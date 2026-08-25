// e2e-c1：真实 dsh 宿主装载验证（dump-config 装配树）
// 方法：隔离 DSH_HOME → 复制 web profile → package.json 声明 bundle → node_modules symlink 挂载插件
//      （共享 hoist 层 @deepseek-ai 也 symlink——与 dsh flat fallback 解析一致）→ dump-config 断言。
// 注：不用 pnpm install（宿主 pnpm 缺失、corepack EPERM、npx 通道对 file: 依赖在此环境不可靠）——
//      symlink 与 pnpm file: 安装的装载效果等价（node_modules 解析路径相同），正式安装走 dsh plugin add。
import { execFile } from "node:child_process"
import { cp, mkdir, writeFile, symlink, rm } from "node:fs/promises"
import { promisify } from "node:util"
import os from "node:os"
import path from "node:path"

const run = promisify(execFile)
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")

async function main() {
  const home = path.join(os.tmpdir(), "tw-dsh-e2ec-" + Date.now())
  const src = path.join(os.homedir(), ".dsh")
  const profileDir = path.join(home, "profiles", "web")
  await mkdir(profileDir, { recursive: true })
  // profile 基础文件（patch/cordis/workspace 从用户 profile 拷贝）
  for (const f of ["cordis.patch.yml", "cordis.yml", "pnpm-workspace.yaml"]) {
    await cp(path.join(src, "profiles", "web", f), path.join(profileDir, f)).catch(() => {})
  }
  await cp(path.join(src, "settings.yaml"), path.join(home, "settings.yaml")).catch(() => {})
  // 声明 bundle（dsh plugin add 的等价 package.json 形态）
  const pkg = {
    name: "dsh-profile-web",
    private: true,
    dependencies: { "team-work-runtime-dsh": "file:" + path.join(repoRoot, "packages", "dsh-plugin") },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "team-work-runtime-dsh"] } },
  }
  await writeFile(path.join(profileDir, "package.json"), JSON.stringify(pkg, null, 2))
  // node_modules：插件 symlink + 共享 hoist 层 @deepseek-ai symlink（dsh flat fallback 同源）
  const nm = path.join(profileDir, "node_modules")
  await mkdir(nm, { recursive: true })
  await symlink(path.join(repoRoot, "packages", "dsh-plugin"), path.join(nm, "team-work-runtime-dsh"), "dir")
  const sharedDeps = path.join(src, "profiles", "node_modules", "@deepseek-ai")
  await symlink(sharedDeps, path.join(nm, "@deepseek-ai"), "dir").catch(() => {})

  const { stdout, stderr } = await run("dsh", ["--profile", "web", "--dump-config"], {
    env: { ...process.env, DSH_HOME: home },
    timeout: 90000,
  }).catch((e) => ({ stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") }))
  // 断言真装载：stdout 装配树须同时含 entry id 与包名行（旧断言合并 stderr，曾把
  // "patch: entry not found" 的 warn 误判为装载成功——纯 stdout 才是装配树）。
  const out = String(stdout)
  if (!(out.includes("id: team-work-dsh") && out.includes("name: team-work-runtime-dsh"))) {
    console.error("FAIL: 装配树不含插件 entry。stdout 片段：")
    console.error(out.slice(0, 800) || "(空)")
    console.error("stderr 片段（含 patch warn 时为 patch 行未生效）：")
    console.error(String(stderr).slice(0, 400) || "(空)")
    process.exit(1)
  }
  if (String(stderr).includes("team-work-dsh") && String(stderr).includes("not found")) {
    console.error("FAIL: patch 行被判 not found（写法回退或 bundle 未收集）")
    process.exit(1)
  }
  console.log("C1 OK 宿主装配树含 team-work-dsh entry（insert 行 + 按包名解析）")
  await rm(home, { recursive: true, force: true }).catch(() => {})
}

main().catch((e) => { console.error("C1 FAIL:", e.message); process.exit(1) })
