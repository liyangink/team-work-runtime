import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import Ajv2020 from "ajv/dist/2020.js"
import addFormats from "ajv-formats"

import { canTransitionWorkItem, evaluateStageGate, planRollback, resolveActiveTask, validateTaskAgainstWorkflow, validateWorkflowSemantics, validateWorkItemsSemantics } from "../schemas/semantic-validation.mjs"

const runtimeRoot = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(runtimeRoot, "..")
const contractNames = ["project-config", "workflow", "task", "context-entry", "work-item", "work-items", "event", "binding"]

class RuntimeError extends Error {
  constructor(code, message, { retryable = false, blockers = [], remediation = [], exitCode = 2, task } = {}) {
    super(message)
    this.code = code
    this.retryable = retryable
    this.blockers = blockers
    this.remediation = remediation
    this.exitCode = exitCode
    this.task = task
  }
}

let validatorsPromise

async function validators() {
  if (!validatorsPromise) {
    validatorsPromise = (async () => {
      const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false })
      addFormats(ajv)
      const entries = await Promise.all(contractNames.map(async (name) => {
        const schema = JSON.parse(await readFile(path.join(repositoryRoot, `schemas/${name}.schema.json`), "utf8"))
        return [name, schema]
      }))
      entries.forEach(([, schema]) => ajv.addSchema(schema))
      return Object.fromEntries(entries.map(([name, schema]) => [name, ajv.getSchema(schema.$id)]))
    })()
  }
  return validatorsPromise
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

function now(clock) {
  return clock().toISOString()
}

async function exists(target) {
  try {
    await stat(target)
    return true
  } catch (error) {
    if (error.code === "ENOENT") return false
    throw error
  }
}

async function readJson(target, label = target) {
  try {
    return JSON.parse(await readFile(target, "utf8"))
  } catch (error) {
    if (error.code === "ENOENT") throw new RuntimeError("TASK_NOT_FOUND", `${label} does not exist`, { remediation: ["Initialize the project or select an existing task"] })
    if (error instanceof SyntaxError) throw new RuntimeError("STATE_CORRUPT", `${label} is not valid JSON`, { exitCode: 70, remediation: ["Run team-work doctor"] })
    throw error
  }
}

async function validate(name, value) {
  const validateContract = (await validators())[name]
  if (validateContract(value)) return
  const blockers = validateContract.errors.map((error) => ({
    code: "SCHEMA_INVALID",
    kind: name,
    path: error.instancePath || "/",
    message: error.message ?? "schema validation failed",
  }))
  throw new RuntimeError("INVALID_ARGUMENT", `${name} does not satisfy Runtime Interface 1.0`, { blockers })
}

async function atomicWrite(target, content) {
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`)
  const handle = await open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(content)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, target)
}

async function atomicJson(target, value) {
  await atomicWrite(target, `${JSON.stringify(value, null, 2)}\n`)
}

async function commitTaskFiles(taskRoot, taskId, writes) {
  const transactionId = randomUUID().toLowerCase()
  const transactionPath = path.join(taskRoot, `.txn/${transactionId}.json`)
  const manifest = {
    schemaVersion: "1.0",
    taskId,
    writes: writes.map(({ relativePath, content }) => ({ path: relativePath, content })),
  }
  await atomicJson(transactionPath, manifest)
  for (const write of manifest.writes) await atomicWrite(path.join(taskRoot, write.path), write.content)
  await rm(transactionPath, { force: true })
}

async function withLock(lockPath, action) {
  let handle
  try {
    handle = await open(lockPath, "wx", 0o600)
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new RuntimeError("LOCK_UNAVAILABLE", "Runtime state is locked by another writer", {
        retryable: true,
        exitCode: 3,
        remediation: ["Retry after the current writer completes", "Run doctor if the lock is stale"],
      })
    }
    throw error
  }
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`)
    await handle.sync()
  } catch (error) {
    await handle.close()
    await rm(lockPath, { force: true })
    throw error
  }
  try {
    return await action()
  } finally {
    await handle?.close()
    await rm(lockPath, { force: true })
  }
}

async function resolveControlDirectory(target, allowedRoot, label) {
  let metadata
  try { metadata = await lstat(target) } catch (error) {
    if (error.code === "ENOENT") throw new RuntimeError("STATE_CORRUPT", `${label} is missing`, { exitCode: 70 })
    throw error
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new RuntimeError("STATE_CORRUPT", `${label} must be a real directory`, { exitCode: 70 })
  const resolved = await realpath(target)
  if (resolved !== allowedRoot && !resolved.startsWith(`${allowedRoot}${path.sep}`)) throw new RuntimeError("STATE_CORRUPT", `${label} escapes its control root`, { exitCode: 70 })
  return resolved
}

function success(data, task) {
  return {
    envelope: {
      ok: true,
      apiVersion: "1.0",
      ...(task ? { taskId: task.taskId, revision: task.revision } : {}),
      data,
      warnings: [],
    },
    exitCode: 0,
  }
}

function failure(error) {
  const runtimeError = error instanceof RuntimeError
    ? error
    : new RuntimeError("INTERNAL_ERROR", error.message || "Unexpected Runtime failure", { exitCode: 70 })
  return {
    envelope: {
      ok: false,
      apiVersion: "1.0",
      ...(runtimeError.task ? { taskId: runtimeError.task.taskId, revision: runtimeError.task.revision } : {}),
      error: {
        code: runtimeError.code,
        message: runtimeError.message,
        retryable: runtimeError.retryable,
        blockers: runtimeError.blockers,
        remediation: runtimeError.remediation,
        ...(runtimeError.code === "INTERNAL_ERROR" ? { diagnosticId: randomUUID() } : {}),
      },
    },
    exitCode: runtimeError.exitCode,
  }
}

function safeId(value, label) {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value ?? "")) {
    throw new RuntimeError("INVALID_ARGUMENT", `${label} must match [a-z0-9][a-z0-9._-]*`)
  }
  return value
}

async function loadProject(projectRoot) {
  const root = await realpath(projectRoot)
  const stateRoot = await resolveControlDirectory(path.join(root, ".team-work"), root, ".team-work")
  for (const directory of ["tasks", "bindings", "archive", "workflows"]) await resolveControlDirectory(path.join(stateRoot, directory), stateRoot, `.team-work/${directory}`)
  const config = await readJson(path.join(stateRoot, "config.yaml"), "project config")
  await validate("project-config", config)
  let workflowPath
  try {
    workflowPath = await realpath(path.resolve(root, config.workflow.path))
  } catch (error) {
    if (error.code === "ENOENT") throw new RuntimeError("STATE_CORRUPT", "workflow file is missing", { exitCode: 70 })
    throw error
  }
  if (!workflowPath.startsWith(`${root}${path.sep}`)) throw new RuntimeError("STATE_CORRUPT", "workflow path escapes project root", { exitCode: 70 })
  const workflowRaw = await readFile(workflowPath, "utf8")
  if (digest(workflowRaw) !== config.workflow.digest) throw new RuntimeError("STATE_CORRUPT", "workflow digest does not match project config", { exitCode: 70 })
  const workflow = JSON.parse(workflowRaw)
  await validate("workflow", workflow)
  const semanticIssues = validateWorkflowSemantics(workflow)
  if (semanticIssues.length) throw new RuntimeError("STATE_CORRUPT", "workflow graph is invalid", { exitCode: 70, blockers: semanticIssues.map((entry) => ({ code: "WORKFLOW_INVALID", kind: "workflow", ...entry })) })
  return { root, stateRoot, config, workflow }
}

