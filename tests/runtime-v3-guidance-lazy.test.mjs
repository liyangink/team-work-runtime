// 引导库惰性加载量化测试（P3-5）：loadGuidance 只在"真正派发"与"在途补发重建"分支内调用——
// 任务不存在（归档卡）、终态幂等完成卡、awaiting-user 静止、advance 转移、blocked 卡等非派发路径零引导 I/O。
//
// 量化方法：项目覆盖层放置"损坏"文件（同名目录，readFile 抛 EISDIR），每次 loadGuidance
// 恰好产生 1 条 stderr 警告（P3-6 的可观测信号，mock console.warn 计数），故
// stderr 警告数 = loadGuidance 调用数；而每次 loadGuidance = 4 次 readdir（包内 roles/scenes +
// 项目根 roles/scenes；项目根 guidance 目录缺失则 readdir 抛 ENOENT，被静默跳过）+ 全部引导
// 文件读取（包内基线 5 件 + 覆盖层件数），因此警告数即引导 I/O 次数的量化代理。
// 优化前（无条件提前加载）：上述每条路径都付 1 次调用；优化后（惰性）仅派发/补发付 1 次。
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import test, { mock } from "node:test"

import { caller, makeProject, openTask } from "./support/v3-fixtures.mjs"

// 完整 workflow 模式（入口 research，无 core 场景）：research → implementation → finish
const FLOW_WORKFLOW = {
  terminalStages: ["finish"],
  gates: [],
  stages: [
    { id: "research", label: "调研", outputs: [], teamScene: "research" },
    { id: "implementation", label: "实施", outputs: ["source"], teamScene: "implementation" },
    { id: "finish", label: "收尾", outputs: [], teamScene: "finish" },
  ],
  edges: [
    { from: "research", to: "implementation", outcome: "pass" },
    { from: "implementation", to: "finish", outcome: "pass" },
  ],
}
const FLOW_POLICY = {
  maxAutonomousRounds: 3,
  costWeights: { junior: 1, senior: 10, expert: 50 },
  riskTiers: { critical: "expert", high: "senior" },
  scenes: { research: {}, implementation: {}, finish: {} },
}

// 通过中间阶段介入的工作流（through-stage 任务，升档审批与热变测试用）
const IMPL_WORKFLOW = {
  terminalStages: ["finish"],
  gates: [],
  stages: [
    { id: "implementation", label: "实施", outputs: ["source"], teamScene: "implementation" },
    { id: "test", label: "测试", outputs: ["test-code"], teamScene: "test" },
    { id: "finish", label: "收尾", outputs: [], teamScene: "finish" },
  ],
  edges: [
    { from: "implementation", to: "test", outcome: "pass" },
    { from: "test", to: "finish", outcome: "pass" },
  ],
}
const IMPL_POLICY = {
  maxAutonomousRounds: 3,
  costWeights: { junior: 1, senior: 10, expert: 50 },
  riskTiers: { critical: "expert", high: "senior" },
  scenes: { implementation: {}, test: {}, finish: {} },
}

// 损坏覆盖文件夹具：scenes/implementation.md 建成同名目录 → readFile 抛 EISDIR，
// loadGuidance 每次调用恰好打 1 条 stderr 警告（P3-6），作为引导 I/O 的可计数信号。
async function corruptCoverage(projectRoot) {
  await mkdir(path.join(projectRoot, "team-work/guidance/scenes/implementation.md"), { recursive: true })
}

