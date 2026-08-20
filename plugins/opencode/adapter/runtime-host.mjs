import path from "node:path"

import { createRuntimeFacade } from "../../../runtime/application/runtime-facade.mjs"
import { createFileContextComposer } from "../../../runtime/application/context-composer.mjs"
import { createSignalHub } from "../../../runtime/application/signal-hub.mjs"
import { createFileArtifactRepository, createFileStore, initializeProjectRuntime } from "../../../runtime/persistence/index.mjs"

function taskSelectionProblem() {
  return {
    code: "TASK_SELECTION_REQUIRED",
    message: "当前会话还没有活动任务。",
    impact: "任务状态未改变；请先打开或创建任务。",
    next: { kind: "none", reason: "需要先调用 workflow_open" },
  }
}

function taskNotFoundProblem(taskId) {
  return {
    code: "TASK_NOT_FOUND",
    message: `任务 ${taskId} 不存在。只有 task_id 表示恢复已有任务。`,
    impact: "任务状态未改变。",
    next: { kind: "none", reason: "如需创建新任务，请使用 mode=create 并提供 title 与 objective。" },
  }
}

function requireSession(value) {
  if (typeof value !== "string" || value === "") throw new TypeError("OpenCode session id is required")
  return value
}

function normalizeProjectPath(projectRoot, value, code) {
  const root = path.resolve(projectRoot)
  if (!path.isAbsolute(value ?? "")) return value
  const relative = path.relative(root, path.resolve(value))
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw Object.assign(new Error(`制品不在当前项目内：${value}`), { code })
  }
  return relative.split(path.sep).join("/")
}

function normalizeOpenInput(projectRoot, input) {
  if (!Array.isArray(input?.existingArtifacts)) return input
  return {
    ...input,
    existingArtifacts: input.existingArtifacts.map((artifact) => {
      const value = artifact?.locator?.value
      if (artifact?.locator?.type !== "project-path" || !path.isAbsolute(value ?? "")) return artifact
      return { ...artifact, locator: { ...artifact.locator, value: normalizeProjectPath(projectRoot, value, "OPEN_ARTIFACT_PATH_ESCAPE") } }
    }),
  }
}

function normalizeReference(ref, acceptedReportIds, knownArtifactIds) {
  if (acceptedReportIds.has(ref)) return `report:${ref}`
  if (knownArtifactIds.has(ref)) return `artifact:${ref}`
  return ref
}

export function normalizeOpenCodeMemberReport(projectRoot, report, {
  role,
  allowArtifacts = role === "owner",
  acceptedReportRefs = [],
  knownArtifactRefs = [],
} = {}) {
  if (!Array.isArray(report?.artifacts)) return report
  const acceptedReportIds = new Set(acceptedReportRefs.map((entry) => entry.reportId ?? entry))
  const knownArtifactIds = new Set(knownArtifactRefs
    .filter((ref) => typeof ref === "string" && ref.startsWith("artifact:"))
    .map((ref) => ref.slice("artifact:".length)))
  const normalizeRefs = (refs = []) => refs.map((ref) => normalizeReference(ref, acceptedReportIds, knownArtifactIds))
  const findingEvidenceRefs = (report.findings ?? []).flatMap((finding) => normalizeRefs(finding.evidenceRefs))
  const verdictEvidenceRefs = normalizeRefs(report.verdict?.evidenceRefs)
  const directEvidenceRefs = normalizeRefs(report.evidenceRefs)
  const evidenceRefs = directEvidenceRefs.length > 0
    ? directEvidenceRefs
    : [...new Set([...verdictEvidenceRefs, ...findingEvidenceRefs])]
  const stableEvidence = new Set([
    ...evidenceRefs,
    ...report.artifacts.map(({ ref }) => normalizeReference(ref, acceptedReportIds, knownArtifactIds)),
  ])
  const normalized = {
    ...report,
    evidenceRefs,
    artifacts: allowArtifacts ? report.artifacts.map((artifact) => ({
      ...artifact,
      ref: normalizeReference(artifact.ref, acceptedReportIds, knownArtifactIds),
      path: normalizeProjectPath(projectRoot, artifact.path, "REPORT_ARTIFACT_PATH_ESCAPE"),
    })) : [],
    ...(Array.isArray(report.checks) ? {
      checks: report.checks.map((check) => {
        const evidenceRef = check.evidenceRef && normalizeReference(check.evidenceRef, acceptedReportIds, knownArtifactIds)
        return evidenceRef && stableEvidence.has(evidenceRef)
          ? { ...check, evidenceRef }
          : Object.fromEntries(Object.entries(check).filter(([key]) => key !== "evidenceRef"))
      }),
    } : {}),
    ...(Array.isArray(report.findings) ? {
      findings: report.findings.map((finding) => ({
        ...finding,
        evidenceRefs: normalizeRefs(finding.evidenceRefs),
      })),
    } : {}),
    ...(report.verdict ? {
      verdict: {
        ...report.verdict,
        evidenceRefs: verdictEvidenceRefs.length > 0 ? verdictEvidenceRefs : evidenceRefs,
      },
    } : {}),
  }
  if (role !== "expert") delete normalized.verdict
  return normalized
}

