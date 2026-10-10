import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import {
  coldSessionReceived,
  coldResumePrompt,
  reconcileSession as inspectSession,
  createDirectedSubagent,
  followupChild,
  SUBAGENT_PROVIDER,
} from "./subagent-session.js"
import { decisionTableText } from "./settings.js"
import { resolveChildCwd, resolveTwExecutable } from "./tw-tool.js"

export const TOOL_NAME = "tw-dispatch"

export const STAGE_ABBREV = Object.freeze({
  research: "RES",
  design: "DESIGN",
  "design-review": "DESIGN",
  spec: "SPEC",
  "spec-review": "SPEC",
  implementation: "IMPL",
  test: "TEST",
  "code-review": "CR",
  e2e: "E2E",
  finish: "FIN",
})

export function roleAbbrev(role) {
  return role === "challenger" ? "chal" : String(role ?? "")
}

export function buildDispatchLabel(plan, wave, note) {
  const task = String(plan?.task ?? "")
  const ab = STAGE_ABBREV[plan?.stage] ?? String(plan?.stage ?? "")
  const role = roleAbbrev(wave?.role)
  const pkg = wave?.package != null ? "@" + String(wave.package) : ""
  const brief =
    typeof note === "string" && note.trim()
      ? note.trim()
      : task + "-" + role + "-r" + String(wave?.round ?? 1)
  return ab + "·" + role + pkg + " · " + brief + " #" + task
}

export function deterministicSessionId(task, key) {
  const h = createHash("sha256").update(String(task) + "\u0000" + String(key), "utf8").digest("hex")
  return h.slice(0, 8) + "-" + h.slice(8, 12) + "-4" + h.slice(13, 16) + "-" + ["8", "9", "a", "b"][parseInt(h.slice(16, 17), 16) % 4] + h.slice(17, 20) + "-" + h.slice(20, 32)
}

export function twDispatchToolDescription() {
  return [
    "team-work 正式成员派发：推进到当前波次、先登记确定性会话 ID、按派单 modelHint 创建成员并拼接展示标签。同 key 重试先检查同 ID：同父活会话等待；同父冷会话用 sendMessage 续投；异主拒绝接管；确认不存在才重建。读取不确定时返回恢复错误，保留映射；初始消息已接收但持久化未确认时保留 sessionId，不回收或另建成员。",
    "续派先登记本轮 key 到原成员会话，再等待或冷唤醒：日志已含本轮完整正文则发送轻量续行提醒，仅有旧轮上下文则发送本轮增量，尚无上下文则发送全量；断链重建发送全量上下文。awaiting-user/completed/blocked/archived 卡停止派发，wait-inflight 逐项恢复。人工等待时只能等新用户输入，不轮询。主动催单和续聊用原生 send_message。防重复创建不承诺消息恰好投递一次；回执丢失后先核对已有会话 ID。",
    decisionTableText(),
  ].join("\n")
}

const TW_TIMEOUT_MS = 120000

function failCard(code, message) {
  return { ok: false, code, message }
}

function runTwChild(executable, args, cwd, snapshot, timeoutMs = TW_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [executable, ...args], { cwd, env: { ...process.env, TW_DSH_CONFIG: JSON.stringify(snapshot) } })
    let done = false
    let out = ""
    let err = ""
    const timer = setTimeout(() => {
      if (done) return
      done = true
      child.kill("SIGKILL")
      resolve({ ok: false, code: "TW_DISPATCH_TIMEOUT", message: "tw " + args[0] + " 超时（" + timeoutMs + "ms）被终止" })
    }, timeoutMs)
    child.stdout.on("data", (chunk) => { out += chunk })
    child.stderr.on("data", (chunk) => { err += chunk })
    child.on("close", () => {
      if (done) return
      done = true
      clearTimeout(timer)
      const text = (out || err || "").trim()
      let card = null
      try { card = JSON.parse(text) } catch { card = { ok: false, code: "TW_OUTPUT_UNPARSEABLE", message: text.slice(0, 400) } }
      resolve(card)
    })
    child.on("error", (error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: false, code: "TW_SPAWN_FAILED", message: String(error?.message ?? error) })
    })
  })
}

