export const LEAD_TOOL_NAMES = Object.freeze(["workflow_open", "workflow_plan", "workflow_run", "workflow_steer"])

export const TOOL_DESCRIPTIONS = Object.freeze({
  workflow_open: "打开已有研发任务，或从任意阶段创建一个新任务；返回当前进展和唯一下一步。",
  workflow_plan: "提交目标、约束和成本偏好，由 Harness 生成并启动当前阶段计划。",
  workflow_run: "按已持久化事实继续推进；成员工作未完成时在平台内等待事件，不需要轮询。",
  workflow_steer: "响应当前决策，或请求解释、返工、补证据、追加挑战、Expert 意见、更换 Owner、重规划或升级用户。只提交意图。",
  team_work_report: "由当前受管成员提交本轮结构化交付；身份和工作范围由 Harness 自动绑定。",
})

function compact(value) {
  if (Array.isArray(value)) return value.map(compact)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, compact(entry)]))
  }
  return value
}

function openIntent(args) {
  if (args.task_id) return { taskId: args.task_id }
  if (args.completion_mode === "through-stage" && !args.completion_stage) {
    throw new TypeError("completion_stage is required when completion_mode is through-stage")
  }
  return compact({
    title: args.title,
    objective: args.objective,
    entryStage: args.entry_stage,
    completion: args.completion_mode === "through-stage"
      ? { mode: "through-stage", stage: args.completion_stage }
      : { mode: "workflow" },
    existingArtifacts: (args.existing_artifacts ?? []).map(({ kind, path }) => ({
      kind,
      locator: { type: "project-path", value: path },
    })),
  })
}

function memberReport(args) {
  return compact({
    outcome: args.outcome,
    summary: args.summary,
    artifacts: args.artifacts ?? [],
    evidenceRefs: args.evidence_refs ?? [],
    unresolved: args.unresolved,
    checks: args.checks?.map(({ name, result, evidence_ref }) => compact({ name, result, evidenceRef: evidence_ref })),
    findings: args.findings?.map(({ severity, statement, evidence_refs }) => ({ severity, statement, evidenceRefs: evidence_refs ?? [] })),
    recommendation: args.recommendation,
    workflowOutcome: args.workflow_outcome,
    verdict: args.verdict ? {
      outcome: args.verdict.outcome,
      rationale: args.verdict.rationale,
      evidenceRefs: args.verdict.evidence_refs ?? [],
      affectedScope: args.verdict.affected_scope ?? [],
      risks: args.verdict.risks ?? [],
      confidence: args.verdict.confidence,
      recommendedAction: args.verdict.recommended_action,
    } : undefined,
  })
}

export function createOpenCodeToolHandlers({ runtimeHost } = {}) {
  if (!runtimeHost) throw new TypeError("runtimeHost is required")
  return Object.freeze({
    workflow_open: (args, context) => runtimeHost.open(context.sessionID, openIntent(args)),
    workflow_plan: (args, context) => runtimeHost.plan(context.sessionID, compact({
      objective: args.objective,
      constraints: args.constraints,
      exclusions: args.exclusions,
      preferences: { execution: args.execution, budget: args.budget, risk: args.risk },
    })),
    workflow_run: (_args, context) => runtimeHost.run(context.sessionID, { signal: context.abort }),
    workflow_steer: (args, context) => runtimeHost.steer(context.sessionID, compact({
      action: args.action,
      directive: args.directive,
      targetRef: args.target_ref,
      referenceRefs: args.reference_refs,
      note: args.note,
    })),
    team_work_report: (args, context) => runtimeHost.report(context.sessionID, memberReport(args)),
  })
}
