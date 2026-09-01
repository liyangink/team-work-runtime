// dsh-tw-tool-subagent.test.mjs — 定向选模委派工具单测（方案 §7 自动测试 + §10.3 风险落点）
// 纯 fake ctx（不依赖 DSH 运行时）；装载链验证沿用 dsh-plugin-e2e 模式。
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import vm from "node:vm"

import {
  TOOL_NAME,
  TIER_VALUE_PROPS,
  TIER_NAMES,
  normalizeTarget,
  resolveTierSelection,
  toolDescriptionText,
  systemPromptSection,
  decisionTableText,
  tierValuePropsText,
  twToolSubagentDefinition,
} from "../dsh/tw-tool-subagent.js"
import { recallFromHeader, makeInjectContribution } from "../dsh/inject.js"
import * as hostPlugin from "../dsh/index.js"

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const TIERS_SNAPSHOT = Object.freeze({
  tiers: {
    junior: [{ provider: "p-a", model: "m-j1" }, { provider: "p-b", model: "m-j2" }],
    senior: { provider: "p-a", model: "m-s1", effort: "medium" },
    expert: [{ provider: "p-c", model: "m-e1", effort: "high" }],
  },
})

function makeFakeCtx(overrides = {}) {
  const started = []
  const registered = []
  const ctx = {
    logger: { warn() {}, info() {} },
    llm: { resolveCallConfig: async (config) => ({ ...config }) },
    subagents: {
      getProvider: () => ({ name: "spawn", prepareContinuable: async () => ({}) }),
      startContinuable: async (spec) => {
        started.push(spec)
        return { childId: spec.childId, messageId: "m-" + started.length }
      },
      drainContinuableChildren: async () => {},
    },
    sessions: { get: (id) => ({ id }), flush: async () => true },
    sessionPersistence: {},
    tools: { register(def) { registered.push(def) } },
    ...overrides,
  }
  return { ctx, started, registered }
}

function makeTool(overrides = {}, deps = {}) {
  const base = makeFakeCtx(overrides)
  const selections = deps.directSelections ?? new Map()
  if (!Object.hasOwn(overrides, "sessions")) {
    base.ctx.sessions = {
      get: (id) => {
        const direct = selections.get(id)
        return {
          id,
          events: [{
            type: "request/header",
            data: { header: { config: { ...direct } } },
          }],
        }
      },
      flush: async () => true,
    }
  }
  const tool = twToolSubagentDefinition(base.ctx, {
    tiersSource: deps.tiersSource ?? (() => TIERS_SNAPSHOT),
    directSelections: selections,
    ...deps,
  })
  return { tool, ...base, selections }
}

const EXEC = { agent: { id: "parent-agent-1" } }

// 模拟 Cordis 的服务属性守卫：只有 inject 声明过的服务才能经 ctx.<name> 访问；
// ctx.get(name) 保留为可选/运行期服务的查询通道。普通对象 mock 无法捕获这类装载错误。
function guardedContext(services, declared = []) {
  const allowed = new Set([...declared, "get", "logger"])
  const target = {
    ...services,
    get(name) { return services[name] },
  }
  return new Proxy(target, {
    get(object, key, receiver) {
      if (typeof key === "string" && !allowed.has(key)) {
        throw new Error('cannot get property "' + key + '" without inject')
      }
      return Reflect.get(object, key, receiver)
    },
  })
}

// ── 参数校验（§7：档位、精确模型和可选 effort 的参数校验正确） ─────────────────

test("normalizeTarget：tier 与显式模型互斥", () => {
  const both = normalizeTarget({ tier: "senior", provider: "p", model: "m" })
  assert.equal(both.ok, false)
  assert.equal(both.code, "TW_SUB_TARGET_INVALID")
  assert.match(both.message, /互斥/)
})

test("normalizeTarget：tier 枚举校验；合法 tier 原样通过", () => {
  assert.equal(normalizeTarget({ tier: "intern" }).ok, false)
  for (const tier of TIER_NAMES) {
    assert.deepEqual(normalizeTarget({ tier }), { ok: true, tier })
  }
})

test("normalizeTarget：显式选择必须 provider+model 齐全且非空；effort 可选", () => {
  assert.equal(normalizeTarget({ provider: "p" }).ok, false)
  assert.equal(normalizeTarget({ model: "m" }).ok, false)
  assert.equal(normalizeTarget({ provider: "", model: "m" }).ok, false)
  assert.equal(normalizeTarget({ provider: "p", model: "m", effort: "" }).ok, false)
  assert.deepEqual(normalizeTarget({ provider: "p", model: "m" }), { ok: true, provider: "p", model: "m" })
  assert.deepEqual(normalizeTarget({ provider: "p", model: "m", effort: "high" }), {
    ok: true, provider: "p", model: "m", effort: "high",
  })
})

test("resolveTierSelection：候选数组稳定取第一项；单对象兼容；缺档/字段不完整返回 null", () => {
  assert.deepEqual(resolveTierSelection(TIERS_SNAPSHOT, "junior"), { provider: "p-a", model: "m-j1" })
  assert.deepEqual(resolveTierSelection(TIERS_SNAPSHOT, "senior"), { provider: "p-a", model: "m-s1", effort: "medium" })
  assert.equal(resolveTierSelection({ tiers: {} }, "junior"), null)
  assert.equal(resolveTierSelection({ tiers: { junior: [{ provider: "p" }] } }, "junior"), null)
  assert.equal(resolveTierSelection(null, "junior"), null)
})

