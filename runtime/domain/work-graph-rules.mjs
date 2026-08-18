function dependsTransitively(assignmentsById, assignmentId, dependencyId) {
  const pending = [...(assignmentsById.get(assignmentId)?.dependsOn ?? [])]
  const visited = new Set()
  while (pending.length > 0) {
    const current = pending.shift()
    if (current === dependencyId) return true
    if (visited.has(current)) continue
    visited.add(current)
    pending.push(...(assignmentsById.get(current)?.dependsOn ?? []))
  }
  return false
}

export function findParallelWriteConflict(assignments) {
  const owners = assignments.filter((assignment) => assignment.teamRole === "owner" && assignment.writableRefs.length > 0)
  const byId = new Map(assignments.map((assignment) => [assignment.assignmentId, assignment]))
  for (let leftIndex = 0; leftIndex < owners.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < owners.length; rightIndex += 1) {
      const left = owners[leftIndex]
      const right = owners[rightIndex]
      const sharedRefs = left.writableRefs.filter((ref) => right.writableRefs.includes(ref))
      if (sharedRefs.length === 0) continue
      const serialized = dependsTransitively(byId, left.assignmentId, right.assignmentId)
        || dependsTransitively(byId, right.assignmentId, left.assignmentId)
      if (!serialized) return { left: left.assignmentId, right: right.assignmentId, sharedRefs }
    }
  }
  return null
}
