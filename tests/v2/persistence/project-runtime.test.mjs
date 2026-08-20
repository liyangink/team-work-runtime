import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { initializeProjectRuntime } from "../../../runtime/persistence/index.mjs"

test("project Runtime initialization is idempotent and creates only the v2 control root", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-project-init-"))
  assert.deepEqual(await initializeProjectRuntime({ projectRoot }), { runtimeMajor: 2, schemaVersion: "2.0" })
  assert.deepEqual(await initializeProjectRuntime({ projectRoot }), { runtimeMajor: 2, schemaVersion: "2.0" })
  assert.deepEqual(JSON.parse(await readFile(path.join(projectRoot, ".team-work", "project.json"), "utf8")), { runtimeMajor: 2, schemaVersion: "2.0" })
})

test("project Runtime initialization rejects old majors and symbolic control roots", async () => {
  const oldProject = await mkdtemp(path.join(os.tmpdir(), "team-work-project-old-"))
  await mkdir(path.join(oldProject, ".team-work"))
  await writeFile(path.join(oldProject, ".team-work", "project.json"), `${JSON.stringify({ runtimeMajor: 1, schemaVersion: "1.0" })}\n`)
  await assert.rejects(initializeProjectRuntime({ projectRoot: oldProject }), (error) => error.code === "RUNTIME_MAJOR_MISMATCH")

  const linkedProject = await mkdtemp(path.join(os.tmpdir(), "team-work-project-linked-"))
  const outside = await mkdtemp(path.join(os.tmpdir(), "team-work-project-control-"))
  await symlink(outside, path.join(linkedProject, ".team-work"))
  await assert.rejects(initializeProjectRuntime({ projectRoot: linkedProject }), (error) => error.code === "PATH_ESCAPE")
})
