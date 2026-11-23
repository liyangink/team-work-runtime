// v3 测试共享夹具：目录/定义/日志种子，压缩各测试文件的重复搭建
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { tw } from "../../runtime-v3/cli.mjs"
import { loadTask } from "../../runtime-v3/store.mjs"

export const FIX_WORKFLOW = {
  terminalStages: ["finish"],
  gates: [],
  stages: [{ id: "code-review", label: "代码审查", outputs: ["code-review"], teamScene: "code-review", route: "e2e" }],
}
export const FIX_POLICY = { maxAutonomousRounds: 3, costWeights: { junior: 1, senior: 10, expert: 50 }, riskTiers: { critical: "expert", high: "senior" }, roles: { owner: "junior", challenger: "senior", expert: "expert" }, scenes: { "code-review": { core: true } } }

// dispatch-plan 在派发点校验调用快照。本进程默认提供完整三档；
// 个别测试文件可覆盖 TW_DSH_CONFIG，隔离测试负责恢复环境。
process.env.TW_DSH_CONFIG = JSON.stringify({
  "entryId": "team-work-dsh",
  "profile": "fixture-profile",
  "tiers": {
    "junior": {
      "provider": "fx-junior",
      "model": "fx-junior"
    },
    "senior": {
      "provider": "fx-senior",
      "model": "fx-senior"
    },
    "expert": {
      "provider": "fx-expert",
      "model": "fx-expert"
    }
  }
})

// 夹具策略补 roles 兜底段：open 初始化三角色 ModelRef 需要（缺 roles.expert 即 unresolved，属被测语义，
// 夹具统一提供合法默认，个别用例可显式覆盖）。
export function fixturePolicy(policy = FIX_POLICY) {
  if (!policy) return policy
  return { roles: { owner: "junior", challenger: "senior", expert: "expert" }, ...policy }
}

export async function makeProject({ workflow = FIX_WORKFLOW, policy = FIX_POLICY } = {}) {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "tw-fx-"))
  const effectivePolicy = fixturePolicy(policy)
  if (workflow) await mkdir(path.join(projectRoot, "workflow/definitions"), { recursive: true }).then(() => writeFile(path.join(projectRoot, "workflow/definitions/engineering.json"), JSON.stringify(workflow)))
  if (effectivePolicy) await mkdir(path.join(projectRoot, "team-work/policies"), { recursive: true }).then(() => writeFile(path.join(projectRoot, "team-work/policies/default.json"), JSON.stringify(effectivePolicy)))
  return projectRoot
}

export function caller(projectRoot) {
  return (argv) => tw(argv, { projectRoot })
}

// 既有业务流程用例显式模拟用户看到意图卡后按卡号确认；确认门专项仍使用 caller 原始接口。
// 首卡在第一次 dispatch 才出现，重签卡仍可能由 plan/intent/roles 返回。
export function autoCaller(projectRoot) {
  const call = caller(projectRoot)
  return async (argv) => {
    const args = argv[0] === "open" && !argv.includes("--raw-requirement")
      ? [...argv, "--raw-requirement", "测试用户的完整合成需求"] : argv
    const result = await call(args)
    const card = args[0] === "dispatch-plan" ? result?.card : result
    const isIntake = card?.intakeFingerprint && card?.choices?.some((choice) => choice.grant === "accept-intake")
    if (isIntake && card?.status === "awaiting-user") {
      const option = card.choices.find((choice) => choice.grant === "accept-intake")
      const confirmed = await call(["decide", "--task", result.task, "--choice", String(option.n), "--decision-id", card.decisionId])
      // 并发推进时另一测试调用可能已经确认同一张卡；重推导由 Runtime 保证。
      if (confirmed.ok === false && confirmed.code !== "DECISION_STALE") throw new Error("模拟确认失败：" + JSON.stringify(confirmed))
      if (args[0] === "dispatch-plan") {
        const next = await call(args)
        if (result.warnings?.length) next.warnings = [...new Set([...(result.warnings ?? []), ...(next.warnings ?? [])])]
        return next
      }
    }
    return result
  }
}

