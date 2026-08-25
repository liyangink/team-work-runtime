// 唯一市场制品装载验证：根 package.json → bundle patch → DSH loader。
import { execFile } from "node:child_process"
import { cp, mkdir, writeFile, symlink, rm } from "node:fs/promises"
import { promisify } from "node:util"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import assert from "node:assert/strict"

const run = promisify(execFile)
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")

test("唯一根制品：bundle 声明 → dump-config 装配树命中 + 零 warn", async () => {
  const home = path.join(os.tmpdir(), "tw-dsh-root-" + Date.now())
  const src = path.join(os.homedir(), ".dsh")
  const profileDir = path.join(home, "profiles", "web")
  await mkdir(profileDir, { recursive: true })
  for (const file of ["cordis.patch.yml", "cordis.yml", "pnpm-workspace.yaml"]) {
    await cp(path.join(src, "profiles", "web", file), path.join(profileDir, file)).catch(() => {})
  }
  const pkg = {
    name: "dsh-profile-web",
    private: true,
    dependencies: { "team-work-runtime": "file:" + repoRoot },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "team-work-runtime"] } },
  }
  await writeFile(path.join(profileDir, "package.json"), JSON.stringify(pkg, null, 2))
  const nodeModules = path.join(profileDir, "node_modules")
  await mkdir(nodeModules, { recursive: true })
  await symlink(repoRoot, path.join(nodeModules, "team-work-runtime"), "dir")
  await symlink(path.join(src, "profiles", "node_modules", "@deepseek-ai"), path.join(nodeModules, "@deepseek-ai"), "dir").catch(() => {})

  try {
    const { stdout, stderr } = await run("dsh", ["--profile", "web", "--dump-config"], {
      env: { ...process.env, DSH_HOME: home },
      timeout: 90000,
    }).catch((error) => ({ stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") }))
    const out = String(stdout)
    assert.ok(out.includes("id: team-work-dsh") && out.includes("name: team-work-runtime"),
      "装配树须含唯一根制品 entry：" + out.slice(-400))
    assert.ok(!String(stderr).includes("team-work"), "stderr 不得含插件相关 warn：" + String(stderr).slice(0, 300))
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})
