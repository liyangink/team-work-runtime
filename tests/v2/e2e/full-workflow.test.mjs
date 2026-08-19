import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { createRuntimeFacade } from "../../../runtime/application/runtime-facade.mjs"
import { createInMemoryStore } from "../../../runtime/persistence/in-memory-store.mjs"
import {
  createFakeExecutionAdapter,
  createFakeSpecProvider,
  createInMemoryArtifactRepository,
} from "../../../runtime/testing/fakes.mjs"
import { createHappyPathHarness } from "./happy-path-harness.mjs"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")

async function loadJson(relativePath) {
  return JSON.parse(await readFile(path.join(repositoryRoot, relativePath), "utf8"))
}

async function fixture({
  routeConfig = { spec: { mode: "disabled" }, e2e: { mode: "disabled" } },
  e2eAssessment,
  transformReport,
  store = createInMemoryStore(),
  specStatus = "missing",
} = {}) {
  const workflowDefinition = await loadJson("workflow/definitions/engineering.json")
  const teamPolicy = await loadJson("team-work/policies/default.json")
  const artifacts = createInMemoryArtifactRepository({
    "requirements/full.md": "Deliver a reviewed change from research to final acceptance.",
    "scopes/review.md": "Review the complete change.",
    "scopes/test.md": "Exercise the critical user path.",
    "src/existing.mjs": "export const existing = true\n",
  })
  const execution = createFakeExecutionAdapter({ clock: () => "2026-08-19T09:00:00.000Z" })
  const runtime = createRuntimeFacade({
    store,
    executionAdapter: execution,
    specProviderAdapter: createFakeSpecProvider({ status: specStatus }),
    artifactRepository: artifacts,
    workflowDefinition,
    teamPolicy,
    routeConfig,
    clock: () => "2026-08-19T09:00:00.000Z",
  })
  return {
    runtime,
    execution,
    artifacts,
    store,
    workflowDefinition,
    harness: createHappyPathHarness({ runtime, execution, artifacts, store, workflowDefinition, e2eAssessment, transformReport }),
  }
}

test("the platform-neutral harness completes the full workflow with only one plan intent", async () => {
  const { runtime, harness } = await fixture()
  const opened = await runtime.leadControl.open({
    title: "Complete the full engineering workflow",
    objective: "Deliver the requested change through final human acceptance",
    entryStage: "research",
    completion: { mode: "workflow" },
    existingArtifacts: [
      { kind: "requirement", locator: { type: "project-path", value: "requirements/full.md" } },
    ],
  })
  const planned = await runtime.leadControl.plan({
    objective: "Deliver and independently review the requested change",
    preferences: { budget: "quality" },
  })
  const result = await harness.drive(planned)

  assert.equal(opened.next.kind, "plan")
  assert.equal(result.card.task.status, "completed")
  assert.equal(result.card.task.stage, "finish")
  assert.equal(result.humanDecisions, 2)
  assert.ok(result.leadActions < 64)
  const visited = new Set(result.cards.map(({ task }) => task.stage))
  assert.deepEqual([...visited], ["research", "design", "design-review", "implementation", "test", "code-review", "finish"])
  assert.equal(visited.has("spec"), false)
  assert.equal(visited.has("e2e"), false)
})

test("Fake SPEC routing covers disabled, optional-missing, and available provider paths", async (t) => {
  const cases = [
    { name: "disabled", mode: "disabled", status: "missing", visitsSpec: false },
    { name: "auto-missing", mode: "auto", status: "missing", visitsSpec: false },
    { name: "auto-ready", mode: "auto", status: "ready", visitsSpec: true },
    { name: "required-ready", mode: "required", status: "ready", visitsSpec: true },
  ]
  for (const entry of cases) await t.test(entry.name, async () => {
    const { runtime, harness, store } = await fixture({
      routeConfig: { spec: { mode: entry.mode }, e2e: { mode: "disabled" } },
      specStatus: entry.status,
    })
    const opened = await runtime.leadControl.open({
      title: `Route SPEC in ${entry.name} mode`,
      objective: "Design and deliver the requested change",
      entryStage: "design",
      completion: { mode: "workflow" },
      existingArtifacts: [{ kind: "requirement", locator: { type: "project-path", value: "requirements/full.md" } }],
    })
    const completed = await harness.drive(await runtime.leadControl.plan({
      objective: "Design and deliver the requested change",
      preferences: { budget: "quality" },
    }))
    const state = await store.loadTask(opened.task.id)
    assert.equal(completed.card.task.status, "completed")
    assert.equal(state.stageRuns.some(({ stage }) => stage === "spec"), entry.visitsSpec)
    assert.equal(state.stageRuns.some(({ stage }) => stage === "spec-review"), entry.visitsSpec)
  })
})