async function initialize(projectRoot, clock) {
  const root = await realpath(projectRoot)
  const stateRoot = path.join(root, ".team-work")
  if (await exists(path.join(stateRoot, "config.yaml"))) {
    const project = await loadProject(root)
    return success({ alreadyInitialized: true, initializedAt: now(clock), workflow: project.config.workflow })
  }
  if (await exists(stateRoot) && (await lstat(stateRoot)).isSymbolicLink()) throw new RuntimeError("STATE_CORRUPT", ".team-work must not be a symlink", { exitCode: 70 })
  for (const directory of ["tasks", "bindings", "archive", "workflows"]) {
    const candidate = path.join(stateRoot, directory)
    if (await exists(candidate)) await resolveControlDirectory(candidate, stateRoot, `.team-work/${directory}`)
  }
  await mkdir(path.join(stateRoot, "workflows"), { recursive: true })
  await mkdir(path.join(stateRoot, "tasks"), { recursive: true })
  await mkdir(path.join(stateRoot, "bindings"), { recursive: true })
  await mkdir(path.join(stateRoot, "archive"), { recursive: true })
  const workflowTarget = path.join(stateRoot, "workflows/engineering.json")
  if (!(await exists(workflowTarget))) {
    const source = await readFile(path.join(repositoryRoot, "schemas/examples/engineering.workflow.json"), "utf8")
    await atomicWrite(workflowTarget, source.endsWith("\n") ? source : `${source}\n`)
  }
  const resolvedWorkflowTarget = await realpath(workflowTarget)
  if (!resolvedWorkflowTarget.startsWith(`${root}${path.sep}`)) throw new RuntimeError("STATE_CORRUPT", "workflow path escapes project root", { exitCode: 70 })
  const workflowRaw = await readFile(resolvedWorkflowTarget, "utf8")
  const workflow = JSON.parse(workflowRaw)
  const config = {
    schemaVersion: "1.0",
    workflow: {
      id: workflow.workflowId,
      version: workflow.version,
      path: ".team-work/workflows/engineering.json",
      digest: digest(workflowRaw),
    },
    spec: { type: "openspec", skill: "openspec", root: "openspec/", status: "missing" },
  }
  await validate("workflow", workflow)
  await validate("project-config", config)
  await atomicJson(path.join(stateRoot, "config.yaml"), config)
  return success({ initializedAt: now(clock), workflow: config.workflow })
}

async function loadTask(project, taskId) {
  const id = safeId(taskId, "task id")
  const taskParent = await realpath(path.join(project.stateRoot, "tasks"))
  let taskRoot
  try {
    taskRoot = await realpath(path.join(taskParent, id))
  } catch (error) {
    if (error.code === "ENOENT") throw new RuntimeError("TASK_NOT_FOUND", `task ${id} does not exist`)
    throw error
  }
  if (!taskRoot.startsWith(`${taskParent}${path.sep}`)) throw new RuntimeError("STATE_CORRUPT", `task ${id} escapes task storage`, { exitCode: 70 })
  const task = await readJson(path.join(taskRoot, "task.json"), `task ${id}`)
  await validate("task", task)
  if (task.taskId !== id) throw new RuntimeError("STATE_CORRUPT", `task directory ${id} contains task ${task.taskId}`, { exitCode: 70 })
  let workItems
  if (task.status === "completed") {
    workItems = await readJson(path.join(taskRoot, "work-items.json"), "work-items document")
    await validate("work-items", workItems)
  }
  const issues = validateTaskAgainstWorkflow(task, project.workflow, { loadedWorkflowDigest: project.config.workflow.digest, workItems })
  if (issues.length) throw new RuntimeError("STATE_CORRUPT", `task ${id} is inconsistent with its workflow`, { exitCode: 70, blockers: issues.map((entry) => ({ code: "TASK_INVALID", kind: "task", ...entry })) })
  return task
}

function safePlatform(value) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value ?? "")) throw new RuntimeError("INVALID_ARGUMENT", "platform is invalid")
  return value
}

function safeSession(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value ?? "")) throw new RuntimeError("INVALID_ARGUMENT", "session key is invalid")
  return value
}

async function bindingTaskId(project, platform, sessionKey) {
  if (!platform && !sessionKey) return undefined
  const safePlatformId = safePlatform(platform)
  const safeSessionKey = safeSession(sessionKey)
  const bindingRoot = await resolveControlDirectory(path.join(project.stateRoot, "bindings"), project.stateRoot, ".team-work/bindings")
  const platformRootPath = path.join(bindingRoot, safePlatformId)
  if (!(await exists(platformRootPath))) return undefined
  const platformRoot = await resolveControlDirectory(platformRootPath, bindingRoot, `bindings/${safePlatformId}`)
  const target = path.join(platformRoot, `${safeSessionKey}.json`)
  if (!(await exists(target))) return undefined
  const binding = await readJson(target, "session binding")
  await validate("binding", binding)
  return binding.taskId
}

async function resolveTask(project, input) {
  if (input.taskId) return loadTask(project, input.taskId)
  const names = await readdir(path.join(project.stateRoot, "tasks"), { withFileTypes: true })
  const tasks = []
  for (const entry of names.filter((candidate) => candidate.isDirectory() && !candidate.name.startsWith("."))) {
    tasks.push(await loadTask(project, entry.name))
  }
  const resolution = resolveActiveTask({
    bindingTaskId: await bindingTaskId(project, input.platform, input.sessionKey),
    tasks,
  })
  if (resolution.errorCode) throw new RuntimeError(resolution.errorCode, resolution.errorCode === "TASK_AMBIGUOUS" ? "multiple active tasks require an explicit selection" : "no active task was found", {
    remediation: resolution.errorCode === "TASK_AMBIGUOUS" ? ["Pass --task or bind the current session"] : ["Create a task or pass an active task id"],
  })
  return loadTask(project, resolution.taskId)
}

