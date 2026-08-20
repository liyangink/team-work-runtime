import { lstat, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises"
import path from "node:path"

import { digestValue } from "../../../runtime/domain/digests.mjs"
import { atomicJson, withOwnerLock } from "../../../runtime/persistence/transactions.mjs"
import { assertProjectRuntimeMajor } from "../../../runtime/version.mjs"

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const OPERATION_TITLE = "[team-work-runtime:"
const HELPER_AGENT = { explore: "team-work-explore", librarian: "team-work-librarian" }

function platformError(code, message, retryable) {
  return { code, message: String(message).slice(0, 1000), retryable }
}

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function requireIdentifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw fail("INVALID_IDENTIFIER", `${label} is not a safe identifier`)
  return value
}

function unwrap(response) {
  if (response?.error) {
    const error = fail("OPENCODE_API_ERROR", response.error?.data?.message ?? response.error?.message ?? "OpenCode request failed")
    error.statusCode = response.error?.status ?? response.response?.status
    throw error
  }
  return response && Object.hasOwn(response, "data") ? response.data : response
}

async function callSdk(operation) {
  try {
    return unwrap(await operation())
  } catch (error) {
    if (!error.code) error.code = "OPENCODE_API_ERROR"
    throw error
  }
}

function retryableSdkError(error) {
  const status = Number(error?.statusCode ?? error?.status ?? error?.response?.status)
  return !Number.isFinite(status) || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
}

function observedAt(clock) {
  const value = clock()
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function operationMarker(operationId) {
  return `[team-work-runtime operation:${operationId}]`
}

function operationTitle(operationId, assignmentId) {
  return `${OPERATION_TITLE}${operationId}] ${assignmentId}`
}

function messageText(message) {
  return (message?.parts ?? [])
    .filter(({ type, ignored }) => type === "text" && !ignored)
    .map(({ text }) => text)
    .join("\n")
    .trim()
}

function messageCursor(message) {
  const created = Number(message?.info?.time?.created ?? 0)
  return `${String(created).padStart(16, "0")}:${message?.info?.id ?? "unknown"}`
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function choiceFrom(content, choices) {
  const normalized = content.trim().toLowerCase()
  const direct = normalized.replace(/^\/+/, "").replace(/[.!。！]+$/, "").trim()
  const exact = choices.find((choice) => direct === choice.toLowerCase())
  if (exact) return exact
  if (/(?:不要|不接受|不同意|不批准|不确认|不选择|不通过|不是|拒绝|否决|\bdo\s+not\b|\bdon't\b|\bnot\b|\bno\b|\breject\b|\bdecline\b)/i.test(content)) return null
  const mentioned = choices.filter((choice) => new RegExp(`(^|[^a-z0-9_-])${escapeRegExp(choice.toLowerCase())}(?=$|[^a-z0-9_-])`, "i").test(normalized))
  if (mentioned.length !== 1) return null
  return /(?:选择|选定|确认|同意|批准|通过|决定|\bchoose\b|\bselect\b|\bconfirm\b|\bapprove\b|\bdecision\b)/i.test(content)
    ? mentioned[0]
    : null
}

async function projectRootOf(projectRoot) {
  const root = await realpath(path.resolve(projectRoot))
  const control = path.join(root, ".team-work")
  const metadata = await lstat(control).catch((error) => {
    throw fail("RUNTIME_ROOT_MISSING", `Runtime control root is unavailable: ${error.message}`)
  })
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw fail("PATH_ESCAPE", "Runtime control root must be a real directory")
  await assertProjectRuntimeMajor(root)
  return { root, control }
}

async function ensureDirectoryTree(root, target, label) {
  const relative = path.relative(root, target)
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw fail("PATH_ESCAPE", `${label} escapes its trusted root`)
  }
  let cursor = root
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment)
    let metadata
    try {
      metadata = await lstat(cursor)
    } catch (error) {
      if (error.code !== "ENOENT") throw error
      await mkdir(cursor).catch((mkdirError) => { if (mkdirError.code !== "EEXIST") throw mkdirError })
      metadata = await lstat(cursor)
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw fail("PATH_ESCAPE", `${label} crosses a non-directory or symbolic link`)
  }
}

async function readProjectFile(root, relativePath, label) {
  if (typeof relativePath !== "string" || relativePath === "" || path.isAbsolute(relativePath)) {
    throw fail("PROJECT_PATH_INVALID", `${label} must be a project-relative path`)
  }
  const target = path.resolve(root, relativePath)
  const relative = path.relative(root, target)
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw fail("PATH_ESCAPE", `${label} escapes the project root`)
  }
  let cursor = root
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment)
    const metadata = await lstat(cursor).catch((error) => {
      throw fail("PROJECT_FILE_MISSING", `${label} is unavailable: ${error.message}`)
    })
    if (metadata.isSymbolicLink()) throw fail("PATH_ESCAPE", `${label} crosses a symbolic link`)
  }
  if (!(await lstat(target)).isFile()) throw fail("PROJECT_FILE_INVALID", `${label} must be a regular file`)
  return readFile(target, "utf8")
}

