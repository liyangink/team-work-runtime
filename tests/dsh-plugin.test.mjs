// 新版客户端配置、档位输入与真实会话徽标的行为契约。
import assert from "node:assert/strict"
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import test from "node:test"
import vm from "node:vm"
import z from "@deepseek-ai/schemastery"
import { Config, validateTiers, readDshConfigSnapshot, systemPromptSection } from "../dsh/settings.js"
import { resolveTwExecutable, resolveChildCwd, twToolDefinition } from "../dsh/tw-tool.js"
import { parseFrontmatter, registerEmbeddedSkill } from "../dsh/skill-embed.js"

const tiers = () => ({
  junior: [{ provider: "provider-demo", model: "model-basic", family: "family-basic" }],
  senior: [{ provider: "provider-demo", model: "model-standard", effort: "high" }],
  expert: [{ provider: "provider-demo", model: "model-advanced" }],
})
const catalog = () => ({ groups: [{ id: "provider-demo", models: [
  { id: "model-basic", name: "基础模型" },
  { id: "model-standard", name: "常规模型", reasoning: { efforts: [{ id: "high", name: "高" }] } },
  { id: "model-advanced", name: "高级模型" },
] }], failures: [] })
const plain = (value) => JSON.parse(JSON.stringify(value))

function findTree(node, predicate) {
  if (!node || typeof node !== "object") return null
  if (predicate(node)) return node
  for (const child of node.props?.children ?? []) {
    const found = findTree(child, predicate)
    if (found) return found
  }
  return null
}
function hooks() {
  const state = [], dependencies = [], cleanup = [], effects = []
  let index = 0
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...props, children: children.flat(Infinity) } } },
    useState(initial) {
      const i = index++
      if (!(i in state)) state[i] = typeof initial === "function" ? initial() : initial
      return [state[i], (next) => { state[i] = typeof next === "function" ? next(state[i]) : next }]
    },
    useEffect(effect, deps) {
      const i = index++
      if (!dependencies[i] || deps.some((value, j) => !Object.is(value, dependencies[i][j]))) {
        dependencies[i] = deps
        effects.push(() => { cleanup[i]?.(); cleanup[i] = effect() })
      }
    },
  }
  return {
    React,
    render(component, props) { index = 0; return component(props) },
    async flush() { for (const effect of effects.splice(0)) effect(); await new Promise((resolve) => setTimeout(resolve, 0)) },
    dispose() { cleanup.forEach((off) => off?.()) },
  }
}
async function loadClient(React = {}) {
  let entry
  const source = await readFile(new URL("../dsh/client/badge.js", import.meta.url), "utf8")
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(value) { entry = value } } } })
  assert.equal(entry.id, "team-work-runtime")
  return entry.factory((name) => name === "react" ? React : { Input: "NativeInput", Button: "NativeButton" })
}
function form(initial = tiers()) {
  let snapshot = { status: "ready", writable: true, revision: "revision-one", value: { tiers: initial } }
  const listeners = new Set(), mutations = []
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    publish(value, revision) { snapshot = { ...snapshot, revision, value: { tiers: value } }; for (const listener of listeners) listener() },
    async mutate(ops, revision) {
      mutations.push({ ops: plain(ops), revision })
      if (revision !== snapshot.revision) return false
      this.publish(ops[0].value, "revision-two")
      return true
    },
    mutations, listeners,
  }
}
async function settingsHarness(options = {}) {
  const runtime = hooks(), cards = [], sources = []
  const shared = options.form ?? form(options.tiers)
  let servedOff = 0, slotOff = 0, triggerOff = 0
  const services = {
    configForms: {
      get(id) { assert.equal(id, "team-work-dsh"); return shared },
      whileServed(namespaces, register) {
        assert.deepEqual(Array.from(namespaces), ["team-work-dsh"])
        const off = register(new Set(namespaces))
        return () => { servedOff += 1; off?.() }
      },
    },
    slots: {
      inject(_name, install) { return install() },
      register(options, component) { cards.push({ options, component }); return () => { slotOff += 1 } },
    },
    inputTriggers: { registerSource(source) { sources.push(source); return () => { triggerOff += 1 } } },
    remote: {
      llm: { async listProviders() { return { ok: true, value: [{ id: "provider-demo", name: "示例 Provider" }] } } },
      session: { async modelCatalog() { return { ok: true, value: options.catalog ?? catalog() } } },
    },
    ...options.services,
  }
  const plugin = await loadClient(runtime.React)
  if (services.remote) {
    services["remote.llm"] = services.remote.llm
    services["remote.session"] = services.remote.session
    services.remote = new Proxy({}, { get() { throw new Error("命名空间直读未声明服务") } })
  }
  const dispose = plugin.apply({ get(name) { return services[name] }, logger: { warn() {} } })
  const card = cards.find(({ options }) => options.name === "plugins.bundle.config")
  const props = card?.options.inject()
  const render = () => runtime.render(card.component, props)
  return { runtime, shared, cards, sources, render, dispose, released: () => ({ servedOff, slotOff, triggerOff }), services }
}
const field = (tree, tier, position = 0) => {
  const section = findTree(tree, (node) => node.props?.["data-tw-tier"] === tier)
  const inputs = []
  function collect(node) {
    if (!node || typeof node !== "object") return
    if (node.type === "NativeInput") inputs.push(node)
    node.props?.children?.forEach(collect)
  }
  collect(section)
  return inputs[position]
}
const action = (tree, name) => findTree(tree, (node) => node.props?.["data-tw-action"] === name)

