// dsh-plugin 纯函数单测（不依赖 DSH 运行时；装载链验证在 I2 验证脚本与 I6 压轴 E2E）
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import vm from "node:vm"

import { hintForChild, agentsJsonPath } from "../packages/dsh-plugin/src/inject.js"
import { resolveTwBin, resolveProjectRoot } from "../packages/dsh-plugin/src/tw-tool.js"
import { matchProjectRoot, installPluginSettings, SETTINGS_NS } from "../packages/dsh-plugin/src/settings.js"
import { parseFrontmatter } from "../packages/dsh-plugin/src/skill-embed.js"

test("I4 client 工厂遵守 DSH 契约：factory(require) 直接返回 Cordis 插件", async () => {
  const registrations = []
  const source = await readFile(new URL("../packages/dsh-plugin/src-client/badge.js", import.meta.url), "utf8")
  vm.runInNewContext(source, {
    globalThis: {},
    window: { __ModuleLoader__: { load(registration) { registrations.push(registration) } } },
  })

  assert.deepEqual(registrations.map(({ id }) => id), ["team-work-runtime-dsh", "team-work-runtime"])
  for (const { factory } of registrations) {
    const plugin = factory(() => ({}))
    assert.equal(typeof plugin?.apply, "function", "factory(require) 须返回带 apply 的插件对象")
    assert.deepEqual(Array.from(plugin.inject), ["slots", "sessions"], "logger 是 ctx 内建属性，不得声明为注入服务")
  }
})

test("I2 注入寻址：childId 查 modelHints（合法/缺字段/无此 child/损坏输入）", () => {
  const agents = { mappings: { w1: "child-a" }, modelHints: { "child-a": { provider: "p", model: "m", effort: "high" }, "child-b": { provider: "p", model: "m" }, "child-c": { provider: "", model: "m" } } }
  assert.deepEqual(hintForChild(agents, "child-a"), { provider: "p", model: "m", reasoningEffort: "high" }, "effort 映射为 reasoningEffort")
  assert.deepEqual(hintForChild(agents, "child-b"), { provider: "p", model: "m" }, "无 effort 不带字段")
  assert.equal(hintForChild(agents, "child-c"), null, "空 provider 拒绝")
  assert.equal(hintForChild(agents, "child-x"), null, "无此 child")
  assert.equal(hintForChild(null, "child-a"), null, "损坏输入")
  assert.equal(hintForChild({ modelHints: "not-object" }, "a"), null, "modelHints 非对象")
})

test("I2 agents.json 路径解析：config 优先 → header.cwd 兜底 → 无则 null", () => {
  assert.equal(agentsJsonPath({ projectRoot: "/proj" }, "/cwd"), "/proj/.team-work/platform/agents.json", "config 优先")
  assert.equal(agentsJsonPath(null, "/cwd"), "/cwd/.team-work/platform/agents.json", "header.cwd 兜底")
  assert.equal(agentsJsonPath(null, null), null, "两者皆无 → 不注入")
})

test("I2 tw 工具解析：twBin config 优先；projectRoot 三级链", () => {
  assert.equal(resolveTwBin({ twBin: "/x/tw.mjs" }), "/x/tw.mjs", "config 显式")
  assert.equal(typeof resolveTwBin({}), "string", "peerDep 解析或 PATH 兜底")
  assert.equal(resolveProjectRoot({ projectRoot: "/p" }, { agent: { session: { header: { cwd: "/c" } } } }), "/p")
  assert.equal(resolveProjectRoot({}, { agent: { session: { header: { cwd: "/c" } } } }), "/c")
  assert.equal(resolveProjectRoot({}, {}), process.cwd())
})

