// dsh-dispatch.test.mjs — tw-dispatch 工作流派发工具测试（方案 docs/dsh-dispatch-tool-plan.md §5 自动测试）
// 覆盖：非派发卡透传（awaiting-user/wait-inflight/completed/拒绝/防御空波）、三步集成
// （dispatch-plan → 创建核心 → agent-map）、标签拼接（含缺省 note）、多包逐项串行、
// 登记失败补登记指引、创建失败回收语义、continuation 波归属、三工具分工文案同源。
// 纯 fake ctx 与 fake runTw（不依赖 DSH 运行时与真实 tw 子进程）；创建核心走真实实现验证复用链路。
import assert from "node:assert/strict"
import test from "node:test"

import {
  TOOL_NAME,
  STAGE_ABBREV,
  buildDispatchLabel,
  roleAbbrev,
  twDispatchDefinition,
  twDispatchToolDescription,
} from "../dsh/tw-dispatch.js"
import { decisionTableText, systemPromptSection, toolDescriptionText, twToolSubagentDefinition } from "../dsh/tw-tool-subagent.js"
import * as hostPlugin from "../dsh/index.js"

const EXEC = { agent: { id: "parent-agent-1", session: { header: { cwd: "/proj" } } } }

// ── fake 工厂 ────────────────────────────────────────────────────────────────

// 派发计划（stop=null）样例，形状对齐 runtime-v3/cli.mjs cmdDispatchPlan 输出。
function planCard(waves, extra = {}) {
  return { ok: true, task: "demo-t", stage: "implementation", stop: null, waves, card: { status: "dispatch", next: "await-reports" }, ...extra }
}
function ownerWave(overrides = {}) {
  return {
    dispatchKey: "d1-abc123",
    waveId: "wv1",
    kind: "produce",
    role: "owner",
    tier: "junior",
    round: 1,
    continuation: false,
    prompt: "派单全文 PROMPT",
    deliver: "deliver",
    modelHint: { provider: "p-a", model: "m-j1", source: "global-settings" },
    weight: 1,
    ...overrides,
  }
}

// fake CLI：记录每次调用；按命令分派卡片。failCommands 按命令名强制返回失败卡。
function makeRunTw(plan, { failCommands = {}, onCall } = {}) {
  const calls = []
  const runTw = async (args, cwd) => {
    calls.push({ cmd: args[0], args, cwd })
    if (onCall) onCall(args[0])
    // failCommands 值可为卡片（命中即失败）或判定函数（返回卡片才失败，null 放行）。
    const fail = typeof failCommands[args[0]] === "function" ? failCommands[args[0]](args) : failCommands[args[0]]
    if (fail) return fail
    if (args[0] === "dispatch-plan") return plan
    if (args[0] === "agent-map") return { ok: true, task: "demo-t", key: args[4], agent: args[6], note: "已登记派单映射" }
    throw new Error("unexpected command: " + args[0])
  }
  return { runTw, calls }
}

// fake 宿主 ctx：仿 dsh-tw-tool-subagent.test.mjs 的 makeFakeCtx（创建核心真实链路所需服务）。
function makeCtx(overrides = {}) {
  const started = []
  const drained = []
  const ctx = {
    llm: { resolveCallConfig: async (config) => ({ ...config }) },
    subagents: {
      getProvider: () => ({ name: "spawn", prepareContinuable: async () => ({}) }),
      startContinuable: async (spec) => {
        started.push(spec)
        return { childId: spec.childId, messageId: "m-" + started.length }
      },
      drainContinuableChildren: async (_parent, ids) => {
        drained.push(...ids)
      },
    },
    sessions: { get: (id) => ({ id }), flush: async () => true },
    sessionPersistence: {},
    ...overrides,
  }
  return { ctx, started, drained }
}

function makeTool(deps = {}, ctxOverrides = {}) {
  const { ctx, started, drained } = makeCtx(ctxOverrides)
  const selections = deps.directSelections ?? new Map()
  const tool = twDispatchDefinition(ctx, { directSelections: selections, ...deps })
  return { tool, ctx, started, drained, selections }
}