export function normalizeOpenCodeSteerInput(state, input) {
  if (input?.action !== "choose" || typeof input.directive !== "string") return input
  return { ...input, directive: input.directive.trim() }
}

export function createOpenCodeRuntimeHost({
  projectRoot,
  executionAdapter,
  specProviderAdapter,
  workflowDefinition,
  teamPolicy,
  routeConfig = {},
  roleGuides = {},
  runWaitBudgetMs = 30_000,
  clock = () => new Date().toISOString(),
} = {}) {
  if (typeof projectRoot !== "string" || projectRoot === "") throw new TypeError("projectRoot is required")
  if (!executionAdapter || typeof executionAdapter.resolveLeadBindingForSession !== "function") {
    throw new TypeError("OpenCode Runtime host requires a binding-aware Execution Adapter")
  }
  if (!Number.isInteger(runWaitBudgetMs) || runWaitBudgetMs < 0) throw new TypeError("runWaitBudgetMs must be a non-negative integer")
  const store = createFileStore({ projectRoot })
  const artifactRepository = createFileArtifactRepository({ projectRoot })
  const signalHub = createSignalHub()
  const executionPreparer = createFileContextComposer({ projectRoot, store, roleGuides })
  const sessions = new Map()
  let initialization

  async function ready() {
    if (!initialization) {
      initialization = initializeProjectRuntime({ projectRoot }).catch((error) => {
        initialization = undefined
        throw error
      })
    }
    return initialization
  }

  function facade(hostSessionRef) {
    return createRuntimeFacade({
      store,
      executionAdapter,
      specProviderAdapter,
      artifactRepository,
      workflowDefinition,
      teamPolicy,
      routeConfig,
      platform: "opencode",
      hostSessionRef,
      signalHub,
      executionPreparer,
      clock,
    })
  }

  async function restore(hostSessionRef) {
    const sessionId = requireSession(hostSessionRef)
    const active = sessions.get(sessionId)
    const binding = await executionAdapter.resolveLeadBindingForSession(sessionId)
    if (!binding) {
      sessions.delete(sessionId)
      return null
    }
    if (active?.taskId === binding.taskId) return { ...active, restored: false }
    sessions.delete(sessionId)
    const runtime = facade(sessionId)
    const card = await runtime.leadControl.open({ taskId: binding.taskId })
    const selected = { runtime, taskId: card.task?.id ?? binding.taskId }
    sessions.set(sessionId, selected)
    return { ...selected, card, restored: true }
  }

  async function reconcilePlatform(taskId) {
    if (typeof executionAdapter.reconcileTaskExecutions !== "function") return
    await executionAdapter.reconcileTaskExecutions(taskId)
  }

  return Object.freeze({
    async open(hostSessionRef, input) {
      await ready()
      const sessionId = requireSession(hostSessionRef)
      const normalizedInput = normalizeOpenInput(projectRoot, input)
      const current = sessions.get(sessionId)
      let runtime = normalizedInput?.taskId && current?.taskId === normalizedInput.taskId ? current.runtime : facade(sessionId)
      let card
      try {
        card = await runtime.leadControl.open(normalizedInput?.taskId ? { taskId: normalizedInput.taskId } : normalizedInput)
      } catch (error) {
        if (normalizedInput?.taskId && error?.code === "TASK_NOT_FOUND") {
          return taskNotFoundProblem(normalizedInput.taskId)
        } else {
          throw error
        }
      }
      if (card.task?.id) sessions.set(sessionId, { runtime, taskId: card.task.id })
      if (!card.task?.id) return card
      await reconcilePlatform(card.task.id)
      return runtime.hostControl.run({ waitBudgetMs: 0 })
    },

    async plan(hostSessionRef, input) {
      const selected = await restore(hostSessionRef)
      return selected ? selected.runtime.leadControl.plan(input) : taskSelectionProblem()
    },

    async run(hostSessionRef, { signal } = {}) {
      const selected = await restore(hostSessionRef)
      if (!selected) return taskSelectionProblem()
      await reconcilePlatform(selected.taskId)
      return selected.runtime.hostControl.run({ waitBudgetMs: runWaitBudgetMs, ...(signal ? { signal } : {}) })
    },

    async steer(hostSessionRef, input) {
      const selected = await restore(hostSessionRef)
      if (!selected) return taskSelectionProblem()
      const state = await store.loadTask(selected.taskId)
      return selected.runtime.leadControl.steer(normalizeOpenCodeSteerInput(state, input))
    },

    async report(memberSessionRef, report) {
      const sessionId = requireSession(memberSessionRef)
      if (typeof executionAdapter.resolveMemberBinding !== "function") {
        throw new TypeError("OpenCode Execution Adapter cannot resolve member bindings")
      }
      const binding = await executionAdapter.resolveMemberBinding(sessionId)
      if (!binding) {
        const error = new Error("当前会话不是受管团队成员。")
        error.code = "MEMBER_BINDING_REQUIRED"
        throw error
      }
      const state = await store.loadTask(binding.taskId)
      const assignment = state.workGraph.assignments.find(({ assignmentId }) => assignmentId === binding.assignmentId)
      if (!assignment) {
        const error = new Error("当前成员派单不存在。")
        error.code = "MEMBER_ASSIGNMENT_REQUIRED"
        throw error
      }
      const runtime = sessions.get(binding.hostSessionRef)?.runtime ?? facade(binding.hostSessionRef)
      return runtime.memberDeliveryFor({
        taskId: binding.taskId,
        assignmentId: binding.assignmentId,
        attemptId: binding.attemptId,
        executionRef: binding.executionRef,
        operationKey: binding.operationKey,
      }).report(normalizeOpenCodeMemberReport(projectRoot, report, {
        role: assignment.teamRole,
        allowArtifacts: assignment.teamRole === "owner" && assignment.writableRefs.length > 0,
        acceptedReportRefs: state.acceptedReportRefs,
        knownArtifactRefs: [...assignment.readableRefs, ...assignment.writableRefs],
      }))
    },

    async describeSession(sessionRef) {
      const sessionId = requireSession(sessionRef)
      if (typeof executionAdapter.resolveHelperBinding === "function") {
        const helper = await executionAdapter.resolveHelperBinding(sessionId)
        if (helper) return { kind: "helper", ...helper }
      }
      if (typeof executionAdapter.resolveMemberBinding === "function") {
        const member = await executionAdapter.resolveMemberBinding(sessionId)
        if (member) {
          const state = await store.loadTask(member.taskId)
          const assignment = state.workGraph.assignments.find(({ assignmentId }) => assignmentId === member.assignmentId)
          if (!assignment) return null
          const artifactById = new Map(state.artifacts.map((artifact) => [`artifact:${artifact.artifactId}`, artifact.path]))
          return {
            kind: "member",
            taskId: member.taskId,
            assignmentId: member.assignmentId,
            role: assignment.teamRole,
            stage: state.currentStageRun.stage,
            contextRef: assignment.execution.contextRef,
            promptRef: assignment.execution.promptRef,
            writablePaths: assignment.writableRefs
              .filter((ref) => artifactById.has(ref))
              .map((ref) => artifactById.get(ref)),
          }
        }
      }
      const lead = await executionAdapter.resolveLeadBindingForSession(sessionId)
      if (!lead) return null
      const state = await store.loadTask(lead.taskId)
      return {
        kind: "lead",
        taskId: state.taskId,
        title: state.title,
        stage: state.currentStageRun.stage,
        status: state.status,
        taskRoot: `.team-work/tasks/${state.taskId}`,
      }
    },
  })
}
