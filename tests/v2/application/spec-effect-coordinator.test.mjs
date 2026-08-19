import assert from "node:assert/strict"
import test from "node:test"

import { createTaskDriver } from "../../../runtime/application/driver.mjs"
import { createTaskAggregate, digestValue, reduceTask } from "../../../runtime/domain/index.mjs"
import { createInMemoryStore } from "../../../runtime/persistence/index.mjs"
import { createFakeExecutionAdapter, createFakeSpecProvider } from "../../../runtime/testing/fakes.mjs"
import { compiledPlanMetadata, TEST_AGENT_CATALOG_DIGEST, TEST_TASK_INTENT } from "../support/compiled-plan.mjs"

const workflow = {
  workflowId: "engineering",
  version: "2026-08-19",
  digest: "a".repeat(64),
  stages: ["spec", "finish"],
  edges: [{ from: "spec", to: "finish", outcome: "pass" }],
  terminalStages: ["finish"],
}

function specMetadata() {
  const metadata = compiledPlanMetadata({ workflow })
  const body = {
    mode: "required",
    configDigest: "d".repeat(64),
    probeDigest: "e".repeat(64),
    decision: "use-provider",
    reason: "provider-ready",
  }
  metadata.routes.spec = { ...body, digest: digestValue(body) }
  metadata.costProjection.specDecision = "use-provider"
  return metadata
}

async function createPlannedTask(store, taskId = "spec-effects") {
  let state = createTaskAggregate({
    taskId,
    title: "Prepare a SPEC capability",
    objective: "Prove durable SPEC effects",
    workflow,
    entryStage: "spec",
    completion: { mode: "workflow" },
    stageRunId: "stage-run-1",
    createdAt: "2026-08-19T10:00:00.000Z",
    artifacts: [{
      artifactId: "design",
      kind: "design",
      path: "docs/design.md",
      digest: "f".repeat(64),
      stageRunId: "stage-run-1",
      recordedAt: "2026-08-19T10:00:00.000Z",
    }],
  })
  await store.createTask(state)
  state = reduceTask(state, {
    type: "stage-plan.frozen",
    expectedRevision: 0,
    taskIntent: TEST_TASK_INTENT,
    plan: {
      ...specMetadata(),
      planId: "spec-plan",
      stageRunId: "stage-run-1",
      objective: "Write the provider-backed specification",
      inputRefs: ["artifact:design"],
      outputRefs: ["artifact:spec"],
      assignments: [{
        assignmentId: "spec-owner",
        teamRole: "owner",
        assignmentKind: "spec",
        costTier: "junior",
        dependsOn: [],
        readableRefs: ["artifact:design"],
        writableRefs: ["artifact:spec"],
        completionCriteria: ["complete provider artifact"],
        execution: {
          agentId: "junior-luna",
          capabilitySnapshotDigest: TEST_AGENT_CATALOG_DIGEST,
          contextRef: `.team-work/tasks/${taskId}/context/owner.md`,
          promptRef: `.team-work/tasks/${taskId}/prompts/spec-owner.md`,
        },
      }],
    },
    costLedger: { forecastMin: 1, forecastMax: 2, accrued: 0, uncertain: 0, nextWave: 1, automaticLimit: 2 },
    occurredAt: "2026-08-19T10:01:00.000Z",
  }).state
  state = await store.commit({
    taskId,
    expectedRevision: 0,
    state,
    auditEvents: [{ eventId: "stage-plan-frozen-1", type: "stage-plan.frozen", occurredAt: "2026-08-19T10:01:00.000Z", revision: 1, refs: ["spec-plan"] }],
  })
  return state
}

test("Runtime persists a SPEC prepare intent and pins the confirmed capability", async () => {
  const store = createInMemoryStore()
  await createPlannedTask(store)
  const provider = createFakeSpecProvider({ status: "ready", clock: () => "2026-08-19T10:02:00.000Z" })
  const driver = createTaskDriver({
    store,
    executionAdapter: createFakeExecutionAdapter(),
    specProviderAdapter: provider,
    clock: () => "2026-08-19T10:02:00.000Z",
  })

  const first = await driver.prepareSpec({ taskId: "spec-effects", artifact: "proposal" })
  assert.equal(first.capability.status, "ready")
  assert.equal(first.state.specLifecycle.capabilities.length, 1)
  assert.equal(first.state.specLifecycle.capabilities[0].artifact, "proposal")
  assert.deepEqual(first.state.pendingOperations, [])

  const duplicate = await driver.prepareSpec({ taskId: "spec-effects", artifact: "proposal" })
  assert.equal(duplicate.duplicate, true)
  assert.deepEqual(duplicate.capability, first.capability)
  assert.equal((await store.loadTask("spec-effects")).specLifecycle.capabilities.length, 1)
})