test("a missing required Fake SPEC provider blocks at the branch instead of spinning", async () => {
  const { runtime, harness, store } = await fixture({
    routeConfig: { spec: { mode: "required" }, e2e: { mode: "disabled" } },
    specStatus: "missing",
  })
  const opened = await runtime.leadControl.open({
    title: "Block a required missing SPEC provider",
    objective: "Design and specify the requested change",
    entryStage: "design",
    completion: { mode: "workflow" },
    existingArtifacts: [{ kind: "requirement", locator: { type: "project-path", value: "requirements/full.md" } }],
  })
  const blocked = await harness.drive(await runtime.leadControl.plan({
    objective: "Design and specify the requested change",
    preferences: { budget: "quality" },
  }), { stopWhen: (card) => card.task?.status === "blocked" })
  const state = await store.loadTask(opened.task.id)
  assert.equal(blocked.card.next.kind, "none")
  assert.equal(state.routeDecisions.at(-1).routeKind, "spec")
  assert.equal(state.routeDecisions.at(-1).reason, "required-provider-missing")
})

test("a mid-stage cost boundary becomes an auditable human choice and resumes after approval", async () => {
  const setup = await fixture()
  setup.workflowDefinition.gates = setup.workflowDefinition.gates.map((gate) => ({ ...gate, requirement: "disabled" }))
  const constrainedPolicy = structuredClone(await loadJson("team-work/policies/default.json"))
  constrainedPolicy.automaticLimits.economy = 10
  const execution = createFakeExecutionAdapter({ clock: () => "2026-08-19T09:00:00.000Z" })
  const store = createInMemoryStore()
  const runtime = createRuntimeFacade({
    store,
    executionAdapter: execution,
    specProviderAdapter: createFakeSpecProvider(),
    artifactRepository: setup.artifacts,
    workflowDefinition: setup.workflowDefinition,
    teamPolicy: constrainedPolicy,
    routeConfig: { spec: { mode: "disabled" }, e2e: { mode: "disabled" } },
    clock: () => "2026-08-19T09:00:00.000Z",
  })
  const harness = createHappyPathHarness({ runtime, execution, artifacts: setup.artifacts, store, workflowDefinition: setup.workflowDefinition })
  await runtime.leadControl.open({
    title: "Review within a constrained automatic budget",
    objective: "Review the existing source",
    entryStage: "code-review",
    completion: { mode: "through-stage", stage: "code-review" },
    existingArtifacts: [
      { kind: "source", locator: { type: "project-path", value: "src/existing.mjs" } },
      { kind: "review-scope", locator: { type: "project-path", value: "scopes/review.md" } },
    ],
  })
  const planned = await runtime.leadControl.plan({ objective: "Review the existing source", preferences: { budget: "economy" } })
  const result = await harness.drive(planned)
  assert.equal(result.card.task.status, "completed")
  assert.ok(result.cards.some(({ next }) => next.kind === "steer" && next.question.includes("超过自动上限")))
  assert.ok(result.humanDecisions >= 1)
})