async function bindTask(project, input, clock, dryRun) {
  const task = await loadTask(project, input.taskId)
  if (!["active", "awaiting-user"].includes(task.status)) throw new RuntimeError("ILLEGAL_TRANSITION", "only an active task can be bound", { exitCode: 4, task })
  const platform = safePlatform(input.platform)
  const sessionKey = safeSession(input.sessionKey)
  const bindingRoot = await resolveControlDirectory(path.join(project.stateRoot, "bindings"), project.stateRoot, ".team-work/bindings")
  const platformRootPath = path.join(bindingRoot, platform)
  await mkdir(platformRootPath, { recursive: true })
  const platformRoot = await resolveControlDirectory(platformRootPath, bindingRoot, `bindings/${platform}`)
  const target = path.join(platformRoot, `${sessionKey}.json`)
  const createBinding = async () => {
    const existing = await exists(target) ? await readJson(target, "session binding") : undefined
    if (existing && input.expectedRevision === undefined) throw new RuntimeError("REVISION_CONFLICT", "rebinding requires the current binding revision", { exitCode: 3, retryable: true, task })
    if (input.expectedRevision !== undefined && Number(input.expectedRevision) !== (existing?.revision ?? -1)) throw new RuntimeError("REVISION_CONFLICT", "binding revision changed", { exitCode: 3, retryable: true, task })
    const timestamp = now(clock)
    const binding = { schemaVersion: "1.0", platform, sessionKey, taskId: task.taskId, revision: (existing?.revision ?? -1) + 1, boundAt: existing?.boundAt ?? timestamp, updatedAt: timestamp }
    await validate("binding", binding)
    if (!dryRun) await atomicJson(target, binding)
    return binding
  }
  const binding = dryRun ? await createBinding() : await withLock(`${target}.lock`, createBinding)
  return success({ dryRun: Boolean(dryRun), binding }, task)
}

async function readJsonLines(target, label) {
  let raw
  try {
    raw = await readFile(target, "utf8")
  } catch (error) {
    if (error.code === "ENOENT") throw new RuntimeError("STATE_CORRUPT", `${label} is missing`, { exitCode: 70 })
    throw error
  }
  try {
    return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    throw new RuntimeError("STATE_CORRUPT", `${label} contains invalid JSONL`, { exitCode: 70, remediation: ["Run team-work doctor"] })
  }
}

function assertRevision(task, expectedRevision) {
  if (expectedRevision === undefined) return
  if (Number(expectedRevision) !== task.revision) {
    throw new RuntimeError("REVISION_CONFLICT", `expected revision ${expectedRevision}, current revision is ${task.revision}`, {
      exitCode: 3,
      retryable: true,
      task,
      remediation: ["Reload the task and retry with its current revision"],
    })
  }
}

async function appendEvent(project, task, type, clock, refs = [], reason) {
  const target = path.join(project.stateRoot, `tasks/${task.taskId}/events.jsonl`)
  const event = {
    schemaVersion: "1.0",
    eventId: randomUUID().toLowerCase(),
    taskId: task.taskId,
    type,
    actor: "runtime",
    occurredAt: now(clock),
    revision: task.revision,
    ...(reason ? { reason } : {}),
    refs,
  }
  await validate("event", event)
  await withLock(path.join(path.dirname(target), ".events.lock"), async () => {
    await appendPreparedEvent(target, event)
  })
}

async function appendPreparedEvent(target, event) {
  await atomicWrite(target, await preparedEventContent(target, event))
}

async function preparedEventContent(target, event) {
  const events = await readJsonLines(target, "events log")
  return `${[...events, event].map((entry) => JSON.stringify(entry)).join("\n")}\n`
}

async function prepareEvent(task, type, clock, refs = [], reason) {
  const event = {
    schemaVersion: "1.0", eventId: randomUUID().toLowerCase(), taskId: task.taskId, type,
    actor: "runtime", occurredAt: now(clock), revision: task.revision, ...(reason ? { reason } : {}), refs,
  }
  await validate("event", event)
  return event
}

async function loadContextEntries(project, task) {
  const entries = await readJsonLines(path.join(project.stateRoot, `tasks/${task.taskId}/context.jsonl`), "context index")
  for (const [index, entry] of entries.entries()) {
    try {
      await validate("context-entry", entry)
      if (entry.taskId !== task.taskId) throw new Error("taskId does not match task")
      await safeProjectEntry(project, entry.path)
    } catch (error) {
      throw new RuntimeError("STATE_CORRUPT", `context entry ${index} is invalid: ${error.message}`, { exitCode: 70, task })
    }
  }
  return entries
}

async function safeProjectEntry(project, relativePath) {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\\") || relativePath.split("/").includes("..") || /^[A-Za-z]:/.test(relativePath)) {
    throw new RuntimeError("INVALID_ARGUMENT", `unsafe project path: ${relativePath}`)
  }
  let resolved
  try {
    resolved = await realpath(path.resolve(project.root, relativePath))
  } catch (error) {
    if (error.code === "ENOENT") throw new RuntimeError("INVALID_ARGUMENT", `context path does not exist: ${relativePath}`)
    throw error
  }
  if (resolved !== project.root && !resolved.startsWith(`${project.root}${path.sep}`)) {
    throw new RuntimeError("INVALID_ARGUMENT", `context path escapes project root: ${relativePath}`)
  }
  return resolved
}

async function registerContext(project, input, clock, dryRun) {
  const task = await loadTask(project, input.taskId)
  assertRevision(task, input.expectedRevision)
  if (!["active", "awaiting-user"].includes(task.status)) throw new RuntimeError("ILLEGAL_TRANSITION", "terminal task cannot accept context", { exitCode: 4, task })
  const contextId = safeId(input.contextId, "context id")
  const resolved = await safeProjectEntry(project, input.path)
  const entryStat = await stat(resolved)
  const entry = {
    schemaVersion: "1.0",
    contextId,
    taskId: task.taskId,
    path: input.path,
    kind: input.kind,
    profiles: input.profiles,
    priority: Number(input.priority ?? 50),
    mustRead: Boolean(input.mustRead),
    ...(input.summary ? { summary: input.summary } : {}),
    ...(entryStat.isFile() ? { digest: digest(await readFile(resolved)) } : {}),
    updatedAt: now(clock),
  }
  await validate("context-entry", entry)
  const contextPath = path.join(project.stateRoot, `tasks/${task.taskId}/context.jsonl`)
  const entries = await loadContextEntries(project, task)
  if (entries.some(({ contextId: existing }) => existing === contextId)) throw new RuntimeError("WORK_ITEM_CONFLICT", `context id already exists: ${contextId}`, { exitCode: 3, task })
  const nextTask = { ...task, revision: task.revision + 1, updatedAt: now(clock) }
  if (dryRun) return success({ dryRun: true, context: entry }, nextTask)
  const taskRoot = path.join(project.stateRoot, `tasks/${task.taskId}`)
  return withLock(path.join(taskRoot, ".lock"), async () => {
    const current = await loadTask(project, task.taskId)
    assertRevision(current, task.revision)
    const event = await prepareEvent(nextTask, "context.registered", clock, [contextId, input.path])
    await withLock(path.join(taskRoot, ".events.lock"), async () => {
      const eventsContent = await preparedEventContent(path.join(taskRoot, "events.jsonl"), event)
      await commitTaskFiles(taskRoot, task.taskId, [
        { relativePath: "context.jsonl", content: `${[...entries, entry].map((value) => JSON.stringify(value)).join("\n")}\n` },
        { relativePath: "task.json", content: `${JSON.stringify(nextTask, null, 2)}\n` },
        { relativePath: "events.jsonl", content: eventsContent },
      ])
    })
    return success({ context: entry }, nextTask)
  })
}

