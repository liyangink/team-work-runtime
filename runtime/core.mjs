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
  const humanGates = new Set((workflow.gates ?? []).filter(({ kind }) => kind === "human").map(({ id }) => id))
  const unknownHumanReviews = Object.keys(config.humanReview ?? {}).filter((gateId) => !humanGates.has(gateId))
  if (unknownHumanReviews.length) throw new RuntimeError("STATE_CORRUPT", "project human-review configuration references unknown workflow gates", {
    exitCode: 70,
    blockers: unknownHumanReviews.map((gateId) => ({
      code: "HUMAN_REVIEW_CONFIG_INVALID",
      kind: "project-config",
      path: `humanReview.${gateId}`,
      message: `unknown human review gate: ${gateId}`,
    })),
    remediation: ["Remove unknown human-review keys or declare matching human gates in the pinned workflow"],
  })
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
    schemaVersion: "1.1",
    workflow: {
      id: workflow.workflowId,
      version: workflow.version,
      path: ".team-work/workflows/engineering.json",
      digest: digest(workflowRaw),
    },
    spec: { type: "openspec", skill: "openspec", root: "openspec/", mode: "auto", status: "missing" },
    humanReview: {
      "design-approval": "required",
      "final-acceptance": "required",
    },
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
  const issues = validateTaskAgainstWorkflow(task, project.workflow, {
    loadedWorkflowDigest: project.config.workflow.digest,
    workItems,
    gateModes: project.config.humanReview,
  })
  if (issues.length) throw new RuntimeError("STATE_CORRUPT", `task ${id} is inconsistent with its workflow`, { exitCode: 70, blockers: issues.map((entry) => ({ code: "TASK_INVALID", kind: "task", ...entry })) })
  if (task.status === "completed") {
    const staleHumanEvidence = await passedHumanGateEvidenceBlockers(project, task)
    if (staleHumanEvidence.length) throw new RuntimeError("STATE_CORRUPT", `completed task ${id} has stale human-review evidence`, {
      exitCode: 70,
      blockers: staleHumanEvidence,
      remediation: ["Restore the accepted artifact or reopen the task through an audited recovery procedure"],
    })
  }
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

async function safeFutureProjectEntry(project, relativePath) {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\\") || relativePath.split("/").includes("..") || /^[A-Za-z]:/.test(relativePath)) {
    throw new RuntimeError("INVALID_ARGUMENT", `unsafe project path: ${relativePath}`)
  }
  const target = path.resolve(project.root, relativePath)
  if (target !== project.root && !target.startsWith(`${project.root}${path.sep}`)) {
    throw new RuntimeError("INVALID_ARGUMENT", `project path escapes project root: ${relativePath}`)
  }
  let cursor = project.root
  for (const segment of relativePath.split("/").slice(0, -1)) {
    cursor = path.join(cursor, segment)
    try {
      const metadata = await lstat(cursor)
      if (metadata.isSymbolicLink()) throw new RuntimeError("INVALID_ARGUMENT", `project path crosses a symbolic link: ${relativePath}`)
      if (!metadata.isDirectory()) throw new RuntimeError("INVALID_ARGUMENT", `project path parent is not a directory: ${relativePath}`)
    } catch (error) {
      if (error.code === "ENOENT") break
      throw error
    }
  }
  return target
}

function normalizedProjectPrefix(value) {
  return `${String(value ?? "").replace(/^\/+|\/+$/g, "")}/`
}

