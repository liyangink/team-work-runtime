import { randomUUID } from "node:crypto"

import { createExecutionAdapterPort } from "../ports/execution.mjs"
import { digestEffect, digestValue } from "../domain/digests.mjs"

function completedOperation(operation, receipt) {
  return {
    kind: "operation",
    recordId: operation.operationId,
    value: {
      operationId: operation.operationId,
      kind: operation.kind,
      intent: operation.intent,
      receipt,
      invocationCount: operation.invocationCount,
    },
  }
}

export function evaluateHumanGate({ requirement, humanDecisionProof }) {
  if (!["required", "optional", "disabled"].includes(requirement)) {
    throw new TypeError("human gate requirement must be required, optional, or disabled")
  }
  if (!["verified-event", "trusted-caller", "unsupported"].includes(humanDecisionProof)) {
    throw new TypeError("human decision proof capability is invalid")
  }
  if (requirement === "disabled") return { action: "skip", reason: "disabled" }
  if (humanDecisionProof === "unsupported") {
    if (requirement === "optional") return { action: "skip", reason: "proof-unsupported" }
    const error = new Error("required human decision cannot be verified by this platform")
    error.code = "HUMAN_DECISION_PROOF_UNSUPPORTED"
    throw error
  }
  return { action: "wait", proofMode: humanDecisionProof }
}

export function compileHumanGateRequirements({ gates, capabilitySnapshot }) {
  if (!Array.isArray(gates) || gates.length === 0) throw new TypeError("human gate declarations are required")
  const gateIds = new Set()
  return gates.map((gate) => {
    if (typeof gate?.gateId !== "string" || gate.gateId === "" || gateIds.has(gate.gateId)) {
      throw new TypeError("human gate ids must be unique non-empty strings")
    }
    gateIds.add(gate.gateId)
    const compiled = evaluateHumanGate({
      requirement: gate.requirement,
      humanDecisionProof: capabilitySnapshot?.features?.humanDecisionProof,
    })
    const metadata = {}
    if (typeof gate.stage === "string" && gate.stage !== "") metadata.stage = gate.stage
    if (typeof gate.artifactKind === "string" && gate.artifactKind !== "") metadata.artifactKind = gate.artifactKind
    return Object.freeze({ gateId: gate.gateId, ...metadata, requirement: gate.requirement, ...compiled })
  })
}

