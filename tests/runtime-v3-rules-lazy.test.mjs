// 规则库惰性读取量化测试（P3-5 的接线版）：成员规则只在"真正派发"与"在途重建"分支内解析，
// Lead 规则只在呈现时点按 kind 读取——非派发、非呈现路径零规则 I/O。
//
// 量化方法：项目规则层放"损坏"条目（同名目录，readFile 抛 EISDIR），resolveMemberRules /
// resolveLeadRules 读到它时恰好打 1 条 stderr 警告（rules.mjs 的 readRuleFile 项目层诊断）。
// 两个通道用不同目标文件分别计数，互不干扰：
//   成员通道：team-work/rules/common/index.md 损坏 → 警告数 = 成员规则解析次数；
//   Lead 通道：team-work/rules/lead/<kind>/index.md 损坏 → 警告数 = 该时点 Lead 规则读取次数。
// 优化前（无条件提前加载）每条路径都付 1 次调用；优化后只在派发/重建/呈现时点付 1 次。
import assert from "node:assert/strict"
import { mkdir, writeFile, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test, { mock } from "node:test"

import { caller, makeProject, openTask } from "./support/v3-fixtures.mjs"

// 用户公共规则隔离：HOME 指向临时目录，派单只读空的 ~/.team-work/rules，不读开发机真实用户规则。
process.env.HOME = await mkdtemp(path.join(tmpdir(), "tw-lazy-home-"))

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
const IMPL_POLICY = FLOW_POLICY

async function writeRule(projectRoot, relative, text) {
  const file = path.join(projectRoot, "team-work", "rules", ...relative.split("/"))
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, text, "utf8")
}

// 成员通道信号：common/index.md 建成同名目录 → 每次成员规则解析恰好 1 条项目层警告
async function corruptMemberRule(projectRoot) {
  await mkdir(path.join(projectRoot, "team-work/rules/common/index.md"), { recursive: true })
}

// Lead 通道信号：lead/<kind>/index.md 建成同名目录 → 每次该时点的 Lead 规则读取恰好 1 条警告
async function corruptLeadRule(projectRoot, kind) {
  await mkdir(path.join(projectRoot, "team-work/rules/lead", kind, "index.md"), { recursive: true })
}