test("run 路径惰性化：非派发路径零引导 I/O，派发与在途重建恰好一次", async () => {
  const projectRoot = await makeProject({ workflow: FLOW_WORKFLOW, policy: FLOW_POLICY })
  await corruptCoverage(projectRoot)
  const call = caller(projectRoot)
  // workflow 模式：不传 entry（入口 research），跑完整 research → implementation → finish
  await openTask(projectRoot, "lazy-t", { objective: "实现模块 X", entry: null })

  const warns = []
  mock.method(console, "warn", (...args) => warns.push(args.join(" ")))
  const io = () => warns.length

  // ① 任务不存在：存在性检查前置路径，零引导 I/O
  const ghost = await call(["run", "--task", "ghost-t"])
  assert.equal(ghost.ok, false)
  assert.equal(io(), 0, "任务不存在路径零引导 I/O")

  // ② 真正派发（owner，--writable none 无产物派单）：恰好 1 次
  const d = await call(["dispatch-plan", "--task", "lazy-t", "--writable", "none"])
  assert.equal(d.stop, null)
  assert.equal(d.waves.length, 1)
  assert.equal(io(), 1, "派发路径恰好 1 次引导 I/O")
  assert.match(d.waves[0].prompt, /先调研和理解/, "派发注入角色引导")

  // ③ 在途补发重建（已派发未交付再 dispatch-plan → wait-inflight stop 卡内嵌重建文本）：恰好 1 次
  const inflight = await call(["dispatch-plan", "--task", "lazy-t"])
  assert.equal(inflight.stop, "wait-inflight")
  assert.equal(io(), 2, "在途重建路径恰好 1 次引导 I/O")
  assert.match(inflight.inflight[0].prompt, /先调研和理解/, "在途重建文本注入引导")

  // ④ 交付后 challenger 派发：恰好 1 次
  await call(["deliver", "--task", "lazy-t", "--key", d.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "完成"])
  const c = await call(["dispatch-plan", "--task", "lazy-t"])
  assert.equal(c.waves[0].role, "challenger")
  assert.equal(io(), 3, "评审派发路径恰好 1 次引导 I/O")

  // ⑤ 评审 accept 后 advance 转移（research → implementation）：run 只读化后 advance 中间卡消失，
  // dispatch-plan 锁内 continue 直达下一阶段派发点（转移本身零引导 I/O，落点派发付 1 次）
  await call(["review", "--task", "lazy-t", "--key", c.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "通过"])
  const adv = await call(["dispatch-plan", "--task", "lazy-t", "--writable", "src.mjs:source"])
  assert.equal(adv.stop, null)
  assert.equal(adv.stage, "implementation")
  assert.equal(adv.waves[0].role, "owner")
  assert.equal(io(), 4, "advance 转移零引导 I/O，落点派发恰好 1 次")

  // ⑥ implementation 阶段交付后 challenger 派发：恰好 1 次
  await writeFile(path.join(projectRoot, "src.mjs"), "export const x = 1", "utf8")
  await call(["deliver", "--task", "lazy-t", "--key", adv.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "完成", "--paths", "src.mjs"])
  const c2 = await call(["dispatch-plan", "--task", "lazy-t"])
  assert.equal(c2.waves[0].role, "challenger")
  assert.equal(io(), 5, "implementation 阶段评审派发恰好 1 次引导 I/O")
  await call(["review", "--task", "lazy-t", "--key", c2.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "通过"])
  const adv2 = await call(["dispatch-plan", "--task", "lazy-t", "--writable", "none"])
  assert.equal(adv2.stop, null)
  assert.equal(adv2.stage, "finish")
  assert.equal(adv2.waves[0].role, "owner")
  assert.equal(io(), 6, "finish 阶段落点派发恰好 1 次引导 I/O")

  // ⑦b finish 阶段收尾链：deliver → challenger 派发 → accept → 终态
  await call(["deliver", "--task", "lazy-t", "--key", adv2.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "收尾"])
  const c3 = await call(["dispatch-plan", "--task", "lazy-t"])
  assert.equal(c3.waves[0].role, "challenger")
  assert.equal(io(), 7, "finish 阶段评审派发恰好 1 次引导 I/O")
  await call(["review", "--task", "lazy-t", "--key", c3.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "通过"])
  const done = await call(["dispatch-plan", "--task", "lazy-t"])
  assert.equal(done.stop, "completed")
  assert.equal(done.card.status, "completed")
  assert.equal(io(), 7, "终态完成卡零引导 I/O")

  // ⑧ 幂等完成卡（run 只读幂等返回同一完成卡）：零引导 I/O
  const again = await call(["run", "--task", "lazy-t"])
  assert.equal(again.status, "completed")
  assert.equal(again.next, "archive")
  assert.equal(io(), 7, "幂等完成卡零引导 I/O")
})

