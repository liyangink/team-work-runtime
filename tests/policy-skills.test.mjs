import assert from "node:assert/strict"
import { access, readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (relativePath) => readFile(path.join(projectRoot, relativePath), "utf8")

const requiredSkillFiles = [
  "skills/workflow/SKILL.md",
  "skills/workflow/agents/openai.yaml",
  "skills/workflow/references/runtime-commands.md",
  "skills/workflow/references/stages-and-artifacts.md",
  "skills/workflow/references/team-and-spec-routing.md",
  "skills/workflow/references/recovery-and-handoff.md",
  "skills/workflow/references/human-review.md",
  "skills/team-work/SKILL.md",
  "skills/team-work/agents/openai.yaml",
  "skills/team-work/references/member-contract.md",
  "skills/team-work/references/topologies.md",
  "skills/team-work/references/artifacts-and-report.md",
  "skills/team-work/references/context-and-sessions.md",
  "skills/team-work/references/solution-discussion.md",
  "skills/team-work/references/code-review.md",
  "skills/team-work/references/parallel-delivery.md",
  "skills/team-work/references/testing.md",
  "skills/team-work/references/recovery.md",
  "skills/team-work/references/evaluation.md",
  "skills/team-work/scripts/select-members.mjs",
]

test("policy skills have complete scaffolds and linked resources", async () => {
  for (const relativePath of requiredSkillFiles) await assert.doesNotReject(access(path.join(projectRoot, relativePath)), relativePath)

  for (const skill of ["workflow", "team-work"]) {
    const skillPath = `skills/${skill}/SKILL.md`
    const content = await read(skillPath)
    assert.doesNotMatch(content, /TODO|\[TODO/)
    assert.match(content, new RegExp(`^---\\nname: ${skill}\\ndescription: .+\\n---`, "s"))
    for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1].split("#", 1)[0]
      if (!target || /^(?:https?:|mailto:)/.test(target)) continue
      await assert.doesNotReject(access(path.resolve(projectRoot, path.dirname(skillPath), target)), `${skillPath} links to missing ${target}`)
    }
  }
})

test("Workflow preserves platform-neutral task, gate, team, and SPEC policy", async () => {
  const skill = await read("skills/workflow/SKILL.md")
  const stages = await read("skills/workflow/references/stages-and-artifacts.md")
  const routing = await read("skills/workflow/references/team-and-spec-routing.md")
  const commands = await read("skills/workflow/references/runtime-commands.md")

  assert.match(skill, /任意阶段/)
  assert.match(skill, /当前阶段.*最低/)
  assert.match(skill, /用户明确要求.*团队/)
  assert.match(skill, /CoreRuntime|Runtime/)
  assert.match(skill, /Platform Profile/)
  assert.match(routing, /并行价值/)
  assert.match(routing, /独立挑战[^。\n]*不是[^。\n]*team/)
  assert.match(routing, /两种模式[^。\n]*team-work/)
  assert.match(routing, /OpenSpec/)
  assert.match(routing, /auto.*跳过|跳过.*auto/s)
  assert.match(routing, /required.*阻塞|阻塞.*required/s)
  assert.match(routing, /disabled.*跳过|跳过.*disabled/s)
  assert.match(commands, /team-work task create/)
  assert.match(commands, /--entry-stage/)
  for (const stage of ["research", "design", "design-review", "spec", "spec-review", "implementation", "test", "code-review", "e2e", "finish"]) {
    assert.match(stages, new RegExp(`\\b${stage}\\b`))
  }
  assert.match(stages, /code-review[^]*代码[^]*审查范围/)
  assert.doesNotMatch([skill, stages, routing, commands].join("\n"), /\.opencode|\.claude|team_create|team_send/)
})

