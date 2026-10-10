import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import z from "@deepseek-ai/schemastery"

import {
  TOOL_NAME,
  STAGE_ABBREV,
  buildDispatchLabel,
  deterministicSessionId,
  roleAbbrev,
  twDispatchDefinition,
  twDispatchToolDescription,
} from "../dsh/tw-dispatch.js"
import { Config, readDshConfigSnapshot, decisionTableText, systemPromptSection } from "../dsh/settings.js"
import { twToolDefinition } from "../dsh/tw-tool.js"
import * as hostPlugin from "../dsh/index.js"

const EXEC = { agent: { id: "parent-agent-1", session: { header: { cwd: "/proj" } } } }

test("插件 Config 根 object，空配置启动，热读取保留原始三档形状及 profile", () => {
  assert.equal(Config.type, "object")
  assert.equal(Config.dict.tiers.meta.volatile, true)
  assert.deepEqual(Config({}).tiers.get(), {})
  let value = { junior: { provider: "provider-example", model: "model-a" }, senior: [{ provider: "provider-example", model: "model-b" }], expert: { provider: "provider-example", model: "model-c", effort: "high" } }
  const config = { tiers: { get: () => value } }
  const ctx = { get: (name) => name === "profileContext" ? { name: "profile-example" } : undefined }
  const first = readDshConfigSnapshot(ctx, config)
  value.junior.model = "model-updated"
  assert.equal(first.tiers.junior.model, "model-a")
  assert.equal(readDshConfigSnapshot(ctx, config).tiers.junior.model, "model-updated")
  assert.equal(first.entryId, "team-work-dsh")
  assert.equal(first.profile, "profile-example")
  assert.equal(readDshConfigSnapshot({}, {}).profile, "unresolved")
  assert.throws(() => Config({ tiers: { junior: value.junior } }))
  assert.throws(() => Config({ tiers: { ...value, expert: { provider: " ", model: "model-example" } } }))
})

test("配置表单经宿主去 volatile 后二次 JSON 序列化可在客户端校验", () => {
  const form = new z(Config.toJSON())
  const walk = (node) => { delete node.meta.volatile; for (const child of Object.values(node.dict ?? {})) walk(child); if (node.inner) walk(node.inner); for (const child of node.list ?? []) walk(child) }
  walk(form)
  const client = new z(JSON.parse(JSON.stringify(form.toJSON())))
  const complete = { junior: { provider: "provider-example", model: "model-a" }, senior: [{ provider: "provider-example", model: "model-b" }], expert: { provider: "provider-example", model: "model-c", effort: "high" } }
  assert.deepEqual(client({ tiers: {} }), { tiers: {} })
  assert.deepEqual(client({ tiers: complete }), { tiers: complete })
  for (const invalid of [{ junior: complete.junior }, { ...complete, other: complete.junior }, { ...complete, junior: { ...complete.junior, other: "value" } }, { ...complete, expert: [] }]) assert.throws(() => client({ tiers: invalid }))
})

test("tw 与 dispatch 调用只取一次快照，各子进程参数共用该快照且不改进程环境", async () => {
  const h = makeCtx()
  const original = process.env.TW_DSH_CONFIG
  let reads = 0
  const snapshot = { tiers: {}, entryId: "team-work-dsh", profile: "profile-example" }
  const configSnapshot = () => { reads++; return snapshot }
  const cards = []
  const dispatch = twDispatchDefinition(h.ctx, { configSnapshot, runTw: async (args, cwd, config) => { cards.push(config); return args[0] === "dispatch-plan" ? planCard([ownerWave()]) : { ok: true } } })
  await dispatch.execute({ task: "demo-t" }, EXEC)
  assert.equal(reads, 1)
  assert.equal(cards.length, 2)
  assert.equal(cards[0], cards[1])
  const tw = twToolDefinition({ configSnapshot, runTw: async (_executable, _args, _cwd, config) => { assert.equal(config, snapshot); return { ok: true } } })
  await tw.execute({ args: ["models"] }, EXEC)
  assert.equal(reads, 2)
  assert.equal(process.env.TW_DSH_CONFIG, original)
})

test("冷续派发送前登记新 key，登记失败不发正文", async () => {
  const wave = ownerWave({ dispatchKey: "d5-continuation", continuation: true, expectedAgentId: "prior-example" })
  const h = makeCtx()
  h.injectCold("prior-example", { received: "上一轮正文" })
  const { runTw, calls } = makeRunTw(planCard([wave]), { failCommands: { "agent-map": { ok: false, message: "登记失败" } } })
  const tool = twDispatchDefinition(h.ctx, { runTw })
  const result = await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(result.dispatched[0].code, "TW_DISPATCH_REGISTER_FAILED")
  assert.equal(h.followups.length, 0)
  assert.deepEqual(calls[1].args, ["agent-map", "--task", "demo-t", "--key", "d5-continuation", "--agent", "prior-example"])
})

test("真实 tw 子进程收到宿主调用快照，不读取旧配置", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tw-config-test-"))
  const tiers = { junior: { provider: "provider-example", model: "model-junior" }, senior: { provider: "provider-example", model: "model-senior" }, expert: { provider: "provider-example", model: "model-expert" } }
  const tool = twToolDefinition({ configSnapshot: () => ({ tiers, entryId: "team-work-dsh", profile: "profile-example" }) })
  const result = await tool.execute({ args: ["models"] }, { agent: { session: { header: { cwd: root } } } })
  assert.equal(result.ok, true)
  assert.equal(result.source, "dsh-plugin-config")
  assert.equal(result.profile, "profile-example")
  assert.equal(result.entryId, "team-work-dsh")
  assert.equal(result.tiers.find((tier) => tier.tier === "junior").model, "model-junior")
})

test("registered 在途冷重试已含同轮正文，仅续行提示", async () => {
  const item = { ...ownerWave(), registered: true, mappedAgentId: "prior-example" }
  const { runTw } = makeRunTw({ ok: true, task: "demo-t", stage: "implementation", stop: "wait-inflight", inflight: [item] })
  const h = makeCtx()
  h.injectCold("prior-example", { received: item.prompt })
  const result = await twDispatchDefinition(h.ctx, { runTw }).execute({ task: "demo-t" }, EXEC)
  assert.equal(result.inflight[0].resume, "reminder")
  assert.match(h.followups[0].text, /已收到本轮派单正文/)
})

