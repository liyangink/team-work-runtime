// tw-tool.js — tw 原生工具：args 透传 CLI（CLI 即接口 P4：单层契约，无第二层 schema）。
// 工作目录只来自当前调用会话的 cwd，避免插件配置跨项目影响任务目录。
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const TW_EXECUTABLE = fileURLToPath(new URL("../bin/tw.mjs", import.meta.url))

export function resolveTwExecutable() {
  return TW_EXECUTABLE
}

export function resolveChildCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === "string" && cwd ? cwd : null
}

const TW_TIMEOUT_MS = 120000

function runTw(executable, args, cwd, timeoutMs = TW_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [executable, ...args], { cwd, env: process.env })
    let done = false
    let out = ""
    let err = ""
    const timer = setTimeout(() => {
      if (done) return
      done = true
      child.kill("SIGKILL")
      resolve({ ok: false, code: "TW_TIMEOUT", message: "tw 命令超时（" + timeoutMs + "ms）被终止" })
    }, timeoutMs)
    child.stdout.on("data", (chunk) => { out += chunk })
    child.stderr.on("data", (chunk) => { err += chunk })
    child.on("close", () => {
      if (done) return
      done = true
      clearTimeout(timer)
      const text = (out || err || "").trim()
      let card = null
      try { card = JSON.parse(text) } catch { card = { ok: false, code: "TW_OUTPUT_UNPARSEABLE", message: text.slice(0, 400) } }
      resolve(card)
    })
    child.on("error", (error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: false, code: "TW_SPAWN_FAILED", message: String(error?.message ?? error) })
    })
  })
}

export function twToolDefinition() {
  return {
    name: "tw",
    timeoutMs: TW_TIMEOUT_MS,
    description: 'team-work CLI：任务目录读写（open/plan/run/deliver/review/decide/...）。args 即 CLI 参数面，如 ["gate","--task","demo"]；输出为 JSON 卡片（拒绝自带 fix 指引）。运行 tw help 查看全部命令。',
    parameters: {
      type: "object",
      properties: {
        args: { type: "array", items: { type: "string" }, description: "CLI 参数数组" },
      },
      required: ["args"],
    },
    async execute(params, exec) {
      const cwd = resolveChildCwd(exec)
      if (!cwd) {
        return {
          ok: false,
          code: "TW_CWD_UNRESOLVED",
          message: "无法确定当前子会话的工作目录；请在已打开项目的 DSH 会话中重试。",
        }
      }
      const args = Array.isArray(params?.args) ? params.args.map(String) : []
      return runTw(resolveTwExecutable(), args, cwd)
    },
    output: {
      schema: { type: "object" },
      render: (_params, card) => [{ type: "text", text: JSON.stringify(card, null, 2) }],
    },
  }
}
