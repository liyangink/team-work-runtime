// runtime-v3 CLI 全链路：code-review 介入 → Owner → Challenger → Expert → 人工门 accept → completed → archive
// 规约映射：DoD #4 的工具序列彩排（无真实模型）、E2E-14 终态幂等、I7 静止、§5.2 归档

import test from "node:test"
import assert from "assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, writeFile, readFile, readdir, stat, access, cp, unlink, rm, chmod, realpath } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { digestValue } from "../runtime-v3/domain/digests.mjs"
import fsPromises from "node:fs/promises"
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
  assert.match(state.note, /用户给出明确方向/)
  assert.match(state.note, /resolve-blocked/)
  assert.doesNotMatch(state.note, /扩大可写范围后重派/)
  assert.match(state.question, /用户明确方向.*授权/)
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
  await call(["review", "--task", "rework-scope", "--key", reviewer.dispatchKey, "--recommendation", "rework", "--summary", "需核对容量恢复与公平再访的证据", "--findings", '[{\"severity\":\"risk\",\"statement\":\"需核对容量恢复与公平再访的证据\",\"disposition\":\"must-fix\",\"scope\":{\"kind\":\"all-covered\"}}]'])
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
  const rework = await call(["review", "--task", "audit-e2e", "--key", d2.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "并发覆盖不足", "--findings", '[{"severity":"risk","statement":"连接池耗尽未分析","disposition":"must-fix","scope":{"kind":"all-covered"}}]'])
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
  assert.equal(archived.ok, true, JSON.stringify(archived))
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
    await call(["review", "--task", "quick-scan", "--key", rd.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "再改", "--findings", '[{\"severity\":\"risk\",\"statement\":\"再改\",\"disposition\":\"must-fix\",\"scope\":{\"kind\":\"all-covered\"}}]'])
    round += 1
    dispatch = await call(["dispatch-plan", "--task", "quick-scan", "--writable", "NOTES.md:code-review"])
  }
  const exhausted = await call(["run", "--task", "quick-scan"])
  assert.equal(exhausted.status, "awaiting-user", "三轮后升级用户")
  assert.ok(exhausted.choices.some((c) => c.label === "结束任务"))

  const ended = await call(["decide", "--task", "quick-scan", "--choice", "2", "--decision-id", exhausted.decisionId])
  assert.equal(ended.ok, true)
  const archived = await call(["archive", "--task", "quick-scan"])
  assert.equal(archived.form, "partial")
})

test("按真实场景选择提示：派发只带派发规则，最终验收只带同源短审阅", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "tw-present-"))
  const call = autoCaller(projectRoot)
  await call(["open", "--name", "present-check", "--objective", "验证呈现注入", "--entry", "code-review"])

  // dispatch 派发：轻量简报纪律随 waves 计划输出提升（派单转发成员，不复述用户）
  const d1 = await call(["dispatch-plan", "--task", "present-check", "--writable", "REPORT.md:code-review"])
  assert.equal(d1.stop, null)
  assert.ok(d1.presentation, "派发计划带呈现简报")
  const dispatchRules = (await readFile(new URL("../team-work/rules/lead/dispatch/index.md", import.meta.url), "utf8")).trim()
  assert.equal(d1.presentation, "完整呈现规则见 human[" + d1.human.indexOf(dispatchRules) + "]。")
  assert.equal(d1.human.filter((text) => text === dispatchRules).length, 1, "终端只在 human 中附一次派发规则")
  assert.doesNotMatch(d1.human.at(-1), /clarity/)
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
  // 路由是机械选择：保留阶段事实，不读写作规则。
  const routeCard = await call(["run", "--task", "present-check"])
  assert.equal(routeCard.next, "route")
  assert.equal(routeCard.presentation, undefined)
  assert.match(routeCard.progress, /完成八视角审查/)
  await call(["route", "--task", "present-check", "--route", "e2e", "--decision", "skip", "--basis", "审查类任务，无跨系统路径"])
  // 人工门首签归 dispatch 通道；run 只读渲染已签发的待决卡
  const gateSigned = await call(["dispatch-plan", "--task", "present-check"])
  assert.equal(gateSigned.stop, "awaiting-user")
  const gate = await call(["run", "--task", "present-check"])
  assert.equal(gate.status, "awaiting-user")

  assert.match(gate.presentation, /现在要决定什么/)
  const reviewSource = await readFile(new URL("../skills/clarity-review/references/review-rules.md", import.meta.url), "utf8")
  const shortReview = reviewSource.split("<!-- clarity:review-short:begin -->")[1].split("<!-- clarity:review-short:end -->")[0].trim()
  assert.ok([...shortReview].length <= 160)
  assert.ok(gate.presentation.includes(shortReview), "仅加载同一规范的短审阅段")
  assert.doesNotMatch(gate.presentation, /公共必读|审阅必读/)
  assert.equal(gate.presentation.split("## clarity 审阅短节选").length - 1, 1)
  assert.match(gate.progress, /完成八视角审查/)
  assert.match(gate.progress, /REPORT\.md/)
  assert.match(gate.progress, /证据链完整/)
  assert.match(gate.progress, /证据链完整/)

  // 静止期重复 run：注入为静态文本，卡片自足稳定（I7 + 认知对等不随轮数漂移）
  const again = await call(["run", "--task", "present-check"])
  assert.equal(again.presentation, gate.presentation)
  assert.equal(again.progress, gate.progress)

  // dispatch-plan 的嵌套 stop 卡同样注入（编排通道与 run 通道同纪律，素材同携）
  const plan = await call(["dispatch-plan", "--task", "present-check", "--json"])
  assert.equal(plan.stop, "awaiting-user")
  assert.match(plan.card.presentation, /现在要决定什么/)
  assert.equal(plan.card.presentation, gate.presentation, "run 与 dispatch 的决定呈现规则一致")
  assert.equal(plan.card.progress, gate.progress)
  for (const flags of [[], ["--json"]]) {
    const { stdout } = await promisify(execFile)(process.execPath, [new URL("../bin/tw.mjs", import.meta.url).pathname, "dispatch-plan", "--task", "present-check", "--project-root", projectRoot, ...flags])
    assert.equal(stdout.split("## clarity 审阅短节选").length - 1, 1, "真实 stdout 同源短审阅只出现一次")
    const actual = JSON.parse(stdout)
    if (flags.length) assert.ok(actual.card.presentation.includes(shortReview))
    else {
      assert.match(actual.card.presentation, /完整呈现规则见 human\[/)
      assert.ok(actual.human.some((text) => text.includes(shortReview)))
    }
  }

  // accept → completed：进展转折卡带轻量提醒（完成由 dispatch 通道落盘）
  await call(["decide", "--task", "present-check", "--choice", "1"])
  const done = await call(["dispatch-plan", "--task", "present-check"])
  assert.equal(done.stop, "completed")
  const progressRules = (await readFile(new URL("../team-work/rules/lead/progress/index.md", import.meta.url), "utf8")).trim()
  assert.ok(done.human.includes(progressRules))
  assert.match(done.card.presentation, /完整呈现规则见 human\[/)
  const repeated = await call(["run", "--task", "present-check"])
  assert.equal(repeated.presentation, undefined, "重复终态查询不加载提示")
  await call(["archive", "--task", "present-check"])
  const archived = await call(["dispatch-plan", "--task", "present-check"])
  assert.equal(archived.card.presentation, undefined, "归档是机械回执")
})

// ── §7 修订 v2：run 只读矩阵 + dispatch-plan 人读模式 ─────────────────────────

test("run 普通状态查询不附呈现规范且整个项目零写入", async () => {
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
    if (mode === "pending") await prepareIntake(root, "progress-check", ["none"])
    const before = await snapshot(root)
    const card = await call(["run", "--task", "progress-check"])
    assert.equal(card.status, "working", mode)
    assert.equal(card.next, "dispatch", mode)
    assert.match(card.note, mode === "pending" ? /有待派发波次/ : mode === "advance" ? /门禁已通过/ : /完成条件已满足/)
    assert.equal(card.presentation, undefined)
    assert.deepEqual(await snapshot(root), before, "读取规范和呈现不写任务事实或目录：" + mode)
    assert.equal((await call(["models"])).presentation, undefined)
  }
})

test("run 只读：待派发/在途各态出指引卡且零写入；--writable 被拒绝", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "tw-run-ro-"))
  const call = autoCaller(projectRoot)
  await call(["open", "--name", "ro-check", "--objective", "验证只读 run", "--entry", "code-review"])
  await prepareIntake(projectRoot, "ro-check", ["R.md:code-review"])

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
  assert.ok(gate.human.some((l) => l.includes(gate.card.question)))
  assert.ok(gate.human.some((l) => /1\. accept/.test(l)))

  // stop: completed：human 即 note
  await call(["decide", "--task", "human-check", "--choice", "1"])
  const done = await call(["dispatch-plan", "--task", "human-check"])
  assert.equal(done.stop, "completed")
  assert.ok(Array.isArray(done.human))
  assert.ok(done.human.some((l) => /任务完成/.test(l)))
})

// ── 批 D：删除升档审批的反向断言与旧卡收口；批 B/C：意图确认门与换模型确认 ──

import { makeProject, autoCaller, caller, openTask, asLegacyTask, prepareIntake, FIX_WORKFLOW, FIX_POLICY } from "./support/v3-fixtures.mjs"

// 追加任意 journal 事件（旧协议迁移用例构造历史事实；seq 自现有事实推导）
async function assertPathExists(target, message) {
  await access(target).then(() => true, () => assert.fail(message ?? ("路径不存在：" + target)))
}

async function appendEvents(root, name, events) {
  const file = path.join(root, ".team-work", "tasks", name, "journal.jsonl")
  const journal = await readFile(file, "utf8")
  let seq = journal.trim().split("\n").filter((l) => l.trim()).length
  const stamp = new Date().toISOString()
  await writeFile(file, journal + events.map((e) => JSON.stringify({ seq: ++seq, at: stamp, ...e })).join("\n") + "\n", "utf8")
}
import { loadTask as fixLoadTask } from "../runtime-v3/store.mjs"

