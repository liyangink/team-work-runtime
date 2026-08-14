export const TASK_TRANSITIONS = Object.freeze({
  active: ["awaiting-user", "completed", "cancelled"],
  "awaiting-user": ["active", "cancelled"],
  completed: [],
  cancelled: [],
})

export const WORK_ITEM_TRANSITIONS = Object.freeze({
  queued: ["running", "cancelled"],
  running: ["submitted", "blocked", "cancelled"],
  submitted: ["accepted", "rework"],
  rework: ["running", "cancelled"],
  blocked: ["running", "cancelled"],
  accepted: [],
  cancelled: [],
})

const issue = (path, message) => ({ path, message })
const stageOrder = (workflow) => new Map(workflow.stages.map(({ id }, index) => [id, index]))

export function validateWorkflowSemantics(workflow) {
  const issues = []
  const stageIds = workflow.stages.map(({ id }) => id)
  const stages = new Set(stageIds)
  const gateDeclarations = workflow.gates ?? []
  const gateIds = gateDeclarations.map(({ id }) => id)
  const gates = new Map(gateDeclarations.map((gate) => [gate.id, gate]))
  const terminals = new Set(workflow.stages.filter(({ terminal }) => terminal).map(({ id }) => id))
  const adjacency = new Map(stageIds.map((id) => [id, []]))

  for (const id of new Set(stageIds.filter((value, index) => stageIds.indexOf(value) !== index))) {
    issues.push(issue("stages", `duplicate stage: ${id}`))
  }
  for (const id of new Set(gateIds.filter((value, index) => gateIds.indexOf(value) !== index))) {
    issues.push(issue("gates", `duplicate gate: ${id}`))
  }
  gateDeclarations.forEach((gate, index) => {
    if (!stages.has(gate.stage)) issues.push(issue(`gates[${index}].stage`, `unknown gate stage: ${gate.stage}`))
  })
  if (!stages.has(workflow.initialStage)) issues.push(issue("initialStage", `unknown stage: ${workflow.initialStage}`))
  if (terminals.size === 0) issues.push(issue("stages", "at least one terminal stage is required"))

  const edgeKeys = new Set()
  for (const [index, edge] of workflow.transitions.entries()) {
    if (!stages.has(edge.from)) issues.push(issue(`transitions[${index}].from`, `unknown stage: ${edge.from}`))
    if (!stages.has(edge.to)) issues.push(issue(`transitions[${index}].to`, `unknown stage: ${edge.to}`))
    if (stages.has(edge.from) && stages.has(edge.to)) adjacency.get(edge.from).push(edge.to)
    const key = `${edge.from}:${edge.outcome}`
    if (edgeKeys.has(key)) issues.push(issue(`transitions[${index}]`, `duplicate transition: ${key}`))
    edgeKeys.add(key)
    if (terminals.has(edge.from)) issues.push(issue(`transitions[${index}].from`, `terminal stage has outgoing transition: ${edge.from}`))
    if (edge.requiredGate && !gates.has(edge.requiredGate)) issues.push(issue(`transitions[${index}].requiredGate`, `unknown required gate: ${edge.requiredGate}`))
    if (edge.requiredGate && gates.has(edge.requiredGate) && gates.get(edge.requiredGate).stage !== edge.from) {
      issues.push(issue(`transitions[${index}].requiredGate`, `required gate ${edge.requiredGate} belongs to ${gates.get(edge.requiredGate).stage}, not ${edge.from}`))
    }
  }

  function reachesTerminal(start, visiting = new Set()) {
    if (terminals.has(start)) return true
    if (visiting.has(start)) return false
    const next = new Set(visiting)
    next.add(start)
    return (adjacency.get(start) ?? []).some((target) => reachesTerminal(target, next))
  }

  for (const id of stageIds) {
    if (!terminals.has(id) && (adjacency.get(id)?.length ?? 0) === 0) issues.push(issue(`stages.${id}`, "non-terminal stage has no outgoing transition"))
    if (!reachesTerminal(id)) issues.push(issue(`stages.${id}`, "stage cannot reach a terminal stage"))
  }
  return issues
}