// ── execute 行为 ────────────────────────────────────────────────────────────

test("execute：description/prompt 必填非空", async () => {
  const { tool } = makeTool()
  assert.equal((await tool.execute({ description: "  ", prompt: "x", target: { tier: "senior" } }, EXEC)).code, "TW_SUB_DESCRIPTION_REQUIRED")
  assert.equal((await tool.execute({ description: "d", prompt: "", target: { tier: "senior" } }, EXEC)).code, "TW_SUB_PROMPT_REQUIRED")
})

test("execute：档位未配置 → TW_SUB_TIER_UNRESOLVED，未创建子会话", async () => {
  const { tool, started } = makeTool({}, { tiersSource: () => ({ tiers: {} }) })
  const card = await tool.execute({ description: "d", prompt: "p", target: { tier: "junior" } }, EXEC)
  assert.equal(card.ok, false)
  assert.equal(card.code, "TW_SUB_TIER_UNRESOLVED")
  assert.match(card.message, /team-work-dsh\.tiers/)
  assert.equal(started.length, 0)
})

test("execute：模型验证失败 → 创建前失败，不留子会话（§7）", async () => {
  const { tool, started } = makeTool({
    llm: { resolveCallConfig: async () => { throw new Error("unknown model") } },
  })
  const card = await tool.execute({ description: "d", prompt: "p", target: { provider: "p-x", model: "nope" } }, EXEC)
  assert.equal(card.code, "TW_SUB_MODEL_INVALID")
  assert.match(card.message, /未创建子会话/)
  assert.equal(started.length, 0)
})

test("execute：显式精确选择不得被 resolveCallConfig 静默改写", async () => {
  const cases = [
    { name: "provider", resolved: { provider: "p-other", model: "m-x", reasoningEffort: "high" } },
    { name: "model", resolved: { provider: "p-x", model: "m-other", reasoningEffort: "high" } },
    { name: "effort", resolved: { provider: "p-x", model: "m-x", reasoningEffort: "low" } },
    { name: "补入未请求 effort", resolved: { provider: "p-x", model: "m-x", reasoningEffort: "medium" }, target: { provider: "p-x", model: "m-x" } },
  ]
  for (const entry of cases) {
    const { tool, started } = makeTool({ llm: { resolveCallConfig: async () => entry.resolved } })
    const card = await tool.execute(
      { description: "d", prompt: "p", target: entry.target ?? { provider: "p-x", model: "m-x", effort: "high" } },
      EXEC
    )
    assert.equal(card.code, "TW_SUB_EXPLICIT_SELECTION_MISMATCH", entry.name)
    assert.equal(started.length, 0, entry.name + " 不得创建子会话")
  }
})

test("execute：子代理 provider 未注册 / 缺 prepareContinuable → 创建前失败（§10.3 风险 3）", async () => {
  const missing = makeTool({ subagents: { getProvider: () => undefined, startContinuable: async () => {} } })
  const cardMissing = await missing.tool.execute({ description: "d", prompt: "p", target: { tier: "senior" } }, EXEC)
  assert.equal(cardMissing.code, "TW_SUB_PROVIDER_MISSING")
  assert.equal(missing.started.length, 0)

  for (const prepareContinuable of [undefined, null, "not-a-function", {}]) {
    let calls = 0
    const bare = makeTool({
      subagents: {
        getProvider: () => ({ name: "spawn", prepareContinuable }),
        startContinuable: async () => { calls++ },
      },
    })
    const cardBare = await bare.tool.execute({ description: "d", prompt: "p", target: { tier: "senior" } }, EXEC)
    assert.equal(cardBare.code, "TW_SUB_PROVIDER_NOT_CONTINUABLE")
    assert.equal(calls, 0, "非函数 prepareContinuable 必须在创建前拒绝")
  }
})

test("execute：宿主服务缺失时明确报错（llm/subagents/sessions）", async () => {
  const noLlm = makeTool({ llm: undefined })
  assert.equal((await noLlm.tool.execute({ description: "d", prompt: "p", target: { tier: "senior" } }, EXEC)).code, "TW_SUB_LLM_UNAVAILABLE")
  const noSub = makeTool({ subagents: undefined })
  assert.equal((await noSub.tool.execute({ description: "d", prompt: "p", target: { tier: "senior" } }, EXEC)).code, "TW_SUB_SUBAGENTS_UNAVAILABLE")
  const noSess = makeTool({ sessions: undefined })
  assert.equal((await noSess.tool.execute({ description: "d", prompt: "p", target: { tier: "senior" } }, EXEC)).code, "TW_SUB_SESSIONS_UNAVAILABLE")
})

