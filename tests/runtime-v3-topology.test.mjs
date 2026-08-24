// v3.2 拓扑波组集成测试：tw plan 验收/重拆窗口/多包全链路/波组导出/inflight 重建
import assert from "node:assert/strict"
import { writeFile, readFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { tw } from "../runtime-v3/cli.mjs"
import { loadTask } from "../runtime-v3/store.mjs"
import { makeProject, caller, openTask, FIX_WORKFLOW, FIX_POLICY } from "./support/v3-fixtures.mjs"

const PKGS = JSON.stringify([
  { id: "store", writable: ["S.md:code-review"], done: ["store 结论"], dependsOn: [] },
  { id: "intake", writable: ["I.md:code-review"], done: ["intake 结论"], dependsOn: [] },
  { id: "overview", writable: ["O.md:code-review"], done: ["汇总各包结论、解决冲突、不丢信息"], dependsOn: ["store", "intake"] },
])

test("tw plan：机械验收通过登记 packages.json + journal；重叠/成环/缺标准拒绝", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "plan-t")
  const okCard = await call(["plan", "--task", "plan-t", "--packages", PKGS])
  assert.equal(okCard.ok, true)
  assert.equal(okCard.replanned, false)
  const task = await loadTask(root, "plan-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(task.packages.length, 3)
  assert.ok(task.journal.some((e) => e.type === "packages-planned" && e.detail.packages.includes("overview")))
  // 重叠
  const overlap = await call(["plan", "--task", "plan-t", "--packages", JSON.stringify([
    { id: "a", writable: ["X.md:k"], done: ["d"], dependsOn: [] },
    { id: "b", writable: ["X.md:k"], done: ["d"], dependsOn: [] },
  ])])
  assert.equal(overlap.ok, false)
  assert.equal(overlap.code, "PLAN_REJECTED")
  assert.match(overlap.message, /重叠/)
  // 成环
  const cycle = await call(["plan", "--task", "plan-t", "--packages", JSON.stringify([
    { id: "a", writable: ["A.md:k"], done: ["d"], dependsOn: ["b"] },
    { id: "b", writable: ["B.md:k"], done: ["d"], dependsOn: ["a"] },
  ])])
  assert.equal(cycle.code, "PLAN_REJECTED")
  assert.match(cycle.message, /成环/)
  // 缺完成标准
  const noDone = await call(["plan", "--task", "plan-t", "--packages", JSON.stringify([{ id: "a", writable: ["A.md:k"], done: [], dependsOn: [] }])])
  assert.equal(noDone.code, "PLAN_REJECTED")
  assert.match(noDone.message, /完成标准/)
})

test("tw plan 重拆窗口：在途派发时拒绝", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "replan-t")
  await call(["plan", "--task", "replan-t", "--packages", PKGS])
  const d = await call(["run", "--task", "replan-t"])
  assert.equal(d.dispatches.length, 2, "首波只有无依赖包")
  const blocked = await call(["plan", "--task", "replan-t", "--packages", PKGS])
  assert.equal(blocked.ok, false)
  assert.match(blocked.message, /在途派发/)
})

