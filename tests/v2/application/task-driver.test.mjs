import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { createTaskDriver } from "../../../runtime/application/driver.mjs"
import { createTaskAggregate, digestEffect, reduceTask } from "../../../runtime/domain/index.mjs"
import { createMemberDelivery } from "../../../runtime/member-delivery.mjs"
import { createPlatformObservationSink } from "../../../runtime/platform-observation.mjs"
import { createFileStore } from "../../../runtime/persistence/index.mjs"

const workflow = {
  workflowId: "engineering",
  version: "2026-08-18",
  digest: "a".repeat(64),
  stages: ["implementation"],
  edges: [],
  terminalStages: ["implementation"],
}

async function createProject() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-v2-driver-"))
  await mkdir(path.join(projectRoot, ".team-work", "tasks"), { recursive: true })
  await writeFile(path.join(projectRoot, ".team-work", "project.json"), `${JSON.stringify({
    runtimeMajor: 2,
    schemaVersion: "2.0",
  })}\n`)
  return projectRoot
}

function event(revision, type, occurredAt) {
  return { eventId: `${type.replaceAll(".", "-")}-${revision}`, type, occurredAt, revision, refs: ["stage-run-1"] }
}

async function createDispatchPendingTask(store, taskId = "driver-dispatch", { prepareOnly = false } = {}) {
  let state = createTaskAggregate({
    taskId,
    title: "Dispatch one member",
    objective: "Prove durable effect coordination",
    workflow,
    entryStage: "implementation",
    completion: { mode: "workflow" },
    stageRunId: "stage-run-1",
    createdAt: "2026-08-18T10:00:00.000Z",
  })
  await store.createTask(state)
  let result = reduceTask(state, {
    type: "stage-plan.frozen",
    expectedRevision: 0,
    occurredAt: "2026-08-18T10:01:00.000Z",
    plan: {
      planId: "plan-1",
      stageRunId: "stage-run-1",
      objective: "Implement the requested change",
      inputRefs: ["artifact:source"],
      outputRefs: ["artifact:implementation"],
      assignments: [{
        assignmentId: "implementation-owner",
        teamRole: "owner",
        assignmentKind: "implementation",
        costTier: "junior",
        dependsOn: [],
        readableRefs: ["artifact:source"],
        writableRefs: ["artifact:implementation"],
        completionCriteria: ["submit a structured report"],
        execution: {
          agentId: "junior-luna",
          capabilitySnapshotDigest: "capability-snapshot-1",
          contextRef: `.team-work/tasks/${taskId}/context/owner.md`,
          promptRef: `.team-work/tasks/${taskId}/prompts/implementation-owner.md`,
        },
      }],
    },
    costLedger: { forecastMin: 1, forecastMax: 2, accrued: 0, uncertain: 0, nextWave: 1, automaticLimit: 2 },
  })
  state = await store.commit({
    taskId,
    expectedRevision: 0,
    state: result.state,
    auditEvents: [event(1, "stage-plan.frozen", "2026-08-18T10:01:00.000Z")],
  })
  if (prepareOnly) return state
  const effect = {
    operationId: "dispatch-operation-1",
    effectDigest: "0".repeat(64),
    taskId,
    stageRunId: "stage-run-1",
    assignmentId: "implementation-owner",
    attempt: 1,
    role: "owner",
    assignmentKind: "implementation",
    agentId: "junior-luna",
    capabilitySnapshotDigest: "capability-snapshot-1",
    mode: "background",
    contextRef: `.team-work/tasks/${taskId}/context/owner.md`,
    promptRef: `.team-work/tasks/${taskId}/prompts/implementation-owner.md`,
  }
  effect.effectDigest = digestEffect(effect)
  result = reduceTask(state, {
    type: "assignment.attempt-started",
    expectedRevision: 1,
    occurredAt: "2026-08-18T10:02:00.000Z",
    assignmentId: "implementation-owner",
    stageRunId: "stage-run-1",
    attemptId: "implementation-owner-attempt-1",
    attempt: 1,
    effect,
  })
  return store.commit({
    taskId,
    expectedRevision: 1,
    state: result.state,
    auditEvents: [event(2, "assignment.attempt-started", "2026-08-18T10:02:00.000Z")],
  })
}