test("新版客户端：可选服务缺席仍能注册档位输入并随释放注销", async () => {
  const plugin = await loadClient()
  assert.deepEqual(Object.keys(plugin.inject), [])
  let released = 0
  const dispose = plugin.apply({
    get(name) { return name === "inputTriggers" ? { registerSource() { return () => { released += 1 } } } : undefined },
    logger: { warn() {} },
  })
  dispose()
  assert.equal(released, 1)
})

test("新版配置：唯一包页面只有编辑内容，原生字段与按钮随 served 生命周期释放", async () => {
  const h = await settingsHarness()
  assert.equal(h.cards.length, 1)
  assert.equal(h.cards[0].options.key, "team-work-runtime")
  const tree = h.render()
  assert.equal(tree.type, "div")
  assert.equal(findTree(tree, (node) => node.props?.["aria-expanded"] !== undefined), null)
  assert.ok(field(tree, "junior"))
  assert.equal(action(tree, "save-tiers").type, "NativeButton")
  assert.match(JSON.stringify(tree), /Provider 和模型必填，推理等级可选/)
  await h.runtime.flush()
  h.dispose()
  h.runtime.dispose()
  assert.deepEqual(h.released(), { servedOff: 1, slotOff: 1, triggerOff: 1 })
  assert.equal(h.shared.listeners.size, 0)
})

test("新版配置：候选增删、整份 tiers 原子保存，宿主读回确认才显示成功", async () => {
  const h = await settingsHarness()
  h.render(); await h.runtime.flush()
  let tree = h.render()
  field(tree, "junior", 1).props.onChange({ target: { value: "model-advanced" } })
  tree = h.render()
  await action(tree, "save-tiers").props.onClick()
  tree = h.render()
  assert.deepEqual(h.shared.mutations, [{ ops: [{ op: "set", path: ["tiers"], value: {
    junior: [{ provider: "provider-demo", model: "model-advanced", family: "family-basic" }],
    senior: [{ provider: "provider-demo", model: "model-standard", effort: "high" }],
    expert: [{ provider: "provider-demo", model: "model-advanced" }],
  } }], revision: "revision-one" }])
  assert.match(JSON.stringify(tree), /已保存并由宿主确认/)
  const section = findTree(tree, (node) => node.props?.["data-tw-tier"] === "junior")
  action(section, "add-candidate").props.onClick()
  tree = h.render()
  assert.equal(field(tree, "junior", 3).props.value, "")
  const remove = action(findTree(tree, (node) => node.props?.["data-tw-candidate"] === "junior-1"), "remove-candidate")
  remove.props.onClick()
  assert.equal(field(h.render(), "junior", 3), undefined)
  h.runtime.dispose(); h.dispose()
})

