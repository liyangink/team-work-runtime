import path from "node:path"

const helperDenied = new Set(["edit", "write", "apply_patch", "shell", "task", "todowrite"])
const fileWriteTools = new Set(["edit", "write", "apply_patch"])

function pendingTodos(args) {
  return (args?.todos ?? []).some(({ status }) => status !== "completed" && status !== "cancelled")
}

function normalizeProjectPath(value, projectRoot) {
  let candidate = String(value).trim().replace(/^\.\//, "")
  if (projectRoot && path.isAbsolute(candidate)) {
    const relative = path.relative(path.resolve(projectRoot), candidate)
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) candidate = relative
  }
  return path.normalize(candidate).replace(/\\/g, "/")
}

function writeTargets(tool, args = {}) {
  if (tool === "apply_patch") {
    const patch = String(args.patch ?? args.diff ?? args.content ?? "")
    return [...patch.matchAll(/^\*\*\* (?:Update|Add) File: (.+)$/gm)].map(([, file]) => file.trim())
  }
  return [args.filePath ?? args.file ?? args.path].filter((target) => typeof target === "string" && target.trim() !== "")
}

export function createOpenCodeHooks({ executionAdapter, contextHooks, runtimeHost, projectRoot } = {}) {
  if (!executionAdapter || !contextHooks) throw new TypeError("OpenCode hooks require adapter and context hooks")
  return Object.freeze({
    async event({ event }) {
      return executionAdapter.handleEvent(event)
    },

    async "tool.execute.before"(input, output) {
      const helper = await executionAdapter.resolveHelperBinding?.(input.sessionID)
      if (helper && (helperDenied.has(input.tool) || input.tool.startsWith("workflow_") || input.tool.startsWith("team_work_"))) {
        throw new Error("TEAM_WORK_HELPER_READ_ONLY: 只读 Helper 不得修改文件、执行命令、继续委托或控制工作流")
      }
      const member = await executionAdapter.resolveMemberBinding?.(input.sessionID)
      if (member && (input.tool === "task" || input.tool.startsWith("workflow_"))) {
        throw new Error("TEAM_WORK_MEMBER_DELEGATION_REJECTED: 受管成员由 Runtime 后台派发，不得自行创建团队或推进工作流")
      }
      if (member && fileWriteTools.has(input.tool)) {
        // 平台层强制派单写边界：可写制品为空的成员（Challenger/Expert/Owner 回应）
        // 不得修改任何项目文件；有可写制品的成员只能在派单声明的路径内写入。
        const scope = await runtimeHost?.describeSession?.(input.sessionID)
        const writablePaths = scope?.kind === "member" && Array.isArray(scope.writablePaths)
          ? scope.writablePaths.map((target) => normalizeProjectPath(target, projectRoot))
          : null
        const targets = writeTargets(input.tool, input.args ?? output.args).map((target) => normalizeProjectPath(target, projectRoot))
        if (writablePaths === null || targets.length === 0 || targets.some((target) => !writablePaths.includes(target))) {
          const declared = writablePaths?.length ? writablePaths.join("、") : "无（只读派单）"
          throw new Error(`TEAM_WORK_MEMBER_WRITE_OUT_OF_SCOPE: 当前派单的可写制品为${declared}，禁止修改其他项目文件；发现越权写入将恢复最后注册内容`)
        }
      }
      if (member && input.tool === "shell") {
        await executionAdapter.captureCheck({ sessionId: input.sessionID, toolCallRef: input.callID })
      }
      if (!member && !helper && input.tool === "todowrite" && pendingTodos(output.args)) {
        const binding = await runtimeHost?.describeSession(input.sessionID)
        if (binding?.kind === "lead") {
          throw new Error("TEAM_WORK_LEAD_TODO_REJECTED: 受管 Lead 的推进状态由 Runtime 保存，不要创建外部续跑 TODO")
        }
      }
    },

    async "tool.execute.after"(input, output) {
      if (input.tool !== "shell") return
      const member = await executionAdapter.resolveMemberBinding?.(input.sessionID)
      if (!member) return
      await executionAdapter.recordCheck({
        sessionId: input.sessionID,
        toolCallRef: input.callID,
        commandSummary: String(input.args?.command ?? output.title ?? "shell check").slice(0, 500),
        ...(Number.isInteger(output.metadata?.exit) ? { exitCode: output.metadata.exit } : {}),
      })
    },

    async "experimental.chat.system.transform"(input, output) {
      if (!input.sessionID) return
      const context = await contextHooks.contextForSession(input.sessionID)
      if (context) output.system.push(context)
    },

    async "experimental.session.compacting"(input, output) {
      const context = await contextHooks.contextForSession(input.sessionID)
      if (context) output.context.push(context)
    },

    async "experimental.compaction.autocontinue"(input, output) {
      const binding = await runtimeHost?.describeSession(input.sessionID)
      if (binding?.kind === "lead" && binding.status === "awaiting-user") output.enabled = false
    },
  })
}
