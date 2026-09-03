// tw-tool-subagent.js — 定向选模委派工具（方案 docs/dsh-directed-delegation-plan.md，§9 第 3 条命名裁决）
// 按档位（tiers 快照）或精确 provider/model/effort 创建后台可续聊子代理；复用 DSH 原生
// startContinuable / followup，不重写子代理引擎。确定性复用对账（sessionId 在场）走判定链四态
//（用户终裁②③，docs/dispatch-rework-investigation.md §二·A：活→等待 / 冷归属一致→冷唤醒+判收单
// 定增量或全量 / 冷异主→接管冲突 / 无记录→同 ID 重建投全量）。§10.3 风险落点：
//   R1 effort 冷恢复——agentOptions 只承载 provider/model；effort 由 setup 贡献从持久化
//      request/header.config.reasoningEffort 回读重建（见 inject.js recallFromHeader）；
//   R2 单一来源——selection 与 agentOptions 由同一份 resolveCallConfig 结果派生，禁止双源解析；
//   R3 provider 钉死 spawn——创建前校验 getProvider("spawn") 在场且具备 prepareContinuable 能力。
import { randomUUID } from "node:crypto"

export const TOOL_NAME = "tw-tool-subagent"
export const SUBAGENT_PROVIDER = "spawn"
export const TIER_NAMES = Object.freeze(["junior", "senior", "expert"])

// §3.7 档位价值主张：工具说明 / systemPrompt / @ 候选三处同源（badge.js 内联副本由测试对齐）。
export const TIER_VALUE_PROPS = Object.freeze({
  junior:
    "足以负担大部分基础工作；速度优势显著、单位成本最低——批量探索、信息收集、格式化整理、初稿类工作的默认选择。",
  senior:
    "平衡档：推理能力与解题率不错，综合能力对比 expert 略有不足，但价格优势明显、性价比高——大多数常规开发任务的默认选择。",
  expert:
    "最强推理能力、高解题率、低错误率；价格与执行耗时都最贵——只在高难度设计、疑难定位、关键技术裁决时使用。",
})

export function tierValuePropsText() {
  return TIER_NAMES.map((tier) => "- " + tier + "：" + TIER_VALUE_PROPS[tier]).join("\n")
}

// §3.6 决策表（工具说明与 systemPrompt section 共用文本；§3.7 三工具分工表随 tw-dispatch 上线更新：
// 波次派发归 tw-dispatch，本工具退守非工作流委派，tw 主管任务簿记）。
export function decisionTableText() {
  return [
    "team-work 三工具分工（情境判据是「有无进行中的任务波次」，不依赖模型记忆）：",
    "- 正在推进 team-work 任务（派波次成员/推进一步） → tw-dispatch（单次调用完成派发+登记+标签，非派发卡原样透传）",
    "- 非工作流委派：只读子派单、用户 @档位、并行调查、独立审查等 → tw-tool-subagent",
    "- 任务簿记：决定、门禁查询、交付、评审、补登记 → tw",
    "- 用户或任务指定 tier、provider、model 或 effort → tw-tool-subagent",
    "- Agent 按任务复杂度、时效与成本主动选档（无需任何人显式指定） → tw-tool-subagent",
    "- 不选模型、接受继承平台默认选择 → 原生 subagent",
    "- 需要原生工具的前台或一次性模式 → 原生 subagent",
    "- 需要继承父会话上下文 → 原生 subagent_fork",
    "- 继续已存在的子会话 → send_message",
  ].join("\n")
}

export function toolDescriptionText() {
  return [
    "定向选模委派：按档位（junior/senior/expert）或精确 provider/model/effort 创建后台、可续聊子代理；成功返回 sessionId，可用 send_message 续聊。不处于 team-work 工作流时同样可用（信息收集、并行调查、独立审查等普通委派）。引导：不确定优先 senior，明确高难度才升 expert，大量低风险基础工作下沉 junior。",
    "档位价值主张：",
    tierValuePropsText(),
    decisionTableText(),
  ].join("\n")
}

// systemPrompt 决策表 section（§3.6/§3.7：与工具说明同源；order 落在工具引导区 100–199）。
export function systemPromptSection() {
  return {
    name: "team-work-dsh:tw-tool-subagent",
    order: 150,
    text: ["team-work 定向委派工具选择指引（tw-tool-subagent）：", "", tierValuePropsText(), "", decisionTableText()].join("\n"),
  }
}

