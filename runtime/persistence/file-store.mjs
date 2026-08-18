import { lstat, mkdir, readFile, rename, rm } from "node:fs/promises"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"

import {
  assertIdentifier,
  assertNonEmptyString,
  assertStringList,
  assertTaskState,
  assertTimestamp,
} from "../domain/invariants.mjs"
import { assertProjectRuntimeMajor } from "../version.mjs"

import {
  newTaskRoot,
  resolveExistingTaskRoot,
  resolveSafeFile,
  resolveStorePaths,
  resolveTaskSubdirectory,
} from "./paths.mjs"
import { recoverTransactions } from "./recovery.mjs"
import { StoreError } from "./store-error.mjs"
import { atomicJson, atomicWrite, canonicalJson, syncDirectory, withOwnerLock } from "./transactions.mjs"

const taskDirectories = ["reports", "observations", "packets", "operations", "artifacts", ".txn"]

function parseState(source, label) {
  try {
    return assertTaskState(JSON.parse(source))
  } catch (error) {
    throw new StoreError("STATE_CORRUPT", `${label} is not a valid task snapshot`, [{ message: error.message }])
  }
}

async function readState(taskRoot) {
  try {
    const statePath = await resolveSafeFile(taskRoot, path.join(taskRoot, "state.json"), "state.json")
    return parseState(await readFile(statePath, "utf8"), "state.json")
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

const recordDirectories = { report: "reports", observation: "observations", operation: "operations" }

function digestJson(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex")
}

function artifactProjection(state) {
  return {
    generatedFrom: {
      taskId: state.taskId,
      revision: state.revision,
      stateDigest: digestJson(state),
    },
    artifacts: structuredClone(state.artifacts),
  }
}

async function writeArtifactProjection(taskRoot, state) {
  const target = path.join(taskRoot, "artifacts.json")
  const safeTarget = await resolveSafeFile(taskRoot, target, "artifacts.json", { allowMissing: true })
  const expected = artifactProjection(state)
  if (safeTarget) {
    try {
      if (canonicalJson(JSON.parse(await readFile(safeTarget, "utf8"))) === canonicalJson(expected)) return
    } catch {
      // Generated projections are rebuilt from state.json instead of becoming a second state source.
    }
  }
  await atomicJson(target, expected)
}

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
    const existingPath = await resolveSafeFile(directory, target, `${key} record`, { allowMissing: true })
    try {
      if (!existingPath) throw Object.assign(new Error("record missing"), { code: "ENOENT" })
      const existing = canonicalJson(JSON.parse(await readFile(existingPath, "utf8")))
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
    const existingPath = await resolveSafeFile(directory, target, `${record.kind}:${record.recordId} record`, { allowMissing: true })
    try {
      if (!existingPath) throw Object.assign(new Error("record missing"), { code: "ENOENT" })
      const existing = canonicalJson(JSON.parse(await readFile(existingPath, "utf8")))
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
  const included = new Map(records.filter(({ kind }) => kind === "report").map((record) => [record.recordId, record.value]))
  for (const { reportId, digest } of state.acceptedReportRefs) {
    assertIdentifier(reportId, "acceptedReportRef")
    let value = included.get(reportId)
    try {
      if (value === undefined) {
        const reportPath = await resolveSafeFile(reportsRoot, path.join(reportsRoot, `${reportId}.json`), `accepted report ${reportId}`)
        value = JSON.parse(await readFile(reportPath, "utf8"))
      }
    } catch (error) {
      if (error instanceof StoreError && error.code === "PATH_ESCAPE") throw error
      const code = corrupt ? "STATE_CORRUPT" : "IMMUTABLE_RECORD_MISSING"
      throw new StoreError(code, `accepted report ${reportId} has no immutable record`, [{ message: error.message }])
    }
    if (digestJson(value) !== digest) {
      const code = corrupt ? "STATE_CORRUPT" : "IMMUTABLE_RECORD_DIGEST_MISMATCH"
      throw new StoreError(code, `accepted report ${reportId} does not match its authoritative digest`)
    }
  }
}

async function assertDurableReferencesExist(taskRoot, state, records = [], { corrupt = false } = {}) {
  const included = new Map(records.map((record) => [`${record.kind}:${record.recordId}`, record.value]))
  const missingCode = corrupt ? "STATE_CORRUPT" : "IMMUTABLE_RECORD_MISSING"
  const mismatchCode = corrupt ? "STATE_CORRUPT" : "IMMUTABLE_RECORD_DIGEST_MISMATCH"

  async function readRecord(kind, recordId) {
    const key = `${kind}:${recordId}`
    if (included.has(key)) return included.get(key)
    const directoryName = recordDirectories[kind]
    const directory = await resolveTaskSubdirectory(taskRoot, directoryName)
    try {
      const recordPath = await resolveSafeFile(directory, path.join(directory, `${recordId}.json`), key)
      return JSON.parse(await readFile(recordPath, "utf8"))
    } catch (error) {
      if (error instanceof StoreError && error.code === "PATH_ESCAPE") throw error
      throw new StoreError(missingCode, `${key} is required by authoritative state`, [{ message: error.message }])
    }
  }

  for (const assignment of state.workGraph.assignments) {
    for (const attempt of assignment.attempts) {
      if (attempt.receiptRef) {
        const operation = await readRecord("operation", attempt.receiptRef)
        if (
          operation.operationId !== attempt.receiptRef
          || operation.intent?.effectDigest !== attempt.effectDigest
          || operation.receipt?.operationId !== attempt.receiptRef
          || operation.receipt?.effectDigest !== attempt.effectDigest
          || (["running", "reported", "verified", "accepted"].includes(attempt.status)
            && (operation.receipt.status !== "confirmed" || operation.receipt.executionRef !== attempt.executionRef))
        ) {
          throw new StoreError(mismatchCode, `operation:${attempt.receiptRef} does not prove its assignment state`)
        }
      }
      if (attempt.reportRef) {
        const report = await readRecord("report", attempt.reportRef)
        if (digestJson(report) !== attempt.reportDigest) {
          throw new StoreError(mismatchCode, `report:${attempt.reportRef} does not match its assignment digest`)
        }
      }
    }
  }

  for (const item of state.observationInbox.items) {
    const kind = item.kind === "member-report" ? "report" : "observation"
    const directory = kind === "report" ? "reports" : "observations"
    const match = new RegExp(`^${directory}/([a-z0-9][a-z0-9._-]*)\\.json$`).exec(item.payloadRef ?? "")
    if (!match) throw new StoreError(mismatchCode, `${item.kind} inbox item has an invalid payload reference`)
    const payload = await readRecord(kind, match[1])
    if (digestJson(payload) !== item.digest) {
      throw new StoreError(mismatchCode, `${kind}:${match[1]} does not match its inbox digest`)
    }
  }
}

function normalizeAuditEvents(events = [], { revision, required = false } = {}) {
  if (!Array.isArray(events)) throw new StoreError("AUDIT_EVENT_INVALID", "auditEvents must be an array")
  if (required && events.length === 0) throw new StoreError("AUDIT_EVENT_REQUIRED", `revision ${revision} requires an audit event`)
  const ids = new Set()
  return events.map((event) => {
    const eventId = assertIdentifier(event?.eventId, "event.eventId")
    if (ids.has(eventId)) throw new StoreError("AUDIT_EVENT_INVALID", `duplicate audit event: ${eventId}`)
    ids.add(eventId)
    if (!Number.isInteger(event.revision) || event.revision !== revision) {
      throw new StoreError("AUDIT_EVENT_INVALID", `audit event ${eventId} must bind revision ${revision}`)
    }
    return {
      eventId,
      type: assertNonEmptyString(event.type, "event.type"),
      occurredAt: assertTimestamp(event.occurredAt, "event.occurredAt"),
      revision: event.revision,
      refs: [...assertStringList(event.refs ?? [], "event.refs")],
    }
  })
}

async function writeAuditEvents(taskRoot, auditEvents) {
  if (auditEvents.length === 0) return
  const target = path.join(taskRoot, "events.jsonl")
  let existing
  try {
    const safeTarget = await resolveSafeFile(taskRoot, target, "events.jsonl")
    const source = await readFile(safeTarget, "utf8")
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
  await writeArtifactProjection(taskRoot, manifest.state)
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
  manifest.auditEvents = normalizeAuditEvents(manifest.auditEvents ?? [], {
    revision: manifest.state.revision,
    required: true,
  })
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
      await assertDurableReferencesExist(taskRoot, manifest.state, manifest.records)
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
          await atomicJson(path.join(stagingRoot, "artifacts.json"), artifactProjection(state))
          await atomicWrite(path.join(stagingRoot, "events.jsonl"), `${JSON.stringify({
            eventId: "task-created",
            type: "task.created",
            occurredAt: state.createdAt,
            revision: 0,
            refs: [state.currentStageRun.stageRunId],
          })}\n`)
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
        await assertDurableReferencesExist(taskRoot, state, [], { corrupt: true })
        await writeArtifactProjection(taskRoot, state)
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
        await assertDurableReferencesExist(taskRoot, state, normalizedRecords)
        const normalizedAuditEvents = normalizeAuditEvents(auditEvents, { revision: state.revision, required: true })
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
