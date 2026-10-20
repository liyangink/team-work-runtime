// 唯一市场制品：官方初始化的隔离 profile + 显式新版 CLI 装配与 schema 验证。
import { execFile } from "node:child_process"
import { readFile, mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises"
import { promisify } from "node:util"
import { createRequire } from "node:module"
import { pathToFileURL, fileURLToPath } from "node:url"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import assert from "node:assert/strict"

const run = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("唯一根制品：新版隔离 profile 的 bundle 与 Config schema 可装配", async (t) => {
  const host = process.env.DSH_TEST_HOST
  if (!host) { t.skip("未指定 DSH_TEST_HOST；新版隔离装配验证未执行"); return }
  const hostPackage = JSON.parse(await readFile(path.join(host, "package.json"), "utf8"))
  assert.equal(hostPackage.name, "@deepseek-ai/dsh")
  const require = createRequire(path.join(host, "package.json"))
  const { evaluatePluginCompatibility } = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-app-boot")).href)
  const pluginPackage = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"))
  assert.equal(evaluatePluginCompatibility(pluginPackage, {}, hostPackage.version), undefined, "实际宿主须通过当前根包的官方兼容检查")
  const home = await mkdtemp(path.join(os.tmpdir(), "twr-dsh-profile-"))
  const profileName = "profile-demo"
  const profileDir = path.join(home, "profiles", profileName)
  try {
    const { initializeProfileFromDefault } = await import(pathToFileURL(path.join(host, "lib", "profile-boot.js")).href)
    initializeProfileFromDefault(profileName, "web", home)
    const manifestPath = path.join(profileDir, "package.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    manifest.dependencies["team-work-runtime"] = "file:" + repoRoot
    manifest.dsh.profile.bundles.push("team-work-runtime")
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
    const modules = path.join(profileDir, "node_modules")
    await mkdir(modules, { recursive: true })
    await symlink(repoRoot, path.join(modules, "team-work-runtime"), "dir")
    await symlink(path.dirname(host), path.join(modules, "@deepseek-ai"), "dir")
    const bin = path.join(host, hostPackage.bin.dsh)
    const env = { ...process.env, DSH_HOME: home }
    const composed = await run(process.execPath, [bin, "--profile", profileName, "--dump-config"], { env, cwd: repoRoot, timeout: 30000 })
    assert.match(composed.stdout, /id: team-work-dsh/)
    assert.match(composed.stdout, /name: team-work-runtime/)
    assert.doesNotMatch(composed.stderr, /team-work/)
    // 完整 Web 模板含宿主自己的 group alias，schema CLI 对这些载体另有报错。
    // 此处独立核验根制品 Config；完整 Web 装配已由上方 dump-config 验证。
    manifest.dsh.profile.bundles = ["team-work-runtime"]
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
    const schema = await run(process.execPath, [bin, "--profile", profileName, "--dump-config-schema"], { env, cwd: repoRoot, timeout: 30000, maxBuffer: 8 * 1024 * 1024 }).catch((error) => {
      assert.equal(error.code, 1)
      assert.match(error.stderr, /^dsh: warning: \[\/0\] config\/tiers\/1: native schema type intersect is not statically projected\s*$/)
      return { stdout: error.stdout, stderr: error.stderr }
    })
    assert.match(schema.stdout, /team-work-dsh/)
    assert.match(schema.stdout, /tiers/)
    assert.doesNotMatch(schema.stderr, /team-work/)
    const projected = JSON.parse(schema.stdout)
    assert.equal(projected["x-cordis"].complete, false, "JSON Schema 明确不承诺投影 tiers intersect")
    assert.equal(projected["x-cordis"].diagnostics.length, 1)
    assert.equal(projected["x-cordis"].diagnostics[0].level, "warning")
    t.diagnostic("宿主输出 schema，但 tiers intersect 仍需原生 Schemastery 校验；这不是零警告的完整静态投影。")
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
