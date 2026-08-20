import { randomUUID } from "node:crypto"
import { link, lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import Ajv2020 from "ajv/dist/2020.js"

export const USER_CONFIG_NAME = "config.json"
export const USER_CONFIG_SCHEMA_REF = "./schemas/user-config.v1.schema.json"

const moduleRoot = path.dirname(fileURLToPath(import.meta.url))
const sourceSchemaPath = path.resolve(moduleRoot, "../schemas/user-config.v1.schema.json")
const CONFIG_LOCK_RETRIES = 200
const CONFIG_LOCK_RETRY_MS = 10
const CONFIG_LOCK_STALE_MS = 5 * 60_000

const DEFAULT_CONFIG = {
  $schema: USER_CONFIG_SCHEMA_REF,
  agents: "auto",
  platforms: { opencode: { enabled: true } },
  spec: { provider: "openspec", mode: "auto" },
}

export function resolveUserConfigRoot({ env = process.env, platform = process.platform, homeDir = os.homedir() } = {}) {
  const pathApi = platform === "win32" ? path.win32 : path
  if (env.TEAM_WORK_CONFIG_HOME?.trim()) return pathApi.resolve(env.TEAM_WORK_CONFIG_HOME)
  if (env.XDG_CONFIG_HOME?.trim()) return pathApi.resolve(env.XDG_CONFIG_HOME, "team-work")
  if (platform === "win32" && env.APPDATA?.trim()) return pathApi.resolve(env.APPDATA, "team-work")
  return pathApi.resolve(homeDir, ".config", "team-work")
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

async function assertNoConfigSymlink(configRoot, relativePath) {
  let cursor = configRoot
  try {
    if ((await lstat(cursor)).isSymbolicLink()) fail("USER_CONFIG_UNSAFE", "用户配置目录不得是符号链接")
  } catch (error) {
    if (error.code === "ENOENT") return
    throw error
  }
  for (const segment of relativePath.split(/[\\/]/).filter((entry) => entry && entry !== ".")) {
    cursor = path.join(cursor, segment)
    try {
      if ((await lstat(cursor)).isSymbolicLink()) fail("USER_CONFIG_UNSAFE", `用户配置路径不得经过符号链接：${relativePath}`)
    } catch (error) {
      if (error.code === "ENOENT") return
      throw error
    }
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== "ESRCH"
  }
}

async function withConfigLock(configPath, action) {
  const lockPath = `${configPath}.lock`
  await mkdir(path.dirname(lockPath), { recursive: true })
  let handle
  for (let attempt = 0; attempt < CONFIG_LOCK_RETRIES; attempt += 1) {
    try {
      handle = await open(lockPath, "wx", 0o600)
      break
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      let owner
      try {
        owner = JSON.parse(await readFile(lockPath, "utf8"))
      } catch {
        let age
        try {
          age = Date.now() - (await stat(lockPath)).mtimeMs
        } catch (statError) {
          if (statError.code === "ENOENT") continue
          throw statError
        }
        if (age >= CONFIG_LOCK_STALE_MS) {
          await rm(lockPath, { force: true })
          continue
        }
      }
      if (owner && !processIsAlive(owner.pid)) {
        await rm(lockPath, { force: true })
        continue
      }
      if (attempt < CONFIG_LOCK_RETRIES - 1) {
        await new Promise((resolve) => setTimeout(resolve, CONFIG_LOCK_RETRY_MS))
        continue
      }
      fail("USER_CONFIG_LOCKED", "用户配置正在被另一个 team-work 命令更新，请稍后重试", { retryable: true, lockPath })
    }
  }
  if (!handle) fail("USER_CONFIG_LOCKED", "无法获取用户配置写锁", { retryable: true, lockPath })
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`)
    return await action()
  } finally {
    await handle.close()
    await rm(lockPath, { force: true })
  }
}

let validatorPromise

async function validator() {
  if (!validatorPromise) {
    validatorPromise = readFile(sourceSchemaPath, "utf8").then((raw) => {
      const ajv = new Ajv2020({ allErrors: true, strict: true })
      return ajv.compile(JSON.parse(raw))
    })
  }
  return validatorPromise
}

async function validateConfig(config) {
  const validate = await validator()
  if (validate(config)) return config
  const details = validate.errors.map(({ instancePath, message, params }) => (
    `${instancePath || "/"} ${message}${params?.additionalProperty ? `：${params.additionalProperty}` : ""}`
  )).join("；")
  fail("USER_CONFIG_INVALID", `用户配置不符合 ${USER_CONFIG_SCHEMA_REF}：${details}`)
}

async function readConfig(configPath) {
  try {
    return await validateConfig(JSON.parse(await readFile(configPath, "utf8")))
  } catch (error) {
    if (error.code === "ENOENT") return null
    if (error instanceof SyntaxError) fail("USER_CONFIG_INVALID", `${USER_CONFIG_NAME} 不是合法 JSON`)
    throw error
  }
}

async function ensureLocalSchema(configPath) {
  const localSchemaPath = path.join(path.dirname(configPath), USER_CONFIG_SCHEMA_REF)
  await assertNoConfigSymlink(path.dirname(configPath), USER_CONFIG_SCHEMA_REF)
  await mkdir(path.dirname(localSchemaPath), { recursive: true })
  const source = await readFile(sourceSchemaPath)
  try {
    if ((await lstat(localSchemaPath)).isSymbolicLink()) fail("USER_CONFIG_UNSAFE", "用户配置 Schema 不得是符号链接")
    if ((await readFile(localSchemaPath)).equals(source)) return
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  const temporary = path.join(path.dirname(localSchemaPath), `.${path.basename(localSchemaPath)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, source, { flag: "wx" })
    await rename(temporary, localSchemaPath)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function createDefaultConfig(configPath) {
  await mkdir(path.dirname(configPath), { recursive: true })
  await ensureLocalSchema(configPath)
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
  await assertNoConfigSymlink(resolvedRoot, USER_CONFIG_NAME)
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
  await ensureLocalSchema(configPath)

  const opencode = config.platforms.opencode
  const userAgents = config.agents === "auto" ? undefined : config.agents
  return {
    created,
    path: configPath,
    config,
    platform: {
      id: "opencode",
      enabled: opencode.enabled ?? true,
      userAgents,
      opencodeCommand: opencode.command ?? "opencode",
      openspecCommand: config.spec?.command ?? "openspec",
      specMode: config.spec.mode,
    },
  }
}

export async function setOpenCodeEnabled({ configRoot, enabled, io = {} }) {
  if (typeof enabled !== "boolean") fail("USER_CONFIG_ENABLED_INVALID", "OpenCode enabled 必须是 boolean")
  if (typeof configRoot !== "string" || !configRoot.trim()) fail("USER_CONFIG_ROOT_INVALID", "用户配置目录不能为空")
  const resolvedRoot = path.resolve(configRoot)
  const configPath = path.join(resolvedRoot, USER_CONFIG_NAME)
  await assertNoConfigSymlink(resolvedRoot, `${USER_CONFIG_NAME}.lock`)
  const write = io.writeFile ?? writeFile
  const replace = io.rename ?? rename
  return withConfigLock(configPath, async () => {
    const loaded = await loadUserConfig({ configRoot })
    const current = loaded.config.platforms.opencode.enabled ?? true
    if (current === enabled) return { changed: false, enabled, path: loaded.path }

    const next = structuredClone(loaded.config)
    next.platforms.opencode.enabled = enabled
    await validateConfig(next)
    const temporary = path.join(path.dirname(loaded.path), `.${path.basename(loaded.path)}.${randomUUID()}.tmp`)
    try {
      await write(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx" })
      await replace(temporary, loaded.path)
    } finally {
      await rm(temporary, { force: true })
    }
    return { changed: true, enabled, path: loaded.path }
  })
}
