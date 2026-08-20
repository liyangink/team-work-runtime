import assert from "node:assert/strict"
import test from "node:test"

import { applyOpenCodeAgentConfig, resolveEffectivePlatformProfile } from "../plugins/opencode/src/agent-config.mjs"

const profile = {
  agents: [
    { id: "junior-flash", tier: "junior", costWeight: 1, resolvedModel: "gateway/deepseek-v4-flash" },
    { id: "senior-terra", tier: "senior", costWeight: 10, resolvedModel: "gateway/gpt-5.6-terra" },
    { id: "expert-opus", tier: "expert", costWeight: 50, resolvedModel: null },
  ],
  helpers: [
    { id: "team-work-explore", kind: "explore", resolvedModel: null, capabilities: ["unavailable"] },
    { id: "team-work-librarian", kind: "librarian", resolvedModel: null, capabilities: ["unavailable"] },
  ],
}

const leadTools = ["workflow_open", "workflow_plan", "workflow_run", "workflow_steer"]
const memberTools = ["team_work_report", "team_work_assist", "team_work_assist_status", "team_work_assist_collect"]

function permissionMap(permission) {
  return typeof permission === "string" ? { "*": permission } : permission ?? {}
}

function effectivePermission(config, agentId) {
  return {
    ...permissionMap(config.permission),
    ...permissionMap(config.agent?.[agentId]?.permission),
  }
}

function assertPermissions(permission, entries) {
  for (const [tool, expected] of Object.entries(entries)) assert.equal(permission[tool], expected, tool)
}

test("explicit user agents become restart-time OpenCode subagent configuration", () => {
  const config = { agent: { build: { mode: "primary" } } }
  const configured = applyOpenCodeAgentConfig(config, {
    profile,
    userConfig: {
      agents: {
        "junior-flash": { model: "aigw/deepseek-v4-flash", effort: "low" },
        "expert-opus": { model: "official/claude-opus-5", effort: "high" },
      },
    },
  })

  assert.deepEqual(configured, ["junior-flash", "expert-opus"])
  assert.equal(config.agent.build.mode, "primary")
  assert.deepEqual(config.agent["expert-opus"], {
    description: "Team-work Expert 通用成员；成本档位 50，具体分工由团队场景决定。",
    mode: "subagent",
    model: "official/claude-opus-5",
    reasoningEffort: "high",
    prompt: "你是 Team-work 的 Expert 通用成员。只执行派单中明确的范围、完成条件、制品路径和验证要求；事实与证据优先，完成后必须调用 team_work_report。不要自行组建下级团队。",
    permission: {
      task: "deny",
      team_work_assist: "deny",
      team_work_assist_status: "deny",
      team_work_assist_collect: "deny",
      team_work_report: "allow",
      workflow_open: "deny",
      workflow_plan: "deny",
      workflow_run: "deny",
      workflow_steer: "deny",
    },
  })
})

test("automatic user config exposes only models resolved in the installed profile", () => {
  const config = {}
  const configured = applyOpenCodeAgentConfig(config, { profile, userConfig: { agents: "auto" } })

  assert.deepEqual(configured, ["junior-flash", "senior-terra"])
  assert.equal(config.agent["junior-flash"].model, "gateway/deepseek-v4-flash")
  assert.equal(config.agent["expert-opus"], undefined)
})

test("merged OpenCode permissions keep every Lead on the four-tool control plane", () => {
  const config = {
    permission: "allow",
    default_agent: "default-lead",
    agent: {
      build: { mode: "primary", permission: { bash: "ask", team_work_report: "allow" } },
      plan: { mode: "primary", permission: { team_work_assist: "allow" } },
      "default-lead": { permission: "allow" },
      "custom-lead": { mode: "primary", permission: { workflow_open: "deny", team_work_assist_collect: "allow" } },
      "custom-subagent": { mode: "subagent", permission: { read: "allow" } },
    },
  }

  applyOpenCodeAgentConfig(config, { profile, userConfig: { agents: "auto" } })

  assert.equal(config.permission["*"], "allow")
  assertPermissions(config.permission, {
    ...Object.fromEntries(leadTools.map((tool) => [tool, "deny"])),
    ...Object.fromEntries(memberTools.map((tool) => [tool, "deny"])),
  })
  for (const id of ["build", "plan", "default-lead", "custom-lead"]) {
    assertPermissions(effectivePermission(config, id), {
      ...Object.fromEntries(leadTools.map((tool) => [tool, "allow"])),
      ...Object.fromEntries(memberTools.map((tool) => [tool, "deny"])),
    })
  }
  assert.equal(effectivePermission(config, "build").bash, "ask")
  assertPermissions(effectivePermission(config, "custom-subagent"), {
    ...Object.fromEntries(leadTools.map((tool) => [tool, "deny"])),
    ...Object.fromEntries(memberTools.map((tool) => [tool, "deny"])),
  })
  assertPermissions(effectivePermission(config, "junior-flash"), {
    ...Object.fromEntries(leadTools.map((tool) => [tool, "deny"])),
    team_work_report: "allow",
    team_work_assist: "deny",
    team_work_assist_status: "deny",
    team_work_assist_collect: "deny",
  })
})

