import assert from "node:assert/strict"
import test from "node:test"
import { createDirectedSubagent, coldSessionReceived } from "../dsh/subagent-session.js"

const parent = { id: "parent-example" }
const input = { description: "成员", prompt: "完整派单", sessionId: "child-example", target: { provider: "provider-example", model: "model-example" }, exec: { agent: parent } }
function host() {
  const live = new Map()
  const starts = []
  const sends = []
  const ctx = {
    sessions: { get: (id) => live.get(id), flush: async () => true },
    sessionPersistence: { stat: async () => undefined },
    llm: { resolveCallConfig: async (config) => ({ ...config }) },
    subagents: {
      getProvider: () => ({ prepareContinuable() {} }),
      resolveMaxDepth: () => 2,
      startContinuable: async (spec) => { starts.push(spec); live.set(spec.childId, { header: { parentSession: parent.id } }); return { childId: spec.childId, messageId: "message-example" } },
      sendMessage: async (...args) => { sends.push(args); return "followup-example" },
    },
  }
  return { ctx, live, starts, sends }
}

test("读取持久化失败不能作为不存在创建成员", async () => {
  const h = host()
  h.ctx.sessionPersistence.stat = async () => { throw new Error("读取失败") }
  const result = await createDirectedSubagent(h.ctx, {}, input)
  assert.equal(result.ok, false)
  assert.equal(result.code, "TW_SUB_SESSION_UNKNOWN")
  assert.equal(result.sessionId, "child-example")
  assert.equal(h.starts.length, 0)
})

test("新成员采用精确模型与宿主深度，允许宿主填充未指定 effort", async () => {
  const h = host()
  h.ctx.llm.resolveCallConfig = async (config) => ({ ...config, reasoningEffort: "medium" })
  const result = await createDirectedSubagent(h.ctx, {}, input)
  assert.equal(result.ok, true)
  assert.equal(h.starts[0].request.maxDepth, 2)
  assert.deepEqual(h.starts[0].request.agentOptions, { provider: "provider-example", model: "model-example", reasoningEffort: "medium" })
  assert.deepEqual(h.starts[0].request.prompt, [{ type: "text", text: input.prompt }])
})

test("新版创建优先 startActivation 并指定父级投递，保留会话与消息回执", async () => {
  const h = host()
  h.ctx.subagents.startActivation = async (spec) => {
    assert.equal(spec.delivery, "parent")
    h.starts.push(spec)
    h.live.set(spec.childId, { header: { parentSession: parent.id } })
    return { childId: spec.childId, messageId: "activation-message", result: Promise.resolve({}), dispose() { assert.fail("插件不接管生命周期") } }
  }
  h.ctx.subagents.startContinuable = async () => assert.fail("新版不得走旧入口")
  const result = await createDirectedSubagent(h.ctx, {}, input)
  assert.equal(result.ok, true)
  assert.equal(result.messageId, "activation-message")
  assert.equal(h.starts[0].childId, input.sessionId)
  assert.deepEqual(h.starts[0].request.prompt.map(({ text }) => text), [input.prompt])
})

test("新版创建拒绝不降级重试旧入口，避免重复创建", async () => {
  const h = host()
  h.ctx.subagents.startActivation = async () => { throw new Error("新版拒绝") }
  h.ctx.subagents.startContinuable = async () => assert.fail("拒绝后不得降级重试")
  const result = await createDirectedSubagent(h.ctx, {}, input)
  assert.equal(result.code, "TW_SUB_START_FAILED")
  assert.equal(result.sessionId, input.sessionId)
})

test("已接收但 flush=false 保留会话 ID，绝不回收已运行成员", async () => {
  const h = host()
  h.ctx.sessions.flush = async () => false
  h.ctx.subagents.drainContinuableChildren = async () => { assert.fail("不能回收") }
  const result = await createDirectedSubagent(h.ctx, {}, input)
  assert.equal(result.ok, false)
  assert.equal(result.code, "TW_SUB_NOT_PERSISTED")
  assert.equal(result.sessionId, "child-example")
  assert.equal(result.accepted, true)
  assert.equal(h.live.has("child-example"), true)
})

