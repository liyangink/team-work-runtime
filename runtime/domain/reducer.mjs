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
import { digestEffect } from "./digests.mjs"

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
  const effect = structuredClone(fact.effect)
  const operationId = assertIdentifier(effect?.operationId, "fact.effect.operationId")
  const effectDigest = assertDigest(effect?.effectDigest, "fact.effect.effectDigest")
  if (
    effect.taskId !== next.taskId
    || effect.stageRunId !== fact.stageRunId
    || effect.assignmentId !== fact.assignmentId
    || effect.attempt !== fact.attempt
    || effect.role !== assignment.teamRole
    || effect.assignmentKind !== assignment.assignmentKind
    || effect.mode !== "background"
  ) {
    throw new DomainError("DISPATCH_EFFECT_MISMATCH", "dispatch effect does not match its assignment attempt")
  }
  if (digestEffect(effect) !== effectDigest) {
    throw new DomainError("DISPATCH_EFFECT_DIGEST_MISMATCH", "dispatch effect digest does not match its immutable intent")
  }
  const duplicate = next.workGraph.assignments.some(({ attempts }) => attempts.some((attempt) => attempt.attemptId === attemptId))
  if (duplicate) throw new DomainError("ASSIGNMENT_ATTEMPT_DUPLICATE", `attempt ${attemptId} already exists`)
  if (next.pendingOperations.some((operation) => operation.operationId === operationId)) {
    throw new DomainError("OPERATION_DUPLICATE", `operation ${operationId} already exists`)
  }
  assignment.status = "effect-pending"
  if (next.status === "needs-plan") next.status = "working"
  if (next.currentStageRun.status === "planned") next.currentStageRun.status = "dispatching"
  assignment.attempts.push({
    attemptId,
    attempt: fact.attempt,
    stageRunId: fact.stageRunId,
    status: "effect-pending",
    startedAt: fact.occurredAt,
    correctionCount: 0,
    operationId,
    effectDigest,
  })
  next.pendingOperations.push({
    operationId,
    kind: "execution.ensure",
    purpose: "dispatch",
    assignmentId: assignment.assignmentId,
    attemptId,
    effectDigest,
    status: "intent-persisted",
    invocationCount: 0,
    intent: effect,
    createdAt: fact.occurredAt,
  })
}

function findPendingOperation(next, fact, expectedKind) {
  const operationId = assertIdentifier(fact.operationId, "fact.operationId")
  const operation = next.pendingOperations.find((entry) => entry.operationId === operationId)
  if (!operation || (expectedKind && operation.kind !== expectedKind)) {
    throw new DomainError("OPERATION_UNKNOWN", `unknown ${expectedKind ?? "external"} operation: ${operationId}`)
  }
  const assignment = next.workGraph.assignments.find((entry) => entry.assignmentId === operation.assignmentId)
  const attempt = assignment?.attempts.find((entry) => entry.attemptId === operation.attemptId)
  if (
    !assignment
    || !attempt
    || (operation.kind === "execution.ensure" && operation.purpose === "dispatch" && attempt.operationId !== operation.operationId)
  ) {
    throw new DomainError("OPERATION_BINDING_INVALID", "execution operation has no matching assignment attempt")
  }
  return { operation, assignment, attempt }
}

function requestExecutionStop(next, fact) {
  const assignment = next.workGraph.assignments.find((entry) => entry.assignmentId === fact.assignmentId)
  const attempt = assignment?.attempts.find((entry) => entry.attemptId === fact.attemptId)
  if (!assignment || !attempt || attempt.status !== "running") {
    throw new DomainError("STOP_TARGET_INVALID", "stop intent must target a running assignment attempt")
  }
  const intent = structuredClone(fact.intent)
  const operationId = assertIdentifier(intent?.operationId, "fact.intent.operationId")
  const effectDigest = assertDigest(intent?.effectDigest, "fact.intent.effectDigest")
  if (intent.executionRef !== attempt.executionRef || digestEffect(intent) !== effectDigest) {
    throw new DomainError("STOP_EFFECT_MISMATCH", "stop intent does not match the running execution")
  }
  if (next.pendingOperations.some((operation) => operation.operationId === operationId)) {
    throw new DomainError("OPERATION_DUPLICATE", `operation ${operationId} already exists`)
  }
  next.pendingOperations.push({
    operationId,
    kind: "execution.stop",
    purpose: "stop",
    assignmentId: assignment.assignmentId,
    attemptId: attempt.attemptId,
    effectDigest,
    status: "intent-persisted",
    invocationCount: 0,
    intent,
    createdAt: fact.occurredAt,
  })
}

