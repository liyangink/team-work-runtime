import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { createTaskAggregate, reduceTask } from "../../../runtime/domain/index.mjs"
import { createFileStore } from "../../../runtime/persistence/index.mjs"

const workflow = {
  workflowId: "engineering",
  version: "2026-08-18",
  digest: "a".repeat(64),
  stages: ["implementation", "code-review"],
  edges: [{ from: "implementation", to: "code-review" }],
  terminalStages: ["code-review"],
}

async function createProject() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-v2-store-"))
  await mkdir(path.join(projectRoot, ".team-work", "tasks"), { recursive: true })
  await writeFile(path.join(projectRoot, ".team-work", "project.json"), `${JSON.stringify({
    runtimeMajor: 2,
    schemaVersion: "2.0",
  })}\n`)
  return projectRoot
}

function createState(taskId = "store-task") {
  return createTaskAggregate({
    taskId,
    title: "Persist one task",
    objective: "Keep state.json authoritative",
    workflow,
    entryStage: "implementation",
    completion: { mode: "workflow" },
    stageRunId: "stage-run-1",
    createdAt: "2026-08-18T10:00:00.000Z",
  })
}

test("the file store creates, commits, and reloads the authoritative task snapshot", async () => {
  const projectRoot = await createProject()
  const store = createFileStore({ projectRoot })
  const initial = createState()

  await store.createTask(initial)
  assert.deepEqual(await store.loadTask(initial.taskId), initial)

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
  })

  assert.deepEqual(await store.loadTask(initial.taskId), next)
})

test("reports and completed operations are immutable facts committed with state", async () => {
  const projectRoot = await createProject()
  const store = createFileStore({ projectRoot })
  const initial = createState("immutable-facts")
  await store.createTask(initial)
  const next = reduceTask(initial, {
    type: "stage-run.transitioned",
    expectedRevision: 0,
    status: "dispatching",
    occurredAt: "2026-08-18T10:01:00.000Z",
  }).state
  next.acceptedReportRefs = ["report-1"]
  const report = {
    kind: "report",
    recordId: "report-1",
    value: { reportId: "report-1", outcome: "completed" },
  }
  const event = {
    eventId: "event-1",
    type: "stage-run.transitioned",
    occurredAt: "2026-08-18T10:01:00.000Z",
    refs: ["stage-run-1"],
  }
  await assert.rejects(
    store.commit({ taskId: initial.taskId, expectedRevision: 0, state: next }),
    (error) => error.code === "IMMUTABLE_RECORD_MISSING",
  )
  await store.commit({
    taskId: initial.taskId,
    expectedRevision: 0,
    state: next,
    records: [report],
    auditEvents: [event],
  })

  assert.deepEqual(
    JSON.parse(await readFile(path.join(projectRoot, ".team-work", "tasks", initial.taskId, "reports", "report-1.json"), "utf8")),
    report.value,
  )
  assert.deepEqual(
    JSON.parse((await readFile(path.join(projectRoot, ".team-work", "tasks", initial.taskId, "events.jsonl"), "utf8")).trim()),
    event,
  )

  const revisionTwo = structuredClone(next)
  revisionTwo.revision = 2
  revisionTwo.updatedAt = "2026-08-18T10:02:00.000Z"
  await store.commit({ taskId: initial.taskId, expectedRevision: 1, state: revisionTwo, records: [report], auditEvents: [event] })

  const revisionThree = structuredClone(revisionTwo)
  revisionThree.revision = 3
  revisionThree.updatedAt = "2026-08-18T10:03:00.000Z"
  await assert.rejects(
    store.commit({
      taskId: initial.taskId,
      expectedRevision: 2,
      state: revisionThree,
      records: [{ kind: "operation", recordId: "operation-invalid", value: { status: undefined } }],
    }),
    (error) => error.code === "RECORD_INVALID",
  )
  await assert.rejects(
    store.commit({
      taskId: initial.taskId,
      expectedRevision: 2,
      state: revisionThree,
      records: [{ ...report, value: { reportId: "report-1", outcome: "changed" } }],
    }),
    (error) => error.code === "IMMUTABLE_RECORD_CONFLICT",
  )
  assert.equal((await store.loadTask(initial.taskId)).revision, 2)
})