test("declining a cost increase returns one controlled replan instead of taking a technical rework edge", async () => {
  const setup = await fixture()
  setup.workflowDefinition.gates = setup.workflowDefinition.gates.map((gate) => ({ ...gate, requirement: "disabled" }))
  const constrainedPolicy = structuredClone(await loadJson("team-work/policies/default.json"))
  constrainedPolicy.automaticLimits.economy = 10
  const execution = createFakeExecutionAdapter({ clock: () => "2026-08-19T09:00:00.000Z" })
  const store = createInMemoryStore()
  const runtime = createRuntimeFacade({
    store,
    executionAdapter: execution,
    specProviderAdapter: createFakeSpecProvider(),
    artifactRepository: setup.artifacts,
    workflowDefinition: setup.workflowDefinition,
    teamPolicy: constrainedPolicy,
    routeConfig: { spec: { mode: "disabled" }, e2e: { mode: "disabled" } },
    clock: () => "2026-08-19T09:00:00.000Z",
  })
  const harness = createHappyPathHarness({ runtime, execution, artifacts: setup.artifacts, store, workflowDefinition: setup.workflowDefinition })
  const opened = await runtime.leadControl.open({
    title: "Replan a constrained review",
    objective: "Review the existing source",
    entryStage: "code-review",
    completion: { mode: "through-stage", stage: "code-review" },
    existingArtifacts: [
      { kind: "source", locator: { type: "project-path", value: "src/existing.mjs" } },
      { kind: "review-scope", locator: { type: "project-path", value: "scopes/review.md" } },
    ],
  })
  const economy = { objective: "Review the existing source", preferences: { budget: "economy" } }
  const declined = await harness.drive(await runtime.leadControl.plan(economy), {
    choose: () => "replan",
    stopWhen: (card) => card.next.kind === "plan",
  })
  assert.equal(declined.card.task.stage, "code-review")
  assert.equal(declined.card.next.kind, "plan")

  const completed = await harness.drive(await runtime.leadControl.plan({
    objective: "Review the existing source with approved quality budget",
    preferences: { budget: "quality" },
  }))
  const state = await store.loadTask(opened.task.id)
  assert.equal(completed.card.task.status, "completed")
  assert.equal(state.taskIntentRevision, 2)
  assert.equal(state.taskIntentHistory[0].preferences, undefined)
  assert.equal(state.taskIntentHistory[0].intent.preferences.budget, "economy")
})

test("a user can stop cleanly at a cost boundary without dispatching the blocked member", async () => {
  const setup = await fixture()
  setup.workflowDefinition.gates = setup.workflowDefinition.gates.map((gate) => ({ ...gate, requirement: "disabled" }))
  const constrainedPolicy = structuredClone(await loadJson("team-work/policies/default.json"))
  constrainedPolicy.automaticLimits.economy = 10
  const execution = createFakeExecutionAdapter({ clock: () => "2026-08-19T09:00:00.000Z" })
  const store = createInMemoryStore()
  const runtime = createRuntimeFacade({
    store,
    executionAdapter: execution,
    artifactRepository: setup.artifacts,
    workflowDefinition: setup.workflowDefinition,
    teamPolicy: constrainedPolicy,
    routeConfig: { spec: { mode: "disabled" }, e2e: { mode: "disabled" } },
    clock: () => "2026-08-19T09:00:00.000Z",
  })
  const harness = createHappyPathHarness({ runtime, execution, artifacts: setup.artifacts, store, workflowDefinition: setup.workflowDefinition })
  const opened = await runtime.leadControl.open({
    title: "Stop a constrained review",
    objective: "Review the existing source",
    entryStage: "code-review",
    completion: { mode: "through-stage", stage: "code-review" },
    existingArtifacts: [
      { kind: "source", locator: { type: "project-path", value: "src/existing.mjs" } },
      { kind: "review-scope", locator: { type: "project-path", value: "scopes/review.md" } },
    ],
  })
  const stopped = await harness.drive(await runtime.leadControl.plan({
    objective: "Review the existing source",
    preferences: { budget: "economy" },
  }), {
    choose: () => "stop",
    stopWhen: (card) => card.task?.status === "cancelled",
  })
  assert.equal(stopped.card.task.status, "cancelled")
  assert.equal((await store.loadTask(opened.task.id)).status, "cancelled")
})

