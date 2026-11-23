// intake.mjs — deliver / review 的调用内同步总检查（P2：一次查完全部欠账，当场返回）
// 派单身份用 dispatchKey（run 派发时生成、写进派单文本；成员从派单里照抄，是寻址不是簿记）。
//
// v3.5（架构方案 runtime-v3/twr-framework-architecture-design.md §5/§6.1/§6.2）：
// - §5 强类型同步校验：payload/嵌套对象拒绝未知字段；finding 用 {severity, statement, disposition?, scope?}，
//   scope.kind 强制（all-covered | packages.ids），旧 package/packages 形状明确拒绝并给替换写法；
//   Expert 必填完整 verdict，双结论（recommendation × verdict）按一致性矩阵校验。
// - §6.1 每包完整清单：--paths 是本包当前阶段的完整交付清单（用户拍板），不再是增量清单；
//   新报告只写 X 就明确表示 Y 不再属于该包有效制品（不删除磁盘文件，历史与快照保留审计）。
//   幂等 = 相同 key + 规范化 payload + 全部路径内容字节相同；内容或清单变化即新版本（ver+1）。
//   用户裁决不新增跨波旧 key 禁止守卫：异常迟到重交可形成更新版本，由 Lead 查版本链、必要时请用户裁决。
// - §6.2 sha256-bytes-v1：快照与实时核验一律对磁盘原始字节计算 SHA-256（digestBytes），
//   与旧 digestValue（canonical JSON 文本摘要）显式区分；旧数据不判等（转换走 §7 迁移工具）。
//   review 接受前稳定读取各活动包基线清单文件并逐项比对字节摘要，差异同步拒绝。
import path from "node:path"
import { readFile, readdir, mkdir } from "node:fs/promises"

import { digestValue, digestBytes, BYTES_DIGEST_ALGORITHM } from "./domain/digests.mjs"
import { atomicJson, atomicWrite, withOwnerLock } from "./persistence/transactions.mjs"
import { readStableArtifact, readStableArtifactBytes } from "./persistence/file-artifact-repository.mjs"
import { artifactsFingerprint } from "./gate.mjs"
import { projectRounds, inflightBatch, supersededKeys, waveIdOf, deliverBaselines } from "./waves.mjs"
import { currentStageOf } from "./derive.mjs"
import { readJson, rebuildArtifacts, projectReportsFromJournal, artifactsNeedRebuild, artifactProjectionSeq, parseJournal } from "./store.mjs"
import { writableMatch } from "./domain/writable.mjs"

function reject(reasons) {
  const error = new Error(Array.isArray(reasons) ? reasons.join("\n") : reasons)
  error.code = "INTAKE_REJECTED"
  error.reasons = Array.isArray(reasons) ? reasons : [reasons]
  return error
}

