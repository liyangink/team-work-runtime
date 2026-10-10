// 工作流内部会话操作；只接受派单中的精确模型，不提供普通委派工具。
export const SUBAGENT_PROVIDER = "spawn"
const describe = (error) => String(error?.message ?? error)
const failure = (code, message, sessionId) => ({ ok: false, code, message, ...(sessionId ? { sessionId } : {}) })

export async function coldSessionStatus({ persistence, parentSessionId, signal }, childId) {
  if (typeof persistence?.stat !== "function") return { status: "unknown", message: "sessionPersistence.stat 不可用" }
  try {
    const found = await persistence.stat(childId, { signal })
    if (found === undefined) return { status: "none" }
    if (!found?.header || found.header.id !== childId) return { status: "unknown", message: "持久化元数据无法判定" }
    return { status: found.header.parentSession === parentSessionId ? "ours" : "foreign", header: found.header }
  } catch (error) {
    return { status: "unknown", message: describe(error) }
  }
}

export async function reconcileSession({ sessions, persistence, parentSessionId, signal }, childId) {
  if (typeof sessions?.get !== "function") return { status: "unknown", message: "sessions.get 不可用" }
  try {
    const live = sessions.get(childId)
    if (live != null) return { status: live?.header?.parentSession === parentSessionId ? "live" : "foreign" }
  } catch (error) { return { status: "unknown", message: describe(error) } }
  return coldSessionStatus({ persistence, parentSessionId, signal }, childId)
}

// 不确定读取必须阻止补投；finally 始终释放只读 handle。
export async function coldSessionReceived(persistence, childId, signal, expectedPrompts = []) {
  let handle
  try {
    if (typeof persistence?.open !== "function") throw new Error("sessionPersistence.open 不可用")
    handle = await persistence.open(childId, "read", { signal })
    const read = await handle.read(undefined, undefined, { signal })
    const inherited = handle.inheritedEventCount
    if (!Array.isArray(read?.events) || !Number.isSafeInteger(inherited) || inherited < 0 || inherited > read.events.length) throw new Error("会话事件或继承前缀无法判定")
    const expected = expectedPrompts.filter((text) => typeof text === "string" && text.trim())
    let received = false
    let currentReceived = false
    for (const event of read.events.slice(inherited)) {
      if (typeof event?.type !== "string") throw new Error("会话事件无法判定")
      if (event.type !== "agent/inbox/spliced") continue
      if (!Array.isArray(event.data?.inserted)) throw new Error("收单日志 inserted 无法判定")
      for (const message of event.data.inserted) {
        if (!Array.isArray(message?.content)) throw new Error("收单消息 content 无法判定")
        received = true
        for (const block of message.content) {
          if (typeof block?.type !== "string") throw new Error("收单内容块无法判定")
          if (block?.type === "text") {
            if (typeof block.text !== "string") throw new Error("收单文本无法判定")
            if (expected.includes(block.text)) currentReceived = true
          }
        }
      }
    }
    return { ok: true, received, currentReceived }
  } catch (error) {
    return failure("TW_SUB_SESSION_UNKNOWN", "冷会话读取不确定：" + describe(error) + "；请检查同 ID 会话后重试，未补投正文", childId)
  } finally {
    if (handle) await handle.close()
  }
}

export function coldResumePrompt(read, prompt, promptFull = prompt) {
  if (read.currentReceived) return { resume: "reminder", text: "会话日志确认你已收到本轮派单正文。请继续按已有派单完成工作，并通过 tw deliver/review 交付；如果已经交付，请汇报现有结果，不要重复执行整轮工作。" }
  return read.received ? { resume: "incremental", text: prompt } : { resume: "full", text: promptFull }
}

