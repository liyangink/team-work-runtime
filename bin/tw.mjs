#!/usr/bin/env node
// tw — team-work v3 CLI 入口（规约 §4；卡片输出 JSON，拒绝带修复指引）
import { tw } from "../runtime-v3/cli.mjs"

const argv = process.argv.slice(2)
const rootFlag = argv.indexOf("--project-root")
const projectRoot = rootFlag !== -1 ? argv[rootFlag + 1] : process.env.TW_PROJECT_ROOT ?? process.cwd()
const rest = rootFlag === -1 ? argv : [...argv.slice(0, rootFlag), ...argv.slice(rootFlag + 2)]

try {
  const card = await tw(rest, { projectRoot })
  process.stdout.write(JSON.stringify(card, null, 2) + "\n")
  process.exitCode = card?.ok === false ? 1 : 0
} catch (error) {
  process.stderr.write(JSON.stringify({ ok: false, code: error.code ?? "RUNTIME_ERROR", message: error.message }) + "\n")
  process.exitCode = 1
}
