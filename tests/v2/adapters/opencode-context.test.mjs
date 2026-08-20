import assert from "node:assert/strict"
import test from "node:test"

import { createOpenCodeContextHooks } from "../../../plugins/opencode/context/index.mjs"

test("OpenCode context hooks inject one bounded role projection", async () => {
  const runtimeHost = {
    describeSession: async (sessionId) => sessionId === "lead-1" ? {
      kind: "lead",
      taskId: "task-1",
      title: "Implement feature",
      stage: "implementation",
      status: "working",
      taskRoot: ".team-work/tasks/task-1",
    } : {
      kind: "member",
      taskId: "task-1",
      assignmentId: "owner-1",
      role: "owner",
      stage: "implementation",
      contextRef: ".team-work/tasks/task-1/context/owner-1.md",
      promptRef: ".team-work/tasks/task-1/prompts/owner-1.md",
    },
  }
  const hooks = createOpenCodeContextHooks({ runtimeHost })
  const lead = await hooks.contextForSession("lead-1")
  const member = await hooks.contextForSession("member-1")

  assert.match(lead, /只负责推进流程/)
  assert.match(lead, /workflow_run/)
  assert.doesNotMatch(lead, /revision|pendingOperations|workGraph/)
  assert.match(member, /team_work_report/)
  assert.match(member, /context\/owner-1\.md/)
  assert.ok(lead.length < 1_500)
  assert.ok(member.length < 1_500)
})

test("unmanaged sessions receive no team-work context", async () => {
  const hooks = createOpenCodeContextHooks({ runtimeHost: { describeSession: async () => null } })
  assert.equal(await hooks.contextForSession("standalone"), null)
})
