import {
  DomainError,
  assertIdentifier,
  assertNonEmptyString,
  assertStringList,
} from "./invariants.mjs"
import { findParallelWriteConflict } from "./work-graph-rules.mjs"

const TEAM_ROLES = new Set(["owner", "challenger", "expert"])
const COST_TIERS = new Set(["junior", "senior", "expert"])
const ASSIGNMENT_KINDS = /^(?:planning|research|design|spec|implementation|integration|test|review|e2e|evidence|e2e-applicability|custom:[a-z0-9][a-z0-9._-]*)$/

function assertAcyclic(assignments) {
  const dependencies = new Map(assignments.map((assignment) => [assignment.assignmentId, new Set(assignment.dependsOn)]))
  const ready = [...dependencies].filter(([, refs]) => refs.size === 0).map(([id]) => id)
  let visited = 0
  while (ready.length > 0) {
    const current = ready.shift()
    visited += 1
    for (const [id, refs] of dependencies) {
      if (!refs.delete(current) || refs.size > 0) continue
      ready.push(id)
    }
  }
  if (visited !== assignments.length) {
    throw new DomainError("WORK_GRAPH_CYCLE", "assignment dependencies must be acyclic")
  }
}

function normalizeAssignment(assignment) {
  assertIdentifier(assignment?.assignmentId, "assignment.assignmentId")
  if (!TEAM_ROLES.has(assignment.teamRole)) {
    throw new DomainError("WORK_GRAPH_INVALID", `unsupported team role: ${assignment.teamRole}`)
  }
  if (typeof assignment.assignmentKind !== "string" || !ASSIGNMENT_KINDS.test(assignment.assignmentKind)) {
    throw new DomainError("WORK_GRAPH_INVALID", `unsupported assignment kind: ${assignment.assignmentKind}`)
  }
  if (!COST_TIERS.has(assignment.costTier)) {
    throw new DomainError("WORK_GRAPH_INVALID", `unsupported cost tier: ${assignment.costTier}`)
  }
  const dependsOn = assertStringList(assignment.dependsOn, "assignment.dependsOn")
  const readableRefs = assertStringList(assignment.readableRefs, "assignment.readableRefs")
  const writableRefs = assertStringList(assignment.writableRefs, "assignment.writableRefs")
  const completionCriteria = assertStringList(assignment.completionCriteria, "assignment.completionCriteria", { allowEmpty: false })
  if (assignment.teamRole !== "owner" && writableRefs.length > 0) {
    throw new DomainError("ROLE_WRITE_FORBIDDEN", `${assignment.teamRole} assignments cannot write product artifacts`)
  }
  completionCriteria.forEach((criterion, index) => assertNonEmptyString(criterion, `assignment.completionCriteria[${index}]`))
  const execution = {
    agentId: assertNonEmptyString(assignment.execution?.agentId, "assignment.execution.agentId"),
    capabilitySnapshotDigest: assertNonEmptyString(
      assignment.execution.capabilitySnapshotDigest,
      "assignment.execution.capabilitySnapshotDigest",
    ),
    contextRef: assertNonEmptyString(assignment.execution.contextRef, "assignment.execution.contextRef"),
    promptRef: assertNonEmptyString(assignment.execution.promptRef, "assignment.execution.promptRef"),
    ...(assignment.execution.resumeAssignmentId ? {
      resumeAssignmentId: assertIdentifier(assignment.execution.resumeAssignmentId, "assignment.execution.resumeAssignmentId"),
    } : {}),
  }
  return {
    assignmentId: assignment.assignmentId,
    teamRole: assignment.teamRole,
    assignmentKind: assignment.assignmentKind,
    costTier: assignment.costTier,
    dependsOn: [...dependsOn],
    readableRefs: [...readableRefs],
    writableRefs: [...writableRefs],
    completionCriteria: [...completionCriteria],
    execution,
    status: "planned",
    attempts: [],
  }
}

export function createWorkGraph(assignments) {
  const normalized = assignments.map(normalizeAssignment)
  const ids = new Set(normalized.map(({ assignmentId }) => assignmentId))
  const byId = new Map(normalized.map((assignment) => [assignment.assignmentId, assignment]))
  const dependsTransitivelyOn = (assignment, target, seen = new Set()) => assignment.dependsOn.some((dependency) => {
    if (dependency === target) return true
    if (seen.has(dependency)) return false
    seen.add(dependency)
    const parent = byId.get(dependency)
    return parent ? dependsTransitivelyOn(parent, target, seen) : false
  })
  if (ids.size !== normalized.length) {
    throw new DomainError("WORK_GRAPH_INVALID", "assignment ids must be unique")
  }
  for (const assignment of normalized) {
    if (assignment.dependsOn.includes(assignment.assignmentId) || assignment.dependsOn.some((id) => !ids.has(id))) {
      throw new DomainError("WORK_GRAPH_INVALID", `assignment ${assignment.assignmentId} has an invalid dependency`)
    }
    const resumeAssignmentId = assignment.execution.resumeAssignmentId
    if (resumeAssignmentId) {
      const source = normalized.find(({ assignmentId }) => assignmentId === resumeAssignmentId)
      if (
        !source
        || source.assignmentId === assignment.assignmentId
        || source.teamRole !== assignment.teamRole
        || source.execution.agentId !== assignment.execution.agentId
        || !dependsTransitivelyOn(assignment, source.assignmentId)
      ) {
        throw new DomainError("WORK_GRAPH_INVALID", `assignment ${assignment.assignmentId} has an invalid resume source`)
      }
    }
  }
  assertAcyclic(normalized)
  const conflict = findParallelWriteConflict(normalized)
  if (conflict) {
    throw new DomainError(
      "WORK_GRAPH_WRITE_CONFLICT",
      `parallel owners ${conflict.left} and ${conflict.right} share writable refs: ${conflict.sharedRefs.join(", ")}`,
    )
  }
  return { assignments: normalized }
}
