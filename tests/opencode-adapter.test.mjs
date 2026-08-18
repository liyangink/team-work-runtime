import assert from "node:assert/strict"
import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  createOpenCodeAdapter,
  resolveOpenCodeProjectRoot,
  withRuntimeRemediation,
} from "../plugins/opencode/src/opencode-adapter.mjs"
import { createLeadController } from "../plugins/opencode/src/lead-controller.mjs"
import { executeRuntime } from "../runtime/core.mjs"

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
      async todo(input) {
        calls.push(["todo", input])
        return { data: [] }
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

async function fakeOpenSpec(platformRoot) {
  const command = path.join(platformRoot, "openspec-test.mjs")
  await writeFile(command, `#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
const args = process.argv.slice(2)
const root = process.cwd()
const changes = path.join(root, "openspec/changes")
const activeNames = () => fs.existsSync(changes) ? fs.readdirSync(changes).filter((name) => name !== "archive" && fs.statSync(path.join(changes, name)).isDirectory()) : []
if (args[0] === "--version") { console.log("OpenSpec 1.3.1"); process.exit(0) }
if (args[0] === "list") { console.log(JSON.stringify({ changes: activeNames().map((name) => ({ name })) })); process.exit(0) }
if (args[0] === "new" && args[1] === "change") {
  const name = args[2]; const target = path.join(changes, name)
  if (fs.existsSync(target)) process.exit(1)
  fs.mkdirSync(target, { recursive: true }); fs.writeFileSync(path.join(target, ".openspec.yaml"), "schema: spec-driven\\n")
  console.log("created"); process.exit(0)
}
const changeIndex = args.indexOf("--change")
const name = changeIndex >= 0 ? args[changeIndex + 1] : args.find((value, index) => index > 0 && !value.startsWith("-"))
const target = name ? path.join(changes, name) : null
const state = () => {
  const proposal = fs.existsSync(path.join(target, "proposal.md"))
  const design = fs.existsSync(path.join(target, "design.md"))
  const specsRoot = path.join(target, "specs")
  const specs = fs.existsSync(specsRoot) && fs.readdirSync(specsRoot, { recursive: true }).some((entry) => String(entry).endsWith(".md"))
  const tasks = fs.existsSync(path.join(target, "tasks.md"))
  const status = (done, ready) => done ? "done" : ready ? "ready" : "blocked"
  return { changeName: name, schemaName: "spec-driven", isComplete: proposal && design && specs && tasks, artifacts: [
    { id: "proposal", outputPath: "proposal.md", status: status(proposal, true) },
    { id: "design", outputPath: "design.md", status: status(design, proposal) },
    { id: "specs", outputPath: "specs/**/*.md", status: status(specs, proposal) },
    { id: "tasks", outputPath: "tasks.md", status: status(tasks, design && specs) },
  ] }
}
if (args[0] === "status") { console.log(JSON.stringify(state())); process.exit(0) }
if (args[0] === "instructions") {
  const id = args[1]; const output = { proposal: "proposal.md", design: "design.md", specs: "specs/**/*.md", tasks: "tasks.md" }[id]
  console.log(JSON.stringify({ changeName: name, artifactId: id, outputPath: output, instruction: "Follow OpenSpec " + id + " instructions", template: "# " + id }))
  process.exit(0)
}
if (args[0] === "validate") { console.log(JSON.stringify({ valid: state().isComplete })); process.exit(state().isComplete ? 0 : 1) }
if (args[0] === "archive") {
  const archiveName = "2026-08-18-" + args[1]
  fs.mkdirSync(path.join(changes, "archive"), { recursive: true })
  fs.renameSync(path.join(changes, args[1]), path.join(changes, "archive", archiveName))
  console.log("archived"); process.exit(0)
}
process.exit(2)
`)
  await chmod(command, 0o755)
  return command
}

test("Runtime failures tell Lead the next typed action instead of inviting source inspection", () => {
  const result = withRuntimeRemediation({
    exitCode: 4,
    envelope: {
      ok: false,
      error: {
        code: "TASK_NOT_FOUND",
        message: "work item does not exist: revise-1",
        retryable: false,
        blockers: [],
        remediation: [],
      },
    },
  }, { command: "work.start", input: { taskId: "task-1", workItemId: "revise-1" } })

  assert.match(result.envelope.error.remediation.join("\n"), /team_work_dispatch/)
  assert.match(result.envelope.error.remediation.join("\n"), /不要重复|不得重复/)
})

test("non-VCS OpenCode projects use directory instead of filesystem-root worktree", () => {
  assert.equal(resolveOpenCodeProjectRoot({ directory: "/tmp/project", worktree: "/" }), path.resolve("/tmp/project"))
  assert.equal(resolveOpenCodeProjectRoot({ directory: "/repo/subdir", worktree: "/repo" }), path.resolve("/repo"))
})

test("human gate decisions require an explicit user message after the review request", async () => {
  const projectRoot = await tempProject()
  const client = fakeClient()
  client.session.messages = async () => ({ data: [{
    info: { id: "user-decision-1", role: "user", time: { created: 2_000 } },
    parts: [{ type: "text", text: "我确认批准当前方案，可以继续。" }],
  }] })
  const adapter = testAdapter(client, projectRoot)
  assert.equal((await adapter.assertUserDecision({ sessionId: "lead-1", action: "approve", requestedAt: new Date(1_000).toISOString() })).messageId, "user-decision-1")
  await assert.rejects(
    adapter.assertUserDecision({ sessionId: "lead-1", action: "reject", requestedAt: new Date(1_000).toISOString() }),
    (error) => error.code === "EXPLICIT_USER_DECISION_REQUIRED",
  )
  await assert.rejects(
    adapter.assertUserDecision({ sessionId: "lead-1", action: "approve", requestedAt: new Date(3_000).toISOString() }),
    (error) => error.code === "EXPLICIT_USER_DECISION_REQUIRED",
  )

  client.session.messages = async () => ({ data: [{
    info: { id: "user-rejection-1", role: "user", time: { created: 4_000 } },
    parts: [{ type: "text", text: "我不批准当前方案，不要继续。" }],
  }] })
  assert.equal((await adapter.assertUserDecision({ sessionId: "lead-1", action: "reject", requestedAt: new Date(3_000).toISOString() })).messageId, "user-rejection-1")
  await assert.rejects(
    adapter.assertUserDecision({ sessionId: "lead-1", action: "approve", requestedAt: new Date(3_000).toISOString() }),
    (error) => error.code === "EXPLICIT_USER_DECISION_REQUIRED",
  )
})

test("first Runtime tool call lazily initializes project state from the global platform installation", async () => {
  const projectRoot = await tempProject()
  const platformRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-platform-"))
  await mkdir(path.join(platformRoot, "guides"), { recursive: true })
  await writeFile(path.join(platformRoot, "profile.json"), `${JSON.stringify({ agents: [], guides: [".team-work/platform/opencode/guides/team-work.md"] })}\n`)
  await writeFile(path.join(platformRoot, "guides/team-work.md"), "# OpenCode guide\n")
  const adapter = createOpenCodeAdapter({
    client: fakeClient(),
    projectRoot,
    platformRoot,
    runtimeExecutor: (request) => executeRuntime({ ...request, projectRoot }),
  })

  const result = await adapter.runtime({ command: "doctor", input: {} })

  assert.equal(result.exitCode, 0)
  await assert.doesNotReject(access(path.join(projectRoot, ".team-work/config.yaml")))
  assert.equal(JSON.parse(await readFile(path.join(projectRoot, ".team-work/config.yaml"), "utf8")).spec.status, "missing")
  assert.equal(JSON.parse(await readFile(path.join(projectRoot, ".team-work/config.yaml"), "utf8")).spec.mode, "auto")
  assert.deepEqual(JSON.parse(await readFile(path.join(projectRoot, ".team-work/platform/opencode/profile.json"), "utf8")), {
    agents: [],
    guides: [".team-work/platform/opencode/guides/team-work.md"],
  })
  assert.equal(await readFile(path.join(projectRoot, ".team-work/platform/opencode/guides/team-work.md"), "utf8"), "# OpenCode guide\n")
})

test("Lead intent controller dispatches, resumes, and accepts without exposing Runtime revisions", async () => {
  const projectRoot = await tempProject()
  const platformRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-platform-"))
  const profile = {
    agents: [
      { id: "junior-luna", resolvedModel: "gateway/luna" },
      { id: "senior-terra", resolvedModel: "gateway/terra" },
    ],
    helpers: [],
    guides: [],
  }
  await mkdir(path.join(platformRoot, "guides"), { recursive: true })
  const client = fakeClient()
  let childNumber = 0
  client.session.create = async (input) => {
    childNumber += 1
    const child = { id: `child-${childNumber}`, parentID: input.body.parentID, title: input.body.title }
    client.calls.push(["create", input])
    return { data: child }
  }
  const adapter = createOpenCodeAdapter({
    client,
    projectRoot,
    platformRoot,
    platformProfile: profile,
    runtimeExecutor: (request) => executeRuntime({ ...request, projectRoot }),
  })
  const lead = createLeadController({ adapter, id: () => "proof0001" })

  const beginInput = {
    taskId: "intent-flow", title: "Intent flow", entryStage: "implementation",
    mode: "solo", reason: "one owner is enough", sessionId: "lead-intent",
  }
  await lead.begin(beginInput)
  const resumedBegin = await lead.begin(beginInput)
  assert.equal(resumedBegin.task.taskId, "intent-flow")
  assert.equal(resumedBegin.binding.existing, true)
  const assignment = {
    taskId: "intent-flow", workItemId: "implementation-owner", owner: "junior-luna",
    scope: "Implement the requested change", doneWhen: ["delivery exists"],
    artifactPaths: [".team-work/tasks/intent-flow/artifacts/delivery.md"], dependencies: [],
    contextProfile: "implement", prompt: "Implement and report evidence", sessionId: "lead-intent",
  }
  const first = await lead.dispatch(assignment)
  assert.equal(first.dispatch.mode, "background")
  assert.equal(first.workItem.status, "running")
  assert.equal(client.calls.filter(([name]) => name === "create").length, 1)

  const resumed = await lead.dispatch({ ...assignment, prompt: "Continue the same work item" })
  assert.equal(resumed.dispatch.sessionId, first.dispatch.sessionId)
  assert.equal(client.calls.filter(([name]) => name === "create").length, 1)
  assert.equal(client.calls.filter(([name]) => name === "promptAsync").length, 2)

  await adapter.handleEvent({ type: "session.deleted", properties: { sessionID: first.dispatch.sessionId } })
  const replaced = await lead.dispatch({ ...assignment, prompt: "Recover the lost member session" })
  assert.equal(replaced.dispatch.sessionId, "child-2")
  assert.equal(client.calls.filter(([name]) => name === "create").length, 2)

  const evidencePath = ".team-work/tasks/intent-flow/artifacts/delivery.md"
  await writeFile(path.join(projectRoot, evidencePath), "implemented and verified\n")
  await assert.rejects(lead.assess({
    taskId: "intent-flow", workItemId: "implementation-owner", decision: "accept",
    reviewer: "junior-luna", reason: "self review", scenario: "implementation",
    scopeRefs: ["src"], artifactPaths: [evidencePath], evidencePath, summary: "self review",
  }), (error) => error.code === "REVIEWER_ROLE_REQUIRED")
  const accepted = await lead.assess({
    taskId: "intent-flow", workItemId: "implementation-owner", decision: "accept",
    reviewer: "senior-terra", reason: "independent review passed", scenario: "implementation",
    scopeRefs: ["src"], artifactPaths: [evidencePath], evidencePath,
    summary: "Implementation and evidence checked",
  })
  assert.equal(accepted.workItem.status, "accepted")
  assert.equal(accepted.evidence.evidenceId, "implementation-owner-accept-proof0001")
})

test("Lead rollback intent forwards only currently valid gate evidence", async () => {
  const calls = []
  const task = {
    taskId: "rollback-intent",
    stage: "code-review",
    revision: 8,
    gates: [
      { gateId: "old-review", evidenceRefs: ["old-proof"] },
      { gateId: "current-review", evidenceRefs: ["current-proof", "current-proof"] },
    ],
    evidence: [
      { evidenceId: "old-proof", status: "invalidated" },
      { evidenceId: "current-proof", status: "valid" },
    ],
  }
  const lead = createLeadController({
    adapter: {
      async runtime(request) {
        calls.push(request)
        return request.command === "task.show"
          ? { exitCode: 0, envelope: { ok: true, data: { task } } }
          : { exitCode: 0, envelope: { ok: true, data: { task } } }
      },
    },
  })

  await lead.progress({
    taskId: task.taskId,
    result: "needs_rework",
    returnTo: "implementation",
    reason: "current review found a defect",
  })
  assert.deepEqual(calls.at(-1), {
    command: "flow.rollback",
    input: {
      taskId: "rollback-intent",
      to: "implementation",
      reason: "current review found a defect",
      evidenceRefs: ["current-proof"],
      expectedRevision: 8,
    },
  })
})

test("human review request refuses to wait while the Lead has unfinished external todos", async () => {
  const calls = []
  const blocker = Object.assign(new Error("unfinished external todos"), { code: "EXTERNAL_TODO_BLOCKS_HUMAN_WAIT" })
  const lead = createLeadController({
    adapter: {
      async runtime(request) {
        calls.push(request)
        return {
          exitCode: 0,
          envelope: { ok: true, data: { task: { taskId: "human-wait", status: "active", revision: 4 } } },
        }
      },
      async assertNoPendingExternalTodos() {
        throw blocker
      },
    },
  })

  await assert.rejects(lead.userReview({
    taskId: "human-wait",
    action: "request",
    gateId: "design-approval",
    evidencePath: "docs/design.md",
    reason: "request approval",
    question: "是否批准？",
    blocker: "等待用户决定",
    requiredDecision: "批准或驳回",
    sessionId: "lead-await",
  }), (error) => error.code === "EXTERNAL_TODO_BLOCKS_HUMAN_WAIT")
  assert.deepEqual(calls.map(({ command }) => command), ["task.show"])
})

test("member synchronization is disabled while waiting for a user decision", async () => {
  let waited = false
  const lead = createLeadController({
    adapter: {
      async runtime() {
        return {
          exitCode: 0,
          envelope: { ok: true, data: { task: { taskId: "human-wait", status: "awaiting-user", revision: 5 } } },
        }
      },
      async wait() {
        waited = true
        return { outcome: "timeout", items: [] }
      },
    },
  })

  await assert.rejects(lead.sync({
    taskId: "human-wait",
    workItemIds: ["review-1"],
    timeoutMs: 10_000,
    sessionId: "lead-await",
  }), (error) => error.code === "HUMAN_DECISION_PENDING")
  assert.equal(waited, false)
})

test("human review infers its declared gate and repairs a legacy gate-less wait", async () => {
  const projectRoot = await tempProject()
  const evidencePath = "design.md"
  await writeFile(path.join(projectRoot, evidencePath), "approved design\n")
  const runtimeExecutor = (request) => executeRuntime({ ...request, projectRoot })
  assert.equal((await runtimeExecutor({ command: "init", input: {} })).exitCode, 0)
  assert.equal((await runtimeExecutor({
    command: "task.create",
    input: { taskId: "inferred-gate", entryStage: "design-review" },
  })).exitCode, 0)

  const client = fakeClient()
  client.session.messages = async () => ({ data: [{
    info: { id: "explicit-approval", role: "user", time: { created: 9_000_000_000_000 } },
    parts: [{ type: "text", text: "批准，继续推进。" }],
  }] })
  const platformRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-platform-"))
  await mkdir(path.join(platformRoot, "guides"), { recursive: true })
  await writeFile(path.join(platformRoot, "profile.json"), `${JSON.stringify({ agents: [], helpers: [], guides: [] })}\n`)
  const adapter = testAdapter(client, projectRoot, { runtimeExecutor, platformRoot })
  const lead = createLeadController({ adapter, id: () => "humanproof" })

  const requested = await lead.userReview({
    taskId: "inferred-gate",
    action: "request",
    evidencePath,
    reason: "request design approval",
    question: "是否批准？",
    blocker: "等待用户批准",
    requiredDecision: "批准或驳回",
    sessionId: "lead-inferred",
  })
  assert.equal(requested.task.awaitingUser.gateRef, "design-approval")

  assert.equal((await runtimeExecutor({
    command: "task.create",
    input: { taskId: "legacy-gateless", entryStage: "design-review" },
  })).exitCode, 0)
  const malformed = await runtimeExecutor({
    command: "task.await",
    input: {
      taskId: "legacy-gateless",
      question: "是否批准？",
      blocker: "等待用户批准",
      requiredDecision: "批准或驳回",
      expectedRevision: 0,
    },
  })
  assert.equal(malformed.envelope.data.task.awaitingUser.gateRef, undefined)

  const repaired = await lead.userReview({
    taskId: "legacy-gateless",
    action: "approve",
    evidencePath,
    reason: "user approved the design",
    sessionId: "lead-legacy",
  })
  assert.equal(repaired.gate.gateId, "design-approval")
  assert.equal(repaired.gate.status, "passed")
  assert.equal(repaired.task.status, "active")
})

test("one continue intent requests, resolves, and advances a human checkpoint", async () => {
  const projectRoot = await tempProject()
  await writeFile(path.join(projectRoot, "design.md"), "approved design\n")
  const runtimeExecutor = (request) => executeRuntime({ ...request, projectRoot })
  assert.equal((await runtimeExecutor({ command: "init", input: {} })).exitCode, 0)
  assert.equal((await runtimeExecutor({ command: "task.create", input: { taskId: "continue-human", entryStage: "design-review" } })).exitCode, 0)
  assert.equal((await runtimeExecutor({
    command: "context.register",
    input: { taskId: "continue-human", contextId: "design", path: "design.md", kind: "design", profiles: ["lead", "check"], expectedRevision: 0 },
  })).exitCode, 0)
  const client = fakeClient()
  client.session.messages = async () => ({ data: [{
    info: { id: "continue-approval", role: "user", time: { created: 9_000_000_000_000 } },
    parts: [{ type: "text", text: "批准，继续推进。" }],
  }] })
  const platformRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-platform-"))
  await mkdir(path.join(platformRoot, "guides"), { recursive: true })
  await writeFile(path.join(platformRoot, "profile.json"), `${JSON.stringify({ agents: [], helpers: [], guides: [] })}\n`)
  const adapter = testAdapter(client, projectRoot, { runtimeExecutor, platformRoot })
  const lead = createLeadController({ adapter, id: () => "continueproof" })

  const requested = await lead.continueFlow({ taskId: "continue-human", artifactPath: "design.md", sessionId: "lead-continue" })
  assert.equal(requested.state, "awaiting-user")
  assert.match(requested.report, /等待用户审核/)

  const advanced = await lead.continueFlow({ taskId: "continue-human", sessionId: "lead-continue" })
  assert.equal(advanced.stage, "implementation")
  assert.equal(advanced.state, "active")
  assert.match(advanced.report, /批准已记录/)
  const task = (await runtimeExecutor({ command: "task.show", input: { taskId: "continue-human" } })).envelope.data.task
  assert.equal(task.gates.find(({ gateId }) => gateId === "design-approval").status, "passed")
})

test("lazy initialization preserves nested Runtime error details", async () => {
  const projectRoot = await tempProject()
  const platformRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-platform-"))
  const adapter = createOpenCodeAdapter({
    client: fakeClient(),
    projectRoot,
    platformRoot,
    runtimeExecutor: async () => ({
      exitCode: 4,
      envelope: {
        ok: false,
        error: {
          code: "STATE_CORRUPT",
          message: "broken runtime state",
          retryable: false,
          blockers: [{ code: "BROKEN" }],
          remediation: ["run doctor"],
        },
      },
    }),
  })

  await assert.rejects(adapter.runtime({ command: "doctor", input: {} }), (error) => (
    error.code === "STATE_CORRUPT"
      && error.message === "init 失败：broken runtime state"
      && error.remediation.includes("run doctor")
  ))
})

test("lazy project initialization promotes an initialized OpenSpec route using the user-level command", async () => {
  const projectRoot = await tempProject()
  const platformRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-platform-"))
  const openspec = path.join(platformRoot, "openspec-test")
  await mkdir(path.join(platformRoot, "guides"), { recursive: true })
  await writeFile(path.join(platformRoot, "profile.json"), `${JSON.stringify({ agents: [], guides: [] })}\n`)
  await writeFile(path.join(platformRoot, "settings.json"), `${JSON.stringify({ spec: { provider: "openspec", mode: "required", command: openspec } })}\n`)
  await writeFile(openspec, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'OpenSpec 2.0.0'; else echo '{\"changes\":[]}'; fi\n")
  await chmod(openspec, 0o755)
  const adapter = createOpenCodeAdapter({
    client: fakeClient(),
    projectRoot,
    platformRoot,
    runtimeExecutor: (request) => executeRuntime({ ...request, projectRoot }),
  })

  await adapter.runtime({ command: "doctor", input: {} })

  const config = JSON.parse(await readFile(path.join(projectRoot, ".team-work/config.yaml"), "utf8"))
  assert.equal(config.spec.status, "ready")
  assert.equal(config.spec.mode, "required")
})

test("workflow advancement refreshes SPEC readiness without a separate doctor call", async () => {
  const projectRoot = await tempProject()
  const platformRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-platform-"))
  const openspec = path.join(platformRoot, "openspec-test")
  await mkdir(path.join(platformRoot, "guides"), { recursive: true })
  await writeFile(path.join(platformRoot, "profile.json"), `${JSON.stringify({ agents: [], guides: [] })}\n`)
  await writeFile(path.join(platformRoot, "settings.json"), `${JSON.stringify({ spec: { provider: "openspec", mode: "auto", command: openspec } })}\n`)
  await writeFile(openspec, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'OpenSpec 2.0.0'; else echo '{\"changes\":[]}'; fi\n")
  await chmod(openspec, 0o755)
  const adapter = createOpenCodeAdapter({
    client: fakeClient(),
    projectRoot,
    platformRoot,
    runtimeExecutor: (request) => executeRuntime({ ...request, projectRoot }),
  })
  await adapter.runtime({ command: "doctor", input: {} })
  const configPath = path.join(projectRoot, ".team-work/config.yaml")
  const config = JSON.parse(await readFile(configPath, "utf8"))
  config.spec.status = "missing"
  config.humanReview["design-approval"] = "disabled"
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
  await writeFile(path.join(projectRoot, "design.md"), "approved design\n")
  await adapter.runtime({ command: "task.create", input: { taskId: "auto-spec-refresh", entryStage: "design-review" } })
  await adapter.runtime({
    command: "context.register",
    input: { taskId: "auto-spec-refresh", contextId: "design", path: "design.md", kind: "design", profiles: ["lead", "check"], expectedRevision: 0 },
  })

  const advanced = await adapter.runtime({
    command: "flow.advance",
    input: { taskId: "auto-spec-refresh", outcome: "pass", expectedRevision: 1 },
  })

  assert.equal(advanced.envelope.data.to, "spec")
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).spec.status, "ready")
})

test("Lead enters SPEC through a managed OpenSpec change and injects provider instructions into member work", async () => {
  const projectRoot = await tempProject()
  const platformRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-platform-"))
  await mkdir(path.join(platformRoot, "guides"), { recursive: true })
  const command = await fakeOpenSpec(platformRoot)
  const profile = { agents: [{ id: "junior-luna", resolvedModel: "gateway/luna" }], helpers: [], guides: [] }
  await writeFile(path.join(platformRoot, "settings.json"), `${JSON.stringify({ spec: { provider: "openspec", mode: "required", command } })}\n`)
  const client = fakeClient()
  const adapter = createOpenCodeAdapter({
    client, projectRoot, platformRoot, platformProfile: profile,
    runtimeExecutor: (request) => executeRuntime({ ...request, projectRoot }),
  })
  const lead = createLeadController({ adapter })
  const historicalArchive = path.join(projectRoot, "openspec/changes/archive/2026-08-01-managed-spec")
  await mkdir(historicalArchive, { recursive: true })
  await writeFile(path.join(historicalArchive, "proposal.md"), "historical proposal\n")

  const begun = await lead.begin({
    taskId: "managed-spec", title: "Managed SPEC", entryStage: "spec",
    mode: "solo", reason: "single SPEC owner", sessionId: "lead-spec",
  })
  assert.equal(begun.task.spec.status, "in-progress")
  await access(path.join(projectRoot, "openspec/changes/managed-spec/.openspec.yaml"))
  assert.equal(await readFile(path.join(historicalArchive, "proposal.md"), "utf8"), "historical proposal\n")

  await assert.rejects(lead.dispatch({
    taskId: "managed-spec", workItemId: "bad-spec", owner: "junior-luna",
    scope: "write canonical spec", doneWhen: ["written"], artifactPaths: ["openspec/specs/example/spec.md"],
    contextProfile: "implement", prompt: "write it", sessionId: "lead-spec",
  }), (error) => error.code === "OPENSPEC_PATH_FORBIDDEN")

  await lead.dispatch({
    taskId: "managed-spec", workItemId: "proposal-owner", owner: "junior-luna",
    scope: "write proposal", doneWhen: ["proposal follows OpenSpec"],
    specArtifact: "proposal",
    contextProfile: "implement", prompt: "Write the proposal", sessionId: "lead-spec",
  })
  const dispatched = client.calls.filter(([name]) => name === "promptAsync").at(-1)[1].body.parts[0].text
  assert.match(dispatched, /Follow OpenSpec proposal instructions/)
  assert.match(dispatched, /openspec\/changes\/managed-spec\/proposal\.md/)

  await writeFile(path.join(projectRoot, "openspec/changes/managed-spec/proposal.md"), "proposal needing review fixes\n")
  await assert.rejects(lead.dispatch({
    taskId: "managed-spec", workItemId: "duplicate-proposal", owner: "junior-luna",
    scope: "duplicate completed proposal", doneWhen: ["written"], specArtifact: "proposal",
    contextProfile: "implement", prompt: "Rewrite it as a new work item", sessionId: "lead-spec",
  }), (error) => error.code === "SPEC_ARTIFACT_NOT_READY")
  await lead.dispatch({
    taskId: "managed-spec", workItemId: "proposal-owner", owner: "junior-luna",
    scope: "revise proposal", doneWhen: ["review issue resolved"],
    specArtifact: "proposal",
    contextProfile: "implement", prompt: "Revise the same proposal", sessionId: "lead-spec",
  })
  assert.equal(client.calls.filter(([name]) => name === "create").length, 1)
  assert.match(client.calls.filter(([name]) => name === "promptAsync").at(-1)[1].body.parts[0].text, /Follow OpenSpec proposal instructions/)
})

test("Lead keeps an incomplete OpenSpec change in SPEC and advances only after provider completion", async () => {
  const projectRoot = await tempProject()
  const platformRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-platform-"))
  await mkdir(path.join(platformRoot, "guides"), { recursive: true })
  const command = await fakeOpenSpec(platformRoot)
  await writeFile(path.join(platformRoot, "settings.json"), `${JSON.stringify({ spec: { provider: "openspec", mode: "required", command } })}\n`)
  const adapter = createOpenCodeAdapter({
    client: fakeClient(), projectRoot, platformRoot, platformProfile: { agents: [], helpers: [], guides: [] },
    runtimeExecutor: (request) => executeRuntime({ ...request, projectRoot }),
  })
  const lead = createLeadController({ adapter })
  await writeFile(path.join(projectRoot, "design.md"), "approved design\n")
  await lead.begin({ taskId: "complete-spec", title: "Complete SPEC", entryStage: "spec", mode: "solo", reason: "single owner", sessionId: "lead-complete" })
  await lead.register({ taskId: "complete-spec", contextId: "design", path: "design.md", kind: "design", profiles: ["lead", "check"], mustRead: true })

  const incomplete = await lead.continueFlow({ taskId: "complete-spec", sessionId: "lead-complete" })
  assert.equal(incomplete.stage, "spec")
  assert.match(incomplete.report, /尚未完成/)

  const changeRoot = path.join(projectRoot, "openspec/changes/complete-spec")
  await mkdir(path.join(changeRoot, "specs/example"), { recursive: true })
  await writeFile(path.join(changeRoot, "proposal.md"), "proposal\n")
  await writeFile(path.join(changeRoot, "design.md"), "design\n")
  await writeFile(path.join(changeRoot, "tasks.md"), "tasks\n")
  await writeFile(path.join(changeRoot, "specs/example/spec.md"), "spec\n")

  const advanced = await lead.continueFlow({ taskId: "complete-spec", sessionId: "lead-complete" })
  assert.equal(advanced.stage, "spec-review")
  const task = (await adapter.runtime({ command: "task.show", input: { taskId: "complete-spec" } })).envelope.data.task
  assert.equal(task.spec.status, "completed")
  assert.ok(task.spec.artifactRefs.every((entry) => entry.startsWith("openspec/changes/complete-spec/")))
  const contexts = (await adapter.runtime({ command: "context.list", input: { taskId: "complete-spec" } })).envelope.data.entries
  assert.ok(contexts.some(({ contextId, kind }) => contextId === "openspec-change" && kind === "spec"))
})

test("Lead validates and archives the active OpenSpec change only at final completion", async () => {
  const projectRoot = await tempProject()
  const platformRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-platform-"))
  await mkdir(path.join(platformRoot, "guides"), { recursive: true })
  const command = await fakeOpenSpec(platformRoot)
  await writeFile(path.join(platformRoot, "settings.json"), `${JSON.stringify({ spec: { provider: "openspec", mode: "required", command } })}\n`)
  let failArchivedStateWrite = true
  const adapter = createOpenCodeAdapter({
    client: fakeClient(), projectRoot, platformRoot, platformProfile: { agents: [], helpers: [], guides: [] },
    runtimeExecutor: (request) => {
      if (failArchivedStateWrite && request.command === "task.spec" && request.input.artifactPaths?.some((entry) => entry.includes("/changes/archive/"))) {
        return {
          exitCode: 3,
          envelope: {
            ok: false, apiVersion: "1.0", taskId: request.input.taskId, revision: request.input.expectedRevision,
            error: { code: "REVISION_CONFLICT", message: "injected interruption after archive", retryable: true, blockers: [], remediation: ["retry"] },
          },
        }
      }
      return executeRuntime({ ...request, projectRoot })
    },
  })
  const lead = createLeadController({ adapter, id: () => "finalproof" })
  await adapter.runtime({ command: "doctor", input: {} })
  await adapter.runtime({ command: "task.create", input: { taskId: "archive-spec", entryStage: "finish" } })
  const changeRoot = path.join(projectRoot, "openspec/changes/archive-spec")
  await mkdir(path.join(changeRoot, "specs/example"), { recursive: true })
  for (const [relative, content] of [
    [".openspec.yaml", "schema: spec-driven\n"], ["proposal.md", "proposal\n"],
    ["design.md", "design\n"], ["tasks.md", "tasks\n"], ["specs/example/spec.md", "spec\n"],
  ]) await writeFile(path.join(changeRoot, relative), content)
  let task = (await adapter.runtime({ command: "task.show", input: { taskId: "archive-spec" } })).envelope.data.task
  task = (await adapter.runtime({ command: "task.spec", input: { taskId: "archive-spec", status: "in-progress", expectedRevision: task.revision } })).envelope.data.task
  const activeArtifacts = ["proposal.md", "design.md", "tasks.md", "specs/example/spec.md"].map((entry) => `openspec/changes/archive-spec/${entry}`)
  task = (await adapter.runtime({ command: "task.spec", input: { taskId: "archive-spec", status: "completed", artifactPaths: activeArtifacts, expectedRevision: task.revision } })).envelope.data.task
  await writeFile(path.join(projectRoot, "final.md"), "final acceptance\n")
  task = (await adapter.runtime({
    command: "flow.await",
    input: {
      taskId: "archive-spec", evidencePath: "final.md", question: "approve?", blocker: "waiting",
      requiredDecision: "approve or reject", expectedRevision: task.revision,
    },
  })).envelope.data.task
  task = (await adapter.runtime({
    command: "flow.human",
    input: {
      taskId: "archive-spec", status: "passed", actor: "user",
      reason: "user approved", evidenceId: "final-evidence", expectedRevision: task.revision,
    },
  })).envelope.data.task

  await assert.rejects(lead.progress({
    taskId: "archive-spec", result: "completed", finalArtifactPaths: ["final.md"], finalSummary: "accepted",
  }), (error) => error.code === "REVISION_CONFLICT")
  await assert.rejects(access(changeRoot))
  failArchivedStateWrite = false
  const completed = await lead.progress({
    taskId: "archive-spec", result: "completed", finalArtifactPaths: ["final.md"], finalSummary: "accepted",
  })
  assert.equal(completed.task.status, "completed")
  await assert.rejects(access(changeRoot))
  const archived = completed.task.spec.artifactRefs
  assert.ok(archived.length > 0)
  assert.ok(archived.every((entry) => entry.startsWith("openspec/changes/archive/2026-08-18-archive-spec/")))
  assert.match(await readFile(path.join(projectRoot, ".team-work/tasks/archive-spec/artifacts/openspec-change.md"), "utf8"), /生命周期：archived/)
})

test("lazy project initialization disables the optional SPEC route when configured", async () => {
  const projectRoot = await tempProject()
  const platformRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-platform-"))
  await mkdir(path.join(platformRoot, "guides"), { recursive: true })
  await writeFile(path.join(platformRoot, "profile.json"), `${JSON.stringify({ agents: [], guides: [] })}\n`)
  await writeFile(path.join(platformRoot, "settings.json"), `${JSON.stringify({ spec: { provider: "openspec", mode: "disabled", command: "openspec" } })}\n`)
  const adapter = createOpenCodeAdapter({
    client: fakeClient(),
    projectRoot,
    platformRoot,
    runtimeExecutor: (request) => executeRuntime({ ...request, projectRoot }),
  })

  await adapter.runtime({ command: "doctor", input: {} })

  const config = JSON.parse(await readFile(path.join(projectRoot, ".team-work/config.yaml"), "utf8"))
  assert.deepEqual(config.spec, { type: "openspec", skill: "openspec", root: "openspec/", mode: "disabled", status: "disabled" })
})

test("lazy project initialization persists the restart-time effective Agent profile", async () => {
  const projectRoot = await tempProject()
  const platformRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-platform-"))
  await mkdir(path.join(platformRoot, "guides"), { recursive: true })
  await writeFile(path.join(platformRoot, "profile.json"), `${JSON.stringify({ agents: [], guides: [] })}\n`)
  const effectiveProfile = {
    agents: [{ id: "expert-opus", resolvedModel: "official/claude-opus-5" }],
    guides: [],
  }
  const adapter = createOpenCodeAdapter({
    client: fakeClient(),
    projectRoot,
    platformRoot,
    platformProfile: effectiveProfile,
    runtimeExecutor: (request) => executeRuntime({ ...request, projectRoot }),
  })

  await adapter.runtime({ command: "doctor", input: {} })

  assert.deepEqual(JSON.parse(await readFile(path.join(projectRoot, ".team-work/platform/opencode/profile.json"), "utf8")), effectiveProfile)
})

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

  client.session.status = async (input) => {
    client.calls.push(["status", input])
    return { data: {} }
  }
  await adapter.handleEvent({ type: "session.idle", properties: { sessionID: "child-1" } })
  await adapter.resume({ taskId: "task-1", workItemId: "review-1", prompt: "复核证据" })
  assert.deepEqual(client.calls.map(([name]) => name), ["create", "promptAsync", "status", "promptAsync"])
  assert.equal(client.calls.some(([name]) => name === "prompt"), false)

  const mapping = JSON.parse(await readFile(path.join(projectRoot, ".team-work/platform/opencode/sessions/task-1/review-1.json"), "utf8"))
  assert.equal(mapping.sessionId, "child-1")
  assert.equal(mapping.contextProfile, "check")
  assert.equal(mapping.dispatchMode, "background")
  assert.equal(mapping.dispatchSeq, 2)
  assert.equal(mapping.pendingSync, undefined)
})

