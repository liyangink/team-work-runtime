// 宿主入口只装配正式派发、CLI 与 skill，模型解析和冷恢复由新版宿主原生承载。
import { twToolDefinition } from "./tw-tool.js"
import { twDispatchDefinition } from "./tw-dispatch.js"
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
  for (const definition of [twToolDefinition({ configSnapshot }), twDispatchDefinition(ctx, { configSnapshot })]) {
    try { const dispose = ctx.tools.register(definition); if (typeof dispose === "function") disposers.push(dispose) } catch (error) {
      ctx.logger?.warn?.("team-work-dsh: 工具注册失败：" + String(error?.message ?? error))
    }
  }
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
