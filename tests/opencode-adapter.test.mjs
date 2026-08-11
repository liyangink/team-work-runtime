import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { createOpenCodeAdapter } from "../plugins/opencode/src/opencode-adapter.mjs"

const tempProject = () => mkdtemp(path.join(os.tmpdir(), "team-work-adapter-"))
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function fakeClient() {
  const calls = []
  return {
    calls,
    session: {
      async create(input) {
        calls.push(["create", input])
        return { data: { id: "child-1", parentID: input.body.parentID, title: input.body.title } }
      },
      async promptAsync(input) {
        calls.push(["promptAsync", input])
        return { data: undefined }
      },
      async prompt(input) {
        calls.push(["prompt", input])
        throw new Error("blocking prompt must never be called")
      },
      async status(input) {
        calls.push(["status", input])
        return { data: { "child-1": { type: "busy" } } }
      },
      async get(input) {
        calls.push(["get", input])
        return { data: { id: input.path.id } }
      },
      async messages(input) {
        calls.push(["messages", input])
        return { data: [{ info: { id: "message-1" }, parts: [{ type: "text", text: "result" }] }] }
      },
      async abort(input) {
        calls.push(["abort", input])
        return { data: true }
      },
    },
  }
}

function testAdapter(client, projectRoot, extras = {}) {
  return createOpenCodeAdapter({ client, projectRoot, assignmentValidator: async () => {}, ...extras })
}

test("managed spawn and resume always use native promptAsync child sessions", async () => {
  const projectRoot = await tempProject()
  const client = fakeClient()
  const adapter = testAdapter(client, projectRoot)

  const spawned = await adapter.spawn({
    taskId: "task-1",
    workItemId: "review-1",
    parentSessionId: "lead-1",
    agent: "senior-terra",
    contextProfile: "check",
    prompt: "独立审查",
  })
  assert.equal(spawned.mode, "background")
  assert.equal(spawned.sessionId, "child-1")
  assert.deepEqual(client.calls.map(([name]) => name), ["create", "promptAsync"])
  assert.equal(client.calls[1][1].body.agent, "senior-terra")

  await adapter.resume({ taskId: "task-1", workItemId: "review-1", prompt: "复核证据" })
  assert.deepEqual(client.calls.map(([name]) => name), ["create", "promptAsync", "promptAsync"])
  assert.equal(client.calls.some(([name]) => name === "prompt"), false)

  const mapping = JSON.parse(await readFile(path.join(projectRoot, ".team-work/platform/opencode/sessions/task-1/review-1.json"), "utf8"))
  assert.equal(mapping.sessionId, "child-1")
  assert.equal(mapping.contextProfile, "check")
  assert.equal(mapping.dispatchMode, "background")
})

test("status, result collection, and stop recover through stable task/work-item mapping", async () => {
  const projectRoot = await tempProject()
  const client = fakeClient()
  const adapter = testAdapter(client, projectRoot)
  await adapter.spawn({ taskId: "task-2", workItemId: "impl-1", parentSessionId: "lead-2", agent: "junior-luna", prompt: "实现" })

  const status = await adapter.status({ taskId: "task-2", workItemId: "impl-1" })
  assert.equal(status.status.type, "busy")
  const messages = await adapter.messages({ taskId: "task-2", workItemId: "impl-1" })
  assert.equal(messages.messages[0].parts[0].text, "result")
  const stopped = await adapter.stop({ taskId: "task-2", workItemId: "impl-1" })
  assert.equal(stopped.stopped, true)
  assert.equal(client.calls.some(([name]) => name === "abort"), true)
})

test("adapter rejects path traversal identifiers before touching the SDK", async () => {
  const projectRoot = await tempProject()
  const client = fakeClient()
  const adapter = testAdapter(client, projectRoot)
  await assert.rejects(
    adapter.spawn({ taskId: "../escape", workItemId: "x", parentSessionId: "lead", agent: "team-junior-luna", prompt: "x" }),
    (error) => error.code === "INVALID_IDENTIFIER",
  )
  assert.equal(client.calls.length, 0)
})