test("a delayed idle event cannot settle a newer busy dispatch", async () => {
  const projectRoot = await tempProject()
  const client = fakeClient()
  const adapter = testAdapter(client, projectRoot)
  await adapter.spawn({ taskId: "task-stale-idle", workItemId: "impl-1", parentSessionId: "lead", agent: "junior-luna", prompt: "第一轮" })
  await adapter.resume({ taskId: "task-stale-idle", workItemId: "impl-1", prompt: "第二轮" })

  await adapter.handleEvent({ type: "session.idle", properties: { sessionID: "child-1" } })

  const mapping = await adapter.readMapping("task-stale-idle", "impl-1")
  assert.equal(mapping.dispatchSeq, 2)
  assert.equal(mapping.pendingSync, undefined)
})

test("managed members can fan out read-only helpers through background child sessions", async () => {
  const projectRoot = await tempProject()
  const client = fakeClient()
  let child = 0
  client.session.create = async (input) => {
    child += 1
    client.calls.push(["create", input])
    return { data: { id: `child-${child}`, parentID: input.body.parentID, title: input.body.title } }
  }
  client.session.status = async (input) => {
    client.calls.push(["status", input])
    return { data: { "child-2": { type: "busy" } } }
  }
  const adapter = testAdapter(client, projectRoot, {
    platformProfile: {
      helpers: [
        { id: "team-work-explore", kind: "explore", resolvedModel: "gateway/deepseek-v4-flash" },
        { id: "team-work-librarian", kind: "librarian", resolvedModel: "gateway/deepseek-v4-flash" },
      ],
    },
  })
  await adapter.spawn({ taskId: "task-help", workItemId: "owner-1", parentSessionId: "lead", agent: "junior-luna", prompt: "实现" })

  const assisted = await adapter.assist({
    parentSessionId: "child-1",
    kind: "explore",
    prompt: "定位身份校验调用链",
  })

  assert.deepEqual(assisted, {
    mode: "background",
    sessionId: "child-2",
    parentSessionId: "child-1",
    taskId: "task-help",
    workItemId: "owner-1",
    kind: "explore",
    agent: "team-work-explore",
  })
  assert.equal(client.calls.at(-1)[0], "promptAsync")
  assert.equal(client.calls.at(-1)[1].body.agent, "team-work-explore")
  assert.match(client.calls.at(-1)[1].body.parts[0].text, /定位身份校验调用链/)
  assert.match(client.calls.at(-1)[1].body.parts[0].text, /只读辅助任务/)

  const helperContext = await adapter.contextForSession("child-2")
  assert.match(helperContext, /profile: helper\/explore/)
  assert.match(helperContext, /只按父成员派发的窄范围问题工作/)
  assert.doesNotMatch(helperContext, /Lead|整个任务目录/)

  const status = await adapter.assistStatus({ parentSessionId: "child-1", sessionId: "child-2" })
  assert.equal(status.status.type, "busy")
  const collected = await adapter.assistMessages({ parentSessionId: "child-1", sessionId: "child-2" })
  assert.equal(collected.messages[0].parts[0].text, "result")

  const mapping = await adapter.readMapping("task-help", "owner-1")
  assert.deepEqual(mapping.helpers.map(({ sessionId, kind, agent }) => ({ sessionId, kind, agent })), [
    { sessionId: "child-2", kind: "explore", agent: "team-work-explore" },
  ])

  const createsBeforeInvalidPrompt = client.calls.filter(([name]) => name === "create").length
  await assert.rejects(
    adapter.assist({ parentSessionId: "child-1", kind: "explore", prompt: "  " }),
    (error) => error.code === "INVALID_PROMPT",
  )
  assert.equal(client.calls.filter(([name]) => name === "create").length, createsBeforeInvalidPrompt)
})

