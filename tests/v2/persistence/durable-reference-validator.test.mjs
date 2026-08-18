import assert from "node:assert/strict"
import test from "node:test"

import { digestValue } from "../../../runtime/domain/digests.mjs"
import { assertDurableReferences } from "../../../runtime/persistence/durable-reference-validator.mjs"

const digest = (value) => digestValue(value)
const effectDigest = "a".repeat(64)

function quiesceOperation({ operationId, decisionId, leadBindingRef, executionRefs, state = "idle" }) {
  return {
    operationId,
    kind: "execution.quiesce",
    intent: { decisionId, leadBindingRef, executionRefs, effectDigest },
    receipt: {
      status: "confirmed",
      operationId,
      effectDigest,
      hostContinuationsCleared: true,
      executions: executionRefs.map((executionRef) => ({ executionRef, state })),
    },
  }
}

function fixture() {
  const attemptReport = { reportId: "report-attempt", outcome: "completed" }
  const inboxReport = { reportId: "report-inbox", outcome: "completed" }
  const observation = { observationId: "observation-1", state: "idle" }
  const decisionRecord = {
    operationId: "decision-1",
    kind: "human-decision",
    stageRunId: "stage-run-1",
    evidenceDigest: "b".repeat(64),
    decision: { decisionId: "decision-resolved", choice: "approve", proof: { mode: "trusted-caller" } },
  }
  const records = new Map([
    ["report:report-accepted", { reportId: "report-accepted", outcome: "accepted" }],
    ["operation:dispatch-1", {
      operationId: "dispatch-1",
      intent: { effectDigest },
      receipt: { operationId: "dispatch-1", effectDigest, status: "confirmed", executionRef: "member-1" },
    }],
    ["report:report-attempt", attemptReport],
    ["report:report-inbox", inboxReport],
    ["observation:observation-1", observation],
    ["operation:quiesce-pending", quiesceOperation({
      operationId: "quiesce-pending",
      decisionId: "decision-pending",
      leadBindingRef: "lead-binding-1",
      executionRefs: ["member-1"],
    })],
    ["operation:decision-1", decisionRecord],
    ["operation:quiesce-decision", quiesceOperation({
      operationId: "quiesce-decision",
      decisionId: "decision-resolved",
      leadBindingRef: "lead-binding-1",
      executionRefs: ["member-1"],
    })],
  ])
  const accepted = records.get("report:report-accepted")
  return {
    records,
    state: {
      acceptedReportRefs: [{ reportId: "report-accepted", digest: digest(accepted) }],
      workGraph: {
        assignments: [{
          attempts: [{
            status: "reported",
            receiptRef: "dispatch-1",
            effectDigest,
            executionRef: "member-1",
            reportRef: "report-attempt",
            reportDigest: digest(attemptReport),
          }],
        }],
      },
      observationInbox: {
        items: [
          { kind: "member-report", payloadRef: "reports/report-inbox.json", digest: digest(inboxReport) },
          { kind: "execution-idle", payloadRef: "observations/observation-1.json", digest: digest(observation) },
        ],
      },
      pendingDecision: {
        decisionId: "decision-pending",
        leadBindingRef: "lead-binding-1",
        executionRefs: ["member-1"],
        quiesceReceiptRef: "quiesce-pending",
      },
      decisionHistory: [{
        decisionId: "decision-resolved",
        stageRunId: "stage-run-1",
        choice: "approve",
        proofMode: "trusted-caller",
        leadBindingRef: "lead-binding-1",
        executionRefs: ["member-1"],
        evidenceDigest: "b".repeat(64),
        decisionRef: "decision-1",
        decisionDigest: digest(decisionRecord),
        quiesceReceiptRef: "quiesce-decision",
      }],
    },
  }
}

async function validate({ state, records }, mode = "commit") {
  return assertDurableReferences({
    state,
    mode,
    loadRecord: async (kind, recordId) => records.get(`${kind}:${recordId}`),
  })
}

test("the shared validator accepts a complete durable reference graph", async () => {
  await validate(fixture())
})

test("the shared validator rejects every authoritative missing reference with mode-specific fail-closed codes", async () => {
  const refs = [
    "report:report-accepted",
    "operation:dispatch-1",
    "report:report-attempt",
    "report:report-inbox",
    "observation:observation-1",
    "operation:quiesce-pending",
    "operation:decision-1",
    "operation:quiesce-decision",
  ]

  for (const mode of ["commit", "load"]) {
    for (const ref of refs) {
      const input = fixture()
      input.records.delete(ref)
      await assert.rejects(
        validate(input, mode),
        (error) => error.code === (mode === "load" ? "STATE_CORRUPT" : "IMMUTABLE_RECORD_MISSING"),
        `${mode} must fail closed for ${ref}`,
      )
    }
  }
})

test("the shared validator rejects digest mismatches and invalid human-wait receipts", async () => {
  const reportDigestMismatch = fixture()
  reportDigestMismatch.records.set("report:report-attempt", { reportId: "report-attempt", outcome: "changed" })
  await assert.rejects(
    validate(reportDigestMismatch),
    (error) => error.code === "IMMUTABLE_RECORD_DIGEST_MISMATCH",
  )

  const inboxDigestMismatch = fixture()
  inboxDigestMismatch.records.set("observation:observation-1", { observationId: "observation-1", state: "lost" })
  await assert.rejects(
    validate(inboxDigestMismatch),
    (error) => error.code === "IMMUTABLE_RECORD_DIGEST_MISMATCH",
  )

  const brokenWait = fixture()
  brokenWait.records.get("operation:quiesce-pending").receipt.hostContinuationsCleared = false
  await assert.rejects(
    validate(brokenWait, "load"),
    (error) => error.code === "STATE_CORRUPT",
  )
})
