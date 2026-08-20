import assert from "node:assert/strict"
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  createOpenCodeRuntimeHost,
  normalizeOpenCodeMemberReport,
  normalizeOpenCodeSteerInput,
} from "../../../plugins/opencode/adapter/runtime-host.mjs"
import { ContractError } from "../../../runtime/index.mjs"
import { createFakeExecutionAdapter } from "../../../runtime/testing/fakes.mjs"

const root = path.resolve(import.meta.dirname, "../../..")
const json = async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8"))

async function project() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-v2-host-"))
  await mkdir(path.join(projectRoot, ".team-work", "tasks"), { recursive: true })
  await mkdir(path.join(projectRoot, "requirements"), { recursive: true })
  await writeFile(path.join(projectRoot, ".team-work", "project.json"), `${JSON.stringify({ runtimeMajor: 2, schemaVersion: "2.0" })}\n`)
  await writeFile(path.join(projectRoot, "requirements", "task.md"), "Implement the requested change.\n")
  return projectRoot
}

function durableFake() {
  const base = createFakeExecutionAdapter()
  const leads = new Map()
  const leadByTask = new Map()
  return Object.freeze({
    ...base,
    async bindLead(input) {
      const priorTask = leadByTask.get(input.taskId)
      if (priorTask) leads.delete(priorTask.hostSessionRef)
      const priorSession = leads.get(input.hostSessionRef)
      if (priorSession) leadByTask.delete(priorSession.taskId)
      const binding = await base.bindLead(input)
      leads.set(input.hostSessionRef, binding)
      leadByTask.set(input.taskId, binding)
      return binding
    },
    async resolveLeadBindingForSession(hostSessionRef) {
      return leads.get(hostSessionRef) ?? null
    },
    async resolveMemberBinding(sessionId) {
      const member = base.activeMembers().find(({ executionRef }) => executionRef === sessionId)
      if (!member) return null
      return {
        taskId: member.taskId,
        stageRunId: member.stageRunId,
        assignmentId: member.assignmentId,
        attemptId: member.attemptId,
        executionRef: member.executionRef,
        operationKey: `report:${member.attemptId}`,
        agentId: "junior-luna",
        hostSessionRef: leadByTask.get(member.taskId).hostSessionRef,
      }
    },
  })
}

async function host(projectRoot, executionAdapter, options = {}) {
  return createOpenCodeRuntimeHost({
    projectRoot,
    executionAdapter,
    workflowDefinition: await json("workflow/definitions/engineering.json"),
    teamPolicy: await json("team-work/policies/default.json"),
    routeConfig: { spec: { mode: "disabled" }, e2e: { mode: "disabled" } },
    ...options,
    clock: () => "2026-08-20T10:00:00.000Z",
  })
}

function openIntent(title) {
  return {
    title,
    objective: "Implement the requested change",
    entryStage: "implementation",
    completion: { mode: "through-stage", stage: "implementation" },
    existingArtifacts: [{ kind: "requirement", locator: { type: "project-path", value: "requirements/task.md" } }],
  }
}

test("OpenCode steering trims an exact choice without guessing from prose", () => {
  const state = { pendingDecision: { choices: ["rework"] } }
  assert.deepEqual(normalizeOpenCodeSteerInput(state, {
    action: "choose",
    directive: "  rework  ",
  }), { action: "choose", directive: "rework" })
  assert.equal(normalizeOpenCodeSteerInput(state, {
    action: "choose",
    directive: "用户确认 rework，请继续",
  }).directive, "用户确认 rework，请继续")
  assert.equal(normalizeOpenCodeSteerInput({ pendingDecision: { choices: ["accept", "rework"] } }, {
    action: "choose",
    directive: "accept 或 rework 均可",
  }).directive, "accept 或 rework 均可")
})