test("helper fan-out rejects unowned sessions and unavailable helper models", async () => {
  const projectRoot = await tempProject()
  const client = fakeClient()
  const adapter = testAdapter(client, projectRoot, { platformProfile: { helpers: [] } })

  await assert.rejects(
    adapter.assist({ parentSessionId: "not-managed", kind: "explore", prompt: "检索" }),
    (error) => error.code === "ASSIST_PARENT_REQUIRED",
  )
  await adapter.spawn({ taskId: "task-help", workItemId: "owner-1", parentSessionId: "lead", agent: "junior-luna", prompt: "实现" })
  await assert.rejects(
    adapter.assist({ parentSessionId: "child-1", kind: "librarian", prompt: "查文档" }),
    (error) => error.code === "HELPER_UNAVAILABLE",
  )

  const corrupt = testAdapter(client, projectRoot, {
    platformProfile: {
      helpers: [
        { id: "team-work-explore", kind: "explore", resolvedModel: "gateway/helper" },
        { id: "team-work-explore", kind: "explore", resolvedModel: "gateway/helper" },
      ],
    },
  })
  await assert.rejects(
    corrupt.assist({ parentSessionId: "child-1", kind: "explore", prompt: "检索" }),
    (error) => error.code === "HELPER_PROFILE_INVALID",
  )
})