test("预登记新 key 但本轮正文未送达时，旧上下文不能误选轻提示", async () => {
  const item = { ...ownerWave({ dispatchKey: "d5-next-round", continuation: true, prompt: "本轮增量正文", promptFull: "本轮全量正文" }), registered: true, mappedAgentId: "prior-example" }
  const { runTw, calls } = makeRunTw({ ok: true, task: "demo-t", stage: "implementation", stop: "wait-inflight", inflight: [item] })
  const h = makeCtx()
  h.injectCold("prior-example", { received: "上一轮派单正文" })
  const result = await twDispatchDefinition(h.ctx, { runTw }).execute({ task: "demo-t" }, EXEC)
  assert.equal(result.inflight[0].resume, "incremental")
  assert.equal(h.followups[0].text, "本轮增量正文")
  assert.equal(calls.filter((call) => call.cmd === "agent-map").length, 0)
})

test("新 continuation 冷会话已收本轮全量时，先登记同父映射再轻量续行", async () => {
  const wave = ownerWave({ dispatchKey: "d5-next-round", continuation: true, expectedAgentId: "prior-example", prompt: "本轮增量正文", promptFull: "本轮全量正文" })
  const { runTw, calls } = makeRunTw(planCard([wave]))
  const h = makeCtx()
  h.injectCold("prior-example", { received: wave.promptFull })
  const result = await twDispatchDefinition(h.ctx, { runTw }).execute({ task: "demo-t" }, EXEC)
  assert.equal(result.dispatched[0].resume, "reminder")
  assert.match(h.followups[0].text, /已收到本轮派单正文/)
  assert.deepEqual(calls[1].args, ["agent-map", "--task", "demo-t", "--key", "d5-next-round", "--agent", "prior-example"])
})

test("续派 unknown 保留具体存储错误原因，阻止登记与补投", async () => {
  const wave = ownerWave({ continuation: true, expectedAgentId: "prior-example" })
  const { runTw, calls } = makeRunTw(planCard([wave]))
  const h = makeCtx()
  h.ctx.sessionPersistence.stat = async () => { throw new Error("存储读取失败：EACCES") }
  const result = await twDispatchDefinition(h.ctx, { runTw }).execute({ task: "demo-t" }, EXEC)
  const card = result.dispatched[0]
  assert.equal(card.code, "TW_SUB_SESSION_UNKNOWN")
  assert.equal(card.sessionId, "prior-example")
  assert.match(card.message, /存储读取失败：EACCES/)
  assert.equal(calls.filter((call) => call.cmd === "agent-map").length, 0)
  assert.equal(h.followups.length, 0)
  assert.equal(h.started.length, 0)
})

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

function makeRunTw(plan, { failCommands = {}, onCall } = {}) {
  const calls = []
  const runTw = async (args, cwd) => {
    calls.push({ cmd: args[0], args, cwd })
    if (onCall) onCall(args[0])
    const fail = typeof failCommands[args[0]] === "function" ? failCommands[args[0]](args) : failCommands[args[0]]
    if (fail) return fail
    if (args[0] === "dispatch-plan") return plan
    if (args[0] === "agent-map") return { ok: true, task: "demo-t", key: args[4], agent: args[6], note: "已登记派单映射" }
    throw new Error("unexpected command: " + args[0])
  }
  return { runTw, calls }
}

function makeCtx(overrides = {}) {
  const started = []
  const drained = []
  const followups = []
  const live = new Map() // 活会话（id → { id, header, events }）——sessions.get 的唯一事实源
  const store = new Map() // 已物化持久（id → { header, events }）——stat/只读 handle 的事实源
  let msgSeq = 0
  const headerOf = (id, parentSession) => ({ id, version: 3, createdAt: 0, parentSession, origin: "subagent" })
  const splice = (session, text) => {
    session.events.push({
      type: "agent/inbox/spliced",
      seq: session.events.length + 1,
      time: 0,
      data: { target: "next-turn", start: 0, inserted: [{ id: "msg-" + (++msgSeq), role: "user", content: [{ type: "text", text }] }] },
    })
  }
  const persist = (session) => {
    store.set(session.id, { header: { ...session.header }, inheritedEventCount: session.inheritedEventCount ?? 0, events: session.events.map((e) => ({ ...e, data: structuredClone(e.data) })) })
  }
  const unauthorized = () => Object.assign(new Error("belongs to another parent session"), { code: "UNAUTHORIZED" })
  const ctx = {
    llm: { resolveCallConfig: async (config) => ({ ...config }) },
    subagents: {
      resolveMaxDepth: () => 2,
      getProvider: () => ({ name: "spawn", prepareContinuable: async () => ({}) }),
      startContinuable: async (spec) => {
        const childId = spec.childId ?? "gen-" + (++msgSeq)
        if (live.has(childId) || (spec.childId !== undefined && store.has(childId))) {
          throw Object.assign(new Error('subagent "' + childId + '" already exists'), { code: "DUPLICATE_CHILD" })
        }
        started.push(spec)
        const session = { id: childId, header: headerOf(childId, spec.request.parent.id), events: [{ type: "subagent/descriptor", seq: 1, time: 0, data: { mode: "continuable" } }] }
        live.set(childId, session)
        splice(session, spec.request.prompt[0]?.text ?? "") // inbox 接受即同步进内存事件流
        persist(session) // 接受即落盘（契约 3）
        return { childId, messageId: "m-" + started.length }
      },
      sendMessage: async (parent, childId, content, options) => {
        let session = live.get(childId)
        if (!session) {
          const cold = store.get(childId)
          if (!cold) throw Object.assign(new Error('subagent "' + childId + '" is unavailable'), { code: "NOT_RESUMABLE" })
          if (cold.header.parentSession !== parent.id) throw unauthorized()
          session = { id: childId, header: { ...cold.header }, events: cold.events.map((e) => ({ ...e, data: structuredClone(e.data) })) } // 冷唤醒重建 Agent
          live.set(childId, session)
        } else if (session.header.parentSession !== parent.id) {
          throw unauthorized()
        }
        followups.push({ childId, text: content[0]?.text, options })
        splice(session, content[0]?.text ?? "")
        persist(session)
        return "msg-" + (++msgSeq)
      },
      drainContinuableChildren: async (_parent, ids) => {
        for (const id of ids) {
          drained.push(id)
          live.delete(id)
        }
      },
    },
    sessions:
      overrides.sessions ?? {
        get: (id) => live.get(id),
        flush: async () => true,
      },
    sessionPersistence:
      overrides.sessionPersistence ?? {
        supportsRawArtifacts: true,
        stat: async (id) => { const s = store.get(id); return s ? { header: { ...s.header }, revision: "revision-example" } : undefined },
        open: async (id, access) => {
          assert.equal(access, "read")
          const s = store.get(id)
          if (!s) throw Object.assign(new Error("not found"), { code: "NOT_RESUMABLE" })
          return { header: { ...s.header }, inheritedEventCount: s.inheritedEventCount, read: async () => ({ events: s.events.map((e) => ({ ...e, data: structuredClone(e.data) })) }), close: async () => {} }
        },
      },
    ...overrides,
  }
  return {
    ctx, started, drained, followups,
    injectLive(id, { received = null, parentSession = EXEC.agent.id, inheritedEventCount = 0, seedEvents = [] } = {}) {
      const session = { id, header: headerOf(id, parentSession), inheritedEventCount, events: [...seedEvents, { type: "subagent/descriptor", seq: seedEvents.length + 1, time: 0, data: { mode: "continuable" } }] }
      if (received != null) splice(session, received)
      live.set(id, session)
      return session
    },
    injectCold(id, { received = null, parentSession = EXEC.agent.id, materialized = true, inheritedEventCount = 0, seedEvents = [] } = {}) {
      const session = { id, header: headerOf(id, parentSession), inheritedEventCount, events: [...seedEvents, { type: "subagent/descriptor", seq: seedEvents.length + 1, time: 0, data: { mode: "continuable" } }] }
      if (received != null) splice(session, received)
      if (materialized) persist(session)
      return session
    },
    liveIds: () => [...live.keys()],
    storeIds: () => [...store.keys()],
  }
}