// ── 标签拼接（§3.3：四项机器段来自派单事实，唯一语义成分是 note） ────────────────

test("buildDispatchLabel：多包带 @包、显式 note、阶段缩写按固定表", () => {
  assert.equal(
    buildDispatchLabel({ task: "task-a", stage: "code-review" }, { role: "owner", package: "store", round: 2 }, "模块说明"),
    "CR·owner@store · 模块说明 #task-a"
  )
  assert.equal(
    buildDispatchLabel({ task: "task-a", stage: "implementation" }, { role: "owner", round: 1 }, null),
    "IMPL·owner · task-a-owner-r1 #task-a"
  )
})

test("buildDispatchLabel：challenger 缩写 chal；review 阶段复用 DESIGN/SPEC；未知阶段回退原 id；note 端到端去空白", () => {
  assert.equal(
    buildDispatchLabel({ task: "t", stage: "design-review" }, { role: "challenger", round: 1 }, " 方案审查 "),
    "DESIGN·chal · 方案审查 #t"
  )
  assert.equal(buildDispatchLabel({ task: "t", stage: "spec-review" }, { role: "expert", round: 1 }, null), "SPEC·expert · t-expert-r1 #t")
  assert.equal(buildDispatchLabel({ task: "t", stage: "unknown-stage" }, { role: "owner", round: 3 }, null), "unknown-stage·owner · t-owner-r3 #t")
  assert.equal(roleAbbrev("challenger"), "chal")
  assert.equal(roleAbbrev("owner"), "owner")
  assert.equal(roleAbbrev("expert"), "expert")
  assert.equal(STAGE_ABBREV.e2e, "E2E")
})

test("buildDispatchLabel：简述缺省形态不含 #（任务段是唯一 # 定界）", () => {
  const label = buildDispatchLabel({ task: "demo", stage: "test" }, { role: "owner", round: 2 }, null)
  assert.equal(label.split("#").length, 2, "恰好一个任务段 #：" + label)
})

// ── 参数校验 ─────────────────────────────────────────────────────────────────

test("参数校验：task 缺失 / writables 形状非法 / cwd 无法解析，均不触发 CLI 调用", async () => {
  const cliCalls = []
  const { tool } = makeTool({ runTw: async (args) => { cliCalls.push(args); throw new Error("不应调用 CLI") } })
  const exec = EXEC
  assert.equal((await tool.execute({}, exec)).code, "TW_DISPATCH_TASK_REQUIRED")
  assert.equal((await tool.execute({ task: "" }, exec)).code, "TW_DISPATCH_TASK_REQUIRED")
  assert.equal((await tool.execute({ task: "t", writables: "R.md:doc" }, exec)).code, "TW_DISPATCH_WRITABLES_INVALID")
  assert.equal((await tool.execute({ task: "t", writables: [{ path: "R.md" }] }, exec)).code, "TW_DISPATCH_WRITABLES_INVALID")
  const noCwd = await tool.execute({ task: "t" }, { agent: { id: "p" } })
  assert.equal(noCwd.code, "TW_DISPATCH_CWD_UNRESOLVED")
  assert.equal(cliCalls.length, 0)
})

// ── 非派发卡透传（§3.2：Lead 循环收敛为反复调用，卡片形态不变） ─────────────────