test("context injection selects lead or child profile without copying artifact bodies", async () => {
  const projectRoot = await tempProject()
  const client = fakeClient()
  const requests = []
  const runtimeExecutor = async (request) => {
    requests.push(request)
    if (request.command === "task.show") return {
      exitCode: 0,
      envelope: { data: { task: { taskId: request.input.taskId ?? "task-bound", stage: "code-review" } } },
    }
    return {
      exitCode: 0,
      envelope: { data: { entries: [{ path: "src/a.js", kind: "source", mustRead: true, summary: "审查目标" }] } },
    }
  }
  const adapter = testAdapter(client, projectRoot, { runtimeExecutor })

  const lead = await adapter.contextForSession("lead-7")
  assert.match(lead, /profile: lead/)
  assert.match(lead, /src\/a\.js/)
  assert.equal(requests[0].input.sessionKey, "lead-7")

  await adapter.spawn({
    taskId: "task-7",
    workItemId: "check-1",
    parentSessionId: "lead-7",
    agent: "senior-terra",
    contextProfile: "check",
    prompt: "审查",
  })
  requests.length = 0
  const child = await adapter.contextForSession("child-1")
  assert.match(child, /profile: check/)
  assert.equal(requests[0].input.taskId, "task-7")
  assert.equal(requests[1].input.profile, "check")
})

test("SDK field-style errors are surfaced as recoverable platform errors", async () => {
  const projectRoot = await tempProject()
  const client = fakeClient()
  client.session.promptAsync = async () => ({ error: { data: { message: "gateway rate limited" } } })
  const adapter = testAdapter(client, projectRoot)
  await assert.rejects(
    adapter.spawn({ taskId: "task-8", workItemId: "research-1", parentSessionId: "lead-8", agent: "junior-flash", prompt: "调研" }),
    (error) => error.code === "OPENCODE_API_ERROR" && /rate limited/.test(error.message),
  )
  const mapping = JSON.parse(await readFile(path.join(projectRoot, ".team-work/platform/opencode/sessions/task-8/research-1.json"), "utf8"))
  assert.match(mapping.dispatchError, /rate limited/)
})

test("the same work item cannot create a second child session", async () => {
  const projectRoot = await tempProject()
  const client = fakeClient()
  const adapter = testAdapter(client, projectRoot)
  const assignment = { taskId: "task-9", workItemId: "impl-1", parentSessionId: "lead-9", agent: "junior-luna", prompt: "实现" }
  await adapter.spawn(assignment)
  await assert.rejects(adapter.spawn(assignment), (error) => error.code === "SESSION_MAPPING_EXISTS")
  assert.equal(client.calls.filter(([name]) => name === "create").length, 1)
})

test("spawn validates the installed agent and Runtime assignment before creating a session", async () => {
  const projectRoot = await tempProject()
  const profilePath = path.join(projectRoot, ".team-work/platform/opencode/profile.json")
  await mkdir(path.dirname(profilePath), { recursive: true })
  await writeFile(profilePath, `${JSON.stringify({ agents: [{ id: "senior-terra", resolvedModel: "gateway/gpt-5.6-terra" }] })}\n`)
  const client = fakeClient()
  const runtimeExecutor = async (request) => {
    if (request.command === "task.show") return { exitCode: 0, envelope: { data: { task: { status: "active", teamDecision: { mode: "team" } } } } }
    return { exitCode: 0, envelope: { data: { workItem: { owner: "senior-terra", status: "queued" } } } }
  }
  const adapter = createOpenCodeAdapter({ client, projectRoot, runtimeExecutor })
  await adapter.spawn({ taskId: "task-10", workItemId: "review-1", parentSessionId: "lead-10", agent: "senior-terra", prompt: "审查" })
  assert.equal(client.calls.filter(([name]) => name === "create").length, 1)

  await assert.rejects(
    adapter.spawn({ taskId: "task-10", workItemId: "review-2", parentSessionId: "lead-10", agent: "build", prompt: "绕过" }),
    (error) => error.code === "AGENT_UNAVAILABLE",
  )
  assert.equal(client.calls.filter(([name]) => name === "create").length, 1)
})

test("missing child sessions are reported as lost rather than idle", async () => {
  const projectRoot = await tempProject()
  const client = fakeClient()
  const adapter = testAdapter(client, projectRoot)
  await adapter.spawn({ taskId: "task-11", workItemId: "impl-1", parentSessionId: "lead-11", agent: "junior-luna", prompt: "实现" })
  client.session.status = async () => ({ data: {} })
  client.session.get = async () => ({ error: { status: 404, data: { message: "not found" } } })
  const result = await adapter.status({ taskId: "task-11", workItemId: "impl-1" })
  assert.equal(result.status.type, "lost")
  assert.match(result.status.remediation, /重派/)
})

