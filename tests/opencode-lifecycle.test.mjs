import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, writeFile, access, rm, chmod, symlink, readdir, utimes } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"

import { manageOpenCodePlugin } from "../plugins/opencode/src/lifecycle.mjs"
import { createContractValidator } from "./support/contract-validator.mjs"

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const exists = async (target) => access(target).then(() => true, () => false)
const tempProject = () => mkdtemp(path.join(os.tmpdir(), "team-work-opencode-"))
const modelMap = {
  "junior-flash": "gateway/deepseek-v4-flash",
  "junior-luna": "gateway/gpt-5.6-luna",
  "senior-terra": "gateway/gpt-5.6-terra",
  "senior-glm": "gateway/glm-5.2",
  "senior-qwen": "gateway/qwen3.8-max",
  "expert-opus": "official/claude-opus-5",
  "expert-k3": "gateway/kimi-k3",
}

function options(projectRoot, overrides = {}) {
  return {
    installRoot: projectRoot,
    sourceRoot,
    hostVersion: "1.18.15",
    modelMap,
    helper: { model: "gateway/deepseek-v4-flash", effort: "low" },
    availableModels: Object.values(modelMap),
    skipDependencies: true,
    now: () => new Date("2026-08-11T08:00:00.000Z"),
    ...overrides,
  }
}

test("install enforces only a minimum OpenCode version", async () => {
  const tooOld = await tempProject()
  await assert.rejects(
    manageOpenCodePlugin("install", options(tooOld, { hostVersion: "1.17.9" })),
    (error) => error.code === "OPENCODE_VERSION_TOO_OLD",
  )

  const future = await tempProject()
  const result = await manageOpenCodePlugin("install", options(future, { hostVersion: "9.0.0" }))
  assert.equal(result.status, "installed")
})

test("lifecycle commands report a stable result when the global install root is absent", async () => {
  const parent = await tempProject()
  const missing = path.join(parent, "missing-opencode-root")
  assert.deepEqual(await manageOpenCodePlugin("uninstall", options(missing)), { status: "not-installed", retained: [] })
  await assert.rejects(
    manageOpenCodePlugin("update", options(missing)),
    (error) => error.code === "NOT_INSTALLED",
  )
  await assert.rejects(
    manageOpenCodePlugin("doctor", options(missing)),
    (error) => error.code === "NOT_INSTALLED",
  )
})

test("install materializes runtime, skills, dynamic Agent config, plugin, profile, guides, and manifest", async () => {
  const projectRoot = await tempProject()
  const result = await manageOpenCodePlugin("install", options(projectRoot))

  assert.equal(result.status, "installed")
  for (const relativePath of [
    "skills/workflow/SKILL.md",
    "skills/team-work/SKILL.md",
    "plugins/team-work.js",
    "plugins/team-work-tui.tsx",
    "team-work/runtime/cli.mjs",
    "team-work/opencode-adapter.mjs",
    "team-work/opencode-activation.mjs",
    "team-work/opencode-agent-config.mjs",
    "team-work/tui/team-work-tui.tsx",
    "team-work/tui/team-sidebar.tsx",
    "team-work/tui/team-sessions.mjs",
    "team-work/installer/user-config.mjs",
    "team-work/settings.json",
    "team-work/profile.json",
    "team-work/guides/team-work.md",
    "team-work/guides/recovery.md",
    "team-work/install.json",
  ]) assert.equal(await exists(path.join(projectRoot, relativePath)), true, relativePath)
  assert.equal(await exists(path.join(projectRoot, "agents/junior-flash.md")), false)

  const profile = JSON.parse(await readFile(path.join(projectRoot, "team-work/profile.json"), "utf8"))
  assert.equal(profile.dispatch.managedMode, "background")
  assert.equal(profile.dispatch.blockingPolicy, "reject")
  assert.equal(profile.agents.length, 7)
  assert.ok(profile.agents.every((agent) => agent.resolvedModel?.includes("/")))
  assert.equal(profile.agents.find(({ id }) => id === "senior-terra").costWeight, 10)
  assert.deepEqual(profile.helpers.map(({ id }) => id), ["team-work-explore", "team-work-librarian"])
  assert.ok(profile.helpers.every(({ resolvedModel }) => resolvedModel === "gateway/deepseek-v4-flash"))
  assert.equal(profile.operations.spawn.tool, "team_work_spawn")
  assert.equal(profile.operations.assist.tool, "team_work_assist")
  const profileSchema = JSON.parse(await readFile(path.join(sourceRoot, "schemas/platform-profile.schema.json"), "utf8"))
  assert.deepEqual(createContractValidator([profileSchema])(profileSchema.$id, profile), [])
  assert.deepEqual(JSON.parse(await readFile(path.join(projectRoot, "team-work/settings.json"), "utf8")), {
    spec: { provider: "openspec", mode: "auto", command: "openspec" },
  })

  const manifest = JSON.parse(await readFile(path.join(projectRoot, "team-work/install.json"), "utf8"))
  assert.equal(manifest.status, "installed")
  assert.ok(manifest.managedFiles.length > 20)
  assert.ok(manifest.managedFiles.every(({ path: relativePath, sha256 }) => relativePath && /^[a-f0-9]{64}$/.test(sha256)))

  const tuiConfig = JSON.parse(await readFile(path.join(projectRoot, "tui.json"), "utf8"))
  assert.equal(tuiConfig.$schema, "https://opencode.ai/tui.json")
  assert.deepEqual(tuiConfig.plugin, ["./plugins/team-work-tui.tsx"])
})

