// cli.mjs — tw CLI：v3 工具契约的参考实现（§4）
// 卡片输出为 JSON（Lead 在 DSH 里用 bash 调用并解析）；拒绝输出带修复指引（P2）。
import { randomBytes, createHash } from "node:crypto"
import { accessSync, constants } from "node:fs"
import { readFile, rm, mkdir, access, lstat, realpath, mkdtemp, readdir } from "node:fs/promises"
import fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { initTask, loadTask, taskExists, taskRoot, archiveRoot, controlRoot, atomicJson, atomicWrite, withOwnerLock, validName, readJson } from "./store.mjs"
import { deriveTask } from "./derive.mjs"
import { gateCheck, artifactsFingerprint, artifactFingerprints, reviewChainFingerprint, humanDecisionFresh } from "./gate.mjs"
import { scenePolicy, projectRounds, inflightBatch, supersededKeys, waveGroups, waveIdOf } from "./waves.mjs"
import { registerDelivery, registerReview } from "./intake.mjs"
import { lockedWorkflowContract, resolveMemberRules, composeMemberRules, resolveLeadRules, createClarityGuidanceReader, requiredClarityText } from "./rules.mjs"
import { TIERS, resolveTiers, computeModelHint, normalizeModelRef, modelRefFromHint, modelRefsEqual } from "./dsh-map.mjs"
import { digestValue } from "./domain/digests.mjs"
import { writableMatch, writablePathsOverlap } from "./domain/writable.mjs"

function collectList(argv, flag) {
  const out = []
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === `--${flag}`) out.push(argv[i + 1])
  return out.flatMap((v) => String(v).split(",")).map((s) => s.trim()).filter(Boolean)
}

// 可重复的文本参数（不按逗号切分）：open 的约束/排除/范围/验收/gap、intent 的同名增补、roles 的 --set。
function collectFlags(argv, flag) {
  const out = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== `--${flag}`) continue
    const value = argv[i + 1]
    if (value !== undefined) out.push(value)
  }
  return out
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
    TASK_EXISTS: "换一个任务名，或用 tw dispatch-plan --task <name>（或 tw-dispatch）继续既有任务",
    TASK_NOT_FOUND: "检查拼写；tw open 创建新任务",
    TASK_NAME_INVALID: "任务名使用小写字母/数字/连字符，≤64 字符",
    OPEN_INPUT_REQUIRED: "open 需要 --name 与 --objective；可选 --entry <stage>",
    DECISION_STALE: "读取最新卡片（tw run 查看；重签经 tw-dispatch / tw dispatch-plan）后按其中的选项序号重新 decide",
    ENTRY_UNKNOWN: "--entry 必须是 workflow 声明的阶段之一",
    DISPATCH_INPUT_REQUIRED: "Owner 波次派发需要 --writable <path>:<kind>（可多次；路径以 / 结尾 = 目录授权，如 docs/:doc）",
    MAP_INVALID: "在 DSH 当前 profile 的插件配置页补齐 team-work-dsh.tiers 的 junior/senior/expert；每档提供非空 provider/model。无宿主终端由调用方通过 TW_DSH_CONFIG 提供配置快照",
    STATE_CORRUPT: "控制文件损坏：任务事实在 reports/journal，可重推导；遗留 dsh.json 不参与读取",
    RETIRE_UNKNOWN_WAVE: "tw run 或 dispatch-plan 的 wait-inflight 卡片输出当前波 waveId；请核对后重试",
    RETIRE_SETTLED_WAVE: "该波已全部交付（已结波），无需作废；要解除未交付在途请核对 waveId（run 卡片列出当前未结波）",
    LOCK_UNAVAILABLE: "任务锁被并发写者占用（成员交付/Lead 推进同时进行）：等几秒原样重试同一命令即可；崩溃进程的锁会被自动回收",
    LOCK_CORRUPT: "任务锁读取异常：崩溃残留的损坏锁会在约 10 秒后自动回收；持续失败且确认无并发写者时，可手动删除任务目录 locks/task.lock",
    INTAKE_UNCONFIRMED: "意图确认未完成：调 tw-dispatch（或 tw dispatch-plan）重签确认卡，decide 确认后再派发",
    INTAKE_FINGERPRINT_STALE: "意图/角色/包模型在确认后发生变化：调 tw-dispatch 重签确认卡后重新 decide",
    INTAKE_ROLES_UNRESOLVED: "角色模型仍有 unresolved：补齐 DSH 当前 profile 的 team-work-dsh.tiers（tw models 查看）后 tw roles --resolve；unresolved 时不能确认开始",
    ROLES_CORRUPT: "agents.json 损坏：tw roles --resolve 重建角色模型（损坏内容无法保留时历史映射丢失，续派按 fresh 重建）",
    ROLES_UNRESOLVED: "角色模型未解析：tw roles 查看 unresolved 清单，补齐 team-work-dsh.tiers 后 tw roles --resolve，或 tw roles --set <role>=<provider>/<model>[@<effort>]",
    PACKAGE_MODEL_UNRESOLVED: "包缺已固化模型：tw plan 为每包给 model（或省略以复用 roles.owner），或先 tw roles --resolve",
    MODEL_REF_INVALID: "ModelRef 只接受 {provider, modelName, effort?, family?}；effort 不设置时省略字段（禁止 \"\" 与 \"none\"）",
    REQUIRES_FRESH_SESSION: "已有会话不可热替换模型：按换模型确认卡选择 保留原会话 / 重开会话 / 回滚 roles",
    PLAN_MODEL_UNRESOLVED: "包级模型解析失败：补齐 team-work-dsh.tiers 后重试，或为包显式给 model",
  })[code] ?? "运行 tw help 查看全部命令与参数"
}

// 呈现注入：Lead 规则通道的代码半边——只决定"在哪个时点读哪个目录、拼哪几段"，
// 文案本身是规则数据 team-work/rules/lead/<时点>/*.md（见 rules.mjs 的 resolveLeadRules）。
// 反吐内容 = 该时点目录下文件正文（按文件名排序）+ 根包明晰必读段（决定点加审阅段，同源提取）。
// 时点判定完全沿用原口径：决定点 = status/stop/transition 为 awaiting-user/blocked；
// 派发 = transition 为 dispatch；进展 = advance/complete/wait-inflight 或 completed/archived/wait-inflight
// 或 run 的 working+next=dispatch；机械回执不命中。
async function presentationText({ kind, projectRoot, readGuidance, review = false }) {
  const rules = await resolveLeadRules({ kind, projectRoot })
  const leadText = rules.map((rule) => rule.text.trim()).filter(Boolean).join("\n\n")
  const clarity = await readGuidance({ review })
  return leadText ? leadText + "\n\n" + clarity : clarity
}

async function attachPresentation(card, readGuidance, stop = null, runProgress = false, projectRoot = null) {
  if (!card || typeof card !== "object" || Array.isArray(card) || card.presentation) return card
  const decision = [card.status, stop, card.transition].some((v) => v === "awaiting-user" || v === "blocked")
  const dispatch = card.transition === "dispatch"
  const progress = ["advance", "complete", "wait-inflight"].includes(card.transition) ||
    [card.status, stop].some((v) => ["completed", "archived", "wait-inflight"].includes(v)) ||
    (runProgress && card.status === "working" && card.next === "dispatch")
  if (!decision && !dispatch && !progress) return card
  const kind = decision ? "decision" : dispatch ? "dispatch" : "progress"
  return { ...card, presentation: await presentationText({ kind, projectRoot, readGuidance, review: decision }) }
}