test("execute 成功（档位带 effort）：spec 与返回卡（§4 创建过程 + §7 首条）", async () => {
  const { tool, started, selections } = makeTool()
  const card = await tool.execute(
    { description: "评审方案", prompt: "请评审 X", target: { tier: "senior" } },
    EXEC
  )
  assert.deepEqual(
    { ...card, sessionId: undefined, messageId: undefined },
    { ok: true, sessionId: undefined, messageId: undefined, provider: "p-a", model: "m-s1", effort: "medium", source: "tier" }
  )
  assert.match(card.sessionId, UUID_V4_RE)
  assert.equal(started.length, 1)
  const spec = started[0]
  assert.equal(spec.provider, "spawn")
  assert.equal(spec.childId, card.sessionId)
  assert.equal(spec.label, "评审方案")
  assert.deepEqual(spec.request.prompt, [{ type: "text", text: "请评审 X" }])
  assert.equal(spec.request.parent, EXEC.agent)
  assert.deepEqual(spec.request.agentOptions, { provider: "p-a", model: "m-s1" })
  assert.equal(selections.size, 0, "成功路径后直接选择表须被清空（take 或兜底）")
})

test("execute 成功（显式精确模型，无 effort）：schema 不向模型暴露 sessionId（§3.4）", async () => {
  const { tool, started } = makeTool()
  const card = await tool.execute(
    { description: "d", prompt: "p", target: { provider: "p-z", model: "m-z9", effort: "low" } },
    EXEC
  )
  assert.equal(card.source, "explicit")
  assert.equal(card.effort, "low")
  assert.deepEqual(started[0].request.agentOptions, { provider: "p-z", model: "p-z9".replace("p-z9", "m-z9") })
  const props = Object.keys(tool.parameters.properties)
  assert.ok(!props.includes("sessionId") && !props.includes("id"), "sessionId 不是模型参数")
  assert.deepEqual(tool.parameters.required, ["description", "prompt", "target"])
})

test("execute：创建失败清理待注入选择，不复用已有会话（§3.4 重复 id）", async () => {
  const { tool, selections } = makeTool({
    subagents: {
      getProvider: () => ({ prepareContinuable: async () => ({}) }),
      startContinuable: async () => { throw new Error("duplicate child id") },
      drainContinuableChildren: async () => {},
    },
  })
  const card = await tool.execute({ description: "d", prompt: "p", target: { tier: "junior" } }, EXEC)
  assert.equal(card.code, "TW_SUB_START_FAILED")
  assert.match(card.message, /不复用已有会话/)
  assert.equal(selections.size, 0)
})

test("execute：缺少回收能力时在创建前拒绝", async () => {
  const { tool, started } = makeTool({
    subagents: {
      getProvider: () => ({ prepareContinuable: async () => ({}) }),
      startContinuable: async () => { started.push(true) },
    },
  })
  const card = await tool.execute({ description: "d", prompt: "p", target: { tier: "junior" } }, EXEC)
  assert.equal(card.code, "TW_SUB_CLEANUP_UNAVAILABLE")
  assert.equal(started.length, 0)
})

test("execute：持久化确认失败矩阵 → 均不报成功（§7）", async () => {
  const noPersist = makeTool({ sessionPersistence: undefined })
  assert.equal((await noPersist.tool.execute({ description: "d", prompt: "p", target: { tier: "junior" } }, EXEC)).code, "TW_SUB_PERSISTENCE_UNAVAILABLE")
  const noSession = makeTool({ sessions: { get: () => undefined, flush: async () => true }, sessionPersistence: {} })
  assert.equal((await noSession.tool.execute({ description: "d", prompt: "p", target: { tier: "junior" } }, EXEC)).code, "TW_SUB_SESSION_MISSING")
  const flushFalse = makeTool({ sessions: { get: (id) => ({ id }), flush: async () => false }, sessionPersistence: {} })
  assert.equal((await flushFalse.tool.execute({ description: "d", prompt: "p", target: { tier: "junior" } }, EXEC)).code, "TW_SUB_NOT_PERSISTED")
  const flushThrow = makeTool({ sessions: { get: (id) => ({ id }), flush: async () => { throw new Error("disk full") } }, sessionPersistence: {} })
  assert.equal((await flushThrow.tool.execute({ description: "d", prompt: "p", target: { tier: "junior" } }, EXEC)).code, "TW_SUB_FLUSH_FAILED")
})

test("execute：确认失败会停止并释放已创建子会话，回收失败禁止重试", async () => {
  const drained = []
  const { tool, started, selections } = makeTool({
    sessions: { get: (id) => ({ id }), flush: async () => false },
    subagents: {
      getProvider: () => ({ prepareContinuable: async () => ({}) }),
      startContinuable: async (spec) => {
        started.push(spec)
        return { childId: spec.childId, messageId: "m" }
      },
      drainContinuableChildren: async (parent, childIds) => { drained.push({ parent, childIds }) },
    },
  })
  const card = await tool.execute({ description: "d", prompt: "p", target: { tier: "junior" } }, EXEC)
  assert.equal(card.code, "TW_SUB_NOT_PERSISTED")
  assert.match(card.message, /可在修复原因后重试/)
  assert.equal(started.length, 1)
  assert.deepEqual(drained, [{ parent: EXEC.agent, childIds: [started[0].childId] }])
  assert.equal(selections.size, 0)

  const blocked = makeTool({
    sessions: { get: (id) => ({ id }), flush: async () => false },
    subagents: {
      getProvider: () => ({ prepareContinuable: async () => ({}) }),
      startContinuable: async (spec) => ({ childId: spec.childId, messageId: "m" }),
      drainContinuableChildren: async () => { throw new Error("cleanup unavailable") },
    },
  })
  const blockedCard = await blocked.tool.execute({ description: "d", prompt: "p", target: { tier: "junior" } }, EXEC)
  assert.equal(blockedCard.code, "TW_SUB_CLEANUP_FAILED")
  assert.match(blockedCard.message, /请勿重试/)
})