export async function followupChild({ subagents, parent, signal }, childId, text) {
  if (typeof subagents?.sendMessage !== "function") return failure("TW_SUB_FOLLOWUP_UNAVAILABLE", "subagents.sendMessage 不可用，请检查宿主", childId)
  try {
    const messageId = await subagents.sendMessage(parent, childId, [{ type: "text", text }], { signal: signal ?? new AbortController().signal })
    return { ok: true, sessionId: childId, messageId }
  } catch (error) {
    const code = error?.code === "UNAUTHORIZED" ? "TW_SUB_TAKEOVER_CONFLICT" : error?.code === "NOT_RESUMABLE" ? "TW_SUB_NOT_RESUMABLE" : "TW_SUB_FOLLOWUP_FAILED"
    return failure(code, "续投失败：" + describe(error) + "；保留现有会话 ID，由原父会话继续或作废该波重新派发；未确认回执时不要另建成员", childId)
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
  if (state.status === "live") return { ok: true, sessionId: id, reused: true, source: "reconciled" }
  if (state.status === "ours") {
    let read
    try { read = await coldSessionReceived(persistence, id, input.exec?.signal, [input.prompt, input.promptFull]) } catch (error) { return failure("TW_SUB_SESSION_UNKNOWN", "关闭会话读取 handle 失败：" + describe(error) + "；保留映射，请检查同 ID 会话后重试，未补投正文", id) }
    if (!read.ok) return read
    let subagents
    try { subagents = get("subagents") } catch (error) { return failure("TW_SUB_FOLLOWUP_UNAVAILABLE", describe(error), id) }
    const followup = coldResumePrompt(read, input.prompt, input.promptFull?.trim() ? input.promptFull : input.prompt)
    const sent = await followupChild({ subagents, parent: input.exec?.agent, signal: input.exec?.signal }, id, followup.text)
    return sent.ok ? { ...sent, refollowed: true, resume: followup.resume, source: "reconciled" } : sent
  }
  const target = input.target
  if (!target || target.tier !== undefined || typeof target.provider !== "string" || !target.provider.trim() || typeof target.model !== "string" || !target.model.trim() || (target.effort !== undefined && (typeof target.effort !== "string" || !target.effort.trim()))) {
    return failure("TW_SUB_TARGET_INVALID", "需要精确 target：{provider, model, effort?}；缺档时请修复插件 tiers 配置", id)
  }
  let subagents, llm, resolved, maxDepth
  try {
    subagents = get("subagents"); llm = get("llm")
    if (typeof llm?.resolveCallConfig !== "function") return failure("TW_SUB_LLM_UNAVAILABLE", "llm.resolveCallConfig 不可用", id)
    resolved = await llm.resolveCallConfig({ provider: target.provider, model: target.model, ...(target.effort ? { reasoningEffort: target.effort } : {}) })
    if (!resolved || resolved.provider !== target.provider || resolved.model !== target.model || (target.effort !== undefined && resolved.reasoningEffort !== target.effort)) {
      return failure("TW_SUB_EXPLICIT_SELECTION_MISMATCH", "宿主未确认精确模型或显式 effort；未创建成员，请核对 tiers", id)
    }
    if (typeof subagents?.startContinuable !== "function" || typeof subagents?.resolveMaxDepth !== "function") return failure("TW_SUB_SUBAGENTS_UNAVAILABLE", "subagents.startContinuable/resolveMaxDepth 不可用", id)
    const provider = subagents.getProvider?.(deps.subagentProviderName ?? SUBAGENT_PROVIDER)
    if (!provider) return failure("TW_SUB_PROVIDER_MISSING", "spawn 子代理 provider 未注册", id)
    if (typeof provider.prepareContinuable !== "function") return failure("TW_SUB_PROVIDER_NOT_CONTINUABLE", "spawn provider 不支持可续聊成员", id)
    maxDepth = subagents.resolveMaxDepth()
  } catch (error) { return failure("TW_SUB_MODEL_INVALID", "创建前验证失败（未创建子会话）：" + describe(error), id) }
  const agentOptions = { provider: resolved.provider, model: resolved.model, ...(resolved.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}) }
  let start
  try {
    start = await subagents.startContinuable({ provider: deps.subagentProviderName ?? SUBAGENT_PROVIDER, label: input.description, childId: id,
      request: { parent: input.exec.agent, prompt: [{ type: "text", text: input.promptFull?.trim() ? input.promptFull : input.prompt }], agentOptions, maxDepth },
      signal: input.exec.signal ?? new AbortController().signal })
  } catch (error) { return failure("TW_SUB_START_FAILED", "成员创建失败：" + describe(error) + "；保留映射，先核对同 ID 会话后重试", id) }
  const childId = start?.childId ?? id
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