function fakeExecutionAdapter(overrides = {}) {
  return {
    capabilities: async () => assert.fail("not used"),
    bindLead: async () => assert.fail("not used"),
    ensureExecution: async () => assert.fail("ensureExecution must be provided"),
    inspectExecution: async () => assert.fail("inspectExecution must be provided"),
    inspectStop: async () => assert.fail("inspectStop must be provided"),
    quiesce: async () => assert.fail("not used"),
    verifyHumanDecision: async () => assert.fail("not used"),
    stopExecution: async () => assert.fail("not used"),
    ...overrides,
  }
}

test("the driver derives a durable background dispatch from a frozen planned assignment", async () => {
  const projectRoot = await createProject()
  const store = createFileStore({ projectRoot })
  await createDispatchPendingTask(store, "planned-dispatch", { prepareOnly: true })
  let receivedEffect
  const executionAdapter = fakeExecutionAdapter({
    ensureExecution: async (effect) => {
      receivedEffect = effect
      return {
        operationId: effect.operationId,
        effectDigest: effect.effectDigest,
        status: "confirmed",
        executionRef: "member-session-planned",
        agentId: effect.agentId,
        observedAt: "2026-08-18T10:03:00.000Z",
      }
    },
    inspectExecution: async () => assert.fail("not used"),
  })
  const driver = createTaskDriver({ store, executionAdapter, clock: () => "2026-08-18T10:02:00.000Z" })

  const outcome = await driver.run({ taskId: "planned-dispatch", waitBudgetMs: 0 })

  assert.equal(receivedEffect.mode, "background")
  assert.equal(receivedEffect.agentId, "junior-luna")
  assert.equal(receivedEffect.assignmentId, "implementation-owner")
  assert.equal(outcome.reason, "waiting-report")
  assert.equal(outcome.state.currentStageRun.status, "dispatching")
  assert.equal(outcome.state.workGraph.assignments[0].status, "running")
})

test("the driver persists invocation state before dispatch and commits only a confirmed receipt as running", async () => {
  const projectRoot = await createProject()
  const store = createFileStore({ projectRoot })
  await createDispatchPendingTask(store)
  let ensureCalls = 0
  const executionAdapter = fakeExecutionAdapter({
    ensureExecution: async (effect) => {
      ensureCalls += 1
      const durable = await store.loadTask(effect.taskId)
      assert.equal(durable.workGraph.assignments[0].status, "in-doubt")
      assert.equal(durable.pendingOperations[0].status, "in-doubt")
      assert.equal(durable.pendingOperations[0].invocationCount, 1)
      return {
        operationId: effect.operationId,
        effectDigest: effect.effectDigest,
        status: "confirmed",
        executionRef: "member-session-1",
        agentId: effect.agentId,
        observedAt: "2026-08-18T10:03:00.000Z",
      }
    },
    inspectExecution: async () => assert.fail("a fresh intent must use ensureExecution"),
  })
  const driver = createTaskDriver({
    store,
    executionAdapter,
    clock: () => "2026-08-18T10:02:30.000Z",
  })

  const outcome = await driver.run({ taskId: "driver-dispatch", waitBudgetMs: 0 })

  assert.equal(ensureCalls, 1)
  assert.equal(outcome.reason, "waiting-report")
  assert.equal(outcome.state.workGraph.assignments[0].status, "running")
  assert.equal(outcome.state.workGraph.assignments[0].attempts[0].receiptRef, "dispatch-operation-1")
  assert.equal(outcome.state.workGraph.assignments[0].attempts[0].executionRef, "member-session-1")
  assert.deepEqual(outcome.state.pendingOperations, [])
  const operation = JSON.parse(await readFile(path.join(
    projectRoot,
    ".team-work/tasks/driver-dispatch/operations/dispatch-operation-1.json",
  ), "utf8"))
  assert.equal(operation.receipt.status, "confirmed")
  assert.equal(operation.intent.mode, "background")
})

