// dsh-plugin 纯函数单测（不依赖 DSH 运行时；装载链验证在 I2 验证脚本与 I6 压轴 E2E）
import assert from "node:assert/strict"
import { readFile, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import vm from "node:vm"

const DOT = String.fromCharCode(183)

import { resolveTwExecutable, resolveChildCwd } from "../dsh/tw-tool.js"
import { installPluginSettings, SETTINGS_NS, TIER_DESCRIPTIONS } from "../dsh/settings.js"
import { parseFrontmatter } from "../dsh/skill-embed.js"

function findTree(node, predicate) {
  if (!node || typeof node !== "object") return null
  if (predicate(node)) return node
  for (const child of node.props?.children ?? []) {
    const found = findTree(child, predicate)
    if (found) return found
  }
  return null
}

function hasInlineStyle(node) {
  if (!node || typeof node !== "object") return false
  if (node.props?.style) return true
  return (node.props?.children ?? []).some(hasInlineStyle)
}

test("I4 client 工厂遵守 DSH 契约：factory(require) 直接返回 Cordis 插件", async () => {
  const registrations = []
  const source = await readFile(new URL("../dsh/client/badge.js", import.meta.url), "utf8")
  vm.runInNewContext(source, {
    globalThis: {},
    window: { __ModuleLoader__: { load(registration) { registrations.push(registration) } } },
  })

  assert.deepEqual(registrations.map(({ id }) => id), ["team-work-runtime"])
  for (const { factory } of registrations) {
    const plugin = factory(() => ({}))
    assert.equal(typeof plugin?.apply, "function", "factory(require) 须返回带 apply 的插件对象")
    assert.deepEqual(Array.from(plugin.inject), ["slots", "sessions", "connection", "remote", "remote.session", "remote.llm", "settingsScope", "inputTriggers"], "须声明模型查询、remote 模型目录、全局 settingsScope 与 @ 候选源服务；logger 是 ctx 内建属性")
  }
})

test("I5 Web 插件配置卡：继承 DSH 标题与说明两行卡片形态", async () => {
  const registrations = []
  const source = await readFile(new URL("../dsh/client/badge.js", import.meta.url), "utf8")
  vm.runInNewContext(source, {
    globalThis: {},
    window: { __ModuleLoader__: { load(registration) { registrations.push(registration) } } },
  })

  const hookState = []
  let hookIndex = 0
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...(props ?? {}), children: children.flat(Infinity) } } },
    useState(initial) {
      const index = hookIndex++
      if (!(index in hookState)) hookState[index] = typeof initial === "function" ? initial() : initial
      return [hookState[index], (next) => { hookState[index] = typeof next === "function" ? next(hookState[index]) : next }]
    },
    useEffect() { hookIndex += 1 },
  }
  const cards = []
  const plugin = registrations[0].factory((id) => id === "react" ? React : {})
  plugin.apply({
    sessions: { subagentAddress() { return undefined } },
    settingsScope: { bind() { return { getSnapshot() { return { status: "ready", writable: true, value: {} } } } } },
    slots: {
      inject(_slot, install) { install() },
      register(options, component) { cards.push({ options, component }); return () => {} },
    },
    connection: {},
    logger: { warn() {} },
  })

  const card = cards.find(({ options }) => options.name === "settings.plugin.item")
  hookIndex = 0
  const tree = card.component(card.options.inject())
  const header = findTree(tree, (node) => node.type === "button" && node.props?.["aria-expanded"] === false)

  assert.equal(tree.type, "li", "配置项须呈现为与 DSH 内建插件一致的列表卡片")
  assert.equal(header?.props?.["aria-label"], "展开设置: team-work-runtime", "默认折叠并提供宿主一致的可访问名称")
  assert.match(JSON.stringify(header), /team-work-runtime/, "折叠态显示唯一插件制品名")
  assert.match(JSON.stringify(header), /为子代理配置团队档位模型/, "折叠态显示与 DSH 原生卡片一致的一行说明")
  assert.ok(findTree(header, (node) => node.props?.className === "tw-settings-head-text"), "标题与说明须使用宿主一致的纵向排版容器")
  assert.equal(findTree(tree, (node) => node.props?.["data-tw-tier"]), null, "折叠态不渲染具体配置项")
  assert.equal(hasInlineStyle(tree), false, "配置卡不得用内联样式绕过 DSH 主题与字体体系")
  const stylesheet = findTree(tree, (node) => node.type === "style" && node.props?.["data-tw-settings-style"] === "tiers")
  assert.match(stylesheet?.props?.children?.join("") ?? "", /--dsw-alias-/, "配置卡颜色须跟随 DSH 主题 token")
  assert.match(stylesheet?.props?.children?.join("") ?? "", /font:inherit/, "配置控件须继承 DSH 字体体系")

  header.props.onClick()
  hookIndex = 0
  const expandedTree = card.component(card.options.inject())
  assert.ok(findTree(expandedTree, (node) => node.type === "button" && node.props?.["aria-expanded"] === true), "点击卡片后须切换为展开态")
  assert.ok(findTree(expandedTree, (node) => node.props?.["data-tw-tier"] === "junior"), "展开后才显示具体配置项")
  assert.ok(findTree(expandedTree, (node) => node.type === "input" && node.props?.className === "tw-settings-input"), "展开后的输入控件须使用统一宿主风格类")
})

