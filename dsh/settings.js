// settings.js — 根市场制品的 DSH 全局档位配置与热更新快照。
// 宿主契约：ctx.inject(["settings"], cb) 动态注入 ctx.settings 服务，再调用其
// installSection(owner, ns, schema, entry, hooks) 注册区段（对齐 dsh-agent-default-model）。
// 服务不可用时保留 entry，插件其他能力照常降级运行。

export const SETTINGS_NS = "team-work-dsh"
export const TIER_NAMES = Object.freeze(["junior", "senior", "expert"])
export const TIER_DESCRIPTIONS = Object.freeze({
  junior: "低成本的只读探索与常规辅助工作。",
  senior: "常规实现、复核与需要稳定判断的工作。",
  expert: "核心场景、技术裁决与高失败成本工作。",
})

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0
}

function fail(message) {
  throw new TypeError("team-work-dsh tiers 无效：" + message)
}

function validateCandidate(value, label) {
  if (!isPlainObject(value)) fail(label + " 必须是候选对象")
  const allowed = new Set(["provider", "model", "effort", "family"])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(label + " 含未知字段 " + key)
  }
  if (!nonEmptyString(value.provider)) fail(label + ".provider 必须是非空字符串")
  if (!nonEmptyString(value.model)) fail(label + ".model 必须是非空字符串")
  if (value.effort !== undefined && !nonEmptyString(value.effort)) fail(label + ".effort 如填写必须是非空字符串")
  if (value.family !== undefined && !nonEmptyString(value.family)) fail(label + ".family 如填写必须是非空字符串")
}

function validateTier(value, tier) {
  if (Array.isArray(value)) {
    if (value.length === 0) fail("tiers." + tier + " 的候选数组不能为空")
    value.forEach((candidate, index) => validateCandidate(candidate, "tiers." + tier + "[" + index + "]"))
    return
  }
  validateCandidate(value, "tiers." + tier)
}

// settings 服务的 validate 为同步钩子。空对象是首次配置的 unresolved 状态；一旦开始配置，
// 三档必须齐全。单个候选对象保留为兼容输入，Web 卡片保存时统一写为候选数组。
export function validateTiers(value) {
  if (!isPlainObject(value)) fail("配置根必须是对象")
  const tiers = value.tiers
  if (tiers === undefined) return
  if (!isPlainObject(tiers)) fail("tiers 必须是对象")
  if (Object.keys(tiers).length === 0) return
  for (const key of Object.keys(tiers)) {
    if (!TIER_NAMES.includes(key)) fail("tiers 含未知档位 " + key)
  }
  for (const tier of TIER_NAMES) {
    if (!Object.hasOwn(tiers, tier)) fail("tiers 一经配置必须同时包含 junior、senior、expert")
    validateTier(tiers[tier], tier)
  }
}

// Schemastery 会把 transform 回调的函数源码写进 schema.toJSON()，并在 Web 端用
// new Function 重建。因此此函数必须完全自包含，不能引用本模块的校验辅助函数或常量。
function serializedTiersTransform(value) {
  const resolved = { tiers: value?.tiers ?? {} }
  const tiers = resolved.tiers
  const names = ["junior", "senior", "expert"]
  const fail = (message) => {
    throw new TypeError("team-work-dsh tiers 无效：" + message)
  }
  const isPlainObject = (item) => typeof item === "object" && item !== null && !Array.isArray(item)
  const nonEmptyString = (item) => typeof item === "string" && item.trim().length > 0
  const validateCandidate = (candidate, label) => {
    if (!isPlainObject(candidate)) fail(label + " 必须是候选对象")
    const allowed = new Set(["provider", "model", "effort", "family"])
    for (const key of Object.keys(candidate)) {
      if (!allowed.has(key)) fail(label + " 含未知字段 " + key)
    }
    if (!nonEmptyString(candidate.provider)) fail(label + ".provider 必须是非空字符串")
    if (!nonEmptyString(candidate.model)) fail(label + ".model 必须是非空字符串")
    if (candidate.effort !== undefined && !nonEmptyString(candidate.effort)) fail(label + ".effort 如填写必须是非空字符串")
    if (candidate.family !== undefined && !nonEmptyString(candidate.family)) fail(label + ".family 如填写必须是非空字符串")
  }
  if (!isPlainObject(tiers)) fail("tiers 必须是对象")
  if (Object.keys(tiers).length === 0) return resolved
  for (const key of Object.keys(tiers)) {
    if (!names.includes(key)) fail("tiers 含未知档位 " + key)
  }
  for (const tier of names) {
    if (!Object.hasOwn(tiers, tier)) fail("tiers 一经配置必须同时包含 junior、senior、expert")
    const candidates = tiers[tier]
    if (Array.isArray(candidates)) {
      if (candidates.length === 0) fail("tiers." + tier + " 的候选数组不能为空")
      candidates.forEach((candidate, index) => validateCandidate(candidate, "tiers." + tier + "[" + index + "]"))
    } else {
      validateCandidate(candidates, "tiers." + tier)
    }
  }
  return resolved
}