function normalizeRelative(value) {
  const text = String(value ?? "").trim().replace(/^\.\//, "")
  if (text === "" || path.isAbsolute(text) || text.split("/").some((s) => s === "" || s === "." || s === "..")) return null
  return text
}

// —— §5 形状校验原语：未知字段（含嵌套）一次聚合拒绝 ——

const DELIVER_FIELDS = new Set(["outcome", "summary", "paths", "checks", "unresolved"])
const REVIEW_FIELDS = new Set(["summary", "recommendation", "findings", "verdict"])
const CHECK_FIELDS = new Set(["name", "result"])
const FINDING_FIELDS = new Set(["severity", "statement", "disposition", "scope"])
const SCOPE_FIELDS = new Set(["kind", "ids"])
const VERDICT_FIELDS = new Set(["outcome", "rationale", "confidence", "recommendedAction", "risks"])

function unknownFields(obj, allowed, label) {
  return Object.keys(obj ?? {}).filter((k) => !allowed.has(k)).map((k) => `${label} 含未知字段「${k}」（只接受 ${[...allowed].join("、")}）`)
}

// journal 里找 dispatchKey 对应的派单合同
export function findDispatch(journal, dispatchKey) {
  return journal.find((e) => e.type === "dispatched" && e.detail?.key === dispatchKey) ?? null
}

// 执行时从磁盘重读最新事实（并发提交与跨进程重试都以此为准确保正确）。
// artifacts.json 是派生索引（I3）：缺失/损坏都不抛——抛错会让 deliver/review 死门（无修复指引的裸
// RUNTIME_ERROR，违反 P2 与方案 §8.1 #5 的锁内自愈声明）。降级用 rebuildArtifacts 从不可变事实
// （reports+snapshots）重建，与 loadTask 重建路径同源同序；本函数只在任务锁内（deliver/review 入口）
// 执行——deliver 落盘本就全量重写 artifacts.json，重建结果随本次交付固化（锁内自愈），review 内存
// 重建即够（taskSha 口径与健康账本一致）。
async function freshState(task) {
  const journalRaw = await readFile(path.join(task.root, "journal.jsonl"), "utf8")
  const journal = parseJournal(journalRaw)
  const fileReports = []
  for (const entry of await readdir(path.join(task.root, "reports")).catch(() => [])) {
    if (entry.endsWith(".json")) fileReports.push(await readJson(path.join(task.root, "reports", entry)))
  }
  // R3-1：报告/计划一律从 journal 事实投影（projectReportsFromJournal 与 loadTask 同源）——
  // report-committed 已提交而报告视图写前崩溃时，锁内幂等与下一 ver 仍基于已提交事实，不重写同 ver。
  const reports = projectReportsFromJournal(fileReports, journal)
  let artifacts = null
  try {
    artifacts = JSON.parse(await readFile(path.join(task.root, "artifacts.json"), "utf8"))
  } catch {
    artifacts = null
  }
  // 与 loadTask 使用同一新鲜度口径；保留无新协议事件的旧索引供 §7 核验。
  if (artifactsNeedRebuild(artifacts, journal)) {
    artifacts = { items: (await rebuildArtifacts(task.root, reports, journal)).items, journalSeq: artifactProjectionSeq(journal) }
  }
  // R3-1：计划同样从 journal 最新计划事件投影（packages.json 视图滞后不污染校验）
  let packages = Array.isArray(task.packages) ? task.packages : null
  for (const e of journal) {
    if ((e.type === "packages-planned" || e.type === "re-planned") && Array.isArray(e.detail?.items)) packages = e.detail.items
  }
  return { journal, artifacts, reports, packages }
}

// 稳定读取走 persistence 保留件：逐段拒符号链接、读中变化检测、realpath 防逃逸（I1）
async function readStable(projectRoot, relativePath) {
  try {
    const content = await readStableArtifact(projectRoot, relativePath)
    return { content, digest: digestValue(content) }
  } catch (error) {
    throw stableReadError(error, relativePath)
  }
}

// §6.2 原始字节稳定读取：快照与实时核验的字节来源（不先转文本）。
async function readStableBytes(projectRoot, relativePath) {
  try {
    return await readStableArtifactBytes(projectRoot, relativePath)
  } catch (error) {
    throw stableReadError(error, relativePath)
  }
}

function stableReadError(error, relativePath) {
  if (error.code === "ARTIFACT_MISSING") {
    const wrapped = new Error(`路径 ${relativePath} 不存在：先创建文件再交付；若你是纯回应/说明交付，paths 留空。`)
    wrapped.code = "INTAKE_REJECTED"
    return wrapped
  }
  if (error.code === "ARTIFACT_PATH_ESCAPE") {
    const wrapped = new Error(`路径 ${relativePath} 越出项目根或包含符号链接（${error.message}）。交付路径必须是项目内真实文件。`)
    wrapped.code = "INTAKE_REJECTED"
    return wrapped
  }
  if (error.code === "ARTIFACT_UNSTABLE") {
    const wrapped = new Error(`路径 ${relativePath} 在读取期间发生变化，请稍后重试交付。`)
    wrapped.code = "INTAKE_REJECTED"
    return wrapped
  }
  return error
}

// —— §6.2 实时核验：稳定读取磁盘原始字节计算 sha256-bytes-v1，与报告快照 digest 逐项比对 ——
// files: [{path, digest, digestAlgorithm?}]；digestAlgorithm 缺失（旧任务遗留）按旧 digestValue
// 文本口径核对（保持旧任务可评审，转换走 §7 迁移工具，不在此判等两种算法）。
// 返回 {ok, mismatches:[{path, expected, actual, reason}]}，不抛错（调用方决定拒绝或 blocker）。
export async function verifyArtifactBytes({ projectRoot, files, taskRoot = null }) {
  const mismatches = []
  for (const f of Array.isArray(files) ? files : []) {
    // B5：形状不全（缺 path/digest）fail-closed 报不匹配，不静默跳过（纯内存 files=[{path}] 不再返回 ok）
    if (!f || typeof f !== "object" || typeof f.path !== "string" || !f.path || typeof f.digest !== "string" || !f.digest) {
      mismatches.push({ path: f?.path ?? null, expected: f?.digest ?? null, actual: null, reason: "清单条目形状不全（缺 path 或 digest）——按不匹配处理" })
      continue
    }
    // R3-5/§6.1：快照在场与自洽核验——报告所指 snapshotRef 缺失、损坏或自身字节 SHA 不一致时
    // fail closed（磁盘恰好一致也不能免除快照核验：快照是恢复边与审计的事实）。
    if (taskRoot) {
      const standardRef = /^[0-9a-f]{64}$/.test(f.digest) ? "snapshots/" + f.digest + ".json" : null
      const snapshotRef = f.snapshotRef == null ? standardRef : f.snapshotRef
      if (!standardRef || snapshotRef !== standardRef) {
        mismatches.push({ path: f.path, expected: f.digest, actual: null, reason: "快照引用缺失或非法，无法确定标准快照：请核对报告和快照后重新交付或授权刷新" })
        continue
      }
      try {
        const snap = JSON.parse(await readFile(path.join(taskRoot, snapshotRef), "utf8"))
        let snapOk = false
        if (snap.format === "bytes-v1" && typeof snap.data === "string") {
          snapOk = digestBytes(Buffer.from(snap.data, "base64")) === f.digest
        } else if (typeof snap.content === "string") {
          snapOk = digestValue(snap.content) === f.digest
        }
        if (!snapOk) mismatches.push({ path: f.path, expected: f.digest, actual: null, reason: "快照内容与报告摘要不自洽（" + snapshotRef + "）——按 §6.1 阻止依赖它的评审/门禁" })
      } catch (error) {
        mismatches.push({ path: f.path, expected: f.digest, actual: null, reason: "快照缺失或不可读（" + snapshotRef + "：" + (error?.code ?? error?.message) + "）——按 §6.1 阻止依赖它的评审/门禁；恢复：依据 journal 事件重做交付或人工恢复快照" })
      }
    }
    try {
      if (f.digestAlgorithm === BYTES_DIGEST_ALGORITHM) {
        const bytes = await readStableBytes(projectRoot, f.path)
        const actual = digestBytes(bytes)
        if (actual !== f.digest) mismatches.push({ path: f.path, expected: f.digest, actual, reason: "磁盘字节 SHA-256 与报告快照不一致" })
      } else {
        const legacy = await readStable(projectRoot, f.path)
        if (legacy.digest !== f.digest) mismatches.push({ path: f.path, expected: f.digest, actual: legacy.digest, reason: "磁盘内容摘要与登记值不一致（旧文本口径）" })
      }
    } catch (error) {
      if (error.code === "INTAKE_REJECTED") {
        mismatches.push({ path: f.path, expected: f.digest, actual: null, reason: error.message })
      } else {
        throw error
      }
    }
  }
  return { ok: mismatches.length === 0, mismatches }
}

// —— §6.1 每包有效基线的文件清单（新报告读 files[]；旧报告回退 artifacts 索引条目） ——
// 返回 [{package, reportId, ver, files:[{path, digest, digestAlgorithm}]}]。
export function baselineFiles({ journal, reports, artifacts, stage }) {
  const stageReports = stage ? reports.filter((r) => r.stage === stage) : reports
  const baselines = deliverBaselines({ journal, reports: stageReports })
  const byReport = new Map()
  for (const item of (artifacts?.items ?? [])) {
    if (!byReport.has(item.reportRef)) byReport.set(item.reportRef, [])
    byReport.get(item.reportRef).push(item)
  }
  const out = []
  for (const [pkg, base] of baselines) {
    const report = base.report
    if (Array.isArray(report.files) && report.files.length > 0) {
      out.push({ package: pkg, reportId: report.reportId, ver: report.ver ?? 1, files: report.files.map((f) => ({ path: f.path, digest: f.digest, digestAlgorithm: f.digestAlgorithm ?? null })) })
    } else {
      const items = byReport.get(report.reportId) ?? []
      out.push({ package: pkg, reportId: report.reportId, ver: report.ver ?? 1, files: items.map((i) => ({ path: i.path, digest: i.digest, digestAlgorithm: i.digestAlgorithm ?? null })) })
    }
  }
  return out
}

// D2：key 不存在时列当前在途派单（帮成员发现 key 错配——E2E 实测 intake 成员用错 key 覆盖他人报告）
// 在途判定统一走 waves.inflightBatch（F3 四处共用同一纯函数；superseded 波不在在途）。
function inflightHint(journal, reports) {
  const inflight = inflightBatch({ journal, reports })
  if (!inflight) return "当前无在途派单；key 可能属于其他任务或已交付完毕"
  return `当前在途派单：${inflight.open.map((d) => `${d.key}（${d.role}${d.package ? "@" + d.package : ""} 轮次 ${d.round}）`).join("、")}——检查你是否用了别人的 key`
}

// deliver：Owner 交卷。§6.1：paths 是本包当前阶段的**完整**交付清单（不是本次改动增量）；
// 要保留旧文件必须重新列入。blocked 必须 paths 为空且不覆盖此前有效清单。
// 并发安全（复核修复）：读-算-写整体在任务锁内，并发 deliver 不丢失任一方登记。
export async function registerDelivery({ projectRoot, task, dispatchKey, payload }) {
  return withOwnerLock(path.join(task.root, "locks", "task.lock"), async () => {
    return deliverLocked({ projectRoot, task, dispatchKey, payload })
  })
}

// §5 deliver payload 校验（一次聚合全部错误，不写任何事实）
function validateDeliveryPayload({ payload, writable, dispatch }) {
  const reasons = []
  const source = payload ?? {}
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return ["payload 必须是对象（outcome/summary/paths/checks/unresolved）"]
  }
  reasons.push(...unknownFields(source, DELIVER_FIELDS, "deliver 参数"))
  const { outcome, summary, paths = [], checks = [], unresolved = [] } = source
  if (outcome !== "delivered" && outcome !== "blocked") reasons.push("outcome 只能是 delivered 或 blocked")
  if (typeof summary !== "string" || summary.trim() === "") reasons.push("summary 必填（一句话说明本轮做了什么）")
  // B13：先判形状再遍历——任何非数组输入在遍历前聚合拒绝，不抛裸 TypeError（§5 同步汇总）
  const pathsOk = Array.isArray(paths)
  if (!pathsOk) reasons.push("paths 必须是路径数组（本包当前阶段的完整交付清单，不是增量）")
  else if (paths.some((p) => typeof p !== "string")) reasons.push("paths 的每一项都必须是字符串路径")
  const checksOk = Array.isArray(checks)
  if (!checksOk) reasons.push("checks 必须是数组 [{name, result}]")
  const checkNames = new Set()
  for (const c of checksOk ? checks : []) {
    if (!c || typeof c !== "object" || Array.isArray(c)) { reasons.push(`check 格式错误：${JSON.stringify(c)}（需要 {name, result}）`); continue }
    reasons.push(...unknownFields(c, CHECK_FIELDS, "check"))
    if (typeof c.name !== "string" || c.name.trim() === "") reasons.push(`check.name 非空：${JSON.stringify(c)}`)
    else if (checkNames.has(c.name)) reasons.push(`check.name 重复：${c.name}（同名检查只能一条）`)
    checkNames.add(c.name)
    if (!["pass", "fail", "not-run"].includes(c.result)) reasons.push(`check.result 只能是 pass|fail|not-run：${JSON.stringify(c)}`)
  }
  const unresolvedOk = Array.isArray(unresolved)
  if (!unresolvedOk) reasons.push("unresolved 必须是字符串数组")
  else if (unresolved.some((u) => typeof u !== "string" || u.trim() === "")) reasons.push("unresolved 的每一项都必须是非空字符串")
  const normalized = []
  const seen = new Set()
  for (const p of Array.isArray(paths) ? paths : []) {
    const rel = normalizeRelative(p)
    if (rel === null) { reasons.push(`路径不合法：${JSON.stringify(p)}（必须是项目内相对路径）`); continue }
    if (seen.has(rel)) { reasons.push(`路径重复：${rel}（完整清单内每条路径只出现一次）`); continue }
    seen.add(rel)
    if (!writableMatch(writable, rel)) {
      // 恢复边双层（无死门）：目录条目语义提示（写法纠正）+ blocked 升级通道（任务确需范围外路径时）
      reasons.push(`路径 ${rel} 不在本派单可写范围（${writable.map((w) => w?.path ?? String(w)).join("、") || "无"}；目录条目以 / 结尾才授权其下路径，如 docs/。本派单：${dispatch.detail.role} 轮次 ${dispatch.detail.round}${dispatch.detail.package ? " 包 " + dispatch.detail.package : ""}）。若完成目标确需范围外修改，或必要性/修法授权仍有实质争议：不要改派单外文件或先造新方案——以 --outcome blocked 交付（paths 留空），在 summary/unresolved 写明基线、证据和待确认方向，保留原有效制品。Lead 先请用户明确方向与授权，再按原恢复通道处理，不自行扩权。其余发现写进已有交付物或 unresolved。`)
    }
    normalized.push(rel)
  }
  if (outcome === "blocked" && normalized.length > 0) {
    reasons.push("blocked 交付的 paths 必须为空（blocked 不登记制品、不覆盖此前有效清单；说明写 summary/unresolved）")
  }
  if (outcome === "delivered" && normalized.length === 0 && writable.length > 0) {
    reasons.push("本轮声明 delivered 但没有登记任何路径；--paths 是本包完整交付清单：要保留此前交付的文件必须全部重新列入，空清单就表示此前文件不再属于本包有效制品。纯反驳/说明请确认派单是否允许无产出交付。")
  }
  normalized.sort()
  // 形状错误时返回安全空集合（调用方在 reasons 非空时已拒绝；防御后续构造读到非法形状）
  return { reasons, outcome, summary, paths: normalized, checks: checksOk ? checks : [], unresolved: unresolvedOk ? unresolved : [] }
}