// 阶段工作摘要（P4：从 reports/artifacts 自有事实推导，给 Lead 现成的人话素材，
// 不让 Lead 翻任务目录）：各包 Owner 交付一句话 + 产出物 + Challenger 评审结论
// + （core 场景）Expert 裁决。多包按包归组（reports 按 at 升序，后写覆盖即最新）。
function stageProgress(task, stageId) {
  const stageReports = task.reports.filter((r) => r.stage === stageId)
  const owners = new Map()
  for (const r of stageReports) {
    if (r.role !== "owner" || r.kind !== "deliver" || r.payload?.outcome === "blocked") continue
    owners.set(r.package ?? "", r)
  }
  const lines = []
  for (const [pkg, r] of owners) {
    const paths = Array.isArray(r.payload?.paths) ? r.payload.paths : []
    lines.push((pkg ? "包「" + pkg + "」" : "本阶段工作") + "：" + String(r.payload?.summary ?? "") + (paths.length ? "（产出：" + paths.join("、") + "）" : ""))
  }
  const challenger = stageReports.filter((r) => r.role === "challenger").at(-1)
  if (challenger?.payload) {
    const findings = Array.isArray(challenger.payload.findings) ? challenger.payload.findings.length : 0
    lines.push("独立评审：" + String(challenger.payload.summary ?? "") + "（结论 " + challenger.payload.recommendation + (findings ? "，提出 " + findings + " 条意见" : "") + "）")
  }
  const expert = stageReports.filter((r) => r.role === "expert").at(-1)
  if (expert?.payload?.verdict) {
    lines.push("技术裁决：" + String(expert.payload.verdict.rationale ?? "") + "（结论 " + expert.payload.verdict.outcome + "）")
  }
  const items = (task.artifacts?.items ?? []).filter((it) => it.stage === stageId)
  if (items.length) lines.push("已登记产出物：" + items.map((it) => it.path).join("、"))
  return lines.join("\n")
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

// 返工/回应语境（v3.2：多包时按 findings.package 过滤，无归属意见对全体可见）
function reworkContext(task, stageId, pkg = null) {
  const stageReports = task.reports.filter((r) => r.stage === stageId)
  const latest = (role) => stageReports.filter((r) => r.role === role).at(-1)
  const challenger = latest('challenger')
  const expert = latest('expert')
  const humanRework = task.decisions.filter((d) => d.choice === 'rework').at(-1)
  const forPkg = (findings) => (findings ?? []).filter((f) => pkg == null || f.package == null || f.package === pkg)
  const sections = []
  if (challenger?.payload?.recommendation === 'rework' || challenger?.payload?.findings?.length) {
    const findings = forPkg(challenger.payload.findings).map((f) => '- [' + f.severity + ']' + (f.package ? '（包 ' + f.package + '）' : '') + ' ' + f.statement).join('\n')
    sections.push('### Challenger 意见（' + challenger.payload.recommendation + '）\n' + challenger.payload.summary + (findings ? '\n' + findings : ''))
  }
  // Expert 裁决面向组合制品（verdict 无 findings 归属），对每个包的回应轮都相关，不过滤；
  // challenger findings 才按包归属过滤（上方 forPkg）。
  if (expert?.payload?.verdict) {
    const v = expert.payload.verdict
    sections.push('### Expert 裁决（' + v.outcome + '）\n' + v.rationale + '\n建议：' + v.recommendedAction)
  }
  if (humanRework) sections.push('### 用户决定：返工\n' + (humanRework.note ?? '用户在人工门要求返工；结合上述意见修订交付。'))
  return sections.length ? '## 本轮返工/回应原因\n\n以下是意见和裁决上下文，不是全部必须修复的清单，返工不代表修法已获授权。分别核对缺陷是否真实、是否妨碍原目标、是否本轮必修、修法是否授权；以现成证据修正或反驳，非阻塞建议与范围外发现沿原分流。范围、必要性或修法授权有实质争议时，先暂停依赖修改，以 blocked 报告 Lead 并保留原有效制品，不先造新设施或耗一轮证明必须扩范围。Lead 应在下一次推进前用普通最终消息请用户确认方向，不为取卡继续派修补波；新增设施或机制替换须用户明确授权。\n\n' + sections.join('\n\n') : ''
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

// 评审/裁决被审制品清单（当前阶段登记产出物按包分组，单包列出当前阶段登记路径；P4：runtime 自有事实推导，排除作废波与 blocked 报告）
function NLART(task, stageId = null) {
  const targetStage = stageId ?? task.reports?.at(-1)?.stage
  const excluded = supersededKeys(task.journal ?? [])
  const validReportIds = new Set(
    (task.reports ?? [])
      .filter((r) => (!targetStage || r.stage === targetStage) && r.role === 'owner' && r.kind === 'deliver' && r.payload?.outcome !== 'blocked' && (!r.dispatchKey || !excluded.has(r.dispatchKey)))
      .map((r) => r.reportId)
  )
  const hasReports = (task.reports ?? []).some((r) => !targetStage || r.stage === targetStage)
  const items = (task.artifacts?.items ?? []).filter((it) => (!targetStage || it.stage === targetStage) && (!hasReports || !it.reportRef || validReportIds.has(it.reportRef)))
  // 路径:kind 条目解析与 parseWritableEntry 同口径（lastIndexOf 冒号，路径可含冒号）；目录条目覆盖其下路径
  const entryPathOf = (w) => { const s = String(w); const sep = s.lastIndexOf(':'); return sep === -1 ? s : s.slice(0, sep) }
  const lines = (task.packages ?? []).map((p) => {
    const paths = items.filter((it) => writableMatch((p.writable ?? []).map((w) => ({ path: entryPathOf(w) })), it.path)).map((it) => it.path)
    return '- 包 ' + p.id + '：' + (paths.join('、') || '（无登记产出物）')
  })
  return lines.length ? '\n' + lines.join('\n') : '（当前阶段登记产出物：' + (items.map((it) => it.path).join('、') || '无') + '）'
}

// 按 journal report-accepted seq 第一全序、at 次级破平、ver 再破平比较报告新旧（与 gate.mjs:40-52 同口径，防时钟回拨或同毫秒失序）
function reportOrderComparator(journal = []) {
  const seqOf = new Map()
  for (const e of journal) {
    if (e.type === 'report-accepted' && e.detail?.reportId) seqOf.set(e.detail.reportId, e.seq ?? -1)
  }
  return (a, b) => {
    const sa = seqOf.get(a.reportId) ?? -1
    const sb = seqOf.get(b.reportId) ?? -1
    if (sa !== sb) return sa > sb
    if ((a.at ?? '') !== (b.at ?? '')) return (a.at ?? '') > (b.at ?? '')
    return (a.ver ?? 1) > (b.ver ?? 1)
  }
}

// 评审/裁决上下文（P4：把本阶段已交付 Owner 摘要与 Challenger 评审结论内嵌到 review/verdict 派单，
// 避免单包 Challenger 缺被审路径或 Expert 因看不到 Challenger 结论而向 Lead 反问分歧）
function reviewVerdictContext(task, stageId, wave) {
  if (wave.kind !== 'review' && wave.kind !== 'verdict') return ''
  const excluded = supersededKeys(task.journal ?? [])
  const later = reportOrderComparator(task.journal ?? [])
  const activePkgSet = Array.isArray(task.packages) && task.packages.length ? new Set(task.packages.map((p) => p.id)) : null
  const stageReports = (task.reports ?? []).filter((r) => r.stage === stageId && (!r.dispatchKey || !excluded.has(r.dispatchKey)))
  const owners = new Map()
  for (const r of stageReports) {
    if (r.role !== 'owner' || r.kind !== 'deliver' || r.payload?.outcome === 'blocked') continue
    if (activePkgSet && !activePkgSet.has(r.package)) continue
    const key = r.package ?? ''
    const prev = owners.get(key)
    if (!prev || later(r, prev)) owners.set(key, r)
  }
  const ownerLines = []
  for (const [pkg, r] of owners) {
    const paths = Array.isArray(r.payload?.paths) ? r.payload.paths : []
    ownerLines.push('- ' + (pkg ? '包「' + pkg + '」' : '本阶段交付') + '：' + String(r.payload?.summary ?? '') + (paths.length ? '（产出：' + paths.join('、') + '）' : ''))
  }
  const sections = []
  if (wave.scope !== 'consolidation') {
    sections.push('被审制品清单：' + NLART(task, stageId))
  }
  if (ownerLines.length) {
    sections.push('### 本阶段 Owner 交付摘要\n' + ownerLines.join('\n'))
  }
  if (wave.kind === 'verdict') {
    let challenger = null
    for (const r of stageReports) {
      if (r.role !== 'challenger' || r.kind !== 'review') continue
      if (!challenger || later(r, challenger)) challenger = r
    }
    if (challenger?.payload) {
      const rec = challenger.payload.recommendation
      const findings = (challenger.payload.findings ?? []).map((f) => '- [' + f.severity + ']' + (f.package ? '（包 ' + f.package + '）' : '') + ' ' + f.statement).join('\n')
      const emptyNote = rec === 'accept'
        ? '\n（无结构化 findings 条目；Challenger 已接受本轮交付，无待裁决分歧）'
        : '\n（无结构化 findings 条目，详见上方评审摘要）'
      sections.push(
        '### Challenger 评审结论（' + rec + '）\n' +
        String(challenger.payload.summary ?? '') +
        (findings ? '\n' + findings : emptyNote)
      )
    }
  }
  return sections.length ? '## 本轮被审交付与前序评审上下文\n\n' + sections.join('\n\n') : ''
}

function parseWritableEntry(entry) {
  const sep = entry.lastIndexOf(':')
  return { path: entry.slice(0, sep), artifactKind: entry.slice(sep + 1) }
}

// 续派回溯（F4）：沿 journal 倒序找同角色同包范围内最近一个有映射的派发 key——
// send_message 续派不登记新 key，映射链必然间断，只看紧邻 key 必断链；
// 遇 stage-advanced 事件停止（不跨阶段串线）；跳过 superseded 波的 key（F3 排除面）。
// D3（评审 B-F3 限定放宽）：无包波（challenger/expert 的 review/verdict，package=null）按"同角色"匹配上一派发；
// 包波必须同包同角色——全局放宽会让包2 respond 误继承包1 的 agent、续错会话。
// 消费方：dispatch-plan 的 waves 导出（expectedAgentId）与 wait-inflight 兜底重建（§7.3）共用。
function continuationPrevKey({ journal, agentMaps, excludedKeys }, d) {
  // 会话重置边界（§3.6）：最近一次同 role+package 的 session-reset seq 之前的映射一律忽略——
  // 选"作废当前波、重开会话"后，更早已结波映射不得把续派拉回旧会话（否则新模型永远用不上）。
  const resetSeq = latestSessionResetSeq(journal, d)
  for (let i = journal.length - 1; i >= 0; i -= 1) {
    const e = journal[i]
    if (e.type === 'stage-advanced') break
    if (resetSeq >= 0 && (e.seq ?? -1) <= resetSeq) break
    if (e.type !== 'dispatched') continue
    const detail = e.detail
    if (detail.key === d.key) continue
    if (detail.role !== d.role) continue
    if (excludedKeys.has(detail.key)) continue
    if ((d.package ?? null) !== null && (detail.package ?? null) !== d.package) continue
    if (agentMaps[detail.key]) return detail.key
  }
  return null
}

// 最近一次会话重置事件的 seq（同角色；包波同包，无包波匹配 package=null 的重置）。
function latestSessionResetSeq(journal, d) {
  let seq = -1
  for (const e of journal) {
    if (e.type !== 'session-reset') continue
    if (e.detail?.role !== d.role) continue
    if ((e.detail?.package ?? null) !== (d.package ?? null)) continue
    const current = e.seq ?? -1
    if (current > seq) seq = current
  }
  return seq
}

// 成员规则解析（规则库 team-work/rules，见 rules.mjs）：按 role×teamScene 合成卡片三段文本。
// 只在该波真正派发或在途重建时调用，同一批次的同角色只解析一次；三段全空返回空字符串（卡上整段省略）。
// teamScenes 直接取自已加载的工作流定义（避免重复读盘，也避免集合缺失时的警告噪声）。
// 规则是增强不是门禁：读取失败由 rules.mjs 按"该层没有条目"降级，不阻塞派发。
async function memberRulesText({ projectRoot, workflow, teamScene, roles }) {
  const teamScenes = (workflow?.stages ?? [])
    .map((stage) => stage?.teamScene)
    .filter((scene) => typeof scene === "string" && scene)
  const texts = new Map()
  for (const role of new Set(roles)) {
    texts.set(role, composeMemberRules(await resolveMemberRules({ role, teamScene: teamScene ?? null, projectRoot, teamScenes })))
  }
  return texts
}

// 在途派单重建（F3/F4）：当前未结波中尚无 report 的派发，重建完整派单文本（统一走 waves.inflightBatch）。
// §7.3 兜底三字段（dispatch 自身崩溃窗口的恢复事实，由 runtime 锁内投影——绑定层不直读账本）。
// 调用方约束：必须在任务锁内调用（registered 查 agents.json 与 journal 读取要求同一临界区）。
// - modelRef：journal dispatched 快照回填（历史 modelHint 读取时映射）；无快照时按文件 roles/packages 取值；
//   仍不可解析置 modelRefUnresolved（消费方不得据此创建，指 tw retire --wave 回收）；
// - expectedAgentId：仅续派条目——continuationPrevKey 回溯老 key 查 mappings；
// - promptFull：仅续派条目——全量 prompt 变体（C②：断链 fresh 重建/空壳补发用，绑定层只选用不拼装）；
// - registered：锁内查 mappings 该 key 有无对应代理（tw-dispatch 判定链的判定事实；
//   agents.json 缺失/损坏时字段降级为缺失，消费方透传不补派）。
// 规则（memberRules）按每个在途条目的 role 重建同文本，与首派卡一致；只在本次真正重建时读盘。
async function inflightDispatches(projectRoot, task, stageId) {
  const stageDef = task.workflow.stages.find((st) => st.id === stageId)
  const inflight = inflightBatch({ journal: task.journal, reports: task.reports })
  if (!inflight) return []
  const memberRules = await memberRulesText({
    projectRoot,
    workflow: task.workflow,
    teamScene: stageDef?.teamScene,
    roles: inflight.open.map((d) => d.role),
  })
  // agents.json 缺失 = 零登记事实（registered=false，补派安全）；损坏 = 判定事实不可得（registered
  // 字段降级为缺失，tw-dispatch 透传不补派——宁透传不误派）。
  const registry = await readRegistry(task)
  const mappings = registry.mappings
  const registryCorrupt = registry.corrupt
  const roles = normalizeRoleEntries(registry.roles).roles
  const excludedKeys = supersededKeys(task.journal)
  return inflight.open.map((d) => {
    // 模型投影：journal 已记录的 ModelRef（历史 modelHint 读取时映射）→ 文件里的 pkg.model ?? roles[role]；
    // 仍不可解析置 modelRefUnresolved（消费方不得据此创建，指 tw retire --wave 回收）。
    let modelRef = refFromDispatchDetail(d)
    let modelSource = modelRef ? (d.modelRef ? d.modelSource ?? "roles" : "legacy-journal") : null
    if (!modelRef) {
      const fallback = modelRefForDispatch(task, roles, d.role, d.package ?? null)
      if (!fallback.error) { modelRef = fallback.modelRef; modelSource = fallback.source }
    }
    const card = dispatchCard({ ...task, policy: task.policy }, stageDef, { kind: d.kind, role: d.role, round: d.round, ...(d.scope ? { scope: d.scope } : {}) }, { key: d.key, package: d.package ?? null, round: d.round, continuation: d.continuation, writable: d.writable ?? [], waveId: d.waveId ?? null }, memberRules.get(d.role) ?? "", modelRef ? { modelRef, source: modelSource } : null).dispatch
    const prevKey = d.continuation ? continuationPrevKey({ journal: task.journal, agentMaps: mappings, excludedKeys }, d) : null
    return {
      ...card,
      dispatchKey: card.key,  // D4：输出层补 dispatchKey（与 dispatch-plan waves[] 字段统一；key 字段保留兼容）
      ...(modelRef ? { modelRef, modelSource } : {}),
      ...(modelRef ? {} : { modelRefUnresolved: true }),
      ...(d.continuation && prevKey && mappings[prevKey] ? { expectedAgentId: mappings[prevKey] } : {}),
      // mappedAgentId：该 key 已登记的 childId 值（判定链四态用：registered=true ≠ 子代理存在，
      // 消费方按四态处置——活→等待/冷归属一致→冷唤醒/异主→接管冲突/无记录→同 id 重建；机器防双发的事实源，P4 投影）
      ...(registryCorrupt ? {} : mappings[card.key] ? { mappedAgentId: mappings[card.key] } : {}),
      ...(registryCorrupt ? {} : { registered: Boolean(mappings[card.key]) }),
      ...(registryCorrupt ? { registeredUnresolved: registryCorrupt } : {}),
    }
  })
}

// ── 档位、ModelRef 与任务角色/包级模型（方案 §3；派发期零配置反查）──────────────────
// roles 在 open 一次性解析并写入 agents.json，tw roles 显式更新；packages[].model 在 plan 物化；
// 派发只读 pkg.model ?? roles[role]，不再在派发期解析 tier 配置。档位只用于初始化与展示溯源。
const TIER_RANK = { junior: 1, senior: 2, expert: 3 }
const ROLE_KEYS = ["owner", "challenger", "expert"]
const INTAKE_GATE = "intake-approval"

function ownerTierWithRisk(task, sp) {
  const base = sp.ownerTier
  const up = task?.policy?.riskTiers?.[task?.intent?.risk]
  if (!base) return up ?? null // 场景与 roles 都缺时，riskTiers 仍是显式配置；否则保持 null（unresolved）
  return up && (TIER_RANK[up] ?? 0) > (TIER_RANK[base] ?? 0) ? up : base
}

// 展示与权重用的角色档位（不再读包 tier；包级只存具体 ModelRef）。缺配置时明确 unresolved，
// 不再用 junior/expert 字面量掩盖配置缺口。
function roleTierFor(task, sp, role) {
  if (role === "owner") return ownerTierWithRisk(task, sp) ?? "unresolved"
  if (role === "challenger") return sp.challengerTier ?? "unresolved"
  return sp.expertTier ?? "unresolved"
}

// 档位溯源只报真实来源（E3）：场景、roles 兜底、risk 覆盖逐项记录；缺配置如实标 unresolved，
// 不得伪报 "policy.roles.owner=..."。角色模型来源是 journal roles-initialized/modelRef，不在此。
function tierProvenanceOf(task, policy, stageDef, role) {
  const sceneId = stageDef?.teamScene ?? "implementation"
  const scene = policy?.scenes?.[sceneId] ?? {}
  const risk = task?.intent?.risk
  const up = policy?.riskTiers?.[risk]
  const field = role === "owner" ? "ownerTier" : role === "challenger" ? "challengerTier" : null
  const sceneTier = field ? scene[field] ?? null : null
  const roleTier = role === "owner" ? policy?.roles?.owner ?? null : role === "challenger" ? policy?.roles?.challenger ?? null : policy?.roles?.expert ?? null
  const base = sceneTier ?? roleTier
  const parts = []
  if (sceneTier) parts.push("scene." + sceneId + "." + field + "=" + sceneTier)
  else if (roleTier) parts.push("policy.roles." + role + "=" + roleTier)
  if (role === "owner" && up && base && (TIER_RANK[up] ?? 0) > (TIER_RANK[base] ?? 0)) parts.push("policy.riskTiers." + risk + "=" + up)
  else if (role === "owner" && up && !base) parts.push("policy.riskTiers." + risk + "=" + up)
  if (!parts.length) {
    return field
      ? "unresolved：scene." + sceneId + "." + field + " 与 policy.roles." + role + " 均缺失"
      : "unresolved：policy.roles." + role + " 缺失"
  }
  return parts.join(" + ")
}

function canonicalModelRef(ref) {
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) return null
  if (typeof ref.provider !== "string" || !ref.provider.trim() || typeof ref.modelName !== "string" || !ref.modelName.trim()) return null
  return {
    provider: ref.provider,
    modelName: ref.modelName,
    ...(ref.effort !== undefined ? { effort: ref.effort } : {}),
    ...(ref.family !== undefined ? { family: ref.family } : {}),
  }
}

function describeModelRef(ref) {
  if (!ref) return "（unresolved）"
  return ref.provider + "/" + ref.modelName + "（推理强度 " + (ref.effort ?? "省略") + "）"
}

// agents.json 只保留 mappings + roles：读取时区分"缺失/损坏"（损坏 → ROLES_CORRUPT 恢复边）。
async function readRegistry(task) {
  try {
    const agents = (await readJson(path.join(task.root, "agents.json"), { allowMissing: true })) ?? {}
    return {
      mappings: agents.mappings && typeof agents.mappings === "object" && !Array.isArray(agents.mappings) ? agents.mappings : {},
      roles: agents.roles ?? null,
      agents,
      corrupt: null,
    }
  } catch (error) {
    return { mappings: {}, roles: null, agents: null, corrupt: String(error?.message ?? error) }
  }
}

async function updateAgents(task, mutate) {
  const file = path.join(task.root, "agents.json")
  let current = null
  let rebuilt = null
  try {
    current = (await readJson(file, { allowMissing: true })) ?? {}
  } catch (error) {
    rebuilt = String(error?.message ?? error)
    current = {}
  }
  const next = { ...current, mappings: { ...(current.mappings ?? {}) } }
  await mutate(next)
  await atomicJson(file, next)
  return { agents: next, rebuilt }
}

function normalizeRoleEntries(raw) {
  const roles = {}
  const invalid = []
  if (raw === null || raw === undefined) return { roles, invalid, present: false }
  if (typeof raw !== "object" || Array.isArray(raw)) return { roles, invalid: [{ role: null, reason: "roles 不是对象" }], present: true }
  for (const key of Object.keys(raw)) {
    if (!ROLE_KEYS.includes(key)) {
      invalid.push({ role: key, reason: "未知角色键（只允许 owner/challenger/expert）" })
      continue
    }
    try {
      roles[key] = normalizeModelRef(raw[key], "roles." + key)
    } catch (error) {
      invalid.push({ role: key, reason: String(error?.message ?? error) })
    }
  }
  return { roles, invalid, present: true }
}

// 按当前调用快照把三个角色解析成 ModelRef（open 初始化 / tw roles --resolve 共用）。
// 缺档或候选池空 → 该角色 unresolved（不猜默认值），不阻塞 open。
async function resolveRoleModels({ task, workflow, policy }) {
  const resolved = await resolveTiers()
  const state = deriveTask(task)
  const stageDef = workflow.stages.find((s) => s.id === state.stage)
  const sp = scenePolicy(policy, stageDef?.teamScene ?? "implementation")
  // 家族去重只在同一档位内有效：不同角色若落在同一档，才需要错开家族。
  const usedFamiliesByTier = new Map()
  const details = []
  const roles = {}
  for (const role of ROLE_KEYS) {
    const tier = role === "expert" ? sp.expertTier : role === "owner" ? ownerTierWithRisk(task, sp) : sp.challengerTier
    const tierProvenance = tierProvenanceOf(task, policy, stageDef, role)
    let modelRef = null
    let reason = null
    if (!tier) reason = "角色 " + role + " 的档位未配置（scene." + (stageDef?.teamScene ?? "implementation") + " 与 policy.roles." + role + " 均缺失，unresolved）"
    else if (!resolved.tiers[tier]?.pool?.length) reason = "档位 " + tier + " 在当前调用快照未解析（unresolved）"
    else {
      const usedFamilies = usedFamiliesByTier.get(tier) ?? []
      const hint = computeModelHint(resolved.tiers[tier], usedFamilies)
      if (!hint) reason = "档位 " + tier + " 候选池为空"
      else {
        try {
          modelRef = modelRefFromHint(hint)
          if (modelRef?.family) usedFamiliesByTier.set(tier, [...usedFamilies, modelRef.family])
        } catch (error) {
          reason = String(error?.message ?? error)
        }
      }
    }
    if (modelRef) roles[role] = modelRef
    details.push({ role, tier: tier ?? null, tierProvenance, modelRef, effortState: modelRef ? (modelRef.effort ? "configured" : "omitted") : "unresolved", resolution: modelRef ? "resolved" : "unresolved", ...(reason ? { reason } : {}) })
  }
  return { roles, details, warnings: resolved.warnings, profile: resolved.profile, entryId: resolved.entryId, source: resolved.source }
}

function refFromDispatchDetail(detail) {
  if (!detail) return null
  if (detail.modelRef) {
    try { return normalizeModelRef(detail.modelRef) } catch { return null }
  }
  // 兼容历史 journal：modelHint{provider,model,effort,family} → ModelRef（不重写历史行）。
  try { return modelRefFromHint(detail.modelHint) } catch { return null }
}

function lastDispatchedModelRef(task, role) {
  for (let i = task.journal.length - 1; i >= 0; i -= 1) {
    const event = task.journal[i]
    if (event.type !== "dispatched" || event.detail?.role !== role) continue
    const ref = refFromDispatchDetail(event.detail)
    if (ref) return ref
  }
  return null
}

// 同角色同包最近一条派发模型：会话起始映射缺失时的保守降级（比全任务最早更接近当前会话，
// 但仍不用于替代 sessionFirstModelRef 的正常路径）。
function lastDispatchModelRefFor(task, role, pkg = null) {
  for (let i = task.journal.length - 1; i >= 0; i -= 1) {
    const event = task.journal[i]
    if (event.type !== "dispatched" || event.detail?.role !== role) continue
    if ((event.detail.package ?? null) !== (pkg ?? null)) continue
    const ref = refFromDispatchDetail(event.detail)
    if (ref) return ref
  }
  return null
}

// 全任务最早一条同角色同包派发模型：仅作旧任务/无映射数据的降级基准（不用于新会话比较）。
function firstDispatchModelRef(task, role, pkg = null) {
  for (const event of task.journal) {
    if (event.type !== "dispatched" || event.detail?.role !== role) continue
    if ((event.detail.package ?? null) !== (pkg ?? null)) continue
    const ref = refFromDispatchDetail(event.detail)
    if (ref) return ref
  }
  return null
}

// 当前阶段与最近一次同角色同包 session-reset 之后的边界 seq（纯函数）：
// 会话首派模型必须以"当前会话 + 当前阶段"为范围，不能拿重置前/上一阶段的旧会话比较。
function sessionBoundarySeq(task, role, pkg = null) {
  let boundary = -1
  for (const event of task.journal) {
    if (event.type === "stage-advanced") boundary = Math.max(boundary, event.seq ?? -1)
    else if (event.type === "session-reset" && event.detail?.role === role && (event.detail.package ?? null) === (pkg ?? null)) boundary = Math.max(boundary, event.seq ?? -1)
  }
  return boundary
}

// 当前会话首派模型：边界之后、映射到该 sessionId 的最早一条派发模型（E1 修复）。
// mismatchedMappings / 旧任务缺起始 key 映射时，由调用方回退 firstDispatchModelRef 降级，不在这里猜。
function sessionFirstModelRef(task, mappings, role, pkg, sessionId) {
  if (!sessionId || !mappings) return null
  const boundary = sessionBoundarySeq(task, role, pkg)
  for (const event of task.journal) {
    if (event.type !== "dispatched" || event.detail?.role !== role) continue
    if ((event.seq ?? -1) <= boundary) continue
    if ((event.detail.package ?? null) !== (pkg ?? null)) continue
    if (mappings[event.detail.key] !== sessionId) continue
    const ref = refFromDispatchDetail(event.detail)
    if (ref) return ref
  }
  return null
}

function latestSessionForRole(task, mappings, role) {
  for (let i = task.journal.length - 1; i >= 0; i -= 1) {
    const event = task.journal[i]
    if (event.type !== "dispatched" || event.detail?.role !== role) continue
    const mapped = mappings?.[event.detail.key]
    if (typeof mapped === "string" && mapped) return { key: event.detail.key, sessionId: mapped, package: event.detail.package ?? null }
  }
  return null
}

// 角色溯源（journal roles-initialized / role-models-changed 只增事实）：卡面与 tw roles 共用。
function roleMeta(task) {
  const meta = new Map()
  for (const event of task.journal) {
    if (event.type === "roles-initialized") {
      meta.clear()
      for (const entry of event.detail?.roles ?? []) meta.set(entry.role, { ...entry })
    } else if (event.type === "role-models-changed") {
      for (const change of event.detail?.changes ?? []) {
        const prev = meta.get(change.role) ?? { role: change.role }
        const to = change.to ?? null
        meta.set(change.role, { ...prev, ...change, modelRef: to, effortState: to ? (to.effort ? "configured" : "omitted") : "unresolved", resolution: to ? "resolved" : "unresolved" })
      }
    }
  }
  return meta
}

function profileOf(task) {
  return task.journal.filter((e) => e.type === "roles-initialized").at(-1)?.detail?.profile ?? "unresolved"
}

function roleDetailsForCard(task, roles, invalid = []) {
  const meta = roleMeta(task)
  return ROLE_KEYS.map((role) => {
    const previous = meta.get(role) ?? {}
    const modelRef = roles?.[role] ?? null
    return {
      role,
      modelRef,
      effortState: modelRef ? (modelRef.effort ? "configured" : "omitted") : "unresolved",
      tier: previous.tier ?? null,
      tierProvenance: previous.tierProvenance ?? null,
      ...(modelRef ? {} : { reason: invalid.find((i) => i.role === role)?.reason ?? previous.reason ?? "未解析（缺配置或未初始化）" }),
    }
  })
}

// ── 意图确认门（§3.4）：复用 decisions/journal，不新增存储 ─────────────────────────
// 稳定配置投影：只取 {intent, roles, packages}，不含指纹自身、时间戳、decisionId、profile 等运行元数据。
function intakeSnapshot({ task, roles, packages }) {
  const intent = task.intent ?? {}
  const scope = intent.scope && typeof intent.scope === "object" && !Array.isArray(intent.scope) ? intent.scope : {}
  return {
    intent: {
      objective: String(intent.objective ?? ""),
      constraints: Array.isArray(intent.constraints) ? intent.constraints.map(String) : [],
      exclusions: Array.isArray(intent.exclusions) ? intent.exclusions.map(String) : [],
      rawRequirement: String(intent.rawRequirement ?? ""),
      scope,
      acceptance: Array.isArray(intent.acceptance) ? intent.acceptance.map(String) : [],
      gaps: Array.isArray(intent.gaps) ? intent.gaps.map((gap) => ({ ...gap })) : [],
      risk: String(intent.risk ?? "normal"),
    },
    roles: Object.fromEntries(ROLE_KEYS.map((role) => [role, canonicalModelRef(roles?.[role])])),
    packages: (Array.isArray(packages) ? packages : []).map((p) => ({
      id: p.id,
      model: canonicalModelRef(p.model),
      writable: Array.isArray(p.writable) ? p.writable.map(String) : [],
      done: Array.isArray(p.done) ? p.done.map(String) : [],
      dependsOn: Array.isArray(p.dependsOn) ? p.dependsOn.map(String) : [],
    })),
  }
}

function intakeConfirmation(task) {
  return (task.decisions ?? []).filter((d) => d.gateId === INTAKE_GATE && d.grant === "accept-intake").at(-1) ?? null
}

async function intakeState(task) {
  const registry = await readRegistry(task)
  const normalized = normalizeRoleEntries(registry.roles)
  const snapshot = intakeSnapshot({ task, roles: normalized.roles, packages: task.packages })
  return { registry, roles: normalized.roles, invalid: normalized.invalid, snapshot, fingerprint: digestValue(snapshot) }
}

// 确认卡正文：固定段序（原始需求 → 目标 → 约束/排除 → 范围/产出 → 角色模型 3 行 → 逐包模型 → gap → 选项）。
function intakeCardText({ task, workflow, snapshot, details, choices = [] }) {
  const lines = []
  lines.push("# 任务意图确认（intake-approval）", "")
  lines.push("## 你的原始需求（不摘要、不删改）")
  lines.push(snapshot.intent.rawRequirement || "（未提供原始需求全文；可用 tw intent --task <n> --raw-requirement <原文> 补充）", "")
  lines.push("## 目标 / 约束 / 排除")
  lines.push("目标：" + (snapshot.intent.objective || "（未提供）"))
  if (snapshot.intent.constraints.length) lines.push("约束：", ...snapshot.intent.constraints.map((c) => "- " + c))
  else lines.push("约束：（未提供）")
  if (snapshot.intent.exclusions.length) lines.push("排除：", ...snapshot.intent.exclusions.map((c) => "- " + c))
  else lines.push("排除：（未提供）")
  lines.push("", "## 范围与产出")
  const entryStage = workflow?.stages?.find((stage) => stage.id === task.scope?.entry)
  lines.push("入口阶段：" + String(task.scope?.entry ?? "未提供") + (task.scope?.completion?.mode === "through-stage" ? "（运行到该阶段验收）" : "（运行完整工作流）"))
  lines.push("预期产出物：" + ((entryStage?.outputs ?? []).map(String).join("、") || "（入口阶段无声明产出物）"))
  const scopeNotes = Array.isArray(snapshot.intent.scope?.notes) ? snapshot.intent.scope.notes.map(String) : []
  if (scopeNotes.length) lines.push("范围补充：", ...scopeNotes.map((note) => "- " + note))
  if (snapshot.intent.acceptance.length) lines.push("验收：", ...snapshot.intent.acceptance.map((c) => "- " + c))
  lines.push("", "## 角色模型（3 行，恒定显示）")
  lines.push("| 角色 | provider | modelName | 推理强度 | 档位溯源 |", "| --- | --- | --- | --- | --- |")
  for (const detail of details) {
    lines.push("| " + detail.role + " | " + (detail.modelRef?.provider ?? "（unresolved）") + " | " + (detail.modelRef?.modelName ?? "—") + " | " + (detail.modelRef ? (detail.modelRef.effort ?? "省略（不设置）") : "—") + " | " + (detail.tierProvenance ?? "未记录") + " |")
  }
  const unresolved = details.filter((detail) => !detail.modelRef)
  if (unresolved.length) lines.push("", "未解析角色：" + unresolved.map((detail) => detail.role + "（" + (detail.reason ?? "未解析") + "）").join("；"))
  lines.push("", "## 已拆包的实际模型")
  if (!snapshot.packages.length) lines.push("（未拆包；拆包后本卡会重签并列出逐包模型）")
  else {
    lines.push("| 包 | provider | modelName | 推理强度 | 与 roles.owner |", "| --- | --- | --- | --- | --- |")
    for (const pkg of snapshot.packages) {
      const same = pkg.model && snapshot.roles.owner ? modelRefsEqual(pkg.model, snapshot.roles.owner) : null
      lines.push("| " + pkg.id + " | " + (pkg.model?.provider ?? "（unresolved）") + " | " + (pkg.model?.modelName ?? "—") + " | " + (pkg.model ? (pkg.model.effort ?? "省略（不设置）") : "—") + " | " + (same === null ? "无法比较" : same ? "等于" : "不同") + " |")
    }
  }
  lines.push("", "## 仍未明确的问题（gap）")
  if (!snapshot.intent.gaps.length) lines.push("（无：目标、约束、排除、范围与验收均可指回原始需求）")
  else snapshot.intent.gaps.forEach((gap, index) => {
    lines.push((index + 1) + ". " + String(gap.question ?? "（未填写问题）") + " —— 影响：" + String(gap.whyItMatters ?? "未说明") + "；若确认开始将按“" + String(gap.proposedDefault ?? "无默认假设（需用户补充）") + "”执行" + (gap.answer ? "（已答复：" + String(gap.answer) + "）" : ""))
  })
  lines.push("")
  lines.push(unresolved.length ? "（角色模型 unresolved：本卡不提供“确认开始”；修复配置后 tw roles --resolve 重签）" : "（若计划拆包，建议先 tw plan 再确认；拆包会触发一次重签并列出逐包模型）")
  if (choices.length) {
    lines.push("", "## 选项")
    for (const choice of choices) lines.push(choice.n + ". " + choice.label + (choice.desc ? "——" + choice.desc : ""))
  }
  return lines.join("\n")
}

async function signIntakeApproval({ task, workflow, roles, details, profile, source }) {
  const snapshot = intakeSnapshot({ task, roles, packages: task.packages })
  const fingerprint = digestValue(snapshot)
  const pending = pendingDecisionDetail(task.journal)
  const events = []
  // 同一时刻只允许一张未决卡：若正在等待的是换模型卡，配置已变化也该作废它，避免下次 decide
  // 展示 intake 选项却实际答到旧 fresh 卡的 keep-session（E2）。
  if (pending && (pending.gateId === INTAKE_GATE || pending.requiresFreshSession)) {
    events.push({ type: "decided", detail: { decisionId: pending.decisionId, choice: "superseded", reason: "意图、角色模型或包模型已变化，按新配置重签确认卡" } })
  }
  const unresolved = details.filter((detail) => !detail.modelRef)
  const choices = []
  let number = 0
  if (!unresolved.length) choices.push({ n: ++number, label: "确认开始", desc: "按以上意图、角色模型与逐包模型进入执行", grant: "accept-intake" })
  choices.push({ n: ++number, label: "我先修改", desc: "用 tw intent / tw roles / tw plan 修改后重出确认卡", grant: "revise-intake" })
  choices.push({ n: ++number, label: "终止任务", desc: "以当前形态终止并归档", grant: "stop-task" })
  const question = intakeCardText({ task, workflow, snapshot, details, choices })
  const decisionId = "intake-" + randomBytes(3).toString("hex")
  const intake = {
    rawRequirement: snapshot.intent.rawRequirement,
    objective: snapshot.intent.objective,
    constraints: snapshot.intent.constraints,
    exclusions: snapshot.intent.exclusions,
    scope: snapshot.intent.scope,
    acceptance: snapshot.intent.acceptance,
    gaps: snapshot.intent.gaps,
    roles: details.map((detail) => ({ role: detail.role, modelRef: detail.modelRef, effortState: detail.effortState, tierProvenance: detail.tierProvenance })),
    packages: snapshot.packages.map((pkg) => ({ id: pkg.id, modelRef: pkg.model, vsRolesOwner: pkg.model && snapshot.roles.owner ? (modelRefsEqual(pkg.model, snapshot.roles.owner) ? "equal" : "different") : null })),
    profile: profile ?? "unresolved",
    source: source ?? "unresolved",
  }
  events.push({ type: "decision-issued", detail: { decisionId, gateId: INTAKE_GATE, reason: question, choices, intakeFingerprint: fingerprint, intake } })
  await appendEventsUnlocked(task, events)
  return { decisionId, question, choices, intakeFingerprint: fingerprint, intake, ...(unresolved.length ? { code: "INTAKE_ROLES_UNRESOLVED", unresolved: unresolved.map((detail) => detail.role) } : {}) }
}

// 派发前的确认门：只在"本任务签发过确认卡"时生效（旧任务不补卡、不静止，§3.4.5）。
// 已确认指纹与当前稳定投影不一致（意图/roles/packages 变化）→ 作废旧卡并重签，停止派发。
async function intakeGateCard({ task, workflow, state }) {
  const issued = task.journal.some((event) => event.type === "decision-issued" && event.detail?.gateId === INTAKE_GATE)
  if (!issued) return null
  const stateInfo = await intakeState(task)
  const accepted = intakeConfirmation(task)
  if (accepted && accepted.intakeFingerprint === stateInfo.fingerprint) return null
  const details = roleDetailsForCard(task, stateInfo.roles, stateInfo.invalid)
  const card = await signIntakeApproval({ task, workflow, roles: stateInfo.roles, details, profile: profileOf(task), source: "role-registry" })
  return {
    ok: true,
    task: task.name,
    stage: state.stage,
    status: "awaiting-user",
    next: "decide",
    transition: "await-decision",
    ...card,
    // 恢复边错误码：无匹配确认 vs 确认后配置变化；roles unresolved 时保留 INTAKE_ROLES_UNRESOLVED。
    ...(card.code ? {} : { code: accepted ? "INTAKE_FINGERPRINT_STALE" : "INTAKE_UNCONFIRMED" }),
    note: accepted ? "意图、角色模型或包模型在确认后发生变化：已重签意图确认卡，确认前不派发" : "意图确认尚未完成：确认意图与模型后再派发",
  }
}

// 旧任务迁移：无 roles → 优先取该角色最近一次实际派发模型，无历史才按 policy 解析（"迁移不换模型"）。
async function ensureRolesInitialized({ task, workflow, policy }) {
  const registry = await readRegistry(task)
  const normalized = normalizeRoleEntries(registry.roles)
  const missing = ROLE_KEYS.filter((role) => !normalized.roles[role])
  if (!registry.corrupt && normalized.present && missing.length === 0 && normalized.invalid.length === 0) {
    return { roles: normalized.roles, source: "roles", registry, details: roleDetailsForCard(task, normalized.roles) }
  }
  const resolved = await resolveRoleModels({ task, workflow, policy })
  const roles = {}
  const details = []
  for (const detail of resolved.details) {
    const history = lastDispatchedModelRef(task, detail.role)
    const modelRef = normalized.roles[detail.role] ?? history ?? detail.modelRef ?? null
    if (modelRef) roles[detail.role] = modelRef
    details.push({ ...detail, modelRef, effortState: modelRef ? (modelRef.effort ? "configured" : "omitted") : "unresolved", resolution: modelRef ? "resolved" : "unresolved", ...(history && !normalized.roles[detail.role] ? { migratedFrom: "journal-dispatched" } : {}) })
  }
  const unresolved = ROLE_KEYS.filter((role) => !roles[role])
  const updated = await updateAgents(task, (agents) => { agents.roles = roles })
  await appendEventsUnlocked(task, [{ type: "roles-initialized", detail: { roles: details, source: unresolved.length ? "unresolved" : "migrated", profile: resolved.profile, entryId: resolved.entryId, ...(registry.corrupt ? { registryRebuilt: registry.corrupt } : {}) } }])
  return { roles, details, source: "migrated", unresolved, warnings: resolved.warnings, registry: { ...registry, mappings: updated.agents.mappings, corrupt: null } }
}

// 旧 packages.json 只有 tier：首次 plan/推进时按当前快照物化（不换模型），失败不落半成品。
async function materializePackages({ task }) {
  const packages = Array.isArray(task.packages) ? task.packages : null
  if (!packages || packages.length === 0) return { packages }
  const needs = packages.filter((pkg) => !(pkg?.model && typeof pkg.model.provider === "string" && typeof pkg.model.modelName === "string"))
  if (needs.length === 0) return { packages }
  const registry = await readRegistry(task)
  const roles = normalizeRoleEntries(registry.roles).roles
  const resolved = await resolveTiers()
  const next = []
  const materialized = []
  for (const pkg of packages) {
    if (pkg?.model) {
      // 已有 model 的包不再保留旧 tier 字面量（tier 只作 tw plan 入参语法糖）。
      const { tier: _staleTier, ...rest } = pkg
      next.push({ ...rest, model: normalizeModelRef(pkg.model, "packages." + pkg.id + ".model") })
      continue
    }
    let modelRef = null
    if (pkg?.tier) {
      const hint = computeModelHint(resolved.tiers[pkg.tier], [])
      if (hint) {
        try { modelRef = modelRefFromHint(hint) } catch { modelRef = null }
      }
      if (!modelRef) {
        return { error: { code: "PLAN_MODEL_UNRESOLVED", message: "包 " + pkg.id + " 的旧 tier=" + pkg.tier + " 在当前调用快照无法解析（tier 未配置或候选池为空）", recovery: "补齐 team-work-dsh.tiers 后重试，或用 tw plan 重新登记包级模型（不改模型时可省略 model/tier，复用 roles.owner）" } }
      }
    } else {
      if (!roles.owner) return { error: { code: "PLAN_MODEL_UNRESOLVED", message: "包 " + pkg.id + " 未给 model/tier，且 agents.json.roles.owner 缺失", recovery: "先 tw roles --resolve 初始化角色模型，或 tw plan 为每包显式指定 model" } }
      modelRef = normalizeModelRef(roles.owner)
    }
    const { tier: _legacyTier, ...rest } = pkg
    next.push({ ...rest, model: modelRef })
    materialized.push({ id: pkg.id, modelRef, from: pkg.tier ? "tier" : "roles.owner" })
  }
  await atomicJson(path.join(task.root, "packages.json"), { items: next })
  task.packages = next
  await appendEventsUnlocked(task, [{ type: "packages-model-materialized", detail: { packages: materialized } }])
  return { packages: next, materialized }
}

// 派发取值（§3.8）：包级优先，否则角色级；缺失返回可恢复码，不现场解析配置、不猜。
function modelRefForDispatch(task, roles, role, pkg) {
  if (role === "owner" && pkg != null) {
    const def = (task.packages ?? []).find((entry) => entry.id === pkg)
    if (def?.model) return { modelRef: normalizeModelRef(def.model, "packages." + pkg + ".model"), source: "package" }
  }
  const ref = roles?.[role]
  if (ref) return { modelRef: normalizeModelRef(ref, "roles." + role), source: "roles" }
  return { error: role === "owner" && pkg != null ? "PACKAGE_MODEL_UNRESOLVED" : "ROLES_UNRESOLVED" }
}

// 旧未决升档卡收口（§3.3.3）：升档审批删除后，历史未决 escalation 卡必须幂等追加 decided:superseded，
// 否则任务会落在"已签发未失效"渲染分支永久静止。只增不改，审计保留。
function isLegacyEscalationCard(detail) {
  if (!detail) return false
  if (detail.escalationFingerprint !== undefined) return true
  return (detail.choices ?? []).some((choice) => choice?.grant === "approve-escalation" || /降回默认档/.test(String(choice?.label ?? "")))
}

async function settleLegacyEscalations(task) {
  const settled = new Set(task.journal.filter((event) => event.type === "decided").map((event) => event.detail.decisionId))
  const stale = task.journal.filter((event) => event.type === "decision-issued" && event.detail && !settled.has(event.detail.decisionId) && isLegacyEscalationCard(event.detail))
  if (!stale.length) return 0
  await appendEventsUnlocked(task, stale.map((event) => ({ type: "decided", detail: { decisionId: event.detail.decisionId, choice: "superseded", reason: "升档审批机制已删除" } })))
  return stale.length
}

// 换模型卡的当前指纹（E2）：按当前 roles/packages 与当前会话首派模型重算，供 decide/run/推进校验
// "展示的卡仍是当前配置对应的那张卡"；配置变了旧卡必须 superseded 重签，不能答成 keep-session。
async function currentFreshFingerprint(task, detail) {
  if (!detail || typeof detail !== "object") return { error: "REQUIRES_FRESH_SESSION" }
  const registry = await readRegistry(task)
  const roles = normalizeRoleEntries(registry.roles).roles
  const model = modelRefForDispatch(task, roles, detail.role, detail.package ?? null)
  if (model.error) return { error: model.error }
  const from = sessionFirstModelRef(task, registry.mappings, detail.role, detail.package ?? null, detail.sessionId)
    ?? (detail.fromModelRef ? canonicalModelRef(detail.fromModelRef) : null)
  if (!from) return { error: "REQUIRES_FRESH_SESSION" }
  return {
    fingerprint: digestValue({ role: detail.role, sessionId: detail.sessionId, from, to: model.modelRef }),
    fromModelRef: from,
    toModelRef: model.modelRef,
  }
}

// 已有会话换模型门（§3.6）：续派会话首派模型与当前配置不一致 → 签发三选项卡；选"保留"后按 keptModelRef
// 固化（rolesDigest 变化才再问）。会话不可热替换模型，本门只决定"保留旧会话 / 重开 / 回滚"。
async function freshSessionGate({ task, state, cards }) {
  const registry = await readRegistry(task)
  const excludedKeys = supersededKeys(task.journal)
  const roles = normalizeRoleEntries(registry.roles).roles
  // 绑定指纹只覆盖模型配置（roles + packages）；intent 文本变化不应让"保留旧会话"重新问一次。
  const snapshot = intakeSnapshot({ task, roles, packages: task.packages })
  const rolesDigest = digestValue({ roles: snapshot.roles, packages: snapshot.packages })
  for (const card of cards) {
    if (!card.continuation) continue
    const prevKey = continuationPrevKey({ journal: task.journal, agentMaps: registry.mappings, excludedKeys }, { key: card.key, role: card.role, package: card.package ?? null })
    const sessionId = prevKey ? registry.mappings[prevKey] : null
    if (!sessionId) continue
    // 基线 = 当前会话（sessionId）在当前阶段/最近 reset 之后的首派模型；旧数据无起始映射才回退全任务首派。
    const from = sessionFirstModelRef(task, registry.mappings, card.role, card.package ?? null, sessionId)
      ?? lastDispatchModelRefFor(task, card.role, card.package ?? null)
      ?? firstDispatchModelRef(task, card.role, card.package ?? null)
    if (!from || !card.modelRef || modelRefsEqual(from, card.modelRef)) continue
    const keep = (task.decisions ?? []).filter((decision) => decision.grant === "keep-session" && decision.sessionId === sessionId && decision.role === card.role).at(-1)
    if (keep?.keptModelRef && keep.rolesDigest === rolesDigest) {
      card.modelRef = normalizeModelRef(keep.keptModelRef, "keep-session.keptModelRef")
      continue
    }
    const decisionId = "fresh-" + randomBytes(3).toString("hex")
    // 包波的模型来自 packages[].model（包级优先）；无包波来自 roles[role]。回滚对象随来源而定。
    const rollbackTarget = card.package != null ? "package" : "roles"
    const rollbackLabel = rollbackTarget === "package" ? "回滚包模型到旧值" : "回滚 roles 到旧值"
    const rollbackDesc = rollbackTarget === "package" ? "包 " + card.package + " 的 model 恢复为首派模型并重签确认卡" : "角色模型恢复为首派模型并重签确认卡"
    const reason = "模型变更确认（已有会话不可热替换模型）：续派会话 " + sessionId + "（" + card.role + (card.package ? " · 包 " + card.package : "") + "）首派模型 " + describeModelRef(from) + "，当前配置 " + describeModelRef(card.modelRef) + "。请选择：保留原会话按旧模型继续 / 作废当前波并重开会话（全新上下文）/ " + rollbackLabel + "。"
    const choices = [
      { n: 1, label: "保留原会话", desc: "按首派模型继续，之后不再重复出卡", grant: "keep-session" },
      { n: 2, label: "作废当前波并重开会话", desc: "写 session-reset，用新模型全新上下文（原会话上下文不延续）", grant: "retire-and-recreate" },
      { n: 3, label: rollbackLabel, desc: rollbackDesc, grant: "rollback-model" },
    ]
    const requiresFreshSession = { role: card.role, package: card.package ?? null, sessionId, fromModelRef: from, toModelRef: card.modelRef, target: rollbackTarget, waveId: card.waveId ?? null, scene: state.stage, rolesDigest }
    await appendEventsUnlocked(task, [{ type: "decision-issued", detail: { decisionId, gateId: null, reason, choices, requiresFreshSession, freshSessionFingerprint: digestValue({ role: card.role, sessionId, from, to: card.modelRef }) } }])
    return { card: { ok: true, task: task.name, stage: state.stage, status: "awaiting-user", next: "decide", transition: "await-decision", code: "REQUIRES_FRESH_SESSION", decisionId, question: reason, choices, requiresFreshSession, note: "已有会话换模型需显式确认：按卡片选项作答后再推进" } }
  }
  return {}
}

// 包模型不可解析 / 角色未解析的统一 blocked 卡（不写 dispatched 事实）。
function modelResolutionCard({ task, state, error }) {
  const code = error.code ?? "ROLES_UNRESOLVED"
  return {
    ok: true,
    task: task.name,
    stage: state.stage,
    status: "blocked",
    next: "configure-model",
    blockers: [{ code, message: error.message, recovery: error.recovery }],
    note: "未写入派发事实；修复角色/包级模型后可原样重试。",
  }
}

// 当前阶段双指纹（B 同源化：runStatusCard / runTransition / cmdDecide 三处共用同一计算——
// 渲染失效检测、签发锚点与 decide 校验不漂移）
function currentArtifactFpOf(task, state) {
  return artifactFingerprints(
    task.artifacts.items.filter((i) => i.stage === state.stage),
    Array.isArray(task.packages) && task.packages.length ? task.packages : null,
  )
}
function currentReviewFpOf(task, state, workflow, policy) {
  const stageDef = workflow.stages.find((st) => st.id === state.stage)
  const sp = scenePolicy(policy, stageDef?.teamScene ?? "implementation")
  return reviewChainFingerprint({ reports: task.reports.filter((r) => r.stage === state.stage), journal: task.journal, core: Boolean(sp.core) })
}

// 派单卡（v3.2 波组：detail = {key, package, round, continuation, writable}）
// 段序固定（方案第二节 2）：卡头 → 本轮验收基线 → 工作流职责（TWR 固定契约，包内锁定）
// → 规范/红线/建议（规则库可 DIY 三段）→ 行动与交付。填充只有两种来源：
// runtime = 任务事实投影 + lockedWorkflowContract(role)；rules = 调用方解析好的三段文本 memberRules
// （resolveMemberRules + composeMemberRules 的结果，为空字符串时整段省略）。
// 带当波任务事实的包限定、组合评审/裁决覆盖句留在行动与交付段（纪律通用句已进锁定契约）。
// 上一轮 blocked 上下文（扩权重派场景）：该包最新 owner 报告为 blocked 时注入派单卡，
// 让重派后的 Owner（可能是新会话）知道上次为什么做不了、本轮范围已重新声明。
// 注意：本函数用 at 墙钟选取"最新报告"，仅服务于派单卡展示文案；blocked 的**有效性**判定
// （静止卡/让位/派发过滤）一律以 waves.effectiveBlockedSet 的 seq 因果口径为准，二者不共用比较器。
function lastOwnerBlockedSummary(task, pkg) {
  let last = null
  for (const r of task.reports ?? []) {
    if (r.role !== 'owner' || r.kind !== 'deliver' || (r.package ?? null) !== pkg) continue
    if (!last || (r.at ?? '') >= (last.at ?? '')) last = r
  }
  return last && last.payload?.outcome === 'blocked' ? String(last.payload.summary ?? '') : null
}

// model = { modelRef, source }（派发期从 pkg.model ?? roles[role] 取出的已固化模型；卡头展示、journal 落盘同源）
function dispatchCard(task, stageDef, wave, detail, memberRules = "", model = null) {
  const sp = scenePolicy(task.policy, stageDef.teamScene)
  const pkg = detail.package ?? null
  const currentPackage = pkg == null ? null : task.packages?.find((p) => p.id === pkg)
  const boundaries = detail.writable.map(({ path: p, artifactKind }) => p + (p.endsWith('/') ? '（目录授权：其下路径均可写）' : '') + (pkg ? '（包 ' + pkg + '，产出物 ' + artifactKind + '）' : '（产出物 ' + artifactKind + '）'))
  const lastBlocked = (wave.kind === 'produce' || wave.kind === 'respond') ? lastOwnerBlockedSummary(task, pkg) : null
  const deliverCmd = twCommand() + ' deliver --task ' + task.name + ' --key ' + detail.key + ' --outcome delivered --summary <一句话> --paths <可写路径>'
  const verdictArg = ' --verdict <JSON: outcome|rationale|confidence|recommendedAction>'
  const reviewCmd = twCommand() + ' review --task ' + task.name + ' --key ' + detail.key + ' --recommendation <accept|rework|escalate> --summary <一句话>' + (wave.kind === 'verdict' ? verdictArg : '')
  const intro = detail.continuation ? '# 续派（key: ' + detail.key + '）——你在原上下文基础上继续' : '# 派单（key: ' + detail.key + '）'
  const headLine = '任务：' + task.name + '；阶段：' + stageDef.id + '（' + stageDef.label + '）；角色：' + wave.role + '；轮次：' + (detail.round ?? wave.round) + (pkg ? '；包：' + pkg : '') + (detail.waveId ? '；波：' + detail.waveId : '') +
    (model?.modelRef ? '；模型：' + model.modelRef.provider + '/' + model.modelRef.modelName + '（推理强度 ' + (model.modelRef.effort ?? '省略') + '）· 来源 ' + (model.source ?? 'roles') : '')
  // 当前验收基线由同一事实投影，两种正文及在途重建都携带一次。
  const contextParts = [
    '## 本轮验收基线',
    '任务总目标（背景；你的职责以本派单角色、范围和完成标准为准）：' + task.intent.objective,
    task.intent.constraints.length ? '约束：\n' + task.intent.constraints.map((c) => '- ' + c).join('\n') : '',
    task.intent.exclusions.length ? '排除：\n' + task.intent.exclusions.map((c) => '- ' + c).join('\n') : '',
    task.intent.scope && typeof task.intent.scope === 'object' && Object.keys(task.intent.scope).length
      ? '范围（intent.scope）：\n' + Object.entries(task.intent.scope).map(([key, value]) => '- ' + key + '：' + (Array.isArray(value) ? value.join('、') : String(value))).join('\n')
      : '',
    Array.isArray(task.intent.acceptance) && task.intent.acceptance.length ? '验收（intent.acceptance）：\n' + task.intent.acceptance.map((a) => '- ' + a).join('\n') : '',
    wave.role === 'owner' && Array.isArray(currentPackage?.done) && currentPackage.done.length ? '本包完成标准：\n' + currentPackage.done.map((d) => '- ' + d).join('\n') : '',
    (wave.role === 'challenger' || wave.role === 'expert') && task.packages?.some((p) => Array.isArray(p.done) && p.done.length)
      ? '各包完成标准（仅验收已交付包）：\n' + task.packages.filter((p) => Array.isArray(p.done) && p.done.length).map((p) => p.id + '：\n' + p.done.map((d) => '- ' + d).join('\n')).join('\n')
      : '',
  ]
  // 包限定与组合职责带着本波任务事实（哪个包、本轮已交付哪些包），属 runtime 尾段而非固定契约。
  const scopeParts = [
    wave.role === 'owner' && pkg ? '你仅承担本包 ' + pkg + '；总目标中的其他包与团队组织要求由 Lead 处理。' : '',
    wave.scope === 'consolidation' || (wave.kind === 'verdict' && task.packages?.length) ? '组合评审/裁决仍覆盖本轮已交付包的组合制品。' : '',
  ]
  const tailParts = [
    '## 行动与交付',
    scopeParts[0],
    scopeParts[1],
    wave.role === 'owner' ? '可写路径（仅限）：\n' + (boundaries.map((b) => '- ' + b).join('\n') || '（无，纯回应派单）') : '只读派单：不得修改任何文件',
    // §4 写边界补强（phase3 方案）：声明越界后果——三层防线可见化（派单纪律/ deliver 校验/快照恢复）
    wave.role === 'owner' ? '可写范围外的修改会被 deliver 拒绝；已越界污染的产出物可在恢复轮回滚（tw restore 快照恢复）。不要尝试绕过。' : '',
    wave.scope === 'consolidation' ? '组合评审：对象是本轮全部已交付包的组合制品——重点审包间接缝、需求偏移与集成风险；findings 请标注 package 归属（哪个包的问题）。被审制品清单：' + NLART(task, stageDef.id) : '',
    reviewVerdictContext(task, stageDef.id, wave),
    // D6（台账）：评审/裁决派单内嵌包计划事实——把编排事实给到裁决者，
    // 消除"缺包误判 rework"（topo-e2e w17 实例：expert 不知道未交付包会自动解锁派发）
    (wave.role === 'challenger' || wave.role === 'expert') && Array.isArray(task.packages) && task.packages.length
      ? (() => {
          const excluded = supersededKeys(task.journal ?? [])
          return '本任务包计划：' + task.packages.map((p) => {
            const delivered = (task.reports ?? []).some((r) => r.stage === stageDef.id && r.kind === 'deliver' && r.payload?.outcome !== 'blocked' && (!r.dispatchKey || !excluded.has(r.dispatchKey)) && r.package === p.id)
            return p.id + (delivered ? '（已交付）' : '（未交付' + ((p.dependsOn ?? []).length ? '，依赖满足后自动派发' : '') + '）')
          }).join('、') + '——未交付包不构成 rework 依据；仅用于了解计划，对完整性的非阻塞顾虑写进 summary 或已有交付物。'
        })()
      : '',
    wave.kind === 'produce' || wave.kind === 'respond' ? '完成后调用：' + deliverCmd : '完成后调用：' + reviewCmd,
    wave.kind === 'verdict' ? 'Expert 裁决语义：recommendation 概括立场；verdict 是技术裁决正文（outcome/rationale/confidence/recommendedAction）。两者都通过上面的 review 调用提交，不要只写成文字。' : '',
    wave.kind === 'respond' ? reworkContext(task, stageDef.id, pkg) : '',
    lastBlocked ? '## 上一轮 blocked 原因\n' + lastBlocked + '\n本轮路径仅是可写边界，不代表争议已获用户批准；先核明确方向与授权，再按原合同工作。若仍不能完成，以 --outcome blocked 报告并保留原有效制品，不自行扩权。' : '',
    '上下文与派单已内嵌；不要读取 .team-work 内部状态，不要扫描项目外路径。',
  ]
  // 保留全量变体与恢复选择；续派也带当前基线，不依赖成员记忆旧条件。
  const join = (sections) => sections.filter(Boolean).join('\n\n')
  const disciplineParts = [lockedWorkflowContract(wave.role), memberRules]
  const prompt = join([intro, headLine, ...contextParts, ...disciplineParts, ...tailParts])
  const promptFull = detail.continuation
    ? join([
        '# 续派全量变体（key: ' + detail.key + '）——原会话上下文不可用时的自足派单',
        headLine,
        ...contextParts,
        ...disciplineParts,
        ...tailParts,
      ])
    : prompt
  return {
    ok: true,
    task: task.name,
    stage: stageDef.id,
    status: 'working',
    next: 'dispatch',
    transition: 'dispatch',
    dispatch: {
      key: detail.key,
      ...(detail.waveId ? { waveId: detail.waveId } : {}),
      role: wave.role,
      // tier 仅展示/权重用：角色档位（owner 含 risk 升档），不再读包 tier；实际模型以 modelRef 为准。
      tier: roleTierFor(task, sp, wave.role),
      ...(model?.modelRef ? { modelRef: model.modelRef, modelSource: model.source ?? 'roles' } : {}),
      round: detail.round ?? wave.round,
      kind: wave.kind,
      ...(pkg != null ? { package: pkg } : {}),
      continuation: Boolean(detail.continuation),
      ...(wave.scope ? { scope: wave.scope } : {}),
      prompt,
      ...(detail.continuation ? { promptFull } : {}),
    },
  }
}

// 开任务（§3.1/§3.4）：initTask 写 intent → 锁内解析三角色 ModelRef 写 agents.json.roles
// → journal roles-initialized → 签发意图确认卡（intake-approval）。open 后任务静止等待确认。
async function cmdOpen({ projectRoot, name, objective, entry, risk, rawRequirement, constraints = [], exclusions = [], scopeNotes = [], acceptance = [], gaps = [] }) {
  if (!name || !objective) throw fail("OPEN_INPUT_REQUIRED", "open 需要 --name 与 --objective")
  if (risk && !['normal', 'high', 'critical'].includes(risk)) throw fail("USAGE", "--risk 只能是 normal | high | critical（只升 owner 角色档；包级模型由 tw plan 显式指定）")
  const { workflow, policy } = await loadDefinitions(projectRoot)
  const resolvedEntry = entry ?? "research"
  const entryStage = workflow.stages.find((s) => s.id === resolvedEntry)
  if (!entryStage) throw fail("ENTRY_UNKNOWN", `未知阶段：${resolvedEntry}`)
  const completion = entry ? { mode: "through-stage", stage: entry } : { mode: "workflow" }
  const normalizedGaps = gaps.map((gap, index) => {
    if (!gap || typeof gap !== "object" || typeof gap.question !== "string" || !gap.question.trim()) throw fail("USAGE", "--gap 需要 JSON 对象且 question 为非空字符串：{question, whyItMatters?, proposedDefault?}")
    return {
      id: typeof gap.id === "string" && gap.id.trim() ? gap.id.trim() : "g" + (index + 1),
      question: gap.question.trim(),
      whyItMatters: typeof gap.whyItMatters === "string" ? gap.whyItMatters : "",
      proposedDefault: typeof gap.proposedDefault === "string" ? gap.proposedDefault : "",
      answer: typeof gap.answer === "string" && gap.answer.trim() ? gap.answer : null,
    }
  })
  const scope = {
    entry: resolvedEntry,
    outputs: (entryStage.outputs ?? []).map(String),
    ...(scopeNotes.length ? { notes: scopeNotes } : {}),
  }
  await initTask({
    projectRoot, name, objective, entry: resolvedEntry, completion, workflowDigest: workflow.version,
    stages: workflow.stages.map((s) => s.id), risk,
    intent: {
      rawRequirement: typeof rawRequirement === "string" ? rawRequirement : "",
      constraints,
      exclusions,
      scope,
      acceptance,
      gaps: normalizedGaps,
    },
  })
  const task0 = await loadTask(projectRoot, name, { workflow, policy })
  return withOwnerLock(path.join(task0.root, "locks", "task.lock"), async () => {
    const task = await loadTask(projectRoot, name, { workflow, policy, repair: true })
    const resolved = await resolveRoleModels({ task, workflow, policy })
    const unresolved = ROLE_KEYS.filter((role) => !resolved.roles[role])
    await updateAgents(task, (agents) => { agents.roles = resolved.roles })
    await appendEventsUnlocked(task, [{ type: "roles-initialized", detail: { roles: resolved.details, source: resolved.source, profile: resolved.profile, entryId: resolved.entryId, ...(unresolved.length ? { unresolved } : {}) } }])
    const card = await signIntakeApproval({ task, workflow, roles: resolved.roles, details: resolved.details, profile: resolved.profile, source: resolved.source })
    const baseNote = entry ? `任务从 ${entry} 介入，将运行到该阶段验收` : "任务将运行完整工作流"
    const riskNote = risk && risk !== 'normal' ? `；按 ${risk} 档运行：owner 角色档解析为 ${risk === 'critical' ? 'expert' : 'senior'}` : ""
    const unresolvedNote = unresolved.length ? '；角色模型 unresolved（' + unresolved.join('、') + '）：补齐配置后 tw roles --resolve 重建' : ''
    return {
      ok: true, task: name, stage: resolvedEntry, status: "awaiting-user", next: "decide", transition: "await-decision",
      ...card,
      roles: resolved.roles,
      note: baseNote + riskNote + '；已签发意图确认卡（确认前不派发）' + unresolvedNote,
    }
  })
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

// run 的下一步指引（§7 修订 v2）：run 只读后，一切推进（开单/签发/流转/完成）经 dispatch 通道。
const DISPATCH_HINT = "推进：调 tw-dispatch（{ task }，单次调用完成开单+创建+登记）；无 DSH 插件的终端用 tw dispatch-plan --task <名> [--writable <路径>:<kind>]"

// run（§7.2 修订 v2 + 返工终版 §二·D）：只读状态卡 + 下一步指引。推进是 dispatch 侧的单一写者
//（AGENTS 规则 6）：开单、决定卡签发、阶段流转与完成都在任务锁内由 dispatch 通道完成——dispatch-plan
// 是编排机器接口兼无插件终端的推进通道（人读输出），DSH 内由 tw-dispatch 调用；卡片即呈现单位。
// run 只读且**无锁**（与 gate 同一口径）：旧实现取任务锁会在锁目录创建/写入/删除锁文件——锁目录
// 只读时 run 抛 EACCES，不是只读；且锁外首次读有一致性窗口。无锁快照承诺：锁目录只读时 run 照常
// 返回状态卡、盘上零变化（含锁文件）。单文件原子写保证各文件不撕裂，跨文件尽力一致——卡面标注
// 所读 journal seq 版本（journalSeq）供调用方对账；自愈写回只在锁内写命令（loadTask repair=false）。
// awaiting-user 静止；completed 重复调用幂等返回同一完成卡片。
async function cmdRun({ projectRoot, name, writable = [] }) {
  if (writable.length) {
    throw fail("USAGE", "run 已只读，不接受 --writable；扩权重派/推进请用 tw-dispatch（writables 参数）或 tw dispatch-plan --writable <路径>:<kind>")
  }
  const { workflow, policy } = await loadDefinitions(projectRoot)
  if (!await taskExists(projectRoot, name)) {
    const archived = await archivedCard(projectRoot, name)
    if (archived) return archived
  }
  const task = await loadTask(projectRoot, name, { workflow, policy })
  const state = deriveTask(task)
  const card = await runStatusCard({ projectRoot, name, task, state, workflow, policy })
  const lastSeq = task.journal.length ? task.journal[task.journal.length - 1].seq : 0
  return { ...card, journalSeq: lastSeq }
}

// 只读状态卡渲染（cmdRun 专用）：分支与 runTransition 平行但零写入——runTransition 是 dispatch 通道的
// 推进器（唯一写者），本函数只呈现事实与指路。天然只读的行为保留：归档摘要卡、completed 幂等完成卡、
// wait-inflight 在途重建卡；决定卡仅呈现已签发的（首签归 dispatch，§7.5.3），签发指纹失效时给重签指引
// 而不作废旧卡（作废/重签都是写，归 dispatch 通道——封堵「run 反复重签」的死循环写路径，§7.5.2）。
async function runStatusCard({ projectRoot, name, task, state, workflow, policy }) {
  // E2E-14：终态幂等——重复 run 返回与完成时完全相同的卡片
  if (state.status === "completed") {
    return { ok: true, task: name, stage: state.stage, status: "completed", next: "archive", transition: "complete", note: "任务完成。可 tw archive --task 归档（用户确认后）" }
  }
  if (state.next.kind === "dispatch") {
    if (!state.next.wave) {
      // 门失败且非人工阻塞（如裁决/指纹失效且无法自动重派）：呈现 blocker 卡（I5；只读推导）
      const blockers = (state.gate?.blockers ?? state.next.hint ?? []).map((b2) => (typeof b2 === "string" ? { message: b2, recovery: b2 } : b2))
      return { ok: true, task: name, stage: state.stage, status: "blocked", next: "none", blockers, transition: "blocked" }
    }
    const wave = state.next.wave
    // 只读检查（run 零写入）：确认未完成或配置已变化时只给重签指引，签发归 dispatch 通道。
    const intakeIssued = task.journal.some((event) => event.type === "decision-issued" && event.detail?.gateId === INTAKE_GATE)
    if (intakeIssued) {
      const stateInfo = await intakeState(task)
      const accepted = intakeConfirmation(task)
      if (!accepted || accepted.intakeFingerprint !== stateInfo.fingerprint) {
        return { ok: true, task: name, stage: state.stage, status: "working", next: "dispatch", wave: { kind: wave.kind, role: wave.role, round: wave.round }, note: "意图确认未完成或配置已变化：调 tw-dispatch（或 tw dispatch-plan）重签确认卡并等待用户确认；确认前不派发" }
      }
    }
    return {
      ok: true, task: name, stage: state.stage, status: "working", next: "dispatch",
      wave: { kind: wave.kind, role: wave.role, round: wave.round },
      note: "有待派发波次（" + wave.kind + " · " + wave.role + " 第 " + wave.round + " 轮）。" + DISPATCH_HINT,
    }
  }
  if (state.next.kind === "advance") {
    return { ok: true, task: name, stage: state.stage, status: "working", next: "dispatch", note: "当前阶段门禁已通过、待进入下一阶段。" + DISPATCH_HINT }
  }
  if (state.next.kind === "complete") {
    return { ok: true, task: name, stage: state.stage, status: "working", next: "dispatch", note: "任务完成条件已满足、待收尾出完成卡。" + DISPATCH_HINT }
  }
  if (state.next.kind === "wait-inflight") {
    // F3/F4 在途重建（只读）：卡内嵌原派单全文与兜底判定事实（modelRef/expectedAgentId/registered）。
    // 恢复入口 = tw-dispatch：按条目 registered/expectedAgentId 逐条自动处置（已登记等待/续派指引/补派）；
    // 无插件终端按 dsh-orchestration 的 wait-inflight 规程手工处置。
    const inflight = await inflightDispatches(projectRoot, task, state.stage) // 惰性：在途重建按需解析规则
    return {
      ok: true, task: name, stage: state.stage, status: "working", next: "wait", transition: "wait-inflight",
      dispatchKey: state.next.dispatchKey,
      ...(state.next.waveId ? { waveId: state.next.waveId } : {}),
      wave: { kind: state.wave.kind, role: state.wave.role, round: state.wave.round },
      inflight,
      note: "波次 " + state.wave.kind + "（" + state.wave.role + " 轮次 " + state.wave.round + "）已派发、部分在途（inflight 可原样转发补派：" + inflight.map((d) => d.key).join("、") + "）。" + DISPATCH_HINT,
    }
  }
  if (state.next.kind === "await-decision") {
    // 阶段工作摘要（呈现素材）：与 runTransition 的用户决定点共用同一 stageProgress 推导
    const progressText = stageProgress(task, state.stage)
    // blocked 静止卡（produce/respond 波，非 decision 卡）：只读呈现；恢复 = 扩权重派，入口在 dispatch 通道
    if (Array.isArray(state.next.produceBlocked)) {
      return {
        ok: true, task: name, stage: state.stage, status: "awaiting-user", next: "re-scope", transition: "await-decision",
        blocked: state.next.produceBlocked, question: state.next.reason,
        ...(progressText ? { progress: progressText } : {}),
        note: "任务静止等待用户：先核必要性和授权，用户明确方向与授权后按原通道恢复（单 owner 用已获授权范围调 tw-dispatch 的 writables / tw dispatch-plan --writable；多包先 tw plan 重拆再推进），或决定结束。路径参数不代表产品授权",
      }
    }
    // B（返工终版 §二·B）：渲染一律同钉账本原卡（derive 静止化带出的 state.next.pending）——
    // question/choices 直接用签发时落盘的 pending.reason/pending.choices，禁止重算（防两源错位）。
    const pending = state.next.pending ?? null
    if (pending) {
      if (pending.migrate) {
        // F9 迁移冲突卡：只读渲染其签出时的 question/choices（迁移卡无指纹语义，decide 直答）
        return { ok: true, task: name, stage: state.stage, status: "awaiting-user", next: "decide", transition: "await-decision", decisionId: pending.decisionId, question: pending.reason, choices: pending.choices, note: "迁移冲突卡待决：decide 保留版本后任务恢复推进" }
      }
      if (pending.gateId && pending.fingerprints && !humanDecisionFresh({ decided: pending.fingerprints, artifactFp: currentArtifactFpOf(task, state, workflow, policy), reviewFp: currentReviewFpOf(task, state, workflow, policy) })) {
        // 指纹失效（§7.5.2 死循环封堵）：只读 run 不作废不重签（写归 dispatch 通道），返回失效指引卡——
        // 调 tw-dispatch / tw dispatch-plan 推进时由 runTransition 作废旧卡（decided:superseded）并重签。
        return { ok: true, task: name, stage: state.stage, status: "awaiting-user", next: "re-sign", transition: "await-decision", decisionId: pending.decisionId, stale: true, question: pending.reason, note: "该待决卡已失效（签发后制品或评审链又变化，原选项不可再 decide）：调 tw-dispatch（或 tw dispatch-plan）重签最新卡片后重新 decide" }
      }
      if (pending.gateId === INTAKE_GATE) {
        // 意图确认卡：只读渲染；配置已变时提示调 dispatch 重签（run 不作废不重签，写归 dispatch 通道）。
        const stateInfo = await intakeState(task)
        if (pending.intakeFingerprint !== stateInfo.fingerprint) {
          return { ok: true, task: name, stage: state.stage, status: "awaiting-user", next: "re-sign", transition: "await-decision", decisionId: pending.decisionId, stale: true, question: pending.reason, note: "意图、角色模型或包模型已变化：调 tw-dispatch（或 tw dispatch-plan）重签确认卡后重新 decide" }
        }
        return { ok: true, task: name, stage: state.stage, status: "awaiting-user", next: "decide", transition: "await-decision", decisionId: pending.decisionId, question: pending.reason, choices: pending.choices, intakeFingerprint: pending.intakeFingerprint, ...(pending.intake ? { intake: pending.intake } : {}), ...(progressText ? { progress: progressText } : {}) }
      }
      if (isLegacyEscalationCard(pending)) {
        return { ok: true, task: name, stage: state.stage, status: "awaiting-user", next: "re-sign", transition: "await-decision", decisionId: pending.decisionId, stale: true, question: pending.reason, note: "该卡属于已删除的升档审批机制：调 tw-dispatch（或 tw dispatch-plan）推进一次即自动收口（decided:superseded）并重推导" }
      }
      if (pending.requiresFreshSession && pending.freshSessionFingerprint !== undefined) {
        const current = await currentFreshFingerprint(task, pending.requiresFreshSession)
        if (!current.fingerprint || current.fingerprint !== pending.freshSessionFingerprint) {
          return { ok: true, task: name, stage: state.stage, status: "awaiting-user", next: "re-sign", transition: "await-decision", decisionId: pending.decisionId, stale: true, question: pending.reason, note: "换模型确认卡已失效（角色/包模型在签发后变化）：调 tw-dispatch（或 tw dispatch-plan）重签后再决定" }
        }
      }
      return { ok: true, task: name, stage: state.stage, status: "awaiting-user", next: "decide", transition: "await-decision", decisionId: pending.decisionId, question: pending.reason, choices: pending.choices, ...(progressText ? { progress: progressText } : {}) }
    }
    // 路由类 blocker（pending 之后——routeBlocker 在场时 derive 不会静止）：只读呈现路由指引
    const routeBlocker = (state.gate?.blockers ?? []).find((b) => b.route && b.awaitingUser)
    if (routeBlocker && !task.decisions.some((d) => d.route === routeBlocker.route)) {
      return {
        ok: true, task: name, stage: state.stage, status: "awaiting-user", next: "route", transition: "await-route",
        route: routeBlocker.route,
        question: routeBlocker.requirement,
        fix: routeBlocker.recovery,
        ...(progressText ? { progress: progressText } : {}),
        note: "先做路由判定（tw route），完成后人工门卡才会出现",
      }
    }
    // 未签发（人工门首签/僵局/blocked 决定卡首签归 dispatch 通道，§7.5.3 收窄）：只读给指引不签发
    return { ok: true, task: name, stage: state.stage, status: "working", next: "dispatch", ...(state.next.reason ? { question: state.next.reason } : {}), note: (state.next.reason ? "需要用户决定（" + state.next.reason + "）" : "需要用户决定") + "；决定卡由 dispatch 通道签发。" + DISPATCH_HINT }
  }
  if (state.next.kind === "blocked") {
    return { ok: true, task: name, stage: state.stage, status: "blocked", next: "none", transition: "blocked", blockers: [{ message: state.next.reason, recovery: state.next.reason }] }
  }
  return { ok: true, task: name, stage: state.stage, status: state.status, next: "dispatch", note: DISPATCH_HINT }
}

// B（pre-phase3 §B）：e2eTemplate 物化——e2e 场景阶段首次派发前，任务无 packages 时按 policy 模板生成
// （journal 记 packages-planned，detail 附 source:"e2eTemplate"）；已 plan 不覆盖；非 e2e 场景跳过。
// 形状映射：packageId→id、outputRefs（artifact:e2e-design）→ writable（约定路径 e2e/<name>.md:<ref>）、completionCriteria→done。
async function ensureE2ePackages(task) {
  const state = deriveTask(task)
  const stageDef = task.workflow.stages.find((st) => st.id === state.stage)
  if (!stageDef || stageDef.teamScene !== 'e2e') return false
  if (Array.isArray(task.packages) && task.packages.length) return false
  const template = task.policy?.e2eTemplate
  if (!Array.isArray(template) || template.length === 0) return false
  const items = template.map((entry) => ({
    id: entry.packageId,
    writable: (entry.outputRefs ?? []).map((ref) => {
      const name = String(ref).replace(/^artifact:/, '')
      return 'e2e/' + name + '.md:' + name
    }),
    done: entry.completionCriteria ?? [],
    dependsOn: entry.dependsOn ?? [],
  }))
  await atomicJson(path.join(task.root, 'packages.json'), { items })
  task.packages = items
  await appendEventsUnlocked(task, [{ type: 'packages-planned', detail: { packages: items.map((p) => p.id), source: 'e2eTemplate' } }])
  return true
}

// F1/F8 波身份：waveId 与 d 序号两个「全任务递增序号」均以 journal 内 dispatched 事件数为源（任务锁内推导，
// 不引入平行权威）；迁移后新号从 max(wvN)/max(dN) 接续。waveNum = max(dispatchedCount, maxWvN) + 1，
// 恒严格大于已赋最大值（B8/R1 断言语义；dispatchedCount >= 波数 >= maxWvN 为正常态，max 为损坏数据防御）。
// 同批次多派发共享一个 waveId；d 序号不承担幂等键职责（唯一性由随机后缀保证）。
function nextWaveIdentity(task) {
  const dispatchedCount = task.journal.filter((e) => e.type === "dispatched").length
  let maxWv = 0
  for (const e of task.journal) {
    const m = /^wv(\d+)$/.exec(e.detail?.waveId ?? "")
    if (m) maxWv = Math.max(maxWv, Number(m[1]))
  }
  return { waveId: `wv${Math.max(dispatchedCount, maxWv) + 1}`, dispatchSeq: dispatchedCount + 1 }
}

function dispatchedDetail(dispatch, wave, writable) {
  return {
    key: dispatch.key,
    kind: wave.kind,
    role: wave.role,
    round: dispatch.round,
    package: dispatch.package ?? null,
    continuation: dispatch.continuation,
    ...(dispatch.scope ? { scope: dispatch.scope } : {}),
    writable,
    ...(dispatch.waveId ? { waveId: dispatch.waveId } : {}),
    ...(wave.causeDecisionId ? { causeDecisionId: wave.causeDecisionId } : {}),  // F5：respond 派发抄写返工决定（runtime 抄写，P4）
    // 新派发一律写 modelRef + 来源（package/roles）；历史 modelHint 只在读取时映射，不重写。
    ...(dispatch.modelRef ? { modelRef: dispatch.modelRef, modelSource: dispatch.modelSource ?? 'roles' } : {}),
  }
}

// F9 当前待决卡选择（runTransition 渲染与 cmdDecide 处理共用同一函数，防两处取卡顺序分叉）：
// 未决 migrate 冲突卡优先于一切其他卡（derive 静止语义同源：迁移冲突未决时任务不推进、不渲染/不答其他卡），
// 否则取最早未决卡。返回 decision-issued 的 detail 对象（无待决卡 → null）。
function pendingDecisionDetail(journal) {
  const settled = new Set(journal.filter((e) => e.type === "decided").map((e) => e.detail.decisionId))
  const open = journal.filter((e) => e.type === "decision-issued").map((e) => e.detail)
  const migrate = open.find((d) => d?.migrate && !settled.has(d.decisionId))
  if (migrate) return migrate
  return open.find((d) => !settled.has(d.decisionId)) ?? null
}

// 规则库惰性读取（P3-5）：memberRulesText 只在"真正派发"与"在途重建"两个分支内按需调用——
// 任务不存在（归档卡）、终态幂等完成卡、awaiting-user 静止、advance/blocked 等非派发路径
// 零成员规则 I/O（每次调用按 role×teamScene 读取规则库三层目录，见 rules.mjs）。
// 无模块级缓存：每次派发/补发重新全量读取，保住"改规则文件即下次派发生效"的热变语义。
// 锁内执行权衡：本函数整体在任务锁（locks/task.lock，见 cmdDispatchPlan 的 withOwnerLock）内运行，
// 规则读取计入持锁时间——代价通过惰性控制在最小（仅派发/在途重建分支才读），
// 换取"判定与写入同锁"（复核修复原则）：注入规则的派单文本与 dispatched/journal 事实
// 在同一临界区内落盘，并发 run 不会出现规则内容与派发事实错位或读到半程覆盖层的竞态。
// 待决卡选择表（F5 四类僵局/返工/人工门/默认收敛；runTransition 签发与 runStatusCard 只读渲染共用）：
// 僵局卡对既有 converge-user choices 的扩展——「追加一轮」对僵局包会立即再判僵局（用户可见空转），不得沿用；
// blocked 卡用专用两选项「重派 respond（新绑定波）/ 结束任务」——不沿用「追加一轮」
// （extra-round 无派发路径、绑定波报告仍 blocked → 空转循环，实证修正）。
function decisionChoicesFor({ state, human }) {
  const isStalemate = Array.isArray(state.next.reworkStalemate)
  const isBlocked = Boolean(state.next.reworkBlocked)
  return isStalemate
    ? [
        { n: 1, label: "接受现状", desc: "未修包按原内容过评审链（人工门需重新确认）", grant: "accept-as-is" },
        { n: 2, label: "仅重派未修包", desc: "新 respond 波绑定同一返工决定、只含未修包", grant: "rework-unfixed" },
        { n: 3, label: "结束任务", desc: "以当前形态终止" },
      ]
    : isBlocked
      ? [
          { n: 1, label: "重派 respond", desc: "新 respond 波绑定同一返工决定、整波重派", grant: "rework-rerun" },
          { n: 2, label: "结束任务", desc: "以当前形态终止" },
        ]
      : human
        ? [{ n: 1, label: "accept", desc: "接受本阶段交付" }, { n: 2, label: "rework", desc: "要求返工（回到 Owner 波次）" }]
        : [{ n: 1, label: "追加一轮", desc: "授权追加一轮自主收敛", grant: "extra-round" }, { n: 2, label: "结束任务", desc: "以当前形态终止并归档" }]
}

// 派发前统一准备：意图确认门（§3.4）→ 角色初始化/迁移（§3.1/§7.1）→ 旧包 tier 物化（§3.3.1）。
// 返回 { roles } 或 { card }（已签发的等待/阻塞卡，调用方直接返回）。
async function prepareDispatch({ task, workflow, policy, state }) {
  // 顺序：角色初始化/迁移 → 旧包 tier 物化（配置事实先落盘）→ 意图确认门（卡面与指纹包含最终包模型）。
  // 这样拆包/自动模板只触发一次重签，而不是"确认后模型才物化"导致二次重签。
  const rolesInfo = await ensureRolesInitialized({ task, workflow, policy })
  if (rolesInfo.unresolved?.length) {
    return { card: modelResolutionCard({ task, state, error: {
      code: "ROLES_UNRESOLVED",
      message: "角色模型未解析：" + rolesInfo.unresolved.join("、") + "（agents.json.roles 缺失或损坏，派发不猜默认模型）",
      recovery: "补齐 DSH 当前 profile 的 team-work-dsh.tiers（tw models 查看解析），再 tw roles --resolve 重建角色模型；无宿主终端由调用方通过 TW_DSH_CONFIG 提供快照。",
    } }) }
  }
  const materialized = await materializePackages({ task })
  if (materialized.error) return { card: modelResolutionCard({ task, state, error: materialized.error }) }
  const gate = await intakeGateCard({ task, workflow, state })
  if (gate) return { card: gate }
  return { roles: rolesInfo.roles }
}

function dispatchModelFor(task, roles, state, role, pkg) {
  const model = modelRefForDispatch(task, roles, role, pkg)
  if (!model.error) return model
  return {
    errorCard: modelResolutionCard({ task, state, error: {
      code: model.error,
      message: model.error === "PACKAGE_MODEL_UNRESOLVED"
        ? "包 " + (pkg ?? "(未命名)") + " 未固化 model，且 agents.json.roles.owner 缺失"
        : "角色 " + role + " 的模型未固化（agents.json.roles 缺失）",
      recovery: model.error === "PACKAGE_MODEL_UNRESOLVED"
        ? "tw plan 重新登记包级 model，或先 tw roles --resolve 初始化 roles.owner"
        : "tw roles --resolve 重建角色模型，或 tw roles --set " + role + "=<provider>/<model>[@<effort>] 显式指定",
    } }),
  }
}

async function runTransition({ projectRoot, name, writable, workflow, policy, task, state }) {

  // blocked 静止卡的用户恢复通道（单 owner）：Lead 携新的可写范围经 dispatch 通道重派 = 用户重派指示
  // （规则 6：awaiting-user 只由新的用户输入恢复）。直接派新 produce 波——新 dispatched 晚于 blocked 报告，
  // 波次机的 blocked 判定自然解除；多包恢复走 plan 重拆（re-planned 同样晚于 blocked）后经 dispatch 通道推进。
  if (Array.isArray(state.next?.produceBlocked) && writable.length && writable[0] !== 'none' && !(Array.isArray(task.packages) && task.packages.length)) {
    const stageDef = workflow.stages.find((st) => st.id === state.stage)
    const prepared = await prepareDispatch({ task, workflow, policy, state })
    if (prepared.card) return prepared.card
    const { waveId, dispatchSeq } = nextWaveIdentity(task)
    const decl = writable.map(parseWritableEntry)
    const round = (projectRounds({ journal: task.journal, reports: task.reports }).get(null) ?? 0) + 1
    const wave = { kind: 'produce', role: 'owner', round, owners: [{ package: null, round, continuation: false }] }
    const d = { key: 'd' + dispatchSeq + '-' + randomBytes(3).toString('hex'), waveId, package: null, round, continuation: false, writable: decl }
    const model = dispatchModelFor(task, prepared.roles, state, 'owner', null)
    if (model.errorCard) return model.errorCard
    const rules = await memberRulesText({ projectRoot, workflow, teamScene: stageDef.teamScene, roles: ['owner'] })
    const dispatch = dispatchCard({ ...task, policy }, stageDef, wave, d, rules.get('owner') ?? "", model).dispatch
    const fresh = await freshSessionGate({ task, state, cards: [dispatch] })
    if (fresh.card) return fresh.card
    await appendEventsUnlocked(task, [{ type: 'dispatched', detail: dispatchedDetail(dispatch, wave, decl) }])
    return { ok: true, task: name, stage: state.stage, status: 'working', next: 'dispatch', transition: 'dispatch', dispatch, dispatches: [dispatch], wave: { kind: wave.kind, role: wave.role, round: wave.round }, note: '已按传入可写范围重派 produce（机械恢复不代表产品授权）；派单卡保留上一轮 blocked 原因' }
  }

  if (state.next.kind === 'dispatch') {
    if (!state.next.wave) {
      // 门失败且非人工阻塞（如裁决/指纹失效且无法自动重派）：返回 blocker 卡（I5）
      const blockers = (state.gate?.blockers ?? state.next.hint ?? []).map((b2) => (typeof b2 === 'string' ? { message: b2, recovery: b2 } : b2))
      return { ok: true, task: name, stage: state.stage, status: 'blocked', next: 'none', blockers, transition: 'blocked' }
    }
    const wave = state.next.wave
    const stageDef = workflow.stages.find((st) => st.id === state.stage)
    const prepared = await prepareDispatch({ task, workflow, policy, state })
    if (prepared.card) return prepared.card
    const pkgItems = Array.isArray(task.packages) && task.packages.length ? task.packages : null
    // F1/F8：波身份与 d 前缀 key（d 消除旧 w 前缀与 wave 的歧义）；同批次共享一个 waveId
    const { waveId, dispatchSeq } = nextWaveIdentity(task)
    const newKey = () => 'd' + dispatchSeq + '-' + randomBytes(3).toString('hex')
    if (wave.role === 'owner') {
      let decls
      if (pkgItems) {
        // 多包：可写范围来自包定义（--writable 不适用）；每包独立 key/轮次/continuation
        decls = wave.owners.map((o) => {
          const pkg = pkgItems.find((p) => p.id === o.package)
          return { key: newKey(), waveId, package: o.package, round: o.round, continuation: o.continuation, writable: (pkg?.writable ?? []).map(parseWritableEntry) }
        })
      } else {
        if (!writable.length) {
          const outputs = (stageDef.outputs ?? []).map((k) => '  --writable <路径>:' + k).join('\n')
          throw fail('DISPATCH_INPUT_REQUIRED', 'Owner 波次需要声明可写路径与产物类型。阶段 ' + stageDef.id + ' 的产出物合同：\n' + (outputs || '  （无声明产出物，纯调查/回应类派单可直接 --writable none）'))
        }
        const o = wave.owners?.[0]
        // --writable none = 无产物派单（纯调查/回应，outputs 为空的阶段）；其余按 路径:kind 解析
        const decl = writable.length === 1 && writable[0] === 'none' ? [] : writable.map(parseWritableEntry)
        decls = [{ key: newKey(), waveId, package: null, round: o?.round ?? wave.round, continuation: o?.continuation ?? false, writable: decl }]
      }
      // 惰性：仅到达真正派发点才解析规则
      const rules = await memberRulesText({ projectRoot, workflow, teamScene: stageDef.teamScene, roles: ['owner'] })
      const cards = []
      for (const d of decls) {
        const model = dispatchModelFor(task, prepared.roles, state, 'owner', d.package)
        if (model.errorCard) return model.errorCard
        cards.push(dispatchCard({ ...task, policy }, stageDef, wave, d, rules.get('owner') ?? "", model).dispatch)
      }
      // 已有会话换模型门：续派前检测首派与当前配置差异（§3.6），命中则停止并签发换模型卡。
      const fresh = await freshSessionGate({ task, state, cards })
      if (fresh.card) return fresh.card
      await appendEventsUnlocked(task, cards.map((card, index) => ({ type: 'dispatched', detail: dispatchedDetail(card, wave, decls[index].writable) })))
      return { ok: true, task: name, stage: state.stage, status: 'working', next: 'dispatch', transition: 'dispatch', dispatch: cards[0], dispatches: cards, wave: { kind: wave.kind, role: wave.role, round: wave.round } }
    }
    const key = newKey()
    // 惰性：非 owner 派发同样只在派发点解析规则
    const model = dispatchModelFor(task, prepared.roles, state, wave.role, null)
    if (model.errorCard) return model.errorCard
    const rules = await memberRulesText({ projectRoot, workflow, teamScene: stageDef.teamScene, roles: [wave.role] })
    const card = dispatchCard({ ...task, policy }, stageDef, wave, { key, waveId, round: wave.round, continuation: wave.continuation, writable: [] }, rules.get(wave.role) ?? "", model)
    const fresh = await freshSessionGate({ task, state, cards: [card.dispatch] })
    if (fresh.card) return fresh.card
    await appendEventsUnlocked(task, [{ type: 'dispatched', detail: dispatchedDetail(card.dispatch, wave, []) }])
    return { ...card, dispatch: card.dispatch }
  }

  if (state.next.kind === "advance") {
    const edges = (workflow.edges ?? []).filter((e) => e.from === state.stage)
    // D7（评审 B-F1）：路由阶段按决定选边——code-review 等阶段无 pass 边且
    // run-e2e/skip-e2e 曾无消费者，原 edges[0] 兜底会恒取第一条边弹回 implementation。
    const stageDef = workflow.stages.find((st) => st.id === state.stage)
    const routeOf = stageDef?.route
    const routeDecision = routeOf ? task.decisions.find((d) => d.route === routeOf) : null
    const wanted = routeOf === "e2e"
      ? (routeDecision?.choice === "run" ? "run-e2e" : routeDecision?.choice === "skip" ? "skip-e2e" : null)
      : routeOf === "spec"
        ? (routeDecision?.choice === "run" ? "use-spec" : routeDecision?.choice === "skip" ? "skip-spec" : null)
        : null
    const edge = (wanted && edges.find((e) => e.outcome === wanted))
      ?? edges.find((e) => e.outcome === "pass")
      ?? edges[0]
    if (!edge) throw fail("STATE_CORRUPT", `阶段 ${state.stage} 没有可用出边`)
    await appendEventsUnlocked(task, [{ type: "stage-advanced", detail: { from: state.stage, to: edge.to } }])
    return { ok: true, task: name, stage: edge.to, status: "working", next: "run", transition: "advance", note: `${state.stage} 门禁通过，进入 ${edge.to}` }
  }
  if (state.next.kind === "complete") {
    await appendEventsUnlocked(task, [{ type: "task-completed", detail: { stage: state.stage } }])
    return { ok: true, task: name, stage: state.stage, status: "completed", next: "archive", transition: "complete", note: "任务完成。可 tw archive --task 归档（用户确认后）" }
  }
  if (state.next.kind === 'wait-inflight') {
    // F3/F4：在途卡内嵌原派单全文（从 journal dispatched 事实重建）+ §7.3 兜底判定事实三字段；
    // 恢复入口 = dispatch 通道（tw-dispatch 按条目自动处置；无插件终端按 orchestration 规程手工补派）。
    const inflight = await inflightDispatches(projectRoot, task, state.stage) // 惰性：在途重建按需解析规则
    return {
      ok: true, task: name, stage: state.stage, status: 'working', next: 'wait', transition: 'wait-inflight',
      dispatchKey: state.next.dispatchKey,
      ...(state.next.waveId ? { waveId: state.next.waveId } : {}),
      wave: { kind: state.wave.kind, role: state.wave.role, round: state.wave.round },
      inflight,
      note: '波次 ' + state.wave.kind + '（' + state.wave.role + ' 轮次 ' + state.wave.round + '）已派发；在途派单（inflight 数组含 modelRef/expectedAgentId/registered 判定事实，可原样转发补派）：' + inflight.map((d) => d.key).join('、') + '。恢复：调 tw-dispatch（按条目自动等待/续派/补派）',
    }
  }

  if (state.next.kind === "await-decision") {
    // 阶段工作摘要（呈现素材）：分支内全部用户决定点（blocked 静止/路由/人工门/僵局/converge-user）
    // 共用——自带"这阶段做了什么"的人话事实（P4：runtime 从自有 reports/artifacts 推导），
    // Lead 不必翻任务目录；空摘要（如 blocked 静止单包无交付）自然省略字段。
    const progressText = stageProgress(task, state.stage)
    // blocked 静止卡（produce/respond 波，非 decision 卡）：不签发 decision-issued（无 decide 语义），
    // 恢复通道 = 扩权重派（入口在 dispatch 通道：tw-dispatch writables / tw dispatch-plan --writable 新范围；
    // 多包先 tw plan 重拆）；重复推进幂等返回本卡。
    if (Array.isArray(state.next.produceBlocked)) {
      return {
        ok: true, task: name, stage: state.stage, status: "awaiting-user", next: "re-scope", transition: "await-decision",
        blocked: state.next.produceBlocked, question: state.next.reason,
        ...(progressText ? { progress: progressText } : {}),
        note: "任务静止等待用户：先核必要性和授权，用户明确方向与授权后按原通道恢复（单 owner 用已获授权范围调 tw-dispatch 的 writables / tw dispatch-plan --writable；多包先 tw plan 重拆再推进），或决定结束。路径参数不代表产品授权",
      }
    }
    // 路由类 blocker 优先（E2E 实测缺陷修复）：gate 同时有路由未判定与人工门时，
    // 必须先出路由指引卡（走 tw route），不提前签发人工门决定——否则用户答完人工门
    // 又收到同样的人工门卡（路由仍悬空），死循环且指引缺失。
    const routeBlocker = (state.gate?.blockers ?? []).find((b) => b.route && b.awaitingUser)
    if (routeBlocker && !task.decisions.some((d) => d.route === routeBlocker.route)) {
      return {
        ok: true, task: name, stage: state.stage, status: "awaiting-user", next: "route", transition: "await-route",
        route: routeBlocker.route,
        question: routeBlocker.requirement,
        fix: routeBlocker.recovery,
        ...(progressText ? { progress: progressText } : {}),
        note: "先做路由判定（tw route），完成后人工门卡才会出现",
      }
    }
    // B（返工终版 §二·B）：待决卡从 derive 静止化结果取（state.next.pending，与 runStatusCard/decide
    // 同源），渲染一律同钉账本 pending.reason/pending.choices——禁止重算 choices（防「渲染重算、
    // decide 用账本」两源错位：选项序号/文案漂移会让 decide 映射到错误语义）。
    const pending = state.next.pending ?? null
    // F6-3 签发锚点：人工门卡签发时绑定 {artifactFingerprint, reviewFingerprint} 快照；
    // F6-2 未决分支：签发指纹 vs 当前指纹，变化 → 作废旧卡（decided:superseded，只增不改）重签新卡。
    const currentArtifactFp = currentArtifactFpOf(task, state)
    const currentReviewFp = currentReviewFpOf(task, state, workflow, policy)
    // 僵局/blocked/人工门/默认四类选择表（仅首签生成；重渲染一律用账本 pending.choices）
    const human = state.gate?.humanGate ?? state.next.gateId ?? null
    const cardChoices = decisionChoicesFor({ state, human })
    if (pending) {
      if (pending.migrate) {
        // F9 迁移冲突卡：渲染其签出时的 question/choices（不套用 cardChoices、不参与人工门指纹比对——
        // 卡面与 decide 校验同源，防误映射候选索引；优先于任何其他未决卡）
        return { ok: true, task: name, stage: state.stage, status: "awaiting-user", next: "decide", transition: "await-decision", decisionId: pending.decisionId, question: pending.reason, choices: pending.choices, note: "迁移冲突卡待决：decide 保留版本后任务恢复推进" }
      }
      if (pending.gateId === INTAKE_GATE) {
        // 意图确认卡：配置未变 → 同钉渲染；已变（tw intent/roles/plan 改过）→ 作废并重签（§3.4.4）。
        const stateInfo = await intakeState(task)
        if (pending.intakeFingerprint === stateInfo.fingerprint) {
          return { ok: true, task: name, stage: state.stage, status: "awaiting-user", next: "decide", transition: "await-decision", decisionId: pending.decisionId, question: pending.reason, choices: pending.choices, intakeFingerprint: pending.intakeFingerprint, ...(pending.intake ? { intake: pending.intake } : {}) }
        }
        const details = roleDetailsForCard(task, stateInfo.roles, stateInfo.invalid)
        const card = await signIntakeApproval({ task, workflow, roles: stateInfo.roles, details, profile: profileOf(task), source: "role-registry" })
        return { ok: true, task: name, stage: state.stage, status: "awaiting-user", next: "decide", transition: "await-decision", ...card, note: "意图、角色模型或包模型已变化：确认卡已重签" }
      }
      if (isLegacyEscalationCard(pending)) {
        // 升档审批机制已删除：历史未决卡幂等收口（只增 decided:superseded），随后重推导。
        await appendEventsUnlocked(task, [{ type: "decided", detail: { decisionId: pending.decisionId, choice: "superseded", reason: "升档审批机制已删除" } }])
        return { ok: true, task: name, stage: state.stage, status: "working", next: "dispatch", transition: "re-sign", note: "历史升档待决卡已收口（decided:superseded），正在按当前配置重新推导" }
      }
      if (pending.requiresFreshSession && pending.freshSessionFingerprint !== undefined) {
        // E2：换模型卡签发后配置变化 → 旧卡作废重签（避免 decide 把 intake/旧 fresh 选项错位）。
        const current = await currentFreshFingerprint(task, pending.requiresFreshSession)
        if (!current.fingerprint || current.fingerprint !== pending.freshSessionFingerprint) {
          await appendEventsUnlocked(task, [{ type: "decided", detail: { decisionId: pending.decisionId, choice: "superseded", reason: "角色或包模型在换模型卡签发后变化，按当前配置重签" } }])
          return { ok: true, task: name, stage: state.stage, status: "working", next: "dispatch", transition: "re-sign", note: "换模型确认卡因配置变化已作废，正在按当前配置重新下发" }
        }
      }
      if (pending.gateId && pending.fingerprints && !humanDecisionFresh({ decided: pending.fingerprints, artifactFp: currentArtifactFp, reviewFp: currentReviewFp })) {
        // 指纹失效：作废旧卡（不删事实，只增 decided:superseded），落入下方重签
        await appendEventsUnlocked(task, [{ type: "decided", detail: { decisionId: pending.decisionId, choice: "superseded", reason: "等待期评审链或制品已变化，卡片自动失效重签" } }])
      } else {
        // 已签发未失效：同钉渲染账本原卡（卡面=账本=decide 依据；再调 dispatch 返回同一张卡——签发幂等）
        return { ok: true, task: name, stage: state.stage, status: "awaiting-user", next: "decide", transition: "await-decision", decisionId: pending.decisionId, question: pending.reason, choices: pending.choices, ...(progressText ? { progress: progressText } : {}) }
      }
    }
    const decisionId = `dec-${randomBytes(3).toString("hex")}`
    await appendEventsUnlocked(task, [{ type: "decision-issued", detail: {
      decisionId, gateId: human,
      reason: state.next.reason ?? `人工门 ${human}`,
      choices: cardChoices,
      fingerprints: { artifactFingerprint: currentArtifactFp, reviewFingerprint: currentReviewFp },
      ...(Array.isArray(state.next.reworkStalemate) ? { reworkStalemate: state.next.reworkStalemate.map(String) } : {}),
      // 卡类型标记落账（derive 静止态透传给重签：blocked 卡重签须生成「重派 respond/结束」两选项，
      // 不得回退人工门默认选项）
      ...(state.next.reworkBlocked ? { reworkBlocked: true } : {}),
    } }])
    return { ok: true, task: name, stage: state.stage, status: "awaiting-user", next: "decide", transition: "await-decision", decisionId, question: state.next.reason ?? `人工门 ${human}：是否接受交付？`, choices: cardChoices, ...(progressText ? { progress: progressText } : {}) }
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
    const task = await loadTask(projectRoot, name, { workflow, policy, repair: true })
    // F9：待决卡选择与 runTransition 渲染同源（pendingDecisionDetail：migrate 冲突卡优先），
    // 防「run 渲染 migrate 卡、decide 却处理人工门卡」的选项序号错位（实证修复）
    const pending = pendingDecisionDetail(task.journal)
    if (!pending) throw fail("DECISION_STALE", "当前没有等待中的决定")
    const options = pending.choices
    const picked = options.find((o) => o.n === choice)
    if (!picked) throw fail("DECISION_STALE", `选项序号 ${choice} 不在当前卡片中。合法选项：${options.map((o) => `${o.n}=${o.label}`).join("、")}`)

    const stageId = deriveTask(task).stage
    const current = task.artifacts.items.filter((item) => item.stage === stageId)
    // F5/F6 指纹（决定落盘与 gate 判定共用同一导出纯函数；R4 同源）
    const stageDef = task.workflow.stages.find((st) => st.id === stageId)
    const sp = scenePolicy(task.policy, stageDef?.teamScene ?? "implementation")
    const pkgArr = Array.isArray(task.packages) && task.packages.length ? task.packages : null
    const artifactFp = artifactFingerprints(current, pkgArr)
    const reviewFp = reviewChainFingerprint({ reports: task.reports.filter((r) => r.stage === stageId), journal: task.journal, core: Boolean(sp.core) })
    // F6-3：未决人工门卡同样做「签发指纹 vs 当前指纹」对比，失效即拒绝（旧卡直答被拒 + 指引闭环）
    if (pending.gateId && pending.fingerprints && !humanDecisionFresh({ decided: pending.fingerprints, artifactFp, reviewFp })) {
      throw fail("DECISION_STALE", "该卡片的签发指纹已失效（等待期评审链或制品发生变化）：tw run 查看状态，调 tw-dispatch / tw dispatch-plan 重签最新卡片后重新 decide")
    }
    // 升档审批机制已删除：历史未决升档卡保持审计事实，但不再可答（收口由 dispatch 通道完成）。
    if (isLegacyEscalationCard(pending)) {
      throw fail("DECISION_STALE", "该卡属于已删除的升档审批机制：调 tw-dispatch（或 tw dispatch-plan）推进一次即自动收口（decided:superseded）并重推导，随后按意图确认卡/模型配置重新推进")
    }
    // 意图确认卡：指纹必须与当前稳定投影一致（等待期改意图/roles/packages → 旧卡拒绝直答）；
    // unresolved 时不允许"确认开始"（确认语义是模型符合预期，不能假确认）。
    let intakeRoles = null
    if (pending.gateId === INTAKE_GATE) {
      const stateInfo = await intakeState(task)
      if (pending.intakeFingerprint !== stateInfo.fingerprint) {
        throw fail("DECISION_STALE", "意图、角色模型或包模型在签发后已变化：tw run 查看状态，调 tw-dispatch / tw dispatch-plan 重签确认卡后重新 decide")
      }
      intakeRoles = stateInfo.roles
      if (picked.grant === "accept-intake") {
        const unresolved = ROLE_KEYS.filter((role) => !intakeRoles[role])
        if (unresolved.length) throw fail("INTAKE_ROLES_UNRESOLVED", "角色模型仍未解析（" + unresolved.join("、") + "）：补齐 DSH 当前 profile 的 team-work-dsh.tiers（tw models 查看）后 tw roles --resolve 重签确认卡；unresolved 时不能确认开始")
      }
      if (picked.grant === "revise-intake") {
        return { ok: true, task: name, decisionId: pending.decisionId, next: "run", note: "未落盘决定：用 tw intent / tw roles / tw plan 修改后，调 tw-dispatch 会作废旧卡并重签；确认卡未确认前不派发" }
      }
    }
    // 已有会话换模型卡：三个选项分别写 keep-session 绑定 / session-reset 事实 / 回滚 roles。
    const fresh = pending.requiresFreshSession ?? null
    if (fresh && !["keep-session", "retire-and-recreate", "rollback-model"].includes(picked.grant)) {
      throw fail("DECISION_STALE", "换模型确认卡只接受 保留原会话 / 重开会话 / 回滚 roles 三个选项")
    }
    // E2：卡面必须与当前配置同钉——签发后 roles/packages 变化（含绕过 roles 命令的外部改动）拒绝直答。
    if (fresh && pending.freshSessionFingerprint !== undefined) {
      const current = await currentFreshFingerprint(task, fresh)
      if (!current.fingerprint || current.fingerprint !== pending.freshSessionFingerprint) {
        throw fail("DECISION_STALE", "该换模型卡签发后角色/包模型已变化（当前卡片与配置不再一致）：tw run 查看状态，调 tw-dispatch / tw dispatch-plan 重签后再决定")
      }
    }
    const decision = {
      decisionId: pending.decisionId,
      gateId: pending.gateId ?? null,
      choice: picked.label,
      ...(picked.grant ? { grant: picked.grant } : {}),
      ...(picked.batchKey ? { batchKey: picked.batchKey } : {}),
      ...(pending.gateId === INTAKE_GATE ? { intakeFingerprint: pending.intakeFingerprint, modelRefs: intakeRoles } : {}),
      ...(pending.gateId === INTAKE_GATE && pending.intake ? { intake: pending.intake } : {}),
      ...(fresh && picked.grant === "keep-session" ? { sessionId: fresh.sessionId, role: fresh.role, keptModelRef: fresh.fromModelRef, rolesDigest: fresh.rolesDigest } : {}),
      ...(fresh && picked.grant === "retire-and-recreate" ? { sessionId: fresh.sessionId, role: fresh.role } : {}),
      ...(fresh && picked.grant === "rollback-model" ? { sessionId: fresh.sessionId, role: fresh.role, target: fresh.target ?? "roles", restoredModelRef: fresh.fromModelRef } : {}),
      // F5/F6：决定绑定双指纹——artifactFingerprint（每包「包→指纹」映射）+ reviewFingerprint；
      // fingerprint 旧字段双写（§7 回滚兼容：旧版 runtime 读旧字段仍可判定）
      ...(pending.gateId && pending.gateId !== INTAKE_GATE ? { fingerprint: artifactsFingerprint(current), artifactFingerprint: artifactFp, reviewFingerprint: reviewFp } : {}),
      ...(picked.grant === "rework-unfixed" && Array.isArray(pending.reworkStalemate) ? { packages: pending.reworkStalemate } : {}),
      ...(note ? { note } : {}),
      proof: { mode: "caller-reported", at: new Date().toISOString() },
      at: new Date().toISOString(),
    }
    const file = path.join(task.root, "decisions.json")
    const existing = JSON.parse(await readFile(file, "utf8").catch(() => '{"items":[]}'))
    existing.items.push(decision)
    await atomicJson(file, existing)
    const events = [{ type: "decided", detail: { decisionId: decision.decisionId, choice: decision.choice } }]
    if (picked.label === "结束任务" || picked.grant === "stop-task") events.push({ type: "task-completed", detail: { stage: stageId, by: "user", form: "partial" } })
    if (fresh && picked.grant === "retire-and-recreate") {
      events.push({ type: "session-reset", detail: { role: fresh.role, package: fresh.package ?? null, scene: fresh.scene ?? stageId, reason: "用户选择作废当前波、重开会话（全新上下文）", decisionId: pending.decisionId, fromModelRef: fresh.fromModelRef, toModelRef: fresh.toModelRef } })
    }
    if (fresh && picked.grant === "rollback-model") {
      if (fresh.target === "package" && fresh.package != null) {
        // 包级模型变更：回滚 packages[package].model（roles 未被改动，不动角色配置）。
        const restored = (Array.isArray(task.packages) ? task.packages : []).map((pkg) => pkg.id === fresh.package ? { ...pkg, model: normalizeModelRef(fresh.fromModelRef, "requiresFreshSession.fromModelRef") } : pkg)
        await atomicJson(path.join(task.root, "packages.json"), { items: restored })
        events.push({ type: "re-planned", detail: { packages: restored.map((pkg) => pkg.id), source: "fresh-session-rollback", package: fresh.package, modelRef: fresh.fromModelRef, decisionId: pending.decisionId } })
      } else {
        await updateAgents(task, (agents) => {
          const roles = normalizeRoleEntries(agents.roles).roles
          agents.roles = { ...roles, [fresh.role]: normalizeModelRef(fresh.fromModelRef, "requiresFreshSession.fromModelRef") }
        })
        events.push({ type: "role-models-changed", detail: { changes: [{ role: fresh.role, from: fresh.toModelRef, to: fresh.fromModelRef, reason: "用户选择回滚 roles 到首派模型", decisionId: pending.decisionId }] } })
      }
    }
    // F9 四类恢复：异 digest 多报告 → 用户选择保留一版，其余波写 dispatch-superseded（未经评审的内容不得混入收敛基线）
    const migrate = pending.migrate
    if (migrate && Array.isArray(migrate.candidates)) {
      const pickedIdx = options.findIndex((o) => o.n === choice)
      const kept = migrate.candidates[pickedIdx]
      for (const cand of migrate.candidates) {
        if (!kept || cand.key === kept.key) continue
        events.push({ type: "dispatch-superseded", detail: { waveId: cand.waveId, reason: `迁移恢复：用户选择保留 ${kept.key} 的版本` } })
      }
    }
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

// F3 作废恢复边：tw retire（仅 Lead；命令面）。只增 dispatch-superseded {waveId, reason}（detail 不含 at，事件顶层已有 at）。
// 幂等矩阵：重复 retire 幂等返回；未知 waveId / 已结波 / 缺 reason 拒绝并附恢复指引（附当前未结波清单）。
// 已交付报告保留为审计事实、不参与推导（投影/快照/依赖/耗尽/回溯统一排除 superseded 波）；
// 清退该波映射（agents.json mappings 删除该波 key，审计记录保留在 journal）。
async function cmdRetire({ projectRoot, name, wave, reason }) {
  if (!wave || !/^wv\d+$/.test(wave)) throw fail("USAGE", "retire 需要 --wave <wvN>（当前未结波见 tw run / dispatch-plan 的 wait-inflight 卡）")
  if (!reason || !reason.trim()) throw fail("USAGE", "retire 需要 --reason <作废原因>（写入 dispatch-superseded 供审计与恢复指引）")
  const { workflow, policy } = await loadDefinitions(projectRoot)
  const task0 = await loadTask(projectRoot, name, { workflow, policy })
  return withOwnerLock(path.join(task0.root, "locks", "task.lock"), async () => {
    const task = await loadTask(projectRoot, name, { workflow, policy, repair: true })
    const groups = waveGroups(task.journal)
    const group = groups.find((g) => g.waveId === wave)
    const inflight = inflightBatch({ journal: task.journal, reports: task.reports })
    const openHint = inflight ? `当前未结波：${inflight.waveId ?? "无 waveId 的历史派发（" + inflight.open[0].key + "…）"}` : "当前无未结波"
    if (!group) throw fail("RETIRE_UNKNOWN_WAVE", `未知波 ${wave}（journal 中不存在该 waveId 的派发）。${openHint}`)
    if (task.journal.some((e) => e.type === "dispatch-superseded" && e.detail?.waveId === wave)) {
      return { ok: true, task: name, wave, idempotent: true, note: "该波此前已作废（幂等返回）" }
    }
    const settled = new Set(task.reports.map((r) => r.dispatchKey))
    if (group.keys.every((k) => settled.has(k))) {
      throw fail("RETIRE_SETTLED_WAVE", `波 ${wave} 已全部交付（已结波）。retire 仅解除未交付派发在途；已交付报告保留为审计事实。${openHint}`)
    }
    await appendEventsUnlocked(task, [{ type: "dispatch-superseded", detail: { waveId: wave, reason } }])
    // 清退该波映射：新 key 不再可被回溯/续派解析（agents.json 其余记录保留）
    const agentsFile = path.join(task.root, "agents.json")
    let agents = null
    let registryRebuilt = null
    try {
      agents = (await readJson(agentsFile, { allowMissing: true })) ?? {}
    } catch (error) {
      // 损坏账本不构成 retire 死门：retire 正是兜底恢复工具，不能被派生映射文件的损坏挡死。
      // 损坏内容读不出任何映射，重写为空账本（历史映射丢失的后果同 agent-map 重建：续派走 fresh 路径）。
      registryRebuilt = String(error?.message ?? error)
      agents = { mappings: {} }
    }
    if (agents.mappings) {
      let changed = false
      for (const k of group.keys) if (k in agents.mappings) { delete agents.mappings[k]; changed = true }
      if (changed || registryRebuilt) await atomicJson(agentsFile, agents)
    }
    const openCount = group.keys.filter((k) => !settled.has(k)).length
    return { ok: true, task: name, wave, supersededKeys: group.keys, ...(registryRebuilt ? { registryRebuilt } : {}), note: `波已作废（解除 ${openCount} 条未交付派发在途）${registryRebuilt ? '；agents.json 此前损坏已重建（历史映射丢失）' : ''}；重新 tw-dispatch / tw dispatch-plan 推进取新派单。` }
  })
}

// F9 既有任务迁移（追加式，B4）：为无 waveId 事实的既有派发追加 wave-assigned {waveId, dispatchKeys[], at} 映射事件，
// 不改写既有 journal 行与报告文件（与 journal 只增不改、报告不可变一致）；投影经 join 解析。
// 合并规则（B6/R10-T13）：以最近 stage-advanced 事件为界（不跨阶段并波），同 (kind, role, round) 且 package 互不相同的
// 合并为一个波；package 相同（同轮重复派发）各自成波；package=null 一律各自成波；按序赋 wv1…wvN（新号从 max(wvN) 接续）。
// 幂等：已赋号派发跳过，重跑不重复赋号；中断重跑等价（半迁移 journal 可续跑至完整）。
// 四类恢复（B6）：零报告/单报告按投影自然收敛；同 digest 多报告机械合并；不同 digest 多报告出用户选择卡保留一版、
// 其余写 dispatch-superseded（未经评审的内容不得混入收敛基线）。迁移输出「迁移前后投影对比」作为现场机械验收证据。
async function cmdMigrate({ projectRoot, name }) {
  const { workflow, policy } = await loadDefinitions(projectRoot)
  const task0 = await loadTask(projectRoot, name, { workflow, policy })
  return withOwnerLock(path.join(task0.root, "locks", "task.lock"), async () => {
    const task = await loadTask(projectRoot, name, { workflow, policy, repair: true })
    const before = Object.fromEntries([...projectRounds({ journal: task.journal, reports: task.reports }).entries()].map(([k, v]) => [String(k), v]))
    // 待决迁移冲突卡：先让用户 decide 保留版本（decide 写 dispatch-superseded 后再迁移）
    const settled = new Set(task.journal.filter((e) => e.type === "decided").map((e) => e.detail.decisionId))
    const pendingMigrate = task.journal.find((e) => e.type === "decision-issued" && e.detail?.migrate && !settled.has(e.detail.decisionId))
    if (pendingMigrate) {
      return { ok: true, task: name, status: "awaiting-user", next: "decide", decisionId: pendingMigrate.detail.decisionId, question: pendingMigrate.detail.reason, choices: pendingMigrate.detail.choices, note: "迁移冲突卡待决：decide 保留版本后再 tw migrate 完成剩余处理" }
    }
    // 1) 待赋号派发：无 waveId 事实（detail.waveId 与 wave-assigned join 均无）
    const assignedKeys = new Set(task.journal.filter((e) => e.type === "wave-assigned").flatMap((e) => e.detail?.dispatchKeys ?? []))
    const stageIdx = task.journal.map((e) => e.type).lastIndexOf("stage-advanced")
    const unassigned = []
    for (let i = Math.max(stageIdx, 0); i < task.journal.length; i += 1) {
      const e = task.journal[i]
      if (e.type !== "dispatched") continue
      if (e.detail?.waveId) continue
      if (assignedKeys.has(e.detail?.key)) continue
      unassigned.push(e)
    }
    // 2) 分组：同 (kind, role, round)；组内 package 互不相同合并一波、package 相同或 null 各自成波
    let maxWv = 0
    for (const e of task.journal) {
      const m = /^wv(\d+)$/.exec(e.detail?.waveId ?? "")
      if (m) maxWv = Math.max(maxWv, Number(m[1]))
    }
    const byGroup = new Map()
    for (const e of unassigned) {
      const k = `${e.detail.kind}\u0000${e.detail.role}\u0000${e.detail.round}`
      if (!byGroup.has(k)) byGroup.set(k, [])
      byGroup.get(k).push(e.detail)
    }
    // 分割顺序钉死（F9 边界）：组内按 journal 序——不同 package 并入当前波；package 相同（同轮重复派发）
    // 或 package=null 一律从重复处开新波，后续条目逐条独立成波；赋号顺序 = journal 序（wvN 递增）。
    const newWaves = []
    let num = maxWv
    for (const entries of byGroup.values()) {
      let current = null
      for (const d of entries) {
        if (!current || d.package == null || current.packages.has(d.package)) {
          num += 1
          current = { waveId: `wv${num}`, dispatchKeys: [d.key], packages: new Set(d.package == null ? [] : [d.package]) }
          newWaves.push(current)
        } else {
          current.dispatchKeys.push(d.key)
          current.packages.add(d.package)
        }
      }
    }
    if (newWaves.length) {
      await appendEventsUnlocked(task, newWaves.map((w) => ({ type: "wave-assigned", detail: { waveId: w.waveId, dispatchKeys: w.dispatchKeys } })))
    }
    // 3) 异 digest 冲突检测（独立于赋号循环：遍历迁移段全部分组逐组处理——多组冲突/重跑均不遗漏，B6 四类恢复完整）
    const afterTask = await loadTask(projectRoot, name, { workflow, policy, repair: true })
    const excluded = supersededKeys(afterTask.journal)
    const reportByKey = new Map(afterTask.reports.map((r) => [r.dispatchKey, r]))
    const digestSetOf = (key) => {
      const rid = `deliver-${key}`
      return (afterTask.artifacts?.items ?? []).filter((i) => i.reportRef === rid).map((i) => i.digest).sort()
    }
    // 迁移段内全部已赋号派发（经 waveId join）按 (kind, role, round, package) 四元组分组：
    // 同组重复派发成员 ≥2 且非 superseded 交付 ≥2 且制品 digest 组合互异 = 冲突组（每组一卡，逐组解决）
    const conflictGroups = new Map()
    for (let i = Math.max(stageIdx, 0); i < afterTask.journal.length; i += 1) {
      const e = afterTask.journal[i]
      if (e.type !== "dispatched") continue
      const wid = e.detail?.waveId ?? waveIdOf(afterTask.journal, e.detail?.key)
      if (!wid) continue
      const k = `${e.detail.kind}\u0000${e.detail.role}\u0000${e.detail.round}\u0000${e.detail.package ?? null}`
      if (!conflictGroups.has(k)) conflictGroups.set(k, [])
      conflictGroups.get(k).push(e.detail)
    }
    for (const ds of conflictGroups.values()) {
      if (ds.length < 2) continue
      const delivered = ds.filter((d) => reportByKey.has(d.key) && !excluded.has(d.key))
      if (delivered.length < 2) continue
      const sets = delivered.map((d) => ({ key: d.key, set: digestSetOf(d.key), waveId: waveIdOf(afterTask.journal, d.key) }))
      if (new Set(sets.map((s) => s.set.join("\u0000"))).size < 2) continue
      const decisionId = `migrate-${randomBytes(3).toString("hex")}`
      const question = `迁移恢复：同一逻辑波存在多个不同内容的交付版本（${sets.map((s) => s.key).join("、")}），请选择保留哪一版（其余版本作废）`
      const choices = sets.map((s, i) => ({ n: i + 1, label: `保留 ${s.key} 的版本`, desc: `digest ${s.set.join("、").slice(0, 48)}` }))
      await appendEventsUnlocked(task, [{ type: "decision-issued", detail: { decisionId, gateId: null, reason: question, choices, migrate: { candidates: sets.map((s) => ({ key: s.key, waveId: s.waveId })) } } }])
      return { ok: true, task: name, status: "awaiting-user", next: "decide", transition: "await-decision", decisionId, question, choices, note: "迁移赋号已完成（幂等）；解决冲突卡后再次 tw migrate 完成剩余处理" }
    }
    // 4) 完成：输出迁移前后投影对比（「迁移前后状态等价」验收证据）
    const after = Object.fromEntries([...projectRounds({ journal: afterTask.journal, reports: afterTask.reports }).entries()].map(([k, v]) => [String(k), v]))
    return { ok: true, task: name, assignedWaves: newWaves.map((w) => ({ waveId: w.waveId, dispatchKeys: w.dispatchKeys })), projectionBefore: before, projectionAfter: after, equivalent: JSON.stringify(before) === JSON.stringify(after), note: newWaves.length ? "迁移完成（追加 wave-assigned 事件，不改写历史行）；迁移前后投影对比见输出" : "无需迁移（无可赋号派发，幂等返回）" }
  })
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

// 意图修订（§3.5）：新增 rawRequirement/scope/acceptance/gaps 与 gap 答复；改值后确认指纹变化，
// 确认卡在下次 tw-dispatch / tw plan 时作废重签（这里只提示，不抢先签发第二张卡）。
async function cmdIntent({ projectRoot, name, objective, risk, rawRequirement, addConstraint = [], addExclusion = [], acceptance = [], scopeNotes = [], gaps = [], answerGap = null, answer = null }) {
  const { workflow, policy } = await loadDefinitions(projectRoot)
  const task = await loadTask(projectRoot, name, { workflow, policy })
  if (deriveTask(task).status === "completed") {
    return { ok: false, code: "TASK_COMPLETED", message: "任务已完成；目标变更请开新任务并引用归档名", fix: "tw open --name <new> --objective <...>" }
  }
  const file = path.join(task.root, "intent.json")
  return withOwnerLock(path.join(task.root, "locks", "task.lock"), async () => {
    const intent = JSON.parse(await readFile(file, "utf8"))
    const change = {}
    if (risk) {
      if (!['normal', 'high', 'critical'].includes(risk)) throw fail("USAGE", "--risk 只能是 normal | high | critical")
      intent.risk = risk
      change.risk = risk
    }
    if (objective) { intent.objective = objective; change.objective = objective }
    if (typeof rawRequirement === "string" && rawRequirement.trim()) { intent.rawRequirement = rawRequirement; change.rawRequirement = "更新（原文已保留）" }
    if (!Array.isArray(intent.constraints)) intent.constraints = []
    for (const c of addConstraint) if (!intent.constraints.includes(c)) intent.constraints.push(c)
    if (addConstraint.length) change.addConstraints = addConstraint
    if (!Array.isArray(intent.exclusions)) intent.exclusions = []
    for (const x of addExclusion) if (!intent.exclusions.includes(x)) intent.exclusions.push(x)
    if (addExclusion.length) change.addExclusions = addExclusion
    if (acceptance.length) {
      if (!Array.isArray(intent.acceptance)) intent.acceptance = []
      for (const a of acceptance) if (!intent.acceptance.includes(a)) intent.acceptance.push(a)
      change.acceptance = acceptance
    }
    if (scopeNotes.length) {
      const scope = intent.scope && typeof intent.scope === "object" && !Array.isArray(intent.scope) ? intent.scope : {}
      const notes = Array.isArray(scope.notes) ? scope.notes : []
      for (const noteText of scopeNotes) if (!notes.includes(noteText)) notes.push(noteText)
      intent.scope = { ...scope, notes }
      change.scope = { notes: scopeNotes }
    }
    if (gaps.length) {
      if (!Array.isArray(intent.gaps)) intent.gaps = []
      for (const gap of gaps) {
        if (!gap || typeof gap.question !== "string" || !gap.question.trim()) throw fail("USAGE", "--add-gap 需要 JSON 对象且 question 为非空字符串")
        intent.gaps.push({
          id: typeof gap.id === "string" && gap.id.trim() ? gap.id.trim() : "g" + (intent.gaps.length + 1),
          question: gap.question.trim(),
          whyItMatters: typeof gap.whyItMatters === "string" ? gap.whyItMatters : "",
          proposedDefault: typeof gap.proposedDefault === "string" ? gap.proposedDefault : "",
          answer: typeof gap.answer === "string" && gap.answer.trim() ? gap.answer : null,
        })
      }
      change.addGaps = gaps.length
    }
    if (answerGap) {
      if (!Array.isArray(intent.gaps)) intent.gaps = []
      const target = intent.gaps.find((gap) => gap.id === answerGap)
      if (!target) throw fail("USAGE", "未知 gap id：" + answerGap + "（可用 tw run / 确认卡查看现有 gap）")
      if (typeof answer !== "string" || !answer.trim()) throw fail("USAGE", "--answer-gap 需要 --answer <答复文本>")
      target.answer = answer.trim()
      change.answeredGaps = [answerGap]
    }
    intent.revisions = Array.isArray(intent.revisions) ? intent.revisions : []
    intent.revisions.push({ seq: intent.revisions.length + 1, at: new Date().toISOString(), change })
    await atomicJson(file, intent)
    const intakeIssued = task.journal.some((event) => event.type === "decision-issued" && event.detail?.gateId === INTAKE_GATE)
    // 已有确认卡且当前没有其他待决卡 → 直接重签（§3.4.4 触发源）；存在其他待决卡时不叠第二张卡，
    // 只标记 intakeRestaled，等下次派发时重签。
    const pending = pendingDecisionDetail(task.journal)
    const next = deriveTask(task).next
    // 重签条件：当前待决卡就是意图确认卡（改意图即重签），或没有待决卡且下一步就是派发。
    // 存在其他待决/未签的收敛问题（人工门/升级/僵局）时不抢先盖卡，只标记 intakeRestaled，等下次派发前重签。
    const canResignIntake = pending ? pending.gateId === INTAKE_GATE : next.kind === "dispatch"
    if (intakeIssued && canResignIntake) {
      // 用写盘后的最新 intent 重算指纹（task.intent 是进入命令时的快照，不能用于确认投影）。
      const updated = await loadTask(projectRoot, name, { workflow, policy, repair: true })
      const stateInfo = await intakeState(updated)
      const details = roleDetailsForCard(updated, stateInfo.roles, stateInfo.invalid)
      const card = await signIntakeApproval({ task: updated, workflow, roles: stateInfo.roles, details, profile: profileOf(updated), source: "role-registry" })
      return {
        ok: true, task: name, status: "awaiting-user", next: "decide", transition: "await-decision",
        ...card, roles: stateInfo.roles,
        objective: intent.objective, constraints: intent.constraints, exclusions: intent.exclusions,
        rawRequirement: intent.rawRequirement ?? "", scope: intent.scope ?? {}, acceptance: intent.acceptance ?? [], gaps: intent.gaps ?? [],
        intakeRestaled: true,
        note: "意图已更新；意图确认卡已按新意图重签（确认前不派发）",
      }
    }
    return {
      ok: true, task: name, objective: intent.objective, constraints: intent.constraints, exclusions: intent.exclusions,
      rawRequirement: intent.rawRequirement ?? "", scope: intent.scope ?? {}, acceptance: intent.acceptance ?? [], gaps: intent.gaps ?? [],
      ...(intakeIssued ? { intakeRestaled: true } : {}),
      note: "意图已更新；后续派单将使用新值" + (intakeIssued ? "；确认卡将在下次 tw-dispatch / tw plan 时作废旧卡并重签（确认前不派发）" : ""),
    }
  })
}

async function cmdGate({ projectRoot, name }) {
  const { workflow, policy } = await loadDefinitions(projectRoot)
  const task = await loadTask(projectRoot, name, { workflow, policy })
  const state = deriveTask(task)
  // 只读提示（§6 批 B）：意图确认状态与当前稳定投影是否一致（不签发、不写盘）。
  const intakeIssued = task.journal.some((event) => event.type === "decision-issued" && event.detail?.gateId === INTAKE_GATE)
  const stateInfo = await intakeState(task)
  const accepted = intakeConfirmation(task)
  const intake = {
    issued: intakeIssued,
    confirmed: Boolean(accepted && accepted.intakeFingerprint === stateInfo.fingerprint),
    ...(intakeIssued ? { fingerprint: stateInfo.fingerprint } : {}),
  }
  if (state.gate) return { ok: true, task: name, stage: state.stage, passed: state.gate.passed, blockers: state.gate.blockers, intake }
  const gate = gateCheck({ workflow, policy, stageId: state.stage, scope: task.scope, artifacts: task.artifacts, reports: task.reports.filter((r) => r.stage === state.stage), decisions: task.decisions, journal: task.journal, packages: Array.isArray(task.packages) && task.packages.length ? task.packages : null })
  return { ok: true, task: name, stage: state.stage, passed: gate.passed, blockers: gate.blockers, wave: state.wave, intake }
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
  return { ok: true, task: name, archivedTo: path.relative(projectRoot, dest), form, kept: ["manifest.json", "artifacts/", "reviews(在 manifest)", "decisions.json", "journal-summary.jsonl"], cleaned: ["reports/", "snapshots/", "runtime 状态"] }
}

// plan（v3.2/§3.3）：Lead 拆包登记 + 机械验收（P2 调用内一次查完）。
// 仅验机械属性（id 唯一/可写互斥/依赖无环/完成标准在场/路径合法/模型解析）；拆分语义质量归 Lead。
// 每包在落盘前一律物化为 model:ModelRef（显式 model / tier 语法糖 / 复用 roles.owner），不再持久化 tier。
async function cmdPlan({ projectRoot, name, packagesJson }) {
  const { workflow, policy } = await loadDefinitions(projectRoot)
  let items
  try {
    items = JSON.parse(packagesJson)
  } catch {
    throw fail('USAGE', '--packages 不是合法 JSON 数组')
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw fail('USAGE', '--packages 必须是非空 JSON 数组：[{id, model?:{provider,modelName,effort?}, tier?:junior|senior|expert, writable:["路径:kind"], done:["完成标准"], dependsOn:["包id"]}]')
  }
  const reasons = []
  const ids = new Set()
  const paths = []
  for (const p of items) {
    if (!p || typeof p.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(p.id)) { reasons.push('包 id 不合法：' + JSON.stringify(p?.id) + '（小写字母/数字/连字符）'); continue }
    if (ids.has(p.id)) reasons.push('包 id 重复：' + p.id)
    ids.add(p.id)
    if (!Array.isArray(p.writable) || p.writable.length === 0) reasons.push('包 ' + p.id + ' 缺 writable（["路径:产出物kind"]）')
    for (const w of p.writable ?? []) {
      const rel = String(w).split(':').slice(0, -1).join(':') || String(w)
      if (rel.startsWith('/') || rel.split('/').includes('..')) reasons.push('包 ' + p.id + ' 可写路径不合法：' + w + '（须为项目内相对路径）')
      paths.push({ path: rel, pkg: p.id })
    }
    if (!Array.isArray(p.done) || p.done.length === 0 || p.done.some((d) => typeof d !== 'string' || !d.trim())) reasons.push('包 ' + p.id + ' 缺完成标准 done（非空字符串数组）')
    if (p.model !== undefined && p.tier !== undefined) reasons.push('包 ' + p.id + ' 不能同时给 model 与 tier（model 是已解析实例，tier 只是入参语法糖）')
    if (p.tier !== undefined && !['junior', 'senior', 'expert'].includes(p.tier)) reasons.push('包 ' + p.id + ' tier 非法：' + JSON.stringify(p.tier) + '（可选 junior|senior|expert；缺省复制 roles.owner）')
    if (p.model !== undefined) {
      try { normalizeModelRef(p.model, '包 ' + p.id + ' 的 model') } catch (error) { reasons.push('包 ' + p.id + ' 的 model 不合法：' + String(error?.message ?? error)) }
    }
  }
  for (let i = 0; i < paths.length; i += 1) {
    for (let j = i + 1; j < paths.length; j += 1) {
      // 互斥判定 = 祖先路径组件语义（domain/writable.mjs，可写互斥是并行前提）：
      // 相同路径、或互为祖先组件（含尾斜杠目录条目与其下路径）均重叠——同一路径只一个 inode，
      // 同名文件/目录（docs 与 docs/）在文件系统互斥；兄弟前缀（docs/ 与 docs-x/）不重叠。
      if (writablePathsOverlap(paths[i].path, paths[j].path)) reasons.push('可写范围重叠：' + paths[i].pkg + ' 与 ' + paths[j].pkg + ' 都写 ' + paths[i].path + (paths[i].path !== paths[j].path ? ' 与 ' + paths[j].path : '') + '（相同路径或互为祖先目录才可写（一个 inode 原则）：docs 与 docs/、docs 与 docs/x 均冲突；兄弟前缀 docs/ 与 docs-x/ 不冲突）')
    }
  }
  for (const p of items) {
    for (const d of p.dependsOn ?? []) {
      if (!ids.has(d)) reasons.push('包 ' + p?.id + ' 依赖不存在的包：' + d)
    }
  }
  const graph = new Map(items.filter((p) => ids.has(p.id)).map((p) => [p.id, (p.dependsOn ?? []).filter((d) => ids.has(d))]))
  const visiting = new Set(), visited = new Set()
  const dfs = (id) => {
    if (visited.has(id)) return
    if (visiting.has(id)) { reasons.push('依赖成环：涉及包 ' + id); return }
    visiting.add(id)
    for (const d of graph.get(id) ?? []) dfs(d)
    visiting.delete(id); visited.add(id)
  }
  for (const id of graph.keys()) dfs(id)
  if (reasons.length) {
    const error = new Error('包定义未通过机械验收：' + String.fromCharCode(10) + '- ' + [...new Set(reasons)].join(String.fromCharCode(10) + '- '))
    error.code = 'PLAN_REJECTED'
    error.card = { ok: false, code: 'PLAN_REJECTED', message: error.message, fix: '修正 --packages 后重试；验收只保机械属性（互斥/无环/标准在场），拆分语义质量由 Lead 把关' }
    throw error
  }
  // 标签可读性软警告（非机械验收项，不拒绝）：DSH 子代理列表标签约 32 半角字符，
  // 阶段·角色@包 前置后包 id 超 12 字符会挤压简述空间
  const longIds = items.filter((p) => ids.has(p.id) && p.id.length > 12).map((p) => p.id)
  const tagWarn = longIds.length ? `包 id 过长（${longIds.join("、")}，>12 字符）：子代理标签中会挤压简述空间，建议短词（如 store/intake）` : null
  const task0 = await loadTask(projectRoot, name, { workflow, policy })
  return withOwnerLock(path.join(task0.root, 'locks', 'task.lock'), async () => {
    const task = await loadTask(projectRoot, name, { workflow, policy, repair: true })
    // 重拆窗口（F6）：待决卡片或在途派发时禁止重拆（与 intent 修订同款语义）。
    // 意图确认卡是例外（§3.4.3）：拆包会改变逐包模型，允许先 plan，随后自动重签确认卡。
    const state = deriveTask(task)
    const pendingIntake = state.status === 'awaiting-user' && state.next.pending?.gateId === INTAKE_GATE
    if (state.status === 'awaiting-user' && !Array.isArray(state.next.produceBlocked) && !pendingIntake) throw fail('PLAN_REJECTED', '当前有待决用户卡片（' + (state.next.reason ?? '人工门') + '），禁止重拆；decide 后再试')
    // F3：在途判定统一走 waves.inflightBatch（与 derive/重建/提示同源；superseded 波不在在途）
    const inflight = inflightBatch({ journal: task.journal, reports: task.reports })
    if (inflight) throw fail('PLAN_REJECTED', '存在在途派发（' + inflight.open.map((d) => d.key).join('、') + '），禁止重拆；等成员交付或补派完成后再试')
    // 模型解析（§3.3.1）：显式 model 直接采用；tier 从本次调用快照解析；都不给复制 roles.owner。
    // 任一包解析失败 → PLAN_MODEL_UNRESOLVED，不落半成品包（结构错误仍用 PLAN_REJECTED）。
    const rolesInfo = await ensureRolesInitialized({ task, workflow, policy })
    const resolvedTiers = await resolveTiers()
    const planned = []
    for (const p of items) {
      let modelRef = null
      let from = null
      if (p.model !== undefined) {
        modelRef = normalizeModelRef(p.model, '包 ' + p.id + ' 的 model')
        from = 'explicit'
      } else if (p.tier !== undefined) {
        const hint = computeModelHint(resolvedTiers.tiers[p.tier], [])
        modelRef = hint ? modelRefFromHint(hint) : null
        from = 'tier'
        if (!modelRef) throw fail('PLAN_MODEL_UNRESOLVED', '包 ' + p.id + ' 的 tier=' + p.tier + ' 在当前调用快照无法解析（tier 未配置或候选池为空）：补齐 team-work-dsh.tiers（tw models 查看）后重试，或直接给 model')
      } else {
        if (!rolesInfo.roles.owner) throw fail('PLAN_MODEL_UNRESOLVED', '包 ' + p.id + ' 未给 model/tier，且 agents.json.roles.owner 缺失：先 tw roles --resolve 初始化角色模型，或每包显式给 model')
        modelRef = normalizeModelRef(rolesInfo.roles.owner, 'roles.owner')
        from = 'roles.owner'
      }
      const { tier: _legacyTier, ...rest } = p
      planned.push({ ...rest, model: modelRef, modelSource: from })
    }
    const had = task.packages != null
    const persisted = planned.map(({ modelSource: _source, ...pkg }) => pkg)
    await atomicJson(path.join(task.root, 'packages.json'), { items: persisted })
    task.packages = persisted
    await appendEventsUnlocked(task, [{ type: had ? 're-planned' : 'packages-planned', detail: { packages: persisted.map((p) => p.id), models: planned.map((p) => ({ id: p.id, modelRef: p.model, from: p.modelSource })) } }])
    // 已有确认卡：包模型变化 → 作废旧卡并重签（§3.4.3/§3.4.4）。
    const intakeIssued = task.journal.some((event) => event.type === 'decision-issued' && event.detail?.gateId === INTAKE_GATE)
    if (intakeIssued) {
      const stateInfo = await intakeState(task)
      const details = roleDetailsForCard(task, stateInfo.roles, stateInfo.invalid)
      const card = await signIntakeApproval({ task, workflow, roles: stateInfo.roles, details, profile: profileOf(task), source: 'role-registry' })
      return { ok: true, task: name, packages: persisted.map((p) => ({ id: p.id, model: p.model, dependsOn: p.dependsOn ?? [] })), replanned: had, status: 'awaiting-user', next: 'decide', transition: 'await-decision', ...card, ...(tagWarn ? { warnings: [tagWarn] } : {}), note: '包定义与逐包模型已登记，意图确认卡已按新包模型重签：确认后推进（tw-dispatch / tw dispatch-plan）' }
    }
    return { ok: true, task: name, packages: persisted.map((p) => ({ id: p.id, model: p.model, dependsOn: p.dependsOn ?? [] })), replanned: had, next: 'dispatch', ...(tagWarn ? { warnings: [tagWarn] } : {}), note: had ? '包定义已更新（下一波生效）' : '包定义已登记；推进将按波组派发（tw-dispatch / tw dispatch-plan）' }
  })
}


// tw roles（§3.2/§3.1）：任务角色模型的唯一读写入口。
// 只读：三角色 ModelRef + effort 状态 + 档位溯源 + unresolved 清单；
// 写：--set <role>=<provider>/<modelName>[@<effort>] 或 <role>=tier:<档位>[@<effort>]、--clear <role>、--resolve。
// 写后若已签发过意图确认卡 → 作废旧卡并重签；已有会话的角色给出"不可热替换模型"警告（换模型卡在推进时签发）。
function parseRoleAssignment(spec) {
  if (typeof spec !== "string" || !spec.includes("=")) throw fail("USAGE", "--set 需要 <role>=<provider>/<modelName>[@<effort>] 或 <role>=tier:<junior|senior|expert>[@<effort>]")
  const index = spec.indexOf("=")
  const role = spec.slice(0, index)
  const value = spec.slice(index + 1)
  if (!ROLE_KEYS.includes(role)) throw fail("USAGE", "未知角色 " + JSON.stringify(role) + "：只允许 owner/challenger/expert")
  if (!value.trim()) throw fail("USAGE", "角色 " + role + " 的赋值不能为空")
  if (value.startsWith("tier:")) {
    const rest = value.slice("tier:".length)
    const at = rest.lastIndexOf("@")
    const tier = at >= 0 ? rest.slice(0, at) : rest
    const effort = at >= 0 ? rest.slice(at + 1) : undefined
    if (!TIERS.includes(tier)) throw fail("USAGE", "角色 " + role + " 的档位非法：" + JSON.stringify(tier) + "（junior|senior|expert）")
    if (at >= 0 && !effort.trim()) throw fail("MODEL_REF_INVALID", "角色 " + role + " 的 effort 不能为空字符串：不设置推理强度时省略 @ 部分")
    if (at >= 0 && effort.trim() === "none") throw fail("MODEL_REF_INVALID", '角色 ' + role + ' 的 effort 不能为 "none"：不设置推理强度时省略 @ 部分')
    return { role, tier, ...(at >= 0 ? { effort: effort.trim() } : {}) }
  }
  const at = value.lastIndexOf("@")
  const base = at >= 0 ? value.slice(0, at) : value
  const effort = at >= 0 ? value.slice(at + 1) : undefined
  const slash = base.indexOf("/")
  if (slash <= 0 || slash === base.length - 1) throw fail("USAGE", "角色 " + role + " 的模型写法应为 <provider>/<modelName>，例如 vendor/model（可选 @<effort>）")
  const ref = { provider: base.slice(0, slash), modelName: base.slice(slash + 1) }
  if (effort !== undefined) ref.effort = effort
  let modelRef
  try { modelRef = normalizeModelRef(ref, "角色 " + role) } catch (error) { throw fail("MODEL_REF_INVALID", String(error?.message ?? error)) }
  return { role, modelRef }
}

async function cmdRoles({ projectRoot, name, sets = [], clears = [], resolve = false }) {
  const { workflow, policy } = await loadDefinitions(projectRoot)
  const task = await loadTask(projectRoot, name, { workflow, policy })
  const registry = await readRegistry(task)
  const parsedSets = sets.map(parseRoleAssignment)
  if (!sets.length && !clears.length && !resolve) {
    if (registry.corrupt) throw fail("ROLES_CORRUPT", "agents.json 损坏，角色模型不可读：" + registry.corrupt)
    const normalized = normalizeRoleEntries(registry.roles)
    const resolved = await resolveTiers()
    const unresolved = ROLE_KEYS.filter((role) => !normalized.roles[role])
    const meta = roleMeta(task)
    return {
      ok: true, task: name, profile: profileOf(task),
      roles: normalized.roles,
      effortState: Object.fromEntries(ROLE_KEYS.map((role) => [role, normalized.roles[role] ? (normalized.roles[role].effort ? "configured" : "omitted") : "unresolved"])),
      tierProvenance: Object.fromEntries(ROLE_KEYS.map((role) => [role, meta.get(role)?.tierProvenance ?? null])),
      details: roleDetailsForCard(task, normalized.roles, normalized.invalid),
      unresolved,
      ...(normalized.invalid.length ? { warnings: normalized.invalid.map((entry) => "角色 " + (entry.role ?? "(未知)") + " 无效：" + entry.reason) } : {}),
      ...(resolved.warnings.length ? { configWarnings: resolved.warnings } : {}),
      history: task.journal.filter((event) => event.type === "role-models-changed").slice(-5).map((event) => ({ at: event.at, changes: event.detail?.changes ?? [] })),
      note: unresolved.length ? "存在 unresolved 角色：补齐 team-work-dsh.tiers 后 tw roles --resolve 重建；unresolved 时确认卡不提供“确认开始”" : "三角色模型已固化在 agents.json.roles；配置热变不会自动改（要改用 tw roles --resolve）",
    }
  }
  return withOwnerLock(path.join(task.root, "locks", "task.lock"), async () => {
    const locked = await loadTask(projectRoot, name, { workflow, policy, repair: true })
    const lockedRegistry = await readRegistry(locked)
    const roles = { ...normalizeRoleEntries(lockedRegistry.roles).roles }
    const resolvedTiers = await resolveTiers()
    const changes = []
    const warnings = []
    const state = deriveTask(locked)
    for (const entry of parsedSets) {
      let modelRef = entry.modelRef ?? null
      let tier = entry.tier ?? null
      let tierProvenance = null
      if (tier) {
        const hint = computeModelHint(resolvedTiers.tiers[tier], [])
        if (!hint) throw fail("ROLES_UNRESOLVED", "角色 " + entry.role + " 的档位 " + tier + " 在当前调用快照未解析：补齐 team-work-dsh.tiers（tw models 查看）后重试，或直接给 <provider>/<modelName>")
        modelRef = modelRefFromHint({ ...hint, ...(entry.effort ? { effort: entry.effort } : {}) })
        tierProvenance = "tw roles --set tier:" + tier + (entry.effort ? "@" + entry.effort : "")
      }
      if (!modelRef) throw fail("MODEL_REF_INVALID", "角色 " + entry.role + " 没有解析出模型实例")
      const from = roles[entry.role] ?? null
      roles[entry.role] = modelRef
      changes.push({ role: entry.role, from, to: modelRef, ...(tier ? { tier, tierProvenance } : {}) })
    }
    for (const role of clears) {
      if (!ROLE_KEYS.includes(role)) throw fail("USAGE", "未知角色 " + JSON.stringify(role) + "：只允许 owner/challenger/expert")
      const from = roles[role] ?? null
      delete roles[role]
      changes.push({ role, from, to: null, cleared: true })
    }
    if (resolve) {
      const resolvedRoles = await resolveRoleModels({ task: locked, workflow, policy })
      for (const role of ROLE_KEYS) {
        const from = roles[role] ?? null
        const to = resolvedRoles.roles[role] ?? null
        if (to) roles[role] = to
        else delete roles[role]
        changes.push({ role, from, to, tier: resolvedRoles.details.find((detail) => detail.role === role)?.tier ?? null, tierProvenance: resolvedRoles.details.find((detail) => detail.role === role)?.tierProvenance ?? null, resolved: true })
      }
    }
    // 已有会话的角色：提示不可热替换（换模型确认卡由下一轮 tw-dispatch 签发，避免一次动作叠两张卡）。
    for (const change of changes) {
      const session = latestSessionForRole(locked, lockedRegistry.mappings, change.role)
      if (session) warnings.push("角色 " + change.role + " 已有会话（" + session.sessionId + "）：会话模型不可热替换，下一轮续派（tw-dispatch）将出换模型确认卡")
    }
    await updateAgents(locked, (agents) => { agents.roles = roles })
    if (changes.length) await appendEventsUnlocked(locked, [{ type: "role-models-changed", detail: { changes, source: resolve ? "resolve" : "explicit" } }])
    locked.roles = roles
    const unresolved = ROLE_KEYS.filter((role) => !roles[role])
    // 写盘后重载：角色溯源（role-models-changed）与 agents.json.roles 都必须是新事实。
    const refreshed = await loadTask(projectRoot, name, { workflow, policy, repair: true })
    const intakeIssued = refreshed.journal.some((event) => event.type === "decision-issued" && event.detail?.gateId === INTAKE_GATE)
    // 同一时刻只允许一张未决卡（E2）：存在其他待决卡（人工门/收敛/迁移）时不抢先签意图确认卡，
    // 只标记 stale，等用户答完该卡后的下一次推进再重签，避免 choose 序号错位。
    const pending = pendingDecisionDetail(refreshed.journal)
    const canSignIntake = !pending || pending.gateId === INTAKE_GATE || Boolean(pending.requiresFreshSession)
    if (intakeIssued && canSignIntake) {
      const stateInfo = await intakeState(refreshed)
      const details = roleDetailsForCard(refreshed, stateInfo.roles, stateInfo.invalid)
      const card = await signIntakeApproval({ task: refreshed, workflow, roles: stateInfo.roles, details, profile: profileOf(refreshed), source: "role-registry" })
      return { ok: true, task: name, stage: state.stage, status: "awaiting-user", next: "decide", transition: "await-decision", ...card, roles, changes, unresolved, ...(warnings.length ? { warnings } : {}), note: "角色模型已更新，意图确认卡已重签（确认前不派发）" }
    }
    return { ok: true, task: name, roles, changes, unresolved, ...(warnings.length ? { warnings } : {}), ...(intakeIssued && pending ? { intakeRestaled: true } : {}), note: changes.length ? "角色模型已更新；后续派发直接使用 roles（不再查配置）" + (intakeIssued && pending ? "；当前有待决卡（" + String(pending.reason ?? "待用户决定") + "），处理后的下一次推进将重签意图确认卡" : "") : "无变化（幂等）" }
  })
}

// agent-map（v3.2/F5；定向委派第二阶段收敛为纯续派登记）：登记 dispatchKey → 平台 subagent id。
// 任务级注册表 task.root/agents.json 保存 mappings 与 roles——本命令只写 mappings；模型由 open/tw roles/plan
// 固化在 roles 与 packages，tw-dispatch 按 dispatch-plan 导出的 modelRef 创建；快照在 journal 的 dispatched 事实内。
// 续派波经 dispatch-plan 导出 expectedAgentId（同包同角色上一派发的映射）——Lead 据此 send_message 续原会话。
async function cmdAgentMap({ projectRoot, name, key, agent, modelHint }) {
  if (!key || !agent) throw fail('USAGE', 'agent-map 需要 --key <派单key> 与 --agent <平台subagentId>')
  const { workflow, policy } = await loadDefinitions(projectRoot)
  if (modelHint !== undefined) throw fail('USAGE', 'agent-map 不接受 --model-hint；模型在 open / tw roles / tw plan 时已固化为 ModelRef，tw-dispatch 按 dispatch-plan 的 modelRef 创建成员')
  const task0 = await loadTask(projectRoot, name, { workflow, policy })
  return withOwnerLock(path.join(task0.root, 'locks', 'task.lock'), async () => {
    const task = await loadTask(projectRoot, name, { workflow, policy, repair: true })
    const dispatch = task.journal.find((e) => e.type === 'dispatched' && e.detail.key === key)
    if (!dispatch) {
      throw fail('USAGE', 'key ' + key + ' 不是本任务的派单 key（从派单卡或 dispatch-plan 输出复制）')
    }
    // 任务级注册表：file=task.root/agents.json；task.lock 已持有（写 journal 同锁域）。
    // 只写 mappings（dispatchKey→childId 续派映射）；遗留旧键（tagHints/pendingTags/modelHints）不再写入。
    const file = path.join(task.root, 'agents.json')
    let current = null
    let registryRebuilt = null
    try {
      current = (await readJson(file, { allowMissing: true })) ?? {}
    } catch (error) {
      // 账本损坏自愈（I5 无死门）：本命令是 registeredUnresolved 降级卡指名的修复入口，
      // 若在这里被损坏挡死则该恢复边永远走不通（死门闭环）。损坏 JSON 读不出任何可保留映射，
      // 重建为空账本后历史映射丢失——受影响续派由 dispatch-plan 的 expectedAgentIdMissing
      // fresh 重建路径自动恢复（派单卡自带 resumeNote）。
      registryRebuilt = String(error?.message ?? error)
      current = { mappings: {} }
    }
    current.mappings = { ...(current.mappings ?? {}) }
    current.mappings[key] = agent
    await atomicJson(file, current)
    return {
      ok: true, task: name, key, agent,
      ...(registryRebuilt ? { registryRebuilt } : {}),
      note: '已登记派单映射（dispatchKey→childId，续派 send_message 用）；模型选择由 tw-dispatch 创建子代理时直接指定' +
        (registryRebuilt ? '；agents.json 此前损坏已重建（历史映射丢失，相关续派按 fresh 重建路径恢复）' : ''),
    }
  })
}

// dispatch-plan 人读输出（§7.2 终端推进通道；§7.5.5 范围 = waves + 全部 stop 卡）：
// 默认（无 --json）输出 plan.human 人读推进指引（终端 Lead 直接照此行动）；--json 供编排工具
// 消费结构化字段，两者并存互不影响。
function stopHumanLines(stop, card, extra = {}) {
  const lines = ['任务 ' + (card?.task ?? '') + ' · 阶段 ' + (card?.stage ?? '-') + ' · 状态：' + stop]
  const nl = String.fromCharCode(10)
  if (stop === 'awaiting-user') {
    if (card?.question) lines.push('待用户决定：' + card.question)
    for (const c of card?.choices ?? []) lines.push('  ' + c.n + '. ' + c.label + (c.desc ? '——' + c.desc : ''))
    if (card?.blocked) lines.push('blocked 包：' + (Array.isArray(card.blocked) ? card.blocked.map(String).join('、') : String(card.blocked)))
    if (card?.note) lines.push(card.note)
  } else if (stop === 'wait-inflight') {
    for (const d of extra.inflight ?? []) {
      const key = d.dispatchKey ?? d.key
      lines.push('- ' + key + '（' + d.role + ' 第 ' + d.round + ' 轮' + (d.package ? ' · 包 ' + d.package : '') + '）' + (d.registered === undefined ? ' · 登记状态未知（先核对再处置）' : d.registered ? ' · 已登记（等待交付）' : ' · 未登记（可补派' + (d.expectedAgentId ? '；续派走 send_message ' + d.expectedAgentId : '') + '）'))
    }
    if (card?.note) lines.push(card.note)
  } else if (stop === 'blocked') {
    for (const b of card?.blockers ?? []) {
      const message = typeof b === 'string' ? b : (b.message ?? '')
      const recovery = typeof b === 'string' ? '' : (b.recovery ?? '')
      lines.push('- ' + message + (recovery ? nl + '  恢复：' + recovery : ''))
    }
    if (card?.note) lines.push(card.note)
  } else {
    // completed / archived 等终态：note/question 即全部
    if (card?.note) lines.push(card.note)
    else if (card?.question) lines.push(card.question)
  }
  return lines
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
    // 旧未决升档卡收口（§3.3.3）：删除升档审批后，历史 escalation 卡必须幂等 superseded，否则永久静止。
    const lockedTask = await loadTask(projectRoot, name, { workflow, policy, repair: true })
    const settled = await settleLegacyEscalations(lockedTask)
    // E4：配置快照只服务派发计划展示（modelSettings/warnings）与旧 tier 物化，不在 stop 卡路径无条件读取；
    // 派发模型本身来自 roles/packages，不依赖本次调用快照。
    const warnings = []
    if (settled) warnings.push("已收口 " + settled + " 张历史升档审批卡（decided:superseded，升档审批机制已删除）")
    const planStop = (stop, card, extra = {}) => {
      const plan = { ok: true, task: name, stage: card.stage ?? null, stop, waves: [], card, ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}), ...extra }
      if (!json) plan.human = stopHumanLines(stop, card, extra)
      return plan
    }
    for (let hop = 0; hop <= workflow.stages.length + 2; hop += 1) {
      const task = await loadTask(projectRoot, name, { workflow, policy, repair: true })
      // 账本损坏降级（I5 无死门）：prepareDispatch 会按历史/策略重建 roles；续派映射丢失走 fresh 重建路径。
      const preRegistry = await readRegistry(task)
      if (preRegistry.corrupt) warnings.push("agents.json 损坏（" + preRegistry.corrupt + "）：已按角色迁移路径重建 roles；续派映射不可用，续派波按 fresh 重建路径恢复；可用 tw agent-map 重建登记")
      await ensureE2ePackages(task) // B：e2e 场景模板物化（幂等；advance 进入 e2e 后首轮生效）
      const state = deriveTask(task)
      // 派发链零配置反查（§3.8）：不在此解析 tiers；roles/packages 缺失由 runTransition 返回可恢复卡。
      const card = await runTransition({ projectRoot, name, writable, workflow, policy, task, state })
      if (card.transition === 'dispatch') {
        const list = card.dispatches ?? (card.dispatch ? [card.dispatch] : [])
        const resolved = await resolveTiers()
        warnings.push(...resolved.warnings)
        const registry = await readRegistry(task)
        if (registry.corrupt) {
          // 账本损坏降级推进（I5 无死门）：续派映射不可用时按 fresh 重建路径恢复（派单卡自带 resumeNote）。
          warnings.push('agents.json 损坏已降级（' + registry.corrupt + '）：续派映射不可用，续派波按 fresh 重建路径恢复；可用 tw roles --resolve / tw agent-map 重建登记')
        }
        const agentMaps = registry.mappings
        // F4 续派身份回溯：journal 倒序找同角色同包范围内最近一个有映射的派发 key
        // （限定细则、session-reset 边界与排除面见 continuationPrevKey 注释；与 wait-inflight 兜底重建共用同一实现）。
        const excludedKeys = supersededKeys(task.journal)
        const prevKeyOf = (d) => continuationPrevKey({ journal: task.journal, agentMaps, excludedKeys }, d)
        const waves = list.map((d) => {
          const deliver = d.kind === 'produce' || d.kind === 'respond' ? 'deliver' : 'review'
          const pkgDef = (task.packages ?? []).find((p) => p.id === d.package)
          const prevKey = d.continuation ? prevKeyOf(d) : null
          const sessionId = prevKey ? agentMaps[prevKey] : null
          const firstRef = (sessionId ? sessionFirstModelRef(task, agentMaps, d.role, d.package ?? null, sessionId) : null)
            ?? lastDispatchModelRefFor(task, d.role, d.package ?? null)
            ?? firstDispatchModelRef(task, d.role, d.package ?? null)
          const modelStaleForSession = Boolean(sessionId && d.continuation && firstRef && d.modelRef && !modelRefsEqual(firstRef, d.modelRef))
          const example = deliver === 'deliver'
            ? twCommand() + ' deliver --task ' + name + ' --key ' + d.key + ' --outcome delivered --summary <一句话> --paths <可写路径>'
            : twCommand() + ' review --task ' + name + ' --key ' + d.key + ' --recommendation <accept|rework|escalate> --summary <一句话>' + (d.kind === 'verdict' ? ' --verdict <JSON: outcome|rationale|confidence|recommendedAction>' : '')
          return {
            dispatchKey: d.key, ...(d.waveId ? { waveId: d.waveId } : {}), kind: d.kind, role: d.role, tier: d.tier, round: d.round,
            ...(d.package != null ? { package: d.package } : {}),
            continuation: Boolean(d.continuation),
            modelRef: d.modelRef,
            modelSource: d.modelSource ?? 'roles',
            ...(modelStaleForSession ? { modelStaleForSession: true } : {}),
            ...(d.continuation && prevKeyOf(d) && agentMaps[prevKeyOf(d)] ? { expectedAgentId: agentMaps[prevKeyOf(d)] } : {}),
            ...(d.continuation && !(prevKeyOf(d) && agentMaps[prevKeyOf(d)]) ? { expectedAgentIdMissing: true, resumeNote: '未找到可续会话映射（含 session-reset 边界后）：由 tw-dispatch 按本派单 modelRef 新建成员并登记；无宿主编排层须按精确模型创建后 tw agent-map --key <本key> --agent <新childId> 登记。复用原派单 key 时回填新 childId 覆盖旧映射' } : {}),
            ...(d.scope ? { scope: d.scope } : {}),
            ...(pkgDef ? { dependsOn: pkgDef.dependsOn ?? [] } : {}),
            prompt: d.prompt,
            ...(d.promptFull ? { promptFull: d.promptFull } : {}),
            deliver,
            weight: policy.costWeights?.[d.tier] ?? null,
            dispatchExample: example,
          }
        })
        const plan = {
          ok: true, task: name, stage: card.stage, stop: null,
          waves,
          card: { status: card.status, next: card.next },
          modelSettings: { source: resolved.source, entryId: resolved.entryId, profile: resolved.profile },
          ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}),
        }
        if (!json) {
          plan.human = ['任务 ' + name + ' · 阶段 ' + card.stage + ' · ' + waves.length + ' 个派单']
          plan.human.push('模型来源：任务 roles / 包级 model（配置快照 ' + resolved.entryId + ' · profile ' + resolved.profile + ' 只用于 open/roles --resolve 初始化）')
          for (const w of waves) {
            plan.human.push('-- ' + w.role + '(' + w.tier + ') ' + w.kind + ' 第 ' + w.round + ' 轮' + (w.package ? ' · 包 ' + w.package : '') + (w.continuation ? ' · 续派' : '') + String.fromCharCode(10) + '模型：' + describeModelRef(w.modelRef) + '（来源 ' + w.modelSource + '）' + String.fromCharCode(10) + '派单全文：' + String.fromCharCode(10) + w.prompt + (w.promptFull ? String.fromCharCode(10) + '断链重建/空壳补发用全量变体（原会话不可用时以此为准）：' + String.fromCharCode(10) + w.promptFull : '') + String.fromCharCode(10) + '交付示例：' + w.dispatchExample)
          }
          plan.human.push('派发后登记映射：tw agent-map --task ' + name + ' --key <派单key> --agent <childId>（DSH 内 tw-dispatch 会自动创建并登记，无需手工）')
        }
        return plan
      }

      if (card.transition === "advance") continue // stage-advanced 已写；锁内重推导下一阶段
      if (card.transition === "re-sign") continue // 旧升档卡已收口（decided:superseded）；锁内重推导
      if (card.transition === "complete") return planStop("completed", card)
      if (card.transition === "wait-inflight") return planStop("wait-inflight", card, { dispatchKey: card.dispatchKey, inflight: card.inflight ?? [] })
      if (card.transition === "await-decision" || card.transition === "await-route") return planStop("awaiting-user", card)
      return planStop("blocked", card)
    }
    throw fail("STATE_CORRUPT", "dispatch-plan 推进循环超界（阶段图可能成环）")
  })
}