test("install and update preserve an existing JSONC TUI config and register the sidebar idempotently", async () => {
  const projectRoot = await tempProject()
  const tuiPath = path.join(projectRoot, "tui.json")
  await writeFile(tuiPath, `{
  // 用户自己的主题与插件必须保留
  "$schema": "https://opencode.ai/tui.json",
  "theme": "custom",
  "plugin": ["other-plugin"]
}\n`)

  await manageOpenCodePlugin("install", options(projectRoot))
  await manageOpenCodePlugin("update", options(projectRoot))

  const content = await readFile(tuiPath, "utf8")
  assert.match(content, /用户自己的主题与插件必须保留/)
  assert.match(content, /"theme": "custom"/)
  assert.equal(content.match(/\.\/plugins\/team-work-tui\.tsx/g)?.length, 1)
})

test("invalid or symlinked TUI config fails before installation changes", async () => {
  const invalidRoot = await tempProject()
  await writeFile(path.join(invalidRoot, "tui.json"), "{broken\n")
  await assert.rejects(
    manageOpenCodePlugin("install", options(invalidRoot)),
    (error) => error.code === "TUI_CONFIG_INVALID",
  )
  assert.equal(await exists(path.join(invalidRoot, "plugins/team-work.js")), false)

  const symlinkRoot = await tempProject()
  const outside = path.join(await tempProject(), "outside-tui.json")
  await writeFile(outside, "{}\n")
  await symlink(outside, path.join(symlinkRoot, "tui.json"))
  await assert.rejects(
    manageOpenCodePlugin("install", options(symlinkRoot)),
    (error) => error.code === "UNSAFE_PATH",
  )
  assert.equal(await readFile(outside, "utf8"), "{}\n")
})

test("failed smoke restores the exact pre-install TUI config", async () => {
  const projectRoot = await tempProject()
  const tuiPath = path.join(projectRoot, "tui.json")
  const original = `{
  // keep this byte-for-byte on rollback
  "theme": "custom"
}\n`
  await writeFile(tuiPath, original)
  const fakeOpenCode = path.join(projectRoot, "fake-opencode")
  await writeFile(fakeOpenCode, "#!/bin/sh\nexit 23\n")
  await chmod(fakeOpenCode, 0o755)

  await assert.rejects(
    manageOpenCodePlugin("install", options(projectRoot, { opencodeCommand: fakeOpenCode, skipSmoke: false })),
    (error) => error.code === "SMOKE_TEST_FAILED",
  )

  assert.equal(await readFile(tuiPath, "utf8"), original)
  assert.equal(await exists(path.join(projectRoot, "plugins/team-work.js")), false)
})

