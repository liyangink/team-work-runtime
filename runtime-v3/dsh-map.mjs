// dsh-map.mjs — 调用级 DSH 插件配置快照的 tier→模型解析。
// 快照通过 TW_DSH_CONFIG 输入；Runtime 不读取配置文件，也不落盘缓存。

export const TIERS = ["junior", "senior", "expert"]
export const UNRESOLVED = Object.freeze({ provider: null, model: null, source: "unresolved", pool: [] })

const CONFIG_PATH = "team-work-dsh.tiers"

function configurationHint() {
  return `请在 DSH 当前 profile 的插件配置页保存 ${CONFIG_PATH}.junior、${CONFIG_PATH}.senior、${CONFIG_PATH}.expert；每档为含非空 provider/model 的对象或候选数组。无宿主终端由调用方通过 TW_DSH_CONFIG 提供 {tiers,entryId:"team-work-dsh",profile:<来源或 unresolved>} JSON 快照。`
}

function unresolvedTier() {
  return { ...UNRESOLVED, pool: [] }
}

function familyOf(model) {
  return model.split("-")[0]
}

// 家族去重挑选（v3.2 选人规则：同档优先不同模型家族；已用家族之外取序首位）。
export function pickFromPool(pool, usedFamilies = []) {
  if (!pool || pool.length === 0) return null
  const fresh = pool.find((candidate) => !usedFamilies.includes(candidate.family))
  const picked = fresh ?? pool[0]
  return { ...picked, selectedBy: fresh ? "diversity" : "first" }
}

// 档位候选池 → 家族去重 → 单个 hint（RoleRef 的前身）：只服务 open 期角色初始化与 tw roles --resolve。
// 派发期不再调用本函数（模型已固化在 roles/packages）；解析失败的档位返回 null，由调用方标 unresolved。
export function computeModelHint(tierResolution, usedFamilies = []) {
  if (!tierResolution?.pool?.length) return null
  const picked = pickFromPool(tierResolution.pool, usedFamilies)
  if (!picked) return null
  return {
    provider: picked.provider,
    model: picked.model,
    source: tierResolution.source,
    ...(picked.family !== undefined ? { family: picked.family } : {}),
    ...(picked.selectedBy ? { selectedBy: picked.selectedBy } : {}),
    ...(picked.effort !== undefined ? { effort: picked.effort } : {}),
  }
}

// —— ModelRef：任务级/包级保存的已解析模型实例（§3.0）——
// 字段：provider、modelName 必填；effort 可选（配置了合法枚举才出现，缺省=省略字段，禁止 "" 与 "none"）；
// family 可选（审计/同波多样性用，不投影宿主）。宿主字段映射只在绑定层 toHostTarget 一处发生。
export const MODEL_REF_KEYS = Object.freeze(["provider", "modelName", "effort", "family"])

function modelRefInvalid(message) {
  const error = new Error(message)
  error.code = "MODEL_REF_INVALID"
  return error
}

export function normalizeModelRef(value, label = "ModelRef") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw modelRefInvalid(label + " 必须是对象")
  for (const key of Object.keys(value)) {
    if (!MODEL_REF_KEYS.includes(key)) throw modelRefInvalid(label + " 含未知字段 " + JSON.stringify(key))
  }
  if (typeof value.provider !== "string" || !value.provider.trim() || typeof value.modelName !== "string" || !value.modelName.trim()) {
    throw modelRefInvalid(label + " 的 provider 与 modelName 必须是非空字符串")
  }
  const hasEffort = Object.hasOwn(value, "effort")
  // effort 语义（宿主实测）：缺省 = 省略字段；出现时必须是非空合法枚举，严禁 "" 与 "none"。
  if (hasEffort && (typeof value.effort !== "string" || !value.effort.trim() || value.effort.trim() === "none")) {
    throw modelRefInvalid(label + ' 的 effort 必须是非空字符串且不能为 "none"（不设置推理强度时省略 effort 字段）')
  }
  const hasFamily = Object.hasOwn(value, "family")
  if (hasFamily && (typeof value.family !== "string" || !value.family.trim())) throw modelRefInvalid(label + " 的 family 必须是非空字符串")
  return {
    provider: value.provider.trim(),
    modelName: value.modelName.trim(),
    ...(hasEffort ? { effort: value.effort.trim() } : {}),
    ...(hasFamily ? { family: value.family.trim() } : {}),
  }
}

// tier 候选/历史 modelHint → ModelRef；解析不出返回 null（不猜测、不补默认值）。
export function modelRefFromHint(hint, label = "modelHint") {
  if (!hint || typeof hint !== "object") return null
  if (typeof hint.provider !== "string" || !hint.provider.trim() || typeof hint.model !== "string" || !hint.model.trim()) return null
  return normalizeModelRef({
    provider: hint.provider,
    modelName: hint.model,
    ...(hint.effort !== undefined ? { effort: hint.effort } : {}),
    ...(hint.family !== undefined ? { family: hint.family } : {}),
  }, label)
}

// 身份比较只看 provider/modelName/effort；family 仅审计，不参与"是否换模型"判定。
export function modelRefsEqual(a, b) {
  if (!a || !b) return a === b
  return a.provider === b.provider && a.modelName === b.modelName && (a.effort ?? null) === (b.effort ?? null)
}