function openSpecPathPolicy(project, task, artifactPaths, { requireActiveChange = false, allowArchivedAtFinish = false, enforceWorkStage = false } = {}) {
  if (project.config.spec.type !== "openspec" || project.config.spec.mode === "disabled") return
  const specRoot = normalizedProjectPrefix(project.config.spec.root)
  const activeRoot = `${specRoot}changes/${task.taskId}/`
  const archiveRoot = `${specRoot}changes/archive/`
  for (const artifact of artifactPaths ?? []) {
    const candidate = String(artifact).replace(/^\.\//, "")
    const managed = candidate === activeRoot.slice(0, -1) || candidate.startsWith(activeRoot)
    const archived = candidate.startsWith(archiveRoot)
      && candidate.slice(archiveRoot.length).split("/")[0]?.endsWith(`-${task.taskId}`)
    if (managed) {
      const implementationTaskList = task.stage === "implementation" && candidate === `${activeRoot}tasks.md`
      if (!enforceWorkStage || ["spec", "spec-review"].includes(task.stage) || implementationTaskList) continue
      throw new RuntimeError("GATE_BLOCKED", "OpenSpec content changes require the SPEC workflow stage", {
        exitCode: 4,
        task,
        blockers: [{
          code: "OPENSPEC_STAGE_FORBIDDEN",
          kind: "spec",
          path: candidate,
          message: `Stage ${task.stage} may update only ${activeRoot}tasks.md; return to SPEC for proposal, design, or requirement changes`,
        }],
        remediation: ["Roll back to the SPEC stage for content changes", `Only implementation task progress may update ${activeRoot}tasks.md`],
      })
    }
    if (allowArchivedAtFinish && task.stage === "finish" && archived) continue
    if (!requireActiveChange && !candidate.startsWith(specRoot)) continue
    throw new RuntimeError("GATE_BLOCKED", "OpenSpec artifacts must belong to the current active change", {
      exitCode: 4,
      task,
      blockers: [{
        code: "OPENSPEC_PATH_FORBIDDEN",
        kind: "spec",
        path: candidate,
        message: `Use ${activeRoot}; agents must not write canonical specs, archived changes, or another task's change`,
      }],
      remediation: [`Create or resume the active OpenSpec change ${task.taskId}`, `Use artifact paths under ${activeRoot}`],
    })
  }
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
  const workflowGateIds = new Set((project.workflow.gates ?? []).map(({ id }) => id))
  const gate = evaluateStageGate(project.workflow, task.stage, entries, task.gates.filter(({ gateId, stageRun }) => workflowGateIds.has(gateId) && stageRun === task.stageRun))
  const workItems = await loadWorkItems(project, task)
  const currentRunItems = workItems.items.filter((item) => item.stage === task.stage && item.stageRun === task.stageRun)
  const pending = currentRunItems.filter((item) => !["accepted", "cancelled"].includes(item.status))
  for (const item of pending) {
    gate.blockers.push({ code: "WORK_ITEM_PENDING", kind: "work-item", path: item.workItemId, message: `Work item ${item.workItemId} is ${item.status}` })
  }
  const accepted = currentRunItems.filter((candidate) => candidate.status === "accepted")
  if (task.stageRunRequiresWork && accepted.length === 0) {
    gate.blockers.push({
      code: "STAGE_RUN_DELIVERY_REQUIRED",
      kind: "work-item",
      path: `${task.stage}#${task.stageRun}`,
      message: "Reopened workflow stage requires a newly accepted delivery",
    })
  }
  for (const item of accepted) {
    const validEvidence = new Set(task.evidence.filter(({ status }) => status === "valid").map(({ evidenceId }) => evidenceId))
    if (item.acceptance.evidenceRefs.some((ref) => !validEvidence.has(ref))) gate.blockers.push({ code: "INVALID_ACCEPTANCE_EVIDENCE", kind: "work-item", path: item.workItemId, message: "Accepted work item references invalid evidence" })
  }
  if (["spec", "spec-review"].includes(task.stage) && project.config.spec.mode !== "disabled" && task.spec.status !== "completed") {
    gate.blockers.push({
      code: "SPEC_LIFECYCLE_INCOMPLETE",
      kind: "spec",
      path: `${normalizedProjectPrefix(project.config.spec.root)}changes/${task.taskId}`,
      message: "The configured SPEC provider has not completed the active change artifacts",
    })
  }
  gate.ok = gate.blockers.length === 0
  return { gate, workItems }
}

async function checkFlow(project, taskId) {
  const task = await loadTask(project, taskId)
  const { gate } = await evaluateCurrentStage(project, task)
  gate.blockers.push(...await passedHumanGateEvidenceBlockers(project, task), ...await requiredStageGateBlockers(project, task))
  gate.ok = gate.blockers.length === 0
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
  gate.blockers.push(...await passedHumanGateEvidenceBlockers(project, task), ...await requiredStageGateBlockers(project, task))
  gate.ok = gate.blockers.length === 0
  return success({
    stage: task.stage,
    status: task.status,
    gate,
    workItems: workItems.items.map(({ workItemId, owner, status, attempt }) => ({ workItemId, owner, status, attempt })),
  }, task)
}

async function persistTask(project, currentTask, nextTask, eventType, clock, { refs = [], reason, dryRun = false, workItems } = {}) {
  await validate("task", nextTask)
  const issues = validateTaskAgainstWorkflow(nextTask, project.workflow, {
    loadedWorkflowDigest: project.config.workflow.digest,
    workItems,
    gateModes: project.config.humanReview,
  })
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

function declaredGate(project, gateId) {
  return (project.workflow.gates ?? []).find(({ id }) => id === gateId)
}

function configuredGateMode(project, declaration) {
  if (!declaration) return "required"
  if (declaration.kind === "human") return project.config.humanReview?.[declaration.id] ?? declaration.defaultMode
  return declaration.defaultMode
}

async function gateEvidenceBlocker(project, task, gate) {
  for (const evidenceId of gate.evidenceRefs) {
    const evidence = task.evidence.find(({ evidenceId: id }) => id === evidenceId)
    if (!evidence?.digest) {
      return { code: "EVIDENCE_FINGERPRINT_MISSING", kind: gate.kind, gateId: gate.gateId, evidenceId }
    }
    try {
      const target = await safeProjectEntry(project, evidence.path)
      const metadata = await stat(target)
      if (!metadata.isFile()) return { code: "EVIDENCE_CHANGED", kind: gate.kind, gateId: gate.gateId, evidenceId, path: evidence.path }
      const actual = digest(await readFile(target))
      if (actual !== evidence.digest) {
        return { code: "EVIDENCE_CHANGED", kind: gate.kind, gateId: gate.gateId, evidenceId, path: evidence.path, expected: evidence.digest, actual }
      }
    } catch (error) {
      return { code: "EVIDENCE_CHANGED", kind: gate.kind, gateId: gate.gateId, evidenceId, path: evidence.path, message: error.message }
    }
  }
  return null
}

async function requiredGateDecision(project, task, gateId) {
  const declaration = declaredGate(project, gateId)
  const mode = configuredGateMode(project, declaration)
  if (mode === "disabled") return null
  const gate = task.gates.find(({ gateId: id, stage, stageRun }) => id === gateId && stage === task.stage && stageRun === task.stageRun)
  if (mode === "optional" && !gate) return null
  const acceptedStatuses = declaration?.kind === "human" ? ["passed"] : ["passed", "overridden"]
  if (gate && acceptedStatuses.includes(gate.status) && (!declaration || gate.kind === declaration.kind)) return gateEvidenceBlocker(project, task, gate)
  return {
    code: "REQUIRED_GATE_MISSING",
    kind: declaration?.kind ?? "semantic",
    gateId,
    mode,
    ...(gate ? { status: gate.status } : {}),
  }
}

async function requiredStageGateBlockers(project, task) {
  return (await Promise.all((project.workflow.gates ?? [])
    .filter(({ stage }) => stage === task.stage)
    .map(({ id }) => requiredGateDecision(project, task, id))))
    .filter(Boolean)
}

async function passedHumanGateEvidenceBlockers(project, task) {
  const declarations = new Map((project.workflow.gates ?? []).filter(({ kind }) => kind === "human").map((gate) => [gate.id, gate]))
  return (await Promise.all(task.gates
    .filter((gate) => gate.kind === "human" && gate.status === "passed" && configuredGateMode(project, declarations.get(gate.gateId)) !== "disabled")
    .map((gate) => gateEvidenceBlocker(project, task, gate))))
    .filter(Boolean)
}

async function decideFlow(project, input, clock, dryRun) {
  const task = await loadTask(project, input.taskId)
  assertRevision(task, input.expectedRevision)
  const declaration = declaredGate(project, input.gateId)
  const isHuman = declaration?.kind === "human"
  if (input.kind === "human" && !isHuman) throw new RuntimeError("INVALID_ARGUMENT", "human decisions require a declared human gate", { exitCode: 4, task })
  if (isHuman) {
    if (configuredGateMode(project, declaration) === "disabled") throw new RuntimeError("ILLEGAL_TRANSITION", "disabled human review cannot receive a decision", { exitCode: 4, task })
    if (declaration.stage !== task.stage || input.kind !== "human") throw new RuntimeError("INVALID_ARGUMENT", "human decision does not match the declared gate", { exitCode: 4, task })
    if (task.status !== "awaiting-user" || task.awaitingUser?.gateRef !== declaration.id || input.actor !== "user") {
      throw new RuntimeError("HUMAN_DECISION_REQUIRED", "human gate requires the task to await this gate and the decision actor to be user", {
        exitCode: 4,
        task,
        blockers: [{ code: "HUMAN_DECISION_REQUIRED", kind: "human", gateId: declaration.id }],
        remediation: ["Put the task into awaiting-user for this gate and wait for the user's explicit decision"],
      })
    }
    if (!["passed", "rejected"].includes(input.status)) throw new RuntimeError("INVALID_ARGUMENT", "human gate status must be passed or rejected", { exitCode: 4, task })
  } else if (task.status !== "active") {
    throw new RuntimeError("ILLEGAL_TRANSITION", "flow decisions require an active task", { exitCode: 4, task })
  }
  if (declaration && declaration.kind !== input.kind) throw new RuntimeError("INVALID_ARGUMENT", "gate kind does not match the workflow declaration", { exitCode: 4, task })
  const timestamp = now(clock)
  const evidenceId = safeId(input.evidenceId, "evidence id")
  if (task.evidence.some(({ evidenceId: existing }) => existing === evidenceId)) throw new RuntimeError("WORK_ITEM_CONFLICT", `evidence id already exists: ${evidenceId}`, { exitCode: 3, task })
  const evidenceTarget = await safeProjectEntry(project, input.evidencePath)
  if (isHuman) {
    const awaitedEvidenceTarget = await safeProjectEntry(project, task.awaitingUser.evidencePath)
    if (evidenceTarget !== awaitedEvidenceTarget) throw new RuntimeError("HUMAN_DECISION_REQUIRED", "human decision evidence must match the artifact presented for review", {
      exitCode: 4,
      task,
      blockers: [{ code: "HUMAN_REVIEW_ARTIFACT_MISMATCH", kind: "human", gateId: declaration.id, expected: task.awaitingUser.evidencePath, actual: input.evidencePath }],
      remediation: ["Record the decision against the exact artifact named when the human review started"],
    })
  }
  const evidenceMetadata = await stat(evidenceTarget)
  if (!evidenceMetadata.isFile()) throw new RuntimeError("INVALID_ARGUMENT", "decision evidence must be a file", { exitCode: 4, task })
  const evidence = {
    evidenceId,
    stage: task.stage,
    stageRun: task.stageRun,
    path: input.evidencePath,
    digest: digest(await readFile(evidenceTarget)),
    status: "valid",
    recordedAtRevision: task.revision + 1,
  }
  const gate = {
    gateId: safeId(input.gateId, "gate id"),
    stage: task.stage,
    stageRun: task.stageRun,
    kind: input.kind,
    status: input.status,
    ...(input.blocker ? { blocker: input.blocker } : {}),
    evidenceRefs: [evidenceId],
    ...(["passed", "rejected", "overridden"].includes(input.status) ? {
      decision: { decidedBy: input.actor, reason: input.reason, decidedAt: timestamp },
    } : {}),
  }
  const gates = task.gates.filter(({ gateId }) => gateId !== gate.gateId)
  const nextTask = {
    ...task,
    ...(isHuman ? { status: "active" } : {}),
    revision: task.revision + 1,
    gates: [...gates, gate],
    evidence: [...task.evidence, evidence],
    updatedAt: timestamp,
  }
  if (isHuman) delete nextTask.awaitingUser
  const persisted = await persistTask(project, task, nextTask, "flow.decided", clock, { refs: [gate.gateId, evidenceId], reason: input.reason, dryRun })
  return success({ dryRun: Boolean(dryRun), gate, evidence, task: persisted }, persisted)
}

async function decideAwaitedHuman(project, input, clock, dryRun) {
  const task = await loadTask(project, input.taskId)
  assertRevision(task, input.expectedRevision)
  if (task.status !== "awaiting-user" || !task.awaitingUser?.gateRef || !task.awaitingUser?.evidencePath) {
    throw new RuntimeError("HUMAN_DECISION_REQUIRED", "task is not waiting on a complete human-review checkpoint", {
      exitCode: 4,
      task,
      blockers: [{ code: "HUMAN_DECISION_REQUIRED", kind: "human", ...(task.awaitingUser?.gateRef ? { gateId: task.awaitingUser.gateRef } : {}) }],
      remediation: ["Request the declared human review before recording the user's decision"],
    })
  }
  if (input.actor !== "user") throw new RuntimeError("HUMAN_DECISION_REQUIRED", "human decisions must be attributed to the user", { exitCode: 4, task })
  return decideFlow(project, {
    ...input,
    gateId: task.awaitingUser.gateRef,
    evidencePath: task.awaitingUser.evidencePath,
    kind: "human",
  }, clock, dryRun)
}

async function awaitDeclaredHuman(project, input, clock, dryRun) {
  const task = await loadTask(project, input.taskId)
  assertRevision(task, input.expectedRevision)
  const candidates = (project.workflow.gates ?? []).filter((declaration) => (
    declaration.kind === "human"
      && declaration.stage === task.stage
      && configuredGateMode(project, declaration) !== "disabled"
  ))
  if (candidates.length !== 1) {
    throw new RuntimeError("HUMAN_GATE_REQUIRED", `stage ${task.stage} must resolve exactly one enabled human gate`, {
      exitCode: 4,
      task,
      blockers: candidates.map(({ id }) => ({ code: "HUMAN_GATE_AMBIGUOUS", kind: "human", gateId: id })),
      remediation: ["Declare exactly one enabled human-review gate for this workflow stage"],
    })
  }
  return transitionTask(project, { ...input, gateId: candidates[0].id }, "await", clock, dryRun)
}

function enforceSpecRoute(project, task, transition) {
  const stages = new Map(project.workflow.stages.map((stage) => [stage.id, stage]))
  const entersSpec = Boolean(stages.get(transition.to)?.specRoute)
  const skipsSpec = transition.outcome === "skip" && project.workflow.transitions.some(({ from, to }) => (
    from === task.stage && stages.get(to)?.specRoute
  ))
  if (!entersSpec && !skipsSpec) return

  const { mode, status } = project.config.spec
  const ready = status === "ready" && mode !== "disabled"
  const allowed = entersSpec
    ? ready
    : mode === "disabled" || (mode === "auto" && !ready)
  if (allowed) return

  const reason = mode === "required" && !ready
    ? "required SPEC route is unavailable"
    : entersSpec
      ? "SPEC route is not available"
      : "available SPEC route cannot be skipped"
  throw new RuntimeError("GATE_BLOCKED", reason, {
    exitCode: 4,
    task,
    blockers: [{ code: "SPEC_ROUTE_BLOCKED", kind: "semantic", mode, status }],
    remediation: mode === "required" && !ready
      ? ["Install and initialize the configured SPEC provider, then restart the platform host"]
      : entersSpec
        ? ["Use the declared skip transition or make the SPEC route ready"]
        : ["Use the declared transition into the ready SPEC stage"],
  })
}

async function advanceFlow(project, input, clock, dryRun) {
  const task = await loadTask(project, input.taskId)
  assertRevision(task, input.expectedRevision)
  if (task.status !== "active") throw new RuntimeError("ILLEGAL_TRANSITION", "flow advance requires an active task", { exitCode: 4, task })
  const transition = project.workflow.transitions.find(({ from, outcome }) => from === task.stage && outcome === input.outcome)
  if (!transition) throw new RuntimeError("ILLEGAL_TRANSITION", `no ${input.outcome} transition from ${task.stage}`, { exitCode: 4, task })
  const { gate } = await evaluateCurrentStage(project, task)
  if (!gate.ok) throw new RuntimeError("GATE_BLOCKED", `stage ${task.stage} is blocked`, { exitCode: 4, task, blockers: gate.blockers, remediation: ["Resolve current-stage gate blockers"] })
  const staleHumanEvidence = await passedHumanGateEvidenceBlockers(project, task)
  if (staleHumanEvidence.length) throw new RuntimeError("GATE_BLOCKED", "approved human-review evidence changed after approval", {
    exitCode: 4,
    task,
    blockers: staleHumanEvidence,
    remediation: ["Return to the review stage and request approval for the current artifact"],
  })
  enforceSpecRoute(project, task, transition)
  if (transition.requiredGate) {
    const blocker = await requiredGateDecision(project, task, transition.requiredGate)
    if (blocker) throw new RuntimeError("GATE_BLOCKED", `transition requires gate ${transition.requiredGate}`, {
      exitCode: 4,
      task,
      blockers: [blocker],
      remediation: [`Record ${transition.requiredGate} with decision evidence before advancing`],
    })
  }
  const nextRevision = task.revision + 1
  const stageOrder = new Map(project.workflow.stages.map(({ id }, index) => [id, index]))
  const movesBackward = stageOrder.get(transition.to) < stageOrder.get(task.stage)
  const events = await readJsonLines(path.join(project.stateRoot, `tasks/${task.taskId}/events.jsonl`), "events log")
  const revisitsStage = task.entryStage === transition.to || events.some(({ type, refs }) => (
    ["flow.advanced", "flow.rolled-back"].includes(type) && refs?.includes(transition.to)
  ))
  const reopensStage = transition.to === task.stage || movesBackward || revisitsStage
  const resetReason = `workflow ${input.outcome} moved ${task.stage} to ${transition.to}`
  const nextTask = {
    ...task,
    stage: transition.to,
    stageRun: task.stageRun + 1,
    stageRunRequiresWork: reopensStage || ["rework", "fail", "test-gap"].includes(input.outcome),
    teamDecision: { mode: "undecided" },
    revision: nextRevision,
    updatedAt: now(clock),
    ...(movesBackward ? {
      gates: task.gates.map((gate) => (stageOrder.get(gate.stage) > stageOrder.get(transition.to)
        ? { gateId: gate.gateId, stage: gate.stage, stageRun: task.stageRun + 1, kind: gate.kind, status: "pending", evidenceRefs: [] }
        : gate)),
      evidence: task.evidence.map((evidence) => (evidence.status === "valid" && stageOrder.get(evidence.stage) > stageOrder.get(transition.to)
        ? { ...evidence, status: "invalidated", invalidatedAtRevision: nextRevision, invalidationReason: resetReason }
        : evidence)),
    } : {}),
  }
  const persisted = await persistTask(project, task, nextTask, "flow.advanced", clock, { refs: [...new Set([task.stage, transition.to, transition.requiredGate].filter(Boolean))], dryRun })
  return success({ dryRun: Boolean(dryRun), from: task.stage, to: transition.to, outcome: input.outcome, task: persisted }, persisted)
}

async function proceedFlow(project, input, clock, dryRun) {
  const task = await loadTask(project, input.taskId)
  assertRevision(task, input.expectedRevision)
  if (input.outcome) return advanceFlow(project, input, clock, dryRun)
  const transitions = project.workflow.transitions.filter(({ from, outcome }) => (
    from === task.stage && ["pass", "skip"].includes(outcome)
  ))
  const stages = new Map(project.workflow.stages.map((stage) => [stage.id, stage]))
  const entersSpec = transitions.find(({ to }) => stages.get(to)?.specRoute)
  const skipsSpec = entersSpec && transitions.find(({ outcome }) => outcome === "skip")
  let selected
  if (entersSpec && skipsSpec) {
    const ready = project.config.spec.status === "ready" && project.config.spec.mode !== "disabled"
    selected = ready ? entersSpec : project.config.spec.mode === "required" ? entersSpec : skipsSpec
  } else if (transitions.length === 1) {
    selected = transitions[0]
  } else {
    throw new RuntimeError("WORKFLOW_DECISION_REQUIRED", `stage ${task.stage} has more than one valid forward result`, {
      exitCode: 4,
      task,
      blockers: transitions.map(({ outcome, to }) => ({ code: "WORKFLOW_DECISION_REQUIRED", kind: "workflow", outcome, path: to })),
      remediation: ["Provide the reviewed business result for this stage"],
    })
  }
  if (!selected) throw new RuntimeError("ILLEGAL_TRANSITION", `stage ${task.stage} has no forward transition`, { exitCode: 4, task })
  return advanceFlow(project, { ...input, outcome: selected.outcome }, clock, dryRun)
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
    stageRun: task.stageRun + 1,
    stageRunRequiresWork: true,
    teamDecision: { mode: "undecided" },
    revision: nextRevision,
    gates: task.gates.map((gate) => gatesToReset.has(gate.gateId)
      ? { gateId: gate.gateId, stage: gate.stage, stageRun: task.stageRun + 1, kind: gate.kind, status: "pending", evidenceRefs: [] }
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
  openSpecPathPolicy(project, task, input.artifactPaths, { enforceWorkStage: true })
  for (const artifact of input.artifactPaths ?? []) await safeFutureProjectEntry(project, artifact)
  const timestamp = now(clock)
  const item = {
    schemaVersion: "1.1",
    workItemId,
    taskId: task.taskId,
    stage: itemStage,
    stageRun: task.stageRun,
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
    openSpecPathPolicy(project, task, input.artifactPaths, { enforceWorkStage: true })
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

async function updateProjectSpecReadiness(project, input, dryRun) {
  const mode = input.mode
  const status = input.status
  if (!["auto", "required", "disabled"].includes(mode) || !["ready", "missing", "disabled"].includes(status)) {
    throw new RuntimeError("INVALID_ARGUMENT", "project SPEC readiness requires a valid mode and status")
  }
  if ((mode === "disabled") !== (status === "disabled")) {
    throw new RuntimeError("INVALID_ARGUMENT", "disabled SPEC mode and status must be set together")
  }
  const configPath = path.join(project.stateRoot, "config.yaml")
  if (dryRun) return success({ dryRun: true, spec: { ...project.config.spec, mode, status } })
  return withLock(path.join(project.stateRoot, ".project.lock"), async () => {
    const current = await readJson(configPath, "project config")
    await validate("project-config", current)
    const next = { ...current, spec: { ...current.spec, mode, status } }
    await validate("project-config", next)
    await atomicJson(configPath, next)
    return success({ spec: next.spec })
  })
}

async function updateSpec(project, input, clock, dryRun) {
  const task = await loadTask(project, input.taskId)
  assertRevision(task, input.expectedRevision)
  if (task.status !== "active") throw new RuntimeError("ILLEGAL_TRANSITION", "SPEC updates require an active task", { exitCode: 4, task })
  if (!specTransitions[task.spec.status]?.has(input.status)) {
    throw new RuntimeError("ILLEGAL_TRANSITION", `cannot move SPEC from ${task.spec.status} to ${input.status}`, { exitCode: 4, task })
  }
  const artifactRefs = input.artifactPaths ?? task.spec.artifactRefs
  if (["in-progress", "completed"].includes(input.status)) {
    openSpecPathPolicy(project, task, artifactRefs, {
      requireActiveChange: artifactRefs.length > 0,
      allowArchivedAtFinish: input.status === "completed",
    })
  }
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
    const repairsGateLessWait = task.status === "awaiting-user" && !task.awaitingUser?.gateRef && Boolean(input.gateId)
    if (task.status !== "active" && !repairsGateLessWait) throw new RuntimeError("ILLEGAL_TRANSITION", "only an active task can await user input", { exitCode: 4, task })
    const declaration = input.gateId ? declaredGate(project, input.gateId) : null
    if (input.gateId && (!declaration || declaration.kind !== "human" || declaration.stage !== task.stage || configuredGateMode(project, declaration) === "disabled")) {
      throw new RuntimeError("INVALID_ARGUMENT", "awaited gate must be an enabled human gate declared for the current stage", { exitCode: 4, task })
    }
    let reviewEvidencePath
    if (declaration) {
      const reviewEvidenceTarget = await safeProjectEntry(project, input.evidencePath)
      const reviewEvidenceMetadata = await stat(reviewEvidenceTarget)
      if (!reviewEvidenceMetadata.isFile()) throw new RuntimeError("INVALID_ARGUMENT", "human review evidence must be a file", { exitCode: 4, task })
      reviewEvidencePath = path.relative(project.root, reviewEvidenceTarget).split(path.sep).join("/")
    }
    const gates = declaration
      ? [...task.gates.filter(({ gateId }) => gateId !== declaration.id), {
          gateId: declaration.id,
          stage: task.stage,
          stageRun: task.stageRun,
          kind: "human",
          status: "pending",
          evidenceRefs: [],
        }]
      : task.gates
    nextTask = {
      ...task,
      gates,
      status: "awaiting-user",
      awaitingUser: {
        question: input.question,
        blocker: input.blocker,
        requiredDecision: input.requiredDecision,
        ...(input.gateId ? { gateRef: input.gateId } : {}),
        ...(reviewEvidencePath ? { evidencePath: reviewEvidencePath } : {}),
        requestedAt: repairsGateLessWait ? task.awaitingUser.requestedAt : timestamp,
      },
    }
  } else if (action === "resume") {
    if (task.status !== "awaiting-user") throw new RuntimeError("ILLEGAL_TRANSITION", "only an awaiting-user task can resume", { exitCode: 4, task })
    if (task.awaitingUser.gateRef) throw new RuntimeError("HUMAN_DECISION_REQUIRED", "a human gate must be resolved through flow decide", {
      exitCode: 4,
      task,
      blockers: [{ code: "HUMAN_DECISION_REQUIRED", kind: "human", gateId: task.awaitingUser.gateRef }],
      remediation: ["Record the user's passed or rejected decision for the awaited human gate"],
    })
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
    const staleHumanEvidence = await passedHumanGateEvidenceBlockers(project, task)
    if (staleHumanEvidence.length) throw new RuntimeError("GATE_BLOCKED", "approved human-review evidence changed after approval", {
      exitCode: 4,
      task,
      blockers: staleHumanEvidence,
      remediation: ["Return to the review stage and request approval for the current artifact"],
    })
    const gateBlockers = await requiredStageGateBlockers(project, task)
    if (gateBlockers.length) throw new RuntimeError("GATE_BLOCKED", `stage ${task.stage} requires configured gate decisions`, {
      exitCode: 4,
      task,
      blockers: gateBlockers,
      remediation: ["Complete every required stage gate before task completion"],
    })
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
      schemaVersion: "1.1",
      taskId,
      ...(input.title ? { title: input.title } : {}),
      workflow: { ...project.config.workflow },
      status: "active",
      stage,
      entryStage: stage,
      stageRun: 1,
      stageRunRequiresWork: false,
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
    await atomicJson(path.join(taskRoot, "work-items.json"), { schemaVersion: "1.1", taskId, revision: 0, items: [] })
    await atomicWrite(path.join(taskRoot, "context.jsonl"), "")
    await atomicWrite(path.join(taskRoot, "events.jsonl"), "")
    await atomicWrite(path.join(taskRoot, "index.md"), `# ${input.title ?? taskId}\n\n当前阶段：${stage}\n`)
    return success({ task }, task)
  })
}

async function migrateProject(project, clock) {
  const tasksRoot = path.join(project.stateRoot, "tasks")
  const entries = await readdir(tasksRoot, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return []
    throw error
  })
  let migratedTasks = 0
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue
    const taskId = safeId(entry.name, "task id")
    const taskRoot = path.join(tasksRoot, taskId)
    const migrated = await withLock(path.join(taskRoot, ".lock"), async () => {
      const task = await readJson(path.join(taskRoot, "task.json"), "task state")
      const document = await readJson(path.join(taskRoot, "work-items.json"), "work-items document")
      if (!["1.0", "1.1"].includes(task.schemaVersion) || !["1.0", "1.1"].includes(document.schemaVersion)) {
        throw new RuntimeError("STATE_CORRUPT", "unsupported task schema version", { exitCode: 70 })
      }
      if (task.schemaVersion === "1.1" && document.schemaVersion === "1.1") {
        await validate("task", task)
        await validate("work-items", document)
        return false
      }
      if (task.schemaVersion !== "1.0" || document.schemaVersion !== "1.0") {
        throw new RuntimeError("STATE_CORRUPT", "task and work-items schema versions do not match", { exitCode: 70 })
      }

      const nextRevision = task.revision + 1
      const nextTask = {
        ...task,
        schemaVersion: "1.1",
        stageRun: Number.isInteger(task.stageRun) ? task.stageRun : 1,
        stageRunRequiresWork: typeof task.stageRunRequiresWork === "boolean" ? task.stageRunRequiresWork : false,
        gates: task.gates.map((gate) => ({ ...gate, stageRun: Number.isInteger(gate.stageRun) ? gate.stageRun : 1 })),
        evidence: task.evidence.map((evidence) => ({ ...evidence, stageRun: Number.isInteger(evidence.stageRun) ? evidence.stageRun : 1 })),
        revision: nextRevision,
        updatedAt: now(clock),
      }
      const nextDocument = {
        ...document,
        schemaVersion: "1.1",
        revision: nextRevision,
        items: document.items.map((item) => ({
          ...item,
          schemaVersion: "1.1",
          stageRun: Number.isInteger(item.stageRun) ? item.stageRun : 1,
        })),
      }
      await validate("task", nextTask)
      await validate("work-items", nextDocument)
      const semanticIssues = validateWorkItemsSemantics(nextDocument)
      if (semanticIssues.length) throw new RuntimeError("STATE_CORRUPT", "legacy work-items cannot be migrated safely", {
        exitCode: 70,
        task: nextTask,
        blockers: semanticIssues.map((issue) => ({ code: "WORK_ITEMS_INVALID", kind: "work-item", ...issue })),
      })
      const event = await prepareEvent(nextTask, "runtime.migrated", clock, ["stage-run"])
      await withLock(path.join(taskRoot, ".events.lock"), async () => {
        const eventsContent = await preparedEventContent(path.join(taskRoot, "events.jsonl"), event)
        await commitTaskFiles(taskRoot, taskId, [
          { relativePath: "task.json", content: `${JSON.stringify(nextTask, null, 2)}\n` },
          { relativePath: "work-items.json", content: `${JSON.stringify(nextDocument, null, 2)}\n` },
          { relativePath: "events.jsonl", content: eventsContent },
        ])
      })
      return true
    })
    if (migrated) migratedTasks += 1
  }
  return success({ migrated: migratedTasks > 0, schemaVersion: "1.1", tasks: migratedTasks })
}

export async function executeRuntime(request, dependencies = {}) {
  const clock = dependencies.clock ?? (() => new Date())
  try {
    if (request.command === "version") return success({ runtimeVersion: "0.1.0-beta.0", apiVersion: "1.0", schemaVersion: "1.1" })
    if (request.command === "init") return await initialize(request.projectRoot, clock)
    if (request.command === "doctor") return await doctorProject(request.projectRoot, request.input.repair, request.input.force)
    const project = await loadProject(request.projectRoot)
    if (request.command === "migrate") return await migrateProject(project, clock)
    if (request.command === "project.spec") return await updateProjectSpecReadiness(project, request.input, request.dryRun)
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
    if (request.command === "flow.await") return await awaitDeclaredHuman(project, request.input, clock, request.dryRun)
    if (request.command === "flow.decide") return await decideFlow(project, request.input, clock, request.dryRun)
    if (request.command === "flow.human") return await decideAwaitedHuman(project, request.input, clock, request.dryRun)
    if (request.command === "flow.proceed") return await proceedFlow(project, request.input, clock, request.dryRun)
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