// models（§1.3）：映射解析结果展示——每档 provider/model + 来源 + 警告。无状态、不派发。
async function cmdModels({ projectRoot }) {
  const resolved = await resolveTiers()
  return {
    ok: true,
    source: resolved.source,
    entryId: resolved.entryId,
    profile: resolved.profile,
    tiers: TIERS.map((t) => ({ tier: t, ...resolved.tiers[t] })),
    ...(resolved.warnings.length ? { warnings: resolved.warnings } : {}),
    note: '只读本次调用的 DSH 插件配置快照：entryId/profile 标明配置来源；无宿主终端由调用方通过 TW_DSH_CONFIG 提供快照。',
  }
}

// ---- tw init 的用户公共规则释放（方式 A 的同步半边，见方案第二节 4）----
// 出厂模板 = 包内 team-work/rules/；目标 = 用户公共规则目录（默认 ~/.team-work/rules，测试可传 userRulesRoot）。
// 逐文件判定用户是否改过：
//   目标缺失 → 直接写入新版默认；
//   与出厂新版逐字相同 → 无变化（只刷新摘要记录）；
//   与"上次释放的出厂摘要"相同（记录在 .tw-init-hashes.json）= 用户没改过 → 静默更新为新版默认；
//   其余（无记录或摘要不符）= 用户可能改过 → 保留用户版本，新版默认写同目录 <stem>.default.md 旁路供对照合并。
// 摘要记录始终更新为本次出厂版本：下一版仍能区分"用户改过"与"版本升级"。
// --force 不覆盖用户改过的规则文件——规则是用户数据，force 只用于重新装载技能目录；
// 装载器忽略 *.default.md 旁路（见 rules.mjs 的 BYPASS_SUFFIXES），旁路只在用户手工合并时有用。
// 测试进程（node --test 子进程带 NODE_TEST_CONTEXT）未显式传 userRulesRoot 时跳过写入，
// 避免套件里已有的 tw init 调用把开发机主目录当副作用；需要验证释放逻辑时显式传 userRulesRoot。
const RULES_TEMPLATE_SEGMENTS = ["team-work", "rules"]
const RULES_HASH_FILE = ".tw-init-hashes.json"
const RULES_BYPASS_SUFFIXES = [".default.md", ".new.md"]

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

