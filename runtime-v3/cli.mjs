// cli.mjs — tw CLI：v3 工具契约的参考实现（§4）
// 卡片输出为 JSON（Lead 在 DSH 里用 bash 调用并解析）；拒绝输出带修复指引（P2）。
import { randomBytes } from "node:crypto"
import { accessSync, constants } from "node:fs"
import { readFile, rm, cp, mkdir, access } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { initTask, loadTask, taskExists, taskRoot, archiveRoot, controlRoot, atomicJson, atomicWrite, withOwnerLock, validName } from "./store.mjs"
import { deriveTask } from "./derive.mjs"
import { gateCheck, artifactsFingerprint } from "./gate.mjs"
import { scenePolicy } from "./waves.mjs"
import { registerDelivery, registerReview } from "./intake.mjs"
import { TIERS, UNRESOLVED, ensureDshMap, resolveTiers, dshMapPath } from "./dsh-map.mjs"

function collectList(argv, flag) {
  const out = []
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === `--${flag}`) out.push(argv[i + 1])
  return out.flatMap((v) => String(v).split(",")).map((s) => s.trim()).filter(Boolean)
}

function parseJsonArg(value, label) {
  if (value === undefined || value === null || value === "") return undefined
  try {
    return JSON.parse(value)
  } catch {
    throw fail("USAGE", `${label} 不是合法 JSON：${value}`)
  }
}

async function cmdDeliver({ projectRoot, name, key, payload }) {
  const { workflow, policy } = await loadDefinitions(projectRoot)
  const task = await loadTask(projectRoot, name, { workflow, policy })
  return registerDelivery({ projectRoot, task, dispatchKey: key, payload })
}

async function cmdReview({ projectRoot, name, key, payload }) {
  const { workflow, policy } = await loadDefinitions(projectRoot)
  const task = await loadTask(projectRoot, name, { workflow, policy })
  return registerReview({ projectRoot, task, dispatchKey: key, payload })
}

async function loadDefinitionsWith(projectRoot) {
  const workflow = JSON.parse(await readFile(path.join(projectRoot, "workflow", "definitions", "engineering.json"), "utf8"))
  const policy = JSON.parse(await readFile(path.join(projectRoot, "team-work", "policies", "default.json"), "utf8"))
  return { workflow, policy }
}

// 仓库内运行时定义文件相对项目根定位（安装布局：.team-work 同级）
async function loadDefinitions(projectRoot) {
  try {
    return await loadDefinitionsWith(projectRoot)
  } catch {
    const here = path.dirname(new URL(import.meta.url).pathname)
    const workflow = JSON.parse(await readFile(path.join(here, "../workflow/definitions/engineering.json"), "utf8"))
    const policy = JSON.parse(await readFile(path.join(here, "../team-work/policies/default.json"), "utf8"))
    return { workflow, policy }
  }
}

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  error.card = { ok: false, code, message, fix: fixHint(code) }
  return error
}

function fixHint(code) {
  return ({
    TASK_EXISTS: "换一个任务名，或用 tw run --task <name> 继续既有任务",
    TASK_NOT_FOUND: "检查拼写；tw open 创建新任务",
    TASK_NAME_INVALID: "任务名使用小写字母/数字/连字符，≤64 字符",
    OPEN_INPUT_REQUIRED: "open 需要 --name 与 --objective；可选 --entry <stage>",
    DECISION_STALE: "读取最新卡片（tw run）后按其中的选项序号重新 decide",
    ENTRY_UNKNOWN: "--entry 必须是 workflow 声明的阶段之一",
    DISPATCH_INPUT_REQUIRED: "Owner 波次派发需要 --writable <path>:<kind>（可多次）",
    MAP_INVALID: "映射写法：{\"provider\":\"...\",\"model\":\"...\"} 显式分档，或 {\"use\":\"agent-default\"} 占位；档位 junior/senior/expert；删除 dsh.json 可自动重建",
    STATE_CORRUPT: "控制文件损坏：映射文件可删除重建；任务事实在 reports/journal，可重推导",
    LOCK_UNAVAILABLE: "任务锁被并发写者占用（成员交付/Lead 推进同时进行）：等几秒原样重试同一命令即可；崩溃进程的锁会被自动回收",
    LOCK_CORRUPT: "任务锁读取异常：崩溃残留的损坏锁会在约 10 秒后自动回收；持续失败且确认无并发写者时，可手动删除任务目录 locks/task.lock",
  })[code] ?? "运行 tw help 查看全部命令与参数"
}

// 复核修复：判定与写入必须同锁。appendEventsUnlocked 供已持锁的临界区使用。
async function appendEventsUnlocked(task, events) {
  const file = path.join(task.root, "journal.jsonl")
  const journal = await readFile(file, "utf8").catch(() => "")
  let seq = journal.trim().split("\n").filter((l) => l.trim()).length
  const lines = events.map((e) => JSON.stringify({ seq: ++seq, at: new Date().toISOString(), ...e }))
  await atomicWrite(file, journal + lines.map((l) => `${l}\n`).join(""))
  return seq
}

