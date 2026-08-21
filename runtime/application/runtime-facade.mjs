import { createLeadControl } from "../lead-control.mjs"
import { createMemberDelivery } from "../member-delivery.mjs"
import { createPlatformObservationSink } from "../platform-observation.mjs"
import { createExecutionAdapterPort } from "../ports/execution.mjs"
import { createSpecProviderAdapterPort } from "../ports/spec-provider.mjs"
import { createTaskDriver } from "./driver.mjs"
import { createTaskReconciler } from "./reconciler.mjs"
import { composeActionCard } from "./action-card.mjs"
import { validateWorkflowDefinition } from "../../workflow/compiler.mjs"

// 与 schemas/v2/runtime-card.schema.json 的 problemCard.code 枚举保持一致；
// 未知错误码必须收敛到枚举内，否则"错误处理"本身会产出非法卡片并掩盖真实错误。
const PROBLEM_CODES = new Set([
  "TASK_SELECTION_REQUIRED",
  "PLAN_INVALID",
  "ACTION_STALE",
  "ENTRY_UNSATISFIED",
  "ROUTE_BLOCKED",
  "ROUTE_SKIPPED",
  "BUDGET_DECISION_REQUIRED",
  "EVIDENCE_CHANGED",
  "WORK_CHAIN_INCOMPLETE",
  "PLATFORM_UNAVAILABLE",
  "EXTERNAL_EFFECT_IN_DOUBT",
  "RECOVERY_REQUIRED",
  "HUMAN_DECISION_REQUIRED",
  "CONTEXT_BUDGET_EXCEEDED",
  "STATE_CORRUPT",
  "RUNTIME_MAJOR_MISMATCH",
])

function problem(code, message, impact) {
  if (PROBLEM_CODES.has(code)) {
    return { code, message, impact, next: { kind: "none", reason: "需要先处理上述问题" } }
  }
  return {
    code: "PLAN_INVALID",
    message: `${message}（原始错误码 ${code ?? "UNKNOWN"}）`,
    impact,
    next: { kind: "none", reason: "需要先处理上述问题" },
  }
}

function compactCard(state, workflowDefinition, reason) {
  const normalizedReason = state.status === "completed" ? "completed"
    : state.status === "cancelled" ? "cancelled"
      : state.status === "awaiting-user" ? "awaiting-user"
        : state.status === "blocked" ? "blocked"
          : (!state.stagePlan && !state.preflight) ? "needs-plan"
            : ["waiting-report", "settling-idle", "wait-budget-exhausted", "budget-decision", "in-doubt"].includes(reason) ? reason
              : "stable"
  const pending = state.pendingDecision
  const decision = pending?.packetRef ? {
    summary: "当前判断所需的团队结论、证据和制品已经整理为决策包。",
    packetRef: pending.packetRef,
    question: pending.question,
    choices: pending.choices,
    ...(pending.decisionId.startsWith("convergence-") ? { disagreement: "团队在三轮内仍未自主收敛。" } : {}),
  } : undefined
  return composeActionCard({ taskState: state, workflowDefinition, reason: normalizedReason, decision })
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
  signalHub,
  executionPreparer,
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
    ...(signalHub ? { signalHub } : {}),
    ...(executionPreparer ? { executionPreparer } : {}),
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
        if (error.code === "WORKFLOW_INPUT_MISSING") {
          return problem("ENTRY_UNSATISFIED", error.message, "当前阶段缺少最低输入，且制品只能在创建任务时通过 existing_artifacts 登记。若无法补齐，请重新创建任务（workflow_open mode=create 并声明 existing_artifacts）；已固化的目标或约束变更请用 workflow_steer action=replan。")
        }
        if (error.code === "TASK_INTENT_CONFLICT") {
          return problem("PLAN_INVALID", "任务目标或约束已固化，直接修改会被拒绝。", "任务状态未改变。存在待决策时可用 workflow_steer（action=replan）受控重规划；当前没有待决策的固化任务请新建（workflow_open mode=create）并使用修正后的目标与约束。")
        }
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
        if (error.code === "STEERING_BUDGET_REQUIRED") {
          return problem("BUDGET_DECISION_REQUIRED", error.message, "当前任务保持静止；请扩大预算、缩小范围或放弃第二位 Expert。")
        }
        if (error.code === "ACTION_STALE" || error.code?.startsWith("STEERING_")) {
          return problem("ACTION_STALE", error.message, "请读取最新决策包，并只引用其中仍可见的对象。")
        }
        throw error
      }
    },
  })

  const memberDeliveryFor = (binding) => createMemberDelivery({ report: (report) => driver.deliverMemberReport({ ...binding, report }) })
  const observationSinkFor = (taskId) => createPlatformObservationSink({ observe: (observation) => driver.observe({ taskId, observation }) })
  rawExecutionAdapter.attachRuntime?.({ memberDeliveryFor, observationSinkFor })

  const hostControl = Object.freeze({
    async run({ waitBudgetMs = 0, signal } = {}) {
      const state = await current()
      const result = await driver.runToStable({
        taskId: state.taskId,
        leadBindingRef: leadBinding.bindingRef,
        waitBudgetMs,
        ...(signal ? { signal } : {}),
      })
      return compactCard(result.state, workflowDefinition, result.reason)
    },
  })

  return Object.freeze({ leadControl, hostControl, memberDeliveryFor, observationSinkFor })
}
