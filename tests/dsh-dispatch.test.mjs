import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import z from "@deepseek-ai/schemastery"

import {
  TOOL_NAME,
  STAGE_ABBREV,
  TW_DISPATCH_OUTPUT_SCHEMA,
  buildDispatchLabel,
  deterministicSessionId,
  isHealthyInflightBatch,
  isHealthyInflightItem,
  roleAbbrev,
  twDispatchDefinition,
  twDispatchToolDescription,
} from "../dsh/tw-dispatch.js"
import {
  NATIVE_DELEGATION_TOOLS,
  SLEEP_CONFIRM_STOP,
  analyzeSleepCommand,
  createSleepConfirmGuard,
  renderSleepConfirmGuide,
} from "../dsh/sleep-confirm.js"
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
      data: { target: "next-turn", start: 0, inserted: [{ id: "msg-" + (++msgSeq), role: "user", content: Array.isArray(text) ? structuredClone(text) : [{ type: "text", text }] }] },
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
        splice(session, spec.request.prompt) // inbox 接受即同步进内存事件流，保留全部块
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
        followups.push({ childId, text: content[0]?.text, content: structuredClone(content), options })
        splice(session, content)
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

test("成员投递为单块业务正文：初派/续派/重建/在途冷提醒都不带规则块，Lead presentation 原样透传", async (t) => {
  const rules = "旧投影规则段原文\n专项必读段原文\n资源：包内规范"
  for (const mode of ["fresh", "incremental", "full", "reminder", "rebuild", "inflight-reminder", "inflight-recreate"]) {
    const h = makeCtx()
    // 禁止模型调用技能入口；装配服务仍在，不把移除服务当成验收。
    h.ctx.skills = { register() { return () => {} }, get() { assert.fail("不应主动调用 skill") } }
    const continuation = ["incremental", "full", "reminder", "rebuild"].includes(mode)
    // 旧 Runtime 投影仍可能带 requiredGuidance：绑定层必须忽略，不得追加第二个 text 块。
    const wave = ownerWave({ continuation, ...(continuation ? { expectedAgentId: "prior-example" } : {}), prompt: "本轮增量正文", promptFull: "本轮完整正文", requiredGuidance: rules })
    if (["incremental", "full", "reminder", "inflight-reminder"].includes(mode)) h.injectCold("prior-example", { received: mode === "incremental" ? "旧轮正文" : ["reminder", "inflight-reminder"].includes(mode) ? wave.promptFull : null })
    const lead = { purpose: "进展汇报", requiredGuidance: "Lead 公共必读原文" }
    const plan = mode.startsWith("inflight")
      ? { ok: true, task: "demo-t", stage: "implementation", stop: "wait-inflight", inflight: [{ ...wave, continuation: true, registered: true, mappedAgentId: "prior-example" }], card: { presentation: lead } }
      : planCard([wave], { presentation: lead })
    const { runTw } = makeRunTw(plan)
    const tool = twDispatchDefinition(h.ctx, { runTw })
    const result = await tool.execute({ task: "demo-t" }, EXEC)
    const sent = h.started[0]?.request.prompt ?? h.followups[0]?.content
    assert.equal(sent.length, 1, mode + "：成员消息只有业务正文一块")
    assert.equal(sent[0].type, "text", mode)
    if (mode.includes("reminder")) {
      assert.match(sent[0].text, /已收到本轮派单正文/)
      assert.doesNotMatch(sent[0].text, /本轮完整正文|本轮增量正文/)
    } else assert.equal(sent[0].text, mode === "incremental" ? wave.prompt : continuation || mode.startsWith("inflight") ? wave.promptFull : wave.prompt)
    assert.equal(h.started.length + h.followups.length, 1, mode)
    assert.deepEqual(result.presentation, lead)
    const rendered = tool.output.render({}, result)[0].text
    assert.equal(JSON.parse(rendered).presentation.requiredGuidance, lead.requiredGuidance)
    assert.doesNotMatch(rendered, /旧投影规则段原文|专项必读段原文|本轮完整正文|本轮增量正文/)
    t.diagnostic(mode + "：单块业务正文 " + sent[0].text.length + " 字符，实际投递 1 条消息；非 token 统计")
  }
})

test("requiredGuidance 缺失或为空时只投业务正文，不注入规则未带入诊断句", async () => {
  for (const value of [undefined, "", "   "]) {
    const h = makeCtx()
    const wave = ownerWave({ ...(value === undefined ? {} : { requiredGuidance: value }) })
    const { runTw } = makeRunTw(planCard([wave]))
    const out = await twDispatchDefinition(h.ctx, { runTw }).execute({ task: "demo-t" }, EXEC)
    assert.equal(out.dispatched[0].ok, true)
    assert.deepEqual(h.started[0].request.prompt, [{ type: "text", text: wave.prompt }])
    assert.doesNotMatch(JSON.stringify(h.started[0].request.prompt), /规则未带入|requiredGuidance/)
  }
})

