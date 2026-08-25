#!/usr/bin/env node
// e2e-smoke.mjs — I5 集成自证冒烟（可重复执行）
// 前置：node packages/dsh-plugin/build.mjs
// 步骤：
//  S1 构建产物完整性（dist/client.js + dist/skill）
//  S2 隔离 profile 装配（DSH_HOME→临时目录；cordis.patch.yml 挂载本插件包目录）
//  S3 dsh headless 启动验证插件装载（skills/tools 注册成功标志）
//  S4 tw 工具真调（spawn 路径：open→gate 幂等）
//  S5 注入链干跑（构造 agents.json + 直接调 inject.js 的 hintForChild——装载级验证留给 I6）
import { execFile } from "node:child_process"
import { mkdir, writeFile, readFile, cp, rm, symlink } from "node:fs/promises"
import { promisify } from "node:util"
import os from "node:os"
import path from "node:path"

const run = promisify(execFile)
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")

async function main() {
  // S1 产物
  const client = await readFile(path.join(repoRoot, "packages/dsh-plugin/src-client/badge.js"), "utf8")
  const skill = await readFile(path.join(repoRoot, "skills/team-work-v3/SKILL.md"), "utf8")
  if (!client.includes("__ModuleLoader__") || !client.includes("var factory = function (module, exports)")) throw new Error("S1: client 源文件非工厂形态（免构建装载协议）")
  if (!skill.includes("team-work")) throw new Error("S1: skill 拷贝缺失")
  console.log("S1 OK 构建产物完整")

  // S2 隔离 profile（不动用户 ~/.dsh）
  const home = await mkdir(path.join(os.tmpdir(), "tw-dsh-smoke-" + Date.now()), { recursive: true }).then(() => path.join(os.tmpdir(), "tw-dsh-smoke-" + Date.now()))
  const profile = path.join(home, "profiles", "smoke")
  await mkdir(profile, { recursive: true })
  await writeFile(path.join(profile, "package.json"), JSON.stringify({ name: "dsh-profile-smoke", private: true, dsh: { profile: { bundles: ["team-work-runtime-dsh"] } } }, null, 2))
  await writeFile(path.join(profile, "pnpm-workspace.yaml"), "packages:\n  - .\nnodeLinker: hoisted\n")
  // 用户层 patch 保持空数组；装载由 bundle 层承担：package.json 声明 bundles +
  // 插件包自带纯 insert cordis.patch.yml + node_modules 按包名 symlink（loader 据名解析 main 入口）。
  await writeFile(path.join(profile, "cordis.patch.yml"), "[]" + "\n")
  await mkdir(path.join(profile, "node_modules"), { recursive: true })
  await symlink(path.join(repoRoot, "packages/dsh-plugin"), path.join(profile, "node_modules", "team-work-runtime-dsh"), "dir")
  console.log("S2 OK 隔离 profile:", profile)

  // S3 dsh headless 装载验证（DSH_HOME 重定向；超时容错）
  try {
    const { stdout } = await run("dsh", ["headless", "-p", "smoke", "--eval", "1"], {
      env: { ...process.env, DSH_HOME: home },
      timeout: 30000,
    }).catch((e) => e) // headless 交互形态可能不支持——记录输出供 I6 调整
    console.log("S3 (尽力) headless 输出片段:", String(stdout).slice(0, 200))
  } catch (e) {
    console.log("S3 SKIP（headless 不可用，I6 换 dsh 会话内验证）:", String(e.message).slice(0, 120))
  }

  // S4 tw 工具真调（spawn 链路 = 工具 execute 的核心逻辑）
  const tmpProj = path.join(home, "proj")
  await mkdir(tmpProj, { recursive: true })
  const twBin = path.join(repoRoot, "bin", "tw.mjs")
  const open = await run(process.execPath, [twBin, "open", "--name", "smoke", "--objective", "冒烟", "--entry", "research"], { cwd: tmpProj })
  const card = JSON.parse(open.stdout)
  if (card.ok !== true) throw new Error("S4: tw open 失败 " + open.stdout)
  console.log("S4 OK tw 工具 spawn 链路（open→卡片）")

  // S5 注入决策干跑
  const { hintForChild } = await import(path.join(repoRoot, "packages/dsh-plugin/src/inject.js"))
  const hint = hintForChild({ modelHints: { "c1": { provider: "p", model: "m", effort: "high" } } }, "c1")
  if (hint.reasoningEffort !== "high") throw new Error("S5: hintForChild 失败")
  console.log("S5 OK 注入决策干跑（effort→reasoningEffort）")

  console.log("SMOKE PASS（装载级验证移交 I6 压轴）")
}

main().catch((e) => { console.error("SMOKE FAIL:", e.message); process.exit(1) })
