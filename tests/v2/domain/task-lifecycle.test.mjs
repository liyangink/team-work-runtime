import assert from "node:assert/strict"
import test from "node:test"

import {
  DomainError,
  assertTaskState,
  createTaskAggregate,
  digestValue,
  projectStageScope,
  reduceTask,
} from "../../../runtime/domain/index.mjs"
import { compiledPlanMetadata, TEST_AGENT_CATALOG_DIGEST, TEST_TASK_INTENT } from "../support/compiled-plan.mjs"

const digest = "a".repeat(64)
const execution = {
  agentId: "test-agent",
  capabilitySnapshotDigest: TEST_AGENT_CATALOG_DIGEST,
  contextRef: ".team-work/context/member.md",
  promptRef: ".team-work/prompts/assignment.md",
}

const workflow = {
  workflowId: "engineering",
  version: "2026-08-18",
  digest,
  stages: ["research", "design", "implementation", "code-review", "done"],
  edges: [
    { from: "research", to: "design" },
    { from: "design", to: "implementation" },
    { from: "implementation", to: "code-review" },
    { from: "code-review", to: "implementation" },
    { from: "code-review", to: "done" },
  ],
  terminalStages: ["done"],
}

test("a task can enter at any declared stage and stop at a local completion stage", () => {
  const state = createTaskAggregate({
    taskId: "review-existing-code",
    title: "Review existing code",
    objective: "Review the current implementation without replaying earlier stages",
    workflow,
    entryStage: "code-review",
    completion: { mode: "through-stage", stage: "code-review" },
    stageRunId: "stage-run-1",
    createdAt: "2026-08-18T10:00:00.000Z",
  })

  assert.equal(state.runtimeMajor, 2)
  assert.equal(state.revision, 0)
  assert.equal(state.status, "needs-plan")
  assert.equal(state.currentStageRun.stage, "code-review")
  assert.equal(state.currentStageRun.status, "planned")
  assert.deepEqual(state.scope.stages, ["code-review"])
  assert.deepEqual(state.scope.edges, [])
  assert.deepEqual(state.scope.completionStages, ["code-review"])
  assert.equal(state.taskIntent, null)
  assert.equal(state.taskIntentRevision, 0)
  assert.deepEqual(state.taskIntentHistory, [])
})

test("TaskIntent is recorded once and remains the inherited source for later stage plans", () => {
  const initial = createTaskAggregate({
    taskId: "intent-inheritance",
    title: "Keep task intent",
    objective: "Implement and review the requested behavior",
    workflow,
    entryStage: "implementation",
    completion: { mode: "through-stage", stage: "code-review" },
    stageRunId: "stage-run-1",
    createdAt: "2026-08-18T10:00:00.000Z",
  })
  const intent = {
    objective: "Implement and review the requested behavior",
    constraints: ["preserve public API"],
    exclusions: ["unrelated refactors"],
    preferences: { execution: "auto", budget: "balanced", risk: "normal" },
  }
  const recorded = reduceTask(initial, {
    type: "task-intent.recorded",
    expectedRevision: 0,
    intent,
    occurredAt: "2026-08-18T10:01:00.000Z",
  }).state

  assert.deepEqual(recorded.taskIntent, intent)
  assert.throws(
    () => reduceTask(recorded, {
      type: "task-intent.recorded",
      expectedRevision: 1,
      intent: { ...intent, objective: "silently replace the task" },
      occurredAt: "2026-08-18T10:02:00.000Z",
    }),
    (error) => error instanceof DomainError && error.code === "TASK_INTENT_ALREADY_RECORDED",
  )
})