test("doctor reports a missing TUI registration and update repairs it", async () => {
  const projectRoot = await tempProject()
  await manageOpenCodePlugin("install", options(projectRoot))
  await writeFile(path.join(projectRoot, "tui.json"), "{}\n")

  const diagnosis = await manageOpenCodePlugin("doctor", options(projectRoot))
  assert.ok(diagnosis.issues.some(({ code }) => code === "TUI_PLUGIN_NOT_REGISTERED"))

  const repaired = await manageOpenCodePlugin("update", options(projectRoot))
  assert.equal(repaired.status, "updated")
  assert.deepEqual(JSON.parse(await readFile(path.join(projectRoot, "tui.json"), "utf8")).plugin, ["./plugins/team-work-tui.tsx"])
})

test("uninstall removes only the Team-work TUI registration", async () => {
  const projectRoot = await tempProject()
  const tuiPath = path.join(projectRoot, "tui.json")
  await writeFile(tuiPath, `${JSON.stringify({ theme: "custom", plugin: ["other-plugin"] }, null, 2)}\n`)
  await manageOpenCodePlugin("install", options(projectRoot))

  await manageOpenCodePlugin("uninstall", options(projectRoot))

  assert.deepEqual(JSON.parse(await readFile(tuiPath, "utf8")), { theme: "custom", plugin: ["other-plugin"] })
})

test("uninstall refuses a newly corrupted TUI config without removing installed assets", async () => {
  const projectRoot = await tempProject()
  await manageOpenCodePlugin("install", options(projectRoot))
  await writeFile(path.join(projectRoot, "tui.json"), "{broken\n")

  await assert.rejects(
    manageOpenCodePlugin("uninstall", options(projectRoot)),
    (error) => error.code === "TUI_CONFIG_INVALID",
  )

  assert.equal(await exists(path.join(projectRoot, "plugins/team-work.js")), true)
  assert.equal(JSON.parse(await readFile(path.join(projectRoot, "team-work/install.json"), "utf8")).status, "installed")
})

test("update repairs missing managed files and doctor reports drift", async () => {
  const projectRoot = await tempProject()
  await manageOpenCodePlugin("install", options(projectRoot))
  const target = path.join(projectRoot, "plugins/team-work.js")
  await rm(target)
  const diagnosis = await manageOpenCodePlugin("doctor", options(projectRoot))
  assert.equal(diagnosis.status, "issues")
  assert.ok(diagnosis.issues.some(({ code, path: relativePath }) => code === "MANAGED_FILE_MISSING" && relativePath === "plugins/team-work.js"))

  const repaired = await manageOpenCodePlugin("update", options(projectRoot))
  assert.equal(repaired.status, "updated")
  assert.equal(await exists(target), true)
})

test("unresolved model aliases remain visible and dynamic config can omit them", async () => {
  const projectRoot = await tempProject()
  const result = await manageOpenCodePlugin("install", options(projectRoot, { modelMap: undefined, availableModels: ["gateway/gpt-5.6-terra"] }))
  assert.ok(result.warnings.length >= 6)
  assert.equal(await exists(path.join(projectRoot, "agents/senior-terra.md")), false)
  assert.equal(await exists(path.join(projectRoot, "agents/expert-opus.md")), false)
  const profile = JSON.parse(await readFile(path.join(projectRoot, "team-work/profile.json"), "utf8"))
  assert.equal(profile.agents.find(({ id }) => id === "expert-opus").resolvedModel, null)
})

test("doctor does not report stale unresolved Agents outside the current explicit config", async () => {
  const projectRoot = await tempProject()
  await manageOpenCodePlugin("install", options(projectRoot, {
    modelMap: undefined,
    availableModels: ["gateway/gpt-5.6-terra"],
  }))

  const diagnosis = await manageOpenCodePlugin("doctor", options(projectRoot, {
    modelMap: { "expert-opus": "official/claude-opus-5" },
  }))

  assert.equal(diagnosis.issues.some(({ code }) => code === "MODEL_UNRESOLVED"), false)
})

test("an explicit reduced Agent config does not warn about intentionally omitted candidates", async () => {
  const projectRoot = await tempProject()
  const result = await manageOpenCodePlugin("install", options(projectRoot, {
    modelMap: { "junior-flash": "gateway/deepseek-v4-flash" },
    availableModels: ["gateway/deepseek-v4-flash"],
  }))

  assert.deepEqual(result.warnings, [])
})

