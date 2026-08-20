class AgentConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = "AgentConfigError"
    this.code = "AGENT_CONFIG_INVALID"
  }
}

const roleNames = { junior: "Junior", senior: "Senior", expert: "Expert", challenger: "Challenger" }
export const MEMBER_ROLES = ["junior", "senior", "expert", "challenger"]
export const ROLE_TIER = { junior: "junior", senior: "senior", expert: "expert", challenger: "senior" }
export const ROLE_WEIGHT = { junior: 1, senior: 10, challenger: 10, expert: 50 }
const ALL_ROLES = new Set([...MEMBER_ROLES, "assistant"])
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

const leadPermissions = Object.freeze({
  workflow_open: "allow",
  workflow_plan: "allow",
  workflow_run: "allow",
  workflow_steer: "allow",
  team_work_report: "deny",
  team_work_assist: "deny",
  team_work_assist_status: "deny",
  team_work_assist_collect: "deny",
})

const globalTeamWorkPermissions = Object.freeze(Object.fromEntries(
  Object.keys(leadPermissions).map((tool) => [tool, "deny"]),
))

const managedMemberPermissions = Object.freeze({
  workflow_open: "deny",
  workflow_plan: "deny",
  workflow_run: "deny",
  workflow_steer: "deny",
  team_work_report: "allow",
})

const helperTeamWorkPermissions = Object.freeze(Object.fromEntries(
  Object.keys(leadPermissions).map((tool) => [tool, "deny"]),
))

function permissionMap(permission) {
  if (typeof permission === "string") return { "*": permission }
  return permission && typeof permission === "object" && !Array.isArray(permission) ? permission : {}
}

function mergePermissions(permission, overrides) {
  return { ...permissionMap(permission), ...overrides }
}

function configureLeads(config) {
  config.permission = mergePermissions(config.permission, globalTeamWorkPermissions)
  config.agent ??= {}

  const leadIds = new Set(["build", "plan"])
  if (typeof config.default_agent === "string" && config.default_agent) leadIds.add(config.default_agent)
  for (const [id, agent] of Object.entries(config.agent)) {
    if (agent?.mode === "primary") leadIds.add(id)
  }
  for (const id of leadIds) {
    const agent = config.agent[id]
    config.agent[id] = {
      ...(agent && typeof agent === "object" ? agent : {}),
      permission: mergePermissions(agent?.permission, leadPermissions),
    }
  }
}