test("execute：post-start 会话读取抛错时统一回收并清理选择", async () => {
  const drained = []
  const { tool, started, selections } = makeTool({
    sessions: { get: () => { throw new Error("session store unavailable") }, flush: async () => true },
    subagents: {
      getProvider: () => ({ prepareContinuable: async () => ({}) }),
      startContinuable: async (spec) => { started.push(spec); return { childId: spec.childId } },
      drainContinuableChildren: async (parent, childIds) => { drained.push({ parent, childIds }) },
    },
  })
  const card = await tool.execute({ description: "d", prompt: "p", target: { tier: "junior" } }, EXEC)
  assert.equal(card.code, "TW_SUB_SESSION_READ_FAILED")
  assert.deepEqual(drained, [{ parent: EXEC.agent, childIds: [started[0].childId] }])
  assert.equal(selections.size, 0)
})

test("execute：首 request/header 缺失（限时等待超时）→ PENDING；错配 → MISMATCH；均回收不报成功", async () => {
  const header = (config) => ({ type: "request/header", data: { header: { config } } })
  const fastWait = { firstHeaderWaitMs: 120, firstHeaderPollMs: 20 }
  // 缺失：限时等待超时 → PENDING（与真错配区分；§7 真实宿主实测的时序路径）
  const missing = makeTool({ sessions: { get: () => ({ events: [] }), flush: async () => true } }, fastWait)
  const cardMissing = await missing.tool.execute({ description: "d", prompt: "p", target: { tier: "senior" } }, EXEC)
  assert.equal(cardMissing.code, "TW_SUB_FIRST_REQUEST_PENDING")
  assert.match(cardMissing.message, /未持久化/)
  assert.equal(missing.selections.size, 0, "超时后必须清理待注入选择")
  const cases = [
    { name: "provider 错配", events: [header({ provider: "wrong", model: "m-s1", reasoningEffort: "medium" })] },
    { name: "model 错配", events: [header({ provider: "p-a", model: "wrong", reasoningEffort: "medium" })] },
    { name: "effort 错配", events: [header({ provider: "p-a", model: "m-s1", reasoningEffort: "low" })] },
  ]
  for (const entry of cases) {
    const { tool, selections } = makeTool({ sessions: { get: () => ({ events: entry.events }), flush: async () => true } }, fastWait)
    const card = await tool.execute({ description: "d", prompt: "p", target: { tier: "senior" } }, EXEC)
    assert.equal(card.code, "TW_SUB_FIRST_REQUEST_MISMATCH", entry.name)
    assert.equal(selections.size, 0, entry.name + " 后必须清理待注入选择")
  }
})

test("execute：首 header 延迟落盘（真实宿主时序）→ 轮询等到后核验成功（§7 验收发现的缺陷回归）", async () => {
  const events = []
  const { tool } = makeTool(
    {
      sessions: {
        get: () => ({ events }),
        flush: async () => true,
      },
      subagents: {
        getProvider: () => ({ prepareContinuable: async () => ({}) }),
        startContinuable: async (spec) => {
          // 模拟真实宿主：inbox 接受后首请求异步延迟发出、header 延迟落盘
          setTimeout(() => {
            events.push({ type: "request/header", data: { header: { config: { provider: "p-a", model: "m-s1", reasoningEffort: "medium" } } } })
          }, 120)
          return { childId: spec.childId, messageId: "m" }
        },
        drainContinuableChildren: async () => {},
      },
    },
    { firstHeaderWaitMs: 3000, firstHeaderPollMs: 20 }
  )
  const card = await tool.execute({ description: "d", prompt: "p", target: { tier: "senior" } }, EXEC)
  assert.equal(card.ok, true, JSON.stringify(card))
  assert.equal(card.model, "m-s1")
  assert.equal(card.effort, "medium")
})

