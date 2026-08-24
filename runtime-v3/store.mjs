// store.mjs — 任务目录 I/O（唯一写入通道；原子写 + 锁复用 §6.1 保留件）
import { mkdir, readFile, readdir } from "node:fs/promises"
import path from "node:path"

import { atomicWrite, atomicJson, withOwnerLock } from "../runtime/persistence/transactions.mjs"

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export function validName(name) {
  return typeof name === "string" && NAME_RE.test(name)
}

export function controlRoot(projectRoot) {
  return path.join(projectRoot, ".team-work")
}

export function taskRoot(projectRoot, name) {
  if (!validName(name)) {
    const error = new Error(`任务名 ${JSON.stringify(name)} 不合法：小写字母/数字/连字符，≤64 字符`)
    error.code = "TASK_NAME_INVALID"
    throw error
  }
  return path.join(controlRoot(projectRoot), "tasks", name)
}

export function archiveRoot(projectRoot, name) {
  if (!validName(name)) throw Object.assign(new Error(`任务名不合法：${name}`), { code: "TASK_NAME_INVALID" })
  return path.join(controlRoot(projectRoot), "archive", name)
}

async function readJson(file, { allowMissing = false } = {}) {
  try {
    return JSON.parse(await readFile(file, "utf8"))
  } catch (error) {
    if (error.code === "ENOENT" && allowMissing) return null
    if (error instanceof SyntaxError) {
      throw Object.assign(new Error(`文件损坏（非 JSON）：${file}`), { code: "STATE_CORRUPT" })
    }
    throw error
  }
}

export async function taskExists(projectRoot, name) {
  try {
    await readFile(path.join(taskRoot(projectRoot, name), "scope.json"), "utf8")
    return true
  } catch (error) {
    if (error.code === "ENOENT") return false
    throw error
  }
}

export async function initTask({ projectRoot, name, objective, entry, completion, workflowDigest, stages }) {
  const root = taskRoot(projectRoot, name)
  if (await taskExists(projectRoot, name)) {
    const error = new Error(`任务 ${name} 已存在。换一个名字，或用 run 继续它。`)
    error.code = "TASK_EXISTS"
    throw error
  }
  const at = new Date().toISOString()
  // 项目版本标记（E2E-19）：首次初始化写入；已存在则不动（含 v1 遗留内容）
  await mkdir(controlRoot(projectRoot), { recursive: true })
  const marker = path.join(controlRoot(projectRoot), "project.json")
  if (!await readJson(marker, { allowMissing: true })) {
    await atomicJson(marker, { runtimeMajor: 3, schema: "v3", createdAt: at })
  }
  await mkdir(path.join(root, "reports"), { recursive: true })
  await mkdir(path.join(root, "decisions"), { recursive: true })
  await mkdir(path.join(root, "snapshots"), { recursive: true })
  await mkdir(path.join(root, "gates"), { recursive: true })
  await mkdir(path.join(root, "locks"), { recursive: true })
  await Promise.all([
    atomicJson(path.join(root, "intent.json"), { objective, constraints: [], exclusions: [], revisions: [] }),
    atomicJson(path.join(root, "scope.json"), { entry, completion, stages, workflowDigest, createdAt: at }),
    atomicJson(path.join(root, "artifacts.json"), { items: [] }),
    atomicWrite(path.join(root, "journal.jsonl"), `${JSON.stringify({ seq: 1, at, type: "task-opened", detail: { name, objective, entry } })}\n`),
  ])
  return { root, at }
}

export async function loadTask(projectRoot, name, { workflow, policy }) {
  const root = taskRoot(projectRoot, name)
  if (!await taskExists(projectRoot, name)) {
    const error = new Error(`任务 ${name} 不存在。用 open 创建，或检查名字拼写。`)
    error.code = "TASK_NOT_FOUND"
    throw error
  }
  const [scope, intent, artifacts, decisions, journalRaw, packages] = await Promise.all([
    readJson(path.join(root, "scope.json")),
    readJson(path.join(root, "intent.json")),
    readJson(path.join(root, "artifacts.json"), { allowMissing: true }),
    readJson(path.join(root, "decisions.json"), { allowMissing: true }),
    readFile(path.join(root, "journal.jsonl"), "utf8").catch(() => ""),
    readJson(path.join(root, "packages.json"), { allowMissing: true }),
  ])
  const journal = journalRaw.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line))
  const reports = []
  const reportsDir = path.join(root, "reports")
  for (const entry of await readdir(reportsDir).catch(() => [])) {
    if (entry.endsWith(".json")) reports.push(await readJson(path.join(reportsDir, entry)))
  }
  reports.sort((a, b) => (a.at < b.at ? -1 : 1))
  // I3：索引缺失/损坏时从不可变事实（reports + snapshots）重建
  let items = artifacts?.items
  if (!Array.isArray(items)) {
    items = await rebuildArtifacts(root, reports)
    await atomicJson(path.join(root, "artifacts.json"), { items })
  }
  return { root, name, scope, intent, artifacts: { items }, reports, decisions: decisions?.items ?? [], journal, packages: packages?.items ?? null, workflow, policy }
}

async function rebuildArtifacts(root, reports) {
  const snapshotsDir = path.join(root, "snapshots")
  const byPath = new Map()
  for (const entry of await readdir(snapshotsDir).catch(() => [])) {
    if (!entry.endsWith(".json")) continue
    const snap = await readJson(path.join(snapshotsDir, entry))
    const prev = byPath.get(snap.path)
    if (!prev || (snap.at ?? "") > (prev.at ?? "")) byPath.set(snap.path, snap)
  }
  const kindByPath = new Map()
  for (const report of reports) {
    if (report.kind !== "deliver") continue
    // 最近的 deliver 报告决定 kind（原地修订时后写的赢）
    for (let i = 0; i < (report.payload?.paths ?? []).length; i += 1) kindByPath.set(report.payload.paths[i], null)
  }
  const items = []
  for (const report of reports) {
    if (report.kind !== "deliver") continue
    for (const p of report.payload?.paths ?? []) {
      const snap = byPath.get(p)
      if (snap && !items.some((it) => it.path === p)) {
        items.push({ path: p, digest: snap.digest, kind: "misc", stage: report.stage, reportRef: report.reportId, snapshotRef: `snapshots/${snap.digest}.json` })
      }
    }
  }
  return items
}

// decisions 用单文件数组存储（决定数量少，避免目录遍历）；deliver/review 报告仍是每文件一条。
export async function appendDecision(projectRoot, name, decision) {
  const root = taskRoot(projectRoot, name)
  const file = path.join(root, "decisions.json")
  return withOwnerLock(path.join(root, "locks", "task.lock"), async () => {
    const current = await readJson(file, { allowMissing: true })
    const items = [...(current?.items ?? []), decision]
    await atomicJson(file, { items })
    return items.length
  })
}

export async function listDecisions(projectRoot, name) {
  const current = await readJson(path.join(taskRoot(projectRoot, name), "decisions.json"), { allowMissing: true })
  return current?.items ?? []
}

export { atomicWrite, atomicJson, withOwnerLock, readJson }
