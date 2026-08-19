import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { createOpenCodeExecutionAdapter } from "../../../plugins/opencode/adapter/execution-adapter.mjs"
import { createExecutionAdapterPort, digestEffect } from "../../../runtime/index.mjs"

async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), "team-work-v2-opencode-"))
  await mkdir(path.join(root, ".team-work"), { recursive: true })
  await mkdir(path.join(root, "generated"), { recursive: true })
  await writeFile(path.join(root, "generated", "context.md"), "Owner context")
  await writeFile(path.join(root, "generated", "prompt.md"), "Implement the assigned work")
  return root
}

function profile() {
  return {
    agents: [
      { id: "junior-luna", tier: "junior", resolvedModel: "gateway/luna", costWeight: 1, capabilities: ["*"] },
      { id: "senior-terra", tier: "senior", resolvedModel: "gateway/terra", effort: "max", costWeight: 10, capabilities: ["*"] },
      { id: "expert-opus", tier: "expert", resolvedModel: "gateway/opus", costWeight: 50, capabilities: ["*"] },
    ],
  }
}

function fakeClient() {
  const sessions = new Map()
  const messages = new Map()
  const statuses = {}
  const todos = new Map()
  const calls = { create: 0, prompt: 0, abort: 0 }
  let sequence = 0

  function missing() {
    return { error: { status: 404, message: "missing" } }
  }

  const session = {
    async create({ body }) {
      calls.create += 1
      sequence += 1
      const value = {
        id: `ses_${sequence}`,
        parentID: body.parentID,
        title: body.title,
        directory: "/project",
        projectID: "project",
        version: "test",
        time: { created: 1_000 + sequence, updated: 1_000 + sequence },
      }
      sessions.set(value.id, value)
      messages.set(value.id, [])
      statuses[value.id] = { type: "idle" }
      return { data: value }
    },
    async list() { return { data: [...sessions.values()] } },
    async get({ path: input }) { return sessions.has(input.id) ? { data: sessions.get(input.id) } : missing() },
    async status() { return { data: structuredClone(statuses) } },
    async messages({ path: input }) { return sessions.has(input.id) ? { data: structuredClone(messages.get(input.id) ?? []) } : missing() },
    async promptAsync({ path: input, body }) {
      calls.prompt += 1
      const created = 2_000 + calls.prompt
      messages.get(input.id).push({
        info: { id: `msg_prompt_${calls.prompt}`, role: "user", time: { created } },
        parts: structuredClone(body.parts),
      })
      statuses[input.id] = { type: "busy" }
      return { data: true }
    },
    async abort({ path: input }) {
      calls.abort += 1
      if (!sessions.has(input.id)) return missing()
      statuses[input.id] = { type: "idle" }
      return { data: true }
    },
    async todo({ path: input }) { return { data: structuredClone(todos.get(input.id) ?? []) } },
  }

  function addHostSession(id = "lead_1") {
    sessions.set(id, { id, title: "Lead", directory: "/project", projectID: "project", version: "test", time: { created: 100, updated: 100 } })
    messages.set(id, [])
    statuses[id] = { type: "idle" }
    return id
  }

  function addUserMessage(sessionId, { id, created, text }) {
    messages.get(sessionId).push({ info: { id, role: "user", time: { created } }, parts: [{ type: "text", text }] })
  }

  return { client: { session }, sessions, messages, statuses, todos, calls, addHostSession, addUserMessage }
}

async function configuredAdapter(options = {}) {
  const projectRoot = options.projectRoot ?? await project()
  const sdk = options.sdk ?? fakeClient()
  const hostSessionRef = sdk.addHostSession(options.hostSessionRef)
  const adapter = createOpenCodeExecutionAdapter({
    client: sdk.client,
    projectRoot,
    platformProfile: profile(),
    clock: () => new Date("2026-08-19T10:00:00.000Z"),
    faultInjector: options.faultInjector,
  })
  const port = createExecutionAdapterPort(adapter)
  const binding = await port.bindLead({ taskId: "task-1", platform: "opencode", hostSessionRef })
  const capabilities = await port.capabilities()
  return { projectRoot, sdk, adapter, port, binding, capabilities }
}

function effect(capabilities, overrides = {}) {
  const value = {
    operationId: "dispatch-1",
    effectDigest: "0".repeat(64),
    taskId: "task-1",
    stageRunId: "stage-run-1",
    assignmentId: "owner-1",
    attempt: 1,
    role: "owner",
    assignmentKind: "implementation",
    agentId: "junior-luna",
    capabilitySnapshotDigest: capabilities.digest,
    mode: "background",
    contextRef: "generated/context.md",
    promptRef: "generated/prompt.md",
    ...overrides,
  }
  value.effectDigest = digestEffect(value)
  return value
}

