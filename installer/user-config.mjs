import { randomUUID } from "node:crypto"
import { link, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"

export const USER_CONFIG_NAME = "config.json"

const DEFAULT_CONFIG = {
  schemaVersion: "1.0",
  platforms: { opencode: { models: "auto" } },
  spec: { type: "openspec" },
}

export class UserConfigError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = "UserConfigError"
    this.code = code
    Object.assign(this, details)
  }
}

function fail(code, message, details) {
  throw new UserConfigError(code, message, details)
}

function assertObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("USER_CONFIG_INVALID", `${field} 必须是对象`)
  }
}

function assertKnownKeys(value, allowed, field) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length) fail("USER_CONFIG_INVALID", `${field} 包含未知字段：${unknown.join(", ")}`)
}

function validateConfig(config) {
  assertObject(config, "配置")
  assertKnownKeys(config, ["schemaVersion", "platforms", "spec"], "配置")
  if (config.schemaVersion !== "1.0") fail("USER_CONFIG_INVALID", "schemaVersion 必须是 1.0")

  assertObject(config.platforms, "platforms")
  assertKnownKeys(config.platforms, ["opencode"], "platforms")
  assertObject(config.platforms.opencode, "platforms.opencode")
  assertKnownKeys(config.platforms.opencode, ["command", "models", "effort"], "platforms.opencode")
  const { command, models, effort } = config.platforms.opencode
  if (command !== undefined && (typeof command !== "string" || !command.trim())) {
    fail("USER_CONFIG_INVALID", "platforms.opencode.command 必须是非空字符串")
  }
  if (models !== "auto") {
    assertObject(models, "platforms.opencode.models")
    for (const [agentId, model] of Object.entries(models)) {
      if (!agentId || typeof model !== "string" || !model.trim()) {
        fail("USER_CONFIG_INVALID", "platforms.opencode.models 必须是 agent 到非空模型名称的映射")
      }
    }
  }
  if (effort !== undefined) {
    assertObject(effort, "platforms.opencode.effort")
    for (const [agentId, value] of Object.entries(effort)) {
      if (!agentId || typeof value !== "string" || !value.trim()) {
        fail("USER_CONFIG_INVALID", "platforms.opencode.effort 必须是 agent 到非空 effort 名称的映射")
      }
    }
  }

  assertObject(config.spec, "spec")
  assertKnownKeys(config.spec, ["type", "command"], "spec")
  if (config.spec.type !== "openspec") fail("USER_CONFIG_INVALID", "spec.type 当前仅支持 openspec")
  if (config.spec.command !== undefined && (typeof config.spec.command !== "string" || !config.spec.command.trim())) {
    fail("USER_CONFIG_INVALID", "spec.command 必须是非空字符串")
  }
  return config
}

async function readConfig(configPath) {
  try {
    return validateConfig(JSON.parse(await readFile(configPath, "utf8")))
  } catch (error) {
    if (error.code === "ENOENT") return null
    if (error instanceof SyntaxError) fail("USER_CONFIG_INVALID", `${USER_CONFIG_NAME} 不是合法 JSON`)
    throw error
  }
}

async function createDefaultConfig(configPath) {
  await mkdir(path.dirname(configPath), { recursive: true })
  const temporary = path.join(path.dirname(configPath), `.${path.basename(configPath)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, { flag: "wx" })
    await link(temporary, configPath)
    return true
  } catch (error) {
    if (error.code !== "EEXIST") throw error
    return false
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function loadUserConfig({ configRoot, createIfMissing = false }) {
  if (typeof configRoot !== "string" || !configRoot.trim()) fail("USER_CONFIG_ROOT_INVALID", "用户配置目录不能为空")
  const resolvedRoot = path.resolve(configRoot)
  const configPath = path.join(resolvedRoot, USER_CONFIG_NAME)
  try {
    if ((await lstat(configPath)).isSymbolicLink()) fail("USER_CONFIG_UNSAFE", `${USER_CONFIG_NAME} 不得是符号链接`)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }

  let config = await readConfig(configPath)
  let created = false
  if (!config && createIfMissing) {
    created = await createDefaultConfig(configPath)
    config = await readConfig(configPath)
  }
  if (!config) fail("USER_CONFIG_MISSING", `缺少用户配置 ${configPath}；请先执行 team-work install`)

  const opencode = config.platforms?.opencode ?? {}
  return {
    created,
    path: configPath,
    platform: {
      id: "opencode",
      modelMap: opencode.models === "auto" ? undefined : opencode.models,
      ...(opencode.effort === undefined ? {} : { effortMap: opencode.effort }),
      opencodeCommand: opencode.command ?? "opencode",
      openspecCommand: config.spec?.command ?? "openspec",
    },
  }
}