function failCard(code, message) {
  return { ok: false, code, message }
}

// ── 会话判定原语（返工终版 docs/dispatch-rework-investigation.md §二·A；两处消费：本文件创建核心
// 对账 + tw-dispatch 判定链）──────────────────────────────────────────────────────
// 判定标准与宿主判重一致（startContinuable：活注册表+活会话，显式 childId 才加查持久快照）。
// 「已收单」（有原上下文）的可靠信号 = 子会话 own-suffix 中存在 inserted 非空的 agent/inbox/spliced
// 事件——判定只服务冷支（冷唤醒时选增量/全量变体）；活会话统一等待不读事件流（用户终裁②③：
// 活=任务进行中，重入判活→等待永不重投；「活+未收单」经宿主 submitMaterialized 失败即完全回滚不存在）。
// own-suffix = events.slice(header.seedLength ?? 0)（seed 是 fork 继承的父历史，不是本会话的工作）。
// 保守方向钉死：形态不可判定一律按已收单——误判已收单的代价是投增量（成员可自辨），误判未收单
// 的代价是向无上下文会话投不可执行的增量；宁可多带上下文。
export function ownSuffixOf(session) {
  const events = session?.events
  if (!Array.isArray(events)) return null
  const seed = Number(session?.header?.seedLength ?? 0)
  return events.slice(Number.isSafeInteger(seed) && seed > 0 ? seed : 0)
}

// 活会话收单判定：own-suffix 有 inserted 非空的 inbox splice 即收过派单消息（descriptor-only = 未收单）。
export function sessionReceived(session) {
  const own = ownSuffixOf(session)
  if (own === null) return true
  return own.some((e) => e?.type === "agent/inbox/spliced" && Array.isArray(e?.data?.inserted) && e.data.inserted.length > 0)
}

// 冷持久判定（sessions.get 无命中时）：listSnapshots 匹配 id——轻量，仅 header+revision；
// 未物化的崩溃壳（created-but-never-appended）不出现在列表，宿主判重同样不认它 → 同 ID 重建合法。
// 返回：none（无冷记录，undetermined=true 表示持久服务不可用——按 none 走重建，宿主 DUPLICATE_CHILD
// 兜底拒绝并报错可恢复）；foreign（header.parentSession 存在且 ≠ 调用方会话 → 接管冲突，不做
// followup/重建——冷唤醒鉴权与显式 childId 判重两路必拒）；ours（归属一致 → followup 冷唤醒）。
export async function coldSessionStatus({ persistence, parentSessionId }, childId) {
  if (!persistence || typeof persistence.listSnapshots !== "function") return { status: "none", undetermined: true }
  let snapshots
  try {
    snapshots = await persistence.listSnapshots()
  } catch {
    return { status: "none", undetermined: true }
  }
  const hit = (Array.isArray(snapshots) ? snapshots : []).find((s) => s?.header?.id === childId)
  if (!hit) return { status: "none" }
  const owner = hit.header.parentSession
  if (owner !== undefined && owner !== null && owner !== parentSessionId) return { status: "foreign", header: hit.header }
  return { status: "ours", header: hit.header }
}

// 冷会话收单判定（F-1 防双投：决定 followup 消息是补发正文还是轻量续行提示）：
// readRaw 按需读回原始制品（detached 物理读，不触碰 coordinator/prepare 状态）；后端不支持
// per-session 制品（supportsRawArtifacts=false，如 SQLite）或读取失败降级 inspect（全后端通用）。
// 两者都不可得 → 保守按已收单（轻提示可人工恢复，正文重投不可逆）。
export async function coldSessionReceived(persistence, childId) {
  try {
    if (persistence && typeof persistence.readRaw === "function" && persistence.supportsRawArtifacts !== false) {
      const raw = await persistence.readRaw(childId)
      if (!raw) return true
      // 制品第一行是 header，其后每行一个事件；own-suffix 从事件 seedLength 起（行号 = seedLength+1）
      const lines = String(raw.content ?? "").split("\n").filter((l) => l.trim() !== "")
      const seed = Number(raw.meta?.seedLength ?? 0)
      const start = Number.isSafeInteger(seed) && seed > 0 ? seed + 1 : 1
      for (const line of lines.slice(start)) {
        let event
        try {
          event = JSON.parse(line)
        } catch {
          return true // 撕裂/不可解析行：存在未知事件，保守按已收单
        }
        if (event?.type === "agent/inbox/spliced" && Array.isArray(event?.data?.inserted) && event.data.inserted.length > 0) return true
      }
      return false
    }
  } catch {
    // 降级 inspect
  }
  if (persistence && typeof persistence.inspect === "function") {
    try {
      const looked = await persistence.inspect(childId)
      return sessionReceived({ events: looked?.events, header: looked?.meta })
    } catch {
      return true
    }
  }
  return true
}