test("doctor reports an explicit Agent model that OpenCode cannot resolve", async () => {
  const projectRoot = await tempProject()
  await manageOpenCodePlugin("install", options(projectRoot))

  const diagnosis = await manageOpenCodePlugin("doctor", options(projectRoot, {
    modelMap: { "junior-flash": "gateway/missing-model" },
  }))

  assert.ok(diagnosis.issues.some(({ code, agent, model }) => (
    code === "MODEL_UNAVAILABLE" && agent === "junior-flash" && model === "gateway/missing-model"
  )))
})

test("doctor reports an independently configured helper model that OpenCode cannot resolve", async () => {
  const projectRoot = await tempProject()
  await manageOpenCodePlugin("install", options(projectRoot))

  const diagnosis = await manageOpenCodePlugin("doctor", options(projectRoot, {
    helper: { model: "gateway/missing-helper", effort: "low" },
  }))

  assert.ok(diagnosis.issues.some(({ code, model }) => (
    code === "HELPER_MODEL_UNAVAILABLE" && model === "gateway/missing-helper"
  )))
})

test("doctor distinguishes model discovery failure from unavailable configured models", async () => {
  const projectRoot = await tempProject()
  await manageOpenCodePlugin("install", options(projectRoot))
  const failingOpenCode = path.join(projectRoot, "failing-opencode")
  await writeFile(failingOpenCode, "#!/bin/sh\necho model-scan-broken >&2\nexit 23\n")
  await chmod(failingOpenCode, 0o755)

  const diagnosis = await manageOpenCodePlugin("doctor", options(projectRoot, {
    availableModels: undefined,
    opencodeCommand: failingOpenCode,
  }))

  assert.ok(diagnosis.issues.some(({ code, message }) => code === "MODEL_DISCOVERY_FAILED" && message.includes("model-scan-broken")))
  assert.equal(diagnosis.issues.some(({ code }) => code === "MODEL_UNAVAILABLE"), false)
})

test("doctor optionally probes each distinct configured model and reports connectivity", async () => {
  const projectRoot = await tempProject()
  const calls = path.join(projectRoot, "probe-calls.txt")
  const fakeOpenCode = path.join(projectRoot, "fake-opencode")
  await writeFile(fakeOpenCode, `#!/bin/sh
if [ "$1" = "models" ]; then
  printf '%s\\n' gateway/model-a gateway/model-b
  exit 0
fi
printf '%s\\n' "$*" >> "${calls}"
case "$*" in
  *gateway/model-b*) echo '{"type":"error","error":{"message":"probe-failed"}}'; exit 0 ;;
  *) echo '{"type":"text","part":{"type":"text","text":"OK"}}'; exit 0 ;;
esac
`)
  await chmod(fakeOpenCode, 0o755)
  const configured = {
    "junior-flash": "gateway/model-a",
    "junior-luna": "gateway/model-a",
    "senior-terra": "gateway/model-b",
  }
  await manageOpenCodePlugin("install", options(projectRoot, {
    modelMap: configured,
    availableModels: Object.values(configured),
  }))

  const diagnosis = await manageOpenCodePlugin("doctor", options(projectRoot, {
    modelMap: configured,
    availableModels: undefined,
    opencodeCommand: fakeOpenCode,
    probeModels: true,
  }))

  assert.equal(diagnosis.modelChecks.filter(({ probe }) => probe === "ok").length, 1)
  assert.ok(diagnosis.issues.some(({ code, model }) => code === "MODEL_PROBE_FAILED" && model === "gateway/model-b"))
  assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 2)
})

