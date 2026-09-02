// runtime-v3 核心纯函数测试：waves / gate / derive
// 规约映射：§2 I5/I6/I7、§3 E2E-14、AGENTS 规则 5（任意阶段介入）

import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { nextWave, scenePolicy } from "../runtime-v3/waves.mjs"
import { gateCheck, artifactsFingerprint, artifactFingerprints } from "../runtime-v3/gate.mjs"
import { writablePathsOverlap } from "../runtime-v3/domain/writable.mjs"
import { deriveTask } from "../runtime-v3/derive.mjs"
import { ownerDeliver, challengerReview, expertVerdict, registeredArtifacts, throughStageScope, e2eSkipped, pkgDeliver, pkgReview, pkgVerdict, PACKAGES, snap } from "./support/v3-fixtures.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const workflow = JSON.parse(await readFile(path.join(here, "../workflow/definitions/engineering.json"), "utf8"))
const policy = JSON.parse(await readFile(path.join(here, "../team-work/policies/default.json"), "utf8"))

const codeReviewScene = scenePolicy(policy, "code-review")
const implScene = scenePolicy(policy, "implementation")

test("波次推进：produce → review → verdict（核心场景）→ gate（单 owner 兼容：匿名包 [null]）", () => {
  assert.deepEqual(nextWave({ scenePolicy: codeReviewScene, reports: [] }), { kind: "produce", role: "owner", round: 1, owners: [{ package: null, round: 1, continuation: false }] })
  assert.deepEqual(nextWave({ scenePolicy: codeReviewScene, reports: [ownerDeliver(1)] }), { kind: "review", role: "challenger", round: 1, continuation: false })
  assert.deepEqual(
    nextWave({ scenePolicy: codeReviewScene, reports: [ownerDeliver(1), challengerReview(1, "accept")] }),
    { kind: "verdict", role: "expert", round: 1 },
  )
  assert.deepEqual(
    nextWave({ scenePolicy: codeReviewScene, reports: [ownerDeliver(1), challengerReview(1, "accept"), expertVerdict("accept")] }),
    { kind: "gate" },
  )
})

test("波次推进：非核心场景 challenger accept 后直接过门（无需 Expert）", () => {
  const reports = [{ reportId: "o1", role: "owner", kind: "deliver", round: 1, stage: "implementation", payload: { outcome: "delivered", summary: "s", paths: [], checks: [] }, at: "t" },
    { reportId: "c1", role: "challenger", kind: "review", round: 1, stage: "implementation", payload: { summary: "s", recommendation: "accept" }, at: "t" }]
  assert.deepEqual(nextWave({ scenePolicy: implScene, reports }).kind, "gate")
})

test("I6/三轮收敛：rework 循环与轮次耗尽升级用户", () => {
  const r1 = [ownerDeliver(1), challengerReview(1, "rework")]
  assert.deepEqual(nextWave({ scenePolicy: codeReviewScene, reports: r1 }), { kind: "respond", role: "owner", round: 2, owners: [{ package: null, round: 2, continuation: true }] })
  const r2 = [...r1, ownerDeliver(2), challengerReview(2, "rework")]
  assert.deepEqual(nextWave({ scenePolicy: codeReviewScene, reports: r2 }), { kind: "respond", role: "owner", round: 3, owners: [{ package: null, round: 3, continuation: true }] })
  const r3 = [...r2, ownerDeliver(3), challengerReview(3, "rework")]
  const exhausted = nextWave({ scenePolicy: codeReviewScene, reports: r3 })
  assert.equal(exhausted.kind, "converge-user")
  assert.match(exhausted.reason, /自主轮次上限/)
})

