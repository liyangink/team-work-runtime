import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import {
  sessionReceived,
  coldResumePrompt,
  followupChild,
  dispatchKeyFromPrompt,
  toHostTarget,
  reconcileSession as inspectSession,
  createDirectedSubagent,
  SUBAGENT_PROVIDER,
} from "./subagent-session.js"
import { decisionTableText } from "./settings.js"
import { createSleepConfirmGuard } from "./sleep-confirm.js"
import { resolveChildCwd, resolveTwExecutable } from "./tw-tool.js"
import { dispatchLockPath, withOwnerLock } from "../runtime-v3/store.mjs"

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
    "team-work 正式成员派发：按每个 key 先持投递锁、再短持任务锁重验波状态和映射，不持任务锁等待宿主；按派单 modelRef 创建并拼接展示标签。正文必须是可验证的冻结版本，重算 SHA-256 并逐块核对同父会话收单；内容冲突、停写未确认或身份与状态不确定时保留原会话及文件并返回 recover。模型来自任务 roles 与包级 model；人工门停止派发。",
    'wait-children 只表示核实本轮正文已被宿主接收，不代表成员已完成或通知一定可达；活会话未见本轮正文时，仅有可靠旧轮活动与通知证据才返回 wait-prior-turn，否则 recover。冷会话补投或同 ID 补建按用户裁决执行，但日志缺项和 stat 未命中不能证明旧调用不会迟到，存在重复投递风险，需隔离宿主验证。确需同步等待时 sleep 首次会有确认引导；人工等待不轮询，主动续聊用原生 send_message，不承诺跨崩溃恰好一次。新任务先展示意图确认卡，换模型须沿用已有确认卡；多张待决卡按实际 decisionId 答复。',
    decisionTableText(),
  ].join("\n")
}

export const TW_DISPATCH_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    ok: { type: "boolean", description: "调用是否成功" },
    task: { type: "string", description: "任务名" },
    stage: { oneOf: [{ type: "string" }, { type: "null" }], description: "当前阶段 ID" },
    stop: {
      oneOf: [
        { type: "string", enum: ["awaiting-user", "wait-inflight", "completed", "blocked", "archived"] },
        { type: "null" },
      ],
      description: "停止原因；派发点为 null",
    },
    nextAction: {
      type: "string",
      enum: ["wait-children", "wait-prior-turn", "needs-user-report", "recover", "complete"],
      description: "wait-children=已核实本轮收单，不保证成员完成或通知可达；wait-prior-turn=只确认旧轮活动和通知、本轮未送；recover=有状态或安全边界无法证明的条目。",
    },
    dispatched: { type: "array", items: { type: "object" }, description: "本波已派发或续派的成员回执列表" },
    inflight: { type: "array", items: { type: "object" }, description: "wait-inflight 在途核对与恢复结果列表" },
    failures: { type: "integer", description: "失败条目数" },
    pendingDecisions: { type: "array", items: { type: "object" }, description: "全部有效待决卡，按实际 decisionId 作答" },
    staleDecisions: { type: "array", items: { type: "object" }, description: "绑定已失效但尚未收口的卡" },
    needsDecisionId: { type: "boolean", description: "是否必须指定实际答复的决定卡" },
    blockedPackages: { type: "array", items: { type: "object" }, description: "按包阻塞证据" },
    code: { type: "string", description: "错误码" },
    message: { type: "string", description: "说明或错误恢复指引" },
  },
})

export function isHealthyInflightItem(item) {
  return Boolean(item && item.ok === true && item.receiptVerified === true && ["wait", "followup", "recreated", "fresh_rebuilt"].includes(item.action) && typeof item.sessionId === "string" && item.sessionId.trim())
}

export function isHealthyInflightBatch(items, failures = 0) {
  if (!Array.isArray(items) || failures !== 0 || items.some((item) => !item?.ok)) return false
  const outstanding = items.filter((item) => item.action !== "reported")
  return outstanding.length > 0 && outstanding.every(isHealthyInflightItem)
}

