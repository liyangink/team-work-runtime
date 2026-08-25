// index.js — host 插件入口：成员模型/effort 注入 + skill 注册 + tw 原生工具 + 全局配置接线
// 平台事实（docs/phase3-plugin-plan.md §0）：三项均为官方插件 API；
// 失败语义逐级降级（不注入/不注册不阻塞宿主），错误经 ctx.logger.warn 留痕。
import { makeInjectContribution, resolveInstaller } from "./inject.js"
import { twToolDefinition } from "./tw-tool.js"
import { registerEmbeddedSkill } from "./skill-embed.js"
import { installPluginSettings } from "./settings.js"

export const name = "team-work-dsh"
// F1（交叉审查①）：logger 是 ctx 内建属性非可注入服务——inject 含非服务名会导致 fiber INACTIVE（cordis 实验证实）
export const inject = ["subagents", "skills", "tools"]

export async function apply(ctx, config = {}, deps = {}) {
  const installSettings = deps.installPluginSettings ?? installPluginSettings
  const resolveModelInstaller = deps.resolveInstaller ?? resolveInstaller
  const registerSkill = deps.registerEmbeddedSkill ?? registerEmbeddedSkill
  const installerRetryMs = deps.installerRetryMs ?? 5000
  const installerResolveTimeoutMs = deps.installerResolveTimeoutMs ?? 5000
  // 全局配置 entry（settings 区段的 base 层初值）：settings 服务装载后由 source() 热覆写。
  // 注意：entry 不再是「运行时读取的权威值」——读取方统一走 installPluginSettings 返回的 getConfig thunk。
  const entry = {
    projectRoots: Array.isArray(config?.projectRoots) ? config.projectRoots : [],
    twBin: config?.twBin ?? null,
    injectionEnabled: config?.injectionEnabled !== false,
  }
  // 0) 全局配置区段注册：同步拿 getConfig thunk（每次调用取最新 settings 快照），注册 fire-and-forget。
  //    getConfig 供 inject / tw-tool 在消费时刻读 source() 现值——深冻结快照只读。
  const getConfig = installSettings(ctx, entry)
  // 激活门槛：先解析安装器，再开放 continuable setup。Cordis 会等待 async apply，
  // 因此 Node 18/20 的动态 import 也不会出现“首个子代错过、第二个才生效”的竞态。
  let resolvedInstaller = null
  let retryTimer = null
  let stopped = false
  let setupDisposer = null
  let setupRegistered = false
  const resolveInstallerWithTimeout = (initial) => {
    let timeout
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        const error = new Error("模型选择安装器解析超时（" + installerResolveTimeoutMs + "ms）")
        error.code = "INSTALLER_RESOLVE_TIMEOUT"
        reject(error)
      }, installerResolveTimeoutMs)
      if (!initial) timeout.unref?.()
    })
    const resolution = Promise.resolve().then(() => resolveModelInstaller(getConfig()))
    return Promise.race([resolution, deadline]).finally(() => clearTimeout(timeout))
  }
  const tryResolveInstaller = async (initial) => {
    try {
      const candidate = await resolveInstallerWithTimeout(initial)
      if (stopped && !initial) return false
      if (typeof candidate !== "function") throw new Error("@deepseek-ai/dsh-agent 未导出 installModelSelection")
      resolvedInstaller = candidate
      if (!initial) ctx.logger?.info?.("team-work-dsh: 模型选择安装器已恢复，后续子代可重新注入")
      return true
    } catch (error) {
      if (initial) {
        ctx.logger?.warn?.("team-work-dsh: 模型选择安装器解析失败；当前子代将继承默认模型，后台会继续重试。修复依赖后重新创建或恢复子代：" + String(error?.message ?? error))
      }
      return false
    }
  }
  const installerReady = await tryResolveInstaller(true)
  // 1) 成员模型/effort 注入（continuable 子代 fresh+resume；childId 寻址 modelHints）
  //    injectionEnabled 判定移入 contribution 闭包内（按 getConfig() 现值），使关/开热生效：
  //    setup 常驻，子代创建时若快照 injectionEnabled === false 则不注入。
  try {
    setupDisposer = ctx.subagents.registerContinuableSetup(makeInjectContribution(ctx, getConfig, {
      installerNow: () => resolvedInstaller,
    }))
    setupRegistered = true
  } catch (error) {
    ctx.logger?.warn?.("team-work-dsh: 模型注入注册失败：" + String(error?.message ?? error))
  }
  const scheduleInstallerRetry = () => {
    if (stopped || resolvedInstaller || !setupRegistered) return
    retryTimer = setTimeout(async () => {
      retryTimer = null
      if (stopped || await tryResolveInstaller(false)) return
      scheduleInstallerRetry()
    }, installerRetryMs)
    retryTimer.unref?.()
  }
  if (!installerReady) scheduleInstallerRetry()
  // 2) skill 注册（构建期内嵌 dist/skill/；失败不阻塞——tw init 文件通道为兜底）
  try {
    await registerSkill(ctx, config)
  } catch (error) {
    ctx.logger?.warn?.("team-work-dsh: skill 注册未启用（可用 tw init 文件通道兜底）：" + String(error?.message ?? error))
  }
  // 3) tw 原生工具（args 透传 CLI；output.render 渲染卡片；execute 内按 getConfig() 读最新配置）
  try {
    ctx.tools.register(twToolDefinition(getConfig))
  } catch (error) {
    ctx.logger?.warn?.("team-work-dsh: tw 工具注册失败：" + String(error?.message ?? error))
  }
  return () => {
    stopped = true
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
    if (typeof setupDisposer === "function") setupDisposer()
  }
}