test("helper creation aborts the child session if the parent mapping becomes inactive", async () => {
  const projectRoot = await tempProject()
  const client = fakeClient()
  const adapter = testAdapter(client, projectRoot, {
    platformProfile: {
      helpers: [{ id: "team-work-explore", kind: "explore", resolvedModel: "gateway/deepseek-v4-flash" }],
    },
  })
  await adapter.spawn({ taskId: "task-orphan", workItemId: "owner-1", parentSessionId: "lead", agent: "junior-luna", prompt: "实现" })
  client.session.create = async (input) => {
    client.calls.push(["create", input])
    const target = path.join(projectRoot, ".team-work/platform/opencode/sessions/task-orphan/owner-1.json")
    const mapping = JSON.parse(await readFile(target, "utf8"))
    await writeFile(target, `${JSON.stringify({ ...mapping, stoppedAt: new Date().toISOString() })}\n`)
    return { data: { id: "helper-orphan" } }
  }

  await assert.rejects(
    adapter.assist({ parentSessionId: "child-1", kind: "explore", prompt: "检索" }),
    (error) => error.code === "ASSIST_PARENT_INACTIVE",
  )
  const abort = client.calls.find(([name, input]) => name === "abort" && input.path.id === "helper-orphan")
  assert.ok(abort, "orphan helper session must be aborted")
})

