// dsh-map.mjs — DSH 全局 settings 的 tier→模型解析。
// Runtime 只读取 ~/.dsh/settings.yaml（DSH_SETTINGS 可覆盖）中的 team-work-dsh.tiers；
// 项目 .team-work/platform/dsh.json 不是配置源，遗留文件由用户自行保留或删除。
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export const TIERS = ["junior", "senior", "expert"]
export const UNRESOLVED = Object.freeze({ provider: null, model: null, source: "unresolved", pool: [] })

const CONFIG_PATH = "team-work-dsh.tiers"

function configurationHint(file) {
  return `请在 ${file} 配置 ${CONFIG_PATH}.junior、${CONFIG_PATH}.senior、${CONFIG_PATH}.expert；每档为含非空 provider/model 的对象或候选数组。`
}

function unresolvedTier() {
  return { ...UNRESOLVED, pool: [] }
}

function familyOf(model) {
  return model.split("-")[0]
}

// 家族去重挑选（v3.2 选人规则：同档优先不同模型家族；已用家族之外取序首位）。
export function pickFromPool(pool, usedFamilies = []) {
  if (!pool || pool.length === 0) return null
  const fresh = pool.find((candidate) => !usedFamilies.includes(candidate.family))
  const picked = fresh ?? pool[0]
  return { ...picked, selectedBy: fresh ? "diversity" : "first" }
}

// 单波 modelHint 决策：tier 候选池 → 波内家族去重 → effort 透传。
// 解析失败的档位返回 null，由 dispatch-plan 在写入派发事实前给出可恢复 blocked 卡。
export function computeModelHint(tierResolution, usedFamilies = []) {
  if (!tierResolution?.pool?.length) return null
  const picked = pickFromPool(tierResolution.pool, usedFamilies)
  if (!picked) return null
  return {
    provider: picked.provider,
    model: picked.model,
    source: tierResolution.source,
    ...(picked.family !== undefined ? { family: picked.family } : {}),
    ...(picked.selectedBy ? { selectedBy: picked.selectedBy } : {}),
    ...(picked.effort !== undefined ? { effort: picked.effort } : {}),
  }
}

function yamlSyntaxError(message) {
  const error = new Error(`team-work-dsh 配置无法解析：${message}`)
  error.code = "MAP_INVALID"
  return error
}

function stripYamlComment(line) {
  let quote = null
  let escaped = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (quote === '"') {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (quote === "'") {
      if (char === "'" && line[i + 1] === "'") { i += 1; continue }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === "#") return line.slice(0, i)
  }
  return line
}

function yamlLines(text) {
  if (typeof text !== "string") throw yamlSyntaxError("settings 内容不是文本")
  const lines = []
  for (const [offset, raw] of text.split(/\r?\n/).entries()) {
    if (/\t/.test(raw)) throw yamlSyntaxError(`第 ${offset + 1} 行使用了不支持的制表符缩进`)
    const content = stripYamlComment(raw).trimEnd()
    if (!content.trim()) continue
    const indent = content.length - content.trimStart().length
    lines.push({ indent, content: content.trimStart(), line: offset + 1 })
  }
  return lines
}

function yamlColon(text) {
  let quote = null
  let escaped = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quote === '"') {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (quote === "'") {
      if (char === "'" && text[i + 1] === "'") { i += 1; continue }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === ":") return i
  }
  return -1
}

function quotedYaml(text, start = 0) {
  const quote = text[start]
  let escaped = false
  for (let i = start + 1; i < text.length; i += 1) {
    const char = text[i]
    if (quote === '"') {
      if (escaped) { escaped = false; continue }
      if (char === "\\") { escaped = true; continue }
      if (char !== quote) continue
      try {
        return { value: JSON.parse(text.slice(start, i + 1)), end: i + 1 }
      } catch {
        throw yamlSyntaxError("双引号字符串转义无效")
      }
    }
    if (char !== quote) continue
    if (text[i + 1] === quote) { i += 1; continue }
    return { value: text.slice(start + 1, i).replace(/''/g, "'"), end: i + 1 }
  }
  throw yamlSyntaxError("引号没有闭合")
}