test("thrown SDK network errors receive stable retryable platform semantics", async () => {
  const projectRoot = await tempProject()
  const client = fakeClient()
  client.session.promptAsync = async () => { throw new TypeError("fetch failed") }
  const adapter = testAdapter(client, projectRoot)
  await assert.rejects(
    adapter.spawn({ taskId: "task-12", workItemId: "research-1", parentSessionId: "lead-12", agent: "junior-flash", prompt: "调研" }),
    (error) => error.code === "OPENCODE_API_ERROR" && error.retryable === true && error.remediation.length > 0,
  )
})

test("stale dispatch locks recover by owner PID and managed sessions reject native task", async () => {
  const projectRoot = await tempProject()
  const lock = path.join(projectRoot, ".team-work/platform/opencode/sessions/task-13/impl-1.json.lock")
  await mkdir(path.dirname(lock), { recursive: true })
  await writeFile(lock, `${JSON.stringify({ pid: 2147483647 })}\n`)
  const client = fakeClient()
  const runtimeExecutor = async () => ({
    exitCode: 0,
    envelope: { data: { task: { status: "active", teamDecision: { mode: "team" } } } },
  })
  const adapter = testAdapter(client, projectRoot, { runtimeExecutor })
  await adapter.spawn({ taskId: "task-13", workItemId: "impl-1", parentSessionId: "lead-13", agent: "junior-luna", prompt: "实现" })
  assert.equal(await adapter.isManagedTeamSession("child-1"), true)

  const plugin = await readFile(path.join(sourceRoot, "plugins/opencode/assets/team-work.js"), "utf8")
  assert.match(plugin, /"tool\.execute\.before"/)
  assert.match(plugin, /input\.tool !== "task"/)
  assert.match(plugin, /TEAM_WORK_BLOCKING_TASK_REJECTED/)
})

test("managed task guard fails closed when Runtime state cannot be read", async () => {
  const projectRoot = await tempProject()
  const client = fakeClient()
  let runtimeFails = false
  const runtimeExecutor = async () => runtimeFails
    ? { exitCode: 70, envelope: { code: "STATE_CORRUPT", message: "broken" } }
    : { exitCode: 0, envelope: { data: { task: { status: "active", teamDecision: { mode: "team" } } } } }
  const adapter = testAdapter(client, projectRoot, { runtimeExecutor })
  await adapter.spawn({ taskId: "task-14", workItemId: "review-1", parentSessionId: "lead-14", agent: "senior-terra", prompt: "审查" })
  runtimeFails = true
  assert.equal(await adapter.isManagedTeamSession("child-1"), true)
  assert.equal(await adapter.isManagedTeamSession("ordinary-session"), false)
})

test("dispatch and resume outcomes are normalized into best-effort Runtime audit events", async () => {
  const projectRoot = await tempProject()
  const client = fakeClient()
  const events = []
  const runtimeExecutor = async (request) => {
    if (request.command === "event.record") {
      events.push(request.input)
      return { exitCode: 0, envelope: { data: { event: request.input } } }
    }
    return { exitCode: 0, envelope: { data: {} } }
  }
  const adapter = testAdapter(client, projectRoot, { runtimeExecutor })
  await adapter.spawn({ taskId: "task-audit", workItemId: "impl-1", parentSessionId: "lead-audit", agent: "junior-luna", prompt: "实现" })
  await adapter.resume({ taskId: "task-audit", workItemId: "impl-1", prompt: "补充证据" })
  await adapter.stop({ taskId: "task-audit", workItemId: "impl-1" })

  assert.deepEqual(events.map(({ eventType }) => eventType), [
    "platform.dispatch.accepted",
    "platform.resume.accepted",
    "platform.session.stopped",
  ])
  assert.ok(events.every(({ actor, refs }) => actor === "platform:opencode" && refs.includes("impl-1") && refs.includes("child-1")))
})

test("gateway failures remain retryable, preserve mapping, and emit infrastructure audit without masking the original error", async () => {
  const projectRoot = await tempProject()
  const client = fakeClient()
  client.session.promptAsync = async () => { throw new TypeError("gateway overloaded") }
  const events = []
  const runtimeExecutor = async (request) => {
    if (request.command === "event.record") events.push(request.input)
    return { exitCode: 0, envelope: { data: {} } }
  }
  const adapter = testAdapter(client, projectRoot, { runtimeExecutor })

  await assert.rejects(
    adapter.spawn({ taskId: "task-fault", workItemId: "research-1", parentSessionId: "lead-fault", agent: "junior-flash", prompt: "调研" }),
    (error) => error.code === "OPENCODE_API_ERROR" && /gateway overloaded/.test(error.message),
  )
  assert.deepEqual(events.map(({ eventType }) => eventType), ["platform.dispatch.failed"])
  const mapping = await adapter.readMapping("task-fault", "research-1")
  assert.equal(mapping.sessionId, "child-1")
  assert.match(mapping.dispatchError, /gateway overloaded/)
})

