// tw-tool.js — tw 原生工具：args 透传 CLI（CLI 即接口 P4：单层契约，无第二层 schema）
// 平台事实（dsh-tools 源码 + 官方 dsh-tool-bash 对照实证）：definition 需 parameters + output{schema, render}；
// execute 返回值经 output.schema 校验后由 render 转模型可见内容——render 必须返回 content 块数组
// [{type:"text",text}]（官方 bash 同形态），纯字符串会在宿主 commit 崩溃。
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { matchProjectRoot } from "./settings.js"

const require = createRequire(import.meta.url)

// twBin 解析：matchProjectRoot 命中项的 twBin → settings.twBin → peerDep 主包 bin → PATH
export function resolveTwBin(settings, hit = null) {
  if (hit?.twBin) return hit.twBin
  if (settings?.twBin) return settings.twBin
  try {
    return require.resolve("team-work-runtime/bin/tw.mjs")
  } catch {
    return "tw"
  }
}

// 项目根解析：config.projectRoot → exec.agent.session.header.cwd（子代继承父工作目录）→ process.cwd()
export function resolveProjectRoot(config, exec) {
  return config?.projectRoot ?? exec?.agent?.session?.header?.cwd ?? process.cwd()
}

const TW_TIMEOUT_MS = 120000

function runTw(twBin, args, cwd, timeoutMs = TW_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [twBin, ...args], { cwd, env: process.env })
    let done = false
    let out = ""
    let err = ""
    // F4（交叉审查①）：超时双保险——definition.timeoutMs 声明之外，内部强制 kill 并返回失败卡
    const timer = setTimeout(() => {
      if (done) return
      done = true
      child.kill("SIGKILL")
      resolve({ ok: false, code: "TW_TIMEOUT", message: "tw 命令超时（" + timeoutMs + "ms）被终止" })
    }, timeoutMs)
    child.stdout.on("data", (c) => { out += c })
    child.stderr.on("data", (c) => { err += c })
    child.on("close", (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      const text = (out || err || "").trim()
      let card = null
      try { card = JSON.parse(text) } catch { card = { ok: false, code: "TW_OUTPUT_UNPARSEABLE", message: text.slice(0, 400) } }
      resolve(card) // F4：__exit 不混入（模型可见数据保持纯卡片）
    })
    child.on("error", (error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: false, code: "TW_SPAWN_FAILED", message: String(error?.message ?? error) })
    })
  })
}

export function twToolDefinition(settings) {
  // settings 可为对象（快照）或函数（getConfig thunk，返回最新 settings 快照）。
  const snapshot = () => (typeof settings === "function" ? settings() : settings)
  return {
    name: "tw",
    timeoutMs: TW_TIMEOUT_MS, // F4：dsh-tools 支持的定义级超时（内部另有 kill 双保险）
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
      // 每次调用按 getConfig() 现值读配置（热生效；深冻结快照只读）。
      const config = snapshot() ?? {}
      const cwd = resolveProjectRoot(config, exec)
      const hit = matchProjectRoot(config?.projectRoots, cwd)
      const twBin = resolveTwBin(config, hit)
      // 命中项 path 覆盖工作目录（否则用 header.cwd/process.cwd）
      return runTw(twBin, args, hit?.path ?? cwd)
    },
    output: {
      schema: { type: "object" },
      // 宿主 render 契约（dsh-tool-bash 384 行实证）：必须返回 content 块数组
      // [{type:"text",text}]——纯字符串会导致宿主 commit 里 result.content.some 崩溃
      // （TypeError → unhandled → 宿主进程退出，实机两崩铁证）。
      render: (_params, card) => [{ type: "text", text: JSON.stringify(card, null, 2) }],
    },
  }
}