test("a restart inspects an in-doubt dispatch instead of creating a second execution", async () => {
  const projectRoot = await createProject()
  const store = createFileStore({ projectRoot })
  await createDispatchPendingTask(store, "recover-dispatch")
  let ensureCalls = 0
  let inspectCalls = 0
  const confirmedReceipt = {
    operationId: "dispatch-operation-1",
    effectDigest: (await store.loadTask("recover-dispatch")).pendingOperations[0].effectDigest,
    status: "confirmed",
    executionRef: "member-session-recovered",
    agentId: "junior-luna",
    observedAt: "2026-08-18T10:04:00.000Z",
  }
  const executionAdapter = fakeExecutionAdapter({
    ensureExecution: async () => {
      ensureCalls += 1
      return confirmedReceipt
    },
    inspectExecution: async () => {
      inspectCalls += 1
      return confirmedReceipt
    },
  })
  const interrupted = createTaskDriver({
    store,
    executionAdapter,
    clock: () => "2026-08-18T10:02:30.000Z",
    faultInjector: { afterReceipt: async () => { throw new Error("simulated host crash") } },
  })

  await assert.rejects(
    interrupted.run({ taskId: "recover-dispatch", waitBudgetMs: 0 }),
    /simulated host crash/,
  )
  const uncertain = await store.loadTask("recover-dispatch")
  assert.equal(uncertain.pendingOperations[0].status, "in-doubt")
  assert.equal(uncertain.workGraph.assignments[0].status, "in-doubt")

  const recovered = createTaskDriver({ store, executionAdapter, clock: () => "2026-08-18T10:10:00.000Z" })
  const outcome = await recovered.run({ taskId: "recover-dispatch", waitBudgetMs: 0 })

  assert.equal(ensureCalls, 1)
  assert.equal(inspectCalls, 1)
  assert.equal(outcome.reason, "waiting-report")
  assert.equal(outcome.state.workGraph.assignments[0].attempts[0].executionRef, "member-session-recovered")
})

test("a concurrent driver does not inspect or repeat an invocation whose durable lease is still active", async () => {
  const projectRoot = await createProject()
  const store = createFileStore({ projectRoot })
  await createDispatchPendingTask(store, "concurrent-dispatch")
  const pending = await store.loadTask("concurrent-dispatch")
  const effect = pending.pendingOperations[0].intent
  let releaseEnsure
  let markEnsureStarted
  const ensureStarted = new Promise((resolve) => { markEnsureStarted = resolve })
  const ensureReleased = new Promise((resolve) => { releaseEnsure = resolve })
  let inspectCalls = 0
  const executionAdapter = fakeExecutionAdapter({
    ensureExecution: async () => {
      markEnsureStarted()
      await ensureReleased
      return {
        operationId: effect.operationId,
        effectDigest: effect.effectDigest,
        status: "confirmed",
        executionRef: "member-session-concurrent",
        agentId: effect.agentId,
        observedAt: "2026-08-18T10:03:00.000Z",
      }
    },
    inspectExecution: async () => {
      inspectCalls += 1
      return {
        operationId: effect.operationId,
        effectDigest: effect.effectDigest,
        status: "in-doubt",
        agentId: effect.agentId,
        observedAt: "2026-08-18T10:02:45.000Z",
      }
    },
  })
  const firstDriver = createTaskDriver({ store, executionAdapter, clock: () => "2026-08-18T10:02:30.000Z" })
  const secondDriver = createTaskDriver({ store, executionAdapter, clock: () => "2026-08-18T10:02:31.000Z" })
  const firstRun = firstDriver.run({ taskId: "concurrent-dispatch", waitBudgetMs: 0 })
  await ensureStarted

  const concurrent = await secondDriver.run({ taskId: "concurrent-dispatch", waitBudgetMs: 0 })
  assert.equal(concurrent.reason, "in-doubt")
  assert.equal(inspectCalls, 0)

  releaseEnsure()
  const completed = await firstRun
  assert.equal(completed.reason, "waiting-report")
  assert.equal(completed.state.workGraph.assignments[0].attempts[0].executionRef, "member-session-concurrent")
})

