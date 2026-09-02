// runtime-v3 CLI 全链路：code-review 介入 → Owner → Challenger → Expert → 人工门 accept → completed → archive
// 规约映射：DoD #4 的工具序列彩排（无真实模型）、E2E-14 终态幂等、I7 静止、§5.2 归档

import test from "node:test"
import assert from "assert/strict"
import { mkdtemp, writeFile, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { tw } from "../runtime-v3/cli.mjs"

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

  // 2. run → Owner 派单卡（带 key、可写边界、派单文本）
  const missingWritable = await call(["run", "--task", "audit-e2e"])
  assert.equal(missingWritable.ok, false)
  assert.equal(missingWritable.code, "DISPATCH_INPUT_REQUIRED")
  assert.match(missingWritable.message, /code-review/)

  const dispatch1 = await call(["run", "--task", "audit-e2e", "--writable", "CODE_REVIEW.md:code-review"])
  assert.equal(dispatch1.next, "dispatch")
  assert.equal(dispatch1.dispatch.role, "owner")
  assert.match(dispatch1.dispatch.prompt, /只读派单|可写路径/)
  const ownerKey = dispatch1.dispatch.key

  // 3. Owner deliver（写文件后交卷）
  await writeFile(path.join(projectRoot, "CODE_REVIEW.md"), "# 审查\n两个高危", "utf8")
  const delivered = await call(["deliver", "--task", "audit-e2e", "--key", ownerKey, "--outcome", "delivered", "--summary", "八视角覆盖", "--paths", "CODE_REVIEW.md", "--checks", '[{"name":"npm test","result":"pass"}]'])
  assert.equal(delivered.accepted, true)

  // 4. run → Challenger 派单 → review rework → run → Owner respond → deliver → run → Challenger 复审 accept
  const d2 = await call(["run", "--task", "audit-e2e"])
  assert.equal(d2.dispatch.role, "challenger")
  const rework = await call(["review", "--task", "audit-e2e", "--key", d2.dispatch.key, "--recommendation", "rework", "--summary", "并发覆盖不足", "--findings", '[{"severity":"risk","statement":"连接池耗尽未分析"}]'])
  assert.equal(rework.accepted, true)

  const d3 = await call(["run", "--task", "audit-e2e", "--writable", "CODE_REVIEW.md:code-review"])
  assert.equal(d3.dispatch.kind, "respond")
  await writeFile(path.join(projectRoot, "CODE_REVIEW.md"), "# 审查 v2\n补齐并发", "utf8")
  const fixed = await call(["deliver", "--task", "audit-e2e", "--key", d3.dispatch.key, "--outcome", "delivered", "--summary", "补齐并发分析", "--paths", "CODE_REVIEW.md"])
  assert.equal(fixed.accepted, true)

  const d4 = await call(["run", "--task", "audit-e2e"])
  assert.equal(d4.dispatch.role, "challenger")
  const accept = await call(["review", "--task", "audit-e2e", "--key", d4.dispatch.key, "--recommendation", "accept", "--summary", "缺口已补齐"])
  assert.equal(accept.accepted, true)

  // 5. run → Expert 裁决波次（core=true）
  const d5 = await call(["run", "--task", "audit-e2e"])
  assert.equal(d5.dispatch.role, "expert")
  const verdict = await call(["review", "--task", "audit-e2e", "--key", d5.dispatch.key, "--recommendation", "accept", "--summary", "裁决", "--verdict", '{"outcome":"accept","rationale":"证据充分","confidence":"high","recommendedAction":"进入验收"}'])
  assert.equal(verdict.accepted, true)

  // 6. E2E 路由判定（I9：skip 需依据）→ 门 → scoped final-acceptance 签发（I7 静止）
  const noBasis = await call(["route", "--task", "audit-e2e", "--route", "e2e", "--decision", "skip"])
  assert.equal(noBasis.ok, false, "skip 无依据必须拒绝")
  await call(["route", "--task", "audit-e2e", "--route", "e2e", "--decision", "skip", "--basis", "审查类任务，无跨系统路径"])
  const awaiting = await call(["run", "--task", "audit-e2e"])
  assert.equal(awaiting.status, "awaiting-user")
  assert.equal(awaiting.next, "decide")
  assert.ok(awaiting.choices.some((c) => c.label === "accept"))
  const decisionId = awaiting.decisionId

  // 静止期重复 run → 同一张卡（I7；不重复签发）
  const again = await call(["run", "--task", "audit-e2e"])
  assert.equal(again.decisionId, decisionId)

  // 7. decide accept → run → completed
  const decided = await call(["decide", "--task", "audit-e2e", "--choice", "1"])
  assert.equal(decided.ok, true)
  assert.equal(decided.choice, "accept")

  const completed = await call(["run", "--task", "audit-e2e"])
  assert.equal(completed.status, "completed")
  assert.equal(completed.next, "archive")

  // E2E-14：终态幂等——完成后再 run 返回同一完成卡
  const completed2 = await call(["run", "--task", "audit-e2e"])
  assert.deepEqual(completed2, completed)

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
  const d1 = await call(["run", "--task", "quick-scan", "--writable", "NOTES.md:code-review"])

  // converge-user：跑满三轮 rework → 决定"结束任务" → partial 归档
  let round = 1
  let dispatch = d1
  while (round <= 3) {
    await writeFile(path.join(projectRoot, "NOTES.md"), `v${round}`, "utf8")
    await call(["deliver", "--task", "quick-scan", "--key", dispatch.dispatch.key, "--outcome", "delivered", "--summary", "s", "--paths", "NOTES.md"])
    const rd = await call(["run", "--task", "quick-scan"])
    if (rd.status === "awaiting-user") break
    await call(["review", "--task", "quick-scan", "--key", rd.dispatch.key, "--recommendation", "rework", "--summary", "再改"])
    round += 1
    dispatch = await call(["run", "--task", "quick-scan", "--writable", "NOTES.md:code-review"])
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

  // dispatch 派发卡：轻量简报纪律（派单转发成员，不复述用户）
  const d1 = await call(["run", "--task", "present-check", "--writable", "REPORT.md:code-review"])
  assert.equal(d1.transition, "dispatch")
  assert.ok(d1.presentation, "派发卡带呈现简报")
  assert.match(d1.presentation, /原样转发给成员/)

  // 成员 deliver 回执：不是用户汇报点，不注入
  await writeFile(path.join(projectRoot, "REPORT.md"), "# 报告\n覆盖八视角", "utf8")
  const delivered = await call(["deliver", "--task", "present-check", "--key", d1.dispatch.key, "--outcome", "delivered", "--summary", "完成八视角审查", "--paths", "REPORT.md"])
  assert.equal(delivered.accepted, true)
  assert.equal(delivered.presentation, undefined, "成员回执不注入呈现纪律")

  // challenger accept → expert 裁决 → e2e skip → 人工门卡（用户决定点）
  const d2 = await call(["run", "--task", "present-check"])
  await call(["review", "--task", "present-check", "--key", d2.dispatch.key, "--recommendation", "accept", "--summary", "结论可靠"])
  const d3 = await call(["run", "--task", "present-check"])
  await call(["review", "--task", "present-check", "--key", d3.dispatch.key, "--recommendation", "accept", "--summary", "裁决", "--verdict", '{"outcome":"accept","rationale":"证据链完整","confidence":"high","recommendedAction":"验收"}'])
  // 路由卡也是用户决定点：同样带完整纪律与阶段工作摘要
  const routeCard = await call(["run", "--task", "present-check"])
  assert.equal(routeCard.next, "route")
  assert.match(routeCard.presentation, /呈现纪律/)
  assert.match(routeCard.progress, /完成八视角审查/)
  await call(["route", "--task", "present-check", "--route", "e2e", "--decision", "skip", "--basis", "审查类任务，无跨系统路径"])
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

  // accept → completed：进展转折卡带轻量提醒
  await call(["decide", "--task", "present-check", "--choice", "1"])
  const done = await call(["run", "--task", "present-check"])
  assert.equal(done.status, "completed")
  assert.match(done.presentation, /自然语言完整说明/)
})