test("透传：awaiting-user / wait-inflight / completed / blocked / archived 卡原样返回，不创建子代理", async () => {
  const awaiting = { ok: true, task: "demo-t", stage: "finish", stop: "awaiting-user", waves: [], card: { ok: true, status: "awaiting-user", question: "?", choices: ["accept", "rework"] } }
  const inflight = { ok: true, task: "demo-t", stage: "implementation", stop: "wait-inflight", waves: [], dispatchKey: "d1-x", inflight: [{ key: "d1-x", prompt: "原派单" }], card: { status: "wait-inflight" } }
  const completed = { ok: true, task: "demo-t", stage: "finish", stop: "completed", waves: [], card: { ok: true, status: "completed", next: "archive" } }
  const blocked = { ok: true, task: "demo-t", stage: null, stop: "blocked", waves: [], card: { ok: false, blockers: [{ code: "X", recovery: "r" }] } }
  const archived = { ok: true, task: "demo-t", stage: null, stop: "archived", waves: [], card: { archived: true } }
  for (const card of [awaiting, inflight, completed, blocked, archived]) {
    const { runTw, calls } = makeRunTw(card)
    const { tool, started } = makeTool({ runTw })
    const out = await tool.execute({ task: "demo-t" }, EXEC)
    assert.deepEqual(out, card, "原样透传 " + card.stop)
    assert.deepEqual(calls.map((c) => c.cmd), ["dispatch-plan"])
    assert.equal(started.length, 0, card.stop + " 卡不得创建子代理")
  }
})

test("透传：CLI 拒绝卡（ok:false 含 fix 指引）与防御性空波计划均原样返回", async () => {
  const rejected = { ok: false, code: "TASK_NOT_FOUND", message: "任务不存在", fix: "检查拼写；tw open 创建新任务" }
  {
    const { runTw } = makeRunTw(rejected)
    const { tool } = makeTool({ runTw })
    assert.deepEqual(await tool.execute({ task: "ghost" }, EXEC), rejected)
  }
  {
    const { runTw } = makeRunTw({ ok: true, task: "demo-t", stage: "finish", stop: null, waves: [] })
    const { tool, started } = makeTool({ runTw })
    const out = await tool.execute({ task: "demo-t" }, EXEC)
    assert.equal(out.stop, null)
    assert.equal(started.length, 0, "空 waves 不派发")
  }
})

// ── 三步集成成功路径（§5：dispatch-plan → 创建 → 登记） ────────────────────────

test("三步集成：真实创建核心 + agent-map 登记；标签/注入选择/登记参数全部对齐", async () => {
  const plan = planCard([ownerWave()])
  const { runTw, calls } = makeRunTw(plan)
  const { tool, ctx, started, selections } = makeTool({ runTw, tiersSource: () => ({}) })
  // 创建核心写表 → 宿主 setup 贡献在 startContinuable 期间 take-once（此处以观察点模拟时机），
  // 启动确认成功后核心清理表项。
  let selectionAtStart
  const origStart = ctx.subagents.startContinuable
  ctx.subagents.startContinuable = async (spec) => {
    selectionAtStart = selections.get(spec.childId)
    return origStart(spec)
  }
  const out = await tool.execute({ task: "demo-t", note: "接口改造", writables: [{ path: "src/", kind: "source" }] }, EXEC)

  assert.deepEqual(calls[0].args, ["dispatch-plan", "--task", "demo-t", "--json", "--writable", "src/:source"])
  assert.equal(calls[0].cwd, "/proj")
  assert.equal(started.length, 1)
  const spec = started[0]
  assert.equal(spec.label, "IMPL·owner · 接口改造 #demo-t", "标签按派单事实 + note 自动拼接")
  assert.equal(spec.request.prompt[0].text, "派单全文 PROMPT", "prompt 原样转发")
  assert.deepEqual(spec.request.agentOptions, { provider: "p-a", model: "m-j1" }, "target 直取 modelHint（effort 走直接选择）")
  assert.deepEqual(selectionAtStart, { provider: "p-a", model: "m-j1" }, "直接选择经共享通道写入（宿主 take-once 时机在场）")
  assert.equal(selections.size, 0, "启动确认成功后核心清理表项")

  assert.deepEqual(calls[1].args, ["agent-map", "--task", "demo-t", "--key", "d1-abc123", "--agent", spec.childId])
  assert.deepEqual(out, {
    ok: true,
    task: "demo-t",
    stage: "implementation",
    dispatched: [{
      ok: true,
      key: "d1-abc123",
      label: "IMPL·owner · 接口改造 #demo-t",
      sessionId: spec.childId,
      provider: "p-a",
      model: "m-j1",
      waveId: "wv1",
      registered: true,
    }],
  })
})

