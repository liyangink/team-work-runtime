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
export const FIX_POLICY = { maxAutonomousRounds: 3, scenes: { "code-review": { core: true } } }

export async function makeProject({ workflow = FIX_WORKFLOW, policy = FIX_POLICY } = {}) {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "tw-fx-"))
  if (workflow) await mkdir(path.join(projectRoot, "workflow/definitions"), { recursive: true }).then(() => writeFile(path.join(projectRoot, "workflow/definitions/engineering.json"), JSON.stringify(workflow)))
  if (policy) await mkdir(path.join(projectRoot, "team-work/policies"), { recursive: true }).then(() => writeFile(path.join(projectRoot, "team-work/policies/default.json"), JSON.stringify(policy)))
  return projectRoot
}

export function caller(projectRoot) {
  return (argv) => tw(argv, { projectRoot })
}

export async function openTask(projectRoot, name, { objective = "o", entry = "code-review" } = {}) {
  const call = caller(projectRoot)
  const r = await call(["open", "--name", name, "--objective", objective, ...(entry ? ["--entry", entry] : [])])
  if (r.ok === false) throw new Error("openTask failed: " + JSON.stringify(r))
  return r
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
  const call = caller(projectRoot)
  await openTask(projectRoot, name)
  const d = await call(["run", "--task", name, "--writable", "R.md:code-review"])
  await writeFile(path.join(projectRoot, "R.md"), "报告", "utf8")
  await call(["deliver", "--task", name, "--key", d.dispatch.key, "--outcome", "delivered", "--summary", "s", "--paths", "R.md"])
  const task = await loadTask(projectRoot, name, { workflow: FIX_WORKFLOW, policy: FIX_POLICY })
  const seedAt = new Date().toISOString() // 晚于真实 deliver，保持裁决新鲜
  const base = { dispatchKey: d.dispatch.key, round: 1, stage: "code-review", taskSha: "x" }
  const review = (role, payload) => ({ reportId: role, role, kind: "review", ...base, payload, at: seedAt })
  await writeFile(path.join(task.root, "reports", "rc.json"), JSON.stringify(review("challenger", { summary: "s", recommendation: "accept" })))
  await writeFile(path.join(task.root, "reports", "re.json"), JSON.stringify(review("expert", { summary: "s", recommendation: "accept", verdict: { outcome: "accept", rationale: "r", confidence: "high", recommendedAction: "a" } })))
  await call(["route", "--task", name, "--route", "e2e", "--decision", "skip", "--basis", "夹具跳过"])
  return { call, task, dispatchKey: d.dispatch.key }
}

// 纯函数层报告构造器（gate/derive 测试共用）；时间戳随轮次单调（裁决新鲜度依赖 at）
const t = (n) => `2026-01-01T00:00:${String(n).padStart(2, "0")}Z`
export const ownerDeliver = (round, extra = {}) => ({ reportId: `o${round}`, role: "owner", kind: "deliver", round, stage: "code-review", payload: { outcome: "delivered", summary: "s", paths: ["CODE_REVIEW.md"], checks: [], ...extra }, at: t((round - 1) * 10 + 1) })
export const challengerReview = (round, recommendation) => ({ reportId: `c${round}`, role: "challenger", kind: "review", round, stage: "code-review", payload: { summary: "s", findings: [], recommendation }, at: t((round - 1) * 10 + 2) })
export const expertVerdict = (outcome) => ({ reportId: "e1", role: "expert", kind: "review", round: 1, stage: "code-review", payload: { summary: "s", recommendation: "accept", verdict: { outcome, rationale: "r", confidence: "high", risks: [], recommendedAction: "a" } }, at: t(3) })
export const registeredArtifacts = { items: [{ path: "CODE_REVIEW.md", digest: "d1", kind: "code-review", stage: "code-review", reportRef: "o1", snapshotRef: "snap1" }] }
export const throughStageScope = { entry: "code-review", completion: { mode: "through-stage", stage: "code-review" }, workflowDigest: "wd" }
export const e2eSkipped = [{ route: "e2e", choice: "skip", basis: "测试夹具：跳过" }]
export const acceptedChain = () => [ownerDeliver(1), challengerReview(1, "accept"), expertVerdict("accept")]
