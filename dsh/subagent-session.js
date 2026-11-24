// 工作流内部会话操作；只接受派单中的精确模型，不提供普通委派工具。
export const SUBAGENT_PROVIDER = "spawn"
const describe = (error) => String(error?.message ?? error)
const failure = (code, message, sessionId) => ({ ok: false, code, message, ...(sessionId ? { sessionId } : {}) })

export async function coldSessionStatus({ persistence, parentSessionId, signal }, childId) {
  if (typeof persistence?.stat !== "function") return { status: "unknown", message: "sessionPersistence.stat 不可用" }
  try {
    const found = await persistence.stat(childId, { signal })
    if (found === undefined) return { status: "none" }
    if (!found?.header || found.header.id !== childId || typeof found.header.parentSession !== "string" || !found.header.parentSession) return { status: "unknown", message: "持久化元数据或父级无法判定" }
    return { status: found.header.parentSession === parentSessionId ? "ours" : "foreign", header: found.header }
  } catch (error) {
    return { status: "unknown", message: describe(error) }
  }
}

export async function reconcileSession({ sessions, persistence, parentSessionId, signal }, childId) {
  if (typeof parentSessionId !== "string" || !parentSessionId.trim()) return { status: "unknown", message: "父会话 ID 不可用" }
  if (typeof sessions?.get !== "function") return { status: "unknown", message: "sessions.get 不可用" }
  try {
    const live = sessions.get(childId)
    if (live != null) {
      if (typeof live?.header?.parentSession !== "string" || !live.header.parentSession || (live.header.id !== undefined && live.header.id !== childId)) return { status: "unknown", message: "在场会话 ID 或父级无法判定" }
      return { status: live.header.parentSession === parentSessionId ? "live" : "foreign", session: live }
    }
  } catch (error) { return { status: "unknown", message: describe(error) } }
  return coldSessionStatus({ persistence, parentSessionId, signal }, childId)
}

// 只识别派单首行完整 key，不把普通文字、前缀或继承历史当成本轮收单。
export function dispatchKeyFromPrompt(text) {
  if (typeof text !== "string") return null
  const first = text.split("\n", 1)[0].replace(/\r$/, "")
  return /^# (?:派单|续派|续派全量变体)（key: ([^）\r\n]+)）(?:——[^\r\n]*)?$/.exec(first)?.[1] ?? null
}

// 宿主可能前置通知或追加引导，逐个正文块精确比对；未读到不代表未收单。
export async function coldSessionReceived(persistence, childId, signal, expectedPrompts = [], dispatchKey = null) {
  let handle
  let result
  try {
    if (typeof persistence?.open !== "function") throw new Error("sessionPersistence.open 不可用")
    handle = await persistence.open(childId, "read", { signal })
    const read = await handle.read(undefined, undefined, { signal })
    const inherited = handle.inheritedEventCount
    if (!Array.isArray(read?.events) || !Number.isSafeInteger(inherited) || inherited < 0 || inherited > read.events.length || read.truncated === true || read.hasMore === true) throw new Error("会话事件、完整性或继承前缀无法判定")
    const expected = expectedPrompts.filter((text) => typeof text === "string" && text.trim())
    let received = false
    let currentReceived = false
    let currentAdmitted = false
    let conflict = false
    for (const event of read.events.slice(inherited)) {
      if (typeof event?.type !== "string") throw new Error("会话事件无法判定")
      // user/message 是派单已进入模型上下文的证据；仅排入 inbox 还不能切换成员当前 key。
      if (event.type === "user/message" && dispatchKey !== null && Array.isArray(event.data?.content)) {
        currentAdmitted ||= event.data.content.some((block) => block?.type === "text" && expected.includes(block.text) && dispatchKeyFromPrompt(block.text) === dispatchKey)
      }
      if (event.type !== "agent/inbox/spliced") continue
      if (!Array.isArray(event.data?.inserted)) throw new Error("收单日志 inserted 无法判定")
      for (const message of event.data.inserted) {
        if (!Array.isArray(message?.content)) throw new Error("收单消息 content 无法判定")
        if (dispatchKey === null) received = true
        for (const block of message.content) {
          if (typeof block?.type !== "string") throw new Error("收单内容块无法判定")
          if (block.type !== "text") continue
          if (typeof block.text !== "string") throw new Error("收单文本无法判定")
          const seenKey = dispatchKeyFromPrompt(block.text)
          if (dispatchKey !== null && seenKey !== null) received = true
          if ((dispatchKey === null || seenKey === dispatchKey) && expected.includes(block.text)) currentReceived = true
          else if (dispatchKey !== null && seenKey === dispatchKey) conflict = true
        }
      }
    }
    result = { ok: true, received, currentReceived, ...(currentAdmitted ? { currentAdmitted: true } : {}), ...(conflict ? { conflict: true } : {}) }
  } catch (error) {
    result = failure("TW_SUB_SESSION_UNKNOWN", "收单日志读取不确定：" + describe(error) + "；保留原 ID 并核对宿主，未补投正文", childId)
  } finally {
    if (handle) {
      try { await handle.close() } catch (error) { result = failure("TW_SUB_SESSION_UNKNOWN", "关闭会话读取句柄失败：" + describe(error) + "；保留原 ID 并核对宿主", childId) }
    }
  }
  return result
}

