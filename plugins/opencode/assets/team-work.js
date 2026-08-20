import { tool } from "@opencode-ai/plugin"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { createOpenCodeExecutionAdapter, createOpenCodeRuntimeHost } from "../team-work/lib/plugins/opencode/adapter/index.mjs"
import { createOpenCodeContextHooks } from "../team-work/lib/plugins/opencode/context/index.mjs"
import { createOpenCodeHooks } from "../team-work/lib/plugins/opencode/context/hooks.mjs"
import { createOpenCodeToolHandlers, TOOL_DESCRIPTIONS } from "../team-work/lib/plugins/opencode/tools/index.mjs"
import { createOpenSpecProvider } from "../team-work/lib/spec-providers/openspec/index.mjs"
import { loadOpenCodeActivation } from "../team-work/opencode-activation.mjs"
import { applyOpenCodeAgentConfig, resolveEffectivePlatformProfile } from "../team-work/opencode-agent-config.mjs"
import { loadUserConfig, resolveUserConfigRoot } from "../team-work/installer/user-config.mjs"

const json = (value) => `${JSON.stringify(value, null, 2)}\n`
const platformRoot = fileURLToPath(new URL("../team-work/", import.meta.url))
const runtimeRoot = fileURLToPath(new URL("../team-work/lib/", import.meta.url))

function projectRoot({ directory, worktree }) {
  const selected = worktree && path.parse(path.resolve(worktree)).root !== path.resolve(worktree) ? worktree : directory
  return path.resolve(selected)
}

async function loadJson(relativePath) {
  return JSON.parse(await readFile(path.join(runtimeRoot, relativePath), "utf8"))
}

async function roleGuides() {
  return Object.fromEntries(await Promise.all(["owner", "challenger", "expert"].map(async (role) => [
    role,
    await readFile(path.join(runtimeRoot, "team-work", "prompts", `${role}.md`), "utf8"),
  ])))
}

function toolSchemas() {
  const stage = tool.schema.enum(["research", "design", "design-review", "spec", "spec-review", "implementation", "test", "code-review", "e2e", "finish"])
  const artifact = tool.schema.object({ kind: tool.schema.string().min(1), path: tool.schema.string().min(1) })
  const reportArtifact = tool.schema.object({ ref: tool.schema.string().min(1), path: tool.schema.string().min(1) })
  const check = tool.schema.object({ name: tool.schema.string().min(1), result: tool.schema.enum(["pass", "fail", "not-run"]), evidence_ref: tool.schema.string().min(1).optional() })
  const finding = tool.schema.object({ severity: tool.schema.enum(["info", "risk", "blocker"]), statement: tool.schema.string().min(1), evidence_refs: tool.schema.array(tool.schema.string().min(1)).default([]) })
  const verdict = tool.schema.object({
    outcome: tool.schema.enum(["accept", "rework", "choose-option", "need-more-evidence", "escalate-to-user"]),
    rationale: tool.schema.string().min(1),
    evidence_refs: tool.schema.array(tool.schema.string().min(1)).default([]),
    affected_scope: tool.schema.array(tool.schema.string().min(1)).default([]),
    risks: tool.schema.array(tool.schema.string()).default([]),
    confidence: tool.schema.enum(["low", "medium", "high"]),
    recommended_action: tool.schema.string().min(1),
  })
  return { stage, artifact, reportArtifact, check, finding, verdict }
}