test("新版配置：外部更新不改草稿与编辑 revision，冲突拒绝后保留草稿", async () => {
  const h = await settingsHarness()
  h.render(); await h.runtime.flush()
  field(h.render(), "junior", 1).props.onChange({ target: { value: "model-advanced" } })
  const external = tiers()
  external.junior[0].model = "model-standard"
  h.shared.publish(external, "revision-external")
  let tree = h.render(); await h.runtime.flush()
  tree = h.render()
  assert.equal(field(tree, "junior", 1).props.value, "model-advanced")
  await action(tree, "save-tiers").props.onClick()
  assert.equal(h.shared.mutations[0].revision, "revision-one")
  tree = h.render()
  assert.match(JSON.stringify(tree), /草稿已保留/)
  assert.equal(field(tree, "junior", 1).props.value, "model-advanced")
  assert.equal(h.shared.getSnapshot().value.tiers.junior[0].model, "model-standard")
  action(tree, "reload-tiers").props.onClick()
  assert.equal(field(h.render(), "junior", 1).props.value, "model-standard")
  h.runtime.dispose(); h.dispose()
})

test("新版配置：保存拒绝、异常与读回不匹配均不显示成功且不丢草稿", async () => {
  for (const mode of ["reject", "throw", "mismatch"]) {
    const shared = form()
    shared.mutate = async () => {
      if (mode === "throw") throw new Error("配置传输中断")
      return mode === "mismatch"
    }
    const h = await settingsHarness({ form: shared })
    h.render(); await h.runtime.flush()
    field(h.render(), "junior", 1).props.onChange({ target: { value: "model-advanced" } })
    await action(h.render(), "save-tiers").props.onClick()
    const tree = h.render()
    assert.match(JSON.stringify(tree), /草稿已保留/)
    assert.doesNotMatch(JSON.stringify(tree), /已保存并由宿主确认/)
    assert.equal(field(tree, "junior", 1).props.value, "model-advanced")
    h.runtime.dispose(); h.dispose()
  }
})

test("新版配置：未知广告模型只标尚未验证，已保存值保留，缺字段和无效 effort 阻止提交", async () => {
  const checks = [
    ["provider", "", /Provider 为必填项/],
    ["model", "", /模型为必填项/],
    ["model", "model-unadvertised", /尚未验证.*未列出不代表不存在或不允许/],
    ["effort", "unsupported", /推理等级不在该模型公开的选项中/],
  ]
  for (const [name, value, expected] of checks) {
    const configured = tiers()
    configured.senior[0][name] = value
    const h = await settingsHarness({ tiers: configured })
    h.render(); await h.runtime.flush()
    const tree = h.render()
    assert.match(JSON.stringify(tree), expected)
    assert.equal(action(tree, "save-tiers").props.disabled, true)
    await action(tree, "save-tiers").props.onClick()
    assert.equal(h.shared.mutations.length, 0)
    if (name === "model") assert.equal(field(tree, "senior", 1).props.value, value)
    h.runtime.dispose(); h.dispose()
  }
})

test("新版配置：Provider/模型目录 RPC 失败不可宣称有效", async () => {
  const h = await settingsHarness({ services: { remote: { llm: { async listProviders() { return { ok: false, error: { message: "注册表不可用" } } } } } } })
  h.render(); await h.runtime.flush()
  const tree = h.render()
  assert.match(JSON.stringify(tree), /无法确认 Provider/)
  assert.equal(action(tree, "save-tiers").props.disabled, true)
  await action(tree, "save-tiers").props.onClick()
  assert.equal(h.shared.mutations.length, 0)
  h.runtime.dispose(); h.dispose()
})

