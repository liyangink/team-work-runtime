import assert from "node:assert/strict"
import test from "node:test"
import { deterministicSessionId, buildDispatchLabel } from "../dsh/tw-dispatch.js"

test("标签只影响展示，不改变派单身份或跨任务寻址", () => {
  const wave = { dispatchKey: "d1-example", role: "owner", round: 1 }
  const plan = { task: "task-example", stage: "code-review" }
  const labelA = buildDispatchLabel(plan, wave, "初次审查")
  const labelB = buildDispatchLabel(plan, wave, "改名展示")
  assert.notEqual(labelA, labelB)
  assert.match(deterministicSessionId(plan.task, wave.dispatchKey), /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
  assert.notEqual(deterministicSessionId("other-task", wave.dispatchKey), deterministicSessionId(plan.task, wave.dispatchKey))
})