function requestExecutionContinuation(next, fact) {
  const assignment = next.workGraph.assignments.find((entry) => entry.assignmentId === fact.assignmentId)
  const attempt = assignment?.attempts.find((entry) => entry.attemptId === fact.attemptId)
  if (!assignment || !attempt || attempt.status !== "running" || !attempt.idleObservedAt) {
    throw new DomainError("CONTINUATION_TARGET_INVALID", "continuation must target an idle running assignment attempt")
  }
  const intent = structuredClone(fact.intent)
  const operationId = assertIdentifier(intent?.operationId, "fact.intent.operationId")
  const effectDigest = assertDigest(intent?.effectDigest, "fact.intent.effectDigest")
  if (
    intent.taskId !== next.taskId
    || intent.stageRunId !== next.currentStageRun.stageRunId
    || intent.assignmentId !== assignment.assignmentId
    || intent.attempt !== attempt.attempt
    || intent.resumeExecutionRef !== attempt.executionRef
    || digestEffect(intent) !== effectDigest
  ) {
    throw new DomainError("CONTINUATION_EFFECT_MISMATCH", "continuation effect does not match its running assignment")
  }
  if (next.pendingOperations.some((operation) => operation.operationId === operationId)) {
    throw new DomainError("OPERATION_DUPLICATE", `operation ${operationId} already exists`)
  }
  next.pendingOperations.push({
    operationId,
    kind: "execution.ensure",
    purpose: "continuation",
    assignmentId: assignment.assignmentId,
    attemptId: attempt.attemptId,
    effectDigest,
    status: "intent-persisted",
    invocationCount: 0,
    intent,
    createdAt: fact.occurredAt,
  })
}

function exhaustIdleCorrection(next, fact) {
  const assignment = next.workGraph.assignments.find((entry) => entry.assignmentId === fact.assignmentId)
  const attempt = assignment?.attempts.find((entry) => entry.attemptId === fact.attemptId)
  if (!assignment || !attempt || attempt.status !== "running" || !attempt.idleObservedAt) {
    throw new DomainError("IDLE_EXHAUSTED_INVALID", "idle correction exhaustion must target an idle running attempt")
  }
  assignment.status = "blocked"
  attempt.status = "blocked"
  attempt.completedAt = fact.occurredAt
  next.status = "blocked"
}

function startEffectInvocation(next, fact) {
  const { operation, assignment, attempt } = findPendingOperation(next, fact)
  if (operation.status !== "intent-persisted") {
    throw new DomainError("EFFECT_INVOCATION_INVALID", "only a persisted effect intent can begin an invocation")
  }
  if (operation.kind === "execution.ensure" && operation.purpose === "dispatch" && attempt.status !== "effect-pending") {
    throw new DomainError("EFFECT_INVOCATION_INVALID", "dispatch effect must target an effect-pending attempt")
  }
  if (operation.kind === "execution.ensure" && operation.purpose === "continuation" && attempt.status !== "running") {
    throw new DomainError("EFFECT_INVOCATION_INVALID", "continuation effect must target a running attempt")
  }
  if (operation.kind === "execution.stop" && attempt.status !== "running") {
    throw new DomainError("EFFECT_INVOCATION_INVALID", "stop effect must target a running attempt")
  }
  operation.status = "in-doubt"
  operation.invocationCount += 1
  operation.invocationId = assertIdentifier(fact.invocationId, "fact.invocationId")
  operation.leaseExpiresAt = assertTimestamp(fact.leaseExpiresAt, "fact.leaseExpiresAt")
  if (Date.parse(operation.leaseExpiresAt) < Date.parse(fact.occurredAt)) {
    throw new DomainError("EFFECT_LEASE_INVALID", "effect invocation lease cannot expire before it starts")
  }
  delete operation.lastError
  if (operation.kind === "execution.ensure" && operation.purpose === "dispatch") {
    assignment.status = "in-doubt"
    attempt.status = "in-doubt"
  }
}

function validateReceipt(operation, receipt) {
  if (
    receipt?.operationId !== operation.operationId
    || receipt.effectDigest !== operation.effectDigest
  ) {
    throw new DomainError("EFFECT_RECEIPT_MISMATCH", "effect receipt does not match its persisted intent")
  }
}

