import {
  DomainError,
  assertDigest,
  assertIdentifier,
  assertNonEmptyString,
  assertStringList,
  assertUniqueStrings,
} from "./invariants.mjs"

function reachableFrom(start, edges, stopStages = new Set()) {
  const reached = new Set([start])
  const queue = [start]
  while (queue.length > 0) {
    const current = queue.shift()
    if (stopStages.has(current)) continue
    for (const edge of edges) {
      if (edge.from === current && !reached.has(edge.to)) {
        reached.add(edge.to)
        queue.push(edge.to)
      }
    }
  }
  return reached
}

function canReach(targets, edges) {
  const reached = new Set(targets)
  const queue = [...targets]
  while (queue.length > 0) {
    const current = queue.shift()
    for (const edge of edges) {
      if (edge.to === current && !reached.has(edge.from)) {
        reached.add(edge.from)
        queue.push(edge.from)
      }
    }
  }
  return reached
}

export function projectStageScope(workflow, entryStage, completion) {
  if (!workflow || typeof workflow !== "object") {
    throw new DomainError("WORKFLOW_INVALID", "workflow must be an object")
  }
  assertNonEmptyString(workflow.workflowId, "workflow.workflowId")
  assertNonEmptyString(workflow.version, "workflow.version")
  assertDigest(workflow.digest, "workflow.digest")
  const stages = assertUniqueStrings(workflow.stages, "workflow.stages")
  const stageSet = new Set(stages)
  if (!stageSet.has(entryStage)) {
    throw new DomainError("ENTRY_INVALID", `entry stage ${entryStage} is not declared by the workflow`)
  }
  if (!Array.isArray(workflow.edges)) {
    throw new DomainError("WORKFLOW_INVALID", "workflow.edges must be an array")
  }
  const edges = workflow.edges.map((edge) => {
    if (!edge || typeof edge !== "object" || !stageSet.has(edge.from) || !stageSet.has(edge.to)) {
      throw new DomainError("WORKFLOW_INVALID", "every workflow edge must reference declared stages")
    }
    return { from: edge.from, to: edge.to, ...(edge.outcome ? { outcome: edge.outcome } : {}) }
  })

  let completionStages
  if (completion?.mode === "through-stage") {
    if (!stageSet.has(completion.stage)) {
      throw new DomainError("COMPLETION_INVALID", `completion stage ${completion.stage} is not declared by the workflow`)
    }
    completionStages = [completion.stage]
  } else if (completion?.mode === "workflow") {
    completionStages = assertUniqueStrings(workflow.terminalStages, "workflow.terminalStages")
    if (completionStages.some((stage) => !stageSet.has(stage))) {
      throw new DomainError("WORKFLOW_INVALID", "workflow terminal stages must be declared stages")
    }
  } else {
    throw new DomainError("COMPLETION_INVALID", "completion must use workflow or through-stage mode")
  }

  const forward = reachableFrom(entryStage, edges, new Set(completionStages))
  const backward = canReach(completionStages, edges)
  const included = stages.filter((stage) => forward.has(stage) && backward.has(stage))
  if (!completionStages.some((stage) => included.includes(stage))) {
    throw new DomainError("COMPLETION_UNREACHABLE", "completion cannot be reached from the entry stage")
  }

  const includedSet = new Set(included)
  return {
    entryStage,
    completion: structuredClone(completion),
    completionStages: completionStages.filter((stage) => includedSet.has(stage)),
    stages: included,
    edges: edges.filter((edge) => includedSet.has(edge.from) && includedSet.has(edge.to)),
  }
}

export function normalizeStagePlan(plan, currentStageRunId) {
  if (!plan || typeof plan !== "object") {
    throw new DomainError("STAGE_PLAN_INVALID", "stage plan must be an object")
  }
  assertIdentifier(plan.planId, "plan.planId")
  if (plan.stageRunId !== currentStageRunId) {
    throw new DomainError("STAGE_PLAN_STALE", "stage plan does not target the current stage run")
  }
  assertNonEmptyString(plan.objective, "plan.objective")
  assertStringList(plan.inputRefs, "plan.inputRefs")
  assertStringList(plan.outputRefs, "plan.outputRefs", { allowEmpty: false })
  if (!Array.isArray(plan.assignments) || plan.assignments.length === 0) {
    throw new DomainError("STAGE_PLAN_INVALID", "stage plan must contain at least one assignment")
  }
  return structuredClone(plan)
}
