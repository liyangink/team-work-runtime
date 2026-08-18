import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { validateContract } from "../../../runtime/contracts.mjs"
import { createTaskAggregate, digestValue, reduceTask } from "../../../runtime/domain/index.mjs"
import { compilePolicyPlan } from "../../../runtime/application/policy-compiler.mjs"
import { normalizeStagePlan } from "../../../runtime/domain/stage-plan.mjs"
import { compileE2ERoute, compileSpecRoute } from "../../../workflow/compiler.mjs"
import { compileSteeringAction, createSteeringAuthority, evaluateConvergence, projectCostLedger } from "../../../team-work/compiler.mjs"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")

async function loadJson(relativePath) {
  return JSON.parse(await readFile(path.join(repositoryRoot, relativePath), "utf8"))
}

function agentCatalog() {
  const agents = [
    { agentId: "junior-luna", tier: "junior", modelFamily: "luna", assignmentKinds: ["*"] },
    { agentId: "senior-terra", tier: "senior", modelFamily: "terra", assignmentKinds: ["*"] },
    { agentId: "expert-opus", tier: "expert", modelFamily: "opus", assignmentKinds: ["*"] },
  ]
  return { digest: digestValue(agents), agents }
}

function artifact(kind, ref = `artifact:${kind}`) {
  return { kind, ref, digest: digestValue({ kind, ref, fixture: true }) }
}

test("a clear implementation stage compiles directly without a planning agent", async () => {
  const workflow = await loadJson("workflow/definitions/engineering.json")
  const teamPolicy = await loadJson("team-work/policies/default.json")
  const result = compilePolicyPlan({
    task: {
      taskId: "implement-cache",
      currentStageRun: { stageRunId: "stage-run-1", stage: "implementation", round: 1 },
      scope: { stages: ["implementation"], edges: [], completionStages: ["implementation"] },
      costLedger: { accrued: 0, uncertain: 0 },
    },
    taskIntent: {
      objective: "Implement the approved cache change",
      constraints: ["preserve the public API"],
      exclusions: [],
      preferences: { execution: "auto", budget: "balanced", risk: "normal" },
    },
    availableArtifacts: [artifact("requirement")],
    workflowDefinition: workflow,
    teamPolicy,
    agentCatalog: agentCatalog(),
    routeInputs: {
      humanDecisionCapability: "verified-event",
      spec: { mode: "disabled", configDigest: digestValue({ mode: "disabled" }) },
      e2e: { mode: "auto", userRequired: false },
    },
  })

  assert.equal(result.kind, "executable")
  assert.equal(result.summary.mode, "solo")
  assert.equal(result.summary.planningBootstrap, false)
  assert.deepEqual(result.plan.assignments.map(({ teamRole, assignmentKind, costTier }) => ({
    teamRole,
    assignmentKind,
    costTier,
  })), [
    { teamRole: "owner", assignmentKind: "implementation", costTier: "junior" },
    { teamRole: "challenger", assignmentKind: "review", costTier: "senior" },
    { teamRole: "owner", assignmentKind: "implementation", costTier: "junior" },
  ])
  assert.deepEqual(result.plan.assignments[1].dependsOn, [result.plan.assignments[0].assignmentId])
  assert.equal(result.plan.assignments[2].execution.resumeAssignmentId, result.plan.assignments[0].assignmentId)
  assert.deepEqual(result.costLedger, {
    forecastMin: 12,
    forecastMax: 36,
    accrued: 0,
    uncertain: 0,
    nextWave: 1,
    automaticLimit: 200,
  })
  assert.deepEqual(result.plan.routes.humanGates, [
    {
      gateId: "design-approval",
      stage: "design-review",
      artifactKind: "design",
      requirement: "required",
      action: "wait",
      proofMode: "verified-event",
    },
    {
      gateId: "final-acceptance",
      stage: "finish",
      artifactKind: "delivery-report",
      requirement: "required",
      action: "wait",
      proofMode: "verified-event",
    },
  ])
})

