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
  "skills/team-work/SKILL.md",
  "skills/team-work/agents/openai.yaml",
  "skills/team-work/references/member-contract.md",
  "skills/team-work/references/topologies.md",
  "skills/team-work/references/artifacts-and-report.md",
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
  assert.match(routing, /独立评审价值/)
  assert.match(routing, /OpenSpec/)
  assert.match(commands, /team-work task create/)
  assert.match(commands, /--entry-stage/)
  for (const stage of ["research", "design", "design-review", "spec", "spec-review", "implementation", "test", "code-review", "e2e", "finish"]) {
    assert.match(stages, new RegExp(`\\b${stage}\\b`))
  }
  assert.match(stages, /code-review[^]*代码[^]*审查范围/)
  assert.doesNotMatch([skill, stages, routing, commands].join("\n"), /\.opencode|\.claude|team_create|team_send/)
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
  assert.match(combined, /唯一 Owner/)
  assert.match(evaluation, /同档/)
  assert.match(evaluation, /不.*流程|不进入.*循环/)
  assert.match(skill, /没有活动任务/)
  assert.match(skill, /实际研发阶段|适配.*阶段/)
  assert.match(skill, /创建后立即[^。]*Runtime[^。]*team/)
  assert.doesNotMatch(combined, /adhoc-team/)
  assert.doesNotMatch(combined, /team_create|team_send|\.opencode|\.claude/)
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
