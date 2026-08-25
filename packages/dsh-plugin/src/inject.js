// inject.js — continuable 子代模型注入（同步 contribution 契约版）
// 宿主契约（dsh-subagent SetupRegistry.apply 源码实证）：
//   contribution(childCtx) 同步调用，返回值【直接存为 disposer，不 await】——
//   async contribution = Promise 被当 disposer + 同步段在首个 await 让出，
//   install 真正执行可能晚于子代首请求（监听器迟到）。故本实现为同步函数。
// installModelSelection 宿主语义（dsh-agent/lib/index.js 实证）：
//   selection.current === undefined = 不干预（继承默认模型）；
//   对象（哪怕 {provider:null}）会覆写 variables.provider/model——null 值杀 turn（实机铁证）。
// 首轮时序（实机修正，见 phase3-plugin-plan §时序）：childId 在子代创建前不可预知，
//   Lead 的 tw agent-map 写入晚于首 turn——hint 经自循环补读命中后【下轮请求】生效，
//   首轮必为默认模型（设计边界，非缺陷）。
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { matchProjectRoot } from "./settings.js"

const requireSync = createRequire(import.meta.url)

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

// 安装器解析——双通道：
//   同步通道（contribution 主路径）：createRequire + require（Node 22+ require(esm)；
//     dsh-agent 模块图在宿主进程早已加载，require 仅取引用，无 IO）；
//   异步通道（预解析兜底）：apply 时 fire-and-forget 动态 import 填充缓存，
//     覆盖 require(esm) 不可用的旧 Node（engines >=18 场景）。两通道任一命中即缓存。
let cachedInstaller = null
export async function resolveInstaller(settings) {
  if (typeof settings?.installModelSelection === "function") return settings.installModelSelection
  try {
    const mod = await import("@deepseek-ai/dsh-agent")
    const fn = mod.installModelSelection ?? mod.default?.installModelSelection
    if (typeof fn === "function") { cachedInstaller = fn; return fn }
  } catch { /* flat fallback 不可达 → 走同步通道/放弃 */ }
  return null
}
export function installerNow(settings) {
  if (typeof settings?.installModelSelection === "function") return settings.installModelSelection
  if (cachedInstaller) return cachedInstaller
  try {
    const m = requireSync("@deepseek-ai/dsh-agent")
    const fn = m.installModelSelection ?? m.default?.installModelSelection
    if (typeof fn === "function") { cachedInstaller = fn; return fn }
  } catch { /* 同步解析不可达 → 本子代不注入（apply 预解析已填缓存的下一子代起生效） */ }
  return null
}

// contribution 工厂：返回【同步函数】（宿主存其返回值为 disposer）。
export function makeInjectContribution(ctx, settings, deps = {}) {
  const readFileFn = deps.readFile ?? readFile
  const installerNowFn = deps.installerNow ?? installerNow
  const pollMs = deps.pollMs ?? 500
  const pollMaxMs = deps.pollMaxMs ?? 120000
  const snapshot = () => (typeof settings === "function" ? settings() : settings)
  return function contribution(childCtx) {
    let stopped = false
    let timer = null
    let disposeInstall = null
    try {
      const agent = childCtx?.agent
      if (!agent?.id) return undefined
      const config = snapshot() ?? {}
      if (config.injectionEnabled === false) return undefined
      const install = installerNowFn(settings)
      if (!install) return undefined
      // 同步注册（F2）：listener 在 contribution 同步段即刻在场；current=undefined=不干预
      const selection = { current: undefined, assembled: undefined }
      disposeInstall = install(childCtx, selection)
      // 迟到 hint 自循环补读：childId 派生时序晚于 agents.json 写入（Lead agent-map 在 spawn 后），
      // 命中即写 selection.current（下轮请求生效）并停；超时（pollMaxMs）静默停。
      const cwd = agent?.session?.header?.cwd
      const hit = matchProjectRoot(config?.projectRoots, cwd)
      const projectRoot = hit?.path ?? config?.projectRoot
      const file = agentsJsonPath({ projectRoot }, cwd)
      if (!file) return () => cleanup()
      const startedAt = Date.now()
      const tick = () => {
        if (stopped) return
        readFileFn(file, "utf8").then((text) => {
          if (stopped) return
          const hint = hintForChild(JSON.parse(text), agent.id)
          if (hint) {
            selection.current = hint
            ctx.logger?.info?.("team-work-dsh: 成员 " + agent.id.slice(0, 8) + " 注入 " + hint.provider + "/" + hint.model)
            return // 命中即停（一次性注入，幂等）
          }
          if (Date.now() - startedAt < pollMaxMs) timer = setTimeout(tick, pollMs)
        }).catch(() => {
          if (!stopped && Date.now() - startedAt < pollMaxMs) timer = setTimeout(tick, pollMs)
        })
      }
      timer = setTimeout(tick, 0)
      function cleanup() {
        stopped = true
        if (timer) clearTimeout(timer)
        if (typeof disposeInstall === "function") disposeInstall()
      }
      return cleanup
    } catch {
      return undefined
    }
  }
}