export function createHumanWait({
  reconciler,
  executionAdapter,
  evidenceVerifier,
  clock,
  effectLeaseMs = 120_000,
  faultInjector = {},
}) {
  const execution = createExecutionAdapterPort(executionAdapter)

  async function evidenceIsCurrent(evidence) {
    if (!evidenceVerifier || typeof evidenceVerifier.verify !== "function") {
      const error = new Error("human decisions require an EvidenceVerifier")
      error.code = "EVIDENCE_VERIFIER_REQUIRED"
      throw error
    }
    return (await evidenceVerifier.verify(evidence)).valid
  }

  function compareExistingRequest(existing, decision) {
    const existingRequest = {
      requirement: existing.requirement,
      leadBindingRef: existing.leadBindingRef,
      question: existing.question,
      choices: existing.choices,
      artifactRefs: existing.evidence.map(({ artifactId }) => artifactId),
    }
    const repeatedRequest = {
      requirement: decision.requirement,
      leadBindingRef: decision.leadBindingRef,
      question: decision.question,
      choices: decision.choices,
      artifactRefs: decision.artifactRefs,
    }
    if (digestValue(existingRequest) !== digestValue(repeatedRequest)) {
      const error = new Error(`human decision ${decision.decisionId} was repeated with different content`)
      error.code = "HUMAN_DECISION_CONFLICT"
      throw error
    }
  }

  async function prepare(taskId, decision) {
    const beforeCapabilityCheck = await reconciler.load(taskId)
    if (beforeCapabilityCheck.pendingDecision?.decisionId === decision.decisionId) {
      compareExistingRequest(beforeCapabilityCheck.pendingDecision, decision)
      if (!beforeCapabilityCheck.pendingDecision.quiesceFailureRef) {
        return { changed: false, state: beforeCapabilityCheck }
      }
    }
    const capabilities = await execution.capabilities()
    const [gate] = compileHumanGateRequirements({
      gates: [{ gateId: decision.decisionId, requirement: decision.requirement }],
      capabilitySnapshot: capabilities,
    })
    if (gate.action === "skip") return { changed: false, state: await reconciler.load(taskId), skipped: true, reason: gate.reason }
    const proofMode = gate.proofMode
    return reconciler.commit(taskId, async (state) => {
      const createIntent = (attempt) => {
        const executionRefs = [...new Set(state.workGraph.assignments.flatMap((assignment) => {
          const executionRef = assignment.attempts.at(-1)?.executionRef
          return executionRef ? [executionRef] : []
        }))].sort()
        const evidence = decision.artifactRefs.map((artifactId) => {
          const artifact = state.artifacts.find((entry) => entry.artifactId === artifactId)
          return artifact ? { artifactId, path: artifact.path, digest: artifact.digest } : { artifactId }
        })
        const seed = digestValue({
          taskId,
          stageRunId: state.currentStageRun.stageRunId,
          decisionId: decision.decisionId,
          leadBindingRef: decision.leadBindingRef,
          executionRefs,
          evidence,
          attempt,
        }).slice(0, 24)
        const intent = {
          operationId: `quiesce-${seed}`,
          effectDigest: "0".repeat(64),
          taskId,
          decisionId: decision.decisionId,
          leadBindingRef: decision.leadBindingRef,
          executionRefs,
          clearHostContinuations: true,
        }
        intent.effectDigest = digestEffect(intent)
        return intent
      }
      const existing = state.pendingDecision
      if (existing?.decisionId === decision.decisionId) {
        compareExistingRequest(existing, decision)
        if (existing.quiesceFailureRef && state.status === "blocked") {
          if (proofMode !== existing.proofMode) {
            const error = new Error("human decision proof capability changed while recovering a blocked wait")
            error.code = "HUMAN_DECISION_CAPABILITY_CHANGED"
            throw error
          }
          const intent = createIntent(existing.quiesceAttempt + 1)
          return {
            fact: { type: "human-wait.quiesce-retried", intent, occurredAt: clock() },
            refs: [existing.decisionId, existing.quiesceFailureRef, intent.operationId],
          }
        }
        return null
      }
      const evidence = decision.artifactRefs.map((artifactId) => {
        const artifact = state.artifacts.find((entry) => entry.artifactId === artifactId)
        return artifact && { artifactId, path: artifact.path, digest: artifact.digest }
      })
      if (evidence.some((entry) => !entry) || !await evidenceIsCurrent(evidence)) {
        const error = new Error("human decision artifacts do not match their registered evidence")
        error.code = "ARTIFACT_EVIDENCE_STALE"
        throw error
      }
      const intent = createIntent(1)
      return {
        fact: {
          type: "human-wait.prepared",
          decision: {
            ...structuredClone(decision),
            proofMode,
            capabilitySnapshotDigest: capabilities.digest,
          },
          intent,
          occurredAt: clock(),
        },
        refs: [decision.decisionId, intent.operationId],
      }
    })
  }

  async function reconcile(taskId, operationId) {
    let state = await reconciler.load(taskId)
    let operation = state.pendingOperations.find((entry) => entry.operationId === operationId)
    if (!operation) return { changed: false, state }
    let fresh = operation.status === "intent-persisted"
    if (fresh) {
      const invocationStartedAt = clock()
      const started = await reconciler.commit(taskId, (current) => {
        const candidate = current.pendingOperations.find((entry) => entry.operationId === operationId)
        if (!candidate || candidate.status !== "intent-persisted") return null
        return {
          fact: {
            type: "effect.invocation-started",
            operationId,
            invocationId: randomUUID(),
            leaseExpiresAt: new Date(Date.parse(invocationStartedAt) + effectLeaseMs).toISOString(),
            occurredAt: invocationStartedAt,
          },
          refs: [operationId, current.pendingDecision?.decisionId].filter(Boolean),
        }
      })
      state = started.state
      operation = state.pendingOperations.find((entry) => entry.operationId === operationId)
      if (!operation) return { changed: started.changed, state }
      fresh = started.changed
    }
    if (!fresh && Date.parse(operation.leaseExpiresAt) > Date.parse(clock())) {
      return { changed: false, state, inDoubt: true }
    }
    const receipt = fresh
      ? await execution.quiesce(operation.intent)
      : await execution.inspectQuiesce(operation.intent)
    await faultInjector.afterReceipt?.({ taskId, operation: structuredClone(operation), receipt: structuredClone(receipt) })
    if (receipt.status === "in-doubt") return { changed: false, state, inDoubt: true }
    const committed = await reconciler.commit(taskId, (current) => {
      const candidate = current.pendingOperations.find((entry) => entry.operationId === operationId)
      if (!candidate) return null
      return {
        fact: {
          type: receipt.status === "confirmed" ? "human-wait.quiesce-confirmed" : "human-wait.quiesce-blocked",
          operationId,
          receipt,
          occurredAt: receipt.observedAt,
        },
        records: [completedOperation(candidate, receipt)],
        refs: [operationId, current.pendingDecision?.decisionId].filter(Boolean),
      }
    })
    return { changed: committed.changed, state: committed.state, inDoubt: false }
  }

  function activate(taskId) {
    return reconciler.commit(taskId, async (state) => {
      if (state.pendingDecision?.phase !== "preparing" || !state.pendingDecision.quiesceReceiptRef) return null
      const currentEvidence = state.pendingDecision.evidence.map(({ artifactId }) => {
        const artifact = state.artifacts.find((entry) => entry.artifactId === artifactId)
        return artifact && { artifactId, path: artifact.path, digest: artifact.digest }
      })
      const stale = state.pendingDecision.observationsAfterPrepare > 0 || currentEvidence.some((entry) => !entry) || digestValue({
        stageRunId: state.currentStageRun.stageRunId,
        evidence: currentEvidence,
      }) !== state.pendingDecision.evidenceDigest || !await evidenceIsCurrent(currentEvidence)
      return {
        fact: {
          type: stale ? "human-wait.invalidated" : "human-wait.activated",
          ...(stale ? { reason: "evidence-or-observation-changed" } : {}),
          occurredAt: clock(),
        },
        refs: [state.pendingDecision.decisionId, state.pendingDecision.quiesceReceiptRef],
      }
    })
  }

  async function resolve(taskId) {
    const state = await reconciler.load(taskId)
    const pending = state.pendingDecision
    if (state.status !== "awaiting-user" || pending?.phase !== "awaiting-user") {
      const error = new Error("task is not awaiting a human decision")
      error.code = "HUMAN_DECISION_NOT_AWAITED"
      throw error
    }
    if (state.observationInbox.items.length > 0) {
      const reopened = await reconciler.commit(taskId, (current) => {
        if (current.status !== "awaiting-user" || current.observationInbox.items.length === 0) return null
        return {
          fact: {
            type: "human-wait.reopened",
            reason: "late-observations",
            occurredAt: clock(),
          },
          refs: [pending.decisionId, ...current.observationInbox.items.map(({ observationId }) => observationId)],
        }
      })
      return { state: reopened.state, accepted: false, reason: "late-observations" }
    }
    if (!await evidenceIsCurrent(pending.evidence)) {
      const reopened = await reconciler.commit(taskId, (current) => {
        if (current.status !== "awaiting-user" || current.pendingDecision?.decisionId !== pending.decisionId) return null
        return {
          fact: {
            type: "human-wait.reopened",
            reason: "evidence-changed",
            occurredAt: clock(),
          },
          refs: [pending.decisionId, ...pending.evidence.map(({ artifactId }) => artifactId)],
        }
      })
      return { state: reopened.state, accepted: false, reason: "evidence-changed" }
    }
    const decision = await execution.verifyHumanDecision({
      decisionId: pending.decisionId,
      leadBindingRef: pending.leadBindingRef,
      issuedAt: pending.issuedAt,
      ...(pending.afterHostCursor ? { afterHostCursor: pending.afterHostCursor } : {}),
      choices: pending.choices,
    })
    const decisionRef = `decision-${digestValue({
      taskId,
      decisionId: pending.decisionId,
      stageRunId: pending.stageRunId,
      evidenceDigest: pending.evidenceDigest,
      quiesceReceiptRef: pending.quiesceReceiptRef,
      issuedAt: pending.issuedAt,
    }).slice(0, 24)}`
    const value = {
      operationId: decisionRef,
      kind: "human-decision",
      stageRunId: pending.stageRunId,
      evidenceDigest: pending.evidenceDigest,
      decision: structuredClone(decision),
    }
    const decisionDigest = digestValue(value)
    const committed = await reconciler.commit(taskId, async (current) => {
      if (
        current.status !== "awaiting-user"
        || current.pendingDecision?.decisionId !== pending.decisionId
      ) return null
      if (current.observationInbox.items.length > 0) {
        return {
          fact: {
            type: "human-wait.reopened",
            reason: "late-observations",
            occurredAt: clock(),
          },
          refs: [pending.decisionId, ...current.observationInbox.items.map(({ observationId }) => observationId)],
        }
      }
      if (!await evidenceIsCurrent(current.pendingDecision.evidence)) {
        return {
          fact: {
            type: "human-wait.reopened",
            reason: "evidence-changed",
            occurredAt: clock(),
          },
          refs: [pending.decisionId, ...current.pendingDecision.evidence.map(({ artifactId }) => artifactId)],
        }
      }
      return {
        fact: {
          type: "human-decision.resolved",
          decision,
          decisionRef,
          decisionDigest,
          occurredAt: decision.receivedAt,
        },
        records: [{ kind: "operation", recordId: decisionRef, value }],
        refs: [pending.decisionId, decisionRef, pending.stageRunId],
      }
    })
    const accepted = committed.state.decisionHistory.some((entry) => entry.decisionRef === decisionRef)
    return accepted
      ? { state: committed.state, decision, accepted: true }
      : { state: committed.state, accepted: false, reason: committed.state.observationInbox.items.length > 0 ? "late-observations" : "evidence-changed" }
  }

  return Object.freeze({ prepare, reconcile, activate, resolve })
}