function plainYamlScalar(value) {
  const text = value.trim()
  if (text === "null" || text === "~") return null
  if (text === "true") return true
  if (text === "false") return false
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return Number(text)
  return text
}

function parseYamlFlow(text) {
  let index = 0
  const skip = () => { while (/\s/.test(text[index] ?? "")) index += 1 }
  const parseKey = () => {
    skip()
    if (text[index] === '"' || text[index] === "'") {
      const parsed = quotedYaml(text, index)
      index = parsed.end
      return parsed.value
    }
    const start = index
    while (index < text.length && text[index] !== ":" && !/\s/.test(text[index])) index += 1
    const key = text.slice(start, index)
    if (!key) throw yamlSyntaxError("流式对象缺少键")
    return key
  }
  const parseValue = () => {
    skip()
    const char = text[index]
    if (char === "{") {
      index += 1
      const object = Object.create(null)
      skip()
      if (text[index] === "}") { index += 1; return object }
      while (true) {
        const key = parseKey()
        skip()
        if (text[index] !== ":") throw yamlSyntaxError("流式对象的键后缺少冒号")
        index += 1
        object[key] = parseValue()
        skip()
        if (text[index] === "}") { index += 1; return object }
        if (text[index] !== ",") throw yamlSyntaxError("流式对象字段之间缺少逗号")
        index += 1
      }
    }
    if (char === "[") {
      index += 1
      const array = []
      skip()
      if (text[index] === "]") { index += 1; return array }
      while (true) {
        array.push(parseValue())
        skip()
        if (text[index] === "]") { index += 1; return array }
        if (text[index] !== ",") throw yamlSyntaxError("流式数组元素之间缺少逗号")
        index += 1
      }
    }
    if (char === '"' || char === "'") {
      const parsed = quotedYaml(text, index)
      index = parsed.end
      return parsed.value
    }
    const start = index
    while (index < text.length && !",}]".includes(text[index])) index += 1
    const bare = text.slice(start, index).trim()
    if (!bare) throw yamlSyntaxError("流式值为空")
    return plainYamlScalar(bare)
  }
  const value = parseValue()
  skip()
  if (index !== text.length) throw yamlSyntaxError("流式值后有多余字符")
  return value
}

function parseYamlValue(text) {
  const value = text.trim()
  if (!value) return null
  if (value.startsWith("{") || value.startsWith("[")) return parseYamlFlow(value)
  if (value.startsWith('"') || value.startsWith("'")) {
    const parsed = quotedYaml(value)
    if (value.slice(parsed.end).trim()) throw yamlSyntaxError("引号值后有多余字符")
    return parsed.value
  }
  return plainYamlScalar(value)
}

function parseYamlKeyValue(text, line) {
  const colon = yamlColon(text)
  if (colon === -1) throw yamlSyntaxError(`第 ${line} 行缺少键值分隔冒号`)
  const rawKey = text.slice(0, colon).trim()
  if (!rawKey) throw yamlSyntaxError(`第 ${line} 行键为空`)
  const key = (rawKey.startsWith('"') || rawKey.startsWith("'")) ? parseYamlValue(rawKey) : rawKey
  if (typeof key !== "string" || !key) throw yamlSyntaxError(`第 ${line} 行键必须是字符串`)
  return { key, value: text.slice(colon + 1).trim() }
}