test("human gate route overrides retain the Workflow Definition stage and artifact kind", async () => {
  const workflow = await loadJson("workflow/definitions/engineering.json")
  const teamPolicy = await loadJson("team-work/policies/default.json")
  const compile = (humanReview) => compilePolicyPlan({
    task: {
      taskId: "human-gate-overrides",
      currentStageRun: { stageRunId: "stage-run-1", stage: "implementation", round: 1 },
      scope: { stages: ["implementation"], edges: [], completionStages: ["implementation"] },
      costLedger: { accrued: 0, uncertain: 0 },
    },
    taskIntent: {
      objective: "Implement the approved cache change",
      constraints: [],
      exclusions: [],
      preferences: { execution: "auto", budget: "balanced", risk: "normal" },
    },
    availableArtifacts: [artifact("requirement")],
    workflowDefinition: workflow,
    teamPolicy,
    agentCatalog: agentCatalog(),
    routeInputs: {
      humanDecisionCapability: "verified-event",
      humanReview,
      spec: { mode: "disabled", configDigest: digestValue({ mode: "disabled" }) },
      e2e: { mode: "auto", userRequired: false },
    },
  })

  const required = compile({})
  const optional = compile({ "design-approval": "optional" })
  const disabled = compile({ "final-acceptance": "disabled" })

  for (const result of [required, optional, disabled]) {
    assert.deepEqual(result.plan.routes.humanGates.map(({ gateId, stage, artifactKind }) => ({ gateId, stage, artifactKind })), [
      { gateId: "design-approval", stage: "design-review", artifactKind: "design" },
      { gateId: "final-acceptance", stage: "finish", artifactKind: "delivery-report" },
    ])
  }
  assert.equal(required.plan.routes.humanGates[0].requirement, "required")
  assert.equal(optional.plan.routes.humanGates[0].requirement, "optional")
  assert.equal(optional.plan.routes.humanGates[0].action, "wait")
  assert.equal(disabled.plan.routes.humanGates[1].requirement, "disabled")
  assert.equal(disabled.plan.routes.humanGates[1].action, "skip")
})

test("a complex design uses a planning bootstrap before freezing a multi-owner graph", async () => {
  const workflow = await loadJson("workflow/definitions/engineering.json")
  const teamPolicy = await loadJson("team-work/policies/default.json")
  const base = {
    task: {
      taskId: "design-migration",
      currentStageRun: { stageRunId: "stage-run-1", stage: "design", round: 1 },
      scope: { stages: ["design"], edges: [], completionStages: ["design"] },
      costLedger: { accrued: 0, uncertain: 0 },
    },
    taskIntent: {
      objective: "Design the storage migration",
      constraints: ["support rollback"],
      exclusions: [],
      preferences: { execution: "auto", budget: "quality", risk: "normal" },
    },
    availableArtifacts: [artifact("requirement")],
    workflowDefinition: workflow,
    teamPolicy,
    agentCatalog: agentCatalog(),
    routeInputs: {
      humanDecisionCapability: "verified-event",
      spec: { mode: "disabled", configDigest: digestValue({ mode: "disabled" }) },
      e2e: { mode: "auto", userRequired: false },
    },
  }

  const bootstrap = compilePolicyPlan(base)
  assert.equal(bootstrap.kind, "planning-bootstrap")
  assert.equal(bootstrap.plan, null)
  assert.equal(bootstrap.preflight.preflightKind, "planning-bootstrap")
  assert.equal(bootstrap.summary.planningBootstrap, true)
  assert.deepEqual(bootstrap.preflight.assignments.map(({ teamRole, assignmentKind, costTier }) => ({ teamRole, assignmentKind, costTier })), [
    { teamRole: "owner", assignmentKind: "planning", costTier: "junior" },
    { teamRole: "challenger", assignmentKind: "review", costTier: "senior" },
    { teamRole: "expert", assignmentKind: "design", costTier: "expert" },
    { teamRole: "owner", assignmentKind: "planning", costTier: "junior" },
  ])
  assert.throws(
    () => normalizeStagePlan(bootstrap.preflight, "stage-run-1"),
    (error) => error.code === "STAGE_PLAN_PREFLIGHT",
  )

  const proposalBody = {
    proposalId: "proposal-design-migration",
    stageRunId: "stage-run-1",
    stage: "design",
    integrationRequired: true,
    workPackages: [
      {
        packageId: "storage",
        objective: "Design the storage transition",
        inputRefs: [],
        outputRefs: ["artifact:storage-design"],
        completionCriteria: ["cover migration and rollback"],
        dependsOn: [],
      },
      {
        packageId: "compatibility",
        objective: "Design compatibility behavior",
        inputRefs: [],
        outputRefs: ["artifact:compatibility-design"],
        completionCriteria: ["cover old and new clients"],
        dependsOn: [],
      },
    ],
  }
  const proposal = { ...proposalBody, digest: digestValue(proposalBody) }
  const compiled = compilePolicyPlan({ ...base, proposal })

  assert.equal(compiled.kind, "executable")
  assert.equal(compiled.summary.mode, "team")
  assert.equal(compiled.summary.planningBootstrap, false)
  assert.deepEqual(compiled.plan.assignments.map(({ teamRole, assignmentKind }) => ({ teamRole, assignmentKind })), [
    { teamRole: "owner", assignmentKind: "design" },
    { teamRole: "owner", assignmentKind: "design" },
    { teamRole: "owner", assignmentKind: "integration" },
    { teamRole: "challenger", assignmentKind: "review" },
    { teamRole: "expert", assignmentKind: "design" },
    { teamRole: "owner", assignmentKind: "design" },
    { teamRole: "owner", assignmentKind: "design" },
    { teamRole: "owner", assignmentKind: "integration" },
  ])
  const [first, second, integration, challenger, expert] = compiled.plan.assignments
  assert.notEqual(challenger.assignmentId, bootstrap.preflight.assignments.find(({ teamRole }) => teamRole === "challenger").assignmentId)
  assert.notEqual(expert.assignmentId, bootstrap.preflight.assignments.find(({ teamRole }) => teamRole === "expert").assignmentId)
  assert.deepEqual(integration.dependsOn, [first.assignmentId, second.assignmentId])
  assert.deepEqual(challenger.dependsOn, [integration.assignmentId])
  assert.deepEqual(expert.dependsOn, [challenger.assignmentId])
  assert.deepEqual(integration.writableRefs, ["artifact:design"])
})

