import { randomUUID } from "node:crypto"

function fail(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  error.retryable = false
  return error
}

function assertReviewer(reviewer, owner, stage) {
  if (!/^(?:senior|expert)-[a-z0-9._-]+$/.test(reviewer ?? "")) {
    throw fail("REVIEWER_ROLE_REQUIRED", "reviewer must be an installed Senior or Expert Agent")
  }
  if (reviewer === owner) throw fail("INDEPENDENT_REVIEW_REQUIRED", "reviewer must not be the work-item Owner")
  if (["design-review", "spec-review", "code-review"].includes(stage) && !reviewer.startsWith("expert-")) {
    throw fail("EXPERT_REVIEW_REQUIRED", `${stage} requires a non-author Expert reviewer`)
  }
}

export function createLeadController({ adapter, id = () => randomUUID().slice(0, 8).toLowerCase() }) {
  const stageNames = {
    research: "需求调研", design: "方案设计", "design-review": "方案审查", spec: "SPEC",
    "spec-review": "SPEC 审查", implementation: "实施", test: "测试", "code-review": "代码审查",
    e2e: "E2E 测试", finish: "收尾",
  }
  async function runtime(request) {
    const result = await adapter.runtime(request)
    if (result.envelope?.ok === false) {
      const error = fail(result.envelope.error.code, result.envelope.error.message)
      error.retryable = result.envelope.error.retryable
      error.blockers = result.envelope.error.blockers
      error.remediation = result.envelope.error.remediation
      throw error
    }
    return result.envelope.data
  }

  async function currentTask(taskId, sessionId) {
    return (await runtime({
      command: "task.show",
      input: taskId ? { taskId } : { platform: "opencode", sessionKey: sessionId },
    })).task
  }

  async function resolveHumanGate(task, requestedGateId) {
    if (task.awaitingUser?.gateRef) {
      if (requestedGateId && requestedGateId !== task.awaitingUser.gateRef) {
        throw fail("HUMAN_GATE_MISMATCH", `task is awaiting ${task.awaitingUser.gateRef}, not ${requestedGateId}`)
      }
      return task.awaitingUser.gateRef
    }
    if (requestedGateId) return requestedGateId
    const flow = await runtime({ command: "flow.status", input: { taskId: task.taskId } })
    const candidates = [...new Set((flow.gate?.blockers ?? [])
      .filter(({ kind }) => kind === "human")
      .map(({ gateId }) => gateId)
      .filter(Boolean))]
    if (candidates.length !== 1) {
      throw fail("HUMAN_GATE_REQUIRED", `cannot infer one human gate for ${task.stage}; candidates: ${candidates.join(", ") || "none"}`)
    }
    return candidates[0]
  }

  async function summary(taskId, note) {
    const task = await currentTask(taskId)
    const flow = await runtime({ command: "flow.status", input: { taskId: task.taskId } })
    const blockers = flow.gate?.blockers ?? []
    const pending = flow.workItems?.filter(({ status }) => !["accepted", "cancelled"].includes(status)) ?? []
    let next = "当前阶段已满足，可继续推进"
    if (task.status === "awaiting-user") next = "等待用户审核；收到明确回复前停止推进"
    else if (pending.length) next = `等待或处理 ${pending.length} 个团队工作项`
    else if (blockers.some(({ kind }) => kind === "human")) next = "提交当前阶段制品给用户审核"
    else if (blockers.length) next = "补齐当前阶段缺失的制品、审查或证据"
    return {
      taskId: task.taskId,
      stage: task.stage,
      stageName: stageNames[task.stage] ?? task.stage,
      state: task.status,
      work: {
        total: flow.workItems?.length ?? 0,
        pending: pending.length,
        accepted: flow.workItems?.filter(({ status }) => status === "accepted").length ?? 0,
      },
      blockers: blockers.map(({ code, kind, path, message }) => ({ code, kind, ...(path ? { path } : {}), ...(message ? { message } : {}) })),
      next,
      ...(note ? { report: note } : {}),
    }
  }

  async function progressTask({ taskId, result = "completed", returnTo, reason, finalArtifactPaths, finalSummary }) {
    let task = await currentTask(taskId)
    if (task.stage === "finish" && result === "completed") {
      const finalGate = task.gates.find(({ gateId, status }) => gateId === "final-acceptance" && status === "passed")
      if (!finalArtifactPaths?.length || !finalSummary) throw fail("FINAL_ACCEPTANCE_INPUT_REQUIRED", "finish completion requires finalArtifactPaths and finalSummary")
      if (!finalGate?.evidenceRefs?.length) throw fail("FINAL_ACCEPTANCE_REQUIRED", "final-acceptance has not passed")
      if (task.spec.status === "completed" && task.spec.artifactRefs.some((entry) => /(?:^|\/)changes\/(?!archive\/)/.test(entry))) {
        task = (await adapter.archiveOpenSpec(taskId)).task
      }
      return runtime({
        command: "task.complete",
        input: {
          taskId, actor: "lead", summary: finalSummary,
          artifactPaths: finalArtifactPaths, evidenceRefs: finalGate.evidenceRefs,
          expectedRevision: task.revision,
        },
      })
    }
    if (result === "needs_rework" && returnTo) {
      if (!reason) throw fail("ROLLBACK_REASON_REQUIRED", "returnTo requires reason")
      const validEvidence = new Set(task.evidence.filter(({ status }) => status === "valid").map(({ evidenceId }) => evidenceId))
      const evidenceRefs = [...new Set(task.gates.flatMap((gate) => gate.evidenceRefs ?? []).filter((ref) => validEvidence.has(ref)))]
      return runtime({
        command: "flow.rollback",
        input: { taskId, to: returnTo, reason, evidenceRefs, expectedRevision: task.revision },
      })
    }
    if (result === "completed") {
      return runtime({ command: "flow.proceed", input: { taskId, expectedRevision: task.revision } })
    }
    const outcome = {
      needs_rework: "rework",
      test_failed: "fail",
      test_gap: "test-gap",
      optional_stage_skipped: "skip",
    }[result]
    if (!outcome) throw fail("INVALID_WORKFLOW_RESULT", result)
    return runtime({ command: "flow.advance", input: { taskId, outcome, expectedRevision: task.revision } })
  }

  return {
    async overview({ taskId, sessionId }) {
      const task = await currentTask(taskId, sessionId)
      return summary(task.taskId)
    },

    async begin({ taskId, title, entryStage, mode, reason, sessionId }) {
      const existing = await adapter.runtime({ command: "task.show", input: { taskId } })
      let task
      if (existing.exitCode === 0) {
        task = existing.envelope.data.task
        if (task.entryStage !== entryStage || (task.title && task.title !== title)) {
          throw fail("TASK_BEGIN_CONFLICT", `existing task ${taskId} has different title or entry stage`)
        }
      } else if (existing.envelope?.error?.code === "TASK_NOT_FOUND") {
        task = (await runtime({ command: "task.create", input: { taskId, title, entryStage } })).task
      } else {
        await runtime({ command: "task.show", input: { taskId } })
      }
      if (task.teamDecision.mode === "undecided") {
        task = (await runtime({ command: "task.team", input: { taskId, mode, reason, expectedRevision: task.revision } })).task
      } else if (task.teamDecision.mode !== mode) {
        throw fail("TASK_BEGIN_CONFLICT", `existing task ${taskId} uses ${task.teamDecision.mode}, not ${mode}`)
      }
      let binding
      try {
        binding = (await runtime({ command: "task.bind", input: { taskId, platform: "opencode", sessionKey: sessionId } })).binding
      } catch (error) {
        if (error.code !== "REVISION_CONFLICT") throw error
        const resolved = await currentTask(undefined, sessionId)
        if (resolved.taskId !== taskId) throw fail("TASK_BINDING_CONFLICT", `session is bound to ${resolved.taskId}`)
        binding = { platform: "opencode", sessionKey: sessionId, taskId, existing: true }
      }
      let spec
      if (task.stage === "spec") {
        spec = await adapter.ensureOpenSpec(taskId)
        task = spec.task
      }
      return { task, binding, ...(spec ? { spec: spec.change } : {}), next: "register-context-then-dispatch" }
    },

    async register({ taskId, contextId, path, kind, profiles, summary, mustRead }) {
      const task = await currentTask(taskId)
      return runtime({
        command: "context.register",
        input: { taskId, contextId, path, kind, profiles, summary, mustRead, expectedRevision: task.revision },
      })
    },

    async dispatch({ taskId, workItemId, owner, scope, doneWhen, artifactPaths, specArtifact, specCapabilities = [], dependencies = [], contextProfile, prompt, title, sessionId }) {
      let task = await currentTask(taskId)
      let item
      const shown = await adapter.runtime({ command: "work.show", input: { taskId, workItemId } })
      if (shown.exitCode === 0) item = shown.envelope.data.workItem
      else if (shown.envelope?.error?.code !== "TASK_NOT_FOUND") {
        await runtime({ command: "work.show", input: { taskId, workItemId } })
      }
      if (task.stage === "spec") {
        if (artifactPaths?.length) throw fail("OPENSPEC_PATH_FORBIDDEN", "SPEC 派单不接受物理 artifactPaths；请传 specArtifact 和 capability 名称")
        const prepared = await adapter.prepareOpenSpecDispatch({
          taskId, artifactId: specArtifact, capabilities: specCapabilities, prompt,
          allowCompleted: Boolean(item && ["running", "rework", "blocked"].includes(item.status)),
        })
        prompt = prepared.prompt
        artifactPaths = prepared.artifactPaths
        task = await currentTask(taskId)
      } else if (!artifactPaths?.length) {
        throw fail("WORK_ARTIFACT_REQUIRED", "非 SPEC 工作必须提供至少一个产物路径")
      }
      if (!item) {
        const created = await runtime({
          command: "work.create",
          input: { taskId, workItemId, owner, scope, doneWhen, artifactPaths, dependencies, expectedRevision: task.revision },
        })
        item = created.workItem
        task = await currentTask(taskId)
      }
      if (item.owner !== owner) throw fail("WORK_OWNER_MISMATCH", `${item.owner} != ${owner}`)
      if (JSON.stringify(item.assignment.artifactPaths) !== JSON.stringify(artifactPaths)) {
        throw fail("WORK_ASSIGNMENT_MISMATCH", "续派必须保持原 work item 的产物边界；职责变化请创建新 work item")
      }
      if (["queued", "rework", "blocked"].includes(item.status)) {
        const started = await runtime({
          command: "work.start",
          input: { taskId, workItemId, owner, expectedRevision: task.revision },
        })
        item = started.workItem
      }
      if (item.status !== "running") throw fail("WORK_ITEM_NOT_DISPATCHABLE", `${workItemId} is ${item.status}`)
      let hasMapping = true
      let mapping
      try {
        mapping = await adapter.readMapping(taskId, workItemId)
      } catch (error) {
        if (error.code === "SESSION_MAPPING_NOT_FOUND") hasMapping = false
        else throw error
      }
      if (mapping?.lostRecordedAt || mapping?.stoppedAt) hasMapping = false
      const dispatch = hasMapping
        ? await adapter.resume({ taskId, workItemId, prompt })
        : await adapter.spawn({ taskId, workItemId, parentSessionId: sessionId, agent: owner, contextProfile, prompt, title })
      return { workItem: item, dispatch }
    },

    async sync({ taskId, workItemIds, timeoutMs, messageLimit, sessionId, signal }) {
      const task = await currentTask(taskId)
      if (task.status === "awaiting-user") {
        throw fail("HUMAN_DECISION_PENDING", "正在等待用户明确决定；禁止启动成员同步或定时轮询")
      }
      const wait = await adapter.wait({ taskId, workItemIds, requesterSessionId: sessionId, timeoutMs, signal })
      const collected = []
      for (const item of wait.items ?? []) {
        collected.push(await adapter.messages({ taskId, workItemId: item.workItemId, limit: messageLimit }))
      }
      return { wait, collected }
    },

    async assess({ taskId, workItemId, decision, reviewer, reason, scenario, scopeRefs, artifactPaths, evidencePath, summary }) {
      let task = await currentTask(taskId)
      let shown = await runtime({ command: "work.show", input: { taskId, workItemId } })
      assertReviewer(reviewer, shown.workItem.owner, shown.workItem.stage)
      await adapter.assertAgentAvailable(reviewer)
      if (shown.workItem.status === "accepted" && decision === "accept") return { workItem: shown.workItem, idempotent: true }
      if (shown.workItem.status === "rework" && decision === "rework") return { workItem: shown.workItem, idempotent: true }
      if (shown.workItem.status === "running") {
        await runtime({
          command: "work.submit",
          input: {
            taskId, workItemId, scenario, scopeRefs,
            outcome: decision === "accept" ? "pass" : "rework",
            artifactPaths, evidenceRefs: [], summary, expectedRevision: task.revision,
          },
        })
        task = await currentTask(taskId)
        shown = await runtime({ command: "work.show", input: { taskId, workItemId } })
      }
      if (shown.workItem.status !== "submitted") throw fail("WORK_ITEM_NOT_ASSESSABLE", `${workItemId} is ${shown.workItem.status}`)
      const evidenceId = `${workItemId}-${decision}-${id()}`
      const gate = await runtime({
        command: "flow.decide",
        input: {
          taskId, gateId: `work-${workItemId}`, kind: "semantic",
          status: decision === "accept" ? "passed" : "rejected",
          actor: reviewer, reason, evidenceId, evidencePath, expectedRevision: task.revision,
        },
      })
      const decided = await runtime({
        command: decision === "accept" ? "work.accept" : "work.rework",
        input: { taskId, workItemId, actor: "lead", reason, evidenceRefs: [evidenceId], expectedRevision: gate.task.revision },
      })
      return { workItem: decided.workItem, gate: gate.gate, evidence: gate.evidence }
    },

    async progress({ taskId, result, returnTo, reason, finalArtifactPaths, finalSummary }) {
      return progressTask({ taskId, result, returnTo, reason, finalArtifactPaths, finalSummary })
    },

    async reviewGate({ taskId, gateId, decision, reviewer, reason, evidencePath }) {
      const task = await currentTask(taskId)
      assertReviewer(reviewer, null, task.stage)
      await adapter.assertAgentAvailable(reviewer)
      return runtime({
        command: "flow.decide",
        input: {
          taskId, gateId, kind: "semantic", status: decision, actor: reviewer, reason,
          evidenceId: `${gateId}-${id()}`, evidencePath, expectedRevision: task.revision,
        },
      })
    },

    async userReview({ taskId, action, gateId, evidencePath, reason, question, blocker, requiredDecision, sessionId }) {
      let task = await currentTask(taskId)
      if (action === "request") {
        if (!question || !blocker || !requiredDecision) throw fail("INVALID_USER_REVIEW_REQUEST", "question、blocker、requiredDecision 必填")
        await adapter.assertNoPendingExternalTodos(sessionId)
        return runtime({
          command: "flow.await",
          input: { taskId, evidencePath, question, blocker, requiredDecision, expectedRevision: task.revision },
        })
      }
      if (!["approve", "reject"].includes(action)) throw fail("INVALID_USER_REVIEW_ACTION", action)
      if (!task.awaitingUser?.requestedAt) throw fail("USER_REVIEW_NOT_PENDING", "task is not awaiting an explicit user decision")
      await adapter.assertNoPendingExternalTodos(sessionId)
      const resolvedGateId = await resolveHumanGate(task, gateId)
      if (!task.awaitingUser.gateRef) {
        task = (await runtime({
          command: "task.await",
          input: {
            taskId,
            gateId: resolvedGateId,
            evidencePath,
            question: task.awaitingUser.question,
            blocker: task.awaitingUser.blocker,
            requiredDecision: task.awaitingUser.requiredDecision,
            reason: "repair legacy gate-less human wait",
            expectedRevision: task.revision,
          },
        })).task
      }
      const userDecision = await adapter.assertUserDecision({ sessionId, action, requestedAt: task.awaitingUser.requestedAt })
      return runtime({
        command: "flow.human",
        input: {
          taskId, status: action === "approve" ? "passed" : "rejected",
          actor: "user", reason: `${reason} [user-message:${userDecision.messageId}]`, evidenceId: `${resolvedGateId}-${id()}`, expectedRevision: task.revision,
        },
      })
    },

    async continueFlow({ taskId, result = "completed", artifactPath, returnTo, reason, finalArtifactPaths, finalSummary, sessionId }) {
      let task = await currentTask(taskId, sessionId)
      if (task.status === "awaiting-user") {
        await adapter.assertNoPendingExternalTodos(sessionId)
        const decision = await adapter.resolveUserDecision({ sessionId, requestedAt: task.awaitingUser.requestedAt })
        const resolved = await runtime({
          command: "flow.human",
          input: {
            taskId: task.taskId,
            status: decision.action === "approve" ? "passed" : "rejected",
            actor: "user",
            reason: `用户明确${decision.action === "approve" ? "批准" : "驳回"} [user-message:${decision.messageId}]`,
            evidenceId: `${task.awaitingUser.gateRef}-${id()}`,
            expectedRevision: task.revision,
          },
        })
        if (decision.action === "reject") {
          return summary(task.taskId, "用户已驳回当前制品；请根据反馈确定返工阶段后再继续。")
        }
        task = resolved.task
        try {
          const progressed = await progressTask({ taskId: task.taskId, result, returnTo, reason, finalArtifactPaths, finalSummary })
          const progressedTask = progressed.task ?? await currentTask(task.taskId)
          if (progressedTask.stage === "spec" && progressedTask.spec.status !== "completed") await adapter.ensureOpenSpec(task.taskId)
          return summary(task.taskId, "用户批准已记录，工作流已进入下一阶段。")
        } catch (error) {
          return { ...(await summary(task.taskId, "用户批准已可靠记录；下一阶段仍有固定门禁需要处理。")), continuationError: { code: error.code, message: error.message, blockers: error.blockers ?? [] } }
        }
      }

      if (task.stage === "spec" && result === "completed") {
        const spec = await adapter.completeOpenSpec(task.taskId)
        if (!spec.complete) {
          const ready = spec.change.ready.map(({ artifactId }) => artifactId).join("、") || "等待前置 artifact"
          return summary(task.taskId, `OpenSpec 活动变更尚未完成；下一步：${ready}。不得跳过或直接修改 canonical/archive 文档。`)
        }
        task = spec.task
      }

      const flow = await runtime({ command: "flow.status", input: { taskId: task.taskId } })
      const humanBlocker = flow.gate?.blockers?.find(({ code, kind }) => code === "REQUIRED_GATE_MISSING" && kind === "human")
      if (humanBlocker) {
        if (!artifactPath) throw fail("HUMAN_REVIEW_ARTIFACT_REQUIRED", "当前阶段需要人工审核，请提供已存在的制品路径")
        await adapter.assertNoPendingExternalTodos(sessionId)
        await runtime({
          command: "flow.await",
          input: {
            taskId: task.taskId,
            evidencePath: artifactPath,
            question: `请审核 ${artifactPath}，是否批准继续推进？`,
            blocker: "等待用户审核当前阶段制品",
            requiredDecision: "批准继续，或明确指出需要返工的内容",
            expectedRevision: task.revision,
          },
        })
        return summary(task.taskId, `已提交 ${artifactPath} 等待用户审核。`)
      }

      const progressed = await progressTask({ taskId: task.taskId, result, returnTo, reason, finalArtifactPaths, finalSummary })
      const progressedTask = progressed.task ?? await currentTask(task.taskId)
      if (progressedTask.stage === "spec" && progressedTask.spec.status !== "completed") await adapter.ensureOpenSpec(task.taskId)
      return summary(task.taskId, "当前阶段已完成，工作流已进入下一阶段。")
    },
  }
}
