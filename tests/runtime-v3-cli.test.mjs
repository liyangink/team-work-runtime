// runtime-v3 CLI 全链路：code-review 介入 → Owner → Challenger → Expert → 人工门 accept → completed → archive
// 规约映射：DoD #4 的工具序列彩排（无真实模型）、E2E-14 终态幂等、I7 静止、§5.2 归档

import test from "node:test"
import assert from "assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, writeFile, readFile, readdir, stat, access, cp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { tw } from "../runtime-v3/cli.mjs"
import { artifactsFingerprint } from "../runtime-v3/gate.mjs"

// 用户公共规则隔离：把 HOME 指到临时目录，派单只读该目录下的 ~/.team-work/rules，
// 不读开发机上的真实用户规则（否则断言会随本机自定义漂移）。
process.env.HOME = await mkdtemp(path.join(tmpdir(), "tw-cli-home-"))

test("范围争议 blocked：恢复提示先确认授权，保留原 re-scope 非决定接口", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "tw-scope-pause-"))
  const call = autoCaller(projectRoot)
  await call(["open", "--name", "pause-check", "--objective", "按已确认范围审阅示例方案", "--entry", "code-review"])
  const owner = (await call(["dispatch-plan", "--task", "pause-check", "--writable", "R.md:code-review"])).waves[0]
  const receipt = await call(["deliver", "--task", "pause-check", "--key", owner.dispatchKey, "--outcome", "blocked", "--summary", "新增设施是否为本轮必需及是否获授权仍有争议"])
  assert.equal(receipt.accepted, true)
  const state = await call(["run", "--task", "pause-check"])
  assert.equal(state.status, "awaiting-user")
  assert.equal(state.next, "re-scope")
  assert.equal(state.decisionId, undefined)
  assert.equal(state.choices, undefined)
  assert.match(state.note, /用户明确.*授权/)
  assert.doesNotMatch(state.note, /扩大可写范围后重派/)
  assert.match(state.question, /用户明确.*授权/)
  assert.deepEqual(await call(["run", "--task", "pause-check"]), state)
})

// dispatch-plan 在派发点校验调用快照；本文件自带完整三档。
process.env.TW_DSH_CONFIG = JSON.stringify({
  "entryId": "team-work-dsh",
  "profile": "fixture-profile",
  "tiers": {
    "junior": {
      "provider": "cli-junior",
      "model": "cli-junior"
    },
    "senior": {
      "provider": "cli-senior",
      "model": "cli-senior"
    },
    "expert": {
      "provider": "cli-expert",
      "model": "cli-expert"
    }
  }
})

test("返工派单保留原回应轮，提醒授权争议在修补前暂停而非自动扩建", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "tw-rework-scope-"))
  const call = autoCaller(projectRoot)
  await call(["open", "--name", "rework-scope", "--objective", "按原方案审阅重访策略", "--entry", "code-review"])
  const owner = (await call(["dispatch-plan", "--task", "rework-scope", "--writable", "R.md:code-review"])).waves[0]
  await writeFile(path.join(projectRoot, "R.md"), "# 原方案\n保留既有扫描机制")
  await call(["deliver", "--task", "rework-scope", "--key", owner.dispatchKey, "--outcome", "delivered", "--summary", "完成原范围方案", "--paths", "R.md"])
  const reviewer = (await call(["dispatch-plan", "--task", "rework-scope"])).waves[0]
  await call(["review", "--task", "rework-scope", "--key", reviewer.dispatchKey, "--recommendation", "rework", "--summary", "需核对容量恢复与公平再访的证据"])
  const response = (await call(["dispatch-plan", "--task", "rework-scope", "--writable", "R.md:code-review"])).waves[0]
  assert.equal(response.kind, "respond")
  assert.equal(response.round, 2)
  assert.match(response.prompt, /实质争议.*暂停依赖.*Lead/s)
  assert.match(response.prompt, /返工.*不.*授权/)
  assert.match(response.prompt, /普通最终消息/)
})

test("首轮评审升级保持同 key 修订和原卡语义，方向文本不消耗追加轮数卡", async () => {
  for (const role of ["challenger", "expert"]) {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "tw-review-direction-"))
    const call = autoCaller(projectRoot)
    await call(["open", "--name", "direction-check", "--objective", "在现有机制内审阅虚构方案", "--entry", "code-review"])
    const owner = (await call(["dispatch-plan", "--task", "direction-check", "--writable", "R.md:code-review"])).waves[0]
    await writeFile(path.join(projectRoot, "R.md"), "# 虚构方案\n保留既有机制")
    await call(["deliver", "--task", "direction-check", "--key", owner.dispatchKey, "--outcome", "delivered", "--summary", "原范围制品", "--paths", "R.md"])
    let reviewer = (await call(["dispatch-plan", "--task", "direction-check"])).waves[0]
    if (role === "expert") {
      await call(["review", "--task", "direction-check", "--key", reviewer.dispatchKey, "--recommendation", "accept", "--summary", "原范围交付合格"])
      reviewer = (await call(["dispatch-plan", "--task", "direction-check"])).waves[0]
    }
    const report = async (escalate) => call([
      "review", "--task", "direction-check", "--key", reviewer.dispatchKey,
      "--recommendation", escalate ? "escalate" : "accept", "--summary", escalate ? "必要保证与修法授权待用户确认" : "依据虚构用户方向重核，未变交付符合原范围",
      ...(role === "expert" ? ["--verdict", JSON.stringify({ outcome: escalate ? "escalate-to-user" : "accept", rationale: "核对现有方案与原目标", confidence: "high", recommendedAction: escalate ? "请用户确认方向" : "按原合同复核" })] : []),
    ])
    const first = await report(true)
    assert.equal(first.accepted, true)
    assert.equal(first.ver, 1)
    const pending = await call(["run", "--task", "direction-check"])
    assert.equal(pending.status, "working", "只读 run 未签卡，普通等待不伪装 Runtime 已落卡")
    assert.match(pending.question, /升级用户裁决|需要用户/)
    assert.equal(pending.decisionId, undefined, "Lead 可在签卡之前普通消息等待")
    await call(["intent", "--task", "direction-check", "--add-constraint", "虚构方向：保留现有机制"])
    assert.match((await call(["run", "--task", "direction-check"])).question, /升级用户裁决|需要用户/, "改意图不解除原升级报告")
    const corrected = await report(false)
    assert.equal(corrected.reportId, first.reportId)
    assert.equal(corrected.ver, 2)
    assert.equal(corrected.reviewedDigest, first.reviewedDigest, "未变交付仍绑定同一内容")
    assert.notEqual((await call(["run", "--task", "direction-check"])).next, "decide")
    await report(true)
    const signed = (await call(["dispatch-plan", "--task", "direction-check"])).card
    assert.deepEqual(signed.choices.map((c) => c.label), ["追加一轮", "结束任务"])
    assert.equal(signed.choices[0].grant, "extra-round")
    await call(["intent", "--task", "direction-check", "--add-constraint", "虚构方向确认不授权追加轮数"])
    await report(false)
    const stillPending = await call(["run", "--task", "direction-check"])
    assert.equal(stillPending.decisionId, signed.decisionId)
    assert.deepEqual(stillPending.choices, signed.choices, "报告修订和方向文本不消费原待决卡")
  }
})

