import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { pathToFileURL } from "node:url"

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
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`)
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" })
  await rename(temporary, target)
}

async function withLock(target, action) {
  await mkdir(path.dirname(target), { recursive: true })
  let handle
  for (let attempt = 0; attempt < 2; attempt += 1) {
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
      if (owner && processIsAlive(owner.pid)) throw failure("SESSION_MAPPING_LOCKED", "该 work item 正在派发，请稍后查询状态", { retryable: true })
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

export function createOpenCodeAdapter({ client, projectRoot, now = () => new Date(), runtimeExecutor, assignmentValidator }) {
  if (!client?.session) throw failure("INVALID_CLIENT", "OpenCode client.session 不可用")
  const root = path.resolve(projectRoot)

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
    const runtime = await import(pathToFileURL(path.join(root, ".opencode/team-work/runtime/core.mjs")).href)
    return runtime.executeRuntime({ ...request, projectRoot: root })
  }

  function runtimeData(result, operation) {
    if (result?.exitCode === 0) return result.envelope.data
    throw failure(result?.envelope?.code ?? "RUNTIME_VALIDATION_FAILED", `${operation} 失败：${result?.envelope?.message ?? "Runtime 拒绝操作"}`, {
      retryable: Boolean(result?.envelope?.retryable),
      blockers: result?.envelope?.blockers ?? [],
      remediation: result?.envelope?.remediation ?? [],
    })
  }

  async function validateAssignment(input) {
    if (assignmentValidator) return assignmentValidator(input)
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
      return withLock(`${target}.lock`, async () => {
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
        await atomicJson(target, mapping)
        try {
          await dispatch(created.id, agent, prompt)
        } catch (error) {
          await atomicJson(target, { ...mapping, dispatchError: String(error?.message ?? error), updatedAt: now().toISOString() })
          throw error
        }
        return { mode: "background", sessionId: created.id, taskId, workItemId, agent }
      })
    },

    async resume({ taskId, workItemId, prompt }) {
      const mapping = await readMapping(taskId, workItemId)
      await dispatch(mapping.sessionId, mapping.agent, prompt)
      await atomicJson(mappingPath(taskId, workItemId), { ...mapping, updatedAt: now().toISOString() })
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
          return { ...mapping, status: { type: "lost", retryable: false, remediation: "创建新的 work item attempt 并重派" } }
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
      const mapping = await readMapping(taskId, workItemId)
      const stopped = await callSdk("OpenCode session.abort", () => client.session.abort({ path: { id: mapping.sessionId }, query: { directory: root } }))
      await atomicJson(mappingPath(taskId, workItemId), { ...mapping, stoppedAt: now().toISOString(), updatedAt: now().toISOString() })
      return { ...mapping, stopped: Boolean(stopped) }
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
      return executeRuntime(request)
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
