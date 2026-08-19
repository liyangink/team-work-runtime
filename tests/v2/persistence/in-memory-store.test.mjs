import assert from "node:assert/strict"
import test from "node:test"

import { digestValue } from "../../../runtime/domain/digests.mjs"
import { createTaskAggregate, reduceTask } from "../../../runtime/domain/index.mjs"
import { createInMemoryStore } from "../../../runtime/persistence/index.mjs"

const workflow = {
  workflowId: "engineering",
  version: "2026-08-18",
  digest: "a".repeat(64),
  stages: ["implementation"],
  edges: [],
  terminalStages: ["implementation"],
}

test("the in-memory Store preserves the same revision and immutable-record boundary", async () => {
  const store = createInMemoryStore()
  const initial = createTaskAggregate({
    taskId: "memory-store",
    title: "Exercise the in-memory Store",
    objective: "Use the Store seam in platform-neutral E2E",
    workflow,
    entryStage: "implementation",
    completion: { mode: "workflow" },
    stageRunId: "stage-run-1",
    createdAt: "2026-08-18T10:00:00.000Z",
  })
  await store.createTask(initial)
  const next = reduceTask(initial, {
    type: "stage-run.transitioned",
    expectedRevision: 0,
    status: "dispatching",
    occurredAt: "2026-08-18T10:01:00.000Z",
  }).state
  await store.commit({
    taskId: initial.taskId,
    expectedRevision: 0,
    state: next,
    records: [{ kind: "operation", recordId: "operation-1", value: { status: "confirmed" } }],
    auditEvents: [{ eventId: "event-1", type: "stage-run.transitioned", occurredAt: "2026-08-18T10:01:00.000Z", revision: 1, refs: ["stage-run-1"] }],
  })

  assert.equal((await store.loadTask(initial.taskId)).revision, 1)
  assert.deepEqual(await store.loadRecord(initial.taskId, "operation", "operation-1"), { status: "confirmed" })
  await assert.rejects(store.commit({
    taskId: initial.taskId,
    expectedRevision: 0,
    state: next,
    auditEvents: [{ eventId: "event-stale", type: "stale", occurredAt: "2026-08-18T10:01:00.000Z", revision: 1, refs: [] }],
  }), (error) => error.code === "REVISION_CONFLICT")
})

test("the in-memory Store rejects bad durable references without consuming a revision", async () => {
  const store = createInMemoryStore()
  const initial = createTaskAggregate({
    taskId: "memory-durable-refs",
    title: "Reject bad durable references",
    objective: "Keep in-memory persistence fail closed",
    workflow,
    entryStage: "implementation",
    completion: { mode: "workflow" },
    stageRunId: "stage-run-1",
    createdAt: "2026-08-18T10:00:00.000Z",
  })
  await store.createTask(initial)
  const next = reduceTask(initial, {
    type: "stage-run.transitioned",
    expectedRevision: 0,
    status: "dispatching",
    occurredAt: "2026-08-18T10:01:00.000Z",
  }).state
  const report = { reportId: "report-1", outcome: "completed" }
  next.acceptedReportRefs = [{ reportId: "report-1", digest: digestValue(report) }]
  const event = { eventId: "event-1", type: "stage-run.transitioned", occurredAt: "2026-08-18T10:01:00.000Z", revision: 1, refs: ["stage-run-1"] }

  await assert.rejects(
    store.commit({ taskId: initial.taskId, expectedRevision: 0, state: next, auditEvents: [event] }),
    (error) => error.code === "IMMUTABLE_RECORD_MISSING",
  )
  assert.equal((await store.loadTask(initial.taskId)).revision, 0)

  const mismatched = structuredClone(next)
  mismatched.acceptedReportRefs[0].digest = "f".repeat(64)
  await assert.rejects(
    store.commit({
      taskId: initial.taskId,
      expectedRevision: 0,
      state: mismatched,
      records: [{ kind: "report", recordId: "report-1", value: report }],
      auditEvents: [event],
    }),
    (error) => error.code === "IMMUTABLE_RECORD_DIGEST_MISMATCH",
  )
  assert.equal((await store.loadTask(initial.taskId)).revision, 0)
})

test("the in-memory Store rechecks revision after async validation so concurrent commits cannot both win", async () => {
  const store = createInMemoryStore()
  const initial = createTaskAggregate({
    taskId: "memory-concurrent-commit",
    title: "Serialize in-memory commits",
    objective: "Match the production Store revision contract",
    workflow,
    entryStage: "implementation",
    completion: { mode: "workflow" },
    stageRunId: "stage-run-1",
    createdAt: "2026-08-18T10:00:00.000Z",
  })
  await store.createTask(initial)
  const next = reduceTask(initial, {
    type: "stage-run.transitioned",
    expectedRevision: 0,
    status: "dispatching",
    occurredAt: "2026-08-18T10:01:00.000Z",
  }).state
  const commit = (suffix) => store.commit({
    taskId: initial.taskId,
    expectedRevision: 0,
    state: next,
    auditEvents: [{
      eventId: `event-${suffix}`,
      type: "stage-run.transitioned",
      occurredAt: "2026-08-18T10:01:00.000Z",
      revision: 1,
      refs: ["stage-run-1"],
    }],
  })

  const outcomes = await Promise.allSettled([commit("left"), commit("right")])
  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1)
  assert.equal(outcomes.filter(({ status, reason }) => status === "rejected" && reason.code === "REVISION_CONFLICT").length, 1)
  assert.equal((await store.loadTask(initial.taskId)).revision, 1)
})