// 开任务但不确认意图（确认门用例可通过 extra 显式提供原文）。
export async function openTaskRaw(projectRoot, name, { objective = "o", entry = "code-review", extra = [] } = {}) {
  const call = caller(projectRoot)
  const r = await call(["open", "--name", name, "--objective", objective, ...(entry ? ["--entry", entry] : []), ...(!extra.includes("--raw-requirement") ? ["--raw-requirement", "测试用户的完整合成需求"] : []), ...extra])
  if (r.ok === false) throw new Error("openTask failed: " + JSON.stringify(r))
  return r
}

// 测试调用方必须从实际收到的卡传入 ID，不能根据当前待决状态猜测。
export async function confirmIntake(projectRoot, name, decisionId) {
  return caller(projectRoot)(["decide", "--task", name, "--choice", "1", "--decision-id", decisionId])
}

export async function openTask(projectRoot, name, options = {}) {
  return openTaskRaw(projectRoot, name, options)
}

// 某些状态测试需要确认首卡但不实际派发：以原始接口模拟一次明确的用户确认。
export async function prepareIntake(projectRoot, name, writable = []) {
  const call = caller(projectRoot)
  const result = await call(["dispatch-plan", "--task", name, ...writable.flatMap((item) => ["--writable", item])])
  if (result.stop !== "awaiting-user" || !result.card?.intakeFingerprint) throw new Error("未得到意图确认卡：" + JSON.stringify(result))
  const choice = result.card.choices.find((item) => item.grant === "accept-intake")
  const confirmed = await call(["decide", "--task", name, "--choice", String(choice.n), "--decision-id", result.card.decisionId])
  if (!confirmed.ok) throw new Error("确认意图卡失败：" + JSON.stringify(confirmed))
  return result.card
}

// 仅供历史迁移用例模拟无确认协议标记的旧任务；不用于新版确认门用例。
export async function asLegacyTask(projectRoot, name) {
  const file = path.join(projectRoot, ".team-work", "tasks", name, "scope.json")
  const scope = JSON.parse(await readFile(file, "utf8"))
  delete scope.intakeVersion
  await writeFile(file, JSON.stringify(scope))
}

