// DSH 绑定：调用配置快照解析、dispatch-plan、models、init 与模型快照。
import assert from "node:assert/strict"
import { writeFile, readFile, access, mkdir, cp, mkdtemp, symlink, chmod, readdir, realpath, rm } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import fsPromises from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test, { mock } from "node:test"

import { tw } from "../runtime-v3/cli.mjs"
import { loadTask } from "../runtime-v3/store.mjs"
import { resolveTiers, validateTierSettings, TIERS } from "../runtime-v3/dsh-map.mjs"
import { FIX_WORKFLOW, FIX_POLICY, makeProject, caller, openTask, seedConvergedStage } from "./support/v3-fixtures.mjs"

const BASE_CONFIG = {
  entryId: "team-work-dsh", profile: "fixture-profile", tiers: {
    junior: { provider: "vendor-junior", model: "model-junior" },
    senior: { provider: "vendor-senior", model: "model-senior" },
    expert: { provider: "vendor-expert", model: "model-expert" },
  },
}
process.env.TW_DSH_CONFIG = JSON.stringify(BASE_CONFIG)

async function setConfig(config) { process.env.TW_DSH_CONFIG = JSON.stringify(config) }

async function hasFile(file) {
  return access(file).then(() => true, () => false)
}

async function withEnvironment(values, action) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    return await action()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test("调用快照：完整三档从插件配置解析并携带 entry/profile 来源", async () => {
  const resolved = await resolveTiers({ configSnapshot: {
    entryId: "team-work-dsh", profile: "fixture-profile", tiers: {
      junior: { provider: "vendor-junior", model: "model-junior" },
      senior: [{ provider: "vendor-senior", model: "model-senior", effort: "high" }],
      expert: { provider: "vendor-expert", model: "model-expert" },
    },
  } })
  assert.equal(resolved.source, "dsh-plugin-config")
  assert.equal(resolved.entryId, "team-work-dsh")
  assert.equal(resolved.profile, "fixture-profile")
  assert.equal(Object.hasOwn(resolved, "file"), false)
  assert.equal(resolved.tiers.junior.model, "model-junior")
  assert.equal(resolved.tiers.senior.effort, "high")
  assert.equal(resolved.tiers.expert.source, "dsh-plugin-config")
  assert.deepEqual(resolved.warnings, [])
})

test("调用快照：环境 JSON 生效，缺失或损坏只返回 unresolved", async () => {
  await withEnvironment({ TW_DSH_CONFIG: JSON.stringify({ entryId: "team-work-dsh", profile: "env-profile", tiers: {
    junior: { provider: "snapshot-provider", model: "snapshot-junior" },
    senior: { provider: "snapshot-provider", model: "snapshot-senior" },
    expert: { provider: "snapshot-provider", model: "snapshot-expert" },
  } }) }, async () => {
    assert.equal((await resolveTiers()).tiers.junior.model, "snapshot-junior")
  })
  for (const input of [undefined, "{invalid", "null", "[]", '{"tiers":{}}']) {
    await withEnvironment({ TW_DSH_CONFIG: input }, async () => {
      const resolved = await resolveTiers()
      for (const tier of TIERS) assert.equal(resolved.tiers[tier].source, "unresolved")
      assert.equal(resolved.profile, "unresolved")
      assert.match(resolved.warnings.join("\n"), /TW_DSH_CONFIG/)
      assert.equal(Object.hasOwn(resolved, "file"), false)
    })
  }
})

test("调用快照：未知封套字段和继承来源不当成可信输入", async () => {
  for (const configSnapshot of [{ ...BASE_CONFIG, extra: true }, Object.create(BASE_CONFIG)]) {
    const resolved = await resolveTiers({ configSnapshot })
    for (const tier of TIERS) assert.equal(resolved.tiers[tier].source, "unresolved")
    assert.match(resolved.warnings.join("\n"), /TW_DSH_CONFIG/)
  }
})