test("SPEC routing deterministically pins use, skip, and recoverable block decisions", () => {
  const configDigest = digestValue({ spec: "config" })
  const ready = { status: "ready", digest: digestValue({ status: "ready" }), providerId: "openspec" }
  const missing = { status: "missing", digest: digestValue({ status: "missing" }) }

  assert.equal(compileSpecRoute({ mode: "disabled", configDigest }).decision, "skip")
  assert.equal(compileSpecRoute({ mode: "auto", configDigest, probe: ready }).decision, "use-provider")
  assert.equal(compileSpecRoute({ mode: "auto", configDigest, probe: missing }).decision, "skip")
  assert.equal(compileSpecRoute({ mode: "required", configDigest, probe: missing }).decision, "block")
  assert.equal(compileSpecRoute({ mode: "required", configDigest, probe: ready }).decision, "use-provider")

  const first = compileSpecRoute({ mode: "auto", configDigest, probe: ready })
  const repeated = compileSpecRoute({ mode: "auto", configDigest, probe: ready })
  assert.equal(first.digest, repeated.digest)
})

test("E2E routing requires independent evidence and never guesses environment readiness", () => {
  const taskIntentDigest = digestValue({ objective: "route E2E" })
  const artifactSnapshotDigest = digestValue([artifact("source")])
  assert.deepEqual(compileE2ERoute({ mode: "auto", userRequired: false, taskIntentDigest, artifactSnapshotDigest }), {
    kind: "assessment-required",
    mode: "auto",
    userRequired: false,
    taskIntentDigest,
    artifactSnapshotDigest,
  })

  const assessmentBody = {
    assessmentId: "assessment-1",
    taskId: "review-change",
    stageRunId: "stage-run-1",
    applicable: true,
    criticalCrossSystemPath: false,
    environment: "missing",
    evidenceRefs: ["evidence:e2e-environment"],
    artifactSnapshotDigest,
    evidenceSnapshotDigest: digestValue({ evidence: "e2e-environment" }),
    ownerAssignmentId: "owner-e2e-assessment",
    challengerAssignmentId: "challenger-e2e-assessment",
    ownerSessionDigest: digestValue("session-owner-e2e-assessment"),
    challengerSessionDigest: digestValue("session-challenger-e2e-assessment"),
    ownerReportRef: "report:e2e-owner",
    challengerReportRef: "report:e2e-challenger",
  }
  const assessment = { ...assessmentBody, digest: digestValue(assessmentBody) }
  assert.equal(compileE2ERoute({ mode: "auto", userRequired: false, assessment, taskIntentDigest, artifactSnapshotDigest }).decision, "block")
  assert.equal(compileE2ERoute({ mode: "required", userRequired: false, assessment, taskIntentDigest, artifactSnapshotDigest }).decision, "block")

  const readyBody = { ...assessmentBody, environment: "ready" }
  const ready = { ...readyBody, digest: digestValue(readyBody) }
  assert.equal(compileE2ERoute({ mode: "auto", userRequired: false, assessment: ready, taskIntentDigest, artifactSnapshotDigest }).decision, "run")

  const notApplicableBody = { ...assessmentBody, applicable: false, environment: "unknown" }
  const notApplicable = { ...notApplicableBody, digest: digestValue(notApplicableBody) }
  assert.equal(compileE2ERoute({ mode: "auto", userRequired: false, assessment: notApplicable, taskIntentDigest, artifactSnapshotDigest }).decision, "skip")
  assert.equal(compileE2ERoute({ mode: "disabled", userRequired: true, assessment: notApplicable, taskIntentDigest, artifactSnapshotDigest }).decision, "block")

  assert.throws(
    () => compileE2ERoute({ mode: "auto", userRequired: false, assessment: { ...ready, digest: "0".repeat(64) }, taskIntentDigest, artifactSnapshotDigest }),
    (error) => error.code === "E2E_ROUTE_INVALID",
  )
})