test("OpenCode session events audit retries, errors, and lost children exactly once", async () => {
  const projectRoot = await tempProject()
  const client = fakeClient()
  const events = []
  const runtimeExecutor = async (request) => {
    if (request.command === "event.record") events.push(request.input)
    return { exitCode: 0, envelope: { data: {} } }
  }
  const adapter = testAdapter(client, projectRoot, { runtimeExecutor })
  await adapter.spawn({ taskId: "task-events", workItemId: "check-1", parentSessionId: "lead-events", agent: "senior-terra", prompt: "审查" })
  events.length = 0

  await adapter.handleEvent({ type: "session.status", properties: { sessionID: "child-1", status: { type: "retry", attempt: 2, message: "rate limited" } } })
  await adapter.handleEvent({ type: "session.status", properties: { sessionID: "child-1", status: { type: "retry", attempt: 2, message: "rate limited" } } })
  await adapter.handleEvent({ type: "session.error", properties: { sessionID: "child-1", error: { name: "APIError", message: "upstream unavailable" } } })
  await adapter.handleEvent({ type: "session.error", properties: { sessionID: "child-1", error: { name: "APIError", message: "upstream unavailable" } } })
  await adapter.handleEvent({ type: "session.deleted", properties: { info: { id: "child-1" } } })
  await adapter.handleEvent({ type: "session.deleted", properties: { info: { id: "child-1" } } })
  await adapter.handleEvent({ type: "session.error", properties: { sessionID: "unrelated", error: { message: "ignore" } } })

  assert.deepEqual(events.map(({ eventType }) => eventType), [
    "platform.session.retry",
    "platform.session.error",
    "platform.session.lost",
  ])
  assert.ok((await adapter.readMapping("task-events", "check-1")).lostRecordedAt)
})

test("lost detection and resume serialize mapping updates without erasing the terminal marker", async () => {
  const projectRoot = await tempProject()
  const client = fakeClient()
  const events = []
  let releaseLost
  let announceLost
  const lostHeld = new Promise((resolve) => { releaseLost = resolve })
  const lostStarted = new Promise((resolve) => { announceLost = resolve })
  const runtimeExecutor = async (request) => {
    if (request.command === "event.record") {
      if (request.input.eventType === "platform.session.lost") {
        announceLost()
        await lostHeld
      }
      events.push(request.input)
    }
    return { exitCode: 0, envelope: { data: {} } }
  }
  const adapter = testAdapter(client, projectRoot, { runtimeExecutor })
  await adapter.spawn({ taskId: "task-race", workItemId: "impl-1", parentSessionId: "lead", agent: "junior-luna", prompt: "实现" })
  events.length = 0
  client.session.status = async () => ({ data: {} })
  client.session.get = async () => ({ error: { status: 404, data: { message: "not found" } } })

  const status = adapter.status({ taskId: "task-race", workItemId: "impl-1" })
  await lostStarted
  const resumed = assert.rejects(
    adapter.resume({ taskId: "task-race", workItemId: "impl-1", prompt: "继续" }),
    (error) => error.code === "SESSION_LOST",
  )
  releaseLost()
  assert.equal((await status).status.type, "lost")
  await resumed

  const mapping = await adapter.readMapping("task-race", "impl-1")
  assert.ok(mapping.lostRecordedAt)
  assert.deepEqual(events.map(({ eventType }) => eventType), ["platform.session.lost"])
  assert.equal(client.calls.filter(([name]) => name === "promptAsync").length, 1)
})

test("audit failures never turn a successful background dispatch into a failed operation", async () => {
  const projectRoot = await tempProject()
  const client = fakeClient()
  const adapter = testAdapter(client, projectRoot, {
    runtimeExecutor: async (request) => request.command === "event.record"
      ? { exitCode: 70, envelope: { code: "STATE_CORRUPT", message: "audit unavailable" } }
      : { exitCode: 0, envelope: { data: {} } },
  })
  const result = await adapter.spawn({ taskId: "task-audit-fail", workItemId: "impl-1", parentSessionId: "lead", agent: "junior-luna", prompt: "实现" })
  assert.equal(result.mode, "background")
  assert.equal(result.sessionId, "child-1")

  const plugin = await readFile(path.join(sourceRoot, "plugins/opencode/assets/team-work.js"), "utf8")
  assert.match(plugin, /event:\s*async/)
  assert.match(plugin, /adapter\.handleEvent/)
})