test("the pure reducer advances only across a declared edge and starts a new stage run", () => {
  const initial = createTaskAggregate({
    taskId: "implement-and-review",
    title: "Implement and review",
    objective: "Complete implementation and code review",
    workflow,
    entryStage: "implementation",
    completion: { mode: "through-stage", stage: "code-review" },
    stageRunId: "stage-run-1",
    createdAt: "2026-08-18T10:00:00.000Z",
  })
  const snapshot = structuredClone(initial)

  let state = initial
  for (const [index, status] of ["dispatching", "waiting-reports", "reviewing", "ready-to-advance"].entries()) {
    state = reduceTask(state, {
      type: "stage-run.transitioned",
      expectedRevision: index,
      status,
      occurredAt: `2026-08-18T10:0${index + 1}:00.000Z`,
    }).state
  }

  assert.throws(
    () => reduceTask(state, {
      type: "stage.advanced",
      expectedRevision: 4,
      to: "done",
      nextStageRunId: "stage-run-invalid",
      occurredAt: "2026-08-18T10:05:00.000Z",
    }),
    (error) => error instanceof DomainError && error.code === "STAGE_EDGE_INVALID",
  )

  const result = reduceTask(state, {
    type: "stage.advanced",
    expectedRevision: 4,
    to: "code-review",
    nextStageRunId: "stage-run-2",
    occurredAt: "2026-08-18T10:05:00.000Z",
  })

  assert.deepEqual(initial, snapshot)
  assert.equal(result.state.revision, 5)
  assert.equal(result.state.currentStageRun.stageRunId, "stage-run-2")
  assert.equal(result.state.currentStageRun.stage, "code-review")
  assert.equal(result.state.currentStageRun.sequence, 2)
  assert.equal(result.state.currentStageRun.status, "planned")
  assert.equal(result.state.stageRuns[0].stageRunId, "stage-run-1")
  assert.equal(result.state.stageRuns[0].status, "completed")
  assert.deepEqual(result.effects, [])
})

test("freezing a stage plan materializes a validated work graph and cost ledger", () => {
  const initial = createTaskAggregate({
    taskId: "planned-review",
    title: "Review with independent challenge",
    objective: "Review implementation evidence",
    workflow,
    entryStage: "code-review",
    completion: { mode: "through-stage", stage: "code-review" },
    stageRunId: "stage-run-1",
    createdAt: "2026-08-18T10:00:00.000Z",
  })
  const result = reduceTask(initial, {
    type: "stage-plan.frozen",
    taskIntent: TEST_TASK_INTENT,
    expectedRevision: 0,
    occurredAt: "2026-08-18T10:01:00.000Z",
    plan: {
      ...compiledPlanMetadata({ workflow, scopeStages: initial.scope.stages }),
      planId: "plan-1",
      stageRunId: "stage-run-1",
      objective: "Produce an evidence-backed code review",
      inputRefs: ["artifact:source"],
      outputRefs: ["artifact:review"],
      assignments: [
        {
          assignmentId: "review-owner",
          teamRole: "owner",
          assignmentKind: "review",
          costTier: "junior",
          dependsOn: [],
          readableRefs: ["artifact:source"],
          writableRefs: ["artifact:review"],
          completionCriteria: ["findings include evidence"],
          execution,
        },
        {
          assignmentId: "review-challenger",
          teamRole: "challenger",
          assignmentKind: "review",
          costTier: "senior",
          dependsOn: ["review-owner"],
          readableRefs: ["artifact:source", "artifact:review"],
          writableRefs: [],
          completionCriteria: ["challenge omissions and false positives"],
          execution,
        },
      ],
    },
    costLedger: {
      forecastMin: 11,
      forecastMax: 21,
      accrued: 0,
      uncertain: 0,
      nextWave: 1,
      automaticLimit: 21,
    },
  })

  assert.equal(result.state.stagePlan.planId, "plan-1")
  assert.deepEqual(result.state.workGraph.assignments.map(({ assignmentId, status, attempts }) => ({ assignmentId, status, attempts })), [
    { assignmentId: "review-owner", status: "planned", attempts: [] },
    { assignmentId: "review-challenger", status: "planned", attempts: [] },
  ])
  assert.deepEqual(result.state.costLedger, {
    forecastMin: 11,
    forecastMax: 21,
    accrued: 0,
    uncertain: 0,
    nextWave: 1,
    automaticLimit: 21,
  })
})

