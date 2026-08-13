import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { loadTeamPanel } from "../plugins/opencode/tui/team-sessions.mjs"
import { createTeamWorkTui } from "../plugins/opencode/tui/team-tui-plugin.mjs"

async function fixture() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-tui-"))
  const taskId = "task-ui"
  const mappingRoot = path.join(projectRoot, ".team-work/platform/opencode/sessions", taskId)
  const bindingRoot = path.join(projectRoot, ".team-work/bindings/opencode")
  await mkdir(mappingRoot, { recursive: true })
  await mkdir(bindingRoot, { recursive: true })
  await writeFile(path.join(bindingRoot, "lead-1.json"), `${JSON.stringify({
    schemaVersion: "1.0",
    platform: "opencode",
    sessionKey: "lead-1",
    taskId,
    revision: 0,
    boundAt: "2026-08-13T08:00:00.000Z",
    updatedAt: "2026-08-13T08:00:00.000Z",
  })}\n`)
  for (const mapping of [
    {
      schemaVersion: "1.0", platform: "opencode", taskId, workItemId: "owner-1",
      parentSessionId: "lead-1", sessionId: "child-busy", agent: "junior-flash",
      contextProfile: "implement", dispatchMode: "background",
      createdAt: "2026-08-13T08:01:00.000Z", updatedAt: "2026-08-13T08:03:00.000Z",
    },
    {
      schemaVersion: "1.0", platform: "opencode", taskId, workItemId: "review-1",
      parentSessionId: "lead-1", sessionId: "child-idle", agent: "senior-terra",
      contextProfile: "check", dispatchMode: "background",
      createdAt: "2026-08-13T08:02:00.000Z", updatedAt: "2026-08-13T08:02:00.000Z",
    },
  ]) {
    await writeFile(path.join(mappingRoot, `${mapping.workItemId}.json`), `${JSON.stringify(mapping)}\n`)
  }
  return { projectRoot, taskId }
}

test("Team sidebar resolves the bound task and presents live managed sessions", async () => {
  const { projectRoot, taskId } = await fixture()
  const sessions = new Map([
    ["child-busy", { id: "child-busy", title: "实现消息重试" }],
    ["child-idle", { id: "child-idle", title: "挑战实现方案" }],
  ])
  const panel = await loadTeamPanel({
    projectRoot,
    currentSessionId: "lead-1",
    statusFor: (sessionId) => sessionId === "child-busy" ? { type: "busy" } : { type: "idle" },
    sessionFor: (sessionId) => sessions.get(sessionId),
  })

  assert.equal(panel.taskId, taskId)
  assert.equal(panel.leadSessionId, "lead-1")
  assert.deepEqual(panel.members.map(({ workItemId, status, title, navigable }) => ({ workItemId, status, title, navigable })), [
    { workItemId: "owner-1", status: "busy", title: "实现消息重试", navigable: true },
    { workItemId: "review-1", status: "idle", title: "挑战实现方案", navigable: true },
  ])
})

test("Team sidebar keeps the same task visible after navigating into a child session", async () => {
  const { projectRoot, taskId } = await fixture()
  const panel = await loadTeamPanel({
    projectRoot,
    currentSessionId: "child-idle",
    statusFor: () => ({ type: "idle" }),
    sessionFor: (sessionId) => ({ id: sessionId }),
  })

  assert.equal(panel.taskId, taskId)
  assert.equal(panel.leadSessionId, "lead-1")
  assert.equal(panel.members.find(({ sessionId }) => sessionId === "child-idle").focused, true)
})

test("Team sidebar preserves stopped and lost mappings without inventing live status", async () => {
  const { projectRoot } = await fixture()
  const mappingRoot = path.join(projectRoot, ".team-work/platform/opencode/sessions/task-ui")
  const stopped = JSON.parse(await readFile(path.join(mappingRoot, "review-1.json"), "utf8"))
  await writeFile(path.join(mappingRoot, "review-1.json"), `${JSON.stringify({ ...stopped, stoppedAt: "2026-08-13T08:04:00.000Z" })}\n`)
  const lost = { ...stopped, workItemId: "expert-1", sessionId: "child-lost", agent: "expert-opus", lostRecordedAt: "2026-08-13T08:05:00.000Z" }
  await writeFile(path.join(mappingRoot, "expert-1.json"), `${JSON.stringify(lost)}\n`)

  const panel = await loadTeamPanel({
    projectRoot,
    currentSessionId: "lead-1",
    statusFor: () => ({ type: "busy" }),
    sessionFor: () => undefined,
  })

  assert.equal(panel.members.find(({ workItemId }) => workItemId === "review-1").status, "stopped")
  assert.equal(panel.members.find(({ workItemId }) => workItemId === "review-1").navigable, true)
  assert.equal(panel.members.find(({ workItemId }) => workItemId === "expert-1").status, "lost")
  assert.equal(panel.members.find(({ workItemId }) => workItemId === "expert-1").navigable, false)
})

test("Team sidebar refuses ambiguous parent mappings and ignores malformed files", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "team-work-tui-"))
  for (const [taskId, workItemId] of [["task-a", "owner-a"], ["task-b", "owner-b"]]) {
    const root = path.join(parent, ".team-work/platform/opencode/sessions", taskId)
    await mkdir(root, { recursive: true })
    await writeFile(path.join(root, `${workItemId}.json`), `${JSON.stringify({
      schemaVersion: "1.0", platform: "opencode", taskId, workItemId,
      parentSessionId: "lead-shared", sessionId: `child-${taskId}`, agent: "junior-flash",
      contextProfile: "implement", dispatchMode: "background",
      createdAt: "2026-08-13T08:00:00.000Z", updatedAt: "2026-08-13T08:00:00.000Z",
    })}\n`)
    await writeFile(path.join(root, "broken.json"), "{not-json\n")
  }

  assert.equal(await loadTeamPanel({ projectRoot: parent, currentSessionId: "lead-shared" }), null)
})

test("OpenCode TUI submodule registers one sidebar slot and passes the selected session", async () => {
  let registration
  const rendered = []
  const tui = createTeamWorkTui((props) => {
    rendered.push(props)
    return "team-sidebar"
  })
  const api = { slots: { register: (value) => { registration = value } } }

  await tui(api)
  const output = registration.slots.sidebar_content({ theme: "theme" }, { session_id: "child-1" })

  assert.equal(registration.order, 300)
  assert.equal(output, "team-sidebar")
  assert.deepEqual(rendered, [{ api, context: { theme: "theme" }, sessionId: "child-1" }])
})

test("Team sidebar never follows task mapping or binding roots outside the project", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-tui-"))
  const outside = await mkdtemp(path.join(os.tmpdir(), "team-work-tui-outside-"))
  const outsideTask = path.join(outside, "task-outside")
  await mkdir(outsideTask, { recursive: true })
  await writeFile(path.join(outsideTask, "owner-1.json"), `${JSON.stringify({
    schemaVersion: "1.0", platform: "opencode", taskId: "task-outside", workItemId: "owner-1",
    parentSessionId: "lead-1", sessionId: "child-1", agent: "junior-flash",
    contextProfile: "implement", dispatchMode: "background",
    createdAt: "2026-08-13T08:00:00.000Z", updatedAt: "2026-08-13T08:00:00.000Z",
  })}\n`)
  await mkdir(path.join(projectRoot, ".team-work/platform/opencode"), { recursive: true })
  await symlink(outside, path.join(projectRoot, ".team-work/platform/opencode/sessions"))

  assert.equal(await loadTeamPanel({ projectRoot, currentSessionId: "lead-1" }), null)
})