// 出厂模板文件清单：递归收集 *.md（跳过旁路副本），相对路径统一用 "/" 分隔。
async function listTemplateFiles(dir, prefix = "") {
  const files = []
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const relative = prefix ? prefix + "/" + entry.name : entry.name
    if (entry.isDirectory()) files.push(...await listTemplateFiles(path.join(dir, entry.name), relative))
    else if (entry.isFile() && entry.name.endsWith(".md") && !RULES_BYPASS_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) files.push(relative)
  }
  return files
}

// 用户公共规则目录：显式参数优先；缺省为 ~/.team-work/rules；测试进程未显式指定时返回 null（跳过写入）。
function userRulesRootFor(explicit) {
  if (explicit !== undefined && explicit !== null && explicit !== "") return path.resolve(explicit)
  if (process.env.NODE_TEST_CONTEXT) return null
  return path.join(os.homedir(), ".team-work", "rules")
}

async function syncUserRules({ packageRoot, userRulesRoot }) {
  const sourceRoot = path.join(packageRoot, ...RULES_TEMPLATE_SEGMENTS)
  try {
    if (!(await lstat(sourceRoot)).isDirectory()) throw new Error("出厂模板须为目录")
  } catch (error) {
    return { action: "unavailable", source: sourceRoot, note: "出厂规则模板不可用（" + (error?.code ?? error?.message) + "）；跳过用户公共规则释放，技能装载不受影响" }
  }
  if (!userRulesRoot) {
    return { action: "skipped", source: sourceRoot, note: "测试进程（NODE_TEST_CONTEXT）默认不写用户主目录；需要验证规则释放时显式传 userRulesRoot" }
  }
  try {
    const files = await listTemplateFiles(sourceRoot)
    // 旧摘要记录：缺失 = 首次释放；损坏 = 无法判断"用户改过"，按与出厂逐字比对处理（保守方向不覆盖）
    const hashFile = path.join(userRulesRoot, RULES_HASH_FILE)
    let previous = {}
    let hashState = "ok"
    try {
      const parsed = JSON.parse(await readFile(hashFile, "utf8"))
      if (parsed && typeof parsed === "object" && parsed.files && typeof parsed.files === "object" && !Array.isArray(parsed.files)) previous = parsed.files
      else hashState = "invalid"
    } catch (error) {
      hashState = error?.code === "ENOENT" ? "missing" : "invalid"
    }
    await mkdir(userRulesRoot, { recursive: true })
    const next = {}
    const changes = []
    const summary = { installed: 0, updated: 0, kept: 0, unchanged: 0 }
    for (const relative of files) {
      const source = await readFile(path.join(sourceRoot, ...relative.split("/")), "utf8")
      next[relative] = sha256(source)
      const target = path.join(userRulesRoot, ...relative.split("/"))
      let current = null
      try {
        current = await readFile(target, "utf8")
      } catch (error) {
        if (error?.code !== "ENOENT") throw new Error("读取用户规则 " + target + " 失败：" + (error?.code ?? error?.message))
      }
      if (current === null) {
        await mkdir(path.dirname(target), { recursive: true })
        await atomicWrite(target, source)
        summary.installed += 1
        changes.push({ path: relative, action: "installed" })
        continue
      }
      if (current === source) {
        summary.unchanged += 1
        continue
      }
      if (previous[relative] === sha256(current)) {
        await atomicWrite(target, source)
        summary.updated += 1
        changes.push({ path: relative, action: "updated" })
        continue
      }
      const bypass = relative.replace(/\.md$/, ".default.md")
      const bypassPath = path.join(userRulesRoot, ...bypass.split("/"))
      await mkdir(path.dirname(bypassPath), { recursive: true })
      const existingBypass = await readFile(bypassPath, "utf8").catch(() => null)
      if (existingBypass !== source) await atomicWrite(bypassPath, source)
      summary.kept += 1
      changes.push({ path: relative, action: "kept", bypass })
    }
    await atomicWrite(hashFile, JSON.stringify({ version: 1, files: next }, null, 2) + "\n")
    return {
      action: "synced",
      root: userRulesRoot,
      summary,
      ...(changes.length ? { files: changes } : {}),
      ...(hashState === "invalid" ? { warning: hashFile + " 不可读或格式不符，已按「与出厂逐字比对」处理：内容与出厂相同的文件按未改过刷新，其余保留用户版本并写旁路" } : {}),
    }
  } catch (error) {
    return { action: "unavailable", root: userRulesRoot, note: "用户公共规则释放失败：" + (error?.code ?? error?.message) + "；技能装载不受影响，修复后原样重跑 init" }
  }
}