async function appendEvents(task, events) {
  return withOwnerLock(path.join(task.root, "locks", "task.lock"), () => appendEventsUnlocked(task, events))
}

function reworkContext(task, stageId) {
  // E2E-07 v3 编码：回应波次必须携带触发返工的意见（目录推导，成员不填报告 ID）
  const stageReports = task.reports.filter((r) => r.stage === stageId)
  const latest = (role) => stageReports.filter((r) => r.role === role).at(-1)
  const challenger = latest("challenger")
  const expert = latest("expert")
  const humanRework = task.decisions.filter((d) => d.choice === "rework").at(-1)
  const sections = []
  if (challenger?.payload?.recommendation === "rework" || challenger?.payload?.findings?.length) {
    const findings = (challenger.payload.findings ?? []).map((f) => `- [${f.severity}] ${f.statement}`).join("\n")
    sections.push(`### Challenger 意见（${challenger.payload.recommendation}）\n${challenger.payload.summary}${findings ? "\n" + findings : ""}`)
  }
  if (expert?.payload?.verdict) {
    const v = expert.payload.verdict
    sections.push(`### Expert 裁决（${v.outcome}）\n${v.rationale}\n建议：${v.recommendedAction}`)
  }
  if (humanRework) sections.push(`### 用户决定：返工\n${humanRework.note ?? "用户在人工门要求返工；结合上述意见修订交付。"}`)
  return sections.length ? `## 本轮返工/回应原因\n\n${sections.join("\n\n")}` : ""
}

// 派单 PATH 注入（Phase 1 过渡）：成员环境未必有 tw 于 PATH——解析本包 bin 绝对路径写入交付指令；
// Phase 3 插件把 tw 注册为 preset 层原生工具后本注入退役。
function twCommand() {
  if (process.env.TW_CMD) return process.env.TW_CMD
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "tw.mjs")
  try {
    accessSync(bin, constants.R_OK)
    return `node ${bin}`
  } catch {
    return "tw"
  }
}

function dispatchCard(task, stageDef, wave, detail) {
  const sp = scenePolicy(task.policy, stageDef.teamScene)
  const boundaries = detail.writable.map(({ path: p, artifactKind }) => `${p}（产出物 ${artifactKind}）`)
  return {
    ok: true,
    task: task.name,
    stage: stageDef.id,
    status: "working",
    next: "dispatch",
    transition: "dispatch",
    dispatch: {
      key: detail.key,
      role: wave.role,
      tier: wave.role === "owner" ? sp.ownerTier : wave.role === "challenger" ? sp.challengerTier : "expert",
      round: wave.round,
      kind: wave.kind,
      prompt: [
        `# 派单（key: ${detail.key}）`,
        `任务：${task.name}；阶段：${stageDef.id}（${stageDef.label}）；角色：${wave.role}；轮次：${wave.round}`,
        `目标：${task.intent.objective}`,
        task.intent.constraints.length ? `约束：\n${task.intent.constraints.map((c) => "- " + c).join("\n")}` : "",
        task.intent.exclusions.length ? `排除：\n${task.intent.exclusions.map((c) => "- " + c).join("\n")}` : "",
        wave.role === "owner" ? `可写路径（仅限）：\n${boundaries.map((b) => "- " + b).join("\n")}` : "只读派单：不得修改任何文件",
        wave.kind === "produce" || wave.kind === "respond"
          ? `完成后调用：${twCommand()} deliver --task ${task.name} --key ${detail.key} --outcome delivered --summary <一句话> --paths <可写路径>`
          : `完成后调用：${twCommand()} review --task ${task.name} --key ${detail.key} --recommendation <accept|rework|escalate> --summary <一句话>${wave.kind === "verdict" ? ' --verdict \'{"outcome":"accept|rework|choose-option|need-more-evidence|escalate-to-user","rationale":"…","confidence":"low|medium|high","recommendedAction":"…"}\'' : ""}`,
        wave.kind === "verdict" ? "Expert 裁决语义：recommendation 概括立场；verdict 是技术裁决正文（outcome/rationale/confidence/recommendedAction）。两者都通过上面的 review 调用提交，不要只写成文字。" : "",
        wave.kind === "respond" ? reworkContext(task, stageDef.id) : "",
        "上下文与派单已内嵌；不要读取 .team-work 内部状态，不要扫描项目外路径。",
      ].filter(Boolean).join("\n\n"),
    },
  }
}