export function twDispatchDefinition(ctx, deps = {}) {
  const cli = deps.runTw ?? ((args, cwd, snapshot) => runTwChild(resolveTwExecutable(), args, cwd, snapshot))
  const createSubagent = deps.createDirectedSubagent ?? createDirectedSubagent
  const coreDeps = {
    subagentProviderName: deps.subagentProviderName ?? SUBAGENT_PROVIDER,
    ...(deps.getService ? { getService: deps.getService } : {}),
  }

  return {
    name: TOOL_NAME,
    timeoutMs: 300000,
    description: twDispatchToolDescription(),
    isConcurrencySafe: () => false,
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "任务名（tw open 的名字）" },
        note: { type: "string", description: "可选简述（标签展示；≤4 个中文词，不含 #。缺省自动生成 任务名-角色-轮次）" },
        writables: {
          type: "array",
          description: "可写范围，透传 dispatch-plan（路径以 / 结尾 = 目录授权）",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "可写路径（文件如 R.md；目录如 docs/）" },
              kind: { type: "string", description: "制品类型（如 code-review/source/doc）" },
            },
            required: ["path", "kind"],
          },
        },
      },
      required: ["task"],
    },
    async execute(params, exec) {
      let snapshot
      try { snapshot = (deps.configSnapshot ?? (() => ({ tiers: {}, entryId: "team-work-dsh", profile: "unresolved" })))() } catch (error) {
        return failCard("TW_DSH_CONFIG_UNRESOLVED", "配置快照读取失败：" + String(error?.message ?? error))
      }
      const runTw = (args, cwd) => cli(args, cwd, snapshot)
      const task = typeof params?.task === "string" ? params.task.trim() : ""
      if (!task) return failCard("TW_DISPATCH_TASK_REQUIRED", "task 必须是非空字符串（任务名）")
      const note = typeof params?.note === "string" && params.note.trim() ? params.note.trim() : null
      const writables = params?.writables
      if (writables !== undefined) {
        if (!Array.isArray(writables)) {
          return failCard("TW_DISPATCH_WRITABLES_INVALID", "writables 必须是数组（[{path, kind}]），透传 dispatch-plan --writable")
        }
        for (const w of writables) {
          if (!w || typeof w !== "object" || typeof w.path !== "string" || !w.path.trim() || typeof w.kind !== "string" || !w.kind.trim()) {
            return failCard("TW_DISPATCH_WRITABLES_INVALID", 'writables 每项都需要非空 path 与 kind（如 { path: "R.md", kind: "code-review" }）')
          }
        }
      }
      const cwd = resolveChildCwd(exec)
      if (!cwd) {
        return failCard("TW_DISPATCH_CWD_UNRESOLVED", "无法确定当前会话的工作目录；请在已打开项目的 DSH 会话中重试")
      }

      const args = ["dispatch-plan", "--task", task, "--json"]
      for (const w of writables ?? []) args.push("--writable", w.path.trim() + ":" + w.kind.trim())
      const plan = await runTw(args, cwd)
      const isDispatchPlan =
        plan && typeof plan === "object" && plan.ok === true && plan.stop === null && Array.isArray(plan.waves) && plan.waves.length > 0
      const getService = deps.getService ?? ((name) => (ctx && typeof ctx.get === "function" ? ctx.get(name) : ctx ? ctx[name] : undefined))
      let sessionsSvc = null
      try { sessionsSvc = getService("sessions") } catch { sessionsSvc = null }
      let persistenceSvc = null
      try { persistenceSvc = getService("sessionPersistence") } catch { persistenceSvc = null }
      let subagentsSvc = null
      try { subagentsSvc = getService("subagents") } catch { subagentsSvc = null }
      const reconcileSession = async (id) => {
        return inspectSession({ sessions: sessionsSvc, persistence: persistenceSvc, parentSessionId: exec?.agent?.id, signal: exec?.signal }, id)
      }
      const handleContinuation = async ({ key, label, waveFields, expectedAgentId, hint, prompt, promptFull, retireText }) => {
        if (typeof prompt !== "string" || !prompt.trim()) {
          return { ok: false, key, label, continuation: true, expectedAgentId, ...waveFields, code: "TW_DISPATCH_PROMPT_MISSING", message: "续派派单 " + key + " 的 prompt 缺失（runtime 投影缺陷），未投递未创建。若为误报请修复任务目录后重新 tw-dispatch；" + retireText }
        }
        const full = typeof promptFull === "string" && promptFull.trim() ? promptFull : prompt
        const prior = expectedAgentId
        const observation = await reconcileSession(prior)
        const state = observation.status
        if (state === "unknown") return { ok: false, key, label, sessionId: prior, ...waveFields, code: "TW_SUB_SESSION_UNKNOWN", message: "续派会话读取不确定：" + (observation.message ?? "宿主未提供具体原因") + "；保留映射，检查同 ID 会话后重试，勿另建成员或补投正文" }
        if (state === "live" || state === "ours") {
          const mapped = await runTw(["agent-map", "--task", task, "--key", key, "--agent", prior], cwd)
          if (mapped?.ok !== true) return { ok: false, key, label, sessionId: prior, ...waveFields, code: "TW_DISPATCH_REGISTER_FAILED", message: "续派登记失败，未发送本轮正文；保留原成员会话，请修复登记后重试：" + String(mapped?.message ?? mapped) }
        }
        if (state === "live") {
          return {
            ok: true, key, label, continuation: true, expectedAgentId: prior, sessionId: prior, action: "wait", ...waveFields,
            message: "续派原会话（" + prior + "）在场：任务进行中（正在处理本轮，或等子代——子代停止时宿主注入父级通知逐级传导），等待成员完成通知；重入恒等待不重投，催单用 send_message",
          }
        }
        if (state === "ours") {
          let read
          try { read = await coldSessionReceived(persistenceSvc, prior, exec?.signal, [prompt, full]) } catch (error) { return { ok: false, key, label, sessionId: prior, code: "TW_SUB_SESSION_UNKNOWN", message: String(error?.message ?? error) + "；保留映射，请检查同 ID 会话后重试，未补投正文" } }
          if (!read.ok) return { ...read, key, label, continuation: true, expectedAgentId: prior, ...waveFields }
          const followup = coldResumePrompt(read, prompt, full)
          const sent = await followupChild({ subagents: subagentsSvc, parent: exec?.agent, signal: exec?.signal }, prior, followup.text)
          if (!sent.ok) return { ...sent, key, label, continuation: true, expectedAgentId: prior, ...waveFields }
          return {
            ok: true, key, label, continuation: true, expectedAgentId: prior, sessionId: prior, messageId: sent.messageId, action: "followup",
            resume: followup.resume, ...waveFields,
            message: "续派原会话（" + prior + "）归属一致，已冷唤醒并发送" + (followup.resume === "reminder" ? "轻量续行提醒（日志已含本轮正文）" : followup.resume === "incremental" ? "本轮增量派单（仅有旧轮上下文）" : "全量派单（尚无工作上下文）"),
          }
        }
        if (state === "foreign") {
          return {
            ok: false, key, label, continuation: true, expectedAgentId: prior, ...waveFields, code: "TW_SUB_TAKEOVER_CONFLICT",
            message: "续派原会话（" + prior + "）是冷持久会话且归属其他父会话（接管冲突）：本工具不做接管（冷唤醒鉴权与同 ID 重建判重两路必被宿主拒绝）。处置：由原 Lead 会话继续，或 " + retireText,
          }
        }
        const done = await registerThenCreate({ key, label, waveFields, hint, prompt: full, retireText })
        if (!done.ok) return { ...done, continuation: true, expectedAgentId: prior }
        return {
          ...done, recovered: true, freshRebuilt: true, action: "fresh_rebuilt", continuation: true, priorAgentId: prior,
          message: "续派原会话（" + prior + "）已不存在（断链），已 fresh 重建 " + done.sessionId + "（key 映射已回填，全量派单变体照发——新成员无原上下文）。" + retireText,
        }
      }
      const retireHint = (item) => "若本波不应执行，立即 tw retire --task " + (plan.task ?? task) + " --wave " + (item?.waveId ?? "<waveId 见本卡>") + " 回收"
      const hintValid = (hint) => Boolean(hint && typeof hint.provider === "string" && hint.provider && typeof hint.model === "string" && hint.model)
      const registerThenCreate = async ({ key, label, waveFields, hint, prompt, retireText }) => {
        if (typeof prompt !== "string" || !prompt.trim()) {
          return { ok: false, key, label, ...waveFields, code: "TW_DISPATCH_PROMPT_MISSING", message: "派单 " + key + " 的 prompt 缺失（runtime 投影缺陷），未登记未创建。" + retireText + "；若为误报请修复任务目录后重新 tw-dispatch" }
        }
        const sessionId = deterministicSessionId(task, key)
        const mapped = await runTw(["agent-map", "--task", task, "--key", key, "--agent", sessionId], cwd)
        if (!mapped || mapped.ok !== true) {
          return {
            ok: false, key, label, ...waveFields, code: "TW_DISPATCH_REGISTER_FAILED",
            message: "映射登记失败：" + String(mapped?.message ?? mapped) + "。尚未创建子会话（先登记后创建），原样重试安全、不会双发；若本波不应执行，" + retireText,
          }
        }
        const created = await createSubagent(ctx, coreDeps, {
          description: label,
          prompt,
          ...(hintValid(hint) ? { target: { provider: hint.provider, model: hint.model, ...(hint.effort ? { effort: hint.effort } : {}) } } : {}),
          sessionId,
          dispatchKey: key,
          exec,
        })
        if (!created || created.ok !== true) {
          const hintBlocked = created?.code === "TW_SUB_TARGET_INVALID" && !hintValid(hint)
          return {
            ok: false, key, label, sessionId, ...waveFields,
            ...(created?.accepted ? { accepted: true, persistenceConfirmed: false, messageId: created.messageId } : {}),
            code: hintBlocked ? "TW_DISPATCH_MODEL_HINT_UNRESOLVED" : created?.code ?? "TW_DISPATCH_CREATE_FAILED",
            message:
              (hintBlocked
                ? "会话无记录需同 id 重建，但该派单无可用 modelHint（快照缺失且按 tier 从当前 profile 配置无法解析），重建无 target"
                : created?.message ?? "子代理创建失败（未知原因）") +
              "。映射已登记（" + sessionId + "）：重试先检查同 ID 会话；若本波不应执行，" + retireText +
              (hintBlocked ? "；若仍需执行，修复 team-work-dsh.tiers（tw models 查看解析）后重新 tw-dispatch" : ""),
          }
        }
        return {
          ok: true, key, label, sessionId: created.sessionId,
          ...(created.provider ? { provider: created.provider } : {}),
          ...(created.model ? { model: created.model } : {}),
          ...(created.effort ? { effort: created.effort } : {}),
          ...(created.reused ? { reused: true } : {}),
          ...(created.refollowed ? { refollowed: true, ...(created.resume ? { resume: created.resume } : {}) } : {}),
          ...waveFields, registered: true,
          ...(created.reused
            ? { action: "wait", message: "判定链命中：会话（" + created.sessionId + "）在场——任务进行中，等待成员完成通知；重入恒等待不重投" }
            : created.refollowed
              ? { action: "followup", message: "同父冷会话（" + created.sessionId + "）已冷唤醒并发送" + (created.resume === "reminder" ? "轻量续行提醒（日志已含本轮正文）" : created.resume === "incremental" ? "本轮增量派单" : "全量派单") }
              : {}),
        }
      }

      if (plan && plan.ok === true && plan.stop === "wait-inflight" && Array.isArray(plan.inflight)) {
        const handleInflightItem = async (item) => {
          const key = typeof item?.dispatchKey === "string" && item.dispatchKey ? item.dispatchKey : typeof item?.key === "string" ? item.key : ""
          const label = buildDispatchLabel(plan, item, note)
          const waveFields = item?.waveId ? { waveId: item.waveId } : {}
          if (item == null || typeof item !== "object" || item.registered === undefined) {
            return {
              ok: true, key, label, ...waveFields, passthrough: true,
              code: item?.registeredUnresolved ? "TW_DISPATCH_REGISTRY_CORRUPT" : "TW_DISPATCH_REGISTERED_UNKNOWN",
              message:
                "在途派单 " + (key || "(缺 key)") + " 缺 registered 判定字段（任务级 agents.json " +
                (item?.registeredUnresolved ? "损坏：" + item.registeredUnresolved : "缺失") + "），不自动补派。" +
                "恢复边：tw agent-map --task " + (plan.task ?? task) + " --key " + (key || "<派单key>") + " --agent <childId> 补登记（账本损坏时该命令自动重建账本，历史映射丢失的续派走 fresh 重建路径）后重新 tw-dispatch；已确认子代理未创建则直接重新 tw-dispatch（按未登记自动补派）",
            }
          }
          if (item.registered === true) {
            const mappedId = typeof item.mappedAgentId === "string" && item.mappedAgentId ? item.mappedAgentId : ""
            const targetId = mappedId || deterministicSessionId(task, key)
            if (typeof item.prompt !== "string" || !item.prompt.trim()) {
              return {
                ok: false, key, label, ...waveFields, code: "TW_DISPATCH_PROMPT_MISSING",
                message: "在途派单 " + key + " 的 prompt 缺失（runtime 投影缺陷），未补发未创建（登记保持不变）。" + retireHint(item) + "；若为误报请修复任务目录后重新 tw-dispatch",
              }
            }
            const hint = item?.modelHint
            const created = await createSubagent(ctx, coreDeps, {
              description: label,
              prompt: item.prompt,
              ...(item.continuation && typeof item.promptFull === "string" && item.promptFull.trim() ? { promptFull: item.promptFull } : {}),
              ...(hintValid(hint) ? { target: { provider: hint.provider, model: hint.model, ...(hint.effort ? { effort: hint.effort } : {}) } } : {}),
              sessionId: targetId,
              dispatchKey: key,
              exec,
            })
            if (!created || created.ok !== true) {
              const hintBlocked = created?.code === "TW_SUB_TARGET_INVALID" && !hintValid(hint)
              return {
                ok: false, key, label, sessionId: targetId, ...waveFields,
                ...(created?.accepted ? { accepted: true, persistenceConfirmed: false, messageId: created.messageId } : {}),
                code: created?.code === "TW_SUB_TAKEOVER_CONFLICT" || created?.code === "TW_SUB_NOT_RESUMABLE" || created?.code === "TW_SUB_FOLLOWUP_UNAVAILABLE"
                  ? created.code
                  : hintBlocked ? "TW_DISPATCH_MODEL_HINT_UNRESOLVED" : created?.code ?? "TW_DISPATCH_CREATE_FAILED",
                message: (created?.message ?? "在途处置失败（未知原因）") + "。登记保持不变，重试先检查同 ID 会话；" + retireHint(item) +
                  (hintBlocked ? "；若仍需执行，修复 team-work-dsh.tiers（tw models 查看解析）后重新 tw-dispatch" : ""),
              }
            }
            return {
              ok: true, key, label, sessionId: created.sessionId,
              ...(created.provider ? { provider: created.provider } : {}),
              ...(created.model ? { model: created.model } : {}),
              ...(created.effort ? { effort: created.effort } : {}),
              ...waveFields, registered: true,
              ...(created.reused
                ? { action: "wait", message: "已登记在途且会话在场（" + created.sessionId + "）：任务进行中，等待成员完成通知；重入恒等待不重投，催单用 send_message" }
                : created.refollowed
                  ? { recovered: true, action: "followup", ...(created.resume ? { resume: created.resume } : {}), message: "已登记在途，同父冷会话（" + created.sessionId + "）已唤醒并发送" + (created.resume === "reminder" ? "轻量续行提醒（日志已含本轮正文）" : created.resume === "incremental" ? "本轮增量派单" : "全量派单") + "。" + retireHint(item) }
                  : { recovered: true, action: "recreated", message: "已登记在途但会话无记录（崩溃窗口或会话被清），已同 id 重建（投全量变体）：" + created.sessionId + "。" + retireHint(item) }),
            }
          }
          if (item.continuation && item.expectedAgentId) {
            return handleContinuation({
              key, label, waveFields, expectedAgentId: item.expectedAgentId, hint: item?.modelHint,
              prompt: item.prompt, promptFull: item.promptFull, retireText: retireHint(item),
            })
          }
          const done = await registerThenCreate({ key, label, waveFields, hint: hintValid(item?.modelHint) ? item.modelHint : null, prompt: item.prompt, retireText: retireHint(item) })
          if (!done.ok) return done
          return {
            ...done, recovered: true,
            message:
              (done.reused
                ? "补派判定链命中：会话在场（此前崩溃窗口的登记+投递实际已完成，任务进行中）：" + done.sessionId
                : done.refollowed
                  ? "补派判定链投递：同父冷会话（" + done.sessionId + "）已唤醒并发送" + (done.resume === "reminder" ? "轻量续行提醒（日志已含本轮正文）" : done.resume === "incremental" ? "本轮增量派单" : "全量派单")
                  : "补派：此前已落盘无执行登记（dispatch 崩溃窗口），已按确定性 sessionId 登记并创建 " + done.sessionId) +
              "。同 key 重试经判定链收敛，不会双发。" + retireHint(item),
          }
        }
        const inflight = []
        for (const item of plan.inflight) inflight.push(await handleInflightItem(item))
        const failures = inflight.filter((d) => !d.ok).length
        return {
          ok: true,
          task: plan.task ?? task,
          stage: plan.stage,
          stop: "wait-inflight",
          inflight,
          ...(failures > 0 ? { failures, note: "部分在途条目处置失败：已成功项不回滚；失败项按各自 message 的指引恢复" } : { note: "在途条目已逐条处置（等待/补发/冷唤醒/续派 followup/重建）" }),
        }
      }
      if (!isDispatchPlan) return plan

      const dispatched = []
      for (const wave of plan.waves) {
        const key = typeof wave?.dispatchKey === "string" ? wave.dispatchKey : ""
        const label = buildDispatchLabel(plan, wave, note)
        const waveFields = wave?.waveId ? { waveId: wave.waveId } : {}
        if (!key) {
          dispatched.push({ ok: false, key, label, ...waveFields, code: "TW_DISPATCH_KEY_MISSING", message: "派单缺 dispatchKey（波次事实损坏）；已跳过。请核对任务目录后重试 tw-dispatch" })
          continue
        }
        if (wave.continuation && wave.expectedAgentId) {
          dispatched.push(await handleContinuation({
            key, label, waveFields, expectedAgentId: wave.expectedAgentId, hint: wave?.modelHint,
            prompt: wave.prompt, promptFull: wave.promptFull, retireText: retireHint(wave),
          }))
          continue
        }
        const card = await registerThenCreate({ key, label, waveFields, hint: hintValid(wave?.modelHint) ? wave.modelHint : null, prompt: wave.prompt, retireText: retireHint(wave) })
        dispatched.push(card)
      }
      const failures = dispatched.filter((d) => !d.ok).length
      return {
        ok: true,
        task: plan.task ?? task,
        stage: plan.stage,
        dispatched,
        ...(failures > 0 ? { failures, note: "部分派单项失败：已成功项不回滚；失败项按各自 message 的指引恢复" } : {}),
      }
    },
    output: {
      schema: { type: "object" },
      render: (_params, card) => [{ type: "text", text: JSON.stringify(card, null, 2) }],
    },
  }
}