function isModuleNotFound(error) {
  const code = error?.code
  if (code === "ERR_MODULE_NOT_FOUND") return true
  if (code === "ERR_PACKAGE_PATH_NOT_EXPORTED") return false
  return /Cannot find (module|package)/i.test(String(error?.message ?? ""))
}

function warnUnlessMissing(ctx, what, error) {
  if (isModuleNotFound(error)) return
  ctx.logger?.warn?.("team-work-dsh: settings 依赖不可用（" + what + "）：" + String(error?.message ?? error))
}

function makeSchema(z) {
  const nonEmpty = (description) => z.string().required().min(1).description(description)
  const candidate = z.object({
    provider: nonEmpty("Provider 标识，必填。"),
    model: nonEmpty("模型标识，必填。"),
    effort: z.string().min(1).description("推理等级，可选。"),
    family: z.string().min(1).description("模型家族，可选；未填写时由运行时推导。"),
  }).description("一个可选模型候选。")
  const tier = (name) => z.union([
    candidate,
    z.array(candidate).min(1),
  ]).description(TIER_DESCRIPTIONS[name] + " 可填单个候选或候选数组。")
  const section = z.object({
    tiers: z.object({
      junior: tier("junior"),
      senior: tier("senior"),
      expert: tier("expert"),
    }).description("三个团队档位的模型候选池。首次配置前可保持为空。"),
  }).description("team-work-dsh 的全局档位设置。")
  // transform 同时剥离遗留键并校验三档完整性；回调可序列化后在 Web 客户端安全重建。
  return z.transform(section, serializedTiersTransform)
}

// 注册插件配置区段：同步返回读取当前快照的 thunk；内部异步解析 schemastery 后
// 经 ctx.inject 动态注入 settings 服务并注册。无服务或注册失败时返回 entry，
// 避免可选设置能力阻断宿主插件。
export function installPluginSettings(ctx, entry, deps = {}) {
  const importSchemastery = deps.importSchemastery ?? (() => import("@deepseek-ai/schemastery"))
  const injectSettings = deps.injectSettings ?? ((callback) => {
    // settings 服务是可选项：缺失时回调不触发，source 保持 entry（静默降级）。
    if (typeof ctx.inject !== "function") return
    ctx.inject(["settings"], (settingsCtx) => callback(settingsCtx?.settings))
  })
  let source = () => entry

  void (async () => {
    let z
    try {
      z = (await importSchemastery()).default
    } catch (error) {
      warnUnlessMissing(ctx, "@deepseek-ai/schemastery", error)
      return
    }
    try {
      injectSettings((settings) => {
        if (!settings || typeof settings.installSection !== "function") {
          ctx.logger?.warn?.("team-work-dsh: settings 服务不可用，跳过区段注册")
          return
        }
        settings.installSection(ctx, SETTINGS_NS, makeSchema(z), entry, {
          setSource: (current) => { source = current },
          onChange: () => {},
          validate: validateTiers,
        })
      })
    } catch (error) {
      ctx.logger?.warn?.("team-work-dsh: settings 区段注册失败：" + String(error?.message ?? error))
    }
  })()

  return () => source()
}