test("a human rejection reopens only the current stage and can later be accepted", async () => {
  const { runtime, harness, store } = await fixture()
  const opened = await runtime.leadControl.open({
    title: "Rework a completed implementation after human review",
    objective: "Implement the change and incorporate final human feedback",
    entryStage: "implementation",
    completion: { mode: "through-stage", stage: "implementation" },
    existingArtifacts: [{ kind: "requirement", locator: { type: "project-path", value: "requirements/full.md" } }],
  })
  const planned = await runtime.leadControl.plan({ objective: "Implement the change" })
  const result = await harness.drive(planned, {
    choose: (_card, decisionIndex) => decisionIndex === 0 ? "rework" : "accept",
  })
  const state = await store.loadTask(opened.task.id)
  assert.equal(result.card.task.status, "completed")
  assert.equal(result.humanDecisions, 2)
  assert.equal(state.stageRuns[0].status, "rework")
  assert.equal(state.currentStageRun.round, 2)
  const repeated = await runtime.leadControl.steer({ action: "choose", directive: "accept" })
  assert.equal(repeated.code, "ACTION_STALE")
})

test("design rejection follows the declared rework edge instead of reopening design-review", async () => {
  const { runtime, harness, store } = await fixture()
  const opened = await runtime.leadControl.open({
    title: "Revise a rejected design",
    objective: "Reach agreement on the design before implementation",
    entryStage: "design",
    completion: { mode: "workflow" },
    existingArtifacts: [
      { kind: "requirement", locator: { type: "project-path", value: "requirements/full.md" } },
    ],
  })
  const result = await harness.drive(await runtime.leadControl.plan({
    objective: "Design and deliver the requested change",
    preferences: { budget: "quality" },
  }), {
    choose: (_card, decisionIndex) => decisionIndex === 0 ? "rework" : "accept",
  })
  const state = await store.loadTask(opened.task.id)
  assert.equal(result.card.task.status, "completed")
  assert.ok(state.stageRuns.some(({ stage, status }) => stage === "design-review" && status === "rework"))
  assert.ok(state.stageRuns.filter(({ stage }) => stage === "design").length >= 2)
})

test("final acceptance can return the task to the user-selected responsible stage", async () => {
  let returned = false
  const { runtime, harness, store } = await fixture()
  const opened = await runtime.leadControl.open({
    title: "Return final acceptance feedback to implementation",
    objective: "Deliver the change and route final feedback to its owner",
    entryStage: "implementation",
    completion: { mode: "workflow" },
    existingArtifacts: [
      { kind: "requirement", locator: { type: "project-path", value: "requirements/full.md" } },
    ],
  })
  const result = await harness.drive(await runtime.leadControl.plan({
    objective: "Deliver and review the change",
    preferences: { budget: "quality" },
  }), {
    choose(card) {
      if (!returned && card.task.stage === "finish") {
        returned = true
        return "return-implementation"
      }
      return "accept"
    },
  })
  const state = await store.loadTask(opened.task.id)
  assert.equal(result.card.task.status, "completed")
  const rejectedFinish = state.stageRuns.findIndex(({ stage, status }) => stage === "finish" && status === "rework")
  assert.ok(rejectedFinish >= 0)
  assert.equal(state.stageRuns[rejectedFinish + 1].stage, "implementation")
})

test("a code-review defect follows the member-selected implementation edge", async () => {
  let challenged = false
  const { runtime, harness, store } = await fixture({
    transformReport({ member, stageId, report: value }) {
      if (
        !challenged
        && stageId === "code-review"
        && member.role === "challenger"
        && !member.assignmentId.startsWith("preflight-")
      ) {
        challenged = true
        return { ...value, recommendation: "rework", workflowOutcome: "implementation-defect" }
      }
      return value
    },
  })
  const opened = await runtime.leadControl.open({
    title: "Repair a defect found during code review",
    objective: "Review, repair, retest, and accept the change",
    entryStage: "code-review",
    completion: { mode: "workflow" },
    existingArtifacts: [
      { kind: "requirement", locator: { type: "project-path", value: "requirements/full.md" } },
      { kind: "source", locator: { type: "project-path", value: "src/existing.mjs" } },
      { kind: "review-scope", locator: { type: "project-path", value: "scopes/review.md" } },
      { kind: "test-scope", locator: { type: "project-path", value: "scopes/test.md" } },
    ],
  })
  const result = await harness.drive(await runtime.leadControl.plan({
    objective: "Review and repair the change",
    preferences: { budget: "quality" },
  }))
  const state = await store.loadTask(opened.task.id)
  assert.equal(result.card.task.status, "completed")
  assert.ok(state.stageRuns.some(({ stage, status }) => stage === "code-review" && status === "rework"))
  const firstReview = state.stageRuns.findIndex(({ stage }) => stage === "code-review")
  assert.equal(state.stageRuns[firstReview + 1].stage, "implementation")
})

