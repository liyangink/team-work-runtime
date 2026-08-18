import { digestValue, PolicyError } from "../policy/kernel.mjs"

function fail(code, message, details = []) {
  throw new PolicyError(code, message, details)
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry === "") || new Set(value).size !== value.length) {
    fail("POLICY_INVALID", `${label} must contain unique non-empty strings`)
  }
  return value
}

function normalizeIntent(intent) {
  if (!intent || typeof intent.objective !== "string" || intent.objective.trim() === "") {
    fail("TASK_INTENT_INVALID", "task intent requires an objective")
  }
  const preferences = intent.preferences ?? {}
  const execution = preferences.execution ?? "auto"
  const budget = preferences.budget ?? "balanced"
  const risk = preferences.risk ?? "normal"
  if (!["auto", "solo", "team"].includes(execution)) fail("TASK_INTENT_INVALID", "execution preference is invalid")
  if (!["economy", "balanced", "quality"].includes(budget)) fail("TASK_INTENT_INVALID", "budget preference is invalid")
  if (!["normal", "high", "critical"].includes(risk)) fail("TASK_INTENT_INVALID", "risk preference is invalid")
  return {
    objective: intent.objective,
    constraints: [...assertStringArray(intent.constraints ?? [], "taskIntent.constraints")],
    exclusions: [...assertStringArray(intent.exclusions ?? [], "taskIntent.exclusions")],
    preferences: { execution, budget, risk },
  }
}

export function validateWorkflowDefinition(definition) {
  if (!definition || definition.schemaVersion !== "2.0" || typeof definition.workflowId !== "string" || typeof definition.version !== "string") {
    fail("WORKFLOW_POLICY_INVALID", "workflow definition identity is invalid")
  }
  if (!Array.isArray(definition.stages) || definition.stages.length === 0) fail("WORKFLOW_POLICY_INVALID", "workflow stages are required")
  const stageIds = definition.stages.map((stage) => stage.id)
  if (stageIds.some((id) => typeof id !== "string" || id === "") || new Set(stageIds).size !== stageIds.length) {
    fail("WORKFLOW_POLICY_INVALID", "workflow stage ids must be unique")
  }
  const stageSet = new Set(stageIds)
  for (const stage of definition.stages) {
    assertStringArray(stage.requiredInputs, `stage ${stage.id} requiredInputs`)
    assertStringArray(stage.outputs, `stage ${stage.id} outputs`)
    if (!["conditional", "required"].includes(stage.planning)) fail("WORKFLOW_POLICY_INVALID", `stage ${stage.id} planning rule is invalid`)
  }
  if (!Array.isArray(definition.edges) || definition.edges.some((edge) => !stageSet.has(edge.from) || !stageSet.has(edge.to))) {
    fail("WORKFLOW_POLICY_INVALID", "workflow edges must reference declared stages")
  }
  if (!Array.isArray(definition.terminalStages) || definition.terminalStages.some((stage) => !stageSet.has(stage))) {
    fail("WORKFLOW_POLICY_INVALID", "workflow terminal stages are invalid")
  }
  return {
    definition: structuredClone(definition),
    pin: {
      workflowId: definition.workflowId,
      version: definition.version,
      digest: digestValue(definition),
    },
  }
}

