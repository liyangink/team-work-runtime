import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { createTaskDriver } from "../../../runtime/application/driver.mjs"
import { compileHumanGateRequirements, evaluateHumanGate } from "../../../runtime/application/human-wait.mjs"
import { assertTaskState, createTaskAggregate, digestEffect, digestValue, reduceTask } from "../../../runtime/domain/index.mjs"
import { createFileStore } from "../../../runtime/persistence/index.mjs"
import { compiledPlanMetadata, TEST_AGENT_CATALOG_DIGEST, TEST_TASK_INTENT } from "../support/compiled-plan.mjs"

const workflow = {
  workflowId: "engineering",
  version: "2026-08-18",
  digest: "a".repeat(64),
  stages: ["design"],
  edges: [],
  terminalStages: ["design"],
}

async function createProject() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-v2-human-wait-"))
  await mkdir(path.join(projectRoot, ".team-work", "tasks"), { recursive: true })
  await mkdir(path.join(projectRoot, "docs"), { recursive: true })
  await writeFile(path.join(projectRoot, "docs", "design.md"), "approved design contents")
  await writeFile(path.join(projectRoot, ".team-work", "project.json"), `${JSON.stringify({
    runtimeMajor: 2,
    schemaVersion: "2.0",
  })}\n`)
  return projectRoot
}

function event(revision, type, occurredAt, refs = ["stage-run-1"]) {
  return { eventId: `${type.replaceAll(".", "-")}-${revision}`, type, occurredAt, revision, refs }
}

async function createWorkingTask(store, taskId) {
  let state = createTaskAggregate({
    taskId,
    title: "Approve the design",
    objective: "Wait for an evidence-bound human decision",
    workflow,
    entryStage: "design",
    completion: { mode: "workflow" },
    stageRunId: "stage-run-1",
    createdAt: "2026-08-18T10:00:00.000Z",
  })
  state = await store.createTask(state)
  state = reduceTask(state, {
    type: "stage-run.transitioned",
    expectedRevision: 0,
    status: "dispatching",
    occurredAt: "2026-08-18T10:01:00.000Z",
  }).state
  state = await store.commit({
    taskId,
    expectedRevision: 0,
    state,
    auditEvents: [event(1, "stage-run.transitioned", "2026-08-18T10:01:00.000Z")],
  })
  const artifactDigest = digestValue("approved design contents")
  state = reduceTask(state, {
    type: "artifact.recorded",
    expectedRevision: 1,
    occurredAt: "2026-08-18T10:02:00.000Z",
    artifact: {
      artifactId: "design-document",
      kind: "design",
      path: "docs/design.md",
      digest: artifactDigest,
      stageRunId: "stage-run-1",
    },
  }).state
  await store.commit({
    taskId,
    expectedRevision: 1,
    state,
    auditEvents: [event(2, "artifact.recorded", "2026-08-18T10:02:00.000Z", ["design-document"])],
  })
  return artifactDigest
}

async function createRunningTask(store, driver, taskId) {
  let state = createTaskAggregate({
    taskId,
    title: "Wait while a member session exists",
    objective: "Prove late delivery remains non-progressing",
    workflow,
    entryStage: "design",
    completion: { mode: "workflow" },
    stageRunId: "stage-run-1",
    createdAt: "2026-08-18T10:00:00.000Z",
  })
  await store.createTask(state)
  state = reduceTask(state, {
    type: "stage-plan.frozen",
    taskIntent: TEST_TASK_INTENT,
    expectedRevision: 0,
    occurredAt: "2026-08-18T10:01:00.000Z",
    plan: {
      ...compiledPlanMetadata({ workflow }),
      planId: "plan-1",
      stageRunId: "stage-run-1",
      objective: "Produce a design for approval",
      inputRefs: [],
      outputRefs: ["artifact:design"],
      assignments: [{
        assignmentId: "design-owner",
        teamRole: "owner",
        assignmentKind: "design",
        costTier: "junior",
        dependsOn: [],
        readableRefs: [],
        writableRefs: ["artifact:design"],
        completionCriteria: ["submit the design"],
        execution: {
          agentId: "junior-luna",
          capabilitySnapshotDigest: TEST_AGENT_CATALOG_DIGEST,
          contextRef: `.team-work/tasks/${taskId}/context/owner.md`,
          promptRef: `.team-work/tasks/${taskId}/prompts/design-owner.md`,
        },
      }],
    },
    costLedger: { forecastMin: 1, forecastMax: 2, accrued: 0, uncertain: 0, nextWave: 1, automaticLimit: 2 },
  }).state
  await store.commit({
    taskId,
    expectedRevision: 0,
    state,
    auditEvents: [event(1, "stage-plan.frozen", "2026-08-18T10:01:00.000Z")],
  })
  await driver.run({ taskId, waitBudgetMs: 0 })
  state = await store.loadTask(taskId)
  state = reduceTask(state, {
    type: "artifact.recorded",
    expectedRevision: state.revision,
    occurredAt: "2026-08-18T10:03:00.000Z",
    artifact: {
      artifactId: "design-document",
      kind: "design",
      path: "docs/design.md",
      digest: digestValue("approved design contents"),
      stageRunId: "stage-run-1",
    },
  }).state
  await store.commit({
    taskId,
    expectedRevision: state.revision - 1,
    state,
    auditEvents: [event(state.revision, "artifact.recorded", "2026-08-18T10:03:00.000Z", ["design-document"])],
  })
}