function parseYamlBlock(lines, start, indent) {
  const array = lines[start]?.content === "-" || lines[start]?.content.startsWith("- ")
  const value = array ? [] : Object.create(null)
  let index = start
  while (index < lines.length) {
    const current = lines[index]
    if (current.indent < indent) break
    if (current.indent > indent) throw yamlSyntaxError(`第 ${current.line} 行缩进层级不连续`)
    const isItem = current.content === "-" || current.content.startsWith("- ")
    if (array !== isItem) throw yamlSyntaxError(`第 ${current.line} 行对象与数组不能混用`)
    if (!array) {
      const entry = parseYamlKeyValue(current.content, current.line)
      index += 1
      if (entry.value) value[entry.key] = parseYamlValue(entry.value)
      else if (index < lines.length && lines[index].indent > indent) {
        const child = parseYamlBlock(lines, index, lines[index].indent)
        value[entry.key] = child.value
        index = child.index
      } else value[entry.key] = null
      continue
    }

    const rest = current.content === "-" ? "" : current.content.slice(2).trim()
    index += 1
    if (!rest) {
      if (index >= lines.length || lines[index].indent <= indent) throw yamlSyntaxError(`第 ${current.line} 行数组项缺少值`)
      const child = parseYamlBlock(lines, index, lines[index].indent)
      value.push(child.value)
      index = child.index
      continue
    }
    if (rest.startsWith("{") || rest.startsWith("[") || rest.startsWith('"') || rest.startsWith("'")) {
      value.push(parseYamlValue(rest))
      continue
    }
    const colon = yamlColon(rest)
    if (colon === -1) {
      value.push(parseYamlValue(rest))
      continue
    }
    const first = parseYamlKeyValue(rest, current.line)
    const item = Object.create(null)
    if (first.value) item[first.key] = parseYamlValue(first.value)
    else if (index < lines.length && lines[index].indent > indent) {
      const child = parseYamlBlock(lines, index, lines[index].indent)
      item[first.key] = child.value
      index = child.index
    } else item[first.key] = null
    if (index < lines.length && lines[index].indent > indent) {
      const extra = parseYamlBlock(lines, index, lines[index].indent)
      if (!extra.value || typeof extra.value !== "object" || Array.isArray(extra.value)) throw yamlSyntaxError(`第 ${current.line} 行数组对象的续行必须是对象`)
      Object.assign(item, extra.value)
      index = extra.index
    }
    value.push(item)
  }
  return { value, index }
}

// 只返回 DSH settings 中 team-work-dsh.tiers 的原始值；不解析、不依赖其他 settings 区段。
export function parseTeamWorkDshSettings(text) {
  const lines = yamlLines(text)
  const sectionIndex = lines.findIndex((line) => line.indent === 0 && /^team-work-dsh\s*:/.test(line.content))
  if (sectionIndex === -1) return null
  const sectionLine = lines[sectionIndex]
  const entry = parseYamlKeyValue(sectionLine.content, sectionLine.line)
  if (entry.key !== "team-work-dsh") return null
  let section
  if (entry.value) section = parseYamlValue(entry.value)
  else {
    const children = []
    for (let i = sectionIndex + 1; i < lines.length && lines[i].indent > sectionLine.indent; i += 1) children.push(lines[i])
    if (!children.length) return null
    const baseIndent = children[0].indent
    const normalized = children.map((line) => ({ ...line, indent: line.indent - baseIndent }))
    section = parseYamlBlock(normalized, 0, 0).value
  }
  if (!section || typeof section !== "object" || Array.isArray(section)) throw yamlSyntaxError("team-work-dsh 必须是对象")
  return Object.hasOwn(section, "tiers") ? section.tiers : null
}

function normalizeCandidate(candidate, label) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error(`${label} 必须是对象`)
  for (const key of Object.keys(candidate)) {
    if (!['provider', 'model', 'family', 'effort'].includes(key)) throw new Error(`${label} 含未知字段 ${JSON.stringify(key)}`)
  }
  if (!Object.hasOwn(candidate, "provider") || !Object.hasOwn(candidate, "model") || typeof candidate.provider !== "string" || !candidate.provider.trim() || typeof candidate.model !== "string" || !candidate.model.trim()) {
    throw new Error(`${label} 的 provider 与 model 必须是非空字符串`)
  }
  const hasFamily = Object.hasOwn(candidate, "family")
  const hasEffort = Object.hasOwn(candidate, "effort")
  if (hasFamily && (typeof candidate.family !== "string" || !candidate.family.trim())) {
    throw new Error(`${label} 的 family 必须是非空字符串`)
  }
  if (hasEffort && (typeof candidate.effort !== "string" || !candidate.effort.trim())) {
    throw new Error(`${label} 的 effort 必须是非空字符串`)
  }
  return {
    provider: candidate.provider.trim(),
    model: candidate.model.trim(),
    family: hasFamily ? candidate.family.trim() : familyOf(candidate.model.trim()),
    ...(hasEffort ? { effort: candidate.effort.trim() } : {}),
  }
}