test("modelHint 带 effort 时 target 透传 effort，创建核心验证后生效", async () => {
  const plan = planCard([ownerWave({ modelHint: { provider: "p-c", model: "m-e1", source: "global-settings", effort: "high" } })])
  const { runTw } = makeRunTw(plan)
  const { tool, started } = makeTool({ runTw })
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(out.dispatched[0].ok, true)
  assert.equal(out.dispatched[0].effort, "high")
  assert.deepEqual(started[0].request.agentOptions, { provider: "p-c", model: "m-e1" })
})

test("writables 省略时 dispatch-plan 不带 --writable 参数", async () => {
  const { runTw, calls } = makeRunTw(planCard([ownerWave()]))
  const { tool } = makeTool({ runTw })
  await tool.execute({ task: "demo-t" }, EXEC)
  assert.deepEqual(calls[0].args, ["dispatch-plan", "--task", "demo-t", "--json"])
})

// ── 多包逐项（§3.5：逐张串行创建+登记，返回数组） ─────────────────────────────

test("多包波：两张派单逐张串行「创建→登记」，结果逐项返回", async () => {
  const wave1 = ownerWave({ dispatchKey: "d1-p1", package: "store" })
  const wave2 = ownerWave({ dispatchKey: "d2-p2", waveId: "wv1", package: "intake", modelHint: { provider: "p-b", model: "m-j2", source: "global-settings" } })
  const order = []
  const { runTw, calls } = makeRunTw(planCard([wave1, wave2]), {
    onCall: (cmd) => order.push("cli:" + cmd),
  })
  const { tool, ctx, started } = makeTool({ runTw })
  const origStart = ctx.subagents.startContinuable
  ctx.subagents.startContinuable = async (spec) => {
    order.push("create:" + spec.label)
    return origStart(spec)
  }
  const out = await tool.execute({ task: "demo-t" }, EXEC)

  assert.equal(out.dispatched.length, 2)
  assert.ok(out.dispatched.every((d) => d.ok && d.registered))
  assert.deepEqual(
    order,
    ["cli:dispatch-plan", "create:IMPL·owner@store · demo-t-owner-r1 #demo-t", "cli:agent-map", "create:IMPL·owner@intake · demo-t-owner-r1 #demo-t", "cli:agent-map"],
    "逐张串行：创建 1 → 登记 1 → 创建 2 → 登记 2"
  )
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 2)
  assert.deepEqual(out.dispatched.map((d) => d.sessionId), started.map((s) => s.childId))
})

// ── 登记失败（§3.6：部分成功 + 补登记指引） ───────────────────────────────────

test("登记失败：子会话已创建不回收，逐项报错并给 tw agent-map 补登记指引；成功项不回滚", async () => {
  const plan = planCard([ownerWave({ dispatchKey: "d1-ok" }), ownerWave({ dispatchKey: "d2-mapfail", package: "api" })])
  const { runTw } = makeRunTw(plan, {
    failCommands: {
      // 仅 d2-mapfail 的登记失败；d1-ok 的登记正常成功（验证部分成功语义）。
      "agent-map": (args) => (args[4] === "d2-mapfail" ? { ok: false, code: "USAGE", message: "key d2-mapfail 不是本任务的派单 key" } : null),
    },
  })
  const { tool, started, drained } = makeTool({ runTw })
  const out = await tool.execute({ task: "demo-t" }, EXEC)

  assert.equal(out.ok, true)
  assert.equal(out.failures, 1)
  assert.equal(out.dispatched[0].ok, true, "已成功项不回滚")
  const bad = out.dispatched[1]
  assert.equal(bad.ok, false)
  assert.equal(bad.code, "TW_DISPATCH_REGISTER_FAILED")
  assert.equal(bad.sessionId, started[1].childId, "子会话已在工作，不回收")
  assert.equal(drained.length, 0, "登记失败不触发回收语义")
  assert.match(bad.message, new RegExp("tw agent-map --task demo-t --key d2-mapfail --agent " + started[1].childId + " 补登记"))
  assert.match(bad.message, /勿重复创建/)
})

