// e2e-c1：真实 dsh 宿主装载验证（dump-config 装配树）
// 隔离 DSH_HOME → 复制 web profile → package.json 加插件依赖 + bundles 条目 → dump-config 断言
import { execFile } from "node:child_process"
import { cp, mkdir, writeFile, rm } from "node:fs/promises"
import { promisify } from "node:util"
import os from "node:os"
import path from "node:path"

const run = promisify(execFile)
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const LF = String.fromCharCode(10)

async function main() {
  const home = path.join(os.tmpdir(), "tw-dsh-e2ec-" + Date.now())
  const src = path.join(os.homedir(), ".dsh")
  await mkdir(path.join(home, "profiles"), { recursive: true })
  await cp(path.join(src, "profiles", "web"), path.join(home, "profiles", "web"), { recursive: true }).catch(() => {})
  await cp(path.join(src, "settings.yaml"), path.join(home, "settings.yaml")).catch(() => {})

  // 插件挂载 = profile 依赖 + bundles 条目（dsh plugin add 的等价手动形态）
  const profileDir = path.join(home, "profiles", "web")
  const pkg = {
    name: "dsh-profile-web",
    private: true,
    dependencies: { "team-work-runtime-dsh": "file:" + path.join(repoRoot, "packages", "dsh-plugin") },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "team-work-runtime-dsh"] } },
  }
  await writeFile(path.join(profileDir, "package.json"), JSON.stringify(pkg, null, 2))

  // pnpm install（经 npx --cache 通道——宿主 pnpm 不在 PATH 且 corepack enable 遇 EPERM）
  await run("npx", ["-y", "--cache", "/tmp/tw-npm-cache", "pnpm@9", "install", "--no-frozen-lockfile"], { cwd: profileDir, timeout: 300000 })
    .catch((e) => { throw new Error("pnpm install 失败: " + String(e.stderr ?? e.message).slice(0, 400)) })

  const { stdout } = await run("dsh", ["--profile", "web", "--dump-config"], {
    env: { ...process.env, DSH_HOME: home },
    timeout: 60000,
  }).catch((e) => ({ stdout: String(e.stdout ?? "") + String(e.stderr ?? "") }))
  const tree = String(stdout)
  if (!tree.includes("team-work")) {
    console.error("FAIL: 装配树不含插件。输出：")
    console.error(tree.slice(0, 1000) || "(空)")
    process.exit(1)
  }
  console.log("C1 OK 宿主装配树含 team-work 插件（pnpm install + dump-config 双层验证）")
  await rm(home, { recursive: true, force: true }).catch(() => {})
}

main().catch((e) => { console.error("C1 FAIL:", e.message); process.exit(1) })
