import { createHash } from "node:crypto"

import { validateContract } from "../contracts.mjs"
import { assertTaskState } from "../domain/invariants.mjs"

const MAX_VISIBLE_CODE_POINTS = 2_000
const ACTION_REASONS = new Set([
  "needs-plan",
  "stable",
  "waiting-report",
  "settling-idle",
  "wait-budget-exhausted",
  "budget-decision",
  "awaiting-user",
  "blocked",
  "completed",
  "cancelled",
  "in-doubt",
])

function codePointLength(value) {
  return Array.from(value).length
}

export function visibleCodePointLength(value) {
  if (typeof value === "string") return codePointLength(value)
  if (Array.isArray(value)) return value.reduce((total, item) => total + visibleCodePointLength(item), 0)
  if (!value || typeof value !== "object") return 0
  return Object.values(value).reduce((total, item) => total + visibleCodePointLength(item), 0)
}

function assertReason(reason) {
  if (!ACTION_REASONS.has(reason)) {
    throw new TypeError(`action card reason is not supported: ${reason}`)
  }
  return reason
}

function stageFor(state, definition) {
  validateContract("https://team-work-runtime.dev/schemas/v2/workflow-policy", definition, "workflow definition")
  if (
    definition.workflowId !== state.workflow.workflowId
    || definition.version !== state.workflow.version
  ) throw new TypeError("workflow definition does not match the task")
  const stage = definition.stages.find(({ id }) => id === state.currentStageRun.stage)
  if (!stage) throw new TypeError("workflow definition does not declare the current task stage")
  return stage
}

function normalizeChoices(choices) {
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new TypeError("decision choices must contain at least one choice")
  }
  return choices.map((choice) => {
    if (typeof choice === "string" && choice !== "") return { value: choice, label: choice }
    if (!choice || typeof choice !== "object" || typeof choice.value !== "string" || choice.value === "" || typeof choice.label !== "string" || choice.label === "") {
      throw new TypeError("each decision choice needs a value and label")
    }
    if (choice.impact !== undefined && (typeof choice.impact !== "string" || choice.impact === "")) {
      throw new TypeError("decision choice impact must be a non-empty string")
    }
    if (choice.relativeCost !== undefined && (!Number.isFinite(choice.relativeCost) || choice.relativeCost < 0)) {
      throw new TypeError("decision choice relativeCost must be a non-negative number")
    }
    return {
      value: choice.value,
      label: choice.label,
      ...(choice.impact === undefined ? {} : { impact: choice.impact }),
      ...(choice.relativeCost === undefined ? {} : { relativeCost: choice.relativeCost }),
    }
  })
}

function normalizeDecision(decision) {
  if (decision === undefined) return undefined
  if (!decision || typeof decision !== "object") throw new TypeError("decision must be an object")
  if (typeof decision.question !== "string" || decision.question === "") {
    throw new TypeError("decision question must be a non-empty string")
  }
  const choices = normalizeChoices(decision.choices)
  if (decision.summary !== undefined && (typeof decision.summary !== "string" || decision.summary === "")) {
    throw new TypeError("decision summary must be a non-empty string")
  }
  if (decision.packetRef !== undefined && (typeof decision.packetRef !== "string" || decision.packetRef === "" || decision.packetRef.startsWith("/"))) {
    throw new TypeError("decision packetRef must be a relative project path")
  }
  if ((decision.summary === undefined) !== (decision.packetRef === undefined)) {
    throw new TypeError("decision summary and packetRef must be supplied together")
  }
  if (decision.disagreement !== undefined && (typeof decision.disagreement !== "string" || decision.disagreement === "")) {
    throw new TypeError("decision disagreement must be a non-empty string")
  }
  return {
    question: decision.question,
    choices,
    ...(decision.summary === undefined ? {} : { summary: decision.summary, packetRef: decision.packetRef }),
    ...(decision.disagreement === undefined ? {} : { disagreement: decision.disagreement }),
  }
}

function pendingDecision(state) {
  const pending = state.pendingDecision
  if (!pending) return undefined
  return {
    question: pending.question,
    choices: normalizeChoices(pending.choices),
  }
}

function nextAction({ reason, decision }) {
  if (decision) return { kind: "steer", question: decision.question, choices: decision.choices }
  if (reason === "needs-plan") return { kind: "plan", instruction: "说明目标、约束和偏好。" }
  if (["waiting-report", "settling-idle", "wait-budget-exhausted", "in-doubt"].includes(reason)) {
    return { kind: "wait", instruction: "当前工作仍在推进；收到新的进展后再继续。" }
  }
  if (reason === "budget-decision") return { kind: "wait", instruction: "需要先确认下一步投入后才能继续。" }
  if (["blocked", "completed", "cancelled"].includes(reason)) return { kind: "none" }
  return { kind: "run", instruction: "继续推进当前阶段。" }
}