test("新版配置：保存时重新确认 Provider，停用后不写入旧目录验证结果", async () => {
  let active = true
  const h = await settingsHarness({ services: { remote: {
    llm: { async listProviders() { return { ok: true, value: active ? [{ id: "provider-demo", name: "示例 Provider" }] : [] } } },
    session: { async modelCatalog() { return { ok: true, value: catalog() } } },
  } } })
  h.render(); await h.runtime.flush()
  active = false
  await action(h.render(), "save-tiers").props.onClick()
  assert.equal(h.shared.mutations.length, 0)
  assert.match(JSON.stringify(h.render()), /Provider 未处于 active 状态/)
  h.runtime.dispose(); h.dispose()
})

test("@ 档位：提交读取当前快照第一候选并转换原生 effort，缺档明确 unresolved", async () => {
  const h = await settingsHarness()
  const source = h.sources[0]
  assert.deepEqual(plain(await source.candidates(null, { query: "" })).map((item) => item.name), ["junior", "senior", "expert"])
  const picked = source.onPick({ candidate: { name: "senior" } })
  assert.equal(picked.insert.ref, "@senior")
  const changed = tiers()
  changed.senior = [{ provider: "provider-fresh", model: "model-fresh", effort: "max" }, { provider: "provider-demo", model: "model-standard" }]
  h.shared.publish(changed, "revision-fresh")
  const instruction = await source.codec.serialize("@senior")
  assert.match(instruction, /原生 subagent/)
  assert.match(instruction, /"provider":"provider-fresh","model":"model-fresh","reasoning_effort":"max"/)
  assert.match(instruction, /目录未列出时按 provider\+model 精确查询/)
  assert.match(instruction, /后台模式必须为 continuable/)
  assert.doesNotMatch(instruction, /tw-tool-subagent/)
  h.shared.publish({}, "revision-empty")
  assert.match(await source.codec.serialize("@senior"), /unresolved/)
  h.dispose()
})

test("会话徽标：新版 kit 模型投影显示真实请求，父会话不显示 tiers 意图", async () => {
  const runtime = hooks(), cards = []
  const services = {
    sessions: { subagentAddress() { return undefined } },
    slots: { inject(_name, install) { return install() }, register(options, component) { cards.push({ options, component }); return () => {} } },
  }
  const plugin = await loadClient(runtime.React)
  const dispose = plugin.apply({ get(name) { return services[name] }, logger: { warn() {} } })
  const badge = cards[0]
  assert.equal(badge.options.name, "conversation.input.right")
  const props = { ...badge.options.inject("child-demo"),
    useSession(selector) { return selector({ subagent: { address: { childSessionId: "child-demo" } }, running: false }) },
    useProjection(key, selector) {
      assert.equal(key, "modelSelection")
      return selector({ lastUsed: { provider: "provider-actual", model: "model-actual", reasoningEffort: "high" }, next: { provider: "provider-next", model: "model-next" } })
    },
  }
  assert.equal(runtime.render(badge.component, props).props.children.join(""), "provider-actual/model-actual · 推理 high")
  const parent = { ...props, useSession(selector) { return selector({ subagent: null, running: false }) } }
  assert.equal(runtime.render(badge.component, parent), null)
  runtime.dispose(); dispose()
})

