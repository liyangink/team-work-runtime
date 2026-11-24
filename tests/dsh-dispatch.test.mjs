import assert from "node:assert/strict"
import test, { before } from "node:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import childProcess, { spawn } from "node:child_process"
import { EventEmitter, once } from "node:events"
import { syncBuiltinESMExports } from "node:module"
import { Readable } from "node:stream"
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
import { createMemberMessageGuard } from "../dsh/member-message-guard.js"
import { coldSessionReceived } from "../dsh/subagent-session.js"
import * as hostPlugin from "../dsh/index.js"

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex")

// 投递锁在会话工作目录下创建 .team-work/tasks/<task>/locks，虚构路径会 ENOENT；
// 测试统一使用真实临时目录。
let EXEC_ROOT = ""
let EXEC
before(async () => {
  EXEC_ROOT = await mkdtemp(path.join(os.tmpdir(), "twr-dispatch-exec-"))
  await mkdir(path.join(EXEC_ROOT, ".team-work/tasks/demo-t/locks"), { recursive: true })
  EXEC = { agent: { id: "parent-agent-1", session: { header: { cwd: EXEC_ROOT } } } }
})

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
  const walk = (node) => { delete node.meta.volatile; for (const child of Object.values(node.dict ?? {})) walk(child); if (node.inner) walk(node.inner); for (const child of Object.list ?? []) walk(child) }
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
  const dispatch = twDispatchDefinition(h.ctx, { configSnapshot, runTw: async (args, cwd, config) => { cards.push(config); return args[0] === "dispatch-plan" ? planCard([ownerWave()]) : args[0] === "run" ? { ok: true, task: "demo-t", stage: "implementation", status: "working", transition: "wait-inflight", inflight: [ownerWave()] } : { ok: true, status: "active", agentId: args[6], idempotent: true } } })
  await dispatch.execute({ task: "demo-t" }, EXEC)
  assert.equal(reads, 1)
  assert.ok(cards.length >= 2, "dispatch-plan 与锁内重验都携带同一快照")
  assert.ok(cards.every((c) => c === snapshot))
  const tw = twToolDefinition({ configSnapshot, runTw: async (_executable, _args, _cwd, config) => { assert.equal(config, snapshot); return { ok: true } } })
  await tw.execute({ args: ["models"] }, EXEC)
  assert.equal(reads, 2)
  assert.equal(process.env.TW_DSH_CONFIG, original)
})

test("冷续派发送前登记新 key，登记失败不发正文", async () => {
  const wave = ownerWave({ dispatchKey: "d5-continuation", continuation: true, expectedAgentId: "prior-example" })
  const h = makeCtx()
  h.injectCold("prior-example", { received: "# 派单（key: d0-old）\n\n上一轮正文" })
  const { runTw, calls } = makeRunTw(planCard([wave]), { failCommands: { "agent-map": { ok: false, message: "登记失败" } } })
  const tool = twDispatchDefinition(h.ctx, { runTw })
  const result = await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(result.dispatched[0].code, "TW_DISPATCH_REGISTER_FAILED")
  assert.equal(h.followups.length, 0)
  const mapCall = calls.find((call) => call.cmd === "agent-map")
  assert.deepEqual(mapCall.args, ["agent-map", "--task", "demo-t", "--key", "d5-continuation", "--agent", "prior-example"])
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

for (const [name, execute] of [
  ["tw", () => twToolDefinition().execute({ args: ["run", "--task", "demo-t"] }, EXEC)],
  ["tw-dispatch", () => twDispatchDefinition({}).execute({ task: "demo-t" }, EXEC)],
]) {
  for (const stream of ["stdout", "stderr"]) {
    test(`${name}：${stream} 跨分块时完整保留中文回执`, async (t) => {
      const card = { ok: true, task: "demo-t", stop: "completed", message: "中文回执" }
      const bytes = Buffer.from(JSON.stringify(card), "utf8")
      // 在「中」的首字节后断开，逐块交给管道读取方，不依赖真实管道何时合并写入。
      const split = bytes.indexOf("中") + 1
      const chunks = [bytes.subarray(0, split), bytes.subarray(split)]
      const spawnMock = t.mock.method(childProcess, "spawn", () => {
        const child = Object.assign(new EventEmitter(), {
          stdout: Readable.from(stream === "stdout" ? chunks : []),
          stderr: Readable.from(stream === "stderr" ? chunks : []),
        })
        void Promise.all([once(child.stdout, "end"), once(child.stderr, "end")]).then(() => child.emit("close", 0))
        return child
      })
      syncBuiltinESMExports()
      try {
        assert.deepEqual(await execute(), card)
      } finally {
        spawnMock.mock.restore()
        syncBuiltinESMExports()
      }
    })
  }
}

test("registered 在途冷重试已含同轮正文，仅续行提示", async () => {
  const item = { ...ownerWave(), registered: true, mappedAgentId: "prior-example" }
  const { runTw } = makeRunTw({ ok: true, task: "demo-t", stage: "implementation", stop: "wait-inflight", inflight: [item] })
  const h = makeCtx()
  h.injectCold("prior-example", { received: item.prompt })
  const result = await twDispatchDefinition(h.ctx, { runTw }).execute({ task: "demo-t" }, EXEC)
  assert.equal(result.inflight[0].resume, "reminder")
  assert.match(h.followups[0].text, /已收到本轮派单正文/)
  assert.match(h.followups[0].text, /登记则正常结束，不预告、不另发交卷摘要/)
})

test("预登记新 key 但本轮正文未送达时，旧上下文不能误选轻提示", async () => {
  const item = ownerWave({ dispatchKey: "d5-next-round", continuation: true, prompt: "本轮增量正文", promptFull: "本轮全量正文" })
  const inflight = { ...item, registered: true, mappedAgentId: "prior-example" }
  const { runTw, calls } = makeRunTw({ ok: true, task: "demo-t", stage: "implementation", stop: "wait-inflight", inflight: [inflight] })
  const h = makeCtx()
  h.injectCold("prior-example", { received: "# 派单（key: d0-old）\n\n上一轮派单正文" })
  const result = await twDispatchDefinition(h.ctx, { runTw }).execute({ task: "demo-t" }, EXEC)
  assert.equal(result.inflight[0].resume, "incremental")
  assert.equal(h.followups[0].text, item.prompt)
  assert.ok(calls.filter((call) => call.cmd === "agent-map").length >= 1, "发送前已完成映射登记")
  const firstMap = calls.findIndex((call) => call.cmd === "agent-map")
  const sendIndex = calls.length // sends 不经过 runTw；以 agent-map 先于 followup 的因果由 h.followups 长度断言
  assert.ok(firstMap >= 0 && sendIndex > firstMap)
})

test("新 continuation 冷会话已收本轮全量时，先登记同父映射再轻量续行", async () => {
  const wave = ownerWave({ dispatchKey: "d5-next-round", continuation: true, expectedAgentId: "prior-example", prompt: "本轮增量正文", promptFull: "本轮全量正文" })
  const { runTw, calls } = makeRunTw(planCard([wave]))
  const h = makeCtx()
  h.injectCold("prior-example", { received: wave.promptFull })
  const result = await twDispatchDefinition(h.ctx, { runTw }).execute({ task: "demo-t" }, EXEC)
  assert.equal(result.dispatched[0].resume, "reminder")
  assert.match(h.followups[0].text, /已收到本轮派单正文/)
  const mapCall = calls.find((call) => call.cmd === "agent-map")
  assert.deepEqual(mapCall.args, ["agent-map", "--task", "demo-t", "--key", "d5-next-round", "--agent", "prior-example"])
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
// 冻结正文契约：首行 key 标记 + promptFrozen + SHA-256 摘要；continuation 附全量变体。
function withKeyHeader(text, key, kind, dash) {
  if (typeof text !== "string" || !text.trim()) return text
  if (text.startsWith("# ")) return text
  return `# ${kind}（key: ${key}）${dash}\n\n${text}`
}
function ownerWave(overrides = {}) {
  const key = overrides.dispatchKey ?? "d1-abc123"
  const continuation = overrides.continuation ?? false
  const prompt = withKeyHeader(overrides.prompt ?? "派单全文 PROMPT", key, continuation ? "续派" : "派单", continuation ? "——你在原上下文基础上继续" : "")
  const base = {
    dispatchKey: key,
    waveId: "wv1",
    kind: "produce",
    role: "owner",
    tier: "junior",
    round: 1,
    continuation: false,
    deliver: "deliver",
    modelRef: { provider: "p-a", modelName: "m-j1" },
    weight: 1,
    ...overrides,
    prompt,
    promptFrozen: true,
    promptDigest: sha(prompt),
  }
  if (base.continuation || base.promptFull !== undefined) {
    base.promptFull = withKeyHeader(base.promptFull ?? "全量派单正文：目标+约束+排除", key, "续派全量变体", "——原会话上下文不可用时的自足派单")
    base.promptFullDigest = sha(base.promptFull)
  }
  return base
}

// 状态化 CLI 桩：dispatch-plan 返回计划；run 返回 wait-inflight 投影；agent-map 按 CAS 登记映射。
function makeRunTw(plan, { failCommands = {}, onCall } = {}) {
  const calls = []
  const mappings = new Map()
  const keyOf = (item) => (typeof item?.dispatchKey === "string" && item.dispatchKey) || (typeof item?.key === "string" ? item.key : "")
  const waveItems = () => (plan?.stop === "wait-inflight" ? (Array.isArray(plan?.inflight) ? plan.inflight : []) : Array.isArray(plan?.waves) ? plan.waves : [])
  for (const item of waveItems()) {
    const k = keyOf(item)
    if (item?.registered === true && typeof item?.mappedAgentId === "string" && item.mappedAgentId) mappings.set(k, item.mappedAgentId)
  }
  const projection = (item) => {
    const k = keyOf(item)
    if (mappings.has(k)) return { ...item, registered: true, mappedAgentId: mappings.get(k) }
    return { ...item, registered: false }
  }
  const runTw = async (args, cwd) => {
    calls.push({ cmd: args[0], args, cwd })
    if (onCall) onCall(args[0], args)
    const fail = typeof failCommands[args[0]] === "function" ? failCommands[args[0]](args) : failCommands[args[0]]
    if (fail) return fail
    if (args[0] === "dispatch-plan") return plan
    if (args[0] === "run") {
      const enhance = (it) => { const k = keyOf(it); return mappings.has(k) ? { ...it, registered: true, mappedAgentId: mappings.get(k) } : it }
      if (plan?.stop === "wait-inflight") return { ...plan, transition: "wait-inflight", status: "working", inflight: (plan.inflight ?? []).map(enhance) }
      return { ok: true, task: plan?.task ?? "demo-t", stage: plan?.stage ?? "implementation", status: "working", transition: "wait-inflight", inflight: waveItems().map((it) => enhance({ ...it, registered: mappings.has(keyOf(it)) })) }
    }
    if (args[0] === "agent-map") {
      const key = args[4], agent = args[6]
      const old = mappings.get(key)
      if (old && old !== agent) return { ok: false, code: "AGENT_MAP_CONFLICT", status: "conflict", agentId: old }
      const idempotent = old === agent
      mappings.set(key, agent)
      return { ok: true, status: "active", agentId: agent, idempotent }
    }
    throw new Error("unexpected command: " + args[0])
  }
  return { runTw, calls, mappings }
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
        const childId = spec.childId ?? spec.request?.childId ?? "gen-" + (++msgSeq)
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
        flush: async (session) => { persist(session); return true },
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
    if (["incremental", "full", "reminder", "inflight-reminder"].includes(mode)) h.injectCold("prior-example", { received: mode === "incremental" ? "# 派单（key: d0-old）\n\n旧轮正文" : ["reminder", "inflight-reminder"].includes(mode) ? wave.promptFull : null })
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
  h.ctx.sessions.get = (id) => h.liveIds().includes(id) ? { header: { id, parentSession: EXEC.agent.id } } : undefined
  await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(h.started.length, 1)
  assert.equal(h.followups.length, 1)
  const stop = { ok: true, stop: "awaiting-user", card: { status: "awaiting-user", presentation: { requiredGuidance: "公共与专项" } } }
  const waiting = twDispatchDefinition(h.ctx, { runTw: async () => stop })
  assert.deepEqual(await waiting.execute({ task: "demo-t" }, EXEC), stop)
  assert.equal(JSON.parse(waiting.output.render({}, stop)[0].text).card.presentation.requiredGuidance, "公共与专项")
  assert.equal(h.started.length, 1)
  assert.equal(h.followups.length, 1)
})

test("真实 CLI 接缝：成员只收单块冻结正文，Lead 只渲染一次派发短规则", async (t) => {
  const project = await mkdtemp(path.join(os.tmpdir(), "twr-clarity-dispatch-"))
  t.after(() => rm(project, { recursive: true, force: true }))
  // CLI 子进程使用包内默认规则，不读取执行者的用户公共覆盖。
  const homeKey = process.platform === "win32" ? "USERPROFILE" : "HOME"
  const oldHome = process.env[homeKey]
  process.env[homeKey] = project
  t.after(() => {
    if (oldHome === undefined) delete process.env[homeKey]
    else process.env[homeKey] = oldHome
  })
  const snapshot = { entryId: "team-work-dsh", profile: "profile-example", tiers: {
    junior: { provider: "provider-example", model: "model-basic" },
    senior: { provider: "provider-example", model: "model-standard" },
    expert: { provider: "provider-example", model: "model-advanced" },
  } }
  const exec = { agent: { id: EXEC.agent.id, session: { header: { cwd: project } } } }
  const configSnapshot = () => snapshot
  const opened = await twToolDefinition({ configSnapshot }).execute({ args: ["open", "--name", "clarity-seam", "--objective", "审查虚构模块的接口边界", "--entry", "code-review", "--raw-requirement", "完整合成需求"] }, exec)
  assert.equal(opened.ok, true, JSON.stringify(opened))
  const h = makeCtx()
  h.ctx.skills = { register() { return () => {} }, get() { assert.fail("禁止主动调用技能") } }
  // 不替换 runTw/createDirectedSubagent；先展示首卡，再用卡 ID 模拟用户确认。
  const tool = twDispatchDefinition(h.ctx, { configSnapshot })
  const first = await tool.execute({ task: "clarity-seam", writables: [{ path: "AUDIT.md", kind: "code-review" }] }, exec)
  assert.equal(first.stop, "awaiting-user")
  const confirmed = await twToolDefinition({ configSnapshot }).execute({ args: ["decide", "--task", "clarity-seam", "--choice", "1", "--decision-id", first.card.decisionId] }, exec)
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed))
  const result = await tool.execute({ task: "clarity-seam" }, exec)
  assert.equal(result.dispatched[0].ok, true, JSON.stringify(result))
  const required = async (resource) => {
    const text = await readFile(new URL(resource, import.meta.url), "utf8")
    return text.split("<!-- clarity:required:begin -->")[1].split("<!-- clarity:required:end -->")[0]
  }
  const publicRules = await required("../skills/clarity-guidance/output-standard.md")
  const reviewRules = await required("../skills/clarity-review/references/review-rules.md")
  const message = h.started[0].request.prompt
  assert.equal(message.length, 1, "成员消息是单块业务正文，不再追加规则块")
  assert.equal(message[0].type, "text")
  assert.match(message[0].text, /^# 派单（key: /)
  assert.match(message[0].text, /任务：clarity-seam；阶段：code-review/)
  assert.equal(message[0].text.includes(publicRules), false, "成员正文不注入明晰公共段")
  assert.equal(message[0].text.includes(reviewRules), false, "成员正文不注入明晰审阅段")
  const dispatchRules = (await readFile(new URL("../team-work/rules/lead/dispatch/index.md", import.meta.url), "utf8")).trim()
  const rendered = tool.output.render({}, result)[0].text
  const card = JSON.parse(rendered)
  const jsonText = (text) => JSON.stringify(text).slice(1, -1)
  assert.equal(card.presentation, dispatchRules, "Lead 只透传包内派发短规则")
  assert.equal(rendered.split(jsonText(dispatchRules)).length - 1, 1, "短规则在最终渲染中只出现一次")
  assert.equal(rendered.includes(jsonText(publicRules)), false, "派发结果不带明晰公共段")
  assert.equal(rendered.includes(jsonText(reviewRules)), false, "派发结果不带明晰审阅段")
  assert.equal("waves" in card, false)
  assert.equal(rendered.includes(jsonText(message[0].text)), false, "成员冻结正文不在 Lead 渲染中复述")
  t.diagnostic("真实 CLI 子进程到成员创建参数：单块业务正文 " + message[0].text.length + " 字符；Lead 只渲染派发短规则，未调用技能或真实模型。")
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
  const wave = ownerWave()
  const plan = planCard([wave])
  const { runTw, calls } = makeRunTw(plan)
  const { tool, started } = makeTool({ runTw })
  const out = await tool.execute({ task: "demo-t", note: "接口改造", writables: [{ path: "src/", kind: "source" }] }, EXEC)

  assert.deepEqual(calls[0].args, ["dispatch-plan", "--task", "demo-t", "--json", "--writable", "src/:source"])
  assert.equal(calls[0].cwd, EXEC_ROOT)
  const fixedId = deterministicSessionId("demo-t", "d1-abc123")
  const mapCall = calls.find((call) => call.cmd === "agent-map")
  assert.deepEqual(mapCall.args, ["agent-map", "--task", "demo-t", "--key", "d1-abc123", "--agent", fixedId])
  assert.equal(started.length, 1)
  const spec = started[0]
  assert.equal(spec.childId, fixedId, "确定性 sessionId：同 key 重试推导同一 id（防双发基石）")
  assert.equal(spec.label, "IMPL·owner · 接口改造 #demo-t", "标签按派单事实 + note 自动拼接")
  assert.equal(spec.request.prompt[0].text, wave.prompt, "冻结正文原样转发")
  assert.deepEqual(spec.request.agentOptions, { provider: "p-a", model: "m-j1" }, "target 直取 modelRef（effort 走直接选择）")

  assert.deepEqual(out, {
    ok: true,
    task: "demo-t",
    stage: "implementation",
    stop: null,
    nextAction: "wait-children",
    dispatched: [{
      ok: true,
      key: "d1-abc123",
      label: "IMPL·owner · 接口改造 #demo-t",
      waveId: "wv1",
      sessionId: fixedId,
      registered: true,
      accepted: true,
      receiptVerified: true,
      action: "wait",
      messageId: "m-1",
      provider: "p-a",
      model: "m-j1",
      message: "已核实宿主收单（仅证明收单，不保证活动或通知可达），等待成员完成通知。",
    }],
  })
})

test("modelRef 带 effort 时 target 透传 effort，创建核心验证后生效", async () => {
  const plan = planCard([ownerWave({ modelRef: { provider: "p-c", modelName: "m-e1", effort: "high" } })])
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

test("多包波：两张派单逐张串行「登记→重验→创建」，结果逐项返回", async () => {
  const wave1 = ownerWave({ dispatchKey: "d1-p1", package: "store" })
  const wave2 = ownerWave({ dispatchKey: "d2-p2", waveId: "wv1", package: "intake", modelRef: { provider: "p-b", modelName: "m-j2" } })
  const order = []
  const { runTw, calls } = makeRunTw(planCard([wave1, wave2]), {
    onCall: (cmd, args) => order.push("cli:" + cmd + (cmd === "agent-map" ? ":" + args[4] : "")),
  })
  const { tool, ctx, started } = makeTool({ runTw })
  const origStart = ctx.subagents.startContinuable
  ctx.subagents.startContinuable = async (spec) => {
    order.push("create:" + spec.childId)
    return origStart(spec)
  }
  const out = await tool.execute({ task: "demo-t" }, EXEC)

  assert.equal(out.dispatched.length, 2)
  assert.ok(out.dispatched.every((d) => d.ok && d.registered))
  const id1 = deterministicSessionId("demo-t", "d1-p1")
  const id2 = deterministicSessionId("demo-t", "d2-p2")
  assert.deepEqual(
    order,
    [
      "cli:dispatch-plan",
      "cli:run", "cli:agent-map:d1-p1", "cli:run", "cli:agent-map:d1-p1",
      "create:" + id1,
      "cli:run", "cli:agent-map:d2-p2", "cli:run", "cli:agent-map:d2-p2",
      "create:" + id2,
    ],
    "逐张串行：每张先登记、锁内重验、再创建（先登记后创建）"
  )
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 4)
  assert.deepEqual(out.dispatched.map((d) => d.sessionId), [id1, id2])
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
  assert.equal(bad.code, "USAGE", "登记失败回执保留 CLI 原始错误码")
  assert.match(bad.message, /保留原会话与映射，核对后重试/)
  assert.equal(bad.sessionId, deterministicSessionId("demo-t", "d2-mapfail"), "回执带确定性 sessionId 便于对账（未创建子会话）")
  assert.equal(started.length, 1, "仅成功那张派单创建了子会话")
  assert.equal(drained.length, 0, "登记失败不触发回收语义")
  assert.match(bad.message, /key d2-mapfail 不是本任务的派单 key/)
  assert.match(bad.message, /保留原会话与映射，核对后重试/)
})

test("创建失败：模型验证失败不留子会话（映射已登记，确定性对账使重试幂等）；继续处理后续派单", async () => {
  const plan = planCard([ownerWave({ dispatchKey: "d1-bad", modelRef: { provider: "p-x", modelName: "gone" } }), ownerWave({ dispatchKey: "d2-next" })])
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
  assert.match(out.dispatched[0].message, /保留原映射，检查同 ID/)
  assert.equal(out.dispatched[0].sessionId, deterministicSessionId("demo-t", "d1-bad"), "回执带确定性 sessionId（已登记未创建）")
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 4, "两张派单都先登记（登记在验证之前）")
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
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 2, "登记已发生（先登记后创建）")
  assert.match(out.dispatched[0].message, /保留原映射/)
})

test("创建已接收：flush 未确认保留成员，重试先对账同 ID", async () => {
  const { ctx } = makeCtx()
  ctx.sessions.flush = async () => false
  const { runTw, calls } = makeRunTw(planCard([ownerWave()]))
  const tool = twDispatchDefinition(ctx, { runTw })
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(out.dispatched[0].code, "TW_SUB_NOT_PERSISTED")
  assert.match(out.dispatched[0].message, /初始消息已接收但持久化尚未确认/)
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 2, "登记已发生（先登记后创建）")
  assert.match(out.dispatched[0].message, /请检查同 ID 的现状/)
})