test("dispatch-plan 路径惰性化：推进到派发点恰好一次引导 I/O，stop 路径零", async () => {
  const projectRoot = await makeProject({ workflow: IMPL_WORKFLOW, policy: IMPL_POLICY })
  await corruptCoverage(projectRoot)
  const call = caller(projectRoot)

  const warns = []
  mock.method(console, "warn", (...args) => warns.push(args.join(" ")))
  const io = () => warns.length

  // ① 任务不存在：零引导 I/O
  const ghost = await call(["dispatch-plan", "--task", "ghost-t"])
  assert.equal(ghost.ok, false)
  assert.equal(io(), 0, "任务不存在路径零引导 I/O")

  // ② 派发：恰好 1 次
  await openTask(projectRoot, "plan-t", { objective: "实现模块 X", entry: "implementation" })
  const plan = await call(["dispatch-plan", "--task", "plan-t", "--writable", "src.mjs:source"])
  assert.equal(plan.stop, null)
  assert.equal(plan.waves.length, 1)
  assert.equal(io(), 1, "dispatch-plan 派发路径恰好 1 次引导 I/O")
  assert.match(plan.waves[0].prompt, /先调研和理解/, "dispatch-plan 派单注入引导")

  // ③ 已派发未交付再 dispatch-plan：wait-inflight stop，在途重建恰好 1 次
  const inflight = await call(["dispatch-plan", "--task", "plan-t"])
  assert.equal(inflight.stop, "wait-inflight")
  assert.equal(io(), 2, "dispatch-plan 在途重建恰好 1 次引导 I/O")
  assert.match(inflight.inflight[0].prompt, /先调研和理解/, "dispatch-plan 在途重建注入引导")
})

test("awaiting-user 静止路径（升档审批卡）零引导 I/O，批准后派发恰好一次", async () => {
  const projectRoot = await makeProject({ workflow: IMPL_WORKFLOW, policy: IMPL_POLICY })
  await corruptCoverage(projectRoot)
  const call = caller(projectRoot)
  await openTask(projectRoot, "esc-t", { objective: "实现模块 X", entry: "implementation" })

  const warns = []
  mock.method(console, "warn", (...args) => warns.push(args.join(" ")))
  const io = () => warns.length

  // 包 tier（expert）高于场景默认档（junior）→ dispatch-plan 出升档审批卡（awaiting-user 静止 stop，不派发；
  // 决定卡首签发生在 dispatch-plan 推进时，run 只读不签发）
  const p = await call(["plan", "--task", "esc-t", "--packages", JSON.stringify([{ id: "core", writable: ["a.mjs:source"], done: ["完成 core"], tier: "expert" }])])
  assert.equal(p.ok, true)
  const r = await call(["dispatch-plan", "--task", "esc-t"])
  assert.equal(r.stop, "awaiting-user")
  assert.equal(r.waves.length, 0)
  assert.ok(r.card.decisionId, "决定卡在 card 下（首签归 dispatch 通道）")
  assert.equal(r.card.next, "decide")
  assert.equal(io(), 0, "升档审批静止卡零引导 I/O")

  // 批准升档后真正派发：恰好 1 次
  await call(["decide", "--task", "esc-t", "--choice", "1"])
  const d = await call(["dispatch-plan", "--task", "esc-t"])
  assert.equal(d.stop, null)
  assert.equal(d.waves.length, 1)
  assert.equal(io(), 1, "审批后派发恰好 1 次引导 I/O")
  assert.match(d.waves[0].prompt, /先调研和理解/, "审批后派发注入引导")
})

