import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import path from "node:path"

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const STATUS_ORDER = new Map([["busy", 0], ["retry", 1], ["idle", 2], ["unknown", 3], ["stopped", 4], ["lost", 5]])

export function resolvePanelProjectRoot({ directory, worktree }) {
  const current = path.resolve(directory)
  if (typeof worktree !== "string" || !worktree) return current
  const candidate = path.resolve(worktree)
  return candidate === path.parse(candidate).root ? current : candidate
}

function safeDirectory(root, segments) {
  let current = root
  for (const segment of segments) {
    current = path.join(current, segment)
    try {
      const metadata = lstatSync(current)
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) return null
    } catch {
      return null
    }
  }
  return current
}

function json(target) {
  try {
    const metadata = lstatSync(target)
    if (metadata.isSymbolicLink() || !metadata.isFile()) return null
    return JSON.parse(readFileSync(target, "utf8"))
  } catch {
    return null
  }
}

function records(directory) {
  if (!directory) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) return []
    const value = json(path.join(directory, entry.name))
    return value ? [value] : []
  })
}

function bindingForSession(root, sessionId) {
  if (!IDENTIFIER.test(sessionId)) return null
  const bindings = safeDirectory(root, ["bindings", "by-session"])
  return bindings ? json(path.join(bindings, `${sessionId}.json`)) : null
}

function bindingForTask(root, taskId) {
  if (!IDENTIFIER.test(taskId)) return null
  const bindings = safeDirectory(root, ["bindings", "by-task"])
  return bindings ? json(path.join(bindings, `${taskId}.json`)) : null
}

function platformStatus(assignment, attempt, statusFor) {
  if (assignment.status === "lost") return "lost"
  if (["cancelled", "blocked"].includes(assignment.status)) return "stopped"
  if (assignment.status !== "running") return "idle"
  try {
    const status = statusFor?.(attempt.executionRef)?.type
    return new Set(["busy", "retry", "idle"]).has(status) ? status : "unknown"
  } catch {
    return "unknown"
  }
}

function snapshot({ projectRoot, currentSessionId, statusFor }) {
  if (typeof projectRoot !== "string" || !projectRoot || !IDENTIFIER.test(currentSessionId ?? "")) return null
  let root
  try { root = realpathSync(path.resolve(projectRoot)) } catch { return null }
  const platform = safeDirectory(root, [".team-work", "platform", "opencode", "v2"])
  if (!platform) return null
  const sessions = safeDirectory(platform, ["sessions"])
  if (!sessions) return null
  const currentMember = json(path.join(sessions, `${currentSessionId}.json`))
  const currentLead = bindingForSession(platform, currentSessionId)
  const taskId = currentMember?.taskId ?? currentLead?.taskId
  if (!IDENTIFIER.test(taskId ?? "")) return null
  if (currentMember && currentLead && currentMember.taskId !== currentLead.taskId) return null
  const lead = bindingForTask(platform, taskId)
  if (!lead || lead.taskId !== taskId || !IDENTIFIER.test(lead.hostSessionRef ?? "")) return null
  const taskRoot = safeDirectory(root, [".team-work", "tasks", taskId])
  if (!taskRoot) return null
  const state = json(path.join(taskRoot, "state.json"))
  if (!state || state.schemaVersion !== "2.0" || state.taskId !== taskId || !Array.isArray(state.workGraph?.assignments)) return null
  const projections = new Map(records(sessions).filter((entry) => entry.taskId === taskId).map((entry) => [entry.executionRef, entry]))
  const members = state.workGraph.assignments.flatMap((assignment) => {
    const attempt = assignment.attempts?.at(-1)
    if (!attempt?.executionRef) return []
    const projection = projections.get(attempt.executionRef)
    if (!projection || projection.assignmentId !== assignment.assignmentId) return []
    const status = platformStatus(assignment, attempt, statusFor)
    return [{
      taskId,
      assignmentId: assignment.assignmentId,
      sessionId: attempt.executionRef,
      parentSessionId: lead.hostSessionRef,
      agent: projection.agentId,
      role: assignment.teamRole,
      assignmentKind: assignment.assignmentKind,
      status,
      title: `${assignment.teamRole} · ${assignment.assignmentKind}`,
      navigable: status !== "lost",
      focused: attempt.executionRef === currentSessionId,
      updatedAt: projection.updatedAt,
    }]
  }).sort((left, right) => (
    (STATUS_ORDER.get(left.status) ?? 99) - (STATUS_ORDER.get(right.status) ?? 99)
    || String(right.updatedAt).localeCompare(String(left.updatedAt))
    || left.assignmentId.localeCompare(right.assignmentId)
  ))
  return { taskId, leadSessionId: lead.hostSessionRef, currentSessionId, members }
}

export function loadTeamPanelSync(input) {
  try { return snapshot(input) } catch { return null }
}

export async function loadTeamPanel(input) {
  return loadTeamPanelSync(input)
}
