import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const run = promisify(execFile)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("one package CLI routes runtime and lifecycle commands", async () => {
  const version = await run(process.execPath, [path.join(projectRoot, "cli.mjs"), "version"], {
    cwd: projectRoot,
    encoding: "utf8",
  })
  const envelope = JSON.parse(version.stdout)
  assert.equal(envelope.ok, true)
  assert.equal(envelope.data.runtimeVersion, "0.1.0")

  const explicitRuntime = await run(process.execPath, [path.join(projectRoot, "cli.mjs"), "runtime", "version"], {
    cwd: projectRoot,
    encoding: "utf8",
  })
  assert.equal(JSON.parse(explicitRuntime.stdout).data.runtimeVersion, "0.1.0")

  await assert.rejects(
    run(process.execPath, [path.join(projectRoot, "cli.mjs"), "doctor", "--project", projectRoot], {
      cwd: projectRoot,
      encoding: "utf8",
    }),
    (error) => JSON.parse(error.stderr).code === "USER_CONFIG_MISSING",
  )
})

test("package bin exposes the unified CLI", async () => {
  const packageJson = await import("../package.json", { with: { type: "json" } })
  assert.deepEqual(packageJson.default.bin, { "team-work": "cli.mjs" })
  assert.equal(packageJson.default.private, undefined)
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
    "runtime/core.mjs",
    "schemas/task.schema.json",
    "skills/workflow/SKILL.md",
    "skills/team-work/SKILL.md",
    "plugins/opencode/src/lifecycle.mjs",
    "plugins/opencode/config/runtime-package-lock.json",
  ]) assert.ok(names.has(required), `npm package is missing ${required}`)
  for (const excluded of ["USAGE.md", "AGENTS.md", "tests/user-config.test.mjs", "archive/legacy-omo/SKILL.md"]) {
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