test("execute：并行创建两个不同模型，选择按 sessionId 隔离不串线；selection 与 agentOptions 同值（§7 + §10.3 风险 2）", async () => {
  const taken = []
  const shared = new Map()
  const { tool: tool2, started } = makeTool(
    {
      subagents: {
        getProvider: () => ({ prepareContinuable: async () => ({}) }),
        startContinuable: async (spec) => {
          taken.push({ childId: spec.childId, direct: shared.get(spec.childId), agentOptions: spec.request.agentOptions })
          shared.delete(spec.childId)
          return { childId: spec.childId, messageId: "m" }
        },
        drainContinuableChildren: async () => {},
      },
      sessions: {
        get: (id) => {
          const entry = taken.find((item) => item.childId === id)
          return { events: [{ type: "request/header", data: { header: { config: entry?.direct } } }] }
        },
        flush: async () => true,
      },
    },
    { directSelections: shared }
  )
  const [cardA, cardB] = await Promise.all([
    tool2.execute({ description: "a", prompt: "pa", target: { tier: "junior" } }, EXEC),
    tool2.execute({ description: "b", prompt: "pb", target: { provider: "p-c", model: "m-e1", effort: "high" } }, EXEC),
  ])
  assert.equal(cardA.model, "m-j1")
  assert.equal(cardB.model, "m-e1")
  assert.notEqual(cardA.sessionId, cardB.sessionId)
  assert.equal(taken.length, 2)
  for (const entry of taken) {
    assert.ok(entry.direct, "每次创建须能按 childId 取到直接选择")
    assert.equal(entry.direct.provider, entry.agentOptions.provider, "selection 与 agentOptions 同源（R2）")
    assert.equal(entry.direct.model, entry.agentOptions.model, "selection 与 agentOptions 同源（R2）")
  }
  const byModel = Object.fromEntries(taken.map((t) => [t.agentOptions.model, t]))
  assert.equal(byModel["m-j1"].direct.reasoningEffort, undefined)
  assert.equal(byModel["m-e1"].direct.reasoningEffort, "high")
})

// ── 文案同源（§3.6/§3.7：工具说明、systemPrompt、价值主张三处一致） ─────────

test("工具说明与 systemPrompt 同源：含三档价值主张、非工作流可用、决策表与分阶段标注", () => {
  const desc = toolDescriptionText()
  const section = systemPromptSection()
  for (const tier of TIER_NAMES) {
    assert.ok(desc.includes(TIER_VALUE_PROPS[tier]), "工具说明含 " + tier + " 价值主张")
    assert.ok(section.text.includes(TIER_VALUE_PROPS[tier]), "systemPrompt 含 " + tier + " 价值主张")
  }
  assert.match(desc, /不处于 team-work 工作流时同样可用/)
  assert.ok(desc.includes(decisionTableText()))
  assert.ok(section.text.includes(decisionTableText()))
  assert.match(desc, /第一阶段 team-work 正式首派仍用原生 subagent/)
  assert.equal(section.name, "team-work-dsh:tw-tool-subagent")
  assert.ok(section.order >= 100 && section.order <= 199, "section order 落在工具引导区")
  assert.ok(tierValuePropsText().split("\n").length === 3)
})

test("工具定义注册名与形态", () => {
  const { tool } = makeTool()
  assert.equal(tool.name, TOOL_NAME)
  assert.equal(tool.name, "tw-tool-subagent")
  assert.equal(typeof tool.isConcurrencySafe, "function")
  assert.equal(tool.isConcurrencySafe(), true)
  assert.equal(typeof tool.timeoutMs, "number")
})

// ── recallFromHeader（§10.3 风险 1：effort 冷恢复） ────────────────────────

test("recallFromHeader：最近 header 同源回读 provider/model；effort 可选", () => {
  const header = (config) => ({ type: "request/header", data: { header: { config }, reason: "change" } })
  assert.deepEqual(
    recallFromHeader([header({ provider: "p-a", model: "m-s1", reasoningEffort: "medium" })]),
    { provider: "p-a", model: "m-s1", reasoningEffort: "medium" }
  )
  assert.deepEqual(
    recallFromHeader([
      header({ provider: "p-old", model: "m-0", reasoningEffort: "low" }),
      header({ provider: "p-a", model: "m-s1", reasoningEffort: "high" }),
    ]),
    { provider: "p-a", model: "m-s1", reasoningEffort: "high" }
  )
  assert.deepEqual(
    recallFromHeader([header({ provider: "p-a", model: "m-s1" })]),
    { provider: "p-a", model: "m-s1" },
    "无 effort 仍是持久化的精确选择"
  )
  assert.equal(recallFromHeader([]), null)
  assert.equal(recallFromHeader(null), null)
  assert.equal(recallFromHeader([{ type: "other" }]), null)
})

// ── setup 贡献：直接选择通道与回读通道（inject.js 集成） ─────────────────────

function makeContribution(directSelections, events = []) {
  const installed = []
  const contribution = makeInjectContribution(
    { logger: { warn() {}, info() {} } },
    {
      installerNow: () => (childCtx, selection) => { installed.push(selection); return () => {} },
      directSelections,
    }
  )
  const childCtx = { agent: { id: "child-uuid-1", session: { header: { cwd: "/tmp" }, events } } }
  return { contribution, childCtx, installed }
}

test("contribution：直接选择 take-once 命中即注入；不走标签/回读；第二次不再命中", () => {
  const selections = new Map([["child-uuid-1", { provider: "p-a", model: "m-s1", reasoningEffort: "medium" }]])
  const events = [{ type: "request/header", data: { header: { config: { provider: "p-x", model: "m-x", reasoningEffort: "low" } } } }]
  const { contribution, childCtx, installed } = makeContribution(selections, events)
  const dispose = contribution(childCtx)
  assert.equal(installed.length, 1)
  assert.deepEqual(installed[0].current, { provider: "p-a", model: "m-s1", reasoningEffort: "medium" })
  assert.equal(selections.size, 0, "take-once：消费后删除")
  assert.equal(installed[0].current.provider, "p-a", "直接选择优先于 header 回读（p-x 未生效）")
  if (typeof dispose === "function") dispose()
})