test("continuation 且有 expectedAgentId（会话在场已收本轮）：统一等待不重投（用户终裁②），登记本轮映射，不创建不重投", async () => {
  const wave = ownerWave({ dispatchKey: "d5-cont", waveId: "wv3", kind: "respond", round: 2, continuation: true, expectedAgentId: "child-uuid-7", prompt: "本轮增量派单正文" })
  const { runTw, calls } = makeRunTw(planCard([wave]))
  const { tool, started, followups, injectLive } = makeTool({ runTw })
  injectLive("child-uuid-7", { received: wave.prompt }) // 活会话已收本轮正文（任务进行中）
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(started.length, 0, "续派不经创建")
  assert.equal(followups.length, 0, "活会话统一等待：重入恒等待永不重投（防成员重复执行整轮工作）")
  const item = out.dispatched[0]
  assert.equal(item.ok, true)
  assert.equal(item.action, "wait")
  assert.equal(item.sessionId, "child-uuid-7", "续派沿用原会话 ID（不创建不重投）")
  assert.ok(calls.filter((c) => c.cmd === "agent-map").length >= 1, "同父续派登记本轮 key→原会话")
  assert.match(item.message, /等待成员完成通知/)

  const again = await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(again.dispatched[0].action, "wait")
  assert.equal(followups.length, 0)
})

test("continuation 活会话未见本轮正文且无活动证明：不投递不创建，按需人工核对（不再默认等待）", async () => {
  const wave = ownerWave({ dispatchKey: "d5b-cont", waveId: "wv3", kind: "respond", round: 2, continuation: true, expectedAgentId: "shell-child", prompt: "本轮增量派单正文", promptFull: "全量变体：目标+约束+排除内嵌" })
  const { runTw } = makeRunTw(planCard([wave]))
  const { tool, started, followups, injectLive } = makeTool({ runTw })
  injectLive("shell-child", { received: null }) // 空壳/未收本轮：无法证明旧轮活动与通知
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(started.length, 0)
  assert.equal(followups.length, 0, "活会话不重投正文（用户终裁②）")
  const item = out.dispatched[0]
  assert.equal(item.ok, false)
  assert.equal(item.code, "TW_SUB_ACTIVITY_UNVERIFIED")
  assert.equal(out.nextAction, "recover")
  assert.match(item.message, /未补投/)
})

test("活会话未见本轮正文但有可靠旧轮活动与通知标记时只等待旧轮（wait-prior-turn）", async () => {
  const wave = ownerWave({ dispatchKey: "d5b2-cont", waveId: "wv3", kind: "respond", round: 2, continuation: true, expectedAgentId: "busy-child", prompt: "本轮增量派单正文" })
  const { runTw } = makeRunTw(planCard([wave]))
  const { tool, started, followups, injectLive } = makeTool({ runTw })
  const session = injectLive("busy-child", { received: "# 派单（key: d0-old）\n\n上一轮正文" })
  session.turnActive = true
  session.notificationReachable = true
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(out.nextAction, "wait-prior-turn")
  assert.equal(out.stop, "wait-inflight")
  assert.equal(started.length + followups.length, 0)
  const item = out.dispatched[0]
  assert.equal(item.ok, true)
  assert.equal(item.action, "wait-prior-turn")
  assert.equal(item.receiptVerified, false)
  assert.equal(item.priorActivityConfirmed, true)
  assert.equal(item.notificationConfirmed, true)
})

test("continuation 冷持久（归属一致）：判收单定增量或全量（用户终裁②冷唤醒语义）", async () => {
  const waveA = ownerWave({ dispatchKey: "d5c-cont", waveId: "wv3", kind: "respond", round: 2, continuation: true, expectedAgentId: "cold-prior-1", prompt: "本轮增量派单正文", promptFull: "全量变体：目标+约束+排除内嵌" })
  const ra = makeRunTw(planCard([waveA]))
  const ta = makeTool({ runTw: ra.runTw })
  ta.injectCold("cold-prior-1", { received: "# 派单（key: d0-old）\n\n上一轮派单正文" })
  const outA = await ta.tool.execute({ task: "demo-t" }, EXEC)
  const itemA = outA.dispatched[0]
  assert.equal(itemA.ok, true)
  assert.equal(itemA.action, "followup")
  assert.equal(itemA.resume, "incremental")
  assert.equal(ta.started.length, 0, "冷唤醒走 followup 不经创建")
  assert.equal(ta.followups.length, 1)
  assert.equal(ta.followups[0].text, waveA.prompt, "曾收单=有原上下文：投增量变体")

  const waveB = ownerWave({ dispatchKey: "d5d-cont", waveId: "wv3", kind: "respond", round: 2, continuation: true, expectedAgentId: "cold-prior-2", prompt: "本轮增量派单正文", promptFull: "全量变体：目标+约束+排除内嵌" })
  const rb = makeRunTw(planCard([waveB]))
  const tb = makeTool({ runTw: rb.runTw })
  tb.injectCold("cold-prior-2", { received: null })
  const outB = await tb.tool.execute({ task: "demo-t" }, EXEC)
  const itemB = outB.dispatched[0]
  assert.equal(itemB.ok, true)
  assert.equal(itemB.action, "followup")
  assert.equal(itemB.resume, "full")
  assert.equal(tb.followups[0].text, waveB.promptFull, "从未收单无上下文：投全量变体")
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
  assert.match(item.message, /归属其他父会话/)
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
  assert.equal(started[0].request.prompt[0].text, wave.promptFull, "重建会话无原上下文：投全量变体")
  const mapCall = calls.find((call) => call.cmd === "agent-map")
  assert.deepEqual(mapCall.args, ["agent-map", "--task", "demo-t", "--key", "d7-cont", "--agent", deterministicSessionId("demo-t", "d7-cont")])
})

