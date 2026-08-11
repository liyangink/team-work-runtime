import { tool } from "@opencode-ai/plugin"
import { createOpenCodeAdapter } from "../team-work/opencode-adapter.mjs"

const json = (value) => `${JSON.stringify(value, null, 2)}\n`

export const TeamWorkPlugin = async ({ client, directory, worktree }) => {
  const adapter = createOpenCodeAdapter({ client, projectRoot: worktree || directory })
  const taskId = tool.schema.string().describe("稳定的 team-work task id")
  const workItemId = tool.schema.string().describe("稳定的 Runtime work item id")
  const prompt = tool.schema.string().describe("成员本轮任务、范围、完成条件、制品路径和证据要求")
  const runtimeCommands = [
    "init", "doctor", "version", "migrate",
    "task.create", "task.bind", "task.show", "task.team", "task.spec", "task.await", "task.resume", "task.complete", "task.cancel", "task.archive",
    "context.register", "context.list", "context.render", "context.rebuild",
    "flow.status", "flow.check", "flow.advance", "flow.rollback", "flow.decide",
    "work.create", "work.start", "work.submit", "work.accept", "work.rework", "work.block", "work.cancel", "work.show",
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
    "tool.execute.before": async (input) => {
      if (input.tool !== "task") return
      if (await adapter.isManagedTeamSession(input.sessionID)) {
        throw new Error("TEAM_WORK_BLOCKING_TASK_REJECTED: team 任务必须使用 team_work_spawn 的非阻塞 child session")
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
        description: "以稳定 JSON Interface 调用项目 CoreRuntime；用于任务、上下文、流程、门禁和 work item 状态，不执行任意 shell",
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
      team_work_spawn: tool({
        description: "非阻塞创建受管 OpenCode child session 并派发团队 work item",
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
        description: "非阻塞续派已有团队 child session，用于返工和多轮收敛",
        args: { task_id: taskId, work_item_id: workItemId, prompt },
        async execute(args) {
          return json(await adapter.resume({ taskId: args.task_id, workItemId: args.work_item_id, prompt: args.prompt }))
        },
      }),
      team_work_status: tool({
        description: "查询受管团队 child session 状态，不阻塞 Lead",
        args: { task_id: taskId, work_item_id: workItemId },
        async execute(args) {
          return json(await adapter.status({ taskId: args.task_id, workItemId: args.work_item_id }))
        },
      }),
      team_work_collect: tool({
        description: "在同步点读取受管团队 child session 消息并由 Lead 验收",
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
