import { createHash, randomUUID } from "node:crypto"
import { execFile as execFileCallback } from "node:child_process"
import { promisify } from "node:util"
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { applyEdits, modify, parse as parseJsonc, printParseErrorCode } from "jsonc-parser"

const execFile = promisify(execFileCallback)
export const MINIMUM_OPENCODE_VERSION = "1.18.0"
const MANIFEST_PATH = "team-work/install.json"
const BACKUP_ROOT = "team-work/backups"
const PLATFORM_ROOT = "team-work"
const LIFECYCLE_LOCK = `${PLATFORM_ROOT}/.lifecycle.lock`
const TUI_CONFIG_PATH = "tui.json"
const TUI_PLUGIN_SPEC = "./plugins/team-work-tui.tsx"
const DEFAULT_SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const MANAGED_AGENT_PATHS = new Set([
  "junior-flash", "junior-luna", "senior-terra", "senior-glm", "senior-qwen", "expert-opus", "expert-k3",
].map((id) => `agents/${id}.md`))

class LifecycleError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = "LifecycleError"
    this.code = code
    Object.assign(this, details)
  }
}

function fail(code, message, details) {
  throw new LifecycleError(code, message, details)
}

function hash(content) {
  return createHash("sha256").update(content).digest("hex")
}

function normalizeRelative(relativePath) {
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath) || relativePath.includes("\\")) {
    fail("UNSAFE_PATH", `非法安装路径：${relativePath}`)
  }
  const normalized = path.posix.normalize(relativePath)
  if (normalized === ".." || normalized.startsWith("../")) fail("UNSAFE_PATH", `安装路径越界：${relativePath}`)
  return normalized
}

function targetPath(installRoot, relativePath) {
  const normalized = normalizeRelative(relativePath)
  const target = path.resolve(installRoot, normalized)
  if (!target.startsWith(`${installRoot}${path.sep}`)) fail("UNSAFE_PATH", `安装路径越界：${relativePath}`)
  return target
}

async function exists(target) {
  return access(target).then(() => true, (error) => {
    if (error.code === "ENOENT") return false
    throw error
  })
}

async function assertNoSymlink(installRoot, relativePath) {
  let cursor = installRoot
  for (const segment of normalizeRelative(relativePath).split("/")) {
    cursor = path.join(cursor, segment)
    try {
      if ((await lstat(cursor)).isSymbolicLink()) fail("UNSAFE_PATH", `受管路径不得经过符号链接：${relativePath}`)
    } catch (error) {
      if (error.code === "ENOENT") return
      throw error
    }
  }
}

async function atomicWrite(target, content) {
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`)
  await writeFile(temporary, content, { flag: "wx" })
  await rename(temporary, target)
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === "ESRCH") return false
    return true
  }
}

async function withLifecycleLock(installRoot, force, action) {
  const lockPath = targetPath(installRoot, LIFECYCLE_LOCK)
  const parentCandidates = [PLATFORM_ROOT]
  const preexistingParents = new Set()
  for (const relativePath of parentCandidates) {
    if (await exists(targetPath(installRoot, relativePath))) preexistingParents.add(relativePath)
  }
  await assertNoSymlink(installRoot, LIFECYCLE_LOCK)
  await mkdir(path.dirname(lockPath), { recursive: true })
  let handle
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await open(lockPath, "wx", 0o600)
      break
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      let owner = null
      try {
        owner = JSON.parse(await readFile(lockPath, "utf8"))
      } catch (readError) {
        const age = Date.now() - (await stat(lockPath)).mtimeMs
        if (age < 5 * 60_000) fail("INSTALL_LOCKED", "安装锁正在初始化或近期损坏；为避免抢占活动安装器，五分钟后再使用 --force 恢复")
        if (!force) fail("INSTALL_LOCK_CORRUPT", "安装锁损坏；确认无其他安装器运行后使用 --force 恢复")
      }
      if (owner && processIsAlive(owner.pid)) fail("INSTALL_LOCKED", `另一个安装器进程仍在运行（pid ${owner.pid}）`)
      await rm(lockPath, { force: true })
    }
  }
  if (!handle) fail("INSTALL_LOCKED", "无法获取 OpenCode PlatformPlugin 安装锁")
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`)
    return await action()
  } finally {
    await handle.close()
    await rm(lockPath, { force: true })
    for (const relativePath of [...parentCandidates].reverse()) {
      if (preexistingParents.has(relativePath)) continue
      try {
        await rmdir(targetPath(installRoot, relativePath))
      } catch (error) {
        if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error
      }
    }
  }
}

async function readJson(target, code) {
  try {
    return JSON.parse(await readFile(target, "utf8"))
  } catch (error) {
    if (error.code === "ENOENT") return null
    if (error instanceof SyntaxError) fail(code, `${target} 不是合法 JSON`)
    throw error
  }
}

