// 并发回归（复核修复验证）：并发 deliver 不丢登记、并发 dispatch-plan 推进不双派发、并发 decide 不双记
import test from "node:test"
import assert from "assert/strict"
import {mkdtemp, writeFile, readFile, utimes} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { tw } from "../runtime-v3/cli.mjs"
import { initTask, loadTask, taskRoot } from "../runtime-v3/store.mjs"
import { registerDelivery } from "../runtime-v3/intake.mjs"
import { autoCaller, caller, makeProject, seedDispatch, FIX_WORKFLOW, FIX_POLICY } from "./support/v3-fixtures.mjs"

test("并发 deliver：两个不同 key 同时交付，登记互不丢失", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "tw-conc-"))
  await initTask({ projectRoot, name: "conc-deliver", objective: "o", entry: "code-review", completion: { mode: "through-stage", stage: "code-review" }, workflowDigest: "wd", stages: [] })
  const task = await loadTask(projectRoot, "conc-deliver", { workflow: FIX_WORKFLOW, FIX_POLICY })
  // 新契约 §6.1：deliver --paths 是本包完整清单——两个不同包的并发交付互不覆盖（单 owner 才会整包替换）
  const planFile = path.join(task.root, "packages.json")
  await writeFile(planFile, JSON.stringify({ items: [{ id: "a", writable: ["A.md:code-review"], done: ["d"], dependsOn: [] }, { id: "b", writable: ["B.md:code-review"], done: ["d"], dependsOn: [] }] }))
  await seedDispatch(projectRoot, "conc-deliver", { key: "k-a", kind: "produce", role: "owner", round: 1, package: "a", writable: [{ path: "A.md", artifactKind: "code-review" }] })
  await seedDispatch(projectRoot, "conc-deliver", { key: "k-b", kind: "produce", role: "owner", round: 1, package: "b", writable: [{ path: "B.md", artifactKind: "code-review" }] })
  await writeFile(path.join(projectRoot, "A.md"), "A 内容", "utf8")
  await writeFile(path.join(projectRoot, "B.md"), "B 内容", "utf8")
  const taskA = await loadTask(projectRoot, "conc-deliver", { workflow: FIX_WORKFLOW, FIX_POLICY })

  const [ra, rb] = await Promise.all([
    registerDelivery({ projectRoot, task: taskA, dispatchKey: "k-a", payload: { outcome: "delivered", summary: "A", paths: ["A.md"] } }),
    registerDelivery({ projectRoot, task: taskA, dispatchKey: "k-b", payload: { outcome: "delivered", summary: "B", paths: ["B.md"] } }),
  ])
  assert.equal(ra.accepted, true)
  assert.equal(rb.accepted, true)
  const after = await loadTask(projectRoot, "conc-deliver", { workflow: FIX_WORKFLOW, FIX_POLICY })
  const paths = after.artifacts.items.map((i) => i.path).sort()
  assert.deepEqual(paths, ["A.md", "B.md"], "并发交付的登记必须都在（复核缺陷 1：曾丢失先写者）")
  assert.equal(after.reports.length, 2)
})

test("并发 dispatch-plan：同波次只派发一次（一个 dispatch key）", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "tw-conc-"))
  const call = autoCaller(projectRoot)
  await call(["open", "--name", "conc-run", "--objective", "o", "--entry", "code-review"])
  const [c1, c2] = await Promise.all([
    call(["dispatch-plan", "--task", "conc-run", "--writable", "R.md:code-review"]),
    call(["dispatch-plan", "--task", "conc-run", "--writable", "R.md:code-review"]),
  ])
  const dispatches = [c1, c2].filter((c) => c.stop === null && c.waves.length > 0)
  assert.equal(dispatches.length, 1, "并发推进只有一方拿到派单（复核缺陷 4：曾双重派发），另一方应为 wait-inflight 状态卡")
  const other = [c1, c2].find((c) => !(c.stop === null && c.waves.length > 0))
  assert.equal(other.stop, "wait-inflight", "另一方锁内重推导得到在途重建卡：" + JSON.stringify(other))
  const task = await loadTask(projectRoot, "conc-run", { workflow: FIX_WORKFLOW, FIX_POLICY })
  const dispatchedEvents = task.journal.filter((e) => e.type === "dispatched")
  assert.equal(dispatchedEvents.length, 1, "journal 只有一条 dispatched")
})