function normalizeCandidate(candidate, label) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error(`${label} 必须是对象`)
  for (const key of Object.keys(candidate)) {
    if (!['provider', 'model', 'family', 'effort'].includes(key)) throw new Error(`${label} 含未知字段 ${JSON.stringify(key)}`)
  }
  if (!Object.hasOwn(candidate, "provider") || !Object.hasOwn(candidate, "model") || typeof candidate.provider !== "string" || !candidate.provider.trim() || typeof candidate.model !== "string" || !candidate.model.trim()) {
    throw new Error(`${label} 的 provider 与 model 必须是非空字符串`)
  }
  const hasFamily = Object.hasOwn(candidate, "family")
  const hasEffort = Object.hasOwn(candidate, "effort")
  if (hasFamily && (typeof candidate.family !== "string" || !candidate.family.trim())) {
    throw new Error(`${label} 的 family 必须是非空字符串`)
  }
  if (hasEffort && (typeof candidate.effort !== "string" || !candidate.effort.trim() || candidate.effort.trim() === "none")) {
    throw new Error(`${label} 的 effort 必须是非空字符串且不能为 "none"（不设置推理强度时省略 effort 字段）`)
  }
  return {
    provider: candidate.provider.trim(),
    model: candidate.model.trim(),
    family: hasFamily ? candidate.family.trim() : familyOf(candidate.model.trim()),
    ...(hasEffort ? { effort: candidate.effort.trim() } : {}),
  }
}

function normalizeTier(entry, tier) {
  const candidates = Array.isArray(entry) ? entry : [entry]
  if (!candidates.length) throw new Error(`档位 ${tier} 的候选数组不能为空`)
  return candidates.map((candidate, index) => normalizeCandidate(candidate, `档位 ${tier} 的候选 ${index + 1}`))
}

// 静态配置校验不猜测回退：每个不可用档位都规范化为 unresolved，并附带可直接执行的修复提示。
export function validateTierSettings(rawTiers) {
  const warnings = []
  const tiers = {}
  if (!rawTiers || typeof rawTiers !== "object" || Array.isArray(rawTiers)) {
    warnings.push(`未找到有效的 ${CONFIG_PATH}；${configurationHint()}`)
    for (const tier of TIERS) tiers[tier] = unresolvedTier()
    return { tiers, warnings }
  }
  const unknownTiers = Object.keys(rawTiers).filter((key) => !TIERS.includes(key))
  if (unknownTiers.length) {
    // tier 名称是闭集；未知键表示整份映射的意图无法判定，不能带着部分有效候选继续派发。
    warnings.push(`MAP_INVALID：${CONFIG_PATH} 含未知档位 ${unknownTiers.map((tier) => JSON.stringify(tier)).join("、")}；只允许 ${TIERS.join("、")}；${configurationHint()}`)
    for (const tier of TIERS) tiers[tier] = unresolvedTier()
    return { tiers, warnings }
  }
  for (const tier of TIERS) {
    if (!Object.hasOwn(rawTiers, tier)) {
      tiers[tier] = unresolvedTier()
      warnings.push(`档位 ${tier} 未配置（unresolved）；${configurationHint()}`)
      continue
    }
    try {
      const pool = normalizeTier(rawTiers[tier], tier)
      const top = pool[0]
      tiers[tier] = {
        pool,
        provider: top.provider,
        model: top.model,
        source: "dsh-plugin-config",
        ...(top.effort !== undefined ? { effort: top.effort } : {}),
      }
    } catch (error) {
      tiers[tier] = unresolvedTier()
      warnings.push(`档位 ${tier} 无效（${error.message}，unresolved）；${configurationHint()}`)
    }
  }
  return { tiers, warnings }
}

// 唯一解析入口。缺快照、JSON 损坏和静态校验失败均返回 unresolved，不猜测来源或模型默认值。
export async function resolveTiers({ configSnapshot } = {}) {
  const source = { source: "dsh-plugin-config", entryId: "team-work-dsh", profile: "unresolved" }
  try {
    if (configSnapshot === undefined) {
      const input = process.env.TW_DSH_CONFIG
      if (!input?.trim()) throw new Error("未提供 TW_DSH_CONFIG 调用快照（unresolved）")
      try { configSnapshot = JSON.parse(input) }
      catch { throw new Error("TW_DSH_CONFIG 不是有效 JSON（unresolved）") }
    }
    if (!configSnapshot || typeof configSnapshot !== "object" || Array.isArray(configSnapshot)) throw new Error("TW_DSH_CONFIG 必须是含 tiers、entryId、profile 的对象（unresolved）")
    const fields = ["tiers", "entryId", "profile"]
    if (Object.keys(configSnapshot).some((key) => !fields.includes(key))) throw new Error("TW_DSH_CONFIG 含未知字段；只允许 tiers、entryId、profile（unresolved）")
    if (!fields.every((key) => Object.hasOwn(configSnapshot, key)) || configSnapshot.entryId !== "team-work-dsh" || typeof configSnapshot.profile !== "string" || !configSnapshot.profile.trim()) throw new Error("TW_DSH_CONFIG 必须包含 tiers，entryId 必须为 team-work-dsh，profile 必须标明来源或 unresolved")
    source.profile = configSnapshot.profile.trim()
    return { ...source, ...validateTierSettings(configSnapshot.tiers) }
  } catch (error) {
    return { ...source, tiers: Object.fromEntries(TIERS.map((tier) => [tier, unresolvedTier()])), warnings: [`${error.message}；${configurationHint()}`] }
  }
}
