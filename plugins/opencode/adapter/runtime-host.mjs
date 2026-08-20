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

function requireSession(value) {
  if (typeof value !== "string" || value === "") throw new TypeError("OpenCode session id is required")
  return value
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
      const current = sessions.get(sessionId)
      const runtime = input?.taskId && current?.taskId === input.taskId ? current.runtime : facade(sessionId)
      const card = await runtime.leadControl.open(input)
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
      return selected ? selected.runtime.leadControl.steer(input) : taskSelectionProblem()
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
      const runtime = sessions.get(binding.hostSessionRef)?.runtime ?? facade(binding.hostSessionRef)
      return runtime.memberDeliveryFor({
        taskId: binding.taskId,
        assignmentId: binding.assignmentId,
        attemptId: binding.attemptId,
        executionRef: binding.executionRef,
        operationKey: binding.operationKey,
      }).report(report)
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
          return {
            kind: "member",
            taskId: member.taskId,
            assignmentId: member.assignmentId,
            role: assignment.teamRole,
            stage: state.currentStageRun.stage,
            contextRef: assignment.execution.contextRef,
            promptRef: assignment.execution.promptRef,
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
