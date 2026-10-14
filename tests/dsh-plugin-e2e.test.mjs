// 显式选定新版隔离宿主，验证真实 Cordis 生命周期；不读取用户的宿主或 profile。
import assert from "node:assert/strict"
import { readFile, mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import { createRequire } from "node:module"
import path from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"
import vm from "node:vm"
import { coldSessionReceived } from "../dsh/subagent-session.js"

async function hostContext(t) {
  const host = process.env.DSH_TEST_HOST
  if (!host) { t.skip("未指定 DSH_TEST_HOST；新版隔离宿主验证未执行"); return null }
  const metadata = JSON.parse(await readFile(path.join(host, "package.json"), "utf8"))
  assert.equal(metadata.name, "@deepseek-ai/dsh")
  assert.equal(metadata.version, "0.2.0-rc.2", "只使用本次已核验的宿主版本")
  const require = createRequire(path.join(host, "package.json"))
  const { Context } = await import(pathToFileURL(require.resolve("@deepseek-ai/cordis")).href)
  return new Context({ _isRoot: true })
}
test("新版真实 Cordis：空 tiers 可启动，只注册 tw/tw-dispatch 和内嵌 skill", async (t) => {
  const ctx = await hostContext(t)
  if (!ctx) return
  const plugin = await import("../dsh/index.js")
  const registered = [], configurations = []
  ctx.provide("subagents", {})
  ctx.provide("skills", { register(spec) { registered.push(["skill", spec.name]); return () => {} } })
  ctx.provide("tools", { register(definition) { registered.push(["tool", definition.name]); return () => {} } })
  ctx.provide("settings", { configure(options) { configurations.push(options); return () => {} } })
  const fiber = ctx.plugin(plugin, {})
  await fiber
  assert.deepEqual(registered.filter(([kind]) => kind === "tool").map(([, name]) => name), ["tw", "tw-dispatch"])
  assert.deepEqual(registered.filter(([kind]) => kind === "skill").map(([, name]) => name), ["team-work", "clarity-writing", "clarity-review"])
  assert.deepEqual(configurations, [{ auto: false }])
  await fiber.dispose()
})

test("新版真实 skill 工具：随包正文/相邻资源/来源优先级及插件独立释放", async (t) => {
  const ctx = await hostContext(t)
  if (!ctx) return
  const host = process.env.DSH_TEST_HOST
  const require = createRequire(path.join(host, "package.json"))
  const { SkillRegistry } = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-skill")).href)
  const { SandboxedFileSystem } = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-fs-sandbox")).href)
  const skillToolPlugin = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-tool-skill")).href)
  const runtimePlugin = await import("../dsh/index.js")
  const tools = new Map()
  ctx.provide("tools", { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) }, get(name) { return tools.get(name) } })
  ctx.provide("agents", {})
  ctx.provide("subagents", {})
  ctx.provide("sandboxPolicy", { defaultMode: "read-only", resolve: () => ({ mode: "read-only" }) })
  const filesystemBackend = ctx.plugin(SandboxedFileSystem, {})
  await filesystemBackend
  const registry = ctx.plugin(SkillRegistry)
  await registry
  const loader = ctx.plugin(skillToolPlugin)
  await loader
  const installed = ctx.plugin(runtimePlugin)
  await installed
  const skillTool = tools.get("skill")
  const cwd = await mkdtemp(path.join(os.tmpdir(), "twr-skill-host-"))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const exec = { agent: { id: "agent-example", session: { header: { cwd } } }, signal: new AbortController().signal }
  for (const [name, directory] of [["team-work", "team-work-v3"], ["clarity-writing", "clarity-writing"], ["clarity-review", "clarity-review"]]) {
    const loaded = await skillTool.execute({ name }, exec)
    assert.equal(loaded.provider, "runtime")
    assert.equal(loaded.resourceBase.path, path.resolve("skills", directory))
    assert.equal(loaded.content, await readFile(path.join(loaded.resourceBase.path, "SKILL.md"), "utf8"))
    assert.match(skillTool.output.render({ name }, loaded)[0].text, new RegExp(name))
    const resource = name === "team-work" ? "references/scenarios.md" : "../clarity-guidance/output-standard.md"
    const target = await ctx.fs.resolve(path.resolve(loaded.resourceBase.path, resource))
    assert.ok((await ctx.fs.readText(target, exec.signal)).length > 0)
    if (name === "clarity-review") assert.ok((await ctx.fs.readText(await ctx.fs.resolve(path.join(loaded.resourceBase.path, "references/review-rules.md")), exec.signal)).length > 0)
  }
  // 真实 filesystem provider 在临时根里产生项目/用户来源，不访问个人技能。
  const filesystemPlugin = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-skill-filesystem")).href)
  const project = path.join(cwd, "project-example")
  const isolatedUser = path.join(cwd, "user-example")
  const projectSkill = path.join(project, ".dsh/skills/clarity-writing")
  await mkdir(path.join(project, ".git"), { recursive: true })
  await mkdir(path.join(isolatedUser, "skills/clarity-writing"), { recursive: true })
  await writeFile(path.join(isolatedUser, "skills/clarity-writing/SKILL.md"), "---\nname: clarity-writing\ndescription: 用户来源\n---\n用户正文")
  exec.agent.session.header.cwd = project
  const filesystem = ctx.plugin(filesystemPlugin, { dshHome: isolatedUser, agentsHome: path.join(cwd, "agents-empty"), bundledSkillDir: path.join(cwd, "bundled-empty"), watch: false })
  await filesystem
  assert.equal((await skillTool.execute({ name: "clarity-writing" }, exec)).provider, "runtime")
  await mkdir(projectSkill, { recursive: true })
  await writeFile(path.join(projectSkill, "SKILL.md"), "---\nname: clarity-writing\ndescription: 项目来源\n---\n项目正文")
  ctx.skills.invalidateCache()
  const projectLoaded = await skillTool.execute({ name: "clarity-writing" }, exec)
  assert.equal(projectLoaded.provider, "filesystem")
  assert.equal(projectLoaded.content, "项目正文")
  assert.equal(projectLoaded.resourceBase.path, projectSkill)
  await rm(projectSkill, { recursive: true })
  ctx.skills.invalidateCache()
  const duplicateOff = ctx.skills.register({ name: "clarity-writing", description: "重复条目", source: "duplicate-example", content: "不得替换" })
  duplicateOff()
  assert.notEqual((await skillTool.execute({ name: "clarity-writing" }, exec)).content, "不得替换")
  await installed.dispose()
  assert.equal((await skillTool.execute({ name: "clarity-writing" }, exec)).content, "用户正文")
  assert.equal((await ctx.skills.get("clarity-writing", { cwd: project, scope: exec.agent })).source, "user-dsh")
  assert.equal(await ctx.skills.get("clarity-review", { cwd: project, scope: exec.agent }), undefined)
  await filesystem.dispose()
  await loader.dispose()
  await registry.dispose()
  await filesystemBackend.dispose()
  t.diagnostic("实际 skill 工具、filesystem 选源和 read-only SandboxedFileSystem 相邻资源读取通过；这是宿主文件接口权限，不是内核 shell sandbox。")
})