async function listContext(project, taskId, profile) {
  const task = await loadTask(project, taskId)
  let entries = await loadContextEntries(project, task)
  if (profile) entries = entries.filter(({ profiles }) => profiles.includes(profile))
  entries.sort((left, right) => Number(right.mustRead) - Number(left.mustRead) || right.priority - left.priority || left.contextId.localeCompare(right.contextId))
  return success({ entries }, task)
}

function contextMarkdown(task, entries) {
  const lines = [`# ${task.title ?? task.taskId}`, "", `当前阶段：${task.stage}`, "", "## 上下文索引", ""]
  for (const entry of entries) {
    lines.push(`- ${entry.mustRead ? "[必读] " : ""}\`${entry.path}\`（${entry.kind}，${entry.profiles.join("/")}）${entry.summary ? `：${entry.summary}` : ""}`)
  }
  return `${lines.join("\n")}\n`
}

async function rebuildContext(project, input, dryRun) {
  const task = await loadTask(project, input.taskId)
  assertRevision(task, input.expectedRevision)
  const entries = (await listContext(project, task.taskId)).envelope.data.entries
  const markdown = contextMarkdown(task, entries)
  if (!dryRun) await atomicWrite(path.join(project.stateRoot, `tasks/${task.taskId}/index.md`), markdown)
  return success({ dryRun: Boolean(dryRun), markdown }, task)
}

async function evaluateCurrentStage(project, task) {
  const entries = await loadContextEntries(project, task)
  const gate = evaluateStageGate(project.workflow, task.stage, entries, task.gates)
  const workItems = await loadWorkItems(project, task)
  const pending = workItems.items.filter((item) => item.stage === task.stage && !["accepted", "cancelled"].includes(item.status))
  for (const item of pending) {
    gate.blockers.push({ code: "WORK_ITEM_PENDING", kind: "work-item", path: item.workItemId, message: `Work item ${item.workItemId} is ${item.status}` })
  }
  for (const item of workItems.items.filter((candidate) => candidate.stage === task.stage && candidate.status === "accepted")) {
    const validEvidence = new Set(task.evidence.filter(({ status }) => status === "valid").map(({ evidenceId }) => evidenceId))
    if (item.acceptance.evidenceRefs.some((ref) => !validEvidence.has(ref))) gate.blockers.push({ code: "INVALID_ACCEPTANCE_EVIDENCE", kind: "work-item", path: item.workItemId, message: "Accepted work item references invalid evidence" })
  }
  gate.ok = gate.blockers.length === 0
  return { gate, workItems }
}

async function checkFlow(project, taskId) {
  const task = await loadTask(project, taskId)
  const { gate } = await evaluateCurrentStage(project, task)
  if (!gate.ok) throw new RuntimeError("GATE_BLOCKED", `stage ${task.stage} is blocked`, {
    exitCode: 4,
    task,
    blockers: gate.blockers,
    remediation: gate.blockers.map(({ kind }) => `Register or resolve required ${kind}`),
  })
  return success({ gate }, task)
}

async function flowStatus(project, taskId) {
  const task = await loadTask(project, taskId)
  const { gate, workItems } = await evaluateCurrentStage(project, task)
  return success({
    stage: task.stage,
    status: task.status,
    gate,
    workItems: workItems.items.map(({ workItemId, owner, status, attempt }) => ({ workItemId, owner, status, attempt })),
  }, task)
}

async function persistTask(project, currentTask, nextTask, eventType, clock, { refs = [], reason, dryRun = false, workItems } = {}) {
  await validate("task", nextTask)
  const issues = validateTaskAgainstWorkflow(nextTask, project.workflow, { loadedWorkflowDigest: project.config.workflow.digest, workItems })
  if (issues.length) throw new RuntimeError("ILLEGAL_TRANSITION", "task mutation violates workflow semantics", {
    exitCode: 4,
    task: currentTask,
    blockers: issues.map((entry) => ({ code: "TASK_INVALID", kind: "task", ...entry })),
  })
  if (dryRun) return nextTask
  const taskRoot = path.join(project.stateRoot, `tasks/${currentTask.taskId}`)
  return withLock(path.join(taskRoot, ".lock"), async () => {
    const latest = await loadTask(project, currentTask.taskId)
    assertRevision(latest, currentTask.revision)
    const event = await prepareEvent(nextTask, eventType, clock, refs, reason)
    await withLock(path.join(taskRoot, ".events.lock"), async () => {
      const eventsContent = await preparedEventContent(path.join(taskRoot, "events.jsonl"), event)
      await commitTaskFiles(taskRoot, currentTask.taskId, [
        { relativePath: "task.json", content: `${JSON.stringify(nextTask, null, 2)}\n` },
        { relativePath: "events.jsonl", content: eventsContent },
      ])
    })
    return nextTask
  })
}

async function decideFlow(project, input, clock, dryRun) {
  const task = await loadTask(project, input.taskId)
  assertRevision(task, input.expectedRevision)
  if (task.status !== "active") throw new RuntimeError("ILLEGAL_TRANSITION", "flow decisions require an active task", { exitCode: 4, task })
  const timestamp = now(clock)
  const evidenceId = safeId(input.evidenceId, "evidence id")
  if (task.evidence.some(({ evidenceId: existing }) => existing === evidenceId)) throw new RuntimeError("WORK_ITEM_CONFLICT", `evidence id already exists: ${evidenceId}`, { exitCode: 3, task })
  await safeProjectEntry(project, input.evidencePath)
  const evidence = {
    evidenceId,
    stage: task.stage,
    path: input.evidencePath,
    status: "valid",
    recordedAtRevision: task.revision + 1,
  }
  const gate = {
    gateId: safeId(input.gateId, "gate id"),
    stage: task.stage,
    kind: input.kind,
    status: input.status,
    ...(input.blocker ? { blocker: input.blocker } : {}),
    evidenceRefs: [evidenceId],
    ...(["passed", "overridden"].includes(input.status) ? {
      decision: { decidedBy: input.actor, reason: input.reason, decidedAt: timestamp },
    } : {}),
  }
  const gates = task.gates.filter(({ gateId }) => gateId !== gate.gateId)
  const nextTask = {
    ...task,
    revision: task.revision + 1,
    gates: [...gates, gate],
    evidence: [...task.evidence, evidence],
    updatedAt: timestamp,
  }
  const persisted = await persistTask(project, task, nextTask, "flow.decided", clock, { refs: [gate.gateId, evidenceId], reason: input.reason, dryRun })
  return success({ dryRun: Boolean(dryRun), gate, evidence }, persisted)
}

