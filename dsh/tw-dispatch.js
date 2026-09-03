// tw-dispatch.js — team-work 工作流派发工具（方案 docs/dsh-dispatch-tool-plan.md，§7 v2 + §8 v3 + §9 返工终版）
// 单次调用完成一个波次的完整派发：子进程 tw dispatch-plan 拿波次事实 → 派单逐张（串行）
// 「tw agent-map 先登记确定性 sessionId → 共享创建核心 createDirectedSubagent（target 直取 modelHint，
// 不重选档位；核心内判定链四态：活→等待 / 冷归属一致→冷唤醒+判收单定增量或全量 / 冷异主→接管冲突 /
// 无记录→同 id 重建投全量）」。防双发是机器保障：确定性 sessionId 从任务名+派单 key 推导，同 key
// 任意次重试收敛到同一会话（或冷唤醒投递），不再造第二个成员，不依赖模型遵守「勿重复创建」指引。
// 标签按派单事实自动拼接（P4：阶段缩写/角色/包/任务名全是 Runtime 自有事实，模型只给可选 note）。
// 波次机不在派发点时透传卡片、不创建任何子代理——Lead 推进循环收敛为「反复调 tw-dispatch 直到终态卡」。
// 例外是 wait-inflight stop 卡（§7.3 兜底层）：runtime 在卡内 inflight 条目上投影判定事实（modelHint
// 回填/expectedAgentId 回溯/registered+mappedAgentId/promptFull 锁内查 mappings），本工具按判定链四态
// 逐条自动处置（活→等待；冷归属一致→冷唤醒投增量/全量；冷异主→接管冲突卡；无记录→同 id 重建投全量；
// 续派活→等待不重投；续派冷→冷唤醒；续派断链→全量变体 fresh 重建）。
// 续派冷唤醒的 followup 是机器投递（与 send_message 同为续聊通道，确定性动作归工具）。
// 组合发生在绑定层：不改 dispatch-plan / agent-map 的 CLI 语义，CoreRuntime 不感知本工具。
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import {
  coldSessionReceived,
  coldSessionStatus,
  createDirectedSubagent,
  decisionTableText,
  followupChild,
  SUBAGENT_PROVIDER,
} from "./tw-tool-subagent.js"
import { resolveChildCwd, resolveTwExecutable } from "./tw-tool.js"

export const TOOL_NAME = "tw-dispatch"

// 阶段缩写固定表（与 skill dsh-orchestration.md 同源；恢复二阶段切链删除的 tagLabel 语义：
// design/spec 的 review 阶段复用 DESIGN/SPEC 缩写——同阶段同缩写，无独立缩写）。未知阶段回退原 id，
// 不猜测语义。workflow.stages 是数据驱动扩展点：新阶段落在固定表外时按原 id 展示。
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

// 角色缩写：challenger 固定缩写 chal（省 6 字符）；其余原样（owner/expert）。
export function roleAbbrev(role) {
  return role === "challenger" ? "chal" : String(role ?? "")
}

// 标签 = `阶段缩写·角色[@包] · 简述 #任务名`（纯展示语义：模型选择由创建核心 target 直达、续派映射由
// agent-map 登记，标签写错只影响人读分组）。@包仅多包波携带——dispatch-plan 对单包/无包派单不输出
// package 字段，字段在场即多包波次成员。简述 = note；缺省自动生成（任务名-角色-轮次）：任务名重复入
// 简述是有意设计——侧栏从尾部截断时 #任务名 段先被截掉，简述里的任务名保住辨识度。
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

// 确定性 sessionId（防双发的机器保障基石，方案 §8 修订 v3 用户裁决）：sha256(task + key) 组装
// UUID v4 形态（version/variant 位按规范置位，宿主视角与随机 UUID 无差别）。同一派单 key 的任意次
// 重试推导出同一 id——「先登记后创建 + sessions.get 三态对账」在任何崩溃时点重入都收敛到同一会话，
// 不再依赖模型自觉遵守「勿重复创建」指引（Expert 裁决：防双发必须有机器保障，指引不是保障）。
export function deterministicSessionId(task, key) {
  const h = createHash("sha256").update(String(task) + "\u0000" + String(key), "utf8").digest("hex")
  return h.slice(0, 8) + "-" + h.slice(8, 12) + "-4" + h.slice(13, 16) + "-" + ["8", "9", "a", "b"][parseInt(h.slice(16, 17), 16) % 4] + h.slice(17, 20) + "-" + h.slice(20, 32)
}