test("lost session state is authoritative even when its audit write fails and can be retried later", async () => {
  const projectRoot = await tempProject()
  const client = fakeClient()
  let auditFails = false
  const events = []
  const runtimeExecutor = async (request) => {
    if (request.command === "event.record") {
      if (auditFails) return { exitCode: 70, envelope: { code: "STATE_CORRUPT", message: "audit unavailable" } }
      events.push(request.input)
    }
    return { exitCode: 0, envelope: { data: {} } }
  }
  const adapter = testAdapter(client, projectRoot, { runtimeExecutor })
  await adapter.spawn({ taskId: "task-lost-audit", workItemId: "impl-1", parentSessionId: "lead", agent: "junior-luna", prompt: "实现" })
  events.length = 0
  client.session.status = async () => ({ data: {} })
  client.session.get = async () => ({ error: { status: 404, data: { message: "not found" } } })
  auditFails = true

  assert.equal((await adapter.status({ taskId: "task-lost-audit", workItemId: "impl-1" })).status.type, "lost")
  let mapping = await adapter.readMapping("task-lost-audit", "impl-1")
  assert.ok(mapping.lostRecordedAt)
  assert.ok(mapping.lostAuditError)
  await assert.rejects(
    adapter.resume({ taskId: "task-lost-audit", workItemId: "impl-1", prompt: "错误续派" }),
    (error) => error.code === "SESSION_LOST",
  )

  auditFails = false
  await adapter.status({ taskId: "task-lost-audit", workItemId: "impl-1" })
  mapping = await adapter.readMapping("task-lost-audit", "impl-1")
  assert.ok(mapping.lostAuditRecordedAt)
  assert.deepEqual(events.map(({ eventType }) => eventType), ["platform.session.lost"])
})

test("session error events remain auditable while a slow promptAsync resume is in flight", async () => {
  const projectRoot = await tempProject()
  const client = fakeClient()
  const events = []
  const runtimeExecutor = async (request) => {
    if (request.command === "event.record") events.push(request.input)
    return { exitCode: 0, envelope: { data: {} } }
  }
  const adapter = testAdapter(client, projectRoot, { runtimeExecutor })
  await adapter.spawn({ taskId: "task-slow-resume", workItemId: "impl-1", parentSessionId: "lead", agent: "junior-luna", prompt: "实现" })
  events.length = 0

  let announcePrompt
  let releasePrompt
  const promptStarted = new Promise((resolve) => { announcePrompt = resolve })
  const promptHeld = new Promise((resolve) => { releasePrompt = resolve })
  client.session.promptAsync = async (input) => {
    client.calls.push(["promptAsync", input])
    announcePrompt()
    await promptHeld
    return { data: undefined }
  }

  const resumed = adapter.resume({ taskId: "task-slow-resume", workItemId: "impl-1", prompt: "继续" })
  await promptStarted
  await adapter.handleEvent({ type: "session.error", properties: { sessionID: "child-1", error: { message: "gateway retrying" } } })
  assert.deepEqual(events.map(({ eventType }) => eventType), ["platform.session.error"])
  releasePrompt()
  assert.equal((await resumed).mode, "background")
  assert.deepEqual(events.map(({ eventType }) => eventType), ["platform.session.error", "platform.resume.accepted"])
})

test("mapping lock contention never masks the original gateway error", async () => {
  const projectRoot = await tempProject()
  const client = fakeClient()
  const lock = path.join(projectRoot, ".team-work/platform/opencode/sessions/task-lock-error/impl-1.json.lock")
  client.session.promptAsync = async () => {
    await writeFile(lock, `${JSON.stringify({ pid: process.pid })}\n`)
    throw new TypeError("gateway overloaded")
  }
  const adapter = testAdapter(client, projectRoot, {
    runtimeExecutor: async () => ({ exitCode: 0, envelope: { data: {} } }),
  })

  await assert.rejects(
    adapter.spawn({ taskId: "task-lock-error", workItemId: "impl-1", parentSessionId: "lead", agent: "junior-luna", prompt: "实现" }),
    (error) => error.code === "OPENCODE_API_ERROR"
      && /gateway overloaded/.test(error.message)
      && error.mappingPersistenceError?.code === "SESSION_MAPPING_LOCKED",
  )
  await rm(lock, { force: true })
})
