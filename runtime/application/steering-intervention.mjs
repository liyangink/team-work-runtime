import { validateContract } from "../contracts.mjs"
import { digestValue } from "../domain/digests.mjs"
import {
  compileSteeringAction,
  createSteeringAuthority,
  projectCostLedger,
} from "../../team-work/compiler.mjs"

const INTERVENTION_ACTIONS = new Set([
  "owner-explain",
  "owner-rework",
  "collect-evidence",
  "challenge-again",
  "expert-arbitrate",
  "second-expert-opinion",
  "replace-owner",
])
const SUPPORTED_ACTIONS = new Set([...INTERVENTION_ACTIONS, "replan", "escalate-to-user"])

function fail(code, message) {
  throw Object.assign(new Error(message), { code })
}

function supports(agent, kind) {
  return agent.available !== false && (agent.assignmentKinds.includes("*") || agent.assignmentKinds.includes(kind))
}

function chooseAgent(catalog, tier, kind, { preferred, excluded = [] } = {}) {
  const tiers = tier === "junior" ? ["junior", "senior", "expert"] : tier === "senior" ? ["senior", "expert"] : ["expert"]
  const candidates = catalog.agents.filter((agent) => tiers.includes(agent.tier) && supports(agent, kind) && !excluded.includes(agent.agentId))
  const selected = candidates.find(({ agentId }) => agentId === preferred)
    ?? candidates.sort((left, right) => tiers.indexOf(left.tier) - tiers.indexOf(right.tier) || left.agentId.localeCompare(right.agentId))[0]
  if (!selected) fail("AGENT_TIER_UNAVAILABLE", `no agent can satisfy steering intervention ${tier}/${kind}`)
  return selected
}

// challenger 干预优先显式 challenger role；未配置时回退 senior→expert。
function chooseChallenger(catalog, kind, { preferred, excluded = [] } = {}) {
  const byRole = catalog.agents.filter((agent) => (agent.role ?? agent.tier) === "challenger" && supports(agent, kind) && !excluded.includes(agent.agentId))
  const preferredMatch = byRole.find(({ agentId }) => agentId === preferred)
  if (preferredMatch) return preferredMatch
  if (byRole.length > 0) return byRole.sort((left, right) => left.agentId.localeCompare(right.agentId))[0]
  return chooseAgent(catalog, "senior", kind, { preferred, excluded })
}

function execution(taskId, assignmentId, agent, catalogDigest, resumeAssignmentId) {
  return {
    agentId: agent.agentId,
    capabilitySnapshotDigest: catalogDigest,
    contextRef: `.team-work/tasks/${taskId}/context/${assignmentId}.md`,
    promptRef: `.team-work/tasks/${taskId}/prompts/${assignmentId}.md`,
    ...(resumeAssignmentId ? { resumeAssignmentId } : {}),
  }
}

function assignment({ taskId, stageRunId, action, label, role, kind, agent, catalogDigest, dependsOn = [], readableRefs = [], writableRefs = [], criteria, resumeAssignmentId }) {
  const assignmentId = `${label}-${digestValue({ taskId, stageRunId, action, label, role, kind }).slice(0, 12)}`
  return {
    assignmentId,
    teamRole: role,
    assignmentKind: kind,
    costTier: agent.tier,
    dependsOn,
    readableRefs: [...new Set(readableRefs)],
    writableRefs: [...new Set(writableRefs)],
    completionCriteria: criteria,
    execution: execution(taskId, assignmentId, agent, catalogDigest, resumeAssignmentId),
  }
}

function exposedRefs(packet, decisionId) {
  return [...new Set([
    `decision:${decisionId}`,
    ...packet.roster.map(({ memberRef }) => memberRef),
    ...packet.claims.flatMap(({ authorRef, evidenceRefs }) => [authorRef, ...evidenceRefs]),
    ...packet.artifactRefs,
  ])]
}

function resumeDecisionId(pending, nextStageRunId) {
  const suffix = `-${pending.stageRunId}`
  return pending.decisionId.endsWith(suffix)
    ? `${pending.decisionId.slice(0, -suffix.length)}-${nextStageRunId}`
    : `intervention-${digestValue({ decisionId: pending.decisionId, nextStageRunId }).slice(0, 20)}`
}