export function validateTaskAgainstWorkflow(task, workflow, { loadedWorkflowDigest, workItems, gateModes = {} } = {}) {
  const order = stageOrder(workflow)
  const stages = new Set(order.keys())
  const declaredGates = new Map((workflow.gates ?? []).map((gate) => [gate.id, gate]))
  const issues = []
  if (!stages.has(task.entryStage)) issues.push(issue("entryStage", `unknown stage: ${task.entryStage}`))
  if (!stages.has(task.stage)) issues.push(issue("stage", `unknown stage: ${task.stage}`))
  if (task.workflow.id !== workflow.workflowId || task.workflow.version !== workflow.version) issues.push(issue("workflow", "task workflow pin does not match loaded workflow"))
  if (loadedWorkflowDigest && task.workflow.digest !== loadedWorkflowDigest) issues.push(issue("workflow.digest", "loaded workflow digest does not match task pin"))

  const evidenceById = new Map(task.evidence.map((entry) => [entry.evidenceId, entry]))
  const validEvidence = (ref) => evidenceById.get(ref)?.status === "valid"

  if (task.status === "completed") {
    if (!workflow.stages.find(({ id }) => id === task.stage)?.terminal) issues.push(issue("status", "completed task must be at a terminal stage"))
    if (!workItems) issues.push(issue("status", "completed task validation requires work-items document"))
    else {
      if (workItems.taskId !== task.taskId) issues.push(issue("status", "work-items document belongs to another task"))
      for (const workItemIssue of validateWorkItemsSemantics(workItems)) {
        issues.push(issue(`workItems.${workItemIssue.path}`, workItemIssue.message))
      }
      if (workItems.items.some(({ status }) => !["accepted", "cancelled"].includes(status))) issues.push(issue("status", "completed task has unfinished work items"))
      workItems.items.forEach((item, index) => {
        if (!stages.has(item.stage)) issues.push(issue(`workItems.items[${index}].stage`, `unknown stage: ${item.stage}`))
        if (item.status !== "accepted") return
        if (!item.submission || item.acceptance?.decision !== "accepted") {
          issues.push(issue(`workItems.items[${index}]`, "accepted work item requires submission and Lead acceptance"))
        }
        if (!item.acceptance?.evidenceRefs?.length || item.acceptance.evidenceRefs.some((ref) => !validEvidence(ref))) {
          issues.push(issue(`workItems.items[${index}].acceptance.evidenceRefs`, "accepted work item requires valid task evidence"))
        }
      })
    }
    if (!task.acceptance?.evidenceRefs?.length) issues.push(issue("acceptance.evidenceRefs", "completed task requires acceptance evidence"))
    for (const declaration of (workflow.gates ?? []).filter(({ stage }) => stage === task.stage)) {
      const mode = declaration.kind === "human" ? (gateModes[declaration.id] ?? declaration.defaultMode) : declaration.defaultMode
      if (mode === "disabled") continue
      const gate = task.gates.find(({ gateId, stage }) => gateId === declaration.id && stage === declaration.stage)
      if (mode === "optional" && !gate) continue
      const acceptedStatuses = declaration.kind === "human" ? ["passed"] : ["passed", "overridden"]
      if (!gate || gate.kind !== declaration.kind || !acceptedStatuses.includes(gate.status)) {
        issues.push(issue("gates", `completed task requires passed gate: ${declaration.id}`))
      }
    }
  }

  for (const [field, values, key] of [["gates", task.gates, "gateId"], ["evidence", task.evidence, "evidenceId"]]) {
    const ids = values.map((value) => value[key])
    for (const id of new Set(ids.filter((value, index) => ids.indexOf(value) !== index))) issues.push(issue(field, `duplicate ${key}: ${id}`))
    values.forEach((value, index) => {
      if (!stages.has(value.stage)) issues.push(issue(`${field}[${index}].stage`, `unknown stage: ${value.stage}`))
    })
  }
  task.evidence.forEach((evidence, evidenceIndex) => {
    if ((order.get(evidence.stage) ?? Infinity) > (order.get(task.stage) ?? -1) && evidence.status === "valid") {
      issues.push(issue(`evidence[${evidenceIndex}].stage`, "future-stage evidence must be invalidated"))
    }
  })
  task.gates.forEach((gate, gateIndex) => {
    const declaration = declaredGates.get(gate.gateId)
    if (gate.kind === "human") {
      if (!declaration || declaration.kind !== "human") {
        issues.push(issue(`gates[${gateIndex}].gateId`, `human gate must match a declared workflow human gate: ${gate.gateId}`))
      }
      if (!["pending", "passed", "rejected"].includes(gate.status)) {
        issues.push(issue(`gates[${gateIndex}].status`, "human gate status must be pending, passed, or rejected"))
      }
      if (["passed", "rejected"].includes(gate.status) && gate.decision?.decidedBy !== "user") {
        issues.push(issue(`gates[${gateIndex}].decision.decidedBy`, "human gate decision must be made by user"))
      }
    }
    if (declaration && (gate.kind !== declaration.kind || gate.stage !== declaration.stage)) {
      issues.push(issue(`gates[${gateIndex}]`, `gate must match workflow declaration: ${gate.gateId}`))
    }
    if ((order.get(gate.stage) ?? Infinity) > (order.get(task.stage) ?? -1) && gate.status !== "pending") {
      issues.push(issue(`gates[${gateIndex}].stage`, "future-stage gate must remain pending"))
    }
    gate.evidenceRefs.forEach((ref) => {
      const evidence = evidenceById.get(ref)
      if (!evidence) issues.push(issue(`gates[${gateIndex}].evidenceRefs`, `unknown evidence: ${ref}`))
      else if (evidence.status !== "valid") issues.push(issue(`gates[${gateIndex}].evidenceRefs`, `invalidated evidence: ${ref}`))
      else if ((order.get(evidence.stage) ?? Infinity) > (order.get(gate.stage) ?? -1)) issues.push(issue(`gates[${gateIndex}].evidenceRefs`, `future-stage evidence: ${ref}`))
    })
  })
  for (const ref of task.acceptance?.evidenceRefs ?? []) {
    const evidence = evidenceById.get(ref)
    if (!evidence) issues.push(issue("acceptance.evidenceRefs", `unknown evidence: ${ref}`))
    else if (evidence.status !== "valid") issues.push(issue("acceptance.evidenceRefs", `invalidated evidence: ${ref}`))
  }
  if (task.awaitingUser?.gateRef && !task.gates.some(({ gateId }) => gateId === task.awaitingUser.gateRef)) issues.push(issue("awaitingUser.gateRef", "unknown gate"))
  return issues
}

