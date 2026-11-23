#!/usr/bin/env node
// 确定性 CLI 预检：首卡完整性/一次确认/答复绑定/重签增量；计划非数组；评审包名精确校验。
// 用法：preflight-cli.mjs <eval-root> <tw-path> <repo-root>
// 只写 <eval-root>/cli-preflight 下的隔离项目，不访问项目外路径。
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync, existsSync, lstatSync, realpathSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const [evalRootArg, twPathArg, repoRootArg] = process.argv.slice(2)
if (!evalRootArg || !twPathArg) {
  console.error("usage: preflight-cli.mjs <eval-root> <tw-path> [repo-root]")
  process.exit(2)
}
const refuse = (message) => { console.error("preflight: REFUSE: " + message); process.exit(2) }
const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, "../../..")
if (!existsSync(evalRootArg)) refuse("eval-root missing: " + evalRootArg)
if (lstatSync(evalRootArg).isSymbolicLink()) refuse("eval-root must not be a symlink")
const evalReal = realpathSync(evalRootArg)
let repoReal, homeReal
try { repoReal = realpathSync(repoRoot) } catch { refuse("actual repo root missing: " + repoRoot) }
if (repoRootArg) {
  let argReal
  try { argReal = realpathSync(resolve(repoRootArg)) } catch { refuse("repo-root argument missing: " + repoRootArg) }
  if (argReal !== repoReal) refuse("repo-root argument must equal the actual script repo (" + repoReal + ")")
}
try { homeReal = realpathSync(process.env.HOME ?? "") } catch { refuse("HOME missing or unresolvable") }
if (evalReal === repoReal || evalReal.startsWith(repoReal + sep)) refuse("eval-root must be outside the real repo")
if (evalReal === homeReal || evalReal.startsWith(homeReal + sep)) refuse("eval-root must be outside the real HOME")
if (homeReal === evalReal || homeReal.startsWith(evalReal + sep)) refuse("real HOME must not be inside eval-root")
if (!existsSync(join(evalReal, "evidence/isolation-env.txt"))) refuse("eval-root lacks setup marker evidence/isolation-env.txt; run setup-isolation.sh first")
const twPathReal = existsSync(twPathArg) ? realpathSync(twPathArg) : refuse("tw-path missing: " + twPathArg)
if (!twPathReal.startsWith(evalReal + sep)) refuse("tw-path must stay inside eval-root")
const evalRoot = evalReal
const twPath = twPathReal
const config = JSON.stringify({
  tiers: {
    junior: { provider: "zai-coding-cn", model: "glm-5.3", effort: "max" },
    senior: { provider: "zai-coding-cn", model: "glm-5.3", effort: "max" },
    expert: { provider: "zai-coding-cn", model: "glm-5.3", effort: "max" },
  },
  entryId: "team-work-dsh",
  profile: "eval-cli",
})
const root = join(evalRoot, "cli-preflight")
if (existsSync(root) || (() => { try { lstatSync(root); return true } catch { return false } })()) refuse("preflight root already exists (refuse to reuse/overwrite): " + root)
try { mkdirSync(root) } catch (error) { refuse("cannot create preflight root exclusively (" + error.code + "): " + root) }
const checks = []
function record(name, ok, detail) { checks.push({ name, ok, detail }) ; if (!ok) console.error("FAIL", name, JSON.stringify(detail).slice(0, 800)) }
function tw(cwd, args) {
  const r = spawnSync(process.execPath, [twPath, ...args], { cwd, env: { ...process.env, TW_DSH_CONFIG: config }, encoding: "utf8" })
  let json = null
  try { json = JSON.parse(r.stdout) } catch {}
  return { status: r.status, json, stdout: r.stdout, stderr: r.stderr }
}
function taskDir(name) {
  const p = join(root, name)
  if (existsSync(p)) refuse("preflight task dir already exists: " + p)
  try { mkdirSync(p) } catch (error) { refuse("cannot create preflight task dir exclusively (" + error.code + "): " + p) }
  return p
}