test("code review keeps all required perspectives independent from cost tiers", async () => {
  const workflow = await loadJson("workflow/definitions/engineering.json")
  const teamPolicy = await loadJson("team-work/policies/default.json")
  const result = compilePolicyPlan({
    task: {
      taskId: "review-runtime",
      currentStageRun: { stageRunId: "stage-run-1", stage: "code-review", round: 1 },
      scope: { stages: ["code-review"], edges: [], completionStages: ["code-review"] },
      costLedger: { accrued: 0, uncertain: 0 },
    },
    taskIntent: {
      objective: "Review the Runtime change",
      constraints: [],
      exclusions: [],
      preferences: { execution: "auto", budget: "balanced", risk: "normal" },
    },
    availableArtifacts: [artifact("source"), artifact("review-scope")],
    workflowDefinition: workflow,
    teamPolicy,
    agentCatalog: agentCatalog(),
    routeInputs: {
      humanDecisionCapability: "verified-event",
      spec: { mode: "disabled", configDigest: digestValue({ mode: "disabled" }) },
      e2e: { mode: "auto", userRequired: false },
    },
  })
  const owner = result.plan.assignments.find(({ teamRole }) => teamRole === "owner")
  const perspectives = owner.completionCriteria.filter((entry) => entry.startsWith("cover review perspective:"))
  assert.equal(perspectives.length, 8)
  assert.deepEqual(result.plan.assignments.map(({ teamRole, costTier }) => ({ teamRole, costTier })), [
    { teamRole: "owner", costTier: "junior" },
    { teamRole: "challenger", costTier: "senior" },
    { teamRole: "expert", costTier: "expert" },
    { teamRole: "owner", costTier: "junior" },
  ])
})

test("an applicable E2E stage compiles the full internal review loop", async () => {
  const workflow = await loadJson("workflow/definitions/engineering.json")
  const teamPolicy = await loadJson("team-work/policies/default.json")
  const availableArtifacts = [artifact("source"), artifact("test-scope")]
  const artifactSnapshotDigest = digestValue(availableArtifacts.map(({ kind, ref, digest }) => ({ kind, ref, digest })))
  const assessmentBody = {
    assessmentId: "assessment-e2e",
    taskId: "verify-checkout",
    stageRunId: "stage-run-1",
    applicable: true,
    criticalCrossSystemPath: true,
    environment: "ready",
    evidenceRefs: ["evidence:environment-ready"],
    artifactSnapshotDigest,
    evidenceSnapshotDigest: digestValue({ evidence: "environment-ready" }),
    ownerAssignmentId: "owner-e2e-assessment",
    challengerAssignmentId: "challenger-e2e-assessment",
    ownerSessionDigest: digestValue("session-owner-e2e-assessment"),
    challengerSessionDigest: digestValue("session-challenger-e2e-assessment"),
    ownerReportRef: "report:assessment-owner",
    challengerReportRef: "report:assessment-challenger",
  }
  const result = compilePolicyPlan({
    task: {
      taskId: "verify-checkout",
      currentStageRun: { stageRunId: "stage-run-1", stage: "e2e", round: 1 },
      scope: { stages: ["e2e"], edges: [], completionStages: ["e2e"] },
      costLedger: { accrued: 0, uncertain: 0 },
    },
    taskIntent: {
      objective: "Verify checkout through the real system boundary",
      constraints: [],
      exclusions: [],
      preferences: { execution: "auto", budget: "quality", risk: "normal" },
    },
    availableArtifacts,
    workflowDefinition: workflow,
    teamPolicy,
    agentCatalog: agentCatalog(),
    routeInputs: {
      humanDecisionCapability: "verified-event",
      spec: { mode: "disabled", configDigest: digestValue({ mode: "disabled" }) },
      e2e: {
        mode: "auto",
        userRequired: false,
        assessment: { ...assessmentBody, digest: digestValue(assessmentBody) },
      },
    },
  })

  assert.equal(result.routes.e2e.decision, "run")
  assert.deepEqual(result.plan.assignments.map(({ teamRole }) => teamRole), [
    "owner", "challenger",
    "owner", "challenger",
    "owner", "challenger",
    "expert",
    "owner", "owner", "owner",
  ])
  for (let index = 1; index < 7; index += 1) {
    assert.deepEqual(result.plan.assignments[index].dependsOn, [result.plan.assignments[index - 1].assignmentId])
  }
  for (const [index, response] of result.plan.assignments.slice(7).entries()) {
    assert.deepEqual(response.dependsOn, [
      result.plan.assignments[(index * 2) + 1].assignmentId,
      result.plan.assignments[6].assignmentId,
    ])
    assert.ok(response.execution.resumeAssignmentId)
  }
})