test("continuation 但映射缺失（expectedAgentIdMissing）：拒绝投递并要求核对，不猜补建", async () => {
  const wave = ownerWave({ dispatchKey: "d6-fresh", kind: "respond", round: 2, continuation: true, expectedAgentIdMissing: true })
  const { runTw, calls } = makeRunTw(planCard([wave]))
  const { tool, started } = makeTool({ runTw })
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  const item = out.dispatched[0]
  assert.equal(item.ok, false)
  assert.equal(item.code, "TW_DISPATCH_EXPECTED_AGENT_MISSING")
  assert.match(item.message, /不得据此推定断链或新建/)
  assert.equal(started.length, 0)
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 0)
})

function inflightCard(items, extra = {}) {
  return { ok: true, task: "demo-t", stage: "implementation", stop: "wait-inflight", waves: [], dispatchKey: items[0]?.key ?? "d1-x", inflight: items, card: { status: "wait-inflight" }, ...extra }
}
function inflightItem(overrides = {}) {
  const key = overrides.key ?? "d1-abc123"
  const continuation = overrides.continuation ?? false
  const prompt = withKeyHeader(overrides.prompt ?? "原派单全文", key, continuation ? "续派" : "派单", continuation ? "——你在原上下文基础上继续" : "")
  const base = {
    key, waveId: "wv1", role: "owner", tier: "junior", round: 1, kind: "produce", continuation: false,
    modelRef: { provider: "p-a", modelName: "m-j1" }, registered: false,
    ...overrides,
    prompt,
    promptFrozen: true,
    promptDigest: sha(prompt),
  }
  if (base.continuation || base.promptFull !== undefined) {
    base.promptFull = withKeyHeader(base.promptFull ?? "全量派单正文：目标+约束+排除", key, "续派全量变体", "——原会话上下文不可用时的自足派单")
    base.promptFullDigest = sha(base.promptFull)
  }
  return base
}

test("兜底·registered 字段非布尔（agents.json 损坏）：拒绝投递并给核对指引", async () => {
  const item = inflightItem({ registered: undefined, registeredUnresolved: "文件损坏（非 JSON）：agents.json" })
  const { runTw, calls } = makeRunTw(inflightCard([item]))
  const { tool, started } = makeTool({ runTw })
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(out.stop, "wait-inflight")
  assert.equal(started.length, 0, "判定事实不可得时不自动创建")
  const entry = out.inflight[0]
  assert.equal(entry.ok, false)
  assert.equal(entry.code, "TW_DISPATCH_REGISTERED_UNKNOWN")
  assert.match(entry.message, /映射状态缺失或账本损坏/)
  assert.equal(entry.reason, "文件损坏（非 JSON）：agents.json")
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

test("兜底·优先级：registered=true 且会话在场已收本轮 → 判定链等待，优先于续派分支", async () => {
  const item = inflightItem({ continuation: true, expectedAgentId: "child-old", registered: true, mappedAgentId: "mapped-child-1" })
  const { runTw } = makeRunTw(inflightCard([item]))
  const { tool, started, followups, injectLive } = makeTool({ runTw })
  injectLive("mapped-child-1", { received: item.prompt }) // 活会话已收本轮（任务进行中）
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(started.length, 0, "已登记且会话在场不创建")
  assert.equal(followups.length, 0, "活会话统一等待不投递（判定链保证不重复投递）")
  const entry = out.inflight[0]
  assert.equal(entry.ok, true)
  assert.equal(entry.registered, true)
  assert.equal(entry.sessionId, "mapped-child-1")
  assert.equal(entry.action, "wait")
  assert.equal(entry.reused, true)
  assert.match(entry.message, /等待成员完成通知/)
})

test("兜底·registered=true 但会话不存在（登记与创建间崩溃窗口）→ 同 id 重建，不双发", async () => {
  const item = inflightItem({ registered: true, mappedAgentId: "mapped-child-2" })
  const { runTw } = makeRunTw(inflightCard([item]))
  const { tool, started } = makeTool({ runTw })
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  const entry = out.inflight[0]
  assert.equal(entry.ok, true)
  assert.equal(entry.action, "recreated")
  assert.equal(entry.sessionId, "mapped-child-2", "同 id 重建（判定链 none → 正常创建路径）")
  assert.equal(entry.receiptVerified, true, "重建后核实宿主收单")
  assert.equal(started.length, 1)
  assert.equal(started[0].childId, "mapped-child-2")
})

test("兜底·registered=true 且会话在场空壳（未见本轮正文）：不补发不重建，转人工核对", async () => {
  const item = inflightItem({ registered: true, mappedAgentId: "mapped-child-3" })
  const { runTw } = makeRunTw(inflightCard([item]))
  const { tool, started, drained, followups, injectLive } = makeTool({ runTw })
  injectLive("mapped-child-3", { received: null }) // 防御性形态：活壳（经宿主回滚实际不存在）
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  const entry = out.inflight[0]
  assert.equal(entry.ok, false)
  assert.equal(entry.code, "TW_SUB_ACTIVITY_UNVERIFIED")
  assert.deepEqual(drained, [], "废弃声明：empty→drain→同 id 重建路径已删除")
  assert.equal(started.length, 0, "活会话不创建")
  assert.equal(followups.length, 0, "活会话不读事件流不投递（活壳补发分支已删除）")
  assert.equal(out.nextAction, "recover")
})

test("兜底·registered=true 且会话为冷持久（归属一致、曾收单）→ 冷唤醒投本轮增量变体", async () => {
  const item = inflightItem({ registered: true, mappedAgentId: "mapped-cold-1" })
  const { runTw } = makeRunTw(inflightCard([item]))
  const { tool, started, followups, injectCold, liveIds } = makeTool({ runTw })
  injectCold("mapped-cold-1", { received: "# 派单（key: d0-old）\n\n原派单正文" }) // 冷持久归属一致且曾收单（有上一轮上下文）
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  const entry = out.inflight[0]
  assert.equal(entry.ok, true)
  assert.equal(entry.action, "followup")
  assert.equal(entry.resume, "incremental", "曾收单冷会话：投本轮增量变体（用户终裁②冷唤醒语义）")
  assert.equal(started.length, 0, "冷唤醒走 followup，不经创建")
  assert.equal(followups.length, 1)
  assert.equal(followups[0].text, item.prompt, "冷会话不在执行（本轮派单必未投过）：投本轮正文")
  assert.deepEqual(liveIds(), ["mapped-cold-1"], "冷唤醒物化会话（转活）")
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
  assert.equal(followups[0].text, item.promptFull, "从未收单冷会话：投全量变体（增量不可执行）")
})

test("兜底·registered=true 且冷持久异主（接管冲突）：不 followup 不重建，交由原 Lead 核对", async () => {
  const item = inflightItem({ registered: true, mappedAgentId: "mapped-foreign" })
  const { runTw, calls } = makeRunTw(inflightCard([item]))
  const { tool, started, followups, injectCold } = makeTool({ runTw })
  injectCold("mapped-foreign", { received: "原派单正文", parentSession: "another-lead" }) // 归属其他父会话
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  const entry = out.inflight[0]
  assert.equal(entry.ok, false)
  assert.equal(entry.code, "TW_SUB_TAKEOVER_CONFLICT")
  assert.match(entry.message, /归属其他父会话/)
  assert.equal(started.length, 0, "接管冲突不重建（同 ID 重建必被宿主判重拒绝）")
  assert.equal(followups.length, 0, "接管冲突不 followup（冷唤醒鉴权必被拒绝）")
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 1, "已登记项先经锁内映射重验（reported/作废短路），再发现异主")
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
  assert.equal(started[0].request.prompt[0].text, item.promptFull, "新会话无原上下文：重建投全量变体（§9.3 验收基线）")
  assert.equal(followups.length, 0)
})

test("兜底·分支 2 二阶窗口（续派·活壳形态）：registered=true 且 continuation → 不可证明活动时转人工", async () => {
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
  assert.equal(entry.ok, false)
  assert.equal(entry.code, "TW_SUB_ACTIVITY_UNVERIFIED", "活会话未收本轮且无活动证明：不投递不重建")
  assert.equal(started.length, 0)
  assert.equal(followups.length, 0, "不读事件流不投递")
  assert.equal(out.nextAction, "recover")
})

test("兜底·分支 2 二阶窗口（续派·活会话等待不受影响）：已收本轮的等待路径不投任何正文", async () => {
  const item = inflightItem({
    registered: true, mappedAgentId: "mapped-wait-2",
    continuation: true, expectedAgentId: "prior-agent-live",
    prompt: "续派增量派单正文", promptFull: "续派全量变体：目标+约束+排除内嵌",
  })
  const { runTw } = makeRunTw(inflightCard([item]))
  const { tool, started, followups, injectLive } = makeTool({ runTw })
  injectLive("mapped-wait-2", { received: item.prompt }) // 活会话已收本轮：等待，不投正文
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  const entry = out.inflight[0]
  assert.equal(entry.ok, true)
  assert.equal(entry.action, "wait")
  assert.equal(entry.reused, true)
  assert.equal(started.length, 0)
  assert.equal(followups.length, 0, "活会话统一等待（全量/增量都不投，重入恒等待）")
})

test("兜底·续派：registered=false 且 expectedAgentId 在场已收本轮 → 统一等待不重投，登记本轮映射，不创建不重投", async () => {
  const item = inflightItem({ continuation: true, expectedAgentId: "child-uuid-7", registered: false, prompt: "本轮增量派单正文" })
  const { runTw, calls } = makeRunTw(inflightCard([item]))
  const { tool, started, followups, injectLive } = makeTool({ runTw })
  injectLive("child-uuid-7", { received: item.prompt })
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(started.length, 0)
  assert.equal(followups.length, 0, "活会话统一等待：永不重投（用户终裁②）")
  const entry = out.inflight[0]
  assert.equal(entry.action, "wait")
  assert.equal(entry.sessionId, "child-uuid-7", "续派沿用原会话 ID")
  assert.match(entry.message, /等待成员完成通知/)
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 1)
})

test("兜底·自动补派：registered=false 非续派 → 登记确定性 sessionId + 创建并核实收单", async () => {
  const item = inflightItem()
  const order = []
  const { runTw, calls } = makeRunTw(inflightCard([item]), { onCall: (cmd) => order.push(cmd) })
  const { tool, started } = makeTool({ runTw })
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(started.length, 1, "崩溃窗口的未登记派单自动补派")
  assert.equal(started[0].request?.prompt?.[0]?.text, item.prompt, "补派转发冻结的原派单正文")
  const fixedId = deterministicSessionId("demo-t", "d1-abc123")
  assert.equal(started[0].childId, fixedId, "补派用确定性 sessionId")
  assert.deepEqual(order, ["dispatch-plan", "run", "agent-map", "run", "agent-map"], "先登记后创建：agent-map 在创建完成前调用（创建经创建核心同步完成）")
  const entry = out.inflight[0]
  assert.equal(entry.ok, true)
  assert.equal(entry.registered, true)
  assert.equal(entry.sessionId, fixedId)
  assert.equal(entry.action, "wait")
  assert.equal(entry.receiptVerified, true, "创建后核实宿主收单（仅证明收单）")
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 2, "补派自动登记（登记 + 锁内重验）")
})

test("兜底·登记失败回执：登记失败发生在创建之前 → 未创建子会话，原样重试安全不双发", async () => {
  const item = inflightItem()
  const failMap = { ok: false, code: "USAGE", message: "key 不合法" }
  const { runTw } = makeRunTw(inflightCard([item]), { failCommands: { "agent-map": failMap } })
  const { tool, started } = makeTool({ runTw })
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(started.length, 0, "登记失败未创建（先登记后创建）")
  const entry = out.inflight[0]
  assert.equal(entry.ok, false)
  assert.equal(entry.code, "USAGE", "登记失败回执保留 CLI 原始错误码")
  assert.equal(entry.sessionId, deterministicSessionId("demo-t", "d1-abc123"), "回执带确定性 sessionId 便于对账")
  assert.match(entry.message, /key 不合法/)
  assert.equal(out.failures, 1)
})

test("兜底·modelRef 不可解析：无会话需重建但无 target → 不登记不创建，修复后重试", async () => {
  const item = inflightItem({ modelRefUnresolved: true })
  delete item.modelRef
  const { runTw, calls } = makeRunTw(inflightCard([item]))
  const { tool, started, followups } = makeTool({ runTw })
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(started.length, 0, "无 target 不创建")
  assert.equal(followups.length, 0)
  const entry = out.inflight[0]
  assert.equal(entry.ok, false)
  assert.equal(entry.code, "TW_DISPATCH_MODEL_REF_UNRESOLVED")
  assert.match(entry.message, /无法验证派单的精确模型/)
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 0, "模型无法解析时登记前置检查即拒绝")
})