test("loading a task completes an interrupted transaction from its durable intent", async () => {
  const projectRoot = await createProject()
  const store = createFileStore({ projectRoot })
  const initial = createState("recover-transaction")
  await store.createTask(initial)
  const next = reduceTask(initial, {
    type: "stage-run.transitioned",
    expectedRevision: 0,
    status: "dispatching",
    occurredAt: "2026-08-18T10:01:00.000Z",
  }).state
  const taskRoot = path.join(projectRoot, ".team-work", "tasks", initial.taskId)
  await writeFile(path.join(taskRoot, ".txn", "interrupted-1.json"), `${JSON.stringify({
    schemaVersion: "2.0",
    transactionId: "interrupted-1",
    taskId: initial.taskId,
    expectedRevision: 0,
    state: next,
    records: [{
      kind: "operation",
      recordId: "operation-1",
      value: { operationId: "operation-1", status: "confirmed" },
    }],
  })}\n`)

  assert.deepEqual(await store.loadTask(initial.taskId), next)
  assert.deepEqual(
    JSON.parse(await readFile(path.join(taskRoot, "operations", "operation-1.json"), "utf8")),
    { operationId: "operation-1", status: "confirmed" },
  )
  assert.deepEqual(await readdir(path.join(taskRoot, ".txn")), [])
})

test("concurrent writers cannot silently overwrite the same task revision", async () => {
  const projectRoot = await createProject()
  const firstStore = createFileStore({ projectRoot })
  const secondStore = createFileStore({ projectRoot })
  const initial = createState("concurrent-writers")
  await firstStore.createTask(initial)
  const next = reduceTask(initial, {
    type: "stage-run.transitioned",
    expectedRevision: 0,
    status: "dispatching",
    occurredAt: "2026-08-18T10:01:00.000Z",
  }).state

  const results = await Promise.allSettled([
    firstStore.commit({ taskId: initial.taskId, expectedRevision: 0, state: next }),
    secondStore.commit({ taskId: initial.taskId, expectedRevision: 0, state: next }),
  ])

  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1)
  const rejection = results.find(({ status }) => status === "rejected")
  assert.ok(["LOCK_UNAVAILABLE", "REVISION_CONFLICT"].includes(rejection.reason.code))
  assert.equal((await firstStore.loadTask(initial.taskId)).revision, 1)
})

test("a symlinked task subdirectory cannot escape the project", async () => {
  const projectRoot = await createProject()
  const externalRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-v2-external-"))
  const store = createFileStore({ projectRoot })
  const initial = createState("symlink-escape")
  await store.createTask(initial)
  const reportsRoot = path.join(projectRoot, ".team-work", "tasks", initial.taskId, "reports")
  await rm(reportsRoot, { recursive: true })
  await symlink(externalRoot, reportsRoot)
  const next = reduceTask(initial, {
    type: "stage-run.transitioned",
    expectedRevision: 0,
    status: "dispatching",
    occurredAt: "2026-08-18T10:01:00.000Z",
  }).state

  await assert.rejects(
    store.commit({
      taskId: initial.taskId,
      expectedRevision: 0,
      state: next,
      records: [{ kind: "report", recordId: "report-1", value: { result: "pass" } }],
    }),
    (error) => error.code === "PATH_ESCAPE",
  )
  assert.deepEqual(await readdir(externalRoot), [])
  assert.equal((await store.loadTask(initial.taskId)).revision, 0)
})

