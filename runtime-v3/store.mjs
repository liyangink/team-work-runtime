// store.mjs — 任务目录 I/O（唯一写入通道；原子写 + 锁复用 §6.1 保留件）
import { mkdir, readFile, readdir } from "node:fs/promises"
import path from "node:path"

import { atomicWrite, atomicJson, withOwnerLock } from "./persistence/transactions.mjs"
import { writableMatch } from "./domain/writable.mjs"

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

export async function initTask({ projectRoot, name, objective, entry, completion, workflowDigest, stages, risk }) {
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
  // 目录骨架只创建运行时实际使用的目录：决定在单文件 decisions.json、门禁判定不落盘（charter §5），
  // 早期 per-file 设计遗留的 decisions/、gates/ 空目录不再创建（2026-09 清理；存量任务目录里的空目录无害，归档时随目录删除）。
  await mkdir(path.join(root, "reports"), { recursive: true })
  await mkdir(path.join(root, "snapshots"), { recursive: true })
  await mkdir(path.join(root, "locks"), { recursive: true })
  await Promise.all([
    atomicJson(path.join(root, "intent.json"), { objective, constraints: [], exclusions: [], revisions: [], risk: risk ?? "normal" }),
    atomicJson(path.join(root, "scope.json"), { entry, completion, stages, workflowDigest, createdAt: at }),
    atomicJson(path.join(root, "artifacts.json"), { items: [] }),
    atomicWrite(path.join(root, "journal.jsonl"), `${JSON.stringify({ seq: 1, at, type: "task-opened", detail: { name, objective, entry } })}\n`),
  ])
  return { root, at }
}