async function advanceFlow(project, input, clock, dryRun) {
  const task = await loadTask(project, input.taskId)
  assertRevision(task, input.expectedRevision)
  if (task.status !== "active") throw new RuntimeError("ILLEGAL_TRANSITION", "flow advance requires an active task", { exitCode: 4, task })
  const transition = project.workflow.transitions.find(({ from, outcome }) => from === task.stage && outcome === input.outcome)
  if (!transition) throw new RuntimeError("ILLEGAL_TRANSITION", `no ${input.outcome} transition from ${task.stage}`, { exitCode: 4, task })
  const { gate } = await evaluateCurrentStage(project, task)
  if (!gate.ok) throw new RuntimeError("GATE_BLOCKED", `stage ${task.stage} is blocked`, { exitCode: 4, task, blockers: gate.blockers, remediation: ["Resolve current-stage gate blockers"] })
  const nextTask = { ...task, stage: transition.to, teamDecision: { mode: "undecided" }, revision: task.revision + 1, updatedAt: now(clock) }
  const persisted = await persistTask(project, task, nextTask, "flow.advanced", clock, { refs: [task.stage, transition.to], dryRun })
  return success({ dryRun: Boolean(dryRun), from: task.stage, to: transition.to, outcome: input.outcome, task: persisted }, persisted)
}

async function rollbackFlow(project, input, clock, dryRun) {
  const task = await loadTask(project, input.taskId)
  assertRevision(task, input.expectedRevision)
  const evidenceRefs = input.evidenceRefs ?? []
  const plan = planRollback(task, project.workflow, input.to, { reason: input.reason, evidenceRefs })
  if (plan.issues.length) throw new RuntimeError("ILLEGAL_TRANSITION", "rollback request is invalid", {
    exitCode: 4,
    task,
    blockers: plan.issues.map((entry) => ({ code: "ROLLBACK_INVALID", kind: "rollback", ...entry })),
  })
  const nextRevision = task.revision + 1
  const gatesToReset = new Set(plan.gateIdsToReset)
  const evidenceToInvalidate = new Set(plan.evidenceIdsToInvalidate)
  const nextTask = {
    ...task,
    stage: input.to,
    teamDecision: { mode: "undecided" },
    revision: nextRevision,
    gates: task.gates.map((gate) => gatesToReset.has(gate.gateId)
      ? { gateId: gate.gateId, stage: gate.stage, kind: gate.kind, status: "pending", evidenceRefs: [] }
      : gate),
    evidence: task.evidence.map((evidence) => evidenceToInvalidate.has(evidence.evidenceId)
      ? { ...evidence, status: "invalidated", invalidatedAtRevision: nextRevision, invalidationReason: input.reason }
      : evidence),
    updatedAt: now(clock),
  }
  const persisted = await persistTask(project, task, nextTask, "flow.rolled-back", clock, { refs: [task.stage, input.to, ...evidenceRefs], reason: input.reason, dryRun })
  return success({ dryRun: Boolean(dryRun), from: task.stage, to: input.to, task: persisted }, persisted)
}

async function loadWorkItems(project, task) {
  const document = await readJson(path.join(project.stateRoot, `tasks/${task.taskId}/work-items.json`), "work-items document")
  await validate("work-items", document)
  const issues = validateWorkItemsSemantics(document)
  if (issues.length) throw new RuntimeError("STATE_CORRUPT", "work-items document is inconsistent", {
    exitCode: 70,
    task,
    blockers: issues.map((entry) => ({ code: "WORK_ITEMS_INVALID", kind: "work-item", ...entry })),
  })
  return document
}

async function persistWorkMutation(project, task, document, nextItem, eventType, clock, { reason, dryRun = false } = {}) {
  const nextRevision = task.revision + 1
  const nextDocument = {
    ...document,
    revision: nextRevision,
    items: document.items.some(({ workItemId }) => workItemId === nextItem.workItemId)
      ? document.items.map((item) => item.workItemId === nextItem.workItemId ? nextItem : item)
      : [...document.items, nextItem],
  }
  const nextTask = { ...task, revision: nextRevision, updatedAt: now(clock) }
  await validate("work-items", nextDocument)
  const issues = validateWorkItemsSemantics(nextDocument)
  if (issues.length) throw new RuntimeError("WORK_ITEM_CONFLICT", "work-item mutation violates document semantics", {
    exitCode: 3,
    task,
    blockers: issues.map((entry) => ({ code: "WORK_ITEM_INVALID", kind: "work-item", ...entry })),
  })
  if (dryRun) return { task: nextTask, document: nextDocument }
  const taskRoot = path.join(project.stateRoot, `tasks/${task.taskId}`)
  return withLock(path.join(taskRoot, ".lock"), async () => {
    const current = await loadTask(project, task.taskId)
    assertRevision(current, task.revision)
    const event = await prepareEvent(nextTask, eventType, clock, [nextItem.workItemId], reason)
    await withLock(path.join(taskRoot, ".events.lock"), async () => {
      const eventsContent = await preparedEventContent(path.join(taskRoot, "events.jsonl"), event)
      await commitTaskFiles(taskRoot, task.taskId, [
        { relativePath: "work-items.json", content: `${JSON.stringify(nextDocument, null, 2)}\n` },
        { relativePath: "task.json", content: `${JSON.stringify(nextTask, null, 2)}\n` },
        { relativePath: "events.jsonl", content: eventsContent },
      ])
    })
    return { task: nextTask, document: nextDocument }
  })
}

function findWorkItem(document, workItemId, task) {
  const item = document.items.find(({ workItemId: id }) => id === workItemId)
  if (!item) throw new RuntimeError("TASK_NOT_FOUND", `work item does not exist: ${workItemId}`, { task })
  return item
}

