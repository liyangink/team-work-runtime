import { assertTaskState } from "../domain/invariants.mjs"
import { digestValue } from "../domain/digests.mjs"
import { assertDurableReferences } from "./durable-reference-validator.mjs"
import { StoreError } from "./store-error.mjs"

const recordKinds = new Set(["report", "observation", "operation"])

function clone(value) {
  return structuredClone(value)
}

function recordKey(taskId, kind, recordId) {
  if (typeof taskId !== "string" || taskId === "") throw new StoreError("TASK_NOT_FOUND", "task id is required")
  if (!recordKinds.has(kind) || typeof recordId !== "string" || recordId === "") {
    throw new StoreError("RECORD_INVALID", "record kind and id are required")
  }
  return `${taskId}:${kind}:${recordId}`
}

function same(value, other) {
  return digestValue(value) === digestValue(other)
}

function assertImmutableIdentity(current, next) {
  for (const field of ["taskId", "createdAt", "workflow", "scope"]) {
    if (!same(current[field], next[field])) throw new StoreError("IMMUTABLE_STATE_CHANGED", `${field} cannot change`)
  }
}

async function assertTaskDurableReferences(taskId, state, records, pending = new Map(), { corrupt = false } = {}) {
  return assertDurableReferences({
    state,
    mode: corrupt ? "load" : "commit",
    loadRecord: async (kind, recordId) => {
      const key = recordKey(taskId, kind, recordId)
      return pending.has(key) ? pending.get(key) : records.get(key)
    },
  })
}

export function createInMemoryStore() {
  const tasks = new Map()
  const records = new Map()
  const events = new Map()

  return Object.freeze({
    async createTask(input) {
      const state = assertTaskState(clone(input))
      if (tasks.has(state.taskId)) throw new StoreError("TASK_EXISTS", `task already exists: ${state.taskId}`)
      tasks.set(state.taskId, clone(state))
      events.set(state.taskId, [{
        eventId: "task-created",
        type: "task.created",
        occurredAt: state.createdAt,
        revision: 0,
        refs: [state.currentStageRun.stageRunId],
      }])
      return clone(state)
    },

    async loadTask(taskId) {
      const state = tasks.get(taskId)
      if (!state) throw new StoreError("TASK_NOT_FOUND", `task does not exist: ${taskId}`)
      const authoritative = assertTaskState(clone(state))
      await assertTaskDurableReferences(taskId, authoritative, records, new Map(), { corrupt: true })
      return clone(authoritative)
    },

    async loadRecord(taskId, kind, recordId) {
      if (!tasks.has(taskId)) throw new StoreError("TASK_NOT_FOUND", `task does not exist: ${taskId}`)
      const key = recordKey(taskId, kind, recordId)
      if (!records.has(key)) throw new StoreError("RECORD_NOT_FOUND", `immutable record does not exist: ${key}`)
      return clone(records.get(key))
    },

    async commit({ taskId, expectedRevision, state: input, records: nextRecords = [], auditEvents = [] }) {
      const current = tasks.get(taskId)
      if (!current) throw new StoreError("TASK_NOT_FOUND", `task does not exist: ${taskId}`)
      const state = assertTaskState(clone(input))
      if (current.revision !== expectedRevision || state.revision !== expectedRevision + 1) {
        throw new StoreError("REVISION_CONFLICT", "commit does not advance the current revision exactly once")
      }
      if (state.taskId !== taskId) throw new StoreError("STATE_ID_MISMATCH", "state taskId does not match commit taskId")
      assertImmutableIdentity(current, state)

      const pending = new Map()
      for (const record of nextRecords) {
        const key = recordKey(taskId, record?.kind, record?.recordId)
        if (record.value === undefined || pending.has(key)) throw new StoreError("RECORD_INVALID", `invalid or duplicate immutable record: ${key}`)
        const existing = records.get(key)
        if (existing && !same(existing, record.value)) throw new StoreError("IMMUTABLE_RECORD_CONFLICT", `${key} already exists with different content`)
        pending.set(key, clone(record.value))
      }
      await assertTaskDurableReferences(taskId, state, records, pending)
      const knownEvents = events.get(taskId) ?? []
      if (!Array.isArray(auditEvents) || auditEvents.length === 0) throw new StoreError("AUDIT_REQUIRED", "commit requires an audit event")
      for (const event of auditEvents) {
        if (event.revision !== state.revision || knownEvents.some(({ eventId }) => eventId === event.eventId)) {
          throw new StoreError("AUDIT_INVALID", "audit events must be unique and target the committed revision")
        }
      }
      for (const [key, value] of pending) records.set(key, value)
      tasks.set(taskId, clone(state))
      events.set(taskId, [...knownEvents, ...clone(auditEvents)])
      return clone(state)
    },
  })
}