test("an applicable and ready E2E route executes its complete internally reviewed loop", async () => {
  const { runtime, harness, store } = await fixture({
    routeConfig: { spec: { mode: "disabled" }, e2e: { mode: "auto" } },
    e2eAssessment: { applicable: true, criticalCrossSystemPath: true, environment: "ready" },
  })
  const opened = await runtime.leadControl.open({
    title: "Review and exercise a cross-system change",
    objective: "Review the source and execute its critical E2E path",
    entryStage: "code-review",
    completion: { mode: "workflow" },
    existingArtifacts: [
      { kind: "source", locator: { type: "project-path", value: "src/existing.mjs" } },
      { kind: "review-scope", locator: { type: "project-path", value: "scopes/review.md" } },
      { kind: "test-scope", locator: { type: "project-path", value: "scopes/test.md" } },
    ],
  })
  const planned = await runtime.leadControl.plan({
    objective: "Review and execute the critical E2E path",
    preferences: { budget: "quality" },
  })
  let result
  try {
    result = await harness.drive(planned)
  } catch (error) {
    const failedState = await store.loadTask(opened.task.id)
    error.message += `; stage runs: ${JSON.stringify(failedState.stageRuns)}`
    throw error
  }
  const state = await store.loadTask(opened.task.id)
  assert.equal(result.card.task.status, "completed")
  assert.ok(state.stageRuns.some(({ stage, status }) => stage === "e2e" && status === "completed"))
  assert.ok(result.deliveredAssignments.some((assignmentId) => assignmentId.startsWith("owner-path-design-")))
  assert.ok(result.deliveredAssignments.some((assignmentId) => assignmentId.startsWith("owner-fixture-implementation-")))
  assert.ok(result.deliveredAssignments.some((assignmentId) => assignmentId.startsWith("owner-execution-")))
  assert.equal(result.deliveredAssignments.filter((assignmentId) => assignmentId.startsWith("owner-e2e-applicability-")).length, 1)
  assert.equal(state.routeDecisions.filter(({ outcome }) => outcome === "selected").length, 1)
})

test("E2E findings follow artifact, product, and test-strategy recovery edges", async (t) => {
  const cases = [
    { outcome: "e2e-defect", target: "e2e" },
    { outcome: "product-defect", target: "implementation" },
    { outcome: "test-strategy-gap", target: "test" },
  ]
  for (const entry of cases) await t.test(entry.outcome, async () => {
    let challenged = false
    const { runtime, harness, store } = await fixture({
      routeConfig: { spec: { mode: "disabled" }, e2e: { mode: "auto" } },
      e2eAssessment: { applicable: true, criticalCrossSystemPath: true, environment: "ready" },
      transformReport({ member, stageId, report: value }) {
        if (!challenged && stageId === "e2e" && member.assignmentId.startsWith("challenger-path-design-")) {
          challenged = true
          return { ...value, recommendation: "rework", workflowOutcome: entry.outcome }
        }
        return value
      },
    })
    const opened = await runtime.leadControl.open({
      title: `Recover E2E through ${entry.outcome}`,
      objective: "Exercise and recover the critical path",
      entryStage: "code-review",
      completion: { mode: "workflow" },
      existingArtifacts: [
        { kind: "requirement", locator: { type: "project-path", value: "requirements/full.md" } },
        { kind: "source", locator: { type: "project-path", value: "src/existing.mjs" } },
        { kind: "test-scope", locator: { type: "project-path", value: "scopes/test.md" } },
      ],
    })
    const completed = await harness.drive(await runtime.leadControl.plan({
      objective: "Exercise and recover the critical path",
      preferences: { budget: "quality" },
    }))
    const state = await store.loadTask(opened.task.id)
    assert.equal(completed.card.task.status, "completed")
    const failedE2E = state.stageRuns.findIndex(({ stage, status }) => stage === "e2e" && status === "rework")
    assert.ok(failedE2E >= 0)
    assert.equal(state.stageRuns[failedE2E + 1].stage, entry.target)
  })
})