test("run 路径惰性化：非派发路径零成员规则 I/O，派发与在途重建恰好一次", async () => {
  const projectRoot = await makeProject({ workflow: FLOW_WORKFLOW, policy: FLOW_POLICY })
  await corruptMemberRule(projectRoot)
  const call = caller(projectRoot)
  // workflow 模式：不传 entry（入口 research），跑完整 research → implementation → finish
  await openTask(projectRoot, "lazy-t", { objective: "实现模块 X", entry: null })

  const warns = []
  mock.method(console, "warn", (...args) => warns.push(args.join(" ")))
  const io = () => warns.length

  // ① 任务不存在：存在性检查前置路径，零成员规则 I/O
  const ghost = await call(["run", "--task", "ghost-t"])
  assert.equal(ghost.ok, false)
  assert.equal(io(), 0, "任务不存在路径零成员规则 I/O")

  // ② 真正派发（owner）：恰好 1 次；规则正文照常随卡到达（基线层完整）
  const d = await call(["dispatch-plan", "--task", "lazy-t", "--writable", "none"])
  assert.equal(d.stop, null)
  assert.equal(d.waves.length, 1)
  assert.equal(io(), 1, "派发路径恰好 1 次成员规则 I/O")
  assert.match(d.waves[0].prompt, /不盲目接受派单提供的信息/, "成员规则（包内基线）注入派单")

  // ③ 在途补发重建（已派发未交付再 dispatch-plan → wait-inflight stop 卡内嵌重建文本）：恰好 1 次
  const inflight = await call(["dispatch-plan", "--task", "lazy-t"])
  assert.equal(inflight.stop, "wait-inflight")
  assert.equal(io(), 2, "在途重建路径恰好 1 次成员规则 I/O")
  assert.match(inflight.inflight[0].prompt, /不盲目接受派单提供的信息/, "在途重建文本注入规则")

  // ④ 交付后 challenger 派发：恰好 1 次
  await call(["deliver", "--task", "lazy-t", "--key", d.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "完成"])
  const c = await call(["dispatch-plan", "--task", "lazy-t"])
  assert.equal(c.waves[0].role, "challenger")
  assert.equal(io(), 3, "评审派发路径恰好 1 次成员规则 I/O")

  // ⑤ 评审 accept 后 advance 转移（research → implementation）：转移本身零成员规则 I/O，落点派发付 1 次
  await call(["review", "--task", "lazy-t", "--key", c.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "通过"])
  const adv = await call(["dispatch-plan", "--task", "lazy-t", "--writable", "src.mjs:source"])
  assert.equal(adv.stop, null)
  assert.equal(adv.stage, "implementation")
  assert.equal(adv.waves[0].role, "owner")
  assert.equal(io(), 4, "advance 转移零成员规则 I/O，落点派发恰好 1 次")

  // ⑥ implementation 阶段交付后 challenger 派发：恰好 1 次
  await writeFile(path.join(projectRoot, "src.mjs"), "export const x = 1", "utf8")
  await call(["deliver", "--task", "lazy-t", "--key", adv.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "完成", "--paths", "src.mjs"])
  const c2 = await call(["dispatch-plan", "--task", "lazy-t"])
  assert.equal(c2.waves[0].role, "challenger")
  assert.equal(io(), 5, "implementation 阶段评审派发恰好 1 次成员规则 I/O")
  await call(["review", "--task", "lazy-t", "--key", c2.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "通过"])
  const adv2 = await call(["dispatch-plan", "--task", "lazy-t", "--writable", "none"])
  assert.equal(adv2.stop, null)
  assert.equal(adv2.stage, "finish")
  assert.equal(adv2.waves[0].role, "owner")
  assert.equal(io(), 6, "finish 阶段落点派发恰好 1 次成员规则 I/O")

  // ⑦ finish 阶段收尾链：deliver → challenger 派发 → accept → 终态
  await call(["deliver", "--task", "lazy-t", "--key", adv2.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "收尾"])
  const c3 = await call(["dispatch-plan", "--task", "lazy-t"])
  assert.equal(c3.waves[0].role, "challenger")
  assert.equal(io(), 7, "finish 阶段评审派发恰好 1 次成员规则 I/O")
  await call(["review", "--task", "lazy-t", "--key", c3.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "通过"])
  const done = await call(["dispatch-plan", "--task", "lazy-t"])
  assert.equal(done.stop, "completed")
  assert.equal(done.card.status, "completed")
  assert.equal(io(), 7, "终态完成卡零成员规则 I/O")

  // ⑧ 幂等完成卡（run 只读幂等返回同一完成卡）：零成员规则 I/O
  const again = await call(["run", "--task", "lazy-t"])
  assert.equal(again.status, "completed")
  assert.equal(again.next, "archive")
  assert.equal(io(), 7, "幂等完成卡零成员规则 I/O")
})

test("dispatch-plan 路径惰性化：推进到派发点恰好一次成员规则 I/O，stop 路径零", async () => {
  const projectRoot = await makeProject({ workflow: IMPL_WORKFLOW, policy: IMPL_POLICY })
  await corruptMemberRule(projectRoot)
  const call = caller(projectRoot)

  const warns = []
  mock.method(console, "warn", (...args) => warns.push(args.join(" ")))
  const io = () => warns.length

  // ① 任务不存在：零成员规则 I/O
  const ghost = await call(["dispatch-plan", "--task", "ghost-t"])
  assert.equal(ghost.ok, false)
  assert.equal(io(), 0, "任务不存在路径零成员规则 I/O")

  // ② 派发：恰好 1 次
  await openTask(projectRoot, "plan-t", { objective: "实现模块 X", entry: "implementation" })
  const plan = await call(["dispatch-plan", "--task", "plan-t", "--writable", "src.mjs:source"])
  assert.equal(plan.stop, null)
  assert.equal(plan.waves.length, 1)
  assert.equal(io(), 1, "dispatch-plan 派发路径恰好 1 次成员规则 I/O")
  assert.match(plan.waves[0].prompt, /不盲目接受派单提供的信息/, "dispatch-plan 派单注入规则")

  // ③ 已派发未交付再 dispatch-plan：wait-inflight stop，在途重建恰好 1 次
  const inflight = await call(["dispatch-plan", "--task", "plan-t"])
  assert.equal(inflight.stop, "wait-inflight")
  assert.equal(io(), 2, "dispatch-plan 在途重建恰好 1 次成员规则 I/O")
  assert.match(inflight.inflight[0].prompt, /不盲目接受派单提供的信息/, "dispatch-plan 在途重建注入规则")
})