test("doctor probes resolved automatic Agent models too", async () => {
  const projectRoot = await tempProject()
  const fakeOpenCode = path.join(projectRoot, "fake-opencode")
  await writeFile(fakeOpenCode, `#!/bin/sh
if [ "$1" = "models" ]; then echo gateway/model-a; exit 0; fi
echo '{"type":"text","part":{"type":"text","text":"OK"}}'
`)
  await chmod(fakeOpenCode, 0o755)
  await manageOpenCodePlugin("install", options(projectRoot, {
    modelMap: undefined,
    availableModels: ["gateway/gpt-5.6-terra"],
  }))

  const diagnosis = await manageOpenCodePlugin("doctor", options(projectRoot, {
    modelMap: undefined,
    helper: undefined,
    availableModels: ["gateway/gpt-5.6-terra"],
    opencodeCommand: fakeOpenCode,
    probeModels: true,
  }))

  assert.deepEqual(diagnosis.modelChecks.map(({ model, probe }) => ({ model, probe })), [
    { model: "gateway/gpt-5.6-terra", probe: "ok" },
  ])
})

test("failed OpenCode smoke test rolls back all managed files", async () => {
  const projectRoot = await tempProject()
  const fakeOpenCode = path.join(projectRoot, "fake-opencode")
  await writeFile(fakeOpenCode, "#!/bin/sh\nexit 23\n")
  await chmod(fakeOpenCode, 0o755)

  await assert.rejects(
    manageOpenCodePlugin("install", options(projectRoot, { opencodeCommand: fakeOpenCode, skipSmoke: false })),
    (error) => error.code === "SMOKE_TEST_FAILED",
  )
  assert.equal(await exists(path.join(projectRoot, "plugins/team-work.js")), false)
  assert.equal(await exists(path.join(projectRoot, "team-work/install.json")), false)
  assert.equal(await readFile(fakeOpenCode, "utf8"), "#!/bin/sh\nexit 23\n")
})

test("OpenCode smoke retries one transient Agent discovery miss", async () => {
  const projectRoot = await tempProject()
  const attempts = path.join(projectRoot, "smoke-attempts")
  const fakeOpenCode = path.join(projectRoot, "fake-opencode")
  await writeFile(fakeOpenCode, `#!/bin/sh
count=0
if [ -f "${attempts}" ]; then count=$(cat "${attempts}"); fi
count=$((count + 1))
printf '%s' "$count" > "${attempts}"
if [ "$count" -eq 1 ]; then exit 0; fi
printf '%s\\n' junior-flash junior-luna senior-terra senior-glm senior-qwen expert-opus expert-k3 team-work-explore team-work-librarian
`)
  await chmod(fakeOpenCode, 0o755)

  const result = await manageOpenCodePlugin("install", options(projectRoot, {
    opencodeCommand: fakeOpenCode,
    skipSmoke: false,
  }))

  assert.equal(result.status, "installed")
  assert.equal(await readFile(attempts, "utf8"), "2")
})

test("disabled OpenCode platform keeps host smoke and update repair without requiring Agent registration", async () => {
  const projectRoot = await tempProject()
  const fakeOpenCode = path.join(projectRoot, "fake-opencode")
  await writeFile(fakeOpenCode, "#!/bin/sh\nexit 0\n")
  await chmod(fakeOpenCode, 0o755)

  const result = await manageOpenCodePlugin("install", options(projectRoot, {
    platformEnabled: false,
    opencodeCommand: fakeOpenCode,
    skipSmoke: false,
  }))

  assert.equal(result.status, "installed")
  const plugin = path.join(projectRoot, "plugins/team-work.js")
  assert.equal(await exists(plugin), true)

  await rm(plugin)
  const repaired = await manageOpenCodePlugin("update", options(projectRoot, {
    platformEnabled: false,
    opencodeCommand: fakeOpenCode,
    skipSmoke: false,
  }))
  assert.equal(repaired.status, "updated")
  assert.equal(await exists(plugin), true)
})

test("tampered manifest cannot claim and delete arbitrary project files", async () => {
  const projectRoot = await tempProject()
  const readme = path.join(projectRoot, "README.md")
  const content = "user project\n"
  await writeFile(readme, content)
  const manifest = path.join(projectRoot, "team-work/install.json")
  await mkdir(path.dirname(manifest), { recursive: true })
  await writeFile(manifest, `${JSON.stringify({
    schemaVersion: "1.0",
    platform: "opencode",
    status: "installed",
    managedFiles: [{ path: "README.md", sha256: createHash("sha256").update(content).digest("hex") }],
  })}\n`)

  await assert.rejects(
    manageOpenCodePlugin("uninstall", options(projectRoot)),
    (error) => error.code === "INSTALL_MANIFEST_UNSAFE",
  )
  assert.equal(await readFile(readme, "utf8"), content)
})

