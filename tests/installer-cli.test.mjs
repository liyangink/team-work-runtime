import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { runInstallerCli } from "../installer/cli.mjs"

test("install CLI creates user config and targets the global OpenCode directory from any cwd", async () => {
  const userRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-installer-cli-"))
  const configRoot = path.join(userRoot, ".config", "team-work")
  const opencodeRoot = path.join(userRoot, ".config", "opencode")
  const unrelatedCwd = await mkdtemp(path.join(os.tmpdir(), "team-work-unrelated-"))
  const calls = []
  let output = ""

  const exitCode = await runInstallerCli(["install"], {
    manage: async (command, options) => {
      calls.push({ command, options })
      return { status: "installed" }
    },
    writeOut: (text) => { output += text },
    cwd: unrelatedCwd,
    configRoot,
    opencodeRoot,
  })

  assert.equal(exitCode, 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, "install")
  assert.equal(calls[0].options.installRoot, opencodeRoot)
  assert.equal(calls[0].options.modelMap, undefined)
  assert.equal(calls[0].options.opencodeCommand, "opencode")
  assert.equal(calls[0].options.openspecCommand, "openspec")
  assert.deepEqual(JSON.parse(await readFile(path.join(configRoot, "config.json"), "utf8")), {
    schemaVersion: "1.0",
    platforms: { opencode: { models: "auto" } },
    spec: { type: "openspec" },
  })
  assert.equal(JSON.parse(output).status, "installed")
})

test("update CLI takes all model and command configuration from the fixed file", async () => {
  const userRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-installer-cli-"))
  const configRoot = path.join(userRoot, ".config", "team-work")
  const opencodeRoot = path.join(userRoot, ".config", "opencode")
  await mkdir(configRoot, { recursive: true })
  const models = { "junior-luna": "gateway/gpt-5.6-luna" }
  const effort = { "junior-luna": "medium" }
  await writeFile(path.join(configRoot, "config.json"), JSON.stringify({
    schemaVersion: "1.0",
    platforms: { opencode: { command: "opencode-next", models, effort } },
    spec: { type: "openspec", command: "openspec-next" },
  }))
  let received

  const exitCode = await runInstallerCli(["update", "--force"], {
    manage: async (command, options) => {
      received = { command, options }
      return { status: "installed" }
    },
    writeOut: () => {},
    configRoot,
    opencodeRoot,
  })

  assert.equal(exitCode, 0)
  assert.equal(received.command, "update")
  assert.deepEqual(received.options.modelMap, models)
  assert.deepEqual(received.options.effortMap, effort)
  assert.equal(received.options.opencodeCommand, "opencode-next")
  assert.equal(received.options.openspecCommand, "openspec-next")
  assert.equal(received.options.force, true)
  assert.equal(received.options.installRoot, opencodeRoot)
})

test("installer CLI reports stable JSON errors and uninstall remains recoverable without config", async () => {
  const userRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-installer-cli-"))
  const configRoot = path.join(userRoot, ".config", "team-work")
  const opencodeRoot = path.join(userRoot, ".config", "opencode")
  let errorOutput = ""
  const missingExit = await runInstallerCli(["doctor"], {
    manage: async () => assert.fail("manager must not run without config"),
    writeOut: () => {},
    writeError: (text) => { errorOutput += text },
    configRoot,
    opencodeRoot,
  })
  assert.equal(missingExit, 1)
  assert.equal(JSON.parse(errorOutput).code, "USER_CONFIG_MISSING")

  let uninstallCommand
  const uninstallExit = await runInstallerCli(["uninstall"], {
    manage: async (command) => {
      uninstallCommand = command
      return { status: "uninstalled" }
    },
    writeOut: () => {},
    configRoot,
    opencodeRoot,
  })
  assert.equal(uninstallExit, 0)
  assert.equal(uninstallCommand, "uninstall")
})

test("installer CLI rejects the removed project-scoped option", async () => {
  let errorOutput = ""
  const exitCode = await runInstallerCli(["install", "--project", "/tmp/project"], {
    writeOut: () => {},
    writeError: (text) => { errorOutput += text },
  })
  assert.equal(exitCode, 1)
  assert.equal(JSON.parse(errorOutput).code, "INVALID_ARGUMENT")
})
