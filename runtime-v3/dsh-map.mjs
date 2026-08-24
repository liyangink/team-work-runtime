// dsh-map.mjs — DSH 平台绑定：tier→模型映射（Phase 1）
// 解析链（docs/dsh-phase1-plan.md §2）：tier 显式 {provider, model} → 占位 {"use":"agent-default"}
// 解析为 DSH 主 agent 模型（~/.dsh/settings.yaml 的 agent-default-model）→ dsh.json defaults → 内置兜底；
// 结果一律标注来源（explicit / agent-default / fallback / default）。
// 派发时读取（波次粒度生效）；映射数据留项目 .team-work/platform/，不进 DSH profile。
import { readFile, mkdir } from "node:fs/promises"
import path from "node:path"
import os from "node:os"

import { controlRoot, atomicJson, readJson } from "./store.mjs"

export const TIERS = ["junior", "senior", "expert"]
export const PLACEHOLDER = "agent-default"
// 脱敏规则：不内置任何环境特定默认 provider；无法解析显式 unresolved（派发前需配置）
export const UNRESOLVED = Object.freeze({ provider: null, model: null, source: "unresolved" })

const ENTRY_EXAMPLE = '写法：{"provider":"...","model":"..."} 显式分档，或 {"use":"agent-default"} 占位（解析为 DSH 主 agent 模型）；删除本文件可自动重建占位模板'

export function dshMapPath(projectRoot) {
  return path.join(controlRoot(projectRoot), "platform", "dsh.json")
}

export function placeholderMap() {
  const tier = () => ({ use: PLACEHOLDER })
  return { tiers: { junior: tier(), senior: tier(), expert: tier() }, defaults: null }
}

// 零初始化：首次使用自动生成占位映射（安装 → open → run 即可工作；用户分档 = 改任一档为显式 {provider, model}）
export async function ensureDshMap(projectRoot) {
  const file = dshMapPath(projectRoot)
  if (await readJson(file, { allowMissing: true })) return { created: false, file }
  await mkdir(path.dirname(file), { recursive: true })
  await atomicJson(file, placeholderMap())
  return { created: true, file }
}

function invalid(message, fix) {
  const error = new Error(message)
  error.code = "MAP_INVALID"
  error.card = { ok: false, code: "MAP_INVALID", message, fix }
  return error
}

// settings.yaml 只读 agent-default-model 一个块的两个标量（完整 YAML 解析不属于 runtime 职责；DSH_SETTINGS 供测试/覆盖）
export function parseAgentDefault(text) {
  const lines = text.split(/\r?\n/)
  const idx = lines.findIndex((line) => /^agent-default-model:\s*$/.test(line))
  if (idx === -1) return null
  const found = {}
  for (const line of lines.slice(idx + 1)) {
    if (/^\S/.test(line)) break // 出现顶级键 = 块结束
    const m = line.match(/^\s+(provider|model):\s*"?([^"\s]+)"?\s*$/)
    if (m) found[m[1]] = m[2]
  }
  return found.provider && found.model ? { provider: found.provider, model: found.model } : null
}

export async function readAgentDefault({ settingsFile } = {}) {
  const file = settingsFile ?? process.env.DSH_SETTINGS ?? path.join(os.homedir(), ".dsh", "settings.yaml")
  const text = await readFile(file, "utf8").catch(() => null)
  if (text === null) return { file, resolved: null, reason: `未找到 ${file}` }
  const resolved = parseAgentDefault(text)
  return { file, resolved, reason: resolved ? null : `${file} 没有 agent-default-model 配置` }
}