test("兜底·多条目逐条独立判定：等待/补派混排互不影响，各按自身事实处置", async () => {
  const waiting = inflightItem({ key: "d2-aaa", waveId: "wv2", registered: true, mappedAgentId: "mapped-wait-1" })
  const recover = inflightItem({ key: "d3-bbb", waveId: "wv3", modelRef: { provider: "p-b", modelName: "m-x" } })
  const { runTw, calls } = makeRunTw(inflightCard([waiting, recover]))
  const { tool, started, injectLive } = makeTool({ runTw })
  injectLive("mapped-wait-1", { received: waiting.prompt })
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(started.length, 1, "仅未登记条目补派")
  assert.equal(started[0].childId, deterministicSessionId("demo-t", "d3-bbb"))
  assert.equal(out.inflight[0].action, "wait")
  assert.equal(out.inflight[0].reused, true)
  assert.equal(out.inflight[1].action, "wait")
  assert.equal(out.inflight[1].key, "d3-bbb")
  assert.equal(out.failures, undefined, "全部成功无 failures 计数")
  assert.equal(out.note, undefined, "健康批次不带恢复注记")
})

test("兜底·续派断链：expectedAgentId 会话不存在 → 自动 fresh 重建（登记回填 key 映射），不再指向幽灵会话", async () => {
  const item = inflightItem({ key: "d4-cont", waveId: "wv4", kind: "respond", round: 2, continuation: true, expectedAgentId: "ghost-child", registered: false, modelRef: { provider: "p-a", modelName: "m-s1" } })
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
  const mapCall = calls.find((call) => call.cmd === "agent-map")
  assert.deepEqual(mapCall.args, ["agent-map", "--task", "demo-t", "--key", "d4-cont", "--agent", deterministicSessionId("demo-t", "d4-cont")], "key 映射回填新 childId")
})

test("兜底·续派断链且 modelRef 不可解析：不重建不登记，修复配置后重试", async () => {
  const item = inflightItem({ key: "d5-cont", waveId: "wv5", kind: "respond", round: 2, continuation: true, expectedAgentId: "ghost-child", registered: false, modelRefUnresolved: true })
  delete item.modelRef
  const { runTw, calls } = makeRunTw(inflightCard([item]))
  const { tool, started, followups } = makeTool({ runTw })
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  const entry = out.inflight[0]
  assert.equal(entry.ok, false)
  assert.equal(entry.code, "TW_DISPATCH_MODEL_REF_UNRESOLVED")
  assert.equal(entry.sessionId, deterministicSessionId("demo-t", "d5-cont"), "断链重建先切换确定性 ID，模型校验失败时保留该 ID 供对账")
  assert.match(entry.message, /无法验证派单的精确模型/)
  assert.equal(started.length, 0)
  assert.equal(followups.length, 0)
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 0)
})

test("派单 prompt 缺失（runtime 投影缺陷）：拒绝登记与创建，零副作用", async () => {
  const item = inflightItem({ prompt: "" })
  const { runTw, calls } = makeRunTw(inflightCard([item]))
  const { tool, started } = makeTool({ runTw })
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  const entry = out.inflight[0]
  assert.equal(entry.ok, false)
  assert.equal(entry.code, "TW_DISPATCH_PROMPT_UNVERIFIED")
  assert.match(entry.message, /冻结摘要不符/)
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
  assert.equal(entry.code, "TW_DISPATCH_PROMPT_UNVERIFIED")
  assert.match(entry.message, /冻结摘要不符/)
  assert.equal(started.length, 0, "不静默置空串创建")
  assert.equal(followups.length, 0)
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 1, "已登记项只做锁内只读重验（idempotent），冻结检查失败后零副作用")
})

test("分工文案同源：普通委派走原生工具，正式成员走 tw-dispatch", () => {
  const table = decisionTableText()
  assert.match(table, /正式波次由 Lead 用 tw-dispatch/, "正式组团由 Lead 承担")
  assert.match(table, /Lead 问询、纠偏和叫停不受影响/)
  assert.match(table, /不主动播报或另发交卷摘要/)
  assert.match(table, /成员内部只读助手：原生 subagent/)
  assert.match(table, /限定小问题.*不得继续委托/, "成员仍可开有范围的辅助，不能递归招募")
  assert.match(table, /list_subagent_models.*精确查询/)

  assert.ok(twDispatchToolDescription().includes(table), "tw-dispatch 工具说明含同表")
  assert.ok(systemPromptSection({}, {}).text().includes(table), "systemPrompt section 含同表")

  const dispatchDef = twDispatchDefinition({}, {})
  assert.equal(dispatchDef.description, twDispatchToolDescription())
})

test("派发文案与收单口径：工具描述指向宿主收单、旧轮等待与 sleep 确认引导", () => {
  const description = twDispatchToolDescription()
  assert.match(description, /同父会话收单/)
  assert.match(description, /sleep 首次会有确认引导/)
  assert.doesNotMatch(description, /自动收束当前回合/)
  const nextActionText = TW_DISPATCH_OUTPUT_SCHEMA.properties.nextAction.description
  assert.match(nextActionText, /已核实本轮收单/)
  assert.doesNotMatch(nextActionText, /本回合自动收束/)
})