async function cmdOpen({ projectRoot, name, objective, entry }) {
  if (!name || !objective) throw fail("OPEN_INPUT_REQUIRED", "open 需要 --name 与 --objective")
  const { workflow } = await loadDefinitions(projectRoot)
  const resolvedEntry = entry ?? "research"
  if (!workflow.stages.some((s) => s.id === resolvedEntry)) throw fail("ENTRY_UNKNOWN", `未知阶段：${resolvedEntry}`)
  const completion = entry ? { mode: "through-stage", stage: entry } : { mode: "workflow" }
  await initTask({ projectRoot, name, objective, entry: resolvedEntry, completion, workflowDigest: workflow.version, stages: workflow.stages.map((s) => s.id) })
  return { ok: true, task: name, stage: resolvedEntry, status: "working", next: "run", note: entry ? `任务从 ${entry} 介入，将运行到该阶段验收` : "任务将运行完整工作流" }
}

// 归档后的任务不是"不存在"：返回只读摘要卡（E2E-14 精神 + §5.2 归档只读摘要）
async function archivedCard(projectRoot, name) {
  try {
    const manifest = JSON.parse(await readFile(path.join(archiveRoot(projectRoot, name), "manifest.json"), "utf8"))
    return { ok: true, task: name, status: "archived", next: "none", form: manifest.form, archivedTo: ".team-work/archive/" + name, objective: manifest.objective, note: "任务已归档（只读）；后续工作请新开任务引用归档名" }
  } catch (error) {
    if (error.code !== "ENOENT") throw error
    return null
  }
}

async function cmdRun({ projectRoot, name, writable = [] }) {
  const { workflow, policy } = await loadDefinitions(projectRoot)
  if (!await taskExists(projectRoot, name)) {
    const archived = await archivedCard(projectRoot, name)
    if (archived) return archived
  }
  const early = await loadTask(projectRoot, name, { workflow, policy })
  const earlyState = deriveTask(early)
  if (earlyState.status === "completed") {
    // E2E-14：终态幂等——重复 run 返回与完成时完全相同的卡片
    return { ok: true, task: name, stage: earlyState.stage, status: "completed", next: "archive", transition: "complete", note: "任务完成。可 tw archive --task 归档（用户确认后）" }
  }
  // 复核修复：判定与写入同锁——并发 run 只有一方完成派发/推进，另一方锁内重推导后拿到新状态
  return withOwnerLock(path.join(early.root, "locks", "task.lock"), async () => {
    const task = await loadTask(projectRoot, name, { workflow, policy })
    const state = deriveTask(task)
    return runTransition({ projectRoot, name, writable, workflow, policy, task, state })
  })
}

