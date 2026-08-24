// 并发回归（复核修复验证）：并发 deliver 不丢登记、并发 run 不双派发、并发 decide 不双记
import test from "node:test"
import assert from "assert/strict"
import {mkdtemp, writeFile, readFile, utimes} from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { tw } from "../runtime-v3/cli.mjs"
import { initTask, loadTask, taskRoot } from "../runtime-v3/store.mjs"
import { registerDelivery } from "../runtime-v3/intake.mjs"
import { seedDispatch, FIX_WORKFLOW, FIX_POLICY } from "./support/v3-fixtures.mjs"

test("并发 deliver：两个不同 key 同时交付，登记互不丢失", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "tw-conc-"))
  await initTask({ projectRoot, name: "conc-deliver", objective: "o", entry: "code-review", completion: { mode: "through-stage", stage: "code-review" }, workflowDigest: "wd", stages: [] })
  const task = await loadTask(projectRoot, "conc-deliver", { workflow: FIX_WORKFLOW, FIX_POLICY })
  await seedDispatch(projectRoot, "conc-deliver", { key: "k-a", kind: "produce", role: "owner", round: 1, writable: [{ path: "A.md", artifactKind: "code-review" }] })
  await seedDispatch(projectRoot, "conc-deliver", { key: "k-b", kind: "produce", role: "owner", round: 1, writable: [{ path: "B.md", artifactKind: "code-review" }] })
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

test("并发 run：同波次只派发一次（一个 dispatch key）", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "tw-conc-"))
  const call = (argv) => tw(argv, { projectRoot })
  await call(["open", "--name", "conc-run", "--objective", "o", "--entry", "code-review"])
  const [c1, c2] = await Promise.all([
    call(["run", "--task", "conc-run", "--writable", "R.md:code-review"]),
    call(["run", "--task", "conc-run", "--writable", "R.md:code-review"]),
  ])
  const dispatches = [c1, c2].filter((c) => c.next === "dispatch")
  assert.equal(dispatches.length, 1, "并发 run 只有一方完成派发（复核缺陷 4：曾双重派发），另一方应为后续状态卡")
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
  const { withOwnerLock } = await import("../runtime/persistence/transactions.mjs")
  const root = await mkdtemp(path.join(tmpdir(), "tw-lock-"))
  const lockPath = path.join(root, "task.lock")
  await writeFile(lockPath, "{ 半截崩溃残留，不是 JSON", "utf8")
  // mtime 回拨到 11 秒前：越过回收年龄阈值（写入竞态窗口是毫秒级，不受影响）
  const old = new Date(Date.now() - 11_000)
  await utimes(lockPath, old, old)
  const result = await withOwnerLock(lockPath, async () => "ok")
  assert.equal(result, "ok", "超龄损坏锁应被回收而非 LOCK_CORRUPT 永久失败")
})
