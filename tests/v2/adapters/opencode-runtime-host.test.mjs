import assert from "node:assert/strict"
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { createOpenCodeRuntimeHost } from "../../../plugins/opencode/adapter/runtime-host.mjs"
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
    artifacts: [{ ref: assignment.writableRefs[0], path: "src/result.mjs" }],
    evidenceRefs: [],
    recommendation: "accept",
  })
  assert.equal(receipt.accepted, true)
  assert.equal(receipt.assignmentId, member.assignmentId)
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