async function runTransition({ projectRoot, name, writable, workflow, policy, task, state }) {

  if (state.next.kind === "dispatch") {
    if (!state.next.wave) {
      // 门失败且非人工阻塞（如裁决/指纹失效且无法自动重派）：返回 blocker 卡（I5）
      const blockers = (state.gate?.blockers ?? state.next.hint ?? []).map((b) => (typeof b === "string" ? { message: b, recovery: b } : b))
      return { ok: true, task: name, stage: state.stage, status: "blocked", next: "none", blockers, transition: "blocked" }
    }
    const wave = state.next.wave
    const stageDef = workflow.stages.find((s) => s.id === state.stage)
    const key = `w${task.journal.length + 1}-${randomBytes(3).toString("hex")}`
    let decl
    if (wave.role === "owner") {
      if (!writable.length) {
        const outputs = (stageDef.outputs ?? []).map((k) => `  --writable <路径>:${k}`).join("\n")
        throw fail("DISPATCH_INPUT_REQUIRED", `Owner 波次需要声明可写路径与产出物类型。阶段 ${stageDef.id} 的产出物合同：\n${outputs || "  （无声明产出物，纯调查/回应类派单可直接 --writable none）"}`)
      }
      decl = writable.map((entry) => {
        const sep = entry.lastIndexOf(":")
        return { path: entry.slice(0, sep), artifactKind: entry.slice(sep + 1) }
      })
    } else {
      decl = []
    }
    await appendEventsUnlocked(task, [{ type: "dispatched", detail: { key, kind: wave.kind, role: wave.role, round: wave.round, writable: decl } }])
    return dispatchCard({ ...task, policy }, stageDef, wave, { key, writable: decl })
  }
  if (state.next.kind === "advance") {
    const edges = (workflow.edges ?? []).filter((e) => e.from === state.stage)
    const edge = edges.find((e) => e.outcome === "pass") ?? edges[0]
    if (!edge) throw fail("STATE_CORRUPT", `阶段 ${state.stage} 没有可用出边`)
    await appendEventsUnlocked(task, [{ type: "stage-advanced", detail: { from: state.stage, to: edge.to } }])
    return { ok: true, task: name, stage: edge.to, status: "working", next: "run", transition: "advance", note: `${state.stage} 门禁通过，进入 ${edge.to}` }
  }
  if (state.next.kind === "complete") {
    await appendEventsUnlocked(task, [{ type: "task-completed", detail: { stage: state.stage } }])
    return { ok: true, task: name, stage: state.stage, status: "completed", next: "archive", transition: "complete", note: "任务完成。可 tw archive --task 归档（用户确认后）" }
  }
  if (state.next.kind === "wait-inflight") {
    return { ok: true, task: name, stage: state.stage, status: "working", next: "wait", transition: "wait-inflight", dispatchKey: state.next.dispatchKey, wave: { kind: state.wave.kind, role: state.wave.role, round: state.wave.round }, note: `波次 ${state.wave.kind}（${state.wave.role} 轮次 ${state.wave.round}）已派发，key ${state.next.dispatchKey}；等待成员交付后再 run。` }
  }
  if (state.next.kind === "await-decision") {
    const open = task.journal.filter((e) => e.type === "decision-issued").map((e) => e.detail.decisionId)
    const settled = new Set(task.journal.filter((e) => e.type === "decided").map((e) => e.detail.decisionId))
    const pending = open.find((id) => !settled.has(id))
    if (!pending) {
      const decisionId = `dec-${randomBytes(3).toString("hex")}`
      const human = state.gate?.humanGate
      const choices = human
        ? [{ n: 1, label: "accept", desc: "接受本阶段交付" }, { n: 2, label: "rework", desc: "要求返工（回到 Owner 波次）" }]
        : [{ n: 1, label: "追加一轮", desc: "授权追加一轮自主收敛", grant: "extra-round" }, { n: 2, label: "结束任务", desc: "以当前形态终止并归档" }]
      await appendEventsUnlocked(task, [{ type: "decision-issued", detail: { decisionId, gateId: human, reason: state.next.reason ?? `人工门 ${human}`, choices } }])
      return { ok: true, task: name, stage: state.stage, status: "awaiting-user", next: "decide", transition: "await-decision", decisionId, question: state.next.reason ?? `人工门 ${human}：是否接受交付？`, choices }
    }
    const issued = task.journal.find((e) => e.type === "decision-issued" && e.detail.decisionId === pending)
    return { ok: true, task: name, stage: state.stage, status: "awaiting-user", next: "decide", transition: "await-decision", decisionId: pending, question: issued.detail.reason, choices: issued.detail.choices }
  }
  if (state.next.kind === "blocked") {
    return { ok: true, task: name, stage: state.stage, status: "blocked", next: "none", transition: "blocked", blockers: [{ message: state.next.reason, recovery: state.next.reason }] }
  }
  return { ok: true, task: name, stage: state.stage, status: state.status, next: "run", transition: "none", gate: state.gate }
}

async function cmdDecide({ projectRoot, name, choice, note }) {
  const { workflow, policy } = await loadDefinitions(projectRoot)
  const task0 = await loadTask(projectRoot, name, { workflow, policy })
  return withOwnerLock(path.join(task0.root, "locks", "task.lock"), async () => {
    const task = await loadTask(projectRoot, name, { workflow, policy })
    const issued = task.journal.filter((e) => e.type === "decision-issued")
    const settled = new Set(task.journal.filter((e) => e.type === "decided").map((e) => e.detail.decisionId))
    const pending = issued.find((e) => !settled.has(e.detail.decisionId))
    if (!pending) throw fail("DECISION_STALE", "当前没有等待中的决定")
    const options = pending.detail.choices
    const picked = options.find((o) => o.n === choice)
    if (!picked) throw fail("DECISION_STALE", `选项序号 ${choice} 不在当前卡片中。合法选项：${options.map((o) => `${o.n}=${o.label}`).join("、")}`)

    const stageId = deriveTask(task).stage
    const current = task.artifacts.items.filter((item) => item.stage === stageId)
    const decision = {
      decisionId: pending.detail.decisionId,
      gateId: pending.detail.gateId ?? null,
      choice: picked.label,
      ...(picked.grant ? { grant: picked.grant } : {}),
      ...(pending.detail.gateId ? { fingerprint: artifactsFingerprint(current) } : {}),
      ...(note ? { note } : {}),
      proof: { mode: "caller-reported", at: new Date().toISOString() },
      at: new Date().toISOString(),
    }
    const file = path.join(task.root, "decisions.json")
    const existing = JSON.parse(await readFile(file, "utf8").catch(() => '{"items":[]}'))
    existing.items.push(decision)
    await atomicJson(file, existing)
    const events = [{ type: "decided", detail: { decisionId: decision.decisionId, choice: decision.choice } }]
    if (picked.label === "结束任务") events.push({ type: "task-completed", detail: { stage: stageId, by: "user", form: "partial" } })
    await appendEventsUnlocked(task, events)
    return { ok: true, task: name, decisionId: decision.decisionId, choice: decision.choice, next: "run" }
  })
}

