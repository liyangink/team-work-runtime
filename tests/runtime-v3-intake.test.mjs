// runtime-v3 intake/store 文件系统测试
// 规约映射：§3 E2E-05/09/10/16/17 消解、§2 I1/I8/I10

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { initTask, loadTask, taskExists, validName, taskRoot } from "../runtime-v3/store.mjs"
import { registerDelivery, registerReview } from "../runtime-v3/intake.mjs"
import { digestValue } from "../runtime-v3/domain/digests.mjs"
import { deliverBaselines } from "../runtime-v3/waves.mjs"
import { autoCaller, makeProject, openTask, seedDispatch, FIX_WORKFLOW as workflow, FIX_POLICY as policy } from "./support/v3-fixtures.mjs"

async function fixture() {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "tw-v3-"))
  await initTask({ projectRoot, name: "audit-x", objective: "审查改动", entry: "code-review", completion: { mode: "through-stage", stage: "code-review" }, workflowDigest: "wd", stages: ["code-review"] })
  const task = await loadTask(projectRoot, "audit-x", { workflow, policy })
  return { projectRoot, task, dispatch: (detail) => seedDispatch(projectRoot, "audit-x", detail), reload: () => loadTask(projectRoot, "audit-x", { workflow, policy }) }
}

test("I1：任务名校验与目录唯一（open 重名拒绝）", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tw-v3-"))
  assert.equal(validName("audit-q3"), true)
  assert.equal(validName("Bad_Name"), false)
  assert.equal(validName("../escape"), false)
  await initTask({ projectRoot: root, name: "t-1", objective: "o", entry: "code-review", completion: { mode: "through-stage", stage: "code-review" }, workflowDigest: "wd", stages: [] })
  assert.equal(await taskExists(root, "t-1"), true)
  await assert.rejects(
    initTask({ projectRoot: root, name: "t-1", objective: "o", entry: "code-review", completion: { mode: "through-stage", stage: "code-review" }, workflowDigest: "wd", stages: [] }),
    (error) => error.code === "TASK_EXISTS" && /已存在/.test(error.message),
  )
})

test("initTask 目录骨架：只创建运行时实际使用的目录（无 decisions/、gates/ 残留）", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tw-v3-"))
  await initTask({ projectRoot: root, name: "skel-t", objective: "o", entry: "code-review", completion: { mode: "through-stage", stage: "code-review" }, workflowDigest: "wd", stages: [] })
  const entries = await readdir(taskRoot(root, "skel-t"), { withFileTypes: true })
  const names = entries.map((e) => e.name).sort()
  // 决定存单文件 decisions.json（首次决定时才落盘）、门禁判定不落盘（charter §5）——骨架里没有这两个目录
  assert.deepEqual(names, ["artifacts.json", "intent.json", "journal.jsonl", "locks", "reports", "scope.json", "snapshots"])
  for (const dir of ["locks", "reports", "snapshots"]) {
    assert.equal(entries.find((e) => e.name === dir)?.isDirectory(), true, `${dir} 应为目录`)
  }
})

test("deliver 目录授权：尾斜杠条目覆盖其下路径且 kind 继承条目声明", async () => {
  const { projectRoot, task, dispatch, reload } = await fixture()
  await dispatch({ key: "w1-dir001", kind: "produce", role: "owner", round: 1, writable: [{ path: "review/", artifactKind: "code-review" }] })
  await mkdir(path.join(projectRoot, "review"), { recursive: true })
  await writeFile(path.join(projectRoot, "review", "findings-defects.md"), "# 审查\n缺陷清单", "utf8")
  const receipt = await registerDelivery({ projectRoot, task, dispatchKey: "w1-dir001", payload: { outcome: "delivered", summary: "目录交付", paths: ["review/findings-defects.md"], checks: [], unresolved: [] } })
  assert.equal(receipt.accepted, true)
  assert.equal(receipt.registered[0].path, "review/findings-defects.md")
  const t2 = await reload()
  assert.equal(t2.artifacts.items.find((i) => i.path === "review/findings-defects.md")?.kind, "code-review", "kind 继承目录条目的 artifactKind")
})

test("deliver 目录授权边界：前缀不误匹配（review/ 不覆盖 review-x/）；范围外拒绝文案含 blocked 恢复引导", async () => {
  const { projectRoot, task, dispatch } = await fixture()
  await dispatch({ key: "w1-dir002", kind: "produce", role: "owner", round: 1, writable: [{ path: "review/", artifactKind: "code-review" }] })
  await mkdir(path.join(projectRoot, "review-x"), { recursive: true })
  await writeFile(path.join(projectRoot, "review-x", "a.md"), "x", "utf8")
  await assert.rejects(
    registerDelivery({ projectRoot, task, dispatchKey: "w1-dir002", payload: { outcome: "delivered", summary: "越界", paths: ["review-x/a.md"], checks: [], unresolved: [] } }),
    (error) => error.code === "INTAKE_REJECTED"
      && error.reasons.some((r) => r.includes("review-x/a.md") && r.includes("不在本派单可写范围") && r.includes("目录条目以 / 结尾"))
      && error.reasons.some((r) => r.includes("--outcome blocked") && /用户明确.*授权/.test(r) && !r.includes("Lead 将扩大可写范围")),
  )
})

test("deliver 精确条目不扩张：无尾斜杠条目仅匹配自身", async () => {
  const { projectRoot, task, dispatch } = await fixture()
  await dispatch({ key: "w1-exact01", kind: "produce", role: "owner", round: 1, writable: [{ path: "docs", artifactKind: "code-review" }] })
  await mkdir(path.join(projectRoot, "docs"), { recursive: true })
  await writeFile(path.join(projectRoot, "docs", "a.md"), "x", "utf8")
  await assert.rejects(
    registerDelivery({ projectRoot, task, dispatchKey: "w1-exact01", payload: { outcome: "delivered", summary: "越界", paths: ["docs/a.md"], checks: [], unresolved: [] } }),
    (error) => error.code === "INTAKE_REJECTED" && error.reasons.some((r) => r.includes("docs/a.md") && r.includes("目录条目以 / 结尾")),
  )
})

