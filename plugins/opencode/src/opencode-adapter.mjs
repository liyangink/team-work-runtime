import { access, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { execFile as execFileCallback } from "node:child_process"
import { promisify } from "node:util"
import { pathToFileURL } from "node:url"

const execFile = promisify(execFileCallback)

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MANAGED_AGENT = /^(?:junior-(?:flash|luna)|senior-(?:terra|glm|qwen)|expert-(?:opus|k3))$/
const HELPER_AGENT = {
  explore: "team-work-explore",
  librarian: "team-work-librarian",
}

function failure(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

function requireIdentifier(value, name) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw failure("INVALID_IDENTIFIER", `${name} 必须是安全的稳定标识符`)
  }
  return value
}

function unwrap(response) {
  if (response?.error) {
    const message = response.error?.data?.message ?? response.error?.message ?? "OpenCode SDK request failed"
    throw failure("OPENCODE_API_ERROR", message, {
      retryable: true,
      statusCode: response.error?.status ?? response.response?.status,
      remediation: ["使用 team_work_sync 查询 child session 状态", "网关恢复后使用 team_work_dispatch 续派", "持续失败时记录基础设施 blocker"],
    })
  }
  return response && Object.hasOwn(response, "data") ? response.data : response
}

async function callSdk(label, operation) {
  try {
    return unwrap(await operation())
  } catch (error) {
    if (error?.code === "OPENCODE_API_ERROR") throw error
    throw failure("OPENCODE_API_ERROR", `${label} 失败：${error?.message ?? error}`, {
      retryable: true,
      cause: error,
      statusCode: error?.statusCode ?? error?.status ?? error?.response?.status,
      remediation: ["查询 child session 状态", "检查网关限流与容量", "稍后重试；不要把平台错误当作验收失败"],
    })
  }
}

async function atomicJson(target, value) {
  await atomicFile(target, `${JSON.stringify(value, null, 2)}\n`)
}