test("新版真实 JSONL 后端：两文本块冷持久读取保留，更新规则不改变本轮业务收单", async (t) => {
  const ctx = await hostContext(t)
  if (!ctx) return
  const require = createRequire(path.join(process.env.DSH_TEST_HOST, "package.json"))
  const { default: JsonlPersistence } = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-session-persistence-jsonl")).href)
  const { createUserMessage } = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-llm")).href)
  const root = await mkdtemp(path.join(os.tmpdir(), "twr-message-blocks-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const backend = ctx.plugin(JsonlPersistence, { root, compression: "none" })
  await backend
  const persistence = ctx.get("sessionPersistence")
  const content = [{ type: "text", text: "本轮业务派单" }, { type: "text", text: "原规则必读短段" }]
  const writer = await persistence.create({ id: "child-example", version: 4, createdAt: 0, isSeeded: false, delegationDepth: 1, cwd: root, parentSession: "parent-example", origin: "subagent" })
  try {
    await writer.append([{ type: "agent/inbox/spliced", seq: 0, time: 0, data: { target: "next-turn", start: 0, inserted: [createUserMessage({ content, source: { kind: "user" } })] } }])
    await writer.flush()
  } finally { await writer.close() }
  const reader = await persistence.open("child-example", "read")
  try { assert.deepEqual((await reader.read()).events[0].data.inserted[0].content, content) } finally { await reader.close() }
  assert.deepEqual(await coldSessionReceived(persistence, "child-example", undefined, ["本轮业务派单"]), { ok: true, received: true, currentReceived: true })
  await backend.dispose()
  const reopened = ctx.plugin(JsonlPersistence, { root, compression: "none" })
  await reopened
  assert.deepEqual(await coldSessionReceived(ctx.get("sessionPersistence"), "child-example", undefined, ["本轮业务派单"]), { ok: true, received: true, currentReceived: true })
  await reopened.dispose()
  t.diagnostic("真实 JSONL 后端跨实例保存和冷读通过；start/send 的完整宿主调度与真实模型未在此测试中执行。")
})

test("新版真实 Cordis：客户端只等各功能依赖，服务迟到可注册，dispose 释放所有贡献", async (t) => {
  const ctx = await hostContext(t)
  if (!ctx) return
  let entry
  vm.runInNewContext(await readFile(new URL("../dsh/client/badge.js", import.meta.url), "utf8"), {
    window: { __ModuleLoader__: { load(registration) { entry = registration } } },
  })
  const plugin = entry.factory(() => ({}))
  let triggerOff = 0, slotOff = 0, servedOff = 0
  const slotNames = [], sources = []
  ctx.provide("inputTriggers", { registerSource(source) { sources.push(source); return () => { triggerOff += 1 } } })
  const fiber = ctx.plugin(plugin)
  await fiber
  assert.equal(sources.length, 1, "无需 remote/sessions/configForms 即可装载档位候选")
  assert.equal(slotNames.length, 0)
  ctx.provide("slots", {
    inject(_name, install) { return install() },
    register(options) { slotNames.push(options.name); return () => { slotOff += 1 } },
  })
  ctx.provide("configForms", {
    get(id) { assert.equal(id, "team-work-dsh"); return { getSnapshot() { return { status: "ready", value: { tiers: {} } } } } },
    whileServed(namespaces, register) {
      assert.deepEqual(Array.from(namespaces), ["team-work-dsh"])
      const off = register(new Set(namespaces))
      return () => { servedOff += 1; off() }
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(slotNames, ["plugins.bundle.config"])
  ctx.provide("sessions", { subagentAddress() { return undefined } })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(slotNames, ["plugins.bundle.config", "conversation.input.right"])
  await fiber.dispose()
  assert.equal(triggerOff, 1)
  assert.equal(slotOff, 2)
  assert.equal(servedOff, 1)
})

test("新版真实 Cordis：组件按完整服务名读取 remote，目录加载不触发命名空间 guard", async (t) => {
  const ctx = await hostContext(t)
  if (!ctx) return
  let entry, component, props, providerReads = 0, modelReads = 0
  const effects = [], cleanup = []
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...props, children } } },
    useState(initial) { return [typeof initial === "function" ? initial() : initial, () => {}] },
    useEffect(effect) { effects.push(effect) },
  }
  vm.runInNewContext(await readFile(new URL("../dsh/client/badge.js", import.meta.url), "utf8"), {
    window: { __ModuleLoader__: { load(registration) { entry = registration } } },
  })
  ctx.provide("remote", new Proxy({}, { get() { throw new Error("cannot get property remote.llm without inject") } }))
  ctx.provide("remote.llm", { async listProviders() { providerReads += 1; return { ok: true, value: [] } } })
  ctx.provide("remote.session", { async modelCatalog() { modelReads += 1; return { ok: true, value: { groups: [], failures: [] } } } })
  ctx.provide("slots", {
    inject(_name, install) { return install() },
    register(options, render) { props = options.inject(); component = render; return () => {} },
  })
  ctx.provide("configForms", {
    get() { return { getSnapshot() { return { status: "ready", writable: true, revision: "revision-demo", value: { tiers: {} } } }, subscribe() { return () => {} } } },
    whileServed(_namespaces, register) { return register(new Set(["team-work-dsh"])) },
  })
  const fiber = ctx.plugin(entry.factory((name) => name === "react" ? React : {}))
  await fiber
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.doesNotThrow(() => component(props))
  for (const effect of effects) cleanup.push(effect())
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(providerReads, 1)
  assert.equal(modelReads, 1)
  cleanup.forEach((dispose) => dispose?.())
  await fiber.dispose()
})

test("新版真实 ConfigForms：宿主 plainSchema 经浏览器重建后，空 tiers 可进入 ready", async (t) => {
  const host = process.env.DSH_TEST_HOST
  const hostCtx = await hostContext(t)
  if (!hostCtx) return
  const require = createRequire(path.join(host, "package.json"))
  const { SettingsForms } = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-settings")).href)
  const { Config } = await import("../dsh/settings.js")
  const isolatedHome = await mkdtemp(path.join(os.tmpdir(), "twr-settings-mirror-"))
  t.after(() => rm(isolatedHome, { recursive: true, force: true }))
  const entryPlugin = { Config, apply: () => {} }
  const entryFiber = hostCtx.plugin(entryPlugin, {})
  await entryFiber
  const entry = { id: "team-work-dsh", options: { id: "team-work-dsh", name: "team-work-runtime", config: {} }, fiber: entryFiber }
  hostCtx.provide("loader", { await: async () => {} })
  hostCtx.provide("profileContext", { name: "profile-demo", home: isolatedHome })
  hostCtx.provide("configEditor", { configuration() { return [{ entry, inherited: {}, override: {} }] } })
  const settingsFiber = hostCtx.plugin(SettingsForms)
  await settingsFiber
  const descriptors = hostCtx.get("settings").describe()
  assert.deepEqual(descriptors.map(({ ns }) => ns), ["team-work-dsh"])
  assert.deepEqual(descriptors[0].value, { tiers: {} })

  let clientEntry
  vm.runInNewContext(await readFile(path.join(host, "..", "dsh-client-ui-settings", "lib", "client.js"), "utf8"), {
    window: { __ModuleLoader__: { load(registration) { clientEntry = registration } } },
    setTimeout, clearTimeout, structuredClone,
  })
  const clientPlugin = clientEntry.factory(require)
  const clientCtx = await hostContext(t)
  const remoteSettings = { async describe() { return { ok: true, value: { writable: true, namespaces: plain(hostCtx.get("settings").describe()) } } } }
  clientCtx.provide("remote", { $host: { isLoopback: true }, $on() { return () => {} }, settings: remoteSettings })
  clientCtx.provide("remote.settings", remoteSettings)
  const clientFiber = clientCtx.plugin(clientPlugin)
  await clientFiber
  const forms = clientCtx.get("configForms")
  await forms.describe().ensure()
  const form = forms.get("team-work-dsh")
  const schema = clientCtx.get("settingsSchema")
  assert.equal(schema.validate(schema.rehydrate(plain(descriptors[0].schema)), { tiers: {} }), undefined)
  assert.equal(form.getSnapshot().status, "ready", "实际 derive/decode 不得停在 loading")
  assert.deepEqual(plain(form.getSnapshot().value), { tiers: {} })
  const complete = {
    junior: { provider: "provider-demo", model: "model-basic" },
    senior: [{ provider: "provider-demo", model: "model-standard", effort: "high" }],
    expert: { provider: "provider-demo", model: "model-advanced" },
  }
  entry.options.config = { tiers: complete }
  entryFiber.config = Config({ tiers: complete })
  await forms.describe().load()
  assert.equal(form.getSnapshot().status, "ready")
  assert.deepEqual(plain(form.getSnapshot().value), { tiers: complete }, "对象与数组候选在真实 decode 链都保留")
  await clientFiber.dispose()
  await settingsFiber.dispose()
  await entryFiber.dispose()
})

function plain(value) { return JSON.parse(JSON.stringify(value)) }
