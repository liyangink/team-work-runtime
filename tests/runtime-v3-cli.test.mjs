// runtime-v3 CLI 全链路：code-review 介入 → Owner → Challenger → Expert → 人工门 accept → completed → archive
// 规约映射：DoD #4 的工具序列彩排（无真实模型）、E2E-14 终态幂等、I7 静止、§5.2 归档

import test from "node:test"
import assert from "assert/strict"
import { mkdir, mkdtemp, writeFile, readFile, readdir, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { tw } from "../runtime-v3/cli.mjs"
import { artifactsFingerprint } from "../runtime-v3/gate.mjs"

// dispatch-plan 在派发点强制校验全局 tier 解析（run 只读化后是唯一推进通道）——本文件自带临时 settings
const settingsFile = path.join(tmpdir(), `tw-cli-tiers-${process.pid}-${Date.now()}.yaml`)
await writeFile(settingsFile, [
  "team-work-dsh:",
  "  tiers:",
  "    junior: { provider: cli-junior, model: cli-junior }",
  "    senior: { provider: cli-senior, model: cli-senior }",
  "    expert: { provider: cli-expert, model: cli-expert }",
  "",
].join("\n"))
process.env.DSH_SETTINGS = settingsFile

test("code-review 介入全链路（CLI 序列）", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "tw-cli-"))
  const call = (argv) => tw(argv, { projectRoot })

  // 1. open：名字寻址 + entry 介入
  const opened = await call(["open", "--name", "audit-e2e", "--objective", "审查当前分支，重点安全", "--entry", "code-review"])
  assert.equal(opened.ok, true)
  assert.equal(opened.stage, "code-review")
  assert.match(opened.note, /介入/)

  // open 重名拒绝（I1/I2）
  const dup = await call(["open", "--name", "audit-e2e", "--objective", "x", "--entry", "code-review"])
  assert.equal(dup.ok, false)
  assert.equal(dup.code, "TASK_EXISTS")

  // 2. dispatch-plan → Owner 派单（带 key、可写边界、派单文本）；run 只读化后推进一律 dispatch 通道
  const missingWritable = await call(["dispatch-plan", "--task", "audit-e2e"])
  assert.equal(missingWritable.ok, false)
  assert.equal(missingWritable.code, "DISPATCH_INPUT_REQUIRED")
  assert.match(missingWritable.message, /code-review/)

  const dispatch1 = await call(["dispatch-plan", "--task", "audit-e2e", "--writable", "CODE_REVIEW.md:code-review"])
  assert.equal(dispatch1.stop, null)
  assert.equal(dispatch1.waves[0].role, "owner")
  assert.match(dispatch1.waves[0].prompt, /只读派单|可写路径/)
  const ownerKey = dispatch1.waves[0].dispatchKey

  // 3. Owner deliver（写文件后交卷）
  await writeFile(path.join(projectRoot, "CODE_REVIEW.md"), "# 审查\n两个高危", "utf8")
  const delivered = await call(["deliver", "--task", "audit-e2e", "--key", ownerKey, "--outcome", "delivered", "--summary", "八视角覆盖", "--paths", "CODE_REVIEW.md", "--checks", '[{"name":"npm test","result":"pass"}]'])
  assert.equal(delivered.accepted, true)

  // 4. dispatch-plan → Challenger 派单 → review rework → respond → deliver → 复审 accept
  const d2 = await call(["dispatch-plan", "--task", "audit-e2e"])
  assert.equal(d2.waves[0].role, "challenger")
  const rework = await call(["review", "--task", "audit-e2e", "--key", d2.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "并发覆盖不足", "--findings", '[{"severity":"risk","statement":"连接池耗尽未分析"}]'])
  assert.equal(rework.accepted, true)

  const d3 = await call(["dispatch-plan", "--task", "audit-e2e", "--writable", "CODE_REVIEW.md:code-review"])
  assert.equal(d3.waves[0].kind, "respond")
  await writeFile(path.join(projectRoot, "CODE_REVIEW.md"), "# 审查 v2\n补齐并发", "utf8")
  const fixed = await call(["deliver", "--task", "audit-e2e", "--key", d3.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "补齐并发分析", "--paths", "CODE_REVIEW.md"])
  assert.equal(fixed.accepted, true)

  const d4 = await call(["dispatch-plan", "--task", "audit-e2e"])
  assert.equal(d4.waves[0].role, "challenger")
  const accept = await call(["review", "--task", "audit-e2e", "--key", d4.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "缺口已补齐"])
  assert.equal(accept.accepted, true)

  // 5. dispatch-plan → Expert 裁决波次（core=true）
  const d5 = await call(["dispatch-plan", "--task", "audit-e2e"])
  assert.equal(d5.waves[0].role, "expert")
  const verdict = await call(["review", "--task", "audit-e2e", "--key", d5.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "裁决", "--verdict", '{"outcome":"accept","rationale":"证据充分","confidence":"high","recommendedAction":"进入验收"}'])
  assert.equal(verdict.accepted, true)

  // 6. E2E 路由判定（I9：skip 需依据）→ 门 → scoped final-acceptance 签发（I7 静止；首签归 dispatch 通道）
  const noBasis = await call(["route", "--task", "audit-e2e", "--route", "e2e", "--decision", "skip"])
  assert.equal(noBasis.ok, false, "skip 无依据必须拒绝")
  await call(["route", "--task", "audit-e2e", "--route", "e2e", "--decision", "skip", "--basis", "审查类任务，无跨系统路径"])
  const awaiting = await call(["dispatch-plan", "--task", "audit-e2e"])
  assert.equal(awaiting.stop, "awaiting-user")
  assert.equal(awaiting.card.next, "decide")
  assert.ok(awaiting.card.choices.some((c) => c.label === "accept"))
  const decisionId = awaiting.card.decisionId

  // 静止期重复 run → 同一张卡（I7；run 只读渲染已签发待决卡，不重复签发）
  const again = await call(["run", "--task", "audit-e2e"])
  assert.equal(again.status, "awaiting-user")
  assert.equal(again.decisionId, decisionId)

  // 7. decide accept → dispatch-plan 推进收尾 → completed（完成也是 dispatch 侧写者）
  const decided = await call(["decide", "--task", "audit-e2e", "--choice", "1"])
  assert.equal(decided.ok, true)
  assert.equal(decided.choice, "accept")

  const completed = await call(["dispatch-plan", "--task", "audit-e2e"])
  assert.equal(completed.stop, "completed")
  assert.equal(completed.card.status, "completed")
  assert.equal(completed.card.next, "archive")

  // E2E-14：终态幂等——完成后再 run 返回同一完成卡（只读幂等）
  const completed2 = await call(["run", "--task", "audit-e2e"])
  assert.equal(completed2.status, "completed")
  assert.equal(completed2.next, "archive")
  const completed3 = await call(["run", "--task", "audit-e2e"])
  assert.deepEqual(completed3, completed2)

  // 8. archive：显式归档（completed 形态）
  const archived = await call(["archive", "--task", "audit-e2e"])
  assert.equal(archived.ok, true)
  assert.equal(archived.form, "completed")
  const manifest = JSON.parse(await readFile(path.join(projectRoot, ".team-work", "archive", "audit-e2e", "manifest.json"), "utf8"))
  assert.equal(manifest.form, "completed")
  assert.equal(manifest.reviews.length, 3, "压缩审查日志：challenger×2 + expert×1")
  const restored = await readFile(path.join(projectRoot, ".team-work", "archive", "audit-e2e", "artifacts", "CODE_REVIEW.md"), "utf8")
  assert.equal(restored, "# 审查 v2\n补齐并发", "归档保存最终版产出物内容")
  // 项目树里的制品本体不动
  const inPlace = await readFile(path.join(projectRoot, "CODE_REVIEW.md"), "utf8")
  assert.match(inPlace, /补齐并发/)
  // 任务目录已清理
  await assert.rejects(stat(path.join(projectRoot, ".team-work", "tasks", "audit-e2e")))
  // 归档只读强制（§5.2）：写入被文件系统拒绝
  await assert.rejects(
    writeFile(path.join(projectRoot, ".team-work", "archive", "audit-e2e", "manifest.json"), "篡改"),
    (error) => ["EACCES", "EPERM"].includes(error.code),
  )
  // 归档幂等（只读目录上重读 manifest 仍可行）
  const reArchive = await call(["archive", "--task", "audit-e2e"])
  assert.equal(reArchive.ok, true)
  // 归档后 run 返回只读摘要卡而非 TASK_NOT_FOUND（E2E-14 精神）
  const postArchive = await call(["run", "--task", "audit-e2e"])
  assert.equal(postArchive.ok, true)
  assert.equal(postArchive.status, "archived")
  assert.equal(postArchive.form, "completed")
})

