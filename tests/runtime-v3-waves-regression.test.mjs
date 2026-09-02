// v3.4 波身份与恢复回归（docs/wave-identity-recovery-plan.md §5 验收表第 1-14 行，第 15 行真实 DSH 复验由用户实机执行）
// 覆盖：台账 V3-E2E-01~04 确定性复现（在途幂等 / 身份链 / 轮次分叉 / 旧派单冒充）+
// F5 人工门返工结构因果（blocked/僵局/多包混合）+ F6 双形态（等待期重签 / 二次 accept 不成环）+
// F7 报告 ver + F8 d 前缀命名 + F9 迁移矩阵（合并/幂等/中断重跑/跨阶段/四类恢复）+ F3 retire + B8 混合态 + 五类鲁棒性。
// 断言全部基于已核验的实现行为（实施前以探针脚本在临时目录实测各关键流），不臆造形状。
import test from "node:test"
import assert from "node:assert/strict"
import { writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { tw } from "../runtime-v3/cli.mjs"
import { loadTask } from "../runtime-v3/store.mjs"
import { deriveTask } from "../runtime-v3/derive.mjs"
import { projectRounds, inflightBatch, waveGroups, supersededKeys, effectiveBlockedSet } from "../runtime-v3/waves.mjs"
import { humanDecisionFresh } from "../runtime-v3/gate.mjs"
import { makeProject, caller, openTask, seedConvergedStage, seedDispatch, FIX_WORKFLOW, FIX_POLICY } from "./support/v3-fixtures.mjs"

// dispatch-plan 需要全局 tier 解析（与 topology 测试同款临时 settings）
const settingsFile = path.join(tmpdir(), `tw-waves-tiers-${process.pid}-${Date.now()}.yaml`)
await writeFile(settingsFile, [
  "team-work-dsh:",
  "  tiers:",
  "    junior: { provider: wv-junior, model: wv-junior }",
  "    senior: { provider: wv-senior, model: wv-senior }",
  "    expert: { provider: wv-expert, model: wv-expert }",
  "",
].join("\n"))
process.env.DSH_SETTINGS = settingsFile

const KEY_RE = /^d\d+-[0-9a-f]{6}$/
const VERDICT = { outcome: "accept", rationale: "r", confidence: "high", recommendedAction: "a" }
const PKGS2 = JSON.stringify([
  { id: "store", writable: ["S.md:code-review"], done: ["d"], dependsOn: [] },
  { id: "intake", writable: ["I.md:code-review"], done: ["d"], dependsOn: [] },
])

// 交付文件并按给定摘要登记（摘要进入 payload digest，同摘要同内容重交 = 幂等）
async function deliverContent(call, root, name, key, file, content, summary = "s") {
  await writeFile(path.join(root, file), content, "utf8")
  return call(["deliver", "--task", name, "--key", key, "--outcome", "delivered", "--summary", summary, "--paths", file])
}

async function reviewAccept(call, name, key, verdict = null) {
  return call(["review", "--task", name, "--key", key, "--recommendation", "accept", "--summary", "s",
    ...(verdict ? ["--verdict", JSON.stringify(verdict)] : [])])
}

// 追加任意 journal 事件（迁移分段/损坏输入测试用；seq 自 journal 事实推导，不引入平行权威）
async function appendEvents(root, name, events) {
  const task = await loadTask(root, name, { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const file = path.join(task.root, "journal.jsonl")
  const raw = await readFile(file, "utf8")
  let seq = raw.trim().split("\n").filter((l) => l.trim()).length
  const lines = events.map((e) => JSON.stringify({ seq: ++seq, at: new Date().toISOString(), ...e }) + "\n")
  await writeFile(file, raw + lines.join(""))
}

// —— F1/F8 波身份与命名 ——

test("F1/F8：派发 key 为 d<序号>-<hex>、同批共享 waveId、waveId 全任务递增、dispatched 落盘 waveId", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "wave-id")
  const d1 = await call(["run", "--task", "wave-id", "--writable", "R.md:code-review"])
  assert.match(d1.dispatch.key, KEY_RE, "key 格式 d<序号>-<3字节hex>")
  assert.equal(d1.dispatch.waveId, "wv1")
  await deliverContent(call, root, "wave-id", d1.dispatch.key, "R.md", "v1")
  const rv = await call(["run", "--task", "wave-id"])
  assert.equal(rv.dispatch.role, "challenger")
  assert.equal(rv.dispatch.waveId, "wv2", "下一波严格递增")
  assert.notEqual(rv.dispatch.key, d1.dispatch.key)
  await call(["review", "--task", "wave-id", "--key", rv.dispatch.key, "--recommendation", "rework", "--summary", "需修"])
  const r2 = await call(["run", "--task", "wave-id", "--writable", "R.md:code-review"])
  assert.equal(r2.dispatch.kind, "respond")
  assert.equal(r2.dispatch.waveId, "wv3")
  const task = await loadTask(root, "wave-id", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const details = task.journal.filter((e) => e.type === "dispatched").map((e) => e.detail)
  assert.deepEqual(details.map((d) => d.waveId), ["wv1", "wv2", "wv3"], "journal dispatched.detail 落盘 waveId（F1）")
  assert.ok(details.every((d) => KEY_RE.test(d.key)), "全部 key 均为 d 前缀")
  assert.equal(details[2].causeDecisionId, undefined, "普通 respond（非人工门）不带 causeDecisionId")
})

test("F1/F3：wait-inflight 卡与 dispatch-plan 输出补 waveId；run 派单带 waveId 字段", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "wave-out")
  await call(["run", "--task", "wave-out", "--writable", "R.md:code-review"])
  const w = await call(["run", "--task", "wave-out", "--writable", "R.md:code-review"])
  assert.equal(w.transition, "wait-inflight")
  assert.equal(w.waveId, "wv1", "wait-inflight 卡补 waveId（P4）")
  const plan = await call(["dispatch-plan", "--task", "wave-out", "--json", "--writable", "R.md:code-review"])
  assert.equal(plan.stop, "wait-inflight")
  assert.equal(plan.dispatchKey, w.dispatchKey)
  const task = await loadTask(root, "wave-out", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const wavesOut = await (async () => {
    await deliverContent(call, root, "wave-out", w.dispatchKey, "R.md", "v1")
    const p2 = await call(["dispatch-plan", "--task", "wave-out", "--json"])
    return p2.waves
  })()
  assert.ok(wavesOut.length > 0 && wavesOut.every((x) => /^wv\d+$/.test(x.waveId)), "dispatch-plan 波次输出补 waveId")
  assert.ok(task.journal.some((e) => e.type === "dispatched" && e.detail.waveId === "wv1"))
})

// —— 台账复现 1：人工门 rework 在途幂等（V3-E2E-01）——

test("V3-E2E-01：人工门 rework 后 run×2 / dispatch-plan / 混用 / Promise.all 并发均返回同一 wait-inflight，journal 不增长", async () => {
  const root = await makeProject()
  const { call } = await seedConvergedStage(root, "inflight-t")
  const card = await call(["run", "--task", "inflight-t"])
  assert.equal(card.status, "awaiting-user")
  await call(["decide", "--task", "inflight-t", "--choice", "2", "--note", "返工"])
  const first = await call(["run", "--task", "inflight-t", "--writable", "R.md:code-review"])
  assert.equal(first.next, "dispatch")
  assert.equal(first.dispatch.kind, "respond")
  const key = first.dispatch.key
  // 串行 run
  const again = await call(["run", "--task", "inflight-t", "--writable", "R.md:code-review"])
  assert.equal(again.transition, "wait-inflight")
  assert.equal(again.dispatchKey, key)
  // dispatch-plan
  const plan = await call(["dispatch-plan", "--task", "inflight-t", "--json", "--writable", "R.md:code-review"])
  assert.equal(plan.stop, "wait-inflight")
  assert.equal(plan.dispatchKey, key)
  // 混用 + 并发（任意顺序均幂等）
  const [a, b, c, d] = await Promise.all([
    call(["run", "--task", "inflight-t", "--writable", "R.md:code-review"]),
    call(["dispatch-plan", "--task", "inflight-t", "--json", "--writable", "R.md:code-review"]),
    call(["run", "--task", "inflight-t", "--writable", "R.md:code-review"]),
    call(["dispatch-plan", "--task", "inflight-t", "--json", "--writable", "R.md:code-review"]),
  ])
  assert.ok([a, b, c, d].every((r) => (r.transition ?? r.stop) === "wait-inflight"), "并发/混用全部 wait-inflight")
  assert.ok([a, b, c, d].every((r) => r.dispatchKey === key), "全部返回同一在途 key")
  const task = await loadTask(root, "inflight-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(task.journal.filter((e) => e.type === "dispatched").length, 2, "首推 + 返工 respond 各一条，重复推进零新增（journal 不增长）")
})

test("V3-E2E-01 重启：派发落盘后重新加载推导/重放原 key 不扩大波次", async () => {
  const root = await makeProject()
  const { call } = await seedConvergedStage(root, "restart-t")
  await call(["run", "--task", "restart-t"])
  await call(["decide", "--task", "restart-t", "--choice", "2", "--note", "返工"])
  const first = await call(["run", "--task", "restart-t", "--writable", "R.md:code-review"])
  // 模拟进程崩溃重启：重新从磁盘加载任务，纯函数重推导
  const fresh = await loadTask(root, "restart-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const state = deriveTask(fresh)
  assert.equal(state.next.kind, "wait-inflight", "重启后从事实源重推导仍判在途（F3 守卫）")
  assert.equal(state.next.dispatchKey, first.dispatch.key)
  const replay = await call(["run", "--task", "restart-t", "--writable", "R.md:code-review"])
  assert.equal(replay.transition, "wait-inflight")
  assert.equal(replay.dispatchKey, first.dispatch.key, "重放原 key 返回同一在途卡")
  const task = await loadTask(root, "restart-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(task.journal.filter((e) => e.type === "dispatched").length, 2, "重放不扩大波次")
})

test("门槛 2：多包部分交付后重复推进返回原在途卡、只等未交付包、不提前派 review、不重派已交付包", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "partial-t")
  await call(["plan", "--task", "partial-t", "--packages", PKGS2])
  const d1 = await call(["run", "--task", "partial-t"])
  assert.equal(d1.dispatches.length, 2, "一逻辑波一批：两包共享一个波")
  assert.equal(d1.dispatches[0].waveId, d1.dispatches[1].waveId)
  const kS = d1.dispatches.find((x) => x.package === "store").key
  const kI = d1.dispatches.find((x) => x.package === "intake").key
  await deliverContent(call, root, "partial-t", kS, "S.md", "store v1", "s1")
  const w1 = await call(["run", "--task", "partial-t"])
  assert.equal(w1.transition, "wait-inflight")
  assert.equal(w1.waveId, "wv1")
  assert.equal(w1.inflight.length, 1, "只等未交付包（组合评审等齐语义）")
  assert.equal(w1.inflight[0].package, "intake")
  assert.equal(w1.dispatchKey, kI)
  const w2 = await call(["run", "--task", "partial-t"])
  assert.equal(w2.transition, "wait-inflight", "重复推进返回同一在途卡（幂等）")
  assert.equal(w2.dispatchKey, kI)
  assert.equal(w2.inflight.length, 1)
  const mid = await loadTask(root, "partial-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(mid.journal.filter((e) => e.type === "dispatched").length, 2, "不重派已交付包、journal 不增长")
  assert.equal(mid.reports.some((r) => r.dispatchKey === kS), true, "已交付包报告保留")
  await deliverContent(call, root, "partial-t", kI, "I.md", "intake v1", "s2")
  const next = await call(["run", "--task", "partial-t"])
  assert.equal(next.dispatch.role, "challenger", "全部交付后才进入组合评审（不提前派 review）")
})

// —— 台账复现 2：成员身份链（V3-E2E-02）+ F4 回溯 ——

test("V3-E2E-02：Owner 三轮连续派发 expectedAgentId 始终解析（倒序回溯，非紧邻 key）", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "chain-t")
  const d1 = await call(["run", "--task", "chain-t", "--writable", "R.md:code-review"])
  await call(["agent-map", "--task", "chain-t", "--key", d1.dispatch.key, "--agent", "child-O"])
  await deliverContent(call, root, "chain-t", d1.dispatch.key, "R.md", "v1")
  const rv1 = await call(["run", "--task", "chain-t"])
  await call(["review", "--task", "chain-t", "--key", rv1.dispatch.key, "--recommendation", "rework", "--summary", "需修"])
  const pl1 = await call(["dispatch-plan", "--task", "chain-t", "--json", "--writable", "R.md:code-review"])
  const k2 = pl1.waves[0]
  assert.equal(k2.continuation, true)
  assert.equal(k2.expectedAgentId, "child-O", "第二次续派解析原 Owner（原实现只看紧邻 key 必断）")
  assert.equal(k2.expectedAgentIdMissing, undefined)
  await deliverContent(call, root, "chain-t", k2.dispatchKey, "R.md", "v2")
  const rv2 = await call(["run", "--task", "chain-t"])
  await call(["review", "--task", "chain-t", "--key", rv2.dispatch.key, "--recommendation", "rework", "--summary", "再修"])
  const pl2 = await call(["dispatch-plan", "--task", "chain-t", "--json", "--writable", "R.md:code-review"])
  const k3 = pl2.waves[0]
  assert.equal(k3.expectedAgentId, "child-O", "第三次续派（映射链中间隔无映射 key）仍解析原 Owner")
})

test("F4：replace-owner 后解析新成员（最新映射自然胜出）", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "repl-t")
  const d1 = await call(["run", "--task", "repl-t", "--writable", "R.md:code-review"])
  await call(["agent-map", "--task", "repl-t", "--key", d1.dispatch.key, "--agent", "child-A"])
  await deliverContent(call, root, "repl-t", d1.dispatch.key, "R.md", "v1")
  const rv1 = await call(["run", "--task", "repl-t"])
  await call(["review", "--task", "repl-t", "--key", rv1.dispatch.key, "--recommendation", "rework", "--summary", "需修"])
  const pl1 = await call(["dispatch-plan", "--task", "repl-t", "--json", "--writable", "R.md:code-review"])
  const k2 = pl1.waves[0]
  assert.equal(k2.expectedAgentId, "child-A")
  await call(["agent-map", "--task", "repl-t", "--key", k2.dispatchKey, "--agent", "child-B"])
  await deliverContent(call, root, "repl-t", k2.dispatchKey, "R.md", "v2")
  const rv2 = await call(["run", "--task", "repl-t"])
  await call(["review", "--task", "repl-t", "--key", rv2.dispatch.key, "--recommendation", "rework", "--summary", "再修"])
  const pl2 = await call(["dispatch-plan", "--task", "repl-t", "--json", "--writable", "R.md:code-review"])
  assert.equal(pl2.waves[0].expectedAgentId, "child-B", "replace-owner 后新映射为最近合法映射")
})