function confirmEffect(next, fact) {
  const { operation, assignment, attempt } = findPendingOperation(next, fact, "execution.ensure")
  validateReceipt(operation, fact.receipt)
  if (fact.receipt.status !== "confirmed" || typeof fact.receipt.executionRef !== "string" || fact.receipt.executionRef === "") {
    throw new DomainError("EFFECT_RECEIPT_INVALID", "a running assignment requires a confirmed execution receipt")
  }
  assignment.status = "running"
  attempt.status = "running"
  if (operation.purpose === "dispatch") {
    attempt.receiptRef = operation.operationId
    attempt.executionRef = fact.receipt.executionRef
  } else {
    if (fact.receipt.executionRef !== attempt.executionRef) {
      throw new DomainError("CONTINUATION_RECEIPT_INVALID", "continuation must resume the bound execution")
    }
    attempt.correctionCount += 1
    attempt.lastCorrectionAt = fact.occurredAt
    delete attempt.idleObservedAt
  }
  next.pendingOperations = next.pendingOperations.filter((entry) => entry.operationId !== operation.operationId)
  if (next.status === "needs-plan") next.status = "working"
}

function scheduleEffectRetry(next, fact) {
  const { operation, assignment, attempt } = findPendingOperation(next, fact)
  validateReceipt(operation, fact.receipt)
  if (operation.status !== "in-doubt" || fact.receipt.status !== "failed" || fact.receipt.error?.retryable !== true) {
    throw new DomainError("EFFECT_RETRY_INVALID", "only a retryable failed invocation can be scheduled again")
  }
  operation.status = "intent-persisted"
  operation.lastError = structuredClone(fact.receipt.error)
  delete operation.invocationId
  delete operation.leaseExpiresAt
  if (operation.purpose === "dispatch") {
    assignment.status = "effect-pending"
    attempt.status = "effect-pending"
  }
}

function failEffect(next, fact) {
  const { operation, assignment, attempt } = findPendingOperation(next, fact, "execution.ensure")
  validateReceipt(operation, fact.receipt)
  if (fact.receipt.status !== "failed") {
    throw new DomainError("EFFECT_FAILURE_INVALID", "only a failed receipt can block an execution effect")
  }
  assignment.status = "blocked"
  attempt.status = "blocked"
  attempt.receiptRef = operation.operationId
  attempt.completedAt = fact.occurredAt
  next.pendingOperations = next.pendingOperations.filter((entry) => entry.operationId !== operation.operationId)
  next.status = "blocked"
}

function confirmStop(next, fact) {
  const { operation, assignment, attempt } = findPendingOperation(next, fact, "execution.stop")
  validateReceipt(operation, fact.receipt)
  if (fact.receipt.status !== "confirmed" || fact.receipt.executionRef !== attempt.executionRef) {
    throw new DomainError("STOP_RECEIPT_INVALID", "confirmed stop receipt does not match the running execution")
  }
  assignment.status = "blocked"
  attempt.status = "blocked"
  attempt.completedAt = fact.occurredAt
  next.pendingOperations = next.pendingOperations.filter((entry) => entry.operationId !== operation.operationId)
  next.status = "blocked"
}

function failStop(next, fact) {
  const { operation } = findPendingOperation(next, fact, "execution.stop")
  validateReceipt(operation, fact.receipt)
  if (fact.receipt.status !== "failed") throw new DomainError("STOP_RECEIPT_INVALID", "stop failure requires a failed receipt")
  next.pendingOperations = next.pendingOperations.filter((entry) => entry.operationId !== operation.operationId)
  next.status = "blocked"
}