test("OpenCode normalizes only known bare report ids in member evidence", () => {
  const known = "report-1234abcd"
  const unknown = "report-deadbeef"
  const normalized = normalizeOpenCodeMemberReport("/project", {
    artifacts: [],
    evidenceRefs: [known, unknown, "artifact:source"],
    checks: [
      { name: "known", result: "pass", evidenceRef: known },
      { name: "unknown", result: "pass", evidenceRef: unknown },
    ],
    findings: [{ severity: "risk", statement: "review", evidenceRefs: [known, unknown] }],
    verdict: { evidenceRefs: [known, unknown] },
  }, { role: "expert", acceptedReportRefs: [{ reportId: known }] })

  assert.deepEqual(normalized.evidenceRefs, [`report:${known}`, unknown, "artifact:source"])
  assert.deepEqual(normalized.checks, [
    { name: "known", result: "pass", evidenceRef: `report:${known}` },
    { name: "unknown", result: "pass", evidenceRef: unknown },
  ])
  assert.deepEqual(normalized.findings[0].evidenceRefs, [`report:${known}`, unknown])
  assert.deepEqual(normalized.verdict.evidenceRefs, [`report:${known}`, unknown])

  const inherited = normalizeOpenCodeMemberReport("/project", {
    artifacts: [{ ref: "artifact:proposal", path: "/project/plan.json" }],
    evidenceRefs: ["artifact:proposal"],
    verdict: { outcome: "accept", evidenceRefs: [] },
  }, { role: "expert" })
  assert.deepEqual(inherited.artifacts, [])
  assert.deepEqual(inherited.verdict.evidenceRefs, ["artifact:proposal"])

  const promoted = normalizeOpenCodeMemberReport("/project", {
    artifacts: [],
    evidenceRefs: [],
    findings: [{ severity: "risk", statement: "review", evidenceRefs: ["artifact:source"] }],
    verdict: { outcome: "accept", evidenceRefs: ["artifact:review"] },
  }, { role: "expert" })
  assert.deepEqual(promoted.evidenceRefs, ["artifact:review", "artifact:source"])
  assert.deepEqual(promoted.verdict.evidenceRefs, ["artifact:review"])

  const response = normalizeOpenCodeMemberReport("/project", {
    artifacts: [{ ref: "artifact:review", path: "/project/review.md" }],
    evidenceRefs: ["artifact:review"],
  }, { role: "owner", allowArtifacts: false })
  assert.deepEqual(response.artifacts, [])

  const bareArtifact = normalizeOpenCodeMemberReport("/project", {
    artifacts: [{ ref: "code-review", path: "/project/review.md" }],
    evidenceRefs: ["source", "code-review"],
    checks: [{ name: "review", result: "pass", evidenceRef: "code-review" }],
  }, {
    role: "owner",
    knownArtifactRefs: ["artifact:source", "artifact:code-review"],
  })
  assert.deepEqual(bareArtifact.artifacts, [{ ref: "artifact:code-review", path: "review.md" }])
  assert.deepEqual(bareArtifact.evidenceRefs, ["artifact:source", "artifact:code-review"])
  assert.equal(bareArtifact.checks[0].evidenceRef, "artifact:code-review")
})

test("the OpenCode Runtime host isolates active tasks by Lead session", async () => {
  const projectRoot = await project()
  const executionAdapter = durableFake()
  const runtimeHost = await host(projectRoot, executionAdapter)

  const first = await runtimeHost.open("lead-one", openIntent("First task"))
  const second = await runtimeHost.open("lead-two", openIntent("Second task"))
  assert.notEqual(first.task.id, second.task.id)

  const firstAgain = await runtimeHost.run("lead-one")
  const secondAgain = await runtimeHost.run("lead-two")
  assert.equal(firstAgain.task.id, first.task.id)
  assert.equal(secondAgain.task.id, second.task.id)
})