test("three autonomous E2E rework rounds stop for one explicit user extension", async () => {
  let challengedRounds = 0
  const { runtime, harness, store } = await fixture({
    routeConfig: { spec: { mode: "disabled" }, e2e: { mode: "auto" } },
    e2eAssessment: { applicable: true, criticalCrossSystemPath: true, environment: "ready" },
    transformReport({ member, stageId, report: value }) {
      if (
        challengedRounds < 3
        && stageId === "e2e"
        && member.assignmentId.startsWith("challenger-path-design-")
      ) {
        challengedRounds += 1
        return { ...value, recommendation: "rework", workflowOutcome: "e2e-defect" }
      }
      return value
    },
  })
  const opened = await runtime.leadControl.open({
    title: "Bound autonomous E2E convergence",
    objective: "Stop after three autonomous E2E rework rounds",
    entryStage: "code-review",
    completion: { mode: "workflow" },
    existingArtifacts: [
      { kind: "source", locator: { type: "project-path", value: "src/existing.mjs" } },
      { kind: "test-scope", locator: { type: "project-path", value: "scopes/test.md" } },
    ],
  })
  const completed = await harness.drive(await runtime.leadControl.plan({
    objective: "Bound autonomous E2E convergence",
    preferences: { budget: "quality" },
  }), {
    choose(card) {
      return card.next.question.includes("自主收敛上限") ? "rework" : "accept"
    },
  })
  const state = await store.loadTask(opened.task.id)
  assert.equal(completed.card.task.status, "completed")
  assert.equal(challengedRounds, 3)
  assert.equal(completed.cards.filter(({ next }) => next.kind === "steer" && next.question.includes("自主收敛上限")).length, 1)
  assert.equal(state.stageRuns.filter(({ stage, status }) => stage === "e2e" && status === "rework").length, 3)
})

test("Lead steering opens one durable member-owned intervention round from the DecisionPacket", async (t) => {
  for (const action of ["owner-rework", "collect-evidence", "expert-arbitrate"]) await t.test(action, async () => {
    const { runtime, harness, store } = await fixture()
    const opened = await runtime.leadControl.open({
      title: `Exercise ${action} steering`,
      objective: "Implement and independently review the requested change",
      entryStage: "implementation",
      completion: { mode: "through-stage", stage: "implementation" },
      existingArtifacts: [{ kind: "requirement", locator: { type: "project-path", value: "requirements/full.md" } }],
    })
    const waiting = await harness.drive(await runtime.leadControl.plan({
      objective: "Implement and independently review the requested change",
      preferences: { budget: "quality" },
    }), { stopWhen: (card) => card.task?.status === "awaiting-user" })
    const packetId = waiting.card.decision.packetRef.split("/").at(-1).replace(/\.json$/, "")
    const packet = await store.loadRecord(opened.task.id, "packet", packetId)
    const ownerRef = packet.roster.find(({ role }) => role === "owner")?.memberRef
    const targetRef = action === "collect-evidence" ? packet.artifactRefs[0] : ownerRef
    assert.ok(targetRef)

    const interventionCard = await runtime.leadControl.steer({
      action,
      directive: action === "owner-rework"
        ? "修订当前实现并复核受影响边界"
        : action === "collect-evidence"
          ? "补充失败路径的可验证证据"
          : "独立裁决当前实现是否满足核心约束",
      targetRef,
    })
    const interventionState = await store.loadTask(opened.task.id)
    assert.equal(interventionState.stagePlan.intervention.action, action)
    assert.equal(interventionState.stageRuns.at(-1).status, "rework")
    assert.equal(interventionState.pendingDecision, null)
    assert.equal(interventionCard.task.stage, "implementation")
    if (action === "expert-arbitrate") assert.equal(interventionCard.report.team.owners, 0)
    assert.ok(interventionCard.report.team.cost.forecastMin >= interventionState.costLedger.accrued)

    const completed = await harness.drive(interventionCard)
    assert.equal(completed.card.task.status, "completed")
    const finalState = await store.loadTask(opened.task.id)
    assert.ok(finalState.decisionHistory.some(({ decisionId, choice }) => (
      decisionId === interventionState.stagePlan.intervention.resumeDecisionId && choice === "accept"
    )))
  })
})

