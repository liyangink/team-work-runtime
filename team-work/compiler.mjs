import { assertCompiledWorkGraph, digestValue, PolicyError } from "../policy/kernel.mjs"

function fail(code, message, details = []) {
  throw new PolicyError(code, message, details)
}

function validatePolicy(policy) {
  if (!policy || policy.schemaVersion !== "2.0" || typeof policy.policyId !== "string" || typeof policy.version !== "string") {
    fail("TEAM_POLICY_INVALID", "team policy identity is invalid")
  }
  if (policy.maxAutonomousRounds !== 3) fail("TEAM_POLICY_INVALID", "default autonomous convergence must stop after three rounds")
  for (const [tier, expected] of Object.entries({ junior: 1, senior: 10, expert: 50 })) {
    if (policy.costWeights?.[tier] !== expected) fail("TEAM_POLICY_INVALID", "cost weights must preserve 1:10:50")
  }
  return { policy, digest: digestValue(policy) }
}

function validateCatalog(catalog) {
  if (!catalog || typeof catalog.digest !== "string" || !Array.isArray(catalog.agents) || catalog.agents.length === 0) {
    fail("AGENT_CATALOG_INVALID", "a normalized agent catalog is required")
  }
  if (!/^[a-f0-9]{64}$/.test(catalog.digest) || catalog.digest !== digestValue(catalog.agents)) {
    fail("AGENT_CATALOG_INVALID", "agent catalog digest does not match its entries")
  }
  if (new Set(catalog.agents.map(({ agentId }) => agentId)).size !== catalog.agents.length) {
    fail("AGENT_CATALOG_INVALID", "agent ids must be unique")
  }
  return catalog
}

function supports(agent, assignmentKind) {
  return Array.isArray(agent.assignmentKinds) && (agent.assignmentKinds.includes("*") || agent.assignmentKinds.includes(assignmentKind))
}

function chooseAgent(catalog, requestedTier, assignmentKind, usedFamilies = [], forbiddenAgentIds = []) {
  if (!["junior", "senior", "expert"].includes(requestedTier)) fail("TEAM_POLICY_INVALID", `unsupported owner tier: ${requestedTier}`)
  const tiers = requestedTier === "junior" ? ["junior", "senior", "expert"] : requestedTier === "senior" ? ["senior", "expert"] : ["expert"]
  for (const tier of tiers) {
    const candidates = catalog.agents.filter((agent) => (
      agent.tier === tier
      && agent.available !== false
      && supports(agent, assignmentKind)
      && !forbiddenAgentIds.includes(agent.agentId)
    ))
    if (candidates.length === 0) continue
    return [...candidates].sort((left, right) => {
      const leftDiverse = usedFamilies.includes(left.modelFamily) ? 1 : 0
      const rightDiverse = usedFamilies.includes(right.modelFamily) ? 1 : 0
      return leftDiverse - rightDiverse || left.agentId.localeCompare(right.agentId)
    })[0]
  }
  fail("AGENT_TIER_UNAVAILABLE", `no agent can satisfy ${requestedTier}/${assignmentKind}`)
}

function assignmentId(seed, label) {
  return `${label}-${digestValue(seed).slice(0, 12)}`
}

function executionFor(taskId, assignmentIdValue, agent, catalogDigest) {
  return {
    agentId: agent.agentId,
    capabilitySnapshotDigest: catalogDigest,
    contextRef: `.team-work/tasks/${taskId}/context/${assignmentIdValue}.md`,
    promptRef: `.team-work/tasks/${taskId}/prompts/${assignmentIdValue}.md`,
  }
}

function createAssignment({ taskId, stageRunId, label, role, kind, tier, dependsOn, readableRefs, writableRefs, criteria, agent, catalogDigest }) {
  const id = assignmentId({ taskId, stageRunId, label, role, kind, writableRefs }, label)
  return {
    assignmentId: id,
    teamRole: role,
    assignmentKind: kind,
    costTier: agent.tier ?? tier,
    dependsOn,
    readableRefs: [...new Set(readableRefs)],
    writableRefs: [...new Set(writableRefs)],
    completionCriteria: criteria,
    execution: executionFor(taskId, id, agent, catalogDigest),
  }
}