test("convergence stops at three autonomous rounds and cost uncertainty cannot be ignored", async () => {
  const teamPolicy = await loadJson("team-work/policies/default.json")
  assert.deepEqual(evaluateConvergence({
    round: 2,
    maxAutonomousRounds: teamPolicy.maxAutonomousRounds,
    owner: "dispute",
    challenger: "rework",
    expert: "rework",
  }), { action: "rework", nextRound: 3 })
  assert.deepEqual(evaluateConvergence({
    round: 3,
    maxAutonomousRounds: teamPolicy.maxAutonomousRounds,
    owner: "dispute",
    challenger: "rework",
    expert: "rework",
  }), { action: "user-decision", reason: "autonomous-round-limit" })
  assert.deepEqual(evaluateConvergence({
    round: 1,
    maxAutonomousRounds: teamPolicy.maxAutonomousRounds,
    owner: "accept",
    challenger: "accept",
    expert: "accept",
  }), { action: "accept" })

  const ledger = projectCostLedger({
    assignments: [{ costTier: "expert", dependsOn: [] }],
    policy: teamPolicy,
    budget: "economy",
    accrued: 15,
    uncertain: 10,
  })
  assert.equal(ledger.nextWave, 50)
  assert.ok(ledger.accrued + ledger.uncertain + ledger.nextWave > ledger.automaticLimit)
})

test("controlled steering routes technical judgment to members without exposing orchestration", async () => {
  const teamPolicy = await loadJson("team-work/policies/default.json")
  const context = {
    authority: createSteeringAuthority({
      taskId: "cache-task",
      stageRunId: "stage-run-1",
      artifactDigest: "f".repeat(64),
      allowedActions: ["choose", "challenge-again", "expert-arbitrate", "second-expert-opinion"],
      exposedRefs: ["assignment:owner-1", "decision:cache-strategy", "verdict:expert-1"],
      choices: ["accept-risk", "return-to-design"],
    }),
    current: {
      taskId: "cache-task",
      stageRunId: "stage-run-1",
      artifactDigest: "f".repeat(64),
      steeringTokenDigest: null,
      stable: true,
      round: 2,
      costLedger: { accrued: 20, uncertain: 0, automaticLimit: 200 },
    },
    teamPolicy,
  }
  context.current.steeringTokenDigest = context.authority.tokenDigest
  assert.deepEqual(compileSteeringAction({
    ...context,
    intent: { action: "expert-arbitrate", directive: "Resolve the cache consistency disagreement", targetRef: "decision:cache-strategy" },
  }), {
    action: "create-expert-assignment",
    targetRef: "decision:cache-strategy",
    relativeCost: 50,
  })
  assert.deepEqual(compileSteeringAction({
    ...context,
    current: { ...context.current, round: 3 },
    intent: { action: "challenge-again", directive: "Check the unresolved failure path", targetRef: "assignment:owner-1" },
  }), { action: "user-decision", reason: "autonomous-round-limit" })
  assert.deepEqual(compileSteeringAction({
    ...context,
    current: { ...context.current, costLedger: { accrued: 160, uncertain: 10, automaticLimit: 200 } },
    intent: { action: "second-expert-opinion", directive: "Obtain an independent opinion", targetRef: "verdict:expert-1" },
  }), { action: "budget-decision", relativeCost: 50 })
  assert.throws(
    () => compileSteeringAction({
      ...context,
      intent: {
        action: "expert-arbitrate",
        directive: "Use this exact model",
        targetRef: "decision:cache-strategy",
        agentId: "expert-opus",
      },
    }),
    (error) => error.code === "STEERING_INVALID",
  )
  assert.throws(
    () => compileSteeringAction({
      ...context,
      current: { ...context.current, artifactDigest: "0".repeat(64) },
      intent: { action: "expert-arbitrate", directive: "Resolve it", targetRef: "decision:cache-strategy" },
    }),
    (error) => error.code === "STEERING_AUTHORITY_STALE",
  )
  assert.throws(
    () => compileSteeringAction({
      ...context,
      authority: { ...context.authority, allowedActions: [...context.authority.allowedActions, "replan"] },
      intent: { action: "replan", directive: "Change the plan" },
    }),
    (error) => error.code === "STEERING_AUTHORITY_INVALID",
  )
  const replanAuthority = createSteeringAuthority({
    taskId: context.current.taskId,
    stageRunId: context.current.stageRunId,
    artifactDigest: context.current.artifactDigest,
    allowedActions: ["replan"],
  })
  assert.deepEqual(compileSteeringAction({
    ...context,
    authority: replanAuthority,
    current: { ...context.current, steeringTokenDigest: replanAuthority.tokenDigest },
    intent: { action: "replan", directive: "Apply the newly confirmed constraint" },
  }), { action: "replan-stage", reason: "Apply the newly confirmed constraint" })
})