export async function loadTask(projectRoot, name, { workflow, policy, repair = false }) {
  const root = taskRoot(projectRoot, name)
  if (!await taskExists(projectRoot, name)) {
    const error = new Error(`任务 ${name} 不存在。用 open 创建，或检查名字拼写。`)
    error.code = "TASK_NOT_FOUND"
    throw error
  }
  const [scope, intent, artifacts, decisions, journalRaw, packages] = await Promise.all([
    readJson(path.join(root, "scope.json")),
    readJson(path.join(root, "intent.json")),
    // artifacts 是派生索引（I3）：缺失/损坏都不抛——损坏降级 null 走下方不可变事实重建路径，
    // 只读命令呈现重建视图、写命令（repair）自愈固化；损坏直接抛会让 run/gate/deliver 全部死门。
    readJson(path.join(root, "artifacts.json"), { allowMissing: true }).catch(() => null),
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
  // I3：索引缺失/损坏时从不可变事实（reports + snapshots）重建。
  // 重建默认只在内存（repair=false）：loadTask 被只读命令（run/gate）与锁外预读（task0/outer/early）
  // 大量复用——任何隐式写回都会破坏「run 只读」承诺，且锁外读-改-写会与锁内写者竞态覆盖（v3 修订）。
  // 自愈写回仅由锁内写命令显式 repair:true 承载（cli.mjs 的 decide/retire/migrate/dispatch-plan/
  // agent-map/plan；deliver/review 经 intake 锁内路径），写点遗漏只损失自愈时机、无正确性风险。
  let items = artifacts?.items
  let artifactsRebuilt = false
  let artifactsDegraded = null
  if (!Array.isArray(items)) {
    // E：重建返回 { items, degraded }——degraded 列出结构校验失败被跳过的报告/路径（保守降级可测）
    const rebuilt = await rebuildArtifacts(root, reports, journal)
    items = rebuilt.items
    artifactsDegraded = rebuilt.degraded
    artifactsRebuilt = true
    if (repair) await atomicJson(path.join(root, "artifacts.json"), { items })
  }
  return { root, name, scope, intent, artifacts: { items }, reports, decisions: decisions?.items ?? [], journal, packages: packages?.items ?? null, workflow, policy, ...(artifactsRebuilt ? { artifactsRebuilt, ...(artifactsDegraded?.length ? { artifactsDegraded } : {}) } : {}) }
}

// E（返工终版 §二·E）：损坏 artifacts.json 的重建与正常登记等价——三源拼接：
//   源1 journal 的 report-accepted 事件序（全序：seq 单调，跨进程重试也保序）；
//   源2 reports 文件事实（stage/package/payload.paths——报告不可变；journal 缺事件的报告按 at
//        稳定序补尾：报告是 P1 事实源，不因 journal 事件缺失而丢弃）；
//   源3 snapshots（每路径按 at 取最新——快照文件名即 digest）。
// 等价性修复（对旧实现）：每路径取「最新涉及报告」的完整事实（digest/kind/stage/reportRef）——
// 旧首见胜出会让同路径多报告（原地修订 ver+1、跨 key 重交、同 digest 重交）只恢复首见版本、
// 字段随 readdir 顺序漂移，重建改变门禁事实；kind 精确推导 = 报告 dispatchKey → journal
// dispatched 的 writable → writableMatch（含目录继承，与 intake 正常登记 kindOf 同口径——
// 旧实现按 path 精确匹配查不到目录条目下的路径，kind 退化 misc）。
// 保守降级可测定义：结构校验失败（缺 reportId/dispatchKey/payload.paths/stage、快照缺失、
// 快照损坏非 JSON）跳过该报告/路径（损坏快照按缺失处理）并列入 degraded——不产出错误事实、
// 重建不抛错（run/gate/deliver/review 全链无死门，用户终裁①）；superseded 波已交付的登记不排除
//（与正常登记一致：retire 保留审计事实、不清 artifacts）。
export async function rebuildArtifacts(root, reports, journal = []) {
  // 报告按 at 升序是重建语义的一部分（首见 deliver 报告定该 path 的 stage 归属）——在重建入口统一
  // 排序，不依赖调用方预排：loadTask 预先排序、intake.freshState 的 readdir 顺序任意，两者重建同源同序
  // （比较器对相等 at 保持稳定序，比 loadTask 内联排序的破平更确定）。
  const ordered = [...reports].sort((a, b) => ((a.at ?? "") < (b.at ?? "") ? -1 : (a.at ?? "") > (b.at ?? "") ? 1 : 0))
  const snapshotsDir = path.join(root, "snapshots")
  const degraded = []
  const snapByPath = new Map()
  for (const entry of await readdir(snapshotsDir).catch(() => [])) {
    if (!entry.endsWith(".json")) continue
    let snap = null
    try {
      snap = await readJson(path.join(snapshotsDir, entry))
    } catch (error) {
      // 快照损坏容错（用户终裁①，Challenger r5 死门封堵）：损坏快照按缺失处理——重建不抛
      // STATE_CORRUPT（旧实现会使 run/gate/deliver/review 全链死门，违反 E 项无死门承诺）。
      // 文件级 degraded 给足提示（损坏文件 + 处置建议）；对应路径经下方「快照缺失」路径级 degraded
      // 自然列出（快照文件名即 digest、路径标签读不出，无法在此关联具体路径）。
      degraded.push({
        file: "snapshots/" + entry,
        reason: "快照不可读（" + String(error?.message ?? error) + "）。处置建议：该快照按缺失处理——可依据 journal 的 report-accepted/dispatched 事件与对应报告 payload 定位内容来源后重跑重做并重新交付，或人工修复/移除该损坏文件后重新触发重建；由 Lead 自主决策",
      })
      continue
    }
    // 同 digest 多路径共享快照：按 paths 全集标签索引（旧格式单 path 字段兼容）
    const labels = [...new Set([...(Array.isArray(snap.paths) ? snap.paths : []), ...(snap.path ? [snap.path] : [])])]
    for (const label of labels) {
      const prev = snapByPath.get(label)
      if (!prev || (snap.at ?? "") > (prev.at ?? "")) snapByPath.set(label, snap)
    }
  }
  const writableByKey = new Map()
  for (const e of journal) {
    if (e.type === "dispatched" && Array.isArray(e.detail?.writable)) writableByKey.set(e.detail.key, e.detail.writable)
  }
  // 主序：journal report-accepted 全序在前，journal 缺事件的报告按 at 稳定序补尾
  const acceptedOrder = []
  for (const e of journal) {
    if (e.type === "report-accepted" && e.detail?.reportId) acceptedOrder.push(e.detail.reportId)
  }
  const byId = new Map(ordered.map((r) => [r?.reportId, r]))
  const usedIds = new Set()
  const orderedReports = []
  for (const id of acceptedOrder) {
    const report = byId.get(id)
    if (!report) continue // journal 有事件但报告文件缺失：无事实可登记（不产出错误事实）
    usedIds.add(id)
    orderedReports.push(report)
  }
  for (const report of ordered) {
    if (report?.reportId && usedIds.has(report.reportId)) continue
    orderedReports.push(report)
  }
  // 结构校验 + 每路径最新报告事实（后写的赢：latestByPath 覆盖 = 每路径取最新报告完整事实）。
  // reportId 参与校验（Challenger r5 建议）：缺 reportId 的报告会产出 reportRef 缺失的 item
  //（JSON 序列化丢字段、cmdRestore 无法寻址），与「结构校验失败跳过并列 degraded」语义一致。
  // at 记录报告时间戳（Challenger r6）：与快照 at 同源同值（intake deliverLocked 单点定义——报告与
  // 快照共用同一 at），供下方快照-报告时间校验防 digest 静默回退旧版本。
  const latestByPath = new Map()
  for (const report of orderedReports) {
    if (!report || report.kind !== "deliver") continue
    if (typeof report.reportId !== "string" || !report.reportId || typeof report.dispatchKey !== "string" || !report.dispatchKey || !Array.isArray(report.payload?.paths) || typeof report.stage !== "string") {
      degraded.push({ reportId: report?.reportId ?? null, reason: "结构校验失败（缺 reportId/dispatchKey/payload.paths/stage），该报告已跳过" })
      continue
    }
    for (const p of report.payload.paths) {
      latestByPath.set(String(p), { reportRef: report.reportId, stage: report.stage, dispatchKey: report.dispatchKey, at: report.at ?? "" })
    }
  }
  const items = []
  for (const [p, latest] of latestByPath) {
    const snap = snapByPath.get(p)
    if (!snap) {
      degraded.push({ path: p, reportRef: latest.reportRef, reason: "快照缺失（snapshots/ 无该路径记录），该路径已跳过" })
      continue
    }
    // 快照-报告时间校验（Challenger r6，§9.5 不产出错误事实）：snapByPath 按 at 取最新，若最新交付的
    // 快照损坏（被上方容错跳过）或丢失，索引会静默回退到旧快照——产出 {digest: 旧版本, reportRef: 新报告}
    // 的混搭错误事实。报告与快照 at 同源同值（intake 单点定义），校验 snap.at >= report.at 不满足即该
    // 路径的当前快照不在场：按快照缺失降级跳过并列 degraded（处置建议同损坏快照）。
    if ((snap.at ?? "") < latest.at) {
      degraded.push({
        path: p,
        reportRef: latest.reportRef,
        reason: "快照版本落后于最新交付（最新快照缺失或损坏，索引回退到旧版本 " + String(snap.at) + "）：按缺失降级跳过，不产出旧 digest 混搭。处置建议：依据 journal 的 report-accepted 事件与报告 payload 定位最新内容来源后重跑重做并重新交付，或人工恢复该路径最新快照后重新触发重建；由 Lead 自主决策",
      })
      continue
    }
    const writable = writableByKey.get(latest.dispatchKey) ?? []
    items.push({
      path: p,
      digest: snap.digest,
      kind: writableMatch(writable, p)?.artifactKind ?? "misc",
      stage: latest.stage,
      reportRef: latest.reportRef,
      snapshotRef: `snapshots/${snap.digest}.json`,
    })
  }
  return { items, degraded }
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