function interventionMetadata({ state, input, pending, packet, nextStageRunId }) {
  return {
    action: input.action,
    directive: input.directive,
    targetRef: input.targetRef,
    referenceRefs: [...(input.referenceRefs ?? [])],
    sourceDecisionId: pending.decisionId,
    sourcePacketRef: pending.packetRef,
    sourcePacketDigest: pending.packetDigest,
    resumeDecisionId: resumeDecisionId(pending, nextStageRunId),
    resumeQuestion: pending.question,
    resumeChoices: [...pending.choices],
    requirement: pending.requirement,
    proofMode: pending.proofMode,
    artifactIds: pending.evidence.map(({ artifactId }) => artifactId),
  }
}

function assignmentForRef(state, ref, role) {
  return state.workGraph.assignments.find(({ assignmentId, teamRole }) => (
    (!role || teamRole === role) && `assignment:${assignmentId}` === ref
  ))
}

function compileAssignments({ state, input, packet, catalog, nextStageRunId }) {
  const readableRefs = [...new Set([
    ...state.stagePlan.inputRefs,
    ...state.stagePlan.outputRefs,
    ...packet.artifactRefs,
    ...(input.referenceRefs ?? []),
  ])]
  const catalogDigest = catalog.digest
  if (["expert-arbitrate", "second-expert-opinion"].includes(input.action)) {
    const target = assignmentForRef(state, input.targetRef)
    if (!target) fail("STEERING_TARGET_STALE", `${input.action} must target a current team member exposed by the DecisionPacket`)
    const authorAgents = state.workGraph.assignments
      .filter(({ teamRole, writableRefs }) => teamRole === "owner" && writableRefs.length > 0)
      .map(({ execution: { agentId } }) => agentId)
    const priorExperts = input.action === "second-expert-opinion"
      ? state.workGraph.assignments.filter(({ teamRole }) => teamRole === "expert").map(({ execution: { agentId } }) => agentId)
      : []
    if (input.action === "second-expert-opinion" && priorExperts.length === 0) {
      fail("STEERING_TARGET_STALE", "second-expert-opinion requires an existing Expert conclusion")
    }
    const expert = chooseAgent(catalog, "expert", "review", { excluded: [...new Set([...authorAgents, ...priorExperts])] })
    return [assignment({
      taskId: state.taskId,
      stageRunId: nextStageRunId,
      action: input.action,
      label: input.action === "expert-arbitrate" ? "expert-arbitration" : "second-expert-opinion",
      role: "expert",
      kind: "review",
      agent: expert,
      catalogDigest,
      readableRefs,
      criteria: [input.directive, input.action === "expert-arbitrate"
        ? "仅依据决策包、制品和可验证证据给出结构化技术裁决"
        : "独立于已有 Expert 重新核验争议并明确一致点、分歧和建议"],
    })]
  }

  if (input.action === "challenge-again") {
    const target = assignmentForRef(state, input.targetRef)
    if (!target) fail("STEERING_TARGET_STALE", "challenge-again must target a current team member exposed by the DecisionPacket")
    const prior = target.teamRole === "challenger"
      ? target
      : state.workGraph.assignments.find(({ teamRole }) => teamRole === "challenger")
    const owner = target.teamRole === "owner"
      ? target
      : state.workGraph.assignments.find(({ teamRole }) => teamRole === "owner")
    if (!prior || !owner) fail("STEERING_TARGET_STALE", "challenge-again requires the current Challenger and Owner")
    const challengerAgent = chooseChallenger(catalog, "review", { preferred: prior.execution.agentId, excluded: [owner.execution.agentId] })
    const challenger = assignment({
      taskId: state.taskId,
      stageRunId: nextStageRunId,
      action: input.action,
      label: "challenge-again",
      role: "challenger",
      kind: "review",
      agent: challengerAgent,
      catalogDigest,
      readableRefs,
      criteria: [input.directive, "从需求、事实、推理、边界和失败路径重新寻找遗漏"],
    })
    const response = assignment({
      taskId: state.taskId,
      stageRunId: nextStageRunId,
      action: input.action,
      label: "challenge-owner-response",
      role: "owner",
      kind: owner.assignmentKind,
      agent: chooseAgent(catalog, owner.costTier, owner.assignmentKind, { preferred: owner.execution.agentId }),
      catalogDigest,
      dependsOn: [challenger.assignmentId],
      readableRefs,
      criteria: ["逐项核验新增挑战，明确接受、修正或有证据地提出异议"],
    })
    return [challenger, response]
  }

  const target = ["owner-explain", "owner-rework", "replace-owner"].includes(input.action)
    ? assignmentForRef(state, input.targetRef, "owner")
    : null
  if (["owner-explain", "owner-rework", "replace-owner"].includes(input.action) && !target) {
    fail("STEERING_TARGET_STALE", `${input.action} must target a current Owner exposed by the DecisionPacket`)
  }
  const kind = input.action === "collect-evidence" ? "evidence" : target.assignmentKind
  const outputRefs = input.action === "collect-evidence"
    ? [`artifact:steering-evidence:${digestValue({ taskId: state.taskId, nextStageRunId, directive: input.directive }).slice(0, 16)}`]
    : input.action === "owner-explain"
      ? [`artifact:steering-explanation:${digestValue({ taskId: state.taskId, nextStageRunId, directive: input.directive }).slice(0, 16)}`]
      : target.writableRefs
  const ownerAgent = chooseAgent(catalog, input.action === "collect-evidence" ? "junior" : target.costTier, kind, {
    preferred: input.action === "replace-owner" ? undefined : target?.execution.agentId,
    excluded: input.action === "replace-owner" ? [target.execution.agentId] : [],
  })
  const owner = assignment({
    taskId: state.taskId,
    stageRunId: nextStageRunId,
    action: input.action,
    label: input.action === "collect-evidence" ? "evidence-owner"
      : input.action === "owner-explain" ? "owner-explanation"
        : input.action === "replace-owner" ? "replacement-owner" : "rework-owner",
    role: "owner",
    kind,
    agent: ownerAgent,
    catalogDigest,
    readableRefs,
    writableRefs: outputRefs,
    criteria: [input.directive, input.action === "collect-evidence" ? "补充可复核的事实和证据引用"
      : input.action === "owner-explain" ? "针对争议逐项解释事实、推理和未决风险"
        : "完成修订并自检全部受影响范围"],
  })
  const challengerAgent = chooseAgent(catalog, "senior", kind, { excluded: [ownerAgent.agentId] })
  const challenger = assignment({
    taskId: state.taskId,
    stageRunId: nextStageRunId,
    action: input.action,
    label: "intervention-challenger",
    role: "challenger",
    kind,
    agent: challengerAgent,
    catalogDigest,
    dependsOn: [owner.assignmentId],
    readableRefs: [...readableRefs, ...outputRefs],
    criteria: ["主动寻找事实、需求、边界和失败路径漏洞", "给出有证据的接受或最小修正结论"],
  })
  const reviewers = [challenger]
  if (["owner-rework", "replace-owner"].includes(input.action) && state.workGraph.assignments.some(({ teamRole }) => teamRole === "expert")) {
    const expertAgent = chooseAgent(catalog, "expert", kind, { excluded: [ownerAgent.agentId] })
    reviewers.push(assignment({
      taskId: state.taskId,
      stageRunId: nextStageRunId,
      action: input.action,
      label: "intervention-expert",
      role: "expert",
      kind,
      agent: expertAgent,
      catalogDigest,
      dependsOn: [owner.assignmentId],
      readableRefs: [...readableRefs, ...outputRefs],
      criteria: ["独立核验修订是否满足核心技术约束并给出结构化裁决"],
    }))
  }
  const response = assignment({
    taskId: state.taskId,
    stageRunId: nextStageRunId,
    action: input.action,
    label: "intervention-owner-response",
    role: "owner",
    kind,
    agent: ownerAgent,
    catalogDigest,
    dependsOn: reviewers.map(({ assignmentId }) => assignmentId),
    readableRefs: [...readableRefs, ...outputRefs],
    criteria: ["逐项引用独立复核证据，明确接受、修正或有证据地提出异议"],
    resumeAssignmentId: owner.assignmentId,
  })
  return [owner, ...reviewers, response]
}