test("规则字段变化不改变业务正文收单与冷提醒；live 与 awaiting-user 不投递也不调用技能", async () => {
  const h = makeCtx()
  const wave = ownerWave({ requiredGuidance: "第一版规则" })
  const { runTw } = makeRunTw(planCard([wave], { presentation: { requiredGuidance: "Lead 规则" } }))
  const tool = twDispatchDefinition(h.ctx, { runTw })
  await tool.execute({ task: "demo-t" }, EXEC)
  // 业务正文已持久化，模拟仅活会话离开；业务文本没有变化，规则字段变化不构成重投理由。
  h.ctx.sessions.get = () => undefined
  wave.requiredGuidance = "第二版规则"
  const retry = await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(retry.dispatched[0].resume, "reminder")
  assert.equal(h.followups[0].content.length, 1, "冷提醒也只有业务正文一块")
  assert.match(h.followups[0].content[0].text, /已收到本轮派单正文/)
  assert.doesNotMatch(h.followups[0].content[0].text, /第一版规则|第二版规则/)
  h.ctx.sessions.get = () => ({ header: { parentSession: EXEC.agent.id } })
  await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(h.started.length, 1)
  assert.equal(h.followups.length, 1)
  const stop = { ok: true, stop: "awaiting-user", card: { status: "awaiting-user", presentation: { requiredGuidance: "公共与专项" } } }
  const waiting = twDispatchDefinition(h.ctx, { runTw: async () => stop })
  assert.equal(await waiting.execute({ task: "demo-t" }, EXEC), stop)
  assert.equal(JSON.parse(waiting.output.render({}, stop)[0].text).card.presentation.requiredGuidance, "公共与专项")
  assert.equal(h.started.length, 1)
  assert.equal(h.followups.length, 1)
})

