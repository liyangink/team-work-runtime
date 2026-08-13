import { lstat, readFile, readdir, realpath } from "node:fs/promises"
import path from "node:path"

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const STATUS_ORDER = new Map([
  ["busy", 0],
  ["retry", 1],
  ["idle", 2],
  ["unknown", 3],
  ["stopped", 4],
  ["lost", 5],
])

async function readJson(target) {
  try {
    return JSON.parse(await readFile(target, "utf8"))
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null
    throw error
  }
}

async function resolveControlDirectory(projectRoot, segments) {
  let current = projectRoot
  for (const segment of segments) {
    current = path.join(current, segment)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || !info.isDirectory()) return null
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null
      throw error
    }
  }
  return current
}

function isMapping(value, taskId, workItemId) {
  return value?.schemaVersion === "1.0"
    && value.platform === "opencode"
    && value.taskId === taskId
    && value.workItemId === workItemId
    && [value.taskId, value.workItemId, value.parentSessionId, value.sessionId, value.agent].every((entry) => (
      typeof entry === "string" && IDENTIFIER.test(entry)
    ))
    && value.dispatchMode === "background"
}

async function loadMappings(projectRoot) {
  const root = await resolveControlDirectory(projectRoot, [".team-work", "platform", "opencode", "sessions"])
  if (!root) return []
  const taskDirectories = await readdir(root, { withFileTypes: true })
  const mappings = []
  for (const taskDirectory of taskDirectories) {
    if (!taskDirectory.isDirectory() || taskDirectory.isSymbolicLink() || !IDENTIFIER.test(taskDirectory.name)) continue
    const taskRoot = path.join(root, taskDirectory.name)
    for (const entry of await readdir(taskRoot, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) continue
      const workItemId = entry.name.slice(0, -5)
      if (!IDENTIFIER.test(workItemId)) continue
      const mapping = await readJson(path.join(taskRoot, entry.name))
      if (isMapping(mapping, taskDirectory.name, workItemId)) mappings.push(mapping)
    }
  }
  return mappings
}

async function loadBinding(projectRoot, currentSessionId) {
  if (!IDENTIFIER.test(currentSessionId)) return null
  const root = await resolveControlDirectory(projectRoot, [".team-work", "bindings", "opencode"])
  if (!root) return null
  const binding = await readJson(path.join(root, `${currentSessionId}.json`))
  if (binding?.schemaVersion !== "1.0" || binding.platform !== "opencode" || binding.sessionKey !== currentSessionId) return null
  return IDENTIFIER.test(binding.taskId ?? "") ? binding : null
}

function resolveTask(binding, mappings, currentSessionId) {
  const childTasks = new Set(mappings.filter(({ sessionId }) => sessionId === currentSessionId).map(({ taskId }) => taskId))
  if (childTasks.size > 1) return null
  const childTask = [...childTasks][0]
  if (binding && childTask && binding.taskId !== childTask) return null
  if (binding) return binding.taskId
  if (childTask) return childTask
  const parentTasks = new Set(mappings.filter(({ parentSessionId }) => parentSessionId === currentSessionId).map(({ taskId }) => taskId))
  return parentTasks.size === 1 ? [...parentTasks][0] : null
}

function memberStatus(mapping, statusFor) {
  if (mapping.lostRecordedAt) return "lost"
  if (mapping.stoppedAt) return "stopped"
  try {
    const status = statusFor?.(mapping.sessionId)?.type
    return new Set(["busy", "retry", "idle"]).has(status) ? status : "unknown"
  } catch {
    return "unknown"
  }
}

export async function loadTeamPanel({ projectRoot, currentSessionId, statusFor, sessionFor }) {
  if (typeof projectRoot !== "string" || !projectRoot || typeof currentSessionId !== "string") return null
  const root = await realpath(path.resolve(projectRoot)).catch(() => null)
  if (!root) return null
  const mappings = await loadMappings(root)
  const binding = await loadBinding(root, currentSessionId)
  const taskId = resolveTask(binding, mappings, currentSessionId)
  if (!taskId) return null
  const currentMapping = mappings.find(({ taskId: candidate, sessionId }) => candidate === taskId && sessionId === currentSessionId)
  const leadSessionId = currentMapping?.parentSessionId ?? currentSessionId
  const members = mappings
    .filter((mapping) => mapping.taskId === taskId)
    .map((mapping) => {
      let session
      try {
        session = sessionFor?.(mapping.sessionId)
      } catch {
        session = undefined
      }
      const status = memberStatus(mapping, statusFor)
      return {
        taskId,
        workItemId: mapping.workItemId,
        sessionId: mapping.sessionId,
        parentSessionId: mapping.parentSessionId,
        agent: mapping.agent,
        contextProfile: mapping.contextProfile,
        status,
        title: session?.title || `${mapping.agent} · ${mapping.workItemId}`,
        navigable: status !== "lost",
        focused: mapping.sessionId === currentSessionId,
        updatedAt: mapping.updatedAt,
      }
    })
    .sort((left, right) => (
      (STATUS_ORDER.get(left.status) ?? 99) - (STATUS_ORDER.get(right.status) ?? 99)
      || String(right.updatedAt).localeCompare(String(left.updatedAt))
      || left.workItemId.localeCompare(right.workItemId)
    ))
  return { taskId, leadSessionId, currentSessionId, members }
}