export function compileSteeringIntervention({ state, input, packet, teamPolicy, agentCatalog }) {
  if (!SUPPORTED_ACTIONS.has(input?.action)) fail("STEERING_INVALID", "unsupported steering intervention")
  if (state.status !== "awaiting-user" || state.pendingDecision?.phase !== "awaiting-user" || !state.pendingDecision.packetRef) {
    fail("ACTION_STALE", "steering intervention requires the current DecisionPacket at an awaiting-user stable point")
  }
  if (state.pendingDecision.decisionId.startsWith("budget-")) fail("STEERING_INVALID", "a budget decision must be resolved before requesting technical intervention")
  validateContract("https://team-work-runtime.dev/schemas/v2/decision-packet", packet, "decision packet")
  if (packet.factsDigest === "" || packet.stage !== state.currentStageRun.stage) fail("STEERING_AUTHORITY_STALE", "DecisionPacket no longer matches the current stage")
  const authority = createSteeringAuthority({
    taskId: state.taskId,
    stageRunId: state.currentStageRun.stageRunId,
    artifactDigest: state.pendingDecision.evidenceDigest,
    allowedActions: [...SUPPORTED_ACTIONS],
    exposedRefs: exposedRefs(packet, state.pendingDecision.decisionId),
  })
  const policyAction = compileSteeringAction({
    intent: input,
    authority,
    current: {
      taskId: state.taskId,
      stageRunId: state.currentStageRun.stageRunId,
      artifactDigest: state.pendingDecision.evidenceDigest,
      steeringTokenDigest: authority.tokenDigest,
      stable: true,
      round: state.currentStageRun.round,
      costLedger: state.costLedger,
    },
    teamPolicy,
  })

  const source = {
    sourceDecisionId: state.pendingDecision.decisionId,
    sourcePacketRef: state.pendingDecision.packetRef,
    sourcePacketDigest: state.pendingDecision.packetDigest,
  }
  if (policyAction.action === "budget-decision") {
    fail("STEERING_BUDGET_REQUIRED", "the requested independent Expert exceeds the current automatic cost limit")
  }
  if (policyAction.action === "replan-stage") {
    return {
      kind: "replan",
      nextStageRunId: `stage-run-${state.currentStageRun.sequence + 1}`,
      reason: policyAction.reason,
      ...source,
    }
  }
  if (policyAction.action === "user-decision") {
    return { kind: "escalate", question: input.directive, reason: policyAction.reason, ...source }
  }
  if (!INTERVENTION_ACTIONS.has(input.action)) fail("STEERING_INVALID", "steering action cannot create a member intervention")

  const nextStageRunId = `stage-run-${state.currentStageRun.sequence + 1}`
  const assignments = compileAssignments({ state, input, packet, catalog: agentCatalog, nextStageRunId })
  const intervention = interventionMetadata({ state, input, pending: state.pendingDecision, packet, nextStageRunId })
  const outputRefs = [...new Set(assignments.flatMap(({ writableRefs }) => writableRefs))]
  const fallbackOutput = `report:steering-${digestValue({ taskId: state.taskId, nextStageRunId, action: input.action }).slice(0, 16)}`
  const plan = {
    planId: `plan-${digestValue({ taskId: state.taskId, nextStageRunId, intervention }).slice(0, 20)}`,
    stageRunId: nextStageRunId,
    objective: input.directive,
    inputRefs: [...new Set([state.pendingDecision.packetRef, ...state.stagePlan.inputRefs, ...state.stagePlan.outputRefs])],
    outputRefs: outputRefs.length > 0 ? outputRefs : [fallbackOutput],
    assignments,
    basis: { kind: "deterministic" },
    teamMode: assignments.filter(({ teamRole, writableRefs }) => teamRole === "owner" && writableRefs.length > 0).length > 1 ? "team" : "solo",
    policyPins: structuredClone(state.stagePlan.policyPins),
    convergence: { maxAutonomousRounds: 3, currentRound: state.currentStageRun.round + 1 },
    routes: structuredClone(state.stagePlan.routes),
    costProjection: structuredClone(state.stagePlan.costProjection),
    intervention,
  }
  const interventionLedger = projectCostLedger({
    assignments,
    policy: teamPolicy,
    budget: state.taskIntent.preferences.budget,
    accrued: state.costLedger.accrued,
    uncertain: state.costLedger.uncertain,
    approvedLimit: state.costLedger.automaticLimit,
  })
  const costLedger = {
    ...interventionLedger,
    forecastMin: state.costLedger.forecastMin + interventionLedger.forecastMin,
    forecastMax: state.costLedger.forecastMax + interventionLedger.forecastMax,
  }
  return { kind: "intervention", nextStageRunId, plan, costLedger, intervention }
}
