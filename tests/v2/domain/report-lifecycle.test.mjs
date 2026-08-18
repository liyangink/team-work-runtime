import assert from "node:assert/strict"
import test from "node:test"

import { createTaskAggregate, digestEffect, digestValue, reduceTask } from "../../../runtime/domain/index.mjs"
import { compiledPlanMetadata, TEST_AGENT_CATALOG_DIGEST, TEST_TASK_INTENT } from "../support/compiled-plan.mjs"

const workflow = {
  workflowId: "engineering",
  version: "2026-08-18",
  digest: "a".repeat(64),
  stages: ["implementation"],
  edges: [],
  terminalStages: ["implementation"],
}

function reportedState() {
  let state = createTaskAggregate({
    taskId: "report-lifecycle",
    title: "Verify one delivery",
    objective: "Keep report acceptance deterministic",
    workflow,
    entryStage: "implementation",
    completion: { mode: "through-stage", stage: "implementation" },
    stageRunId: "stage-run-1",
    createdAt: "2026-08-18T10:00:00.000Z",
  })
  state = reduceTask(state, {
    type: "stage-plan.frozen",
    taskIntent: TEST_TASK_INTENT,
    expectedRevision: state.revision,
    occurredAt: "2026-08-18T10:01:00.000Z",
    plan: {
      ...compiledPlanMetadata({ workflow }),
      planId: "plan-report",
      stageRunId: "stage-run-1",
      objective: "Produce source",
      inputRefs: ["artifact:requirement"],
      outputRefs: ["artifact:source"],
      assignments: [{
        assignmentId: "owner-source",
        teamRole: "owner",
        assignmentKind: "implementation",
        costTier: "junior",
        dependsOn: [],
        readableRefs: ["artifact:requirement"],
        writableRefs: ["artifact:source"],
        completionCriteria: ["submit source and evidence"],
        execution: {
          agentId: "junior-luna",
          capabilitySnapshotDigest: TEST_AGENT_CATALOG_DIGEST,
          contextRef: ".team-work/tasks/report-lifecycle/context/owner.md",
          promptRef: ".team-work/tasks/report-lifecycle/prompts/owner.md",
        },
      }],
    },
    costLedger: { forecastMin: 1, forecastMax: 3, accrued: 0, uncertain: 0, nextWave: 1, automaticLimit: 10 },
  }).state
  const effect = {
    operationId: "dispatch-report",
    effectDigest: "0".repeat(64),
    taskId: state.taskId,
    stageRunId: state.currentStageRun.stageRunId,
    assignmentId: "owner-source",
    attempt: 1,
    role: "owner",
    assignmentKind: "implementation",
    agentId: "junior-luna",
    capabilitySnapshotDigest: TEST_AGENT_CATALOG_DIGEST,
    mode: "background",
    contextRef: ".team-work/tasks/report-lifecycle/context/owner.md",
    promptRef: ".team-work/tasks/report-lifecycle/prompts/owner.md",
  }
  effect.effectDigest = digestEffect(effect)
  state = reduceTask(state, {
    type: "assignment.attempt-started",
    expectedRevision: state.revision,
    occurredAt: "2026-08-18T10:02:00.000Z",
    assignmentId: "owner-source",
    stageRunId: "stage-run-1",
    attemptId: "owner-source-attempt-1",
    attempt: 1,
    effect,
  }).state
  state = reduceTask(state, {
    type: "effect.invocation-started",
    expectedRevision: state.revision,
    occurredAt: "2026-08-18T10:03:00.000Z",
    operationId: effect.operationId,
    invocationId: "invoke-report",
    leaseExpiresAt: "2026-08-18T10:04:00.000Z",
  }).state
  state = reduceTask(state, {
    type: "effect.confirmed",
    expectedRevision: state.revision,
    occurredAt: "2026-08-18T10:03:30.000Z",
    operationId: effect.operationId,
    receipt: {
      operationId: effect.operationId,
      effectDigest: effect.effectDigest,
      status: "confirmed",
      executionRef: "session-owner",
      agentId: "junior-luna",
      observedAt: "2026-08-18T10:03:30.000Z",
    },
  }).state
  const reportValue = {
    reportId: "report-owner",
    taskId: state.taskId,
    assignmentId: "owner-source",
    attemptId: "owner-source-attempt-1",
    executionRef: "session-owner",
    report: {
      outcome: "delivered",
      summary: "Source implemented and checked.",
      artifacts: [{ ref: "artifact:source", path: "src/feature.mjs" }],
      evidenceRefs: ["check:test"],
      recommendation: "accept",
    },
  }
  const reportDigest = digestValue(reportValue)
  state = reduceTask(state, {
    type: "observation.received",
    expectedRevision: state.revision,
    occurredAt: "2026-08-18T10:04:00.000Z",
    item: {
      observationId: "observation-owner",
      sequence: 1,
      dedupeKey: "member-report:owner",
      digest: reportDigest,
      kind: "member-report",
      assignmentId: "owner-source",
      attemptId: "owner-source-attempt-1",
      executionRef: "session-owner",
      payloadRef: "reports/report-owner.json",
      receivedAt: "2026-08-18T10:04:00.000Z",
    },
  }).state
  state = reduceTask(state, {
    type: "observation.consumed",
    expectedRevision: state.revision,
    occurredAt: "2026-08-18T10:04:30.000Z",
    sequence: 1,
    observationId: "observation-owner",
    reportId: "report-owner",
  }).state
  return { state, reportDigest }
}