export function evaluateStageGate(workflow, stageId, contextEntries, taskGates = []) {
  const stage = workflow.stages.find(({ id }) => id === stageId)
  if (!stage) return { ok: false, blockers: [{ code: "UNKNOWN_STAGE", kind: "stage", path: stageId, message: "Stage is not declared" }], warnings: [] }
  const counts = new Map()
  contextEntries.forEach(({ kind }) => counts.set(kind, (counts.get(kind) ?? 0) + 1))
  const blockers = stage.requiredInputs
    .filter(({ kind, minCount }) => (counts.get(kind) ?? 0) < minCount)
    .map(({ kind, minCount }) => ({ code: "MISSING_INPUT", kind, path: stageId, message: `Missing required ${kind}`, expected: minCount, actual: counts.get(kind) ?? 0 }))
  for (const gate of taskGates.filter(({ stage: gateStage }) => gateStage === stageId)) {
    if (["pending", "blocked"].includes(gate.status)) blockers.push({ code: "GATE_NOT_PASSED", kind: gate.kind, path: gate.gateId, message: gate.blocker ?? "Gate is not passed" })
  }
  return { ok: blockers.length === 0, blockers, warnings: [] }
}

export function validateWorkItemsSemantics(document) {
  const issues = []
  const ids = document.items.map(({ workItemId }) => workItemId)
  const known = new Set(ids)
  const dependencies = new Map(document.items.map((item) => [item.workItemId, item.assignment.dependencies]))
  for (const id of new Set(ids.filter((value, index) => ids.indexOf(value) !== index))) issues.push(issue("items", `duplicate work item: ${id}`))
  for (const [index, item] of document.items.entries()) {
    if (item.taskId !== document.taskId) issues.push(issue(`items[${index}].taskId`, "does not match document taskId"))
    const historyAttempts = item.attemptHistory.map(({ attempt }) => attempt)
    if (new Set(historyAttempts).size !== historyAttempts.length) issues.push(issue(`items[${index}].attemptHistory`, "duplicate attempt history"))
    if (historyAttempts.some((attempt) => attempt >= item.attempt)) issues.push(issue(`items[${index}].attemptHistory`, "historical attempt must be lower than current attempt"))
    const expectedHistory = Array.from({ length: item.attempt - 1 }, (_, attemptIndex) => attemptIndex + 1)
    if (JSON.stringify([...historyAttempts].sort((a, b) => a - b)) !== JSON.stringify(expectedHistory)) {
      issues.push(issue(`items[${index}].attemptHistory`, "attempt history must contain every prior attempt exactly once"))
    }
    if (item.attemptHistory.some(({ acceptance, blockage }) => acceptance ? acceptance.decision !== "rework" : !blockage)) {
      issues.push(issue(`items[${index}].attemptHistory`, "every historical attempt must end in rework or infrastructure blockage"))
    }
    for (const dependency of item.assignment.dependencies) {
      if (!known.has(dependency)) issues.push(issue(`items[${index}].assignment.dependencies`, `unknown dependency: ${dependency}`))
      if (dependency === item.workItemId) issues.push(issue(`items[${index}].assignment.dependencies`, "self dependency is not allowed"))
    }
  }
  function hasCycle(id, visiting = new Set(), visited = new Set()) {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    const nextVisiting = new Set(visiting)
    nextVisiting.add(id)
    const nextVisited = new Set(visited)
    nextVisited.add(id)
    return (dependencies.get(id) ?? []).filter((dependency) => known.has(dependency)).some((dependency) => hasCycle(dependency, nextVisiting, nextVisited))
  }
  if (ids.some((id) => hasCycle(id))) issues.push(issue("items", "dependency cycle is not allowed"))
  return issues
}