function normalizeProposal(proposal, stageRunId, stage, requiredInputRefs, requiredOutputRefs) {
  if (!proposal || proposal.stageRunId !== stageRunId || proposal.stage !== stage.id || !Array.isArray(proposal.workPackages) || proposal.workPackages.length === 0) {
    fail("STAGE_PLAN_PROPOSAL_INVALID", "proposal must target the current stage run and contain work packages")
  }
  if (typeof proposal.digest !== "string" || proposal.digest !== digestValue({ ...proposal, digest: undefined })) {
    fail("STAGE_PLAN_PROPOSAL_INVALID", "proposal digest does not match its content")
  }
  const packageIds = proposal.workPackages.map((entry) => entry.packageId)
  if (packageIds.some((id) => typeof id !== "string" || id === "") || new Set(packageIds).size !== packageIds.length) {
    fail("STAGE_PLAN_PROPOSAL_INVALID", "proposal package ids must be unique")
  }
  const packageSet = new Set(packageIds)
  const packages = proposal.workPackages.map((workPackage) => {
    const dependsOn = assertStringArray(workPackage.dependsOn ?? [], `package ${workPackage.packageId} dependsOn`)
    if (dependsOn.some((id) => id === workPackage.packageId || !packageSet.has(id))) {
      fail("STAGE_PLAN_PROPOSAL_INVALID", `package ${workPackage.packageId} has an invalid dependency`)
    }
    return {
      packageId: workPackage.packageId,
      objective: workPackage.objective,
      assignmentKind: workPackage.assignmentKind ?? stage.assignmentKind,
      inputRefs: [...new Set([...requiredInputRefs, ...assertStringArray(workPackage.inputRefs ?? [], `package ${workPackage.packageId} inputRefs`)])],
      outputRefs: [...assertStringArray(workPackage.outputRefs, `package ${workPackage.packageId} outputRefs`)],
      completionCriteria: [...assertStringArray(workPackage.completionCriteria, `package ${workPackage.packageId} completionCriteria`)],
      dependsOn: [...dependsOn],
    }
  })
  const pending = new Map(packages.map((entry) => [entry.packageId, new Set(entry.dependsOn)]))
  const ready = [...pending].filter(([, dependencies]) => dependencies.size === 0).map(([id]) => id)
  let visited = 0
  while (ready.length > 0) {
    const current = ready.shift()
    visited += 1
    for (const [id, dependencies] of pending) {
      if (dependencies.delete(current) && dependencies.size === 0) ready.push(id)
    }
  }
  if (visited !== packages.length) fail("STAGE_PLAN_PROPOSAL_INVALID", "proposal work packages must be acyclic")
  if (packages.some((entry) => typeof entry.objective !== "string" || entry.objective.trim() === "" || entry.outputRefs.length === 0 || entry.completionCriteria.length === 0)) {
    fail("STAGE_PLAN_PROPOSAL_INVALID", "every package needs an objective, output, and completion criteria")
  }
  if (packages.length > 1 && typeof proposal.integrationRequired !== "boolean") {
    fail("STAGE_PLAN_PROPOSAL_INVALID", "multi-package proposals must decide whether integration is required")
  }
  const packageOutputs = new Set(packages.flatMap(({ outputRefs }) => outputRefs))
  if (!proposal.integrationRequired && requiredOutputRefs.some((ref) => !packageOutputs.has(ref))) {
    fail("STAGE_PLAN_PROPOSAL_INVALID", "a non-integrated proposal must directly produce every stage output")
  }
  return { packages, integrationRequired: proposal.integrationRequired ?? false, proposalDigest: digestValue(proposal) }
}

export function compileWorkflowStage({ definition, task, taskIntent, availableArtifacts = [], proposal }) {
  const validated = validateWorkflowDefinition(definition)
  if (task?.workflow && (
    task.workflow.workflowId !== validated.pin.workflowId
    || task.workflow.version !== validated.pin.version
    || task.workflow.digest !== validated.pin.digest
  )) fail("WORKFLOW_PIN_MISMATCH", "task workflow pin does not match the supplied definition")
  const intent = normalizeIntent(taskIntent)
  const stage = definition.stages.find((entry) => entry.id === task?.currentStageRun?.stage)
  if (!stage) fail("WORKFLOW_STAGE_UNKNOWN", "current stage is not declared by the workflow")
  if (availableArtifacts.some((artifact) => !/^[a-f0-9]{64}$/.test(artifact.digest ?? ""))) {
    fail("WORKFLOW_ARTIFACT_INVALID", "available artifacts require Runtime-verified content digests")
  }
  const refsByKind = new Map(availableArtifacts.map((artifact) => [artifact.kind, artifact.ref]))
  const missing = stage.requiredInputs.filter((kind) => !refsByKind.has(kind))
  if (missing.length > 0) fail("WORKFLOW_INPUT_MISSING", `current stage is missing required inputs: ${missing.join(", ")}`, missing)
  const inputRefs = [...new Set([...stage.requiredInputs.map((kind) => refsByKind.get(kind)), ...availableArtifacts.map(({ ref }) => ref)])]
  const outputRefs = stage.outputs.map((kind) => `artifact:${kind}`)
  const planningReasons = []
  if (stage.planning === "required") planningReasons.push("stage-requires-technical-planning")
  if (intent.preferences.execution === "team") planningReasons.push("team-execution-requested")
  if (["high", "critical"].includes(intent.preferences.risk)) planningReasons.push(`${intent.preferences.risk}-risk`)

  let work
  if (proposal) {
    work = normalizeProposal(proposal, task.currentStageRun.stageRunId, stage, inputRefs, outputRefs)
  } else if (planningReasons.length === 0) {
    work = {
      packages: [{
        packageId: `${stage.id}-delivery`,
        objective: intent.objective,
        assignmentKind: stage.assignmentKind,
        inputRefs,
        outputRefs,
        completionCriteria: [`produce ${stage.outputs.join(", ")}`, "submit evidence and unresolved risks"],
        dependsOn: [],
      }],
      integrationRequired: false,
    }
  }

  return Object.freeze({
    workflowPin: validated.pin,
    stagePolicies: Object.fromEntries(definition.stages.map(({ id, teamScene, route }) => [id, { teamScene, ...(route ? { route } : {}) }])),
    stage: structuredClone(stage),
    intent,
    inputRefs,
    outputRefs,
    planningRequired: !work,
    planningReasons,
    work,
  })
}