test("工具定义形态：名称/并发安全/参数面只收语义（key、modelRef、标签均不向模型索要）", () => {
  const def = twDispatchDefinition({}, {})
  assert.equal(def.name, TOOL_NAME)
  assert.equal(def.name, "tw-dispatch")
  assert.equal(typeof def.timeoutMs, "number")
  assert.equal(def.isConcurrencySafe(), false, "§7.3.3 并发保守：同任务连点排队串行，防补派双发")
  assert.deepEqual(Object.keys(def.parameters.properties), ["task", "note", "userDirection", "writables"])
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
    assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 2)
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
    if (mode === "cold-followup") h.injectCold("cold-c1", { received: "# 派单（key: d0-old）\n\n旧轮正文" })
    const plan = mode === "wait-inflight-healthy"
      ? inflightCard([inflightItem({ registered: true, mappedAgentId: "live-inflight-1" })])
      : planCard([wave])
    if (mode === "wait-inflight-healthy") h.injectLive("live-inflight-1", { received: plan.inflight[0].prompt })
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

  // 3. 部分失败、wait-inflight 登记不可判定、flush 持久化未确认 → 不记录派发世代且 nextAction=recover
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
    assert.equal(concluded, 0, "登记不可判定不得收束回合")
    assert.equal(sleepConfirm.notes.length, 0, "登记不可判定不得记录派发世代")
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
  const dispatchTool = twDispatchDefinition(ctx, { runTw, sleepConfirm })
  registered.set("tw-dispatch", dispatchTool)
  const invokeViaHook = (exec, body) => listeners.get("tools/execute")(exec, body)
  const emitSessionEvent = (id, type) => listeners.get("session/event")({ id }, { type })
  let bashExecCount = 0
  let runCodeExecCount = 0
  let seq = 0
  const runBash = async (agent, command, extra = {}) => {
    const contexts = []
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
    const leadAgent = { id: "parent-agent-1", phase: { kind: "running", turn: 1, step: 1 }, session: { header: { cwd: EXEC_ROOT } } }
    const childAgent = { id: "child-agent-1", phase: { kind: "running", turn: 1, step: 1 }, session: { header: { cwd: "/proj" } } }
    const parentToken = Symbol("ptc-run-1")

    let outerConcluded = 0
    const dispatchExec = { name: "tw-dispatch", callId: "rc-1:ptc:1", rootCallId: "rc-1", parent: parentToken, agent: leadAgent, concludeTurn() { outerConcluded++ } }
    const dispatchRes = await invokeViaHook(dispatchExec, () => dispatchTool.execute({ task: "demo-t" }, dispatchExec))
    assert.equal(dispatchRes.nextAction, "wait-children")
    assert.equal(outerConcluded, 0, "派发后不再收束回合")

    const first = await runBash(leadAgent, "sleep 30", { callId: "rc-1:ptc:2", rootCallId: "rc-1", parent: parentToken })
    assert.equal(first.executed, 0, "首次命中的等待不执行")
    assert.equal(first.result.isError, false)
    assert.equal(first.result.value.stopped, SLEEP_CONFIRM_STOP)
    assert.equal(first.result.value.cwd, EXEC_ROOT)
    assert.equal(first.contexts.length, 1, "嵌套调用的引导不依赖程序转印：deferContext 独立递达")
    assert.equal(first.contexts[0].role, "user")
    assert.equal(first.contexts[0].source.kind, "sleep-confirm")
    assert.match(first.contexts[0].content[0].text, /TWR_SLEEP_CONFIRM/)
    assert.match(first.contexts[0].content[0].text, /1 分钟前刚派发了任务 demo-t 的波次/, "首行追加近期派发提示")

    const second = await runBash(leadAgent, "sleep 30", { callId: "rc-2", rootCallId: "rc-2", parent: Symbol("ptc-run-2") })
    assert.equal(second.executed, 0)
    assert.equal(second.result.value.stopped, SLEEP_CONFIRM_STOP)
    assert.match(second.contexts[0].content[0].text, /本回合已引导过/)

    const plain = await runBash(leadAgent, "echo hello")
    assert.equal(plain.executed, 1, "非等待的 bash 正常执行")
    const runCodeResult = await invokeViaHook({ name: "run_code", callId: "rc-3", rootCallId: "rc-3", agent: leadAgent }, async () => {
      runCodeExecCount++
      return { isError: false, value: { logs: [], result: "ok" } }
    })
    assert.equal(runCodeExecCount, 1, "run_code 正常执行")
    assert.equal(runCodeResult.value.result, "ok")
    const beforeTaskB = calls.length
    const taskBExec = { name: "tw-dispatch", callId: "rc-3b", rootCallId: "rc-3b", agent: leadAgent }
    const taskB = await invokeViaHook(taskBExec, () => dispatchTool.execute({ task: "demo-t" }, taskBExec))
    assert.equal(calls.length - beforeTaskB, 4, "同回合再派发正常走判定链（dispatch-plan + 锁内重验），无屏障短路")
    assert.equal(taskB.nextAction, "wait-children")
    assert.equal(taskB.dispatched[0].reused, true, "同 key 由判定链收敛为纯重入等待（reused），不是屏障短路卡")

    const interleaved = await invokeViaHook({ name: "tw", callId: "rc-3c", rootCallId: "rc-3c", agent: leadAgent }, async () => ({ isError: false, value: { ok: true } }))
    assert.equal(interleaved.isError, false)

    const childFirst = await runBash(childAgent, "sleep 30", { callId: "child-rc-1:ptc:1", rootCallId: "child-rc-1", parent: Symbol("child-ptc") })
    assert.equal(childFirst.executed, 0, "子代理的等待同样被引导")
    childAgent.phase = { kind: "running", turn: 1, step: 2 }
    const childSecond = await runBash(childAgent, "sleep 30", { callId: "child-rc-2:ptc:1", rootCallId: "child-rc-2" })
    assert.equal(childSecond.executed, 1, "子代理更晚 Step 确认放行")

    leadAgent.phase = { kind: "running", turn: 1, step: 2 }
    const confirmed = await runBash(leadAgent, "sleep 30", { callId: "rc-4", rootCallId: "rc-4" })
    assert.equal(confirmed.executed, 1, "看到引导后的更晚 Step 再次执行即确认放行")
    const rewritten = await runBash(leadAgent, "sleep 90", { callId: "rc-5", rootCallId: "rc-5" })
    assert.equal(rewritten.executed, 1, "确认是回合级一次性，不按命令文本指纹")

    emitSessionEvent("parent-agent-1", "turn/end")
    leadAgent.phase = { kind: "running", turn: 2, step: 1 }
    const newTurn = await runBash(leadAgent, "sleep 30", { callId: "rc-6", rootCallId: "rc-6" })
    assert.equal(newTurn.executed, 0, "新回合重新引导")
    assert.match(newTurn.contexts[0].content[0].text, /请先自判等待是否必要/)
    leadAgent.phase = { kind: "running", turn: 2, step: 2 }
    assert.equal((await runBash(leadAgent, "sleep 30", { callId: "rc-7", rootCallId: "rc-7" })).executed, 1, "新回合的确认放行")

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
    ["while true; do sle" + "ep 5; done", true, "R2"],
    ["until test -f out.txt; do sle" + "ep 0.2; done", true, "R2"],
    ["while true; do date; done", false, null],
    ["for i in 1 2 3; do sle" + "ep 1; done", false, null],
    ["echo start && sle" + "ep 5", true, "R3"],
    ["echo a; sle" + "ep 3", true, "R3"],
    ["echo a\nsle" + "ep 3", true, "R3"],
    ["echo start; sle" + "ep 2", false, null],
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

  const second = await run("sleep 30", { callId: "call-2", rootCallId: "root-2" })
  assert.equal(second.executed, 0)
  assert.equal(second.result.value.stopped, SLEEP_CONFIRM_STOP)
  assert.match(second.contexts[0].content[0].text, /本回合已引导过/)
  const third = await run("sleep 1", { callId: "call-3", rootCallId: "root-3" })
  assert.equal(third.executed, 0)
  assert.match(third.contexts[0].content[0].text, /本回合已引导过/)

  let otherRan = 0
  await guard.aroundExecute({ name: "read", agent, arguments: {} }, async () => { otherRan++; return { isError: false } })
  assert.equal(otherRan, 1, "中间夹其他工具调用完全放行")
  setGuardStep(agent, 1, 3)
  const confirmed = await run("sleep 30", { callId: "call-4", rootCallId: "root-4" })
  assert.equal(confirmed.executed, 1, "更晚 Step 再次执行即确认放行")
  const rewritten = await run("sleep 60", { callId: "call-5", rootCallId: "root-5" })
  assert.equal(rewritten.executed, 1, "确认后命令改写仍放行")

  const { exec: failingExec } = makeGuardExec(agent, "sleep 5", { callId: "call-6", rootCallId: "root-6" })
  let failingRan = 0
  const failing = await guard.aroundExecute(failingExec, async () => { failingRan++; return { isError: true, error: { message: "boom" } } })
  assert.equal(failingRan, 1)
  assert.equal(failing.isError, true)
  const retried = await run("sleep 5", { callId: "call-7", rootCallId: "root-7" })
  assert.equal(retried.executed, 1, "失败重试不回退 confirmed")

  guard.clearTurn("lead-guard")
  setGuardStep(agent, 2, 1)
  const newTurn = await run("sleep 30", { callId: "call-8", rootCallId: "root-8" })
  assert.equal(newTurn.executed, 0, "新回合重新引导")

  setGuardStep(agent, 2, 2)
  guard.noteDispatch({ agent }, { ok: true, task: "task-x", dispatched: [{ ok: true, sessionId: "s-x", action: "wait" }] })
  const afterDispatch = await run("sleep 30", { callId: "call-9", rootCallId: "root-9" })
  assert.equal(afterDispatch.executed, 0, "新派发后的等待重新首次拦截")
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

  guard.noteDispatch({ agent }, { ok: true, task: "task-a", dispatched: [{ ok: true, sessionId: "s1", action: "wait" }] })
  const first = await run("sleep 10")
  assert.equal(first.executed, 0)
  assert.match(first.contexts[0].content[0].text, /本会话 1 分钟前刚派发了任务 task-a 的波次/)
  setGuardStep(agent, 1, 2)
  assert.equal((await run("sleep 10")).executed, 1, "更晚 Step 确认放行")

  const reusedNote = guard.noteDispatch({ agent }, { ok: true, task: "task-a", dispatched: [{ ok: true, sessionId: "s1", reused: true, action: "wait" }] })
  assert.equal(reusedNote, null, "纯重入 reused 不记录派发世代")
  setGuardStep(agent, 1, 3)
  assert.equal((await run("sleep 10")).executed, 1, "reused 重入后已确认状态保持")

  for (const toolName of NATIVE_DELEGATION_TOOLS) {
    const delegated = { isError: false, value: { subagentId: "child-" + toolName } }
    assert.equal(await guard.aroundExecute({ name: toolName, agent }, async () => delegated), delegated, toolName + " 委派结果透传")
    setGuardStep(agent, 1, agent.phase.step + 1)
    assert.equal((await run("sleep 10")).executed, 0, toolName + " 成功委派后等待重新引导")
    setGuardStep(agent, 1, agent.phase.step + 1)
    assert.equal((await run("sleep 10")).executed, 1, toolName + " 之后再次确认放行")
  }

  const failedDelegation = { isError: true, error: { message: "not allowed" } }
  assert.equal(await guard.aroundExecute({ name: "subagent", agent }, async () => failedDelegation), failedDelegation)
  setGuardStep(agent, 1, agent.phase.step + 1)
  assert.equal((await run("sleep 10")).executed, 1, "委派失败不重置已确认状态")
  assert.equal(await guard.aroundExecute({ name: "send_message", agent }, async () => ({ isError: false })).then((r) => r.isError), false)
  setGuardStep(agent, 1, agent.phase.step + 1)
  assert.equal((await run("sleep 10")).executed, 1, "send_message 不递增世代")

  guard.noteDispatch({ agent }, { ok: true, task: "task-b", inflight: [{ ok: true, sessionId: "s2", action: "recreated" }] })
  setGuardStep(agent, 1, agent.phase.step + 1)
  assert.equal((await run("sleep 10")).executed, 0, "恢复补派后等待重新首次拦截")
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

  const first = await runOn(idleAgent, "sleep 30")
  assert.equal(first.executed, 0)
  const second = await runOn(idleAgent, "sleep 30", { callId: "call-2", rootCallId: "root-2" })
  assert.equal(second.executed, 0, "phase 读不到时不确认放行")
  assert.match(second.contexts[0].content[0].text, /本回合已引导过/)
  setGuardStep(idleAgent, 1, 3)
  assert.equal((await runOn(idleAgent, "sleep 30", { callId: "call-3", rootCallId: "root-3" })).executed, 0, "guidedStep 未知时本回合内保守继续拦截")
  guard.clearTurn("lead-idle")
  setGuardStep(idleAgent, 2, 1)
  assert.equal((await runOn(idleAgent, "sleep 30", { callId: "call-4", rootCallId: "root-4" })).executed, 0, "新回合重新引导")
  setGuardStep(idleAgent, 2, 2)
  assert.equal((await runOn(idleAgent, "sleep 30", { callId: "call-5", rootCallId: "root-5" })).executed, 1, "可读 Step 的引导在更晚 Step 确认放行")

  const brokenAgent = { id: "lead-broken", get phase() { throw new Error("phase 状态损坏") }, session: { header: { cwd: "/proj" } } }
  const broken = await runOn(brokenAgent, "sleep 30")
  assert.equal(broken.executed, 1, "guard 异常时放行原命令")
  assert.ok(logs.some((line) => /phase 状态损坏/.test(line)))

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

test("sleep 引导只拦等待：run_in_background、微小等待、workdir 与 cwd、非 bash 工具全部透传", async () => {
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
  assert.deepEqual(TW_DISPATCH_OUTPUT_SCHEMA.properties.nextAction.enum, ["wait-children", "wait-prior-turn", "needs-user-report", "recover", "complete"])
  // 健康 = 已核实宿主收单 + 合法动作 + 可定位会话；不依赖 registered/passthrough 等簿记字段。
  assert.equal(isHealthyInflightItem({ ok: true, sessionId: "s1", receiptVerified: true, action: "wait" }), true)
  assert.equal(isHealthyInflightItem({ ok: true, sessionId: "s1", receiptVerified: true, action: "followup" }), true)
  assert.equal(isHealthyInflightItem({ ok: true, sessionId: "s1", receiptVerified: true, action: "recreated" }), true)
  assert.equal(isHealthyInflightItem({ ok: true, sessionId: "s1", receiptVerified: true, action: "fresh_rebuilt" }), true)
  assert.equal(isHealthyInflightItem({ ok: true, sessionId: "s1", action: "wait" }), false, "未核实收单不算健康")
  assert.equal(isHealthyInflightItem({ ok: true, sessionId: "s1", receiptVerified: true, action: "reported" }), false, "reported 不在健康动作集")
  assert.equal(isHealthyInflightItem({ ok: true, sessionId: "s1", receiptVerified: true, action: "wait-prior-turn" }), false, "等待旧轮不是已收单健康态")
  assert.equal(isHealthyInflightItem({ ok: true, receiptVerified: true, action: "wait" }), false, "缺 sessionId 无法定位会话")
  assert.equal(isHealthyInflightBatch([{ ok: true, sessionId: "s1", receiptVerified: true, action: "wait" }], 0), true)
  assert.equal(isHealthyInflightBatch([{ ok: true, sessionId: "s1", receiptVerified: true, action: "wait" }], 1), false)
  assert.equal(isHealthyInflightBatch([], 0), false)
})

test("工具描述与输出字段：按 modelRef 创建、意图确认卡与换模型卡说明在位，不回退 modelHint", async () => {
  const description = twDispatchToolDescription()
  assert.match(description, /modelRef/, "按派单 modelRef 创建")
  assert.match(description, /无信息差.*直接推进.*原样呈现已签正文/, "说明可直接授权和有卡时的固定正文")
  assert.match(description, /换模型确认卡|已有会话换模型/, "说明已有会话换模型确认")
  assert.doesNotMatch(description, /按派单 modelHint/)
  const tool = twDispatchDefinition({}, { runTw: async () => ({ ok: true, stop: "completed", card: {}, waves: [] }) })
  assert.equal(tool.name, TOOL_NAME)
  const schema = JSON.stringify(TW_DISPATCH_OUTPUT_SCHEMA)
  assert.match(schema, /awaiting-user/)
  assert.doesNotMatch(schema, /modelHint/)
})

test("原生 tw 与 tw-dispatch：完整首卡停止且不创建成员，按展示卡 ID 确认后才派发", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tw-native-intake-"))
  const h = makeCtx()
  const config = { entryId: "team-work-dsh", profile: "fixture", tiers: {
    junior: { provider: "vendor-example", model: "model-j" },
    senior: { provider: "vendor-example", model: "model-s" },
    expert: { provider: "vendor-example", model: "model-e" },
  } }
  const context = { agent: { id: "parent-example", session: { header: { cwd: root } } } }
  const tool = twToolDefinition({ configSnapshot: () => config })
  const dispatch = twDispatchDefinition(h.ctx, { configSnapshot: () => config })
  const opened = await tool.execute({ args: ["open", "--name", "native-intake", "--objective", "目标", "--entry", "code-review", "--raw-requirement", "用户完整原文"] }, context)
  assert.equal(opened.status, "preparing")
  const first = await dispatch.execute({ task: "native-intake", writables: [{ path: "R.md", kind: "code-review" }] }, context)
  assert.equal(first.stop, "awaiting-user")
  assert.deepEqual(first.waves, [])
  assert.match(first.card.question, /用户完整原文/)
  assert.equal(h.started.length, 0)
  const response = await tool.execute({ args: ["decide", "--task", "native-intake", "--choice", "1", "--decision-id", first.card.decisionId] }, context)
  assert.equal(response.ok, true)
  const next = await dispatch.execute({ task: "native-intake" }, context)
  assert.equal(next.dispatched?.length, 1, JSON.stringify(next))
  assert.equal(h.started.length, 1)
})

function memberProbe(guard, { root = EXEC_ROOT, key = "d1-example", task = "demo-t", role = "owner", child = "member-example", lead = "lead-example" } = {}) {
  const wave = ownerWave({ dispatchKey: key, role })
  const header = { id: child, parentSession: lead, cwd: root }
  const session = { id: child, header }
  const member = { id: child, session, phase: { kind: "running", turn: 1, step: 1 } }
  const binding = { cwd: root, task, key, sessionId: child, leadId: lead, role, promptDigest: wave.promptDigest }
  const admission = { type: "user/message", data: { content: [{ type: "text", text: wave.prompt }] } }
  const notices = []
  const deliveries = []
  const exec = { name: "send_message", agent: member, arguments: { agent: "父会话路由", message: "例行进展" }, deferContext: (msg) => notices.push(msg) }
  const fire = (overrides = {}) => guard.aroundExecute({ ...exec, ...overrides }, () => {
    deliveries.push(overrides.arguments ?? exec.arguments)
    return { isError: false, value: { messageId: "原生回执" } }
  })
  return { exec, member, session, binding, admission, fire, notices, deliveries }
}

test("发送前软引导只拦当前已进入上下文的正式成员，同 Step 并发只提示一次且较晚 Step 只放行一条", async () => {
  let checked = 0
  const guard = createMemberMessageGuard({ resolveRecipient: (_exec, name) => name === "父会话路由" ? "lead-example" : "other-example", reportStatus: async () => { checked++; return "unreported" } })
  const m = memberProbe(guard)
  assert.equal((await m.fire()).isError, false, "无正式派发映射直通")
  guard.trackDispatch(m.binding)
  guard.observeSession(m.session, { type: "agent/inbox/spliced", data: { inserted: [m.admission.data] } })
  assert.equal((await m.fire()).isError, false, "排入 inbox 不把下一 key 强套给还在运行的旧轮")
  const fake = structuredClone(m.admission)
  fake.data.content[0].text += "\n不一致的正文"
  guard.observeSession(m.session, fake)
  assert.equal((await m.fire()).isError, false, "不能只认正文里的 key")
  guard.observeSession(m.session, m.admission)
  assert.equal((await m.fire({ arguments: { agent: "其他收件人", message: "协调" } })).isError, false)
  assert.equal((await m.fire({ deferContext: undefined })).isError, false, "宿主能力未知直通")
  assert.equal((await m.fire({ agent: { ...m.member, phase: null } })).isError, false, "Step 未知直通")
  assert.equal(checked, 0)
  const before = m.deliveries.length
  const first = await Promise.all([m.fire(), m.fire(), m.fire()])
  assert.ok(first.every((item) => item.isError && !item.value && /未发送|还没发/.test(item.content[0].text)))
  assert.equal(m.deliveries.length, before)
  assert.equal(m.notices.length, 1)
  assert.match(m.notices[0].content[0].text, /答 Lead 的问询.*后续 Step/)
  m.member.phase.step = 2
  const retry = await Promise.all([m.fire({ arguments: { agent: "父会话路由", message: "需立即处理阻塞" } }), m.fire(), m.fire()])
  assert.equal(retry.filter((item) => !item.isError).length, 1)
  assert.equal(m.deliveries.length, before + 1)
  assert.equal(m.notices.length, 1)
  m.member.phase.step = 3
  assert.equal((await m.fire()).isError, true, "后续新发送不继承全 turn 白名单")
  assert.equal(m.notices.length, 2)
  guard.observeSession(m.session, { type: "turn/end" })
  m.member.phase = { kind: "running", turn: 2, step: 1 }
  assert.equal((await m.fire()).isError, true, "新 turn 的第一次仍提示")
  assert.equal(m.notices.length, 3)
  guard.dispose()
  assert.equal((await m.fire()).isError, false, "释放后不残留引导")
})

test("原生 tw 只缓存正式同 key 的成功登记；失败、旧 key 与异任务不放行", async () => {
  for (const [role, command, payload] of [["owner", "deliver", ["--outcome", "blocked"]], ["challenger", "review", ["--recommendation", "escalate"]], ["expert", "review", ["--recommendation", "escalate"]]]) {
    const guard = createMemberMessageGuard({ resolveRecipient: () => "lead-example", reportStatus: () => "unreported" })
    const m = memberProbe(guard, { role })
    guard.trackDispatch(m.binding, true)
    let card = { accepted: false, reportId: command + "-" + m.binding.key }
    const tw = twToolDefinition({ memberGuard: guard, runTw: async () => card })
    const report = (task, key) => tw.execute({ args: [command, "--task", task, "--key", key, ...payload] }, m.exec)
    await report(m.binding.task, m.binding.key)
    assert.equal((await m.fire()).isError, true)
    card = { accepted: true, idempotent: true, reportId: command + "-d0-old" }
    await report(m.binding.task, "d0-old")
    assert.equal((await m.fire()).isError, true)
    card = { accepted: true, idempotent: true, reportId: command + "-" + m.binding.key }
    await report("another-task", m.binding.key)
    assert.equal((await m.fire()).isError, true)
    assert.equal(await report(m.binding.task, m.binding.key), card)
    assert.equal((await m.fire()).value.messageId, "原生回执", "报告登记后同 Step 也直接放行")
  }
})

test("异常不阻塞原生 send_message，也不重试或改写原生失败", async () => {
  const alreadyFailed = Object.assign(new Error("原生发送失败"), { code: "ORIGINAL_FAILURE" })
  for (const mode of ["路由", "报告", "提醒"]) {
    const logs = []
    const guard = createMemberMessageGuard({
      resolveRecipient: () => { if (mode === "路由") throw new Error(mode); return "lead-example" },
      reportStatus: () => { if (mode === "报告") throw new Error(mode); return "unreported" },
      log: (line) => logs.push(line),
    })
    const m = memberProbe(guard)
    guard.trackDispatch(m.binding, true)
    let called = 0
    await assert.rejects(() => guard.aroundExecute({ ...m.exec, deferContext() { throw new Error(mode) } }, () => { called++; throw alreadyFailed }), (error) => error === alreadyFailed)
    assert.equal(called, 1, mode)
    assert.equal(logs.length, 1, mode)
  }
})

test("插件装配：只在成员实际收单后提示，冷恢复重建当前身份，CLI 已登记不因回执丢失而拦截", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tw-member-report-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const h = makeCtx()
  const tiers = Object.fromEntries(["junior", "senior", "expert"].map((tier) => [tier, { provider: "example", model: tier }]))
  const definitions = new Map()
  const handlers = new Map()
  h.ctx.tools = { register(def) { definitions.set(def.name, def); return () => definitions.delete(def.name) } }
  h.ctx.on = (event, fn) => { handlers.set(event, fn); return () => handlers.delete(event) }
  h.ctx.subagents.resolveName = (_agent, address) => address === "父会话路由" ? "lead-example" : address
  const mount = () => hostPlugin.apply(h.ctx, { tiers }, { registerEmbeddedSkill: async () => {} })
  const firstMount = await mount()
  t.after(firstMount)
  const lead = { id: "lead-example", session: { header: { cwd: root } } }
  const call = (args) => definitions.get("tw").execute({ args }, { agent: lead })
  const dispatch = (params) => definitions.get("tw-dispatch").execute(params, { agent: lead })
  const task = "member-report"
  await call(["open", "--name", task, "--objective", "验证真实报告回执兜底", "--entry", "implementation", "--raw-requirement", "示例需求"])
  const params = { task, writables: [{ path: "sample.mjs", kind: "source" }] }
  const intent = await dispatch(params)
  assert.equal(intent.stop, "awaiting-user")
  assert.equal((await call(["decide", "--task", task, "--choice", "1", "--decision-id", intent.card.decisionId])).ok, true)
  const plan = await dispatch(params)
  const item = plan.dispatched[0]
  assert.equal(item.ok, true)
  const session = h.ctx.sessions.get(item.sessionId)
  session.header.cwd = root
  const member = { id: item.sessionId, session, phase: { kind: "running", turn: 1, step: 1 } }
  const contexts = []
  let sent = 0
  const fire = (agent = member, target = "父会话路由") => handlers.get("tools/execute")({
    name: "send_message", agent, arguments: { agent: target, message: "示例消息" }, deferContext: (note) => contexts.push(note),
  }, () => { sent++; return { isError: false, value: { messageId: "原生回执" } } })
  assert.equal((await fire(lead, member.id)).isError, false, "Lead 主动协调直通")
  assert.equal((await fire()).isError, false, "只登记/排队而未进入上下文时直通")
  const adopted = { type: "user/message", data: { content: h.started[0].request.prompt } }
  handlers.get("session/event")(session, adopted)
  assert.equal((await fire()).isError, true)
  assert.equal(sent, 2)
  assert.equal(contexts.length, 1)

  // 保留已接纳的派单日志，移走活会话并释放插件，冷读不能依赖原进程内的提示状态。
  session.events.push(adopted)
  await h.ctx.sessions.flush(session)
  await h.ctx.subagents.drainContinuableChildren(lead, [item.sessionId])
  firstMount()
  t.after(await mount())
  const cold = await dispatch({ task })
  assert.equal(cold.inflight[0].resume, "reminder")
  assert.match(h.followups[0].text, /登记则正常结束，不预告、不另发交卷摘要/)
  member.session = h.ctx.sessions.get(item.sessionId)
  member.phase = { kind: "running", turn: 2, step: 1 }
  assert.equal((await fire()).isError, true, "冷读恢复已接纳的 key，首次重新给软提示")
  assert.equal(contexts.length, 2)

  const args = ["deliver", "--task", task, "--key", item.key, "--outcome", "blocked", "--summary", "存在待决范围争议"]
  const standalone = twToolDefinition({ configSnapshot: () => ({ tiers, entryId: "team-work-dsh", profile: "fixture" }) })
  assert.equal((await standalone.execute({ args }, { agent: member })).accepted, true)
  assert.equal((await standalone.execute({ args }, { agent: member })).idempotent, true)
  const journal = path.join(root, ".team-work/tasks", task, "journal.jsonl")
  const before = await readFile(journal, "utf8")
  assert.equal((await fire()).value.messageId, "原生回执", "未收到原生回执也能核实 CLI 已提交的 blocked")
  assert.equal(await readFile(journal, "utf8"), before, "守卫不写任务事实")
})