function adapter(overrides = {}) {
  return {
    capabilities: async () => ({
      snapshotId: "capabilities-1",
      digest: "capability-digest-1",
      capturedAt: "2026-08-18T09:59:00.000Z",
      agents: [],
      limits: { maxParallel: 2 },
      features: {
        background: true,
        resume: true,
        humanDecisionProof: "trusted-caller",
        readOnlyHelper: false,
        checkReceipts: false,
      },
    }),
    bindLead: async () => assert.fail("not used"),
    ensureExecution: async () => assert.fail("not used"),
    inspectExecution: async () => assert.fail("not used"),
    quiesce: async () => assert.fail("quiesce must be provided"),
    inspectQuiesce: async () => assert.fail("not used"),
    verifyHumanDecision: async () => assert.fail("not used"),
    stopExecution: async () => assert.fail("not used"),
    inspectStop: async () => assert.fail("not used"),
    ...overrides,
  }
}

test("confirmed quiesce is required before the driver enters a static human wait", async () => {
  const projectRoot = await createProject()
  const store = createFileStore({ projectRoot })
  const taskId = "confirmed-human-wait"
  await createWorkingTask(store, taskId)
  let quiesceCalls = 0
  const executionAdapter = adapter({
    quiesce: async (intent) => {
      quiesceCalls += 1
      return {
        operationId: intent.operationId,
        effectDigest: intent.effectDigest,
        status: "confirmed",
        executions: [],
        hostContinuationsCleared: true,
        observedAt: "2026-08-18T10:04:00.000Z",
      }
    },
  })
  const driver = createTaskDriver({
    projectRoot,
    store,
    executionAdapter,
    clock: () => "2026-08-18T10:03:00.000Z",
  })

  await driver.prepareHumanDecision({
    taskId,
    decision: {
      decisionId: "approve-design",
      requirement: "required",
      leadBindingRef: "binding:lead-1",
      question: "是否批准当前方案进入实施？",
      choices: ["approve", "revise"],
      artifactRefs: ["design-document"],
    },
  })
  const prepared = await store.loadTask(taskId)
  assert.equal(prepared.status, "working")
  assert.equal(prepared.pendingDecision.phase, "preparing")
  assert.equal(prepared.pendingOperations[0].kind, "execution.quiesce")

  const waiting = await driver.run({ taskId, waitBudgetMs: 1_000 })
  assert.equal(waiting.reason, "awaiting-user")
  assert.equal(waiting.state.status, "awaiting-user")
  assert.equal(waiting.state.pendingDecision.phase, "awaiting-user")
  assert.equal(waiting.state.pendingDecision.evidence[0].digest, digestValue("approved design contents"))
  assert.equal(quiesceCalls, 1)

  const unchanged = await driver.run({ taskId, waitBudgetMs: 1_000 })
  assert.equal(unchanged.reason, "awaiting-user")
  assert.equal(unchanged.state.revision, waiting.state.revision)
  assert.equal(quiesceCalls, 1)
})

test("human gate capability is resolved before execution so required unsupported gates cannot deadlock", () => {
  assert.deepEqual(evaluateHumanGate({ requirement: "required", humanDecisionProof: "trusted-caller" }), {
    action: "wait",
    proofMode: "trusted-caller",
  })
  assert.deepEqual(evaluateHumanGate({ requirement: "optional", humanDecisionProof: "unsupported" }), {
    action: "skip",
    reason: "proof-unsupported",
  })
  assert.deepEqual(evaluateHumanGate({ requirement: "disabled", humanDecisionProof: "unsupported" }), {
    action: "skip",
    reason: "disabled",
  })
  assert.throws(
    () => evaluateHumanGate({ requirement: "required", humanDecisionProof: "unsupported" }),
    (error) => error.code === "HUMAN_DECISION_PROOF_UNSUPPORTED",
  )
  assert.throws(
    () => compileHumanGateRequirements({
      gates: [
        { gateId: "design-approval", requirement: "required" },
        { gateId: "final-acceptance", requirement: "required" },
      ],
      capabilitySnapshot: { features: { humanDecisionProof: "unsupported" } },
    }),
    (error) => error.code === "HUMAN_DECISION_PROOF_UNSUPPORTED",
  )
  assert.deepEqual(compileHumanGateRequirements({
    gates: [
      { gateId: "design-approval", requirement: "optional" },
      { gateId: "final-acceptance", requirement: "disabled" },
    ],
    capabilitySnapshot: { features: { humanDecisionProof: "unsupported" } },
  }), [
    { gateId: "design-approval", requirement: "optional", action: "skip", reason: "proof-unsupported" },
    { gateId: "final-acceptance", requirement: "disabled", action: "skip", reason: "disabled" },
  ])
})