test("contribution：cold-resume 的 header 优先于合法标签链，保持持久化的已确认选择", () => {
  const directSelections = new Map()
  const installed = []
  const contribution = makeInjectContribution(
    { logger: { warn() {}, info() {} } },
    {
      directSelections,
      installerNow: () => (_childCtx, selection) => { installed.push(selection); return () => {} },
      accessSync: () => {},
      readFileSync: () => JSON.stringify({ tagHints: { "CR·owner": { provider: "p-tag", model: "m-tag", effort: "low" } } }),
    }
  )
  contribution({
    agent: {
      id: "child-uuid-1",
      session: {
        header: { cwd: "/tmp" },
        events: [
          { type: "subagent/descriptor", data: { label: "CR·owner · 合法标签 #task-x" } },
          { type: "request/header", data: { header: { config: { provider: "p-header", model: "m-header", reasoningEffort: "high" } } } },
        ],
      },
    },
  })
  assert.deepEqual(installed[0]?.current, { provider: "p-header", model: "m-header", reasoningEffort: "high" })
})

test("contribution：无直接选择时按 header 回读重建（effort 冷恢复路径）", () => {
  const events = [
    { type: "subagent/descriptor", data: { label: "自由文本描述（无机器段）" } },
    { type: "request/header", data: { header: { config: { provider: "p-a", model: "m-s1", reasoningEffort: "medium" } } } },
  ]
  const { contribution, childCtx, installed } = makeContribution(new Map(), events)
  contribution(childCtx)
  assert.deepEqual(installed[0]?.current, { provider: "p-a", model: "m-s1", reasoningEffort: "medium" })
})

test("contribution：cold-resume 的无 effort header 优先于合法旧标签链", () => {
  const installed = []
  const contribution = makeInjectContribution(
    { logger: { warn() {}, info() {} } },
    {
      directSelections: new Map(),
      installerNow: () => (_childCtx, selection) => { installed.push(selection); return () => {} },
      accessSync: () => {},
      readFileSync: () => JSON.stringify({ tagHints: { "CR·owner": { provider: "p-tag", model: "m-tag", effort: "low" } } }),
    }
  )
  contribution({
    agent: {
      id: "child-uuid-1",
      session: {
        header: { cwd: "/tmp" },
        events: [
          { type: "subagent/descriptor", data: { label: "CR·owner · 合法旧标签 #task-x" } },
          { type: "request/header", data: { header: { config: { provider: "p-header", model: "m-header" } } } },
        ],
      },
    },
  })
  assert.deepEqual(installed[0]?.current, { provider: "p-header", model: "m-header" })
})

test("contribution：直接选择与冷恢复在 setup 返回后保持监听器，显式释放时才注销", () => {
  const header = (config) => ({ type: "request/header", data: { header: { config } } })
  const cases = [
    {
      name: "直接选择",
      directSelections: new Map([["child-uuid-1", { provider: "p-direct", model: "m-direct", reasoningEffort: "high" }]]),
      events: [],
      expected: { provider: "p-direct", model: "m-direct", reasoningEffort: "high" },
    },
    {
      name: "冷恢复",
      directSelections: new Map(),
      events: [header({ provider: "p-recalled", model: "m-recalled", reasoningEffort: "medium" })],
      expected: { provider: "p-recalled", model: "m-recalled", reasoningEffort: "medium" },
    },
  ]
  for (const entry of cases) {
    let active = false
    let unregisters = 0
    let selection
    const contribution = makeInjectContribution(
      { logger: { warn() {}, info() {} } },
      {
        directSelections: entry.directSelections,
        installerNow: () => (_childCtx, installedSelection) => {
          active = true // 模拟 installModelSelection 注册 system-prompt/assemble 与 agent/request 监听器
          selection = installedSelection
          return () => { active = false; unregisters++ }
        },
      }
    )
    const dispose = contribution({ agent: { id: "child-uuid-1", session: { header: { cwd: "/tmp" }, events: entry.events } } })
    assert.equal(typeof dispose, "function", entry.name + " setup 必须返回宿主 disposer")
    assert.equal(active, true, entry.name + " setup 返回后监听器仍须存活，首请求才能注入")
    assert.equal(unregisters, 0, entry.name + " setup 不得提前调用安装器 disposer")
    assert.deepEqual(selection.current, entry.expected, entry.name + " 首请求选择必须在 setup 同步段就绪")
    dispose()
    assert.equal(active, false, entry.name + " 仅宿主显式释放时才注销监听器")
    assert.equal(unregisters, 1, entry.name + " 注销一次")
  }
})

// ── index.js 装配集成 ───────────────────────────────────────────────────────

