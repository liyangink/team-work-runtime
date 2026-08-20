import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const run = promisify(execFile)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("one package CLI routes runtime and lifecycle commands", async () => {
  const explicitRuntime = await run(process.execPath, [path.join(projectRoot, "cli.mjs"), "runtime", "version"], {
    cwd: projectRoot,
    encoding: "utf8",
  })
  assert.deepEqual(JSON.parse(explicitRuntime.stdout).data, { runtimeMajor: 2, schemaVersion: "2.0" })

  await assert.rejects(
    run(process.execPath, [path.join(projectRoot, "cli.mjs"), "doctor"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: { ...process.env, XDG_CONFIG_HOME: await mkdtemp(path.join(os.tmpdir(), "team-work-empty-config-")) },
    }),
    (error) => JSON.parse(error.stderr).code === "USER_CONFIG_MISSING",
  )
})

test("package bin exposes the unified CLI", async () => {
  const packageJson = await import("../package.json", { with: { type: "json" } })
  assert.deepEqual(packageJson.default.bin, { "team-work": "cli.mjs" })
  assert.equal(packageJson.default.private, undefined)
})

test("Runtime inspect rejects a v1 project before reading task state", async () => {
  const oldProject = await mkdtemp(path.join(os.tmpdir(), "team-work-cli-v1-"))
  await mkdir(path.join(oldProject, ".team-work"))
  await writeFile(path.join(oldProject, ".team-work", "project.json"), `${JSON.stringify({ runtimeMajor: 1, schemaVersion: "1.0" })}\n`)

  await assert.rejects(
    run(process.execPath, [path.join(projectRoot, "cli.mjs"), "runtime", "inspect", "--project", oldProject, "--task", "legacy-task"], { encoding: "utf8" }),
    (error) => JSON.parse(error.stderr).code === "RUNTIME_MAJOR_MISMATCH",
  )
})

test("npm package contains every installer input and excludes repository-only assets", async () => {
  const npmCache = await mkdtemp(path.join(os.tmpdir(), "team-work-npm-cache-"))
  const packed = await run("npm", ["pack", "--dry-run", "--json"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, NPM_CONFIG_CACHE: npmCache },
  })
  const [{ files }] = JSON.parse(packed.stdout)
  const names = new Set(files.map(({ path: filePath }) => filePath))
  for (const required of [
    "cli.mjs",
    "installer/cli.mjs",
    "installer/user-config.mjs",
    "runtime/application/runtime-facade.mjs",
    "runtime/persistence/file-artifact-repository.mjs",
    "schemas/v2/task-state.schema.json",
    "schemas/user-config.v1.schema.json",
    "skills/workflow/SKILL.md",
    "skills/team-work/SKILL.md",
    "plugins/opencode/src/lifecycle.mjs",
    "plugins/opencode/src/activation.mjs",
    "plugins/opencode/src/agent-config.mjs",
    "plugins/opencode/adapter/runtime-host.mjs",
    "plugins/opencode/context/hooks.mjs",
    "plugins/opencode/tools/index.mjs",
    "plugins/opencode/config/runtime-package-lock.json",
  ]) assert.ok(names.has(required), `npm package is missing ${required}`)
  for (const removed of ["runtime/core.mjs", "plugins/opencode/src/lead-controller.mjs", "plugins/opencode/src/opencode-adapter.mjs", "schemas/task.schema.json"]) {
    assert.equal(names.has(removed), false, `npm package still contains removed v1 asset ${removed}`)
  }
  for (const excluded of ["USAGE.md", "AGENTS.md", "tests/user-config.test.mjs", "docs/runtime-roadmap.md"]) {
    assert.equal(names.has(excluded), false, `npm package includes repository-only ${excluded}`)
  }

  const rootLock = JSON.parse(await readFile(path.join(projectRoot, "package-lock.json"), "utf8"))
  const runtimeLock = JSON.parse(await readFile(path.join(projectRoot, "plugins/opencode/config/runtime-package-lock.json"), "utf8"))
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"))
  assert.deepEqual(runtimeLock.packages[""], {
    name: packageJson.name,
    version: packageJson.version,
    dependencies: packageJson.dependencies,
  })
  for (const [name, entry] of Object.entries(rootLock.packages)) {
    if (name) assert.deepEqual(runtimeLock.packages[name], entry, `${name} differs in packaged runtime lock`)
  }
})