test("F4：Challenger 复审 expectedAgentId 可解析（无包波按同角色回溯）", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "chal-t")
  const d1 = await call(["run", "--task", "chal-t", "--writable", "R.md:code-review"])
  await deliverContent(call, root, "chal-t", d1.dispatch.key, "R.md", "v1")
  const pl1 = await call(["dispatch-plan", "--task", "chal-t", "--json"])
  const c1 = pl1.waves[0]
  assert.equal(c1.role, "challenger")
  assert.equal(c1.continuation, false, "首次评审非续派")
  await call(["agent-map", "--task", "chal-t", "--key", c1.dispatchKey, "--agent", "child-C"])
  await call(["review", "--task", "chal-t", "--key", c1.dispatchKey, "--recommendation", "rework", "--summary", "需修"])
  const pl2 = await call(["dispatch-plan", "--task", "chal-t", "--json", "--writable", "R.md:code-review"])
  const k2 = pl2.waves[0]
  await deliverContent(call, root, "chal-t", k2.dispatchKey, "R.md", "v2")
  const pl3 = await call(["dispatch-plan", "--task", "chal-t", "--json"])
  const c2 = pl3.waves[0]
  assert.equal(c2.role, "challenger")
  assert.equal(c2.continuation, true)
  assert.equal(c2.expectedAgentId, "child-C", "复审（无包波）按同角色回溯原 Challenger")
})

test("F4：同名角色/包不跨阶段串线（stage-advanced 边界停止回溯）", async () => {
  const wf = { terminalStages: ["finish"], gates: [], stages: [
    { id: "research", label: "调研", outputs: [], teamScene: "research" },
    { id: "code-review", label: "审查", outputs: ["code-review"], teamScene: "code-review", route: "e2e" },
  ], edges: [{ from: "research", to: "code-review", outcome: "pass" }] }
  const pol = { maxAutonomousRounds: 3, costWeights: { junior: 1, senior: 10, expert: 50 }, scenes: { research: { core: false }, "code-review": { core: true } } }
  const root = await makeProject({ workflow: wf, policy: pol })
  const call = caller(root)
  await openTask(root, "xstage-t", { entry: null }) // workflow 模式从 research 起
  const d0 = await call(["run", "--task", "xstage-t", "--writable", "none"])
  await call(["agent-map", "--task", "xstage-t", "--key", d0.dispatch.key, "--agent", "child-R1"])
  await call(["deliver", "--task", "xstage-t", "--key", d0.dispatch.key, "--outcome", "delivered", "--summary", "调研完成"])
  const rv0 = await call(["run", "--task", "xstage-t"])
  await reviewAccept(call, "xstage-t", rv0.dispatch.key)
  const adv = await call(["run", "--task", "xstage-t"])
  assert.equal(adv.transition, "advance")
  const d1 = await call(["run", "--task", "xstage-t", "--writable", "R.md:code-review"])
  await deliverContent(call, root, "xstage-t", d1.dispatch.key, "R.md", "v1")
  const rv1 = await call(["run", "--task", "xstage-t"])
  await call(["review", "--task", "xstage-t", "--key", rv1.dispatch.key, "--recommendation", "rework", "--summary", "需修"])
  const pl = await call(["dispatch-plan", "--task", "xstage-t", "--json", "--writable", "R.md:code-review"])
  assert.equal(pl.waves[0].expectedAgentIdMissing, true, "跨阶段同名 owner 不得续到上一阶段成员（child-R1）")
  assert.match(pl.waves[0].resumeNote ?? "", /未找到可续会话/)
})

test("F4/V3-E2E-02：Expert 重裁三次连续派发可解析——首裁 fresh、重裁 continuation 并解析原 Expert（台账门槛 3 Expert 侧，D3 同角色回溯）", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "vdct-t")
  const d1 = await call(["run", "--task", "vdct-t", "--writable", "R.md:code-review"])
  await call(["agent-map", "--task", "vdct-t", "--key", d1.dispatch.key, "--agent", "child-O"])
  await deliverContent(call, root, "vdct-t", d1.dispatch.key, "R.md", "v1")
  const verdictJson = (outcome) => JSON.stringify({ outcome, rationale: "r", confidence: "high", recommendedAction: "a" })
  const plan = () => call(["dispatch-plan", "--task", "vdct-t", "--json"])
  const planOwner = () => call(["dispatch-plan", "--task", "vdct-t", "--json", "--writable", "R.md:code-review"])
  // 首裁：无既有 Expert 报告 → fresh（continuation=false、无 expectedAgentId 字段）
  const c1 = (await plan()).waves[0]
  await call(["review", "--task", "vdct-t", "--key", c1.dispatchKey, "--recommendation", "accept", "--summary", "s"])
  const v1 = (await plan()).waves[0]
  assert.equal(v1.role, "expert")
  assert.equal(v1.continuation, false, "首裁 fresh 新会话")
  assert.equal(v1.expectedAgentId, undefined)
  assert.equal(v1.expectedAgentIdMissing, undefined)
  await call(["agent-map", "--task", "vdct-t", "--key", v1.dispatchKey, "--agent", "child-E1"])
  await call(["review", "--task", "vdct-t", "--key", v1.dispatchKey, "--recommendation", "accept", "--summary", "v", "--verdict", verdictJson("rework")])
  // 第二轮：respond → 交付 → challenger accept → 重裁 1 解析原 Expert
  const k2 = (await planOwner()).waves[0]
  assert.equal(k2.expectedAgentId, "child-O", "Owner 续派照常解析")
  await deliverContent(call, root, "vdct-t", k2.dispatchKey, "R.md", "v2")
  const c2 = (await plan()).waves[0]
  await call(["review", "--task", "vdct-t", "--key", c2.dispatchKey, "--recommendation", "accept", "--summary", "s"])
  const v2 = (await plan()).waves[0]
  assert.equal(v2.role, "expert")
  assert.equal(v2.continuation, true, "重裁为续派（verdict 波带 continuation）")
  assert.equal(v2.expectedAgentId, "child-E1", "重裁按同角色倒序回溯解析原 Expert（原实现每次重裁断链 fresh）")
  await call(["review", "--task", "vdct-t", "--key", v2.dispatchKey, "--recommendation", "accept", "--summary", "v", "--verdict", verdictJson("rework")])
  // 第三轮：重裁 2 仍解析同一 Expert（三次连续派发身份稳定）
  const k3 = (await planOwner()).waves[0]
  await deliverContent(call, root, "vdct-t", k3.dispatchKey, "R.md", "v3")
  const c3 = (await plan()).waves[0]
  await call(["review", "--task", "vdct-t", "--key", c3.dispatchKey, "--recommendation", "accept", "--summary", "s"])
  const v3 = (await plan()).waves[0]
  assert.equal(v3.continuation, true)
  assert.equal(v3.expectedAgentId, "child-E1", "第三次裁决仍解析原 Expert（映射链间断不断链）")
  await call(["review", "--task", "vdct-t", "--key", v3.dispatchKey, "--recommendation", "accept", "--summary", "v", "--verdict", verdictJson("accept")])
  await call(["route", "--task", "vdct-t", "--route", "e2e", "--decision", "skip", "--basis", "测试"])
  const gate = await call(["run", "--task", "vdct-t"])
  assert.equal(gate.status, "awaiting-user", "三轮裁决收敛后进入人工门")
})

// —— 台账复现 3：轮次分叉（V3-E2E-03）+ F2 唯一投影 ——