test("status, result collection, and stop recover through stable task/work-item mapping", async () => {
  const projectRoot = await tempProject()
  const client = fakeClient()
  const adapter = testAdapter(client, projectRoot)
  await adapter.spawn({ taskId: "task-2", workItemId: "impl-1", parentSessionId: "lead-2", agent: "junior-luna", prompt: "实现" })

  const status = await adapter.status({ taskId: "task-2", workItemId: "impl-1" })
  assert.equal(status.status.type, "busy")
  client.session.status = async () => ({ data: {} })
  await adapter.handleEvent({ type: "session.idle", properties: { sessionID: "child-1" } })
  const messages = await adapter.messages({ taskId: "task-2", workItemId: "impl-1" })
  assert.equal(messages.messages[0].parts[0].text, "result")
  const collectedMapping = await adapter.readMapping("task-2", "impl-1")
  assert.equal(collectedMapping.pendingSync, undefined)
  assert.equal(collectedMapping.lastCollectedSeq, 1)
  const stopped = await adapter.stop({ taskId: "task-2", workItemId: "impl-1" })
  assert.equal(stopped.stopped, true)
  assert.equal(client.calls.some(([name]) => name === "abort"), true)
})

test("failed result collection preserves the pending synchronization hint", async () => {
  const projectRoot = await tempProject()
  const client = fakeClient()
  const adapter = testAdapter(client, projectRoot)
  await adapter.spawn({ taskId: "task-collect", workItemId: "impl-1", parentSessionId: "lead", agent: "junior-luna", prompt: "实现" })
  client.session.status = async () => ({ data: {} })
  await adapter.handleEvent({ type: "session.idle", properties: { sessionID: "child-1" } })
  client.session.messages = async () => { throw new Error("gateway unavailable") }

  await assert.rejects(
    adapter.messages({ taskId: "task-collect", workItemId: "impl-1" }),
    (error) => error.code === "OPENCODE_API_ERROR",
  )
  assert.equal((await adapter.readMapping("task-collect", "impl-1")).pendingSync.kind, "idle")
})