test("Workflow requires plain-language design approval and final human acceptance", async () => {
  const skill = await read("skills/workflow/SKILL.md")
  const review = await read("skills/workflow/references/human-review.md")
  const combined = `${skill}\n${review}`

  assert.match(skill, /方案批准|design-approval/)
  assert.match(skill, /最终验收|final-acceptance/)
  assert.match(combined, /required.*optional.*disabled/s)
  assert.match(combined, /awaiting-user/)
  assert.match(combined, /唯一批准基线/)
  for (const requirement of ["说人话", "修改点", "影响范围", "风险", "验证", "未决问题"]) {
    assert.match(review, new RegExp(requirement))
  }
  assert.match(review, /复杂[^。\n]*(?:图|表)|(?:图|表)[^。\n]*复杂/)
  assert.match(review, /代码片段[^。\n]*(?:现有代码|代码事实)/)
  assert.match(review, /(?:伪代码|建议)[^。\n]*(?:明确|标注)/)
  assert.match(review, /不得[^。\n]*(?:臆造|虚构)/)
  assert.match(review, /文档[^。\n]*(?:变化|修改)[^。\n]*(?:重新批准|失效)/)
  assert.match(review, /返工[^。\n]*(?:方案|实施|测试|代码审查|E2E)/)
})

test("Team-work preserves cost topology, convergence, ownership, and standalone entry", async () => {
  const skill = await read("skills/team-work/SKILL.md")
  const topology = await read("skills/team-work/references/topologies.md")
  const member = await read("skills/team-work/references/member-contract.md")
  const evaluation = await read("skills/team-work/references/evaluation.md")
  const combined = [skill, topology, member, evaluation].join("\n")

  assert.match(combined, /Junior.*默认|默认.*Junior/)
  assert.match(combined, /Expert.*通常.*1|通常.*1.*Expert/)
  assert.match(combined, /第二位 Expert/)
  assert.match(combined, /不可逆|高风险/)
  assert.match(combined, /挑战者/)
  assert.match(combined, /Senior 或 Expert/)
  assert.match(combined, /最多三轮|最多 3 轮/)
  assert.match(combined, /每一轮[^。\n]*挑战者|挑战者[^。\n]*每一轮/)
  assert.match(combined, /唯一 Owner/)
  assert.match(evaluation, /同档/)
  assert.match(evaluation, /不.*流程|不进入.*循环/)
  assert.match(skill, /没有活动任务/)
  assert.match(skill, /实际研发阶段|适配.*阶段/)
  assert.match(skill, /创建后立即[^。]*Runtime[^。]*team/)
  assert.match(skill, /只读助手/)
  assert.match(skill, /不[^。]*(?:团队成员|work item)/)
  assert.match(skill, /调用成员[^。]*(?:核验|整合)|(?:核验|整合)[^。]*调用成员/)
  assert.doesNotMatch(combined, /adhoc-team/)
  assert.doesNotMatch(combined, /team_create|team_send|\.opencode|\.claude/)
})

test("Lead controls the Harness while workers, challengers, and Experts own content", async () => {
  const workflow = await read("skills/workflow/SKILL.md")
  const teamwork = await read("skills/team-work/SKILL.md")
  const topology = await read("skills/team-work/references/topologies.md")
  const member = await read("skills/team-work/references/member-contract.md")
  const combined = [workflow, teamwork, topology, member].join("\n")

  assert.match(combined, /Lead[^。\n]*(?:不得|禁止)[^。\n]*(?:具体工作|具体内容)/)
  assert.match(combined, /solo[^。\n]*(?:单一|一个)[^。\n]*Owner/i)
  assert.match(combined, /solo[^。\n]*挑战者|挑战者[^。\n]*solo/i)
  assert.match(combined, /核心[^。\n]*(?:Expert|专家)[^。\n]*(?:裁决|把关)|(?:Expert|专家)[^。\n]*核心[^。\n]*(?:裁决|把关)/)
  assert.match(combined, /Lead[^。\n]*(?:流程|制品|证据)[^。\n]*(?:验收|核对)/)
  assert.match(combined, /(?:Expert|专家)[^。\n]*(?:内容|技术)[^。\n]*(?:裁决|结论)/)
  assert.doesNotMatch(combined, /Lead (?:单独执行|汇总为方案初稿|进行集成|决定工作流建议结果)/)
})