export async function seedDispatch(projectRoot, name, detail) {
  const task = await loadTask(projectRoot, name, { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const file = path.join(task.root, "journal.jsonl")
  const journal = await readFile(file, "utf8")
  const seq = journal.trim().split("\n").filter((l) => l.trim()).length
  await writeFile(file, journal + JSON.stringify({ seq: seq + 1, at: new Date().toISOString(), type: "dispatched", detail }) + "\n")
  return task
}

export async function seedReviewReport(projectRoot, name, { role, recommendation = "accept", verdict, dispatchKey = "seed", round = 1 }) {
  const task = await loadTask(projectRoot, name, { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  await mkdir(path.join(task.root, "reports"), { recursive: true })
  const id = `seed-${role}-${Date.now().toString(36)}`
  await writeFile(path.join(task.root, "reports", `${id}.json`), JSON.stringify({
    reportId: id, dispatchKey, role, kind: "review", round, stage: "code-review", taskSha: "seed",
    payload: { summary: "s", recommendation, ...(verdict ? { verdict } : {}) }, at: new Date().toISOString(),
  }))
  return id
}

// 收敛链夹具：open → Owner 交付 → Challenger accept + Expert accept 裁决 → E2E 路由 skip
// （E2E-01 静止测试与人工门 rework 测试共用）
export async function seedConvergedStage(projectRoot, name) {
  const call = autoCaller(projectRoot)
  await openTask(projectRoot, name)
  const plan = await call(["dispatch-plan", "--task", name, "--writable", "R.md:code-review"])
  if (!plan.waves?.length) throw new Error("seedConvergedStage: dispatch-plan 未产出派单：" + JSON.stringify(plan))
  const d = plan.waves[0]
  await writeFile(path.join(projectRoot, "R.md"), "报告", "utf8")
  await call(["deliver", "--task", name, "--key", d.dispatchKey, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  const task = await loadTask(projectRoot, name, { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const seedAt = new Date().toISOString() // 晚于真实 deliver，保持裁决新鲜
  const base = { dispatchKey: d.dispatchKey, round: 1, stage: "code-review", taskSha: "x" }
  const review = (role, payload) => ({ reportId: role, role, kind: "review", ...base, payload, at: seedAt })
  await writeFile(path.join(task.root, "reports", "rc.json"), JSON.stringify(review("challenger", { summary: "s", recommendation: "accept" })))
  await writeFile(path.join(task.root, "reports", "re.json"), JSON.stringify(review("expert", { summary: "s", recommendation: "accept", verdict: { outcome: "accept", rationale: "r", confidence: "high", recommendedAction: "a" } })))
  await call(["route", "--task", name, "--route", "e2e", "--decision", "skip", "--basis", "夹具跳过"])
  return { call, task, dispatchKey: d.dispatchKey }
}

// 纯函数层报告构造器（gate/derive 测试共用）；时间戳随轮次单调（裁决新鲜度依赖 at）
const t = (n) => `2026-01-01T00:00:${String(n).padStart(2, "0")}Z`
export const ownerDeliver = (round, extra = {}) => ({ reportId: `o${round}`, role: "owner", kind: "deliver", round, stage: "code-review", payload: { outcome: "delivered", summary: "s", paths: ["CODE_REVIEW.md"], checks: [], ...extra }, at: t((round - 1) * 10 + 1) })
export const challengerReview = (round, recommendation) => ({ reportId: `c${round}`, role: "challenger", kind: "review", round, stage: "code-review", reviewedPackages: [{ package: null, round }], payload: { summary: "s", findings: [], recommendation }, at: t((round - 1) * 10 + 2) })
export const expertVerdict = (outcome) => ({ reportId: "e1", role: "expert", kind: "review", round: 1, stage: "code-review", payload: { summary: "s", recommendation: "accept", verdict: { outcome, rationale: "r", confidence: "high", risks: [], recommendedAction: "a" } }, at: t(3) })
export const registeredArtifacts = { items: [{ path: "CODE_REVIEW.md", digest: "a".repeat(64), digestAlgorithm: "sha256-bytes-v1", kind: "code-review", stage: "code-review", reportRef: "o1", snapshotRef: "snap1" }] }
export const throughStageScope = { entry: "code-review", completion: { mode: "through-stage", stage: "code-review" }, workflowDigest: "wd" }
export const e2eSkipped = [{ route: "e2e", choice: "skip", basis: "测试夹具：跳过" }]
export const acceptedChain = () => [ownerDeliver(1), challengerReview(1, "accept"), expertVerdict("accept")]
// v3.2 波组夹具：包化 deliver/review（package 由 runtime 从派发事件写入报告）
// reviewed 快照便捷构造：包名数组 + 各包评审时轮次（默认 1）
export const snap = (pkgs, round = 1) => pkgs.map((p) => ({ package: p ?? null, round }))
export const pkgDeliver = (pkg, round, extra = {}) => ({ reportId: `o-${pkg ?? "solo"}-${round}`, role: "owner", kind: "deliver", round, stage: "code-review", package: pkg ?? null, payload: { outcome: "delivered", summary: "s", paths: [], checks: [], ...extra }, at: t((round - 1) * 10 + 1) })
export const pkgReview = (round, recommendation, packages_ = undefined, reviewed = undefined, extraPayload = {}) => ({ reportId: `c-${round}`, role: "challenger", kind: "review", round, stage: "code-review", ...(reviewed ? { reviewedPackages: reviewed } : {}), payload: { summary: "s", recommendation, ...(packages_ ? { findings: packages_.map((p) => ({ severity: "risk", statement: "s", ...(p != null ? { package: p } : {}) })) } : {}), ...extraPayload }, at: t((round - 1) * 10 + 5) })
export const pkgVerdict = (outcome, round = 1) => ({ reportId: `e-${round}`, role: "expert", kind: "review", round, stage: "code-review", payload: { summary: "s", recommendation: "accept", verdict: { outcome, rationale: "r", confidence: "high", risks: [], recommendedAction: "a" } }, at: t((round - 1) * 10 + 7) })
export const PACKAGES = [
  { id: "store", writable: ["runtime-v3/store.mjs"], done: ["覆盖 store"], dependsOn: [] },
  { id: "intake", writable: ["runtime-v3/intake.mjs"], done: ["覆盖 intake"], dependsOn: [] },
  { id: "cli", writable: ["runtime-v3/cli.mjs"], done: ["覆盖 cli"], dependsOn: [] },
  { id: "overview", writable: ["docs/overview.md"], done: ["汇总各包结论、解决冲突、不丢信息"], dependsOn: ["store", "intake", "cli"] },
]