test("I5 Web 插件配置卡：绑定 settingsScope、候选行保存为数组，并依据目录热更新", async () => {
  const registrations = []
  const source = await readFile(new URL("../dsh/client/badge.js", import.meta.url), "utf8")
  vm.runInNewContext(source, {
    globalThis: {},
    window: { __ModuleLoader__: { load(registration) { registrations.push(registration) } } },
  })

  const hookState = []
  let hookIndex = 0
  let effects = []
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...(props ?? {}), children: children.flat(Infinity) } } },
    useState(initial) {
      const index = hookIndex++
      if (!(index in hookState)) hookState[index] = typeof initial === "function" ? initial() : initial
      return [hookState[index], (next) => { hookState[index] = typeof next === "function" ? next(hookState[index]) : next }]
    },
    useEffect(effect) { hookIndex += 1; effects.push(effect) },
  }
  const plugin = registrations[0].factory((id) => id === "react" ? React : {})
  const slotRegistrations = []
  const bindings = []
  const writes = []
  const apiCalls = []
  let settingsSnapshot = {
    status: "ready",
    writable: true,
    revision: 1,
    value: {
      tiers: {
        junior: { provider: "provider-a", model: "catalog-model", family: "family-a" },
        senior: [{ provider: "provider-a", model: "catalog-model" }],
        expert: [{ provider: "provider-a", model: "catalog-model" }],
      },
    },
  }
  let scopeSubscriber
  const scope = {
    getSnapshot() { return settingsSnapshot },
    subscribe(callback) { scopeSubscriber = callback; return () => {} },
    async set(field, value) {
      writes.push({ field, value })
      settingsSnapshot = {
        ...settingsSnapshot,
        revision: settingsSnapshot.revision + 1,
        value: { ...settingsSnapshot.value, [field]: value },
      }
      scopeSubscriber?.()
    },
  }
  plugin.apply({
    sessions: { subagentAddress() { return undefined } },
    settingsScope: { bind(spec) { bindings.push(spec); return scope } },
    slots: {
      inject(_slot, install) { install() },
      register(options, component) { slotRegistrations.push({ options, component }); return () => {} },
    },
    remote: {
      llm: {
        async listProviders() {
          apiCalls.push("providers")
          return { ok: true, value: [{ id: "provider-a", name: "Provider A" }] }
        },
      },
      session: {
        async modelCatalog() {
          apiCalls.push("models")
          return { ok: true, value: { groups: [{ id: "provider-a", name: "Provider A", models: [{ id: "catalog-model", name: "Catalog model", reasoning: { efforts: [{ id: "high", name: "High" }] } }, { id: "catalog-model-two", name: "Catalog model two" }] }], failures: [{ id: "provider-b", name: "Provider B", message: "暂不可用" }] } }
        },
      },
    },
    logger: { warn() {} },
  })

  assert.equal(bindings.length, 1, "配置卡只绑定一次")
  assert.equal(bindings[0]?.namespace, "team-work-dsh", "配置卡须绑定插件自己的全局 namespace")
  const configCard = slotRegistrations.find(({ options }) => options.name === "settings.plugin.item")
  assert.equal(configCard?.options?.key, "team-work-dsh", "插件配置页按 namespace key 派发卡片")
  const props = configCard.options.inject()
  assert.equal(props.scope, scope, "卡片通过 slot inject 接收已绑定 scope")

  const render = () => {
    hookIndex = 0
    effects = []
    return configCard.component(props)
  }
  render()
  for (const effect of effects) effect()
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const collapsedTree = render()
  findTree(collapsedTree, (node) => node.type === "button" && node.props?.["aria-expanded"] === false).props.onClick()
  const tree = render()
  assert.deepEqual(apiCalls.sort(), ["models", "providers"], "卡片读取 provider 目录与模型目录")
  assert.match(JSON.stringify(tree), /低成本/, "三档中文说明可见")
  assert.match(JSON.stringify(tree), /部分 Provider 的模型目录不可用/, "与当前候选无关的目录失败应明确显示")

  const find = (node, predicate) => {
    if (!node || typeof node !== "object") return null
    if (predicate(node)) return node
    for (const child of node.props?.children ?? []) {
      const found = find(child, predicate)
      if (found) return found
    }
    return null
  }
  const save = find(tree, (node) => node.props?.["data-tw-action"] === "save-tiers")
  assert.equal(typeof save?.props?.onClick, "function", "卡片提供保存操作")
  await save.props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(writes)), [{
    field: "tiers",
    value: {
      junior: [{ provider: "provider-a", model: "catalog-model", family: "family-a" }],
      senior: [{ provider: "provider-a", model: "catalog-model" }],
      expert: [{ provider: "provider-a", model: "catalog-model" }],
    },
  }], "单对象回显后统一按候选数组保存，并保留 family")

  settingsSnapshot = {
    ...settingsSnapshot,
    revision: 3,
    value: { tiers: {
      junior: [{ provider: "provider-a", model: "catalog-model-two" }],
      senior: [{ provider: "provider-a", model: "catalog-model" }],
      expert: [{ provider: "provider-a", model: "catalog-model" }],
    } },
  }
  scopeSubscriber()
  render()
  for (const effect of effects) effect()
  const hotTree = render()
  assert.match(JSON.stringify(hotTree), /catalog-model-two/, "scope 订阅到外部 settings 更新后热更新候选行")

  settingsSnapshot = {
    ...settingsSnapshot,
    revision: 4,
    value: {},
  }
  scopeSubscriber()
  render()
  for (const effect of effects) effect()
  const emptyTree = render()
  assert.match(JSON.stringify(emptyTree), /Provider（active，必填）/, "首次空配置也能打开卡片并填写三档候选")
})

