import { createExecutionAdapterPort } from "../ports/execution.mjs"
import { randomUUID } from "node:crypto"

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

export function createEffectCoordinator({
  reconciler,
  executionAdapter,
  clock,
  maxEffectAttempts = 2,
  effectLeaseMs = 120_000,
  faultInjector = {},
}) {
  const execution = createExecutionAdapterPort(executionAdapter)

  async function commitReceipt(taskId, operationId, receipt) {
    return reconciler.commit(taskId, (state) => {
      const operation = state.pendingOperations.find((entry) => entry.operationId === operationId)
      if (!operation) return null
      if (receipt.status === "confirmed") {
        return {
          fact: {
            type: operation.kind === "execution.stop" ? "effect.stop-confirmed" : "effect.confirmed",
            operationId,
            receipt,
            occurredAt: receipt.observedAt,
          },
          records: [completedOperation(operation, receipt)],
          refs: [operationId, operation.assignmentId],
        }
      }
      if (receipt.status === "failed") {
        const retry = receipt.error?.retryable === true && operation.invocationCount < maxEffectAttempts
        return {
          fact: {
            type: retry ? "effect.retry-scheduled" : operation.kind === "execution.stop" ? "effect.stop-failed" : "effect.failed",
            operationId,
            receipt,
            occurredAt: receipt.observedAt,
          },
          records: retry ? [] : [completedOperation(operation, receipt)],
          refs: [operationId, operation.assignmentId],
        }
      }
      return null
    })
  }

  return Object.freeze({
    async reconcile(taskId, operationId) {
      let state = await reconciler.load(taskId)
      let operation = state.pendingOperations.find((entry) => entry.operationId === operationId)
      if (!operation) return { changed: false, state }

      let receipt
      let fresh = operation.status === "intent-persisted"
      if (fresh) {
        await faultInjector.beforeInvocationClaim?.({ taskId, operation: structuredClone(operation) })
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
            refs: [operationId, candidate.assignmentId],
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
      if (operation.kind === "execution.stop") {
        receipt = fresh
          ? await execution.stopExecution(operation.intent)
          : await execution.inspectStop(operation.intent)
      } else if (fresh) {
        receipt = await execution.ensureExecution(operation.intent)
      } else {
        receipt = await execution.inspectExecution(operation.intent)
      }

      await faultInjector.afterReceipt?.({ taskId, operation: structuredClone(operation), receipt: structuredClone(receipt) })
      const committed = await commitReceipt(taskId, operationId, receipt)
      return {
        changed: committed.changed,
        state: committed.state,
        inDoubt: receipt.status === "in-doubt",
      }
    },
  })
}
