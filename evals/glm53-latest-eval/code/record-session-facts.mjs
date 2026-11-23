#!/usr/bin/env node
// 从隔离 DSH_HOME 的会话日志提取事实：模型身份、cwd、权限、技能正文哈希、工具调用与用量。
// 用法：record-session-facts.mjs <eval-root> <repo-root> <out.json>
// 只读取 <eval-root>/home/.dsh/sessions 下的 zstd JSONL，不读取项目外目录。
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { join, basename } from "node:path"

const [evalRoot, repoRoot, outFile] = process.argv.slice(2)
if (!evalRoot || !repoRoot || !outFile) {
  console.error("usage: record-session-facts.mjs <eval-root> <repo-root> <out.json>")
  process.exit(2)
}
const repoSkill = readFileSync(join(repoRoot, "skills/team-work-v3/SKILL.md"))
const repoSha = createHash("sha256").update(repoSkill).digest("hex")
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
const skillBody = (text) => {
  const m = text.match(/<skill_instructions>\n?([\s\S]*?)\n?<\/skill_instructions>/)
  return m ? m[1] : null
}
const sessions = []
for (const file of walk(sessionsDir)) {
  const raw = execFileSync("zstd", ["-dc", file], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
  const rows = raw.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  const header = rows.find((r) => r.type === "session") ?? {}
  const descriptor = rows.find((r) => r.type === "subagent/descriptor")?.data ?? null
  const permission = rows.find((r) => r.type === "permission/preset")?.data?.preset ?? null
  const modelConfigs = []
  const skillReturns = []
  const toolCalls = []
  const resultsByCall = new Map()
  let usage = { input: 0, output: 0, cacheRead: 0 }
  let firstTime = null, lastTime = null
  for (const row of rows) {
    if (row.time) { firstTime ??= row.time; lastTime = row.time }
    if (row.type === "request/header") {
      const cfg = row.data?.header?.config
      if (cfg && !modelConfigs.some((c) => JSON.stringify(c) === JSON.stringify(cfg))) modelConfigs.push(cfg)
    }
    if (row.type === "assistant/message" && row.data?.usage) {
      usage.input += row.data.usage.inputTokens ?? 0
      usage.output += row.data.usage.outputTokens ?? 0
      usage.cacheRead += row.data.usage.cacheReadTokens ?? 0
    }
    if (row.type === "tool/call") {
      const entry = { seq: row.seq, name: row.data?.name, args: row.data?.arguments }
      toolCalls.push(entry)
    }
    if (row.type === "tool/result") {
      const text = (row.data?.message?.content ?? []).map((c) => c.text ?? "").join("")
      resultsByCall.set(row.data?.toolCallId, { seq: row.seq, text, isError: row.data?.message?.isError === true })
      if (text.includes("<skill_instructions>")) {
        const body = skillBody(text)
        if (body) {
          const buf = Buffer.from(body, "utf8")
          skillReturns.push({
            seq: row.seq,
            bytes: buf.length,
            sha256: createHash("sha256").update(buf).digest("hex"),
            matchesRepo: buf.equals(repoSkill),
            baseDir: /Base directory for this skill: ([^\n]+)/.exec(text)?.[1] ?? null,
          })
        }
      }
    }
  }
  const calls = toolCalls.map((call) => {
    const result = resultsByCall.get(callSeqToId(rows, call.seq))
    let parsed = null
    if (result?.text) { try { parsed = JSON.parse(result.text) } catch { parsed = null } }
    const summary = {}
    if (parsed && typeof parsed === "object") {
      for (const key of ["ok", "code", "status", "stop", "nextAction", "decisionId", "stage", "transition", "outcome", "failures"]) {
        if (parsed[key] !== undefined) summary[key] = parsed[key]
      }
      if (Array.isArray(parsed.dispatched)) summary.dispatched = parsed.dispatched.map((d) => ({ role: d.role, package: d.package ?? null, key: d.key, modelRef: d.modelRef }))
      if (parsed.card && typeof parsed.card === "object") {
        summary.card = {}
        for (const key of ["decisionId", "status", "stop", "nextAction", "stage", "transition"]) if (parsed.card[key] !== undefined) summary.card[key] = parsed.card[key]
        if (typeof parsed.card.question === "string") summary.card.questionBytes = Buffer.byteLength(parsed.card.question)
        if (Array.isArray(parsed.card.choices)) summary.card.choices = parsed.card.choices
        if (parsed.card.intake && typeof parsed.card.intake === "object") {
          summary.card.intakeKeys = Object.keys(parsed.card.intake)
          if (parsed.card.intake.packages) summary.card.intakePackages = parsed.card.intake.packages.map((p) => ({ id: p.id, model: p.model ?? p.modelRef, writable: p.writable, done: p.done, dependsOn: p.dependsOn }))
          if (parsed.card.intake.diff) summary.card.diff = parsed.card.intake.diff
        }
      }
      if (parsed.intake && typeof parsed.intake === "object") {
        summary.intakeKeys = Object.keys(parsed.intake)
        if (parsed.intake.diff) summary.diff = parsed.intake.diff
        if (parsed.intake.packages) summary.intakePackages = parsed.intake.packages.map((p) => ({ id: p.id, model: p.model ?? p.modelRef, writable: p.writable, done: p.done, dependsOn: p.dependsOn }))
      }
      if (typeof parsed.question === "string") summary.questionBytes = Buffer.byteLength(parsed.question)
      if (parsed.intakeFingerprint) summary.intakeFingerprint = parsed.intakeFingerprint
      if (Array.isArray(parsed.choices)) summary.choices = parsed.choices
    }
    return { seq: call.seq, name: call.name, args: clip(call.args, 1200), result: summary, isError: result?.isError ?? false, resultText: clip(result?.text, 600) }
  })
  sessions.push({
    sessionId: header.id ?? basename(file),
    cwd: header.cwd ?? null,
    delegationDepth: header.delegationDepth ?? null,
    parentSessionId: header.parentSessionId ?? header.parent ?? null,
    label: descriptor?.label ?? null,
    descriptor: descriptor ? { mode: descriptor.mode, provider: descriptor.agentProvider, model: descriptor.agentModel, effort: descriptor.agentReasoningEffort } : null,
    permissionPreset: permission,
    modelConfigs,
    skillReturns,
    usage,
    timeRange: firstTime && lastTime ? [new Date(firstTime).toISOString(), new Date(lastTime).toISOString()] : null,
    toolCallCount: calls.length,
    toolCalls: calls,
  })
}
function callSeqToId(rows, seq) {
  const row = rows.find((r) => r.type === "tool/call" && r.seq === seq)
  return row?.data?.callId ?? null
}
function clip(value, n) {
  if (value === undefined || value === null) return null
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return text.length > n ? text.slice(0, n) + "…(" + text.length + " bytes)" : text
}
const summary = {
  generatedAt: new Date().toISOString(),
  repoSkill: { path: "skills/team-work-v3/SKILL.md", bytes: repoSkill.length, sha256: repoSha },
  sessionCount: sessions.length,
  modelConfigs: [...new Set(sessions.flatMap((s) => s.modelConfigs.map((c) => JSON.stringify(c))))].map((s) => JSON.parse(s)),
  cwds: [...new Set(sessions.map((s) => s.cwd))],
  skillReturnMatches: sessions.flatMap((s) => s.skillReturns.map((r) => ({ sessionId: s.sessionId, ...r }))),
  sessions,
}
writeFileSync(outFile, JSON.stringify(summary, null, 2))
console.log(JSON.stringify({ outFile, sessionCount: sessions.length, modelConfigs: summary.modelConfigs, cwds: summary.cwds, skillReturns: summary.skillReturnMatches }, null, 2))