function normalizeAgents(profile) {
  const agents = (profile?.agents ?? []).flatMap((agent) => agent.resolvedModel ? [{
    agentId: agent.id,
    role: agent.role ?? agent.tier,
    tier: agent.tier,
    model: agent.resolvedModel,
    ...(agent.effort ? { effort: agent.effort } : {}),
    costWeight: agent.costWeight,
    capabilities: (agent.capabilities ?? ["*"]).includes("general")
      ? ["*"]
      : (agent.capabilities ?? ["*"]).filter((entry) => entry !== "unavailable"),
  }] : [])
  if (agents.length === 0) throw fail("AGENT_CATALOG_EMPTY", "OpenCode has no resolved Team-work agents")
  return agents
}

export function createOpenCodeExecutionAdapter({
  client,
  projectRoot,
  platformProfile,
  hostContinuationController,
  maxParallel = 8,
  clock = () => new Date(),
  faultInjector = {},
} = {}) {
  if (!client?.session) throw new TypeError("OpenCode client.session is required")
  if (!projectRoot) throw new TypeError("projectRoot is required")
  const agents = normalizeAgents(platformProfile)
  let rootsPromise
  let observationSinkFor

  async function roots() {
    if (!rootsPromise) {
      rootsPromise = (async () => {
        const base = await projectRootOf(projectRoot)
        const platform = path.join(base.control, "platform", "opencode", "v2")
        for (const directory of [
          platform,
          path.join(platform, "operations"),
          path.join(platform, "sessions"),
          path.join(platform, "helpers"),
          path.join(platform, "checks"),
          path.join(platform, "bindings", "by-task"),
          path.join(platform, "bindings", "by-ref"),
          path.join(platform, "bindings", "by-session"),
          path.join(platform, "locks"),
        ]) await ensureDirectoryTree(base.control, directory, "OpenCode adapter state")
        return { ...base, platform }
      })().catch((error) => {
        rootsPromise = undefined
        throw error
      })
    }
    return rootsPromise
  }

  // 被动探测（上下文注入、工具前置钩子、事件投影）对整个标记错误族返回 null：
  // standalone 项目与 v1 遗留目录不得阻塞平台 Hook；权威路径（派发、Store）仍严格校验，
  // 并由 Lead 入口把可修复的标记问题转成修复询问。
  const PROBE_TOLERANT_ERROR_CODES = new Set([
    "RUNTIME_ROOT_MISSING",
    "PROJECT_MARKER_MISSING",
    "PATH_ESCAPE",
    "STATE_CORRUPT",
    "RUNTIME_MAJOR_MISMATCH",
  ])

  async function optionalRoots() {
    try {
      return await roots()
    } catch (error) {
      if (PROBE_TOLERANT_ERROR_CODES.has(error.code)) return null
      throw error
    }
  }

  function recordPath(base, kind, id) {
    requireIdentifier(id, kind)
    return path.join(base.platform, kind, `${id}.json`)
  }

  async function readOptional(target) {
    try {
      return JSON.parse(await readFile(target, "utf8"))
    } catch (error) {
      if (error.code === "ENOENT") return null
      if (error instanceof SyntaxError) throw fail("PLATFORM_STATE_CORRUPT", `invalid OpenCode adapter record: ${target}`)
      throw error
    }
  }

  async function withOperationLock(operationId, action) {
    const base = await roots()
    return withOwnerLock(recordPath(base, "locks", operationId).replace(/\.json$/, ".lock"), action)
  }

  async function withLeadBindingLock(action) {
    const base = await roots()
    return withOwnerLock(path.join(base.platform, "locks", "lead-bindings.lock"), () => action(base))
  }

  async function loadOperation(operationId) {
    const base = await roots()
    return readOptional(recordPath(base, "operations", operationId))
  }

  async function saveOperation(record) {
    const base = await roots()
    await atomicJson(recordPath(base, "operations", record.operationId), record)
    if (record.executionRef) {
      const leadBinding = await bindingForTask(record.taskId)
      await atomicJson(recordPath(base, "sessions", record.executionRef), {
        schemaVersion: "2.0",
        platform: "opencode",
        taskId: record.taskId,
        stageRunId: record.stageRunId,
        assignmentId: record.assignmentId,
        attempt: record.attempt,
        agentId: record.agentId,
        executionRef: record.executionRef,
        operationId: record.operationId,
        hostSessionRef: leadBinding.hostSessionRef,
        updatedAt: record.updatedAt,
      })
    }
  }

  function configuredHelper(kind) {
    const agentId = HELPER_AGENT[kind]
    const helper = (platformProfile?.helpers ?? []).find((entry) => entry.kind === kind && entry.id === agentId)
    if (!helper?.resolvedModel) throw fail("HELPER_UNAVAILABLE", `read-only helper ${kind} is not configured`)
    return { ...helper, agentId }
  }

  function checkBindingPath(base, sessionId, toolCallRef) {
    const key = digestValue({ sessionId, toolCallRef }).slice(0, 40)
    return path.join(base.platform, "checks", `${key}.json`)
  }

  function assertOperation(record, intent, kind) {
    if (record.kind !== kind || record.effectDigest !== intent.effectDigest) {
      throw fail("OPERATION_DIGEST_CONFLICT", `operation ${intent.operationId} was reused with different content`)
    }
  }

  async function bindingForTask(taskId) {
    return withLeadBindingLock(async (base) => {
      const binding = await readOptional(path.join(base.platform, "bindings", "by-task", `${requireIdentifier(taskId, "taskId")}.json`))
      if (!binding) throw fail("LEAD_BINDING_MISSING", `task ${taskId} has no OpenCode Lead binding`)
      const session = await readOptional(path.join(base.platform, "bindings", "by-session", `${requireIdentifier(binding.hostSessionRef, "hostSessionRef")}.json`))
      if (!session || session.taskId !== taskId || session.bindingRef !== binding.bindingRef) {
        throw fail("PLATFORM_STATE_CORRUPT", `task ${taskId} has no reciprocal OpenCode Lead session binding`)
      }
      return binding
    })
  }

  async function bindingForRef(bindingRef) {
    return withLeadBindingLock(async (base) => {
      const key = digestValue(bindingRef).slice(0, 32)
      const binding = await readOptional(path.join(base.platform, "bindings", "by-ref", `${key}.json`))
      if (!binding || binding.bindingRef !== bindingRef) throw fail("LEAD_BINDING_MISSING", "OpenCode Lead binding is unavailable")
      const [task, session] = await Promise.all([
        readOptional(path.join(base.platform, "bindings", "by-task", `${requireIdentifier(binding.taskId, "taskId")}.json`)),
        readOptional(path.join(base.platform, "bindings", "by-session", `${requireIdentifier(binding.hostSessionRef, "hostSessionRef")}.json`)),
      ])
      if (task?.bindingRef !== bindingRef || session?.bindingRef !== bindingRef) {
        throw fail("PLATFORM_STATE_CORRUPT", "OpenCode Lead binding indexes are inconsistent")
      }
      return binding
    })
  }

  async function sessionGet(sessionId) {
    return callSdk(async () => client.session.get({ path: { id: sessionId }, query: { directory: (await roots()).root } }))
  }

  async function sessionMessages(sessionId) {
    return callSdk(async () => client.session.messages({ path: { id: sessionId }, query: { directory: (await roots()).root } }))
  }

  async function sessionStatuses() {
    return callSdk(async () => client.session.status({ query: { directory: (await roots()).root } }))
  }

  async function findSessionForOperation(intent) {
    const sessions = await callSdk(async () => client.session.list({ query: { directory: (await roots()).root } })) ?? []
    const title = operationTitle(intent.operationId, intent.assignmentId)
    const matches = sessions.filter((session) => session.title === title)
    if (matches.length > 1) throw fail("OPERATION_AMBIGUOUS", `multiple OpenCode sessions claim operation ${intent.operationId}`)
    return matches[0] ?? null
  }

  async function promptWasAccepted(sessionId, operationId) {
    const marker = operationMarker(operationId)
    const messages = await sessionMessages(sessionId)
    return (messages ?? []).some((message) => messageText(message).includes(marker))
  }

  async function dispatchPrompt(intent, sessionId) {
    const base = await roots()
    const [context, prompt] = await Promise.all([
      readProjectFile(base.root, intent.contextRef, "member context"),
      readProjectFile(base.root, intent.promptRef, "member prompt"),
    ])
    const recovery = intent.recovery
      ? `恢复任务：前一执行会话已失联。以下声明输出均未验证，必须先检查并明确接管、重做或保留依据，不能因文件存在就视为完成：${intent.recovery.unverifiedRefs.join("、") || "（无产品写入）"}`
      : ""
    const text = [operationMarker(intent.operationId), context.trim(), recovery, prompt.trim()].filter(Boolean).join("\n\n")
    await callSdk(() => client.session.promptAsync({
      path: { id: sessionId },
      query: { directory: base.root },
      body: { agent: intent.agentId, parts: [{ type: "text", text }] },
    }))
  }

  async function evaluateQuiesce(intent, { clear = false } = {}) {
    try {
      const binding = await bindingForRef(intent.leadBindingRef)
      if (binding.taskId !== intent.taskId) throw fail("LEAD_BINDING_CONFLICT", "human wait binding targets another task")
      if (typeof client.session.todo !== "function") throw fail("OPENCODE_CAPABILITY_MISSING", "OpenCode session.todo is required to prove a static human wait")
      if (clear && hostContinuationController) {
        if (typeof hostContinuationController.clear !== "function") throw fail("OPENCODE_CAPABILITY_MISSING", "host continuation controller must provide clear()")
        await hostContinuationController.clear({
          taskId: intent.taskId,
          decisionId: intent.decisionId,
          hostSessionRef: binding.hostSessionRef,
        })
      }
      let statuses = await sessionStatuses()
      if (clear) {
        for (const executionRef of intent.executionRefs) {
          const status = statuses?.[executionRef]
          if (status?.type !== "busy" && status?.type !== "retry") continue
          await callSdk(async () => client.session.abort({ path: { id: executionRef }, query: { directory: (await roots()).root } }))
        }
        statuses = await sessionStatuses()
      }
      const executions = []
      for (const executionRef of intent.executionRefs) {
        const status = statuses?.[executionRef]
        if (status?.type === "busy" || status?.type === "retry") {
          return {
            operationId: intent.operationId,
            effectDigest: intent.effectDigest,
            status: "blocked",
            executions,
            hostContinuationsCleared: false,
            observedAt: observedAt(clock),
          }
        }
        try {
          await sessionGet(executionRef)
          executions.push({ executionRef, state: "idle" })
        } catch (error) {
          if (error.statusCode !== 404) throw error
          executions.push({ executionRef, state: "stopped" })
        }
      }
      const todos = unwrap(await client.session.todo({ path: { id: binding.hostSessionRef }, query: { directory: (await roots()).root } })) ?? []
      const pending = todos.filter(({ status }) => !["completed", "cancelled"].includes(status))
      const messages = await sessionMessages(binding.hostSessionRef)
      const cursor = (messages ?? []).filter(({ info }) => info?.role === "user").map(messageCursor).sort().at(-1)
      return {
        operationId: intent.operationId,
        effectDigest: intent.effectDigest,
        status: pending.length ? "blocked" : "confirmed",
        executions,
        hostContinuationsCleared: pending.length === 0,
        ...(cursor ? { hostCursor: cursor } : {}),
        observedAt: observedAt(clock),
      }
    } catch {
      return {
        operationId: intent.operationId,
        effectDigest: intent.effectDigest,
        status: "in-doubt",
        executions: [],
        hostContinuationsCleared: false,
        observedAt: observedAt(clock),
      }
    }
  }

  function executionReceipt(intent, status, executionRef, error) {
    return {
      operationId: intent.operationId,
      effectDigest: intent.effectDigest,
      status,
      ...(executionRef ? { executionRef } : {}),
      agentId: intent.agentId,
      observedAt: observedAt(clock),
      ...(error ? { error } : {}),
    }
  }

  async function recoverExecution(intent, record) {
    let current = record
    try {
      if (!current) {
        const session = intent.resumeExecutionRef
          ? await sessionGet(intent.resumeExecutionRef)
          : await findSessionForOperation(intent)
        if (!session?.id) {
          return executionReceipt(intent, "failed", undefined, platformError("OPERATION_NOT_FOUND", "OpenCode has no execution for this operation", true))
        }
        current = {
          schemaVersion: "2.0",
          kind: "dispatch",
          operationId: intent.operationId,
          effectDigest: intent.effectDigest,
          taskId: intent.taskId,
          stageRunId: intent.stageRunId,
          assignmentId: intent.assignmentId,
          attempt: intent.attempt,
          agentId: intent.agentId,
          executionRef: session.id,
          phase: "created",
          createdAt: observedAt(clock),
          updatedAt: observedAt(clock),
        }
        await saveOperation(current)
      }
      assertOperation(current, intent, "dispatch")
      if (current.phase === "confirmed") return executionReceipt(intent, "confirmed", current.executionRef)
      if (await promptWasAccepted(current.executionRef, intent.operationId)) {
        current = { ...current, phase: "confirmed", updatedAt: observedAt(clock) }
        await saveOperation(current)
        return executionReceipt(intent, "confirmed", current.executionRef)
      }
      return executionReceipt(intent, "failed", current.executionRef, platformError("DISPATCH_NOT_ACCEPTED", "OpenCode session exists but the operation prompt is absent", true))
    } catch (error) {
      if (error.statusCode === 404) {
        return executionReceipt(intent, "failed", current?.executionRef, platformError("SESSION_LOST", "OpenCode child session is missing", false))
      }
      return executionReceipt(intent, "in-doubt", current?.executionRef, platformError(error.code ?? "OPENCODE_API_ERROR", error.message, retryableSdkError(error)))
    }
  }

  const adapter = {
    attachRuntime(bindingsFactory) {
      observationSinkFor = bindingsFactory.observationSinkFor
    },

    async capabilities() {
      const body = {
        agents,
        limits: { maxParallel },
        features: {
          background: true,
          resume: true,
          humanDecisionProof: "verified-event",
          readOnlyHelper: Array.isArray(platformProfile?.helpers) && platformProfile.helpers.some(({ resolvedModel }) => resolvedModel),
          checkReceipts: true,
        },
      }
      const catalog = agents.map((agent) => ({
        agentId: agent.agentId,
        tier: agent.tier,
        modelFamily: agent.model,
        assignmentKinds: agent.capabilities.includes("*") ? ["*"] : [...agent.capabilities],
      }))
      const digest = digestValue(catalog)
      const snapshotId = `opencode-${digestValue(body).slice(0, 24)}`
      return { snapshotId, digest, capturedAt: observedAt(clock), ...body }
    },

    async bindLead(input) {
      requireIdentifier(input.taskId, "taskId")
      requireIdentifier(input.hostSessionRef, "hostSessionRef")
      if (input.platform !== "opencode") throw fail("PLATFORM_MISMATCH", "OpenCode adapter only accepts platform=opencode")
      const bindingRef = `opencode-${digestValue({ taskId: input.taskId, platform: input.platform }).slice(0, 32)}`
      const receipt = { bindingRef, ...input }
      await withLeadBindingLock(async (base) => {
        const taskPath = path.join(base.platform, "bindings", "by-task", `${input.taskId}.json`)
        const sessionPath = path.join(base.platform, "bindings", "by-session", `${input.hostSessionRef}.json`)
        const [existingTask, existingSession] = await Promise.all([readOptional(taskPath), readOptional(sessionPath)])
        if (existingTask?.hostSessionRef && existingTask.hostSessionRef !== input.hostSessionRef) {
          const oldSessionPath = path.join(base.platform, "bindings", "by-session", `${existingTask.hostSessionRef}.json`)
          const oldSession = await readOptional(oldSessionPath)
          if (oldSession?.taskId === input.taskId && oldSession.bindingRef === existingTask.bindingRef) {
            await rm(oldSessionPath, { force: true })
          }
        }
        if (existingSession?.taskId && existingSession.taskId !== input.taskId) {
          const oldTaskPath = path.join(base.platform, "bindings", "by-task", `${existingSession.taskId}.json`)
          const oldTask = await readOptional(oldTaskPath)
          if (oldTask?.hostSessionRef === input.hostSessionRef && oldTask.bindingRef === existingSession.bindingRef) {
            await rm(oldTaskPath, { force: true })
          }
          const oldRefPath = path.join(base.platform, "bindings", "by-ref", `${digestValue(existingSession.bindingRef).slice(0, 32)}.json`)
          const oldRef = await readOptional(oldRefPath)
          if (oldRef?.taskId === existingSession.taskId && oldRef.hostSessionRef === input.hostSessionRef) {
            await rm(oldRefPath, { force: true })
          }
        }
        await atomicJson(taskPath, receipt)
        await atomicJson(path.join(base.platform, "bindings", "by-ref", `${digestValue(bindingRef).slice(0, 32)}.json`), receipt)
        await atomicJson(sessionPath, receipt)
      })
      return receipt
    },

    async resolveLeadBindingForSession(hostSessionRef) {
      requireIdentifier(hostSessionRef, "hostSessionRef")
      const base = await optionalRoots()
      if (!base) return null
      return withOwnerLock(path.join(base.platform, "locks", "lead-bindings.lock"), async () => {
        const binding = await readOptional(path.join(base.platform, "bindings", "by-session", `${hostSessionRef}.json`))
        if (!binding) return null
        if (binding.hostSessionRef !== hostSessionRef || binding.platform !== "opencode") {
          throw fail("PLATFORM_STATE_CORRUPT", `OpenCode lead binding is invalid for session ${hostSessionRef}`)
        }
        const task = await readOptional(path.join(base.platform, "bindings", "by-task", `${requireIdentifier(binding.taskId, "taskId")}.json`))
        if (!task || task.hostSessionRef !== hostSessionRef || task.bindingRef !== binding.bindingRef) {
          throw fail("PLATFORM_STATE_CORRUPT", `OpenCode lead binding is not reciprocal for session ${hostSessionRef}`)
        }
        return binding
      })
    },

    async resolveMemberBinding(sessionId) {
      requireIdentifier(sessionId, "sessionId")
      const base = await optionalRoots()
      if (!base) return null
      const projection = await readOptional(recordPath(base, "sessions", sessionId))
      if (!projection) return null
      if (projection.executionRef !== sessionId || !Number.isInteger(projection.attempt) || projection.attempt < 1) {
        throw fail("PLATFORM_STATE_CORRUPT", `OpenCode member binding is invalid for session ${sessionId}`)
      }
      return {
        taskId: projection.taskId,
        stageRunId: projection.stageRunId,
        assignmentId: projection.assignmentId,
        attemptId: `${projection.assignmentId}-attempt-${projection.attempt}`,
        executionRef: projection.executionRef,
        operationKey: `report:${projection.operationId}`,
        agentId: projection.agentId,
        hostSessionRef: projection.hostSessionRef ?? (await bindingForTask(projection.taskId)).hostSessionRef,
      }
    },

    async resolveHelperBinding(sessionId) {
      requireIdentifier(sessionId, "sessionId")
      const base = await optionalRoots()
      if (!base) return null
      const helper = await readOptional(recordPath(base, "helpers", sessionId))
      if (!helper) return null
      if (helper.sessionId !== sessionId || !HELPER_AGENT[helper.helperKind]) {
        throw fail("PLATFORM_STATE_CORRUPT", `OpenCode helper binding is invalid for session ${sessionId}`)
      }
      return helper
    },

    async assist({ parentSessionId, kind, prompt, title }) {
      requireIdentifier(parentSessionId, "parentSessionId")
      if (typeof prompt !== "string" || prompt.trim() === "") throw fail("HELPER_PROMPT_INVALID", "helper prompt is required")
      const parent = await adapter.resolveMemberBinding(parentSessionId)
      if (!parent) throw fail("MEMBER_BINDING_REQUIRED", "only a managed member can create a helper")
      const helper = configuredHelper(kind)
      const base = await roots()
      const created = await callSdk(() => client.session.create({
        query: { directory: base.root },
        body: { parentID: parentSessionId, title: String(title ?? `Team-work ${kind}`).slice(0, 120) },
      }))
      if (!created?.id) throw fail("SESSION_CREATE_FAILED", "OpenCode did not return a helper session id")
      requireIdentifier(created.id, "helperSessionId")
      const record = {
        schemaVersion: "2.0",
        sessionId: created.id,
        parentSessionRef: parentSessionId,
        helperKind: kind,
        agentId: helper.agentId,
        taskId: parent.taskId,
        assignmentId: parent.assignmentId,
        createdAt: observedAt(clock),
      }
      await atomicJson(recordPath(base, "helpers", created.id), record)
      try {
        await callSdk(() => client.session.promptAsync({
          path: { id: created.id },
          query: { directory: base.root },
          body: {
            agent: helper.agentId,
            parts: [{ type: "text", text: `只读辅助任务：${prompt.trim()}\n\n返回事实、路径/来源和不确定项；禁止修改、命令执行、继续委托或技术裁决。` }],
          },
        }))
      } catch (error) {
        await callSdk(() => client.session.abort({ path: { id: created.id }, query: { directory: base.root } })).catch(() => {})
        throw error
      }
      return record
    },

    async assistStatus({ parentSessionId, sessionId }) {
      const helper = await adapter.resolveHelperBinding(sessionId)
      if (!helper || helper.parentSessionRef !== parentSessionId) throw fail("HELPER_SESSION_NOT_FOUND", "helper does not belong to the current member")
      const statuses = await sessionStatuses()
      return { ...helper, status: statuses?.[sessionId] ?? { type: "idle" } }
    },

    async assistMessages({ parentSessionId, sessionId, limit = 50 }) {
      const helper = await adapter.resolveHelperBinding(sessionId)
      if (!helper || helper.parentSessionRef !== parentSessionId) throw fail("HELPER_SESSION_NOT_FOUND", "helper does not belong to the current member")
      const messages = await sessionMessages(sessionId)
      return { ...helper, messages: (messages ?? []).slice(-Math.max(1, Math.min(Number(limit) || 50, 200))) }
    },

    async ensureExecution(intent) {
      return withOperationLock(intent.operationId, async () => {
        let record = await loadOperation(intent.operationId)
        if (record) {
          assertOperation(record, intent, "dispatch")
          if (record.phase === "confirmed") return executionReceipt(intent, "confirmed", record.executionRef)
          const recovered = await recoverExecution(intent, record)
          if (recovered.status !== "failed" || recovered.error?.retryable !== true) return recovered
          record = await loadOperation(intent.operationId)
        }
        try {
          const capabilities = await adapter.capabilities()
          if (capabilities.digest !== intent.capabilitySnapshotDigest || !agents.some(({ agentId }) => agentId === intent.agentId)) {
            return executionReceipt(intent, "failed", undefined, platformError("CAPABILITY_SNAPSHOT_STALE", "the pinned OpenCode Agent catalog is no longer available", false))
          }
          const binding = await bindingForTask(intent.taskId)
          let session
          if (record?.executionRef) {
            session = await sessionGet(record.executionRef)
          } else if (intent.resumeExecutionRef) {
            session = await sessionGet(intent.resumeExecutionRef)
          } else {
            session = await callSdk(async () => client.session.create({
              query: { directory: (await roots()).root },
              body: { parentID: binding.hostSessionRef, title: operationTitle(intent.operationId, intent.assignmentId) },
            }))
            await faultInjector.afterSessionCreate?.({ intent: structuredClone(intent), session: structuredClone(session) })
          }
          if (!session?.id) return executionReceipt(intent, "failed", undefined, platformError("SESSION_CREATE_FAILED", "OpenCode did not return a child session id", false))
          record = {
            schemaVersion: "2.0",
            kind: "dispatch",
            operationId: intent.operationId,
            effectDigest: intent.effectDigest,
            taskId: intent.taskId,
            stageRunId: intent.stageRunId,
            assignmentId: intent.assignmentId,
            attempt: intent.attempt,
            agentId: intent.agentId,
            executionRef: session.id,
            phase: "created",
            createdAt: record?.createdAt ?? observedAt(clock),
            updatedAt: observedAt(clock),
          }
          await saveOperation(record)
          await dispatchPrompt(intent, session.id)
          await faultInjector.afterPromptAccepted?.({ intent: structuredClone(intent), executionRef: session.id })
          record = { ...record, phase: "confirmed", updatedAt: observedAt(clock) }
          await saveOperation(record)
          return executionReceipt(intent, "confirmed", session.id)
        } catch (error) {
          const retryable = retryableSdkError(error)
          if (record) {
            await saveOperation({ ...record, phase: retryable ? "in-doubt" : "failed", error: platformError(error.code ?? "OPENCODE_API_ERROR", error.message, retryable), updatedAt: observedAt(clock) })
          }
          return executionReceipt(intent, retryable ? "in-doubt" : "failed", record?.executionRef, platformError(error.code ?? "OPENCODE_API_ERROR", error.message, retryable))
        }
      })
    },

    async inspectExecution(intent) {
      return withOperationLock(intent.operationId, async () => recoverExecution(intent, await loadOperation(intent.operationId)))
    },

    async quiesce(intent) {
      return withOperationLock(intent.operationId, async () => {
        const existing = await loadOperation(intent.operationId)
        if (existing) {
          assertOperation(existing, intent, "quiesce")
          return existing.receipt
        }
        const receipt = await evaluateQuiesce(intent, { clear: true })
        await faultInjector.afterQuiesceObserved?.({ intent: structuredClone(intent), receipt: structuredClone(receipt) })
        await saveOperation({
          schemaVersion: "2.0",
          kind: "quiesce",
          operationId: intent.operationId,
          effectDigest: intent.effectDigest,
          receipt,
          createdAt: observedAt(clock),
          updatedAt: observedAt(clock),
        })
        return receipt
      })
    },

    async inspectQuiesce(intent) {
      return withOperationLock(intent.operationId, async () => {
        const existing = await loadOperation(intent.operationId)
        if (existing) {
          assertOperation(existing, intent, "quiesce")
          return existing.receipt
        }
        const receipt = await evaluateQuiesce(intent)
        await saveOperation({
          schemaVersion: "2.0",
          kind: "quiesce",
          operationId: intent.operationId,
          effectDigest: intent.effectDigest,
          receipt,
          createdAt: observedAt(clock),
          updatedAt: observedAt(clock),
        })
        return receipt
      })
    },

    async verifyHumanDecision(intent) {
      const binding = await bindingForRef(intent.leadBindingRef)
      const messages = await sessionMessages(binding.hostSessionRef)
      const issuedAt = Date.parse(intent.issuedAt)
      const candidates = (messages ?? []).filter((message) => (
        message.info?.role === "user"
        && Number(message.info?.time?.created ?? 0) >= issuedAt
        && (!intent.afterHostCursor || messageCursor(message) > intent.afterHostCursor)
      ))
      const matches = candidates.flatMap((message) => {
        const choice = choiceFrom(messageText(message), intent.choices)
        return choice ? [{ message, choice }] : []
      })
      const selected = matches.at(-1)
      if (!selected) throw fail("HUMAN_DECISION_MISSING", "no unambiguous user decision exists after the human gate request")
      return {
        decisionId: intent.decisionId,
        leadBindingRef: intent.leadBindingRef,
        receivedAt: new Date(Number(selected.message.info.time.created)).toISOString(),
        choice: selected.choice,
        note: messageText(selected.message).slice(0, 1000),
        proof: {
          mode: "verified-event",
          messageId: selected.message.info.id,
          messageCursor: messageCursor(selected.message),
        },
      }
    },

    async stopExecution(intent) {
      return withOperationLock(intent.operationId, async () => {
        const existing = await loadOperation(intent.operationId)
        if (existing) {
          assertOperation(existing, intent, "stop")
          return existing.receipt
        }
        let receipt
        try {
          await callSdk(async () => client.session.abort({ path: { id: intent.executionRef }, query: { directory: (await roots()).root } }))
          receipt = { operationId: intent.operationId, effectDigest: intent.effectDigest, status: "confirmed", executionRef: intent.executionRef, observedAt: observedAt(clock) }
        } catch (error) {
          const retryable = retryableSdkError(error)
          receipt = {
            operationId: intent.operationId,
            effectDigest: intent.effectDigest,
            status: retryable ? "in-doubt" : "failed",
            executionRef: intent.executionRef,
            observedAt: observedAt(clock),
            error: platformError(error.code ?? "OPENCODE_API_ERROR", error.message, retryable),
          }
        }
        await saveOperation({ schemaVersion: "2.0", kind: "stop", operationId: intent.operationId, effectDigest: intent.effectDigest, receipt, createdAt: observedAt(clock), updatedAt: observedAt(clock) })
        return receipt
      })
    },

    async inspectStop(intent) {
      return withOperationLock(intent.operationId, async () => {
        const existing = await loadOperation(intent.operationId)
        if (existing) {
          assertOperation(existing, intent, "stop")
          if (existing.receipt.status !== "in-doubt") return existing.receipt
        }
        try {
          const statuses = await sessionStatuses()
          if (statuses?.[intent.executionRef]?.type === "busy" || statuses?.[intent.executionRef]?.type === "retry") {
            return { operationId: intent.operationId, effectDigest: intent.effectDigest, status: "in-doubt", executionRef: intent.executionRef, observedAt: observedAt(clock) }
          }
          const receipt = { operationId: intent.operationId, effectDigest: intent.effectDigest, status: "confirmed", executionRef: intent.executionRef, observedAt: observedAt(clock) }
          await saveOperation({ schemaVersion: "2.0", kind: "stop", operationId: intent.operationId, effectDigest: intent.effectDigest, receipt, createdAt: existing?.createdAt ?? observedAt(clock), updatedAt: observedAt(clock) })
          return receipt
        } catch {
          return { operationId: intent.operationId, effectDigest: intent.effectDigest, status: "in-doubt", executionRef: intent.executionRef, observedAt: observedAt(clock) }
        }
      })
    },

    async handleEvent(event) {
      const sessionId = event?.properties?.sessionID ?? event?.properties?.info?.id
      if (typeof sessionId !== "string" || !IDENTIFIER.test(sessionId) || !observationSinkFor) return false
      const base = await optionalRoots()
      if (!base) return false
      const projection = await readOptional(recordPath(base, "sessions", sessionId))
      if (!projection) return false
      let state
      let error
      if (event.type === "session.idle" || (event.type === "session.status" && event.properties?.status?.type === "idle")) {
        const statuses = await sessionStatuses().catch(() => null)
        if (!statuses || statuses[sessionId]?.type === "busy" || statuses[sessionId]?.type === "retry") return true
        state = "idle"
      }
      else if (event.type === "session.error") {
        state = "error"
        error = platformError("OPENCODE_SESSION_ERROR", event.properties?.error?.message ?? event.properties?.error ?? "OpenCode session failed", retryableSdkError(event.properties?.error))
      } else if (event.type === "session.deleted") state = "lost"
      else return false
      const fingerprint = digestValue({ type: event.type, properties: event.properties })
      await observationSinkFor(projection.taskId).observe({
        kind: "execution",
        observationId: `opencode-event-${fingerprint.slice(0, 24)}`,
        dedupeKey: `opencode:${sessionId}:${fingerprint}`,
        executionRef: sessionId,
        assignmentId: projection.assignmentId,
        state,
        observedAt: observedAt(clock),
        ...(error ? { error } : {}),
      })
      return true
    },

    async reconcileTaskExecutions(taskId) {
      requireIdentifier(taskId, "taskId")
      if (!observationSinkFor) return { observations: 0, inDoubt: false }
      const base = await roots()
      let statuses
      try {
        statuses = await sessionStatuses()
      } catch {
        return { observations: 0, inDoubt: true }
      }
      const files = (await readdir(path.join(base.platform, "sessions"))).filter((name) => name.endsWith(".json"))
      let observations = 0
      let inDoubt = false
      for (const file of files) {
        const projection = await readOptional(path.join(base.platform, "sessions", file))
        if (!projection || projection.taskId !== taskId) continue
        const status = statuses?.[projection.executionRef]
        if (status?.type === "busy" || status?.type === "retry") continue
        let state = "idle"
        let error
        try {
          await sessionGet(projection.executionRef)
        } catch (sdkError) {
          if (sdkError.statusCode !== 404) {
            inDoubt = true
            continue
          }
          state = "lost"
          error = platformError("SESSION_LOST", "OpenCode child session is missing during restart reconciliation", false)
        }
        const fingerprint = digestValue({
          operationId: projection.operationId,
          executionRef: projection.executionRef,
          state,
        })
        try {
          await observationSinkFor(taskId).observe({
            kind: "execution",
            observationId: `opencode-reconcile-${fingerprint.slice(0, 24)}`,
            dedupeKey: `opencode:reconcile:${fingerprint}`,
            executionRef: projection.executionRef,
            assignmentId: projection.assignmentId,
            state,
            observedAt: projection.updatedAt,
            ...(error ? { error } : {}),
          })
          observations += 1
        } catch (observationError) {
          if (observationError.code !== "OBSERVATION_BINDING_STALE") throw observationError
        }
      }
      return { observations, inDoubt }
    },

    async captureCheck({ sessionId, toolCallRef }) {
      const base = await roots()
      const safeSessionId = requireIdentifier(sessionId, "sessionId")
      if (typeof toolCallRef !== "string" || toolCallRef === "") throw fail("CHECK_BINDING_INVALID", "toolCallRef is required")
      const projection = await readOptional(recordPath(base, "sessions", safeSessionId))
      if (!projection) throw fail("SESSION_MAPPING_MISSING", "OpenCode session is not managed by Runtime v2")
      const target = checkBindingPath(base, safeSessionId, toolCallRef)
      const binding = {
        schemaVersion: "2.0",
        sessionId: safeSessionId,
        toolCallRef,
        taskId: projection.taskId,
        assignmentId: projection.assignmentId,
        attempt: projection.attempt,
        operationId: projection.operationId,
        capturedAt: observedAt(clock),
      }
      const existing = await readOptional(target)
      if (existing) {
        const stableFields = ["sessionId", "toolCallRef", "taskId", "assignmentId", "attempt", "operationId"]
        if (stableFields.some((field) => existing[field] !== binding[field])) {
          throw fail("CHECK_BINDING_CONFLICT", `check ${toolCallRef} is already bound to another assignment attempt`)
        }
        return existing
      }
      await atomicJson(target, binding)
      return binding
    },

    async recordCheck({ sessionId, toolCallRef, commandSummary, exitCode, outputRef }) {
      if (!observationSinkFor) throw fail("RUNTIME_NOT_ATTACHED", "OpenCode adapter is not attached to Runtime")
      const base = await roots()
      const safeSessionId = requireIdentifier(sessionId, "sessionId")
      const projection = await readOptional(recordPath(base, "sessions", safeSessionId))
      if (!projection) throw fail("SESSION_MAPPING_MISSING", "OpenCode session is not managed by Runtime v2")
      const binding = await readOptional(checkBindingPath(base, safeSessionId, toolCallRef))
      if (!binding) throw fail("CHECK_BINDING_MISSING", `check ${toolCallRef} was not captured before execution`)
      if (
        binding.sessionId !== safeSessionId
        || binding.taskId !== projection.taskId
        || binding.assignmentId !== projection.assignmentId
        || binding.attempt !== projection.attempt
        || binding.operationId !== projection.operationId
      ) throw fail("CHECK_BINDING_STALE", `check ${toolCallRef} belongs to an earlier assignment attempt`)
      let observation = binding.observation
      if (!observation) {
        const output = outputRef ? await readProjectFile(base.root, outputRef, "check output") : null
        const result = Number.isInteger(exitCode) ? (exitCode === 0 ? "pass" : "fail") : "unknown"
        observation = {
          kind: "check",
          observationId: `opencode-check-${digestValue({ sessionId, toolCallRef }).slice(0, 24)}`,
          dedupeKey: `opencode-check:${sessionId}:${toolCallRef}`,
          executionRef: sessionId,
          assignmentId: binding.assignmentId,
          attempt: binding.attempt,
          toolCallRef,
          commandSummary: String(commandSummary).slice(0, 500),
          ...(Number.isInteger(exitCode) ? { exitCode } : {}),
          result,
          ...(outputRef ? { outputRef, outputDigest: digestValue(output) } : {}),
          observedAt: observedAt(clock),
        }
        await atomicJson(checkBindingPath(base, safeSessionId, toolCallRef), { ...binding, observation })
      } else {
        const expected = {
          commandSummary: String(commandSummary).slice(0, 500),
          ...(Number.isInteger(exitCode) ? { exitCode } : {}),
          ...(outputRef ? { outputRef } : {}),
        }
        const recorded = {
          commandSummary: observation.commandSummary,
          ...(Number.isInteger(observation.exitCode) ? { exitCode: observation.exitCode } : {}),
          ...(observation.outputRef ? { outputRef: observation.outputRef } : {}),
        }
        if (digestValue(expected) !== digestValue(recorded)) throw fail("CHECK_RECEIPT_CONFLICT", `check ${toolCallRef} was retried with different content`)
      }
      return observationSinkFor(binding.taskId).observe(observation)
    },
  }

  return Object.freeze(adapter)
}
