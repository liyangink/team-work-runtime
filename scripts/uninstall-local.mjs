#!/usr/bin/env node
// uninstall-local.mjs — 卸载本地安装的插件（还原 package.json 与 node_modules）
import { readFile, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const argv = process.argv.slice(2)
const profileFlag = argv.indexOf("--profile")
const profile = profileFlag !== -1 ? argv[profileFlag + 1] : "web"
const pkgName = "team-work-runtime-dsh"

const home = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh")
const profileDir = path.join(home, "profiles", profile)
const pkgPath = path.join(profileDir, "package.json")

const pkg = JSON.parse(await readFile(pkgPath, "utf8"))
if (pkg.dependencies) delete pkg.dependencies[pkgName]
if (pkg.dsh?.profile?.bundles) pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== pkgName)
await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + String.fromCharCode(10))
await rm(path.join(profileDir, "node_modules", pkgName), { recursive: true, force: true })
console.log("已卸载（profile: " + profile + "）。重启 dsh 会话生效。")
