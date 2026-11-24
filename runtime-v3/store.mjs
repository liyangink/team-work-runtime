// store.mjs — 任务目录 I/O（唯一写入通道；原子写 + 锁复用 §6.1 保留件）
import { mkdir, readFile, readdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"

import { atomicWrite, atomicJson, withOwnerLock } from "./persistence/transactions.mjs"
import { writableMatch } from "./domain/writable.mjs"
import { deliverBaselines, reportOrderComparator, isPackagePlanEvent } from "./waves.mjs"
import { digestValue } from "./domain/digests.mjs"

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

// 与宿主绑定共用同一 key 锁路径；以 UTF-8 摘要作文件名，避免 key 进入路径语法。
export function dispatchLockPath(projectRoot, name, dispatchKey) {
  if (typeof dispatchKey !== "string" || !dispatchKey) throw Object.assign(new Error("派单 key 必须是非空字符串。"), { code: "DISPATCH_KEY_INVALID" })
  const digest = createHash("sha256").update(dispatchKey, "utf8").digest("hex")
  return path.join(taskRoot(projectRoot, name), "locks", "dispatch-" + digest + ".lock")
}

export function archiveRoot(projectRoot, name) {
  if (!validName(name)) throw Object.assign(new Error(`任务名不合法：${name}`), { code: "TASK_NAME_INVALID" })
  return path.join(controlRoot(projectRoot), "archive", name)
}

// journal 是权威事实：空内容、半条 JSON 或非事件都不能当成可追加的空日志。
export function parseJournal(raw) {
  const lines = typeof raw === "string" ? raw.split("\n").filter((line) => line.trim()) : []
  if (!lines.length) throw Object.assign(new Error("任务日志为空：保留原任务并核对备份，不能猜测重建。"), { code: "STATE_CORRUPT" })
  return lines.map((line, index) => {
    let event
    try { event = JSON.parse(line) } catch { throw Object.assign(new Error("任务日志第 " + (index + 1) + " 条不是有效 JSON；保留原文件并核对恢复。"), { code: "STATE_CORRUPT" }) }
    if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string" || !event.type) throw Object.assign(new Error("任务日志第 " + (index + 1) + " 条不是有效事件；保留原文件并核对恢复。"), { code: "STATE_CORRUPT" })
    return event
  })
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

// intent 初始字段只扩内容、不新增文件（方案 §7.3 骨架断言）：rawRequirement 保留用户原文，
// scope/acceptance/gaps 承载范围、验收与待对齐问题；缺省字段按空处理（旧文件缺字段同样按空）。
export async function initTask({ projectRoot, name, objective, entry, completion, workflowDigest, stages, risk, intent = {}, intakeVersion }) {
  const root = taskRoot(projectRoot, name)
  if (intakeVersion === 2) {
    await mkdir(path.dirname(root), { recursive: true })
    try {
      await mkdir(root)
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      const scope = await readJson(path.join(root, "scope.json"), { allowMissing: true })
      if (!scope) throw incompleteTask(name)
      if (scope.intakeVersion === 2) await checkInitialFacts(root, name)
      const exists = new Error(`任务 ${name} 已存在。换一个名字，或用 run 继续它。`)
      exists.code = "TASK_EXISTS"
      throw exists
    }
  } else if (await taskExists(projectRoot, name)) {
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
    atomicJson(path.join(root, "intent.json"), {
      rawRequirement: typeof intent.rawRequirement === "string" ? intent.rawRequirement : "",
      objective,
      constraints: Array.isArray(intent.constraints) ? intent.constraints : [],
      exclusions: Array.isArray(intent.exclusions) ? intent.exclusions : [],
      scope: intent.scope && typeof intent.scope === "object" && !Array.isArray(intent.scope) ? intent.scope : {},
      acceptance: Array.isArray(intent.acceptance) ? intent.acceptance : [],
      gaps: Array.isArray(intent.gaps) ? intent.gaps : [],
      revisions: [],
      risk: risk ?? "normal",
    }),
    atomicJson(path.join(root, "scope.json"), { entry, completion, stages, workflowDigest, createdAt: at, ...(intakeVersion === 2 ? { intakeVersion: 2 } : {}) }),
    atomicJson(path.join(root, "artifacts.json"), { items: [] }),
    atomicWrite(path.join(root, "journal.jsonl"), `${JSON.stringify({ seq: 1, at, type: "task-opened", detail: { name, objective, entry } })}\n`),
  ])
  return { root, at }
}

function incompleteTask(name) {
  return Object.assign(new Error(`任务 ${name} 的初始化可能仍在进行或已中断：先核实原调用结束；若已成功按实际状态继续，若中断或事实不全请保留原目录，并用新名字重新提供原文和计划。`), { code: "TASK_INIT_INCOMPLETE" })
}

async function checkInitialFacts(root, name) {
  const intent = await readJson(path.join(root, "intent.json"), { allowMissing: true })
  let journal
  try { journal = await readFile(path.join(root, "journal.jsonl"), "utf8") } catch (error) {
    if (error.code !== "ENOENT") throw error
    throw incompleteTask(name)
  }
  if (!intent || !journal.trim()) throw incompleteTask(name)
}

async function readPackagePlan(root, strict) {
  let raw
  try { raw = await readFile(path.join(root, "packages.json"), "utf8") } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
  let plan
  try { plan = JSON.parse(raw) } catch {
    throw Object.assign(new Error("包计划损坏（非 JSON）：请检查并恢复 packages.json。"), { code: "STATE_CORRUPT" })
  }
  if (strict && (!plan || !Array.isArray(plan.items))) {
    throw Object.assign(new Error("包计划损坏：packages.json 的 items 必须是数组；请检查并恢复计划。"), { code: "STATE_CORRUPT" })
  }
  return plan
}

// R3-1：journal 事件流投影报告（锁内 freshState 与 loadTask 共用同一合并口径）——
// report-committed 事件是报告版本事实的权威；文件报告只作事件缺字段（旧 report-accepted 时代）的补充。
export function projectReportsFromJournal(fileReports, journal) {
  const fileByVer = new Map()
  for (const r of fileReports) {
    if (!r?.reportId) continue
    const key = r.reportId + "\u0000" + (r.ver ?? 1)
    fileByVer.set(key, r)
  }
  const eventReports = new Map() // reportId|ver → 事件构造报告
  const eventDigests = new Map()
  for (const e of journal) {
    if (e.type !== "report-committed" || !e.detail?.reportId) continue
    const d = e.detail
    const ver = d.ver ?? 1
    const versionKey = d.reportId + "\u0000" + ver
    if (eventReports.has(versionKey)) {
      if (eventDigests.get(versionKey) !== digestValue(d)) throw Object.assign(new Error("同一报告版本存在冲突的 journal 事实：" + d.reportId + "#v" + ver + "，请核对并恢复账本。"), { code: "STATE_CORRUPT" })
      continue
    }
    eventDigests.set(versionKey, digestValue(d))
    const dispatch = d.dispatchKey == null ? null : journal.find((event) => event.type === "dispatched" && event.detail?.key === d.dispatchKey)?.detail
    const ev = {
      reportId: d.reportId,
      ...(d.dispatchKey != null ? { dispatchKey: d.dispatchKey } : {}),
      role: d.role ?? (d.kind === "review" ? "challenger" : "owner"),
      kind: d.kind ?? "deliver",
      ...((d.round ?? dispatch?.round) != null ? { round: d.round ?? dispatch.round } : {}),
      ...(d.stage != null ? { stage: d.stage } : {}),
      ...(d.package !== undefined ? { package: d.package } : {}),
      ver,
      ...(d.origin ? { origin: d.origin } : {}),
      ...(Array.isArray(d.files) ? { files: d.files.map((f) => ({ ...f, ...(f.kind || d.kinds?.[f.path] ? { kind: f.kind ?? d.kinds[f.path] } : {}), snapshotRef: f.snapshotRef ?? ("snapshots/" + f.digest + ".json") })) } : {}),
      ...(d.payload ? { payload: d.payload } : (Array.isArray(d.paths) ? { payload: { paths: d.paths, ...(d.outcome ? { outcome: d.outcome } : {}) } } : {})),
      ...(d.payloadDigest ? { payloadDigest: d.payloadDigest } : {}),
      ...(d.recommendation !== undefined ? { recommendation: d.recommendation } : {}),
      ...(Array.isArray(d.reviewedPackages) ? { reviewedPackages: d.reviewedPackages } : {}),
      ...(d.taskSha ? { taskSha: d.taskSha } : {}),
      ...(d.reviewedBaseline ? { reviewedBaseline: d.reviewedBaseline } : {}),
      ...(d.author ? { author: d.author } : {}),
      ...(d.decisionId ? { decisionId: d.decisionId } : {}),
      ...(d.replacedReport ? { replacedReport: d.replacedReport } : {}),
      at: e.at ?? null,
    }
    eventReports.set(versionKey, ev)
  }
  // 同 key 覆盖旧报告文件时，新提交事件携带被覆盖的旧 delivered 事实；其顺序仍以原 report-accepted 为锚。
  const preservedLegacy = new Map()
  for (const e of journal) {
    const d = e.detail
    const prior = d?.legacyPriorReport
    if (e.type !== "report-committed" || !prior || prior.reportId !== d.reportId || prior.dispatchKey !== d.dispatchKey
      || prior.role !== "owner" || prior.kind !== "deliver" || prior.payload?.outcome !== "delivered" || (prior.ver ?? 1) >= (d.ver ?? 1)) continue
    const key = prior.reportId + "\u0000" + (prior.ver ?? 1)
    if (eventReports.has(key)) continue // 已有同版本新协议事实时仍以原提交事件为权威
    if (preservedLegacy.has(key) && digestValue(preservedLegacy.get(key)) !== digestValue(prior)) {
      throw Object.assign(new Error("同一旧报告版本存在冲突的保留事实：" + prior.reportId + "#v" + (prior.ver ?? 1) + "，请核对并恢复账本。"), { code: "STATE_CORRUPT" })
    }
    preservedLegacy.set(key, prior)
  }
  for (const [key, prior] of preservedLegacy) eventReports.set(key, { ...prior, ver: prior.ver ?? 1 })
  const merged = []
  const seenFileReports = new Set()
  for (const ev of eventReports.values()) {
    const fileSameVer = fileByVer.get(ev.reportId + "\u0000" + ev.ver)
    if (fileSameVer) seenFileReports.add(fileSameVer)
    // 文件仅补事件没有的辅助字段；事件明确提交的任何字段始终优先，尤其完整清单和 payload。
    merged.push({ ...(fileSameVer ?? {}), ...ev })
  }
  for (const r of fileReports) {
    if (!r?.reportId || seenFileReports.has(r)) continue
    if (eventReports.has(r.reportId + "\u0000" + (r.ver ?? 1))) continue
    merged.push(r)
  }
  // §7.3/B12：protocol-migrated 事件叠加新算法 files（不改写报告文件）
  for (const e of journal) {
    if (e.type !== "protocol-migrated" || !e.detail?.reportId || !Array.isArray(e.detail.files)) continue
    const target = merged.find((r) => r?.reportId === e.detail.reportId)
    if (target && !Array.isArray(target.files)) {
      target.files = e.detail.files.map((f) => ({ ...f, snapshotRef: f.snapshotRef ?? ("snapshots/" + f.digest + ".json") }))
      target.protocolMigrated = { algorithm: e.detail.algorithm ?? "sha256-bytes-v1", previousAlgorithm: e.detail.previousAlgorithm ?? "legacy-digest-value", at: e.at ?? null }
    }
  }
  return merged
}

// 只有改变有效清单的提交、迁移与作废事件使索引过期；评审和 blocked 不改变清单。
export function artifactProjectionSeq(journal) {
  return Math.max(0, ...journal.filter((e) => {
    if (e.type === "report-committed") {
      if (e.detail?.kind === "review") return false
      if (e.detail?.kind === "deliver" && e.detail?.outcome === "blocked") return false
      return true
    }
    return e.type === "protocol-migrated" || e.type === "dispatch-superseded"
  }).map((e) => e.seq ?? 0))
}

export function artifactsNeedRebuild(artifacts, journal) {
  if (!Array.isArray(artifacts?.items)) return true
  const lastSeq = Math.max(0, ...journal.map((e) => e.seq ?? 0))
  const seq = artifacts.journalSeq
  if (seq != null && (!Number.isSafeInteger(seq) || seq < 0 || seq > lastSeq)) return true
  return (seq ?? 0) < artifactProjectionSeq(journal)
}

export async function loadTask(projectRoot, name, { workflow, policy, repair = false, ignorePackages = false }) {
  const root = taskRoot(projectRoot, name)
  if (!await taskExists(projectRoot, name)) {
    const error = new Error(`任务 ${name} 不存在。用 open 创建，或检查名字拼写。`)
    error.code = "TASK_NOT_FOUND"
    throw error
  }
  const scope = await readJson(path.join(root, "scope.json"))
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) throw Object.assign(new Error("任务范围文件损坏；请核对并恢复 scope.json。"), { code: "STATE_CORRUPT" })
  if (scope?.intakeVersion === 2) await checkInitialFacts(root, name)
  const [intent, artifacts, decisions, journalRaw, packages] = await Promise.all([
    readJson(path.join(root, "intent.json")),
    // artifacts 是派生索引（I3）：缺失/损坏都不抛——损坏降级 null 走下方不可变事实重建路径，
    // 只读命令呈现重建视图、写命令（repair）自愈固化；损坏直接抛会让 run/gate/deliver 全部死门。
    readJson(path.join(root, "artifacts.json"), { allowMissing: true }).catch(() => null),
    readJson(path.join(root, "decisions.json"), { allowMissing: true }),
    readFile(path.join(root, "journal.jsonl"), "utf8").catch((error) => {
      if (error.code === "ENOENT") {
        if (scope?.intakeVersion === 2) throw incompleteTask(name)
        throw Object.assign(new Error("旧任务日志缺失：保留原任务，核对备份及旧写者状态后恢复，不能猜为空日志。"), { code: "STATE_CORRUPT" })
      }
      throw error
    }),
    ignorePackages ? Promise.resolve(null) : readPackagePlan(root, scope?.intakeVersion === 2),
  ])
  const journal = parseJournal(journalRaw)
  if (scope?.intakeVersion === 2 && journal[0]?.type !== "task-opened") throw incompleteTask(name)
  // 意图修订随 journal 原子提交；intent.json 的旧视图可在回执丢失或进程中断后复原。
  const committedIntent = journal.findLast((event) => event.type === "intent-prepared" && Array.isArray(event.detail?.intent?.revisions))?.detail.intent
  const effectiveIntent = committedIntent && committedIntent.revisions.length > (intent?.revisions?.length ?? 0) ? committedIntent : intent
  // B11/§6.3：完整计划是 journal 一次提交的事实（packages-planned/re-planned/block 计划事件带 items），
  // packages.json 是可重建视图——崩溃于"journal 已提交、视图未写"时计划不回退；旧事件（无 items）回退文件。
  let packagesEffective = packages?.items ?? null
  if (!ignorePackages) {
    for (const e of journal) {
      if (isPackagePlanEvent(e) && Array.isArray(e.detail?.items)) {
        packagesEffective = e.detail.items
      }
    }
  }
  // §6.2.1：刷新等经 journal 单次原子提交的决定（decided 事件）与 decisions.json 常规决定合并，
  // 按 decisionId 去重——journal 事实优先，decisions.json 同 ID 行视为视图重复不重复消费。
  const journalDecisions = []
  const journalDecisionIds = new Set()
  for (const e of journal) {
    if (e.type === "decided" && e.detail?.decisionId) {
      journalDecisionIds.add(e.detail.decisionId)
      journalDecisions.push({ decisionId: e.detail.decisionId, ...(e.detail.gateId !== undefined ? { gateId: e.detail.gateId } : { gateId: null }), choice: e.detail.choice, ...(e.detail.grant ? { grant: e.detail.grant } : {}), ...(e.detail.refresh ? { refresh: e.detail.refresh } : {}), ...(e.detail.note ? { note: e.detail.note } : {}), proof: { mode: "journal-committed", at: e.at ?? null }, at: e.at ?? null })
    }
  }
  const reports = []
  const reportsDir = path.join(root, "reports")
  for (const entry of await readdir(reportsDir).catch(() => [])) {
    if (entry.endsWith(".json")) reports.push(await readJson(path.join(reportsDir, entry)))
  }
  reports.sort(reportOrderComparator(journal))
  // R3-1：合并口径统一走 projectReportsFromJournal（与 freshState 同源）
  const reportsMerged = projectReportsFromJournal(reports, journal)
  reports.length = 0
  reports.push(...reportsMerged)
  reports.sort(reportOrderComparator(journal))
  // I3：索引缺失/损坏时从不可变事实（reports + snapshots）重建。
  // 重建默认只在内存（repair=false）：loadTask 被只读命令（run/gate）与锁外预读（task0/outer/early）
  // 大量复用——任何隐式写回都会破坏「run 只读」承诺，且锁外读-改-写会与锁内写者竞态覆盖（v3 修订）。
  // 自愈写回仅由锁内写命令显式 repair:true 承载（cli.mjs 的 decide/retire/migrate/dispatch-plan/
  // agent-map/plan；deliver/review 经 intake 锁内路径），写点遗漏只损失自愈时机、无正确性风险。
  let items = artifacts?.items
  let artifactsRebuilt = false
  let artifactsDegraded = null
  const projectionSeq = artifactProjectionSeq(journal)
  if (artifactsNeedRebuild(artifacts, journal)) {
    // 只读调用在内存重算；锁内修复才写回，避免把旧版有效 JSON 误当最新索引。
    // E：重建返回 { items, degraded }——degraded 列出结构校验失败被跳过的报告/路径（保守降级可测）
    const rebuilt = await rebuildArtifacts(root, reports, journal)
    items = rebuilt.items
    artifactsDegraded = rebuilt.degraded
    artifactsRebuilt = true
    if (repair) await atomicJson(path.join(root, "artifacts.json"), { items, journalSeq: projectionSeq })
  }
  // 合并方向：decisions.json 完整行优先（decide 常规路径的完整决定数据在此）；
  // journal decided 事件行只补充 decisions.json 缺失的 ID（§6.2.1 刷新原子提交的决定先落 journal，
  // decisions.json 是随后同步的视图——两边都有时以文件行为准，避免摘要行覆盖完整行）。
  const decisionFileIds = new Set((decisions?.items ?? []).map((d) => d?.decisionId))
  const mergedDecisions = [...(decisions?.items ?? []), ...journalDecisions.filter((j) => !decisionFileIds.has(j.decisionId))]
  return { root, name, scope, intent: effectiveIntent, artifacts: { items, ...(artifactsRebuilt ? { journalSeq: projectionSeq } : artifacts?.journalSeq != null ? { journalSeq: artifacts.journalSeq } : {}) }, reports, decisions: mergedDecisions, journal, packages: packagesEffective, workflow, policy, ...(artifactsRebuilt ? { artifactsRebuilt, ...(artifactsDegraded?.length ? { artifactsDegraded } : {}) } : {}) }
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
// E（返工终版 §二·E）+ §6.1 完整清单语义：损坏 artifacts.json 的重建与正常登记等价——
//   每包（按 stage×package 分组）取 journal 提交序最新一条未作废 delivered 报告，其清单**整体**即
//   该包有效路径集；不再从老报告继承个别路径，也不建立逐路径跨版本来源状态。
//   新报告读 files[]（sha256-bytes-v1，快照 = snapshots/<bytesDigest>.json 的 base64 载荷）；
//   旧报告回退 payload.paths × 快照标签索引（快照兼容 bytes-v1 与旧 content 两种格式，按 at 取最新）。
// 保守降级可测定义：结构校验失败（缺 reportId/dispatchKey/payload.paths/stage、快照缺失、
//   快照损坏非 JSON）跳过该报告/路径（损坏快照按缺失处理）并列入 degraded——不产出错误事实、
//   重建不抛错（run/gate/deliver/review 全链无死门）；superseded 波已交付的登记自然排除
//   （基线选择统一走 deliverBaselines 的排除口径）。
export async function rebuildArtifacts(root, reports, journal = []) {
  const degraded = []
  const snapshotsDir = path.join(root, "snapshots")
  const snapByPath = new Map()
  for (const entry of await readdir(snapshotsDir).catch(() => [])) {
    if (!entry.endsWith(".json")) continue
    let snap = null
    try {
      snap = await readJson(path.join(snapshotsDir, entry))
    } catch (error) {
      // 快照损坏容错（用户终裁①）：损坏快照按缺失处理，重建不抛 STATE_CORRUPT；
      // 文件级 degraded 给足提示，对应路径经下方「快照缺失」路径级 degraded 自然列出。
      degraded.push({
        file: "snapshots/" + entry,
        reason: "快照不可读（" + String(error?.message ?? error) + "）。处置建议：该快照按缺失处理——可依据 journal 的 report-committed/report-accepted/dispatched 事件与对应报告 payload 定位内容来源后重跑重做并重新交付，或人工修复/移除该损坏文件后重新触发重建；由 Lead 自主决策",
      })
      continue
    }
    // 同 digest 多路径共享快照：按 paths 全集标签索引（旧格式单 path 字段兼容）。
    // 新旧格式都带 digest（文件名即摘要）；at 用于同标签多快照时取最新（快照-报告时间校验）。
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
  // §6.1：每包基线整体展开（groupedByStage：跨阶段条目保留，item.stage 来自基线报告）。
  const baselines = deliverBaselines({ journal, reports, groupedByStage: true })
  const items = []
  for (const [, base] of baselines) {
    const report = base.report
    // R3-2：Lead 刷新报告 dispatchKey=null 合法（origin=user-authorized-lead-refresh）——不得因缺
    // dispatchKey 被 degraded 跳过（否则刷新提交后索引缺失即丢失全部有效产物）。
    const hasIdentity = typeof report.reportId === "string" && report.reportId
      && (typeof report.dispatchKey === "string" && report.dispatchKey || report.origin === "user-authorized-lead-refresh")
    if (!report || !hasIdentity || typeof report.stage !== "string") {
      degraded.push({ reportId: report?.reportId ?? null, reason: "结构校验失败（缺 reportId/身份/stage），该报告已跳过" })
      continue
    }
    const pkg = report.package ?? null
    const writable = writableByKey.get(report.dispatchKey) ?? []
    const entries = Array.isArray(report.files) && report.files.length > 0
      ? report.files.map((f) => ({ path: f.path, digest: f.digest, digestAlgorithm: f.digestAlgorithm ?? null, kind: f.kind ?? null, fromFiles: true }))
      : (Array.isArray(report.payload?.paths) ? report.payload.paths.map((p) => ({ path: String(p), digest: null, digestAlgorithm: null, kind: null, fromFiles: false })) : null)
    if (!entries) {
      degraded.push({ reportId: report.reportId, reason: "结构校验失败（缺 files/payload.paths），该报告已跳过" })
      continue
    }
    for (const entry of entries) {
      let digest = entry.digest
      let algorithm = entry.digestAlgorithm
      const snap = snapByPath.get(entry.path)
      if (!snap) {
        degraded.push({ path: entry.path, reportRef: report.reportId, reason: "快照缺失（snapshots/ 无该路径记录），须恢复或重新交付" })
        // 新报告的摘要是日志事实：即使快照缺失也保留路径，令实时核验明确阻断，不能过滤后过门。
        if (digest == null) continue
      }
      if (digest == null) digest = snap.digest ?? null
      if (digest == null) {
        degraded.push({ path: entry.path, reportRef: report.reportId, reason: "快照缺少 digest 字段，该路径已跳过" })
        continue
      }
      // 快照-报告时间校验：snapByPath 按 at 取最新，若最新交付的快照损坏/丢失，索引会静默回退
      // 旧快照——产出 {digest: 旧版本, reportRef: 新报告} 的混搭错误事实，按缺失降级跳过。
      if (!entry.fromFiles && (snap.at ?? "") < (report.at ?? "")) {
        degraded.push({
          path: entry.path,
          reportRef: report.reportId,
          reason: "快照版本落后于最新交付（最新快照缺失或损坏，索引回退到旧版本 " + String(snap.at) + "）：按缺失降级跳过，不产出旧 digest 混搭。处置建议：依据 journal 事件与报告 payload 定位最新内容来源后重跑重做并重新交付，或人工恢复该路径最新快照后重新触发重建；由 Lead 自主决策",
        })
        continue
      }
      items.push({
        path: entry.path,
        digest,
        ...(algorithm ? { digestAlgorithm: algorithm } : {}),
        kind: entry.kind ?? writableMatch(writable, entry.path)?.artifactKind ?? "misc",
        stage: report.stage,
        ...(pkg != null ? { package: pkg } : {}),
        reportRef: report.reportId,
        snapshotRef: "snapshots/" + digest + ".json",
      })
    }
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
