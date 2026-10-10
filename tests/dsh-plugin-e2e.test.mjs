// 显式选定新版隔离宿主，验证真实 Cordis 生命周期；不读取用户的宿主或 profile。
import assert from "node:assert/strict"
import { readFile, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import { createRequire } from "node:module"
import path from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"
import vm from "node:vm"

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
  assert.ok(registered.some(([kind, name]) => kind === "skill" && name === "team-work"))
  assert.deepEqual(configurations, [{ auto: false }])
  await fiber.dispose()
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