// 工具说明（三处同源的分工表：tw-tool-subagent 工具说明 / systemPrompt section / 本工具说明，
// 全部引用 tw-tool-subagent.js 的 decisionTableText()，文案不可能漂移）。
export function twDispatchToolDescription() {
  return [
    "team-work 工作流派发：单次调用完成一个波次的完整派发——推进任务到派发点、登记派单映射（先登记后创建，确定性 sessionId）、按 dispatch-plan 的 modelHint 创建成员子代理（不重选档位）、自动拼接展示标签。防双发由机器保障（判定链四态）：同 key 重试对账宿主会话收敛——活→等待（任务进行中，重入恒等待不重投）；冷持久归属一致→冷唤醒+判收单投增量/全量；冷持久异主→接管冲突卡；无记录→同 id 重建投全量。不依赖人工核对。",
    "波次机不在派发点时（awaiting-user/completed/blocked/archived 卡）原样透传卡片且不创建任何子代理；wait-inflight 卡按条目自动处置兜底（已登记→判定链四态处置：活等待/冷唤醒投递/同 id 重建/接管冲突卡；续派活→等待不重投；续派冷→冷唤醒投本轮派单；续派断链→全量变体 fresh 重建；未登记→登记+补派）。Lead 推进循环 = 反复调用本工具直到终态卡片。续派冷唤醒时本工具直接 followup（机器投递）；Lead 主动催单/续聊用 send_message。",
    decisionTableText(),
  ].join("\n")
}

const TW_TIMEOUT_MS = 120000

function failCard(code, message) {
  return { ok: false, code, message }
}

// 子进程封装（与 tw-tool.js 的 runTw 同构；tw-tool.js 不在本任务可写清单，故未抽公共模块——
// 后续如需消除重复可把 runTw 提升为 tw-tool.js 导出后两处共用）。解析失败同样回结构化卡。
function runTwChild(executable, args, cwd, timeoutMs = TW_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [executable, ...args], { cwd, env: process.env })
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

