import { lstat, mkdir, realpath } from "node:fs/promises"
import path from "node:path"

import { assertProjectRuntimeMajor } from "../version.mjs"
import { atomicJson, withOwnerLock } from "./transactions.mjs"

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

async function ensureDirectory(target, label) {
  await mkdir(target, { recursive: true })
  const metadata = await lstat(target)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw fail("PATH_ESCAPE", `${label} must be a real directory`)
}

export async function initializeProjectRuntime({ projectRoot } = {}) {
  if (typeof projectRoot !== "string" || projectRoot === "") throw new TypeError("projectRoot is required")
  const root = await realpath(path.resolve(projectRoot))
  const control = path.join(root, ".team-work")
  await ensureDirectory(control, "Runtime control root")
  return withOwnerLock(path.join(control, ".initialize.lock"), async () => {
    const markerPath = path.join(control, "project.json")
    try {
      await lstat(markerPath)
      return assertProjectRuntimeMajor(root)
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
    await ensureDirectory(path.join(control, "tasks"), "Runtime task root")
    const marker = { runtimeMajor: 2, schemaVersion: "2.0" }
    await atomicJson(markerPath, marker)
    return assertProjectRuntimeMajor(root)
  })
}
