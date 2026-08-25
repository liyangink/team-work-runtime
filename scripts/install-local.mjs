#!/usr/bin/env node
// install-local.mjs — 插件本地安装（压缩包/目录两种来源，免 pnpm——手动装配等价 dsh plugin add）
// 用法：
//   node scripts/install-local.mjs                # 从仓库目录安装（symlink，开发期改动即时生效）
//   node scripts/install-local.mjs path/to/x.tgz  # 从压缩包安装（复制解压，适合分发）
//   node scripts/install-local.mjs --profile web  # 指定 profile（默认 web）
import { readFile, writeFile, symlink, mkdir, cp, rm, readdir } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import os from "node:os"
import path from "node:path"

const run = promisify(execFile)
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")

const argv = process.argv.slice(2)
const profileFlag = argv.indexOf("--profile")
const profile = profileFlag !== -1 ? argv[profileFlag + 1] : "web"
const source = argv.find((a) => !a.startsWith("--") && a !== profile)

const home = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh")
const profileDir = path.join(home, "profiles", profile)
const pkgPath = path.join(profileDir, "package.json")
const nm = path.join(profileDir, "node_modules")
const pkgName = "team-work-runtime-dsh"

async function main() {
  // 1) package.json：依赖声明 + bundle 条目
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"))
  pkg.dependencies = pkg.dependencies ?? {}
  pkg.dsh = pkg.dsh ?? { profile: { bundles: [] } }
  pkg.dsh.profile = pkg.dsh.profile ?? { bundles: [] }
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles ?? []
  const depValue = source && source.endsWith(".tgz")
    ? "file:" + path.resolve(source)                       // 压缩包：file: 指向 tgz（pnpm 装载时解开）
    : "file:" + (source ? path.resolve(source) : path.join(repoRoot, "packages", "dsh-plugin"))
  pkg.dependencies[pkgName] = depValue
  if (!pkg.dsh.profile.bundles.includes(pkgName)) pkg.dsh.profile.bundles.push(pkgName)
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + String.fromCharCode(10))
  console.log("OK package.json：" + pkgName + " 依赖与 bundle 条目已写入（profile: " + profile + "）")

  // 2) node_modules 装载
  await mkdir(nm, { recursive: true })
  const dest = path.join(nm, pkgName)
  await rm(dest, { recursive: true, force: true })
  if (source && source.endsWith(".tgz")) {
    // 压缩包：解压 package/ 到 dest（tgz 内根目录为 package/）
    const tmp = path.join(os.tmpdir(), "tw-plugin-install-" + Date.now())
    await mkdir(tmp, { recursive: true })
    await run("tar", ["-xzf", path.resolve(source), "-C", tmp])
    await cp(path.join(tmp, "package"), dest, { recursive: true })
    await rm(tmp, { recursive: true, force: true })
    console.log("OK 压缩包已解压装载：" + dest)
  } else {
    // 目录：symlink（开发期改动即时生效）
    await symlink(source ? path.resolve(source) : path.join(repoRoot, "packages", "dsh-plugin"), dest, "dir")
    console.log("OK symlink 装载：" + dest + "（源目录改动即时生效）")
  }

  console.log(String.fromCharCode(10) + "安装完成。重启 dsh 会话生效；验证：dsh --profile " + profile + " --dump-config | grep team-work-dsh")
  console.log("卸载：node scripts/uninstall-local.mjs --profile " + profile)
}

main().catch((e) => { console.error("安装失败：", e.message); process.exit(1) })
