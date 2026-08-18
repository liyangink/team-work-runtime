import assert from "node:assert/strict"
import test from "node:test"

import { ContractError, createMemberDelivery } from "../../../runtime/index.mjs"

test("MemberDelivery accepts a bound member report without orchestration identity fields", async () => {
  const delivery = createMemberDelivery({
    report: async () => ({
      reportId: "report-1",
      observationId: "observation-1",
      assignmentId: "assignment-1",
      accepted: true,
      duplicate: false,
      stateRevision: 3,
    }),
  })

  const receipt = await delivery.report({
    outcome: "delivered",
    summary: "代码审查完成",
    artifacts: [{ ref: "artifact:code-review", path: "reviews/code-review.md" }],
    evidenceRefs: ["evidence-1"],
    checks: [{ name: "tests", result: "pass", evidenceRef: "evidence-1" }],
    recommendation: "accept",
  })

  assert.equal(receipt.accepted, true)
  assert.equal(receipt.assignmentId, "assignment-1")
})

test("MemberDelivery rejects member-supplied assignment identity", async () => {
  const delivery = createMemberDelivery({ report: async () => assert.fail("handler must not run") })

  await assert.rejects(
    delivery.report({
      assignmentId: "forged",
      outcome: "delivered",
      summary: "done",
      artifacts: [],
      evidenceRefs: [],
      recommendation: "accept",
    }),
    (error) => error instanceof ContractError,
  )
})
