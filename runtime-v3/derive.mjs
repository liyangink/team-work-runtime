// derive.mjs — 任务目录数据 → 当前状态（纯函数，P1：目录即状态）
// 输入是已解析的目录文件（加载见 store.mjs/CLI）；本模块不做 I/O。
// 推导链：scope + journal 尾部 → 当前阶段；reports → 波次；gate → 门；decisions → 人工门。

import { nextWave, scenePolicy } from "./waves.mjs"
import { gateCheck } from "./gate.mjs"

const state2Packages = (packages) => (Array.isArray(packages) ? packages : null)

export function deriveTask({ scope, intent, artifacts, reports, decisions, journal, workflow, policy, packages = null }) {
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
  const wave = nextWave({ scenePolicy: sp, reports: stageReports, extraRounds, packages: state2Packages(packages) })

  // 人工门 rework：用户要求返工 → 在新一轮 Owner 交付之前，波次覆盖为 respond
  const humanRework = decisions.filter((d) => d.choice === "rework" && d.gateId).at(-1)
  const deliveredAfter = stageReports.some((r) => r.role === "owner" && r.at > (humanRework?.at ?? ""))

  if (wave.kind === "gate") {
    if (humanRework && !deliveredAfter) {
      // 人工门 rework：新一轮 Owner 回应（多包 = 全部活跃包重修）
      const owners = (Array.isArray(packages) && packages.length ? packages.map((p) => p.id) : [null]).map((id) => ({
        package: id,
        round: stageReports.filter((r) => r.role === "owner" && (r.package ?? null) === id).length + 1,
        continuation: true,
      }))
      return {
        stage: stageId,
        status: "working",
        wave,
        gate: null,
        next: { kind: "dispatch", wave: { kind: "respond", role: "owner", round: Math.max(...owners.map((o) => o.round)), owners } },
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

  // 在途检查（复核修复 + v3.2 批次化）：最后一个 dispatched 起向前连续 dispatched = 派发批次
  // （批次成员的 report-accepted 可能穿插在批次之后，故从最后 dispatched 定位）；
  // 批次中任一尚无报告 = 波仍在执行（组合评审等齐语义），不重复派发。
  const batch = []
  const lastIdx = journal.map((e) => e.type).lastIndexOf("dispatched")
  for (let i = lastIdx; i >= 0 && journal[i].type === "dispatched"; i -= 1) batch.unshift(journal[i].detail)
  const inflight = batch.filter((d) => !reports.some((r) => r.dispatchKey === d.key))
  // 批次未清空一律等待：组合评审必须等齐当轮全部交付（部分交付不提前进评审/裁决）
  if (inflight.length) {
    return { stage: stageId, status: "working", wave, gate: null, next: { kind: "wait-inflight", dispatchKey: inflight[0].key, wave } }
  }

  return { stage: stageId, status: "working", wave, gate: null, next: { kind: "dispatch", wave } }
}