test("tampered manifest cannot claim user files added inside installed skill directories", async () => {
  const projectRoot = await tempProject()
  const note = path.join(projectRoot, "skills/team-work/user-notes.md")
  const content = "user note\n"
  await mkdir(path.dirname(note), { recursive: true })
  await writeFile(note, content)
  const manifest = path.join(projectRoot, "team-work/install.json")
  await mkdir(path.dirname(manifest), { recursive: true })
  await writeFile(manifest, `${JSON.stringify({
    schemaVersion: "1.0",
    platform: "opencode",
    status: "installed",
    managedFiles: [{ path: "skills/team-work/user-notes.md", sha256: createHash("sha256").update(content).digest("hex") }],
  })}\n`)

  await assert.rejects(
    manageOpenCodePlugin("uninstall", options(projectRoot)),
    (error) => error.code === "INSTALL_MANIFEST_UNSAFE",
  )
  assert.equal(await readFile(note, "utf8"), content)
})

test("backup creation rejects symlinked backup roots", async () => {
  const projectRoot = await tempProject()
  await manageOpenCodePlugin("install", options(projectRoot))
  const plugin = path.join(projectRoot, "plugins/team-work.js")
  await writeFile(plugin, "// local change\n")
  const outside = await mkdtemp(path.join(os.tmpdir(), "team-work-outside-"))
  const backupRoot = path.join(projectRoot, "team-work/backups")
  await symlink(outside, backupRoot)

  await assert.rejects(
    manageOpenCodePlugin("update", options(projectRoot, { force: true })),
    (error) => error.code === "UNSAFE_PATH",
  )
  assert.equal(await readFile(plugin, "utf8"), "// local change\n")
  assert.deepEqual(await readdir(outside), [])
})

test("update rejects symlinked obsolete managed files before backup or deletion", async () => {
  const projectRoot = await tempProject()
  await manageOpenCodePlugin("install", options(projectRoot))
  const managed = path.join(projectRoot, "agents/expert-k3.md")
  await mkdir(path.dirname(managed), { recursive: true })
  await writeFile(managed, "legacy managed agent\n")
  const manifestPath = path.join(projectRoot, "team-work/install.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  manifest.managedFiles.push({ path: "agents/expert-k3.md", sha256: createHash("sha256").update("legacy managed agent\n").digest("hex") })
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  const outside = path.join(await mkdtemp(path.join(os.tmpdir(), "team-work-outside-")), "external.md")
  await writeFile(outside, "outside\n")
  await rm(managed)
  await symlink(outside, managed)
  const reducedMap = { ...modelMap }
  delete reducedMap["expert-k3"]

  await assert.rejects(
    manageOpenCodePlugin("update", options(projectRoot, { modelMap: reducedMap, force: true })),
    (error) => error.code === "UNSAFE_PATH",
  )
  assert.equal(await readFile(outside, "utf8"), "outside\n")
})

test("first install never silently adopts an identical pre-existing file", async () => {
  const projectRoot = await tempProject()
  const target = path.join(projectRoot, "plugins/team-work.js")
  const original = await readFile(path.join(sourceRoot, "plugins/opencode/assets/team-work.js"))
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, original)
  await assert.rejects(
    manageOpenCodePlugin("install", options(projectRoot)),
    (error) => error.code === "INSTALL_COLLISION",
  )

  const fakeOpenCode = path.join(projectRoot, "fake-opencode")
  await writeFile(fakeOpenCode, "#!/bin/sh\nexit 23\n")
  await chmod(fakeOpenCode, 0o755)
  await assert.rejects(
    manageOpenCodePlugin("install", options(projectRoot, { force: true, opencodeCommand: fakeOpenCode, skipSmoke: false })),
    (error) => error.code === "SMOKE_TEST_FAILED",
  )
  assert.deepEqual(await readFile(target), original)
})