test("stale or concurrent DecisionPacket steering cannot open two intervention rounds", async () => {
  const { runtime, harness, store } = await fixture()
  const opened = await runtime.leadControl.open({
    title: "Serialize concurrent steering",
    objective: "Implement and independently review the requested change",
    entryStage: "implementation",
    completion: { mode: "through-stage", stage: "implementation" },
    existingArtifacts: [{ kind: "requirement", locator: { type: "project-path", value: "requirements/full.md" } }],
  })
  const waiting = await harness.drive(await runtime.leadControl.plan({
    objective: "Implement and independently review the requested change",
    preferences: { budget: "quality" },
  }), { stopWhen: (card) => card.task?.status === "awaiting-user" })
  const packetId = waiting.card.decision.packetRef.split("/").at(-1).replace(/\.json$/, "")
  const packet = await store.loadRecord(opened.task.id, "packet", packetId)
  const ownerRef = packet.roster.find(({ role }) => role === "owner").memberRef
  const invalid = await runtime.leadControl.steer({
    action: "expert-arbitrate",
    directive: "不得允许制品引用绕过非作者约束",
    targetRef: packet.artifactRefs[0],
  })
  assert.equal(invalid.code, "ACTION_STALE")
  const calls = await Promise.all([
    runtime.leadControl.steer({ action: "owner-rework", directive: "修订实现", targetRef: ownerRef }),
    runtime.leadControl.steer({ action: "expert-arbitrate", directive: "独立裁决", targetRef: ownerRef }),
  ])
  assert.equal(calls.filter(({ code }) => code === "ACTION_STALE").length, 1, JSON.stringify(calls))
  assert.equal(calls.filter(({ task }) => task?.stage === "implementation").length, 1, JSON.stringify(calls))
  const state = await store.loadTask(opened.task.id)
  assert.equal(state.stageRuns.filter(({ status }) => status === "rework").length, 1)
  assert.ok(state.stagePlan.intervention)
})

test("an unavailable required E2E route blocks once and replans after the environment recovers", async () => {
  const assessment = { applicable: true, criticalCrossSystemPath: true, environment: "missing" }
  const { runtime, harness, store } = await fixture({
    routeConfig: { spec: { mode: "disabled" }, e2e: { mode: "required" } },
    e2eAssessment: assessment,
  })
  const opened = await runtime.leadControl.open({
    title: "Recover a required E2E route",
    objective: "Review and execute the required E2E path",
    entryStage: "code-review",
    completion: { mode: "workflow" },
    existingArtifacts: [
      { kind: "source", locator: { type: "project-path", value: "src/existing.mjs" } },
      { kind: "review-scope", locator: { type: "project-path", value: "scopes/review.md" } },
      { kind: "test-scope", locator: { type: "project-path", value: "scopes/test.md" } },
    ],
  })
  const intent = { objective: "Review and execute the required E2E path", preferences: { budget: "quality" } }
  const blocked = await harness.drive(await runtime.leadControl.plan(intent), {
    stopWhen: (card) => card.task?.status === "blocked",
  })
  assert.equal(blocked.card.next.kind, "none")
  assert.equal((await store.loadTask(opened.task.id)).routeDecisions.at(-1).reason, "e2e-environment-unavailable")

  assessment.environment = "ready"
  const completed = await harness.drive(await runtime.leadControl.plan(intent))
  assert.equal(completed.card.task.status, "completed")
  assert.ok((await store.loadTask(opened.task.id)).stageRuns.some(({ status }) => status === "rework"))
})