function parseTuiConfig(content) {
  const errors = []
  const config = parseJsonc(content, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length) {
    const first = errors[0]
    fail("TUI_CONFIG_INVALID", `OpenCode ${TUI_CONFIG_PATH} 无效：${printParseErrorCode(first.error)}（offset ${first.offset}）`)
  }
  if (config === undefined) return {}
  if (!config || Array.isArray(config) || typeof config !== "object") fail("TUI_CONFIG_INVALID", `OpenCode ${TUI_CONFIG_PATH} 顶层必须是对象`)
  if (config.plugin !== undefined && !Array.isArray(config.plugin)) fail("TUI_CONFIG_INVALID", `OpenCode ${TUI_CONFIG_PATH} 的 plugin 必须是数组`)
  return config
}

function isTuiPluginEntry(entry) {
  return entry === TUI_PLUGIN_SPEC || (Array.isArray(entry) && entry[0] === TUI_PLUGIN_SPEC)
}

async function readTuiConfig(installRoot) {
  await assertNoSymlink(installRoot, TUI_CONFIG_PATH)
  const target = targetPath(installRoot, TUI_CONFIG_PATH)
  try {
    const content = await readFile(target, "utf8")
    return { target, content, config: parseTuiConfig(content), existed: true }
  } catch (error) {
    if (error.code !== "ENOENT") throw error
    return { target, content: "{}\n", config: {}, existed: false }
  }
}

async function tuiRegistrationState(installRoot) {
  const state = await readTuiConfig(installRoot)
  return { ...state, registered: state.config.plugin?.some(isTuiPluginEntry) ?? false }
}

async function ensureTuiRegistration(installRoot) {
  const state = await tuiRegistrationState(installRoot)
  if (state.registered) return { ...state, changed: false }
  const plugins = [...(state.config.plugin ?? []), TUI_PLUGIN_SPEC]
  let content = state.content
  if (!state.existed && Object.keys(state.config).length === 0) {
    content = `${JSON.stringify({ $schema: "https://opencode.ai/tui.json", plugin: plugins }, null, 2)}\n`
  } else {
    const edits = modify(content, ["plugin"], plugins, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: content.includes("\r\n") ? "\r\n" : "\n" },
    })
    content = applyEdits(content, edits)
  }
  await atomicWrite(state.target, content)
  return { ...state, content, changed: true }
}

async function removeTuiRegistration(installRoot) {
  const state = await tuiRegistrationState(installRoot)
  if (!state.registered) return { ...state, changed: false }
  const plugins = state.config.plugin.filter((entry) => !isTuiPluginEntry(entry))
  const edits = modify(state.content, ["plugin"], plugins.length ? plugins : undefined, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: state.content.includes("\r\n") ? "\r\n" : "\n" },
  })
  await atomicWrite(state.target, applyEdits(state.content, edits))
  return { ...state, changed: true }
}

async function allowedManagedPaths(sourceRoot) {
  const allowed = new Set([
    "plugins/team-work.js",
    "plugins/team-work-tui.tsx",
    `${PLATFORM_ROOT}/profile.json`,
    ...MANAGED_AGENT_PATHS,
  ])
  for (const [source, destination] of [
    ["skills/workflow", "skills/workflow"],
    ["skills/team-work", "skills/team-work"],
    ["plugins/opencode/guides", `${PLATFORM_ROOT}/guides`],
  ]) {
    for (const relativePath of await walkFiles(path.join(sourceRoot, source))) allowed.add(`${destination}/${relativePath}`)
  }
  return allowed
}

function validateManifest(manifest, allowedPaths) {
  if (!manifest || manifest.schemaVersion !== "1.0" || manifest.platform !== "opencode") {
    fail("INSTALL_MANIFEST_INVALID", "安装清单版本或平台无效")
  }
  if (!["installed", "partial", "uninstalled"].includes(manifest.status) || !Array.isArray(manifest.managedFiles)) {
    fail("INSTALL_MANIFEST_INVALID", "安装清单状态或 managedFiles 无效")
  }
  const seen = new Set()
  for (const entry of manifest.managedFiles) {
    if (!entry || Object.keys(entry).some((key) => !["path", "sha256"].includes(key))) {
      fail("INSTALL_MANIFEST_INVALID", "安装清单包含未知文件字段")
    }
    const relativePath = normalizeRelative(entry.path)
    if (!relativePath.startsWith("team-work/") && !allowedPaths.has(relativePath)) {
      fail("INSTALL_MANIFEST_UNSAFE", `清单包含当前安装源未物化的路径：${relativePath}`)
    }
    if (!/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")) fail("INSTALL_MANIFEST_INVALID", `清单 digest 无效：${relativePath}`)
    if (seen.has(relativePath)) fail("INSTALL_MANIFEST_INVALID", `清单路径重复：${relativePath}`)
    seen.add(relativePath)
  }
  return manifest
}

function parseVersion(value) {
  const match = String(value ?? "").match(/(\d+)\.(\d+)\.(\d+)/)
  if (!match) fail("OPENCODE_VERSION_UNKNOWN", `无法解析 OpenCode 版本：${value ?? "<empty>"}`)
  return match.slice(1).map(Number)
}

function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

async function detectHostVersion(opencodeCommand = "opencode") {
  try {
    const { stdout, stderr } = await execFile(opencodeCommand, ["--version"], { encoding: "utf8" })
    return (stdout || stderr).trim()
  } catch (error) {
    fail("OPENCODE_NOT_FOUND", `无法执行 ${opencodeCommand} --version`, { cause: error })
  }
}

async function walkFiles(root, prefix = "", options = {}) {
  const result = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    const absolutePath = path.join(root, entry.name)
    if (entry.isSymbolicLink()) {
      if (options.skipSymlinks) continue
      fail("SOURCE_SYMLINK_UNSUPPORTED", `安装源不得包含符号链接：${absolutePath}`)
    }
    if (entry.isDirectory()) result.push(...await walkFiles(absolutePath, relativePath, options))
    else if (entry.isFile()) result.push(relativePath)
  }
  return result.sort()
}

