import {
  DomainError,
  assertDigest,
  assertIdentifier,
  assertNonEmptyString,
  assertStringList,
  assertTaskState,
  assertTimestamp,
} from "./invariants.mjs"
import { normalizeStagePlan } from "./stage-plan.mjs"
import { createWorkGraph } from "./work-graph.mjs"

const stageRunTransitions = new Map([
  ["planned", new Set(["dispatching"])],
  ["dispatching", new Set(["waiting-reports", "in-doubt"])],
  ["in-doubt", new Set(["dispatching", "waiting-reports"])],
  ["waiting-reports", new Set(["reviewing"])],
  ["reviewing", new Set(["ready-to-advance"])],
])

function prepare(state, fact) {
  if (!state || typeof state !== "object" || state.runtimeMajor !== 2) {
    throw new DomainError("STATE_INVALID", "task state is not a Runtime v2 aggregate")
  }
  if (!Number.isInteger(fact?.expectedRevision) || fact.expectedRevision !== state.revision) {
    throw new DomainError("REVISION_CONFLICT", "fact does not target the current task revision")
  }
  assertTimestamp(fact.occurredAt, "fact.occurredAt")
  return structuredClone(state)
}

function finish(next, fact, effects = []) {
  next.revision += 1
  next.updatedAt = fact.occurredAt
  return { state: assertTaskState(next), effects }
}

function transitionStageRun(next, fact) {
  const allowed = stageRunTransitions.get(next.currentStageRun.status)
  if (!allowed?.has(fact.status)) {
    throw new DomainError(
      "STAGE_RUN_TRANSITION_INVALID",
      `cannot move a stage run from ${next.currentStageRun.status} to ${fact.status}`,
    )
  }
  next.currentStageRun.status = fact.status
  if (fact.status === "dispatching" && next.status === "needs-plan") next.status = "working"
}

function advanceStage(next, fact) {
  if (next.currentStageRun.status !== "ready-to-advance") {
    throw new DomainError("STAGE_NOT_READY", "the current stage run is not ready to advance")
  }
  const currentStage = next.currentStageRun.stage
  const legal = next.scope.edges.some((edge) => edge.from === currentStage && edge.to === fact.to)
  if (!legal) {
    throw new DomainError("STAGE_EDGE_INVALID", `workflow scope does not allow ${currentStage} -> ${fact.to}`)
  }
  const nextStageRunId = assertIdentifier(fact.nextStageRunId, "fact.nextStageRunId")
  if (next.stageRuns.some((run) => run.stageRunId === nextStageRunId) || next.currentStageRun.stageRunId === nextStageRunId) {
    throw new DomainError("STAGE_RUN_DUPLICATE", `stage run ${nextStageRunId} already exists`)
  }
  next.stageRuns.push({ ...next.currentStageRun, status: "completed", completedAt: fact.occurredAt })
  next.currentStageRun = {
    stageRunId: nextStageRunId,
    sequence: next.currentStageRun.sequence + 1,
    round: fact.to === currentStage ? next.currentStageRun.round + 1 : 1,
    stage: fact.to,
    status: "planned",
  }
  next.stagePlan = null
  next.workGraph = { assignments: [] }
}

function normalizeCostLedger(ledger) {
  const fields = ["forecastMin", "forecastMax", "accrued", "uncertain", "nextWave", "automaticLimit"]
  if (!ledger || fields.some((field) => !Number.isFinite(ledger[field]) || ledger[field] < 0)) {
    throw new DomainError("COST_LEDGER_INVALID", "cost ledger values must be non-negative finite numbers")
  }
  if (ledger.forecastMin > ledger.forecastMax) {
    throw new DomainError("COST_LEDGER_INVALID", "forecastMin cannot exceed forecastMax")
  }
  return Object.fromEntries(fields.map((field) => [field, ledger[field]]))
}

function freezeStagePlan(next, fact) {
  if (next.currentStageRun.status !== "planned" || next.stagePlan !== null) {
    throw new DomainError("STAGE_PLAN_ALREADY_FROZEN", "the current stage run already has an active plan")
  }
  const plan = normalizeStagePlan(fact.plan, next.currentStageRun.stageRunId)
  next.stagePlan = { ...plan, assignments: plan.assignments.map(({ assignmentId }) => assignmentId) }
  next.workGraph = createWorkGraph(plan.assignments)
  next.costLedger = normalizeCostLedger(fact.costLedger)
}