async function deliverLocked({ projectRoot, task, dispatchKey, payload }) {
  const fresh = await freshState(task)
  const dispatch = findDispatch(fresh.journal, dispatchKey)
  if (!dispatch || dispatch.detail.role !== "owner") {
    throw reject([`dispatchKey ${dispatchKey} 不对应有效的 Owner 派单。${dispatch ? `该 key 属于 ${dispatch.detail.role} 派单（轮次 ${dispatch.detail.round}${dispatch.detail.package ? "，包 " + dispatch.detail.package : ""}）——deliver 只接受 owner 派单 key，你可能用了评审者的 key。` : inflightHint(fresh.journal, fresh.reports)} 请从你的派单文本原样复制 --key 的值。`])
  }
  // F3：superseded 波的 key 拒绝（作废恢复边：重新推进取新卡；I5 拒绝必有出路）
  if (supersededKeys(fresh.journal).has(dispatchKey)) {
    throw reject([`dispatchKey ${dispatchKey} 对应的波已作废（tw retire 或迁移恢复）。该 key 不再接受交付：请重新 tw-dispatch / tw dispatch-plan 推进取新卡；作废原因见任务 journal 的 dispatch-superseded 事件。`])
  }
  // 注意：用户裁决不新增跨波旧 key 禁止守卫——未作废旧 key 异内容重交在此被允许形成新版本（§6.1）。

  const writable = dispatch.detail.writable ?? []
  const validated = validateDeliveryPayload({ payload, writable, dispatch })
  const reasons = [...validated.reasons]
  // §6.1 包间互斥：相同路径不能被两个活动包同时认领（可写集互斥由 plan 保证，这里防迟到重交跨包覆盖）
  const pkg = dispatch.detail.package ?? null
  if (validated.outcome === "delivered" && pkg != null && Array.isArray(fresh.packages) && fresh.packages.length) {
    const others = baselineFiles({ journal: fresh.journal, reports: fresh.reports, artifacts: fresh.artifacts, stage: typeof dispatch.detail.stage === "string" && dispatch.detail.stage ? dispatch.detail.stage : currentStageOf(fresh.journal, task.scope) })
      .filter((b) => b.package !== pkg)
    for (const rel of validated.paths) {
      for (const other of others) {
        if (other.files.some((f) => f.path === rel)) {
          reasons.push(`路径 ${rel} 已被包 ${other.package} 的当前有效清单认领（报告 ${other.reportId}）：相同路径不能被两个活动包同时认领；确需调整归属先由 Lead 处理包计划。`)
        }
      }
    }
  }
  if (reasons.length) throw reject([...new Set(reasons)])

  // —— §6.1 稳定读取全部路径的原始字节（先读全部再写，单路径失败不留孤儿快照）——
  // B4：阶段归属取原派单冻结值（dispatched.detail.stage），旧 key 迟到重交按原阶段提交；
  // 旧事件无 stage 回退当前阶段（兼容迁移前事实，不新增禁止旧 key 的守卫）。
  const stage = typeof dispatch.detail.stage === "string" && dispatch.detail.stage ? dispatch.detail.stage : currentStageOf(fresh.journal, task.scope)
  const kindOf = (rel) => writableMatch(writable, rel)?.artifactKind ?? "misc"
  const files = []
  for (const rel of validated.paths) {
    const bytes = await readStableBytes(projectRoot, rel)
    files.push({ path: rel, digestAlgorithm: BYTES_DIGEST_ALGORITHM, digest: digestBytes(bytes), kind: kindOf(rel), bytes })
  }

  // F7/§6.1 幂等：key + 规范化 payload + 全部路径内容字节均相同才幂等返回；
  // 文件内容或清单变化则是新版本（ver+1）。
  const payloadNow = { outcome: validated.outcome, summary: validated.summary, paths: [...validated.paths], checks: [...validated.checks].sort((a, b) => String(a?.name ?? "").localeCompare(String(b?.name ?? ""))), unresolved: [...(validated.unresolved ?? [])].sort() }
  const payloadDigest = digestValue(payloadNow)
  // R3-1：prior 取 journal 投影中该 reportId 的最新 ver 条目（fresh.reports 含全部已提交版本）——
  // report-committed 已提交而报告文件写前崩溃时，重试基于已提交 ver 计算下一 ver，不重写同 ver 事实。
  const prior = fresh.reports.filter((r) => r?.reportId === "deliver-" + dispatchKey).sort((a, b) => (b.ver ?? 1) - (a.ver ?? 1))[0] ?? null
  const digestPrior = (p) => digestValue({ outcome: p?.outcome, summary: p?.summary, paths: [...(p?.paths ?? [])].sort(), checks: [...(p?.checks ?? [])].sort((a, b) => String(a?.name ?? "").localeCompare(String(b?.name ?? ""))), unresolved: [...(p?.unresolved ?? [])].sort() })
  const priorDigest = prior ? (prior.payloadDigest ?? digestPrior(prior.payload ?? {})) : null
  const bytesUnchanged = prior && Array.isArray(prior.files)
    && prior.files.length === files.length
    && prior.files.every((f, i) => f.path === files[i].path && f.digest === files[i].digest && f.digestAlgorithm === files[i].digestAlgorithm)
  if (prior && priorDigest === payloadDigest && bytesUnchanged) {
    const registered = files.map(({ path: p, digest }) => ({ path: p, digest }))
    return { reportId: `deliver-${dispatchKey}`, accepted: true, idempotent: true, ver: prior.ver ?? 1, registered, manifest: payloadNow.paths, hint: "此前已接受同一交付（相同清单与文件字节，幂等返回）；无需重复操作。" }
  }

  // 回执只比较提交前同阶段、同包的有效清单；新报告继续复用 baselineFiles。
  let prevBaselineFiles = []
  if (validated.outcome === "delivered") {
    const baseline = baselineFiles({ journal: fresh.journal, reports: fresh.reports, artifacts: fresh.artifacts, stage }).find((b) => b.package === pkg)
    prevBaselineFiles = (baseline?.files ?? []).map((f) => f.path)
    const previousReport = deliverBaselines({ journal: fresh.journal, reports: fresh.reports.filter((r) => r.stage === stage) }).get(pkg)?.report
    if (previousReport && !Array.isArray(previousReport.files) && previousReport.origin !== "user-authorized-lead-refresh") {
      // 旧协议 paths 是增量，同包索引可跨报告；只接纳能证明归属且未作废的报告。
      const excluded = supersededKeys(fresh.journal)
      const reportPackages = new Map()
      for (const report of fresh.reports) {
        if (report.stage !== stage || report.role !== "owner" || report.kind !== "deliver" || report.payload?.outcome !== "delivered") continue
        if (report.dispatchKey != null && excluded.has(report.dispatchKey)) continue
        const reportPkg = report.package === undefined ? (findDispatch(fresh.journal, report.dispatchKey)?.detail.package ?? null) : report.package
        if (reportPkg === pkg && report.reportId) reportPackages.set(report.reportId, reportPkg)
      }
      prevBaselineFiles = [...new Set(fresh.artifacts.items
        .filter((item) => item.stage === stage && typeof item.path === "string" && reportPackages.has(item.reportRef) && (item.package ?? reportPackages.get(item.reportRef)) === pkg)
        .map((item) => item.path))]
    }
  }

  // —— B2/§6.1 落盘（journal 为唯一权威）：快照 → 单次 journal 原子提交（完整版本事实）→ 可丢弃视图 ——
  // 快照文件名即内容摘要、写入幂等，崩溃残留的孤儿快照无害；report-committed 事件携带该 ver 的
  // 完整事实（files + payload），同 key v1/v2 与先 delivered 后 blocked 的历史版本都在事件流中保留、
  // 不因报告文件被覆盖而丢失；reports/ 与 artifacts.json 是事后重建的视图，提交前崩溃不产生任何
  // 已生效事实（freshState/rebuild 以 journal 事件为准，无事件的报告文件按 at 补尾但不覆盖事件序）。
  const at = new Date().toISOString()
  const reportId = `deliver-${dispatchKey}`
  // F7：报告身份 = key+ver，落盘带 ver 与 payloadDigest；旧报告无 ver 视为 ver 1。
  // F2：waveId 仅展示字段（投影判定一律经 dispatchKey join journal，不读此字段）。
  const ver = prior ? (prior.ver ?? 1) + 1 : 1
  // 旧 delivered 报告只有文件与 report-accepted，覆盖文件前随新事件原子保存其完整事实。
  const priorCommitted = prior && fresh.journal.some((e) => e.type === "report-committed" && e.detail?.reportId === reportId && (e.detail.ver ?? 1) === (prior.ver ?? 1))
  const legacyPriorReport = prior && prior.payload?.outcome === "delivered" && !priorCommitted ? prior : null
  const filesPublic = files.map(({ bytes: _bytes, ...f }) => ({ ...f, snapshotRef: `snapshots/${f.digest}.json` }))
  const committedDetail = {
    reportId, dispatchKey, kind: "deliver", role: "owner", package: pkg, stage,
    outcome: payloadNow.outcome, ver, origin: "owner",
    files: filesPublic.map(({ snapshotRef, kind, ...f }) => f), paths: payloadNow.paths, payloadDigest,
    // B2：完整报告事实进 journal（重建视图不需要依赖可能被覆盖的报告文件）
    payload: payloadNow,
    ...(legacyPriorReport ? { legacyPriorReport } : {}),
    ...(waveIdOf(fresh.journal, dispatchKey) ? { waveId: waveIdOf(fresh.journal, dispatchKey) } : {}),
    ...(dispatch.detail.round !== undefined ? { round: dispatch.detail.round } : {}),
    ...(filesPublic.length ? { kinds: Object.fromEntries(filesPublic.map((f) => [f.path, f.kind])) } : {}),
  }
  for (const { path: rel, digest, bytes } of files) {
    // 同 digest 共享同一快照文件（文件名即字节摘要）——不同路径交付相同内容时 paths 标签不互相覆盖。
    const snapFile = path.join(task.root, "snapshots", `${digest}.json`)
    let priorSnap = null
    try {
      priorSnap = JSON.parse(await readFile(snapFile, "utf8"))
    } catch {
      priorSnap = null
    }
    const labels = new Set([...(Array.isArray(priorSnap?.paths) ? priorSnap.paths : []), ...(priorSnap?.path ? [priorSnap.path] : []), rel])
    // §6.2：快照保存可无损恢复的原始字节（base64 + 格式版本），不再先转 UTF-8 文本。
    await atomicJson(snapFile, {
      format: "bytes-v1", digestAlgorithm: BYTES_DIGEST_ALGORITHM, digest,
      path: rel, paths: [...labels], encoding: "base64", data: bytes.toString("base64"), at,
    })
  }
  // 1) journal 单次原子提交（唯一权威事实）
  await appendReportEvent(task, fresh.journal, { at, event: { type: "report-committed", detail: committedDetail } })

  // 2) 视图：报告文件（最新 ver 缓存）——崩溃可由 journal 事件重建（目录被外部删除时自愈重建）
  await mkdir(path.join(task.root, "reports"), { recursive: true })
  const report = {
    reportId, dispatchKey, role: "owner", kind: "deliver", round: dispatch.detail.round, stage, package: pkg,
    ...(waveIdOf(fresh.journal, dispatchKey) ? { waveId: waveIdOf(fresh.journal, dispatchKey) } : {}),
    ver, origin: "owner", payloadDigest, files: filesPublic, payload: payloadNow, at,
  }
  await atomicJson(path.join(task.root, "reports", `${reportId}.json`), report)

  // 3) 视图：items 重算（完整清单）——本阶段本包基线整体替换；其他包与其他阶段条目保留。
  // 依据提交后事实（journal2 + allReports）重选各包最新有效清单，旧 key 迟到重交自然改变基线。
  const journal2 = [...fresh.journal, { seq: fresh.journal.length + 1, at, type: "report-committed", detail: committedDetail }]
  // B2 修订：只排除同 reportId 且 ver 不低于本次的条目（幂等重试防御）；同 key 更低 ver 的历史版本
  // （先 delivered v1 后 blocked v2 的 v1）必须保留在场，否则基线回退（排除 blocked 取 v1）会丢清单。
  const allReports = [...fresh.reports.filter((r) => !(r?.reportId === reportId && (r.ver ?? 1) >= ver)), report]
  const stageBaselines = deliverBaselines({ journal: journal2, reports: allReports.filter((r) => r.stage === stage) })
  const stageItems = fresh.artifacts.items.filter((item) => item.stage === stage)
  const items = fresh.artifacts.items.filter((item) => item.stage !== stage)
  const keptByPkg = new Map()
  for (const item of stageItems) {
    // 旧索引可能没有 package：优先从关联报告、再从原派单确认归属。
    const source = allReports.find((r) => r?.reportId === item.reportRef && r.stage === stage && r.kind === "deliver" && r.payload?.outcome === "delivered")
    const sourceDispatch = source?.dispatchKey ? findDispatch(fresh.journal, source.dispatchKey) : null
    const key = String(item.package ?? source?.package ?? sourceDispatch?.detail?.package ?? null)
    if (!keptByPkg.has(key)) keptByPkg.set(key, [])
    keptByPkg.get(key).push(item)
  }
  for (const [baselinePkg, base] of stageBaselines) {
    // B2 修订：items 一律按**基线报告自身**的 files 展开——基线可能是同 reportId 的旧 ver
    // （先 delivered v1 后 blocked v2 时基线回退 v1），此时不能用本次（blocked 空清单）的 files。
    const baseFiles = Array.isArray(base.report.files) && base.report.files.length > 0 ? base.report.files : null
    if (baseFiles) {
      for (const f of baseFiles) {
        items.push({ path: f.path, digest: f.digest, digestAlgorithm: f.digestAlgorithm, kind: f.kind ?? "misc", stage, package: baselinePkg, reportRef: base.report.reportId, snapshotRef: f.snapshotRef ?? ("snapshots/" + f.digest + ".json") })
      }
    } else {
      for (const item of keptByPkg.get(String(baselinePkg)) ?? []) items.push(item)
    }
  }
  await atomicJson(path.join(task.root, "artifacts.json"), { items, journalSeq: fresh.journal.length + 1 })

  // §6.1 交付回执：仅 delivered 比较前置有效清单；blocked 不替换清单，也不报告路径移出。
  const added = validated.outcome === "delivered" ? payloadNow.paths.filter((p) => !prevBaselineFiles.includes(p)) : []
  const removed = validated.outcome === "delivered" ? prevBaselineFiles.filter((p) => !payloadNow.paths.includes(p)) : []
  return {
    reportId, accepted: true, ver,
    registered: filesPublic.map(({ path: p, digest }) => ({ path: p, digest })),
    manifest: payloadNow.paths,
    ...(added.length ? { added } : {}), ...(removed.length ? { removed } : {}),
    hint: validated.outcome === "blocked"
      ? "已登记阻塞；此前有效清单和制品予以保留，原因将供后续恢复处理。"
      : "已登记（--paths 是完整清单：本次未列入的此前文件已移出本包有效制品，磁盘文件保留待审计）。你的交付将交非作者评审；无需其他操作。",
  }
}

