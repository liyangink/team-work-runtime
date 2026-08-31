// runtime-v3 核心纯函数测试：waves / gate / derive
// 规约映射：§2 I5/I6/I7、§3 E2E-14、AGENTS 规则 5（任意阶段介入）

import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { nextWave, scenePolicy } from "../runtime-v3/waves.mjs"
import { gateCheck, artifactsFingerprint } from "../runtime-v3/gate.mjs"
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