test("V3-E2E-03/F2：同轮重复报告投影轮不虚增；blocked 不入投影；superseded 波排除（纯函数）", async () => {
  const journal = [
    { seq: 1, at: "t1", type: "task-opened", detail: {} },
    { seq: 2, at: "t2", type: "dispatched", detail: { key: "d1-x", kind: "produce", role: "owner", round: 1, package: null, waveId: "wv1" } },
    { seq: 3, at: "t3", type: "dispatched", detail: { key: "d2-y", kind: "produce", role: "owner", round: 2, package: null, waveId: "wv2" } },
    { seq: 4, at: "t4", type: "dispatched", detail: { key: "d3-z", kind: "produce", role: "owner", round: 2, package: null, waveId: "wv3" } },
  ]
  const deliver = (id, key, round) => ({ reportId: id, dispatchKey: key, role: "owner", kind: "deliver", round, package: null, payload: { outcome: "delivered" }, at: "t9" })
  const reports = [deliver("r1", "d1-x", 1), deliver("r2", "d2-y", 2), deliver("r3", "d3-z", 2)]
  assert.deepEqual([...projectRounds({ journal, reports }).entries()], [[null, 2]], "两条 round 2 重复交付投影轮仍为 2（报告计数口径已删除）")
  const blockedJournal = [...journal, { seq: 5, at: "t5", type: "dispatched", detail: { key: "d4-b", kind: "produce", role: "owner", round: 3, package: null, waveId: "wv4" } }]
  const blockedReports = [...reports, { ...deliver("r4", "d4-b", 3), payload: { outcome: "blocked" } }]
  assert.deepEqual([...projectRounds({ journal: blockedJournal, reports: blockedReports }).entries()], [[null, 2]], "blocked 报告不入投影")
  const supersededJournal = [...blockedJournal, { seq: 6, at: "t6", type: "dispatch-superseded", detail: { waveId: "wv2" } }]
  assert.deepEqual([...supersededKeys(supersededJournal)], ["d2-y"], "superseded 波 key 集合解析")
  assert.deepEqual([...projectRounds({ journal: supersededJournal, reports: blockedReports }).entries()], [[null, 2]], "被作废波报告不入投影（d3 仍轮 2）")
  assert.equal(inflightBatch({ journal: supersededJournal, reports: blockedReports }), null, "全部已结/作废后无在途")
})

test("V3-E2E-03 全链路：同轮重复 key 迁移后 review 轮次不抬高、accept 后不再重复派 review、快照与判定同源（F2）", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "dup-t")
  // 注入历史重复 key（同轮 round 2 两条、无 waveId——迁移前旧事实形态）；
  // 历史重复交付以报告文件 + 双条目制品索引播种（同 digest → 机械合并，不触发异 digest 冲突卡）
  await seedDispatch(root, "dup-t", { key: "w1-dup", kind: "produce", role: "owner", round: 2, package: null, writable: [{ path: "R.md", artifactKind: "code-review" }] })
  await seedDispatch(root, "dup-t", { key: "w2-dup", kind: "produce", role: "owner", round: 2, package: null, writable: [{ path: "R.md", artifactKind: "code-review" }] })
  const task0 = await loadTask(root, "dup-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const mkReport = (key, id) => writeFile(path.join(task0.root, "reports", id + ".json"), JSON.stringify({ reportId: id, dispatchKey: key, role: "owner", kind: "deliver", round: 2, stage: "code-review", package: null, payload: { outcome: "delivered", summary: "s", paths: ["R.md"] }, at: new Date().toISOString() }))
  await mkReport("w1-dup", "ra")
  await mkReport("w2-dup", "rb")
  await writeFile(path.join(task0.root, "artifacts.json"), JSON.stringify({ items: [
    { path: "R.md", digest: "d1", kind: "code-review", stage: "code-review", reportRef: "deliver-w1-dup", snapshotRef: "s1" },
    { path: "R.md", digest: "d1", kind: "code-review", stage: "code-review", reportRef: "deliver-w2-dup", snapshotRef: "s1" },
  ] }))
  const mig = await call(["migrate", "--task", "dup-t"])
  assert.equal(mig.equivalent, true, "迁移前后投影等价")
  const rv = await call(["run", "--task", "dup-t"])
  assert.equal(rv.dispatch.role, "challenger")
  assert.equal(rv.dispatch.round, 2, "review 轮次按投影轮 2，不被重复报告抬高到 3")
  await reviewAccept(call, "dup-t", rv.dispatch.key)
  const task = await loadTask(root, "dup-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const lastReview = task.reports.filter((r) => r.role === "challenger").at(-1)
  assert.deepEqual(lastReview.reviewedPackages, [{ package: null, round: 2 }], "reviewedPackages 快照与投影同源（F2 写入处换源）")
  const next = await call(["run", "--task", "dup-t"])
  assert.equal(next.dispatch.role, "expert", "Challenger accept 后进入裁决，不再重复派同轮 review（死循环根除）")
  assert.equal(next.dispatch.round, 2)
  assert.notEqual(next.status, "awaiting-user", "真实轮 2 不触发轮次耗尽")
})

// —— 台账复现 4 + F5：人工门返工结构因果（人工门用例 1）——

