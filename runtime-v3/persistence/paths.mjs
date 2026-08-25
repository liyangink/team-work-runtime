import { lstat, realpath } from "node:fs/promises"
import path from "node:path"

import { assertIdentifier } from "../domain/invariants.mjs"

import { StoreError } from "./store-error.mjs"

function isDescendant(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function resolveDirectoryWithin(parent, candidate, label) {
  let resolved
  try {
    const metadata = await lstat(candidate)
    if (metadata.isSymbolicLink()) throw new StoreError("PATH_ESCAPE", `${label} cannot be a symbolic link`)
    resolved = await realpath(candidate)
  } catch (error) {
    if (error instanceof StoreError) throw error
    throw new StoreError("STATE_CORRUPT", `cannot resolve ${label}`, [{ message: error.message }])
  }
  if (!isDescendant(parent, resolved)) throw new StoreError("PATH_ESCAPE", `${label} escapes its parent directory`)
  return resolved
}

export async function resolveStorePaths(projectRoot) {
  let root
  try {
    root = await realpath(path.resolve(projectRoot))
  } catch (error) {
    throw new StoreError("STATE_CORRUPT", "cannot resolve project root", [{ message: error.message }])
  }
  const controlRoot = await resolveDirectoryWithin(root, path.join(root, ".team-work"), "Runtime control root")
  const tasksRoot = await resolveDirectoryWithin(controlRoot, path.join(controlRoot, "tasks"), "Runtime tasks root")
  return { projectRoot: root, controlRoot, tasksRoot }
}

export async function resolveExistingTaskRoot(paths, taskId) {
  assertIdentifier(taskId, "taskId")
  const candidate = path.join(paths.tasksRoot, taskId)
  try {
    await lstat(candidate)
  } catch (error) {
    if (error.code === "ENOENT") throw new StoreError("TASK_NOT_FOUND", `task does not exist: ${taskId}`)
    throw error
  }
  return resolveDirectoryWithin(paths.tasksRoot, candidate, `task ${taskId}`)
}

export function newTaskRoot(paths, taskId) {
  assertIdentifier(taskId, "taskId")
  return path.join(paths.tasksRoot, taskId)
}

export function assertChildPath(parent, candidate, label) {
  const resolved = path.resolve(candidate)
  if (!isDescendant(parent, resolved)) throw new StoreError("PATH_ESCAPE", `${label} escapes its parent directory`)
  return resolved
}

export async function resolveTaskSubdirectory(taskRoot, name) {
  return resolveDirectoryWithin(taskRoot, path.join(taskRoot, name), `task ${name} directory`)
}

export async function resolveSafeFile(parent, candidate, label, { allowMissing = false } = {}) {
  const target = path.resolve(candidate)
  if (path.dirname(target) !== parent) throw new StoreError("PATH_ESCAPE", `${label} escapes its parent directory`)
  let metadata
  try {
    metadata = await lstat(target)
  } catch (error) {
    if (allowMissing && error.code === "ENOENT") return null
    if (error.code === "ENOENT") throw new StoreError("STATE_CORRUPT", `${label} is missing`)
    throw new StoreError("STATE_CORRUPT", `cannot inspect ${label}`, [{ message: error.message }])
  }
  if (metadata.isSymbolicLink()) throw new StoreError("PATH_ESCAPE", `${label} cannot be a symbolic link`)
  if (!metadata.isFile()) throw new StoreError("STATE_CORRUPT", `${label} must be a regular file`)
  const resolved = await realpath(target)
  if (!isDescendant(parent, resolved)) throw new StoreError("PATH_ESCAPE", `${label} escapes its parent directory`)
  return resolved
}