test("partial 归档：未完成任务由用户终止后归档", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "tw-cli2-"))
  const call = (argv) => tw(argv, { projectRoot })
  await call(["open", "--name", "quick-scan", "--objective", "快速看一眼", "--entry", "code-review"])
  const d1 = await call(["dispatch-plan", "--task", "quick-scan", "--writable", "NOTES.md:code-review"])

  // converge-user：跑满三轮 rework → 决定"结束任务" → partial 归档（静止卡由 dispatch-plan 首签、run 只读渲染）
  let round = 1
  let dispatch = d1
  while (round <= 3) {
    await writeFile(path.join(projectRoot, "NOTES.md"), `v${round}`, "utf8")
    await call(["deliver", "--task", "quick-scan", "--key", dispatch.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "NOTES.md"])
    const rd = await call(["dispatch-plan", "--task", "quick-scan"])
    if (rd.stop === "awaiting-user") break
    await call(["review", "--task", "quick-scan", "--key", rd.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "再改"])
    round += 1
    dispatch = await call(["dispatch-plan", "--task", "quick-scan", "--writable", "NOTES.md:code-review"])
  }
  const exhausted = await call(["run", "--task", "quick-scan"])
  assert.equal(exhausted.status, "awaiting-user", "三轮后升级用户")
  assert.ok(exhausted.choices.some((c) => c.label === "结束任务"))

  const ended = await call(["decide", "--task", "quick-scan", "--choice", "2"])
  assert.equal(ended.ok, true)
  const archived = await call(["archive", "--task", "quick-scan"])
  assert.equal(archived.form, "partial")
})