// journal 追加（report-committed / report-accepted）：seq 连续、原子替换。
async function appendReportEvent(task, journal, { at, event }) {
  const file = path.join(task.root, "journal.jsonl")
  const raw = await readFile(file, "utf8")
  const seq = parseJournal(raw).length + 1
  const separator = raw.endsWith("\n") ? "" : "\n"
  await atomicWrite(file, `${raw}${separator}${JSON.stringify({ seq, at, ...event })}\n`)
}

// review：Challenger/Expert 阅卷。§5 强类型 findings/verdict；§6.2 接受前实时核验基线字节摘要。
export async function registerReview({ projectRoot, task, dispatchKey, payload }) {
  return withOwnerLock(path.join(task.root, "locks", "task.lock"), async () => {
    return reviewLocked({ projectRoot, task, dispatchKey, payload })
  })
}

// §5 scope 校验：kind 强制；ids 非空唯一且精确属于被审包集合；单 Owner 只能 all-covered。
function validateScope(scope, label, { reviewableIds, singleOwner }) {
  const reasons = []
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    return [`${label}：scope 必须是对象 {kind:"all-covered"} 或 {kind:"packages", ids:[...]}`]
  }
  reasons.push(...unknownFields(scope, SCOPE_FIELDS, label))
  if (scope.kind === "all-covered") {
    if (scope.ids !== undefined) reasons.push(`${label}：all-covered 不带 ids`)
  } else if (scope.kind === "packages") {
    if (!Array.isArray(scope.ids) || scope.ids.length === 0) {
      reasons.push(`${label}：packages scope 的 ids 必须是非空数组`)
    } else {
      if (scope.ids.some((id) => typeof id !== "string" || id.trim() === "")) reasons.push(`${label}：ids 的每一项都必须是非空字符串`)
      if (new Set(scope.ids).size !== scope.ids.length) reasons.push(`${label}：ids 不得重复`)
      for (const id of scope.ids) {
        if (typeof id === "string" && !reviewableIds.has(id)) {
          reasons.push(`${label}：包 ID「${id}」不属于本次评审覆盖的有效包集合；可选 ID：${[...reviewableIds].join("、") || "无"}。`)
        }
      }
    }
  } else {
    reasons.push(`${label}：scope.kind 必须是 all-covered 或 packages（返工范围是模型的语义判断，不能省略）`)
  }
  if (singleOwner && scope.kind === "packages") {
    reasons.push(`${label}：单 Owner 任务没有包 ID 可点名，只能用 {kind:"all-covered"}`)
  }
  return reasons
}