test("index 装配：注册两工具 + systemPrompt section + 共享直接选择表（工具写入 → 贡献 take）", async () => {
  const registered = []
  const sections = []
  const setups = []
  const installedSelections = []
  const ctx = {
    logger: { warn() {}, info() {} },
    tools: { register(def) { registered.push(def) } },
    subagents: {
      registerContinuableSetup(fn) { setups.push(fn); return () => {} },
      getProvider: () => ({ prepareContinuable: async () => ({}) }),
      startContinuable: async (spec) => {
        // 模拟宿主 materialize：同步执行 setup 贡献（真实链路中 contribution 在此期间跑）
        setups[0]({ agent: { id: spec.childId, session: { header: { cwd: "/tmp" }, events: [] } } })
        return { childId: spec.childId, messageId: "m1" }
      },
      drainContinuableChildren: async () => {},
    },
    llm: { resolveCallConfig: async (config) => ({ ...config }) },
    sessions: {
      get: (id) => ({
        id,
        events: [{ type: "request/header", data: { header: { config: installedSelections[0]?.current } } }],
      }),
      flush: async () => true,
    },
    sessionPersistence: {},
    systemPrompt: { section(s) { sections.push(s); return () => {} } },
  }
  const tiers = { tiers: { junior: [{ provider: "p-a", model: "m-j1" }] } }
  const dispose = await hostPlugin.apply(ctx, {}, {
    resolveInstaller: async () => (childCtx, selection) => { installedSelections.push(selection); return () => {} },
    installPluginSettings: () => () => tiers,
    registerEmbeddedSkill: async () => {},
  })
  try {
    assert.deepEqual(registered.map((d) => d.name), ["tw", "tw-tool-subagent"])
    assert.equal(sections.length, 1)
    assert.equal(sections[0].name, "team-work-dsh:tw-tool-subagent")
    assert.ok(sections[0].text.includes(TIER_VALUE_PROPS.senior))
    assert.equal(setups.length, 1)
    // 共享链路：工具 execute 写入直接选择 → startContinuable 内贡献 take → 注入。
    const tool = registered.find((d) => d.name === "tw-tool-subagent")
    const card = await tool.execute({ description: "d", prompt: "p", target: { tier: "junior" } }, {
      agent: { id: "parent" },
    })
    assert.equal(card.ok, true, JSON.stringify(card))
    assert.equal(card.model, "m-j1")
    assert.deepEqual(installedSelections[0]?.current, { provider: "p-a", model: "m-j1" })
  } finally {
    if (typeof dispose === "function") dispose()
  }
})

test("index 装配：安装器不可用时定向委派创建前失败", async () => {
  const registered = []
  let starts = 0
  const ctx = {
    logger: { warn() {}, info() {} },
    tools: { register(def) { registered.push(def) } },
    subagents: {
      registerContinuableSetup() { return () => {} },
      getProvider: () => ({ prepareContinuable() {} }),
      startContinuable: async () => { starts++ },
      drainContinuableChildren: async () => {},
    },
    llm: { resolveCallConfig: async (config) => ({ ...config }) },
    sessions: { get: () => ({ events: [] }), flush: async () => true },
    sessionPersistence: {},
  }
  const dispose = await hostPlugin.apply(ctx, {}, {
    resolveInstaller: async () => null,
    installPluginSettings: () => () => TIERS_SNAPSHOT,
    registerEmbeddedSkill: async () => {},
    installerRetryMs: 1,
  })
  try {
    const tool = registered.find((d) => d.name === "tw-tool-subagent")
    const card = await tool.execute({ description: "d", prompt: "p", target: { tier: "senior" } }, EXEC)
    assert.equal(card.code, "TW_SUB_MODEL_INJECTION_UNAVAILABLE")
    assert.equal(starts, 0)
  } finally {
    dispose()
  }
})

test("index 装配：systemPrompt 服务缺失时降级 warn，不阻塞工具注册", async () => {
  const registered = []
  const warns = []
  const ctx = {
    logger: { warn(m) { warns.push(m) }, info() {} },
    tools: { register(def) { registered.push(def) } },
    subagents: { registerContinuableSetup() { return () => {} } },
  }
  const dispose = await hostPlugin.apply(ctx, {}, {
    resolveInstaller: async () => (childCtx, selection) => () => {},
    installPluginSettings: () => () => ({}),
    registerEmbeddedSkill: async () => {},
  })
  try {
    assert.deepEqual(registered.map((d) => d.name), ["tw", "tw-tool-subagent"])
    assert.ok(warns.some((m) => m.includes("systemPrompt 服务不可用")))
  } finally {
    if (typeof dispose === "function") dispose()
  }
})

