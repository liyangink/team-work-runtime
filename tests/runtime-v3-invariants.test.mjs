// v3 不变量与台账编码/消解测试（合并版，使用共享夹具）
// 覆盖：I1 路径安全、I2 名字寻址、I3 重建、I4 目录推导、I6 不信声称、I9 路由、I10 无半态
// 台账：E2E-01/02/05/09/10/15/16/19/20
import test from "node:test"
import assert from "assert/strict"
import { writeFile, rm, readFile, mkdir } from "node:fs/promises"
import path from "node:path"

import { tw } from "../runtime-v3/cli.mjs"
import { initTask, loadTask } from "../runtime-v3/store.mjs"
import { registerDelivery } from "../runtime-v3/intake.mjs"
import { deriveTask } from "../runtime-v3/derive.mjs"
import { makeProject, caller, openTask, seedDispatch, seedConvergedStage, FIX_WORKFLOW, FIX_POLICY } from "./support/v3-fixtures.mjs"

test("I2：名字寻址——重名拒绝并提示、未知任务拒绝并给修复方向（不猜测）", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "dup-t")
  const dup = await call(["open", "--name", "dup-t", "--objective", "x", "--entry", "code-review"])
  assert.equal(dup.ok, false)
  assert.equal(dup.code, "TASK_EXISTS")
  assert.match(dup.fix, /换一个任务名|run/)
  const missing = await call(["run", "--task", "never-opened"])
  assert.equal(missing.ok, false)
  assert.equal(missing.code, "TASK_NOT_FOUND")
})

