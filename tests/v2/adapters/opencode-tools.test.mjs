import assert from "node:assert/strict"
import test from "node:test"

import { createOpenCodeToolHandlers, LEAD_TOOL_NAMES, TOOL_DESCRIPTIONS } from "../../../plugins/opencode/tools/index.mjs"

test("the OpenCode Lead control surface contains only four intent tools", () => {
  assert.deepEqual(LEAD_TOOL_NAMES, ["workflow_open", "workflow_plan", "workflow_run", "workflow_steer"])
  const forbidden = /revision|gate|work[-_ ]?item|session|SPEC command|恢复命令/i
  for (const name of LEAD_TOOL_NAMES) assert.doesNotMatch(TOOL_DESCRIPTIONS[name], forbidden)
  assert.match(TOOL_DESCRIPTIONS.workflow_open, /mode=create\|resume/)
})

test("OpenCode tool handlers translate only user intent and bind identity from tool context", async () => {
  const calls = []
  const runtimeHost = {
    open: async (...args) => (calls.push(["open", ...args]), { ok: true }),
    plan: async (...args) => (calls.push(["plan", ...args]), { ok: true }),
    run: async (...args) => (calls.push(["run", ...args]), { ok: true }),
    steer: async (...args) => (calls.push(["steer", ...args]), { ok: true }),
    report: async (...args) => (calls.push(["report", ...args]), { ok: true }),
  }
  const handlers = createOpenCodeToolHandlers({ runtimeHost })
  const abort = new AbortController().signal
  await handlers.workflow_open({
    mode: "create",
    title: "Task",
    objective: "Implement it",
    entry_stage: "implementation",
    completion_mode: "through-stage",
    completion_stage: "implementation",
    existing_artifacts: [{ kind: "requirement", path: "requirements/task.md" }],
  }, { sessionID: "lead-1" })
  await handlers.workflow_plan({ objective: "Implement it", execution: "solo", budget: "economy", risk: "normal" }, { sessionID: "lead-1" })
  await handlers.workflow_run({}, { sessionID: "lead-1", abort })
  await handlers.workflow_steer({ action: "choose", directive: "accept" }, { sessionID: "lead-1" })
  await handlers.team_work_report({
    outcome: "delivered",
    summary: "Done",
    artifacts: [{ ref: "artifact:source", path: "src/result.mjs" }],
    evidence_refs: [],
    recommendation: "accept",
  }, { sessionID: "member-1" })

  assert.deepEqual(calls[0], ["open", "lead-1", {
    title: "Task",
    objective: "Implement it",
    entryStage: "implementation",
    completion: { mode: "through-stage", stage: "implementation" },
    existingArtifacts: [{ kind: "requirement", locator: { type: "project-path", value: "requirements/task.md" } }],
  }])
  assert.deepEqual(calls[1], ["plan", "lead-1", {
    objective: "Implement it",
    preferences: { execution: "solo", budget: "economy", risk: "normal" },
  }])
  assert.deepEqual(calls[2], ["run", "lead-1", { signal: abort }])
  assert.deepEqual(calls[3], ["steer", "lead-1", { action: "choose", directive: "accept" }])
  assert.equal(calls[4][0], "report")
  assert.equal(calls[4][1], "member-1")
  assert.deepEqual(calls[4][2].evidenceRefs, [])
})

test("workflow_open defaults a new task to the full workflow", async () => {
  const calls = []
  const handlers = createOpenCodeToolHandlers({
    runtimeHost: {
      async open(sessionId, input) { calls.push({ sessionId, input }); return { ok: true } },
    },
  })

  await handlers.workflow_open({ mode: "create", title: "Default workflow", objective: "Deliver it", existing_artifacts: [] }, { sessionID: "lead-default" })
  assert.deepEqual(calls, [{
    sessionId: "lead-default",
    input: { title: "Default workflow", objective: "Deliver it", completion: { mode: "workflow" }, existingArtifacts: [] },
  }])
  assert.throws(
    () => handlers.workflow_open({ mode: "create", title: "Partial", objective: "Review it", completion_mode: "through-stage" }, { sessionID: "lead-default" }),
    /completion_stage is required/,
  )
  await handlers.workflow_open({
    mode: "create",
    task_id: "provider-filled-placeholder",
    title: "Provider-safe creation",
    objective: "Create despite an irrelevant task id",
    completion_mode: "workflow",
    existing_artifacts: [],
  }, { sessionID: "lead-default" })
  assert.deepEqual(calls[1], {
    sessionId: "lead-default",
    input: {
      title: "Provider-safe creation",
      objective: "Create despite an irrelevant task id",
      completion: { mode: "workflow" },
      existingArtifacts: [],
    },
  })
  assert.throws(
    () => handlers.workflow_open({ mode: "create", completion_mode: "workflow", existing_artifacts: [] }, { sessionID: "lead-default" }),
    (error) => error.code === "OPEN_INPUT_REQUIRED" && /title 和 objective/.test(error.message),
  )
  await handlers.workflow_open({ mode: "resume", task_id: "existing-task", title: "ignored", objective: "ignored" }, { sessionID: "lead-default" })
  assert.deepEqual(calls[2], { sessionId: "lead-default", input: { taskId: "existing-task" } })
  assert.throws(
    () => handlers.workflow_open({ mode: "resume" }, { sessionID: "lead-default" }),
    (error) => error.code === "OPEN_INPUT_REQUIRED" && /task_id/.test(error.message),
  )
})