test("调用快照：特殊未知档位拒绝派发且不污染原型", async () => {
  for (const key of ["__proto__", "constructor", "prototype", "legacy"]) {
    const tiers = JSON.parse('{"' + key + '": {"polluted":true}}')
    const resolved = await resolveTiers({ configSnapshot: { ...BASE_CONFIG, tiers } })
    for (const tier of TIERS) assert.equal(resolved.tiers[tier].source, "unresolved")
    assert.match(resolved.warnings.join("\n"), /MAP_INVALID/)
    assert.ok(resolved.warnings.some((warning) => warning.includes(key)))
    const root = await makeProject()
    const call = caller(root)
    await openTask(root, "unknown-tier")
    await withEnvironment({ TW_DSH_CONFIG: JSON.stringify({ ...BASE_CONFIG, tiers }) }, async () => {
      const models = await call(["models"])
      assert.match(models.warnings.join("\n"), /MAP_INVALID/)
      const plan = await call(["dispatch-plan", "--task", "unknown-tier", "--writable", "R.md:code-review", "--json"])
      assert.equal(plan.stop, "blocked")
      const task = await loadTask(root, "unknown-tier", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
      assert.equal(task.journal.some((event) => event.type === "dispatched"), false)
    })
  }
  assert.equal(Object.hasOwn(Object.prototype, "polluted"), false)
})

test("调用快照：继承档位或 provider/model 不能通过完整性", () => {
  const inherited = validateTierSettings(Object.create(BASE_CONFIG.tiers))
  for (const tier of TIERS) assert.equal(inherited.tiers[tier].source, "unresolved")
  const invalid = validateTierSettings({ ...BASE_CONFIG.tiers, junior: Object.create(BASE_CONFIG.tiers.junior) })
  assert.equal(invalid.tiers.junior.source, "unresolved")
  assert.equal(invalid.tiers.senior.source, "dsh-plugin-config")
  assert.match(invalid.warnings.join("\n"), /provider 与 model 必须是非空字符串/)
})

test("调用快照：缺档与无效候选明确 unresolved，不猜测默认", async () => {
  const resolved = await resolveTiers({ configSnapshot: { ...BASE_CONFIG, tiers: {
    junior: BASE_CONFIG.tiers.junior,
    senior: [{ provider: "vendor-a", model: "model-a" }, { provider: "vendor-b", model: "model-b" }],
  } } })
  assert.equal(resolved.tiers.junior.model, "model-junior")
  assert.deepEqual(resolved.tiers.senior.pool.map((item) => item.model), ["model-a", "model-b"])
  assert.equal(resolved.tiers.expert.source, "unresolved")
  assert.match(resolved.warnings.join("\n"), /expert/)
  for (const candidate of [{ provider: "", model: "model" }, { provider: "vendor" }, { provider: "vendor", model: "model", extra: true }]) {
    const invalid = validateTierSettings({ ...BASE_CONFIG.tiers, junior: candidate })
    assert.equal(invalid.tiers.junior.source, "unresolved")
    assert.match(invalid.warnings.join("\n"), /provider 与 model 必须是非空字符串|未知字段/)
  }
})

test("调用快照：旧 settings 文件与显式旧参数均不读取，环境隔离后恢复", async () => {
  const home = path.join(tmpdir(), `tw-dsh-legacy-${process.pid}-${Date.now()}`)
  await mkdir(home, { recursive: true })
  const file = path.join(home, "settings.yaml")
  const old = "team-work-dsh:\n  tiers:\n    junior: { provider: legacy-vendor, model: legacy-model }\n"
  await writeFile(file, old)
  const initial = process.env.TW_DSH_CONFIG
  await withEnvironment({ DSH_SETTINGS: file, DSH_HOME: home, TW_DSH_CONFIG: undefined }, async () => {
    const resolved = await resolveTiers({ settingsFile: file })
    for (const tier of TIERS) assert.equal(resolved.tiers[tier].source, "unresolved")
    assert.match(resolved.warnings.join("\n"), /未提供 TW_DSH_CONFIG/)
  })
  await withEnvironment({ DSH_SETTINGS: file, DSH_HOME: home, TW_DSH_CONFIG: JSON.stringify({ ...BASE_CONFIG, profile: "snapshot-profile" }) }, async () => {
    const resolved = await resolveTiers({ settingsFile: file })
    assert.equal(resolved.tiers.junior.model, "model-junior")
    assert.equal(resolved.profile, "snapshot-profile")
    const root = await makeProject()
    const call = caller(root)
    const models = await call(["models"])
    assert.equal(models.profile, "snapshot-profile")
    assert.equal(Object.hasOwn(models, "file"), false)
    await openTask(root, "snapshot-source")
    const plan = await call(["dispatch-plan", "--task", "snapshot-source", "--writable", "R.md:code-review", "--json"])
    assert.deepEqual(plan.modelSettings, { source: "dsh-plugin-config", entryId: "team-work-dsh", profile: "snapshot-profile" })
  })
  assert.equal(process.env.TW_DSH_CONFIG, initial)
  assert.equal(await readFile(file, "utf8"), old)
})

test("dispatch-plan：调用快照映射生效，遗留项目 dsh.json 被完全忽略", async () => {
  const root = await makeProject()
  const legacy = path.join(root, ".team-work", "platform", "dsh.json")
  await mkdir(path.dirname(legacy), { recursive: true })
  const legacyContent = JSON.stringify({ tiers: { junior: { provider: "legacy-vendor", model: "legacy-model" } } })
  await writeFile(legacy, legacyContent)
  const call = caller(root)
  await openTask(root, "plan-t")

  const plan = await call(["dispatch-plan", "--task", "plan-t", "--writable", "R.md:code-review", "--json"])
  assert.equal(plan.ok, true)
  assert.equal(plan.stop, null)
  assert.equal(plan.waves.length, 1)
  const wave = plan.waves[0]
  assert.equal(wave.role, "owner")
  assert.equal(wave.modelHint.model, "model-junior")
  assert.equal(wave.modelHint.source, "dsh-plugin-config")
  assert.deepEqual(plan.modelSettings, { source: "dsh-plugin-config", entryId: "team-work-dsh", profile: "fixture-profile" })
  assert.equal(await readFile(legacy, "utf8"), legacyContent, "遗留文件未被读取后覆盖或改写")

  const task = await loadTask(root, "plan-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const dispatched = task.journal.filter((event) => event.type === "dispatched")
  assert.equal(dispatched.length, 1)
  assert.deepEqual(dispatched[0].detail.modelHint, wave.modelHint, "模型选择与 dispatch-plan 同一事实快照")
  const again = await call(["dispatch-plan", "--task", "plan-t", "--writable", "R.md:code-review", "--json"])
  assert.equal(again.stop, "wait-inflight", "在途波次不重复派发")
})

test("派发人读卡：显示实际 entry/profile 来源", async () => {
  const root = await makeProject()
  await openTask(root, "source-card")
  const plan = await caller(root)(["dispatch-plan", "--task", "source-card", "--writable", "R.md:code-review"])
  assert.match(plan.human.join("\n"), /team-work-dsh/)
  assert.match(plan.human.join("\n"), /fixture-profile/)
})

test("调用快照热变：前波沿用快照，后波读取新配置且保留可选 effort", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "hot-config")
  const first = await call(["dispatch-plan", "--task", "hot-config", "--writable", "R.md:code-review", "--json"])
  const oldHint = first.waves[0].modelHint
  const changed = { ...BASE_CONFIG, profile: "updated-profile", tiers: {
    junior: { provider: "updated-vendor", model: "updated-junior" },
    senior: { provider: "updated-vendor", model: "updated-senior", effort: "high" },
    expert: { provider: "updated-vendor", model: "updated-expert" },
  } }
  await withEnvironment({ TW_DSH_CONFIG: JSON.stringify(changed) }, async () => {
    const waiting = await call(["dispatch-plan", "--task", "hot-config", "--json"])
    assert.equal(waiting.stop, "wait-inflight")
    assert.deepEqual(waiting.inflight[0].modelHint, oldHint)
    await writeFile(path.join(root, "R.md"), "报告")
    const delivered = await call(["deliver", "--task", "hot-config", "--key", first.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "完成报告", "--paths", "R.md"])
    assert.equal(delivered.accepted, true)
    const next = await call(["dispatch-plan", "--task", "hot-config", "--json"])
    assert.equal(next.waves[0].modelHint.model, "updated-senior")
    assert.equal(next.waves[0].modelHint.effort, "high")
    assert.equal(next.modelSettings.profile, "updated-profile")
    const task = await loadTask(root, "hot-config", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
    const dispatched = task.journal.filter((event) => event.type === "dispatched")
    assert.deepEqual(dispatched[0].detail.modelHint, oldHint)
    assert.equal(dispatched[1].detail.modelHint.model, "updated-senior")
  })
})

test("旧 journal modelHint：配置变化或快照缺失都不重选已记录的精确模型", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "legacy-hint")
  const first = await call(["dispatch-plan", "--task", "legacy-hint", "--writable", "R.md:code-review", "--json"])
  const journalFile = path.join(root, ".team-work/tasks/legacy-hint/journal.jsonl")
  const events = (await readFile(journalFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
  const recorded = { provider: "recorded-vendor", model: "recorded-model", source: "global-settings", effort: "low" }
  events.find((event) => event.type === "dispatched").detail.modelHint = recorded
  await writeFile(journalFile, events.map((event) => JSON.stringify(event)).join("\n") + "\n")
  for (const input of [JSON.stringify(BASE_CONFIG), undefined]) {
    await withEnvironment({ TW_DSH_CONFIG: input }, async () => {
      const waiting = await call(["dispatch-plan", "--task", "legacy-hint", "--json"])
      assert.equal(waiting.stop, "wait-inflight")
      assert.equal(waiting.inflight[0].dispatchKey, first.waves[0].dispatchKey)
      assert.deepEqual(waiting.inflight[0].modelHint, recorded)
    })
  }
})

test("平台无关操作：缺配置快照仍可开任务、查状态、交付和评审", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "deliver-without-config")
  const owner = await call(["dispatch-plan", "--task", "deliver-without-config", "--writable", "D.md:code-review", "--json"])
  await openTask(root, "review-without-config")
  const reviewOwner = await call(["dispatch-plan", "--task", "review-without-config", "--writable", "R.md:code-review", "--json"])
  await writeFile(path.join(root, "R.md"), "评审报告")
  await call(["deliver", "--task", "review-without-config", "--key", reviewOwner.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "完成", "--paths", "R.md"])
  const reviewer = await call(["dispatch-plan", "--task", "review-without-config", "--json"])
  await withEnvironment({ TW_DSH_CONFIG: undefined }, async () => {
    assert.equal((await call(["open", "--name", "plain-task", "--objective", "平台无关", "--entry", "code-review"])).ok, true)
    assert.equal((await call(["run", "--task", "plain-task"])).ok, true)
    assert.equal((await call(["gate", "--task", "plain-task"])).ok, true)
    await writeFile(path.join(root, "D.md"), "交付报告")
    assert.equal((await call(["deliver", "--task", "deliver-without-config", "--key", owner.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "完成", "--paths", "D.md"])).accepted, true)
    assert.equal((await call(["review", "--task", "review-without-config", "--key", reviewer.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "独立核验通过"])).accepted, true)
  })
})

