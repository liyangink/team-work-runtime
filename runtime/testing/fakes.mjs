import { digestValue } from "../domain/digests.mjs"

function timestamp(clock) {
  return clock()
}

export function createInMemoryArtifactRepository(seed = {}) {
  const files = new Map(Object.entries(seed))
  const authoredBy = new Map()
  return Object.freeze({
    write(path, content, { assignmentId } = {}) {
      if (typeof path !== "string" || path === "" || typeof content !== "string") throw new TypeError("artifact path and string content are required")
      files.set(path, content)
      if (assignmentId) authoredBy.set(path, new Set([...(authoredBy.get(path) ?? []), assignmentId]))
    },
    async verifyDeclaredOutputs({ assignmentId, outputs }) {
      const mismatches = outputs.flatMap(({ path }) => authoredBy.get(path)?.has(assignmentId)
        ? []
        : [{ path, reason: "not-authored-by-assignment" }])
      return { valid: mismatches.length === 0, mismatches }
    },
    async snapshot(paths) {
      return paths.map((path) => {
        if (!files.has(path)) {
          const error = new Error(`artifact does not exist: ${path}`)
          error.code = "ARTIFACT_MISSING"
          throw error
        }
        const content = files.get(path)
        return { path, content, digest: digestValue(content) }
      })
    },
    async read(path) {
      if (!files.has(path)) {
        const error = new Error(`artifact does not exist: ${path}`)
        error.code = "ARTIFACT_MISSING"
        throw error
      }
      return files.get(path)
    },
  })
}

export function createFakeExecutionAdapter({ agents, clock = () => new Date().toISOString(), humanDecisionProof = "trusted-caller" } = {}) {
  const catalog = agents ?? [
    { agentId: "junior-luna", tier: "junior", model: "luna", costWeight: 1, capabilities: ["*"] },
    { agentId: "senior-terra", tier: "senior", model: "terra", costWeight: 10, capabilities: ["*"] },
    { agentId: "expert-opus", tier: "expert", model: "opus", costWeight: 50, capabilities: ["*"] },
  ]
  const executions = new Map()
  const effects = new Map()
  const bindings = new Map()
  let memberDeliveryFor
  let observationSinkFor
  let nextHumanChoice

  const adapter = {
    attachRuntime(bindingsFactory) {
      memberDeliveryFor = bindingsFactory.memberDeliveryFor
      observationSinkFor = bindingsFactory.observationSinkFor
    },
    setHumanChoice(choice, note) {
      nextHumanChoice = { choice, note }
    },
    activeMembers() {
      return [...executions.values()].map((binding) => Object.freeze({
        taskId: binding.taskId,
        executionRef: binding.executionRef,
        stageRunId: binding.stageRunId,
        assignmentId: binding.assignmentId,
        attemptId: binding.attemptId,
        role: binding.role,
        assignmentKind: binding.assignmentKind,
        report: async (report, operationKey = `fake-report-${binding.assignmentId}-${binding.attempt}`) => {
          if (!memberDeliveryFor) throw new Error("fake execution adapter is not attached to Runtime")
          return memberDeliveryFor({ ...binding, operationKey }).report(report)
        },
        observe: async (observation) => {
          if (!observationSinkFor) throw new Error("fake execution adapter is not attached to Runtime")
          return observationSinkFor(binding.taskId).observe({
            ...observation,
            executionRef: binding.executionRef,
            assignmentId: binding.assignmentId,
          })
        },
      }))
    },
    async capabilities() {
      return {
        snapshotId: "fake-capabilities",
        digest: digestValue(catalog),
        capturedAt: timestamp(clock),
        agents: structuredClone(catalog),
        limits: { maxParallel: 8 },
        features: {
          background: true,
          resume: true,
          humanDecisionProof,
          readOnlyHelper: true,
          checkReceipts: true,
        },
      }
    },
    async bindLead(input) {
      const receipt = { bindingRef: `lead-${input.taskId}`, ...structuredClone(input) }
      bindings.set(input.taskId, receipt)
      return receipt
    },
    async ensureExecution(effect) {
      const known = effects.get(effect.operationId)
      if (known && known.effectDigest !== effect.effectDigest) throw new Error("fake operation digest conflict")
      if (known) return structuredClone(known)
      const executionRef = effect.resumeExecutionRef ?? `fake-session-${effect.assignmentId}`
      const receipt = {
        operationId: effect.operationId,
        effectDigest: effect.effectDigest,
        status: "confirmed",
        executionRef,
        agentId: effect.agentId,
        observedAt: timestamp(clock),
      }
      effects.set(effect.operationId, receipt)
      executions.set(executionRef, {
        taskId: effect.taskId,
        stageRunId: effect.stageRunId,
        assignmentId: effect.assignmentId,
        attemptId: `${effect.assignmentId}-attempt-${effect.attempt}`,
        attempt: effect.attempt,
        executionRef,
        role: effect.role,
        assignmentKind: effect.assignmentKind,
      })
      return structuredClone(receipt)
    },
    async inspectExecution(effect) {
      return structuredClone(effects.get(effect.operationId) ?? {
        operationId: effect.operationId,
        effectDigest: effect.effectDigest,
        status: "in-doubt",
        agentId: effect.agentId,
        observedAt: timestamp(clock),
      })
    },
    async quiesce(intent) {
      return {
        operationId: intent.operationId,
        effectDigest: intent.effectDigest,
        status: "confirmed",
        executions: intent.executionRefs.map((executionRef) => ({ executionRef, state: "isolated" })),
        hostContinuationsCleared: true,
        hostCursor: `cursor-${intent.decisionId}`,
        observedAt: timestamp(clock),
      }
    },
    async inspectQuiesce(intent) {
      return adapter.quiesce(intent)
    },
    async verifyHumanDecision(intent) {
      if (!nextHumanChoice || !intent.choices.includes(nextHumanChoice.choice)) {
        const error = new Error("no matching fake human decision is queued")
        error.code = "HUMAN_DECISION_MISSING"
        throw error
      }
      const selected = nextHumanChoice
      nextHumanChoice = undefined
      return {
        decisionId: intent.decisionId,
        leadBindingRef: intent.leadBindingRef,
        receivedAt: timestamp(clock),
        choice: selected.choice,
        ...(selected.note ? { note: selected.note } : {}),
        proof: humanDecisionProof === "verified-event"
          ? { mode: "verified-event", messageId: `message-${intent.decisionId}`, messageCursor: `cursor-z-${intent.decisionId}` }
          : { mode: "trusted-caller", invocationRef: `human-${intent.decisionId}` },
      }
    },
    async stopExecution(intent) {
      return { operationId: intent.operationId, effectDigest: intent.effectDigest, status: "confirmed", executionRef: intent.executionRef, observedAt: timestamp(clock) }
    },
    async inspectStop(intent) {
      return adapter.stopExecution(intent)
    },
  }
  return adapter
}