test("the Driver compiles a required gate before creating any quiesce intent", async () => {
  const projectRoot = await createProject()
  const store = createFileStore({ projectRoot })
  const taskId = "unsupported-required-gate"
  await createWorkingTask(store, taskId)
  const base = await adapter().capabilities()
  const driver = createTaskDriver({
    projectRoot,
    store,
    executionAdapter: adapter({
      capabilities: async () => ({
        ...base,
        features: { ...base.features, humanDecisionProof: "unsupported" },
      }),
    }),
  })
  const before = await store.loadTask(taskId)

  await assert.rejects(
    driver.prepareHumanDecision({
      taskId,
      decision: {
        decisionId: "design-approval",
        requirement: "required",
        leadBindingRef: "binding:lead-1",
        question: "是否批准当前方案进入实施？",
        choices: ["approve", "revise"],
        artifactRefs: ["design-document"],
      },
    }),
    (error) => error.code === "HUMAN_DECISION_PROOF_UNSUPPORTED",
  )
  assert.deepEqual(await store.loadTask(taskId), before)
})

test("a verified adapter decision is bound to the issued stage and artifact evidence", async () => {
  const projectRoot = await createProject()
  const store = createFileStore({ projectRoot })
  const taskId = "verified-human-decision"
  const artifactDigest = await createWorkingTask(store, taskId)
  let verifyIntent
  const executionAdapter = adapter({
    quiesce: async (intent) => ({
      operationId: intent.operationId,
      effectDigest: intent.effectDigest,
      status: "confirmed",
      executions: [],
      hostContinuationsCleared: true,
      observedAt: "2026-08-18T10:04:00.000Z",
    }),
    verifyHumanDecision: async (intent) => {
      verifyIntent = intent
      return {
        decisionId: intent.decisionId,
        leadBindingRef: intent.leadBindingRef,
        receivedAt: "2026-08-18T10:06:00.000Z",
        choice: "approve",
        note: "方案与预期一致",
        proof: { mode: "trusted-caller", invocationRef: "human-cli-call-1" },
      }
    },
  })
  const times = [
    "2026-08-18T10:03:00.000Z",
    "2026-08-18T10:03:01.000Z",
    "2026-08-18T10:05:00.000Z",
  ]
  const driver = createTaskDriver({ projectRoot, store, executionAdapter, clock: () => times.shift() ?? "2026-08-18T10:05:00.000Z" })
  await driver.prepareHumanDecision({
    taskId,
    decision: {
      decisionId: "approve-design",
      requirement: "required",
      leadBindingRef: "binding:lead-1",
      question: "是否批准当前方案进入实施？",
      choices: ["approve", "revise"],
      artifactRefs: ["design-document"],
    },
  })
  await driver.run({ taskId, waitBudgetMs: 0 })

  const resolved = await driver.resolveHumanDecision({ taskId })

  assert.deepEqual(verifyIntent.choices, ["approve", "revise"])
  assert.equal(verifyIntent.decisionId, "approve-design")
  assert.equal(resolved.decision.choice, "approve")
  assert.equal(resolved.state.status, "working")
  assert.equal(resolved.state.pendingDecision, null)
  assert.deepEqual(resolved.state.decisionHistory[0].artifactDigests, { "design-document": artifactDigest })
  assert.match(resolved.state.decisionHistory[0].quiesceReceiptRef, /^quiesce-/)
  assert.equal(resolved.state.evidence[0].kind, "human-decision")
  assert.equal(resolved.state.evidence[0].valid, true)
  const corruptDigestMap = structuredClone(resolved.state)
  corruptDigestMap.decisionHistory[0].artifactDigests["design-document"] = "f".repeat(64)
  assert.throws(() => assertTaskState(corruptDigestMap), (error) => error.code === "STATE_INVALID")

  const decisionPath = path.join(
    projectRoot,
    `.team-work/tasks/${taskId}/operations/${resolved.state.decisionHistory[0].decisionRef}.json`,
  )
  const decisionRecord = await readFile(decisionPath, "utf8")
  await rm(decisionPath)
  await assert.rejects(store.loadTask(taskId), (error) => error.code === "STATE_CORRUPT")
  await writeFile(decisionPath, decisionRecord)

  const quiescePath = path.join(
    projectRoot,
    `.team-work/tasks/${taskId}/operations/${resolved.state.decisionHistory[0].quiesceReceiptRef}.json`,
  )
  const quiesceRecord = JSON.parse(await readFile(quiescePath, "utf8"))
  quiesceRecord.intent.leadBindingRef = "binding:another-lead"
  quiesceRecord.intent.effectDigest = digestEffect(quiesceRecord.intent)
  quiesceRecord.receipt.effectDigest = quiesceRecord.intent.effectDigest
  await writeFile(quiescePath, JSON.stringify(quiesceRecord))
  await assert.rejects(store.loadTask(taskId), (error) => error.code === "STATE_CORRUPT")
})