test("汇报呈现注入：用户决定点带纪律与素材，回执不注入，幂等稳定", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "tw-present-"))
  const call = (argv) => tw(argv, { projectRoot })
  await call(["open", "--name", "present-check", "--objective", "验证呈现注入", "--entry", "code-review"])

  // dispatch 派发：轻量简报纪律随 waves 计划输出提升（派单转发成员，不复述用户）
  const d1 = await call(["dispatch-plan", "--task", "present-check", "--writable", "REPORT.md:code-review"])
  assert.equal(d1.stop, null)
  assert.ok(d1.presentation, "派发计划带呈现简报")
  assert.match(d1.presentation, /原样转发给成员/)

  // 成员 deliver 回执：不是用户汇报点，不注入
  await writeFile(path.join(projectRoot, "REPORT.md"), "# 报告\n覆盖八视角", "utf8")
  const delivered = await call(["deliver", "--task", "present-check", "--key", d1.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "完成八视角审查", "--paths", "REPORT.md"])
  assert.equal(delivered.accepted, true)
  assert.equal(delivered.presentation, undefined, "成员回执不注入呈现纪律")

  // challenger accept → expert 裁决 → e2e skip → 人工门卡（用户决定点）
  const d2 = await call(["dispatch-plan", "--task", "present-check"])
  await call(["review", "--task", "present-check", "--key", d2.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "结论可靠"])
  const d3 = await call(["dispatch-plan", "--task", "present-check"])
  await call(["review", "--task", "present-check", "--key", d3.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "裁决", "--verdict", '{"outcome":"accept","rationale":"证据链完整","confidence":"high","recommendedAction":"验收"}'])
  // 路由卡也是用户决定点：同样带完整纪律与阶段工作摘要
  const routeCard = await call(["run", "--task", "present-check"])
  assert.equal(routeCard.next, "route")
  assert.match(routeCard.presentation, /呈现纪律/)
  assert.match(routeCard.progress, /完成八视角审查/)
  await call(["route", "--task", "present-check", "--route", "e2e", "--decision", "skip", "--basis", "审查类任务，无跨系统路径"])
  // 人工门首签归 dispatch 通道；run 只读渲染已签发的待决卡
  const gateSigned = await call(["dispatch-plan", "--task", "present-check"])
  assert.equal(gateSigned.stop, "awaiting-user")
  const gate = await call(["run", "--task", "present-check"])
  assert.equal(gate.status, "awaiting-user")

  // 完整呈现纪律 + 阶段工作摘素材（runtime 推导，不劳 Lead 翻目录）
  assert.match(gate.presentation, /呈现纪律/)
  assert.match(gate.presentation, /不得原样抛给用户/)
  assert.match(gate.progress, /完成八视角审查/)
  assert.match(gate.progress, /REPORT\.md/)
  assert.match(gate.progress, /证据链完整/)

  // 静止期重复 run：注入为静态文本，卡片自足稳定（I7 + 认知对等不随轮数漂移）
  const again = await call(["run", "--task", "present-check"])
  assert.equal(again.presentation, gate.presentation)
  assert.equal(again.progress, gate.progress)

  // dispatch-plan 的嵌套 stop 卡同样注入（编排通道与 run 通道同纪律，素材同携）
  const plan = await call(["dispatch-plan", "--task", "present-check", "--json"])
  assert.equal(plan.stop, "awaiting-user")
  assert.match(plan.card.presentation, /呈现纪律/)
  assert.equal(plan.card.progress, gate.progress)

  // accept → completed：进展转折卡带轻量提醒（完成由 dispatch 通道落盘）
  await call(["decide", "--task", "present-check", "--choice", "1"])
  const done = await call(["dispatch-plan", "--task", "present-check"])
  assert.equal(done.stop, "completed")
  assert.match(done.card.presentation, /自然语言完整说明/)
})

// ── §7 修订 v2：run 只读矩阵 + dispatch-plan 人读模式 ─────────────────────────

test("run 只读：待派发/在途各态出指引卡且零写入；--writable 被拒绝", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "tw-run-ro-"))
  const call = (argv) => tw(argv, { projectRoot })
  await call(["open", "--name", "ro-check", "--objective", "验证只读 run", "--entry", "code-review"])

  // 待派发态：run 返回指引卡（带波次信息），不落盘任何任务事实
  const before = await readFile(path.join(projectRoot, ".team-work", "tasks", "ro-check", "journal.jsonl"), "utf8").catch(() => "")
  const status1 = await call(["run", "--task", "ro-check"])
  assert.equal(status1.ok, true)
  assert.equal(status1.status, "working")
  assert.equal(status1.next, "dispatch")
  assert.deepEqual(status1.wave, { kind: "produce", role: "owner", round: 1 })
  assert.match(status1.note, /tw-dispatch/)
  assert.match(status1.note, /dispatch-plan/)
  const after = await readFile(path.join(projectRoot, ".team-work", "tasks", "ro-check", "journal.jsonl"), "utf8").catch(() => "")
  assert.equal(after, before, "run 不写 journal（开单归 dispatch 通道）")

  // run --writable 显式拒绝（防旧习惯误用）
  const rejected = await call(["run", "--task", "ro-check", "--writable", "X.md:code-review"])
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, "USAGE")
  assert.match(rejected.message, /run 已只读/)

  // 派发后（在途）：dispatch-plan 出 wait-inflight stop 卡（兜底判定事实在 inflight 条目），run 只读重建同事实
  const plan1 = await call(["dispatch-plan", "--task", "ro-check", "--writable", "CODE_REVIEW.md:code-review"])
  assert.equal(plan1.stop, null)
  const inflightPlan = await call(["dispatch-plan", "--task", "ro-check"])
  assert.equal(inflightPlan.stop, "wait-inflight")
  const entry = inflightPlan.inflight[0]
  assert.equal(entry.registered, false, "agents.json 缺失 = 零登记事实（registered 由 runtime 锁内投影）")
  assert.ok(entry.modelHint?.provider, "modelHint 从 journal dispatched 快照回填")
  const status2 = await call(["run", "--task", "ro-check"])
  assert.equal(status2.transition, "wait-inflight")
  assert.equal(status2.inflight[0].registered, false)
  assert.ok(status2.inflight[0].modelHint?.provider)
  assert.match(status2.note, /tw-dispatch/)
})