function receiveObservation(next, fact) {
  const item = structuredClone(fact.item)
  assertIdentifier(item?.observationId, "fact.item.observationId")
  assertDigest(item?.digest, "fact.item.digest")
  assertNonEmptyString(item?.dedupeKey, "fact.item.dedupeKey")
  assertTimestamp(item?.receivedAt, "fact.item.receivedAt")
  if (item.sequence !== next.observationInbox.nextSequence) {
    throw new DomainError("OBSERVATION_SEQUENCE_INVALID", "observation must use the next durable inbox sequence")
  }
  if (next.observationInbox.dedupe.some((entry) => entry.dedupeKey === item.dedupeKey)) {
    throw new DomainError("OBSERVATION_DUPLICATE", `observation dedupe key already exists: ${item.dedupeKey}`)
  }
  if (item.assignmentId) {
    const assignment = next.workGraph.assignments.find((entry) => entry.assignmentId === item.assignmentId)
    const attempt = assignment?.attempts.find((entry) => entry.attemptId === item.attemptId)
    if (!assignment || !attempt) throw new DomainError("OBSERVATION_BINDING_INVALID", "observation has no matching assignment attempt")
    if (item.executionRef && attempt.executionRef !== item.executionRef) {
      throw new DomainError("OBSERVATION_BINDING_INVALID", "observation execution does not match its assignment attempt")
    }
    if (item.kind === "member-report" && attempt.status !== "running") {
      throw new DomainError("MEMBER_REPORT_STALE", "member report must target a running assignment attempt")
    }
  }
  next.observationInbox.items.push(item)
  next.observationInbox.dedupe.push({
    dedupeKey: item.dedupeKey,
    observationId: item.observationId,
    sequence: item.sequence,
    digest: item.digest,
    stateRevision: next.revision + 1,
  })
  next.observationInbox.nextSequence += 1
}

function consumeObservation(next, fact) {
  const expected = next.observationInbox.acknowledgedThrough + 1
  if (fact.sequence !== expected) {
    throw new DomainError("OBSERVATION_ACK_INVALID", `next observation acknowledgement must be ${expected}`)
  }
  const item = next.observationInbox.items.find((entry) => entry.sequence === fact.sequence)
  if (!item || item.observationId !== fact.observationId) {
    throw new DomainError("OBSERVATION_ACK_INVALID", "observation acknowledgement does not match the inbox head")
  }
  if (item.kind === "member-report") {
    const assignment = next.workGraph.assignments.find((entry) => entry.assignmentId === item.assignmentId)
    const attempt = assignment?.attempts.find((entry) => entry.attemptId === item.attemptId)
    if (!assignment || !attempt || attempt.status !== "running") {
      throw new DomainError("MEMBER_REPORT_STALE", "member report does not target a running assignment attempt")
    }
    assignment.status = "reported"
    attempt.status = "reported"
    attempt.reportRef = assertIdentifier(fact.reportId, "fact.reportId")
    attempt.reportDigest = assertDigest(item.digest, "fact.item.digest")
    attempt.completedAt = fact.occurredAt
  } else if (["execution-error", "execution-lost"].includes(item.kind)) {
    const assignment = next.workGraph.assignments.find((entry) => entry.assignmentId === item.assignmentId)
    const attempt = assignment?.attempts.find((entry) => entry.attemptId === item.attemptId)
    if (assignment && attempt && ["running", "in-doubt"].includes(attempt.status)) {
      const status = item.kind === "execution-lost" ? "lost" : "blocked"
      assignment.status = status
      attempt.status = status
      attempt.completedAt = fact.occurredAt
      next.status = "blocked"
    }
  } else if (item.kind === "execution-idle") {
    const assignment = next.workGraph.assignments.find((entry) => entry.assignmentId === item.assignmentId)
    const attempt = assignment?.attempts.find((entry) => entry.attemptId === item.attemptId)
    if (assignment && attempt && attempt.status === "running") attempt.idleObservedAt = item.receivedAt
  }
  next.observationInbox.acknowledgedThrough = fact.sequence
  next.observationInbox.items = next.observationInbox.items.filter((entry) => entry.sequence > fact.sequence)
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
    case "execution.stop-requested":
      requestExecutionStop(next, fact)
      return finish(next, fact)
    case "execution.continuation-requested":
      requestExecutionContinuation(next, fact)
      return finish(next, fact)
    case "execution.idle-exhausted":
      exhaustIdleCorrection(next, fact)
      return finish(next, fact)
    case "effect.invocation-started":
      startEffectInvocation(next, fact)
      return finish(next, fact)
    case "effect.confirmed":
      confirmEffect(next, fact)
      return finish(next, fact)
    case "effect.retry-scheduled":
      scheduleEffectRetry(next, fact)
      return finish(next, fact)
    case "effect.failed":
      failEffect(next, fact)
      return finish(next, fact)
    case "effect.stop-confirmed":
      confirmStop(next, fact)
      return finish(next, fact)
    case "effect.stop-failed":
      failStop(next, fact)
      return finish(next, fact)
    case "observation.received":
      receiveObservation(next, fact)
      return finish(next, fact)
    case "observation.consumed":
      consumeObservation(next, fact)
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