test("versioned policy files validate and a compiled plan freezes without losing policy pins", async () => {
  const workflowDefinition = await loadJson("workflow/definitions/engineering.json")
  const teamPolicy = await loadJson("team-work/policies/default.json")
  validateContract("https://team-work-runtime.dev/schemas/v2/workflow-policy", workflowDefinition, "engineering workflow")
  validateContract("https://team-work-runtime.dev/schemas/v2/team-policy", teamPolicy, "default team policy")

  const workflow = {
    workflowId: workflowDefinition.workflowId,
    version: workflowDefinition.version,
    digest: digestValue(workflowDefinition),
    stages: workflowDefinition.stages.map(({ id }) => id),
    edges: workflowDefinition.edges,
    terminalStages: workflowDefinition.terminalStages,
  }
  let state = createTaskAggregate({
    taskId: "freeze-compiled-plan",
    title: "Freeze compiler output",
    objective: "Prove the policy seam reaches the aggregate",
    workflow,
    entryStage: "implementation",
    completion: { mode: "through-stage", stage: "implementation" },
    stageRunId: "stage-run-1",
    createdAt: "2026-08-18T10:00:00.000Z",
  })
  state = reduceTask(state, {
    type: "task-intent.recorded",
    expectedRevision: 0,
    intent: {
      objective: "Prove the policy seam reaches the aggregate",
      constraints: [],
      exclusions: [],
      preferences: { execution: "auto", budget: "balanced", risk: "normal" },
    },
    occurredAt: "2026-08-18T10:01:00.000Z",
  }).state
  const compiled = compilePolicyPlan({
    task: state,
    availableArtifacts: [artifact("requirement")],
    workflowDefinition,
    teamPolicy,
    agentCatalog: agentCatalog(),
    routeInputs: {
      humanDecisionCapability: "verified-event",
      spec: { mode: "disabled", configDigest: digestValue({ mode: "disabled" }) },
      e2e: { mode: "auto", userRequired: false },
    },
  })
  state = reduceTask(state, {
    type: "stage-plan.frozen",
    expectedRevision: 1,
    plan: compiled.plan,
    costLedger: compiled.costLedger,
    occurredAt: "2026-08-18T10:02:00.000Z",
  }).state

  assert.equal(state.stagePlan.policyPins.workflow.digest, workflow.digest)
  assert.equal(state.stagePlan.policyPins.team.policyId, "default")
  assert.equal(state.stagePlan.convergence.maxAutonomousRounds, 3)
  assert.equal(state.stagePlan.teamMode, "solo")
  assert.equal(state.workGraph.assignments.length, 3)

  const revisedIntent = {
    ...state.taskIntent,
    constraints: ["preserve the public API", "support rollback"],
  }
  state = reduceTask(state, {
    type: "stage.replanned",
    expectedRevision: state.revision,
    nextStageRunId: "stage-run-2",
    reason: "Add the confirmed rollback constraint",
    taskIntent: revisedIntent,
    occurredAt: "2026-08-18T10:03:00.000Z",
  }).state
  const recompiled = compilePolicyPlan({
    task: state,
    availableArtifacts: [artifact("requirement")],
    workflowDefinition,
    teamPolicy,
    agentCatalog: agentCatalog(),
    routeInputs: {
      humanDecisionCapability: "verified-event",
      spec: { mode: "disabled", configDigest: digestValue({ mode: "disabled" }) },
      e2e: { mode: "auto", userRequired: false },
    },
  })
  state = reduceTask(state, {
    type: "stage-plan.frozen",
    expectedRevision: state.revision,
    plan: recompiled.plan,
    costLedger: recompiled.costLedger,
    occurredAt: "2026-08-18T10:04:00.000Z",
  }).state
  assert.equal(state.stagePlan.routes.e2e.taskIntentDigest, digestValue(revisedIntent))
  assert.equal(state.taskIntentRevision, 2)

  const corrupted = structuredClone(state)
  corrupted.stagePlan.policyPins.agentCatalogDigest = "0".repeat(64)
  assert.throws(
    () => reduceTask(corrupted, {
      type: "stage-run.transitioned",
      expectedRevision: corrupted.revision,
      status: "dispatching",
      occurredAt: "2026-08-18T10:05:00.000Z",
    }),
    (error) => error.code === "STATE_INVALID",
  )
})