test("I5 Web 插件配置卡：模型目录 RPC 被拒绝时，阻止保存并给出可恢复原因", async () => {
  const registrations = []
  const source = await readFile(new URL("../dsh/client/badge.js", import.meta.url), "utf8")
  vm.runInNewContext(source, {
    globalThis: {},
    window: { __ModuleLoader__: { load(registration) { registrations.push(registration) } } },
  })

  const hookState = []
  let hookIndex = 0
  let effects = []
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...(props ?? {}), children: children.flat(Infinity) } } },
    useState(initial) {
      const index = hookIndex++
      if (!(index in hookState)) hookState[index] = typeof initial === "function" ? initial() : initial
      return [hookState[index], (next) => { hookState[index] = typeof next === "function" ? next(hookState[index]) : next }]
    },
    useEffect(effect) { hookIndex += 1; effects.push(effect) },
  }
  let settingsSnapshot = {
    status: "ready",
    writable: true,
    revision: 1,
    value: { tiers: {
      junior: [{ provider: "provider-a", model: "manual-model" }],
      senior: [{ provider: "provider-a", model: "manual-model" }],
      expert: [{ provider: "provider-a", model: "manual-model" }],
    } },
  }
  const writes = []
  const scope = {
    getSnapshot() { return settingsSnapshot },
    subscribe() { return () => {} },
    async set(field, value) {
      writes.push({ field, value })
      settingsSnapshot = {
        ...settingsSnapshot,
        revision: settingsSnapshot.revision + 1,
        value: { ...settingsSnapshot.value, [field]: value },
      }
    },
  }
  const slotRegistrations = []
  const plugin = registrations[0].factory((id) => id === "react" ? React : {})
  plugin.apply({
    sessions: { subagentAddress() { return undefined } },
    settingsScope: { bind() { return scope } },
    slots: {
      inject(_slot, install) { install() },
      register(options, component) { slotRegistrations.push({ options, component }); return () => {} },
    },
    remote: {
      llm: {
        async listProviders() {
          return { ok: true, value: [{ id: "provider-a", name: "Provider A" }] }
        },
      },
      session: {
        async modelCatalog() {
          return { ok: false, error: { message: "模型目录服务暂不可用" } }
        },
      },
    },
    logger: { warn() {} },
  })

  const card = slotRegistrations.find(({ options }) => options.name === "settings.plugin.item")
  const props = card.options.inject()
  const render = () => {
    hookIndex = 0
    effects = []
    return card.component(props)
  }
  render()
  for (const effect of effects) effect()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const collapsedTree = render()
  findTree(collapsedTree, (node) => node.type === "button" && node.props?.["aria-expanded"] === false).props.onClick()
  const tree = render()
  const find = (node, predicate) => {
    if (!node || typeof node !== "object") return null
    if (predicate(node)) return node
    for (const child of node.props?.children ?? []) {
      const found = find(child, predicate)
      if (found) return found
    }
    return null
  }
  const save = find(tree, (node) => node.props?.["data-tw-action"] === "save-tiers")

  assert.match(JSON.stringify(tree), /模型目录读取失败/, "模型目录故障须明确显示")
  assert.match(JSON.stringify(tree), /请恢复.*模型目录/, "模型目录故障须提供恢复指引")
  assert.equal(save?.props?.disabled, true, "模型目录 RPC 被拒绝时必须禁用保存")
  await save.props.onClick()
  assert.equal(writes.length, 0, "模型目录 RPC 拒绝必须阻止写入")
})

test("I5 Web 插件配置卡：候选必须通过 Provider、模型目录与 effort 的硬校验", async () => {
  const registrations = []
  const source = await readFile(new URL("../dsh/client/badge.js", import.meta.url), "utf8")
  vm.runInNewContext(source, {
    globalThis: {},
    window: { __ModuleLoader__: { load(registration) { registrations.push(registration) } } },
  })

  const hookState = []
  let hookIndex = 0
  let effects = []
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...(props ?? {}), children: children.flat(Infinity) } } },
    useState(initial) {
      const index = hookIndex++
      if (!(index in hookState)) hookState[index] = typeof initial === "function" ? initial() : initial
      return [hookState[index], (next) => { hookState[index] = typeof next === "function" ? next(hookState[index]) : next }]
    },
    useEffect(effect) { hookIndex += 1; effects.push(effect) },
  }
  const writes = []
  const scope = {
    getSnapshot() {
      return {
        status: "ready",
        writable: true,
        revision: 1,
        value: { tiers: {
          junior: [
            { provider: "", model: "catalog-model" },
            { provider: "provider-inactive", model: "catalog-model" },
            { provider: "provider-a", model: "outside-catalog" },
            { provider: "provider-a", model: "catalog-model", effort: "unsupported" },
          ],
          senior: [{ provider: "provider-b", model: "anything" }],
          expert: [{ provider: "provider-c", model: "anything" }],
        } },
      }
    },
    subscribe() { return () => {} },
    async set(field, value) { writes.push({ field, value }) },
  }
  const slots = []
  const plugin = registrations[0].factory((id) => id === "react" ? React : {})
  plugin.apply({
    sessions: { subagentAddress() { return undefined } },
    settingsScope: { bind() { return scope } },
    slots: {
      inject(_slot, install) { install() },
      register(options, component) { slots.push({ options, component }); return () => {} },
    },
    remote: {
      llm: {
        async listProviders() {
          // 最新版契约只列 active 路由；inactive 的 provider 不出现在列表中
          return { ok: true, value: [
            { id: "provider-a", name: "Provider A" },
            { id: "provider-b", name: "Provider B" },
            { id: "provider-c", name: "Provider C" },
          ] }
        },
      },
      session: {
        async modelCatalog() {
          return { ok: true, value: {
            groups: [{ id: "provider-a", models: [{ id: "catalog-model", reasoning: { efforts: [{ id: "high" }] } }] }],
            failures: [{ id: "provider-b", name: "Provider B", message: "目录服务不可用" }],
          } }
        },
      },
    },
    logger: { warn() {} },
  })

  const card = slots.find(({ options }) => options.name === "settings.plugin.item")
  const props = card.options.inject()
  const render = () => {
    hookIndex = 0
    effects = []
    return card.component(props)
  }
  render()
  for (const effect of effects) effect()
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const collapsedTree = render()
  findTree(collapsedTree, (node) => node.type === "button" && node.props?.["aria-expanded"] === false).props.onClick()
  const tree = render()
  const text = JSON.stringify(tree)
  const find = (node, predicate) => {
    if (!node || typeof node !== "object") return null
    if (predicate(node)) return node
    for (const child of node.props?.children ?? []) {
      const found = find(child, predicate)
      if (found) return found
    }
    return null
  }
  const save = find(tree, (node) => node.props?.["data-tw-action"] === "save-tiers")

  assert.match(text, /Provider 为必填项/, "Provider 为空时须阻止保存")
  assert.match(text, /Provider 未处于 active 状态/, "inactive Provider 须阻止保存")
  assert.match(text, /模型不在该 Provider 的可验证目录中/, "目录已成功读取时模型必须真实存在")
  assert.match(text, /推理等级不在该模型公开的选项中/, "公开非空 effort 列表时填写值必须命中")
  assert.match(text, /Provider 模型目录读取失败.*请恢复该 Provider 的模型目录/, "候选 Provider 的目录失败须有恢复指引")
  assert.match(text, /没有可验证的模型目录.*请恢复该 Provider 的模型目录/, "没有该 Provider 目录时须有恢复指引")
  assert.equal(save?.props?.disabled, true, "任一候选不可验证时必须禁用保存")
  await save.props.onClick()
  assert.equal(writes.length, 0, "任一候选不可验证时不得写入 settings")
})

