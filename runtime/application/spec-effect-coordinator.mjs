import { randomUUID } from "node:crypto"

import { createSpecProviderAdapterPort } from "../ports/spec-provider.mjs"

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

function isMissingRecord(error) {
  return error?.code === "RECORD_NOT_FOUND"
}

export function createSpecEffectCoordinator({
  reconciler,
  store,
  specProviderAdapter,
  clock,
  maxEffectAttempts = 2,
  effectLeaseMs = 120_000,
  faultInjector = {},
}) {
  if (!store || typeof store.loadRecord !== "function") throw new TypeError("SpecEffectCoordinator requires a Store")
  const provider = createSpecProviderAdapterPort(specProviderAdapter)

  async function completed(taskId, operationId) {
    try {
      return await store.loadRecord(taskId, "operation", operationId)
    } catch (error) {
      if (isMissingRecord(error)) return null
      throw error
    }
  }

  async function request(taskId, kind, intent) {
    const existing = await completed(taskId, intent.operationId)
    if (existing) {
      if (existing.kind !== kind || existing.intent?.effectDigest !== intent.effectDigest) {
        const error = new Error(`SPEC operation ${intent.operationId} conflicts with its immutable receipt`)
        error.code = "OPERATION_DIGEST_CONFLICT"
        throw error
      }
      return { changed: false, state: await reconciler.load(taskId), receipt: existing.receipt }
    }
    const committed = await reconciler.commit(taskId, (state) => {
      const pending = state.pendingOperations.find(({ operationId }) => operationId === intent.operationId)
      if (pending) {
        if (pending.kind !== kind || pending.effectDigest !== intent.effectDigest) {
          const error = new Error(`SPEC operation ${intent.operationId} conflicts with its durable intent`)
          error.code = "OPERATION_DIGEST_CONFLICT"
          throw error
        }
        return null
      }
      return {
        fact: {
          type: kind === "spec.prepare" ? "spec.prepare-requested" : "spec.archive-requested",
          intent,
          occurredAt: clock(),
        },
        refs: [intent.operationId, intent.task.stageRunId],
      }
    })
    return { changed: committed.changed, state: committed.state }
  }

  async function commitConfirmed(taskId, operationId, receipt) {
    return reconciler.commit(taskId, (state) => {
      const operation = state.pendingOperations.find((entry) => entry.operationId === operationId)
      if (!operation) return null
      return {
        fact: operation.kind === "spec.prepare"
          ? { type: "spec.prepare-confirmed", operationId, capability: receipt, occurredAt: clock() }
          : { type: "spec.archive-confirmed", operationId, receipt, occurredAt: receipt.observedAt },
        records: [completedOperation(operation, receipt)],
        refs: [operationId, receipt.capabilityId].filter(Boolean),
      }
    })
  }

  async function commitBlocked(taskId, operationId, receipt, blocker) {
    return reconciler.commit(taskId, (state) => {
      const operation = state.pendingOperations.find((entry) => entry.operationId === operationId)
      if (!operation) return null
      const normalized = receipt ?? {
        operationId,
        effectDigest: operation.effectDigest,
        status: "failed",
        blocker: blocker ?? "SPEC provider operation failed",
        observedAt: clock(),
      }
      return {
        fact: { type: "spec.effect-blocked", operationId, blocker: normalized.blocker ?? blocker ?? normalized.status, occurredAt: normalized.observedAt ?? clock() },
        records: [completedOperation(operation, normalized)],
        refs: [operationId],
      }
    })
  }

  const coordinator = {
    requestPrepare: (taskId, intent) => request(taskId, "spec.prepare", intent),
    requestArchive: (taskId, intent) => request(taskId, "spec.archive", intent),

    async reconcile(taskId, operationId) {
      let state = await reconciler.load(taskId)
      let operation = state.pendingOperations.find((entry) => entry.operationId === operationId)
      if (!operation) return { changed: false, state, receipt: (await completed(taskId, operationId))?.receipt }
      if (!["spec.prepare", "spec.archive"].includes(operation.kind)) {
        throw new TypeError(`operation ${operationId} is not a SPEC effect`)
      }

      let fresh = operation.status === "intent-persisted"
      if (fresh) {
        await faultInjector.beforeInvocationClaim?.({ taskId, operation: structuredClone(operation) })
        const startedAt = clock()
        const started = await reconciler.commit(taskId, (current) => {
          const candidate = current.pendingOperations.find((entry) => entry.operationId === operationId)
          if (!candidate || candidate.status !== "intent-persisted") return null
          return {
            fact: {
              type: "effect.invocation-started",
              operationId,
              invocationId: randomUUID(),
              leaseExpiresAt: new Date(Date.parse(startedAt) + effectLeaseMs).toISOString(),
              occurredAt: startedAt,
            },
            refs: [operationId],
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

      let result
      if (fresh) {
        result = operation.kind === "spec.prepare"
          ? await provider.prepare(operation.intent)
          : await provider.archive(operation.intent)
      } else {
        result = await provider.inspect({
          ...operation.intent,
          kind: operation.kind === "spec.prepare" ? "prepare" : "archive",
        })
      }
      await faultInjector.afterReceipt?.({ taskId, operation: structuredClone(operation), receipt: structuredClone(result) })

      if (!fresh) {
        if (result.status === "confirmed") result = result.result
        else if (result.status === "missing" && operation.invocationCount < maxEffectAttempts) {
          const retried = await reconciler.commit(taskId, (current) => current.pendingOperations.some((entry) => entry.operationId === operationId)
            ? { fact: { type: "spec.effect-retry-scheduled", operationId, blocker: "provider inspection found no external effect", occurredAt: result.observedAt }, refs: [operationId] }
            : null)
          return { changed: retried.changed, state: retried.state }
        } else if (result.status === "in-doubt") {
          return { changed: false, state, inDoubt: true, blocker: result.blocker }
        } else {
          const blocked = await commitBlocked(taskId, operationId, result, result.blocker)
          return { changed: blocked.changed, state: blocked.state, blocked: true }
        }
      }

      const confirmed = operation.kind === "spec.prepare" ? result.status === "ready" : result.status === "confirmed"
      if (confirmed) {
        const committed = await commitConfirmed(taskId, operationId, result)
        return { changed: committed.changed, state: committed.state, receipt: result }
      }
      if (result.status === "in-doubt") return { changed: false, state, inDoubt: true }
      const blocked = await commitBlocked(taskId, operationId, result, result.blocker)
      return { changed: blocked.changed, state: blocked.state, blocked: true }
    },

    async recordStatus(taskId) {
      const state = await reconciler.load(taskId)
      if (!state.specLifecycle.task) throw Object.assign(new Error("SPEC provider task has not been prepared"), { code: "SPEC_TASK_MISSING" })
      const status = await provider.status(state.specLifecycle.task)
      return reconciler.commit(taskId, (current) => (
        current.specLifecycle.task && current.specLifecycle.archive === null
          ? { fact: { type: "spec.status-recorded", status, occurredAt: clock() }, refs: [status.providerRevision] }
          : null
      ))
    },

    async recordValidation(taskId) {
      const state = await reconciler.load(taskId)
      if (!state.specLifecycle.task || !state.specLifecycle.status) {
        throw Object.assign(new Error("SPEC provider status must be recorded before validation"), { code: "SPEC_STATUS_MISSING" })
      }
      const validation = await provider.validate(state.specLifecycle.task)
      return reconciler.commit(taskId, (current) => (
        current.specLifecycle.status?.providerRevision === validation.providerRevision
          ? { fact: { type: "spec.validation-recorded", validation, occurredAt: clock() }, refs: [validation.providerRevision, ...validation.evidenceRefs] }
          : null
      ))
    },
  }

  return Object.freeze(coordinator)
}