test("会话徽标：projections 非激活 RPC 随运行刷新，拒绝不覆盖真实请求", async () => {
  const runtime = hooks(), cards = []
  let selection = { provider: "provider-before", model: "model-before", reasoningEffort: "low" }
  let rejected = false, calls = 0
  const services = {
    sessions: { subagentAddress() { return { childId: "child-demo" } } },
    slots: { inject(_name, install) { return install() }, register(options, component) { cards.push({ options, component }); return () => {} } },
    remote: { session: { async projections(request) {
      assert.equal(request.sessionId, "child-demo"); calls += 1
      if (rejected) return { ok: false, error: { message: "读盘失败" } }
      return { ok: true, value: { asOfSeq: 7, values: { modelSelection: { lastUsed: selection, next: null } } } }
    } } },
  }
  services["remote.session"] = services.remote.session
  services.remote = new Proxy({}, { get() { throw new Error("命名空间直读未声明服务") } })
  const plugin = await loadClient(runtime.React), dispose = plugin.apply({ get(name) { return services[name] }, logger: { warn() {} } })
  const badge = cards[0], props = { ...badge.options.inject("child-demo"), session: { running: false } }
  assert.equal(runtime.render(badge.component, props), null)
  await runtime.flush()
  assert.match(JSON.stringify(runtime.render(badge.component, props)), /provider-before\/model-before/)
  selection = { provider: "provider-after", model: "model-after", reasoningEffort: "max" }
  props.session.running = true
  runtime.render(badge.component, props); await runtime.flush()
  assert.match(JSON.stringify(runtime.render(badge.component, props)), /provider-after\/model-after.*max/)
  rejected = true
  props.session = { running: false, nodes: [{ kind: "assistant", requestConfig: { provider: "provider-recorded", model: "model-recorded", reasoningEffort: "high" } }] }
  runtime.render(badge.component, props); await runtime.flush()
  assert.match(JSON.stringify(runtime.render(badge.component, props)), /provider-recorded\/model-recorded.*high/)
  assert.equal(calls, 3)
  runtime.dispose(); dispose()
})

test("Config：普通根 object、volatile tiers 可重建且三档结构保持有效", () => {
  assert.equal(Config.type, "object")
  assert.equal(Config.dict.tiers.meta.volatile, true)
  assert.deepEqual(Config({}).tiers.get(), {})
  const rebuilt = new z(Config.toJSON())
  assert.deepEqual(rebuilt({ tiers: tiers() }).tiers.get(), tiers())
  for (const invalid of [
    { senior: { provider: "provider-demo", model: "model-basic" } },
    { ...tiers(), junior: [] },
    { ...tiers(), junior: [{ model: "model-basic" }] },
    { ...tiers(), junior: [{ provider: "provider-demo", model: "model-basic", effort: "" }] },
  ]) {
    assert.throws(() => validateTiers({ tiers: invalid }))
    assert.throws(() => rebuilt({ tiers: invalid }))
  }
})

test("Config：去 volatile 后再次序列化的浏览器表单仍可校验空与完整 tiers", () => {
  // 与宿主 plainSchema 的两次序列化边界一致；不是直接重建原始 Config。
  const field = new z(Config.dict.tiers.toJSON())
  function removeVolatile(node) {
    delete node.meta.volatile
    for (const child of Object.values(node.dict ?? {})) removeVolatile(child)
    if (node.inner) removeVolatile(node.inner)
    for (const child of node.list ?? []) removeVolatile(child)
  }
  removeVolatile(field)
  const projected = z.object({ tiers: field })
  const restored = new z(plain(projected.toJSON()))
  assert.deepEqual(restored({ tiers: {} }), { tiers: {} })
  assert.deepEqual(restored({ tiers: tiers() }), { tiers: tiers() })
})

test("宿主快照与动态指引：热更新读当前 tiers，不引入项目覆盖或默认模型", () => {
  let current = tiers()
  const config = { tiers: { get() { return current } } }
  const ctx = { get(name) { return name === "profileContext" ? { name: "profile-demo" } : undefined } }
  const snapshot = readDshConfigSnapshot(ctx, config)
  assert.equal(snapshot.entryId, "team-work-dsh")
  assert.equal(snapshot.profile, "profile-demo")
  current.senior[0].model = "model-new"
  assert.equal(snapshot.tiers.senior[0].model, "model-standard")
  const section = systemPromptSection(ctx, config)
  assert.match(section.text(), /model-new/)
  current = {}
  assert.match(section.text(), /unresolved/)
  assert.doesNotMatch(section.text(), /tw-tool-subagent/)
})