test("派发波次固化精确模型快照", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "run-hint-t")
  const plan = await call(["dispatch-plan", "--task", "run-hint-t", "--writable", "R.md:code-review", "--json"])
  assert.equal(plan.stop, null)
  const hint = plan.waves[0]?.modelHint
  assert.ok(hint?.provider && hint?.model, "派发波次带 modelHint（调用快照配置快照）")
  assert.equal(hint.source, "dsh-plugin-config")
  const task = await loadTask(root, "run-hint-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const dispatched = task.journal.filter((e) => e.type === "dispatched")
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0].detail.modelHint.provider, hint.provider, "journal dispatched 事实与派发波次同一快照")
  assert.equal(dispatched[0].detail.modelHint.model, hint.model, "journal dispatched 事实与派发波次同一快照")
  assert.equal(dispatched[0].detail.modelHint.source, hint.source, "journal dispatched 事实与派发波次同一快照")
})

test("dispatch-plan：无调用快照模型配置返回可恢复 blocked，且不写 dispatched 事实", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "no-models")
  await setConfig({ ...BASE_CONFIG, tiers: {} })
  try {
    const plan = await call(["dispatch-plan", "--task", "no-models", "--writable", "R.md:code-review", "--json"])
    assert.equal(plan.ok, true)
    assert.equal(plan.stop, "blocked")
    assert.equal(plan.card.status, "blocked")
    assert.equal(plan.card.next, "configure-models")
    assert.deepEqual(plan.card.modelSettings, { source: "dsh-plugin-config", entryId: "team-work-dsh", profile: "fixture-profile" })
    assert.equal(plan.card.blockers[0].code, "MODEL_CONFIG_UNRESOLVED")
    assert.match(plan.card.blockers[0].recovery, /team-work-dsh\.tiers/)
    const task = await loadTask(root, "no-models", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
    assert.equal(task.journal.some((event) => event.type === "dispatched"), false)
  } finally {
    await setConfig(BASE_CONFIG)
  }
})