test("冷续派忽略继承事件，并在只读读取后关闭 handle", async () => {
  const h = host()
  let closed = 0
  h.ctx.sessionPersistence.stat = async () => ({ header: { id: input.sessionId, parentSession: parent.id }, revision: "revision-example" })
  h.ctx.sessionPersistence.open = async (id, access) => {
    assert.equal(id, "child-example"); assert.equal(access, "read")
    return { inheritedEventCount: 1, read: async () => ({ events: [{ type: "agent/inbox/spliced", data: { inserted: [{ id: "inherited-message", content: [{ type: "text", text: "增量" }] }] } }, { type: "subagent/descriptor", data: {} }] }), close: async () => { closed++ } }
  }
  const result = await createDirectedSubagent(h.ctx, {}, { ...input, prompt: "增量", promptFull: "全量" })
  assert.equal(result.ok, true)
  assert.equal(result.resume, "full")
  assert.deepEqual(h.sends[0][2], [{ type: "text", text: "全量" }])
  assert.equal(closed, 1)
  assert.equal(h.starts.length, 0)
})

test("冷会话读取异常仍关闭 handle，绝不补投或重建", async () => {
  const h = host()
  let closed = 0
  h.ctx.sessionPersistence.stat = async () => ({ header: { id: input.sessionId, parentSession: parent.id } })
  h.ctx.sessionPersistence.open = async () => ({ inheritedEventCount: 0, read: async () => { throw new Error("读取失败") }, close: async () => { closed++ } })
  const result = await createDirectedSubagent(h.ctx, {}, input)
  assert.equal(result.code, "TW_SUB_SESSION_UNKNOWN")
  assert.equal(closed, 1)
  assert.equal(h.sends.length, 0)
  assert.equal(h.starts.length, 0)
})

test("快速结束与 flush 抛错均回执已接收 ID；重试对账活会话不重投", async () => {
  for (const mode of ["ended", "flush-error"]) {
    const h = host()
    const start = h.ctx.subagents.startContinuable
    if (mode === "ended") h.ctx.subagents.startContinuable = async (spec) => { const result = await start(spec); h.live.delete(spec.childId); return result }
    else h.ctx.sessions.flush = async () => { throw new Error("确认失败") }
    const result = await createDirectedSubagent(h.ctx, {}, input)
    assert.equal(result.accepted, true)
    assert.equal(result.sessionId, input.sessionId)
    assert.equal(result.persistenceConfirmed, false)
    assert.equal(result.code, mode === "ended" ? "TW_SUB_SESSION_MISSING" : "TW_SUB_FLUSH_FAILED")
    if (mode === "flush-error") {
      const retry = await createDirectedSubagent(h.ctx, {}, input)
      assert.equal(retry.reused, true)
      assert.equal(h.starts.length, 1)
      assert.equal(h.sends.length, 0)
    }
  }
})

test("取消与读取缺失都保留同 ID；取消信号传给 stat/open/read/start", async () => {
  const controller = new AbortController()
  controller.abort()
  for (const mode of ["stat", "open", "read", "close", "start"]) {
    const h = host()
    let closed = 0
    const fail = (signal) => { assert.equal(signal, controller.signal); throw new Error("取消或读取失败") }
    h.ctx.sessionPersistence.stat = async (_id, options) => {
      assert.equal(options.signal, controller.signal)
      if (mode === "stat") fail(options.signal)
      return mode === "start" ? undefined : { header: { id: input.sessionId, parentSession: parent.id } }
    }
    h.ctx.sessionPersistence.open = async (_id, access, options) => {
      assert.equal(access, "read"); assert.equal(options.signal, controller.signal)
      if (mode === "open") fail(options.signal)
      return { inheritedEventCount: 0, read: async (_offset, _length, options) => { if (mode === "read") fail(options.signal); return { events: [] } }, close: async () => { closed++; if (mode === "close") throw new Error("关闭失败") } }
    }
    h.ctx.subagents.startContinuable = async (spec) => fail(spec.signal)
    const result = await createDirectedSubagent(h.ctx, {}, { ...input, exec: { agent: parent, signal: controller.signal } })
    assert.equal(result.ok, false)
    assert.equal(result.sessionId, input.sessionId)
    assert.equal(result.code, mode === "start" ? "TW_SUB_START_FAILED" : "TW_SUB_SESSION_UNKNOWN")
    assert.equal(h.sends.length, 0)
    assert.equal(closed, ["read", "close"].includes(mode) ? 1 : 0)
  }
})