function startAssignmentAttempt(next, fact) {
  if (fact.stageRunId !== next.currentStageRun.stageRunId) {
    throw new DomainError("ASSIGNMENT_STAGE_STALE", "assignment attempt does not target the current stage run")
  }
  const assignment = next.workGraph.assignments.find(({ assignmentId }) => assignmentId === fact.assignmentId)
  if (!assignment) {
    throw new DomainError("ASSIGNMENT_UNKNOWN", `unknown assignment: ${fact.assignmentId}`)
  }
  if (!["planned", "rework", "lost", "blocked"].includes(assignment.status)) {
    throw new DomainError("ASSIGNMENT_NOT_RETRYABLE", `assignment ${fact.assignmentId} cannot start another attempt`)
  }
  const expectedAttempt = assignment.attempts.length + 1
  if (!Number.isInteger(fact.attempt) || fact.attempt !== expectedAttempt) {
    throw new DomainError("ASSIGNMENT_ATTEMPT_INVALID", `next assignment attempt must be ${expectedAttempt}`)
  }
  const attemptId = assertIdentifier(fact.attemptId, "fact.attemptId")
  const duplicate = next.workGraph.assignments.some(({ attempts }) => attempts.some((attempt) => attempt.attemptId === attemptId))
  if (duplicate) throw new DomainError("ASSIGNMENT_ATTEMPT_DUPLICATE", `attempt ${attemptId} already exists`)
  assignment.status = "effect-pending"
  assignment.attempts.push({
    attemptId,
    attempt: fact.attempt,
    stageRunId: fact.stageRunId,
    status: "effect-pending",
    startedAt: fact.occurredAt,
  })
}

function assertProjectPath(value, label) {
  if (typeof value !== "string" || value === "" || value.startsWith("/") || value.includes("\\") || value.includes("\0")) {
    throw new DomainError("ARTIFACT_PATH_INVALID", `${label} must be a relative project path`)
  }
  if (value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new DomainError("ARTIFACT_PATH_INVALID", `${label} contains an unsafe path segment`)
  }
  return value
}

function recordArtifact(next, fact) {
  const artifact = fact.artifact
  const artifactId = assertIdentifier(artifact?.artifactId, "artifact.artifactId")
  const normalized = {
    artifactId,
    kind: assertNonEmptyString(artifact.kind, "artifact.kind"),
    path: assertProjectPath(artifact.path, "artifact.path"),
    digest: assertDigest(artifact.digest, "artifact.digest"),
    stageRunId: artifact.stageRunId,
    recordedAt: fact.occurredAt,
  }
  if (normalized.stageRunId !== next.currentStageRun.stageRunId) {
    throw new DomainError("ARTIFACT_STAGE_STALE", "artifact does not belong to the current stage run")
  }
  const index = next.artifacts.findIndex((entry) => entry.artifactId === artifactId)
  if (index === -1) {
    next.artifacts.push(normalized)
    return
  }
  const previous = next.artifacts[index]
  if (previous.kind !== normalized.kind || previous.path !== normalized.path) {
    throw new DomainError("ARTIFACT_IDENTITY_CHANGED", "an artifact id cannot be rebound to another kind or path")
  }
  next.artifacts[index] = normalized
  if (previous.digest === normalized.digest) return
  for (const evidence of next.evidence) {
    if (!evidence.valid || evidence.artifactDigests?.[artifactId] !== previous.digest) continue
    evidence.valid = false
    evidence.invalidation = {
      reason: "artifact-changed",
      artifactId,
      invalidatedAt: fact.occurredAt,
    }
  }
}

const EVIDENCE_KINDS = new Set([
  "artifact-digest",
  "platform-check",
  "spec-provider",
  "human-decision",
  "external-fact",
  "member-assertion",
])