test("tw 工具与 skill：根制品寻址、缺 cwd 恢复、render 返回内容块", async () => {
  assert.match(resolveTwExecutable(), /bin\/tw\.mjs$/)
  assert.equal(resolveChildCwd({ agent: { session: { header: { cwd: "/tmp/project-demo" } } } }), "/tmp/project-demo")
  const tool = twToolDefinition()
  const failure = await tool.execute({ args: ["models"] }, {})
  assert.equal(failure.code, "TW_CWD_UNRESOLVED")
  const rendered = tool.output.render({}, { ok: true, message: "演示输出" })
  assert.equal(rendered[0].type, "text")
  assert.deepEqual(JSON.parse(rendered[0].text), { ok: true, message: "演示输出" })
  assert.deepEqual(parseFrontmatter("---\nname: demo\ndescription: '说明'\n---\n正文"), { name: "demo", description: "说明" })
})

test("三个随包技能独立注册与释放：默认根基址、自定义旧基址及失败隔离", async (t) => {
  const specs = [], released = [], warnings = []
  const ctx = { skills: { register(spec) { specs.push(spec); return () => released.push(spec.name) } }, logger: { warn(text) { warnings.push(text) } } }
  const dispose = await registerEmbeddedSkill(ctx, {})
  assert.deepEqual(specs.map((spec) => spec.name), ["team-work", "clarity-writing", "clarity-review"])
  for (const [spec, directory] of specs.map((spec, i) => [spec, ["team-work-v3", "clarity-writing", "clarity-review"][i]])) {
    assert.equal(spec.source, "team-work-runtime")
    assert.equal(spec.resourceBase.path, path.resolve("skills", directory))
    assert.equal(spec.content, await readFile(path.join(spec.resourceBase.path, "SKILL.md"), "utf8"))
  }
  dispose(); dispose()
  assert.deepEqual(released, ["clarity-review", "clarity-writing", "team-work"])
  const root = await mkdtemp(path.join(os.tmpdir(), "twr-custom-skill-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, "references"))
  await writeFile(path.join(root, "SKILL.md"), "---\nname: team-work\ndescription: 自定义入口\n---\n正文")
  specs.length = 0
  const customOff = await registerEmbeddedSkill(ctx, { skillDir: root })
  assert.equal(specs[0].resourceBase.path, path.join(root, "references"))
  assert.equal(specs[1].resourceBase.path, path.resolve("skills/clarity-writing"))
  customOff()
  const selected = [], off = []
  const isolated = { skills: { register(spec) { if (spec.name === "clarity-writing") throw new Error("条目失败"); selected.push(spec.name); return () => off.push(spec.name) } }, logger: ctx.logger }
  const isolatedOff = await registerEmbeddedSkill(isolated, { skillDir: path.join(root, "missing") })
  assert.deepEqual(selected, ["clarity-review"])
  assert.ok(warnings.some((text) => /team-work.*ENOENT/.test(text)))
  assert.ok(warnings.some((text) => /clarity-writing.*条目失败/.test(text)))
  isolatedOff()
  assert.deepEqual(off, ["clarity-review"])
})

test("插件技能一条失败不影响另两条和两工具，禁用收拢真实释放函数", async () => {
  const plugin = await import("../dsh/index.js")
  const registered = [], released = [], warnings = []
  const ctx = { skills: { register(spec) { if (spec.name === "clarity-writing") throw new Error("失败示例"); registered.push(spec.name); return () => released.push(spec.name) } }, tools: { register(def) { registered.push(def.name); return () => released.push(def.name) } }, logger: { warn(text) { warnings.push(text) } } }
  const dispose = await plugin.apply(ctx, {})
  assert.deepEqual(registered, ["team-work", "clarity-review", "tw", "tw-dispatch"])
  assert.ok(warnings.some((text) => /clarity-writing.*失败示例/.test(text)))
  dispose()
  assert.deepEqual(released, ["tw-dispatch", "tw", "clarity-review", "team-work"])
})