test("deliver：登记产出物 + 快照 + journal（E2E-16：路径即身份）", async () => {
  const { projectRoot, task, dispatch, reload } = await fixture()
  await dispatch({ key: "w1-abc123", kind: "produce", role: "owner", round: 1, writable: [{ path: "CODE_REVIEW.md", artifactKind: "code-review" }] })
  await writeFile(path.join(projectRoot, "CODE_REVIEW.md"), "# 审查\n发现 X", "utf8")

  const receipt = await registerDelivery({ projectRoot, task, dispatchKey: "w1-abc123", payload: { outcome: "delivered", summary: "完成八视角审查", paths: ["CODE_REVIEW.md"], checks: [{ name: "npm test", result: "pass" }], unresolved: [] } })
  assert.equal(receipt.accepted, true)
  assert.equal(receipt.registered[0].path, "CODE_REVIEW.md")

  const after = await reload()
  assert.equal(after.artifacts.items.length, 1)
  assert.equal(after.artifacts.items[0].kind, "code-review")
  assert.equal(after.artifacts.items[0].stage, "code-review")
  const snapshot = JSON.parse(await readFile(path.join(after.root, "snapshots", `${receipt.registered[0].digest}.json`), "utf8"))
  assert.equal(snapshot.format, "bytes-v1")
  assert.equal(Buffer.from(snapshot.data, snapshot.encoding ?? "base64").toString("utf8"), "# 审查\n发现 X")

  // 原地修订：同路径 → 同制品新 digest，旧快照保留（I8 恢复源 + E2E-16 同路径同制品）
  await dispatch({ key: "w3-def456", kind: "respond", role: "owner", round: 2, writable: [{ path: "CODE_REVIEW.md", artifactKind: "code-review" }] })
  await writeFile(path.join(projectRoot, "CODE_REVIEW.md"), "# 审查 v2\n补齐", "utf8")
  const r2 = await registerDelivery({ projectRoot, task: after, dispatchKey: "w3-def456", payload: { outcome: "delivered", summary: "补齐缺口", paths: ["CODE_REVIEW.md"], checks: [] } })
  const final = await reload()
  assert.equal(final.artifacts.items.length, 1, "同路径不产生第二个制品")
  assert.equal(final.artifacts.items[0].digest, r2.registered[0].digest)
  const oldSnapshot = JSON.parse(await readFile(path.join(final.root, "snapshots", `${receipt.registered[0].digest}.json`), "utf8"))
  assert.equal(Buffer.from(oldSnapshot.data, oldSnapshot.encoding ?? "base64").toString("utf8"), "# 审查\n发现 X", "旧版本快照保留")
})

test("交付回执：评审返工换 key 后按同包上一份完整清单计算增删", async () => {
  const { projectRoot, task, dispatch, reload } = await fixture()
  const writable = [{ path: "X.md", artifactKind: "code-review" }, { path: "Y.md", artifactKind: "code-review" }]
  await writeFile(path.join(projectRoot, "X.md"), "初稿 X", "utf8")
  await writeFile(path.join(projectRoot, "Y.md"), "初稿 Y", "utf8")
  await dispatch({ key: "owner-first", kind: "produce", role: "owner", round: 1, package: "draft", stage: "code-review", writable })
  const first = await registerDelivery({ projectRoot, task, dispatchKey: "owner-first", payload: { outcome: "delivered", summary: "初稿", paths: ["X.md", "Y.md"] } })
  assert.deepEqual(first.manifest, ["X.md", "Y.md"])
  assert.deepEqual(first.added, ["X.md", "Y.md"], "首份清单中的路径均为新增")
  await dispatch({ key: "challenger-first", kind: "review", role: "challenger", round: 1, stage: "code-review", writable: [] })
  const review = await registerReview({ projectRoot, task, dispatchKey: "challenger-first", payload: { summary: "需要返工", recommendation: "rework", findings: [{ severity: "risk", statement: "修改初稿", disposition: "must-fix", scope: { kind: "all-covered" } }] } })
  assert.equal(review.accepted, true, "先完成真实返工评审")
  await dispatch({ key: "owner-rework", kind: "respond", role: "owner", round: 2, package: "draft", stage: "code-review", writable })
  const rework = await registerDelivery({ projectRoot, task, dispatchKey: "owner-rework", payload: { outcome: "delivered", summary: "返工", paths: ["X.md"] } })
  assert.deepEqual(rework.manifest, ["X.md"])
  assert.equal(rework.added, undefined, "X 已在前置基线中，不得报新增")
  assert.deepEqual(rework.removed, ["Y.md"], "新 key 也须报告前置基线移出的 Y")
  assert.deepEqual((await reload()).artifacts.items.map((item) => item.path), ["X.md"])
  assert.equal(await readFile(path.join(projectRoot, "Y.md"), "utf8"), "初稿 Y", "移出清单不删除磁盘文件")
})

test("交付回执：同 key 幂等保留清单，换 key 或只改内容不报告路径增删", async () => {
  const { projectRoot, task, dispatch, reload } = await fixture()
  const writable = [{ path: "X.md", artifactKind: "code-review" }, { path: "Y.md", artifactKind: "code-review" }]
  await writeFile(path.join(projectRoot, "X.md"), "X1", "utf8")
  await writeFile(path.join(projectRoot, "Y.md"), "Y1", "utf8")
  await dispatch({ key: "owner-a", kind: "produce", role: "owner", round: 1, writable })
  const payload = { outcome: "delivered", summary: "完整交付", paths: ["Y.md", "X.md"] }
  const first = await registerDelivery({ projectRoot, task, dispatchKey: "owner-a", payload })
  const beforeRetry = await reload()
  const retry = await registerDelivery({ projectRoot, task, dispatchKey: "owner-a", payload })
  assert.equal(retry.idempotent, true)
  assert.equal(retry.ver, first.ver)
  assert.deepEqual(retry.registered, first.registered)
  assert.deepEqual(retry.manifest, ["X.md", "Y.md"], "幂等回执包含规范化完整清单")
  assert.equal((await reload()).journal.length, beforeRetry.journal.length, "幂等不新增报告事件")
  await dispatch({ key: "owner-b", kind: "respond", role: "owner", round: 2, writable })
  const next = await registerDelivery({ projectRoot, task, dispatchKey: "owner-b", payload })
  assert.deepEqual(next.manifest, ["X.md", "Y.md"])
  assert.equal(next.added, undefined, "换 key 但清单相同不得误报新增")
  assert.equal(next.removed, undefined)
  await writeFile(path.join(projectRoot, "X.md"), "X2", "utf8")
  const changed = await registerDelivery({ projectRoot, task, dispatchKey: "owner-b", payload })
  assert.equal(changed.ver, 2, "内容变化仍按同 key 产生新版本")
  assert.equal(changed.idempotent, undefined)
  assert.equal(changed.added, undefined, "只改内容不改变路径归属")
  assert.equal(changed.removed, undefined)
  assert.deepEqual(changed.manifest, ["X.md", "Y.md"])
})

