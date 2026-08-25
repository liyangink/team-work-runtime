// inject.js — continuable 子代模型注入（同步 contribution 契约版）
// 宿主契约（dsh-subagent SetupRegistry.apply 源码实证）：
//   contribution(childCtx) 同步调用，返回值【直接存为 disposer，不 await】——
//   async contribution = Promise 被当 disposer + 同步段在首个 await 让出，
//   install 真正执行可能晚于子代首请求（监听器迟到）。故本实现为同步函数。
// installModelSelection 宿主语义（dsh-agent/lib/index.js 实证）：
//   selection.current === undefined = 不干预（继承默认模型）；
//   对象（哪怕 {provider:null}）会覆写 variables.provider/model——null 值杀 turn（实机铁证）。
// 时序（实机修正，见 phase3-plugin-plan §时序）：新建子代的 childId 在首条 prompt 前不可预知，
//   故 fresh 首轮继承默认模型，Lead 的 tw agent-map 落盘后由自循环补读供下轮请求使用；
//   cold-resume 的 hint 已存在，可在 contribution 返回前同步读入并供当前请求使用。
import { readFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

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

// agents.json 路径解析（纯函数导出供单测）：只从子会话 cwd 定位。
export function agentsJsonPath(headerCwd) {
  if (typeof headerCwd !== "string" || !headerCwd) return null
  return path.join(headerCwd, ".team-work", "platform", "agents.json")
}

// 安装器解析：插件 apply 通过动态 import 完成异步激活门槛，解析成功后才注册 setup，
// 覆盖 Node >=18，首个子代不再依赖异步缓存竞态。同步 require 仅保留给直接调用
// makeInjectContribution 且未显式注入 installerNow 的适配场景。
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
  const readFileFn = deps.readFile ?? readFile
  const readFileSyncFn = deps.readFileSync ?? readFileSync
  const installerNowFn = deps.installerNow ?? installerNow
  const pollMs = deps.pollMs ?? 500
  const pollMaxMs = deps.pollMaxMs ?? 120000
  return function contribution(childCtx) {
    let stopped = false
    let timer = null
    let disposeInstall = null
    function cleanup() {
      stopped = true
      if (timer) clearTimeout(timer)
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
      const file = agentsJsonPath(cwd)
      if (!file) {
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
      // 迟到 hint 自循环补读：childId 派生时序晚于 agents.json 写入（Lead agent-map 在 spawn 后），
      // 命中即写 selection.current（下轮请求生效）并停；超时（pollMaxMs）静默停。
      const startedAt = Date.now()
      let readIssueWarned = false
      let timeoutWarned = false
      let lastReadError = null
      const applyHint = (text) => {
        const hint = hintForChild(JSON.parse(text), agent.id)
        if (!hint) return false
        selection.current = hint
        ctx.logger?.info?.("team-work-dsh: 成员 " + agent.id.slice(0, 8) + " 注入 " + hint.provider + "/" + hint.model)
        return true
      }
      const warnReadIssue = (error) => {
        lastReadError = error
        if (readIssueWarned || error?.code === "ENOENT") return
        readIssueWarned = true
        warn("读取 agents.json 失败，将继续补读：" + describe(error))
      }
      const recoveryFor = (error) => {
        if (error instanceof SyntaxError || error?.name === "SyntaxError") {
          return "请修复或删除损坏的 agents.json，再重新运行 tw agent-map 后重试请求"
        }
        if (error?.code === "EACCES" || error?.code === "EPERM") {
          return "请修复 .team-work/platform/agents.json 的读权限后重试请求"
        }
        if (error?.code === "ENOENT" || !error) {
          return "请确认 tw agent-map 已写入该子代映射后重试请求"
        }
        return "请根据上述读取错误修复 agents.json 后重试请求"
      }
      const scheduleNext = (error) => {
        if (stopped) return
        if (error) warnReadIssue(error)
        if (Date.now() - startedAt < pollMaxMs) {
          timer = setTimeout(tick, pollMs)
          return
        }
        if (!timeoutWarned) {
          timeoutWarned = true
          warn("等待 agents.json modelHint 超时，当前子代 " + agent.id + " 保持默认模型；" + recoveryFor(lastReadError))
        }
      }
      try {
        if (applyHint(readFileSyncFn(file, "utf8"))) return cleanup
      } catch (error) {
        warnReadIssue(error)
      }
      function tick() {
        if (stopped) return
        readFileFn(file, "utf8").then((text) => {
          if (stopped) return
          if (applyHint(text)) return // 命中即停（一次性注入，幂等）
          lastReadError = null
          scheduleNext()
        }).catch((error) => {
          scheduleNext(error)
        })
      }
      timer = setTimeout(tick, 0)
      return cleanup
    } catch (error) {
      warn("模型注入初始化失败，当前子代保持默认模型；修复配置后重新创建或恢复子代：" + describe(error))
      return cleanup
    }
  }
}