test("workflow_open lazily initializes a clean project", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-v2-host-clean-"))
  await mkdir(path.join(projectRoot, "requirements"), { recursive: true })
  await writeFile(path.join(projectRoot, "requirements", "task.md"), "Implement the requested change.\n")
  const runtimeHost = await host(projectRoot, durableFake())

  await assert.rejects(access(path.join(projectRoot, ".team-work")), { code: "ENOENT" })
  const opened = await runtimeHost.open("lead-clean", openIntent("Clean task"))
  assert.equal(opened.task.title, "Clean task")
  assert.equal(JSON.parse(await readFile(path.join(projectRoot, ".team-work", "project.json"), "utf8")).runtimeMajor, 2)
})

test("workflow_open asks for marker repair instead of crashing on a broken project marker", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-v2-host-marker-"))
  await mkdir(path.join(projectRoot, ".team-work"), { recursive: true })
  await writeFile(path.join(projectRoot, ".team-work", "project.json"), "{ not json")
  const runtimeHost = await host(projectRoot, durableFake())

  const problem = await runtimeHost.open("lead-marker", openIntent("Marker repair task"))
  assert.equal(problem.code, "STATE_CORRUPT")
  assert.match(problem.message, /project\.json/)
  assert.equal(problem.next.kind, "none")
  assert.match(problem.next.reason, /workflow_open/)
})

test("workflow_open asks for marker repair when the marker belongs to another runtime major", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-v2-host-v1-marker-"))
  await mkdir(path.join(projectRoot, ".team-work"), { recursive: true })
  await writeFile(path.join(projectRoot, ".team-work", "project.json"), `${JSON.stringify({ runtimeMajor: 1, schemaVersion: "1.0" })}\n`)
  const runtimeHost = await host(projectRoot, durableFake())

  const problem = await runtimeHost.open("lead-v1-marker", openIntent("Foreign marker task"))
  assert.equal(problem.code, "RUNTIME_MAJOR_MISMATCH")
  assert.equal(problem.next.kind, "none")
})

test("lead steering tools surface marker repair problems without throwing", async () => {
  const projectRoot = await project()
  const broken = durableFake()
  const markerFailure = new ContractError("Cannot read Runtime project marker at .team-work/project.json", [], "STATE_CORRUPT")
  const failing = Object.freeze({
    ...broken,
    async resolveLeadBindingForSession() {
      throw markerFailure
    },
  })
  const runtimeHost = await host(projectRoot, failing)

  for (const [operation, invoke] of [
    ["plan", () => runtimeHost.plan("lead-broken", { objective: "Continue" })],
    ["run", () => runtimeHost.run("lead-broken")],
    ["steer", () => runtimeHost.steer("lead-broken", { action: "replan", directive: "Replan the stage" })],
  ]) {
    const problem = await invoke()
    assert.equal(problem.code, "STATE_CORRUPT", operation)
    assert.equal(problem.impact.includes("未执行"), true, operation)
  }
})

test("workflow_open normalizes model-supplied absolute artifact paths inside the project", async () => {
  const projectRoot = await project()
  const runtimeHost = await host(projectRoot, durableFake())
  const intent = openIntent("Absolute input task")
  intent.existingArtifacts[0].locator.value = path.join(projectRoot, "requirements", "task.md")

  const opened = await runtimeHost.open("lead-absolute", intent)
  const state = JSON.parse(await readFile(path.join(projectRoot, ".team-work", "tasks", opened.task.id, "state.json"), "utf8"))

  assert.equal(state.artifacts[0].path, "requirements/task.md")
  await assert.rejects(
    runtimeHost.open("lead-outside", {
      ...openIntent("Outside input task"),
      existingArtifacts: [{ kind: "requirement", locator: { type: "project-path", value: path.join(os.tmpdir(), "outside.md") } }],
    }),
    (error) => error.code === "OPEN_ARTIFACT_PATH_ESCAPE",
  )
})

