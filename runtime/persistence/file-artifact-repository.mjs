import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import path from "node:path"

import { digestValue } from "../domain/digests.mjs"

function failure(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function inside(root, target) {
  const relative = path.relative(root, target)
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function validateRelativePath(value) {
  if (
    typeof value !== "string"
    || value === ""
    || path.isAbsolute(value)
    || value.split(/[\\/]/).some((segment) => ["", ".", ".."].includes(segment))
  ) throw failure("ARTIFACT_PATH_ESCAPE", "artifact path must remain project-relative")
  return value
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

function sameSnapshot(left, right) {
  return sameFile(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

async function rejectSymlinkSegments(root, candidate, relativePath) {
  const segments = path.relative(root, candidate).split(path.sep)
  let cursor = root
  for (const segment of segments) {
    cursor = path.join(cursor, segment)
    const metadata = await lstat(cursor)
    if (metadata.isSymbolicLink()) throw failure("ARTIFACT_PATH_ESCAPE", `artifact path contains a symbolic link: ${relativePath}`)
  }
}

async function readStable(root, relativePath) {
  const candidate = path.resolve(root, validateRelativePath(relativePath))
  if (!inside(root, candidate)) throw failure("ARTIFACT_PATH_ESCAPE", `artifact path escapes project root: ${relativePath}`)
  let handle
  try {
    await rejectSymlinkSegments(root, candidate, relativePath)
    handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw failure("ARTIFACT_NOT_FILE", `artifact is not a regular file: ${relativePath}`)
    const content = await handle.readFile({ encoding: "utf8" })
    const after = await handle.stat({ bigint: true })
    if (!sameSnapshot(before, after)) throw failure("ARTIFACT_UNSTABLE", `artifact changed while being read: ${relativePath}`)
    const resolved = await realpath(candidate)
    if (!inside(root, resolved)) throw failure("ARTIFACT_PATH_ESCAPE", `artifact resolves outside project root: ${relativePath}`)
    const linked = await lstat(candidate, { bigint: true })
    if (linked.isSymbolicLink() || !linked.isFile() || !sameFile(before, linked)) {
      throw failure("ARTIFACT_UNSTABLE", `artifact path changed while being read: ${relativePath}`)
    }
    return content
  } catch (error) {
    if (error.code === "ENOENT") throw failure("ARTIFACT_MISSING", `artifact does not exist: ${relativePath}`)
    if (["ELOOP", "EMLINK"].includes(error.code)) throw failure("ARTIFACT_PATH_ESCAPE", `artifact path is a symbolic link: ${relativePath}`)
    throw error
  } finally {
    await handle?.close()
  }
}

function validateBinding(input) {
  for (const field of ["taskId", "stageRunId", "assignmentId", "attemptId", "executionRef"]) {
    if (typeof input?.[field] !== "string" || input[field] === "") throw new TypeError(`${field} is required`)
  }
  if (!Array.isArray(input.writableRefs) || !Array.isArray(input.outputs)) throw new TypeError("writableRefs and outputs are required")
}

export function createFileArtifactRepository({ projectRoot } = {}) {
  if (typeof projectRoot !== "string" || projectRoot === "") throw new TypeError("projectRoot is required")
  let rootPromise
  const root = () => rootPromise ??= realpath(path.resolve(projectRoot))

  return Object.freeze({
    async read(relativePath) {
      return readStable(await root(), relativePath)
    },

    async snapshot(paths) {
      if (!Array.isArray(paths)) throw new TypeError("artifact paths must be an array")
      const trustedRoot = await root()
      const snapshots = []
      for (const relativePath of paths) {
        const content = await readStable(trustedRoot, relativePath)
        snapshots.push({ path: relativePath, content, digest: digestValue(content) })
      }
      return snapshots
    },

    async verifyDeclaredOutputs(input) {
      validateBinding(input)
      const writable = new Set(input.writableRefs)
      const seenRefs = new Set()
      const seenPaths = new Set()
      const mismatches = []
      for (const output of input.outputs) {
        const outputPath = typeof output?.path === "string" ? output.path : ""
        if (!writable.has(output?.ref)) mismatches.push({ path: outputPath, reason: "output-ref-not-writable" })
        else if (seenRefs.has(output.ref)) mismatches.push({ path: outputPath, reason: "duplicate-output-ref" })
        else if (seenPaths.has(outputPath)) mismatches.push({ path: outputPath, reason: "duplicate-output-path" })
        else if (outputPath === ".team-work" || outputPath.startsWith(".team-work/") || outputPath.startsWith(".team-work\\")) {
          mismatches.push({ path: outputPath, reason: "runtime-control-path" })
        } else {
          try {
            await readStable(await root(), outputPath)
          } catch (error) {
            if (error.code === "ARTIFACT_MISSING") mismatches.push({ path: outputPath, reason: "missing" })
            else throw error
          }
        }
        seenRefs.add(output?.ref)
        seenPaths.add(outputPath)
      }
      return { valid: mismatches.length === 0, mismatches }
    },
  })
}
