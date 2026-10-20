import z from "@deepseek-ai/schemastery"

export const SETTINGS_NS = "team-work-dsh"
export const TIER_NAMES = Object.freeze(["junior", "senior", "expert"])
export const TIER_DESCRIPTIONS = Object.freeze({ junior: "低成本、速度快，适合基础工作与只读探索。", senior: "能力与成本平衡，适合常规开发和复核。", expert: "最强推理，成本和耗时最高，适合疑难设计与技术裁决。" })

// 直接校验辅助函数不进入宿主表单 schema；表单必须能经二次 JSON 序列化。
function validateTierValue(tiers) {
  const fail = (message) => { throw new TypeError("team-work-dsh tiers 无效：" + message) }
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  const string = (value) => typeof value === "string" && value.trim().length > 0
  const names = ["junior", "senior", "expert"]
  if (!object(tiers)) fail("tiers 必须是对象")
  if (Object.keys(tiers).length === 0) return tiers
  if (Object.keys(tiers).some((name) => !names.includes(name))) fail("存在未知档位")
  for (const name of names) {
    if (!Object.hasOwn(tiers, name)) fail("开始配置后必须同时包含三档")
    const candidates = Array.isArray(tiers[name]) ? tiers[name] : [tiers[name]]
    if (!candidates.length) fail(name + " 候选不能为空")
    for (const item of candidates) {
      if (!object(item) || !string(item.provider) || !string(item.model)) fail(name + " 的 provider/model 必填")
      if (Object.keys(item).some((key) => !["provider", "model", "effort", "family"].includes(key))) fail(name + " 候选存在未知字段")
      for (const key of ["effort", "family"]) if (item[key] !== undefined && !string(item[key])) fail(name + "." + key + " 必须是非空字符串")
    }
  }
  return tiers
}

export function validateTiers(value) { validateTierValue(value?.tiers ?? {}) }
const nonEmpty = () => z.string().min(1).pattern(/\S/)
// intersect 内 dict 按 strict 模式跳过 sKey 不匹配的键；只匹配未知键，再由 never 拒绝其值。
const candidate = z.intersect([
  z.object({ provider: nonEmpty().required(), model: nonEmpty().required(), effort: nonEmpty(), family: nonEmpty() }),
  z.dict(z.never().required(), z.string().pattern(/^(?!(?:provider|model|effort|family)$)/)),
])
const tier = (name) => z.union([candidate, z.array(candidate).min(1)]).required().description(TIER_DESCRIPTIONS[name])
const completeTiers = z.intersect([
  z.object({ junior: tier("junior"), senior: tier("senior"), expert: tier("expert") }),
  z.dict(z.never().required(), z.string().pattern(/^(?!(?:junior|senior|expert)$)/)),
])
export const Config = z.object({
  tiers: z.union([z.dict(z.never().required()), completeTiers]).default({}).volatile().description("当前 profile 的团队档位；开始配置后须三档齐全。"),
})

export function readDshConfigSnapshot(ctx, config = {}) {
  const tiers = typeof config.tiers?.get === "function" ? config.tiers.get() : config.tiers ?? {}
  let profileContext
  try { profileContext = typeof ctx?.get === "function" ? ctx.get("profileContext") : ctx?.profileContext } catch {}
  return { tiers: structuredClone(tiers), entryId: SETTINGS_NS, profile: typeof profileContext?.name === "string" && profileContext.name.trim() ? profileContext.name : "unresolved" }
}

export function decisionTableText() {
  return ["team-work 工具分工：", "- 正式任务的波次成员派发和续派仅由 Lead 执行：tw-dispatch（自动登记）。", "- 普通委派、用户指定档位、成员内部只读助手：原生 subagent；继承历史用 subagent_fork。成员助手仅查本职责内的限定小问题，junior、可写为空、不得继续委托，不重建审查团队；发起者核验整合，不能替代正式交付与评审。", "- 续聊已有子会话：原生 send_message；使用支持续聊的原生后端，返回的 subagentId 是会话 ID。参数以当前工具 schema 为准，不补造模式字段。", "- 开任务、拆包、推进与决定由 Lead 通过 tw 操作；成员通过 tw 交付、评审，门禁查询和补登记仍用 tw。收到带角色、范围与交付指令的派单时按成员职责执行，总目标仅作背景。", "- 普通精准选模先查 list_subagent_models；目录未列出不代表禁止，应以 provider+model 精确查询，区分权限拒绝、解析失败和可用。选模开关与允许列表约束原生工具，旧会话权限可能需新建会话后生效。", "- 原生工具参数为 reasoning_effort；tiers 的 effort 到调用时转换。缺档明确 unresolved，请配置或运行 tw models，禁止猜默认模型。"].join("\n")
}

export function systemPromptSection(ctx, config) {
  return { name: "team-work-dsh:delegation", order: 150, text: () => {
    const snapshot = readDshConfigSnapshot(ctx, config)
    return [decisionTableText(), ...TIER_NAMES.map((name) => {
      const first = Array.isArray(snapshot.tiers?.[name]) ? snapshot.tiers[name][0] : snapshot.tiers?.[name]
      return name + "：" + TIER_DESCRIPTIONS[name] + " 当前普通委派第一候选=" + (first?.provider && first?.model ? JSON.stringify(first) : "unresolved；请在插件配置中补全三档")
    })].join("\n")
  } }
}