test("retryable dispatch failures are bounded and end in an explicit blocker", async () => {
  const projectRoot = await createProject()
  const store = createFileStore({ projectRoot })
  await createDispatchPendingTask(store, "bounded-retry")
  let calls = 0
  const executionAdapter = fakeExecutionAdapter({
    ensureExecution: async (effect) => {
      calls += 1
      return {
        operationId: effect.operationId,
        effectDigest: effect.effectDigest,
        status: "failed",
        agentId: effect.agentId,
        observedAt: `2026-08-18T10:0${2 + calls}:00.000Z`,
        error: { code: "gateway-capacity", retryable: true, message: "provider is saturated" },
      }
    },
    inspectExecution: async () => assert.fail("a completed failed call must not be inspected"),
  })
  const driver = createTaskDriver({ store, executionAdapter, maxEffectAttempts: 2 })

  const outcome = await driver.run({ taskId: "bounded-retry", waitBudgetMs: 0 })

  assert.equal(calls, 2)
  assert.equal(outcome.reason, "blocked")
  assert.equal(outcome.state.workGraph.assignments[0].status, "blocked")
  assert.deepEqual(outcome.state.pendingOperations, [])
})

test("member reports land atomically, dedupe retries, and replay once through the inbox", async () => {
  const projectRoot = await createProject()
  const store = createFileStore({ projectRoot })
  await createDispatchPendingTask(store, "member-report")
  const pending = await store.loadTask("member-report")
  const effect = pending.pendingOperations[0].intent
  const executionAdapter = fakeExecutionAdapter({
    ensureExecution: async () => ({
      operationId: effect.operationId,
      effectDigest: effect.effectDigest,
      status: "confirmed",
      executionRef: "member-session-report",
      agentId: effect.agentId,
      observedAt: "2026-08-18T10:03:00.000Z",
    }),
    inspectExecution: async () => assert.fail("not used"),
  })
  const driver = createTaskDriver({ store, executionAdapter, clock: () => "2026-08-18T10:04:00.000Z" })
  await driver.run({ taskId: "member-report", waitBudgetMs: 0 })
  const binding = {
    taskId: "member-report",
    assignmentId: "implementation-owner",
    attemptId: "implementation-owner-attempt-1",
    executionRef: "member-session-report",
    operationKey: "host-tool-call-42",
  }
  const delivery = createMemberDelivery({
    report: (report) => driver.deliverMemberReport({ ...binding, report }),
  })
  const report = {
    outcome: "delivered",
    summary: "Implementation and focused tests are complete.",
    artifacts: ["src/feature.mjs", "tests/feature.test.mjs"],
    evidenceRefs: ["check:test-1"],
    checks: [{ name: "focused tests", result: "pass", evidenceRef: "check:test-1" }],
    recommendation: "accept",
  }

  const first = await delivery.report(report)
  const revisionAfterFirst = (await store.loadTask("member-report")).revision
  const duplicate = await delivery.report(report)

  assert.equal(first.duplicate, false)
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.reportId, first.reportId)
  assert.equal(duplicate.observationId, first.observationId)
  assert.equal((await store.loadTask("member-report")).revision, revisionAfterFirst)

  const outcome = await driver.run({ taskId: "member-report", waitBudgetMs: 0 })
  const attempt = outcome.state.workGraph.assignments[0].attempts[0]
  assert.equal(attempt.status, "reported")
  assert.equal(attempt.reportRef, first.reportId)
  assert.equal(outcome.state.observationInbox.acknowledgedThrough, 1)
  assert.deepEqual(outcome.state.observationInbox.items, [])
  assert.equal(outcome.state.observationInbox.dedupe.length, 1)

  const afterConsumption = await delivery.report(report)
  assert.equal(afterConsumption.duplicate, true)
  assert.equal(afterConsumption.stateRevision, first.stateRevision)

  const stored = JSON.parse(await readFile(path.join(
    projectRoot,
    `.team-work/tasks/member-report/reports/${first.reportId}.json`,
  ), "utf8"))
  assert.equal(stored.report.summary, report.summary)
  assert.equal("transcript" in stored, false)
  assert.equal("toolLogs" in stored, false)
})

