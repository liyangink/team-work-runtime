// cli.mjs — tw CLI：v3 工具契约的参考实现（§4）
// 卡片输出为 JSON（Lead 在 DSH 里用 bash 调用并解析）；拒绝输出带修复指引（P2）。
import { randomBytes, createHash } from "node:crypto"
import { accessSync, constants } from "node:fs"
import { readFile, rm, mkdir, access, lstat, realpath, mkdtemp, readdir } from "node:fs/promises"
import fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { initTask, loadTask, taskExists, taskRoot, archiveRoot, controlRoot, atomicJson, atomicWrite, withOwnerLock, validName, readJson, rebuildArtifacts, dispatchLockPath, parseJournal } from "./store.mjs"
import { syncDirectory } from "./persistence/transactions.mjs"
import { deriveTask, currentStageOf, pendingDecisionsOf, duplicateIssuedIds, cardOf, INTAKE_GATE } from "./derive.mjs"
import { gateCheck, artifactsFingerprint, artifactFingerprints, reviewChainFingerprint, humanDecisionFresh, baselineCommitFloor } from "./gate.mjs"
import { scenePolicy, projectRounds, inflightBatch, supersededKeys, waveGroups, waveIdOf, deliverBaselines, reportOrderComparator, effectiveBlockedSet } from "./waves.mjs"
import { registerDelivery, registerReview, verifyArtifactBytes } from "./intake.mjs"
import { lockedWorkflowContract, resolveMemberRules, composeMemberRules, resolveLeadRules, resolveLeadGeneralRules, createClarityGuidanceReader, requiredClarityText } from "./rules.mjs"
import { TIERS, resolveTiers, computeModelHint, normalizeModelRef, modelRefFromHint, modelRefsEqual } from "./dsh-map.mjs"
import { digestValue, digestBytes, BYTES_DIGEST_ALGORITHM } from "./domain/digests.mjs"
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

// —— §5 强类型参数面：deliver/review/plan（及本方案新增命令）拒绝未知或重复的单值 flag ——
// 多值 flag（如 --paths）允许重复；单值 flag 重复会被静默覆盖，一律同步拒绝并给完整合法集。
const FLAG_SPECS = {
  deliver: { single: ["task", "key", "outcome", "summary", "checks", "unresolved"], multi: ["paths"] },
  review: { single: ["task", "key", "recommendation", "summary", "findings", "verdict"], multi: [] },
  plan: { single: ["task", "packages", "resolve-blocked", "blocked-ref"], multi: [] },
  "refresh-artifacts": { single: ["task", "package", "paths-json", "reason"], multi: [] },
  decide: { single: ["task", "choice", "note", "decision-id"], multi: [] },
  restore: { single: ["task", "path", "source"], multi: ["list"] },
}