test("blocked 卡路径（门失败且非人工阻塞）零引导 I/O", async () => {
  const projectRoot = await makeProject({ workflow: FLOW_WORKFLOW, policy: FLOW_POLICY })
  await corruptCoverage(projectRoot)
  const call = caller(projectRoot)
  // workflow 模式（entry null）：无 through-stage 人工门，gate 失败即 blocked（而非 awaiting-user）
  await openTask(projectRoot, "blk-t", { objective: "实现模块 X", entry: null })

  const warns = []
  mock.method(console, "warn", (...args) => warns.push(args.join(" ")))
  const io = () => warns.length

  // ① research 阶段完整收敛（派发 ×2），advance 直达 implementation 派发点：
  // advance 转移零 I/O，落点派发付 1 次
  const r1 = await call(["dispatch-plan", "--task", "blk-t", "--writable", "none"])
  assert.equal(r1.stop, null)
  assert.equal(io(), 1, "research 派发恰好 1 次引导 I/O")
  await call(["deliver", "--task", "blk-t", "--key", r1.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "完成"])
  const rc = await call(["dispatch-plan", "--task", "blk-t"])
  assert.equal(rc.waves[0].role, "challenger")
  assert.equal(io(), 2, "research 评审派发恰好 1 次引导 I/O")
  await call(["review", "--task", "blk-t", "--key", rc.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "通过"])
  const adv = await call(["dispatch-plan", "--task", "blk-t", "--writable", "src.mjs:source"])
  assert.equal(adv.stop, null)
  assert.equal(adv.stage, "implementation")
  assert.equal(adv.waves[0].role, "owner")
  assert.equal(io(), 3, "advance 转移零引导 I/O，落点派发恰好 1 次")

  // ② implementation 阶段交付：deliver 携带 fail 检查（intake 接受，门禁判 blocker）
  await writeFile(path.join(projectRoot, "src.mjs"), "export const x = 1", "utf8")
  await call(["deliver", "--task", "blk-t", "--key", adv.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "完成", "--paths", "src.mjs", "--checks", '[{"name":"lint","result":"fail"}]'])
  const c = await call(["dispatch-plan", "--task", "blk-t"])
  assert.equal(c.waves[0].role, "challenger")
  assert.equal(io(), 4, "implementation 评审派发恰好 1 次引导 I/O")
  await call(["review", "--task", "blk-t", "--key", c.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "通过"])

  // ③ 门失败（检查未通过，无 awaitingUser blocker）→ blocked 卡：零引导 I/O
  const b = await call(["run", "--task", "blk-t"])
  assert.equal(b.status, "blocked")
  assert.equal(b.next, "none")
  assert.equal(b.transition, "blocked")
  assert.match(b.blockers.map((x) => x.requirement).join(), /lint/, "blocker 指明失败检查")
  assert.equal(io(), 4, "blocked 卡路径零引导 I/O")
})

test("热变语义：修改覆盖层引导文件后下一次派发生效（无模块级缓存）", async () => {
  const projectRoot = await makeProject({ workflow: IMPL_WORKFLOW, policy: IMPL_POLICY })
  await mkdir(path.join(projectRoot, "team-work/guidance/scenes"), { recursive: true })
  await writeFile(path.join(projectRoot, "team-work/guidance/scenes/implementation.md"), "- 第一版覆盖纪律。", "utf8")
  const call = caller(projectRoot)
  await openTask(projectRoot, "hot-t", { objective: "实现模块 X", entry: "implementation" })

  const d = await call(["dispatch-plan", "--task", "hot-t", "--writable", "src.mjs:source"])
  assert.match(d.waves[0].prompt, /第一版覆盖纪律/, "首次派发注入当前覆盖内容")
  assert.doesNotMatch(d.waves[0].prompt, /第二版覆盖纪律/, "新内容尚未写入")

  // 交付后修改覆盖文件，respond 续派（同一任务第二次派发）应读到新内容
  await writeFile(path.join(projectRoot, "src.mjs"), "export const x = 1", "utf8")
  await call(["deliver", "--task", "hot-t", "--key", d.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "完成", "--paths", "src.mjs"])
  const c = await call(["dispatch-plan", "--task", "hot-t"])
  await call(["review", "--task", "hot-t", "--key", c.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "返工"])
  await writeFile(path.join(projectRoot, "team-work/guidance/scenes/implementation.md"), "- 第二版覆盖纪律。", "utf8")
  const rw = await call(["dispatch-plan", "--task", "hot-t", "--writable", "src.mjs:source"])
  assert.equal(rw.waves[0].kind, "respond")
  assert.match(rw.waves[0].prompt, /第二版覆盖纪律/, "修改引导文件后下次派发生效（热变）")
  assert.doesNotMatch(rw.waves[0].prompt, /第一版覆盖纪律/, "旧内容不残留（无模块级缓存）")
})
