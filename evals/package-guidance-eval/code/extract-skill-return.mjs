#!/usr/bin/env node
// 从会话日志中提取 skill 工具返回的 <skill_instructions> 正文，并计算 SHA-256。
// 用法：extract-skill-return.mjs <session-logs-dir> <out-dir> <repo-skill-file>
// 说明：会话日志为 zstd 压缩的 JSONL；正文位于 tool/result 的 message.content[].text。
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { join, basename } from "node:path"

const [logDir, outDir, repoSkill] = process.argv.slice(2)
if (!logDir || !outDir || !repoSkill) {
  console.error("usage: extract-skill-return.mjs <session-logs-dir> <out-dir> <repo-skill-file>")
  process.exit(2)
}
const source = readFileSync(repoSkill)
const sourceSha = createHash("sha256").update(source).digest("hex")
mkdirSync(outDir, { recursive: true })
const lines = []
for (const name of readdirSync(logDir).filter((f) => f.endsWith(".jsonl.zstd")).sort()) {
  const raw = execFileSync("zstd", ["-dc", join(logDir, name)], { encoding: "utf8" })
  const rows = raw.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  const results = rows.filter((row) => row.type === "tool/result" && (row.data?.message?.content ?? []).some((c) => typeof c.text === "string" && c.text.includes("<skill_instructions>")))
  for (const row of results) {
    const text = (row.data.message.content ?? []).map((c) => c.text ?? "").join("")
    const match = text.match(/<skill_instructions>([\s\S]*?)<\/skill_instructions>/)
    if (!match) continue
    let body = match[1]
    if (body.startsWith("\n")) body = body.slice(1)
    if (body.endsWith("\n")) body = body.slice(0, -1)
    const buf = Buffer.from(body, "utf8")
    const sha = createHash("sha256").update(buf).digest("hex")
    const file = join(outDir, basename(name, ".jsonl.zstd") + ".md")
    writeFileSync(file, buf)
    lines.push(JSON.stringify({ log: name, seq: row.seq, bytes: buf.length, sha256: sha, matchesRepo: buf.equals(source), file }))
  }
}
lines.push(JSON.stringify({ repoSkill, repoBytes: source.length, repoSha256: sourceSha }))
console.log(lines.join("\n"))
