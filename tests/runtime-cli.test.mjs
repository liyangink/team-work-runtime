import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { runRuntimeCli } from "../runtime/cli.mjs"

function capture() {
  const chunks = { out: [], err: [] }
  return {
    writeOut: (text) => chunks.out.push(text),
    writeError: (text) => chunks.err.push(text),
    json: (stream) => JSON.parse(chunks[stream].join("")),
  }
}

test("runtime version reports the v2 contract without touching the project", async () => {
  const io = capture()
  const exit = await runRuntimeCli(["version"], io)
  assert.equal(exit, 0)
  assert.deepEqual(io.json("out"), { ok: true, data: { runtimeMajor: 2, schemaVersion: "2.0" } })
})

test("runtime inspect fails structurally on a markerless project and explains the repair", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-cli-markerless-"))
  const io = capture()
  const exit = await runRuntimeCli(["inspect", "--task", "task-1", "--project", projectRoot], io)
  assert.equal(exit, 1)
  const failure = io.json("err")
  assert.equal(failure.ok, false)
  assert.equal(failure.code, "PROJECT_MARKER_MISSING")
  assert.match(failure.repair, /workflow_open/)
})

test("runtime inspect explains the repair for a foreign runtime major marker", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-cli-foreign-"))
  await mkdir(path.join(projectRoot, ".team-work"))
  await writeFile(path.join(projectRoot, ".team-work", "project.json"), `${JSON.stringify({ runtimeMajor: 1, schemaVersion: "1.0" })}\n`)
  const io = capture()
  const exit = await runRuntimeCli(["inspect", "--task", "task-1", "--project", projectRoot], io)
  assert.equal(exit, 1)
  const failure = io.json("err")
  assert.equal(failure.code, "RUNTIME_MAJOR_MISMATCH")
  assert.match(failure.repair, /主版本/)
})