test("a controlled replan atomically revises TaskIntent and preserves its prior revision", () => {
  const initial = createTaskAggregate({
    taskId: "replan-review",
    title: "Replan a stable review",
    objective: "Replace a stale work graph safely",
    workflow,
    entryStage: "code-review",
    completion: { mode: "through-stage", stage: "code-review" },
    stageRunId: "stage-run-1",
    createdAt: "2026-08-18T10:00:00.000Z",
  })
  const planned = reduceTask(initial, {
    type: "stage-plan.frozen",
    taskIntent: TEST_TASK_INTENT,
    expectedRevision: 0,
    occurredAt: "2026-08-18T10:01:00.000Z",
    plan: {
      ...compiledPlanMetadata({ workflow, scopeStages: initial.scope.stages }),
      planId: "plan-replan",
      stageRunId: "stage-run-1",
      objective: "Review the current implementation",
      inputRefs: ["artifact:source"],
      outputRefs: ["artifact:review"],
      assignments: [{
        assignmentId: "review-owner",
        teamRole: "owner",
        assignmentKind: "review",
        costTier: "junior",
        dependsOn: [],
        readableRefs: ["artifact:source"],
        writableRefs: ["artifact:review"],
        completionCriteria: ["submit the review"],
        execution,
      }],
    },
    costLedger: { forecastMin: 1, forecastMax: 3, accrued: 0, uncertain: 0, nextWave: 1, automaticLimit: 20 },
  }).state

  const replanned = reduceTask(planned, {
    type: "stage.replanned",
    expectedRevision: planned.revision,
    nextStageRunId: "stage-run-2",
    reason: "Apply a newly confirmed scope constraint",
    taskIntent: {
      ...TEST_TASK_INTENT,
      constraints: ["preserve the public API"],
    },
    occurredAt: "2026-08-18T10:02:00.000Z",
  }).state

  assert.equal(replanned.status, "needs-plan")
  assert.equal(replanned.currentStageRun.stageRunId, "stage-run-2")
  assert.equal(replanned.currentStageRun.round, 2)
  assert.equal(replanned.stagePlan, null)
  assert.deepEqual(replanned.taskIntent.constraints, ["preserve the public API"])
  assert.equal(replanned.taskIntentRevision, 2)
  assert.equal(replanned.taskIntentHistory.length, 1)
  assert.deepEqual(replanned.taskIntentHistory[0].intent, TEST_TASK_INTENT)
  assert.equal(replanned.taskIntentHistory[0].stageRunId, "stage-run-1")
  assert.equal(replanned.stageRuns[0].status, "rework")
})

