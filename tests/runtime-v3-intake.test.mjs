// runtime-v3 intake/store 文件系统测试
// 规约映射：§3 E2E-05/09/10/16/17 消解、§2 I1/I8/I10

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { initTask, loadTask, taskExists, validName, taskRoot } from "../runtime-v3/store.mjs"
import { registerDelivery, registerReview } from "../runtime-v3/intake.mjs"
import { seedDispatch, FIX_WORKFLOW as workflow, FIX_POLICY as policy } from "./support/v3-fixtures.mjs"

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
      && error.reasons.some((r) => r.includes("--outcome blocked") && r.includes("扩大可写范围")),
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
  assert.equal(snapshot.content, "# 审查\n发现 X")

  // 原地修订：同路径 → 同制品新 digest，旧快照保留（I8 恢复源 + E2E-16 同路径同制品）
  await dispatch({ key: "w3-def456", kind: "respond", role: "owner", round: 2, writable: [{ path: "CODE_REVIEW.md", artifactKind: "code-review" }] })
  await writeFile(path.join(projectRoot, "CODE_REVIEW.md"), "# 审查 v2\n补齐", "utf8")
  const r2 = await registerDelivery({ projectRoot, task: after, dispatchKey: "w3-def456", payload: { outcome: "delivered", summary: "补齐缺口", paths: ["CODE_REVIEW.md"], checks: [] } })
  const final = await reload()
  assert.equal(final.artifacts.items.length, 1, "同路径不产生第二个制品")
  assert.equal(final.artifacts.items[0].digest, r2.registered[0].digest)
  const oldSnapshot = JSON.parse(await readFile(path.join(final.root, "snapshots", `${receipt.registered[0].digest}.json`), "utf8"))
  assert.equal(oldSnapshot.content, "# 审查\n发现 X", "旧版本快照保留")
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
  assert.equal(after.reports.length, 1, "同 key 只有一份报告")
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