test("波组：DAG 分层派发（F1）——依赖未满足的包不在首波，依赖交付后解锁", () => {
  const w1 = nextWave({ scenePolicy: codeReviewScene, reports: [], packages: PACKAGES })
  assert.equal(w1.kind, "produce")
  assert.deepEqual(w1.owners.map((o) => o.package), ["store", "intake", "cli"], "总览包依赖未满足，不在首波")
  // 三模块交付后：总览解锁，同时三模块待评审 → 评审优先于新包 produce？否——todo（待交付）优先
  const w2 = nextWave({ scenePolicy: codeReviewScene, reports: [pkgDeliver("store", 1), pkgDeliver("intake", 1), pkgDeliver("cli", 1)], packages: PACKAGES })
  assert.equal(w2.kind, "review", "已交付待评审优先（总览包尚不能被评审）")
  const afterAccept = nextWave({ scenePolicy: codeReviewScene, reports: [pkgDeliver("store", 1), pkgDeliver("intake", 1), pkgDeliver("cli", 1), pkgReview(1, "accept", undefined, snap(["store", "intake", "cli"]))], packages: PACKAGES })
  assert.equal(afterAccept.kind, "verdict", "核心场景组合评审 accept 后进入裁决")
  const afterVerdict = nextWave({ scenePolicy: codeReviewScene, reports: [pkgDeliver("store", 1), pkgDeliver("intake", 1), pkgDeliver("cli", 1), pkgReview(1, "accept", undefined, snap(["store", "intake", "cli"])), pkgVerdict("accept")], packages: PACKAGES })
  assert.equal(afterVerdict.kind, "produce")
  assert.deepEqual(afterVerdict.owners.map((o) => o.package), ["overview"], "三模块收敛出集，总览包依赖满足解锁")
})

test("波组：findings 包归属选择性重派（F3）——未被点名包视同本轮通过", () => {
  const base = [pkgDeliver("store", 1), pkgDeliver("intake", 1), pkgDeliver("cli", 1)]
  const w = nextWave({ scenePolicy: codeReviewScene, reports: [...base, pkgReview(1, "rework", ["store"], snap(["store", "intake", "cli"]))], packages: PACKAGES })
  assert.equal(w.kind, "respond")
  assert.deepEqual(w.owners.map((o) => o.package), ["store"], "只重派被点名包")
  assert.equal(w.owners[0].continuation, true, "store 包已有报告 → 续派")
  // 无归属 findings → 保守回退全组
  const w2 = nextWave({ scenePolicy: codeReviewScene, reports: [...base, pkgReview(1, "rework", [null, null], snap(["store", "intake", "cli"]))], packages: PACKAGES })
  assert.deepEqual(w2.owners.map((o) => o.package).sort(), ["cli", "intake", "store"], "无归属 rework 回退全组当轮包")
})

test("波组：按包计轮（F2）——单包轮耗尽只出该包，不牵连他包", () => {
  const r1 = [pkgDeliver("store", 1), pkgDeliver("intake", 1), pkgDeliver("cli", 1), pkgReview(1, "rework", ["store"], snap(["store", "intake", "cli"]))]
  const r2 = [...r1, pkgDeliver("store", 2), pkgReview(2, "rework", ["store"], snap(["store"], 2))]
  const r3 = [...r2, pkgDeliver("store", 3), pkgReview(3, "rework", ["store"], snap(["store"], 3))]
  const exhausted = nextWave({ scenePolicy: codeReviewScene, reports: r3, packages: PACKAGES })
  assert.equal(exhausted.kind, "converge-user")
  assert.match(exhausted.reason, /store/, "理由点名耗尽的包")
})

test("波组：聚合裁决新鲜度（F8）——任一包新交付使旧裁决失效", () => {
  const accepted1 = [pkgDeliver("store", 1), pkgDeliver("intake", 1), pkgDeliver("cli", 1), pkgReview(1, "accept", undefined, snap(["store", "intake", "cli"])), pkgVerdict("accept")]
  // 总览包解锁交付 → 活跃集 = {overview}，旧裁决（先于总览交付）不应放行
  const afterOverview = nextWave({ scenePolicy: codeReviewScene, reports: [...accepted1, pkgDeliver("overview", 1)], packages: PACKAGES })
  assert.equal(afterOverview.kind, "review", "总览包新交付需新一轮评审，旧裁决不覆盖它")
})
test("可写重叠判定：同名文件/目录与祖先路径组件均重叠，兄弟前缀不重叠", () => {
  // 同一路径只一个 inode：docs 与 docs/、docs 与 docs/x 都判重叠（文件系统同名互斥）
  assert.equal(writablePathsOverlap("docs", "docs/"), true, "文件条目与同名目录条目重叠（同一路径）")
  assert.equal(writablePathsOverlap("docs", "docs/x.md"), true, "文件条目与其下路径重叠（祖先组件）")
  assert.equal(writablePathsOverlap("docs/", "docs/x.md"), true, "目录条目与其下路径重叠")
  assert.equal(writablePathsOverlap("docs", "docs"), true, "相同路径重叠")
  // 兄弟前缀（字符串前缀相同但路径组件不同）不重叠
  assert.equal(writablePathsOverlap("docs/", "docs-x/"), false, "兄弟目录不重叠")
  assert.equal(writablePathsOverlap("docs/", "docs-x/a.md"), false, "目录与兄弟目录下文件不重叠")
  assert.equal(writablePathsOverlap("docs", "other"), false, "不相关路径不重叠")
})