// 在场 Session 的日志可能仍在缓冲，先用公开持久化屏障，再读取自身事件。
// 这只证明看见的收单，不证明 turn 活动、通知可达或缺失消息绝不会迟到。
export async function sessionReceived({ sessions, persistence, signal }, childId, observation, expectedPrompts, dispatchKey) {
  if (observation.status === "live") {
    if (typeof sessions?.flush !== "function") return failure("TW_SUB_PERSISTENCE_UNAVAILABLE", "无法刷新在场会话日志；收单无法核验", childId)
    try {
      if (await sessions.flush(observation.session) !== true) return failure("TW_SUB_NOT_PERSISTED", "会话 flush 未确认；收单无法核验", childId)
    } catch (error) { return failure("TW_SUB_FLUSH_FAILED", "会话 flush 失败：" + describe(error), childId) }
  }
  return coldSessionReceived(persistence, childId, signal, expectedPrompts, dispatchKey)
}

// 冷续派保留历史行为：已收正文只发轻提醒，否则按是否有旧上下文选增量或全量。
export function coldResumePrompt(read, prompt, promptFull = prompt) {
  if (read.currentReceived) return { resume: "reminder", text: "会话日志确认你已收到本轮派单正文。同一 key 已通过 tw deliver/review 登记则正常结束，不预告、不另发交卷摘要，也不重复工作；未登记则按原派单继续，完成后用对应工具登记。" }
  return read.received ? { resume: "incremental", text: prompt } : { resume: "full", text: promptFull }
}

// —— ModelRef → 宿主 target 的唯一映射点（方案 §3.0）——
// runtime 只处理 {provider, modelName, effort?, family?}；宿主字段是 {provider, model, reasoningEffort?}。
// effort 缺省 = 不传该字段（宿主实测："" 被 assertNonEmpty 拒绝，"none" 被 UNSUPPORTED_REASONING_EFFORT 拒绝）。
export function toHostTarget(ref) {
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) throw new Error("ModelRef 必须是对象")
  if (typeof ref.provider !== "string" || !ref.provider.trim()) throw new Error("ModelRef.provider 必须是非空字符串")
  if (typeof ref.modelName !== "string" || !ref.modelName.trim()) throw new Error("ModelRef.modelName 必须是非空字符串")
  if (ref.effort !== undefined && (typeof ref.effort !== "string" || !ref.effort.trim() || ref.effort.trim() === "none")) {
    throw new Error('ModelRef.effort 必须是非空字符串且不能为 "none"（不设置推理强度时省略 effort）')
  }
  return {
    provider: ref.provider.trim(),
    model: ref.modelName.trim(),
    ...(ref.effort !== undefined ? { reasoningEffort: ref.effort.trim() } : {}),
  }
}

// 成员消息是单块业务正文：派单卡自带规范段，绑定层不再追加规则块或缺失诊断句。
// 冷收单按整块文本精确匹配，单块正文与历史多块日志都能判定本轮是否已收。
function memberMessage(text) {
  return [{ type: "text", text }]
}

