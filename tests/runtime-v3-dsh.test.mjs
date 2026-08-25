// DSH 绑定：全局 settings tier 解析、dispatch-plan、models、init 与模型快照。
import assert from "node:assert/strict"
import { writeFile, readFile, access, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { tw } from "../runtime-v3/cli.mjs"
import { loadTask } from "../runtime-v3/store.mjs"
import { parseTeamWorkDshSettings, resolveTiers, validateTierSettings, TIERS } from "../runtime-v3/dsh-map.mjs"
import { FIX_WORKFLOW, FIX_POLICY, makeProject, caller, openTask, seedConvergedStage } from "./support/v3-fixtures.mjs"

const settingsFile = path.join(tmpdir(), `tw-global-tiers-${process.pid}-${Date.now()}.yaml`)
const BASE_SETTINGS = `
unrelated-section:
  enabled: true
team-work-dsh:
  tiers:
    junior:
      provider: vendor-junior
      model: model-junior
    senior:
      provider: vendor-senior
      model: model-senior
    expert:
      provider: vendor-expert
      model: model-expert
`
await writeFile(settingsFile, BASE_SETTINGS)
process.env.DSH_SETTINGS = settingsFile

async function setSettings(text) {
  await writeFile(settingsFile, text)
}

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

test("全局 settings：解析 team-work-dsh.tiers 的引号、注释、对象与数组", () => {
  const tiers = parseTeamWorkDshSettings(`
other-section:
  ignored: true
team-work-dsh:
  # 此区段是 runtime 的唯一模型配置来源
  injectionEnabled: true # 旧根键由插件迁移；runtime 不将其作为 tier
  projectRoots: [legacy-root]
  twBin: legacy-tw
  tiers:
    junior: { provider: "vendor-one", model: 'model-one' } # 行尾注释
    senior:
      - provider: vendor-two
        model: model-two
        family: two
    expert: [{ provider: vendor-three, model: model-three, effort: high }]
`)
  assert.deepEqual(JSON.parse(JSON.stringify(tiers)), {
    junior: { provider: "vendor-one", model: "model-one" },
    senior: [{ provider: "vendor-two", model: "model-two", family: "two" }],
    expert: [{ provider: "vendor-three", model: "model-three", effort: "high" }],
  })
})

test("全局 settings：block 与 flow 特殊 tier 键保持自有并标记 MAP_INVALID", () => {
  const block = (key) => `
team-work-dsh:
  tiers:
    ${key}:
      twYamlTierPolluted: true
      junior: { provider: isolated-provider, model: isolated-junior }
      senior: { provider: isolated-provider, model: isolated-senior }
      expert: { provider: isolated-provider, model: isolated-expert }
`
  const flow = (key) => `team-work-dsh: { tiers: { ${key}: { twYamlTierPolluted: true, junior: { provider: isolated-provider, model: isolated-junior }, senior: { provider: isolated-provider, model: isolated-senior }, expert: { provider: isolated-provider, model: isolated-expert } } } }`
  for (const [style, source] of [["block", block], ["flow", flow]]) {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const tiers = parseTeamWorkDshSettings(source(key))
      assert.equal(Object.getPrototypeOf(tiers), null, `${style}/${key} tier 映射没有原型`)
      assert.equal(Object.hasOwn(tiers, key), true, `${style}/${key} 是自有未知键`)
      for (const tier of TIERS) assert.equal(Object.hasOwn(tiers, tier), false, `${style}/${key} 不继承 ${tier}`)
      const invalid = validateTierSettings(tiers, { file: settingsFile })
      for (const tier of TIERS) assert.equal(invalid.tiers[tier].source, "unresolved")
      assert.match(invalid.warnings.join("\n"), /MAP_INVALID/)
      assert.match(invalid.warnings.join("\n"), new RegExp(`未知档位.*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))
    }
  }
  assert.equal(Object.hasOwn(Object.prototype, "twYamlTierPolluted"), false, "YAML 不能污染 Object.prototype")
})

test("全局 settings：继承 tier 或候选 provider/model 不能通过完整性", () => {
  const inheritedTiers = Object.create({
    junior: { provider: "inherited-provider", model: "inherited-junior" },
    senior: { provider: "inherited-provider", model: "inherited-senior" },
    expert: { provider: "inherited-provider", model: "inherited-expert" },
  })
  const missingOwnTiers = validateTierSettings(inheritedTiers, { file: settingsFile })
  for (const tier of TIERS) assert.equal(missingOwnTiers.tiers[tier].source, "unresolved")

  const tiers = Object.create(null)
  tiers.junior = Object.create({ provider: "inherited-provider", model: "inherited-junior" })
  tiers.senior = { provider: "own-provider", model: "own-senior" }
  tiers.expert = { provider: "own-provider", model: "own-expert" }
  const inheritedCandidate = validateTierSettings(tiers, { file: settingsFile })
  assert.equal(inheritedCandidate.tiers.junior.source, "unresolved")
  assert.equal(inheritedCandidate.tiers.senior.source, "global-settings")
  assert.match(inheritedCandidate.warnings.join("\n"), /provider 与 model 必须是非空字符串/)

  const yamlSources = [
    `
team-work-dsh:
  tiers:
    junior:
      __proto__: { provider: inherited-provider, model: inherited-junior }
    senior: { provider: own-provider, model: own-senior }
    expert: { provider: own-provider, model: own-expert }
`,
    `team-work-dsh: { tiers: { junior: { __proto__: { provider: inherited-provider, model: inherited-junior } }, senior: { provider: own-provider, model: own-senior }, expert: { provider: own-provider, model: own-expert } } }`,
  ]
  for (const source of yamlSources) {
    const parsed = parseTeamWorkDshSettings(source)
    assert.equal(Object.getPrototypeOf(parsed.junior), null)
    const rejected = validateTierSettings(parsed, { file: settingsFile })
    assert.equal(rejected.tiers.junior.source, "unresolved")
  }
})

test("dispatch-plan：__proto__ tier 映射 MAP_INVALID 且零派发", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "prototype-tier")
  await setSettings(`team-work-dsh: { tiers: { __proto__: { junior: { provider: isolated-provider, model: isolated-junior }, senior: { provider: isolated-provider, model: isolated-senior }, expert: { provider: isolated-provider, model: isolated-expert } } } }`)
  try {
    const plan = await call(["dispatch-plan", "--task", "prototype-tier", "--writable", "R.md:code-review", "--json"])
    assert.equal(plan.stop, "blocked")
    assert.match(plan.warnings.join("\n"), /MAP_INVALID/)
    assert.match(plan.warnings.join("\n"), /未知档位.*__proto__/)
    const task = await loadTask(root, "prototype-tier", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
    assert.equal(task.journal.some((event) => event.type === "dispatched"), false)
  } finally {
    await setSettings(BASE_SETTINGS)
  }
})

test("全局 settings：三档候选池是唯一解析来源，缺档显式 unresolved", async () => {
  const file = path.join(tmpdir(), `tw-global-partial-${process.pid}-${Date.now()}.yaml`)
  await writeFile(file, `
team-work-dsh:
  tiers:
    junior:
      provider: vendor-junior
      model: model-junior
    senior:
      - provider: vendor-senior-a
        model: model-senior-a
        family: senior-a
      - provider: vendor-senior-b
        model: model-senior-b
        family: senior-b
`)
  const resolved = await resolveTiers({ settingsFile: file })
  assert.equal(resolved.file, file)
  assert.equal(resolved.tiers.junior.model, "model-junior")
  assert.equal(resolved.tiers.junior.source, "global-settings")
  assert.deepEqual(resolved.tiers.senior.pool.map((candidate) => candidate.model), ["model-senior-a", "model-senior-b"])
  assert.equal(resolved.tiers.expert.source, "unresolved")
  assert.match(resolved.warnings.join("\n"), /expert/)
})

test("全局 settings：provider/model 必填，损坏项与缺失文件都不回退", async () => {
  const invalid = validateTierSettings({
    junior: { provider: "vendor-junior", model: "model-junior" },
    senior: { provider: "", model: "model-senior" },
    expert: { provider: "vendor-expert" },
  }, { file: settingsFile })
  assert.equal(invalid.tiers.junior.source, "global-settings")
  assert.equal(invalid.tiers.senior.source, "unresolved")
  assert.equal(invalid.tiers.expert.source, "unresolved")
  assert.match(invalid.warnings.join("\n"), /provider 与 model 必须是非空字符串/)

  const missing = await resolveTiers({ settingsFile: path.join(tmpdir(), `no-global-settings-${Date.now()}.yaml`) })
  for (const tier of TIERS) assert.equal(missing.tiers[tier].source, "unresolved")
  assert.match(missing.warnings.join("\n"), /未找到全局 DSH settings/)
})

test("全局 settings：未知档位使映射 MAP_INVALID，models 显示且 dispatch-plan 阻断", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "unknown-tier")
  await setSettings(`
team-work-dsh:
  tiers:
    junior: { provider: vendor-junior, model: model-junior }
    senior: { provider: vendor-senior, model: model-senior }
    expert: { provider: vendor-expert, model: model-expert }
    legacy: { provider: vendor-legacy, model: model-legacy }
`)
  try {
    const resolved = await resolveTiers()
    for (const tier of TIERS) assert.equal(resolved.tiers[tier].source, "unresolved")
    assert.match(resolved.warnings.join("\n"), /MAP_INVALID/)
    assert.match(resolved.warnings.join("\n"), /未知档位.*legacy/)
    assert.match(resolved.warnings.join("\n"), /只允许 junior、senior、expert/)

    const models = await call(["models"])
    assert.match(models.warnings.join("\n"), /MAP_INVALID/)
    assert.match(models.warnings.join("\n"), /未知档位.*legacy/)

    const plan = await call(["dispatch-plan", "--task", "unknown-tier", "--writable", "R.md:code-review", "--json"])
    assert.equal(plan.stop, "blocked")
    assert.equal(plan.card.status, "blocked")
    assert.match(plan.warnings.join("\n"), /MAP_INVALID/)
    const task = await loadTask(root, "unknown-tier", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
    assert.equal(task.journal.some((event) => event.type === "dispatched"), false)
  } finally {
    await setSettings(BASE_SETTINGS)
  }
})

test("settings 路径优先级：显式 > DSH_SETTINGS > DSH_HOME，并由 models/dispatch-plan 共用", async () => {
  const home = path.join(tmpdir(), `tw-dsh-home-${process.pid}-${Date.now()}`)
  const homeFile = path.join(home, "settings.yaml")
  const envFile = path.join(tmpdir(), `tw-dsh-env-${process.pid}-${Date.now()}.yaml`)
  const explicitFile = path.join(tmpdir(), `tw-dsh-explicit-${process.pid}-${Date.now()}.yaml`)
  const settingsFor = (model) => `
team-work-dsh:
  tiers:
    junior: { provider: priority-vendor, model: ${model} }
    senior: { provider: priority-vendor, model: ${model}-senior }
    expert: { provider: priority-vendor, model: ${model}-expert }
`
  await mkdir(home, { recursive: true })
  await Promise.all([
    writeFile(homeFile, settingsFor("home-model")),
    writeFile(envFile, settingsFor("env-model")),
    writeFile(explicitFile, settingsFor("explicit-model")),
  ])

  await withEnvironment({ DSH_SETTINGS: envFile, DSH_HOME: home }, async () => {
    assert.equal((await resolveTiers()).file, envFile)
    assert.equal((await resolveTiers({ settingsFile: explicitFile })).file, explicitFile)
  })
  await withEnvironment({ DSH_SETTINGS: undefined, DSH_HOME: home }, async () => {
    const resolved = await resolveTiers()
    assert.equal(resolved.file, homeFile)
    assert.equal(resolved.tiers.junior.model, "home-model")

    const root = await makeProject()
    const call = caller(root)
    const models = await call(["models"])
    assert.equal(models.file, homeFile)
    assert.equal(models.tiers.find((tier) => tier.tier === "junior").model, "home-model")

    await openTask(root, "home-source")
    const plan = await call(["dispatch-plan", "--task", "home-source", "--writable", "R.md:code-review", "--json"])
    assert.equal(plan.modelSettings.file, homeFile)
    assert.equal(plan.waves[0].modelHint.model, "home-model")
  })
  assert.equal(process.env.DSH_SETTINGS, settingsFile, "测试后恢复默认 DSH_SETTINGS")
})

test("dispatch-plan：全局映射生效，遗留项目 dsh.json 被完全忽略", async () => {
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
  assert.equal(wave.modelHint.source, "global-settings")
  assert.deepEqual(plan.modelSettings, { source: "global-settings", file: settingsFile, path: "team-work-dsh.tiers" })
  assert.equal(await readFile(legacy, "utf8"), legacyContent, "遗留文件未被读取后覆盖或改写")

  const task = await loadTask(root, "plan-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const dispatched = task.journal.filter((event) => event.type === "dispatched")
  assert.equal(dispatched.length, 1)
  assert.deepEqual(dispatched[0].detail.modelHint, wave.modelHint, "模型选择与 dispatch-plan 同一事实快照")
  const again = await call(["dispatch-plan", "--task", "plan-t", "--writable", "R.md:code-review", "--json"])
  assert.equal(again.stop, "wait-inflight", "在途波次不重复派发")
})

test("dispatch-plan：无全局模型配置返回可恢复 blocked，且不写 dispatched 事实", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "no-models")
  await setSettings("team-work-dsh:\n  tiers: {}\n")
  try {
    const plan = await call(["dispatch-plan", "--task", "no-models", "--writable", "R.md:code-review", "--json"])
    assert.equal(plan.ok, true)
    assert.equal(plan.stop, "blocked")
    assert.equal(plan.card.status, "blocked")
    assert.equal(plan.card.next, "configure-models")
    assert.equal(plan.card.blockers[0].code, "MODEL_CONFIG_UNRESOLVED")
    assert.match(plan.card.blockers[0].recovery, /team-work-dsh\.tiers/)
    const task = await loadTask(root, "no-models", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
    assert.equal(task.journal.some((event) => event.type === "dispatched"), false)
  } finally {
    await setSettings(BASE_SETTINGS)
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

test("models 只读全局来源；init 只安装 skill，不创建项目 dsh.json", async () => {
  const root = await makeProject()
  const call = caller(root)
  const dshFile = path.join(root, ".team-work", "platform", "dsh.json")
  const models = await call(["models"])
  assert.equal(models.ok, true)
  assert.equal(models.source, "global-settings")
  assert.equal(models.file, settingsFile)
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
})

test("effort 预留字段：全局候选条目透传", async () => {
  await setSettings(`
team-work-dsh:
  tiers:
    junior: { provider: vendor-junior, model: model-junior }
    senior: { provider: vendor-senior, model: model-senior, effort: high }
    expert: { provider: vendor-expert, model: model-expert }
`)
  try {
    const resolved = await resolveTiers()
    assert.equal(resolved.tiers.senior.effort, "high")
  } finally {
    await setSettings(BASE_SETTINGS)
  }
})

test("verdict 派单必须内嵌工具调用指令", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "vd-t")
  const first = await call(["run", "--task", "vd-t", "--writable", "R.md:code-review"])
  await writeFile(path.join(root, "R.md"), "x", "utf8")
  await call(["deliver", "--task", "vd-t", "--key", first.dispatch.key, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  await call(["review", "--task", "vd-t", "--key", (await call(["run", "--task", "vd-t"])).dispatch.key, "--recommendation", "accept", "--summary", "s"])
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
  const owner = await call(["run", "--task", "blk-t", "--writable", "R.md:code-review"])
  await writeFile(path.join(root, "R.md"), "x", "utf8")
  await call(["deliver", "--task", "blk-t", "--key", owner.dispatch.key, "--outcome", "delivered", "--summary", "s", "--paths", "R.md", "--checks", '[{"name":"lint","result":"fail"}]'])
  const task = await loadTask(root, "blk-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const at = new Date().toISOString()
  const base = { dispatchKey: owner.dispatch.key, round: 1, stage: "code-review", taskSha: "x" }
  await writeFile(path.join(task.root, "reports", "rc.json"), JSON.stringify({ reportId: "rc", role: "challenger", kind: "review", ...base, payload: { summary: "s", recommendation: "accept" }, at }))
  await writeFile(path.join(task.root, "reports", "re.json"), JSON.stringify({ reportId: "re", role: "expert", kind: "review", ...base, payload: { summary: "s", recommendation: "accept", verdict: { outcome: "accept", rationale: "r", confidence: "high", recommendedAction: "a" } }, at }))
  await call(["route", "--task", "blk-t", "--route", "e2e", "--decision", "skip", "--basis", "测试"])
  const gate = await call(["run", "--task", "blk-t"])
  assert.equal(gate.status, "awaiting-user")
  await call(["decide", "--task", "blk-t", "--choice", "1"])
  const plan = await call(["dispatch-plan", "--task", "blk-t", "--json"])
  assert.equal(plan.stop, "blocked")
  assert.ok(Array.isArray(plan.card.blockers) && plan.card.blockers.every((blocker) => typeof blocker === "object" && blocker.recovery))
})

test("agent-map 复制 dispatch-plan 模型快照，不因全局配置热变或手工覆盖漂移", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "snapshot-t")
  const plan = await call(["dispatch-plan", "--task", "snapshot-t", "--writable", "R.md:code-review", "--json"])
  const selected = plan.waves[0].modelHint
  await setSettings(`
team-work-dsh:
  tiers:
    junior: { provider: changed-vendor, model: changed-model }
    senior: { provider: changed-vendor, model: changed-senior }
    expert: { provider: changed-vendor, model: changed-expert }
`)
  try {
    const mapped = await call(["agent-map", "--task", "snapshot-t", "--key", plan.waves[0].dispatchKey, "--agent", "child-a"])
    assert.deepEqual(mapped.modelHint, selected)
    const agents = JSON.parse(await readFile(path.join(root, ".team-work", "platform", "agents.json"), "utf8"))
    assert.deepEqual(agents.modelHints["child-a"], selected)
    const manual = await call(["agent-map", "--task", "snapshot-t", "--key", plan.waves[0].dispatchKey, "--agent", "child-b", "--model-hint", '{"provider":"other","model":"other"}'])
    assert.equal(manual.ok, false)
    assert.match(manual.message, /不接受 --model-hint/)
  } finally {
    await setSettings(BASE_SETTINGS)
  }
})

test("TW_CMD 覆盖派单内的成员工具调用指令", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "cmd-t")
  const previous = process.env.TW_CMD
  process.env.TW_CMD = "twx"
  try {
    const card = await call(["run", "--task", "cmd-t", "--writable", "R.md:code-review"])
    assert.match(card.dispatch.prompt, /twx deliver --task cmd-t/)
  } finally {
    if (previous === undefined) delete process.env.TW_CMD
    else process.env.TW_CMD = previous
  }
})

test("幂等重交：同 key 同 payload 不追加第二条 report-accepted", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "idem-t")
  const dispatch = await call(["run", "--task", "idem-t", "--writable", "R.md:code-review"])
  await writeFile(path.join(root, "R.md"), "x", "utf8")
  await call(["deliver", "--task", "idem-t", "--key", dispatch.dispatch.key, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  const again = await call(["deliver", "--task", "idem-t", "--key", dispatch.dispatch.key, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  assert.equal(again.idempotent, true)
  const task = await loadTask(root, "idem-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(task.journal.filter((event) => event.type === "report-accepted").length, 1)
})

test("help：全局模型来源与全部命令在场", async () => {
  const help = await tw(["help"])
  for (const command of ["open", "run", "dispatch-plan", "decide", "intent", "route", "gate", "models", "init", "restore", "archive", "deliver", "review"]) {
    assert.ok(help.commands[command], command)
  }
  const notes = help.notes.join("\n")
  assert.match(notes, /team-work-dsh\.tiers/)
  assert.match(notes, /显式 settingsFile（内部调用参数） > DSH_SETTINGS > \$DSH_HOME\/settings\.yaml > ~\/\.dsh\/settings\.yaml/)
})