test("I4 模型席位声明回收时同步释放徽标注册", async () => {
  const registrations = []
  const source = await readFile(new URL("../dsh/client/badge.js", import.meta.url), "utf8")
  vm.runInNewContext(source, {
    globalThis: {},
    window: { __ModuleLoader__: { load(registration) { registrations.push(registration) } } },
  })

  const plugin = registrations[0].factory((id) => id === "react" ? {} : {})
  let injectedDisposer
  let releases = 0
  plugin.apply({
    sessions: { subagentAddress() { return undefined } },
    slots: {
      inject(_slot, install) { injectedDisposer = install() },
      register() { return () => { releases += 1 } },
    },
    logger: { warn() {} },
  })

  assert.equal(typeof injectedDisposer, "function", "slots.inject 回调须透传 register disposer")
  injectedDisposer()
  assert.equal(releases, 1, "席位声明 collapse/reload 时不得遗留重复徽标")
})

test("I4 子代理模型席位显示 sessions.models 返回的实际模型与 effort", async () => {
  const registrations = []
  const source = await readFile(new URL("../dsh/client/badge.js", import.meta.url), "utf8")
  vm.runInNewContext(source, {
    globalThis: {},
    window: { __ModuleLoader__: { load(registration) { registrations.push(registration) } } },
  })

  let state = null
  let pendingEffect
  const React = {
    createElement(type, props, children) { return { type, props: { ...props, children } } },
    useState(initial) {
      if (state === undefined) state = initial
      return [state, (next) => { state = next }]
    },
    useEffect(effect) { pendingEffect = effect },
  }
  const factory = registrations[0].factory
  const plugin = factory((id) => {
    if (id === "react") return React
    throw new Error("测试未提供模块：" + id)
  })

  let contribution
  const ctx = {
    sessions: { subagentAddress: (sessionId) => sessionId === "child-session" ? { childId: "child" } : undefined },
    slots: {
      inject(_slot, install) { install() },
      register(options, component) { contribution = { options, component } },
    },
    get(name) {
      if (name !== "connection") return undefined
      return { api: { sessions: { models: async () => ({
        result: {
          ok: true,
          value: { current: { provider: "provider-example", model: "model-example", reasoningEffort: "high" } },
        },
      }) } } }
    },
    logger: { warn() {} },
  }

  plugin.apply(ctx)
  const props = contribution.options.inject("child-session")
  assert.equal(contribution.component(props), null, "RPC 返回前不显示占位值")
  pendingEffect()
  await Promise.resolve()
  await Promise.resolve()

  const rendered = contribution.component(props)
  assert.equal(rendered?.type, "span")
  assert.equal(rendered?.props?.children, "provider-example/model-example · 推理 high")
})

test("I4 徽标仅追加在模型席位旁，不替换父会话的原生模型选择器", async () => {
  const registrations = []
  const source = await readFile(new URL("../dsh/client/badge.js", import.meta.url), "utf8")
  vm.runInNewContext(source, {
    globalThis: {},
    window: { __ModuleLoader__: { load(registration) { registrations.push(registration) } } },
  })

  const React = {
    createElement() { throw new Error("父会话不应渲染插件徽标") },
    useState(initial) { return [initial, () => {}] },
    useEffect() {},
  }
  const plugin = registrations[0].factory((id) => id === "react" ? React : {})
  let targetSlot
  let contribution
  plugin.apply({
    sessions: { subagentAddress() { return undefined } },
    slots: {
      inject(slot, install) { targetSlot = slot; install() },
      register(options, component) { contribution = { options, component } },
    },
    logger: { warn() {} },
  })

  assert.equal(targetSlot, "conversation.input.right", "追加到模型席位左侧区域，不能抢占 single 模型席位")
  const parentProps = contribution.options.inject("parent-session")
  assert.deepEqual({ ...parentProps }, { sessionId: "parent-session", addressed: false }, "slot inject 必须始终返回对象")
  assert.equal(contribution.component({
    ...parentProps,
    session: {
      running: false,
      nodes: [{ kind: "assistant", requestConfig: { provider: "parent-provider", model: "parent-model", reasoningEffort: "high" } }],
    },
  }), null, "父会话即使已有请求记录也只保留原生模型选择器")
})