// init：装载三技能目录与公共单文件（逐项验证/暂存/替换，保留其他内容），并释放用户公共规则模板。
// 核心流程（安装 → open → run）不需要它。
async function cmdInit({ projectRoot, force = false, userRulesRoot } = {}) {
  const root = await realpath(projectRoot)
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const targets = [
    ["skill", "team-work-v3", true], ["writingSkill", "clarity-writing", true],
    ["reviewSkill", "clarity-review", true], ["outputStandard", "clarity-guidance/output-standard.md", false],
  ]
  const inside = (p) => p === root || p.startsWith(root + path.sep)
  const checkedTarget = async (dest) => {
    let current = root
    for (const part of path.relative(root, dest).split(path.sep)) {
      current = path.join(current, part)
      const info = await lstat(current).catch((error) => { if (error.code === "ENOENT") return null; throw error })
      if (info && !inside(await realpath(current))) throw new Error("目标或父路径经符号链接越出项目根：" + current)
    }
  }
  const result = { ok: true }
  const validated = new Map()
  const validateFile = (file, required = false) => {
    if (!validated.has(file)) validated.set(file, (async () => {
      try {
        if (!(await lstat(file)).isFile()) throw new Error("资源须为普通文件")
        const body = await readFile(file, "utf8")
        if (!body.trim()) throw new Error("资源正文为空")
        if (required) requiredClarityText(body)
        return body
      } catch (error) { throw new Error("资源 " + file + "：" + (error?.code ?? error?.message)) }
    })())
    return validated.get(file)
  }
  const publicSource = path.join(packageRoot, "skills/clarity-guidance/output-standard.md")
  for (const [key, relative, directory] of targets) {
    const src = path.join(packageRoot, "skills", relative)
    const dest = path.join(root, ".dsh", "skills", relative)
    const installedTo = path.relative(root, dest)
    let temporary = null
    let backup = null
    let published = false
    try {
      await checkedTarget(dest)
      const existing = await lstat(dest).catch((error) => { if (error.code === "ENOENT") return null; throw error })
      if (existing && !force) {
        result[key] = { installedTo, action: "skipped", note: "保留已有目标（不按 SKILL.md 是否存在判断）；--force 仅覆盖此目标，无法据存在性确认与根包同版" }
        continue
      }
      const sourceInfo = await lstat(src)
      if (directory ? !sourceInfo.isDirectory() : !sourceInfo.isFile()) throw new Error("源类型不符合目标")
      const files = [[directory ? path.join(src, "SKILL.md") : src, directory ? "SKILL.md" : "", !directory]]
      if (key === "reviewSkill") for (const reference of ["review-rules", "standalone-records", "examples"]) files.push([path.join(src, "references", reference + ".md"), "references/" + reference + ".md", reference === "review-rules"])
      if (key === "writingSkill" || key === "reviewSkill") files.push([publicSource, null, true])
      const contents = await Promise.all(files.map(([file, , required]) => validateFile(file, required)))
      await mkdir(path.dirname(dest), { recursive: true })
      await checkedTarget(dest)
      temporary = await mkdtemp(path.join(path.dirname(dest), ".tw-init-"))
      const staged = path.join(temporary, "content")
      await fsPromises.cp(src, staged, { recursive: directory })
      for (let index = 0; index < files.length; index += 1) {
        const [file, relative] = files[index]
        const copy = relative === null ? path.join(temporary, "public-dependency.md") : directory ? path.join(staged, relative) : staged
        if (relative === null) await fsPromises.cp(file, copy)
        try {
          if (!(await lstat(copy)).isFile() || await readFile(copy, "utf8") !== contents[index]) throw new Error("暂存副本与已验证源不一致")
        } catch (error) { throw new Error("暂存资源 " + file + "：" + (error?.code ?? error?.message)) }
      }
      if (existing) {
        const previous = path.join(temporary, "previous")
        await fsPromises.rename(dest, previous)
        backup = previous
      }
      try { await fsPromises.rename(staged, dest) } catch (error) {
        if (backup) { await fsPromises.rename(backup, dest); backup = null }
        throw error
      }
      published = true
      result[key] = { installedTo, action: existing ? "overwritten" : "installed" }
    } catch (error) {
      result[key] = { installedTo: null, target: installedTo, action: "unavailable", note: "装载失败；源：" + src + "；原因：" + (error?.code ?? error?.message) + "。核对完整根包资源和目标权限后重试" }
    } finally {
      // 回滚失败时保留备份供恢复，绝不把最后有效内容当临时垃圾清理。
      if (temporary && backup && !published) {
        result[key].note += "；回滚失败，原内容备份保留在 " + backup
      } else if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => {})
    }
  }
  const actions = targets.map(([key]) => result[key].action)
  result.note = "init 仅装载三个技能目录与公共规范单文件，不创建配置或任务事实；--force 仅覆盖这四个目标，其他文件保留。" +
    (actions.includes("unavailable") ? "存在部分失败，按逐项诊断恢复；不能声明完整同版。" : actions.includes("skipped") ? "含已有副本，版本混用待核；无法据存在性确认兼容。" : "四目标均来自当前根包；模型配置仍由 DSH 当前 profile 管理。")
  // 用户公共规则单独一项：失败不影响技能装载，也不并入上面的技能同版判断（两者是不同制品）。
  result.rules = await syncUserRules({ packageRoot, userRulesRoot: userRulesRootFor(userRulesRoot) })
  const rulesNote = result.rules.action === "synced"
    ? "用户公共规则已同步到 " + result.rules.root + "（新增 " + result.rules.summary.installed + "、更新 " + result.rules.summary.updated + "、保留用户修改 " + result.rules.summary.kept + "、未变 " + result.rules.summary.unchanged + "）"
    : "用户公共规则未释放（" + result.rules.action + "，见 rules 字段）"
  result.note = result.note.replace(/。$/, "；") + rulesNote + "。"
  return result
}