test("an Expert Owner is reviewed by a different Expert agent when the catalog permits", async () => {
  const workflowDefinition = await loadJson("workflow/definitions/engineering.json")
  const teamPolicy = await loadJson("team-work/policies/default.json")
  const agents = [
    { agentId: "junior-luna", tier: "junior", modelFamily: "luna", assignmentKinds: ["*"] },
    { agentId: "senior-terra", tier: "senior", modelFamily: "terra", assignmentKinds: ["*"] },
    { agentId: "expert-k3", tier: "expert", modelFamily: "k3", assignmentKinds: ["*"] },
    { agentId: "expert-opus", tier: "expert", modelFamily: "opus", assignmentKinds: ["*"] },
  ]
  const proposalBody = {
    proposalId: "proposal-critical-refactor",
    stageRunId: "stage-run-1",
    stage: "implementation",
    integrationRequired: false,
    workPackages: [{
      packageId: "critical-refactor",
      objective: "Implement the critical state transition",
      assignmentKind: "implementation",
      inputRefs: [],
      outputRefs: ["artifact:source"],
      completionCriteria: ["preserve the state invariants"],
      dependsOn: [],
    }],
  }
  const result = compilePolicyPlan({
    task: {
      taskId: "critical-refactor",
      currentStageRun: { stageRunId: "stage-run-1", stage: "implementation", round: 1 },
      scope: { stages: ["implementation"], edges: [], completionStages: ["implementation"] },
      costLedger: { accrued: 0, uncertain: 0 },
    },
    taskIntent: {
      objective: "Implement the critical state transition",
      constraints: [],
      exclusions: [],
      preferences: { execution: "solo", budget: "quality", risk: "critical" },
    },
    availableArtifacts: [artifact("requirement")],
    workflowDefinition,
    teamPolicy,
    agentCatalog: { digest: digestValue(agents), agents },
    proposal: { ...proposalBody, digest: digestValue(proposalBody) },
    routeInputs: {
      humanDecisionCapability: "verified-event",
      spec: { mode: "disabled", configDigest: digestValue({ mode: "disabled" }) },
      e2e: { mode: "auto", userRequired: false },
    },
  })

  const owner = result.plan.assignments.find(({ teamRole }) => teamRole === "owner")
  const expert = result.plan.assignments.find(({ teamRole }) => teamRole === "expert")
  assert.equal(owner.costTier, "expert")
  assert.notEqual(owner.assignmentId, expert.assignmentId)
  assert.notEqual(owner.execution.agentId, expert.execution.agentId)
  assert.equal(expert.writableRefs.length, 0)
})

test("explicit solo collapses proposal packages into one Owner without losing outputs", async () => {
  const workflowDefinition = await loadJson("workflow/definitions/engineering.json")
  const teamPolicy = await loadJson("team-work/policies/default.json")
  const proposalBody = {
    proposalId: "proposal-solo-design",
    stageRunId: "stage-run-1",
    stage: "design",
    integrationRequired: true,
    workPackages: [
      { packageId: "api", objective: "Design API", inputRefs: [], outputRefs: ["artifact:api-design"], completionCriteria: ["define API"], dependsOn: [] },
      { packageId: "storage", objective: "Design storage", inputRefs: [], outputRefs: ["artifact:storage-design"], completionCriteria: ["define storage"], dependsOn: [] },
    ],
  }
  const result = compilePolicyPlan({
    task: {
      taskId: "solo-design",
      currentStageRun: { stageRunId: "stage-run-1", stage: "design", round: 1 },
      scope: { stages: ["design"], edges: [], completionStages: ["design"] },
      costLedger: { accrued: 0, uncertain: 0 },
    },
    taskIntent: {
      objective: "Design the change with one accountable Owner",
      constraints: [], exclusions: [],
      preferences: { execution: "solo", budget: "quality", risk: "normal" },
    },
    availableArtifacts: [artifact("requirement")],
    workflowDefinition,
    teamPolicy,
    agentCatalog: agentCatalog(),
    proposal: { ...proposalBody, digest: digestValue(proposalBody) },
    routeInputs: {
      humanDecisionCapability: "verified-event",
      spec: { mode: "disabled", configDigest: digestValue({ mode: "disabled" }) },
      e2e: { mode: "auto", userRequired: false },
    },
  })
  const owners = result.plan.assignments.filter(({ teamRole, writableRefs }) => teamRole === "owner" && writableRefs.length > 0)
  assert.equal(result.summary.mode, "solo")
  assert.equal(owners.length, 1)
  assert.deepEqual(owners[0].writableRefs, ["artifact:api-design", "artifact:storage-design", "artifact:design"])
})

