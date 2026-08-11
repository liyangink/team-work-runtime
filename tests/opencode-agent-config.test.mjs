import assert from "node:assert/strict"
import test from "node:test"

import { applyOpenCodeAgentConfig, resolveEffectivePlatformProfile } from "../plugins/opencode/src/agent-config.mjs"

const profile = {
  agents: [
    { id: "junior-flash", tier: "junior", costWeight: 1, resolvedModel: "gateway/deepseek-v4-flash" },
    { id: "senior-terra", tier: "senior", costWeight: 10, resolvedModel: "gateway/gpt-5.6-terra" },
    { id: "expert-opus", tier: "expert", costWeight: 50, resolvedModel: null },
  ],
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
    prompt: "你是 Team-work 的 Expert 通用成员。只执行派单中明确的范围、完成条件、制品路径和验证要求；事实与证据优先，发现缺口及时报告。不要自行组建下级团队。",
    permission: { task: "deny", team_work_spawn: "deny", team_work_resume: "deny", team_work_stop: "deny" },
  })
})

test("automatic user config exposes only models resolved in the installed profile", () => {
  const config = {}
  const configured = applyOpenCodeAgentConfig(config, { profile, userConfig: { agents: "auto" } })

  assert.deepEqual(configured, ["junior-flash", "senior-terra"])
  assert.equal(config.agent["junior-flash"].model, "gateway/deepseek-v4-flash")
  assert.equal(config.agent["expert-opus"], undefined)
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
