// index.js — 根市场制品的 DSH host 插件入口：模型注入 + skill + tw 工具 + 全局配置
// 失败语义逐级降级（不注入/不注册不阻塞宿主），错误经 ctx.logger.warn 留痕。
import { makeInjectContribution, resolveInstaller } from "./inject.js"
import { twToolDefinition } from "./tw-tool.js"
import { twToolSubagentDefinition, systemPromptSection } from "./tw-tool-subagent.js"
import { twDispatchDefinition } from "./tw-dispatch.js"
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
  // 全局配置 entry（settings 区段的 base 层初值）：空 tiers 代表尚未配置，不能猜测环境默认模型。
  // settings 服务装载后，Web 配置卡经宿主 scope 取得最新深冻结快照。
  const entry = { tiers: {} }
  // 0) 全局配置区段注册：fire-and-forget，不阻断其他插件能力。返回快照读取 thunk。
  const tiersSource = installSettings(ctx, entry)
  // tw-tool-subagent 直接选择表（sessionId → 已验证选择）：工具写入、setup 贡献 take-once 消费。
  const directSelections = new Map()
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
    const resolution = Promise.resolve().then(() => resolveModelInstaller())
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
  // 1) 成员模型/effort 注入——双宿主版本兼容：
  //    0.1.1：registerContinuableSetup + installModelSelection（直接选择通道 take-once +
  //    request/header 回读双通道——标签链已于二阶段切换删除）；
  //    0.1.2（dsh-subagent 源码实证）：SetupRegistry/registerContinuableSetup 已移除，宿主原生
  //    接管全部注入职责——startContinuable 的 agentOptions.reasoningEffort 直接进 buildRequest
  //    的 seedConfig（首请求即生效），descriptor v3 持久化 provider/model/effort 并在冷恢复时
  //    重建 agentOptions。setup 通道缺失不是故障：跳过注册并按「宿主原生路由」放行创建门槛。
  const hostNativeModelRouting = typeof ctx.subagents?.registerContinuableSetup !== "function"
  if (hostNativeModelRouting) {
    ctx.logger?.info?.("team-work-dsh: 宿主无 continuable setup 通道（>=0.1.2 形态），成员模型/effort 经宿主原生 agentOptions 路由")
  }
  let installerReady = false
  if (!hostNativeModelRouting) {
    installerReady = await tryResolveInstaller(true)
    try {
      setupDisposer = ctx.subagents.registerContinuableSetup(makeInjectContribution(ctx, {
        installerNow: () => resolvedInstaller,
        directSelections,
      }))
      setupRegistered = true
    } catch (error) {
      ctx.logger?.warn?.("team-work-dsh: 模型注入注册失败：" + String(error?.message ?? error))
    }
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
  // 2) skill 注册（直接读取根制品内的 skills/team-work-v3；失败不阻塞——tw init 为兜底）
  try {
    await registerSkill(ctx, config)
  } catch (error) {
    ctx.logger?.warn?.("team-work-dsh: skill 注册未启用（可用 tw init 文件通道兜底）：" + String(error?.message ?? error))
  }
  // 3) tw 原生工具（args 透传 CLI；output.render 渲染卡片；工作目录来自调用子会话 cwd）
  try {
    ctx.tools.register(twToolDefinition())
  } catch (error) {
    ctx.logger?.warn?.("team-work-dsh: tw 工具注册失败：" + String(error?.message ?? error))
  }
  // 4) tw-tool-subagent 定向选模委派工具（宿主侧依赖运行时探测：缺失时工具报错，不阻塞装载）
  try {
    ctx.tools.register(twToolSubagentDefinition(ctx, {
      tiersSource,
      directSelections,
      isModelInjectionReady: () => hostNativeModelRouting || (setupRegistered && typeof resolvedInstaller === "function"),
    }))
  } catch (error) {
    ctx.logger?.warn?.("team-work-dsh: tw-tool-subagent 工具注册失败：" + String(error?.message ?? error))
  }
  // 5) tw-dispatch 工作流派发工具（复用创建核心与同一份直接选择表；宿主侧依赖运行时探测：
  //    缺失时工具报错，不阻塞装载）。波次推进/派发经此工具，tw-tool-subagent 退守非工作流委派。
  try {
    ctx.tools.register(twDispatchDefinition(ctx, {
      tiersSource,
      directSelections,
      isModelInjectionReady: () => hostNativeModelRouting || (setupRegistered && typeof resolvedInstaller === "function"),
    }))
  } catch (error) {
    ctx.logger?.warn?.("team-work-dsh: tw-dispatch 工具注册失败：" + String(error?.message ?? error))
  }
  // 6) systemPrompt 决策表 section（§3.6/§3.7：与工具说明同源；服务缺失时降级不阻塞）
  let sectionDisposer = null
  try {
    // systemPrompt 是可选增强，不列入顶层 inject；真实 Cordis Context 经 get 查询，
    // 避免属性守卫把“缺失时降级”变成静默异常。
    const systemPrompt = typeof ctx.get === "function" ? ctx.get("systemPrompt") : ctx.systemPrompt
    if (systemPrompt && typeof systemPrompt.section === "function") {
      sectionDisposer = systemPrompt.section(systemPromptSection())
    } else {
      ctx.logger?.warn?.("team-work-dsh: systemPrompt 服务不可用，跳过定向委派决策表注入（工具说明仍携带同表）")
    }
  } catch (error) {
    sectionDisposer = null
    ctx.logger?.warn?.("team-work-dsh: systemPrompt 决策表注册失败：" + String(error?.message ?? error))
  }
  return () => {
    stopped = true
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
    if (typeof setupDisposer === "function") setupDisposer()
    if (typeof sectionDisposer === "function") sectionDisposer()
  }
}