test("code-review 介入全链路（CLI 序列）", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "tw-cli-"))
  const call = autoCaller(projectRoot)

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
  const call = autoCaller(projectRoot)
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
  const call = autoCaller(projectRoot)
  await call(["open", "--name", "present-check", "--objective", "验证呈现注入", "--entry", "code-review"])

  // dispatch 派发：轻量简报纪律随 waves 计划输出提升（派单转发成员，不复述用户）
  const d1 = await call(["dispatch-plan", "--task", "present-check", "--writable", "REPORT.md:code-review"])
  assert.equal(d1.stop, null)
  assert.ok(d1.presentation, "派发计划带呈现简报")
  assert.match(d1.presentation, /派发简报的目的是和用户对齐认知 gap/, "派发时点反吐 lead/dispatch 规则")
  assert.ok(d1.human.some((text) => text.includes("派单正文直接投递给成员")), "人读通道携带 lead/dispatch 规则全文")
  assert.doesNotMatch(d1.presentation, /## clarity 审阅必读/, "派发时点只带公共必读段")
  assert.doesNotMatch(JSON.stringify(d1.waves), /requiredGuidance/, "成员派单不再投影第二块规则")
  assert.doesNotMatch(d1.waves[0].prompt, /## clarity 公共必读/, "成员卡不含明晰段")

  // 成员 deliver 回执：不是用户汇报点，不注入
  await writeFile(path.join(projectRoot, "REPORT.md"), "# 报告\n覆盖八视角", "utf8")
  const delivered = await call(["deliver", "--task", "present-check", "--key", d1.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "完成八视角审查", "--paths", "REPORT.md"])
  assert.equal(delivered.accepted, true)
  assert.equal(delivered.presentation, undefined, "机械回执不注入呈现规则")

  // challenger accept → expert 裁决 → e2e skip → 人工门卡（用户决定点）
  const d2 = await call(["dispatch-plan", "--task", "present-check"])
  await call(["review", "--task", "present-check", "--key", d2.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "结论可靠"])
  const d3 = await call(["dispatch-plan", "--task", "present-check"])
  await call(["review", "--task", "present-check", "--key", d3.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "裁决", "--verdict", '{"outcome":"accept","rationale":"证据链完整","confidence":"high","recommendedAction":"验收"}'])
  // 路由卡也是用户决定点：同样带完整纪律与阶段工作摘要
  const routeCard = await call(["run", "--task", "present-check"])
  assert.equal(routeCard.next, "route")
  assert.match(routeCard.presentation, /当前要决定什么/, "决定点反吐 lead/decision 规则")
  assert.match(routeCard.progress, /完成八视角审查/)
  await call(["route", "--task", "present-check", "--route", "e2e", "--decision", "skip", "--basis", "审查类任务，无跨系统路径"])
  // 人工门首签归 dispatch 通道；run 只读渲染已签发的待决卡
  const gateSigned = await call(["dispatch-plan", "--task", "present-check"])
  assert.equal(gateSigned.stop, "awaiting-user")
  const gate = await call(["run", "--task", "present-check"])
  assert.equal(gate.status, "awaiting-user")

  // 完整呈现规则（lead/decision）+ 阶段工作摘素材（runtime 推导，不劳 Lead 翻目录）
  assert.match(gate.presentation, /当前要决定什么/)
  assert.match(gate.presentation, /推荐和依据/)
  const required = async (relative) => (await readFile(new URL("../" + relative, import.meta.url), "utf8")).split("<!-- clarity:required:begin -->")[1].split("<!-- clarity:required:end -->")[0]
  const publicRules = await required("skills/clarity-guidance/output-standard.md")
  const reviewRules = await required("skills/clarity-review/references/review-rules.md")
  assert.ok(gate.presentation.includes(publicRules), "公共段原文同源，不沿用旧硬编码副本")
  assert.ok(gate.presentation.includes(reviewRules), "决定点追加专项段原文")
  assert.match(publicRules, /完整句|自然语言|朴实中文/)
  assert.match(publicRules, /批准.*范围|批准什么/)
  assert.match(publicRules, /修订.*改变.*依据.*原结论/)
  assert.match(publicRules, /比较.*批准.*核对真实来源.*缺失.*说明/)
  assert.match(reviewRules, /不能跳过.*人工批准.*指纹重批/)
  for (const header of ["## clarity 公共必读", "## clarity 审阅必读"]) assert.equal(gate.presentation.split(header).length - 1, 1)
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
  assert.match(plan.card.presentation, /当前要决定什么/)
  assert.equal(plan.card.presentation, gate.presentation, "run 与 dispatch 的决定呈现规则一致")
  assert.equal(plan.card.progress, gate.progress)
  for (const flags of [[], ["--json"]]) {
    const { stdout } = await promisify(execFile)(process.execPath, [new URL("../bin/tw.mjs", import.meta.url).pathname, "dispatch-plan", "--task", "present-check", "--project-root", projectRoot, ...flags])
    for (const header of ["## clarity 公共必读", "## clarity 审阅必读"]) assert.equal(stdout.split(header).length - 1, 1, "真实 stdout 每段恰好一次：" + flags.join(" "))
    const actual = JSON.parse(stdout)
    if (flags.length) assert.ok(actual.card.presentation.includes(publicRules))
    else {
      assert.match(actual.card.presentation, /完整呈现规则见 human\[/)
      assert.ok(actual.human.some((text) => text.includes(publicRules) && text.includes(reviewRules)))
    }
  }

  // accept → completed：进展转折卡带轻量提醒（完成由 dispatch 通道落盘）
  await call(["decide", "--task", "present-check", "--choice", "1"])
  const done = await call(["dispatch-plan", "--task", "present-check"])
  assert.equal(done.stop, "completed")
  assert.match(done.card.presentation, /进展汇报的目的是和用户对齐认知 gap/, "进展时点反吐 lead/progress 规则")
  assert.ok(done.human.some((text) => text.includes(publicRules)))
  assert.doesNotMatch(done.card.presentation, /## clarity 审阅必读/)
  const repeated = await call(["run", "--task", "present-check"])
  assert.ok(repeated.presentation.includes(publicRules), "重复终态查询仍带公共规则")
  await call(["archive", "--task", "present-check"])
  const archived = await call(["dispatch-plan", "--task", "present-check"])
  assert.ok(archived.human.some((text) => text.includes(publicRules)), "归档查询仍带规则")
  assert.match(archived.card.presentation, /完整呈现规则见 human\[/, "早返回终态定位人读规则")
})

// ── §7 修订 v2：run 只读矩阵 + dispatch-plan 人读模式 ─────────────────────────

test("run 普通进展：待派发、过门和待收尾均带公共段，整个项目零写入", async () => {
  const snapshot = async (root) => {
    const entries = []
    const visit = async (dir) => {
      for (const name of (await readdir(dir)).sort()) {
        const file = path.join(dir, name)
        const info = await stat(file)
        entries.push([path.relative(root, file), info.mode, info.mtimeMs, info.isDirectory() ? null : await readFile(file, "base64")])
        if (info.isDirectory()) await visit(file)
      }
    }
    await visit(root)
    return entries
  }
  for (const mode of ["pending", "advance", "complete"]) {
    const root = await mkdtemp(path.join(tmpdir(), "tw-run-progress-"))
    await mkdir(path.join(root, "workflow/definitions"), { recursive: true })
    await mkdir(path.join(root, "team-work/policies"), { recursive: true })
    await writeFile(path.join(root, "workflow/definitions/engineering.json"), JSON.stringify({
      stages: [{ id: "research", label: "调研", outputs: [], teamScene: "research" }, { id: "finish", label: "收尾", outputs: [], teamScene: "finish" }],
      gates: [], terminalStages: mode === "complete" ? ["research"] : ["finish"],
      edges: [{ from: "research", to: "finish", outcome: "pass" }],
    }))
    await writeFile(path.join(root, "team-work/policies/default.json"), JSON.stringify({ maxAutonomousRounds: 3, costWeights: { junior: 1, senior: 10, expert: 50 }, roles: { owner: "junior", challenger: "senior", expert: "expert" }, scenes: { research: {}, finish: {} } }))
    const call = autoCaller(root)
    await call(["open", "--name", "progress-check", "--objective", "核验普通进展规则"])
    if (mode !== "pending") {
      const wave = (await call(["dispatch-plan", "--task", "progress-check", "--writable", "none", "--json"])).waves[0]
      assert.equal((await call(["deliver", "--task", "progress-check", "--key", wave.dispatchKey, "--outcome", "delivered", "--summary", "调研完成"])).presentation, undefined)
      const review = (await call(["dispatch-plan", "--task", "progress-check", "--json"])).waves[0]
      assert.equal((await call(["review", "--task", "progress-check", "--key", review.dispatchKey, "--recommendation", "accept", "--summary", "核验通过"])).presentation, undefined)
    }
    const before = await snapshot(root)
    const card = await call(["run", "--task", "progress-check"])
    assert.equal(card.status, "working", mode)
    assert.equal(card.next, "dispatch", mode)
    assert.match(card.note, mode === "pending" ? /有待派发波次/ : mode === "advance" ? /门禁已通过/ : /完成条件已满足/)
    assert.equal(card.presentation.split("## clarity 公共必读").length - 1, 1)
    assert.doesNotMatch(card.presentation, /## clarity 审阅必读/)
    assert.deepEqual(await snapshot(root), before, "读取规范和呈现不写任务事实或目录：" + mode)
    assert.equal((await call(["models"])).presentation, undefined)
  }
})

test("run 只读：待派发/在途各态出指引卡且零写入；--writable 被拒绝", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "tw-run-ro-"))
  const call = autoCaller(projectRoot)
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
  assert.ok(entry.modelRef?.provider, "modelRef 从 journal dispatched 快照回填（历史 modelHint 读取时映射）")
  const status2 = await call(["run", "--task", "ro-check"])
  assert.equal(status2.transition, "wait-inflight")
  assert.equal(status2.inflight[0].registered, false)
  assert.ok(status2.inflight[0].modelRef?.provider)
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
    roles: { owner: "junior", challenger: "senior", expert: "expert" },
    scenes: { "code-review": { core: false } },
  }))
  const call = autoCaller(projectRoot)
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
  const call = autoCaller(projectRoot)
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

// ── 批 D：删除升档审批的反向断言与旧卡收口；批 B/C：意图确认门与换模型确认 ──

import { makeProject, autoCaller, caller, openTask, FIX_WORKFLOW, FIX_POLICY } from "./support/v3-fixtures.mjs"
import { loadTask as fixLoadTask } from "../runtime-v3/store.mjs"

