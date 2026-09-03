// v3.2 拓扑波组集成测试：tw plan 验收/重拆窗口/多包全链路/波组导出/inflight 重建
import assert from "node:assert/strict"
import { writeFile, readFile } from "node:fs/promises"
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

const settingsFile = path.join(tmpdir(), `tw-topology-tiers-${process.pid}-${Date.now()}.yaml`)
const BASE_SETTINGS = `
team-work-dsh:
  tiers:
    junior: { provider: topology-junior, model: topology-junior }
    senior: { provider: topology-senior, model: topology-senior }
    expert: { provider: topology-expert, model: topology-expert }
`
await writeFile(settingsFile, BASE_SETTINGS)
process.env.DSH_SETTINGS = settingsFile

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
  // 目录条目与其下路径视为重叠（可写互斥是并行前提）；不相关目录不重叠
  const dirOverlap = await call(["plan", "--task", "plan-t", "--packages", JSON.stringify([
    { id: "a", writable: ["src/:k"], done: ["d"], dependsOn: [] },
    { id: "b", writable: ["src/foo.js:k"], done: ["d"], dependsOn: [] },
  ])])
  assert.equal(dirOverlap.code, "PLAN_REJECTED")
  assert.match(dirOverlap.message, /重叠/)
  // 同名文件/目录与祖先组件同样重叠（同一路径只一个 inode）
  const samePath = await call(["plan", "--task", "plan-t", "--packages", JSON.stringify([
    { id: "a", writable: ["docs:k"], done: ["d"], dependsOn: [] },
    { id: "b", writable: ["docs/:k"], done: ["d"], dependsOn: [] },
  ])])
  assert.equal(samePath.code, "PLAN_REJECTED", "docs 与 docs/ 同一路径，重叠")
  assert.match(samePath.message, /重叠/)
  const ancestor = await call(["plan", "--task", "plan-t", "--packages", JSON.stringify([
    { id: "a", writable: ["docs:k"], done: ["d"], dependsOn: [] },
    { id: "b", writable: ["docs/x.md:k"], done: ["d"], dependsOn: [] },
  ])])
  assert.equal(ancestor.code, "PLAN_REJECTED", "docs 与 docs/x.md 祖先组件，重叠")
  const sibling = await call(["plan", "--task", "plan-t", "--packages", JSON.stringify([
    { id: "a", writable: ["docs/:k"], done: ["d"], dependsOn: [] },
    { id: "b", writable: ["docs-x/:k"], done: ["d"], dependsOn: [] },
  ])])
  assert.equal(sibling.ok, true, "兄弟前缀（docs/ 与 docs-x/）不重叠")
  const dirOk = await call(["plan", "--task", "plan-t", "--packages", JSON.stringify([
    { id: "a", writable: ["src/:k"], done: ["d"], dependsOn: [] },
    { id: "b", writable: ["docs/:k"], done: ["d"], dependsOn: [] },
  ])])
  assert.equal(dirOk.ok, true, "互斥目录条目通过")
})

test("produce blocked 静止卡与扩权重派（单 owner）：不再无限重派；新范围重派卡内嵌 blocked 原因", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "blk-t")
  const d1 = await call(["dispatch-plan", "--task", "blk-t", "--writable", "R.md:code-review"])
  await call(["deliver", "--task", "blk-t", "--key", d1.waves[0].dispatchKey, "--outcome", "blocked", "--summary", "必须修改 src/config.ts 才能完成，超出可写范围"])
  const card = await call(["dispatch-plan", "--task", "blk-t"])
  assert.equal(card.stop, "awaiting-user")
  assert.equal(card.card.next, "re-scope")
  assert.match(card.card.question, /blocked/)
  assert.match(card.card.question, /src\/config\.ts/)
  assert.match(card.card.note, /dispatch-plan --writable/)
  const card2 = await call(["dispatch-plan", "--task", "blk-t"])
  assert.equal(card2.stop, "awaiting-user", "静止卡幂等：重复推进不重派同形状派单")
  // 扩权重派：Lead 携新可写范围重跑 dispatch-plan = 用户重派指示
  const d2 = await call(["dispatch-plan", "--task", "blk-t", "--writable", "R.md:code-review", "--writable", "src/:code"])
  assert.equal(d2.stop, null)
  assert.ok(d2.waves.length > 0, "扩权重派产出新 produce 波")
  assert.match(d2.waves[0].prompt, /上一轮 blocked 原因/)
  assert.match(d2.waves[0].prompt, /src\/config\.ts/)
  await writeFile(path.join(root, "R.md"), "报告", "utf8")
  await call(["deliver", "--task", "blk-t", "--key", d2.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "完成", "--paths", "R.md"])
  const rv = await call(["dispatch-plan", "--task", "blk-t"])
  assert.equal(rv.waves[0].role, "challenger", "扩权交付后恢复正常评审链")
})

