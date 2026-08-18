import { ContractError, validateContract } from "../contracts.mjs"
import { digestEffect } from "./digests.mjs"

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/
const DIGEST_PATTERN = /^[a-f0-9]{64}$/

export class DomainError extends Error {
  constructor(code, message, details = []) {
    super(message)
    this.name = "DomainError"
    this.code = code
    this.details = details
  }
}

export function assertIdentifier(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new DomainError("DOMAIN_INVALID", `${label} must be a stable lowercase identifier`)
  }
  return value
}

export function assertDigest(value, label) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new DomainError("DOMAIN_INVALID", `${label} must be a lowercase sha256 digest`)
  }
  return value
}

export function assertTimestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new DomainError("DOMAIN_INVALID", `${label} must be an ISO timestamp`)
  }
  return value
}

export function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError("DOMAIN_INVALID", `${label} must be a non-empty string`)
  }
  return value
}

export function assertUniqueStrings(values, label) {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== "string" || value === "")) {
    throw new DomainError("DOMAIN_INVALID", `${label} must contain non-empty strings`)
  }
  if (new Set(values).size !== values.length) {
    throw new DomainError("DOMAIN_INVALID", `${label} must not contain duplicates`)
  }
  return values
}

export function assertStringList(values, label, { allowEmpty = true } = {}) {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0) || values.some((value) => typeof value !== "string" || value === "")) {
    throw new DomainError("DOMAIN_INVALID", `${label} must contain non-empty strings`)
  }
  if (new Set(values).size !== values.length) {
    throw new DomainError("DOMAIN_INVALID", `${label} must not contain duplicates`)
  }
  return values
}

function failState(message, details = []) {
  throw new DomainError("STATE_INVALID", message, details)
}

function assertUniqueBy(items, key, label) {
  const values = items.map((item) => item[key])
  if (new Set(values).size !== values.length) failState(`${label} must be unique`)
}