test("corrupt snapshots and half-written transaction manifests fail closed", async () => {
  const corruptProject = await createProject()
  const corruptStore = createFileStore({ projectRoot: corruptProject })
  const corruptState = createState("corrupt-state")
  await corruptStore.createTask(corruptState)
  await writeFile(
    path.join(corruptProject, ".team-work", "tasks", corruptState.taskId, "state.json"),
    "{not-json\n",
  )
  await assert.rejects(
    corruptStore.loadTask(corruptState.taskId),
    (error) => error.code === "STATE_CORRUPT",
  )

  const halfWriteProject = await createProject()
  const halfWriteStore = createFileStore({ projectRoot: halfWriteProject })
  const halfWriteState = createState("half-written-transaction")
  await halfWriteStore.createTask(halfWriteState)
  await writeFile(
    path.join(halfWriteProject, ".team-work", "tasks", halfWriteState.taskId, ".txn", "broken.json"),
    "{\"schemaVersion\":\"2.0\"",
  )
  await assert.rejects(
    halfWriteStore.loadTask(halfWriteState.taskId),
    (error) => error.code === "STATE_CORRUPT",
  )

  const halfWriteNext = reduceTask(halfWriteState, {
    type: "stage-run.transitioned",
    expectedRevision: 0,
    status: "dispatching",
    occurredAt: "2026-08-18T10:01:00.000Z",
  }).state
  await writeFile(
    path.join(halfWriteProject, ".team-work", "tasks", halfWriteState.taskId, ".txn", "broken.json"),
    `${JSON.stringify({
      schemaVersion: "2.0",
      transactionId: "broken",
      taskId: halfWriteState.taskId,
      expectedRevision: 0,
      state: halfWriteNext,
      records: [{ kind: "report", recordId: "../escape", value: { unsafe: true } }],
      auditEvents: [],
    })}\n`,
  )
  await assert.rejects(
    halfWriteStore.loadTask(halfWriteState.taskId),
    (error) => error.code === "STATE_CORRUPT",
  )
})

test("an orphaned owner lock does not make a task permanently unrecoverable", async () => {
  const projectRoot = await createProject()
  const store = createFileStore({ projectRoot })
  const initial = createState("orphaned-lock")
  await store.createTask(initial)
  const lockPath = path.join(projectRoot, ".team-work", "tasks", initial.taskId, ".lock")
  await writeFile(lockPath, `${JSON.stringify({
    ownerId: "dead-owner",
    pid: 2147483647,
    acquiredAt: "2026-08-18T09:00:00.000Z",
  })}\n`)

  assert.deepEqual(await store.loadTask(initial.taskId), initial)
  await assert.rejects(readFile(lockPath, "utf8"), (error) => error.code === "ENOENT")
})

test("task creation replaces an abandoned staging directory atomically", async () => {
  const projectRoot = await createProject()
  const initial = createState("recover-create")
  const stagingRoot = path.join(projectRoot, ".team-work", "tasks", `.create-${initial.taskId}.txn`)
  await mkdir(stagingRoot)
  await writeFile(path.join(stagingRoot, "partial"), "incomplete")
  const store = createFileStore({ projectRoot })

  await store.createTask(initial)

  assert.deepEqual(await store.loadTask(initial.taskId), initial)
  await assert.rejects(readdir(stagingRoot), (error) => error.code === "ENOENT")
})

test("cached paths cannot be swapped for a symlink between store calls", async () => {
  const projectRoot = await createProject()
  const externalRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-v2-swapped-"))
  const store = createFileStore({ projectRoot })
  await store.createTask(createState("prime-store-paths"))
  const tasksRoot = path.join(projectRoot, ".team-work", "tasks")
  await rename(tasksRoot, `${tasksRoot}-safe`)
  await symlink(externalRoot, tasksRoot)

  await assert.rejects(
    store.createTask(createState("must-not-escape")),
    (error) => error.code === "PATH_ESCAPE",
  )
  assert.deepEqual(await readdir(externalRoot), [])
})