test("同派单冷重试已含本轮正文时只发送轻量续行提醒", async () => {
  const h = host()
  h.ctx.sessionPersistence.stat = async () => ({ header: { id: input.sessionId, parentSession: parent.id } })
  h.ctx.sessionPersistence.open = async () => ({ inheritedEventCount: 0, read: async () => ({ events: [{ type: "agent/inbox/spliced", data: { inserted: [{ id: "message-example", content: [{ type: "text", text: input.prompt }, { type: "text", text: "宿主追加引导" }] }] } }] }), close: async () => {} })
  const result = await createDirectedSubagent(h.ctx, {}, input)
  assert.equal(result.resume, "reminder")
  assert.equal(h.sends[0][2].length, 1)
  assert.notEqual(h.sends[0][2][0].text, input.prompt)
  assert.match(h.sends[0][2][0].text, /已收到本轮派单正文/)
  assert.equal(h.starts.length, 0)
})

test("仅上一轮上下文的冷会话发送本轮增量，不误选轻提示", async () => {
  const h = host()
  h.ctx.sessionPersistence.stat = async () => ({ header: { id: input.sessionId, parentSession: parent.id } })
  h.ctx.sessionPersistence.open = async () => ({ inheritedEventCount: 0, read: async () => ({ events: [{ type: "agent/inbox/spliced", data: { inserted: [{ id: "old-message", content: [{ type: "text", text: "上一轮派单" }] }] } }] }), close: async () => {} })
  const result = await createDirectedSubagent(h.ctx, {}, { ...input, prompt: "本轮增量", promptFull: "本轮全量" })
  assert.equal(result.resume, "incremental")
  assert.deepEqual(h.sends[0][2], [{ type: "text", text: "本轮增量" }])
})

test("成员消息单块：历史双块日志仍判本轮收单，规则字段被忽略且不再注入诊断句", async () => {
  const h = host()
  const events = [{ type: "agent/inbox/spliced", data: { inserted: [{ content: [{ type: "text", text: input.prompt }, { type: "text", text: "旧规则" }] }] } }]
  h.ctx.sessionPersistence.stat = async () => ({ header: { id: input.sessionId, parentSession: parent.id } })
  h.ctx.sessionPersistence.open = async () => ({ inheritedEventCount: 0, read: async () => ({ events }), close: async () => {} })
  assert.deepEqual(await coldSessionReceived(h.ctx.sessionPersistence, input.sessionId, undefined, [input.prompt]), { ok: true, received: true, currentReceived: true })
  const resumed = await createDirectedSubagent(h.ctx, {}, input)
  assert.equal(resumed.resume, "reminder")
  assert.equal(h.sends[0][2].length, 1)
  assert.match(h.sends[0][2][0].text, /已收到本轮派单正文/)
  const fresh = host()
  const compatible = await createDirectedSubagent(fresh.ctx, {}, { ...input, requiredGuidance: "旧投影里的规则" })
  assert.equal(compatible.ok, true)
  assert.deepEqual(fresh.starts[0].request.prompt, [{ type: "text", text: input.prompt }], "多余规则字段被忽略，不再注入诊断句")
  const live = await createDirectedSubagent(fresh.ctx, {}, { ...input, requiredGuidance: "再更新" })
  assert.equal(live.reused, true)
  assert.equal(fresh.starts.length, 1)
  assert.equal(fresh.sends.length, 0)
})