export function projectCostLedger({ assignments, policy, budget, accrued = 0, uncertain = 0, futureCostMin = 0, futureCostMax = 0 }) {
  validatePolicy(policy)
  if (!Object.hasOwn(policy.automaticLimits, budget)) fail("TEAM_POLICY_INVALID", `no automatic limit for ${budget}`)
  const weight = (assignment) => policy.costWeights[assignment.costTier]
  const base = assignments.reduce((sum, assignment) => sum + weight(assignment), 0)
  const roots = assignments.filter((assignment) => assignment.dependsOn.length === 0).slice(0, policy.concurrencySoftLimit)
  return {
    forecastMin: base + futureCostMin,
    forecastMax: (base + futureCostMax) * policy.maxAutonomousRounds,
    accrued,
    uncertain,
    nextWave: roots.reduce((sum, assignment) => sum + weight(assignment), 0),
    automaticLimit: policy.automaticLimits[budget],
  }
}

function defaultStageCost(stage, stagePolicies, policy) {
  const teamScene = stagePolicies[stage]?.teamScene
  if (teamScene === "e2e") {
    return policy.e2eTemplate.length * (policy.costWeights.junior + policy.costWeights.senior) + policy.costWeights.expert
  }
  const scene = policy.scenes[teamScene]
  if (!scene) return 0
  return policy.costWeights[scene.ownerTier]
    + policy.costWeights[scene.challengerTier]
    + (scene.core ? policy.costWeights.expert : 0)
}

function routeAllows(edge, routes, stagePolicies) {
  const route = stagePolicies[edge.from]?.route
  if (route === "spec" && ["use-spec", "skip-spec"].includes(edge.outcome)) {
    if (routes.spec.decision === "use-provider") return edge.outcome === "use-spec"
    if (routes.spec.decision === "skip") return edge.outcome === "skip-spec"
  }
  if (route === "e2e" && ["run-e2e", "skip-e2e"].includes(edge.outcome)) {
    if (routes.e2e.decision === "run") return edge.outcome === "run-e2e"
    if (routes.e2e.decision === "skip") return edge.outcome === "skip-e2e"
  }
  return true
}

function projectFutureStageCost(task, routes, stagePolicies, policy) {
  const completion = new Set(task.scope?.completionStages ?? [])
  const edges = (task.scope?.edges ?? []).filter((edge) => routeAllows(edge, routes, stagePolicies))
  const current = task.currentStageRun.stage
  const walk = (stage, visited) => {
    if (completion.has(stage)) return [0]
    const nextEdges = edges.filter((edge) => edge.from === stage && !visited.has(edge.to))
    return nextEdges.flatMap((edge) => {
      const tail = walk(edge.to, new Set([...visited, edge.to]))
      return tail.map((cost) => defaultStageCost(edge.to, stagePolicies, policy) + cost)
    })
  }
  const paths = walk(current, new Set([current]))
  if (paths.length === 0) return { min: 0, max: 0, pathCount: 0 }
  return { min: Math.min(...paths), max: Math.max(...paths), pathCount: paths.length }
}

export function evaluateConvergence({ round, maxAutonomousRounds, owner, challenger, expert }) {
  if (!Number.isInteger(round) || round < 1 || !Number.isInteger(maxAutonomousRounds) || maxAutonomousRounds < 1) {
    fail("CONVERGENCE_INVALID", "convergence round and limit must be positive integers")
  }
  if (owner === "accept" && challenger === "accept" && (!expert || expert === "accept")) return { action: "accept" }
  if (round >= maxAutonomousRounds) return { action: "user-decision", reason: "autonomous-round-limit" }
  return { action: "rework", nextRound: round + 1 }
}

const STEERING_ACTIONS = new Set([
  "choose",
  "owner-explain",
  "owner-rework",
  "collect-evidence",
  "challenge-again",
  "expert-arbitrate",
  "second-expert-opinion",
  "replace-owner",
  "replan",
  "escalate-to-user",
])
const STEERING_FIELDS = new Set(["action", "directive", "targetRef", "referenceRefs", "note"])
const TARGETED_ACTIONS = new Set([
  "owner-explain",
  "owner-rework",
  "collect-evidence",
  "challenge-again",
  "expert-arbitrate",
  "second-expert-opinion",
  "replace-owner",
])