test("lifecycle lock rejects active writers and recovers stale or forced corrupt locks", async () => {
  const activeProject = await tempProject()
  const activeLock = path.join(activeProject, "team-work/.lifecycle.lock")
  await mkdir(path.dirname(activeLock), { recursive: true })
  await writeFile(activeLock, `${JSON.stringify({ pid: process.pid })}\n`)
  await assert.rejects(
    manageOpenCodePlugin("install", options(activeProject)),
    (error) => error.code === "INSTALL_LOCKED",
  )
  await rm(activeLock)

  const staleProject = await tempProject()
  const staleLock = path.join(staleProject, "team-work/.lifecycle.lock")
  await mkdir(path.dirname(staleLock), { recursive: true })
  await writeFile(staleLock, `${JSON.stringify({ pid: 2147483647 })}\n`)
  assert.equal((await manageOpenCodePlugin("install", options(staleProject))).status, "installed")
  assert.equal(await exists(staleLock), false)

  const corruptProject = await tempProject()
  const corruptLock = path.join(corruptProject, "team-work/.lifecycle.lock")
  await mkdir(path.dirname(corruptLock), { recursive: true })
  await writeFile(corruptLock, "not-json\n")
  await assert.rejects(
    manageOpenCodePlugin("install", options(corruptProject)),
    (error) => error.code === "INSTALL_LOCKED",
  )
  const old = new Date(Date.now() - 10 * 60_000)
  await utimes(corruptLock, old, old)
  assert.equal((await manageOpenCodePlugin("install", options(corruptProject, { force: true }))).status, "installed")
})

test("install is idempotent and update snapshots replaced managed files", async () => {
  const projectRoot = await tempProject()
  const installed = await manageOpenCodePlugin("install", options(projectRoot))
  const repeated = await manageOpenCodePlugin("install", options(projectRoot))
  assert.equal(repeated.status, "unchanged")
  assert.equal(repeated.manifestId, installed.manifestId)

  const target = path.join(projectRoot, "plugins/team-work.js")
  const previous = await readFile(target, "utf8")
  const updatedSource = await mkdtemp(path.join(os.tmpdir(), "team-work-source-"))
  await copySourceFixture(sourceRoot, updatedSource)
  await writeFile(path.join(updatedSource, "plugins/opencode/assets/team-work.js"), `${previous}\n// next release\n`)

  const result = await manageOpenCodePlugin("update", options(projectRoot, { sourceRoot: updatedSource }))
  assert.equal(result.status, "updated")
  assert.ok(result.backupPath)
  assert.equal(await readFile(path.join(result.backupPath, "plugins/team-work.js"), "utf8"), previous)
  assert.match(await readFile(target, "utf8"), /next release/)
})

test("generatedAt does not turn a repeated install into a false update", async () => {
  const projectRoot = await tempProject()
  await manageOpenCodePlugin("install", options(projectRoot, { now: () => new Date("2026-08-11T08:00:00.000Z") }))
  const repeated = await manageOpenCodePlugin("install", options(projectRoot, { now: () => new Date("2027-01-01T00:00:00.000Z") }))
  assert.equal(repeated.status, "unchanged")
  const profile = JSON.parse(await readFile(path.join(projectRoot, "team-work/profile.json"), "utf8"))
  assert.equal(profile.generatedAt, "2026-08-11T08:00:00.000Z")
})

test("update never overwrites a new-path user collision without backup", async () => {
  const projectRoot = await tempProject()
  await manageOpenCodePlugin("install", options(projectRoot))
  const updatedSource = await mkdtemp(path.join(os.tmpdir(), "team-work-source-"))
  await copySourceFixture(sourceRoot, updatedSource)
  const relativePath = "skills/team-work/references/new-guide.md"
  await writeFile(path.join(updatedSource, "skills/team-work/references/new-guide.md"), "new managed guide\n")
  const collision = path.join(projectRoot, relativePath)
  await writeFile(collision, "user guide\n")

  await assert.rejects(
    manageOpenCodePlugin("update", options(projectRoot, { sourceRoot: updatedSource })),
    (error) => error.code === "INSTALL_COLLISION" && error.files.includes(relativePath),
  )
  assert.equal(await readFile(collision, "utf8"), "user guide\n")

  const forced = await manageOpenCodePlugin("update", options(projectRoot, { sourceRoot: updatedSource, force: true }))
  assert.equal(await readFile(path.join(forced.backupPath, relativePath), "utf8"), "user guide\n")
  assert.equal(await readFile(collision, "utf8"), "new managed guide\n")
})