function describe(error) {
  return String(error?.message ?? error)
}

// followup 投递原语（宿主 subagents.followup 的语义化封装；创建核心与 tw-dispatch 续派在场处置共用）：
// 对活/冷会话均入队且接受即落盘（宿主契约）；冷会话走宿主 coldResume（inspect 读回 → 鉴权须精确
// 直接父 → 重建 Agent → 消息入队）。错误按宿主错误码转译：UNAUTHORIZED=接管冲突（父会话不匹配）、
// NOT_RESUMABLE=持久状态不可续投。返回 { ok, messageId } 或 { ok:false, code, message }。
export async function followupChild({ subagents, parent, signal }, childId, text) {
  if (!subagents || typeof subagents.followup !== "function") {
    return { ok: false, code: "TW_SUB_FOLLOWUP_UNAVAILABLE", message: "subagents 服务缺 followup；无法向既有会话（" + childId + "）投递消息。请升级宿主后重试" }
  }
  let messageId
  try {
    messageId = await subagents.followup(parent, childId, [{ type: "text", text }], { source: { kind: "user" }, signal: signal ?? new AbortController().signal })
  } catch (error) {
    const code = error?.code
    if (code === "UNAUTHORIZED") {
      return {
        ok: false,
        code: "TW_SUB_TAKEOVER_CONFLICT",
        message: "会话（" + childId + "）归属其他父会话（接管冲突）：本工具不做接管。处置：由原 Lead 会话继续（send_message），或 tw retire 作废该波后重新派发",
      }
    }
    if (code === "NOT_RESUMABLE") {
      return {
        ok: false,
        code: "TW_SUB_NOT_RESUMABLE",
        message: "会话（" + childId + "）无法续投（NOT_RESUMABLE：持久状态不含可续聊描述符）。处置：tw retire 作废该波后重新派发（勿重试同 id）",
      }
    }
    return { ok: false, code: "TW_SUB_FOLLOWUP_FAILED", message: "会话（" + childId + "）续投失败：" + describe(error) + "。原样重试安全（判定链幂等收敛）" }
  }
  return { ok: true, messageId }
}

// 纯函数：校验并标准化 target。成功返回 { ok:true, tier } 或 { ok:true, provider, model, effort? }；
// 失败返回 { ok:false, code, message }（两种形态互斥；显式选择必须 provider+model 齐全）。
export function normalizeTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    return { ok: false, code: "TW_SUB_TARGET_INVALID", message: "target 必须是对象：{ tier } 或 { provider, model, effort? } 二选一" }
  }
  const hasTier = target.tier !== undefined
  const hasExplicit = target.provider !== undefined || target.model !== undefined || target.effort !== undefined
  if (hasTier && hasExplicit) {
    return { ok: false, code: "TW_SUB_TARGET_INVALID", message: "target.tier 与 provider/model/effort 互斥，只能二选一" }
  }
  if (hasTier) {
    if (!TIER_NAMES.includes(target.tier)) {
      return { ok: false, code: "TW_SUB_TARGET_INVALID", message: "target.tier 必须是 " + TIER_NAMES.join("/") + " 之一" }
    }
    return { ok: true, tier: target.tier }
  }
  if (target.provider === undefined && target.model === undefined) {
    return { ok: false, code: "TW_SUB_TARGET_INVALID", message: "target 需要 tier，或同时提供 provider 与 model" }
  }
  if (typeof target.provider !== "string" || !target.provider.trim()) {
    return { ok: false, code: "TW_SUB_TARGET_INVALID", message: "显式选择必须提供非空 provider（与 model 同时）" }
  }
  if (typeof target.model !== "string" || !target.model.trim()) {
    return { ok: false, code: "TW_SUB_TARGET_INVALID", message: "显式选择必须提供非空 model（与 provider 同时）" }
  }
  if (target.effort !== undefined && (typeof target.effort !== "string" || !target.effort.trim())) {
    return { ok: false, code: "TW_SUB_TARGET_INVALID", message: "target.effort 如填写必须是非空字符串" }
  }
  return {
    ok: true,
    provider: target.provider,
    model: target.model,
    ...(target.effort !== undefined ? { effort: target.effort } : {}),
  }
}