export function createSteeringAuthority({ taskId, stageRunId, artifactDigest, allowedActions, exposedRefs = [], choices = [] }) {
  if (
    typeof taskId !== "string"
    || typeof stageRunId !== "string"
    || !/^[a-f0-9]{64}$/.test(artifactDigest ?? "")
    || !Array.isArray(allowedActions)
    || allowedActions.some((action) => !STEERING_ACTIONS.has(action))
    || new Set(allowedActions).size !== allowedActions.length
    || !Array.isArray(exposedRefs)
    || new Set(exposedRefs).size !== exposedRefs.length
    || !Array.isArray(choices)
    || new Set(choices).size !== choices.length
  ) fail("STEERING_AUTHORITY_INVALID", "steering authority fields are invalid")
  const binding = { taskId, stageRunId, artifactDigest, allowedActions: [...allowedActions], exposedRefs: [...exposedRefs], choices: [...choices] }
  return Object.freeze({ ...binding, tokenDigest: digestValue(binding) })
}

export function compileSteeringAction({ intent, authority, current, teamPolicy }) {
  validatePolicy(teamPolicy)
  if (
    !authority
    || !/^[a-f0-9]{64}$/.test(authority.tokenDigest ?? "")
    || !/^[a-f0-9]{64}$/.test(authority.artifactDigest ?? "")
    || !Array.isArray(authority.allowedActions)
    || !Array.isArray(authority.exposedRefs)
    || !Array.isArray(authority.choices)
  ) fail("STEERING_AUTHORITY_INVALID", "steering requires a Runtime-issued authority snapshot")
  const { tokenDigest, ...authorityBinding } = authority
  if (tokenDigest !== digestValue(authorityBinding)) {
    fail("STEERING_AUTHORITY_INVALID", "steering authority binding has been modified")
  }
  if (
    !current?.stable
    || current.steeringTokenDigest !== authority.tokenDigest
    || current.taskId !== authority.taskId
    || current.stageRunId !== authority.stageRunId
    || current.artifactDigest !== authority.artifactDigest
  ) fail("STEERING_AUTHORITY_STALE", "steering authority no longer matches the Runtime-issued stable task state")
  if (!intent || !STEERING_ACTIONS.has(intent.action) || typeof intent.directive !== "string" || intent.directive.trim() === "") {
    fail("STEERING_INVALID", "steering action and directive are required")
  }
  if (!authority.allowedActions.includes(intent.action)) fail("STEERING_INVALID", "steering action is not allowed by the current ActionCard")
  if (Object.keys(intent).some((field) => !STEERING_FIELDS.has(field))) {
    fail("STEERING_INVALID", "steering cannot include agent, session, work-item, gate, or Runtime state fields")
  }
  const visible = new Set(authority.exposedRefs)
  if (TARGETED_ACTIONS.has(intent.action) && !visible.has(intent.targetRef)) {
    fail("STEERING_TARGET_STALE", "steering target is not exposed by the current decision packet")
  }
  if (intent.referenceRefs && (!Array.isArray(intent.referenceRefs) || intent.referenceRefs.some((ref) => !visible.has(ref)))) {
    fail("STEERING_TARGET_STALE", "steering references must belong to the current decision packet")
  }
  if (intent.action === "choose") {
    if (!authority.choices.includes(intent.directive)) fail("STEERING_CHOICE_INVALID", "choice is not offered by the current ActionCard")
    return { action: "apply-choice", value: intent.directive }
  }
  if (intent.action === "challenge-again" && current.round >= teamPolicy.maxAutonomousRounds) {
    return { action: "user-decision", reason: "autonomous-round-limit" }
  }
  if (["expert-arbitrate", "second-expert-opinion"].includes(intent.action)) {
    const relativeCost = teamPolicy.costWeights.expert
    if (current.costLedger.accrued + current.costLedger.uncertain + relativeCost > current.costLedger.automaticLimit) {
      return { action: "budget-decision", relativeCost }
    }
    return {
      action: intent.action === "expert-arbitrate" ? "create-expert-assignment" : "create-independent-expert-assignment",
      targetRef: intent.targetRef,
      relativeCost,
    }
  }
  if (intent.action === "escalate-to-user") return { action: "user-decision", reason: "lead-escalation" }
  if (intent.action === "replan") return { action: "replan-stage", reason: intent.directive }
  return { action: intent.action, ...(intent.targetRef ? { targetRef: intent.targetRef } : {}) }
}