test("I4 子代理开始新一轮运行时刷新实际模型与 effort", async () => {
  const registrations = []
  const source = await readFile(new URL("../dsh/client/badge.js", import.meta.url), "utf8")
  vm.runInNewContext(source, {
    globalThis: {},
    window: { __ModuleLoader__: { load(registration) { registrations.push(registration) } } },
  })

  let state = null
  let pendingEffect
  let previousDeps
  const React = {
    createElement(type, props, children) { return { type, props: { ...props, children } } },
    useState() { return [state, (next) => { state = next }] },
    useEffect(effect, deps) {
      const changed = !previousDeps || deps.some((value, index) => value !== previousDeps[index])
      previousDeps = deps
      if (changed) pendingEffect = effect
    },
  }
  const plugin = registrations[0].factory((id) => id === "react" ? React : {})
  let contribution
  let current = { provider: "provider-before", model: "model-before", reasoningEffort: "low" }
  plugin.apply({
    sessions: { subagentAddress() { return { childId: "child" } } },
    slots: {
      inject(_slot, install) { install() },
      register(options, component) { contribution = { options, component } },
    },
    get() {
      return { api: { sessions: { models: async () => ({ result: { ok: true, value: { current } } }) } } }
    },
    logger: { warn() {} },
  })

  const injected = contribution.options.inject("child-session")
  contribution.component({ ...injected, session: { running: false } })
  pendingEffect()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(contribution.component({ ...injected, session: { running: false } }).props.children, "provider-before/model-before · 推理 low")

  current = { provider: "provider-after", model: "model-after", reasoningEffort: "max" }
  pendingEffect = undefined
  contribution.component({ ...injected, session: { running: true } })
  assert.equal(typeof pendingEffect, "function", "运行状态变化必须触发重新读取")
  pendingEffect()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(contribution.component({ ...injected, session: { running: true } }).props.children, "provider-after/model-after · 推理 max")
})

test("I4 addressed 子代理的模型 RPC 不可用时显示会话真实请求记录", async () => {
  const registrations = []
  const source = await readFile(new URL("../dsh/client/badge.js", import.meta.url), "utf8")
  vm.runInNewContext(source, {
    globalThis: {},
    window: { __ModuleLoader__: { load(registration) { registrations.push(registration) } } },
  })

  let pendingEffect
  const React = {
    createElement(type, props, children) { return { type, props: { ...props, children } } },
    useState(initial) { return [initial, () => {}] },
    useEffect(effect) { pendingEffect = effect },
  }
  const plugin = registrations[0].factory((id) => id === "react" ? React : {})
  let contribution
  let rpcCalls = 0
  plugin.apply({
    sessions: { subagentAddress() { return { childId: "child" } } },
    slots: {
      inject(_slot, install) { install() },
      register(options, component) { contribution = { options, component } },
    },
    connection: { api: { sessions: { models: async () => { rpcCalls += 1; throw new Error("addressed session unavailable") } } } },
    logger: { warn() {} },
  })

  const injected = contribution.options.inject("child-session")
  const rendered = contribution.component({
    ...injected,
    session: {
      running: false,
      views: { get() { return { requests: [
        { purpose: "assistant", requestConfig: { provider: "provider-recorded", model: "model-recorded", reasoningEffort: "xhigh" } },
        { purpose: "compaction", requestConfig: { provider: "provider-compact", model: "model-compact", reasoningEffort: "low" } },
      ] } } },
      nodes: [
        { kind: "assistant", requestConfig: { provider: "provider-recorded", model: "model-recorded", reasoningEffort: "xhigh" } },
      ],
    },
  })
  assert.equal(rendered?.props?.children, "provider-recorded/model-recorded · 推理 xhigh")
  pendingEffect()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(rpcCalls, 1, "用例必须真实执行并遭遇 addressed sessions.models 拒绝")
  const afterRejection = contribution.component({
    ...injected,
    session: {
      running: false,
      nodes: [{ kind: "assistant", requestConfig: { provider: "provider-recorded", model: "model-recorded", reasoningEffort: "xhigh" } }],
    },
  })
  assert.equal(afterRejection?.props?.children, "provider-recorded/model-recorded · 推理 xhigh", "RPC 拒绝不清除真实请求记录")
})

test("I2 发布包声明直接使用的 DSH 模型选择 peer", async () => {
  const file = "../package.json"
  const metadata = JSON.parse(await readFile(new URL(file, import.meta.url), "utf8"))
  assert.equal(metadata.peerDependencies?.["@deepseek-ai/dsh-agent"], ">=0.1.0-rc", file + " 必须声明直接导入的宿主模型选择包")
})

test("I2 注入通道（第二阶段后）：inject.js 只剩直接选择 + header 回读，无文件读取面", async () => {
  const inject = await import("../dsh/inject.js")
  assert.equal(typeof inject.makeInjectContribution, "function")
  assert.equal(typeof inject.recallFromHeader, "function")
  assert.equal(inject.hintForChild, undefined, "childId 补读（modelHints）已删")
  assert.equal(inject.agentsJsonPath, undefined, "任务级注册表寻址已删（标签纯展示）")
})

test("I2 tw 工具解析：唯一根制品直接携带 Runtime，不依赖 PATH", () => {
  assert.equal(resolveTwExecutable(), fileURLToPath(new URL("../bin/tw.mjs", import.meta.url)))
  assert.equal(resolveChildCwd({ agent: { session: { header: { cwd: "/c" } } } }), "/c")
  assert.equal(resolveChildCwd({}), null, "缺少子会话 cwd 时显式 unresolved")
})