export function planRollback(task, workflow, targetStage, { reason, evidenceRefs } = {}) {
  const issues = []
  if (task.status !== "active") issues.push(issue("status", "rollback requires active task"))
  if (!rollbackTargetIsEarlier(workflow, task.stage, targetStage)) issues.push(issue("targetStage", "rollback target must be an earlier stage"))
  if (!reason?.trim()) issues.push(issue("reason", "rollback reason is required"))
  if (!evidenceRefs?.length) issues.push(issue("evidenceRefs", "rollback evidence is required"))
  const validEvidence = new Set(task.evidence.filter(({ status }) => status === "valid").map(({ evidenceId }) => evidenceId))
  for (const ref of evidenceRefs ?? []) if (!validEvidence.has(ref)) issues.push(issue("evidenceRefs", `unknown or invalid evidence: ${ref}`))
  const order = stageOrder(workflow)
  const targetIndex = order.get(targetStage) ?? Infinity
  return {
    issues,
    gateIdsToReset: task.gates.filter(({ stage }) => (order.get(stage) ?? -1) > targetIndex).map(({ gateId }) => gateId),
    evidenceIdsToInvalidate: task.evidence.filter(({ stage, status }) => status === "valid" && (order.get(stage) ?? -1) > targetIndex).map(({ evidenceId }) => evidenceId),
  }
}

export function resolveActiveTask({ explicitTaskId, bindingTaskId, tasks }) {
  const eligible = tasks.filter(({ status, archived = false }) => !archived && ["active", "awaiting-user"].includes(status))
  const byId = new Map(eligible.map((task) => [task.taskId, task]))
  if (explicitTaskId) return byId.has(explicitTaskId) ? { taskId: explicitTaskId } : { errorCode: "TASK_NOT_FOUND" }
  if (bindingTaskId && byId.has(bindingTaskId)) return { taskId: bindingTaskId }
  if (eligible.length === 1) return { taskId: eligible[0].taskId }
  if (eligible.length > 1) return { errorCode: "TASK_AMBIGUOUS" }
  return { errorCode: "TASK_NOT_FOUND" }
}

export function validatePlatformProfileSemantics(profile) {
  const issues = []
  const ids = profile.agents.map(({ id }) => id)
  for (const id of new Set(ids.filter((value, index) => ids.indexOf(value) !== index))) {
    issues.push(issue("agents", `duplicate agent id: ${id}`))
  }
  const helpers = profile.helpers ?? []
  const helperIds = helpers.map(({ id }) => id)
  for (const id of new Set(helperIds.filter((value, index) => helperIds.indexOf(value) !== index))) {
    issues.push(issue("helpers", `duplicate helper id: ${id}`))
  }
  const expectedKinds = { "team-work-explore": "explore", "team-work-librarian": "librarian" }
  for (const helper of helpers) {
    if (expectedKinds[helper.id] && expectedKinds[helper.id] !== helper.kind) {
      issues.push(issue("helpers", `helper id/kind mismatch: ${helper.id} must use ${expectedKinds[helper.id]}`))
    }
  }
  return issues
}

export function canTransitionTask(from, to) {
  return TASK_TRANSITIONS[from]?.includes(to) ?? false
}

export function canTransitionWorkItem(from, to) {
  return WORK_ITEM_TRANSITIONS[from]?.includes(to) ?? false
}

export function rollbackTargetIsEarlier(workflow, from, to) {
  const order = workflow.stages.map(({ id }) => id)
  return order.indexOf(to) >= 0 && order.indexOf(from) > order.indexOf(to)
}