test("dispatch-plan：人工门 stop + 决定后推进到 completed", async () => {
  const root = await makeProject()
  const { call } = await seedConvergedStage(root, "gate-t")
  const plan = await call(["dispatch-plan", "--task", "gate-t", "--json"])
  assert.equal(plan.stop, "awaiting-user")
  assert.ok(plan.card.decisionId)
  assert.equal((await call(["decide", "--task", "gate-t", "--choice", "1"])).ok, true)
  const done = await call(["dispatch-plan", "--task", "gate-t", "--json"])
  assert.equal(done.stop, "completed")
})

test("dispatch-plan：门过即跨阶段推进并派发下一阶段首波", async () => {
  const workflow = { terminalStages: ["code-review"], gates: [], stages: [
    { id: "research", label: "调研", outputs: [], teamScene: "research" },
    { id: "code-review", label: "审查", outputs: ["code-review"], teamScene: "code-review" },
  ], edges: [{ from: "research", to: "code-review", outcome: "pass" }] }
  const policy = { maxAutonomousRounds: 3, scenes: { research: { core: false }, "code-review": { core: false } } }
  const root = await makeProject({ workflow, policy })
  const call = caller(root)
  await openTask(root, "adv-t", { entry: null })
  const task = await loadTask(root, "adv-t", { workflow, policy })
  const at = new Date().toISOString()
  await writeFile(path.join(task.root, "reports", "o.json"), JSON.stringify({ reportId: "o1", dispatchKey: "seed", role: "owner", kind: "deliver", round: 1, stage: "research", taskSha: "s", payload: { outcome: "delivered", summary: "s", paths: [] }, at }))
  await writeFile(path.join(task.root, "reports", "c.json"), JSON.stringify({ reportId: "c1", dispatchKey: "seed", role: "challenger", kind: "review", round: 1, stage: "research", taskSha: "s", payload: { summary: "s", recommendation: "accept" }, at }))
  const plan = await call(["dispatch-plan", "--task", "adv-t", "--writable", "R.md:code-review", "--json"])
  assert.equal(plan.stop, null)
  assert.equal(plan.stage, "code-review")
  assert.equal(plan.waves[0].modelHint.model, "model-junior")
})