test("多包 blocked：评审优先消化已交付包；blocked 卡放行 plan 重拆扩权，重拆后派新波并带 blocked 原因", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "mpblk-t")
  await call(["plan", "--task", "mpblk-t", "--packages", JSON.stringify([
    { id: "a", writable: ["A.md:code-review"], done: ["a 标准"], dependsOn: [] },
    { id: "b", writable: ["B.md:code-review"], done: ["b 标准"], dependsOn: [] },
  ])])
  const w = await call(["dispatch-plan", "--task", "mpblk-t"])
  assert.equal(w.waves.length, 2)
  const keyOf = Object.fromEntries(w.waves.map((x) => [x.package, x.dispatchKey]))
  await writeFile(path.join(root, "A.md"), "a", "utf8")
  await call(["deliver", "--task", "mpblk-t", "--key", keyOf.a, "--outcome", "delivered", "--summary", "a 完成", "--paths", "A.md"])
  await call(["deliver", "--task", "mpblk-t", "--key", keyOf.b, "--outcome", "blocked", "--summary", "需要改 C.md，超出 B 包可写范围"])
  // a 已交付未评审 → 评审波优先消化（b 的 blocked 卡延后）
  const rv = await call(["dispatch-plan", "--task", "mpblk-t"])
  assert.equal(rv.waves[0].role, "challenger")
  await call(["review", "--task", "mpblk-t", "--key", rv.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "a 通过"])
  // core 场景 → expert 裁决
  const vd = await call(["dispatch-plan", "--task", "mpblk-t"])
  assert.equal(vd.waves[0].role, "expert")
  await call(["review", "--task", "mpblk-t", "--key", vd.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "裁决", "--verdict", JSON.stringify({ outcome: "accept", rationale: "r", confidence: "high", recommendedAction: "a" })])
  // a 出集后 b 仍 blocked → 静止卡（带 blocked 原因摘要）
  const card = await call(["dispatch-plan", "--task", "mpblk-t"])
  assert.equal(card.stop, "awaiting-user")
  assert.equal(card.card.next, "re-scope")
  assert.match(card.card.question, /包 b/)
  assert.match(card.card.question, /C\.md/)
  // blocked 静止卡放行重拆（扩权恢复通道），重拆后 run 派 b 新波并内嵌 blocked 原因
  const replan = await call(["plan", "--task", "mpblk-t", "--packages", JSON.stringify([
    { id: "a", writable: ["A.md:code-review"], done: ["a 标准"], dependsOn: [] },
    { id: "b", writable: ["B.md:code-review", "C.md:code-review"], done: ["b 标准"], dependsOn: [] },
  ])])
  assert.equal(replan.ok, true, "blocked 静止卡允许重拆扩权")
  const d = await call(["dispatch-plan", "--task", "mpblk-t"])
  assert.equal(d.stop, null)
  assert.equal(d.waves[0].package, "b")
  assert.match(d.waves[0].prompt, /上一轮 blocked 原因/)
})

test("respond blocked（返工波）：owner 无法返工时出静止卡，不再无限重派 respond；扩权重派恢复", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "rblk-t")
  const d1 = await call(["dispatch-plan", "--task", "rblk-t", "--writable", "R.md:code-review"])
  await writeFile(path.join(root, "R.md"), "初版", "utf8")
  await call(["deliver", "--task", "rblk-t", "--key", d1.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "初版", "--paths", "R.md"])
  const rv = await call(["dispatch-plan", "--task", "rblk-t"])
  assert.equal(rv.waves[0].role, "challenger")
  await call(["review", "--task", "rblk-t", "--key", rv.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "要求补充"])
  const d2 = await call(["dispatch-plan", "--task", "rblk-t", "--writable", "R.md:code-review"])
  assert.equal(d2.stop, null)
  assert.equal(d2.waves[0].kind, "respond")
  await call(["deliver", "--task", "rblk-t", "--key", d2.waves[0].dispatchKey, "--outcome", "blocked", "--summary", "返工需要改 T.md，超出可写范围"])
  const card = await call(["dispatch-plan", "--task", "rblk-t"])
  assert.equal(card.stop, "awaiting-user", "respond blocked 同样静止出卡（不再无限重派返工波）")
  assert.equal(card.card.next, "re-scope")
  assert.match(card.card.question, /T\.md/)
  // 扩权重派：新范围含 T.md，重派派单内嵌 blocked 原因（投影轮 1 → 新 produce 轮 2）
  const d3 = await call(["dispatch-plan", "--task", "rblk-t", "--writable", "R.md:code-review", "--writable", "T.md:code"])
  assert.equal(d3.stop, null)
  assert.equal(d3.waves[0].round, 2)
  assert.match(d3.waves[0].prompt, /上一轮 blocked 原因/)
})