export function compileTeamPlan({ task, workflowDraft, teamPolicy, agentCatalog }) {
  const policyPin = validatePolicy(teamPolicy)
  const catalog = validateCatalog(agentCatalog)
  const stageScene = teamPolicy.scenes[workflowDraft.stage.teamScene]
  const scene = teamPolicy.scenes[workflowDraft.planningRequired ? "planning" : workflowDraft.stage.teamScene]
  if (!scene || !stageScene) fail("TEAM_POLICY_INVALID", `missing team scene ${workflowDraft.stage.teamScene}`)
  const stageRunId = task.currentStageRun.stageRunId
  const usedFamilies = []
  const assignments = []

  const e2eRun = workflowDraft.stage.teamScene === "e2e" && workflowDraft.routes?.e2e?.decision === "run"
  let packages = e2eRun
    ? teamPolicy.e2eTemplate.map((entry) => ({
        ...entry,
        objective: entry.completionCriteria[0],
        inputRefs: workflowDraft.inputRefs,
      }))
    : workflowDraft.planningRequired
    ? [{
        packageId: "planning",
        objective: `Produce an executable proposal for: ${workflowDraft.intent.objective}`,
        assignmentKind: "planning",
        inputRefs: workflowDraft.inputRefs,
        outputRefs: [`artifact:stage-plan-proposal:${stageRunId}`],
        completionCriteria: ["define work packages, outputs, dependencies, and acceptance criteria", "identify integration and unresolved decisions"],
        dependsOn: [],
      }]
    : workflowDraft.work.packages
  let integrationRequired = !workflowDraft.planningRequired && workflowDraft.work?.integrationRequired === true
  if (!workflowDraft.planningRequired && workflowDraft.intent.preferences.execution === "team" && packages.length < 2) {
    fail("TEAM_TOPOLOGY_UNSATISFIED", "team execution requires a proposal with at least two independent work packages")
  }
  if (!workflowDraft.planningRequired && workflowDraft.intent.preferences.execution === "solo" && packages.length > 1) {
    packages = [{
      packageId: "solo-delivery",
      objective: workflowDraft.intent.objective,
      assignmentKind: workflowDraft.stage.assignmentKind,
      inputRefs: [...new Set(packages.flatMap(({ inputRefs }) => inputRefs))],
      outputRefs: [...new Set([
        ...packages.flatMap(({ outputRefs }) => outputRefs),
        ...(integrationRequired ? workflowDraft.outputRefs : []),
      ])],
      completionCriteria: packages.flatMap((entry) => entry.completionCriteria.map((criterion) => `${entry.packageId}: ${criterion}`)),
      dependsOn: [],
    }]
    integrationRequired = false
  }

  let deliveryIds = []
  let deliveredRefs = []
  let challenger
  if (e2eRun) {
    let previousReviewId
    for (const workPackage of packages) {
      const ownerAgent = chooseAgent(catalog, scene.ownerTier, workPackage.assignmentKind, usedFamilies)
      usedFamilies.push(ownerAgent.modelFamily)
      const owner = createAssignment({
        taskId: task.taskId,
        stageRunId,
        label: `owner-${workPackage.packageId}`,
        role: "owner",
        kind: workPackage.assignmentKind,
        tier: scene.ownerTier,
        dependsOn: previousReviewId ? [previousReviewId] : [],
        readableRefs: [...workPackage.inputRefs, ...deliveredRefs],
        writableRefs: workPackage.outputRefs,
        criteria: workPackage.completionCriteria,
        agent: ownerAgent,
        catalogDigest: catalog.digest,
      })
      assignments.push(owner)
      deliveredRefs.push(...workPackage.outputRefs)
      const reviewAgent = chooseAgent(catalog, scene.challengerTier, "review", usedFamilies)
      usedFamilies.push(reviewAgent.modelFamily)
      challenger = createAssignment({
        taskId: task.taskId,
        stageRunId,
        label: `challenger-${workPackage.packageId}`,
        role: "challenger",
        kind: "review",
        tier: scene.challengerTier,
        dependsOn: [owner.assignmentId],
        readableRefs: [...workflowDraft.inputRefs, ...deliveredRefs],
        writableRefs: [],
        criteria: [
          `independently review ${workPackage.packageId}`,
          "challenge reproducibility, omissions, false positives, cleanup, and failure classification",
        ],
        agent: reviewAgent,
        catalogDigest: catalog.digest,
      })
      assignments.push(challenger)
      previousReviewId = challenger.assignmentId
    }
    deliveryIds = [challenger.assignmentId]
  } else {
    for (const workPackage of packages) {
      const requestedTier = workflowDraft.intent.preferences.risk === "critical" ? "expert"
        : workflowDraft.intent.preferences.risk === "high" ? "senior"
          : scene.ownerTier
      const owner = chooseAgent(catalog, requestedTier, workPackage.assignmentKind, usedFamilies)
      usedFamilies.push(owner.modelFamily)
      assignments.push(createAssignment({
        taskId: task.taskId,
        stageRunId,
        label: `owner-${workPackage.packageId}`,
        role: "owner",
        kind: workPackage.assignmentKind,
        tier: requestedTier,
        dependsOn: workPackage.dependsOn.map((dependency) => assignmentId({ taskId: task.taskId, stageRunId, label: `owner-${dependency}`, role: "owner", kind: packages.find(({ packageId }) => packageId === dependency)?.assignmentKind, writableRefs: packages.find(({ packageId }) => packageId === dependency)?.outputRefs }, `owner-${dependency}`)),
        readableRefs: workPackage.inputRefs,
        writableRefs: workPackage.outputRefs,
        criteria: [
          ...workPackage.completionCriteria,
          ...(stageScene.requiredPerspectives ?? []).map((perspective) => `cover review perspective: ${perspective}`),
        ],
        agent: owner,
        catalogDigest: catalog.digest,
      }))
    }

    deliveryIds = assignments.filter((assignment) => (
      !assignments.some((candidate) => candidate.dependsOn.includes(assignment.assignmentId))
    )).map(({ assignmentId }) => assignmentId)
    deliveredRefs = packages.flatMap(({ outputRefs }) => outputRefs)
    if (integrationRequired) {
      const integrationAgent = chooseAgent(catalog, scene.ownerTier, "integration", usedFamilies)
      usedFamilies.push(integrationAgent.modelFamily)
      const integration = createAssignment({
        taskId: task.taskId,
        stageRunId,
        label: "owner-integration",
        role: "owner",
        kind: "integration",
        tier: scene.ownerTier,
        dependsOn: deliveryIds,
        readableRefs: [...workflowDraft.inputRefs, ...deliveredRefs],
        writableRefs: workflowDraft.outputRefs,
        criteria: ["integrate owner outputs without losing material conclusions", "resolve conflicts and submit verification evidence"],
        agent: integrationAgent,
        catalogDigest: catalog.digest,
      })
      assignments.push(integration)
      deliveryIds = [integration.assignmentId]
      deliveredRefs = workflowDraft.outputRefs
    }

    const challengerAgent = chooseAgent(catalog, scene.challengerTier, "review", usedFamilies)
    usedFamilies.push(challengerAgent.modelFamily)
    challenger = createAssignment({
      taskId: task.taskId,
      stageRunId,
      label: "challenger",
      role: "challenger",
      kind: "review",
      tier: scene.challengerTier,
      dependsOn: deliveryIds,
      readableRefs: [...workflowDraft.inputRefs, ...deliveredRefs],
      writableRefs: [],
      criteria: ["challenge requirements, facts, reasoning, boundaries, cost, and failure paths", "report evidence-backed findings and minimal corrections"],
      agent: challengerAgent,
      catalogDigest: catalog.digest,
    })
    assignments.push(challenger)
    deliveryIds = [challenger.assignmentId]
  }

  const needsExpert = stageScene.core || ["high", "critical"].includes(workflowDraft.intent.preferences.risk)
  if (needsExpert) {
    const ownerAgentIds = assignments.filter(({ teamRole }) => teamRole === "owner").map(({ execution }) => execution.agentId)
    let expertAgent
    try {
      expertAgent = chooseAgent(catalog, "expert", workflowDraft.stage.assignmentKind, usedFamilies, ownerAgentIds)
    } catch (error) {
      if (error.code !== "AGENT_TIER_UNAVAILABLE") throw error
      expertAgent = chooseAgent(catalog, "expert", workflowDraft.stage.assignmentKind, usedFamilies)
    }
    const expert = createAssignment({
      taskId: task.taskId,
      stageRunId,
      label: "expert-verdict",
      role: "expert",
      kind: workflowDraft.stage.assignmentKind,
      tier: "expert",
      dependsOn: [challenger.assignmentId],
      readableRefs: [...workflowDraft.inputRefs, ...deliveredRefs],
      writableRefs: [],
      criteria: ["issue an evidence-backed independent technical verdict", "state risks, confidence, and recommended action"],
      agent: expertAgent,
      catalogDigest: catalog.digest,
    })
    assignments.push(expert)
  }

  const planSeed = {
    workflowPin: workflowDraft.workflowPin,
    policyDigest: policyPin.digest,
    catalogDigest: catalog.digest,
    stageRunId,
    intent: workflowDraft.intent,
    assignments,
  }
  const futureCost = projectFutureStageCost(task, workflowDraft.routes, workflowDraft.stagePolicies, teamPolicy)
  const costProjection = {
    scopeStages: [...(task.scope?.stages ?? [workflowDraft.stage.id])],
    branchPathCount: futureCost.pathCount,
    specDecision: workflowDraft.routes.spec.decision,
    e2eDecision: workflowDraft.routes.e2e.decision ?? workflowDraft.routes.e2e.kind,
    maxAutonomousRounds: teamPolicy.maxAutonomousRounds,
  }
  const plan = {
    planId: `plan-${digestValue(planSeed).slice(0, 20)}`,
    stageRunId,
    objective: workflowDraft.planningRequired ? `Plan ${workflowDraft.stage.label}` : workflowDraft.intent.objective,
    inputRefs: workflowDraft.inputRefs,
    outputRefs: workflowDraft.planningRequired
      ? packages[0].outputRefs
      : [...workflowDraft.outputRefs],
    assignments,
    costProjection,
  }
  assertCompiledWorkGraph(assignments)
  const costLedger = projectCostLedger({
    assignments,
    policy: teamPolicy,
    budget: workflowDraft.intent.preferences.budget,
    accrued: task.costLedger?.accrued ?? 0,
    uncertain: task.costLedger?.uncertain ?? 0,
    futureCostMin: futureCost.min,
    futureCostMax: futureCost.max,
  })
  return {
    kind: costLedger.accrued + costLedger.uncertain + costLedger.nextWave > costLedger.automaticLimit ? "budget-decision" : "executable",
    plan,
    costLedger,
    policyPins: {
      workflow: workflowDraft.workflowPin,
      team: { policyId: teamPolicy.policyId, version: teamPolicy.version, digest: policyPin.digest },
      agentCatalogDigest: catalog.digest,
    },
    convergence: { maxAutonomousRounds: teamPolicy.maxAutonomousRounds, currentRound: task.currentStageRun.round },
    costProjection,
    summary: {
      mode: assignments.filter(({ teamRole }) => teamRole === "owner").length > 1 ? "team" : "solo",
      planningBootstrap: workflowDraft.planningRequired,
      owners: assignments.filter(({ teamRole }) => teamRole === "owner").length,
      challengerTier: challenger.costTier,
      expert: needsExpert,
    },
  }
}