function recordEvidence(next, fact) {
  const evidence = fact.evidence
  const evidenceId = assertIdentifier(evidence?.evidenceId, "evidence.evidenceId")
  if (next.evidence.some((entry) => entry.evidenceId === evidenceId)) {
    throw new DomainError("EVIDENCE_DUPLICATE", `evidence ${evidenceId} already exists`)
  }
  if (!EVIDENCE_KINDS.has(evidence.kind)) {
    throw new DomainError("EVIDENCE_INVALID", `unsupported evidence kind: ${evidence.kind}`)
  }
  if (evidence.stageRunId !== next.currentStageRun.stageRunId) {
    throw new DomainError("EVIDENCE_STAGE_STALE", "evidence does not belong to the current stage run")
  }
  if (!["pass", "fail", "unknown"].includes(evidence.result)) {
    throw new DomainError("EVIDENCE_INVALID", "evidence result must be pass, fail, or unknown")
  }
  const artifactRefs = assertStringList(evidence.artifactRefs ?? [], "evidence.artifactRefs")
  if (evidence.kind === "artifact-digest" && artifactRefs.length === 0) {
    throw new DomainError("EVIDENCE_INVALID", "artifact-digest evidence must reference an artifact")
  }
  const artifactDigests = {}
  for (const artifactId of artifactRefs) {
    const artifact = next.artifacts.find((entry) => entry.artifactId === artifactId)
    if (!artifact) throw new DomainError("EVIDENCE_ARTIFACT_UNKNOWN", `unknown artifact: ${artifactId}`)
    artifactDigests[artifactId] = artifact.digest
  }
  next.evidence.push({
    evidenceId,
    kind: evidence.kind,
    sourceRef: assertNonEmptyString(evidence.sourceRef, "evidence.sourceRef"),
    artifactRefs,
    artifactDigests,
    result: evidence.result,
    ...(evidence.digest ? { digest: assertDigest(evidence.digest, "evidence.digest") } : {}),
    stageRunId: evidence.stageRunId,
    observedAt: fact.occurredAt,
    valid: true,
  })
}

function completeTask(next, fact) {
  if (next.currentStageRun.status !== "ready-to-advance") {
    throw new DomainError("STAGE_NOT_READY", "the current stage run is not ready to complete")
  }
  if (!next.scope.completionStages.includes(next.currentStageRun.stage)) {
    throw new DomainError("COMPLETION_NOT_REACHED", "the current stage is not a scoped completion stage")
  }
  next.status = "completed"
  next.currentStageRun.status = "completed"
  next.currentStageRun.completedAt = fact.occurredAt
}

function reopenStage(next, fact) {
  if (!["reviewing", "ready-to-advance"].includes(next.currentStageRun.status)) {
    throw new DomainError("STAGE_REWORK_INVALID", "only a reviewed stage run can enter rework")
  }
  const nextStageRunId = assertIdentifier(fact.nextStageRunId, "fact.nextStageRunId")
  const reason = assertNonEmptyString(fact.reason, "fact.reason")
  if (next.stageRuns.some((run) => run.stageRunId === nextStageRunId) || next.currentStageRun.stageRunId === nextStageRunId) {
    throw new DomainError("STAGE_RUN_DUPLICATE", `stage run ${nextStageRunId} already exists`)
  }
  const previous = next.currentStageRun
  next.stageRuns.push({ ...previous, status: "rework", reason, completedAt: fact.occurredAt })
  next.currentStageRun = {
    stageRunId: nextStageRunId,
    sequence: previous.sequence + 1,
    round: previous.round + 1,
    stage: previous.stage,
    status: "planned",
  }
  next.stagePlan = null
  next.workGraph = { assignments: [] }
}

export function reduceTask(state, fact) {
  const next = prepare(state, fact)
  switch (fact.type) {
    case "stage-run.transitioned":
      transitionStageRun(next, fact)
      return finish(next, fact)
    case "stage.advanced":
      advanceStage(next, fact)
      return finish(next, fact)
    case "stage-plan.frozen":
      freezeStagePlan(next, fact)
      return finish(next, fact)
    case "assignment.attempt-started":
      startAssignmentAttempt(next, fact)
      return finish(next, fact)
    case "artifact.recorded":
      recordArtifact(next, fact)
      return finish(next, fact)
    case "evidence.recorded":
      recordEvidence(next, fact)
      return finish(next, fact)
    case "task.completed":
      completeTask(next, fact)
      return finish(next, fact)
    case "stage.reopened":
      reopenStage(next, fact)
      return finish(next, fact)
    default:
      throw new DomainError("FACT_UNSUPPORTED", `unsupported task fact: ${fact.type}`)
  }
}
