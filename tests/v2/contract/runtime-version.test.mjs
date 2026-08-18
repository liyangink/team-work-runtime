import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  ContractError,
  RUNTIME_MAJOR,
  assertProjectRuntimeMajor,
  assertRuntimeMajor,
} from "../../../runtime/index.mjs"

test("Runtime v2 rejects a v1 project root without a compatibility fallback", () => {
  assert.equal(RUNTIME_MAJOR, 2)
  assert.equal(assertRuntimeMajor(2), 2)
  assert.throws(
    () => assertRuntimeMajor(1),
    (error) => error instanceof ContractError && error.code === "RUNTIME_MAJOR_MISMATCH",
  )
})

test("Runtime v2 reads the project marker and refuses a v1 root", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-v2-major-"))
  const controlRoot = path.join(projectRoot, ".team-work")
  await mkdir(controlRoot)
  const fixture = await readFile(new URL("../fixtures/project-marker.v1.json", import.meta.url), "utf8")
  await writeFile(path.join(controlRoot, "project.json"), fixture)

  await assert.rejects(
    assertProjectRuntimeMajor(projectRoot),
    (error) => error instanceof ContractError && error.code === "RUNTIME_MAJOR_MISMATCH",
  )

  const validFixture = await readFile(new URL("../fixtures/project-marker.valid.json", import.meta.url), "utf8")
  await writeFile(path.join(controlRoot, "project.json"), validFixture)
  assert.deepEqual(await assertProjectRuntimeMajor(projectRoot), {
    runtimeMajor: 2,
    schemaVersion: "2.0",
  })
})
