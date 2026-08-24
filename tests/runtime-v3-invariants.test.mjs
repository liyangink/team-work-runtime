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
  const d = await call(["run", "--task", "pure-t", "--writable", "R.md:code-review"])
  await writeFile(path.join(root, "R.md"), "内容", "utf8")
  await call(["deliver", "--task", "pure-t", "--key", d.dispatch.key, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
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
  const d = await call(["run", "--task", "rebuild-t", "--writable", "R.md:code-review"])
  await writeFile(path.join(root, "R.md"), "内容 v1", "utf8")
  await call(["deliver", "--task", "rebuild-t", "--key", d.dispatch.key, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  const task = await loadTask(root, "rebuild-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  await rm(path.join(task.root, "artifacts.json"))
  const rebuilt = await loadTask(root, "rebuild-t", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(rebuilt.artifacts.items.length, 1)
  assert.equal(rebuilt.artifacts.items[0].path, "R.md")
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
  const d = await call(["run", "--task", "con-t", "--writable", "R.md:code-review"])
  assert.match(d.dispatch.prompt, /重点看认证/)
  assert.match(d.dispatch.prompt, /不看样式/)
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
  const card = await call(["run", "--task", "hgw-t"])
  assert.equal(card.status, "awaiting-user")
  const rework = await call(["decide", "--task", "hgw-t", "--choice", "2", "--note", "请按 Expert 保留意见修订"])
  assert.equal(rework.choice, "rework")
  const next = await call(["run", "--task", "hgw-t", "--writable", "R.md:code-review"])
  assert.equal(next.next, "dispatch")
  assert.equal(next.dispatch.kind, "respond")
  assert.match(next.dispatch.prompt, /用户决定：返工/)
  assert.match(next.dispatch.prompt, /请按 Expert 保留意见修订/)
})

test("I8：tw restore 从最后注册快照恢复被污染制品", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "restore-t")
  const d = await call(["run", "--task", "restore-t", "--writable", "R.md:code-review"])
  await writeFile(path.join(root, "R.md"), "正确内容", "utf8")
  await call(["deliver", "--task", "restore-t", "--key", d.dispatch.key, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  await writeFile(path.join(root, "R.md"), "被篡改", "utf8")
  const r = await call(["restore", "--task", "restore-t", "--path", "R.md"])
  assert.equal(r.ok, true)
  assert.equal(r.restored, "R.md")
  assert.equal(await readFile(path.join(root, "R.md"), "utf8"), "正确内容")
  const miss = await call(["restore", "--task", "restore-t", "--path", "OTHER.md"])
  assert.equal(miss.ok, false)
  assert.match(miss.message, /不是本任务登记的产出物/)
})

test("E2E-07 v3：respond 派单注入返工原因（意见随派单到达 Owner）", async () => {
  const root = await makeProject()
  const call = caller(root)
  await openTask(root, "rework-ctx")
  const d1 = await call(["run", "--task", "rework-ctx", "--writable", "R.md:code-review"])
  await writeFile(path.join(root, "R.md"), "v1", "utf8")
  await call(["deliver", "--task", "rework-ctx", "--key", d1.dispatch.key, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  const d2 = await call(["run", "--task", "rework-ctx"])
  await call(["review", "--task", "rework-ctx", "--key", d2.dispatch.key, "--recommendation", "rework", "--summary", "覆盖不足", "--findings", '[{"severity":"risk","statement":"并发场景未分析"}]'])
  const d3 = await call(["run", "--task", "rework-ctx", "--writable", "R.md:code-review"])
  assert.match(d3.dispatch.prompt, /本轮返工\/回应原因/)
  assert.match(d3.dispatch.prompt, /并发场景未分析/)
  assert.match(d3.dispatch.prompt, /Challenger 意见（rework）/)
})