test("交付回执：blocked 不移除有效清单，同 key 解除阻塞后仍比较前置 delivered", async () => {
  const { projectRoot, task, dispatch, reload } = await fixture()
  const writable = [{ path: "X.md", artifactKind: "code-review" }, { path: "Y.md", artifactKind: "code-review" }]
  await writeFile(path.join(projectRoot, "X.md"), "X", "utf8")
  await writeFile(path.join(projectRoot, "Y.md"), "Y", "utf8")
  await dispatch({ key: "owner-a", kind: "produce", role: "owner", round: 1, writable })
  await registerDelivery({ projectRoot, task, dispatchKey: "owner-a", payload: { outcome: "delivered", summary: "初稿", paths: ["X.md", "Y.md"] } })
  const blocked = { outcome: "blocked", summary: "暂时受阻", paths: [] }
  const sameKeyBlocked = await registerDelivery({ projectRoot, task, dispatchKey: "owner-a", payload: blocked })
  assert.equal(sameKeyBlocked.ver, 2)
  assert.deepEqual(sameKeyBlocked.manifest, [])
  assert.equal(sameKeyBlocked.added, undefined)
  assert.equal(sameKeyBlocked.removed, undefined, "blocked 不应报告原清单被移除")
  assert.deepEqual((await reload()).artifacts.items.map((item) => item.path).sort(), ["X.md", "Y.md"], "blocked 不替换有效清单")
  await dispatch({ key: "owner-b", kind: "respond", role: "owner", round: 2, writable })
  const newKeyBlocked = await registerDelivery({ projectRoot, task, dispatchKey: "owner-b", payload: blocked })
  assert.equal(newKeyBlocked.removed, undefined)
  const blockedRetry = await registerDelivery({ projectRoot, task, dispatchKey: "owner-b", payload: blocked })
  assert.equal(blockedRetry.idempotent, true)
  assert.deepEqual(blockedRetry.manifest, [], "blocked 幂等回执也带空清单")
  assert.equal(blockedRetry.removed, undefined)
  const recovered = await registerDelivery({ projectRoot, task, dispatchKey: "owner-b", payload: { outcome: "delivered", summary: "继续交付", paths: ["X.md"] } })
  assert.equal(recovered.ver, 2, "同 key 从 blocked 继续交付仍递增版本")
  assert.deepEqual(recovered.manifest, ["X.md"])
  assert.equal(recovered.added, undefined)
  assert.deepEqual(recovered.removed, ["Y.md"], "被 blocked 隔开的有效基线仍是 X/Y")
})

test("交付回执：迟到旧 key 变更按最新有效基线计算，不改变幂等身份", async () => {
  const { projectRoot, task, dispatch } = await fixture()
  const writable = [{ path: "X.md", artifactKind: "code-review" }, { path: "Y.md", artifactKind: "code-review" }, { path: "Z.md", artifactKind: "code-review" }]
  for (const name of ["X.md", "Y.md", "Z.md"]) await writeFile(path.join(projectRoot, name), name, "utf8")
  await dispatch({ key: "owner-a", kind: "produce", role: "owner", round: 1, package: "draft", writable })
  const old = { outcome: "delivered", summary: "初稿", paths: ["X.md", "Y.md"] }
  await registerDelivery({ projectRoot, task, dispatchKey: "owner-a", payload: old })
  await dispatch({ key: "owner-b", kind: "respond", role: "owner", round: 2, package: "draft", writable })
  await registerDelivery({ projectRoot, task, dispatchKey: "owner-b", payload: { outcome: "delivered", summary: "新版", paths: ["X.md", "Z.md"] } })
  const unchangedLate = await registerDelivery({ projectRoot, task, dispatchKey: "owner-a", payload: old })
  assert.equal(unchangedLate.idempotent, true, "旧 key 的相同交付仍按自身报告幂等")
  assert.deepEqual(unchangedLate.manifest, ["X.md", "Y.md"])
  const changedLate = await registerDelivery({ projectRoot, task, dispatchKey: "owner-a", payload: { ...old, summary: "迟到修订" } })
  assert.equal(changedLate.ver, 2)
  assert.deepEqual(changedLate.manifest, ["X.md", "Y.md"])
  assert.deepEqual(changedLate.added, ["Y.md"], "迟到重交相对新 key 的 X/Z 新增 Y")
  assert.deepEqual(changedLate.removed, ["Z.md"], "迟到重交相对新 key 的 X/Z 移出 Z")
})

test("交付回执：不同阶段或不同包的交付不能污染当前包前置基线", async () => {
  const { projectRoot, task, dispatch, reload } = await fixture()
  const writable = [{ path: "X.md", artifactKind: "code-review" }, { path: "Y.md", artifactKind: "code-review" }, { path: "Z.md", artifactKind: "code-review" }, { path: "U.md", artifactKind: "code-review" }]
  for (const name of ["X.md", "Y.md", "Z.md", "U.md"]) await writeFile(path.join(projectRoot, name), name, "utf8")
  await dispatch({ key: "draft-first", kind: "produce", role: "owner", round: 1, package: "draft", stage: "code-review", writable })
  await registerDelivery({ projectRoot, task, dispatchKey: "draft-first", payload: { outcome: "delivered", summary: "草稿", paths: ["X.md", "Y.md"] } })
  await dispatch({ key: "other-package", kind: "produce", role: "owner", round: 1, package: "other", stage: "code-review", writable })
  await registerDelivery({ projectRoot, task, dispatchKey: "other-package", payload: { outcome: "delivered", summary: "其他包", paths: ["U.md"] } })
  await dispatch({ key: "other-stage", kind: "produce", role: "owner", round: 1, package: "draft", stage: "implementation", writable })
  await registerDelivery({ projectRoot, task, dispatchKey: "other-stage", payload: { outcome: "delivered", summary: "其他阶段", paths: ["Z.md"] } })
  await dispatch({ key: "draft-next", kind: "respond", role: "owner", round: 2, package: "draft", stage: "code-review", writable })
  const next = await registerDelivery({ projectRoot, task, dispatchKey: "draft-next", payload: { outcome: "delivered", summary: "草稿返工", paths: ["X.md"] } })
  assert.equal(next.added, undefined)
  assert.deepEqual(next.removed, ["Y.md"], "同包同阶段基线为 X/Y，不能混入其他包 U 或其他阶段 Z")
  assert.deepEqual((await reload()).artifacts.items.map((item) => item.path).sort(), ["U.md", "X.md", "Z.md"])
})

test("交付回执：同包并发交付分别比较各自在锁内看到的前置清单", async () => {
  const { projectRoot, task, dispatch, reload } = await fixture()
  const writable = [{ path: "X.md", artifactKind: "code-review" }, { path: "Y.md", artifactKind: "code-review" }]
  await writeFile(path.join(projectRoot, "X.md"), "X", "utf8")
  await writeFile(path.join(projectRoot, "Y.md"), "Y", "utf8")
  await dispatch({ key: "initial", kind: "produce", role: "owner", round: 1, package: "draft", writable })
  await registerDelivery({ projectRoot, task, dispatchKey: "initial", payload: { outcome: "delivered", summary: "初稿", paths: ["X.md", "Y.md"] } })
  await dispatch({ key: "later-x", kind: "respond", role: "owner", round: 2, package: "draft", writable })
  await dispatch({ key: "later-y", kind: "respond", role: "owner", round: 2, package: "draft", writable })
  const [x, y] = await Promise.all([
    registerDelivery({ projectRoot, task, dispatchKey: "later-x", payload: { outcome: "delivered", summary: "仅交 X", paths: ["X.md"] } }),
    registerDelivery({ projectRoot, task, dispatchKey: "later-y", payload: { outcome: "delivered", summary: "仅交 Y", paths: ["Y.md"] } }),
  ])
  assert.deepEqual(x.removed, ["Y.md"])
  assert.deepEqual(y.removed, ["X.md"])
  const final = (await reload()).artifacts.items.map((item) => item.path)
  assert.equal(final.length, 1, "同包最终只保留后提交者的完整清单")
  const last = final[0] === "X.md" ? x : y
  const earlier = last === x ? y : x
  assert.deepEqual(last.added, final, "后提交者相对先提交的单项清单新增自己的路径")
  assert.equal(earlier.added, undefined, "先提交者相对初始 X/Y 不应报新增")
})

