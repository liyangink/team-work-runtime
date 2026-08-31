// intake.mjs — deliver / review 的调用内同步总检查（P2：一次查完全部欠账，当场返回）
// 派单身份用 dispatchKey（run 派发时生成、写进派单文本；成员从派单里照抄，是寻址不是簿记）。
import path from "node:path"
import { readFile, readdir } from "node:fs/promises"

import { digestValue } from "./domain/digests.mjs"
import { atomicJson, atomicWrite, withOwnerLock } from "./persistence/transactions.mjs"
import { readStableArtifact } from "./persistence/file-artifact-repository.mjs"
import { artifactsFingerprint } from "./gate.mjs"
import { projectRounds, inflightBatch, supersededKeys, waveIdOf } from "./waves.mjs"
import { currentStageOf } from "./derive.mjs"
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
  const reports = []
  for (const entry of await readdir(path.join(task.root, "reports")).catch(() => [])) {
    if (entry.endsWith(".json")) reports.push(await readJson(path.join(task.root, "reports", entry)))
  }
  return { journal, artifacts, reports }
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

// D2：key 不存在时列当前在途派单（帮成员发现 key 错配——E2E 实测 intake 成员用错 key 覆盖他人报告）
// 在途判定统一走 waves.inflightBatch（F3 四处共用同一纯函数；superseded 波不在在途）。
function inflightHint(journal, reports) {
  const inflight = inflightBatch({ journal, reports })
  if (!inflight) return "当前无在途派单；key 可能属于其他任务或已交付完毕"
  return `当前在途派单：${inflight.open.map((d) => `${d.key}（${d.role}${d.package ? "@" + d.package : ""} 轮次 ${d.round}）`).join("、")}——检查你是否用了别人的 key`
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
    reasons.push(`dispatchKey ${dispatchKey} 不对应有效的 Owner 派单。${dispatch ? `该 key 属于 ${dispatch.detail.role} 派单（轮次 ${dispatch.detail.round}${dispatch.detail.package ? "，包 " + dispatch.detail.package : ""}）——deliver 只接受 owner 派单 key，你可能用了评审者的 key。` : inflightHint(fresh.journal, fresh.reports)} 请从你的派单文本原样复制 --key 的值。`)
    throw reject(reasons)
  }
  // F3：superseded 波的 key 拒绝（作废恢复边：重新 run 取新卡；I5 拒绝必有出路）
  if (dispatch && supersededKeys(fresh.journal).has(dispatchKey)) {
    reasons.push(`dispatchKey ${dispatchKey} 对应的波已作废（tw retire 或迁移恢复）。该 key 不再接受交付：请重新 tw run 取新卡；作废原因见任务 journal 的 dispatch-superseded 事件。`)
    throw reject(reasons)
  }
  // F7：同 key 重交 = key+payloadDigest 幂等；payload 变化 = ver+1 修订（身份 = key+ver，最新 ver 正文在单文件）

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
    if (!allowed.has(rel)) reasons.push(`路径 ${rel} 不在本派单可写范围（${[...allowed].join("、") || "无"}；本派单：${dispatch.detail.role} 轮次 ${dispatch.detail.round}${dispatch.detail.package ? " 包 " + dispatch.detail.package : ""}）。发现的问题请写进交付物或 unresolved，不要改派单外文件。`)
    if (!normalized.includes(rel)) normalized.push(rel)
  }
  if (outcome === "delivered" && normalized.length === 0 && writable.length > 0) {
    reasons.push("本轮声明 delivered 但没有登记任何可写路径；纯反驳/说明请确认派单是否允许无产出交付")
  }
  for (const c of checks) {
    if (!c?.name || !["pass", "fail", "not-run"].includes(c.result)) reasons.push(`check 格式错误：${JSON.stringify(c)}（需要 name 与 result=pass|fail|not-run）`)
  }
  if (reasons.length) throw reject(reasons)

  // F7 事件层幂等（E2E-10 补全）：幂等判定 = key + payloadDigest（digestValue(canonicalJson(payload))，
  // 键序归一化 + 无顺序语义数组（paths/checks/unresolved）排序归一化，消除 JSON.stringify 全等的键序敏感）；
  // 同 key 同 digest 重交返回同一接受结果、不追加第二条 report-accepted、ver 不变；
  // payload 变化才是真实修订（ver+1 照常覆盖记录）。
  const payloadNow = { outcome, summary, paths: [...normalized].sort(), checks: [...checks].sort((a, b) => String(a?.name ?? "").localeCompare(String(b?.name ?? ""))), unresolved: [...(unresolved ?? [])].sort() }
  const payloadDigest = digestValue(payloadNow)
  const prior = await readJson(path.join(task.root, "reports", `deliver-${dispatchKey}.json`), { allowMissing: true })
  // 旧报告（无 payloadDigest）现场回算与当前归一化口径对齐（paths/checks/unresolved 排序），跨版本同内容重交仍幂等
  const digestPrior = (p) => digestValue({ outcome: p?.outcome, summary: p?.summary, paths: [...(p?.paths ?? [])].sort(), checks: [...(p?.checks ?? [])].sort((a, b) => String(a?.name ?? "").localeCompare(String(b?.name ?? ""))), unresolved: [...(p?.unresolved ?? [])].sort() })
  const priorDigest = prior ? (prior.payloadDigest ?? digestPrior(prior.payload ?? {})) : null
  if (prior && priorDigest === payloadDigest) {
    const registered = normalized.map((rel) => ({ path: rel, digest: fresh.artifacts.items.find((i) => i.path === rel)?.digest ?? null }))
    return { reportId: `deliver-${dispatchKey}`, accepted: true, idempotent: true, ver: prior.ver ?? 1, registered, hint: "此前已接受同一交付（幂等返回）；无需重复操作。" }
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
  // F7：报告身份 = key+ver，落盘带 ver 与 payloadDigest（digest 链即时可审计）；旧报告无 ver 视为 ver 1。
  // F2：waveId 仅展示字段（投影判定一律经 dispatchKey join journal，不读此字段）。
  const ver = prior ? (prior.ver ?? 1) + 1 : 1
  const report = { reportId, dispatchKey, role: "owner", kind: "deliver", round: dispatch.detail.round, stage, package: dispatch.detail.package ?? null, ...(waveIdOf(fresh.journal, dispatchKey) ? { waveId: waveIdOf(fresh.journal, dispatchKey) } : {}), ver, payloadDigest, payload: payloadNow, at }
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
  await atomicWrite(path.join(task.root, "journal.jsonl"), `${journal}${JSON.stringify({ seq, at, type: "report-accepted", detail: { reportId, dispatchKey, paths: normalized, ver, payloadDigest } })}\n`)
  return { reportId, accepted: true, ver, registered: registered.map(({ path: p, digest }) => ({ path: p, digest })), hint: "已登记。你的交付将交非作者评审；无需其他操作。" }
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
    reasons.push(`dispatchKey ${dispatchKey} 不对应有效的评审派单。${dispatch ? `该 key 属于 ${dispatch.detail.role === "owner" ? "owner 交付派单（轮次 " + dispatch.detail.round + (dispatch.detail.package ? "，包 " + dispatch.detail.package : "") + "）——review 只接受 challenger/expert 派单 key" : "未知角色派单"}。` : inflightHint(fresh.journal, fresh.reports)} 请从你的派单文本原样复制 --key 的值。`)
    throw reject(reasons)
  }
  // F3：superseded 波的 key 拒绝（作废恢复边：重新 run 取新卡）
  if (dispatch && supersededKeys(fresh.journal).has(dispatchKey)) {
    reasons.push(`dispatchKey ${dispatchKey} 对应的波已作废（tw retire 或迁移恢复）。该 key 不再接受评审：请重新 tw run 取新卡；作废原因见任务 journal 的 dispatch-superseded 事件。`)
    throw reject(reasons)
  }
  // F7：同 key 重交 = key+payloadDigest 幂等；payload 变化 = ver+1 修订

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

  // F7 事件层幂等：幂等判定 = key + payloadDigest（键序归一化）；findings 保序——评审顺序是内容语义的一部分，
  // 与 deliver 的 paths/checks（无顺序语义、排序归一化）口径区分；ver 不变、不追加第二条 report-accepted
  const payloadNow = { summary, recommendation, findings, ...(verdict ? { verdict } : {}) }
  const payloadDigest = digestValue(payloadNow)
  const prior = await readJson(path.join(task.root, "reports", `review-${dispatchKey}.json`), { allowMissing: true })
  const priorDigest = prior ? (prior.payloadDigest ?? digestValue(prior.payload ?? {})) : null
  if (prior && priorDigest === payloadDigest) {
    return { reportId: `review-${dispatchKey}`, accepted: true, idempotent: true, ver: prior.ver ?? 1, reviewedDigest: prior.taskSha, hint: "此前已接受同一评审（幂等返回）；无需重复操作。" }
  }

  const at = new Date().toISOString()
  const stage = currentStageOf(fresh.journal, task.scope)
  // 被审指纹（taskSha）：评审绑定当前阶段全部登记制品，保持全局口径（非每包映射）。
  // 每包指纹公式（F5 artifactFingerprints）的消费点只有三处：gate 人工门判定 / cmdDecide 落盘 / derive 僵局检测；
  // 本处 taskSha 是评审绑定的第四类用途，不与每包指纹公式混用（评审 findings 无每包指纹语义）。
  const taskSha = artifactsFingerprint(fresh.artifacts.items.filter((item) => item.stage === stage))
  // 被审包快照（v3.2 + F2）：写入处与判定处同源——统一读 waves.projectRounds 投影函数
  // （每包 max 已交付报告 round；blocked 与 superseded 波不入投影），波次机据此精确判定
  // "评审是否覆盖某包的最新交付"（同包更高轮次 = 未覆盖），不依赖时间戳近似。
  const reviewedPackages = [...projectRounds({ journal: fresh.journal, reports: fresh.reports.filter((r) => r.stage === stage) }).entries()].map(([p, round]) => ({ package: p, round }))
  const reportId = `review-${dispatchKey}`
  // F7：ver/payloadDigest 落盘（报告身份 = key+ver）；F2：waveId 仅展示字段
  const ver = prior ? (prior.ver ?? 1) + 1 : 1
  const report = { reportId, dispatchKey, role: dispatch.detail.role, kind: "review", round: dispatch.detail.round, stage, taskSha, reviewedPackages, ...(waveIdOf(fresh.journal, dispatchKey) ? { waveId: waveIdOf(fresh.journal, dispatchKey) } : {}), ver, payloadDigest, payload: payloadNow, at }
  await atomicJson(path.join(task.root, "reports", `${reportId}.json`), report)
  const journal = await readFile(path.join(task.root, "journal.jsonl"), "utf8")
  const seq = journal.trim().split("\n").length + 1
  await atomicWrite(path.join(task.root, "journal.jsonl"), `${journal}${JSON.stringify({ seq, at, type: "report-accepted", detail: { reportId, dispatchKey, recommendation: recommendation ?? null, ver, payloadDigest } })}\n`)
  return { reportId, accepted: true, ver, reviewedDigest: taskSha, hint: "意见已登记，将驱动下一波次或门禁。" }
}