test("late member delivery is durable but non-progressing until new human input reopens the task", async () => {
  const projectRoot = await createProject()
  const store = createFileStore({ projectRoot })
  const taskId = "late-human-observation"
  let verifyCalls = 0
  const executionAdapter = adapter({
    ensureExecution: async (effect) => ({
      operationId: effect.operationId,
      effectDigest: effect.effectDigest,
      status: "confirmed",
      executionRef: "member-session-late",
      agentId: effect.agentId,
      observedAt: "2026-08-18T10:02:00.000Z",
    }),
    inspectExecution: async () => assert.fail("not used"),
    quiesce: async (intent) => ({
      operationId: intent.operationId,
      effectDigest: intent.effectDigest,
      status: "confirmed",
      executions: [{ executionRef: "member-session-late", state: "isolated" }],
      hostContinuationsCleared: true,
      observedAt: "2026-08-18T10:04:00.000Z",
    }),
    verifyHumanDecision: async () => {
      verifyCalls += 1
      return assert.fail("late facts must be reviewed before asking the adapter for a decision")
    },
  })
  const driver = createTaskDriver({ projectRoot, store, executionAdapter, clock: () => "2026-08-18T10:03:30.000Z" })
  await createRunningTask(store, driver, taskId)
  await driver.prepareHumanDecision({
    taskId,
    decision: {
      decisionId: "approve-design",
      requirement: "required",
      leadBindingRef: "binding:lead-1",
      question: "是否批准当前方案进入实施？",
      choices: ["approve", "revise"],
      artifactRefs: ["design-document"],
    },
  })
  const waiting = await driver.run({ taskId, waitBudgetMs: 0 })
  const revision = waiting.state.revision
  await driver.deliverMemberReport({
    taskId,
    assignmentId: "design-owner",
    attemptId: "design-owner-attempt-1",
    executionRef: "member-session-late",
    operationKey: "late-member-report",
    report: {
      outcome: "delivered",
      summary: "A report arrived after the approval card was issued.",
      artifacts: ["docs/design.md"],
      evidenceRefs: [],
      recommendation: "accept",
    },
  })

  const persisted = await store.loadTask(taskId)
  assert.equal(persisted.status, "awaiting-user")
  assert.equal(persisted.observationInbox.items[0].progression, "deferred")
  const staticRun = await driver.run({ taskId, waitBudgetMs: 1_000 })
  assert.equal(staticRun.state.revision, revision + 1)
  assert.equal(staticRun.state.observationInbox.items.length, 1)

  const reopened = await driver.resolveHumanDecision({ taskId })
  assert.equal(reopened.accepted, false)
  assert.equal(reopened.reason, "late-observations")
  assert.equal(reopened.state.status, "working")
  assert.equal(reopened.state.pendingDecision, null)
  assert.equal(verifyCalls, 0)
})

test("a restart inspects an in-doubt quiesce instead of repeating the external effect", async () => {
  const projectRoot = await createProject()
  const store = createFileStore({ projectRoot })
  const taskId = "recover-human-quiesce"
  await createWorkingTask(store, taskId)
  let quiesceCalls = 0
  let inspectCalls = 0
  const executionAdapter = adapter({
    quiesce: async (intent) => {
      quiesceCalls += 1
      return {
        operationId: intent.operationId,
        effectDigest: intent.effectDigest,
        status: "confirmed",
        executions: [],
        hostContinuationsCleared: true,
        observedAt: "2026-08-18T10:04:00.000Z",
      }
    },
    inspectQuiesce: async (intent) => {
      inspectCalls += 1
      return {
        operationId: intent.operationId,
        effectDigest: intent.effectDigest,
        status: "confirmed",
        executions: [],
        hostContinuationsCleared: true,
        observedAt: "2026-08-18T10:10:00.000Z",
      }
    },
  })
  const interrupted = createTaskDriver({
    projectRoot,
    store,
    executionAdapter,
    clock: () => "2026-08-18T10:03:00.000Z",
    faultInjector: { afterReceipt: async () => { throw new Error("simulated quiesce receipt loss") } },
  })
  await interrupted.prepareHumanDecision({
    taskId,
    decision: {
      decisionId: "approve-design",
      requirement: "required",
      leadBindingRef: "binding:lead-1",
      question: "是否批准当前方案进入实施？",
      choices: ["approve", "revise"],
      artifactRefs: ["design-document"],
    },
  })
  await assert.rejects(interrupted.run({ taskId, waitBudgetMs: 0 }), /simulated quiesce receipt loss/)
  assert.equal((await store.loadTask(taskId)).pendingOperations[0].status, "in-doubt")

  const recovered = createTaskDriver({
    projectRoot,
    store,
    executionAdapter,
    clock: () => "2026-08-18T10:10:00.000Z",
  })
  const outcome = await recovered.run({ taskId, waitBudgetMs: 0 })
  assert.equal(outcome.reason, "awaiting-user")
  assert.equal(quiesceCalls, 1)
  assert.equal(inspectCalls, 1)
})