test("artifactFingerprints：目录条目（尾斜杠）归属其下制品，精确条目不扩张", () => {
  const items = [
    { path: "review/findings-a.md", digest: "da" },
    { path: "review/findings-b.md", digest: "db" },
    { path: "review-x/c.md", digest: "dc" },
    { path: "overview.md", digest: "dd" },
  ]
  const pkgs = [
    { id: "a", writable: ["review/:code-review"], done: ["d"], dependsOn: [] },
    { id: "b", writable: ["overview.md:doc"], done: ["d"], dependsOn: [] },
  ]
  const fps = artifactFingerprints(items, pkgs)
  // 包 a：目录条目归属 review/ 下两个制品（含指纹实体，非空集 digest）
  assert.equal(fps.a, artifactsFingerprint(items.filter((i) => i.path.startsWith("review/"))), "目录条目下制品归入包指纹（F5/F6 双指纹与僵局检测不漏检）")
  assert.notEqual(fps.a, artifactsFingerprint([]), "目录条目不得把包指纹算成空集")
  // 兄弟目录 review-x 不归包 a（前缀以路径组件为界）
  const withSibling = artifactFingerprints([...items, { path: "review-x/extra.md", digest: "dx" }], pkgs)
  assert.equal(withSibling.a, fps.a, "兄弟前缀（review-x）不归入目录条目")
  // 精确条目只归自身
  assert.equal(fps.b, artifactsFingerprint([items[3]]), "精确条目只归属自身路径")
})

test("门：through-stage 的 scoped final-acceptance 未决 → awaiting-user（I7 静止）", () => {
  const result = gateCheck({
    workflow, policy, stageId: "code-review", scope: throughStageScope,
    artifacts: registeredArtifacts,
    reports: [ownerDeliver(1), challengerReview(1, "accept"), expertVerdict("accept")],
    decisions: e2eSkipped, journal: [],
  })
  assert.equal(result.passed, false)
  const blocker = result.blockers.find((b) => b.awaitingUser)
  assert.ok(blocker, "缺人工门 blocker")
  assert.match(blocker.requirement, /scoped-final/)
  assert.ok(blocker.recovery, "I5：blocker 必有恢复边")
})

test("门：人工批准绑定制品指纹，制品变化即失效（I7）", () => {
  const reports = [ownerDeliver(1), challengerReview(1, "accept"), expertVerdict("accept")]
  const base = { workflow, policy, stageId: "code-review", scope: throughStageScope, reports, journal: [], decisions: e2eSkipped }
  const fingerprint = artifactsFingerprint(registeredArtifacts.items)
  const accepted = gateCheck({ ...base, artifacts: registeredArtifacts, decisions: [...e2eSkipped, { decisionId: "d1", gateId: "scoped-final-code-review", choice: "accept", fingerprint }] })
  assert.equal(accepted.passed, true)

  const changed = { items: [{ ...registeredArtifacts.items[0], digest: "d2" }] }
  const stale = gateCheck({ ...base, artifacts: changed, decisions: [...e2eSkipped, { decisionId: "d1", gateId: "scoped-final-code-review", choice: "accept", fingerprint }] })
  assert.equal(stale.passed, false)
  assert.match(stale.blockers.find((b) => b.awaitingUser).requirement, /指纹已过期/)
})

test("AGENTS 规则 5：code-review 介入不检查历史阶段制品（制品两分法）", () => {
  const result = gateCheck({
    workflow, policy, stageId: "code-review", scope: throughStageScope,
    artifacts: { items: [] },
    reports: [ownerDeliver(1), challengerReview(1, "accept"), expertVerdict("accept")],
    decisions: [...e2eSkipped, { decisionId: "d1", gateId: "scoped-final-code-review", choice: "accept", fingerprint: "any" }],
    journal: [],
  })
  const requirementKinds = result.blockers.map((b) => b.requirement).join()
  assert.match(requirementKinds, /code-review 尚未登记/)
  assert.doesNotMatch(requirementKinds, /requirement|design|spec|source|research/)
})

