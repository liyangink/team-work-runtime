import { lstat, mkdir, readFile, rename, rm } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

import {
  assertIdentifier,
  assertNonEmptyString,
  assertStringList,
  assertTaskState,
  assertTimestamp,
} from "../domain/invariants.mjs"
import { assertProjectRuntimeMajor } from "../version.mjs"

import { newTaskRoot, resolveExistingTaskRoot, resolveStorePaths, resolveTaskSubdirectory } from "./paths.mjs"
import { recoverTransactions } from "./recovery.mjs"
import { StoreError } from "./store-error.mjs"
import { atomicJson, atomicWrite, canonicalJson, syncDirectory, withOwnerLock } from "./transactions.mjs"

const taskDirectories = ["reports", "packets", "operations", "artifacts", ".txn"]

function parseState(source, label) {
  try {
    return assertTaskState(JSON.parse(source))
  } catch (error) {
    throw new StoreError("STATE_CORRUPT", `${label} is not a valid task snapshot`, [{ message: error.message }])
  }
}

async function readState(taskRoot) {
  try {
    return parseState(await readFile(path.join(taskRoot, "state.json"), "utf8"), "state.json")
  } catch (error) {
    if (error instanceof StoreError) throw error
    if (error.code === "ENOENT") throw new StoreError("STATE_CORRUPT", "task has no authoritative state.json")
    throw error
  }
}

function assertImmutableIdentity(current, next) {
  const fields = ["taskId", "createdAt"]
  for (const field of fields) {
    if (current[field] !== next[field]) throw new StoreError("IMMUTABLE_STATE_CHANGED", `${field} cannot change`)
  }
  for (const field of ["workflow", "scope"]) {
    if (JSON.stringify(current[field]) !== JSON.stringify(next[field])) {
      throw new StoreError("IMMUTABLE_STATE_CHANGED", `${field} cannot change`)
    }
  }
}

const recordDirectories = { report: "reports", operation: "operations" }

function normalizeJsonValue(value) {
  let invalid = false
  let encoded
  try {
    encoded = JSON.stringify(value, (_key, entry) => {
      if (
        ["undefined", "function", "symbol", "bigint"].includes(typeof entry)
        || (typeof entry === "number" && !Number.isFinite(entry))
      ) invalid = true
      return entry
    })
  } catch (error) {
    throw new StoreError("RECORD_INVALID", "immutable record must be finite, acyclic JSON", [{ message: error.message }])
  }
  if (invalid || encoded === undefined) {
    throw new StoreError("RECORD_INVALID", "immutable record must contain only finite JSON values")
  }
  return JSON.parse(encoded)
}

async function normalizeRecords(taskRoot, records = []) {
  if (!Array.isArray(records)) throw new StoreError("RECORD_INVALID", "records must be an array")
  const normalized = []
  const keys = new Set()
  for (const record of records) {
    const directoryName = recordDirectories[record?.kind]
    if (!directoryName) throw new StoreError("RECORD_INVALID", `unsupported immutable record kind: ${record?.kind}`)
    assertIdentifier(record.recordId, "record.recordId")
    if (record.value === undefined) throw new StoreError("RECORD_INVALID", "immutable record value is required")
    const key = `${record.kind}:${record.recordId}`
    if (keys.has(key)) throw new StoreError("RECORD_INVALID", `duplicate immutable record in transaction: ${key}`)
    keys.add(key)
    const directory = await resolveTaskSubdirectory(taskRoot, directoryName)
    const target = path.join(directory, `${record.recordId}.json`)
    const value = normalizeJsonValue(record.value)
    const content = canonicalJson(value)
    try {
      const existing = canonicalJson(JSON.parse(await readFile(target, "utf8")))
      if (existing !== content) {
        throw new StoreError("IMMUTABLE_RECORD_CONFLICT", `${key} already exists with different content`)
      }
    } catch (error) {
      if (error instanceof StoreError) throw error
      if (error.code !== "ENOENT") throw new StoreError("STATE_CORRUPT", `cannot validate immutable record ${key}`, [{ message: error.message }])
    }
    normalized.push({ kind: record.kind, recordId: record.recordId, value })
  }
  return normalized
}

async function writeRecords(taskRoot, records) {
  for (const record of records) {
    const directory = await resolveTaskSubdirectory(taskRoot, recordDirectories[record.kind])
    const target = path.join(directory, `${record.recordId}.json`)
    try {
      const existing = canonicalJson(JSON.parse(await readFile(target, "utf8")))
      if (existing !== canonicalJson(record.value)) {
        throw new StoreError("IMMUTABLE_RECORD_CONFLICT", `${record.kind}:${record.recordId} changed during commit`)
      }
    } catch (error) {
      if (error instanceof StoreError) throw error
      if (error.code !== "ENOENT") throw error
      await atomicJson(target, record.value)
    }
  }
}