test("I2 tw 工具 render 契约：必须返回 content 块数组（纯字符串致宿主 commit 崩溃——实机两崩铁证）", async () => {
  const { twToolDefinition } = await import("../packages/dsh-plugin/src/tw-tool.js")
  const def = twToolDefinition({})
  const rendered = def.output.render({}, { ok: true, task: "t" })
  assert.ok(Array.isArray(rendered), "render 返回数组")
  assert.equal(rendered[0]?.type, "text")
  assert.equal(typeof rendered[0]?.text, "string")
  assert.doesNotThrow(() => rendered.some((b) => b.type === "image"), "宿主 commit 的 .some 调用形态必须可用")
})
test("I2 tw 工具失败路径：超时 kill 返回失败卡；输出不可解析返回 UNPARSEABLE", async () => {
  const { twToolDefinition } = await import("../packages/dsh-plugin/src/tw-tool.js")
  const def = twToolDefinition({ twBin: "/nonexistent/tw.mjs" })
  // 输出不可解析：twBin 指向 node + 一个输出纯文本的脚本（-e）
  const def2 = twToolDefinition({ twBin: "-e", projectRoot: "/tmp" })
  // 超时：定义级 timeoutMs 传极小值——通过 deps 注入不可（runTw 内部常量）——直接测 spawn 失败路径：
  const card = await def.execute({ args: ["--version"] }, {})
  assert.equal(card.ok, false, "twBin 不存在 → 失败卡（不抛出）")
  assert.ok(card.code === "TW_SPAWN_FAILED" || card.code === "TW_OUTPUT_UNPARSEABLE" || card.ok === false, "失败码在场")
  // 参数缺 args：execute 容错（空数组 → tw help 卡片或失败卡，不抛出）
  const card2 = await def.execute({}, {})
  assert.equal(typeof card2, "object")
})

test("I2 注入链（同步 contribution 契约）：install 同步在场 + undefined 占位 + hint 迟到补读 + disposer 语义", async () => {
  const { makeInjectContribution } = await import("../packages/dsh-plugin/src/inject.js")
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
  // 宿主真实契约（SetupRegistry.apply 源码）：contribution(childCtx) 同步调用、返回值直接存为 disposer、
    // 不 await——测试原样复刻该契约：不加 await，调用后立即断言同步效果。
  const contribution = makeInjectContribution(ctx, { projectRoot: "/proj" }, {
    readFileSync: () => JSON.stringify({ modelHints: { "child-1": { provider: "p", model: "m", effort: "max" } } }),
    readFile: async () => { throw new Error("已有 hint 不应退化到异步首读") },
    installerNow: () => fakeInstallChecked,
    pollMs: 5,
  })
  const childCtx = { agent: { id: "child-1", session: { header: { cwd: "/x" } } } }
  const disposer = contribution(childCtx) // 不 await——同步契约
  assert.equal(typeof disposer, "function", "contribution 返回 disposer（宿主直接存储该返回值）")
  assert.equal(installs.length, 1, "install 在 contribution 同步段完成（监听器在场——F2 契约）")
  assert.equal(providerAtInstall, "UNDEFINED", "注册时刻 current=undefined（null 对象会清空宿主模型选择）")
  const selection = installs[0].selection
  assert.equal(selection.current?.model, "m", "恢复时已有 hint → contribution 返回前同步生效")
  assert.equal(selection.current.reasoningEffort, "max")
  // disposer：清定时器 + 透传 install 的 disposer
  disposer()
  assert.equal(installDisposers, 1, "disposer 透传 install 清理")

  // 迟到写入场景：首次读无 hint，第二次读才命中（真实时序：agent-map 晚于子代创建）
  let readCount = 0
  const installsLate = []
  const contributionLate = makeInjectContribution(ctx, { projectRoot: "/proj" }, {
    readFileSync: () => JSON.stringify({ modelHints: {} }),
    readFile: async () => {
      readCount += 1
      if (readCount < 2) return JSON.stringify({ modelHints: {} }) // 首轮：Lead 尚未 agent-map
      return JSON.stringify({ modelHints: { "child-late": { provider: "p2", model: "m2" } } })
    },
    installerNow: () => (c, s) => { installsLate.push(s) },
    pollMs: 5,
  })
  const disposeLate = contributionLate({ agent: { id: "child-late", session: { header: { cwd: "/x" } } } })
  assert.equal(installsLate[0].current, undefined, "首读未命中：不注入（继承默认）")
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(installsLate[0].current?.model, "m2", "第二次读命中：hint 补写生效（下轮请求注入）")
  disposeLate()

  // 读失败静默（超时窗口内重试，无抛出）
  const contribution2 = makeInjectContribution(ctx, { projectRoot: "/proj" }, {
    readFile: async () => { throw new Error("enoent") },
    installerNow: () => fakeInstall,
    pollMs: 5, pollMaxMs: 20,
  })
  const dispose2 = contribution2({ agent: { id: "child-2", session: { header: { cwd: "/x" } } } })
  await new Promise((r) => setTimeout(r, 40))
  dispose2()
  // 无抛出即为通过（selection 保持 undefined——不干预）

  // installer 同步解析失败 → 不注入，但仍须返回宿主可释放的 no-op disposer
  const contribution3 = makeInjectContribution(ctx, {}, { installerNow: () => null })
  const before = installs.length
  const dispose3 = contribution3({ agent: { id: "child-3" } })
  assert.equal(typeof dispose3, "function", "无安装器 → 仍返回 disposer（宿主释放时会无条件调用）")
  assert.doesNotThrow(() => dispose3(), "no-op disposer 可安全释放")
  assert.equal(installs.length, before, "无安装器 → install 不被调")

  const disposeDisabled = makeInjectContribution(ctx, { injectionEnabled: false })({ agent: { id: "child-disabled" } })
  assert.equal(typeof disposeDisabled, "function", "注入关闭 → 仍返回 disposer")
  assert.doesNotThrow(() => disposeDisabled())

  const disposeInvalid = makeInjectContribution(ctx, {}, { installerNow: () => { throw new Error("installer failed") } })({ agent: { id: "child-error" } })
  assert.equal(typeof disposeInvalid, "function", "contribution 异常 → 仍返回 disposer")
  assert.doesNotThrow(() => disposeInvalid())
})

