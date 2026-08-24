// index.js — host 插件入口：成员模型/effort 注入 + skill 注册 + tw 原生工具
// 平台事实（docs/phase3-plugin-plan.md §0）：三项均为官方插件 API；
// 失败语义全部静默降级（不注入/不注册不阻塞宿主），错误经 ctx.logger.warn 留痕。
import { makeInjectContribution } from "./inject.js"
import { twToolDefinition } from "./tw-tool.js"
import { registerEmbeddedSkill } from "./skill-embed.js"

export const name = "team-work-dsh"
export const inject = ["subagents", "skills", "tools", "logger"]

export function apply(ctx, config = {}) {
  // 1) 成员模型/effort 注入（continuable 子代 fresh+resume；childId 寻址 modelHints）
  try {
    ctx.subagents.registerContinuableSetup(makeInjectContribution(ctx, config))
  } catch (error) {
    ctx.logger?.warn?.("team-work-dsh: 模型注入未启用：" + String(error?.message ?? error))
  }
  // 2) skill 注册（构建期内嵌 dist/skill/；失败不阻塞——tw init 文件通道为兜底）
  try {
    registerEmbeddedSkill(ctx, config)
  } catch (error) {
    ctx.logger?.warn?.("team-work-dsh: skill 注册未启用（可用 tw init 文件通道兜底）：" + String(error?.message ?? error))
  }
  // 3) tw 原生工具（args 透传 CLI；output.render 渲染卡片）
  try {
    ctx.tools.register(twToolDefinition(config))
  } catch (error) {
    ctx.logger?.warn?.("team-work-dsh: tw 工具注册失败：" + String(error?.message ?? error))
  }
}