// I8：从最后注册快照恢复被污染的产出物（路径即身份 → snapshots/<digest>.json）
async function cmdRestore({ projectRoot, name, target }) {
  const { workflow, policy } = await loadDefinitions(projectRoot)
  const task = await loadTask(projectRoot, name, { workflow, policy })
  const item = task.artifacts.items.find((i) => i.path === target)
  if (!item) throw fail("USAGE", `路径 ${target} 不是本任务登记的产出物；可恢复路径：${task.artifacts.items.map((i) => i.path).join("、") || "无"}`)
  const snapshot = JSON.parse(await readFile(path.join(task.root, item.snapshotRef), "utf8"))
  await atomicWrite(path.join(projectRoot, item.path), snapshot.content)
  return { ok: true, task: name, restored: item.path, fromDigest: item.digest, toDigestPrevious: "see journal", note: "已恢复最后注册内容；恢复后请成员重新 deliver 以刷新指纹" }
}

async function cmdRoute({ projectRoot, name, route, decision, basis }) {
  const { workflow, policy } = await loadDefinitions(projectRoot)
  const task = await loadTask(projectRoot, name, { workflow, policy })
  if (!["spec", "e2e"].includes(route)) throw fail("USAGE", "--route 只能是 spec 或 e2e")
  if (!["run", "skip"].includes(decision)) throw fail("USAGE", "--decision 只能是 run 或 skip")
  if (decision === "skip" && !basis) throw fail("USAGE", "skip 必须给出 --basis <跳过依据>（I9：可定位证据）")
  const file = path.join(task.root, "decisions.json")
  return withOwnerLock(path.join(task.root, "locks", "task.lock"), async () => {
    const existing = JSON.parse(await readFile(file, "utf8").catch(() => '{"items":[]}'))
    existing.items = existing.items.filter((d) => d.route !== route)
    existing.items.push({ decisionId: `route-${route}-${Date.now().toString(36)}`, route, choice: decision, ...(basis ? { basis } : {}), at: new Date().toISOString() })
    await atomicJson(file, existing)
    return { ok: true, task: name, route, decision, ...(basis ? { basis } : {}), next: "run" }
  })
}

async function cmdIntent({ projectRoot, name, objective, addConstraint = [], addExclusion = [] }) {
  const { workflow, policy } = await loadDefinitions(projectRoot)
  const task = await loadTask(projectRoot, name, { workflow, policy })
  if (deriveTask(task).status === "completed") {
    return { ok: false, code: "TASK_COMPLETED", message: "任务已完成；目标变更请开新任务并引用归档名", fix: "tw open --name <new> --objective <...>" }
  }
  const file = path.join(task.root, "intent.json")
  return withOwnerLock(path.join(task.root, "locks", "task.lock"), async () => {
    const intent = JSON.parse(await readFile(file, "utf8"))
    const change = {}
    if (objective) { intent.objective = objective; change.objective = objective }
    for (const c of addConstraint) if (!intent.constraints.includes(c)) intent.constraints.push(c)
    if (addConstraint.length) change.addConstraints = addConstraint
    for (const x of addExclusion) if (!intent.exclusions.includes(x)) intent.exclusions.push(x)
    if (addExclusion.length) change.addExclusions = addExclusion
    intent.revisions.push({ seq: intent.revisions.length + 1, at: new Date().toISOString(), change })
    await atomicJson(file, intent)
    return { ok: true, task: name, objective: intent.objective, constraints: intent.constraints, exclusions: intent.exclusions, note: "意图已更新；后续派单将使用新值" }
  })
}

async function cmdGate({ projectRoot, name }) {
  const { workflow, policy } = await loadDefinitions(projectRoot)
  const task = await loadTask(projectRoot, name, { workflow, policy })
  const state = deriveTask(task)
  if (state.gate) return { ok: true, task: name, stage: state.stage, passed: state.gate.passed, blockers: state.gate.blockers }
  const gate = gateCheck({ workflow, policy, stageId: state.stage, scope: task.scope, artifacts: task.artifacts, reports: task.reports.filter((r) => r.stage === state.stage), decisions: task.decisions, journal: task.journal })
  return { ok: true, task: name, stage: state.stage, passed: gate.passed, blockers: gate.blockers, wave: state.wave }
}