async function createWork(project, input, clock, dryRun) {
  const task = await loadTask(project, input.taskId)
  assertRevision(task, input.expectedRevision)
  if (task.status !== "active") throw new RuntimeError("ILLEGAL_TRANSITION", "work creation requires an active task", { exitCode: 4, task })
  const document = await loadWorkItems(project, task)
  const itemStage = input.stage ?? task.stage
  if (!project.workflow.stages.some(({ id }) => id === itemStage) || itemStage !== task.stage) throw new RuntimeError("INVALID_ARGUMENT", "work item stage must be the current workflow stage", { task })
  const workItemId = safeId(input.workItemId, "work item id")
  if (document.items.some(({ workItemId: existing }) => existing === workItemId)) throw new RuntimeError("WORK_ITEM_CONFLICT", `work item already exists: ${workItemId}`, { exitCode: 3, task })
  for (const artifact of input.artifactPaths ?? []) await safeProjectEntry(project, artifact)
  const timestamp = now(clock)
  const item = {
    schemaVersion: "1.0",
    workItemId,
    taskId: task.taskId,
    stage: itemStage,
    owner: input.owner,
    status: "queued",
    attempt: 1,
    attemptHistory: [],
    assignment: {
      scope: input.scope,
      doneWhen: input.doneWhen,
      artifactPaths: input.artifactPaths,
      dependencies: input.dependencies ?? [],
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  const persisted = await persistWorkMutation(project, task, document, item, "work.created", clock, { dryRun })
  return success({ dryRun: Boolean(dryRun), workItem: item }, persisted.task)
}

async function transitionWork(project, input, action, clock, dryRun) {
  const task = await loadTask(project, input.taskId)
  assertRevision(task, input.expectedRevision)
  if (task.status !== "active") throw new RuntimeError("ILLEGAL_TRANSITION", "work mutation requires an active task", { exitCode: 4, task })
  const document = await loadWorkItems(project, task)
  const item = findWorkItem(document, input.workItemId, task)
  const targetByAction = { start: "running", submit: "submitted", accept: "accepted", rework: "rework", block: "blocked", cancel: "cancelled" }
  const target = targetByAction[action]
  if (!canTransitionWorkItem(item.status, target)) throw new RuntimeError("ILLEGAL_TRANSITION", `cannot move work item from ${item.status} to ${target}`, { exitCode: 4, task })
  const timestamp = now(clock)
  let nextItem = { ...item, status: target, updatedAt: timestamp }
  if (action === "start" && item.status === "rework") {
    nextItem = {
      ...nextItem,
      attempt: item.attempt + 1,
      attemptHistory: [...item.attemptHistory, { attempt: item.attempt, submission: item.submission, acceptance: item.acceptance }],
    }
    delete nextItem.submission
    delete nextItem.acceptance
  }
  if (action === "start" && item.status === "blocked") {
    nextItem = {
      ...nextItem,
      owner: input.owner ?? item.owner,
      attempt: item.attempt + 1,
      attemptHistory: [...item.attemptHistory, { attempt: item.attempt, owner: item.owner, blockage: item.blockage }],
    }
    delete nextItem.blockage
  }
  if (action === "block") {
    if (typeof input.errorCode !== "string" || !input.errorCode.trim()) throw new RuntimeError("INVALID_ARGUMENT", "work blockage requires an error code", { task })
    if (typeof input.reason !== "string" || !input.reason.trim()) throw new RuntimeError("INVALID_ARGUMENT", "work blockage requires a reason", { task })
    nextItem.blockage = {
      kind: "infrastructure",
      code: input.errorCode,
      reason: input.reason,
      refs: input.refs ?? [],
      owner: item.owner,
      blockedAt: timestamp,
    }
  }
  if (action === "submit") {
    for (const artifact of input.artifactPaths ?? []) await safeProjectEntry(project, artifact)
    nextItem.submission = {
      scenario: input.scenario,
      stageRef: item.stage,
      scopeRefs: input.scopeRefs,
      outcome: input.outcome,
      artifactRefs: input.artifactPaths,
      evidenceRefs: input.evidenceRefs ?? [],
      summary: input.summary,
      submittedAt: timestamp,
    }
  }
  if (["accept", "rework"].includes(action)) {
    const validEvidence = new Set(task.evidence.filter(({ status }) => status === "valid").map(({ evidenceId }) => evidenceId))
    if (!input.evidenceRefs?.length || input.evidenceRefs.some((ref) => !validEvidence.has(ref))) throw new RuntimeError("INVALID_ARGUMENT", "work acceptance requires valid task evidence", { task })
    nextItem.acceptance = {
      acceptedBy: input.actor ?? "lead",
      acceptedAt: timestamp,
      decision: action === "accept" ? "accepted" : "rework",
      evidenceRefs: input.evidenceRefs ?? [],
    }
  }
  const persisted = await persistWorkMutation(project, task, document, nextItem, `work.${action}`, clock, { reason: input.reason, dryRun })
  return success({ dryRun: Boolean(dryRun), workItem: nextItem }, persisted.task)
}

async function showWork(project, input) {
  const task = await loadTask(project, input.taskId)
  const document = await loadWorkItems(project, task)
  return success({ workItem: findWorkItem(document, input.workItemId, task) }, task)
}

async function recordEvent(project, input, clock, dryRun) {
  const task = await loadTask(project, input.taskId)
  assertRevision(task, input.expectedRevision)
  const event = {
    schemaVersion: "1.0",
    eventId: randomUUID().toLowerCase(),
    taskId: task.taskId,
    type: input.eventType,
    actor: input.actor,
    occurredAt: now(clock),
    revision: task.revision,
    ...(input.reason ? { reason: input.reason } : {}),
    refs: input.refs ?? [],
  }
  await validate("event", event)
  if (!dryRun) {
    const taskRoot = path.join(project.stateRoot, `tasks/${task.taskId}`)
    await withLock(path.join(taskRoot, ".events.lock"), async () => {
      const events = await readJsonLines(path.join(taskRoot, "events.jsonl"), "events log")
      await atomicWrite(path.join(taskRoot, "events.jsonl"), `${[...events, event].map((entry) => JSON.stringify(entry)).join("\n")}\n`)
    })
  }
  return success({ dryRun: Boolean(dryRun), event }, task)
}

async function listEvents(project, taskId) {
  const task = await loadTask(project, taskId)
  const events = await readJsonLines(path.join(project.stateRoot, `tasks/${task.taskId}/events.jsonl`), "events log")
  for (const event of events) await validate("event", event)
  return success({ events }, task)
}

async function decideTeam(project, input, clock, dryRun) {
  const task = await loadTask(project, input.taskId)
  assertRevision(task, input.expectedRevision)
  if (task.status !== "active") throw new RuntimeError("ILLEGAL_TRANSITION", "team decisions require an active task", { exitCode: 4, task })
  if (!["solo", "team"].includes(input.mode)) throw new RuntimeError("INVALID_ARGUMENT", "team mode must be solo or team", { task })
  if (typeof input.reason !== "string" || !input.reason.trim()) throw new RuntimeError("INVALID_ARGUMENT", "team decision requires a reason", { task })
  const nextTask = {
    ...task,
    teamDecision: { mode: input.mode, reason: input.reason },
    revision: task.revision + 1,
    updatedAt: now(clock),
  }
  const persisted = await persistTask(project, task, nextTask, "task.team-decided", clock, {
    refs: [task.stage, input.mode],
    reason: input.reason,
    dryRun,
  })
  return success({ dryRun: Boolean(dryRun), task: persisted }, persisted)
}

const specTransitions = {
  "not-started": new Set(["in-progress", "blocked", "disabled"]),
  "in-progress": new Set(["in-progress", "completed", "blocked", "disabled"]),
  blocked: new Set(["in-progress", "blocked", "disabled"]),
  completed: new Set(["in-progress", "completed"]),
  disabled: new Set(["in-progress", "disabled"]),
}

async function updateSpec(project, input, clock, dryRun) {
  const task = await loadTask(project, input.taskId)
  assertRevision(task, input.expectedRevision)
  if (task.status !== "active") throw new RuntimeError("ILLEGAL_TRANSITION", "SPEC updates require an active task", { exitCode: 4, task })
  if (!specTransitions[task.spec.status]?.has(input.status)) {
    throw new RuntimeError("ILLEGAL_TRANSITION", `cannot move SPEC from ${task.spec.status} to ${input.status}`, { exitCode: 4, task })
  }
  const artifactRefs = input.artifactPaths ?? task.spec.artifactRefs
  for (const artifact of artifactRefs) await safeProjectEntry(project, artifact)
  if (input.status === "completed" && !artifactRefs.length) throw new RuntimeError("INVALID_ARGUMENT", "completed SPEC requires at least one artifact", { task })
  const nextTask = {
    ...task,
    spec: { ...task.spec, status: input.status, artifactRefs },
    revision: task.revision + 1,
    updatedAt: now(clock),
  }
  const persisted = await persistTask(project, task, nextTask, "task.spec-updated", clock, {
    refs: [input.status, ...artifactRefs],
    reason: input.reason,
    dryRun,
  })
  return success({ dryRun: Boolean(dryRun), task: persisted }, persisted)
}

async function transitionTask(project, input, action, clock, dryRun) {
  const task = await loadTask(project, input.taskId)
  assertRevision(task, input.expectedRevision)
  const timestamp = now(clock)
  let nextTask
  let workItems
  if (action === "await") {
    if (task.status !== "active") throw new RuntimeError("ILLEGAL_TRANSITION", "only an active task can await user input", { exitCode: 4, task })
    nextTask = {
      ...task,
      status: "awaiting-user",
      awaitingUser: {
        question: input.question,
        blocker: input.blocker,
        requiredDecision: input.requiredDecision,
        ...(input.gateId ? { gateRef: input.gateId } : {}),
        requestedAt: timestamp,
      },
    }
  } else if (action === "resume") {
    if (task.status !== "awaiting-user") throw new RuntimeError("ILLEGAL_TRANSITION", "only an awaiting-user task can resume", { exitCode: 4, task })
    nextTask = { ...task, status: "active" }
    delete nextTask.awaitingUser
  } else if (action === "cancel") {
    if (!["active", "awaiting-user"].includes(task.status)) throw new RuntimeError("ILLEGAL_TRANSITION", "only an unfinished task can be cancelled", { exitCode: 4, task })
    nextTask = { ...task, status: "cancelled" }
    delete nextTask.awaitingUser
  } else if (action === "complete") {
    if (task.status !== "active") throw new RuntimeError("ILLEGAL_TRANSITION", "only an active task can be completed", { exitCode: 4, task })
    for (const artifact of input.artifactPaths ?? []) await safeProjectEntry(project, artifact)
    const currentStage = await evaluateCurrentStage(project, task)
    if (!currentStage.gate.ok) throw new RuntimeError("GATE_BLOCKED", `stage ${task.stage} is blocked`, { exitCode: 4, task, blockers: currentStage.gate.blockers, remediation: ["Resolve current-stage blockers before completion"] })
    workItems = currentStage.workItems
    nextTask = {
      ...task,
      status: "completed",
      acceptance: {
        acceptedBy: input.actor ?? "lead",
        acceptedAt: timestamp,
        summary: input.summary,
        artifactRefs: input.artifactPaths,
        evidenceRefs: input.evidenceRefs ?? [],
      },
    }
  } else {
    throw new RuntimeError("INVALID_ARGUMENT", `unsupported task transition: ${action}`)
  }
  nextTask = { ...nextTask, revision: task.revision + 1, updatedAt: timestamp }
  const persisted = await persistTask(project, task, nextTask, `task.${action}`, clock, { reason: input.reason, dryRun, workItems })
  return success({ dryRun: Boolean(dryRun), task: persisted }, persisted)
}

async function archiveTask(project, input, clock, dryRun) {
  const task = await loadTask(project, input.taskId)
  if (!["completed", "cancelled"].includes(task.status)) throw new RuntimeError("ILLEGAL_TRANSITION", "only a terminal task can be archived", { exitCode: 4, task })
  const source = path.join(project.stateRoot, `tasks/${task.taskId}`)
  const target = path.join(project.stateRoot, `archive/${task.taskId}`)
  if (await exists(target)) throw new RuntimeError("WORK_ITEM_CONFLICT", `archive already exists: ${task.taskId}`, { exitCode: 3, task })
  if (!dryRun) {
    await appendEvent(project, task, "task.archived", clock, [task.taskId])
    await withLock(path.join(project.stateRoot, ".project.lock"), async () => rename(source, target))
  }
  return success({ dryRun: Boolean(dryRun), archived: true, task }, task)
}

async function safeTransactionWrite(taskRoot, write) {
  if (typeof write.path !== "string" || typeof write.content !== "string" || path.isAbsolute(write.path) || write.path.includes("\\") || write.path.split("/").includes("..")) {
    throw new RuntimeError("STATE_CORRUPT", "transaction contains an unsafe write", { exitCode: 70 })
  }
  const target = path.resolve(taskRoot, write.path)
  if (!target.startsWith(`${taskRoot}${path.sep}`)) throw new RuntimeError("STATE_CORRUPT", "transaction write escapes task root", { exitCode: 70 })
  const resolvedParent = await realpath(path.dirname(target))
  if (resolvedParent !== taskRoot && !resolvedParent.startsWith(`${taskRoot}${path.sep}`)) throw new RuntimeError("STATE_CORRUPT", "transaction write parent escapes task root", { exitCode: 70 })
  return target
}

async function doctorProject(projectRoot, repair, force = false) {
  const root = await realpath(projectRoot)
  const stateRootPath = path.join(root, ".team-work")
  const issues = []
  const repaired = []
  if (!(await exists(stateRootPath))) return success({ healthy: false, issues: [{ code: "PROJECT_NOT_INITIALIZED", path: ".team-work", message: "Runtime is not initialized" }], repaired })
  const stateRoot = await resolveControlDirectory(stateRootPath, root, ".team-work")
  for (const directory of ["tasks", "bindings", "archive", "workflows"]) await resolveControlDirectory(path.join(stateRoot, directory), stateRoot, `.team-work/${directory}`)
  const taskParent = path.join(stateRoot, "tasks")
  const taskEntries = await readdir(taskParent, { withFileTypes: true })
  const inspectLock = async (lockPath, label) => {
    if (!(await exists(lockPath))) return
    let owner
    let ownerValid = true
    try { owner = await readJson(lockPath, "lock owner") } catch { ownerValid = false }
    let alive = false
    if (ownerValid && Number.isInteger(owner?.pid)) {
      try { process.kill(owner.pid, 0); alive = true } catch (error) { if (error.code === "EPERM") alive = true }
    } else ownerValid = false
    issues.push({ code: !ownerValid ? "LOCK_OWNER_UNKNOWN" : alive ? "LOCK_HELD" : "STALE_LOCK", path: label, message: !ownerValid ? "Lock owner is incomplete; only forced repair may remove it" : alive ? `Lock is held by pid ${owner.pid}` : "Lock owner is no longer running" })
    if (repair && (force || (ownerValid && !alive))) {
      await rm(lockPath, { recursive: true, force: true })
      repaired.push(label.replace(/^\.team-work\//, ""))
    }
  }
  await inspectLock(path.join(stateRoot, ".project.lock"), ".team-work/.project.lock")
  const bindingRoot = path.join(stateRoot, "bindings")
  if (await exists(bindingRoot)) {
    for (const platformEntry of await readdir(bindingRoot, { withFileTypes: true })) {
      if (platformEntry.isSymbolicLink()) throw new RuntimeError("STATE_CORRUPT", `bindings/${platformEntry.name} must not be a symlink`, { exitCode: 70 })
      if (!platformEntry.isDirectory()) continue
      const platformRoot = path.join(bindingRoot, platformEntry.name)
      for (const name of await readdir(platformRoot)) {
        if (name.endsWith(".lock")) await inspectLock(path.join(platformRoot, name), `.team-work/bindings/${platformEntry.name}/${name}`)
      }
    }
  }
  for (const taskEntry of taskEntries.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))) {
    const taskRoot = path.join(taskParent, taskEntry.name)
    for (const lockName of [".lock", ".events.lock"]) {
      await inspectLock(path.join(taskRoot, lockName), `.team-work/tasks/${taskEntry.name}/${lockName}`)
    }
    const transactionRoot = path.join(taskRoot, ".txn")
    const transactionNames = await exists(transactionRoot) ? await readdir(transactionRoot) : []
    for (const transactionName of transactionNames.filter((name) => name.endsWith(".json"))) {
      const transactionPath = path.join(transactionRoot, transactionName)
      issues.push({ code: "PENDING_TRANSACTION", path: `.team-work/tasks/${taskEntry.name}/.txn/${transactionName}`, message: "Interrupted write transaction requires replay" })
      if (!repair) continue
      const manifest = await readJson(transactionPath, "transaction manifest")
      if (manifest.schemaVersion !== "1.0" || manifest.taskId !== taskEntry.name || !Array.isArray(manifest.writes)) {
        throw new RuntimeError("STATE_CORRUPT", "transaction manifest is invalid", { exitCode: 70 })
      }
      for (const write of manifest.writes) await atomicWrite(await safeTransactionWrite(taskRoot, write), write.content)
      await rm(transactionPath)
      repaired.push(`${taskEntry.name}/${transactionName}`)
    }
  }
  let project
  try {
    project = await loadProject(root)
  } catch (error) {
    issues.push({ code: error.code ?? "INTERNAL_ERROR", path: ".team-work/config.yaml", message: error.message })
  }
  if (project) {
    for (const taskEntry of taskEntries.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))) {
      try {
        const task = await loadTask(project, taskEntry.name)
        await loadContextEntries(project, task)
        await loadWorkItems(project, task)
        const events = await readJsonLines(path.join(project.stateRoot, `tasks/${task.taskId}/events.jsonl`), "events log")
        for (const event of events) await validate("event", event)
      } catch (error) {
        issues.push({ code: error.code ?? "INTERNAL_ERROR", path: `.team-work/tasks/${taskEntry.name}`, message: error.message })
      }
    }
  }
  const remainingIssues = repair ? issues.filter(({ code }) => code !== "PENDING_TRANSACTION") : issues
  if (repair && repaired.length) {
    return doctorProject(root, false, false).then((result) => success({ ...result.envelope.data, repaired }))
  }
  return success({ healthy: remainingIssues.length === 0, issues: remainingIssues, repaired })
}

