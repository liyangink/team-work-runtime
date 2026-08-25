// settings.js — 插件配置全局化：经宿主 settings 服务落 $DSH_HOME/settings.yaml 热生效
// 平台事实：宿主 settings 服务 = 动态 import('@deepseek-ai/dsh-settings') →
// { installSettingsSection, settingsNamespace }；import 失败 = 宿主无 settings 服务，静默跳过保持现行为。
// 参考样板：ntes-dsh-market/src/settings.ts 的 installMarketSettings（fire-and-forget + try/catch 降级）。
//
// installSettingsSection 真实契约（dsh-settings/lib/index.js:618）：
//   installSettingsSection(ctx, ns, schema, entry, hooks)
//   - hooks.setSource(current: () => T)：参数「返回当前值的 thunk」，须存储（source = current）后按需调用；
//     service 内部调用 hooks.setSource(() => scope.get())——scope.get() 返回「深冻结」快照（deepFreeze(resolve(...))）。
//   - schema：schemastery z<T> 可调用对象；service 解析时执行 schema(mergeLayers(base, section))，
//     裸对象会被当函数调用抛 TypeError 且被外层 catch 吞掉。故必须用真实 z.object(...) 构造。
//   - 读取方每次调 source() 取新快照（只读，不可 Object.assign 进深冻结对象）。

export const SETTINGS_NS = 'team-work-dsh'

// 纯函数：entries（形如 [{ path, twBin?, injectionEnabled? }]，path 绝对路径）中取最长前缀命中项。
// 无 path 前缀匹配返回 null；空数组返回 null。
// 分隔符边界：比较时统一给 path 补尾斜杠，target 前缀匹配——'/a/b' 不命中 '/a/bc'，
// 末尾斜杠输入与相对路径输入行为见 tests/dsh-plugin.test.mjs。
export function matchProjectRoot(projectRoots, cwd) {
  if (!Array.isArray(projectRoots) || projectRoots.length === 0) return null
  if (typeof cwd !== "string" || !cwd) return null
  const target = cwd.endsWith("/") ? cwd : cwd + "/"
  let best = null
  for (const entry of projectRoots) {
    if (!entry || typeof entry.path !== "string" || !entry.path) continue
    const p = entry.path.endsWith("/") ? entry.path : entry.path + "/"
    if (!target.startsWith(p)) continue
    if (best === null || p.length > (best.path.endsWith("/") ? best.path : best.path + "/").length) {
      best = entry
    }
  }
  return best
}

// 是否为「模块/包不存在」类错误：宿主无该服务属正常形态，应静默降级；
// 其余异常（导出缺失、包内抛错等）应留痕再降级。
function isModuleNotFound(error) {
  const code = error?.code
  if (code === "ERR_MODULE_NOT_FOUND") return true
  if (code === "ERR_PACKAGE_PATH_NOT_EXPORTED") return false
  return /Cannot find (module|package)/i.test(String(error?.message ?? ""))
}

// 缺失类错误留痕 vs 静默的公共出口：模块不存在静默，其他 warn 后均降级。
function warnUnlessMissing(ctx, what, error) {
  if (isModuleNotFound(error)) return
  ctx.logger?.warn?.("team-work-dsh: settings 依赖不可用（" + what + "）：" + String(error?.message ?? error))
}

// 构造区段 schema（schemastery）：object 字段缺省即 optional，.default() 在缺省时填充。
// 与 index.js entry / README settings.yaml 字段一一对应。
function makeSchema(z) {
  return z.object({
    projectRoots: z.array(z.object({
      path: z.string(),
      twBin: z.string(),
      injectionEnabled: z.boolean(),
    })).default([]),
    twBin: z.string(),
    injectionEnabled: z.boolean().default(true),
  })
}

// 注册插件配置区段：同步返回「读当前配置快照」的 thunk，内部 fire-and-forget 完成
// settings 服务加载 + 区段注册。有服务时返回 source()（scope.get() 深冻结快照），
// 无服务时永远返回 entry（配置初值，与未安装服务等价）。两个动态 import 任一失败
// 整段降级（不注册、返回 entry），模块不存在静默、其他异常 warn 留痕。
//
// deps 可注入（单测不依赖真实 dsh 运行时）：
//   deps.importSettings   —— 默认 () => import('@deepseek-ai/dsh-settings')
//   deps.importSchemastery —— 默认 () => import('@deepseek-ai/schemastery')
export function installPluginSettings(ctx, entry, deps = {}) {
  const importSettings = deps.importSettings ?? (() => import("@deepseek-ai/dsh-settings"))
  const importSchemastery = deps.importSchemastery ?? (() => import("@deepseek-ai/schemastery"))

  // source thunk：无服务时返回 entry；服务装载后由 setSource 换成 scope.get()。
  let source = () => entry

  // fire-and-forget：注册结果不影响主链路；子代注册不等 settings。
  void (async () => {
    let settingsMod
    try {
      settingsMod = await importSettings()
    } catch (error) {
      warnUnlessMissing(ctx, "@deepseek-ai/dsh-settings", error) // 模块不存在（宿主无服务）→ 静默
      return
    }
    let z
    try {
      z = (await importSchemastery()).default
    } catch (error) {
      warnUnlessMissing(ctx, "@deepseek-ai/schemastery", error)
      return
    }
    try {
      const { installSettingsSection, settingsNamespace } = settingsMod
      if (typeof installSettingsSection !== "function" || typeof settingsNamespace !== "function") {
        if (!isModuleNotFound(null)) ctx.logger?.warn?.("team-work-dsh: settings 模块缺少 installSettingsSection/settingsNamespace，跳过区段注册")
        return
      }
      installSettingsSection(ctx, settingsNamespace(SETTINGS_NS), makeSchema(z), entry, {
        // setSource 参数是 thunk（函数）：存储之，读取方每次调 source() 取最新快照。
        setSource: (current) => { source = current },
        onChange: () => {},
      })
    } catch (error) {
      ctx.logger?.warn?.("team-work-dsh: settings 区段注册失败：" + String(error?.message ?? error))
    }
  })()

  return () => source()
}
