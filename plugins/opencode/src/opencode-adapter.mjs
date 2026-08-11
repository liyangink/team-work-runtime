import { access, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { execFile as execFileCallback } from "node:child_process"
import { promisify } from "node:util"
import { pathToFileURL } from "node:url"

const execFile = promisify(execFileCallback)

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MANAGED_AGENT = /^(?:junior-(?:flash|luna)|senior-(?:terra|glm|qwen)|expert-(?:opus|k3))$/

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
      remediation: ["查询 child session 状态", "网关恢复后使用 team_work_resume 重试", "持续失败时记录基础设施 blocker"],
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

export function createOpenCodeAdapter({ client, projectRoot, platformRoot, platformProfile, platformSettings, now = () => new Date(), runtimeExecutor, assignmentValidator }) {
  if (!client?.session) throw failure("INVALID_CLIENT", "OpenCode client.session 不可用")
  const root = path.resolve(projectRoot)
  const installedPlatformRoot = path.resolve(platformRoot ?? path.join(root, ".opencode/team-work"))
  const inFlightPlatformAudits = new Map()
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

  async function readMapping(taskId, workItemId) {
    const target = mappingPath(taskId, workItemId)
    try {
      return JSON.parse(await readFile(target, "utf8"))
    } catch (error) {
      if (error.code === "ENOENT") throw failure("SESSION_MAPPING_NOT_FOUND", `未找到 ${taskId}/${workItemId} 的 OpenCode child session`)
      if (error instanceof SyntaxError) throw failure("SESSION_MAPPING_CORRUPT", `OpenCode session 映射损坏：${target}`)
      throw error
    }
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

  async function hasRuntimeBinding(sessionId) {
    requireIdentifier(sessionId, "sessionId")
    const target = path.join(root, ".team-work/bindings/opencode", `${sessionId}.json`)
    return readFile(target).then(() => true, (error) => {
      if (error.code === "ENOENT") return false
      throw error
    })
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
      const spec = { ...config.spec, mode, status: "disabled" }
      if (JSON.stringify(config.spec) !== JSON.stringify(spec)) await atomicJson(configPath, { ...config, spec })
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
    const spec = { ...config.spec, mode, status }
    if (JSON.stringify(config.spec) !== JSON.stringify(spec)) await atomicJson(configPath, { ...config, spec })
  }

  async function ensureProjectReady() {
    if (!projectReady) {
      projectReady = (async () => {
        if (!await pathExists(path.join(root, ".team-work/config.yaml"))) {
          const initialized = await executeRuntime({ command: "init", input: {} })
          runtimeData(initialized, "init")
        }
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
    throw failure(result?.envelope?.code ?? "RUNTIME_VALIDATION_FAILED", `${operation} 失败：${result?.envelope?.message ?? "Runtime 拒绝操作"}`, {
      retryable: Boolean(result?.envelope?.retryable),
      blockers: result?.envelope?.blockers ?? [],
      remediation: result?.envelope?.remediation ?? [],
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
        ...(ownsClaim ? { lostAuditClaimedAt: timestamp } : {}),
        updatedAt: timestamp,
      }
    })
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
    if (task.status !== "active" || task.teamDecision?.mode !== "team") {
      throw failure("TEAM_TASK_REQUIRED", `task ${input.taskId} 不是活动 team 任务`)
    }
    const workItem = runtimeData(await executeRuntime({ command: "work.show", input: { taskId: input.taskId, workItemId: input.workItemId } }), "work.show").workItem
    if (workItem.owner !== input.agent) throw failure("WORK_OWNER_MISMATCH", `work item Owner ${workItem.owner} 与 Agent ${input.agent} 不一致`)
    if (!new Set(["queued", "running"]).has(workItem.status)) {
      throw failure("WORK_ITEM_NOT_DISPATCHABLE", `work item ${input.workItemId} 当前状态 ${workItem.status} 不可首次派发`)
    }
  }

  return {
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
        if (await readFile(target).then(() => true, (error) => error.code === "ENOENT" ? false : Promise.reject(error))) {
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
          contextProfile,
          dispatchMode: "background",
          createdAt: timestamp,
          updatedAt: timestamp,
        }
        await withLock(`${target}.lock`, async () => {
          if (await readFile(target).then(() => true, (error) => error.code === "ENOENT" ? false : Promise.reject(error))) {
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
              updatedAt: now().toISOString(),
            }))
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
      const mapping = await updateMapping(taskId, workItemId, (current) => current)
      if (mapping.lostRecordedAt) throw failure("SESSION_LOST", "OpenCode child session 已失联；请创建新的 work item attempt 并重派", { retryable: false })
      try {
        await dispatch(mapping.sessionId, mapping.agent, prompt)
      } catch (error) {
        let failed = mapping
        try {
          failed = await updateMapping(taskId, workItemId, (current) => ({
            ...current,
            resumeError: String(error?.message ?? error),
            updatedAt: now().toISOString(),
          }))
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
      const messages = await callSdk("OpenCode session.messages", () => client.session.messages({
        path: { id: mapping.sessionId },
        query: { directory: root, ...(limit ? { limit } : {}) },
      })) ?? []
      return { ...mapping, messages }
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
        "只按需读取以下路径；摘要不能替代原文：",
      ]
      for (const entry of rendered.envelope.data.entries) {
        lines.push(`- ${entry.mustRead ? "[必读] " : ""}${entry.path} (${entry.kind})${entry.summary ? `：${entry.summary}` : ""}`)
      }
      return lines.join("\n")
    },

    async runtime(request) {
      await ensureProjectReady()
      if (request.command === "doctor") await synchronizeSpecReadiness()
      return executeRuntime(request)
    },

    async handleEvent(event) {
      const properties = event?.properties ?? {}
      const sessionId = properties.sessionID ?? properties.info?.id
      if (typeof sessionId !== "string" || !IDENTIFIER.test(sessionId)) return false
      const mapping = await findMapping(sessionId)
      if (!mapping) return false
      if (event.type === "session.status" && properties.status?.type === "retry") {
        await auditPlatformEventOnce(mapping, "platform.session.retry", properties.status.message ?? `attempt ${properties.status.attempt ?? "unknown"}`, properties.status)
        return true
      }
      if (event.type === "session.error") {
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
      let mapping = null
      let bound = false
      try {
        mapping = await findMapping(sessionId)
        bound = await hasRuntimeBinding(sessionId)
        const task = runtimeData(await executeRuntime({
          command: "task.show",
          input: mapping ? { taskId: mapping.taskId } : { platform: "opencode", sessionKey: sessionId },
        }), "task.show").task
        return task.status === "active" && task.teamDecision?.mode === "team"
      } catch {
        // 已有 child mapping 或 Runtime binding 就属于受管会话；状态损坏时必须
        // fail-closed，不能因此放行原生阻塞 task。完全无受管证据的会话仍放行。
        return Boolean(mapping || bound)
      }
    },

    readMapping,
    findMapping,
  }
}