test("models 只读调用快照来源；init 只安装 skill，不创建项目 dsh.json", async () => {
  const root = await makeProject()
  const call = caller(root)
  const dshFile = path.join(root, ".team-work", "platform", "dsh.json")
  const models = await call(["models"])
  assert.equal(models.ok, true)
  assert.equal(models.source, "dsh-plugin-config")
  assert.equal(models.entryId, "team-work-dsh")
  assert.equal(models.profile, "fixture-profile")
  assert.equal(Object.hasOwn(models, "file"), false)
  assert.equal(models.tiers.find((tier) => tier.tier === "senior").model, "model-senior")
  assert.equal(await hasFile(dshFile), false, "models 不创建项目映射")

  const first = await tw(["init"], { projectRoot: root })
  assert.equal(first.ok, true)
  assert.equal(first.skill.action, "installed")
  assert.equal(Object.hasOwn(first, "mapping"), false)
  assert.equal(await hasFile(dshFile), false, "init 不创建项目映射")
  const skill = await readFile(path.join(root, ".dsh/skills/team-work-v3/SKILL.md"), "utf8")
  assert.match(skill, /team-work（v3）/)
  const second = await tw(["init"], { projectRoot: root })
  assert.equal(second.skill.action, "skipped")
  for (const key of ["writingSkill", "reviewSkill", "outputStandard"]) {
    assert.equal(first[key].action, "installed")
    assert.equal(second[key].action, "skipped")
  }
  assert.match(second.note, /版本混用待核/)
})

test("init 四目标：混合副本逐项保留，force 不触碰公共目录其他文件", async () => {
  const root = await makeProject()
  const base = path.join(root, ".dsh/skills")
  await mkdir(path.join(base, "team-work-v3"), { recursive: true })
  await writeFile(path.join(base, "team-work-v3/user-note.md"), "无入口也要保留")
  await mkdir(path.join(base, "clarity-guidance"), { recursive: true })
  await writeFile(path.join(base, "clarity-guidance/output-standard.md"), "已有自定义正文")
  await writeFile(path.join(base, "clarity-guidance/other.md"), "无关文件")
  const mixed = await tw(["init"], { projectRoot: root })
  assert.equal(mixed.skill.action, "skipped")
  assert.equal(mixed.outputStandard.action, "skipped")
  assert.equal(mixed.writingSkill.action, "installed")
  assert.equal(await readFile(path.join(base, "clarity-guidance/output-standard.md"), "utf8"), "已有自定义正文")
  const forced = await tw(["init", "--force"], { projectRoot: root })
  for (const key of ["skill", "writingSkill", "reviewSkill", "outputStandard"]) assert.equal(forced[key].action, "overwritten")
  assert.match(await readFile(path.join(base, "clarity-guidance/output-standard.md"), "utf8"), /clarity:required:begin/)
  assert.equal(await readFile(path.join(base, "clarity-guidance/other.md"), "utf8"), "无关文件")
  assert.equal((await readdir(base)).filter((name) => name.startsWith(".tw-init-")).length, 0)
})

test("init 符号链接逃逸：父路径和目标都逐项拒绝，外部内容保持", async () => {
  for (const parent of [true, false]) {
    const root = await makeProject()
    const outside = await mkdtemp(path.join(tmpdir(), "tw-init-outside-"))
    const original = path.join(outside, "SKILL.md")
    await writeFile(original, "外部原内容")
    const base = path.join(root, ".dsh/skills")
    if (parent) {
      await mkdir(path.join(root, ".dsh"))
      await symlink(outside, base)
    } else {
      await mkdir(base, { recursive: true })
      await symlink(outside, path.join(base, "team-work-v3"))
    }
    const result = await tw(["init", "--force"], { projectRoot: root })
    assert.equal(result.skill.action, "unavailable")
    assert.match(result.skill.note, /符号链接越出项目根/)
    assert.equal(await readFile(original, "utf8"), "外部原内容")
    if (parent) for (const key of ["writingSkill", "reviewSkill", "outputStandard"]) assert.equal(result[key].action, "unavailable")
  }
})

