// inject.js — continuable 子代模型注入：childId 寻址 agents.json 的 modelHints
// 时序契约（交叉审查① F2）：installModelSelection 必须在 contribution 同步段注册——
// 官方路径（dsh-headless/dsh-host-apiproxy）均在 Agent setup 同步注册，其监听器
// （system-prompt/assemble + agent/request）必须先于首次 request 就位；本实现同步预注册
// selection 对象、hint 异步补读写入 selection.current——listener 任意时刻在场，
// 最坏首轮用默认模型（不劣化、不失效）。
// installModelSelection 获取（F3）：settings.installModelSelection 直传引用（宿主 ctx 取，最稳）→
// 裸 import("@deepseek-ai/dsh-agent")（profile flat fallback，当前环境实证可行）→ 放弃注入。
import { readFile } from "node:fs/promises"
import path from "node:path"
import { matchProjectRoot } from "./settings.js"

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

// agents.json 路径解析（纯函数导出供单测）：config 显式 → header.cwd 兜底（逻辑不变）
export function agentsJsonPath(config, headerCwd) {
  const root = config?.projectRoot ?? headerCwd
  if (!root) return null
  return path.join(String(root), ".team-work", "platform", "agents.json")
}

// installModelSelection 解析（可注入依赖，F7 提纯：单测传 fake）
export async function resolveInstaller(settings) {
  if (typeof settings?.installModelSelection === "function") return settings.installModelSelection
  try {
    const mod = await import("@deepseek-ai/dsh-agent")
    if (typeof mod.installModelSelection === "function") return mod.installModelSelection
  } catch { /* flat fallback 不可达 → 放弃注入 */ }
  return null
}

export function makeInjectContribution(ctx, settings, deps = {}) {
  const readFileFn = deps.readFile ?? readFile
  const resolveInstallerFn = deps.resolveInstaller ?? resolveInstaller
  // settings 可为对象（快照）或函数（getConfig thunk，返回最新 settings 快照）。
  const snapshot = () => (typeof settings === "function" ? settings() : settings)
  return async (childCtx) => {
    try {
      const agent = childCtx?.agent
      if (!agent?.id) return
      // 每次子代创建按 getConfig() 现值判定开关（热生效）：关闭则不注入，开启才继续。
      const config = snapshot() ?? {}
      if (config.injectionEnabled === false) return
      const install = await resolveInstallerFn(settings)
      if (!install) return // 解析不到安装器 → 不注入（继承默认）
      // 同步预注册（F2 核心）：selection.current 先为空占位，监听器即刻在场
      const selection = { current: { provider: null, model: null }, assembled: void 0 }
      install(childCtx, selection)
      // 项目根：config.projectRoots 最长前缀命中 → config.projectRoot 兜底 → header.cwd
      const cwd = agent?.session?.header?.cwd
      const hit = matchProjectRoot(config?.projectRoots, cwd)
      const projectRoot = hit?.path ?? config?.projectRoot
      const file = agentsJsonPath({ projectRoot }, cwd)
      if (!file) return
      // hint 异步补读：就绪后覆写 selection.current，本轮或下轮请求生效（最坏首轮默认）
      readFileFn(file, "utf8")
        .then((text) => {
          const hint = hintForChild(JSON.parse(text), agent.id)
          if (hint) {
            selection.current = hint
            ctx.logger?.info?.("team-work-dsh: 成员 " + agent.id.slice(0, 8) + " 注入 " + hint.provider + "/" + hint.model)
          }
        })
        .catch(() => { /* 文件不存在/损坏 → 保持默认 */ })
    } catch {
      /* 同步异常 → 不注入 */
    }
  }
}
