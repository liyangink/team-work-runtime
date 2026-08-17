import { tool } from "@opencode-ai/plugin"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { createOpenCodeAdapter } from "../team-work/opencode-adapter.mjs"
import { loadOpenCodeActivation } from "../team-work/opencode-activation.mjs"
import { applyOpenCodeAgentConfig, resolveEffectivePlatformProfile } from "../team-work/opencode-agent-config.mjs"
import { loadUserConfig, resolveUserConfigRoot } from "../team-work/installer/user-config.mjs"

const json = (value) => `${JSON.stringify(value, null, 2)}\n`

export const TeamWorkPlugin = async ({ client, directory, worktree }) => {
  const platformRoot = fileURLToPath(new URL("../team-work", import.meta.url))
  const loaded = await loadOpenCodeActivation(() => loadUserConfig({ configRoot: resolveUserConfigRoot() }))
  if (!loaded) return {}
  const profile = JSON.parse(await readFile(fileURLToPath(new URL("../team-work/profile.json", import.meta.url)), "utf8"))
  const effectiveProfile = resolveEffectivePlatformProfile(profile, loaded.config)
  const adapter = createOpenCodeAdapter({
    client,
    projectRoot: worktree || directory,
    platformRoot,
    platformProfile: effectiveProfile,
    platformSettings: { spec: loaded.config.spec },
  })
  const taskId = tool.schema.string().describe("稳定的 team-work task id")
  const workItemId = tool.schema.string().describe("稳定的 Runtime work item id")
  const helperSessionId = tool.schema.string().describe("team_work_assist 返回的只读 helper session id")
  const prompt = tool.schema.string().describe("成员本轮任务、范围、完成条件、制品路径和证据要求")
  const runtimeCommands = [
    "init", "doctor", "version", "migrate",
    "task.create", "task.bind", "task.show", "task.team", "task.spec", "task.await", "task.resume", "task.complete", "task.cancel", "task.archive",
    "context.register", "context.list", "context.render", "context.rebuild",
    "flow.status", "flow.check", "flow.advance", "flow.rollback", "flow.decide",
    "work.start", "work.submit", "work.accept", "work.rework", "work.block", "work.cancel", "work.show",
    "event.list", "event.record",
  ]
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
    "tool.execute.before": async (input) => {
      const helperRestricted = new Set(["task", "edit", "write", "patch", "bash"]).has(input.tool)
        || input.tool.startsWith("team_work_")
      if (helperRestricted && await adapter.isManagedHelperSession(input.sessionID)) {
        throw new Error("TEAM_WORK_HELPER_READ_ONLY_REJECTED: 只读助手不得修改文件、执行命令、继续委托或控制团队")
      }
      if (input.tool === "task" && await adapter.isManagedTeamSession(input.sessionID)) {
        throw new Error("TEAM_WORK_BLOCKING_TASK_REJECTED: solo/team 受管任务必须使用 team_work_spawn 的非阻塞 child session")
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
      team_work_runtime: tool({
        description: "以稳定 JSON Interface 调用项目 CoreRuntime；用于任务、上下文、流程、门禁和 work item 状态，不执行任意 shell。创建 work item 优先使用强类型 team_work_work_create，避免猜测字段名",
        args: {
          command: tool.schema.enum(runtimeCommands),
          input: tool.schema.record(tool.schema.string(), tool.schema.unknown()).default({}),
          dry_run: tool.schema.boolean().default(false),
        },
        async execute(args, context) {
          const input = { ...args.input }
          if (args.command === "task.bind") {
            input.platform = "opencode"
            input.sessionKey = context.sessionID
          }
          if (args.command === "task.show" && !input.taskId) {
            input.platform = "opencode"
            input.sessionKey = context.sessionID
          }
          return json((await adapter.runtime({ command: args.command, input, dryRun: args.dry_run })).envelope)
        },
      }),
      team_work_work_create: tool({
        description: "强类型创建 Runtime work item；固定平台参数并映射到 CoreRuntime，避免通过通用 record 猜测字段名",
        args: {
          task_id: taskId,
          work_item_id: workItemId,
          owner: tool.schema.string().describe("已安装的 Team-work Agent 名称，且必须与随后派发的 agent 一致"),
          scope: tool.schema.string().min(1).describe("唯一 Owner 的工作范围与边界"),
          done_when: tool.schema.array(tool.schema.string().min(1)).min(1).describe("可核验完成条件"),
          artifact_paths: tool.schema.array(tool.schema.string().min(1)).min(1).describe("相对项目根目录的预期制品路径"),
          dependencies: tool.schema.array(workItemId).default([]),
          expected_revision: tool.schema.number().int().nonnegative(),
        },
        async execute(args) {
          return json((await adapter.runtime({
            command: "work.create",
            input: {
              taskId: args.task_id,
              workItemId: args.work_item_id,
              owner: args.owner,
              scope: args.scope,
              doneWhen: args.done_when,
              artifactPaths: args.artifact_paths,
              dependencies: args.dependencies,
              expectedRevision: args.expected_revision,
            },
          })).envelope)
        },
      }),
      team_work_spawn: tool({
        description: "非阻塞创建受管 OpenCode child session 并派发 solo/team work item；仅失联或已停止的旧 session 可受控替换",
        args: {
          task_id: taskId,
          work_item_id: workItemId,
          agent: tool.schema.string().describe("已安装的 junior-*、senior-* 或 expert-* subagent 名称"),
          context_profile: tool.schema.enum(["research", "implement", "check"]).default("implement"),
          prompt,
          title: tool.schema.string().optional(),
        },
        async execute(args, context) {
          return json(await adapter.spawn({
            taskId: args.task_id,
            workItemId: args.work_item_id,
            parentSessionId: context.sessionID,
            agent: args.agent,
            contextProfile: args.context_profile,
            prompt: args.prompt,
            title: args.title,
          }))
        },
      }),
      team_work_resume: tool({
        description: "非阻塞续派已有 child session；同一 work item 的返工和多轮收敛必须优先复用；只传 task_id、work_item_id 和 prompt，不要传 session_id、run_in_background 或 background，本工具自身始终非阻塞",
        args: { task_id: taskId, work_item_id: workItemId, prompt },
        async execute(args) {
          return json(await adapter.resume({ taskId: args.task_id, workItemId: args.work_item_id, prompt: args.prompt }))
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
      team_work_status: tool({
        description: "查询受管团队 child session 状态，不阻塞 Lead",
        args: { task_id: taskId, work_item_id: workItemId },
        async execute(args) {
          return json(await adapter.status({ taskId: args.task_id, workItemId: args.work_item_id }))
        },
      }),
      team_work_wait: tool({
        description: "在明确同步点有界等待任一受管成员请求同步；默认 10 秒、最长 30 秒，事件通知优先并低频复核状态。ready 只表示应收集消息，不表示工作已验收；timeout 后继续处理用户输入或其他 Harness 工作",
        args: {
          task_id: taskId,
          work_item_ids: tool.schema.array(workItemId).min(1).optional().describe("可选；只等待这些 work item，省略则等待任务下任一受管成员"),
          timeout_ms: tool.schema.number().int().positive().max(30_000).default(10_000),
        },
        async execute(args, context) {
          return json(await adapter.wait({
            taskId: args.task_id,
            workItemIds: args.work_item_ids,
            requesterSessionId: context.sessionID,
            timeoutMs: args.timeout_ms,
            signal: context.abort,
          }))
        },
      }),
      team_work_collect: tool({
        description: "在同步点读取受管 child session 消息，供 Lead 核对制品、证据和裁决链",
        args: { task_id: taskId, work_item_id: workItemId, limit: tool.schema.number().int().positive().max(200).optional() },
        async execute(args) {
          return json(await adapter.messages({ taskId: args.task_id, workItemId: args.work_item_id, limit: args.limit }))
        },
      }),
      team_work_stop: tool({
        description: "停止指定受管团队 child session，不改变 Runtime 验收状态",
        args: { task_id: taskId, work_item_id: workItemId },
        async execute(args) {
          return json(await adapter.stop({ taskId: args.task_id, workItemId: args.work_item_id }))
        },
      }),
    },
  }
}

export default TeamWorkPlugin