function definition(agent, binding, assistantEnabled) {
  const role = roleNames[agent.role] ?? roleNames[agent.tier] ?? agent.role ?? agent.tier
  return {
    description: `Team-work ${role} 通用成员；成本档位 ${agent.costWeight ?? ROLE_WEIGHT[agent.tier] ?? agent.tier}，具体分工由团队场景决定。`,
    mode: "subagent",
    model: binding.model,
    ...(binding.effort === undefined ? {} : { reasoningEffort: binding.effort }),
    prompt: `你是 Team-work 的 ${role} 通用成员。只执行派单中明确的范围、完成条件、制品路径和验证要求；事实与证据优先，完成后必须调用 team_work_report。${assistantEnabled ? "不得自行组建下级团队；仅在并行检索确有价值时，使用 team_work_assist 调用只读 explore 或 librarian 助手，并自行核验与整合结果。" : "不要自行组建下级团队。"}`,
    permission: {
      task: "deny",
      team_work_assist: assistantEnabled ? "allow" : "deny",
      team_work_assist_status: assistantEnabled ? "allow" : "deny",
      team_work_assist_collect: assistantEnabled ? "allow" : "deny",
      ...managedMemberPermissions,
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
    tools: { edit: false, write: false, apply_patch: false, shell: false, patch: false, bash: false, task: false },
    permission: {
      edit: "deny",
      apply_patch: "deny",
      shell: "deny",
      bash: "deny",
      task: "deny",
      external_directory: "deny",
      todowrite: "deny",
      question: "deny",
      skill: "deny",
      webfetch: helper.web,
      websearch: helper.web,
      ...helperTeamWorkPermissions,
    },
  }
}

export function staticRole(agent) {
  return agent.role ?? agent.tier
}

// 将用户配置的显式 agents 条目解析为成员目录与 assistant 绑定。
// 条目带 role 时按 role 建目录；与静态目录同名的无 role 条目保持“改模型”语义；
// 未知 id 且无 role 时给出必须声明 role 的明确错误。
export function resolveConfiguredAgents(staticAgents, explicitEntries) {
  if (!Array.isArray(staticAgents)) throw new AgentConfigError("静态 Agent 目录无效")
  if (!explicitEntries || typeof explicitEntries !== "object" || Array.isArray(explicitEntries)) {
    throw new AgentConfigError("agents 显式配置必须是对象")
  }
  const staticById = new Map(staticAgents.map((agent) => [agent.id, agent]))
  const members = []
  const assistants = []
  for (const [id, entry] of Object.entries(explicitEntries)) {
    const declared = entry?.role
    const inherited = staticById.get(id)
    const role = declared ?? (inherited ? staticRole(inherited) : undefined)
    if (!role) {
      throw new AgentConfigError(`自定义 Agent ${id} 必须声明 role（junior|senior|expert|challenger|assistant）`)
    }
    if (!ALL_ROLES.has(role)) throw new AgentConfigError(`Agent ${id} 的 role 无效：${role}`)
    if (typeof entry?.model !== "string" || !/^[^\s/]+\/.+/.test(entry.model)) {
      throw new AgentConfigError(`Agent ${id} 必须映射为 provider/model`)
    }
    const binding = { model: entry.model, ...(entry.effort === undefined ? {} : { effort: entry.effort }) }
    if (role === "assistant") assistants.push({ id, binding })
    else {
      const tier = ROLE_TIER[role]
      members.push({
        id,
        role,
        tier,
        requestedModel: entry.model,
        costWeight: inherited && staticRole(inherited) === role ? inherited.costWeight : ROLE_WEIGHT[tier],
        binding,
      })
    }
  }
  const sorted = (entries) => [...entries].sort((left, right) => left.id.localeCompare(right.id))
  // 与静态目录同名的条目保持 profile 顺序，保证旧任务钉住的能力快照 digest 可复现；
  // 新增 role 条目按 id 稳定追加在静态条目之后。
  const staticOrder = new Map(staticAgents.map((agent, index) => [agent.id, index]))
  members.sort((left, right) => {
    const leftIndex = staticOrder.get(left.id)
    const rightIndex = staticOrder.get(right.id)
    if (leftIndex !== undefined && rightIndex !== undefined) return leftIndex - rightIndex
    if (leftIndex !== undefined) return -1
    if (rightIndex !== undefined) return 1
    return left.id.localeCompare(right.id)
  })
  const explicitAssistant = sorted(assistants)[0]
  const juniorFallback = sorted(members.filter((member) => member.role === "junior"))[0]
  const assistant = explicitAssistant
    ?? (juniorFallback ? { id: juniorFallback.id, binding: juniorFallback.binding } : null)
  return { members, assistants: sorted(assistants), assistant }
}

function validateProfile(profile) {
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
}

export function resolveEffectivePlatformProfile(profile, userConfig) {
  validateProfile(profile)
  const effective = structuredClone(profile)
  if (userConfig.agents !== "auto" && userConfig.agents !== undefined) {
    const { members, assistant } = resolveConfiguredAgents(profile.agents, userConfig.agents)
    effective.agents = members.map((member) => ({
      id: member.id,
      role: member.role,
      tier: member.tier,
      requestedModel: member.requestedModel,
      resolvedModel: member.binding.model,
      costWeight: member.costWeight,
      capabilities: ["general"],
    }))
    if (assistant) effective.assistantBinding = assistant.binding
  } else {
    effective.agents = effective.agents.map((agent) => ({ ...agent, role: staticRole(agent) }))
    const junior = [...effective.agents]
      .filter((agent) => agent.resolvedModel && staticRole(agent) === "junior")
      .sort((left, right) => left.id.localeCompare(right.id))[0]
    if (junior) effective.assistantBinding = { model: junior.resolvedModel }
  }
  if (Array.isArray(effective.helpers)) {
    const binding = effective.assistantBinding ?? null
    effective.helpers = effective.helpers.map((helper) => ({
      ...helper,
      resolvedModel: binding?.model ?? null,
      capabilities: binding ? ["read-only", helper.kind === "explore" ? "code-search" : "web-research"] : ["unavailable"],
    }))
  }
  return effective
}

export function applyOpenCodeAgentConfig(config, { profile, userConfig }) {
  if (!config || typeof config !== "object") throw new AgentConfigError("OpenCode 配置或 Platform Profile 无效")
  validateProfile(profile)

  configureLeads(config)
  let memberBindings
  let assistantBinding
  if (userConfig.agents !== "auto" && userConfig.agents !== undefined) {
    const resolved = resolveConfiguredAgents(profile.agents, userConfig.agents)
    memberBindings = resolved.members.map((member) => [
      member.id,
      {
        agent: { id: member.id, role: member.role, tier: member.tier, costWeight: member.costWeight },
        binding: member.binding,
      },
    ])
    assistantBinding = resolved.assistant?.binding ?? null
  } else {
    memberBindings = profile.agents
      .filter(({ resolvedModel }) => resolvedModel)
      .map((agent) => [agent.id, { agent, binding: { model: agent.resolvedModel } }])
    // auto 模式下 assistant 回退 junior：取 id 排序后第一个已解析的 junior 成员
    const juniorBinding = profile.agents
      .filter((agent) => agent.resolvedModel && staticRole(agent) === "junior")
      .sort((left, right) => left.id.localeCompare(right.id))[0]
    assistantBinding = juniorBinding ? { model: juniorBinding.resolvedModel } : null
  }
  for (const [id, { agent, binding }] of memberBindings) config.agent[id] = definition(agent, binding, Boolean(assistantBinding))
  if (assistantBinding) {
    for (const [id, helper] of Object.entries(helperAgents)) config.agent[id] = helperDefinition(helper, assistantBinding)
  }
  return [...memberBindings.map(([id]) => id), ...(assistantBinding ? Object.keys(helperAgents) : [])]
}

export { AgentConfigError }
