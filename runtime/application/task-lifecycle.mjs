import { digestValue } from "../domain/digests.mjs"
import { createTaskAggregate } from "../domain/task-aggregate.mjs"
import { compilePolicyPlan } from "./policy-compiler.mjs"

function slug(value) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70)
  return normalized || "task"
}

function artifactIdentity(ref) {
  const raw = ref.replace(/^artifact:/, "")
  const kind = raw.split(":")[0]
  const base = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "")
  return {
    artifactId: base.length <= 100 ? base : `${base.slice(0, 70)}-${digestValue(raw).slice(0, 20)}`,
    kind,
  }
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

function reportReferenceExists(state, ref, transientArtifactIds = new Set()) {
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
    return state.evidence.some(({ sourceRef, kind, valid }) => sourceRef === ref && kind === "platform-check" && valid)
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
    return [
      ...state.artifacts.map(({ artifactId, kind, digest }) => ({ kind, ref: `artifact:${artifactId}`, digest })),
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
    return {
      task: state,
      taskIntent: state.taskIntent,
      availableArtifacts: await availableArtifacts(state),
      workflowDefinition,
      teamPolicy,
      agentCatalog: normalizedCatalog(),
      routeInputs: routeInputsFor(specProbe, e2eAssessment),
      ...(proposal ? { proposal } : {}),
    }
  }

  async function installCompiled(state, compiled) {
    if (["route-skip", "route-blocked"].includes(compiled.kind)) {
      const routeKind = workflowDefinition.stages.find(({ id }) => id === state.currentStageRun.stage)?.route
      const route = compiled.routes[routeKind]
      const decision = route?.decision
      const routeDigest = route?.digest ?? digestValue(route)
      const decisionId = `route-${digestValue({ stageRunId: state.currentStageRun.stageRunId, routeKind, routeDigest }).slice(0, 20)}`
      if (!state.routeDecisions.some((entry) => entry.decisionId === decisionId)) {
        const recorded = await reconciler.commit(state.taskId, () => ({
          fact: {
            type: "route.decision-recorded",
            decision: {
              decisionId,
              stageRunId: state.currentStageRun.stageRunId,
              stage: state.currentStageRun.stage,
              routeKind,
              outcome: compiled.kind === "route-blocked" ? "blocked" : "skipped",
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
              recovery: compiled.kind === "route-blocked" ? "replan-after-capability-change" : "follow-skip-edge",
              recordedAt: clock(),
            },
            occurredAt: clock(),
          },
          refs: [routeDigest],
        }))
        state = recorded.state
      }
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
    if (["route-blocked", "budget-decision"].includes(compiled.kind)) {
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
      const unknown = evidenceRefs.find((ref) => !reportReferenceExists(state, ref, artifactIds))
      if (unknown) throw invalidReport(`report references unknown or stale evidence: ${unknown}`)
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
      return { assignment, report: record.report, reportId: attempt.reportRef }
    }))
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
    provisional.workGraph = { assignments: [] }
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
    await effectDriver.prepareHumanDecision({
      taskId: state.taskId,
      decision: {
        decisionId: `${gate.gateId}-${state.currentStageRun.stageRunId}`,
        requirement: gate.requirement,
        proofMode: gate.proofMode,
        leadBindingRef,
        question: gate.gateId === "design-approval" ? "方案是否已经与预期一致，可以进入后续实施？" : "当前成果是否符合预期，可以完成本任务吗？",
        artifactRefs,
        choices: ["accept", "rework"],
      },
    })
    return (await effectDriver.run({ taskId: state.taskId, waitBudgetMs: 0 })).state
  }

  async function prepareConvergenceDecision(state, leadBindingRef) {
    capabilities ??= await executionAdapter.capabilities()
    const artifactRefs = [...new Set(state.artifacts.map(({ artifactId }) => artifactId))]
    if (artifactRefs.length === 0) return { state, reason: "round-limit" }
    await effectDriver.prepareHumanDecision({
      taskId: state.taskId,
      decision: {
        decisionId: `convergence-${state.currentStageRun.stageRunId}`,
        requirement: "required",
        proofMode: capabilities.features.humanDecisionProof,
        leadBindingRef,
        question: "团队已达到自主收敛上限；是否结合你的意见再开启一轮返工？",
        artifactRefs,
        choices: ["rework"],
      },
    })
    return { state: (await effectDriver.run({ taskId: state.taskId, waitBudgetMs: 0 })).state, reason: "awaiting-user" }
  }

  async function finalizeAcceptedGraph(state, leadBindingRef) {
    if (state.preflight?.status === "active") return finishPreflight(state)
    const ready = await ensureReady(state)
    if (!await reportsAgree(ready)) return reopenForRework(ready, "团队审查要求返工")

    const gate = gateFor(ready)
    const gateDecisionId = gate && `${gate.gateId}-${ready.currentStageRun.stageRunId}`
    const gateAccepted = gateDecisionId && ready.decisionHistory.some(({ decisionId, choice }) => decisionId === gateDecisionId && choice === "accept")
    if (gate && gate.action !== "skip" && !gateAccepted) {
      return { state: await prepareGate(ready, gate, leadBindingRef), reason: "awaiting-user" }
    }
    if (ready.scope.completionStages.includes(ready.currentStageRun.stage)) {
      const completed = await reconciler.commit(ready.taskId, () => ({ fact: { type: "task.completed", occurredAt: clock() } }))
      return { state: completed.state, reason: "completed" }
    }
    const edge = selectEdge(ready)
    if (!edge) return { state: ready, reason: "route-blocked" }
    const advanced = await reconciler.commit(ready.taskId, (snapshot) => ({
      fact: { type: "stage.advanced", to: edge.to, nextStageRunId: `stage-run-${snapshot.currentStageRun.sequence + 1}`, occurredAt: clock() },
    }))
    return planCurrentStage(advanced.state)
  }

  async function runToStable({ taskId, leadBindingRef }) {
    for (let step = 0; step < 64; step += 1) {
      const outcome = await effectDriver.run({ taskId, waitBudgetMs: 0 })
      const state = outcome.state
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
      const error = new Error("task intent changes require a controlled replan")
      error.code = "TASK_INTENT_CONFLICT"
      throw error
    }
    if (!state.stagePlan && !state.preflight) {
      const installed = await planCurrentStage(state)
      if (installed.reason !== "planned") return installed
    }
    return runToStable({ taskId, leadBindingRef })
  }

  async function steer({ taskId, input, leadBindingRef }) {
    let state = await reconciler.load(taskId)
    if (input.action !== "choose" || state.status !== "awaiting-user" || !state.pendingDecision?.choices.includes(input.directive)) {
      const error = new Error("the current stable point does not accept this choice")
      error.code = "ACTION_STALE"
      throw error
    }
    state = (await effectDriver.resolveHumanDecision({ taskId })).state
    const choice = state.decisionHistory.at(-1)?.choice
    if (choice !== input.directive) {
      const error = new Error("the platform-verified human choice does not match the steering intent")
      error.code = "ACTION_STALE"
      throw error
    }
    if (choice === "accept") return runToStable({ taskId, leadBindingRef })
    const reopened = await reconciler.commit(taskId, (snapshot) => ({
      fact: {
        type: "stage.reopened",
        nextStageRunId: `stage-run-${snapshot.currentStageRun.sequence + 1}`,
        reason: input.note || "人工审核要求返工",
        occurredAt: clock(),
      },
    }))
    const installed = await planCurrentStage(reopened.state)
    return installed.reason === "planned" ? runToStable({ taskId, leadBindingRef }) : installed
  }

  return Object.freeze({ ensureTask, plan, runToStable, steer })
}
