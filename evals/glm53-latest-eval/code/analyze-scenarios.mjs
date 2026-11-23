#!/usr/bin/env node
// 从 --json 事件流与会话事实生成场景时间线摘要（报告用）。
// 用法：analyze-scenarios.mjs <eval-root> <facts-json> <out-json>
import { readFileSync, writeFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
const [evalRoot, factsFile, outFile] = process.argv.slice(2)
if (!evalRoot || !factsFile || !outFile) { console.error("usage: analyze-scenarios.mjs <eval-root> <facts-json> <out-json>"); process.exit(2) }
const facts = JSON.parse(readFileSync(factsFile, "utf8"))
const byTag = {}
for (const tag of ["p1", "s1a", "s1b", "s1c", "s3a", "s3b", "s4a"]) {
  let lines
  try { lines = readFileSync(join(evalRoot, "evidence", tag + ".jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) } catch { continue }
  const session = lines.find((e) => e.type === "session")
  const calls = []
  const meta = readFileSync(join(evalRoot, "evidence", tag + ".meta"), "utf8")
  const startedAt = /started_at=(.+)/.exec(meta)?.[1]
  const finishedAt = /finished_at=(.+)/.exec(meta)?.[1]
  let usage = { input: 0, output: 0, cache: 0 }
  for (const e of lines) {
    if (e.type === "status" && e.usage) { usage.input += e.usage.inputTokens ?? 0; usage.output += e.usage.outputTokens ?? 0; usage.cache += e.usage.cacheReadTokens ?? 0 }
    if (e.type === "tool_call") calls.push({ at: new Date(e.time ?? 0).toISOString(), tool: e.tool, args: e.input })
    if (e.type === "tool_result") {
      const last = calls.at(-1)
      if (!last) continue
      let parsed = null
      try { parsed = JSON.parse(e.result) } catch {}
      last.status = e.status
      last.summary = parsed && typeof parsed === "object" ? {
        ok: parsed.ok, code: parsed.code, status: parsed.status, stop: parsed.stop, nextAction: parsed.nextAction,
        decisionId: parsed.decisionId, stage: parsed.stage, transition: parsed.transition,
        card: parsed.card ? { decisionId: parsed.card.decisionId, status: parsed.card.status, stop: parsed.card.stop, questionBytes: parsed.card.question ? Buffer.byteLength(parsed.card.question) : undefined, choices: parsed.card.choices } : undefined,
        dispatched: Array.isArray(parsed.dispatched) ? parsed.dispatched.map((d) => ({ key: d.key, label: d.label, sessionId: d.sessionId, role: d.role, package: d.package })) : undefined,
        waves: Array.isArray(parsed.waves) ? parsed.waves.map((w) => ({ key: w.dispatchKey, role: w.role, package: w.package, round: w.round, continuation: w.continuation })) : undefined,
      } : null
      last.resultBytes = Buffer.byteLength(String(e.result ?? ""))
      last.resultTruncated = String(e.result ?? "").includes("…") && String(e.result ?? "").length < 3000 ? "possible" : undefined
    }
  }
  const final = lines.filter((e) => e.type === "final").at(-1)
  byTag[tag] = { sessionId: session?.sessionId, cwd: session?.cwd, startedAt, finishedAt, usage, callCount: calls.length, calls, finalTextBytes: final?.text ? Buffer.byteLength(final.text) : 0, finalText: final?.text ?? null }
}
const topIds = Object.values(byTag).map((t) => t.sessionId).filter(Boolean)
const members = facts.sessions.filter((s) => !topIds.includes(s.sessionId)).map((s) => ({
  sessionId: s.sessionId, label: s.label ?? null, modelConfigs: s.modelConfigs, cwd: s.cwd, permissionPreset: s.permissionPreset,
  usage: s.usage, toolCalls: s.toolCalls.length, timeRange: s.timeRange,
  deliverOrReview: s.toolCalls.filter((c) => c.name === "bash").map((c) => c.result?.resultText ?? "").filter((t) => /reportId/.test(t)).slice(-1),
}))
writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), byTag, members }, null, 2))
console.log(JSON.stringify({ outFile, tags: Object.keys(byTag), members: members.length }, null, 2))