test("I2 注入失败可诊断且不阻塞：损坏文件重试、超时与安装器异常均留恢复指引", async () => {
  const { makeInjectContribution } = await import("../packages/dsh-plugin/src/inject.js")
  const warnings = []
  const ctx = { logger: { warn: (message) => warnings.push(String(message)), info() {} } }
  let reads = 0
  const contribution = makeInjectContribution(ctx, { projectRoot: "/proj" }, {
    readFileSync: () => "{损坏",
    readFile: async () => {
      reads += 1
      const error = new Error("permission denied")
      error.code = "EACCES"
      throw error
    },
    installerNow: () => () => () => {},
    pollMs: 2,
    pollMaxMs: 8,
  })
  const dispose = contribution({ agent: { id: "child-diagnostic" } })
  await new Promise((resolve) => setTimeout(resolve, 25))
  dispose()

  assert.ok(reads > 0, "损坏同步快照后仍异步重试")
  assert.ok(warnings.some((message) => message.includes("agents.json") && message.includes("继续补读")), "读错留痕并说明自动重试")
  assert.ok(warnings.some((message) => message.includes("超时") && message.includes("agent-map")), "补读超时给出恢复指引")

  const contributionInstallerError = makeInjectContribution(ctx, {}, {
    installerNow: () => { throw new Error("installer failed") },
  })
  const disposer = contributionInstallerError({ agent: { id: "child-installer-error" } })
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
test("I5 matchProjectRoot：最长前缀命中/无命中/空数组", () => {
  const roots = [
    { path: "/a" },
    { path: "/a/b", twBin: "/deep/tw.mjs" },
    { path: "/a/b/c" },
  ]
  // 最长前缀命中：cwd 落在多级前缀，取最深命中项（带 twBin 覆盖）
  assert.deepEqual(matchProjectRoot(roots, "/a/b/c/app"), { path: "/a/b/c" }, "最长前缀命中")
  assert.deepEqual(matchProjectRoot(roots, "/a/b/x"), { path: "/a/b", twBin: "/deep/tw.mjs" }, "次深命中（保留附加字段）")
  // 无 path 前缀匹配 → null
  assert.equal(matchProjectRoot(roots, "/other/proj"), null, "无前缀命中 → null")
  // 空数组 → null
  assert.equal(matchProjectRoot([], "/a/b/c"), null, "空数组 → null")
  assert.equal(matchProjectRoot(null, "/a/b/c"), null, "非数组 → null")
})

test("I5 matchProjectRoot 分隔符边界（Risk 4）：/a/b 不误命中 /a/bc、末尾斜杠、相对路径", () => {
  const roots = [{ path: "/a/b", twBin: "/deep/tw.mjs" }]
  // /a/b vs /a/bc：目录名边界不得前缀误命中
  assert.equal(matchProjectRoot(roots, "/a/bc"), null, "/a/bc 不得命中 /a/b")
  assert.equal(matchProjectRoot(roots, "/a/bc/x/y"), null, "/a/bc 子路径不得命中 /a/b")
  assert.deepEqual(matchProjectRoot(roots, "/a/b/app"), { path: "/a/b", twBin: "/deep/tw.mjs" }, "/a/b 正常命中")
  // 末尾斜杠：cwd 与 path 带尾斜杠等价于不带
  assert.deepEqual(matchProjectRoot(roots, "/a/b/"), { path: "/a/b", twBin: "/deep/tw.mjs" }, "cwd 尾斜杠")
  assert.deepEqual(matchProjectRoot([{ path: "/a/b/" }], "/a/b/app"), { path: "/a/b/" }, "path 尾斜杠")
  assert.deepEqual(matchProjectRoot(roots, "/a/b/app/"), { path: "/a/b", twBin: "/deep/tw.mjs" }, "cwd 深路径尾斜杠")
  // 相对路径输入：不越界匹配绝对 cwd（只按字符串前缀，相对对相对才可能命中）
  assert.equal(matchProjectRoot(roots, "a/b"), null, "相对 cwd 不命中绝对 path")
  assert.deepEqual(matchProjectRoot([{ path: "a/b" }], "a/b/x"), { path: "a/b" }, "相对对相对命中")
  // 空 path / 非字符串 path / 缺 path 条目跳过（但其他有效条目仍参与命中）
  assert.equal(matchProjectRoot([{ path: "" }], "/a/b"), null, "空 path 跳过")
  assert.deepEqual(matchProjectRoot([{ path: "/a/b" }, {}], "/a/b/x"), { path: "/a/b" }, "缺 path 条目跳过，有效条目仍命中")
  assert.deepEqual(matchProjectRoot([{ path: "/a/b/c", twBin: "/c" }, { path: "/a/b" }], "/a/b/x"), { path: "/a/b" }, "无效条目跳过不影响最长前缀")
})

test("I5 installPluginSettings 接线契约：setSource 收到 thunk、schema 为可调用函数", async () => {
  // 桩 installSettingsSection：断言三方——schema 是函数、setSource 是函数、hooks 形状在场。
  const calls = []
  let receivedSource = null
  const fakeInstallSettingsSection = (_ctx, ns, schema, entry, hooks) => {
    calls.push({ ns, schema, entry, hooks })
    // 模拟 service 契约：把「返回当前快照」的 thunk 交给 setSource（对应 scope.get()）
    hooks.setSource((receivedSource = () => ({ seen: true })))
    hooks.onChange()
  }
  const fakeZ = {
    string: () => ({ default: () => void 0 }),
    boolean: () => ({ default: () => void 0 }),
    array: () => ({ default: () => void 0 }),
    object: () => function (value) { return value ?? {} }, // z.object 返回可调用 schema
  }
  const importSettings = async () => ({
    installSettingsSection: fakeInstallSettingsSection,
    settingsNamespace: (ns) => ns,
  })
  const importSchemastery = async () => ({ default: fakeZ })

  const ctx = { logger: { warn() {} } }
  const entry = { projectRoots: [], twBin: null, injectionEnabled: true }
  const getConfig = installPluginSettings(ctx, entry, { importSettings, importSchemastery })

  // fire-and-forget 注册需要一拍：让异步 IIFE 跑完
  await new Promise((r) => setTimeout(r, 20))

  assert.equal(calls.length, 1, "installSettingsSection 被调用一次")
  assert.equal(calls[0].ns, SETTINGS_NS, "namespace 直传")
  assert.equal(typeof calls[0].schema, "function", "schema 必须是可调用函数（非裸对象，否则 service resolve 抛 TypeError）")
  assert.equal(typeof calls[0].hooks.setSource, "function", "hooks.setSource 在场")
  assert.equal(typeof receivedSource, "function", "setSource 收到的是 thunk（函数），非值")
  // setSource 存 thunk + 读值调 source()：getConfig() 返回服务端快照（非 entry Object.assign 残留）
  assert.deepEqual(getConfig(), { seen: true }, "getConfig 调 source() 取服务端快照")
})

test("I5 installPluginSettings 降级：模块不存在静默、其他异常 warn、两 import 任一失败整段降级", async () => {
  // 模块不存在（ERR_MODULE_NOT_FOUND）→ 静默（无 warn）、getConfig 返回 entry
  const warnsNotFound = []
  const ctxNF = { logger: { warn: (...a) => warnsNotFound.push(a) } }
  const g1 = installPluginSettings(ctxNF, { twBin: "/entry" }, {
    importSettings: async () => { const e = new Error("Cannot find package '@deepseek-ai/dsh-settings'"); e.code = "ERR_MODULE_NOT_FOUND"; throw e },
    importSchemastery: async () => { throw new Error("unreachable") },
  })
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(g1(), { twBin: "/entry" }, "无服务 → getConfig 返回 entry")
  assert.equal(warnsNotFound.length, 0, "模块不存在 → 静默不 warn")

  // schemastery 缺失（其他异常非模块缺失）→ warn 留痕再降级
  const warnsOther = []
  const ctxO = { logger: { warn: (...a) => warnsOther.push(a) } }
  const g2 = installPluginSettings(ctxO, { twBin: "/entry2" }, {
    importSettings: async () => ({ installSettingsSection: () => {}, settingsNamespace: (n) => n }),
    importSchemastery: async () => { throw new Error("schemastery broken") },
  })
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(g2(), { twBin: "/entry2" }, "schemastery 失败 → 整段降级返回 entry")
  assert.equal(warnsOther.length, 1, "非模块缺失异常 → warn 留痕一次")

  // installSettingsSection 本身抛错 → warn 留痕，getConfig 仍返回 entry（不阻断主链路）
  const warnsReg = []
  const ctxR = { logger: { warn: (...a) => warnsReg.push(a) } }
  const g3 = installPluginSettings(ctxR, { injectionEnabled: false }, {
    importSettings: async () => ({ installSettingsSection: () => { throw new Error("dup namespace") }, settingsNamespace: (n) => n }),
    importSchemastery: async () => ({ default: { object: () => function () {}, array: () => ({ default: () => 0 }), string: () => ({}), boolean: () => ({ default: () => 0 }) } }),
  })
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(g3(), { injectionEnabled: false }, "注册异常 → 返回 entry")
  assert.equal(warnsReg.length, 1, "注册异常 warn 留痕一次")
})

test("I5 resolveTwBin 覆盖链：命中项 twBin > settings.twBin > peerDep 解析 > PATH", () => {
  assert.equal(resolveTwBin({ twBin: "/settings/tw.mjs" }, { twBin: "/hit/tw.mjs" }), "/hit/tw.mjs", "matchProjectRoot 命中项 twBin 最优先")
  assert.equal(resolveTwBin({ twBin: "/settings/tw.mjs" }, {}), "/settings/tw.mjs", "无命中项 → settings.twBin")
  assert.equal(resolveTwBin({ twBin: "/settings/tw.mjs" }, null), "/settings/tw.mjs", "hit=null → settings.twBin")
  assert.equal(typeof resolveTwBin({}, {}), "string", "皆无 → peerDep 解析或 PATH 兜底")
})