test("awaiting-user 静止路径（升档审批卡）零成员规则 I/O，批准后派发恰好一次", async () => {
  const projectRoot = await makeProject({ workflow: IMPL_WORKFLOW, policy: IMPL_POLICY })
  await corruptMemberRule(projectRoot)
  const call = caller(projectRoot)
  await openTask(projectRoot, "esc-t", { objective: "实现模块 X", entry: "implementation" })

  const warns = []
  mock.method(console, "warn", (...args) => warns.push(args.join(" ")))
  const io = () => warns.length

  // 包 tier（expert）高于场景默认档（junior）→ dispatch-plan 出升档审批卡（awaiting-user 静止 stop，不派发）
  const p = await call(["plan", "--task", "esc-t", "--packages", JSON.stringify([{ id: "core", writable: ["a.mjs:source"], done: ["完成 core"], tier: "expert" }])])
  assert.equal(p.ok, true)
  const r = await call(["dispatch-plan", "--task", "esc-t"])
  assert.equal(r.stop, "awaiting-user")
  assert.equal(r.waves.length, 0)
  assert.ok(r.card.decisionId, "决定卡在 card 下（首签归 dispatch 通道）")
  assert.equal(io(), 0, "升档审批静止卡零成员规则 I/O")

  // 批准升档后真正派发：恰好 1 次
  await call(["decide", "--task", "esc-t", "--choice", "1"])
  const d = await call(["dispatch-plan", "--task", "esc-t"])
  assert.equal(d.stop, null)
  assert.equal(d.waves.length, 1)
  assert.equal(io(), 1, "审批后派发恰好 1 次成员规则 I/O")
  assert.match(d.waves[0].prompt, /不盲目接受派单提供的信息/, "审批后派发注入规则")
})

test("blocked 卡路径（门失败且非人工阻塞）零成员规则 I/O", async () => {
  const projectRoot = await makeProject({ workflow: FLOW_WORKFLOW, policy: FLOW_POLICY })
  await corruptMemberRule(projectRoot)
  const call = caller(projectRoot)
  // workflow 模式（entry null）：无 through-stage 人工门，gate 失败即 blocked（而非 awaiting-user）
  await openTask(projectRoot, "blk-t", { objective: "实现模块 X", entry: null })

  const warns = []
  mock.method(console, "warn", (...args) => warns.push(args.join(" ")))
  const io = () => warns.length

  // ① research 阶段完整收敛（派发 ×2），advance 直达 implementation 派发点
  const r1 = await call(["dispatch-plan", "--task", "blk-t", "--writable", "none"])
  assert.equal(r1.stop, null)
  assert.equal(io(), 1, "research 派发恰好 1 次成员规则 I/O")
  await call(["deliver", "--task", "blk-t", "--key", r1.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "完成"])
  const rc = await call(["dispatch-plan", "--task", "blk-t"])
  assert.equal(rc.waves[0].role, "challenger")
  assert.equal(io(), 2, "research 评审派发恰好 1 次成员规则 I/O")
  await call(["review", "--task", "blk-t", "--key", rc.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "通过"])
  const adv = await call(["dispatch-plan", "--task", "blk-t", "--writable", "src.mjs:source"])
  assert.equal(adv.stop, null)
  assert.equal(adv.stage, "implementation")
  assert.equal(adv.waves[0].role, "owner")
  assert.equal(io(), 3, "advance 转移零成员规则 I/O，落点派发恰好 1 次")

  // ② implementation 阶段交付：deliver 携带 fail 检查（intake 接受，门禁判 blocker）
  await writeFile(path.join(projectRoot, "src.mjs"), "export const x = 1", "utf8")
  await call(["deliver", "--task", "blk-t", "--key", adv.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "完成", "--paths", "src.mjs", "--checks", '[{"name":"lint","result":"fail"}]'])
  const c = await call(["dispatch-plan", "--task", "blk-t"])
  assert.equal(c.waves[0].role, "challenger")
  assert.equal(io(), 4, "implementation 评审派发恰好 1 次成员规则 I/O")
  await call(["review", "--task", "blk-t", "--key", c.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "通过"])

  // ③ 门失败（检查未通过，无 awaitingUser blocker）→ blocked 卡：零成员规则 I/O
  const b = await call(["run", "--task", "blk-t"])
  assert.equal(b.status, "blocked")
  assert.equal(b.next, "none")
  assert.equal(b.transition, "blocked")
  assert.match(b.blockers.map((x) => x.requirement).join(), /lint/, "blocker 指明失败检查")
  assert.equal(io(), 4, "blocked 卡路径零成员规则 I/O")
})