test("run 只读：指纹失效待决卡出重签指引且不作废不重签（写归 dispatch，封堵死循环）；dispatch-plan 重签后旧卡 decide 被拒", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "tw-run-stale-"))
  // 非 core 场景 + 本阶段人工门（无 Expert 裁决波干扰——制品变化直接作用在门卡签发指纹上）
  await mkdir(path.join(projectRoot, "workflow", "definitions"), { recursive: true })
  await writeFile(path.join(projectRoot, "workflow", "definitions", "engineering.json"), JSON.stringify({
    terminalStages: ["finish"],
    gates: [{ gateId: "user-approval", stage: "code-review", requirement: "required", artifactKind: "code-review" }],
    stages: [{ id: "code-review", label: "代码审查", outputs: ["code-review"], teamScene: "code-review" }],
  }))
  await mkdir(path.join(projectRoot, "team-work", "policies"), { recursive: true })
  await writeFile(path.join(projectRoot, "team-work", "policies", "default.json"), JSON.stringify({
    maxAutonomousRounds: 3, costWeights: { junior: 1, senior: 10, expert: 50 }, riskTiers: { critical: "expert", high: "senior" },
    scenes: { "code-review": { core: false } },
  }))
  const call = (argv) => tw(argv, { projectRoot })
  await call(["open", "--name", "stale-check", "--objective", "验证失效指引", "--entry", "code-review"])
  const plan = await call(["dispatch-plan", "--task", "stale-check", "--writable", "R.md:code-review"])
  await writeFile(path.join(projectRoot, "R.md"), "v1", "utf8")
  await call(["deliver", "--task", "stale-check", "--key", plan.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  // challenger accept（非 core：accept 即出集）→ dispatch-plan 签发人工门卡（绑定签发指纹）
  const cPlan = await call(["dispatch-plan", "--task", "stale-check"])
  await call(["review", "--task", "stale-check", "--key", cPlan.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "s"])
  const signed = await call(["dispatch-plan", "--task", "stale-check"])
  assert.equal(signed.stop, "awaiting-user")
  const oldDecisionId = signed.card.decisionId

  // 等待期制品变化（owner 同 key 重交 ver2 修订）→ 签发指纹失效：run 只读给重签指引，不作废旧卡
  await writeFile(path.join(projectRoot, "R.md"), "v2 修订", "utf8")
  await call(["deliver", "--task", "stale-check", "--key", plan.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s2 修订", "--paths", "R.md"])
  const journalBefore = await readFile(path.join(projectRoot, ".team-work", "tasks", "stale-check", "journal.jsonl"), "utf8")
  const stale = await call(["run", "--task", "stale-check"])
  assert.equal(stale.status, "awaiting-user")
  assert.equal(stale.next, "re-sign")
  assert.equal(stale.stale, true)
  assert.equal(stale.decisionId, oldDecisionId)
  assert.match(stale.note, /重签/)
  const journalAfter = await readFile(path.join(projectRoot, ".team-work", "tasks", "stale-check", "journal.jsonl"), "utf8")
  assert.equal(journalAfter, journalBefore, "只读 run 不作废旧卡（无 decided:superseded 写入）")

  // dispatch-plan 推进 = 重签通道：作废旧卡（decided:superseded 只增）签新卡；新卡 decide 恢复应答
  const resigned = await call(["dispatch-plan", "--task", "stale-check"])
  assert.equal(resigned.stop, "awaiting-user")
  assert.notEqual(resigned.card.decisionId, oldDecisionId, "重签出新卡")
  const decided = await call(["decide", "--task", "stale-check", "--choice", "1"])
  assert.equal(decided.ok, true, "重签通道闭合：失效→重签→应答恢复")
})

test("dispatch-plan 人读模式：waves 与全部 stop 卡均带 human 指引（--json 不输出）", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "tw-plan-human-"))
  const call = (argv) => tw(argv, { projectRoot })
  await call(["open", "--name", "human-check", "--objective", "验证人读输出", "--entry", "code-review"])

  // waves 派发：human 含派单行 + 登记提醒；--json 供编排工具消费，无 human（独立任务验证，避免在途互扰）
  const plan = await call(["dispatch-plan", "--task", "human-check", "--writable", "H.md:code-review"])
  assert.equal(plan.stop, null)
  assert.ok(Array.isArray(plan.human))
  assert.match(plan.human[0], /human-check/)
  assert.ok(plan.human.some((l) => /-- owner/.test(l)), "每张派单一行人读摘要")
  assert.ok(plan.human.some((l) => /agent-map/.test(l) && /登记/.test(l)), "人读模式登记提醒（§7.5.9）")
  await call(["open", "--name", "human-json", "--objective", "验证 --json 形态", "--entry", "code-review"])
  const planJson = await call(["dispatch-plan", "--task", "human-json", "--writable", "H.md:code-review", "--json"])
  assert.equal(planJson.human, undefined, "--json 供编排工具消费，无 human")
  assert.equal(planJson.stop, null)

  // stop: wait-inflight：human 列出在途条目与登记状态
  const inflight = await call(["dispatch-plan", "--task", "human-check"])
  assert.equal(inflight.stop, "wait-inflight")
  assert.ok(Array.isArray(inflight.human))
  assert.ok(inflight.human.some((l) => /未登记/.test(l)), "在途条目带登记状态")
  assert.ok(inflight.human.some((l) => /状态：wait-inflight/.test(l)))

  // stop: awaiting-user：human 含问题与选项行
  await writeFile(path.join(projectRoot, "H.md"), "# 报告", "utf8")
  await call(["deliver", "--task", "human-check", "--key", plan.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "H.md"])
  const cPlan = await call(["dispatch-plan", "--task", "human-check"])
  await call(["review", "--task", "human-check", "--key", cPlan.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "s"])
  const ePlan = await call(["dispatch-plan", "--task", "human-check"])
  await call(["review", "--task", "human-check", "--key", ePlan.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "裁决", "--verdict", '{"outcome":"accept","rationale":"r","confidence":"high","recommendedAction":"a"}'])
  await call(["route", "--task", "human-check", "--route", "e2e", "--decision", "skip", "--basis", "无跨系统路径"])
  const gate = await call(["dispatch-plan", "--task", "human-check"])
  assert.equal(gate.stop, "awaiting-user")
  assert.ok(gate.human.some((l) => /待用户决定/.test(l)))
  assert.ok(gate.human.some((l) => /1\. accept/.test(l)))

  // stop: completed：human 即 note
  await call(["decide", "--task", "human-check", "--choice", "1"])
  const done = await call(["dispatch-plan", "--task", "human-check"])
  assert.equal(done.stop, "completed")
  assert.ok(Array.isArray(done.human))
  assert.ok(done.human.some((l) => /任务完成/.test(l)))
})