async function addTree(files, source, destination, options) {
  for (const relativePath of await walkFiles(source, "", options)) {
    files.set(normalizeRelative(`${destination}/${relativePath}`), await readFile(path.join(source, relativePath)))
  }
}

async function scanModels(opencodeCommand) {
  try {
    const { stdout } = await execFile(opencodeCommand, ["models"], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })
    return {
      models: stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[^\s/]+\/.+/.test(line)),
      error: null,
    }
  } catch (error) {
    return {
      models: [],
      error: String(error.stderr || error.message || error).trim().slice(0, 1200),
    }
  }
}

async function probeConfiguredModels(opencodeCommand, models) {
  const probeRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-model-probe-"))
  const results = new Map()
  try {
    for (const model of models) {
      try {
        const { stdout } = await execFile(opencodeCommand, [
          "--pure",
          "run",
          "--model", model,
          "--format", "json",
          "--title", "team-work doctor model probe",
          "仅回复 OK",
        ], {
          cwd: probeRoot,
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
          timeout: 60_000,
          env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: "true" },
        })
        const events = stdout.split(/\r?\n/).filter(Boolean).map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        }).filter(Boolean)
        const errorEvent = events.find(({ type }) => type === "error")
        if (errorEvent) throw new Error(JSON.stringify(errorEvent.error ?? errorEvent).slice(0, 1000))
        const text = events
          .filter(({ type, part }) => type === "text" && part?.type === "text")
          .map(({ part }) => part.text)
          .join("\n")
        if (!/(?:^|\W)OK(?:\W|$)/i.test(text)) throw new Error("OpenCode 未返回预期的模型文本 OK")
        results.set(model, { status: "ok" })
      } catch (error) {
        results.set(model, {
          status: "failed",
          message: String(error.stderr || error.stdout || error.message || error).trim().slice(0, 1200),
        })
      }
    }
  } finally {
    await rm(probeRoot, { recursive: true, force: true })
  }
  return results
}

function resolveModels(agentConfig, explicitMap, availableModels) {
  const warnings = []
  const resolved = new Map()
  const knownAgents = new Set(agentConfig.agents.map(({ id }) => id))
  const unknownAgents = Object.keys(explicitMap ?? {}).filter((id) => !knownAgents.has(id))
  if (unknownAgents.length) fail("INVALID_MODEL_MAP", `模型映射包含未知 Agent：${unknownAgents.join(", ")}`)
  for (const agent of agentConfig.agents) {
    if (explicitMap && !Object.hasOwn(explicitMap, agent.id)) continue
    const explicit = explicitMap?.[agent.id]
    if (explicit !== undefined) {
      if (typeof explicit !== "string" || !/^[^\s/]+\/.+/.test(explicit)) {
        fail("INVALID_MODEL_MAP", `${agent.id} 必须映射为 provider/model`)
      }
      resolved.set(agent.id, explicit)
      continue
    }
    const matches = availableModels.filter((model) => model === agent.requestedModel || model.endsWith(`/${agent.requestedModel}`))
    if (matches.length === 1) resolved.set(agent.id, matches[0])
    else warnings.push(matches.length > 1
      ? `${agent.id} 的模型别名 ${agent.requestedModel} 匹配多个 provider，未自动选择`
      : `${agent.id} 的模型 ${agent.requestedModel} 不可用，自动模式不会启用该 Agent`)
  }
  return { resolved, warnings }
}