async function legacyIncrementalFixture(pkg = null, { single = false, minimalAccepted = false } = {}) {
  const f = await fixture()
  const writable = [{ path: "X.md", artifactKind: "code-review" }, { path: "Y.md", artifactKind: "code-review" }]
  for (const name of ["X.md", "Y.md"]) await writeFile(path.join(f.projectRoot, name), name, "utf8")
  const append = async (type, detail) => {
    const file = path.join(f.task.root, "journal.jsonl")
    const journal = await readFile(file, "utf8")
    const seq = journal.trim().split("\n").filter(Boolean).length + 1
    await writeFile(file, journal + JSON.stringify({ seq, at: "2026-01-01T00:00:00.000Z", type, detail }) + "\n")
  }
  const oldDelivery = async ({ key, paths, round, stage = "code-review", package: owner = pkg, waveId }) => {
    const detail = { key, kind: round === 1 ? "produce" : "respond", role: "owner", round, stage, package: owner, writable: paths.map((name) => ({ path: name, artifactKind: "code-review" })), ...(waveId ? { waveId } : {}) }
    await f.dispatch(detail)
    const reportId = "deliver-" + key
    const payload = { outcome: "delivered", summary: "旧增量", paths }
    await writeFile(path.join(f.task.root, "reports", reportId + ".json"), JSON.stringify({ reportId, dispatchKey: key, role: "owner", kind: "deliver", round, stage, package: owner, payload, at: "2026-01-01T00:00:00.000Z" }))
    await append("report-accepted", minimalAccepted ? { reportId, dispatchKey: key } : { reportId, dispatchKey: key, kind: "deliver", role: "owner", package: owner, stage, outcome: "delivered", paths, payload })
  }
  // 旧 a 交 X/Y，旧 b 增量只交 X；索引仍保留 Y 并指向旧 a。
  await oldDelivery({ key: "legacy-a", paths: ["X.md", "Y.md"], round: 1 })
  if (!single) await oldDelivery({ key: "legacy-b", paths: ["X.md"], round: 2 })
  return { ...f, writable, append, oldDelivery }
}

async function writeLegacyIndex({ projectRoot, task }, entries) {
  const items = []
  for (const { name, reportRef, stage = "code-review", package: owner } of entries) {
    await writeFile(path.join(projectRoot, name), name, "utf8")
    const digest = digestValue(name)
    await writeFile(path.join(task.root, "snapshots", digest + ".json"), JSON.stringify({ path: name, content: name, digest, at: "2026-01-02T00:00:00.000Z" }))
    items.push({ path: name, digest, kind: "code-review", stage, ...(owner !== undefined ? { package: owner } : {}), reportRef, snapshotRef: "snapshots/" + digest + ".json" })
  }
  await writeFile(path.join(task.root, "artifacts.json"), JSON.stringify({ items }))
  return items
}

test("blocked 回执说明保留有效清单，不使用 delivered 的移出提示", async () => {
  const { projectRoot, task, dispatch } = await fixture()
  await dispatch({ key: "hint-owner", kind: "produce", role: "owner", round: 1, writable: [] })
  const blocked = await registerDelivery({ projectRoot, task, dispatchKey: "hint-owner", payload: { outcome: "blocked", summary: "受阻", paths: [] } })
  assert.match(blocked.hint, /保留|不覆盖/, "阻塞提示应明确保留有效清单")
  assert.doesNotMatch(blocked.hint, /移出/, "阻塞不得声称旧制品被移出")
})

for (const sameKey of [true, false]) {
  test("旧单报告同 key blocked 保留有效基线，" + (sameKey ? "同 key" : "新 key") + "交付 X", async () => {
    const f = await legacyIncrementalFixture(null, { single: true, minimalAccepted: true })
    const { projectRoot, task, dispatch, reload, writable } = f
    const items = await writeLegacyIndex(f, [
      { name: "X.md", reportRef: "deliver-legacy-a", package: null },
      { name: "Y.md", reportRef: "deliver-legacy-a", package: null },
    ])
    const blockedPayload = { outcome: "blocked", summary: "旧任务受阻", paths: [] }
    const blocked = await registerDelivery({ projectRoot, task, dispatchKey: "legacy-a", payload: blockedPayload })
    assert.equal(blocked.ver, 2)
    assert.deepEqual(blocked.manifest, [])
    assert.equal(blocked.removed, undefined)
    const after = await reload()
    const base = deliverBaselines({ journal: after.journal, reports: after.reports.filter((r) => r.stage === "code-review") }).get(null)
    assert.equal(base?.report.reportId, "deliver-legacy-a", "同 key blocked 后仍选择旧 delivered 报告")
    assert.equal(base?.report.ver ?? 1, 1)
    assert.deepEqual(after.artifacts.items, items, "阻塞不改变旧有效索引")
    const repeated = await registerDelivery({ projectRoot, task, dispatchKey: "legacy-a", payload: blockedPayload })
    assert.equal(repeated.idempotent, true)
    assert.equal(repeated.ver, 2)
    assert.deepEqual(repeated.manifest, [])
    const key = sameKey ? "legacy-a" : "owner-next"
    if (!sameKey) await dispatch({ key, kind: "respond", role: "owner", round: 2, writable })
    const done = await registerDelivery({ projectRoot, task, dispatchKey: key, payload: { outcome: "delivered", summary: "继续交付", paths: ["X.md"] } })
    assert.equal(done.ver, sameKey ? 3 : 1, "报告身份与版本仍由当前 key 决定")
    assert.deepEqual(done.manifest, ["X.md"])
    assert.equal(done.added, undefined)
    assert.deepEqual(done.removed, ["Y.md"], "阻塞前 Y 属于有效清单")
    assert.match(done.hint, /移出/, "正常 delivered 提示保持原语义")
  })
}