test("workflow_open prioritizes task id and never guesses creation from an unknown id", async () => {
  const projectRoot = await project()
  const runtimeHost = await host(projectRoot, durableFake())
  const missing = await runtimeHost.open("lead-create", { taskId: "new", ...openIntent("Provider-filled id task") })
  assert.equal(missing.code, "TASK_NOT_FOUND")
  const created = await runtimeHost.open("lead-create", openIntent("Provider-filled id task"))

  const restored = await runtimeHost.open("lead-restore", {
    taskId: created.task.id,
    ...openIntent("Fields the provider should have omitted"),
  })

  assert.equal(restored.task.id, created.task.id)
  assert.equal(restored.task.title, "Provider-filled id task")
})

test("workflow_open explains how to recover when a requested task does not exist", async () => {
  const projectRoot = await project()
  const runtimeHost = await host(projectRoot, durableFake())

  const problem = await runtimeHost.open("lead-missing", { taskId: "missing-task" })

  assert.equal(problem.code, "TASK_NOT_FOUND")
  assert.match(problem.message, /只有 task_id 表示恢复已有任务/)
  assert.match(problem.next.reason, /mode=create/)
})

test("a restarted OpenCode Runtime host restores the task from the durable Lead binding", async () => {
  const projectRoot = await project()
  const executionAdapter = durableFake()
  const firstHost = await host(projectRoot, executionAdapter)
  const opened = await firstHost.open("lead-restart", openIntent("Restart task"))

  const restarted = await host(projectRoot, executionAdapter)
  const recovered = await restarted.run("lead-restart")
  assert.equal(recovered.task.id, opened.task.id)
  assert.equal(recovered.next.kind, "plan")
})

test("a transferred task invalidates the old Lead Runtime cache", async () => {
  const projectRoot = await project()
  const executionAdapter = durableFake()
  const runtimeHost = await host(projectRoot, executionAdapter)
  const opened = await runtimeHost.open("lead-old", openIntent("Transferred task"))
  await runtimeHost.open("lead-new", { taskId: opened.task.id })

  assert.equal((await runtimeHost.run("lead-old")).code, "TASK_SELECTION_REQUIRED")
  assert.equal((await runtimeHost.run("lead-new")).task.id, opened.task.id)
})

test("an unbound Lead session receives one small task-selection problem", async () => {
  const runtimeHost = await host(await project(), durableFake())
  assert.deepEqual(await runtimeHost.run("unknown-lead"), {
    code: "TASK_SELECTION_REQUIRED",
    message: "当前会话还没有活动任务。",
    impact: "任务状态未改变；请先打开或创建任务。",
    next: { kind: "none", reason: "需要先调用 workflow_open" },
  })
})

test("planning materializes bounded member context before background dispatch", async () => {
  const projectRoot = await project()
  const executionAdapter = durableFake()
  const runtimeHost = await host(projectRoot, executionAdapter)
  await runtimeHost.open("lead-context", openIntent("Context task"))
  const card = await runtimeHost.plan("lead-context", {
    objective: "Implement the requested change",
    preferences: { execution: "solo", budget: "balanced", risk: "normal" },
  })
  const member = executionAdapter.activeMembers()[0]
  assert.equal(card.next.kind, "wait")
  assert.match(
    await readFile(path.join(projectRoot, ".team-work", "tasks", member.taskId, "context", `${member.assignmentId}.md`), "utf8"),
    /角色：Owner/,
  )
})