export function assertTaskState(state) {
  try {
    validateContract("https://team-work-runtime.dev/schemas/v2/task-state", state, "task state")
  } catch (error) {
    if (error instanceof ContractError) failState("task state does not match its schema", error.errors)
    throw error
  }

  const stageSet = new Set(state.scope.stages)
  if (!stageSet.has(state.scope.entryStage) || !stageSet.has(state.currentStageRun.stage)) {
    failState("entry and current stages must belong to the projected workflow scope")
  }
  if (state.scope.completionStages.some((stage) => !stageSet.has(stage))) {
    failState("completion stages must belong to the projected workflow scope")
  }
  if (state.scope.edges.some((edge) => !stageSet.has(edge.from) || !stageSet.has(edge.to))) {
    failState("workflow edges must remain inside the projected workflow scope")
  }

  const runs = [...state.stageRuns, state.currentStageRun]
  assertUniqueBy(runs, "stageRunId", "stage run ids")
  const sequences = runs.map(({ sequence }) => sequence).sort((left, right) => left - right)
  if (sequences.some((sequence, index) => sequence !== index + 1) || state.currentStageRun.sequence !== runs.length) {
    failState("stage run sequence must be contiguous and end at the current run")
  }
  if (runs.some((run) => !stageSet.has(run.stage))) failState("every stage run must belong to the workflow scope")
  if (state.stageRuns.some((run) => !["completed", "rework"].includes(run.status))) {
    failState("historical stage runs must be completed or closed for rework")
  }
  if (state.currentStageRun.status === "rework") failState("rework must create a new current stage run")
  runs.forEach((run, index) => {
    if (run.sequence !== index + 1) failState("stage runs must be stored in sequence order")
    if (index === 0 && run.round !== 1) failState("the first stage run must start at round one")
    if (index > 0) {
      const previous = runs[index - 1]
      const expectedRound = previous.stage === run.stage ? previous.round + 1 : 1
      if (run.round !== expectedRound) failState("stage run rounds must increment only when re-entering the same stage")
    }
  })

  assertUniqueBy(state.workGraph.assignments, "assignmentId", "assignment ids")
  const assignmentIds = new Set(state.workGraph.assignments.map(({ assignmentId }) => assignmentId))
  const unresolvedDependencies = new Map()
  const globalAttemptIds = new Set()
  const attemptsById = new Map()
  for (const assignment of state.workGraph.assignments) {
    if (assignment.dependsOn.some((dependency) => !assignmentIds.has(dependency))) {
      failState(`assignment ${assignment.assignmentId} references an unknown dependency`)
    }
    unresolvedDependencies.set(assignment.assignmentId, new Set(assignment.dependsOn))
    if (assignment.teamRole !== "owner" && assignment.writableRefs.length > 0) {
      failState(`${assignment.teamRole} assignments cannot write product artifacts`)
    }
    const attemptIds = new Set()
    assignment.attempts.forEach((attempt, index) => {
      if (
        attempt.attempt !== index + 1
        || attempt.stageRunId !== state.currentStageRun.stageRunId
        || attemptIds.has(attempt.attemptId)
        || globalAttemptIds.has(attempt.attemptId)
      ) {
        failState(`assignment ${assignment.assignmentId} has an invalid attempt history`)
      }
      attemptIds.add(attempt.attemptId)
      globalAttemptIds.add(attempt.attemptId)
      attemptsById.set(attempt.attemptId, { assignment, attempt })
    })
    if (assignment.attempts.length === 0 && assignment.status !== "planned") {
      failState(`assignment ${assignment.assignmentId} has status without an attempt`)
    }
    if (assignment.attempts.length > 0 && assignment.status !== assignment.attempts.at(-1).status) {
      failState(`assignment ${assignment.assignmentId} status disagrees with its latest attempt`)
    }
  }
  const readyAssignments = [...unresolvedDependencies].filter(([, refs]) => refs.size === 0).map(([id]) => id)
  let visitedAssignments = 0
  while (readyAssignments.length > 0) {
    const current = readyAssignments.shift()
    visitedAssignments += 1
    for (const [assignmentId, refs] of unresolvedDependencies) {
      if (!refs.delete(current) || refs.size > 0) continue
      readyAssignments.push(assignmentId)
    }
  }
  if (visitedAssignments !== state.workGraph.assignments.length) failState("assignment dependencies must be acyclic")
  assertUniqueBy(state.pendingOperations, "operationId", "pending operation ids")
  const pendingById = new Map(state.pendingOperations.map((operation) => [operation.operationId, operation]))
  for (const operation of state.pendingOperations) {
    if (operation.status === "in-doubt" && (!operation.invocationId || !operation.leaseExpiresAt)) {
      failState("in-doubt operation must retain its invocation lease")
    }
    if (operation.status === "intent-persisted" && (operation.invocationId || operation.leaseExpiresAt)) {
      failState("a retryable effect intent cannot retain an old invocation lease")
    }
    if (operation.kind === "execution.ensure") {
      if (!["dispatch", "continuation"].includes(operation.purpose)) {
        failState("execution ensure operation must declare dispatch or continuation purpose")
      }
      try {
        validateContract(
          "https://team-work-runtime.dev/schemas/v2/execution-port#/$defs/dispatchEffect",
          operation.intent,
          "pending dispatch intent",
        )
      } catch (error) {
        if (error instanceof ContractError) failState("execution operation intent does not match its contract", error.errors)
        throw error
      }
      const binding = attemptsById.get(operation.attemptId)
      if (
        !binding
        || binding.assignment.assignmentId !== operation.assignmentId
        || (operation.purpose === "dispatch" && binding.attempt.operationId !== operation.operationId)
        || (operation.purpose === "dispatch" && binding.attempt.effectDigest !== operation.effectDigest)
        || (operation.purpose === "continuation" && binding.attempt.executionRef !== operation.intent.resumeExecutionRef)
        || operation.intent.operationId !== operation.operationId
        || operation.intent.effectDigest !== operation.effectDigest
        || digestEffect(operation.intent) !== operation.effectDigest
      ) failState("execution operation must bind exactly one assignment attempt")
    } else if (operation.kind === "execution.stop") {
      if (operation.purpose !== "stop") failState("execution stop operation must declare stop purpose")
      try {
        validateContract(
          "https://team-work-runtime.dev/schemas/v2/execution-port#/$defs/stopIntent",
          operation.intent,
          "pending stop intent",
        )
      } catch (error) {
        if (error instanceof ContractError) failState("stop operation intent does not match its contract", error.errors)
        throw error
      }
      const binding = attemptsById.get(operation.attemptId)
      if (
        !binding
        || binding.assignment.assignmentId !== operation.assignmentId
        || binding.attempt.executionRef !== operation.intent.executionRef
        || operation.intent.operationId !== operation.operationId
        || operation.intent.effectDigest !== operation.effectDigest
        || digestEffect(operation.intent) !== operation.effectDigest
      ) failState("stop operation must bind exactly one running assignment attempt")
    }
  }
  for (const { assignment, attempt } of attemptsById.values()) {
    const pending = pendingById.get(attempt.operationId)
    if (["effect-pending", "in-doubt"].includes(attempt.status)) {
      if (!attempt.operationId || !attempt.effectDigest || !pending) {
        failState(`assignment ${assignment.assignmentId} has an untracked external effect`)
      }
    }
    if (["running", "reported", "verified", "accepted"].includes(attempt.status)) {
      if (!attempt.operationId || !attempt.effectDigest || !attempt.receiptRef || !attempt.executionRef || pending) {
        failState(`assignment ${assignment.assignmentId} cannot be ${attempt.status} without a confirmed receipt`)
      }
    }
    if (["reported", "verified", "accepted"].includes(attempt.status) && (!attempt.reportRef || !attempt.reportDigest)) {
      failState(`assignment ${assignment.assignmentId} cannot be ${attempt.status} without a durable member report`)
    }
  }
  if (state.stagePlan === null && state.workGraph.assignments.length > 0) {
    failState("a work graph cannot exist without a frozen stage plan")
  }
  if (state.stagePlan !== null) {
    if (state.stagePlan.stageRunId !== state.currentStageRun.stageRunId) failState("stage plan must target the current stage run")
    if (state.stagePlan.assignments.length !== assignmentIds.size || state.stagePlan.assignments.some((id) => !assignmentIds.has(id))) {
      failState("stage plan assignment refs must exactly match the work graph")
    }
  }

  assertUniqueBy(state.artifacts, "artifactId", "artifact ids")
  const artifacts = new Map(state.artifacts.map((artifact) => [artifact.artifactId, artifact]))
  const runIds = new Set(runs.map(({ stageRunId }) => stageRunId))
  if (state.artifacts.some((artifact) => !runIds.has(artifact.stageRunId))) failState("artifact stage run must exist")
  if (state.artifacts.some((artifact) => artifact.path.split("/").some((segment) => segment === "" || segment === "." || segment === ".."))) {
    failState("artifact paths must contain only safe project-relative segments")
  }
  assertUniqueBy(state.evidence, "evidenceId", "evidence ids")
  for (const evidence of state.evidence) {
    if (!runIds.has(evidence.stageRunId)) failState("evidence stage run must exist")
    if (evidence.valid && evidence.invalidation) failState("valid evidence cannot carry invalidation metadata")
    if (!evidence.valid && !evidence.invalidation) failState("invalid evidence must explain its invalidation")
    const digestRefs = Object.keys(evidence.artifactDigests).sort()
    const artifactRefs = [...evidence.artifactRefs].sort()
    if (canonicalStringList(digestRefs) !== canonicalStringList(artifactRefs)) failState("evidence artifact snapshot contains mismatched refs")
    for (const artifactId of evidence.artifactRefs) {
      const artifact = artifacts.get(artifactId)
      if (!artifact || !(artifactId in evidence.artifactDigests)) failState("evidence artifact snapshot is incomplete")
      if (evidence.valid && evidence.artifactDigests[artifactId] !== artifact.digest) {
        failState("valid evidence cannot reference a stale artifact digest")
      }
    }
  }
  assertUniqueBy(state.acceptedReportRefs, "reportId", "accepted report ids")
  const inbox = state.observationInbox
  if (inbox.nextSequence !== inbox.acknowledgedThrough + inbox.items.length + 1) {
    failState("observation inbox sequence must be contiguous")
  }
  inbox.items.forEach((item, index) => {
    if (item.sequence !== inbox.acknowledgedThrough + index + 1) failState("observation inbox items must remain ordered")
  })
  assertUniqueBy(inbox.items, "observationId", "pending observation ids")
  assertUniqueBy(inbox.items, "dedupeKey", "pending observation dedupe keys")
  assertUniqueBy(inbox.dedupe, "observationId", "observation dedupe ids")
  assertUniqueBy(inbox.dedupe, "dedupeKey", "observation dedupe keys")
  assertUniqueBy(inbox.dedupe, "sequence", "observation dedupe sequences")
  if (inbox.dedupe.length !== inbox.nextSequence - 1) failState("observation dedupe summary must retain every allocated sequence")
  if (inbox.dedupe.some((entry) => entry.stateRevision > state.revision)) {
    failState("observation dedupe revision cannot be newer than task state")
  }
  const dedupeBySequence = new Map(inbox.dedupe.map((entry) => [entry.sequence, entry]))
  for (const item of inbox.items) {
    const summary = dedupeBySequence.get(item.sequence)
    if (!summary || summary.observationId !== item.observationId || summary.dedupeKey !== item.dedupeKey || summary.digest !== item.digest) {
      failState("pending observation must match its retained dedupe summary")
    }
  }
  if (state.costLedger.forecastMin > state.costLedger.forecastMax) failState("cost forecast range is inverted")
  if (state.status === "completed" && state.currentStageRun.status !== "completed") {
    failState("a completed task must have a completed current stage run")
  }
  if (state.currentStageRun.status === "completed" && state.status !== "completed") {
    failState("a completed current stage run requires a completed task")
  }
  return state
}

function canonicalStringList(values) {
  return JSON.stringify(values)
}