test("one independent helper binding creates two hidden read-only assistants", () => {
  const config = {}
  const configured = applyOpenCodeAgentConfig(config, {
    profile,
    userConfig: {
      agents: "auto",
      helper: { model: "gateway/deepseek-v4-flash", effort: "low" },
    },
  })

  assert.deepEqual(configured.slice(-2), ["team-work-explore", "team-work-librarian"])
  for (const id of ["team-work-explore", "team-work-librarian"]) {
    assert.equal(config.agent[id].model, "gateway/deepseek-v4-flash")
    assert.equal(config.agent[id].reasoningEffort, "low")
    assert.equal(config.agent[id].mode, "subagent")
    assert.equal(config.agent[id].hidden, true)
    assert.equal(config.agent[id].permission.edit, "deny")
    assert.equal(config.agent[id].permission.apply_patch, "deny")
    assert.equal(config.agent[id].permission.shell, "deny")
    assert.equal(config.agent[id].permission.bash, "deny")
    assert.equal(config.agent[id].permission.task, "deny")
    assert.equal(config.agent[id].permission.team_work_assist, "deny")
    assert.equal(config.agent[id].permission.team_work_report, "deny")
    assert.equal(config.agent[id].permission.workflow_run, "deny")
  }
  assert.notEqual(config.agent["team-work-explore"].prompt, config.agent["team-work-librarian"].prompt)
  assert.equal(config.agent["team-work-explore"].permission.webfetch, "deny")
  assert.equal(config.agent["team-work-librarian"].permission.webfetch, "allow")
  assert.equal(config.agent["junior-flash"].permission.team_work_assist, "allow")
  assert.equal(config.agent["junior-flash"].permission.team_work_report, "allow")
  assertPermissions(effectivePermission(config, "junior-flash"), {
    ...Object.fromEntries(leadTools.map((tool) => [tool, "deny"])),
    ...Object.fromEntries(memberTools.map((tool) => [tool, "allow"])),
  })
  for (const id of ["team-work-explore", "team-work-librarian"]) {
    assertPermissions(effectivePermission(config, id), {
      ...Object.fromEntries(leadTools.map((tool) => [tool, "deny"])),
      ...Object.fromEntries(memberTools.map((tool) => [tool, "deny"])),
    })
  }
})

test("dynamic agent configuration rejects names outside the installed catalog", () => {
  assert.throws(
    () => applyOpenCodeAgentConfig({}, { profile, userConfig: { agents: { rogue: { model: "gateway/rogue" } } } }),
    (error) => error.code === "AGENT_CONFIG_INVALID" && /rogue/.test(error.message),
  )
})

test("explicit restart-time bindings replace stale installed model availability in the effective profile", () => {
  const effective = resolveEffectivePlatformProfile(profile, {
    agents: { "expert-opus": { model: "official/claude-opus-5", effort: "high" } },
  })

  assert.equal(effective.agents.find(({ id }) => id === "expert-opus").resolvedModel, "official/claude-opus-5")
  assert.deepEqual(effective.agents.find(({ id }) => id === "expert-opus").capabilities, ["general"])
  assert.equal(effective.agents.find(({ id }) => id === "junior-flash").resolvedModel, null)
})

test("effective profile advertises the independently configured helper model", () => {
  const effective = resolveEffectivePlatformProfile(profile, {
    agents: "auto",
    helper: { model: "gateway/deepseek-v4-flash", effort: "low" },
  })

  assert.deepEqual(effective.helpers, [
    {
      id: "team-work-explore",
      kind: "explore",
      resolvedModel: "gateway/deepseek-v4-flash",
      capabilities: ["read-only", "code-search"],
    },
    {
      id: "team-work-librarian",
      kind: "librarian",
      resolvedModel: "gateway/deepseek-v4-flash",
      capabilities: ["read-only", "web-research"],
    },
  ])
})

test("startup rejects duplicate or mismatched helper catalog entries", () => {
  const duplicate = structuredClone(profile)
  duplicate.helpers.push({ ...duplicate.helpers[0] })
  assert.throws(
    () => resolveEffectivePlatformProfile(duplicate, { agents: "auto" }),
    (error) => error.code === "AGENT_CONFIG_INVALID" && /重复/.test(error.message),
  )

  const mismatched = structuredClone(profile)
  mismatched.helpers[0].kind = "librarian"
  assert.throws(
    () => applyOpenCodeAgentConfig({}, { profile: mismatched, userConfig: { agents: "auto" } }),
    (error) => error.code === "AGENT_CONFIG_INVALID" && /不匹配/.test(error.message),
  )
})