test("OpenCode Execution Adapter exposes the pinned Agent catalog and dispatches only promptAsync child sessions", async () => {
  const { sdk, port, capabilities } = await configuredAdapter()
  assert.deepEqual(capabilities.agents.map(({ agentId, costWeight }) => [agentId, costWeight]), [
    ["junior-luna", 1],
    ["senior-terra", 10],
    ["expert-opus", 50],
  ])
  assert.equal(capabilities.agents[1].effort, "max")
  assert.equal(capabilities.features.background, true)
  assert.equal(capabilities.features.humanDecisionProof, "verified-event")

  const intent = effect(capabilities)
  const [first, duplicate] = await Promise.all([port.ensureExecution(intent), port.ensureExecution(intent)])
  assert.equal(first.status, "confirmed")
  assert.deepEqual(duplicate, first)
  assert.equal(sdk.calls.create, 1)
  assert.equal(sdk.calls.prompt, 1)
  assert.match(sdk.messages.get(first.executionRef)[0].parts[0].text, /Owner context[\s\S]*Implement the assigned work/)
})

test("a new operation resumes the same OpenCode session without exposing session choice to Lead", async () => {
  const { sdk, port, capabilities } = await configuredAdapter()
  const first = await port.ensureExecution(effect(capabilities))
  const resumedIntent = effect(capabilities, {
    operationId: "continue-2",
    resumeExecutionRef: first.executionRef,
  })
  resumedIntent.effectDigest = digestEffect(resumedIntent)
  const resumed = await port.ensureExecution(resumedIntent)
  assert.equal(resumed.status, "confirmed")
  assert.equal(resumed.executionRef, first.executionRef)
  assert.equal(sdk.calls.create, 1)
  assert.equal(sdk.calls.prompt, 2)
})

test("inspect recovers a prompt accepted before its receipt was persisted without dispatching twice", async () => {
  const projectRoot = await project()
  const sdk = fakeClient()
  let crash = true
  const setup = await configuredAdapter({
    projectRoot,
    sdk,
    faultInjector: { afterPromptAccepted: async () => { if (crash) { crash = false; throw new Error("simulated receipt loss") } } },
  })
  const intent = effect(setup.capabilities)
  const interrupted = await setup.port.ensureExecution(intent)
  assert.equal(interrupted.status, "in-doubt")
  assert.equal(sdk.calls.prompt, 1)

  const restarted = createExecutionAdapterPort(createOpenCodeExecutionAdapter({
    client: sdk.client,
    projectRoot,
    platformProfile: profile(),
    clock: () => new Date("2026-08-19T10:01:00.000Z"),
  }))
  const recovered = await restarted.inspectExecution(intent)
  assert.equal(recovered.status, "confirmed")
  assert.equal(sdk.calls.prompt, 1)
})

test("inspect finds an orphan session by operation title and retry uses it instead of creating another", async () => {
  const projectRoot = await project()
  const sdk = fakeClient()
  let crash = true
  const setup = await configuredAdapter({
    projectRoot,
    sdk,
    faultInjector: { afterSessionCreate: async () => { if (crash) { crash = false; throw new Error("simulated create receipt loss") } } },
  })
  const intent = effect(setup.capabilities)
  const interrupted = await setup.port.ensureExecution(intent)
  assert.equal(interrupted.status, "in-doubt")
  const inspected = await setup.port.inspectExecution(intent)
  assert.equal(inspected.status, "failed")
  assert.equal(inspected.error.retryable, true)
  const retried = await setup.port.ensureExecution(intent)
  assert.equal(retried.status, "confirmed")
  assert.equal(sdk.calls.create, 1)
  assert.equal(sdk.calls.prompt, 1)
})

test("OpenCode events and check receipts are normalized directly into PlatformObservationSink", async () => {
  const { sdk, adapter, port, capabilities } = await configuredAdapter()
  const observations = []
  adapter.attachRuntime({ observationSinkFor: () => ({ observe: async (value) => { observations.push(value); return { observationId: "obs", sequence: observations.length, duplicate: false } } }) })
  const receipt = await port.ensureExecution(effect(capabilities))
  assert.equal(await adapter.handleEvent({ type: "session.idle", properties: { sessionID: receipt.executionRef } }), true)
  assert.equal(observations.length, 0, "a stale idle event must not override the current busy status")
  sdk.statuses[receipt.executionRef] = { type: "idle" }
  assert.equal(await adapter.handleEvent({ type: "session.idle", properties: { sessionID: receipt.executionRef } }), true)
  await adapter.recordCheck({ sessionId: receipt.executionRef, toolCallRef: "tool-1", commandSummary: "npm test", exitCode: 0, outputRef: ".team-work/checks/tool-1.txt" })
  assert.equal(observations[0].kind, "execution")
  assert.equal(observations[0].state, "idle")
  assert.equal(observations[1].kind, "check")
  assert.equal(observations[1].result, "pass")
  assert.equal(observations[1].commandSummary, "npm test")
})

