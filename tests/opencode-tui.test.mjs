import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { loadTeamPanel, loadTeamPanelSync, resolvePanelProjectRoot } from "../plugins/opencode/tui/team-sessions.mjs"
import { createTeamWorkTui } from "../plugins/opencode/tui/team-tui-plugin.mjs"

async function fixture() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-tui-"))
  const taskId = "task-ui"
  const platform = path.join(projectRoot, ".team-work/platform/opencode/v2")
  await mkdir(path.join(platform, "bindings/by-session"), { recursive: true })
  await mkdir(path.join(platform, "bindings/by-task"), { recursive: true })
  await mkdir(path.join(platform, "sessions"), { recursive: true })
  await mkdir(path.join(projectRoot, ".team-work/tasks", taskId), { recursive: true })
  const binding = { bindingRef: "binding-1", taskId, platform: "opencode", hostSessionRef: "lead-1" }
  await writeFile(path.join(platform, "bindings/by-session/lead-1.json"), `${JSON.stringify(binding)}\n`)
  await writeFile(path.join(platform, `bindings/by-task/${taskId}.json`), `${JSON.stringify(binding)}\n`)
  const assignments = [
    {
      assignmentId: "owner-1", teamRole: "owner", assignmentKind: "implementation", status: "running",
      attempts: [{ executionRef: "child-busy" }],
    },
    {
      assignmentId: "review-1", teamRole: "challenger", assignmentKind: "review", status: "accepted",
      attempts: [{ executionRef: "child-idle" }],
    },
  ]
  await writeFile(path.join(projectRoot, `.team-work/tasks/${taskId}/state.json`), `${JSON.stringify({
    schemaVersion: "2.0", taskId, workGraph: { assignments },
  })}\n`)
  for (const projection of [
    { executionRef: "child-busy", assignmentId: "owner-1", agentId: "junior-flash", updatedAt: "2026-08-13T08:03:00.000Z" },
    { executionRef: "child-idle", assignmentId: "review-1", agentId: "senior-terra", updatedAt: "2026-08-13T08:02:00.000Z" },
  ]) {
    await writeFile(path.join(platform, `sessions/${projection.executionRef}.json`), `${JSON.stringify({ taskId, ...projection })}\n`)
  }
  return { projectRoot, taskId, platform }
}

async function replaceDirectoryWithExternalSymlink(projectRoot, relativePath) {
  const source = path.join(projectRoot, relativePath)
  const outside = await mkdtemp(path.join(os.tmpdir(), "team-work-tui-outside-"))
  const relocated = path.join(outside, "directory")
  await rename(source, relocated)
  await symlink(relocated, source)
}

test("Team sidebar uses the current directory for a non-VCS filesystem-root worktree", () => {
  assert.equal(resolvePanelProjectRoot({ directory: "/tmp/project", worktree: "/" }), path.resolve("/tmp/project"))
  assert.equal(resolvePanelProjectRoot({ directory: "/repo/subdir", worktree: "/repo" }), path.resolve("/repo"))
})

test("Team sidebar resolves the V2 Lead binding and authoritative work graph", async () => {
  const { projectRoot, taskId } = await fixture()
  const panel = await loadTeamPanel({
    projectRoot,
    currentSessionId: "lead-1",
    statusFor: (sessionId) => sessionId === "child-busy" ? { type: "busy" } : { type: "idle" },
  })

  assert.equal(panel.taskId, taskId)
  assert.equal(panel.leadSessionId, "lead-1")
  assert.deepEqual(panel.members.map(({ assignmentId, status, title, navigable }) => ({ assignmentId, status, title, navigable })), [
    { assignmentId: "owner-1", status: "busy", title: "owner · implementation", navigable: true },
    { assignmentId: "review-1", status: "idle", title: "challenger · review", navigable: true },
  ])
})

test("Team sidebar synchronous snapshot matches the validated async projection", async () => {
  const { projectRoot } = await fixture()
  const input = {
    projectRoot,
    currentSessionId: "lead-1",
    statusFor: (sessionId) => sessionId === "child-busy" ? { type: "busy" } : { type: "idle" },
  }
  assert.deepEqual(loadTeamPanelSync(input), await loadTeamPanel(input))
})

test("Team sidebar keeps the same task visible after navigating into a member session", async () => {
  const { projectRoot, taskId } = await fixture()
  const panel = await loadTeamPanel({ projectRoot, currentSessionId: "child-idle", statusFor: () => ({ type: "idle" }) })
  assert.equal(panel.taskId, taskId)
  assert.equal(panel.leadSessionId, "lead-1")
  assert.equal(panel.members.find(({ sessionId }) => sessionId === "child-idle").focused, true)
})