test("多路径部分失败不留孤儿快照（I10 补强：断言 snapshots）", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "tw-conc-"))
  await initTask({ projectRoot, name: "orphan-t", objective: "o", entry: "code-review", completion: { mode: "through-stage", stage: "code-review" }, workflowDigest: "wd", stages: [] })
  const task = await loadTask(projectRoot, "orphan-t", { workflow: FIX_WORKFLOW, FIX_POLICY })
  await seedDispatch(projectRoot, "orphan-t", { key: "k-orp", kind: "produce", role: "owner", round: 1, writable: [{ path: "OK1.md", artifactKind: "code-review" }, { path: "MISSING.md", artifactKind: "code-review" }] })
  await writeFile(path.join(projectRoot, "OK1.md"), "有", "utf8")
  const fsp = await import("node:fs/promises")
  await assert.rejects(registerDelivery({ projectRoot, task, dispatchKey: "k-orp", payload: { outcome: "delivered", summary: "s", paths: ["OK1.md", "MISSING.md"] } }))
  const snaps = await fsp.readdir(path.join(taskRoot(projectRoot, "orphan-t"), "snapshots")).catch(() => [])
  assert.equal(snaps.length, 0, "失败后 snapshots 目录为空（复核缺陷 3：曾留孤儿快照）")
})

test("损坏锁回收（评审 B F1）：超龄损坏锁自动回收，不永久卡死", async () => {
  const { withOwnerLock } = await import("../runtime-v3/persistence/transactions.mjs")
  const root = await mkdtemp(path.join(tmpdir(), "tw-lock-"))
  const lockPath = path.join(root, "task.lock")
  await writeFile(lockPath, "{ 半截崩溃残留，不是 JSON", "utf8")
  // mtime 回拨到 11 秒前：越过回收年龄阈值（写入竞态窗口是毫秒级，不受影响）
  const old = new Date(Date.now() - 11_000)
  await utimes(lockPath, old, old)
  const result = await withOwnerLock(lockPath, async () => "ok")
  assert.equal(result, "ok", "超龄损坏锁应被回收而非 LOCK_CORRUPT 永久失败")
})

test("新版并发 open：同名独占创建最多一个成功，完整任务不可覆盖", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "tw-open-"))
  const args = ["open", "--name", "same-name", "--objective", "目标", "--entry", "code-review", "--raw-requirement", "完整原文"]
  const [a, b] = await Promise.all([tw(args, { projectRoot }), tw(args, { projectRoot })])
  assert.equal([a, b].filter((result) => result.ok === true).length, 1)
  const refused = [a, b].find((result) => result.ok === false)
  assert.ok(["TASK_EXISTS", "TASK_INIT_INCOMPLETE"].includes(refused.code), JSON.stringify(refused))
  const task = await loadTask(projectRoot, "same-name", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(task.intent.rawRequirement, "完整原文")
  assert.equal((await tw(args, { projectRoot })).code, "TASK_EXISTS")
})

test("新版并发首卡：相同准备只签一次且不派发", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "tw-first-card-"))
  const call = (args) => tw(args, { projectRoot })
  await call(["open", "--name", "concurrent-card", "--objective", "目标", "--entry", "code-review", "--raw-requirement", "完整原文"])
  const args = ["dispatch-plan", "--task", "concurrent-card", "--writable", "R.md:code-review"]
  const [a, b] = await Promise.all([call(args), call(args)])
  assert.equal(a.stop, "awaiting-user")
  assert.equal(b.stop, "awaiting-user")
  assert.equal(a.card.decisionId, b.card.decisionId)
  const task = await loadTask(projectRoot, "concurrent-card", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.equal(task.journal.filter((event) => event.type === "decision-issued").length, 1)
  assert.equal(task.journal.some((event) => event.type === "dispatched"), false)
})