test("install and update refuse collisions or modified managed files unless forced", async () => {
  const collisionProject = await tempProject()
  const collision = path.join(collisionProject, "plugins/team-work.js")
  await mkdir(path.dirname(collision), { recursive: true })
  await writeFile(collision, "// user plugin\n")
  await assert.rejects(
    manageOpenCodePlugin("install", options(collisionProject)),
    (error) => error.code === "INSTALL_COLLISION",
  )
  assert.equal(await readFile(collision, "utf8"), "// user plugin\n")

  const projectRoot = await tempProject()
  await manageOpenCodePlugin("install", options(projectRoot))
  const managed = path.join(projectRoot, "plugins/team-work.js")
  await writeFile(managed, "// local customization\n")
  await assert.rejects(
    manageOpenCodePlugin("update", options(projectRoot)),
    (error) => error.code === "MANAGED_FILE_MODIFIED",
  )
  assert.equal(await readFile(managed, "utf8"), "// local customization\n")

  const forced = await manageOpenCodePlugin("update", options(projectRoot, { force: true }))
  assert.equal(forced.status, "updated")
  assert.equal(await readFile(path.join(forced.backupPath, "plugins/team-work.js"), "utf8"), "// local customization\n")
})

test("uninstall removes only managed files and preserves task data and user files", async () => {
  const projectRoot = await tempProject()
  await manageOpenCodePlugin("install", options(projectRoot))
  const taskArtifact = path.join(projectRoot, ".team-work/tasks/task-1/artifacts/review.md")
  const userPlugin = path.join(projectRoot, "plugins/my-plugin.js")
  const userConfig = path.join(projectRoot, "opencode.json")
  await mkdir(path.dirname(taskArtifact), { recursive: true })
  await writeFile(taskArtifact, "keep task\n")
  await writeFile(userPlugin, "// keep plugin\n")
  await writeFile(userConfig, "{}\n")

  const result = await manageOpenCodePlugin("uninstall", options(projectRoot))
  assert.equal(result.status, "uninstalled")
  assert.equal(await exists(path.join(projectRoot, "plugins/team-work.js")), false)
  assert.equal(await exists(path.join(projectRoot, "team-work/runtime")), false)
  assert.equal(await readFile(taskArtifact, "utf8"), "keep task\n")
  assert.equal(await readFile(userPlugin, "utf8"), "// keep plugin\n")
  assert.equal(await readFile(userConfig, "utf8"), "{}\n")

  const tombstone = JSON.parse(await readFile(path.join(projectRoot, "team-work/install.json"), "utf8"))
  assert.equal(tombstone.status, "uninstalled")
  assert.deepEqual(tombstone.managedFiles, [])
})

test("uninstall retains modified managed files by default and force backs them up before removal", async () => {
  const projectRoot = await tempProject()
  await manageOpenCodePlugin("install", options(projectRoot))
  const managed = path.join(projectRoot, "plugins/team-work.js")
  await writeFile(managed, "// preserve my changes\n")

  const safe = await manageOpenCodePlugin("uninstall", options(projectRoot))
  assert.equal(safe.status, "partial")
  assert.deepEqual(safe.retained, ["plugins/team-work.js"])
  assert.equal(await exists(managed), true)

  const forced = await manageOpenCodePlugin("uninstall", options(projectRoot, { force: true }))
  assert.equal(forced.status, "uninstalled")
  assert.equal(await exists(managed), false)
  assert.equal(await readFile(path.join(forced.backupPath, "plugins/team-work.js"), "utf8"), "// preserve my changes\n")
})

async function copySourceFixture(from, to) {
  const { cp } = await import("node:fs/promises")
  for (const relativePath of ["runtime", "schemas", "skills", "installer", "plugins/opencode/assets", "plugins/opencode/config", "plugins/opencode/guides", "plugins/opencode/src", "plugins/opencode/tui", "package.json"]) {
    await cp(path.join(from, relativePath), path.join(to, relativePath), { recursive: true })
  }
}