test("init 隔离坏源和暂存失败：不先删除已有目标，其他项独立完成", async () => {
  const packageRoot = await realpath(await mkdtemp(path.join(tmpdir(), "tw-init-source-")))
  for (const folder of ["runtime-v3", "policy"]) await cp(new URL("../" + folder, import.meta.url), path.join(packageRoot, folder), { recursive: true })
  for (const name of ["team-work-v3", "clarity-writing", "clarity-review"]) {
    await mkdir(path.join(packageRoot, "skills", name), { recursive: true })
    await writeFile(path.join(packageRoot, "skills", name, "SKILL.md"), "# 隔离技能")
  }
  await mkdir(path.join(packageRoot, "skills/clarity-guidance"))
  await writeFile(path.join(packageRoot, "skills/clarity-guidance/output-standard.md"), "坏标记")
  const { tw: isolatedTw } = await import(pathToFileURL(path.join(packageRoot, "runtime-v3/cli.mjs")))
  const root = await realpath(await makeProject())
  const publicTarget = path.join(root, ".dsh/skills/clarity-guidance/output-standard.md")
  await mkdir(path.dirname(publicTarget), { recursive: true })
  await writeFile(publicTarget, "最后有效内容")
  const result = await isolatedTw(["init", "--force"], { projectRoot: root })
  assert.equal(result.outputStandard.action, "unavailable")
  assert.match(result.outputStandard.note, /必读标记/)
  assert.equal(await readFile(publicTarget, "utf8"), "最后有效内容")
  assert.equal(result.writingSkill.action, "unavailable", "公共源不可用时先诊断，不安装缺依赖入口")
  assert.match(result.note, /部分失败/)
  const skillTarget = path.join(root, ".dsh/skills/team-work-v3")
  await writeFile(path.join(skillTarget, "SKILL.md"), "先前有效技能")
  for (const operation of ["cp", "rename"]) {
    const original = fsPromises[operation]
    const mocked = mock.method(fsPromises, operation, async (...args) => {
      const affected = operation === "cp" ? args[0] === path.join(packageRoot, "skills/team-work-v3") : args[1] === skillTarget && path.basename(args[0]) === "content"
      if (affected) { const error = new Error("隔离故障"); error.code = "EIO"; throw error }
      return original(...args)
    })
    try {
      const failed = await isolatedTw(["init", "--force"], { projectRoot: root })
      assert.equal(failed.skill.action, "unavailable", operation + " 失败应可见")
      assert.match(failed.skill.note, /EIO/)
      assert.equal(await readFile(path.join(skillTarget, "SKILL.md"), "utf8"), "先前有效技能", operation + " 失败保留最后有效内容")
    } finally { mocked.mock.restore() }
  }
  if (process.getuid?.() !== 0) {
    // 暂存目录创建被系统拒绝时，旧目录仍在原位置。
    const base = path.join(root, ".dsh/skills")
    await chmod(base, 0o555)
    try {
      const failed = await isolatedTw(["init", "--force"], { projectRoot: root })
      assert.equal(failed.skill.action, "unavailable")
      assert.match(await readFile(path.join(base, "team-work-v3/SKILL.md"), "utf8"), /先前有效技能/)
    } finally { await chmod(base, 0o755) }
  }
  // 发布与回滚都失败，即使目标被占位也不得把备份当垃圾删除。
  const rename = fsPromises.rename
  const fault = mock.method(fsPromises, "rename", async (from, to) => {
    if (to === skillTarget && path.basename(from) === "content") {
      await mkdir(to)
      await writeFile(path.join(to, "SKILL.md"), "故障占位，不是恢复的旧内容")
      const error = new Error("发布失败"); error.code = "EIO"; throw error
    }
    if (to === skillTarget && path.basename(from) === "previous") {
      const error = new Error("回滚失败"); error.code = "EIO"; throw error
    }
    return rename(from, to)
  })
  try {
    const failed = await isolatedTw(["init", "--force"], { projectRoot: root })
    assert.equal(failed.skill.action, "unavailable")
    const backup = failed.skill.note.match(/原内容备份保留在 (.+)$/)?.[1]
    assert.ok(backup, "回滚失败须给可恢复备份位置")
    assert.equal(await readFile(path.join(backup, "SKILL.md"), "utf8"), "先前有效技能")
    assert.match(await readFile(path.join(skillTarget, "SKILL.md"), "utf8"), /故障占位/)
  } finally { fault.mock.restore() }
})

