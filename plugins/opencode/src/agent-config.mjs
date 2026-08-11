class AgentConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = "AgentConfigError"
    this.code = "AGENT_CONFIG_INVALID"
  }
}

const tierName = { junior: "Junior", senior: "Senior", expert: "Expert" }

function definition(agent, binding) {
  const tier = tierName[agent.tier] ?? agent.tier
  return {
    description: `Team-work ${tier} 通用成员；成本档位 ${agent.costWeight}，具体分工由团队场景决定。`,
    mode: "subagent",
    model: binding.model,
    ...(binding.effort === undefined ? {} : { reasoningEffort: binding.effort }),
    prompt: `你是 Team-work 的 ${tier} 通用成员。只执行派单中明确的范围、完成条件、制品路径和验证要求；事实与证据优先，发现缺口及时报告。不要自行组建下级团队。`,
    permission: {
      task: "deny",
      team_work_spawn: "deny",
      team_work_resume: "deny",
      team_work_stop: "deny",
    },
  }
}

function resolveBindings(profile, userConfig) {
  if (!profile || !Array.isArray(profile.agents)) {
    throw new AgentConfigError("OpenCode 配置或 Platform Profile 无效")
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
  if (userConfig.agents === "auto") return structuredClone(profile)
  const resolved = new Map(bindings.map(([id, binding]) => [id, binding.model]))
  return {
    ...structuredClone(profile),
    agents: profile.agents.map((agent) => ({
      ...agent,
      resolvedModel: resolved.get(agent.id) ?? null,
      capabilities: resolved.has(agent.id) ? ["general"] : ["unavailable"],
    })),
  }
}

export function applyOpenCodeAgentConfig(config, { profile, userConfig }) {
  if (!config || typeof config !== "object") throw new AgentConfigError("OpenCode 配置或 Platform Profile 无效")
  const { bindings, catalog } = resolveBindings(profile, userConfig)

  config.agent ??= {}
  for (const [id, binding] of bindings) config.agent[id] = definition(catalog.get(id), binding)
  return bindings.map(([id]) => id)
}

export { AgentConfigError }
