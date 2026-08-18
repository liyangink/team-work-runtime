import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import path from "node:path"

import { digestValue } from "../domain/digests.mjs"

function isInside(root, target) {
  const relative = path.relative(root, target)
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function verifierError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
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

async function readStableProjectFile(root, candidate, relativePath) {
  let handle
  try {
    handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) return { mismatch: "not-regular-file" }
    const content = await handle.readFile({ encoding: "utf8" })
    const after = await handle.stat({ bigint: true })
    if (!sameSnapshot(before, after)) return { mismatch: "changed-during-read" }

    const linked = await lstat(candidate, { bigint: true })
    if (linked.isSymbolicLink() || !linked.isFile() || !sameFile(before, linked)) {
      return { mismatch: "path-replaced-during-read" }
    }
    const resolved = await realpath(candidate)
    if (!isInside(root, resolved)) throw verifierError("EVIDENCE_PATH_ESCAPE", `artifact resolves outside project root: ${relativePath}`)
    const finalLinked = await lstat(candidate, { bigint: true })
    const finalResolved = await lstat(resolved, { bigint: true })
    if (
      finalLinked.isSymbolicLink()
      || !finalLinked.isFile()
      || !sameFile(before, finalLinked)
      || !sameFile(before, finalResolved)
    ) return { mismatch: "path-replaced-after-resolution" }
    return { content }
  } catch (error) {
    if (["ELOOP", "EMLINK"].includes(error.code)) {
      throw verifierError("EVIDENCE_PATH_ESCAPE", `artifact path is a symbolic link: ${relativePath}`)
    }
    throw error
  } finally {
    await handle?.close()
  }
}

export function createFileEvidenceVerifier({ projectRoot }) {
  if (typeof projectRoot !== "string" || projectRoot === "") throw new TypeError("projectRoot is required")

  return Object.freeze({
    async verify(snapshots) {
      if (!Array.isArray(snapshots)) throw new TypeError("evidence snapshots must be an array")
      const root = await realpath(path.resolve(projectRoot))
      const mismatches = []
      for (const snapshot of snapshots) {
        if (
          typeof snapshot?.path !== "string"
          || snapshot.path === ""
          || path.isAbsolute(snapshot.path)
          || snapshot.path.split(/[\\/]/).some((segment) => ["", ".", ".."].includes(segment))
        ) throw verifierError("EVIDENCE_PATH_ESCAPE", "artifact evidence path must remain project-relative")
        const candidate = path.resolve(root, snapshot.path)
        if (!isInside(root, candidate)) throw verifierError("EVIDENCE_PATH_ESCAPE", `artifact path escapes project root: ${snapshot.path}`)
        try {
          const stable = await readStableProjectFile(root, candidate, snapshot.path)
          if (stable.mismatch) {
            mismatches.push({ artifactId: snapshot.artifactId, path: snapshot.path, reason: stable.mismatch })
            continue
          }
          const digest = digestValue(stable.content)
          if (digest !== snapshot.digest) {
            mismatches.push({ artifactId: snapshot.artifactId, path: snapshot.path, reason: "digest-mismatch", actualDigest: digest })
          }
        } catch (error) {
          if (error.code === "EVIDENCE_PATH_ESCAPE") throw error
          if (error.code === "ENOENT") {
            mismatches.push({ artifactId: snapshot.artifactId, path: snapshot.path, reason: "missing" })
            continue
          }
          throw verifierError("EVIDENCE_READ_FAILED", `cannot verify artifact ${snapshot.path}: ${error.message}`)
        }
      }
      return Object.freeze({ valid: mismatches.length === 0, mismatches })
    },
  })
}