test("context, session continuity, and human synchronization remain bounded", async () => {
  const context = await read("skills/team-work/references/context-and-sessions.md")
  const teamwork = await read("skills/team-work/SKILL.md")
  const handoff = await read("skills/workflow/references/recovery-and-handoff.md")
  const reports = await read("skills/team-work/references/artifacts-and-report.md")
  const combined = [context, teamwork, handoff, reports].join("\n")

  assert.match(context, /Lead[^。\n]*(?:索引|摘要)[^。\n]*(?:不注入|禁止)[^。\n]*(?:整个任务目录|全部任务)/)
  assert.match(context, /同一[^。\n]*work item[^。\n]*(?:续派|原会话)/i)
  assert.match(context, /Expert[^。\n]*同一阶段[^。\n]*同一会话|同一阶段[^。\n]*Expert[^。\n]*同一会话/i)
  assert.match(context, /跨阶段[^。\n]*(?:新|重新)[^。\n]*(?:work item|会话)/i)
  assert.match(combined, /用户[^。\n]*授权[^。\n]*追加轮次/)
  assert.match(handoff, /直接[^。\n]*(?:回复|消息)[^。\n]*用户/)
  for (const field of ["当前阶段", "结果", "产物", "分歧", "建议"]) assert.match(handoff, new RegExp(field))
  assert.match(handoff, /(?:Owner|挑战者|Expert)[^。\n]*(?:转发|续派|回答)/)
  assert.match(handoff, /(?:说人话|普通语言)/)
  assert.match(handoff, /(?:内部|推理)[^。\n]*(?:编号|标识)[^。\n]*(?:替代|代替)/)
  assert.match(handoff, /默认固定门禁[^。\n]*方案批准[^。\n]*最终验收/)
  assert.match(handoff, /用户预先指定[^。\n]*高风险/)
})

test("research produces a concise project briefing instead of an unverifiable expertise claim", async () => {
  const stages = await read("skills/workflow/references/stages-and-artifacts.md")
  for (const field of ["项目目标", "核心设计", "关键模块", "关键实现", "风险", "未知项"]) {
    assert.match(stages, new RegExp(field))
  }
  assert.match(stages, /项目简介/)
  assert.match(stages, /简洁|言简意赅/)
  assert.doesNotMatch(stages, /成为.*专家/)
})

test("owners can challenge expert findings while Lead remains a process authority", async () => {
  const teamwork = await read("skills/team-work/SKILL.md")
  const member = await read("skills/team-work/references/member-contract.md")
  const topology = await read("skills/team-work/references/topologies.md")
  const combined = [teamwork, member, topology].join("\n")

  assert.match(combined, /Owner[^。\n]*(?:独立判断|核验)[^。\n]*(?:接受|异议|辩驳)/)
  assert.match(combined, /Expert[^。\n]*(?:不可质疑|绝对权威|无条件执行)/)
  assert.match(combined, /Lead[^。\n]*(?:不得|不)[^。\n]*(?:技术分歧|内容结论)[^。\n]*(?:强行|替代|裁决)/)
  assert.match(combined, /三轮[^。\n]*(?:用户|人工)[^。\n]*(?:决定|裁决)/)
})

test("rework follows confirmation, execution, self-check, and independent review", async () => {
  const member = await read("skills/team-work/references/member-contract.md")
  for (const step of ["理解并确认", "修复计划", "执行修改", "自检", "非作者复核"]) {
    assert.match(member, new RegExp(step))
  }
  assert.match(member, /不理解|疑问/)
  assert.match(member, /人工复核[^。\n]*(?:显式|高风险)/)
})