export const TeamWorkPlugin = async ({ client, directory, worktree }) => {
  const root = projectRoot({ directory, worktree })
  const loaded = await loadOpenCodeActivation(() => loadUserConfig({ configRoot: resolveUserConfigRoot() }))
  if (!loaded) return {}
  const profile = JSON.parse(await readFile(path.join(platformRoot, "profile.json"), "utf8"))
  const effectiveProfile = resolveEffectivePlatformProfile(profile, loaded.config)
  const workflowDefinition = await loadJson("workflow/definitions/engineering.json")
  const teamPolicy = await loadJson("team-work/policies/default.json")
  const executionAdapter = createOpenCodeExecutionAdapter({ client, projectRoot: root, platformProfile: effectiveProfile })
  const specProviderAdapter = loaded.platform.specMode === "disabled" ? undefined : createOpenSpecProvider({ projectRoot: root, command: loaded.platform.openspecCommand })
  const runtimeHost = createOpenCodeRuntimeHost({
    projectRoot: root,
    executionAdapter,
    specProviderAdapter,
    workflowDefinition,
    teamPolicy,
    roleGuides: await roleGuides(),
    routeConfig: { spec: { mode: loaded.platform.specMode }, e2e: { mode: "auto" } },
  })
  const contextHooks = createOpenCodeContextHooks({ runtimeHost })
  const hooks = createOpenCodeHooks({ executionAdapter, contextHooks, runtimeHost })
  const handlers = createOpenCodeToolHandlers({ runtimeHost })
  const schema = toolSchemas()

  return {
    config: async (config) => applyOpenCodeAgentConfig(config, { profile, userConfig: loaded.config }),
    event: async (input) => { try { await hooks.event(input) } catch { /* durable reconciliation handles missed host events */ } },
    "tool.execute.before": hooks["tool.execute.before"],
    "tool.execute.after": hooks["tool.execute.after"],
    "experimental.chat.system.transform": hooks["experimental.chat.system.transform"],
    "experimental.session.compacting": hooks["experimental.session.compacting"],
    "experimental.compaction.autocontinue": hooks["experimental.compaction.autocontinue"],
    tool: {
      workflow_open: tool({
        description: TOOL_DESCRIPTIONS.workflow_open,
        args: {
          task_id: tool.schema.string().min(1).optional(), title: tool.schema.string().min(1).optional(), objective: tool.schema.string().min(1).optional(),
          entry_stage: schema.stage.optional(), completion_mode: tool.schema.enum(["workflow", "through-stage"]).default("workflow"), completion_stage: schema.stage.optional(),
          existing_artifacts: tool.schema.array(schema.artifact).default([]),
        },
        execute: async (args, context) => json(await handlers.workflow_open(args, context)),
      }),
      workflow_plan: tool({
        description: TOOL_DESCRIPTIONS.workflow_plan,
        args: {
          objective: tool.schema.string().min(1), constraints: tool.schema.array(tool.schema.string().min(1)).optional(), exclusions: tool.schema.array(tool.schema.string().min(1)).optional(),
          execution: tool.schema.enum(["auto", "solo", "team"]).default("auto"), budget: tool.schema.enum(["economy", "balanced", "quality"]).default("balanced"), risk: tool.schema.enum(["normal", "high", "critical"]).default("normal"),
        },
        execute: async (args, context) => json(await handlers.workflow_plan(args, context)),
      }),
      workflow_run: tool({ description: TOOL_DESCRIPTIONS.workflow_run, args: {}, execute: async (args, context) => json(await handlers.workflow_run(args, context)) }),
      workflow_steer: tool({
        description: TOOL_DESCRIPTIONS.workflow_steer,
        args: {
          action: tool.schema.enum([
            "choose", "owner-explain", "owner-rework", "collect-evidence", "challenge-again",
            "expert-arbitrate", "second-expert-opinion", "replace-owner", "replan", "escalate-to-user",
          ]), directive: tool.schema.string().min(1),
          target_ref: tool.schema.string().min(1).optional(), reference_refs: tool.schema.array(tool.schema.string().min(1)).optional(), note: tool.schema.string().optional(),
        },
        execute: async (args, context) => json(await handlers.workflow_steer(args, context)),
      }),
      team_work_report: tool({
        description: TOOL_DESCRIPTIONS.team_work_report,
        args: {
          outcome: tool.schema.enum(["delivered", "rework", "blocked", "needs-user"]), summary: tool.schema.string().min(1),
          artifacts: tool.schema.array(schema.reportArtifact).default([]), evidence_refs: tool.schema.array(tool.schema.string().min(1)).default([]), unresolved: tool.schema.array(tool.schema.string().min(1)).optional(),
          checks: tool.schema.array(schema.check).optional(), findings: tool.schema.array(schema.finding).optional(), recommendation: tool.schema.enum(["accept", "rework", "escalate"]),
          workflow_outcome: tool.schema.string().regex(/^[a-z][a-z0-9-]*$/).optional(), verdict: schema.verdict.optional(),
        },
        execute: async (args, context) => json(await handlers.team_work_report(args, context)),
      }),
      ...(loaded.config.helper ? {
        team_work_assist: tool({
          description: "受管成员非阻塞创建临时只读 explore/librarian Helper。",
          args: { kind: tool.schema.enum(["explore", "librarian"]), prompt: tool.schema.string().min(1), title: tool.schema.string().optional() },
          execute: async (args, context) => json(await executionAdapter.assist({ parentSessionId: context.sessionID, ...args })),
        }),
        team_work_assist_status: tool({
          description: "读取当前成员创建的只读 Helper 状态。",
          args: { session_id: tool.schema.string().min(1) },
          execute: async (args, context) => json(await executionAdapter.assistStatus({ parentSessionId: context.sessionID, sessionId: args.session_id })),
        }),
        team_work_assist_collect: tool({
          description: "收集当前成员创建的只读 Helper 输出，供成员核验后整合。",
          args: { session_id: tool.schema.string().min(1), limit: tool.schema.number().int().positive().max(200).optional() },
          execute: async (args, context) => json(await executionAdapter.assistMessages({ parentSessionId: context.sessionID, sessionId: args.session_id, limit: args.limit })),
        }),
      } : {}),
    },
  }
}

export default TeamWorkPlugin