test("tw-dispatch 只透传调用方精确方向与冻结意图卡，不渲染第二份正文", async () => {
  const direction = { quote: "只写这一项", fields: { writable: ["sample.mjs:source"] } }
  const card = { ok: true, stop: "awaiting-user", waves: [], card: { decisionId: "dec-example", question: "# 冻结正文\n\n不重新拼装。" } }
  const def = twDispatchDefinition({}, { runTw: async (args) => {
    assert.equal(args[args.indexOf("--user-direction") + 1], JSON.stringify(direction))
    assert.equal(args[args.indexOf("--writable") + 1], "sample.mjs:source")
    return card
  } })
  const actual = await def.execute({ task: "demo-t", userDirection: direction, writables: [{ path: "sample.mjs", kind: "source" }] }, EXEC)
  assert.deepEqual(actual, card)
  assert.equal(actual.presentation, undefined)
})

// —— 宿主直接对账专项（收编自 dsh-binding 包验证矩阵：Ghost Wave、并发屏障、崩溃窗口、收单核验）——
// 这些用例使用独立的状态化夹具 makeBindingFixture：dispatch-plan/run/agent-map 共享同一映射账本，
// 宿主会话（活/冷/异主/缺失）由 fixture 注入，验证 tw-dispatch 对账链在崩溃窗口与迟到调用下的行为。
const bKey = "d2-example"
const bParent = "parent-example"
const bPrompt = "# 派单（key: " + bKey + "）\n\n冻结正文"
const bFull = "# 续派全量变体（key: " + bKey + "）——原会话上下文不可用时的自足派单\n\n完整正文"
const bIncremental = "# 续派（key: " + bKey + "）——你在原上下文基础上继续\n\n增量正文"
function bindingWave(extra = {}) {
  const value = { dispatchKey: bKey, waveId: "wv2", role: "owner", kind: "produce", round: 1, continuation: false, prompt: bPrompt, promptFrozen: true, promptDigest: sha(bPrompt), modelRef: { provider: "provider-example", modelName: "model-example" }, ...extra }
  return value
}
const bindingInbox = (...texts) => ({ type: "agent/inbox/spliced", data: { inserted: [{ content: texts.map((text) => ({ type: "text", text })) }] } })

async function makeBindingFixture({ item = bindingWave(), registered = false, firstDispatch = false, blockStart, mapStatus = "active", mapReply } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "twr-binding-fixture-"))
  await mkdir(path.join(root, ".team-work/tasks/demo/locks"), { recursive: true })
  const id = item.expectedAgentId ?? deterministicSessionId("demo", bKey)
  const mappings = new Map(registered ? [[bKey, id]] : [])
  const live = new Map()
  const stored = new Map()
  const starts = [], sends = [], calls = []
  let planCalls = 0, sessionReads = 0, mapCalls = 0, state = mapStatus
  const persisted = (session) => stored.set(session.header.id, { header: { ...session.header }, inheritedEventCount: session.inheritedEventCount ?? 0, events: structuredClone(session.events ?? []) })
  const ctx = {
    sessions: {
      get: (childId) => { sessionReads++; return live.get(childId) },
      flush: async (session) => { persisted(session); return true },
    },
    sessionPersistence: {
      stat: async (childId) => stored.has(childId) ? { header: stored.get(childId).header } : undefined,
      open: async (childId) => {
        const snapshot = stored.get(childId)
        if (!snapshot) throw new Error("missing stored session")
        return { inheritedEventCount: snapshot.inheritedEventCount, read: async () => ({ events: structuredClone(snapshot.events) }), close: async () => {} }
      },
    },
    llm: { resolveCallConfig: async (target) => target },
    subagents: {
      getProvider: () => ({ prepareContinuable() {} }),
      resolveMaxDepth: () => 1,
      startActivation: async (spec) => {
        starts.push(spec)
        if (blockStart) await blockStart()
        const session = { header: { id: spec.childId, parentSession: bParent }, events: [bindingInbox("Agent example sent a message:", spec.prompt[0].text, "宿主引导")] }
        live.set(spec.childId, session); persisted(session)
        return { childId: spec.childId, messageId: "message-example" }
      },
      sendMessage: async (...args) => {
        sends.push(args)
        const [, childId, blocks] = args
        const previous = stored.get(childId)
        if (!previous) throw new Error("missing stored session")
        const session = { header: { ...previous.header }, inheritedEventCount: previous.inheritedEventCount, events: [...previous.events, bindingInbox("Agent example sent a message:", ...blocks.map((block) => block.text))] }
        live.set(childId, session); persisted(session)
        return "message-example"
      },
    },
  }
  const projection = () => ({ ...item, registered: mappings.has(bKey), ...(mappings.has(bKey) ? { mappedAgentId: mappings.get(bKey) } : {}) })
  const runTw = async (args) => {
    calls.push(args)
    if (args[0] === "dispatch-plan") {
      planCalls++
      if (firstDispatch && planCalls === 1) return { ok: true, task: "demo", stage: "implementation", stop: null, waves: [item] }
      return { ok: true, task: "demo", stage: "implementation", stop: "wait-inflight", inflight: [projection()] }
    }
    if (args[0] === "run") return { ok: true, task: "demo", stage: "implementation", status: "working", transition: "wait-inflight", inflight: [projection()] }
    assert.equal(args[0], "agent-map")
    const target = args[6], old = mappings.get(bKey)
    const override = mapReply?.({ count: ++mapCalls, target, old, state })
    if (override !== undefined) return override
    if (state === "superseded") return { ok: false, code: "DISPATCH_SUPERSEDED", status: "superseded", agentId: old ?? null }
    if (old && old !== target) return { ok: false, code: "AGENT_MAP_CONFLICT", status: state, agentId: old }
    if (state === "reported") return { ok: true, status: "reported", agentId: old ?? null, idempotent: true }
    const idempotent = old === target
    if (!idempotent) mappings.set(bKey, target)
    return { ok: true, status: "active", agentId: target, idempotent }
  }
  const exec = { agent: { id: bParent, session: { header: { cwd: root } } } }
  const dispatch = twDispatchDefinition(ctx, { runTw })
  return { root, id, ctx, mappings, live, stored, starts, sends, calls, exec, dispatch, get sessionReads() { return sessionReads }, setStatus: (v) => { state = v }, setSession: (events, { cold = false, inherited = 0, parentId = bParent } = {}) => { const s = { header: { id, parentSession: parentId }, inheritedEventCount: inherited, events }; persisted(s); if (!cold) live.set(id, s) } }
}

test("首次登记只创建一次并复核收单，wait-children 仅证明宿主收单", async () => {
  const f = await makeBindingFixture({ firstDispatch: true })
  const out = await f.dispatch.execute({ task: "demo" }, f.exec)
  assert.equal(f.starts.length, 1)
  assert.equal(f.starts[0].childId, f.id)
  assert.deepEqual(f.starts[0].prompt, [{ type: "text", text: bPrompt }])
  assert.equal(f.mappings.get(bKey), f.id)
  assert.equal(out.nextAction, "wait-children")
  assert.equal(out.dispatched[0].receiptVerified, true)
  assert.equal(out.dispatched[0].accepted, true)
  assert.equal(out.dispatched[0].action, "wait")
  assert.match(out.dispatched[0].message, /仅证明收单/)
})

test("同 key 并发在共享投递锁内对账，不会重复创建", async () => {
  let release, markStarted
  const gate = new Promise((resolve) => { release = resolve })
  const begun = new Promise((resolve) => { markStarted = resolve })
  const f = await makeBindingFixture({ blockStart: async () => { markStarted(); await gate } })
  const first = f.dispatch.execute({ task: "demo" }, f.exec)
  await begun
  const second = f.dispatch.execute({ task: "demo" }, f.exec)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.starts.length, 1)
  release()
  const results = await Promise.all([first, second])
  assert.equal(f.starts.length, 1)
  assert.equal(f.sends.length, 0)
  assert.ok(results.every((x) => x.nextAction === "wait-children"))
})

test("报告已存在或波已作废时重验状态，不访问宿主或发送", async () => {
  for (const state of ["reported", "superseded"]) {
    const f = await makeBindingFixture({ registered: true, mapStatus: state })
    const out = await f.dispatch.execute({ task: "demo" }, f.exec)
    assert.equal(f.sessionReads, 0)
    assert.equal(f.starts.length + f.sends.length, 0)
    if (state === "reported") assert.equal(out.inflight[0].action, "reported")
    else assert.equal(out.inflight[0].code, "DISPATCH_SUPERSEDED")
  }
})