function makeTool(deps = {}, ctxOverrides = {}) {
  const made = makeCtx(ctxOverrides)
  const tool = twDispatchDefinition(made.ctx, deps)
  return { tool, ...made }
}

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

test("透传：awaiting-user / completed / blocked / archived 卡原样返回，不创建子代理（wait-inflight 不再透传——§7.3 兜底，见下方三分支矩阵）", async () => {
  const awaiting = { ok: true, task: "demo-t", stage: "finish", stop: "awaiting-user", waves: [], card: { ok: true, status: "awaiting-user", question: "?", choices: ["accept", "rework"] } }
  const completed = { ok: true, task: "demo-t", stage: "finish", stop: "completed", waves: [], card: { ok: true, status: "completed", next: "archive" } }
  const blocked = { ok: true, task: "demo-t", stage: null, stop: "blocked", waves: [], card: { ok: false, blockers: [{ code: "X", recovery: "r" }] } }
  const archived = { ok: true, task: "demo-t", stage: null, stop: "archived", waves: [], card: { archived: true } }
  for (const card of [awaiting, completed, blocked, archived]) {
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

test("三步集成：真实创建核心 + agent-map 登记；先登记后创建，确定性 sessionId；标签/注入选择/登记参数全部对齐", async () => {
  const plan = planCard([ownerWave()])
  const { runTw, calls } = makeRunTw(plan)
  const { tool, started } = makeTool({ runTw })
  const out = await tool.execute({ task: "demo-t", note: "接口改造", writables: [{ path: "src/", kind: "source" }] }, EXEC)

  assert.deepEqual(calls[0].args, ["dispatch-plan", "--task", "demo-t", "--json", "--writable", "src/:source"])
  assert.equal(calls[0].cwd, "/proj")
  const fixedId = deterministicSessionId("demo-t", "d1-abc123")
  assert.deepEqual(calls[1].args, ["agent-map", "--task", "demo-t", "--key", "d1-abc123", "--agent", fixedId])
  assert.equal(started.length, 1)
  const spec = started[0]
  assert.equal(spec.childId, fixedId, "确定性 sessionId：同 key 重试推导同一 id（防双发基石）")
  assert.equal(spec.label, "IMPL·owner · 接口改造 #demo-t", "标签按派单事实 + note 自动拼接")
  assert.equal(spec.request.prompt[0].text, "派单全文 PROMPT", "prompt 原样转发")
  assert.deepEqual(spec.request.agentOptions, { provider: "p-a", model: "m-j1" }, "target 直取 modelHint（effort 走直接选择）")

  assert.deepEqual(out, {
    ok: true,
    task: "demo-t",
    stage: "implementation",
    dispatched: [{
      ok: true,
      key: "d1-abc123",
      label: "IMPL·owner · 接口改造 #demo-t",
      sessionId: fixedId,
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
  assert.deepEqual(started[0].request.agentOptions, { provider: "p-c", model: "m-e1", reasoningEffort: "high" })
})

test("writables 省略时 dispatch-plan 不带 --writable 参数", async () => {
  const { runTw, calls } = makeRunTw(planCard([ownerWave()]))
  const { tool } = makeTool({ runTw })
  await tool.execute({ task: "demo-t" }, EXEC)
  assert.deepEqual(calls[0].args, ["dispatch-plan", "--task", "demo-t", "--json"])
})

test("多包波：两张派单逐张串行「登记→创建」（先登记后创建），结果逐项返回", async () => {
  const wave1 = ownerWave({ dispatchKey: "d1-p1", package: "store" })
  const wave2 = ownerWave({ dispatchKey: "d2-p2", waveId: "wv1", package: "intake", modelHint: { provider: "p-b", model: "m-j2", source: "global-settings" } })
  const order = []
  const { runTw, calls } = makeRunTw(planCard([wave1, wave2]), {
    onCall: (cmd) => order.push("cli:" + cmd + ":" + (cmd === "agent-map" ? "" : "")),
  })
  const { tool, ctx, started } = makeTool({ runTw })
  const origStart = ctx.subagents.startContinuable
  ctx.subagents.startContinuable = async (spec) => {
    order.push("create:" + spec.childId)
    return origStart(spec)
  }
  const origRunTw = ctx // 占位：order 记录 agent-map key 需要在 makeRunTw onCall 中拿到 args，见下方 calls 断言
  void origRunTw
  const out = await tool.execute({ task: "demo-t" }, EXEC)

  assert.equal(out.dispatched.length, 2)
  assert.ok(out.dispatched.every((d) => d.ok && d.registered))
  assert.deepEqual(
    order,
    [
      "cli:dispatch-plan:",
      "cli:agent-map:",
      "create:" + deterministicSessionId("demo-t", "d1-p1"),
      "cli:agent-map:",
      "create:" + deterministicSessionId("demo-t", "d2-p2"),
    ],
    "逐张串行：登记 1 → 创建 1 → 登记 2 → 创建 2（§8 先登记后创建）"
  )
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 2)
  assert.deepEqual(out.dispatched.map((d) => d.sessionId), [deterministicSessionId("demo-t", "d1-p1"), deterministicSessionId("demo-t", "d2-p2")])
  assert.deepEqual(out.dispatched.map((d) => d.sessionId), started.map((s) => s.childId))
})

test("登记失败：尚未创建子会话（先登记后创建），原样重试安全不双发；成功项不回滚", async () => {
  const plan = planCard([ownerWave({ dispatchKey: "d1-ok" }), ownerWave({ dispatchKey: "d2-mapfail", package: "api" })])
  const { runTw } = makeRunTw(plan, {
    failCommands: {
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
  assert.equal(bad.sessionId, undefined, "未创建子会话")
  assert.equal(started.length, 1, "仅成功那张派单创建了子会话")
  assert.equal(drained.length, 0, "登记失败不触发回收语义")
  assert.match(bad.message, /尚未创建子会话（先登记后创建），原样重试安全、不会双发/)
  assert.match(bad.message, /tw retire --task demo-t --wave wv1/)
})

test("创建失败：模型验证失败不留子会话（映射已登记，确定性对账使重试幂等）；继续处理后续派单", async () => {
  const plan = planCard([ownerWave({ dispatchKey: "d1-bad", modelHint: { provider: "p-x", model: "gone", source: "global-settings" } }), ownerWave({ dispatchKey: "d2-next" })])
  const { ctx } = makeCtx()
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
  assert.match(out.dispatched[0].message, /重试先检查同 ID 会话/)
  assert.equal(out.dispatched[0].sessionId, deterministicSessionId("demo-t", "d1-bad"), "回执带确定性 sessionId（已登记未创建）")
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 2, "两张派单都先登记（§8：登记在验证之前）")
  assert.equal(out.dispatched[1].ok, true, "单张失败不阻断后续")
  assert.equal(out.failures, 1)
})

test("创建失败：startContinuable 抛错，保留映射与确定性 ID", async () => {
  const { ctx } = makeCtx({
    subagents: {
      resolveMaxDepth: () => 2,
      getProvider: () => ({ prepareContinuable: async () => ({}) }),
      startContinuable: async () => { throw new Error("host exploded") },
      drainContinuableChildren: async () => {},
    },
  })
  const { runTw, calls } = makeRunTw(planCard([ownerWave()]))
  const tool = twDispatchDefinition(ctx, { runTw })
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(out.dispatched[0].code, "TW_SUB_START_FAILED")
  assert.equal(out.dispatched[0].sessionId, deterministicSessionId("demo-t", "d1-abc123"))
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 1, "登记已发生（先登记后创建）")
  assert.match(out.dispatched[0].message, /重试先检查同 ID 会话/)
})

test("创建已接收：flush 未确认保留成员，重试先对账同 ID", async () => {
  const { ctx } = makeCtx()
  ctx.sessions.flush = async () => false
  const { runTw, calls } = makeRunTw(planCard([ownerWave()]))
  const tool = twDispatchDefinition(ctx, { runTw })
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(out.dispatched[0].code, "TW_SUB_NOT_PERSISTED")
  assert.match(out.dispatched[0].message, /初始消息已接收但持久化尚未确认/)
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 1, "登记已发生（先登记后创建）")
  assert.match(out.dispatched[0].message, /重试先检查同 ID 会话/)
})

test("continuation 且有 expectedAgentId（会话在场）：统一等待不重投（用户终裁②），登记本轮映射，不创建不重投", async () => {
  const wave = ownerWave({ dispatchKey: "d5-cont", waveId: "wv3", kind: "respond", round: 2, continuation: true, expectedAgentId: "child-uuid-7", prompt: "本轮增量派单正文" })
  const { runTw, calls } = makeRunTw(planCard([wave]))
  const { tool, started, followups, injectLive } = makeTool({ runTw })
  injectLive("child-uuid-7", { received: "上一轮派单正文" }) // 活会话（任务进行中）
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(started.length, 0, "续派不经创建")
  assert.equal(followups.length, 0, "活会话统一等待：重入恒等待永不重投（防成员重复执行整轮工作）")
  const item = out.dispatched[0]
  assert.equal(item.ok, true)
  assert.equal(item.continuation, true)
  assert.equal(item.expectedAgentId, "child-uuid-7")
  assert.equal(item.action, "wait")
  assert.equal(item.sessionId, "child-uuid-7")
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 1, "同父续派登记本轮 key→原会话")
  assert.match(item.message, /等待成员完成通知/)
  assert.match(item.message, /催单用 send_message/)

  const again = await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(again.dispatched[0].action, "wait")
  assert.equal(followups.length, 0)
})

test("continuation 在场（含空壳形态）：统一等待——活+未收单形态经宿主回滚不存在（用户终裁③）", async () => {
  const wave = ownerWave({ dispatchKey: "d5b-cont", waveId: "wv3", kind: "respond", round: 2, continuation: true, expectedAgentId: "shell-child", prompt: "本轮增量派单正文", promptFull: "全量变体：目标+约束+排除内嵌" })
  const { runTw } = makeRunTw(planCard([wave]))
  const { tool, started, followups, injectLive } = makeTool({ runTw })
  injectLive("shell-child", { received: null }) // 防御性形态：即使注入也统一等待
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(started.length, 0)
  assert.equal(followups.length, 0, "活会话不读事件流不投递（活壳补发分支已删除）")
  const item = out.dispatched[0]
  assert.equal(item.ok, true)
  assert.equal(item.action, "wait")
})

test("continuation 冷持久（归属一致）：判收单定增量或全量（用户终裁②冷唤醒语义）", async () => {
  const waveA = ownerWave({ dispatchKey: "d5c-cont", waveId: "wv3", kind: "respond", round: 2, continuation: true, expectedAgentId: "cold-prior-1", prompt: "本轮增量派单正文", promptFull: "全量变体：目标+约束+排除内嵌" })
  const ra = makeRunTw(planCard([waveA]))
  const ta = makeTool({ runTw: ra.runTw })
  ta.injectCold("cold-prior-1", { received: "上一轮派单正文" })
  const outA = await ta.tool.execute({ task: "demo-t" }, EXEC)
  const itemA = outA.dispatched[0]
  assert.equal(itemA.ok, true)
  assert.equal(itemA.action, "followup")
  assert.equal(itemA.resume, "incremental")
  assert.equal(ta.started.length, 0, "冷唤醒走 followup 不经创建")
  assert.equal(ta.followups.length, 1)
  assert.equal(ta.followups[0].text, "本轮增量派单正文", "曾收单=有原上下文：投增量变体")

  const waveB = ownerWave({ dispatchKey: "d5d-cont", waveId: "wv3", kind: "respond", round: 2, continuation: true, expectedAgentId: "cold-prior-2", prompt: "本轮增量派单正文", promptFull: "全量变体：目标+约束+排除内嵌" })
  const rb = makeRunTw(planCard([waveB]))
  const tb = makeTool({ runTw: rb.runTw })
  tb.injectCold("cold-prior-2", { received: null })
  const outB = await tb.tool.execute({ task: "demo-t" }, EXEC)
  const itemB = outB.dispatched[0]
  assert.equal(itemB.ok, true)
  assert.equal(itemB.action, "followup")
  assert.equal(itemB.resume, "full")
  assert.equal(tb.followups[0].text, "全量变体：目标+约束+排除内嵌", "从未收单无上下文：投全量变体")
})

test("continuation 活会话异主（接管冲突）：本工具不做接管，不等待不投递不重建", async () => {
  const wave = ownerWave({ dispatchKey: "d5e-cont", waveId: "wv3", kind: "respond", round: 2, continuation: true, expectedAgentId: "foreign-live", prompt: "本轮增量派单正文" })
  const { runTw, calls } = makeRunTw(planCard([wave]))
  const { tool, started, followups, injectLive } = makeTool({ runTw })
  injectLive("foreign-live", { received: "他人的派单", parentSession: "another-lead" }) // 活会话但异主
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  const item = out.dispatched[0]
  assert.equal(item.ok, false)
  assert.equal(item.code, "TW_SUB_TAKEOVER_CONFLICT")
  assert.match(item.message, /接管冲突/)
  assert.equal(started.length, 0, "不重建（同 id 重建判重必被宿主拒绝）")
  assert.equal(followups.length, 0, "不投递（活异主不是本 Lead 的任务进行中）")
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 0)
})

test("continuation 且 expectedAgentId 断链：自动 fresh 重建（登记回填 key 映射），不再给幽灵 send_message 指引", async () => {
  const wave = ownerWave({ dispatchKey: "d7-cont", waveId: "wv7", kind: "respond", round: 3, continuation: true, expectedAgentId: "ghost-child" })
  const { runTw, calls } = makeRunTw(planCard([wave]))
  const { tool, started } = makeTool({ runTw })
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  const item = out.dispatched[0]
  assert.equal(item.ok, true)
  assert.equal(item.freshRebuilt, true)
  assert.equal(item.action, "fresh_rebuilt")
  assert.equal(item.priorAgentId, "ghost-child")
  assert.equal(item.sessionId, deterministicSessionId("demo-t", "d7-cont"))
  assert.equal(started.length, 1)
  assert.deepEqual(calls[1].args, ["agent-map", "--task", "demo-t", "--key", "d7-cont", "--agent", deterministicSessionId("demo-t", "d7-cont")])
  assert.match(item.message, /断链/)
})

test("continuation 但映射缺失（expectedAgentIdMissing）：走登记+创建路径（确定性 sessionId）", async () => {
  const wave = ownerWave({ dispatchKey: "d6-fresh", kind: "respond", round: 2, continuation: true, expectedAgentIdMissing: true })
  const { runTw, calls } = makeRunTw(planCard([wave]))
  const { tool, started } = makeTool({ runTw })
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(started.length, 1, "resumeNote 场景是创建路径")
  assert.equal(out.dispatched[0].ok, true)
  assert.equal(out.dispatched[0].registered, true)
  assert.equal(out.dispatched[0].sessionId, deterministicSessionId("demo-t", "d6-fresh"))
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 1)
  assert.deepEqual(calls[1].args, ["agent-map", "--task", "demo-t", "--key", "d6-fresh", "--agent", deterministicSessionId("demo-t", "d6-fresh")])
})

function inflightCard(items, extra = {}) {
  return { ok: true, task: "demo-t", stage: "implementation", stop: "wait-inflight", waves: [], dispatchKey: items[0]?.key ?? "d1-x", inflight: items, card: { status: "wait-inflight" }, ...extra }
}
function inflightItem(overrides = {}) {
  return { key: "d1-abc123", waveId: "wv1", role: "owner", tier: "junior", round: 1, kind: "produce", continuation: false, prompt: "原派单全文", modelHint: { provider: "p-a", model: "m-j1", source: "global-settings" }, registered: false, ...overrides }
}

test("兜底·降级透传：registered 缺失（agents.json 损坏）不补派，附人工核对与修复指引", async () => {
  const item = inflightItem({ registered: undefined, registeredUnresolved: "文件损坏（非 JSON）：agents.json" })
  const { runTw, calls } = makeRunTw(inflightCard([item]))
  const { tool, started } = makeTool({ runTw })
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(out.stop, "wait-inflight")
  assert.equal(started.length, 0, "判定事实不可得时不自动创建")
  const entry = out.inflight[0]
  assert.equal(entry.ok, true, "降级透传是成功形态（passthrough），不是失败")
  assert.equal(entry.passthrough, true)
  assert.equal(entry.code, "TW_DISPATCH_REGISTRY_CORRUPT")
  assert.match(entry.message, /agents.json/)
  assert.match(entry.message, /不自动补派/)
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 0)
})

test("兜底·降级透传：registered 字段整体缺失（旧卡降级），提示核对后重试", async () => {
  const item = inflightItem({ registered: undefined })
  delete item.registered
  const { runTw, calls } = makeRunTw(inflightCard([item]))
  const { tool, started } = makeTool({ runTw })
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(started.length, 0)
  assert.equal(out.inflight[0].code, "TW_DISPATCH_REGISTERED_UNKNOWN")
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 0)
})

test("兜底·优先级：registered=true 且会话在场 → 判定链等待，优先于续派分支", async () => {
  const item = inflightItem({ continuation: true, expectedAgentId: "child-old", registered: true, mappedAgentId: "mapped-child-1" })
  const { runTw } = makeRunTw(inflightCard([item]))
  const { tool, started, followups, injectLive } = makeTool({ runTw })
  injectLive("mapped-child-1", { received: "原派单正文" }) // 活会话（任务进行中）
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(started.length, 0, "已登记且会话在场不创建")
  assert.equal(followups.length, 0, "活会话统一等待不投递（判定链保证不重复投递）")
  const entry = out.inflight[0]
  assert.equal(entry.ok, true)
  assert.equal(entry.registered, true)
  assert.equal(entry.sessionId, "mapped-child-1")
  assert.equal(entry.action, "wait")
  assert.ok(!entry.expectedAgentId, "registered=true 时不走续派分支")
  assert.match(entry.message, /在场/)
  assert.match(entry.message, /等待成员完成通知/)
})

test("兜底·registered=true 但会话不存在（登记与创建间崩溃窗口）→ 同 id 重建，不双发", async () => {
  const item = inflightItem({ registered: true, mappedAgentId: "mapped-child-2" })
  const { runTw } = makeRunTw(inflightCard([item]))
  const { tool, started } = makeTool({ runTw })
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  const entry = out.inflight[0]
  assert.equal(entry.ok, true)
  assert.equal(entry.recovered, true)
  assert.equal(entry.action, "recreated")
  assert.equal(entry.sessionId, "mapped-child-2", "同 id 重建（判定链 none → 正常创建路径）")
  assert.equal(started.length, 1)
  assert.equal(started[0].childId, "mapped-child-2")
  assert.match(entry.message, /会话无记录/)
})

test("兜底·registered=true 且会话在场（含空壳形态）→ 统一等待，不补发不重建（用户终裁②③）", async () => {
  const item = inflightItem({ registered: true, mappedAgentId: "mapped-child-3" })
  const { runTw } = makeRunTw(inflightCard([item]))
  const { tool, started, drained, followups, injectLive } = makeTool({ runTw })
  injectLive("mapped-child-3", { received: null }) // 防御性形态：活壳（经宿主回滚实际不存在）
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  const entry = out.inflight[0]
  assert.equal(entry.ok, true)
  assert.equal(entry.action, "wait")
  assert.equal(entry.sessionId, "mapped-child-3")
  assert.deepEqual(drained, [], "废弃声明：empty→drain→同 id 重建路径已删除")
  assert.equal(started.length, 0, "活会话统一等待不创建")
  assert.equal(followups.length, 0, "活会话不读事件流不投递（活壳补发分支已删除）")
  assert.match(entry.message, /等待成员完成通知/)
})

test("兜底·registered=true 且会话为冷持久（归属一致、曾收单）→ 冷唤醒投本轮增量变体", async () => {
  const item = inflightItem({ registered: true, mappedAgentId: "mapped-cold-1" })
  const { runTw } = makeRunTw(inflightCard([item]))
  const { tool, started, followups, injectCold, liveIds } = makeTool({ runTw })
  injectCold("mapped-cold-1", { received: "原派单正文" }) // 冷持久归属一致且曾收单（有上一轮上下文）
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  const entry = out.inflight[0]
  assert.equal(entry.ok, true)
  assert.equal(entry.action, "followup")
  assert.equal(entry.resume, "incremental", "曾收单冷会话：投本轮增量变体（用户终裁②冷唤醒语义）")
  assert.equal(started.length, 0, "冷唤醒走 followup，不经创建")
  assert.equal(followups.length, 1)
  assert.equal(followups[0].text, "原派单全文", "冷会话不在执行（本轮派单必未投过）：投本轮正文")
  assert.deepEqual(liveIds(), ["mapped-cold-1"], "冷唤醒物化 Activation（会话转活）")
})

test("兜底·registered=true 且会话为冷持久（归属一致、从未收单）→ 冷唤醒投全量变体（无原上下文）", async () => {
  const item = inflightItem({ registered: true, mappedAgentId: "mapped-cold-2", continuation: true, promptFull: "续派全量变体：目标+约束+排除内嵌" })
  const { runTw } = makeRunTw(inflightCard([item]))
  const { tool, started, followups, injectCold } = makeTool({ runTw })
  injectCold("mapped-cold-2", { received: null }) // 冷持久归属一致但从未收单
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  const entry = out.inflight[0]
  assert.equal(entry.ok, true)
  assert.equal(entry.action, "followup")
  assert.equal(entry.resume, "full")
  assert.equal(followups[0].text, "续派全量变体：目标+约束+排除内嵌", "从未收单冷会话：投全量变体（增量不可执行）")
})

test("兜底·registered=true 且冷持久异主（接管冲突）→ 冲突卡指 retire/原会话继续，不 followup 不重建", async () => {
  const item = inflightItem({ registered: true, mappedAgentId: "mapped-foreign" })
  const { runTw, calls } = makeRunTw(inflightCard([item]))
  const { tool, started, followups, injectCold } = makeTool({ runTw })
  injectCold("mapped-foreign", { received: "原派单正文", parentSession: "another-lead" }) // 归属其他父会话
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  const entry = out.inflight[0]
  assert.equal(entry.ok, false)
  assert.equal(entry.code, "TW_SUB_TAKEOVER_CONFLICT")
  assert.match(entry.message, /接管冲突/)
  assert.match(entry.message, /tw retire --task demo-t --wave wv1/)
  assert.equal(started.length, 0, "接管冲突不重建（同 ID 重建必被宿主判重拒绝）")
  assert.equal(followups.length, 0, "接管冲突不 followup（冷唤醒鉴权必被拒绝）")
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 0)
})