test("V3-E2E-04/F5：决定前旧 key 同/异内容重交均不能完成返工；只认绑定 respond 波报告", async () => {
  const root = await makeProject()
  const { call, dispatchKey: k1 } = await seedConvergedStage(root, "imp-t")
  const card = await call(["run", "--task", "imp-t"])
  await call(["decide", "--task", "imp-t", "--choice", "2", "--note", "返工"])
  const first = await call(["run", "--task", "imp-t", "--writable", "R.md:code-review"])
  assert.equal(first.dispatch.kind, "respond")
  const k2 = first.dispatch.key
  // 旧 key 同内容重交 → 幂等，不消费返工
  const idem = await deliverContent(call, root, "imp-t", k1, "R.md", "报告v1", "s")
  assert.equal(idem.idempotent, true)
  const w1 = await call(["run", "--task", "imp-t", "--writable", "R.md:code-review"])
  assert.equal(w1.transition, "wait-inflight", "同内容旧 key 重交后仍在途（绑定波未交付）")
  assert.equal(w1.dispatchKey, k2)
  // 旧 key 异内容重交 → ver+1，仍结构性无效（不绑定该决定的报告不能消费本次返工）
  const changed = await deliverContent(call, root, "imp-t", k1, "R.md", "被旧key改动", "旧key重交")
  assert.equal(changed.ver, 2)
  const w2 = await call(["run", "--task", "imp-t", "--writable", "R.md:code-review"])
  assert.equal(w2.transition, "wait-inflight", "异内容旧 key 重交仍不能完成返工（deliveredAfter 时间判据已移除）")
  assert.equal(w2.dispatchKey, k2)
  // 绑定波报告（真正修订）→ 返工完成 → 评审链 → 二次人工门
  await deliverContent(call, root, "imp-t", k2, "R.md", "绑定波真正修复", "修复")
  const rv = await call(["run", "--task", "imp-t"])
  assert.equal(rv.dispatch.role, "challenger")
  await reviewAccept(call, "imp-t", rv.dispatch.key)
  const ve = await call(["run", "--task", "imp-t"])
  await reviewAccept(call, "imp-t", ve.dispatch.key, VERDICT)
  const gate = await call(["run", "--task", "imp-t"])
  assert.equal(gate.status, "awaiting-user", "返工完成后重新呈人工门卡")
  assert.notEqual(gate.decisionId, card.decisionId, "制品变化后旧卡不再复用")
  await call(["decide", "--task", "imp-t", "--choice", "1"])
  const done = await call(["run", "--task", "imp-t"])
  assert.equal(done.status, "completed")
  const task = await loadTask(root, "imp-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const bound = task.journal.find((e) => e.type === "dispatched" && e.detail.key === k2)
  assert.match(bound.detail.causeDecisionId ?? "", /^dec-/, "respond 派发抄写返工决定（causeDecisionId，P4）")
})

test("F5：blocked → converge-user 不无限重派；重派 respond 绑定同一返工决定；再 blocked 仍回仲裁卡", async () => {
  const root = await makeProject()
  const { call } = await seedConvergedStage(root, "blk-t")
  await call(["run", "--task", "blk-t"])
  await call(["decide", "--task", "blk-t", "--choice", "2", "--note", "返工"])
  const first = await call(["run", "--task", "blk-t", "--writable", "R.md:code-review"])
  const k2 = first.dispatch.key
  await call(["deliver", "--task", "blk-t", "--key", k2, "--outcome", "blocked", "--summary", "无法完成返工"])
  const card = await call(["run", "--task", "blk-t", "--writable", "R.md:code-review"])
  assert.equal(card.status, "awaiting-user")
  assert.match(card.question, /无法完成本次返工/, "blocked → 人工仲裁（消费规则 2）")
  assert.deepEqual(card.choices.map((c) => c.label), ["重派 respond", "结束任务"], "blocked 卡专用两选项，不沿用「追加一轮」")
  const again = await call(["run", "--task", "blk-t", "--writable", "R.md:code-review"])
  assert.equal(again.decisionId, card.decisionId, "静止：重复推进不签新卡、不重派")
  const task = await loadTask(root, "blk-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(task.journal.filter((e) => e.type === "dispatched").length, 2, "blocked 后零新增派发")
  await call(["decide", "--task", "blk-t", "--choice", "1"])
  const rerun = await call(["run", "--task", "blk-t", "--writable", "R.md:code-review"])
  assert.equal(rerun.dispatch.kind, "respond", "用户选择重派 → 新 respond 波")
  const k3 = rerun.dispatch.key
  assert.notEqual(k3, k2)
  const t2 = await loadTask(root, "blk-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const causes = t2.journal.filter((e) => e.type === "dispatched" && e.detail.causeDecisionId).map((e) => e.detail.causeDecisionId)
  assert.equal(new Set(causes).size, 1, "两次 respond 绑定同一返工决定（causeDecisionId 一致）")
  await call(["deliver", "--task", "blk-t", "--key", k3, "--outcome", "blocked", "--summary", "仍无法完成"])
  const card2 = await call(["run", "--task", "blk-t", "--writable", "R.md:code-review"])
  assert.equal(card2.status, "awaiting-user")
  assert.match(card2.question, /无法完成本次返工/, "再次 blocked 仍回仲裁卡，不无限重派 respond")
})

test("有效 blocked（seq 因果纯函数）：同毫秒不误判、墙钟回拨不误静止；锚后新派发/重拆解除", () => {
  const at = "2026-01-01T00:00:00.000Z" // 全部事件同毫秒：seq 是唯一可靠因果序
  const mkJournal = (events) => events.map((e, i) => ({ seq: i + 1, at, ...e }))
  const blockedReport = (key, pkg = null) => ({ reportId: `b-${key}`, dispatchKey: key, role: "owner", kind: "deliver", round: 1, stage: "code-review", ...(pkg != null ? { package: pkg } : {}), payload: { outcome: "blocked", summary: "范围不够" }, at })
  const ownerDispatch = (key, pkg = null) => ({ type: "dispatched", detail: { key, role: "owner", ...(pkg != null ? { package: pkg } : {}) } })
  // 1) blocked 后无新事件 → 有效（同毫秒不影响 seq 因果；旧 at 严格 > 口径在同毫秒会误判）
  const j1 = mkJournal([ownerDispatch("k1"), { type: "report-accepted", detail: { reportId: "b-k1" } }])
  assert.equal(effectiveBlockedSet({ journal: j1, reports: [blockedReport("k1")], packages: null }).has(null), true)
  // 2) 扩权重派（at 回拨到更早、seq 更大）→ 解除：seq 因果不受墙钟回拨影响
  const j2 = mkJournal([
    ownerDispatch("k1"),
    { type: "report-accepted", detail: { reportId: "b-k1" } },
    { ...ownerDispatch("k2"), at: "2025-01-01T00:00:00.000Z" },
  ])
  assert.equal(effectiveBlockedSet({ journal: j2, reports: [blockedReport("k1")], packages: null }).has(null), false, "锚后新 owner 派发（即使墙钟更早）解除 blocked")
  // 3) 重拆（packages-planned/re-planned，seq 更大）→ 解除（任意包的重拆都是新范围承诺）
  const j3 = mkJournal([
    ownerDispatch("k1", "a"),
    { type: "report-accepted", detail: { reportId: "b-k1" } },
    { type: "re-planned", detail: { packages: [] } },
  ])
  assert.equal(effectiveBlockedSet({ journal: j3, reports: [blockedReport("k1", "a")], packages: [{ id: "a" }] }).has("a"), false, "锚后重拆解除 blocked")
  // 4) 报告全序也走 seq：同 at 下后接受的 delivered 覆盖 blocked（最新 owner 报告为 delivered）
  const j4 = mkJournal([
    ownerDispatch("k1"),
    { type: "report-accepted", detail: { reportId: "b-k1" } },
    ownerDispatch("k2"),
    { type: "report-accepted", detail: { reportId: "o-k2" } },
  ])
  const deliveredAfter = { ...blockedReport("k2"), reportId: "o-k2", payload: { outcome: "delivered", summary: "s", paths: ["R.md"] } }
  assert.equal(effectiveBlockedSet({ journal: j4, reports: [blockedReport("k1"), deliveredAfter], packages: null }).size, 0, "最新 owner 报告为 delivered → 不在有效 blocked 集")
  // 5) 多包隔离：包 a blocked、包 b 无报告 → 只有 a 进集合
  const j5 = mkJournal([ownerDispatch("k1", "a"), { type: "report-accepted", detail: { reportId: "b-k1" } }])
  const s5 = effectiveBlockedSet({ journal: j5, reports: [blockedReport("k1", "a")], packages: [{ id: "a" }, { id: "b" }] })
  assert.deepEqual([...s5.keys()], ["a"], "集合按包隔离，值为该包最新 blocked 报告")
  assert.equal(s5.get("a")?.payload?.summary, "范围不够")
})

test("F5×produceBlocked 交叉：人工门 rework 多包一 delivered 一 blocked → 出 F5 仲裁卡（不被 produceBlocked 遮蔽）；重派交付后不再触发 blocked 仲裁", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "xblk-t")
  await call(["plan", "--task", "xblk-t", "--packages", PKGS2])
  // 走完评审链到人工门：两包交付 → review accept → verdict accept → e2e skip
  const d1 = await call(["run", "--task", "xblk-t"])
  const kS = d1.dispatches.find((x) => x.package === "store").key
  const kI = d1.dispatches.find((x) => x.package === "intake").key
  await deliverContent(call, root, "xblk-t", kS, "S.md", "store v1")
  await deliverContent(call, root, "xblk-t", kI, "I.md", "intake v1")
  const rv1 = await call(["run", "--task", "xblk-t"])
  await reviewAccept(call, "xblk-t", rv1.dispatch.key)
  const ve1 = await call(["run", "--task", "xblk-t"])
  await reviewAccept(call, "xblk-t", ve1.dispatch.key, VERDICT)
  await call(["route", "--task", "xblk-t", "--route", "e2e", "--decision", "skip", "--basis", "测试"])
  await call(["run", "--task", "xblk-t"])
  await call(["decide", "--task", "xblk-t", "--choice", "2", "--note", "返工"])
  // 人工门 rework → 绑定 respond 覆盖波（两包，causeDecisionId）
  const r1 = await call(["run", "--task", "xblk-t"])
  assert.equal(r1.dispatches.length, 2, "返工覆盖波含全部包")
  const kS2 = r1.dispatches.find((x) => x.package === "store").key
  const kI2 = r1.dispatches.find((x) => x.package === "intake").key
  await deliverContent(call, root, "xblk-t", kS2, "S.md", "store v2 修复", "修store")
  await call(["deliver", "--task", "xblk-t", "--key", kI2, "--outcome", "blocked", "--summary", "intake 需要范围外文件，无法返工"])
  // 评审链消化 store 的修复交付；challenger rework 点名 blocked 的 intake → 无可派波（intake 被有效 blocked 过滤）
  const rv2 = await call(["run", "--task", "xblk-t"])
  assert.equal(rv2.dispatch.role, "challenger")
  await call(["review", "--task", "xblk-t", "--key", rv2.dispatch.key, "--recommendation", "rework", "--summary", "intake 仍需修", "--findings", JSON.stringify([{ severity: "risk", statement: "intake 待修", package: "intake" }])])
  const ve2 = await call(["run", "--task", "xblk-t"])
  assert.equal(ve2.dispatch.role, "expert", "core 场景 store 修复先过裁决")
  await reviewAccept(call, "xblk-t", ve2.dispatch.key, VERDICT)
  // 无可派波 + intake 有效 blocked → nextWave 出 produceBlocked 场景，但人工门 rework 绑定在场 →
  // derive 让位 F5：出 reworkBlocked 仲裁卡（decide 语义），不被 produceBlocked 卡遮蔽成 re-scope
  const card = await call(["run", "--task", "xblk-t"])
  assert.equal(card.status, "awaiting-user")
  assert.notEqual(card.next, "re-scope", "不被 produceBlocked 静止卡遮蔽")
  assert.match(card.question, /无法完成本次返工/, "出 F5 消费规则 2 的 reworkBlocked 仲裁卡")
  assert.deepEqual(card.choices.map((c) => c.label), ["重派 respond", "结束任务"])
  // 用户选择重派 → 新绑定 respond 波（同决定、含绑定波整波包集）→ 两包本轮均完成 → 评审链 →
  // gate 分支消费规则 2 不再被旧 blocked 报告触发（新绑定波报告全 delivered；blocked 投影已解除）
  await call(["decide", "--task", "xblk-t", "--choice", "1"])
  const r2 = await call(["run", "--task", "xblk-t"])
  assert.equal(r2.dispatches.length, 2, "rework-rerun 覆盖波仍含全部包")
  await deliverContent(call, root, "xblk-t", r2.dispatches.find((x) => x.package === "store").key, "S.md", "store v3 再修", "再修store")
  await deliverContent(call, root, "xblk-t", r2.dispatches.find((x) => x.package === "intake").key, "I.md", "intake v2 修复", "修intake")
  const rv3 = await call(["run", "--task", "xblk-t"])
  await reviewAccept(call, "xblk-t", rv3.dispatch.key)
  const ve3 = await call(["run", "--task", "xblk-t"])
  await reviewAccept(call, "xblk-t", ve3.dispatch.key, VERDICT)
  const gate = await call(["run", "--task", "xblk-t"])
  assert.equal(gate.status, "awaiting-user")
  assert.doesNotMatch(gate.question ?? "", /无法完成本次返工/, "旧 blocked 报告不再二次触发 F5 仲裁（回到人工门卡）")
  assert.match(gate.question ?? "", /scoped-final|人工|批准/, "回到人工门等待用户")
  await call(["decide", "--task", "xblk-t", "--choice", "1"])
  const done = await call(["run", "--task", "xblk-t"])
  assert.equal(done.status, "completed", "交叉场景消解后正常收敛")
})

test("r4 边界：轮次耗尽（exhausted）不遮蔽 F5——绑定波含有效 blocked 时直接出 reworkBlocked 仲裁卡，不先出「追加一轮」卡；重派交付后不二次触发", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "exh-t")
  await call(["plan", "--task", "exh-t", "--packages", PKGS2])
  const keyOf = (w, pkg) => w.dispatches.find((x) => x.package === pkg).key
  // 两轮 challenger rework（不点名 = 两包全重派）把两包推到第 3 轮
  const w1 = await call(["run", "--task", "exh-t"])
  await deliverContent(call, root, "exh-t", keyOf(w1, "store"), "S.md", "store v1")
  await deliverContent(call, root, "exh-t", keyOf(w1, "intake"), "I.md", "intake v1")
  const rv1 = await call(["run", "--task", "exh-t"])
  await call(["review", "--task", "exh-t", "--key", rv1.dispatch.key, "--recommendation", "rework", "--summary", "两包都修"])
  const w2 = await call(["run", "--task", "exh-t"])
  await deliverContent(call, root, "exh-t", keyOf(w2, "store"), "S.md", "store v2")
  await deliverContent(call, root, "exh-t", keyOf(w2, "intake"), "I.md", "intake v2")
  const rv2 = await call(["run", "--task", "exh-t"])
  await call(["review", "--task", "exh-t", "--key", rv2.dispatch.key, "--recommendation", "rework", "--summary", "再修"])
  const w3 = await call(["run", "--task", "exh-t"])
  await deliverContent(call, root, "exh-t", keyOf(w3, "store"), "S.md", "store v3")
  await deliverContent(call, root, "exh-t", keyOf(w3, "intake"), "I.md", "intake v3")
  // 第 3 轮收敛：review accept + verdict accept → 人工门 → rework
  const rv3 = await call(["run", "--task", "exh-t"])
  await reviewAccept(call, "exh-t", rv3.dispatch.key)
  const ve3 = await call(["run", "--task", "exh-t"])
  await reviewAccept(call, "exh-t", ve3.dispatch.key, VERDICT)
  await call(["route", "--task", "exh-t", "--route", "e2e", "--decision", "skip", "--basis", "测试"])
  await call(["run", "--task", "exh-t"])
  await call(["decide", "--task", "exh-t", "--choice", "2", "--note", "返工"])
  // 人工门 rework → 绑定 respond round 4：store delivered、intake blocked（投影轮仍 3 = maxRounds）
  const r4 = await call(["run", "--task", "exh-t"])
  assert.equal(r4.dispatches.length, 2)
  await deliverContent(call, root, "exh-t", keyOf(r4, "store"), "S.md", "store v4 修复", "修store")
  await call(["deliver", "--task", "exh-t", "--key", keyOf(r4, "intake"), "--outcome", "blocked", "--summary", "intake 需范围外文件"])
  // challenger 对 store 修复交付 rework 并点名 blocked 的 intake——此刻 intake 投影轮 3 = maxRounds，
  // nextWave 的 exhausted 检查先于 review/verdict 派发触发（不会先派 store 的裁决波）
  const rv4 = await call(["run", "--task", "exh-t"])
  assert.equal(rv4.dispatch.role, "challenger")
  await call(["review", "--task", "exh-t", "--key", rv4.dispatch.key, "--recommendation", "rework", "--summary", "intake 待修", "--findings", JSON.stringify([{ severity: "risk", statement: "intake 待修", package: "intake" }])])
  // 关键断言：nextWave 的 exhausted 分支（intake 投影轮 3 ≥ maxRounds 3）被让位检查接管——
  // 直接出 F5 reworkBlocked 仲裁卡，而非「轮次上限」卡（否则用户先追加一轮、随后又收 F5 卡，双重处理）
  const card = await call(["run", "--task", "exh-t"])
  assert.equal(card.status, "awaiting-user")
  assert.match(card.question, /无法完成本次返工/, "出 F5 reworkBlocked 仲裁卡")
  assert.doesNotMatch(card.question, /轮次上限|自主轮次/, "不被 exhausted 卡抢先")
  assert.deepEqual(card.choices.map((c) => c.label), ["重派 respond", "结束任务"])
  // decide 重派 → 双包交付 → 回人工门，旧 blocked 不二次触发
  await call(["decide", "--task", "exh-t", "--choice", "1"])
  const r5 = await call(["run", "--task", "exh-t"])
  assert.equal(r5.dispatches.length, 2, "rework-rerun 覆盖波含绑定波整波包集")
  await deliverContent(call, root, "exh-t", keyOf(r5, "store"), "S.md", "store v5 终版", "s5")
  await deliverContent(call, root, "exh-t", keyOf(r5, "intake"), "I.md", "intake v5 终版", "i5")
  const rv5 = await call(["run", "--task", "exh-t"])
  await reviewAccept(call, "exh-t", rv5.dispatch.key)
  const ve5 = await call(["run", "--task", "exh-t"])
  await reviewAccept(call, "exh-t", ve5.dispatch.key, VERDICT)
  const gate = await call(["run", "--task", "exh-t"])
  assert.equal(gate.status, "awaiting-user")
  assert.doesNotMatch(gate.question ?? "", /无法完成本次返工/, "旧 blocked 不再二次触发 F5 仲裁")
  assert.match(gate.question ?? "", /scoped-final|人工|批准/, "回人工门等待用户")
  await call(["decide", "--task", "exh-t", "--choice", "1"])
  const done = await call(["run", "--task", "exh-t"])
  assert.equal(done.status, "completed", "耗尽×blocked 交叉场景消解后正常收敛")
})

