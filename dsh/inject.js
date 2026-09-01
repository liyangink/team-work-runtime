// inject.js — continuable 子代模型注入（定向委派第二阶段：双通道）
// 宿主契约（dsh-subagent SetupRegistry.apply 源码实证）：
//   contribution(childCtx) 同步调用，返回值【直接存为 disposer，不 await】——
//   async contribution = Promise 被当 disposer + 同步段在首个 await 让出。
// installModelSelection 宿主语义（dsh-agent/lib/index.js 实证）：
//   selection.current === undefined = 不干预（继承默认模型）；对象覆写 variables.provider/model。
// 通道（方案 docs/dsh-directed-delegation-plan.md §6 第二阶段清理后，仅剩两级）：
//   ⓪ 直接选择（tw-tool-subagent 创建通道，首轮生效）：工具按预生成 sessionId 暂存已验证选择，
//      contribution 同步段 take-once 命中即同步写 selection.current——首请求即注入；
//   ① request/header 回读（cold-resume 权威通道）：直接选择只在创建进程内存中存在，恢复时从
//      子会话持久化的末次 request/header.config 同源回读 provider/model（含可选 effort）。
// 旧标签链（tagHints 寻址 / modelHints childId 补读 / pendingTags 自动回填）已随第二阶段删除：
// 标签回归纯展示语义（方案 §9 增量裁决——不做旧字段只读兼容窗口，header 回读天然覆盖旧会话冷恢复）。
import { createRequire } from "node:module"

const requireSync = createRequire(import.meta.url)

// 纯函数（§10.3 风险 1 cold-resume）：从子会话事件回读最近的 request/header。
// provider/model/effort 同源于一次持久化选择；reasoningEffort 有值才附带。
// 无可回读内容（新会话、无持久化请求）返回 null。
export function recallFromHeader(events) {
  if (!Array.isArray(events)) return null
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== "request/header") continue
    const config = event?.data?.header?.config
    if (
      config &&
      typeof config.provider === "string" && config.provider &&
      typeof config.model === "string" && config.model
    ) {
      return {
        provider: config.provider,
        model: config.model,
        ...(typeof config.reasoningEffort === "string" && config.reasoningEffort
          ? { reasoningEffort: config.reasoningEffort }
          : {}),
      }
    }
    return null
  }
  return null
}

// 安装器解析（与既有实现一致）
let cachedInstaller = null
export async function resolveInstaller() {
  const mod = await import("@deepseek-ai/dsh-agent")
  const fn = mod.installModelSelection ?? mod.default?.installModelSelection
  if (typeof fn === "function") { cachedInstaller = fn; return fn }
  return null
}
export function installerNow() {
  if (cachedInstaller) return cachedInstaller
  const m = requireSync("@deepseek-ai/dsh-agent")
  const fn = m.installModelSelection ?? m.default?.installModelSelection
  if (typeof fn === "function") { cachedInstaller = fn; return fn }
  return null
}

// contribution 工厂：返回【同步函数】（宿主存其返回值为 disposer）。
export function makeInjectContribution(ctx, deps = {}) {
  const installerNowFn = deps.installerNow ?? installerNow
  // tw-tool-subagent 直接选择通道（take-once）：sessionId → 已验证选择；冷恢复后为空走回读。
  const directSelections = deps.directSelections ?? new Map()
  return function contribution(childCtx) {
    let disposeInstall = null
    function cleanup() {
      if (typeof disposeInstall === "function") disposeInstall()
    }
    const warn = (message) => ctx.logger?.warn?.("team-work-dsh: " + message)
    const describe = (error) => String(error?.message ?? error)
    try {
      const agent = childCtx?.agent
      if (!agent?.id) {
        warn("模型注入跳过：子代缺少 agent.id；请检查 DSH continuable setup 上下文")
        return cleanup
      }
      const cwd = agent?.session?.header?.cwd
      if (typeof cwd !== "string" || !cwd) {
        warn("模型注入跳过：子会话缺少工作目录；请在已打开项目的 DSH 会话中创建子代")
        return cleanup
      }
      let install
      try {
        install = installerNowFn()
      } catch (error) {
        warn("模型选择安装器解析失败，当前子代保持默认模型；修复依赖后重新创建或恢复子代：" + describe(error))
        return cleanup
      }
      if (!install) {
        warn("模型选择安装器不可用，当前子代保持默认模型；请检查 @deepseek-ai/dsh-agent，等待后台重试成功后重新创建或恢复子代（依赖版本变更后需刷新插件）")
        return cleanup
      }
      // 同步注册（F2）：listener 在 contribution 同步段即刻在场；current=undefined=不干预
      const selection = { current: undefined, assembled: undefined }
      disposeInstall = install(childCtx, selection)
      // ⓪ 直接选择通道（tw-tool-subagent 创建，方案 §4 步骤 4）：按 sessionId 取内存选择，
      //    take-once 命中即同步注入（首请求即生效）并锁死——不进 header 回读。
      //    selection 与 request.agentOptions 由工具侧同一份 resolveCallConfig 结果派生（§10.3 风险 2 单一来源）。
      const direct = directSelections.get(agent.id)
      if (direct) {
        directSelections.delete(agent.id)
        selection.current = direct
        ctx.logger?.info?.("team-work-dsh: 成员 " + agent.id.slice(0, 8) + " 直接选择注入 " + direct.provider + "/" + direct.model)
        return cleanup
      }
      // ① header 回读（cold-resume 权威通道）：恢复的会话从持久化末次请求同源重建选择
      //    （provider/model 与 agentOptions 同值断言由工具侧创建时保证，见 tw-tool-subagent.js R2）。
      const recalled = recallFromHeader(agent?.session?.events)
      if (recalled) {
        selection.current = recalled
        ctx.logger?.info?.(
          "team-work-dsh: 成员 " + agent.id.slice(0, 8) + " header 回读重建 " + recalled.provider + "/" + recalled.model
        )
        return cleanup
      }
      // 无选择来源（原生 subagent 新建且尚无持久化请求）：保持 current=undefined——继承平台默认模型。
      return cleanup
    } catch (error) {
      warn("模型注入初始化失败，当前子代保持默认模型；修复配置后重新创建或恢复子代：" + describe(error))
      return cleanup
    }
  }
}
