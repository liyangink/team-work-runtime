// derive.mjs — 任务目录数据 → 当前状态（纯函数，P1：目录即状态）
// 输入是已解析的目录文件（加载见 store.mjs/CLI）；本模块不做 I/O。
// 推导链：scope + journal 尾部 → 当前阶段；reports → 波次；gate → 门；decisions → 人工门。

import { nextWave, scenePolicy } from "./waves.mjs"
import { gateCheck } from "./gate.mjs"

export function deriveTask({ scope, intent, artifacts, reports, decisions, journal, workflow, policy }) {
  const completedEvent = journal.find((e) => e.type === "task-completed")
  if (completedEvent) {
    return { stage: completedEvent.detail.stage, status: "completed", wave: { kind: "done" }, gate: null, next: { kind: "none" } }
  }

  const stageId = journal.filter((e) => e.type === "stage-advanced").map((e) => e.detail.to).at(-1) ?? scope.entry
  const stageDef = workflow.stages.find((s) => s.id === stageId)
  if (!stageDef) {
    return { stage: stageId, status: "blocked", wave: null, gate: null, next: { kind: "blocked", reason: `scope.entry ${stageId} 不在 workflow 定义中` } }
  }
  const sp = scenePolicy(policy, stageDef.teamScene)
  const stageReports = reports.filter((r) => r.stage === stageId)
  const extraRounds = decisions.filter((d) => d.grant === "extra-round").length
  const wave = nextWave({ scenePolicy: sp, reports: stageReports, extraRounds })

  // 人工门 rework：用户要求返工 → 在新一轮 Owner 交付之前，波次覆盖为 respond
  const humanRework = decisions.filter((d) => d.choice === "rework" && d.gateId).at(-1)
  const deliveredAfter = stageReports.some((r) => r.role === "owner" && r.at > (humanRework?.at ?? ""))

  if (wave.kind === "gate") {
    if (humanRework && !deliveredAfter) {
      return {
        stage: stageId,
        status: "working",
        wave,
        gate: null,
        next: { kind: "dispatch", wave: { kind: "respond", role: "owner", round: stageReports.filter((r) => r.role === "owner").length + 1 } },
      }
    }
    const gate = gateCheck({ workflow, policy, stageId, scope, artifacts, reports: stageReports, decisions, journal })
    if (gate.passed) {
      const isCompletion = scope.completion?.mode === "through-stage"
        ? scope.completion.stage === stageId
        : (workflow.terminalStages ?? []).includes(stageId)
      return { stage: stageId, status: "working", wave, gate, next: isCompletion ? { kind: "complete" } : { kind: "advance" } }
    }
    const awaiting = gate.blockers.some((b) => b.awaitingUser)
    return {
      stage: stageId,
      status: awaiting ? "awaiting-user" : "working",
      wave,
      gate,
      next: awaiting ? { kind: "await-decision" } : { kind: "dispatch", hint: gate.blockers.map((b) => b.recovery) },
    }
  }

  if (wave.kind === "converge-user") {
    return { stage: stageId, status: "awaiting-user", wave, gate: null, next: { kind: "await-decision", reason: wave.reason } }
  }

  // 在途检查（复核修复）：最后一个 dispatched 事件尚无对应报告时，该波次已在执行——
  // 不重复派发（串行重复 run 与并发 run 同样受此保护），返回等待态。
  const lastDispatched = journal.filter((e) => e.type === "dispatched").at(-1)
  if (
    lastDispatched
    && !reports.some((r) => r.dispatchKey === lastDispatched.detail.key)
    && lastDispatched.detail.role === wave.role
    && lastDispatched.detail.kind === wave.kind
    && lastDispatched.detail.round === wave.round
  ) {
    return { stage: stageId, status: "working", wave, gate: null, next: { kind: "wait-inflight", dispatchKey: lastDispatched.detail.key, wave } }
  }

  return { stage: stageId, status: "working", wave, gate: null, next: { kind: "dispatch", wave } }
}