test("旧写者未停写和续派映射缺失均阻止自动投递", async () => {
  const safety = { status: "unknown", required: true, conflicts: [{ dispatchKey: "old-key" }], recovery: "核对旧写者" }
  for (const [item, code] of [[bindingWave({ writerSafety: safety }), "TW_DISPATCH_WRITER_SAFETY_UNKNOWN"], [bindingWave({ continuation: true, prompt: bIncremental, promptDigest: sha(bIncremental), promptFull: bFull, promptFullDigest: sha(bFull), expectedAgentIdMissing: true }), "TW_DISPATCH_EXPECTED_AGENT_MISSING"]]) {
    const f = await makeBindingFixture({ item })
    const out = await f.dispatch.execute({ task: "demo" }, f.exec)
    assert.equal(out.nextAction, "recover")
    assert.equal(out.inflight[0].code, code)
    assert.equal(f.starts.length + f.sends.length, 0)
    if (item.writerSafety) assert.deepEqual(out.inflight[0].writerSafety.conflicts, safety.conflicts)
  }
})

test("缺冻结标记、摘要损坏或正文 key 不符均不得登记或创建", async () => {
  const invalid = [bindingWave({ promptFrozen: false }), bindingWave({ promptFrozen: undefined, promptDigest: undefined }), bindingWave({ promptDigest: "0".repeat(64) }), bindingWave({ prompt: bPrompt.replace(bKey, bKey + "x"), promptDigest: sha(bPrompt.replace(bKey, bKey + "x")) }), bindingWave({ continuation: true, expectedAgentId: "prior-example", prompt: bIncremental, promptDigest: sha(bIncremental), promptFull: bFull, promptFullDigest: "0".repeat(64) })]
  for (const item of invalid) {
    const f = await makeBindingFixture({ item })
    const out = await f.dispatch.execute({ task: "demo" }, f.exec)
    assert.equal(out.inflight[0].code, "TW_DISPATCH_PROMPT_UNVERIFIED")
    assert.equal(f.starts.length + f.sends.length, 0)
    assert.equal(f.mappings.size, 0)
  }
})

test("精确块比对排除继承前缀、宿主前置文本及相似 key，发现同 key 内容冲突", async () => {
  let closed = 0
  const inspect = async (events, inheritedEventCount = 0) => coldSessionReceived({ open: async () => ({ inheritedEventCount, read: async () => ({ events }), close: async () => { closed++ } }) }, "child-example", undefined, [bPrompt], bKey)
  assert.equal((await inspect([bindingInbox("Agent example sent a message:", bPrompt, "附加规则")])).currentReceived, true)
  assert.equal((await inspect([bindingInbox(bPrompt)], 1)).currentReceived, false)
  assert.equal((await inspect([bindingInbox(bPrompt.replace(bKey, bKey + "x"))])).currentReceived, false)
  assert.equal((await inspect([bindingInbox("普通提及 " + bKey)])).currentReceived, false)
  const conflict = await inspect([bindingInbox(bPrompt, bPrompt.replace("冻结正文", "不同正文"))])
  assert.equal(conflict.currentReceived, true)
  assert.equal(conflict.conflict, true)
  assert.equal(closed, 5)
})

test("按裁决区分已收活会话、未收活会话、冷续投与当前不可见会话", async () => {
  for (const mode of ["live-old", "live-current", "cold-old", "cold-current", "missing", "foreign", "conflict"]) {
    const f = await makeBindingFixture({ registered: true })
    if (mode === "live-old") f.setSession([bindingInbox("# 派单（key: d1-old）\n\n旧正文")])
    if (mode === "live-current") f.setSession([bindingInbox(bPrompt)])
    if (mode === "cold-old") f.setSession([bindingInbox("# 派单（key: d1-old）\n\n旧正文")], { cold: true })
    if (mode === "cold-current") f.setSession([bindingInbox(bPrompt)], { cold: true })
    if (mode === "foreign") f.setSession([bindingInbox(bPrompt)], { parentId: "other-parent" })
    if (mode === "conflict") f.setSession([bindingInbox(bPrompt.replace("冻结正文", "冲突正文"))])
    const out = await f.dispatch.execute({ task: "demo" }, f.exec)
    const entry = out.inflight[0]
    if (["live-current", "cold-old", "cold-current", "missing"].includes(mode)) {
      assert.equal(out.nextAction, "wait-children", mode)
      assert.equal(entry.receiptVerified, true, mode)
    } else assert.equal(out.nextAction, "recover", mode)
    if (mode === "live-old") { assert.equal(entry.code, "TW_SUB_ACTIVITY_UNVERIFIED"); assert.equal(f.sends.length, 0) }
    if (mode === "live-current") { assert.equal(entry.action, "wait"); assert.equal(f.sends.length, 0) }
    if (mode === "cold-old") { assert.equal(entry.resume, "incremental"); assert.equal(f.sends.length, 1); assert.equal(f.sends[0][2][0].text, bPrompt) }
    if (mode === "cold-current") { assert.equal(entry.resume, "reminder"); assert.equal(f.sends.length, 1); assert.match(f.sends[0][2][0].text, /已收到本轮/) }
    if (mode === "missing") { assert.equal(entry.action, "recreated"); assert.equal(f.starts.length, 1) }
    if (mode === "conflict") { assert.equal(entry.code, "TW_DISPATCH_PROMPT_CONFLICT"); assert.equal(f.sends.length, 0) }
    if (mode === "foreign") { assert.equal(entry.code, "TW_SUB_TAKEOVER_CONFLICT"); assert.equal(f.sends.length, 0) }
  }
})

test("活会话未收本轮且显式给出旧轮活动与通知标记时只等待旧轮", async () => {
  const f = await makeBindingFixture({ registered: true })
  f.setSession([bindingInbox("# 派单（key: d1-old）\n\n旧正文")])
  f.live.get(f.id).turnActive = true
  f.live.get(f.id).notificationReachable = true
  const out = await f.dispatch.execute({ task: "demo" }, f.exec)
  assert.equal(out.nextAction, "wait-prior-turn")
  assert.equal(out.inflight[0].receiptVerified, false)
  assert.equal(f.sends.length + f.starts.length, 0)
})

test("混合在途项中未确认收单不被健康项掩盖，可靠旧轮信号聚合 wait-prior-turn", async () => {
  for (const mode of ["unknown", "prior"]) {
    const f = await makeBindingFixture({ registered: true })
    f.setSession([bindingInbox(bPrompt)])
    const otherKey = "d3-other", otherId = "other-session", otherPrompt = "# 派单（key: " + otherKey + "）\n\n其他正文"
    const otherSession = { header: { id: otherId, parentSession: bParent }, inheritedEventCount: 0, events: [bindingInbox("# 派单（key: d1-old）\n\n旧正文")] }
    if (mode === "prior") { otherSession.turnActive = true; otherSession.notificationReachable = true }
    f.live.set(otherId, otherSession); f.stored.set(otherId, structuredClone(otherSession))
    const entries = [
      { ...bindingWave(), registered: true, mappedAgentId: f.id },
      { ...bindingWave({ dispatchKey: otherKey, prompt: otherPrompt, promptDigest: sha(otherPrompt) }), registered: true, mappedAgentId: otherId },
    ]
    const runTw = async (args) => args[0] === "dispatch-plan"
      ? { ok: true, task: "demo", stage: "implementation", stop: "wait-inflight", inflight: entries }
      : args[0] === "run"
        ? { ok: true, transition: "wait-inflight", inflight: entries }
        : { ok: true, status: "active", agentId: args[6], idempotent: true }
    const out = await twDispatchDefinition(f.ctx, { runTw }).execute({ task: "demo" }, f.exec)
    assert.equal(out.inflight[0].action, "wait")
    assert.equal(out.nextAction, mode === "prior" ? "wait-prior-turn" : "recover")
    if (mode === "prior") assert.equal(out.inflight[1].action, "wait-prior-turn")
    else assert.equal(out.inflight[1].code, "TW_SUB_ACTIVITY_UNVERIFIED")
    assert.equal(f.sends.length, 0)
  }
})

test("冷续派按旧上下文选择增量、全量或提醒并核验发送后收单", async () => {
  for (const mode of ["old", "empty", "current"]) {
    const item = bindingWave({ continuation: true, expectedAgentId: "prior-agent", prompt: bIncremental, promptDigest: sha(bIncremental), promptFull: bFull, promptFullDigest: sha(bFull) })
    const f = await makeBindingFixture({ item })
    const events = mode === "old" ? [bindingInbox("# 派单（key: d1-old）\n\n旧正文")] : mode === "current" ? [bindingInbox(bIncremental)] : []
    f.setSession(events, { cold: true })
    const out = await f.dispatch.execute({ task: "demo" }, f.exec)
    const entry = out.inflight[0]
    assert.equal(out.nextAction, "wait-children", mode)
    assert.equal(entry.action, "followup", mode)
    assert.equal(entry.resume, mode === "old" ? "incremental" : mode === "empty" ? "full" : "reminder", mode)
    assert.equal(f.mappings.get(bKey), "prior-agent", mode)
    assert.equal(f.sends.length, 1, mode)
    if (mode === "old") assert.equal(f.sends[0][2][0].text, bIncremental)
    if (mode === "empty") assert.equal(f.sends[0][2][0].text, bFull)
    if (mode === "current") assert.match(f.sends[0][2][0].text, /已收到本轮/)
  }
})

test("续派原 ID 当前不可见时，以新 key 的确定性 ID 重建并发送全量正文", async () => {
  const item = bindingWave({ continuation: true, expectedAgentId: "prior-agent", prompt: bIncremental, promptDigest: sha(bIncremental), promptFull: bFull, promptFullDigest: sha(bFull) })
  const f = await makeBindingFixture({ item })
  const out = await f.dispatch.execute({ task: "demo" }, f.exec)
  const entry = out.inflight[0], freshId = deterministicSessionId("demo", bKey)
  assert.equal(out.nextAction, "wait-children")
  assert.equal(entry.action, "fresh_rebuilt")
  assert.equal(entry.priorAgentId, "prior-agent")
  assert.equal(entry.sessionId, freshId)
  assert.equal(f.mappings.get(bKey), freshId)
  assert.equal(f.starts[0].prompt[0].text, bFull)
})

test("冷续投重验期间会话变为活会话时绝不投递正文", async () => {
  const item = bindingWave({ continuation: true, expectedAgentId: "prior-agent", prompt: bIncremental, promptDigest: sha(bIncremental), promptFull: bFull, promptFullDigest: sha(bFull) })
  let f
  f = await makeBindingFixture({ item, mapReply: ({ count }) => { if (count === 1) f.live.set(f.id, { ...f.stored.get(f.id) }); return undefined } })
  f.setSession([bindingInbox("# 派单（key: d1-old）\n\n旧正文")], { cold: true })
  const out = await f.dispatch.execute({ task: "demo" }, f.exec)
  assert.equal(out.nextAction, "recover")
  assert.equal(out.inflight[0].code, "TW_SUB_ACTIVITY_UNVERIFIED")
  assert.equal(f.sends.length + f.starts.length, 0)
})

test("冷续投登记后出现旧写者停写冲突时不得发送", async () => {
  const item = bindingWave({ continuation: true, expectedAgentId: "prior-agent", prompt: bIncremental, promptDigest: sha(bIncremental), promptFull: bFull, promptFullDigest: sha(bFull) })
  const safety = { required: true, status: "unknown", conflicts: [{ dispatchKey: "old" }], recovery: "核对旧写者" }
  const f = await makeBindingFixture({ item, mapReply: ({ count }) => { if (count === 1) item.writerSafety = safety; return undefined } })
  f.setSession([], { cold: true })
  const out = await f.dispatch.execute({ task: "demo" }, f.exec)
  assert.equal(out.inflight[0].code, "TW_DISPATCH_WRITER_SAFETY_UNKNOWN")
  assert.deepEqual(out.inflight[0].writerSafety.conflicts, safety.conflicts)
  assert.equal(f.sends.length, 0)
})

test("续投后消息回执、flush 或精确收单无法确认时不得称健康", async () => {
  for (const mode of ["no-id", "throw", "no-event", "flush-false"]) {
    const item = bindingWave({ continuation: true, expectedAgentId: "prior-agent", prompt: bIncremental, promptDigest: sha(bIncremental), promptFull: bFull, promptFullDigest: sha(bFull) })
    const f = await makeBindingFixture({ item })
    f.setSession([], { cold: true })
    if (mode === "no-id") f.ctx.subagents.sendMessage = async (...args) => { f.sends.push(args); return undefined }
    if (mode === "throw") f.ctx.subagents.sendMessage = async (...args) => { f.sends.push(args); throw new Error("回执丢失") }
    if (mode === "no-event") f.ctx.subagents.sendMessage = async (...args) => { f.sends.push(args); return "message-example" }
    if (mode === "flush-false") f.ctx.sessions.flush = async () => false
    const out = await f.dispatch.execute({ task: "demo" }, f.exec)
    assert.equal(out.nextAction, "recover", mode)
    assert.equal(f.sends.length, 1, mode)
    assert.notEqual(out.inflight[0].receiptVerified, true, mode)
  }
})