test("Team sidebar preserves stopped and lost assignments without inventing live status", async () => {
  const { projectRoot, taskId, platform } = await fixture()
  const statePath = path.join(projectRoot, `.team-work/tasks/${taskId}/state.json`)
  const state = JSON.parse(await readFile(statePath, "utf8"))
  state.workGraph.assignments[1].status = "blocked"
  state.workGraph.assignments.push({
    assignmentId: "expert-1", teamRole: "expert", assignmentKind: "review", status: "lost",
    attempts: [{ executionRef: "child-lost" }],
  })
  await writeFile(statePath, `${JSON.stringify(state)}\n`)
  await writeFile(path.join(platform, "sessions/child-lost.json"), `${JSON.stringify({
    taskId, assignmentId: "expert-1", executionRef: "child-lost", agentId: "expert-opus", updatedAt: "2026-08-13T08:05:00.000Z",
  })}\n`)

  const panel = await loadTeamPanel({ projectRoot, currentSessionId: "lead-1", statusFor: () => ({ type: "busy" }) })
  assert.equal(panel.members.find(({ assignmentId }) => assignmentId === "review-1").status, "stopped")
  assert.equal(panel.members.find(({ assignmentId }) => assignmentId === "review-1").navigable, true)
  assert.equal(panel.members.find(({ assignmentId }) => assignmentId === "expert-1").status, "lost")
  assert.equal(panel.members.find(({ assignmentId }) => assignmentId === "expert-1").navigable, false)
})

test("Team sidebar rejects conflicting Lead and member task bindings", async () => {
  const { projectRoot, platform } = await fixture()
  await writeFile(path.join(platform, "sessions/lead-1.json"), `${JSON.stringify({
    taskId: "task-other", assignmentId: "owner-other", executionRef: "lead-1", agentId: "junior-flash",
  })}\n`)
  assert.equal(await loadTeamPanel({ projectRoot, currentSessionId: "lead-1" }), null)
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

  assert.equal(registration.order, 350)
  assert.equal(output, "team-sidebar")
  assert.deepEqual(rendered, [{ api, context: { theme: "theme" }, sessionId: "child-1" }])
})

test("Team sidebar follows official reactive session state without timers or event subscriptions", async () => {
  const source = await readFile(path.join(import.meta.dirname, "../plugins/opencode/tui/team-sidebar.tsx"), "utf8")
  assert.match(source, /createMemo/)
  assert.match(source, /state\.session\.count\(\)/)
  assert.doesNotMatch(source, /createEffect|createSignal|setInterval|\.event\.on\(/)
  assert.match(source, /loadTeamPanelSync/)
  assert.doesNotMatch(source, /glyph:\s*"\?"/)
  assert.match(source, /状态未载入/)
})

test("disabled OpenCode platform does not register the Team sidebar", async () => {
  let registrations = 0
  const tui = createTeamWorkTui(() => "team-sidebar", { isEnabled: async () => false })
  await tui({ slots: { register: () => { registrations += 1 } } })
  assert.equal(registrations, 0)
})

test("Team sidebar never follows V2 platform roots outside the project", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-tui-"))
  const outside = await mkdtemp(path.join(os.tmpdir(), "team-work-tui-outside-"))
  await mkdir(path.join(projectRoot, ".team-work/platform/opencode"), { recursive: true })
  await symlink(outside, path.join(projectRoot, ".team-work/platform/opencode/v2"))
  assert.equal(await loadTeamPanel({ projectRoot, currentSessionId: "lead-1" }), null)
})

test("Team sidebar rejects every symlinked binding, session, and task directory", async () => {
  for (const relativePath of [
    ".team-work/platform/opencode/v2/bindings",
    ".team-work/platform/opencode/v2/bindings/by-session",
    ".team-work/platform/opencode/v2/bindings/by-task",
    ".team-work/platform/opencode/v2/sessions",
    ".team-work/tasks",
    ".team-work/tasks/task-ui",
  ]) {
    const { projectRoot } = await fixture()
    await replaceDirectoryWithExternalSymlink(projectRoot, relativePath)
    assert.equal(await loadTeamPanel({ projectRoot, currentSessionId: "lead-1" }), null, relativePath)
    assert.equal(loadTeamPanelSync({ projectRoot, currentSessionId: "lead-1" }), null, relativePath)
  }
})