// help（P4：CLI 即接口，--help 与拒绝输出即完整 meta）
function helpCard() {
  return {
    ok: true,
    commands: {
      plan: "tw plan --task <n> --packages <JSON数组>：登记拆分并物化逐包 ModelRef（{id, model?} | {id, tier?} | {id}；机械验收：互斥/无环/完成标准；语义质量归 Lead）；已有意图确认卡会按新包模型重签",
      "agent-map": "tw agent-map --task <n> --key <派单key> --agent <平台subagentId>：登记派单→成员续派映射（tw-dispatch 按派单 modelRef 创建）",
      roles: "tw roles --task <n> [--set <role>=<provider>/<model>[@<effort>] | <role>=tier:<junior|senior|expert>[@<effort>]] [--clear <role>] [--resolve]：任务角色模型的唯一读写入口（agents.json.roles）",
      open: "tw open --name <n> --objective <o> [--entry <stage>] [--risk normal|high|critical] [--raw-requirement <原文>] [--constraint <文本>]... [--exclusion <文本>]... [--scope-note <文本>]... [--acceptance <文本>]... [--gap <JSON>]...：开任务并签发意图确认卡（intake-approval）",
      run: "tw run --task <n>：只读查状态（当前状态卡 + 下一步指引；不写任务事实。推进用 tw-dispatch / dispatch-plan）",
      "dispatch-plan": "tw dispatch-plan --task <n> [--json] [--writable <路径>:<kind> ...]：推进一步——推进到派发点或 stop 卡，输出波次计划（prompt + modelRef + modelSource）；路径以 / 结尾 = 目录授权；无 --json 输出人读 human 字段",
      decide: "tw decide --task <n> --choice <序号> [--note <...>]：回答当前卡片（意图确认卡 / 换模型卡 / 人工门 / 仲裁）",
      intent: "tw intent --task <n> [--objective <...>] [--raw-requirement <原文>] [--add-constraint <...>] [--add-exclusion <...>] [--acceptance <...>] [--scope-note <...>] [--add-gap <JSON>] [--answer-gap <id> --answer <文本>]：修订意图，改后确认卡重签",
      route: "tw route --task <n> --route spec|e2e --decision run|skip [--basis <依据>]：SPEC/E2E 显式路由",
      gate: "tw gate --task <n>：只读门禁检查（blockers + 修复建议）",
      models: "tw models：只读调用配置快照的 tier→模型解析结果与 entry/profile 来源",
      init: "tw init [--force]：装载 .dsh/skills/ 下 team-work-v3、clarity-writing、clarity-review 三目录及 clarity-guidance/output-standard.md 单文件（默认逐项保留，--force 只覆盖四目标，不清理其他文件），并把包内 team-work/rules/ 出厂模板增量释放到用户公共规则目录 ~/.team-work/rules/（缺失补齐；用户未改过的旧默认静默升版；用户改过的保留并写 <stem>.default.md 旁路，--force 也不覆盖用户修改）",
      restore: "tw restore --task <n> --path <路径>：从最后注册快照恢复产出物",
      retire: "tw retire --task <n> --wave <wvN> --reason <原因>：作废未结波（仅 Lead；解除在途，已交付报告保留审计）",
      migrate: "tw migrate --task <n>：既有任务波身份迁移（追加 wave-assigned 事件；异 digest 冲突出选择卡）",
      archive: "tw archive --task <n>：归档（用户确认后；归档目录只读）",
      deliver: "成员交卷：tw deliver --task <n> --key <k> --outcome delivered --summary <一句话> --paths <路径...> [--checks <JSON>] [--unresolved <JSON>]",
      review: "成员阅卷：tw review --task <n> --key <k> --recommendation accept|rework|escalate --summary <一句话> [--findings <JSON>] [--verdict <JSON>]",
    },
    notes: [
      "卡片即接口：按返回卡片行动，不预判步骤；拒绝输出自带修复指引",
      "模型数据链：默认档只来自 team-work/policies/default.json；tw open 把三角色解析成 ModelRef 存 agents.json.roles；tw plan 把每包解析成 packages.json[].model；派发直接读 pkg.model ?? roles[role]，不在派发期查配置",
      'ModelRef={provider, modelName, effort?, family?}：effort 只在配置了合法枚举时出现，不设置时省略字段（宿主实测 "" 与 "none" 均被拒绝）；宿主字段映射只在绑定层 toHostTarget 一处发生',
      '配置来源为当前 profile 的 team-work-dsh.tiers；宿主每次调用提供 TW_DSH_CONFIG JSON={tiers,entryId:"team-work-dsh",profile:<来源或 unresolved>} 快照。无宿主终端由调用方显式提供相同输入；缺失、损坏或缺档返回 unresolved，不读取旧配置文件或写缓存',
      "新任务首步会先出意图确认卡（原始需求/目标/约束/排除/范围/角色模型/逐包模型/gap）；确认前不派发。改意图、roles 或包模型后确认卡会失效重签；已有会话换模型会另出换模型确认卡（保留原会话 / 重开会话 / 回滚 roles）",
    ],
  }
}

