import { createEffectCoordinator } from "./effect-coordinator.mjs"
import { createTaskReconciler } from "./reconciler.mjs"
import { createSignalHub } from "./signal-hub.mjs"
import { digestValue } from "../domain/digests.mjs"
import { validateContract } from "../contracts.mjs"

const terminalReasons = new Set(["needs-plan", "awaiting-user", "blocked", "completed", "cancelled"])

function stableReason(state) {
  if (terminalReasons.has(state.status)) return state.status
  if (state.pendingOperations.some((operation) => operation.status === "in-doubt")) return "in-doubt"
  if (state.workGraph.assignments.some((assignment) => assignment.status === "running")) return "waiting-report"
  return "stable"
}

export function createTaskDriver({
  store,
  executionAdapter,
  clock = () => new Date().toISOString(),
  maxEffectAttempts = 2,
  maxInternalTransitions = 64,
  faultInjector,
  signalHub = createSignalHub(),
  now = Date.now,
}) {
  const reconciler = createTaskReconciler({ store, clock })
  const effects = createEffectCoordinator({ reconciler, executionAdapter, clock, maxEffectAttempts, faultInjector })

  async function consumeInbox(taskId) {
    return reconciler.commit(taskId, (state) => {
      const item = state.observationInbox.items[0]
      if (!item) return null
      return {
        fact: {
          type: "observation.consumed",
          sequence: item.sequence,
          observationId: item.observationId,
          ...(item.kind === "member-report" ? { reportId: item.payloadRef.split("/").at(-1).replace(/\.json$/, "") } : {}),
          occurredAt: clock(),
        },
        refs: [item.observationId, ...(item.assignmentId ? [item.assignmentId] : [])],
      }
    })
  }

  async function receive(taskId, item, record) {
    const committed = await reconciler.commit(taskId, (state) => {
      const previous = state.observationInbox.dedupe.find((entry) => entry.dedupeKey === item.dedupeKey)
      if (previous) {
        if (previous.digest !== item.digest) {
          const error = new Error(`dedupe key ${item.dedupeKey} was reused with different content`)
          error.code = "OBSERVATION_DEDUPE_CONFLICT"
          throw error
        }
        return null
      }
      return {
        fact: {
          type: "observation.received",
          item: { ...item, sequence: state.observationInbox.nextSequence },
          occurredAt: item.receivedAt,
        },
        records: record ? [record] : [],
        refs: [item.observationId, ...(item.assignmentId ? [item.assignmentId] : [])],
      }
    })
    if (committed.changed) {
      await faultInjector?.afterInboxCommit?.({ taskId, item: structuredClone(item) })
      signalHub.publish(taskId)
    }
    return committed
  }

  const driver = {
    async deliverMemberReport({ taskId, assignmentId, attemptId, executionRef, operationKey, report }) {
      validateContract(
        "https://team-work-runtime.dev/schemas/v2/member-delivery#/$defs/memberReport",
        report,
        "member report",
      )
      if (typeof operationKey !== "string" || operationKey === "") throw new TypeError("operationKey is required")
      const keyDigest = digestValue(operationKey)
      const reportId = `report-${keyDigest.slice(0, 24)}`
      const observationId = `observation-${keyDigest.slice(0, 24)}`
      const receivedAt = clock()
      const value = { reportId, taskId, assignmentId, attemptId, executionRef, report: structuredClone(report) }
      const digest = digestValue(value)
      const dedupeKey = `member-report:${operationKey}`
      const current = await reconciler.load(taskId)
      const previous = current.observationInbox.dedupe.find((entry) => entry.dedupeKey === dedupeKey)
      if (previous) {
        if (previous.digest !== digest) {
          const error = new Error(`dedupe key ${dedupeKey} was reused with different content`)
          error.code = "OBSERVATION_DEDUPE_CONFLICT"
          throw error
        }
        return {
          reportId,
          observationId: previous.observationId,
          assignmentId,
          accepted: true,
          duplicate: true,
          stateRevision: previous.stateRevision,
        }
      }
      const assignment = current.workGraph.assignments.find((entry) => entry.assignmentId === assignmentId)
      const attempt = assignment?.attempts.find((entry) => entry.attemptId === attemptId)
      if (!assignment || !attempt || attempt.status !== "running" || attempt.executionRef !== executionRef) {
        const error = new Error("member report binding does not target the running assignment attempt")
        error.code = "MEMBER_BINDING_STALE"
        throw error
      }
      const result = await receive(taskId, {
        observationId,
        dedupeKey,
        digest,
        kind: "member-report",
        assignmentId,
        attemptId,
        executionRef,
        payloadRef: `reports/${reportId}.json`,
        receivedAt,
      }, { kind: "report", recordId: reportId, value })
      const state = result.state
      const summary = state.observationInbox.dedupe.find((entry) => entry.dedupeKey === dedupeKey)
      return {
        reportId,
        observationId: summary.observationId,
        assignmentId,
        accepted: true,
        duplicate: !result.changed,
        stateRevision: summary.stateRevision,
      }
    },

    async observe({ taskId, observation }) {
      validateContract(
        "https://team-work-runtime.dev/schemas/v2/platform-observation#/$defs/observation",
        observation,
        "platform observation",
      )
      const digest = digestValue(observation)
      const keyDigest = digestValue(`${taskId}:${observation.dedupeKey}`)
      const observationId = `observation-${keyDigest.slice(0, 24)}`
      const current = await reconciler.load(taskId)
      const previous = current.observationInbox.dedupe.find((entry) => entry.dedupeKey === observation.dedupeKey)
      if (previous) {
        if (previous.digest !== digest) {
          const error = new Error(`dedupe key ${observation.dedupeKey} was reused with different content`)
          error.code = "OBSERVATION_DEDUPE_CONFLICT"
          throw error
        }
        return { observationId: previous.observationId, sequence: previous.sequence, duplicate: true }
      }
      const assignment = current.workGraph.assignments.find((entry) => entry.assignmentId === observation.assignmentId)
      const attempt = assignment?.attempts.at(-1)
      if (!assignment || !attempt || attempt.executionRef !== observation.executionRef) {
        const error = new Error("platform observation does not match the active assignment execution")
        error.code = "OBSERVATION_BINDING_STALE"
        throw error
      }
      const kind = observation.kind === "check"
        ? "check-result"
        : `execution-${observation.state}`
      const value = { observationId, taskId, receivedAt: clock(), observation: structuredClone(observation) }
      const result = await receive(taskId, {
        observationId,
        dedupeKey: observation.dedupeKey,
        digest,
        kind,
        assignmentId: observation.assignmentId,
        attemptId: attempt.attemptId,
        executionRef: observation.executionRef,
        payloadRef: `observations/${observationId}.json`,
        receivedAt: observation.observedAt,
      }, { kind: "observation", recordId: observationId, value })
      const summary = result.state.observationInbox.dedupe.find((entry) => entry.dedupeKey === observation.dedupeKey)
      return { observationId: summary.observationId, sequence: summary.sequence, duplicate: !result.changed }
    },

    async run({ taskId, waitBudgetMs = 0, signal } = {}) {
      const deadline = now() + Math.max(0, waitBudgetMs)
      for (let index = 0; index < maxInternalTransitions; index += 1) {
        const state = await reconciler.load(taskId)
        if (["awaiting-user", "completed", "cancelled"].includes(state.status)) return { state, reason: state.status }
        if (state.observationInbox.items.length > 0) {
          await consumeInbox(taskId)
          continue
        }
        const operation = state.pendingOperations[0]
        if (!operation) {
          const reason = stableReason(state)
          if (reason !== "waiting-report" || waitBudgetMs <= 0) return { state, reason }
          const remaining = deadline - now()
          if (remaining <= 0 || signal?.aborted) return { state, reason: "wait-budget-exhausted" }

          const revision = state.revision
          const subscription = signalHub.subscribe(taskId, { signal, timeoutMs: remaining })
          const checked = await reconciler.load(taskId)
          if (checked.revision !== revision || checked.observationInbox.items.length > 0) {
            subscription.cancel()
            continue
          }
          await subscription.promise
          const awakened = await reconciler.load(taskId)
          if (awakened.revision === revision && awakened.observationInbox.items.length === 0) {
            if (signal?.aborted || now() >= deadline) return { state: awakened, reason: "wait-budget-exhausted" }
          }
          continue
        }
        const outcome = await effects.reconcile(taskId, operation.operationId)
        if (outcome.inDoubt && !outcome.changed) return { state: outcome.state, reason: "in-doubt" }
      }
      throw new Error(`Task Driver exceeded ${maxInternalTransitions} internal transitions`)
    },
  }
  return Object.freeze(driver)
}