test("platform observations use the same durable sequence and dedupe protocol", async () => {
  const projectRoot = await createProject()
  const store = createFileStore({ projectRoot })
  await createDispatchPendingTask(store, "platform-observation")
  const pending = await store.loadTask("platform-observation")
  const effect = pending.pendingOperations[0].intent
  const executionAdapter = fakeExecutionAdapter({
    ensureExecution: async () => ({
      operationId: effect.operationId,
      effectDigest: effect.effectDigest,
      status: "confirmed",
      executionRef: "member-session-observed",
      agentId: effect.agentId,
      observedAt: "2026-08-18T10:03:00.000Z",
    }),
    inspectExecution: async () => assert.fail("not used"),
  })
  const driver = createTaskDriver({ store, executionAdapter })
  await driver.run({ taskId: "platform-observation", waitBudgetMs: 0 })
  const sink = createPlatformObservationSink({
    observe: (observation) => driver.observe({ taskId: "platform-observation", observation }),
  })
  const idle = {
    kind: "execution",
    observationId: "host-event-idle-1",
    dedupeKey: "member-session-observed:idle:1",
    executionRef: "member-session-observed",
    assignmentId: "implementation-owner",
    state: "idle",
    observedAt: "2026-08-18T10:04:00.000Z",
  }

  const first = await sink.observe(idle)
  const duplicate = await sink.observe(idle)
  assert.equal(first.sequence, 1)
  assert.equal(first.duplicate, false)
  assert.deepEqual(duplicate, { ...first, duplicate: true })

  const waiting = await driver.run({ taskId: "platform-observation", waitBudgetMs: 0 })
  assert.equal(waiting.reason, "settling-idle")
  assert.equal(waiting.state.observationInbox.acknowledgedThrough, 1)
  assert.equal(waiting.state.observationInbox.dedupe.length, 1)

  await assert.rejects(
    sink.observe({ ...idle, state: "lost", observedAt: "2026-08-18T10:05:00.000Z" }),
    (error) => error.code === "OBSERVATION_DEDUPE_CONFLICT",
  )
})

test("a lost execution becomes an explicit blocker after its observation is acknowledged", async () => {
  const projectRoot = await createProject()
  const store = createFileStore({ projectRoot })
  await createDispatchPendingTask(store, "lost-execution")
  const pending = await store.loadTask("lost-execution")
  const effect = pending.pendingOperations[0].intent
  const executionAdapter = fakeExecutionAdapter({
    ensureExecution: async () => ({
      operationId: effect.operationId,
      effectDigest: effect.effectDigest,
      status: "confirmed",
      executionRef: "member-session-lost",
      agentId: effect.agentId,
      observedAt: "2026-08-18T10:03:00.000Z",
    }),
    inspectExecution: async () => assert.fail("not used"),
  })
  const driver = createTaskDriver({ store, executionAdapter })
  await driver.run({ taskId: "lost-execution", waitBudgetMs: 0 })
  await driver.observe({
    taskId: "lost-execution",
    observation: {
      kind: "execution",
      observationId: "host-event-lost-1",
      dedupeKey: "member-session-lost:lost:1",
      executionRef: "member-session-lost",
      assignmentId: "implementation-owner",
      state: "lost",
      observedAt: "2026-08-18T10:04:00.000Z",
    },
  })

  const outcome = await driver.run({ taskId: "lost-execution", waitBudgetMs: 0 })
  assert.equal(outcome.reason, "blocked")
  assert.equal(outcome.state.workGraph.assignments[0].status, "lost")
  assert.equal(outcome.state.observationInbox.acknowledgedThrough, 1)
})