function platformProfile(agentConfig, resolved, helper, generatedAt) {
  if (helper && (typeof helper.model !== "string" || !/^[^\s/]+\/.+/.test(helper.model))) {
    fail("INVALID_HELPER_CONFIG", "helper.model 必须是 provider/model")
  }
  const helpers = [
    { id: "team-work-explore", kind: "explore", capability: "code-search" },
    { id: "team-work-librarian", kind: "librarian", capability: "web-research" },
  ].map(({ capability, ...entry }) => ({
    ...entry,
    resolvedModel: helper?.model ?? null,
    capabilities: helper ? ["read-only", capability] : ["unavailable"],
  }))
  return {
    schemaVersion: "1.0",
    platform: "opencode",
    generatedAt,
    agents: agentConfig.agents.map((agent) => ({
      ...agent,
      resolvedModel: resolved.get(agent.id) ?? null,
      capabilities: resolved.has(agent.id) ? ["general"] : ["unavailable"],
    })),
    helpers,
    dispatch: { managedMode: "background", blockingPolicy: "reject" },
    operations: {
      spawn: { supported: true, tool: "team_work_spawn" },
      assign: { supported: true, tool: "team_work_spawn" },
      resume: { supported: true, tool: "team_work_resume" },
      status: { supported: true, tool: "team_work_status" },
      stop: { supported: true, tool: "team_work_stop" },
      message: { supported: false, tool: null },
      assist: { supported: Boolean(helper), tool: helper ? "team_work_assist" : null },
      assistStatus: { supported: Boolean(helper), tool: helper ? "team_work_assist_status" : null },
      assistCollect: { supported: Boolean(helper), tool: helper ? "team_work_assist_collect" : null },
    },
    limits: { maxConcurrent: null },
    session: { childSessions: true, resume: true, crossSessionProcessRecovery: false },
    ui: { childNavigation: true, splitView: false },
    degradations: [
      { code: "lead-relay", description: "OpenCode 不提供受管成员间直接消息，本插件由 Lead 原样记录并转发成员或 Expert 结论后续派" },
      { code: "process-recovery", description: "跨进程只保证任务、制品和 session 映射恢复，不保证旧 child session 仍可运行" },
    ],
    guides: [
      ".team-work/platform/opencode/guides/team-work.md",
      ".team-work/platform/opencode/guides/recovery.md",
    ],
  }
}