test("真实 CLI 接缝：派单卡以单块业务正文直达成员，最终 render 只保留 Lead 呈现", async (t) => {
  const project = await mkdtemp(path.join(os.tmpdir(), "twr-clarity-dispatch-"))
  t.after(() => rm(project, { recursive: true, force: true }))
  const snapshot = { entryId: "team-work-dsh", profile: "profile-example", tiers: {
    junior: { provider: "provider-example", model: "model-basic" },
    senior: { provider: "provider-example", model: "model-standard" },
    expert: { provider: "provider-example", model: "model-advanced" },
  } }
  const exec = { agent: { id: EXEC.agent.id, session: { header: { cwd: project } } } }
  const configSnapshot = () => snapshot
  const opened = await twToolDefinition({ configSnapshot }).execute({ args: ["open", "--name", "clarity-seam", "--objective", "审查虚构模块的接口边界", "--entry", "code-review"] }, exec)
  assert.equal(opened.ok, true, JSON.stringify(opened))
  const h = makeCtx()
  h.ctx.skills = { register() { return () => {} }, get() { assert.fail("禁止主动调用技能") } }
  // 不替换 runTw/createDirectedSubagent；只替代不会访问真实模型的宿主服务。
  const tool = twDispatchDefinition(h.ctx, { configSnapshot })
  const result = await tool.execute({ task: "clarity-seam", writables: [{ path: "AUDIT.md", kind: "code-review" }] }, exec)
  assert.equal(result.dispatched[0].ok, true, JSON.stringify(result))
  const required = async (resource) => {
    const text = await readFile(new URL(resource, import.meta.url), "utf8")
    return text.split("<!-- clarity:required:begin -->")[1].split("<!-- clarity:required:end -->")[0]
  }
  const publicRules = await required("../skills/clarity-guidance/output-standard.md")
  assert.match(publicRules, /实质争议.*暂停依赖/, "真实 CLI 派单到创建消息的通用暂停提醒，仅证明送达")
  const reviewRules = await required("../skills/clarity-review/references/review-rules.md")
  const message = h.started[0].request.prompt
  assert.equal(message.length, 1, "成员消息是单块业务正文，不再追加规则块")
  assert.equal(message[0].type, "text")
  assert.match(message[0].text, /^# 派单（key: /)
  assert.match(message[0].text, /任务：clarity-seam；阶段：code-review/)
  assert.equal(message[0].text.includes(publicRules), false, "明晰段只随 Lead 反吐出现")
  assert.equal(message[0].text.includes(reviewRules), false)
  const rendered = tool.output.render({}, result)[0].text
  const leadText = JSON.parse(rendered).presentation
  assert.equal(typeof leadText, "string")
  assert.equal(leadText.split(publicRules).length - 1, 1)
  assert.equal(leadText.includes(reviewRules), false)
  assert.equal("waves" in JSON.parse(rendered), false)
  assert.equal(rendered.includes(JSON.stringify(message[0].text)), false)
  t.diagnostic("真实子进程 → 插件核心 → start 参数：成员单块业务正文 " + message[0].text.length + " 字符；Lead 仅自身呈现，无主动 skill 调用或真实 LLM。")
})

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
    nextAction: "wait-children",
    dispatched: [{
      ok: true,
      key: "d1-abc123",
      label: "IMPL·owner · 接口改造 #demo-t",
      sessionId: fixedId,
      provider: "p-a",
      model: "m-j1",
      waveId: "wv1",
      registered: true,
      action: "wait",
      message: "已创建成员会话（" + fixedId + "）并投递派单；输出派发简报后自然结束回合即可，等待成员完成通知（宿主会自动唤醒本会话）；请勿轮询或调用 sleep，确需同步等待时 sleep 类命令首次会被确认引导",
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
  assert.match(table, /仅由 Lead 执行/, "正式组团由 Lead 承担")
  assert.match(table, /成员内部只读助手：原生 subagent/)
  assert.match(table, /限定小问题.*不得继续委托/, "成员仍可开有范围的辅助，不能递归招募")
  assert.match(table, /list_subagent_models.*精确查询/)

  assert.ok(twDispatchToolDescription().includes(table), "tw-dispatch 工具说明含同表")
  assert.ok(systemPromptSection({}, {}).text().includes(table), "systemPrompt section 含同表")

  const dispatchDef = twDispatchDefinition({}, {})
  assert.equal(dispatchDef.description, twDispatchToolDescription())
})

test("派发文案不再声称回合已收束：工具描述与 nextAction 说明都指向简报、自动唤醒与 sleep 确认引导", () => {
  const description = twDispatchToolDescription()
  assert.match(description, /输出派发简报后自然结束回合即可/)
  assert.match(description, /sleep 类命令首次会被确认引导/)
  assert.doesNotMatch(description, /自动收束当前回合/)
  const nextActionText = TW_DISPATCH_OUTPUT_SCHEMA.properties.nextAction.description
  assert.match(nextActionText, /可输出简报后结束回合等待通知/)
  assert.doesNotMatch(nextActionText, /本回合自动收束/)
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

function makeSpySleepConfirm() {
  const notes = []
  return {
    notes,
    noteDispatch(exec, card) { notes.push({ exec, card }) },
    aroundExecute: async (_exec, next) => next(),
    clearTurn() {},
  }
}

test("波次派发不再收束回合：健康派发只记录派发世代，静止卡/部分失败/未确认持久化均保留汇报回合", async () => {
  // 1. 正常初派、同父活会话等待、冷唤醒续投、wait-inflight 健康恢复 → 只 noteDispatch，不再 concludeTurn
  for (const mode of ["fresh", "reused-live", "cold-followup", "wait-inflight-healthy"]) {
    const h = makeCtx()
    const wave = ownerWave({
      ...(mode === "cold-followup" ? { continuation: true, expectedAgentId: "cold-c1" } : {}),
    })
    if (mode === "reused-live") h.injectLive(deterministicSessionId("demo-t", wave.dispatchKey), { received: wave.prompt })
    if (mode === "cold-followup") h.injectCold("cold-c1", { received: "旧轮正文" })
    const plan = mode === "wait-inflight-healthy"
      ? inflightCard([inflightItem({ registered: true, mappedAgentId: "live-inflight-1" })])
      : planCard([wave])
    if (mode === "wait-inflight-healthy") h.injectLive("live-inflight-1", { received: "原派单" })
    const { runTw } = makeRunTw(plan)
    const sleepConfirm = makeSpySleepConfirm()
    const tool = twDispatchDefinition(h.ctx, { runTw, sleepConfirm })
    let concluded = 0
    const out = await tool.execute({ task: "demo-t" }, { ...EXEC, concludeTurn() { concluded++ } })
    assert.equal(concluded, 0, mode + " 健康派发不得收束回合（模型还要输出派发简报）")
    assert.equal(out.nextAction, "wait-children", mode + " nextAction 应为 wait-children")
    assert.equal(sleepConfirm.notes.length, 1, mode + " 健康派发记录一次派发世代")
    assert.equal(sleepConfirm.notes[0].card, out, mode + " noteDispatch 收到本次卡片")
    const entry = out.dispatched?.[0] ?? out.inflight?.[0]
    // 纯重入等待（活会话在场）必须带 reused 标记，否则 guard 会把重入查询误判成新交付而重置确认状态。
    assert.equal(entry.reused, mode === "reused-live" || mode === "wait-inflight-healthy" ? true : undefined, mode + " reused 标记语义")
  }

  // 2. awaiting-user / blocked / completed / archived / 拒绝卡 / 空波计划 → 不记录派发世代
  for (const stopCard of [
    { ok: true, task: "demo-t", stage: "finish", stop: "awaiting-user", waves: [], card: { status: "awaiting-user" } },
    { ok: true, task: "demo-t", stage: null, stop: "blocked", waves: [], card: { ok: false } },
    { ok: true, task: "demo-t", stage: "finish", stop: "completed", waves: [], card: { status: "completed" } },
    { ok: true, task: "demo-t", stage: null, stop: "archived", waves: [], card: { archived: true } },
    { ok: false, code: "TASK_NOT_FOUND", message: "任务不存在" },
    { ok: true, task: "demo-t", stage: "finish", stop: null, waves: [] },
  ]) {
    const h = makeCtx()
    const { runTw } = makeRunTw(stopCard)
    const sleepConfirm = makeSpySleepConfirm()
    const tool = twDispatchDefinition(h.ctx, { runTw, sleepConfirm })
    let concluded = 0
    await tool.execute({ task: "demo-t" }, { ...EXEC, concludeTurn() { concluded++ } })
    assert.equal(concluded, 0, "非在途卡不得收束回合：" + JSON.stringify(stopCard))
    assert.equal(sleepConfirm.notes.length, 0, "非在途卡不得记录派发世代：" + JSON.stringify(stopCard))
  }

  // 3. 部分失败、wait-inflight passthrough（未知登记）、flush 持久化未确认 → 不记录派发世代且 nextAction=recover
  {
    const h = makeCtx()
    h.ctx.sessions.flush = async () => false
    const { runTw } = makeRunTw(planCard([ownerWave()]))
    const sleepConfirm = makeSpySleepConfirm()
    const tool = twDispatchDefinition(h.ctx, { runTw, sleepConfirm })
    let concluded = 0
    const out = await tool.execute({ task: "demo-t" }, { ...EXEC, concludeTurn() { concluded++ } })
    assert.equal(concluded, 0, "持久化未确认不得收束回合")
    assert.equal(sleepConfirm.notes.length, 0, "持久化未确认不得记录派发世代")
    assert.equal(out.nextAction, "recover")
  }
  {
    const h = makeCtx()
    const { runTw } = makeRunTw(inflightCard([inflightItem({ registered: undefined, registeredUnresolved: "损坏" })]))
    const sleepConfirm = makeSpySleepConfirm()
    const tool = twDispatchDefinition(h.ctx, { runTw, sleepConfirm })
    let concluded = 0
    const out = await tool.execute({ task: "demo-t" }, { ...EXEC, concludeTurn() { concluded++ } })
    assert.equal(concluded, 0, "passthrough 未知登记不得收束回合")
    assert.equal(sleepConfirm.notes.length, 0, "passthrough 未知登记不得记录派发世代")
    assert.equal(out.nextAction, "recover")
  }
})

test("sleep 确认引导：同 Step 后续等待继续拦截，更晚 Step 再次执行放行，新回合重新引导，其余工具完全放行", async () => {
  const registered = new Map()
  const listeners = new Map()
  const h = makeCtx()
  const { runTw, calls } = makeRunTw(planCard([ownerWave()]))
  const ctx = {
    ...h.ctx,
    logger: { warn() {}, info() {} },
    tools: { register(def) { registered.set(def.name, def); return () => registered.delete(def.name) } },
    on(event, fn) {
      listeners.set(event, fn)
      return () => listeners.delete(event)
    },
  }
  const fixedNow = Date.parse("2026-10-30T10:00:00+08:00")
  const sleepConfirm = createSleepConfirmGuard({ now: () => fixedNow })
  const dispose = await hostPlugin.apply(ctx, {}, {
    registerEmbeddedSkill: async () => {},
    sleepConfirm,
  })
  assert.deepEqual([...listeners.keys()].sort(), ["session/event", "tools/execute"], "只装配工具执行引导与回合边界清理，旧的 pre-step 钩子已下线")
  // 替换 tw-dispatch 的内部 runTw 以观测调用次数
  const dispatchTool = twDispatchDefinition(ctx, { runTw, sleepConfirm })
  registered.set("tw-dispatch", dispatchTool)
  const invokeViaHook = (exec, body) => listeners.get("tools/execute")(exec, body)
  const emitSessionEvent = (id, type) => listeners.get("session/event")({ id }, { type })
  let bashExecCount = 0
  let runCodeExecCount = 0
  let seq = 0
  const runBash = async (agent, command, extra = {}) => {
    const contexts = []
    // 顶层 bash 没有 parent；run_code 内嵌（PTC）调用才带 parent token。
    const exec = {
      name: "bash",
      callId: extra.callId ?? "call-" + String(++seq),
      rootCallId: extra.rootCallId ?? "rc-bash-" + String(seq),
      ...(extra.parent ? { parent: extra.parent } : {}),
      agent,
      arguments: { command, description: "test" },
      deferContext(context) { contexts.push(context) },
    }
    let executed = 0
    const result = await invokeViaHook(exec, async () => {
      bashExecCount++
      executed++
      return { isError: false, value: { kind: "foreground", exitCode: 0 } }
    })
    return { result, contexts, executed }
  }

  try {
    const leadAgent = { id: "parent-agent-1", phase: { kind: "running", turn: 1, step: 1 }, session: { header: { cwd: "/proj" } } }
    const childAgent = { id: "child-agent-1", phase: { kind: "running", turn: 1, step: 1 }, session: { header: { cwd: "/proj" } } }
    const parentToken = Symbol("ptc-run-1")

    // 1) 首派健康返回：不再 concludeTurn，回合继续，可输出简报
    let outerConcluded = 0
    const dispatchExec = { name: "tw-dispatch", callId: "rc-1:ptc:1", rootCallId: "rc-1", parent: parentToken, agent: leadAgent, concludeTurn() { outerConcluded++ } }
    const dispatchRes = await invokeViaHook(dispatchExec, () => dispatchTool.execute({ task: "demo-t" }, dispatchExec))
    assert.equal(dispatchRes.nextAction, "wait-children")
    assert.equal(outerConcluded, 0, "派发后不再收束回合")

    // 2) 同一 run_code 内紧接着 bash sleep：首次引导，命令未执行，引导经 deferContext 递达
    const first = await runBash(leadAgent, "sleep 30", { callId: "rc-1:ptc:2", rootCallId: "rc-1", parent: parentToken })
    assert.equal(first.executed, 0, "首次命中的 sleep 不执行")
    assert.equal(first.result.isError, false)
    assert.equal(first.result.value.stopped, SLEEP_CONFIRM_STOP)
    assert.equal(first.result.value.cwd, "/proj")
    assert.equal(first.contexts.length, 1, "嵌套调用的引导不依赖程序转印：deferContext 独立递达")
    assert.equal(first.contexts[0].role, "user")
    assert.equal(first.contexts[0].source.kind, "sleep-confirm")
    assert.match(first.contexts[0].content[0].text, /TWR_SLEEP_CONFIRM/)
    assert.match(first.contexts[0].content[0].text, /1 分钟前刚派发了任务 demo-t 的波次/, "首行追加近期派发提示")

    // 3) 同 Step 的后续 sleep（不同根调用）继续拦截，只返回精简提示
    const second = await runBash(leadAgent, "sleep 30", { callId: "rc-2", rootCallId: "rc-2", parent: Symbol("ptc-run-2") })
    assert.equal(second.executed, 0)
    assert.equal(second.result.value.stopped, SLEEP_CONFIRM_STOP)
    assert.match(second.contexts[0].content[0].text, /本回合已引导过/)

    // 4) 非 sleep 的 bash / run_code / tw-dispatch 完全放行（同回合连续派发回归）
    const plain = await runBash(leadAgent, "echo hello")
    assert.equal(plain.executed, 1, "非 sleep 的 bash 正常执行")
    const runCodeResult = await invokeViaHook({ name: "run_code", callId: "rc-3", rootCallId: "rc-3", agent: leadAgent }, async () => {
      runCodeExecCount++
      return { isError: false, value: { logs: [], result: "ok" } }
    })
    assert.equal(runCodeExecCount, 1, "run_code 正常执行")
    assert.equal(runCodeResult.value.result, "ok")
    const beforeTaskB = calls.length
    const taskBExec = { name: "tw-dispatch", callId: "rc-3b", rootCallId: "rc-3b", agent: leadAgent }
    const taskB = await invokeViaHook(taskBExec, () => dispatchTool.execute({ task: "demo-t" }, taskBExec))
    assert.equal(calls.length, beforeTaskB + 2, "同回合再派发正常走判定链（dispatch-plan + agent-map），无屏障短路")
    assert.equal(taskB.nextAction, "wait-children")
    assert.equal(taskB.dispatched[0].reused, true, "同 key 由判定链收敛为纯重入等待（reused），不是屏障短路卡")

    // 4b) 其他工具调用夹在中间不使确认失效（跨多 Step 做别的事）
    const interleaved = await invokeViaHook({ name: "tw", callId: "rc-3c", rootCallId: "rc-3c", agent: leadAgent }, async () => ({ isError: false, value: { ok: true } }))
    assert.equal(interleaved.isError, false)

    // 5) 子代理独立状态：同 Step 首次引导，更晚 Step 放行
    const childFirst = await runBash(childAgent, "sleep 30", { callId: "child-rc-1:ptc:1", rootCallId: "child-rc-1", parent: Symbol("child-ptc") })
    assert.equal(childFirst.executed, 0, "子代理的 sleep 同样被引导")
    childAgent.phase = { kind: "running", turn: 1, step: 2 }
    const childSecond = await runBash(childAgent, "sleep 30", { callId: "child-rc-2:ptc:1", rootCallId: "child-rc-2" })
    assert.equal(childSecond.executed, 1, "子代理更晚 Step 确认放行")

    // 6) Lead 更晚 Step 再次执行（顶层调用）→ 确认放行；同 Step 改写命令仍放行
    leadAgent.phase = { kind: "running", turn: 1, step: 2 }
    const confirmed = await runBash(leadAgent, "sleep 30", { callId: "rc-4", rootCallId: "rc-4" })
    assert.equal(confirmed.executed, 1, "看到引导后的更晚 Step 再次执行即确认放行")
    const rewritten = await runBash(leadAgent, "sleep 90", { callId: "rc-5", rootCallId: "rc-5" })
    assert.equal(rewritten.executed, 1, "确认是回合级一次性，不按命令文本指纹")

    // 7) 回合边界清空（turn/end）：新回合重新引导一次
    emitSessionEvent("parent-agent-1", "turn/end")
    leadAgent.phase = { kind: "running", turn: 2, step: 1 }
    const newTurn = await runBash(leadAgent, "sleep 30", { callId: "rc-6", rootCallId: "rc-6" })
    assert.equal(newTurn.executed, 0, "新回合重新引导")
    assert.match(newTurn.contexts[0].content[0].text, /请先自判等待是否必要/)
    leadAgent.phase = { kind: "running", turn: 2, step: 2 }
    assert.equal((await runBash(leadAgent, "sleep 30", { callId: "rc-7", rootCallId: "rc-7" })).executed, 1, "新回合的确认放行")

    // 8) turn/start 同样清空 confirmed（guided 与 confirmed 一并清除）
    emitSessionEvent("parent-agent-1", "turn/start")
    leadAgent.phase = { kind: "running", turn: 3, step: 1 }
    assert.equal((await runBash(leadAgent, "sleep 30", { callId: "rc-8", rootCallId: "rc-8" })).executed, 0, "turn/start 后重新引导")
  } finally {
    if (typeof dispose === "function") dispose()
  }
})

test("sleep 检测规则矩阵：R1/R2/R3 命中，白名单与未覆盖形态放行", () => {
  const cases = [
    ["sleep 5", true, "R1"],
    ["sleep 1", true, "R1"],
    ["sleep 0.5", false, null],
    ["sleep 0", false, null],
    ["watch -n 2 date", true, "R1"],
    ["tail -f app.log", true, "R1"],
    ["tail -n 20 -f app.log", true, "R1"],
    ["tail -n 20 app.log", false, null],
    ["while true; do sleep 5; done", true, "R2"],
    ["until test -f out.txt; do sleep 0.2; done", true, "R2"],
    ["while true; do date; done", false, null],
    ["for i in 1 2 3; do sleep 1; done", false, null],
    ["echo start && sleep 5", true, "R3"],
    ["echo a; sleep 3", true, "R3"],
    ["echo a\nsleep 3", true, "R3"],
    ["echo start; sleep 2", false, null],
    ["sleep 5 && echo done", true, "R1"],
    ["ps aux | grep node", false, null],
    ["sleep infinity", true, "R1"],
  ]
  for (const [command, expected, rule] of cases) {
    const hit = analyzeSleepCommand(command)
    assert.equal(hit.match, expected, command)
    assert.equal(hit.rule, rule, command)
  }
  assert.equal(analyzeSleepCommand("sleep 5", { runInBackground: true }).match, false, "run_in_background 走宿主原生后台机制，不引导")
  assert.match(renderSleepConfirmGuide(), /TWR_SLEEP_CONFIRM/)
  assert.doesNotMatch(renderSleepConfirmGuide(), /分钟前刚派发/, "无派发记录时不追加场景提示")
})

function makeGuardExec(agent, command, extra = {}) {
  const contexts = []
  const exec = {
    name: "bash",
    callId: extra.callId ?? "call-1",
    rootCallId: extra.rootCallId ?? "root-1",
    parent: extra.parent ?? Symbol("ptc"),
    agent,
    arguments: { command, description: "test", ...(extra.workdir ? { workdir: extra.workdir } : {}), ...(extra.runInBackground ? { run_in_background: true } : {}) },
    deferContext(context) { contexts.push(context) },
  }
  return { exec, contexts }
}

function makeGuardAgent(id = "lead-guard") {
  return { id, phase: { kind: "running", turn: 1, step: 1 }, session: { header: { cwd: "/proj" } } }
}

function setGuardStep(agent, turn, step) {
  agent.phase = { kind: "running", turn, step }
}

test("sleep 引导状态机：首次拦截并递达，同 Step 继续拦截，更晚 Step 确认放行且失败不回退", async () => {
  const guard = createSleepConfirmGuard({ now: () => 0 })
  const agent = makeGuardAgent()
  const run = async (command, extra = {}) => {
    const { exec, contexts } = makeGuardExec(agent, command, extra)
    let executed = 0
    const result = await guard.aroundExecute(exec, async () => {
      executed++
      return { isError: false, value: { kind: "foreground" } }
    })
    return { result, contexts, executed }
  }

  // 1) 首次命中：不执行、返回 bash 前台契约结果、引导经 deferContext 递达
  const first = await run("sleep 30")
  assert.equal(first.executed, 0, "首次禁止真实执行")
  assert.equal(first.result.isError, false)
  assert.equal(first.result.value.kind, "foreground")
  assert.equal(first.result.value.stopped, SLEEP_CONFIRM_STOP)
  assert.equal(first.result.value.cwd, "/proj")
  assert.equal(first.result.value.exitCode, null)
  assert.equal(first.result.value.signal, null)
  assert.equal(first.result.value.timedOut, false)
  assert.equal(first.result.value.aborted, false)
  assert.equal(first.result.value.timeoutMs, 0)
  assert.equal(first.result.value.stdout.truncated, false)
  assert.equal(first.result.value.stderr.text, "")
  assert.equal(first.contexts.length, 1, "引导经 deferContext 递达（嵌套调用不依赖程序转印）")
  assert.equal(typeof first.contexts[0].id, "string")
  assert.equal(first.contexts[0].role, "user")
  assert.equal(first.contexts[0].source.form, "notice")
  assert.match(first.contexts[0].content[0].text, /请先自判等待是否必要/)

  // 2) 同一次 run_code 连续两次 / 同 Step 不同根调用：全部拦截，只首个记 guided
  const second = await run("sleep 30", { callId: "call-2", rootCallId: "root-2" })
  assert.equal(second.executed, 0)
  assert.equal(second.result.value.stopped, SLEEP_CONFIRM_STOP)
  assert.match(second.contexts[0].content[0].text, /本回合已引导过/)
  const third = await run("sleep 1", { callId: "call-3", rootCallId: "root-3" })
  assert.equal(third.executed, 0)
  assert.match(third.contexts[0].content[0].text, /本回合已引导过/)

  // 3) 更晚 Step（不要求紧邻、可夹其他工具）再次执行：确认放行
  let otherRan = 0
  await guard.aroundExecute({ name: "read", agent, arguments: {} }, async () => { otherRan++; return { isError: false } })
  assert.equal(otherRan, 1, "中间夹其他工具调用完全放行")
  setGuardStep(agent, 1, 3)
  const confirmed = await run("sleep 30", { callId: "call-4", rootCallId: "root-4" })
  assert.equal(confirmed.executed, 1, "更晚 Step 再次执行即确认放行")
  const rewritten = await run("sleep 60", { callId: "call-5", rootCallId: "root-5" })
  assert.equal(rewritten.executed, 1, "确认后命令改写仍放行")

  // 4) 确认后命令执行失败与失败重试不回退状态
  const { exec: failingExec } = makeGuardExec(agent, "sleep 5", { callId: "call-6", rootCallId: "root-6" })
  let failingRan = 0
  const failing = await guard.aroundExecute(failingExec, async () => { failingRan++; return { isError: true, error: { message: "boom" } } })
  assert.equal(failingRan, 1)
  assert.equal(failing.isError, true)
  const retried = await run("sleep 5", { callId: "call-7", rootCallId: "root-7" })
  assert.equal(retried.executed, 1, "失败重试不回退 confirmed")

  // 5) 回合边界清空 guided 与 confirmed；新回合重新引导
  guard.clearTurn("lead-guard")
  setGuardStep(agent, 2, 1)
  const newTurn = await run("sleep 30", { callId: "call-8", rootCallId: "root-8" })
  assert.equal(newTurn.executed, 0, "新回合重新引导")

  // 6) 派发世代重置：已引导后新交付 → 后面的 sleep 重新首次拦截
  setGuardStep(agent, 2, 2)
  guard.noteDispatch({ agent }, { ok: true, task: "task-x", dispatched: [{ ok: true, sessionId: "s-x", action: "wait" }] })
  const afterDispatch = await run("sleep 30", { callId: "call-9", rootCallId: "root-9" })
  assert.equal(afterDispatch.executed, 0, "新派发后的 sleep 重新首次拦截")
  assert.match(afterDispatch.contexts[0].content[0].text, /请先自判等待是否必要/)
  setGuardStep(agent, 2, 3)
  const afterDispatchConfirm = await run("sleep 30", { callId: "call-10", rootCallId: "root-10" })
  assert.equal(afterDispatchConfirm.executed, 1)
})

test("派发世代：新交付与原生委派成功递增并重新引导，纯重入 reused 与 send_message 不重置", async () => {
  const guard = createSleepConfirmGuard({ now: () => 0 })
  const agent = makeGuardAgent("lead-epoch")
  const run = async (command, extra = {}) => {
    const { exec, contexts } = makeGuardExec(agent, command, extra)
    let executed = 0
    await guard.aroundExecute(exec, async () => {
      executed++
      return { isError: false, value: { kind: "foreground" } }
    })
    return { contexts, executed }
  }

  // 1) noteDispatch 新交付：引导文案首行含近期派发提示
  guard.noteDispatch({ agent }, { ok: true, task: "task-a", dispatched: [{ ok: true, sessionId: "s1", action: "wait" }] })
  const first = await run("sleep 10")
  assert.equal(first.executed, 0)
  assert.match(first.contexts[0].content[0].text, /本会话 1 分钟前刚派发了任务 task-a 的波次/)
  setGuardStep(agent, 1, 2)
  assert.equal((await run("sleep 10")).executed, 1, "更晚 Step 确认放行")

  // 2) 纯重入等待（判定链命中 reused、无新投递）不重置：确认状态保持放行
  const reusedNote = guard.noteDispatch({ agent }, { ok: true, task: "task-a", dispatched: [{ ok: true, sessionId: "s1", reused: true, action: "wait" }] })
  assert.equal(reusedNote, null, "纯重入 reused 不记录派发世代")
  setGuardStep(agent, 1, 3)
  assert.equal((await run("sleep 10")).executed, 1, "reused 重入后已确认状态保持")

  // 3) 原生委派成功（subagent / subagent_fork）：递增世代，后续 sleep 重新引导
  for (const toolName of NATIVE_DELEGATION_TOOLS) {
    const delegated = { isError: false, value: { subagentId: "child-" + toolName } }
    assert.equal(await guard.aroundExecute({ name: toolName, agent }, async () => delegated), delegated, toolName + " 委派结果透传")
    setGuardStep(agent, 1, agent.phase.step + 1)
    assert.equal((await run("sleep 10")).executed, 0, toolName + " 成功委派后 sleep 重新引导")
    setGuardStep(agent, 1, agent.phase.step + 1)
    assert.equal((await run("sleep 10")).executed, 1, toolName + " 之后再次确认放行")
  }

  // 4) 委派错误返回不重置；send_message（续聊催单）不是新派发也不重置
  const failedDelegation = { isError: true, error: { message: "not allowed" } }
  assert.equal(await guard.aroundExecute({ name: "subagent", agent }, async () => failedDelegation), failedDelegation)
  setGuardStep(agent, 1, agent.phase.step + 1)
  assert.equal((await run("sleep 10")).executed, 1, "委派失败不重置已确认状态")
  assert.equal(await guard.aroundExecute({ name: "send_message", agent }, async () => ({ isError: false })).then((r) => r.isError), false)
  setGuardStep(agent, 1, agent.phase.step + 1)
  assert.equal((await run("sleep 10")).executed, 1, "send_message 不递增世代")

  // 5) wait-inflight 恢复补派 / 冷唤醒 / 断链重建同样是新交付：重置并重新引导
  guard.noteDispatch({ agent }, { ok: true, task: "task-b", inflight: [{ ok: true, sessionId: "s2", recovered: true, action: "recreated" }] })
  setGuardStep(agent, 1, agent.phase.step + 1)
  assert.equal((await run("sleep 10")).executed, 0, "恢复补派后 sleep 重新首次拦截")
})

test("guard 保守方向与 fail-open：phase 读不到继续拦截，guard 自身异常放行原命令", async () => {
  const logs = []
  const guard = createSleepConfirmGuard({ now: () => 0, log: (message) => logs.push(message) })
  const idleAgent = { id: "lead-idle", phase: { kind: "idle", lastTurn: 1 }, session: { header: { cwd: "/proj" } } }
  const runOn = async (agent, command, extra = {}) => {
    const { exec, contexts } = makeGuardExec(agent, command, extra)
    let executed = 0
    const result = await guard.aroundExecute(exec, async () => { executed++; return { isError: false, value: { kind: "foreground" } } })
    return { result, contexts, executed }
  }

  // 1) phase 读不到（idle）：保守视为同 Step，继续拦截而不是放行
  const first = await runOn(idleAgent, "sleep 30")
  assert.equal(first.executed, 0)
  const second = await runOn(idleAgent, "sleep 30", { callId: "call-2", rootCallId: "root-2" })
  assert.equal(second.executed, 0, "phase 读不到时不确认放行")
  assert.match(second.contexts[0].content[0].text, /本回合已引导过/)
  // 引导时 guidedStep 未知，本回合内一律按"同 Step"保守拦截，不因之后 phase 可读就补认更晚 Step
  setGuardStep(idleAgent, 1, 3)
  assert.equal((await runOn(idleAgent, "sleep 30", { callId: "call-3", rootCallId: "root-3" })).executed, 0, "guidedStep 未知时本回合内保守继续拦截")
  guard.clearTurn("lead-idle")
  setGuardStep(idleAgent, 2, 1)
  assert.equal((await runOn(idleAgent, "sleep 30", { callId: "call-4", rootCallId: "root-4" })).executed, 0, "新回合重新引导")
  setGuardStep(idleAgent, 2, 2)
  assert.equal((await runOn(idleAgent, "sleep 30", { callId: "call-5", rootCallId: "root-5" })).executed, 1, "可读 Step 的引导在更晚 Step 确认放行")

  // 2) 检测抛错（phase getter 抛错）：fail-open 放行原命令并记日志
  const brokenAgent = { id: "lead-broken", get phase() { throw new Error("phase 状态损坏") }, session: { header: { cwd: "/proj" } } }
  const broken = await runOn(brokenAgent, "sleep 30")
  assert.equal(broken.executed, 1, "guard 异常时放行原命令")
  assert.ok(logs.some((line) => /phase 状态损坏/.test(line)))

  // 3) 引导递达抛错：同样 fail-open，且不留 guided 残迹（后续仍按首次引导）
  const deferAgent = makeGuardAgent("lead-defer")
  const { exec: deferExec } = makeGuardExec(deferAgent, "sleep 30")
  deferExec.deferContext = () => { throw new Error("递达失败") }
  let deferRan = 0
  const deferResult = await guard.aroundExecute(deferExec, async () => { deferRan++; return { isError: false, value: { kind: "foreground" } } })
  assert.equal(deferRan, 1, "递达失败时放行原命令")
  assert.equal(deferResult.isError, false)
  const retryAfterFailure = await runOn(deferAgent, "sleep 30", { callId: "call-defer-2", rootCallId: "root-defer-2" })
  assert.equal(retryAfterFailure.executed, 0, "递达失败没留下 guided 残迹：下次仍按首次引导")
  assert.match(retryAfterFailure.contexts[0].content[0].text, /请先自判等待是否必要/)
})

test("sleep 引导只拦等待：run_in_background、微小 sleep、workdir 与 cwd、非 bash 工具全部透传", async () => {
  const guard = createSleepConfirmGuard({ now: () => 0 })
  const agent = makeGuardAgent("lead-pass")
  const runOn = async (exec) => {
    let executed = 0
    const result = await guard.aroundExecute(exec, async () => { executed++; return { isError: false, value: { kind: "foreground" } } })
    return { result, executed }
  }
  for (const [command, extra] of [
    ["sleep 0.2", {}],
    ["sleep 30", { runInBackground: true }],
    ["echo hello", {}],
  ]) {
    const { exec } = makeGuardExec(agent, command, extra)
    assert.equal((await runOn(exec)).executed, 1, command + " 应放行")
  }
  const workdirSleep = makeGuardExec(agent, "sleep 30", { workdir: "/custom" })
  const intercepted = await runOn(workdirSleep.exec)
  assert.equal(intercepted.executed, 0)
  assert.equal(intercepted.result.value.cwd, "/custom", "结果 cwd 使用调用 workdir")
  const relativeWorkdir = await runOn(makeGuardExec(agent, "sleep 30", { workdir: "sub" }).exec)
  assert.equal(relativeWorkdir.result.value.cwd, "/proj/sub", "相对 workdir 按会话工作目录解析")
  const toolExec = { name: "run_code", agent, arguments: { code: "await new Promise(() => {})" } }
  assert.equal((await runOn(toolExec)).executed, 1, "run_code 程序体不检测（宿主 timeoutMs 兜底），guard 不拦")
  const noAgentExec = { name: "bash", arguments: { command: "sleep 30" } }
  assert.equal((await runOn(noAgentExec)).executed, 1, "无 agent 上下文时放行")
})

test("TW_DISPATCH_OUTPUT_SCHEMA 与健康在途判定纯函数符合契约", () => {
  assert.equal(TW_DISPATCH_OUTPUT_SCHEMA.type, "object")
  assert.deepEqual(TW_DISPATCH_OUTPUT_SCHEMA.properties.nextAction.enum, ["wait-children", "needs-user-report", "recover", "complete"])
  assert.equal(isHealthyInflightItem({ ok: true, sessionId: "s1", registered: true, action: "wait" }), true)
  assert.equal(isHealthyInflightItem({ ok: true, sessionId: "s1", registered: true, action: "wait", passthrough: true }), false)
  assert.equal(isHealthyInflightItem({ ok: true, sessionId: "s1", registered: true, action: "wait", persistenceConfirmed: false }), false)
  assert.equal(isHealthyInflightBatch([{ ok: true, sessionId: "s1", registered: true, action: "wait" }], 0), true)
  assert.equal(isHealthyInflightBatch([{ ok: true, sessionId: "s1", registered: true, action: "wait" }], 1), false)
  assert.equal(isHealthyInflightBatch([], 0), false)
})
