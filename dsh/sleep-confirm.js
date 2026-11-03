// dsh/sleep-confirm.js — sleep 确认引导 Hook。
//
// 目标：tw-dispatch 派发后不再收束回合，Lead 能输出派发简报；模型若想用 sleep/轮询等待，
// 首次命中时不执行命令、返回引导卡片并经 exec.deferContext 递达，让模型自判"等宿主自动唤醒"
// 还是"确需同步等待"。模型在见到引导后的任意更晚 Step 再次执行才真实放行；同一 Step 内
// 预排/循环/并行的后续 sleep 继续拦截（模型尚未自判）；每次新派发（派发世代 +1）后旧确认作废。
//
// 定位是防呆增强，不是门禁：guard 自身任何异常都 fail-open 放行原命令，不阻塞工具执行。
import { randomUUID } from "node:crypto"
import path from "node:path"
import { resolveChildCwd } from "./tw-tool.js"

/** 拦截结果里 stopped 字段的标记值（bash 前台输出契约的 stopped 是自由字符串）。 */
export const SLEEP_CONFIRM_STOP = "TWR_SLEEP_CONFIRM"

/** 宿主原生委派工具名：成功委派是新的等待起点，同样递增派发世代（以宿主注册名为准）。 */
export const NATIVE_DELEGATION_TOOLS = Object.freeze(["subagent", "subagent_fork"])

/** 检测阈值与文案窗口；R2 轮询循环不设时长阈值（循环体内的 sleep 本身就是轮询）。 */
export const SLEEP_CONFIRM_RULES = Object.freeze({
  pureSleepSeconds: 1,
  chainedSleepSeconds: 3,
  dispatchHintWindowMs: 30 * 60 * 1000,
})

const SLEEP_UNIT_SECONDS = Object.freeze({ "": 1, s: 1, m: 60, h: 3600, d: 86400 })

/**
 * 解析 sleep 时长参数为秒；无法识别时返回 null（不猜测，交给调用方放行）。
 * 支持纯数字与单个 s/m/h/d 后缀，以及 GNU sleep 的 infinity。
 */
export function parseSleepSeconds(token) {
  if (typeof token !== "string" || !token) return null
  const lower = token.trim().toLowerCase()
  if (lower === "infinity" || lower === "inf") return Number.POSITIVE_INFINITY
  const match = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(lower)
  if (!match) return null
  return Number(match[1]) * SLEEP_UNIT_SECONDS[match[2]]
}

/** 按命令分隔符切段（&&、||、;、换行）；单竖线管道不切，管道整体不算"纯等待"。 */
function splitCommandSegments(command) {
  return String(command ?? "")
    .split(/&&|\|\||;|\n/)
    .map((segment) => segment.trim())
    .filter(Boolean)
}

/** 纯 sleep 段的秒数；不是纯 sleep 时返回 null。 */
function pureSleepSeconds(segment) {
  const match = /^sleep\s+(\S+)$/.exec(segment)
  return match ? parseSleepSeconds(match[1]) : null
}

/** tail 是否带跟随参数（-f / -F / --follow / -100f 这类组合）。 */
function isFollowTail(segment) {
  if (!/^tail(?:\s|$)/.test(segment)) return false
  return segment
    .split(/\s+/)
    .slice(1)
    .some((token) => /^-[0-9A-Za-z]*[fF][0-9A-Za-z]*$/.test(token) || /^--follow(?:=|$)/.test(token))
}

/** 是否存在 while/until ... do ... done 结构，且循环体内含 sleep 命令。 */
function hasPollingLoop(command) {
  const pattern = /\b(?:while|until)\b[\s\S]*?\bdo\b([\s\S]*?)\bdone\b/g
  for (const match of String(command ?? "").matchAll(pattern)) {
    if (/(?:^|[;&|\s])sleep(?:\s|$)/m.test(match[1])) return true
  }
  return false
}