test("an assignment attempt is monotonic and belongs to the current stage run", () => {
  const initial = createTaskAggregate({
    taskId: "attempt-invariants",
    title: "Validate assignment attempts",
    objective: "Keep retries attributable to one work assignment",
    workflow,
    entryStage: "code-review",
    completion: { mode: "through-stage", stage: "code-review" },
    stageRunId: "stage-run-1",
    createdAt: "2026-08-18T10:00:00.000Z",
  })
  const planned = reduceTask(initial, {
    type: "stage-plan.frozen",
    taskIntent: TEST_TASK_INTENT,
    expectedRevision: 0,
    occurredAt: "2026-08-18T10:01:00.000Z",
    plan: {
      ...compiledPlanMetadata({ workflow, scopeStages: initial.scope.stages }),
      planId: "plan-1",
      stageRunId: "stage-run-1",
      objective: "Review one artifact",
      inputRefs: ["artifact:source"],
      outputRefs: ["artifact:review"],
      assignments: [{
        assignmentId: "review-owner",
        teamRole: "owner",
        assignmentKind: "review",
        costTier: "junior",
        dependsOn: [],
        readableRefs: ["artifact:source"],
        writableRefs: ["artifact:review"],
        completionCriteria: ["submit evidence-backed findings"],
        execution,
      }],
    },
    costLedger: {
      forecastMin: 1,
      forecastMax: 3,
      accrued: 0,
      uncertain: 0,
      nextWave: 1,
      automaticLimit: 3,
    },
  }).state

  const dispatchEffect = {
    operationId: "dispatch-operation-1",
    effectDigest: "0".repeat(64),
    taskId: "attempt-invariants",
    stageRunId: "stage-run-1",
    assignmentId: "review-owner",
    attempt: 1,
    role: "owner",
    assignmentKind: "review",
    agentId: "junior-luna",
    capabilitySnapshotDigest: TEST_AGENT_CATALOG_DIGEST,
    mode: "background",
    contextRef: ".team-work/tasks/attempt-invariants/context/owner.md",
    promptRef: ".team-work/tasks/attempt-invariants/prompts/review-owner.md",
  }
  dispatchEffect.effectDigest = digestValue({ ...dispatchEffect, effectDigest: undefined })
  const started = reduceTask(planned, {
    type: "assignment.attempt-started",
    expectedRevision: 1,
    occurredAt: "2026-08-18T10:02:00.000Z",
    assignmentId: "review-owner",
    stageRunId: "stage-run-1",
    attemptId: "review-owner-attempt-1",
    attempt: 1,
    operationId: "dispatch-operation-1",
    effect: dispatchEffect,
  }).state

  assert.equal(started.workGraph.assignments[0].status, "effect-pending")
  assert.deepEqual(started.workGraph.assignments[0].attempts, [{
    attemptId: "review-owner-attempt-1",
    attempt: 1,
    stageRunId: "stage-run-1",
    status: "effect-pending",
    startedAt: "2026-08-18T10:02:00.000Z",
    correctionCount: 0,
    operationId: "dispatch-operation-1",
    effectDigest: dispatchEffect.effectDigest,
  }])
  assert.deepEqual(started.pendingOperations, [{
    operationId: "dispatch-operation-1",
    kind: "execution.ensure",
    purpose: "dispatch",
    assignmentId: "review-owner",
    attemptId: "review-owner-attempt-1",
    effectDigest: dispatchEffect.effectDigest,
    status: "intent-persisted",
    invocationCount: 0,
    intent: dispatchEffect,
    createdAt: "2026-08-18T10:02:00.000Z",
  }])

  const impossibleRunning = structuredClone(started)
  impossibleRunning.workGraph.assignments[0].status = "running"
  impossibleRunning.workGraph.assignments[0].attempts[0].status = "running"
  impossibleRunning.pendingOperations = []
  assert.throws(
    () => assertTaskState(impossibleRunning),
    (error) => error instanceof DomainError && error.code === "STATE_INVALID",
  )
  assert.throws(
    () => reduceTask(started, {
      type: "assignment.attempt-started",
      expectedRevision: 2,
      occurredAt: "2026-08-18T10:03:00.000Z",
      assignmentId: "review-owner",
      stageRunId: "stage-run-1",
      attemptId: "review-owner-attempt-3",
      attempt: 3,
    }),
    (error) => error instanceof DomainError && error.code === "ASSIGNMENT_NOT_RETRYABLE",
  )
})

test("changing an artifact digest invalidates evidence captured from the old content", () => {
  let state = createTaskAggregate({
    taskId: "evidence-invalidation",
    title: "Invalidate stale evidence",
    objective: "Never approve changed artifacts with old evidence",
    workflow,
    entryStage: "code-review",
    completion: { mode: "through-stage", stage: "code-review" },
    stageRunId: "stage-run-1",
    createdAt: "2026-08-18T10:00:00.000Z",
  })
  state = reduceTask(state, {
    type: "artifact.recorded",
    expectedRevision: 0,
    occurredAt: "2026-08-18T10:01:00.000Z",
    artifact: {
      artifactId: "review-document",
      kind: "review",
      path: "docs/review.md",
      digest: "b".repeat(64),
      stageRunId: "stage-run-1",
    },
  }).state
  state = reduceTask(state, {
    type: "evidence.recorded",
    expectedRevision: 1,
    occurredAt: "2026-08-18T10:02:00.000Z",
    evidence: {
      evidenceId: "review-digest",
      kind: "artifact-digest",
      sourceRef: "runtime:artifact-verifier",
      artifactRefs: ["review-document"],
      result: "pass",
      digest: "c".repeat(64),
      stageRunId: "stage-run-1",
    },
  }).state

  assert.equal(state.evidence[0].valid, true)
  assert.deepEqual(state.evidence[0].artifactDigests, { "review-document": "b".repeat(64) })

  state = reduceTask(state, {
    type: "artifact.recorded",
    expectedRevision: 2,
    occurredAt: "2026-08-18T10:03:00.000Z",
    artifact: {
      artifactId: "review-document",
      kind: "review",
      path: "docs/review.md",
      digest: "d".repeat(64),
      stageRunId: "stage-run-1",
    },
  }).state

  assert.equal(state.artifacts[0].digest, "d".repeat(64))
  assert.equal(state.evidence[0].valid, false)
  assert.deepEqual(state.evidence[0].invalidation, {
    reason: "artifact-changed",
    artifactId: "review-document",
    invalidatedAt: "2026-08-18T10:03:00.000Z",
  })
})