test("a deleted managed child session becomes one durable lost observation without adopting partial output", async () => {
  const { adapter, port, capabilities } = await configuredAdapter()
  const observations = []
  adapter.attachRuntime({ observationSinkFor: () => ({ observe: async (value) => {
    observations.push(value)
    return { observationId: "lost-observation", sequence: 1, duplicate: observations.length > 1 }
  } }) })
  const receipt = await port.ensureExecution(effect(capabilities))
  const event = { type: "session.deleted", properties: { info: { id: receipt.executionRef } } }
  assert.equal(await adapter.handleEvent(event), true)
  assert.equal(await adapter.handleEvent(event), true)
  assert.equal(observations[0].state, "lost")
  assert.equal(observations[0].executionRef, receipt.executionRef)
  assert.equal(observations[0].dedupeKey, observations[1].dedupeKey)
})

test("quiesce inspection reconstructs a confirmed static wait after its receipt was lost", async () => {
  const projectRoot = await project()
  const sdk = fakeClient()
  let crash = true
  const setup = await configuredAdapter({
    projectRoot,
    sdk,
    faultInjector: { afterQuiesceObserved: async () => { if (crash) { crash = false; throw new Error("simulated quiesce receipt loss") } } },
  })
  const execution = await setup.port.ensureExecution(effect(setup.capabilities))
  sdk.statuses[execution.executionRef] = { type: "idle" }
  const intent = {
    operationId: "quiesce-lost",
    effectDigest: "z".repeat(64),
    taskId: "task-1",
    decisionId: "design-approval",
    leadBindingRef: setup.binding.bindingRef,
    executionRefs: [execution.executionRef],
    clearHostContinuations: true,
  }
  await assert.rejects(setup.port.quiesce(intent), /simulated quiesce receipt loss/)
  const restarted = createExecutionAdapterPort(createOpenCodeExecutionAdapter({ client: sdk.client, projectRoot, platformProfile: profile() }))
  const recovered = await restarted.inspectQuiesce(intent)
  assert.equal(recovered.status, "confirmed")
  assert.equal(recovered.hostContinuationsCleared, true)
})

test("quiesce binds a verified user decision to a message newer than the captured host cursor", async () => {
  const { sdk, port, binding, capabilities } = await configuredAdapter()
  const execution = await port.ensureExecution(effect(capabilities))
  sdk.statuses[execution.executionRef] = { type: "idle" }
  sdk.addUserMessage(binding.hostSessionRef, { id: "old-user", created: Date.parse("2026-08-19T09:59:00.000Z"), text: "start" })
  const quiesceIntent = {
    operationId: "quiesce-1",
    effectDigest: "q".repeat(64),
    taskId: "task-1",
    decisionId: "design-approval",
    leadBindingRef: binding.bindingRef,
    executionRefs: [execution.executionRef],
    clearHostContinuations: true,
  }
  const quiet = await port.quiesce(quiesceIntent)
  assert.equal(quiet.status, "confirmed")
  assert.equal(quiet.hostContinuationsCleared, true)
  assert.ok(quiet.hostCursor)

  sdk.addUserMessage(binding.hostSessionRef, { id: "new-user", created: Date.parse("2026-08-19T10:02:00.000Z"), text: "同意，accept" })
  const decision = await port.verifyHumanDecision({
    decisionId: "design-approval",
    leadBindingRef: binding.bindingRef,
    issuedAt: "2026-08-19T10:01:00.000Z",
    afterHostCursor: quiet.hostCursor,
    choices: ["accept", "rework"],
  })
  assert.equal(decision.choice, "accept")
  assert.equal(decision.proof.mode, "verified-event")
  assert.equal(decision.proof.messageId, "new-user")
})

test("stop inspection recovers an abort whose receipt is no longer needed to prove quiescence", async () => {
  const { sdk, port, capabilities } = await configuredAdapter()
  const execution = await port.ensureExecution(effect(capabilities))
  const intent = { operationId: "stop-1", effectDigest: "s".repeat(64), executionRef: execution.executionRef, reason: "cancel task" }
  const stopped = await port.stopExecution(intent)
  assert.equal(stopped.status, "confirmed")
  assert.equal(sdk.calls.abort, 1)
  const inspected = await port.inspectStop(intent)
  assert.deepEqual(inspected, stopped)
  assert.equal(sdk.calls.abort, 1)
})