test("兜底·registered=true 且为未物化崩溃壳（stat 无记录）→ 同 id 重建合法（宿主判重不认崩溃壳）", async () => {
  const item = inflightItem({ registered: true, mappedAgentId: "mapped-shell" })
  const { runTw } = makeRunTw(inflightCard([item]))
  const { tool, started, storeIds } = makeTool({ runTw })
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  const entry = out.inflight[0]
  assert.equal(entry.ok, true)
  assert.equal(entry.action, "recreated")
  assert.equal(entry.sessionId, "mapped-shell")
  assert.equal(started.length, 1)
  assert.ok(storeIds().includes("mapped-shell"), "创建后经持久化确认物化")
})

test("兜底·分支 2 二阶窗口（续派·无记录重建）：registered=true 且 continuation → 同 id 重建投全量变体", async () => {
  const item = inflightItem({
    registered: true, mappedAgentId: "mapped-rebuild-1",
    continuation: true, expectedAgentId: "prior-agent-gone",
    prompt: "续派增量派单正文", promptFull: "续派全量变体：目标+约束+排除内嵌",
  })
  const { runTw } = makeRunTw(inflightCard([item]))
  const { tool, started, followups } = makeTool({ runTw })
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  const entry = out.inflight[0]
  assert.equal(entry.ok, true)
  assert.equal(entry.action, "recreated", "判定链无记录 → 同 id 重建（分支 2 优先于续派分支 3，非 fresh_rebuilt）")
  assert.equal(entry.sessionId, "mapped-rebuild-1")
  assert.equal(started.length, 1)
  assert.equal(started[0].request.prompt[0].text, "续派全量变体：目标+约束+排除内嵌", "新会话无原上下文：重建投全量变体（§9.3 验收基线）")
  assert.equal(followups.length, 0)
})