// §5 双结论一致性矩阵（Expert 的 recommendation × verdict）：
//   accept×accept 合法；accept×rework 合法（按 verdict 返工）；rework×accept 拒绝（互相矛盾）；
//   escalate×accept/escalate×rework 拒绝；待决 verdict 与三种 recommendation 的组合合法（不当 accept）。
function verdictCombinationError({ recommendation, verdictOutcome }) {
  if (recommendation === "rework" && verdictOutcome === "accept") {
    return "Expert 双结论矛盾：recommendation=rework 不能搭配 verdict=accept（rework 表示这版交付必须重做）。要么两者都 rework 并给出带 scope 的 must-fix，要么用待决类 verdict（choose-option/need-more-evidence/escalate-to-user）表达升级。"
  }
  if (recommendation === "escalate" && verdictOutcome === "accept") {
    return "Expert 双结论矛盾：recommendation=escalate 不能搭配 verdict=accept（escalate 表示升级用户，accept 表示接受交付）。"
  }
  if (recommendation === "escalate" && verdictOutcome === "rework") {
    return "Expert 双结论矛盾：recommendation=escalate 不能搭配 verdict=rework（升级与要求返工是不同结论）。需要返工就两者都用 rework；需要用户决定用待决类 verdict。"
  }
  return null
}

