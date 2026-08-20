import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { createOpenCodeExecutionAdapter } from "../../../plugins/opencode/adapter/execution-adapter.mjs"
import { createOpenCodeRuntimeHost } from "../../../plugins/opencode/adapter/runtime-host.mjs"
import { createOpenCodeToolHandlers } from "../../../plugins/opencode/tools/index.mjs"

const repositoryRoot = path.resolve(import.meta.dirname, "../../..")
const json = async (relativePath) => JSON.parse(await readFile(path.join(repositoryRoot, relativePath), "utf8"))

function fakeOpenCode() {
  const sessions = new Map()
  const messages = new Map()
  const statuses = {}
  let sequence = 0
  const session = {
    async create({ body }) {
      const id = `child-${++sequence}`
      const value = { id, parentID: body.parentID, title: body.title, time: { created: sequence, updated: sequence } }
      sessions.set(id, value)
      messages.set(id, [])
      statuses[id] = { type: "idle" }
      return { data: value }
    },
    async list() { return { data: [...sessions.values()] } },
    async get({ path: { id } }) { return sessions.has(id) ? { data: sessions.get(id) } : { error: { status: 404, message: "missing" } } },
    async status() { return { data: structuredClone(statuses) } },
    async messages({ path: { id } }) { return sessions.has(id) ? { data: structuredClone(messages.get(id) ?? []) } : { error: { status: 404, message: "missing" } } },
    async promptAsync({ path: { id }, body }) {
      messages.get(id).push({ info: { id: `prompt-${messages.get(id).length + 1}`, role: "user", time: { created: Date.now() } }, parts: body.parts })
      statuses[id] = { type: "busy" }
      return { data: true }
    },
    async abort({ path: { id } }) {
      if (!sessions.has(id)) return { error: { status: 404, message: "missing" } }
      statuses[id] = { type: "idle" }
      return { data: true }
    },
    async todo() { return { data: [] } },
  }
  const addLead = (id) => {
    sessions.set(id, { id, title: "Lead", time: { created: Date.now(), updated: Date.now() } })
    messages.set(id, [])
    statuses[id] = { type: "idle" }
  }
  return { client: { session }, sessions, statuses, addLead }
}

async function fixture() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-v2-opencode-plane-"))
  await mkdir(path.join(projectRoot, ".team-work", "tasks"), { recursive: true })
  await mkdir(path.join(projectRoot, "requirements"), { recursive: true })
  await writeFile(path.join(projectRoot, ".team-work", "project.json"), `${JSON.stringify({ runtimeMajor: 2, schemaVersion: "2.0" })}\n`)
  await writeFile(path.join(projectRoot, "requirements", "task.md"), "Implement the requested change.\n")
  const sdk = fakeOpenCode()
  sdk.addLead("lead-one")
  sdk.addLead("lead-two")
  const profile = {
    agents: [
      { id: "junior-luna", tier: "junior", resolvedModel: "gateway/luna", costWeight: 1, capabilities: ["*"] },
      { id: "senior-terra", tier: "senior", resolvedModel: "gateway/terra", costWeight: 10, capabilities: ["*"] },
      { id: "expert-opus", tier: "expert", resolvedModel: "gateway/opus", costWeight: 50, capabilities: ["*"] },
    ],
  }
  const createPlane = async () => {
    const executionAdapter = createOpenCodeExecutionAdapter({ client: sdk.client, projectRoot, platformProfile: profile })
    const runtimeHost = createOpenCodeRuntimeHost({
      projectRoot,
      executionAdapter,
      workflowDefinition: await json("workflow/definitions/engineering.json"),
      teamPolicy: await json("team-work/policies/default.json"),
      routeConfig: { spec: { mode: "disabled" }, e2e: { mode: "disabled" } },
      runWaitBudgetMs: 500,
    })
    return { executionAdapter, runtimeHost, handlers: createOpenCodeToolHandlers({ runtimeHost }) }
  }
  return { projectRoot, sdk, createPlane }
}

test("the assembled OpenCode control plane wakes on report and survives a Lead session transfer", async () => {
  const { projectRoot, sdk, createPlane } = await fixture()
  const first = await createPlane()
  const opened = await first.handlers.workflow_open({
    title: "Control plane",
    objective: "Implement the requested change",
    entry_stage: "implementation",
    completion_mode: "through-stage",
    completion_stage: "implementation",
    existing_artifacts: [{ kind: "requirement", path: "requirements/task.md" }],
  }, { sessionID: "lead-one" })
  const planned = await first.handlers.workflow_plan({
    objective: "Implement the requested change",
    execution: "solo",
    budget: "balanced",
    risk: "normal",
  }, { sessionID: "lead-one" })

  const memberSession = [...sdk.sessions.keys()].find((id) => id.startsWith("child-"))
  assert.ok(memberSession, JSON.stringify({ planned, state: JSON.parse(await readFile(path.join(projectRoot, ".team-work", "tasks", opened.task.id, "state.json"), "utf8")) }))
  const binding = await first.executionAdapter.resolveMemberBinding(memberSession)
  const statePath = path.join(projectRoot, ".team-work", "tasks", opened.task.id, "state.json")
  const before = JSON.parse(await readFile(statePath, "utf8"))
  const assignment = before.workGraph.assignments.find(({ assignmentId }) => assignmentId === binding.assignmentId)
  await mkdir(path.join(projectRoot, "src"), { recursive: true })
  await writeFile(path.join(projectRoot, "src", "control-plane.mjs"), "export const ready = true\n")

  const abort = new AbortController()
  const waiting = first.handlers.workflow_run({}, { sessionID: "lead-one", abort: abort.signal })
  await new Promise((resolve) => setImmediate(resolve))
  await first.handlers.team_work_report({
    outcome: "delivered",
    summary: "Implemented through the assembled control plane.",
    artifacts: [{ ref: assignment.writableRefs[0], path: "src/control-plane.mjs" }],
    evidence_refs: [],
    recommendation: "accept",
  }, { sessionID: memberSession })
  setTimeout(() => abort.abort(), 20)
  await waiting
  const progressed = JSON.parse(await readFile(statePath, "utf8"))
  assert.equal(progressed.workGraph.assignments.find(({ assignmentId }) => assignmentId === binding.assignmentId).status, "accepted")

  const restarted = await createPlane()
  await restarted.handlers.workflow_open({ task_id: opened.task.id, existing_artifacts: [] }, { sessionID: "lead-two" })
  const stopped = new AbortController()
  stopped.abort()
  assert.equal((await restarted.handlers.workflow_run({}, { sessionID: "lead-two", abort: stopped.signal })).task.id, opened.task.id)
  assert.equal((await first.runtimeHost.run("lead-one", { signal: stopped.signal })).code, "TASK_SELECTION_REQUIRED")
})