for (const missingReportPackage of [false, true]) {
  test("旧多包索引缺 package：新 key blocked 后保留各包与阶段，报告" + (missingReportPackage ? "缺" : "有") + "包归属", async () => {
    const f = await legacyIncrementalFixture("draft")
    const { projectRoot, task, dispatch, reload, oldDelivery, writable } = f
    await oldDelivery({ key: "legacy-other", paths: ["Z.md"], round: 1, package: "other" })
    await oldDelivery({ key: "legacy-stage", paths: ["W.md"], round: 1, package: "draft", stage: "implementation" })
    if (missingReportPackage) {
      const reportFile = path.join(task.root, "reports", "deliver-legacy-a.json")
      const report = JSON.parse(await readFile(reportFile, "utf8"))
      delete report.package
      await writeFile(reportFile, JSON.stringify(report))
    }
    const items = await writeLegacyIndex(f, [
      { name: "X.md", reportRef: "deliver-legacy-b" },
      { name: "Y.md", reportRef: "deliver-legacy-a" },
      { name: "Z.md", reportRef: "deliver-legacy-other" },
      { name: "W.md", reportRef: "deliver-legacy-stage", stage: "implementation" },
    ])
    await writeFile(path.join(task.root, "packages.json"), JSON.stringify({ items: [{ id: "draft" }, { id: "other" }] }))
    const multi = await reload()
    await dispatch({ key: "draft-blocked", kind: "respond", role: "owner", round: 3, package: "draft", stage: "code-review", writable })
    const blocked = await registerDelivery({ projectRoot, task: multi, dispatchKey: "draft-blocked", payload: { outcome: "blocked", summary: "暂时受阻", paths: [] } })
    assert.equal(blocked.removed, undefined)
    const after = await reload()
    assert.deepEqual(after.artifacts.items.map((i) => [i.path, i.reportRef]).sort(), items.map((i) => [i.path, i.reportRef]).sort(), "缺 package 的旧索引及其他阶段、包均保留")
    await dispatch({ key: "draft-done", kind: "respond", role: "owner", round: 4, package: "draft", stage: "code-review", writable })
    const done = await registerDelivery({ projectRoot, task: after, dispatchKey: "draft-done", payload: { outcome: "delivered", summary: "继续交付", paths: ["X.md"] } })
    assert.deepEqual(done.manifest, ["X.md"])
    assert.equal(done.added, undefined)
    assert.deepEqual(done.removed, ["Y.md"])
    assert.deepEqual((await reload()).artifacts.items.map((i) => i.path).sort(), ["W.md", "X.md", "Z.md"], "重交不影响其他包与阶段")
  })
}

for (const key of ["legacy-a", "legacy-b"]) {
  test("旧增量跨报告：" + key + " 同 key blocked 保留报告顺序和有效清单", async () => {
    const f = await legacyIncrementalFixture()
    const { projectRoot, task, reload } = f
    await writeLegacyIndex(f, [
      { name: "X.md", reportRef: "deliver-legacy-b", package: null },
      { name: "Y.md", reportRef: "deliver-legacy-a", package: null },
    ])
    const blocked = await registerDelivery({ projectRoot, task, dispatchKey: key, payload: { outcome: "blocked", summary: "暂时受阻", paths: [] } })
    assert.equal(blocked.ver, 2)
    const after = await reload()
    assert.ok(after.reports.some((r) => r.reportId === "deliver-" + key && (r.ver ?? 1) === 1 && r.payload.outcome === "delivered"), "旧 v1 不被覆盖丢失")
    const base = deliverBaselines({ journal: after.journal, reports: after.reports.filter((r) => r.stage === "code-review") }).get(null)
    assert.equal(base?.report.reportId, "deliver-legacy-b", "按旧提交先后选 b，不能把迟到 blocked 的 a 变成最新基线")
    assert.deepEqual(after.artifacts.items.map((i) => i.path).sort(), ["X.md", "Y.md"])
    const done = await registerDelivery({ projectRoot, task, dispatchKey: key, payload: { outcome: "delivered", summary: "继续交付", paths: ["X.md"] } })
    assert.equal(done.ver, 3)
    assert.deepEqual(done.manifest, ["X.md"])
    assert.equal(done.added, undefined)
    assert.deepEqual(done.removed, ["Y.md"])
  })
}

test("旧增量经新协议评审后再 blocked，索引仍保留 X/Y", async () => {
  const f = await legacyIncrementalFixture()
  const { projectRoot, task, dispatch, reload, writable } = f
  const items = await writeLegacyIndex(f, [
    { name: "X.md", reportRef: "deliver-legacy-b", package: null },
    { name: "Y.md", reportRef: "deliver-legacy-a", package: null },
  ])
  await dispatch({ key: "legacy-review", kind: "review", role: "challenger", round: 2, stage: "code-review", writable: [] })
  const review = await registerReview({ projectRoot, task, dispatchKey: "legacy-review", payload: { summary: "需返工", recommendation: "rework", findings: [{ severity: "risk", statement: "调整", disposition: "must-fix", scope: { kind: "all-covered" } }] } })
  assert.equal(review.accepted, true)
  assert.deepEqual((await reload()).artifacts.items, items, "评审不改变旧有效清单")
  await dispatch({ key: "legacy-blocked", kind: "respond", role: "owner", round: 3, writable })
  const blocked = await registerDelivery({ projectRoot, task, dispatchKey: "legacy-blocked", payload: { outcome: "blocked", summary: "暂时受阻", paths: [] } })
  assert.equal(blocked.removed, undefined)
  assert.deepEqual((await reload()).artifacts.items, items, "blocked 继续保留旧有效清单")
  await dispatch({ key: "legacy-after-block", kind: "respond", role: "owner", round: 4, writable })
  const done = await registerDelivery({ projectRoot, task, dispatchKey: "legacy-after-block", payload: { outcome: "delivered", summary: "继续交付", paths: ["X.md"] } })
  assert.equal(done.added, undefined)
  assert.deepEqual(done.removed, ["Y.md"], "评审和 blocked 后按原 X/Y 计算")
})

test("旧增量 blocked 提交后视图未更新也能恢复原清单和幂等重试", async () => {
  const f = await legacyIncrementalFixture("draft")
  const { projectRoot, task, reload } = f
  const items = await writeLegacyIndex(f, [
    { name: "X.md", reportRef: "deliver-legacy-b" },
    { name: "Y.md", reportRef: "deliver-legacy-a" },
  ])
  await writeFile(path.join(task.root, "packages.json"), JSON.stringify({ items: [{ id: "draft" }] }))
  const multi = await reload()
  const reportFile = path.join(task.root, "reports", "deliver-legacy-b.json")
  const indexFile = path.join(task.root, "artifacts.json")
  const reportBefore = await readFile(reportFile, "utf8")
  const indexBefore = await readFile(indexFile, "utf8")
  const payload = { outcome: "blocked", summary: "暂时受阻", paths: [] }
  assert.equal((await registerDelivery({ projectRoot, task: multi, dispatchKey: "legacy-b", payload })).ver, 2)
  // 模拟提交后、报告和索引视图写入前中断，journal 已有 blocked 事实。
  await writeFile(reportFile, reportBefore)
  await writeFile(indexFile, indexBefore)
  const recovered = await reload()
  assert.deepEqual(recovered.artifacts.items, items, "旧索引仍然完整而非只剩增量报告中的 X")
  assert.deepEqual(recovered.reports.filter((r) => r.reportId === "deliver-legacy-b").map((r) => r.ver ?? 1).sort(), [1, 2], "旧文件仍在时不得重复投影旧版本")
  assert.equal(deliverBaselines({ journal: recovered.journal, reports: recovered.reports.filter((r) => r.stage === "code-review") }).get("draft")?.report.reportId, "deliver-legacy-b")
  const retry = await registerDelivery({ projectRoot, task: multi, dispatchKey: "legacy-b", payload })
  assert.equal(retry.idempotent, true)
  assert.equal(retry.ver, 2)
  const done = await registerDelivery({ projectRoot, task: multi, dispatchKey: "legacy-b", payload: { outcome: "delivered", summary: "继续交付", paths: ["X.md"] } })
  assert.equal(done.ver, 3)
  assert.equal(done.added, undefined)
  assert.deepEqual(done.removed, ["Y.md"])
})