test("门：Owner 报告的 fail 检查阻塞（I6 验收不信声称）", () => {
  const failed = ownerDeliver(1, { checks: [{ name: "npm test", result: "fail" }] })
  const result = gateCheck({
    workflow, policy, stageId: "code-review", scope: throughStageScope,
    artifacts: registeredArtifacts, reports: [failed, challengerReview(1, "accept"), expertVerdict("accept")],
    decisions: [...e2eSkipped, { decisionId: "d1", gateId: "scoped-final-code-review", choice: "accept", fingerprint: artifactsFingerprint(registeredArtifacts.items) }],
    journal: [],
  })
  assert.equal(result.passed, false)
  assert.match(result.blockers.map((b) => b.requirement).join(), /npm test/)
})

test("F5 消费规则 2（derive 纯函数）：绑定波 blocked 后扩权重派已交付 → 旧 blocked 不二次触发仲裁", () => {
  // 人工门 rework → 绑定 respond 波 blocked → 扩权重派（非绑定 produce）delivered → 新评审链 accept →
  // 有效 blocked 投影（seq 因果）已解除 → F5 消费规则 2 不得被旧绑定波 blocked 报告再触发（回 gateCheck 人工门）
  const t = (n) => `2026-01-01T00:00:${String(n).padStart(2, "0")}Z`
  const journal = [
    { seq: 1, at: t(1), type: "dispatched", detail: { key: "d1-aaa", role: "owner", round: 1, waveId: "wv1", writable: [{ path: "R.md", artifactKind: "code-review" }] } },
    { seq: 2, at: t(2), type: "report-accepted", detail: { reportId: "o1" } },
    { seq: 3, at: t(3), type: "dispatched", detail: { key: "d2-bbb", role: "challenger", round: 1, waveId: "wv2" } },
    { seq: 4, at: t(4), type: "report-accepted", detail: { reportId: "rc1" } },
    { seq: 5, at: t(5), type: "dispatched", detail: { key: "d3-ccc", role: "expert", round: 1, waveId: "wv3" } },
    { seq: 6, at: t(6), type: "report-accepted", detail: { reportId: "re1" } },
    { seq: 7, at: t(7), type: "dispatched", detail: { key: "d4-ddd", role: "owner", round: 2, waveId: "wv4", causeDecisionId: "dec-1", writable: [{ path: "R.md", artifactKind: "code-review" }] } },
    { seq: 8, at: t(8), type: "report-accepted", detail: { reportId: "o2" } }, // blocked（绑定波）
    { seq: 9, at: t(9), type: "dispatched", detail: { key: "d5-eee", role: "owner", round: 3, waveId: "wv5", writable: [{ path: "R.md", artifactKind: "code-review" }, { path: "T.md", artifactKind: "code" }] } }, // 扩权重派（非绑定）
    { seq: 10, at: t(10), type: "report-accepted", detail: { reportId: "o3" } },
    { seq: 11, at: t(11), type: "dispatched", detail: { key: "d6-fff", role: "challenger", round: 3, waveId: "wv6" } },
    { seq: 12, at: t(12), type: "report-accepted", detail: { reportId: "rc2" } },
    { seq: 13, at: t(13), type: "dispatched", detail: { key: "d7-ggg", role: "expert", round: 3, waveId: "wv7" } },
    { seq: 14, at: t(14), type: "report-accepted", detail: { reportId: "re2" } },
  ]
  const reports = [
    { reportId: "o1", dispatchKey: "d1-aaa", role: "owner", kind: "deliver", round: 1, stage: "code-review", payload: { outcome: "delivered", summary: "s", paths: ["R.md"] }, at: t(2) },
    { reportId: "rc1", dispatchKey: "d2-bbb", role: "challenger", kind: "review", round: 1, stage: "code-review", reviewedPackages: [{ package: null, round: 1 }], payload: { summary: "s", recommendation: "accept" }, at: t(4) },
    { reportId: "re1", dispatchKey: "d3-ccc", role: "expert", kind: "review", round: 1, stage: "code-review", payload: { summary: "s", recommendation: "accept", verdict: { outcome: "accept", rationale: "r", confidence: "high", recommendedAction: "a" } }, at: t(6) },
    { reportId: "o2", dispatchKey: "d4-ddd", role: "owner", kind: "deliver", round: 2, stage: "code-review", payload: { outcome: "blocked", summary: "范围不够" }, at: t(8) },
    { reportId: "o3", dispatchKey: "d5-eee", role: "owner", kind: "deliver", round: 3, stage: "code-review", payload: { outcome: "delivered", summary: "扩权后完成", paths: ["R.md"] }, at: t(10) },
    { reportId: "rc2", dispatchKey: "d6-fff", role: "challenger", kind: "review", round: 3, stage: "code-review", reviewedPackages: [{ package: null, round: 3 }], payload: { summary: "s", recommendation: "accept" }, at: t(12) },
    { reportId: "re2", dispatchKey: "d7-ggg", role: "expert", kind: "review", round: 3, stage: "code-review", payload: { summary: "s", recommendation: "accept", verdict: { outcome: "accept", rationale: "r", confidence: "high", recommendedAction: "a" } }, at: t(14) },
  ]
  const decisions = [...e2eSkipped, { decisionId: "dec-1", gateId: "scoped-final-code-review", choice: "rework", artifactFingerprint: { null: "fp-at-decision" }, at: t(6) }]
  const result = deriveTask({
    scope: throughStageScope, intent: { objective: "o" },
    artifacts: { items: [{ path: "R.md", digest: "digest-after-fix", kind: "code-review", stage: "code-review" }] },
    reports, decisions, journal, workflow, policy,
  })
  assert.equal(result.status, "awaiting-user", "回 gateCheck 人工门（制品指纹已变、评审链新鲜）")
  assert.equal(result.next.reworkBlocked, undefined, "扩权重派交付后旧绑定波 blocked 报告不再二次触发 F5 仲裁")
})