test("a workflow code review assesses E2E before selecting the outgoing branch", async () => {
  const workflowDefinition = await loadJson("workflow/definitions/engineering.json")
  const teamPolicy = await loadJson("team-work/policies/default.json")
  const result = compilePolicyPlan({
    task: {
      taskId: "review-before-e2e",
      currentStageRun: { stageRunId: "stage-run-1", stage: "code-review", round: 1 },
      scope: {
        stages: ["code-review", "e2e", "finish"],
        edges: [
          { from: "code-review", to: "e2e", outcome: "run-e2e" },
          { from: "code-review", to: "finish", outcome: "skip-e2e" },
          { from: "e2e", to: "finish", outcome: "pass" },
        ],
        completionStages: ["finish"],
      },
      costLedger: { accrued: 0, uncertain: 0 },
    },
    taskIntent: {
      objective: "Review and route the change",
      constraints: [], exclusions: [],
      preferences: { execution: "auto", budget: "quality", risk: "normal" },
    },
    availableArtifacts: [artifact("source"), artifact("review-scope")],
    workflowDefinition,
    teamPolicy,
    agentCatalog: agentCatalog(),
    routeInputs: {
      humanDecisionCapability: "verified-event",
      spec: { mode: "disabled", configDigest: digestValue({ mode: "disabled" }) },
      e2e: { mode: "auto", userRequired: false },
    },
  })
  assert.equal(result.kind, "route-assessment")
  assert.equal(result.plan, null)
  assert.equal(result.preflight.preflightKind, "route-assessment")
  assert.deepEqual(result.preflight.assignments.map(({ teamRole, assignmentKind }) => ({ teamRole, assignmentKind })), [
    { teamRole: "owner", assignmentKind: "e2e-applicability" },
    { teamRole: "challenger", assignmentKind: "review" },
    { teamRole: "owner", assignmentKind: "e2e-applicability" },
  ])
  assert.deepEqual(result.preflight.assignments[1].dependsOn, [result.preflight.assignments[0].assignmentId])
  assert.deepEqual(result.preflight.outputRefs, ["artifact:e2e-route-assessment"])
  assert.equal(result.preflight.costProjection.branchPathCount, 2)
})

test("completion cost follows Workflow team scenes instead of hard-coded stage ids", async () => {
  const workflowDefinition = await loadJson("workflow/definitions/engineering.json")
  const teamPolicy = await loadJson("team-work/policies/default.json")
  const renamed = structuredClone(workflowDefinition)
  renamed.stages = renamed.stages.map((stage) => stage.id === "finish" ? { ...stage, id: "wrap-up" } : stage)
  renamed.edges = renamed.edges.map((edge) => ({
    ...edge,
    from: edge.from === "finish" ? "wrap-up" : edge.from,
    to: edge.to === "finish" ? "wrap-up" : edge.to,
  }))
  renamed.terminalStages = ["wrap-up"]
  const result = compilePolicyPlan({
    task: {
      taskId: "custom-stage-cost",
      currentStageRun: { stageRunId: "stage-run-1", stage: "implementation", round: 1 },
      scope: {
        stages: ["implementation", "wrap-up"],
        edges: [{ from: "implementation", to: "wrap-up", outcome: "pass" }],
        completionStages: ["wrap-up"],
      },
      costLedger: { accrued: 0, uncertain: 0 },
    },
    taskIntent: {
      objective: "Implement and wrap up the change",
      constraints: [], exclusions: [],
      preferences: { execution: "auto", budget: "balanced", risk: "normal" },
    },
    availableArtifacts: [artifact("requirement")],
    workflowDefinition: renamed,
    teamPolicy,
    agentCatalog: agentCatalog(),
    routeInputs: {
      humanDecisionCapability: "verified-event",
      spec: { mode: "disabled", configDigest: digestValue({ mode: "disabled" }) },
      e2e: { mode: "auto", userRequired: false },
    },
  })

  assert.equal(result.costLedger.forecastMin, 24)
  assert.equal(result.plan.costProjection.branchPathCount, 1)
})