// ── §8 修订 v3：升档批准绑定包配置指纹（Expert 裁决 r2：幽灵批准不复活误授权） ──

import { makeProject, caller, openTask, FIX_WORKFLOW, FIX_POLICY } from "./support/v3-fixtures.mjs"
import { loadTask as fixLoadTask } from "../runtime-v3/store.mjs"

test("升档批准绑定包配置指纹：re-plan 改档后旧批准失效重出卡；同配置幂等", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "escfp-t")
  await call(["plan", "--task", "escfp-t", "--packages", JSON.stringify([
    { id: "hi", writable: ["HI.md:k"], done: ["d"], tier: "senior", dependsOn: [] },
  ])])
  const gate1 = await call(["dispatch-plan", "--task", "escfp-t"])
  assert.equal(gate1.stop, "awaiting-user", "升档审批卡（C）")
  await call(["decide", "--task", "escfp-t", "--choice", "1"])
  const d1 = await call(["dispatch-plan", "--task", "escfp-t"])
  assert.equal(d1.stop, null, "批准后正常出波")
  assert.equal(d1.waves[0].tier, "senior")
  // 同批次原样重推（retire 释放在途）：同 batchKey 同包配置指纹 → 批准仍有效，幂等不重复打扰用户
  await call(["retire", "--task", "escfp-t", "--wave", d1.waves[0].waveId, "--reason", "重推场景"])
  const d2 = await call(["dispatch-plan", "--task", "escfp-t"])
  assert.equal(d2.stop, null, "同配置重复推进：不重复出卡")
  assert.equal(d2.waves[0].tier, "senior")
  // re-plan 改包档（senior→expert）：batchKey 相同（stage+round+包集同名）但指纹不同 → 幽灵批准失效
  await call(["retire", "--task", "escfp-t", "--wave", d2.waves[0].waveId, "--reason", "改档场景"])
  await call(["plan", "--task", "escfp-t", "--packages", JSON.stringify([
    { id: "hi", writable: ["HI.md:k"], done: ["d"], tier: "expert", dependsOn: [] },
  ])])
  const gate2 = await call(["dispatch-plan", "--task", "escfp-t"])
  assert.equal(gate2.stop, "awaiting-user", "包配置已变化：旧批准不得授权新批次（重新出卡）")
  assert.deepEqual(gate2.card.escalations, [{ package: "hi", tier: "expert" }], "升档清单指向新档位包")
  await call(["decide", "--task", "escfp-t", "--choice", "1"])
  const d3 = await call(["dispatch-plan", "--task", "escfp-t"])
  assert.equal(d3.stop, null)
  assert.equal(d3.waves[0].tier, "expert", "新批准按新档位派发")
})

test("升档卡 decide 校验签发指纹：等待期包配置被外部改动（回滚/漂移）后旧卡拒绝直答（F6-3 同构）", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "escdec-t")
  await call(["plan", "--task", "escdec-t", "--packages", JSON.stringify([
    { id: "hi", writable: ["HI.md:k"], done: ["d"], tier: "senior", dependsOn: [] },
  ])])
  const gate = await call(["dispatch-plan", "--task", "escdec-t"])
  assert.equal(gate.stop, "awaiting-user")
  // 模拟等待期外部改动包配置（绕过 plan 窗口守卫的异常路径：快照回滚/手工编辑）——
  // decide 端重算指纹不符 → 拒绝直答，否则答旧卡写入旧语义授权且永不被新批次消费（空转）
  const task = await fixLoadTask(root, "escdec-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  await writeFile(path.join(task.root, "packages.json"), JSON.stringify({ items: [
    { id: "hi", writable: ["HI.md:k"], done: ["d"], tier: "expert", dependsOn: [] },
  ] }))
  const bad = await call(["decide", "--task", "escdec-t", "--choice", "1"])
  assert.equal(bad.ok, false)
  assert.equal(bad.code, "DECISION_STALE")
  assert.match(bad.message, /包配置已变化/)
})

// ── 返工终版 §二·B：未决卡统一静止 + 签发幂等 + 渲染同钉 ──────────────────────────