async function cmdArchive({ projectRoot, name }) {
  // 幂等：已归档的任务重复 archive 直接返回（§5.2）
  const dest = archiveRoot(projectRoot, name)
  try {
    const manifest = JSON.parse(await readFile(path.join(dest, "manifest.json"), "utf8"))
    return { ok: true, task: name, archivedTo: path.relative(projectRoot, dest), form: manifest.form, note: "任务已归档（幂等返回）" }
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  const { workflow, policy } = await loadDefinitions(projectRoot)
  const task = await loadTask(projectRoot, name, { workflow, policy })
  const state = deriveTask(task)
  const completedEvent = task.journal.filter((e) => e.type === "task-completed").at(-1)
  const form = completedEvent?.detail?.form === "partial" || (state.status !== "completed" && !completedEvent) ? "partial" : (completedEvent?.detail?.form === "partial" ? "partial" : state.status === "completed" ? "completed" : "partial")
  await mkdir(path.join(dest, "artifacts"), { recursive: true })
  const latest = new Map()
  for (const item of task.artifacts.items) latest.set(item.path, item)
  for (const item of latest.values()) {
    const snapshot = JSON.parse(await readFile(path.join(task.root, item.snapshotRef), "utf8"))
    await atomicWrite(path.join(dest, "artifacts", path.basename(item.path)), snapshot.content)
  }
  const stagePassed = task.journal.filter((e) => e.type === "stage-advanced" || e.type === "task-completed").map((e) => e.type === "task-completed" ? `${e.detail.stage}(终)` : e.detail.to)
  const reviews = task.reports.filter((r) => r.kind === "review").map((r) => ({ role: r.role, round: r.round, recommendation: r.payload.recommendation, findings: (r.payload.findings ?? []).length, verdict: r.payload.verdict?.outcome ?? null, summary: r.payload.summary }))
  await atomicJson(path.join(dest, "manifest.json"), {
    task: name, objective: task.intent.objective, constraints: task.intent.constraints,
    entry: task.scope.entry, completion: task.scope.completion,
    form,
    stagesPassed: stagePassed, reviews, createdAt: task.scope.createdAt, archivedAt: new Date().toISOString(),
  })
  await atomicJson(path.join(dest, "decisions.json"), { items: task.decisions })
  await atomicWrite(path.join(dest, "journal-summary.jsonl"), task.journal
    .filter((e) => ["task-opened", "stage-advanced", "gate-passed", "decision-issued", "decided", "task-completed", "report-rejected"].includes(e.type))
    .map((e) => JSON.stringify(e)).join("\n") + "\n")
  await rm(taskRoot(projectRoot, name), { recursive: true, force: true })
  // 归档只读强制（§5.2：归档后目录只读）——文件 0444、目录 0555
  await markTreeReadOnly(dest)
  return { ok: true, task: name, archivedTo: path.relative(projectRoot, dest), form, kept: ["manifest.json", "artifacts/", "reviews(在 manifest)", "decisions.json", "journal-summary.jsonl"], cleaned: ["reports/", "snapshots/", "gates/", "runtime 状态"] }
}

// dispatch-plan（§1.1）：编排脚本的唯一输入。锁内追非派发转移（advance/complete/人工门卡片）
// 直到派发点或 stop；派发点注册 dispatched 事件并导出机器可读波次（prompt + tier→模型解析）。
async function cmdDispatchPlan({ projectRoot, name, writable = [], json = false }) {
  const { workflow, policy } = await loadDefinitions(projectRoot)
  if (!await taskExists(projectRoot, name)) {
    const archived = await archivedCard(projectRoot, name)
    if (archived) return { ok: true, task: name, stage: null, stop: "archived", waves: [], card: archived }
  }
  const early = await loadTask(projectRoot, name, { workflow, policy })
  const earlyState = deriveTask(early)
  if (earlyState.status === "completed") {
    const card = { ok: true, task: name, stage: earlyState.stage, status: "completed", next: "archive", note: "任务完成。可 tw archive --task 归档（用户确认后）" }
    return { ok: true, task: name, stage: earlyState.stage, stop: "completed", waves: [], card }
  }
  return withOwnerLock(path.join(early.root, "locks", "task.lock"), async () => {
    const warnings = []
    const ensured = await ensureDshMap(projectRoot).catch((error) => ({ error }))
    if (ensured.error) warnings.push(`映射模板生成失败（${ensured.error.message}）；按占位解析继续`)
    const resolved = await resolveTiers(projectRoot)
    warnings.push(...resolved.warnings)
    const planStop = (stop, card, extra = {}) => ({ ok: true, task: name, stage: card.stage ?? null, stop, waves: [], card, ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}), ...extra })
    for (let hop = 0; hop <= workflow.stages.length + 2; hop += 1) {
      const task = await loadTask(projectRoot, name, { workflow, policy })
      const state = deriveTask(task)
      const card = await runTransition({ projectRoot, name, writable, workflow, policy, task, state })
      if (card.transition === "dispatch") {
        const d = card.dispatch
        const deliver = d.kind === "produce" || d.kind === "respond" ? "deliver" : "review"
        const hint = resolved.tiers[d.tier]
        if (!hint) warnings.push(`未知档位 ${d.tier}，标记未解析`)
        const modelHint = hint ?? { ...UNRESOLVED }
        const wave = {
          dispatchKey: d.key, kind: d.kind, role: d.role, tier: d.tier, round: d.round,
          prompt: d.prompt,
          deliver,
          modelHint: { provider: modelHint.provider, model: modelHint.model, source: modelHint.source },
          dispatchExample: deliver === "deliver"
            ? `${twCommand()} deliver --task ${name} --key ${d.key} --outcome delivered --summary <一句话> --paths <可写路径>`
            : `${twCommand()} review --task ${name} --key ${d.key} --recommendation <accept|rework|escalate> --summary <一句话>${d.kind === "verdict" ? " --verdict '{\"outcome\":\"accept\",\"rationale\":\"…\",\"confidence\":\"high\",\"recommendedAction\":\"…\"}'" : ""}`,
        }
        const plan = {
          ok: true, task: name, stage: card.stage, stop: null,
          waves: [wave],
          card: { status: card.status, next: card.next },
          mapping: path.relative(projectRoot, dshMapPath(projectRoot)),
          ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}),
        }
        if (!json) {
          plan.human = [
            `任务 ${name} · 阶段 ${card.stage} · ${wave.role}(${wave.tier}) ${wave.kind} 第 ${wave.round} 轮`,
            `模型：${modelHint.provider}/${modelHint.model}（来源 ${modelHint.source}）`,
            "派单全文：",
            wave.prompt,
            `交付示例：${wave.dispatchExample}`,
          ]
        }
        return plan
      }
      if (card.transition === "advance") continue // stage-advanced 已写；锁内重推导下一阶段
      if (card.transition === "complete") return planStop("completed", card)
      if (card.transition === "wait-inflight") return planStop("wait-inflight", card, { dispatchKey: card.dispatchKey })
      if (card.transition === "await-decision") return planStop("awaiting-user", card)
      return planStop("blocked", card)
    }
    throw fail("STATE_CORRUPT", "dispatch-plan 推进循环超界（阶段图可能成环）")
  })
}