/**
 * 检测一条 bash 命令是否属于"sleep/轮询等待"（纯函数，可独立单测）。
 *
 * 规则：R1 首命令为纯 sleep（≥1s）/ watch / tail -f；R2 while/until 循环体内含 sleep；
 * R3 &&、;、换行分段中存在 ≥3s 的纯 sleep 段。
 * 白名单：run_in_background（宿主后台机制）、<1s 的纯 sleep、<3s 的链中 sleep。
 * 不检测 run_code 程序体内的 setTimeout/Promise 等待（文本匹配不可靠，交给宿主 timeoutMs）。
 */
export function analyzeSleepCommand(command, options = {}) {
  if (options?.runInBackground === true) return { match: false, rule: null, reason: "background" }
  const text = String(command ?? "").trim()
  if (!text) return { match: false, rule: null }
  const segments = splitCommandSegments(text)
  const first = segments[0] ?? ""
  if (/^watch(?:\s|$)/.test(first)) return { match: true, rule: "R1", kind: "watch", seconds: null }
  if (isFollowTail(first)) return { match: true, rule: "R1", kind: "tail-follow", seconds: null }
  const firstSleep = pureSleepSeconds(first)
  if (firstSleep !== null && firstSleep >= SLEEP_CONFIRM_RULES.pureSleepSeconds) {
    return { match: true, rule: "R1", kind: "sleep", seconds: firstSleep }
  }
  if (hasPollingLoop(text)) return { match: true, rule: "R2", kind: "loop", seconds: null }
  for (const segment of segments) {
    const seconds = pureSleepSeconds(segment)
    if (seconds !== null && seconds >= SLEEP_CONFIRM_RULES.chainedSleepSeconds) {
      return { match: true, rule: "R3", kind: "sleep", seconds }
    }
  }
  return { match: false, rule: null }
}

/** 首次拦截的引导文案；有近期派发记录时首行追加场景提示。 */
export function renderSleepConfirmGuide(dispatchHint = null) {
  return [
    ...(dispatchHint ? [dispatchHint] : []),
    "[TWR_SLEEP_CONFIRM] 本次调用将进入 sleep/轮询等待，命令未执行。请先自判等待是否必要：",
    "1. 若你在等待 tw-dispatch 派出的波次成员、原生 subagent、后台 job 或定时器：宿主会在它们完成时自动唤醒本会话并注入通知，不需要 sleep——正确做法是输出派发简报/结束语后自然结束当前回合。",
    "2. 若你确需同步等待（等待宿主不管理的外部进程或条件，且本回合必须阻塞拿到结果才能继续）：在你看到本提示之后的后续 Step 再次执行该命令即确认放行；更推荐改用 bash run_in_background + job_output(wait:true) 的宿主原生等待通道。",
    "（同一次 run_code 程序预排或循环的后续 sleep、同一 Step 并行发出的其他 sleep 都会继续被拦截；确认放行后本回合内不再重复引导；本回合内再次发起新派发（波次成员或原生 subagent）后，sleep 会重新引导一次；新回合也会重新引导）",
  ].join("\n")
}

/** 同 Step 继续拦截的精简提示。 */
export function renderSleepConfirmReminder() {
  return "[TWR_SLEEP_CONFIRM] 本回合已引导过；请在看到引导后的后续 Step 再次执行该命令以确认放行（更推荐 bash run_in_background + job_output(wait:true) 的宿主原生等待通道）。"
}

/** 读取当前 Step 键；读不到返回 null（保守方向：视为同 Step，继续拦截）。 */
function readStepKey(agent) {
  const phase = agent?.phase
  if (phase && phase.kind === "running" && Number.isInteger(phase.turn) && Number.isInteger(phase.step)) {
    return { turn: phase.turn, step: phase.step }
  }
  return null
}

/** 卡片里是否包含"新工作交付"：refollowed / recovered / freshRebuilt / 新建（无 reused 标记）。 */
function hasNewDelivery(card) {
  const entries = [
    ...(Array.isArray(card?.dispatched) ? card.dispatched : []),
    ...(Array.isArray(card?.inflight) ? card.inflight : []),
  ]
  return entries.some(
    (entry) => entry && typeof entry === "object" && entry.ok === true && entry.reused !== true && entry.passthrough !== true,
  )
}

