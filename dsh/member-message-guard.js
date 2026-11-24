// 正式成员的发送前软引导：只依赖已核验派单、宿主路由和报告登记，不分析消息内容。
import { createHash, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { parseJournal, projectReportsFromJournal, readJson, taskRoot } from "../runtime-v3/store.mjs"
import { supersededKeys } from "../runtime-v3/waves.mjs"
import { dispatchKeyFromPrompt } from "./subagent-session.js"
import { resolveChildCwd } from "./tw-tool.js"

const NON_DELIVERY = "TWR_MEMBER_MESSAGE_DEFERRED"
const GUIDE = "这条消息还没发。如果只是开工告知、过程进度、测试计数或交卷摘要，请继续工作，结束时用 tw deliver/review 登记，不另发摘要。如果是在答 Lead 的问询，或确有范围争议、阻塞需要 Lead 立即处理，可在后续 Step 再发一次。"
const REMINDER = "这条消息未发送：同一 Step 的预排或并行调用不能确认发送；确需协调时请在后续 Step 再发。"

function stepOf(agent) {
  const phase = agent?.phase
  return phase?.kind === "running" && Number.isSafeInteger(phase.turn) && Number.isSafeInteger(phase.step)
    ? { turn: phase.turn, step: phase.step }
    : null
}

function notSent(message) {
  // 原生 send_message 成功结果只有 messageId。走宿主可恢复错误结果，不伪造成功或丢失 deferContext。
  return { isError: true, error: { message, info: { name: "TwrMemberMessageDeferred", code: NON_DELIVERY } }, content: [{ type: "text", text: message }] }
}

// 只打开派单所指任务的事实。新报告以已提交事件为准；旧报告复用 Runtime 投影，
// 只查本 key 对应的历史文件。已登记的 blocked / escalate 同样是正式报告，不取决于是否过门。
async function readReportStatus({ cwd, task, key, sessionId, kind, role }) {
  const root = taskRoot(cwd, task)
  const [raw, agents] = await Promise.all([
    readFile(path.join(root, "journal.jsonl"), "utf8"),
    readJson(path.join(root, "agents.json")),
  ])
  const journal = parseJournal(raw)
  if (supersededKeys(journal).has(key)) return "retired"
  const dispatches = journal.filter((e) => e.type === "dispatched" && e.detail?.key === key)
  if (dispatches.length !== 1 || dispatches[0].detail.role !== role || agents?.mappings?.[key] !== sessionId) return "unknown"
  const reportId = kind + "-" + key
  const commits = journal.filter((event) => ["report-committed", "report-accepted"].includes(event.type) && (event.detail?.dispatchKey === key || event.detail?.reportId === reportId))
  if (!commits.length) return "unreported"
  if (commits.some(({ detail }) => detail.reportId !== reportId || (detail.dispatchKey !== undefined && detail.dispatchKey !== key)
    || (detail.kind !== undefined && detail.kind !== kind) || (detail.role !== undefined && detail.role !== role))) return "unknown"
  const legacy = commits.some((event) => event.type === "report-accepted")
  const file = legacy ? await readJson(path.join(root, "reports", reportId + ".json"), { allowMissing: true }) : null
  const reports = projectReportsFromJournal(file ? [file] : [], [...dispatches, ...commits])
  const registered = reports.some((r) => r.reportId === reportId && r.dispatchKey === key && r.kind === kind && r.role === role
    && commits.some((e) => (e.detail.ver ?? 1) === (r.ver ?? 1)))
  return registered ? "reported" : "unknown"
}

export function createMemberMessageGuard({ resolveRecipient, reportStatus = readReportStatus, log = () => {} } = {}) {
  const bySession = new Map()
  let disposed = false
  const onError = () => {
    try { log("成员消息软引导检查失败，原调用继续执行。") } catch { /* 日志不能阻塞发送 */ }
  }

  // 调度器只在映射 CAS 和冻结正文均核对后登记候选；候选不等于新 key 已进入模型上下文。
  const trackDispatch = (input, admitted = false) => {
    if (disposed) return
    try {
      const { cwd, task, key, sessionId, leadId, role, promptDigest, promptFullDigest } = input
      if (![cwd, task, key, sessionId, leadId].every((v) => typeof v === "string" && v) || sessionId === leadId || !["owner", "challenger", "expert"].includes(role)) return
      const previous = bySession.get(sessionId)
      if (previous?.key === key && previous.task === task && previous.leadId === leadId && previous.cwd === cwd) {
        if (admitted) previous.admitted = true
        return
      }
      bySession.set(sessionId, { cwd, task, key, sessionId, leadId, role, kind: role === "owner" ? "deliver" : "review",
        digests: [promptDigest, promptFullDigest].filter(Boolean), admitted, reported: false, hint: null, released: null })
    } catch { onError() }
  }

  const observeSession = (session, event) => {
    try {
      const member = bySession.get(session?.id)
      if (!member) return
      if (event?.type === "turn/start" || event?.type === "turn/end") {
        member.hint = member.released = null
      } else if (event?.type === "user/message" && !member.admitted && session.header?.parentSession === member.leadId && session.header?.cwd === member.cwd) {
        // 不是排入 inbox 即生效；必须是本会话实际接纳的已核验冻结派单。只保留摘要，不保存正文。
        member.admitted = event.data?.content?.some((block) => block?.type === "text" && dispatchKeyFromPrompt(block.text) === member.key
          && member.digests.includes(createHash("sha256").update(block.text, "utf8").digest("hex"))) === true
      }
    } catch { onError() }
  }

  const noteReport = (exec, cwd, args, result) => {
    try {
      const member = bySession.get(exec?.agent?.id)
      if (!member?.admitted || exec.agent.session?.header?.parentSession !== member.leadId || cwd !== member.cwd
        || args[0] !== member.kind || result?.accepted !== true || result.reportId !== member.kind + "-" + member.key) return
      // deliver/review 的单值参数重复会被 CLI 拒绝；这里只识别成功回执对应任务与 key，不复做校验。
      let task, key
      for (let i = 1; i < args.length; i += 2) {
        if (args[i] === "--task") task = args[i + 1]
        if (args[i] === "--key") key = args[i + 1]
      }
      if (task !== member.task || key !== member.key) return
      member.reported = true
      member.hint = member.released = null
    } catch { onError() }
  }

  const decide = async (exec) => {
    if (exec?.name !== "send_message" || typeof exec.deferContext !== "function" || typeof resolveRecipient !== "function" || exec.signal?.aborted) return
    const { agent } = exec
    const member = bySession.get(agent?.id)
    const header = agent?.session?.header
    const step = stepOf(agent)
    const recipient = exec.arguments?.agent
    if (!member?.admitted || header?.id !== member.sessionId || header.parentSession !== member.leadId || resolveChildCwd(exec) !== member.cwd
      || !step || typeof recipient !== "string" || !recipient) return
    if (await resolveRecipient(exec, recipient) !== member.leadId) return
    if (member.reported) return
    const status = await reportStatus(member)
    const current = stepOf(agent)
    if (bySession.get(member.sessionId) !== member || current?.turn !== step.turn || current.step !== step.step || exec.signal?.aborted) return
    if (status === "retired") bySession.delete(member.sessionId)
    if (status === "reported") member.reported = true
    if (status !== "unreported" || member.reported) return
    // 自判凭据按 turn/Step 隔离；await 都在此段之前，并发只消费一次，不给同 Step 其他调用搭便车。
    if (member.hint?.turn === step.turn) {
      if (step.step <= member.hint.step) return notSent(REMINDER)
      member.hint = null
      member.released = step
      return
    }
    if (member.released?.turn === step.turn && step.step <= member.released.step) return notSent(REMINDER)
    const response = notSent(GUIDE)
    exec.deferContext({ id: randomUUID(), role: "user", content: response.content, source: {
      kind: "twr-member-message", form: "notice", summary: "正式成员发送前自判提示",
    } })
    member.hint = step
    return response
  }

  const aroundExecute = async (exec, next) => {
    let result
    try { result = await decide(exec) } catch { onError() }
    // 原生错误原样冒出，不在守卫 catch 里重试 next。
    return result ?? next()
  }
  return { aroundExecute, trackDispatch, observeSession, noteReport, dispose() { disposed = true; bySession.clear() } }
}
