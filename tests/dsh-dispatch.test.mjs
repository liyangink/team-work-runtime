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
  deterministicSessionId,
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

// fake 宿主 ctx（返工终版 docs/dispatch-rework-investigation.md §三：5 条宿主行为契约快照，
// 宿主升级需复核；与 dsh-tw-tool-subagent.test.mjs 的对账场景同款语义）：
// 1) sessions.get 只反映活会话（live Map）；
// 2) listSnapshots 只列已物化会话（store Map；created-but-never-appended 不出现——注入
//    materialized=false 即崩溃壳形态）；
// 3) followup 对活/冷会话均入队且接受即落盘（write-behind ≤200ms 时延不模拟——模拟的是崩溃
//    截断的静态形态；冷会话 followup = 鉴权（须精确直接父）→ 重建 Agent → 消息入队）；
// 4) events 形态：header.seedLength + seed 事件（descriptor-only）与 own-suffix 的
//    agent/inbox/spliced(inserted) 粒度；header 带 parentSession 字段；UNAUTHORIZED /
//    DUPLICATE_CHILD / NOT_RESUMABLE 行为与宿主错误码一致（接管冲突支可验证）；
// 5) readRaw 按需读回（冷支判收单；第一行 header，其后每行一个事件）。
function makeCtx(overrides = {}) {
  const started = []
  const drained = []
  const followups = []
  const live = new Map() // 活会话（id → { id, header, events }）——sessions.get 的唯一事实源
  const store = new Map() // 已物化持久（id → { header, events }）——listSnapshots/readRaw 的事实源
  let msgSeq = 0
  const headerOf = (id, parentSession, seedLength = 0) => ({ id, version: 0, createdAt: 0, parentSession, seedLength, origin: "subagent" })
  const splice = (session, text) => {
    session.events.push({
      type: "agent/inbox/spliced",
      seq: session.events.length + 1,
      time: 0,
      data: { target: "next-turn", start: 0, inserted: [{ id: "msg-" + (++msgSeq), role: "user", content: [{ type: "text", text }] }] },
    })
  }
  const persist = (session) => {
    store.set(session.id, { header: { ...session.header }, events: session.events.map((e) => ({ ...e, data: structuredClone(e.data) })) })
  }
  const unauthorized = () => Object.assign(new Error("belongs to another parent session"), { code: "UNAUTHORIZED" })
  const ctx = {
    llm: { resolveCallConfig: async (config) => ({ ...config }) },
    subagents: {
      getProvider: () => ({ name: "spawn", prepareContinuable: async () => ({}) }),
      startContinuable: async (spec) => {
        const childId = spec.childId ?? "gen-" + (++msgSeq)
        // 宿主判重：活会话 + （显式 childId 才查）持久快照 → DUPLICATE_CHILD
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
      followup: async (parent, childId, content, options) => {
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
        listSnapshots: async () => [...store.values()].map((s, i) => ({ header: { ...s.header }, revision: "r" + i })),
        readRaw: async (id) => {
          const s = store.get(id)
          if (!s) return undefined
          return { meta: { ...s.header }, filename: id + ".jsonl", content: [JSON.stringify(s.header), ...s.events.map((e) => JSON.stringify(e))].join("\n") }
        },
        inspect: async (id) => {
          const s = store.get(id)
          if (!s) throw Object.assign(new Error("not found"), { code: "NOT_RESUMABLE" })
          return { meta: { ...s.header }, events: s.events.map((e) => ({ ...e, data: structuredClone(e.data) })) }
        },
      },
    ...overrides,
  }
  return {
    ctx, started, drained, followups,
    // 活会话注入：received=null 为 descriptor-only（未收单）；seedEvents/seedLength 构造 fork 形态
    injectLive(id, { received = null, parentSession = EXEC.agent.id, seedLength = 0, seedEvents = [] } = {}) {
      const session = { id, header: headerOf(id, parentSession, seedLength), events: [...seedEvents, { type: "subagent/descriptor", seq: seedEvents.length + 1, time: 0, data: { mode: "continuable" } }] }
      if (received != null) splice(session, received)
      live.set(id, session)
      return session
    },
    // 冷持久注入：materialized=false = 未物化崩溃壳（不出现在 listSnapshots——契约 2）
    injectCold(id, { received = null, parentSession = EXEC.agent.id, materialized = true, seedLength = 0, seedEvents = [] } = {}) {
      const session = { id, header: headerOf(id, parentSession, seedLength), events: [...seedEvents, { type: "subagent/descriptor", seq: seedEvents.length + 1, time: 0, data: { mode: "continuable" } }] }
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
  const selections = deps.directSelections ?? new Map()
  const tool = twDispatchDefinition(made.ctx, { directSelections: selections, ...deps })
  return { tool, ...made, selections }
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

// ── 三步集成成功路径（§5：dispatch-plan → 创建 → 登记） ────────────────────────

test("三步集成：真实创建核心 + agent-map 登记；先登记后创建，确定性 sessionId；标签/注入选择/登记参数全部对齐", async () => {
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
  // 先登记后创建（§8）：calls[1] 是 agent-map（确定性 sessionId），创建在其后
  const fixedId = deterministicSessionId("demo-t", "d1-abc123")
  assert.deepEqual(calls[1].args, ["agent-map", "--task", "demo-t", "--key", "d1-abc123", "--agent", fixedId])
  assert.equal(started.length, 1)
  const spec = started[0]
  assert.equal(spec.childId, fixedId, "确定性 sessionId：同 key 重试推导同一 id（防双发基石）")
  assert.equal(spec.label, "IMPL·owner · 接口改造 #demo-t", "标签按派单事实 + note 自动拼接")
  assert.equal(spec.request.prompt[0].text, "派单全文 PROMPT", "prompt 原样转发")
  assert.deepEqual(spec.request.agentOptions, { provider: "p-a", model: "m-j1" }, "target 直取 modelHint（effort 走直接选择）")
  assert.deepEqual(selectionAtStart, { provider: "p-a", model: "m-j1" }, "直接选择经共享通道写入（宿主 take-once 时机在场）")
  assert.equal(selections.size, 0, "启动确认成功后核心清理表项")

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
  assert.deepEqual(started[0].request.agentOptions, { provider: "p-c", model: "m-e1" })
})

test("writables 省略时 dispatch-plan 不带 --writable 参数", async () => {
  const { runTw, calls } = makeRunTw(planCard([ownerWave()]))
  const { tool } = makeTool({ runTw })
  await tool.execute({ task: "demo-t" }, EXEC)
  assert.deepEqual(calls[0].args, ["dispatch-plan", "--task", "demo-t", "--json"])
})

// ── 多包逐项（§3.5：逐张串行创建+登记，返回数组） ─────────────────────────────

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
  // 每张派单都是「登记 → 创建」，且 sessionId 是从 key 确定性推导的
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

// ── 登记失败（§3.6：部分成功 + 补登记指引） ───────────────────────────────────

test("登记失败：尚未创建子会话（先登记后创建），原样重试安全不双发；成功项不回滚", async () => {
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
  // §8 语义升级：登记失败发生在创建之前——没有任何子会话残留，重试安全（旧序会留下在跑会话 + 双发窗口）
  assert.equal(bad.sessionId, undefined, "未创建子会话")
  assert.equal(started.length, 1, "仅成功那张派单创建了子会话")
  assert.equal(drained.length, 0, "登记失败不触发回收语义")
  assert.match(bad.message, /尚未创建子会话（先登记后创建），原样重试安全、不会双发/)
  assert.match(bad.message, /tw retire --task demo-t --wave wv1/)
})

// ── 创建失败（§3.6：该项错误卡；已创建子会话按核心回收语义处理；不登记） ──────────

test("创建失败：模型验证失败不留子会话（映射已登记，确定性对账使重试幂等）；继续处理后续派单", async () => {
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
  assert.match(out.dispatched[0].message, /原样重试安全（判定链幂等收敛）/)
  assert.equal(out.dispatched[0].sessionId, deterministicSessionId("demo-t", "d1-bad"), "回执带确定性 sessionId（已登记未创建）")
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 2, "两张派单都先登记（§8：登记在验证之前）")
  assert.equal(out.dispatched[1].ok, true, "单张失败不阻断后续")
  assert.equal(out.failures, 1)
})

test("创建失败：startContinuable 抛错 → 清理待注入选择；映射已登记、重试安全", async () => {
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
  assert.equal(out.dispatched[0].sessionId, deterministicSessionId("demo-t", "d1-abc123"))
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 1, "登记已发生（先登记后创建）")
  assert.match(out.dispatched[0].message, /原样重试安全/)
})

test("创建失败：flush 未确认 → 核心回收未确认子会话（drain 被调）；重试时确定性对账走同 id 重建", async () => {
  // 默认 fake（对账期 missing、确认期在场）+ flush 恒 false：命中「创建后启动未确认持久化」失败路径
  const { ctx } = makeCtx()
  ctx.sessions.flush = async () => false
  const { runTw, calls } = makeRunTw(planCard([ownerWave()]))
  const tool = twDispatchDefinition(ctx, { runTw })
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  assert.equal(out.dispatched[0].code, "TW_SUB_NOT_PERSISTED")
  assert.match(out.dispatched[0].message, /已停止并释放未确认子会话/)
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 1, "登记已发生（先登记后创建）")
  assert.match(out.dispatched[0].message, /原样重试安全/)
})

// ── continuation 波归属（判定链四态：活→等待 / 冷归属一致→冷唤醒投增量或全量 / 断链→全量重建）──

test("continuation 且有 expectedAgentId（会话在场）：统一等待不重投（用户终裁②），不创建不登记", async () => {
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
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 0, "续派在场不登记新映射")
  assert.match(item.message, /等待成员完成通知/)
  assert.match(item.message, /催单用 send_message/)

  // 重入幂等：再次调用仍等待、仍不投递（活→等待是重入稳定态）
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
  // 曾收单（有上一轮上下文）→ 冷唤醒投本轮增量变体
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

  // 从未收单（无上下文）→ 冷唤醒投全量变体
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


// ── §7.3 wait-inflight 兜底矩阵（崩溃窗口恢复；三分支优先级 §7.5.8） ─────────────

// wait-inflight stop 卡样例（形状对齐 runtime-v3/cli.mjs cmdDispatchPlan 的 planStop 平铺 extra）
function inflightCard(items, extra = {}) {
  return { ok: true, task: "demo-t", stage: "implementation", stop: "wait-inflight", waves: [], dispatchKey: items[0]?.key ?? "d1-x", inflight: items, card: { status: "wait-inflight" }, ...extra }
}
// inflight 条目样例（形状对齐 cli.mjs inflightDispatches：模型快照/registered 判定事实由 runtime 投影）
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

test("兜底·registered=true 且为未物化崩溃壳（listSnapshots 无记录）→ 同 id 重建合法（宿主判重不认崩溃壳）", async () => {
  const item = inflightItem({ registered: true, mappedAgentId: "mapped-shell" })
  const { runTw } = makeRunTw(inflightCard([item]))
  const { tool, started, storeIds } = makeTool({ runTw })
  // 未物化：live 无、store 无（created-but-never-appended 不出现在 listSnapshots——契约 2）
  const out = await tool.execute({ task: "demo-t" }, EXEC)
  const entry = out.inflight[0]
  assert.equal(entry.ok, true)
  assert.equal(entry.action, "recreated")
  assert.equal(entry.sessionId, "mapped-shell")
  assert.equal(started.length, 1)
  assert.ok(storeIds().includes("mapped-shell"), "创建后经持久化确认物化")
})

// ── Challenger r4 定点回归：分支 2 对续派条目选用全量变体（二阶恢复窗口） ────────────
// 触发链：续派断链 fresh 重建登记成功但创建瞬态失败（如 TW_SUB_START_FAILED）后重入——
// registered=true + mappedAgentId 优先命中分支 2（优先于续派分支 3），投正文的三条路径
//（descriptor-only 补发/冷未收单补发/无记录重建）目标会话都无原上下文，增量变体不可执行。

test("兜底·分支 2 二阶窗口（续派·无记录重建）：registered=true 且 continuation → 同 id 重建投全量变体", async () => {
  const item = inflightItem({
    registered: true, mappedAgentId: "mapped-rebuild-1",
    continuation: true, expectedAgentId: "prior-agent-gone",
    prompt: "续派增量派单正文", promptFull: "续派全量变体：目标+约束+排除内嵌",
  })
  const { runTw } = makeRunTw(inflightCard([item]))
  const { tool, started, followups } = makeTool({ runTw })
  // 无记录：live 无、store 无（断链重建登记成功但创建失败的崩溃窗口重入态）
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

test("兜底·续派：registered=false 且 expectedAgentId 在场 → 统一等待不重投，不创建不登记", async () => {
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
  assert.equal(calls.filter((c) => c.cmd === "agent-map").length, 0)
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
  assert.equal(def.isConcurrencySafe(), false, "§7.3.3 并发保守：同任务连点排队串行，防补派双发")
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
