// intake.mjs — deliver / review 的调用内同步总检查（P2：一次查完全部欠账，当场返回）
// 派单身份用 dispatchKey（run 派发时生成、写进派单文本；成员从派单里照抄，是寻址不是簿记）。
import path from "node:path"
import { readFile } from "node:fs/promises"

import { digestValue } from "../runtime/domain/digests.mjs"
import { atomicJson, atomicWrite, withOwnerLock } from "../runtime/persistence/transactions.mjs"
import { readStableArtifact } from "../runtime/persistence/file-artifact-repository.mjs"
import { artifactsFingerprint } from "./gate.mjs"
import { readJson } from "./store.mjs"

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

// journal 里找 dispatchKey 对应的派单合同
export function findDispatch(journal, dispatchKey) {
  return journal.find((e) => e.type === "dispatched" && e.detail?.key === dispatchKey) ?? null
}

// 执行时从磁盘重读最新事实（并发提交与跨进程重试都以此为准确保正确）
async function freshState(task) {
  const journalRaw = await readFile(path.join(task.root, "journal.jsonl"), "utf8").catch(() => "")
  const journal = journalRaw.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line))
  let artifacts = { items: [] }
  try {
    artifacts = JSON.parse(await readFile(path.join(task.root, "artifacts.json"), "utf8"))
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  return { journal, artifacts }
}

function parseJournal(raw) {
  return raw.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line))
}

// 稳定读取走 persistence 保留件：逐段拒符号链接、读中变化检测、realpath 防逃逸（I1）
async function readStable(projectRoot, relativePath) {
  try {
    const content = await readStableArtifact(projectRoot, relativePath)
    return { content, digest: digestValue(content) }
  } catch (error) {
    if (error.code === "ARTIFACT_MISSING") {
      const wrapped = new Error(`路径 ${relativePath} 不存在：先创建文件再交付；若你是纯回应/说明交付，paths 留空。`)
      wrapped.code = "INTAKE_REJECTED"
      throw wrapped
    }
    if (error.code === "ARTIFACT_PATH_ESCAPE") {
      const wrapped = new Error(`路径 ${relativePath} 越出项目根或包含符号链接（${error.message}）。交付路径必须是项目内真实文件。`)
      wrapped.code = "INTAKE_REJECTED"
      throw wrapped
    }
    if (error.code === "ARTIFACT_UNSTABLE") {
      const wrapped = new Error(`路径 ${relativePath} 在读取期间发生变化，请稍后重试交付。`)
      wrapped.code = "INTAKE_REJECTED"
      throw wrapped
    }
    throw error
  }
}

// deliver：Owner 交卷。paths ⊆ 派单可写集；同路径原地修订 = 新 digest 新快照，旧快照保留（E2E-16/I8）。
// 并发安全（复核修复）：读-算-写整体在任务锁内，并发 deliver 不丢失任一方登记。
export async function registerDelivery({ projectRoot, task, dispatchKey, payload }) {
  return withOwnerLock(path.join(task.root, "locks", "task.lock"), async () => {
    return deliverLocked({ projectRoot, task, dispatchKey, payload })
  })
}