test("I2 tw 工具 render 契约：必须返回 content 块数组（纯字符串致宿主 commit 崩溃——实机两崩铁证）", async () => {
  const { twToolDefinition } = await import("../dsh/tw-tool.js")
  const def = twToolDefinition({})
  const rendered = def.output.render({}, { ok: true, task: "t" })
  assert.ok(Array.isArray(rendered), "render 返回数组")
  assert.equal(rendered[0]?.type, "text")
  assert.equal(typeof rendered[0]?.text, "string")
  assert.doesNotThrow(() => rendered.some((b) => b.type === "image"), "宿主 commit 的 .some 调用形态必须可用")
})
test("I2 tw 工具失败路径：缺少子会话 cwd 返回可恢复失败卡", async () => {
  const { twToolDefinition } = await import("../dsh/tw-tool.js")
  const def = twToolDefinition({})
  const card = await def.execute({ args: ["--version"] }, {})
  assert.deepEqual(card, {
    ok: false,
    code: "TW_CWD_UNRESOLVED",
    message: "无法确定当前子会话的工作目录；请在已打开项目的 DSH 会话中重试。",
  })
})

test("I2 注入链（同步 contribution 契约）：install 同步在场 + undefined 占位 + header 回读同步生效 + disposer 语义", async () => {
  const { makeInjectContribution } = await import("../dsh/inject.js")
  const installs = []
  let installDisposers = 0
  const fakeInstall = (ctx, selection) => { installs.push({ ctx, selection }); return () => { installDisposers += 1 } }
  const ctx = { logger: { info() {} } }
  let providerAtInstall = "NOT_CALLED"
  const fakeInstallChecked = (childCtx2, selection) => {
    // 注册时刻快照：current 必须是 undefined（宿主语义：undefined=不干预继承默认；
    // {provider:null} 会覆写 variables → 子代 no provider/model 直接 turn error——实机铁证）
    providerAtInstall = selection.current === undefined ? "UNDEFINED" : String(selection.current.provider)
    return fakeInstall(childCtx2, selection)
  }
  const cwd = await mkdtemp(path.join(tmpdir(), "tw-inject-"))
  const header = { type: "request/header", data: { header: { config: { provider: "p", model: "m", reasoningEffort: "max" } } } }
  const child = (id, events) => ({ agent: { id, session: { header: { cwd }, events } } })
  // 宿主真实契约（SetupRegistry.apply 源码）：contribution(childCtx) 同步调用、返回值直接存为 disposer、
  // 不 await——测试原样复刻该契约：不加 await，调用后立即断言同步效果。
  const contribution = makeInjectContribution(ctx, {
    installerNow: () => fakeInstallChecked,
  })
  const childCtx = child("child-1", [header])
  const disposer = contribution(childCtx) // 不 await——同步契约
  assert.equal(typeof disposer, "function", "contribution 返回 disposer（宿主直接存储该返回值）")
  assert.equal(installs.length, 1, "install 在 contribution 同步段完成（监听器在场——F2 契约）")
  assert.equal(providerAtInstall, "UNDEFINED", "注册时刻 current=undefined（null 对象会清空宿主模型选择）")
  const selection = installs[0].selection
  assert.equal(selection.current?.model, "m", "header 回读在 contribution 返回前同步生效（cold-resume 通道）")
  assert.equal(selection.current.reasoningEffort, "max")
  // disposer：透传 install 的 disposer
  disposer()
  assert.equal(installDisposers, 1, "disposer 透传 install 清理")

  // 无选择来源（原生 subagent 新建、无持久化请求；标签事件不参与）→ 不干预（继承默认模型）
  const installsFresh = []
  const contributionFresh = makeInjectContribution(ctx, {
    installerNow: () => (c, s) => { installsFresh.push(s) },
  })
  const disposeFresh = contributionFresh(child("child-fresh", [{ type: "subagent/descriptor", data: { label: "IMPL" + DOT + "owner #demo-t" } }]))
  assert.equal(installsFresh[0].current, undefined, "标签纯展示：无 header/直接选择 → selection 不写")
  disposeFresh()

  // installer 同步解析失败 → 不注入，但仍须返回宿主可释放的 no-op disposer
  const contribution3 = makeInjectContribution(ctx, { installerNow: () => null })
  const before = installs.length
  const dispose3 = contribution3({ agent: { id: "child-3" } })
  assert.equal(typeof dispose3, "function", "无安装器 → 仍返回 disposer（宿主释放时会无条件调用）")
  assert.doesNotThrow(() => dispose3(), "no-op disposer 可安全释放")
  assert.equal(installs.length, before, "无安装器 → install 不被调")

  const disposeInvalid = makeInjectContribution(ctx, { installerNow: () => { throw new Error("installer failed") } })({ agent: { id: "child-error", session: { header: { cwd: "/x" } } } })
  assert.equal(typeof disposeInvalid, "function", "contribution 异常 → 仍返回 disposer")
  assert.doesNotThrow(() => disposeInvalid())
})

test("I2 注入失败可诊断且不阻塞：安装器异常留恢复指引（文件读取面已随标签链删除）", async () => {
  const { makeInjectContribution } = await import("../dsh/inject.js")
  const warnings = []
  const ctx = { logger: { warn: (message) => warnings.push(String(message)), info() {} } }
  const contributionInstallerError = makeInjectContribution(ctx, {
    installerNow: () => { throw new Error("installer failed") },
  })
  const disposer = contributionInstallerError({ agent: { id: "child-installer-error", session: { header: { cwd: "/x" } } } })
  assert.equal(typeof disposer, "function")
  assert.ok(warnings.some((message) => message.includes("安装器") && message.includes("installer failed")), "安装器异常可诊断")
})