test("a restart between E2E assessment acceptance and formal planning retains both review reports", async () => {
  const durableStore = createInMemoryStore()
  let crashOnce = true
  const interruptedStore = {
    ...durableStore,
    async commit(input) {
      const committed = await durableStore.commit(input)
      if (crashOnce && committed.preflight?.kind === "route-assessment" && committed.preflight.status === "satisfied") {
        crashOnce = false
        throw new Error("simulated crash after accepted route assessment")
      }
      return committed
    },
  }
  const assessment = { applicable: true, criticalCrossSystemPath: true, environment: "ready" }
  const interrupted = await fixture({
    store: interruptedStore,
    routeConfig: { spec: { mode: "disabled" }, e2e: { mode: "auto" } },
    e2eAssessment: assessment,
  })
  const opened = await interrupted.runtime.leadControl.open({
    title: "Resume an accepted E2E assessment",
    objective: "Preserve independent assessment evidence across restart",
    entryStage: "code-review",
    completion: { mode: "workflow" },
    existingArtifacts: [
      { kind: "source", locator: { type: "project-path", value: "src/existing.mjs" } },
      { kind: "review-scope", locator: { type: "project-path", value: "scopes/review.md" } },
      { kind: "test-scope", locator: { type: "project-path", value: "scopes/test.md" } },
    ],
  })
  const intent = { objective: "Preserve and execute the assessed path", preferences: { budget: "quality" } }
  await assert.rejects(
    interrupted.harness.drive(await interrupted.runtime.leadControl.plan(intent)),
    /simulated crash after accepted route assessment/,
  )
  const interruptedState = await durableStore.loadTask(opened.task.id)
  assert.equal(interruptedState.preflight.status, "satisfied")
  assert.ok(interruptedState.workGraph.assignments.every(({ status }) => status === "accepted"))

  const execution = createFakeExecutionAdapter({ clock: () => "2026-08-19T09:00:00.000Z" })
  const resumed = createRuntimeFacade({
    store: durableStore,
    executionAdapter: execution,
    specProviderAdapter: createFakeSpecProvider(),
    artifactRepository: interrupted.artifacts,
    workflowDefinition: interrupted.workflowDefinition,
    teamPolicy: await loadJson("team-work/policies/default.json"),
    routeConfig: { spec: { mode: "disabled" }, e2e: { mode: "auto" } },
    clock: () => "2026-08-19T09:00:00.000Z",
  })
  const resumedHarness = createHappyPathHarness({
    runtime: resumed,
    execution,
    artifacts: interrupted.artifacts,
    store: durableStore,
    workflowDefinition: interrupted.workflowDefinition,
    e2eAssessment: assessment,
  })
  const completed = await resumedHarness.drive(await resumed.leadControl.open({ taskId: opened.task.id }))
  assert.equal(completed.card.task.status, "completed")
})

test("research and code-review can independently enter and complete through-stage workflows", async (t) => {
  const cases = [{
    name: "research",
    entryStage: "research",
    inputs: [{ kind: "requirement", locator: { type: "project-path", value: "requirements/full.md" } }],
  }, {
    name: "code-review",
    entryStage: "code-review",
    inputs: [
      { kind: "source", locator: { type: "project-path", value: "src/existing.mjs" } },
      { kind: "review-scope", locator: { type: "project-path", value: "scopes/review.md" } },
    ],
  }]

  for (const entry of cases) await t.test(entry.name, async () => {
    const { runtime, harness } = await fixture()
    const opened = await runtime.leadControl.open({
      title: `Enter at ${entry.entryStage}`,
      objective: `Complete only the ${entry.entryStage} stage`,
      entryStage: entry.entryStage,
      completion: { mode: "through-stage", stage: entry.entryStage },
      existingArtifacts: entry.inputs,
    })
    const planned = await runtime.leadControl.plan({ objective: `Complete ${entry.entryStage}` })
    const result = await harness.drive(planned)
    assert.equal(opened.task.stage, entry.entryStage)
    assert.equal(result.card.task.stage, entry.entryStage)
    assert.equal(result.card.task.status, "completed")
    assert.equal(result.humanDecisions, 1)
  })
})