function normalizeTier(entry, tier) {
  const candidates = Array.isArray(entry) ? entry : [entry]
  if (!candidates.length) throw new Error(`档位 ${tier} 的候选数组不能为空`)
  return candidates.map((candidate, index) => normalizeCandidate(candidate, `档位 ${tier} 的候选 ${index + 1}`))
}

// 静态配置校验不猜测回退：每个不可用档位都规范化为 unresolved，并附带可直接执行的修复提示。
export function validateTierSettings(rawTiers, { file = "~/.dsh/settings.yaml" } = {}) {
  const warnings = []
  const tiers = {}
  if (!rawTiers || typeof rawTiers !== "object" || Array.isArray(rawTiers)) {
    warnings.push(`未找到有效的 ${CONFIG_PATH}；${configurationHint(file)}`)
    for (const tier of TIERS) tiers[tier] = unresolvedTier()
    return { tiers, warnings }
  }
  const unknownTiers = Object.keys(rawTiers).filter((key) => !TIERS.includes(key))
  if (unknownTiers.length) {
    // tier 名称是闭集；未知键表示整份映射的意图无法判定，不能带着部分有效候选继续派发。
    warnings.push(`MAP_INVALID：${CONFIG_PATH} 含未知档位 ${unknownTiers.map((tier) => JSON.stringify(tier)).join("、")}；只允许 ${TIERS.join("、")}；${configurationHint(file)}`)
    for (const tier of TIERS) tiers[tier] = unresolvedTier()
    return { tiers, warnings }
  }
  for (const tier of TIERS) {
    if (!Object.hasOwn(rawTiers, tier)) {
      tiers[tier] = unresolvedTier()
      warnings.push(`档位 ${tier} 未配置（unresolved）；${configurationHint(file)}`)
      continue
    }
    try {
      const pool = normalizeTier(rawTiers[tier], tier)
      const top = pool[0]
      tiers[tier] = {
        pool,
        provider: top.provider,
        model: top.model,
        source: "global-settings",
        ...(top.effort !== undefined ? { effort: top.effort } : {}),
      }
    } catch (error) {
      tiers[tier] = unresolvedTier()
      warnings.push(`档位 ${tier} 无效（${error.message}，unresolved）；${configurationHint(file)}`)
    }
  }
  return { tiers, warnings }
}

function settingsPath(settingsFile) {
  const dshHome = process.env.DSH_HOME
  return settingsFile
    ?? process.env.DSH_SETTINGS
    ?? (dshHome ? path.join(dshHome, "settings.yaml") : path.join(os.homedir(), ".dsh", "settings.yaml"))
}

// 全局唯一解析入口。文件缺失、YAML 损坏和静态校验失败均返回 unresolved，不读项目配置也不写配置文件。
export async function resolveTiers({ settingsFile } = {}) {
  const file = settingsPath(settingsFile)
  let text
  try {
    text = await readFile(file, "utf8")
  } catch (error) {
    const base = validateTierSettings(null, { file })
    const reason = error?.code === "ENOENT" ? `未找到全局 DSH settings：${file}` : `无法读取全局 DSH settings：${file}（${error.message}）`
    return { file, tiers: base.tiers, warnings: [reason, ...base.warnings] }
  }
  try {
    const rawTiers = parseTeamWorkDshSettings(text)
    const resolved = validateTierSettings(rawTiers, { file })
    return { file, ...resolved }
  } catch (error) {
    const base = validateTierSettings(null, { file })
    return { file, tiers: base.tiers, warnings: [`${error.message}；${configurationHint(file)}`, ...base.warnings] }
  }
}
