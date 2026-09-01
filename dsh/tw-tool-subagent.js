// tw-tool-subagent.js — 定向选模委派工具（方案 docs/dsh-directed-delegation-plan.md，§9 第 3 条命名裁决）
// 按档位（tiers 快照）或精确 provider/model/effort 创建后台可续聊子代理；复用 DSH 原生
// startContinuable，不重写子代理引擎。§10.3 风险落点：
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

// §3.6 决策表（工具说明与 systemPrompt section 共用文本，现状陈述；二阶段切链已于 2026-09-06 完成）。
export function decisionTableText() {
  return [
    "tw-tool-subagent 与原生 subagent 的分工（以是否显式选择模型为界——由用户/任务指定，或由 Agent 按档位价值主张主动选定）：",
    "- 用户或任务指定 tier、provider、model 或 effort → tw-tool-subagent",
    "- Agent 按任务复杂度、时效与成本主动选档（无需任何人显式指定） → tw-tool-subagent",
    "- team-work 首次派发且 dispatch-plan 已给出 modelHint → tw-tool-subagent（team-work 首派经本工具 target 直取 dispatch-plan 的 modelHint）",
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

function describe(error) {
  return String(error?.message ?? error)
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

// 工具定义工厂。directSelections 与 inject.js 的 setup 贡献共享（sessionId → 已验证选择，
// take-once）；tiersSource 为 settings 快照读取 thunk（installPluginSettings 返回值）。
export function twToolSubagentDefinition(ctx, deps = {}) {
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
      const description = typeof params?.description === "string" ? params.description.trim() : ""
      if (!description) return failCard("TW_SUB_DESCRIPTION_REQUIRED", "description 必须是非空字符串（子代理标签）")
      const prompt = typeof params?.prompt === "string" ? params.prompt : ""
      if (!prompt.trim()) return failCard("TW_SUB_PROMPT_REQUIRED", "prompt 必须是非空字符串（完整任务指令）")
      const target = normalizeTarget(params?.target)
      if (!target.ok) return failCard(target.code, target.message)

      // 宿主侧依赖运行时探测（§3.2：缺失时工具明确报错，不阻塞插件其他能力）。
      const llm = getService("llm")
      if (!llm || typeof llm.resolveCallConfig !== "function") {
        return failCard("TW_SUB_LLM_UNAVAILABLE", "llm 服务不可用（缺 resolveCallConfig）；无法在创建前验证模型选择")
      }
      const subagents = getService("subagents")
      if (!subagents || typeof subagents.startContinuable !== "function") {
        return failCard("TW_SUB_SUBAGENTS_UNAVAILABLE", "subagents 服务不可用（缺 startContinuable）；无法创建可续聊子代理")
      }
      const sessions = getService("sessions")
      if (!sessions || typeof sessions.get !== "function" || typeof sessions.flush !== "function") {
        return failCard("TW_SUB_SESSIONS_UNAVAILABLE", "sessions 服务不可用（缺 get/flush）；无法确认启动持久化")
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

      const parent = exec?.agent
      if (!parent) {
        return failCard("TW_SUB_PARENT_MISSING", "缺少调用方 Agent（exec.agent 未定义）；请在会话工具调用上下文中使用")
      }

      // §3.4 sessionId：插件生成 UUID v4，不是模型参数；重复/冲突由 startContinuable 拒绝并清理。
      const sessionId = randomUUID()
      directSelections.set(sessionId, selection)
      let start
      try {
        start = await subagents.startContinuable({
          provider: providerName,
          label: description,
          childId: sessionId,
          request: {
            prompt: [{ type: "text", text: prompt }],
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
    },
    output: {
      schema: { type: "object" },
      render: (_params, card) => [{ type: "text", text: JSON.stringify(card, null, 2) }],
    },
  }
}