test("a task completes only after its scoped completion stage is ready", () => {
  let state = createTaskAggregate({
    taskId: "scoped-completion",
    title: "Complete a local review",
    objective: "Stop after the requested review milestone",
    workflow,
    entryStage: "code-review",
    completion: { mode: "through-stage", stage: "code-review" },
    stageRunId: "stage-run-1",
    createdAt: "2026-08-18T10:00:00.000Z",
  })
  assert.throws(
    () => reduceTask(state, {
      type: "task.completed",
      expectedRevision: 0,
      occurredAt: "2026-08-18T10:01:00.000Z",
    }),
    (error) => error instanceof DomainError && error.code === "STAGE_NOT_READY",
  )
  for (const [index, status] of ["dispatching", "waiting-reports", "reviewing", "ready-to-advance"].entries()) {
    state = reduceTask(state, {
      type: "stage-run.transitioned",
      expectedRevision: index,
      status,
      occurredAt: `2026-08-18T10:0${index + 1}:00.000Z`,
    }).state
  }

  const completed = reduceTask(state, {
    type: "task.completed",
    expectedRevision: 4,
    occurredAt: "2026-08-18T10:05:00.000Z",
  }).state

  assert.equal(completed.status, "completed")
  assert.equal(completed.currentStageRun.status, "completed")
  assert.equal(completed.currentStageRun.completedAt, "2026-08-18T10:05:00.000Z")
})

test("rework opens a new stage run so old reports cannot satisfy the new round", () => {
  let state = createTaskAggregate({
    taskId: "review-rework",
    title: "Rework a review finding",
    objective: "Keep every convergence round attributable",
    workflow,
    entryStage: "code-review",
    completion: { mode: "through-stage", stage: "code-review" },
    stageRunId: "stage-run-1",
    createdAt: "2026-08-18T10:00:00.000Z",
  })
  for (const [index, status] of ["dispatching", "waiting-reports", "reviewing"].entries()) {
    state = reduceTask(state, {
      type: "stage-run.transitioned",
      expectedRevision: index,
      status,
      occurredAt: `2026-08-18T10:0${index + 1}:00.000Z`,
    }).state
  }

  state = reduceTask(state, {
    type: "stage.reopened",
    expectedRevision: 3,
    occurredAt: "2026-08-18T10:04:00.000Z",
    nextStageRunId: "stage-run-2",
    reason: "challenger found an unsupported conclusion",
  }).state

  assert.deepEqual(state.currentStageRun, {
    stageRunId: "stage-run-2",
    sequence: 2,
    round: 2,
    stage: "code-review",
    status: "planned",
  })
  assert.equal(state.stageRuns[0].status, "rework")
  assert.equal(state.stageRuns[0].reason, "challenger found an unsupported conclusion")
  assert.equal(state.stagePlan, null)
  assert.deepEqual(state.workGraph, { assignments: [] })
})

