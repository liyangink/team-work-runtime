import { digestValue } from "../domain/digests.mjs"
import { artifactIdentity } from "../domain/artifact-reference.mjs"
import { createTaskAggregate } from "../domain/task-aggregate.mjs"
import { compilePolicyPlan } from "./policy-compiler.mjs"
import { costWeightForTier } from "../../policy/kernel.mjs"
import { composeDecisionPacket, decisionPacketRef } from "./decision-packet.mjs"
import { compileSteeringIntervention } from "./steering-intervention.mjs"

function slug(value) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70)
  return normalized || "task"
}

function inputEvidenceSource(reference) {
  return `input:${encodeURIComponent(reference.kind)}:${reference.locator.type}:${encodeURIComponent(reference.locator.value)}`
}

function inputFromEvidence(evidence) {
  if (evidence.kind !== "external-fact" || !evidence.sourceRef.startsWith("input:")) return null
  const match = /^input:([^:]+):(git-revision|external-uri):(.+)$/.exec(evidence.sourceRef)
  if (!match) return null
  return {
    kind: decodeURIComponent(match[1]),
    ref: `evidence:${evidence.evidenceId}`,
    digest: evidence.digest,
  }
}

function reportReferenceExists(state, ref, transientArtifactIds = new Set(), binding = {}) {
  if (ref.startsWith("report:")) {
    const accepted = state.acceptedReportRefs.some(({ reportId }) => reportId === ref.slice("report:".length))
    const artifactEvidence = state.evidence.filter(({ sourceRef, kind }) => sourceRef === ref && kind === "artifact-digest")
    return accepted && artifactEvidence.every(({ valid }) => valid)
  }
  if (ref.startsWith("artifact:")) {
    const artifactId = artifactIdentity(ref).artifactId
    return transientArtifactIds.has(artifactId) || state.artifacts.some((entry) => entry.artifactId === artifactId)
  }
  if (ref.startsWith("evidence:")) {
    return state.evidence.some(({ evidenceId, valid }) => evidenceId === ref.slice("evidence:".length) && valid)
  }
  if (ref.startsWith("check:")) {
    return state.evidence.some((evidence) => (
      evidence.sourceRef === ref
      && evidence.kind === "platform-check"
      && evidence.valid
      && evidence.result === "pass"
      && evidence.assignmentId === binding.assignmentId
      && evidence.attemptId === binding.attemptId
      && evidence.executionRef === binding.executionRef
      && typeof evidence.outputRef === "string"
      && typeof evidence.outputDigest === "string"
    ))
  }
  return false
}

function invalidReport(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined)
  error.code = "REPORT_CONTENT_INVALID"
  return error
}

function selectEdge(state, suppliedRoutes) {
  const edges = state.scope.edges.filter(({ from }) => from === state.currentStageRun.stage)
  const routes = suppliedRoutes ?? state.stagePlan?.routes
  if (edges.length === 0) return null
  const specOutcome = routes?.spec?.decision === "use-provider" ? "use-spec"
    : routes?.spec?.decision === "skip" ? "skip-spec"
      : null
  const e2eOutcome = routes?.e2e?.decision === "run" ? "run-e2e"
    : routes?.e2e?.decision === "skip" ? "skip-e2e"
      : null
  return edges.find(({ outcome }) => outcome === specOutcome)
    ?? edges.find(({ outcome }) => outcome === e2eOutcome)
    ?? edges.find(({ outcome }) => outcome === "pass")
    ?? (edges.length === 1 ? edges[0] : null)
}