function reportFor(state, stage, reason, decision) {
  const completedStages = state.stageRuns.filter(({ status }) => status === "completed")
  const artifacts = state.artifacts.slice(-5).map(({ kind, path }) => ({ label: kind, path, kind }))
  const conclusions = [
    ...(completedStages.length > 0 ? [`已完成 ${completedStages.length} 个阶段。`] : []),
    ...(artifacts.length > 0 ? [`已登记 ${artifacts.length} 项关键产物。`] : []),
    ...(state.acceptedReportRefs.length > 0 ? ["已有交付结论完成复核。"] : []),
  ].slice(0, 3)
  const risks = [
    ...(reason === "blocked" ? ["当前工作受阻，需要处理后才能继续。"] : []),
    ...(reason === "in-doubt" ? ["外部执行状态仍待确认。"] : []),
    ...(decision ? ["等待人工选择。"] : []),
  ].slice(0, 3)
  const assignments = state.workGraph.assignments
  const deliveryOwners = assignments.filter(({ teamRole, writableRefs }) => teamRole === "owner" && writableRefs.length > 0)
  const challengers = assignments.filter(({ teamRole }) => teamRole === "challenger")
  const team = assignments.length === 0 ? undefined : {
    mode: state.stagePlan?.teamMode ?? (deliveryOwners.length > 1 ? "team" : "solo"),
    owners: deliveryOwners.length,
    challengerTier: challengers.some(({ costTier }) => costTier === "expert") ? "expert" : "senior",
    expert: assignments.some(({ teamRole }) => teamRole === "expert"),
    cost: {
      forecastMin: state.costLedger.forecastMin,
      forecastMax: state.costLedger.forecastMax,
      accrued: state.costLedger.accrued,
      nextWave: state.costLedger.nextWave,
      automaticLimit: state.costLedger.automaticLimit,
    },
  }
  return {
    completed: completedStages.length === 0 ? [] : [`已完成 ${completedStages.length} 个阶段。`],
    current: `当前处于${stage.label}。`,
    conclusions,
    artifacts,
    risks,
    ...(decision?.disagreement === undefined ? {} : { disagreement: decision.disagreement }),
    ...(team === undefined ? {} : { team }),
  }
}

function cardId(input) {
  const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 24)
  return `action-card-${digest}`
}

function budgetProblem() {
  const problem = {
    code: "CONTEXT_BUDGET_EXCEEDED",
    message: "当前工作摘要无法在安全的上下文预算内呈现。",
    impact: "请先提供可引用的简短决策或制品摘要，再继续推进。",
    next: { kind: "none", reason: "需要缩短当前工作视图。" },
  }
  return validateContract("https://team-work-runtime.dev/schemas/v2/runtime-card", problem, "problem card")
}

function reduceOptionalContent(card) {
  const compact = structuredClone(card)
  compact.report.completed = []
  compact.report.conclusions = []
  compact.report.risks = []
  delete compact.report.team
  while (compact.report.artifacts.length > 1 && visibleCodePointLength(compact) > MAX_VISIBLE_CODE_POINTS) {
    compact.report.artifacts.shift()
  }
  return compact
}

export function composeActionCard({ taskState, workflowDefinition, reason, decision } = {}) {
  const state = assertTaskState(taskState)
  const stableReason = assertReason(reason)
  const stage = stageFor(state, workflowDefinition)
  const selectedDecision = normalizeDecision(decision)
  const activeDecision = selectedDecision ?? pendingDecision(state)
  const card = {
    cardId: cardId({ taskState: state, reason: stableReason, decision: selectedDecision }),
    task: {
      id: state.taskId,
      title: state.title,
      stage: stage.id,
      stageLabel: stage.label,
      status: state.status,
    },
    report: reportFor(state, stage, stableReason, activeDecision),
    ...(selectedDecision?.summary === undefined ? {} : {
      decision: { summary: selectedDecision.summary, packetRef: selectedDecision.packetRef },
    }),
    next: nextAction({ reason: stableReason, decision: activeDecision }),
  }
  const compact = visibleCodePointLength(card) > MAX_VISIBLE_CODE_POINTS ? reduceOptionalContent(card) : card
  if (visibleCodePointLength(compact) > MAX_VISIBLE_CODE_POINTS) return budgetProblem()
  return validateContract("https://team-work-runtime.dev/schemas/v2/runtime-card", compact, "action card")
}