async function deliverLocked({ projectRoot, task, dispatchKey, payload }) {
  const reasons = []
  const fresh = await freshState(task)
  const dispatch = findDispatch(fresh.journal, dispatchKey)
  if (!dispatch || dispatch.detail.role !== "owner") {
    reasons.push(`dispatchKey ${dispatchKey} 不对应有效的 Owner 派单。请从你的派单文本原样复制 --key 的值。`)
    throw reject(reasons)
  }
  // 同 key 重交 = 幂等覆盖同一报告（E2E-10：重试不产生第二身份、不烧 key）

  const { outcome, summary, paths = [], checks = [], unresolved = [] } = payload ?? {}
  if (outcome !== "delivered" && outcome !== "blocked") reasons.push("outcome 只能是 delivered 或 blocked")
  if (typeof summary !== "string" || summary.trim() === "") reasons.push("summary 必填（一句话说明本轮做了什么）")
  if (!Array.isArray(paths)) reasons.push("paths 必须是路径数组")
  const writable = dispatch.detail.writable ?? []
  const allowed = new Set(writable.map((w) => w.path))
  const normalized = []
  for (const p of paths) {
    const rel = normalizeRelative(p)
    if (rel === null) { reasons.push(`路径不合法：${JSON.stringify(p)}（必须是项目内相对路径）`); continue }
    if (!allowed.has(rel)) reasons.push(`路径 ${rel} 不在本派单可写范围（${[...allowed].join("、") || "无"}）。发现的问题请写进交付物或 unresolved，不要改派单外文件。`)
    if (!normalized.includes(rel)) normalized.push(rel)
  }
  if (outcome === "delivered" && normalized.length === 0 && writable.length > 0) {
    reasons.push("本轮声明 delivered 但没有登记任何可写路径；纯反驳/说明请确认派单是否允许无产出交付")
  }
  for (const c of checks) {
    if (!c?.name || !["pass", "fail", "not-run"].includes(c.result)) reasons.push(`check 格式错误：${JSON.stringify(c)}（需要 name 与 result=pass|fail|not-run）`)
  }
  if (reasons.length) throw reject(reasons)

  // 事件层幂等（E2E-10 补全）：同 key 同 payload 重交（重试/成员重复提交）返回同一接受结果，
  // 不追加第二条 report-accepted；payload 变化才是真实修订，照常覆盖并记录。
  const prior = await readJson(path.join(task.root, "reports", `deliver-${dispatchKey}.json`), { allowMissing: true })
  if (prior && JSON.stringify(prior.payload) === JSON.stringify({ outcome, summary, paths: normalized, checks, unresolved })) {
    const registered = normalized.map((rel) => ({ path: rel, digest: fresh.artifacts.items.find((i) => i.path === rel)?.digest ?? null }))
    return { reportId: `deliver-${dispatchKey}`, accepted: true, idempotent: true, registered, hint: "此前已接受同一交付（幂等返回）；无需重复操作。" }
  }

  // 全部检查通过后一次性落盘（I10：失败不留半态）；先读全部再写，单路径失败不留孤儿快照（复核修复）
  const at = new Date().toISOString()
  const kindByPath = new Map(writable.map((w) => [w.path, w.artifactKind]))
  const stables = []
  for (const rel of normalized) {
    stables.push({ rel, ...(await readStable(projectRoot, rel)) })
  }
  const stage = currentStageOf(fresh.journal, task.scope)
  const registered = stables.map(({ rel, digest }) => ({ path: rel, digest, kind: kindByPath.get(rel) ?? "misc", stage }))
  const reportId = `deliver-${dispatchKey}`
  const report = { reportId, dispatchKey, role: "owner", kind: "deliver", round: dispatch.detail.round, stage, payload: { outcome, summary, paths: normalized, checks, unresolved }, at }
  for (const { rel, digest, content } of stables) {
    await atomicJson(path.join(task.root, "snapshots", `${digest}.json`), { digest, path: rel, content, at })
  }
  await atomicJson(path.join(task.root, "reports", `${reportId}.json`), report)
  const items = fresh.artifacts.items.filter((item) => !normalized.includes(item.path))
  for (const reg of registered) {
    items.push({ ...reg, reportRef: reportId, snapshotRef: `snapshots/${reg.digest}.json` })
  }
  await atomicJson(path.join(task.root, "artifacts.json"), { items })
  const journal = await readFile(path.join(task.root, "journal.jsonl"), "utf8")
  const seq = journal.trim().split("\n").length + 1
  await atomicWrite(path.join(task.root, "journal.jsonl"), `${journal}${JSON.stringify({ seq, at, type: "report-accepted", detail: { reportId, dispatchKey, paths: normalized } })}\n`)
  return { reportId, accepted: true, registered: registered.map(({ path: p, digest }) => ({ path: p, digest })), hint: "已登记。你的交付将交非作者评审；无需其他操作。" }
}

// review：Challenger/Expert 阅卷。无 paths 参数（E2E-05 消解）；recommendation 只评价这版交付（E2E-09）。
// 并发安全（复核修复）：指纹计算与写入同锁，避免与并发 deliver 竞态。
export async function registerReview({ projectRoot, task, dispatchKey, payload }) {
  return withOwnerLock(path.join(task.root, "locks", "task.lock"), async () => {
    return reviewLocked({ projectRoot, task, dispatchKey, payload })
  })
}