test("多包全链路：并行派发 → 批次在途 → 组合评审 → 选择性重派(continuation) → 依赖解锁 → 人工门", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "multi-t")
  await call(["plan", "--task", "multi-t", "--packages", PKGS])

  // 1) 首波：store+intake 并行（overview 依赖未满足）
  const d1 = await call(["run", "--task", "multi-t"])
  assert.equal(d1.dispatches.length, 2)
  assert.deepEqual(d1.dispatches.map((x) => x.package).sort(), ["intake", "store"])
  assert.equal(d1.dispatches.every((x) => x.continuation === false), true)
  const [kS, kI] = [d1.dispatches.find((x) => x.package === "store").key, d1.dispatches.find((x) => x.package === "intake").key]

  // 2) store 先交付 → run 批次在途（intake 未交付），inflight 内嵌原派单
  await writeFile(path.join(root, "S.md"), "store v1", "utf8")
  await call(["deliver", "--task", "multi-t", "--key", kS, "--outcome", "delivered", "--summary", "s1", "--paths", "S.md"])
  const w1 = await call(["run", "--task", "multi-t"])
  assert.equal(w1.transition, "wait-inflight")
  assert.equal(w1.inflight.length, 1, "intake 在途")
  assert.match(w1.inflight[0].prompt, /# 派单/, "inflight 内嵌原派单全文（F4）")
  assert.equal(w1.inflight[0].package, "intake")

  // 3) intake 交付 → 组合评审波（consolidation）
  await writeFile(path.join(root, "I.md"), "intake v1", "utf8")
  await call(["deliver", "--task", "multi-t", "--key", kI, "--outcome", "delivered", "--summary", "s2", "--paths", "I.md"])
  const d2 = await call(["run", "--task", "multi-t"])
  assert.equal(d2.dispatch.role, "challenger")
  assert.equal(d2.dispatch.scope, "consolidation")
  assert.match(d2.dispatch.prompt, /组合评审/)
  // deliver 报告落盘带 package（P4 从派发事件推导）
  const mid = await loadTask(root, "multi-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const sDeliver = mid.reports.find((r) => r.dispatchKey === kS)
  assert.equal(sDeliver.package, "store")

  // 4) challenger rework 只指 store（findings 带归属）→ 选择性重派 + continuation
  await call(["review", "--task", "multi-t", "--key", d2.dispatch.key, "--recommendation", "rework", "--summary", "store 需修", "--findings", JSON.stringify([{ severity: "risk", statement: "store 论据不足", package: "store" }])])
  const d3 = await call(["run", "--task", "multi-t"])
  assert.equal(d3.dispatches.length, 1, "只重派 store")
  assert.equal(d3.dispatches[0].package, "store")
  assert.equal(d3.dispatches[0].continuation, true, "store 续派")
  assert.match(d3.dispatches[0].prompt, /# 续派/, "增量派单标头")
  assert.match(d3.dispatches[0].prompt, /store 论据不足/, "意见内嵌")
  assert.doesNotMatch(d3.dispatches[0].prompt, /目标：/, "续派不重述全量目标")

  // 5) store 修订交付 → 评审（reviewedPackages 快照自动落盘，含轮次）→ accept → verdict
  await writeFile(path.join(root, "S.md"), "store v2", "utf8")
  await call(["deliver", "--task", "multi-t", "--key", d3.dispatches[0].key, "--outcome", "delivered", "--summary", "s3", "--paths", "S.md"])
  const d4 = await call(["run", "--task", "multi-t"])
  assert.equal(d4.dispatch.role, "challenger")
  await call(["review", "--task", "multi-t", "--key", d4.dispatch.key, "--recommendation", "accept", "--summary", "ok"])
  const after = await loadTask(root, "multi-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const lastReview = after.reports.filter((r) => r.role === "challenger").at(-1)
  const snapS = lastReview.reviewedPackages.find((e) => e.package === "store")
  assert.equal(snapS.round, 2, "快照记录 store 当前轮次（轮2 修订被新评审覆盖）")
  const d5 = await call(["run", "--task", "multi-t"])
  assert.equal(d5.dispatch.role, "expert", "core 场景进入裁决")
  await call(["review", "--task", "multi-t", "--key", d5.dispatch.key, "--recommendation", "accept", "--summary", "v", "--verdict", JSON.stringify({ outcome: "accept", rationale: "r", confidence: "high", recommendedAction: "go" })])

  // 6) 裁决过 → overview 依赖解锁（produce，continuation=false 新成员）
  const d6 = await call(["run", "--task", "multi-t"])
  assert.equal(d6.dispatches.length, 1)
  assert.equal(d6.dispatches[0].package, "overview")
  assert.equal(d6.dispatches[0].continuation, false)
  await writeFile(path.join(root, "O.md"), "overview v1", "utf8")
  await call(["deliver", "--task", "multi-t", "--key", d6.dispatches[0].key, "--outcome", "delivered", "--summary", "s4", "--paths", "O.md"])
  const d7 = await call(["run", "--task", "multi-t"])
  await call(["review", "--task", "multi-t", "--key", d7.dispatch.key, "--recommendation", "accept", "--summary", "ok"])
  const d8 = await call(["run", "--task", "multi-t"])
  await call(["review", "--task", "multi-t", "--key", d8.dispatch.key, "--recommendation", "accept", "--summary", "v", "--verdict", JSON.stringify({ outcome: "accept", rationale: "r", confidence: "high", recommendedAction: "go" })])

  // 7) 人工门 → awaiting-user → decide → completed
  const gateCard = await call(["run", "--task", "multi-t"])
  assert.equal(gateCard.status, "awaiting-user")
  await call(["route", "--task", "multi-t", "--route", "e2e", "--decision", "skip", "--basis", "文档任务不适用"])
  const gate2 = await call(["run", "--task", "multi-t"])
  assert.equal(gate2.status, "awaiting-user")
  await call(["decide", "--task", "multi-t", "--choice", "1"])
  const done = await call(["run", "--task", "multi-t"])
  assert.equal(done.status, "completed", "多包全链路收敛")
})

test("dispatch-plan 波组导出：package/continuation/dependsOn/weight 字段", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "exp-t")
  await call(["plan", "--task", "exp-t", "--packages", PKGS])
  const plan = await call(["dispatch-plan", "--task", "exp-t", "--json"])
  assert.equal(plan.stop, null)
  assert.equal(plan.waves.length, 2)
  const w = plan.waves[0]
  assert.ok(w.package)
  assert.equal(w.continuation, false)
  assert.deepEqual(w.dependsOn, [])
  assert.equal(w.weight, 1, "junior 权重")
  assert.equal(plan.waves.every((x) => x.modelHint), true)
})