async function twInner(argv, { projectRoot = process.cwd(), stdout = process.stdout, userRulesRoot } = {}) {
  const [cmd, ...rest] = argv
  const args = {}
  for (let i = 0; i < rest.length; i += 2) args[rest[i].replace(/^--/, "")] = rest[i + 1]
  const flag = (key) => argv.filter((a) => a === `--${key}`).length ? [argv[argv.indexOf(`--${key}`) + 1]] : []
  const common = { projectRoot }
  try {
    switch (cmd) {
      case "open": return await cmdOpen({
        ...common, name: args.name, objective: args.objective, entry: args.entry, risk: args.risk,
        rawRequirement: args["raw-requirement"],
        constraints: collectFlags(argv, "constraint"),
        exclusions: collectFlags(argv, "exclusion"),
        scopeNotes: collectFlags(argv, "scope-note"),
        acceptance: collectFlags(argv, "acceptance"),
        gaps: collectFlags(argv, "gap").map((value) => parseJsonArg(value, "--gap")),
      })
      case "roles": return await cmdRoles({ ...common, name: args.task, sets: collectFlags(argv, "set"), clears: collectFlags(argv, "clear"), resolve: argv.includes("--resolve") })
      case "run": {
        // run 只读化（§7.2）：--writable 是旧推进时代的参数，显式拒绝并指路 dispatch 通道（防旧习惯误用）
        const legacyWritable = collectWritable(argv)
        if (legacyWritable.length) {
          throw fail("USAGE", "run 已只读，不接受 --writable；扩权重派/推进请用 tw-dispatch（writables 参数）或 tw dispatch-plan --writable <路径>:<kind>")
        }
        return await cmdRun({ ...common, name: args.task, writable: [] })
      }
      case "decide": return await cmdDecide({ ...common, name: args.task, choice: Number(args.choice), note: args.note })
      case "intent": return await cmdIntent({
        ...common, name: args.task, objective: args.objective, risk: args.risk,
        rawRequirement: args["raw-requirement"],
        addConstraint: collectFlags(argv, "add-constraint"),
        addExclusion: collectFlags(argv, "add-exclusion"),
        acceptance: collectFlags(argv, "acceptance"),
        scopeNotes: collectFlags(argv, "scope-note"),
        gaps: collectFlags(argv, "add-gap").map((value) => parseJsonArg(value, "--add-gap")),
        answerGap: args["answer-gap"] ?? null,
        answer: args.answer ?? null,
      })
      case "route": return await cmdRoute({ ...common, name: args.task, route: args.route, decision: args.decision, basis: args.basis })
      case "restore": return await cmdRestore({ ...common, name: args.task, target: args.path })
      case "retire": return await cmdRetire({ ...common, name: args.task, wave: args.wave, reason: args.reason })
      case "migrate": return await cmdMigrate({ ...common, name: args.task })
      case "gate": return await cmdGate({ ...common, name: args.task })
      case "archive": return await cmdArchive({ ...common, name: args.task })
      case "plan": return await cmdPlan({ ...common, name: args.task, packagesJson: args.packages })
      case "agent-map": return await cmdAgentMap({ ...common, name: args.task, key: args.key, agent: args.agent, modelHint: args["model-hint"] })
      case "dispatch-plan": return await cmdDispatchPlan({ ...common, name: args.task, writable: collectWritable(argv), json: argv.includes("--json") })
      case "models": return await cmdModels(common)
      case "init": return await cmdInit({ ...common, force: argv.includes("--force"), userRulesRoot })
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
        throw fail("USAGE", "用法：tw help 查看全部命令（Lead：open/roles/plan/dispatch-plan/run 查状态/decide/intent/route/gate/models/init/restore/retire/migrate/archive；成员：deliver/review）")
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

// 唯一公共出口同时覆盖 JSON 与终端人读；只读投影不参与任务事实或收单判重。
// 成员侧只有业务正文一块：规则已全部进派单卡 prompt（锁定契约 + 可 DIY 三段），不再追加第二块投影。
// Lead 侧在本出口按呈现时点反吐 lead/<时点>/ 规则与明晰必读段（决定点加审阅段）。
export async function tw(argv, opts = {}) {
  let result = await twInner(argv, opts)
  if (!result || typeof result !== "object" || Array.isArray(result)) return result
  const projectRoot = opts.projectRoot ?? process.cwd()
  const readGuidance = createClarityGuidanceReader()
  if (result.card && typeof result.card === "object") {
    if (result.stop === null && result.waves?.length) {
      result.presentation = await presentationText({ kind: "dispatch", projectRoot, readGuidance })
    } else result.card = await attachPresentation(result.card, readGuidance, result.stop, false, projectRoot)
  } else result = await attachPresentation(result, readGuidance, null, argv[0] === "run", projectRoot)
  if (argv[0] === "dispatch-plan" && !argv.includes("--json")) {
    // 人读通道独立可用：业务正文在 waves/inflight 里原样给，规则只反吐给 Lead。
    if (!result.human) result.human = stopHumanLines(result.stop, result.card ?? result, result)
    const presentation = result.presentation ?? result.card?.presentation
    if (presentation) {
      const position = result.human.push(presentation) - 1
      const route = presentation.split("\n\n")[0] + "\n完整呈现规则见 human[" + position + "]。"
      if (result.presentation) result.presentation = route
      else result.card.presentation = route
    }
  }
  return result
}

export { cmdOpen, cmdRun, cmdDecide, cmdIntent, cmdGate, cmdArchive }