test("Runtime inspects an in-doubt SPEC prepare after receipt loss without duplicating the provider effect", async () => {
  const store = createInMemoryStore()
  await createPlannedTask(store, "spec-recovery")
  let now = Date.parse("2026-08-19T10:02:00.000Z")
  let interrupt = true
  const clock = () => new Date(now).toISOString()
  const provider = createFakeSpecProvider({ status: "ready", clock })
  const interrupted = createTaskDriver({
    store,
    executionAdapter: createFakeExecutionAdapter(),
    specProviderAdapter: provider,
    clock,
    effectLeaseMs: 1_000,
    faultInjector: { afterReceipt: async ({ operation }) => {
      if (operation.kind === "spec.prepare" && interrupt) {
        interrupt = false
        throw new Error("simulated SPEC receipt loss")
      }
    } },
  })
  await assert.rejects(
    interrupted.prepareSpec({ taskId: "spec-recovery", artifact: "proposal" }),
    /simulated SPEC receipt loss/,
  )
  assert.equal((await store.loadTask("spec-recovery")).pendingOperations[0].status, "in-doubt")

  now += 2_000
  const restarted = createTaskDriver({
    store,
    executionAdapter: createFakeExecutionAdapter(),
    specProviderAdapter: provider,
    clock,
    effectLeaseMs: 1_000,
  })
  const recovered = await restarted.run({ taskId: "spec-recovery" })
  assert.deepEqual(recovered.state.pendingOperations, [])
  assert.equal(recovered.state.specLifecycle.capabilities.length, 1)
  assert.equal(recovered.state.specLifecycle.capabilities[0].artifact, "proposal")
})

test("provider status and validation become authoritative Runtime projections", async () => {
  const store = createInMemoryStore()
  await createPlannedTask(store, "spec-validation")
  const driver = createTaskDriver({
    store,
    executionAdapter: createFakeExecutionAdapter(),
    specProviderAdapter: createFakeSpecProvider({ status: "ready", clock: () => "2026-08-19T10:03:00.000Z" }),
    clock: () => "2026-08-19T10:03:00.000Z",
  })
  await driver.prepareSpec({ taskId: "spec-validation", artifact: "proposal" })
  const status = await driver.recordSpecStatus({ taskId: "spec-validation" })
  assert.equal(status.state.specLifecycle.status.state, "complete")
  const validation = await driver.validateSpec({ taskId: "spec-validation" })
  assert.equal(validation.state.specLifecycle.validation.valid, true)
  assert.equal(validation.state.specLifecycle.validation.providerRevision, status.state.specLifecycle.status.providerRevision)
})

test("SPEC archive is rejected before final acceptance and recovered by inspect after receipt loss", async () => {
  const store = createInMemoryStore()
  await createPlannedTask(store, "spec-archive")
  let now = Date.parse("2026-08-19T10:04:00.000Z")
  const clock = () => new Date(now).toISOString()
  const execution = createFakeExecutionAdapter({ clock })
  const provider = createFakeSpecProvider({ status: "ready", clock })
  let interrupt = true
  const driver = createTaskDriver({
    store,
    executionAdapter: execution,
    specProviderAdapter: provider,
    evidenceVerifier: { verify: async () => ({ valid: true, mismatches: [] }) },
    clock,
    effectLeaseMs: 1_000,
    faultInjector: { afterReceipt: async ({ operation }) => {
      if (operation.kind === "spec.archive" && interrupt) {
        interrupt = false
        throw new Error("simulated archive receipt loss")
      }
    } },
  })
  await driver.prepareSpec({ taskId: "spec-archive", artifact: "proposal" })
  await driver.recordSpecStatus({ taskId: "spec-archive" })
  await driver.validateSpec({ taskId: "spec-archive" })
  await assert.rejects(driver.archiveSpec({ taskId: "spec-archive" }), (error) => error.code === "SPEC_ARCHIVE_INTENT_INVALID")

  await driver.prepareHumanDecision({
    taskId: "spec-archive",
    decision: {
      decisionId: "final-acceptance-stage-run-1",
      requirement: "required",
      leadBindingRef: "lead-spec-archive",
      question: "Accept?",
      choices: ["accept", "rework"],
      artifactRefs: ["design"],
    },
  })
  await driver.run({ taskId: "spec-archive" })
  execution.setHumanChoice("accept")
  await driver.resolveHumanDecision({ taskId: "spec-archive" })
  await assert.rejects(driver.archiveSpec({ taskId: "spec-archive" }), /simulated archive receipt loss/)
  assert.equal((await store.loadTask("spec-archive")).pendingOperations[0].kind, "spec.archive")

  now += 2_000
  const restarted = createTaskDriver({
    store,
    executionAdapter: execution,
    specProviderAdapter: provider,
    evidenceVerifier: { verify: async () => ({ valid: true, mismatches: [] }) },
    clock,
    effectLeaseMs: 1_000,
  })
  const recovered = await restarted.run({ taskId: "spec-archive" })
  assert.deepEqual(recovered.state.pendingOperations, [])
  assert.equal(recovered.state.specLifecycle.archive.receiptRef, recovered.state.specLifecycle.archive.operationId)
})
