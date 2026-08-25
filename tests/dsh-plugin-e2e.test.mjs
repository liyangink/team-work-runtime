// E2E-A：真实 cordis 装载验证（F-1/F-2 全自动层）
// 用 dsh 同源 cordis（真实 Context/Fiber/inject 协议）装载 team-work-dsh 插件 + 服务桩——
// 验证 inject 服务解析通过（F1 类 blocker 的永久回归防线）与三注册调用 + 降级语义。
import assert from "node:assert/strict"
import test from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"

const DSH = "/Users/liyang/.nvm/versions/node/v24.15.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai"

test("E2E-A：cordis 真实装载——inject 服务解析 + apply 三注册 + 非法名防线", async () => {
  const { Context } = await import(pathToFileURL(path.join(DSH, "cordis/lib/index.js")).href)
  const plugin = await import("../packages/dsh-plugin/src/index.js")

  // 注入面核查：inject 数组只含服务名（logger 等 ctx 内建属性不得出现——交叉审查① F1 契约）
  assert.deepEqual(plugin.inject, ["subagents", "skills", "tools"], "inject 恰为三个真实服务")

  // 真实 cordis 装载：提供三个桩服务 → 插件 apply 必须被调用且三注册发生
  const events = { registered: [], setups: [] }
  const ctx = new Context({ _isRoot: true })
  ctx.provide("subagents", {
    registerContinuableSetup(fn) { events.setups.push(fn); return () => {} },
  })
  ctx.provide("skills", {
    register(spec) { events.registered.push(["skill", spec.name]) },
  })
  ctx.provide("tools", {
    register(def) { events.registered.push(["tool", def.name, Boolean(def.output?.render), Boolean(def.parameters)]) },
  })
  // 不提供 logger 服务（它是 ctx 内建属性）——如果插件 inject 需要它，装载会 INACTIVE
  const fiber = ctx.effect(() => plugin.apply(ctx, {}), "e2e-a: apply")
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(events.setups.length, 1, "registerContinuableSetup 被调")
  assert.ok(events.registered.some(([kind, name]) => kind === "skill" && name === "team-work"), "skill 必须以 team-work 注册")
  assert.ok(events.registered.some(([kind, name]) => kind === "tool" && name === "tw"), "tw 工具注册被调")
  const twReg = events.registered.find(([kind, name]) => kind === "tool" && name === "tw")
  assert.equal(twReg[2], true, "output.render 在场（F4 形状）")
  assert.equal(twReg[3], true, "parameters 在场（非 inputSchema）")

  // inject 含非服务名的反证：**主防线 = 上方 assert.deepEqual(plugin.inject, [三服务])**——
  // 任何新增/改名非法名都会使 deepEqual 整体 fail。下方静态白名单段仅冗余兜底（直调模式不经
  // 宿主 inject 校验，静态段对白名单外的非法名会假阴）——不得单独删除 deepEqual 主防。
  const builtinCtxProps = ["logger", "events", "effect", "provide", "inject"]
  for (const name2 of plugin.inject) assert.ok(!builtinCtxProps.includes(name2), "inject 不含 ctx 内建属性：" + name2)
  fiber?.()
})

test("E2E-A：插件激活等待安装器解析完成后才开放 continuable setup", async () => {
  const plugin = await import("../packages/dsh-plugin/src/index.js")
  const setups = []
  const installs = []
  let finishResolve
  const installerReady = new Promise((resolve) => { finishResolve = resolve })
  const ctx = {
    subagents: { registerContinuableSetup(contribution) { setups.push(contribution) } },
    skills: { register() {} },
    tools: { register() {} },
    logger: { warn() {}, info() {} },
  }
  const activation = plugin.apply(ctx, { injectionEnabled: true }, {
    resolveInstaller: () => installerReady,
    registerEmbeddedSkill: async () => {},
    installPluginSettings: (_ctx, entry) => () => entry,
  })

  assert.equal(setups.length, 0, "安装器尚未解析时不得提前开放 setup")
  finishResolve((_childCtx, selection) => { installs.push(selection); return () => {} })
  await activation
  assert.equal(setups.length, 1, "安装器就绪后才注册 setup")

  const dispose = setups[0]({ agent: { id: "child-ready" } })
  assert.equal(installs.length, 1, "首个子代同步安装 listener，不依赖第二个子代缓存")
  assert.equal(typeof dispose, "function")
  dispose()
})

test("E2E-A：注入 contribution 真调用链（childCtx 桩 + agents.json 真文件）", async () => {
  const { makeInjectContribution } = await import("../packages/dsh-plugin/src/inject.js")
  const { mkdtemp, writeFile, mkdir } = await import("node:fs/promises")
  const os = await import("node:os")
  // 真实临时项目 + agents.json
  const proj = await mkdtemp(path.join(os.tmpdir(), "e2a-"))
  await mkdir(path.join(proj, ".team-work/platform"), { recursive: true })
  await writeFile(path.join(proj, ".team-work/platform/agents.json"), JSON.stringify({
    mappings: { w1: "child-real" },
    modelHints: { "child-real": { provider: "prov-demo", model: "model-demo", effort: "max" } },
  }))
  // fake installer 捕获 selection（完整链：路径解析→真文件读取→hintForChild→补写）
  const installs = []
  const contribution = makeInjectContribution({ logger: { info() {} } }, { projectRoot: proj }, {
    installerNow: () => (ctx2, sel) => installs.push(sel), // 同步契约：contribution 同步段直取安装器
    pollMs: 5,
  })
  // 宿主真实契约：同步调用、不 await（返回 disposer）
  const disposer = contribution({ agent: { id: "child-real", session: { header: { cwd: proj } } } })
  assert.equal(typeof disposer, "function", "contribution 返回 disposer")
  assert.equal(installs.length, 1)
  assert.equal(installs[0].current.model, "model-demo", "恢复时已有 hint 在 contribution 返回前生效")
  assert.equal(installs[0].current.reasoningEffort, "max", "effort 映射链")
  disposer()
})