export function createTaskLifecycle({
  store,
  reconciler,
  effectDriver,
  executionAdapter,
  specProviderAdapter,
  artifactRepository,
  workflowDefinition,
  workflowPin,
  teamPolicy,
  routeConfig = {},
  clock,
}) {
  let capabilities

  async function materializeInputs(references, stageRunId, occurredAt) {
    const artifacts = []
    const evidence = []
    for (const reference of references ?? []) {
      if (reference.locator.type === "project-path") {
        const [snapshot] = await artifactRepository.snapshot([reference.locator.value])
        artifacts.push({
          artifactId: `input-${artifactIdentity(`artifact:${reference.kind}`).artifactId}-${digestValue(reference.locator).slice(0, 12)}`,
          kind: reference.kind,
          path: snapshot.path,
          digest: snapshot.digest,
          stageRunId,
          recordedAt: occurredAt,
        })
      } else {
        evidence.push({
          evidenceId: `input-${digestValue(reference).slice(0, 24)}`,
          kind: "external-fact",
          sourceRef: inputEvidenceSource(reference),
          artifactRefs: [],
          artifactDigests: {},
          result: "unknown",
          digest: digestValue(reference),
          stageRunId,
          observedAt: occurredAt,
          valid: true,
        })
      }
    }
    return { artifacts, evidence }
  }

  async function ensureTask(input) {
    if (input.taskId) return { taskId: input.taskId, state: await reconciler.load(input.taskId), created: false }
    const taskId = `${slug(input.title)}-${digestValue({ title: input.title, objective: input.objective }).slice(0, 10)}`
    const createdAt = clock()
    const stageRunId = "stage-run-1"
    const inputs = await materializeInputs(input.existingArtifacts, stageRunId, createdAt)
    const initial = createTaskAggregate({
      taskId,
      title: input.title,
      objective: input.objective,
      workflow: {
        ...workflowPin,
        stages: workflowDefinition.stages.map(({ id }) => id),
        edges: workflowDefinition.edges,
        terminalStages: workflowDefinition.terminalStages,
      },
      entryStage: input.entryStage,
      completion: input.completion,
      stageRunId,
      createdAt,
      ...inputs,
    })
    try {
      return { taskId, state: await store.createTask(initial), created: true }
    } catch (error) {
      if (error.code !== "TASK_EXISTS") throw error
      const existing = await reconciler.load(taskId)
      const sameIdentity = existing.title === input.title
        && existing.objective === input.objective
        && existing.scope.entryStage === input.entryStage
        && digestValue(existing.scope.completion) === digestValue(input.completion)
      const sameInputs = inputs.artifacts.every((expected) => existing.artifacts.some((actual) => (
        actual.artifactId === expected.artifactId && actual.kind === expected.kind && actual.path === expected.path && actual.digest === expected.digest
      ))) && inputs.evidence.every((expected) => existing.evidence.some((actual) => (
        actual.evidenceId === expected.evidenceId && actual.sourceRef === expected.sourceRef && actual.digest === expected.digest
      )))
      if (!sameIdentity || !sameInputs) {
        throw Object.assign(new Error("the deterministic task id already belongs to different input"), { code: "TASK_ID_CONFLICT" })
      }
      return { taskId, state: existing, created: false }
    }
  }

  function routeInputsFor(specProbe, e2eAssessment) {
    const specMode = routeConfig.spec?.mode ?? "disabled"
    return {
      humanDecisionCapability: capabilities.features.humanDecisionProof,
      humanReview: routeConfig.humanReview ?? {},
      spec: {
        mode: specMode,
        configDigest: routeConfig.spec?.configDigest ?? digestValue({ mode: specMode }),
        ...(specMode === "disabled" ? {} : { probe: specProbe }),
      },
      e2e: {
        mode: routeConfig.e2e?.mode ?? "auto",
        userRequired: routeConfig.e2e?.userRequired ?? false,
        ...(e2eAssessment ? { assessment: e2eAssessment } : {}),
      },
    }
  }

  function normalizedCatalog() {
    const agents = capabilities.agents.map((agent) => ({
      agentId: agent.agentId,
      tier: agent.tier,
      modelFamily: agent.model,
      assignmentKinds: agent.capabilities.includes("*") ? ["*"] : [...agent.capabilities],
    }))
    return { digest: digestValue(agents), agents }
  }

  async function availableArtifacts(state) {
    const excludedArtifactIds = state.preflight?.kind === "route-assessment"
      ? new Set(state.preflight.plan.outputRefs.map((ref) => artifactIdentity(ref).artifactId))
      : new Set()
    return [
      ...state.artifacts
        .filter(({ artifactId, kind }) => kind !== "e2e-route-assessment" && !excludedArtifactIds.has(artifactId))
        .map(({ artifactId, kind, digest }) => ({ kind, ref: `artifact:${artifactId}`, digest })),
      ...state.evidence.flatMap((entry) => {
        const input = inputFromEvidence(entry)
        return input ? [input] : []
      }),
    ]
  }

  async function compilerInput(state, { proposal, e2eAssessment } = {}) {
    capabilities ??= await executionAdapter.capabilities()
    let specProbe
    const specMode = routeConfig.spec?.mode ?? "disabled"
    if (specMode !== "disabled") {
      specProbe = specProviderAdapter
        ? (() => specProviderAdapter.probe())()
        : { status: "missing", digest: digestValue({ provider: "missing" }) }
      specProbe = await specProbe
      if (!specProbe.digest) specProbe = { status: specProbe.status, digest: digestValue(specProbe) }
    }
    const inheritedE2ERoute = state.currentStageRun.stage === "e2e"
      ? state.routeDecisions.findLast(({ routeKind, outcome, decision }) => routeKind === "e2e" && outcome === "selected" && decision === "run")?.routeSnapshot
      : undefined
    const routeInputs = routeInputsFor(specProbe, e2eAssessment)
    if (inheritedE2ERoute) routeInputs.e2e.resolvedRoute = inheritedE2ERoute
    return {
      task: state,
      taskIntent: state.taskIntent,
      availableArtifacts: await availableArtifacts(state),
      workflowDefinition,
      teamPolicy,
      agentCatalog: normalizedCatalog(),
      routeInputs,
      ...(proposal ? { proposal } : {}),
    }
  }

  async function recordRouteOutcome(state, routeKind, route, kind) {
    const decision = route?.decision
    const routeDigest = route?.digest ?? digestValue(route)
    const decisionId = `route-${digestValue({ stageRunId: state.currentStageRun.stageRunId, routeKind, routeDigest }).slice(0, 20)}`
    if (state.routeDecisions.some((entry) => entry.decisionId === decisionId)) return state
    return (await reconciler.commit(state.taskId, () => ({
      fact: {
        type: "route.decision-recorded",
        decision: {
          decisionId,
          stageRunId: state.currentStageRun.stageRunId,
          stage: state.currentStageRun.stage,
          routeKind,
          outcome: kind === "route-blocked" ? "blocked" : kind === "route-selected" ? "selected" : "skipped",
          decision,
          routeDigest,
          basisRefs: [...new Set([
            routeDigest,
            route.configDigest,
            route.probeDigest,
            route.taskIntentDigest,
            route.artifactSnapshotDigest,
            route.assessmentDigest,
            ...(route.evidenceRefs ?? []),
          ].filter(Boolean))],
          reason: route.reason,
          recovery: kind === "route-blocked" ? "replan-after-capability-change"
            : kind === "route-selected" ? "follow-selected-edge"
              : "follow-skip-edge",
          ...(kind === "route-selected" ? { routeSnapshot: structuredClone(route) } : {}),
          recordedAt: clock(),
        },
        occurredAt: clock(),
      },
      refs: [routeDigest],
    }))).state
  }

  async function installCompiled(state, compiled) {
    if (["route-skip", "route-blocked"].includes(compiled.kind)) {
      const routeKind = workflowDefinition.stages.find(({ id }) => id === state.currentStageRun.stage)?.route
      const route = compiled.routes[routeKind]
      state = await recordRouteOutcome(state, routeKind, route, compiled.kind)
    }
    if (compiled.kind === "route-skip") {
      const desiredOutcome = compiled.routes.spec.decision === "skip" && workflowDefinition.stages.find(({ id }) => id === state.currentStageRun.stage)?.route === "spec"
        ? "skip-spec"
        : compiled.routes.e2e.decision === "skip" ? "skip-e2e" : null
      const edge = state.scope.edges.find(({ from, outcome }) => from === state.currentStageRun.stage && outcome === desiredOutcome)
      if (!edge) return { state, reason: "route-skip" }
      const skipped = await reconciler.commit(state.taskId, (snapshot) => ({
        fact: {
          type: "stage.skipped",
          to: edge.to,
          outcome: edge.outcome,
          nextStageRunId: `stage-run-${snapshot.currentStageRun.sequence + 1}`,
          reason: edge.outcome === "skip-spec"
            ? compiled.routes.spec.reason
            : compiled.routes.e2e.reason ?? "compiled route skipped this stage",
          occurredAt: clock(),
        },
        refs: [compiled.routes.spec.digest, compiled.routes.e2e.digest].filter(Boolean),
      }))
      return planCurrentStage(skipped.state)
    }
    if (compiled.kind === "route-blocked") {
      return { state, reason: compiled.kind }
    }
    const result = await reconciler.commit(state.taskId, () => ({
      fact: compiled.plan ? {
        type: "stage-plan.frozen",
        plan: compiled.plan,
        costLedger: compiled.costLedger,
        ...(state.preflight ? { preflightId: state.preflight.preflightId } : {}),
        occurredAt: clock(),
      } : {
        type: "preflight.started",
        plan: compiled.preflight,
        costLedger: compiled.costLedger,
        occurredAt: clock(),
      },
      refs: [compiled.plan?.planId ?? compiled.preflight.planId],
    }))
    return { state: result.state, reason: "planned" }
  }

  async function planCurrentStage(state, extra = {}) {
    return installCompiled(state, compilePolicyPlan(await compilerInput(state, extra)))
  }

  async function rejectReport(state, assignment, attempt, reason) {
    return (await reconciler.commit(state.taskId, () => ({
      fact: {
        type: "assignment.report-rejected",
        assignmentId: assignment.assignmentId,
        attemptId: attempt.attemptId,
        reportId: attempt.reportRef,
        reportDigest: attempt.reportDigest,
        reason,
        occurredAt: clock(),
      },
      refs: [assignment.assignmentId, attempt.reportRef],
    }))).state
  }

  async function verifyReportedAssignment(state, assignment) {
    const attempt = assignment.attempts.at(-1)
    const record = await store.loadRecord(state.taskId, "report", attempt.reportRef)
    const report = record.report
    let snapshots
    try {
      if (assignment.teamRole !== "owner" && report.artifacts.length > 0) throw invalidReport("review roles cannot modify product artifacts")
      if (assignment.teamRole === "expert" && !report.verdict) throw invalidReport("Expert delivery requires a verdict")
      if (assignment.teamRole === "owner" && report.artifacts.length !== assignment.writableRefs.length) {
        throw invalidReport("Owner delivery must provide every declared artifact exactly once")
      }
      if (assignment.teamRole !== "owner" && report.evidenceRefs.length === 0) throw invalidReport("review delivery requires evidence references")
      if (assignment.teamRole === "owner" && report.artifacts.length === 0 && report.evidenceRefs.length === 0) {
        throw invalidReport("Owner response requires artifact or review evidence")
      }
      const writableArtifactIds = new Set(assignment.writableRefs
        .filter((ref) => ref.startsWith("artifact:"))
        .map((ref) => artifactIdentity(ref).artifactId))
      const protectedArtifacts = state.artifacts.filter(({ artifactId }) => !writableArtifactIds.has(artifactId))
      if (protectedArtifacts.length > 0) {
        const currentInputs = await artifactRepository.snapshot(protectedArtifacts.map(({ path }) => path))
        const changedInput = protectedArtifacts.find((artifact, index) => artifact.digest !== currentInputs[index].digest)
        if (changedInput) throw invalidReport(`registered input changed outside the assignment writable scope: ${changedInput.path}`)
      }
      const declaredRefs = new Set(assignment.writableRefs)
      const reportedRefs = new Set(report.artifacts.map(({ ref }) => ref))
      if (reportedRefs.size !== report.artifacts.length || declaredRefs.size !== reportedRefs.size || [...declaredRefs].some((ref) => !reportedRefs.has(ref))) {
        throw invalidReport("Owner report artifacts must identify exactly the assignment writable refs")
      }
      if (report.artifacts.length > 0) {
        const outputCheck = await artifactRepository.verifyDeclaredOutputs({
          taskId: state.taskId,
          stageRunId: state.currentStageRun.stageRunId,
          assignmentId: assignment.assignmentId,
          attemptId: attempt.attemptId,
          executionRef: attempt.executionRef,
          writableRefs: assignment.writableRefs,
          outputs: report.artifacts,
        })
        if (!outputCheck.valid) throw invalidReport(`report claims an unverified output path: ${outputCheck.mismatches[0]?.path}`)
      }
      try {
        snapshots = await artifactRepository.snapshot(report.artifacts.map(({ path }) => path))
      } catch (error) {
        if (error.code === "ARTIFACT_MISSING") throw invalidReport(error.message, error)
        throw error
      }
      const artifactIds = new Set(report.artifacts.map(({ ref }) => artifactIdentity(ref).artifactId))
      for (const [index, snapshot] of snapshots.entries()) {
        const identity = artifactIdentity(report.artifacts[index].ref)
        const conflicting = state.artifacts.find(({ artifactId, path }) => path === snapshot.path && artifactId !== identity.artifactId)
        if (conflicting) throw invalidReport(`artifact path is already bound to ${conflicting.artifactId}`)
      }
      const evidenceRefs = [
        ...report.evidenceRefs,
        ...(report.checks ?? []).flatMap(({ evidenceRef }) => evidenceRef ? [evidenceRef] : []),
        ...(report.findings ?? []).flatMap(({ evidenceRefs }) => evidenceRefs),
        ...(report.verdict?.evidenceRefs ?? []),
      ]
      if (report.verdict && report.verdict.evidenceRefs.length === 0) throw invalidReport("Expert verdict requires evidence references")
      const reportBinding = {
        assignmentId: assignment.assignmentId,
        attemptId: attempt.attemptId,
        executionRef: attempt.executionRef,
      }
      const unknown = evidenceRefs.find((ref) => !reportReferenceExists(state, ref, artifactIds, reportBinding))
      if (unknown) throw invalidReport(`report references unknown or stale evidence: ${unknown}`)
      for (const ref of new Set(evidenceRefs.filter((entry) => entry.startsWith("check:")))) {
        const check = state.evidence.find((entry) => (
          entry.sourceRef === ref
          && entry.kind === "platform-check"
          && entry.assignmentId === assignment.assignmentId
          && entry.attemptId === attempt.attemptId
          && entry.executionRef === attempt.executionRef
        ))
        let current
        try {
          const snapshots = await artifactRepository.snapshot([check.outputRef])
          current = snapshots[0]
        } catch (error) {
          if (error.code === "ARTIFACT_MISSING") throw invalidReport(`check output is missing: ${check.outputRef}`, error)
          throw error
        }
        if (current.digest !== check.outputDigest) throw invalidReport(`check output changed after capture: ${check.outputRef}`)
      }
      if (assignment.execution.resumeAssignmentId) {
        const requiredReviewRefs = assignment.dependsOn.flatMap((dependencyId) => {
          const dependency = state.workGraph.assignments.find(({ assignmentId }) => assignmentId === dependencyId)
          if (!dependency || !["challenger", "expert"].includes(dependency.teamRole)) return []
          const dependencyAttempt = dependency.attempts.at(-1)
          return dependencyAttempt?.status === "accepted" ? [`report:${dependencyAttempt.reportRef}`] : []
        })
        const missingReviewRef = requiredReviewRefs.find((ref) => !evidenceRefs.includes(ref))
        if (missingReviewRef) throw invalidReport(`Owner response must cite the accepted review report: ${missingReviewRef}`)
      }
      if (state.preflight?.status === "active" && state.preflight.kind === "planning-bootstrap" && assignment.teamRole === "owner" && report.artifacts.length > 0) {
        let parsed
        try {
          parsed = JSON.parse(await artifactRepository.read(report.artifacts[0].path))
        } catch (error) {
          if (error.code === "ARTIFACT_MISSING" || error instanceof SyntaxError) throw invalidReport(`planning proposal is not readable structured JSON: ${error.message}`, error)
          throw error
        }
        const provisional = structuredClone(state)
        provisional.artifacts = [
          ...provisional.artifacts,
          ...snapshots.map((snapshot, index) => ({
            ...artifactIdentity(report.artifacts[index].ref),
            path: snapshot.path,
            digest: snapshot.digest,
            stageRunId: state.currentStageRun.stageRunId,
            recordedAt: clock(),
          })),
        ]
        provisional.preflight.status = "satisfied"
        provisional.preflight.result = {
          kind: "planning-bootstrap",
          ref: report.artifacts[0].path,
          digest: snapshots[0].digest,
          evidenceRefs: [`report:${attempt.reportRef}`],
        }
        provisional.workGraph = { assignments: [] }
        const input = await compilerInput(provisional, { proposal: parsed })
        try {
          compilePolicyPlan(input)
        } catch (error) {
          throw invalidReport(`planning proposal cannot compile: ${error.message}`, error)
        }
      }
    } catch (error) {
      if (error.code !== "REPORT_CONTENT_INVALID") throw error
      return rejectReport(state, assignment, attempt, error.message)
    }

    const artifacts = snapshots.map((snapshot, index) => ({
      ...artifactIdentity(report.artifacts[index].ref),
      path: snapshot.path,
      digest: snapshot.digest,
      stageRunId: state.currentStageRun.stageRunId,
    }))
    const evidence = artifacts.map((artifact) => ({
      evidenceId: `artifact-${digestValue({ reportId: attempt.reportRef, artifactId: artifact.artifactId }).slice(0, 24)}`,
      kind: "artifact-digest",
      sourceRef: `report:${attempt.reportRef}`,
      artifactRefs: [artifact.artifactId],
      result: "pass",
      digest: artifact.digest,
      stageRunId: state.currentStageRun.stageRunId,
    }))
    return (await reconciler.commit(state.taskId, () => ({
      fact: {
        type: "assignment.report-verified",
        assignmentId: assignment.assignmentId,
        attemptId: attempt.attemptId,
        reportId: attempt.reportRef,
        reportDigest: attempt.reportDigest,
        artifacts,
        evidence,
        occurredAt: clock(),
      },
      refs: [assignment.assignmentId, attempt.reportRef, ...artifacts.map(({ artifactId }) => artifactId)],
    }))).state
  }

  async function acceptVerifiedAssignment(state, assignment) {
    const attempt = assignment.attempts.at(-1)
    return (await reconciler.commit(state.taskId, () => ({
      fact: {
        type: "assignment.report-accepted",
        assignmentId: assignment.assignmentId,
        attemptId: attempt.attemptId,
        reportId: attempt.reportRef,
        reportDigest: attempt.reportDigest,
        occurredAt: clock(),
      },
      refs: [assignment.assignmentId, attempt.reportRef],
    }))).state
  }

  async function acceptedReports(state) {
    return Promise.all(state.workGraph.assignments.map(async (assignment) => {
      const attempt = assignment.attempts.at(-1)
      const record = await store.loadRecord(state.taskId, "report", attempt.reportRef)
      return { assignment, attempt, report: record.report, reportId: attempt.reportRef }
    }))
  }

  async function availableDecisionReports(state) {
    return Promise.all(state.workGraph.assignments.flatMap((assignment) => {
      const attempt = assignment.attempts.at(-1)
      if (!attempt?.reportRef || !["reported", "verified", "accepted"].includes(attempt.status)) return []
      return [store.loadRecord(state.taskId, "report", attempt.reportRef).then(({ report }) => ({ assignment, report }))]
    }))
  }

  async function prepareDecision(state, decision) {
    const packet = composeDecisionPacket({
      taskState: state,
      decision,
      reports: await availableDecisionReports(state),
    })
    return effectDriver.prepareHumanDecision({
      taskId: state.taskId,
      decision: {
        ...decision,
        packet,
        packetRef: decisionPacketRef(state.taskId, packet.packetId),
        packetDigest: digestValue(packet),
      },
    })
  }

  async function currentDecisionPacket(state) {
    const prefix = `.team-work/tasks/${state.taskId}/packets/`
    const ref = state.pendingDecision?.packetRef
    if (!ref?.startsWith(prefix) || !ref.endsWith(".json")) {
      throw Object.assign(new Error("the current stable point has no readable DecisionPacket"), { code: "ACTION_STALE" })
    }
    const packetId = ref.slice(prefix.length, -".json".length)
    return store.loadRecord(state.taskId, "packet", packetId)
  }

  function enrichE2EAssessment(state, parsed, reports) {
    if (state.preflight?.kind !== "route-assessment") return parsed
    const owner = reports.find(({ assignment }) => assignment.teamRole === "owner" && assignment.writableRefs.length > 0)
    const challenger = reports.find(({ assignment }) => assignment.teamRole === "challenger")
    if (!owner || !challenger || typeof parsed !== "object" || parsed === null) {
      throw new Error("route assessment requires accepted Owner and Challenger reports")
    }
    const evidenceRefs = [...new Set([
      ...(Array.isArray(parsed.evidenceRefs) ? parsed.evidenceRefs : []),
      `report:${owner.reportId}`,
      `report:${challenger.reportId}`,
    ])]
    const body = {
      assessmentId: parsed.assessmentId ?? `assessment-${digestValue({ taskId: state.taskId, stageRunId: state.currentStageRun.stageRunId }).slice(0, 20)}`,
      taskId: state.taskId,
      stageRunId: state.currentStageRun.stageRunId,
      applicable: parsed.applicable,
      criticalCrossSystemPath: parsed.criticalCrossSystemPath,
      environment: parsed.environment,
      evidenceRefs,
      artifactSnapshotDigest: state.preflight.plan.routes.e2e.artifactSnapshotDigest,
      evidenceSnapshotDigest: digestValue(evidenceRefs),
      ownerAssignmentId: owner.assignment.assignmentId,
      challengerAssignmentId: challenger.assignment.assignmentId,
      ownerSessionDigest: digestValue(owner.attempt.executionRef),
      challengerSessionDigest: digestValue(challenger.attempt.executionRef),
      ownerReportRef: `report:${owner.reportId}`,
      challengerReportRef: `report:${challenger.reportId}`,
    }
    return { ...body, digest: digestValue(body) }
  }

  async function reportsAgree(state) {
    const reports = await acceptedReports(state)
    const currentArtifacts = state.artifacts.filter(({ stageRunId }) => stageRunId === state.currentStageRun.stageRunId)
    if (currentArtifacts.length > 0) {
      let snapshots
      try {
        snapshots = await artifactRepository.snapshot(currentArtifacts.map(({ path }) => path))
      } catch (error) {
        if (error.code === "ARTIFACT_MISSING") return false
        throw error
      }
      if (snapshots.some((snapshot, index) => snapshot.digest !== currentArtifacts[index].digest)) return false
    }
    return state.evidence.every(({ kind, valid, stageRunId }) => stageRunId !== state.currentStageRun.stageRunId || kind !== "artifact-digest" || valid) && reports.every(({ assignment, report }) => (
      report.outcome === "delivered"
      && report.recommendation === "accept"
      && (assignment.teamRole !== "expert" || report.verdict?.outcome === "accept")
    ))
  }

  async function replanAfterPreflightFailure(state, reason) {
    if (state.currentStageRun.round >= (state.preflight?.plan?.convergence.maxAutonomousRounds ?? 3)) {
      return { state, reason: "round-limit" }
    }
    const replanned = await reconciler.commit(state.taskId, (snapshot) => ({
      fact: {
        type: "stage.replanned",
        nextStageRunId: `stage-run-${snapshot.currentStageRun.sequence + 1}`,
        reason,
        occurredAt: clock(),
      },
      refs: [state.preflight?.preflightId].filter(Boolean),
    }))
    return planCurrentStage(replanned.state)
  }

  async function finishPreflight(state) {
    if (!await reportsAgree(state)) return replanAfterPreflightFailure(state, "预检团队尚未达成一致")
    const reports = await acceptedReports(state)
    const owner = reports.find(({ assignment }) => assignment.teamRole === "owner" && assignment.writableRefs.length > 0)
    const outputPath = owner?.report.artifacts[0]?.path
    if (!outputPath) throw Object.assign(new Error("preflight Owner did not produce its declared result"), { code: "WORK_CHAIN_INCOMPLETE" })
    const [snapshot] = await artifactRepository.snapshot([outputPath])
    let parsed
    try {
      parsed = JSON.parse(await artifactRepository.read(outputPath))
      parsed = enrichE2EAssessment(state, parsed, reports)
    } catch (error) {
      return replanAfterPreflightFailure(state, `preflight result is not readable structured JSON: ${error.message}`)
    }
    const result = {
      kind: state.preflight.kind,
      ref: outputPath,
      digest: snapshot.digest,
      evidenceRefs: reports.map(({ reportId }) => `report:${reportId}`),
    }
    const provisional = structuredClone(state)
    provisional.preflight.status = "satisfied"
    provisional.preflight.result = result
    const extra = state.preflight.kind === "planning-bootstrap" ? { proposal: parsed } : { e2eAssessment: parsed }
    let compiled
    try {
      compiled = compilePolicyPlan(await compilerInput(provisional, extra))
    } catch (error) {
      return replanAfterPreflightFailure(state, `preflight result cannot compile: ${error.message}`)
    }
    const satisfied = await reconciler.commit(state.taskId, () => ({
      fact: { type: "preflight.satisfied", preflightId: state.preflight.preflightId, result, occurredAt: clock() },
      refs: [state.preflight.preflightId, ...reports.map(({ reportId }) => reportId)],
    }))
    return installCompiled(satisfied.state, compiled)
  }

  async function compileSatisfiedPreflight(state) {
    const [snapshot] = await artifactRepository.snapshot([state.preflight.result.ref])
    if (snapshot.digest !== state.preflight.result.digest) {
      return replanAfterPreflightFailure(state, "satisfied preflight result changed before formal planning")
    }
    let parsed
    try {
      parsed = JSON.parse(await artifactRepository.read(state.preflight.result.ref))
      parsed = enrichE2EAssessment(state, parsed, await acceptedReports(state))
    } catch (error) {
      return replanAfterPreflightFailure(state, `satisfied preflight result is invalid JSON: ${error.message}`)
    }
    return state.preflight.kind === "planning-bootstrap"
      ? planCurrentStage(state, { proposal: parsed })
      : planCurrentStage(state, { e2eAssessment: parsed })
  }

  async function transition(taskId, status) {
    return (await reconciler.commit(taskId, () => ({ fact: { type: "stage-run.transitioned", status, occurredAt: clock() } }))).state
  }

  async function ensureReady(state) {
    let current = state
    if (current.currentStageRun.status === "dispatching") current = await transition(state.taskId, "waiting-reports")
    if (current.currentStageRun.status === "waiting-reports") current = await transition(state.taskId, "reviewing")
    if (current.currentStageRun.status === "reviewing") current = await transition(state.taskId, "ready-to-advance")
    return current
  }

  async function reopenForRework(state, reason) {
    const ready = await ensureReady(state)
    if (ready.currentStageRun.round >= (ready.stagePlan?.convergence.maxAutonomousRounds ?? 3)) {
      return { state: ready, reason: "round-limit" }
    }
    const reopened = await reconciler.commit(ready.taskId, (snapshot) => ({
      fact: {
        type: "stage.reopened",
        nextStageRunId: `stage-run-${snapshot.currentStageRun.sequence + 1}`,
        reason,
        occurredAt: clock(),
      },
    }))
    return planCurrentStage(reopened.state)
  }

  async function returnForOutcome(state, outcome, reason) {
    const ready = await ensureReady(state)
    const edge = ready.scope.edges.find(({ from, outcome: candidate }) => from === ready.currentStageRun.stage && candidate === outcome)
    if (!edge) return reopenForRework(ready, reason)
    if (edge.to === ready.currentStageRun.stage && ready.currentStageRun.round >= (ready.stagePlan?.convergence.maxAutonomousRounds ?? 3)) {
      return { state: ready, reason: "round-limit" }
    }
    const returned = await reconciler.commit(ready.taskId, (snapshot) => ({
      fact: {
        type: "stage.returned",
        to: edge.to,
        outcome: edge.outcome,
        nextStageRunId: `stage-run-${snapshot.currentStageRun.sequence + 1}`,
        reason,
        occurredAt: clock(),
      },
      refs: [edge.outcome],
    }))
    return planCurrentStage(returned.state)
  }

  async function routeTeamRework(state) {
    const reports = await acceptedReports(state)
    const requested = [...new Set(reports.flatMap(({ report }) => report.recommendation === "accept" || !report.workflowOutcome
      ? []
      : [report.workflowOutcome]))]
    if (requested.length > 1) return reopenForRework(state, `团队对返工路径存在分歧：${requested.join("、")}`)
    const fallback = state.scope.edges.find(({ from, outcome }) => from === state.currentStageRun.stage && outcome === "rework")?.outcome
    const outcome = requested[0] ?? fallback
    return outcome
      ? returnForOutcome(state, outcome, "团队审查要求沿工作流返工")
      : reopenForRework(state, "团队审查要求返工")
  }

  function gateFor(state) {
    const gates = state.stagePlan?.routes?.humanGates ?? []
    const stageGate = gates.find(({ stage }) => stage === state.currentStageRun.stage)
    if (stageGate) return stageGate
    if (state.scope.completionStages.includes(state.currentStageRun.stage)) {
      return gates.find(({ gateId }) => gateId === "final-acceptance")
        ?? { gateId: "scoped-final-acceptance", requirement: "required", action: "wait", proofMode: capabilities.features.humanDecisionProof }
    }
    return null
  }

  async function prepareGate(state, gate, leadBindingRef) {
    if (gate.action === "skip") return state
    const matching = gate.artifactKind ? state.artifacts.filter(({ kind }) => kind === gate.artifactKind) : []
    const current = state.artifacts.filter(({ stageRunId }) => stageRunId === state.currentStageRun.stageRunId)
    const artifactRefs = [...new Set((matching.length > 0 ? matching : current).map(({ artifactId }) => artifactId))]
    if (artifactRefs.length === 0) throw Object.assign(new Error(`${gate.gateId} requires a registered artifact`), { code: "WORK_CHAIN_INCOMPLETE" })
    const returnChoices = gate.gateId === "final-acceptance"
      ? state.scope.edges
        .filter(({ from, outcome }) => from === state.currentStageRun.stage && outcome?.startsWith("return-"))
        .map(({ outcome }) => outcome)
      : []
    await prepareDecision(state, {
        decisionId: `${gate.gateId}-${state.currentStageRun.stageRunId}`,
        requirement: gate.requirement,
        proofMode: gate.proofMode,
        leadBindingRef,
        question: gate.gateId === "design-approval" ? "方案是否已经与预期一致，可以进入后续实施？" : "当前成果是否符合预期，可以完成本任务吗？",
        artifactRefs,
        choices: returnChoices.length > 0 ? ["accept", ...returnChoices] : ["accept", "rework"],
    })
    return (await effectDriver.run({ taskId: state.taskId, waitBudgetMs: 0 })).state
  }

  async function prepareConvergenceDecision(state, leadBindingRef) {
    capabilities ??= await executionAdapter.capabilities()
    const artifactRefs = [...new Set(state.artifacts.map(({ artifactId }) => artifactId))]
    if (artifactRefs.length === 0) return { state, reason: "round-limit" }
    await prepareDecision(state, {
        decisionId: `convergence-${state.currentStageRun.stageRunId}`,
        requirement: "required",
        proofMode: capabilities.features.humanDecisionProof,
        leadBindingRef,
        question: "团队已达到自主收敛上限；是否结合你的意见再开启一轮返工？",
        artifactRefs,
        choices: ["rework"],
    })
    return { state: (await effectDriver.run({ taskId: state.taskId, waitBudgetMs: 0 })).state, reason: "awaiting-user" }
  }

  function nextBudgetBlockedAssignment(state) {
    const byId = new Map(state.workGraph.assignments.map((assignment) => [assignment.assignmentId, assignment]))
    return state.workGraph.assignments.find((assignment) => (
      ["planned", "rework", "lost"].includes(assignment.status)
      && assignment.attempts.length < (state.stagePlan?.convergence.maxAutonomousRounds ?? 3)
      && assignment.execution
      && assignment.dependsOn.every((dependency) => byId.get(dependency)?.status === "accepted")
      && state.costLedger.accrued + state.costLedger.uncertain + costWeightForTier(assignment.costTier) > state.costLedger.automaticLimit
    ))
  }

  async function prepareBudgetDecision(state, leadBindingRef) {
    capabilities ??= await executionAdapter.capabilities()
    const assignment = nextBudgetBlockedAssignment(state)
    if (!assignment) return { state, reason: "budget-decision" }
    const approvedLimit = state.costLedger.accrued + state.costLedger.uncertain + costWeightForTier(assignment.costTier)
    const artifactRefs = [...new Set(state.artifacts.map(({ artifactId }) => artifactId))]
    if (artifactRefs.length === 0) return { state, reason: "budget-decision" }
    await prepareDecision(state, {
        decisionId: `budget-${digestValue({ stageRunId: state.currentStageRun.stageRunId, assignmentId: assignment.assignmentId, approvedLimit }).slice(0, 24)}`,
        requirement: "required",
        proofMode: capabilities.features.humanDecisionProof,
        leadBindingRef,
        question: `下一位成员会使累计成本从 ${state.costLedger.accrued + state.costLedger.uncertain} 增至 ${approvedLimit}，超过自动上限 ${state.costLedger.automaticLimit}；是否批准本次增额？`,
        artifactRefs,
        choices: ["accept", "replan", "stop"],
    })
    return { state: (await effectDriver.run({ taskId: state.taskId, waitBudgetMs: 0 })).state, reason: "awaiting-user" }
  }

  async function finalizeAcceptedGraph(state, leadBindingRef) {
    if (state.preflight?.status === "active") return finishPreflight(state)
    let ready = await ensureReady(state)
    if (!await reportsAgree(ready)) return routeTeamRework(ready)

    const intervention = ready.stagePlan?.intervention
    if (intervention) {
      const accepted = ready.decisionHistory.some(({ decisionId, stageRunId, choice }) => (
        decisionId === intervention.resumeDecisionId
        && stageRunId === ready.currentStageRun.stageRunId
        && choice === "accept"
      ))
      if (!accepted) {
        const artifactRefs = [...new Set([
          ...intervention.artifactIds,
          ...ready.artifacts.filter(({ stageRunId }) => stageRunId === ready.currentStageRun.stageRunId).map(({ artifactId }) => artifactId),
        ])].filter((artifactId) => ready.artifacts.some((artifact) => artifact.artifactId === artifactId))
        if (artifactRefs.length === 0) throw Object.assign(new Error("steering intervention produced no reviewable artifact"), { code: "WORK_CHAIN_INCOMPLETE" })
        await prepareDecision(ready, {
          decisionId: intervention.resumeDecisionId,
          requirement: intervention.requirement,
          proofMode: intervention.proofMode,
          leadBindingRef,
          question: intervention.resumeQuestion,
          artifactRefs,
          choices: intervention.resumeChoices,
        })
        return { state: (await effectDriver.run({ taskId: ready.taskId, waitBudgetMs: 0 })).state, reason: "awaiting-user" }
      }
    }

    const gate = gateFor(ready)
    const gateDecisionId = gate && `${gate.gateId}-${ready.currentStageRun.stageRunId}`
    const gateAccepted = gateDecisionId && ready.decisionHistory.some(({ decisionId, choice }) => decisionId === gateDecisionId && choice === "accept")
    if (gate && gate.action !== "skip" && !gateAccepted) {
      return { state: await prepareGate(ready, gate, leadBindingRef), reason: "awaiting-user" }
    }
    if (ready.scope.completionStages.includes(ready.currentStageRun.stage)) {
      if (ready.specLifecycle.task && !ready.specLifecycle.archive) {
        const observed = await effectDriver.recordSpecStatus({ taskId: ready.taskId })
        ready = observed.state
        if (ready.status === "blocked") return { state: ready, reason: "blocked" }
        if (ready.specLifecycle.status?.state !== "complete") return { state: ready, reason: "spec-incomplete" }
        const validated = await effectDriver.validateSpec({ taskId: ready.taskId })
        ready = validated.state
        if (ready.status === "blocked" || !ready.specLifecycle.validation?.valid || !ready.specLifecycle.validation?.complete) {
          return { state: ready, reason: "blocked" }
        }
        const archived = await effectDriver.archiveSpec({ taskId: ready.taskId })
        ready = archived.state
        if (archived.inDoubt) return { state: ready, reason: "in-doubt" }
        if (archived.blocked || !ready.specLifecycle.archive) return { state: ready, reason: "blocked" }
      }
      const completed = await reconciler.commit(ready.taskId, () => ({ fact: { type: "task.completed", occurredAt: clock() } }))
      return { state: completed.state, reason: "completed" }
    }
    const edge = selectEdge(ready)
    if (!edge) {
      const outgoingOutcomes = new Set(ready.scope.edges
        .filter(({ from }) => from === ready.currentStageRun.stage)
        .map(({ outcome }) => outcome))
      const routeKind = outgoingOutcomes.has("use-spec") || outgoingOutcomes.has("skip-spec") ? "spec"
        : outgoingOutcomes.has("run-e2e") || outgoingOutcomes.has("skip-e2e") ? "e2e"
          : workflowDefinition.stages.find(({ id }) => id === ready.currentStageRun.stage)?.route
      const route = ready.stagePlan?.routes?.[routeKind]
      if (route?.decision === "block") {
        return { state: await recordRouteOutcome(ready, routeKind, route, "route-blocked"), reason: "route-blocked" }
      }
      return { state: ready, reason: "route-blocked" }
    }
    if (edge.outcome === "run-e2e") {
      ready = await recordRouteOutcome(ready, "e2e", ready.stagePlan.routes.e2e, "route-selected")
    }
    const advanced = await reconciler.commit(ready.taskId, (snapshot) => ({
      fact: { type: "stage.advanced", to: edge.to, nextStageRunId: `stage-run-${snapshot.currentStageRun.sequence + 1}`, occurredAt: clock() },
    }))
    return planCurrentStage(advanced.state)
  }

  async function runToStable({ taskId, leadBindingRef, waitBudgetMs = 0, signal }) {
    const deadline = Date.now() + Math.max(0, waitBudgetMs)
    for (let step = 0; step < 64; step += 1) {
      const remaining = Math.max(0, deadline - Date.now())
      const outcome = await effectDriver.run({
        taskId,
        waitBudgetMs: waitBudgetMs > 0 ? remaining : 0,
        ...(signal ? { signal } : {}),
      })
      const state = outcome.state
      if (outcome.reason === "budget-decision") return prepareBudgetDecision(state, leadBindingRef)
      if (state.preflight?.status === "satisfied") {
        const result = await compileSatisfiedPreflight(state)
        if (result.reason === "planned") continue
        if (result.reason === "round-limit") return prepareConvergenceDecision(result.state, leadBindingRef)
        return result
      }
      const reported = state.workGraph.assignments.find(({ status }) => status === "reported")
      if (reported) {
        await verifyReportedAssignment(state, reported)
        continue
      }
      const verified = state.workGraph.assignments.find(({ status }) => status === "verified")
      if (verified) {
        await acceptVerifiedAssignment(state, verified)
        continue
      }
      const exhausted = state.workGraph.assignments.find(({ status, attempts }) => status === "rework" && attempts.length >= 3)
      if (exhausted) return prepareConvergenceDecision(state, leadBindingRef)
      if (state.workGraph.assignments.length > 0 && state.workGraph.assignments.every(({ status }) => status === "accepted")) {
        const result = await finalizeAcceptedGraph(state, leadBindingRef)
        if (result.reason === "planned") continue
        if (result.reason === "round-limit") return prepareConvergenceDecision(result.state, leadBindingRef)
        return result
      }
      return outcome
    }
    throw new Error("Task Driver exceeded its lifecycle transition budget")
  }

  async function plan({ taskId, intent, leadBindingRef }) {
    let state = await reconciler.load(taskId)
    if (state.taskIntent === null) {
      const recorded = await reconciler.commit(taskId, () => ({
        fact: { type: "task-intent.recorded", intent, occurredAt: clock() },
        refs: [state.currentStageRun.stageRunId],
      }))
      state = recorded.state
    } else if (digestValue(state.taskIntent) !== digestValue(intent)) {
      const previousRun = state.stageRuns.at(-1)
      const revisable = state.currentStageRun.status === "planned"
        && state.stagePlan === null
        && state.preflight === null
        && state.workGraph.assignments.length === 0
        && previousRun?.status === "rework"
      if (!revisable) {
        const error = new Error("task intent changes require a controlled replan")
        error.code = "TASK_INTENT_CONFLICT"
        throw error
      }
      state = (await reconciler.commit(taskId, () => ({
        fact: {
          type: "task-intent.revised",
          intent,
          reason: previousRun.reason,
          occurredAt: clock(),
        },
        refs: [previousRun.stageRunId],
      }))).state
    }
    const blockedRoute = state.routeDecisions.findLast(({ stageRunId, outcome }) => (
      stageRunId === state.currentStageRun.stageRunId && outcome === "blocked"
    ))
    if (state.status === "blocked" && blockedRoute?.recovery === "replan-after-capability-change" && (state.stagePlan || state.preflight)) {
      state = (await reconciler.commit(taskId, (snapshot) => ({
        fact: {
          type: "stage.replanned",
          nextStageRunId: `stage-run-${snapshot.currentStageRun.sequence + 1}`,
          reason: "重新检查已变化的流程能力或环境",
          occurredAt: clock(),
        },
        refs: [blockedRoute.decisionId],
      }))).state
    }
    if (!state.stagePlan && !state.preflight) {
      const installed = await planCurrentStage(state)
      if (installed.reason !== "planned") return installed
    }
    return runToStable({ taskId, leadBindingRef })
  }

  async function steer({ taskId, input, leadBindingRef }) {
    let state = await reconciler.load(taskId)
    if (input.action !== "choose") {
      capabilities ??= await executionAdapter.capabilities()
      const compiled = compileSteeringIntervention({
        state,
        input,
        packet: await currentDecisionPacket(state),
        teamPolicy,
        agentCatalog: normalizedCatalog(),
      })
      if (compiled.kind === "replan") {
        const replanned = await reconciler.commit(taskId, (current) => {
          if (
            current.revision !== state.revision
            || current.pendingDecision?.packetRef !== state.pendingDecision?.packetRef
            || current.pendingDecision?.packetDigest !== state.pendingDecision?.packetDigest
          ) {
            const error = new Error("the DecisionPacket changed before the replan was committed")
            error.code = "ACTION_STALE"
            throw error
          }
          return {
            fact: {
              type: "steering.replan-requested",
              nextStageRunId: compiled.nextStageRunId,
              sourceDecisionId: compiled.sourceDecisionId,
              sourcePacketRef: compiled.sourcePacketRef,
              sourcePacketDigest: compiled.sourcePacketDigest,
              reason: compiled.reason,
              occurredAt: clock(),
            },
            refs: [compiled.sourceDecisionId, compiled.sourcePacketRef],
          }
        })
        return { state: replanned.state, reason: "needs-plan" }
      }
      if (compiled.kind === "escalate") {
        const escalated = await reconciler.commit(taskId, (current) => {
          if (
            current.revision !== state.revision
            || current.pendingDecision?.packetRef !== state.pendingDecision?.packetRef
            || current.pendingDecision?.packetDigest !== state.pendingDecision?.packetDigest
          ) {
            const error = new Error("the DecisionPacket changed before the escalation was committed")
            error.code = "ACTION_STALE"
            throw error
          }
          return {
            fact: {
              type: "steering.user-escalated",
              sourceDecisionId: compiled.sourceDecisionId,
              sourcePacketRef: compiled.sourcePacketRef,
              sourcePacketDigest: compiled.sourcePacketDigest,
              question: compiled.question,
              reason: compiled.reason,
              occurredAt: clock(),
            },
            refs: [compiled.sourceDecisionId, compiled.sourcePacketRef],
          }
        })
        return { state: escalated.state, reason: "awaiting-user" }
      }
      const opened = await reconciler.commit(taskId, (current) => {
        if (
          current.revision !== state.revision
          || current.pendingDecision?.packetRef !== state.pendingDecision?.packetRef
          || current.pendingDecision?.packetDigest !== state.pendingDecision?.packetDigest
        ) {
          const error = new Error("the DecisionPacket changed before the intervention was committed")
          error.code = "ACTION_STALE"
          throw error
        }
        return {
          fact: {
            type: "steering.intervention-opened",
            nextStageRunId: compiled.nextStageRunId,
            plan: compiled.plan,
            costLedger: compiled.costLedger,
            reason: input.directive,
            occurredAt: clock(),
          },
          refs: [state.pendingDecision.packetRef, input.action, input.targetRef],
        }
      })
      return runToStable({ taskId: opened.state.taskId, leadBindingRef })
    }
    if (input.action !== "choose" || state.status !== "awaiting-user" || !state.pendingDecision?.choices.includes(input.directive)) {
      const error = new Error("the current stable point does not accept this choice")
      error.code = "ACTION_STALE"
      throw error
    }
    const resolution = await effectDriver.resolveHumanDecision({ taskId })
    if (resolution.accepted !== true) {
      const error = new Error("the human decision was invalidated before it could be applied")
      error.code = "ACTION_STALE"
      throw error
    }
    state = resolution.state
    const resolvedDecision = state.decisionHistory.at(-1)
    const choice = resolvedDecision?.choice
    if (choice !== input.directive) {
      const error = new Error("the platform-verified human choice does not match the steering intent")
      error.code = "ACTION_STALE"
      throw error
    }
    if (choice === "accept") {
      if (resolvedDecision.decisionId.startsWith("budget-")) {
        const assignment = nextBudgetBlockedAssignment(state)
        if (!assignment) {
          const error = new Error("the approved cost boundary is no longer current")
          error.code = "ACTION_STALE"
          throw error
        }
        const approvedLimit = state.costLedger.accrued + state.costLedger.uncertain + costWeightForTier(assignment.costTier)
        state = (await reconciler.commit(taskId, () => ({
          fact: {
            type: "cost-budget.approved",
            assignmentId: assignment.assignmentId,
            approvedLimit,
            decisionId: resolvedDecision.decisionId,
            occurredAt: clock(),
          },
          refs: [resolvedDecision.decisionId, assignment.assignmentId],
        }))).state
      }
      return runToStable({ taskId, leadBindingRef })
    }
    if (resolvedDecision.decisionId.startsWith("budget-") && choice === "stop") {
      const cancelled = await reconciler.commit(taskId, () => ({
        fact: { type: "task.cancelled", reason: input.note || "人工决定停止超预算任务", occurredAt: clock() },
        refs: [resolvedDecision.decisionId],
      }))
      return { state: cancelled.state, reason: "cancelled" }
    }
    if (resolvedDecision.decisionId.startsWith("budget-")) {
      const replanned = await reconciler.commit(taskId, (snapshot) => ({
        fact: {
          type: "stage.replanned",
          nextStageRunId: `stage-run-${snapshot.currentStageRun.sequence + 1}`,
          reason: input.note || "人工拒绝追加预算，等待调整范围或预算",
          occurredAt: clock(),
        },
        refs: [resolvedDecision.decisionId],
      }))
      return { state: replanned.state, reason: "needs-plan" }
    }
    if (resolvedDecision.decisionId.startsWith("convergence-") && choice === "rework") {
      const reopened = await reconciler.commit(taskId, (snapshot) => ({
        fact: {
          type: "stage.reopened",
          nextStageRunId: `stage-run-${snapshot.currentStageRun.sequence + 1}`,
          reason: input.note || "人工授权一轮有目标的追加返工",
          occurredAt: clock(),
        },
        refs: [resolvedDecision.decisionId],
      }))
      const installed = await planCurrentStage(reopened.state)
      return installed.reason === "planned" ? runToStable({ taskId, leadBindingRef }) : installed
    }
    const outcome = choice.startsWith("return-") ? choice : "rework"
    const installed = await returnForOutcome(state, outcome, input.note || "人工审核要求返工")
    return installed.reason === "planned" ? runToStable({ taskId, leadBindingRef }) : installed
  }

  return Object.freeze({ ensureTask, plan, runToStable, steer })
}