// ---- 1. 首卡完整性、一次确认、答复绑定、重签增量 ----
const d1 = taskDir("card-flow")
const open = tw(d1, ["open", "--name", "preflight-card", "--objective", "预检：写一行虚构说明", "--raw-requirement", "在 docs/note.md 写一行虚构说明，内容自拟", "--constraint", "只写一个文件", "--exclusion", "不联网", "--scope-note", "实现阶段入口", "--acceptance", "docs/note.md 包含一行说明", "--entry", "implementation"])
record("open 只返回准备回执（无 decisionId、无卡）", open.json?.ok === true && open.json?.status === "preparing" && open.json?.decisionId === undefined && open.json?.card === undefined, open.json)
const plan = tw(d1, ["plan", "--task", "preflight-card", "--packages", JSON.stringify([{ id: "note", writable: ["docs/note.md:doc"], done: ["写一行虚构说明"], dependsOn: [] }])])
record("plan 只返回准备回执（无 decisionId、无卡）", plan.json?.ok === true && plan.json?.decisionId === undefined && plan.json?.replanned === false, plan.json)
const cardRes = tw(d1, ["dispatch-plan", "--task", "preflight-card"])
const card = cardRes.json?.card
record("首次推进签发一张 awaiting-user 卡且未派发", cardRes.json?.ok === true && cardRes.json?.stop === "awaiting-user" && Array.isArray(cardRes.json?.waves) && cardRes.json.waves.length === 0 && typeof card?.decisionId === "string" && card?.choices?.some((c) => c.grant === "accept-intake"), { stop: cardRes.json?.stop, decisionId: card?.decisionId, waves: cardRes.json?.waves })
const question = card?.question ?? ""
const intake = card?.intake ?? {}
const requiredText = ["在 docs/note.md 写一行虚构说明，内容自拟", "预检：写一行虚构说明", "只写一个文件", "不联网", "implementation", "docs/note.md 包含一行说明"]
record("首卡人读文本覆盖原文/目标/约束/排除/入口/验收", requiredText.every((t) => question.includes(t)), { missing: requiredText.filter((t) => !question.includes(t)) })
const roles = intake.roles ?? []
const pkg = (intake.packages ?? [])[0]
record("首卡结构化含三角色实际模型与逐包五字段", roles.length === 3 && roles.every((r) => r.modelRef?.provider === "zai-coding-cn" && r.modelRef?.modelName === "glm-5.3" && r.modelRef?.effort === "max") && pkg?.id === "note" && pkg?.writable?.length === 1 && pkg?.done?.length === 1 && Array.isArray(pkg?.dependsOn) && pkg?.modelRef?.modelName === "glm-5.3", { roles: roles.map((r) => r.role), pkg })
record("首卡指纹为非空 SHA-256", /^[0-9a-f]{64}$/.test(card?.intakeFingerprint ?? ""), card?.intakeFingerprint)
const samePlan = tw(d1, ["plan", "--task", "preflight-card", "--packages", JSON.stringify([{ id: "note", writable: ["docs/note.md:doc"], done: ["写一行虚构说明"], dependsOn: [] }])])
const afterSame = tw(d1, ["run", "--task", "preflight-card"])
record("相同计划重复登记不重签（等待中的 decisionId 不变）", samePlan.json?.ok === true && afterSame.json?.decisionId === card.decisionId, { planReplanned: samePlan.json?.replanned, pending: afterSame.json?.decisionId, card: card.decisionId })
const noId = tw(d1, ["decide", "--task", "preflight-card", "--choice", "1"])
record("缺 decision-id 的答复被拒（DECISION_STALE）", noId.json?.ok === false && noId.json?.code === "DECISION_STALE", noId.json)
const wrongId = tw(d1, ["decide", "--task", "preflight-card", "--choice", "1", "--decision-id", "intake-000000"])
record("错误 decision-id 被拒（DECISION_STALE）", wrongId.json?.ok === false && wrongId.json?.code === "DECISION_STALE", wrongId.json)
const okDecide = tw(d1, ["decide", "--task", "preflight-card", "--choice", "1", "--decision-id", card.decisionId])
record("正确 decision-id 接受首卡", okDecide.json?.ok === true && okDecide.json?.decisionId === card.decisionId, okDecide.json)
const replan = tw(d1, ["plan", "--task", "preflight-card", "--packages", JSON.stringify([{ id: "note", writable: ["docs/note.md:doc"], done: ["写一行虚构说明并注明虚构"], dependsOn: [] }])])
const cardB = replan.json
const diff = cardB?.intake?.diff
record("确认后计划变化触发重签增量卡（diff 基线与变更项）", cardB?.ok === true && cardB?.status === "awaiting-user" && cardB?.replanned === true && cardB?.decisionId !== card.decisionId && diff?.baseDecisionId === card.decisionId && diff?.changes?.some((c) => c.path === "packages[note].done[0]" && c.kind === "modified") && diff?.unchangedCount > 0, { decisionId: cardB?.decisionId, diff })
record("增量卡人读文本突出变更且折叠未变项", typeof cardB?.question === "string" && cardB.question.includes("增量") && cardB.question.includes("写一行虚构说明") && /\d+ 项未变/.test(cardB.question), { questionHead: (cardB?.question ?? "").slice(0, 300) })
const staleA = tw(d1, ["decide", "--task", "preflight-card", "--choice", "1", "--decision-id", card.decisionId])
record("旧卡 ID 答复重签卡被拒（DECISION_STALE）", staleA.json?.ok === false && staleA.json?.code === "DECISION_STALE", staleA.json)
const okB = tw(d1, ["decide", "--task", "preflight-card", "--choice", "1", "--decision-id", cardB.decisionId])
record("重签卡携带新 ID 被接受", okB.json?.ok === true && okB.json?.decisionId === cardB.decisionId, okB.json)
const dispatch = tw(d1, ["dispatch-plan", "--task", "preflight-card"])
record("确认后推进得到 owner 派单", dispatch.json?.ok === true && Array.isArray(dispatch.json?.waves) && dispatch.json.waves[0]?.role === "owner" && typeof dispatch.json.waves[0]?.dispatchKey === "string", { waves: dispatch.json?.waves?.map((w) => ({ role: w.role, key: w.dispatchKey })) })