test("单 owner 任务无 packages：行为与 v3.1 一致（--writable 派单）", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "solo-t")
  const d = await call(["run", "--task", "solo-t", "--writable", "R.md:code-review"])
  assert.equal(d.dispatch.kind, "produce")
  assert.equal(d.dispatch.continuation, false)
  assert.equal(d.dispatches.length, 1)
  assert.equal(d.dispatches[0].package, undefined, "单 owner 不带 package 字段")
})

test("risk 升档：critical → expert Owner（只升 owner 档，challenger 不变）", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "risk-t")
  await call(["intent", "--task", "risk-t", "--risk", "critical"])
  const d = await call(["run", "--task", "risk-t", "--writable", "R.md:code-review"])
  assert.equal(d.dispatch.tier, "expert", "critical 任务 Owner 升 expert 档")
  // challenger 档不受 risk 影响（policy challengerTier=senior）
  await writeFile(path.join(root, "R.md"), "x", "utf8")
  await call(["deliver", "--task", "risk-t", "--key", d.dispatch.key, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  const r = await call(["run", "--task", "risk-t"])
  assert.equal(r.dispatch.tier, "senior", "challenger 档不随 risk 升降")
})

test("候选池 + 家族去重：同档多 owner 派发优先不同模型家族", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "pool-t")
  // junior 池：两个不同家族候选
  const mapFile = path.join(root, ".team-work", "platform", "dsh.json")
  await mkdir(path.dirname(mapFile), { recursive: true })
  await writeFile(mapFile, JSON.stringify({ tiers: { junior: [
    { provider: "prov-a", model: "familyone-lite", family: "familyone" },
    { provider: "prov-b", model: "familytwo-lite", family: "familytwo" },
  ] }, defaults: null }))
  await call(["plan", "--task", "pool-t", "--packages", PKGS])
  const plan = await call(["dispatch-plan", "--task", "pool-t", "--json"])
  assert.equal(plan.waves.length, 2, "首波两包（overview 依赖锁）")
  const [m1, m2] = plan.waves.map((w) => w.modelHint)
  assert.equal(m1.model, "familyone-lite")
  assert.equal(m2.model, "familytwo-lite", "同档第二 owner 家族去重选第二候选")
  assert.equal(m2.selectedBy, "diversity")
})