test("E2E-14 根：task-completed 事件使 derive 幂等返回 completed", () => {
  const state = deriveTask({
    scope: throughStageScope, intent: { objective: "o" }, artifacts: registeredArtifacts,
    reports: [], decisions: [], journal: [{ seq: 9, at: "t", type: "task-completed", detail: { stage: "code-review" } }],
    workflow, policy,
  })
  assert.equal(state.status, "completed")
  assert.deepEqual(state.next, { kind: "none" })
})

test("derive：journal 的 stage-advanced 推导当前阶段", () => {
  const state = deriveTask({
    scope: { entry: "research", completion: { mode: "through-stage", stage: "code-review" }, workflowDigest: "wd" },
    intent: { objective: "o" }, artifacts: { items: [] }, reports: [], decisions: [],
    journal: [{ seq: 1, at: "t", type: "stage-advanced", detail: { to: "design" } }],
    workflow, policy,
  })
  assert.equal(state.stage, "design")
  assert.equal(state.status, "working")
  assert.equal(state.next.kind, "dispatch")
})

test("derive：门通过且到 completion → next=complete", () => {
  const state = deriveTask({
    scope: throughStageScope, intent: { objective: "o" }, artifacts: registeredArtifacts,
    reports: [ownerDeliver(1), challengerReview(1, "accept"), expertVerdict("accept")],
    decisions: [...e2eSkipped, { decisionId: "d1", gateId: "scoped-final-code-review", choice: "accept", fingerprint: artifactsFingerprint(registeredArtifacts.items) }],
    journal: [], workflow, policy,
  })
  assert.equal(state.gate.passed, true)
  assert.deepEqual(state.next, { kind: "complete" })
})

test("裁决新鲜度：返工后的旧 accept 裁决不放行（重新裁决）", () => {
  const r1 = [ownerDeliver(1), challengerReview(1, "accept"), expertVerdict("accept")]
  assert.equal(nextWave({ scenePolicy: codeReviewScene, reports: r1 }).kind, "gate")
  const afterRework = [...r1, ownerDeliver(2), challengerReview(2, "accept")]
  // 既有 expert 报告在场 → 重裁为续派（continuation=true，D3 同角色回溯解析原 Expert；首次裁决无该字段）
  assert.deepEqual(
    nextWave({ scenePolicy: codeReviewScene, reports: afterRework }),
    { kind: "verdict", role: "expert", round: 2, continuation: true },
  )
})