export function createFakeSpecProvider({ status = "missing", clock = () => new Date().toISOString() } = {}) {
  const operations = new Map()
  return Object.freeze({
    async probe() {
      return { providerId: "fake-spec", status, ...(status === "ready" ? { version: "1.0" } : {}), observedAt: timestamp(clock) }
    },
    async prepare(intent) {
      const capability = {
        operationId: intent.operationId,
        effectDigest: intent.effectDigest,
        capabilityId: `capability-${intent.artifact}`,
        capabilityDigest: digestValue(intent),
        task: intent.task,
        instructionsRef: `.team-work/spec/${intent.artifact}.md`,
        readableRefs: [],
        writableRefs: [`.team-work/spec/${intent.artifact}.md`],
        status: "ready",
      }
      operations.set(intent.operationId, capability)
      return capability
    },
    async status(task) {
      return { task, providerRevision: "fake-1", state: "complete", readyArtifacts: ["proposal", "design", "specs", "tasks"], artifactRefs: [], blockers: [] }
    },
    async validate(task) {
      return { task, providerRevision: "fake-1", valid: true, complete: true, evidenceRefs: ["fake-spec-validation"], blockers: [] }
    },
    async archive(intent) {
      const receipt = { operationId: intent.operationId, effectDigest: intent.effectDigest, task: intent.task, status: "confirmed", archiveRefs: [], observedAt: timestamp(clock) }
      operations.set(intent.operationId, receipt)
      return receipt
    },
    async inspect(intent) {
      const result = operations.get(intent.operationId)
      return { operationId: intent.operationId, effectDigest: intent.effectDigest, kind: intent.kind, status: result ? "confirmed" : "missing", ...(result ? { result } : {}), observedAt: timestamp(clock) }
    },
  })
}
