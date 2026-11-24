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

const verifiedHostVersions = ["0.2.0-rc.2", "0.2.1-rc.2"]

async function hostContext(t) {
  const host = process.env.DSH_TEST_HOST
  if (!host) { t.skip("未指定 DSH_TEST_HOST；新版隔离宿主验证未执行"); return null }
  const metadata = JSON.parse(await readFile(path.join(host, "package.json"), "utf8"))
  assert.equal(metadata.name, "@deepseek-ai/dsh")
  const require = createRequire(path.join(host, "package.json"))
  const { evaluatePluginCompatibility } = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-app-boot")).href)
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  assert.equal(evaluatePluginCompatibility(manifest, {}, metadata.version), undefined, "实际宿主须通过当前根包的官方兼容检查")
  const { Context } = await import(pathToFileURL(require.resolve("@deepseek-ai/cordis")).href)
  return new Context({ _isRoot: true })
}

test("真实宿主兼容检查：已测两版通过，加载范围边界遵循声明", async (t) => {
  const ctx = await hostContext(t)
  if (!ctx) return
  const require = createRequire(path.join(process.env.DSH_TEST_HOST, "package.json"))
  const { evaluatePluginCompatibility } = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-app-boot")).href)
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  for (const version of verifiedHostVersions) assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined)
  const oldManifest = { ...manifest, peerDependencies: { "@deepseek-ai/dsh": "0.2.0-rc.2" } }
  assert.equal(evaluatePluginCompatibility(oldManifest, {}, "0.2.1-rc.2").exempted, false)
  // 以下版本仅作范围规则输入，不代表它们已发布或已完成运行验证。
  for (const version of ["0.2.0-rc.3", "0.2.0", "0.2.1-rc.1", "0.2.1", "0.2.2-rc.1", "0.2.99"]) {
    assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined, version)
  }
  for (const version of ["0.1.7-rc.2", "0.2.0-rc.1", "0.3.0-0", "0.3.0-alpha.1", "0.3.0-rc.1", "0.3.0", "1.0.0"]) {
    assert.equal(evaluatePluginCompatibility(manifest, {}, version).exempted, false, version)
  }
})

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
  ctx.provide("systemPrompt", { section() { return () => {} } })
  ctx.provide("workingDirectory", { ensure: async (agent) => agent.session.header.cwd })
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

test("新版真实 JSONL 后端：单块业务正文冷持久读取保留，业务正文收单判定不变", async (t) => {
  const ctx = await hostContext(t)
  if (!ctx) return
  const require = createRequire(path.join(process.env.DSH_TEST_HOST, "package.json"))
  const persistencePlugin = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-session-persistence-jsonl")).href)
  const JsonlPersistence = persistencePlugin.default ?? persistencePlugin
  const { createUserMessage } = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-llm")).href)
  const root = await mkdtemp(path.join(os.tmpdir(), "twr-message-blocks-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const backend = ctx.plugin(JsonlPersistence, { root, compression: "none" })
  await backend
  const persistence = ctx.get("sessionPersistence")
  const content = [{ type: "text", text: "本轮业务派单" }]
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

test("隔离宿主 PTC：原生 SDK 软提示未调用发送，下一 Step 仅一次，并给外层 deferContext", async (t) => {
  const ctx = await hostContext(t)
  if (!ctx) return
  const require = createRequire(path.join(process.env.DSH_TEST_HOST, "package.json"))
  const load = async (name) => import(pathToFileURL(require.resolve("@deepseek-ai/" + name)).href)
  let control, tools, ptc, scope
  try {
    [control, tools, ptc, scope] = await Promise.all([load("dsh-tool-subagent-control"), load("dsh-tools"), load("dsh-tool-executor-ptc"), load("dsh-scope")])
  } catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND" && error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error
    t.skip("该隔离宿主缺少本用例的现代 PTC 接缝，发送未验")
    return
  }
  if (typeof ptc.PtcExecutor !== "function") { t.skip("该隔离宿主未暴露 PtcExecutor，发送未验"); return }
  const { createMemberMessageGuard } = await import("../dsh/member-message-guard.js")
  const cwd = await mkdtemp(path.join(os.tmpdir(), "tw-ptc-member-"))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const received = []
  const subagents = {
    resolveName(_agent, name) { return name === "父会话别名" ? "lead-example" : name },
    async sendMessage(_agent, target, blocks) { received.push({ target, blocks }); return "真实工具消息回执" },
  }
  ctx.provide("subagents", subagents)
  ctx.provide("systemPrompt", { getContextOrder: () => 10, getSectionOrder: () => 10, context() {}, section() {}, tools() {} })
  ctx.provide("workingDirectory", { ensure: () => cwd })
  await ctx.plugin(tools.ToolsService).ready
  control.apply(ctx, { interrupt: false })
  // 程序驱动替身只调用宿主真实生成的 SDK 绑定，不替代工具调度、校验、回执和 additionalContexts 合并。
  const runtime = {
    language: "typescript", programFormat: "function-body", retainsState: false, release() {},
    resolve(input) { return { ...input, timeoutMs: null } },
    async run({ bindings, program }) {
      const sdk = bindings[0].functions
      const calls = Array.from({ length: Number(program) }, () => sdk.send_message({ agent: "父会话别名", message: "需要协调的示例" }))
      const results = (await Promise.allSettled(calls)).map((entry) => entry.status === "fulfilled" ? entry.value : { error: entry.reason.message })
      return { logs: [], value: results }
    },
  }
  ctx.provide("ptcRuntime", runtime)
  const guard = createMemberMessageGuard({ resolveRecipient: (exec, name) => subagents.resolveName(exec.agent, name), reportStatus: () => "unreported" })
  ctx.on("tools/execute", (exec, next) => guard.aroundExecute(exec, next))
  t.after(() => guard.dispose())
  const executor = new ptc.PtcExecutor(ctx)
  const session = { id: "member-example", header: { id: "member-example", cwd, parentSession: "lead-example" }, append() {} }
  const agent = { id: session.id, session, phase: { kind: "running", turn: 1, step: 1 } }
  agent.ctx = scope.createScope(ctx, agent).ctx
  guard.trackDispatch({ cwd, task: "示例任务", key: "d1-example", sessionId: session.id, leadId: "lead-example", role: "owner" }, true)
  let sequence = 0
  const run = (sender, calls) => executor.execute({ calls: [{ type: "tool-call", id: "call-" + (++sequence), name: "run_code", arguments: JSON.stringify({ code: String(calls), description: "验证原生消息守卫" }) }], signal: new AbortController().signal, agent: sender })
  const first = await run(agent, 2)
  assert.equal(first.results[0].result.isError, false)
  assert.ok(first.results[0].result.value.result.every((item) => /未发送|还没发/.test(item.error)))
  assert.equal(received.length, 0, "两次 SDK 调用均未进入原生发送体")
  assert.equal(first.additionalContexts?.length, 1, JSON.stringify(first))
  assert.match(first.additionalContexts[0].content[0].text, /这条消息还没发/)
  agent.phase.step = 2
  const later = await run(agent, 2)
  assert.equal(later.additionalContexts?.length ?? 0, 0)
  assert.equal(received.length, 1, "后续 Step 的并发调用仅有一条送达")
  assert.equal(received[0].target, "lead-example")
  const ordinary = { ...agent, id: "ordinary-example", session: { ...session, id: "ordinary-example", header: { ...session.header, id: "ordinary-example" } } }
  ordinary.ctx = scope.createScope(ctx, ordinary).ctx
  await run(ordinary, 1)
  assert.equal(received.length, 2, "相同父级但无正式映射的普通委派不拦截")
})
