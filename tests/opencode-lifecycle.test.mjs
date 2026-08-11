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
    projectRoot,
    sourceRoot,
    hostVersion: "1.18.15",
    modelMap,
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

test("install materializes runtime, skills, agents, plugin, profile, guides, and manifest", async () => {
  const projectRoot = await tempProject()
  const result = await manageOpenCodePlugin("install", options(projectRoot))

  assert.equal(result.status, "installed")
  for (const relativePath of [
    ".opencode/skills/workflow/SKILL.md",
    ".opencode/skills/team-work/SKILL.md",
    ".opencode/agents/junior-flash.md",
    ".opencode/agents/expert-opus.md",
    ".opencode/plugins/team-work.js",
    ".opencode/team-work/runtime/cli.mjs",
    ".opencode/team-work/opencode-adapter.mjs",
    ".team-work/platform/opencode/profile.json",
    ".team-work/platform/opencode/guides/team-work.md",
    ".team-work/platform/opencode/guides/recovery.md",
    ".team-work/platform/opencode/install.json",
  ]) assert.equal(await exists(path.join(projectRoot, relativePath)), true, relativePath)

  const profile = JSON.parse(await readFile(path.join(projectRoot, ".team-work/platform/opencode/profile.json"), "utf8"))
  assert.equal(profile.dispatch.managedMode, "background")
  assert.equal(profile.dispatch.blockingPolicy, "reject")
  assert.equal(profile.agents.length, 7)
  assert.ok(profile.agents.every((agent) => agent.resolvedModel?.includes("/")))
  assert.equal(profile.operations.spawn.tool, "team_work_spawn")
  const profileSchema = JSON.parse(await readFile(path.join(sourceRoot, "schemas/platform-profile.schema.json"), "utf8"))
  assert.deepEqual(createContractValidator([profileSchema])(profileSchema.$id, profile), [])

  const manifest = JSON.parse(await readFile(path.join(projectRoot, ".team-work/platform/opencode/install.json"), "utf8"))
  assert.equal(manifest.status, "installed")
  assert.ok(manifest.managedFiles.length > 20)
  assert.ok(manifest.managedFiles.every(({ path: relativePath, sha256 }) => relativePath && /^[a-f0-9]{64}$/.test(sha256)))
})

test("install materializes per-agent effort as an OpenCode model option", async () => {
  const projectRoot = await tempProject()
  await manageOpenCodePlugin("install", options(projectRoot, {
    effortMap: { "junior-flash": "low", "senior-terra": "high" },
  }))

  const junior = await readFile(path.join(projectRoot, ".opencode/agents/junior-flash.md"), "utf8")
  const senior = await readFile(path.join(projectRoot, ".opencode/agents/senior-terra.md"), "utf8")
  const expert = await readFile(path.join(projectRoot, ".opencode/agents/expert-opus.md"), "utf8")
  assert.match(junior, /^reasoningEffort: "low"$/m)
  assert.match(senior, /^reasoningEffort: "high"$/m)
  assert.doesNotMatch(expert, /^reasoningEffort:/m)
})

test("install rejects effort configured for an unknown Agent", async () => {
  const projectRoot = await tempProject()
  await assert.rejects(
    manageOpenCodePlugin("install", options(projectRoot, { effortMap: { "missing-agent": "high" } })),
    (error) => error.code === "INVALID_EFFORT_MAP",
  )
})