test("升档卡静止化与幂等：签发后 run 呈待决原卡、再调 dispatch-plan 返回同一张卡（choices=账本）；待决期间拒绝重拆", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "escstill-t")
  await call(["plan", "--task", "escstill-t", "--packages", JSON.stringify([
    { id: "hi", writable: ["HI.md:k"], done: ["d"], tier: "senior", dependsOn: [] },
  ])])
  const gate = await call(["dispatch-plan", "--task", "escstill-t"])
  assert.equal(gate.stop, "awaiting-user", "升档审批卡首签")
  const firstId = gate.card.decisionId

  // run 呈待决原卡：question/choices 来自账本（不重算），状态静止
  const runCard = await call(["run", "--task", "escstill-t"])
  assert.equal(runCard.status, "awaiting-user")
  assert.equal(runCard.decisionId, firstId)
  assert.deepEqual(runCard.choices, gate.card.choices, "渲染同钉账本 choices")
  assert.equal(runCard.question, gate.card.question)

  // 再调 dispatch-plan：返回同一张卡（签发幂等——不再作废重签循环）
  const again = await call(["dispatch-plan", "--task", "escstill-t"])
  assert.equal(again.stop, "awaiting-user")
  assert.equal(again.card.decisionId, firstId, "同卡幂等返回")
  assert.deepEqual(again.card.choices, gate.card.choices)

  // 待决期间拒绝重拆（升档卡静止语义与人工门一致：先 decide 再改包配置）
  const replan = await call(["plan", "--task", "escstill-t", "--packages", JSON.stringify([
    { id: "hi2", writable: ["H2.md:k"], done: ["d"], dependsOn: [] },
  ])])
  assert.equal(replan.ok, false)
  assert.match(replan.message, /有待决用户卡片/)

  await call(["decide", "--task", "escstill-t", "--choice", "1"])
  const d = await call(["dispatch-plan", "--task", "escstill-t"])
  assert.equal(d.stop, null, "批准后恢复派发")
})

test("升档指纹扩字段（F-2）：改 writable/done/dependsOn（tier 不变）同样使旧批准失效重出卡", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "escwide-t")
  await call(["plan", "--task", "escwide-t", "--packages", JSON.stringify([
    { id: "hi", writable: ["HI.md:k"], done: ["d1"], tier: "senior", dependsOn: [] },
  ])])
  const gate1 = await call(["dispatch-plan", "--task", "escwide-t"])
  assert.equal(gate1.stop, "awaiting-user")
  await call(["decide", "--task", "escwide-t", "--choice", "1"])
  const d1 = await call(["dispatch-plan", "--task", "escwide-t"])
  assert.equal(d1.stop, null)
  await call(["retire", "--task", "escwide-t", "--wave", d1.waves[0].waveId, "--reason", "改完成标准场景"])
  // tier 不变、仅改 done 完成标准：完整包配置指纹（id+tier+writable+done+dependsOn）不同 → 旧批准失效
  await call(["plan", "--task", "escwide-t", "--packages", JSON.stringify([
    { id: "hi", writable: ["HI.md:k"], done: ["d1", "d2"], tier: "senior", dependsOn: [] },
  ])])
  const gate2 = await call(["dispatch-plan", "--task", "escwide-t"])
  assert.equal(gate2.stop, "awaiting-user", "done 变化也触发重新审批（授权对象=完整包配置）")
})

// ── 返工终版 §二·D：run 无锁只读快照 ─────────────────────────────────────────────

test("run 无锁只读：锁目录只读时照常返回状态卡、盘上零变化（含锁文件）；卡面标注 journal seq", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "lockfree-t")
  const plan = await call(["dispatch-plan", "--task", "lockfree-t", "--writable", "R.md:doc"])
  assert.equal(plan.stop, null)

  // 锁目录置只读（模拟 EACCES 环境）：run 必须照常返回（旧实现取任务锁会创建/删除锁文件而失败）
  const locksDir = path.join(root, ".team-work", "tasks", "lockfree-t", "locks")
  await (await import("node:fs/promises")).chmod(locksDir, 0o555)
  try {
    const card = await call(["run", "--task", "lockfree-t"])
    assert.equal(card.ok, true)
    assert.equal(card.status, "working")
    assert.equal(typeof card.journalSeq, "number", "卡面标注所读 journal seq 版本（跨文件尽力一致的对账锚）")
    assert.ok(card.journalSeq >= 1)
    const entries = await (await import("node:fs/promises")).readdir(locksDir)
    assert.deepEqual(entries, [], "run 全程零写入：不创建锁文件")
  } finally {
    await (await import("node:fs/promises")).chmod(locksDir, 0o755)
  }
})

// ── 返工终版 §二·C②：续派波导出全量 prompt 变体 ─────────────────────────────────

