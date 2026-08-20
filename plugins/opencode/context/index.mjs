const roleName = { owner: "Owner", challenger: "Challenger", expert: "Expert", helper: "Helper" }

function leadContext(binding) {
  return [
    "# Team-work Lead",
    `当前任务：${binding.title}（${binding.taskId}）`,
    `当前阶段：${binding.stage}；状态：${binding.status}`,
    `任务制品目录：${binding.taskRoot}`,
    "你只负责推进流程、呈现制品与分歧、转发具体问题；不要亲自承担成员工作或技术裁决。",
    "严格按 ActionCard 的唯一下一步调用 workflow_plan、workflow_run 或 workflow_steer；需要打开任务时使用 workflow_open。",
    "向用户只说完成内容、当前阶段、关键制品、风险/分歧和下一步，不解释 Runtime 内部字段。",
  ].join("\n")
}

function memberContext(binding) {
  return [
    `# Team-work ${roleName[binding.role] ?? binding.role}`,
    `任务：${binding.taskId}；阶段：${binding.stage}；Assignment：${binding.assignmentId}`,
    `上下文：${binding.contextRef}`,
    `派单：${binding.promptRef}`,
    "只处理当前派单。需要细节时读取上述文件和其中引用，不接管 Lead 流程。",
    "完成后先自检，再调用 team_work_report；不要用普通消息冒充交付，也不要等待 Lead 轮询。",
  ].join("\n")
}

function helperContext(binding) {
  return [
    "# Team-work 只读 Assistant",
    `父成员：${binding.parentSessionRef}；类型：${binding.helperKind}`,
    "仅完成窄范围探索或资料检索。禁止修改文件、执行命令、继续委托或作最终裁决。",
  ].join("\n")
}

export function createOpenCodeContextHooks({ runtimeHost } = {}) {
  if (!runtimeHost || typeof runtimeHost.describeSession !== "function") throw new TypeError("runtimeHost.describeSession is required")
  return Object.freeze({
    async contextForSession(sessionId) {
      const binding = await runtimeHost.describeSession(sessionId)
      if (!binding) return null
      if (binding.kind === "lead") return leadContext(binding)
      if (binding.kind === "member") return memberContext(binding)
      if (binding.kind === "helper") return helperContext(binding)
      return null
    },
  })
}