test("人工门保留全部待决、失效和阻塞包，不保留多卡单项别名", async () => {
  const f = await makeBindingFixture()
  const pending = [{ decisionId: "card-a", blockers: [] }, { decisionId: "card-b", blockers: ["证据不足"] }]
  const stale = [{ decisionId: "old-card" }]
  const blocked = [{ package: "package-a", ref: "ref-a" }]
  const plan = { ok: true, stop: "awaiting-user", decisionId: "card-a", card: { decisionId: "card-a", question: "单卡别名", choices: [1], pendingDecisions: pending, staleDecisions: stale, blockedPackages: blocked } }
  const tool = twDispatchDefinition({}, { runTw: async () => plan })
  const out = await tool.execute({ task: "demo" }, f.exec)
  assert.deepEqual(out.pendingDecisions, pending)
  assert.deepEqual(out.staleDecisions, stale)
  assert.deepEqual(out.blockedPackages, blocked)
  assert.equal(out.needsDecisionId, true)
  assert.equal(out.decisionId, undefined)
  assert.equal(out.card.decisionId, undefined)
  assert.ok(TW_DISPATCH_OUTPUT_SCHEMA.properties.nextAction.enum.includes("wait-prior-turn"))
})

test("真实 CoreRuntime CLI 与绑定接缝：首卡、用户确认、锁内重验及宿主桩收单", async () => {
  const f = await makeBindingFixture()
  const snapshot = { entryId: "team-work-dsh", profile: "profile-example", tiers: { junior: { provider: "provider-example", model: "model-basic" }, senior: { provider: "provider-example", model: "model-standard" }, expert: { provider: "provider-example", model: "model-advanced" } } }
  const configSnapshot = () => snapshot
  const tw = twToolDefinition({ configSnapshot })
  const opened = await tw.execute({ args: ["open", "--name", "seam-example", "--objective", "验证派发接缝", "--entry", "code-review", "--raw-requirement", "虚构需求"] }, f.exec)
  assert.equal(opened.ok, true, JSON.stringify(opened))
  const dispatch = twDispatchDefinition(f.ctx, { configSnapshot })
  const first = await dispatch.execute({ task: "seam-example", writables: [{ path: "AUDIT.md", kind: "code-review" }] }, f.exec)
  assert.equal(first.stop, "awaiting-user", JSON.stringify(first))
  const confirmed = await tw.execute({ args: ["decide", "--task", "seam-example", "--choice", "1", "--decision-id", first.card.decisionId] }, f.exec)
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed))
  const out = await dispatch.execute({ task: "seam-example" }, f.exec)
  assert.equal(f.starts.length, 1, JSON.stringify(out))
  assert.equal(out.nextAction, "wait-children", JSON.stringify(out))
  assert.equal(out.dispatched[0].receiptVerified, true, JSON.stringify(out))
  assert.match(f.starts[0].prompt[0].text, /^# 派单（key: /)
})

test("波次重验报告账本损坏时保留原始错误而不访问宿主", async () => {
  const f = await makeBindingFixture()
  let calls = 0
  const runTw = async () => ++calls === 1
    ? { ok: true, task: "demo", stage: "implementation", stop: "wait-inflight", inflight: [{ ...bindingWave(), registered: false }] }
    : { ok: false, code: "AGENTS_STATE_CORRUPT", card: { blockers: [{ message: "登记簿损坏" }] } }
  const out = await twDispatchDefinition(f.ctx, { runTw }).execute({ task: "demo" }, f.exec)
  assert.equal(out.nextAction, "recover")
  assert.equal(out.inflight[0].code, "AGENTS_STATE_CORRUPT")
  assert.equal(f.sessionReads, 0)
  assert.equal(f.starts.length + f.sends.length, 0)
})

test("已报告即使冻结正文损坏也短路，不凭猜测补造 sessionId", async () => {
  const f = await makeBindingFixture({ item: bindingWave({ promptFrozen: false }), registered: true, mapReply: () => ({ ok: true, status: "reported", agentId: null, idempotent: true }) })
  const out = await f.dispatch.execute({ task: "demo" }, f.exec)
  assert.equal(out.inflight[0].action, "reported")
  assert.equal(out.inflight[0].sessionId, undefined)
  assert.equal(f.sessionReads, 0)
})

test("登记簿损坏或竞争变更时保留原映射且不访问宿主", async () => {
  for (const code of ["AGENTS_STATE_CORRUPT", "AGENT_MAP_CONFLICT"]) {
    const f = await makeBindingFixture({ registered: true, mapReply: () => ({ ok: false, code, message: "登记不可证", agentId: "original-id" }) })
    const out = await f.dispatch.execute({ task: "demo" }, f.exec)
    assert.equal(out.inflight[0].code, code)
    assert.equal(f.sessionReads, 0)
    assert.equal(f.starts.length + f.sends.length, 0)
    assert.equal(f.mappings.get(bKey), f.id)
  }
})

test("首次登记后重验发现已报告或作废时绝不创建", async () => {
  for (const state of ["reported", "superseded"]) {
    const f = await makeBindingFixture({ mapReply: ({ count, target }) => count === 2 ? state === "reported" ? { ok: true, status: "reported", agentId: target, idempotent: true } : { ok: false, status: "superseded", code: "DISPATCH_SUPERSEDED", agentId: target } : undefined })
    const out = await f.dispatch.execute({ task: "demo" }, f.exec)
    assert.equal(f.starts.length + f.sends.length, 0)
    assert.equal(f.mappings.get(bKey), f.id)
    if (state === "reported") assert.equal(out.inflight[0].action, "reported")
    else assert.equal(out.inflight[0].code, "DISPATCH_SUPERSEDED")
  }
})

test("日志读取、持久化屏障或关闭失败均保持 recover 且不重投", async () => {
  for (const mode of ["flush-false", "flush-throw", "open-throw", "read-throw", "close-throw", "truncated"]) {
    const f = await makeBindingFixture({ registered: true })
    f.setSession([bindingInbox(bPrompt)])
    if (mode === "flush-false") f.ctx.sessions.flush = async () => false
    if (mode === "flush-throw") f.ctx.sessions.flush = async () => { throw new Error("flush failed") }
    if (mode === "open-throw") f.ctx.sessionPersistence.open = async () => { throw new Error("open failed") }
    if (mode === "read-throw") f.ctx.sessionPersistence.open = async () => ({ inheritedEventCount: 0, read: async () => { throw new Error("read failed") }, close: async () => {} })
    if (mode === "close-throw") f.ctx.sessionPersistence.open = async () => ({ inheritedEventCount: 0, read: async () => ({ events: [bindingInbox(bPrompt)] }), close: async () => { throw new Error("close failed") } })
    if (mode === "truncated") f.ctx.sessionPersistence.open = async () => ({ inheritedEventCount: 0, read: async () => ({ events: [bindingInbox(bPrompt)], truncated: true }), close: async () => {} })
    const out = await f.dispatch.execute({ task: "demo" }, f.exec)
    assert.equal(out.nextAction, "recover", mode)
    assert.equal(f.starts.length + f.sends.length, 0, mode)
    assert.notEqual(out.inflight[0].receiptVerified, true, mode)
  }
})

test("用户裁决下当前不可见的创建可重试，而持久化未确认的在场会话不重建", async () => {
  for (const mode of ["start-throw", "flush-false"]) {
    const f = await makeBindingFixture()
    if (mode === "start-throw") f.ctx.subagents.startActivation = async (spec) => { f.starts.push(spec); throw new Error("回执丢失") }
    if (mode === "flush-false") f.ctx.sessions.flush = async () => false
    const first = await f.dispatch.execute({ task: "demo" }, f.exec)
    assert.equal(first.nextAction, "recover", mode)
    assert.equal(f.starts.length, 1, mode)
    assert.equal(f.mappings.get(bKey), f.id, mode)
    const retry = await f.dispatch.execute({ task: "demo" }, f.exec)
    assert.equal(retry.nextAction, "recover", mode)
    assert.equal(f.starts.length, mode === "start-throw" ? 2 : 1, mode + "：模拟的不可见状态下允许重试但不证明真实宿主无重复")
    assert.equal(f.sends.length, 0, mode)
  }
})

test("精确模型缺失或非法时不登记也不创建", async () => {
  for (const modelRef of [undefined, { provider: "provider-example" }, { provider: "provider-example", modelName: "model-example", effort: "none" }]) {
    const f = await makeBindingFixture({ item: bindingWave({ modelRef }) })
    const out = await f.dispatch.execute({ task: "demo" }, f.exec)
    assert.equal(out.inflight[0].code, "TW_DISPATCH_MODEL_REF_UNRESOLVED")
    assert.equal(f.mappings.size, 0)
    assert.equal(f.starts.length, 0)
  }
})

test("两个进程同 key 投递锁不允许临界区交叠", { timeout: 10000 }, async () => {
  const f = await makeBindingFixture()
  const script = `
    import { appendFile } from "node:fs/promises";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const [root, id, repo] = process.argv.slice(2);
    const { dispatchLockPath, withOwnerLock } = await import(pathToFileURL(path.join(repo, "runtime-v3/store.mjs")));
    const wait = (kind) => new Promise((resolve) => { const on = (v) => { if (v === kind) { process.off("message", on); resolve() } }; process.on("message", on) });
    process.on("disconnect", () => process.exit(1));
    process.send({ type: "ready" });
    await wait("go");
    process.send({ type: "attempt" });
    await withOwnerLock(dispatchLockPath(root, "demo", "d2-example"), async () => {
      await appendFile(path.join(root, "audit.txt"), "start " + id + "\\n");
      process.send({ type: "entered" });
      await wait("release");
      await appendFile(path.join(root, "audit.txt"), "end " + id + "\\n");
    });
    process.send({ type: "done" });
    process.disconnect();
  `
  const scriptPath = path.join(f.root, "lock-probe.mjs")
  await (await import("node:fs/promises")).writeFile(scriptPath, script)
  const children = ["a", "b"].map((id) => spawn(process.execPath, [scriptPath, f.root, id, process.cwd()], { stdio: ["ignore", "ignore", "pipe", "ipc"] }))
  const waitMessage = (child, type) => new Promise((resolve, reject) => {
    const on = (value) => { if (value?.type === type) { cleanup(); resolve() } }
    const error = (e) => { cleanup(); reject(e) }
    const cleanup = () => { child.off("message", on); child.off("error", error) }
    child.on("message", on); child.on("error", error)
  })
  try {
    await Promise.all(children.map((c) => waitMessage(c, "ready")))
    const attempts = children.map((c) => waitMessage(c, "attempt"))
    const entered = children.map((c) => waitMessage(c, "entered"))
    const done = children.map((c) => waitMessage(c, "done"))
    children.forEach((c) => c.send("go"))
    await Promise.all(attempts)
    const first = await Promise.race(entered.map((p, i) => p.then(() => i)))
    let overlapping = false
    entered[1 - first].then(() => { overlapping = true })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(overlapping, false, "第二进程不能同时进入同 key 临界区")
    children[first].send("release")
    await done[first]
    await entered[1 - first]
    children[1 - first].send("release")
    await Promise.all(done)
    const lines = (await readFile(path.join(f.root, "audit.txt"), "utf8")).trim().split("\n")
    assert.deepEqual(lines.map((line) => line.split(" ")[0]), ["start", "end", "start", "end"])
    assert.equal(lines[0].split(" ")[1], lines[1].split(" ")[1])
    assert.equal(lines[2].split(" ")[1], lines[3].split(" ")[1])
  } finally {
    for (const child of children) if (child.exitCode === null && !child.killed) child.kill()
  }
})

// Ghost Wave 防护（收编自 dsh-binding 包）：原 Owner 在锁内重验期间先行交付时，
// 只读 run 重验不得产生未投递的下一波（幽灵波），对账不得声称在途。
test("已有 Owner 先交付时，锁内重验不得创建未投递的下一波", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "twr-ghost-repro-"))
  const exec = { agent: { id: "parent-example", session: { header: { cwd: root } } } }
  const snapshot = { entryId: "team-work-dsh", profile: "profile-example", tiers: { junior: { provider: "provider-example", model: "model-basic" }, senior: { provider: "provider-example", model: "model-standard" }, expert: { provider: "provider-example", model: "model-advanced" } } }
  const tw = twToolDefinition({ configSnapshot: () => snapshot })
  const call = (args) => tw.execute({ args }, exec)
  await (await import("node:fs/promises")).writeFile(path.join(root, "artifact.md"), "独立夹具内容\n")
  const opened = await call(["open", "--name", "ghost-example", "--objective", "验证对账不会推进下一波", "--entry", "implementation", "--raw-requirement", "虚构需求"])
  assert.equal(opened.ok, true, JSON.stringify(opened))
  let armed = false, submitted = false, before, firstKey
  const cli = async (args) => {
    const out = await call(args)
    if (armed && !submitted && args[0] === "dispatch-plan" && out.stop === null && out.waves?.length) {
      submitted = true
      firstKey = out.waves[0].dispatchKey ?? out.waves[0].key
      const delivered = await call(["deliver", "--task", "ghost-example", "--key", firstKey, "--outcome", "delivered", "--summary", "原 Owner 已提交交付。", "--paths", "artifact.md"])
      assert.equal(delivered.accepted, true, JSON.stringify(delivered))
      before = await call(["run", "--task", "ghost-example"])
    }
    return out
  }
  let starts = 0
  const ctx = { sessions: { get: () => undefined }, sessionPersistence: { stat: async () => undefined }, subagents: { startActivation: async () => { starts++; throw Error("不可达") } } }
  const dispatch = twDispatchDefinition(ctx, { runTw: cli, configSnapshot: () => snapshot })
  const card = await dispatch.execute({ task: "ghost-example", writables: [{ path: "artifact.md", kind: "source" }] }, exec)
  assert.equal(card.stop, "awaiting-user", JSON.stringify(card))
  const decision = await call(["decide", "--task", "ghost-example", "--choice", "1", "--decision-id", card.card.decisionId])
  assert.equal(decision.ok, true, JSON.stringify(decision))
  armed = true
  const out = await dispatch.execute({ task: "ghost-example" }, exec)
  const after = await call(["run", "--task", "ghost-example"])
  assert.equal(starts, 0)
  assert.equal(after.journalSeq, before.journalSeq, "锁内重验不得写入下一波事实")
  assert.equal((after.inflight ?? []).length, 0, "对账不应生成未投递的新派单")
})