test("Cordis 服务守卫：host 可选 systemPrompt 与工具运行期服务只经 ctx.get 查询", async () => {
  const registered = []
  const sections = []
  const selections = new Map()
  const services = {
    logger: { warn() {}, info() {} },
    tools: { register(def) { registered.push(def) } },
    skills: {},
    subagents: {
      registerContinuableSetup() { return () => {} },
      getProvider: () => ({ prepareContinuable() {} }),
      startContinuable: async (spec) => ({ childId: spec.childId, messageId: "m1" }),
      drainContinuableChildren: async () => {},
    },
    llm: { resolveCallConfig: async (config) => ({ ...config }) },
    sessions: {
      get(id) {
        return {
          id,
          events: [{ type: "request/header", data: { header: { config: selections.get(id) } } }],
        }
      },
      flush: async () => true,
    },
    sessionPersistence: {},
    systemPrompt: { section(section) { sections.push(section); return () => {} } },
  }
  const ctx = guardedContext(services, hostPlugin.inject)
  const dispose = await hostPlugin.apply(ctx, {}, {
    resolveInstaller: async () => (_childCtx, selection) => {
      // 工具与 setup 共享表的真实路径由其他集成测试覆盖；本用例只锁定服务访问协议。
      return () => {}
    },
    installPluginSettings: () => () => TIERS_SNAPSHOT,
    registerEmbeddedSkill: async () => {},
  })
  try {
    assert.equal(sections.length, 1, "未声明的可选 systemPrompt 必须经 ctx.get 正常取得")
    const tool = registered.find((definition) => definition.name === "tw-tool-subagent")
    // 让首请求确认读取到工具生成的同一选择。
    services.subagents.startContinuable = async (spec) => {
      selections.set(spec.childId, { provider: "p-a", model: "m-j1" })
      return { childId: spec.childId, messageId: "m1" }
    }
    const card = await tool.execute({ description: "d", prompt: "p", target: { tier: "junior" } }, EXEC)
    assert.equal(card.ok, true, JSON.stringify(card))
  } finally {
    if (typeof dispose === "function") dispose()
  }
})

// ── badge.js @ 候选（§3.5/§3.7：描述与 host 价值主张字面同文） ───────────────

async function loadBadgeClient() {
  const registrations = []
  const source = await readFile(new URL("../dsh/client/badge.js", import.meta.url), "utf8")
  vm.runInNewContext(source, {
    globalThis: {},
    window: { __ModuleLoader__: { load(registration) { registrations.push(registration) } } },
  })
  return registrations[0]
}

test("badge 客户端：注册 @ 档位候选，描述与 TIER_VALUE_PROPS 字面同文，onPick 写入可见意图", async () => {
  const registration = await loadBadgeClient()
  let source = null
  const ctx = {
    logger: { warn() {} },
    inputTriggers: { registerSource(s) { source = s; return () => {} } },
    slots: { inject() {}, register() { return () => {} } },
    sessions: {},
    settingsScope: undefined,
  }
  const plugin = registration.factory(() => ({}))
  plugin.apply(ctx)
  assert.ok(source, "须注册 @ 候选源")
  assert.equal(source.trigger, "@")
  // 宿主契约：candidates 必须返回 Promise（InputTriggerController.fetchCandidates 直接调 .then）
  const pending = source.candidates({ sessionId: "s" }, { query: "" })
  assert.equal(typeof pending?.then, "function", "candidates 须返回 Promise（同步数组会炸掉宿主 @ 菜单）")
  const candidates = await pending
  assert.deepEqual([...candidates].map((c) => c.name), ["junior", "senior", "expert"])
  for (const candidate of candidates) {
    assert.equal(candidate.description, TIER_VALUE_PROPS[candidate.name], "描述与 host 价值主张字面同文")
  }
  const filtered = await source.candidates({ sessionId: "s" }, { query: "ju" })
  assert.deepEqual([...filtered].map((c) => c.name), ["junior"])
  // insert 形态：与文件/会话引用一致的标记 chip（非提示词文本）；vm realm 对象用 JSON 比较
  assert.equal(
    JSON.stringify(source.onPick({ candidate: { name: "senior" } })),
    JSON.stringify({ insert: { source: "tw-tier", ref: "@senior", label: "senior", appearance: "session", clipboardText: "@senior" } })
  )
  assert.equal(JSON.stringify(source.onPick({ candidate: { name: "unknown" } })), JSON.stringify({ text: "" }), "无效候选不得生成伪造委派意图")
  // codec：insert 源必须提供，提交时序列化为模型可读的委派指令
  assert.equal(typeof source.codec?.serialize, "function", "insert 源必须提供 codec.serialize")
  assert.equal(await source.codec.serialize("@senior"), "[委派 @senior]（请以该档位调用 tw-tool-subagent 创建子代理）")
  assert.equal(source.codec.clipboardText("@senior"), "@senior")
  assert.deepEqual([...source.lexicon({ sessionId: "s" })], ["junior", "senior", "expert"])
})

test("badge 客户端：无 inputTriggers 时降级 warn 不抛错（§3.2 尾段）", async () => {
  const registration = await loadBadgeClient()
  const warns = []
  const ctx = {
    logger: { warn(m) { warns.push(m) } },
    slots: { inject() {}, register() { return () => {} } },
    sessions: {},
    settingsScope: undefined,
  }
  const plugin = registration.factory(() => ({}))
  plugin.apply(ctx)
  assert.ok(warns.some((m) => m.includes("inputTriggers 不可用")))
})

test("Cordis 服务守卫：badge 通过 ctx.get 查询可选 inputTriggers，不阻塞 Web 装载", async () => {
  const registration = await loadBadgeClient()
  const plugin = registration.factory(() => ({}))
  let source = null
  const services = {
    logger: { warn() {} },
    inputTriggers: { registerSource(candidateSource) { source = candidateSource; return () => {} } },
    slots: { inject() {}, register() { return () => {} } },
    sessions: {},
    connection: {},
    settingsScope: undefined,
  }
  const ctx = guardedContext(services, plugin.inject)
  assert.doesNotThrow(() => plugin.apply(ctx))
  assert.equal(source?.trigger, "@")
})