test("a member report is bound by its child session without Lead orchestration fields", async () => {
  const projectRoot = await project()
  const executionAdapter = durableFake()
  const runtimeHost = await host(projectRoot, executionAdapter)
  await runtimeHost.open("lead-report", openIntent("Report task"))
  await runtimeHost.plan("lead-report", {
    objective: "Implement the requested change",
    preferences: { execution: "solo", budget: "balanced", risk: "normal" },
  })
  const member = executionAdapter.activeMembers()[0]
  const state = JSON.parse(await readFile(path.join(projectRoot, ".team-work", "tasks", member.taskId, "state.json"), "utf8"))
  const assignment = state.workGraph.assignments.find(({ assignmentId }) => assignmentId === member.assignmentId)
  await mkdir(path.join(projectRoot, "src"), { recursive: true })
  await writeFile(path.join(projectRoot, "src", "result.mjs"), "export const result = true\n")

  const receipt = await runtimeHost.report(member.executionRef, {
    outcome: "delivered",
    summary: "Implemented the requested source change.",
    artifacts: [{ ref: assignment.writableRefs[0], path: path.join(projectRoot, "src", "result.mjs") }],
    evidenceRefs: [],
    checks: [{ name: "focused test", result: "pass", evidenceRef: "plain-language evidence is not a durable ref" }],
    recommendation: "accept",
    verdict: {
      outcome: "accept",
      rationale: "A non-Expert model filled this field.",
      evidenceRefs: [],
      affectedScope: [],
      risks: [],
      confidence: "low",
      recommendedAction: "ignore",
    },
  })
  assert.equal(receipt.accepted, true)
  assert.equal(receipt.assignmentId, member.assignmentId)
  const record = JSON.parse(await readFile(path.join(projectRoot, ".team-work", "tasks", member.taskId, "reports", `${receipt.reportId}.json`), "utf8"))
  assert.deepEqual(record.report.checks, [{ name: "focused test", result: "pass" }])
  assert.equal(record.report.verdict, undefined)
})

test("workflow_run waits for a member report and consumes it without Lead polling", async () => {
  const projectRoot = await project()
  const executionAdapter = durableFake()
  const runtimeHost = await host(projectRoot, executionAdapter, { runWaitBudgetMs: 500 })
  await runtimeHost.open("lead-wait", openIntent("Wait task"))
  await runtimeHost.plan("lead-wait", {
    objective: "Implement the requested change",
    preferences: { execution: "solo", budget: "balanced", risk: "normal" },
  })
  const member = executionAdapter.activeMembers()[0]
  const statePath = path.join(projectRoot, ".team-work", "tasks", member.taskId, "state.json")
  const before = JSON.parse(await readFile(statePath, "utf8"))
  const assignment = before.workGraph.assignments.find(({ assignmentId }) => assignmentId === member.assignmentId)
  await mkdir(path.join(projectRoot, "src"), { recursive: true })
  await writeFile(path.join(projectRoot, "src", "wait-result.mjs"), "export const result = true\n")

  const controller = new AbortController()
  const waiting = runtimeHost.run("lead-wait", { signal: controller.signal })
  await new Promise((resolve) => setImmediate(resolve))
  await runtimeHost.report(member.executionRef, {
    outcome: "delivered",
    summary: "Implemented while the Lead control call was suspended.",
    artifacts: [{ ref: assignment.writableRefs[0], path: "src/wait-result.mjs" }],
    evidenceRefs: [],
    recommendation: "accept",
  })
  setTimeout(() => controller.abort(), 20)
  await waiting

  const after = JSON.parse(await readFile(statePath, "utf8"))
  assert.ok(after.revision > before.revision)
  assert.equal(after.workGraph.assignments.find(({ assignmentId }) => assignmentId === member.assignmentId).status, "accepted")
})

test("workflow_run timeout and host abort do not mutate a stable waiting task", async () => {
  const projectRoot = await project()
  const executionAdapter = durableFake()
  const runtimeHost = await host(projectRoot, executionAdapter, { runWaitBudgetMs: 15 })
  await runtimeHost.open("lead-timeout", openIntent("Timeout task"))
  await runtimeHost.plan("lead-timeout", {
    objective: "Implement the requested change",
    preferences: { execution: "solo", budget: "balanced", risk: "normal" },
  })
  const member = executionAdapter.activeMembers()[0]
  const statePath = path.join(projectRoot, ".team-work", "tasks", member.taskId, "state.json")
  const before = await readFile(statePath, "utf8")

  await runtimeHost.run("lead-timeout")
  assert.equal(await readFile(statePath, "utf8"), before)

  const controller = new AbortController()
  controller.abort()
  await runtimeHost.run("lead-timeout", { signal: controller.signal })
  assert.equal(await readFile(statePath, "utf8"), before)
})
