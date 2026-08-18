import assert from "node:assert/strict"
import test from "node:test"

import { createTaskAggregate, reduceTask } from "../../../runtime/domain/index.mjs"
import { compiledPlanMetadata, TEST_AGENT_CATALOG_DIGEST, TEST_TASK_INTENT } from "../support/compiled-plan.mjs"

const workflow = {
  workflowId: "engineering",
  version: "2026-08-18",
  digest: "a".repeat(64),
  stages: ["design"],
  edges: [],
  terminalStages: ["design"],
}

function preflightPlan() {
  return {
    ...compiledPlanMetadata({ workflow }),
    preflightKind: "planning-bootstrap",
    planId: "preflight-plan-1",
    stageRunId: "stage-run-1",
    objective: "Plan the design",
    inputRefs: ["artifact:requirement"],
    outputRefs: ["artifact:stage-plan-proposal:stage-run-1"],
    assignments: [{
      assignmentId: "planning-owner",
      teamRole: "owner",
      assignmentKind: "planning",
      costTier: "junior",
      dependsOn: [],
      readableRefs: ["artifact:requirement"],
      writableRefs: ["artifact:stage-plan-proposal:stage-run-1"],
      completionCriteria: ["submit a structured proposal"],
      execution: {
        agentId: "junior-luna",
        capabilitySnapshotDigest: TEST_AGENT_CATALOG_DIGEST,
        contextRef: ".team-work/tasks/preflight/context/owner.md",
        promptRef: ".team-work/tasks/preflight/prompts/owner.md",
      },
    }],
  }
}

test("a preflight owns the executable graph without becoming the formal StagePlan", () => {
  const initial = createTaskAggregate({
    taskId: "preflight",
    title: "Plan a complex design",
    objective: "Produce a durable plan proposal first",
    workflow,
    entryStage: "design",
    completion: { mode: "through-stage", stage: "design" },
    stageRunId: "stage-run-1",
    createdAt: "2026-08-18T10:00:00.000Z",
  })
  const started = reduceTask(initial, {
    type: "preflight.started",
    expectedRevision: 0,
    occurredAt: "2026-08-18T10:01:00.000Z",
    taskIntent: TEST_TASK_INTENT,
    plan: preflightPlan(),
    costLedger: { forecastMin: 1, forecastMax: 3, accrued: 0, uncertain: 0, nextWave: 1, automaticLimit: 20 },
  }).state

  assert.equal(started.stagePlan, null)
  assert.equal(started.preflight.kind, "planning-bootstrap")
  assert.equal(started.preflight.status, "active")
  assert.equal(started.preflight.plan.preflightKind, undefined)
  assert.deepEqual(started.preflight.plan.assignments, ["planning-owner"])
  assert.deepEqual(started.workGraph.assignments.map(({ assignmentId }) => assignmentId), ["planning-owner"])

  assert.throws(() => reduceTask(started, {
    type: "stage-plan.frozen",
    expectedRevision: started.revision,
    occurredAt: "2026-08-18T10:02:00.000Z",
    plan: { ...preflightPlan(), preflightKind: undefined },
    costLedger: started.costLedger,
  }), (error) => error.code === "PREFLIGHT_NOT_SATISFIED")
})

test("a preflight plan cannot be installed through the formal StagePlan fact", () => {
  const initial = createTaskAggregate({
    taskId: "preflight-rejected",
    title: "Reject disguised preflight",
    objective: "Keep the formal plan immutable",
    workflow,
    entryStage: "design",
    completion: { mode: "through-stage", stage: "design" },
    stageRunId: "stage-run-1",
    createdAt: "2026-08-18T10:00:00.000Z",
  })
  assert.throws(() => reduceTask(initial, {
    type: "stage-plan.frozen",
    expectedRevision: 0,
    occurredAt: "2026-08-18T10:01:00.000Z",
    taskIntent: TEST_TASK_INTENT,
    plan: preflightPlan(),
    costLedger: { forecastMin: 1, forecastMax: 3, accrued: 0, uncertain: 0, nextWave: 1, automaticLimit: 20 },
  }), (error) => error.code === "STAGE_PLAN_PREFLIGHT")
})