test("dispatch-plan 导出 promptFull：续派派单附全量变体（objective/constraints/exclusions 内嵌），增量正文不含；inflight 重建同样携带", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "pfull-t", { objective: "修复判定链并补全测试" })
  await call(["intent", "--task", "pfull-t", "--add-constraint", "不改无关文件", "--add-exclusion", "不碰 v2"])
  const seeded = await call(["dispatch-plan", "--task", "pfull-t", "--writable", "R.md:doc"])
  await (await import("node:fs/promises")).writeFile(path.join(root, "R.md"), "# 初版", "utf8")
  await call(["deliver", "--task", "pfull-t", "--key", seeded.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  const review1 = await call(["dispatch-plan", "--task", "pfull-t"])
  await call(["review", "--task", "pfull-t", "--key", review1.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "重做"])
  // respond 波 = 续派（continuation: true，成员有原上下文）
  const respond = await call(["dispatch-plan", "--task", "pfull-t", "--json", "--writable", "R.md:doc"])
  assert.equal(respond.stop, null)
  const wave = respond.waves[0]
  assert.equal(wave.continuation, true)
  assert.ok(!/目标：/.test(wave.prompt), "增量正文不内嵌目标（成员有原上下文）")
  assert.ok(wave.promptFull, "续派派单附全量变体")
  assert.match(wave.promptFull, /目标：修复判定链并补全测试/)
  assert.match(wave.promptFull, /约束：/)
  assert.match(wave.promptFull, /排除：/)
  assert.match(wave.promptFull, /全量变体/)

  // wait-inflight 重建（inflight 条目）同样携带 promptFull：断链 fresh 重建的恢复边数据源
  const inflightCard = await call(["run", "--task", "pfull-t"])
  assert.equal(inflightCard.transition, "wait-inflight")
  const entry = inflightCard.inflight.find((d) => d.key === wave.dispatchKey)
  assert.ok(entry, "在途条目在场")
  assert.match(entry.promptFull, /目标：修复判定链并补全测试/, "inflight 投影带全量变体（绑定层只选用不拼装）")
})

// ── 返工终版 §二·E 补：快照损坏容错（用户终裁①，Challenger r5 死门封堵） ─────────────