test("install promotes the default OpenSpec route only when CLI and its read-only project probe are ready", async () => {
  const projectRoot = await tempProject()
  const fakeOpenSpec = path.join(projectRoot, "fake-openspec")
  await writeFile(fakeOpenSpec, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'OpenSpec 0.22.0'; else echo '{\"changes\":[]}'; fi\n")
  await chmod(fakeOpenSpec, 0o755)
  await mkdir(path.join(projectRoot, "openspec/specs"), { recursive: true })
  await mkdir(path.join(projectRoot, "openspec/changes"), { recursive: true })
  await writeFile(path.join(projectRoot, "openspec/config.yaml"), "schema: spec-driven\n")

  const result = await manageOpenCodePlugin("install", options(projectRoot, { openspecCommand: fakeOpenSpec }))
  assert.equal(result.spec.ready, true)
  assert.equal(result.spec.cliVersion, "OpenSpec 0.22.0")
  assert.equal(result.spec.initialized, true)
  const config = JSON.parse(await readFile(path.join(projectRoot, ".team-work/config.yaml"), "utf8"))
  assert.deepEqual(config.spec, { type: "openspec", skill: "openspec", root: "openspec/", status: "ready" })
})

test("install and update synchronize a stale ready OpenSpec route back to missing", async () => {
  const projectRoot = await tempProject()
  const fakeOpenSpec = path.join(projectRoot, "fake-openspec")
  await writeFile(fakeOpenSpec, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'OpenSpec 0.22.0'; else echo '{\"changes\":[]}'; fi\n")
  await chmod(fakeOpenSpec, 0o755)
  await mkdir(path.join(projectRoot, "openspec"), { recursive: true })
  await writeFile(path.join(projectRoot, "openspec/config.yaml"), "schema: spec-driven\n")
  await manageOpenCodePlugin("install", options(projectRoot, { openspecCommand: fakeOpenSpec }))

  const missingCommand = path.join(projectRoot, "missing-openspec")
  const repeated = await manageOpenCodePlugin("install", options(projectRoot, { openspecCommand: missingCommand }))
  assert.equal(repeated.spec.ready, false)
  assert.equal(repeated.spec.status, "missing")
  const config = JSON.parse(await readFile(path.join(projectRoot, ".team-work/config.yaml"), "utf8"))
  assert.equal(config.spec.status, "missing")
})

test("OpenSpec config-only pointer projects rely on the CLI probe instead of local planning directories", async () => {
  const projectRoot = await tempProject()
  const fakeOpenSpec = path.join(projectRoot, "fake-openspec")
  await writeFile(fakeOpenSpec, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'OpenSpec 2.0.0'; else echo '{\"changes\":[]}'; fi\n")
  await chmod(fakeOpenSpec, 0o755)
  await mkdir(path.join(projectRoot, "openspec"), { recursive: true })
  await writeFile(path.join(projectRoot, "openspec/config.yaml"), "store: team-context\n")

  const installed = await manageOpenCodePlugin("install", options(projectRoot, { openspecCommand: fakeOpenSpec }))
  assert.equal(installed.spec.ready, true)
  assert.equal(installed.spec.probeReady, true)
  assert.equal(await exists(path.join(projectRoot, "openspec/specs")), false)
  assert.equal(await exists(path.join(projectRoot, "openspec/changes")), false)
})

test("OpenSpec projects without the optional config file can be ready when the CLI probe succeeds", async () => {
  const projectRoot = await tempProject()
  const fakeOpenSpec = path.join(projectRoot, "fake-openspec")
  await writeFile(fakeOpenSpec, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'OpenSpec 2.0.0'; else echo '{\"changes\":[]}'; fi\n")
  await chmod(fakeOpenSpec, 0o755)
  await mkdir(path.join(projectRoot, "openspec/specs"), { recursive: true })
  await mkdir(path.join(projectRoot, "openspec/changes"), { recursive: true })

  const installed = await manageOpenCodePlugin("install", options(projectRoot, { openspecCommand: fakeOpenSpec }))
  assert.equal(installed.spec.ready, true)
  assert.equal(installed.spec.configPresent, false)
})

test("a CLI-resolved default store can be ready without a local OpenSpec root or doctor contradiction", async () => {
  const projectRoot = await tempProject()
  const fakeOpenSpec = path.join(projectRoot, "fake-openspec")
  await writeFile(fakeOpenSpec, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'OpenSpec 2.0.0'; else echo '{\"changes\":[]}'; fi\n")
  await chmod(fakeOpenSpec, 0o755)

  const installed = await manageOpenCodePlugin("install", options(projectRoot, { openspecCommand: fakeOpenSpec }))
  assert.equal(installed.spec.ready, true)
  assert.equal(installed.spec.rootPresent, false)
  assert.equal(installed.warnings.some((warning) => /尚未初始化/.test(warning)), false)
  const diagnosis = await manageOpenCodePlugin("doctor", options(projectRoot, { openspecCommand: fakeOpenSpec }))
  assert.equal(diagnosis.status, "ok")
  assert.equal(diagnosis.issues.some(({ code }) => code === "OPENSPEC_NOT_INITIALIZED"), false)
})

test("a zero exit status without the documented OpenSpec JSON shape never marks the route ready", async () => {
  const projectRoot = await tempProject()
  await mkdir(path.join(projectRoot, "openspec"), { recursive: true })
  const installed = await manageOpenCodePlugin("install", options(projectRoot, { openspecCommand: "/usr/bin/true" }))
  assert.equal(installed.spec.ready, false)
  assert.equal(installed.spec.probeReady, false)
  assert.match(installed.spec.probeError, /JSON|changes/)
})

test("missing OpenSpec prerequisites stay recoverable and doctor reports precise remediation", async () => {
  const projectRoot = await tempProject()
  const missingCommand = path.join(projectRoot, "missing-openspec")
  const installed = await manageOpenCodePlugin("install", options(projectRoot, { openspecCommand: missingCommand }))
  assert.equal(installed.spec.ready, false)
  assert.equal(installed.spec.cliAvailable, false)
  assert.equal(installed.spec.initialized, false)
  assert.ok(installed.warnings.some((warning) => /OpenSpec CLI/.test(warning)))
  assert.ok(installed.warnings.some((warning) => /openspec init/.test(warning)))
  const config = JSON.parse(await readFile(path.join(projectRoot, ".team-work/config.yaml"), "utf8"))
  assert.equal(config.spec.status, "missing")

  const diagnosis = await manageOpenCodePlugin("doctor", options(projectRoot, { openspecCommand: missingCommand }))
  assert.ok(diagnosis.issues.some(({ code }) => code === "OPENSPEC_CLI_MISSING"))
  assert.ok(diagnosis.issues.some(({ code }) => code === "OPENSPEC_NOT_INITIALIZED"))
})

test("custom or disabled SPEC routes are preserved and never diagnosed as missing OpenSpec", async () => {
  const projectRoot = await tempProject()
  await manageOpenCodePlugin("install", options(projectRoot))
  const configPath = path.join(projectRoot, ".team-work/config.yaml")
  const config = JSON.parse(await readFile(configPath, "utf8"))
  config.spec = { type: "spec-kit", skill: "spec-kit", root: "specs/", status: "ready" }
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)

  const diagnosis = await manageOpenCodePlugin("doctor", options(projectRoot, { openspecCommand: path.join(projectRoot, "missing") }))
  assert.equal(diagnosis.spec.managed, false)
  assert.equal(diagnosis.issues.some(({ code }) => code.startsWith("OPENSPEC_")), false)
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).spec, config.spec)
})

test("OpenSpec readiness refuses a symlinked project config marker", async () => {
  const projectRoot = await tempProject()
  const fakeOpenSpec = path.join(projectRoot, "fake-openspec")
  await writeFile(fakeOpenSpec, "#!/bin/sh\necho 'OpenSpec 0.22.0'\n")
  await chmod(fakeOpenSpec, 0o755)
  const outside = await mkdtemp(path.join(os.tmpdir(), "team-work-openspec-outside-"))
  await mkdir(path.join(projectRoot, "openspec"), { recursive: true })
  const outsideConfig = path.join(outside, "config.yaml")
  await writeFile(outsideConfig, "schema: spec-driven\n")
  await symlink(outsideConfig, path.join(projectRoot, "openspec/config.yaml"))

  const installed = await manageOpenCodePlugin("install", options(projectRoot, { openspecCommand: fakeOpenSpec }))
  assert.equal(installed.spec.ready, false)
  assert.equal(installed.spec.rootSafe, false)
  const diagnosis = await manageOpenCodePlugin("doctor", options(projectRoot, { openspecCommand: fakeOpenSpec }))
  assert.ok(diagnosis.issues.some(({ code }) => code === "OPENSPEC_ROOT_UNSAFE"))
})

test("install refuses a symlinked Runtime project config before reading or replacing it", async () => {
  const projectRoot = await tempProject()
  const outside = path.join(await mkdtemp(path.join(os.tmpdir(), "team-work-config-outside-")), "config.json")
  const content = `${JSON.stringify({ spec: { type: "openspec", skill: "openspec", root: "openspec/", status: "missing" } })}\n`
  await writeFile(outside, content)
  await mkdir(path.join(projectRoot, ".team-work"), { recursive: true })
  await symlink(outside, path.join(projectRoot, ".team-work/config.yaml"))

  await assert.rejects(
    manageOpenCodePlugin("install", options(projectRoot)),
    (error) => error.code === "UNSAFE_PATH",
  )
  assert.equal(await readFile(outside, "utf8"), content)
  assert.equal(await exists(path.join(projectRoot, ".opencode/plugins/team-work.js")), false)
})

test("update repairs missing managed files and doctor reports drift", async () => {
  const projectRoot = await tempProject()
  await manageOpenCodePlugin("install", options(projectRoot))
  const target = path.join(projectRoot, ".opencode/plugins/team-work.js")
  await rm(target)
  const diagnosis = await manageOpenCodePlugin("doctor", options(projectRoot))
  assert.equal(diagnosis.status, "issues")
  assert.ok(diagnosis.issues.some(({ code, path: relativePath }) => code === "MANAGED_FILE_MISSING" && relativePath === ".opencode/plugins/team-work.js"))

  const repaired = await manageOpenCodePlugin("update", options(projectRoot))
  assert.equal(repaired.status, "updated")
  assert.equal(await exists(target), true)
})

test("unresolved model aliases remain visible but do not create unusable agents", async () => {
  const projectRoot = await tempProject()
  const result = await manageOpenCodePlugin("install", options(projectRoot, { modelMap: undefined, availableModels: ["gateway/gpt-5.6-terra"] }))
  assert.ok(result.warnings.length >= 6)
  assert.equal(await exists(path.join(projectRoot, ".opencode/agents/senior-terra.md")), true)
  assert.equal(await exists(path.join(projectRoot, ".opencode/agents/expert-opus.md")), false)
  const profile = JSON.parse(await readFile(path.join(projectRoot, ".team-work/platform/opencode/profile.json"), "utf8"))
  assert.equal(profile.agents.find(({ id }) => id === "expert-opus").resolvedModel, null)
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
  assert.equal(await exists(path.join(projectRoot, ".opencode/plugins/team-work.js")), false)
  assert.equal(await exists(path.join(projectRoot, ".team-work/platform/opencode/install.json")), false)
  assert.equal(await exists(path.join(projectRoot, ".team-work/config.yaml")), false)
  assert.equal(await exists(path.join(projectRoot, ".team-work/workflows/engineering.json")), false)
  assert.equal(await exists(path.join(projectRoot, ".team-work/tasks")), false)
  assert.equal(await readFile(fakeOpenCode, "utf8"), "#!/bin/sh\nexit 23\n")
})

test("tampered manifest cannot claim and delete arbitrary project files", async () => {
  const projectRoot = await tempProject()
  const readme = path.join(projectRoot, "README.md")
  const content = "user project\n"
  await writeFile(readme, content)
  const manifest = path.join(projectRoot, ".team-work/platform/opencode/install.json")
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
  const note = path.join(projectRoot, ".opencode/skills/team-work/user-notes.md")
  const content = "user note\n"
  await mkdir(path.dirname(note), { recursive: true })
  await writeFile(note, content)
  const manifest = path.join(projectRoot, ".team-work/platform/opencode/install.json")
  await mkdir(path.dirname(manifest), { recursive: true })
  await writeFile(manifest, `${JSON.stringify({
    schemaVersion: "1.0",
    platform: "opencode",
    status: "installed",
    managedFiles: [{ path: ".opencode/skills/team-work/user-notes.md", sha256: createHash("sha256").update(content).digest("hex") }],
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
  const plugin = path.join(projectRoot, ".opencode/plugins/team-work.js")
  await writeFile(plugin, "// local change\n")
  const outside = await mkdtemp(path.join(os.tmpdir(), "team-work-outside-"))
  const backupRoot = path.join(projectRoot, ".team-work/platform/opencode/backups")
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
  const managed = path.join(projectRoot, ".opencode/agents/expert-k3.md")
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
  const target = path.join(projectRoot, ".opencode/plugins/team-work.js")
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
  const activeLock = path.join(activeProject, ".team-work/platform/opencode/.lifecycle.lock")
  await mkdir(path.dirname(activeLock), { recursive: true })
  await writeFile(activeLock, `${JSON.stringify({ pid: process.pid })}\n`)
  await assert.rejects(
    manageOpenCodePlugin("install", options(activeProject)),
    (error) => error.code === "INSTALL_LOCKED",
  )
  await rm(activeLock)

  const staleProject = await tempProject()
  const staleLock = path.join(staleProject, ".team-work/platform/opencode/.lifecycle.lock")
  await mkdir(path.dirname(staleLock), { recursive: true })
  await writeFile(staleLock, `${JSON.stringify({ pid: 2147483647 })}\n`)
  assert.equal((await manageOpenCodePlugin("install", options(staleProject))).status, "installed")
  assert.equal(await exists(staleLock), false)

  const corruptProject = await tempProject()
  const corruptLock = path.join(corruptProject, ".team-work/platform/opencode/.lifecycle.lock")
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

  const target = path.join(projectRoot, ".opencode/plugins/team-work.js")
  const previous = await readFile(target, "utf8")
  const updatedSource = await mkdtemp(path.join(os.tmpdir(), "team-work-source-"))
  await copySourceFixture(sourceRoot, updatedSource)
  await writeFile(path.join(updatedSource, "plugins/opencode/assets/team-work.js"), `${previous}\n// next release\n`)

  const result = await manageOpenCodePlugin("update", options(projectRoot, { sourceRoot: updatedSource }))
  assert.equal(result.status, "updated")
  assert.ok(result.backupPath)
  assert.equal(await readFile(path.join(result.backupPath, ".opencode/plugins/team-work.js"), "utf8"), previous)
  assert.match(await readFile(target, "utf8"), /next release/)
})

test("generatedAt does not turn a repeated install into a false update", async () => {
  const projectRoot = await tempProject()
  await manageOpenCodePlugin("install", options(projectRoot, { now: () => new Date("2026-08-11T08:00:00.000Z") }))
  const repeated = await manageOpenCodePlugin("install", options(projectRoot, { now: () => new Date("2027-01-01T00:00:00.000Z") }))
  assert.equal(repeated.status, "unchanged")
  const profile = JSON.parse(await readFile(path.join(projectRoot, ".team-work/platform/opencode/profile.json"), "utf8"))
  assert.equal(profile.generatedAt, "2026-08-11T08:00:00.000Z")
})

test("update never overwrites a new-path user collision without backup", async () => {
  const projectRoot = await tempProject()
  await manageOpenCodePlugin("install", options(projectRoot))
  const updatedSource = await mkdtemp(path.join(os.tmpdir(), "team-work-source-"))
  await copySourceFixture(sourceRoot, updatedSource)
  const relativePath = ".opencode/skills/team-work/references/new-guide.md"
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
  const collision = path.join(collisionProject, ".opencode/plugins/team-work.js")
  await mkdir(path.dirname(collision), { recursive: true })
  await writeFile(collision, "// user plugin\n")
  await assert.rejects(
    manageOpenCodePlugin("install", options(collisionProject)),
    (error) => error.code === "INSTALL_COLLISION",
  )
  assert.equal(await readFile(collision, "utf8"), "// user plugin\n")

  const projectRoot = await tempProject()
  await manageOpenCodePlugin("install", options(projectRoot))
  const managed = path.join(projectRoot, ".opencode/plugins/team-work.js")
  await writeFile(managed, "// local customization\n")
  await assert.rejects(
    manageOpenCodePlugin("update", options(projectRoot)),
    (error) => error.code === "MANAGED_FILE_MODIFIED",
  )
  assert.equal(await readFile(managed, "utf8"), "// local customization\n")

  const forced = await manageOpenCodePlugin("update", options(projectRoot, { force: true }))
  assert.equal(forced.status, "updated")
  assert.equal(await readFile(path.join(forced.backupPath, ".opencode/plugins/team-work.js"), "utf8"), "// local customization\n")
})

test("uninstall removes only managed files and preserves task data and user files", async () => {
  const projectRoot = await tempProject()
  await manageOpenCodePlugin("install", options(projectRoot))
  const taskArtifact = path.join(projectRoot, ".team-work/tasks/task-1/artifacts/review.md")
  const userPlugin = path.join(projectRoot, ".opencode/plugins/my-plugin.js")
  const userConfig = path.join(projectRoot, "opencode.json")
  await mkdir(path.dirname(taskArtifact), { recursive: true })
  await writeFile(taskArtifact, "keep task\n")
  await writeFile(userPlugin, "// keep plugin\n")
  await writeFile(userConfig, "{}\n")

  const result = await manageOpenCodePlugin("uninstall", options(projectRoot))
  assert.equal(result.status, "uninstalled")
  assert.equal(await exists(path.join(projectRoot, ".opencode/plugins/team-work.js")), false)
  assert.equal(await exists(path.join(projectRoot, ".opencode/team-work")), false)
  assert.equal(await readFile(taskArtifact, "utf8"), "keep task\n")
  assert.equal(await readFile(userPlugin, "utf8"), "// keep plugin\n")
  assert.equal(await readFile(userConfig, "utf8"), "{}\n")

  const tombstone = JSON.parse(await readFile(path.join(projectRoot, ".team-work/platform/opencode/install.json"), "utf8"))
  assert.equal(tombstone.status, "uninstalled")
  assert.deepEqual(tombstone.managedFiles, [])
})

test("uninstall retains modified managed files by default and force backs them up before removal", async () => {
  const projectRoot = await tempProject()
  await manageOpenCodePlugin("install", options(projectRoot))
  const managed = path.join(projectRoot, ".opencode/plugins/team-work.js")
  await writeFile(managed, "// preserve my changes\n")

  const safe = await manageOpenCodePlugin("uninstall", options(projectRoot))
  assert.equal(safe.status, "partial")
  assert.deepEqual(safe.retained, [".opencode/plugins/team-work.js"])
  assert.equal(await exists(managed), true)

  const forced = await manageOpenCodePlugin("uninstall", options(projectRoot, { force: true }))
  assert.equal(forced.status, "uninstalled")
  assert.equal(await exists(managed), false)
  assert.equal(await readFile(path.join(forced.backupPath, ".opencode/plugins/team-work.js"), "utf8"), "// preserve my changes\n")
})

async function copySourceFixture(from, to) {
  const { cp } = await import("node:fs/promises")
  for (const relativePath of ["runtime", "schemas", "skills", "plugins/opencode/assets", "plugins/opencode/config", "plugins/opencode/guides", "plugins/opencode/src", "package.json"]) {
    await cp(path.join(from, relativePath), path.join(to, relativePath), { recursive: true })
  }
}
