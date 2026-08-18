import { lstat, readFile, realpath } from "node:fs/promises"
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
          const metadata = await lstat(candidate)
          if (metadata.isSymbolicLink() || !metadata.isFile()) {
            mismatches.push({ artifactId: snapshot.artifactId, path: snapshot.path, reason: "not-regular-file" })
            continue
          }
          const resolved = await realpath(candidate)
          if (!isInside(root, resolved)) throw verifierError("EVIDENCE_PATH_ESCAPE", `artifact resolves outside project root: ${snapshot.path}`)
          const digest = digestValue(await readFile(resolved, "utf8"))
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