async function reviewLocked({ projectRoot, task, dispatchKey, payload }) {
  const reasons = []
  const fresh = await freshState(task)
  const dispatch = findDispatch(fresh.journal, dispatchKey)
  if (!dispatch || !["challenger", "expert"].includes(dispatch.detail.role)) {
    reasons.push(`dispatchKey ${dispatchKey} 不对应有效的评审派单。请从你的派单文本原样复制 --key 的值。`)
    throw reject(reasons)
  }
  // 同 key 重交 = 幂等覆盖同一报告

  const { summary, recommendation, findings = [], verdict } = payload ?? {}
  if (typeof summary !== "string" || summary.trim() === "") reasons.push("summary 必填")
  if (!["accept", "rework", "escalate"].includes(recommendation)) {
    reasons.push("recommendation 必填：accept（这版交付合格）/ rework（这版交付必须重做）/ escalate（升级用户）。它只评价被审的这版交付，不评价产品本身；产品缺陷写 findings。")
  }
  for (const f of findings) {
    if (!["info", "risk", "blocker"].includes(f?.severity) || typeof f?.statement !== "string" || f.statement.trim() === "") {
      reasons.push(`finding 格式错误：${JSON.stringify(f)}（需要 severity=info|risk|blocker 与 statement）`)
    }
  }
  if (dispatch.detail.role === "expert") {
    if (!verdict || !["accept", "rework", "choose-option", "need-more-evidence", "escalate-to-user"].includes(verdict.outcome)
      || typeof verdict.rationale !== "string" || verdict.rationale.trim() === ""
      || !["low", "medium", "high"].includes(verdict.confidence)) {
      reasons.push("Expert 裁决必填 verdict：outcome（accept|rework|choose-option|need-more-evidence|escalate-to-user）、rationale、confidence（low|medium|high）、recommendedAction")
    }
  } else if (verdict) {
    reasons.push("verdict 只能由 Expert 填写；Challenger 请用 findings + recommendation")
  }
  if (reasons.length) throw reject(reasons)

  // 事件层幂等（E2E-10 补全）：同 key 同 payload 重交不追加第二条 report-accepted
  const prior = await readJson(path.join(task.root, "reports", `review-${dispatchKey}.json`), { allowMissing: true })
  if (prior && JSON.stringify(prior.payload) === JSON.stringify({ summary, recommendation, findings, ...(verdict ? { verdict } : {}) })) {
    return { reportId: `review-${dispatchKey}`, accepted: true, idempotent: true, reviewedDigest: prior.taskSha, hint: "此前已接受同一评审（幂等返回）；无需重复操作。" }
  }

  const at = new Date().toISOString()
  const stage = currentStageOf(fresh.journal, task.scope)
  // 被审指纹与 gate.mjs 的 artifactsFingerprint 同公式，门禁可校验裁决绑定的是当前制品
  const taskSha = artifactsFingerprint(fresh.artifacts.items.filter((item) => item.stage === stage))
  const reportId = `review-${dispatchKey}`
  const report = { reportId, dispatchKey, role: dispatch.detail.role, kind: "review", round: dispatch.detail.round, stage, taskSha, payload: { summary, recommendation, findings, ...(verdict ? { verdict } : {}) }, at }
  await atomicJson(path.join(task.root, "reports", `${reportId}.json`), report)
  const journal = await readFile(path.join(task.root, "journal.jsonl"), "utf8")
  const seq = journal.trim().split("\n").length + 1
  await atomicWrite(path.join(task.root, "journal.jsonl"), `${journal}${JSON.stringify({ seq, at, type: "report-accepted", detail: { reportId, dispatchKey, recommendation: recommendation ?? null } })}\n`)
  return { reportId, accepted: true, reviewedDigest: taskSha, hint: "意见已登记，将驱动下一波次或门禁。" }
}

function currentStageOf(journal, scope) {
  return journal.filter((e) => e.type === "stage-advanced").map((e) => e.detail.to).at(-1) ?? scope.entry
}
