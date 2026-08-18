import { createEffectCoordinator } from "./effect-coordinator.mjs"
import { createTaskReconciler } from "./reconciler.mjs"
import { createSignalHub } from "./signal-hub.mjs"
import { digestEffect, digestValue } from "../domain/digests.mjs"
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
  effectLeaseMs = 120_000,
  maxInternalTransitions = 64,
  idleSettleMs = 1_000,
  maxIdleCorrections = 1,
  faultInjector,
  signalHub = createSignalHub(),
  now = Date.now,
}) {
  const reconciler = createTaskReconciler({ store, clock })
  const effects = createEffectCoordinator({ reconciler, executionAdapter, clock, maxEffectAttempts, effectLeaseMs, faultInjector })

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

  async function prepareNextDispatch(taskId) {
    return reconciler.commit(taskId, (state) => {
      if (!state.stagePlan) return null
      const byId = new Map(state.workGraph.assignments.map((assignment) => [assignment.assignmentId, assignment]))
      const assignment = state.workGraph.assignments.find((candidate) => (
        candidate.status === "planned"
        && candidate.execution
        && candidate.dependsOn.every((dependency) => byId.get(dependency)?.status === "accepted")
      ))
      if (!assignment) return null
      const attempt = assignment.attempts.length + 1
      const seed = digestValue({
        taskId: state.taskId,
        stageRunId: state.currentStageRun.stageRunId,
        assignmentId: assignment.assignmentId,
        attempt,
      }).slice(0, 24)
      const effect = {
        operationId: `dispatch-${seed}`,
        effectDigest: "0".repeat(64),
        taskId: state.taskId,
        stageRunId: state.currentStageRun.stageRunId,
        assignmentId: assignment.assignmentId,
        attempt,
        role: assignment.teamRole,
        assignmentKind: assignment.assignmentKind,
        agentId: assignment.execution.agentId,
        capabilitySnapshotDigest: assignment.execution.capabilitySnapshotDigest,
        mode: "background",
        contextRef: assignment.execution.contextRef,
        promptRef: assignment.execution.promptRef,
      }
      effect.effectDigest = digestEffect(effect)
      return {
        fact: {
          type: "assignment.attempt-started",
          assignmentId: assignment.assignmentId,
          stageRunId: state.currentStageRun.stageRunId,
          attemptId: `${assignment.assignmentId}-attempt-${attempt}`,
          attempt,
          effect,
          occurredAt: clock(),
        },
        refs: [assignment.assignmentId, effect.operationId],
      }
    })
  }

  async function prepareIdleCorrection(taskId, assignment, attempt) {
    return reconciler.commit(taskId, (state) => {
      const currentAssignment = state.workGraph.assignments.find((entry) => entry.assignmentId === assignment.assignmentId)
      const currentAttempt = currentAssignment?.attempts.find((entry) => entry.attemptId === attempt.attemptId)
      if (!currentAssignment || !currentAttempt || currentAttempt.status !== "running" || !currentAttempt.idleObservedAt) return null
      if (currentAttempt.correctionCount >= maxIdleCorrections || !currentAssignment.execution) {
        return {
          fact: {
            type: "execution.idle-exhausted",
            assignmentId: currentAssignment.assignmentId,
            attemptId: currentAttempt.attemptId,
            occurredAt: clock(),
          },
          refs: [currentAssignment.assignmentId, currentAttempt.executionRef],
        }
      }
      const correction = currentAttempt.correctionCount + 1
      const seed = digestValue({
        taskId: state.taskId,
        stageRunId: state.currentStageRun.stageRunId,
        assignmentId: currentAssignment.assignmentId,
        attemptId: currentAttempt.attemptId,
        correction,
      }).slice(0, 24)
      const effect = {
        operationId: `continue-${seed}`,
        effectDigest: "0".repeat(64),
        taskId: state.taskId,
        stageRunId: state.currentStageRun.stageRunId,
        assignmentId: currentAssignment.assignmentId,
        attempt: currentAttempt.attempt,
        role: currentAssignment.teamRole,
        assignmentKind: currentAssignment.assignmentKind,
        agentId: currentAssignment.execution.agentId,
        capabilitySnapshotDigest: currentAssignment.execution.capabilitySnapshotDigest,
        mode: "background",
        contextRef: currentAssignment.execution.contextRef,
        promptRef: currentAssignment.execution.promptRef,
        resumeExecutionRef: currentAttempt.executionRef,
      }
      effect.effectDigest = digestEffect(effect)
      return {
        fact: {
          type: "execution.continuation-requested",
          assignmentId: currentAssignment.assignmentId,
          attemptId: currentAttempt.attemptId,
          intent: effect,
          occurredAt: clock(),
        },
        refs: [currentAssignment.assignmentId, effect.operationId],
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
      const keyDigest = digestValue(`${taskId}:${observation.dedupeKey}`)
      const observationId = `observation-${keyDigest.slice(0, 24)}`
      const value = { observationId, taskId, observation: structuredClone(observation) }
      const digest = digestValue(value)
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
          const prepared = await prepareNextDispatch(taskId)
          if (prepared.changed) continue
          const idleAssignment = state.workGraph.assignments.find((assignment) => (
            assignment.status === "running" && assignment.attempts.at(-1)?.idleObservedAt
          ))
          if (idleAssignment) {
            const idleAttempt = idleAssignment.attempts.at(-1)
            const settleRemaining = Date.parse(idleAttempt.idleObservedAt) + idleSettleMs - now()
            if (settleRemaining <= 0) {
              const correction = await prepareIdleCorrection(taskId, idleAssignment, idleAttempt)
              if (correction.changed) continue
            } else if (waitBudgetMs <= 0) {
              return { state, reason: "settling-idle" }
            } else {
              const remaining = Math.min(deadline - now(), settleRemaining)
              if (remaining <= 0 || signal?.aborted) return { state, reason: "wait-budget-exhausted" }
              const revision = state.revision
              const subscription = signalHub.subscribe(taskId, { signal, timeoutMs: remaining })
              const checked = await reconciler.load(taskId)
              if (checked.revision !== revision || checked.observationInbox.items.length > 0) {
                subscription.cancel()
                continue
              }
              await subscription.promise
              continue
            }
          }
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
