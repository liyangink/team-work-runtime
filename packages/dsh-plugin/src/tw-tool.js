// tw-tool.js — tw 原生工具：args 透传 CLI（CLI 即接口 P4：单层契约，无第二层 schema）
// 平台事实（dsh-tools:2762-2790）：definition 需 parameters + output{schema, render}；
// execute 返回值经 output.schema 校验后由 render 转模型可见文本。
import { spawn } from "node:child_process"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

// twBin 解析：config → peerDep 主包 bin → PATH
export function resolveTwBin(config) {
  if (config?.twBin) return config.twBin
  try {
    return require.resolve("team-work-runtime/bin/tw.mjs")
  } catch {
    return "tw"
  }
}

// 项目根解析：config → exec.agent.session.header.cwd（子代继承父工作目录）→ process.cwd()
export function resolveProjectRoot(config, exec) {
  return config?.projectRoot ?? exec?.agent?.session?.header?.cwd ?? process.cwd()
}

function runTw(twBin, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [twBin, ...args], { cwd, env: process.env })
    let out = ""
    let err = ""
    child.stdout.on("data", (c) => { out += c })
    child.stderr.on("data", (c) => { err += c })
    child.on("close", (code) => {
      const text = (out || err || "").trim()
      let card = null
      try { card = JSON.parse(text) } catch { card = { ok: false, code: "TW_OUTPUT_UNPARSEABLE", message: text.slice(0, 400) } }
      resolve({ ...card, __exit: code ?? 0 })
    })
    child.on("error", (error) => {
      resolve({ ok: false, code: "TW_SPAWN_FAILED", message: String(error?.message ?? error) })
    })
  })
}

export function twToolDefinition(config) {
  const twBin = resolveTwBin(config)
  return {
    name: "tw",
    description: 'team-work CLI：任务目录读写（open/plan/run/deliver/review/decide/...）。args 即 CLI 参数面，如 ["gate","--task","demo"]；输出为 JSON 卡片（拒绝自带 fix 指引）。运行 tw help 查看全部命令。',
    parameters: {
      type: "object",
      properties: {
        args: { type: "array", items: { type: "string" }, description: "CLI 参数数组" },
      },
      required: ["args"],
    },
    async execute(params, exec) {
      const args = Array.isArray(params?.args) ? params.args.map(String) : []
      return runTw(twBin, args, resolveProjectRoot(config, exec))
    },
    output: {
      schema: { type: "object" },
      render: (_params, card) => JSON.stringify(card, null, 2),
    },
  }
}
