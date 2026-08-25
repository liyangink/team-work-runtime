// e2e-root.test.mjs — 根包单包形态装载验证（市场 git 源码通道模型：根 package.json 即插件包）
// 方法：隔离 DSH_HOME → 复制 web profile 基础文件 → package.json 声明根包 bundle →
//      node_modules symlink 仓库根（模拟市场按根清单构建安装）→ dump-config 断言。
import { execFile } from "node:child_process"
import { cp, mkdir, writeFile, symlink, rm } from "node:fs/promises"
import { promisify } from "node:util"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import assert from "node:assert/strict"

const run = promisify(execFile)
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")

test("根包形态：bundle 声明 → dump-config 装配树命中 + 零 warn", async () => {
  const home = path.join(os.tmpdir(), "tw-dsh-root-" + Date.now())
  const src = path.join(os.homedir(), ".dsh")
  const profileDir = path.join(home, "profiles", "web")
  await mkdir(profileDir, { recursive: true })
  for (const f of ["cordis.patch.yml", "cordis.yml", "pnpm-workspace.yaml"]) {
    await cp(path.join(src, "profiles", "web", f), path.join(profileDir, f)).catch(() => {})
  }
  const pkg = {
    name: "dsh-profile-web",
    private: true,
    dependencies: { "team-work-runtime": "file:" + repoRoot },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "team-work-runtime"] } },
  }
  await writeFile(path.join(profileDir, "package.json"), JSON.stringify(pkg, null, 2))
  const nm = path.join(profileDir, "node_modules")
  await mkdir(nm, { recursive: true })
  await symlink(repoRoot, path.join(nm, "team-work-runtime"), "dir")
  await symlink(path.join(src, "profiles", "node_modules", "@deepseek-ai"), path.join(nm, "@deepseek-ai"), "dir").catch(() => {})

  const { stdout, stderr } = await run("dsh", ["--profile", "web", "--dump-config"], {
    env: { ...process.env, DSH_HOME: home },
    timeout: 90000,
  }).catch((e) => ({ stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") }))
  const out = String(stdout)
  assert.ok(out.includes("id: team-work-dsh") && out.includes("name: team-work-runtime"),
    "装配树须含根包插件 entry：" + out.slice(-400))
  assert.ok(!String(stderr).includes("team-work"), "stderr 不得含插件相关 warn：" + String(stderr).slice(0, 300))
  await rm(home, { recursive: true, force: true }).catch(() => {})
})
