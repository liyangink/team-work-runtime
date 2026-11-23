#!/usr/bin/env node
// 解析隔离会话证据：模型请求头、工具轨迹、阶段与用量；不读取项目外路径。
// 用法：parse-session.mjs <evidence.jsonl> [session.v4.jsonl.zstd]
import { readFileSync, existsSync } from "node:fs"
import { execFileSync } from "node:child_process"

const [evidence, sessionLog] = process.argv.slice(2)
if (!evidence || !existsSync(evidence)) { console.error("usage: parse-session.mjs <evidence.jsonl> [session.zst]"); process.exit(2) }
const events = []
for (const line of readFileSync(evidence, "utf8").split("\n").filter(Boolean)) { try { events.push(JSON.parse(line)) } catch {} }
const session = events.find((e) => e.type === "session")
const toolCalls = events.filter((e) => e.type === "tool_call").map((e) => ({ tool: e.tool, input: JSON.stringify(e.input).slice(0, 240) }))
const toolResults = events.filter((e) => e.type === "tool_result").map((e) => ({ status: e.status, result: String(e.result).slice(0, 400) }))
const final = events.filter((e) => e.type === "final").at(-1)
const usage = events.filter((e) => e.type === "status" && e.usage).map((e) => e.usage)
const out = {
  sessionId: session?.sessionId,
  cwd: session?.cwd,
  eventCount: events.length,
  toolCalls,
  toolResults,
  usageTotal: usage.reduce((a, u) => ({ input: (a.input || 0) + (u.inputTokens || 0), output: (a.output || 0) + (u.outputTokens || 0) }), {}),
  finalText: final?.text?.slice(0, 4000) ?? null,
}
if (sessionLog && existsSync(sessionLog)) {
  const text = execFileSync("zstd", ["-dc", sessionLog], { encoding: "utf8" })
  const rows = text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const header = rows.find((r) => r.type === "request/header")
  const context = rows.find((r) => r.type === "request/context")
  const preset = rows.find((r) => r.type === "permission/preset")
  out.modelRequest = header?.data?.header?.config ?? null
  out.modelContext = context?.data ?? null
  out.permissionPreset = preset?.data?.preset ?? null
  out.sessionEventTypes = rows.reduce((m, r) => (m[r.type] = (m[r.type] || 0) + 1, m), {})
}
console.log(JSON.stringify(out, null, 2))