test("兜底·分支 2 二阶窗口（续派·活壳形态）：registered=true 且 continuation → 统一等待（用户终裁③）", async () => {
  const item = inflightItem({
    registered: true, mappedAgentId: "mapped-shell-2",
    continuation: true, expectedAgentId: "prior-agent-gone",
    prompt: "续派增量派单正文", promptFull: "续派全量变体：目标+约束+排除内嵌",
  })
  const { runTw } = makeRunTw(inflightCard([item]))
  const { tool, started, followups, injectLive } = makeTool({ runTw })
  injectLive("mapped-shell-2", { received: null }) // 防御性形态：活壳（经宿主回滚实际不存在）
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  const entry = out.inflight[0]
  assert.equal(entry.ok, true)
  assert.equal(entry.action, "wait", "活会话统一等待（活壳补发分支已删除）")
  assert.equal(started.length, 0)
  assert.equal(followups.length, 0, "不读事件流不投递")
})

test("兜底·分支 2 二阶窗口（续派·活会话等待不受影响）：等待路径不投任何正文", async () => {
  const item = inflightItem({
    registered: true, mappedAgentId: "mapped-wait-2",
    continuation: true, expectedAgentId: "prior-agent-live",
    prompt: "续派增量派单正文", promptFull: "续派全量变体：目标+约束+排除内嵌",
  })
  const { runTw } = makeRunTw(inflightCard([item]))
  const { tool, started, followups, injectLive } = makeTool({ runTw })
  injectLive("mapped-wait-2", { received: "此前已收单" }) // 活会话：等待，不投正文
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  const entry = out.inflight[0]
  assert.equal(entry.ok, true)
  assert.equal(entry.action, "wait")
  assert.equal(started.length, 0)
  assert.equal(followups.length, 0, "活会话统一等待（全量/增量都不投，重入恒等待）")
})

