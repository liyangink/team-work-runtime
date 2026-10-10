import assert from "node:assert/strict"
import test from "node:test"
import { createDirectedSubagent } from "../dsh/subagent-session.js"

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
  assert.equal(h.sends[0][2][0].text, "全量")
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
  assert.equal(h.sends[0][2][0].text, "本轮增量")
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