test("I2 frontmatter 解析：name/description 提取与引号剥离", () => {
  const md = ["---", "name: team-work-v3", 'description: "用 tw CLI 驱动多智能体研发工作流"', "---", "正文"].join(String.fromCharCode(10))
  const fm = parseFrontmatter(md)
  assert.equal(fm.name, "team-work-v3")
  assert.equal(fm.description, "用 tw CLI 驱动多智能体研发工作流")
  assert.deepEqual(parseFrontmatter("无 frontmatter"), {})
})
test("I5 全局 tiers 设置契约：允许 unresolved；一经配置必须三档完整且兼容候选数组", async () => {
  // 桩 installSection：断言三方——schema 是函数、setSource 是函数、hooks 形状在场。
  const calls = []
  let receivedSource = null
  const fakeInstallSection = (_owner, ns, schema, entry, hooks) => {
    calls.push({ ns, schema, entry, hooks })
    // 模拟 service 契约：把「返回当前快照」的 thunk 交给 setSource（对应 scope.get()）
    hooks.setSource((receivedSource = () => ({ seen: true })))
    hooks.onChange()
  }
  const node = (kind, extra = {}) => ({
    kind,
    ...extra,
    required() { this.requiredCalled = true; return this },
    min(value) { this.minValue = value; return this },
    description(value) { this.descriptionText = value; return this },
  })
  const fakeZ = {
    string: () => node("string"),
    array: (inner) => node("array", { inner }),
    union: (items) => node("union", { items }),
    object: (shape) => {
      const schema = function (value) { return value ?? {} }
      schema.shape = shape
      schema.description = function (value) { schema.descriptionText = value; return schema }
      return schema
    },
    transform: (inner, callback) => {
      const schema = function (value) { return callback(inner(value)) }
      schema.inner = inner
      schema.callback = callback
      schema.toJSON = () => ({ type: "transform", inner: { type: "object", dict: inner.shape } })
      return schema
    },
  }
  const injectSettings = (callback) => callback({
    installSection: fakeInstallSection,
  })
  const importSchemastery = async () => ({ default: fakeZ })

  const ctx = { logger: { warn() {} } }
  const entry = { tiers: {} }
  const getConfig = installPluginSettings(ctx, entry, { injectSettings, importSchemastery })

  // fire-and-forget 注册需要一拍：让异步 IIFE 跑完
  await new Promise((r) => setTimeout(r, 20))

  assert.equal(calls.length, 1, "installSection 被调用一次")
  assert.equal(calls[0].ns, SETTINGS_NS, "namespace 直传")
  assert.equal(typeof calls[0].schema, "function", "schema 必须是可调用函数（非裸对象，否则 service resolve 抛 TypeError）")
  assert.deepEqual(Object.keys(calls[0].entry), ["tiers"], "入口初值只含 tiers")
  assert.deepEqual(Object.keys(calls[0].schema.inner.shape), ["tiers"], "settings 区段只公开 tiers")
  assert.doesNotMatch(JSON.stringify(calls[0].schema.toJSON()), /\b(injectionEnabled|projectRoots|twBin)\b/, "序列化 schema 不公开旧字段")
  assert.deepEqual(calls[0].schema({
    tiers: {},
    injectionEnabled: false,
    projectRoots: [],
    twBin: "legacy-entry",
  }), { tiers: {} }, "解析快照过滤遗留原始键，不再把它们交给消费链")
  assert.throws(() => calls[0].schema({
    tiers: { junior: { provider: "provider-a", model: "model-a" } },
  }), /tiers.*一经配置/, "schema 直接解析也须拒绝不完整的 tiers，不能只依赖宿主 validate 钩子")
  assert.equal(typeof calls[0].hooks.setSource, "function", "hooks.setSource 在场")
  assert.equal(typeof calls[0].hooks.validate, "function", "宿主同步 validate 在场")
  assert.equal(typeof receivedSource, "function", "setSource 收到的是 thunk（函数），非值")
  // setSource 存 thunk + 读值调 source()：getConfig() 返回服务端快照（非 entry Object.assign 残留）
  assert.deepEqual(getConfig(), { seen: true }, "getConfig 调 source() 取服务端快照")

  assert.doesNotThrow(() => calls[0].hooks.validate({ tiers: {} }), "首次空配置保持 unresolved，以便 Web 卡片可见")
  assert.throws(() => calls[0].hooks.validate({ tiers: { junior: { provider: "provider-a", model: "model-a" } } }), /tiers/, "只配置一档时拒绝半成品")
  assert.doesNotThrow(() => calls[0].hooks.validate({
    tiers: {
      junior: { provider: "provider-a", model: "model-a" },
      senior: [{ provider: "provider-b", model: "model-b", effort: "medium", family: "family-b" }],
      expert: [{ provider: "provider-c", model: "model-c" }],
    },
  }), "单对象与候选数组均可兼容")
  assert.throws(() => calls[0].hooks.validate({
    tiers: {
      junior: [{ provider: "", model: "model-a" }],
      senior: [{ provider: "provider-b", model: "model-b" }],
      expert: [{ provider: "provider-c", model: "model-c" }],
    },
  }), /provider/, "候选 provider 为空时拒绝")
  assert.ok(TIER_DESCRIPTIONS.junior.includes("低成本"), "junior 有中文用途说明")
  assert.ok(TIER_DESCRIPTIONS.senior.includes("常规"), "senior 有中文用途说明")
  assert.ok(TIER_DESCRIPTIONS.expert.includes("核心"), "expert 有中文用途说明")
})

