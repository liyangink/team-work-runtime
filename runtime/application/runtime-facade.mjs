import { createLeadControl } from "../lead-control.mjs"
import { createMemberDelivery } from "../member-delivery.mjs"
import { createPlatformObservationSink } from "../platform-observation.mjs"
import { createExecutionAdapterPort } from "../ports/execution.mjs"
import { createSpecProviderAdapterPort } from "../ports/spec-provider.mjs"
import { createTaskDriver } from "./driver.mjs"
import { createTaskReconciler } from "./reconciler.mjs"
import { composeActionCard } from "./action-card.mjs"
import { validateWorkflowDefinition } from "../../workflow/compiler.mjs"

function problem(code, message, impact, retry = false) {
  return { code, message, impact, next: retry ? { kind: "run", when: "问题修复后继续" } : { kind: "none", reason: "需要先处理上述问题" } }
}

function compactCard(state, workflowDefinition, reason) {
  const normalizedReason = state.status === "completed" ? "completed"
    : state.status === "cancelled" ? "cancelled"
      : state.status === "awaiting-user" ? "awaiting-user"
        : state.status === "blocked" ? "blocked"
          : (!state.stagePlan && !state.preflight) ? "needs-plan"
            : ["waiting-report", "settling-idle", "wait-budget-exhausted", "budget-decision", "in-doubt"].includes(reason) ? reason
              : "stable"
  return composeActionCard({ taskState: state, workflowDefinition, reason: normalizedReason })
}

function normalizeIntent(input) {
  return {
    objective: input.objective,
    constraints: input.constraints ?? [],
    exclusions: input.exclusions ?? [],
    preferences: {
      execution: input.preferences?.execution ?? "auto",
      budget: input.preferences?.budget ?? "balanced",
      risk: input.preferences?.risk ?? "normal",
    },
  }
}

export function createRuntimeFacade({
  store,
  executionAdapter: rawExecutionAdapter,
  specProviderAdapter: rawSpecProviderAdapter,
  artifactRepository,
  workflowDefinition,
  teamPolicy,
  routeConfig = {},
  platform = "in-memory",
  hostSessionRef = "lead-session",
  clock = () => new Date().toISOString(),
}) {
  if (
    !store
    || !artifactRepository
    || typeof artifactRepository.snapshot !== "function"
    || typeof artifactRepository.read !== "function"
    || typeof artifactRepository.verifyDeclaredOutputs !== "function"
    || !workflowDefinition
    || !teamPolicy
  ) throw new TypeError("Runtime facade dependencies are required")
  const executionAdapter = createExecutionAdapterPort(rawExecutionAdapter)
  const specProviderAdapter = rawSpecProviderAdapter ? createSpecProviderAdapterPort(rawSpecProviderAdapter) : null
  const workflow = validateWorkflowDefinition(workflowDefinition)
  const reconciler = createTaskReconciler({ store, clock })
  const evidenceVerifier = {
    async verify(snapshots) {
      const current = await artifactRepository.snapshot(snapshots.map(({ path }) => path))
      const mismatches = snapshots.flatMap((snapshot, index) => snapshot.digest === current[index].digest
        ? []
        : [{ artifactId: snapshot.artifactId, path: snapshot.path, reason: "digest-mismatch" }])
      return { valid: mismatches.length === 0, mismatches }
    },
  }
  const driver = createTaskDriver({
    store,
    executionAdapter,
    specProviderAdapter,
    artifactRepository,
    workflowDefinition,
    workflowPin: workflow.pin,
    teamPolicy,
    routeConfig,
    clock,
    evidenceVerifier,
  })
  let activeTaskId
  let leadBinding

  async function current() {
    if (!activeTaskId) throw Object.assign(new Error("no active task"), { code: "TASK_SELECTION_REQUIRED" })
    return reconciler.load(activeTaskId)
  }

  const leadControl = createLeadControl({
    async open(input) {
      const opened = await driver.ensureTask(input)
      activeTaskId = opened.taskId
      leadBinding = await executionAdapter.bindLead({ taskId: activeTaskId, platform, hostSessionRef })
      const recovered = await driver.runToStable({ taskId: activeTaskId, leadBindingRef: leadBinding.bindingRef })
      return compactCard(recovered.state, workflowDefinition, recovered.reason)
    },

    async plan(input) {
      try {
        const result = await driver.plan({ taskId: activeTaskId, intent: normalizeIntent(input), leadBindingRef: leadBinding.bindingRef })
        if (result.reason === "route-blocked") return problem("ROUTE_BLOCKED", "当前项目能力或环境不满足必需流程。", "任务意图已保存；修复配置或环境后重新规划即可恢复。")
        if (result.reason === "route-skip") return problem("ROUTE_SKIPPED", "当前局部任务对应的可选流程已被项目配置关闭。", "请调整任务范围或启用对应能力。")
        if (result.reason === "budget-decision") return problem("BUDGET_DECISION_REQUIRED", "下一波团队工作将超出自动成本上限。", "需要人工确认预算或缩小范围。")
        return compactCard(result.state, workflowDefinition, result.reason)
      } catch (error) {
        if (error.code === "WORKFLOW_INPUT_MISSING") return problem("ENTRY_UNSATISFIED", error.message, "当前阶段缺少最低输入，尚不能生成计划。")
        return problem(error.code ?? "PLAN_INVALID", error.message, "Runtime 未改变当前任务。")
      }
    },

    async run() {
      const state = await current()
      const result = await driver.runToStable({ taskId: state.taskId, leadBindingRef: leadBinding.bindingRef })
      return compactCard(result.state, workflowDefinition, result.reason)
    },

    async steer(input) {
      try {
        const state = await current()
        const result = await driver.steer({ taskId: state.taskId, input, leadBindingRef: leadBinding.bindingRef })
        return compactCard(result.state, workflowDefinition, result.reason)
      } catch (error) {
        if (error.code === "ACTION_STALE") return problem("ACTION_STALE", error.message, "请按最新卡片中的唯一下一步操作。")
        throw error
      }
    },
  })

  const memberDeliveryFor = (binding) => createMemberDelivery({ report: (report) => driver.deliverMemberReport({ ...binding, report }) })
  const observationSinkFor = (taskId) => createPlatformObservationSink({ observe: (observation) => driver.observe({ taskId, observation }) })
  rawExecutionAdapter.attachRuntime?.({ memberDeliveryFor, observationSinkFor })

  return Object.freeze({ leadControl, memberDeliveryFor, observationSinkFor })
}