// 已报告项不需会话；任何未决项不确定都不能被其他成功项掩盖。
function nextActionFor(items) {
  if (!Array.isArray(items) || !items.length || items.some((item) => !item?.ok)) return "recover"
  const outstanding = items.filter((item) => item.action !== "reported")
  if (!outstanding.length) return "recover" // 本波已结，重新推进而非等待通知。
  const prior = (item) => item.action === "wait-prior-turn" && item.priorActivityConfirmed === true && item.notificationConfirmed === true && item.receiptVerified !== true
  if (outstanding.every(isHealthyInflightItem)) return "wait-children"
  return outstanding.every((item) => isHealthyInflightItem(item) || prior(item)) ? "wait-prior-turn" : "recover"
}

function frozenPromptProblem(item, key) {
  if (item?.promptFrozen !== true) return "派单正文不是可验证的冻结版本"
  const valid = (text, digest) => typeof text === "string" && text.length > 0 && dispatchKeyFromPrompt(text) === key && typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest) && createHash("sha256").update(text, "utf8").digest("hex") === digest
  if (!valid(item.prompt, item.promptDigest)) return "增量/首派正文的 key 或 SHA-256 与冻结摘要不符"
  if (item.continuation || item.promptFull !== undefined || item.promptFullDigest !== undefined) {
    if (!valid(item.promptFull, item.promptFullDigest)) return "全量正文的 key 或 SHA-256 与冻结摘要不符"
  }
  return null
}