async function reviewLocked({ projectRoot, task, dispatchKey, payload }) {
  const fresh = await freshState(task)
  const dispatch = findDispatch(fresh.journal, dispatchKey)
  if (!dispatch || !["challenger", "expert"].includes(dispatch.detail.role)) {
    throw reject([`dispatchKey ${dispatchKey} 不对应有效的评审派单。${dispatch ? `该 key 属于 ${dispatch.detail.role === "owner" ? "owner 交付派单（轮次 " + dispatch.detail.round + (dispatch.detail.package ? "，包 " + dispatch.detail.package : "") + "）——review 只接受 challenger/expert 派单 key" : "未知角色派单"}。` : inflightHint(fresh.journal, fresh.reports)} 请从你的派单文本原样复制 --key 的值。`])
  }
  if (supersededKeys(fresh.journal).has(dispatchKey)) {
    throw reject([`dispatchKey ${dispatchKey} 对应的波已作废（tw retire 或迁移恢复）。该 key 不再接受评审：请重新 tw-dispatch / tw dispatch-plan 推进取新卡；作废原因见任务 journal 的 dispatch-superseded 事件。`])
  }

  // B4：阶段归属取原派单冻结值（评审派单冻结了被审基线与阶段；旧事件回退当前阶段）
  const stage = typeof dispatch.detail.stage === "string" && dispatch.detail.stage ? dispatch.detail.stage : currentStageOf(fresh.journal, task.scope)
  // B1：锁内重读真实包计划——cmdReview 以 ignorePackages 预读（避免锁外读竞态），多包/单 Owner
  // 判定与 scope 校验必须以锁内当前计划为准，否则所有任务都会被误判为单 Owner 而拒绝定向意见。
  // R3-1：计划从 journal 最新计划事件投影（fresh.packages）；无事件时回退 packages.json 文件。
  let lockedPackages = Array.isArray(fresh.packages) ? fresh.packages : task.packages
  if (!Array.isArray(lockedPackages) || !lockedPackages.length) {
    try {
      const plan = JSON.parse(await readFile(path.join(task.root, "packages.json"), "utf8"))
      if (Array.isArray(plan?.items)) lockedPackages = plan.items
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw reject(["包计划不可读取，请检查并恢复 packages.json 后用原 key 重试：" + String(error?.message ?? error)])
      }
    }
  }
  // 被审包集合：当前阶段已形成有效交付基线的包（§5：scope IDs 必须精确属于该集合）。
  const stageReports = fresh.reports.filter((r) => r.stage === stage)
  const baselines = deliverBaselines({ journal: fresh.journal, reports: stageReports })
  const multiPackage = Array.isArray(lockedPackages) && lockedPackages.length > 0
  const reviewableIds = new Set([...baselines.keys()].filter((p) => p != null))
  const singleOwner = !multiPackage
  // B3/§6.2：评审派单冻结的被审基线身份——锁内校验当前基线与冻结一致；不一致说明被审内容已变化
  // （旧 key 迟到重交/刷新/retire 回退形成了新基线），本评审不得把结论记到新基线上，拒绝并指引重新推进。
  if (Array.isArray(dispatch.detail.reviewBaseline)) {
    const frozen = dispatch.detail.reviewBaseline
    const current = [...baselines.entries()].map(([baselinePkg, base]) => ({ package: baselinePkg, reportId: base.report.reportId, ver: base.report.ver ?? 1 }))
    const same = frozen.length === current.length && frozen.every((f) => {
      const c = current.find((x) => x.package === (f.package ?? null))
      return c && c.reportId === f.reportId && c.ver === f.ver
    })
    if (!same) {
      throw reject(["被审基线与评审派单冻结的不一致（派单冻结 " + frozen.map((f) => (f.reportId ?? "?") + " v" + (f.ver ?? 1)).join("、") + "，当前 " + (current.map((c) => (c.reportId ?? "?") + " v" + (c.ver ?? 1)).join("、") || "无") + "）：被审内容在评审期间已变化，本 key 的评审不再有效。请 Lead 重新 tw-dispatch / tw dispatch-plan 派发新评审波（携带新基线身份）。"])
    }
  }

  const { summary, recommendation, findings = [], verdict } = payload ?? {}
  const reasons = []
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw reject(["review payload 必须是对象（summary/recommendation/findings/verdict）"])
  }
  // B13：review 顶层未知字段同步聚合拒绝（与 deliver 口径一致）
  reasons.push(...unknownFields(payload, REVIEW_FIELDS, "review 参数"))
  const findingsOk = Array.isArray(findings)
  if (!findingsOk) reasons.push("findings 必须是数组")
  if (typeof summary !== "string" || summary.trim() === "") reasons.push("summary 必填")
  if (!["accept", "rework", "escalate"].includes(recommendation)) {
    reasons.push("recommendation 必填：accept（这版交付合格）/ rework（这版交付必须重做）/ escalate（升级用户）。它只评价被审的这版交付，不评价产品本身；产品缺陷写 findings。")
  }
  if (!Array.isArray(findings)) reasons.push("findings 必须是数组")
  let mustFixCount = 0
  let hasScopedMustFix = false
  for (let i = 0; i < (findingsOk ? findings.length : 0); i += 1) {
    const f = findings[i]
    const label = `finding 第 ${i + 1} 项`
    if (!f || typeof f !== "object" || Array.isArray(f)) { reasons.push(`${label} 必须是对象 {severity, statement, disposition?, scope?}`); continue }
    const unknown = unknownFields(f, FINDING_FIELDS, label)
    reasons.push(...unknown)
    if (f.package !== undefined || f.packages !== undefined) {
      reasons.push(`${label} 使用了旧形状字段 ${f.package !== undefined ? "package" : "packages"}：新版用 scope 表达返工范围——整组返工写 "scope":{"kind":"all-covered"}，点名包写 "scope":{"kind":"packages","ids":["<包ID>"]}；可选包 ID：${[...reviewableIds].join("、") || "无（单 Owner 用 all-covered）"}。`)
    }
    if (!["info", "risk", "blocker"].includes(f.severity)) reasons.push(`${label} severity 只能是 info|risk|blocker`)
    if (typeof f.statement !== "string" || f.statement.trim() === "") reasons.push(`${label} statement 必填（非空）`)
    if (f.disposition !== undefined && !["must-fix", "context"].includes(f.disposition)) {
      reasons.push(`${label} disposition 只能是 must-fix|context（返工时必填）`)
    }
    if (f.scope !== undefined) reasons.push(...validateScope(f.scope, label, { reviewableIds, singleOwner }))
    if (f.disposition === "must-fix") {
      mustFixCount += 1
      if (f.scope && typeof f.scope === "object") hasScopedMustFix = true
      if (!f.scope) reasons.push(`${label} 是 must-fix 但缺 scope：返工范围是必须显式给出的语义判断——整组 {"kind":"all-covered"} 或点名 {"kind":"packages","ids":[...]}`)
    }
  }
  // —— §5 角色与 verdict ——
  if (dispatch.detail.role === "expert") {
    if (!verdict || typeof verdict !== "object" || Array.isArray(verdict)) {
      reasons.push("Expert 裁决必填 verdict 对象：{outcome, rationale, confidence, recommendedAction, risks?}")
    } else {
      reasons.push(...unknownFields(verdict, VERDICT_FIELDS, "verdict"))
      if (!["accept", "rework", "choose-option", "need-more-evidence", "escalate-to-user"].includes(verdict.outcome)) {
        reasons.push("verdict.outcome 只能是 accept|rework|choose-option|need-more-evidence|escalate-to-user")
      }
      if (typeof verdict.rationale !== "string" || verdict.rationale.trim() === "") reasons.push("verdict.rationale 必填（非空）")
      if (!["low", "medium", "high"].includes(verdict.confidence)) reasons.push("verdict.confidence 只能是 low|medium|high")
      if (typeof verdict.recommendedAction !== "string" || verdict.recommendedAction.trim() === "") {
        reasons.push("verdict.recommendedAction 必填（非空，说明建议的下一步）")
      }
      if (verdict.risks !== undefined && (!Array.isArray(verdict.risks) || verdict.risks.some((r) => typeof r !== "string" || r.trim() === ""))) {
        reasons.push("verdict.risks 必须是非空字符串数组")
      }
      if (verdict.outcome && recommendation) {
        const combo = verdictCombinationError({ recommendation, verdictOutcome: verdict.outcome })
        if (combo) reasons.push(combo)
      }
      if (verdict.outcome === "rework" && !(mustFixCount > 0 && hasScopedMustFix)) {
        reasons.push("verdict=rework 必须有至少一条 must-fix finding 且每条显式 scope（技术返工目标 = must-fix 范围的并集，不用文字暗示全组）")
      }
      if (verdict.outcome === "accept" && mustFixCount > 0) {
        reasons.push("verdict=accept 是纯通过结论，不得携带 must-fix finding（非阻塞建议用 disposition=context）")
      }
    }
  } else if (verdict !== undefined && verdict !== null) {
    reasons.push("verdict 只能由 Expert 填写；Challenger 请用 findings + recommendation")
  }
  // Challenger 纯 accept 不得携带 must-fix；rework 必须有显式 scope 的 must-fix（§5）。
  if (dispatch.detail.role === "challenger") {
    if (recommendation === "rework" && !(mustFixCount > 0 && hasScopedMustFix)) {
      reasons.push('recommendation=rework 必须有至少一条 must-fix finding 且每条显式 scope（返工目标 = must-fix 范围并集；整组 {"kind":"all-covered"} 或点名 {"kind":"packages","ids":[...]}）')
    }
    if (recommendation === "accept" && mustFixCount > 0) {
      reasons.push("recommendation=accept 是纯通过结论，不得携带 must-fix finding（非阻塞建议用 disposition=context）")
    }
  }
  if (reasons.length) throw reject([...new Set(reasons)])

  // —— §6.2 实时核验：接受评审前稳定读取各活动包基线清单的磁盘字节并比对摘要 ——
  // 文件缺失/不可读/读中变化/摘要不一致 → 同步拒绝（列路径与期望/实际），不写报告、不关闭该波。
  const toVerify = []
  for (const [baselinePkg, base] of baselines) {
    const report = base.report
    if (Array.isArray(report.files) && report.files.length > 0) {
      for (const f of report.files) toVerify.push({ package: baselinePkg, reportId: report.reportId, path: f.path, digest: f.digest, digestAlgorithm: f.digestAlgorithm ?? null, snapshotRef: f.snapshotRef ?? ("snapshots/" + f.digest + ".json") })
    } else {
      const indexed = fresh.artifacts.items.filter((it) => it.reportRef === report.reportId)
      for (const item of indexed) {
        toVerify.push({ package: baselinePkg, reportId: report.reportId, path: item.path, digest: item.digest, digestAlgorithm: item.digestAlgorithm ?? null, snapshotRef: item.snapshotRef })
      }
      for (const rel of report.payload?.paths ?? []) if (!indexed.some((item) => item.path === rel)) {
        toVerify.push({ package: baselinePkg, reportId: report.reportId, path: rel, digest: null })
      }
    }
  }
  const verification = await verifyArtifactBytes({ projectRoot, files: toVerify, taskRoot: task.root })
  if (!verification.ok) {
    throw reject(verification.mismatches.map((m) =>
      `被审制品与登记摘要不一致，评审被同步拒绝（报告 ${toVerify.find((f) => f.path === m.path)?.reportId ?? "?"}）：${m.path}——${m.reason}（期望 ${m.expected}${m.actual ? "，实际 " + m.actual : ""}）。恢复：成员按报告清单恢复文件后重新交付（tw restore 可从有效快照恢复），或 Lead 在用户明确确认后走 tw refresh-artifacts 刷新待审基线。`))
  }

  // F7：同 key 重交 = key+payloadDigest 幂等；payload 变化 = ver+1 修订
  // findings 保序——评审顺序是内容语义的一部分，与 deliver 的 paths/checks（排序归一化）口径区分。
  const normalizedFindings = findings.map((f) => ({
    severity: f.severity, statement: f.statement,
    ...(f.disposition !== undefined ? { disposition: f.disposition } : {}),
    ...(f.scope !== undefined ? { scope: f.scope.kind === "packages" ? { kind: "packages", ids: [...new Set(f.scope.ids)].sort() } : { kind: f.scope.kind } } : {}),
  }))
  const payloadNow = { summary, recommendation, findings: normalizedFindings, ...(verdict ? { verdict } : {}) }
  const payloadDigest = digestValue(payloadNow)
  // R3-1：prior 从 journal 投影取最新 ver（同 deliver 口径，不依赖报告文件视图）
  const prior = fresh.reports.filter((r) => r?.reportId === "review-" + dispatchKey).sort((a, b) => (b.ver ?? 1) - (a.ver ?? 1))[0] ?? null
  const priorDigest = prior ? (prior.payloadDigest ?? digestValue(prior.payload ?? {})) : null
  if (prior && priorDigest === payloadDigest) {
    return { reportId: `review-${dispatchKey}`, accepted: true, idempotent: true, ver: prior.ver ?? 1, reviewedDigest: prior.taskSha, hint: "此前已接受同一评审（幂等返回）；无需重复操作。" }
  }

  const at = new Date().toISOString()
  // 被审指纹（taskSha）：评审绑定当前阶段全部登记制品，保持全局口径（非每包映射）。
  const taskSha = artifactsFingerprint(fresh.artifacts.items.filter((item) => item.stage === stage))
  // 被审包快照（§6.1/§6.2.1）：统一读 deliverBaselines 投影（每包最新有效基线 + 展示轮），
  // 刷新来源的基线同样入快照（评审覆盖以报告身份与清单判定，不以 Owner 轮次判有无基线）。
  const rounds = projectRounds({ journal: fresh.journal, reports: stageReports })
  const reviewedPackages = [...baselines.entries()].map(([p, base]) => ({ package: p, round: Math.max(rounds.get(p) ?? 0, base.round ?? 0) }))
  const reportId = `review-${dispatchKey}`
  const ver = prior ? (prior.ver ?? 1) + 1 : 1
  // B2：journal 单次原子提交（唯一权威，含完整评审 payload），报告文件为事后视图
  const committedDetail = {
    reportId, dispatchKey, kind: "review", role: dispatch.detail.role, package: dispatch.detail.package ?? null,
    stage, recommendation: recommendation ?? null, ver, payloadDigest, ...(dispatch.detail.round !== undefined ? { round: dispatch.detail.round } : {}),
    // R3-2：完整报告字段进事件（视图缺失时可等价重建评审事实）
    reviewedPackages, taskSha,
    // B3：记录本次评审实际核对的基线身份（派单冻结 + 锁内校验一致后落账），供新鲜度与审计追溯
    reviewedBaseline: [...baselines.entries()].map(([p, base]) => ({ package: p, reportId: base.report.reportId, ver: base.report.ver ?? 1 })),
    payload: payloadNow,
  }
  await appendReportEvent(task, fresh.journal, { at, event: { type: "report-committed", detail: committedDetail } })
  await mkdir(path.join(task.root, "reports"), { recursive: true })
  const report = { reportId, dispatchKey, role: dispatch.detail.role, kind: "review", round: dispatch.detail.round, stage, taskSha, reviewedPackages, ...(waveIdOf(fresh.journal, dispatchKey) ? { waveId: waveIdOf(fresh.journal, dispatchKey) } : {}), ver, payloadDigest, payload: payloadNow, at }
  await atomicJson(path.join(task.root, "reports", `${reportId}.json`), report)
  return { reportId, accepted: true, ver, reviewedDigest: taskSha, hint: "意见已登记，将驱动下一波次或门禁。" }
}