// 工具定义工厂。deps 与 twToolSubagentDefinition 同形（tiersSource / directSelections /
// subagentProviderName / isModelInjectionReady / getService），保证两工具共享同一份直接选择表与注入就绪状态；
// runTw / createDirectedSubagent 仅测试注入用（fake CLI 卡与 fake 创建核心）。
export function twDispatchDefinition(ctx, deps = {}) {
  const runTw = deps.runTw ?? ((args, cwd) => runTwChild(resolveTwExecutable(), args, cwd))
  const createSubagent = deps.createDirectedSubagent ?? createDirectedSubagent
  const coreDeps = {
    tiersSource: deps.tiersSource ?? (() => null),
    directSelections: deps.directSelections ?? new Map(),
    subagentProviderName: deps.subagentProviderName ?? SUBAGENT_PROVIDER,
    isModelInjectionReady: deps.isModelInjectionReady ?? (() => true),
    ...(deps.getService ? { getService: deps.getService } : {}),
  }

  return {
    name: TOOL_NAME,
    // dispatch-plan 推进 + 多包逐张串行（每张含创建核心的验证与持久化确认）+ 逐张登记，
    // 上限按多包串行链估算；正常单波远低于此值。
    timeoutMs: 300000,
    description: twDispatchToolDescription(),
    // 并发保守（§7.3.3）：同任务连点/并发调用在宿主侧排队串行执行。dispatch-plan 的开单→创建→登记
    // 是非原子序列——并发第二个调用若在首调用登记完成前进入，会看到 registered=false 而重复创建
    // （双发）；排队后次调用见 registered=true（等待透传）。代价是同任务派发不并行（串行吞吐），
    // 换取补派不双发；不同任务互不影响。
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

      // 步骤 1：dispatch-plan 拿波次事实（--json 取机器可读 waves[]；writables 透传为 路径:kind 条目）。
      const args = ["dispatch-plan", "--task", task, "--json"]
      for (const w of writables ?? []) args.push("--writable", w.path.trim() + ":" + w.kind.trim())
      const plan = await runTw(args, cwd)
      // 失败语义 §3.6：推进失败/参数拒绝 → 原样返回错误卡（含 fix 指引）；非派发卡（awaiting-user/
      // wait-inflight/completed/blocked/archived）→ 原样透传，不创建任何子代理。
      const isDispatchPlan =
        plan && typeof plan === "object" && plan.ok === true && plan.stop === null && Array.isArray(plan.waves) && plan.waves.length > 0
      // §8 修订 v3 + §9 判定链四态（防双发是机器保障，指引不是保障）。三处派发路径
      // （正常波 / 续派断链重建 / wait-inflight 补派）共用「登记 → 确定性创建」：
      //   1) agent-map 先登记确定性 sessionId（deterministicSessionId(task, key)）——登记失败时
      //      尚未创建任何子代理，原样重试安全（旧序「创建→登记」的登记失败会留下在跑会话 + 双发窗口）；
      //   2) createSubagent 携 sessionId：核心内判定链四态对账（活→等待 / 冷归属一致→冷唤醒投增量或
      //      全量 / 异主→接管冲突卡 / 无记录→同 id 重建投全量）——任何崩溃时点重入都收敛到同一会话。
      // 宿主会话对账服务：sessions 缺失/抛错跳过活判定落冷判定，持久服务缺失按无记录走重建（宿主
      // DUPLICATE_CHILD 兜底拒绝，报错可恢复——不产生双成员）。
      const getService = deps.getService ?? ((name) => (ctx && typeof ctx.get === "function" ? ctx.get(name) : ctx ? ctx[name] : undefined))
      let sessionsSvc = null
      try { sessionsSvc = getService("sessions") } catch { sessionsSvc = null }
      let persistenceSvc = null
      try { persistenceSvc = getService("sessionPersistence") } catch { persistenceSvc = null }
      let subagentsSvc = null
      try { subagentsSvc = getService("subagents") } catch { subagentsSvc = null }
      // 会话判定链四态（与创建核心同源原语，用户终裁②③）：live（活→等待；活=任务进行中，不读
      // 事件流、不投递——重入判活恒等待永不重投；「活+未收单」经宿主 submitMaterialized 失败即完全
      // 回滚不存在）/ foreign（冷持久异主：接管冲突卡）/ ours（冷持久归属一致：冷唤醒+判收单定增量
      // 或全量）/ none（无记录：同 id 重建）。
      // sessions 服务缺失/抛错 → 跳过活判定落冷判定；两服务都不可得 → none（宿主显式 childId 判重兜底，
      // 最坏后果=报错可 retire 恢复，不产生双成员）。parentSessionId 用于冷持久归属比对（接管冲突支）。
      const reconcileSession = async (id) => {
        try {
          const live = sessionsSvc && typeof sessionsSvc.get === "function" ? sessionsSvc.get(id) : undefined
          if (live !== undefined && live !== null) {
            // 活异主与冷异主同款保守（接管冲突）；归属一致的活会话 → live（统一等待）
            const owner = live?.header?.parentSession
            if (owner !== undefined && owner !== null && owner !== exec?.agent?.id) return "foreign"
            return "live"
          }
        } catch {
          // 活判定不可得，落冷判定
        }
        const cold = await coldSessionStatus({ persistence: persistenceSvc, parentSessionId: exec?.agent?.id }, id)
        return cold.status
      }
      // 续派处置（正常波循环与 wait-inflight 共用，C①/C② + 用户终裁②③）：判定链四态——
      //   live（活）→ 统一等待：活 = 任务进行中（正在处理本轮，或等子代——子代停止时宿主注入父级
      //     通知、逐级传导触发 Lead），通知链保证不僵死；重入判活→等待、永不重投（防成员重复执行
      //     整轮工作）；是什么任务/是否当前轮，等通知到达再判断（届时冷了走冷唤醒投正文）；
      //   ours（冷持久归属一致）→ 冷唤醒 + 缺什么补什么：readRaw 判收单定变体（曾收单=有上一轮
      //     上下文→投本轮增量；从未收单→投全量，objective/constraints/exclusions 内嵌）；
      //   foreign（冷持久异主）→ 接管冲突卡（原会话继续或 retire）；
      //   none（断链）→ registerThenCreate fresh 重建 + 全量变体（新成员无原上下文，增量单无法执行）。
      const handleContinuation = async ({ key, label, waveFields, expectedAgentId, hint, prompt, promptFull, retireText }) => {
        if (typeof prompt !== "string" || !prompt.trim()) {
          return { ok: false, key, label, continuation: true, expectedAgentId, ...waveFields, code: "TW_DISPATCH_PROMPT_MISSING", message: "续派派单 " + key + " 的 prompt 缺失（runtime 投影缺陷），未投递未创建。若为误报请修复任务目录后重新 tw-dispatch；" + retireText }
        }
        const full = typeof promptFull === "string" && promptFull.trim() ? promptFull : prompt
        const prior = expectedAgentId
        const state = await reconcileSession(prior)
        if (state === "live") {
          return {
            ok: true, key, label, continuation: true, expectedAgentId: prior, sessionId: prior, action: "wait", ...waveFields,
            message: "续派原会话（" + prior + "）在场：任务进行中（正在处理本轮，或等子代——子代停止时宿主注入父级通知逐级传导），等待成员完成通知；本轮已投递，重入恒等待不重投，催单用 send_message",
          }
        }
        if (state === "ours") {
          const received = await coldSessionReceived(persistenceSvc, prior)
          const sent = await followupChild({ subagents: subagentsSvc, parent: exec?.agent, signal: exec?.signal }, prior, received ? prompt : full)
          if (!sent.ok) return { ...sent, key, label, continuation: true, expectedAgentId: prior, ...waveFields }
          return {
            ok: true, key, label, continuation: true, expectedAgentId: prior, sessionId: prior, messageId: sent.messageId, action: "followup",
            ...(received ? { resume: "incremental" } : { resume: "full" }), ...waveFields,
            message: received
              ? "续派原会话（" + prior + "）为冷持久（归属一致）：已冷唤醒并 followup 本轮派单正文（增量变体；会话曾收单，有原上下文）"
              : "续派原会话（" + prior + "）为冷持久（归属一致）且从未收单：已冷唤醒并 followup 全量派单变体（无原上下文）",
          }
        }
        if (state === "foreign") {
          return {
            ok: false, key, label, continuation: true, expectedAgentId: prior, ...waveFields, code: "TW_SUB_TAKEOVER_CONFLICT",
            message: "续派原会话（" + prior + "）是冷持久会话且归属其他父会话（接管冲突）：本工具不做接管（冷唤醒鉴权与同 ID 重建判重两路必被宿主拒绝）。处置：由原 Lead 会话继续，或 " + retireText,
          }
        }
        // none：断链 fresh 重建（key 映射回填，全量变体照发——新成员无原上下文）
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
          // prompt 缺失是 runtime 投影缺陷（正常总是投影）：拒绝登记与创建（Challenger r2——
          // 不静默置空串创建；登记也不做，保持该项零副作用），指 retire 或修复后重试。
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
        // target 仅在落到「同 ID 重建」时被消费（核心内判定链四态先行：活→等待/冷唤醒投递/接管冲突
        // 都不需要模型选择）；hint 无效时传 null——判定链若返回等待/投递照常成功，落到重建才报
        // MODEL_HINT_UNRESOLVED（指 retire 或修复配置），不再让无效 hint 挡住「等待」这一正确状态。
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
            code: hintBlocked ? "TW_DISPATCH_MODEL_HINT_UNRESOLVED" : created?.code ?? "TW_DISPATCH_CREATE_FAILED",
            message:
              (hintBlocked
                ? "会话无记录需同 id 重建，但该派单无可用 modelHint（快照缺失且按 tier 从当前全局配置无法解析），重建无 target"
                : created?.message ?? "子代理创建失败（未知原因）") +
              "。映射已登记（" + sessionId + "）：原样重试安全（判定链幂等收敛）；若本波不应执行，" + retireText +
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
              ? { action: "followup", message: "判定链投递：会话（" + created.sessionId + "）为冷持久（归属一致），已冷唤醒并 followup " + (created.resume === "incremental" ? "本轮派单正文（增量变体；会话曾收单，有原上下文）" : "全量派单变体（会话从未收单，无原上下文）") }
              : {}),
        }
      }

      // §7.3 兜底层：wait-inflight stop 卡不再纯透传。runtime 已在 inflight 条目上投影判定事实
      // （modelHint 回填/expectedAgentId 回溯/registered+mappedAgentId 锁内查 mappings；绑定层不直读账本——P4），
      // 本工具按判定链四态（用户终裁②③，与创建核心同源原语）逐条独立处置：
      //   1) registered 字段缺失（agents.json 损坏降级）→ 降级透传不补派（判定事实不可信时宁透传不误派；
      //      恢复边 = tw agent-map 补登记，账本损坏时 agent-map 自动重建——不再是无解死门）；
      //   2) registered=true → 判定链处置（委托创建核心）：活→等待；冷持久归属一致→冷唤醒+判收单定
      //      增量/全量；冷持久异主→接管冲突卡；无记录→同 id 重建投全量（投递/重建前同款 prompt
      //      缺失校验：拒绝不创建，登记事实零写）；
      //   3) 续派（expectedAgentId 在场）→ handleContinuation 四态处置（活→等待；冷唤醒 followup；断链 fresh 重建）；
      //   4) 其余（registered=false 且非续派）→ 登记确定性 sessionId + 补派（判定链在核心内先行），
      //      结果标注「补派」并附 tw retire 提示（判定权边界：事实判定归工具，「该波要不要」归 retire）。
      if (plan && plan.ok === true && plan.stop === "wait-inflight" && Array.isArray(plan.inflight)) {
        const handleInflightItem = async (item) => {
          const key = typeof item?.dispatchKey === "string" && item.dispatchKey ? item.dispatchKey : typeof item?.key === "string" ? item.key : ""
          const label = buildDispatchLabel(plan, item, note)
          const waveFields = item?.waveId ? { waveId: item.waveId } : {}
          // 1) registered 缺失：降级透传（修复入口 agent-map 自身可自愈重建损坏账本，非死门）
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
          // 2) registered=true：判定链处置全部委托创建核心（判定原语两处同源，返工终版 §二·A）——
          // 已收单→reused 等待；活会话未收单/冷持久归属一致→followup 补发或冷唤醒；冷持久异主→接管
          // 冲突卡；无记录→同 id 重建。mappedAgentId 缺失（登记事实投影异常）退确定性 sessionId：
          // 同 key 收敛锚不变；本分支不回写 agents.json（登记事实保持原样，后续重入幂等收敛）。
          if (item.registered === true) {
            const mappedId = typeof item.mappedAgentId === "string" && item.mappedAgentId ? item.mappedAgentId : ""
            const targetId = mappedId || deterministicSessionId(task, key)
            if (typeof item.prompt !== "string" || !item.prompt.trim()) {
              // prompt 缺失同款防御（与 registerThenCreate 一致，Challenger r3）：任何投递/重建前拒绝，
              // 不静默置空串；已登记事实零写（不重复登记、不回写），指 retire。
              return {
                ok: false, key, label, ...waveFields, code: "TW_DISPATCH_PROMPT_MISSING",
                message: "在途派单 " + key + " 的 prompt 缺失（runtime 投影缺陷），未补发未创建（登记保持不变）。" + retireHint(item) + "；若为误报请修复任务目录后重新 tw-dispatch",
              }
            }
            const hint = item?.modelHint
            // 双变体透传（用户终裁②③ + Challenger r4）：prompt=增量正文、promptFull=全量变体（仅续派
            // 条目携带），核心按四态自选——活→等待（不消费正文）；冷归属一致→判收单（曾收单=有上一轮
            // 上下文投增量 / 从未收单投全量）；无记录→同 id 重建投全量（新会话无原上下文）。
            // 典型触发链：续派断链 fresh 重建登记成功但创建瞬态失败（如 TW_SUB_START_FAILED）后重入，
            // registered=true 优先命中本分支（优先于续派分支 3）；同 id 收敛锚不变，防双发不受影响。
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
                code: created?.code === "TW_SUB_TAKEOVER_CONFLICT" || created?.code === "TW_SUB_NOT_RESUMABLE" || created?.code === "TW_SUB_FOLLOWUP_UNAVAILABLE"
                  ? created.code
                  : hintBlocked ? "TW_DISPATCH_MODEL_HINT_UNRESOLVED" : created?.code ?? "TW_DISPATCH_CREATE_FAILED",
                message: (created?.message ?? "在途处置失败（未知原因）") + "。登记保持不变，原样重试安全（判定链幂等收敛）；" + retireHint(item) +
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
                  ? { recovered: true, action: "followup", ...(created.resume ? { resume: created.resume } : {}), message: "已登记在途，会话（" + created.sessionId + "）为冷持久（归属一致），已冷唤醒并 followup " + (created.resume === "incremental" ? "本轮派单正文（增量变体；会话曾收单，有原上下文）" : "全量派单变体（会话从未收单，无原上下文）") + "。" + retireHint(item) }
                  : { recovered: true, action: "recreated", message: "已登记在途但会话无记录（崩溃窗口或会话被清），已同 id 重建（投全量变体）：" + created.sessionId + "。" + retireHint(item) }),
            }
          }
          // 3) 续派且有 expectedAgentId：判定链四态处置（见 handleContinuation 注释）
          if (item.continuation && item.expectedAgentId) {
            return handleContinuation({
              key, label, waveFields, expectedAgentId: item.expectedAgentId, hint: item?.modelHint,
              prompt: item.prompt, promptFull: item.promptFull, retireText: retireHint(item),
            })
          }
          // 4) registered=false 且非续派：登记确定性 sessionId + 补派创建（判定链在核心内先行；
          // hint 无效时传 null——已收单/需补发的会话照常处置，仅落到同 id 重建才报 MODEL_HINT_UNRESOLVED）
          const done = await registerThenCreate({ key, label, waveFields, hint: hintValid(item?.modelHint) ? item.modelHint : null, prompt: item.prompt, retireText: retireHint(item) })
          if (!done.ok) return done
          return {
            ...done, recovered: true,
            message:
              (done.reused
                ? "补派判定链命中：会话在场（此前崩溃窗口的登记+投递实际已完成，任务进行中）：" + done.sessionId
                : done.refollowed
                  ? "补派判定链投递：会话（" + done.sessionId + "）为冷持久（归属一致），已冷唤醒并 followup " + (done.resume === "incremental" ? "本轮派单正文（增量变体）" : "派单正文")
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

      // 步骤 2/3：派单逐张串行「登记 → 确定性创建」（§8 修订 v3 防双发：与 wait-inflight 补派共用
      // registerThenCreate 序列，见其注释）；单张失败不回滚已成功项，逐项报错并给恢复指引（§3.5/§3.6）。
      const dispatched = []
      for (const wave of plan.waves) {
        const key = typeof wave?.dispatchKey === "string" ? wave.dispatchKey : ""
        const label = buildDispatchLabel(plan, wave, note)
        const waveFields = wave?.waveId ? { waveId: wave.waveId } : {}
        if (!key) {
          dispatched.push({ ok: false, key, label, ...waveFields, code: "TW_DISPATCH_KEY_MISSING", message: "派单缺 dispatchKey（波次事实损坏）；已跳过。请核对任务目录后重试 tw-dispatch" })
          continue
        }
        // 续派（continuation 且已有映射）：判定链四态处置（见 handleContinuation 注释）——活→等待；
        // 冷持久归属一致冷唤醒投本轮派单（判收单定增量/全量）；断链自动 fresh 重建（全量变体照发
        // ——新成员无原上下文）。
        if (wave.continuation && wave.expectedAgentId) {
          dispatched.push(await handleContinuation({
            key, label, waveFields, expectedAgentId: wave.expectedAgentId, hint: wave?.modelHint,
            prompt: wave.prompt, promptFull: wave.promptFull, retireText: retireHint(wave),
          }))
          continue
        }
        // 登记 → 确定性创建（共享序列：核心内判定链四态对账；启动未确认的子会话由核心回收语义处理）。
        // hint 无效时传 null（与 wait-inflight 分支 4 同款，Challenger r5 建议）：判定链先行——重试场景
        // 会话在场则命中等待（此前「未创建子会话」文案与事实不符且跳过对账）；仅落到同 id 重建才报
        // MODEL_HINT_UNRESOLVED（指修复配置或 retire）。
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