test("快照损坏不构成死门：rebuildArtifacts 按缺失降级进 degraded（含处置建议），run/gate/deliver 全链照常", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "snapbad-t")
  const d = await call(["dispatch-plan", "--task", "snapbad-t", "--writable", "R.md:doc"])
  await writeFile(path.join(root, "R.md"), "内容 v1", "utf8")
  await call(["deliver", "--task", "snapbad-t", "--key", d.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  const task = await fixLoadTask(root, "snapbad-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  // 损坏形态：artifacts.json 损坏（进重建路径）+ snapshots/ 内快照损坏（非 JSON）
  await writeFile(path.join(task.root, "artifacts.json"), "{torn", "utf8")
  const snapFiles = await readdir(path.join(task.root, "snapshots"))
  assert.equal(snapFiles.length, 1)
  await writeFile(path.join(task.root, "snapshots", snapFiles[0]), "{broken snapshot", "utf8")

  // run：不抛 STATE_CORRUPT（旧实现全链死门），重建视图 + degraded 提示损坏文件与处置建议
  const runCard = await call(["run", "--task", "snapbad-t"])
  assert.equal(runCard.ok, true, "快照损坏不构成 run 死门")
  // loadTask 重建结果：items 空（快照按缺失）+ degraded 列出损坏快照与路径
  const rebuilt = await fixLoadTask(root, "snapbad-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.ok(rebuilt.artifactsRebuilt)
  assert.deepEqual(rebuilt.artifacts.items.map((i) => i.path), [], "损坏快照按缺失：路径跳过不产出错误事实")
  const fileDegraded = rebuilt.artifactsDegraded.find((x) => x.file === "snapshots/" + snapFiles[0])
  assert.ok(fileDegraded, "文件级 degraded 在场（损坏文件路径）")
  assert.match(fileDegraded.reason, /快照不可读/)
  assert.match(fileDegraded.reason, /处置建议|处置/)
  assert.match(fileDegraded.reason, /重跑重做|人工修复/)
  const pathDegraded = rebuilt.artifactsDegraded.find((x) => x.path === "R.md")
  assert.ok(pathDegraded, "路径级 degraded 在场（快照缺失自然列出）")

  // gate：同样不抛错
  const gate = await call(["gate", "--task", "snapbad-t"])
  assert.equal(gate.ok, true, "快照损坏不构成 gate 死门")
  // deliver：重交照常接受（锁内重建 + 本轮快照写入恢复）
  await writeFile(path.join(root, "R.md"), "内容 v2 修订", "utf8")
  const redeliver = await call(["deliver", "--task", "snapbad-t", "--key", d.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "v2", "--paths", "R.md"])
  assert.equal(redeliver.accepted, true, "快照损坏不构成 deliver 死门（freshState 降级重建 + 本轮写入）")
})

// ── Challenger r6：最新快照缺失/损坏时 digest 不静默回退旧版本（§9.5 不产出错误事实） ──────

test("快照-报告时间校验：最新快照丢失（旧快照在场）→ 按缺失 degraded，不产出 {digest:旧, reportRef:新} 混搭", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "snapstale-t")
  const d = await call(["dispatch-plan", "--task", "snapstale-t", "--writable", "R.md:doc"])
  // 两轮交付：v1 与 v2 内容不同（两个 digest、两个快照文件）
  await writeFile(path.join(root, "R.md"), "内容 v1", "utf8")
  await call(["deliver", "--task", "snapstale-t", "--key", d.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "v1", "--paths", "R.md"])
  await writeFile(path.join(root, "R.md"), "内容 v2 修订", "utf8")
  await call(["deliver", "--task", "snapstale-t", "--key", d.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "v2", "--paths", "R.md"])
  const task = await fixLoadTask(root, "snapstale-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const before = JSON.parse(JSON.stringify(task.artifacts.items))
  assert.equal(before.length, 1)
  const v2Digest = before[0].digest

  // 模拟最新快照丢失（v2 digest 快照文件被删；v1 快照仍在场）+ artifacts.json 损坏进重建
  await (await import("node:fs/promises")).rm(path.join(task.root, "snapshots", v2Digest + ".json"))
  await writeFile(path.join(task.root, "artifacts.json"), "{torn", "utf8")
  const rebuilt = await fixLoadTask(root, "snapstale-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.ok(rebuilt.artifactsRebuilt)
  assert.deepEqual(rebuilt.artifacts.items, [], "索引回退到的旧快照（at 落后于最新报告）不得作为登记事实——路径跳过")
  const stale = rebuilt.artifactsDegraded.find((x) => x.path === "R.md")
  assert.ok(stale, "路径级 degraded 在场")
  assert.match(stale.reason, /快照版本落后于最新交付/)
  assert.match(stale.reason, /不产出旧 digest 混搭/)
  assert.match(stale.reason, /处置建议/)
  assert.equal(stale.reportRef, "deliver-" + d.waves[0].dispatchKey, "degraded 指向最新报告")

  // 对照：最新快照在场时同一重建逐字段等价（时间校验不误伤正常路径）
  const root2 = await makeProject()
  const call2 = caller(root2)
  await openTask(root2, "snapok-t")
  const d2 = await call2(["dispatch-plan", "--task", "snapok-t", "--writable", "R.md:doc"])
  await writeFile(path.join(root2, "R.md"), "内容 v1", "utf8")
  await call2(["deliver", "--task", "snapok-t", "--key", d2.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "v1", "--paths", "R.md"])
  await writeFile(path.join(root2, "R.md"), "内容 v2 修订", "utf8")
  await call2(["deliver", "--task", "snapok-t", "--key", d2.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "v2", "--paths", "R.md"])
  const task2 = await fixLoadTask(root2, "snapok-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const before2 = JSON.parse(JSON.stringify(task2.artifacts.items))
  await writeFile(path.join(task2.root, "artifacts.json"), "{torn", "utf8")
  const rebuilt2 = await fixLoadTask(root2, "snapok-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.deepEqual(rebuilt2.artifacts.items, before2, "快照在场：重建等价（时间校验通过）")
  assert.deepEqual(rebuilt2.artifactsDegraded ?? [], [])
})

test("artifacts.json 损坏自愈：deliver/review 锁内照常接受（freshState 降级重建），deliver 落盘固化", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "tw-cli-corrupt-"))
  const call = (argv) => tw(argv, { projectRoot })
  const taskDir = path.join(projectRoot, ".team-work", "tasks", "corrupt-art")
  const artifactsFile = path.join(taskDir, "artifacts.json")
  // 破坏形态：合法 JSON 前缀被截断（JSON.parse SyntaxError，非 ENOENT）
  const corrupt = () => writeFile(artifactsFile, '{"items":[{"path":', "utf8")

  // 健康链路打底：open → owner deliver（账本健康、快照在场）
  await call(["open", "--name", "corrupt-art", "--objective", "损坏账本自愈验收", "--entry", "code-review"])
  const d1 = await call(["dispatch-plan", "--task", "corrupt-art", "--writable", "CODE_REVIEW.md:code-review"])
  await writeFile(path.join(projectRoot, "CODE_REVIEW.md"), "# 审查 v1", "utf8")
  const delivered = await call(["deliver", "--task", "corrupt-art", "--key", d1.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "首版", "--paths", "CODE_REVIEW.md"])
  assert.equal(delivered.accepted, true)

  // review 遇损坏账本照常接受：freshState 降级重建，taskSha 与健康账本指纹一致（重建口径不漂移）
  const d2 = await call(["dispatch-plan", "--task", "corrupt-art"])
  assert.equal(d2.waves[0].role, "challenger")
  const healthy = JSON.parse(await readFile(artifactsFile, "utf8"))
  const fpHealthy = artifactsFingerprint(healthy.items.filter((i) => i.stage === "code-review"))
  await corrupt()
  const reviewed = await call(["review", "--task", "corrupt-art", "--key", d2.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "并发覆盖不足"])
  assert.equal(reviewed.accepted, true)
  assert.equal(reviewed.reviewedDigest, fpHealthy, "重建条目指纹 = 健康账本指纹")

  // deliver（respond 修订）遇损坏账本照常接受，且落盘全量重写把自愈固化
  const d3 = await call(["dispatch-plan", "--task", "corrupt-art", "--writable", "CODE_REVIEW.md:code-review"])
  assert.equal(d3.waves[0].kind, "respond")
  await corrupt()
  await writeFile(path.join(projectRoot, "CODE_REVIEW.md"), "# 审查 v2", "utf8")
  const redelivered = await call(["deliver", "--task", "corrupt-art", "--key", d3.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "补齐并发分析", "--paths", "CODE_REVIEW.md"])
  assert.equal(redelivered.accepted, true)
  const healed = JSON.parse(await readFile(artifactsFile, "utf8"))
  assert.equal(healed.items.length, 1)
  assert.equal(healed.items[0].path, "CODE_REVIEW.md")
  const snap = JSON.parse(await readFile(path.join(taskDir, "snapshots", healed.items[0].digest + ".json"), "utf8"))
  assert.equal(snap.content, "# 审查 v2", "固化的是本次交付的最新快照")

  // 只读承诺不因重建改变：再次破坏后 run 呈现重建视图且账本字节级不动（repair=false 零写）
  await corrupt()
  const st = await call(["run", "--task", "corrupt-art"])
  assert.equal(st.ok, true)
  assert.equal(st.stage, "code-review")
  assert.equal(await readFile(artifactsFile, "utf8"), '{"items":[{"path":', "run 不写账本")
})