test("a blocked quiesce becomes a recoverable blocker and never issues an approval request", async () => {
  const projectRoot = await createProject()
  const store = createFileStore({ projectRoot })
  const taskId = "blocked-human-quiesce"
  await createWorkingTask(store, taskId)
  let quiesceCalls = 0
  const executionAdapter = adapter({
    quiesce: async (intent) => {
      quiesceCalls += 1
      return {
        operationId: intent.operationId,
        effectDigest: intent.effectDigest,
        status: quiesceCalls === 1 ? "blocked" : "confirmed",
        executions: [],
        hostContinuationsCleared: quiesceCalls > 1,
        observedAt: quiesceCalls === 1 ? "2026-08-18T10:04:00.000Z" : "2026-08-18T10:06:00.000Z",
      }
    },
  })
  const driver = createTaskDriver({ projectRoot, store, executionAdapter, clock: () => "2026-08-18T10:03:00.000Z" })
  await driver.prepareHumanDecision({
    taskId,
    decision: {
      decisionId: "approve-design",
      requirement: "required",
      leadBindingRef: "binding:lead-1",
      question: "是否批准当前方案进入实施？",
      choices: ["approve", "revise"],
      artifactRefs: ["design-document"],
    },
  })

  const outcome = await driver.run({ taskId, waitBudgetMs: 0 })
  assert.equal(outcome.reason, "blocked")
  assert.equal(outcome.state.status, "blocked")
  assert.equal(outcome.state.pendingDecision.phase, "preparing")
  assert.equal(outcome.state.pendingDecision.issuedAt, undefined)
  assert.deepEqual(outcome.state.pendingOperations, [])

  const failedOperationId = outcome.state.pendingDecision.quiesceOperationId
  const retried = await driver.prepareHumanDecision({
    taskId,
    decision: {
      decisionId: "approve-design",
      requirement: "required",
      leadBindingRef: "binding:lead-1",
      question: "是否批准当前方案进入实施？",
      choices: ["approve", "revise"],
      artifactRefs: ["design-document"],
    },
  })
  assert.equal(retried.state.status, "working")
  assert.notEqual(retried.state.pendingDecision.quiesceOperationId, failedOperationId)
  const recovered = await driver.run({ taskId, waitBudgetMs: 0 })
  assert.equal(recovered.reason, "awaiting-user")
  assert.equal(quiesceCalls, 2)
})

test("changing an issued approval artifact invalidates the wait instead of accepting stale consent", async () => {
  const projectRoot = await createProject()
  const store = createFileStore({ projectRoot })
  const taskId = "stale-human-evidence"
  await createWorkingTask(store, taskId)
  const executionAdapter = adapter({
    quiesce: async (intent) => ({
      operationId: intent.operationId,
      effectDigest: intent.effectDigest,
      status: "confirmed",
      executions: [],
      hostContinuationsCleared: true,
      observedAt: "2026-08-18T10:04:00.000Z",
    }),
  })
  const driver = createTaskDriver({ projectRoot, store, executionAdapter, clock: () => "2026-08-18T10:03:00.000Z" })
  await driver.prepareHumanDecision({
    taskId,
    decision: {
      decisionId: "approve-design",
      requirement: "required",
      leadBindingRef: "binding:lead-1",
      question: "是否批准当前方案进入实施？",
      choices: ["approve", "revise"],
      artifactRefs: ["design-document"],
    },
  })
  const waiting = await driver.run({ taskId, waitBudgetMs: 0 })
  const changed = reduceTask(waiting.state, {
    type: "artifact.recorded",
    expectedRevision: waiting.state.revision,
    occurredAt: "2026-08-18T10:06:00.000Z",
    artifact: {
      artifactId: "design-document",
      kind: "design",
      path: "docs/design.md",
      digest: digestValue("changed after approval was requested"),
      stageRunId: "stage-run-1",
    },
  }).state
  const committed = await store.commit({
    taskId,
    expectedRevision: waiting.state.revision,
    state: changed,
    auditEvents: [event(changed.revision, "artifact.recorded", "2026-08-18T10:06:00.000Z", ["design-document"])],
  })

  assert.equal(committed.status, "working")
  assert.equal(committed.pendingDecision, null)
  await assert.rejects(
    driver.resolveHumanDecision({ taskId }),
    (error) => error.code === "HUMAN_DECISION_NOT_AWAITED",
  )
})