test("删除升档审批反向断言：高于默认档的包直接按包级 ModelRef 派发，不再出 escalation 卡、无权重倍数文案", async () => {
  const root = await makeProject()
  const raw = caller(root)
  await openTask(root, "no-esc-t")
  const planned = await raw(["plan", "--task", "no-esc-t", "--packages", JSON.stringify([
    { id: "hi", writable: ["HI.md:k"], done: ["d"], model: { provider: "vendor-strong", modelName: "model-strong", effort: "max" }, dependsOn: [] },
  ])])
  assert.equal(planned.status, "awaiting-user", "plan 后意图确认卡按新包模型重签")
  assert.equal(planned.intake.packages[0].modelRef.effort, "max")
  assert.equal((await raw(["decide", "--task", "no-esc-t", "--choice", "1"])).ok, true)
  const d = await raw(["dispatch-plan", "--task", "no-esc-t", "--json"])
  assert.equal(d.stop, null)
  assert.deepEqual(d.waves[0].modelRef, { provider: "vendor-strong", modelName: "model-strong", effort: "max" })
  assert.equal(d.waves[0].modelSource, "package")
  assert.equal(Object.hasOwn(d.waves[0], "modelHint"), false, "waves 不再导出 modelHint（宿主映射只看 modelRef）")
  const task = await fixLoadTask(root, "no-esc-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const text = JSON.stringify(task.journal)
  assert.doesNotMatch(text, /escalation|approve-escalation|权重倍数|降回默认档/, "不再签发升档卡或写升档授权字段")
  assert.doesNotMatch(JSON.stringify(d.card), /re-sign-escalation/)
  const run = await raw(["run", "--task", "no-esc-t"])
  assert.doesNotMatch(JSON.stringify(run), /升档审批/)
})

test("旧未决升档卡收口：推进一次自动 decided:superseded 并恢复派发，重复推进幂等", async () => {
  const root = await makeProject()
  const raw = caller(root)
  await openTask(root, "legacy-esc-t")
  const task0 = await fixLoadTask(root, "legacy-esc-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const journalFile = path.join(task0.root, "journal.jsonl")
  const journal = await readFile(journalFile, "utf8")
  const seq = journal.trim().split("\n").length
  await writeFile(journalFile, journal + JSON.stringify({
    seq: seq + 1, at: new Date().toISOString(), type: "decision-issued",
    detail: { decisionId: "esc-legacy", gateId: null, reason: "升档审批：hi→expert（tier 高于场景默认档；权重倍数 junior:senior:expert = 1:10:50）", choices: [{ n: 1, label: "批准升档", grant: "approve-escalation", batchKey: "x" }, { n: 2, label: "降回默认档继续", batchKey: "x" }], escalationFingerprint: "fp", batchKey: "x" },
  }) + "\n")

  const runCard = await raw(["run", "--task", "legacy-esc-t"])
  assert.equal(runCard.status, "awaiting-user")
  assert.equal(runCard.next, "re-sign", "已删除机制的卡只给收口指引，不渲染旧选项")
  const blocked = await raw(["decide", "--task", "legacy-esc-t", "--choice", "1"])
  assert.equal(blocked.ok, false, "旧升档卡不可直答")
  assert.equal(blocked.code, "DECISION_STALE")

  const plan1 = await raw(["dispatch-plan", "--task", "legacy-esc-t", "--writable", "R.md:code-review", "--json"])
  assert.equal(plan1.stop, null, "收口后任务恢复推进")
  const after = await fixLoadTask(root, "legacy-esc-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const settled = after.journal.filter((event) => event.type === "decided" && event.detail.decisionId === "esc-legacy")
  assert.equal(settled.length, 1)
  assert.equal(settled[0].detail.choice, "superseded")
  assert.equal(settled[0].detail.reason, "升档审批机制已删除")

  // 幂等：重复推进不重复收口
  const plan2 = await raw(["dispatch-plan", "--task", "legacy-esc-t"])
  assert.equal(plan2.stop, "wait-inflight")
  const after2 = await fixLoadTask(root, "legacy-esc-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(after2.journal.filter((event) => event.type === "decided" && event.detail.decisionId === "esc-legacy").length, 1)
})

test("意图确认门：open 出卡未确认不派发；确认指纹稳定（不含 decisionId/时间戳）；确认后派发", async () => {
  const root = await makeProject()
  const raw = caller(root)
  const input = ["--objective", "审查示例模块的接口边界", "--entry", "code-review", "--raw-requirement", "原始需求全文不摘要", "--constraint", "约束一", "--exclusion", "排除一", "--acceptance", "验收一", "--gap", JSON.stringify({ question: "范围是否含 B 模块", whyItMatters: "影响工作量和验收", proposedDefault: "只含 A 模块" })]
  const opened = await raw(["open", "--name", "intake-a", ...input])
  assert.equal(opened.ok, true, JSON.stringify(opened))
  assert.equal(opened.status, "awaiting-user")
  assert.equal(opened.next, "decide")
  assert.equal(opened.choices[0].grant, "accept-intake")
  assert.match(opened.question, /原始需求全文不摘要/, "确认卡保留原始需求全文")
  assert.match(opened.question, /角色模型（3 行，恒定显示）/)
  assert.match(opened.question, /已拆包的实际模型/)
  assert.match(opened.question, /范围是否含 B 模块/, "未明确问题作为 gap 呈现")
  assert.deepEqual(opened.intake.roles.map((entry) => entry.role), ["owner", "challenger", "expert"])
  assert.equal(opened.intake.roles[0].effortState, "omitted", "effort 未配置时不补空值")
  assert.equal(opened.intake.roles[2].effortState, "omitted", "该调用快照未给 expert 配置 effort：省略字段而不是空串")

  const early = await raw(["dispatch-plan", "--task", "intake-a", "--writable", "R.md:code-review"])
  assert.equal(early.stop, "awaiting-user", "未确认不派发")
  assert.equal(early.card.decisionId, opened.decisionId, "返回同一张未失效卡（签发幂等）")
  const before = await fixLoadTask(root, "intake-a", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(before.journal.some((event) => event.type === "dispatched"), false, "未确认不写 dispatched 事实")

  // 指纹稳定性：只取 {intent, roles, packages}，不含 decisionId/时间戳——同输入第二个任务指纹相同
  const twin = await raw(["open", "--name", "intake-b", ...input])
  assert.equal(twin.intakeFingerprint, opened.intakeFingerprint, "decisionId/时间戳不参与指纹")

  assert.equal((await raw(["decide", "--task", "intake-a", "--choice", "1"])).ok, true)
  const later = await raw(["run", "--task", "intake-a"])
  assert.notEqual(later.decisionId, opened.decisionId, "确认后不再渲染确认卡")
  const d = await raw(["dispatch-plan", "--task", "intake-a", "--writable", "R.md:code-review", "--json"])
  assert.equal(d.stop, null, "确认后正常派发")
})

test("意图确认门：改 intent 后确认失效并重签；roles 变更也重签；unresolved 时不提供确认开始", async () => {
  const root = await makeProject()
  const raw = caller(root)
  const opened = await raw(["open", "--name", "intake-c", "--objective", "目标", "--entry", "code-review"])
  const changed = await raw(["intent", "--task", "intake-c", "--add-constraint", "新增约束"])
  assert.equal(changed.status, "awaiting-user")
  assert.equal(changed.next, "decide")
  assert.notEqual(changed.intakeFingerprint, opened.intakeFingerprint, "intent 变化使旧确认失效")
  assert.match(changed.question, /新增约束/)
  assert.equal((await raw(["decide", "--task", "intake-c", "--choice", "1"])).ok, true)

  const roles = await raw(["roles", "--task", "intake-c", "--set", "challenger=tier:expert@max"])
  assert.equal(roles.status, "awaiting-user")
  assert.equal(roles.next, "decide")
  assert.equal(roles.roles.challenger.effort, "max", "显式 @max 保存为合法枚举")
  assert.equal(roles.intake.roles.find((entry) => entry.role === "challenger").tierProvenance, "tw roles --set tier:expert@max")
  const again = await raw(["dispatch-plan", "--task", "intake-c", "--writable", "R.md:code-review"])
  assert.equal(again.stop, "awaiting-user", "roles 变更后未确认不派发")

  // unresolved：缺配置的角色不提供"确认开始"
  const broken = await makeProject()
  process.env.TW_DSH_CONFIG = JSON.stringify({ entryId: "team-work-dsh", profile: "p", tiers: { junior: { provider: "j", model: "mj" } } })
  try {
    const card = await caller(broken)(["open", "--name", "intake-u", "--objective", "o", "--entry", "code-review"])
    assert.equal(card.status, "awaiting-user")
    assert.equal(card.code, "INTAKE_ROLES_UNRESOLVED")
    assert.equal(card.choices.some((choice) => choice.grant === "accept-intake"), false, "unresolved 时不提供确认开始")
    assert.equal(card.choices[0].grant, "revise-intake")
    const blocked = await caller(broken)(["decide", "--task", "intake-u", "--choice", "1"])
    assert.equal(blocked.ok, true, "选项 1 是「我先修改」，不落盘确认")
    assert.match(blocked.note, /重签/)
  } finally {
    process.env.TW_DSH_CONFIG = JSON.stringify({
      entryId: "team-work-dsh", profile: "fixture-profile",
      tiers: { junior: { provider: "cli-junior", model: "cli-junior" }, senior: { provider: "cli-senior", model: "cli-senior" }, expert: { provider: "cli-expert", model: "cli-expert" } },
    })
  }
})

test("包级 ModelRef 物化：显式 model / tier 语法糖 / 复用 roles.owner；tier+model 冲突与缺档拒绝", async () => {
  const root = await makeProject()
  const raw = caller(root)
  await openTask(root, "plan-model-t")
  const explicit = await raw(["plan", "--task", "plan-model-t", "--packages", JSON.stringify([
    { id: "a", writable: ["A.md:k"], done: ["d"], model: { provider: "vendor-a", modelName: "model-a" }, dependsOn: [] },
  ])])
  assert.equal(explicit.packages[0].model.provider, "vendor-a")
  await raw(["decide", "--task", "plan-model-t", "--choice", "1"])
  const sugared = await raw(["plan", "--task", "plan-model-t", "--packages", JSON.stringify([
    { id: "a", writable: ["A.md:k"], done: ["d"], model: { provider: "vendor-a", modelName: "model-a" }, dependsOn: [] },
    { id: "b", writable: ["B.md:k"], done: ["d"], tier: "expert", dependsOn: [] },
    { id: "c", writable: ["C.md:k"], done: ["d"], dependsOn: [] },
  ])])
  const byId = Object.fromEntries(sugared.packages.map((pkg) => [pkg.id, pkg.model]))
  assert.equal(byId.b.provider, "cli-expert", "tier 语法糖在 plan 期解析成 ModelRef")
  assert.equal(byId.c.provider, "cli-junior", "未给模型时复用 roles.owner")
  const task = await fixLoadTask(root, "plan-model-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const persisted = JSON.parse(await readFile(path.join(task.root, "packages.json"), "utf8")).items
  assert.equal(persisted.every((pkg) => pkg.model && pkg.tier === undefined), true, "落盘只有 ModelRef，不再持久化 tier")
  const conflict = await raw(["plan", "--task", "plan-model-t", "--packages", JSON.stringify([
    { id: "a", writable: ["A.md:k"], done: ["d"], tier: "senior", model: { provider: "x", modelName: "y" }, dependsOn: [] },
  ])])
  assert.equal(conflict.ok, false)
  assert.equal(conflict.code, "PLAN_REJECTED")
  assert.match(conflict.message, /不能同时给 model 与 tier/)
  // 落盘与派发导出一致：两包不同模型按各自 ModelRef 派发。
  await raw(["decide", "--task", "plan-model-t", "--choice", "1"])
  const dispatched = await raw(["dispatch-plan", "--task", "plan-model-t", "--json"])
  assert.equal(dispatched.stop, null)
  const waveRefs = Object.fromEntries(dispatched.waves.map((wave) => [wave.package, wave.modelRef]))
  assert.deepEqual(waveRefs.a, { provider: "vendor-a", modelName: "model-a" })
  assert.deepEqual({ ...waveRefs.b, family: undefined }, { provider: "cli-expert", modelName: "cli-expert", family: undefined })
  assert.equal(dispatched.waves.every((wave) => wave.modelSource === "package"), true)
})

test("tw roles：只读/--set/--resolve/--clear；已有会话换模型出确认卡，选保留后不再重复出卡", async () => {
  const root = await makeProject()
  const call = autoCaller(root)
  await openTask(root, "roles-t")
  const read = await call(["roles", "--task", "roles-t"])
  assert.equal(read.unresolved.length, 0)
  assert.equal(read.roles.owner.modelName, "cli-junior")
  assert.equal(read.effortState.owner, "omitted")

  // 单 owner 任务（无包）：首波派发 + 登记会话映射 → 交付 + 评审 rework → respond 续派
  const first = await call(["dispatch-plan", "--task", "roles-t", "--writable", "R.md:code-review"])
  const firstKey = first.waves[0].dispatchKey
  assert.equal(first.waves[0].modelRef.modelName, "cli-junior")
  await call(["agent-map", "--task", "roles-t", "--key", firstKey, "--agent", "child-roles"])
  await writeFile(path.join(root, "R.md"), "v1", "utf8")
  await call(["deliver", "--task", "roles-t", "--key", firstKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  const review = await call(["dispatch-plan", "--task", "roles-t"])
  await call(["review", "--task", "roles-t", "--key", review.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "重做"])

  // 改 owner 模型（tier 语法糖）：确认卡重签由 autoCaller 确认；下一轮续派检测到模型差异 → 换模型卡
  const set = await call(["roles", "--task", "roles-t", "--set", "owner=tier:senior"])
  assert.equal(set.ok, true)
  assert.equal(set.roles.owner.modelName, "cli-senior")
  const fresh = await call(["dispatch-plan", "--task", "roles-t", "--writable", "R.md:code-review"])
  assert.equal(fresh.stop, "awaiting-user", "已有会话换模型必须显式确认")
  assert.equal(fresh.card.requiresFreshSession.role, "owner")
  assert.equal(fresh.card.requiresFreshSession.sessionId, "child-roles")
  assert.equal(fresh.card.requiresFreshSession.fromModelRef.modelName, "cli-junior")
  assert.equal(fresh.card.requiresFreshSession.toModelRef.modelName, "cli-senior")
  assert.deepEqual(fresh.card.choices.map((choice) => choice.grant), ["keep-session", "retire-and-recreate", "rollback-model"])

  // 选 1 保留原会话：后续按旧模型固化，不再重复出卡
  assert.equal((await call(["decide", "--task", "roles-t", "--choice", "1"])).ok, true)
  const kept = await call(["dispatch-plan", "--task", "roles-t", "--writable", "R.md:code-review", "--json"])
  assert.equal(kept.stop, null)
  assert.equal(kept.waves[0].modelRef.modelName, "cli-junior", "保留会话 = 按 keptModelRef 继续")
  assert.equal(kept.waves[0].expectedAgentId, "child-roles")
  const repeat = await call(["run", "--task", "roles-t"])
  assert.equal(repeat.next, "wait", "在途等待，不再出卡")
})

test("换模型选 2：写 session-reset 作废旧映射、重开会话用新模型（全新上下文）", async () => {
  const root = await makeProject()
  const call = autoCaller(root)
  await openTask(root, "fresh-t")
  const first = await call(["dispatch-plan", "--task", "fresh-t", "--writable", "R.md:code-review"])
  const firstKey = first.waves[0].dispatchKey
  await call(["agent-map", "--task", "fresh-t", "--key", firstKey, "--agent", "child-fresh"])
  await writeFile(path.join(root, "R.md"), "v1", "utf8")
  await call(["deliver", "--task", "fresh-t", "--key", firstKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  const review = await call(["dispatch-plan", "--task", "fresh-t"])
  await call(["review", "--task", "fresh-t", "--key", review.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "重做"])
  await call(["roles", "--task", "fresh-t", "--set", "owner=tier:expert"])
  const fresh = await call(["dispatch-plan", "--task", "fresh-t", "--writable", "R.md:code-review"])
  assert.equal(fresh.card.requiresFreshSession.sessionId, "child-fresh")
  assert.equal((await call(["decide", "--task", "fresh-t", "--choice", "2"])).ok, true)
  const resetTask = await fixLoadTask(root, "fresh-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const resets = resetTask.journal.filter((event) => event.type === "session-reset")
  assert.equal(resets.length, 1)
  assert.equal(resets[0].detail.role, "owner")
  assert.equal(resets[0].detail.fromModelRef.modelName, "cli-junior")
  assert.equal(resets[0].detail.toModelRef.modelName, "cli-expert")
  const rebuilt = await call(["dispatch-plan", "--task", "fresh-t", "--writable", "R.md:code-review", "--json"])
  assert.equal(rebuilt.stop, null)
  assert.equal(rebuilt.waves[0].modelRef.modelName, "cli-expert", "重开会话用新模型")
  assert.equal(rebuilt.waves[0].expectedAgentId, undefined, "session-reset 边界前映射一律忽略（不续旧会话）")
  assert.equal(rebuilt.waves[0].expectedAgentIdMissing, true, "强制新建会话并投全量变体")
  // 幂等：reset 后另一个推进只进入在途等待，不重复写 session-reset。
  const repeat = await call(["dispatch-plan", "--task", "fresh-t", "--json"])
  assert.equal(repeat.stop, "wait-inflight")
  const repeatTask = await fixLoadTask(root, "fresh-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(repeatTask.journal.filter((event) => event.type === "session-reset").length, 1, "session-reset 幂等：重复推进不重复写")
})

// ── 返工终版 §二·D：run 无锁只读快照 ─────────────────────────────────────────────

test("run 无锁只读：锁目录只读时照常返回状态卡、盘上零变化（含锁文件）；卡面标注 journal seq", async () => {
  const root = await makeProject()
  const call = autoCaller(root)
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

test("dispatch-plan 导出 promptFull：续派与在途重建的两种正文各含一次当前验收基线", async () => {
  const root = await makeProject()
  const call = autoCaller(root)
  await openTask(root, "pfull-t", { objective: "修复判定链并补全测试" })
  await call(["intent", "--task", "pfull-t", "--add-constraint", "不改无关文件", "--add-exclusion", "不碰 v2"])
  const seeded = await call(["dispatch-plan", "--task", "pfull-t", "--writable", "R.md:doc"])
  await (await import("node:fs/promises")).writeFile(path.join(root, "R.md"), "# 初版", "utf8")
  await call(["deliver", "--task", "pfull-t", "--key", seeded.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  const review1 = await call(["dispatch-plan", "--task", "pfull-t"])
  await call(["review", "--task", "pfull-t", "--key", review1.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "重做"])
  await call(["intent", "--task", "pfull-t", "--objective", "修复判定链并验证恢复", "--add-constraint", "保留恢复协议"])
  // respond 波 = 续派（continuation: true，成员有原上下文）
  const respond = await call(["dispatch-plan", "--task", "pfull-t", "--json", "--writable", "R.md:doc"])
  assert.equal(respond.stop, null)
  const wave = respond.waves[0]
  assert.equal(wave.continuation, true)
  assert.ok(wave.promptFull, "续派派单附全量变体")
  for (const prompt of [wave.prompt, wave.promptFull]) {
    for (const fact of ["修复判定链并验证恢复", "不改无关文件", "保留恢复协议", "不碰 v2"]) {
      assert.equal(prompt.split(fact).length - 1, 1, "当前基线事实恰好出现一次：" + fact)
    }
    assert.doesNotMatch(prompt, /修复判定链并补全测试/, "修订后的基线不保留旧目标")
    assert.doesNotMatch(prompt, /^本包完成标准：|^各包完成标准（/m, "无包任务不臆造 done")
  }
  assert.match(wave.promptFull, /全量变体/)

  // wait-inflight 重建（inflight 条目）同样携带 promptFull：断链 fresh 重建的恢复边数据源
  const inflightCard = await call(["run", "--task", "pfull-t"])
  assert.equal(inflightCard.transition, "wait-inflight")
  const entry = inflightCard.inflight.find((d) => d.key === wave.dispatchKey)
  assert.ok(entry, "在途条目在场")
  assert.equal(entry.prompt, wave.prompt)
  assert.equal(entry.promptFull, wave.promptFull, "在途重建保留两种正文与恢复选择")
})

// ── 返工终版 §二·E 补：快照损坏容错（用户终裁①，Challenger r5 死门封堵） ─────────────

test("快照损坏不构成死门：rebuildArtifacts 按缺失降级进 degraded（含处置建议），run/gate/deliver 全链照常", async () => {
  const root = await makeProject()
  const call = autoCaller(root)
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
  const call = autoCaller(root)
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
  const call2 = autoCaller(root2)
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
  const call = autoCaller(projectRoot)
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


// init 的用户公共规则释放：与技能目录装载独立，按文件摘要增量同步并保护用户修改。
const USER_RULES_SOURCE = new URL("../team-work/rules/", import.meta.url)
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex")
const exists = (file) => access(file).then(() => true, () => false)

test("init 增量释放用户公共规则：缺失补齐、未改默认静默升版、已改文件保留并写 .default.md 旁路", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "tw-init-rules-"))
  const userRulesRoot = await mkdtemp(path.join(tmpdir(), "tw-user-rules-"))
  const call = (argv) => tw(argv, { projectRoot, userRulesRoot })
  const sourceFile = (relative) => path.join(USER_RULES_SOURCE.pathname, ...relative.split("/"))
  const userFile = (relative) => path.join(userRulesRoot, ...relative.split("/"))

  // ① 首次释放：缺失文件直接写入，摘要记录落盘
  const first = await call(["init"])
  assert.equal(first.ok, true)
  assert.equal(first.rules.action, "synced")
  assert.equal(first.rules.root, userRulesRoot)
  assert.ok(first.rules.summary.installed > 0, "首次释放补齐出厂模板：" + JSON.stringify(first.rules.summary))
  const indexText = await readFile(sourceFile("common/index.md"), "utf8")
  assert.equal(await readFile(userFile("common/index.md"), "utf8"), indexText, "文件内容与出厂模板一致")
  assert.ok(await exists(path.join(userRulesRoot, ".tw-init-hashes.json")), "安装摘要写入用户规则根")
  const hashes = JSON.parse(await readFile(path.join(userRulesRoot, ".tw-init-hashes.json"), "utf8"))
  assert.equal(hashes.files["common/index.md"], sha256(indexText), "摘要记录出厂内容 hash")

  // ② 再次释放：全部与出厂同名同内容，没有写入动作
  const second = await call(["init"])
  assert.equal(second.rules.action, "synced")
  assert.equal(second.rules.summary.installed, 0)
  assert.equal(second.rules.summary.updated, 0)
  assert.equal(second.rules.summary.kept, 0)
  assert.ok(second.rules.summary.unchanged > 0)

  // ③ 用户改过的文件保留原样，新版默认写成同目录旁路；--force 同样不覆盖用户版本
  await writeFile(userFile("common/index.md"), "## 规范\n\n- 用户自己的通用规则\n", "utf8")
  for (const force of [false, true]) {
    const run = await call(force ? ["init", "--force"] : ["init"])
    assert.equal(run.rules.summary.kept, 1, "用户改过的文件只报保留一次（force=" + force + "）")
    assert.equal(await readFile(userFile("common/index.md"), "utf8"), "## 规范\n\n- 用户自己的通用规则\n", "用户版本不被覆盖（force=" + force + "）")
    assert.equal(await readFile(userFile("common/index.default.md"), "utf8"), indexText, "新版默认写旁路供对照合并（force=" + force + "）")
  }

  // ④ 用户没改过的旧版默认（与上次释放摘要一致）静默升版为新版出厂内容
  const stalePath = userFile("lead/progress/index.md")
  await writeFile(stalePath, "旧版默认正文", "utf8")
  const staleHashes = JSON.parse(await readFile(path.join(userRulesRoot, ".tw-init-hashes.json"), "utf8"))
  staleHashes.files["lead/progress/index.md"] = sha256("旧版默认正文")
  await writeFile(path.join(userRulesRoot, ".tw-init-hashes.json"), JSON.stringify(staleHashes, null, 2) + "\n", "utf8")
  const updated = await call(["init"])
  assert.equal(updated.rules.summary.updated, 1)
  assert.equal(await readFile(stalePath, "utf8"), await readFile(sourceFile("lead/progress/index.md"), "utf8"), "未改过的旧默认升级为新版出厂内容")
  assert.equal(await exists(path.join(userRulesRoot, "lead/progress/index.default.md")), false, "升版不写旁路")
})

test("init 用户公共规则：测试进程未显式指定目录时不写主目录；出厂模板缺失不阻塞技能装载", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "tw-init-rules-skip-"))
  const skipped = await tw(["init"], { projectRoot })
  assert.equal(skipped.rules.action, "skipped")
  assert.match(skipped.rules.note, /NODE_TEST_CONTEXT/, "测试进程默认不写用户主目录")
  assert.equal(skipped.ok, true)

  // 隔离包根缺少 team-work/rules：规则项单独报不可用，技能目录照常逐项处理
  const packageRoot = await mkdtemp(path.join(tmpdir(), "tw-init-rules-missing-"))
  for (const folder of ["runtime-v3", "policy", "skills"]) {
    await cp(new URL("../" + folder, import.meta.url), path.join(packageRoot, folder), { recursive: true })
  }
  const { pathToFileURL } = await import("node:url")
  const { tw: isolatedTw } = await import(pathToFileURL(path.join(packageRoot, "runtime-v3/cli.mjs")))
  const userRulesRoot = await mkdtemp(path.join(tmpdir(), "tw-user-rules-missing-"))
  const isolatedProject = await mkdtemp(path.join(tmpdir(), "tw-init-rules-missing-project-"))
  const result = await isolatedTw(["init"], { projectRoot: isolatedProject, userRulesRoot })
  assert.equal(result.rules.action, "unavailable")
  assert.match(result.rules.note, /出厂规则模板不可用/)
  assert.equal(Object.hasOwn(result.rules, "root"), false, "源缺失时不声称已释放")
  for (const key of ["skill", "writingSkill", "reviewSkill", "outputStandard"]) assert.equal(result[key].action, "installed", key + " 不受规则释放失败影响")
})

test("ModelRef 校验：缺字段/未知字段/effort 空串或 none 拒绝；缺省不补空值", async () => {
  const root = await makeProject()
  const raw = caller(root)
  await openTask(root, "mr-t")
  for (const model of [
    { provider: "vendor-a" },
    { provider: "vendor-a", modelName: "" },
    { provider: "vendor-a", modelName: "model-a", extra: true },
    { provider: "vendor-a", modelName: "model-a", effort: "" },
    { provider: "vendor-a", modelName: "model-a", effort: "none" },
  ]) {
    const result = await raw(["plan", "--task", "mr-t", "--packages", JSON.stringify([{ id: "a", writable: ["A.md:k"], done: ["d"], model, dependsOn: [] }])])
    assert.equal(result.ok, false, JSON.stringify(model))
    assert.equal(result.code, "PLAN_REJECTED")
    assert.match(result.message, /model 不合法/)
  }
  for (const value of ["owner=vendor-a/model-a@none", "owner=vendor-a/model-a@"]) {
    const rejected = await raw(["roles", "--task", "mr-t", "--set", value])
    assert.equal(rejected.ok, false, value)
    assert.equal(rejected.code, "MODEL_REF_INVALID")
  }
  const good = await raw(["roles", "--task", "mr-t", "--set", "owner=vendor-a/model-a"])
  assert.equal(good.ok, true)
  const read = await raw(["roles", "--task", "mr-t"])
  assert.equal(Object.hasOwn(read.roles.owner, "effort"), false, "不设置推理强度 = 省略字段（不补空串）")
})

test("旧 packages.json 的 tier 首次推进物化：按当前快照解析成 ModelRef，journal 记 packages-model-materialized", async () => {
  const root = await makeProject()
  const raw = caller(root)
  await openTask(root, "legacy-tier-t")
  const task = await fixLoadTask(root, "legacy-tier-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  await writeFile(path.join(task.root, "packages.json"), JSON.stringify({ items: [
    { id: "a", tier: "senior", writable: ["A.md:k"], done: ["d"], dependsOn: [] },
  ] }))
  const first = await raw(["dispatch-plan", "--task", "legacy-tier-t"])
  assert.equal(first.stop, "awaiting-user", "包模型出现 → 意图确认卡按逐包模型重签")
  assert.equal(first.card.intake.packages[0].modelRef.modelName, "cli-senior", "旧 tier 在确认前已物化")
  await raw(["decide", "--task", "legacy-tier-t", "--choice", "1"])
  const d = await raw(["dispatch-plan", "--task", "legacy-tier-t", "--json"])
  assert.equal(d.stop, null)
  assert.equal(d.waves[0].modelRef.modelName, "cli-senior", "物化不换模型")
  const after = await fixLoadTask(root, "legacy-tier-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(after.journal.filter((event) => event.type === "packages-model-materialized").length, 1)
  const persisted = JSON.parse(await readFile(path.join(task.root, "packages.json"), "utf8")).items
  assert.equal(persisted[0].tier, undefined, "旧 tier 字段在物化后移除")
  assert.equal(persisted[0].model.modelName, "cli-senior")
})

test("换模型选 3：回滚 roles 到首派模型并重签确认卡", async () => {
  const root = await makeProject()
  const call = autoCaller(root)
  await openTask(root, "rollback-t")
  const first = await call(["dispatch-plan", "--task", "rollback-t", "--writable", "R.md:code-review"])
  const firstKey = first.waves[0].dispatchKey
  await call(["agent-map", "--task", "rollback-t", "--key", firstKey, "--agent", "child-rollback"])
  await writeFile(path.join(root, "R.md"), "v1", "utf8")
  await call(["deliver", "--task", "rollback-t", "--key", firstKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  const review = await call(["dispatch-plan", "--task", "rollback-t"])
  await call(["review", "--task", "rollback-t", "--key", review.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "重做"])
  await call(["roles", "--task", "rollback-t", "--set", "owner=tier:expert"])
  const fresh = await call(["dispatch-plan", "--task", "rollback-t", "--writable", "R.md:code-review"])
  assert.equal(fresh.card.requiresFreshSession.toModelRef.modelName, "cli-expert")
  assert.equal((await call(["decide", "--task", "rollback-t", "--choice", "3"])).ok, true)
  const roles = await call(["roles", "--task", "rollback-t"])
  assert.equal(roles.roles.owner.modelName, "cli-junior", "roles 回滚到首派模型")
  const after = await fixLoadTask(root, "rollback-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(after.journal.filter((event) => event.type === "role-models-changed" && event.detail.changes?.some((change) => change.role === "owner" && change.reason?.includes("回滚"))).length, 1)
  // 回滚使确认指纹回到旧 roles：计划按 §3.6 重签确认卡，用户确认后恢复续派。
  const resign = await call(["dispatch-plan", "--task", "rollback-t", "--writable", "R.md:code-review"])
  assert.equal(resign.stop, "awaiting-user", "回滚后重签意图确认卡")
  assert.equal(resign.card.intake.roles.find((entry) => entry.role === "owner").modelRef.modelName, "cli-junior")
  assert.equal((await call(["decide", "--task", "rollback-t", "--choice", "1"])).ok, true)
  const resumed = await call(["dispatch-plan", "--task", "rollback-t", "--writable", "R.md:code-review", "--json"])
  assert.equal(resumed.stop, null)
  assert.equal(resumed.waves[0].modelRef.modelName, "cli-junior", "回滚后按旧模型续派")
})

test("intent 扩展字段：范围/验收进入派单基线；gap 答复可结构化落到 intent.json", async () => {
  const root = await makeProject()
  const raw = caller(root)
  const opened = await raw(["open", "--name", "scope-t", "--objective", "目标", "--entry", "code-review",
    "--scope-note", "只覆盖 A 模块", "--acceptance", "验收一",
    "--gap", JSON.stringify({ id: "g1", question: "是否含 B 模块", whyItMatters: "影响范围", proposedDefault: "不含" })])
  assert.equal(opened.ok, true)
  assert.equal(opened.intake.scope.notes[0], "只覆盖 A 模块")
  assert.match(opened.question, /范围补充：\n- 只覆盖 A 模块/, "确认卡展示范围补充")
  assert.equal(opened.intake.acceptance[0], "验收一")
  assert.match(opened.question, /验收：\n- 验收一/, "确认卡展示验收项")
  await raw(["decide", "--task", "scope-t", "--choice", "1"])
  const d = await raw(["dispatch-plan", "--task", "scope-t", "--writable", "R.md:code-review", "--json"])
  assert.equal(d.stop, null)
  const prompt = d.waves[0].prompt
  assert.match(prompt, /范围（intent\.scope）/, "派单基线带范围")
  assert.match(prompt, /只覆盖 A 模块/)
  assert.match(prompt, /验收（intent\.acceptance）/, "派单基线带验收")
  const answered = await raw(["intent", "--task", "scope-t", "--answer-gap", "g1", "--answer", "不含 B 模块"])
  assert.equal(answered.ok, true)
  const intent = JSON.parse(await readFile(path.join(root, ".team-work", "tasks", "scope-t", "intent.json"), "utf8"))
  assert.equal(intent.gaps.find((gap) => gap.id === "g1")?.answer, "不含 B 模块")
})


test("tw plan 重拆窗口：意图确认卡期间放行并自动重签；其他 awaiting-user 卡仍拒绝", async () => {
  const root = await makeProject()
  const raw = caller(root)
  const opened = await raw(["open", "--name", "plan-window", "--objective", "o", "--entry", "code-review"])
  const planned = await raw(["plan", "--task", "plan-window", "--packages", JSON.stringify([{ id: "a", writable: ["A.md:k"], done: ["d"], dependsOn: [] }])])
  assert.equal(planned.status, "awaiting-user", "确认卡期间允许拆包")
  assert.notEqual(planned.decisionId, opened.decisionId, "拆包后按新包模型重签确认卡")
  assert.equal(planned.intake.packages.length, 1)
  // 其他类型的待决卡仍禁止重拆（避免改包配置与人工门答案错位）。
  await raw(["decide", "--task", "plan-window", "--choice", "1"])
  const task = await fixLoadTask(root, "plan-window", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const journalFile = path.join(task.root, "journal.jsonl")
  const journal = await readFile(journalFile, "utf8")
  const seq = journal.trim().split("\n").length
  await writeFile(journalFile, journal + JSON.stringify({ seq: seq + 1, at: new Date().toISOString(), type: "decision-issued", detail: { decisionId: "gate-x", gateId: null, reason: "某待决卡", choices: [{ n: 1, label: "继续" }] } }) + "\n")
  const rejected = await raw(["plan", "--task", "plan-window", "--packages", JSON.stringify([{ id: "b", writable: ["B.md:k"], done: ["d"], dependsOn: [] }])])
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, "PLAN_REJECTED")
  assert.match(rejected.message, /有待决用户卡片/)
})

test("tw roles --clear 与 --resolve：清除角色后按当前快照重建", async () => {
  const root = await makeProject()
  const call = autoCaller(root)
  await openTask(root, "roles-clear-t")
  const cleared = await call(["roles", "--task", "roles-clear-t", "--clear", "challenger"])
  assert.equal(cleared.ok, true)
  const read = await call(["roles", "--task", "roles-clear-t"])
  assert.equal(read.roles.challenger, undefined)
  assert.deepEqual(read.unresolved, ["challenger"])
  const resolved = await call(["roles", "--task", "roles-clear-t", "--resolve"])
  assert.equal(resolved.roles.challenger.modelName, "cli-senior")
  assert.deepEqual(resolved.unresolved, [])
})

test("tw gate 只读提示意图确认状态（不改写任务事实）", async () => {
  const root = await makeProject()
  const raw = caller(root)
  await raw(["open", "--name", "gate-intake", "--objective", "o", "--entry", "code-review"])
  const before = await readFile(path.join(root, ".team-work/tasks/gate-intake/journal.jsonl"), "utf8")
  const gate1 = await raw(["gate", "--task", "gate-intake"])
  assert.equal(gate1.intake.issued, true)
  assert.equal(gate1.intake.confirmed, false)
  assert.equal(await readFile(path.join(root, ".team-work/tasks/gate-intake/journal.jsonl"), "utf8"), before, "gate 只读零写入")
  await raw(["decide", "--task", "gate-intake", "--choice", "1"])
  const gate2 = await raw(["gate", "--task", "gate-intake"])
  assert.equal(gate2.intake.confirmed, true)
})


test("包级模型变更：续派出换模型卡（target=package），回滚恢复 packages[].model 后按旧模型续派", async () => {
  const root = await makeProject()
  const call = autoCaller(root)
  await openTask(root, "pkg-fresh-t")
  const planned = await call(["plan", "--task", "pkg-fresh-t", "--packages", JSON.stringify([{ id: "core", writable: ["C.md:k"], done: ["d"], dependsOn: [] }])])
  assert.equal(planned.ok, true)
  const first = await call(["dispatch-plan", "--task", "pkg-fresh-t"])
  const firstKey = first.waves[0].dispatchKey
  assert.equal(first.waves[0].modelRef.modelName, "cli-junior", "无显式 model 的包复用 roles.owner")
  await call(["agent-map", "--task", "pkg-fresh-t", "--key", firstKey, "--agent", "child-pkg"])
  await writeFile(path.join(root, "C.md"), "v1", "utf8")
  await call(["deliver", "--task", "pkg-fresh-t", "--key", firstKey, "--outcome", "delivered", "--summary", "s", "--paths", "C.md"])
  const review = await call(["dispatch-plan", "--task", "pkg-fresh-t"])
  await call(["review", "--task", "pkg-fresh-t", "--key", review.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "重做"])
  // 包模型改为显式更强模型（续派已有会话 → 出换模型卡）
  const replanned = await call(["plan", "--task", "pkg-fresh-t", "--packages", JSON.stringify([{ id: "core", writable: ["C.md:k"], done: ["d"], model: { provider: "vendor-new", modelName: "model-new" }, dependsOn: [] }])])
  assert.equal(replanned.ok, true)
  const fresh = await call(["dispatch-plan", "--task", "pkg-fresh-t"])
  assert.equal(fresh.stop, "awaiting-user")
  assert.equal(fresh.card.requiresFreshSession.target, "package")
  assert.equal(fresh.card.requiresFreshSession.package, "core")
  assert.equal(fresh.card.requiresFreshSession.fromModelRef.modelName, "cli-junior")
  assert.equal(fresh.card.requiresFreshSession.toModelRef.modelName, "model-new")
  assert.equal(fresh.card.choices[2].label, "回滚包模型到旧值")
  assert.equal((await call(["decide", "--task", "pkg-fresh-t", "--choice", "3"])).ok, true)
  const task = await fixLoadTask(root, "pkg-fresh-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const persisted = JSON.parse(await readFile(path.join(task.root, "packages.json"), "utf8")).items
  assert.equal(persisted[0].model.modelName, "cli-junior", "包模型回滚到首派模型")
  assert.ok(task.journal.some((event) => event.type === "re-planned" && event.detail.source === "fresh-session-rollback"))
  // 回滚改变包模型 → 确认指纹回到旧配置：重签确认卡，用户确认后按旧模型续派。
  const resign = await call(["dispatch-plan", "--task", "pkg-fresh-t"])
  assert.equal(resign.stop, "awaiting-user")
  assert.equal(resign.card.intake.packages[0].modelRef.modelName, "cli-junior")
  assert.equal((await call(["decide", "--task", "pkg-fresh-t", "--choice", "1"])).ok, true)
  const resumed = await call(["dispatch-plan", "--task", "pkg-fresh-t", "--json"])
  assert.equal(resumed.stop, null)
  assert.equal(resumed.waves[0].modelRef.modelName, "cli-junior")
})

test("换模型选 2（包级）：写 session-reset 后新会话用新包模型", async () => {
  const root = await makeProject()
  const call = autoCaller(root)
  await openTask(root, "pkg-reset-t")
  await call(["plan", "--task", "pkg-reset-t", "--packages", JSON.stringify([{ id: "core", writable: ["C.md:k"], done: ["d"], dependsOn: [] }])])
  const first = await call(["dispatch-plan", "--task", "pkg-reset-t"])
  const firstKey = first.waves[0].dispatchKey
  await call(["agent-map", "--task", "pkg-reset-t", "--key", firstKey, "--agent", "child-pkg-reset"])
  await writeFile(path.join(root, "C.md"), "v1", "utf8")
  await call(["deliver", "--task", "pkg-reset-t", "--key", firstKey, "--outcome", "delivered", "--summary", "s", "--paths", "C.md"])
  const review = await call(["dispatch-plan", "--task", "pkg-reset-t"])
  await call(["review", "--task", "pkg-reset-t", "--key", review.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "重做"])
  await call(["plan", "--task", "pkg-reset-t", "--packages", JSON.stringify([{ id: "core", writable: ["C.md:k"], done: ["d"], model: { provider: "vendor-new", modelName: "model-new" }, dependsOn: [] }])])
  const fresh = await call(["dispatch-plan", "--task", "pkg-reset-t"])
  assert.equal(fresh.card.requiresFreshSession.target, "package")
  assert.equal((await call(["decide", "--task", "pkg-reset-t", "--choice", "2"])).ok, true)
  const task = await fixLoadTask(root, "pkg-reset-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const reset = task.journal.find((event) => event.type === "session-reset")
  assert.equal(reset.detail.package, "core")
  assert.equal(reset.detail.toModelRef.modelName, "model-new")
  const rebuilt = await call(["dispatch-plan", "--task", "pkg-reset-t", "--json"])
  assert.equal(rebuilt.stop, null)
  assert.equal(rebuilt.waves[0].modelRef.modelName, "model-new")
  assert.equal(rebuilt.waves[0].expectedAgentIdMissing, true, "reset 边界后不续旧会话")
})

test("E1：重开会话 B 后的续派基线是 B 首派模型；B→C 也按 B 比较，不重复出卡", async () => {
  const root = await makeProject()
  const call = autoCaller(root)
  await openTask(root, "b-baseline-t")
  const first = await call(["dispatch-plan", "--task", "b-baseline-t", "--writable", "R.md:code-review"])
  const k1 = first.waves[0].dispatchKey
  await call(["agent-map", "--task", "b-baseline-t", "--key", k1, "--agent", "child-A"])
  await writeFile(path.join(root, "R.md"), "v1", "utf8")
  await call(["deliver", "--task", "b-baseline-t", "--key", k1, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  const rv = await call(["dispatch-plan", "--task", "b-baseline-t"])
  await call(["review", "--task", "b-baseline-t", "--key", rv.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "重做"])

  // A 会话（junior）→ 改 expert 出卡 → 选 2 重开 B（expert）
  await call(["roles", "--task", "b-baseline-t", "--set", "owner=tier:expert"])
  const freshA = await call(["dispatch-plan", "--task", "b-baseline-t", "--writable", "R.md:code-review"])
  assert.equal(freshA.card.requiresFreshSession.fromModelRef.modelName, "cli-junior")
  assert.equal((await call(["decide", "--task", "b-baseline-t", "--choice", "2"])).ok, true)
  const waveB = await call(["dispatch-plan", "--task", "b-baseline-t", "--json", "--writable", "R.md:code-review"])
  assert.equal(waveB.stop, null, JSON.stringify(waveB).slice(0, 600))
  assert.equal(waveB.waves[0].modelRef.modelName, "cli-expert")
  const kB = waveB.waves[0].dispatchKey
  await call(["agent-map", "--task", "b-baseline-t", "--key", kB, "--agent", "child-B"])

  // B 交付 + rework：配置没变 → 续派必须按 B 首派 expert 比较，不能再拿 A 的 junior 重复出卡
  await writeFile(path.join(root, "R.md"), "v2", "utf8")
  await call(["deliver", "--task", "b-baseline-t", "--key", kB, "--outcome", "delivered", "--summary", "s2", "--paths", "R.md"])
  const rvB = await call(["dispatch-plan", "--task", "b-baseline-t"])
  await call(["review", "--task", "b-baseline-t", "--key", rvB.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "再重做"])
  const contB = await call(["dispatch-plan", "--task", "b-baseline-t", "--json", "--writable", "R.md:code-review"])
  assert.equal(contB.stop, null, "B 会话按自身首派模型比较，不重复出卡")
  assert.equal(contB.waves[0].modelRef.modelName, "cli-expert")
  assert.equal(contB.waves[0].expectedAgentId, "child-B")

  // 消化 B 的 respond 波（在途会挡住后续换模型卡）
  const kB2 = contB.waves[0].dispatchKey
  await writeFile(path.join(root, "R.md"), "v3", "utf8")
  await call(["deliver", "--task", "b-baseline-t", "--key", kB2, "--outcome", "delivered", "--summary", "s3", "--paths", "R.md"])
  const rvB2 = await call(["dispatch-plan", "--task", "b-baseline-t"])
  await call(["review", "--task", "b-baseline-t", "--key", rvB2.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "再重做 2"])

  // 轮次上限卡（第 3 轮 rework）先追加一轮，避免把收敛卡误当换模型卡
  const converge = await call(["dispatch-plan", "--task", "b-baseline-t"])
  if (converge.stop === "awaiting-user" && converge.card?.choices?.[0]?.grant === "extra-round") {
    await call(["decide", "--task", "b-baseline-t", "--choice", "1"])
  }

  // B→C：再改 senior → 换模型卡的 from 必须是 B 的 expert
  await call(["roles", "--task", "b-baseline-t", "--set", "owner=tier:senior"])
  const freshB = await call(["dispatch-plan", "--task", "b-baseline-t", "--writable", "R.md:code-review"])
  assert.ok(freshB.card.requiresFreshSession, JSON.stringify(freshB).slice(0, 800))
  assert.equal(freshB.card.requiresFreshSession.fromModelRef.modelName, "cli-expert", "B→C 比较 B 首派模型")
  assert.equal(freshB.card.requiresFreshSession.toModelRef.modelName, "cli-senior")
  assert.equal((await call(["decide", "--task", "b-baseline-t", "--choice", "2"])).ok, true)
  const waveC = await call(["dispatch-plan", "--task", "b-baseline-t", "--json", "--writable", "R.md:code-review"])
  assert.equal(waveC.stop, null)
  assert.equal(waveC.waves[0].modelRef.modelName, "cli-senior")
  const task = await fixLoadTask(root, "b-baseline-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const reset = task.journal.filter((event) => event.type === "session-reset").at(-1)
  assert.equal(reset.detail.fromModelRef.modelName, "cli-expert", "C 的 reset 记录 B 首派模型")
  assert.equal(reset.detail.toModelRef.modelName, "cli-senior")
})

test("E1：跨阶段只比较当前阶段会话首派模型，不回看上一阶段", async () => {
  const wf = { terminalStages: ["code-review"], gates: [], stages: [
    { id: "research", label: "调研", outputs: [], teamScene: "research" },
    { id: "code-review", label: "审查", outputs: ["code-review"], teamScene: "code-review" },
  ], edges: [{ from: "research", to: "code-review", outcome: "pass" }] }
  const pol = { maxAutonomousRounds: 3, roles: { owner: "junior", challenger: "senior", expert: "expert" }, scenes: { research: { core: false }, "code-review": { core: false } } }
  const root = await makeProject({ workflow: wf, policy: pol })
  const call = autoCaller(root)
  await openTask(root, "stage-base-t", { entry: null })
  // research 阶段：junior 派发并收敛 → advance
  const r1 = await call(["dispatch-plan", "--task", "stage-base-t", "--writable", "none"])
  const k1 = r1.waves[0].dispatchKey
  await call(["agent-map", "--task", "stage-base-t", "--key", k1, "--agent", "child-X"])
  await call(["deliver", "--task", "stage-base-t", "--key", k1, "--outcome", "delivered", "--summary", "调研"])
  const rv1 = await call(["dispatch-plan", "--task", "stage-base-t"])
  await call(["review", "--task", "stage-base-t", "--key", rv1.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "s"])
  // 进入 code-review 前改 owner senior：当前阶段首派 = senior（research 首派是 junior）
  await call(["roles", "--task", "stage-base-t", "--set", "owner=tier:senior"])
  const d2 = await call(["dispatch-plan", "--task", "stage-base-t", "--writable", "R.md:code-review", "--json"])
  assert.equal(d2.stage, "code-review")
  assert.equal(d2.waves[0].modelRef.modelName, "cli-senior")
  const k2 = d2.waves[0].dispatchKey
  await call(["agent-map", "--task", "stage-base-t", "--key", k2, "--agent", "child-X"]) // 模拟同一会话跨阶段续用
  await writeFile(path.join(root, "R.md"), "x", "utf8")
  await call(["deliver", "--task", "stage-base-t", "--key", k2, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  const rv2 = await call(["dispatch-plan", "--task", "stage-base-t"])
  await call(["review", "--task", "stage-base-t", "--key", rv2.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "重做"])
  await call(["roles", "--task", "stage-base-t", "--set", "owner=tier:expert"])
  const fresh = await call(["dispatch-plan", "--task", "stage-base-t", "--writable", "R.md:code-review"])
  assert.equal(fresh.card.requiresFreshSession.fromModelRef.modelName, "cli-senior", "跨阶段基线只看本阶段首派，不回看 research 的 junior")
  assert.equal(fresh.card.requiresFreshSession.toModelRef.modelName, "cli-expert")
})

test("E2：换模型卡未决时改 roles：旧卡 superseded 不叠 intake 卡；decide 选项仍是 keep-session", async () => {
  const root = await makeProject()
  const call = autoCaller(root)
  await openTask(root, "no-stack-t")
  const first = await call(["dispatch-plan", "--task", "no-stack-t", "--writable", "R.md:code-review"])
  const key = first.waves[0].dispatchKey
  await call(["agent-map", "--task", "no-stack-t", "--key", key, "--agent", "child-stack"])
  await writeFile(path.join(root, "R.md"), "v1", "utf8")
  await call(["deliver", "--task", "no-stack-t", "--key", key, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  const rv = await call(["dispatch-plan", "--task", "no-stack-t"])
  await call(["review", "--task", "no-stack-t", "--key", rv.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "重做"])
  await call(["roles", "--task", "no-stack-t", "--set", "owner=tier:expert"])
  const fresh1 = await call(["dispatch-plan", "--task", "no-stack-t", "--writable", "R.md:code-review"])
  const oldFreshId = fresh1.card.decisionId
  // 未决换模型卡期间再改 roles：旧卡必须 superseded，不能同时挂 intake 卡
  const changed = await call(["roles", "--task", "no-stack-t", "--set", "owner=tier:senior"])
  assert.equal(changed.next, "decide")
  const task = await fixLoadTask(root, "no-stack-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const superseded = task.journal.filter((event) => event.type === "decided" && event.detail.decisionId === oldFreshId)
  assert.equal(superseded.length, 1, "旧换模型卡被 superseded")
  assert.equal(superseded[0].detail.choice, "superseded")
  // 新配置下重新出换模型卡；选择 1 是 keep-session（保留 old 模型），不是 intake 的“确认开始”
  const fresh2 = await call(["dispatch-plan", "--task", "no-stack-t", "--writable", "R.md:code-review"])
  assert.equal(fresh2.card.requiresFreshSession.fromModelRef.modelName, "cli-junior")
  assert.equal(fresh2.card.requiresFreshSession.toModelRef.modelName, "cli-senior")
  assert.notEqual(fresh2.card.decisionId, oldFreshId)
  assert.equal((await call(["decide", "--task", "no-stack-t", "--choice", "1"])).ok, true)
  const kept = await call(["dispatch-plan", "--task", "no-stack-t", "--writable", "R.md:code-review", "--json"])
  assert.equal(kept.stop, null)
  assert.equal(kept.waves[0].modelRef.modelName, "cli-junior", "选项 1 = 保留旧会话（不是接受 intake）")
  assert.equal(kept.waves[0].expectedAgentId, "child-stack")
})

test("E2：换模型卡签发后外部改 roles → decide 拒绝直答；推进时旧卡自动作废重签", async () => {
  const root = await makeProject()
  const call = autoCaller(root)
  await openTask(root, "fresh-stale-t")
  const first = await call(["dispatch-plan", "--task", "fresh-stale-t", "--writable", "R.md:code-review"])
  const key = first.waves[0].dispatchKey
  await call(["agent-map", "--task", "fresh-stale-t", "--key", key, "--agent", "child-stale"])
  await writeFile(path.join(root, "R.md"), "v1", "utf8")
  await call(["deliver", "--task", "fresh-stale-t", "--key", key, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  const rv = await call(["dispatch-plan", "--task", "fresh-stale-t"])
  await call(["review", "--task", "fresh-stale-t", "--key", rv.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "重做"])
  await call(["roles", "--task", "fresh-stale-t", "--set", "owner=tier:expert"])
  const fresh = await call(["dispatch-plan", "--task", "fresh-stale-t", "--writable", "R.md:code-review"])
  assert.ok(fresh.card.requiresFreshSession)
  // 绕过 tw roles 直接改 agents.json（模拟外部漂移/手工编辑）
  const task = await fixLoadTask(root, "fresh-stale-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const agentsFile = path.join(task.root, "agents.json")
  const agents = JSON.parse(await readFile(agentsFile, "utf8"))
  agents.roles.owner = { provider: "external", modelName: "external-model" }
  await writeFile(agentsFile, JSON.stringify(agents))
  const bad = await call(["decide", "--task", "fresh-stale-t", "--choice", "1"])
  assert.equal(bad.ok, false, "旧换模型卡不可直答")
  assert.equal(bad.code, "DECISION_STALE")
  // 推进通道：作废旧卡并重签（run 只读给 stale 指引）
  const run = await call(["run", "--task", "fresh-stale-t"])
  assert.equal(run.next, "re-sign")
  const reSign = await call(["dispatch-plan", "--task", "fresh-stale-t", "--writable", "R.md:code-review"])
  assert.equal(reSign.stop, "awaiting-user")
  assert.ok(reSign.card.intake, "外部改 roles 后先重签意图确认卡")
  await call(["decide", "--task", "fresh-stale-t", "--choice", "1"])
  const resigned = await call(["dispatch-plan", "--task", "fresh-stale-t", "--writable", "R.md:code-review"])
  assert.equal(resigned.stop, "awaiting-user")
  assert.notEqual(resigned.card.decisionId, fresh.card.decisionId)
  assert.equal(resigned.card.requiresFreshSession.toModelRef.modelName, "external-model")
})


test("E2：存在其他待决卡时 roles 修改不抢先签 intake 卡，只标 stale（避免选项错位）", async () => {
  const root = await makeProject()
  const call = autoCaller(root)
  await openTask(root, "roles-pending-t")
  const task = await fixLoadTask(root, "roles-pending-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const journalFile = path.join(task.root, "journal.jsonl")
  const journal = await readFile(journalFile, "utf8")
  const seq = journal.trim().split("\n").length
  await writeFile(journalFile, journal + JSON.stringify({ seq: seq + 1, at: new Date().toISOString(), type: "decision-issued", detail: { decisionId: "other-card", gateId: null, reason: "其他待决卡", choices: [{ n: 1, label: "继续" }] } }) + "\n")
  const before = (await fixLoadTask(root, "roles-pending-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })).journal.filter((event) => event.type === "decision-issued").length
  const changed = await call(["roles", "--task", "roles-pending-t", "--set", "owner=tier:senior"])
  assert.equal(changed.ok, true)
  assert.equal(changed.intakeRestaled, true)
  assert.equal(changed.status, undefined, "不返回新卡")
  assert.match(changed.note, /待决卡/)
  const after = (await fixLoadTask(root, "roles-pending-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })).journal.filter((event) => event.type === "decision-issued").length
  assert.equal(after, before, "不叠签第二张卡")
})