test("F5：僵局检测——delivered 但制品指纹未变 → 仲裁卡含未修包清单；仅重派未修包 → 修复 → 完成", async () => {
  const root = await makeProject()
  const { call } = await seedConvergedStage(root, "stale-t")
  await call(["run", "--task", "stale-t"])
  await call(["decide", "--task", "stale-t", "--choice", "2", "--note", "返工"])
  const first = await call(["run", "--task", "stale-t", "--writable", "R.md:code-review"])
  const k2 = first.dispatch.key
  // 交付但内容未改（digest 与决定时一致）→ 走评审链后 gate 分支判僵局
  await deliverContent(call, root, "stale-t", k2, "R.md", "报告", "未改内容")
  const rv = await call(["run", "--task", "stale-t"])
  await reviewAccept(call, "stale-t", rv.dispatch.key)
  const ve = await call(["run", "--task", "stale-t"])
  await reviewAccept(call, "stale-t", ve.dispatch.key, VERDICT)
  const card = await call(["run", "--task", "stale-t", "--writable", "R.md:code-review"])
  assert.equal(card.status, "awaiting-user")
  assert.match(card.question, /返工僵局/, "消费规则 3：指纹未变 → 僵局仲裁")
  assert.deepEqual(card.choices.map((c) => c.label), ["接受现状", "仅重派未修包", "结束任务"], "僵局卡不沿用「追加一轮」（空转循环根除）")
  await call(["decide", "--task", "stale-t", "--choice", "2"])
  const rerun = await call(["run", "--task", "stale-t", "--writable", "R.md:code-review"])
  assert.equal(rerun.dispatch.kind, "respond", "仅重派未修包 → 新 respond 波绑定同一返工决定")
  await deliverContent(call, root, "stale-t", rerun.dispatch.key, "R.md", "真正修复的版本", "已修复")
  const rv2 = await call(["run", "--task", "stale-t"])
  await reviewAccept(call, "stale-t", rv2.dispatch.key)
  const ve2 = await call(["run", "--task", "stale-t"])
  await reviewAccept(call, "stale-t", ve2.dispatch.key, VERDICT)
  const gate = await call(["run", "--task", "stale-t"])
  assert.equal(gate.status, "awaiting-user")
  await call(["decide", "--task", "stale-t", "--choice", "1"])
  const done = await call(["run", "--task", "stale-t"])
  assert.equal(done.status, "completed")
})

test("F5：第二次 rework 不能被第一次绑定波报告消费", async () => {
  const root = await makeProject()
  const { call } = await seedConvergedStage(root, "r2-t")
  await call(["run", "--task", "r2-t"])
  await call(["decide", "--task", "r2-t", "--choice", "2", "--note", "第一次返工"])
  const r1 = await call(["run", "--task", "r2-t", "--writable", "R.md:code-review"])
  const k2 = r1.dispatch.key
  await deliverContent(call, root, "r2-t", k2, "R.md", "第一轮修复", "修复一")
  const rv1 = await call(["run", "--task", "r2-t"])
  await reviewAccept(call, "r2-t", rv1.dispatch.key)
  const ve1 = await call(["run", "--task", "r2-t"])
  await reviewAccept(call, "r2-t", ve1.dispatch.key, VERDICT)
  const card2 = await call(["run", "--task", "r2-t"])
  assert.equal(card2.status, "awaiting-user")
  await call(["decide", "--task", "r2-t", "--choice", "2", "--note", "第二次返工"])
  const r2 = await call(["run", "--task", "r2-t", "--writable", "R.md:code-review"])
  const k3 = r2.dispatch.key
  assert.notEqual(k3, k2)
  // 第一次绑定波 key 重交（异内容）→ 第二次返工仍等待 k3
  await deliverContent(call, root, "r2-t", k2, "R.md", "第一轮key再次改动", "旧绑定重交")
  const w = await call(["run", "--task", "r2-t", "--writable", "R.md:code-review"])
  assert.equal(w.transition, "wait-inflight", "第一次绑定波报告不能消费第二次返工")
  assert.equal(w.dispatchKey, k3)
  const t = await loadTask(root, "r2-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const causes = [...new Set(t.journal.filter((e) => e.type === "dispatched" && e.detail.causeDecisionId).map((e) => e.detail.causeDecisionId))]
  assert.equal(causes.length, 2, "两次返工各有独立 causeDecisionId（因果链按决定隔离）")
})

test("F5 多包混合：已改包交付进入评审链、未修包僵局卡列清单、仅重派未修包", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "mix-t")
  await call(["plan", "--task", "mix-t", "--packages", PKGS2])
  const d1 = await call(["run", "--task", "mix-t"])
  const kS = d1.dispatches.find((x) => x.package === "store").key
  const kI = d1.dispatches.find((x) => x.package === "intake").key
  assert.equal(d1.dispatches[0].waveId, d1.dispatches[1].waveId, "同波两包共享 waveId")
  await deliverContent(call, root, "mix-t", kS, "S.md", "store v1", "s1")
  await deliverContent(call, root, "mix-t", kI, "I.md", "intake v1", "s2")
  const rv1 = await call(["run", "--task", "mix-t"])
  await reviewAccept(call, "mix-t", rv1.dispatch.key)
  const ve1 = await call(["run", "--task", "mix-t"])
  await reviewAccept(call, "mix-t", ve1.dispatch.key, VERDICT)
  await call(["route", "--task", "mix-t", "--route", "e2e", "--decision", "skip", "--basis", "测试"])
  await call(["run", "--task", "mix-t"])
  await call(["decide", "--task", "mix-t", "--choice", "2", "--note", "返工"])
  const r1 = await call(["run", "--task", "mix-t"])
  assert.equal(r1.dispatches.length, 2, "返工覆盖波含全部包")
  const kS2 = r1.dispatches.find((x) => x.package === "store").key
  const kI2 = r1.dispatches.find((x) => x.package === "intake").key
  // store 修复、intake 未改（digest 不变）
  await deliverContent(call, root, "mix-t", kS2, "S.md", "store v2 修复", "修store")
  await deliverContent(call, root, "mix-t", kI2, "I.md", "intake v1", "未改intake")
  const rv2 = await call(["run", "--task", "mix-t"])
  assert.equal(rv2.dispatch.role, "challenger", "已改包（store）交付进入评审链，不因他包僵局挂起")
  await reviewAccept(call, "mix-t", rv2.dispatch.key)
  const ve2 = await call(["run", "--task", "mix-t"])
  await reviewAccept(call, "mix-t", ve2.dispatch.key, VERDICT)
  const card = await call(["run", "--task", "mix-t"])
  assert.equal(card.status, "awaiting-user")
  assert.match(card.question, /返工僵局/)
  assert.match(card.question, /intake/, "仲裁卡列出未修包清单（包 id）")
  const t = await loadTask(root, "mix-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const issued = t.journal.filter((e) => e.type === "decision-issued").at(-1)
  assert.deepEqual(issued.detail.reworkStalemate, ["intake"], "未修包清单只含 intake（store 已修不搭车）")
  await call(["decide", "--task", "mix-t", "--choice", "2"])
  const r2 = await call(["run", "--task", "mix-t"])
  assert.equal(r2.dispatches.length, 1, "仅重派未修包")
  assert.equal(r2.dispatches[0].package, "intake")
  await deliverContent(call, root, "mix-t", r2.dispatches[0].key, "I.md", "intake v2 修复", "修intake")
  const rv3 = await call(["run", "--task", "mix-t"])
  await reviewAccept(call, "mix-t", rv3.dispatch.key)
  const ve3 = await call(["run", "--task", "mix-t"])
  await reviewAccept(call, "mix-t", ve3.dispatch.key, VERDICT)
  const gate = await call(["run", "--task", "mix-t"])
  assert.equal(gate.status, "awaiting-user")
  await call(["decide", "--task", "mix-t", "--choice", "1"])
  const done = await call(["run", "--task", "mix-t"])
  assert.equal(done.status, "completed", "多包混合僵局消解后正常收敛")
})

// —— F6：评审链指纹 + 重出卡（人工门用例 2）——

