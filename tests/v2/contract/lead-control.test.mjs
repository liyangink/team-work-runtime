import assert from "node:assert/strict"
import test from "node:test"

import { ContractError, createLeadControl } from "../../../runtime/index.mjs"

const actionCard = {
  cardId: "card-1",
  task: {
    id: "task-1",
    title: "Review existing code",
    stage: "code-review",
    stageLabel: "代码审查",
    status: "needs-plan",
  },
  report: {
    completed: [],
    current: "等待计划",
    conclusions: [],
    artifacts: [],
    risks: [],
  },
  next: { kind: "plan", instruction: "提交目标与约束" },
}

test("LeadControl validates a small open intent and returns one RuntimeCard", async () => {
  const calls = []
  const control = createLeadControl({
    open: async (input) => {
      calls.push(input)
      return actionCard
    },
    plan: async () => actionCard,
    run: async () => actionCard,
    steer: async () => actionCard,
  })

  const result = await control.open({
    taskId: "task-1",
    entryStage: "code-review",
    completion: { mode: "through-stage", stage: "code-review" },
    existingArtifacts: [{
      kind: "source",
      locator: { type: "git-revision", value: "HEAD" },
    }],
  })

  assert.deepEqual(result, actionCard)
  assert.equal(calls.length, 1)
})

test("LeadControl rejects orchestration fields before invoking a handler", async () => {
  let called = false
  const control = createLeadControl({
    open: async () => {
      called = true
      return actionCard
    },
    plan: async () => actionCard,
    run: async () => actionCard,
    steer: async () => actionCard,
  })

  await assert.rejects(
    control.open({ taskId: "task-1", agentId: "expert-opus" }),
    (error) => error instanceof ContractError && error.code === "CONTRACT_INVALID",
  )
  assert.equal(called, false)
})

test("LeadControl rejects invalid RuntimeCards and run arguments at the public boundary", async () => {
  const control = createLeadControl({
    open: async () => actionCard,
    plan: async () => ({ ...actionCard, next: { kind: "run", instruction: "continue", sessionId: "private" } }),
    run: async () => actionCard,
    steer: async () => actionCard,
  })

  await assert.rejects(control.plan({ objective: "continue" }), ContractError)
  await assert.rejects(control.run({ waitMs: 1000 }), ContractError)
})