// models（§1.3）：映射解析结果展示——每档 provider/model + 来源 + 警告。无状态、不派发。
async function cmdModels({ projectRoot }) {
  const ensured = await ensureDshMap(projectRoot).catch((error) => ({ error }))
  const resolved = await resolveTiers(projectRoot)
  const warnings = [...resolved.warnings, ...(ensured.error ? [`映射模板生成失败（${ensured.error.message}）`] : [])]
  return {
    ok: true,
    file: path.relative(projectRoot, dshMapPath(projectRoot)),
    settings: resolved.agentDefault.file,
    agentDefault: resolved.agentDefault.resolved ? `${resolved.agentDefault.resolved.provider}/${resolved.agentDefault.resolved.model}` : null,
    tiers: TIERS.map((t) => ({ tier: t, ...resolved.tiers[t] })),
    ...(warnings.length ? { warnings } : {}),
    note: '分档：把任一档改为 {"provider":"...","model":"..."}；占位 {"use":"agent-default"} 解析为 DSH 主 agent 模型（agent-default-model）',
  }
}

// init（可选便捷命令，Phase 1 降级）：装载 skill 到 .dsh/skills/（DSH filesystem provider 扫描根）+ 确保映射模板。
// 核心流程（安装 → open → run）不需要它。
async function cmdInit({ projectRoot, force = false }) {
  const mapInfo = await ensureDshMap(projectRoot)
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", "team-work-v3")
  const dest = path.join(projectRoot, ".dsh", "skills", "team-work-v3")
  let skill
  try {
    await access(path.join(src, "SKILL.md"))
    const exists = await access(path.join(dest, "SKILL.md")).then(() => true, () => false)
    if (exists && !force) {
      skill = { installedTo: path.relative(projectRoot, dest), action: "skipped", note: "已存在；--force 覆盖" }
    } else {
      await rm(dest, { recursive: true, force: true })
      await cp(src, dest, { recursive: true })
      skill = { installedTo: path.relative(projectRoot, dest), action: exists ? "overwritten" : "installed" }
    }
  } catch {
    skill = { installedTo: null, action: "unavailable", note: "skill 源不在本安装布局内（npm files 应含 skills/team-work-v3/）" }
  }
  const resolved = await resolveTiers(projectRoot)
  return {
    ok: true,
    mapping: { file: path.relative(projectRoot, mapInfo.file), created: mapInfo.created },
    skill,
    agentDefault: resolved.agentDefault.resolved ? `${resolved.agentDefault.resolved.provider}/${resolved.agentDefault.resolved.model}` : null,
    tiers: TIERS.map((t) => ({ tier: t, ...resolved.tiers[t] })),
    ...(resolved.warnings.length ? { warnings: resolved.warnings } : {}),
    note: "init 只是便捷命令：装载 Lead 判断指引 skill 并确保映射模板；核心流程安装后直接 tw open 即可",
  }
}

