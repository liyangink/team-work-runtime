import { digestValue } from "../domain/digests.mjs"

import { StoreError } from "./store-error.mjs"

function failureCodes(mode) {
  return mode === "load"
    ? { missing: "STATE_CORRUPT", mismatch: "STATE_CORRUPT" }
    : { missing: "IMMUTABLE_RECORD_MISSING", mismatch: "IMMUTABLE_RECORD_DIGEST_MISMATCH" }
}

function canonicalExecutionRefs(executions = []) {
  return [...executions]
    .map(({ executionRef, state }) => ({ executionRef, state }))
    .sort((left, right) => left.executionRef.localeCompare(right.executionRef))
}

/**
 * Validates every immutable record reference retained by an authoritative task
 * snapshot. The Store supplies the lookup boundary: FileStore owns path safety
 * and disk parsing; InMemoryStore owns its map lookup. A missing lookup must
 * return undefined.  Other errors, including PATH_ESCAPE, deliberately escape.
 */
export async function assertDurableReferences({ state, loadRecord, mode = "commit" }) {
  if (!new Set(["commit", "load"]).has(mode)) {
    throw new StoreError("REFERENCE_MODE_INVALID", "durable-reference validation mode must be commit or load")
  }
  if (typeof loadRecord !== "function") {
    throw new StoreError("REFERENCE_LOOKUP_INVALID", "durable-reference validation requires a record lookup")
  }
  const codes = failureCodes(mode)

  async function requiredRecord(kind, recordId) {
    const value = await loadRecord(kind, recordId)
    if (value === undefined) {
      throw new StoreError(codes.missing, `${kind}:${recordId} is required by authoritative state`)
    }
    return value
  }

  function mismatch(message) {
    throw new StoreError(codes.mismatch, message)
  }

  async function validateDecisionPacket(packetRef, packetDigest) {
    const prefix = `.team-work/tasks/${state.taskId}/packets/`
    if (!packetRef.startsWith(prefix) || !packetRef.endsWith(".json")) mismatch("decision packet reference is outside the current task")
    const recordId = packetRef.slice(prefix.length, -".json".length)
    if (recordId === "" || recordId.includes("/")) mismatch("decision packet reference is invalid")
    const packet = await requiredRecord("packet", recordId)
    if (packet.packetId !== recordId || digestValue(packet) !== packetDigest) {
      mismatch(`packet:${recordId} does not match its decision projection`)
    }
  }

  for (const { reportId, digest } of state.acceptedReportRefs) {
    const report = await requiredRecord("report", reportId)
    if (digestValue(report) !== digest) {
      mismatch(`report:${reportId} does not match its accepted digest`)
    }
  }

  for (const assignment of state.workGraph.assignments) {
    for (const attempt of assignment.attempts) {
      if (attempt.receiptRef) {
        const operation = await requiredRecord("operation", attempt.receiptRef)
        if (
          operation.operationId !== attempt.receiptRef
          || operation.intent?.effectDigest !== attempt.effectDigest
          || operation.receipt?.operationId !== attempt.receiptRef
          || operation.receipt?.effectDigest !== attempt.effectDigest
          || (["running", "reported", "verified", "accepted"].includes(attempt.status)
            && (operation.receipt.status !== "confirmed" || operation.receipt.executionRef !== attempt.executionRef))
        ) {
          mismatch(`operation:${attempt.receiptRef} does not prove its assignment state`)
        }
      }
      if (attempt.reportRef) {
        const report = await requiredRecord("report", attempt.reportRef)
        if (digestValue(report) !== attempt.reportDigest) {
          mismatch(`report:${attempt.reportRef} does not match its assignment digest`)
        }
      }
    }
  }

  for (const capability of state.specLifecycle?.capabilities ?? []) {
    const operation = await requiredRecord("operation", capability.receiptRef)
    if (
      operation.operationId !== capability.operationId
      || operation.kind !== "spec.prepare"
      || operation.intent?.effectDigest !== capability.effectDigest
      || operation.receipt?.operationId !== capability.operationId
      || operation.receipt?.effectDigest !== capability.effectDigest
      || operation.receipt?.capabilityId !== capability.capabilityId
      || operation.receipt?.capabilityDigest !== capability.capabilityDigest
      || operation.receipt?.status !== "ready"
    ) mismatch(`operation:${capability.receiptRef} does not prove its SPEC capability`)
  }
  if (state.specLifecycle?.archive) {
    const archive = state.specLifecycle.archive
    const operation = await requiredRecord("operation", archive.receiptRef)
    if (
      operation.operationId !== archive.operationId
      || operation.kind !== "spec.archive"
      || operation.intent?.effectDigest !== archive.effectDigest
      || operation.receipt?.operationId !== archive.operationId
      || operation.receipt?.effectDigest !== archive.effectDigest
      || operation.receipt?.status !== "confirmed"
      || digestValue(operation.receipt?.archiveRefs) !== digestValue(archive.archiveRefs)
    ) mismatch(`operation:${archive.receiptRef} does not prove SPEC archival`)
  }

  for (const item of state.observationInbox.items) {
    const kind = item.kind === "member-report" ? "report" : "observation"
    const directory = kind === "report" ? "reports" : "observations"
    const match = new RegExp(`^${directory}/([a-z0-9][a-z0-9._-]*)\\.json$`).exec(item.payloadRef ?? "")
    if (!match) mismatch(`${item.kind} inbox item has an invalid payload reference`)
    const payload = await requiredRecord(kind, match[1])
    if (digestValue(payload) !== item.digest) {
      mismatch(`${kind}:${match[1]} does not match its inbox digest`)
    }
  }

  if (state.pendingDecision?.quiesceReceiptRef || state.pendingDecision?.quiesceFailureRef) {
    const recordId = state.pendingDecision.quiesceReceiptRef ?? state.pendingDecision.quiesceFailureRef
    const operation = await requiredRecord("operation", recordId)
    const expectedStatus = state.pendingDecision.quiesceReceiptRef ? "confirmed" : "blocked"
    const receiptExecutions = canonicalExecutionRefs(operation.receipt?.executions)
    if (
      operation.operationId !== recordId
      || operation.kind !== "execution.quiesce"
      || operation.intent?.decisionId !== state.pendingDecision.decisionId
      || operation.intent?.leadBindingRef !== state.pendingDecision.leadBindingRef
      || digestValue(operation.intent?.executionRefs) !== digestValue(state.pendingDecision.executionRefs)
      || operation.receipt?.status !== expectedStatus
      || operation.receipt?.operationId !== recordId
      || operation.receipt?.effectDigest !== operation.intent?.effectDigest
      || (expectedStatus === "confirmed" && operation.receipt?.hostContinuationsCleared !== true)
      || (expectedStatus === "confirmed" && digestValue(receiptExecutions.map(({ executionRef }) => executionRef)) !== digestValue(state.pendingDecision.executionRefs))
      || (expectedStatus === "confirmed" && receiptExecutions.some(({ state: executionState }) => !["idle", "stopped", "isolated"].includes(executionState)))
    ) {
      mismatch(`operation:${recordId} does not prove its human-wait state`)
    }
  }
  if (state.pendingDecision?.packetRef) {
    await validateDecisionPacket(state.pendingDecision.packetRef, state.pendingDecision.packetDigest)
  }
  if (state.stagePlan?.intervention) {
    await validateDecisionPacket(
      state.stagePlan.intervention.sourcePacketRef,
      state.stagePlan.intervention.sourcePacketDigest,
    )
  }

  for (const decision of state.decisionHistory) {
    const record = await requiredRecord("operation", decision.decisionRef)
    if (
      digestValue(record) !== decision.decisionDigest
      || record.operationId !== decision.decisionRef
      || record.kind !== "human-decision"
      || record.stageRunId !== decision.stageRunId
      || record.evidenceDigest !== decision.evidenceDigest
      || record.decision?.decisionId !== decision.decisionId
      || record.decision?.choice !== decision.choice
      || record.decision?.proof?.mode !== decision.proofMode
    ) {
      mismatch(`operation:${decision.decisionRef} does not prove its human decision`)
    }
    const quiesce = await requiredRecord("operation", decision.quiesceReceiptRef)
    const receiptExecutions = canonicalExecutionRefs(quiesce.receipt?.executions)
    if (
      quiesce.operationId !== decision.quiesceReceiptRef
      || quiesce.kind !== "execution.quiesce"
      || quiesce.intent?.decisionId !== decision.decisionId
      || quiesce.intent?.leadBindingRef !== decision.leadBindingRef
      || digestValue(quiesce.intent?.executionRefs) !== digestValue(decision.executionRefs)
      || quiesce.receipt?.status !== "confirmed"
      || quiesce.receipt?.operationId !== decision.quiesceReceiptRef
      || quiesce.receipt?.effectDigest !== quiesce.intent?.effectDigest
      || quiesce.receipt?.hostContinuationsCleared !== true
      || digestValue(receiptExecutions.map(({ executionRef }) => executionRef)) !== digestValue(decision.executionRefs)
      || receiptExecutions.some(({ state: executionState }) => !["idle", "stopped", "isolated"].includes(executionState))
    ) {
      mismatch(`operation:${decision.quiesceReceiptRef} does not prove decision quiescence`)
    }
    if (decision.packetRef) await validateDecisionPacket(decision.packetRef, decision.packetDigest)
  }
}