test("evidence changed during quiesce reopens safely without issuing a stale approval", async () => {
  const projectRoot = await createProject()
  const store = createFileStore({ projectRoot })
  const taskId = "changed-during-quiesce"
  await createWorkingTask(store, taskId)
  const executionAdapter = adapter({
    quiesce: async (intent) => ({
      operationId: intent.operationId,
      effectDigest: intent.effectDigest,
      status: "confirmed",
      executions: [],
      hostContinuationsCleared: true,
      observedAt: "2026-08-18T10:05:00.000Z",
    }),
  })
  const driver = createTaskDriver({ projectRoot, store, executionAdapter, clock: () => "2026-08-18T10:03:00.000Z" })
  await driver.prepareHumanDecision({
    taskId,
    decision: {
      decisionId: "approve-design",
      requirement: "required",
      leadBindingRef: "binding:lead-1",
      question: "是否批准当前方案进入实施？",
      choices: ["approve", "revise"],
      artifactRefs: ["design-document"],
    },
  })
  let state = await store.loadTask(taskId)
  state = reduceTask(state, {
    type: "artifact.recorded",
    expectedRevision: state.revision,
    occurredAt: "2026-08-18T10:04:00.000Z",
    artifact: {
      artifactId: "design-document",
      kind: "design",
      path: "docs/design.md",
      digest: digestValue("changed while the platform was quiescing"),
      stageRunId: "stage-run-1",
    },
  }).state
  await store.commit({
    taskId,
    expectedRevision: state.revision - 1,
    state,
    auditEvents: [event(state.revision, "artifact.recorded", "2026-08-18T10:04:00.000Z", ["design-document"])],
  })

  const outcome = await driver.run({ taskId, waitBudgetMs: 0 })
  assert.equal(outcome.reason, "stable")
  assert.equal(outcome.state.status, "working")
  assert.equal(outcome.state.pendingDecision, null)
})

test("verified-event decisions must be newer than the host cursor captured at quiesce", async () => {
  const projectRoot = await createProject()
  const store = createFileStore({ projectRoot })
  const taskId = "verified-event-cursor"
  await createWorkingTask(store, taskId)
  let verifyIntent
  const base = await adapter().capabilities()
  const executionAdapter = adapter({
    capabilities: async () => ({
      ...base,
      features: { ...base.features, humanDecisionProof: "verified-event" },
    }),
    quiesce: async (intent) => ({
      operationId: intent.operationId,
      effectDigest: intent.effectDigest,
      status: "confirmed",
      executions: [],
      hostContinuationsCleared: true,
      hostCursor: "message-cursor-10",
      observedAt: "2026-08-18T10:04:00.000Z",
    }),
    verifyHumanDecision: async (intent) => {
      verifyIntent = intent
      return {
        decisionId: intent.decisionId,
        leadBindingRef: intent.leadBindingRef,
        receivedAt: "2026-08-18T10:06:00.000Z",
        choice: "approve",
        proof: {
          mode: "verified-event",
          messageId: "old-message",
          messageCursor: "message-cursor-10",
        },
      }
    },
  })
  const driver = createTaskDriver({ projectRoot, store, executionAdapter, clock: () => "2026-08-18T10:03:00.000Z" })
  await driver.prepareHumanDecision({
    taskId,
    decision: {
      decisionId: "approve-design",
      requirement: "required",
      leadBindingRef: "binding:lead-1",
      question: "是否批准当前方案进入实施？",
      choices: ["approve", "revise"],
      artifactRefs: ["design-document"],
    },
  })
  await driver.run({ taskId, waitBudgetMs: 0 })

  await assert.rejects(
    driver.resolveHumanDecision({ taskId }),
    (error) => error.code === "HUMAN_DECISION_STALE",
  )
  assert.equal(verifyIntent.afterHostCursor, "message-cursor-10")
  const waiting = await store.loadTask(taskId)
  assert.equal(waiting.status, "awaiting-user")
  assert.deepEqual(waiting.decisionHistory, [])
})

