import assert from "node:assert/strict"
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { digestValue } from "../../../runtime/domain/digests.mjs"
import { createFileArtifactRepository } from "../../../runtime/persistence/index.mjs"

async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), "team-work-artifacts-"))
  await mkdir(path.join(root, "src"), { recursive: true })
  await writeFile(path.join(root, "src", "result.mjs"), "export const result = true\n")
  return root
}

test("the file artifact repository reads stable project-relative artifacts", async () => {
  const projectRoot = await project()
  const repository = createFileArtifactRepository({ projectRoot })

  assert.equal(await repository.read("src/result.mjs"), "export const result = true\n")
  assert.deepEqual(await repository.snapshot(["src/result.mjs"]), [{
    path: "src/result.mjs",
    content: "export const result = true\n",
    digest: digestValue("export const result = true\n"),
  }])
})

test("snapshot is idempotent and concurrent reads observe an unchanged artifact", async () => {
  const projectRoot = await project()
  const repository = createFileArtifactRepository({ projectRoot })
  const expected = [{
    path: "src/result.mjs",
    content: "export const result = true\n",
    digest: digestValue("export const result = true\n"),
  }]

  assert.deepEqual(await repository.snapshot(["src/result.mjs"]), expected)
  assert.deepEqual(await repository.snapshot(["src/result.mjs"]), expected)
  const reads = await Promise.all(Array.from({ length: 12 }, () => repository.read("src/result.mjs")))
  assert.deepEqual(reads, Array(12).fill("export const result = true\n"))
})

test("snapshot recomputes the digest after a completed external modification", async () => {
  const projectRoot = await project()
  const repository = createFileArtifactRepository({ projectRoot })
  const target = path.join(projectRoot, "src/result.mjs")
  const before = await repository.snapshot(["src/result.mjs"])
  const updated = "export const result = false\n"
  await writeFile(target, updated)
  const after = await repository.snapshot(["src/result.mjs"])

  assert.notEqual(after[0].digest, before[0].digest)
  assert.deepEqual(after, [{ path: "src/result.mjs", content: updated, digest: digestValue(updated) }])
})

test("declared outputs must exist and exactly match the assignment writable refs", async () => {
  const projectRoot = await project()
  const repository = createFileArtifactRepository({ projectRoot })

  assert.deepEqual(await repository.verifyDeclaredOutputs({
    taskId: "task-1",
    stageRunId: "run-1",
    assignmentId: "owner-1",
    attemptId: "attempt-1",
    executionRef: "session-1",
    writableRefs: ["artifact:source"],
    outputs: [{ ref: "artifact:source", path: "src/result.mjs" }],
  }), { valid: true, mismatches: [] })

  assert.deepEqual(await repository.verifyDeclaredOutputs({
    taskId: "task-1",
    stageRunId: "run-1",
    assignmentId: "owner-1",
    attemptId: "attempt-1",
    executionRef: "session-1",
    writableRefs: ["artifact:source"],
    outputs: [{ ref: "artifact:test-code", path: "src/result.mjs" }],
  }), { valid: false, mismatches: [{ path: "src/result.mjs", reason: "output-ref-not-writable" }] })
})

test("missing declared outputs are reported without accepting the assignment", async () => {
  const projectRoot = await project()
  const repository = createFileArtifactRepository({ projectRoot })

  assert.deepEqual(await repository.verifyDeclaredOutputs({
    taskId: "task-1",
    stageRunId: "run-1",
    assignmentId: "owner-1",
    attemptId: "attempt-1",
    executionRef: "session-1",
    writableRefs: ["artifact:source"],
    outputs: [{ ref: "artifact:source", path: "src/missing-result.mjs" }],
  }), { valid: false, mismatches: [{ path: "src/missing-result.mjs", reason: "missing" }] })
})

test("missing, traversal, runtime-control, and symlink artifact paths fail closed", async () => {
  const projectRoot = await project()
  const outside = await mkdtemp(path.join(os.tmpdir(), "team-work-outside-"))
  await writeFile(path.join(outside, "secret.txt"), "secret\n")
  await symlink(path.join(outside, "secret.txt"), path.join(projectRoot, "src", "link.txt"))
  const repository = createFileArtifactRepository({ projectRoot })

  await assert.rejects(repository.read("src/missing.txt"), (error) => error.code === "ARTIFACT_MISSING")
  await assert.rejects(repository.read("../secret.txt"), (error) => error.code === "ARTIFACT_PATH_ESCAPE")
  await assert.rejects(repository.read("src/link.txt"), (error) => error.code === "ARTIFACT_PATH_ESCAPE")

  const result = await repository.verifyDeclaredOutputs({
    taskId: "task-1",
    stageRunId: "run-1",
    assignmentId: "owner-1",
    attemptId: "attempt-1",
    executionRef: "session-1",
    writableRefs: ["artifact:source"],
    outputs: [{ ref: "artifact:source", path: ".team-work/project.json" }],
  })
  assert.deepEqual(result, { valid: false, mismatches: [{ path: ".team-work/project.json", reason: "runtime-control-path" }] })
})

test("nested symbolic-link artifact directories fail closed", async () => {
  const projectRoot = await project()
  const outside = await mkdtemp(path.join(os.tmpdir(), "team-work-outside-"))
  await writeFile(path.join(outside, "secret.txt"), "secret\n")
  await symlink(outside, path.join(projectRoot, "src", "nested"))
  const repository = createFileArtifactRepository({ projectRoot })

  await assert.rejects(repository.read("src/nested/secret.txt"), (error) => error.code === "ARTIFACT_PATH_ESCAPE")
})