// ---- 2. 计划非数组 ----
const d2 = taskDir("plan-shape")
tw(d2, ["open", "--name", "preflight-plan", "--objective", "预检：非数组 writable", "--raw-requirement", "测试非数组 writable 拒绝", "--entry", "implementation"])
const strPlan = tw(d2, ["plan", "--task", "preflight-plan", "--packages", JSON.stringify([{ id: "a", writable: "docs/a.md:doc", done: ["写 a"], dependsOn: [] }])])
record("字符串 writable 返回 PLAN_REJECTED 且提示缺 writable 数组", strPlan.json?.ok === false && strPlan.json?.code === "PLAN_REJECTED" && /writable/.test(strPlan.json?.message ?? ""), strPlan.json)
record("非数组错误不含逐字符重叠噪声", !/(都写|d\/o\/c|单个字符)/.test(strPlan.json?.message ?? ""), strPlan.json?.message)
const objPlan = tw(d2, ["plan", "--task", "preflight-plan", "--packages", JSON.stringify([{ id: "a", writable: { x: "docs/a.md:doc" }, done: ["写 a"], dependsOn: [] }])])
record("对象 writable 同样被拒（无裸异常）", objPlan.json?.ok === false && objPlan.json?.code === "PLAN_REJECTED", objPlan.json)
const goodPlan = tw(d2, ["plan", "--task", "preflight-plan", "--packages", JSON.stringify([{ id: "a", writable: ["docs/a.md:doc"], done: ["写 a"], dependsOn: [] }])])
record("合法数组 writable 仍被接受", goodPlan.json?.ok === true, { ok: goodPlan.json?.ok })

