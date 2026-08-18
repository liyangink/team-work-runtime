import assert from "node:assert/strict"
import test from "node:test"

import { composeActionCard, visibleCodePointLength } from "../../../runtime/application/action-card.mjs"
import { validateContract } from "../../../runtime/contracts.mjs"
import { createTaskAggregate } from "../../../runtime/domain/index.mjs"

const workflowDefinition = {
  schemaVersion: "2.0",
  workflowId: "engineering",
  version: "2026-08-18",
  terminalStages: ["design"],
  gates: [],
  stages: [{
    id: "design",
    label: "方案设计",
    requiredInputs: ["requirement"],
    outputs: ["design"],
    assignmentKind: "design",
    teamScene: "design",
    planning: "required",
  }],
  edges: [],
}

const aggregateWorkflow = {
  workflowId: workflowDefinition.workflowId,
  version: workflowDefinition.version,
  digest: "a".repeat(64),
  stages: workflowDefinition.stages.map(({ id }) => id),
  edges: workflowDefinition.edges,
  terminalStages: workflowDefinition.terminalStages,
}

function taskState(overrides = {}) {
  return {
    ...createTaskAggregate({
      taskId: "action-card",
      title: "实现 ActionCard composer",
      objective: "为 Lead 生成简短且确定的工作视图",
      workflow: aggregateWorkflow,
      entryStage: "design",
      completion: { mode: "workflow" },
      stageRunId: "stage-run-1",
      createdAt: "2026-08-18T10:00:00.000Z",
    }),
    ...overrides,
  }
}

test("the composer projects a schema-valid deterministic plan card without runtime internals", () => {
  const input = { taskState: taskState(), workflowDefinition, reason: "needs-plan" }
  const first = composeActionCard(input)
  const second = composeActionCard(input)

  validateContract("https://team-work-runtime.dev/schemas/v2/runtime-card", first, "action card")
  assert.deepEqual(first, second)
  assert.equal(first.task.stageLabel, "方案设计")
  assert.deepEqual(first.next, { kind: "plan", instruction: "说明目标、约束和偏好。" })
  assert.equal(visibleCodePointLength(first) <= 2_000, true)
  assert.doesNotMatch(JSON.stringify(first), /revision|session|assignment|gateId/i)
})

test("the composer uses a single wait action while background work is progressing", () => {
  const card = composeActionCard({
    taskState: taskState({ status: "working" }),
    workflowDefinition,
    reason: "waiting-report",
  })

  assert.equal(card.next.kind, "wait")
  assert.equal("reason" in card.next, false)
})

test("the composer renders an explicit decision as the only next action", () => {
  const card = composeActionCard({
    taskState: taskState({ status: "working" }),
    workflowDefinition,
    reason: "stable",
    decision: {
      summary: "方案已准备好，等待确认。",
      packetRef: ".team-work/tasks/action-card/packets/design.json",
      question: "是否批准当前方案？",
      choices: [{ value: "approve", label: "批准", impact: "继续实施" }, { value: "rework", label: "返工" }],
      disagreement: "审查意见要求先明确边界。",
    },
  })

  assert.equal(card.next.kind, "steer")
  assert.equal(card.next.choices.length, 2)
  assert.deepEqual(card.decision, {
    summary: "方案已准备好，等待确认。",
    packetRef: ".team-work/tasks/action-card/packets/design.json",
  })
  assert.equal(card.report.disagreement, "审查意见要求先明确边界。")
})

test("the composer caps derived lists and returns a budget problem for an unshortenable decision", () => {
  const artifacts = Array.from({ length: 7 }, (_, index) => ({
    artifactId: `design-${index}`,
    kind: "design",
    path: `docs/design-${index}.md`,
    digest: `${index}`.repeat(64),
    stageRunId: "stage-run-1",
    recordedAt: "2026-08-18T10:00:00.000Z",
  }))
  const capped = composeActionCard({
    taskState: taskState({ artifacts }),
    workflowDefinition,
    reason: "stable",
  })
  assert.equal(capped.report.artifacts.length, 5)
  assert.equal(capped.report.conclusions.length <= 3, true)
  assert.equal(capped.report.risks.length <= 3, true)

  const tooLarge = composeActionCard({
    taskState: taskState({ status: "working" }),
    workflowDefinition,
    reason: "budget-decision",
    decision: {
      summary: "需要用户决定。",
      packetRef: ".team-work/tasks/action-card/packets/decision.json",
      question: "要如何处理？".repeat(1_000),
      choices: ["approve"],
    },
  })
  assert.equal(tooLarge.code, "CONTEXT_BUDGET_EXCEEDED")
  validateContract("https://team-work-runtime.dev/schemas/v2/runtime-card", tooLarge, "budget problem")
})