test("init 新技能已知依赖：缺件、目录假冒与暂存丢失均保留旧有效入口", async () => {
  const packageRoot = await realpath(await mkdtemp(path.join(tmpdir(), "tw-init-dependencies-")))
  for (const folder of ["runtime-v3", "policy", "skills"]) await cp(new URL("../" + folder, import.meta.url), path.join(packageRoot, folder), { recursive: true })
  const { tw: isolatedTw } = await import(pathToFileURL(path.join(packageRoot, "runtime-v3/cli.mjs")))
  const root = await realpath(await makeProject())
  await isolatedTw(["init"], { projectRoot: root })
  const reviewTarget = path.join(root, ".dsh/skills/clarity-review")
  await writeFile(path.join(reviewTarget, "SKILL.md"), "旧有效审阅入口")
  for (const reference of ["review-rules", "standalone-records", "examples"]) {
    const source = path.join(packageRoot, "skills/clarity-review/references", reference + ".md")
    const body = await readFile(source, "utf8")
    await rm(source)
    const missing = await isolatedTw(["init", "--force"], { projectRoot: root })
    assert.equal(missing.reviewSkill.action, "unavailable")
    assert.ok(missing.reviewSkill.note.includes(source), "指出实际缺件")
    assert.equal(await readFile(path.join(reviewTarget, "SKILL.md"), "utf8"), "旧有效审阅入口")
    await mkdir(source)
    const directory = await isolatedTw(["init", "--force"], { projectRoot: root })
    assert.equal(directory.reviewSkill.action, "unavailable")
    assert.match(directory.reviewSkill.note, /普通文件/)
    await rm(source, { recursive: true })
    await writeFile(source, body)
  }
  const originalCopy = fsPromises.cp
  const fault = mock.method(fsPromises, "cp", async (from, to, options) => {
    await originalCopy(from, to, options)
    if (from === path.join(packageRoot, "skills/clarity-review")) await rm(path.join(to, "references/examples.md"))
  })
  try {
    const lost = await isolatedTw(["init", "--force"], { projectRoot: root })
    assert.equal(lost.reviewSkill.action, "unavailable")
    assert.match(lost.reviewSkill.note, /暂存资源.*examples\.md/)
    assert.equal(await readFile(path.join(reviewTarget, "SKILL.md"), "utf8"), "旧有效审阅入口")
  } finally { fault.mock.restore() }
  const writingTarget = path.join(root, ".dsh/skills/clarity-writing/SKILL.md")
  await writeFile(writingTarget, "旧有效写作入口")
  const publicSource = path.join(packageRoot, "skills/clarity-guidance/output-standard.md")
  await rm(publicSource)
  const noPublic = await isolatedTw(["init", "--force"], { projectRoot: root })
  assert.equal(noPublic.writingSkill.action, "unavailable")
  assert.equal(noPublic.reviewSkill.action, "unavailable")
  assert.ok(noPublic.writingSkill.note.includes(publicSource))
  assert.equal(await readFile(writingTarget, "utf8"), "旧有效写作入口")
  assert.equal(await readFile(path.join(reviewTarget, "SKILL.md"), "utf8"), "旧有效审阅入口")
  assert.match(noPublic.note, /部分失败/)
})

test("可选 effort：调用快照候选条目透传", async () => {
  await setConfig({ ...BASE_CONFIG, tiers: {
  "junior": {
    "provider": "vendor-junior",
    "model": "model-junior"
  },
  "senior": {
    "provider": "vendor-senior",
    "model": "model-senior",
    "effort": "high"
  },
  "expert": {
    "provider": "vendor-expert",
    "model": "model-expert"
  }
} })
  try {
    const resolved = await resolveTiers()
    assert.equal(resolved.tiers.senior.effort, "high")
  } finally {
    await setConfig(BASE_CONFIG)
  }
})

test("verdict 派单必须内嵌工具调用指令", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "vd-t")
  const first = await call(["dispatch-plan", "--task", "vd-t", "--writable", "R.md:code-review", "--json"])
  await writeFile(path.join(root, "R.md"), "x", "utf8")
  await call(["deliver", "--task", "vd-t", "--key", first.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  await call(["review", "--task", "vd-t", "--key", (await call(["dispatch-plan", "--task", "vd-t", "--json"])).waves[0].dispatchKey, "--recommendation", "accept", "--summary", "s"])
  const plan = await call(["dispatch-plan", "--task", "vd-t", "--json"])
  assert.equal(plan.waves[0].kind, "verdict")
  assert.match(plan.waves[0].prompt, /review --task vd-t --key /)
  assert.match(plan.waves[0].prompt, /--verdict/)
  assert.match(plan.waves[0].dispatchExample, /--verdict/)
})