test("并发屏障：B 先签发后迟到 A 答复，不能消费 B 或写派单", async () => {
  const projectRoot = await makeProject()
  const call = caller(projectRoot)
  await call(["open", "--name", "late-answer", "--objective", "目标", "--entry", "code-review", "--raw-requirement", "合成原文"])
  const a = (await call(["dispatch-plan", "--task", "late-answer", "--writable", "A.md:k"])).card
  let release
  const barrier = new Promise((resolve) => { release = resolve })
  const delayed = barrier.then(() => call(["decide", "--task", "late-answer", "--choice", "1", "--decision-id", a.decisionId]))
  const b = (await call(["dispatch-plan", "--task", "late-answer", "--writable", "B.md:k"])).card
  const before = await loadTask(projectRoot, "late-answer", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  release()
  assert.equal((await delayed).code, "DECISION_STALE")
  const after = await loadTask(projectRoot, "late-answer", { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  assert.deepEqual(after.decisions, before.decisions, "迟到答复不写决定")
  assert.deepEqual(after.journal, before.journal, "迟到答复不写事件")
  assert.equal((await call(["run", "--task", "late-answer"])).decisionId, b.decisionId)
  assert.equal(after.journal.some((event) => event.type === "dispatched"), false)
  assert.equal((await call(["decide", "--task", "late-answer", "--choice", "1", "--decision-id", b.decisionId])).ok, true)
})

test("并发重拆与返工评审按锁内当前计划串行，旧包名不可伪成功", async () => {
  const projectRoot = await makeProject()
  const call = caller(projectRoot)
  await call(["open", "--name", "review-plan-race", "--objective", "目标", "--entry", "code-review", "--raw-requirement", "合成原文"])
  const oldPlan = [{ id: "a", writable: ["A.md:code-review"], done: ["完成"], dependsOn: [] }]
  const newPlan = [{ id: "b", writable: ["B.md:code-review"], done: ["完成"], dependsOn: [] }]
  const plan = (items) => call(["plan", "--task", "review-plan-race", "--packages", JSON.stringify(items)])
  await plan(oldPlan)
  const first = (await call(["dispatch-plan", "--task", "review-plan-race"])).card
  await call(["decide", "--task", "review-plan-race", "--choice", "1", "--decision-id", first.decisionId])
  const owner = (await call(["dispatch-plan", "--task", "review-plan-race"])).waves[0]
  await writeFile(path.join(projectRoot, "A.md"), "交付")
  await call(["deliver", "--task", "review-plan-race", "--key", owner.dispatchKey, "--outcome", "delivered", "--summary", "完成", "--paths", "A.md"])
  const reviewer = (await call(["dispatch-plan", "--task", "review-plan-race"])).waves[0]
  assert.equal((await plan(newPlan)).code, "PLAN_REJECTED", "评审在途时重拆受原规则阻止")
  const reviewArgs = ["review", "--task", "review-plan-race", "--key", reviewer.dispatchKey, "--recommendation", "rework", "--summary", "需修改", "--findings", JSON.stringify([{ severity: "risk", statement: "问题", disposition: "must-fix", scope: { kind: "packages", ids: ["a"] } }])]
  let release
  const barrier = new Promise((resolve) => { release = resolve })
  const planning = barrier.then(() => plan(newPlan))
  const reviewing = barrier.then(() => call(reviewArgs))
  release()
  const [planned, reviewed] = await Promise.all([planning, reviewing])
  // 两种锁序均合法：review 先入锁 → 按旧计划接受；plan 先入锁 → 旧包名 findings 对新计划（b）不匹配被拒
  assert.ok(reviewed.accepted === true || (reviewed.ok === false && reviewed.code === "INTAKE_REJECTED"), "并发窗口内两种锁序的合法结果：" + JSON.stringify(reviewed).slice(0, 200))
  assert.ok(planned.ok || planned.code === "PLAN_REJECTED", JSON.stringify(planned))
  const retry = await call(reviewArgs)
  if (planned.ok && reviewed.accepted === true) {
    // review 先入锁按旧计划接受、plan 随后成功落盘：重放已接受评审按同 key 幂等重显（不重复消费）
    assert.equal(retry.idempotent, true, "评审已接受后重放幂等：" + JSON.stringify(retry).slice(0, 160))
  } else if (planned.ok) {
    assert.equal(retry.code, "INTAKE_REJECTED", "重拆先落盘后，同一旧包名不得以幂等掩盖不匹配")
  } else {
    assert.equal(retry.idempotent, true, "重拆被拒时原计划仍有效，重复评审幂等")
  }
})