test("repeating the same wait request is idempotent but conflicting content is rejected", async () => {
  const projectRoot = await createProject()
  const store = createFileStore({ projectRoot })
  const taskId = "idempotent-human-wait"
  await createWorkingTask(store, taskId)
  let capabilityCalls = 0
  const baseAdapter = adapter()
  const driver = createTaskDriver({
    projectRoot,
    store,
    executionAdapter: adapter({
      capabilities: async () => {
        capabilityCalls += 1
        const snapshot = await baseAdapter.capabilities()
        return { ...snapshot, digest: `capability-digest-${capabilityCalls}` }
      },
    }),
  })
  const request = {
    taskId,
    decision: {
      decisionId: "approve-design",
      requirement: "required",
      leadBindingRef: "binding:lead-1",
      question: "是否批准当前方案进入实施？",
      choices: ["approve", "revise"],
      artifactRefs: ["design-document"],
    },
  }

  const first = await driver.prepareHumanDecision(request)
  const duplicate = await driver.prepareHumanDecision(request)
  assert.equal(duplicate.changed, false)
  assert.equal(duplicate.state.revision, first.state.revision)
  assert.equal(capabilityCalls, 1)
  await assert.rejects(
    driver.prepareHumanDecision({
      ...request,
      decision: { ...request.decision, question: "是否批准另一份未展示的方案？" },
    }),
    (error) => error.code === "HUMAN_DECISION_CONFLICT",
  )
})

test("a report racing with human verification wins and invalidates the decision atomically", async () => {
  const projectRoot = await createProject()
  const store = createFileStore({ projectRoot })
  const taskId = "decision-observation-race"
  let driver
  const executionAdapter = adapter({
    ensureExecution: async (effect) => ({
      operationId: effect.operationId,
      effectDigest: effect.effectDigest,
      status: "confirmed",
      executionRef: "member-session-race",
      agentId: effect.agentId,
      observedAt: "2026-08-18T10:02:00.000Z",
    }),
    inspectExecution: async () => assert.fail("not used"),
    quiesce: async (intent) => ({
      operationId: intent.operationId,
      effectDigest: intent.effectDigest,
      status: "confirmed",
      executions: [{ executionRef: "member-session-race", state: "isolated" }],
      hostContinuationsCleared: true,
      observedAt: "2026-08-18T10:04:00.000Z",
    }),
    verifyHumanDecision: async (intent) => {
      await driver.deliverMemberReport({
        taskId,
        assignmentId: "design-owner",
        attemptId: "design-owner-attempt-1",
        executionRef: "member-session-race",
        operationKey: "racing-member-report",
        report: {
          outcome: "delivered",
          summary: "This report raced with the human decision.",
          artifacts: ["docs/design.md"],
          evidenceRefs: [],
          recommendation: "accept",
        },
      })
      return {
        decisionId: intent.decisionId,
        leadBindingRef: intent.leadBindingRef,
        receivedAt: "2026-08-18T10:06:00.000Z",
        choice: "approve",
        proof: { mode: "trusted-caller", invocationRef: "human-cli-call-race" },
      }
    },
  })
  driver = createTaskDriver({ projectRoot, store, executionAdapter, clock: () => "2026-08-18T10:03:30.000Z" })
  await createRunningTask(store, driver, taskId)
  await driver.prepareHumanDecision({
    taskId,
    decision: {
      decisionId: "approve-design",
      requirement: "required",
      leadBindingRef: "binding:lead-1",
      question: "是否批准当前方案进入实施？",
      choices: ["approve", "revise"],
      artifactRefs: ["design-document"],
    },
  })
  await driver.run({ taskId, waitBudgetMs: 0 })

  const resolved = await driver.resolveHumanDecision({ taskId })
  assert.equal(resolved.accepted, false)
  assert.equal(resolved.reason, "late-observations")
  assert.equal(resolved.state.status, "working")
  assert.deepEqual(resolved.state.decisionHistory, [])
  assert.equal(resolved.state.observationInbox.items[0].progression, "deferred")
})

test("an observation arriving during quiesce is drained and prevents a stale approval from being issued", async () => {
  const projectRoot = await createProject()
  const store = createFileStore({ projectRoot })
  const taskId = "observation-during-quiesce"
  let driver
  const executionAdapter = adapter({
    ensureExecution: async (effect) => ({
      operationId: effect.operationId,
      effectDigest: effect.effectDigest,
      status: "confirmed",
      executionRef: "member-session-quiesce-race",
      agentId: effect.agentId,
      observedAt: "2026-08-18T10:02:00.000Z",
    }),
    inspectExecution: async () => assert.fail("not used"),
    quiesce: async (intent) => {
      await driver.deliverMemberReport({
        taskId,
        assignmentId: "design-owner",
        attemptId: "design-owner-attempt-1",
        executionRef: "member-session-quiesce-race",
        operationKey: "report-during-quiesce",
        report: {
          outcome: "delivered",
          summary: "This report arrived while host continuations were being cleared.",
          artifacts: ["docs/design.md"],
          evidenceRefs: [],
          recommendation: "accept",
        },
      })
      return {
        operationId: intent.operationId,
        effectDigest: intent.effectDigest,
        status: "confirmed",
        executions: [{ executionRef: "member-session-quiesce-race", state: "isolated" }],
        hostContinuationsCleared: true,
        observedAt: "2026-08-18T10:04:00.000Z",
      }
    },
  })
  driver = createTaskDriver({ projectRoot, store, executionAdapter, clock: () => "2026-08-18T10:03:30.000Z" })
  await createRunningTask(store, driver, taskId)
  await driver.prepareHumanDecision({
    taskId,
    decision: {
      decisionId: "approve-design",
      requirement: "required",
      leadBindingRef: "binding:lead-1",
      question: "是否批准当前方案进入实施？",
      choices: ["approve", "revise"],
      artifactRefs: ["design-document"],
    },
  })

  const outcome = await driver.run({ taskId, waitBudgetMs: 0 })
  assert.equal(outcome.reason, "stable")
  assert.equal(outcome.state.status, "working")
  assert.equal(outcome.state.pendingDecision, null)
  assert.equal(outcome.state.workGraph.assignments[0].status, "reported")
})