test("a durable member report must be verified before it can be accepted", () => {
  const { state: reported, reportDigest } = reportedState()
  assert.equal(reported.workGraph.assignments[0].status, "reported")

  assert.throws(() => reduceTask(reported, {
    type: "assignment.report-accepted",
    expectedRevision: reported.revision,
    occurredAt: "2026-08-18T10:05:00.000Z",
    assignmentId: "owner-source",
    attemptId: "owner-source-attempt-1",
    reportId: "report-owner",
    reportDigest,
  }), (error) => error.code === "REPORT_NOT_VERIFIED")

  const verified = reduceTask(reported, {
    type: "assignment.report-verified",
    expectedRevision: reported.revision,
    occurredAt: "2026-08-18T10:05:00.000Z",
    assignmentId: "owner-source",
    attemptId: "owner-source-attempt-1",
    reportId: "report-owner",
    reportDigest,
    artifacts: [{
      artifactId: "source",
      kind: "source",
      path: "src/runtime.mjs",
      digest: "c".repeat(64),
      stageRunId: "stage-run-1",
    }],
    evidence: [{
      evidenceId: "artifact-report-owner",
      kind: "artifact-digest",
      sourceRef: "report:report-owner",
      artifactRefs: ["source"],
      result: "pass",
      digest: "c".repeat(64),
      stageRunId: "stage-run-1",
    }],
  }).state
  assert.equal(verified.workGraph.assignments[0].status, "verified")
  assert.equal(verified.artifacts[0].path, "src/runtime.mjs")
  assert.equal(verified.evidence[0].sourceRef, "report:report-owner")

  const accepted = reduceTask(verified, {
    type: "assignment.report-accepted",
    expectedRevision: verified.revision,
    occurredAt: "2026-08-18T10:06:00.000Z",
    assignmentId: "owner-source",
    attemptId: "owner-source-attempt-1",
    reportId: "report-owner",
    reportDigest,
  }).state
  assert.equal(accepted.workGraph.assignments[0].status, "accepted")
  assert.deepEqual(accepted.acceptedReportRefs, [{ reportId: "report-owner", digest: reportDigest }])
})

test("report verification is bound to the immutable report identity and rework stays retryable", () => {
  const { state: reported, reportDigest } = reportedState()
  assert.throws(() => reduceTask(reported, {
    type: "assignment.report-verified",
    expectedRevision: reported.revision,
    occurredAt: "2026-08-18T10:05:00.000Z",
    assignmentId: "owner-source",
    attemptId: "owner-source-attempt-1",
    reportId: "report-other",
    reportDigest,
  }), (error) => error.code === "REPORT_BINDING_INVALID")

  const rework = reduceTask(reported, {
    type: "assignment.report-rejected",
    expectedRevision: reported.revision,
    occurredAt: "2026-08-18T10:05:00.000Z",
    assignmentId: "owner-source",
    attemptId: "owner-source-attempt-1",
    reportId: "report-owner",
    reportDigest,
    reason: "declared artifact is missing",
  }).state
  assert.equal(rework.workGraph.assignments[0].status, "rework")
  assert.equal(rework.workGraph.assignments[0].attempts[0].status, "rework")
  assert.equal(rework.workGraph.assignments[0].attempts[0].rejectionReason, "declared artifact is missing")
})

test("report verification records artifacts and evidence atomically", () => {
  const { state: reported, reportDigest } = reportedState()
  assert.throws(() => reduceTask(reported, {
    type: "assignment.report-verified",
    expectedRevision: reported.revision,
    occurredAt: "2026-08-18T10:05:00.000Z",
    assignmentId: "owner-source",
    attemptId: "owner-source-attempt-1",
    reportId: "report-owner",
    reportDigest,
    artifacts: [{
      artifactId: "source",
      kind: "source",
      path: "src/runtime.mjs",
      digest: "c".repeat(64),
      stageRunId: "stage-run-1",
    }],
    evidence: [{
      evidenceId: "invalid-artifact-evidence",
      kind: "artifact-digest",
      sourceRef: "report:report-owner",
      artifactRefs: ["missing-artifact"],
      result: "pass",
      stageRunId: "stage-run-1",
    }],
  }), (error) => error.code === "EVIDENCE_ARTIFACT_UNKNOWN")
  assert.equal(reported.workGraph.assignments[0].status, "reported")
  assert.deepEqual(reported.artifacts, [])
  assert.deepEqual(reported.evidence, [])
})
