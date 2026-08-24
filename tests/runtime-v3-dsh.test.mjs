// DSH 绑定 Phase 1 测试：dsh-map 解析、dispatch-plan、models、init、PATH 注入（docs/dsh-phase1-plan.md §3）
import assert from "node:assert/strict"
import { writeFile, readFile, access, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { tw } from "../runtime-v3/cli.mjs"
import { loadTask } from "../runtime-v3/store.mjs"
import { parseAgentDefault, ensureDshMap, resolveTiers, validateDshMap, dshMapPath, placeholderMap, TIERS } from "../runtime-v3/dsh-map.mjs"
import { FIX_WORKFLOW, FIX_POLICY, makeProject, caller, openTask, seedConvergedStage } from "./support/v3-fixtures.mjs"

// settings 夹具（与真实 ~/.dsh/settings.yaml 的 agent-default-model 块同形，含引号值）
const settingsFile = path.join(tmpdir(), `tw-dsh-settings-${process.pid}.yaml`)
await writeFile(settingsFile, 'llm-pi-ai:\n  providers: {}\nagent-default-model:\n  provider: prov-main\n  model: "deepseek-v4-pro"\nllm-deepseek:\n  models: []\n')
process.env.DSH_SETTINGS = settingsFile

async function writeMap(root, map) {
  await mkdir(path.dirname(dshMapPath(root)), { recursive: true })
  await writeFile(dshMapPath(root), typeof map === "string" ? map : JSON.stringify(map))
}

test("parseAgentDefault：块解析、引号剥离、缺失返回 null", () => {
  assert.deepEqual(parseAgentDefault(await0()), { provider: "prov-main", model: "deepseek-v4-pro" })
  assert.equal(parseAgentDefault("other:\n  x: 1\n"), null, "无 agent-default-model 键")
  assert.equal(parseAgentDefault("agent-default-model:\n  provider: only\n"), null, "缺 model")
  function await0() {
    return 'agent-default-model:\n  provider: prov-main\n  model: "deepseek-v4-pro"\nnext-key:\n  a: 1\n'
  }
})

test("零初始化：ensureDshMap 生成占位模板且幂等（不覆盖用户改动）", async () => {
  const root = await makeProject()
  const first = await ensureDshMap(root)
  assert.equal(first.created, true)
  assert.deepEqual(JSON.parse(await readFile(dshMapPath(root), "utf8")), placeholderMap())
  const second = await ensureDshMap(root)
  assert.equal(second.created, false)
})

test("占位解析：三档 = agent-default 来源，值来自 settings", async () => {
  const root = await makeProject()
  await ensureDshMap(root)
  const r = await resolveTiers(root)
  for (const tier of TIERS) {
    assert.deepEqual(r.tiers[tier], { provider: "prov-main", model: "deepseek-v4-pro", source: "agent-default" }, tier)
  }
  assert.deepEqual(r.warnings, [])
})

test("显式分档：senior 显式覆盖，其余保持占位", async () => {
  const root = await makeProject()
  await ensureDshMap(root)
  const map = JSON.parse(await readFile(dshMapPath(root), "utf8"))
  map.tiers.senior = { provider: "prov-main", model: "glm-5.3" }
  await writeMap(root, map)
  const r = await resolveTiers(root)
  assert.deepEqual(r.tiers.senior, { provider: "prov-main", model: "glm-5.3", source: "explicit" })
  assert.equal(r.tiers.junior.source, "agent-default")
})

test("缺档回退：defaults 显式 → fallback；全空 → unresolved + 警告（不猜环境默认）", async () => {
  const fallbackRoot = await makeProject()
  await writeMap(fallbackRoot, { tiers: {}, defaults: { provider: "prov-main", model: "deepseek-v4-flash" } })
  const r1 = await resolveTiers(fallbackRoot)
  assert.deepEqual(r1.tiers.expert, { provider: "prov-main", model: "deepseek-v4-flash", source: "fallback" })
  assert.ok(r1.warnings.some((w) => /expert 未配置/.test(w)), "缺档要给警告")

  const bareRoot = await makeProject()
  await writeMap(bareRoot, { tiers: {}, defaults: null })
  const missingSettings = path.join(bareRoot, "nope.yaml")
  const r2 = await resolveTiers(bareRoot, { settingsFile: missingSettings })
  for (const tier of TIERS) {
    assert.deepEqual(r2.tiers[tier], { provider: null, model: null, source: "unresolved" }, tier + " 未解析而非猜测环境默认")
  }
  assert.ok(r2.warnings.some((w) => /未找到/.test(w)), "settings 缺失要给警告")
  assert.ok(r2.warnings.some((w) => /未解析/.test(w)), "unresolved 档要给配置指引警告")
})

test("映射校验：损坏/未知字段/未知档位拒绝并带修复指引", async () => {
  const root = await makeProject()
  await writeMap(root, "{ not json")
  await assert.rejects(resolveTiers(root), (e) => e.code === "STATE_CORRUPT" && /dsh\.json/.test(e.message), "损坏 JSON")
  assert.throws(() => validateDshMap({ tiers: {}, modles: {} }), (e) => e.code === "MAP_INVALID" && /未知顶层字段/.test(e.message), "顶层未知字段")
  assert.throws(() => validateDshMap({ tiers: { staff: { provider: "a", model: "b" } } }), (e) => e.code === "MAP_INVALID" && /未知档位/.test(e.message), "未知档位")
  assert.throws(() => validateDshMap({ tiers: { senior: { provder: "a", model: "b" } } }), (e) => e.code === "MAP_INVALID" && /未知字段/.test(e.message), "tier 内拼错字段")
  assert.throws(() => validateDshMap({ tiers: { senior: { provider: "", model: "b" } } }), (e) => e.code === "MAP_INVALID" && /非空字符串/.test(e.message), "空 provider")
})

test("dispatch-plan：派发点输出波次计划（prompt/PATH 注入/modelHint/事件注册），重复调用 wait-inflight", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "plan-t")
  const plan = await call(["dispatch-plan", "--task", "plan-t", "--writable", "R.md:code-review", "--json"])
  assert.equal(plan.ok, true)
  assert.equal(plan.stop, null)
  assert.equal(plan.waves.length, 1)
  const w = plan.waves[0]
  assert.equal(w.role, "owner")
  assert.equal(w.tier, "junior")
  assert.equal(w.kind, "produce")
  assert.equal(w.deliver, "deliver")
  assert.match(w.prompt, /# 派单（key: w\d+-/)
  assert.match(w.prompt, /bin\/tw\.mjs deliver --task plan-t/, "交付指令注入绝对路径与真实任务名")
  assert.deepEqual(w.modelHint, { provider: "prov-main", model: "deepseek-v4-pro", source: "agent-default" })
  assert.match(w.dispatchExample, /--key /)
  assert.equal(plan.mapping, ".team-work/platform/dsh.json")
  assert.equal(plan.card.next, "dispatch")
  const task = await loadTask(root, "plan-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const dispatched = task.journal.filter((e) => e.type === "dispatched")
  assert.equal(dispatched.length, 1, "派发点注册 dispatched 事件")
  assert.equal(dispatched[0].detail.key, w.dispatchKey)
  const again = await call(["dispatch-plan", "--task", "plan-t", "--writable", "R.md:code-review", "--json"])
  assert.equal(again.stop, "wait-inflight", "在途波次不重复派发")
  assert.equal(again.dispatchKey, w.dispatchKey)
  // 人读模式（无 --json）：附派单全文
  await openTask(root, "plan-h")
  const human = await call(["dispatch-plan", "--task", "plan-h", "--writable", "R.md:code-review"])
  assert.ok(Array.isArray(human.human))
  assert.match(human.human.join("\n"), /派单全文/)
})

test("dispatch-plan：人工门 stop + 决定后推进到 completed", async () => {
  const root = await makeProject()
  const { call } = await seedConvergedStage(root, "gate-t")
  const plan = await call(["dispatch-plan", "--task", "gate-t", "--json"])
  assert.equal(plan.stop, "awaiting-user")
  assert.ok(plan.card.decisionId)
  assert.equal(plan.card.choices.length, 2)
  assert.equal((await call(["decide", "--task", "gate-t", "--choice", "1"])).ok, true)
  const done = await call(["dispatch-plan", "--task", "gate-t", "--json"])
  assert.equal(done.stop, "completed")
  assert.equal(done.card.status, "completed")
})

test("dispatch-plan：门过即跨阶段推进并派发下一阶段首波", async () => {
  const wf = { terminalStages: ["code-review"], gates: [], stages: [
    { id: "research", label: "调研", outputs: [], teamScene: "research" },
    { id: "code-review", label: "审查", outputs: ["code-review"], teamScene: "code-review" },
  ], edges: [{ from: "research", to: "code-review", outcome: "pass" }] }
  const pol = { maxAutonomousRounds: 3, scenes: { research: { core: false }, "code-review": { core: false } } }
  const root = await makeProject({ workflow: wf, policy: pol })
  const call = caller(root)
  await openTask(root, "adv-t", { entry: null })
  const task = await loadTask(root, "adv-t", { workflow: wf, policy: pol })
  const at = new Date().toISOString()
  await writeFile(path.join(task.root, "reports", "o.json"), JSON.stringify({ reportId: "o1", dispatchKey: "seed", role: "owner", kind: "deliver", round: 1, stage: "research", taskSha: "s", payload: { outcome: "delivered", summary: "s", paths: [] }, at }))
  await writeFile(path.join(task.root, "reports", "c.json"), JSON.stringify({ reportId: "c1", dispatchKey: "seed", role: "challenger", kind: "review", round: 1, stage: "research", taskSha: "s", payload: { summary: "s", recommendation: "accept" }, at }))
  const plan = await call(["dispatch-plan", "--task", "adv-t", "--writable", "R.md:code-review", "--json"])
  assert.equal(plan.stop, null)
  assert.equal(plan.stage, "code-review", "一次调用完成 advance + 下一阶段派发")
  assert.equal(plan.waves[0].kind, "produce")
  const after = await loadTask(root, "adv-t", { workflow: wf, policy: pol })
  assert.ok(after.journal.some((e) => e.type === "stage-advanced" && e.detail.to === "code-review"))
})

test("models：自动建模板、三档解析、显式覆盖即时生效", async () => {
  const root = await makeProject()
  const call = caller(root)
  const r1 = await call(["models"])
  assert.equal(r1.ok, true)
  assert.deepEqual(r1.tiers.map((t) => t.tier), ["junior", "senior", "expert"])
  assert.ok(r1.tiers.every((t) => t.provider === "prov-main" && t.model === "deepseek-v4-pro" && t.source === "agent-default"))
  assert.equal(r1.agentDefault, "prov-main/deepseek-v4-pro")
  assert.ok(await access(dshMapPath(root)).then(() => true, () => false), "models 自动生成映射模板")
  await writeMap(root, { tiers: { senior: { provider: "prov-main", model: "glm-5.3" } }, defaults: null })
  const r2 = await call(["models"])
  assert.deepEqual(r2.tiers.find((t) => t.tier === "senior"), { tier: "senior", provider: "prov-main", model: "glm-5.3", source: "explicit" })
  assert.ok(r2.warnings.some((x) => /junior 未配置/.test(x)), "被删档位给警告")
})

test("init：skill 装载/幂等/--force，映射模板就位", async () => {
  const root = await makeProject()
  const r1 = await tw(["init"], { projectRoot: root })
  assert.equal(r1.ok, true)
  assert.equal(r1.mapping.created, true)
  assert.equal(r1.skill.action, "installed")
  const skill = await readFile(path.join(root, ".dsh/skills/team-work-v3/SKILL.md"), "utf8")
  assert.match(skill, /team-work（v3）/)
  assert.ok(await access(path.join(root, ".dsh/skills/team-work-v3/references/dsh-orchestration.md")).then(() => true, () => false))
  const r2 = await tw(["init"], { projectRoot: root })
  assert.equal(r2.skill.action, "skipped", "幂等：已存在不覆盖")
  assert.equal(r2.mapping.created, false)
  await writeFile(path.join(root, ".dsh/skills/team-work-v3/SKILL.md"), "被污染")
  const r3 = await tw(["init", "--force"], { projectRoot: root })
  assert.equal(r3.skill.action, "overwritten")
  assert.match(await readFile(path.join(root, ".dsh/skills/team-work-v3/SKILL.md"), "utf8"), /team-work（v3）/)
})

test("verdict 派单必须内嵌工具调用指令（P2：成员不调用 review 则 runtime 永远收不到裁决）", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "vd-t")
  const d1 = await call(["run", "--task", "vd-t", "--writable", "R.md:code-review"])
  await writeFile(path.join(root, "R.md"), "x", "utf8")
  await call(["deliver", "--task", "vd-t", "--key", d1.dispatch.key, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  await call(["review", "--task", "vd-t", "--key", (await call(["run", "--task", "vd-t"])).dispatch.key, "--recommendation", "accept", "--summary", "s"])
  const verdictDispatch = await call(["run", "--task", "vd-t"])
  assert.equal(verdictDispatch.dispatch.kind, "verdict")
  assert.match(verdictDispatch.dispatch.prompt, /review --task vd-t --key /, "verdict 派单含 review 调用指令")
  assert.match(verdictDispatch.dispatch.prompt, /--verdict/, "verdict 派单含 --verdict 参数指引")
  assert.match(verdictDispatch.dispatch.prompt, /不要只写成文字/, "明确禁止纯文本裁决")
})

test("幂等重交：同 key 同 payload 不追加第二条 report-accepted（E2E-10 补全）", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "idem-t")
  const d = await call(["run", "--task", "idem-t", "--writable", "R.md:code-review"])
  await writeFile(path.join(root, "R.md"), "x", "utf8")
  const first = await call(["deliver", "--task", "idem-t", "--key", d.dispatch.key, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  const again = await call(["deliver", "--task", "idem-t", "--key", d.dispatch.key, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  assert.equal(again.accepted, true)
  assert.equal(again.idempotent, true, "重交标记幂等")
  const task = await loadTask(root, "idem-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const events = task.journal.filter((e) => e.type === "report-accepted")
  assert.equal(events.length, 1, "journal 只记一条 report-accepted")
  const rev = await call(["review", "--task", "idem-t", "--key", (await call(["run", "--task", "idem-t"])).dispatch.key, "--recommendation", "accept", "--summary", "s"])
  const revAgain = await call(["review", "--task", "idem-t", "--key", rev.reportId.replace("review-", ""), "--recommendation", "accept", "--summary", "s"])
  assert.equal(revAgain.idempotent, true, "review 重交同样幂等")
  const task2 = await loadTask(root, "idem-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(task2.journal.filter((e) => e.type === "report-accepted").length, 2, "deliver 一条 + review 一条")
})

test("help：CLI 即接口——全部命令与新增动词在场", async () => {
  const r = await tw(["help"])
  assert.equal(r.ok, true)
  for (const cmd of ["open", "run", "dispatch-plan", "decide", "intent", "route", "gate", "models", "init", "restore", "archive", "deliver", "review"]) {
    assert.ok(r.commands[cmd], cmd)
  }
})