test("dispatch-plan stop:blocked 的 blockers 保持对象数组", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "blk-t")
  const owner = await call(["dispatch-plan", "--task", "blk-t", "--writable", "R.md:code-review", "--json"])
  await writeFile(path.join(root, "R.md"), "x", "utf8")
  await call(["deliver", "--task", "blk-t", "--key", owner.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md", "--checks", '[{"name":"lint","result":"fail"}]'])
  const task = await loadTask(root, "blk-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const at = new Date().toISOString()
  const base = { dispatchKey: owner.waves[0].dispatchKey, round: 1, stage: "code-review", taskSha: "x" }
  await writeFile(path.join(task.root, "reports", "rc.json"), JSON.stringify({ reportId: "rc", role: "challenger", kind: "review", ...base, payload: { summary: "s", recommendation: "accept" }, at }))
  await writeFile(path.join(task.root, "reports", "re.json"), JSON.stringify({ reportId: "re", role: "expert", kind: "review", ...base, payload: { summary: "s", recommendation: "accept", verdict: { outcome: "accept", rationale: "r", confidence: "high", recommendedAction: "a" } }, at }))
  await call(["route", "--task", "blk-t", "--route", "e2e", "--decision", "skip", "--basis", "测试"])
  const gate = await call(["dispatch-plan", "--task", "blk-t", "--json"])
  assert.equal(gate.stop, "awaiting-user")
  assert.ok(gate.card.decisionId, "人工门决定卡由 dispatch 通道首签")
  await call(["decide", "--task", "blk-t", "--choice", "1"])
  const plan = await call(["dispatch-plan", "--task", "blk-t", "--json"])
  assert.equal(plan.stop, "blocked")
  assert.ok(Array.isArray(plan.card.blockers) && plan.card.blockers.every((blocker) => typeof blocker === "object" && blocker.recovery))
})

test("agent-map 只登记续派映射：agents.json 收敛纯 mappings、拒绝 --model-hint", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "snapshot-t")
  const plan = await call(["dispatch-plan", "--task", "snapshot-t", "--writable", "R.md:code-review", "--json"])
  assert.ok(plan.waves[0].modelHint?.provider && plan.waves[0].modelHint?.model, "dispatch-plan 仍输出 modelHint（tw-dispatch 的创建来源）")
  const mapped = await call(["agent-map", "--task", "snapshot-t", "--key", plan.waves[0].dispatchKey, "--agent", "child-a"])
  assert.equal(mapped.ok, true)
  assert.equal(mapped.agent, "child-a")
  assert.equal(mapped.modelHint, undefined, "agent-map 不再返回模型快照（模型选择由 tw-dispatch 创建时直接指定）")
  const agents = JSON.parse(await readFile(path.join(root, ".team-work", "tasks", "snapshot-t", "agents.json"), "utf8"))
  assert.equal(agents.mappings[plan.waves[0].dispatchKey], "child-a")
  assert.equal(agents.modelHints, undefined, "agents.json 不再落盘 modelHints")
  assert.equal(agents.tagHints, undefined)
  assert.equal(agents.pendingTags, undefined)
  const manual = await call(["agent-map", "--task", "snapshot-t", "--key", plan.waves[0].dispatchKey, "--agent", "child-b", "--model-hint", '{"provider":"other","model":"other"}'])
  assert.equal(manual.ok, false)
  assert.match(manual.message, /不接受 --model-hint/)
})

test("TW_CMD 覆盖派单内的成员工具调用指令", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "cmd-t")
  const previous = process.env.TW_CMD
  process.env.TW_CMD = "twx"
  try {
    const card = await call(["dispatch-plan", "--task", "cmd-t", "--writable", "R.md:code-review", "--json"])
    assert.match(card.waves[0].prompt, /twx deliver --task cmd-t/)
  } finally {
    if (previous === undefined) delete process.env.TW_CMD
    else process.env.TW_CMD = previous
  }
})

test("幂等重交：同 key 同 payload 不追加第二条 report-accepted", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "idem-t")
  const plan = await call(["dispatch-plan", "--task", "idem-t", "--writable", "R.md:code-review", "--json"])
  await writeFile(path.join(root, "R.md"), "x", "utf8")
  await call(["deliver", "--task", "idem-t", "--key", plan.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  const again = await call(["deliver", "--task", "idem-t", "--key", plan.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  assert.equal(again.idempotent, true)
  const task = await loadTask(root, "idem-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(task.journal.filter((event) => event.type === "report-accepted").length, 1)
})

test("help：调用快照模型来源与全部命令在场", async () => {
  const help = await tw(["help"])
  for (const command of ["open", "run", "dispatch-plan", "decide", "intent", "route", "gate", "models", "init", "restore", "archive", "deliver", "review"]) {
    assert.ok(help.commands[command], command)
  }
  const notes = help.notes.join("\n")
  assert.match(notes, /team-work-dsh\.tiers/)
  assert.match(notes, /TW_DSH_CONFIG/)
  assert.match(notes, /entryId.*profile/)
  assert.doesNotMatch(notes, /settingsFile|DSH_SETTINGS|settings\.yaml/)
})