test("兜底·续派：registered=false 且 expectedAgentId 在场 → 统一等待不重投，登记本轮映射，不创建不重投", async () => {
  const item = inflightItem({ continuation: true, expectedAgentId: "child-uuid-7", registered: false, prompt: "本轮增量派单正文" })
  const { runTw, calls } = makeRunTw(inflightCard([item]))
  const { tool, started, followups, injectLive } = makeTool({ runTw })
  injectLive("child-uuid-7", { received: "上一轮派单正文" })
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(started.length, 0)
  assert.equal(followups.length, 0, "活会话统一等待：永不重投（用户终裁②）")
  const entry = out.inflight[0]
  assert.equal(entry.action, "wait")
  assert.equal(entry.expectedAgentId, "child-uuid-7")
  assert.match(entry.message, /等待成员完成通知/)
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 1)
})

test("兜底·自动补派：registered=false 非续派 → 登记确定性 sessionId + 创建，结果标注补派并附 retire 提示", async () => {
  const item = inflightItem()
  const order = []
  const { runTw, calls } = makeRunTw(inflightCard([item]), { onCall: (cmd) => order.push(cmd) })
  const { tool, started } = makeTool({ runTw })
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(started.length, 1, "崩溃窗口的未登记派单自动补派")
  assert.equal(started[0].request?.prompt?.[0]?.text, "原派单全文", "补派转发原派单全文")
  const fixedId = deterministicSessionId("demo-t", "d1-abc123")
  assert.equal(started[0].childId, fixedId, "补派用确定性 sessionId")
  assert.deepEqual(order, ["dispatch-plan", "agent-map"], "先登记后创建：agent-map 在创建完成前调用（创建经创建核心同步完成）")
  const entry = out.inflight[0]
  assert.equal(entry.ok, true)
  assert.equal(entry.recovered, true)
  assert.equal(entry.registered, true)
  assert.equal(entry.sessionId, fixedId)
  assert.match(entry.message, /补派：此前已落盘无执行登记/)
  assert.match(entry.message, /不会双发/, "机器防双发声明（对账收敛，不靠人工核对）")
  assert.match(entry.message, /tw retire --task demo-t --wave wv1/, "retire 提示（判定权边界：要不要归 retire）")
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 1, "补派自动登记")
})