// 纯函数：从 tiers 快照解析档位选择（候选数组稳定取第一项，单对象兼容；family 不参与选择）。
// 缺档或字段不完整返回 null——unresolved 显式报错，不猜测环境默认（脱敏规则）。
export function resolveTierSelection(tiersSnapshot, tierName) {
  const tiers =
    tiersSnapshot && typeof tiersSnapshot === "object" && !Array.isArray(tiersSnapshot)
      ? tiersSnapshot.tiers ?? tiersSnapshot
      : null
  const candidate = tiers ? tiers[tierName] : null
  if (!candidate) return null
  const first = Array.isArray(candidate) ? candidate[0] : candidate
  if (!first || typeof first !== "object" || Array.isArray(first)) return null
  if (typeof first.provider !== "string" || !first.provider || typeof first.model !== "string" || !first.model) return null
  return {
    provider: first.provider,
    model: first.model,
    ...(typeof first.effort === "string" && first.effort ? { effort: first.effort } : {}),
  }
}

function readTiersSnapshot(tiersSource) {
  try {
    const snapshot = typeof tiersSource === "function" ? tiersSource() : null
    return snapshot && typeof snapshot === "object" ? snapshot : null
  } catch {
    return null
  }
}

// 创建核心（tw-dispatch 方案 §3.1 抽取）：验证 → startContinuable → flush 确认。tw-tool-subagent 与
// tw-dispatch 共用同一实现与同一 directSelections 表（R2 单一来源：selection 与 agentOptions 同源派生）。
// input.description/prompt/target 为原始调用参数（target 在此 normalize）；exec 携带调用方 Agent 与 signal。
// 返回与工具 execute 相同的卡片：{ ok:false, code, message } 或
// { ok:true, sessionId, messageId?, provider, model, effort?, source }。
export async function createDirectedSubagent(ctx, deps = {}, input = {}) {
  const tiersSource = deps.tiersSource ?? (() => null)
  const directSelections = deps.directSelections ?? new Map()
  const providerName = deps.subagentProviderName ?? SUBAGENT_PROVIDER
  // 定向委派必须依赖可用的同步注入通道；否则首请求无法保证使用已验证的选择。
  const isModelInjectionReady = deps.isModelInjectionReady ?? (() => true)
  const getService =
    deps.getService ?? ((name) => {
      // llm/sessions/sessionPersistence 是工具执行期探测的服务，不提升为插件装载硬依赖；
      // 真实 Cordis Context 必须经 get 查询，避免未声明属性访问绕过结构化失败卡。
      if (ctx && typeof ctx.get === "function") return ctx.get(name)
      return ctx && ctx[name]
    })

  const description = typeof input?.description === "string" ? input.description.trim() : ""
  if (!description) return failCard("TW_SUB_DESCRIPTION_REQUIRED", "description 必须是非空字符串（子代理标签）")
  const prompt = typeof input?.prompt === "string" ? input.prompt : ""
  if (!prompt.trim()) return failCard("TW_SUB_PROMPT_REQUIRED", "prompt 必须是非空字符串（完整任务指令）")
  const exec = input?.exec

  // 宿主侧依赖运行时探测（§3.2：缺失时工具明确报错，不阻塞插件其他能力）。
  // 注意 llm 探测延迟到创建路径：确定性复用对账（followup/等待）不验证模型选择——会话自有配置。
  const subagents = getService("subagents")
  if (!subagents || typeof subagents.startContinuable !== "function") {
    return failCard("TW_SUB_SUBAGENTS_UNAVAILABLE", "subagents 服务不可用（缺 startContinuable）；无法创建可续聊子代理")
  }
  const sessions = getService("sessions")
  if (!sessions || typeof sessions.get !== "function" || typeof sessions.flush !== "function") {
    return failCard("TW_SUB_SESSIONS_UNAVAILABLE", "sessions 服务不可用（缺 get/flush）；无法确认启动持久化")
  }
  const sessionPersistence = getService("sessionPersistence")

  const parent = exec?.agent
  if (!parent) {
    return failCard("TW_SUB_PARENT_MISSING", "缺少调用方 Agent（exec.agent 未定义）；请在会话工具调用上下文中使用")
  }

  // 确定性复用对账（判定链四态，用户终裁②③，docs/dispatch-rework-investigation.md §二·A；判定原语
  // 与宿主判重标准一致）。「先登记后创建」的任何崩溃时点重入都收敛到同一会话，不产生第二个成员：
  //   sessions.get 有（活）→ 归属检查（header.parentSession）：异主 → 接管冲突卡；归属一致 → 等待
  //     （活 = 任务进行中，重入判活恒等待、永不重投——不读事件流：「活+未收单」经宿主
  //     submitMaterialized 失败即完全回滚不存在）；
  //   sessions.get 无 → sessionPersistence.listSnapshots 匹配 id：
  //     foreign（header.parentSession ≠ 调用方会话）→ 接管冲突卡（不做 followup/重建——冷唤醒鉴权与
  //       显式 childId 判重两路必被双拒；处置 = 原会话继续或 tw retire）；
  //     ours（归属一致）→ followup 冷唤醒 + 缺什么补什么（readRaw 判收单定变体：曾收单=有上一轮
  //       上下文→投本轮增量 / 从未收单→投全量——冷会话不在执行，本轮派单必未投过）；
  //     none（含未物化崩溃壳）→ 同 ID 重建（投全量变体），落到下方正常创建路径（宿主显式 childId 判重兜底）。
  const reuseId = typeof input?.sessionId === "string" && input.sessionId.trim() ? input.sessionId.trim() : null
  const followupSignal = exec?.signal ?? new AbortController().signal
  const deliverFollowup = async (text, resume) => {
    const sent = await followupChild({ subagents, parent, signal: followupSignal }, reuseId, text)
    if (!sent.ok) return sent
    return { ok: true, sessionId: reuseId, messageId: sent.messageId, refollowed: true, resume, source: "reconciled" }
  }
  // 全量变体缺省回退（与 tw-dispatch handleContinuation 同款降级）：promptFull 仅供续派条目（新会话/
  // 无上下文冷会话投递用）；通用委派缺省时一切投递用 prompt。
  const promptFullOf = () => (typeof input?.promptFull === "string" && input.promptFull.trim() ? input.promptFull : prompt)
  if (reuseId) {
    // 判定链四态（用户终裁②③，docs/dispatch-rework-investigation.md §二·A）：活（归属一致）→等待 /
    // 冷归属一致→唤醒+缺什么补什么 / 异主（活或冷）→接管冲突卡 / 无记录→同 ID 重建。
    const live = sessions.get(reuseId)
    if (live !== undefined && live !== null) {
      // 归属检查（与冷支同款保守）：异主活会话不是「本 Lead 的任务进行中」——出接管冲突卡提示
      // 处置，不做等待/投递/重建（冷唤醒鉴权与同 id 重建判重两路必被宿主拒绝）。
      const owner = live?.header?.parentSession
      if (owner !== undefined && owner !== null && owner !== parent?.id) {
        return failCard(
          "TW_SUB_TAKEOVER_CONFLICT",
          "会话（" + reuseId + "）在场但归属其他父会话（parentSession=" + String(owner) + "≠ 当前 " + String(parent?.id) +
            "，接管冲突）：本工具不做接管。处置：由原 Lead 会话继续，或 tw retire 作废该波后重新派发"
        )
      }
      // 活会话统一等待（用户终裁②）：活 = 任务进行中（正在处理本轮，或等子代——子代停止时宿主注入
      // 父级通知、逐级传导触发 Lead），通知链保证不僵死；重入判活→等待、永不重投（防成员重复执行
      // 整轮工作）。不读事件流、不投递；「活+未收单」形态经宿主 submitMaterialized 失败即完全回滚
      //（continuation catch→dispose）不存在，无需分辨收单状态。
      return { ok: true, sessionId: reuseId, reused: true, source: "reconciled" }
    }
    const cold = await coldSessionStatus({ persistence: sessionPersistence, parentSessionId: parent?.id }, reuseId)
    if (cold.status === "foreign") {
      return failCard(
        "TW_SUB_TAKEOVER_CONFLICT",
        "会话（" + reuseId + "）是冷持久会话且归属其他父会话（parentSession=" + String(cold.header.parentSession) +
          "≠ 当前 " + String(parent?.id) + "，接管冲突）：本工具不做接管（冷唤醒鉴权与同 ID 重建判重两路必被宿主拒绝）。处置：由原 Lead 会话继续，或 tw retire 作废该波后重新派发"
      )
    }
    if (cold.status === "ours") {
      // 冷归属一致 → 冷唤醒 + 缺什么补什么：冷会话不在执行（判定与投递互斥，本轮派单必未投过——
      // 「曾收单」只代表有上一轮上下文）。判收单定变体：有上下文投增量（prompt）、无上下文投全量
      //（promptFull，缺省回退 prompt——通用委派无变体概念）。
      const received = await coldSessionReceived(sessionPersistence, reuseId)
      return received ? deliverFollowup(prompt, "incremental") : deliverFollowup(promptFullOf(), "full")
    }
    // none（含未物化崩溃壳）：同 ID 重建 → 落到下方正常创建路径（重建投全量变体：新会话无原上下文）
  }

  // ── 创建路径（以下验证链只服务「同 ID 重建 / 全新创建」；followup/等待路径已在上面对账返回）──
  const target = normalizeTarget(input?.target)
  if (!target.ok) return failCard(target.code, target.message)
  const llm = getService("llm")
  if (!llm || typeof llm.resolveCallConfig !== "function") {
    return failCard("TW_SUB_LLM_UNAVAILABLE", "llm 服务不可用（缺 resolveCallConfig）；无法在创建前验证模型选择")
  }

  // 解析选择：档位 → tiers 快照第一候选（unresolved 显式报错）；显式 → 原样。
  let proposed
  let source
  if (target.tier) {
    const tierSelection = resolveTierSelection(readTiersSnapshot(tiersSource), target.tier)
    if (!tierSelection) {
      return failCard(
        "TW_SUB_TIER_UNRESOLVED",
        "档位 " + target.tier + " 未配置或字段不完整（DSH 全局设置 team-work-dsh.tiers）；请补全配置后重试，或改用 provider/model 显式指定"
      )
    }
    proposed = tierSelection
    source = "tier"
  } else {
    proposed = { provider: target.provider, model: target.model, ...(target.effort ? { effort: target.effort } : {}) }
    source = "explicit"
  }

  // 创建前验证（§4 步骤 1）：不存在的 provider/model 与无效 effort 在此失败，不留子会话。
  let resolvedCall
  try {
    resolvedCall = await llm.resolveCallConfig({
      provider: proposed.provider,
      model: proposed.model,
      ...(proposed.effort ? { reasoningEffort: proposed.effort } : {}),
    })
  } catch (error) {
    return failCard("TW_SUB_MODEL_INVALID", "模型选择验证失败（未创建子会话）：" + describe(error))
  }
  if (!resolvedCall || typeof resolvedCall !== "object" || !resolvedCall.provider || !resolvedCall.model) {
    return failCard("TW_SUB_MODEL_INVALID", "resolveCallConfig 未返回有效 provider/model（未创建子会话）")
  }
  // 显式选择是调用方的精确意图，验证器只能确认可用性，不能静默替换 provider/model/effort。
  // 档位选择则以全局候选经宿主解析后的实际配置为准。
  if (
    source === "explicit" &&
    (resolvedCall.provider !== proposed.provider ||
      resolvedCall.model !== proposed.model ||
      resolvedCall.reasoningEffort !== proposed.effort)
  ) {
    return failCard(
      "TW_SUB_EXPLICIT_SELECTION_MISMATCH",
      "resolveCallConfig 改写了显式模型选择（请求 " +
        proposed.provider +
        "/" +
        proposed.model +
        "，effort=" +
        (proposed.effort ?? "未指定") +
        "）；未创建子会话。请使用宿主接受的精确 provider/model/effort"
    )
  }

  // R2 单一来源：selection 与 agentOptions 都从同一份 resolvedCall 派生（禁双源解析）。
  const selection = {
    provider: resolvedCall.provider,
    model: resolvedCall.model,
    ...(resolvedCall.reasoningEffort ? { reasoningEffort: resolvedCall.reasoningEffort } : {}),
  }
  const agentOptions = { provider: resolvedCall.provider, model: resolvedCall.model }

  // R3 provider 钉死 + 能力校验（仿 dsh-tool-subagent：缺 prepareContinuable 创建前失败）。
  const provider =
    typeof subagents.getProvider === "function" ? subagents.getProvider(providerName) : undefined
  if (!provider) {
    return failCard(
      "TW_SUB_PROVIDER_MISSING",
      "子代理 provider " + providerName + " 未注册；请确认宿主已装载对应 Bundle 后重试"
    )
  }
  if (typeof provider.prepareContinuable !== "function") {
    return failCard(
      "TW_SUB_PROVIDER_NOT_CONTINUABLE",
      "子代理 provider " + providerName + " 不具备可续聊创建能力（缺 prepareContinuable）；请换用支持 continuable 的宿主配置"
    )
  }
  // 确认只能发生在 initial prompt 已入队后；先确认回收能力，才能保证确认失败后不留运行子会话供重试重复委派。
  if (typeof subagents.drainContinuableChildren !== "function") {
    return failCard(
      "TW_SUB_CLEANUP_UNAVAILABLE",
      "subagents 服务缺 drainContinuableChildren；无法保证启动确认失败后回收子会话，未创建子会话。请升级或修复宿主后重试"
    )
  }

  if (!isModelInjectionReady()) {
    return failCard(
      "TW_SUB_MODEL_INJECTION_UNAVAILABLE",
      "模型选择注入尚未就绪（安装器或 continuable setup 不可用）；未创建子会话。请修复宿主注入依赖后重试"
    )
  }

  // §3.4 sessionId：插件生成 UUID v4，不是模型参数（确定性复用时由派单 key 推导）；重复/冲突由 startContinuable 拒绝并清理。
  // 同 ID 重建投全量变体（promptFull 缺省回退 prompt）：重建目标是无原上下文的新会话，续派条目的
  // 增量正文不可执行（§9.3）；通用委派与正常波（prompt 即全量）行为不变。
  const sessionId = reuseId ?? randomUUID()
  directSelections.set(sessionId, selection)
  let start
  try {
    start = await subagents.startContinuable({
      provider: providerName,
      label: description,
      childId: sessionId,
      request: {
        prompt: [{ type: "text", text: promptFullOf() }],
        parent,
        agentOptions,
      },
      signal: exec?.signal ?? new AbortController().signal,
    })
  } catch (error) {
    directSelections.delete(sessionId)
    return failCard("TW_SUB_START_FAILED", "子会话创建失败（已清理待注入选择，不复用已有会话）：" + describe(error))
  }
  const childId = start?.childId ?? sessionId
  const clearDirectSelection = () => {
    directSelections.delete(sessionId)
    if (childId !== sessionId) directSelections.delete(childId)
  }
  // startContinuable 成功意味着初始任务已被子会话接收；之后任一确认失败均必须先停止并释放该子会话，
  // 只有回收完成才提示调用方可以重试，避免同一委派被重复执行。
  const rejectUnconfirmedStart = async (code, message) => {
    clearDirectSelection()
    try {
      await subagents.drainContinuableChildren(parent, [childId])
      return failCard(code, message + "；已停止并释放未确认子会话，可在修复原因后重试")
    } catch (error) {
      return failCard(
        "TW_SUB_CLEANUP_FAILED",
        message + "；未确认子会话（" + childId + "）回收失败：" + describe(error) + "。请勿重试，以免重复委派；请先人工停止该子会话"
      )
    }
  }

  // §4 步骤 5：持久化后必须实测首个 request/header 与已验证选择完全一致。
  // startContinuable 之后的所有确认读取都可能抛错；它们与 flush/header 不匹配一样必须统一回收。
  try {
    const persistence = getService("sessionPersistence")
    if (!persistence) {
      return rejectUnconfirmedStart(
        "TW_SUB_PERSISTENCE_UNAVAILABLE",
        "子会话已创建（" + childId + "）但 sessionPersistence 服务不可用，启动未确认持久化；请检查宿主持久化配置"
      )
    }
    const childSession = sessions.get(childId)
    if (!childSession) {
      return rejectUnconfirmedStart(
        "TW_SUB_SESSION_MISSING",
        "子会话已创建（" + childId + "）但会话存储读取不到，启动未确认持久化；请检查 sessions 服务状态"
      )
    }
    let flushed = false
    try {
      flushed = await sessions.flush(childSession)
    } catch (error) {
      return rejectUnconfirmedStart("TW_SUB_FLUSH_FAILED", "子会话持久化确认失败（" + childId + "）：" + describe(error))
    }
    if (flushed !== true) {
      return rejectUnconfirmedStart(
        "TW_SUB_NOT_PERSISTED",
        "子会话（" + childId + "）启动未获得持久化监听器确认（flush=false）；请检查持久化后端后重试"
      )
    }
    // 用户裁决（§9 增量）：不做首请求 header 运行期对账——模型/effort 的实际生效由
    // 客户端徽标展示承载（人工可见核验）。启动确认 = 持久化在场 + flush 参与。
  } catch (error) {
    return rejectUnconfirmedStart(
      "TW_SUB_SESSION_READ_FAILED",
      "子会话启动确认读取失败（" + childId + "）：" + describe(error) + "；请检查 sessions 服务状态"
    )
  }
  clearDirectSelection()

  return {
    ok: true,
    sessionId: childId,
    messageId: start?.messageId,
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort ? { effort: selection.reasoningEffort } : {}),
    source,
  }
}


