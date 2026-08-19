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
import { digestEffect, digestValue } from "./digests.mjs"
import { costWeightForTier } from "../../policy/kernel.mjs"

const stageRunTransitions = new Map([
  ["planned", new Set(["dispatching"])],
  ["dispatching", new Set(["waiting-reports", "in-doubt"])],
  ["in-doubt", new Set(["dispatching", "waiting-reports"])],
  ["waiting-reports", new Set(["reviewing"])],
  ["reviewing", new Set(["ready-to-advance"])],
])
function executionOperationCost(operation, assignment) {
  return operation.kind === "execution.ensure" ? costWeightForTier(assignment.costTier) : 0
}

function releaseUncertainCost(next, operation, assignment) {
  const relativeCost = executionOperationCost(operation, assignment)
  if (relativeCost === 0) return
  if (next.costLedger.uncertain < relativeCost) {
    throw new DomainError("COST_LEDGER_INVALID", "uncertain cost cannot be released below zero")
  }
  next.costLedger.uncertain -= relativeCost
}

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
  next.preflight = null
  next.workGraph = { assignments: [] }
}

function returnStage(next, fact) {
  if (next.currentStageRun.status !== "ready-to-advance") {
    throw new DomainError("STAGE_NOT_READY", "the current stage run is not ready to follow a rework edge")
  }
  const currentStage = next.currentStageRun.stage
  const legal = next.scope.edges.some((edge) => edge.from === currentStage && edge.to === fact.to && edge.outcome === fact.outcome)
  if (!legal || fact.outcome === "pass") {
    throw new DomainError("STAGE_EDGE_INVALID", `workflow scope does not allow ${currentStage} -> ${fact.to} via ${fact.outcome}`)
  }
  const nextStageRunId = assertIdentifier(fact.nextStageRunId, "fact.nextStageRunId")
  if (next.stageRuns.some((run) => run.stageRunId === nextStageRunId) || next.currentStageRun.stageRunId === nextStageRunId) {
    throw new DomainError("STAGE_RUN_DUPLICATE", `stage run ${nextStageRunId} already exists`)
  }
  const reason = assertNonEmptyString(fact.reason, "fact.reason")
  next.stageRuns.push({ ...next.currentStageRun, status: "rework", reason, completedAt: fact.occurredAt })
  next.currentStageRun = {
    stageRunId: nextStageRunId,
    sequence: next.currentStageRun.sequence + 1,
    round: fact.to === currentStage ? next.currentStageRun.round + 1 : 1,
    stage: fact.to,
    status: "planned",
  }
  next.stagePlan = null
  next.preflight = null
  next.workGraph = { assignments: [] }
  next.status = "needs-plan"
}

