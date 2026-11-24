// 宿主入口只装配正式派发、CLI 与 skill，模型解析和冷恢复由新版宿主原生承载。
import { twToolDefinition } from "./tw-tool.js"
import { twDispatchDefinition } from "./tw-dispatch.js"
import { createSleepConfirmGuard } from "./sleep-confirm.js"
import { createMemberMessageGuard } from "./member-message-guard.js"
import { registerEmbeddedSkill } from "./skill-embed.js"
import { readDshConfigSnapshot, systemPromptSection } from "./settings.js"
export { Config } from "./settings.js"
export const name = "team-work-dsh"
export const inject = ["subagents", "skills", "tools"]

export async function apply(ctx, config = {}, deps = {}) {
  const disposers = []
  const optional = (name) => typeof ctx.get === "function" ? ctx.get(name) : ctx[name]
  try {
    const settings = optional("settings")
    if (typeof settings?.configure === "function") disposers.push(settings.configure({ auto: false }))
  } catch (error) { ctx.logger?.warn?.("team-work-dsh: 配置页面策略未启用：" + String(error?.message ?? error)) }
  try {
    const dispose = await (deps.registerEmbeddedSkill ?? registerEmbeddedSkill)(ctx, config)
    if (typeof dispose === "function") disposers.push(dispose)
  } catch (error) {
    ctx.logger?.warn?.("team-work-dsh: skill 注册未启用，可用 tw init 文件通道：" + String(error?.message ?? error))
  }
  const configSnapshot = () => readDshConfigSnapshot(ctx, config)
  // sleep 引导是防呆增强：guard 自身异常只记日志并放行（fail-open），不阻塞工具执行。
  const sleepConfirm = deps.sleepConfirm ?? createSleepConfirmGuard({
    log: (message) => ctx.logger?.warn?.("team-work-dsh: " + message),
  })
  const memberGuard = createMemberMessageGuard({
    // 与宿主 send_message 使用相同的名称解析器，以实际目标会话 ID 对账，不信任显示名。
    resolveRecipient: (exec, address) => optional("subagents")?.resolveName?.(exec.agent, address, exec.signal),
    log: (message) => ctx.logger?.warn?.("team-work-dsh: " + message),
  })
  disposers.push(memberGuard.dispose)
  for (const definition of [twToolDefinition({ configSnapshot, memberGuard }), twDispatchDefinition(ctx, { configSnapshot, sleepConfirm, memberGuard })]) {
    try { const dispose = ctx.tools.register(definition); if (typeof dispose === "function") disposers.push(dispose) } catch (error) {
      ctx.logger?.warn?.("team-work-dsh: 工具注册失败：" + String(error?.message ?? error))
    }
  }
  try {
    if (typeof ctx?.on === "function") {
      const offExec = ctx.on("tools/execute", (exec, next) => exec?.name === "send_message"
        ? memberGuard.aroundExecute(exec, next)
        : sleepConfirm.aroundExecute(exec, next))
      if (typeof offExec === "function") disposers.push(offExec)
      const offSessionEvent = ctx.on("session/event", (session, event) => {
        memberGuard.observeSession(session, event)
        // 保留 sleep 原有的整回合确认语义，不以 Step 清空。
        if (event?.type === "turn/start" || event?.type === "turn/end") sleepConfirm.clearTurn(session?.id)
      })
      if (typeof offSessionEvent === "function") disposers.push(offSessionEvent)
    } else ctx.logger?.warn?.("team-work-dsh: 宿主无执行钩子，软引导未启用；成员汇报规则仍有效。")
  } catch (error) { ctx.logger?.warn?.("team-work-dsh: 软引导钩子未完整启用：" + String(error?.message ?? error)) }
  try {
    const systemPrompt = optional("systemPrompt")
    if (typeof systemPrompt?.section === "function") disposers.push(systemPrompt.section(systemPromptSection(ctx, config)))
  } catch (error) { ctx.logger?.warn?.("team-work-dsh: 委派指引未启用：" + String(error?.message ?? error)) }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (const dispose of disposers.reverse()) if (typeof dispose === "function") {
      try { dispose() } catch (error) { ctx.logger?.warn?.("team-work-dsh: 贡献释放失败：" + String(error?.message ?? error)) }
    }
  }
}