test("兜底·登记失败回执：登记失败发生在创建之前 → 未创建子会话，原样重试安全不双发", async () => {
  const item = inflightItem()
  const failMap = { ok: false, code: "USAGE", message: "key 不合法" }
  const { runTw } = makeRunTw(inflightCard([item]), { failCommands: { "agent-map": failMap } })
  const { tool, started } = makeTool({ runTw })
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(started.length, 0, "登记失败未创建（§8：先登记后创建）")
  const entry = out.inflight[0]
  assert.equal(entry.ok, false)
  assert.equal(entry.code, "TW_DISPATCH_REGISTER_FAILED")
  assert.equal(entry.sessionId, undefined, "无子会话残留")
  assert.match(entry.message, /尚未创建子会话（先登记后创建），原样重试安全、不会双发/)
  assert.equal(out.failures, 1)
})

test("兜底·modelHint 不可解析：无会话需重建但无 target → 不创建指 retire；登记先行（重试收敛锚）", async () => {
  const item = inflightItem({ modelHintUnresolved: true })
  delete item.modelHint
  const { runTw, calls } = makeRunTw(inflightCard([item]))
  const { tool, started, followups } = makeTool({ runTw })
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(started.length, 0, "无 target 不创建")
  assert.equal(followups.length, 0)
  const entry = out.inflight[0]
  assert.equal(entry.ok, false)
  assert.equal(entry.code, "TW_DISPATCH_MODEL_HINT_UNRESOLVED")
  assert.match(entry.message, /重建无 target/)
  assert.match(entry.message, /tw retire --task demo-t --wave wv1/)
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 1, "登记先行（确定性 id 已落账，修复配置后重试收敛）")
})

test("兜底·多条目逐条独立判定：等待/补派混排互不影响，各按自身事实处置", async () => {
  const waiting = inflightItem({ key: "d2-aaa", waveId: "wv2", registered: true, mappedAgentId: "mapped-wait-1" })
  const recover = inflightItem({ key: "d3-bbb", waveId: "wv3", modelHint: { provider: "p-b", model: "m-x", source: "global-settings" } })
  const { runTw, calls } = makeRunTw(inflightCard([waiting, recover]))
  const { tool, started, injectLive } = makeTool({ runTw })
  injectLive("mapped-wait-1", { received: "原派单正文" })
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(started.length, 1, "仅未登记条目补派")
  assert.equal(started[0].childId, deterministicSessionId("demo-t", "d3-bbb"))
  assert.equal(out.inflight[0].action, "wait")
  assert.equal(out.inflight[0].recovered, undefined)
  assert.equal(out.inflight[1].recovered, true)
  assert.equal(out.inflight[1].key, "d3-bbb")
  assert.equal(out.failures, undefined, "全部成功无 failures 计数")
  assert.match(out.note, /在途条目已逐条处置/)
})