async function createTask(project, input, clock) {
  const taskId = safeId(input.taskId, "task id")
  const stage = input.entryStage ?? project.workflow.initialStage
  if (!project.workflow.stages.some(({ id }) => id === stage)) throw new RuntimeError("INVALID_ARGUMENT", `unknown entry stage: ${stage}`)
  const taskRoot = path.join(project.stateRoot, `tasks/${taskId}`)
  return withLock(path.join(project.stateRoot, ".project.lock"), async () => {
    if (await exists(taskRoot)) throw new RuntimeError("WORK_ITEM_CONFLICT", `task already exists: ${taskId}`, { exitCode: 3 })
    const timestamp = now(clock)
    const task = {
      schemaVersion: "1.0",
      taskId,
      ...(input.title ? { title: input.title } : {}),
      workflow: { ...project.config.workflow },
      status: "active",
      stage,
      entryStage: stage,
      revision: 0,
      spec: { status: "not-started", artifactRefs: [], configDigest: digest(JSON.stringify(project.config.spec)) },
      teamDecision: { mode: "undecided" },
      gates: [],
      evidence: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await validate("task", task)
    await mkdir(path.join(taskRoot, "artifacts"), { recursive: true })
    await mkdir(path.join(taskRoot, ".txn"), { recursive: true })
    await atomicJson(path.join(taskRoot, "task.json"), task)
    await atomicJson(path.join(taskRoot, "work-items.json"), { schemaVersion: "1.0", taskId, revision: 0, items: [] })
    await atomicWrite(path.join(taskRoot, "context.jsonl"), "")
    await atomicWrite(path.join(taskRoot, "events.jsonl"), "")
    await atomicWrite(path.join(taskRoot, "index.md"), `# ${input.title ?? taskId}\n\n当前阶段：${stage}\n`)
    return success({ task }, task)
  })
}

export async function executeRuntime(request, dependencies = {}) {
  const clock = dependencies.clock ?? (() => new Date())
  try {
    if (request.command === "version") return success({ runtimeVersion: "0.1.0", apiVersion: "1.0", schemaVersion: "1.0" })
    if (request.command === "init") return await initialize(request.projectRoot, clock)
    if (request.command === "doctor") return await doctorProject(request.projectRoot, request.input.repair, request.input.force)
    const project = await loadProject(request.projectRoot)
    if (request.command === "migrate") return success({ migrated: false, schemaVersion: "1.0" })
    if (request.command === "task.create") return await createTask(project, request.input, clock)
    if (request.command === "task.show") {
      const task = await resolveTask(project, request.input)
      return success({ task }, task)
    }
    if (request.command === "task.bind") return await bindTask(project, request.input, clock, request.dryRun)
    if (request.command === "task.team") return await decideTeam(project, request.input, clock, request.dryRun)
    if (request.command === "task.spec") return await updateSpec(project, request.input, clock, request.dryRun)
    if (["task.await", "task.resume", "task.complete", "task.cancel"].includes(request.command)) {
      return await transitionTask(project, request.input, request.command.split(".")[1], clock, request.dryRun)
    }
    if (request.command === "task.archive") return await archiveTask(project, request.input, clock, request.dryRun)
    if (request.command === "context.register") return await registerContext(project, request.input, clock, request.dryRun)
    if (["context.list", "context.render"].includes(request.command)) return await listContext(project, request.input.taskId, request.input.profile)
    if (request.command === "context.rebuild") return await rebuildContext(project, request.input, request.dryRun)
    if (request.command === "flow.check") return await checkFlow(project, request.input.taskId)
    if (request.command === "flow.status") return await flowStatus(project, request.input.taskId)
    if (request.command === "flow.decide") return await decideFlow(project, request.input, clock, request.dryRun)
    if (request.command === "flow.advance") return await advanceFlow(project, request.input, clock, request.dryRun)
    if (request.command === "flow.rollback") return await rollbackFlow(project, request.input, clock, request.dryRun)
    if (request.command === "work.create") return await createWork(project, request.input, clock, request.dryRun)
    if (["work.start", "work.submit", "work.accept", "work.rework", "work.block", "work.cancel"].includes(request.command)) {
      return await transitionWork(project, request.input, request.command.split(".")[1], clock, request.dryRun)
    }
    if (request.command === "work.show") return await showWork(project, request.input)
    if (request.command === "event.record") return await recordEvent(project, request.input, clock, request.dryRun)
    if (request.command === "event.list") return await listEvents(project, request.input.taskId)
    throw new RuntimeError("INVALID_ARGUMENT", `unsupported command: ${request.command}`)
  } catch (error) {
    return failure(error)
  }
}