test("日志中无法解释的消息内容拒绝续投，仍释放 handle", async () => {
  const h = host()
  let closed = 0
  h.ctx.sessionPersistence.stat = async () => ({ header: { id: input.sessionId, parentSession: parent.id } })
  h.ctx.sessionPersistence.open = async () => ({ inheritedEventCount: 0, read: async () => ({ events: [{ type: "agent/inbox/spliced", data: { inserted: [{ id: "broken-message", content: [null] }] } }] }), close: async () => { closed++ } })
  const result = await createDirectedSubagent(h.ctx, {}, input)
  assert.equal(result.code, "TW_SUB_SESSION_UNKNOWN")
  assert.equal(h.sends.length, 0)
  assert.equal(closed, 1)
})

test("toHostTarget：ModelRef → 宿主 target 的唯一映射（缺 effort 不传字段，禁止空串/none）", async () => {
  const { toHostTarget } = await import("../dsh/subagent-session.js")
  assert.deepEqual(toHostTarget({ provider: "vendor-a", modelName: "model-a" }), { provider: "vendor-a", model: "model-a" })
  assert.deepEqual(toHostTarget({ provider: "vendor-a", modelName: "model-a", effort: "high" }), { provider: "vendor-a", model: "model-a", reasoningEffort: "high" })
  assert.equal(Object.hasOwn(toHostTarget({ provider: "vendor-a", modelName: "model-a" }), "reasoningEffort"), false, "effort 缺省 = 省略字段")
  for (const effort of ["", "   ", "none"]) {
    assert.throws(() => toHostTarget({ provider: "vendor-a", modelName: "model-a", effort }), /effort/, "effort=" + JSON.stringify(effort) + " 必须被防御性拒绝")
  }
  assert.throws(() => toHostTarget({ provider: "", modelName: "model-a" }), /provider/)
  assert.throws(() => toHostTarget({ provider: "vendor-a" }), /modelName/)
  assert.throws(() => toHostTarget(null), /ModelRef/)
})

test("createDirectedSubagent 收 modelRef：省略 effort 时不传 reasoningEffort，startActivation 同时带 request 与顶层参数（0.2.1/0.2.2 双兼容）", async () => {
  const h = host()
  h.ctx.subagents.startActivation = async (spec) => { h.starts.push(spec); h.live.set(spec.childId, { header: { parentSession: parent.id } }); return { childId: spec.childId, messageId: "activation-message" } }
  const seen = []
  h.ctx.llm.resolveCallConfig = async (config) => { seen.push(config); return { ...config } }
  const result = await createDirectedSubagent(h.ctx, {}, {
    description: "成员",
    prompt: "完整派单",
    sessionId: "child-modelref",
    modelRef: { provider: "provider-example", modelName: "model-example", family: "model" },
    exec: { agent: parent },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(seen[0], { provider: "provider-example", model: "model-example" }, "没有 effort 就不要在宿主调用里出现 reasoningEffort 键")
  const spec = h.starts[0]
  assert.deepEqual(spec.request.agentOptions, { provider: "provider-example", model: "model-example" })
  assert.equal(Object.hasOwn(spec.request.agentOptions, "reasoningEffort"), false)
  // 0.2.2-rc.2 顶层参数签名：与 request 内字段同源，两个入口都可读。
  assert.deepEqual(spec.parent, spec.request.parent)
  assert.deepEqual(spec.prompt, spec.request.prompt)
  assert.deepEqual(spec.agentOptions, spec.request.agentOptions)
  assert.equal(spec.maxDepth, spec.request.maxDepth)
  assert.equal(result.effort, undefined, "返回值不发明 effort")
})

test("createDirectedSubagent 拒绝无效 modelRef（effort 空串/none、缺字段），不进入创建", async () => {
  for (const modelRef of [
    { provider: "p", modelName: "m", effort: "" },
    { provider: "p", modelName: "m", effort: "none" },
    { provider: "p" },
  ]) {
    const h = host()
    const result = await createDirectedSubagent(h.ctx, {}, { description: "成员", prompt: "派单", sessionId: "child-invalid", modelRef, exec: { agent: parent } })
    assert.equal(result.ok, false)
    assert.equal(result.code, "TW_SUB_MODEL_REF_INVALID")
    assert.equal(h.starts.length, 0, "无效 modelRef 不创建成员")
  }
})