test("a malformed confirmed receipt cannot create an awaiting-user state", async () => {
  const projectRoot = await createProject()
  const store = createFileStore({ projectRoot })
  const taskId = "malformed-quiesce-receipt"
  await createWorkingTask(store, taskId)
  const executionAdapter = adapter({
    quiesce: async (intent) => ({
      operationId: intent.operationId,
      effectDigest: intent.effectDigest,
      status: "confirmed",
      executions: [],
      hostContinuationsCleared: false,
      observedAt: "2026-08-18T10:04:00.000Z",
    }),
  })
  const driver = createTaskDriver({ projectRoot, store, executionAdapter, clock: () => "2026-08-18T10:03:00.000Z" })
  await driver.prepareHumanDecision({
    taskId,
    decision: {
      decisionId: "approve-design",
      requirement: "required",
      leadBindingRef: "binding:lead-1",
      question: "是否批准当前方案进入实施？",
      choices: ["approve", "revise"],
      artifactRefs: ["design-document"],
    },
  })

  await assert.rejects(
    driver.run({ taskId, waitBudgetMs: 0 }),
    (error) => error.code === "HUMAN_WAIT_QUIESCE_INVALID",
  )
  const state = await store.loadTask(taskId)
  assert.notEqual(state.status, "awaiting-user")
  assert.equal(state.pendingOperations[0].status, "in-doubt")
})

test("an unregistered filesystem change invalidates approval before the adapter can accept it", async () => {
  const projectRoot = await createProject()
  const store = createFileStore({ projectRoot })
  const taskId = "external-artifact-change"
  await createWorkingTask(store, taskId)
  let verifyCalls = 0
  const executionAdapter = adapter({
    quiesce: async (intent) => ({
      operationId: intent.operationId,
      effectDigest: intent.effectDigest,
      status: "confirmed",
      executions: [],
      hostContinuationsCleared: true,
      observedAt: "2026-08-18T10:04:00.000Z",
    }),
    verifyHumanDecision: async () => {
      verifyCalls += 1
      return assert.fail("stale filesystem evidence must be rejected before human verification")
    },
  })
  const driver = createTaskDriver({ projectRoot, store, executionAdapter, clock: () => "2026-08-18T10:03:00.000Z" })
  await driver.prepareHumanDecision({
    taskId,
    decision: {
      decisionId: "approve-design",
      requirement: "required",
      leadBindingRef: "binding:lead-1",
      question: "是否批准当前方案进入实施？",
      choices: ["approve", "revise"],
      artifactRefs: ["design-document"],
    },
  })
  await driver.run({ taskId, waitBudgetMs: 0 })
  await writeFile(path.join(projectRoot, "docs", "design.md"), "externally changed contents")

  const resolved = await driver.resolveHumanDecision({ taskId })
  assert.equal(resolved.accepted, false)
  assert.equal(resolved.reason, "evidence-changed")
  assert.equal(resolved.state.status, "working")
  assert.equal(resolved.state.pendingDecision, null)
  assert.equal(verifyCalls, 0)
})

test("artifact verification rejects a symlink even when it resolves to a readable file", async () => {
  const projectRoot = await createProject()
  const store = createFileStore({ projectRoot })
  const taskId = "symlinked-approval-artifact"
  await createWorkingTask(store, taskId)
  const externalPath = path.join(path.dirname(projectRoot), `${path.basename(projectRoot)}-outside.md`)
  await writeFile(externalPath, "approved design contents")
  await rm(path.join(projectRoot, "docs", "design.md"))
  await symlink(externalPath, path.join(projectRoot, "docs", "design.md"))
  const driver = createTaskDriver({ projectRoot, store, executionAdapter: adapter() })

  await assert.rejects(
    driver.prepareHumanDecision({
      taskId,
      decision: {
        decisionId: "approve-design",
        requirement: "required",
        leadBindingRef: "binding:lead-1",
        question: "是否批准当前方案进入实施？",
        choices: ["approve", "revise"],
        artifactRefs: ["design-document"],
      },
    }),
    (error) => error.code === "EVIDENCE_PATH_ESCAPE",
  )
})