async function assertAcceptedReportsExist(taskRoot, state, records = [], { corrupt = false } = {}) {
  if (state.acceptedReportRefs.length === 0) return
  const reportsRoot = await resolveTaskSubdirectory(taskRoot, "reports")
  const included = new Set(records.filter(({ kind }) => kind === "report").map(({ recordId }) => recordId))
  for (const reportId of state.acceptedReportRefs) {
    assertIdentifier(reportId, "acceptedReportRef")
    if (included.has(reportId)) continue
    try {
      JSON.parse(await readFile(path.join(reportsRoot, `${reportId}.json`), "utf8"))
    } catch (error) {
      const code = corrupt ? "STATE_CORRUPT" : "IMMUTABLE_RECORD_MISSING"
      throw new StoreError(code, `accepted report ${reportId} has no immutable record`, [{ message: error.message }])
    }
  }
}

function normalizeAuditEvents(events = []) {
  if (!Array.isArray(events)) throw new StoreError("AUDIT_EVENT_INVALID", "auditEvents must be an array")
  const ids = new Set()
  return events.map((event) => {
    const eventId = assertIdentifier(event?.eventId, "event.eventId")
    if (ids.has(eventId)) throw new StoreError("AUDIT_EVENT_INVALID", `duplicate audit event: ${eventId}`)
    ids.add(eventId)
    return {
      eventId,
      type: assertNonEmptyString(event.type, "event.type"),
      occurredAt: assertTimestamp(event.occurredAt, "event.occurredAt"),
      refs: [...assertStringList(event.refs ?? [], "event.refs")],
    }
  })
}

async function writeAuditEvents(taskRoot, auditEvents) {
  if (auditEvents.length === 0) return
  const target = path.join(taskRoot, "events.jsonl")
  let existing
  try {
    const source = await readFile(target, "utf8")
    existing = source.split("\n").filter(Boolean).map((line) => JSON.parse(line))
  } catch (error) {
    throw new StoreError("STATE_CORRUPT", "events.jsonl is unreadable", [{ message: error.message }])
  }
  const byId = new Map(existing.map((event) => [event.eventId, canonicalJson(event)]))
  for (const event of auditEvents) {
    const previous = byId.get(event.eventId)
    if (previous && previous !== canonicalJson(event)) {
      throw new StoreError("AUDIT_EVENT_CONFLICT", `audit event ${event.eventId} already exists with different content`)
    }
    if (!previous) {
      existing.push(event)
      byId.set(event.eventId, canonicalJson(event))
    }
  }
  await atomicWrite(target, existing.map((event) => JSON.stringify(event)).join("\n") + "\n")
}

async function commitTransaction(taskRoot, manifest) {
  const transactionRoot = await resolveTaskSubdirectory(taskRoot, ".txn")
  const manifestPath = path.join(transactionRoot, `${manifest.transactionId}.json`)
  await atomicJson(manifestPath, manifest)
  return applyPreparedTransaction(taskRoot, manifest, manifestPath)
}

async function applyPreparedTransaction(taskRoot, manifest, manifestPath) {
  await writeRecords(taskRoot, manifest.records)
  await writeAuditEvents(taskRoot, manifest.auditEvents)
  await atomicJson(path.join(taskRoot, "artifacts.json"), manifest.state.artifacts)
  await atomicJson(path.join(taskRoot, "state.json"), manifest.state)
  await rm(manifestPath)
  return manifest.state
}

function validateManifest(manifest, fileId, taskId) {
  if (!manifest || manifest.schemaVersion !== "2.0" || manifest.transactionId !== fileId || manifest.taskId !== taskId) {
    throw new StoreError("STATE_CORRUPT", "transaction manifest identity is invalid")
  }
  if (!Number.isInteger(manifest.expectedRevision) || manifest.expectedRevision < 0 || !Array.isArray(manifest.records)) {
    throw new StoreError("STATE_CORRUPT", "transaction manifest fields are invalid")
  }
  try {
    assertTaskState(manifest.state)
  } catch (error) {
    throw new StoreError("STATE_CORRUPT", "transaction contains an invalid task snapshot", [{ message: error.message }])
  }
  if (manifest.state.taskId !== taskId || manifest.state.revision !== manifest.expectedRevision + 1) {
    throw new StoreError("STATE_CORRUPT", "transaction revision does not advance its task exactly once")
  }
  manifest.auditEvents = normalizeAuditEvents(manifest.auditEvents ?? [])
}