test("I5 真实 Schemastery：tiers schema rehydrate 后仍可执行空/完整/半成品与遗留键语义", async (t) => {
  let z
  try {
    // 默认只解析 peer 依赖；测试环境可注入已安装模块 URL，不把开发机路径写进仓库。
    const specifier = process.env.TEAM_WORK_SCHEMATERY_MODULE || "@deepseek-ai/schemastery"
    const schemastery = await import(specifier)
    z = schemastery.default ?? schemastery
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      t.skip("当前仓库未安装可解析的 @deepseek-ai/schemastery；DSH 宿主依赖环境会自动执行本测试")
      return
    }
    throw error
  }

  let installed
  installPluginSettings({ logger: { warn() {} } }, { tiers: {} }, {
    injectSettings: (callback) => callback({
      installSection(_owner, _namespace, schema, _entry, hooks) { installed = { schema, hooks } },
    }),
    importSchemastery: async () => ({ default: z }),
  })
  for (let attempt = 0; !installed && attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  assert.ok(installed, "真实 Schemastery 可用时必须注册 settings section")

  const full = {
    tiers: {
      junior: { provider: "provider-a", model: "model-a" },
      senior: [{ provider: "provider-b", model: "model-b", effort: "medium", family: "family-b" }],
      expert: [{ provider: "provider-c", model: "model-c" }],
    },
  }
  assert.deepEqual(installed.schema({}), { tiers: {} }, "空配置归一为 unresolved tiers")
  assert.deepEqual(installed.schema(full), full, "真实 schema 接受三档完整的单对象/候选数组组合")
  assert.throws(() => installed.schema({
    tiers: { junior: { provider: "provider-a", model: "model-a" } },
  }), /tiers.*一经配置/, "真实 schema 也必须拒绝缺少档位的半成品")

  const serialized = installed.schema.toJSON()
  const root = serialized.refs[serialized.uid]
  const section = serialized.refs[root.inner]
  const tiers = serialized.refs[section.dict.tiers]
  assert.equal(root.type, "transform", "顶层仍是剥离未知遗留键的 transform")
  assert.equal(typeof root.callback, "string", "transform 回调必须以源码字符串进入 JSON，供客户端重建")
  assert.doesNotMatch(root.callback, /\bvalidateTiers\b/, "回调源码不得引用服务端模块闭包")
  assert.equal(section.type, "object")
  assert.deepEqual(Object.keys(section.dict), ["tiers"], "序列化区段只公开 tiers")
  assert.equal(tiers.type, "object")
  assert.deepEqual(Object.keys(tiers.dict), ["junior", "senior", "expert"], "三个档位均出现在 Web schema")

  const rehydrated = new z(serialized)
  assert.deepEqual(rehydrated({}), { tiers: {} }, "客户端重建后可执行空配置归一")
  assert.deepEqual(rehydrated(full), full, "客户端重建后保留完整三档候选")
  assert.throws(() => rehydrated({
    tiers: { junior: { provider: "provider-a", model: "model-a" } },
  }), /tiers.*一经配置/, "客户端重建后仍拒绝半成品")
  assert.deepEqual(rehydrated({
    tiers: {},
    injectionEnabled: false,
    projectRoots: [],
    twBin: "legacy-entry",
  }), { tiers: {} }, "客户端重建后继续剥离遗留键")
})

test("I5 installPluginSettings 降级：settings 服务缺失静默、schemastery 异常 warn、installSection 异常 warn", async () => {
  // settings 服务缺失（injectSettings 回调不触发）→ 静默、getConfig 返回 entry
  const warnsNoService = []
  const ctxNS = { logger: { warn: (...a) => warnsNoService.push(a) } }
  const g1 = installPluginSettings(ctxNS, { tiers: {} }, {
    injectSettings: () => {},
    importSchemastery: async () => ({ default: {} }),
  })
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(g1(), { tiers: {} }, "settings 服务缺失 → getConfig 返回 entry")
  assert.equal(warnsNoService.length, 0, "服务缺失 → 静默不 warn")

  // schemastery 缺失（非模块缺失异常）→ warn 留痕再降级
  const warnsOther = []
  const ctxO = { logger: { warn: (...a) => warnsOther.push(a) } }
  const g2 = installPluginSettings(ctxO, { tiers: {} }, {
    injectSettings: () => { throw new Error("unreachable") },
    importSchemastery: async () => { throw new Error("schemastery broken") },
  })
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(g2(), { tiers: {} }, "schemastery 失败 → 整段降级返回 entry")
  assert.equal(warnsOther.length, 1, "非模块缺失异常 → warn 留痕一次")

  // installSection 抛错 → warn 留痕，getConfig 仍返回 entry（不阻断主链路）
  const warnsReg = []
  const ctxR = { logger: { warn: (...a) => warnsReg.push(a) } }
  const node = (kind, extra = {}) => ({
    kind,
    ...extra,
    required() { this.requiredCalled = true; return this },
    min(value) { this.minValue = value; return this },
    description(value) { this.descriptionText = value; return this },
  })
  const fakeZ = {
    string: () => node("string"),
    array: (inner) => node("array", { inner }),
    union: (items) => node("union", { items }),
    object: (shape) => {
      const schema = function (value) { return value ?? {} }
      schema.shape = shape
      schema.description = function (value) { schema.descriptionText = value; return schema }
      return schema
    },
    transform: (inner, callback) => {
      const schema = function (value) { return callback(inner(value)) }
      schema.inner = inner
      schema.callback = callback
      schema.toJSON = () => ({ type: "transform", inner: { type: "object", dict: inner.shape } })
      return schema
    },
  }
  const g3 = installPluginSettings(ctxR, { tiers: {} }, {
    injectSettings: (callback) => callback({
      installSection: () => { throw new Error("dup namespace") },
    }),
    importSchemastery: async () => ({ default: fakeZ }),
  })
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(g3(), { tiers: {} }, "注册异常 → 返回 entry")
  assert.equal(warnsReg.length, 1, "注册异常 warn 留痕一次")
})

test("I5 旧项目匹配与运行入口配置已彻底移除", async () => {
  const files = [
    "../dsh/settings.js",
    "../dsh/index.js",
    "../dsh/inject.js",
    "../dsh/tw-tool.js",
  ]
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), "utf8")
    assert.doesNotMatch(source, /\b(injectionEnabled|projectRoots|twBin|matchProjectRoot)\b/, file + " 不得残留旧配置契约")
  }
})