for (const { paths, removed } of [
  { paths: ["X.md"], removed: ["Y.md"] },
  { paths: ["Y.md"], removed: ["X.md"] },
  { paths: ["X.md", "Y.md"], removed: undefined },
]) {
  test("交付回执：旧增量跨报告索引后的完整清单 " + paths.join("、"), async () => {
    const { projectRoot, task, dispatch, reload, writable } = await legacyIncrementalFixture()
    const items = [
      { path: "X.md", digest: "a".repeat(64), kind: "code-review", stage: "code-review", package: null, reportRef: "deliver-legacy-b" },
      { path: "Y.md", digest: "b".repeat(64), kind: "code-review", stage: "code-review", package: null, reportRef: "deliver-legacy-a" },
    ]
    await writeFile(path.join(task.root, "artifacts.json"), JSON.stringify({ items }))
    const before = await reload()
    assert.equal(before.reports.find((r) => r.reportId === "deliver-legacy-b").files, undefined, "最新旧报告缺 files")
    assert.deepEqual(before.artifacts.items.map((item) => [item.path, item.reportRef]), [["X.md", "deliver-legacy-b"], ["Y.md", "deliver-legacy-a"]])
    await dispatch({ key: "owner-next", kind: "respond", role: "owner", round: 3, writable })
    const next = await registerDelivery({ projectRoot, task, dispatchKey: "owner-next", payload: { outcome: "delivered", summary: "新清单", paths } })
    assert.deepEqual(next.manifest, paths)
    assert.equal(next.added, undefined, "索引里的 X/Y 已存在，不得误报新增")
    assert.deepEqual(next.removed, removed, "只报告相对整个旧索引被移出的路径")
    assert.deepEqual((await reload()).artifacts.items.map((item) => item.path).sort(), paths)
  })
}

test("交付回执：旧索引仅计入同阶段同包的有效报告，并从派单恢复缺失包归属", async () => {
  const { projectRoot, task, dispatch, reload, oldDelivery, append, writable } = await legacyIncrementalFixture("draft")
  await oldDelivery({ key: "legacy-other", paths: ["Z.md"], round: 1, package: "other" })
  await oldDelivery({ key: "legacy-stage", paths: ["W.md"], round: 1, package: "draft", stage: "implementation" })
  await oldDelivery({ key: "legacy-retired", paths: ["R.md"], round: 1, package: "draft", waveId: "wv-retired" })
  await append("dispatch-superseded", { waveId: "wv-retired", reason: "旧波已作废" })
  // 较早报告与索引都不带 package 时，仍可由该报告关联的派单核对归属。
  const oldReportFile = path.join(task.root, "reports", "deliver-legacy-a.json")
  const oldReport = JSON.parse(await readFile(oldReportFile, "utf8"))
  delete oldReport.package
  await writeFile(oldReportFile, JSON.stringify(oldReport))
  const item = (name, reportRef, stage = "code-review", owner = undefined) => ({ path: name, digest: "a".repeat(64), kind: "code-review", stage, ...(owner !== undefined ? { package: owner } : {}), ...(reportRef ? { reportRef } : {}) })
  const items = [
    item("X.md", "deliver-legacy-b"),
    item("Y.md", "deliver-legacy-a"),
    item("Z.md", "deliver-legacy-other"),
    item("Q.md", "deliver-legacy-other", "code-review", "draft"),
    item("I.md", "deliver-legacy-a", "code-review", "other"),
    item("W.md", "deliver-legacy-stage", "implementation", "draft"),
    item("R.md", "deliver-legacy-retired", "code-review", "draft"),
    item("U.md", undefined, "code-review", "draft"),
    item("V.md", "deliver-unknown", "code-review", "draft"),
  ]
  const journal = await readFile(path.join(task.root, "journal.jsonl"), "utf8")
  await writeFile(path.join(task.root, "artifacts.json"), JSON.stringify({ items, journalSeq: journal.trim().split("\n").filter(Boolean).length }))
  await writeFile(path.join(task.root, "packages.json"), JSON.stringify({ items: [{ id: "draft" }, { id: "other" }] }))
  const multiTask = await reload()
  assert.equal(multiTask.packages.length, 2, "测试覆盖真实多包判定")
  await dispatch({ key: "draft-next", kind: "respond", role: "owner", round: 3, package: "draft", stage: "code-review", writable })
  const next = await registerDelivery({ projectRoot, task: multiTask, dispatchKey: "draft-next", payload: { outcome: "delivered", summary: "新清单", paths: ["X.md"] } })
  assert.equal(next.added, undefined)
  assert.deepEqual(next.removed, ["Y.md"], "其他包、阶段、作废和无可信报告的索引不得混入")
})

test("交付回执：新协议的空清单不继承旧索引中的路径", async () => {
  const { projectRoot, task, dispatch } = await fixture()
  const writable = [{ path: "X.md", artifactKind: "code-review" }, { path: "Y.md", artifactKind: "code-review" }]
  for (const name of ["X.md", "Y.md"]) await writeFile(path.join(projectRoot, name), name, "utf8")
  await dispatch({ key: "new-first", kind: "produce", role: "owner", round: 1, writable })
  await registerDelivery({ projectRoot, task, dispatchKey: "new-first", payload: { outcome: "delivered", summary: "初稿", paths: ["X.md", "Y.md"] } })
  await dispatch({ key: "new-empty", kind: "respond", role: "owner", round: 2, writable: [] })
  const empty = await registerDelivery({ projectRoot, task, dispatchKey: "new-empty", payload: { outcome: "delivered", summary: "空清单", paths: [] } })
  assert.deepEqual(empty.removed, ["X.md", "Y.md"])
  await dispatch({ key: "new-after-empty", kind: "respond", role: "owner", round: 3, writable })
  const next = await registerDelivery({ projectRoot, task, dispatchKey: "new-after-empty", payload: { outcome: "delivered", summary: "新交付", paths: ["X.md"] } })
  assert.deepEqual(next.added, ["X.md"], "前置新协议清单为空，X 是新增")
  assert.equal(next.removed, undefined, "新协议不得将旧索引里的 Y 混进空清单")
})