test("challenger stays adversarial and covers delivery quality risks", async () => {
  const topology = await read("skills/team-work/references/topologies.md")
  const review = await read("skills/team-work/references/code-review.md")
  const combined = `${topology}\n${review}`
  assert.match(combined, /挑战者[^。\n]*(?:不负责|不得)[^。\n]*(?:策划|实施)/)
  for (const concern of ["实现成本", "代码风格", "可读性", "代码结构", "性能风险", "业务风险", "过度设计", "遗漏"]) {
    assert.match(combined, new RegExp(concern))
  }
})

test("human-facing reports use a compact plain-language decision summary", async () => {
  const reports = await read("skills/team-work/references/artifacts-and-report.md")
  for (const field of ["结论", "依据", "产物", "分歧", "风险", "建议"]) assert.match(reports, new RegExp(field))
  assert.match(reports, /说人话|普通语言/)
  assert.match(reports, /内部[^。\n]*(?:编号|标识)/)
  assert.match(reports, /详细[^。\n]*制品/)
})

test("E2E is applicability-gated and keeps test-artifact rework inside its own loop", async () => {
  const workflow = await read("skills/workflow/SKILL.md")
  const stages = await read("skills/workflow/references/stages-and-artifacts.md")
  const testing = await read("skills/team-work/references/testing.md")
  const combined = [workflow, stages, testing].join("\n")

  assert.match(combined, /E2E.*适用性|适用性.*E2E/s)
  for (const step of ["测试设计", "用例审查", "夹具", "实现审查", "执行", "结果复核"]) {
    assert.match(testing, new RegExp(step))
  }
  assert.match(combined, /产品代码缺陷[^。\n]*实施/)
  assert.match(combined, /测试策略[^。\n]*测试/)
  assert.match(combined, /环境[^。\n]*阻塞/)
})

test("code review covers every perspective independently from model cost", async () => {
  const review = await read("skills/team-work/references/code-review.md")
  assert.match(review, /审查视角.*成本档位.*正交|成本档位.*审查视角.*正交/)
  for (const perspective of ["需求与变更摘要", "缺陷与安全", "错误处理", "逻辑推演", "测试覆盖", "类型与不变量", "规范与合规", "影响范围"]) {
    assert.match(review, new RegExp(perspective))
  }
  for (const field of ["位置", "归因", "严重级别", "置信度", "触发条件", "影响", "证据", "修复", "回归测试", "验证步骤"]) {
    assert.match(review, new RegExp(field))
  }
})

test("member selector is deterministic with a seed and prefers model diversity", async () => {
  const input = JSON.stringify({
    tier: "junior",
    count: 3,
    seed: "review-42",
    candidates: [
      { id: "junior-a", model: "model-a", tier: "junior" },
      { id: "junior-b", model: "model-b", tier: "junior" },
      { id: "junior-c", model: "model-a", tier: "junior" },
      { id: "senior-a", model: "model-s", tier: "senior" },
    ],
  })
  const run = () => spawnSync(process.execPath, [path.join(projectRoot, "skills/team-work/scripts/select-members.mjs")], { input, encoding: "utf8" })
  const first = run()
  const second = run()
  assert.equal(first.status, 0, first.stderr)
  assert.equal(second.status, 0, second.stderr)
  assert.equal(first.stdout, second.stdout)
  const result = JSON.parse(first.stdout)
  assert.equal(result.selected.length, 3)
  assert.equal(new Set(result.selected.map(({ id }) => id)).size, 3)
  assert.equal(new Set(result.selected.slice(0, 2).map(({ model }) => model)).size, 2)
  assert.ok(result.selected.every(({ tier }) => tier === "junior"))
})

test("member selector rejects an insufficient same-tier candidate pool", () => {
  const input = JSON.stringify({ tier: "expert", count: 2, candidates: [{ id: "expert-a", model: "model-a", tier: "expert" }] })
  const result = spawnSync(process.execPath, [path.join(projectRoot, "skills/team-work/scripts/select-members.mjs")], { input, encoding: "utf8" })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /候选|candidate/i)
})
