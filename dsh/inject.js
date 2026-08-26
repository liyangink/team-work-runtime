// inject.js — continuable 子代模型注入（同步 contribution 契约版）
// 宿主契约（dsh-subagent SetupRegistry.apply 源码实证）：
//   contribution(childCtx) 同步调用，返回值【直接存为 disposer，不 await】——
//   async contribution = Promise 被当 disposer + 同步段在首个 await 让出。
// installModelSelection 宿主语义（dsh-agent/lib/index.js 实证）：
//   selection.current === undefined = 不干预（继承默认模型）；对象覆写 variables.provider/model。
// 寻址（方案 docs/dsh-tag-injection-plan.md v2）——两级：
//   ① 标签寻址（主通道，首轮生效）：子代 label 机器段 = 阶段缩写·角色[@包]（skill 标签规范），
//      派发时 runtime 已把该标签的 modelHint 快照写进 agents.json.tagHints；
//      contribution 同步段读 session.events 的 subagent/descriptor 事件（seed 内，seq0）解析 label，
//      命中即同步写 selection.current——首请求即注入。
//   ② childId 补读（回退通道，兼容旧派单）：标签缺失/未命中时按现状自循环补读 modelHints[childId]。
import { readFile, mkdir } from "node:fs/promises"
import { readFileSync, accessSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { atomicJson, withOwnerLock } from "../runtime-v3/persistence/transactions.mjs"

const requireSync = createRequire(import.meta.url)

// 标签机器段正则（skill 标签规范固定表）：阶段缩写·角色[@包]
export const LABEL_TAG_RE = /^(RES|DESIGN|SPEC|IMPL|TEST|CR|E2E|FIN)·(owner|chal|expert)(@[A-Za-z0-9_\-]+)?/
// 任务段（迁移方案三重防线①形态约束）：最后一个 # 之后全串，NAME_RE 且位于最末尾
export const TASK_TAG_RE = / #([a-z0-9][a-z0-9-]{0,63})$/

// 纯函数：从子代 label 解析 {tag, task}。三重防线：
//  ① 形态：头机器段（阶段·角色[@包]）+ 末尾 #任务名（NAME_RE）；
//  ② 事实源：候选任务名必须真实存在（.team-work/tasks/<名>/ 目录在场）——简述误写 #42 不误判；
//  ③ 规范：skill 明示简述不得以 # 结尾（软约束，②兜底）。
// 返回 null = 无标签（回退链）；返回 {tag} = 有机器段但无任务段（无法定位任务级文件，回退）
export function parseLabelTag(label) {
  if (typeof label !== "string") return null
  const head = LABEL_TAG_RE.exec(label.trim())
  if (!head) return null
  const taskM = TASK_TAG_RE.exec(label.trim())
  return taskM ? { tag: head[0], task: taskM[1] } : { tag: head[0], task: null }
}

// 纯函数：从 agents.json 内容解析某标签的注入决策（tagHints 键）
export function hintForTag(agentsJson, tag) {
  if (!agentsJson || typeof agentsJson !== "object" || typeof tag !== "string" || !tag) return null
  const hint = agentsJson.tagHints?.[tag]
  if (!hint || typeof hint !== "object") return null
  if (typeof hint.provider !== "string" || !hint.provider || typeof hint.model !== "string" || !hint.model) return null
  return {
    provider: hint.provider,
    model: hint.model,
    ...(typeof hint.effort === "string" && hint.effort ? { reasoningEffort: hint.effort } : {}),
  }
}

// 纯函数：从 agents.json 内容解析某 childId 的注入决策（补读通道，单测直接覆盖）
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

// agents.json 路径解析（任务级，迁移方案）：cwd + 任务名 → .team-work/tasks/<任务>/agents.json
export function agentsJsonPath(headerCwd, task) {
  if (typeof headerCwd !== "string" || !headerCwd || typeof task !== "string" || !task) return null
  return path.join(headerCwd, ".team-work", "tasks", task, "agents.json")
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

// 自动回填（方案 v2）：标签命中后把 mappings[派发key]=childId 写回项目 agents.json。
// 单次尝试（withOwnerLock 内部自旋约 2s 已覆盖瞬时锁争用）；写失败 warn 降级（Lead 可 agent-map 兜底）。
async function backfillMapping(file, tag, childId, warn, isStopped) {
  // file=<root>/.team-work/tasks/<任务>/agents.json：dirname(file)=task.root，锁用 task.lock（与 CLI 同锁域）
  const lock = path.join(path.dirname(file), "locks", "task.lock")
  try {
    await mkdir(path.dirname(lock), { recursive: true })
    await withOwnerLock(lock, async () => {
      if (isStopped()) return // 写时刻终检（贡献入口检查不足：fire-and-forget 启动时 stopped 必 false）
      const current = (await readFile(file, "utf8").then((t) => JSON.parse(t)).catch(() => ({})))
      const key = current?.pendingTags?.[tag]
      if (!key) return // 无派发期望 → 不写（历史派单/竞态：runtime 尚未落盘）
      if (current.mappings?.[key] === childId) return // 幂等
      current.mappings = { ...(current.mappings ?? {}) }
      current.mappings[key] = childId
      await atomicJson(file, current)
    })
  } catch (error) {
    // 单次尝试：withOwnerLock 内部已自旋约 2s 覆盖瞬时锁争用；剩余失败如实 warn（agent-map 兜底）
    warn("自动回填 mappings 失败（可 tw agent-map 兜底）：" + String(error?.message ?? error))
  }
}
// contribution 工厂：返回【同步函数】（宿主存其返回值为 disposer）。
export function makeInjectContribution(ctx, deps = {}) {
  const readFileFn = deps.readFile ?? readFile
  const readFileSyncFn = deps.readFileSync ?? readFileSync
  const accessSyncFn = deps.accessSync ?? accessSync
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
      // ① 标签寻址（主通道）：descriptor 在 seed（seq0），同步段读 label 机器段+任务段查任务级 tagHints。
      let tagHit = false
      const events = agent?.session?.events
      const descriptor = Array.isArray(events) ? events.find((e) => e?.type === "subagent/descriptor") : null
      const label = descriptor?.data?.label
      const parsed = parseLabelTag(label)
      // 任务段三重防线②：候选任务名必须目录在场（简述误写 #42 不误判）
      let file = null
      let tag = null
      if (parsed) {
        tag = parsed.tag
        if (parsed.task) {
          try {
            accessSyncFn(path.join(cwd, ".team-work", "tasks", parsed.task))
            file = agentsJsonPath(cwd, parsed.task)
          } catch {
            warn("标签任务段 " + parsed.task + " 对应任务目录不存在（简述 # 误写或任务已归档），视作无任务段")
          }
        }
      }
      if (tag && file) {
        try {
          const hint = hintForTag(JSON.parse(readFileSyncFn(file, "utf8")), tag)
          if (hint) {
            selection.current = hint
            tagHit = true
            ctx.logger?.info?.("team-work-dsh: 成员 " + agent.id.slice(0, 8) + " 标签注入 " + tag + "@" + parsed.task + " → " + hint.provider + "/" + hint.model)
            // 自动回填（方案 v2）：fire-and-forget 把 mappings[派发key] = childId 写回任务级文件。
            backfillMapping(file, tag, agent.id, warn, () => stopped)
          } else {
            warn("标签 " + tag + " 未在 tagHints 命中（派发快照缺失或已陈旧），降级 childId 补读")
          }
        } catch (error) {
          warn("标签注入读取 agents.json 失败，降级 childId 补读：" + describe(error))
        }
      }
      if (tagHit) return cleanup // 命中即锁死（与补读互斥——F-7）
      // ② childId 补读（回退通道）：仅任务段在场（file 已定位）时可用；无任务段=定位不了任务级文件，补读放弃
      if (!file) {
        warn("标签无有效任务段（无法定位任务级注册表）：不注入；请按标签规范补 #任务名 后重建子代")
        return cleanup
      }
      const startedAt = Date.now()
      let readIssueWarned = false
      let timeoutWarned = false
      let lastReadError = null
      const applyChildHint = (text) => {
        const hint = hintForChild(JSON.parse(text), agent.id)
        if (!hint) return false
        selection.current = hint
        ctx.logger?.info?.("team-work-dsh: 成员 " + agent.id.slice(0, 8) + " 补读注入 " + hint.provider + "/" + hint.model)
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
        if (file && applyChildHint(readFileSyncFn(file, "utf8"))) return cleanup
      } catch (error) {
        warnReadIssue(error)
      }
      function tick() {
        if (stopped) return
        readFileFn(file, "utf8").then((text) => {
          if (stopped) return
          if (applyChildHint(text)) return // 命中即停（一次性注入，幂等）
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