test("idle waits for a settle window, resumes the same execution once, then blocks if idle repeats", async () => {
  const projectRoot = await createProject()
  const store = createFileStore({ projectRoot })
  await createDispatchPendingTask(store, "idle-correction", { prepareOnly: true })
  let ensureCalls = 0
  const effects = []
  const executionAdapter = fakeExecutionAdapter({
    ensureExecution: async (effect) => {
      ensureCalls += 1
      effects.push(effect)
      return {
        operationId: effect.operationId,
        effectDigest: effect.effectDigest,
        status: "confirmed",
        executionRef: "member-session-idle",
        agentId: effect.agentId,
        observedAt: new Date().toISOString(),
      }
    },
    inspectExecution: async () => assert.fail("not used"),
  })
  const driver = createTaskDriver({ store, executionAdapter, idleSettleMs: 10, maxIdleCorrections: 1 })
  await driver.run({ taskId: "idle-correction", waitBudgetMs: 0 })
  const observedAt = new Date().toISOString()
  await driver.observe({
    taskId: "idle-correction",
    observation: {
      kind: "execution",
      observationId: "host-idle-first",
      dedupeKey: "member-session-idle:idle:1",
      executionRef: "member-session-idle",
      assignmentId: "implementation-owner",
      state: "idle",
      observedAt,
    },
  })

  const corrected = await driver.run({ taskId: "idle-correction", waitBudgetMs: 40 })
  assert.equal(corrected.reason, "wait-budget-exhausted")
  assert.equal(ensureCalls, 2)
  assert.equal(effects[1].resumeExecutionRef, "member-session-idle")
  assert.equal(corrected.state.workGraph.assignments[0].attempts[0].correctionCount, 1)

  await driver.observe({
    taskId: "idle-correction",
    observation: {
      kind: "execution",
      observationId: "host-idle-second",
      dedupeKey: "member-session-idle:idle:2",
      executionRef: "member-session-idle",
      assignmentId: "implementation-owner",
      state: "idle",
      observedAt: new Date().toISOString(),
    },
  })
  const blocked = await driver.run({ taskId: "idle-correction", waitBudgetMs: 40 })
  assert.equal(blocked.reason, "blocked")
  assert.equal(blocked.state.workGraph.assignments[0].status, "blocked")
  assert.equal(ensureCalls, 2)
})