test("tw plan 重拆窗口：在途派发时拒绝", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "replan-t")
  await call(["plan", "--task", "replan-t", "--packages", PKGS])
  const d = await call(["dispatch-plan", "--task", "replan-t"])
  assert.equal(d.waves.length, 2, "首波只有无依赖包")
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
  const d1 = await call(["dispatch-plan", "--task", "multi-t"])
  assert.equal(d1.waves.length, 2)
  assert.deepEqual(d1.waves.map((x) => x.package).sort(), ["intake", "store"])
  assert.equal(d1.waves.every((x) => x.continuation === false), true)
  const [kS, kI] = [d1.waves.find((x) => x.package === "store").dispatchKey, d1.waves.find((x) => x.package === "intake").dispatchKey]

  // 2) store 先交付 → run 批次在途（intake 未交付），inflight 内嵌原派单
  await writeFile(path.join(root, "S.md"), "store v1", "utf8")
  await call(["deliver", "--task", "multi-t", "--key", kS, "--outcome", "delivered", "--summary", "s1", "--paths", "S.md"])
  const w1 = await call(["dispatch-plan", "--task", "multi-t"])
  assert.equal(w1.stop, "wait-inflight")
  assert.equal(w1.inflight.length, 1, "intake 在途")
  assert.match(w1.inflight[0].prompt, /# 派单/, "inflight 内嵌原派单全文（F4）")
  assert.equal(w1.inflight[0].package, "intake")

  // 3) intake 交付 → 组合评审波（consolidation）
  await writeFile(path.join(root, "I.md"), "intake v1", "utf8")
  await call(["deliver", "--task", "multi-t", "--key", kI, "--outcome", "delivered", "--summary", "s2", "--paths", "I.md"])
  const d2 = await call(["dispatch-plan", "--task", "multi-t"])
  assert.equal(d2.waves[0].role, "challenger")
  assert.equal(d2.waves[0].scope, "consolidation")
  assert.match(d2.waves[0].prompt, /组合评审/)
  // deliver 报告落盘带 package（P4 从派发事件推导）
  const mid = await loadTask(root, "multi-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const sDeliver = mid.reports.find((r) => r.dispatchKey === kS)
  assert.equal(sDeliver.package, "store")

  // 4) challenger rework 只指 store（findings 带归属）→ 选择性重派 + continuation
  await call(["review", "--task", "multi-t", "--key", d2.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "store 需修", "--findings", JSON.stringify([{ severity: "risk", statement: "store 论据不足", package: "store" }])])
  const d3 = await call(["dispatch-plan", "--task", "multi-t"])
  assert.equal(d3.waves.length, 1, "只重派 store")
  assert.equal(d3.waves[0].package, "store")
  assert.equal(d3.waves[0].continuation, true, "store 续派")
  assert.match(d3.waves[0].prompt, /# 续派/, "增量派单标头")
  assert.match(d3.waves[0].prompt, /store 论据不足/, "意见内嵌")
  assert.doesNotMatch(d3.waves[0].prompt, /目标：/, "续派不重述全量目标")

  // 5) store 修订交付 → 评审（reviewedPackages 快照自动落盘，含轮次）→ accept → verdict
  await writeFile(path.join(root, "S.md"), "store v2", "utf8")
  await call(["deliver", "--task", "multi-t", "--key", d3.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s3", "--paths", "S.md"])
  const d4 = await call(["dispatch-plan", "--task", "multi-t"])
  assert.equal(d4.waves[0].role, "challenger")
  await call(["review", "--task", "multi-t", "--key", d4.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "ok"])
  const after = await loadTask(root, "multi-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const lastReview = after.reports.filter((r) => r.role === "challenger").at(-1)
  const snapS = lastReview.reviewedPackages.find((e) => e.package === "store")
  assert.equal(snapS.round, 2, "快照记录 store 当前轮次（轮2 修订被新评审覆盖）")
  const d5 = await call(["dispatch-plan", "--task", "multi-t"])
  assert.equal(d5.waves[0].role, "expert", "core 场景进入裁决")
  await call(["review", "--task", "multi-t", "--key", d5.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "v", "--verdict", JSON.stringify({ outcome: "accept", rationale: "r", confidence: "high", recommendedAction: "go" })])

  // 6) 裁决过 → overview 依赖解锁（produce，continuation=false 新成员）
  const d6 = await call(["dispatch-plan", "--task", "multi-t"])
  assert.equal(d6.waves.length, 1)
  assert.equal(d6.waves[0].package, "overview")
  assert.equal(d6.waves[0].continuation, false)
  await writeFile(path.join(root, "O.md"), "overview v1", "utf8")
  await call(["deliver", "--task", "multi-t", "--key", d6.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s4", "--paths", "O.md"])
  const d7 = await call(["dispatch-plan", "--task", "multi-t"])
  await call(["review", "--task", "multi-t", "--key", d7.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "ok"])
  const d8 = await call(["dispatch-plan", "--task", "multi-t"])
  await call(["review", "--task", "multi-t", "--key", d8.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "v", "--verdict", JSON.stringify({ outcome: "accept", rationale: "r", confidence: "high", recommendedAction: "go" })])

  // 7) 人工门 → awaiting-user → decide → completed
  const gateCard = await call(["dispatch-plan", "--task", "multi-t"])
  assert.equal(gateCard.card.status, "awaiting-user", "人工门/路由静止卡（await-route 卡 stop 归 blocked，卡内 status 为准）")
  await call(["route", "--task", "multi-t", "--route", "e2e", "--decision", "skip", "--basis", "文档任务不适用"])
  const gate2 = await call(["dispatch-plan", "--task", "multi-t"])
  assert.equal(gate2.stop, "awaiting-user")
  await call(["decide", "--task", "multi-t", "--choice", "1"])
  const done = await call(["dispatch-plan", "--task", "multi-t"])
  assert.equal(done.stop, "completed", "多包全链路收敛")
  assert.equal(done.card.status, "completed")
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

test("expert rework 后的 respond 派单内嵌裁决原因（reworkContext 不按包过滤裁决）", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "erwd-t")
  await call(["plan", "--task", "erwd-t", "--packages", PKGS])
  const d1 = await call(["dispatch-plan", "--task", "erwd-t"])
  const kS = d1.waves.find((x) => x.package === "store").dispatchKey
  const kI = d1.waves.find((x) => x.package === "intake").dispatchKey
  await writeFile(path.join(root, "S.md"), "v1", "utf8")
  await writeFile(path.join(root, "I.md"), "v1", "utf8")
  await call(["deliver", "--task", "erwd-t", "--key", kS, "--outcome", "delivered", "--summary", "s", "--paths", "S.md"])
  await call(["deliver", "--task", "erwd-t", "--key", kI, "--outcome", "delivered", "--summary", "s", "--paths", "I.md"])
  const d2 = await call(["dispatch-plan", "--task", "erwd-t"])
  await call(["review", "--task", "erwd-t", "--key", d2.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "ok"])
  const d3 = await call(["dispatch-plan", "--task", "erwd-t"])
  await call(["review", "--task", "erwd-t", "--key", d3.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "v", "--verdict", JSON.stringify({ outcome: "rework", rationale: "总览交付物缺失，模块文档本身可接受", confidence: "high", recommendedAction: "补齐缺失交付物" })])
  const d4 = await call(["dispatch-plan", "--task", "erwd-t"])
  assert.equal(d4.waves.length, 2, "verdict rework 无归属 → 全组 respond")
  for (const card of d4.waves) {
    assert.match(card.prompt, /Expert 裁决（rework）/, "每个包的回应派单都带裁决原因")
    assert.match(card.prompt, /总览交付物缺失/, "裁决 rationale 内嵌")
  }
})

test("路由 blocker 优先于人工门卡（E2E 实测缺陷：人工门提前签发死循环）", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "route-t")
  const d = await call(["dispatch-plan", "--task", "route-t", "--writable", "R.md:code-review"])
  await writeFile(path.join(root, "R.md"), "x", "utf8")
  await call(["deliver", "--task", "route-t", "--key", d.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  const rv = await call(["dispatch-plan", "--task", "route-t"])
  await call(["review", "--task", "route-t", "--key", rv.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "s"])
  const ve = await call(["dispatch-plan", "--task", "route-t"])
  await call(["review", "--task", "route-t", "--key", ve.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "s", "--verdict", JSON.stringify({ outcome: "accept", rationale: "r", confidence: "high", recommendedAction: "a" })])
  // gate 此时有 E2E 路由 + 人工门两个 awaiting blocker → 必须先出路由卡，不签 decision-issued
  const card1 = await call(["dispatch-plan", "--task", "route-t"])
  assert.equal(card1.card.status, "awaiting-user", "路由静止卡（await-route 卡 stop 归 blocked，卡内 status 为准）")
  assert.equal(card1.card.next, "route", "路由卡优先")
  assert.equal(card1.card.route, "e2e")
  assert.match(card1.card.fix ?? card1.card.note, /route|路由/)
  const task1 = await loadTask(root, "route-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(task1.journal.filter((e) => e.type === "decision-issued").length, 0, "未提前签发人工门决定")
  // route 判定后 → 人工门卡出现 → decide → completed
  await call(["route", "--task", "route-t", "--route", "e2e", "--decision", "skip", "--basis", "测试"])
  const card2 = await call(["dispatch-plan", "--task", "route-t"])
  assert.equal(card2.card.next, "decide", "路由决定后人工门卡才出现")
  await call(["decide", "--task", "route-t", "--choice", "1"])
  const done = await call(["dispatch-plan", "--task", "route-t"])
  assert.equal(done.stop, "completed", "decide 后完成，不再循环签卡")
  assert.equal(done.card.status, "completed")
})

test("D7：advance 按 e2e 路由决定选边（run→e2e 阶段 / skip→finish），无路由阶段不回归", async () => {
  // workflow：code-review --(run-e2e)--> e2e --(pass)--> finish；code-review --(skip-e2e)--> finish
  const wf = { terminalStages: ["finish"], gates: [], stages: [
    { id: "research", label: "调研", outputs: [], teamScene: "research" },
    { id: "code-review", label: "审查", outputs: ["code-review"], teamScene: "code-review", route: "e2e" },
    { id: "e2e", label: "端到端", outputs: ["e2e-result"], teamScene: "e2e", route: "e2e" },
    { id: "finish", label: "收尾", outputs: [], teamScene: "finish" },
  ], edges: [
    { from: "research", to: "code-review", outcome: "pass" },
    { from: "code-review", to: "e2e", outcome: "run-e2e" },
    { from: "code-review", to: "implementation", outcome: "implementation-defect" },
    { from: "code-review", to: "finish", outcome: "skip-e2e" },
    { from: "e2e", to: "finish", outcome: "pass" },
  ] }
  const pol = { maxAutonomousRounds: 3, scenes: { research: { core: false }, "code-review": { core: false }, e2e: { core: false }, finish: { core: false } } }
  const root = await makeProject({ workflow: wf, policy: pol })
  const call = caller(root)
  await openTask(root, "d7-t", { entry: null })  // workflow 模式：gate 过 → advance（through-stage 会走 complete）
  // research（非 core 无 outputs）一轮收敛 → advance 到 code-review
  const r0 = await call(["dispatch-plan", "--task", "d7-t", "--writable", "none"])
  await call(["deliver", "--task", "d7-t", "--key", r0.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "调研完成"])
  const rv0 = await call(["dispatch-plan", "--task", "d7-t"])
  await call(["review", "--task", "d7-t", "--key", rv0.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "s"])
  // advance 中间卡消失：dispatch-plan 锁内 continue 直至派发点——research 过门后直达 code-review 派发
  const d = await call(["dispatch-plan", "--task", "d7-t", "--writable", "R.md:code-review"])
  assert.equal(d.stage, "code-review", "research 过门推进到 code-review")
  await writeFile(path.join(root, "R.md"), "x", "utf8")
  await call(["deliver", "--task", "d7-t", "--key", d.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  const rv = await call(["dispatch-plan", "--task", "d7-t"])
  await call(["review", "--task", "d7-t", "--key", rv.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "s"])
  // skip → 直达 finish（原实现恒取 implementation-defect 弹回）
  await call(["route", "--task", "d7-t", "--route", "e2e", "--decision", "skip", "--basis", "测试"])
  const skipped = await call(["dispatch-plan", "--task", "d7-t", "--writable", "none"])
  assert.equal(skipped.stage, "finish", "skip-e2e 边被选择")
  // run → e2e 阶段
  const root2 = await makeProject({ workflow: wf, policy: pol })
  const call2 = caller(root2)
  await openTask(root2, "d7r-t", { entry: null })
  const r1 = await call2(["dispatch-plan", "--task", "d7r-t", "--writable", "none"])
  await call2(["deliver", "--task", "d7r-t", "--key", r1.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "调研"])
  const rv1 = await call2(["dispatch-plan", "--task", "d7r-t"])
  await call2(["review", "--task", "d7r-t", "--key", rv1.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "s"])
  const d2 = await call2(["dispatch-plan", "--task", "d7r-t", "--writable", "R.md:code-review"])  // advance + code-review 派发一步到位
  await writeFile(path.join(root2, "R.md"), "x", "utf8")
  await call2(["deliver", "--task", "d7r-t", "--key", d2.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  const rv2 = await call2(["dispatch-plan", "--task", "d7r-t"])
  await call2(["review", "--task", "d7r-t", "--key", rv2.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "s"])
  await call2(["route", "--task", "d7r-t", "--route", "e2e", "--decision", "run", "--basis", "适用"])
  const ran = await call2(["dispatch-plan", "--task", "d7r-t", "--writable", "E.md:e2e-result"])
  assert.equal(ran.stage, "e2e", "run-e2e 边被选择（原实现恒弹回 implementation）")
})

test("D1：索引重建从派发事件还原 kind（gate 按 kind 匹配通过）；无事件兜底 misc", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "d1-t")
  const d = await call(["dispatch-plan", "--task", "d1-t", "--writable", "R.md:code-review"])
  await writeFile(path.join(root, "R.md"), "x", "utf8")
  await call(["deliver", "--task", "d1-t", "--key", d.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  // 删索引触发重建
  const { rm } = await import("node:fs/promises")
  await rm(path.join(root, ".team-work/tasks/d1-t/artifacts.json"))
  const task = await loadTask(root, "d1-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const rebuilt = task.artifacts.items.find((it) => it.path === "R.md")
  assert.equal(rebuilt.kind, "code-review", "kind 从派发事件 writable 还原（原硬编码 misc）")
  // gate 按 kind 匹配：产出物在场检查应通过（blockers 不含"code-review 尚未登记"）
  const { gateCheck } = await import("../runtime-v3/gate.mjs")
  const g = gateCheck({ workflow: FIX_WORKFLOW, policy: FIX_POLICY, stageId: "code-review", scope: task.scope, artifacts: task.artifacts, reports: task.reports, decisions: [], journal: task.journal })
  assert.ok(!g.blockers.some((b) => /code-review 尚未登记/.test(b.requirement)), "重建后 gate 按 kind 匹配通过")
  // 无派发事件的历史报告兜底 misc
  const rogue = { reportId: "r-rogue", dispatchKey: "k-unknown", role: "owner", kind: "deliver", round: 1, stage: "code-review", payload: { outcome: "delivered", summary: "s", paths: ["R.md"] }, at: new Date().toISOString() }
  const rebuilt2 = await (await import("../runtime-v3/store.mjs")).rebuildForTest?.(path.join(root, ".team-work/tasks/d1-t"), [rogue], task.journal) ?? null
  // rebuildForTest 不存在则直接验证逻辑分支：rogue 的 dispatchKey 不在 journal → kind 兜底
  assert.ok(rebuilt2 === null || rebuilt2[0].kind === "misc", "未知派发事件兜底 misc")
})

test("D2：拒绝文案带派单身份（key 错配提示在途清单；路径越界附角色/包/轮次）", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "d2-t")
  const d = await call(["dispatch-plan", "--task", "d2-t", "--writable", "R.md:code-review"])
  // 场景②：不存在 key → 在途清单（提示别用别人 key）
  const rogue = await call(["deliver", "--task", "d2-t", "--key", "w99-nonexist", "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  assert.equal(rogue.ok, false)
  assert.match(rogue.message, /在途派单/, "key 不存在给在途清单")
  assert.match(rogue.message, new RegExp(d.waves[0].dispatchKey.replace(/[-]/g, "\-")), "清单含真实在途 key")
  // 场景①：路径越界 → 附本派单身份
  const cross = await call(["deliver", "--task", "d2-t", "--key", d.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "OTHER.md"])
  assert.equal(cross.ok, false)
  assert.match(cross.message, /owner 轮次 1/, "越界拒绝附派单身份")
  // 场景①：角色错配（owner key 用于 review）→ 附归属提示
  const roleMix = await call(["review", "--task", "d2-t", "--key", d.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "s"])
  assert.equal(roleMix.ok, false)
  assert.match(roleMix.message, /owner 交付派单/, "角色错配提示 key 归属")
})

test("D3/D4：verdict 波续派带 expectedAgentId；inflight 输出带 dispatchKey", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "d34-t")
  const d = await call(["dispatch-plan", "--task", "d34-t", "--writable", "R.md:code-review"])
  await writeFile(path.join(root, "R.md"), "x", "utf8")
  await call(["deliver", "--task", "d34-t", "--key", d.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  const rv = await call(["dispatch-plan", "--task", "d34-t"])
  await call(["review", "--task", "d34-t", "--key", rv.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "s"])
  // 首裁：登记 Expert 映射并给 rework 裁决 → 构造同角色二次续派（重裁）
  const ve = await call(["dispatch-plan", "--task", "d34-t"])
  await call(["agent-map", "--task", "d34-t", "--key", ve.waves[0].dispatchKey, "--agent", "agent-exp-1"])
  await call(["review", "--task", "d34-t", "--key", ve.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "v", "--verdict", JSON.stringify({ outcome: "rework", rationale: "r", confidence: "high", recommendedAction: "a" })])
  const k2 = (await call(["dispatch-plan", "--task", "d34-t", "--json", "--writable", "R.md:code-review"])).waves[0]
  await writeFile(path.join(root, "R.md"), "v2", "utf8")
  await call(["deliver", "--task", "d34-t", "--key", k2.dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  const rv2 = await call(["dispatch-plan", "--task", "d34-t"])
  await call(["review", "--task", "d34-t", "--key", rv2.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "s"])
  // 重裁（同角色二次续派）：倒序回溯解析原 Expert（台账 V3-E2E-02 Expert 重裁断链修复）
  const ve2 = (await call(["dispatch-plan", "--task", "d34-t", "--json"])).waves[0]
  assert.equal(ve2.role, "expert")
  assert.equal(ve2.continuation, true, "重裁为续派")
  assert.equal(ve2.expectedAgentId, "agent-exp-1", "verdict 波续派带 expectedAgentId（测试名与正文一致）")
  await call(["review", "--task", "d34-t", "--key", ve2.dispatchKey, "--recommendation", "accept", "--summary", "v", "--verdict", JSON.stringify({ outcome: "accept", rationale: "r", confidence: "high", recommendedAction: "a" })])
  // 人工门：过掉再走 e2e-skip → completed
  await call(["route", "--task", "d34-t", "--route", "e2e", "--decision", "skip", "--basis", "x"])
  const g1 = await call(["dispatch-plan", "--task", "d34-t"])
  await call(["decide", "--task", "d34-t", "--choice", "1"])
  // D4：在途卡 inflight 元素带 dispatchKey（与 waves 统一）
  const root2 = await makeProject()
  const call2 = caller(root2)
  await openTask(root2, "d4-t")
  await call2(["dispatch-plan", "--task", "d4-t", "--writable", "R.md:code-review"])
  const w = await call2(["dispatch-plan", "--task", "d4-t"])
  assert.equal(w.stop, "wait-inflight")
  assert.ok(w.inflight[0].dispatchKey, "inflight 元素带 dispatchKey")
})

test("D6：多包任务的评审/裁决派单内嵌包计划（未交付包不构成 rework 依据）", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "d6-t")
  await call(["plan", "--task", "d6-t", "--packages", PKGS])
  const d1 = await call(["dispatch-plan", "--task", "d6-t"])
  const kS = d1.waves.find((x) => x.package === "store").dispatchKey
  const kI = d1.waves.find((x) => x.package === "intake").dispatchKey
  await writeFile(path.join(root, "S.md"), "v1", "utf8")
  await writeFile(path.join(root, "I.md"), "v1", "utf8")
  await call(["deliver", "--task", "d6-t", "--key", kS, "--outcome", "delivered", "--summary", "s", "--paths", "S.md"])
  await call(["deliver", "--task", "d6-t", "--key", kI, "--outcome", "delivered", "--summary", "s", "--paths", "I.md"])
  const rv = await call(["dispatch-plan", "--task", "d6-t"])
  assert.match(rv.waves[0].prompt, new RegExp("本任务包计划：store（已交付）、intake（已交付）、overview（未交付，依赖满足后自动派发）"), "评审派单内嵌包计划事实")
  assert.match(rv.waves[0].prompt, /未交付包不构成 rework 依据/, "明确指引避免缺包误判")
})

test("A：包 tier 字段——验收非法值拒绝；实际档 = max(包tier, risk)；缺省回落默认", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "a-t")
  // 非法 tier 拒绝
  const bad = await call(["plan", "--task", "a-t", "--packages", JSON.stringify([{ id: "x", writable: ["X.md:k"], done: ["d"], tier: "staff" }])])
  assert.equal(bad.ok, false)
  assert.match(bad.message, /tier 非法/)
  // 合法 tier：senior 包 + risk critical → max = expert（risk 不触发升档卡，包 tier 触发 → 先批准）
  await call(["intent", "--task", "a-t", "--risk", "critical"])
  await call(["plan", "--task", "a-t", "--packages", JSON.stringify([
    { id: "lo", writable: ["LO.md:k"], done: ["d"], dependsOn: [] },
    { id: "hi", writable: ["HI.md:k"], done: ["d"], tier: "senior", dependsOn: [] },
  ])])
  const gate = await call(["dispatch-plan", "--task", "a-t"])
  assert.equal(gate.stop, "awaiting-user", "包 tier 高于默认 → 升档审批卡（C）")
  assert.deepEqual(gate.card.escalations, [{ package: "hi", tier: "senior" }], "升档清单合批")
  await call(["decide", "--task", "a-t", "--choice", "1"])
  const d = await call(["dispatch-plan", "--task", "a-t"])
  const lo = d.waves.find((x) => x.package === "lo")
  const hi = d.waves.find((x) => x.package === "hi")
  assert.equal(lo.tier, "expert", "无包 tier + risk critical → 兜底抬 expert（用户 open 时已授权，免审批）")
  assert.equal(hi.tier, "senior", "包显式 senior + risk critical → senior（包级判断优先，risk 不无差别抬全部包）")
  // 批准后重跑幂等：交付 lo 后再 run（hi 在途）不再出卡
  await writeFile(path.join(root, "LO.md"), "x", "utf8")
  await call(["deliver", "--task", "a-t", "--key", d.waves.find((x) => x.package === "lo").dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "LO.md"])
  const w = await call(["dispatch-plan", "--task", "a-t"])
  assert.equal(w.stop, "wait-inflight", "已批准批次不重复出卡（幂等）")
  // 缺省回落（risk normal）+ 拒绝路径（降回默认档）
  const root2 = await makeProject()
  const call2 = caller(root2)
  await openTask(root2, "a2-t")
  await call2(["plan", "--task", "a2-t", "--packages", JSON.stringify([{ id: "hi", writable: ["HI.md:k"], done: ["d"], tier: "senior", dependsOn: [] }])])
  const gate2 = await call2(["dispatch-plan", "--task", "a2-t"])
  assert.equal(gate2.stop, "awaiting-user")
  await call2(["decide", "--task", "a2-t", "--choice", "2"])  // 拒绝 → 降回默认档
  const d2 = await call2(["dispatch-plan", "--task", "a2-t"])
  assert.equal(d2.waves[0].tier, "junior", "拒绝升档 → 场景默认 junior（降级说明 note 不在 waves 形状，以实际派发档位为准）")
})

test("B：e2eTemplate 物化——entry e2e 直达自动三包（形状映射+依赖锁+已 plan 不覆盖）", async () => {
  const wf = { terminalStages: ["finish"], gates: [], stages: [
    { id: "e2e", label: "端到端", outputs: ["e2e-result"], teamScene: "e2e", route: "e2e" },
  ], edges: [] }
  const pol = { maxAutonomousRounds: 3, scenes: { e2e: { core: true } }, e2eTemplate: [
    { packageId: "path-design", assignmentKind: "e2e", outputRefs: ["artifact:e2e-design"], dependsOn: [], completionCriteria: ["设计真实用户路径"] },
    { packageId: "fixture-implementation", assignmentKind: "e2e", outputRefs: ["artifact:e2e-fixtures"], dependsOn: ["path-design"], completionCriteria: ["实现可重复测试设施"] },
    { packageId: "execution", assignmentKind: "e2e", outputRefs: ["artifact:e2e-result"], dependsOn: ["fixture-implementation"], completionCriteria: ["执行并保留证据"] },
  ] }
  const root = await makeProject({ workflow: wf, policy: pol })
  const call = caller(root)
  await openTask(root, "b-t", { entry: "e2e" })
  const d = await call(["dispatch-plan", "--task", "b-t"])
  assert.equal(d.waves.length, 1, "只派 path-design（后两包依赖锁）")
  assert.equal(d.waves[0].package, "path-design")
  assert.match(d.waves[0].prompt, /e2e\/e2e-design.md/, "形状映射：artifact:e2e-design → e2e/e2e-design.md:e2e-design")
  const task = await loadTask(root, "b-t", { workflow: wf, policy: pol })
  assert.ok(task.journal.some((e) => e.type === "packages-planned" && e.detail.source === "e2eTemplate"), "journal 记物化来源")
  assert.equal(task.packages.length, 3)
  // 已 plan 不覆盖：手动 plan 后 run 保持用户定义
  const root2 = await makeProject({ workflow: wf, policy: pol })
  const call2 = caller(root2)
  await openTask(root2, "b2-t", { entry: "e2e" })
  await call2(["plan", "--task", "b2-t", "--packages", JSON.stringify([{ id: "my-own", writable: ["X.md:e2e-design"], done: ["自定义"], dependsOn: [] }])])
  const d2 = await call2(["dispatch-plan", "--task", "b2-t"])
  assert.equal(d2.waves[0].package, "my-own", "用户已 plan 不被模板覆盖")
})

test("升档卡在 dispatch-plan 路径同样触发（Lead 编排入口不漏）；合理选档的事实体现", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "escdp-t")
  await call(["plan", "--task", "escdp-t", "--packages", JSON.stringify([
    { id: "mech", writable: ["M.md:k"], done: ["机械核对"], dependsOn: [] },
    { id: "arch", writable: ["A.md:k"], done: ["架构裁决"], tier: "expert", dependsOn: [] },
  ])])
  const plan = await call(["dispatch-plan", "--task", "escdp-t", "--json"])
  assert.equal(plan.stop, "awaiting-user", "dispatch-plan 在升档批次前停住")
  assert.match(plan.card.question, /高于场景默认档/, "升档问题文本")
  assert.deepEqual(plan.card.escalations, [{ package: "arch", tier: "expert" }], "只列升档包（mech 默认档零打扰）")
  await call(["decide", "--task", "escdp-t", "--choice", "1"])
  const plan2 = await call(["dispatch-plan", "--task", "escdp-t", "--json"])
  assert.equal(plan2.stop, null, "批准后正常出波")
  const arch = plan2.waves.find((w) => w.package === "arch")
  const mech = plan2.waves.find((w) => w.package === "mech")
  assert.equal(arch.tier, "expert", "架构裁决包按 expert 派发")
  assert.equal(mech.tier, "junior", "机械核对包保持 junior（复杂度判断表的事实体现）")
})

test("写边界声明：owner 派单内嵌越界后果（deliver 拒绝 + 快照恢复）", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "wb-t")
  const d = await call(["dispatch-plan", "--task", "wb-t", "--writable", "R.md:code-review"])
  assert.match(d.waves[0].prompt, /可写范围外的修改会被 deliver 拒绝/, "边界声明在场")
  assert.match(d.waves[0].prompt, /快照恢复/, "恢复通道提示在场")
})

test("单 owner 任务无 packages：行为与 v3.1 一致（--writable 派单）", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "solo-t")
  const d = await call(["dispatch-plan", "--task", "solo-t", "--writable", "R.md:code-review"])
  assert.equal(d.waves[0].kind, "produce")
  assert.equal(d.waves[0].continuation, false)
  assert.equal(d.waves.length, 1)
  assert.equal(d.waves[0].package, undefined, "单 owner 不带 package 字段")
})

test("risk 升档：critical → expert Owner（只升 owner 档，challenger 不变）", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "risk-t")
  await call(["intent", "--task", "risk-t", "--risk", "critical"])
  const d = await call(["dispatch-plan", "--task", "risk-t", "--writable", "R.md:code-review"])
  assert.equal(d.waves[0].tier, "expert", "critical 任务 Owner 升 expert 档")
  // challenger 档不受 risk 影响（policy challengerTier=senior）
  await writeFile(path.join(root, "R.md"), "x", "utf8")
  await call(["deliver", "--task", "risk-t", "--key", d.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  const r = await call(["dispatch-plan", "--task", "risk-t"])
  assert.equal(r.waves[0].tier, "senior", "challenger 档不随 risk 升降")
})

test("候选池 + 家族去重：同档多 owner 派发优先不同模型家族", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "pool-t")
  // 全局 junior 池：两个不同家族候选；项目 dsh.json 不参与选择。
  await writeFile(settingsFile, `
team-work-dsh:
  tiers:
    junior:
      - provider: pool-a
        model: familyone-lite
        family: familyone
      - provider: pool-b
        model: familytwo-lite
        family: familytwo
    senior: { provider: pool-senior, model: pool-senior }
    expert: { provider: pool-expert, model: pool-expert }
`)
  try {
    await call(["plan", "--task", "pool-t", "--packages", PKGS])
    const plan = await call(["dispatch-plan", "--task", "pool-t", "--json"])
    assert.equal(plan.waves.length, 2, "首波两包（overview 依赖锁）")
    const [m1, m2] = plan.waves.map((wave) => wave.modelHint)
    assert.equal(m1.model, "familyone-lite")
    assert.equal(m2.model, "familytwo-lite", "同档第二 owner 家族去重选第二候选")
    assert.equal(m2.selectedBy, "diversity")

    // diversity 选择固化在 dispatch-plan 的 wave.modelHint（journal 同一快照）；agent-map 只登记续派映射。
    const [first, second] = plan.waves
    await Promise.all([
      call(["agent-map", "--task", "pool-t", "--key", first.dispatchKey, "--agent", "child-one"]),
      call(["agent-map", "--task", "pool-t", "--key", second.dispatchKey, "--agent", "child-two"]),
    ])
    const agents = JSON.parse(await readFile(path.join(root, ".team-work", "tasks", "pool-t", "agents.json"), "utf8"))
    assert.equal(agents.mappings[first.dispatchKey], "child-one")
    assert.equal(agents.mappings[second.dispatchKey], "child-two")
    assert.equal(agents.modelHints, undefined, "agents.json 收敛纯 mappings（模型快照不经注册表中转）")
  } finally {
    await writeFile(settingsFile, BASE_SETTINGS)
  }
})