// help（P4：CLI 即接口，--help 与拒绝输出即完整 meta）
function helpCard() {
  return {
    ok: true,
    commands: {
      open: "tw open --name <n> --objective <o> [--entry <stage>]：开任务（名字寻址；重名拒绝）",
      run: "tw run --task <n> [--writable <路径>:<kind> ...]：推进一步（返回卡片或派单）",
      "dispatch-plan": "tw dispatch-plan --task <n> [--json] [--writable ...]：编排输入——推进到派发点或 stop，输出波次计划（prompt + tier + modelHint）",
      decide: "tw decide --task <n> --choice <序号> [--note <...>]：回答当前卡片",
      intent: "tw intent --task <n> [--objective <...>] [--add-constraint <...>] [--add-exclusion <...>]：修订目标/约束",
      route: "tw route --task <n> --route spec|e2e --decision run|skip [--basis <依据>]：SPEC/E2E 显式路由",
      gate: "tw gate --task <n>：只读门禁检查（blockers + 修复建议）",
      models: "tw models：tier→模型映射解析结果（来源 explicit/agent-default/fallback/default）",
      init: "tw init [--force]：可选——装载 skill 到 .dsh/skills/ 并确保映射模板",
      restore: "tw restore --task <n> --path <路径>：从最后注册快照恢复产出物",
      archive: "tw archive --task <n>：归档（用户确认后；归档目录只读）",
      deliver: "成员交卷：tw deliver --task <n> --key <k> --outcome delivered --summary <一句话> --paths <路径...> [--checks <JSON>] [--unresolved <JSON>]",
      review: "成员阅卷：tw review --task <n> --key <k> --recommendation accept|rework|escalate --summary <一句话> [--findings <JSON>] [--verdict <JSON>]",
    },
    notes: [
      "卡片即接口：按返回卡片行动，不预判步骤；拒绝输出自带修复指引",
      "映射文件 .team-work/platform/dsh.json（缺失自动生成三档 agent-default 占位）；tier→模型在派发点生效",
    ],
  }
}

export async function tw(argv, { projectRoot = process.cwd(), stdout = process.stdout } = {}) {
  const [cmd, ...rest] = argv
  const args = {}
  for (let i = 0; i < rest.length; i += 2) args[rest[i].replace(/^--/, "")] = rest[i + 1]
  const flag = (key) => argv.filter((a) => a === `--${key}`).length ? [argv[argv.indexOf(`--${key}`) + 1]] : []
  const common = { projectRoot }
  try {
    switch (cmd) {
      case "open": return await cmdOpen({ ...common, name: args.name, objective: args.objective, entry: args.entry })
      case "run": return await cmdRun({ ...common, name: args.task, writable: collectWritable(argv) })
      case "decide": return await cmdDecide({ ...common, name: args.task, choice: Number(args.choice), note: args.note })
      case "intent": return await cmdIntent({ ...common, name: args.task, objective: args.objective, addConstraint: flag("add-constraint"), addExclusion: flag("add-exclusion") })
      case "route": return await cmdRoute({ ...common, name: args.task, route: args.route, decision: args.decision, basis: args.basis })
      case "restore": return await cmdRestore({ ...common, name: args.task, target: args.path })
      case "gate": return await cmdGate({ ...common, name: args.task })
      case "archive": return await cmdArchive({ ...common, name: args.task })
      case "dispatch-plan": return await cmdDispatchPlan({ ...common, name: args.task, writable: collectWritable(argv), json: argv.includes("--json") })
      case "models": return await cmdModels(common)
      case "init": return await cmdInit({ ...common, force: argv.includes("--force") })
      case "help": return helpCard()
      case "deliver": return await cmdDeliver({ ...common, name: args.task, key: args.key, payload: {
        outcome: args.outcome, summary: args.summary,
        paths: collectList(argv, "paths"),
        checks: parseJsonArg(args.checks, "--checks") ?? [],
        unresolved: parseJsonArg(args.unresolved, "--unresolved") ?? [],
      } })
      case "review": return await cmdReview({ ...common, name: args.task, key: args.key, payload: {
        summary: args.summary, recommendation: args.recommendation,
        findings: parseJsonArg(args.findings, "--findings") ?? [],
        verdict: parseJsonArg(args.verdict, "--verdict"),
      } })
      default:
        throw fail("USAGE", "用法：tw help 查看全部命令（Lead：open/run/dispatch-plan/decide/intent/route/gate/models/init/restore/archive；成员：deliver/review）")
    }
  } catch (error) {
    if (error.card) return error.card
    if (error.code) {
      return { ok: false, code: error.code, message: error.message, ...(error.reasons ? { reasons: error.reasons } : {}), fix: fixHint(error.code) }
    }
    throw error
  }
}

function collectWritable(argv) {
  const out = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--writable") out.push(argv[i + 1])
  }
  return out
}

async function markTreeReadOnly(rootDir) {
  const { chmod, readdir } = await import("node:fs/promises")
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(target)
      await chmod(target, entry.isDirectory() ? 0o555 : 0o444)
    }
  }
  await walk(rootDir)
  await chmod(rootDir, 0o555)
}

export { cmdOpen, cmdRun, cmdDecide, cmdIntent, cmdGate, cmdArchive }