test("task state validation rejects cross-field corruption that JSON shape alone cannot catch", () => {
  const state = createTaskAggregate({
    taskId: "state-integrity",
    title: "Protect aggregate integrity",
    objective: "Reject snapshots with impossible current stages",
    workflow,
    entryStage: "code-review",
    completion: { mode: "through-stage", stage: "code-review" },
    stageRunId: "stage-run-1",
    createdAt: "2026-08-18T10:00:00.000Z",
  })
  assert.equal(assertTaskState(state), state)

  const corrupt = structuredClone(state)
  corrupt.currentStageRun.stage = "research"
  assert.throws(
    () => assertTaskState(corrupt),
    (error) => error instanceof DomainError && error.code === "STATE_INVALID",
  )

  const impossibleCurrentRun = structuredClone(state)
  impossibleCurrentRun.currentStageRun.status = "rework"
  assert.throws(
    () => assertTaskState(impossibleCurrentRun),
    (error) => error instanceof DomainError && error.code === "STATE_INVALID",
  )
})

test("workflow completion projects only stages on a reachable path to a terminal", () => {
  const scope = projectStageScope(workflow, "implementation", { mode: "workflow" })
  assert.deepEqual(scope.stages, ["implementation", "code-review", "done"])
  assert.deepEqual(scope.completionStages, ["done"])

  assert.throws(
    () => projectStageScope(workflow, "done", { mode: "through-stage", stage: "research" }),
    (error) => error instanceof DomainError && error.code === "COMPLETION_UNREACHABLE",
  )
})

test("task snapshots cannot smuggle dependency cycles or product writes into review roles", () => {
  const initial = createTaskAggregate({
    taskId: "corrupt-work-graph",
    title: "Reject corrupt work graphs",
    objective: "Keep role and dependency invariants authoritative",
    workflow,
    entryStage: "code-review",
    completion: { mode: "through-stage", stage: "code-review" },
    stageRunId: "stage-run-1",
    createdAt: "2026-08-18T10:00:00.000Z",
  })
  const planned = reduceTask(initial, {
    type: "stage-plan.frozen",
    taskIntent: TEST_TASK_INTENT,
    expectedRevision: 0,
    occurredAt: "2026-08-18T10:01:00.000Z",
    plan: {
      ...compiledPlanMetadata({ workflow, scopeStages: initial.scope.stages }),
      planId: "plan-1",
      stageRunId: "stage-run-1",
      objective: "Review independently",
      inputRefs: ["artifact:source"],
      outputRefs: ["artifact:review"],
      assignments: [
        {
          assignmentId: "owner-1",
          teamRole: "owner",
          assignmentKind: "review",
          costTier: "junior",
          dependsOn: [],
          readableRefs: ["artifact:source"],
          writableRefs: ["artifact:review"],
          completionCriteria: ["write review"],
          execution,
        },
        {
          assignmentId: "challenger-1",
          teamRole: "challenger",
          assignmentKind: "review",
          costTier: "senior",
          dependsOn: ["owner-1"],
          readableRefs: ["artifact:review"],
          writableRefs: [],
          completionCriteria: ["challenge review"],
          execution,
        },
      ],
    },
    costLedger: {
      forecastMin: 11,
      forecastMax: 11,
      accrued: 0,
      uncertain: 0,
      nextWave: 1,
      automaticLimit: 11,
    },
  }).state

  const cyclic = structuredClone(planned)
  cyclic.workGraph.assignments[0].dependsOn = ["challenger-1"]
  assert.throws(() => assertTaskState(cyclic), (error) => error.code === "STATE_INVALID")

  const unauthorizedWrite = structuredClone(planned)
  unauthorizedWrite.workGraph.assignments[1].writableRefs = ["artifact:source"]
  assert.throws(() => assertTaskState(unauthorizedWrite), (error) => error.code === "STATE_INVALID")
})