export async function followupChild({ subagents, parent, signal }, childId, text) {
  if (typeof subagents?.sendMessage !== "function") return failure("TW_SUB_FOLLOWUP_UNAVAILABLE", "subagents.sendMessage 不可用，请检查宿主", childId)
  try {
    const messageId = await subagents.sendMessage(parent, childId, memberMessage(text), { signal: signal ?? new AbortController().signal })
    if (typeof messageId !== "string" || !messageId.trim()) return failure("TW_SUB_FOLLOWUP_UNCONFIRMED", "续投没有可确认的消息 ID；可能已经接收，请核对原会话", childId)
    return { ok: true, sessionId: childId, messageId }
  } catch (error) {
    const code = error?.code === "UNAUTHORIZED" ? "TW_SUB_TAKEOVER_CONFLICT" : error?.code === "NOT_RESUMABLE" ? "TW_SUB_NOT_RESUMABLE" : "TW_SUB_FOLLOWUP_FAILED"
    return failure(code, "续投回执未确认：" + describe(error) + "；保留原会话并核对收单，异常本身不证明消息未接收", childId)
  }
}

export async function createDirectedSubagent(ctx, deps = {}, input = {}) {
  const get = deps.getService ?? ((name) => typeof ctx?.get === "function" ? ctx.get(name) : ctx?.[name])
  const id = input.sessionId
  if (typeof id !== "string" || !id.trim() || typeof input.exec?.agent?.id !== "string" || !input.exec.agent.id.trim() || typeof input.description !== "string" || !input.description.trim() || typeof input.prompt !== "string" || !input.prompt.trim()) {
    return failure("TW_SUB_INPUT_INVALID", "会话 ID、父 Agent、标签和派单正文必须完整；请修复派单后重试", typeof id === "string" ? id : undefined)
  }
  let sessions, persistence
  try { sessions = get("sessions"); persistence = get("sessionPersistence") } catch (error) { return failure("TW_SUB_SESSION_UNKNOWN", describe(error), id) }
  const state = await reconcileSession({ sessions, persistence, parentSessionId: input.exec?.agent?.id, signal: input.exec?.signal }, id)
  if (state.status === "unknown") return failure("TW_SUB_SESSION_UNKNOWN", "会话现状无法确认：" + state.message + "；保留映射，请检查宿主后查询同一会话 ID，勿另建成员", id)
  if (state.status === "foreign") return failure("TW_SUB_TAKEOVER_CONFLICT", "会话归属其他父会话（接管冲突）；由原 Lead 继续，或作废该波再派发", id)
  // 只允许调用方在投递锁内完成映射及波次重验后明确许可；已有会话由外层对账。
  // stat 未命中仅是当前观察，不能排除旧调用迟到。
  if (state.status !== "none") return failure("TW_SUB_SESSION_EXISTS", "同 ID 会话已存在，未创建或补投；请核对原会话活动及收单", id)
  if (input.allowCreate !== true) return failure("TW_SUB_CREATE_UNPROVEN", "没有本次持锁对账后的创建许可；未创建成员，请核对原 ID", id)

  // 绑定层只收 runtime 的 ModelRef（内部映射为宿主 target）；historical 精确 target 仍接受以兼容旧调用方。
  let target
  if (input.modelRef !== undefined) {
    try { target = toHostTarget(input.modelRef) } catch (error) {
      return failure("TW_SUB_MODEL_REF_INVALID", "modelRef 无效：" + describe(error) + "；请在 open / tw roles / tw plan 中给出合法 ModelRef（effort 不设置时省略字段）", id)
    }
  } else target = input.target
  if (!target || target.tier !== undefined || typeof target.provider !== "string" || !target.provider.trim() || typeof target.model !== "string" || !target.model.trim() || (target.reasoningEffort !== undefined && (typeof target.reasoningEffort !== "string" || !target.reasoningEffort.trim())) || (target.effort !== undefined && (typeof target.effort !== "string" || !target.effort.trim()))) {
    return failure("TW_SUB_TARGET_INVALID", "需要精确 target：{provider, model, reasoningEffort?}；缺档时请修复插件 tiers 配置", id)
  }
  // 兼容入口：旧调用方仍可传 target.effort；统一归一到宿主字段 reasoningEffort，缺省不传。
  const hostEffort = target.reasoningEffort !== undefined ? target.reasoningEffort : target.effort
  let subagents, llm, resolved, maxDepth
  try {
    subagents = get("subagents"); llm = get("llm")
    if (typeof llm?.resolveCallConfig !== "function") return failure("TW_SUB_LLM_UNAVAILABLE", "llm.resolveCallConfig 不可用", id)
    resolved = await llm.resolveCallConfig({ provider: target.provider, model: target.model, ...(hostEffort ? { reasoningEffort: hostEffort } : {}) })
    if (!resolved || resolved.provider !== target.provider || resolved.model !== target.model || (hostEffort !== undefined && resolved.reasoningEffort !== hostEffort)) {
      return failure("TW_SUB_EXPLICIT_SELECTION_MISMATCH", "宿主未确认精确模型或显式 effort；未创建成员，请核对 tiers", id)
    }
    if ((typeof subagents?.startActivation !== "function" && typeof subagents?.startContinuable !== "function") || typeof subagents?.resolveMaxDepth !== "function") return failure("TW_SUB_SUBAGENTS_UNAVAILABLE", "subagents.startActivation（旧版 startContinuable）/resolveMaxDepth 不可用", id)
    const provider = subagents.getProvider?.(deps.subagentProviderName ?? SUBAGENT_PROVIDER)
    if (!provider) return failure("TW_SUB_PROVIDER_MISSING", "spawn 子代理 provider 未注册", id)
    if (typeof provider.prepareContinuable !== "function") return failure("TW_SUB_PROVIDER_NOT_CONTINUABLE", "spawn provider 不支持可续聊成员", id)
    maxDepth = subagents.resolveMaxDepth()
  } catch (error) { return failure("TW_SUB_MODEL_INVALID", "创建前验证失败（未创建子会话）：" + describe(error), id) }
  const agentOptions = { provider: resolved.provider, model: resolved.model, ...(resolved.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}) }
  let start
  try {
    // 新版显式交给父级接收结果，旧版保留原 continuable 入口；不自行接管生命周期。
    const activation = typeof subagents.startActivation === "function"
    const create = activation ? subagents.startActivation : subagents.startContinuable
    const request = { parent: input.exec.agent, prompt: memberMessage(input.promptFull?.trim() ? input.promptFull : input.prompt), agentOptions, maxDepth }
    // DSH 0.2.2-rc.2 的 startActivation 使用顶层参数签名；0.2.1-rc.2 读 request 对象。
    // 两个入口同时携带 request 与顶层 {parent,prompt,agentOptions,maxDepth}，兼容两版宿主；旧 startContinuable 只传 request。
    start = await create.call(subagents, { provider: deps.subagentProviderName ?? SUBAGENT_PROVIDER, label: input.description, childId: id,
      request,
      ...(activation ? { parent: request.parent, prompt: request.prompt, agentOptions: request.agentOptions, maxDepth: request.maxDepth, delivery: "parent" } : {}),
      signal: input.exec.signal ?? new AbortController().signal })
  } catch (error) { return failure("TW_SUB_START_FAILED", "成员创建失败：" + describe(error) + "；保留映射，先核对同 ID 会话后重试", id) }
  if (start?.childId !== undefined && start.childId !== id) return { ...failure("TW_SUB_ID_MISMATCH", "宿主返回不同子会话 ID；保留原映射并核对回执，禁止自动换 ID", id), returnedSessionId: start.childId, accepted: true, persistenceConfirmed: false }
  const childId = id
  const unconfirmed = (code, message) => ({ ...failure(code, message + "；初始消息已接收但持久化尚未确认，保留映射，请检查同 ID 的现状；勿另建成员或自动重投正文", childId), accepted: true, persistenceConfirmed: false, messageId: start?.messageId })
  try {
    const childSession = sessions.get(childId)
    if (!childSession) return unconfirmed("TW_SUB_SESSION_MISSING", "成员已创建但活会话已不可读")
    if (typeof sessions.flush !== "function") return unconfirmed("TW_SUB_PERSISTENCE_UNAVAILABLE", "sessions.flush 不可用")
    let flushed
    try { flushed = await sessions.flush(childSession) } catch (error) { return unconfirmed("TW_SUB_FLUSH_FAILED", describe(error)) }
    if (flushed !== true) return unconfirmed("TW_SUB_NOT_PERSISTED", "未取得持久化监听器确认（flush=false）")
  } catch (error) { return unconfirmed("TW_SUB_SESSION_READ_FAILED", describe(error)) }
  return { ok: true, sessionId: childId, messageId: start?.messageId, provider: resolved.provider, model: resolved.model, ...(resolved.reasoningEffort ? { effort: resolved.reasoningEffort } : {}), source: "explicit" }
}
