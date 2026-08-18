import { compileHumanGateRequirements } from "./human-wait.mjs"
import { validateContract } from "../contracts.mjs"
import { compileWorkflowStage, compileSpecRoute, compileE2ERoute } from "../../workflow/compiler.mjs"
import { compileTeamPlan } from "../../team-work/compiler.mjs"
import { digestValue } from "../../policy/kernel.mjs"

export function compilePolicyPlan(input) {
  validateContract("https://team-work-runtime.dev/schemas/v2/workflow-policy", input.workflowDefinition, "workflow policy")
  validateContract("https://team-work-runtime.dev/schemas/v2/team-policy", input.teamPolicy, "team policy")
  validateContract("https://team-work-runtime.dev/schemas/v2/agent-catalog", input.agentCatalog, "agent catalog")
  if (input.proposal) {
    validateContract("https://team-work-runtime.dev/schemas/v2/stage-plan-proposal", input.proposal, "stage plan proposal")
  }
  const taskIntent = input.taskIntent ?? input.task?.taskIntent
  const availableArtifacts = input.availableArtifacts ?? []
  const artifactSnapshotDigest = digestValue(availableArtifacts.map(({ kind, ref, digest }) => ({ kind, ref, digest })))
  const declaredGateIds = new Set(input.workflowDefinition.gates.map(({ gateId }) => gateId))
  const unknownHumanGate = Object.keys(input.routeInputs?.humanReview ?? {}).find((gateId) => !declaredGateIds.has(gateId))
  if (unknownHumanGate) {
    const error = new Error(`unknown human gate override: ${unknownHumanGate}`)
    error.code = "HUMAN_GATE_UNKNOWN"
    throw error
  }
  const humanGates = compileHumanGateRequirements({
    gates: input.workflowDefinition.gates.map((gate) => ({
      gateId: gate.gateId,
      stage: gate.stage,
      artifactKind: gate.artifactKind,
      requirement: input.routeInputs?.humanReview?.[gate.gateId] ?? gate.requirement,
    })),
    capabilitySnapshot: { features: { humanDecisionProof: input.routeInputs?.humanDecisionCapability } },
  })
  const routes = {
    humanGates,
    spec: compileSpecRoute(input.routeInputs.spec),
    e2e: compileE2ERoute({
      ...input.routeInputs.e2e,
      taskId: input.task.taskId,
      stageRunId: input.task.currentStageRun.stageRunId,
      taskIntentDigest: digestValue(taskIntent),
      artifactSnapshotDigest,
    }),
  }
  let workflowDraft = compileWorkflowStage({
    definition: input.workflowDefinition,
    task: input.task,
    taskIntent,
    availableArtifacts,
    proposal: input.proposal,
  })
  workflowDraft = { ...workflowDraft, routes }
  if (workflowDraft.stage.route === "spec" && routes.spec.decision !== "use-provider") {
    return { kind: routes.spec.decision === "skip" ? "route-skip" : "route-blocked", routes, plan: null }
  }
  const e2eInScope = input.task.scope?.stages?.includes("e2e") === true
  const needsE2EAssessment = workflowDraft.stage.route === "e2e"
    && routes.e2e.kind === "assessment-required"
    && (workflowDraft.stage.id === "e2e" || e2eInScope)
  if (workflowDraft.stage.route === "e2e" && workflowDraft.stage.id === "e2e") {
    if (!needsE2EAssessment && routes.e2e.decision !== "run") {
      return { kind: routes.e2e.decision === "skip" ? "route-skip" : "route-blocked", routes, plan: null }
    } else if (!needsE2EAssessment) {
      workflowDraft = { ...workflowDraft, planningRequired: false }
    }
  }
  if (needsE2EAssessment) {
    workflowDraft = {
      ...workflowDraft,
      stage: { ...workflowDraft.stage, teamScene: "e2e-applicability", assignmentKind: "e2e-applicability" },
      planningRequired: false,
      work: {
        packages: [{
          packageId: "e2e-applicability",
          objective: "Assess E2E applicability and environment readiness with evidence",
          assignmentKind: "e2e-applicability",
          inputRefs: workflowDraft.inputRefs,
          outputRefs: ["artifact:e2e-route-assessment"],
          completionCriteria: [
            "record applicability, critical cross-system paths, and environment status",
            "cite evidence for every run, skip, or block conclusion",
          ],
          dependsOn: [],
        }],
        integrationRequired: false,
      },
      outputRefs: ["artifact:e2e-route-assessment"],
    }
  }
  const compiled = compileTeamPlan({
    task: input.task,
    workflowDraft,
    teamPolicy: input.teamPolicy,
    agentCatalog: input.agentCatalog,
  })
  const compiledPlan = {
    ...compiled.plan,
    basis: input.task.preflight?.status === "satisfied" ? {
      kind: "preflight",
      preflightId: input.task.preflight.preflightId,
      resultRef: input.task.preflight.result.ref,
      resultDigest: input.task.preflight.result.digest,
    } : { kind: "deterministic" },
    policyPins: compiled.policyPins,
    routes,
    convergence: compiled.convergence,
    costProjection: compiled.costProjection,
    teamMode: compiled.summary.mode,
  }
  const preflightKind = needsE2EAssessment ? "route-assessment"
    : workflowDraft.planningRequired ? "planning-bootstrap"
      : null
  if (preflightKind) {
    return {
      ...compiled,
      kind: compiled.kind === "budget-decision" ? "budget-decision" : preflightKind,
      plan: null,
      preflight: { ...compiledPlan, preflightKind },
      routes,
    }
  }
  return {
    ...compiled,
    plan: compiledPlan,
    routes,
  }
}
