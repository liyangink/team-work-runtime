import { tool } from "@opencode-ai/plugin"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { createOpenCodeAdapter, resolveOpenCodeProjectRoot } from "../team-work/opencode-adapter.mjs"
import { createLeadController } from "../team-work/lead-controller.mjs"
import { loadOpenCodeActivation } from "../team-work/opencode-activation.mjs"
import { applyOpenCodeAgentConfig, resolveEffectivePlatformProfile } from "../team-work/opencode-agent-config.mjs"
import { loadUserConfig, resolveUserConfigRoot } from "../team-work/installer/user-config.mjs"

const json = (value) => `${JSON.stringify(value, null, 2)}\n`

export const TeamWorkPlugin = async ({ client, directory, worktree }) => {
  const projectRoot = resolveOpenCodeProjectRoot({ directory, worktree })
  const platformRoot = fileURLToPath(new URL("../team-work", import.meta.url))
  const loaded = await loadOpenCodeActivation(() => loadUserConfig({ configRoot: resolveUserConfigRoot() }))
  if (!loaded) return {}
  const profile = JSON.parse(await readFile(fileURLToPath(new URL("../team-work/profile.json", import.meta.url)), "utf8"))
  const effectiveProfile = resolveEffectivePlatformProfile(profile, loaded.config)
  const adapter = createOpenCodeAdapter({
    client,
    projectRoot,
    platformRoot,
    platformProfile: effectiveProfile,
    platformSettings: { spec: loaded.config.spec },
  })
  const lead = createLeadController({ adapter })
  const taskId = tool.schema.string().describe("稳定的 team-work task id")
  const workItemId = tool.schema.string().describe("稳定的 Runtime work item id")
  const helperSessionId = tool.schema.string().describe("team_work_assist 返回的只读 helper session id")
  const prompt = tool.schema.string().describe("成员本轮任务、范围、完成条件、制品路径和证据要求")
  const contextFor = async (sessionID) => {
    if (!sessionID) return null
    try {
      return await adapter.contextForSession(sessionID)
    } catch {
      // 上下文注入是增强能力，不能让无关或 standalone 会话形成死门。
      return null
    }
  }

  return {
    config: async (config) => {
      applyOpenCodeAgentConfig(config, { profile, userConfig: loaded.config })
    },
    event: async ({ event }) => {
      try {
        await adapter.handleEvent(event)
      } catch {
        // 事件审计不得阻断 OpenCode 主循环；后续状态查询仍可恢复任务与映射。
      }
    },
    "tool.execute.before": async (input, output) => {
      const helperRestricted = new Set(["task", "edit", "write", "patch", "bash"]).has(input.tool)
        || input.tool.startsWith("team_work_")
      if (helperRestricted && await adapter.isManagedHelperSession(input.sessionID)) {
        throw new Error("TEAM_WORK_HELPER_READ_ONLY_REJECTED: 只读助手不得修改文件、执行命令、继续委托或控制团队")
      }
      if (input.tool === "task" && await adapter.isManagedTeamSession(input.sessionID)) {
        throw new Error("TEAM_WORK_BLOCKING_TASK_REJECTED: solo/team 受管任务必须使用 team_work_dispatch 的非阻塞 child session")
      }
      if (input.tool === "todowrite") {
        await adapter.assertExternalTodoWriteAllowed(input.sessionID, output.args?.todos)
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      const context = await contextFor(input.sessionID)
      if (context) output.system.push(context)
    },
    "experimental.session.compacting": async (input, output) => {
      const context = await contextFor(input.sessionID)
      if (context) output.context.push(`${context}\n压缩后先按 task/work-item 和制品路径恢复，不以旧聊天摘要替代事实源。`)
    },
    tool: {
      team_work_overview: tool({
        description: "读取当前任务、阶段门禁和下一步；只读。task_id 可省略，此时按当前 OpenCode 会话绑定解析",
        args: { task_id: taskId.optional() },
        async execute(args, context) {
          return json(await lead.overview({ taskId: args.task_id, sessionId: context.sessionID }))
        },
      }),
      team_work_begin: tool({
        description: "创建并绑定研发任务，同时确定 solo/team 拓扑；一次调用完成开始任务所需状态写入",
        args: {
          task_id: taskId,
          title: tool.schema.string().min(1),
          entry_stage: tool.schema.enum(["research", "design", "design-review", "spec", "spec-review", "implementation", "test", "code-review", "e2e"]).default("research"),
          mode: tool.schema.enum(["solo", "team"]),
          reason: tool.schema.string().min(1).describe("选择该入口阶段和团队规模的依据"),
        },
        async execute(args, context) {
          return json(await lead.begin({ taskId: args.task_id, title: args.title, entryStage: args.entry_stage, mode: args.mode, reason: args.reason, sessionId: context.sessionID }))
        },
      }),
      team_work_register: tool({
        description: "把一个已存在的项目文件登记为当前任务上下文；Runtime 自动读取当前 revision，Lead 不传内部并发字段",
        args: {
          task_id: taskId,
          context_id: tool.schema.string().min(1),
          path: tool.schema.string().min(1).describe("相对项目根目录且已经存在的文件路径"),
          kind: tool.schema.enum(["requirement", "source", "review-scope", "test-scope", "spec", "design", "test", "review", "artifact", "evidence"]),
          profiles: tool.schema.array(tool.schema.enum(["lead", "research", "implement", "check"])).min(1),
          summary: tool.schema.string().optional(),
          must_read: tool.schema.boolean().default(false),
        },
        async execute(args) {
          return json(await lead.register({ taskId: args.task_id, contextId: args.context_id, path: args.path, kind: args.kind, profiles: args.profiles, summary: args.summary, mustRead: args.must_read }))
        },
      }),
      team_work_dispatch: tool({
        description: "创建或恢复 work item，并以后台 child session 派发给唯一 Owner；自动完成 create/start/spawn 或 start/resume，Lead 不传 revision、session_id 或 background 参数。SPEC 阶段只接受当前 OpenSpec change 的 ready/返工 artifact，并自动注入 provider instructions",
        args: {
          task_id: taskId,
          work_item_id: workItemId,
          owner: tool.schema.string().describe("已安装的 junior-*、senior-* 或 expert-* Agent 名称"),
          scope: tool.schema.string().min(1),
          done_when: tool.schema.array(tool.schema.string().min(1)).min(1),
          artifact_paths: tool.schema.array(tool.schema.string().min(1)).min(1).optional().describe("非 SPEC 工作的预期产物路径；SPEC 阶段不要传，路径由 Harness 生成"),
          spec_artifact: tool.schema.enum(["proposal", "design", "specs", "tasks"]).optional().describe("仅 SPEC 阶段使用；选择 provider 当前 ready 或原 work item 返工的 artifact"),
          spec_capabilities: tool.schema.array(tool.schema.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/)).min(1).optional().describe("仅 spec_artifact=specs 使用；填写 proposal 已确认的 capability 名称，不填写物理路径"),
          dependencies: tool.schema.array(workItemId).default([]),
          context_profile: tool.schema.enum(["research", "implement", "check"]).default("implement"),
          prompt,
          title: tool.schema.string().optional(),
        },
        async execute(args, context) {
          return json(await lead.dispatch({
            taskId: args.task_id, workItemId: args.work_item_id, owner: args.owner,
            scope: args.scope, doneWhen: args.done_when, artifactPaths: args.artifact_paths,
            specArtifact: args.spec_artifact, specCapabilities: args.spec_capabilities,
            dependencies: args.dependencies, contextProfile: args.context_profile,
            prompt: args.prompt, title: args.title, sessionId: context.sessionID,
          }))
        },
      }),
      team_work_assess: tool({
        description: "登记成员交付并一次完成 Expert/Senior 审查结论与 accept/rework；自动读取 revision 和生成证据 ID，返工后再用 team_work_dispatch 续派原会话",
        args: {
          task_id: taskId,
          work_item_id: workItemId,
          decision: tool.schema.enum(["accept", "rework"]),
          reviewer: tool.schema.string().min(1).describe("实际完成非作者审查的 Senior 或 Expert"),
          reason: tool.schema.string().min(1),
          scenario: tool.schema.string().min(1),
          scope_refs: tool.schema.array(tool.schema.string().min(1)).min(1),
          artifact_paths: tool.schema.array(tool.schema.string().min(1)).min(1).describe("已经存在的交付与审查制品"),
          evidence_path: tool.schema.string().min(1).describe("已经存在、可支撑本次裁决的文件"),
          summary: tool.schema.string().min(1),
        },
        async execute(args) {
          return json(await lead.assess({
            taskId: args.task_id, workItemId: args.work_item_id, decision: args.decision,
            reviewer: args.reviewer, reason: args.reason, scenario: args.scenario,
            scopeRefs: args.scope_refs, artifactPaths: args.artifact_paths,
            evidencePath: args.evidence_path, summary: args.summary,
          }))
        },
      }),
      team_work_continue: tool({
        description: "让 Harness 按持久状态继续：自动处理人工审核、创建/检查 OpenSpec 活动 change、选择合法前进边，并在最终验收后验证归档。无需 gate、revision、SPEC 命令或 approve/reject 参数",
        args: {
          task_id: taskId.optional().describe("通常省略，按当前 Lead 会话绑定解析"),
          result: tool.schema.enum(["completed", "needs_rework", "test_failed", "test_gap", "optional_stage_skipped"]).default("completed"),
          artifact_path: tool.schema.string().min(1).optional().describe("首次进入人工审核时提供当前阶段主制品；批准/驳回后继续时不要再传"),
          return_to: tool.schema.enum(["research", "design", "design-review", "spec", "spec-review", "implementation", "test", "code-review", "e2e"]).optional().describe("人工拒绝或跨阶段返工时指定；普通阶段边使用无需传"),
          reason: tool.schema.string().optional().describe("return_to 时必填"),
          final_artifact_paths: tool.schema.array(tool.schema.string().min(1)).min(1).optional().describe("finish 完成时必填"),
          final_summary: tool.schema.string().min(1).optional().describe("finish 完成时必填"),
        },
        async execute(args, context) {
          return json(await lead.continueFlow({
            taskId: args.task_id, result: args.result, returnTo: args.return_to,
            artifactPath: args.artifact_path, reason: args.reason,
            finalArtifactPaths: args.final_artifact_paths, finalSummary: args.final_summary,
            sessionId: context.sessionID,
          }))
        },
      }),
      team_work_review_gate: tool({
        description: "记录非人工流程门禁的技术裁决，例如 E2E 是否适用；只接受实际审查者和已存在证据文件",
        args: {
          task_id: taskId,
          gate_id: tool.schema.string().min(1),
          decision: tool.schema.enum(["passed", "rejected"]),
          reviewer: tool.schema.string().min(1),
          reason: tool.schema.string().min(1),
          evidence_path: tool.schema.string().min(1),
        },
        async execute(args) {
          return json(await lead.reviewGate({ taskId: args.task_id, gateId: args.gate_id, decision: args.decision, reviewer: args.reviewer, reason: args.reason, evidencePath: args.evidence_path }))
        },
      }),
      team_work_assist: tool({
        description: "由受管成员非阻塞派发一个临时只读 explore/librarian 助手；助手不成为团队成员或 work item Owner",
        args: {
          kind: tool.schema.enum(["explore", "librarian"]),
          prompt: tool.schema.string().describe("窄范围检索问题和期望证据；不得要求助手修改文件或作最终裁决"),
          title: tool.schema.string().optional(),
        },
        async execute(args, context) {
          return json(await adapter.assist({
            parentSessionId: context.sessionID,
            kind: args.kind,
            prompt: args.prompt,
            title: args.title,
          }))
        },
      }),
      team_work_assist_status: tool({
        description: "查询当前受管成员创建的只读 helper session 状态，不阻塞成员",
        args: { session_id: helperSessionId },
        async execute(args, context) {
          return json(await adapter.assistStatus({ parentSessionId: context.sessionID, sessionId: args.session_id }))
        },
      }),
      team_work_assist_collect: tool({
        description: "收集当前受管成员创建的只读 helper session 输出，由成员自行核验并整合",
        args: { session_id: helperSessionId, limit: tool.schema.number().int().positive().max(200).optional() },
        async execute(args, context) {
          return json(await adapter.assistMessages({
            parentSessionId: context.sessionID,
            sessionId: args.session_id,
            limit: args.limit,
          }))
        },
      }),
      team_work_sync: tool({
        description: "挂起当前工具调用并等待成员事件，事件到达后自动收集输出；Runtime/Plugin 等待，不产生模型轮询。默认 5 分钟、最长 30 分钟，可被用户输入中断。awaiting-user 时禁止调用",
        args: {
          task_id: taskId,
          work_item_ids: tool.schema.array(workItemId).min(1).optional().describe("可选；只等待这些 work item，省略则等待任务下任一受管成员"),
          timeout_ms: tool.schema.number().int().positive().max(1_800_000).default(300_000),
          message_limit: tool.schema.number().int().positive().max(200).optional(),
        },
        async execute(args, context) {
          return json(await lead.sync({
            taskId: args.task_id, workItemIds: args.work_item_ids,
            timeoutMs: args.timeout_ms, messageLimit: args.message_limit,
            sessionId: context.sessionID, signal: context.abort,
          }))
        },
      }),
    },
  }
}

export default TeamWorkPlugin