test("I4：门禁判定是任务目录的纯函数——两次加载推导一致，快照不变", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "pure-t")
  const d = await call(["dispatch-plan", "--task", "pure-t", "--writable", "R.md:code-review"])
  await writeFile(path.join(root, "R.md"), "内容", "utf8")
  await call(["deliver", "--task", "pure-t", "--key", d.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  const first = await loadTask(root, "pure-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const state1 = deriveTask(first)
  const second = await loadTask(root, "pure-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const state2 = deriveTask(second)
  assert.deepEqual(state1, state2)
  assert.equal(state1.stage, "code-review")
})

test("I1：deliver 路径逃逸与绝对路径拒绝", async () => {
  const root = await makeProject()
  await initTask({ projectRoot: root, name: "esc-t", objective: "o", entry: "code-review", completion: { mode: "through-stage", stage: "code-review" }, workflowDigest: "wd", stages: [] })
  const task = await seedDispatch(root, "esc-t", { key: "k1", kind: "produce", role: "owner", round: 1, writable: [{ path: "OK.md", artifactKind: "code-review" }] })
  await assert.rejects(registerDelivery({ projectRoot: root, task, dispatchKey: "k1", payload: { outcome: "delivered", summary: "s", paths: ["../outside.md"] } }), (e) => e.code === "INTAKE_REJECTED" && /路径不合法/.test(e.message))
  await assert.rejects(registerDelivery({ projectRoot: root, task, dispatchKey: "k1", payload: { outcome: "delivered", summary: "s", paths: ["/etc/passwd"] } }), (e) => e.code === "INTAKE_REJECTED")
})

test("I6 契约：deliver 不接受自评 recommendation（作者不自审）", async () => {
  const root = await makeProject()
  await initTask({ projectRoot: root, name: "norec-t", objective: "o", entry: "code-review", completion: { mode: "through-stage", stage: "code-review" }, workflowDigest: "wd", stages: [] })
  const task = await seedDispatch(root, "norec-t", { key: "k2", kind: "produce", role: "owner", round: 1, writable: [{ path: "OK.md", artifactKind: "code-review" }] })
  await writeFile(path.join(root, "OK.md"), "内容", "utf8")
  const r = await registerDelivery({ projectRoot: root, task, dispatchKey: "k2", payload: { outcome: "delivered", summary: "s", paths: ["OK.md"], recommendation: "accept" } })
  assert.equal(r.accepted, true)
  const after = await loadTask(root, "norec-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(after.reports.find((rep) => rep.dispatchKey === "k2").payload.recommendation, undefined)
})

test("I3：artifacts.json 删除后从 reports+snapshots 自动重建", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "rebuild-t")
  const d = await call(["dispatch-plan", "--task", "rebuild-t", "--writable", "R.md:code-review"])
  await writeFile(path.join(root, "R.md"), "内容 v1", "utf8")
  await call(["deliver", "--task", "rebuild-t", "--key", d.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  const task = await loadTask(root, "rebuild-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  await rm(path.join(task.root, "artifacts.json"))
  const rebuilt = await loadTask(root, "rebuild-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(rebuilt.artifacts.items.length, 1)
  assert.equal(rebuilt.artifacts.items[0].path, "R.md")
})

// ── 返工终版 §二·E：损坏账本重建等价（三源拼接，重建不得改变门禁事实） ──────────────

test("E 等价矩阵：多轮 ver 同 path / 跨 key 重交 / 同 digest 重交——重建与损坏前登记逐字段等价；kind 目录继承；degraded 可测", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "eq-t")
  const writable = [{ path: "docs/", artifactKind: "doc" }]
  const key1 = "deq-k1"
  await seedDispatch(root, "eq-t", { key: key1, kind: "produce", role: "owner", round: 1, package: null, continuation: false, writable })
  await mkdir(path.join(root, "docs"), { recursive: true })

  // 组 1：同 key 多轮 ver（原地修订 v1 → v2，F7 ver+1 覆盖单文件）
  await writeFile(path.join(root, "docs", "A.md"), "A v1", "utf8")
  await call(["deliver", "--task", "eq-t", "--key", key1, "--outcome", "delivered", "--summary", "v1", "--paths", "docs/A.md"])
  await writeFile(path.join(root, "docs", "A.md"), "A v2 修订", "utf8")
  await call(["deliver", "--task", "eq-t", "--key", key1, "--outcome", "delivered", "--summary", "v2", "--paths", "docs/A.md"])

  // 组 2：跨 key 重交同 path（重派后新 key 交付新内容 + 新增路径）
  const key2 = "deq-k2"
  await seedDispatch(root, "eq-t", { key: key2, kind: "respond", role: "owner", round: 2, package: null, continuation: true, writable, waveId: "wv1", causeDecisionId: "dec-x" })
  await writeFile(path.join(root, "docs", "A.md"), "A v3 跨key", "utf8")
  await writeFile(path.join(root, "docs", "B.md"), "B 同digest", "utf8")
  await call(["deliver", "--task", "eq-t", "--key", key2, "--outcome", "delivered", "--summary", "v3", "--paths", "docs/A.md,docs/B.md"])

  // 组 3：同 digest 重交（另一 key 交付与 B 相同内容的路径）
  const key3 = "deq-k3"
  await seedDispatch(root, "eq-t", { key: key3, kind: "respond", role: "owner", round: 3, package: null, continuation: true, writable, waveId: "wv2", causeDecisionId: "dec-y" })
  await writeFile(path.join(root, "docs", "B2.md"), "B 同digest", "utf8")
  await call(["deliver", "--task", "eq-t", "--key", key3, "--outcome", "delivered", "--summary", "同内容", "--paths", "docs/B2.md"])

  const before = await loadTask(root, "eq-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const registered = JSON.parse(JSON.stringify(before.artifacts.items))
  assert.equal(registered.length, 3)
  assert.ok(registered.every((it) => it.kind === "doc"), "kind 目录继承（docs/ 条目下路径继承 doc，不退化 misc）")
  assert.equal(registered.find((it) => it.path === "docs/A.md").reportRef, "deliver-" + key2, "每路径取最新报告（跨 key 重交后指向新 key）")
  const itemB = registered.find((it) => it.path === "docs/B.md")
  const itemB2 = registered.find((it) => it.path === "docs/B2.md")
  assert.equal(itemB.digest, itemB2.digest, "同 digest 事实保留（两路径各自登记）")

  // 损坏 → 三源重建：与损坏前逐字段等价（重建不改变门禁事实）
  const af = path.join(before.root, "artifacts.json")
  await writeFile(af, "{torn", "utf8")
  const after = await loadTask(root, "eq-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.ok(after.artifactsRebuilt, "损坏降级重建路径")
  assert.deepEqual(after.artifacts.items, registered, "重建与损坏前登记逐字段等价（digest/kind/stage/reportRef/snapshotRef）")
  assert.deepEqual(after.artifactsDegraded ?? [], [], "结构完好时无降级项")

  // degraded 可测定义：结构校验失败的报告被跳过并列出（不产出错误事实）
  const brokenReport = path.join(before.root, "reports", "deliver-broken.json")
  await writeFile(brokenReport, JSON.stringify({ reportId: "deliver-broken", kind: "deliver", stage: "code-review", payload: {} }), "utf8")
  await writeFile(af, "{torn2", "utf8")
  const degraded = await loadTask(root, "eq-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.ok(degraded.artifactsDegraded?.some((x) => x.reportId === "deliver-broken"), "损坏报告列入 degraded")
  assert.deepEqual(degraded.artifacts.items, registered, "损坏报告不产出错误事实（items 不变）")
})

test("agent-map 合法空账本正常登记（不假成功、不误报损坏）；agents.json 空映射数组合法", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "emptymap-t")
  const d = await call(["dispatch-plan", "--task", "emptymap-t", "--writable", "R.md:code-review"])
  const task = await loadTask(root, "emptymap-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  // 合法空账本（mappings 空对象）是正常态：登记成功、无 registryRebuilt 假成功/误报
  await writeFile(path.join(task.root, "agents.json"), JSON.stringify({ mappings: {} }), "utf8")
  const mapped = await call(["agent-map", "--task", "emptymap-t", "--key", d.waves[0].dispatchKey, "--agent", "child-x1"])
  assert.equal(mapped.ok, true)
  assert.equal(mapped.registryRebuilt, undefined, "合法空账本不是损坏重建")
  // runtime 投影：owner 波在途 + 登记事实 → run 的 wait-inflight 卡带 registered=true + mappedAgentId
  const runCard = await call(["run", "--task", "emptymap-t"])
  assert.equal(runCard.transition, "wait-inflight")
  const entry = runCard.inflight.find((it) => it.key === d.waves[0].dispatchKey)
  assert.equal(entry.registered, true)
  assert.equal(entry.mappedAgentId, "child-x1")
})

test("I9：E2E 路由门——未判定阻塞带恢复边；skip 必须给依据", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "route-t")
  const g1 = await call(["gate", "--task", "route-t"])
  assert.ok(g1.blockers.some((b) => b.route === "e2e"))
  const bad = await call(["route", "--task", "route-t", "--route", "e2e", "--decision", "skip"])
  assert.equal(bad.ok, false)
  await call(["route", "--task", "route-t", "--route", "e2e", "--decision", "skip", "--basis", "纯静态改动"])
  const g2 = await call(["gate", "--task", "route-t"])
  assert.ok(!g2.blockers.some((b) => b.route === "e2e"))
})

test("E2E-01：人工门签发后 journal 零状态事件（静止）", async () => {
  const root = await makeProject()
  const { call, task } = await seedConvergedStage(root, "still-t")
  const plan = await call(["dispatch-plan", "--task", "still-t"])
  assert.equal(plan.stop, "awaiting-user", JSON.stringify(plan))
  assert.ok(plan.card.decisionId, "决定卡由 dispatch-plan 推进时首签")
  const card = await call(["run", "--task", "still-t"])
  assert.equal(card.status, "awaiting-user", JSON.stringify(card))
  const jf = path.join(task.root, "journal.jsonl")
  const before = await readFile(jf, "utf8")
  await call(["intent", "--task", "still-t", "--add-constraint", "静止期补充"])
  assert.equal(await readFile(jf, "utf8"), before)
  const again = await call(["run", "--task", "still-t"])
  assert.equal(again.decisionId, card.decisionId)
})

test("E2E-02：用户约束与排除项进入派单文本", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "con-t")
  await call(["intent", "--task", "con-t", "--add-constraint", "重点看认证", "--add-exclusion", "不看样式"])
  const d = await call(["dispatch-plan", "--task", "con-t", "--writable", "R.md:code-review"])
  assert.equal(d.stop, null)
  assert.match(d.waves[0].prompt, /重点看认证/)
  assert.match(d.waves[0].prompt, /不看样式/)
})

test("E2E-20：intent 任何时候可修订（固化死局非法）", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "intent-t")
  const r = await call(["intent", "--task", "intent-t", "--objective", "目标升级", "--add-constraint", "含性能"])
  assert.equal(r.ok, true)
  assert.equal((await call(["intent", "--task", "intent-t", "--add-constraint", "再补"])).ok, true)
})