test("collect consumes only the idle hint from the dispatch it actually read", async () => {
  const projectRoot = await tempProject()
  const client = fakeClient()
  const adapter = testAdapter(client, projectRoot)
  await adapter.spawn({ taskId: "task-collect-race", workItemId: "impl-1", parentSessionId: "lead", agent: "junior-luna", prompt: "第一轮" })
  client.session.status = async () => ({ data: {} })
  await adapter.handleEvent({ type: "session.idle", properties: { sessionID: "child-1" } })

  let announceMessages
  let releaseMessages
  const messagesStarted = new Promise((resolve) => { announceMessages = resolve })
  const messagesHeld = new Promise((resolve) => { releaseMessages = resolve })
  client.session.messages = async () => {
    announceMessages()
    await messagesHeld
    return { data: [] }
  }
  const collecting = adapter.messages({ taskId: "task-collect-race", workItemId: "impl-1" })
  await messagesStarted
  await adapter.resume({ taskId: "task-collect-race", workItemId: "impl-1", prompt: "第二轮" })
  await adapter.handleEvent({ type: "session.idle", properties: { sessionID: "child-1" } })
  releaseMessages()
  await collecting

  const mapping = await adapter.readMapping("task-collect-race", "impl-1")
  assert.equal(mapping.dispatchSeq, 2)
  assert.equal(mapping.lastCollectedSeq, 1)
  assert.equal(mapping.pendingSync.dispatchSeq, 2)
  assert.equal(mapping.pendingSync.kind, "idle")
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
  let taskStatus = "active"
  const runtimeExecutor = async (request) => {
    requests.push(request)
    if (request.command === "task.show") return {
      exitCode: 0,
      envelope: { data: { task: { taskId: request.input.taskId ?? "task-7", stage: "code-review", status: taskStatus } } },
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
  assert.match(lead, /控制面索引/)
  assert.match(lead, /不要扫描整个任务目录/)
  assert.match(lead, /team_work_dispatch/)
  assert.match(lead, /team_work_assess.*team_work_continue/s)
  assert.match(lead, /不可重试[^。\n]*不要重复/)
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
  assert.match(child, /work-item: check-1/)
  assert.match(child, /agent: senior-terra/)
  assert.match(child, /只读取分配范围/)
  assert.equal(requests[0].input.taskId, "task-7")
  assert.equal(requests[1].input.profile, "check")

  client.session.status = async () => ({ data: {} })
  await adapter.handleEvent({ type: "session.idle", properties: { sessionID: "child-1" } })
  const leadWithPendingSync = await adapter.contextForSession("lead-7")
  assert.match(leadWithPendingSync, /待同步成员/)
  assert.match(leadWithPendingSync, /check-1/)
  assert.match(leadWithPendingSync, /team_work_sync/)
  assert.doesNotMatch(leadWithPendingSync, /result/)

  taskStatus = "awaiting-user"
  const awaitingUser = await adapter.contextForSession("lead-7")
  assert.match(awaitingUser, /等待用户明确决定/)
  assert.match(awaitingUser, /不要.*轮询|不得.*轮询|禁止.*轮询/)
  assert.doesNotMatch(awaitingUser, /\[待同步成员\]/)
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

test("spawn fails closed on a corrupt work-item session mapping", async () => {
  const projectRoot = await tempProject()
  const mappingRoot = path.join(projectRoot, ".team-work/platform/opencode/sessions/task-corrupt")
  await mkdir(mappingRoot, { recursive: true })
  await writeFile(path.join(mappingRoot, "owner-1.json"), "{not-json\n")
  const client = fakeClient()
  const adapter = testAdapter(client, projectRoot)

  await assert.rejects(
    adapter.spawn({ taskId: "task-corrupt", workItemId: "owner-1", parentSessionId: "lead", agent: "junior-luna", prompt: "实现" }),
    (error) => error.code === "SESSION_MAPPING_CORRUPT",
  )
  assert.equal(client.calls.filter(([name]) => name === "create").length, 0)
})

test("a lost work-item session can be replaced without losing session history", async () => {
  const projectRoot = await tempProject()
  const client = fakeClient()
  let child = 0
  client.session.create = async (input) => {
    child += 1
    const data = { id: `child-${child}`, parentID: input.body.parentID, title: input.body.title }
    client.calls.push(["create", input])
    return { data }
  }
  const adapter = testAdapter(client, projectRoot)
  const assignment = { taskId: "task-reset", workItemId: "owner-1", parentSessionId: "lead", agent: "junior-luna", prompt: "实现" }
  await adapter.spawn(assignment)
  await adapter.handleEvent({ type: "session.deleted", properties: { info: { id: "child-1" } } })

  const replaced = await adapter.spawn({ ...assignment, prompt: "从最新制品恢复" })

  assert.equal(replaced.sessionId, "child-2")
  const mapping = await adapter.readMapping("task-reset", "owner-1")
  assert.equal(mapping.sessionId, "child-2")
  assert.deepEqual(mapping.sessionHistory.map(({ sessionId, reason }) => ({ sessionId, reason })), [
    { sessionId: "child-1", reason: "lost" },
  ])
})

test("spawn validates the installed agent and Runtime assignment before creating a session", async () => {
  const projectRoot = await tempProject()
  const platformRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-platform-"))
  const profilePath = path.join(platformRoot, "profile.json")
  await mkdir(path.join(platformRoot, "guides"), { recursive: true })
  await writeFile(profilePath, `${JSON.stringify({ agents: [{ id: "senior-terra", resolvedModel: "gateway/gpt-5.6-terra" }] })}\n`)
  const client = fakeClient()
  const runtimeExecutor = async (request) => {
    if (request.command === "task.show") return { exitCode: 0, envelope: { data: { task: { status: "active", teamDecision: { mode: "team" } } } } }
    return { exitCode: 0, envelope: { data: { workItem: { owner: "senior-terra", status: "queued" } } } }
  }
  const adapter = createOpenCodeAdapter({ client, projectRoot, platformRoot, runtimeExecutor })
  await adapter.spawn({ taskId: "task-10", workItemId: "review-1", parentSessionId: "lead-10", agent: "senior-terra", prompt: "审查" })
  assert.equal(client.calls.filter(([name]) => name === "create").length, 1)

  await assert.rejects(
    adapter.spawn({ taskId: "task-10", workItemId: "review-2", parentSessionId: "lead-10", agent: "build", prompt: "绕过" }),
    (error) => error.code === "AGENT_UNAVAILABLE",
  )
  assert.equal(client.calls.filter(([name]) => name === "create").length, 1)
})

test("solo mode dispatches one concrete worker instead of making Lead execute", async () => {
  const projectRoot = await tempProject()
  const platformRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-platform-"))
  await mkdir(path.join(platformRoot, "guides"), { recursive: true })
  await writeFile(path.join(platformRoot, "profile.json"), `${JSON.stringify({
    agents: [{ id: "junior-luna", resolvedModel: "gateway/gpt-5.6-luna" }],
  })}\n`)
  const client = fakeClient()
  const runtimeExecutor = async (request) => {
    if (request.command === "task.show") return { exitCode: 0, envelope: { data: { task: { status: "active", teamDecision: { mode: "solo" } } } } }
    return { exitCode: 0, envelope: { data: { workItem: { owner: "junior-luna", status: "queued" } } } }
  }
  const adapter = createOpenCodeAdapter({ client, projectRoot, platformRoot, runtimeExecutor })

  const result = await adapter.spawn({
    taskId: "task-solo",
    workItemId: "owner-1",
    parentSessionId: "lead-solo",
    agent: "junior-luna",
    contextProfile: "implement",
    prompt: "串行完成当前范围",
  })

  assert.equal(result.mode, "background")
  assert.equal(result.sessionId, "child-1")
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
  const adapterSource = await readFile(path.join(sourceRoot, "plugins/opencode/src/opencode-adapter.mjs"), "utf8")
  const leadController = await readFile(path.join(sourceRoot, "plugins/opencode/src/lead-controller.mjs"), "utf8")
  assert.match(plugin, /"tool\.execute\.before"/)
  assert.match(plugin, /input\.tool === "task"/)
  assert.match(plugin, /TEAM_WORK_BLOCKING_TASK_REJECTED/)
  assert.match(plugin, /assertExternalTodoWriteAllowed/)
  assert.match(adapterSource, /TEAM_WORK_EXTERNAL_TODO_REJECTED/)
  assert.match(plugin, /TEAM_WORK_HELPER_READ_ONLY_REJECTED/)
  assert.match(plugin, /team_work_sync/)
  assert.match(leadController, /adapter\.wait/)
  assert.match(plugin, /sessionId:\s*context\.sessionID/)
  assert.match(plugin, /timeout_ms/)
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

test("awaiting-user Lead remains managed and may only clear external todos", async () => {
  const projectRoot = await tempProject()
  const bindingRoot = path.join(projectRoot, ".team-work/bindings/opencode")
  await mkdir(bindingRoot, { recursive: true })
  await writeFile(path.join(bindingRoot, "lead-await.json"), "{}\n")
  const client = fakeClient()
  client.session.todo = async () => ({ data: [{ content: "用户确认后继续", status: "pending", priority: "high" }] })
  const adapter = testAdapter(client, projectRoot, {
    runtimeExecutor: async () => ({
      exitCode: 0,
      envelope: { data: { task: { taskId: "awaiting-task", status: "awaiting-user", teamDecision: { mode: "team" } } } },
    }),
  })

  assert.equal(await adapter.isManagedTeamSession("lead-await"), true)
  await assert.rejects(
    adapter.assertExternalTodoWriteAllowed("lead-await", [{ content: "用户确认后继续", status: "pending", priority: "high" }]),
    (error) => error.code === "TEAM_WORK_EXTERNAL_TODO_REJECTED",
  )
  await adapter.assertExternalTodoWriteAllowed("lead-await", [{ content: "等待前清理", status: "completed", priority: "high" }])
  await assert.rejects(
    adapter.assertNoPendingExternalTodos("lead-await"),
    (error) => error.code === "EXTERNAL_TODO_BLOCKS_HUMAN_WAIT",
  )
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

test("child idle events persist a dispatch-scoped Lead synchronization hint without claiming completion", async () => {
  const projectRoot = await tempProject()
  const client = fakeClient()
  const adapter = testAdapter(client, projectRoot, {
    runtimeExecutor: async () => ({ exitCode: 0, envelope: { data: {} } }),
  })
  await adapter.spawn({ taskId: "task-sync", workItemId: "impl-1", parentSessionId: "lead-sync", agent: "junior-luna", prompt: "实现" })

  assert.equal((await adapter.readMapping("task-sync", "impl-1")).dispatchSeq, 1)
  client.session.status = async () => ({ data: {} })
  assert.equal(await adapter.handleEvent({ type: "session.idle", properties: { sessionID: "child-1" } }), true)

  const firstPending = (await adapter.readMapping("task-sync", "impl-1")).pendingSync
  assert.equal(await adapter.handleEvent({ type: "session.idle", properties: { sessionID: "child-1" } }), true)
  const mapping = await adapter.readMapping("task-sync", "impl-1")
  assert.deepEqual(mapping.pendingSync, {
    dispatchSeq: 1,
    kind: "idle",
    detectedAt: firstPending.detectedAt,
  })
  assert.equal(mapping.completedAt, undefined)
})

test("bounded wait wakes on a child synchronization event and can time out without changing workflow state", async () => {
  const projectRoot = await tempProject()
  const client = fakeClient()
  const adapter = testAdapter(client, projectRoot, {
    runtimeExecutor: async () => ({ exitCode: 0, envelope: { data: {} } }),
    waitPollMs: 1_000,
  })
  await adapter.spawn({ taskId: "task-wait", workItemId: "impl-1", parentSessionId: "lead", agent: "junior-luna", prompt: "实现" })
  client.session.status = async () => ({ data: {} })

  const waiting = adapter.wait({ taskId: "task-wait", workItemIds: ["impl-1"], timeoutMs: 1_000 })
  setTimeout(() => {
    void adapter.handleEvent({ type: "session.idle", properties: { sessionID: "child-1" } })
  }, 10)
  const ready = await waiting
  assert.equal(ready.outcome, "ready")
  assert.equal(ready.items[0].workItemId, "impl-1")
  assert.equal(ready.items[0].dispatchSeq, 1)
  assert.ok(ready.waitedMs < 500)

  await adapter.messages({ taskId: "task-wait", workItemId: "impl-1" })
  const timedOut = await adapter.wait({ taskId: "task-wait", workItemIds: ["impl-1"], timeoutMs: 15 })
  assert.equal(timedOut.outcome, "timeout")
  assert.deepEqual(timedOut.items, [])
})

test("managed members cannot use the Lead synchronization wait", async () => {
  const projectRoot = await tempProject()
  const client = fakeClient()
  const adapter = testAdapter(client, projectRoot)
  await adapter.spawn({ taskId: "task-lead-wait", workItemId: "impl-1", parentSessionId: "lead", agent: "junior-luna", prompt: "实现" })

  await assert.rejects(
    adapter.wait({ taskId: "task-lead-wait", requesterSessionId: "child-1", timeoutMs: 20 }),
    (error) => error.code === "WAIT_LEAD_REQUIRED",
  )
})

test("bounded wait follows the OpenCode tool abort signal", async () => {
  const projectRoot = await tempProject()
  const client = fakeClient()
  const adapter = testAdapter(client, projectRoot, { waitPollMs: 1_000 })
  await adapter.spawn({ taskId: "task-abort-wait", workItemId: "impl-1", parentSessionId: "lead", agent: "junior-luna", prompt: "实现" })
  const controller = new AbortController()

  const waiting = assert.rejects(
    adapter.wait({ taskId: "task-abort-wait", timeoutMs: 1_000, signal: controller.signal }),
    (error) => error.code === "WAIT_ABORTED",
  )
  setTimeout(() => controller.abort(), 10)
  await waiting
})

test("a new adapter process recovers persisted pending synchronization hints", async () => {
  const projectRoot = await tempProject()
  const client = fakeClient()
  const runtimeExecutor = async () => ({ exitCode: 0, envelope: { data: {} } })
  const first = testAdapter(client, projectRoot, { runtimeExecutor })
  await first.spawn({ taskId: "task-restart", workItemId: "impl-1", parentSessionId: "lead", agent: "junior-luna", prompt: "实现" })
  client.session.status = async () => ({ data: {} })
  await first.handleEvent({ type: "session.idle", properties: { sessionID: "child-1" } })

  const restarted = testAdapter(client, projectRoot, { runtimeExecutor })
  const recovered = await restarted.wait({ taskId: "task-restart", timeoutMs: 20 })

  assert.equal(recovered.outcome, "ready")
  assert.equal(recovered.items[0].workItemId, "impl-1")
})

test("bounded wait performs one recovery snapshot when an event was missed", async () => {
  const projectRoot = await tempProject()
  const client = fakeClient()
  client.session.status = async (input) => {
    client.calls.push(["status", input])
    return { data: {} }
  }
  const adapter = testAdapter(client, projectRoot, {
    runtimeExecutor: async () => ({ exitCode: 0, envelope: { data: {} } }),
    waitPollMs: 5,
    waitIdleGraceMs: 0,
  })
  await adapter.spawn({ taskId: "task-reconcile", workItemId: "check-1", parentSessionId: "lead", agent: "senior-terra", prompt: "审查" })

  const result = await adapter.wait({ taskId: "task-reconcile", timeoutMs: 100 })

  assert.equal(result.outcome, "ready")
  assert.equal(result.items[0].source, "recovery")
  assert.equal((await adapter.readMapping("task-reconcile", "check-1")).pendingSync.kind, "idle")
  assert.equal(client.calls.some(([name]) => name === "get"), true)
})

test("bounded wait does not poll OpenCode status while suspended", async () => {
  const projectRoot = await tempProject()
  const client = fakeClient()
  let statusCalls = 0
  client.session.status = async () => {
    statusCalls += 1
    return { data: { "child-1": { type: "busy" } } }
  }
  const adapter = testAdapter(client, projectRoot, {
    runtimeExecutor: async () => ({ exitCode: 0, envelope: { data: {} } }),
    waitPollMs: 5,
    waitIdleGraceMs: 0,
  })
  await adapter.spawn({ taskId: "task-no-poll", workItemId: "impl-1", parentSessionId: "lead", agent: "junior-luna", prompt: "实现" })

  const result = await adapter.wait({ taskId: "task-no-poll", timeoutMs: 35 })

  assert.equal(result.outcome, "timeout")
  assert.equal(statusCalls, 1)
})

test("bounded wait honors its deadline even when OpenCode status does not settle", async () => {
  const projectRoot = await tempProject()
  const client = fakeClient()
  client.session.status = async () => new Promise(() => {})
  const adapter = testAdapter(client, projectRoot, {
    runtimeExecutor: async () => ({ exitCode: 0, envelope: { data: {} } }),
    waitPollMs: 5,
  })
  await adapter.spawn({ taskId: "task-hung-status", workItemId: "impl-1", parentSessionId: "lead", agent: "junior-luna", prompt: "实现" })

  const result = await Promise.race([
    adapter.wait({ taskId: "task-hung-status", timeoutMs: 20 }),
    new Promise((resolve) => setTimeout(() => resolve({ outcome: "hung" }), 80)),
  ])

  assert.equal(result.outcome, "timeout")
  assert.match(result.recoveryError, /timed out/)
})

test("bounded wait surfaces child error and lost states without accepting the work item", async () => {
  const projectRoot = await tempProject()
  const client = fakeClient()
  const adapter = testAdapter(client, projectRoot, {
    runtimeExecutor: async () => ({ exitCode: 0, envelope: { data: {} } }),
  })
  await adapter.spawn({ taskId: "task-wait-fault", workItemId: "impl-1", parentSessionId: "lead", agent: "junior-luna", prompt: "实现" })

  await adapter.handleEvent({ type: "session.error", properties: { sessionID: "child-1", error: { message: "gateway unavailable" } } })
  const failed = await adapter.wait({ taskId: "task-wait-fault", timeoutMs: 20 })
  assert.equal(failed.outcome, "error")
  assert.match(failed.items[0].detail, /gateway unavailable/)
  await adapter.messages({ taskId: "task-wait-fault", workItemId: "impl-1" })
  assert.equal((await adapter.readMapping("task-wait-fault", "impl-1")).pendingSync.kind, "error")

  await adapter.resume({ taskId: "task-wait-fault", workItemId: "impl-1", prompt: "网关恢复后继续" })
  await adapter.handleEvent({ type: "session.deleted", properties: { info: { id: "child-1" } } })
  const lost = await adapter.wait({ taskId: "task-wait-fault", timeoutMs: 20 })
  assert.equal(lost.outcome, "lost")
  assert.equal(lost.items[0].dispatchSeq, 2)
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
