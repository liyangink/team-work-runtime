#!/usr/bin/env node
// 导出隔离评测原始证据并生成索引：事件流、会话日志、任务报告、确认卡、事实 JSON、隔离指纹。
// 用法：export-evidence.mjs <eval-root> <repo-root> <results-raw-dir> [preflight-json]
// 只从 eval-root、repo 的 evals 目录和调用方给的 preflight 文件复制；不读取或复制凭据。
import { readdirSync, statSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { join, relative, dirname } from "node:path"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"

const [evalRoot, repoRoot, rawDir, preflightJson] = process.argv.slice(2)
if (!evalRoot || !repoRoot || !rawDir) {
  console.error("usage: export-evidence.mjs <eval-root> <repo-root> <results-raw-dir> [preflight-json]")
  process.exit(2)
}
mkdirSync(rawDir, { recursive: true })
function copyInto(src, destRel) {
  const dest = join(rawDir, destRel)
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(src, dest)
}
// 1. 场景任务输入（与运行副本同源）
const taskDir = join(repoRoot, "evals/glm53-latest-eval/code/tasks")
for (const name of readdirSync(taskDir).filter((f) => f.endsWith(".md")).sort()) copyInto(join(taskDir, name), "task-" + name)
// 2. 隔离根证据（事件流、退出码、meta、指纹）
const evid = join(evalRoot, "evidence")
for (const name of readdirSync(evid).sort()) {
  const p = join(evid, name)
  if (!statSync(p).isFile()) continue
  if (name.endsWith(".jsonl") || name.endsWith(".err") || name.endsWith(".exit") || name.endsWith(".meta") || name === "isolation-env.txt" || name === "source-files.sha256" || name === "loaded-files.sha256") {
    copyInto(p, "sessions/" + name)
  }
}
// 3. 会话日志（含子会话）
const sessionsDir = join(evalRoot, "home/.dsh/sessions")
function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (name.endsWith(".jsonl.zstd")) out.push(p)
  }
  return out
}
for (const p of walk(sessionsDir).sort()) copyInto(p, "session-logs/" + relative(sessionsDir, p).split("\\").join("/"))
// 4. 隔离项目内的任务事实（虚构数据）：报告、journal、计划与确认记录
const tasksDir = join(evalRoot, "project/.team-work/tasks")
if (existsSync(tasksDir)) {
  for (const task of readdirSync(tasksDir).sort()) {
    const taskRoot = join(tasksDir, task)
    if (!statSync(taskRoot).isDirectory()) continue
    for (const name of readdirSync(taskRoot).sort()) {
      const p = join(taskRoot, name)
      if (!statSync(p).isFile()) continue
      if (["journal.jsonl", "decisions.json", "packages.json", "scope.json", "intent.json", "agents.json"].includes(name)) copyInto(p, "task-reports/" + task + "/" + name)
    }
    const reports = join(taskRoot, "reports")
    if (existsSync(reports)) for (const name of readdirSync(reports).sort()) copyInto(join(reports, name), "task-reports/" + task + "/reports/" + name)
  }
}
// 5. 预检与复现输出
if (preflightJson && existsSync(preflightJson)) copyInto(preflightJson, "preflight-cli.json")
// 6. 事实 JSON 与场景分析
const factsFile = join(rawDir, "session-facts.json")
execFileSync(process.execPath, [join(repoRoot, "evals/glm53-latest-eval/code/record-session-facts.mjs"), evalRoot, repoRoot, factsFile], { stdio: "inherit" })
const analyzeFile = join(rawDir, "analyze-scenarios.json")
execFileSync(process.execPath, [join(repoRoot, "evals/glm53-latest-eval/code/analyze-scenarios.mjs"), evalRoot, factsFile, analyzeFile], { stdio: "inherit" })
// 7. 索引 rawDir 下全部文件
function walkAll(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walkAll(p))
    else out.push(p)
  }
  return out
}
const files = walkAll(rawDir).filter((p) => !p.endsWith("/index.json")).sort().map((p) => ({
  path: relative(rawDir, p).split("\\").join("/"), bytes: statSync(p).size,
  sha256: createHash("sha256").update(readFileSync(p)).digest("hex"),
}))
writeFileSync(join(rawDir, "index.json"), JSON.stringify({ generatedAt: new Date().toISOString(), evalRoot, repoRoot, files }, null, 2))
console.log(JSON.stringify({ rawDir, fileCount: files.length, totalBytes: files.reduce((a, f) => a + f.bytes, 0) }, null, 2))