test("parallel owners cannot share writable refs unless the work graph serializes them", () => {
  const owner = (assignmentId, dependsOn, writableRef = "artifact:shared-output") => ({
    assignmentId,
    teamRole: "owner",
    assignmentKind: "implementation",
    costTier: "junior",
    dependsOn,
    readableRefs: ["artifact:source"],
    writableRefs: [writableRef],
    completionCriteria: ["produce result"],
    execution,
  })
  const base = createTaskAggregate({
    taskId: "writable-conflict",
    title: "Reject overlapping parallel writes",
    objective: "Prevent two owners from racing on one product artifact",
    workflow,
    entryStage: "implementation",
    completion: { mode: "through-stage", stage: "code-review" },
    stageRunId: "stage-run-1",
    createdAt: "2026-08-18T10:00:00.000Z",
  })
  const fact = {
    type: "stage-plan.frozen",
    taskIntent: TEST_TASK_INTENT,
    expectedRevision: 0,
    occurredAt: "2026-08-18T10:01:00.000Z",
    plan: {
      ...compiledPlanMetadata({ workflow, scopeStages: base.scope.stages }),
      teamMode: "team",
      planId: "plan-writes",
      stageRunId: "stage-run-1",
      objective: "Produce one shared output safely",
      inputRefs: ["artifact:source"],
      outputRefs: ["artifact:shared-output"],
      assignments: [owner("owner-a", []), owner("owner-b", [])],
    },
    costLedger: { forecastMin: 2, forecastMax: 4, accrued: 0, uncertain: 0, nextWave: 2, automaticLimit: 4 },
  }

  assert.throws(
    () => reduceTask(base, fact),
    (error) => error instanceof DomainError && error.code === "WORK_GRAPH_WRITE_CONFLICT",
  )

  fact.plan.assignments[1] = owner("owner-b", ["owner-a"])
  const serialized = reduceTask(base, fact).state
  assert.equal(serialized.workGraph.assignments.length, 2)

  fact.plan.assignments = [
    owner("owner-a", []),
    owner("integration-owner", ["owner-a"], "artifact:integration"),
    owner("owner-c", ["integration-owner"]),
  ]
  const transitivelySerialized = reduceTask(base, fact).state
  assert.equal(transitivelySerialized.workGraph.assignments.length, 3)

  const corrupted = structuredClone(transitivelySerialized)
  corrupted.workGraph.assignments.find(({ assignmentId }) => assignmentId === "owner-c").dependsOn = []
  assert.throws(
    () => assertTaskState(corrupted),
    (error) => error instanceof DomainError && error.code === "STATE_INVALID",
  )
})

test("work graphs accept every assignment kind declared by the Runtime architecture", () => {
  const kinds = [
    "planning",
    "research",
    "design",
    "spec",
    "implementation",
    "integration",
    "test",
    "review",
    "e2e",
    "evidence",
    "e2e-applicability",
    "custom:security-audit",
  ]
  for (const [index, assignmentKind] of kinds.entries()) {
    const state = createTaskAggregate({
      taskId: `assignment-kind-${index}`,
      title: `Validate ${assignmentKind}`,
      objective: "Keep assignment kinds orthogonal to roles and cost tiers",
      workflow,
      entryStage: "code-review",
      completion: { mode: "through-stage", stage: "code-review" },
      stageRunId: "stage-run-1",
      createdAt: "2026-08-18T10:00:00.000Z",
    })
    assert.doesNotThrow(() => reduceTask(state, {
      type: "stage-plan.frozen",
      taskIntent: TEST_TASK_INTENT,
      expectedRevision: 0,
      occurredAt: "2026-08-18T10:01:00.000Z",
      plan: {
        ...compiledPlanMetadata({ workflow, scopeStages: state.scope.stages }),
        planId: "plan-1",
        stageRunId: "stage-run-1",
        objective: "Validate one assignment kind",
        inputRefs: [],
        outputRefs: ["artifact:result"],
        assignments: [{
          assignmentId: "owner-1",
          teamRole: "owner",
          assignmentKind,
          costTier: "junior",
          dependsOn: [],
          readableRefs: [],
          writableRefs: ["artifact:result"],
          completionCriteria: ["produce result"],
          execution,
        }],
      },
      costLedger: {
        forecastMin: 1,
        forecastMax: 1,
        accrued: 0,
        uncertain: 0,
        nextWave: 1,
        automaticLimit: 1,
      },
    }))
  }
})