function decisionOutput(plan) {
  if (plan?.stop !== "awaiting-user") return plan
  const card = plan.card && typeof plan.card === "object" ? plan.card : {}
  const result = { ...plan }
  for (const name of ["pendingDecisions", "staleDecisions", "needsDecisionId", "blockedPackages"]) {
    if (card[name] !== undefined) result[name] = card[name]
  }
  if (Array.isArray(result.pendingDecisions) && result.pendingDecisions.length > 1) {
    result.needsDecisionId = true
    delete result.decisionId
    delete result.question
    delete result.choices
    result.card = { ...card }
    delete result.card.decisionId
    delete result.card.question
    delete result.card.choices
  }
  return result
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
  const sleepConfirm = deps.sleepConfirm ?? createSleepConfirmGuard()
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
      const isDispatchPlan = plan?.ok === true && plan.stop === null && Array.isArray(plan.waves) && plan.waves.length > 0
      const isInflight = plan?.ok === true && plan.stop === "wait-inflight" && Array.isArray(plan.inflight)
      if (!isDispatchPlan && !isInflight) return decisionOutput(plan)

      const getService = deps.getService ?? ((name) => (ctx && typeof ctx.get === "function" ? ctx.get(name) : ctx ? ctx[name] : undefined))
      let sessionsSvc = null
      try { sessionsSvc = getService("sessions") } catch { sessionsSvc = null }
      let persistenceSvc = null
      try { persistenceSvc = getService("sessionPersistence") } catch { persistenceSvc = null }
      let subagentsSvc = null
      try { subagentsSvc = getService("subagents") } catch { subagentsSvc = null }
      const observe = (id) => inspectSession({ sessions: sessionsSvc, persistence: persistenceSvc, parentSessionId: exec?.agent?.id, signal: exec?.signal }, id)
      const leadPresentation = plan?.presentation ?? plan?.card?.presentation
      const presentation = leadPresentation === undefined ? {} : { presentation: leadPresentation }
      const keyOf = (item) => typeof item?.dispatchKey === "string" && item.dispatchKey ? item.dispatchKey : typeof item?.key === "string" ? item.key : ""
      // 重验必须只读：dispatch-plan 是推进通道，调用它会在原波已完成时产生未投递的新波。
      const inspectPlan = () => runTw(["run", "--task", task], cwd)
      const mapAgent = (key, id) => runTw(["agent-map", "--task", task, "--key", key, "--agent", id], cwd)

      // 两种入口走同一条对账链。锁路径与 retire 共用：先 key 锁，再由 CLI 短持任务锁，
      // 宿主 I/O 始终在任务锁外；后到者拿锁后重读投影和映射，不复用旧计划快照。
      const reconcileItem = async (initial) => {
        const key = keyOf(initial)
        const label = buildDispatchLabel(plan, initial, note)
        const waveFields = initial?.waveId ? { waveId: initial.waveId } : {}
        const base = { key, label, ...waveFields }
        const errorCard = (code, message, extra = {}) => ({ ok: false, ...base, ...extra, code, message })
        if (!key) return errorCard("TW_DISPATCH_KEY_MISSING", "派单缺少 key；未登记或投递，请核对波次事实。")
        const reported = (mapping) => ({ ok: true, ...base, action: "reported", ...(typeof mapping?.agentId === "string" && mapping.agentId ? { sessionId: mapping.agentId } : {}), message: "该 key 已有有效报告，未创建或发送；重新推进以检查后续波。" })
        const mappingFailure = (mapping, id) => errorCard(mapping?.code ?? "TW_DISPATCH_REGISTER_FAILED", (mapping?.message ?? "映射状态无法确认") + "；保留原会话与映射，核对后重试。", { sessionId: id, ...(mapping?.agentId ? { mappedAgentId: mapping.agentId } : {}) })
        const checkMapping = (mapping, id) => mapping?.ok === true && mapping.status === "active" && mapping.agentId === id && typeof mapping.idempotent === "boolean"
        let currentId = typeof initial?.mappedAgentId === "string" && initial.mappedAgentId ? initial.mappedAgentId : typeof initial?.expectedAgentId === "string" && initial.expectedAgentId ? initial.expectedAgentId : null
        let hostAttempted = false
        try {
          return await withOwnerLock(dispatchLockPath(cwd, task, key), async () => {
            const refreshed = await inspectPlan()
            if (refreshed?.ok !== true) return errorCard(refreshed?.code ?? "TW_DISPATCH_STATE_UNKNOWN", "波次重验失败：" + String(refreshed?.message ?? refreshed?.card?.blockers?.[0]?.message ?? "状态不可确定") + "；保留原事实，请核对后重试。", { ...(currentId ? { sessionId: currentId } : {}) })
            const matches = refreshed?.transition === "wait-inflight" && Array.isArray(refreshed.inflight) ? refreshed.inflight.filter((entry) => keyOf(entry) === key) : []
            if (matches.length !== 1) {
              // 只对已登记 ID 做无新增映射的状态重验；报告已在锁内确认时不依赖宿主。
              if (initial?.registered === true && typeof initial.mappedAgentId === "string" && initial.mappedAgentId) {
                const mapping = await mapAgent(key, initial.mappedAgentId)
                if (mapping?.ok === true && mapping.status === "reported") return reported(mapping)
                if (!checkMapping(mapping, initial.mappedAgentId) || mapping.idempotent !== true) return mappingFailure(mapping, initial.mappedAgentId)
              }
              return errorCard("TW_DISPATCH_STATE_CHANGED", "获取投递锁后未能唯一找到原在途派单；未投递，请重新推进并核对当前波。")
            }
            const item = matches[0]
            if ((initial?.waveId && item.waveId !== initial.waveId) || Boolean(initial?.continuation) !== Boolean(item.continuation)) return errorCard("TW_DISPATCH_STATE_CHANGED", "派单波或续派身份已变化；未投递，请重新核对。")
            if (typeof item.registered !== "boolean") return errorCard("TW_DISPATCH_REGISTERED_UNKNOWN", "映射状态缺失或账本损坏；保留原事实，从可信来源核对恢复后重试。", { ...(item.registeredUnresolved ? { reason: item.registeredUnresolved } : {}) })
            if (item.registered && (typeof item.mappedAgentId !== "string" || !item.mappedAgentId.trim())) return errorCard("TW_DISPATCH_REGISTERED_UNKNOWN", "已登记但 sessionId 不可确定；不得猜用确定性 ID。")
            let id = item.registered ? item.mappedAgentId : item.continuation ? item.expectedAgentId : deterministicSessionId(task, key)
            currentId = typeof id === "string" && id.trim() ? id : null
            if (typeof id !== "string" || !id.trim()) return errorCard("TW_DISPATCH_EXPECTED_AGENT_MISSING", "续派原会话 ID 未知；不得据此推定断链或新建，请核对原映射及宿主。", { ...(item.writerSafety?.required ? { writerSafety: item.writerSafety } : initial?.writerSafety?.required ? { writerSafety: initial.writerSafety } : {}) })

            // 对已登记项先重验报告/作废与严格 CAS：reported 直接短路，不依赖会话。
            if (item.registered) {
              const mapping = await mapAgent(key, id)
              if (mapping?.ok === true && mapping.status === "reported") return reported(mapping)
              if (!checkMapping(mapping, id) || mapping.idempotent !== true) return mappingFailure(mapping, id)
            }
            if (initial?.expectedAgentIdMissing === true || item.expectedAgentIdMissing === true) return errorCard("TW_DISPATCH_EXPECTED_AGENT_MISSING", "续派原会话 ID 未经确认；不得据此推定断链或新建，请核对原映射及宿主。", { sessionId: id, ...(item.writerSafety?.required ? { writerSafety: item.writerSafety } : initial?.writerSafety?.required ? { writerSafety: initial.writerSafety } : {}) })
            const safety = item.writerSafety?.required === true ? item.writerSafety : initial?.writerSafety?.required === true ? initial.writerSafety : null
            if (safety) return errorCard("TW_DISPATCH_WRITER_SAFETY_UNKNOWN", "存在重叠的已作废旧写者，未证明其停写或撤权；未投递。" + (safety.recovery ?? "请核对旧会话后处理。"), { sessionId: id, writerSafety: safety })
            if ((item.writerSafety && typeof item.writerSafety.required !== "boolean") || (initial?.writerSafety && typeof initial.writerSafety.required !== "boolean")) return errorCard("TW_DISPATCH_WRITER_SAFETY_UNKNOWN", "旧写者安全状态损坏或未知；未投递，请核对。", { sessionId: id })
            if (initial?.modelStaleForSession === true) return errorCard("TW_DISPATCH_MODEL_CONFIRM_REQUIRED", "续派会话模型与当前模型不同，须先完成已有换模型确认。", { sessionId: id })
            const problem = frozenPromptProblem(item, key) ?? frozenPromptProblem(initial, key)
            if (problem) return errorCard("TW_DISPATCH_PROMPT_UNVERIFIED", problem + "；保留原 ID，不能比对或发送现场重建正文。", { sessionId: id })
            if (initial.prompt !== item.prompt || (initial.promptFull ?? null) !== (item.promptFull ?? null)) return errorCard("TW_DISPATCH_PROMPT_CHANGED", "获取锁后冻结正文改变；未发送，请核对派单事实。", { sessionId: id })

            let state = await observe(id)
            let priorAgentId = null
            if (state.status === "foreign") return errorCard("TW_SUB_TAKEOVER_CONFLICT", "原会话归属其他父会话；未接管或发送，请由原 Lead 核对。", { sessionId: id })
            if (state.status === "unknown") return errorCard("TW_SUB_SESSION_UNKNOWN", "会话状态无法确认：" + (state.message ?? "宿主未提供原因") + "；保留原 ID，不创建或补投。", { sessionId: id })

            // 原续派 ID 在当前宿主不可见且本 key 尚无映射时，按用户裁决使用新 key 的确定性 ID；
            // none 仅是当前观察，不证明旧调用不可能迟到。已登记的 ID 永不被此分支覆盖。
            if (state.status === "none" && item.continuation && !item.registered && item.expectedAgentId === id) {
              priorAgentId = id
              id = deterministicSessionId(task, key)
              currentId = id
              state = await observe(id)
              if (state.status === "foreign") return errorCard("TW_SUB_TAKEOVER_CONFLICT", "重建 ID 已由其他父会话使用；未接管或发送。", { sessionId: id, priorAgentId })
              if (state.status === "unknown") return errorCard("TW_SUB_SESSION_UNKNOWN", "重建 ID 状态无法确认：" + (state.message ?? "宿主未提供原因") + "；保留原会话，不创建。", { sessionId: id, priorAgentId })
            }

            const receiptFor = (observation, current) => sessionReceived({ sessions: sessionsSvc, persistence: persistenceSvc, signal: exec?.signal }, id, observation, [current.prompt, current.promptFull], key)
            const readReceipt = async (observation, current) => {
              const receipt = await receiptFor(observation, current)
              if (!receipt.ok) return { error: errorCard(receipt.code, receipt.message, { sessionId: id }) }
              if (receipt.conflict) return { error: errorCard("TW_DISPATCH_PROMPT_CONFLICT", "同 key 收单正文与冻结版本不同；保留原会话，不发送或重建。", { sessionId: id }) }
              return { receipt }
            }
            const ensureMapping = async () => {
              const mapping = await mapAgent(key, id)
              if (mapping?.ok === true && mapping.status === "reported") return { error: reported(mapping) }
              if (!checkMapping(mapping, id) || (item.registered && mapping.idempotent !== true)) return { error: mappingFailure(mapping, id) }
              return { mapping }
            }
            const waitForReceipt = () => ({ ok: true, ...base, sessionId: id, registered: true, reused: true, receiptVerified: true, action: "wait", ...(priorAgentId ? { priorAgentId } : {}), message: "已核实宿主收单（仅证明宿主收单，不保证活动或通知可达），等待成员完成通知。" })
            const liveUnreceived = async (observation) => {
              // 当前 DSH 版本未证实暴露此类活动证明；仅显式标记同时存在时才采用。
              if (observation.session?.turnActive === true && observation.session?.notificationReachable === true) {
                const registered = await ensureMapping()
                if (registered.error) return registered.error
                return { ok: true, ...base, sessionId: id, registered: true, action: "wait-prior-turn", priorActivityConfirmed: true, notificationConfirmed: true, receiptVerified: false, message: "旧轮仍在运行且通知可达，本轮正文尚未确认收单。" }
              }
              return errorCard("TW_SUB_ACTIVITY_UNVERIFIED", "原会话在场但未见本轮正文，无法证明旧轮活动与通知；未补投，请核对原会话。", { sessionId: id, receiptVerified: false })
            }
            const frozenTarget = (() => {
              try {
                const target = toHostTarget(item.modelRef)
                if (JSON.stringify(target) !== JSON.stringify(toHostTarget(initial.modelRef))) throw new Error("模型快照与初始派单不一致")
                return { target }
              } catch (error) { return { error: String(error?.message ?? error) } }
            })()
            // 映射登记后再次只读投影，再用 agent-map 在任务锁内确认波状态与 CAS。
            const confirmCurrent = async () => {
              const afterMap = await inspectPlan()
              if (afterMap?.ok !== true) return { error: errorCard(afterMap?.code ?? "TW_DISPATCH_STATE_UNKNOWN", "登记后波次重验失败；保留映射，未投递。", { sessionId: id }) }
              const current = afterMap.transition === "wait-inflight" && Array.isArray(afterMap.inflight) ? afterMap.inflight.filter((entry) => keyOf(entry) === key) : []
              const checked = await mapAgent(key, id)
              if (checked?.ok === true && checked.status === "reported") return { error: reported(checked) }
              if (!checkMapping(checked, id) || checked.idempotent !== true) return { error: mappingFailure(checked, id) }
              if (current.length !== 1 || current[0].waveId !== item.waveId || current[0].registered !== true || current[0].mappedAgentId !== id) return { error: errorCard("TW_DISPATCH_STATE_CHANGED", "登记后波或映射已变化；保留映射，未投递。", { sessionId: id }) }
              const now = current[0]
              if (now.writerSafety && (typeof now.writerSafety.required !== "boolean" || now.writerSafety.required)) return { error: errorCard("TW_DISPATCH_WRITER_SAFETY_UNKNOWN", "登记后旧写者停写状态不可证明；未投递。", { sessionId: id, writerSafety: now.writerSafety }) }
              const nowProblem = frozenPromptProblem(now, key)
              if (nowProblem || now.prompt !== item.prompt || (now.promptFull ?? null) !== (item.promptFull ?? null)) return { error: errorCard("TW_DISPATCH_PROMPT_UNVERIFIED", (nowProblem ?? "登记后冻结正文发生变化") + "；未投递。", { sessionId: id }) }
              try {
                if (JSON.stringify(toHostTarget(now.modelRef)) !== JSON.stringify(frozenTarget.target)) throw new Error("模型快照已改变")
              } catch (error) { return { error: errorCard("TW_DISPATCH_MODEL_REF_UNRESOLVED", "登记后无法验证精确模型：" + String(error?.message ?? error) + "；保留映射，未投递。", { sessionId: id }) } }
              return { now }
            }

            if (state.status === "live" || state.status === "ours") {
              const firstRead = await readReceipt(state, item)
              if (firstRead.error) return firstRead.error
              if (state.status === "live") {
                if (!firstRead.receipt.currentReceived) return liveUnreceived(state)
                const registered = await ensureMapping()
                if (registered.error) return registered.error
                return waitForReceipt()
              }
              if (frozenTarget.error) return errorCard("TW_DISPATCH_MODEL_REF_UNRESOLVED", "无法验证派单的精确模型：" + frozenTarget.error + "；未投递。", { sessionId: id })
              const registered = await ensureMapping()
              if (registered.error) return registered.error
              const checked = await confirmCurrent()
              if (checked.error) return checked.error
              const now = checked.now
              // 重验后重新查询：如果会话已在场，不向 live 重投。
              const beforeSend = await observe(id)
              if (beforeSend.status !== "live" && beforeSend.status !== "ours") return errorCard("TW_SUB_SESSION_UNKNOWN", "续投前会话状态或归属已变化；保留映射，未发送。", { sessionId: id })
              const latestRead = await readReceipt(beforeSend, now)
              if (latestRead.error) return latestRead.error
              if (beforeSend.status === "live") return latestRead.receipt.currentReceived ? waitForReceipt() : liveUnreceived(beforeSend)
              if ((firstRead.receipt.currentReceived && !latestRead.receipt.currentReceived) || (firstRead.receipt.received && !latestRead.receipt.received)) return errorCard("TW_SUB_SESSION_UNKNOWN", "续投前日志回退，无法判定收单；保留映射，未发送。", { sessionId: id })
              const followup = coldResumePrompt(latestRead.receipt, now.prompt, now.promptFull ?? now.prompt)
              hostAttempted = true
              const sent = await followupChild({ subagents: subagentsSvc, parent: exec?.agent, signal: exec?.signal }, id, followup.text)
              if (!sent.ok) return errorCard(sent.code, sent.message, { sessionId: id, registered: true })
              const afterSend = await observe(id)
              if (afterSend.status !== "live" && afterSend.status !== "ours") return errorCard("TW_SUB_SESSION_UNKNOWN", "续投回执已收到，但会话或归属不可核验；保留 ID，检查收单。", { sessionId: id, registered: true, accepted: true, messageId: sent.messageId })
              const afterRead = await readReceipt(afterSend, now)
              if (afterRead.error) return { ...afterRead.error, registered: true, accepted: true, messageId: sent.messageId }
              if (!afterRead.receipt.currentReceived) return errorCard("TW_SUB_RECEIPT_UNCONFIRMED", "续投回执已收到，但本轮正文尚未确认；保留 ID 核对，不把回执冒充收单。", { sessionId: id, registered: true, accepted: true, messageId: sent.messageId })
              return { ok: true, ...base, sessionId: id, registered: true, receiptVerified: true, action: "followup", resume: followup.resume, refollowed: true, messageId: sent.messageId, ...(priorAgentId ? { priorAgentId } : {}), message: "已核实宿主收单；仅表示收单，不保证成员完成或通知可达。" }
            }

            if (state.status !== "none") return errorCard("TW_SUB_SESSION_UNKNOWN", "会话状态不受支持；保留原映射，未投递。", { sessionId: id })
            if (frozenTarget.error) return errorCard("TW_DISPATCH_MODEL_REF_UNRESOLVED", "无法验证派单的精确模型：" + frozenTarget.error + "；未投递。", { sessionId: id })
            const registered = await ensureMapping()
            if (registered.error) return registered.error
            const checked = await confirmCurrent()
            if (checked.error) return checked.error
            const now = checked.now
            const createPrompt = item.continuation ? now.promptFull : now.prompt
            hostAttempted = true
            const created = await createSubagent(ctx, coreDeps, { description: label, prompt: createPrompt, modelRef: now.modelRef, sessionId: id, dispatchKey: key, allowCreate: true, exec })
            if (!created || created.ok !== true || created.sessionId !== id) {
              return errorCard(created?.code ?? "TW_DISPATCH_CREATE_FAILED", (created?.message ?? "创建回执不可确认") + "；保留原映射，检查同 ID。", { sessionId: id, ...(created?.accepted ? { accepted: true, persistenceConfirmed: created.persistenceConfirmed, messageId: created.messageId } : {}), ...(created?.returnedSessionId ? { returnedSessionId: created.returnedSessionId } : {}), ...(priorAgentId ? { priorAgentId } : {}) })
            }
            const afterCreate = await observe(id)
            if (afterCreate.status !== "live" && afterCreate.status !== "ours") return errorCard("TW_SUB_SESSION_UNKNOWN", "宿主已返回创建回执，但当前会话或其归属不可核验；保留 ID 并核对。", { sessionId: id, registered: true, accepted: true, messageId: created.messageId })
            const afterRead = await readReceipt(afterCreate, now)
            if (afterRead.error) return { ...afterRead.error, registered: true, accepted: true, messageId: created.messageId }
            if (!afterRead.receipt.currentReceived) return errorCard("TW_SUB_RECEIPT_UNCONFIRMED", "创建回执已收到，但冻结正文尚未在日志确认；保留原 ID。", { sessionId: id, registered: true, accepted: true, messageId: created.messageId })
            const action = priorAgentId ? "fresh_rebuilt" : item.registered ? "recreated" : "wait"
            return { ok: true, ...base, sessionId: id, registered: true, accepted: true, receiptVerified: true, action, messageId: created.messageId, provider: created.provider, model: created.model, ...(created.effort ? { effort: created.effort } : {}), ...(priorAgentId ? { priorAgentId, continuation: true, recovered: true, freshRebuilt: true } : {}), message: "已核实宿主收单（仅证明收单，不保证活动或通知可达），等待成员完成通知。" }
          })
        } catch (error) {
          return errorCard(error?.code ?? "TW_DISPATCH_LOCK_FAILED", "投递锁或对账失败：" + String(error?.message ?? error) + "；保留原映射与会话，请核对后重试。", { ...(currentId ? { sessionId: currentId } : {}), ...(hostAttempted ? { hostAttempted: true } : {}) })
        }
      }

      const items = []
      for (const item of isInflight ? plan.inflight : plan.waves) items.push(await reconcileItem(item))
      const failures = items.filter((item) => !item.ok).length
      const nextAction = nextActionFor(items)
      const result = {
        ok: true, task: plan.task ?? task, stage: plan.stage,
        ...(isInflight || nextAction === "wait-prior-turn" ? { stop: "wait-inflight" } : { stop: null }),
        nextAction, ...(isInflight ? { inflight: items } : { dispatched: items }), ...presentation,
        ...(failures ? { failures, note: "有条目需要核对；其他条目的结果保留，不得重投未知项。" } : nextAction === "recover" ? { note: "本波已报告或没有可证明的等待条件；请重新推进或按条目核对。" } : {}),
      }
      if (nextAction === "wait-children") sleepConfirm.noteDispatch(exec, result)
      return result
    },
    output: {
      schema: TW_DISPATCH_OUTPUT_SCHEMA,
      render: (_params, card) => [{ type: "text", text: JSON.stringify(card, null, 2) }],
    },
  }
}
