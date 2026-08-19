import assert from "node:assert/strict"
import test from "node:test"

import {
  composeDecisionPacket,
  decisionPacketCodePointLength,
  decisionPacketRef,
} from "../../../runtime/application/decision-packet.mjs"

function fixture(summary = "Owner 完成交付，挑战者要求补齐失败路径证据。") {
  const attempt = { stageRunId: "stage-run-2" }
  const assignment = {
    assignmentId: "challenger-review",
    teamRole: "challenger",
    assignmentKind: "review",
    costTier: "senior",
    status: "accepted",
    attempts: [attempt],
    execution: { agentId: "senior-terra" },
  }
  return {
    taskState: {
      taskId: "packet-task",
      revision: 17,
      currentStageRun: { stageRunId: "stage-run-2", stage: "code-review", round: 2 },
      stageRuns: [{ stageRunId: "stage-run-1", stage: "code-review", round: 1, status: "rework", reason: "缺少失败路径证据" }],
      artifacts: [{ artifactId: "review", path: "reviews/code-review.md" }],
    },
    decision: {
      decisionId: "review-decision",
      question: "是否按当前审查结论返工？",
      artifactRefs: ["review"],
      choices: ["accept", "rework"],
    },
    reports: [{
      assignment,
      report: {
        summary,
        recommendation: "rework",
        evidenceRefs: ["report:owner-delivery"],
      },
    }],
  }
}

test("DecisionPacket is a deterministic bounded projection of current decision facts", () => {
  const first = composeDecisionPacket(fixture())
  const second = composeDecisionPacket(fixture())

  assert.deepEqual(first, second)
  assert.equal(first.version, 18)
  assert.equal(first.roster[0].role, "challenger")
  assert.equal(first.claims[0].evidenceRefs[0], "report:owner-delivery")
  assert.equal(first.rounds.length, 2)
  assert.equal(first.artifactRefs[0], "reviews/code-review.md")
  assert.equal(decisionPacketCodePointLength(first) <= 12_000, true)
  assert.equal(decisionPacketRef("packet-task", first.packetId), `.team-work/tasks/packet-task/packets/${first.packetId}.json`)
})

test("DecisionPacket changes its fact binding and bounds member prose without copying transcripts", () => {
  const baseline = composeDecisionPacket(fixture())
  const changed = composeDecisionPacket(fixture("x".repeat(20_000)))

  assert.notEqual(changed.factsDigest, baseline.factsDigest)
  assert.notEqual(changed.packetId, baseline.packetId)
  assert.equal(Array.from(changed.claims[0].statement).length, 320)
  assert.equal(decisionPacketCodePointLength(changed) <= 12_000, true)
})

test("DecisionPacket drops oversized locator fields while retaining a digest of the complete source facts", () => {
  const input = fixture("Review summary")
  input.taskState.artifacts[0].path = `reviews/${"x".repeat(20_000)}.md`
  input.reports[0].report.evidenceRefs = [`report:${"y".repeat(20_000)}`]
  const packet = composeDecisionPacket(input)

  assert.deepEqual(packet.artifactRefs, [])
  assert.deepEqual(packet.claims[0].evidenceRefs, [])
  assert.equal(decisionPacketCodePointLength(packet) <= 12_000, true)
  assert.notEqual(packet.factsDigest, composeDecisionPacket(fixture("Review summary")).factsDigest)
})