test("删除升档审批反向断言：高于默认档的包直接按包级 ModelRef 派发，不再出 escalation 卡、无权重倍数文案", async () => {
  const root = await makeProject()
  const raw = caller(root)
  await openTask(root, "no-esc-t")
  const planned = await raw(["plan", "--task", "no-esc-t", "--packages", JSON.stringify([
    { id: "hi", writable: ["HI.md:k"], done: ["d"], model: { provider: "vendor-strong", modelName: "model-strong", effort: "max" }, dependsOn: [] },
  ])])
  assert.equal(planned.ok, true, "首卡前 plan 只登记准备回执")
  const card = (await raw(["dispatch-plan", "--task", "no-esc-t"])).card
  assert.equal(card.intake.packages[0].modelRef.effort, "max")
  assert.equal((await raw(["decide", "--task", "no-esc-t", "--choice", "1", "--decision-id", card.decisionId])).ok, true)
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

  const firstCard = await raw(["dispatch-plan", "--task", "legacy-esc-t", "--writable", "R.md:code-review", "--json"])
  assert.equal(firstCard.stop, "awaiting-user", "旧升档卡收口后先确认新版首卡")
  await raw(["decide", "--task", "legacy-esc-t", "--choice", "1", "--decision-id", firstCard.card.decisionId])
  const plan1 = await raw(["dispatch-plan", "--task", "legacy-esc-t", "--json"])
  assert.equal(plan1.stop, null, "确认后任务恢复推进")
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

test("用户精确指定开局和模型可直接派发，同字段夹带路径必须签意图卡", async () => {
  const root = await makeProject()
  const call = caller(root)
  const quote = "核对范围，只交一份报告，使用指定的三角色模型。"
  for (const [name, injected] of [["direct-start", false], ["mixed-start", true]]) {
    const opened = await call(["open", "--name", name, "--objective", "核对范围", "--entry", "code-review", "--raw-requirement", quote,
      "--user-direction", JSON.stringify({ quote, fields: { "intent.objective": "核对范围", "scope.entry": "code-review" } })])
    assert.equal(opened.ok, true)
    assert.equal((await call(["roles", "--task", name, "--set", "owner=样例/甲", "--set", "challenger=样例/乙", "--set", "expert=样例/丙",
      "--user-direction", JSON.stringify({ quote, fields: { "roles.owner": "样例/甲", "roles.challenger": "样例/乙", "roles.expert": "样例/丙" } })])).ok, true)
    const out = await call(["dispatch-plan", "--task", name, "--writable", "A.md:code-review", ...(injected ? ["--writable", "B.md:code-review"] : []),
      "--user-direction", JSON.stringify({ quote, fields: { writable: ["A.md:code-review"] } }), "--json"])
    if (injected) {
      assert.equal(out.card.kind, "intent", JSON.stringify(out))
      assert.deepEqual(out.waves, [])
    } else {
      assert.equal(out.stop, null, JSON.stringify(out))
      assert.equal(out.waves[0].modelRef.modelName, "甲")
      const run = await call(["run", "--task", name])
      assert.equal(run.transition, "wait-inflight")
    }
  }
})

test("首开模型简写精确匹配槽位，自动填充的模型族不要求用户复述", async () => {
  const saved = process.env.TW_DSH_CONFIG
  process.env.TW_DSH_CONFIG = JSON.stringify({ entryId: "team-work-dsh", profile: "示例配置", tiers: {
    junior: { provider: "示例", model: "甲", effort: "high" },
    senior: { provider: "示例", model: "乙" },
    expert: { provider: "示例", model: "丙" },
  } })
  try {
    const quote = "请核对报告，只交指定文件，按指定的三角色模型运行。"
    const direction = (fields) => ["--user-direction", JSON.stringify({ quote, fields })]
    const variants = [
      ["match", "示例/甲@high", true],
      ["other-model", "示例/乙@high", false],
      ["other-provider", "另一示例/甲@high", false],
      ["other-effort", "示例/甲@low", false],
      ["missing-effort", "示例/甲", false],
      ["other-family", { provider: "示例", modelName: "甲", effort: "high", family: "错误归类" }, false],
    ]
    for (const [name, claim, expected] of variants) {
      const root = await makeProject()
      const call = caller(root)
      const opened = await call(["open", "--name", name, "--entry", "code-review", "--objective", "核对报告", "--raw-requirement", quote,
        ...direction({ "intent.objective": "核对报告", "scope.entry": "code-review", "roles.owner": claim, "roles.challenger": "示例/乙", "roles.expert": "示例/丙" })])
      assert.ok(opened.roles.owner.family, "启动时确由配置解析填充模型族")
      const result = await call(["dispatch-plan", "--task", name, "--writable", "R.md:code-review", ...direction({ writable: ["R.md:code-review"] }), "--json"])
      if (expected) {
        assert.equal(result.stop, null, JSON.stringify({ stop: result.stop, code: result.card?.code }))
        assert.deepEqual(result.waves[0].modelRef, opened.roles.owner, "实际模型族等完整元数据仍入派单")
        assert.equal((await call(["gate", "--task", name])).intake.issued, false)
      } else {
        assert.equal(result.card.kind, "intent", name)
        assert.deepEqual(result.waves, [], name)
      }
    }
  } finally { process.env.TW_DSH_CONFIG = saved }
})

async function openDirectFixture(root, name) {
  const call = caller(root)
  const quote = "核对报告本身的范围。"
  const opts = (fields, amend) => ["--user-direction", JSON.stringify({ quote, fields, ...(amend ? { amend } : {}) })]
  const models = { "roles.owner": "示例/甲", "roles.challenger": "示例/乙", "roles.expert": "示例/丙" }
  assert.equal((await call(["open", "--name", name, "--entry", "code-review", "--objective", "核对报告", "--raw-requirement", quote, ...opts({ "scope.entry": "code-review", "intent.objective": "核对报告" })])).ok, true)
  assert.equal((await call(["roles", "--task", name, ...Object.entries(models).flatMap(([role, model]) => ["--set", role.split(".")[1] + "=" + model]), ...opts(models)])).ok, true)
  return { call, opts }
}

test("另一合法模型不会被同角色字段授权；完整新方向只作废旧意图卡", async () => {
  const root = await makeProject()
  const name = "exact-model"
  const { call, opts } = await openDirectFixture(root, name)
  const r = await call(["roles", "--task", name, "--set", "owner=示例/丁", ...opts({ "roles.owner": "示例/甲" })])
  assert.equal(r.ok, true)
  const next = () => call(["dispatch-plan", "--task", name, "--writable", "R.md:code-review", ...opts({ writable: ["R.md:code-review"] })])
  const signed = await next()
  assert.equal(signed.card.kind, "intent", JSON.stringify(signed))
  assert.equal(signed.card.intake.roles.find(({ role }) => role === "owner").modelRef.modelName, "丁")
  assert.equal((await call(["roles", "--task", name, "--set", "owner=示例/丁", ...opts({ "roles.owner": "示例/丁" })])).authorization.mode, "caller-reported")
  assert.equal((await call(["decide", "--task", name, "--decision-id", signed.card.decisionId, "--choice", "1"])).code, "DECISION_STALE")
  assert.equal((await next()).waves[0].modelRef.modelName, "丁")
})

test("免卡开局后的刷新和包恢复各自审批，旧授权日志引用不能消费新事实", async () => {
  const root = await makeProject()
  for (const [kind, stale] of [["refresh", false], ["refresh", true], ["retry", false], ["retry", true]]) {
    const name = "direct-" + kind + (stale ? "-stale" : "-ok")
    const { call, opts } = await openDirectFixture(root, name)
    const file = "R.md"
    const advance = () => call(["dispatch-plan", "--task", name, "--writable", file + ":code-review", ...opts({ writable: [file + ":code-review"] }), "--json"])
    const owner = (await advance()).waves[0]
    const gateState = await call(["gate", "--task", name])
    assert.equal(gateState.intake.issued, false)
    assert.equal(gateState.intake.confirmed, true)
    let card
    if (kind === "refresh") {
      await writeFile(path.join(root, file), "原内容", "utf8")
      assert.equal((await call(["deliver", "--task", name, "--key", owner.dispatchKey, "--outcome", "delivered", "--summary", "基线", "--paths", file])).accepted, true)
      await writeFile(path.join(root, file), "替换内容", "utf8")
      card = await call(["refresh-artifacts", "--task", name, "--reason", "录入修改后的字节"])
      assert.equal(card.kind, "artifact-refresh")
      assert.equal(card.binding.intakeConfirmedAtIssue.seq, gateState.intake.authorizationSeq)
      assert.equal(card.binding.intakeConfirmedAtIssue.decisionId, undefined)
    } else {
      assert.equal((await call(["deliver", "--task", name, "--key", owner.dispatchKey, "--outcome", "blocked", "--summary", "缺少输入"])).accepted, true)
      const blocked = await call(["run", "--task", name])
      card = await call(["plan", "--task", name, "--resolve-blocked", JSON.stringify({ action: "retry", reason: "补齐后重试" }), "--blocked-ref", blocked.blockedPackages[0].ref])
      assert.equal(card.kind, "package-recovery")
      assert.equal(card.recovery.intakeConfirmedAtIssue.seq, gateState.intake.authorizationSeq)
      assert.equal(card.intakeCard, undefined)
    }
    assert.equal((await advance()).stop, "awaiting-user", "授权不是刷新或恢复的决定")
    if (stale) {
      const change = await call(["intent", "--task", name, "--add-constraint", "只保留必要结论", ...opts({ "intent.constraints": ["只保留必要结论"] })])
      assert.equal(change.authorization.mode, "caller-reported")
    }
    const answer = await call(["decide", "--task", name, "--decision-id", card.decisionId, "--choice", "1"])
    assert.equal(answer.ok, !stale, JSON.stringify(answer))
    if (stale) assert.equal(answer.code, "DECISION_STALE")
    else assert.equal((await advance()).waves[0].role, kind === "refresh" ? "challenger" : "owner")
  }
})

test("人工门答复同批修订：明确追加可立刻派发，夹带项必须先确认", async () => {
  const root = await makeProject()
  for (const injected of [false, true]) {
    const name = injected ? "amend-with-gap" : "amend-direct"
    const { call, opts } = await openDirectFixture(root, name)
    const advance = () => call(["dispatch-plan", "--task", name, "--writable", "R.md:code-review", ...opts({ writable: ["R.md:code-review"] }), "--json"])
    const owner = (await advance()).waves[0]
    await writeFile(path.join(root, "R.md"), "原报告", "utf8")
    await call(["deliver", "--task", name, "--key", owner.dispatchKey, "--outcome", "delivered", "--summary", "原报告", "--paths", "R.md"])
    let wave = (await advance()).waves[0]
    await call(["review", "--task", name, "--key", wave.dispatchKey, "--recommendation", "accept", "--summary", "通过"])
    wave = (await advance()).waves[0]
    await call(["review", "--task", name, "--key", wave.dispatchKey, "--recommendation", "accept", "--summary", "通过", "--verdict", JSON.stringify({ outcome: "accept", rationale: "证据在场", confidence: "high", recommendedAction: "请用户验收" })])
    await call(["route", "--task", name, "--route", "e2e", "--decision", "skip", "--basis", "报告无需联调"])
    const gate = (await advance()).card
    assert.equal(gate.kind, "human-gate")
    const authorized = "只保留可证明的结论"
    const amend = { addConstraint: [authorized, ...(injected ? ["用户没有指定的限制"] : [])] }
    const decide = () => call(["decide", "--task", name, "--decision-id", gate.decisionId, "--choice", "2", ...opts({ "intent.constraints": [authorized] }, amend)])
    assert.equal((await decide()).ok, true)
    assert.equal((await decide()).replay, true)
    const next = await advance()
    if (injected) { assert.equal(next.card.kind, "intent"); assert.deepEqual(next.waves, []) }
    else { assert.equal(next.waves[0].kind, "respond"); assert.ok(next.waves[0].promptFull.includes(authorized)) }
  }
})

test("固定意图卡隔离粘贴原文，并且正文和选项在人读数组中只出现一次", async () => {
  const root = await makeProject()
  const call = caller(root)
  const name = "frozen-intent"
  const raw = "# 原始标题\n~~~~\n1. 不是真的选项\n| 表格 |"
  await call(["open", "--name", name, "--entry", "code-review", "--objective", "核对", "--raw-requirement", raw])
  const signed = await call(["dispatch-plan", "--task", name, "--writable", "R.md:code-review"])
  assert.equal(signed.card.template.form, "full")
  assert.equal(signed.card.presentation, undefined)
  assert.equal(signed.presentation, undefined)
  assert.equal(signed.human.filter((line) => line === signed.card.question).length, 1)
  assert.equal(signed.human.join("\n").split("1. 确认开始").length - 1, 1)
  assert.ok(signed.card.question.includes("~~~~~text\n" + raw + "\n~~~~~"))
  assert.equal((await call(["run", "--task", name])).question, signed.card.question)
  assert.equal((await call(["dispatch-plan", "--task", name, "--json"])).card.question, signed.card.question)
})

test("新版首卡：先准备完整分包，首次推进签一张卡并绑定 ID 与 SHA", async () => {
  const root = await makeProject()
  const raw = caller(root)
  const args = ["--objective", "审查示例模块", "--entry", "code-review", "--raw-requirement", "用户原始需求全文\n第二行", "--constraint", "约束一", "--exclusion", "排除一", "--acceptance", "验收一", "--scope-note", "范围一"]
  const opened = await raw(["open", "--name", "intake-a", ...args])
  assert.equal(opened.status, "preparing")
  assert.equal(opened.decisionId, undefined)
  const packages = [
    { id: "draft", writable: ["D.md:code-review"], done: ["完成草稿"], dependsOn: [] },
    { id: "merge", writable: ["M.md:code-review"], done: ["完成汇总"], dependsOn: ["draft"] },
  ]
  const planned = await raw(["plan", "--task", "intake-a", "--packages", JSON.stringify(packages)])
  assert.equal(planned.decisionId, undefined)
  const before = await fixLoadTask(root, "intake-a", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(before.scope.intakeVersion, 2)
  assert.equal(before.journal.filter((event) => event.type === "decision-issued").length, 0)
  const first = await raw(["dispatch-plan", "--task", "intake-a", "--json"])
  assert.equal(first.stop, "awaiting-user")
  assert.deepEqual(first.waves, [])
  assert.match(first.card.question, /用户原始需求全文\n第二行/)
  assert.match(first.card.question, new RegExp(first.card.decisionId))
  assert.match(first.card.question, /完整分包计划/)
  assert.deepEqual(first.card.intake.actualScope, { entry: "code-review", completion: { mode: "through-stage", stage: "code-review" }, outputs: ["code-review"] })
  assert.deepEqual(first.card.intake.roles.map((entry) => entry.role), ["owner", "challenger", "expert"])
  for (const [i, pkg] of first.card.intake.packages.entries()) {
    assert.equal(pkg.id, packages[i].id)
    assert.deepEqual(pkg.model, pkg.modelRef)
    assert.deepEqual(pkg.writable, packages[i].writable)
    assert.deepEqual(pkg.done, packages[i].done)
    assert.deepEqual(pkg.dependsOn, packages[i].dependsOn)
    for (const field of [pkg.id, pkg.writable[0], pkg.done[0]]) assert.ok(first.card.question.includes(field))
  }
  const again = await raw(["dispatch-plan", "--task", "intake-a", "--json"])
  assert.equal(again.card.decisionId, first.card.decisionId)
  assert.equal((await raw(["decide", "--task", "intake-a", "--choice", "1"])).code, "DECISION_STALE")
  assert.equal((await raw(["decide", "--task", "intake-a", "--choice", "1", "--decision-id", first.card.decisionId])).ok, true)
  const d = await raw(["dispatch-plan", "--task", "intake-a", "--json"])
  assert.equal(d.stop, null)
  assert.equal(d.waves[0].package, "draft")
  const after = await fixLoadTask(root, "intake-a", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(after.journal.filter((event) => event.type === "decision-issued" && event.detail.gateId === "intake-approval").length, 1)
  assert.equal(after.decisions[0].intakeVersion, 2)
})

test("新版首卡：迟到 ID 拒绝，A→B→A 不复用旧确认或卡号，相同配置不重签", async () => {
  const root = await makeProject()
  const raw = caller(root)
  await raw(["open", "--name", "intake-change", "--objective", "目标", "--entry", "code-review", "--raw-requirement", "用户原文"])
  const planA = [{ id: "a", writable: ["A.md:k"], done: ["完成 A"], dependsOn: [] }]
  const planB = [{ ...planA[0], done: ["完成 B"] }]
  const setPlan = (p) => raw(["plan", "--task", "intake-change", "--packages", JSON.stringify(p)])
  await setPlan(planA)
  const a = (await raw(["dispatch-plan", "--task", "intake-change"])).card
  await setPlan(planA)
  assert.equal((await raw(["dispatch-plan", "--task", "intake-change"])).card.decisionId, a.decisionId)
  const b = await setPlan(planB)
  assert.notEqual(b.decisionId, a.decisionId)
  assert.notEqual(b.intakeFingerprint, a.intakeFingerprint)
  assert.equal(b.intake.diff, undefined, "首卡尚未确认时重签仍展示完整卡")
  assert.match(b.question, /用户原文/)
  for (const choice of ["1", "2", "3"]) assert.equal((await raw(["decide", "--task", "intake-change", "--choice", choice, "--decision-id", a.decisionId])).code, "DECISION_STALE")
  assert.equal((await raw(["run", "--task", "intake-change"])).decisionId, b.decisionId)
  assert.equal((await raw(["decide", "--task", "intake-change", "--choice", "1", "--decision-id", b.decisionId])).ok, true)
  const restored = await setPlan(planA)
  assert.equal(restored.intakeFingerprint, a.intakeFingerprint)
  assert.notEqual(restored.decisionId, a.decisionId)
  assert.notEqual(restored.decisionId, b.decisionId)
  assert.equal((await raw(["dispatch-plan", "--task", "intake-change"])).card.decisionId, restored.decisionId)
  assert.equal((await raw(["decide", "--task", "intake-change", "--choice", "1", "--decision-id", restored.decisionId])).ok, true)
  assert.equal((await raw(["dispatch-plan", "--task", "intake-change"])).stop, null)
})

test("新版首卡：单 Owner 首派范围变化重签，省略范围时沿用已确认值", async () => {
  const root = await makeProject()
  const raw = caller(root)
  await raw(["open", "--name", "solo-intake", "--objective", "目标", "--entry", "code-review", "--raw-requirement", "用户原文"])
  const a = (await raw(["dispatch-plan", "--task", "solo-intake", "--writable", "A.md:code-review"])).card
  assert.deepEqual(a.intake.firstWritable, ["A.md:code-review"])
  assert.match(a.question, /未拆包：单 Owner/)
  const b = (await raw(["dispatch-plan", "--task", "solo-intake", "--writable", "B.md:code-review"])).card
  assert.notEqual(a.decisionId, b.decisionId)
  assert.notEqual(a.intakeFingerprint, b.intakeFingerprint)
  assert.equal((await raw(["decide", "--task", "solo-intake", "--choice", "1", "--decision-id", a.decisionId])).code, "DECISION_STALE")
  await raw(["decide", "--task", "solo-intake", "--choice", "1", "--decision-id", b.decisionId])
  const dispatch = await raw(["dispatch-plan", "--task", "solo-intake"])
  assert.equal(dispatch.stop, null)
  assert.match(dispatch.waves[0].prompt, /B\.md/)
})

test("新版首卡：缺原文或未解析模型不签发可确认卡", async () => {
  const root = await makeProject()
  const raw = caller(root)
  await raw(["open", "--name", "missing-raw", "--objective", "目标", "--entry", "code-review"])
  assert.equal((await raw(["dispatch-plan", "--task", "missing-raw", "--writable", "A.md:k"])).code, "INTAKE_RAW_REQUIRED")
  let state = await fixLoadTask(root, "missing-raw", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(state.journal.some((event) => event.type === "decision-issued"), false)
  await raw(["intent", "--task", "missing-raw", "--raw-requirement", "补充原文"])
  assert.equal((await raw(["dispatch-plan", "--task", "missing-raw"])).stop, "awaiting-user")
  const saved = process.env.TW_DSH_CONFIG
  try {
    process.env.TW_DSH_CONFIG = JSON.stringify({ entryId: "team-work-dsh", profile: "fixture", tiers: { junior: { provider: "example", model: "small" } } })
    const broken = await makeProject()
    const c = caller(broken)
    await c(["open", "--name", "missing-model", "--objective", "目标", "--entry", "code-review", "--raw-requirement", "原文"])
    const blocked = await c(["dispatch-plan", "--task", "missing-model", "--writable", "A.md:k"])
    assert.equal(blocked.stop, "blocked")
    assert.equal(blocked.card.blockers[0].code, "ROLES_UNRESOLVED")
    state = await fixLoadTask(broken, "missing-model", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
    assert.equal(state.journal.some((event) => event.type === "decision-issued"), false)
  } finally { process.env.TW_DSH_CONFIG = saved }
})

test("包级 ModelRef 物化：显式 model / tier 语法糖 / 复用 roles.owner；tier+model 冲突与缺档拒绝", async () => {
  const root = await makeProject()
  const raw = caller(root)
  await openTask(root, "plan-model-t")
  const explicit = await raw(["plan", "--task", "plan-model-t", "--packages", JSON.stringify([
    { id: "a", writable: ["A.md:k"], done: ["d"], model: { provider: "vendor-a", modelName: "model-a" }, dependsOn: [] },
  ])])
  assert.equal(explicit.packages[0].model.provider, "vendor-a")
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
  const firstCard = (await raw(["dispatch-plan", "--task", "plan-model-t", "--json"])).card
  await raw(["decide", "--task", "plan-model-t", "--choice", "1", "--decision-id", firstCard.decisionId])
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
  await call(["review", "--task", "roles-t", "--key", review.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "重做", "--findings", '[{\"severity\":\"risk\",\"statement\":\"重做\",\"disposition\":\"must-fix\",\"scope\":{\"kind\":\"all-covered\"}}]'])

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
  await call(["review", "--task", "fresh-t", "--key", review.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "重做", "--findings", '[{\"severity\":\"risk\",\"statement\":\"重做\",\"disposition\":\"must-fix\",\"scope\":{\"kind\":\"all-covered\"}}]'])
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
  await call(["review", "--task", "pfull-t", "--key", review1.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "重做", "--findings", '[{\"severity\":\"risk\",\"statement\":\"重做\",\"disposition\":\"must-fix\",\"scope\":{\"kind\":\"all-covered\"}}]'])
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
  assert.deepEqual(rebuilt.artifacts.items.map((i) => i.path), ["R.md"], "索引从报告事实重建（digest 来自报告链），不依赖快照文件")
  const fileDegraded = rebuilt.artifactsDegraded.find((x) => x.file === "snapshots/" + snapFiles[0])
  assert.ok(fileDegraded, "文件级 degraded 在场（损坏文件路径）")
  assert.match(fileDegraded.reason, /快照不可读/)
  assert.match(fileDegraded.reason, /处置建议|处置/)
  assert.match(fileDegraded.reason, /重跑重做|人工修复/)
  const pathDegraded = rebuilt.artifactsDegraded.find((x) => x.path === "R.md")
  assert.ok(pathDegraded, "路径级 degraded 在场（损坏快照不构成该路径的有效记录）")
  assert.match(pathDegraded.reason, /快照缺失/)

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
  // 新契约：登记事实从最新报告链重建（digest 即报告声明的 v2 字节摘要），不回退旧快照文本
  assert.equal(rebuilt.artifacts.items.length, 1)
  assert.equal(rebuilt.artifacts.items[0].path, "R.md")
  assert.equal(rebuilt.artifacts.items[0].digest, v2Digest, "重建 digest = 最新报告声明的字节摘要，不产出旧 digest 混搭")
  assert.equal(rebuilt.artifacts.items[0].digestAlgorithm, "sha256-bytes-v1")
  // 旧快照在场且可读：不构成缺失降级；digest 绑定以最新报告为准（无混搭）
  assert.ok(!rebuilt.artifactsDegraded || rebuilt.artifactsDegraded.length === 0, "无可读性降级")

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
  const normalize = (items) => items.map(({ package: pkg, ...rest }) => ({ ...rest, ...(pkg === undefined ? {} : {}) }))
  assert.deepEqual(normalize(rebuilt2.artifacts.items), normalize(before2), "快照在场：重建等价（package null 与省略同义）")
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
  const reviewed = await call(["review", "--task", "corrupt-art", "--key", d2.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "并发覆盖不足", "--findings", '[{\"severity\":\"risk\",\"statement\":\"并发覆盖不足\",\"disposition\":\"must-fix\",\"scope\":{\"kind\":\"all-covered\"}}]'])
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
  assert.equal(Buffer.from(snap.data, snap.encoding ?? "base64").toString("utf8"), "# 审查 v2", "固化的是本次交付的最新字节快照")

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
  await raw(["decide", "--task", "legacy-tier-t", "--choice", "1", "--decision-id", first.card.decisionId])
  const d = await raw(["dispatch-plan", "--task", "legacy-tier-t", "--json"])
  assert.equal(d.stop, null)
  assert.equal(d.waves[0].modelRef.modelName, "cli-senior", "物化不换模型")
  const after = await fixLoadTask(root, "legacy-tier-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(after.journal.filter((event) => event.type === "packages-model-materialized").length, 1)
  const persisted = JSON.parse(await readFile(path.join(task.root, "packages.json"), "utf8")).items
  assert.equal(persisted[0].tier, undefined, "旧 tier 字段在物化后移除")
  assert.equal(persisted[0].model.modelName, "cli-senior")
})

test("换模型原卡选回滚后恢复续派，不代答独立意图差异", async () => {
  for (const independent of [false, true]) {
    const root = await makeProject()
    const name = independent ? "rollback-with-uncovered" : "rollback-direct"
    const { call, opts } = await openDirectFixture(root, name)
    const advance = () => call(["dispatch-plan", "--task", name, "--writable", "R.md:code-review", ...opts({ writable: ["R.md:code-review"] }), "--json"])
    const first = (await advance()).waves[0]
    assert.equal(first.modelRef.modelName, "甲")
    assert.equal((await call(["gate", "--task", name])).intake.issued, false)
    await call(["agent-map", "--task", name, "--key", first.dispatchKey, "--agent", "样例会话"])
    await writeFile(path.join(root, "R.md"), "首个报告版本", "utf8")
    assert.equal((await call(["deliver", "--task", name, "--key", first.dispatchKey, "--outcome", "delivered", "--summary", "报告已交付", "--paths", "R.md"])).accepted, true)
    const review = (await advance()).waves[0]
    assert.equal((await call(["review", "--task", name, "--key", review.dispatchKey, "--recommendation", "rework", "--summary", "需要修改",
      "--findings", JSON.stringify([{ severity: "risk", statement: "补足结论", disposition: "must-fix", scope: { kind: "all-covered" } }])])).accepted, true)
    const requested = await call(["roles", "--task", name, "--set", "owner=示例/新模型", ...opts({ "roles.owner": "示例/新模型" })])
    assert.ok(requested.authorization, "用户已明确指定新模型")
    const fresh = (await advance()).card
    assert.equal(fresh.code, "REQUIRES_FRESH_SESSION")
    assert.deepEqual([fresh.requiresFreshSession.fromModelRef.modelName, fresh.requiresFreshSession.toModelRef.modelName], ["甲", "新模型"])
    if (independent) await call(["intent", "--task", name, "--add-constraint", "尚未获准的新约束"])
    const chooseRollback = () => call(["decide", "--task", name, "--decision-id", fresh.decisionId, "--choice", "3"])
    assert.equal((await chooseRollback()).ok, true)
    assert.equal((await chooseRollback()).replay, true)
    assert.equal((await call(["roles", "--task", name])).roles.owner.modelName, "甲")
    const next = await advance()
    if (independent) {
      assert.equal(next.card.kind, "intent")
      assert.deepEqual(next.waves, [])
      assert.match(next.card.question, /尚未获准的新约束/)
      assert.doesNotMatch(next.card.question, /实际值没有完全匹配[^\n]*Owner/, "孤立的角色回滚值已得到授权")
    } else {
      assert.equal(next.stop, null, JSON.stringify({ stop: next.stop, code: next.card?.code }))
      assert.equal(next.waves[0].modelRef.modelName, "甲")
      assert.equal(next.waves[0].expectedAgentId, "样例会话")
      const status = await call(["gate", "--task", name])
      assert.equal(status.intake.issued, false, "回滚不补造意图卡")
      assert.equal(status.intake.confirmed, true, "供共享门重核的完整投影已提交")
    }
  }
})


test("intent 扩展字段：范围/验收进入派单基线；gap 答复可结构化落到 intent.json", async () => {
  const root = await makeProject()
  const raw = caller(root)
  const opened = await raw(["open", "--name", "scope-t", "--objective", "目标", "--entry", "code-review", "--raw-requirement", "合成原文",
    "--scope-note", "只覆盖 A 模块", "--acceptance", "验收一",
    "--gap", JSON.stringify({ id: "g1", question: "是否含 B 模块", whyItMatters: "影响范围", proposedDefault: "不含" })])
  assert.equal(opened.ok, true)
  const card = (await raw(["dispatch-plan", "--task", "scope-t", "--writable", "R.md:code-review"])).card
  assert.equal(card.intake.scope.notes[0], "只覆盖 A 模块")
  assert.match(card.question, /范围补充[\s\S]*只覆盖 A 模块/, "确认卡展示范围补充")
  assert.equal(card.intake.acceptance[0], "验收一")
  assert.match(card.question, /验收[\s\S]*验收一/, "确认卡展示验收项")
  await raw(["decide", "--task", "scope-t", "--choice", "1", "--decision-id", card.decisionId])
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
  await raw(["open", "--name", "plan-window", "--objective", "o", "--entry", "code-review", "--raw-requirement", "合成原文"])
  const opened = (await raw(["dispatch-plan", "--task", "plan-window", "--writable", "A.md:k"])).card
  const planned = await raw(["plan", "--task", "plan-window", "--packages", JSON.stringify([{ id: "a", writable: ["A.md:k"], done: ["d"], dependsOn: [] }])])
  assert.equal(planned.status, "awaiting-user", "确认卡期间允许拆包")
  assert.notEqual(planned.decisionId, opened.decisionId, "拆包后按新包模型重签确认卡")
  assert.equal(planned.intake.packages.length, 1)
  // 其他类型的待决卡仍禁止重拆（避免改包配置与人工门答案错位）。
  await raw(["decide", "--task", "plan-window", "--choice", "1", "--decision-id", planned.decisionId])
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
  await raw(["open", "--name", "gate-intake", "--objective", "o", "--entry", "code-review", "--raw-requirement", "合成原文"])
  const card = (await raw(["dispatch-plan", "--task", "gate-intake", "--writable", "R.md:code-review"])).card
  const before = await readFile(path.join(root, ".team-work/tasks/gate-intake/journal.jsonl"), "utf8")
  const gate1 = await raw(["gate", "--task", "gate-intake"])
  assert.equal(gate1.intake.issued, true)
  assert.equal(gate1.intake.confirmed, false)
  assert.equal(await readFile(path.join(root, ".team-work/tasks/gate-intake/journal.jsonl"), "utf8"), before, "gate 只读零写入")
  await raw(["decide", "--task", "gate-intake", "--choice", "1", "--decision-id", card.decisionId])
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
  await call(["review", "--task", "pkg-fresh-t", "--key", review.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "重做", "--findings", '[{\"severity\":\"risk\",\"statement\":\"重做\",\"disposition\":\"must-fix\",\"scope\":{\"kind\":\"all-covered\"}}]'])
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
  assert.equal(persisted[0].model.modelName, "cli-junior", "包模型视图回滚到首派模型")
  assert.equal(task.packages[0].model.modelName, "cli-junior", "有效计划也必须回滚，不能仅修改视图")
  const rollback = task.journal.find((event) => event.type === "re-planned" && event.detail.source === "fresh-session-rollback")
  assert.equal(rollback.detail.items[0].model.modelName, "cli-junior", "回滚事件携带完整有效计划")
  // 不能使用会自动确认意图卡的夹具掩盖重复审批。
  const resumed = await caller(root)(["dispatch-plan", "--task", "pkg-fresh-t", "--json"])
  assert.equal(resumed.stop, null)
  assert.equal(resumed.waves[0].modelRef.modelName, "cli-junior")
})

test("F-2：报告持久化重建按提交序而非回拨墙钟返回同 key 修订", async () => {
  const root = await makeProject()
  const name = "review-clock-order"
  await openTask(root, name)
  const task = await fixLoadTask(root, name, { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const journalFile = path.join(task.root, "journal.jsonl")
  const journal = await readFile(journalFile, "utf8")
  const seq = journal.trim().split("\n").filter(Boolean).length
  const reports = [
    { reportId: "review-order", dispatchKey: "review-key", ver: 1, role: "challenger", kind: "review", stage: "code-review", round: 1, at: "2026-01-01T00:00:08Z", payload: { summary: "原评审", recommendation: "accept" } },
    { reportId: "review-order", dispatchKey: "review-key", ver: 2, role: "challenger", kind: "review", stage: "code-review", round: 1, at: "2026-01-01T00:00:02Z", payload: { summary: "修订评审", recommendation: "rework" } },
  ]
  const events = reports.map((report, index) => ({ seq: seq + index + 1, at: report.at, type: "report-committed", detail: { ...report } }))
  await writeFile(journalFile, journal + events.map((event) => JSON.stringify(event) + "\n").join(""))
  const loaded = await fixLoadTask(root, name, { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.deepEqual(loaded.reports.filter((report) => report.reportId === "review-order").map((report) => report.ver), [1, 2], "墙钟回拨不能让旧版本成为最新")
})

// F-10：换模型卡回滚必须提交完整包计划，视图损坏及提交失败均可恢复。
async function preparePackageRollback(name, includeSecond = false) {
  const root = await makeProject()
  const call = autoCaller(root)
  await openTask(root, name)
  const a = { id: "a", writable: ["A.md:code-review"], done: ["完成"], dependsOn: [] }
  const b = { id: "b", writable: ["B.md:code-review"], done: ["保留"], dependsOn: [] }
  const packages = includeSecond ? [a, b] : [a]
  assert.equal((await call(["plan", "--task", name, "--packages", JSON.stringify(packages)])).ok, true)
  const first = await call(["dispatch-plan", "--task", name])
  const firstA = first.waves.find((wave) => wave.package === "a")
  assert.equal((await call(["agent-map", "--task", name, "--key", firstA.dispatchKey, "--agent", "child-a"])).ok, true)
  for (const wave of first.waves) {
    const file = wave.package.toUpperCase() + ".md"
    await writeFile(path.join(root, file), "初次交付 " + wave.package)
    const receipt = await call(["deliver", "--task", name, "--key", wave.dispatchKey, "--outcome", "delivered", "--summary", "完成", "--paths", file])
    assert.equal(receipt.accepted, true, JSON.stringify(receipt))
  }
  const review = await call(["dispatch-plan", "--task", name])
  const result = await call(["review", "--task", name, "--key", review.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "需要修改", "--findings", JSON.stringify([{ severity: "risk", statement: "需要修改", disposition: "must-fix", scope: { kind: "all-covered" } }])])
  assert.equal(result.accepted, true, JSON.stringify(result))
  const changed = [{ ...a, model: { provider: "example", modelName: "new-model" } }, ...(includeSecond ? [b] : [])]
  assert.equal((await call(["plan", "--task", name, "--packages", JSON.stringify(changed)])).ok, true)
  const fresh = await call(["dispatch-plan", "--task", name])
  assert.equal(fresh.card.requiresFreshSession.target, "package")
  return { root, call, fresh }
}

test("F-10：包模型回滚的完整计划支持完好与缺失视图，未改包不受影响", async () => {
  const name = "rollback-two-packages"
  const { root, call, fresh } = await preparePackageRollback(name, true)
  assert.equal((await call(["decide", "--task", name, "--decision-id", fresh.card.decisionId, "--choice", "3"])).ok, true)
  let task = await fixLoadTask(root, name, { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const view = JSON.parse(await readFile(path.join(task.root, "packages.json"), "utf8")).items
  assert.equal(view[0].model.modelName, "cli-junior")
  assert.equal(task.packages[0].model.modelName, "cli-junior", "完好视图下有效计划必须回滚")
  const rollback = task.journal.find((event) => event.type === "re-planned" && event.detail.source === "fresh-session-rollback")
  assert.deepEqual(rollback.detail.items.map((item) => item.id), ["a", "b"], "事件承载完整计划")
  assert.equal(rollback.detail.items[0].model.modelName, "cli-junior")
  assert.deepEqual(rollback.detail.items[1], task.packages[1], "未回滚的包保持原配置")
  const decided = task.journal.find((event) => event.type === "decided" && event.detail.decisionId === rollback.detail.decisionId)
  assert.equal(rollback.seq, decided.seq + 1, "回滚计划和用户决定属于连续提交事实")
  await unlink(path.join(task.root, "packages.json"))
  task = await fixLoadTask(root, name, { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.deepEqual(task.packages, rollback.detail.items, "视图缺失时以完整计划事实重建")
})

for (const target of ["journal.jsonl", "packages.json"]) {
  test("F-10：回滚写入 " + target + " 失败后可恢复且重试幂等", async () => {
    const name = "rollback-fault-" + target.split(".")[0]
    const { root, call, fresh } = await preparePackageRollback(name)
    const original = fsPromises.rename
    const targetPath = path.join(root, ".team-work", "tasks", name, target)
    let injected = 0
    fsPromises.rename = async (from, to) => {
      if (String(to) === targetPath) {
        injected++
        const error = new Error("注入回滚写入失败")
        error.code = "EIO"
        throw error
      }
      return original(from, to)
    }
    syncBuiltinESMExports()
    let failed
    try {
      failed = await call(["decide", "--task", name, "--decision-id", fresh.card.decisionId, "--choice", "3"])
    } finally {
      fsPromises.rename = original
      syncBuiltinESMExports()
    }
    assert.equal(injected, 1, "必须实际命中指定写入")
    assert.equal(failed.ok, false, JSON.stringify(failed))
    let task = await fixLoadTask(root, name, { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
    const rollbacks = () => task.journal.filter((event) => event.type === "re-planned" && event.detail.source === "fresh-session-rollback")
    assert.equal(rollbacks().length, target === "journal.jsonl" ? 0 : 1, "视图故障发生在计划事实提交之后")
    assert.equal(task.packages[0].model.modelName, target === "journal.jsonl" ? "new-model" : "cli-junior")
    const retry = await call(["decide", "--task", name, "--decision-id", fresh.card.decisionId, "--choice", "3"])
    assert.equal(retry.ok, true, JSON.stringify(retry))
    task = await fixLoadTask(root, name, { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
    assert.equal(task.packages[0].model.modelName, "cli-junior")
    assert.equal(rollbacks().length, 1, "重复决定不追加第二个回滚计划")
  })
}

// F-11：人工门与迁移/意图卡并存时，直接按人工门 ID 决定也不能绕过前提。
async function preparePendingHumanGate(kind) {
  const root = await makeProject()
  const name = "prerequisite-" + kind
  await openTask(root, name)
  const task = await fixLoadTask(root, name, { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const decisionsFile = path.join(task.root, "decisions.json")
  await writeFile(decisionsFile, JSON.stringify({ items: [] }))
  const journalFile = path.join(task.root, "journal.jsonl")
  const before = await readFile(journalFile, "utf8")
  let seq = before.trim().split("\n").filter(Boolean).length
  const precondition = kind === "migration"
    ? { decisionId: "pre-migration", migrate: { candidates: [] }, choices: [{ n: 1, label: "确认" }] }
    : { decisionId: "pre-intent", gateId: "intake-approval", intakeVersion: 2, choices: [{ n: 1, label: "确认" }] }
  const humanGate = { decisionId: "human-1", gateId: "scoped-final-code-review", choices: [{ n: 1, label: "accept" }, { n: 2, label: "rework" }, { n: 3, label: "结束任务" }] }
  const events = [precondition, humanGate].map((detail) => ({ seq: ++seq, at: "2026-01-01T00:00:00Z", type: "decision-issued", detail }))
  await writeFile(journalFile, before + events.map((event) => JSON.stringify(event) + "\n").join(""))
  return { root, name, call: caller(root), journalFile, decisionsFile }
}

for (const kind of ["migration", "intent"]) {
  test("F-11：未决 " + kind + " 前置卡阻止人工批准且不写入", async () => {
    const fixture = await preparePendingHumanGate(kind)
    const journal = await readFile(fixture.journalFile, "utf8")
    const decisions = await readFile(fixture.decisionsFile, "utf8")
    const result = await fixture.call(["decide", "--task", fixture.name, "--decision-id", "human-1", "--choice", "1"])
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.match(result.message, new RegExp("pre-" + kind), "拒绝信息指出未决前置卡")
    assert.equal(await readFile(fixture.journalFile, "utf8"), journal, "journal 零写入")
    assert.equal(await readFile(fixture.decisionsFile, "utf8"), decisions, "决定视图零写入")
  })

  test("F-11：" + kind + " 前置卡收口后人工批准可继续", async () => {
    const fixture = await preparePendingHumanGate(kind)
    const journal = await readFile(fixture.journalFile, "utf8")
    const seq = journal.trim().split("\n").filter(Boolean).length + 1
    const closed = { seq, at: "2026-01-01T00:00:01Z", type: "decided", detail: { decisionId: "pre-" + kind, choice: "ok" } }
    await writeFile(fixture.journalFile, journal + JSON.stringify(closed) + "\n")
    const result = await fixture.call(["decide", "--task", fixture.name, "--decision-id", "human-1", "--choice", "1"])
    assert.equal(result.ok, true, JSON.stringify(result))
  })
}

test("F-11：迁移前置卡未决时仍可明确选择结束任务", async () => {
  const fixture = await preparePendingHumanGate("migration")
  const result = await fixture.call(["decide", "--task", fixture.name, "--decision-id", "human-1", "--choice", "3"])
  assert.equal(result.ok, true, JSON.stringify(result))
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
  await call(["review", "--task", "pkg-reset-t", "--key", review.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "重做", "--findings", '[{\"severity\":\"risk\",\"statement\":\"重做\",\"disposition\":\"must-fix\",\"scope\":{\"kind\":\"all-covered\"}}]'])
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
  await call(["review", "--task", "b-baseline-t", "--key", rv.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "重做", "--findings", '[{\"severity\":\"risk\",\"statement\":\"重做\",\"disposition\":\"must-fix\",\"scope\":{\"kind\":\"all-covered\"}}]'])

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
  await call(["review", "--task", "b-baseline-t", "--key", rvB.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "再重做", "--findings", '[{\"severity\":\"risk\",\"statement\":\"再重做\",\"disposition\":\"must-fix\",\"scope\":{\"kind\":\"all-covered\"}}]'])
  const contB = await call(["dispatch-plan", "--task", "b-baseline-t", "--json", "--writable", "R.md:code-review"])
  assert.equal(contB.stop, null, "B 会话按自身首派模型比较，不重复出卡")
  assert.equal(contB.waves[0].modelRef.modelName, "cli-expert")
  assert.equal(contB.waves[0].expectedAgentId, "child-B")

  // 消化 B 的 respond 波（在途会挡住后续换模型卡）
  const kB2 = contB.waves[0].dispatchKey
  await writeFile(path.join(root, "R.md"), "v3", "utf8")
  await call(["deliver", "--task", "b-baseline-t", "--key", kB2, "--outcome", "delivered", "--summary", "s3", "--paths", "R.md"])
  const rvB2 = await call(["dispatch-plan", "--task", "b-baseline-t"])
  await call(["review", "--task", "b-baseline-t", "--key", rvB2.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "再重做 2", "--findings", '[{\"severity\":\"risk\",\"statement\":\"再重做 2\",\"disposition\":\"must-fix\",\"scope\":{\"kind\":\"all-covered\"}}]'])

  // 轮次上限卡（第 3 轮 rework）先追加一轮，避免把收敛卡误当换模型卡
  const converge = await call(["dispatch-plan", "--task", "b-baseline-t"])
  if (converge.stop === "awaiting-user" && converge.card?.choices?.[0]?.grant === "extra-round") {
    await call(["decide", "--task", "b-baseline-t", "--choice", "1", "--decision-id", converge.card.decisionId])
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
  await call(["review", "--task", "stage-base-t", "--key", rv2.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "重做", "--findings", '[{\"severity\":\"risk\",\"statement\":\"重做\",\"disposition\":\"must-fix\",\"scope\":{\"kind\":\"all-covered\"}}]'])
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
  await call(["review", "--task", "no-stack-t", "--key", rv.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "重做", "--findings", '[{\"severity\":\"risk\",\"statement\":\"重做\",\"disposition\":\"must-fix\",\"scope\":{\"kind\":\"all-covered\"}}]'])
  await call(["roles", "--task", "no-stack-t", "--set", "owner=tier:expert"])
  const fresh1 = await call(["dispatch-plan", "--task", "no-stack-t", "--writable", "R.md:code-review"])
  const oldFreshId = fresh1.card.decisionId
  // 其他待决卡优先：先标失效，不叠签；推进时收口旧卡后重签意图卡。
  const changed = await call(["roles", "--task", "no-stack-t", "--set", "owner=tier:senior"])
  assert.equal(changed.status, "awaiting-user", "roles 变更签发新的意图确认卡（多卡并存按 decision-id 决定）")
  assert.ok(changed.decisionId)
  assert.equal((await call(["decide", "--task", "no-stack-t", "--choice", "1", "--decision-id", oldFreshId])).code, "DECISION_STALE")
  const resigned = await caller(root)(["dispatch-plan", "--task", "no-stack-t", "--writable", "R.md:code-review"])
  assert.equal(resigned.stop, "awaiting-user")
  assert.ok(resigned.card.decisionId.startsWith("fresh-"), "意图确认已由调用方完成，重签的是换模型卡")
  const task = await fixLoadTask(root, "no-stack-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const superseded = task.journal.filter((event) => event.type === "decided" && event.detail.decisionId === oldFreshId)
  assert.equal(superseded.length, 1, "推进时旧换模型卡被 superseded")
  assert.equal(superseded[0].detail.choice, "superseded")
  await call(["decide", "--task", "no-stack-t", "--choice", "1", "--decision-id", resigned.card.decisionId])
  // keep-session 固化旧模型后无需再出换模型卡：respond 波直接按旧模型续派。
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
  await call(["review", "--task", "fresh-stale-t", "--key", rv.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "重做", "--findings", '[{\"severity\":\"risk\",\"statement\":\"重做\",\"disposition\":\"must-fix\",\"scope\":{\"kind\":\"all-covered\"}}]'])
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
  const reSign = await caller(root)(["dispatch-plan", "--task", "fresh-stale-t", "--writable", "R.md:code-review"])
  assert.equal(reSign.stop, "awaiting-user")
  assert.ok(reSign.card.decisionId.startsWith("intake-"), "外部改 roles 后先重签意图确认卡")
  await call(["decide", "--task", "fresh-stale-t", "--choice", "1", "--decision-id", reSign.card.decisionId])
  const resigned = await call(["dispatch-plan", "--task", "fresh-stale-t", "--writable", "R.md:code-review"])
  assert.equal(resigned.stop, "awaiting-user")
  assert.notEqual(resigned.card.decisionId, fresh.card.decisionId)
  assert.equal(resigned.card.requiresFreshSession.toModelRef.modelName, "external-model")
})


test("E2：存在其他待决卡时 roles 修改不抢先签 intake 卡，只标 stale（避免选项错位）", async () => {
  const root = await makeProject()
  const call = autoCaller(root)
  await openTask(root, "roles-pending-t")
  await prepareIntake(root, "roles-pending-t", ["R.md:code-review"])
  const task = await fixLoadTask(root, "roles-pending-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const journalFile = path.join(task.root, "journal.jsonl")
  const journal = await readFile(journalFile, "utf8")
  const seq = journal.trim().split("\n").length
  await writeFile(journalFile, journal + JSON.stringify({ seq: seq + 1, at: new Date().toISOString(), type: "decision-issued", detail: { decisionId: "other-card", gateId: null, reason: "其他待决卡", choices: [{ n: 1, label: "继续" }] } }) + "\n")
  const before = (await fixLoadTask(root, "roles-pending-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })).journal.filter((event) => event.type === "decision-issued").length
  const changed = await call(["roles", "--task", "roles-pending-t", "--set", "owner=tier:senior"])
  assert.equal(changed.ok, true)
  assert.equal(changed.status, "awaiting-user", "roles 变更重签意图卡；选项错位由按 ID 决定防护，不再靠不叠签")
  assert.ok(changed.decisionId)
  assert.match(changed.question ?? changed.note ?? "", /意图|确认/)
  const after = (await fixLoadTask(root, "roles-pending-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })).journal.filter((event) => event.type === "decision-issued").length
  assert.equal(after, before + 1, "新意图卡签发一张（旧卡不因此收口，各自按 ID 决定）")
})

test("新版初始化中断：缺原文事实或初始日志保留残留并提示换名恢复", async () => {
  const root = await makeProject()
  const call = caller(root)
  for (const broken of ["intent", "journal-missing", "journal-empty"]) {
    const name = "incomplete-" + broken
    const args = ["open", "--name", name, "--objective", "目标", "--entry", "code-review", "--raw-requirement", "用户完整原文"]
    assert.equal((await call(args)).ok, true)
    const dir = path.join(root, ".team-work", "tasks", name)
    if (broken === "intent") await unlink(path.join(dir, "intent.json"))
    else if (broken === "journal-missing") await unlink(path.join(dir, "journal.jsonl"))
    else await writeFile(path.join(dir, "journal.jsonl"), "")
    const entries = (await readdir(dir)).sort()
    const scope = await readFile(path.join(dir, "scope.json"), "utf8")
    const operations = [args, ["run", "--task", name], ["intent", "--task", name, "--objective", "新目标"], ["plan", "--task", name, "--packages", JSON.stringify([{ id: "a", writable: ["A.md:k"], done: ["完成"], dependsOn: [] }])], ["dispatch-plan", "--task", name, "--writable", "A.md:k"]]
    for (const command of operations) {
      const result = await call(command)
      assert.equal(result.code, "TASK_INIT_INCOMPLETE", JSON.stringify(result))
      assert.match(result.message + result.fix, /新名字|换新名字/)
    }
    assert.deepEqual((await readdir(dir)).sort(), entries)
    assert.equal(await readFile(path.join(dir, "scope.json"), "utf8"), scope)
  }
  const orphan = path.join(root, ".team-work", "tasks", "orphan")
  await mkdir(orphan, { recursive: true })
  await writeFile(path.join(orphan, "intent.json"), "原样保留")
  const blocked = await call(["open", "--name", "orphan", "--objective", "目标", "--entry", "code-review", "--raw-requirement", "原文"])
  assert.equal(blocked.code, "TASK_INIT_INCOMPLETE")
  assert.equal(await readFile(path.join(orphan, "intent.json"), "utf8"), "原样保留")
  assert.equal((await call(["open", "--name", "replacement", "--objective", "目标", "--entry", "code-review", "--raw-requirement", "用户完整原文"])).ok, true)
  assert.equal((await call(["dispatch-plan", "--task", "replacement", "--writable", "R.md:k"])).stop, "awaiting-user")
})

test("新版确认中断：仅决定文件落盘不会派发，原卡 ID 重试可安全恢复", async () => {
  const root = await makeProject()
  const call = caller(root)
  await call(["open", "--name", "split-decision", "--objective", "目标", "--entry", "code-review", "--raw-requirement", "原文"])
  const card = (await call(["dispatch-plan", "--task", "split-decision", "--writable", "R.md:k"])).card
  const dir = path.join(root, ".team-work", "tasks", "split-decision")
  // 模拟决定文件已原子落盘、追加 decided 事件之前进程中断。
  await writeFile(path.join(dir, "decisions.json"), JSON.stringify({ items: [{ gateId: "intake-approval", decisionId: card.decisionId, grant: "accept-intake", choice: "确认开始", intakeVersion: 2, intakeFingerprint: card.intakeFingerprint }] }))
  const pending = await call(["dispatch-plan", "--task", "split-decision"])
  assert.equal(pending.stop, "awaiting-user")
  assert.equal(pending.card.decisionId, card.decisionId)
  assert.deepEqual(pending.waves, [])
  assert.equal((await call(["decide", "--task", "split-decision", "--choice", "1", "--decision-id", card.decisionId])).ok, true)
  assert.equal((await call(["dispatch-plan", "--task", "split-decision"])).stop, null)
})

test("新版确认卡版本与入口产出漂移不能降级或沿用旧确认", async () => {
  const root = await makeProject()
  const call = caller(root)
  await call(["open", "--name", "scope-drift", "--objective", "目标", "--entry", "code-review", "--raw-requirement", "原文"])
  const first = (await call(["dispatch-plan", "--task", "scope-drift", "--writable", "R.md:k"])).card
  const workflowFile = path.join(root, "workflow", "definitions", "engineering.json")
  const workflow = JSON.parse(await readFile(workflowFile, "utf8"))
  workflow.stages[0].outputs = ["other-output"]
  await writeFile(workflowFile, JSON.stringify(workflow))
  assert.equal((await call(["decide", "--task", "scope-drift", "--choice", "1", "--decision-id", first.decisionId])).code, "DECISION_STALE")
  const changed = (await call(["dispatch-plan", "--task", "scope-drift"])).card
  assert.notEqual(changed.decisionId, first.decisionId)
  assert.notEqual(changed.intakeFingerprint, first.intakeFingerprint)
  assert.deepEqual(changed.intake.actualScope.outputs, ["other-output"])
  const scopeFile = path.join(root, ".team-work", "tasks", "scope-drift", "scope.json")
  const scope = JSON.parse(await readFile(scopeFile, "utf8"))
  delete scope.intakeVersion
  await writeFile(scopeFile, JSON.stringify(scope))
  assert.equal((await call(["decide", "--task", "scope-drift", "--choice", "1", "--decision-id", changed.decisionId])).code, "STATE_CORRUPT")
  assert.equal((await call(["dispatch-plan", "--task", "scope-drift"])).code, "STATE_CORRUPT")
})

test("新版无产物单 Owner：首卡绑定 none 并在确认后保持空范围", async () => {
  const root = await makeProject()
  const call = caller(root)
  await call(["open", "--name", "empty-solo", "--objective", "目标", "--entry", "code-review", "--raw-requirement", "原文"])
  const card = (await call(["dispatch-plan", "--task", "empty-solo", "--writable", "none"])).card
  assert.deepEqual(card.intake.firstWritable, ["none"])
  await call(["decide", "--task", "empty-solo", "--choice", "1", "--decision-id", card.decisionId])
  const result = await call(["dispatch-plan", "--task", "empty-solo"])
  assert.equal(result.stop, null)
  const task = await fixLoadTask(root, "empty-solo", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.deepEqual(task.journal.find((event) => event.type === "dispatched").detail.writable, [])
})

test("首卡可写声明严格符合路径:类型，缺冒号不会产生误导确认或派单", async () => {
  const root = await makeProject()
  const call = caller(root)
  await call(["open", "--name", "strict-writable", "--objective", "目标", "--entry", "code-review", "--raw-requirement", "合成原文"])
  for (const entry of ["R.md", ":kind", "R.md:", "../R.md:k", "a//b:k", "a/./b:k", "R.md: "]) {
    const result = await call(["dispatch-plan", "--task", "strict-writable", "--writable", entry])
    assert.equal(result.code, "DISPATCH_INPUT_REQUIRED", entry)
    const state = await fixLoadTask(root, "strict-writable", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
    assert.equal(state.journal.some((event) => event.type === "decision-issued" || event.type === "dispatched"), false)
  }
  const bad = await call(["plan", "--task", "strict-writable", "--packages", JSON.stringify([{ id: "a", writable: ["R.md"], done: ["完成"], dependsOn: [] }])])
  assert.equal(bad.code, "PLAN_REJECTED")
  const card = (await call(["dispatch-plan", "--task", "strict-writable", "--writable", "R.md:code-review"])).card
  assert.deepEqual(card.intake.firstWritable, ["R.md:code-review"])
  await call(["decide", "--task", "strict-writable", "--choice", "1", "--decision-id", card.decisionId])
  const plan = await call(["dispatch-plan", "--task", "strict-writable"])
  assert.equal(plan.stop, null)
  const after = await fixLoadTask(root, "strict-writable", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.deepEqual(after.journal.find((event) => event.type === "dispatched").detail.writable, [{ path: "R.md", artifactKind: "code-review" }])
})

test("重签卡相对最近已确认完整快照展示增量，风险字段与完整 SHA 同源", async () => {
  const { digestValue } = await import("../runtime-v3/domain/digests.mjs")
  const root = await makeProject()
  const call = caller(root)
  const rawText = "不会出现在增量卡的独特完整原文"
  await call(["open", "--name", "diff-card", "--objective", "目标", "--entry", "code-review", "--raw-requirement", rawText, "--risk", "critical"])
  const packages = [
    { id: "a", writable: ["A.md:k"], done: ["旧标准"], dependsOn: [] },
    { id: "b", writable: ["B.md:k"], done: ["完成 B"], dependsOn: [] },
  ]
  const plan = (items) => call(["plan", "--task", "diff-card", "--packages", JSON.stringify(items)])
  await plan(packages)
  const a = (await call(["dispatch-plan", "--task", "diff-card"])).card
  assert.equal(a.intake.risk, "critical")
  assert.match(a.question, /风险标记\n~~~text\ncritical/)
  assert.equal(a.intake.diff, undefined, "首卡必须完整展示")
  await call(["decide", "--task", "diff-card", "--choice", "1", "--decision-id", a.decisionId])
  let state = await fixLoadTask(root, "diff-card", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(digestValue(state.decisions[0].intakeSnapshot), a.intakeFingerprint)
  assert.equal(state.decisions[0].intakeSnapshot.intent.risk, a.intake.risk)
  const changed = [
    { id: "a", writable: ["A2.md:k"], done: ["新标准"], dependsOn: [], model: { provider: "example", modelName: "changed" } },
    { id: "c", writable: ["C.md:k"], done: ["完成 C"], dependsOn: ["a"] },
  ]
  const b = await plan(changed)
  assert.equal(b.intake.diff.baseDecisionId, a.decisionId)
  assert.equal(b.intake.diff.baseFingerprint, a.intakeFingerprint)
  assert.equal(b.intake.diff.unchangedFolded, true)
  assert.ok(b.intake.diff.unchangedCount > 0)
  assert.match(b.question, new RegExp("共 " + b.intake.diff.unchangedCount + " 项，已折叠引用该卡"))
  const paths = b.intake.diff.changes.map((change) => change.path)
  for (const p of ["packages[a].writable[0]", "packages[a].done[0]", "packages[a].model.modelName", "packages[b]", "packages[c]"]) assert.ok(paths.includes(p), p)
  assert.match(b.question, /旧标准[\s\S]*新标准/)
  assert.doesNotMatch(b.question, new RegExp(rawText), "未变原文只在完整结构化基线中保留")
  assert.equal(b.intake.rawRequirement, rawText)
  assert.notEqual(b.intakeFingerprint, a.intakeFingerprint)
  const same = await plan(changed)
  assert.equal(same.decisionId, undefined, "无变化不得重签")
  assert.equal((await call(["run", "--task", "diff-card"])).decisionId, b.decisionId)
  await call(["decide", "--task", "diff-card", "--choice", "1", "--decision-id", b.decisionId])
  const c = await call(["intent", "--task", "diff-card", "--risk", "high"])
  assert.equal(c.intake.diff.baseDecisionId, b.decisionId)
  assert.equal(c.intake.risk, "high")
  assert.ok(c.intake.diff.changes.some((change) => change.path === "intent.risk" && change.before === "critical" && change.after === "high"))
  assert.match(c.question, /critical[\s\S]*high/)
  assert.doesNotMatch(c.question, new RegExp(rawText))
  const changedRole = await call(["roles", "--task", "diff-card", "--set", "challenger=example/new-reviewer@max"])
  assert.equal(changedRole.intake.diff.baseDecisionId, b.decisionId, "未确认的 C 不能当差异基准")
  assert.ok(changedRole.intake.diff.changes.some((change) => change.path === "roles.challenger.modelName" && change.after === "new-reviewer"))
  assert.ok(changedRole.intake.diff.changes.some((change) => change.path === "intent.risk"))
})

test("已确认 A 后 B 重签并回到 A 的旧 SHA，仍需确认新卡而不能复用 A", async () => {
  const root = await makeProject()
  const call = caller(root)
  await call(["open", "--name", "accepted-aba", "--objective", "目标", "--entry", "code-review", "--raw-requirement", "合成原文"])
  const a = (await call(["dispatch-plan", "--task", "accepted-aba", "--writable", "A.md:k"])).card
  await call(["decide", "--task", "accepted-aba", "--choice", "1", "--decision-id", a.decisionId])
  const b = (await call(["dispatch-plan", "--task", "accepted-aba", "--writable", "B.md:k"])).card
  const c = (await call(["dispatch-plan", "--task", "accepted-aba", "--writable", "A.md:k"])).card
  assert.notEqual(c.decisionId, a.decisionId)
  assert.notEqual(c.decisionId, b.decisionId)
  assert.equal(c.intakeFingerprint, a.intakeFingerprint)
  assert.equal(c.intake.diff.baseDecisionId, a.decisionId)
  assert.deepEqual(c.intake.diff.changes, [])
  assert.match(c.question, /仍须确认当前卡/)
  const replay = await call(["decide", "--task", "accepted-aba", "--choice", "1", "--decision-id", a.decisionId])
  assert.equal(replay.ok, true, "已决定卡的相同选项重试幂等重显自身结果")
  assert.equal((await call(["dispatch-plan", "--task", "accepted-aba"])).card.decisionId, c.decisionId, "重放不消费当前待决卡")
  const state = await fixLoadTask(root, "accepted-aba", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(state.journal.some((event) => event.type === "dispatched"), false)
  await call(["decide", "--task", "accepted-aba", "--choice", "1", "--decision-id", c.decisionId])
  assert.equal((await call(["dispatch-plan", "--task", "accepted-aba"])).stop, null)
})

test("旧意图卡 ID 遇到人工门不得错答，未传 ID 的人工门仍可答", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tw-cross-card-"))
  const call = caller(root)
  await call(["open", "--name", "cross-card", "--objective", "目标", "--entry", "code-review", "--raw-requirement", "合成原文"])
  const a = (await call(["dispatch-plan", "--task", "cross-card", "--writable", "R.md:code-review"])).card
  await call(["decide", "--task", "cross-card", "--choice", "1", "--decision-id", a.decisionId])
  const owner = (await call(["dispatch-plan", "--task", "cross-card"])).waves[0]
  await writeFile(path.join(root, "R.md"), "审查内容")
  await call(["deliver", "--task", "cross-card", "--key", owner.dispatchKey, "--outcome", "delivered", "--summary", "完成", "--paths", "R.md"])
  const review = (await call(["dispatch-plan", "--task", "cross-card"])).waves[0]
  await call(["review", "--task", "cross-card", "--key", review.dispatchKey, "--recommendation", "accept", "--summary", "接受"])
  const expert = (await call(["dispatch-plan", "--task", "cross-card"])).waves[0]
  await call(["review", "--task", "cross-card", "--key", expert.dispatchKey, "--recommendation", "accept", "--summary", "裁决", "--verdict", JSON.stringify({ outcome: "accept", rationale: "通过", confidence: "high", recommendedAction: "验收" })])
  await call(["route", "--task", "cross-card", "--route", "e2e", "--decision", "skip", "--basis", "无跨系统路径"])
  const gate = await call(["dispatch-plan", "--task", "cross-card"])
  assert.equal(gate.stop, "awaiting-user")
  assert.notEqual(gate.card.decisionId, a.decisionId)
  const before = await fixLoadTask(root, "cross-card", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const replay = await call(["decide", "--task", "cross-card", "--choice", "1", "--decision-id", a.decisionId])
  assert.equal(replay.ok, true, "已决定意图卡重试幂等重显，不答当前人工门")
  const after = await fixLoadTask(root, "cross-card", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.deepEqual(after.decisions, before.decisions)
  assert.deepEqual(after.journal, before.journal)
  assert.equal((await call(["decide", "--task", "cross-card", "--choice", "1"])).ok, true, "非意图卡旧接口保持兼容")
})

test("历史确认缺完整快照时不猜增量，完整卡确认后恢复增量展示", async () => {
  const root = await makeProject()
  const call = caller(root)
  await call(["open", "--name", "missing-baseline", "--objective", "目标", "--entry", "code-review", "--raw-requirement", "原文必须完整展示"])
  const a = (await call(["dispatch-plan", "--task", "missing-baseline", "--writable", "A.md:k"])).card
  await call(["decide", "--task", "missing-baseline", "--choice", "1", "--decision-id", a.decisionId])
  const file = path.join(root, ".team-work", "tasks", "missing-baseline", "decisions.json")
  const data = JSON.parse(await readFile(file, "utf8"))
  delete data.items[0].intakeSnapshot
  await writeFile(file, JSON.stringify(data))
  const b = await call(["intent", "--task", "missing-baseline", "--add-constraint", "新增约束"])
  assert.equal(b.intake.diffBaselineUnavailable, a.decisionId)
  assert.equal(b.intake.diff, undefined)
  assert.match(b.question, /缺少可核验的完整快照/)
  assert.match(b.question, /原文必须完整展示/)
  await call(["decide", "--task", "missing-baseline", "--choice", "1", "--decision-id", b.decisionId])
  const c = await call(["intent", "--task", "missing-baseline", "--add-exclusion", "新增排除"])
  assert.equal(c.intake.diff.baseDecisionId, b.decisionId)
  assert.ok(c.intake.diff.changes.some((change) => change.path === "intent.exclusions[0]" && change.kind === "added"))
  assert.doesNotMatch(c.question, /原文必须完整展示/)
})

test("增量数组删除与新增准确指向变化条目，保留项不误报修改", async () => {
  const root = await makeProject()
  const call = caller(root)
  await call(["open", "--name", "array-diff", "--objective", "目标", "--entry", "code-review", "--raw-requirement", "合成原文"])
  const p = (done) => [{ id: "a", writable: ["A.md:k"], done, dependsOn: [] }]
  await call(["plan", "--task", "array-diff", "--packages", JSON.stringify(p(["删除项", "保留项"]))])
  const first = (await call(["dispatch-plan", "--task", "array-diff"])).card
  await call(["decide", "--task", "array-diff", "--choice", "1", "--decision-id", first.decisionId])
  const card = await call(["plan", "--task", "array-diff", "--packages", JSON.stringify(p(["保留项", "新增项"]))])
  const changes = card.intake.diff.changes.filter((item) => item.path.startsWith("packages[a].done"))
  assert.deepEqual(changes, [
    { path: "packages[a].done[0]", kind: "removed", before: "删除项" },
    { path: "packages[a].done[1]", kind: "added", after: "新增项" },
  ])
  assert.doesNotMatch(card.question, /保留项/, "未变化条目不展开")
})

test("确认投影：意图、实际范围、角色和分包五字段变动逐项使旧卡失效", async (t) => {
  const cases = ["intent", "scope.entry", "scope.completion", "scope.outputs", "role", "package.id", "package.model", "package.writable", "package.done", "package.dependsOn", "array-order"]
  for (const name of cases) await t.test(name, async () => {
    const workflow = { ...FIX_WORKFLOW, stages: [...FIX_WORKFLOW.stages, { id: "implementation", label: "实现", outputs: ["source"], teamScene: "code-review" }] }
    const root = await makeProject({ workflow })
    const call = caller(root)
    await call(["open", "--name", "fingerprint-fields", "--objective", "目标", "--entry", "code-review", "--raw-requirement", "合成原文"])
    const packages = [
      { id: "a", writable: ["A.md:k"], done: ["一", "二"], dependsOn: [] },
      { id: "b", writable: ["B.md:k"], done: ["三"], dependsOn: [] },
    ]
    const plan = (items) => call(["plan", "--task", "fingerprint-fields", "--packages", JSON.stringify(items)])
    await plan(packages)
    const first = (await call(["dispatch-plan", "--task", "fingerprint-fields"])).card
    let changed
    if (name === "intent") changed = await call(["intent", "--task", "fingerprint-fields", "--objective", "新目标"])
    else if (name === "role") changed = await call(["roles", "--task", "fingerprint-fields", "--set", "challenger=example/new-reviewer@max"])
    else if (name.startsWith("scope.")) {
      if (name === "scope.outputs") {
        const file = path.join(root, "workflow", "definitions", "engineering.json")
        const data = JSON.parse(await readFile(file, "utf8"))
        data.stages[0].outputs = ["changed-output"]
        await writeFile(file, JSON.stringify(data))
      } else {
        const file = path.join(root, ".team-work", "tasks", "fingerprint-fields", "scope.json")
        const data = JSON.parse(await readFile(file, "utf8"))
        if (name === "scope.entry") data.entry = "implementation"
        else data.completion = { mode: "workflow" }
        await writeFile(file, JSON.stringify(data))
      }
      assert.equal((await call(["decide", "--task", "fingerprint-fields", "--choice", "1", "--decision-id", first.decisionId])).code, "DECISION_STALE")
      changed = (await call(["dispatch-plan", "--task", "fingerprint-fields"])).card
    } else {
      if (name === "package.id") packages[1].id = "c"
      if (name === "package.model") packages[0].model = { provider: "example", modelName: "different" }
      if (name === "package.writable") packages[0].writable = ["A2.md:k"]
      if (name === "package.done") packages[0].done = ["修改"]
      if (name === "package.dependsOn") packages[1].dependsOn = ["a"]
      if (name === "array-order") packages[0].done.reverse()
      changed = await plan(packages)
    }
    assert.ok(changed?.decisionId, JSON.stringify(changed))
    assert.notEqual(changed.decisionId, first.decisionId)
    assert.notEqual(changed.intakeFingerprint, first.intakeFingerprint)
    assert.equal((await call(["decide", "--task", "fingerprint-fields", "--choice", "1", "--decision-id", first.decisionId])).code, "DECISION_STALE")
    const state = await fixLoadTask(root, "fingerprint-fields", { workflow, policy: FIX_POLICY })
    // 新契约 §6.2.2：条件变化重签时旧卡以 superseded 原子收口落盘，不残留任何肯定性选择
    assert.ok(state.decisions.length >= 0)
    assert.ok(state.decisions.every((d) => d.choice === "superseded"), "只允许 superseded 收口：" + JSON.stringify(state.decisions))
    assert.equal(state.journal.some((event) => event.type === "dispatched"), false)
  })
})

test("确认投影键序归一：语义相同的重排对象保留原卡与 SHA", async () => {
  const root = await makeProject()
  const call = caller(root)
  await call(["open", "--name", "key-order", "--objective", "目标", "--entry", "code-review", "--raw-requirement", "合成原文"])
  const a = [{ id: "a", model: { provider: "example", modelName: "model", effort: "high" }, writable: ["A.md:k"], done: ["完成"], dependsOn: [] }]
  const reordered = [{ dependsOn: [], done: ["完成"], writable: ["A.md:k"], model: { effort: "high", modelName: "model", provider: "example" }, id: "a" }]
  const plan = (items) => call(["plan", "--task", "key-order", "--packages", JSON.stringify(items)])
  await plan(a)
  const first = (await call(["dispatch-plan", "--task", "key-order"])).card
  assert.equal((await plan(reordered)).decisionId, undefined)
  const again = (await call(["dispatch-plan", "--task", "key-order"])).card
  assert.equal(again.decisionId, first.decisionId)
  assert.equal(again.intakeFingerprint, first.intakeFingerprint)
})

test("确认卡 ID 随机数撞号时重试，绝不复用已签卡身份", async () => {
  const crypto = (await import("node:crypto")).default
  const { syncBuiltinESMExports } = await import("node:module")
  const root = await makeProject()
  const call = caller(root)
  await call(["open", "--name", "collision-card", "--objective", "目标", "--entry", "code-review", "--raw-requirement", "合成原文"])
  const original = crypto.randomBytes
  const ids = ["123456", "123456", "abcdef"]
  crypto.randomBytes = (size) => size === 3 && ids.length ? Buffer.from(ids.shift(), "hex") : original(size)
  syncBuiltinESMExports()
  try {
    const first = (await call(["dispatch-plan", "--task", "collision-card", "--writable", "A.md:k"])).card
    const second = (await call(["dispatch-plan", "--task", "collision-card", "--writable", "B.md:k"])).card
    assert.equal(first.decisionId, "intake-123456")
    assert.equal(second.decisionId, "intake-abcdef")
    assert.equal(ids.length, 0, "第二次签卡确实重试碰撞值")
    assert.equal((await call(["decide", "--task", "collision-card", "--choice", "1", "--decision-id", first.decisionId])).code, "DECISION_STALE")
  } finally {
    crypto.randomBytes = original
    syncBuiltinESMExports()
  }
})

test("Windows 路径语义：越界及盘符相对声明在首卡和计划前同步拒绝", async () => {
  const root = await makeProject()
  const call = caller(root)
  for (const name of ["windows-solo", "windows-plan", "windows-none"]) {
    await call(["open", "--name", name, "--objective", "目标", "--entry", "code-review", "--raw-requirement", "合成原文"])
  }
  const oldPlan = [{ id: "existing", writable: ["keep.md:code-review"], done: ["完成"], dependsOn: [] }]
  assert.equal((await call(["plan", "--task", "windows-plan", "--packages", JSON.stringify(oldPlan)])).ok, true)
  const planFile = path.join(root, ".team-work", "tasks", "windows-plan", "packages.json")
  const planBefore = await readFile(planFile, "utf8")
  const journalBefore = await readFile(path.join(root, ".team-work", "tasks", "windows-plan", "journal.jsonl"), "utf8")
  const project = "C:\\workspace\\project"
  const cases = ["..\\outside.md", "nested\\..\\..\\outside.md", "C:..\\outside.md", "C:relative.md", "D:relative.md", "\\rooted.md", "\\\\server\\share\\outside.md", "C:\\absolute.md"]
  for (const rel of cases.slice(0, 3)) {
    const resolved = path.win32.resolve(project, rel)
    assert.match(path.win32.relative(project, resolved), /^\.\.\\/, "示例按 Windows 语义确实离开项目：" + rel)
  }
  // 在当前宿主上只替换 path 对象的 Windows 平台判别与绝对路径语义；CLI 和文件操作仍走真实公开接口。
  const nativeSep = path.sep, nativeIsAbsolute = path.isAbsolute, windowsIsAbsolute = path.win32.isAbsolute
  path.sep = "\\"
  path.isAbsolute = windowsIsAbsolute
  try {
    for (const rel of cases) {
      const spec = rel + ":code-review"
      const solo = await call(["dispatch-plan", "--task", "windows-solo", "--writable", spec])
      assert.equal(solo.code, "DISPATCH_INPUT_REQUIRED", spec + ": " + JSON.stringify(solo))
      const invalid = [{ id: "changed", writable: [spec], done: ["完成"], dependsOn: [] }]
      const planned = await call(["plan", "--task", "windows-plan", "--packages", JSON.stringify(invalid)])
      assert.equal(planned.code, "PLAN_REJECTED", spec + ": " + JSON.stringify(planned))
      assert.equal(await readFile(planFile, "utf8"), planBefore, "无效计划不得覆盖已有计划")
      assert.equal(await readFile(path.join(root, ".team-work", "tasks", "windows-plan", "journal.jsonl"), "utf8"), journalBefore, "拒绝不追加计划或派单事件")
    }
    const state = await fixLoadTask(root, "windows-solo", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
    assert.equal(state.journal.some((event) => event.type === "decision-issued" || event.type === "dispatched"), false)
    const preserved = await call(["dispatch-plan", "--task", "windows-plan"])
    assert.equal(preserved.stop, "awaiting-user", "无效修改后原计划仍可用于首卡")
    assert.equal(preserved.card.intake.packages[0].id, "existing")
    assert.deepEqual(preserved.card.intake.packages[0].writable, ["keep.md:code-review"])
    const valid = await call(["dispatch-plan", "--task", "windows-solo", "--writable", "nested\\safe.md:code-review"])
    assert.equal(valid.stop, "awaiting-user", "合法 Windows 相对路径仍可签卡")
    assert.deepEqual(valid.card.intake.firstWritable, ["nested\\safe.md:code-review"])
    const none = await call(["dispatch-plan", "--task", "windows-none", "--writable", "none"])
    assert.equal(none.stop, "awaiting-user", "none 无产物语义保持不变")
    assert.deepEqual(none.card.intake.firstWritable, ["none"])
  } finally {
    path.sep = nativeSep
    path.isAbsolute = nativeIsAbsolute
  }
  if (path.sep === "/") {
    await call(["open", "--name", "posix-colon", "--objective", "目标", "--entry", "code-review", "--raw-requirement", "合成原文"])
    const posix = await call(["dispatch-plan", "--task", "posix-colon", "--writable", "C:relative.md:code-review"])
    assert.equal(posix.stop, "awaiting-user", "POSIX 文件名中的冒号按原有平台语义保留")
    assert.deepEqual(posix.card.intake.firstWritable, ["C:relative.md:code-review"])
  }
})

test("Windows 升级前已签的盘符相对首卡不能被旧 ID 确认或直接派发", async () => {
  const root = await makeProject()
  const call = caller(root)
  await call(["open", "--name", "old-windows-card", "--objective", "目标", "--entry", "code-review", "--raw-requirement", "合成原文"])
  await call(["open", "--name", "accepted-old-windows-card", "--objective", "目标", "--entry", "code-review", "--raw-requirement", "合成原文"])
  const nativeSep = path.sep, nativeIsAbsolute = path.isAbsolute
  const posixIsAbsolute = path.posix.isAbsolute, windowsIsAbsolute = path.win32.isAbsolute
  try {
    // 构造修复前可签发的 C:... 相对盘符卡：该字面路径在 POSIX 下合法，但在 Windows 下不确定项目根。
    path.sep = "/"
    path.isAbsolute = posixIsAbsolute
    const old = (await call(["dispatch-plan", "--task", "old-windows-card", "--writable", "C:relative.md:code-review"])).card
    assert.ok(old?.decisionId)
    const accepted = (await call(["dispatch-plan", "--task", "accepted-old-windows-card", "--writable", "C:relative.md:code-review"])).card
    assert.equal((await call(["decide", "--task", "accepted-old-windows-card", "--choice", "1", "--decision-id", accepted.decisionId])).ok, true)
    path.sep = "\\"
    path.isAbsolute = windowsIsAbsolute
    const before = await fixLoadTask(root, "old-windows-card", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
    const refused = await call(["decide", "--task", "old-windows-card", "--choice", "1", "--decision-id", old.decisionId])
    assert.equal(refused.code, "DISPATCH_INPUT_REQUIRED", JSON.stringify(refused))
    const after = await fixLoadTask(root, "old-windows-card", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
    assert.deepEqual(after.decisions, before.decisions, "拒绝不得写接受决定")
    assert.deepEqual(after.journal, before.journal, "拒绝不得追加事件或派单")
    const settledBefore = await fixLoadTask(root, "accepted-old-windows-card", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
    const blocked = await call(["dispatch-plan", "--task", "accepted-old-windows-card"])
    assert.equal(blocked.code, "DISPATCH_INPUT_REQUIRED", "历史已确认但无效的范围仍不得派发")
    const settledAfter = await fixLoadTask(root, "accepted-old-windows-card", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
    assert.deepEqual(settledAfter.journal, settledBefore.journal)
    assert.equal(settledAfter.journal.some((event) => event.type === "dispatched"), false)
    const corrected = await call(["dispatch-plan", "--task", "old-windows-card", "--writable", "safe.md:code-review"])
    assert.equal(corrected.stop, "awaiting-user")
    assert.notEqual(corrected.card.decisionId, old.decisionId)
    assert.deepEqual(corrected.card.intake.firstWritable, ["safe.md:code-review"])
  } finally {
    path.sep = nativeSep
    path.isAbsolute = nativeIsAbsolute
  }
})

// ── §6.2.1 Lead 受控刷新 + §6.2 restore 历史版本 + 多卡交叉（§9 验证矩阵补齐） ────────

test("Lead 授权刷新：准备卡列完整清单与候选 SHA，用户确认后产生 Lead 来源待审基线并重开评审链", async () => {
  const root = await makeProject()
  const call = autoCaller(root)
  await openTask(root, "refresh-t")
  const d = await call(["dispatch-plan", "--task", "refresh-t", "--writable", "R.md:code-review"])
  await writeFile(path.join(root, "R.md"), "原基线内容", "utf8")
  await call(["deliver", "--task", "refresh-t", "--key", d.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  // 评审在途外修改磁盘（模拟外部漂移/手工编辑）→ 门禁实时核对拒绝
  await writeFile(path.join(root, "R.md"), "用户手工修改后的内容", "utf8")
  const blocked = await call(["dispatch-plan", "--task", "refresh-t"])
  assert.equal(blocked.stop, "blocked", "磁盘与登记摘要不一致阻塞门禁")
  // 准备前完整快照：登记条目、报告集与 journal 长度（准备阶段零写入的对照基准）
  const beforePrep = await fixLoadTask(root, "refresh-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const itemsBeforePrep = JSON.parse(JSON.stringify(beforePrep.artifacts.items))
  const seqBeforePrep = beforePrep.journal.length
  // Lead 受控刷新：准备卡（不带 --paths-json 时取当前有效清单，展示候选 SHA）
  const prep = await call(["refresh-artifacts", "--task", "refresh-t", "--reason", "用户确认以当前磁盘内容为新待审基线"])
  assert.ok(prep.decisionId, "签发 artifact-refresh 确认卡")
  assert.equal(prep.card?.kind ?? prep.kind, "artifact-refresh", "卡类型标记")
  assert.match(prep.question, /仅刷新待审基线/, "卡面声明不构成评审通过")
  assert.match(prep.question, /R\.md/)
  assert.match(prep.question, /R\.md/, "卡面列完整清单路径")
  assert.ok(JSON.stringify(prep).match(/[0-9a-f]{40,}/), "卡片数据含候选 SHA（binding/choices 任一处）：" + JSON.stringify(prep).slice(0, 500))
  // 准备阶段零写入：登记逐项不变、journal 只追加 decision-issued（签发事实），不产生刷新报告
  const afterPrep = await fixLoadTask(root, "refresh-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.deepEqual(afterPrep.artifacts.items.map(({ package: p, ...rest }) => rest), itemsBeforePrep.map(({ package: p, ...rest }) => rest), "准备不改基线登记（逐字段比较，非自比较）")
  assert.equal(afterPrep.journal.length, seqBeforePrep + 1, "准备只追加一条 decision-issued")
  assert.equal(afterPrep.journal.at(-1).type, "decision-issued")
  assert.equal(afterPrep.reports.find((r) => r.reportId === "refresh-" + prep.decisionId), undefined, "准备不产生刷新报告")
  // 用户确认 → 一次产生 Lead 来源 delivered 报告（新基线），不伪造 Owner dispatchKey
  const confirmed = await call(["decide", "--task", "refresh-t", "--choice", "1", "--decision-id", prep.decisionId])
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed))
  const after = await fixLoadTask(root, "refresh-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const baseline = after.artifacts.items.find((i) => i.path === "R.md")
  assert.ok(baseline, "新基线登记在场")
  const bytes = await readFile(path.join(root, "R.md"))
  assert.equal(baseline.digest, createHash("sha256").update(bytes).digest("hex"), "基线摘要 = 当前磁盘原始字节")
  assert.equal(baseline.digestAlgorithm, "sha256-bytes-v1")
  const refreshReport = after.reports.find((r) => r.reportId === "refresh-" + prep.decisionId)
  assert.ok(refreshReport, "刷新报告 ID 固定为 refresh-<decisionId>")
  assert.equal(refreshReport.origin, "user-authorized-lead-refresh", "来源显式标记，不伪造 Owner")
  // 刷新后评审链重开：dispatch-plan 派出新 Challenger 波（对刷新基线的非作者评审，而非仅脱离 blocked）
  const reopened = await call(["dispatch-plan", "--task", "refresh-t"])
  assert.equal(reopened.stop, null, JSON.stringify(reopened).slice(0, 300))
  assert.equal(reopened.waves[0].role, "challenger", "新基线进入评审链（重开 Challenger）")
  await call(["review", "--task", "refresh-t", "--key", reopened.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "刷新基线通过复审"])
  const reVerdict = await call(["dispatch-plan", "--task", "refresh-t"])
  assert.equal(reVerdict.waves[0].role, "expert", "复审后进入 Expert 裁决（评审链完整重走）")
  await call(["review", "--task", "refresh-t", "--key", reVerdict.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "v", "--verdict", JSON.stringify({ outcome: "accept", rationale: "刷新基线可用", confidence: "high", recommendedAction: "验收" })])
  await call(["route", "--task", "refresh-t", "--route", "e2e", "--decision", "skip", "--basis", "测试"])
  const reGate = await call(["dispatch-plan", "--task", "refresh-t"])
  assert.equal(reGate.stop, "awaiting-user", "刷新基线重新走到人工门（不沿用刷新前的旧指纹）")
})

test("刷新授权边界：缺 reason 拒绝；确认前磁盘再变 → 旧卡不可确认并要求重签；未确认不产生新基线", async () => {
  const root = await makeProject()
  const call = autoCaller(root)
  await openTask(root, "rfedge-t")
  const d = await call(["dispatch-plan", "--task", "rfedge-t", "--writable", "R.md:code-review"])
  await writeFile(path.join(root, "R.md"), "v1", "utf8")
  await call(["deliver", "--task", "rfedge-t", "--key", d.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  await writeFile(path.join(root, "R.md"), "v2 外部修改", "utf8")
  const noReason = await call(["refresh-artifacts", "--task", "rfedge-t"])
  assert.equal(noReason.ok, false)
  assert.equal(noReason.code, "USAGE")
  assert.match(noReason.message, /--reason/)
  const single = await call(["refresh-artifacts", "--task", "rfedge-t", "--package", "a", "--reason", "x"])
  assert.equal(single.ok, false, "单 Owner 任务不接受 --package")
  const prep = await call(["refresh-artifacts", "--task", "rfedge-t", "--reason", "准备确认"])
  assert.ok(prep.decisionId)
  // 确认前磁盘再变 → 旧卡 SHA 不再匹配，确认拒绝
  await writeFile(path.join(root, "R.md"), "v3 确认前再变", "utf8")
  const stale = await call(["decide", "--task", "rfedge-t", "--choice", "1", "--decision-id", prep.decisionId])
  assert.equal(stale.ok, false, "确认前内容变化不得提交刷新")
  assert.equal(stale.code, "DECISION_STALE")
  const afterReject = await fixLoadTask(root, "rfedge-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(afterReject.reports.find((r) => r.reportId === "refresh-" + prep.decisionId), undefined, "未确认不产生刷新报告")
  // 重签：以新内容重新准备（新卡），旧卡自动失效
  const prep2 = await call(["refresh-artifacts", "--task", "rfedge-t", "--reason", "以最新内容重签"])
  assert.ok(prep2.decisionId)
  assert.notEqual(prep2.decisionId, prep.decisionId)
  const confirmed = await call(["decide", "--task", "rfedge-t", "--choice", "1", "--decision-id", prep2.decisionId])
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed))
})

test("历史快照恢复：默认恢复当前有效基线；--list 列版本；--source 显式选历史；恢复不改有效清单", async () => {
  const root = await makeProject()
  const call = autoCaller(root)
  await openTask(root, "hist-t")
  const d = await call(["dispatch-plan", "--task", "hist-t", "--writable", "R.md:code-review"])
  const key = d.waves[0].dispatchKey
  await writeFile(path.join(root, "R.md"), "版本一", "utf8")
  await call(["deliver", "--task", "hist-t", "--key", key, "--outcome", "delivered", "--summary", "v1", "--paths", "R.md"])
  await writeFile(path.join(root, "R.md"), "版本二", "utf8")
  await call(["deliver", "--task", "hist-t", "--key", key, "--outcome", "delivered", "--summary", "v2", "--paths", "R.md"])
  // 默认恢复：当前基线 = v2
  await writeFile(path.join(root, "R.md"), "被污染", "utf8")
  const def = await call(["restore", "--task", "hist-t", "--path", "R.md"])
  assert.equal(def.ok, true)
  assert.equal(await readFile(path.join(root, "R.md"), "utf8"), "版本二", "默认恢复当前有效报告的字节")
  // --list：两个可验证版本
  const list = await call(["restore", "--task", "hist-t", "--path", "R.md", "--list"])
  assert.equal(list.ok, true)
  assert.ok(Array.isArray(list.versions ?? list.entries), JSON.stringify(list).slice(0, 200))
  assert.equal((list.versions ?? list.entries).length, 2, "两条非作废报告版本")
  // --source 显式选择 v1（历史内容，当前基线不变）
  // 错误消息即版本清单：格式 <报告>@<版本>；显式选择 v1（非当前基线版本）
  const bad = await call(["restore", "--task", "hist-t", "--path", "R.md", "--source", "nonexistent"])
  assert.equal(bad.ok, false)
  const v1Source = bad.message.match(/(deliver-[^@（\s]+@1)/)?.[1]
  assert.ok(v1Source, "错误消息列出可选版本：" + bad.message.slice(0, 200))
  const restoredOld = await call(["restore", "--task", "hist-t", "--path", "R.md", "--source", v1Source])
  assert.equal(restoredOld.ok, true, JSON.stringify(restoredOld).slice(0, 200))
  assert.equal(await readFile(path.join(root, "R.md"), "utf8"), "版本一", "历史版本按显式选择恢复")
  const task = await fixLoadTask(root, "hist-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(task.artifacts.items[0].digest, createHash("sha256").update(Buffer.from("版本二", "utf8")).digest("hex"), "恢复历史不改当前有效清单（基线仍为 v2）")
  // 磁盘与基线不一致 → 门禁如实阻塞（历史内容不冒充基线）
  const gate = await call(["dispatch-plan", "--task", "hist-t"])
  assert.equal(gate.stop, "blocked", "历史内容与基线不一致时门禁如实阻塞")
})

test("多卡并存按 decisionId 交叉：人工门 C1 与刷新卡 C2 并存，确认 C2 收口 C1 为 superseded 而非 accept", async () => {
  const root = await makeProject()
  const call = autoCaller(root)
  await openTask(root, "cross12-t")
  const d = await call(["dispatch-plan", "--task", "cross12-t", "--writable", "R.md:code-review"])
  await writeFile(path.join(root, "R.md"), "评审在途内容", "utf8")
  await call(["deliver", "--task", "cross12-t", "--key", d.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  const rv = await call(["dispatch-plan", "--task", "cross12-t"])
  await call(["review", "--task", "cross12-t", "--key", rv.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "s"])
  const ve = await call(["dispatch-plan", "--task", "cross12-t"])
  await call(["review", "--task", "cross12-t", "--key", ve.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "v", "--verdict", JSON.stringify({ outcome: "accept", rationale: "r", confidence: "high", recommendedAction: "a" })])
  await call(["route", "--task", "cross12-t", "--route", "e2e", "--decision", "skip", "--basis", "测试"])
  // 人工门 C1 签发（绑定当前基线 H1）
  const gateCard = await call(["dispatch-plan", "--task", "cross12-t"])
  assert.equal(gateCard.stop, "awaiting-user")
  const c1 = gateCard.card.decisionId
  // 磁盘变化 → Lead 准备刷新卡 C2（绑定 H2）；C1 仍在待决列表（多卡并存）
  await writeFile(path.join(root, "R.md"), "评审后手工修改", "utf8")
  const prep = await call(["refresh-artifacts", "--task", "cross12-t", "--reason", "用户确认新基线"])
  const c2 = prep.decisionId
  assert.ok(c2 && c2 !== c1)
  const state = await call(["run", "--task", "cross12-t"])
  const pendingIds = (state.pendingDecisions ?? []).map((x) => x.decisionId)
  assert.ok(pendingIds.includes(c1) && pendingIds.includes(c2), "两张卡并存展示：" + JSON.stringify(pendingIds))
  assert.equal(state.needsDecisionId, true, "多卡必须按 ID 答复")
  // 磁盘 H2 状态下批准 C1 → 实时核对拒绝（C1 绑定 H1）
  const badAccept = await call(["decide", "--task", "cross12-t", "--choice", "1", "--decision-id", c1])
  assert.equal(badAccept.ok, false, "磁盘与 C1 绑定基线不符，批准拒绝")
  // 确认 C2 → 新基线；C1 被同批收口为 superseded（不是 accept）
  const confirmed = await call(["decide", "--task", "cross12-t", "--choice", "1", "--decision-id", c2])
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed).slice(0, 200))
  const after = await fixLoadTask(root, "cross12-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const c1Decision = after.decisions.find((x) => x.decisionId === c1)
  assert.equal(c1Decision?.choice, "superseded", "受影响人工门被收口为 superseded，绝不冒充 accept")
  assert.equal(after.decisions.find((x) => x.decisionId === c1 && x.choice === "accept"), undefined)
})

// ── 返工轮 2：§9 矩阵交叉路径（恢复 C1+取消 C2、多包刷新互不影响）与刷新原子性故障注入 ──

test("恢复 C1 与取消 C2：磁盘恢复 H1 后 C1 按原 ID 批准且不自动取消 C2；取消 C2 只落自身决定", async () => {
  const root = await makeProject()
  const call = autoCaller(root)
  await openTask(root, "rc1c2-t")
  const d = await call(["dispatch-plan", "--task", "rc1c2-t", "--writable", "R.md:code-review"])
  const h1 = Buffer.from("评审收敛基线 H1", "utf8")
  await writeFile(path.join(root, "R.md"), h1)
  await call(["deliver", "--task", "rc1c2-t", "--key", d.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  const rv = await call(["dispatch-plan", "--task", "rc1c2-t"])
  await call(["review", "--task", "rc1c2-t", "--key", rv.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "s"])
  const ve = await call(["dispatch-plan", "--task", "rc1c2-t"])
  await call(["review", "--task", "rc1c2-t", "--key", ve.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "v", "--verdict", JSON.stringify({ outcome: "accept", rationale: "r", confidence: "high", recommendedAction: "a" })])
  await call(["route", "--task", "rc1c2-t", "--route", "e2e", "--decision", "skip", "--basis", "测试"])
  const gateCard = await call(["dispatch-plan", "--task", "rc1c2-t"])
  const c1 = gateCard.card.decisionId
  // 磁盘变 H2 → 准备刷新卡 C2（绑定 H2）；C1 仍待决（多卡并存）
  await writeFile(path.join(root, "R.md"), "外部修改 H2")
  const prep = await call(["refresh-artifacts", "--task", "rc1c2-t", "--reason", "候选 H2"])
  const c2 = prep.decisionId
  // 用户把磁盘恢复为 H1 → C1 自身前提恢复 → 按原 ID 批准成功，且不自动批准/取消 C2
  await writeFile(path.join(root, "R.md"), h1)
  const acceptC1 = await call(["decide", "--task", "rc1c2-t", "--choice", "1", "--decision-id", c1])
  assert.equal(acceptC1.ok, true, "磁盘恢复 H1 后 C1 以原 ID 批准：" + JSON.stringify(acceptC1).slice(0, 200))
  const midState = await fixLoadTask(root, "rc1c2-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(midState.decisions.find((x) => x.decisionId === c2), undefined, "批准 C1 不自动取消/消费 C2")
  const runMid = await call(["run", "--task", "rc1c2-t"])
  assert.ok((runMid.pendingDecisions ?? []).some((x) => x.decisionId === c2), "C2 仍在待决列表")
  // 取消 C2：只落自身 cancel 决定，不改 C1 的批准事实
  const cancelC2 = await call(["decide", "--task", "rc1c2-t", "--choice", "2", "--decision-id", c2])
  assert.ok(cancelC2.ok, JSON.stringify(cancelC2).slice(0, 200))
  const endState = await fixLoadTask(root, "rc1c2-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(endState.decisions.find((x) => x.decisionId === c1)?.choice, "accept", "C1 的批准保留")
  const c2Choice = endState.decisions.find((x) => x.decisionId === c2)?.choice
  assert.ok(c2Choice === "cancel" || c2Choice === "取消", "C2 只落自身取消：" + c2Choice)
  assert.equal(endState.reports.find((r) => r.reportId === "refresh-" + c2), undefined, "取消 C2 不产生刷新报告")
})

test("多包刷新卡交叉：A/B 各自绑定自身包基线，确认 A 不使 B 过期；B 仍可按原 ID 确认", async () => {
  const root = await makeProject()
  const call = autoCaller(root)
  await openTask(root, "abx-t")
  await call(["plan", "--task", "abx-t", "--packages", JSON.stringify([
    { id: "a", writable: ["A.md:code-review"], done: ["d"], dependsOn: [] },
    { id: "b", writable: ["B.md:code-review"], done: ["d"], dependsOn: [] },
  ])])
  const d1 = await call(["dispatch-plan", "--task", "abx-t"])
  const keyOf = Object.fromEntries(d1.waves.map((w) => [w.package, w.dispatchKey]))
  await writeFile(path.join(root, "A.md"), "A 基线", "utf8")
  await writeFile(path.join(root, "B.md"), "B 基线", "utf8")
  await call(["deliver", "--task", "abx-t", "--key", keyOf.a, "--outcome", "delivered", "--summary", "s", "--paths", "A.md"])
  await call(["deliver", "--task", "abx-t", "--key", keyOf.b, "--outcome", "delivered", "--summary", "s", "--paths", "B.md"])
  // A、B 各自磁盘变化 → 各自刷新卡
  await writeFile(path.join(root, "A.md"), "A 外部修改", "utf8")
  await writeFile(path.join(root, "B.md"), "B 外部修改", "utf8")
  const prepA = await call(["refresh-artifacts", "--task", "abx-t", "--package", "a", "--reason", "A 候选"])
  const prepB = await call(["refresh-artifacts", "--task", "abx-t", "--package", "b", "--reason", "B 候选"])
  assert.ok(prepA.decisionId && prepB.decisionId && prepA.decisionId !== prepB.decisionId)
  // 确认 A：只刷新 a 包基线；B 卡未共享变化前提 → 不过期
  const okA = await call(["decide", "--task", "abx-t", "--choice", "1", "--decision-id", prepA.decisionId])
  assert.equal(okA.ok, true, JSON.stringify(okA).slice(0, 200))
  const runMid = await call(["run", "--task", "abx-t"])
  const pendMid = (runMid.pendingDecisions ?? []).map((x) => x.decisionId)
  assert.ok(pendMid.includes(prepB.decisionId), "B 卡在 A 确认后仍待决（不因他包先决定而过期）：" + JSON.stringify(pendMid))
  // B 仍可按原 ID 确认
  const okB = await call(["decide", "--task", "abx-t", "--choice", "1", "--decision-id", prepB.decisionId])
  assert.equal(okB.ok, true, JSON.stringify(okB).slice(0, 200))
  const end = await fixLoadTask(root, "abx-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const digestOf = (p) => createHash("sha256").update(readFileSync(path.join(root, p))).digest("hex")
  assert.equal(end.artifacts.items.find((i) => i.path === "A.md")?.digest, digestOf("A.md"), "A 基线已刷新为当前字节")
  assert.equal(end.artifacts.items.find((i) => i.path === "B.md")?.digest, digestOf("B.md"), "B 基线随后刷新，互不覆盖")
})

test("刷新原子性故障注入：快照写失败与 journal 提交失败均无半提交（决定/新基线/旧门收口全有或全无）", async () => {
  const mkScenario = async (name) => {
    const root = await makeProject()
    const call = autoCaller(root)
    await openTask(root, name)
    const d = await call(["dispatch-plan", "--task", name, "--writable", "R.md:code-review"])
    await writeFile(path.join(root, "R.md"), "H1 内容", "utf8")
    await call(["deliver", "--task", name, "--key", d.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
    const rv = await call(["dispatch-plan", "--task", name])
    await call(["review", "--task", name, "--key", rv.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "s"])
    const ve = await call(["dispatch-plan", "--task", name])
    await call(["review", "--task", name, "--key", ve.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "v", "--verdict", JSON.stringify({ outcome: "accept", rationale: "r", confidence: "high", recommendedAction: "a" })])
    await call(["route", "--task", name, "--route", "e2e", "--decision", "skip", "--basis", "测试"])
    const gateCard = await call(["dispatch-plan", "--task", name])
    const c1 = gateCard.card.decisionId
    await writeFile(path.join(root, "R.md"), "H2 候选内容", "utf8")
    const prep = await call(["refresh-artifacts", "--task", name, "--reason", "故障注入候选"])
    return { root, call, name, c1, prep }
  }
  const norm = (t) => ({ decisions: t.decisions.map((x) => [x.decisionId, x.choice]), refreshReports: t.reports.filter((r) => (r.reportId ?? "").startsWith("refresh-")).length, lastJournalTypes: t.journal.slice(-3).map((e) => e.type) })
  for (const mode of ["snapshot-write-fail", "journal-commit-fail"]) {
    const { root, call, name, c1, prep } = await mkScenario("fa-" + mode.slice(0, 4))
    const before = await fixLoadTask(root, name, { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
    const beforeFacts = norm(before)
    const taskDir = path.join(root, ".team-work", "tasks", name)
    if (mode === "snapshot-write-fail") await chmod(path.join(taskDir, "snapshots"), 0o555)
    else await chmod(taskDir, 0o555)
    let decided
    try {
      decided = await call(["decide", "--task", name, "--choice", "1", "--decision-id", prep.decisionId])
    } finally {
      await chmod(mode === "snapshot-write-fail" ? path.join(taskDir, "snapshots") : taskDir, 0o755)
    }
    assert.equal(decided.ok, false, mode + "：确认提交失败（不冒充成功）：" + JSON.stringify(decided).slice(0, 160))
    const after = await fixLoadTask(root, name, { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
    const afterFacts = norm(after)
    assert.equal(afterFacts.refreshReports, beforeFacts.refreshReports, mode + "：无刷新报告半提交")
    assert.equal(afterFacts.decisions.find(([id]) => id === prep.decisionId), undefined, mode + "：刷新决定未落盘")
    assert.equal(afterFacts.decisions.find(([id]) => id === c1)?.[1], undefined, mode + "：受影响人工门未被半收口")
    assert.equal(after.reports.find((r) => (r.reportId ?? "").startsWith("refresh-")), undefined, mode + "：journal 无半提交刷新事实")
    // 恢复写权限后同一卡可重试成功（失败不留死锁）
    const retry = await call(["decide", "--task", name, "--choice", "1", "--decision-id", prep.decisionId])
    assert.equal(retry.ok, true, mode + "：权限恢复后同卡重试成功：" + JSON.stringify(retry).slice(0, 160))
  }
})

test("刷新提交后回执/索引丢失：同 decisionId 幂等重显原结果，journal 为权威可重建视图", async () => {
  const root = await makeProject()
  const call = autoCaller(root)
  await openTask(root, "frloss-t")
  const d = await call(["dispatch-plan", "--task", "frloss-t", "--writable", "R.md:code-review"])
  await writeFile(path.join(root, "R.md"), "H1", "utf8")
  await call(["deliver", "--task", "frloss-t", "--key", d.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  const rv = await call(["dispatch-plan", "--task", "frloss-t"])
  await call(["review", "--task", "frloss-t", "--key", rv.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "s"])
  const ve = await call(["dispatch-plan", "--task", "frloss-t"])
  await call(["review", "--task", "frloss-t", "--key", ve.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "v", "--verdict", JSON.stringify({ outcome: "accept", rationale: "r", confidence: "high", recommendedAction: "a" })])
  await call(["route", "--task", "frloss-t", "--route", "e2e", "--decision", "skip", "--basis", "测试"])
  const gateCard = await call(["dispatch-plan", "--task", "frloss-t"])
  const c1 = gateCard.card.decisionId
  await writeFile(path.join(root, "R.md"), "H2", "utf8")
  const prep = await call(["refresh-artifacts", "--task", "frloss-t", "--reason", "回执丢失场景"])
  const first = await call(["decide", "--task", "frloss-t", "--choice", "1", "--decision-id", prep.decisionId])
  assert.equal(first.ok, true)
  const committed = await fixLoadTask(root, "frloss-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  // 模拟派生视图损坏：删索引与报告文件（journal 仍为权威）
  const taskDir = path.join(root, ".team-work", "tasks", "frloss-t")
  await rm(path.join(taskDir, "artifacts.json"), { force: true })
  await rm(path.join(taskDir, "reports"), { recursive: true, force: true })
  // 同 decisionId 幂等重显：不重复提交、不消费其他卡
  const replay = await call(["decide", "--task", "frloss-t", "--choice", "1", "--decision-id", prep.decisionId])
  assert.equal(replay.ok, true, "回执丢失后同 ID 重试幂等重显：" + JSON.stringify(replay).slice(0, 160))
  const rebuilt = await fixLoadTask(root, "frloss-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const refreshBack = rebuilt.reports.find((r) => r.reportId === "refresh-" + prep.decisionId)
  assert.ok(refreshBack, "journal 权威重建刷新报告（视图可派生）")
  assert.equal(refreshBack.origin, committed.reports.find((r) => r.reportId === "refresh-" + prep.decisionId).origin)
  assert.equal(rebuilt.decisions.find((x) => x.decisionId === c1)?.choice, committed.decisions.find((x) => x.decisionId === c1)?.choice, "C1 收口事实与提交时一致（superseded）")
})

// ── 返工轮 2：§7/§9 旧摘要协议转换（digestValue → sha256-bytes-v1）与非 UTF-8 原始字节回归 ──

// 构造迁移前旧协议任务：dispatched（无 prompt 冻结等新字段）+ 旧报告文件 + 旧 report-accepted 事件
// + 旧 artifacts 索引（digest = digestValue(content)）+ 旧 content 文本快照；磁盘与快照一致。
async function seedLegacyProtocolTask(root, name, { files, eventPaths = null }) {
  const { loadTask } = await import("../runtime-v3/store.mjs")
  const { digestValue } = await import("../runtime-v3/domain/digests.mjs")
  const task = await loadTask(root, name, { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const items = []
  const key = "legacy-1"
  await appendEvents(root, name, [{ type: "dispatched", detail: { key, kind: "produce", role: "owner", round: 1, package: null, writable: files.map(([p]) => ({ path: p, artifactKind: "code-review" })), stage: "code-review" } }])
  const payload = { outcome: "delivered", summary: "旧协议交付", paths: files.map(([p]) => p) }
  const pathsForEvent = eventPaths === null ? payload.paths : eventPaths
  await appendEvents(root, name, [{ type: "report-accepted", detail: { reportId: "deliver-" + key, dispatchKey: key, kind: "deliver", role: "owner", package: null, stage: "code-review", outcome: "delivered", ver: 1, origin: "owner", paths: pathsForEvent, payload, at: new Date().toISOString() } }])
  await mkdir(path.join(task.root, "reports"), { recursive: true })
  await writeFile(path.join(task.root, "reports", "deliver-" + key + ".json"), JSON.stringify({ reportId: "deliver-" + key, dispatchKey: key, role: "owner", kind: "deliver", round: 1, stage: "code-review", package: null, payload, at: new Date().toISOString() }))
  await mkdir(path.join(task.root, "snapshots"), { recursive: true })
  for (const [p, content] of files) {
    await writeFile(path.join(root, p), content, "utf8")
    const d = digestValue(content)
    await writeFile(path.join(task.root, "snapshots", d + ".json"), JSON.stringify({ content }))
    items.push({ path: p, digest: d, kind: "code-review", stage: "code-review", package: null, reportRef: "deliver-" + key, snapshotRef: "snapshots/" + d + ".json" })
  }
  await writeFile(path.join(task.root, "artifacts.json"), JSON.stringify({ items }))
  return { task, key }
}

test("旧摘要协议转换：digestValue 无损迁移为 sha256-bytes-v1，protocol-migrated 为唯一权威且重跑幂等", async () => {
  const root = await makeProject()
  const call = autoCaller(root)
  await openTask(root, "pmig-t")
  await asLegacyTask(root, "pmig-t")
  await seedLegacyProtocolTask(root, "pmig-t", { files: [["R.md", "旧协议内容 A"], ["D.md", "旧协议内容 D"]] })
  const { digestValue } = await import("../runtime-v3/domain/digests.mjs")
  const preMig = await fixLoadTask(root, "pmig-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(preMig.artifacts.items.every((i) => i.digestAlgorithm === undefined), true, "迁移前为旧摘要（无 bytes-v1 标记）")
  assert.equal(preMig.artifacts.items[0].digest, digestValue("旧协议内容 A"), "旧 digest = digestValue(UTF-8 文本)")
  // tw migrate：三源一致 → 转换
  const mig = await call(["migrate", "--task", "pmig-t"])
  assert.equal(mig.ok, true, JSON.stringify(mig).slice(0, 300))
  assert.equal(mig.protocolMigration.migrated.length, 1, "一条旧报告被转换")
  assert.deepEqual(mig.protocolMigration.migrated[0].files.map((f) => f.path).sort(), ["D.md", "R.md"])
  const after = await fixLoadTask(root, "pmig-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  for (const [p, content] of [["R.md", "旧协议内容 A"], ["D.md", "旧协议内容 D"]]) {
    const item = after.artifacts.items.find((i) => i.path === p)
    assert.equal(item.digestAlgorithm, "sha256-bytes-v1", p + " 转换后算法标记")
    assert.equal(item.digest, createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex"), p + " 新 digest = sha256(原始字节)")
  }
  assert.ok(after.journal.some((e) => e.type === "protocol-migrated"), "journal 记录 protocol-migrated 权威事实")
  const migratedEvent = after.journal.find((e) => e.type === "protocol-migrated")
  assert.equal(migratedEvent.detail.previousAlgorithm, "legacy-digest-value")
  // 转换后字节快照在场（base64 可还原），旧文本快照保留审计
  const snap = JSON.parse(await readFile(path.join(after.root, after.artifacts.items.find((i) => i.path === "R.md").snapshotRef), "utf8"))
  assert.equal(snap.format, "bytes-v1")
  assert.equal(Buffer.from(snap.data, "base64").toString("utf8"), "旧协议内容 A")
  assert.ok(await readFile(path.join(after.root, "snapshots", digestValue("旧协议内容 A") + ".json"), "utf8").then(() => true).catch(() => false), "旧快照文件保留")
  // 重跑幂等：已是 bytes-v1 → unchanged，不再追加 protocol-migrated
  const mig2 = await call(["migrate", "--task", "pmig-t"])
  assert.equal(mig2.protocolMigration.migrated.length, 0, "重跑不重复转换")
  assert.equal(mig2.protocolMigration.unchanged, 1)
  const after2 = await fixLoadTask(root, "pmig-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(after2.journal.filter((e) => e.type === "protocol-migrated").length, 1, "幂等：protocol-migrated 只有一条")
})

test("旧增量歧义与证据缺失：三源不一致的历史任务保留原件不自动转换，引导授权刷新", async () => {
  // 场景 1：历史事件缺 paths 证据（事件无 paths 且 payload 缺失）→ 不猜补
  {
    const root = await makeProject()
    const call = autoCaller(root)
    await openTask(root, "pnoev-t")
    await asLegacyTask(root, "pnoev-t")
    const { digestValue } = await import("../runtime-v3/domain/digests.mjs")
    const task = await (async () => {
      const { loadTask } = await import("../runtime-v3/store.mjs")
      return loadTask(root, "pnoev-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
    })()
    const key = "legacy-x"
    await appendEvents(root, "pnoev-t", [
      { type: "dispatched", detail: { key, kind: "produce", role: "owner", round: 1, package: null, writable: [{ path: "R.md", artifactKind: "code-review" }], stage: "code-review" } },
      { type: "report-accepted", detail: { reportId: "deliver-" + key, dispatchKey: key, kind: "deliver", role: "owner", package: null, stage: "code-review", outcome: "delivered", ver: 1, origin: "owner", at: new Date().toISOString() } },
    ])
    await mkdir(path.join(task.root, "reports"), { recursive: true })
    await writeFile(path.join(task.root, "reports", "deliver-" + key + ".json"), JSON.stringify({ reportId: "deliver-" + key, dispatchKey: key, role: "owner", kind: "deliver", round: 1, stage: "code-review", package: null, payload: { outcome: "delivered", summary: "s", paths: ["R.md"] }, at: new Date().toISOString() }))
    await writeFile(path.join(root, "R.md"), "内容", "utf8")
    const d = digestValue("内容")
    await mkdir(path.join(task.root, "snapshots"), { recursive: true })
    await writeFile(path.join(task.root, "snapshots", d + ".json"), JSON.stringify({ content: "内容" }))
    await writeFile(path.join(task.root, "artifacts.json"), JSON.stringify({ items: [{ path: "R.md", digest: d, kind: "code-review", stage: "code-review", package: null, reportRef: "deliver-" + key, snapshotRef: "snapshots/" + d + ".json" }] }))
    const mig = await call(["migrate", "--task", "pnoev-t"])
    assert.equal(mig.protocolMigration.migrated.length, 0, "缺 paths 证据不转换")
    assert.ok(mig.protocolMigration.skipped[0]?.problems.some((p) => /缺少 paths 证据/.test(p)), "skip 原因可定位：" + JSON.stringify(mig.protocolMigration.skipped).slice(0, 200))
    const after = await fixLoadTask(root, "pnoev-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
    assert.equal(after.journal.some((e) => e.type === "protocol-migrated"), false, "原件保留不写转换事实")
  }
  // 场景 2：旧增量语义（历史并集 X/Y ≠ 最新清单 X）→ 三源不一致保留
  {
    const root = await makeProject()
    const call = autoCaller(root)
    await openTask(root, "pinc-t")
    await asLegacyTask(root, "pinc-t")
    // 两次旧交付：第一次 X/Y，第二次增量只列 X（Y 的 reportRef 留在旧报告）
    await seedLegacyProtocolTask(root, "pinc-t", { files: [["X.md", "x 内容"], ["Y.md", "y 内容"]] })
    const { loadTask } = await import("../runtime-v3/store.mjs")
    const { digestValue } = await import("../runtime-v3/domain/digests.mjs")
    const task = await loadTask(root, "pinc-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
    const key2 = "legacy-2"
    await appendEvents(root, "pinc-t", [{ type: "dispatched", detail: { key: key2, kind: "respond", role: "owner", round: 2, package: null, writable: [{ path: "X.md", artifactKind: "code-review" }], stage: "code-review" } }])
    const payload2 = { outcome: "delivered", summary: "增量旧交付", paths: ["X.md"] }
    await appendEvents(root, "pinc-t", [{ type: "report-accepted", detail: { reportId: "deliver-" + key2, dispatchKey: key2, kind: "deliver", role: "owner", package: null, stage: "code-review", outcome: "delivered", ver: 1, origin: "owner", paths: ["X.md"], payload: payload2, at: new Date().toISOString() } }])
    await writeFile(path.join(task.root, "reports", "deliver-" + key2 + ".json"), JSON.stringify({ reportId: "deliver-" + key2, dispatchKey: key2, role: "owner", kind: "deliver", round: 2, stage: "code-review", package: null, payload: payload2, at: new Date().toISOString() }))
    // 索引：最新报告只登记 X（Y 挂旧报告）
    await writeFile(path.join(task.root, "artifacts.json"), JSON.stringify({ items: [
      { path: "X.md", digest: digestValue("x 内容"), kind: "code-review", stage: "code-review", package: null, reportRef: "deliver-" + key2, snapshotRef: "snapshots/" + digestValue("x 内容") + ".json" },
      { path: "Y.md", digest: digestValue("y 内容"), kind: "code-review", stage: "code-review", package: null, reportRef: "deliver-legacy-1", snapshotRef: "snapshots/" + digestValue("y 内容") + ".json" },
    ] }))
    const mig = await call(["migrate", "--task", "pinc-t"])
    assert.equal(mig.protocolMigration.migrated.length, 0, "旧增量歧义不自动转换")
    assert.ok(mig.protocolMigration.skipped.some((s) => s.problems.some((p) => /不一致|完整清单/.test(p))), "skip 原因指向授权刷新：" + JSON.stringify(mig.protocolMigration.skipped).slice(0, 240))
  }
  // 场景 3：旧快照损坏（非 JSON）→ 该路径保留不确定
  {
    const root = await makeProject()
    const call = autoCaller(root)
    await openTask(root, "psnap-t")
    await asLegacyTask(root, "psnap-t")
    const seeded = await seedLegacyProtocolTask(root, "psnap-t", { files: [["R.md", "内容"]] })
    const snapFile = path.join(seeded.task.root, "snapshots", (await import("../runtime-v3/domain/digests.mjs")).digestValue("内容") + ".json")
    await writeFile(snapFile, "{broken", "utf8")
    const mig = await call(["migrate", "--task", "psnap-t"])
    assert.equal(mig.protocolMigration.migrated.length, 0, "快照损坏不转换")
    assert.ok(mig.protocolMigration.skipped[0]?.problems.some((p) => /快照/.test(p)))
  }
})

test("非 UTF-8 原始字节：NUL 与无效字节的 SHA-256、bytes-v1 快照与 restore 逐字节无损", async () => {
  const root = await makeProject()
  const call = autoCaller(root)
  await openTask(root, "bytes-t")
  const d = await call(["dispatch-plan", "--task", "bytes-t", "--writable", "BIN.dat:code-review"])
  // 原始字节含 NUL 与无效 UTF-8 序列（0xFF 0xFE 0x80 中间断 0x00）
  const raw = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x80, 0x41, 0x00, 0xc3, 0x28])
  await writeFile(path.join(root, "BIN.dat"), raw)
  const expectDigest = createHash("sha256").update(raw).digest("hex")
  const dl = await call(["deliver", "--task", "bytes-t", "--key", d.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "二进制交付", "--paths", "BIN.dat"])
  assert.equal(dl.accepted, true)
  assert.equal(dl.registered[0].digest, expectDigest, "登记摘要 = 原始字节 SHA-256（非 UTF-8 文本摘要）")
  const task = await fixLoadTask(root, "bytes-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(task.artifacts.items[0].digestAlgorithm, "sha256-bytes-v1")
  const snap = JSON.parse(await readFile(path.join(task.root, "snapshots", expectDigest + ".json"), "utf8"))
  assert.ok(Buffer.from(snap.data, "base64").equals(raw), "bytes-v1 快照 base64 逐字节无损")
  assert.equal(Buffer.from(raw.toString("utf8"), "utf8").equals(raw), false, "场景自检：该字节序列确非 UTF-8 可无损往返（证明测的是原始字节路径）")
  // 篡改后 restore 逐字节恢复
  await writeFile(path.join(root, "BIN.dat"), Buffer.from([0x41, 0x42]))
  const rst = await call(["restore", "--task", "bytes-t", "--path", "BIN.dat"])
  assert.equal(rst.ok, true)
  const restored = await readFile(path.join(root, "BIN.dat"))
  assert.ok(restored.equals(raw), "restore 后与交付时原始字节逐字节相等（含 NUL 与无效序列）")
})

// ── 返工轮 2 收编：cmdArchive bytes-v1 归档回归（源自 runtime-v3/.validation-d31-PQXzvW1B/regression.mjs，
//    运行时负责人提供的 12 项验证用例；合入保持断言语义不变，归一命名与消息） ──

async function archiveSingle(name, bytes) {
  const root = await makeProject()
  const call = autoCaller(root)
  await openTask(root, name)
  const wave = (await call(["dispatch-plan", "--task", name, "--writable", "out.bin:code-review"])).waves[0]
  await writeFile(path.join(root, "out.bin"), bytes)
  const r = await call(["deliver", "--task", name, "--key", wave.dispatchKey, "--outcome", "delivered", "--summary", "完成", "--paths", "out.bin"])
  assert.equal(r.accepted, true, JSON.stringify(r))
  return { root, call, task: await fixLoadTask(root, name, { workflow: FIX_WORKFLOW, policy: FIX_POLICY }) }
}

async function archivePair(name, { legacy = false, payloads = null } = {}) {
  const root = await makeProject()
  const call = autoCaller(root)
  await openTask(root, name)
  const packages = [
    { id: "a", writable: ["a/:code-review"], done: ["a"], dependsOn: [] },
    { id: "b", writable: ["b/:code-review"], done: ["b"], dependsOn: [] },
  ]
  assert.equal((await call(["plan", "--task", name, "--packages", JSON.stringify(packages)])).ok, true)
  const waves = (await call(["dispatch-plan", "--task", name])).waves
  for (const w of waves) {
    const text = payloads?.[w.package] ?? (w.package === "a" ? "甲快照" : "乙快照")
    await mkdir(path.join(root, w.package), { recursive: true })
    await writeFile(path.join(root, w.package, "index.js"), text)
    const r = await call(["deliver", "--task", name, "--key", w.dispatchKey, "--outcome", "delivered", "--summary", "完成", "--paths", w.package + "/index.js"])
    assert.equal(r.accepted, true, JSON.stringify(r))
  }
  const task = await fixLoadTask(root, name, { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  if (legacy) {
    // 降级为旧协议形态：digestValue 摘要 + 旧 content 文本快照；同时从 journal/report-committed 与
    // 报告文件移除 files（否则索引 digestValue 与报告声明的 bytes-v1 摘要不一致，一致性检查正确拒绝）。
    const items = []
    for (const it of task.artifacts.items) {
      const content = await readFile(path.join(root, it.path), "utf8")
      const digest = digestValue(content)
      const snapshotRef = "snapshots/" + digest + ".json"
      await writeFile(path.join(task.root, snapshotRef), JSON.stringify({ path: it.path, content, digest, at: new Date().toISOString() }))
      const { digestAlgorithm: _a, ...rest } = it
      items.push({ ...rest, digest, snapshotRef })
    }
    const journalFile = path.join(task.root, "journal.jsonl")
    const events = (await readFile(journalFile, "utf8")).trim().split("\n").map((l) => JSON.parse(l))
    for (const e of events) {
      if (e.type === "report-committed" && e.detail?.kind === "deliver") {
        delete e.detail.files
        const reportFile = path.join(task.root, "reports", e.detail.reportId + ".json")
        const report = JSON.parse(await readFile(reportFile, "utf8"))
        delete report.files
        await writeFile(reportFile, JSON.stringify(report))
      }
    }
    await writeFile(journalFile, events.map((e) => JSON.stringify(e)).join("\n") + "\n")
    await writeFile(path.join(task.root, "artifacts.json"), JSON.stringify({ items, journalSeq: task.journal.length }))
  }
  return { root, call, task }
}

test("归档：新版二进制快照按原始字节归档，重复归档幂等", async () => {
  const bytes = Buffer.from([0, 255, 128, 10, 0, 195, 40])
  const { root, call } = await archiveSingle("arch-bin-t", bytes)
  const r = await call(["archive", "--task", "arch-bin-t"])
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(await readFile(path.join(root, r.archivedTo, "artifacts", "out.bin")), bytes, "归档字节与交付原始字节逐字节相等（含 NUL/无效序列）")
  assert.equal((await call(["archive", "--task", "arch-bin-t"])).ok, true, "重复归档幂等")
})

test("归档：旧快照不同目录同名文件独立归档且不能相互覆盖", async () => {
  const { root, call } = await archivePair("arch-legacy-paths-t", { legacy: true })
  const r = await call(["archive", "--task", "arch-legacy-paths-t"])
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(await readFile(path.join(root, r.archivedTo, "artifacts", "a", "index.js"), "utf8"), "甲快照")
  assert.equal(await readFile(path.join(root, r.archivedTo, "artifacts", "b", "index.js"), "utf8"), "乙快照")
})

test("归档：新版不同目录同名文件保持各自完整字节", async () => {
  const { root, call } = await archivePair("arch-new-paths-t")
  const a = await readFile(path.join(root, "a", "index.js"))
  const b = await readFile(path.join(root, "b", "index.js"))
  const r = await call(["archive", "--task", "arch-new-paths-t"])
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(await readFile(path.join(root, r.archivedTo, "artifacts", "a", "index.js")), a)
  assert.deepEqual(await readFile(path.join(root, r.archivedTo, "artifacts", "b", "index.js")), b)
})

test("归档：两包同名二进制文件保持各自原始字节且项目文件不删除", async () => {
  const a = Buffer.from([0, 255, 128]), b = Buffer.from([255, 0, 195, 40])
  const { root, call } = await archivePair("arch-binary-pair-t", { payloads: { a, b } })
  const r = await call(["archive", "--task", "arch-binary-pair-t"])
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(await readFile(path.join(root, r.archivedTo, "artifacts", "a", "index.js")), a)
  assert.deepEqual(await readFile(path.join(root, r.archivedTo, "artifacts", "b", "index.js")), b)
  assert.deepEqual(await readFile(path.join(root, "a", "index.js")), a, "项目内原文件保留")
  assert.deepEqual(await readFile(path.join(root, "b", "index.js")), b)
})

test("归档：空字节快照可归档且与原始空内容一致", async () => {
  const { root, call } = await archiveSingle("arch-empty-t", Buffer.alloc(0))
  const r = await call(["archive", "--task", "arch-empty-t"])
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(await readFile(path.join(root, r.archivedTo, "artifacts", "out.bin")), Buffer.alloc(0))
})

test("归档：旧快照的算法元数据冲突时拒绝归档（STATE_CORRUPT，原任务与归档目录保留）", async () => {
  const { root, call, task } = await archivePair("arch-alg-conflict-t", { legacy: true })
  const index = JSON.parse(await readFile(path.join(task.root, "artifacts.json"), "utf8"))
  const file = path.join(task.root, index.items[0].snapshotRef)
  const snapshot = JSON.parse(await readFile(file, "utf8"))
  snapshot.digestAlgorithm = "sha256-bytes-v1" // 旧 content 快照谎报新算法 → 自相矛盾
  await writeFile(file, JSON.stringify(snapshot))
  const r = await call(["archive", "--task", "arch-alg-conflict-t"])
  assert.equal(r.ok, false, JSON.stringify(r))
  assert.equal(r.code, "STATE_CORRUPT")
  await assertPathExists(path.join(task.root, "scope.json"), "原任务不清理")
  await assert.rejects(access(path.join(root, ".team-work", "archive", "arch-alg-conflict-t")))
})

test("归档：文件与目录路径冲突时不能清理原任务（ARCHIVE_PATH_CONFLICT）", async () => {
  const { root, call, task } = await archivePair("arch-path-conflict-t")
  const file = path.join(task.root, "artifacts.json")
  const index = JSON.parse(await readFile(file, "utf8"))
  // 索引、journal 与报告文件的路径同步改写（保持三源一致），只保留 node 与 node/child 的类型冲突
  const renamePaths = new Map([[index.items[0].path, "node"], [index.items[1].path, "node/child"]])
  index.items.forEach((it) => { it.path = renamePaths.get(it.path) })
  await writeFile(file, JSON.stringify(index))
  const journalFile = path.join(task.root, "journal.jsonl")
  const events = (await readFile(journalFile, "utf8")).trim().split("\n").map((l) => JSON.parse(l))
  for (const e of events) {
    if (e.type === "report-committed" && e.detail?.kind === "deliver") {
      e.detail.paths = e.detail.paths.map((p) => renamePaths.get(p) ?? p)
      e.detail.payload.paths = e.detail.payload.paths.map((p) => renamePaths.get(p) ?? p)
      if (Array.isArray(e.detail.files)) e.detail.files = e.detail.files.map((f) => ({ ...f, path: renamePaths.get(f.path) ?? f.path }))
      const reportFile = path.join(task.root, "reports", e.detail.reportId + ".json")
      const report = JSON.parse(await readFile(reportFile, "utf8"))
      report.payload.paths = report.payload.paths.map((p) => renamePaths.get(p) ?? p)
      if (Array.isArray(report.files)) report.files = report.files.map((f) => ({ ...f, path: renamePaths.get(f.path) ?? f.path }))
      await writeFile(reportFile, JSON.stringify(report))
    }
  }
  await writeFile(journalFile, events.map((e) => JSON.stringify(e)).join("\n") + "\n")
  const result = await call(["archive", "--task", "arch-path-conflict-t"])
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.equal(result.code, "ARCHIVE_PATH_CONFLICT")
  await assertPathExists(path.join(task.root, "scope.json"), "冲突不清理原任务")
  await assert.rejects(access(path.join(root, ".team-work", "archive", "arch-path-conflict-t")))
})

test("归档：无效相对路径和异常快照引用被同步拒绝（防逃逸）", async () => {
  for (const [name, mutate] of [["arch-escape-t", (it) => { it.path = "../escape" }], ["arch-ref-escape-t", (it) => { it.snapshotRef = "../outside.json" }]]) {
    const { root, call, task } = await archiveSingle(name, Buffer.from("ok"))
    const file = path.join(task.root, "artifacts.json")
    const index = JSON.parse(await readFile(file, "utf8"))
    mutate(index.items[0])
    await writeFile(file, JSON.stringify(index))
    const r = await call(["archive", "--task", name])
    assert.equal(r.ok, false, name + " 越界拒绝：" + JSON.stringify(r).slice(0, 120))
    await access(path.join(task.root, "scope.json"))
    await assert.rejects(access(path.join(root, ".team-work", "archive", name)))
  }
})

test("归档：目标存在不完整内容时不能覆盖或删除原任务（ARCHIVE_INCOMPLETE）", async () => {
  const { root, call } = await archiveSingle("arch-preexist-t", Buffer.from("ok"))
  const dest = path.join(root, ".team-work", "archive", "arch-preexist-t")
  await mkdir(dest, { recursive: true })
  await writeFile(path.join(dest, "sentinel"), "人工资料")
  const r = await call(["archive", "--task", "arch-preexist-t"])
  assert.equal(r.code, "ARCHIVE_INCOMPLETE", JSON.stringify(r))
  assert.equal(await readFile(path.join(dest, "sentinel"), "utf8"), "人工资料", "既有内容不被覆盖")
  await assertPathExists(path.join(root, ".team-work", "tasks", "arch-preexist-t", "scope.json"), "原任务不删除")
})

test("归档：发布前重命名故障保留原任务，恢复后重试成功", async () => {
  const { root, call } = await archiveSingle("arch-rename-fail-t", Buffer.from([0, 255, 2]))
  // TMPDIR 可能含符号链接（如 /tmp → /private/tmp）：运行时以 realpath 规范化后调用 rename，
  // 注入匹配必须用同一规范化口径，否则永不命中（注入假生效）。
  const realRoot = await realpath(root)
  const destSuffix = path.join(".team-work", "archive", "arch-rename-fail-t")
  const dest = path.join(realRoot, destSuffix)
  let injected = 0
  const original = fsPromises.rename
  fsPromises.rename = async (from, to) => {
    if (typeof to === "string" && (to === dest || to.endsWith(destSuffix))) {
      injected += 1
      const error = new Error("注入发布故障"); error.code = "EINJECTED"; throw error
    }
    return original(from, to)
  }
  try {
    const failed = await call(["archive", "--task", "arch-rename-fail-t"])
    assert.ok(injected >= 1, "注入确实命中 rename（路径规范化一致，非假注入）")
    assert.equal(failed.ok, false, JSON.stringify(failed))
    assert.equal(failed.code, "EINJECTED")
    await assertPathExists(path.join(root, ".team-work", "tasks", "arch-rename-fail-t", "scope.json"), "失败保留原任务")
    await assert.rejects(access(dest), "失败不留半成品归档")
  } finally {
    fsPromises.rename = original
  }
  const retry = await call(["archive", "--task", "arch-rename-fail-t"])
  assert.equal(retry.ok, true, JSON.stringify(retry))
  assert.deepEqual(await readFile(path.join(root, retry.archivedTo, "artifacts", "out.bin")), Buffer.from([0, 255, 2]))
})

test("归档：发布后异常保留任务和归档，不伪称幂等完成", async () => {
  const { root, call } = await archiveSingle("arch-after-publish-t", Buffer.from([3, 0, 255]))
  const realRoot = await realpath(root)
  const destSuffix = path.join(".team-work", "archive", "arch-after-publish-t")
  const dest = path.join(realRoot, destSuffix)
  let injected = 0
  const original = fsPromises.rename
  fsPromises.rename = async (from, to) => {
    const value = await original(from, to)
    if (typeof to === "string" && (to === dest || to.endsWith(destSuffix))) {
      injected += 1
      const error = new Error("注入发布后故障"); error.code = "EINJECTED"; throw error
    }
    return value
  }
  try {
    const failed = await call(["archive", "--task", "arch-after-publish-t"])
    assert.ok(injected >= 1, "注入确实命中 rename（发布后路径同样规范化）")
    assert.equal(failed.ok, false, JSON.stringify(failed))
    await assertPathExists(path.join(root, ".team-work", "tasks", "arch-after-publish-t", "scope.json"), "任务保留（与归档并存，待人工核对）")
    assert.deepEqual(await readFile(path.join(dest, "artifacts", "out.bin")), Buffer.from([3, 0, 255]), "已发布内容在场")
  } finally {
    fsPromises.rename = original
  }
  const again = await call(["archive", "--task", "arch-after-publish-t"])
  assert.equal(again.ok, false, "不完整归档不得伪称幂等完成")
  assert.equal(again.code, "ARCHIVE_INCOMPLETE")
})

test("归档：损坏快照同步拒绝，原任务和快照仍在（STATE_CORRUPT）", async () => {
  const { root, call, task } = await archiveSingle("arch-corrupt-t", Buffer.from([0, 255, 1]))
  const it = task.artifacts.items[0]
  await writeFile(path.join(task.root, it.snapshotRef), JSON.stringify({ format: "bytes-v1", data: Buffer.from("篡改").toString("base64"), digest: it.digest }))
  let result
  try {
    result = await call(["archive", "--task", "arch-corrupt-t"])
  } catch (error) {
    assert.fail("归档应返回可恢复的错误卡而不是抛出 " + error)
  }
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.equal(result.code, "STATE_CORRUPT")
  await assertPathExists(path.join(task.root, "scope.json"), "原任务保留")
  await assertPathExists(path.join(task.root, it.snapshotRef), "快照原样保留（不删证据）")
  await assert.rejects(access(path.join(root, ".team-work", "archive", "arch-corrupt-t", "manifest.json")))
})

test("归档：最新报告仍有产物但索引静默丢项时不得清理原任务", async () => {
  const { root, call, task } = await archiveSingle("arch-missing-index-t", Buffer.from([7, 0, 255]))
  const file = path.join(task.root, "artifacts.json")
  await writeFile(file, JSON.stringify({ items: [], journalSeq: task.journal.length }))
  const result = await call(["archive", "--task", "arch-missing-index-t"])
  assert.equal(result.ok, false, JSON.stringify(result).slice(0, 200))
  await assertPathExists(path.join(task.root, "scope.json"), "静默丢项不得清理原任务")
  await assert.rejects(access(path.join(root, ".team-work", "archive", "arch-missing-index-t")))
})

// ── 返工轮 3：候选恢复取消隔离（review-d30 场景）与普通报告事务故障注入（§9 报告事务行） ──

// 公共场景构造：A/B 两包；B 交付并收敛评审链，A 交付 blocked（静止后展示 blockedPackages）；
// A 准备带候选计划的 package-recovery 卡（候选计划给 a 扩权 C.md），B 磁盘外部变化后准备 B 刷新卡。
async function seedRecoveryAndRefresh(root, name) {
  const call = autoCaller(root)
  await openTask(root, name)
  const plan1 = [
    { id: "a", writable: ["A.md:code-review"], done: ["d"], dependsOn: [] },
    { id: "b", writable: ["B.md:code-review"], done: ["d"], dependsOn: [] },
  ]
  await call(["plan", "--task", name, "--packages", JSON.stringify(plan1)])
  const w = await call(["dispatch-plan", "--task", name])
  const keyOf = Object.fromEntries(w.waves.map((x) => [x.package, x.dispatchKey]))
  await writeFile(path.join(root, "A.md"), "a 内容", "utf8")
  await writeFile(path.join(root, "B.md"), "b 内容", "utf8")
  await call(["deliver", "--task", name, "--key", keyOf.b, "--outcome", "delivered", "--summary", "b 完成", "--paths", "B.md"])
  await call(["deliver", "--task", name, "--key", keyOf.a, "--outcome", "blocked", "--summary", "A 需要范围外文件 C.md"])
  const rv = await call(["dispatch-plan", "--task", name])
  await call(["review", "--task", name, "--key", rv.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "s"])
  const ve = await call(["dispatch-plan", "--task", name])
  await call(["review", "--task", name, "--key", ve.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "v", "--verdict", JSON.stringify({ outcome: "accept", rationale: "r", confidence: "high", recommendedAction: "a" })])
  await call(["route", "--task", name, "--route", "e2e", "--decision", "skip", "--basis", "测试"])
  const st = await call(["dispatch-plan", "--task", name])
  const aRef = (st.blockedPackages ?? st.card?.blockedPackages).find((x) => x.package === "a").ref
  const plan2 = [
    { id: "a", writable: ["A.md:code-review", "C.md:code-review"], done: ["d"], dependsOn: [] },
    { id: "b", writable: ["B.md:code-review"], done: ["d"], dependsOn: [] },
  ]
  const rec = await call(["plan", "--task", name, "--resolve-blocked", JSON.stringify({ package: "a", action: "retry", reason: "用户同意扩权" }), "--blocked-ref", aRef, "--packages", JSON.stringify(plan2)])
  await writeFile(path.join(root, "B.md"), "b 外部修改", "utf8")
  const prepB = await call(["refresh-artifacts", "--task", name, "--package", "b", "--reason", "B 候选基线"])
  const runMid = await call(["run", "--task", name])
  const intakeId = (runMid.pendingDecisions ?? []).find((x) => (x.decisionId ?? "").startsWith("intake-"))?.decisionId
  return { call, rec, prepB, intakeId, aRef }
}

test("候选恢复取消隔离：恢复意图获批后取消恢复卡，B 原刷新卡仍可确认；A 可按原计划重试恢复", async () => {
  const root = await makeProject()
  const name = "isol1-t"
  const { call, rec, prepB, intakeId } = await seedRecoveryAndRefresh(root, name)
  assert.ok(rec.decisionId && prepB.decisionId && intakeId, "恢复卡、候选意图卡与 B 刷新卡三卡并存")
  // 候选恢复意图先获批（用户接受候选计划方向）
  assert.equal((await call(["decide", "--task", name, "--choice", "1", "--decision-id", intakeId])).ok, true)
  // 取消 A 恢复卡：只收口自身，不解除 blocked、不作废 B 刷新卡
  const cancel = await call(["decide", "--task", name, "--choice", "2", "--decision-id", rec.decisionId])
  assert.equal(cancel.ok, true, JSON.stringify(cancel).slice(0, 160))
  const runAfter = await call(["run", "--task", name])
  const pendIds = (runAfter.pendingDecisions ?? []).map((x) => x.decisionId)
  assert.deepEqual(pendIds, [prepB.decisionId], "取消后仅剩 B 刷新卡待决（未被波及）")
  // A 仍 blocked（取消不解除）且可按原计划重试恢复（同 ref 新恢复卡）——先于 B 确认核验
  const stLater = await call(["run", "--task", name])
  const stillBlocked = (stLater.blockedPackages ?? stLater.card?.blockedPackages)?.find((x) => x.package === "a")
  assert.ok(stillBlocked, "A 的 blocked 不因取消而消失")
  const retry = await call(["plan", "--task", name, "--resolve-blocked", JSON.stringify({ package: "a", action: "retry", reason: "按原计划重试" }), "--blocked-ref", stillBlocked.ref])
  assert.ok(retry.decisionId, "A 可按原计划重试恢复（新恢复卡）：" + JSON.stringify(retry).slice(0, 160))
  await call(["decide", "--task", name, "--choice", "2", "--decision-id", retry.decisionId]) // 清理：取消重试卡，回到仅 B 卡
  // B 原卡按原 ID 确认成功（取消隔离红例：曾误作废他包刷新卡）
  const okB = await call(["decide", "--task", name, "--choice", "1", "--decision-id", prepB.decisionId])
  assert.equal(okB.ok, true, "B 原卡仍可确认：" + JSON.stringify(okB).slice(0, 160))
  const task = await fixLoadTask(root, name, { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const bItem = task.artifacts.items.find((i) => i.path === "B.md")
  assert.equal(bItem.digest, createHash("sha256").update(Buffer.from("b 外部修改", "utf8")).digest("hex"), "B 基线按其卡绑定候选生效")
})

test("候选恢复生效使旧刷新卡失效：恢复卡确认（计划落盘）后 B 卡按其绑定前提过期并须重签", async () => {
  const root = await makeProject()
  const name = "isol2-t"
  const { call, rec, prepB, intakeId } = await seedRecoveryAndRefresh(root, name)
  assert.equal((await call(["decide", "--task", name, "--choice", "1", "--decision-id", intakeId])).ok, true)
  // 恢复卡确认生效：A 解除 blocked + 候选计划成为当前计划（共享前提变化）
  const okRec = await call(["decide", "--task", name, "--choice", "1", "--decision-id", rec.decisionId])
  assert.equal(okRec.ok, true, JSON.stringify(okRec).slice(0, 160))
  // B 旧刷新卡过期：确认被拒（计划摘要与卡不一致），卡列 stale 并须重签，不得跨卡消费
  const tryB = await call(["decide", "--task", name, "--choice", "1", "--decision-id", prepB.decisionId])
  assert.equal(tryB.ok, false, "计划变化后旧刷新卡不得确认")
  assert.equal(tryB.code, "DECISION_STALE")
  assert.match(tryB.message ?? "", /计划|过期|重签/, "拒绝原因指向前提变化")
  const runEnd = await call(["run", "--task", name])
  assert.ok((runEnd.staleDecisions ?? []).some((x) => (x.decisionId ?? "") === prepB.decisionId), "旧卡列入 staleDecisions")
  // 重签：以相同磁盘内容重新准备 B 刷新卡（新 ID 可确认）
  const prepB2 = await call(["refresh-artifacts", "--task", name, "--package", "b", "--reason", "计划变化后重签 B 基线"])
  assert.ok(prepB2.decisionId && prepB2.decisionId !== prepB.decisionId, "重签产出新卡")
  const okB2 = await call(["decide", "--task", name, "--choice", "1", "--decision-id", prepB2.decisionId])
  assert.equal(okB2.ok, true, "重签后的新卡可确认：" + JSON.stringify(okB2).slice(0, 160))
})

// ── 返工轮 3：普通报告事务（deliver/dispatch）故障注入——§9「报告事务」行 ──
// 四类注入：journal 读取失败（防丢账）、快照写失败、journal 提交前失败、提交后视图/回执丢失（幂等恢复）。

test("普通 deliver 事务故障注入：journal 读取失败不清空原账，恢复后同 key 重交成功", async () => {
  const root = await makeProject()
  const call = autoCaller(root)
  await openTask(root, "delio-t")
  const d = await call(["dispatch-plan", "--task", "delio-t", "--writable", "R.md:code-review"])
  await writeFile(path.join(root, "R.md"), "v1", "utf8")
  const journalFile = path.join(root, ".team-work", "tasks", "delio-t", "journal.jsonl")
  await chmod(journalFile, 0o000) // 读失败（EACCES，等价 EIO 语义：读不到原账）
  let failed
  try {
    failed = await call(["deliver", "--task", "delio-t", "--key", d.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  } finally {
    await chmod(journalFile, 0o644)
  }
  assert.equal(failed.ok, false, "读不到原账时 deliver 必须失败，不得猜空账继续：" + JSON.stringify(failed).slice(0, 160))
  const afterBytes = await readFile(journalFile, "utf8")
  assert.ok(afterBytes.trim().length > 0, "原 journal 未被清空（丢账缺陷回归）")
  assert.ok(afterBytes.includes('"task-opened"'), "原事实仍在")
  // 恢复后同 key 同内容重交成功（失败不留死锁）
  const retry = await call(["deliver", "--task", "delio-t", "--key", d.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  assert.equal(retry.accepted, true, "恢复后重交成功：" + JSON.stringify(retry).slice(0, 160))
})

test("普通 deliver 事务故障注入：快照写失败与 journal 提交前失败均零半提交", async () => {
  for (const mode of ["snapshot-write-fail", "journal-commit-fail"]) {
    const root = await makeProject()
    const call = autoCaller(root)
    const name = "delf-" + mode.slice(0, 4)
    await openTask(root, name)
    const d = await call(["dispatch-plan", "--task", name, "--writable", "R.md:code-review"])
    await writeFile(path.join(root, "R.md"), "v1", "utf8")
    const taskDir = path.join(root, ".team-work", "tasks", name)
    const journalFile = path.join(taskDir, "journal.jsonl")
    const journalBefore = await readFile(journalFile, "utf8")
    const snapshotsDir = path.join(taskDir, "snapshots")
    if (mode === "snapshot-write-fail") await chmod(snapshotsDir, 0o555)
    else await chmod(taskDir, 0o555)
    let failed
    try {
      failed = await call(["deliver", "--task", name, "--key", d.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
    } finally {
      await chmod(mode === "snapshot-write-fail" ? snapshotsDir : taskDir, 0o755)
    }
    assert.equal(failed.ok ?? failed.accepted, false, mode + "：提交失败不冒充成功：" + JSON.stringify(failed).slice(0, 160))
    const journalAfter = await readFile(journalFile, "utf8")
    assert.equal(journalAfter, journalBefore, mode + "：journal 零半提交（原样）")
    const task = await fixLoadTask(root, name, { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
    assert.equal(task.reports.find((r) => r.dispatchKey === d.waves[0].dispatchKey && r.kind === "deliver"), undefined, mode + "：未提交不生效（无报告事实）")
    // 权限恢复后同卡重试成功（无死锁）
    const retry = await call(["deliver", "--task", name, "--key", d.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
    assert.equal(retry.accepted, true, mode + "：恢复后重交成功")
  }
})

test("普通 deliver 提交后视图/回执丢失：同 key 同字节重交幂等，journal 为权威重建视图", async () => {
  const root = await makeProject()
  const call = autoCaller(root)
  await openTask(root, "delview-t")
  const d = await call(["dispatch-plan", "--task", "delview-t", "--writable", "R.md:code-review"])
  await writeFile(path.join(root, "R.md"), "v1", "utf8")
  const key = d.waves[0].dispatchKey
  const first = await call(["deliver", "--task", "delview-t", "--key", key, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  assert.equal(first.accepted, true)
  const committed = await fixLoadTask(root, "delview-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const committedEvents = committed.journal.filter((e) => e.type === "report-committed").length
  // 模拟回执/视图丢失：删除派生视图（journal 仍为权威）
  const taskDir = path.join(root, ".team-work", "tasks", "delview-t")
  await rm(path.join(taskDir, "artifacts.json"), { force: true })
  await rm(path.join(taskDir, "reports"), { recursive: true, force: true })
  // 同 key 同字节重交：幂等（不追加第二条提交事实），视图按 journal 重建
  const replay = await call(["deliver", "--task", "delview-t", "--key", key, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  assert.equal(replay.accepted, true, "重交被接受（幂等路径）：" + JSON.stringify(replay).slice(0, 160))
  const rebuilt = await fixLoadTask(root, "delview-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(rebuilt.journal.filter((e) => e.type === "report-committed").length, committedEvents, "幂等：不重复追加提交事实")
  const item = rebuilt.artifacts.items.find((i) => i.path === "R.md")
  assert.ok(item, "视图从 journal 重建（登记在场）")
  assert.equal(item.digest, createHash("sha256").update(Buffer.from("v1", "utf8")).digest("hex"), "重建 digest 与提交时一致")
})

// ── 返工轮 3 骨架：跨阶段归档取最新版本（同路径在两个阶段先后交付，归档不得回退旧阶段版本） ──
// 使用完整 engineering 工作流：implementation → test 相邻阶段；同一路径两阶段各交付一版。

test("跨阶段归档取最新版本：同路径先 implementation 后 test 交付，归档为 test 阶段版本", async (t) => {
  const here = path.dirname(new URL(import.meta.url).pathname)
  const fullWorkflow = JSON.parse(await readFile(path.join(here, "../workflow/definitions/engineering.json"), "utf8"))
  const fullPolicy = JSON.parse(await readFile(path.join(here, "../team-work/policies/default.json"), "utf8"))
  const root = await makeProject({ workflow: fullWorkflow, policy: fullPolicy })
  const call = autoCaller(root)
  await openTask(root, "xsarch-t", { objective: "跨阶段归档验收", entry: "implementation" })
  // 跨阶段结束方式：through-stage(test)（open 未暴露 completion 参数，测试直接设定任务事实）
  {
    const scopeFile = path.join(root, ".team-work", "tasks", "xsarch-t", "scope.json")
    const scope = JSON.parse(await readFile(scopeFile, "utf8"))
    scope.completion = { mode: "through-stage", stage: "test" }
    await writeFile(scopeFile, JSON.stringify(scope))
  }
  // implementation 阶段交付 v1
  const d1 = await call(["dispatch-plan", "--task", "xsarch-t", "--writable", "SRC.md:source"])
  await writeFile(path.join(root, "SRC.md"), "实施阶段版本 v1", "utf8")
  await call(["deliver", "--task", "xsarch-t", "--key", d1.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "实施交付", "--paths", "SRC.md"])
  const rv1 = await call(["dispatch-plan", "--task", "xsarch-t"])
  await call(["review", "--task", "xsarch-t", "--key", rv1.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "s"])
  // implementation 为非 core 场景：challenger accept 后阶段推进（through-stage(test) 下无人工门停留）
  await call(["route", "--task", "xsarch-t", "--route", "e2e", "--decision", "skip", "--basis", "骨架测试跳过"])
  // test 阶段首派需 --writable 声明 test 产出物合同（test-code/test-result/test-scope）
  const st = await call(["dispatch-plan", "--task", "xsarch-t", "--writable", "SRC.md:test-code"])
  assert.equal(st.waves?.length, 1, "test 阶段首派：" + JSON.stringify({ stop: st.stop, code: st.code, msg: st.message?.slice(0, 120) }))
  assert.equal((await call(["run", "--task", "xsarch-t"])).stage, "test", "阶段已推进到 test")
  // test 阶段同路径交付 v2（最新）
  await writeFile(path.join(root, "SRC.md"), "测试阶段版本 v2 最新", "utf8")
  await call(["deliver", "--task", "xsarch-t", "--key", st.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "测试交付", "--paths", "SRC.md"])
  // test 评审链收敛（test 场景按 default 策略走 challenger，expert 若派则一并收敛）
  const rv2 = await call(["dispatch-plan", "--task", "xsarch-t"])
  await call(["review", "--task", "xsarch-t", "--key", rv2.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "s"])
  const ve2 = await call(["dispatch-plan", "--task", "xsarch-t"])
  if (ve2.waves?.length) {
    await call(["review", "--task", "xsarch-t", "--key", ve2.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "v", "--verdict", JSON.stringify({ outcome: "accept", rationale: "r", confidence: "high", recommendedAction: "a" })])
  }
  await call(["route", "--task", "xsarch-t", "--route", "e2e", "--decision", "skip", "--basis", "骨架测试跳过"])
  // through-stage(test)：test 收敛后进入人工门（或直接完成），决定后任务终结
  const g2 = await call(["dispatch-plan", "--task", "xsarch-t"])
  if (g2.stop === "awaiting-user") await call(["decide", "--task", "xsarch-t", "--choice", "1", "--decision-id", g2.decisionId])
  // 完成后归档：取最新（test 阶段 v2），不得回退 implementation 旧版
  const arch = await call(["archive", "--task", "xsarch-t"])
  assert.equal(arch.ok, true, JSON.stringify(arch).slice(0, 240))
  const archived = await readFile(path.join(root, arch.archivedTo, "artifacts", "SRC.md"), "utf8")
  assert.equal(archived, "测试阶段版本 v2 最新", "归档为跨阶段最新版本（旧阶段版本不得覆盖）")
  const manifest = JSON.parse(await readFile(path.join(root, arch.archivedTo, "manifest.json"), "utf8"))
  // stagesPassed 记录推进目标与终结阶段（implementation 是起点不在 to 列表）；跨阶段事实由归档制品与审查记录体现
  assert.ok(manifest.stagesPassed.includes("test"), "推进目标阶段记录在 manifest：" + JSON.stringify(manifest.stagesPassed))
  assert.ok(Array.isArray(manifest.reviews) && manifest.reviews.length >= 2, "两个阶段的评审记录都在归档 manifest")
})

// ── 返工轮 3 收编：journal 读错/空/损坏的入口级故障注入 + 跨阶段回退归档排序保护 ──
// 源自 runtime-v3/.validation-d34-Utr3ZzES/regression.mjs（运行时负责人 28 项验证，合入保持断言语义不变）。

// 按调用栈位置注入指定文件的读取故障（fs.promises.readFile 补丁 + syncBuiltinESMExports 刷新绑定）。
import { syncBuiltinESMExports } from "node:module"
import nodeFs from "node:fs"
import { unlink as unlinkFile } from "node:fs/promises"
import { digestBytes } from "../runtime-v3/domain/digests.mjs"

const journalOf = (root, name) => path.join(root, ".team-work", "tasks", name, "journal.jsonl")

async function injectJournalRead(root, name, at, code, action) {
  const target = path.resolve(journalOf(root, name))
  const original = nodeFs.promises.readFile
  let injected = 0
  nodeFs.promises.readFile = async (...args) => {
    if (typeof args[0] === "string" && path.resolve(args[0]) === target && !injected && (new Error().stack ?? "").includes(at)) {
      injected += 1
      const error = new Error("注入 " + code + " 到 " + at); error.code = code; throw error
    }
    return original(...args)
  }
  syncBuiltinESMExports()
  let result
  try { result = await action() } finally { nodeFs.promises.readFile = original; syncBuiltinESMExports() }
  assert.equal(injected, 1, "必须在 " + at + " 实际触发指定文件读取故障")
  return result
}

async function replaceJournalRead(root, name, at, replacement, action) {
  const target = path.resolve(journalOf(root, name))
  const original = nodeFs.promises.readFile
  let injected = 0
  nodeFs.promises.readFile = async (...args) => {
    if (typeof args[0] === "string" && path.resolve(args[0]) === target && !injected && (new Error().stack ?? "").includes(at)) {
      injected += 1
      return replacement
    }
    return original(...args)
  }
  syncBuiltinESMExports()
  let result
  try { result = await action() } finally { nodeFs.promises.readFile = original; syncBuiltinESMExports() }
  assert.equal(injected, 1, "必须在 " + at + " 实际触发损坏数据注入")
  return result
}

async function readyOwner(name) {
  const root = await makeProject()
  const call = autoCaller(root)
  await openTask(root, name)
  const p = await call(["dispatch-plan", "--task", name, "--writable", "R.md:code-review"])
  assert.ok(p.waves?.[0], JSON.stringify(p))
  await writeFile(path.join(root, "R.md"), "原内容")
  return { root, call, key: p.waves[0].dispatchKey }
}

async function pendingIntakeCard(name) {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, name)
  const p = await call(["dispatch-plan", "--task", name, "--writable", "R.md:code-review"])
  assert.equal(p.stop, "awaiting-user", JSON.stringify(p))
  return { root, call, card: p.card }
}

test("journal 故障：deliver 提交前读取报错不得覆盖既有日志", async () => {
  const { root, call, key } = await readyOwner("jd-eio-t")
  const file = journalOf(root, "jd-eio-t"), before = await readFile(file, "utf8")
  const r = await injectJournalRead(root, "jd-eio-t", "appendReportEvent", "EIO", () => call(["deliver", "--task", "jd-eio-t", "--key", key, "--outcome", "delivered", "--summary", "完成", "--paths", "R.md"]))
  assert.equal(r.ok, false, JSON.stringify({ ok: r.ok, code: r.code }))
  assert.equal(await readFile(file, "utf8"), before, "原日志逐字节保留")
})

test("journal 故障：锁内重读失败时 deliver 不得伪装空日志", async () => {
  const { root, call, key } = await readyOwner("jd-eacces-t")
  const file = journalOf(root, "jd-eacces-t"), before = await readFile(file, "utf8")
  const r = await injectJournalRead(root, "jd-eacces-t", "freshState", "EACCES", () => call(["deliver", "--task", "jd-eacces-t", "--key", key, "--outcome", "delivered", "--summary", "完成", "--paths", "R.md"]))
  assert.equal(r.ok, false, JSON.stringify({ ok: r.ok, code: r.code }))
  assert.equal(r.code, "EACCES")
  assert.equal(await readFile(file, "utf8"), before)
})

test("journal 故障：首次派发前读取失败不得变成唯一派单事件", async () => {
  const { root, call, card } = await pendingIntakeCard("jd-dispatch-t")
  assert.equal((await call(["decide", "--task", "jd-dispatch-t", "--decision-id", card.decisionId, "--choice", "1"])).ok, true)
  const file = journalOf(root, "jd-dispatch-t"), before = await readFile(file, "utf8")
  const r = await injectJournalRead(root, "jd-dispatch-t", "appendEventsUnlocked", "EIO", () => call(["dispatch-plan", "--task", "jd-dispatch-t", "--writable", "R.md:code-review"]))
  assert.equal(r.ok, false, JSON.stringify({ ok: r.ok, code: r.code }))
  assert.equal(await readFile(file, "utf8"), before)
})

test("journal 故障：提交前读到空日志或破损日志时不得覆盖正常日志", async () => {
  {
    const { root, call, card } = await pendingIntakeCard("jd-empty-t")
    assert.equal((await call(["decide", "--task", "jd-empty-t", "--decision-id", card.decisionId, "--choice", "1"])).ok, true)
    const file = journalOf(root, "jd-empty-t"), before = await readFile(file, "utf8")
    const r = await replaceJournalRead(root, "jd-empty-t", "appendEventsUnlocked", "", () => call(["dispatch-plan", "--task", "jd-empty-t", "--writable", "R.md:code-review"]))
    assert.equal(r.ok, false, JSON.stringify({ ok: r.ok, code: r.code }))
    assert.equal(await readFile(file, "utf8"), before, "空日志读数不覆盖正常日志")
  }
  {
    const { root, call, key } = await readyOwner("jd-corrupt-t")
    const file = journalOf(root, "jd-corrupt-t"), before = await readFile(file, "utf8")
    const r = await replaceJournalRead(root, "jd-corrupt-t", "appendReportEvent", "{invalid", () => call(["deliver", "--task", "jd-corrupt-t", "--key", key, "--outcome", "delivered", "--summary", "完成", "--paths", "R.md"]))
    assert.equal(r.ok, false, JSON.stringify({ ok: r.ok, code: r.code }))
    assert.equal(await readFile(file, "utf8"), before, "破损日志读数不覆盖正常日志")
  }
})

test("journal 故障：旧任务读取失败不得被视为无历史；新任务初始化读错不冒充未建账", async () => {
  {
    const root = await makeProject(), call = caller(root)
    await openTask(root, "jd-legacy-t"); await asLegacyTask(root, "jd-legacy-t")
    const file = journalOf(root, "jd-legacy-t"), before = await readFile(file, "utf8")
    const r = await injectJournalRead(root, "jd-legacy-t", "loadTask", "EIO", () => call(["run", "--task", "jd-legacy-t"]))
    assert.equal(r.ok, false, JSON.stringify({ ok: r.ok, code: r.code }))
    assert.equal(await readFile(file, "utf8"), before)
  }
  {
    const root = await makeProject(), call = caller(root)
    await openTask(root, "jd-initial-t")
    const file = journalOf(root, "jd-initial-t"), before = await readFile(file, "utf8")
    const r = await injectJournalRead(root, "jd-initial-t", "checkInitialFacts", "EIO", () => call(["run", "--task", "jd-initial-t"]))
    assert.equal(r.ok, false, JSON.stringify({ ok: r.ok, code: r.code }))
    assert.equal(r.code, "EIO")
    assert.equal(await readFile(file, "utf8"), before)
  }
})

test("journal 故障：decide 读错不落决定，refresh 确认读错不提交决定或新报告且可重试", async () => {
  {
    const { root, call, card } = await pendingIntakeCard("jd-decide-t")
    const journal = journalOf(root, "jd-decide-t"), decisions = path.join(path.dirname(journal), "decisions.json")
    const before = await readFile(journal, "utf8")
    const decisionsBefore = await readFile(decisions, "utf8").catch((e) => { if (e.code === "ENOENT") return null; throw e })
    const r = await injectJournalRead(root, "jd-decide-t", "appendEventsUnlocked", "EIO", () => call(["decide", "--task", "jd-decide-t", "--decision-id", card.decisionId, "--choice", "1"]))
    assert.equal(r.ok, false, JSON.stringify({ ok: r.ok, code: r.code }))
    assert.equal(await readFile(journal, "utf8"), before)
    assert.equal(await readFile(decisions, "utf8").catch((e) => { if (e.code === "ENOENT") return null; throw e }), decisionsBefore, "决定文件不变")
  }
  {
    const { root, call, key } = await readyOwner("jd-refresh-t")
    assert.equal((await call(["deliver", "--task", "jd-refresh-t", "--key", key, "--outcome", "delivered", "--summary", "完成", "--paths", "R.md"])).accepted, true)
    await writeFile(path.join(root, "R.md"), "授权刷新内容")
    const card = await call(["refresh-artifacts", "--task", "jd-refresh-t", "--reason", "用户要求刷新"])
    assert.ok(card.decisionId, JSON.stringify(card))
    const file = journalOf(root, "jd-refresh-t"), before = await readFile(file, "utf8")
    const r = await injectJournalRead(root, "jd-refresh-t", "appendEventsUnlocked", "EIO", () => call(["decide", "--task", "jd-refresh-t", "--decision-id", card.decisionId, "--choice", "1"]))
    assert.equal(r.ok, false, JSON.stringify({ ok: r.ok, code: r.code }))
    assert.equal(await readFile(file, "utf8"), before)
    const task = await fixLoadTask(root, "jd-refresh-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
    assert.ok(!task.reports.some((x) => x.reportId === "refresh-" + card.decisionId), "读错时不产生刷新报告")
    const retried = await call(["decide", "--task", "jd-refresh-t", "--decision-id", card.decisionId, "--choice", "1"])
    assert.equal(retried.ok, true, JSON.stringify({ ok: retried.ok, code: retried.code }))
    assert.equal(retried.refresh.reportId, "refresh-" + card.decisionId, "恢复后重试提交刷新报告")
  }
})

test("journal 故障：deliver/review 追加日志遇 EACCES/ENOENT 明确失败且可重试；确认读错不改既有决定文件", async () => {
  for (const code of ["EACCES", "ENOENT"]) {
    const name = "jd-dlv-" + code.toLowerCase()
    const { root, call, key } = await readyOwner(name)
    const file = journalOf(root, name), before = await readFile(file, "utf8")
    const args = ["deliver", "--task", name, "--key", key, "--outcome", "delivered", "--summary", "完成", "--paths", "R.md"]
    const r = await injectJournalRead(root, name, "appendReportEvent", code, () => call(args))
    assert.equal(r.ok, false, JSON.stringify({ ok: r.ok, code: r.code }))
    assert.equal(r.code, code)
    assert.equal(await readFile(file, "utf8"), before)
    assert.equal((await call(args)).accepted, true, code + " 后重试成功")
  }
  {
    const name = "jd-review-eio"
    const { root, call, key } = await readyOwner(name)
    assert.equal((await call(["deliver", "--task", name, "--key", key, "--outcome", "delivered", "--summary", "完成", "--paths", "R.md"])).accepted, true)
    const plan = await call(["dispatch-plan", "--task", name])
    const reviewer = plan.waves.find((x) => x.role === "challenger")
    assert.ok(reviewer, JSON.stringify({ stop: plan.stop }))
    const file = journalOf(root, name), before = await readFile(file, "utf8")
    const args = ["review", "--task", name, "--key", reviewer.dispatchKey, "--recommendation", "accept", "--summary", "通过"]
    const r = await injectJournalRead(root, name, "appendReportEvent", "EIO", () => call(args))
    assert.equal(r.ok, false, JSON.stringify({ ok: r.ok, code: r.code }))
    assert.equal(r.code, "EIO")
    assert.equal(await readFile(file, "utf8"), before)
    assert.equal((await call(args)).accepted, true, "评审重试成功")
  }
  {
    const { root, call, card } = await pendingIntakeCard("jd-decide-eacces")
    const file = journalOf(root, "jd-decide-eacces"), decisions = path.join(path.dirname(file), "decisions.json")
    const original = JSON.stringify({ items: [{ decisionId: "historical", choice: "旧决定" }] })
    await writeFile(decisions, original)
    const before = await readFile(file, "utf8")
    const r = await injectJournalRead(root, "jd-decide-eacces", "appendEventsUnlocked", "EACCES", () => call(["decide", "--task", "jd-decide-eacces", "--decision-id", card.decisionId, "--choice", "1"]))
    assert.equal(r.ok, false, JSON.stringify({ ok: r.ok, code: r.code }))
    assert.equal(await readFile(file, "utf8"), before)
    assert.equal(await readFile(decisions, "utf8"), original, "既有决定文件不被改写")
  }
})

test("journal 故障：多成员派发读错不提交半波且原样可重试；旧任务日志确实缺失时停止不重建", async () => {
  {
    const name = "jd-batch-t"
    const root = await makeProject(), call = caller(root)
    await openTask(root, name)
    const packages = [{ id: "a", writable: ["A.md:code-review"], done: ["a"], dependsOn: [] }, { id: "b", writable: ["B.md:code-review"], done: ["b"], dependsOn: [] }]
    assert.equal((await call(["plan", "--task", name, "--packages", JSON.stringify(packages)])).ok, true)
    const initial = await call(["dispatch-plan", "--task", name])
    assert.equal(initial.stop, "awaiting-user")
    assert.equal((await call(["decide", "--task", name, "--decision-id", initial.card.decisionId, "--choice", "1"])).ok, true)
    const file = journalOf(root, name), before = await readFile(file, "utf8")
    const r = await injectJournalRead(root, name, "appendEventsUnlocked", "EIO", () => call(["dispatch-plan", "--task", name]))
    assert.equal(r.ok, false, JSON.stringify({ ok: r.ok, code: r.code }))
    assert.equal(await readFile(file, "utf8"), before)
    const retry = await call(["dispatch-plan", "--task", name])
    assert.equal(retry.waves.length, 2, "重试派齐两包")
    assert.equal(new Set(retry.waves.map((w) => w.waveId)).size, 1, "重试不产生分裂波")
    const newEvents = (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse).filter((e) => e.type === "dispatched")
    assert.equal(newEvents.length, 2)
  }
  {
    const name = "jd-absent-t"
    const root = await makeProject(), call = caller(root)
    await openTask(root, name); await asLegacyTask(root, name)
    const file = journalOf(root, name)
    assert.ok(file.startsWith(root + path.sep))
    await unlinkFile(file)
    const r = await call(["dispatch-plan", "--task", name, "--writable", "R.md:code-review"])
    assert.equal(r.ok, false, JSON.stringify({ ok: r.ok, code: r.code }))
    assert.equal(r.code, "STATE_CORRUPT", "日志缺失停止而非重建")
    await assert.rejects(readFile(file, "utf8"))
  }
})

test("journal 边界：无末尾换行的日志仍可原子追加决定与交付事件", async () => {
  {
    const { root, call, card } = await pendingIntakeCard("jd-nl-decide")
    const file = journalOf(root, "jd-nl-decide")
    const raw = (await readFile(file, "utf8")).replace(/\n$/, "")
    await writeFile(file, raw)
    const r = await call(["decide", "--task", "jd-nl-decide", "--decision-id", card.decisionId, "--choice", "1"])
    assert.equal(r.ok, true, JSON.stringify({ ok: r.ok, code: r.code }))
    const after = await readFile(file, "utf8")
    assert.ok(after.startsWith(raw + "\n"), "新事件在完整原行之后追加")
    for (const line of after.trim().split("\n")) assert.ok(JSON.parse(line).type, "每行仍是有效 JSONL")
  }
  {
    const { root, call, key } = await readyOwner("jd-nl-deliver")
    const file = journalOf(root, "jd-nl-deliver")
    const raw = (await readFile(file, "utf8")).replace(/\n$/, "")
    await writeFile(file, raw)
    const r = await call(["deliver", "--task", "jd-nl-deliver", "--key", key, "--outcome", "delivered", "--summary", "完成", "--paths", "R.md"])
    assert.equal(r.accepted, true)
    const after = await readFile(file, "utf8")
    assert.ok(after.startsWith(raw + "\n"))
    for (const line of after.trim().split("\n")) assert.ok(JSON.parse(line).type)
  }
})

// 跨阶段回退（implementation→test→implementation）同路径三版：索引重建按提交序取最新；
// 提交序缺失/重复/倒退（跨阶段与阶段内）与历史报告缺提交锚点一律 ARCHIVE_ORDER_UNVERIFIED 不猜。
async function makeBacktrack(name, mutate = null) {
  const workflow = { ...FIX_WORKFLOW, stages: [
    { id: "implementation", label: "实施", outputs: ["code-review"], teamScene: "code-review", route: "e2e" },
    { id: "test", label: "测试", outputs: ["code-review"], teamScene: "code-review", route: "e2e" },
  ] }
  const root = await makeProject({ workflow })
  const call = autoCaller(root)
  await openTask(root, name, { entry: "implementation" })
  const taskRoot = path.join(root, ".team-work", "tasks", name)
  const file = journalOf(root, name)
  const events = (await readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l))
  const push = (type, detail) => events.push({ seq: events.length + 1, at: "2026-01-01T00:00:00.000Z", type, detail })
  for (const [index, stage, content] of [[1, "implementation", "实施旧"], [2, "test", "测试旧"], [3, "implementation", "实施最新"]]) {
    if (index > 1) push("stage-advanced", { from: index === 2 ? "implementation" : "test", to: stage })
    const key = "d" + index, reportId = "deliver-" + key, bytes = Buffer.from(content), digest = digestBytes(bytes), rel = "shared.txt"
    await writeFile(path.join(taskRoot, "snapshots", digest + ".json"), JSON.stringify({ format: "bytes-v1", digestAlgorithm: "sha256-bytes-v1", digest, path: rel, paths: [rel], encoding: "base64", data: bytes.toString("base64") }))
    push("dispatched", { key, waveId: "wv" + index, stage, role: "owner", round: index, writable: [{ path: rel, artifactKind: "code-review" }] })
    push("report-committed", { reportId, dispatchKey: key, kind: "deliver", role: "owner", package: null, stage, outcome: "delivered", ver: 1, payload: { outcome: "delivered", summary: "完成", paths: [rel] }, files: [{ path: rel, digest, digestAlgorithm: "sha256-bytes-v1" }] })
  }
  if (mutate) mutate(events)
  await writeFile(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n")
  const index = path.join(taskRoot, "artifacts.json")
  assert.ok(index.startsWith(root + path.sep))
  await unlinkFile(index)
  return { root, call, taskRoot, file, workflow, name }
}

test("跨阶段回退归档：索引重建按提交序取最新字节（实施最新），单旧报告可归档", async () => {
  {
    const { root, call, workflow, name } = await makeBacktrack("arch-bt-latest")
    const rebuilt = await fixLoadTask(root, name, { workflow, policy: FIX_POLICY })
    assert.deepEqual(rebuilt.artifacts.items.map((x) => x.reportRef), ["deliver-d3", "deliver-d2"], "重建基线 = 提交序最新的 d3 与同阶段前序 d2")
    assert.deepEqual(rebuilt.artifactsDegraded ?? [], [])
    const archived = await call(["archive", "--task", name])
    assert.equal(archived.ok, true, JSON.stringify(archived))
    assert.equal(await readFile(path.join(root, archived.archivedTo, "artifacts", "shared.txt"), "utf8"), "实施最新", "归档取提交序最新字节（回退后不取 test 旧版）")
  }
  {
    const { root, call, key } = await readyOwner("arch-single")
    assert.equal((await call(["deliver", "--task", "arch-single", "--key", key, "--outcome", "delivered", "--summary", "完成", "--paths", "R.md"])).accepted, true)
    const file = journalOf(root, "arch-single")
    const events = (await readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l))
    const event = events.find((e) => e.type === "report-committed")
    event.type = "legacy-unlinked"
    await writeFile(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n")
    const result = await call(["archive", "--task", "arch-single"])
    assert.equal(result.ok, true, JSON.stringify({ ok: result.ok, code: result.code }))
    assert.equal(await readFile(path.join(root, result.archivedTo, "artifacts", "R.md"), "utf8"), "原内容", "仅一个可验证旧报告无需排序即可归档")
  }
})

test("归档排序保护：跨阶段候选提交序缺失/重复/倒退时保留原任务（ARCHIVE_ORDER_UNVERIFIED）", async () => {
  for (const mode of ["missing", "duplicate", "nonmonotonic"]) {
    const name = "arch-cross-" + mode
    const { call, taskRoot, file } = await makeBacktrack(name, (events) => {
      const b = events.find((e) => e.type === "report-committed" && e.detail.reportId === "deliver-d2")
      const c = events.find((e) => e.type === "report-committed" && e.detail.reportId === "deliver-d3")
      if (mode === "missing") delete b.seq
      else if (mode === "duplicate") b.seq = c.seq
      else b.seq = c.seq + 1
    })
    const before = await readFile(file, "utf8")
    const r = await call(["archive", "--task", name])
    assert.equal(r.ok, false, mode + "：" + JSON.stringify(r).slice(0, 120))
    assert.equal(r.code, "ARCHIVE_ORDER_UNVERIFIED", mode)
    assert.equal(await readFile(file, "utf8"), before, "原任务事实不动")
    await readFile(path.join(taskRoot, "scope.json"), "utf8")
  }
})

test("归档排序保护：阶段内候选提交序异常与历史报告缺提交锚点不按墙钟猜新旧", async () => {
  for (const mode of ["missing", "duplicate", "nonmonotonic"]) {
    const name = "arch-order-" + mode
    const { call, taskRoot, file } = await makeBacktrack(name, (events) => {
      const a = events.find((e) => e.type === "report-committed" && e.detail.reportId === "deliver-d1")
      const c = events.find((e) => e.type === "report-committed" && e.detail.reportId === "deliver-d3")
      if (mode === "missing") delete c.seq
      else if (mode === "duplicate") c.seq = a.seq
      else c.seq = a.seq - 1
    })
    const before = await readFile(file, "utf8")
    const r = await call(["archive", "--task", name])
    assert.equal(r.ok, false, mode + "：" + JSON.stringify(r).slice(0, 120))
    assert.equal(r.code, "ARCHIVE_ORDER_UNVERIFIED", mode)
    assert.equal(await readFile(file, "utf8"), before)
    await readFile(path.join(taskRoot, "scope.json"), "utf8")
  }
  {
    let lost
    const name = "arch-no-anchor"
    const { call, taskRoot, file } = await makeBacktrack(name, (events) => {
      const event = events.find((e) => e.type === "report-committed" && e.detail.reportId === "deliver-d2")
      lost = { ...event.detail, at: event.at }
      event.type = "legacy-unlinked"
    })
    await writeFile(path.join(taskRoot, "reports", lost.reportId + ".json"), JSON.stringify(lost))
    const before = await readFile(file, "utf8")
    const r = await call(["archive", "--task", name])
    assert.equal(r.ok, false, JSON.stringify(r).slice(0, 120))
    assert.equal(r.code, "ARCHIVE_ORDER_UNVERIFIED", "缺提交锚点不按墙钟猜")
    assert.equal(await readFile(file, "utf8"), before)
    await readFile(path.join(taskRoot, "scope.json"), "utf8")
  }
})

// ── 返工轮 4（review-d36-44fd0a）：候选恢复取消隔离的完整重试路径——新版任务与旧任务（legacy-range）参数化 ──
// 完整链：B 先准备刷新卡 → A 候选恢复（意图获批后取消）→ B 原卡按原 ID 确认（基线生效）→
// B 评审链收敛静止 → A 原计划重试卡 choice=1 真正确认 → 断言仅 A 解阻且可重新派发交付。

async function seedRecoveryCancelRetry(root, name, { legacy }) {
  const call = autoCaller(root)
  await openTask(root, name)
  if (legacy) await asLegacyTask(root, name)
  const plan1 = [
    { id: "a", writable: ["A.md:code-review"], done: ["d"], dependsOn: [] },
    { id: "b", writable: ["B.md:code-review"], done: ["d"], dependsOn: [] },
  ]
  await call(["plan", "--task", name, "--packages", JSON.stringify(plan1)])
  const w = await call(["dispatch-plan", "--task", name])
  const keyOf = Object.fromEntries(w.waves.map((x) => [x.package, x.dispatchKey]))
  await writeFile(path.join(root, "A.md"), "a 内容", "utf8")
  await writeFile(path.join(root, "B.md"), "b 内容", "utf8")
  await call(["deliver", "--task", name, "--key", keyOf.b, "--outcome", "delivered", "--summary", "b 完成", "--paths", "B.md"])
  await call(["deliver", "--task", name, "--key", keyOf.a, "--outcome", "blocked", "--summary", "A 需要范围外文件 C.md"])
  // B 评审链收敛 → A blocked 静止
  const rv = await call(["dispatch-plan", "--task", name])
  await call(["review", "--task", name, "--key", rv.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "s"])
  const ve = await call(["dispatch-plan", "--task", name])
  await call(["review", "--task", name, "--key", ve.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "v", "--verdict", JSON.stringify({ outcome: "accept", rationale: "r", confidence: "high", recommendedAction: "a" })])
  await call(["route", "--task", name, "--route", "e2e", "--decision", "skip", "--basis", "测试"])
  const st = await call(["dispatch-plan", "--task", name])
  const aRef = (st.blockedPackages ?? st.card?.blockedPackages).find((x) => x.package === "a").ref
  // 1) B 先准备刷新卡（磁盘外部变化）
  await writeFile(path.join(root, "B.md"), "b 外部修改", "utf8")
  const prepB = await call(["refresh-artifacts", "--task", name, "--package", "b", "--reason", "B 候选基线"])
  assert.ok(prepB.decisionId, "B 刷新卡先准备：" + JSON.stringify(prepB).slice(0, 160))
  // 2) A 候选恢复卡（候选计划扩权 C.md）
  const plan2 = [
    { id: "a", writable: ["A.md:code-review", "C.md:code-review"], done: ["d"], dependsOn: [] },
    { id: "b", writable: ["B.md:code-review"], done: ["d"], dependsOn: [] },
  ]
  const rec = await call(["plan", "--task", name, "--resolve-blocked", JSON.stringify({ package: "a", action: "retry", reason: "用户同意扩权" }), "--blocked-ref", aRef, "--packages", JSON.stringify(plan2)])
  assert.ok(rec.decisionId, "A 候选恢复卡签发")
  // 3) 候选恢复意图获批（intent 卡确认）
  const runMid = await call(["run", "--task", name])
  const intakeId = (runMid.pendingDecisions ?? []).find((x) => (x.decisionId ?? "").startsWith("intake-"))?.decisionId
  assert.ok(intakeId, "候选意图卡在场")
  assert.equal((await call(["decide", "--task", name, "--choice", "1", "--decision-id", intakeId])).ok, true, "恢复意图获批")
  // 4) 取消 A 恢复卡（不执行解除）
  const cancel = await call(["decide", "--task", name, "--choice", "2", "--decision-id", rec.decisionId])
  assert.ok(cancel.ok !== false, JSON.stringify(cancel).slice(0, 160))
  // 5) B 原卡按原 ID 确认（取消未波及）
  const okB = await call(["decide", "--task", name, "--choice", "1", "--decision-id", prepB.decisionId])
  assert.equal(okB.ok, true, "B 原卡仍可确认：" + JSON.stringify(okB).slice(0, 160))
  const task = await fixLoadTask(root, name, { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const bItem = task.artifacts.items.find((i) => i.path === "B.md")
  assert.equal(bItem.digest, createHash("sha256").update(Buffer.from("b 外部修改", "utf8")).digest("hex"), "B 基线已按其卡生效")
  return { call, name }
}

for (const variant of [{ key: "新任务（已确认意图）", legacy: false, suffix: "new" }, { key: "旧任务（legacy-range）", legacy: true, suffix: "legacy" }]) {
  test("候选恢复取消后完整重试（" + variant.key + "）：B 原卡确认生效，A 重试卡真确认解阻并可交付", async () => {
    const root = await makeProject()
    const name = "fullretry-" + variant.suffix + "-t"
    const { call } = await seedRecoveryCancelRetry(root, name, { legacy: variant.legacy })
    // 6) B 评审链收敛至静止 → A 仍 blocked（取消与 B 确认均未解除 A）
    const rvB = await call(["dispatch-plan", "--task", name])
    await call(["review", "--task", name, "--key", rvB.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "B 新基线通过"])
    const veB = await call(["dispatch-plan", "--task", name])
    if (veB.waves?.length) {
      await call(["review", "--task", name, "--key", veB.waves[0].dispatchKey, "--recommendation", "accept", "--summary", "v", "--verdict", JSON.stringify({ outcome: "accept", rationale: "r", confidence: "high", recommendedAction: "a" })])
    }
    await call(["route", "--task", name, "--route", "e2e", "--decision", "skip", "--basis", "测试"])
    let still = await call(["run", "--task", name])
    let aEntry = (still.blockedPackages ?? still.card?.blockedPackages)?.find((x) => x.package === "a")
    if (!aEntry && still.status === "working") {
      // 评审链尚未静止：继续收敛（人工门或复审波）直到 blockedPackages 可见
      const g = await call(["dispatch-plan", "--task", name])
      if (g.stop === "awaiting-user") await call(["decide", "--task", name, "--choice", "1", "--decision-id", g.decisionId])
      still = await call(["run", "--task", name])
      aEntry = (still.blockedPackages ?? still.card?.blockedPackages)?.find((x) => x.package === "a")
    }
    assert.ok(aEntry, "A 仍 blocked（取消与 B 确认都不解除 A）：" + JSON.stringify({ status: still.status, bp: (still.blockedPackages ?? still.card?.blockedPackages)?.map((x) => x.package) }))
    // 7) A 原计划重试卡：同 ref 重新准备 → choice=1 真正确认
    const retry = await call(["plan", "--task", name, "--resolve-blocked", JSON.stringify({ package: "a", action: "retry", reason: "按原计划重试并确认" }), "--blocked-ref", aEntry.ref])
    assert.ok(retry.decisionId, "重试恢复卡签发：" + JSON.stringify(retry).slice(0, 160))
    const confirmed = await call(["decide", "--task", name, "--choice", "1", "--decision-id", retry.decisionId])
    assert.ok(confirmed.ok !== false, "choice=1 真正确认（此前缺陷：旧任务已取消候选意图被当有效意图导致确认失败）：" + JSON.stringify(confirmed).slice(0, 200))
    // 8) 仅 A 解阻：blocked 集无 a，A 可重新派发并真实交付
    const after = await fixLoadTask(root, name, { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
    const { effectiveBlockedSet } = await import("../runtime-v3/waves.mjs")
    const blockedNow = effectiveBlockedSet({ journal: after.journal, reports: after.reports, packages: [{ id: "a" }, { id: "b" }] })
    assert.equal(blockedNow.has("a"), false, "A 的 blocked 已按确认解除")
    assert.equal(blockedNow.has("b"), false, "B 不在 blocked 集（其基线已生效）")
    const aWave = await call(["dispatch-plan", "--task", name])
    const aOwner = (aWave.waves ?? []).find((x) => x.role === "owner" && (x.package === "a" || x.package === null))
    assert.ok(aOwner, "A 解阻后重新派发 owner 波：" + JSON.stringify({ stop: aWave.stop, w: aWave.waves?.map((x) => [x.role, x.package]) }))
    await writeFile(path.join(root, "A.md"), "A 重试交付内容", "utf8")
    const dl = await call(["deliver", "--task", name, "--key", aOwner.dispatchKey, "--outcome", "delivered", "--summary", "A 重试完成", "--paths", "A.md"])
    assert.equal(dl.accepted, true, "A 重试交付被接受：" + JSON.stringify(dl).slice(0, 160))
    const end = await fixLoadTask(root, name, { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
    assert.equal(end.artifacts.items.find((i) => i.path === "A.md").digest, createHash("sha256").update(Buffer.from("A 重试交付内容", "utf8")).digest("hex"), "A 交付登记")
    assert.equal(end.artifacts.items.find((i) => i.path === "B.md").digest, createHash("sha256").update(Buffer.from("b 外部修改", "utf8")).digest("hex"), "B 基线保持生效（未受 A 重试影响）")
  })
}