function checkFlags(cmd, argv) {
  const spec = FLAG_SPECS[cmd]
  if (!spec) return
  const single = new Set(spec.single)
  const multi = new Set(spec.multi)
  const counts = new Map()
  for (const token of argv) {
    if (typeof token !== "string" || !token.startsWith("--") || token === "--") continue
    const name = token.slice(2)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  for (const [name, count] of counts) {
    if (!single.has(name) && !multi.has(name)) {
      throw fail("USAGE", `--${name} 不是 tw ${cmd} 的合法参数。允许：${[...single, ...multi].map((f) => "--" + f).join(" ")}（多值参数可重复）。运行 tw help 查看全部命令与示例。`)
    }
    if (single.has(name) && count > 1) {
      throw fail("USAGE", `--${name} 只能出现一次（本命令第 ${count} 次出现会被静默覆盖）。请合并为一次传入后重试。`)
    }
  }
}

async function cmdDeliver({ projectRoot, name, key, payload }) {
  const { workflow, policy } = await loadDefinitions(projectRoot)
  const task = await loadTask(projectRoot, name, { workflow, policy })
  return registerDelivery({ projectRoot, task, dispatchKey: key, payload })
}

async function cmdReview({ projectRoot, name, key, payload }) {
  const { workflow, policy } = await loadDefinitions(projectRoot)
  // 返工包名只在评审锁内读取计划，锁外读取不能作为校验依据。
  const task = await loadTask(projectRoot, name, { workflow, policy, ignorePackages: true })
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
    DECISION_STALE: "答复对应的卡已失效或身份不明；请完整查看最新确认卡并明确选择，使用实际展示且被答复的卡片 ID；不能确定时先请用户澄清",
    ENTRY_UNKNOWN: "--entry 必须是 workflow 声明的阶段之一",
    DISPATCH_INPUT_REQUIRED: "Owner 波次派发需要 --writable <path>:<kind>（可多次；路径以 / 结尾 = 目录授权，如 docs/:doc）",
    MAP_INVALID: "在 DSH 当前 profile 的插件配置页补齐 team-work-dsh.tiers 的 junior/senior/expert；每档提供非空 provider/model。无宿主终端由调用方通过 TW_DSH_CONFIG 提供配置快照",
    STATE_CORRUPT: "保留原任务目录及日志，先核对损坏位置和备份；证据不足时不要猜测重建或推进",
    EIO: "读取或写入发生 I/O 错误：保留原文件，检查存储后核对事实再重试",
    EACCES: "文件访问被拒绝：保留原文件，核对读取权限后再重试",
    EPERM: "文件操作被拒绝：保留原文件，核对权限后再重试",
    ENOENT: "所需文件不存在：保留原任务并核对文件和备份，不把缺失日志当空记录",
    ARCHIVE_ORDER_UNVERIFIED: "保留原任务，核对并恢复相关报告版本的日志提交序；证据不足时不要猜测最新版本",
    RETIRE_UNKNOWN_WAVE: "tw run 或 dispatch-plan 的 wait-inflight 卡片输出当前波 waveId；请核对后重试",
    RETIRE_SETTLED_WAVE: "该波已全部交付（已结波），无需作废；要解除未交付在途请核对 waveId（run 卡片列出当前未结波）",
    LOCK_UNAVAILABLE: "任务锁被并发写者占用（成员交付/Lead 推进同时进行）：等几秒原样重试同一命令即可；崩溃进程的锁会被自动回收",
    LOCK_CORRUPT: "任务锁读取异常：崩溃残留的损坏锁会在约 10 秒后自动回收；持续失败且确认无并发写者时，可手动删除任务目录 locks/task.lock",
    TASK_INIT_INCOMPLETE: "先核实原创建调用已结束；若初始化中断请保留原目录，换新名字重新提供原文和计划",
    INTAKE_RAW_REQUIRED: "用 tw intent --raw-requirement 补充完整用户原文后重新推进；无法确定原文时先询问用户",
    INTAKE_UNCONFIRMED: "意图确认未完成：调 tw-dispatch（或 tw dispatch-plan）重签确认卡，携带展示的卡片 ID decide 确认后再派发",
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
// + （core 场景）Expert 裁决。多包按包归组（reports 按 journal 提交序排列，后写覆盖即最新）。
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
async function appendEventsUnlocked(task, events, beforeAppend = null) {
  const file = path.join(task.root, "journal.jsonl")
  const journal = await readFile(file, "utf8")
  let seq = parseJournal(journal).length
  const lines = events.map((e) => JSON.stringify({ seq: ++seq, at: new Date().toISOString(), ...e }))
  // 普通决定仍使用既有 decisions.json：先完成日志读取，避免读错后留下已生效的决定视图。
  if (beforeAppend) await beforeAppend()
  const separator = journal.endsWith("\n") ? "" : "\n"
  await atomicWrite(file, journal + separator + lines.map((l) => `${l}\n`).join(""))
  return seq
}

async function appendEvents(task, events) {
  return withOwnerLock(path.join(task.root, "locks", "task.lock"), () => appendEventsUnlocked(task, events))
}

// 返工/回应语境：结构化意见按评审覆盖范围投影，旧报告仍按 package 归属兼容。
function reworkContext(task, stageId, pkg = null) {
  const stageReports = task.reports.filter((r) => r.stage === stageId)
  const latest = (role) => stageReports.filter((r) => r.role === role).at(-1)
  const challenger = latest('challenger')
  const expert = latest('expert')
  const humanRework = task.decisions.filter((d) => d.choice === 'rework').at(-1)
  const forPkg = (review) => (review?.payload?.findings ?? []).filter((f) => {
    if (f.scope?.kind === 'packages' && Array.isArray(f.scope.ids)) return f.scope.ids.includes(pkg)
    if (f.scope?.kind === 'all-covered') {
      // 已有覆盖快照时，整组指当次被审包而非将来新加入的包；旧报告缺快照则保留原兼容口径。
      return !Array.isArray(review.reviewedPackages) || review.reviewedPackages.some((p) => (p && typeof p === 'object' ? p.package ?? null : p ?? null) === pkg)
    }
    return pkg == null || f.package == null || f.package === pkg
  })
  const renderFindings = (findings) => findings.map((f) => {
    const scope = f.scope?.kind === 'packages' && Array.isArray(f.scope.ids) ? '（包 ' + f.scope.ids.join('、') + '）'
      : f.scope?.kind === 'all-covered' ? '（全部已评审包）' : f.package ? '（包 ' + f.package + '）' : ''
    return '- [' + f.severity + (f.disposition ? '/' + f.disposition : '') + ']' + scope + ' ' + f.statement
  }).join('\n')
  const sections = []
  if (challenger?.payload?.recommendation === 'rework' || challenger?.payload?.findings?.length) {
    const findings = renderFindings(forPkg(challenger))
    sections.push('### Challenger 意见（' + challenger.payload.recommendation + '）\n' + challenger.payload.summary + (findings ? '\n' + findings : ''))
  }
  if (expert?.payload?.verdict) {
    const v = expert.payload.verdict
    const findings = v.outcome === 'rework' ? renderFindings(forPkg(expert).filter((f) => f.disposition === 'must-fix')) : ''
    sections.push('### Expert 裁决（' + v.outcome + '）\n' + v.rationale + '\n建议：' + v.recommendedAction + (findings ? '\n' + findings : ''))
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

// 按 journal 提交序比较报告新旧：统一用 waves.reportOrderComparator（§2.2 单一口径，含 report-committed）。

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
    if (!prev || later(r, prev) > 0) owners.set(key, r)
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
      if (!challenger || later(r, challenger) > 0) challenger = r
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

// Windows 用两种分隔符都能指向同一文件；比较时统一，卡面及持久化声明仍保留用户原文。
function comparableWritablePath(rel) {
  return path.sep === "\\" ? rel.replaceAll("\\", "/") : rel
}

// 与派单解析使用同一分隔方式；缺分隔符时不能让卡面和实际派单的路径错位。
function validWritableSpec(entry) {
  if (typeof entry !== "string") return false
  const sep = entry.lastIndexOf(":")
  if (sep <= 0 || sep === entry.length - 1) return false
  const { path: rel, artifactKind } = parseWritableEntry(entry)
  if (!rel.trim() || rel.trim() !== rel || !artifactKind.trim() || artifactKind.trim() !== artifactKind || path.isAbsolute(rel)) return false
  // Windows 的 C:foo 不是绝对路径，却依赖该盘的当前目录；不能保证仍在项目根内。
  if (path.sep === "\\" && path.win32.parse(rel).root) return false
  // 交付校验同样按两种分隔符检查，阻止反斜杠和混合分隔符中的穿越。
  const segments = rel.split(/[\\/]/)
  return segments.every((part, index) => part !== "." && part !== ".." && (part !== "" || index === segments.length - 1))
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

// 从被作废的 Owner 派单投影仍需宿主核验的写者，不把退役、交付或映射存在等同于已停写。
function writerSafetyOf(task, registry, targetWritable = null, restrictKeys = null) {
  const retired = restrictKeys ?? supersededKeys(task.journal)
  const pathsOf = (entries) => {
    if (!Array.isArray(entries)) return null
    const paths = entries.map((entry) => typeof entry === "string" ? (validWritableSpec(entry) ? parseWritableEntry(entry).path : null) : entry?.path)
    return paths.every((p) => typeof p === "string" && validWritableSpec(p + ":kind")) ? paths.map(comparableWritablePath) : null
  }
  const target = targetWritable === null ? null : pathsOf(targetWritable)
  const conflicts = []
  for (const event of task.journal) {
    const d = event.detail
    if (event.type !== "dispatched" || d?.role !== "owner" || !retired.has(d.key)) continue
    const previous = pathsOf(d.writable)
    if (previous?.length === 0 || target?.length === 0) continue
    const overlaps = previous && target ? previous.flatMap((oldPath) => target.filter((newPath) => writablePathsOverlap(oldPath, newPath)).map((newPath) => ({ previous: oldPath, current: newPath }))) : []
    if (previous && target && overlaps.length === 0) continue
    const mapped = registry?.mappings?.[d.key]
    const sessionId = typeof mapped === "string" && mapped ? mapped : null
    conflicts.push({ waveId: d.waveId ?? waveIdOf(task.journal, d.key), dispatchKey: d.key, sessionId, mappingStatus: registry?.corrupt ? "unavailable" : sessionId ? "registered" : "unresolved", writable: d.writable ?? null, overlaps })
  }
  return { status: conflicts.length ? "unknown" : "not-required", required: conflicts.length > 0, conflicts, ...(conflicts.length ? { recovery: "逐一核实旧写者已停止或写权限已撤销；无法证明时保留原会话与文件、不得自动派发重叠范围，请人工核对。" } : {}) }
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
  // 已有派单时 agents.json 缺失或损坏均为未知：registered 不落假值，由宿主保留 ID 并核对。
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
    // §4.1 冻结正文优先：journal 有该 key 的冻结派单正文时，在途重建直接采用冻结版本，
    // 不按当前任务/规则状态重新渲染（规则热更或渲染逻辑升级不得改变已发出派单的口径）。
    const hasFrozen = typeof d.prompt === "string" && Boolean(d.prompt)
    if (hasFrozen) {
      card.prompt = d.prompt
      if (typeof d.promptFull === "string" && d.promptFull) card.promptFull = d.promptFull
      else delete card.promptFull
    }
    // 正文从 journal 恢复；已记录摘要原样导出供宿主比较，缺摘要或旧派单不冒充可验证的冻结事实。
    const hasDigest = typeof d.promptDigest === "string" && /^[a-f0-9]{64}$/.test(d.promptDigest)
    const expectsFull = Boolean(d.continuation || d.promptFull)
    const hasFullDigest = !expectsFull || (typeof d.promptFull === "string" && d.promptFull && typeof d.promptFullDigest === "string" && /^[a-f0-9]{64}$/.test(d.promptFullDigest))
    card.promptFrozen = Boolean(hasFrozen && hasDigest && hasFullDigest)
    card.promptDigest = hasFrozen && hasDigest ? d.promptDigest : sha256(card.prompt)
    if (card.promptFull) card.promptFullDigest = hasFrozen && typeof d.promptFullDigest === "string" ? d.promptFullDigest : sha256(card.promptFull)
    if (d.role === "owner") {
      const safety = writerSafetyOf(task, registry, d.writable)
      if (safety.required) card.writerSafety = safety
    }
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

// 既有派单的映射缺失、结构损坏或非 JSON 均为未知，不能以空映射冒充可靠未登记。
async function readRegistry(task) {
  try {
    const stored = await readJson(path.join(task.root, 'agents.json'), { allowMissing: true })
    const dispatched = task.journal.some((event) => event.type === 'dispatched')
    if (!stored && dispatched) throw new Error('已有派单但 agents.json 缺失')
    const agents = stored ?? {}
    if (typeof agents !== 'object' || Array.isArray(agents)) throw new Error('agents.json 须为对象')
    if (agents.mappings === undefined && dispatched) throw new Error('已有派单但 mappings 缺失')
    const mappings = agents.mappings ?? {}
    if (typeof mappings !== 'object' || Array.isArray(mappings) || Object.values(mappings).some((id) => typeof id !== 'string' || !id.trim() || id !== id.trim())) throw new Error('mappings 须为非空会话 ID 的对象')
    return { mappings, roles: agents.roles ?? null, agents, corrupt: null }
  } catch (error) {
    return { mappings: {}, roles: null, agents: null, corrupt: String(error?.message ?? error) }
  }
}

async function updateAgents(task, mutate) {
  const registry = await readRegistry(task)
  if (registry.corrupt) throw fail('AGENTS_STATE_CORRUPT', '成员映射账本不可验证：' + registry.corrupt + '；保留原文件和 sessionId，核对恢复后重试。')
  const next = { ...registry.agents, mappings: { ...registry.mappings } }
  await mutate(next)
  await atomicJson(path.join(task.root, 'agents.json'), next)
  return { agents: next, rebuilt: null }
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
// 旧卡沿用原投影；新版加入实际入口与首派范围，不含时间戳、decisionId 或 profile。
function intakeSnapshot({ task, roles, packages }) {
  const intent = task.intent ?? {}
  const scope = intent.scope && typeof intent.scope === "object" && !Array.isArray(intent.scope) ? intent.scope : {}
  return {
    ...(task.scope?.intakeVersion === 2 ? {
      scope: {
        entry: task.scope.entry,
        completion: task.scope.completion,
        outputs: (task.workflow?.stages?.find((stage) => stage.id === task.scope.entry)?.outputs ?? []).map(String),
      },
      ...(!(Array.isArray(packages) && packages.length) ? { firstWritable: task.scope.firstWritable ?? null } : {}),
    } : {}),
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

// 候选计划的意图确认只授权其恢复卡；只有计划事实真正提交后才成为当前任务意图。
function effectiveIntakeIssued(task, detail) {
  const auth = detail?.recoveryAuthorization
  if (!auth) return true
  const accepted = acceptedIntakeFor(task, detail)
  if (!accepted) return false
  let settledIndex = -1
  for (let i = 0; i < task.journal.length; i += 1) if (task.journal[i].type === "decided" && task.journal[i].detail?.decisionId === detail.decisionId) settledIndex = i
  return settledIndex >= 0 && task.journal.some((event, index) => index > settledIndex && event.type === "re-planned" && event.detail?.decisionId === auth.decisionId && Array.isArray(event.detail?.items) && digestValue(event.detail.items) === auth.planDigest)
}

function acceptedIntakeFor(task, issued) {
  if (!issued?.decisionId) return null
  const accepted = [...(task.decisions ?? [])].reverse().find((d) => d.decisionId === issued.decisionId && d.gateId === INTAKE_GATE && d.grant === "accept-intake")
  const settled = task.journal.filter((event) => event.type === "decided" && event.detail?.decisionId === issued.decisionId).at(-1)?.detail
  if (!accepted || settled?.choice !== accepted.choice || (task.scope?.intakeVersion === 2 && (accepted.intakeVersion !== 2 || issued.intakeFingerprint !== accepted.intakeFingerprint))) return null
  return accepted
}

function intakeConfirmation(task) {
  const issued = task.journal.filter((event) => event.type === "decision-issued" && event.detail?.gateId === INTAKE_GATE && effectiveIntakeIssued(task, event.detail)).at(-1)?.detail
  return acceptedIntakeFor(task, issued)
}

function checkIntakeVersion(task) {
  const cards = task.journal.filter((event) => event.type === "decision-issued" && event.detail?.gateId === INTAKE_GATE).map((event) => event.detail)
  const decisions = (task.decisions ?? []).filter((decision) => decision.gateId === INTAKE_GATE)
  const v2 = task.scope?.intakeVersion === 2
  if ((v2 && (cards.some((card) => card.intakeVersion !== 2) || decisions.some((decision) => decision.intakeVersion !== 2))) ||
      (!v2 && (cards.some((card) => card.intakeVersion === 2) || decisions.some((decision) => decision.intakeVersion === 2)))) {
    throw fail("STATE_CORRUPT", "任务范围、意图卡或决定的版本标识缺失或不一致；请核对并恢复事实，不能按旧卡处理。")
  }
}

function checkIntakeFacts(task) {
  checkIntakeVersion(task)
  if (task.scope?.intakeVersion !== 2) return
  const intent = task.intent
  const stage = task.workflow?.stages?.find((entry) => entry.id === task.scope.entry)
  const validStrings = (value) => Array.isArray(value) && value.every((item) => typeof item === "string")
  if (!intent || typeof intent !== "object" || Array.isArray(intent) || typeof intent.objective !== "string" || typeof intent.rawRequirement !== "string" ||
      !validStrings(intent.constraints) || !validStrings(intent.exclusions) || !validStrings(intent.acceptance) ||
      !Array.isArray(intent.gaps) || intent.gaps.some((gap) => !gap || typeof gap !== "object" || Array.isArray(gap)) ||
      !intent.scope || typeof intent.scope !== "object" || Array.isArray(intent.scope) || !stage ||
      !task.scope.completion || typeof task.scope.completion !== "object" || Array.isArray(task.scope.completion) ||
      (stage.outputs !== undefined && !validStrings(stage.outputs))) {
    throw fail("STATE_CORRUPT", "任务意图、范围或入口阶段的事实损坏；请检查并恢复后再确认。")
  }
  if (task.packages !== null) {
    if (!Array.isArray(task.packages)) throw fail("STATE_CORRUPT", "包计划损坏；请检查并恢复计划。")
    const ids = new Set()
    const writables = []
    for (const pkg of task.packages) {
      if (!pkg || typeof pkg.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(pkg.id) || ids.has(pkg.id) ||
          !validStrings(pkg.writable) || !pkg.writable.length || !pkg.writable.every(validWritableSpec) || !validStrings(pkg.done) || !pkg.done.length || pkg.done.some((item) => !item.trim()) ||
          (pkg.dependsOn !== undefined && !validStrings(pkg.dependsOn))) {
        throw fail("STATE_CORRUPT", "包计划不完整或损坏；请检查并重新登记完整计划。")
      }
      ids.add(pkg.id)
      // 旧版 Windows 曾接受分隔符别名重叠；在确认或派发前重验这些已有计划。
      if (path.sep === "\\") {
        for (const declaration of pkg.writable) {
          const rel = parseWritableEntry(declaration).path
          const comparable = comparableWritablePath(rel)
          const overlap = writables.find((item) => writablePathsOverlap(item.comparable, comparable))
          if (overlap) throw fail("STATE_CORRUPT", "包计划可写范围重叠：" + overlap.pkg + " 的 " + overlap.rel + " 与 " + pkg.id + " 的 " + rel + "；如有在途波请先完成或作废，再用 tw plan 修正互斥范围并重新确认。")
          writables.push({ pkg: pkg.id, rel, comparable })
        }
      }
    }
  }
}
function assertCompleteIntake(task, roles) {
  if (task.scope?.intakeVersion !== 2) return
  checkIntakeFacts(task)
  if (typeof task.intent?.rawRequirement !== "string" || !task.intent.rawRequirement.trim()) throw fail("INTAKE_RAW_REQUIRED", "签发确认卡前须提供完整用户原始需求。")
  if (!task.scope?.entry || !task.scope?.completion || !task.workflow?.stages?.some((stage) => stage.id === task.scope.entry)) throw fail("STATE_CORRUPT", "任务范围或入口阶段损坏，请检查并恢复。")
  const unresolved = ROLE_KEYS.filter((role) => !roles[role])
  if (unresolved.length) throw fail("INTAKE_ROLES_UNRESOLVED", "角色模型未解析：" + unresolved.join("、"))
  if (Array.isArray(task.packages) && task.packages.length) {
    for (const pkg of task.packages) {
      if (!pkg || typeof pkg.id !== "string" || !pkg.id || !pkg.model || !Array.isArray(pkg.writable) || !pkg.writable.length || !Array.isArray(pkg.done) || !pkg.done.length || !Array.isArray(pkg.dependsOn ?? [])) throw fail("STATE_CORRUPT", "包计划不完整，请检查并重新登记完整计划后再签卡。")
      normalizeModelRef(pkg.model, "packages." + pkg.id + ".model")
    }
  } else if (!Array.isArray(task.scope.firstWritable) || task.scope.firstWritable.length === 0 ||
      !(task.scope.firstWritable.length === 1 && task.scope.firstWritable[0] === "none") && !task.scope.firstWritable.every(validWritableSpec)) {
    const outputs = (task.workflow?.stages?.find((stage) => stage.id === task.scope.entry)?.outputs ?? []).join("、")
    throw fail("DISPATCH_INPUT_REQUIRED", "首派单 Owner 需要声明有效的项目相对路径:产物类型（入口阶段产出：" + (outputs || "无") + "）；无产物时使用 --writable none。")
  }
}

// 重签只以已完整落盘、且快照指纹可核验的最近接受决定为基准。
// 历史记录缺快照时不能猜测旧值：回退完整卡，等本次确认后再生成增量。
function latestConfirmedIntake(task) {
  const confirmed = [...task.journal].reverse().filter((event) => event.type === "decision-issued" && event.detail?.gateId === INTAKE_GATE && effectiveIntakeIssued(task, event.detail)).map((event) => acceptedIntakeFor(task, event.detail)).find(Boolean)
  if (!confirmed) return null
  const snapshot = confirmed.intakeSnapshot
  if (!snapshot || typeof snapshot !== "object" || digestValue(snapshot) !== confirmed.intakeFingerprint) return { decisionId: confirmed.decisionId, unavailable: true }
  return { decisionId: confirmed.decisionId, fingerprint: confirmed.intakeFingerprint, snapshot }
}

// 除快照自洽外，新版还要求它对应最新签发并完成的意图卡；历史已接受卡不能复活。
function currentConfirmedIntake(task) {
  const confirmed = latestConfirmedIntake(task)
  const current = intakeConfirmation(task)
  return confirmed && !confirmed.unavailable && current?.decisionId === confirmed.decisionId ? confirmed : null
}

// 候选确认按恢复卡 ID 单独查询，不能替换当前意图确认，也不能被其他候选重用。
function candidateConfirmedIntake(task, recoveryId) {
  const issued = task.journal.filter((event) => event.type === "decision-issued" && event.detail?.gateId === INTAKE_GATE && event.detail?.recoveryAuthorization?.decisionId === recoveryId).at(-1)?.detail
  const accepted = acceptedIntakeFor(task, issued)
  const snapshot = accepted?.intakeSnapshot
  if (!snapshot || typeof snapshot !== "object" || digestValue(snapshot) !== accepted.intakeFingerprint || issued.intakeFingerprint !== accepted.intakeFingerprint) return null
  return { decisionId: accepted.decisionId, fingerprint: accepted.intakeFingerprint, snapshot }
}

// 差异与签名使用同一个完整快照；数组保序并区分增删，包按 ID 比较字段。
function intakeDiff(previous, current, base) {
  const changes = []
  let unchangedCount = 0
  const leafCount = (value) => {
    if (value && typeof value === "object") {
      const children = Array.isArray(value) ? value : Object.values(value)
      return children.length ? children.reduce((sum, item) => sum + leafCount(item), 0) : 1
    }
    return 1
  }
  const emit = (pathName, kind, before, after) => changes.push({ path: pathName, kind, ...(kind === "added" ? {} : { before }), ...(kind === "removed" ? {} : { after }) })
  const walk = (before, after, location) => {
    if (before === undefined) return emit(location, "added", before, after)
    if (after === undefined) return emit(location, "removed", before, after)
    if (digestValue(before) === digestValue(after)) { unchangedCount += leafCount(before); return }
    if (location === "packages" && Array.isArray(before) && Array.isArray(after)) {
      const oldIds = before.map((pkg) => pkg.id), newIds = after.map((pkg) => pkg.id)
      if (digestValue(oldIds) !== digestValue(newIds)) emit("packages.$order", "modified", oldIds, newIds)
      const oldById = new Map(before.map((pkg) => [pkg.id, pkg]))
      const newById = new Map(after.map((pkg) => [pkg.id, pkg]))
      for (const id of new Set([...oldIds, ...newIds])) walk(oldById.get(id), newById.get(id), "packages[" + id + "]")
      return
    }
    if (Array.isArray(before) && Array.isArray(after)) {
      // 用公共子序列区分插入/删除与位置移动，避免把删掉首项误报成修改其余项。
      // 极大数组退化为整个字段的前后值，避免二次空间无限增长。
      if (before.length * after.length > 100000) return emit(location, "modified", before, after)
      const oldKeys = before.map((item) => digestValue(item))
      const newKeys = after.map((item) => digestValue(item))
      const rows = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1))
      for (let i = before.length - 1; i >= 0; i -= 1) for (let j = after.length - 1; j >= 0; j -= 1) {
        rows[i][j] = oldKeys[i] === newKeys[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1])
      }
      let i = 0, j = 0, removed = [], added = []
      const flush = () => {
        const pairs = Math.min(removed.length, added.length)
        for (let n = 0; n < pairs; n += 1) walk(removed[n].value, added[n].value, location + "[" + added[n].index + "]")
        for (const item of removed.slice(pairs)) walk(item.value, undefined, location + "[" + item.index + "]")
        for (const item of added.slice(pairs)) walk(undefined, item.value, location + "[" + item.index + "]")
        removed = []; added = []
      }
      while (i < before.length || j < after.length) {
        if (i < before.length && j < after.length && oldKeys[i] === newKeys[j]) {
          flush(); walk(before[i], after[j], location + "[" + j + "]"); i += 1; j += 1
        } else if (i < before.length && (j === after.length || rows[i + 1][j] >= rows[i][j + 1])) {
          removed.push({ index: i, value: before[i] }); i += 1
        } else {
          added.push({ index: j, value: after[j] }); j += 1
        }
      }
      flush()
      return
    }
    if (before && after && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) walk(before[key], after[key], location ? location + "." + key : key)
      return
    }
    emit(location, "modified", before, after)
  }
  walk(previous, current, "")
  return { baseDecisionId: base.decisionId, baseFingerprint: base.fingerprint, changes, unchangedFolded: true, unchangedCount }
}

function needsIntakeResign(task, fingerprint) {
  const latest = task.journal.filter((event) => event.type === "decision-issued" && event.detail?.gateId === INTAKE_GATE).at(-1)?.detail
  return Boolean(latest && latest.intakeFingerprint !== fingerprint)
}

function readyToSignIntake(task, roles) {
  try { assertCompleteIntake(task, roles); return true } catch (error) {
    if (["INTAKE_RAW_REQUIRED", "INTAKE_ROLES_UNRESOLVED", "DISPATCH_INPUT_REQUIRED"].includes(error.code)) return false
    throw error
  }
}

async function intakeState(task) {
  checkIntakeFacts(task)
  const registry = await readRegistry(task)
  const normalized = normalizeRoleEntries(registry.roles)
  const snapshot = intakeSnapshot({ task, roles: normalized.roles, packages: task.packages })
  return { registry, roles: normalized.roles, invalid: normalized.invalid, snapshot, fingerprint: digestValue(snapshot) }
}

// 确认卡正文：固定段序（原始需求 → 目标 → 约束/排除 → 范围/产出 → 角色模型 3 行 → 逐包模型 → gap → 选项）。
function intakeCardText({ task, workflow, snapshot, details, choices = [], decisionId, diff, baselineUnavailable }) {
  if (diff) {
    const lines = ["# 任务意图变更确认", "", "卡片标识：" + decisionId,
      "相对最近已确认卡 " + diff.baseDecisionId + " 的增量如下；与已确认快照一致（" + diff.unchangedCount + " 项未变），已折叠引用该卡；完整快照仍受 SHA 与卡片 ID 双重校验。", ""]
    if (!diff.changes.length) lines.push("配置与该已确认快照相同；本次重签仍须确认当前卡。")
    for (const change of diff.changes) {
      const label = { added: "新增", removed: "删除", modified: "修改" }[change.kind]
      lines.push("- " + label + " " + change.path +
        (change.kind === "added" ? "：" + JSON.stringify(change.after) : change.kind === "removed" ? "：" + JSON.stringify(change.before) : "：" + JSON.stringify(change.before) + " → " + JSON.stringify(change.after)))
    }
    if (choices.length) {
      lines.push("", "## 选项")
      for (const choice of choices) lines.push(choice.n + ". " + choice.label + (choice.desc ? "——" + choice.desc : ""))
    }
    return lines.join("\n")
  }
  const lines = []
  if (baselineUnavailable) lines.push("（最近已确认卡缺少可核验的完整快照，本次展示完整卡作为新基线。）", "")
  lines.push("# 任务意图确认（intake-approval）", "")
  if (task.scope?.intakeVersion === 2) lines.push("卡片标识：" + decisionId, "")
  lines.push("## 你的原始需求（不摘要、不删改）")
  lines.push(snapshot.intent.rawRequirement || "（未提供原始需求全文；可用 tw intent --task <n> --raw-requirement <原文> 补充）", "")
  lines.push("## 目标 / 约束 / 排除")
  lines.push("目标：" + (snapshot.intent.objective || "（未提供）"))
  lines.push("风险标记：" + snapshot.intent.risk)
  if (snapshot.intent.constraints.length) lines.push("约束：", ...snapshot.intent.constraints.map((c) => "- " + c))
  else lines.push("约束：（未提供）")
  if (snapshot.intent.exclusions.length) lines.push("排除：", ...snapshot.intent.exclusions.map((c) => "- " + c))
  else lines.push("排除：（未提供）")
  lines.push("", "## 范围与产出")
  const entryStage = workflow?.stages?.find((stage) => stage.id === task.scope?.entry)
  const actualScope = snapshot.scope ?? { entry: task.scope?.entry, completion: task.scope?.completion, outputs: entryStage?.outputs ?? [] }
  lines.push("入口阶段：" + String(actualScope.entry ?? "未提供") + "；结束方式：" + JSON.stringify(actualScope.completion ?? null))
  lines.push("预期产出物：" + (actualScope.outputs.map(String).join("、") || "（入口阶段无声明产出物）"))
  lines.push("意图范围：" + JSON.stringify(snapshot.intent.scope))
  const scopeNotes = Array.isArray(snapshot.intent.scope?.notes) ? snapshot.intent.scope.notes.map(String) : []
  if (scopeNotes.length) lines.push("范围补充：", ...scopeNotes.map((note) => "- " + note))
  if (snapshot.intent.acceptance.length) lines.push("验收：", ...snapshot.intent.acceptance.map((c) => "- " + c))
  else lines.push("验收：（未提供）")
  lines.push("", "## 角色模型（3 行，恒定显示）")
  lines.push("| 角色 | provider | modelName | 推理强度 | family | 档位溯源 |", "| --- | --- | --- | --- | --- | --- |")
  for (const detail of details) {
    lines.push("| " + detail.role + " | " + (detail.modelRef?.provider ?? "（unresolved）") + " | " + (detail.modelRef?.modelName ?? "—") + " | " + (detail.modelRef ? (detail.modelRef.effort ?? "省略（不设置）") : "—") + " | " + (detail.modelRef?.family ?? "省略") + " | " + (detail.tierProvenance ?? "未记录") + " |")
  }
  const unresolved = details.filter((detail) => !detail.modelRef)
  if (unresolved.length) lines.push("", "未解析角色：" + unresolved.map((detail) => detail.role + "（" + (detail.reason ?? "未解析") + "）").join("；"))
  lines.push("", "## 完整分包计划")
  if (!snapshot.packages.length) {
    lines.push("未拆包：单 Owner；模型：" + JSON.stringify(snapshot.roles.owner) + "；首派可写范围：" + JSON.stringify(snapshot.firstWritable ?? null) + "；验收：" + JSON.stringify(snapshot.intent.acceptance))
  } else {
    for (const pkg of snapshot.packages) lines.push("- id: " + pkg.id + "；model: " + JSON.stringify(pkg.model) + "；writable: " + JSON.stringify(pkg.writable) + "；done: " + JSON.stringify(pkg.done) + "；dependsOn: " + JSON.stringify(pkg.dependsOn))
  }
  lines.push("", "## 仍未明确的问题（gap）")
  if (!snapshot.intent.gaps.length) lines.push("（无：目标、约束、排除、范围与验收均可指回原始需求）")
  else snapshot.intent.gaps.forEach((gap, index) => {
    lines.push((index + 1) + ". " + JSON.stringify(gap))
  })
  lines.push("")
  if (unresolved.length) lines.push("（角色模型 unresolved：本卡不提供“确认开始”；修复配置后 tw roles --resolve 重签）")
  if (choices.length) {
    lines.push("", "## 选项")
    for (const choice of choices) lines.push(choice.n + ". " + choice.label + (choice.desc ? "——" + choice.desc : ""))
  }
  return lines.join("\n")
}

async function signIntakeApproval({ task, workflow, roles, details, profile, source, recoveryAuthorization = null }) {
  assertCompleteIntake(task, roles)
  const snapshot = intakeSnapshot({ task, roles, packages: task.packages })
  const fingerprint = digestValue(snapshot)
  const usedIds = new Set(task.journal.filter((event) => event.type === "decision-issued").map((event) => event.detail?.decisionId))
  let decisionId
  do { decisionId = "intake-" + randomBytes(3).toString("hex") } while (usedIds.has(decisionId))
  const pendingIntakes = pendingDecisionsOf({ journal: task.journal }).open.filter((card) => card.detail.gateId === INTAKE_GATE)
  const events = []
  // 多卡时只替换意图卡；刷新等其他卡保留并按自己的绑定重新核验。
  for (const card of pendingIntakes) {
    events.push({ type: "decided", detail: { decisionId: card.detail.decisionId, choice: "superseded", reason: "意图、角色模型或包模型已变化，按新配置重签确认卡" } })
  }
  const unresolved = details.filter((detail) => !detail.modelRef)
  const choices = []
  let number = 0
  if (!unresolved.length) choices.push({ n: ++number, label: "确认开始", desc: "按以上意图、角色模型与逐包模型进入执行", grant: "accept-intake" })
  choices.push({ n: ++number, label: "我先修改", desc: "用 tw intent / tw roles / tw plan 修改后重出确认卡", grant: "revise-intake" })
  choices.push({ n: ++number, label: "终止任务", desc: "以当前形态终止并归档", grant: "stop-task" })
  const base = latestConfirmedIntake(task)
  const diff = base && !base.unavailable ? intakeDiff(base.snapshot, snapshot, base) : null
  const question = intakeCardText({ task, workflow, snapshot, details, choices, decisionId, diff, baselineUnavailable: base?.unavailable })
  const intake = {
    rawRequirement: snapshot.intent.rawRequirement,
    objective: snapshot.intent.objective,
    constraints: snapshot.intent.constraints,
    exclusions: snapshot.intent.exclusions,
    scope: snapshot.intent.scope,
    acceptance: snapshot.intent.acceptance,
    gaps: snapshot.intent.gaps,
    risk: snapshot.intent.risk,
    roles: details.map((detail) => ({ role: detail.role, modelRef: detail.modelRef, effortState: detail.effortState, tierProvenance: detail.tierProvenance })),
    packages: snapshot.packages.map((pkg) => ({ id: pkg.id, model: pkg.model, modelRef: pkg.model, writable: pkg.writable, done: pkg.done, dependsOn: pkg.dependsOn, vsRolesOwner: pkg.model && snapshot.roles.owner ? (modelRefsEqual(pkg.model, snapshot.roles.owner) ? "equal" : "different") : null })),
    ...(snapshot.scope ? { actualScope: snapshot.scope } : {}),
    ...(snapshot.firstWritable !== undefined ? { firstWritable: snapshot.firstWritable } : {}),
    ...(diff ? { diff } : {}),
    ...(base?.unavailable ? { diffBaselineUnavailable: base.decisionId } : {}),
    profile: profile ?? "unresolved",
    source: source ?? "unresolved",
  }
  events.push({ type: "decision-issued", detail: { decisionId, gateId: INTAKE_GATE, reason: question, choices, intakeFingerprint: fingerprint, intake, ...(recoveryAuthorization ? { recoveryAuthorization } : {}), ...(task.scope?.intakeVersion === 2 ? { intakeVersion: 2 } : {}) } })
  await appendEventsUnlocked(task, events)
  return { decisionId, question, choices, intakeFingerprint: fingerprint, intake, ...(unresolved.length ? { code: "INTAKE_ROLES_UNRESOLVED", unresolved: unresolved.map((detail) => detail.role) } : {}) }
}

// 派发前的确认门：只在"本任务签发过确认卡"时生效（旧任务不补卡、不静止，§3.4.5）。
// 已确认指纹与当前稳定投影不一致（意图/roles/packages 变化）→ 作废旧卡并重签，停止派发。
async function intakeGateCard({ task, workflow, state }) {
  const issued = task.journal.some((event) => event.type === "decision-issued" && event.detail?.gateId === INTAKE_GATE && effectiveIntakeIssued(task, event.detail))
  if (!issued && task.scope?.intakeVersion !== 2) return null
  const pending = pendingDecisionDetail(task.journal)
  if (pending && pending.gateId !== INTAKE_GATE) return null
  const stateInfo = await intakeState(task)
  assertCompleteIntake(task, stateInfo.roles)
  if (pending?.intakeFingerprint === stateInfo.fingerprint) return { ok: true, task: task.name, stage: state.stage, status: "awaiting-user", next: "decide", transition: "await-decision", decisionId: pending.decisionId, question: pending.reason, choices: pending.choices, intakeFingerprint: pending.intakeFingerprint, intake: pending.intake }
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
  const deliverCmd = twCommand() + ' deliver --task ' + task.name + ' --key ' + detail.key + ' --outcome delivered --summary <一句话> --paths <路径> [--paths <路径> 或逗号分隔]（完整清单：要保留的文件全部列入）'
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
  // §6.1：Owner 首派/续派正文列出该包上一条未作废有效报告的完整路径清单（不存在则明确为空）。
  const baselineList = (wave.role === 'owner')
    ? (() => {
        const stageReports = (task.reports ?? []).filter((r) => r.stage === stageDef.id)
        const base = deliverBaselines({ journal: task.journal ?? [], reports: stageReports }).get(pkg)
        if (!base) return '当前无上一条有效报告：本次 --paths 就是该包的初始完整清单。'
        const paths = Array.isArray(base.report.files) && base.report.files.length > 0
          ? base.report.files.map((f) => f.path)
          : (Array.isArray(base.report.payload?.paths) ? base.report.payload.paths.map(String) : [])
        return paths.length
          ? '该包上一条未作废有效报告（' + base.report.reportId + ' v' + (base.report.ver ?? 1) + '）的完整路径清单：\n' + paths.map((p) => '- ' + p).join('\n') + '\n交付时 --paths 必须给出本包当前阶段的**完整**清单：要保留的上述文件必须全部重新列入；未列入即表示该文件不再是本包有效交付制品（磁盘文件保留审计，不自动删除）。'
          : '上一条有效报告（' + base.report.reportId + '）清单为空：本次 --paths 就是该包的完整清单。'
      })()
    : ''
  const tailParts = [
    '## 行动与交付',
    scopeParts[0],
    scopeParts[1],
    wave.role === 'owner' ? '可写路径（仅限）：\n' + (boundaries.map((b) => '- ' + b).join('\n') || '（无，纯回应派单）') : '只读派单：不得修改任何文件',
    wave.role === 'owner' ? baselineList : '',
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
      writable: detail.writable ?? [],
      ...(wave.scope ? { scope: wave.scope } : {}),
      prompt,
      ...(detail.continuation ? { promptFull } : {}),
    },
  }
}

// 开任务（§3.1/§3.4）：initTask 写 intent → 锁内解析三角色 ModelRef 写 agents.json.roles
// → journal roles-initialized；首次推进才签发完整意图确认卡。
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
    stages: workflow.stages.map((s) => s.id), risk, intakeVersion: 2,
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
    const baseNote = entry ? `任务从 ${entry} 介入，将运行到该阶段验收` : "任务将运行完整工作流"
    const riskNote = risk && risk !== 'normal' ? `；按 ${risk} 档运行：owner 角色档解析为 ${risk === 'critical' ? 'expert' : 'senior'}` : ""
    const unresolvedNote = unresolved.length ? '；角色模型 unresolved（' + unresolved.join('、') + '）：补齐配置后 tw roles --resolve 重建' : ''
    return {
      ok: true, task: name, stage: resolvedEntry, status: "preparing", next: "dispatch",
      roles: resolved.roles,
      ...(unresolved.length ? { unresolved } : {}),
      note: baseNote + riskNote + '；准备角色与分包后首次推进签发完整确认卡，确认前不派发' + unresolvedNote,
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
  // §6.2 只读实时核验：磁盘字节与各包有效清单摘要不一致时状态卡如实呈现 blocker（run 零写）
  const artifactVerification = await verifyStageArtifacts(projectRoot, task, currentStageOf(task.journal, task.scope))
  const state = deriveTask({ ...task, artifactVerification })
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
    if (task.scope?.intakeVersion === 2 && !task.journal.some((event) => event.type === "decision-issued" && event.detail?.gateId === INTAKE_GATE)) {
      return { ok: true, task: name, stage: state.stage, status: "preparing", next: "dispatch", note: "准备完成后由首次推进签发完整确认卡，确认前不派发。" }
    }
    if (!state.next.wave) {
      // 门失败且非人工阻塞（如裁决/指纹失效且无法自动重派）：呈现 blocker 卡（I5；只读推导）
      const blockers = (state.gate?.blockers ?? state.next.hint ?? []).map((b2) => (typeof b2 === "string" ? { message: b2, recovery: b2 } : b2))
      return { ok: true, task: name, stage: state.stage, status: "blocked", next: "none", blockers, transition: "blocked" }
    }
    const wave = state.next.wave
    // 只读检查（run 零写入）：确认未完成或配置已变化时只给重签指引，签发归 dispatch 通道。
    const intakeIssued = task.journal.some((event) => event.type === "decision-issued" && event.detail?.gateId === INTAKE_GATE && effectiveIntakeIssued(task, event.detail))
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
        blocked: state.next.produceBlocked, blockedPackages: blockedEvidenceOf(task, state.stage), question: state.next.reason,
        ...(progressText ? { progress: progressText } : {}),
        note: "任务静止等待用户：先核必要性和授权；用户给出明确方向后，Lead 用 tw plan --task " + name + " --resolve-blocked '{\"package\":\"<包>\",\"action\":\"retry\",\"reason\":\"<用户方向>\"}' --blocked-ref <blockedPackages 列出的 ref> 准备按包恢复卡（单 owner 省略 package），用户按卡片 decision-id 确认后该包解除 blocked（retry 需新范围再推进；remove 移出计划）；或决定结束。计划变更本身不解除任何 blocked；路径参数不代表产品授权",
      }
    }
    // R3-6/§6.2.2：多卡时直接返回全部现有待决卡（不签新卡）——derive 多卡静止省略单卡别名，
    // 此处若落入首次签发会追加第三张 decision-issued（假门卡）；同钉渲染第一张的账本正文 + 完整列表。
    if (!state.next.pending && Array.isArray(state.next.pendingDecisions) && state.next.pendingDecisions.length > 1) {
      const first = pendingDecisionsOf({ journal: task.journal }).open[0]
      if (first) {
        return {
          ok: true, task: name, stage: state.stage, status: "awaiting-user", next: "decide", transition: "await-decision",
          ...await pendingCardLists(projectRoot, task, state.stage, state.next.pendingDecisions),
          ...(progressText ? { progress: progressText } : {}),
          note: "当前有多张待决卡（" + state.next.pendingDecisions.length + " 张）：用 --decision-id 指定实际答复的卡片；不签发新卡。",
        }
      }
    }
    const pending = state.next.pending ?? null
    const multiList = Array.isArray(state.next.pendingDecisions) && state.next.pendingDecisions.length ? state.next.pendingDecisions : null
    if (!pending && multiList) {
      return { ok: true, task: name, stage: state.stage, status: "awaiting-user", next: "decide", transition: "await-decision", ...await pendingCardLists(projectRoot, task, state.stage, multiList), ...(state.next.duplicateIssued?.length ? { duplicateIssued: state.next.duplicateIssued } : {}), ...(progressText ? { progress: progressText } : {}), note: "当前有多张待决卡：用 --decision-id 指定实际答复的卡片（列表见 pendingDecisions）。" }
    }
    if (pending) {
      if (["artifact-refresh", "package-recovery"].includes(pending.kind)) {
        const lists = await pendingCardLists(projectRoot, task, state.stage, state.next.pendingDecisions ?? [])
        if (lists.staleDecisions?.length) return { ok: true, task: name, stage: state.stage, status: "awaiting-user", next: "decide", transition: "await-decision", ...lists, note: "该卡的结构性前提已失效：可按原卡 ID 安全取消，或按当前事实重新准备；未收口前不推进。" }
      }
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
      return { ok: true, task: name, stage: state.stage, status: "awaiting-user", next: "decide", transition: "await-decision", decisionId: pending.decisionId, question: pending.reason, choices: pending.choices, ...(Array.isArray(state.next.pendingDecisions) && state.next.pendingDecisions.length ? { pendingDecisions: await describePendingCards(projectRoot, task, state.stage, state.next.pendingDecisions), ...(blockedEvidenceOf(task, state.stage).length ? { blockedPackages: blockedEvidenceOf(task, state.stage) } : {}), ...(state.next.pendingDecisions.length > 1 ? { needsDecisionId: true } : {}) } : {}), ...(state.next.duplicateIssued?.length ? { duplicateIssued: state.next.duplicateIssued } : {}), ...(progressText ? { progress: progressText } : {}) }
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

function dispatchedDetail(dispatch, wave, writable, extras = {}) {
  return {
    key: dispatch.key,
    kind: wave.kind,
    role: wave.role,
    round: dispatch.round,
    package: dispatch.package ?? null,
    continuation: dispatch.continuation,
    ...(dispatch.scope ? { scope: dispatch.scope } : {}),
    writable,
    // B4：派单冻结阶段归属——旧 key 迟到重交（跨阶段）按原派单阶段提交，不伪装成当前新阶段事实
    ...(extras.stage ? { stage: extras.stage } : {}),
    // B3：评审/裁决派单冻结被审基线身份（reviewBaseline）
    ...(extras.reviewBaseline ? { reviewBaseline: extras.reviewBaseline } : {}),
    ...(dispatch.waveId ? { waveId: dispatch.waveId } : {}),
    ...(wave.causeDecisionId ? { causeDecisionId: wave.causeDecisionId } : {}),  // F5：respond 派发抄写返工决定（runtime 抄写，P4）
    // 新派发一律写 modelRef + 来源（package/roles）；历史 modelHint 只在读取时映射，不重写。
    ...(dispatch.modelRef ? { modelRef: dispatch.modelRef, modelSource: dispatch.modelSource ?? 'roles' } : {}),
    // §4.1 冻结派单正文与摘要：该 key 首次实际生成的派单正文（含全量变体）随 dispatched 事件
    // 冻结进 journal；在途重建与宿主对账以冻结正文核对，规则热更只影响后续新波。
    ...(dispatch.prompt ? { prompt: dispatch.prompt, promptDigest: sha256(dispatch.prompt) } : {}),
    ...(dispatch.promptFull ? { promptFull: dispatch.promptFull, promptFullDigest: sha256(dispatch.promptFull) } : {}),
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
  checkIntakeFacts(task)
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
    // §6.3：单 Owner 保留 writables 重派通道，但必须绑定实际 blocked 报告和用户方向——
    // 未确认 package-recovery（blocked 仍在有效投影）时不自动重派；计划变更也不解除 blocked。
    const blockedNow = effectiveBlockedSet({ journal: task.journal, reports: task.reports.filter((r) => r.stage === state.stage), packages: null })
    if (blockedNow.size > 0) {
      return {
        ok: true, task: name, stage: state.stage, status: "awaiting-user", next: "re-scope", transition: "await-decision",
        blocked: state.next.produceBlocked, blockedPackages: blockedEvidenceOf(task, state.stage),
        question: state.next.reason,
        note: "单 Owner 恢复需先绑定用户方向：先 tw plan --task " + name + " --resolve-blocked '{\"action\":\"retry\",\"reason\":\"<用户方向>\"}' --blocked-ref <blockedPackages 中的引用> 准备恢复卡，用户按卡片 ID 确认后再携新可写范围经 tw-dispatch / dispatch-plan 推进。",
      }
    }
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
    await appendEventsUnlocked(task, [{ type: 'dispatched', detail: dispatchedDetail(dispatch, wave, decl, { stage: state.stage }) }])
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
    // B5/§6.2：评审/裁决派单冻结前同步核验——磁盘字节与各包有效清单摘要不一致、或快照缺失/损坏时，
    // 不派发评审波（成员无法评审一个与登记不一致的基线），返回 blocker 卡与恢复指引（不再只记 warning）。
    if (wave.role === 'challenger' || wave.role === 'expert') {
      const verification = await verifyStageArtifacts(projectRoot, task, state.stage)
      if (!verification.ok) {
        return {
          ok: true, task: name, stage: state.stage, status: 'blocked', next: 'none', transition: 'blocked',
          blockers: verification.mismatches.map((m) => ({
            message: '磁盘内容与登记摘要不一致：' + (m.path ?? '?') + '（' + m.reason + '；期望 ' + (m.expected ?? '?') + (m.actual ? '，实际 ' + m.actual : '') + '）',
            recovery: 'tw restore --task ' + name + ' --path <路径> 从有效快照恢复原始字节；或 Lead 在用户明确确认后用 tw refresh-artifacts 刷新待审基线；快照缺损时依据 journal 事件重做交付',
          })),
        }
      }
    }
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
      await appendEventsUnlocked(task, cards.map((card, index) => ({ type: 'dispatched', detail: dispatchedDetail(card, wave, decls[index].writable, { stage: state.stage }) })))
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
    // B3/§6.2：评审/裁决派单冻结被审各包的当前有效基线身份（reportId+ver）——
    // 评审交卷时锁内校验基线未变，旧 key 迟到重交形成新基线后旧评审派单不得把结论记到新基线上。
    const reviewBaseline = wave.role === 'challenger' || wave.role === 'expert'
      ? [...deliverBaselines({ journal: task.journal, reports: task.reports.filter((r) => r.stage === state.stage) }).entries()]
          .map(([baselinePkg, base]) => ({ package: baselinePkg, reportId: base.report.reportId, ver: base.report.ver ?? 1 }))
      : null
    await appendEventsUnlocked(task, [{ type: 'dispatched', detail: dispatchedDetail(card.dispatch, wave, [], { stage: state.stage, ...(reviewBaseline ? { reviewBaseline } : {}) }) }])
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
        blocked: state.next.produceBlocked, blockedPackages: blockedEvidenceOf(task, state.stage), question: state.next.reason,
        ...(progressText ? { progress: progressText } : {}),
        note: "任务静止等待用户：先核必要性和授权；用户给出明确方向后，Lead 用 tw plan --task " + name + " --resolve-blocked '{\"package\":\"<包>\",\"action\":\"retry\",\"reason\":\"<用户方向>\"}' --blocked-ref <blockedPackages 列出的 ref> 准备按包恢复卡（单 owner 省略 package），用户按卡片 decision-id 确认后该包解除 blocked（retry 需新范围再推进；remove 移出计划）；或决定结束。计划变更本身不解除任何 blocked；路径参数不代表产品授权",
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
    // R3-6/§6.2.2：多卡静止（derive 省略单卡别名）时**直接返回全部现有待决卡**——落入下方首签
    // 分支会追加第三张 decision-issued（假门卡），重复推进不断生成多余卡。
    if (!state.next.pending && Array.isArray(state.next.pendingDecisions) && state.next.pendingDecisions.length > 1) {
      const firstOpen = pendingDecisionsOf({ journal: task.journal }).open[0]
      if (firstOpen) {
        return {
          ok: true, task: name, stage: state.stage, status: "awaiting-user", next: "decide", transition: "await-decision",
          ...await pendingCardLists(projectRoot, task, state.stage, state.next.pendingDecisions),
          ...(progressText ? { progress: progressText } : {}),
          note: "当前有多张待决卡（" + state.next.pendingDecisions.length + " 张）：用 --decision-id 指定实际答复的卡片；不签发新卡。",
        }
      }
    }
    const pending = state.next.pending ?? null
    // F6-3 签发锚点：人工门卡签发时绑定 {artifactFingerprint, reviewFingerprint} 快照；
    // F6-2 未决分支：签发指纹 vs 当前指纹，变化 → 作废旧卡（decided:superseded，只增不改）重签新卡。
    const currentArtifactFp = currentArtifactFpOf(task, state)
    const currentReviewFp = currentReviewFpOf(task, state, workflow, policy)
    // 僵局/blocked/人工门/默认四类选择表（仅首签生成；重渲染一律用账本 pending.choices）
    const human = state.gate?.humanGate ?? state.next.gateId ?? null
    const cardChoices = decisionChoicesFor({ state, human })
    if (pending) {
      if (["artifact-refresh", "package-recovery"].includes(pending.kind)) {
        const lists = await pendingCardLists(projectRoot, task, state.stage, state.next.pendingDecisions ?? [])
        if (lists.staleDecisions?.length) return { ok: true, task: name, stage: state.stage, status: "awaiting-user", next: "decide", transition: "await-decision", ...lists, note: "该卡的结构性前提已失效：可按原卡 ID 安全取消，或按当前事实重新准备；未收口前不推进。" }
      }
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
        // §6.2.2 多卡输出：pendingDecisions 全列表（机器消费），单卡别名保留
        return { ok: true, task: name, stage: state.stage, status: "awaiting-user", next: "decide", transition: "await-decision", decisionId: pending.decisionId, question: pending.reason, choices: pending.choices, ...(Array.isArray(state.next.pendingDecisions) && state.next.pendingDecisions.length ? { pendingDecisions: await describePendingCards(projectRoot, task, state.stage, state.next.pendingDecisions), ...(blockedEvidenceOf(task, state.stage).length ? { blockedPackages: blockedEvidenceOf(task, state.stage) } : {}), ...(state.next.pendingDecisions.length > 1 ? { needsDecisionId: true } : {}) } : {}), ...(state.next.duplicateIssued?.length ? { duplicateIssued: state.next.duplicateIssued } : {}), ...(progressText ? { progress: progressText } : {}) }
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

// 只读展示逐卡前提；最终允许与否仍由各自决定分支在锁内重核。
async function describePendingCards(projectRoot, task, stage, cards) {
  const open = pendingDecisionsOf({ journal: task.journal }).open
  const verification = await verifyStageArtifacts(projectRoot, task, stage)
  let info = null
  try { info = await intakeState(task) } catch {}
  const readBytes = await import("./persistence/file-artifact-repository.mjs")
  const accepted = currentConfirmedIntake(task)
  const baselines = deliverBaselines({ journal: task.journal, reports: task.reports.filter((r) => r.stage === stage) })
  return Promise.all((cards ?? []).map(async (card) => {
    const blockers = []
    const detail = open.find((c) => c.detail.decisionId === card.decisionId)?.detail ?? {}
    if (["artifact-refresh", "package-recovery", "human-gate"].includes(card.kind)) {
      for (const prerequisite of open.filter((c) => c.detail.decisionId !== card.decisionId && (c.detail.migrate || c.detail.gateId === INTAKE_GATE))) {
        blockers.push({ code: "PREREQUISITE", decisionId: prerequisite.detail.decisionId, message: "先处理迁移或意图确认卡" })
      }
    }
    if (card.kind === "human-gate" && !verification.ok) for (const mismatch of verification.mismatches) blockers.push({ code: "ARTIFACT_MISMATCH", ...mismatch })
    if (card.kind === "artifact-refresh") {
      const refresh = detail.refresh ?? {}
      if (refresh.stage !== stage || (refresh.planDigest && refresh.planDigest !== digestValue(task.packages))) blockers.push({ code: "STALE_BINDING", message: "阶段或包计划与刷新卡不一致" })
      const baseline = baselines.get(detail.package ?? null)?.report
      if ((baseline?.reportId ?? null) !== (refresh.previousReportId ?? null) || (baseline?.ver ?? 1) !== (refresh.previousVer ?? 1)) blockers.push({ code: "STALE_REPORT", message: "有效报告已变化" })
      const auth = refresh.intakeConfirmedAtIssue
      if (!info || (auth?.mode !== "confirmed-intake" && auth?.mode !== "legacy-range")) blockers.push({ code: "INTAKE_UNCONFIRMED", message: "刷新卡授权快照无法验证" })
      else if (auth.mode === "confirmed-intake" && (!accepted || accepted.fingerprint !== info.fingerprint || accepted.fingerprint !== auth.fingerprint || accepted.decisionId !== auth.decisionId)) blockers.push({ code: "STALE_AUTHORIZATION", message: "刷新卡绑定的意图确认已变化，须取消或重签" })
      if (auth?.mode === "legacy-range" && info) {
        const multi = Array.isArray(task.packages) && task.packages.length > 0
        const writable = multi ? (task.packages.find((p) => p.id === detail.package)?.writable ?? []).map(parseWritableEntry) : (lastOwnerWritable(task, stage) ?? [])
        if (digestValue(legacyRefreshBinding(task, info, stage, writable)) !== auth.fingerprint) blockers.push({ code: "STALE_BINDING", message: "旧任务可验证范围或意图已变化" })
      }
      for (const f of refresh.files ?? []) {
        try { const digest = digestBytes(await readBytes.readStableArtifactBytes(projectRoot, f.path)); if (digest !== f.digest) blockers.push({ code: "CANDIDATE_CHANGED", path: f.path, expected: f.digest, actual: digest, message: "候选文件字节已变化" }) }
        catch (error) { blockers.push({ code: "CANDIDATE_UNREADABLE", path: f.path, message: "候选文件不可稳定读取：" + String(error?.message ?? error) }) }
      }
      const inflight = inflightBatch({ journal: task.journal, reports: task.reports })
      if (inflight?.open.some((d) => d.role === "challenger" || d.role === "expert")) blockers.push({ code: "REVIEW_INFLIGHT", message: "评审仍在途，须先安全结束或按规则作废" })
    }
    if (card.kind === "package-recovery") {
      const rec = detail.recovery ?? {}
      if (rec.currentPlanDigest !== digestValue(task.packages ?? null)) blockers.push({ code: "STALE_PLAN", message: "恢复卡绑定的计划已变化" })
      const blocked = effectiveBlockedSetOf(task, stage).get(detail.package ?? null)
      if (!blocked || blocked.dispatchKey !== rec.dispatchKey || (blocked.ver ?? 1) !== (rec.reportVersion ?? 1)) blockers.push({ code: "STALE_BLOCKED", message: "绑定的 blocked 报告已变化" })
      if (Array.isArray(rec.plan) && info && digestValue(rec.plan) !== digestValue(task.packages ?? null)) {
        const expected = digestValue(intakeSnapshot({ task, roles: info.roles, packages: rec.plan }))
        if (candidateConfirmedIntake(task, detail.decisionId)?.fingerprint !== expected) blockers.push({ code: "CANDIDATE_UNCONFIRMED", message: "候选计划尚未获意图确认" })
      }
    }
    return { ...card, readiness: blockers.length ? "blocked" : "确认时重验", blockers, ...(blockers.some((b) => b.decisionId) ? { blockedBy: blockers.filter((b) => b.decisionId).map((b) => b.decisionId) } : {}) }
  }))
}

// 结构前提已失效的卡单列；只读展示不作废，安全取消仍需使用该卡的 ID。
async function pendingCardLists(projectRoot, task, stage, cards) {
  const described = await describePendingCards(projectRoot, task, stage, cards)
  const stale = (card) => card.blockers.some((blocker) => String(blocker.code).startsWith("STALE_"))
  const staleDecisions = described.filter(stale)
  const blockedPackages = blockedEvidenceOf(task, stage)
  return { pendingDecisions: described.filter((card) => !stale(card)), ...(staleDecisions.length ? { staleDecisions } : {}), ...(blockedPackages.length ? { blockedPackages } : {}), needsDecisionId: true }
}

// 卡用途简述（多卡拒绝/列表展示用）
function cardPurpose(card) {
  const kind = card?.kind ?? card?.detail?.kind ?? (card?.gateId ? "human-gate" : "converge")
  if (kind === "artifact-refresh") return "刷新待审基线确认"
  if (kind === "package-recovery") return "按包解除 blocked 恢复确认"
  if (kind === "migrate") return "迁移冲突选择"
  if (kind === "intent") return "意图确认"
  if (kind === "model-change") return "换模型确认"
  if (kind === "stalemate") return "返工僵局仲裁"
  if (kind === "rework-blocked") return "返工 blocked 仲裁"
  if (card.gateId) return "人工门 " + card.gateId
  return "用户决定"
}

// —— §6.2.1 刷新确认的单次原子提交（决定 + Lead 刷新报告 + 受影响旧门作废同一 journal 替换）——
async function decideRefreshCard({ projectRoot, task, name, pending, picked, note }) {
  const refresh = pending.refresh ?? {}
  if (picked.grant === "cancel-refresh") {
    await appendEventsUnlocked(task, [{ type: "decided", detail: { decisionId: pending.decisionId, choice: picked.label, grant: "cancel-refresh", ...(note ? { note } : {}) } }])
    return { ok: true, task: name, decisionId: pending.decisionId, choice: picked.label, next: "run", note: "刷新卡已按用户选择取消：只收口本卡，不改变基线，不取消其他待决卡。" }
  }
  if (picked.grant !== "confirm-refresh") throw fail("DECISION_STALE", "刷新确认卡只接受 确认刷新 / 取消 两个选项")
  // —— B7：锁内重核全部前提（阶段/计划/原报告/意图前置）——任一不符即拒绝且不产生新基线。
  const state = deriveTask(task)
  const stage = refresh.stage ?? state.stage
  const pkg = pending.package ?? null
  if (stage !== state.stage) {
    throw fail("DECISION_STALE", "刷新卡签发时的阶段（" + stage + "）与当前阶段（" + state.stage + "）不一致：任务已推进，本卡过期。请重新调 tw refresh-artifacts 准备新卡。")
  }
  const multiNow = Array.isArray(task.packages) && task.packages.length > 0
  if (refresh.planDigest != null) {
    if (!multiNow || digestValue(task.packages) !== refresh.planDigest) {
      throw fail("DECISION_STALE", "刷新卡签发后包计划已变化（计划摘要与卡不一致）：本卡过期。请重新准备刷新卡（或先 tw plan 处理计划变化）。")
    }
  }
  // 前置卡：未决意图/迁移卡在场时，肯定性刷新被阻止（仅安全取消可用——取消在上方分支已处理）
  const { open: openNow } = pendingDecisionsOf({ journal: task.journal })
  const blocking = openNow.filter((c) => c.detail?.decisionId !== pending.decisionId && (c.detail?.migrate || c.detail?.gateId === INTAKE_GATE))
  if (blocking.length) {
    throw fail("USAGE", "存在未决前置卡（" + blocking.map((c) => c.detail.decisionId + (c.detail.migrate ? "（迁移冲突）" : "（意图确认）")).join("、") + "）：刷新确认不得绕过先决条件。先处理前置卡（意图确认 / 迁移决定），或取消本刷新卡。")
  }
  // 刷新卡绑定确认时的完整授权；修改意图、角色或计划后，旧确认不能授权新事实。
  const authorization = refresh.intakeConfirmedAtIssue
  const currentInfo = await intakeState(task)
  if (authorization?.mode === "confirmed-intake") {
    const accepted = currentConfirmedIntake(task)
    if (!accepted || accepted.unavailable || accepted.decisionId !== authorization.decisionId || accepted.fingerprint !== authorization.fingerprint || accepted.fingerprint !== currentInfo.fingerprint || digestValue(authorization.snapshot) !== accepted.fingerprint) {
      throw fail("DECISION_STALE", "刷新卡绑定的意图确认已变化或无法验证：仅可取消旧卡，先重新确认当前意图后准备新刷新卡。")
    }
  } else if (authorization?.mode === "legacy-range") {
    const writable = multiNow ? (task.packages.find((p) => p.id === pkg)?.writable ?? []).map(parseWritableEntry) : (lastOwnerWritable(task, stage) ?? [])
    const legacy = legacyRefreshBinding(task, currentInfo, stage, writable)
    if (task.scope?.intakeVersion === 2 || !writable.length || authorization.fingerprint !== digestValue(legacy) || digestValue(authorization.snapshot) !== authorization.fingerprint) {
      throw fail("DECISION_STALE", "旧任务的范围、意图或计划已变化，旧刷新卡不得授权新事实：请取消并重新准备卡片。")
    }
  } else {
    throw fail("DECISION_STALE", "刷新卡缺少可核验的授权快照：仅可取消并重新准备，不能使用旧卡批准刷新。")
  }
  // 原报告重核：卡绑定的 previousReportId 仍是该包当前基线（无绑定则要求仍无基线）
  const stageBaselinesNow = deliverBaselines({ journal: task.journal, reports: task.reports.filter((r) => r.stage === stage) })
  const baseNow = stageBaselinesNow.get(pkg) ?? null
  const prevId = refresh.previousReportId ?? null
  if ((baseNow?.report.reportId ?? null) !== prevId || (baseNow?.report.ver ?? 1) !== (refresh.previousVer ?? 1)) {
    throw fail("DECISION_STALE", "刷新卡签发后该包有效基线已变化（卡绑定 " + (prevId ?? "无") + " v" + (refresh.previousVer ?? 1) + "，当前 " + (baseNow?.report.reportId ?? "无") + " v" + (baseNow?.report.ver ?? 1) + "）：本卡过期，重新准备刷新卡。")
  }
  // —— B8：一次读取原始字节（校验与写快照共用同一份，消除两次读取间的变化窗口）——
  const files = Array.isArray(refresh.files) ? refresh.files : []
  if (files.length === 0) {
    throw fail("DECISION_STALE", "刷新卡缺少候选清单（账本字段不全）：重新调 tw refresh-artifacts 准备新卡")
  }
  const readBytes = await import("./persistence/file-artifact-repository.mjs")
  const bytesByPath = new Map()
  for (const f of files) {
    let bytes
    try {
      bytes = await readBytes.readStableArtifactBytes(projectRoot, f.path)
    } catch (error) {
      throw fail("DECISION_STALE", "路径 " + f.path + " 已不可读取（" + (error?.code ?? error?.message) + "）：刷新确认被拒绝且未产生新基线。重新准备刷新卡或先恢复文件。")
    }
    if (digestBytes(bytes) !== f.digest) {
      throw fail("DECISION_STALE", "路径 " + f.path + " 在确认前已变化（当前字节与卡片 SHA 不一致）：本次不提交任何刷新事实。请重新调 tw refresh-artifacts 准备新卡（旧卡会自动失效重签）。")
    }
    bytesByPath.set(f.path, bytes)
  }
  // 受影响评审仍在途时不得提交：Lead 在锁外等其安全结束，或按既有 retire 作废未结评审波后重试。
  const inflight = inflightBatch({ journal: task.journal, reports: task.reports })
  if (inflight && inflight.open.some((d) => d.role === "challenger" || d.role === "expert")) {
    throw fail("USAGE", "受影响评审仍在途（" + inflight.open.map((d) => d.key + "（" + d.role + "）").join("、") + "）：本次刷新决定不得提交。等评审安全结束后重试本 decide；或先 tw retire --wave " + String(inflight.waveId) + " 作废未结评审波（已结评审不强行 retire），再重新准备刷新卡。")
  }
  const at = new Date().toISOString()
  const kindOfPath = (rel) => {
    if (multiNow) {
      const entries = (task.packages.find((p) => p.id === pkg)?.writable ?? []).map(parseWritableEntry)
      return writableMatch(entries, rel)?.artifactKind ?? "misc"
    }
    const wl = lastOwnerWritable(task, stage) ?? []
    return writableMatch(wl, rel)?.artifactKind ?? "misc"
  }
  // 快照先写并核验（B8：写后重读验证字节与摘要一致——核验实际写入的快照）
  const filesPublic = []
  for (const f of files) {
    const bytes = bytesByPath.get(f.path)
    const snapFile = path.join(task.root, "snapshots", f.digest + ".json")
    let priorSnap = null
    try { priorSnap = JSON.parse(await readFile(snapFile, "utf8")) } catch { priorSnap = null }
    const labels = new Set([...(Array.isArray(priorSnap?.paths) ? priorSnap.paths : []), ...(priorSnap?.path ? [priorSnap.path] : []), f.path])
    await atomicJson(snapFile, { format: "bytes-v1", digestAlgorithm: BYTES_DIGEST_ALGORITHM, digest: f.digest, path: f.path, paths: [...labels], encoding: "base64", data: bytes.toString("base64"), at })
    // 写后核验：重读快照并验证字节摘要（写失败/半态在此暴露，不留未核验快照进提交事实）
    const verifySnap = JSON.parse(await readFile(snapFile, "utf8"))
    if (verifySnap.format !== "bytes-v1" || typeof verifySnap.data !== "string" || digestBytes(Buffer.from(verifySnap.data, "base64")) !== f.digest) {
      throw fail("STATE_CORRUPT", "快照写入后核验失败（" + f.path + "）：本次不提交任何刷新事实。检查磁盘状态后重试。")
    }
    filesPublic.push({ ...f, kind: kindOfPath(f.path), snapshotRef: "snapshots/" + f.digest + ".json" })
  }
  // 刷新报告（§6.2.1-4）：kind=deliver、outcome=delivered、来源 user-authorized-lead-refresh、作者 Lead；
  // 报告 ID 固定 refresh-<decisionId>、ver 1；不伪造 Owner dispatchKey，不充当 Owner 轮次。
  const roundsNow = projectRounds({ journal: task.journal, reports: task.reports.filter((r) => r.stage === stage) })
  const reportId = "refresh-" + pending.decisionId
  const paths = files.map((f) => f.path)
  const payload = { outcome: "delivered", summary: "Lead 受控刷新（用户确认 decisionId " + pending.decisionId + "）：" + String(refresh.reason ?? ""), paths: [...paths].sort() }
  const payloadDigest = digestValue(payload)
  const report = {
    reportId, dispatchKey: null, role: "owner", kind: "deliver",
    round: Math.max(roundsNow.get(pkg) ?? 0, 0), stage, package: pkg, ver: 1,
    origin: "user-authorized-lead-refresh", author: "lead",
    decisionId: pending.decisionId, ...(refresh.previousReportId ? { replacedReport: { reportId: refresh.previousReportId, ver: refresh.previousVer ?? null } } : {}),
    payloadDigest, files: filesPublic, payload, at,
  }
  // 受影响未决卡预判（§6.2.2-5/B8）：以刷新后每包指纹对比各卡绑定——字节不变（指纹相同）时
  // 的基线身份失效由 gate 新鲜度的基线提交序条件统一保证（decided 须晚于全部基线 report 事件）。
  const itemsAfter = refreshArtifactsAfter(task, { stage, pkg, files: filesPublic, reportId })
  const pkgArr = multiNow ? task.packages : null
  const newFp = artifactFingerprints(itemsAfter.filter((i) => i.stage === stage), pkgArr)
  const settled = new Set(task.journal.filter((e) => e.type === "decided").map((e) => e.detail?.decisionId).filter(Boolean))
  // R3-7：本次刷新提交将占据的起始 seq——签发早于它的人工门卡即绑定旧基线（同字节指纹不变也收口）
  const refreshFloor = task.journal.length + 1
  const supersededCards = []
  for (const e of task.journal) {
    if (e.type !== "decision-issued" || !e.detail?.decisionId) continue
    if (e.detail.decisionId === pending.decisionId || settled.has(e.detail.decisionId)) continue
    const bound = e.detail?.fingerprints?.artifactFingerprint
    if (!bound || typeof bound !== "object") continue // 只按实际绑定的阶段/包/报告指纹判断失效，不作废无关卡
    const boundStage = e.detail.stage ?? currentStageOf(task.journal.filter((event) => (event.seq ?? 0) <= (e.seq ?? 0)), task.scope)
    const packageKey = String(pkg ?? null)
    // 同字节的新报告身份也会使该包相关门卡失效，但无关阶段或未绑定该包的卡不能被波及。
    const affected = boundStage === stage && Object.prototype.hasOwnProperty.call(bound, packageKey)
    const staleByFp = affected && newFp[packageKey] !== bound[packageKey]
    const issuedBeforeRefresh = affected && (e.seq ?? 0) < refreshFloor && e.detail.gateId != null
    if (staleByFp || issuedBeforeRefresh) supersededCards.push({ decisionId: e.detail.decisionId, reason: "刷新形成新基线（报告身份已更新），卡片绑定过期（不写 accept，重新评审/确认后签发新卡）" })
  }
  // 一次 journal 原子替换（B2/B8 唯一权威）：decided(本卡) + report-committed(完整刷新报告事实，含 payload) + 受影响卡 decided:superseded。
  const events = [
    { type: "decided", detail: { decisionId: pending.decisionId, choice: picked.label, grant: "confirm-refresh", gateId: null, package: pkg, refresh: { reportId, files: files.map((f) => ({ path: f.path, digest: f.digest })), reason: refresh.reason ?? null }, ...(note ? { note } : {}) } },
    { type: "report-committed", detail: { reportId, dispatchKey: null, kind: "deliver", role: "owner", package: pkg, stage, outcome: "delivered", ver: 1, origin: "user-authorized-lead-refresh", files: filesPublic, writable: multiNow ? (task.packages.find((p) => p.id === pkg)?.writable ?? []).map(parseWritableEntry) : (lastOwnerWritable(task, stage) ?? []), paths: payload.paths, payloadDigest, payload, author: "lead", decisionId: pending.decisionId, ...(report.replacedReport ? { replacedReport: report.replacedReport } : {}), round: report.round } },
    ...supersededCards.map((c) => ({ type: "decided", detail: { decisionId: c.decisionId, choice: "superseded", reason: c.reason } })),
  ]
  await appendEventsUnlocked(task, events)
  // 视图（崩溃可由 journal 事件重建：loadTask 以 report-committed 事实合并报告）
  await mkdir(path.join(task.root, "reports"), { recursive: true })
  await atomicJson(path.join(task.root, "reports", reportId + ".json"), report)
  const decisionsFile = path.join(task.root, "decisions.json")
  const existingDecisions = JSON.parse(await readFile(decisionsFile, "utf8").catch((error) => {
    if (error.code === "ENOENT") return '{"items":[]}'
    throw error
  }))
  existingDecisions.items.push({ decisionId: pending.decisionId, gateId: null, choice: picked.label, grant: "confirm-refresh", package: pkg, refresh: { reportId }, proof: { mode: "journal-committed", at }, at })
  await atomicJson(decisionsFile, existingDecisions)
  await atomicJson(path.join(task.root, "artifacts.json"), { items: itemsAfter, journalSeq: task.journal.length + events.length })
  return {
    ok: true, task: name, decisionId: pending.decisionId, choice: picked.label,
    refresh: { reportId, package: pkg ?? null, files: files.map((f) => ({ path: f.path, digest: f.digest })), supersededCards: supersededCards.map((c) => c.decisionId) },
    next: "run",
    note: "刷新已提交（决定、Lead 来源待审报告与受影响旧门作废为同一原子提交）：新基线待评审；旧 Challenger/Expert 与人工批准指纹失效，须重新评审并重新取得人工确认。",
  }
}
// 刷新后 items 预计算：本阶段该包清单整体替换为刷新 files；其他包与其他阶段条目保留。
function refreshArtifactsAfter(task, { stage, pkg, files, reportId }) {
  const items = task.artifacts.items.filter((i) => i.stage !== stage)
  const stageItems = task.artifacts.items.filter((i) => i.stage === stage)
  for (const item of stageItems) {
    const owner = item.package ?? null
    if (owner === (pkg ?? null)) continue // 该包整体替换
    items.push(item)
  }
  for (const f of files) {
    items.push({ path: f.path, digest: f.digest, digestAlgorithm: f.digestAlgorithm, kind: f.kind, stage, ...(pkg != null ? { package: pkg } : {}), reportRef: reportId, snapshotRef: f.snapshotRef })
  }
  return items
}

// —— §6.3 package-recovery 确认：按卡绑定解除该包 blocked（+ 如有候选计划一并原子提交）——
async function decidePackageRecoveryCard({ projectRoot, task, name, pending, picked, note }) {
  const rec = pending.recovery ?? {}
  const pkg = pending.package ?? null
  if (picked.grant === "cancel") {
    await appendEventsUnlocked(task, [{ type: "decided", detail: { decisionId: pending.decisionId, choice: picked.label, grant: "cancel", ...(note ? { note } : {}) } }])
    return { ok: true, task: name, decisionId: pending.decisionId, choice: picked.label, next: "run", note: "恢复卡已取消：该包保持 blocked，其他卡不受影响。" }
  }
  // R3-9：共享先决条件——未决意图/迁移卡在场时，肯定性恢复被阻止（仅安全取消可用）；计划变更须先过意图确认。
  if (picked.grant === "retry" || picked.grant === "remove") {
    const { open: openRec } = pendingDecisionsOf({ journal: task.journal })
    const blocking = openRec.filter((c) => c.detail?.decisionId !== pending.decisionId && (c.detail?.migrate || c.detail?.gateId === INTAKE_GATE))
    if (blocking.length) {
      throw fail("USAGE", "存在未决前置卡（" + blocking.map((c) => c.detail.decisionId + (c.detail.migrate ? "（迁移冲突）" : "（意图确认）")).join("、") + "）：按包恢复不得绕过先决条件。先处理前置卡，或取消本恢复卡。")
    }
    // 计划变更类恢复（retry 带候选 / remove）要求当前存在与计划一致的有效意图确认
    const hasIntake = task.journal.some((event) => event.type === "decision-issued" && event.detail?.gateId === INTAKE_GATE && effectiveIntakeIssued(task, event.detail))
    if (rec.plan || picked.grant === "remove" || hasIntake) {
      const stateInfo = await intakeState(task)
      const targetPlan = rec.plan ?? (picked.grant === "remove" ? (Array.isArray(task.packages) ? task.packages.filter((p) => p.id !== pkg) : null) : task.packages)
      const changed = digestValue(targetPlan ?? null) !== digestValue(task.packages ?? null)
      const accepted = changed ? candidateConfirmedIntake(task, pending.decisionId) : currentConfirmedIntake(task)
      const targetFingerprint = changed ? digestValue(intakeSnapshot({ task, roles: stateInfo.roles, packages: targetPlan })) : stateInfo.fingerprint
      const acceptedCard = task.journal.find((e) => e.type === "decision-issued" && e.detail?.decisionId === accepted?.decisionId)?.detail
      const candidateBound = !changed || (acceptedCard?.recoveryAuthorization?.decisionId === pending.decisionId && acceptedCard.recoveryAuthorization.currentFingerprint === stateInfo.fingerprint && acceptedCard.recoveryAuthorization.planDigest === digestValue(targetPlan))
      if (!accepted || accepted.unavailable || accepted.fingerprint !== targetFingerprint || !candidateBound) {
        throw fail("USAGE", "候选计划尚未获得与当前事实一致的意图确认：重新准备恢复卡，先确认其对应的候选计划意图卡，再决定恢复。")
      }
    }
  }
  // B11：锁内重核当前计划仍是卡绑定的版本（计划摘要一致才消费；重放/过期不解除）
  if (rec.currentPlanDigest != null) {
    const currentItems = Array.isArray(task.packages) ? task.packages : null
    if (digestValue(currentItems ?? null) !== rec.currentPlanDigest) {
      throw fail("DECISION_STALE", "恢复卡签发后包计划已变化（计划摘要与卡不一致）：本卡过期，重新准备恢复卡。")
    }
  }
  // 锁内核验：目标包当前有效 blocked 报告仍是卡绑定的 key/ver（重放不消费新版本）
  const stageId = deriveTask(task).stage
  const stageReports = task.reports.filter((r) => r.stage === stageId)
  const blockedSet = effectiveBlockedSetOf(task, stageId)
  const current = blockedSet.get(pkg) ?? null
  if (!current || current.dispatchKey !== rec.dispatchKey || (current.ver ?? 1) !== (rec.reportVersion ?? 1)) {
    throw fail("DECISION_STALE", "该恢复卡绑定的 blocked 报告（" + rec.dispatchKey + "#v" + (rec.reportVersion ?? 1) + "）与当前有效 blocked 状态不符（当前：" + (current ? current.dispatchKey + "#v" + (current.ver ?? 1) : "无") + "）：旧卡不可消费新版本。请 tw run 查看最新 blockedPackages 证据后重新准备恢复卡。")
  }
  const at = new Date().toISOString()
  // B11：journal 单次原子提交（决定 + 完整计划事实 + blocked-resolved），packages.json 视图随后重建
  const events = [{ type: "decided", detail: { decisionId: pending.decisionId, choice: picked.label, grant: picked.grant ?? null, ...(note ? { note } : {}) } }]
  let planToWrite = null
  let planNote = ""
  if (picked.grant === "retry") {
    if (rec.plan && digestValue(rec.plan) !== digestValue(task.packages ?? null)) {
      planToWrite = rec.plan
      events.push({ type: "re-planned", detail: { packages: rec.plan.map((p) => p.id), items: rec.plan, source: "package-recovery", decisionId: pending.decisionId } })
      planNote = "；候选计划已提交"
    }
    events.push({ type: "blocked-resolved", detail: { decisionId: pending.decisionId, package: pkg, dispatchKey: rec.dispatchKey, reportVersion: rec.reportVersion ?? 1, action: "retry", ...(rec.planDigest ? { planDigest: rec.planDigest } : {}) } })
  } else if (picked.grant === "remove") {
    // B11：remove 用获确认的完整候选计划（准备时已验证不含该包）；无候选时从当前计划移除该包
    const rest = Array.isArray(rec.plan) && rec.plan.length
      ? rec.plan
      : (Array.isArray(task.packages) ? task.packages : []).filter((p) => p.id !== pkg)
    planToWrite = rest
    events.push({ type: "re-planned", detail: { packages: rest.map((p) => p.id), items: rest, source: "package-recovery-remove", decisionId: pending.decisionId, removed: pkg } })
    events.push({ type: "blocked-resolved", detail: { decisionId: pending.decisionId, package: pkg, dispatchKey: rec.dispatchKey, reportVersion: rec.reportVersion ?? 1, action: "remove", ...(rec.planDigest ? { planDigest: rec.planDigest } : {}) } })
    planNote = "；包 " + pkg + " 已按用户批准从计划移除（原报告/快照保留审计，新名称不继承旧包制品）"
  } else if (picked.grant === "cancel") {
    // 仅收口本卡
  } else {
    throw fail("DECISION_STALE", "包恢复卡只接受 retry/remove/取消 选项")
  }
  await appendEventsUnlocked(task, events)
  if (planToWrite) await atomicJson(path.join(task.root, "packages.json"), { items: planToWrite })
  return { ok: true, task: name, decisionId: pending.decisionId, choice: picked.label, changed: planToWrite !== null, next: "run", note: "包 " + (pkg ?? "（单 owner）") + " 的 blocked 已按用户确认解除（绑定 " + rec.dispatchKey + "#v" + (rec.reportVersion ?? 1) + "）" + planNote + "；正常推进后按新范围派发。" }
}

function effectiveBlockedSetOf(task, stageId) {
  return effectiveBlockedSet({ journal: task.journal, reports: task.reports.filter((r) => r.stage === stageId), packages: Array.isArray(task.packages) && task.packages.length ? task.packages : null })
}

async function cmdDecide({ projectRoot, name, choice, note, decisionId }) {
  const { workflow, policy } = await loadDefinitions(projectRoot)
  const task0 = await loadTask(projectRoot, name, { workflow, policy })
  return withOwnerLock(path.join(task0.root, "locks", "task.lock"), async () => {
    const task = await loadTask(projectRoot, name, { workflow, policy })
    checkIntakeVersion(task)
    // —— §6.2.2 按 ID 定位，不按队首猜 ——
    // 多卡投影与 derive/run/dispatch-plan 同源（pendingDecisionsOf：migrate 冲突卡仅是列表一员，
    // 不再垄断选择；排序只用于展示）。多张有效待决卡时缺 ID 同步拒绝并列出全部 ID/用途；
    // 单张时普通历史卡保留无 ID 兼容，意图卡/刷新卡/包恢复卡仍必须携带实际被答复的 ID。
    const { open: openCards } = pendingDecisionsOf({ journal: task.journal })
    if (openCards.length === 0 && (decisionId === undefined || decisionId === null || decisionId === "")) {
      throw fail("DECISION_STALE", "当前没有等待中的决定")
    }
    // 已决 ID 的幂等重放（§6.2.2-2：仅同 ID 同选项幂等重显自身结果；B9：不同选项、已作废卡
    // 与损坏 ID 一律返回 stale，不冒充成功也不消费其他卡）——优先于空待决列表检查。
    if (decisionId !== undefined && decisionId !== null && decisionId !== "") {
      // B9：同 ID 不同正文的损坏账本——不能靠顺序猜测，拒绝肯定性选择（安全取消走重签/人工修复）
      if (duplicateIssuedIds(task.journal).includes(decisionId)) {
        throw fail("DECISION_STALE", "卡片 " + decisionId + " 在 journal 中存在多条不同正文（账本损坏）：不能按顺序猜测答复。请人工核对 journal 的 decision-issued 事件，修复或重签后再 decide。")
      }
      const decidedEvents = task.journal.filter((e) => e.type === "decided" && e.detail?.decisionId === decisionId)
      const decidedEvent = decidedEvents.at(-1)
      if (decidedEvent && !openCards.some((c) => c.detail?.decisionId === decisionId)) {
        if (String(decidedEvent.detail.choice) === "superseded") {
          throw fail("DECISION_STALE", "卡片 " + decisionId + " 已被作废（superseded，非用户答复）：其批准或刷新语义不可复用。请查看当前待决卡（" + (openCards.map((c) => c.detail.decisionId).join("、") || "无") + "）或调 tw-dispatch / tw dispatch-plan 重签最新卡片。")
        }
        // 重放须匹配原选项：本次 choice 与已决 choice 不同 → stale（不把新选项冒充为已决成功）
        const issuedForId = task.journal.filter((e) => e.type === "decision-issued" && e.detail?.decisionId === decisionId).at(-1)?.detail
        const originalPick = (issuedForId?.choices ?? []).find((o) => o.label === decidedEvent.detail.choice)
        if (originalPick && choice !== undefined && choice !== null && originalPick.n !== choice) {
          throw fail("DECISION_STALE", "卡片 " + decisionId + " 此前已按选项 " + originalPick.n + "（" + decidedEvent.detail.choice + "）决定；不同选项不能通过重放变更。当前有效待决卡：" + (openCards.map((c) => c.detail.decisionId).join("、") || "无") + "。")
        }
        return { ok: true, task: name, decisionId, choice: decidedEvent.detail.choice, replay: true, next: "run", note: "该卡片此前已决定（幂等重放原结果）：不重复提交，也不消费其他待决卡。后续仍须核验磁盘与当前基线一致。" }
      }
    }
    if (openCards.length === 0) throw fail("DECISION_STALE", "当前没有等待中的决定")
    const mustHaveId = openCards.length > 1
      || ["artifact-refresh", "package-recovery"].includes(openCards[0].kind)
      || openCards[0].detail?.gateId === INTAKE_GATE
    let card = null
    if (decisionId !== undefined && decisionId !== null && decisionId !== "") {
      card = openCards.find((c) => c.detail?.decisionId === decisionId) ?? null
      if (!card) {
        throw fail("DECISION_STALE", `卡片 ${decisionId} 不存在或不属于本任务。当前有效待决卡：${openCards.map((c) => `${c.detail.decisionId}（${cardPurpose(c)}）`).join("、")}。请用实际向用户展示且被答复的卡片 ID 重新 decide。`)
      }
    } else {
      if (mustHaveId) {
        throw fail("DECISION_STALE", `当前有 ${openCards.length} 张有效待决卡（${openCards.map((c) => `${c.detail.decisionId}（${cardPurpose(c)}）`).join("、")}），必须用 --decision-id 指定实际答复的卡片。`)
      }
      card = openCards[0]
    }
    // 恢复账本原卡字段（openCards 元素 = {seq, detail, kind}；decide 校验一律按 journal 原 detail 同钉）
    const pending = card.detail
    const options = pending.choices ?? []
    const picked = options.find((o) => o.n === choice)
    if (!picked) throw fail("DECISION_STALE", `选项序号 ${choice} 不在卡片 ${pending.decisionId} 中。合法选项：${options.map((o) => `${o.n}=${o.label}`).join("、")}`)
    // —— §6.2.1/§6.3 刷新卡与包恢复卡的确认分支（原子提交，不走通用 decide 路径）——
    if (card.kind === "artifact-refresh" || pending.kind === "artifact-refresh") return decideRefreshCard({ projectRoot, task, name, pending, picked, choice, note })
    if (card.kind === "package-recovery" || pending.kind === "package-recovery") return decidePackageRecoveryCard({ projectRoot, task, name, pending, picked, choice, note })

    const stageId = deriveTask(task).stage
    const current = task.artifacts.items.filter((item) => item.stage === stageId)
    // F5/F6 指纹（决定落盘与 gate 判定共用同一导出纯函数；R4 同源）
    const stageDef = task.workflow.stages.find((st) => st.id === stageId)
    const sp = scenePolicy(task.policy, stageDef?.teamScene ?? "implementation")
    const pkgArr = Array.isArray(task.packages) && task.packages.length ? task.packages : null
    const artifactFp = artifactFingerprints(current, pkgArr)
    const reviewFp = reviewChainFingerprint({ reports: task.reports.filter((r) => r.stage === stageId), journal: task.journal, core: Boolean(sp.core) })
    // F6-3 + R3-7：未决人工门卡做「签发指纹 vs 当前指纹」与「签发序 vs 基线提交序」双重对比——
    // 同字节刷新（指纹不变）形成新基线身份后，旧卡签发早于新基线，迟到 accept 一律拒绝（须重签）。
    if (pending.gateId && pending.fingerprints && !humanDecisionFresh({ decided: pending.fingerprints, artifactFp, reviewFp })) {
      throw fail("DECISION_STALE", "该卡片的签发指纹已失效（等待期评审链或制品发生变化）：tw run 查看状态，调 tw-dispatch / tw dispatch-plan 重签最新卡片后重新 decide")
    }
    if (pending.gateId && pending.gateId !== INTAKE_GATE) {
      const floor = baselineCommitFloor({ journal: task.journal, reports: task.reports.filter((r) => r.stage === stageId) })
      const issuedSeq = Math.max(-1, ...task.journal.filter((e) => e.type === "decision-issued" && e.detail?.decisionId === pending.decisionId).map((e) => e.seq ?? -1))
      if (issuedSeq < floor) {
        throw fail("DECISION_STALE", "该卡片签发后基线报告身份已更新（刷新或迟到重交形成新基线）：旧卡不可批准。调 tw-dispatch / tw dispatch-plan 重签最新卡片后重新 decide。")
      }
    }
    // §6.2/§6.2.2-3：人工门 accept 前实时核验磁盘原始字节与各包有效清单摘要——脏盘批准同步拒绝
    // （不写决定、不作废卡片；用户将文件按授权恢复到报告摘要后可用同一张卡自己的 ID 再批准）。
    if (pending.gateId && pending.gateId !== INTAKE_GATE && picked.label === "accept") {
      // 与刷新、包恢复及展示层同口径：未决迁移/意图卡必须先处理，安全结束不受此守卫影响。
      const blocking = openCards.filter((c) => c.detail?.decisionId !== pending.decisionId && (c.detail?.migrate || c.detail?.gateId === INTAKE_GATE))
      if (blocking.length) {
        throw fail("USAGE", "存在未决前置卡（" + blocking.map((c) => c.detail.decisionId + (c.detail.migrate ? "（迁移冲突）" : "（意图确认）")).join("、") + "）：人工门批准不得绕过先决条件。先处理前置卡后再批准，或安全结束任务。")
      }
      const verification = await verifyStageArtifacts(projectRoot, task, stageId)
      if (!verification.ok) {
        throw fail("USAGE", "磁盘内容与登记摘要不一致，人工门批准被拒绝（不写决定；本卡保留待决）：\n- " + verification.mismatches.map((m) => (m.path ?? "?") + "：" + m.reason + "（期望 " + (m.expected ?? "?") + (m.actual ? "，实际 " + m.actual : "") + "）").join("\n- ") + "\n恢复：tw restore --task " + name + " --path <路径> 从有效快照恢复原始字节，或 Lead 在用户明确确认后用 tw refresh-artifacts 刷新待审基线。")
      }
    }
    // 升档审批机制已删除：历史未决升档卡保持审计事实，但不再可答（收口由 dispatch 通道完成）。
    if (isLegacyEscalationCard(pending)) {
      throw fail("DECISION_STALE", "该卡属于已删除的升档审批机制：调 tw-dispatch（或 tw dispatch-plan）推进一次即自动收口（decided:superseded）并重推导，随后按意图确认卡/模型配置重新推进")
    }
    // 意图确认卡：指纹必须与当前稳定投影一致（等待期改意图/roles/packages → 旧卡拒绝直答）；
    // unresolved 时不允许"确认开始"（确认语义是模型符合预期，不能假确认）。
    let intakeRoles = null
    let confirmedSnapshot = null
    if (pending.gateId === INTAKE_GATE) {
      if (pending.recoveryAuthorization && picked.grant === "revise-intake") {
        await appendEventsUnlocked(task, [{ type: "decided", detail: { decisionId: pending.decisionId, choice: picked.label, grant: "revise-intake" } }])
        return { ok: true, task: name, decisionId: pending.decisionId, next: "run", note: "候选计划意图卡已取消，未确认恢复计划；可重新准备。" }
      }
      const stateInfo = await intakeState(task)
      let confirmationSnapshot = stateInfo.snapshot
      if (pending.recoveryAuthorization) {
        const auth = pending.recoveryAuthorization
        const recoveryCard = pendingDecisionsOf({ journal: task.journal }).open.find((c) => c.detail.decisionId === auth.decisionId && c.detail.kind === "package-recovery")
        const recovery = recoveryCard?.detail.recovery
        if (!recovery || !Array.isArray(recovery.plan) || digestValue(recovery.plan) !== auth.planDigest || digestValue(task.packages ?? null) !== auth.currentPlanDigest || stateInfo.fingerprint !== auth.currentFingerprint) {
          throw fail("DECISION_STALE", "候选恢复计划或当前意图已变化：该候选意图卡不可确认，请重新准备恢复卡。")
        }
        confirmationSnapshot = intakeSnapshot({ task, roles: stateInfo.roles, packages: recovery.plan })
      }
      if (pending.intakeFingerprint !== digestValue(confirmationSnapshot)) {
        throw fail("DECISION_STALE", "意图、角色模型或包模型在签发后已变化：tw run 查看状态，调 tw-dispatch / tw dispatch-plan 重签确认卡后重新 decide")
      }
      intakeRoles = stateInfo.roles
      if (picked.grant === "accept-intake") {
        confirmedSnapshot = confirmationSnapshot
        const unresolved = ROLE_KEYS.filter((role) => !intakeRoles[role])
        if (unresolved.length) throw fail("INTAKE_ROLES_UNRESOLVED", "角色模型仍未解析（" + unresolved.join("、") + "）：补齐 DSH 当前 profile 的 team-work-dsh.tiers（tw models 查看）后 tw roles --resolve 重签确认卡；unresolved 时不能确认开始")
        // 旧版已签卡也须重新验证当前平台可写范围，不能仅凭 SHA 为历史错误放行。
        const confirmationTask = pending.recoveryAuthorization ? { ...task, packages: pendingDecisionsOf({ journal: task.journal }).open.find((c) => c.detail.decisionId === pending.recoveryAuthorization.decisionId).detail.recovery.plan } : task
        assertCompleteIntake(confirmationTask, stateInfo.roles)
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
      ...(pending.gateId === INTAKE_GATE ? { intakeFingerprint: pending.intakeFingerprint, modelRefs: intakeRoles, ...(pending.intakeVersion === 2 ? { intakeVersion: 2 } : {}) } : {}),
      ...(pending.gateId === INTAKE_GATE && pending.intake ? { intake: pending.intake } : {}),
      ...(confirmedSnapshot ? { intakeSnapshot: confirmedSnapshot } : {}),
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
    const existing = await readJson(file, { allowMissing: true }) ?? { items: [] }
    if (!Array.isArray(existing.items)) throw fail("STATE_CORRUPT", "决定记录格式损坏；保留原文件并先核对恢复。")
    existing.items.push(decision)
    const events = [{ type: "decided", detail: { decisionId: decision.decisionId, choice: decision.choice } }]
    let restorePackage = null
    let restoreRole = null
    if (picked.label === "结束任务" || picked.grant === "stop-task") events.push({ type: "task-completed", detail: { stage: stageId, by: "user", form: "partial" } })
    if (fresh && picked.grant === "retire-and-recreate") {
      events.push({ type: "session-reset", detail: { role: fresh.role, package: fresh.package ?? null, scene: fresh.scene ?? stageId, reason: "用户选择作废当前波、重开会话（全新上下文）", decisionId: pending.decisionId, fromModelRef: fresh.fromModelRef, toModelRef: fresh.toModelRef } })
    }
    if (fresh && picked.grant === "rollback-model") {
      if (fresh.target === "package" && fresh.package != null) {
        // 包级模型变更：回滚 packages[package].model（roles 未被改动，不动角色配置）。
        const restored = (Array.isArray(task.packages) ? task.packages : []).map((pkg) => pkg.id === fresh.package ? { ...pkg, model: normalizeModelRef(fresh.fromModelRef, "requiresFreshSession.fromModelRef") } : pkg)
        restorePackage = restored
        events.push({ type: "re-planned", detail: { packages: restored.map((pkg) => pkg.id), items: restored, source: "fresh-session-rollback", package: fresh.package, modelRef: fresh.fromModelRef, decisionId: pending.decisionId } })
      } else {
        restoreRole = fresh
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
    await appendEventsUnlocked(task, events, async () => {
      if (task.artifactsRebuilt) await atomicJson(path.join(task.root, "artifacts.json"), task.artifacts)
      await atomicJson(file, existing)
      if (restoreRole) await updateAgents(task, (agents) => {
        const roles = normalizeRoleEntries(agents.roles).roles
        agents.roles = { ...roles, [restoreRole.role]: normalizeModelRef(restoreRole.fromModelRef, "requiresFreshSession.fromModelRef") }
      })
    })
    // 决定与完整回滚计划先在 journal 同批提交；packages.json 只是可重建视图。
    if (restorePackage) await atomicJson(path.join(task.root, "packages.json"), { items: restorePackage })
    return { ok: true, task: name, decisionId: decision.decisionId, choice: decision.choice, next: "run" }
  })
}

// I8 + §6.2 恢复按有效报告选版本（用户拍板：retire 整包回退、restore 默认有效版本 + 历史恢复）：
//   默认从该路径所属的最新未作废有效报告查快照，先验证快照自身字节摘要再恢复原始字节；
//   --list 只读列出可验证的非作废报告版本；--source <reportId@ver> 恢复用户明确选择的历史版本。
//   恢复历史只写文件、不改变当前有效清单；字节不同于当前基线时后续门禁仍不通过（回执明确提示）。
//   快照兼容 bytes-v1（base64 原始字节）与旧 content（UTF-8 文本）两种格式。
async function readSnapshotBytes(taskRootDir, snapshotRef, expectedDigest, expectedAlgorithm) {
  // 与制品读取共用稳定读和防符号链接边界；归档与 restore 都不能跟随快照路径逃出任务目录。
  const { readStableArtifactBytes } = await import("./persistence/file-artifact-repository.mjs")
  const raw = await readStableArtifactBytes(taskRootDir, snapshotRef)
  let snap
  try { snap = JSON.parse(raw.toString("utf8")) } catch { throw fail("STATE_CORRUPT", "快照 " + snapshotRef + " 不是有效 JSON，请核对原文件或重新交付。") }
  if (!snap || typeof snap !== "object" || Array.isArray(snap)) throw fail("STATE_CORRUPT", "快照 " + snapshotRef + " 结构无效。")
  if (snap.digest != null && snap.digest !== expectedDigest) throw fail("STATE_CORRUPT", "快照 " + snapshotRef + " 的记录摘要与引用不一致。")
  const knownAlgorithms = [BYTES_DIGEST_ALGORITHM, "legacy-text", "legacy-digest-value"]
  if (snap.digestAlgorithm != null && (!knownAlgorithms.includes(snap.digestAlgorithm) || (snap.digestAlgorithm === BYTES_DIGEST_ALGORITHM) !== (expectedAlgorithm === BYTES_DIGEST_ALGORITHM))) throw fail("STATE_CORRUPT", "快照 " + snapshotRef + " 的摘要算法与登记不一致。")
  let bytes
  if (expectedAlgorithm != null && ![BYTES_DIGEST_ALGORITHM, "legacy-text", "legacy-digest-value"].includes(expectedAlgorithm)) throw fail("STATE_CORRUPT", "快照 " + snapshotRef + " 的摘要算法未知，不能猜测校验方式。")
  if (snap.format === "bytes-v1") {
    if (typeof snap.data !== "string") throw fail("STATE_CORRUPT", "快照 " + snapshotRef + " 缺少原始字节数据。")
    if (expectedAlgorithm !== BYTES_DIGEST_ALGORITHM || (snap.digestAlgorithm != null && snap.digestAlgorithm !== expectedAlgorithm)) throw fail("STATE_CORRUPT", "快照 " + snapshotRef + " 的字节摘要算法与登记不一致。")
    bytes = Buffer.from(snap.data, "base64")
    if (bytes.toString("base64") !== snap.data) throw fail("STATE_CORRUPT", "快照 " + snapshotRef + " 的 base64 内容无效。")
  } else if (typeof snap.content === "string") bytes = Buffer.from(snap.content, "utf8")
  else throw fail("STATE_CORRUPT", "快照 " + snapshotRef + " 缺少可恢复内容（无 data/content 字段）。")
  if (expectedAlgorithm === "sha256-bytes-v1") {
    if (digestBytes(bytes) !== expectedDigest) throw fail("STATE_CORRUPT", "快照 " + snapshotRef + " 的原始字节摘要不一致：请核对或重新交付。")
  } else if (digestValue(bytes.toString("utf8")) !== expectedDigest) {
    throw fail("STATE_CORRUPT", "快照 " + snapshotRef + " 的旧文本摘要不一致：请核对或重新交付。")
  }
  return bytes
}

// B6/§6.2 恢复按当前有效基线选版本：默认从该路径所属包**当前有效清单**查快照恢复原始字节；
// --list 只读列出可验证的非作废历史版本（journal 事件流保留每 ver 事实，含被视图覆盖的同 key 旧版）；
// --source 恢复用户明确选择的历史版本。写回沿用防逃逸/防符号链接保护（交付后路径被替换为
// 目录符号链接时拒绝越出项目）。历史恢复只写文件、不改当前有效清单；字节异于基线时后续门禁不通过。
async function cmdRestore({ projectRoot, name, target, source = null, list = false }) {
  if (!target || typeof target !== "string") throw fail("USAGE", "restore 需要 --path <项目内相对路径>（可恢复路径见 tw gate / 任务登记清单）")
  const { workflow, policy } = await loadDefinitions(projectRoot)
  const task = await loadTask(projectRoot, name, { workflow, policy, repair: true })
  // B6：候选版本从 journal 事件流取（每 (reportId, ver) 一条，非作废 delivered），视图文件只作补充。
  const excluded = supersededKeys(task.journal)
  const candidates = []
  const seenVer = new Set()
  const eventCandidates = []
  for (const e of task.journal) {
    if (e.type !== "report-committed" || !e.detail?.reportId) continue
    const d = e.detail
    if (d.kind !== undefined && d.kind !== "deliver") continue
    if (d.dispatchKey != null && excluded.has(d.dispatchKey)) continue
    if (d.outcome !== undefined && d.outcome !== "delivered") continue
    const paths = Array.isArray(d.payload?.paths) ? d.payload.paths.map(String) : (Array.isArray(d.paths) ? d.paths.map(String) : null)
    if (!paths || !paths.includes(target)) continue
    const fileEntry = (Array.isArray(d.files) ? d.files : []).find((f) => f.path === target)
    eventCandidates.push({
      seq: e.seq ?? 0, reportId: d.reportId, ver: d.ver ?? 1, dispatchKey: d.dispatchKey ?? null,
      stage: d.stage ?? null, package: d.package ?? null,
      digest: fileEntry?.digest ?? null, algorithm: fileEntry?.digestAlgorithm ?? null,
      snapshotRef: fileEntry?.snapshotRef ?? (fileEntry?.digest ? "snapshots/" + fileEntry.digest + ".json" : null),
      at: e.at ?? null,
    })
  }
  for (const cand of [...eventCandidates].sort((a, b) => a.seq - b.seq).reverse()) {
    const key = cand.reportId + "@" + cand.ver
    if (seenVer.has(key)) continue
    if (cand.digest && cand.snapshotRef) { seenVer.add(key); candidates.push(cand) }
  }
  // 旧事件（report-accepted / 无 files 的 report-committed）：报告文件 + 索引补
  if (candidates.length === 0) {
    const orderedReports = [...task.reports].sort(reportOrderComparator(task.journal))
    for (const report of [...orderedReports].reverse()) {
      if (report.role !== "owner" || report.kind !== "deliver" || report.payload?.outcome !== "delivered") continue
      if (report.dispatchKey != null && excluded.has(report.dispatchKey)) continue
      const paths = Array.isArray(report.payload?.paths) ? report.payload.paths.map(String) : []
      if (!paths.includes(target)) continue
      const key = report.reportId + "@" + (report.ver ?? 1)
      if (seenVer.has(key)) continue
      const fileEntry = (Array.isArray(report.files) ? report.files : []).find((f) => f.path === target)
      const item = fileEntry ? null : task.artifacts.items.find((i) => i.path === target && i.reportRef === report.reportId)
      const digest = fileEntry?.digest ?? item?.digest ?? null
      const algorithm = fileEntry?.digestAlgorithm ?? item?.digestAlgorithm ?? null
      const snapshotRef = fileEntry?.snapshotRef ?? item?.snapshotRef ?? (digest ? "snapshots/" + digest + ".json" : null)
      if (!digest || !snapshotRef) continue
      seenVer.add(key)
      candidates.push({ reportId: report.reportId, ver: report.ver ?? 1, dispatchKey: report.dispatchKey, stage: report.stage, package: report.package ?? null, digest, algorithm, snapshotRef, at: report.at })
    }
  }
  // B6：当前有效基线判定——默认恢复源必须属于某包当前有效完整清单（路径已移出全部当前清单时
  // 默认拒绝，历史内容只能显式 --source 选择）。
  const stageNow = currentStageOf(task.journal, task.scope)
  const currentBaselineOwner = (() => {
    const baselines = deliverBaselines({ journal: task.journal, reports: task.reports.filter((r) => r.stage === stageNow) })
    for (const [pkg, base] of baselines) {
      const paths = Array.isArray(base.report.files) && base.report.files.length > 0
        ? base.report.files.map((f) => f.path)
        : (Array.isArray(base.report.payload?.paths) ? base.report.payload.paths.map(String) : [])
      if (paths.includes(target)) return { package: pkg, reportId: base.report.reportId, ver: base.report.ver ?? 1 }
    }
    return null
  })()
  // B5/B6：--list 核验每个版本的快照在场且自洽（损坏/缺失的版本标注，不静默列出）
  if (list) {
    const versions = []
    for (const [i, c] of candidates.entries()) {
      let snapshotOk = true
      let snapshotError = null
      try { await readSnapshotBytes(task.root, c.snapshotRef, c.digest, c.algorithm) } catch (error) { snapshotOk = false; snapshotError = error?.message ?? String(error) }
      versions.push({ source: c.reportId + "@" + c.ver, current: Boolean(currentBaselineOwner && c.reportId === currentBaselineOwner.reportId && c.ver === currentBaselineOwner.ver), inCurrentManifest: Boolean(currentBaselineOwner && c.reportId === currentBaselineOwner.reportId), dispatchKey: c.dispatchKey, stage: c.stage, digestAlgorithm: c.algorithm ?? "legacy-text", digest: c.digest, at: c.at, ...(snapshotOk ? {} : { snapshotBroken: true, snapshotError }) })
    }
    return { ok: true, task: name, path: target, ...(currentBaselineOwner ? {} : { notInCurrentManifest: true }), versions }
  }
  if (source == null && !currentBaselineOwner) {
    throw fail("USAGE", "路径 " + target + " 不在任何当前有效清单中（可能已被完整清单语义移出）：默认只恢复当前基线；历史内容用 tw restore --task " + name + " --path " + target + " --list 查看后以 --source <报告@版本> 显式选择。")
  }
  return restoreExecute({ projectRoot, task, name, target, source, candidates, currentBaselineOwner })
}

async function restoreExecute({ projectRoot, task, name, target, source, candidates, currentBaselineOwner }) {
  // B6：写回前的防逃逸/防符号链接保护——交付后路径可能被替换为目录符号链接，写回前逐段核验
  // （与 readStableArtifactBytes 同口径；目标缺失时允许创建文件，但路径任何段不得为符号链接）。
  const safeWrite = async (bytes) => {
    const candidate = path.resolve(projectRoot, target)
    const rel = path.relative(path.resolve(projectRoot), candidate)
    if (rel === "" || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
      throw fail("USAGE", "恢复路径 " + target + " 越出项目根，拒绝写回。")
    }
    const segments = rel.split(path.sep)
    let cursor = path.resolve(projectRoot)
    for (let i = 0; i < segments.length - 1; i += 1) {
      cursor = path.join(cursor, segments[i])
      const st = await lstat(cursor).catch(() => null)
      if (st?.isSymbolicLink()) throw fail("USAGE", "恢复路径 " + target + " 的祖先段 " + segments[i] + " 是符号链接，拒绝写回（防越出项目根）。")
      if (!st) await mkdir(cursor, { recursive: true })
    }
    const finalSt = await lstat(candidate).catch(() => null)
    if (finalSt?.isSymbolicLink() || finalSt?.isDirectory()) throw fail("USAGE", "恢复目标 " + target + " 是符号链接或目录，拒绝覆盖。")
    await atomicWrite(candidate, bytes)
  }
  if (source != null) {
    const match = candidates.find((c) => c.reportId + "@" + c.ver === source || c.reportId === source)
    if (!match) {
      throw fail("USAGE", "--source " + source + " 不匹配路径 " + target + " 的任何可验证非作废版本。可选版本：" + (candidates.map((c) => c.reportId + "@" + c.ver).join("、") || "无") + "（用 tw restore --task " + name + " --path " + target + " --list 查看）")
    }
    const bytes = await readSnapshotBytes(task.root, match.snapshotRef, match.digest, match.algorithm)
    await safeWrite(bytes)
    const current = task.artifacts.items.find((i) => i.path === target)
    const matchesCurrent = current ? (current.digestAlgorithm === "sha256-bytes-v1" ? current.digest === digestBytes(bytes) : current.digest === match.digest) : null
    return { ok: true, task: name, restored: target, source: match.reportId + "@" + match.ver, digest: match.digest, ...(matchesCurrent === false ? { baselineMismatch: true } : {}), note: matchesCurrent === false ? "已按所选历史版本恢复文件内容（历史内容，当前有效基线未变）：如需成为当前基线，请成员按完整清单重新交付或由 Lead 在用户确认后刷新待审基线" : "已按所选版本恢复" }
  }
  // 默认恢复：当前有效基线所属版本（B6：不再取历史报告列表队首）
  const latest = currentBaselineOwner
    ? candidates.find((c) => c.reportId === currentBaselineOwner.reportId && c.ver === currentBaselineOwner.ver) ?? candidates[0]
    : candidates[0]
  if (!latest) throw fail("USAGE", "路径 " + target + " 没有可恢复的快照版本（tw restore --list 查看现状）。")
  const bytes = await readSnapshotBytes(task.root, latest.snapshotRef, latest.digest, latest.algorithm)
  await safeWrite(bytes)
  return { ok: true, task: name, restored: target, fromReport: latest.reportId + "@" + latest.ver, digest: latest.digest, versions: candidates.length, note: candidates.length > 1 ? "已从当前有效基线恢复（另有 " + (candidates.length - 1) + " 个历史版本，--list 查看 / --source 选择）；恢复后请成员重新 deliver 以刷新清单" : "已从当前有效基线恢复；恢复后请成员重新 deliver 以刷新清单" }
}

// —— §6.2.1 用户授权的 Lead 受控刷新（准备卡）——
// 只把用户确认的当前磁盘字节登记为待审基线：不替 Owner 编写文件、不声称技术正确、不代替评审或人工批准。
// 准备 = 锁内核对当前阶段/包/已批准可写范围/路径安全，稳定读取每条文件原始字节 SHA-256，
// 签发 kind=artifact-refresh 的确认卡（不改基线）；用户按实际答复的 decisionId 调 tw decide 确认后，
// 由 decide 的刷新分支做单次 journal 原子提交（决定 + Lead 刷新报告 + 受影响旧门作废）。
async function cmdRefreshArtifacts({ projectRoot, name, pkg = null, pathsJson = null, reason = null }) {
  if (!reason || !reason.trim()) throw fail("USAGE", "refresh-artifacts 需要 --reason <说明>（写入卡片供用户与审计查看刷新动机；reason 不替代用户确认）")
  const { workflow, policy } = await loadDefinitions(projectRoot)
  const task0 = await loadTask(projectRoot, name, { workflow, policy })
  return withOwnerLock(path.join(task0.root, "locks", "task.lock"), async () => {
    const task = await loadTask(projectRoot, name, { workflow, policy, repair: true })
    const state = deriveTask(task)
    const stageId = state.stage
    const multiPackage = Array.isArray(task.packages) && task.packages.length > 0
    if (multiPackage && pkg == null) throw fail("USAGE", "多包任务必须 --package <包ID> 明确选择一个活动包（刷新不能自动扩大到其他包）；可选包：" + task.packages.map((p) => p.id).join("、"))
    if (!multiPackage && pkg != null) throw fail("USAGE", "单 Owner 任务没有包概念，省略 --package")
    if (multiPackage && !task.packages.some((p) => p.id === pkg)) throw fail("USAGE", "包 " + pkg + " 不在当前计划中；可选包：" + task.packages.map((p) => p.id).join("、"))
    // 已批准可写范围：多包 = 该包 packages.json writable；单 Owner = 该阶段 owner 派单可写集。
    const approvedWritable = multiPackage
      ? (task.packages.find((p) => p.id === pkg)?.writable ?? []).map(parseWritableEntry)
      : (lastOwnerWritable(task, stageId) ?? [])
    // B7：已批准范围为空 = 无可依赖的授权边界——任何非空候选清单都拒绝（不能凭"无范围可查"放行
    // 任意路径；--paths 为空同理无意义）。先由 Lead 经正常流程（首派 writable / plan 包定义）建立范围。
    if (approvedWritable.length === 0) {
      throw fail("USAGE", "该任务当前没有可验证的已批准可写范围（多包查 packages.json 该包 writable；单 Owner 查本阶段 owner 派发可写集）：刷新不能在未知范围上登记基线。先经 tw plan（多包）或首派 --writable 建立授权范围后再试。")
    }
    // 新任务绑定可核验的已有意图确认；从未签过意图卡的旧任务则将可证范围完整放入
    // 本刷新卡，让用户明确确认旧范围与候选清单，不能把旧数据缺证据伪称新意图已确认。
    const stateInfo = await intakeState(task)
    const accepted = currentConfirmedIntake(task)
    const everIssued = task.journal.some((event) => event.type === "decision-issued" && event.detail?.gateId === INTAKE_GATE && effectiveIntakeIssued(task, event.detail))
    let intakeAuthorization
    if (!everIssued && task.scope?.intakeVersion !== 2) {
      const snapshot = legacyRefreshBinding(task, stateInfo, stageId, approvedWritable)
      intakeAuthorization = { mode: "legacy-range", fingerprint: digestValue(snapshot), snapshot }
    } else if (accepted && !accepted.unavailable && accepted.fingerprint === stateInfo.fingerprint) {
      intakeAuthorization = { mode: "confirmed-intake", decisionId: accepted.decisionId, fingerprint: accepted.fingerprint, snapshot: accepted.snapshot }
    } else {
      throw fail("USAGE", "当前没有与意图/角色/计划一致的有效确认：先由用户确认当前意图卡，再准备刷新。")
    }
    // 当前有效基线（旧清单展示与新清单缺省）
    const stageReports = task.reports.filter((r) => r.stage === stageId)
    const baselines = deliverBaselines({ journal: task.journal, reports: stageReports })
    const baseline = baselines.get(pkg ?? null) ?? null
    const previousFiles = baseline
      ? (Array.isArray(baseline.report.files) && baseline.report.files.length > 0
        ? baseline.report.files
        : task.artifacts.items.filter((i) => i.reportRef === baseline.report.reportId).map((i) => ({ path: i.path, digest: i.digest, digestAlgorithm: i.digestAlgorithm ?? null })))
      : []
    const previousPaths = previousFiles.map((f) => f.path)
    // 候选清单：显式 pathsJson 优先；缺省用当前有效基线完整路径集（无法确定时必须显式给全量）
    let requested = null
    if (pathsJson != null) {
      try { requested = JSON.parse(pathsJson) } catch { throw fail("USAGE", "--paths-json 不是合法 JSON 数组：'" + String(pathsJson).slice(0, 80) + "'") }
      if (!Array.isArray(requested) || requested.some((p) => typeof p !== "string")) throw fail("USAGE", "--paths-json 必须是完整路径的 JSON 字符串数组（要保留的旧文件也必须列入）")
    } else {
      if (!baseline) throw fail("USAGE", "该包当前无可验证的有效报告，无法推导缺省清单：必须显式提供 --paths-json '<完整路径 JSON 数组>'（不扫描目录猜测）")
      requested = [...previousPaths]
    }
    const reasons = []
    const seen = new Set()
    const normalized = []
    for (const p of requested) {
      const rel = String(p ?? "").trim().replace(/^\.\//, "")
      if (rel === "" || path.isAbsolute(rel) || rel.split("/").some((s) => s === "" || s === "." || s === "..")) { reasons.push("路径不合法：" + JSON.stringify(p)); continue }
      if (seen.has(rel)) { reasons.push("路径重复：" + rel); continue }
      seen.add(rel)
      if (approvedWritable.length > 0 && !writableMatch(approvedWritable, rel)) {
        reasons.push("路径 " + rel + " 超出已批准可写范围（" + approvedWritable.map((w) => w?.path ?? String(w)).join("、") + "）：刷新只能登记已授权范围内的当前字节；范围变化须先走包计划确认")
      }
      normalized.push(rel)
    }
    normalized.sort()
    if (normalized.length === 0) reasons.push("该包有已授权的可写产物范围，刷新完整清单不得为空；请明确提供要登记的完整路径")
    if (reasons.length) { const e = fail("USAGE", "刷新准备被拒绝：\n- " + [...new Set(reasons)].join("\n- ")); throw e }
    // 稳定读取每条文件的原始字节 SHA-256
    const files = []
    for (const rel of normalized) {
      try {
        const bytes = await import("./persistence/file-artifact-repository.mjs").then((m) => m.readStableArtifactBytes(projectRoot, rel))
        files.push({ path: rel, digestAlgorithm: BYTES_DIGEST_ALGORITHM, digest: digestBytes(bytes) })
      } catch (error) {
        throw fail("USAGE", "路径 " + rel + " 无法稳定读取（" + (error?.code ?? error?.message) + "）：刷新只登记可验证的当前字节；缺失/不可读文件先补齐或从清单移除后重试")
      }
    }
    // 幂等：相同候选（包+阶段+清单+SHA+reason）重复准备返回同一卡
    const settled = new Set(task.journal.filter((e) => e.type === "decided").map((e) => e.detail?.decisionId).filter(Boolean))
    const fingerprint = digestValue({ stage: stageId, package: pkg ?? null, files, reason: reason.trim(), previousReportId: baseline?.report.reportId ?? null, previousVer: baseline?.report.ver ?? null, planDigest: multiPackage ? digestValue(task.packages) : null, intakeConfirmedAtIssue: intakeAuthorization })
    for (const e of [...task.journal].reverse()) {
      if (e.type !== "decision-issued" || e.detail?.kind !== "artifact-refresh") continue
      if (settled.has(e.detail.decisionId)) continue
      if (e.detail.refresh?.fingerprint === fingerprint) {
        return { ok: true, task: name, status: "awaiting-user", next: "decide", transition: "await-decision", decisionId: e.detail.decisionId, kind: "artifact-refresh", ...(pkg != null ? { package: pkg } : {}), question: e.detail.reason, choices: e.detail.choices, proposed: { files: e.detail.refresh.files, added: e.detail.refresh.added ?? [], removed: e.detail.refresh.removed ?? [] }, binding: e.detail.refresh, note: "相同候选的刷新卡已签发（幂等返回同一标识）；等待用户按该卡实际 decisionId 确认" }
      }
    }
    // 条件变化重签：同包旧刷新卡若候选不同 → 作废旧卡再签新卡（只令刷新卡失效，不动其他卡）
    for (const e of [...task.journal].reverse()) {
      if (e.type !== "decision-issued" || e.detail?.kind !== "artifact-refresh") continue
      if (settled.has(e.detail.decisionId)) continue
      if ((e.detail.package ?? null) !== (pkg ?? null)) continue
      await appendEventsUnlocked(task, [{ type: "decided", detail: { decisionId: e.detail.decisionId, choice: "superseded", reason: "刷新候选变化（清单或字节 SHA 与卡不一致），旧卡作废重签" } }])
      break
    }
    const decisionId = "rf-" + randomBytes(4).toString("hex")
    // B7：卡绑定完整前提——计划摘要（多包）、原有效报告身份（已有）、意图确认状态；确认时锁内重核。
    const planDigest = multiPackage ? digestValue(task.packages) : null
    const added = normalized.filter((p) => !previousPaths.includes(p))
    const removed = previousPaths.filter((p) => !normalized.includes(p))
    const question = "刷新待审基线确认" + (pkg != null ? "（包 " + pkg + "）" : "") + "：旧清单 " + (previousPaths.join("、") || "（无有效报告）") + " → 新清单 " + normalized.join("、") + (added.length ? "；新增 " + added.join("、") : "") + (removed.length ? "；移出 " + removed.join("、") : "") + "。原因：" + reason.trim() + "。仅刷新待审基线（登记当前磁盘字节为 Lead 来源的新基线），不代表评审或人工批准通过；确认后旧评审与人工门指纹失效，须重新评审与确认。"
    const choices = [
      { n: 1, label: "确认刷新", desc: "以展示的清单与字节 SHA 登记 Lead 来源待审基线", grant: "confirm-refresh" },
      { n: 2, label: "取消", desc: "不刷新，收口本卡且不改变任何基线", grant: "cancel-refresh" },
    ]
    await appendEventsUnlocked(task, [{ type: "decision-issued", detail: {
      decisionId, kind: "artifact-refresh", gateId: null, package: pkg ?? null, stage: stageId,
      reason: question, choices,
      refresh: { fingerprint, files, previousReportId: baseline?.report.reportId ?? null, previousVer: baseline?.report.ver ?? null, stage: stageId, reason: reason.trim(), ...(planDigest ? { planDigest } : {}), added, removed, approvedWritable, intakeConfirmedAtIssue: intakeAuthorization },
    } }])
    return {
      ok: true, task: name, status: "awaiting-user", next: "decide", transition: "await-decision",
      decisionId, kind: "artifact-refresh", ...(pkg != null ? { package: pkg } : {}), stage: stageId,
      question, choices,
      binding: { approvedWritable, intakeConfirmedAtIssue: intakeAuthorization, previousReportId: baseline?.report.reportId ?? null, previousVer: baseline?.report.ver ?? null, planDigest },
      proposed: { files, ...(added.length ? { added } : {}), ...(removed.length ? { removed } : {}) },
      note: "刷新卡已签发（未改基线）：等待用户查看并以实际展示的 decision-id 调 tw decide 确认；确认前清单/字节再变化会让本卡失效重签。",
    }
  })
}

// 旧任务没有意图确认记录时，刷新卡直接展示并绑定可验证的旧范围；确认刷新仍需用户答复此卡。
function legacyRefreshBinding(task, stateInfo, stage, writable) {
  return { scope: task.scope, stage, intent: stateInfo.snapshot.intent, roles: stateInfo.snapshot.roles, packages: stateInfo.snapshot.packages, writable }
}

// 旧派单没有 stage 时，用入口和 stage-advanced 的事实顺序定位其阶段；
// 入口、阶段转换或显式 stage 自相矛盾时不猜范围，避免把上一阶段的授权挪到当前阶段。
function lastOwnerWritable(task, stageId) {
  const opened = task.journal.filter((e) => e.type === "task-opened").map((e) => e.detail?.entry).filter((entry) => typeof entry === "string" && entry)
  const entry = task.scope?.entry ?? opened[0]
  const stages = new Set((task.workflow?.stages ?? []).map((stage) => stage.id))
  if (typeof entry !== "string" || !entry || (stages.size && !stages.has(entry)) || opened.some((value) => value !== entry)) return null
  let current = entry
  let writable = null
  for (const e of task.journal) {
    if (e.type === "stage-advanced") {
      const { from, to } = e.detail ?? {}
      if ((from != null && from !== current) || typeof to !== "string" || !to || (stages.size && !stages.has(to))) return null
      current = to
    } else if (e.type === "dispatched" && e.detail?.role === "owner") {
      const declared = e.detail.stage
      if (declared != null && declared !== current) return null
      if (stageId == null || current === stageId) writable = Array.isArray(e.detail.writable) ? e.detail.writable : []
    }
  }
  return writable
}

// §6.2 阶段级实时核验：稳定读取当前阶段各包有效基线清单的磁盘字节并核对摘要。
// run/gate 只读展示用；dispatch-plan 在锁内推导前重算（advance/complete 前的核验结果经
// artifactVerification 传入 deriveTask → gateCheck，磁盘不一致时阶段不推进）。
async function verifyStageArtifacts(projectRoot, task, stageId) {
  const stageReports = (task.reports ?? []).filter((r) => r.stage === stageId)
  const baselines = deliverBaselines({ journal: task.journal ?? [], reports: stageReports })
  const files = []
  for (const [, base] of baselines) {
    const rep = base.report
    if (Array.isArray(rep.files) && rep.files.length > 0) {
      for (const f of rep.files) files.push({ path: f.path, digest: f.digest, digestAlgorithm: f.digestAlgorithm ?? null, snapshotRef: f.snapshotRef ?? ("snapshots/" + f.digest + ".json") })
    } else {
      const indexed = (task.artifacts?.items ?? []).filter((i) => i.reportRef === rep.reportId)
      for (const item of indexed) {
        files.push({ path: item.path, digest: item.digest, digestAlgorithm: item.digestAlgorithm ?? null, snapshotRef: item.snapshotRef })
      }
      for (const rel of rep.payload?.paths ?? []) if (!indexed.some((item) => item.path === rel)) files.push({ path: rel, digest: null })
    }
  }
  if (files.length === 0) return { ok: true, mismatches: [] }
  try {
    return await verifyArtifactBytes({ projectRoot, files, taskRoot: task.root })
  } catch (error) {
    return { ok: false, mismatches: [{ path: null, expected: null, actual: null, reason: "核验读取失败：" + String(error?.message ?? error) }] }
  }
}

// §6.3 blockedPackages 只读证据：包名、blocked 报告 key/version 与摘要（--blocked-ref 引用源）。
function blockedEvidenceOf(task, stageId) {
  const multi = Array.isArray(task.packages) && task.packages.length
  const blockedSet = effectiveBlockedSet({ journal: task.journal, reports: task.reports.filter((r) => r.stage === stageId), packages: multi ? task.packages : null })
  return [...blockedSet.entries()].map(([pkg, report]) => ({
    package: pkg,
    dispatchKey: report.dispatchKey ?? null,
    reportVersion: report.ver ?? 1,
    ref: (report.dispatchKey ?? "unknown") + "#v" + (report.ver ?? 1),
    summary: String(report.payload?.summary ?? "").slice(0, 160),
  }))
}

// F3 作废恢复边：tw retire（仅 Lead；命令面）。只增 dispatch-superseded {waveId, reason}（detail 不含 at，事件顶层已有 at）。
// 幂等矩阵：重复 retire 幂等返回；未知 waveId / 已结波 / 缺 reason 拒绝并附恢复指引（附当前未结波清单）。
// 已交付报告保留为审计事实、不参与推导（投影/快照/依赖/耗尽/回溯统一排除 superseded 波）；
// 保留该波映射供宿主核验旧写者；作废 key 由 supersededKeys 排除续派与交付。
async function cmdRetire({ projectRoot, name, wave, reason }) {
  if (!wave || !/^wv\d+$/.test(wave)) throw fail("USAGE", "retire 需要 --wave <wvN>（当前未结波见 wait-inflight 卡）")
  if (!reason || !reason.trim()) throw fail("USAGE", "retire 需要 --reason <作废原因>")
  const { workflow, policy } = await loadDefinitions(projectRoot)
  const task0 = await loadTask(projectRoot, name, { workflow, policy })
  const initial = waveGroups(task0.journal).find((group) => group.waveId === wave)
  const initialInflight = inflightBatch({ journal: task0.journal, reports: task0.reports })
  const initialHint = initialInflight ? "当前未结波：" + (initialInflight.waveId ?? "历史派单 " + initialInflight.open[0].key) : "当前无未结波"
  if (!initial) throw fail("RETIRE_UNKNOWN_WAVE", "未知波 " + wave + "；" + initialHint + "。请核对 wait-inflight 卡后重试。")
  if (initial.keys.some((key) => typeof key !== 'string' || !key) || new Set(initial.keys).size !== initial.keys.length) throw fail('STATE_CORRUPT', '波内派单 key 缺失或重复，不能确定锁集合；请先核对账本。')
  // 与宿主对账使用同一路径及 key 字典序；先全部投递锁，最后才短持 task.lock，绝不反向等待。
  const keys = [...initial.keys].sort()
  const withKeys = async (index, action) => index === keys.length
    ? action()
    : withOwnerLock(dispatchLockPath(projectRoot, name, keys[index]), () => withKeys(index + 1, action))
  return withKeys(0, () => withOwnerLock(path.join(task0.root, 'locks', 'task.lock'), async () => {
    const task = await loadTask(projectRoot, name, { workflow, policy, repair: true })
    const group = waveGroups(task.journal).find((g) => g.waveId === wave)
    if (!group || JSON.stringify([...group.keys].sort()) !== JSON.stringify(keys)) throw fail('RETIRE_RETRY', '等待投递锁期间波的派单集合已变化；未作废，请重读任务事实再重试。')
    const registry = await readRegistry(task)
    if (task.journal.some((e) => e.type === 'dispatch-superseded' && e.detail?.waveId === wave)) {
      return { ok: true, task: name, wave, idempotent: true, writerSafety: writerSafetyOf(task, registry, null, new Set(keys)), note: '该波此前已作废；旧写者仍须核实停写或撤权。' }
    }
    const settled = new Set(task.reports.map((r) => r.dispatchKey))
    if (keys.every((key) => settled.has(key))) {
      const active = inflightBatch({ journal: task.journal, reports: task.reports })
      throw fail('RETIRE_SETTLED_WAVE', '波 ' + wave + ' 已全部交付；retire 仅适用于未结波。' + (active ? '当前未结波：' + (active.waveId ?? active.open[0].key) : '当前无未结波'))
    }
    await appendEventsUnlocked(task, [{ type: 'dispatch-superseded', detail: { waveId: wave, reason } }])
    // 作废只影响有效基线，不删除映射：原 sessionId 是后续核对旧写者是否仍在运行的必要证据。
    const afterRetire = await loadTask(projectRoot, name, { workflow, policy })
    const rebuilt = await rebuildArtifacts(task.root, afterRetire.reports, afterRetire.journal)
    await atomicJson(path.join(task.root, 'artifacts.json'), { items: rebuilt.items, journalSeq: afterRetire.journal.length })
    const writerSafety = writerSafetyOf(afterRetire, registry, null, new Set(keys))
    return { ok: true, task: name, wave, supersededKeys: keys, writerSafety, note: '整波已作废并回退有效基线；旧映射和文件保留。未证实旧写者停写或撤权时，不得自动向重叠范围派新 Owner；无法证明时人工核对。' }
  }))
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
    // R3-10/§7：**协议转换段**的静止前提——存在任何未决卡或在途派发时不进入转换（波身份赋号
    // 段按设计处理在途/未结派发不受此限；转换写快照与 protocol-migrated 事件，必须静止执行）。
    {
      const assigned = newWaves.map((w) => ({ waveId: w.waveId, dispatchKeys: w.dispatchKeys }))
      const afterNow = Object.fromEntries([...projectRounds({ journal: afterTask.journal, reports: afterTask.reports }).entries()].map(([k, v]) => [String(k), v]))
      const base = { ok: true, task: name, assignedWaves: assigned, projectionBefore: before, projectionAfter: afterNow, equivalent: JSON.stringify(before) === JSON.stringify(afterNow) }
      const dupIds = duplicateIssuedIds(afterTask.journal)
      if (dupIds.length) {
        return { ...base, protocolMigration: { migrated: [], skipped: [], unchanged: 0, halted: "决定卡账本损坏（同 ID 多正文：" + dupIds.join("、") + "）——人工核对 journal 修复后再 tw migrate 完成协议转换" }, note: "波身份赋号完成；协议转换因账本损坏停止" }
      }
      const { open: openMig } = pendingDecisionsOf({ journal: afterTask.journal })
      if (openMig.length) {
        return { ...base, protocolMigration: { migrated: [], skipped: [], unchanged: 0, halted: "存在未决卡（" + openMig.length + " 张）——先 decide 处理待决卡后再 tw migrate 完成协议转换" }, note: "波身份赋号完成；协议转换因待决卡停止" }
      }
      const inflightNow = inflightBatch({ journal: afterTask.journal, reports: afterTask.reports })
      if (inflightNow) {
        return { ...base, protocolMigration: { migrated: [], skipped: [], unchanged: 0, halted: "存在在途派发（" + inflightNow.open.map((d) => d.key).join("、") + "）——等成员交付或 retire 后再 tw migrate 完成协议转换" }, note: "波身份赋号完成；协议转换因在途派发停止" }
      }
    }
    // 3.5) §7.3 旧摘要协议转换（核验迁移工具，B12 修订）：
    // 核验三源一致——(a) 该包全部历史已接受事件（report-accepted/report-committed）的 paths 并集、
    // (b) 当前索引中该包的全部登记路径（任意 reportRef）、(c) 最新报告清单——三者不等说明旧增量语义
    // 遗留了未收入最新报告的路径（如 d1 交 X/Y、d2 增量交 X 时 Y 的 reportRef=d1 被过滤），不能把
    // 该报告当完整清单候选自动转换；任一路径快照验证失败或磁盘字节不一致同样保留不确定。
    // 转换以 protocol-migrated 事件为唯一权威（不改写旧报告文件，§7.3），快照补写 bytes-v1 新文件（旧快照保留审计）。
    const stageNow = currentStageOf(afterTask.journal, afterTask.scope)
    const protocolResults = { migrated: [], skipped: [], unchanged: 0 }
    for (const [migPkg, migBase] of deliverBaselines({ journal: afterTask.journal, reports: afterTask.reports.filter((r) => r.stage === stageNow) })) {
      const report = migBase.report
      if (Array.isArray(report.files) && report.files.length > 0 && report.files.every((f) => f.digestAlgorithm === BYTES_DIGEST_ALGORITHM)) { protocolResults.unchanged += 1; continue }
      const paths = Array.isArray(report.payload?.paths) ? report.payload.paths.map(String) : []
      const problems = []
      // (a) 该包全部历史事件的 paths 并集（R3-10：任一相关事件缺 paths 即证据不足，不猜补）
      const historicalPaths = new Set()
      let evPathsMissing = false
      for (const e of afterTask.journal) {
        if (e.type !== "report-accepted" && e.type !== "report-committed") continue
        const d = e.detail ?? {}
        if (d.kind !== undefined && d.kind !== "deliver") continue
        if ((d.package ?? null) !== migPkg) continue
        if (d.outcome !== undefined && d.outcome !== "delivered") continue
        const evPaths = Array.isArray(d.payload?.paths) ? d.payload.paths.map(String) : (Array.isArray(d.paths) ? d.paths.map(String) : null)
        if (evPaths === null) {
          // R3-10/§7：历史事件缺 paths = 证据不足——不当作空数组猜补；该包保留不确定并引导授权刷新
          evPathsMissing = true
          continue
        }
        for (const p of evPaths) historicalPaths.add(p)
      }
      // (b) 当前索引中该包的全部登记路径
      const indexPaths = new Set((afterTask.artifacts?.items ?? []).filter((i) => (i.package ?? null) === migPkg).map((i) => i.path))
      const sortedLatest = [...paths].sort()
      if (evPathsMissing) {
        problems.push("该包存在缺少 paths 证据的历史报告事件：不能确认完整清单（缺证据不猜补）；由 Lead 获用户确认后用 tw refresh-artifacts 刷新完整清单")
      }
      if (JSON.stringify([...historicalPaths].sort()) !== JSON.stringify(sortedLatest)) {
        problems.push("该包历史已接受事件的路径并集与最新报告清单不一致（旧增量语义遗留路径未收入最新报告）：不能作为完整清单候选自动转换；由 Lead 获用户确认后用 tw refresh-artifacts 刷新完整清单")
      }
      if (JSON.stringify([...indexPaths].sort()) !== JSON.stringify(sortedLatest)) {
        problems.push("当前登记索引与最新报告清单不一致（增量语义遗留）：不能自动转换，需授权刷新完整清单")
      }
      const indexItems = (afterTask.artifacts?.items ?? []).filter((i) => (i.package ?? null) === migPkg)
      const migratedFiles = []
      for (const rel of paths) {
        const item = indexItems.find((i) => i.path === rel)
        let snap = null
        try { snap = JSON.parse(await readFile(path.join(afterTask.root, item?.snapshotRef ?? ("snapshots/" + item?.digest + ".json")), "utf8")) } catch { problems.push(rel + "：快照缺失或损坏"); continue }
        if (typeof snap.content !== "string") { problems.push(rel + "：旧快照缺 content 字段（无法无损还原原始字节）"); continue }
        if (digestValue(snap.content) !== item?.digest) { problems.push(rel + "：旧快照 digestValue 验证失败"); continue }
        let bytes = null
        try { bytes = await import("./persistence/file-artifact-repository.mjs").then((m) => m.readStableArtifactBytes(projectRoot, rel)) } catch (error) { problems.push(rel + "：磁盘读取失败（" + (error?.code ?? error?.message) + "）"); continue }
        if (!bytes.equals(Buffer.from(snap.content, "utf8"))) { problems.push(rel + "：磁盘当前字节与已验证旧快照不一致（先恢复已知快照，或由 Lead 按 §6.2.1 获用户确认后刷新完整清单）"); continue }
        migratedFiles.push({ path: rel, digestAlgorithm: BYTES_DIGEST_ALGORITHM, digest: digestBytes(bytes) })
      }
      if (problems.length) { protocolResults.skipped.push({ reportId: report.reportId, package: migPkg, problems }); continue }
      // 写转换：新 bytes-v1 快照（旧快照文件保留审计）+ protocol-migrated 事件（唯一权威）；不改写旧报告文件。
      // R3-10：二次读取后核摘要（bytes digest 必须仍等于核验通过的 f.digest，不一致则中断不写快照）。
      const filesPublic = []
      for (const f of migratedFiles) {
        const bytes = await import("./persistence/file-artifact-repository.mjs").then((m) => m.readStableArtifactBytes(projectRoot, f.path))
        if (digestBytes(bytes) !== f.digest) {
          protocolResults.skipped.push({ reportId: report.reportId, package: migPkg, problems: [f.path + "：写快照前二次读取字节与核验摘要不一致（读中变化），本报告未转换"] })
          filesPublic.length = 0
          break
        }
        const snapFile = path.join(afterTask.root, "snapshots", f.digest + ".json")
        if (!await readFile(snapFile, "utf8").then(() => true).catch(() => false)) {
          await atomicJson(snapFile, { format: "bytes-v1", digestAlgorithm: BYTES_DIGEST_ALGORITHM, digest: f.digest, path: f.path, paths: [f.path], encoding: "base64", data: bytes.toString("base64"), at: new Date().toISOString() })
        }
        filesPublic.push({ ...f, snapshotRef: "snapshots/" + f.digest + ".json" })
      }
      if (filesPublic.length === migratedFiles.length && migratedFiles.length > 0) {
        await appendEventsUnlocked(afterTask, [{ type: "protocol-migrated", detail: { reportId: report.reportId, package: migPkg, stage: report.stage, files: filesPublic, paths, algorithm: BYTES_DIGEST_ALGORITHM, previousAlgorithm: "legacy-digest-value" } }])
        protocolResults.migrated.push({ reportId: report.reportId, package: migPkg, files: migratedFiles.map((f) => ({ path: f.path, digest: f.digest })) })
      }
    }
    if (protocolResults.migrated.length) {
      // R3-10：以**追加事件之后**的任务视图重建索引（afterTask 是事件前快照，protocol-migrated
      // 叠加效果经 loadTask 的报告合并生效）；索引记载 journalSeq 供新鲜度检测。
      const afterMigrate = await loadTask(projectRoot, name, { workflow, policy })
      const rebuilt2 = await rebuildArtifacts(task.root, afterMigrate.reports, afterMigrate.journal)
      await atomicJson(path.join(task.root, "artifacts.json"), { items: rebuilt2.items, journalSeq: afterMigrate.journal.length })
    }
    // 4) 完成：输出迁移前后投影对比（「迁移前后状态等价」验收证据）
    const after = Object.fromEntries([...projectRounds({ journal: afterTask.journal, reports: afterTask.reports }).entries()].map(([k, v]) => [String(k), v]))
    return { ok: true, task: name, assignedWaves: newWaves.map((w) => ({ waveId: w.waveId, dispatchKeys: w.dispatchKeys })), projectionBefore: before, projectionAfter: after, equivalent: JSON.stringify(before) === JSON.stringify(after), protocolMigration: protocolResults, note: newWaves.length ? "迁移完成（追加 wave-assigned 事件，不改写历史行）；协议转换与投影对比见输出" : (protocolResults.migrated.length || protocolResults.skipped.length ? "波身份无需迁移；旧摘要协议转换结果见 protocolMigration" : "无需迁移（无可赋号派发与待转换报告，幂等返回）") }
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
    const task = await loadTask(projectRoot, name, { workflow, policy, repair: true })
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
    // 多卡按 ID 独立答复；意图变更立即重签，不以其他待决卡为由延后确认。
    if (intakeIssued) {
      // 用写盘后的最新 intent 重算指纹（task.intent 是进入命令时的快照，不能用于确认投影）。
      const updated = await loadTask(projectRoot, name, { workflow, policy, repair: true })
      const stateInfo = await intakeState(updated)
      if (needsIntakeResign(updated, stateInfo.fingerprint) && readyToSignIntake(updated, stateInfo.roles)) {
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
  // §6.2 只读实时核验（gate 零写）：磁盘字节与各包有效清单摘要不一致 → blocker 呈现
  const artifactVerification = await verifyStageArtifacts(projectRoot, task, currentStageOf(task.journal, task.scope))
  const state = deriveTask({ ...task, artifactVerification })
  // 只读提示（§6 批 B）：意图确认状态与当前稳定投影是否一致（不签发、不写盘）。
  const intakeIssued = task.journal.some((event) => event.type === "decision-issued" && event.detail?.gateId === INTAKE_GATE && effectiveIntakeIssued(task, event.detail))
  const stateInfo = await intakeState(task)
  const accepted = intakeConfirmation(task)
  const intake = {
    issued: intakeIssued,
    confirmed: Boolean(accepted && accepted.intakeFingerprint === stateInfo.fingerprint),
    ...(intakeIssued ? { fingerprint: stateInfo.fingerprint } : {}),
  }
  if (state.gate) return { ok: true, task: name, stage: state.stage, passed: state.gate.passed, blockers: state.gate.blockers, intake }
  const gate = gateCheck({ workflow, policy, stageId: state.stage, scope: task.scope, artifacts: task.artifacts, reports: task.reports.filter((r) => r.stage === state.stage), decisions: task.decisions, journal: task.journal, packages: Array.isArray(task.packages) && task.packages.length ? task.packages : null, artifactVerification })
  return { ok: true, task: name, stage: state.stage, passed: gate.passed, blockers: gate.blockers, wave: state.wave, intake }
}

// 归档保留路径身份；拒绝逃逸、目录声明和不规范分隔，不能用 basename 把不同路径压成同一个文件。
function archiveRelativePath(value) {
  if (typeof value !== "string" || !value || value.trim() !== value || value.includes("\0") || path.isAbsolute(value) || (path.sep === "\\" && path.win32.parse(value).root)) return null
  if (value.split(/[\\/]/).some((segment) => !segment || segment === "." || segment === "..")) return null
  return value
}

// 只在确认归档父目录属于项目后才读取或写入，防止复用已存在的符号链接逃逸。
async function archiveParentWithinProject(projectRoot, parent) {
  const root = await realpath(projectRoot)
  let realParent
  try { realParent = await realpath(parent) } catch (error) { if (error.code === "ENOENT") return null; throw error }
  const rel = path.relative(root, realParent)
  if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) throw fail("ARCHIVE_PATH_ESCAPE", "归档目录不在项目内，不能读取、写入或清理原任务。")
  return realParent
}

// 只有每份报告版本都能唯一关联有序的 journal 事件，才能确定哪个版本较新。
function requireArchiveReportOrder(task, reports, label) {
  const anchors = reports.map((report) => {
    const matches = []
    task.journal.forEach((event, index) => {
      if (["report-accepted", "report-committed"].includes(event.type) && event.detail?.reportId === report.reportId && (event.detail.ver ?? 1) === (report.ver ?? 1)) matches.push({ event, index })
    })
    if (matches.length !== 1 || !Number.isSafeInteger(matches[0].event.seq) || matches[0].event.seq < 1) throw fail("ARCHIVE_ORDER_UNVERIFIED", label + " 的有效报告缺少唯一可核实提交序；未发布归档或清理任务。")
    return { seq: matches[0].event.seq, index: matches[0].index }
  }).sort((a, b) => a.index - b.index)
  if (anchors.some((anchor, index) => index > 0 && anchor.seq <= anchors[index - 1].seq)) throw fail("ARCHIVE_ORDER_UNVERIFIED", label + " 的报告提交序重复或与日志顺序不一致；未发布归档或清理任务。")
}

// 归档会清理不可变快照，必须先证明派生索引与各阶段、各包最新有效报告的完整清单一致。
function assertArchiveBaselines(task) {
  const malformedEvent = task.journal.find((event) => ["report-committed", "report-accepted"].includes(event.type) && (typeof event.detail?.reportId !== "string" || !event.detail.reportId))
  if (malformedEvent) throw fail("STATE_CORRUPT", "报告提交事件缺少身份，无法证明归档清单完整；保留任务并先核对报告事实。")
  const excluded = supersededKeys(task.journal)
  const groupedReports = new Map()
  for (const report of task.reports) {
    if (report.role !== "owner" || report.kind !== "deliver" || report.payload?.outcome !== "delivered" || (report.dispatchKey != null && excluded.has(report.dispatchKey))) continue
    const key = String(report.stage ?? "") + "\0" + String(report.package ?? null)
    const candidates = groupedReports.get(key) ?? []
    candidates.push(report)
    groupedReports.set(key, candidates)
  }
  // 先核验组内所有候选，否则缺序的新报告可能在基线投影时就被误丢弃。
  for (const [key, candidates] of groupedReports) if (candidates.length > 1) requireArchiveReportOrder(task, candidates, "阶段包 " + key.replace("\0", "/"))
  const baselines = deliverBaselines({ journal: task.journal, reports: task.reports, groupedByStage: true })
  const byGroup = new Map()
  for (const item of task.artifacts.items) {
    const key = String(item?.stage ?? "") + "\0" + String(item?.package ?? null)
    const items = byGroup.get(key) ?? []
    items.push(item)
    byGroup.set(key, items)
  }
  for (const [key, base] of baselines) {
    const report = base.report
    const paths = report.payload?.paths
    if (typeof report.stage !== "string" || !Array.isArray(paths) || paths.some((rel) => typeof rel !== "string") || new Set(paths).size !== paths.length) throw fail("STATE_CORRUPT", "有效报告 " + report.reportId + " 缺少可核验的完整清单，不能归档。")
    const indexed = byGroup.get(key) ?? []
    if (indexed.length !== paths.length || indexed.some((item) => item.reportRef !== report.reportId || !paths.includes(item.path)) || paths.some((rel) => indexed.filter((item) => item.path === rel).length !== 1)) throw fail("STATE_CORRUPT", "有效报告 " + report.reportId + " 与产物索引清单不一致；保留任务并先核对或恢复索引。")
    if (Array.isArray(report.files)) {
      if (report.files.length !== paths.length || report.files.some((f) => !paths.includes(f.path)) || new Set(report.files.map((f) => f.path)).size !== paths.length) throw fail("STATE_CORRUPT", "有效报告 " + report.reportId + " 的路径与文件摘要清单不一致。")
      for (const file of report.files) {
        const item = indexed.find((entry) => entry.path === file.path)
        if (!item || item.digest !== file.digest || (item.digestAlgorithm ?? null) !== (file.digestAlgorithm ?? null)) throw fail("STATE_CORRUPT", "产物 " + file.path + " 的索引摘要与有效报告不一致，不能归档。")
      }
    }
    byGroup.delete(key)
  }
  if (byGroup.size) throw fail("STATE_CORRUPT", "产物索引含无有效报告对应的路径；保留任务并先核对完整清单。")
  return baselines
}

// 同一路径跨阶段时，以报告版本在 journal 的唯一提交序选择，不能用重建索引的分组顺序。
function latestArchiveArtifacts(task, baselines) {
  const groups = new Map()
  for (const item of task.artifacts.items) {
    const rel = archiveRelativePath(item?.path)
    if (!rel) throw fail("ARCHIVE_PATH_INVALID", "产物路径无效，不能安全归档：" + JSON.stringify(item?.path))
    const key = String(item.stage ?? "") + "\0" + String(item.package ?? null)
    const report = baselines.get(key)?.report
    if (!report || report.reportId !== item.reportRef) throw fail("STATE_CORRUPT", "产物 " + rel + " 无匹配的有效报告，不能归档。")
    const candidates = groups.get(rel) ?? []
    candidates.push({ item, report })
    groups.set(rel, candidates)
  }
  const compare = reportOrderComparator(task.journal)
  const selected = new Map()
  for (const [rel, candidates] of groups) {
    if (candidates.length === 1) { selected.set(rel, candidates[0].item); continue }
    requireArchiveReportOrder(task, candidates.map(({ report }) => report), "路径 " + rel)
    const newest = candidates.reduce((best, candidate) => compare(candidate.report, best.report) > 0 ? candidate : best)
    selected.set(rel, newest.item)
  }
  return selected
}

async function cmdArchive({ projectRoot, name }) {
  const dest = archiveRoot(projectRoot, name)
  const parent = path.dirname(dest)
  if (await archiveParentWithinProject(projectRoot, parent)) {
    try {
      const target = await lstat(dest)
      if (!target.isDirectory() || target.isSymbolicLink()) throw fail("ARCHIVE_PATH_ESCAPE", "归档目标不是普通目录或包含符号链接，已停止。")
      const manifestPath = path.join(dest, "manifest.json")
      const manifestStat = await lstat(manifestPath)
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw fail("STATE_CORRUPT", "归档清单不是普通文件，不能作为已完成凭据。")
      const { readStableArtifactBytes } = await import("./persistence/file-artifact-repository.mjs")
      let manifest
      try { manifest = JSON.parse((await readStableArtifactBytes(dest, "manifest.json")).toString("utf8")) } catch (error) {
        if (error instanceof SyntaxError) throw fail("STATE_CORRUPT", "归档清单不是有效 JSON。")
        throw error
      }
      if (await taskExists(projectRoot, name)) throw fail("ARCHIVE_INCOMPLETE", "归档与活动任务同时存在，可能是先前清理中断；两边均保留，请先核对并备份归档，人工移走旧归档后再重试，不能猜测删除任务。")
      return { ok: true, task: name, archivedTo: path.relative(projectRoot, dest), form: manifest.form, note: "任务已归档（幂等返回）" }
    } catch (error) { if (error.code !== "ENOENT") throw error }
  }
  const { workflow, policy } = await loadDefinitions(projectRoot)
  const task0 = await loadTask(projectRoot, name, { workflow, policy })
  return withOwnerLock(path.join(task0.root, "locks", "task.lock"), async () => {
    const task = await loadTask(projectRoot, name, { workflow, policy })
    const missingCurrent = (task.artifactsDegraded ?? []).filter((entry) => !entry.file)
    if (missingCurrent.length) throw fail("STATE_CORRUPT", "有效产物索引重建存在缺失或损坏项，不能归档并清理原任务：" + JSON.stringify(missingCurrent))
    const baselines = assertArchiveBaselines(task)
    const latest = latestArchiveArtifacts(task, baselines)
    try { await lstat(dest); throw fail("ARCHIVE_INCOMPLETE", "目标归档目录已存在但不完整：保留原任务和目录，请核对并备份该目录，人工移走后再重试。") }
    catch (error) { if (error.code !== "ENOENT") throw error }
    const state = deriveTask(task)
    const completedEvent = task.journal.filter((e) => e.type === "task-completed").at(-1)
    const form = completedEvent?.detail?.form === "partial" || (state.status !== "completed" && !completedEvent) ? "partial" : (state.status === "completed" ? "completed" : "partial")
    await mkdir(parent, { recursive: true })
    const realParent = await archiveParentWithinProject(projectRoot, parent)
    if (!realParent) throw fail("ARCHIVE_PATH_ESCAPE", "归档目录不可验证，不能写入或清理原任务。")
    // 构建在本次独占的暂存目录；所有快照与输出均已核验后才发布，再清理原任务。
    const prefix = "." + name + ".archive-"
    const stage = await mkdtemp(path.join(realParent, prefix))
    const realStage = await realpath(stage)
    if (path.dirname(realStage) !== realParent || !path.basename(realStage).startsWith(prefix)) throw fail("ARCHIVE_PATH_ESCAPE", "归档暂存目录不在预期位置，已停止操作。")
    let published = false
    try {
      const artifactRoot = path.join(realStage, "artifacts")
      await mkdir(artifactRoot)
      const { readStableArtifactBytes } = await import("./persistence/file-artifact-repository.mjs")
      for (const [rel, item] of latest) {
        if (typeof item.digest !== "string" || !/^[a-f0-9]{64}$/.test(item.digest)) throw fail("STATE_CORRUPT", "产物 " + rel + " 缺少可验证摘要，不能归档。")
        const expectedRef = "snapshots/" + item.digest + ".json"
        const snapshotRef = item.snapshotRef ?? expectedRef
        if (snapshotRef !== expectedRef) throw fail("STATE_CORRUPT", "产物 " + rel + " 的快照引用不合法，不能归档。")
        const bytes = await readSnapshotBytes(task.root, snapshotRef, item.digest, item.digestAlgorithm ?? null)
        const target = path.resolve(artifactRoot, rel)
        const relativeTarget = path.relative(artifactRoot, target)
        if (!relativeTarget || relativeTarget === ".." || relativeTarget.startsWith(".." + path.sep) || path.isAbsolute(relativeTarget)) throw fail("ARCHIVE_PATH_ESCAPE", "产物 " + rel + " 超出归档范围。")
        try { await mkdir(path.dirname(target), { recursive: true }) } catch (error) {
          if (error.code === "EEXIST" || error.code === "ENOTDIR") throw fail("ARCHIVE_PATH_CONFLICT", "产物路径存在文件与目录冲突：" + rel)
          throw error
        }
        let exists = false
        try { await lstat(target); exists = true } catch (error) { if (error.code !== "ENOENT") throw error }
        if (exists) throw fail("ARCHIVE_PATH_CONFLICT", "归档产物路径发生冲突，未覆盖：" + rel)
        await atomicWrite(target, bytes)
        const archivedBytes = await readStableArtifactBytes(realStage, path.join("artifacts", rel))
        if (!archivedBytes.equals(bytes)) throw fail("ARCHIVE_VERIFY_FAILED", "归档产物写入后字节不一致，未清理原任务：" + rel)
      }
      const stagePassed = task.journal.filter((e) => e.type === "stage-advanced" || e.type === "task-completed").map((e) => e.type === "task-completed" ? String(e.detail.stage) + "(终)" : e.detail.to)
      const reviews = task.reports.filter((r) => r.kind === "review").map((r) => ({ role: r.role, round: r.round, recommendation: r.payload.recommendation, findings: (r.payload.findings ?? []).length, verdict: r.payload.verdict?.outcome ?? null, summary: r.payload.summary }))
      await atomicJson(path.join(realStage, "decisions.json"), { items: task.decisions })
      await atomicWrite(path.join(realStage, "journal-summary.jsonl"), task.journal.filter((e) => ["task-opened", "stage-advanced", "gate-passed", "decision-issued", "decided", "task-completed", "report-rejected"].includes(e.type)).map((e) => JSON.stringify(e)).join("\n") + "\n")
      await atomicJson(path.join(realStage, "manifest.json"), { task: name, objective: task.intent.objective, constraints: task.intent.constraints, entry: task.scope.entry, completion: task.scope.completion, form, stagesPassed: stagePassed, reviews, createdAt: task.scope.createdAt, archivedAt: new Date().toISOString() })
      await fsPromises.rename(realStage, path.join(realParent, name))
      published = true
      await syncDirectory(realParent)
      await markTreeReadOnly(dest)
      if (path.resolve(task.root) !== path.resolve(taskRoot(projectRoot, name))) throw fail("ARCHIVE_PATH_ESCAPE", "任务目录身份不一致，未清理。")
      await rm(task.root, { recursive: true, force: true })
      return { ok: true, task: name, archivedTo: path.relative(projectRoot, dest), form, kept: ["manifest.json", "artifacts/", "reviews(在 manifest)", "decisions.json", "journal-summary.jsonl"], cleaned: ["reports/", "snapshots/", "runtime 状态"] }
    } finally {
      if (!published) await rm(realStage, { recursive: true, force: true })
    }
  })
}

// plan（v3.2/§3.3）：Lead 拆包登记 + 机械验收（P2 调用内一次查完）。
// 仅验机械属性（id 唯一/可写互斥/依赖无环/完成标准在场/路径合法/模型解析）；拆分语义质量归 Lead。
// 每包在落盘前一律物化为 model:ModelRef（显式 model / tier 语法糖 / 复用 roles.owner），不再持久化 tier。
// plan 机械验收（§3.3 共用）：互斥/无环/完成标准/模型语法。返回 {reasons, ids, tagWarn}。
const PACKAGE_FIELDS = new Set(['id', 'model', 'tier', 'writable', 'done', 'dependsOn'])

function planAcceptance(items) {
  const reasons = []
  const ids = new Set()
  const paths = []
  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    let p = items[itemIndex]
    if (!p || typeof p !== 'object' || Array.isArray(p)) { reasons.push('包定义必须是对象：' + JSON.stringify(p)); continue }
    // B13：包对象未知字段一次聚合拒绝（typo 字段不静默通过）
    for (const key of Object.keys(p)) {
      if (!PACKAGE_FIELDS.has(key)) reasons.push('包 ' + JSON.stringify(p.id) + ' 含未知字段「' + key + '」（只接受 ' + [...PACKAGE_FIELDS].join('、') + '）')
    }
    // B13：dependsOn 先判形状再遍历（非数组不抛裸异常；安全化副本仅供后续遍历）
    if (p.dependsOn !== undefined && !Array.isArray(p.dependsOn)) {
      reasons.push('包 ' + JSON.stringify(p.id) + ' 的 dependsOn 必须是包 ID 数组')
      p = { ...p, dependsOn: [] }
    }
    if (!p || typeof p.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(p.id)) { reasons.push('包 id 不合法：' + JSON.stringify(p?.id) + '（小写字母/数字/连字符）'); continue }
    if (ids.has(p.id)) reasons.push('包 id 重复：' + p.id)
    ids.add(p.id)
    if (!Array.isArray(p.writable) || p.writable.length === 0) reasons.push('包 ' + p.id + ' 缺 writable（["路径:产出物kind"]）')
    for (const w of Array.isArray(p.writable) ? p.writable : []) {
      if (!validWritableSpec(w)) { reasons.push('包 ' + p.id + ' 的 writable 必须是有效的项目相对路径:产物类型：' + JSON.stringify(w)); continue }
      const rel = String(w).split(':').slice(0, -1).join(':') || String(w)
      if (rel.startsWith('/') || rel.split('/').includes('..')) reasons.push('包 ' + p.id + ' 可写路径不合法：' + w + '（须为项目内相对路径）')
      paths.push({ path: rel, comparable: comparableWritablePath(rel), pkg: p.id })
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
      if (writablePathsOverlap(paths[i].comparable, paths[j].comparable)) reasons.push('可写范围重叠：' + paths[i].pkg + ' 与 ' + paths[j].pkg + ' 都写 ' + paths[i].path + (paths[i].path !== paths[j].path ? ' 与 ' + paths[j].path : '') + '（相同路径或互为祖先目录才可写（一个 inode 原则）：docs 与 docs/、docs 与 docs/x 均冲突；兄弟前缀 docs/ 与 docs-x/ 不冲突）')
    }
  }
  for (const p of items) {
    for (const d of Array.isArray(p?.dependsOn) ? p.dependsOn : []) {
      if (!ids.has(d)) reasons.push('包 ' + p?.id + ' 依赖不存在的包：' + d)
    }
  }
  // R3-11：图构造/长 ID 遍历用已验形状的安全集合（null/非对象包已在循环内记录错误，此处不再触其字段）
  const validItems = items.filter((p) => p && typeof p === "object" && typeof p.id === "string" && ids.has(p.id))
  const graph = new Map(validItems.map((p) => [p.id, (Array.isArray(p.dependsOn) ? p.dependsOn : []).filter((d) => ids.has(d))]))
  const visiting = new Set(), visited = new Set()
  const dfs = (id) => {
    if (visited.has(id)) return
    if (visiting.has(id)) { reasons.push('依赖成环：涉及包 ' + id); return }
    visiting.add(id)
    for (const d of graph.get(id) ?? []) dfs(d)
    visiting.delete(id); visited.add(id)
  }
  for (const id of graph.keys()) dfs(id)
  const longIds = validItems.filter((p) => p.id.length > 12).map((p) => p.id)
  const tagWarn = longIds.length ? `包 id 过长（${longIds.join("、")}，>12 字符）：子代理标签中会挤压简述空间，建议短词（如 store/intake）` : null
  return { reasons, ids, tagWarn }
}

// 解析 + 机械验收（锁外快速失败入口；不含模型物化）。
function planAcceptanceItems(packagesJson) {
  let items
  try { items = JSON.parse(packagesJson) } catch { throw fail('USAGE', '--packages 不是合法 JSON 数组') }
  if (!Array.isArray(items) || items.length === 0) {
    throw fail('USAGE', '--packages 必须是非空 JSON 数组：[{id, model?:{provider,modelName,effort?}, tier?:junior|senior|expert, writable:["路径:kind"], done:["完成标准"], dependsOn:["包id"]}]')
  }
  const { reasons, tagWarn } = planAcceptance(items)
  if (reasons.length) {
    const error = new Error('包定义未通过机械验收：' + String.fromCharCode(10) + '- ' + [...new Set(reasons)].join(String.fromCharCode(10) + '- '))
    error.code = 'PLAN_REJECTED'
    error.card = { ok: false, code: 'PLAN_REJECTED', message: error.message, fix: '修正 --packages 后重试；验收只保机械属性（互斥/无环/标准在场），拆分语义质量由 Lead 把关' }
    throw error
  }
  return { items, tagWarn }
}

// plan 模型物化（锁内）：显式 model 直接采用；tier 从调用快照解析；都不给复制 roles.owner。
async function materializePlan({ task, workflow, policy, items }) {
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
  return planned.map(({ modelSource: _source, ...pkg }) => pkg)
}

// 解析 + 验收 + 物化（resolve-blocked 的候选计划与常规 plan 共用；调用方需在锁内传 task）。
async function validatePlanItems({ task, workflow, policy, packagesJson }) {
  let items
  try { items = JSON.parse(packagesJson) } catch { throw fail('USAGE', '--packages 不是合法 JSON 数组') }
  if (!Array.isArray(items) || items.length === 0) {
    throw fail('USAGE', '--packages 必须是非空 JSON 数组：[{id, model?:{provider,modelName,effort?}, tier?:junior|senior|expert, writable:["路径:kind"], done:["完成标准"], dependsOn:["包id"]}]')
  }
  const { reasons, tagWarn } = planAcceptance(items)
  if (reasons.length) {
    const error = new Error('包定义未通过机械验收：' + String.fromCharCode(10) + '- ' + [...new Set(reasons)].join(String.fromCharCode(10) + '- '))
    error.code = 'PLAN_REJECTED'
    error.card = { ok: false, code: 'PLAN_REJECTED', message: error.message, fix: '修正 --packages 后重试；验收只保机械属性（互斥/无环/标准在场），拆分语义质量由 Lead 把关' }
    throw error
  }
  const persisted = await materializePlan({ task, workflow, policy, items })
  return { items, persisted, tagWarn }
}

// 候选计划尚未生效：复用意图卡确认其完整快照，同时绑定旧计划与恢复卡。
async function recoveryIntakeCard(task, workflow, recoveryCard) {
  const rec = recoveryCard.recovery
  if (!Array.isArray(rec?.plan) || digestValue(rec.plan) === digestValue(task.packages ?? null)) return null
  const stateInfo = await intakeState(task)
  const snapshot = intakeSnapshot({ task, roles: stateInfo.roles, packages: rec.plan })
  const fingerprint = digestValue(snapshot)
  const accepted = candidateConfirmedIntake(task, recoveryCard.decisionId)
  const acceptedCard = task.journal.find((e) => e.type === "decision-issued" && e.detail?.decisionId === accepted?.decisionId)?.detail
  if (accepted?.fingerprint === fingerprint && acceptedCard?.recoveryAuthorization?.decisionId === recoveryCard.decisionId && acceptedCard.recoveryAuthorization.currentFingerprint === stateInfo.fingerprint) return null
  const openIntake = pendingDecisionsOf({ journal: task.journal }).open.find((card) => card.detail.gateId === INTAKE_GATE)
  if (openIntake) {
    if (openIntake.detail.recoveryAuthorization?.decisionId === recoveryCard.decisionId && openIntake.detail.intakeFingerprint === fingerprint && openIntake.detail.recoveryAuthorization.currentFingerprint === stateInfo.fingerprint) return openIntake.detail
    return { blockedBy: openIntake.detail.decisionId, note: "先处理已有意图卡，再重复准备该恢复卡以确认候选计划。" }
  }
  const candidateTask = { ...task, packages: rec.plan }
  if (!readyToSignIntake(candidateTask, stateInfo.roles)) return { blockedBy: "intake-unresolved", note: "意图或角色配置不完整，先补齐后重新准备恢复卡。" }
  const details = roleDetailsForCard(candidateTask, stateInfo.roles, stateInfo.invalid)
  return signIntakeApproval({ task: candidateTask, workflow, roles: stateInfo.roles, details, profile: profileOf(task), source: "recovery-candidate", recoveryAuthorization: { decisionId: recoveryCard.decisionId, planDigest: digestValue(rec.plan), currentPlanDigest: digestValue(task.packages ?? null), currentFingerprint: stateInfo.fingerprint } })
}

async function cmdPlan({ projectRoot, name, packagesJson, resolveBlocked = null, blockedRef = null }) {
  const { workflow, policy } = await loadDefinitions(projectRoot)
  // —— §6.3 按包恢复卡准备：--resolve-blocked '<JSON>' --blocked-ref <展示的阻塞引用> ——
  // 每次只准备一个包（单 owner 省略 package）；不提交计划、不解除 blocked——签发 kind=package-recovery
  // 的待决卡，用户确认后经 decide 按 decisionId 解除（blocked-resolved 事件绑定 key/ver）。
  if (resolveBlocked != null) {
    let rec
    try { rec = JSON.parse(resolveBlocked) } catch { throw fail('USAGE', '--resolve-blocked 不是合法 JSON：' + String(resolveBlocked).slice(0, 80)) }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) throw fail('USAGE', '--resolve-blocked 需要 JSON 对象 {"package":"a","action":"retry","reason":"方向说明"}')
    const action = rec.action
    if (!['retry', 'remove'].includes(action)) throw fail('USAGE', '--resolve-blocked 的 action 只能是 retry|remove（用户明确方向后由 Lead 选择）')
    if (typeof rec.reason !== 'string' || !rec.reason.trim()) throw fail('USAGE', '--resolve-blocked 需要 reason（用户给出的明确方向说明；写入卡供确认）')
    if (!blockedRef || typeof blockedRef !== 'string' || !/^.+#v\d+$/.test(blockedRef)) throw fail('USAGE', '需要 --blocked-ref <展示的阻塞引用>（格式 <dispatchKey>#v<ver>，来自 tw run / dispatch-plan 的 blockedPackages 证据；只为避免迟到回复误配，不证明授权）')
    const [refKey, refVerRaw] = blockedRef.split('#v')
    const refVer = Number(refVerRaw)
    const task0 = await loadTask(projectRoot, name, { workflow, policy })
    return withOwnerLock(path.join(task0.root, 'locks', 'task.lock'), async () => {
      const task = await loadTask(projectRoot, name, { workflow, policy, repair: true })
      const multi = Array.isArray(task.packages) && task.packages.length > 0
      const pkg = rec.package ?? null
      if (multi && pkg == null) throw fail('USAGE', '多包任务必须指定 package（每次只准备一个包的恢复）')
      if (!multi && pkg != null) throw fail('USAGE', '单 Owner 任务省略 package（匿名包）')
      if (multi && !task.packages.some((p) => p.id === pkg)) throw fail('USAGE', '包 ' + pkg + ' 不在当前计划中')
      const state = deriveTask(task)
      const blockedSet = effectiveBlockedSet({ journal: task.journal, reports: task.reports.filter((r) => r.stage === state.stage), packages: multi ? task.packages : null })
      const current = blockedSet.get(pkg) ?? null
      if (!current) throw fail('USAGE', '包 ' + (pkg ?? '（单 owner）') + ' 当前没有有效 blocked 报告；无需恢复卡')
      if (current.dispatchKey !== refKey || (current.ver ?? 1) !== refVer) {
        throw fail('USAGE', 'blocked-ref ' + blockedRef + ' 与当前有效 blocked 不符（当前 ' + current.dispatchKey + '#v' + (current.ver ?? 1) + '）：用 tw run 查看最新 blockedPackages 后重试')
      }
      // 候选重拆计划（如有）：--packages 提供；机械验收同常规 plan
      let candidatePlan = null
      if (packagesJson != null) {
        const validated = await validatePlanItems({ task, workflow, policy, packagesJson })
        candidatePlan = validated.persisted
      }
      if (action === 'remove' && !candidatePlan) {
        const rest = (task.packages ?? []).filter((p) => p.id !== pkg)
        if (!rest.length) throw fail('USAGE', '移除最后一个包不能形成有效计划；请先由用户决定结束任务或提供有效重拆计划。')
        candidatePlan = (await validatePlanItems({ task, workflow, policy, packagesJson: JSON.stringify(rest) })).persisted
      }
      if (action === 'remove' && candidatePlan && candidatePlan.some((p) => p.id === pkg)) {
        throw fail('USAGE', 'remove 动作与候选计划矛盾：候选计划仍包含包 ' + pkg + '（remove = 从计划移除该包；如需重拆保留请用 retry）')
      }
      // R3-9：retry 候选必须保留目标包（否则确认了一个已移除该包的计划却声称恢复它）
      if (action === 'retry' && candidatePlan && !candidatePlan.some((p) => p.id === pkg)) {
        throw fail('USAGE', 'retry 动作与候选计划矛盾：候选计划已移除包 ' + pkg + '（retry 恢复后须在新计划中保留该包；移除请用 remove）')
      }
      const planDigest = candidatePlan ? digestValue(candidatePlan) : null
      // B11：绑定当前计划版本（确认时重核，计划变化即过期）
      const currentPlanDigest = digestValue(Array.isArray(task.packages) ? task.packages : null)
      // 幂等：相同候选（包+key/ver+action+计划摘要）重复准备返回同一卡
      const settled = new Set(task.journal.filter((e) => e.type === 'decided').map((e) => e.detail?.decisionId).filter(Boolean))
      for (const e of [...task.journal].reverse()) {
        if (e.type !== 'decision-issued' || e.detail?.kind !== 'package-recovery') continue
        if (settled.has(e.detail.decisionId)) continue
        if ((e.detail.package ?? null) === pkg && e.detail.recovery?.dispatchKey === refKey && (e.detail.recovery?.reportVersion ?? 1) === refVer && e.detail.recovery?.action === action && (e.detail.recovery?.planDigest ?? null) === planDigest) {
          const intakeCard = await recoveryIntakeCard(task, workflow, e.detail)
          return { ok: true, task: name, status: 'awaiting-user', next: 'decide', transition: 'await-decision', decisionId: e.detail.decisionId, kind: 'package-recovery', ...(pkg != null ? { package: pkg } : {}), question: e.detail.reason, choices: e.detail.choices, recovery: e.detail.recovery, ...(intakeCard ? { intakeCard } : {}), note: '相同候选的恢复卡已签发；先完成候选计划意图确认，再按该卡 decisionId 决定' }
        }
        if ((e.detail.package ?? null) === pkg) {
          await appendEventsUnlocked(task, [{ type: 'decided', detail: { decisionId: e.detail.decisionId, choice: 'superseded', reason: '该包恢复候选变化，旧卡作废重签' } }])
          break
        }
      }
      const decisionId = 'pr-' + randomBytes(4).toString('hex')
      const question = '按包解除 blocked 确认' + (pkg != null ? '（包 ' + pkg + '）' : '（单 owner）') + '：目标 blocked 报告 ' + refKey + '#v' + refVer + '，动作 ' + action + (candidatePlan ? '（附候选重拆计划）' : '') + '。用户方向：' + rec.reason.trim() + '。确认后仅解除该包 blocked（其他包不受影响）；retry 需新范围派发，remove 将该包移出计划（原报告/快照保留审计）。'
      const choices = [
        { n: 1, label: action === 'retry' ? '确认恢复（retry）' : '确认移除（remove）', desc: action === 'retry' ? '解除该包 blocked；如有候选计划一并提交' : '将该包移出计划并解除 blocked', grant: action },
        { n: 2, label: '取消', desc: '收口本卡，该包保持 blocked', grant: 'cancel' },
      ]
      const recovery = { dispatchKey: refKey, reportVersion: refVer, action, planDigest, currentPlanDigest, ...(candidatePlan ? { plan: candidatePlan } : {}) }
      const recoveryCard = { decisionId, kind: 'package-recovery', gateId: null, package: pkg, stage: state.stage, reason: question, choices, recovery }
      await appendEventsUnlocked(task, [{ type: 'decision-issued', detail: recoveryCard }])
      const updated = await loadTask(projectRoot, name, { workflow, policy })
      const intakeCard = await recoveryIntakeCard(updated, workflow, recoveryCard)
      return { ok: true, task: name, status: 'awaiting-user', next: 'decide', transition: 'await-decision', decisionId, kind: 'package-recovery', ...(pkg != null ? { package: pkg } : {}), question, choices, recovery, ...(intakeCard ? { intakeCard } : {}), note: '恢复卡已签发（未解除 blocked、未提交计划）：先确认候选计划意图，再以实际展示的 decision-id 确认恢复。' }
    })
  }
  const acceptance = planAcceptanceItems(packagesJson)
  const items = acceptance.items
  const tagWarn = acceptance.tagWarn
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
    // 模型物化（§3.3.1 共用 materializePlan）：解析失败 → PLAN_MODEL_UNRESOLVED，不落半成品包。
    const persisted = await materializePlan({ task, workflow, policy, items })
    const had = task.packages != null
    // —— §6.3 F-N3：同内容 plan 零写 ——锁内将完整、已物化的计划规范化比较（对象键序归一化；
    // writable/done/dependsOn 等有序数组保序，重排视为内容变化）。相同 → changed:false、不写
    // packages.json、不写 re-planned、不重签卡，也不解除任何 blocked（计划变更本身不构成恢复授权）。
    const normalizePlan = (arr) => JSON.stringify({ items: (arr ?? []).map((p) => {
      const out = {}
      for (const key of Object.keys(p ?? {}).sort()) out[key] = p[key]
      return out
    }) })
    const samePlan = had && task.packages != null && normalizePlan(task.packages) === normalizePlan(persisted)
    if (samePlan) {
      return { ok: true, task: name, changed: false, packages: persisted.map((p) => ({ id: p.id, model: p.model, dependsOn: p.dependsOn ?? [] })), next: 'dispatch', ...(tagWarn ? { warnings: [tagWarn] } : {}), note: '计划与当前登记内容相同（未变更）：零写入返回，不产生 re-planned 事实，不改变任何 blocked 状态。' }
    }
    // B11：journal 单次原子提交完整计划（items 进事件）→ packages.json 视图随后重建
    await appendEventsUnlocked(task, [{ type: had ? 're-planned' : 'packages-planned', detail: { packages: persisted.map((p) => p.id), items: persisted, models: persisted.map((p) => ({ id: p.id, modelRef: p.model })) } }])
    await atomicJson(path.join(task.root, 'packages.json'), { items: persisted })
    task.packages = persisted
    // 已有确认卡：包模型变化 → 作废旧卡并重签（§3.4.3/§3.4.4）。
    const intakeIssued = task.journal.some((event) => event.type === 'decision-issued' && event.detail?.gateId === INTAKE_GATE)
    if (intakeIssued) {
      const stateInfo = await intakeState(task)
      const pending = pendingDecisionDetail(task.journal)
      if ((!pending || pending.gateId === INTAKE_GATE) && needsIntakeResign(task, stateInfo.fingerprint) && readyToSignIntake(task, stateInfo.roles)) {
        const details = roleDetailsForCard(task, stateInfo.roles, stateInfo.invalid)
        const card = await signIntakeApproval({ task, workflow, roles: stateInfo.roles, details, profile: profileOf(task), source: 'role-registry' })
        return { ok: true, task: name, changed: true, packages: persisted.map((p) => ({ id: p.id, model: p.model, dependsOn: p.dependsOn ?? [] })), replanned: had, status: 'awaiting-user', next: 'decide', transition: 'await-decision', ...card, ...(tagWarn ? { warnings: [tagWarn] } : {}), note: '包定义与逐包模型已登记，意图确认卡已按新包模型重签：确认后推进（tw-dispatch / tw dispatch-plan）' }
      }
    }
    return { ok: true, task: name, changed: true, packages: persisted.map((p) => ({ id: p.id, model: p.model, dependsOn: p.dependsOn ?? [] })), replanned: had, next: 'dispatch', ...(tagWarn ? { warnings: [tagWarn] } : {}), note: had ? '包定义已更新（下一波生效）' : '包定义已登记；推进将按波组派发（tw-dispatch / tw dispatch-plan）' }
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
    // 多卡并存；角色变更重签意图卡，其他卡由各自决定路径锁内重核。
    const pending = pendingDecisionDetail(refreshed.journal)
    if (intakeIssued) {
      const stateInfo = await intakeState(refreshed)
      if (needsIntakeResign(refreshed, stateInfo.fingerprint) && readyToSignIntake(refreshed, stateInfo.roles)) {
        const details = roleDetailsForCard(refreshed, stateInfo.roles, stateInfo.invalid)
        const card = await signIntakeApproval({ task: refreshed, workflow, roles: stateInfo.roles, details, profile: profileOf(refreshed), source: "role-registry" })
        return { ok: true, task: name, stage: state.stage, status: "awaiting-user", next: "decide", transition: "await-decision", ...card, roles, changes, unresolved, ...(warnings.length ? { warnings } : {}), note: "角色模型已更新，意图确认卡已重签（确认前不派发）" }
      }
    }
    return { ok: true, task: name, roles, changes, unresolved, ...(warnings.length ? { warnings } : {}), ...(intakeIssued && pending ? { intakeRestaled: true } : {}), note: changes.length ? "角色模型已更新；后续派发直接使用 roles（不再查配置）" + (intakeIssued && pending ? "；当前有待决卡（" + String(pending.reason ?? "待用户决定") + "），处理后的下一次推进将重签意图确认卡" : "") : "无变化（幂等）" }
  })
}

// agent-map（v3.2/F5；定向委派第二阶段收敛为纯续派登记）：登记 dispatchKey → 平台 subagent id。
// 任务级注册表 task.root/agents.json 保存 mappings 与 roles——本命令只写 mappings；模型由 open/tw roles/plan
// 固化在 roles 与 packages，tw-dispatch 按 dispatch-plan 导出的 modelRef 创建；快照在 journal 的 dispatched 事实内。
// 续派波经 dispatch-plan 导出 expectedAgentId（同包同角色上一派发的映射）——Lead 据此 send_message 续原会话。
async function cmdAgentMap({ projectRoot, name, key, agent, modelHint }) {
  if (typeof key !== 'string' || !key.trim() || typeof agent !== 'string' || !agent.trim() || agent !== agent.trim()) throw fail('USAGE', 'agent-map 需要非空 --key 与准确的 --agent <平台subagentId>')
  const { workflow, policy } = await loadDefinitions(projectRoot)
  if (modelHint !== undefined) throw fail('USAGE', 'agent-map 不接受 --model-hint；模型在 open / tw roles / tw plan 时已固化为 ModelRef')
  const task0 = await loadTask(projectRoot, name, { workflow, policy })
  return withOwnerLock(path.join(task0.root, 'locks', 'task.lock'), async () => {
    const task = await loadTask(projectRoot, name, { workflow, policy, repair: true })
    const dispatch = task.journal.find((e) => e.type === 'dispatched' && e.detail?.key === key)
    if (!dispatch) throw fail('USAGE', 'key ' + key + ' 不是本任务的派单 key；从派单卡或 dispatch-plan 复制。')
    const status = supersededKeys(task.journal).has(key) ? 'superseded' : task.reports.some((r) => r.dispatchKey === key) ? 'reported' : 'active'
    const file = path.join(task.root, 'agents.json')
    let current
    try { current = await readJson(file, { allowMissing: true }) } catch (error) {
      return { ok: false, code: 'AGENTS_STATE_CORRUPT', task: name, key, status, agentId: null, message: '成员映射账本损坏，无法确认原会话；未修改或重建：' + String(error.message), fix: '保留原文件，核对并恢复已登记的 sessionId 后重试。' }
    }
    if (!current || typeof current !== 'object' || Array.isArray(current) || !current.mappings || typeof current.mappings !== 'object' || Array.isArray(current.mappings) || Object.values(current.mappings).some((id) => typeof id !== 'string' || !id.trim() || id !== id.trim())) {
      return { ok: false, code: 'AGENTS_STATE_CORRUPT', task: name, key, status, agentId: null, message: '成员映射账本缺失或结构损坏，无法可靠确认原会话；未修改或重建。', fix: '保留原事实并核对恢复映射后重试。' }
    }
    const mapped = Object.prototype.hasOwnProperty.call(current.mappings, key) ? current.mappings[key] : null
    if (status === 'superseded') return { ok: false, code: 'DISPATCH_SUPERSEDED', task: name, key, status, agentId: mapped, message: '该派单所属波已作废，拒绝登记或覆盖映射。', fix: '保留原会话并核对旧写者状态后处理新波。' }
    if (mapped !== null && mapped !== agent) return { ok: false, code: 'AGENT_MAP_CONFLICT', task: name, key, status, agentId: mapped, message: '该 key 已登记不同的 sessionId，不能静默覆盖。', fix: '保留原映射，按宿主事实核对；不能通过换 ID 绕过冲突。' }
    if (status === 'reported') return { ok: true, task: name, key, status, agentId: mapped, agent: mapped, idempotent: true, note: '该 key 已有有效报告；不创建、投递或修改映射。' }
    if (mapped === agent) return { ok: true, task: name, key, status, agentId: mapped, agent: mapped, idempotent: true, note: '映射已登记（幂等）；仍须由宿主对账收单事实。' }
    await atomicJson(file, { ...current, mappings: { ...current.mappings, [key]: agent } })
    return { ok: true, task: name, key, status, agentId: agent, agent, idempotent: false, note: '已登记映射；仍须由宿主核验会话与本轮收单。' }
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
    for (const pending of [...(card?.pendingDecisions ?? []), ...(card?.staleDecisions ?? [])]) {
      lines.push('待决卡 ' + pending.decisionId + '（' + pending.kind + '）：' + pending.question)
      for (const choice of pending.choices ?? []) lines.push('  ' + choice.n + '. ' + choice.label + (choice.desc ? '——' + choice.desc : ''))
      if (pending.binding) lines.push('  绑定：' + JSON.stringify(pending.binding))
      if (pending.blockers?.length) lines.push('  阻碍：' + JSON.stringify(pending.blockers))
    }
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
    const lockedRegistry = await readRegistry(lockedTask)
    if (lockedRegistry.corrupt) {
      const message = "会话登记簿不可验证，保留原文件且不创建、不补派：" + lockedRegistry.corrupt
      return { ok: false, task: name, stage: currentStageOf(lockedTask.journal, lockedTask.scope), stop: "blocked", waves: [], code: "AGENTS_STATE_CORRUPT", card: { ok: false, status: "blocked", blockers: [{ message, recovery: "核对并恢复原映射与会话归属，再重新对账；不得猜测重建。" }] } }
    }
    const settled = await settleLegacyEscalations(lockedTask)
    // E4：配置快照只服务派发计划展示（modelSettings/warnings）与旧 tier 物化，不在 stop 卡路径无条件读取；
    // 派发模型本身来自 roles/packages，不依赖本次调用快照。
    const warnings = []
    if (settled) warnings.push("已收口 " + settled + " 张历史升档审批卡（decided:superseded，升档审批机制已删除）")
    const planStop = (stop, card, extra = {}) => {
      // B9/§6.2.2：awaiting-user 时顶层携带完整待决卡列表（机器消费方不解析 card 也能拿到全部卡），
      // 与 run/derive 共用 pendingDecisionsOf 同一投影；损坏账本（同 ID 多正文）时停止并提示修复。
      let pendingList = null
      let corruptIds = null
      if (stop === "awaiting-user") {
        const taskNow = lockedTask
        const dup = duplicateIssuedIds(taskNow.journal)
        if (dup.length) corruptIds = dup
        else {
          const { open } = pendingDecisionsOf({ journal: taskNow.journal })
          if (open.length) pendingList = open.map(cardOf)
        }
      }
      const plan = { ok: true, task: name, stage: card.stage ?? null, stop, waves: [], card, ...(pendingList?.length ? { pendingDecisions: pendingList, ...(pendingList.length > 1 ? { needsDecisionId: true } : {}) } : {}), ...(corruptIds?.length ? { duplicateIssued: corruptIds, note: "决定卡账本损坏（同 ID 多正文），已停止派发：人工核对 journal 后修复或重签" } : {}), ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}), ...extra }
      if (!json) plan.human = stopHumanLines(stop, card, extra)
      return plan
    }
    for (let hop = 0; hop <= workflow.stages.length + 2; hop += 1) {
      let task = await loadTask(projectRoot, name, { workflow, policy, repair: true })
      // 锁内重读登记簿：状态不可证时保留原 ID，不自动重建或继续派发。
      const preRegistry = await readRegistry(task)
      if (preRegistry.corrupt) return planStop("blocked", { ok: false, task: name, stage: currentStageOf(task.journal, task.scope), status: "blocked", code: "AGENTS_STATE_CORRUPT", blockers: [{ message: "会话登记簿不可验证：" + preRegistry.corrupt, recovery: "保留原文件与 ID，核对恢复映射后重试。" }] })
      const pendingBefore = pendingDecisionDetail(task.journal)
      // 其他待决卡优先，不能先物化模板或以新的意图卡覆盖它。
      if (!pendingBefore || pendingBefore.gateId === INTAKE_GATE) {
        if (await ensureE2ePackages(task)) task = await loadTask(projectRoot, name, { workflow, policy, repair: true })
      }
      // §6.2 真正推进/完成前的锁内核验：磁盘原始字节与各包有效清单摘要比对，结果经 derive → gateCheck
      const artifactVerification = await verifyStageArtifacts(projectRoot, task, currentStageOf(task.journal, task.scope))
      if (!artifactVerification.ok) warnings.push(...artifactVerification.mismatches.map((m) => "磁盘内容与登记摘要不一致：" + (m.path ?? "?") + "（" + m.reason + "）——阶段推进将被阻止；恢复：tw restore 或授权刷新"))
      let state = deriveTask({ ...task, artifactVerification })
      const firstDispatch = !task.journal.some((event) => event.type === "dispatched")
      let effectiveWritable = writable
      if (task.scope?.intakeVersion === 2 && firstDispatch && !(Array.isArray(task.packages) && task.packages.length) && (!pendingBefore || pendingBefore.gateId === INTAKE_GATE)) {
        if (writable.length) {
          const valid = writable.length === 1 && writable[0] === "none" || writable.every(validWritableSpec)
          if (!valid) throw fail("DISPATCH_INPUT_REQUIRED", "首派可写声明须为项目内相对路径:产物类型，或单独使用 none。")
          if (digestValue(task.scope.firstWritable ?? null) !== digestValue(writable)) {
            task.scope = { ...task.scope, firstWritable: [...writable] }
            await atomicJson(path.join(task.root, "scope.json"), task.scope)
          }
        }
        if (!writable.length && Array.isArray(task.scope.firstWritable)) effectiveWritable = task.scope.firstWritable
      }
      // 首卡在任何推进之前签发；已待决的同一意图卡按相同投影重显或失效重签。
      const pending = pendingDecisionDetail(task.journal)
      if (task.scope?.intakeVersion === 2 && (firstDispatch || pending?.gateId === INTAKE_GATE) && (!pending || pending.gateId === INTAKE_GATE)) {
        const prepared = await prepareDispatch({ task, workflow, policy, state })
        if (prepared.card) return planStop(prepared.card.transition === "await-decision" ? "awaiting-user" : "blocked", prepared.card)
        state = deriveTask(task)
      }
      // 派发链零配置反查（§3.8）：roles/packages 缺失由 runTransition 返回可恢复卡。
      const card = await runTransition({ projectRoot, name, writable: effectiveWritable, workflow, policy, task, state })
      if (card.transition === 'dispatch') {
        const list = card.dispatches ?? (card.dispatch ? [card.dispatch] : [])
        const resolved = await resolveTiers()
        warnings.push(...resolved.warnings)
        const registry = await readRegistry(task)
        if (registry.corrupt) return planStop('blocked', { ok: false, task: name, stage: state.stage, status: 'blocked', code: 'AGENTS_STATE_CORRUPT', blockers: [{ message: '会话登记簿不可验证：' + registry.corrupt, recovery: '保留原文件与 ID，核对恢复映射后重新对账。' }] })
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
          const writerSafety = d.role === 'owner' ? writerSafetyOf(task, registry, d.writable) : null
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
            ...(d.continuation && !(prevKeyOf(d) && agentMaps[prevKeyOf(d)]) ? { expectedAgentIdMissing: true, resumeNote: '未找到可续会话映射（含 session-reset 边界后）：不得凭缺失映射推定旧会话不存在或覆盖旧 ID；请先核对宿主与登记事实，状态不确定时保持 recover。' } : {}),
            ...(d.scope ? { scope: d.scope } : {}),
            ...(pkgDef ? { dependsOn: pkgDef.dependsOn ?? [] } : {}),
            writable: d.writable ?? [],
            ...(writerSafety?.required ? { writerSafety } : {}),
            prompt: d.prompt, promptDigest: sha256(d.prompt), promptFrozen: true,
            ...(d.promptFull ? { promptFull: d.promptFull, promptFullDigest: sha256(d.promptFull) } : {}),
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
            plan.human.push('-- ' + w.role + '(' + w.tier + ') ' + w.kind + ' 第 ' + w.round + ' 轮' + (w.package ? ' · 包 ' + w.package : '') + (w.continuation ? ' · 续派' : '') + String.fromCharCode(10) + '模型：' + describeModelRef(w.modelRef) + '（来源 ' + w.modelSource + '）' + String.fromCharCode(10) + (w.writerSafety?.required ? '写者停写核对未完成，禁止自动投递重叠写范围：' + JSON.stringify(w.writerSafety.conflicts) + String.fromCharCode(10) : '') + '派单全文：' + String.fromCharCode(10) + w.prompt + (w.promptFull ? String.fromCharCode(10) + '断链重建/空壳补发用全量变体（原会话不可用时以此为准）：' + String.fromCharCode(10) + w.promptFull : '') + String.fromCharCode(10) + '交付示例：' + w.dispatchExample)
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
// F-N2（§6.3）：help 由运行时按既有三层规则解析并返回 Lead 通用 README（不再依赖技能目录猜包根）；
// 具体时点规则仍由派发/决定/进展通道的 resolveLeadRules 按时点输出。
async function helpCard({ projectRoot = process.cwd() } = {}) {
  const lead = await resolveLeadGeneralRules({ projectRoot }).catch(() => ({ text: "", sources: [] }))
  return {
    ok: true,
    ...(lead.text ? { leadGeneralRules: lead.text, leadGeneralRulesSources: lead.sources } : {}),
    commands: {
      plan: "tw plan --task <n> --packages <JSON数组>：登记拆分并物化逐包 ModelRef（{id, model?} | {id, tier?} | {id}；机械验收：互斥/无环/完成标准；语义质量归 Lead）。同内容重复 plan 零写入（changed:false，不产生 re-planned，也不解除任何 blocked）；解除按包 blocked 用 --resolve-blocked '{\"package\":\"a\",\"action\":\"retry\",\"reason\":\"用户方向\"}' --blocked-ref <run 卡 blockedPackages 列出的 ref> 准备 package-recovery 卡（action 可选 retry 或 remove；有候选计划时先处理意图确认卡），用户确认后仅解除所选包",
      "agent-map": "tw agent-map --task <n> --key <派单key> --agent <平台subagentId>：登记派单→成员续派映射（tw-dispatch 按派单 modelRef 创建）",
      roles: "tw roles --task <n> [--set <role>=<provider>/<model>[@<effort>] | <role>=tier:<junior|senior|expert>[@<effort>]] [--clear <role>] [--resolve]：任务角色模型的唯一读写入口（agents.json.roles）",
      open: "tw open --name <n> --objective <o> [--entry <stage>] [--risk normal|high|critical] [--raw-requirement <原文>] [--constraint <文本>]... [--exclusion <文本>]... [--scope-note <文本>]... [--acceptance <文本>]... [--gap <JSON>]...：开任务并返回准备回执；补齐原文和计划后由首次推进签发完整确认卡",
      run: "tw run --task <n>：只读查状态（当前状态卡 + 下一步指引；不写任务事实。推进用 tw-dispatch / dispatch-plan）",
      "dispatch-plan": "tw dispatch-plan --task <n> [--json] [--writable <路径>:<kind> ...]：推进一步——推进到派发点或 stop 卡，输出波次计划（prompt + modelRef + modelSource）；路径以 / 结尾 = 目录授权；无 --json 输出人读 human 字段",
      decide: "tw decide --task <n> --choice <序号> --decision-id <卡片标识> [--note <...>]：按 decisionId 任意审批有效卡片（多卡时缺 ID 同步拒绝并列出全部卡 ID/用途）；仅一张普通历史卡可省略 ID，意图卡/刷新卡/包恢复卡必须携带实际向用户展示且被答复的卡片 ID；重复相同 ID/选项幂等重放原结果",
      intent: "tw intent --task <n> [--objective <...>] [--raw-requirement <原文>] [--add-constraint <...>] [--add-exclusion <...>] [--acceptance <...>] [--scope-note <...>] [--add-gap <JSON>] [--answer-gap <id> --answer <文本>]：修订意图，改后确认卡重签",
      route: "tw route --task <n> --route spec|e2e --decision run|skip [--basis <依据>]：SPEC/E2E 显式路由",
      gate: "tw gate --task <n>：只读门禁检查（blockers + 修复建议）",
      models: "tw models：只读调用配置快照的 tier→模型解析结果与 entry/profile 来源",
      init: "tw init [--force]：装载 .dsh/skills/ 下 team-work-v3、clarity-writing、clarity-review 三目录及 clarity-guidance/output-standard.md 单文件（默认逐项保留，--force 只覆盖四目标，不清理其他文件），并把包内 team-work/rules/ 出厂模板增量释放到用户公共规则目录 ~/.team-work/rules/（缺失补齐；用户未改过的旧默认静默升版；用户改过的保留并写 <stem>.default.md 旁路，--force 也不覆盖用户修改）",
      restore: "tw restore --task <n> --path <路径> [--list | --source <报告@版本>]：默认从该路径最新未作废有效报告恢复原始字节（快照先验摘要再写回）；--list 只读列出可验证的非作废版本；--source 恢复用户明确选择的历史版本（只写文件不改当前有效清单，字节异于基线时后续门禁仍不通过）",
      retire: "tw retire --task <n> --wave <wvN> --reason <原因>：作废未结波（仅 Lead；解除在途，已交付报告保留审计）",
      migrate: "tw migrate --task <n>：既有任务波身份迁移（追加 wave-assigned 事件；异 digest 冲突出选择卡）",
      archive: "tw archive --task <n>：归档（用户确认后；归档目录只读）",
      deliver: "成员交卷：tw deliver --task <n> --key <k> --outcome delivered --summary <一句话> --paths <路径1> --paths <路径2> [--checks <JSON>] [--unresolved <JSON>]——--paths 是本包当前阶段的**完整交付清单**（不是增量：要保留的旧文件必须全部重新列入，未列入即移出本包有效制品；blocked 必须 paths 为空）。每路径重复 --paths 或用一个逗号分隔参数；单个 --paths 后的空格分隔路径只收集第一个，交卷后核对 manifest/removed。拒绝未知/重复单值参数",
      review: "成员阅卷：tw review --task <n> --key <k> --recommendation accept|rework|escalate --summary <一句话> [--findings <JSON>] [--verdict <JSON>]——findings 每项 {severity, statement, disposition?:must-fix|context, scope:{kind:all-covered|packages, ids:[包ID]}}；旧 package/packages 字段拒绝；返工目标 = must-fix scope 并集；Expert 必填完整 verdict（outcome/rationale/confidence/recommendedAction）且双结论按一致性矩阵校验",
      "refresh-artifacts": "tw refresh-artifacts --task <n> [--package <包>] [--paths-json '<完整路径 JSON 数组>'] --reason <说明>：Lead 受用户明确输入后准备刷新待审基线的确认卡（只登记用户确认的当前磁盘字节为 Lead 来源新基线，不替 Owner 写文件、不代表评审通过）；用户按实际展示的 decision-id 调 tw decide 确认后单次原子提交（决定+刷新报告+受影响旧门作废）",
    },
    notes: [
      "卡片即接口：按返回卡片行动，不预判步骤；拒绝输出自带修复指引",
      "Lead 通用规则见上方 leadGeneralRules（由运行时按 用户公共 ~/.team-work/rules → 包内出厂默认 → 项目 team-work/rules 三层合并解析；具体时点规则随派发/决定/进展卡片输出，不依赖技能目录猜相对路径）",
      "模型数据链：默认档只来自 team-work/policies/default.json；tw open 把三角色解析成 ModelRef 存 agents.json.roles；tw plan 把每包解析成 packages.json[].model；派发直接读 pkg.model ?? roles[role]，不在派发期查配置",
      'ModelRef={provider, modelName, effort?, family?}：effort 只在配置了合法枚举时出现，不设置时省略字段（宿主实测 "" 与 "none" 均被拒绝）；宿主字段映射只在绑定层 toHostTarget 一处发生',
      '配置来源为当前 profile 的 team-work-dsh.tiers；宿主每次调用提供 TW_DSH_CONFIG JSON={tiers,entryId:"team-work-dsh",profile:<来源或 unresolved>} 快照。无宿主终端由调用方显式提供相同输入；缺失、损坏或缺档返回 unresolved，不读取旧配置文件或写缓存',
      "新任务先准备原始需求、角色和完整分包（或首派可写范围），首次推进签发一张完整意图确认卡；确认前不派发。无歧义确认直接携展示卡 ID 决定，有歧义先澄清；实际配置变化后重签。",
    ],
  }
}

async function twInner(argv, { projectRoot = process.cwd(), stdout = process.stdout, userRulesRoot } = {}) {
  const [cmd, ...rest] = argv
  const args = {}
  for (let i = 0; i < rest.length; i += 2) args[rest[i].replace(/^--/, "")] = rest[i + 1]
  const flag = (key) => argv.filter((a) => a === `--${key}`).length ? [argv[argv.indexOf(`--${key}`) + 1]] : []
  const common = { projectRoot }
  checkFlags(cmd, rest)
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
      case "decide": return await cmdDecide({ ...common, name: args.task, choice: Number(args.choice), note: args.note, decisionId: args["decision-id"] })
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
      case "restore": return await cmdRestore({ ...common, name: args.task, target: args.path, source: args.source, list: rest.includes("--list") })
      case "refresh-artifacts": return await cmdRefreshArtifacts({ ...common, name: args.task, pkg: args.package ?? null, pathsJson: args["paths-json"] ?? null, reason: args.reason ?? null })
      case "retire": return await cmdRetire({ ...common, name: args.task, wave: args.wave, reason: args.reason })
      case "migrate": return await cmdMigrate({ ...common, name: args.task })
      case "gate": return await cmdGate({ ...common, name: args.task })
      case "archive": return await cmdArchive({ ...common, name: args.task })
      case "plan": return await cmdPlan({ ...common, name: args.task, packagesJson: args.packages, resolveBlocked: args["resolve-blocked"] ?? null, blockedRef: args["blocked-ref"] ?? null })
      case "agent-map": return await cmdAgentMap({ ...common, name: args.task, key: args.key, agent: args.agent, modelHint: args["model-hint"] })
      case "dispatch-plan": return await cmdDispatchPlan({ ...common, name: args.task, writable: collectWritable(argv), json: argv.includes("--json") })
      case "models": return await cmdModels(common)
      case "init": return await cmdInit({ ...common, force: argv.includes("--force"), userRulesRoot })
      case "help": return await helpCard({ projectRoot })
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
