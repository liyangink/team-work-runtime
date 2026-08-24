// inject.js — continuable 子代模型注入：childId 寻址 agents.json 的 modelHints
// 寻址链（方案 §2.1 v2）：childCtx.agent.id（= childId，fresh+resume 持久）
//   → agents.json.modelHints[childId] → installModelSelection
// agents.json 定位：config.projectRoot → 子代 session.header.cwd（继承父会话工作目录）→ 放弃（不注入）
// 全链静默降级：任何一步失败 = 不注入（子代继承 Lead 默认模型——现状行为，不劣化）。
import { readFile } from "node:fs/promises"
import path from "node:path"

// 纯函数：从 agents.json 内容解析某 childId 的注入决策（单测直接覆盖）
export function hintForChild(agentsJson, childId) {
  if (!agentsJson || typeof agentsJson !== "object") return null
  const hint = agentsJson.modelHints?.[childId]
  if (!hint || typeof hint !== "object") return null
  if (typeof hint.provider !== "string" || !hint.provider || typeof hint.model !== "string" || !hint.model) return null
  return {
    provider: hint.provider,
    model: hint.model,
    ...(typeof hint.effort === "string" && hint.effort ? { reasoningEffort: hint.effort } : {}),
  }
}

// agents.json 路径解析（纯函数导出供单测）：config 显式 → header.cwd 兜底
export function agentsJsonPath(config, headerCwd) {
  const root = config?.projectRoot ?? headerCwd
  if (!root) return null
  return path.join(String(root), ".team-work", "platform", "agents.json")
}

export function makeInjectContribution(ctx, config) {
  return (childCtx) => {
    try {
      const agent = childCtx?.agent
      if (!agent?.id) return
      const file = agentsJsonPath(config, agent?.session?.header?.cwd)
      if (!file) return
      readFile(file, "utf8")
        .then((text) => {
          const hint = hintForChild(JSON.parse(text), agent.id)
          if (!hint) return
          // installModelSelection 经 dsh-agent 导入（宿主环境内）；失败静默
          return import("@deepseek-ai/dsh-agent").then(({ installModelSelection }) => {
            installModelSelection(childCtx, { current: hint })
            ctx.logger?.info?.("team-work-dsh: 已为成员 " + agent.id.slice(0, 8) + " 注入 " + hint.provider + "/" + hint.model)
          })
        })
        .catch(() => { /* 文件不存在/损坏/导入失败 → 不注入 */ })
    } catch {
      /* 同步异常 → 不注入 */
    }
  }
}