// ── 创建失败（§3.6：该项错误卡；已创建子会话按核心回收语义处理；不登记） ──────────

test("创建失败：模型验证失败不留子会话，不登记映射；继续处理后续派单", async () => {
  const plan = planCard([ownerWave({ dispatchKey: "d1-bad", modelHint: { provider: "p-x", model: "gone", source: "global-settings" } }), ownerWave({ dispatchKey: "d2-next" })])
  const { ctx } = makeCtx()
  // 仅 p-x/gone 不可解析；第二张派单的模型正常（验证逐项继续）。
  ctx.llm.resolveCallConfig = async (config) => {
    if (config.model === "gone") throw new Error("unknown model: gone")
    return { ...config }
  }
  const { runTw, calls } = makeRunTw(plan)
  const tool = twDispatchDefinition(ctx, { runTw })
  const out = await tool.execute({ task: "demo-t" }, EXEC)

  assert.equal(out.dispatched[0].ok, false)
  assert.equal(out.dispatched[0].code, "TW_SUB_MODEL_INVALID")
  assert.match(out.dispatched[0].message, /未创建子会话/)
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 1, "仅第二张派单登记")
  assert.equal(out.dispatched[1].ok, true, "单张失败不阻断后续")
  assert.equal(out.failures, 1)
})

test("创建失败：startContinuable 抛错 → 清理待注入选择，不登记映射", async () => {
  const { ctx } = makeCtx({
    subagents: {
      getProvider: () => ({ prepareContinuable: async () => ({}) }),
      startContinuable: async () => { throw new Error("host exploded") },
      drainContinuableChildren: async () => {},
    },
  })
  const { runTw, calls } = makeRunTw(planCard([ownerWave()]))
  const tool = twDispatchDefinition(ctx, { runTw })
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(out.dispatched[0].code, "TW_SUB_START_FAILED")
  assert.equal(out.dispatched[0].sessionId, undefined)
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 0, "创建失败不登记")
})

test("创建失败：flush 未确认 → 核心回收未确认子会话（drain 被调），不登记映射", async () => {
  const { ctx } = makeCtx({ sessions: { get: (id) => ({ id }), flush: async () => false } })
  const { runTw, calls } = makeRunTw(planCard([ownerWave()]))
  const tool = twDispatchDefinition(ctx, { runTw })
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(out.dispatched[0].code, "TW_SUB_NOT_PERSISTED")
  assert.match(out.dispatched[0].message, /已停止并释放未确认子会话/)
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 0, "启动未确认不登记")
})

// ── continuation 波归属（§3.8：续派是 send_message 不是创建） ──────────────────

test("continuation 且有 expectedAgentId：不创建子代理，返回 send_message 指引", async () => {
  const wave = ownerWave({ dispatchKey: "d5-cont", waveId: "wv3", kind: "respond", round: 2, continuation: true, expectedAgentId: "child-uuid-7" })
  const { runTw } = makeRunTw(planCard([wave]))
  const { tool, started } = makeTool({ runTw })
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(started.length, 0, "续派不经创建")
  const item = out.dispatched[0]
  assert.equal(item.ok, true)
  assert.equal(item.continuation, true)
  assert.equal(item.expectedAgentId, "child-uuid-7")
  assert.equal(item.action, "send_message")
  assert.match(item.message, /send_message 向 child-uuid-7/)
  assert.equal(item.sessionId, undefined)
})