test("兜底·续派断链：expectedAgentId 会话不存在 → 自动 fresh 重建（登记回填 key 映射），不再指向幽灵会话", async () => {
  const item = inflightItem({ key: "d4-cont", waveId: "wv4", kind: "respond", round: 2, continuation: true, expectedAgentId: "ghost-child", registered: false, modelHint: { provider: "p-a", model: "m-s1", source: "global-settings" } })
  const { runTw, calls } = makeRunTw(inflightCard([item]))
  const { tool, started } = makeTool({ runTw })
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  const entry = out.inflight[0]
  assert.equal(entry.ok, true)
  assert.equal(entry.freshRebuilt, true)
  assert.equal(entry.action, "fresh_rebuilt")
  assert.equal(entry.priorAgentId, "ghost-child")
  assert.equal(entry.sessionId, deterministicSessionId("demo-t", "d4-cont"), "fresh 重建落确定性 id（重试收敛）")
  assert.equal(started.length, 1)
  assert.deepEqual(calls[1].args, ["agent-map", "--task", "demo-t", "--key", "d4-cont", "--agent", deterministicSessionId("demo-t", "d4-cont")], "key 映射回填新 childId")
  assert.match(entry.message, /断链/)
  assert.match(entry.message, /fresh 重建/)
})

test("兜底·续派断链且 modelHint 不可解析：不重建指 retire；登记先行（修复配置后重试收敛）", async () => {
  const item = inflightItem({ key: "d5-cont", waveId: "wv5", kind: "respond", round: 2, continuation: true, expectedAgentId: "ghost-child", registered: false, modelHintUnresolved: true })
  delete item.modelHint
  const { runTw, calls } = makeRunTw(inflightCard([item]))
  const { tool, started, followups } = makeTool({ runTw })
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  const entry = out.inflight[0]
  assert.equal(entry.ok, false)
  assert.equal(entry.code, "TW_DISPATCH_MODEL_HINT_UNRESOLVED")
  assert.equal(entry.continuation, true)
  assert.match(entry.message, /重建无 target/)
  assert.match(entry.message, /tw retire --task demo-t --wave wv5/)
  assert.equal(started.length, 0)
  assert.equal(followups.length, 0)
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 1, "断链重建序列先登记（确定性 id）")
})

test("派单 prompt 缺失（runtime 投影缺陷）：拒绝登记与创建，零副作用，指 retire", async () => {
  const item = inflightItem({ prompt: "" })
  const { runTw, calls } = makeRunTw(inflightCard([item]))
  const { tool, started } = makeTool({ runTw })
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  const entry = out.inflight[0]
  assert.equal(entry.ok, false)
  assert.equal(entry.code, "TW_DISPATCH_PROMPT_MISSING")
  assert.match(entry.message, /未登记未创建/)
  assert.equal(started.length, 0)
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 0, "零副作用：登记也不做")
})

test("兜底·分支 2 同款 prompt 防御：registered=true 时 prompt 缺失 → 拒绝任何投递/重建，登记零写", async () => {
  const item = inflightItem({ registered: true, mappedAgentId: "mapped-child-9", prompt: "   " })
  const { runTw, calls } = makeRunTw(inflightCard([item]))
  const { tool, started, followups } = makeTool({ runTw })
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  const entry = out.inflight[0]
  assert.equal(entry.ok, false, "投递前置校验失败不是成功形态")
  assert.equal(entry.code, "TW_DISPATCH_PROMPT_MISSING")
  assert.match(entry.message, /未补发未创建/)
  assert.match(entry.message, /retire/)
  assert.equal(started.length, 0, "不静默置空串创建")
  assert.equal(followups.length, 0)
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 0, "已登记项零写：不重复登记不回写")
})

test("分工文案同源：普通委派走原生工具，正式成员走 tw-dispatch", () => {
  const table = decisionTableText()
  assert.match(table, /正式任务.*tw-dispatch/)
  assert.match(table, /成员内部只读助手：原生 subagent/)
  assert.match(table, /list_subagent_models.*精确查询/)

  assert.ok(twDispatchToolDescription().includes(table), "tw-dispatch 工具说明含同表")
  assert.ok(systemPromptSection({}, {}).text().includes(table), "systemPrompt section 含同表")

  const dispatchDef = twDispatchDefinition({}, {})
  assert.equal(dispatchDef.description, twDispatchToolDescription())
})

test("工具定义形态：名称/并发安全/参数面只收语义（key、modelHint、标签均不向模型索要）", () => {
  const def = twDispatchDefinition({}, {})
  assert.equal(def.name, TOOL_NAME)
  assert.equal(def.name, "tw-dispatch")
  assert.equal(typeof def.timeoutMs, "number")
  assert.equal(def.isConcurrencySafe(), false, "§7.3.3 并发保守：同任务连点排队串行，防补派双发")
  assert.deepEqual(Object.keys(def.parameters.properties), ["task", "note", "writables"])
  assert.deepEqual(def.parameters.required, ["task"])
})

test("index 装配只注册 tw 和 tw-dispatch，不装配旧注入", async () => {
  const registered = []
  const ctx = {
    logger: { warn() {}, info() {} },
    tools: { register(def) { registered.push(def) } },
    subagents: {
            getProvider: () => ({ prepareContinuable: async () => ({}) }),
      startContinuable: async (spec) => ({ childId: spec.childId, messageId: "m1" }),
      drainContinuableChildren: async () => {},
    },
    llm: { resolveCallConfig: async (config) => ({ ...config }) },
    sessions: { get: (id) => ({ id }), flush: async () => true },
    sessionPersistence: {},
  }
  const dispose = await hostPlugin.apply(ctx, {}, {
    registerEmbeddedSkill: async () => {},
  })
  try {
    assert.deepEqual(registered.map((d) => d.name), ["tw", "tw-dispatch"])
    const { runTw, calls } = makeRunTw(planCard([ownerWave()]))
    const { ctx: newCtx } = makeCtx()
    const tool = twDispatchDefinition(newCtx, { runTw })
    const out = await tool.execute({ task: "demo-t" }, EXEC)
    assert.equal(out.dispatched[0].ok, true, JSON.stringify(out))
    assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 1)
  } finally {
    if (typeof dispose === "function") dispose()
  }
})