test("a committed report survives a crash before its in-process wake signal", async () => {
  const projectRoot = await createProject()
  const store = createFileStore({ projectRoot })
  await createDispatchPendingTask(store, "report-signal-crash")
  const pending = await store.loadTask("report-signal-crash")
  const effect = pending.pendingOperations[0].intent
  const executionAdapter = fakeExecutionAdapter({
    ensureExecution: async () => ({
      operationId: effect.operationId,
      effectDigest: effect.effectDigest,
      status: "confirmed",
      executionRef: "member-session-crash",
      agentId: effect.agentId,
      observedAt: "2026-08-18T10:03:00.000Z",
    }),
    inspectExecution: async () => assert.fail("not used"),
  })
  let crash = true
  const interrupted = createTaskDriver({
    store,
    executionAdapter,
    faultInjector: {
      afterInboxCommit: async () => {
        if (crash) {
          crash = false
          throw new Error("simulated crash before signal")
        }
      },
    },
  })
  await interrupted.run({ taskId: "report-signal-crash", waitBudgetMs: 0 })
  const binding = {
    taskId: "report-signal-crash",
    assignmentId: "implementation-owner",
    attemptId: "implementation-owner-attempt-1",
    executionRef: "member-session-crash",
    operationKey: "host-tool-call-crash",
  }
  const report = {
    outcome: "delivered",
    summary: "The result was persisted before the host interruption.",
    artifacts: ["src/feature.mjs"],
    evidenceRefs: [],
    recommendation: "accept",
  }
  await assert.rejects(interrupted.deliverMemberReport({ ...binding, report }), /simulated crash before signal/)
  assert.equal((await store.loadTask("report-signal-crash")).observationInbox.items.length, 1)

  const recovered = createTaskDriver({ store, executionAdapter })
  const duplicate = await recovered.deliverMemberReport({ ...binding, report })
  assert.equal(duplicate.duplicate, true)
  const outcome = await recovered.run({ taskId: "report-signal-crash", waitBudgetMs: 0 })
  assert.equal(outcome.state.workGraph.assignments[0].status, "reported")
})

test("run waits on SignalHub and consumes a report without platform polling", async () => {
  const projectRoot = await createProject()
  const store = createFileStore({ projectRoot })
  await createDispatchPendingTask(store, "signal-wait")
  const pending = await store.loadTask("signal-wait")
  const effect = pending.pendingOperations[0].intent
  const executionAdapter = fakeExecutionAdapter({
    ensureExecution: async () => ({
      operationId: effect.operationId,
      effectDigest: effect.effectDigest,
      status: "confirmed",
      executionRef: "member-session-wait",
      agentId: effect.agentId,
      observedAt: "2026-08-18T10:03:00.000Z",
    }),
    inspectExecution: async () => assert.fail("not used"),
  })
  const driver = createTaskDriver({ store, executionAdapter })
  await driver.run({ taskId: "signal-wait", waitBudgetMs: 0 })
  const waiting = driver.run({ taskId: "signal-wait", waitBudgetMs: 2_000 })
  await new Promise((resolve) => setImmediate(resolve))
  await driver.deliverMemberReport({
    taskId: "signal-wait",
    assignmentId: "implementation-owner",
    attemptId: "implementation-owner-attempt-1",
    executionRef: "member-session-wait",
    operationKey: "host-tool-call-wakeup",
    report: {
      outcome: "delivered",
      summary: "The member completed while run was suspended.",
      artifacts: ["src/feature.mjs"],
      evidenceRefs: [],
      recommendation: "accept",
    },
  })

  const outcome = await waiting
  assert.equal(outcome.reason, "stable")
  assert.equal(outcome.state.workGraph.assignments[0].status, "reported")
})

test("an exhausted host wait budget returns without changing durable task state", async () => {
  const projectRoot = await createProject()
  const store = createFileStore({ projectRoot })
  await createDispatchPendingTask(store, "wait-budget")
  const pending = await store.loadTask("wait-budget")
  const effect = pending.pendingOperations[0].intent
  const executionAdapter = fakeExecutionAdapter({
    ensureExecution: async () => ({
      operationId: effect.operationId,
      effectDigest: effect.effectDigest,
      status: "confirmed",
      executionRef: "member-session-budget",
      agentId: effect.agentId,
      observedAt: "2026-08-18T10:03:00.000Z",
    }),
    inspectExecution: async () => assert.fail("not used"),
  })
  const driver = createTaskDriver({ store, executionAdapter })
  await driver.run({ taskId: "wait-budget", waitBudgetMs: 0 })
  const before = await store.loadTask("wait-budget")

  const outcome = await driver.run({ taskId: "wait-budget", waitBudgetMs: 10 })

  assert.equal(outcome.reason, "wait-budget-exhausted")
  assert.deepEqual(outcome.state, before)
  assert.deepEqual(await store.loadTask("wait-budget"), before)
})