function skipStage(next, fact) {
  if (
    next.currentStageRun.status !== "planned"
    || next.stagePlan !== null
    || next.preflight !== null
    || next.workGraph.assignments.length > 0
    || next.pendingOperations.length > 0
  ) throw new DomainError("STAGE_SKIP_INVALID", "only a fresh unplanned stage run can be skipped by a compiled route")
  const currentStage = next.currentStageRun.stage
  const legal = next.scope.edges.some((edge) => edge.from === currentStage && edge.to === fact.to && edge.outcome === fact.outcome)
  if (!legal) throw new DomainError("STAGE_EDGE_INVALID", `workflow scope does not allow ${currentStage} -> ${fact.to} via ${fact.outcome}`)
  const nextStageRunId = assertIdentifier(fact.nextStageRunId, "fact.nextStageRunId")
  if (next.stageRuns.some((run) => run.stageRunId === nextStageRunId) || next.currentStageRun.stageRunId === nextStageRunId) {
    throw new DomainError("STAGE_RUN_DUPLICATE", `stage run ${nextStageRunId} already exists`)
  }
  const reason = assertNonEmptyString(fact.reason, "fact.reason")
  next.stageRuns.push({ ...next.currentStageRun, status: "completed", reason, completedAt: fact.occurredAt })
  next.currentStageRun = {
    stageRunId: nextStageRunId,
    sequence: next.currentStageRun.sequence + 1,
    round: 1,
    stage: fact.to,
    status: "planned",
  }
  next.status = "needs-plan"
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

function approveCostBudget(next, fact) {
  if (next.status !== "working" || next.pendingDecision || next.pendingOperations.length > 0) {
    throw new DomainError("COST_BUDGET_APPROVAL_INVALID", "cost approval requires a stable working task")
  }
  const assignment = next.workGraph.assignments.find(({ assignmentId }) => assignmentId === fact.assignmentId)
  const decisionId = assertIdentifier(fact.decisionId, "fact.decisionId")
  const decision = next.decisionHistory.at(-1)
  if (
    !decision
    || decision.decisionId !== decisionId
    || !decisionId.startsWith("budget-")
    || decision.stageRunId !== next.currentStageRun.stageRunId
    || decision.choice !== "accept"
  ) {
    throw new DomainError("COST_BUDGET_APPROVAL_INVALID", "cost approval requires the latest accepted budget decision")
  }
  if (!assignment || !["planned", "rework", "lost"].includes(assignment.status) || !assignment.execution) {
    throw new DomainError("COST_BUDGET_APPROVAL_STALE", "cost approval no longer targets a dispatchable assignment")
  }
  const dependenciesAccepted = assignment.dependsOn.every((dependency) => (
    next.workGraph.assignments.find(({ assignmentId }) => assignmentId === dependency)?.status === "accepted"
  ))
  const requiredLimit = next.costLedger.accrued + next.costLedger.uncertain + costWeightForTier(assignment.costTier)
  if (
    !dependenciesAccepted
    || assignment.attempts.length >= (next.stagePlan?.convergence.maxAutonomousRounds ?? 3)
    || fact.approvedLimit !== requiredLimit
    || requiredLimit <= next.costLedger.automaticLimit
  ) {
    throw new DomainError("COST_BUDGET_APPROVAL_STALE", "cost approval does not match the next dispatch boundary")
  }
  next.costLedger.automaticLimit = requiredLimit
}

function normalizeTaskIntent(intent) {
  const execution = intent?.preferences?.execution ?? "auto"
  const budget = intent?.preferences?.budget ?? "balanced"
  const risk = intent?.preferences?.risk ?? "normal"
  if (!["auto", "solo", "team"].includes(execution) || !["economy", "balanced", "quality"].includes(budget) || !["normal", "high", "critical"].includes(risk)) {
    throw new DomainError("TASK_INTENT_INVALID", "task intent preferences are invalid")
  }
  return {
    objective: assertNonEmptyString(intent?.objective, "intent.objective"),
    constraints: [...assertStringList(intent?.constraints ?? [], "intent.constraints")],
    exclusions: [...assertStringList(intent?.exclusions ?? [], "intent.exclusions")],
    preferences: { execution, budget, risk },
  }
}

function recordTaskIntent(next, fact) {
  if (next.taskIntent !== null) {
    throw new DomainError("TASK_INTENT_ALREADY_RECORDED", "task intent changes require a controlled stage replan")
  }
  if (next.currentStageRun.status !== "planned" || next.stagePlan !== null) {
    throw new DomainError("TASK_INTENT_STATE_INVALID", "task intent must be recorded before the first stage plan is frozen")
  }
  next.taskIntent = normalizeTaskIntent(fact.intent)
  next.taskIntentRevision = 1
}

function reviseTaskIntent(next, fact) {
  const previousRun = next.stageRuns.at(-1)
  if (
    next.currentStageRun.status !== "planned"
    || next.stagePlan !== null
    || next.preflight !== null
    || next.workGraph.assignments.length > 0
    || next.pendingOperations.length > 0
    || previousRun?.status !== "rework"
  ) {
    throw new DomainError("TASK_INTENT_REVISION_INVALID", "task intent can change only at a fresh controlled rework run")
  }
  const revised = normalizeTaskIntent(fact.intent)
  if (digestValue(revised) === digestValue(next.taskIntent)) {
    throw new DomainError("TASK_INTENT_UNCHANGED", "a revised task intent must change the inherited intent")
  }
  const reason = assertNonEmptyString(fact.reason, "fact.reason")
  next.taskIntentHistory.push({
    revision: next.taskIntentRevision,
    intent: structuredClone(next.taskIntent),
    stageRunId: previousRun.stageRunId,
    reason,
    supersededAt: fact.occurredAt,
  })
  next.taskIntent = revised
  next.taskIntentRevision += 1
}

function freezeStagePlan(next, fact) {
  if (next.currentStageRun.status !== "planned" || next.stagePlan !== null) {
    throw new DomainError("STAGE_PLAN_ALREADY_FROZEN", "the current stage run already has an active plan")
  }
  if (next.taskIntent === null) {
    if (!fact.taskIntent) throw new DomainError("TASK_INTENT_REQUIRED", "a stage plan cannot freeze without its inherited task intent")
    recordTaskIntent(next, { intent: fact.taskIntent })
  }
  const plan = normalizeStagePlan(fact.plan, next.currentStageRun.stageRunId)
  if (next.preflight) {
    if (
      next.preflight.status !== "satisfied"
      || fact.preflightId !== next.preflight.preflightId
      || plan.basis?.kind !== "preflight"
      || plan.basis.preflightId !== next.preflight.preflightId
      || plan.basis.resultRef !== next.preflight.result.ref
      || plan.basis.resultDigest !== next.preflight.result.digest
    ) throw new DomainError("PREFLIGHT_NOT_SATISFIED", "formal planning must bind the satisfied current preflight result")
  } else if (plan.basis?.kind !== "deterministic") {
    throw new DomainError("STAGE_PLAN_BASIS_INVALID", "a direct stage plan must use a deterministic basis")
  }
  next.stagePlan = { ...plan, assignments: plan.assignments.map(({ assignmentId }) => assignmentId) }
  next.workGraph = createWorkGraph(plan.assignments)
  next.costLedger = normalizeCostLedger(fact.costLedger)
  next.status = "needs-plan"
  if (next.preflight) next.preflight.status = "consumed"
}

function recordRouteDecision(next, fact) {
  const decision = structuredClone(fact.decision)
  if (decision.stageRunId !== next.currentStageRun.stageRunId || decision.stage !== next.currentStageRun.stage) {
    throw new DomainError("ROUTE_DECISION_STALE", "route decision must target the current stage run")
  }
  if (next.routeDecisions.some(({ decisionId }) => decisionId === decision.decisionId)) {
    throw new DomainError("ROUTE_DECISION_DUPLICATE", `route decision already exists: ${decision.decisionId}`)
  }
  next.routeDecisions.push(decision)
  if (decision.outcome === "blocked") next.status = "blocked"
}

function startPreflight(next, fact) {
  if (next.currentStageRun.status !== "planned" || next.stagePlan !== null || next.preflight !== null || next.workGraph.assignments.length > 0) {
    throw new DomainError("PREFLIGHT_STATE_INVALID", "preflight requires a fresh planned stage run")
  }
  if (next.taskIntent === null) {
    if (!fact.taskIntent) throw new DomainError("TASK_INTENT_REQUIRED", "preflight requires the inherited task intent")
    recordTaskIntent(next, { intent: fact.taskIntent })
  }
  const kind = fact.plan?.preflightKind
  if (!["planning-bootstrap", "route-assessment"].includes(kind)) {
    throw new DomainError("PREFLIGHT_KIND_INVALID", "preflight plan must declare a supported kind")
  }
  const { preflightKind: _preflightKind, ...candidate } = fact.plan
  const plan = normalizeStagePlan(candidate, next.currentStageRun.stageRunId)
  next.preflight = {
    preflightId: `preflight-${digestValue({ kind, planId: plan.planId, stageRunId: plan.stageRunId }).slice(0, 20)}`,
    stageRunId: next.currentStageRun.stageRunId,
    kind,
    status: "active",
    plan: { ...plan, assignments: plan.assignments.map(({ assignmentId }) => assignmentId) },
    result: null,
  }
  next.workGraph = createWorkGraph(plan.assignments)
  next.costLedger = normalizeCostLedger(fact.costLedger)
  next.status = "working"
}

function satisfyPreflight(next, fact) {
  if (!next.preflight || next.preflight.status !== "active" || fact.preflightId !== next.preflight.preflightId) {
    throw new DomainError("PREFLIGHT_STATE_INVALID", "only the active current preflight can be satisfied")
  }
  if (
    next.pendingOperations.length > 0
    || next.observationInbox.items.length > 0
    || next.workGraph.assignments.some(({ status }) => status !== "accepted")
  ) throw new DomainError("PREFLIGHT_INCOMPLETE", "preflight requires an accepted and quiescent work graph")
  const result = fact.result
  if (
    result?.kind !== next.preflight.kind
    || typeof result.ref !== "string"
    || result.ref === ""
    || !Array.isArray(result.evidenceRefs)
  ) throw new DomainError("PREFLIGHT_RESULT_INVALID", "preflight result must identify its durable output and evidence")
  const evidenceRefs = assertStringList(result.evidenceRefs, "fact.result.evidenceRefs", { allowEmpty: false })
  const resultDigest = assertDigest(result.digest, "fact.result.digest")
  const artifact = next.artifacts.find(({ path, digest }) => path === result.ref && digest === resultDigest)
  if (!artifact || evidenceRefs.some((ref) => {
    const reportId = ref.startsWith("report:") ? ref.slice("report:".length) : null
    return !reportId || !next.acceptedReportRefs.some((entry) => entry.reportId === reportId)
  })) throw new DomainError("PREFLIGHT_RESULT_INVALID", "preflight result must bind a registered artifact and accepted report evidence")
  next.preflight.status = "satisfied"
  next.preflight.result = {
    kind: result.kind,
    ref: result.ref,
    digest: resultDigest,
    evidenceRefs: [...evidenceRefs],
  }
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
  const previousAttempt = assignment.attempts.at(-1)
  if (assignment.status === "lost") {
    if (
      effect.resumeExecutionRef
      || effect.recovery?.kind !== "execution-lost"
      || effect.recovery.priorAttempt !== previousAttempt?.attempt
      || digestValue(effect.recovery.unverifiedRefs) !== digestValue(previousAttempt?.unverifiedRefs)
    ) throw new DomainError("LOST_RECOVERY_INVALID", "lost execution must start a fresh session with its quarantined output refs")
  } else if (effect.recovery) {
    throw new DomainError("LOST_RECOVERY_INVALID", "only a lost assignment may carry recovery context")
  }
  const duplicate = next.workGraph.assignments.some(({ attempts }) => attempts.some((attempt) => attempt.attemptId === attemptId))
  if (duplicate) throw new DomainError("ASSIGNMENT_ATTEMPT_DUPLICATE", `attempt ${attemptId} already exists`)
  if (next.pendingOperations.some((operation) => operation.operationId === operationId)) {
    throw new DomainError("OPERATION_DUPLICATE", `operation ${operationId} already exists`)
  }
  assignment.status = "effect-pending"
  if (next.status === "needs-plan") next.status = "working"
  if (next.currentStageRun.status === "planned" && next.stagePlan !== null) next.currentStageRun.status = "dispatching"
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
  if (operation.kind === "execution.quiesce") {
    if (
      operation.purpose !== "human-wait"
      || next.pendingDecision?.quiesceOperationId !== operation.operationId
      || operation.intent.decisionId !== next.pendingDecision.decisionId
    ) {
      throw new DomainError("OPERATION_BINDING_INVALID", "quiesce operation has no matching pending decision")
    }
    return { operation }
  }
  if (["spec.prepare", "spec.archive"].includes(operation.kind)) {
    if (
      !next.specLifecycle.task
      || digestValue(operation.intent.task) !== digestValue(next.specLifecycle.task)
      || operation.intent.operationId !== operation.operationId
      || operation.intent.effectDigest !== operation.effectDigest
    ) {
      throw new DomainError("OPERATION_BINDING_INVALID", "SPEC operation has no matching provider lifecycle")
    }
    return { operation }
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

function requestSpecPrepare(next, fact) {
  const intent = structuredClone(fact.intent)
  const operationId = assertIdentifier(intent?.operationId, "fact.intent.operationId")
  const effectDigest = assertDigest(intent?.effectDigest, "fact.intent.effectDigest")
  const route = next.stagePlan?.routes?.spec ?? next.preflight?.plan?.routes?.spec
  if (
    !["needs-plan", "working"].includes(next.status)
    || next.pendingDecision
    || next.pendingOperations.length > 0
    || route?.decision !== "use-provider"
    || intent.task?.taskId !== next.taskId
    || intent.task?.stageRunId !== next.currentStageRun.stageRunId
    || intent.task?.routeStateDigest !== route.digest
    || intent.task?.configDigest !== route.configDigest
    || digestEffect(intent) !== effectDigest
  ) {
    throw new DomainError("SPEC_PREPARE_INTENT_INVALID", "SPEC prepare intent does not match the active provider route")
  }
  if (next.specLifecycle.archive) throw new DomainError("SPEC_ALREADY_ARCHIVED", "an archived SPEC lifecycle cannot prepare another capability")
  if (next.specLifecycle.task && digestValue(next.specLifecycle.task) !== digestValue(intent.task)) {
    const previous = next.specLifecycle.task
    const safeRebind = intent.task.providerId === previous.providerId
      && intent.task.taskId === previous.taskId
      && intent.task.configDigest === previous.configDigest
      && intent.task.stageRunId === next.currentStageRun.stageRunId
    if (!safeRebind) throw new DomainError("SPEC_TASK_CONFLICT", "SPEC provider task binding cannot change outside a current-stage replan")
    next.specLifecycle.task = structuredClone(intent.task)
    next.specLifecycle.status = null
    next.specLifecycle.validation = null
  }
  if (next.specLifecycle.capabilities.some((entry) => entry.operationId === operationId)) {
    throw new DomainError("OPERATION_DUPLICATE", `operation ${operationId} already completed`)
  }
  next.specLifecycle.task ??= structuredClone(intent.task)
  next.pendingOperations.push({
    operationId,
    kind: "spec.prepare",
    purpose: "spec-prepare",
    effectDigest,
    status: "intent-persisted",
    invocationCount: 0,
    intent,
    createdAt: fact.occurredAt,
  })
}

function requestSpecArchive(next, fact) {
  const intent = structuredClone(fact.intent)
  const operationId = assertIdentifier(intent?.operationId, "fact.intent.operationId")
  const effectDigest = assertDigest(intent?.effectDigest, "fact.intent.effectDigest")
  const finalGateSkipped = next.stagePlan?.routes?.humanGates?.some(({ gateId, action }) => gateId === "final-acceptance" && action === "skip")
  const accepted = finalGateSkipped || next.decisionHistory.some(({ decisionId, choice }) => (
    choice === "accept"
    && (decisionId.startsWith("final-acceptance-") || decisionId.startsWith("scoped-final-acceptance-"))
  ))
  if (
    next.status !== "working"
    || next.pendingDecision
    || next.pendingOperations.length > 0
    || !accepted
    || !next.specLifecycle.task
    || digestValue(intent.task) !== digestValue(next.specLifecycle.task)
    || next.specLifecycle.validation?.valid !== true
    || next.specLifecycle.validation?.complete !== true
    || intent.expectedProviderRevision !== next.specLifecycle.validation.providerRevision
    || digestEffect(intent) !== effectDigest
  ) {
    throw new DomainError("SPEC_ARCHIVE_INTENT_INVALID", "SPEC archive requires current validation and final human acceptance")
  }
  if (next.specLifecycle.archive) throw new DomainError("SPEC_ALREADY_ARCHIVED", "SPEC provider task is already archived")
  next.pendingOperations.push({
    operationId,
    kind: "spec.archive",
    purpose: "spec-archive",
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
  next.costLedger.uncertain += assignment ? executionOperationCost(operation, assignment) : 0
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

function retrySpecEffect(next, fact) {
  const { operation } = findPendingOperation(next, fact)
  if (!["spec.prepare", "spec.archive"].includes(operation.kind) || operation.status !== "in-doubt") {
    throw new DomainError("SPEC_EFFECT_RETRY_INVALID", "only an in-doubt SPEC operation can be retried")
  }
  operation.status = "intent-persisted"
  delete operation.invocationId
  delete operation.leaseExpiresAt
  if (fact.blocker) operation.lastError = {
    code: "SPEC_EFFECT_MISSING",
    message: assertNonEmptyString(fact.blocker, "fact.blocker"),
    retryable: true,
  }
}

function confirmSpecPrepare(next, fact) {
  const { operation } = findPendingOperation(next, fact, "spec.prepare")
  const capability = structuredClone(fact.capability)
  validateReceipt(operation, capability)
  if (
    capability.status !== "ready"
    || digestValue(capability.task) !== digestValue(next.specLifecycle.task)
    || capability.operationId !== operation.operationId
  ) throw new DomainError("SPEC_CAPABILITY_INVALID", "SPEC prepare did not return a ready capability for its persisted intent")
  next.specLifecycle.capabilities.push({
    artifact: operation.intent.artifact,
    ...(operation.intent.capabilityNames ? { capabilityNames: [...operation.intent.capabilityNames] } : {}),
    task: structuredClone(capability.task),
    operationId: operation.operationId,
    effectDigest: operation.effectDigest,
    receiptRef: operation.operationId,
    capabilityId: capability.capabilityId,
    capabilityDigest: capability.capabilityDigest,
    instructionsRef: capability.instructionsRef,
    readableRefs: [...capability.readableRefs],
    writableRefs: [...capability.writableRefs],
    recordedAt: fact.occurredAt,
  })
  next.pendingOperations = next.pendingOperations.filter((entry) => entry.operationId !== operation.operationId)
}

function recordSpecStatus(next, fact) {
  const status = structuredClone(fact.status)
  if (!next.specLifecycle.task || digestValue(status?.task) !== digestValue(next.specLifecycle.task)) {
    throw new DomainError("SPEC_STATUS_INVALID", "SPEC status does not match the persisted provider task")
  }
  const recoveringProviderBlock = next.specLifecycle.status?.state === "blocked" && next.status === "blocked"
  if (next.specLifecycle.status?.providerRevision !== status.providerRevision) next.specLifecycle.validation = null
  next.specLifecycle.status = status
  if (status.state === "blocked") next.status = "blocked"
  else if (recoveringProviderBlock) next.status = "working"
}

function recordSpecValidation(next, fact) {
  const validation = structuredClone(fact.validation)
  if (
    !next.specLifecycle.task
    || digestValue(validation?.task) !== digestValue(next.specLifecycle.task)
    || validation.providerRevision !== next.specLifecycle.status?.providerRevision
  ) throw new DomainError("SPEC_VALIDATION_INVALID", "SPEC validation must bind the latest provider status")
  const recoveringValidationBlock = next.specLifecycle.validation
    && (!next.specLifecycle.validation.valid || !next.specLifecycle.validation.complete)
    && next.status === "blocked"
  next.specLifecycle.validation = validation
  if (!validation.valid || !validation.complete) next.status = "blocked"
  else if (recoveringValidationBlock) next.status = "working"
}

function confirmSpecArchive(next, fact) {
  const { operation } = findPendingOperation(next, fact, "spec.archive")
  const receipt = structuredClone(fact.receipt)
  validateReceipt(operation, receipt)
  if (receipt.status !== "confirmed" || digestValue(receipt.task) !== digestValue(next.specLifecycle.task)) {
    throw new DomainError("SPEC_ARCHIVE_RECEIPT_INVALID", "SPEC archive did not return a confirmed receipt")
  }
  next.specLifecycle.archive = {
    operationId: operation.operationId,
    effectDigest: operation.effectDigest,
    receiptRef: operation.operationId,
    archiveRefs: [...receipt.archiveRefs],
    observedAt: receipt.observedAt,
  }
  next.pendingOperations = next.pendingOperations.filter((entry) => entry.operationId !== operation.operationId)
}

function blockSpecEffect(next, fact) {
  const { operation } = findPendingOperation(next, fact)
  if (!["spec.prepare", "spec.archive"].includes(operation.kind)) {
    throw new DomainError("SPEC_EFFECT_BLOCK_INVALID", "only a SPEC effect can be blocked by this fact")
  }
  next.pendingOperations = next.pendingOperations.filter((entry) => entry.operationId !== operation.operationId)
  next.status = "blocked"
}

function prepareHumanWait(next, fact) {
  const executableNeedsPlan = next.status === "needs-plan" && (next.stagePlan !== null || next.preflight?.status === "active")
  if (!["working", "blocked"].includes(next.status) && !executableNeedsPlan) {
    throw new DomainError("HUMAN_WAIT_STATE_INVALID", "human wait can only be prepared from working or blocked")
  }
  if (next.pendingDecision || next.pendingOperations.length > 0) {
    throw new DomainError("HUMAN_WAIT_NOT_QUIESCENT", "human wait requires no existing decision or external effect")
  }
  if (next.observationInbox.items.length > 0) {
    throw new DomainError("HUMAN_WAIT_INBOX_PENDING", "human wait requires the durable observation inbox to be drained")
  }
  const decision = fact.decision
  const decisionId = assertIdentifier(decision?.decisionId, "fact.decision.decisionId")
  const artifactRefs = assertStringList(decision?.artifactRefs, "fact.decision.artifactRefs", { allowEmpty: false })
  const evidence = artifactRefs.map((artifactId) => {
    const artifact = next.artifacts.find((entry) => entry.artifactId === artifactId)
    if (!artifact) {
      throw new DomainError("HUMAN_WAIT_EVIDENCE_INVALID", `human decision references an unavailable artifact: ${artifactId}`)
    }
    return { artifactId, path: artifact.path, digest: artifact.digest }
  })
  const evidenceDigest = digestValue({ stageRunId: next.currentStageRun.stageRunId, evidence })
  const executionRefs = [...new Set(next.workGraph.assignments.flatMap((assignment) => {
    const executionRef = assignment.attempts.at(-1)?.executionRef
    return executionRef ? [executionRef] : []
  }))].sort()
  const intent = structuredClone(fact.intent)
  if (
    intent?.taskId !== next.taskId
    || intent.decisionId !== decisionId
    || intent.leadBindingRef !== decision.leadBindingRef
    || JSON.stringify(intent.executionRefs) !== JSON.stringify(executionRefs)
    || intent.clearHostContinuations !== true
    || digestEffect(intent) !== intent.effectDigest
  ) {
    throw new DomainError("HUMAN_WAIT_EFFECT_MISMATCH", "quiesce intent does not match the pending human decision")
  }
  next.pendingDecision = {
    decisionId,
    stageRunId: next.currentStageRun.stageRunId,
    phase: "preparing",
    requirement: decision.requirement,
    proofMode: decision.proofMode,
    capabilitySnapshotDigest: assertNonEmptyString(decision.capabilitySnapshotDigest, "fact.decision.capabilitySnapshotDigest"),
    leadBindingRef: assertNonEmptyString(decision.leadBindingRef, "fact.decision.leadBindingRef"),
    question: assertNonEmptyString(decision.question, "fact.decision.question"),
    choices: [...assertStringList(decision.choices, "fact.decision.choices", { allowEmpty: false })],
    evidence,
    evidenceDigest,
    executionRefs,
    quiesceOperationId: assertIdentifier(intent.operationId, "fact.intent.operationId"),
    quiesceAttempt: 1,
    observationsAfterPrepare: 0,
    createdAt: fact.occurredAt,
    ...(decision.packetRef ? {
      packetRef: assertNonEmptyString(decision.packetRef, "fact.decision.packetRef"),
      packetDigest: assertDigest(decision.packetDigest, "fact.decision.packetDigest"),
    } : {}),
  }
  next.pendingOperations.push({
    operationId: intent.operationId,
    kind: "execution.quiesce",
    purpose: "human-wait",
    effectDigest: assertDigest(intent.effectDigest, "fact.intent.effectDigest"),
    status: "intent-persisted",
    invocationCount: 0,
    intent,
    createdAt: fact.occurredAt,
  })
}

function retryHumanQuiesce(next, fact) {
  const decision = next.pendingDecision
  if (
    next.status !== "blocked"
    || decision?.phase !== "preparing"
    || !decision.quiesceFailureRef
    || next.pendingOperations.length > 0
  ) {
    throw new DomainError("HUMAN_WAIT_RETRY_INVALID", "only a blocked quiesce may be retried")
  }
  const intent = structuredClone(fact.intent)
  if (
    intent?.taskId !== next.taskId
    || intent.decisionId !== decision.decisionId
    || intent.leadBindingRef !== decision.leadBindingRef
    || JSON.stringify(intent.executionRefs) !== JSON.stringify(decision.executionRefs)
    || intent.clearHostContinuations !== true
    || digestEffect(intent) !== intent.effectDigest
  ) {
    throw new DomainError("HUMAN_WAIT_EFFECT_MISMATCH", "retried quiesce intent does not match the pending human decision")
  }
  decision.quiesceAttempt += 1
  decision.quiesceOperationId = assertIdentifier(intent.operationId, "fact.intent.operationId")
  decision.observationsAfterPrepare = 0
  delete decision.quiesceFailureRef
  next.pendingOperations.push({
    operationId: intent.operationId,
    kind: "execution.quiesce",
    purpose: "human-wait",
    effectDigest: assertDigest(intent.effectDigest, "fact.intent.effectDigest"),
    status: "intent-persisted",
    invocationCount: 0,
    intent,
    createdAt: fact.occurredAt,
  })
  next.status = "working"
}

function confirmHumanQuiesce(next, fact) {
  const { operation } = findPendingOperation(next, fact, "execution.quiesce")
  const receipt = fact.receipt
  validateReceipt(operation, receipt)
  const decision = next.pendingDecision
  const states = new Map(receipt.executions?.map((entry) => [entry.executionRef, entry.state]))
  if (
    receipt.status !== "confirmed"
    || receipt.hostContinuationsCleared !== true
    || decision.executionRefs.some((executionRef) => !["idle", "stopped", "isolated"].includes(states.get(executionRef)))
    || states.size !== decision.executionRefs.length
    || (decision.proofMode === "verified-event" && !receipt.hostCursor)
  ) {
    throw new DomainError("HUMAN_WAIT_QUIESCE_INVALID", "confirmed quiesce receipt does not prove a static human wait")
  }
  next.pendingOperations = next.pendingOperations.filter((entry) => entry.operationId !== operation.operationId)
  decision.quiesceReceiptRef = operation.operationId
  decision.quiescedAt = fact.occurredAt
  if (receipt.hostCursor) decision.afterHostCursor = receipt.hostCursor
}

function blockHumanQuiesce(next, fact) {
  const { operation } = findPendingOperation(next, fact, "execution.quiesce")
  const receipt = fact.receipt
  validateReceipt(operation, receipt)
  if (receipt.status !== "blocked") {
    throw new DomainError("HUMAN_WAIT_QUIESCE_INVALID", "blocked human wait requires a blocked quiesce receipt")
  }
  next.pendingOperations = next.pendingOperations.filter((entry) => entry.operationId !== operation.operationId)
  next.pendingDecision.quiesceFailureRef = operation.operationId
  next.status = "blocked"
}

function activateHumanWait(next, fact) {
  const decision = next.pendingDecision
  if (!decision || decision.phase !== "preparing" || !decision.quiesceReceiptRef) {
    throw new DomainError("HUMAN_WAIT_NOT_PREPARED", "human wait requires a confirmed quiesce receipt")
  }
  if (next.pendingOperations.length > 0 || next.observationInbox.items.length > 0) {
    throw new DomainError("HUMAN_WAIT_NOT_QUIESCENT", "human wait cannot activate with pending effects or observations")
  }
  const currentEvidence = decision.evidence.map(({ artifactId }) => {
    const artifact = next.artifacts.find((entry) => entry.artifactId === artifactId)
    return artifact && { artifactId, path: artifact.path, digest: artifact.digest }
  })
  if (
    currentEvidence.some((entry) => !entry)
    || digestValue({ stageRunId: next.currentStageRun.stageRunId, evidence: currentEvidence }) !== decision.evidenceDigest
  ) {
    throw new DomainError("HUMAN_WAIT_EVIDENCE_STALE", "human wait evidence changed before the decision was issued")
  }
  decision.phase = "awaiting-user"
  decision.issuedAt = fact.occurredAt
  next.status = "awaiting-user"
}

function invalidatePreparedHumanWait(next, fact) {
  const decision = next.pendingDecision
  if (!decision || decision.phase !== "preparing" || !decision.quiesceReceiptRef || next.pendingOperations.length > 0) {
    throw new DomainError("HUMAN_WAIT_INVALIDATION_INVALID", "only a quiesced preparing decision can be invalidated")
  }
  const currentEvidence = decision.evidence.map(({ artifactId }) => {
    const artifact = next.artifacts.find((entry) => entry.artifactId === artifactId)
    return artifact && { artifactId, path: artifact.path, digest: artifact.digest }
  })
  const evidenceUnchanged = (
    currentEvidence.every(Boolean)
    && digestValue({ stageRunId: next.currentStageRun.stageRunId, evidence: currentEvidence }) === decision.evidenceDigest
  )
  if (evidenceUnchanged && decision.observationsAfterPrepare === 0 && fact.reason !== "evidence-or-observation-changed") {
    throw new DomainError("HUMAN_WAIT_INVALIDATION_INVALID", "unchanged human wait evidence cannot be invalidated")
  }
  next.pendingDecision = null
  next.status = "working"
}

function resolveHumanDecision(next, fact) {
  const pending = next.pendingDecision
  const decision = fact.decision
  if (next.status !== "awaiting-user" || !pending || pending.phase !== "awaiting-user") {
    throw new DomainError("HUMAN_DECISION_NOT_AWAITED", "task is not awaiting this human decision")
  }
  if (next.observationInbox.items.length > 0) {
    throw new DomainError("HUMAN_DECISION_LATE_OBSERVATIONS", "late observations must be reviewed before accepting a human decision")
  }
  if (
    decision?.decisionId !== pending.decisionId
    || decision.leadBindingRef !== pending.leadBindingRef
    || !pending.choices.includes(decision.choice)
    || decision.proof?.mode !== pending.proofMode
  ) {
    throw new DomainError("HUMAN_DECISION_MISMATCH", "verified human decision does not match the issued request")
  }
  if (
    pending.proofMode === "verified-event"
    && decision.proof.messageCursor === pending.afterHostCursor
  ) {
    throw new DomainError("HUMAN_DECISION_STALE", "verified human event must be newer than the quiesce cursor")
  }
  const currentEvidence = pending.evidence.map(({ artifactId }) => {
    const artifact = next.artifacts.find((entry) => entry.artifactId === artifactId)
    return artifact && { artifactId, path: artifact.path, digest: artifact.digest }
  })
  const evidenceDigest = digestValue({ stageRunId: next.currentStageRun.stageRunId, evidence: currentEvidence })
  if (
    next.currentStageRun.stageRunId !== pending.stageRunId
    || currentEvidence.some((entry) => !entry)
    || evidenceDigest !== pending.evidenceDigest
  ) {
    throw new DomainError("HUMAN_DECISION_EVIDENCE_STALE", "human decision no longer matches the issued stage evidence")
  }
  const decisionRef = assertIdentifier(fact.decisionRef, "fact.decisionRef")
  const decisionDigest = assertDigest(fact.decisionDigest, "fact.decisionDigest")
  const artifactRefs = pending.evidence.map(({ artifactId }) => artifactId)
  const artifactDigests = Object.fromEntries(pending.evidence.map(({ artifactId, digest }) => [artifactId, digest]))
  next.decisionHistory.push({
    decisionId: pending.decisionId,
    stageRunId: pending.stageRunId,
    choice: decision.choice,
    proofMode: pending.proofMode,
    leadBindingRef: pending.leadBindingRef,
    executionRefs: pending.executionRefs,
    artifactDigests,
    evidenceDigest: pending.evidenceDigest,
    quiesceReceiptRef: pending.quiesceReceiptRef,
    decisionRef,
    decisionDigest,
    receivedAt: decision.receivedAt,
    ...(pending.packetRef ? { packetRef: pending.packetRef, packetDigest: pending.packetDigest } : {}),
  })
  next.evidence.push({
    evidenceId: `evidence-${decisionRef}`,
    kind: "human-decision",
    sourceRef: `operations/${decisionRef}.json`,
    artifactRefs,
    artifactDigests,
    result: "unknown",
    digest: decisionDigest,
    stageRunId: pending.stageRunId,
    observedAt: decision.receivedAt,
    valid: true,
  })
  next.pendingDecision = null
  next.status = "working"
}

function reopenHumanWait(next, fact) {
  if (next.status !== "awaiting-user" || next.pendingDecision?.phase !== "awaiting-user") {
    throw new DomainError("HUMAN_WAIT_NOT_ACTIVE", "only an active human wait can be reopened")
  }
  if (
    !["late-observations", "evidence-changed"].includes(fact.reason)
    || (fact.reason === "late-observations" && next.observationInbox.items.length === 0)
  ) {
    throw new DomainError("HUMAN_WAIT_REOPEN_INVALID", "human wait recovery reason is not supported by current durable facts")
  }
  next.pendingDecision = null
  next.status = "working"
}

function validateReceipt(operation, receipt) {
  if (
    receipt?.operationId !== operation.operationId
    || receipt.effectDigest !== operation.effectDigest
  ) {
    throw new DomainError("EFFECT_RECEIPT_MISMATCH", "effect receipt does not match its persisted intent", [{
      expectedOperationId: operation.operationId,
      actualOperationId: receipt?.operationId,
      expectedEffectDigest: operation.effectDigest,
      actualEffectDigest: receipt?.effectDigest,
    }])
  }
}

function confirmEffect(next, fact) {
  const { operation, assignment, attempt } = findPendingOperation(next, fact, "execution.ensure")
  validateReceipt(operation, fact.receipt)
  if (fact.receipt.status !== "confirmed" || typeof fact.receipt.executionRef !== "string" || fact.receipt.executionRef === "") {
    throw new DomainError("EFFECT_RECEIPT_INVALID", "a running assignment requires a confirmed execution receipt")
  }
  const relativeCost = executionOperationCost(operation, assignment)
  releaseUncertainCost(next, operation, assignment)
  next.costLedger.accrued += relativeCost
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
  releaseUncertainCost(next, operation, assignment)
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
  releaseUncertainCost(next, operation, assignment)
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
  item.progression = next.status === "awaiting-user" ? "deferred" : "active"
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
  if (next.pendingDecision?.phase === "preparing") next.pendingDecision.observationsAfterPrepare += 1
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
      if (item.kind === "execution-lost") {
        attempt.unverifiedRefs = [...assignment.writableRefs]
        attempt.unverifiedAt = fact.occurredAt
      }
      const maxRounds = next.stagePlan?.convergence.maxAutonomousRounds ?? 3
      next.status = item.kind === "execution-lost" && attempt.attempt < maxRounds ? "working" : "blocked"
    }
  } else if (item.kind === "execution-idle") {
    const assignment = next.workGraph.assignments.find((entry) => entry.assignmentId === item.assignmentId)
    const attempt = assignment?.attempts.find((entry) => entry.attemptId === item.attemptId)
    if (assignment && attempt && attempt.status === "running") attempt.idleObservedAt = item.receivedAt
  }
  if (fact.evidence) recordEvidence(next, { evidence: fact.evidence, occurredAt: fact.occurredAt })
  next.observationInbox.acknowledgedThrough = fact.sequence
  next.observationInbox.items = next.observationInbox.items.filter((entry) => entry.sequence > fact.sequence)
}

function findReportedAttempt(next, fact, allowedStatuses) {
  const assignment = next.workGraph.assignments.find((entry) => entry.assignmentId === fact.assignmentId)
  const attempt = assignment?.attempts.find((entry) => entry.attemptId === fact.attemptId)
  if (!assignment || !attempt) {
    throw new DomainError("REPORT_BINDING_INVALID", "report decision has no matching assignment attempt")
  }
  if (attempt.reportRef !== fact.reportId || attempt.reportDigest !== fact.reportDigest) {
    throw new DomainError("REPORT_BINDING_INVALID", "report decision does not match the immutable member report")
  }
  if (!allowedStatuses.includes(attempt.status) || assignment.status !== attempt.status) {
    throw new DomainError(
      attempt.status === "reported" ? "REPORT_NOT_VERIFIED" : "REPORT_STATE_INVALID",
      `report cannot move from ${attempt.status}`,
    )
  }
  return { assignment, attempt }
}

function verifyAssignmentReport(next, fact) {
  const { assignment, attempt } = findReportedAttempt(next, fact, ["reported"])
  const artifacts = Array.isArray(fact.artifacts) ? fact.artifacts : []
  const evidence = Array.isArray(fact.evidence) ? fact.evidence : []
  if (assignment.teamRole !== "owner" && artifacts.length > 0) {
    throw new DomainError("ROLE_WRITE_FORBIDDEN", `${assignment.teamRole} reports cannot register product artifacts`)
  }
  if (assignment.teamRole === "owner" && artifacts.length !== assignment.writableRefs.length) {
    throw new DomainError("REPORT_ARTIFACT_MISMATCH", "Owner report artifacts must exactly match its declared writable refs")
  }
  for (const artifact of artifacts) recordArtifact(next, { artifact, occurredAt: fact.occurredAt })
  for (const entry of evidence) recordEvidence(next, { evidence: entry, occurredAt: fact.occurredAt })
  assignment.status = "verified"
  attempt.status = "verified"
  attempt.verifiedAt = fact.occurredAt
}

function acceptAssignmentReport(next, fact) {
  const { assignment, attempt } = findReportedAttempt(next, fact, ["verified"])
  assignment.status = "accepted"
  attempt.status = "accepted"
  attempt.acceptedAt = fact.occurredAt
  if (next.acceptedReportRefs.some(({ reportId }) => reportId === fact.reportId)) {
    throw new DomainError("REPORT_ALREADY_ACCEPTED", `report ${fact.reportId} is already accepted`)
  }
  next.acceptedReportRefs.push({ reportId: fact.reportId, digest: fact.reportDigest })
}

function rejectAssignmentReport(next, fact) {
  const { assignment, attempt } = findReportedAttempt(next, fact, ["reported", "verified"])
  assignment.status = "rework"
  attempt.status = "rework"
  attempt.rejectionReason = assertNonEmptyString(fact.reason, "fact.reason")
  attempt.rejectedAt = fact.occurredAt
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
  if (
    next.status === "awaiting-user"
    && next.pendingDecision?.phase === "awaiting-user"
    && next.pendingDecision.evidence.some((entry) => entry.artifactId === artifactId && entry.digest === previous.digest)
  ) {
    next.pendingDecision = null
    next.status = "working"
  }
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
  if (evidence.kind === "platform-check") {
    const assignment = next.workGraph.assignments.find(({ assignmentId }) => assignmentId === evidence.assignmentId)
    const attempt = assignment?.attempts.find(({ attemptId }) => attemptId === evidence.attemptId)
    if (!assignment || !attempt || attempt.executionRef !== evidence.executionRef) {
      throw new DomainError("EVIDENCE_BINDING_INVALID", "platform check must bind the assignment attempt that executed it")
    }
    if ((evidence.outputRef && !evidence.outputDigest) || (!evidence.outputRef && evidence.outputDigest)) {
      throw new DomainError("EVIDENCE_INVALID", "platform check output ref and digest must be recorded together")
    }
  }
  next.evidence.push({
    evidenceId,
    kind: evidence.kind,
    sourceRef: assertNonEmptyString(evidence.sourceRef, "evidence.sourceRef"),
    artifactRefs,
    artifactDigests,
    result: evidence.result,
    ...(evidence.digest ? { digest: assertDigest(evidence.digest, "evidence.digest") } : {}),
    ...(evidence.assignmentId ? {
      assignmentId: assertIdentifier(evidence.assignmentId, "evidence.assignmentId"),
      attemptId: assertIdentifier(evidence.attemptId, "evidence.attemptId"),
      executionRef: assertNonEmptyString(evidence.executionRef, "evidence.executionRef"),
    } : {}),
    ...(evidence.outputRef ? {
      outputRef: assertProjectPath(evidence.outputRef, "evidence.outputRef"),
      outputDigest: assertDigest(evidence.outputDigest, "evidence.outputDigest"),
    } : {}),
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

function cancelTask(next, fact) {
  if (["completed", "cancelled"].includes(next.status) || next.pendingDecision || next.pendingOperations.length > 0) {
    throw new DomainError("TASK_CANCEL_INVALID", "task cancellation requires a stable non-terminal task")
  }
  if (next.workGraph.assignments.some(({ status }) => ["effect-pending", "running", "reported", "in-doubt"].includes(status))) {
    throw new DomainError("TASK_CANCEL_INVALID", "task cancellation requires quiesced member work")
  }
  next.status = "cancelled"
  next.currentStageRun.reason = assertNonEmptyString(fact.reason, "fact.reason")
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
  next.preflight = null
  next.workGraph = { assignments: [] }
}

function openSteeringIntervention(next, fact) {
  const pending = next.pendingDecision
  const intervention = fact.plan?.intervention
  if (
    next.status !== "awaiting-user"
    || pending?.phase !== "awaiting-user"
    || !["reviewing", "ready-to-advance"].includes(next.currentStageRun.status)
    || next.pendingOperations.length > 0
    || next.observationInbox.items.length > 0
  ) throw new DomainError("STEERING_INTERVENTION_INVALID", "steering intervention requires a quiescent reviewed human-wait state")
  if (
    !intervention
    || intervention.sourceDecisionId !== pending.decisionId
    || intervention.sourcePacketRef !== pending.packetRef
    || intervention.sourcePacketDigest !== pending.packetDigest
  ) throw new DomainError("STEERING_AUTHORITY_STALE", "steering intervention no longer matches the issued DecisionPacket")
  const nextStageRunId = assertIdentifier(fact.nextStageRunId, "fact.nextStageRunId")
  if (fact.plan.stageRunId !== nextStageRunId || intervention.resumeDecisionId === pending.decisionId) {
    throw new DomainError("STEERING_INTERVENTION_INVALID", "steering intervention must create a fresh stage run and decision")
  }
  if (next.stageRuns.some((run) => run.stageRunId === nextStageRunId) || next.currentStageRun.stageRunId === nextStageRunId) {
    throw new DomainError("STAGE_RUN_DUPLICATE", `stage run ${nextStageRunId} already exists`)
  }
  const reason = assertNonEmptyString(fact.reason, "fact.reason")
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
  next.preflight = null
  next.workGraph = { assignments: [] }
  next.pendingDecision = null
  next.status = "working"
  freezeStagePlan(next, fact)
}

function replanStage(next, fact) {
  if (["completed", "cancelled", "awaiting-user"].includes(next.status)) {
    throw new DomainError("STAGE_REPLAN_INVALID", `cannot replan a ${next.status} task`)
  }
  if (
    next.pendingOperations.length > 0
    || next.workGraph.assignments.some((assignment) => (
      ["effect-pending", "running", "reported", "in-doubt"].includes(assignment.status)
    ))
  ) throw new DomainError("STAGE_REPLAN_NOT_QUIESCENT", "replan requires a stable stage with no active external work")
  const nextStageRunId = assertIdentifier(fact.nextStageRunId, "fact.nextStageRunId")
  const reason = assertNonEmptyString(fact.reason, "fact.reason")
  if (next.stageRuns.some((run) => run.stageRunId === nextStageRunId) || next.currentStageRun.stageRunId === nextStageRunId) {
    throw new DomainError("STAGE_RUN_DUPLICATE", `stage run ${nextStageRunId} already exists`)
  }
  const previous = next.currentStageRun
  if (fact.taskIntent) {
    const revisedIntent = normalizeTaskIntent(fact.taskIntent)
    if (digestValue(revisedIntent) === digestValue(next.taskIntent)) {
      throw new DomainError("TASK_INTENT_UNCHANGED", "a replan intent revision must change the inherited task intent")
    }
    next.taskIntentHistory.push({
      revision: next.taskIntentRevision,
      intent: structuredClone(next.taskIntent),
      stageRunId: previous.stageRunId,
      reason,
      supersededAt: fact.occurredAt,
    })
    next.taskIntent = revisedIntent
    next.taskIntentRevision += 1
  }
  next.stageRuns.push({ ...previous, status: "rework", reason, completedAt: fact.occurredAt })
  next.currentStageRun = {
    stageRunId: nextStageRunId,
    sequence: previous.sequence + 1,
    round: previous.round + 1,
    stage: previous.stage,
    status: "planned",
  }
  next.stagePlan = null
  next.preflight = null
  next.workGraph = { assignments: [] }
  next.status = "needs-plan"
  next.costLedger = {
    ...next.costLedger,
    forecastMin: next.costLedger.accrued,
    forecastMax: next.costLedger.accrued,
    uncertain: 0,
    nextWave: 0,
  }
}

export function reduceTask(state, fact) {
  const next = prepare(state, fact)
  switch (fact.type) {
    case "task-intent.recorded":
      recordTaskIntent(next, fact)
      return finish(next, fact)
    case "task-intent.revised":
      reviseTaskIntent(next, fact)
      return finish(next, fact)
    case "stage-run.transitioned":
      transitionStageRun(next, fact)
      return finish(next, fact)
    case "stage.advanced":
      advanceStage(next, fact)
      return finish(next, fact)
    case "stage.returned":
      returnStage(next, fact)
      return finish(next, fact)
    case "stage.skipped":
      skipStage(next, fact)
      return finish(next, fact)
    case "stage-plan.frozen":
      freezeStagePlan(next, fact)
      return finish(next, fact)
    case "preflight.started":
      startPreflight(next, fact)
      return finish(next, fact)
    case "preflight.satisfied":
      satisfyPreflight(next, fact)
      return finish(next, fact)
    case "route.decision-recorded":
      recordRouteDecision(next, fact)
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
    case "spec.prepare-requested":
      requestSpecPrepare(next, fact)
      return finish(next, fact)
    case "spec.archive-requested":
      requestSpecArchive(next, fact)
      return finish(next, fact)
    case "execution.idle-exhausted":
      exhaustIdleCorrection(next, fact)
      return finish(next, fact)
    case "human-wait.prepared":
      prepareHumanWait(next, fact)
      return finish(next, fact)
    case "human-wait.quiesce-retried":
      retryHumanQuiesce(next, fact)
      return finish(next, fact)
    case "human-wait.quiesce-confirmed":
      confirmHumanQuiesce(next, fact)
      return finish(next, fact)
    case "human-wait.quiesce-blocked":
      blockHumanQuiesce(next, fact)
      return finish(next, fact)
    case "human-wait.activated":
      activateHumanWait(next, fact)
      return finish(next, fact)
    case "human-wait.invalidated":
      invalidatePreparedHumanWait(next, fact)
      return finish(next, fact)
    case "human-decision.resolved":
      resolveHumanDecision(next, fact)
      return finish(next, fact)
    case "cost-budget.approved":
      approveCostBudget(next, fact)
      return finish(next, fact)
    case "human-wait.reopened":
      reopenHumanWait(next, fact)
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
    case "spec.effect-retry-scheduled":
      retrySpecEffect(next, fact)
      return finish(next, fact)
    case "spec.prepare-confirmed":
      confirmSpecPrepare(next, fact)
      return finish(next, fact)
    case "spec.status-recorded":
      recordSpecStatus(next, fact)
      return finish(next, fact)
    case "spec.validation-recorded":
      recordSpecValidation(next, fact)
      return finish(next, fact)
    case "spec.archive-confirmed":
      confirmSpecArchive(next, fact)
      return finish(next, fact)
    case "spec.effect-blocked":
      blockSpecEffect(next, fact)
      return finish(next, fact)
    case "observation.received":
      receiveObservation(next, fact)
      return finish(next, fact)
    case "observation.consumed":
      consumeObservation(next, fact)
      return finish(next, fact)
    case "assignment.report-verified":
      verifyAssignmentReport(next, fact)
      return finish(next, fact)
    case "assignment.report-accepted":
      acceptAssignmentReport(next, fact)
      return finish(next, fact)
    case "assignment.report-rejected":
      rejectAssignmentReport(next, fact)
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
    case "task.cancelled":
      cancelTask(next, fact)
      return finish(next, fact)
    case "stage.reopened":
      reopenStage(next, fact)
      return finish(next, fact)
    case "steering.intervention-opened":
      openSteeringIntervention(next, fact)
      return finish(next, fact)
    case "stage.replanned":
      replanStage(next, fact)
      return finish(next, fact)
    default:
      throw new DomainError("FACT_UNSUPPORTED", `unsupported task fact: ${fact.type}`)
  }
}
