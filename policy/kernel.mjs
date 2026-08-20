import { createHash } from "node:crypto"

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

export function digestValue(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex")
}

// 能力快照 digest 只覆盖派发身份（Agent、成本档、模型、能力）；
// role 是编译期选人元数据，参与 plan 种子而不进入该 digest，
// 以保证目录引入 role 字段前后对同一批 Agent 的快照 digest 稳定。
export function agentCatalogDigest(agents) {
  return digestValue(agents.map(({ agentId, tier, modelFamily, assignmentKinds }) => ({
    agentId,
    tier,
    modelFamily,
    assignmentKinds,
  })))
}

export class PolicyError extends Error {
  constructor(code, message, details = []) {
    super(message)
    this.name = "PolicyError"
    this.code = code
    this.details = details
  }
}

export const COST_WEIGHTS = Object.freeze({ junior: 1, senior: 10, expert: 50 })

export function costWeightForTier(tier) {
  const weight = COST_WEIGHTS[tier]
  if (weight === undefined) throw new PolicyError("COST_TIER_INVALID", `unknown cost tier: ${tier}`)
  return weight
}

function dependsTransitively(byId, assignmentId, dependencyId) {
  const pending = [...(byId.get(assignmentId)?.dependsOn ?? [])]
  const visited = new Set()
  while (pending.length > 0) {
    const current = pending.shift()
    if (current === dependencyId) return true
    if (visited.has(current)) continue
    visited.add(current)
    pending.push(...(byId.get(current)?.dependsOn ?? []))
  }
  return false
}

export function assertCompiledWorkGraph(assignments) {
  if (!Array.isArray(assignments) || assignments.length === 0) {
    throw new PolicyError("WORK_GRAPH_INVALID", "compiled work graph requires assignments")
  }
  const ids = assignments.map(({ assignmentId }) => assignmentId)
  const idSet = new Set(ids)
  if (idSet.size !== ids.length) throw new PolicyError("WORK_GRAPH_INVALID", "compiled assignment ids must be unique")
  for (const assignment of assignments) {
    if (
      !Array.isArray(assignment.dependsOn)
      || assignment.dependsOn.includes(assignment.assignmentId)
      || assignment.dependsOn.some((dependency) => !idSet.has(dependency))
    ) throw new PolicyError("WORK_GRAPH_INVALID", `assignment ${assignment.assignmentId} has an invalid dependency`)
    if (assignment.teamRole !== "owner" && assignment.writableRefs.length > 0) {
      throw new PolicyError("ROLE_WRITE_FORBIDDEN", `${assignment.teamRole} assignments cannot write product artifacts`)
    }
  }
  const pending = new Map(assignments.map((assignment) => [assignment.assignmentId, new Set(assignment.dependsOn)]))
  const ready = [...pending].filter(([, dependencies]) => dependencies.size === 0).map(([id]) => id)
  let visited = 0
  while (ready.length > 0) {
    const current = ready.shift()
    visited += 1
    for (const [id, dependencies] of pending) {
      if (dependencies.delete(current) && dependencies.size === 0) ready.push(id)
    }
  }
  if (visited !== assignments.length) throw new PolicyError("WORK_GRAPH_CYCLE", "compiled assignment dependencies must be acyclic")

  const owners = assignments.filter(({ teamRole, writableRefs }) => teamRole === "owner" && writableRefs.length > 0)
  const byId = new Map(assignments.map((assignment) => [assignment.assignmentId, assignment]))
  for (let leftIndex = 0; leftIndex < owners.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < owners.length; rightIndex += 1) {
      const left = owners[leftIndex]
      const right = owners[rightIndex]
      const shared = left.writableRefs.filter((ref) => right.writableRefs.includes(ref))
      if (
        shared.length > 0
        && !dependsTransitively(byId, left.assignmentId, right.assignmentId)
        && !dependsTransitively(byId, right.assignmentId, left.assignmentId)
      ) throw new PolicyError("WORK_GRAPH_WRITE_CONFLICT", `parallel owners share writable refs: ${shared.join(", ")}`)
    }
  }
  return assignments
}