test("continuation 但映射缺失（expectedAgentIdMissing）：走创建+登记路径", async () => {
  const wave = ownerWave({ dispatchKey: "d6-fresh", kind: "respond", round: 2, continuation: true, expectedAgentIdMissing: true })
  const { runTw, calls } = makeRunTw(planCard([wave]))
  const { tool, started } = makeTool({ runTw })
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(started.length, 1, "resumeNote 场景是创建路径")
  assert.equal(out.dispatched[0].ok, true)
  assert.equal(out.dispatched[0].registered, true)
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 1)
})

// ── 三工具分工文案同源（§3.7：说明与 systemPrompt 同表，机制保证不漂移） ──────────

test("分工文案同源：tw-dispatch / tw-tool-subagent 工具说明 / systemPrompt section 引用同一 decisionTableText", () => {
  const table = decisionTableText()
  assert.match(table, /正在推进 team-work 任务（派波次成员\/推进一步） → tw-dispatch/)
  assert.match(table, /非工作流委派：只读子派单、用户 @档位、并行调查、独立审查等 → tw-tool-subagent/)
  assert.match(table, /任务簿记：决定、门禁查询、交付、评审、补登记 → tw/)

  assert.ok(twDispatchToolDescription().includes(table), "tw-dispatch 工具说明含同表")
  assert.ok(toolDescriptionText().includes(table), "tw-tool-subagent 工具说明含同表")
  assert.ok(systemPromptSection().text.includes(table), "systemPrompt section 含同表")

  const dispatchDef = twDispatchDefinition({}, {})
  const subDef = twToolSubagentDefinition({}, {})
  assert.equal(dispatchDef.description, twDispatchToolDescription())
  assert.equal(subDef.description, toolDescriptionText())
})

test("工具定义形态：名称/并发安全/参数面只收语义（key、modelHint、标签均不向模型索要）", () => {
  const def = twDispatchDefinition({}, {})
  assert.equal(def.name, TOOL_NAME)
  assert.equal(def.name, "tw-dispatch")
  assert.equal(typeof def.timeoutMs, "number")
  assert.equal(def.isConcurrencySafe(), true)
  assert.deepEqual(Object.keys(def.parameters.properties), ["task", "note", "writables"])
  assert.deepEqual(def.parameters.required, ["task"])
})

// ── index 装配：三工具注册且共享同一份直接选择表 ───────────────────────────────

test("index 装配：三工具注册；tw-dispatch 创建核心的 take-once 语义不受影响", async () => {
  const registered = []
  const ctx = {
    logger: { warn() {}, info() {} },
    tools: { register(def) { registered.push(def) } },
    subagents: {
      registerContinuableSetup() { return () => {} },
      getProvider: () => ({ prepareContinuable: async () => ({}) }),
      startContinuable: async (spec) => ({ childId: spec.childId, messageId: "m1" }),
      drainContinuableChildren: async () => {},
    },
    llm: { resolveCallConfig: async (config) => ({ ...config }) },
    sessions: { get: (id) => ({ id }), flush: async () => true },
    sessionPersistence: {},
  }
  const dispose = await hostPlugin.apply(ctx, {}, {
    resolveInstaller: async () => (_childCtx, _selection) => () => {},
    installPluginSettings: () => () => ({}),
    registerEmbeddedSkill: async () => {},
  })
  try {
    assert.deepEqual(registered.map((d) => d.name), ["tw", "tw-tool-subagent", "tw-dispatch"])
    const { runTw, calls } = makeRunTw(planCard([ownerWave()]))
    const selections = new Map()
    // 以同形 deps 重建定义（index 传入 tiersSource/directSelections/isModelInjectionReady 的形状已由注册断言与既有 index 测试覆盖）
    const tool = twDispatchDefinition(ctx, { runTw, directSelections: selections })
    const out = await tool.execute({ task: "demo-t" }, EXEC)
    assert.equal(out.dispatched[0].ok, true, JSON.stringify(out))
    assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 1)
    assert.equal(selections.size, 0, "创建核心确认后清理直接选择（take-once 语义不受影响）")
  } finally {
    if (typeof dispose === "function") dispose()
  }
})