test("交付回执：用户确认的 Lead 刷新是旧 key 迟到重交的前置基线", async () => {
  const projectRoot = await makeProject()
  const call = autoCaller(projectRoot)
  await openTask(projectRoot, "refresh-receipt")
  const firstWave = await call(["dispatch-plan", "--task", "refresh-receipt", "--writable", "X.md:code-review", "--writable", "Y.md:code-review", "--writable", "Z.md:code-review"])
  const key = firstWave.waves[0].dispatchKey
  for (const name of ["X.md", "Y.md", "Z.md"]) await writeFile(path.join(projectRoot, name), name, "utf8")
  const first = await call(["deliver", "--task", "refresh-receipt", "--key", key, "--outcome", "delivered", "--summary", "初稿", "--paths", "X.md,Y.md"])
  assert.equal(first.accepted, true, JSON.stringify(first))
  const card = await call(["refresh-artifacts", "--task", "refresh-receipt", "--paths-json", JSON.stringify(["X.md", "Z.md"]), "--reason", "准备用户确认的刷新"])
  assert.equal(card.kind, "artifact-refresh", JSON.stringify(card))
  const confirmed = await call(["decide", "--task", "refresh-receipt", "--choice", "1", "--decision-id", card.decisionId])
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed))
  const late = await call(["deliver", "--task", "refresh-receipt", "--key", key, "--outcome", "delivered", "--summary", "迟到修订", "--paths", "X.md,Y.md"])
  assert.equal(late.accepted, true, JSON.stringify(late))
  assert.equal(late.ver, 2)
  assert.deepEqual(late.manifest, ["X.md", "Y.md"])
  assert.deepEqual(late.added, ["Y.md"], "相对刷新后的 X/Z 新增 Y")
  assert.deepEqual(late.removed, ["Z.md"], "相对刷新后的 X/Z 移出 Z")
})

test("deliver：越权路径同步拒绝并给修复指引（E2E-17 语义 + I5）", async () => {
  const { projectRoot, task, dispatch } = await fixture()
  await dispatch({ key: "w1-abc123", kind: "produce", role: "owner", round: 1, writable: [{ path: "CODE_REVIEW.md", artifactKind: "code-review" }] })
  await assert.rejects(
    registerDelivery({ projectRoot, task, dispatchKey: "w1-abc123", payload: { outcome: "delivered", summary: "s", paths: ["src/auth.ts"] } }),
    (error) => error.code === "INTAKE_REJECTED" && /不在本派单可写范围/.test(error.message) && /CODE_REVIEW.md/.test(error.message),
  )
})

test("deliver：同 key 重交幂等覆盖（E2E-10：重试不烧 key、不产生第二身份）", async () => {
  const { projectRoot, task, dispatch, reload } = await fixture()
  await dispatch({ key: "w1-abc123", kind: "produce", role: "owner", round: 1, writable: [{ path: "CODE_REVIEW.md", artifactKind: "code-review" }] })
  await writeFile(path.join(projectRoot, "CODE_REVIEW.md"), "v1", "utf8")
  await registerDelivery({ projectRoot, task, dispatchKey: "w1-abc123", payload: { outcome: "delivered", summary: "第一次", paths: ["CODE_REVIEW.md"] } })
  await writeFile(path.join(projectRoot, "CODE_REVIEW.md"), "v2", "utf8")
  await registerDelivery({ projectRoot, task, dispatchKey: "w1-abc123", payload: { outcome: "delivered", summary: "重试修正", paths: ["CODE_REVIEW.md"] } })
  const after = await reload()
  assert.equal(after.artifacts.items.length, 1)
  // 新契约：同 key 变内容 → 新 ver 的报告事实（journal），报告文件只保留最新 ver 缓存
  const same = after.reports.filter((r) => r.dispatchKey === "w1-abc123")
  assert.equal(same.length, 2, "两个 ver 的报告事实")
  assert.deepEqual(same.map((r) => r.ver), [1, 2])
  assert.equal(new Set(same.map((r) => r.reportId)).size, 1, "同一报告身份（key+ver 递增，不产生第二身份）")
})

test("review：无 paths 参数、Challenger 不得填 verdict、Expert 必填 verdict（E2E-05/09）", async () => {
  const { projectRoot, task, dispatch } = await fixture()
  await dispatch({ key: "w2-c1", kind: "review", role: "challenger", round: 1, writable: [] })
  await assert.rejects(
    registerReview({ projectRoot, task, dispatchKey: "w2-c1", payload: { summary: "s", recommendation: "accept", verdict: { outcome: "accept" } } }),
    (error) => error.code === "INTAKE_REJECTED" && /verdict 只能由 Expert/.test(error.message),
  )
  await assert.rejects(
    registerReview({ projectRoot, task, dispatchKey: "w2-c1", payload: { summary: "s" } }),
    (error) => error.code === "INTAKE_REJECTED" && /recommendation 必填/.test(error.message) && /只评价被审的这版交付/.test(error.message),
  )
  const ok = await registerReview({ projectRoot, task, dispatchKey: "w2-c1", payload: { summary: "覆盖充分", recommendation: "accept", findings: [{ severity: "risk", statement: "并发覆盖不足" }] } })
  assert.equal(ok.accepted, true)
  assert.ok(ok.reviewedDigest, "review 记录被审制品指纹")
})

test("I1：deliver 路径含符号链接逃逸 → 同步拒绝（防御性稳定读取）", async () => {
  const { symlink, writeFile } = await import("node:fs/promises")
  const projectRoot = await mkdtemp(path.join(tmpdir(), "tw-v3-"))
  await initTask({ projectRoot, name: "sym-t", objective: "o", entry: "code-review", completion: { mode: "through-stage", stage: "code-review" }, workflowDigest: "wd", stages: [] })
  const task = await loadTask(projectRoot, "sym-t", { workflow, policy })
  const fsp = await import("node:fs/promises")
  const jf = path.join(task.root, "journal.jsonl")
  const j = await readFile(jf, "utf8")
  const seq = j.trim().split("\n").length
  await fsp.writeFile(jf, j + JSON.stringify({ seq: seq + 1, at: new Date().toISOString(), type: "dispatched", detail: { key: "ks", kind: "produce", role: "owner", round: 1, writable: [{ path: "ESCAPED.md", artifactKind: "code-review" }] } }) + "\n")
  // 项目外目标文件 + 项目内符号链接指向它
  const outside = path.join(tmpdir(), `outside-${Date.now()}.md`)
  await writeFile(outside, "敏感内容", "utf8")
  await symlink(outside, path.join(projectRoot, "ESCAPED.md"))
  await assert.rejects(
    registerDelivery({ projectRoot, task, dispatchKey: "ks", payload: { outcome: "delivered", summary: "s", paths: ["ESCAPED.md"] } }),
    (error) => error.code === "INTAKE_REJECTED" && /越出项目根|符号链接/.test(error.message),
  )
  // 任务目录不应留下任何快照（内容未进入事实源）
  const after = await loadTask(projectRoot, "sym-t", { workflow, policy })
  assert.equal(after.artifacts.items.length, 0)
})

