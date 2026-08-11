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
import { fileURLToPath, pathToFileURL } from "node:url"

const execFile = promisify(execFileCallback)
export const MINIMUM_OPENCODE_VERSION = "1.18.0"
const MANIFEST_PATH = ".team-work/platform/opencode/install.json"
const BACKUP_ROOT = ".team-work/platform/opencode/backups"
const PLATFORM_ROOT = ".team-work/platform/opencode"
const LIFECYCLE_LOCK = `${PLATFORM_ROOT}/.lifecycle.lock`
const DEFAULT_SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const MANAGED_AGENT_PATHS = new Set([
  "junior-flash", "junior-luna", "senior-terra", "senior-glm", "senior-qwen", "expert-opus", "expert-k3",
].map((id) => `.opencode/agents/${id}.md`))

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

function targetPath(projectRoot, relativePath) {
  const normalized = normalizeRelative(relativePath)
  const target = path.resolve(projectRoot, normalized)
  if (!target.startsWith(`${projectRoot}${path.sep}`)) fail("UNSAFE_PATH", `安装路径越界：${relativePath}`)
  return target
}

async function exists(target) {
  return access(target).then(() => true, (error) => {
    if (error.code === "ENOENT") return false
    throw error
  })
}

async function assertNoSymlink(projectRoot, relativePath) {
  let cursor = projectRoot
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

async function withLifecycleLock(projectRoot, force, action) {
  const lockPath = targetPath(projectRoot, LIFECYCLE_LOCK)
  const parentCandidates = [".team-work", ".team-work/platform", PLATFORM_ROOT]
  const preexistingParents = new Set()
  for (const relativePath of parentCandidates) {
    if (await exists(targetPath(projectRoot, relativePath))) preexistingParents.add(relativePath)
  }
  await assertNoSymlink(projectRoot, LIFECYCLE_LOCK)
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
        await rmdir(targetPath(projectRoot, relativePath))
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

async function allowedManagedPaths(sourceRoot) {
  const allowed = new Set([
    ".opencode/plugins/team-work.js",
    `${PLATFORM_ROOT}/profile.json`,
    ...MANAGED_AGENT_PATHS,
  ])
  for (const [source, destination] of [
    ["skills/workflow", ".opencode/skills/workflow"],
    ["skills/team-work", ".opencode/skills/team-work"],
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
    if (!relativePath.startsWith(".opencode/team-work/") && !allowedPaths.has(relativePath)) {
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

async function inspectSpecReadiness(projectRoot, openspecCommand = "openspec", { synchronize = false } = {}) {
  const configPath = targetPath(projectRoot, ".team-work/config.yaml")
  const config = await readJson(configPath, "PROJECT_CONFIG_CORRUPT")
  if (!config?.spec) return { spec: { managed: false, status: "unconfigured" }, warnings: [], issues: [] }
  const configured = structuredClone(config.spec)
  if (configured.type !== "openspec" || configured.status === "disabled") {
    return {
      spec: { managed: false, ...configured, ready: configured.status === "ready" },
      warnings: [],
      issues: [],
    }
  }

  let cliVersion = null
  let probeReady = false
  let probeError = null
  try {
    const { stdout, stderr } = await execFile(openspecCommand, ["--version"], { encoding: "utf8", timeout: 10_000 })
    cliVersion = (stdout || stderr).trim() || "available"
  } catch {
    // OpenSpec 是可替换的 SPEC 路由；缺失时只提供可恢复诊断。
  }

  let rootPresent = false
  let configPresent = false
  let rootSafe = true
  try {
    const specRoot = normalizeRelative(configured.root)
    const configMarker = `${specRoot}/config.yaml`
    for (const marker of [specRoot, configMarker]) await assertNoSymlink(projectRoot, marker)
    rootPresent = await stat(targetPath(projectRoot, specRoot)).then((entry) => entry.isDirectory(), () => false)
    configPresent = await stat(targetPath(projectRoot, configMarker)).then((entry) => entry.isFile(), () => false)
  } catch (error) {
    if (error.code !== "UNSAFE_PATH") throw error
    rootSafe = false
  }

  const cliAvailable = Boolean(cliVersion)
  if (cliAvailable && rootSafe) {
    try {
      const { stdout } = await execFile(openspecCommand, ["list", "--json"], {
        cwd: projectRoot,
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
      })
      const probe = JSON.parse(stdout)
      if (!probe || !Array.isArray(probe.changes)) throw new Error("openspec list --json 未返回 { changes: [] }")
      probeReady = true
    } catch (error) {
      probeError = String(error.stderr || error.stdout || error.message || error).trim().slice(0, 1000)
    }
  }
  const initialized = probeReady
  const ready = cliAvailable && initialized && rootSafe
  const synchronizedStatus = ready ? "ready" : "missing"
  if (synchronize && config.spec.status !== synchronizedStatus) {
    config.spec.status = synchronizedStatus
    await atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`)
  }
  const warnings = []
  const issues = []
  if (!rootSafe) issues.push({ code: "OPENSPEC_ROOT_UNSAFE", path: configured.root, message: "OpenSpec 根目录经过符号链接或越出项目边界" })
  if (!cliAvailable) issues.push({ code: "OPENSPEC_CLI_MISSING", message: "未发现 OpenSpec CLI；安装后重新执行 update 或 doctor" })
  if (!rootPresent && !probeReady && rootSafe) issues.push({ code: "OPENSPEC_NOT_INITIALIZED", path: configured.root, message: "执行 openspec init <project> --tools opencode 后重新检查" })
  if (rootPresent && !probeReady && rootSafe && cliAvailable) issues.push({ code: "OPENSPEC_CHECK_FAILED", path: configured.root, message: probeError || "OpenSpec 只读就绪检查失败" })
  if (!cliAvailable) warnings.push("OpenSpec CLI 不可用；SPEC 阶段暂不可进入")
  if (!rootPresent && !probeReady && rootSafe) warnings.push("OpenSpec 项目尚未初始化；按需执行 openspec init <project> --tools opencode")
  if (rootPresent && !probeReady && rootSafe && cliAvailable) warnings.push(`OpenSpec 项目检查失败；SPEC 阶段暂不可进入${probeError ? `：${probeError}` : ""}`)
  if (!rootSafe) warnings.push("OpenSpec 根目录不安全；未读取或修改该目录")
  return {
    spec: {
      managed: true,
      ...configured,
      status: synchronize ? synchronizedStatus : configured.status,
      ready,
      cliAvailable,
      cliVersion,
      rootPresent,
      configPresent,
      probeReady,
      probeError,
      initialized,
      rootSafe,
    },
    warnings,
    issues,
  }
}

async function walkFiles(root, prefix = "") {
  const result = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    const absolutePath = path.join(root, entry.name)
    if (entry.isSymbolicLink()) fail("SOURCE_SYMLINK_UNSUPPORTED", `安装源不得包含符号链接：${absolutePath}`)
    if (entry.isDirectory()) result.push(...await walkFiles(absolutePath, relativePath))
    else if (entry.isFile()) result.push(relativePath)
  }
  return result.sort()
}

async function addTree(files, source, destination) {
  for (const relativePath of await walkFiles(source)) {
    files.set(normalizeRelative(`${destination}/${relativePath}`), await readFile(path.join(source, relativePath)))
  }
}

function agentMarkdown(agent, resolvedModel) {
  const tierName = { junior: "Junior", senior: "Senior", expert: "Expert" }[agent.tier]
  return Buffer.from(`---\ndescription: Team-work ${tierName} 通用成员；成本档位 ${agent.costWeight}，具体分工由团队场景决定。\nmode: subagent\nmodel: ${JSON.stringify(resolvedModel)}\npermission:\n  task: deny\n  team_work_spawn: deny\n  team_work_resume: deny\n  team_work_stop: deny\n---\n\n你是 Team-work 的 ${tierName} 通用成员。只执行派单中明确的范围、完成条件、制品路径和验证要求；事实与证据优先，发现缺口及时报告。不要自行组建下级团队。\n`)
}

async function scanModels(opencodeCommand) {
  try {
    const { stdout } = await execFile(opencodeCommand, ["models"], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })
    return stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[^\s/]+\/.+/.test(line))
  } catch {
    return []
  }
}

function resolveModels(agentConfig, explicitMap, availableModels) {
  const warnings = []
  const resolved = new Map()
  const knownAgents = new Set(agentConfig.agents.map(({ id }) => id))
  const unknownAgents = Object.keys(explicitMap ?? {}).filter((id) => !knownAgents.has(id))
  if (unknownAgents.length) fail("INVALID_MODEL_MAP", `模型映射包含未知 Agent：${unknownAgents.join(", ")}`)
  for (const agent of agentConfig.agents) {
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
      : `${agent.id} 的模型 ${agent.requestedModel} 不可用，未安装对应 Agent`)
  }
  return { resolved, warnings }
}

function platformProfile(agentConfig, resolved, generatedAt) {
  return {
    schemaVersion: "1.0",
    platform: "opencode",
    generatedAt,
    agents: agentConfig.agents.map((agent) => ({
      ...agent,
      resolvedModel: resolved.get(agent.id) ?? null,
      capabilities: resolved.has(agent.id) ? ["general"] : ["unavailable"],
    })),
    dispatch: { managedMode: "background", blockingPolicy: "reject" },
    operations: {
      spawn: { supported: true, tool: "team_work_spawn" },
      assign: { supported: true, tool: "team_work_spawn" },
      resume: { supported: true, tool: "team_work_resume" },
      status: { supported: true, tool: "team_work_status" },
      stop: { supported: true, tool: "team_work_stop" },
      message: { supported: false, tool: null },
    },
    limits: { maxConcurrent: null },
    session: { childSessions: true, resume: true, crossSessionProcessRecovery: false },
    ui: { childNavigation: true, splitView: false },
    degradations: [
      { code: "lead-relay", description: "OpenCode 不提供受管成员间直接消息，本插件采用 Lead 汇总再续派" },
      { code: "process-recovery", description: "跨进程只保证任务、制品和 session 映射恢复，不保证旧 child session 仍可运行" },
    ],
    guides: [
      ".team-work/platform/opencode/guides/team-work.md",
      ".team-work/platform/opencode/guides/recovery.md",
    ],
  }
}

async function buildDesiredFiles({ sourceRoot, modelMap, availableModels, opencodeCommand, skipDependencies }) {
  const files = new Map()
  await addTree(files, path.join(sourceRoot, "runtime"), ".opencode/team-work/runtime")
  await addTree(files, path.join(sourceRoot, "schemas"), ".opencode/team-work/schemas")
  await addTree(files, path.join(sourceRoot, "skills/workflow"), ".opencode/skills/workflow")
  await addTree(files, path.join(sourceRoot, "skills/team-work"), ".opencode/skills/team-work")
  await addTree(files, path.join(sourceRoot, "plugins/opencode/guides"), ".team-work/platform/opencode/guides")
  files.set(".opencode/team-work/opencode-adapter.mjs", await readFile(path.join(sourceRoot, "plugins/opencode/src/opencode-adapter.mjs")))
  files.set(".opencode/plugins/team-work.js", await readFile(path.join(sourceRoot, "plugins/opencode/assets/team-work.js")))

  const packageConfig = JSON.parse(await readFile(path.join(sourceRoot, "package.json"), "utf8"))
  const runtimePackage = {
    name: packageConfig.name,
    version: packageConfig.version,
    private: true,
    type: "module",
    dependencies: packageConfig.dependencies ?? {},
  }
  const packageContent = Buffer.from(`${JSON.stringify(runtimePackage, null, 2)}\n`)
  const packageLockContent = await readFile(path.join(sourceRoot, "package-lock.json"))
  files.set(".opencode/team-work/package.json", packageContent)
  files.set(".opencode/team-work/package-lock.json", packageLockContent)

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
      await addTree(files, path.join(staging, "node_modules"), ".opencode/team-work/node_modules")
    } catch (error) {
      fail("DEPENDENCY_INSTALL_FAILED", "Runtime 依赖安装失败；项目文件尚未修改", { cause: error })
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  const agentConfig = JSON.parse(await readFile(path.join(sourceRoot, "plugins/opencode/config/agents.json"), "utf8"))
  const scanned = availableModels ?? (modelMap ? [] : await scanModels(opencodeCommand))
  const { resolved, warnings } = resolveModels(agentConfig, modelMap, scanned)
  for (const agent of agentConfig.agents) {
    const model = resolved.get(agent.id)
    if (model) files.set(`.opencode/agents/${agent.id}.md`, agentMarkdown(agent, model))
  }
  return { files, warnings, packageVersion: packageConfig.version, agentIds: [...resolved.keys()], profile: platformProfile(agentConfig, resolved, "") }
}

function withoutGeneratedAt(profile) {
  const copy = structuredClone(profile)
  delete copy.generatedAt
  return copy
}

async function materializeProfile(projectRoot, desired, now) {
  const target = targetPath(projectRoot, `${PLATFORM_ROOT}/profile.json`)
  await assertNoSymlink(projectRoot, `${PLATFORM_ROOT}/profile.json`)
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

async function currentDigest(projectRoot, relativePath) {
  const target = targetPath(projectRoot, relativePath)
  return await exists(target) ? hash(await readFile(target)) : null
}

function manifestFiles(files) {
  return [...files.entries()].map(([relativePath, content]) => ({ path: relativePath, sha256: hash(content) })).sort((a, b) => a.path.localeCompare(b.path))
}

async function createBackup(projectRoot, relativePaths, now) {
  const existing = []
  for (const relativePath of [...new Set(relativePaths)].sort()) {
    await assertNoSymlink(projectRoot, relativePath)
    const source = targetPath(projectRoot, relativePath)
    if (await exists(source)) existing.push(relativePath)
  }
  if (!existing.length) return null
  const stamp = now().toISOString().replace(/[:.]/g, "-")
  const relativeBackup = `${BACKUP_ROOT}/${stamp}-${randomUUID().slice(0, 8)}`
  await assertNoSymlink(projectRoot, relativeBackup)
  const backupPath = targetPath(projectRoot, relativeBackup)
  for (const relativePath of existing) {
    const content = await readFile(targetPath(projectRoot, relativePath))
    await atomicWrite(path.join(backupPath, relativePath), content)
  }
  await atomicWrite(path.join(backupPath, "backup.json"), `${JSON.stringify({ schemaVersion: "1.0", createdAt: now().toISOString(), files: existing }, null, 2)}\n`)
  return backupPath
}

async function restoreBackup(projectRoot, backupPath, pathsToRemove) {
  for (const relativePath of pathsToRemove) await rm(targetPath(projectRoot, relativePath), { force: true })
  if (!backupPath) return
  const relativeBackup = normalizeRelative(path.relative(projectRoot, backupPath).split(path.sep).join("/"))
  if (!relativeBackup.startsWith(`${BACKUP_ROOT}/`)) fail("UNSAFE_PATH", "备份路径不属于 OpenCode PlatformPlugin")
  await assertNoSymlink(projectRoot, relativeBackup)
  const backup = JSON.parse(await readFile(path.join(backupPath, "backup.json"), "utf8"))
  for (const relativePath of backup.files) {
    await assertNoSymlink(projectRoot, `${relativeBackup}/${relativePath}`)
    await atomicWrite(targetPath(projectRoot, relativePath), await readFile(path.join(backupPath, relativePath)))
  }
}

const RUNTIME_INIT_PATHS = [
  ".team-work/config.yaml",
  ".team-work/workflows/engineering.json",
  ".team-work/tasks",
  ".team-work/bindings",
  ".team-work/archive",
  ".team-work/workflows",
]

async function captureRuntimeBaseline(projectRoot) {
  const baseline = new Map()
  for (const relativePath of RUNTIME_INIT_PATHS) {
    const target = targetPath(projectRoot, relativePath)
    if (await exists(target)) baseline.set(relativePath, (await stat(target)).isFile() ? await readFile(target) : null)
  }
  return baseline
}

async function rollbackRuntimeInitialization(projectRoot, baseline) {
  for (const relativePath of RUNTIME_INIT_PATHS.slice(0, 2)) {
    if (!baseline.has(relativePath)) await rm(targetPath(projectRoot, relativePath), { force: true })
    else if (baseline.get(relativePath)) await atomicWrite(targetPath(projectRoot, relativePath), baseline.get(relativePath))
  }
  for (const relativePath of RUNTIME_INIT_PATHS.slice(2).sort((left, right) => right.split("/").length - left.split("/").length)) {
    if (baseline.has(relativePath)) continue
    try {
      await rmdir(targetPath(projectRoot, relativePath))
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error
    }
  }
}

async function initializeRuntime(sourceRoot, projectRoot, now) {
  if (await exists(path.join(projectRoot, ".team-work/config.yaml"))) return
  const { executeRuntime } = await import(pathToFileURL(path.join(sourceRoot, "runtime/core.mjs")).href)
  const result = await executeRuntime({ command: "init", projectRoot, input: {} }, { clock: now })
  if (result.exitCode !== 0) fail("RUNTIME_INIT_FAILED", result.envelope?.message ?? "CoreRuntime 初始化失败")
}

async function writeManifest(projectRoot, manifest) {
  await atomicWrite(targetPath(projectRoot, MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`)
}

async function smokeCheck(projectRoot, opencodeCommand, expectedAgents) {
  try {
    const { stdout } = await execFile(opencodeCommand, ["agent", "list"], {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
    })
    const missing = expectedAgents.filter((agent) => !stdout.includes(agent))
    if (missing.length) fail("SMOKE_TEST_FAILED", `OpenCode 未发现已安装 Agent：${missing.join(", ")}`)
  } catch (error) {
    if (error instanceof LifecycleError) throw error
    fail("SMOKE_TEST_FAILED", "OpenCode Plugin/Agent smoke test 失败；已开始回滚", { cause: error })
  }
}

async function applyInstall({ projectRoot, sourceRoot, desired, prior, force, now, hostVersion, packageVersion, warnings, command, opencodeCommand, openspecCommand, agentIds, skipSmoke }) {
  const desiredEntries = manifestFiles(desired)
  const desiredByPath = new Map(desiredEntries.map((entry) => [entry.path, entry]))
  const priorFiles = prior?.managedFiles ?? []
  const priorByPath = new Map(priorFiles.map((entry) => [entry.path, entry]))
  const collisions = []
  const modified = []
  const actualDigests = new Map()
  const preexistingDesired = new Set()

  for (const entry of desiredEntries) {
    await assertNoSymlink(projectRoot, entry.path)
    const digest = await currentDigest(projectRoot, entry.path)
    actualDigests.set(entry.path, digest)
    if (digest !== null) preexistingDesired.add(entry.path)
    if ((!prior || !priorByPath.has(entry.path)) && digest !== null) collisions.push(entry.path)
  }
  for (const entry of priorFiles) {
    await assertNoSymlink(projectRoot, entry.path)
    const digest = await currentDigest(projectRoot, entry.path)
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
  if (prior && !changed.length && !missing.length && !obsolete.length) {
    const readiness = await inspectSpecReadiness(projectRoot, openspecCommand, { synchronize: true })
    return { status: "unchanged", manifestId: prior.manifestId, warnings: [...warnings, ...readiness.warnings], spec: readiness.spec }
  }

  const backupCandidates = prior
    ? [...priorFiles.map(({ path: relativePath }) => relativePath), ...collisions]
    : collisions
  const backupPath = await createBackup(projectRoot, backupCandidates, now)
  const createdPaths = desiredEntries
    .filter(({ path: relativePath }) => !priorByPath.has(relativePath) && !preexistingDesired.has(relativePath))
    .map(({ path: relativePath }) => relativePath)
  const runtimeBaseline = await captureRuntimeBaseline(projectRoot)
  try {
    for (const relativePath of obsolete) await rm(targetPath(projectRoot, relativePath), { force: true })
    for (const [relativePath, content] of desired) await atomicWrite(targetPath(projectRoot, relativePath), content)
    await initializeRuntime(sourceRoot, projectRoot, now)
    if (!skipSmoke) await smokeCheck(projectRoot, opencodeCommand, agentIds)
    const readiness = await inspectSpecReadiness(projectRoot, openspecCommand, { synchronize: true })
    const allWarnings = [...warnings, ...readiness.warnings]
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
      managedFiles: desiredEntries,
      warnings: allWarnings,
    }
    await writeManifest(projectRoot, manifest)
    return { status: prior ? "updated" : "installed", manifestId: manifest.manifestId, backupPath, warnings: allWarnings, spec: readiness.spec }
  } catch (error) {
    await restoreBackup(projectRoot, backupPath, [...createdPaths, ...obsolete])
    await rollbackRuntimeInitialization(projectRoot, runtimeBaseline)
    await pruneEmptyManagedDirectories(projectRoot, createdPaths)
    throw error
  }
}

async function uninstall({ projectRoot, prior, force, now }) {
  if (!prior || !["installed", "partial"].includes(prior.status)) return { status: "not-installed", retained: [] }
  const retained = []
  const removable = []
  for (const entry of prior.managedFiles ?? []) {
    await assertNoSymlink(projectRoot, entry.path)
    const digest = await currentDigest(projectRoot, entry.path)
    if (digest === null) continue
    if (digest !== entry.sha256 && !force) retained.push(entry)
    else removable.push(entry.path)
  }
  const backupPath = force ? await createBackup(projectRoot, removable, now) : null
  for (const relativePath of removable) await rm(targetPath(projectRoot, relativePath), { force: true })
  await pruneEmptyManagedDirectories(projectRoot, removable)

  const timestamp = now().toISOString()
  await writeManifest(projectRoot, {
    ...prior,
    status: retained.length ? "partial" : "uninstalled",
    updatedAt: timestamp,
    uninstalledAt: retained.length ? null : timestamp,
    lastOperation: "uninstall",
    managedFiles: retained,
    retained: retained.map(({ path: relativePath }) => relativePath),
  })
  return {
    status: retained.length ? "partial" : "uninstalled",
    retained: retained.map(({ path: relativePath }) => relativePath),
    backupPath,
  }
}

async function pruneEmptyManagedDirectories(projectRoot, removedFiles) {
  const protectedDirectories = new Set([".opencode", ".team-work", PLATFORM_ROOT])
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
      await rmdir(targetPath(projectRoot, relativePath))
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error
    }
  }
}

async function doctor({ projectRoot, prior, hostVersion, openspecCommand }) {
  const issues = []
  if (!prior || !["installed", "partial"].includes(prior.status)) issues.push({ code: "NOT_INSTALLED", message: "OpenCode PlatformPlugin 未安装" })
  for (const entry of prior?.managedFiles ?? []) {
    const digest = await currentDigest(projectRoot, entry.path)
    if (digest === null) issues.push({ code: "MANAGED_FILE_MISSING", path: entry.path })
    else if (digest !== entry.sha256) issues.push({ code: "MANAGED_FILE_MODIFIED", path: entry.path })
  }
  const profile = await readJson(targetPath(projectRoot, `${PLATFORM_ROOT}/profile.json`), "PROFILE_CORRUPT")
  for (const agent of profile?.agents ?? []) {
    if (!agent.resolvedModel) issues.push({ code: "MODEL_UNRESOLVED", agent: agent.id, requestedModel: agent.requestedModel })
  }
  const readiness = await inspectSpecReadiness(projectRoot, openspecCommand)
  issues.push(...readiness.issues)
  return { status: issues.length ? "issues" : "ok", hostVersion, minimumHostVersion: MINIMUM_OPENCODE_VERSION, spec: readiness.spec, issues }
}

async function manageUnlocked(command, options) {
  if (!new Set(["install", "update", "uninstall", "doctor"]).has(command)) fail("INVALID_COMMAND", `未知生命周期命令：${command}`)
  const projectRoot = await realpath(options.projectRoot)
  const sourceRoot = await realpath(options.sourceRoot ?? DEFAULT_SOURCE_ROOT)
  const now = options.now ?? (() => new Date())
  const manifestTarget = targetPath(projectRoot, MANIFEST_PATH)
  await assertNoSymlink(projectRoot, MANIFEST_PATH)
  await assertNoSymlink(projectRoot, ".team-work/config.yaml")
  const prior = await readJson(manifestTarget, "INSTALL_MANIFEST_CORRUPT")
  if (prior) validateManifest(prior, await allowedManagedPaths(sourceRoot))

  if (command === "uninstall") return uninstall({ projectRoot, prior, force: Boolean(options.force), now })

  const hostVersion = options.hostVersion ?? await detectHostVersion(options.opencodeCommand)
  if (compareVersions(hostVersion, MINIMUM_OPENCODE_VERSION) < 0) {
    fail("OPENCODE_VERSION_TOO_OLD", `OpenCode ${hostVersion} 低于最低版本 ${MINIMUM_OPENCODE_VERSION}`)
  }
  if (command === "doctor") return doctor({ projectRoot, prior, hostVersion, openspecCommand: options.openspecCommand ?? "openspec" })
  if (command === "update" && prior?.status !== "installed") {
    fail("NOT_INSTALLED", "尚未安装 OpenCode PlatformPlugin，请先执行 install")
  }
  if (command === "install" && prior?.status === "partial") {
    fail("PARTIAL_UNINSTALL", "上次卸载保留了本地修改，请先处理或使用 uninstall --force")
  }

  const desired = await buildDesiredFiles({
    sourceRoot,
    modelMap: options.modelMap,
    availableModels: options.availableModels,
    opencodeCommand: options.opencodeCommand ?? "opencode",
    skipDependencies: Boolean(options.skipDependencies),
  })
  await materializeProfile(projectRoot, desired, now)
  return applyInstall({
    projectRoot,
    sourceRoot,
    desired: desired.files,
    prior: prior?.status === "installed" ? prior : null,
    force: Boolean(options.force),
    now,
    hostVersion,
    packageVersion: desired.packageVersion,
    warnings: desired.warnings,
    command,
    opencodeCommand: options.opencodeCommand ?? "opencode",
    openspecCommand: options.openspecCommand ?? "openspec",
    agentIds: desired.agentIds,
    skipSmoke: options.skipSmoke === undefined ? Boolean(options.skipDependencies) : Boolean(options.skipSmoke),
  })
}

export async function manageOpenCodePlugin(command, options) {
  if (!new Set(["install", "update", "uninstall", "doctor"]).has(command)) fail("INVALID_COMMAND", `未知生命周期命令：${command}`)
  const projectRoot = await realpath(options.projectRoot)
  if (command === "doctor") return manageUnlocked(command, { ...options, projectRoot })
  return withLifecycleLock(projectRoot, Boolean(options.force), () => manageUnlocked(command, { ...options, projectRoot }))
}

export { LifecycleError }