export function compileSpecRoute({ mode, configDigest, probe }) {
  if (!["auto", "required", "disabled"].includes(mode) || !/^[a-f0-9]{64}$/.test(configDigest ?? "")) {
    fail("SPEC_ROUTE_INVALID", "SPEC route mode and config digest are required")
  }
  let decision
  let reason
  if (mode === "disabled") {
    decision = "skip"
    reason = "disabled-by-project"
  } else {
    if (!probe || !["ready", "missing"].includes(probe.status) || !/^[a-f0-9]{64}$/.test(probe.digest ?? "")) {
      fail("SPEC_ROUTE_INVALID", "enabled SPEC routing requires a normalized probe")
    }
    decision = probe.status === "ready" ? "use-provider" : mode === "auto" ? "skip" : "block"
    reason = probe.status === "ready" ? "provider-ready" : mode === "auto" ? "provider-missing-optional" : "required-provider-missing"
  }
  const route = { mode, configDigest, probeDigest: probe?.digest ?? null, decision, reason }
  return Object.freeze({ ...route, digest: digestValue(route) })
}

export function compileE2ERoute({ mode, userRequired = false, assessment, taskId, stageRunId, taskIntentDigest, artifactSnapshotDigest }) {
  if (
    !["auto", "required", "disabled"].includes(mode)
    || typeof userRequired !== "boolean"
    || !/^[a-f0-9]{64}$/.test(taskIntentDigest ?? "")
    || !/^[a-f0-9]{64}$/.test(artifactSnapshotDigest ?? "")
  ) {
    fail("E2E_ROUTE_INVALID", "E2E route mode is invalid")
  }
  if (!assessment) return Object.freeze({ kind: "assessment-required", mode, userRequired, taskIntentDigest, artifactSnapshotDigest })
  if (
    typeof assessment.digest !== "string"
    || assessment.digest !== digestValue({ ...assessment, digest: undefined })
    || typeof assessment.applicable !== "boolean"
    || typeof assessment.criticalCrossSystemPath !== "boolean"
    || !["ready", "missing", "unknown"].includes(assessment.environment)
    || !Array.isArray(assessment.evidenceRefs)
    || assessment.evidenceRefs.length === 0
    || new Set(assessment.evidenceRefs).size !== assessment.evidenceRefs.length
    || assessment.artifactSnapshotDigest !== artifactSnapshotDigest
    || !/^[a-f0-9]{64}$/.test(assessment.evidenceSnapshotDigest ?? "")
    || typeof assessment.ownerAssignmentId !== "string"
    || typeof assessment.challengerAssignmentId !== "string"
    || assessment.ownerAssignmentId === assessment.challengerAssignmentId
    || !/^[a-f0-9]{64}$/.test(assessment.ownerSessionDigest ?? "")
    || !/^[a-f0-9]{64}$/.test(assessment.challengerSessionDigest ?? "")
    || assessment.ownerSessionDigest === assessment.challengerSessionDigest
    || typeof assessment.ownerReportRef !== "string"
    || typeof assessment.challengerReportRef !== "string"
    || assessment.ownerReportRef === assessment.challengerReportRef
    || (taskId && assessment.taskId !== taskId)
    || (stageRunId && assessment.stageRunId !== stageRunId)
  ) {
    fail("E2E_ROUTE_INVALID", "E2E assessment must be evidence-backed and independently challenged")
  }
  const required = mode === "required" || userRequired || assessment.criticalCrossSystemPath || assessment.applicable
  let decision
  let reason
  if (mode === "disabled") {
    decision = required ? "block" : "skip"
    reason = required ? "disabled-conflicts-with-required-e2e" : "disabled-by-project"
  } else if (!required) {
    decision = "skip"
    reason = "assessment-not-applicable"
  } else if (assessment.environment === "ready") {
    decision = "run"
    reason = "required-and-environment-ready"
  } else {
    decision = "block"
    reason = "e2e-environment-unavailable"
  }
  const route = {
    mode,
    userRequired,
    taskIntentDigest,
    artifactSnapshotDigest,
    assessmentDigest: assessment.digest,
    decision,
    evidenceRefs: [...assessment.evidenceRefs],
    reason,
  }
  return Object.freeze({ ...route, digest: digestValue(route) })
}
