import { randomUUID } from "node:crypto"

import { reduceTask } from "../domain/reducer.mjs"

export function createTaskReconciler({ store, clock, maxConflicts = 8 }) {
  if (!store || typeof store.loadTask !== "function" || typeof store.commit !== "function") {
    throw new TypeError("TaskReconciler requires a Store")
  }
  if (typeof clock !== "function") throw new TypeError("TaskReconciler requires a clock")

  return Object.freeze({
    load: (taskId) => store.loadTask(taskId),

    async commit(taskId, transition) {
      for (let conflict = 0; conflict <= maxConflicts; conflict += 1) {
        const current = await store.loadTask(taskId)
        const change = await transition(structuredClone(current))
        if (!change) return { changed: false, state: current }
        const fact = { ...change.fact, expectedRevision: current.revision }
        const result = reduceTask(current, fact)
        const auditEvent = {
          eventId: change.eventId ?? `${fact.type.replaceAll(".", "-")}-${result.state.revision}-${randomUUID()}`,
          type: fact.type,
          occurredAt: fact.occurredAt,
          revision: result.state.revision,
          refs: change.refs ?? [current.currentStageRun.stageRunId],
        }
        try {
          const state = await store.commit({
            taskId,
            expectedRevision: current.revision,
            state: result.state,
            records: change.records ?? [],
            auditEvents: [auditEvent],
          })
          return { changed: true, state }
        } catch (error) {
          if (error?.code !== "REVISION_CONFLICT" || conflict === maxConflicts) throw error
        }
      }
      throw new Error("unreachable conflict retry state")
    },
  })
}
