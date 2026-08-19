import { digestValue } from "../../../runtime/domain/digests.mjs"

function report(summary, artifacts = [], evidenceRefs = []) {
  return {
    outcome: "delivered",
    summary,
    artifacts,
    evidenceRefs,
    recommendation: "accept",
  }
}

function output(ref, path) {
  return { ref, path }
}

export function createHappyPathHarness({ runtime, execution, artifacts, workflowDefinition, e2eAssessment = {}, transformReport }) {
  const stages = new Map(workflowDefinition.stages.map((stage) => [stage.id, stage]))
  const delivered = new Set()
  const deliveredAssignments = new Set()
  const latestEvidenceByRun = new Map()
  const reviewEvidenceByRun = new Map()

  function stageOutputs(stageId) {
    const stage = stages.get(stageId)
    if (!stage) throw new Error(`unknown workflow stage: ${stageId}`)
    return stage.outputs.map((kind) => `artifact:${kind}`)
  }

  async function deliverMember(member, stageId) {
    const runId = member.stageRunId
    const latestEvidence = latestEvidenceByRun.get(runId)
    let memberReport
    if (member.assignmentId.startsWith("owner-response-")) {
      memberReport = report(
        `Owner independently accepted the ${stageId} review evidence.`,
        [],
        [...(reviewEvidenceByRun.get(runId) ?? [])],
      )
    } else if (member.role === "owner" && member.assignmentKind === "planning") {
      const body = {
        proposalId: `proposal-${runId}`,
        stageRunId: runId,
        stage: stageId,
        integrationRequired: false,
        workPackages: [{
          packageId: `${stageId}-delivery`,
          objective: `Complete ${stageId}`,
          inputRefs: [],
          outputRefs: stageOutputs(stageId),
          completionCriteria: [`produce the declared ${stageId} artifacts`],
          dependsOn: [],
        }],
      }
      const proposal = { ...body, digest: digestValue(body) }
      const path = `generated/${runId}/proposal.json`
      artifacts.write(path, JSON.stringify(proposal), { assignmentId: member.assignmentId })
      memberReport = report(
        `Prepared the executable ${stageId} proposal.`,
        [output(`artifact:stage-plan-proposal:${runId}`, path)],
      )
    } else if (member.role === "owner" && member.assignmentKind === "e2e-applicability") {
      const assessment = {
        applicable: e2eAssessment.applicable ?? false,
        criticalCrossSystemPath: e2eAssessment.criticalCrossSystemPath ?? false,
        environment: e2eAssessment.environment ?? "unknown",
        evidenceRefs: latestEvidence ? [latestEvidence] : ["evidence:controlled-harness-input"],
      }
      const path = "generated/e2e-route-assessment.json"
      artifacts.write(path, JSON.stringify(assessment), { assignmentId: member.assignmentId })
      memberReport = report(
        "Assessed E2E as not applicable for this controlled workflow fixture.",
        [output("artifact:e2e-route-assessment", path)],
        latestEvidence ? [latestEvidence] : [],
      )
    } else if (member.role === "owner") {
      const e2eOutput = member.assignmentId.startsWith("owner-path-design-") ? "artifact:e2e-design"
        : member.assignmentId.startsWith("owner-fixture-implementation-") ? "artifact:e2e-fixtures"
          : member.assignmentId.startsWith("owner-execution-") ? "artifact:e2e-result"
            : null
      const outputs = (e2eOutput ? [e2eOutput] : stageOutputs(stageId)).map((ref) => {
        const kind = ref.slice("artifact:".length)
        const path = `generated/${kind}.md`
        artifacts.write(path, `${stageId} artifact ${kind}\n`, { assignmentId: member.assignmentId })
        return output(ref, path)
      })
      memberReport = report(`Delivered the declared ${stageId} artifacts.`, outputs)
    } else if (member.role === "expert") {
      if (!latestEvidence) throw new Error(`Expert ${member.assignmentId} has no review evidence`)
      memberReport = {
        ...report(`Expert accepts the evidence-backed ${stageId} result.`, [], [latestEvidence]),
        verdict: {
          outcome: "accept",
          rationale: `The ${stageId} result satisfies its declared scope.`,
          evidenceRefs: [latestEvidence],
          affectedScope: [stageId],
          risks: [],
          confidence: "high",
          recommendedAction: "accept",
        },
      }
    } else {
      if (!latestEvidence) throw new Error(`Challenger ${member.assignmentId} has no delivery evidence`)
      memberReport = report(`Challenger found no blocker in ${stageId}.`, [], [latestEvidence])
    }

    memberReport = transformReport?.({ member, stageId, report: memberReport }) ?? memberReport
    const receipt = await member.report(memberReport)
    const evidenceRef = `report:${receipt.reportId}`
    latestEvidenceByRun.set(runId, evidenceRef)
    if (["challenger", "expert"].includes(member.role)) {
      reviewEvidenceByRun.set(runId, [...(reviewEvidenceByRun.get(runId) ?? []), evidenceRef])
    }
    delivered.add(`${member.executionRef}:${member.attemptId}`)
    deliveredAssignments.add(member.assignmentId)
  }

  async function deliverCurrentWave(card) {
    const pending = execution.activeMembers().filter((member) => !delivered.has(`${member.executionRef}:${member.attemptId}`))
    for (const member of pending) await deliverMember(member, card.task.stage)
    return pending.length
  }

  async function drive(initialCard, { maxLeadActions = 96, choose = () => "accept", stopWhen = () => false } = {}) {
    let card = initialCard
    const cards = [card]
    let leadActions = 0
    let humanDecisions = 0
    while (card.task?.status !== "completed" && leadActions < maxLeadActions) {
      if (stopWhen(card)) return { card, cards, leadActions, humanDecisions, deliveredAssignments: [...deliveredAssignments] }
      if (!card.task) throw new Error(`workflow returned a problem card: ${JSON.stringify(card)}`)
      const deliveredCount = await deliverCurrentWave(card)
      if (deliveredCount > 0 || card.next.kind === "run") {
        card = await runtime.leadControl.run()
      } else if (card.next.kind === "steer") {
        const choice = choose(card, humanDecisions)
        if (!card.next.choices.some(({ value }) => value === choice)) {
          throw new Error(`workflow requires a non-accept decision: ${JSON.stringify(card.next)}`)
        }
        execution.setHumanChoice(choice)
        card = await runtime.leadControl.steer({ action: "choose", directive: choice })
        humanDecisions += 1
      } else {
        const active = execution.activeMembers().map(({ executionRef, attemptId, assignmentId, stageRunId, role, assignmentKind }) => ({
          assignmentId,
          stageRunId,
          role,
          assignmentKind,
          delivered: delivered.has(`${executionRef}:${attemptId}`),
        }))
        throw new Error(`workflow stopped at ${card.task.stage}/${card.task.status}/${card.next.kind}: ${JSON.stringify(active)}`)
      }
      leadActions += 1
      cards.push(card)
    }
    if (card.task.status !== "completed") throw new Error(`workflow exceeded ${maxLeadActions} Lead actions`)
    return { card, cards, leadActions, humanDecisions, deliveredAssignments: [...deliveredAssignments] }
  }

  return Object.freeze({ drive })
}