test("F6-2：等待期改写 Challenger 报告 → 旧卡自动作废、重签新卡且只呈一次；旧卡直答被拒", async () => {
  const root = await makeProject()
  const { call } = await seedConvergedStage(root, "f6s-t")
  const card1 = await call(["run", "--task", "f6s-t"])
  assert.equal(card1.status, "awaiting-user")
  // 等待期改写评审结论（recommendation 保持 accept，仅内容变化 → 评审链指纹变化）
  const task = await loadTask(root, "f6s-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const rcPath = path.join(task.root, "reports", "rc.json")
  const rc = JSON.parse(await readFile(rcPath, "utf8"))
  rc.payload.summary = "改写后的结论：补充两条新发现"
  await writeFile(rcPath, JSON.stringify(rc))
  const card2 = await call(["run", "--task", "f6s-t"])
  assert.equal(card2.status, "awaiting-user")
  assert.notEqual(card2.decisionId, card1.decisionId, "指纹失效 → 作废旧卡重签新卡")
  const again = await call(["run", "--task", "f6s-t"])
  assert.equal(again.decisionId, card2.decisionId, "新卡只呈一次（重复 run 幂等）")
  const t2 = await loadTask(root, "f6s-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const superseded = t2.journal.filter((e) => e.type === "decided").map((e) => e.detail)
  assert.deepEqual(superseded.map((d) => d.choice), ["superseded"], "旧卡以 decided:superseded 只增作废（不删事实）")
  assert.equal(superseded[0].decisionId, card1.decisionId)
  // 旧卡直答被拒（签发指纹再变化后 decide 旧卡）
  rc.payload.summary = "第三次改写"
  await writeFile(rcPath, JSON.stringify(rc))
  const staleDecide = await call(["decide", "--task", "f6s-t", "--choice", "1"])
  assert.equal(staleDecide.ok, false)
  assert.equal(staleDecide.code, "DECISION_STALE")
  const card3 = await call(["run", "--task", "f6s-t"])
  assert.notEqual(card3.decisionId, card2.decisionId, "再变化 → 再次重签")
  const okDecide = await call(["decide", "--task", "f6s-t", "--choice", "1"])
  assert.equal(okDecide.ok, true, "取新卡后 decide 成功（指引闭环）")
})

test("F6-1：同门多次决定 → 二次 accept 后门通过、不再成环；批准后制品变化 → 旧批准失效重签", async () => {
  const root = await makeProject()
  const { call } = await seedConvergedStage(root, "f6m-t")
  const card1 = await call(["run", "--task", "f6m-t"])
  await call(["decide", "--task", "f6m-t", "--choice", "1"])
  // 批准后制品指纹变化（模拟决定后内容被改）→ 旧批准失效 → 重新呈卡
  const task = await loadTask(root, "f6m-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  await writeFile(path.join(task.root, "artifacts.json"), JSON.stringify({ items: [{ path: "R.md", digest: "tampered", kind: "code-review", stage: "code-review", reportRef: "x", snapshotRef: "y" }] }))
  const card2 = await call(["run", "--task", "f6m-t"])
  assert.equal(card2.status, "awaiting-user")
  assert.notEqual(card2.decisionId, card1.decisionId, "批准指纹过期 → 重新呈卡（已决分支取最新事实）")
  await call(["decide", "--task", "f6m-t", "--choice", "1"])
  const done = await call(["run", "--task", "f6m-t"])
  assert.equal(done.status, "completed", "二次 accept 后门通过、不再成环")
  const t2 = await loadTask(root, "f6m-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const accepted = t2.journal.filter((e) => e.type === "decided").map((e) => e.detail.choice)
  assert.deepEqual(accepted, ["accept", "accept"], "恰好两次 accept 决定，无循环重签")
})

test("F6/R2：旧决定缺 reviewFingerprint 降级仅制品指纹（纯函数；新决定启用双指纹）", async () => {
  const legacy = { fingerprint: "fp-old", artifactFingerprint: { null: "fp-old" } }
  assert.equal(humanDecisionFresh({ decided: legacy, artifactFp: { null: "fp-old" }, reviewFp: "rf-new" }), true, "旧决定缺 reviewFingerprint → 仅制品指纹比对（评审链变化不失效）")
  assert.equal(humanDecisionFresh({ decided: legacy, artifactFp: { null: "fp-changed" }, reviewFp: "rf-new" }), false)
  const fresh = { artifactFingerprint: { null: "fp-old" }, reviewFingerprint: "rf-old" }
  assert.equal(humanDecisionFresh({ decided: fresh, artifactFp: { null: "fp-old" }, reviewFp: "rf-old" }), true)
  assert.equal(humanDecisionFresh({ decided: fresh, artifactFp: { null: "fp-old" }, reviewFp: "rf-new" }), false, "新决定双指纹：评审链变化即失效")
})

// —— F7：报告版本 ver ——

test("F7：同 key 同 payload 幂等 ver 不变；变 payload ver+1；report-accepted 带 ver+payloadDigest；旧报告视为 ver 1", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "ver-t")
  const d = await call(["run", "--task", "ver-t", "--writable", "R.md:code-review"])
  await writeFile(path.join(root, "R.md"), "v1", "utf8")
  const dl1 = await call(["deliver", "--task", "ver-t", "--key", d.dispatch.key, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  const dl2 = await call(["deliver", "--task", "ver-t", "--key", d.dispatch.key, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  assert.equal(dl1.ver, 1)
  assert.equal(dl2.idempotent, true)
  assert.equal(dl2.ver, 1, "同 key 同 payloadDigest → 幂等，ver 不变")
  const dl3 = await call(["deliver", "--task", "ver-t", "--key", d.dispatch.key, "--outcome", "delivered", "--summary", "改摘要", "--paths", "R.md"])
  assert.equal(dl3.ver, 2, "payload 变化 → ver+1（身份 = key+ver）")
  const task = await loadTask(root, "ver-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const rep = task.reports.find((r) => r.dispatchKey === d.dispatch.key)
  assert.equal(rep.reportId, "deliver-" + d.dispatch.key, "报告文件名跟随 d key（F8）")
  assert.equal(rep.ver, 2)
  assert.ok(rep.payloadDigest, "报告落盘带 payloadDigest（digest 链即时可审计）")
  assert.equal(rep.waveId, "wv1", "waveId 仅展示字段")
  const evts = task.journal.filter((e) => e.type === "report-accepted" && e.detail.dispatchKey === d.dispatch.key)
  assert.deepEqual(evts.map((e) => e.detail.ver), [1, 2], "journal report-accepted 补 ver")
  assert.ok(evts.every((e) => typeof e.detail.payloadDigest === "string" && e.detail.payloadDigest.length > 0), "journal 事件带 payloadDigest")
  assert.equal(evts.length, 2, "幂等重交不追加第二条事件")
})

test("F7：v1 fail + v2 pass → 门按最新 ver 判定（同 key 修订覆盖单文件）", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "verpass-t")
  const d = await call(["run", "--task", "verpass-t", "--writable", "R.md:code-review"])
  await writeFile(path.join(root, "R.md"), "v1", "utf8")
  await call(["deliver", "--task", "verpass-t", "--key", d.dispatch.key, "--outcome", "delivered", "--summary", "s", "--paths", "R.md",
    "--checks", JSON.stringify([{ name: "t", result: "fail" }])])
  const rv = await call(["run", "--task", "verpass-t"])
  await reviewAccept(call, "verpass-t", rv.dispatch.key)
  const ve = await call(["run", "--task", "verpass-t"])
  await reviewAccept(call, "verpass-t", ve.dispatch.key, VERDICT)
  await call(["route", "--task", "verpass-t", "--route", "e2e", "--decision", "skip", "--basis", "测试"])
  const g1 = await call(["gate", "--task", "verpass-t"])
  assert.ok(g1.blockers.some((b) => /检查未通过/.test(b.requirement)), "v1 fail 阻塞门禁")
  const v2 = await call(["deliver", "--task", "verpass-t", "--key", d.dispatch.key, "--outcome", "delivered", "--summary", "s", "--paths", "R.md",
    "--checks", JSON.stringify([{ name: "t", result: "pass" }])])
  assert.equal(v2.ver, 2)
  const g2 = await call(["gate", "--task", "verpass-t"])
  assert.ok(!g2.blockers.some((b) => /检查未通过/.test(b.requirement)), "门按最新 ver 判定（v1 fail 不阻塞 v2 pass）")
})

// —— F8：d 前缀命名与 agents.json 键空间 ——

test("F8：agents.json 旧 w 键只读保留、新 d 键并存；跨版本 w/d 混存回溯不断链", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "wdmix-t")
  // 旧 w 前缀派发（迁移前事实）+ 旧键映射
  await seedDispatch(root, "wdmix-t", { key: "w1-aa", kind: "produce", role: "owner", round: 1, package: null, writable: [{ path: "R.md", artifactKind: "code-review" }] })
  await call(["agent-map", "--task", "wdmix-t", "--key", "w1-aa", "--agent", "child-W"])
  await deliverContent(call, root, "wdmix-t", "w1-aa", "R.md", "v1")
  const mig = await call(["migrate", "--task", "wdmix-t"])
  assert.deepEqual(mig.assignedWaves, [{ waveId: "wv1", dispatchKeys: ["w1-aa"] }])
  const rv = await call(["run", "--task", "wdmix-t"])
  assert.match(rv.dispatch.key, KEY_RE, "新派发用 d 前缀")
  await call(["review", "--task", "wdmix-t", "--key", rv.dispatch.key, "--recommendation", "rework", "--summary", "需修"])
  const pl = await call(["dispatch-plan", "--task", "wdmix-t", "--json", "--writable", "R.md:code-review"])
  const k2 = pl.waves[0]
  assert.equal(k2.expectedAgentId, "child-W", "跨版本 w/d 混存：d 派发回溯 w 键映射不断链（F4 按 key 精匹配）")
  await call(["agent-map", "--task", "wdmix-t", "--key", k2.dispatchKey, "--agent", "child-D"])
  const agents = JSON.parse(await readFile(path.join(root, ".team-work", "tasks", "wdmix-t", "agents.json"), "utf8"))
  assert.equal(agents.mappings["w1-aa"], "child-W", "旧 w 键只读保留")
  assert.equal(agents.mappings[k2.dispatchKey], "child-D", "新 d 键并存")
})

// —— F9：既有任务迁移 ——

test("F9：合并规则——同(kind,role,round)不同包合并一波、同包重复各自成波、package=null 各自成波；迁移前后投影等价；重跑幂等", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "mig-t")
  await call(["plan", "--task", "mig-t", "--packages", JSON.stringify([
    { id: "a", writable: ["A.md:k"], done: ["d"], dependsOn: [] },
    { id: "b", writable: ["B.md:k"], done: ["d"], dependsOn: [] },
  ])])
  // 注入迁移前历史派发（无 waveId）
  await seedDispatch(root, "mig-t", { key: "w1-aa", kind: "produce", role: "owner", round: 1, package: "a", writable: [{ path: "A.md", artifactKind: "k" }] })
  await seedDispatch(root, "mig-t", { key: "w2-bb", kind: "produce", role: "owner", round: 1, package: "b", writable: [{ path: "B.md", artifactKind: "k" }] })
  await seedDispatch(root, "mig-t", { key: "w3-cc", kind: "produce", role: "owner", round: 1, package: "a", writable: [{ path: "A.md", artifactKind: "k" }] })
  await seedDispatch(root, "mig-t", { key: "w4-dd", kind: "produce", role: "owner", round: 2, package: null, writable: [{ path: "R.md", artifactKind: "k" }] })
  await seedDispatch(root, "mig-t", { key: "w5-ee", kind: "produce", role: "owner", round: 2, package: null, writable: [{ path: "R.md", artifactKind: "k" }] })
  const mig = await call(["migrate", "--task", "mig-t"])
  assert.equal(mig.ok, true)
  assert.deepEqual(mig.assignedWaves, [
    { waveId: "wv1", dispatchKeys: ["w1-aa", "w2-bb"] },
    { waveId: "wv2", dispatchKeys: ["w3-cc"] },
    { waveId: "wv3", dispatchKeys: ["w4-dd"] },
    { waveId: "wv4", dispatchKeys: ["w5-ee"] },
  ], "不同包合并一波；同包重复各自成波；package=null 一律各自成波；按 journal 序赋号")
  assert.equal(mig.equivalent, true, "迁移前后投影对比输出且状态等价")
  const mig2 = await call(["migrate", "--task", "mig-t"])
  assert.equal(mig2.ok, true)
  assert.deepEqual(mig2.assignedWaves, [], "重跑不重复赋号（幂等）")
  const task = await loadTask(root, "mig-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(task.journal.filter((e) => e.type === "wave-assigned").length, 4)
  assert.ok(task.journal.filter((e) => e.type === "dispatched").every((e) => !e.detail.waveId), "既有 journal 行未被改写（追加式，B4）")
  // 迁移后继续推进：先结清全部 legacy 派发（同组同内容避免异 digest 冲突卡），
  // 新派发 waveId/key 序号从 max(dispatchedCount, maxWvN)+1 接续（5 条派发、maxWv=4 → wv6 / d6）
  await deliverContent(call, root, "mig-t", "w1-aa", "A.md", "a1", "交付1")
  await deliverContent(call, root, "mig-t", "w2-bb", "B.md", "b1", "交付2")
  await deliverContent(call, root, "mig-t", "w3-cc", "A.md", "a1", "交付3")
  await deliverContent(call, root, "mig-t", "w4-dd", "R.md", "r1", "交付4")
  await deliverContent(call, root, "mig-t", "w5-ee", "R.md", "r1", "交付5")
  const first = await call(["run", "--task", "mig-t"])
  assert.equal(first.next, "dispatch")
  assert.equal(first.dispatch.role, "challenger")
  assert.equal(first.dispatch.waveId, "wv6", "新号从 max(wvN)/dispatched 数接续（恒大于已赋最大值）")
  assert.match(first.dispatch.key, /^d6-/, "d 序号同样从 dispatched 事件数接续")
})

test("F9：中断重跑等价——半迁移 journal（部分已赋号）可续跑至完整、不重复赋号", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "half-t")
  await call(["plan", "--task", "half-t", "--packages", JSON.stringify([
    { id: "a", writable: ["A.md:k"], done: ["d"], dependsOn: [] },
    { id: "b", writable: ["B.md:k"], done: ["d"], dependsOn: [] },
  ])])
  await seedDispatch(root, "half-t", { key: "w1-aa", kind: "produce", role: "owner", round: 1, package: "a", writable: [{ path: "A.md", artifactKind: "k" }] })
  await seedDispatch(root, "half-t", { key: "w2-bb", kind: "produce", role: "owner", round: 1, package: "b", writable: [{ path: "B.md", artifactKind: "k" }] })
  await seedDispatch(root, "half-t", { key: "w3-cc", kind: "produce", role: "owner", round: 1, package: "a", writable: [{ path: "A.md", artifactKind: "k" }] })
  // 模拟迁移中断：只落盘了第一段赋号
  await appendEvents(root, "half-t", [{ type: "wave-assigned", detail: { waveId: "wv1", dispatchKeys: ["w1-aa"] } }])
  const mig = await call(["migrate", "--task", "half-t"])
  assert.deepEqual(mig.assignedWaves, [{ waveId: "wv2", dispatchKeys: ["w2-bb", "w3-cc"] }], "续跑只补未赋号段，号从 max(wvN) 接续")
  const mig2 = await call(["migrate", "--task", "half-t"])
  assert.deepEqual(mig2.assignedWaves, [], "重跑等价（不重复赋号）")
  const task = await loadTask(root, "half-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const events = task.journal.filter((e) => e.type === "wave-assigned").map((e) => e.detail)
  assert.equal(events.length, 2, "半迁移 + 续跑 = 完整赋号（中断重跑等价）")
})

test("F9：跨阶段不误并——以最近 stage-advanced 事件为界，前段派发不参与赋号", async () => {
  const wf = { terminalStages: ["finish"], gates: [], stages: [
    { id: "research", label: "调研", outputs: [], teamScene: "research" },
    { id: "code-review", label: "审查", outputs: ["code-review"], teamScene: "code-review" },
  ], edges: [{ from: "research", to: "code-review", outcome: "pass" }] }
  const pol = { maxAutonomousRounds: 3, costWeights: { junior: 1, senior: 10, expert: 50 }, scenes: { research: { core: false }, "code-review": { core: false } } }
  const root = await makeProject({ workflow: wf, policy: pol })
  const call = caller(root)
  await openTask(root, "seg-t", { entry: null }) // 默认从 research 起（workflow 模式）
  await seedDispatch(root, "seg-t", { key: "w-old-stage", kind: "produce", role: "owner", round: 1, package: null, writable: [{ path: "A.md", artifactKind: "k" }] })
  await appendEvents(root, "seg-t", [{ type: "stage-advanced", detail: { from: "research", to: "code-review" } }])
  await seedDispatch(root, "seg-t", { key: "w-cur-1", kind: "produce", role: "owner", round: 1, package: null, writable: [{ path: "R.md", artifactKind: "k" }] })
  await seedDispatch(root, "seg-t", { key: "w-cur-2", kind: "produce", role: "owner", round: 2, package: null, writable: [{ path: "R.md", artifactKind: "k" }] })
  const mig = await call(["migrate", "--task", "seg-t"])
  assert.deepEqual(mig.assignedWaves, [
    { waveId: "wv1", dispatchKeys: ["w-cur-1"] },
    { waveId: "wv2", dispatchKeys: ["w-cur-2"] },
  ], "只赋号最近 stage-advanced 之后的派发（不跨阶段并波）")
  const task = await loadTask(root, "seg-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(task.journal.some((e) => e.type === "wave-assigned" && (e.detail.dispatchKeys ?? []).includes("w-old-stage")), false)
})

test("F9 四类恢复矩阵：零/单报告与同 digest 多报告机械收敛；异 digest 多报告出用户选择卡、其余写 dispatch-superseded", async () => {
  // 同 digest 多报告：机械合并，无用户卡
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "m4a-t")
  await seedDispatch(root, "m4a-t", { key: "w1-aa", kind: "produce", role: "owner", round: 1, package: null, writable: [{ path: "R.md", artifactKind: "k" }] })
  await seedDispatch(root, "m4a-t", { key: "w2-bb", kind: "produce", role: "owner", round: 1, package: null, writable: [{ path: "R.md", artifactKind: "k" }] })
  const task0 = await loadTask(root, "m4a-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const mkReport = (key, id) => writeFile(path.join(task0.root, "reports", id + ".json"), JSON.stringify({ reportId: id, dispatchKey: key, role: "owner", kind: "deliver", round: 1, stage: "code-review", package: null, payload: { outcome: "delivered", summary: "s", paths: ["R.md"] }, at: new Date().toISOString() }))
  await mkReport("w1-aa", "ra")
  await mkReport("w2-bb", "rb")
  await writeFile(path.join(task0.root, "artifacts.json"), JSON.stringify({ items: [
    { path: "R.md", digest: "d1", kind: "k", stage: "code-review", reportRef: "deliver-w1-aa", snapshotRef: "s1" },
    { path: "R.md", digest: "d1", kind: "k", stage: "code-review", reportRef: "deliver-w2-bb", snapshotRef: "s1" },
  ] }))
  const migA = await call(["migrate", "--task", "m4a-t"])
  assert.equal(migA.ok, true)
  assert.notEqual(migA.next, "decide", "同 digest 多报告机械合并、不出用户选择卡")
  assert.equal(migA.equivalent, true)
  // 异 digest 多报告：出用户选择卡，decide 保留一版、其余写 dispatch-superseded，二次迁移收敛
  const root2 = await makeProject()
  const call2 = caller(root2)
  await openTask(root2, "m4b-t")
  await seedDispatch(root2, "m4b-t", { key: "w1-aa", kind: "produce", role: "owner", round: 1, package: null, writable: [{ path: "R.md", artifactKind: "k" }] })
  await seedDispatch(root2, "m4b-t", { key: "w2-bb", kind: "produce", role: "owner", round: 1, package: null, writable: [{ path: "R.md", artifactKind: "k" }] })
  const task1 = await loadTask(root2, "m4b-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const mkReport2 = (key, id) => writeFile(path.join(task1.root, "reports", id + ".json"), JSON.stringify({ reportId: id, dispatchKey: key, role: "owner", kind: "deliver", round: 1, stage: "code-review", package: null, payload: { outcome: "delivered", summary: "s", paths: ["R.md"] }, at: new Date().toISOString() }))
  await mkReport2("w1-aa", "ra")
  await mkReport2("w2-bb", "rb")
  await writeFile(path.join(task1.root, "artifacts.json"), JSON.stringify({ items: [
    { path: "R.md", digest: "d1", kind: "k", stage: "code-review", reportRef: "deliver-w1-aa", snapshotRef: "s1" },
    { path: "R.md", digest: "d2", kind: "k", stage: "code-review", reportRef: "deliver-w2-bb", snapshotRef: "s2" },
  ] }))
  const migB = await call2(["migrate", "--task", "m4b-t"])
  assert.equal(migB.status, "awaiting-user")
  assert.equal(migB.next, "decide", "异 digest 多报告 → 用户选择卡")
  assert.deepEqual(migB.choices.map((c) => c.label), ["保留 w1-aa 的版本", "保留 w2-bb 的版本"])
  await call2(["decide", "--task", "m4b-t", "--choice", "1"])
  const t2 = await loadTask(root2, "m4b-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.deepEqual(t2.journal.filter((e) => e.type === "dispatch-superseded").map((e) => e.detail.waveId), ["wv2"], "其余版本波写 dispatch-superseded（无删除）")
  const migB2 = await call2(["migrate", "--task", "m4b-t"])
  assert.equal(migB2.ok, true)
  assert.equal(migB2.equivalent, true, "解决冲突后二次迁移收敛（迁移前后投影等价）")
  const rounds = projectRounds({ journal: t2.journal, reports: t2.reports })
  assert.deepEqual([...rounds.entries()], [[null, 1]], "被作废版本不混入收敛投影")
})

test("F9 加固：migrate 冲突卡 pending 期间 run 静止（migratePending）、intake 照常接受交付；decide 后恢复推进", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "mgpend-t")
  // 三条历史派发：w1/w2 同轮异 digest（冲突），w3 在途未交付
  await seedDispatch(root, "mgpend-t", { key: "w1-aa", kind: "produce", role: "owner", round: 1, package: null, writable: [{ path: "R.md", artifactKind: "code-review" }] })
  await seedDispatch(root, "mgpend-t", { key: "w2-bb", kind: "produce", role: "owner", round: 1, package: null, writable: [{ path: "R.md", artifactKind: "code-review" }] })
  await seedDispatch(root, "mgpend-t", { key: "w3-cc", kind: "produce", role: "owner", round: 2, package: null, writable: [{ path: "R.md", artifactKind: "code-review" }] })
  const task0 = await loadTask(root, "mgpend-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const mkReport = (key, id) => writeFile(path.join(task0.root, "reports", id + ".json"), JSON.stringify({ reportId: id, dispatchKey: key, role: "owner", kind: "deliver", round: 1, stage: "code-review", package: null, payload: { outcome: "delivered", summary: "s", paths: ["R.md"] }, at: new Date().toISOString() }))
  await mkReport("w1-aa", "ra")
  await mkReport("w2-bb", "rb")
  await writeFile(path.join(task0.root, "artifacts.json"), JSON.stringify({ items: [
    { path: "R.md", digest: "d1", kind: "code-review", stage: "code-review", reportRef: "deliver-w1-aa", snapshotRef: "s1" },
    { path: "R.md", digest: "d2", kind: "code-review", stage: "code-review", reportRef: "deliver-w2-bb", snapshotRef: "s2" },
  ] }))
  const mig = await call(["migrate", "--task", "mgpend-t"])
  assert.equal(mig.status, "awaiting-user")
  assert.equal(mig.next, "decide", "异 digest 冲突 → 迁移卡待决")
  // pending 期间：run 静止，重呈同一 migrate 卡、零新增派发（未决冲突内容不参与推导/派发）
  const still = await call(["run", "--task", "mgpend-t", "--writable", "R.md:code-review"])
  assert.equal(still.status, "awaiting-user")
  assert.equal(still.decisionId, mig.decisionId, "pending 期间 run 静止、重呈同一 migrate 卡（不推进、不代答）")
  const t1 = await loadTask(root, "mgpend-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(t1.journal.filter((e) => e.type === "dispatched").length, 3, "pending 期间零新增派发")
  // pending 期间 intake 照常接受在途派发交付（不因迁移卡误拒）
  await writeFile(path.join(root, "R.md"), "w3 内容", "utf8")
  const dl = await call(["deliver", "--task", "mgpend-t", "--key", "w3-cc", "--outcome", "delivered", "--summary", "w3交付", "--paths", "R.md"])
  assert.equal(dl.accepted, true, "pending 期间 intake 照常接受交付")
  // decide 保留 w1 版本 → 恢复推进（被作废版本不入投影）
  await call(["decide", "--task", "mgpend-t", "--choice", "1"])
  const next = await call(["run", "--task", "mgpend-t"])
  assert.equal(next.next, "dispatch")
  assert.equal(next.dispatch.role, "challenger", "decide 后任务恢复推进（进入评审链）")
  assert.equal(next.dispatch.round, 2, "保留版（轮 1）+ 在途交付（轮 2）→ 投影轮 2")
})

// —— F3：retire 作废恢复边 ——

test("F3 retire 幂等矩阵：缺 reason/未知波/已结波拒绝附指引；合法作废未结波；旧 key 交付被拒；重跑取新卡", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "ret-t")
  const d = await call(["run", "--task", "ret-t", "--writable", "R.md:code-review"])
  const k1 = d.dispatch.key
  const noReason = await call(["retire", "--task", "ret-t", "--wave", "wv1"])
  assert.equal(noReason.ok, false)
  assert.match(noReason.message, /--reason/)
  const unknown = await call(["retire", "--task", "ret-t", "--wave", "wv99", "--reason", "r"])
  assert.equal(unknown.code, "RETIRE_UNKNOWN_WAVE")
  assert.match(unknown.message, /当前未结波：wv1/, "未知波拒绝附当前未结波清单")
  await call(["agent-map", "--task", "ret-t", "--key", k1, "--agent", "child-R"])
  const ok = await call(["retire", "--task", "ret-t", "--wave", "wv1", "--reason", "派错了"])
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.supersededKeys, [k1])
  const idem = await call(["retire", "--task", "ret-t", "--wave", "wv1", "--reason", "again"])
  assert.equal(idem.idempotent, true, "重复 retire 幂等返回")
  const task = await loadTask(root, "ret-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const ev = task.journal.find((e) => e.type === "dispatch-superseded")
  assert.equal(ev.detail.waveId, "wv1")
  assert.equal(ev.detail.reason, "派错了")
  assert.equal(ev.detail.at, undefined, "dispatch-superseded detail 不含 at（事件顶层已有）")
  const agents = JSON.parse(await readFile(path.join(task.root, "agents.json"), "utf8"))
  assert.equal(agents.mappings[k1], undefined, "retire 清退该波映射（审计记录保留在 journal）")
  const oldDeliver = await call(["deliver", "--task", "ret-t", "--key", k1, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  assert.equal(oldDeliver.ok, false)
  assert.equal(oldDeliver.code, "INTAKE_REJECTED")
  assert.match(oldDeliver.message, /已作废/, "superseded key 迟到交付被拒附指引")
  const next = await call(["run", "--task", "ret-t", "--writable", "R.md:code-review"])
  assert.equal(next.next, "dispatch", "retire 后重新派发新波")
  assert.notEqual(next.dispatch.key, k1)
  assert.equal(next.dispatch.waveId, "wv2")
  // 已结波 retire 拒绝
  await deliverContent(call, root, "ret-t", next.dispatch.key, "R.md", "v1")
  const settled = await call(["retire", "--task", "ret-t", "--wave", "wv2", "--reason", "x"])
  assert.equal(settled.code, "RETIRE_SETTLED_WAVE")
  assert.match(settled.message, /已全部交付/)
})

test("F3 retire：部分交付后 retire——已交付报告保留审计、投影排除（重新派发该包）、回溯跳过 superseded", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "retp-t")
  await call(["plan", "--task", "retp-t", "--packages", PKGS2])
  const d1 = await call(["run", "--task", "retp-t"])
  const kS = d1.dispatches.find((x) => x.package === "store").key
  await deliverContent(call, root, "retp-t", kS, "S.md", "store v1")
  const task0 = await loadTask(root, "retp-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.deepEqual([...projectRounds({ journal: task0.journal, reports: task0.reports }).entries()], [["store", 1]])
  await call(["retire", "--task", "retp-t", "--wave", "wv1", "--reason", "store 交付有误"])
  const task1 = await loadTask(root, "retp-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(task1.reports.some((r) => r.dispatchKey === kS), true, "已交付报告保留为审计事实")
  assert.equal(projectRounds({ journal: task1.journal, reports: task1.reports }).size, 0, "superseded 波报告不参与推导（投影排除）")
  const d2 = await call(["run", "--task", "retp-t"])
  assert.equal(d2.dispatches.length, 2, "投影排除后 store 重新进入派发（不残留部分交付状态）")
  assert.ok(d2.dispatches.some((x) => x.package === "store"))
  // 单 owner：回溯跳过 superseded key 的映射
  const root2 = await makeProject()
  const call2 = caller(root2)
  await openTask(root2, "retb-t")
  const o1 = await call2(["run", "--task", "retb-t", "--writable", "R.md:code-review"])
  await call2(["agent-map", "--task", "retb-t", "--key", o1.dispatch.key, "--agent", "child-A"])
  await deliverContent(call2, root2, "retb-t", o1.dispatch.key, "R.md", "v1")
  const rv1 = await call2(["run", "--task", "retb-t"])
  await call2(["review", "--task", "retb-t", "--key", rv1.dispatch.key, "--recommendation", "rework", "--summary", "需修"])
  const pl1 = await call2(["dispatch-plan", "--task", "retb-t", "--json", "--writable", "R.md:code-review"])
  const k2 = pl1.waves[0]
  await call2(["agent-map", "--task", "retb-t", "--key", k2.dispatchKey, "--agent", "child-B"])
  await call2(["retire", "--task", "retb-t", "--wave", k2.waveId, "--reason", "替换成员"])
  const pl2 = await call2(["dispatch-plan", "--task", "retb-t", "--json", "--writable", "R.md:code-review"])
  assert.equal(pl2.waves[0].expectedAgentId, "child-A", "回溯跳过 superseded 波映射（不解析 child-B），回退到仍有效的最早映射")
})

// —— B8：未迁移任务混合态 ——

test("B8：无 waveId 派发按 key 兜底各自成波，守卫回退尾部连续批次、不重复派发", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "legacy-t")
  await seedDispatch(root, "legacy-t", { key: "w9-legacy", kind: "produce", role: "owner", round: 1, package: null, writable: [{ path: "R.md", artifactKind: "code-review" }] })
  const w = await call(["run", "--task", "legacy-t", "--writable", "R.md:code-review"])
  assert.equal(w.transition, "wait-inflight", "无 waveId 在途派发按 key 兜底（不重复派发）")
  assert.equal(w.dispatchKey, "w9-legacy")
  const groups = waveGroups((await loadTask(root, "legacy-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })).journal)
  assert.deepEqual(groups, [{ waveId: null, keys: ["w9-legacy"] }], "无 waveId 事实：每条派发各视为独立波（退化语义）")
  await deliverContent(call, root, "legacy-t", "w9-legacy", "R.md", "v1")
  const next = await call(["run", "--task", "legacy-t"])
  assert.equal(next.dispatch.role, "challenger", "交付后正常推进（迁移前等价语义）")
})

// —— 五类鲁棒性（AGENTS 变更要求：损坏输入/非法流转/并发/恢复/幂等）——

test("损坏输入与重复决定：损坏 journal 抛错不静默；重复 decide 拒绝 DECISION_STALE", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "corrupt-t")
  const task = await loadTask(root, "corrupt-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  await writeFile(path.join(task.root, "journal.jsonl"), "{ 这不是 JSON\\n")
  await assert.rejects(call(["run", "--task", "corrupt-t", "--writable", "R.md:code-review"]), SyntaxError, "损坏 journal 显式抛错（不静默吞掉）")
  const root2 = await makeProject()
  const { call: call2 } = await seedConvergedStage(root2, "dupdec-t")
  await call2(["run", "--task", "dupdec-t"])
  await call2(["decide", "--task", "dupdec-t", "--choice", "1"])
  const again = await call2(["decide", "--task", "dupdec-t", "--choice", "1"])
  assert.equal(again.ok, false)
  assert.equal(again.code, "DECISION_STALE", "重复 decide 拒绝（卡片已被消费）")
})

test("并发：retire×run 与 迁移×交付 并发后状态一致（任务锁串行化，任意顺序均收敛）", async () => {
  // retire×run 并发
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "cc1-t")
  const d = await call(["run", "--task", "cc1-t", "--writable", "R.md:code-review"])
  await Promise.all([
    call(["retire", "--task", "cc1-t", "--wave", "wv1", "--reason", "并发作废"]),
    call(["run", "--task", "cc1-t", "--writable", "R.md:code-review"]),
  ])
  const t1 = await loadTask(root, "cc1-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(t1.journal.filter((e) => e.type === "dispatch-superseded").length, 1, "恰好一条作废事实（无论先 retire 还是先 run）")
  // 两种串行化顺序：retire 先 → 并发 run 已派新卡（随后 run 为 wait-inflight 新卡）；
  // run 先 → wait-inflight（无新派发）、retire 后推进取新卡。断言对两种顺序均成立。
  const after = await call(["run", "--task", "cc1-t", "--writable", "R.md:code-review"])
  const resumed = after.next === "dispatch" ? after.dispatch.key : after.dispatchKey
  assert.ok(resumed && resumed !== d.dispatch.key, "作废后推进不再指向旧 key（新卡或新卡在途）")
  const oldDeliver = await call(["deliver", "--task", "cc1-t", "--key", d.dispatch.key, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  assert.equal(oldDeliver.ok, false, "旧 key 在任何顺序下都被拒")
  // 迁移×交付并发
  const root2 = await makeProject()
  const call2 = caller(root2)
  await openTask(root2, "cc2-t")
  await seedDispatch(root2, "cc2-t", { key: "w1-cc", kind: "produce", role: "owner", round: 1, package: null, writable: [{ path: "R.md", artifactKind: "code-review" }] })
  await writeFile(path.join(root2, "R.md"), "v1", "utf8")
  const [mig, dl] = await Promise.all([
    call2(["migrate", "--task", "cc2-t"]),
    call2(["deliver", "--task", "cc2-t", "--key", "w1-cc", "--outcome", "delivered", "--summary", "s", "--paths", "R.md"]),
  ])
  assert.equal(dl.accepted, true)
  const mig2 = await call2(["migrate", "--task", "cc2-t"])
  assert.equal(mig2.ok, true)
  const t2 = await loadTask(root2, "cc2-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(t2.journal.filter((e) => e.type === "wave-assigned").length, 1, "迁移×交付并发后赋号事实恰好一条（不重复）")
  assert.equal(t2.reports.filter((r) => r.kind === "deliver").length, 1)
  assert.ok(mig.ok === true || mig.status === "awaiting-user", "迁移调用正常返回（两种顺序均合法）")
})
