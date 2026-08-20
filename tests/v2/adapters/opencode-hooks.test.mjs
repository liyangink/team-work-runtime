import assert from "node:assert/strict"
import test from "node:test"

import { createOpenCodeHooks } from "../../../plugins/opencode/context/hooks.mjs"

test("OpenCode hooks persist member checks and enforce managed session boundaries", async () => {
  const calls = []
  const executionAdapter = {
    resolveMemberBinding: async (id) => id === "member" ? { taskId: "task-1" } : null,
    resolveHelperBinding: async (id) => id === "helper" ? { taskId: "task-1" } : null,
    captureCheck: async (input) => calls.push(["capture", input]),
    recordCheck: async (input) => calls.push(["record", input]),
    handleEvent: async (event) => calls.push(["event", event]),
  }
  const contextHooks = { contextForSession: async () => "bounded context" }
  const hooks = createOpenCodeHooks({ executionAdapter, contextHooks })

  await hooks["tool.execute.before"]({ tool: "shell", sessionID: "member", callID: "call-1" }, { args: { command: "npm test" } })
  await hooks["tool.execute.after"](
    { tool: "shell", sessionID: "member", callID: "call-1", args: { command: "npm test" } },
    { title: "npm test", output: "ok", metadata: { exit: 0 } },
  )
  assert.deepEqual(calls.slice(0, 2), [
    ["capture", { sessionId: "member", toolCallRef: "call-1" }],
    ["record", { sessionId: "member", toolCallRef: "call-1", commandSummary: "npm test", exitCode: 0 }],
  ])
  await assert.rejects(
    hooks["tool.execute.before"]({ tool: "task", sessionID: "member", callID: "call-2" }, { args: {} }),
    /受管成员由 Runtime 后台派发/,
  )
  await assert.rejects(
    hooks["tool.execute.before"]({ tool: "apply_patch", sessionID: "helper", callID: "call-3" }, { args: {} }),
    /只读 Helper/,
  )
})

test("OpenCode hooks inject bounded context and suppress synthetic continuation while awaiting a user", async () => {
  const contextHooks = { contextForSession: async () => "bounded context" }
  const runtimeHost = { describeSession: async () => ({ kind: "lead", status: "awaiting-user" }) }
  const hooks = createOpenCodeHooks({
    executionAdapter: { resolveMemberBinding: async () => null, resolveHelperBinding: async () => null, handleEvent: async () => false },
    contextHooks,
    runtimeHost,
  })
  const system = { system: [] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "lead" }, system)
  assert.deepEqual(system.system, ["bounded context"])
  const compacting = { context: [] }
  await hooks["experimental.session.compacting"]({ sessionID: "lead" }, compacting)
  assert.deepEqual(compacting.context, ["bounded context"])
  const continuation = { enabled: true }
  await hooks["experimental.compaction.autocontinue"]({ sessionID: "lead" }, continuation)
  assert.equal(continuation.enabled, false)
})

test("member file writes are rejected outside the assignment writable scope", async () => {
  const executionAdapter = {
    resolveMemberBinding: async (id) => id === "member" ? { taskId: "task-1" } : null,
  }
  const contextHooks = { contextForSession: async () => null }
  const scopes = new Map([
    ["writer", ["docs/report.md"]],
    ["reviewer", []],
  ])
  const runtimeHost = { describeSession: async (id) => (scopes.has(id) ? { kind: "member", writablePaths: scopes.get(id) } : { kind: "member" }) }
  const bindingAdapter = {
    resolveMemberBinding: async (id) => (scopes.has(id) ? { taskId: "task-1" } : null),
  }
  const hooks = createOpenCodeHooks({ executionAdapter: bindingAdapter, contextHooks, runtimeHost, projectRoot: "/project" })

  await hooks["tool.execute.before"]({ tool: "edit", sessionID: "writer", callID: "w1", args: { filePath: "docs/report.md" } }, { args: { filePath: "docs/report.md" } })
  // 成员常用项目内绝对路径，必须归一化到项目相对后再比对
  await hooks["tool.execute.before"]({ tool: "edit", sessionID: "writer", callID: "w1b", args: { filePath: "/project/docs/report.md" } }, { args: {} })
  await hooks["tool.execute.before"]({ tool: "write", sessionID: "writer", callID: "w2", args: { filePath: "./docs/report.md" } }, { args: {} })
  await assert.rejects(
    hooks["tool.execute.before"]({ tool: "edit", sessionID: "writer", callID: "w3", args: { filePath: "src/main.mjs" } }, { args: {} }),
    /TEAM_WORK_MEMBER_WRITE_OUT_OF_SCOPE/,
  )
  await assert.rejects(
    hooks["tool.execute.before"]({ tool: "apply_patch", sessionID: "reviewer", callID: "r1", args: { patch: "*** Begin Patch\n*** Update File: docs/report.md\n@@\n-x\n+y\n*** End Patch" } }, { args: {} }),
    /只读派单/,
  )
  await assert.rejects(
    hooks["tool.execute.before"]({ tool: "write", sessionID: "reviewer", callID: "r2", args: { filePath: "docs/report.md" } }, { args: {} }),
    /TEAM_WORK_MEMBER_WRITE_OUT_OF_SCOPE/,
  )
})
