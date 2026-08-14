import assert from "node:assert/strict"
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { loadUserConfig, resolveUserConfigRoot, setOpenCodeEnabled } from "../installer/user-config.mjs"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("user config root follows explicit, XDG, Windows, and home fallback precedence", () => {
  assert.equal(resolveUserConfigRoot({
    env: { TEAM_WORK_CONFIG_HOME: "/custom/team-work", XDG_CONFIG_HOME: "/xdg" },
    platform: "linux",
    homeDir: "/home/dev",
  }), path.resolve("/custom/team-work"))
  assert.equal(resolveUserConfigRoot({ env: { XDG_CONFIG_HOME: "/xdg" }, platform: "linux", homeDir: "/home/dev" }), "/xdg/team-work")
  assert.equal(resolveUserConfigRoot({ env: { APPDATA: "C:\\Users\\dev\\AppData\\Roaming" }, platform: "win32", homeDir: "C:\\Users\\dev" }), "C:\\Users\\dev\\AppData\\Roaming\\team-work")
  assert.equal(resolveUserConfigRoot({ env: {}, platform: "darwin", homeDir: "/Users/dev" }), "/Users/dev/.config/team-work")
})

test("first install creates one fixed user-level config with automatic OpenCode defaults", async () => {
  const configRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-user-config-"))
  const loaded = await loadUserConfig({ configRoot, createIfMissing: true })

  assert.equal(loaded.created, true)
  assert.equal(loaded.path, path.join(configRoot, "config.json"))
  assert.deepEqual(loaded.platform, {
    id: "opencode",
    enabled: true,
    modelMap: undefined,
    opencodeCommand: "opencode",
    openspecCommand: "openspec",
    specMode: "auto",
  })
  assert.deepEqual(JSON.parse(await readFile(loaded.path, "utf8")), {
    $schema: "./schemas/user-config.v1.schema.json",
    agents: "auto",
    platforms: { opencode: { enabled: true } },
    spec: { provider: "openspec", mode: "auto" },
  })
  await assert.doesNotReject(access(path.join(configRoot, "schemas/user-config.v1.schema.json")))
})

test("one config supports explicit model bindings and command overrides", async () => {
  const configRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-user-config-"))
  const configPath = path.join(configRoot, "config.json")
  const models = {
    "junior-flash": "gateway/deepseek-v4-flash",
    "senior-terra": "gateway/gpt-5.6-terra",
  }
  await writeFile(configPath, `${JSON.stringify({
    $schema: "./schemas/user-config.v1.schema.json",
    helper: { model: "gateway/deepseek-v4-flash", effort: "low" },
    agents: {
      "junior-flash": { model: models["junior-flash"], effort: "low" },
      "senior-terra": { model: models["senior-terra"], effort: "high" },
    },
    platforms: { opencode: { command: "/opt/bin/opencode" } },
    spec: { provider: "openspec", mode: "required", command: "/opt/bin/openspec" },
  }, null, 2)}\n`)

  const loaded = await loadUserConfig({ configRoot })

  assert.equal(loaded.created, false)
  await assert.doesNotReject(access(path.join(configRoot, "schemas/user-config.v1.schema.json")))
  assert.deepEqual(loaded.platform.helper, { model: "gateway/deepseek-v4-flash", effort: "low" })
  assert.deepEqual(loaded.platform, {
    id: "opencode",
    enabled: true,
    helper: { model: "gateway/deepseek-v4-flash", effort: "low" },
    modelMap: models,
    opencodeCommand: "/opt/bin/opencode",
    openspecCommand: "/opt/bin/openspec",
    specMode: "required",
  })
})

test("OpenCode enable state changes atomically without losing user configuration", async () => {
  const configRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-user-config-"))
  const configPath = path.join(configRoot, "config.json")
  await writeFile(configPath, `${JSON.stringify({
    $schema: "./schemas/user-config.v1.schema.json",
    helper: { model: "gateway/deepseek-v4-flash", effort: "low" },
    agents: "auto",
    platforms: { opencode: { command: "/opt/bin/opencode" } },
    spec: { provider: "openspec", mode: "disabled" },
  }, null, 2)}\n`)

  assert.deepEqual(await setOpenCodeEnabled({ configRoot, enabled: false }), {
    changed: true,
    enabled: false,
    path: configPath,
  })
  assert.deepEqual(await setOpenCodeEnabled({ configRoot, enabled: false }), {
    changed: false,
    enabled: false,
    path: configPath,
  })
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
    $schema: "./schemas/user-config.v1.schema.json",
    helper: { model: "gateway/deepseek-v4-flash", effort: "low" },
    agents: "auto",
    platforms: { opencode: { command: "/opt/bin/opencode", enabled: false } },
    spec: { provider: "openspec", mode: "disabled" },
  })
})

test("loading config repairs a stale local schema sidecar", async () => {
  const configRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-user-config-"))
  await mkdir(path.join(configRoot, "schemas"), { recursive: true })
  await writeFile(path.join(configRoot, "schemas/user-config.v1.schema.json"), "{}\n")
  await writeFile(path.join(configRoot, "config.json"), JSON.stringify({
    $schema: "./schemas/user-config.v1.schema.json",
    agents: "auto",
    platforms: { opencode: { enabled: true } },
    spec: { provider: "openspec", mode: "auto" },
  }))

  await loadUserConfig({ configRoot })

  const expected = await readFile(path.join(repositoryRoot, "schemas/user-config.v1.schema.json"), "utf8")
  assert.equal(await readFile(path.join(configRoot, "schemas/user-config.v1.schema.json"), "utf8"), expected)
})

test("invalid or unsafe fixed config fails with stable error codes", async () => {
  const invalidRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-user-config-"))
  await writeFile(path.join(invalidRoot, "config.json"), JSON.stringify({
    $schema: "./schemas/user-config.v1.schema.json",
    agents: { "junior-flash": { model: 42 } },
    platforms: { opencode: { enabled: true } },
    spec: { provider: "openspec", mode: "auto" },
  }))
  await assert.rejects(
    loadUserConfig({ configRoot: invalidRoot }),
    (error) => error.code === "USER_CONFIG_INVALID" && /model/.test(error.message),
  )

  const invalidEffortRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-user-config-"))
  await writeFile(path.join(invalidEffortRoot, "config.json"), JSON.stringify({
    $schema: "./schemas/user-config.v1.schema.json",
    agents: { "junior-flash": { model: "gateway/deepseek", effort: 42 } },
    platforms: { opencode: {} },
    spec: { provider: "openspec", mode: "auto" },
  }))
  await assert.rejects(
    loadUserConfig({ configRoot: invalidEffortRoot }),
    (error) => error.code === "USER_CONFIG_INVALID" && /effort/.test(error.message),
  )

  const unsafeRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-user-config-"))
  const outside = path.join(unsafeRoot, "outside.json")
  await writeFile(outside, JSON.stringify({ $schema: "./schemas/user-config.v1.schema.json" }))
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
    $schema: "./schemas/user-config.v1.schema.json",
    agents: "auto",
    platforms: { opencode: { enabled: true } },
    spec: { provider: "openspec", mode: "auto" },
  })
})