async function recoverTaskRoot(taskRoot, taskId) {
  const transactionRoot = await resolveTaskSubdirectory(taskRoot, ".txn")
  await recoverTransactions(transactionRoot, async (manifest, manifestPath, fileId) => {
    try {
      validateManifest(manifest, fileId, taskId)
      const current = await readState(taskRoot)
      if (current.revision === manifest.expectedRevision) {
        assertImmutableIdentity(current, manifest.state)
      } else if (current.revision === manifest.state.revision) {
        if (canonicalJson(current) !== canonicalJson(manifest.state)) {
          throw new StoreError("STATE_CORRUPT", "committed state disagrees with its unfinished transaction")
        }
      } else {
        throw new StoreError("STATE_CORRUPT", "unfinished transaction cannot reconcile with current state")
      }
      manifest.records = await normalizeRecords(taskRoot, manifest.records)
      await assertAcceptedReportsExist(taskRoot, manifest.state, manifest.records)
    } catch (error) {
      if (error instanceof StoreError && error.code === "STATE_CORRUPT") throw error
      throw new StoreError("STATE_CORRUPT", "unfinished transaction violates Store invariants", [{
        code: error.code,
        message: error.message,
      }])
    }
    await applyPreparedTransaction(taskRoot, manifest, manifestPath)
  })
}

export function createFileStore({ projectRoot }) {
  async function paths() {
    await assertProjectRuntimeMajor(projectRoot)
    return resolveStorePaths(projectRoot)
  }

  return Object.freeze({
    async createTask(state) {
      assertTaskState(state)
      if (state.revision !== 0) throw new StoreError("REVISION_CONFLICT", "new task state must start at revision 0")
      const resolved = await paths()
      const taskRoot = newTaskRoot(resolved, state.taskId)
      const stagingRoot = path.join(resolved.tasksRoot, `.create-${state.taskId}.txn`)
      const createLock = path.join(resolved.tasksRoot, `.create-${state.taskId}.lock`)
      return withOwnerLock(createLock, async () => {
        try {
          await lstat(taskRoot)
          throw new StoreError("TASK_EXISTS", `task ${state.taskId} already exists`)
        } catch (error) {
          if (error instanceof StoreError) throw error
          if (error.code !== "ENOENT") throw error
        }
        try {
          const metadata = await lstat(stagingRoot)
          if (metadata.isSymbolicLink()) throw new StoreError("PATH_ESCAPE", "task creation staging path cannot be a symlink")
          await rm(stagingRoot, { recursive: true })
        } catch (error) {
          if (error.code !== "ENOENT") throw error
        }
        try {
          await mkdir(stagingRoot)
          for (const directory of taskDirectories) await mkdir(path.join(stagingRoot, directory))
          await atomicJson(path.join(stagingRoot, "state.json"), state)
          await atomicWrite(path.join(stagingRoot, "context.jsonl"), "")
          await atomicJson(path.join(stagingRoot, "artifacts.json"), [])
          await atomicWrite(path.join(stagingRoot, "events.jsonl"), "")
          await rename(stagingRoot, taskRoot)
          await syncDirectory(resolved.tasksRoot)
          return structuredClone(state)
        } catch (error) {
          await rm(stagingRoot, { recursive: true, force: true })
          throw error
        }
      })
    },

    async loadTask(taskId) {
      const taskRoot = await resolveExistingTaskRoot(await paths(), taskId)
      return withOwnerLock(path.join(taskRoot, ".lock"), async () => {
        await recoverTaskRoot(taskRoot, taskId)
        const state = await readState(taskRoot)
        await assertAcceptedReportsExist(taskRoot, state, [], { corrupt: true })
        return structuredClone(state)
      })
    },

    async commit({ taskId, expectedRevision, state, records = [], auditEvents = [] }) {
      assertTaskState(state)
      if (state.taskId !== taskId) throw new StoreError("STATE_ID_MISMATCH", "state taskId does not match commit taskId")
      const taskRoot = await resolveExistingTaskRoot(await paths(), taskId)
      return withOwnerLock(path.join(taskRoot, ".lock"), async () => {
        await recoverTaskRoot(taskRoot, taskId)
        const current = await readState(taskRoot)
        if (current.revision !== expectedRevision || state.revision !== expectedRevision + 1) {
          throw new StoreError("REVISION_CONFLICT", "commit does not advance the current revision exactly once")
        }
        assertImmutableIdentity(current, state)
        const normalizedRecords = await normalizeRecords(taskRoot, records)
        await assertAcceptedReportsExist(taskRoot, state, normalizedRecords)
        const normalizedAuditEvents = normalizeAuditEvents(auditEvents)
        const committed = await commitTransaction(taskRoot, {
          schemaVersion: "2.0",
          transactionId: randomUUID(),
          taskId,
          expectedRevision,
          state: structuredClone(state),
          records: normalizedRecords,
          auditEvents: normalizedAuditEvents,
        })
        return structuredClone(committed)
      })
    },
  })
}