async function buildDesiredFiles({ sourceRoot, modelMap, helper, availableModels, opencodeCommand, openspecCommand, specMode, skipDependencies }) {
  const files = new Map()
  await addTree(files, path.join(sourceRoot, "runtime"), "team-work/runtime")
  await addTree(files, path.join(sourceRoot, "schemas"), "team-work/schemas")
  await addTree(files, path.join(sourceRoot, "skills/workflow"), "skills/workflow")
  await addTree(files, path.join(sourceRoot, "skills/team-work"), "skills/team-work")
  await addTree(files, path.join(sourceRoot, "plugins/opencode/guides"), "team-work/guides")
  await addTree(files, path.join(sourceRoot, "plugins/opencode/tui"), "team-work/tui")
  files.set("team-work/opencode-adapter.mjs", await readFile(path.join(sourceRoot, "plugins/opencode/src/opencode-adapter.mjs")))
  files.set("team-work/opencode-activation.mjs", await readFile(path.join(sourceRoot, "plugins/opencode/src/activation.mjs")))
  files.set("team-work/opencode-agent-config.mjs", await readFile(path.join(sourceRoot, "plugins/opencode/src/agent-config.mjs")))
  files.set("team-work/installer/user-config.mjs", await readFile(path.join(sourceRoot, "installer/user-config.mjs")))
  files.set("plugins/team-work.js", await readFile(path.join(sourceRoot, "plugins/opencode/assets/team-work.js")))
  files.set("plugins/team-work-tui.tsx", await readFile(path.join(sourceRoot, "plugins/opencode/assets/team-work-tui.tsx")))

  const packageConfig = JSON.parse(await readFile(path.join(sourceRoot, "package.json"), "utf8"))
  const runtimePackage = {
    name: packageConfig.name,
    version: packageConfig.version,
    private: true,
    type: "module",
    dependencies: packageConfig.dependencies ?? {},
  }
  const packageContent = Buffer.from(`${JSON.stringify(runtimePackage, null, 2)}\n`)
  const packageLockContent = await readFile(path.join(sourceRoot, "plugins/opencode/config/runtime-package-lock.json"))
  files.set("team-work/package.json", packageContent)
  files.set("team-work/package-lock.json", packageLockContent)
  files.set("team-work/settings.json", Buffer.from(`${JSON.stringify({
    spec: { provider: "openspec", mode: specMode ?? "auto", command: openspecCommand },
  }, null, 2)}\n`))

  if (!skipDependencies && Object.keys(runtimePackage.dependencies).length) {
    const staging = await mkdtemp(path.join(os.tmpdir(), "team-work-deps-"))
    try {
      await writeFile(path.join(staging, "package.json"), packageContent)
      await writeFile(path.join(staging, "package-lock.json"), packageLockContent)
      await execFile("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
        cwd: staging,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      })
      await addTree(files, path.join(staging, "node_modules"), "team-work/node_modules", { skipSymlinks: true })
    } catch (error) {
      fail("DEPENDENCY_INSTALL_FAILED", "Runtime 依赖安装失败；项目文件尚未修改", { cause: error })
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  const agentConfig = JSON.parse(await readFile(path.join(sourceRoot, "plugins/opencode/config/agents.json"), "utf8"))
  const scan = availableModels !== undefined
    ? { models: availableModels, error: null }
    : modelMap
      ? { models: [], error: null }
      : await scanModels(opencodeCommand)
  const { resolved, warnings } = resolveModels(agentConfig, modelMap, scan.models)
  if (scan.error) warnings.unshift(`无法读取 OpenCode 模型列表：${scan.error}`)
  return {
    files,
    warnings,
    packageVersion: packageConfig.version,
    agentIds: [...resolved.keys(), ...(helper ? ["team-work-explore", "team-work-librarian"] : [])],
    profile: platformProfile(agentConfig, resolved, helper, ""),
  }
}

function withoutGeneratedAt(profile) {
  const copy = structuredClone(profile)
  delete copy.generatedAt
  return copy
}

async function materializeProfile(installRoot, desired, now) {
  const target = targetPath(installRoot, `${PLATFORM_ROOT}/profile.json`)
  await assertNoSymlink(installRoot, `${PLATFORM_ROOT}/profile.json`)
  let current = null
  try {
    current = JSON.parse(await readFile(target, "utf8"))
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error
  }
  const unchanged = typeof current?.generatedAt === "string"
    && JSON.stringify(withoutGeneratedAt(current)) === JSON.stringify(withoutGeneratedAt(desired.profile))
  desired.profile.generatedAt = unchanged ? current.generatedAt : now().toISOString()
  desired.files.set(`${PLATFORM_ROOT}/profile.json`, Buffer.from(`${JSON.stringify(desired.profile, null, 2)}\n`))
}

async function currentDigest(installRoot, relativePath) {
  const target = targetPath(installRoot, relativePath)
  return await exists(target) ? hash(await readFile(target)) : null
}

function manifestFiles(files) {
  return [...files.entries()].map(([relativePath, content]) => ({ path: relativePath, sha256: hash(content) })).sort((a, b) => a.path.localeCompare(b.path))
}

async function createBackup(installRoot, relativePaths, now) {
  const existing = []
  for (const relativePath of [...new Set(relativePaths)].sort()) {
    await assertNoSymlink(installRoot, relativePath)
    const source = targetPath(installRoot, relativePath)
    if (await exists(source)) existing.push(relativePath)
  }
  if (!existing.length) return null
  const stamp = now().toISOString().replace(/[:.]/g, "-")
  const relativeBackup = `${BACKUP_ROOT}/${stamp}-${randomUUID().slice(0, 8)}`
  await assertNoSymlink(installRoot, relativeBackup)
  const backupPath = targetPath(installRoot, relativeBackup)
  for (const relativePath of existing) {
    const content = await readFile(targetPath(installRoot, relativePath))
    await atomicWrite(path.join(backupPath, relativePath), content)
  }
  await atomicWrite(path.join(backupPath, "backup.json"), `${JSON.stringify({ schemaVersion: "1.0", createdAt: now().toISOString(), files: existing }, null, 2)}\n`)
  return backupPath
}

async function restoreBackup(installRoot, backupPath, pathsToRemove) {
  for (const relativePath of pathsToRemove) await rm(targetPath(installRoot, relativePath), { force: true })
  if (!backupPath) return
  const relativeBackup = normalizeRelative(path.relative(installRoot, backupPath).split(path.sep).join("/"))
  if (!relativeBackup.startsWith(`${BACKUP_ROOT}/`)) fail("UNSAFE_PATH", "备份路径不属于 OpenCode PlatformPlugin")
  await assertNoSymlink(installRoot, relativeBackup)
  const backup = JSON.parse(await readFile(path.join(backupPath, "backup.json"), "utf8"))
  for (const relativePath of backup.files) {
    await assertNoSymlink(installRoot, `${relativeBackup}/${relativePath}`)
    await atomicWrite(targetPath(installRoot, relativePath), await readFile(path.join(backupPath, relativePath)))
  }
}

async function writeManifest(installRoot, manifest) {
  await atomicWrite(targetPath(installRoot, MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`)
}

async function smokeCheck(installRoot, opencodeCommand, expectedAgents) {
  let lastFailure = null
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const { stdout, stderr } = await execFile(opencodeCommand, ["agent", "list"], {
        cwd: installRoot,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout: 30_000,
      })
      const missing = expectedAgents.filter((agent) => !stdout.includes(agent))
      if (!missing.length) return
      lastFailure = {
        missing,
        stdout: stdout.trim().slice(-1200),
        stderr: stderr.trim().slice(-1200),
      }
    } catch (error) {
      lastFailure = {
        message: String(error.message || error).trim().slice(0, 1200),
        stdout: String(error.stdout || "").trim().slice(-1200),
        stderr: String(error.stderr || "").trim().slice(-1200),
      }
    }
  }
  const missing = lastFailure?.missing
  const message = missing?.length
    ? `OpenCode 未发现已安装 Agent：${missing.join(", ")}`
    : "OpenCode Plugin/Agent smoke test 失败；已开始回滚"
  fail("SMOKE_TEST_FAILED", message, { diagnostics: lastFailure })
}

async function applyInstall({ installRoot, desired, prior, force, now, hostVersion, packageVersion, warnings, command, opencodeCommand, agentIds, skipSmoke }) {
  const tuiState = await tuiRegistrationState(installRoot)
  const tuiNeedsPatch = !tuiState.registered
  const desiredEntries = manifestFiles(desired)
  const desiredByPath = new Map(desiredEntries.map((entry) => [entry.path, entry]))
  const priorFiles = prior?.managedFiles ?? []
  const priorByPath = new Map(priorFiles.map((entry) => [entry.path, entry]))
  const collisions = []
  const modified = []
  const actualDigests = new Map()
  const preexistingDesired = new Set()

  for (const entry of desiredEntries) {
    await assertNoSymlink(installRoot, entry.path)
    const digest = await currentDigest(installRoot, entry.path)
    actualDigests.set(entry.path, digest)
    if (digest !== null) preexistingDesired.add(entry.path)
    if ((!prior || !priorByPath.has(entry.path)) && digest !== null) collisions.push(entry.path)
  }
  for (const entry of priorFiles) {
    await assertNoSymlink(installRoot, entry.path)
    const digest = await currentDigest(installRoot, entry.path)
    if (digest !== null && digest !== entry.sha256) modified.push(entry.path)
  }
  if (collisions.length && !force) fail("INSTALL_COLLISION", "安装目标包含非受管文件；未做任何修改", { files: collisions })
  if (modified.length && !force) fail("MANAGED_FILE_MODIFIED", "受管文件已被本地修改；请先保留改动或使用 --force 备份后更新", { files: modified })

  const obsolete = priorFiles.filter(({ path: relativePath }) => !desiredByPath.has(relativePath)).map(({ path: relativePath }) => relativePath)
  const changed = desiredEntries.filter(({ path: relativePath, sha256 }) => (
    priorByPath.get(relativePath)?.sha256 !== sha256
    || actualDigests.get(relativePath) !== sha256
    || modified.includes(relativePath)
  ))
  const missing = desiredEntries.filter(({ path: relativePath }) => !priorByPath.has(relativePath))
  if (prior && !changed.length && !missing.length && !obsolete.length && !tuiNeedsPatch) {
    return { status: "unchanged", manifestId: prior.manifestId, warnings }
  }

  const backupCandidates = prior
    ? [...priorFiles.map(({ path: relativePath }) => relativePath), ...collisions, ...(tuiState.existed && tuiNeedsPatch ? [TUI_CONFIG_PATH] : [])]
    : [...collisions, ...(tuiState.existed && tuiNeedsPatch ? [TUI_CONFIG_PATH] : [])]
  const backupPath = await createBackup(installRoot, backupCandidates, now)
  const createdPaths = desiredEntries
    .filter(({ path: relativePath }) => !priorByPath.has(relativePath) && !preexistingDesired.has(relativePath))
    .map(({ path: relativePath }) => relativePath)
  if (!tuiState.existed && tuiNeedsPatch) createdPaths.push(TUI_CONFIG_PATH)
  try {
    for (const relativePath of obsolete) await rm(targetPath(installRoot, relativePath), { force: true })
    for (const [relativePath, content] of desired) await atomicWrite(targetPath(installRoot, relativePath), content)
    await ensureTuiRegistration(installRoot)
    if (!skipSmoke) await smokeCheck(installRoot, opencodeCommand, agentIds)
    const timestamp = now().toISOString()
    const manifest = {
      schemaVersion: "1.0",
      platform: "opencode",
      status: "installed",
      manifestId: prior?.manifestId ?? randomUUID(),
      packageVersion,
      minimumHostVersion: MINIMUM_OPENCODE_VERSION,
      hostVersion,
      installedAt: prior?.installedAt ?? timestamp,
      updatedAt: timestamp,
      lastOperation: command,
      tui: { configPath: TUI_CONFIG_PATH, plugin: TUI_PLUGIN_SPEC },
      managedFiles: desiredEntries,
      warnings,
    }
    await writeManifest(installRoot, manifest)
    return { status: prior ? "updated" : "installed", manifestId: manifest.manifestId, backupPath, warnings }
  } catch (error) {
    await restoreBackup(installRoot, backupPath, [...createdPaths, ...obsolete])
    await pruneEmptyManagedDirectories(installRoot, createdPaths)
    throw error
  }
}

async function uninstall({ installRoot, prior, force, now }) {
  if (!prior || !["installed", "partial"].includes(prior.status)) return { status: "not-installed", retained: [] }
  const retained = []
  const removable = []
  for (const entry of prior.managedFiles ?? []) {
    await assertNoSymlink(installRoot, entry.path)
    const digest = await currentDigest(installRoot, entry.path)
    if (digest === null) continue
    if (digest !== entry.sha256 && !force) retained.push(entry)
    else removable.push(entry.path)
  }
  const tuiState = await tuiRegistrationState(installRoot)
  const tuiPath = tuiState.existed && tuiState.registered ? [TUI_CONFIG_PATH] : []
  const backupPath = await createBackup(installRoot, [...removable, ...tuiPath], now)
  try {
    await removeTuiRegistration(installRoot)
    for (const relativePath of removable) await rm(targetPath(installRoot, relativePath), { force: true })
    await pruneEmptyManagedDirectories(installRoot, removable)

    const timestamp = now().toISOString()
    await writeManifest(installRoot, {
      ...prior,
      status: retained.length ? "partial" : "uninstalled",
      updatedAt: timestamp,
      uninstalledAt: retained.length ? null : timestamp,
      lastOperation: "uninstall",
      managedFiles: retained,
      retained: retained.map(({ path: relativePath }) => relativePath),
    })
  } catch (error) {
    await restoreBackup(installRoot, backupPath, [...removable, ...tuiPath])
    throw error
  }
  return {
    status: retained.length ? "partial" : "uninstalled",
    retained: retained.map(({ path: relativePath }) => relativePath),
    backupPath,
  }
}

async function pruneEmptyManagedDirectories(installRoot, removedFiles) {
  const protectedDirectories = new Set(["agents", "plugins", "skills", PLATFORM_ROOT])
  const directories = new Set()
  for (const relativePath of removedFiles) {
    let directory = path.posix.dirname(relativePath)
    while (directory !== "." && !protectedDirectories.has(directory)) {
      directories.add(directory)
      directory = path.posix.dirname(directory)
    }
  }
  for (const relativePath of [...directories].sort((left, right) => right.split("/").length - left.split("/").length)) {
    try {
      await rmdir(targetPath(installRoot, relativePath))
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error
    }
  }
}

async function doctor({ installRoot, prior, hostVersion, modelMap, helper, availableModels, opencodeCommand, probeModels }) {
  const issues = []
  const modelChecks = []
  if (!prior || !["installed", "partial"].includes(prior.status)) issues.push({ code: "NOT_INSTALLED", message: "OpenCode PlatformPlugin 未安装" })
  for (const entry of prior?.managedFiles ?? []) {
    const digest = await currentDigest(installRoot, entry.path)
    if (digest === null) issues.push({ code: "MANAGED_FILE_MISSING", path: entry.path })
    else if (digest !== entry.sha256) issues.push({ code: "MANAGED_FILE_MODIFIED", path: entry.path })
  }
  try {
    if (!(await tuiRegistrationState(installRoot)).registered) {
      issues.push({ code: "TUI_PLUGIN_NOT_REGISTERED", path: TUI_CONFIG_PATH, plugin: TUI_PLUGIN_SPEC })
    }
  } catch (error) {
    if (error.code === "TUI_CONFIG_INVALID") issues.push({ code: error.code, path: TUI_CONFIG_PATH, message: error.message })
    else throw error
  }
  const profile = await readJson(targetPath(installRoot, `${PLATFORM_ROOT}/profile.json`), "PROFILE_CORRUPT")
  const known = new Set((profile?.agents ?? []).map(({ id }) => id))
  const configuredAgents = []
  if (modelMap === undefined) {
    for (const agent of profile?.agents ?? []) {
      if (!agent.resolvedModel) issues.push({ code: "MODEL_UNRESOLVED", agent: agent.id, requestedModel: agent.requestedModel })
      else configuredAgents.push([agent.id, agent.resolvedModel])
    }
  } else {
    for (const [agent, model] of Object.entries(modelMap)) {
      if (!known.has(agent)) issues.push({ code: "AGENT_UNKNOWN", agent })
      else configuredAgents.push([agent, model])
    }
  }

  const consumers = new Map()
  for (const [agent, model] of configuredAgents) consumers.set(model, [...(consumers.get(model) ?? []), agent])
  if (helper) consumers.set(helper.model, [...(consumers.get(helper.model) ?? []), "helper"])
  if (consumers.size) {
    const discovery = availableModels !== undefined
      ? { models: availableModels, error: null }
      : await scanModels(opencodeCommand)
    const visibleModels = new Set(discovery.models)
    if (discovery.error) issues.push({ code: "MODEL_DISCOVERY_FAILED", message: discovery.error })
    if (!discovery.error) {
      for (const [model, agents] of consumers) {
        if (visibleModels.has(model)) continue
        const helperOnly = agents.length === 1 && agents[0] === "helper"
        const teamAgents = agents.filter((agent) => agent !== "helper")
        issues.push(helperOnly
          ? { code: "HELPER_MODEL_UNAVAILABLE", model }
          : { code: "MODEL_UNAVAILABLE", ...(teamAgents.length === 1 ? { agent: teamAgents[0] } : { agents: teamAgents }), model })
      }
    }

    const probeCandidates = [...consumers.keys()].filter((model) => !discovery.error && visibleModels.has(model))
    const probeResults = probeModels ? await probeConfiguredModels(opencodeCommand, probeCandidates) : new Map()
    for (const [model, agents] of consumers) {
      const discoverable = discovery.error ? null : visibleModels.has(model)
      const result = probeResults.get(model)
      const probe = !probeModels ? "not-requested" : result?.status ?? "skipped"
      modelChecks.push({ model, agents, discoverable, probe, ...(result?.message ? { message: result.message } : {}) })
      if (probe === "failed") issues.push({ code: "MODEL_PROBE_FAILED", model, agents, message: result.message })
    }
  }
  return { status: issues.length ? "issues" : "ok", hostVersion, minimumHostVersion: MINIMUM_OPENCODE_VERSION, issues, modelChecks }
}

async function manageUnlocked(command, options) {
  if (!new Set(["install", "update", "uninstall", "doctor"]).has(command)) fail("INVALID_COMMAND", `未知生命周期命令：${command}`)
  const installRoot = await realpath(options.installRoot)
  const sourceRoot = await realpath(options.sourceRoot ?? DEFAULT_SOURCE_ROOT)
  const now = options.now ?? (() => new Date())
  const manifestTarget = targetPath(installRoot, MANIFEST_PATH)
  await assertNoSymlink(installRoot, MANIFEST_PATH)
  const prior = await readJson(manifestTarget, "INSTALL_MANIFEST_CORRUPT")
  if (prior) validateManifest(prior, await allowedManagedPaths(sourceRoot))

  if (command === "uninstall") return uninstall({ installRoot, prior, force: Boolean(options.force), now })

  const hostVersion = options.hostVersion ?? await detectHostVersion(options.opencodeCommand)
  if (compareVersions(hostVersion, MINIMUM_OPENCODE_VERSION) < 0) {
    fail("OPENCODE_VERSION_TOO_OLD", `OpenCode ${hostVersion} 低于最低版本 ${MINIMUM_OPENCODE_VERSION}`)
  }
  if (command === "doctor") return doctor({
    installRoot,
    prior,
    hostVersion,
    modelMap: options.modelMap,
    helper: options.helper,
    availableModels: options.availableModels,
    opencodeCommand: options.opencodeCommand ?? "opencode",
    probeModels: Boolean(options.probeModels),
  })
  if (command === "update" && prior?.status !== "installed") {
    fail("NOT_INSTALLED", "尚未安装 OpenCode PlatformPlugin，请先执行 install")
  }
  if (command === "install" && prior?.status === "partial") {
    fail("PARTIAL_UNINSTALL", "上次卸载保留了本地修改，请先处理或使用 uninstall --force")
  }

  const desired = await buildDesiredFiles({
    sourceRoot,
    modelMap: options.modelMap,
    helper: options.helper,
    availableModels: options.availableModels,
    opencodeCommand: options.opencodeCommand ?? "opencode",
    openspecCommand: options.openspecCommand ?? "openspec",
    specMode: options.specMode ?? "auto",
    skipDependencies: Boolean(options.skipDependencies),
  })
  await materializeProfile(installRoot, desired, now)
  return applyInstall({
    installRoot,
    desired: desired.files,
    prior: prior?.status === "installed" ? prior : null,
    force: Boolean(options.force),
    now,
    hostVersion,
    packageVersion: desired.packageVersion,
    warnings: desired.warnings,
    command,
    opencodeCommand: options.opencodeCommand ?? "opencode",
    agentIds: options.platformEnabled === false ? [] : desired.agentIds,
    skipSmoke: options.skipSmoke === undefined ? Boolean(options.skipDependencies) : Boolean(options.skipSmoke),
  })
}

export async function manageOpenCodePlugin(command, options) {
  if (!new Set(["install", "update", "uninstall", "doctor"]).has(command)) fail("INVALID_COMMAND", `未知生命周期命令：${command}`)
  if (command === "install") await mkdir(path.resolve(options.installRoot), { recursive: true })
  let installRoot
  try {
    installRoot = await realpath(options.installRoot)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
    if (command === "uninstall") return { status: "not-installed", retained: [] }
    fail("NOT_INSTALLED", "OpenCode PlatformPlugin 尚未安装，请先执行 install")
  }
  if (command === "doctor") return manageUnlocked(command, { ...options, installRoot })
  return withLifecycleLock(installRoot, Boolean(options.force), () => manageUnlocked(command, { ...options, installRoot }))
}

export { LifecycleError }
