import {
  assertIdentifier,
  assertNonEmptyString,
  assertTaskState,
  assertTimestamp,
} from "./invariants.mjs"
import { projectStageScope } from "./stage-plan.mjs"

export function createTaskAggregate(input) {
  const taskId = assertIdentifier(input?.taskId, "taskId")
  const title = assertNonEmptyString(input?.title, "title")
  const objective = assertNonEmptyString(input?.objective, "objective")
  const stageRunId = assertIdentifier(input?.stageRunId, "stageRunId")
  const createdAt = assertTimestamp(input?.createdAt, "createdAt")
  const scope = projectStageScope(input.workflow, input.entryStage, input.completion)

  return assertTaskState({
    runtimeMajor: 2,
    schemaVersion: "2.0",
    taskId,
    revision: 0,
    title,
    objective,
    taskIntent: null,
    taskIntentRevision: 0,
    taskIntentHistory: [],
    workflow: {
      workflowId: input.workflow.workflowId,
      version: input.workflow.version,
      digest: input.workflow.digest,
    },
    scope,
    status: "needs-plan",
    currentStageRun: {
      stageRunId,
      sequence: 1,
      round: 1,
      stage: input.entryStage,
      status: "planned",
    },
    stageRuns: [],
    stagePlan: null,
    workGraph: { assignments: [] },
    artifacts: [],
    evidence: [],
    acceptedReportRefs: [],
    costLedger: {
      forecastMin: 0,
      forecastMax: 0,
      accrued: 0,
      uncertain: 0,
      nextWave: 0,
      automaticLimit: 0,
    },
    observationInbox: {
      nextSequence: 1,
      acknowledgedThrough: 0,
      items: [],
      dedupe: [],
    },
    pendingDecision: null,
    decisionHistory: [],
    pendingOperations: [],
    createdAt,
    updatedAt: createdAt,
  })
}