function validEntry(entry, label) {
  if (entry == null) return null
  if (typeof entry !== "object" || Array.isArray(entry)) throw invalid(`${label} 必须是对象`, ENTRY_EXAMPLE)
  const keys = Object.keys(entry)
  if (keys.length === 0) throw invalid(`${label} 为空对象`, ENTRY_EXAMPLE)
  if (keys.includes("use")) {
    if (entry.use !== PLACEHOLDER) throw invalid(`${label} 的 use 只支持 "${PLACEHOLDER}"`, ENTRY_EXAMPLE)
    if (keys.length > 1) throw invalid(`${label}：use 占位不能与 provider/model 混用`, ENTRY_EXAMPLE)
    return { use: PLACEHOLDER }
  }
  for (const key of keys) {
    if (!["provider", "model"].includes(key)) throw invalid(`${label} 含未知字段 "${key}"`, ENTRY_EXAMPLE)
  }
  if (typeof entry.provider !== "string" || !entry.provider.trim() || typeof entry.model !== "string" || !entry.model.trim()) {
    throw invalid(`${label} 的 provider 与 model 必须是非空字符串`, ENTRY_EXAMPLE)
  }
  return { provider: entry.provider, model: entry.model }
}

export function validateDshMap(map) {
  if (typeof map !== "object" || map === null || Array.isArray(map)) {
    throw invalid("dsh.json 顶层必须是对象", ENTRY_EXAMPLE)
  }
  for (const key of Object.keys(map)) {
    if (!["tiers", "defaults"].includes(key)) throw invalid(`dsh.json 含未知顶层字段 "${key}"`, `只允许 tiers 与 defaults；${ENTRY_EXAMPLE}`)
  }
  if (map.tiers === null) throw invalid("tiers 不能为 null（不配置该键或用空对象 {} 表示三档全回退）", ENTRY_EXAMPLE)
  const tiers = map.tiers ?? {}
  if (typeof tiers !== "object" || Array.isArray(tiers)) throw invalid("tiers 必须是对象", ENTRY_EXAMPLE)
  const out = { tiers: {}, defaults: null }
  for (const tier of Object.keys(tiers)) {
    if (!TIERS.includes(tier)) throw invalid(`未知档位 "${tier}"`, `档位只能是 ${TIERS.join(" / ")}；${ENTRY_EXAMPLE}`)
    out.tiers[tier] = validEntry(tiers[tier], `档位 ${tier}`)
  }
  if (map.defaults != null) out.defaults = validEntry(map.defaults, "defaults")
  return out
}

// 解析三档（内部按需可查任意档名；未知档位走 defaults/内置兜底并给警告）
export async function resolveTiers(projectRoot, { settingsFile, map: mapOverride } = {}) {
  const file = dshMapPath(projectRoot)
  const raw = mapOverride !== undefined ? mapOverride : await readJson(file, { allowMissing: true })
  const warnings = []
  let map
  if (raw === null) {
    map = validateDshMap(placeholderMap())
    warnings.push(`映射文件 ${path.relative(projectRoot, file) || file} 不存在，按占位（${PLACEHOLDER}）处理；tw dispatch-plan / tw models 会自动生成`)
  } else {
    map = validateDshMap(raw)
  }
  const agentDefault = await readAgentDefault({ settingsFile })
  if (!agentDefault.resolved) {
    warnings.push(`${agentDefault.reason}；占位档只能回退 defaults，仍无则该档未解析（unresolved），派发前需配置映射`)
  }

  const resolveOne = (tier) => {
    const entry = map.tiers[tier]
    const d = map.defaults
    if (entry?.provider) return { provider: entry.provider, model: entry.model, source: "explicit" }
    if (entry?.use === PLACEHOLDER) {
      if (agentDefault.resolved) return { ...agentDefault.resolved, source: PLACEHOLDER }
      // 占位不可解析 → defaults → 内置（全局警告已给）
    } else if (entry == null) {
      warnings.push(`档位 ${tier} 未配置，回退 defaults`)
    }
    if (d?.provider) return { provider: d.provider, model: d.model, source: "fallback" }
    if (d?.use === PLACEHOLDER && agentDefault.resolved) return { ...agentDefault.resolved, source: PLACEHOLDER }
    warnings.push(`档位 ${tier} 未解析（无显式配置、占位不可解析、无 defaults）：派发前需配置映射或确认 DSH 主模型设置`)
    return { ...UNRESOLVED }
  }
  const tiers = Object.fromEntries(TIERS.map((t) => [t, resolveOne(t)]))
  return { file, map, agentDefault, tiers, warnings }
}