// ---- 3. 评审 finding 包名精确校验 ----
const d3 = taskDir("package-name")
function cmd(cwd, args) { return tw(cwd, args) }
tw(d3, ["open", "--name", "preflight-package", "--objective", "预检：包名校验", "--raw-requirement", "两个虚构文件各写一行", "--entry", "implementation"])
tw(d3, ["plan", "--task", "preflight-package", "--packages", JSON.stringify([
  { id: "a", writable: ["docs/a.md:doc"], done: ["写 a"], dependsOn: [] },
  { id: "b", writable: ["docs/b.md:doc"], done: ["写 b"], dependsOn: [] },
])])
const c3 = tw(d3, ["dispatch-plan", "--task", "preflight-package"]).json?.card
tw(d3, ["decide", "--task", "preflight-package", "--choice", "1", "--decision-id", c3.decisionId])
const w1 = tw(d3, ["dispatch-plan", "--task", "preflight-package"]).json
const docsDir = join(d3, "docs")
if (existsSync(docsDir)) refuse("preflight docs dir already exists: " + docsDir)
try { mkdirSync(docsDir) } catch (error) { refuse("cannot create preflight docs dir (" + error.code + "): " + docsDir) }
for (const [name, content] of [["a.md", "虚构 a\n"], ["b.md", "虚构 b\n"]]) {
  const file = join(docsDir, name)
  if (existsSync(file)) refuse("preflight fixture already exists: " + file)
  try { writeFileSync(file, content, { flag: "wx" }) } catch (error) { refuse("cannot create preflight fixture exclusively (" + error.code + "): " + file) }
}
for (const w of w1.waves) tw(d3, ["deliver", "--task", "preflight-package", "--key", w.dispatchKey, "--outcome", "delivered", "--summary", "虚构交付 " + w.package, "--paths", "docs/" + w.package + ".md"])
const w2 = tw(d3, ["dispatch-plan", "--task", "preflight-package"]).json
const reviewKey = w2.waves?.find((w) => w.role === "challenger")?.dispatchKey
const bad = tw(d3, ["review", "--task", "preflight-package", "--key", reviewKey, "--recommendation", "rework", "--summary", "虚构评审", "--findings", JSON.stringify([{ severity: "risk", statement: "虚构缺陷", package: "nope" }])])
record("未知包名 finding 被拒且列出可用 ID", bad.json?.ok === false && bad.json?.code === "INTAKE_REJECTED" && /可用 ID：a、b/.test(bad.json?.message ?? ""), bad.json)
const joined = tw(d3, ["review", "--task", "preflight-package", "--key", reviewKey, "--recommendation", "rework", "--summary", "虚构评审", "--findings", JSON.stringify([{ severity: "risk", statement: "虚构缺陷", package: "a,b" }])])
record("拼接包名 finding 被拒", joined.json?.ok === false && joined.json?.code === "INTAKE_REJECTED", joined.json)
const good = tw(d3, ["review", "--task", "preflight-package", "--key", reviewKey, "--recommendation", "rework", "--summary", "虚构评审", "--findings", JSON.stringify([{ severity: "risk", statement: "虚构缺陷", package: "a" }])])
record("合法包名 finding 被接受", good.json?.accepted === true && typeof good.json?.reportId === "string", { reportId: good.json?.reportId, ver: good.json?.ver })
const empty = tw(d3, ["review", "--task", "preflight-package", "--key", reviewKey, "--recommendation", "accept", "--summary", "虚构评审通过", "--findings", JSON.stringify([{ severity: "info", statement: "虚构观察", package: "" }])])
record("空字符串包名规范化为未点名并可接收", empty.json?.accepted === true && empty.json?.ver === 2, { ver: empty.json?.ver })

const failed = checks.filter((c) => !c.ok)
const out = { generatedAt: new Date().toISOString(), evalRoot, twPath, checks, passed: checks.length - failed.length, failed: failed.length }
console.log(JSON.stringify(out, null, 2))
process.exit(failed.length ? 1 : 0)