test("stop execution persists intent and inspects after a receipt-loss crash", async () => {
  const projectRoot = await createProject()
  const store = createFileStore({ projectRoot })
  await createDispatchPendingTask(store, "durable-stop")
  let state = await store.loadTask("durable-stop")
  const dispatch = state.pendingOperations[0].intent
  let stopCalls = 0
  let inspectStopCalls = 0
  const stopReceipt = {
    operationId: "stop-operation-1",
    effectDigest: "",
    status: "confirmed",
    executionRef: "member-session-stop",
    observedAt: "2026-08-18T10:05:00.000Z",
  }
  const executionAdapter = fakeExecutionAdapter({
    ensureExecution: async () => ({
      operationId: dispatch.operationId,
      effectDigest: dispatch.effectDigest,
      status: "confirmed",
      executionRef: "member-session-stop",
      agentId: dispatch.agentId,
      observedAt: "2026-08-18T10:03:00.000Z",
    }),
    inspectExecution: async () => assert.fail("not used"),
    stopExecution: async (intent) => {
      stopCalls += 1
      const durable = await store.loadTask("durable-stop")
      assert.equal(durable.pendingOperations[0].status, "in-doubt")
      assert.equal(durable.workGraph.assignments[0].status, "running")
      return { ...stopReceipt, operationId: intent.operationId, effectDigest: intent.effectDigest }
    },
    inspectStop: async (intent) => {
      inspectStopCalls += 1
      return { ...stopReceipt, operationId: intent.operationId, effectDigest: intent.effectDigest }
    },
  })
  const dispatchDriver = createTaskDriver({ store, executionAdapter, clock: () => "2026-08-18T10:04:00.000Z" })
  await dispatchDriver.run({ taskId: "durable-stop", waitBudgetMs: 0 })
  state = await store.loadTask("durable-stop")
  const stopIntent = {
    operationId: "stop-operation-1",
    effectDigest: "0".repeat(64),
    executionRef: "member-session-stop",
    reason: "replace a lost owner",
  }
  stopIntent.effectDigest = digestEffect(stopIntent)
  const requested = reduceTask(state, {
    type: "execution.stop-requested",
    expectedRevision: state.revision,
    assignmentId: "implementation-owner",
    attemptId: "implementation-owner-attempt-1",
    intent: stopIntent,
    occurredAt: "2026-08-18T10:04:00.000Z",
  }).state
  await store.commit({
    taskId: state.taskId,
    expectedRevision: state.revision,
    state: requested,
    auditEvents: [event(requested.revision, "execution.stop-requested", "2026-08-18T10:04:00.000Z")],
  })

  const interrupted = createTaskDriver({
    store,
    executionAdapter,
    clock: () => "2026-08-18T10:04:00.000Z",
    faultInjector: { afterReceipt: async () => { throw new Error("simulated stop receipt loss") } },
  })
  await assert.rejects(interrupted.run({ taskId: "durable-stop", waitBudgetMs: 0 }), /simulated stop receipt loss/)
  assert.equal((await store.loadTask("durable-stop")).pendingOperations[0].status, "in-doubt")

  const recovered = createTaskDriver({ store, executionAdapter, clock: () => "2026-08-18T10:10:00.000Z" })
  const outcome = await recovered.run({ taskId: "durable-stop", waitBudgetMs: 0 })
  assert.equal(stopCalls, 1)
  assert.equal(inspectStopCalls, 1)
  assert.equal(outcome.reason, "blocked")
  assert.equal(outcome.state.workGraph.assignments[0].status, "blocked")
  assert.deepEqual(outcome.state.pendingOperations, [])
  const operation = JSON.parse(await readFile(path.join(
    projectRoot,
    ".team-work/tasks/durable-stop/operations/stop-operation-1.json",
  ), "utf8"))
  assert.equal(operation.receipt.status, "confirmed")
})
