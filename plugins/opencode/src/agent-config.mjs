class AgentConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = "AgentConfigError"
    this.code = "AGENT_CONFIG_INVALID"
  }
}

const tierName = { junior: "Junior", senior: "Senior", expert: "Expert" }
const helperKinds = { "team-work-explore": "explore", "team-work-librarian": "librarian" }
const helperAgents = {
  "team-work-explore": {
    description: "Team-work 只读代码探索助手；仅用于检索、调用链和事实定位。",
    prompt: "你是 Team-work 的只读代码探索助手。只执行父成员给出的窄范围检索任务，使用读取、搜索和 LSP 能力返回文件路径、行号、事实与不确定项；禁止修改文件、运行命令、继续委托、询问用户或作最终技术裁决。",
    web: "deny",
  },
  "team-work-librarian": {
    description: "Team-work 只读资料助手；仅用于外部文档和事实检索。",
    prompt: "你是 Team-work 的只读资料助手。只执行父成员给出的窄范围资料检索任务，优先官方和一手来源，返回链接、版本或日期、事实与不确定项；禁止修改文件、运行命令、继续委托、询问用户或作最终技术裁决。",
    web: "allow",
  },
}

function definition(agent, binding, helperEnabled) {
  const tier = tierName[agent.tier] ?? agent.tier
  return {
    description: `Team-work ${tier} 通用成员；成本档位 ${agent.costWeight}，具体分工由团队场景决定。`,
    mode: "subagent",
    model: binding.model,
    ...(binding.effort === undefined ? {} : { reasoningEffort: binding.effort }),
    prompt: `你是 Team-work 的 ${tier} 通用成员。只执行派单中明确的范围、完成条件、制品路径和验证要求；事实与证据优先，发现缺口及时报告。${helperEnabled ? "不得自行组建下级团队；仅在并行检索确有价值时，使用 team_work_assist 调用只读 explore 或 librarian 助手，并自行核验与整合结果。" : "不要自行组建下级团队。"}`,
    permission: {
      task: "deny",
      team_work_assist: helperEnabled ? "allow" : "deny",
      team_work_assist_status: helperEnabled ? "allow" : "deny",
      team_work_assist_collect: helperEnabled ? "allow" : "deny",
      team_work_overview: "deny",
      team_work_begin: "deny",
      team_work_register: "deny",
      team_work_dispatch: "deny",
      team_work_assess: "deny",
      team_work_continue: "deny",
      team_work_review_gate: "deny",
      team_work_sync: "deny",
    },
  }
}

function helperDefinition(helper, binding) {
  return {
    description: helper.description,
    mode: "subagent",
    hidden: true,
    model: binding.model,
    ...(binding.effort === undefined ? {} : { reasoningEffort: binding.effort }),
    prompt: helper.prompt,
    tools: { edit: false, write: false, patch: false, bash: false, task: false },
    permission: {
      edit: "deny",
      bash: "deny",
      task: "deny",
      external_directory: "deny",
      todowrite: "deny",
      question: "deny",
      skill: "deny",
      webfetch: helper.web,
      websearch: helper.web,
      team_work_overview: "deny",
      team_work_begin: "deny",
      team_work_register: "deny",
      team_work_dispatch: "deny",
      team_work_assess: "deny",
      team_work_continue: "deny",
      team_work_review_gate: "deny",
      team_work_sync: "deny",
      team_work_assist: "deny",
      team_work_assist_status: "deny",
      team_work_assist_collect: "deny",
    },
  }
}

function resolveBindings(profile, userConfig) {
  if (!profile || !Array.isArray(profile.agents)) {
    throw new AgentConfigError("OpenCode 配置或 Platform Profile 无效")
  }
  if (profile.helpers !== undefined && !Array.isArray(profile.helpers)) {
    throw new AgentConfigError("Platform Profile helpers 无效")
  }
  const helperIds = (profile.helpers ?? []).map(({ id }) => id)
  const duplicateHelper = helperIds.find((id, index) => helperIds.indexOf(id) !== index)
  if (duplicateHelper) throw new AgentConfigError(`Platform Profile helper 重复：${duplicateHelper}`)
  for (const helper of profile.helpers ?? []) {
    if (helperKinds[helper.id] !== helper.kind) {
      throw new AgentConfigError(`Platform Profile helper id/kind 不匹配：${helper.id}/${helper.kind}`)
    }
  }
  const catalog = new Map(profile.agents.map((agent) => [agent.id, agent]))
  const bindings = userConfig.agents === "auto"
    ? profile.agents.filter(({ resolvedModel }) => resolvedModel).map(({ id, resolvedModel }) => [id, { model: resolvedModel }])
    : Object.entries(userConfig.agents ?? {})
  for (const [id] of bindings) {
    if (!catalog.has(id)) throw new AgentConfigError(`用户配置包含未知 Agent：${id}`)
  }
  return { bindings, catalog }
}

export function resolveEffectivePlatformProfile(profile, userConfig) {
  const { bindings } = resolveBindings(profile, userConfig)
  const effective = structuredClone(profile)
  if (userConfig.agents !== "auto") {
    const resolved = new Map(bindings.map(([id, binding]) => [id, binding.model]))
    effective.agents = profile.agents.map((agent) => ({
      ...agent,
      resolvedModel: resolved.get(agent.id) ?? null,
      capabilities: resolved.has(agent.id) ? ["general"] : ["unavailable"],
    }))
  }
  if (Array.isArray(effective.helpers)) {
    effective.helpers = effective.helpers.map((helper) => ({
      ...helper,
      resolvedModel: userConfig.helper?.model ?? null,
      capabilities: userConfig.helper
        ? ["read-only", helper.kind === "explore" ? "code-search" : "web-research"]
        : ["unavailable"],
    }))
  }
  return effective
}

export function applyOpenCodeAgentConfig(config, { profile, userConfig }) {
  if (!config || typeof config !== "object") throw new AgentConfigError("OpenCode 配置或 Platform Profile 无效")
  const { bindings, catalog } = resolveBindings(profile, userConfig)
  const helperBinding = userConfig.helper

  config.agent ??= {}
  for (const [id, binding] of bindings) config.agent[id] = definition(catalog.get(id), binding, Boolean(helperBinding))
  if (helperBinding) {
    for (const [id, helper] of Object.entries(helperAgents)) config.agent[id] = helperDefinition(helper, helperBinding)
  }
  return [...bindings.map(([id]) => id), ...(helperBinding ? Object.keys(helperAgents) : [])]
}

export { AgentConfigError }