test("Lead 时点选择性读取：progress 只读 lead/progress，dispatch 只读 lead/dispatch", async () => {
  const projectRoot = await makeProject({ workflow: IMPL_WORKFLOW, policy: IMPL_POLICY })
  // 只损坏 progress 时点：其他时点读取不计入，非呈现路径也不应读它
  await corruptLeadRule(projectRoot, "progress")
  const call = caller(projectRoot)
  await openTask(projectRoot, "lead-io-t", { objective: "实现模块 X", entry: "implementation" })

  const warns = []
  mock.method(console, "warn", (...args) => warns.push(args.join(" ")))
  const io = () => warns.length

  // ① 任务不存在：零 Lead 规则 I/O
  await call(["run", "--task", "ghost-t"])
  assert.equal(io(), 0, "任务不存在路径零 Lead 规则 I/O")

  // ② run 普通进展（working + next=dispatch）：读 lead/progress 恰好 1 次；重复查询每次在场（无已读标记）
  const first = await call(["run", "--task", "lead-io-t"])
  assert.equal(first.status, "working")
  assert.equal(io(), 1, "进展时点恰好 1 次 lead/progress I/O")
  await call(["run", "--task", "lead-io-t"])
  assert.equal(io(), 2, "重复查询按现状每次重新反吐")

  // ③ 派发时点读的是 lead/dispatch，不读损坏的 lead/progress
  const plan = await call(["dispatch-plan", "--task", "lead-io-t", "--writable", "src.mjs:source"])
  assert.equal(plan.stop, null)
  assert.equal(io(), 2, "派发时点不读 lead/progress")

  // ④ 机械回执不注入呈现，也不读 Lead 规则；随后的评审派发只读 lead/dispatch
  await writeFile(path.join(projectRoot, "src.mjs"), "export const x = 1", "utf8")
  const delivery = await call(["deliver", "--task", "lead-io-t", "--key", plan.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "完成", "--paths", "src.mjs"])
  assert.equal(delivery.presentation, undefined)
  assert.equal(io(), 2, "机械回执零 Lead 规则 I/O")
  const reviewer = (await call(["dispatch-plan", "--task", "lead-io-t"])).waves[0]
  assert.equal(reviewer.role, "challenger")
  assert.equal(io(), 2, "评审派发时点同样不读 lead/progress")

  // ⑤ 决定点读 lead/decision，同样不读损坏的 lead/progress（另起一个 blocked 任务，避免 progress 路径）
  await openTask(projectRoot, "decide-io-t", { objective: "实现模块 X", entry: "implementation" })
  const decPlan = await call(["dispatch-plan", "--task", "decide-io-t", "--writable", "src.mjs:source"])
  await call(["deliver", "--task", "decide-io-t", "--key", decPlan.waves[0].dispatchKey, "--outcome", "blocked", "--summary", "新增设施是否本轮必需仍有争议"])
  const decision = await call(["run", "--task", "decide-io-t"])
  assert.equal(decision.status, "awaiting-user")
  assert.equal(io(), 2, "决定点读 lead/decision，不读 lead/progress")
})

test("热变语义：修改项目规则文件后下一次派发生效（无模块级缓存）", async () => {
  const projectRoot = await makeProject({ workflow: IMPL_WORKFLOW, policy: IMPL_POLICY })
  await writeRule(projectRoot, "common/index.md", "## 规范\n\n- 第一版覆盖条目")
  const call = caller(projectRoot)
  await openTask(projectRoot, "hot-t", { objective: "实现模块 X", entry: "implementation" })

  const d = await call(["dispatch-plan", "--task", "hot-t", "--writable", "src.mjs:source"])
  assert.match(d.waves[0].prompt, /第一版覆盖条目/, "首次派发注入当前规则")
  assert.doesNotMatch(d.waves[0].prompt, /第二版覆盖条目/, "新内容尚未写入")

  // 交付后修改规则文件，respond 续派（同一任务第二次派发）应读到新内容
  await writeFile(path.join(projectRoot, "src.mjs"), "export const x = 1", "utf8")
  await call(["deliver", "--task", "hot-t", "--key", d.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "完成", "--paths", "src.mjs"])
  const c = await call(["dispatch-plan", "--task", "hot-t"])
  await call(["review", "--task", "hot-t", "--key", c.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "返工"])
  await writeRule(projectRoot, "common/index.md", "## 规范\n\n- 第二版覆盖条目")
  const rw = await call(["dispatch-plan", "--task", "hot-t", "--writable", "src.mjs:source"])
  assert.equal(rw.waves[0].kind, "respond")
  assert.match(rw.waves[0].prompt, /第二版覆盖条目/, "修改规则文件后下次派发生效（热变）")
  assert.doesNotMatch(rw.waves[0].prompt, /第一版覆盖条目/, "旧内容不残留（无模块级缓存）")
})