async function atomicFile(target, content) {
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`)
  await writeFile(temporary, content, { flag: "wx" })
  await rename(temporary, target)
}

async function withLock(target, action) {
  await mkdir(path.dirname(target), { recursive: true })
  let handle
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      handle = await open(target, "wx", 0o600)
      break
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      let owner = null
      try {
        owner = JSON.parse(await readFile(target, "utf8"))
      } catch {
        const age = Date.now() - (await stat(target)).mtimeMs
        if (age < 5 * 60_000) throw failure("SESSION_MAPPING_LOCK_CORRUPT", "派发锁损坏且仍较新；请确认没有并发派发后再恢复")
      }
      if (owner && processIsAlive(owner.pid)) {
        if (attempt < 24) {
          await new Promise((resolve) => setTimeout(resolve, 20))
          continue
        }
        throw failure("SESSION_MAPPING_LOCKED", "该 work item 正在更新，请稍后查询状态", { retryable: true })
      }
      await rm(target, { force: true })
    }
  }
  if (!handle) throw failure("SESSION_MAPPING_LOCKED", "无法获取 work item 派发锁", { retryable: true })
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`)
    return await action()
  } finally {
    await handle.close()
    await rm(target, { force: true })
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

function errorSummary(value) {
  if (typeof value === "string") return value.slice(0, 1000)
  if (value?.message) return String(value.message).slice(0, 1000)
  try {
    return JSON.stringify(value).slice(0, 1000)
  } catch {
    return String(value).slice(0, 1000)
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function eventFingerprint(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex")
}

function uniqueRemediation(existing, additions) {
  return [...new Set([...(existing ?? []), ...additions].filter(Boolean))]
}

export function withRuntimeRemediation(result, request = {}) {
  const error = result?.envelope?.error
  if (!error) return result
  const command = request.command ?? ""
  const additions = []

  if (error.retryable === false) additions.push("该错误不可重试；不要重复同一个工具调用")
  if (error.code === "TASK_NOT_FOUND" && command === "work.start") {
    additions.push("调用 team_work_dispatch；它会自动判断应创建、启动、首次派发还是续派")
  }
  if (error.code === "ILLEGAL_TRANSITION" && command.startsWith("work.")) {
    additions.push("先调用 team_work_overview，再按业务意图使用 team_work_dispatch 或 team_work_assess；不要手工驱动 work 状态")
  }
  if (error.code === "INVALID_ARGUMENT") {
    const typed = {
      "work.submit": "team_work_assess",
      "work.accept": "team_work_assess",
      "work.rework": "team_work_assess",
      "flow.decide": "team_work_review_gate；人工审核使用 team_work_continue",
    }[command]
    if (typed) additions.push(`改用强类型 ${typed}，不要读取 Runtime 源码猜测 JSON 字段`)
  }
  if (error.code === "REVISION_CONFLICT") {
    additions.push("先调用 task.show 或 work.show 读取最新 revision，重新判断后只重放一次写操作")
  }
  if (!additions.length) return result
  return {
    ...result,
    envelope: {
      ...result.envelope,
      error: {
        ...error,
        remediation: uniqueRemediation(error.remediation, additions),
      },
    },
  }
}

export function resolveOpenCodeProjectRoot({ directory, worktree }) {
  const current = path.resolve(directory)
  if (typeof worktree !== "string" || !worktree) return current
  const candidate = path.resolve(worktree)
  return candidate === path.parse(candidate).root ? current : candidate
}

export function createOpenCodeAdapter({ client, projectRoot, platformRoot, platformProfile, platformSettings, now = () => new Date(), runtimeExecutor, assignmentValidator, waitPollMs = 1_000, waitIdleGraceMs = 1_500 }) {
  if (!client?.session) throw failure("INVALID_CLIENT", "OpenCode client.session 不可用")
  const root = path.resolve(projectRoot)
  const installedPlatformRoot = path.resolve(platformRoot ?? path.join(root, ".opencode/team-work"))
  const inFlightPlatformAudits = new Map()
  const waitSignals = new Set()
  let projectReady

  function mappingPath(taskId, workItemId) {
    return path.join(
      root,
      ".team-work",
      "platform",
      "opencode",
      "sessions",
      requireIdentifier(taskId, "taskId"),
      `${requireIdentifier(workItemId, "workItemId")}.json`,
    )
  }

  async function readOptionalMapping(target) {
    try {
      return JSON.parse(await readFile(target, "utf8"))
    } catch (error) {
      if (error.code === "ENOENT") return null
      if (error instanceof SyntaxError) throw failure("SESSION_MAPPING_CORRUPT", `OpenCode session 映射损坏：${target}`)
      throw error
    }
  }

  async function readMapping(taskId, workItemId) {
    const mapping = await readOptionalMapping(mappingPath(taskId, workItemId))
    if (!mapping) throw failure("SESSION_MAPPING_NOT_FOUND", `未找到 ${taskId}/${workItemId} 的 OpenCode child session`)
    return mapping
  }

  async function listTaskMappings(taskId, workItemIds) {
    requireIdentifier(taskId, "taskId")
    if (workItemIds !== undefined) {
      if (!Array.isArray(workItemIds) || workItemIds.length === 0) {
        throw failure("INVALID_WAIT_TARGET", "workItemIds 必须是非空稳定标识符数组")
      }
      return Promise.all([...new Set(workItemIds)].map((workItemId) => readMapping(taskId, requireIdentifier(workItemId, "workItemId"))))
    }
    const taskRoot = path.dirname(mappingPath(taskId, "placeholder"))
    let entries
    try {
      entries = await readdir(taskRoot, { withFileTypes: true })
    } catch (error) {
      if (error.code === "ENOENT") throw failure("SESSION_MAPPING_NOT_FOUND", `task ${taskId} 没有受管 child session`)
      throw error
    }
    const mappings = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue
      const workItemId = entry.name.slice(0, -5)
      if (!IDENTIFIER.test(workItemId)) continue
      mappings.push(await readMapping(taskId, workItemId))
    }
    if (!mappings.length) throw failure("SESSION_MAPPING_NOT_FOUND", `task ${taskId} 没有受管 child session`)
    return mappings
  }

  function wakeWaiters() {
    for (const resolve of waitSignals) resolve()
    waitSignals.clear()
  }

  function waitForSignal(timeoutMs, signal) {
    if (signal?.aborted) return Promise.reject(failure("WAIT_ABORTED", "等待已被取消", { retryable: true }))
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (operation) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        waitSignals.delete(onWake)
        signal?.removeEventListener("abort", onAbort)
        operation()
      }
      const onWake = () => finish(resolve)
      const onAbort = () => finish(() => reject(failure("WAIT_ABORTED", "等待已被取消", { retryable: true })))
      const timer = setTimeout(() => finish(resolve), timeoutMs)
      waitSignals.add(onWake)
      signal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  async function settleWithin(operation, timeoutMs) {
    let timer
    try {
      return await Promise.race([
        operation,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(failure("WAIT_RECONCILE_TIMEOUT", "OpenCode status reconciliation timed out", { retryable: true })), timeoutMs)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  async function liveSessionIsIdle(mapping) {
    try {
      const statuses = await settleWithin(
        callSdk("OpenCode session.status", () => client.session.status({ query: { directory: root } })),
        waitPollMs,
      ) ?? {}
      const status = statuses[mapping.sessionId]
      return !status || status.type === "idle"
    } catch {
      // 不确定时不消费 idle 事件；下一次显式挂起开始时的一次恢复快照可处理遗漏通知。
      return false
    }
  }

  async function recordPendingSync(mapping, kind, { detail, source } = {}) {
    const priority = { idle: 1, error: 2, lost: 3 }
    const next = await updateMapping(mapping.taskId, mapping.workItemId, (current) => {
      const dispatchSeq = current.dispatchSeq ?? 1
      const existing = current.pendingSync
      if (existing?.dispatchSeq === dispatchSeq && (priority[existing.kind] ?? 0) >= (priority[kind] ?? 0)) return current
      return {
        ...current,
        pendingSync: {
          dispatchSeq,
          kind,
          detectedAt: now().toISOString(),
          ...(source ? { source } : {}),
          ...(detail ? { detail: errorSummary(detail) } : {}),
        },
        updatedAt: now().toISOString(),
      }
    })
    wakeWaiters()
    return next
  }

  async function dispatch(sessionId, agent, prompt) {
    if (typeof prompt !== "string" || !prompt.trim()) throw failure("INVALID_PROMPT", "派发内容不能为空")
    await callSdk("OpenCode promptAsync", () => client.session.promptAsync({
      path: { id: sessionId },
      query: { directory: root },
      body: {
        agent,
        parts: [{ type: "text", text: prompt }],
      },
    }))
  }

  async function findMapping(sessionId) {
    requireIdentifier(sessionId, "sessionId")
    const sessionsRoot = path.join(root, ".team-work/platform/opencode/sessions")
    let taskDirectories
    try {
      taskDirectories = await readdir(sessionsRoot, { withFileTypes: true })
    } catch (error) {
      if (error.code === "ENOENT") return null
      throw error
    }
    for (const taskDirectory of taskDirectories) {
      if (!taskDirectory.isDirectory() || !IDENTIFIER.test(taskDirectory.name)) continue
      const taskRoot = path.join(sessionsRoot, taskDirectory.name)
      const entries = await readdir(taskRoot, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue
        try {
          const mapping = JSON.parse(await readFile(path.join(taskRoot, entry.name), "utf8"))
          if (mapping.sessionId === sessionId) return mapping
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error
        }
      }
    }
    return null
  }

  async function findHelperSession(sessionId) {
    requireIdentifier(sessionId, "sessionId")
    const sessionsRoot = path.join(root, ".team-work/platform/opencode/sessions")
    let taskDirectories
    try {
      taskDirectories = await readdir(sessionsRoot, { withFileTypes: true })
    } catch (error) {
      if (error.code === "ENOENT") return null
      throw error
    }
    for (const taskDirectory of taskDirectories) {
      if (!taskDirectory.isDirectory() || !IDENTIFIER.test(taskDirectory.name)) continue
      const taskRoot = path.join(sessionsRoot, taskDirectory.name)
      for (const entry of await readdir(taskRoot, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue
        try {
          const mapping = JSON.parse(await readFile(path.join(taskRoot, entry.name), "utf8"))
          const helper = mapping.helpers?.find((candidate) => candidate.sessionId === sessionId)
          if (helper) return { mapping, helper }
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error
        }
      }
    }
    return null
  }

  async function helperProfile(kind) {
    const agent = HELPER_AGENT[kind]
    if (!agent) throw failure("HELPER_KIND_INVALID", "helper kind 必须是 explore 或 librarian")
    let profile = platformProfile
    if (!profile) {
      await ensureProjectReady()
      profile = JSON.parse(await readFile(path.join(root, ".team-work/platform/opencode/profile.json"), "utf8"))
    }
    const helpers = profile.helpers ?? []
    const ids = helpers.map(({ id }) => id)
    const duplicate = ids.find((id, index) => ids.indexOf(id) !== index)
    const mismatch = helpers.find((candidate) => HELPER_AGENT[candidate.kind] !== candidate.id)
    if (duplicate || mismatch) {
      throw failure("HELPER_PROFILE_INVALID", duplicate
        ? `Platform Profile helper 重复：${duplicate}`
        : `Platform Profile helper id/kind 不匹配：${mismatch.id}/${mismatch.kind}`)
    }
    const helper = helpers.find((candidate) => candidate.id === agent && candidate.kind === kind)
    if (!helper?.resolvedModel) throw failure("HELPER_UNAVAILABLE", `只读助手 ${kind} 未配置独立模型`)
    return helper
  }

  async function ownedHelper(parentSessionId, sessionId) {
    requireIdentifier(parentSessionId, "parentSessionId")
    requireIdentifier(sessionId, "sessionId")
    const mapping = await findMapping(parentSessionId)
    if (!mapping) throw failure("ASSIST_PARENT_REQUIRED", "只允许受管 Team-work 成员调用只读助手")
    const helper = mapping.helpers?.find((candidate) => candidate.sessionId === sessionId)
    if (!helper) throw failure("HELPER_SESSION_NOT_FOUND", `未找到当前成员创建的 helper session ${sessionId}`)
    return { mapping, helper }
  }

  async function hasRuntimeBinding(sessionId) {
    requireIdentifier(sessionId, "sessionId")
    const target = path.join(root, ".team-work/bindings/opencode", `${sessionId}.json`)
    return readFile(target).then(() => true, (error) => {
      if (error.code === "ENOENT") return false
      throw error
    })
  }

  async function managedTaskForSession(sessionId) {
    requireIdentifier(sessionId, "sessionId")
    let mapping = null
    let bound = false
    try {
      mapping = await findMapping(sessionId)
      bound = await hasRuntimeBinding(sessionId)
      const task = runtimeData(await executeRuntime({
        command: "task.show",
        input: mapping ? { taskId: mapping.taskId } : { platform: "opencode", sessionKey: sessionId },
      }), "task.show").task
      return {
        managed: new Set(["active", "awaiting-user"]).has(task.status)
          && new Set(["solo", "team"]).has(task.teamDecision?.mode),
        task,
      }
    } catch {
      // 已有 child mapping 或 Runtime binding 就属于受管会话；状态损坏时必须
      // fail-closed，不能因此放行外部控制队列。完全无受管证据的会话仍放行。
      return { managed: Boolean(mapping || bound), task: null }
    }
  }

  async function executeRuntime(request) {
    if (runtimeExecutor) return runtimeExecutor(request)
    const runtime = await import(pathToFileURL(path.join(installedPlatformRoot, "runtime/core.mjs")).href)
    return runtime.executeRuntime({ ...request, projectRoot: root })
  }

  async function pathExists(target) {
    return access(target).then(() => true, (error) => error.code === "ENOENT" ? false : Promise.reject(error))
  }

  async function assertProjectPathSafe(relativePath) {
    let cursor = root
    for (const segment of relativePath.split("/")) {
      cursor = path.join(cursor, segment)
      try {
        if ((await lstat(cursor)).isSymbolicLink()) throw failure("STATE_CORRUPT", `受管项目路径不得经过符号链接：${relativePath}`)
      } catch (error) {
        if (error.code === "ENOENT") return
        throw error
      }
    }
  }

  async function copyPlatformContext() {
    let profile = platformProfile
    if (!profile) {
      const profileSource = path.join(installedPlatformRoot, "profile.json")
      profile = JSON.parse(await readFile(profileSource, "utf8").catch((error) => {
        throw failure("PLATFORM_PROFILE_UNAVAILABLE", `无法读取 OpenCode Platform Profile：${error.message}`)
      }))
    }
    const destinationRoot = ".team-work/platform/opencode"
    await assertProjectPathSafe(destinationRoot)
    await atomicJson(path.join(root, destinationRoot, "profile.json"), profile)
    const guideSource = path.join(installedPlatformRoot, "guides")
    for (const entry of await readdir(guideSource, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue
      const relativePath = `${destinationRoot}/guides/${entry.name}`
      await assertProjectPathSafe(relativePath)
      await atomicFile(path.join(root, relativePath), await readFile(path.join(guideSource, entry.name)))
    }
  }

  async function persistSpecReadiness(mode, status) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await executeRuntime({ command: "project.spec", input: { mode, status } })
      if (result.exitCode === 0) return result.envelope.data.spec
      if (result.envelope?.error?.code !== "LOCK_UNAVAILABLE" || attempt === 2) return runtimeData(result, "project.spec")
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)))
    }
  }

  async function synchronizeSpecReadiness() {
    let settings = platformSettings
    if (!settings) {
      try {
        settings = JSON.parse(await readFile(path.join(installedPlatformRoot, "settings.json"), "utf8"))
      } catch {
        // 可选 SPEC 设置损坏或缺失不能阻塞 standalone 与非 SPEC 阶段。
        return
      }
    }
    if (settings?.spec?.provider !== "openspec" || typeof settings.spec.command !== "string") return
    const configPath = path.join(root, ".team-work/config.yaml")
    const config = JSON.parse(await readFile(configPath, "utf8"))
    if (config.spec?.type !== "openspec") return
    const mode = ["auto", "required", "disabled"].includes(settings.spec.mode) ? settings.spec.mode : "auto"
    if (mode === "disabled") {
      if (config.spec.mode !== mode || config.spec.status !== "disabled") {
        await persistSpecReadiness(mode, "disabled")
      }
      return
    }
    let ready = false
    try {
      await execFile(settings.spec.command, ["--version"], { cwd: root, encoding: "utf8", timeout: 10_000 })
      const { stdout } = await execFile(settings.spec.command, ["list", "--json"], {
        cwd: root,
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
      })
      ready = Array.isArray(JSON.parse(stdout)?.changes)
    } catch {
      // SPEC 是可选路由；未安装或未初始化只保持 missing，不阻塞其他阶段。
    }
    const status = ready ? "ready" : "missing"
    if (config.spec.mode !== mode || config.spec.status !== status) {
      await persistSpecReadiness(mode, status)
    }
  }

  async function openSpecSettings() {
    let settings = platformSettings
    if (!settings) {
      settings = JSON.parse(await readFile(path.join(installedPlatformRoot, "settings.json"), "utf8").catch((error) => {
        throw failure("SPEC_PROVIDER_UNAVAILABLE", `无法读取 SPEC provider 配置：${error.message}`, { retryable: false })
      }))
    }
    if (settings?.spec?.provider !== "openspec" || typeof settings.spec.command !== "string" || settings.spec.mode === "disabled") {
      throw failure("SPEC_PROVIDER_UNAVAILABLE", "OpenSpec provider 未启用或未配置命令", { retryable: false })
    }
    return settings.spec
  }

  async function runOpenSpec(args, { timeout = 30_000 } = {}) {
    const settings = await openSpecSettings()
    try {
      return await execFile(settings.command, args, {
        cwd: root,
        encoding: "utf8",
        timeout,
        maxBuffer: 8 * 1024 * 1024,
      })
    } catch (error) {
      throw failure("SPEC_PROVIDER_FAILED", `OpenSpec ${args.join(" ")} 失败：${error.stderr?.trim() || error.message}`, {
        retryable: false,
        cause: error,
        remediation: ["修复 OpenSpec 命令或变更内容后重试", "不要降级为直接修改 canonical 或 archive 文档"],
      })
    }
  }

  async function projectSpecConfig() {
    return JSON.parse(await readFile(path.join(root, ".team-work/config.yaml"), "utf8"))
  }

  async function openSpecChange(taskId, { create = false } = {}) {
    requireIdentifier(taskId, "taskId")
    await ensureProjectReady()
    await synchronizeSpecReadiness()
    const config = await projectSpecConfig()
    if (config.spec.type !== "openspec" || config.spec.status !== "ready") {
      throw failure("SPEC_PROVIDER_UNAVAILABLE", "OpenSpec 当前不可用，不能创建或推进 SPEC", { retryable: false })
    }
    const specRoot = `${String(config.spec.root).replace(/^\/+|\/+$/g, "")}/`
    const activeRoot = `${specRoot}changes/${taskId}/`
    if (create && !await pathExists(path.join(root, activeRoot))) {
      await runOpenSpec(["new", "change", taskId, "--schema", "spec-driven"])
    }
    if (!await pathExists(path.join(root, activeRoot))) {
      throw failure("SPEC_CHANGE_NOT_FOUND", `未找到当前任务的活动 OpenSpec change：${taskId}`, {
        retryable: false,
        remediation: [`通过受管 SPEC 流程创建 ${activeRoot}`, "不要复用 archive 或其他任务的 change"],
      })
    }
    const { stdout } = await runOpenSpec(["status", "--change", taskId, "--json"])
    let status
    try {
      status = JSON.parse(stdout)
    } catch {
      throw failure("SPEC_PROVIDER_INVALID_RESPONSE", "OpenSpec status 未返回合法 JSON", { retryable: false })
    }
    const instructions = []
    const ready = []
    for (const artifact of status.artifacts ?? []) {
      if (!["ready", "done"].includes(artifact.status)) continue
      const instruction = await runOpenSpec(["instructions", artifact.id, "--change", taskId, "--json"])
      try {
        const parsed = JSON.parse(instruction.stdout)
        instructions.push(parsed)
        if (artifact.status === "ready") ready.push(parsed)
      } catch {
        throw failure("SPEC_PROVIDER_INVALID_RESPONSE", `OpenSpec instructions ${artifact.id} 未返回合法 JSON`, { retryable: false })
      }
    }
    return { ...status, activeRoot, instructions, ready }
  }

  async function collectFiles(relativeRoot, predicate = () => true) {
    const collected = []
    async function visit(relativeDirectory) {
      const entries = await readdir(path.join(root, relativeDirectory), { withFileTypes: true })
      for (const entry of entries) {
        const relativePath = `${relativeDirectory.replace(/\/$/, "")}/${entry.name}`
        if (entry.isDirectory()) await visit(relativePath)
        else if (entry.isFile() && predicate(relativePath)) collected.push(relativePath)
      }
    }
    await visit(relativeRoot.replace(/\/$/, ""))
    return collected.sort()
  }

  async function writeOpenSpecManifest(taskId, lifecycle, artifactRefs) {
    const manifestPath = `.team-work/tasks/${taskId}/artifacts/openspec-change.md`
    const lines = [
      `# OpenSpec change: ${taskId}`,
      "",
      `生命周期：${lifecycle}`,
      "",
      "以下路径是事实源；本文件只保存稳定索引：",
      "",
      ...artifactRefs.map((entry) => `- \`${entry}\``),
      "",
    ]
    await atomicFile(path.join(root, manifestPath), lines.join("\n"))
    return manifestPath
  }

  async function ensureOpenSpec(taskId) {
    const change = await openSpecChange(taskId, { create: true })
    let task = runtimeData(await executeRuntime({ command: "task.show", input: { taskId } }), "task.show").task
    if (task.stage !== "spec") throw failure("SPEC_STAGE_REQUIRED", `当前阶段 ${task.stage} 不能创建 OpenSpec change`, { retryable: false })
    if (task.spec.status !== "in-progress") {
      task = runtimeData(await executeRuntime({
        command: "task.spec",
        input: { taskId, status: "in-progress", reason: "OpenSpec active change prepared", expectedRevision: task.revision },
      }), "task.spec").task
    }
    return { task, change }
  }

  async function prepareOpenSpecDispatch({ taskId, artifactId, capabilities = [], prompt, allowCompleted = false }) {
    const { change } = await ensureOpenSpec(taskId)
    const activeRoot = change.activeRoot
    if (!["proposal", "design", "specs", "tasks"].includes(artifactId)) {
      throw failure("SPEC_ARTIFACT_REQUIRED", "SPEC 派单必须选择 proposal、design、specs 或 tasks", { retryable: false })
    }
    const state = change.artifacts?.find(({ id }) => id === artifactId)
    const dispatchable = state?.status === "ready" || (allowCompleted && state?.status === "done")
    if (!dispatchable) {
      throw failure("SPEC_ARTIFACT_NOT_READY", `${artifactId} 当前状态 ${state?.status ?? "unknown"}，不可派发`, {
        retryable: false,
        remediation: ["按 provider 返回的 ready artifact 顺序派发", "done artifact 只允许原 work item 的返工或续派"],
      })
    }
    const instruction = change.instructions.find((entry) => entry.artifactId === artifactId)
    if (!instruction) throw failure("SPEC_PROVIDER_INVALID_RESPONSE", `OpenSpec 未返回 ${artifactId} instructions`, { retryable: false })
    let artifactPaths
    if (artifactId === "specs") {
      if (!Array.isArray(capabilities) || capabilities.length === 0) {
        throw failure("SPEC_CAPABILITY_REQUIRED", "specs artifact 必须提供 proposal 中已经确认的 capability 名称", { retryable: false })
      }
      const invalid = capabilities.find((entry) => !/^[a-z0-9][a-z0-9-]{0,127}$/.test(entry))
      if (invalid) throw failure("SPEC_CAPABILITY_INVALID", `capability 必须使用 kebab-case：${invalid}`, { retryable: false })
      artifactPaths = [...new Set(capabilities)].map((entry) => `${activeRoot}specs/${entry}/spec.md`)
    } else {
      if (capabilities.length) throw failure("SPEC_CAPABILITY_INVALID", `${artifactId} 不接受 capability 参数`, { retryable: false })
      artifactPaths = [`${activeRoot}${instruction.outputPath}`]
    }
    const target = artifactId === "specs" ? artifactPaths.join("、") : artifactPaths[0]
    const providerGuide = [
      `[OpenSpec ${instruction.artifactId}]`,
      `目标：${target}`,
      instruction.instruction,
      `模板：\n${instruction.template}`,
    ].join("\n")
    return { prompt: `${prompt}\n\n${providerGuide}`, artifactPaths, change }
  }

  async function completeOpenSpec(taskId) {
    const change = await openSpecChange(taskId)
    if (!change.isComplete) return { complete: false, change }
    const artifactRefs = await collectFiles(change.activeRoot, (entry) => entry.endsWith(".md"))
    if (!artifactRefs.length) throw failure("SPEC_PROVIDER_INVALID_RESPONSE", "OpenSpec 声称完成但没有可登记的 Markdown 制品", { retryable: false })
    let task = runtimeData(await executeRuntime({ command: "task.show", input: { taskId } }), "task.show").task
    if (task.spec.status !== "completed" || JSON.stringify(task.spec.artifactRefs) !== JSON.stringify(artifactRefs)) {
      task = runtimeData(await executeRuntime({
        command: "task.spec",
        input: { taskId, status: "completed", artifactPaths: artifactRefs, reason: "OpenSpec provider reports all required artifacts complete", expectedRevision: task.revision },
      }), "task.spec").task
    }
    const manifestPath = await writeOpenSpecManifest(taskId, "active-complete", artifactRefs)
    const contexts = runtimeData(await executeRuntime({ command: "context.list", input: { taskId } }), "context.list").entries
    if (!contexts.some(({ contextId }) => contextId === "openspec-change")) {
      runtimeData(await executeRuntime({
        command: "context.register",
        input: {
          taskId, contextId: "openspec-change", path: manifestPath, kind: "spec",
          profiles: ["lead", "implement", "check"], priority: 100, mustRead: true,
          summary: `OpenSpec ${taskId} 活动变更制品索引`, expectedRevision: task.revision,
        },
      }), "context.register")
      task = runtimeData(await executeRuntime({ command: "task.show", input: { taskId } }), "task.show").task
    }
    return { complete: true, task, change, artifactRefs, manifestPath }
  }

  async function archivedOpenSpecRoot(taskId) {
    const config = await projectSpecConfig()
    const archiveRoot = `${String(config.spec.root).replace(/^\/+|\/+$/g, "")}/changes/archive`
    let entries
    try {
      entries = await readdir(path.join(root, archiveRoot), { withFileTypes: true })
    } catch (error) {
      if (error.code === "ENOENT") return null
      throw error
    }
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(`-${taskId}`))
      .map((entry) => `${archiveRoot}/${entry.name}`)
      .sort()
      .at(-1) ?? null
  }

  async function archiveOpenSpec(taskId) {
    requireIdentifier(taskId, "taskId")
    await ensureProjectReady()
    const config = await projectSpecConfig()
    const specRoot = `${String(config.spec.root).replace(/^\/+|\/+$/g, "")}/`
    const activeRoot = `${specRoot}changes/${taskId}`
    let archivedRoot = await archivedOpenSpecRoot(taskId)
    const hadActive = await pathExists(path.join(root, activeRoot))
    if (hadActive) {
      const change = await openSpecChange(taskId)
      if (!change.isComplete) throw failure("SPEC_ARCHIVE_BLOCKED", "OpenSpec change 尚未完成，不能归档", { retryable: false })
      await runOpenSpec(["validate", taskId, "--type", "change", "--strict", "--json", "--no-interactive"])
      await runOpenSpec(["archive", taskId, "--yes"], { timeout: 60_000 })
      archivedRoot = await archivedOpenSpecRoot(taskId)
    }
    if (!archivedRoot) throw failure("SPEC_ARCHIVE_NOT_FOUND", "OpenSpec archive 完成后未找到归档目录", { retryable: false })
    const artifactRefs = await collectFiles(archivedRoot, (entry) => entry.endsWith(".md"))
    let task = runtimeData(await executeRuntime({ command: "task.show", input: { taskId } }), "task.show").task
    if (JSON.stringify(task.spec.artifactRefs) !== JSON.stringify(artifactRefs)) {
      task = runtimeData(await executeRuntime({
        command: "task.spec",
        input: { taskId, status: "completed", artifactPaths: artifactRefs, reason: "OpenSpec change archived at workflow finish", expectedRevision: task.revision },
      }), "task.spec").task
    }
    const manifestPath = await writeOpenSpecManifest(taskId, "archived", artifactRefs)
    return { task, archivedRoot, artifactRefs, manifestPath, recovered: !hadActive }
  }

  async function ensureProjectReady() {
    if (!projectReady) {
      projectReady = (async () => {
        if (!await pathExists(path.join(root, ".team-work/config.yaml"))) {
          const initialized = await executeRuntime({ command: "init", input: {} })
          runtimeData(initialized, "init")
        }
        runtimeData(await executeRuntime({ command: "migrate", input: {} }), "migrate")
        await copyPlatformContext()
        await synchronizeSpecReadiness()
      })().catch((error) => {
        projectReady = undefined
        throw error
      })
    }
    await projectReady
  }

  function runtimeData(result, operation) {
    if (result?.exitCode === 0) return result.envelope.data
    const error = result?.envelope?.error ?? result?.envelope ?? {}
    throw failure(error.code ?? "RUNTIME_VALIDATION_FAILED", `${operation} 失败：${error.message ?? "Runtime 拒绝操作"}`, {
      retryable: Boolean(error.retryable),
      blockers: error.blockers ?? [],
      remediation: error.remediation ?? [],
    })
  }

  async function audit(mapping, eventType, reason) {
    const result = await executeRuntime({
      command: "event.record",
      input: {
        taskId: mapping.taskId,
        eventType,
        actor: "platform:opencode",
        ...(reason ? { reason: errorSummary(reason) } : {}),
        refs: [...new Set([mapping.workItemId, mapping.sessionId].filter(Boolean))],
      },
    })
    runtimeData(result, "event.record")
  }

  async function auditSafe(mapping, eventType, reason) {
    try {
      await audit(mapping, eventType, reason)
      return true
    } catch {
      // 审计是派发后的可恢复旁路；失败不得反向改变平台操作结果。
      return false
    }
  }

  async function updateMapping(taskId, workItemId, transform) {
    const target = mappingPath(taskId, workItemId)
    return withLock(`${target}.lock`, async () => {
      const current = await readMapping(taskId, workItemId)
      const next = transform(current)
      if (next !== current) await atomicJson(target, next)
      return next
    })
  }

  async function markLost(mapping, reason) {
    let ownsClaim = false
    const claimed = await updateMapping(mapping.taskId, mapping.workItemId, (current) => {
      const timestamp = now().toISOString()
      const claimIsFresh = current.lostAuditClaimedAt
        && new Date(timestamp).getTime() - new Date(current.lostAuditClaimedAt).getTime() < 60_000
      ownsClaim = !current.lostAuditRecordedAt && !claimIsFresh
      return {
        ...current,
        lostRecordedAt: current.lostRecordedAt ?? timestamp,
        pendingSync: {
          dispatchSeq: current.dispatchSeq ?? 1,
          kind: "lost",
          detectedAt: timestamp,
          detail: errorSummary(reason),
        },
        ...(ownsClaim ? { lostAuditClaimedAt: timestamp } : {}),
        updatedAt: timestamp,
      }
    })
    wakeWaiters()
    if (!ownsClaim) return claimed

    const recorded = await auditSafe(claimed, "platform.session.lost", reason)
    return updateMapping(mapping.taskId, mapping.workItemId, (current) => {
      if (current.lostAuditClaimedAt !== claimed.lostAuditClaimedAt) return current
      const next = { ...current, updatedAt: now().toISOString() }
      delete next.lostAuditClaimedAt
      if (recorded) {
        next.lostAuditRecordedAt = next.updatedAt
        delete next.lostAuditError
      } else {
        next.lostAuditError = "event.record failed; retry on the next lost observation"
      }
      return next
    })
  }

  async function auditPlatformEventOnce(mapping, eventType, reason, identity) {
    const fingerprint = eventFingerprint({ eventType, sessionId: mapping.sessionId, identity })
    if (inFlightPlatformAudits.has(fingerprint)) return inFlightPlatformAudits.get(fingerprint)
    const operation = (async () => {
      let ownsClaim = false
      const claimed = await updateMapping(mapping.taskId, mapping.workItemId, (current) => {
        if (current.platformEventFingerprints?.includes(fingerprint)) return current
        const timestamp = now().toISOString()
        const existingClaim = current.pendingPlatformEvents?.[fingerprint]
        const claimIsFresh = existingClaim
          && new Date(timestamp).getTime() - new Date(existingClaim).getTime() < 60_000
        if (claimIsFresh) return current
        ownsClaim = true
        return {
          ...current,
          pendingPlatformEvents: { ...(current.pendingPlatformEvents ?? {}), [fingerprint]: timestamp },
          updatedAt: timestamp,
        }
      })
      if (!ownsClaim) return false
      const recorded = await auditSafe(claimed, eventType, reason)
      await updateMapping(mapping.taskId, mapping.workItemId, (current) => {
        const pending = { ...(current.pendingPlatformEvents ?? {}) }
        delete pending[fingerprint]
        const next = { ...current, updatedAt: now().toISOString() }
        if (Object.keys(pending).length) next.pendingPlatformEvents = pending
        else delete next.pendingPlatformEvents
        if (recorded) next.platformEventFingerprints = [...(current.platformEventFingerprints ?? []), fingerprint].slice(-128)
        return next
      })
      return recorded
    })()
    inFlightPlatformAudits.set(fingerprint, operation)
    try {
      return await operation
    } finally {
      inFlightPlatformAudits.delete(fingerprint)
    }
  }

  async function validateAssignment(input) {
    if (assignmentValidator) return assignmentValidator(input)
    await ensureProjectReady()
    let profile
    try {
      profile = JSON.parse(await readFile(path.join(root, ".team-work/platform/opencode/profile.json"), "utf8"))
    } catch (error) {
      throw failure("PLATFORM_PROFILE_UNAVAILABLE", `无法读取 OpenCode Platform Profile：${error.message}`)
    }
    const candidate = profile.agents?.find(({ id }) => id === input.agent)
    if (!candidate?.resolvedModel) throw failure("AGENT_UNAVAILABLE", `Agent ${input.agent} 未安装或模型未解析`)

    const task = runtimeData(await executeRuntime({ command: "task.show", input: { taskId: input.taskId } }), "task.show").task
    if (task.status !== "active" || !new Set(["solo", "team"]).has(task.teamDecision?.mode)) {
      throw failure("TEAM_TASK_REQUIRED", `task ${input.taskId} 尚未选择可派发的 solo/team 拓扑`)
    }
    const workItem = runtimeData(await executeRuntime({ command: "work.show", input: { taskId: input.taskId, workItemId: input.workItemId } }), "work.show").workItem
    if (workItem.owner !== input.agent) throw failure("WORK_OWNER_MISMATCH", `work item Owner ${workItem.owner} 与 Agent ${input.agent} 不一致`)
    if (!new Set(["queued", "running"]).has(workItem.status)) {
      throw failure("WORK_ITEM_NOT_DISPATCHABLE", `work item ${input.workItemId} 当前状态 ${workItem.status} 不可首次派发`)
    }
  }

  async function resolveUserDecision({ sessionId, requestedAt }) {
    requireIdentifier(sessionId, "sessionId")
    const messages = await callSdk("OpenCode session.messages", () => client.session.messages({
      path: { id: sessionId },
      query: { directory: root },
    })) ?? []
    const threshold = new Date(requestedAt).getTime()
    const candidate = messages
      .filter(({ info }) => info?.role === "user" && Number(info.time?.created) >= threshold)
      .at(-1)
    const content = candidate?.parts?.filter(({ type, ignored }) => type === "text" && !ignored).map(({ text }) => text).join("\n").trim() ?? ""
    const rejected = /(?:拒绝|不同意|不批准|不通过|不要继续|驳回|返工|\breject\b|\bno\b)/i.test(content)
    const approved = !rejected && /(?:批准|同意|确认|通过|可以|继续|\bapprove\b|\baccept\b|\byes\b)/i.test(content)
    if (!candidate || !content || (!approved && !rejected)) {
      throw failure("EXPLICIT_USER_DECISION_REQUIRED", "未找到人工门禁请求之后用户明确的批准或驳回决定", { retryable: false })
    }
    return { action: rejected ? "reject" : "approve", messageId: candidate.info.id, content }
  }

  return {
    resolveUserDecision,
    ensureOpenSpec,
    prepareOpenSpecDispatch,
    completeOpenSpec,
    archiveOpenSpec,

    async assertUserDecision({ sessionId, action, requestedAt }) {
      const decision = await resolveUserDecision({ sessionId, requestedAt })
      if (decision.action !== action) {
        throw failure("EXPLICIT_USER_DECISION_REQUIRED", `未找到人工门禁请求之后用户明确的 ${action} 决定`, { retryable: false })
      }
      return decision
    },

    async assertAgentAvailable(agent) {
      requireIdentifier(agent, "agent")
      await ensureProjectReady()
      const profile = JSON.parse(await readFile(path.join(root, ".team-work/platform/opencode/profile.json"), "utf8"))
      const candidate = profile.agents?.find(({ id }) => id === agent)
      if (!candidate?.resolvedModel) throw failure("AGENT_UNAVAILABLE", `Agent ${agent} 未安装或模型未解析`)
      return candidate
    },

    async spawn({ taskId, workItemId, parentSessionId, agent, contextProfile = "implement", prompt, title }) {
      requireIdentifier(taskId, "taskId")
      requireIdentifier(workItemId, "workItemId")
      requireIdentifier(parentSessionId, "parentSessionId")
      requireIdentifier(agent, "agent")
      if (!MANAGED_AGENT.test(agent)) throw failure("AGENT_UNAVAILABLE", `Agent ${agent} 不属于已安装的 Team-work 候选池`)
      if (!IDENTIFIER.test(contextProfile)) throw failure("INVALID_IDENTIFIER", "contextProfile 无效")
      await validateAssignment({ taskId, workItemId, agent })

      const target = mappingPath(taskId, workItemId)
      return withLock(`${target}.spawn.lock`, async () => {
        const existing = await readOptionalMapping(target)
        const replacementReason = existing?.lostRecordedAt ? "lost" : existing?.stoppedAt ? "stopped" : null
        if (existing && !replacementReason) {
          throw failure("SESSION_MAPPING_EXISTS", `work item ${taskId}/${workItemId} 已有 child session；请使用 resume`)
        }
        const created = await callSdk("OpenCode session.create", () => client.session.create({
          query: { directory: root },
          body: { parentID: parentSessionId, title: title ?? `[team-work] ${taskId}/${workItemId}` },
        }))
        if (!created?.id) throw failure("SESSION_CREATE_FAILED", "OpenCode 未返回 child session id")

        const timestamp = now().toISOString()
        const mapping = {
          schemaVersion: "1.0",
          platform: "opencode",
          taskId,
          workItemId,
          parentSessionId,
          sessionId: created.id,
          agent,
          title: title ?? `${agent} · ${workItemId}`,
          contextProfile,
          dispatchMode: "background",
          dispatchSeq: 1,
          lastDispatchAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp,
          ...(existing ? {
            sessionHistory: [
              ...(existing.sessionHistory ?? []),
              {
                sessionId: existing.sessionId,
                agent: existing.agent,
                contextProfile: existing.contextProfile,
                createdAt: existing.createdAt,
                endedAt: existing.lostRecordedAt ?? existing.stoppedAt ?? timestamp,
                reason: replacementReason,
              },
            ].slice(-32),
          } : {}),
        }
        await withLock(`${target}.lock`, async () => {
          const current = await readOptionalMapping(target)
          if ((!existing && current) || (existing && current?.sessionId !== existing.sessionId)) {
            throw failure("SESSION_MAPPING_EXISTS", `work item ${taskId}/${workItemId} 已有 child session；请使用 resume`)
          }
          await atomicJson(target, mapping)
        })
        try {
          await dispatch(created.id, agent, prompt)
        } catch (error) {
          let failed = mapping
          try {
            failed = await updateMapping(taskId, workItemId, (current) => ({
              ...current,
              dispatchError: String(error?.message ?? error),
              pendingSync: {
                dispatchSeq: current.dispatchSeq ?? 1,
                kind: "error",
                detectedAt: now().toISOString(),
                detail: errorSummary(error),
              },
              updatedAt: now().toISOString(),
            }))
            wakeWaiters()
          } catch (mappingError) {
            try { error.mappingPersistenceError = { code: mappingError.code, message: mappingError.message } } catch {}
          }
          await auditSafe(failed, "platform.dispatch.failed", error)
          throw error
        }
        await auditSafe(await readMapping(taskId, workItemId), "platform.dispatch.accepted")
        return { mode: "background", sessionId: created.id, taskId, workItemId, agent }
      })
    },

    async resume({ taskId, workItemId, prompt }) {
      const mapping = await updateMapping(taskId, workItemId, (current) => {
        if (current.lostRecordedAt) return current
        const next = {
          ...current,
          dispatchSeq: (current.dispatchSeq ?? 1) + 1,
          lastDispatchAt: now().toISOString(),
          updatedAt: now().toISOString(),
        }
        delete next.pendingSync
        delete next.resumeError
        return next
      })
      if (mapping.lostRecordedAt) throw failure("SESSION_LOST", "OpenCode child session 已失联；请创建新的 work item attempt 并重派", { retryable: false })
      try {
        await dispatch(mapping.sessionId, mapping.agent, prompt)
      } catch (error) {
        let failed = mapping
        try {
          failed = await updateMapping(taskId, workItemId, (current) => ({
            ...current,
            resumeError: String(error?.message ?? error),
            pendingSync: {
              dispatchSeq: current.dispatchSeq ?? 1,
              kind: "error",
              detectedAt: now().toISOString(),
              detail: errorSummary(error),
            },
            updatedAt: now().toISOString(),
          }))
          wakeWaiters()
        } catch (mappingError) {
          try { error.mappingPersistenceError = { code: mappingError.code, message: mappingError.message } } catch {}
        }
        await auditSafe(failed, "platform.resume.failed", error)
        throw error
      }
      const next = await updateMapping(taskId, workItemId, (current) => {
        if (current.lostRecordedAt) return current
        const updated = { ...current, lastResumedAt: now().toISOString(), updatedAt: now().toISOString() }
        delete updated.resumeError
        return updated
      })
      if (next.lostRecordedAt) throw failure("SESSION_LOST", "OpenCode child session 在续派期间失联；请创建新的 work item attempt 并重派", { retryable: false })
      await auditSafe(next, "platform.resume.accepted")
      return { mode: "background", sessionId: mapping.sessionId, taskId, workItemId }
    },

    async assist({ parentSessionId, kind, prompt, title }) {
      requireIdentifier(parentSessionId, "parentSessionId")
      if (typeof prompt !== "string" || !prompt.trim()) throw failure("INVALID_PROMPT", "辅助检索内容不能为空")
      const parent = await findMapping(parentSessionId)
      if (!parent) throw failure("ASSIST_PARENT_REQUIRED", "只允许受管 Team-work 成员调用只读助手")
      if (parent.lostRecordedAt || parent.stoppedAt) throw failure("ASSIST_PARENT_INACTIVE", "成员 session 已失联或停止，不能继续派发助手")
      const helper = await helperProfile(kind)
      const agent = helper.id
      const created = await callSdk("OpenCode helper session.create", () => client.session.create({
        query: { directory: root },
        body: { parentID: parentSessionId, title: title ?? `[team-work:${kind}] ${parent.taskId}/${parent.workItemId}` },
      }))
      if (!created?.id) throw failure("SESSION_CREATE_FAILED", "OpenCode 未返回 helper child session id")
      requireIdentifier(created.id, "helperSessionId")

      const timestamp = now().toISOString()
      const record = {
        sessionId: created.id,
        parentSessionId,
        kind,
        agent,
        dispatchMode: "background",
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      try {
        await updateMapping(parent.taskId, parent.workItemId, (current) => {
          if (current.sessionId !== parentSessionId || current.lostRecordedAt || current.stoppedAt) {
            throw failure("ASSIST_PARENT_INACTIVE", "成员 session 已变化、失联或停止，不能继续派发助手")
          }
          return { ...current, helpers: [...(current.helpers ?? []), record], updatedAt: timestamp }
        })
      } catch (error) {
        try {
          await callSdk("OpenCode orphan helper session.abort", () => client.session.abort({
            path: { id: created.id },
            query: { directory: root },
          }))
        } catch (cleanupError) {
          try { error.cleanupError = { code: cleanupError.code, message: cleanupError.message, sessionId: created.id } } catch {}
        }
        throw error
      }

      const scopedPrompt = [
        "[Team-work 只读辅助任务]",
        `父任务：${parent.taskId}/${parent.workItemId}`,
        `类型：${kind}`,
        "只处理以下窄范围问题；禁止修改文件、执行命令、继续委托或作最终裁决。",
        prompt,
      ].join("\n")
      try {
        await dispatch(created.id, agent, scopedPrompt)
      } catch (error) {
        try {
          await updateMapping(parent.taskId, parent.workItemId, (current) => ({
            ...current,
            helpers: (current.helpers ?? []).map((candidate) => candidate.sessionId === created.id
              ? { ...candidate, dispatchError: errorSummary(error), updatedAt: now().toISOString() }
              : candidate),
            updatedAt: now().toISOString(),
          }))
        } catch (mappingError) {
          try { error.mappingPersistenceError = { code: mappingError.code, message: mappingError.message } } catch {}
        }
        throw error
      }
      return {
        mode: "background",
        sessionId: created.id,
        parentSessionId,
        taskId: parent.taskId,
        workItemId: parent.workItemId,
        kind,
        agent,
      }
    },

    async assistStatus({ parentSessionId, sessionId }) {
      const { mapping, helper } = await ownedHelper(parentSessionId, sessionId)
      const statuses = await callSdk("OpenCode helper session.status", () => client.session.status({ query: { directory: root } })) ?? {}
      if (statuses[sessionId]) return { ...helper, taskId: mapping.taskId, workItemId: mapping.workItemId, status: statuses[sessionId] }
      try {
        await callSdk("OpenCode helper session.get", () => client.session.get({ path: { id: sessionId }, query: { directory: root } }))
        return { ...helper, taskId: mapping.taskId, workItemId: mapping.workItemId, status: { type: "idle" } }
      } catch (error) {
        if (error.statusCode === 404) return { ...helper, taskId: mapping.taskId, workItemId: mapping.workItemId, status: { type: "lost" } }
        throw error
      }
    },

    async assistMessages({ parentSessionId, sessionId, limit }) {
      const { mapping, helper } = await ownedHelper(parentSessionId, sessionId)
      const messages = await callSdk("OpenCode helper session.messages", () => client.session.messages({
        path: { id: sessionId },
        query: { directory: root, ...(limit ? { limit } : {}) },
      })) ?? []
      return { ...helper, taskId: mapping.taskId, workItemId: mapping.workItemId, messages }
    },

    async status({ taskId, workItemId }) {
      const mapping = await readMapping(taskId, workItemId)
      const statuses = await callSdk("OpenCode session.status", () => client.session.status({ query: { directory: root } })) ?? {}
      if (statuses[mapping.sessionId]) return { ...mapping, status: statuses[mapping.sessionId] }
      try {
        await callSdk("OpenCode session.get", () => client.session.get({ path: { id: mapping.sessionId }, query: { directory: root } }))
        return { ...mapping, status: { type: "idle" } }
      } catch (error) {
        if (error.statusCode === 404) {
          const lost = await markLost(mapping, "OpenCode 无法找到 child session")
          return { ...lost, status: { type: "lost", retryable: false, remediation: "创建新的 work item attempt 并重派" } }
        }
        throw error
      }
    },

    async messages({ taskId, workItemId, limit }) {
      const mapping = await readMapping(taskId, workItemId)
      const collectedDispatchSeq = mapping.dispatchSeq ?? 1
      const messages = await callSdk("OpenCode session.messages", () => client.session.messages({
        path: { id: mapping.sessionId },
        query: { directory: root, ...(limit ? { limit } : {}) },
      })) ?? []
      const collected = await updateMapping(taskId, workItemId, (current) => {
        const next = {
          ...current,
          lastCollectedAt: now().toISOString(),
          lastCollectedSeq: Math.max(current.lastCollectedSeq ?? 0, collectedDispatchSeq),
          updatedAt: now().toISOString(),
        }
        if (current.dispatchSeq === collectedDispatchSeq
          && current.pendingSync?.kind === "idle"
          && current.pendingSync.dispatchSeq === collectedDispatchSeq) delete next.pendingSync
        return next
      })
      return { ...collected, messages }
    },

    async wait({ taskId, workItemIds, requesterSessionId, timeoutMs = 300_000, signal }) {
      requireIdentifier(taskId, "taskId")
      if (requesterSessionId) {
        requireIdentifier(requesterSessionId, "requesterSessionId")
        if (await findMapping(requesterSessionId) || await findHelperSession(requesterSessionId)) {
          throw failure("WAIT_LEAD_REQUIRED", "只有 Lead 控制面可以等待团队同步；成员继续执行自己的 work item")
        }
      }
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1_800_000) {
        throw failure("INVALID_WAIT_TIMEOUT", "timeoutMs 必须是 1 到 1800000 的整数")
      }
      const startedAt = Date.now()
      const deadline = startedAt + timeoutMs
      let recoveryError

      const resultFrom = (mappings) => {
        const items = mappings.flatMap((mapping) => {
          const pending = mapping.pendingSync
          if (!pending && !mapping.lostRecordedAt && !mapping.stoppedAt) return []
          const kind = mapping.lostRecordedAt ? "lost" : mapping.stoppedAt ? "error" : pending.kind
          return [{
            workItemId: mapping.workItemId,
            sessionId: mapping.sessionId,
            agent: mapping.agent,
            dispatchSeq: pending?.dispatchSeq ?? mapping.dispatchSeq ?? 1,
            kind,
            ...(pending?.source ? { source: pending.source } : {}),
            ...(pending?.detail ? { detail: pending.detail } : {}),
          }]
        })
        if (!items.length) return null
        const outcome = items.some(({ kind }) => kind === "lost")
          ? "lost"
          : items.some(({ kind }) => kind === "error") ? "error" : "ready"
        return { outcome, taskId, waitedMs: Date.now() - startedAt, items }
      }

      let mappings = await listTaskMappings(taskId, workItemIds)
      const available = resultFrom(mappings)
      if (available) return available

      // 只在挂起开始时读取一次原生状态，用于恢复进程重启或已经遗漏的事件。
      // 此后完全由 OpenCode session 事件唤醒，不再用模型或定时状态轮询推进。
      try {
        const recoveryBudgetMs = Math.max(1, Math.min(waitPollMs, deadline - Date.now()))
        const statuses = await settleWithin(
          callSdk("OpenCode session.status", () => client.session.status({ query: { directory: root } })),
          recoveryBudgetMs,
        ) ?? {}
        for (const mapping of mappings) {
          const dispatchedAt = new Date(mapping.lastDispatchAt ?? mapping.createdAt).getTime()
          if (Date.now() - dispatchedAt < waitIdleGraceMs) continue
          const status = statuses[mapping.sessionId]
          if (status?.type === "idle") await recordPendingSync(mapping, "idle", { source: "recovery" })
          if (status) continue
          try {
            await settleWithin(
              callSdk("OpenCode session.get", () => client.session.get({ path: { id: mapping.sessionId }, query: { directory: root } })),
              Math.max(1, Math.min(waitPollMs, deadline - Date.now())),
            )
            await recordPendingSync(mapping, "idle", { source: "recovery" })
          } catch (error) {
            if (error.statusCode === 404) await markLost(mapping, "OpenCode 无法找到 child session")
            else throw error
          }
        }
      } catch (error) {
        recoveryError = errorSummary(error)
      }

      while (true) {
        mappings = await listTaskMappings(taskId, workItemIds)
        const signaled = resultFrom(mappings)
        if (signaled) return signaled
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0) {
          return {
            outcome: "timeout",
            taskId,
            waitedMs: Date.now() - startedAt,
            items: [],
            ...(recoveryError ? { recoveryError } : {}),
          }
        }
        await waitForSignal(remainingMs, signal)
      }
    },

    async stop({ taskId, workItemId }) {
      const mapping = await updateMapping(taskId, workItemId, (current) => current)
      const stopped = await callSdk("OpenCode session.abort", () => client.session.abort({ path: { id: mapping.sessionId }, query: { directory: root } }))
      const next = await updateMapping(taskId, workItemId, (current) => ({
        ...current,
        stoppedAt: now().toISOString(),
        updatedAt: now().toISOString(),
      }))
      await auditSafe(next, "platform.session.stopped")
      return { ...next, stopped: Boolean(stopped) }
    },

    async contextForSession(sessionId) {
      const assistance = await findHelperSession(sessionId)
      if (assistance) {
        return [
          "[team-work 只读助手上下文]",
          `task: ${assistance.mapping.taskId}`,
          `parent-work-item: ${assistance.mapping.workItemId}`,
          `profile: helper/${assistance.helper.kind}`,
          "只按父成员派发的窄范围问题工作；不读取任务目录索引，不修改文件，不继续委托，不作最终裁决。",
        ].join("\n")
      }
      const mapping = await findMapping(sessionId)
      const shown = await executeRuntime({
        command: "task.show",
        input: mapping
          ? { taskId: mapping.taskId }
          : { platform: "opencode", sessionKey: sessionId },
      })
      if (shown.exitCode !== 0) return null
      const task = shown.envelope.data.task
      const profile = mapping?.contextProfile ?? "lead"
      const rendered = await executeRuntime({ command: "context.render", input: { taskId: task.taskId, profile } })
      if (rendered.exitCode !== 0) return null
      const lines = [
        "[team-work 任务上下文]",
        `task: ${task.taskId}`,
        `stage: ${task.stage}`,
        `profile: ${profile}`,
      ]
      if (mapping) {
        lines.push(`work-item: ${mapping.workItemId}`, `agent: ${mapping.agent}`)
        lines.push("只读取分配范围所需路径；摘要不能替代原文，不要扫描无关任务资产：")
      } else if (task.status === "awaiting-user") {
        lines.push("当前正在等待用户明确决定；提交一次简明请求后停止本轮，不得启动后台任务、定时检查、team_work_sync 或反复 overview 轮询。")
        lines.push("如果外部 TODO 仍有未完成项，只可用 todowrite 将全部标为 completed/cancelled；不要保留‘用户回复后继续’之类 pending 项。")
      } else {
        lines.push("这是 Lead 控制面索引；不要扫描整个任务目录或代替成员处理具体内容：")
        lines.push("创建、启动与后台派发统一使用 team_work_dispatch；同一 work item 会自动续派原会话。")
        lines.push("提交、审查与验收统一使用 team_work_assess；阶段推进、人工审核和批准恢复统一使用 team_work_continue。")
        if (task.stage === "spec") lines.push("OpenSpec 生命周期由 Harness 管理：只派发当前 change 的 ready/返工 artifact，不要直接修改 canonical specs、archive 或历史 change。")
        lines.push("对用户只汇报：完成了什么、当前阶段、关键制品、未决分歧/风险、下一步；不要复述工具名、gate、revision、session 或 Runtime 命令等内部黑话。")
        lines.push("不可重试错误不要重复调用；按 remediation 改动作或参数，不要读取 Runtime 源码猜测接口。")
      }
      for (const entry of rendered.envelope.data.entries) {
        lines.push(`- ${entry.mustRead ? "[必读] " : ""}${entry.path} (${entry.kind})${entry.summary ? `：${entry.summary}` : ""}`)
      }
      if (!mapping && task.status !== "awaiting-user") {
        let mappings = []
        try {
          mappings = await listTaskMappings(task.taskId)
        } catch (error) {
          if (error.code !== "SESSION_MAPPING_NOT_FOUND") throw error
        }
        const pending = mappings.filter((candidate) => candidate.pendingSync)
        if (pending.length) {
          lines.push("", "[待同步成员]")
          for (const candidate of pending) {
            lines.push(`- ${candidate.workItemId} · ${candidate.pendingSync.kind} · dispatch ${candidate.pendingSync.dispatchSeq}；调用 team_work_sync 核对消息和制品后再决定下一步`)
          }
        }
      }
      return lines.join("\n")
    },

    async runtime(request) {
      await ensureProjectReady()
      if (["doctor", "flow.advance", "flow.proceed"].includes(request.command)) await synchronizeSpecReadiness()
      return withRuntimeRemediation(await executeRuntime(request), request)
    },

    async handleEvent(event) {
      const properties = event?.properties ?? {}
      const sessionId = properties.sessionID ?? properties.info?.id
      if (typeof sessionId !== "string" || !IDENTIFIER.test(sessionId)) return false
      const mapping = await findMapping(sessionId)
      if (!mapping) return false
      if (event.type === "session.idle" || (event.type === "session.status" && properties.status?.type === "idle")) {
        if (!await liveSessionIsIdle(mapping)) return true
        await recordPendingSync(mapping, "idle")
        return true
      }
      if (event.type === "session.status" && properties.status?.type === "retry") {
        await auditPlatformEventOnce(mapping, "platform.session.retry", properties.status.message ?? `attempt ${properties.status.attempt ?? "unknown"}`, properties.status)
        return true
      }
      if (event.type === "session.error") {
        await recordPendingSync(mapping, "error", { detail: properties.error })
        await auditPlatformEventOnce(mapping, "platform.session.error", properties.error, properties.error ?? null)
        return true
      }
      if (event.type === "session.deleted") {
        await markLost(mapping, "OpenCode child session 已删除")
        return true
      }
      return false
    },

    async isManagedTeamSession(sessionId) {
      return (await managedTaskForSession(sessionId)).managed
    },

    async assertExternalTodoWriteAllowed(sessionId, todos) {
      const { managed } = await managedTaskForSession(sessionId)
      if (!managed) return { managed: false }
      const cleanupOnly = Array.isArray(todos) && todos.every(({ status }) => new Set(["completed", "cancelled"]).has(status))
      if (!cleanupOnly) {
        throw failure("TEAM_WORK_EXTERNAL_TODO_REJECTED", "受管任务以 Runtime task/work-item 为唯一控制状态；todowrite 只允许清空既有待办，不得新增 pending/in_progress 项", {
          retryable: false,
          remediation: ["如已有外部 TODO，将所有项目标为 completed/cancelled 后重试", "后续工作只登记为 Runtime work item"],
        })
      }
      return { managed: true, cleanupOnly: true }
    },

    async assertNoPendingExternalTodos(sessionId) {
      requireIdentifier(sessionId, "sessionId")
      if (typeof client.session.todo !== "function") {
        throw failure("OPENCODE_CAPABILITY_MISSING", "OpenCode session.todo 不可用，无法安全进入人工等待", { retryable: false })
      }
      const todos = await callSdk("OpenCode session.todo", () => client.session.todo({
        path: { id: sessionId },
        query: { directory: root },
      })) ?? []
      const pending = todos.filter(({ status }) => !new Set(["completed", "cancelled"]).has(status))
      if (pending.length) {
        throw failure("EXTERNAL_TODO_BLOCKS_HUMAN_WAIT", `进入人工等待前必须清理 ${pending.length} 个外部 TODO，避免 continuation 后台轮询`, {
          retryable: false,
          blockers: pending.map(({ content, status }) => ({ code: "EXTERNAL_TODO_PENDING", kind: "platform", path: status, message: content })),
          remediation: ["调用 todowrite 将所有既有项目标为 completed/cancelled", "不要创建‘用户回复后继续’的 pending TODO", "清理后重新调用 team_work_continue"],
        })
      }
      return { pending: 0 }
    },

    async isManagedHelperSession(sessionId) {
      try {
        return await findHelperSession(sessionId)
      } catch (error) {
        if (error.code !== "ENOENT") throw error
      }
      return null
    },

    readMapping,
    findMapping,
  }
}