test("E2E-15 契约：open 无 mode/create-resume 分支参数（仓库真实 workflow 兜底）", async () => {
  const root = await makeProject({ workflow: null, policy: null })
  const call = caller(root)
  assert.equal((await call(["open", "--name", "mode-t", "--objective", "o"])).ok, true)
  assert.equal((await call(["run", "--task", "ghost"])).code, "TASK_NOT_FOUND")
})

test("E2E-19：v1 遗留 .team-work 上显式 open 自愈且旧文件原样", async () => {
  const root = await makeProject()
  await mkdir(path.join(root, ".team-work"), { recursive: true })
  await writeFile(path.join(root, ".team-work", "config.yaml"), "legacy: true\n")
  await writeFile(path.join(root, ".team-work", "task.json"), "{}")
  const call = caller(root)
  const r = await call(["open", "--name", "on-legacy", "--objective", "o", "--entry", "code-review"])
  assert.equal(r.ok, true)
  assert.match(await readFile(path.join(root, ".team-work", "config.yaml"), "utf8"), /legacy: true/)
})

test("I10：deliver 部分失败零半态", async () => {
  const root = await makeProject()
  await initTask({ projectRoot: root, name: "half-t", objective: "o", entry: "code-review", completion: { mode: "through-stage", stage: "code-review" }, workflowDigest: "wd", stages: [] })
  const task = await seedDispatch(root, "half-t", { key: "k9", kind: "produce", role: "owner", round: 1, writable: [{ path: "A.md", artifactKind: "code-review" }, { path: "B.md", artifactKind: "code-review" }] })
  await writeFile(path.join(root, "A.md"), "有", "utf8")
  await assert.rejects(registerDelivery({ projectRoot: root, task, dispatchKey: "k9", payload: { outcome: "delivered", summary: "s", paths: ["A.md", "B.md"] } }))
  const after = await loadTask(root, "half-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(after.reports.length, 0)
  assert.equal(after.artifacts.items.length, 0)
})

test("人工门 rework → 回 Owner 回应波次（回归：该分支曾静默丢失）", async () => {
  const root = await makeProject()
  const { call } = await seedConvergedStage(root, "hgw-t")
  const plan = await call(["dispatch-plan", "--task", "hgw-t"])
  assert.equal(plan.stop, "awaiting-user", JSON.stringify(plan))
  assert.ok(plan.card.decisionId)
  const card = await call(["run", "--task", "hgw-t"])
  assert.equal(card.status, "awaiting-user")
  const rework = await call(["decide", "--task", "hgw-t", "--choice", "2", "--note", "请按 Expert 保留意见修订"])
  assert.equal(rework.choice, "rework")
  const next = await call(["dispatch-plan", "--task", "hgw-t", "--writable", "R.md:code-review"])
  assert.equal(next.stop, null)
  assert.ok(next.waves.length > 0)
  assert.equal(next.waves[0].kind, "respond")
  assert.match(next.waves[0].prompt, /用户决定：返工/)
  assert.match(next.waves[0].prompt, /请按 Expert 保留意见修订/)
})

test("I8：tw restore 从最后注册快照恢复被污染制品", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "restore-t")
  const d = await call(["dispatch-plan", "--task", "restore-t", "--writable", "R.md:code-review"])
  await writeFile(path.join(root, "R.md"), "正确内容", "utf8")
  await call(["deliver", "--task", "restore-t", "--key", d.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  await writeFile(path.join(root, "R.md"), "被篡改", "utf8")
  const r = await call(["restore", "--task", "restore-t", "--path", "R.md"])
  assert.equal(r.ok, true)
  assert.equal(r.restored, "R.md")
  assert.equal(await readFile(path.join(root, "R.md"), "utf8"), "正确内容")
  const miss = await call(["restore", "--task", "restore-t", "--path", "OTHER.md"])
  assert.equal(miss.ok, false)
  assert.match(miss.message, /不是本任务登记的产出物/)
})

// ── §8 修订 v3（Expert 裁决返工）：run 零写 / 锁内自愈 / 损坏账本无死门 ──────────────

test("run/gate 零写：artifacts.json 损坏时只读重建呈现、文件字节不动；dispatch 推进锁内自愈写回（I3 + run 只读承诺）", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "ro-t")
  const d = await call(["dispatch-plan", "--task", "ro-t", "--writable", "R.md:code-review"])
  await writeFile(path.join(root, "R.md"), "内容", "utf8")
  await call(["deliver", "--task", "ro-t", "--key", d.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  const task = await loadTask(root, "ro-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const af = path.join(task.root, "artifacts.json")
  const corrupt = "{broken json"
  await writeFile(af, corrupt, "utf8")
  // 只读命令：内存重建照常呈现（状态卡/门禁可用），但绝不写回（锁外写回正是旧缺陷——与锁内写者竞态覆盖）
  const card = await call(["run", "--task", "ro-t"])
  assert.equal(card.ok, true)
  assert.equal(await readFile(af, "utf8"), corrupt, "run 零写：损坏字节原样")
  const g = await call(["gate", "--task", "ro-t"])
  assert.equal(g.ok, true)
  assert.equal(await readFile(af, "utf8"), corrupt, "gate 零写：损坏字节原样")
  // dispatch 通道（锁内写者）推进时自愈固化
  const plan = await call(["dispatch-plan", "--task", "ro-t"])
  assert.equal(plan.stop, null)
  const fixed = JSON.parse(await readFile(af, "utf8"))
  assert.equal(fixed.items.length, 1, "锁内自愈写回（repair）")
  assert.equal(fixed.items[0].path, "R.md")
})

test("agent-map 遇损坏账本自愈重建：降级透传卡的修复入口可达（非死门），registered 投影恢复", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "mapfix-t")
  const d = await call(["dispatch-plan", "--task", "mapfix-t", "--writable", "R.md:code-review"])
  const task = await loadTask(root, "mapfix-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  await writeFile(path.join(task.root, "agents.json"), "{corrupt", "utf8")
  const r = await call(["agent-map", "--task", "mapfix-t", "--key", d.waves[0].dispatchKey, "--agent", "child-x"])
  assert.equal(r.ok, true)
  assert.ok(r.registryRebuilt, "重建声明在场")
  assert.match(r.note, /已重建/)
  const healed = JSON.parse(await readFile(path.join(task.root, "agents.json"), "utf8"))
  assert.equal(healed.mappings[d.waves[0].dispatchKey], "child-x")
  // 重新推进：wait-inflight 投影 registered 恢复（不再降级透传）
  const plan = await call(["dispatch-plan", "--task", "mapfix-t"])
  assert.equal(plan.stop, "wait-inflight")
  assert.equal(plan.inflight[0].registered, true)
  assert.equal(plan.inflight[0].mappedAgentId, "child-x")
})

test("dispatch-plan 遇损坏 agents.json 降级推进：不抛错、warnings 在场（I5：推进通道不得死门）", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "planc-t")
  const task = await loadTask(root, "planc-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  await writeFile(path.join(task.root, "agents.json"), "{corrupt", "utf8")
  const plan = await call(["dispatch-plan", "--task", "planc-t", "--writable", "R.md:code-review"])
  assert.equal(plan.stop, null, "账本损坏不挡推进")
  assert.ok(Array.isArray(plan.warnings) && plan.warnings.some((w) => /agents.json 损坏/.test(w)), "降级警告在场（续派恢复路径已声明）")
})

test("retire 遇损坏账本不挡死：作废成功并重建账本（retire 是兜底恢复工具）", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "retc-t")
  const d = await call(["dispatch-plan", "--task", "retc-t", "--writable", "R.md:code-review"])
  const task = await loadTask(root, "retc-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  await writeFile(path.join(task.root, "agents.json"), "{corrupt", "utf8")
  const r = await call(["retire", "--task", "retc-t", "--wave", d.waves[0].waveId, "--reason", "作废场景"])
  assert.equal(r.ok, true)
  assert.ok(r.registryRebuilt, "重建声明在场")
  const healed = JSON.parse(await readFile(path.join(task.root, "agents.json"), "utf8"))
  assert.deepEqual(healed.mappings, {})
})

test("E2E-07 v3：respond 派单注入返工原因（意见随派单到达 Owner）", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "rework-ctx")
  const d1 = await call(["dispatch-plan", "--task", "rework-ctx", "--writable", "R.md:code-review"])
  await writeFile(path.join(root, "R.md"), "v1", "utf8")
  await call(["deliver", "--task", "rework-ctx", "--key", d1.waves[0].dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  const d2 = await call(["dispatch-plan", "--task", "rework-ctx"])
  await call(["review", "--task", "rework-ctx", "--key", d2.waves[0].dispatchKey, "--recommendation", "rework", "--summary", "覆盖不足", "--findings", '[{"severity":"risk","statement":"并发场景未分析"}]'])
  const d3 = await call(["dispatch-plan", "--task", "rework-ctx", "--writable", "R.md:code-review"])
  assert.equal(d3.stop, null)
  assert.match(d3.waves[0].prompt, /本轮返工\/回应原因/)
  assert.match(d3.waves[0].prompt, /并发场景未分析/)
  assert.match(d3.waves[0].prompt, /Challenger 意见（rework）/)
})