/**
 * sleep 确认引导守卫（纯状态机，无宿主依赖）。
 *
 * 状态：WeakMap<agent, { epoch, guided, confirmed, lastDispatch }>。
 * - guided：{ step, turn, epoch }，首次拦截写入，等待模型自判；
 * - confirmed：{ turn, epoch }，更晚 Step 再次执行即确认，本回合同世代内放行；
 * - epoch：派发世代，noteDispatch 新交付与原生委派成功各递增一次，旧记录按世代作废。
 *
 * @param {{ now?: () => number, log?: (message: string) => void, dispatchHintWindowMs?: number }} [options]
 */
export function createSleepConfirmGuard(options = {}) {
  const now = typeof options.now === "function" ? options.now : () => Date.now()
  const report = typeof options.log === "function" ? options.log : () => {}
  const hintWindowMs = Number.isFinite(options.dispatchHintWindowMs)
    ? options.dispatchHintWindowMs
    : SLEEP_CONFIRM_RULES.dispatchHintWindowMs
  const byAgent = new WeakMap()
  const bySessionId = new Map()

  const notice = (error) => {
    try { report("[sleep-confirm] " + String(error?.message ?? error)) } catch { /* 日志失败不影响主流程 */ }
  }

  const stateFor = (agent) => {
    let state = byAgent.get(agent)
    if (state === undefined) {
      state = { epoch: 0, guided: null, confirmed: null, lastDispatch: null }
      byAgent.set(agent, state)
      const sessionId = typeof agent?.id === "string" && agent.id ? agent.id : null
      if (sessionId) bySessionId.set(sessionId, agent)
    }
    return state
  }

  /** 派发世代对不上的旧记录一律作废（按无状态处理）。 */
  const reconcileEpoch = (state) => {
    if (state.guided && state.guided.epoch !== state.epoch) state.guided = null
    if (state.confirmed && state.confirmed.epoch !== state.epoch) state.confirmed = null
  }

  /** 判定一次 bash 调用：allow 直接执行；intercept 首次引导或同 Step 精简提示。 */
  const decide = (exec) => {
    if (exec?.name !== "bash") return { action: "allow" }
    const agent = exec?.agent
    if (!agent || typeof agent !== "object") return { action: "allow" }
    const args = exec?.arguments ?? {}
    const hit = analyzeSleepCommand(args.command, { runInBackground: args.run_in_background === true })
    if (!hit.match) return { action: "allow" }
    const stepKey = readStepKey(agent)
    const state = stateFor(agent)
    reconcileEpoch(state)
    // turn 事件缺失时的兜底：记录里的 turn 与当前 turn 不一致一律按无状态处理，避免跨回合误放行。
    const recordedTurn = state.guided?.turn ?? state.confirmed?.turn ?? null
    if (recordedTurn !== null && stepKey !== null && recordedTurn !== stepKey.turn) {
      state.guided = null
      state.confirmed = null
    }
    if (state.confirmed) return { action: "allow", rule: hit.rule }
    if (state.guided) {
      const laterStep = stepKey !== null && state.guided.step !== null && stepKey.step > state.guided.step
      if (laterStep) {
        state.guided = null
        state.confirmed = { turn: stepKey.turn, epoch: state.epoch }
        return { action: "allow", rule: hit.rule, confirmed: true }
      }
      return { action: "intercept", phase: "remind", rule: hit.rule, state }
    }
    return { action: "intercept", phase: "guide", rule: hit.rule, state }
  }

  /** 记录 guided 状态（递达成功后才调用，避免递达失败留下残迹）。 */
  const markGuided = (exec) => {
    const state = stateFor(exec.agent)
    const stepKey = readStepKey(exec.agent)
    state.guided = { step: stepKey?.step ?? null, turn: stepKey?.turn ?? null, epoch: state.epoch }
  }

  /** 引导文本的近期派发提示（30 分钟内）。 */
  const dispatchHint = (state) => {
    const last = state?.lastDispatch
    if (!last || !Number.isFinite(last.at)) return null
    const elapsed = now() - last.at
    if (elapsed < 0 || elapsed > hintWindowMs) return null
    const minutes = Math.max(1, Math.floor(elapsed / 60000))
    const target = last.task ? "任务 " + last.task + " 的波次" : "波次成员"
    return "本会话 " + minutes + " 分钟前刚派发了" + target + "，成员完成时宿主会自动唤醒本会话。"
  }

  /** 拦截结果：符合 bash 前台输出契约，顶层调用时模型直接可见。 */
  const interruptResult = (exec, decision) => {
    const args = exec?.arguments ?? {}
    const text = decision.phase === "guide" ? renderSleepConfirmGuide(dispatchHint(decision.state)) : renderSleepConfirmReminder()
    if (typeof exec?.deferContext === "function") {
      exec.deferContext({
        id: randomUUID(),
        role: "user",
        content: [{ type: "text", text }],
        source: {
          kind: "sleep-confirm",
          form: "notice",
          summary: decision.phase === "guide" ? "sleep 确认引导" : "sleep 引导提醒",
        },
      })
    }
    // cwd 与 bash 前台结果的语义一致：workdir 相对路径按会话工作目录解析，缺省用会话工作目录。
    const sessionCwd = resolveChildCwd(exec)
    const workdir = typeof args.workdir === "string" && args.workdir
      ? path.isAbsolute(args.workdir) ? args.workdir : path.resolve(sessionCwd ?? "/", args.workdir)
      : sessionCwd ?? "/"
    return {
      isError: false,
      value: {
        kind: "foreground",
        cwd: workdir,
        exitCode: null,
        signal: null,
        timedOut: false,
        aborted: false,
        stopped: SLEEP_CONFIRM_STOP,
        timeoutMs: 0,
        stdout: { text, truncated: false },
        stderr: { text: "", truncated: false },
      },
    }
  }

  /** 原生委派成功返回后递增派发世代：新的等待起点，旧确认不能代表模型对新等待的自判。 */
  const observeNativeDelegation = (exec) => {
    try {
      const agent = exec?.agent
      if (!agent || typeof agent !== "object") return
      stateFor(agent).epoch += 1
    } catch (error) { notice(error) }
  }

  /**
   * 工具执行前钩子：bash 命中 sleep/轮询时拦截并递达引导；原生委派成功后递增派发世代；
   * 其余工具与命令完全透传给下游执行。
   */
  const aroundExecute = async (exec, next) => {
    if (NATIVE_DELEGATION_TOOLS.includes(exec?.name)) {
      const result = await next()
      if (result?.isError !== true) observeNativeDelegation(exec)
      return result
    }
    let decision
    try {
      decision = decide(exec)
    } catch (error) {
      notice(error)
      return next()
    }
    if (decision.action !== "intercept") return next()
    try {
      const result = interruptResult(exec, decision)
      if (decision.phase === "guide") markGuided(exec)
      return result
    } catch (error) {
      notice(error)
      return next()
    }
  }

  /**
   * 记录最近一次健康派发，并在"新工作交付"时递增派发世代。
   * 纯重入等待（判定链命中 reused、无新投递）不触发，避免过度拦截。
   */
  const noteDispatch = (exec, card) => {
    try {
      const agent = exec?.agent
      if (!agent || typeof agent !== "object") return null
      if (!hasNewDelivery(card)) return null
      const state = stateFor(agent)
      state.epoch += 1
      state.lastDispatch = { task: typeof card?.task === "string" && card.task ? card.task : null, at: now() }
      return state
    } catch (error) {
      notice(error)
      return null
    }
  }

  /** 回合边界（turn/start、turn/end）清空该会话全部确认状态：新回合重新引导一次。 */
  const clearTurn = (sessionId) => {
    try {
      if (typeof sessionId !== "string" || !sessionId) return
      const agent = bySessionId.get(sessionId)
      if (!agent) return
      byAgent.delete(agent)
      bySessionId.delete(sessionId)
    } catch (error) {
      notice(error)
    }
  }

  return { aroundExecute, noteDispatch, clearTurn }
}