test("review：Expert 裁决形状同步校验", async () => {
  const { projectRoot, task, dispatch } = await fixture()
  await dispatch({ key: "w3-e1", kind: "verdict", role: "expert", round: 1, writable: [] })
  await assert.rejects(
    registerReview({ projectRoot, task, dispatchKey: "w3-e1", payload: { summary: "s", recommendation: "accept" } }),
    (error) => error.code === "INTAKE_REJECTED" && /verdict/.test(error.message),
  )
  const ok = await registerReview({ projectRoot, task, dispatchKey: "w3-e1", payload: { summary: "裁决", recommendation: "accept", verdict: { outcome: "accept", rationale: "证据充分", confidence: "high", recommendedAction: "进入门禁" } } })
  assert.equal(ok.accepted, true)
})

test("返工 finding scope 须锁内精确匹配计划，拒绝不落报告并可用原 key 修正", async () => {
  const { projectRoot, task, dispatch, reload } = await fixture()
  // 先建立两包有效交付基线（reviewableIds 从有效交付推导，不从 packages.json 猜）
  await dispatch({ key: "own-d01", kind: "produce", role: "owner", round: 1, package: "draft", writable: [{ path: "D.md", artifactKind: "code-review" }] })
  await dispatch({ key: "own-m01", kind: "produce", role: "owner", round: 1, package: "merge", writable: [{ path: "M.md", artifactKind: "code-review" }] })
  await writeFile(path.join(projectRoot, "D.md"), "草稿", "utf8")
  await writeFile(path.join(projectRoot, "M.md"), "汇总", "utf8")
  await registerDelivery({ projectRoot, task, dispatchKey: "own-d01", payload: { outcome: "delivered", summary: "s", paths: ["D.md"], checks: [], unresolved: [] } })
  await registerDelivery({ projectRoot, task, dispatchKey: "own-m01", payload: { outcome: "delivered", summary: "s", paths: ["M.md"], checks: [], unresolved: [] } })
  const task2 = await reload()
  await dispatch({ key: "review-package", kind: "review", role: "challenger", round: 1, writable: [] })
  const planFile = path.join(task2.root, "packages.json")
  await writeFile(planFile, JSON.stringify({ items: [{ id: "draft" }, { id: "merge" }] }))
  const journalFile = path.join(task2.root, "journal.jsonl")
  const journal = await readFile(journalFile, "utf8")
  // §5 scope 强类型：点名包必须精确属于被审包集合；形状非法聚合拒绝
  for (const scope of [{ kind: "packages", ids: ["unknown"] }, { kind: "packages", ids: ["draft", "unknown"] }, { kind: "packages", ids: [] }, { kind: "packages", ids: "draft" }, { kind: "all-covered", ids: ["draft"] }, { kind: "whole-group" }, "all-covered", null]) {
    await assert.rejects(registerReview({ projectRoot, task, dispatchKey: "review-package", payload: { summary: "返工", recommendation: "rework", findings: [{ severity: "risk", statement: "修改", disposition: "must-fix", scope }] } }),
      (error) => error.code === "INTAKE_REJECTED", JSON.stringify(scope))
    assert.equal(await readFile(journalFile, "utf8"), journal, "拒绝不追加 journal")
    assert.equal((await readdir(path.join(task2.root, "reports"))).includes("review-review-package.json"), false, "拒绝不写评审报告")
  }
  const payload = { summary: "返工", recommendation: "rework", findings: [
    { severity: "risk", statement: "修改草稿", disposition: "must-fix", scope: { kind: "packages", ids: ["draft"] } },
    { severity: "risk", statement: "修改汇总", disposition: "must-fix", scope: { kind: "packages", ids: ["merge"] } },
    { severity: "info", statement: "上下文说明" },
  ] }
  const ok = await registerReview({ projectRoot, task, dispatchKey: "review-package", payload })
  assert.equal(ok.accepted, true)
  const report = JSON.parse(await readFile(path.join(task.root, "reports", "review-review-package.json"), "utf8"))
  assert.equal(report.payload.findings[2].scope, undefined, "上下文意见不携带 scope")
  assert.equal((await registerReview({ projectRoot, task, dispatchKey: "review-package", payload })).idempotent, true)
})

test("返工 scope 校验覆盖专家裁决、匿名任务和损坏计划，不扩大 accept 语义", async () => {
  const { projectRoot, task, dispatch } = await fixture()
  await dispatch({ key: "review-expert", kind: "verdict", role: "expert", round: 1, writable: [] })
  const verdict = { outcome: "rework", rationale: "须修正", confidence: "high", recommendedAction: "返工" }
  // 匿名单 Owner 任务没有包 ID 可点名：packages scope 拒绝，all-covered 合法
  const payloadPkgs = { summary: "裁决", recommendation: "accept", verdict, findings: [{ severity: "risk", statement: "问题", disposition: "must-fix", scope: { kind: "packages", ids: ["draft"] } }] }
  await assert.rejects(registerReview({ projectRoot, task, dispatchKey: "review-expert", payload: payloadPkgs }), (error) => error.code === "INTAKE_REJECTED" && /单 Owner|不属于/.test(error.message))
  const payloadAll = { summary: "裁决", recommendation: "accept", verdict, findings: [{ severity: "risk", statement: "问题", disposition: "must-fix", scope: { kind: "all-covered" } }] }
  const planFile = path.join(task.root, "packages.json")
  for (const corrupt of ["{", "null", JSON.stringify({ items: {} })]) {
    await writeFile(planFile, corrupt)
    await assert.rejects(registerReview({ projectRoot, task, dispatchKey: "review-expert", payload: payloadPkgs }), (error) => error.code === "INTAKE_REJECTED" && /包计划|不属于|scope/.test(error.message), "损坏计划下 scope 不可判定：" + corrupt)
  }
  await writeFile(planFile, JSON.stringify({ items: [{ id: "draft" }] }))
  assert.equal((await registerReview({ projectRoot, task, dispatchKey: "review-expert", payload: payloadAll })).accepted, true, "all-covered 不依赖包计划")
  await dispatch({ key: "review-accept", kind: "review", role: "challenger", round: 1, writable: [] })
  await writeFile(planFile, "{")
  // 新契约：损坏计划 fail-closed（accept 也不读不出包集合时保守拒绝），恢复后照常
  await assert.rejects(registerReview({ projectRoot, task, dispatchKey: "review-accept", payload: { summary: "接受", recommendation: "accept", findings: [{ severity: "info", statement: "说明" }] } }), (error) => error.code === "INTAKE_REJECTED" && /包计划/.test(error.message))
  await writeFile(planFile, JSON.stringify({ items: [{ id: "draft" }] }))
  assert.equal((await registerReview({ projectRoot, task, dispatchKey: "review-accept", payload: { summary: "接受", recommendation: "accept", findings: [{ severity: "info", statement: "说明" }] } })).accepted, true, "非返工不扩展包名校验")
})
