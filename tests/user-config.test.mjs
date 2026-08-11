import assert from "node:assert/strict"
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { loadUserConfig } from "../installer/user-config.mjs"

test("first install creates one fixed user-level config with automatic OpenCode defaults", async () => {
  const configRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-user-config-"))
  const loaded = await loadUserConfig({ configRoot, createIfMissing: true })

  assert.equal(loaded.created, true)
  assert.equal(loaded.path, path.join(configRoot, "config.json"))
  assert.deepEqual(loaded.platform, {
    id: "opencode",
    modelMap: undefined,
    opencodeCommand: "opencode",
    openspecCommand: "openspec",
  })
  assert.deepEqual(JSON.parse(await readFile(loaded.path, "utf8")), {
    schemaVersion: "1.0",
    platforms: { opencode: { models: "auto" } },
    spec: { type: "openspec" },
  })
})

test("one config supports explicit model bindings and command overrides", async () => {
  const configRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-user-config-"))
  const configPath = path.join(configRoot, "config.json")
  const models = {
    "junior-flash": "gateway/deepseek-v4-flash",
    "senior-terra": "gateway/gpt-5.6-terra",
  }
  const effort = {
    "junior-flash": "low",
    "senior-terra": "high",
  }
  await writeFile(configPath, `${JSON.stringify({
    schemaVersion: "1.0",
    platforms: { opencode: { command: "/opt/bin/opencode", models, effort } },
    spec: { type: "openspec", command: "/opt/bin/openspec" },
  }, null, 2)}\n`)

  const loaded = await loadUserConfig({ configRoot })

  assert.equal(loaded.created, false)
  assert.deepEqual(loaded.platform, {
    id: "opencode",
    modelMap: models,
    effortMap: effort,
    opencodeCommand: "/opt/bin/opencode",
    openspecCommand: "/opt/bin/openspec",
  })
})

test("invalid or unsafe fixed config fails with stable error codes", async () => {
  const invalidRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-user-config-"))
  await writeFile(path.join(invalidRoot, "config.json"), JSON.stringify({
    schemaVersion: "1.0",
    platforms: { opencode: { models: 42 } },
    spec: { type: "openspec" },
  }))
  await assert.rejects(
    loadUserConfig({ configRoot: invalidRoot }),
    (error) => error.code === "USER_CONFIG_INVALID" && /models/.test(error.message),
  )

  const invalidEffortRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-user-config-"))
  await writeFile(path.join(invalidEffortRoot, "config.json"), JSON.stringify({
    schemaVersion: "1.0",
    platforms: { opencode: { models: "auto", effort: "high" } },
    spec: { type: "openspec" },
  }))
  await assert.rejects(
    loadUserConfig({ configRoot: invalidEffortRoot }),
    (error) => error.code === "USER_CONFIG_INVALID" && /effort/.test(error.message),
  )

  const unsafeRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-user-config-"))
  const outside = path.join(unsafeRoot, "outside.json")
  await writeFile(outside, JSON.stringify({ schemaVersion: "1.0" }))
  await symlink(outside, path.join(unsafeRoot, "config.json"))
  await assert.rejects(
    loadUserConfig({ configRoot: unsafeRoot }),
    (error) => error.code === "USER_CONFIG_UNSAFE",
  )
})

test("concurrent first installs create one complete config without clobbering", async () => {
  const configRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-user-config-"))
  const results = await Promise.all(Array.from({ length: 8 }, () => (
    loadUserConfig({ configRoot, createIfMissing: true })
  )))

  assert.equal(results.filter(({ created }) => created).length, 1)
  assert.ok(results.every(({ platform }) => platform.id === "opencode"))
  assert.doesNotReject(async () => JSON.parse(await readFile(path.join(configRoot, "config.json"), "utf8")))
})

test("a missing user config directory is created on first install", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "team-work-user-config-"))
  const configRoot = path.join(parent, "nested", "team-work")

  const loaded = await loadUserConfig({ configRoot, createIfMissing: true })
  assert.equal(loaded.path, path.join(configRoot, "config.json"))
  assert.deepEqual(JSON.parse(await readFile(loaded.path, "utf8")), {
    schemaVersion: "1.0",
    platforms: { opencode: { models: "auto" } },
    spec: { type: "openspec" },
  })
})