// 工具定义工厂。参数面不变（通用委派：tier 或精确模型）；创建语义全部委托 createDirectedSubagent
// （tw-dispatch 复用同一核心）。directSelections 与 inject.js 的 setup 贡献共享（sessionId → 已验证选择，
// take-once）；tiersSource 为 settings 快照读取 thunk（installPluginSettings 返回值）。
export function twToolSubagentDefinition(ctx, deps = {}) {
  const tiersSource = deps.tiersSource ?? (() => null)
  const directSelections = deps.directSelections ?? new Map()
  const providerName = deps.subagentProviderName ?? SUBAGENT_PROVIDER
  // 定向委派必须依赖可用的同步注入通道；否则首请求无法保证使用已验证的选择。
  const isModelInjectionReady = deps.isModelInjectionReady ?? (() => true)

  return {
    name: TOOL_NAME,
    timeoutMs: 60000,
    description: toolDescriptionText(),
    isConcurrencySafe: () => true,
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "简短名称（成为子代理的创建标签，供人识别）" },
        prompt: { type: "string", description: "完整任务指令（子代理收到的全部输入；独立会话不继承本会话上下文）" },
        target: {
          type: "object",
          description: "模型选择，二选一：{ tier: junior|senior|expert }（档位来自全局配置）或 { provider, model, effort? }（显式精确指定）",
          properties: {
            tier: { type: "string", enum: ["junior", "senior", "expert"], description: "按档位选模" },
            provider: { type: "string", description: "精确 provider 标识（与 model 同时提供）" },
            model: { type: "string", description: "精确 model 标识（与 provider 同时提供）" },
            effort: { type: "string", description: "可选推理等级" },
          },
        },
      },
      required: ["description", "prompt", "target"],
    },
    async execute(params, exec) {
      // 参数提取后全部交给共享创建核心（§3.1）：验证、创建与确认语义两工具同源。
      return createDirectedSubagent(
        ctx,
        {
          tiersSource,
          directSelections,
          subagentProviderName: providerName,
          isModelInjectionReady,
          ...(deps.getService ? { getService: deps.getService } : {}),
        },
        { description: params?.description, prompt: params?.prompt, target: params?.target, exec },
      )
    },
    output: {
      schema: { type: "object" },
      render: (_params, card) => [{ type: "text", text: JSON.stringify(card, null, 2) }],
    },
  }
}
