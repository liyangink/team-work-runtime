// cli.mjs — tw CLI：v3 工具契约的参考实现（§4）
// 卡片输出为 JSON（Lead 在 DSH 里用 bash 调用并解析）；拒绝输出带修复指引（P2）。
import { randomBytes } from "node:crypto"
import { accessSync, constants } from "node:fs"
import { readFile, rm, cp, mkdir, access } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { initTask, loadTask, taskExists, taskRoot, archiveRoot, controlRoot, atomicJson, atomicWrite, withOwnerLock, validName, readJson } from "./store.mjs"
import { deriveTask } from "./derive.mjs"
import { gateCheck, artifactsFingerprint, artifactFingerprints, reviewChainFingerprint, humanDecisionFresh } from "./gate.mjs"
import { scenePolicy, projectRounds, inflightBatch, supersededKeys, waveGroups, waveIdOf } from "./waves.mjs"
import { registerDelivery, registerReview } from "./intake.mjs"
import { loadGuidance } from "./guidance.mjs"
import { TIERS, resolveTiers, computeModelHint } from "./dsh-map.mjs"
import { writableMatch, writablePathsOverlap } from "./domain/writable.mjs"

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
    TASK_EXISTS: "换一个任务名，或用 tw dispatch-plan --task <name>（或 tw-dispatch）继续既有任务",
    TASK_NOT_FOUND: "检查拼写；tw open 创建新任务",
    TASK_NAME_INVALID: "任务名使用小写字母/数字/连字符，≤64 字符",
    OPEN_INPUT_REQUIRED: "open 需要 --name 与 --objective；可选 --entry <stage>",
    DECISION_STALE: "读取最新卡片（tw run 查看；重签经 tw-dispatch / tw dispatch-plan）后按其中的选项序号重新 decide",
    ENTRY_UNKNOWN: "--entry 必须是 workflow 声明的阶段之一",
    DISPATCH_INPUT_REQUIRED: "Owner 波次派发需要 --writable <path>:<kind>（可多次；路径以 / 结尾 = 目录授权，如 docs/:doc）",
    MAP_INVALID: "在 DSH 全局 settings.yaml 的 team-work-dsh.tiers 配置 junior/senior/expert；每档提供非空 provider 与 model（可为候选数组）",
    STATE_CORRUPT: "控制文件损坏：任务事实在 reports/journal，可重推导；遗留 dsh.json 不参与读取",
    RETIRE_UNKNOWN_WAVE: "tw run 或 dispatch-plan 的 wait-inflight 卡片输出当前波 waveId；请核对后重试",
    RETIRE_SETTLED_WAVE: "该波已全部交付（已结波），无需作废；要解除未交付在途请核对 waveId（run 卡片列出当前未结波）",
    LOCK_UNAVAILABLE: "任务锁被并发写者占用（成员交付/Lead 推进同时进行）：等几秒原样重试同一命令即可；崩溃进程的锁会被自动回收",
    LOCK_CORRUPT: "任务锁读取异常：崩溃残留的损坏锁会在约 10 秒后自动回收；持续失败且确认无并发写者时，可手动删除任务目录 locks/task.lock",
  })[code] ?? "运行 tw help 查看全部命令与参数"
}

// ── 汇报呈现纪律（稳定注入）─────────────────────────────────────────────
// 病灶：Lead 向用户汇报是「人机对话」——用户没看过工具调用与卡片原文；会话越长，
// Lead 越被卡片里的编号/术语同化，汇报退化成编号+黑话（认知不对等随轮数恶化）。
// 因此呈现纪律不依赖 skill 一次性装载，而是随每次汇报时机的卡片输出重新在场：
// awaiting-user（用户决定点）带完整纪律 + 阶段工作摘素材（progress）；
// dispatch/进展转折卡带简报纪律。注入为纯静态文本（E2E-14 终态幂等不受影响）。
const PRESENTATION_DECISION = [
  "呈现纪律（向用户转述本卡片时必须遵守，不因会话变长而省略）：",
  "- 用户没有看过你的中间过程。汇报要自足：用完整句子说明这阶段实际做了什么、改动了哪些文件、评审意见怎么说、还有什么风险或分歧、现在需要用户决定什么。",
  "- 用面向不了解任务细节的人的自然语言；卡片与任务目录里的编号（波次号、派单 key、指纹、规则编号）和内部术语（阶段名、波类型、gate id）不得原样抛给用户，需要引用时翻译成业务语言。",
  "- 不得只报选项编号（如「选 1 还是 2」）而不解释每个选项的实际后果。",
  "- progress 字段（若在场）是本阶段工作摘要素材：用它组织汇报，但用你自己的话完整表达。",
].join("\n")
const PRESENTATION_PROGRESS = "向用户汇报本卡片时用自然语言完整说明（做了什么、下一步会发生什么、需要用户做什么），不要输出卡片字段名或内部编号。"
const PRESENTATION_DISPATCH = "向用户简报：本阶段派发了什么角色的成员做什么工作。派单全文（dispatch.prompt）原样转发给成员执行，不要复述给用户。"

// 呈现注入（出口统一，单点全覆盖）：awaiting-user = 用户决定点（完整纪律）；
// dispatch = 派发简报；advance/complete/blocked/wait-inflight = 进展转折。
// 成员 deliver/review 回执、登记/查询类命令不命中（无这些字段），自然跳过。
function attachPresentation(card) {
  if (!card || typeof card !== "object" || Array.isArray(card) || card.presentation) return card
  if (card.status === "awaiting-user") return { ...card, presentation: PRESENTATION_DECISION }
  if (card.transition === "dispatch") return { ...card, presentation: PRESENTATION_DISPATCH }
  if (card.transition === "advance" || card.transition === "complete" || card.transition === "blocked" || card.transition === "wait-inflight") {
    return { ...card, presentation: PRESENTATION_PROGRESS }
  }
  return card
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
  return sections.length ? '## 本轮返工/回应原因\n\n' + sections.join('\n\n') : ''
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

// 组合评审被审制品清单（当前阶段登记产出物按包分组；P4：runtime 自有事实推导）
function NLART(task) {
  const stage = task.workflow ? null : null
  const items = (task.artifacts?.items ?? []).filter((it) => it.stage === (task.reports?.at(-1)?.stage ?? it.stage))
  // 路径:kind 条目解析与 parseWritableEntry 同口径（lastIndexOf 冒号，路径可含冒号）；目录条目覆盖其下路径
  const entryPathOf = (w) => { const s = String(w); const sep = s.lastIndexOf(':'); return sep === -1 ? s : s.slice(0, sep) }
  const lines = (task.packages ?? []).map((p) => {
    const paths = items.filter((it) => writableMatch((p.writable ?? []).map((w) => ({ path: entryPathOf(w) })), it.path)).map((it) => it.path)
    return '- 包 ' + p.id + '：' + (paths.join('、') || '（无登记产出物）')
  })
  return lines.length ? String.fromCharCode(10) + lines.join(String.fromCharCode(10)) : '（当前阶段登记产出物：' + items.map((it) => it.path).join('、') + '）'
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
  for (let i = journal.length - 1; i >= 0; i -= 1) {
    const e = journal[i]
    if (e.type === 'stage-advanced') break
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

// 在途派单重建（F3/F4）：当前未结波中尚无 report 的派发，重建完整派单文本（统一走 waves.inflightBatch）。
// §7.3 兜底三字段（dispatch 自身崩溃窗口的恢复事实，由 runtime 锁内投影——绑定层不直读账本）。
// 调用方约束：必须在任务锁内调用（registered 查 agents.json 与 journal 读取要求同一临界区）。
// - modelHint：journal dispatched 快照回填；老 journal 无快照时按重建 tier 从当前全局 tiers 解析降级
//   （§7.5.7 降级链）；仍不可解析置 modelHintUnresolved（消费方不得据此创建，指 tw retire --wave 回收）；
// - expectedAgentId：仅续派条目——continuationPrevKey 回溯老 key 查 mappings；
// - promptFull：仅续派条目——全量 prompt 变体（C②：断链 fresh 重建/空壳补发用，绑定层只选用不拼装）；
// - registered：锁内查 mappings 该 key 有无对应代理（tw-dispatch 判定链的判定事实；
//   agents.json 缺失/损坏时字段降级为缺失，消费方透传不补派）。
async function inflightDispatches(task, stageId, guidance = null) {
  const stageDef = task.workflow.stages.find((st) => st.id === stageId)
  const inflight = inflightBatch({ journal: task.journal, reports: task.reports })
  if (!inflight) return []
  // agents.json 缺失 = 零登记事实（registered=false，补派安全）；损坏 = 判定事实不可得（registered
  // 字段降级为缺失，tw-dispatch 透传不补派——宁透传不误派）。
  let mappings = {}
  let registryCorrupt = null
  try {
    mappings = ((await readJson(path.join(task.root, "agents.json"), { allowMissing: true })) ?? {}).mappings ?? {}
  } catch (error) {
    registryCorrupt = String(error?.message ?? error)
  }
  const excludedKeys = supersededKeys(task.journal)
  const resolvedTiers = await resolveTiers()
  return inflight.open.map((d) => {
    const card = dispatchCard({ ...task, policy: task.policy }, stageDef, { kind: d.kind, role: d.role, round: d.round, ...(d.scope ? { scope: d.scope } : {}) }, { key: d.key, package: d.package ?? null, round: d.round, continuation: d.continuation, writable: d.writable ?? [], waveId: d.waveId ?? null }, guidance).dispatch
    // modelHint 回填降级链：journal 快照 → 按重建 tier 从当前全局 tiers 解析 → 不可解析标记（指 retire）
    let modelHint = d.modelHint && d.modelHint.provider && d.modelHint.model ? d.modelHint : null
    let modelHintUnresolved = false
    if (!modelHint) {
      const hint = computeModelHint(resolvedTiers.tiers[card.tier], [])
      if (hint?.provider && hint?.model) modelHint = hint
      else modelHintUnresolved = true
    }
    const prevKey = d.continuation ? continuationPrevKey({ journal: task.journal, agentMaps: mappings, excludedKeys }, d) : null
    return {
      ...card,
      dispatchKey: card.key,  // D4：输出层补 dispatchKey（与 dispatch-plan waves[] 字段统一；key 字段保留兼容）
      ...(modelHint ? { modelHint } : {}),
      ...(modelHintUnresolved ? { modelHintUnresolved: true } : {}),
      ...(d.continuation && prevKey && mappings[prevKey] ? { expectedAgentId: mappings[prevKey] } : {}),
      // mappedAgentId：该 key 已登记的 childId 值（判定链四态用：registered=true ≠ 子代理存在，
      // 消费方按四态处置——活→等待/冷归属一致→冷唤醒/异主→接管冲突/无记录→同 id 重建；机器防双发的事实源，P4 投影）
      ...(registryCorrupt ? {} : mappings[card.key] ? { mappedAgentId: mappings[card.key] } : {}),
      ...(registryCorrupt ? {} : { registered: Boolean(mappings[card.key]) }),
      ...(registryCorrupt ? { registeredUnresolved: registryCorrupt } : {}),
    }
  })
}

// 档位序与 risk 升档（v3.2）：risk 由用户在 open/intent 给出，仅升 owner 档（challenger/expert 不受影响）
const TIER_RANK = { junior: 1, senior: 2, expert: 3 }
// 档位计算（pre-phase3 §A）：实际档 = max(包 tier ?? 场景默认, riskTiers[risk])
function ownerTierFor(task, sp, pkg = null) {
  const base = sp.ownerTier
  const pkgTier = (task.packages ?? []).find((p) => p.id === pkg)?.tier
  // risk 语义修正（用户裁决）：risk 不再无差别抬全部包——仅当包未显式定 tier 时作为兜底抬档；
  // 包有显式 tier = Lead 的包级判断优先（risk 任务里的外围机械包保持默认档）。
  if (pkgTier) return pkgTier
  const up = task.policy?.riskTiers?.[task.intent?.risk]
  return up && (TIER_RANK[up] ?? 0) > (TIER_RANK[base] ?? 0) ? up : base
}
// 升档审批判定（C 触发条件）：包 tier 高于场景默认（直接比较）。
// risk=critical/high 且包未显式定 tier 的升档免审批——用户在 open 时已知情授权，不重复打扰。
function isEscalatedTier(task, sp, pkg) {
  const pkgTier = (task.packages ?? []).find((p) => p.id === pkg)?.tier
  return Boolean(pkgTier && (TIER_RANK[pkgTier] ?? 0) > (TIER_RANK[sp.ownerTier] ?? 0))
}
// 升档批准指纹（Expert 裁决 r2 幽灵复活封堵 + 返工终版 F-2 扩字段）：授权对象 = 完整包配置序列化
//（id+tier+writable+done+dependsOn——re-plan 改任何包配置维度都使旧批准失效）。签发、批准落盘、
// 幂等查找、decide 校验四处共用同一指纹；历史批准记录无该字段视为失效（多问一次优于误授权）。
// 排序保证同配置不同书写顺序同指纹；纯函数（四处同源，防漂移）。
function escalationFingerprint(task) {
  return JSON.stringify(
    (task.packages ?? [])
      .map((p) => ({ id: p.id, tier: p.tier ?? null, writable: p.writable ?? [], done: p.done ?? [], dependsOn: p.dependsOn ?? [] }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
  )
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
// guidance（可选）：角色/场景公共引导库（team-work/guidance），按 role+teamScene 检索注入；
// 缺失或未加载时跳过——引导是增强，不阻塞派发。
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

function dispatchCard(task, stageDef, wave, detail, guidance = null) {
  const sp = scenePolicy(task.policy, stageDef.teamScene)
  const pkg = detail.package ?? null
  const boundaries = detail.writable.map(({ path: p, artifactKind }) => p + (p.endsWith('/') ? '（目录授权：其下路径均可写）' : '') + (pkg ? '（包 ' + pkg + '，产出物 ' + artifactKind + '）' : '（产出物 ' + artifactKind + '）'))
  const lastBlocked = (wave.kind === 'produce' || wave.kind === 'respond') ? lastOwnerBlockedSummary(task, pkg) : null
  const deliverCmd = twCommand() + ' deliver --task ' + task.name + ' --key ' + detail.key + ' --outcome delivered --summary <一句话> --paths <可写路径>'
  const verdictArg = ' --verdict <JSON: outcome|rationale|confidence|recommendedAction>'
  const reviewCmd = twCommand() + ' review --task ' + task.name + ' --key ' + detail.key + ' --recommendation <accept|rework|escalate> --summary <一句话>' + (wave.kind === 'verdict' ? verdictArg : '')
  const intro = detail.continuation ? '# 续派（key: ' + detail.key + '）——你在原上下文基础上继续' : '# 派单（key: ' + detail.key + '）'
  const headLine = '任务：' + task.name + '；阶段：' + stageDef.id + '（' + stageDef.label + '）；角色：' + wave.role + '；轮次：' + (detail.round ?? wave.round) + (pkg ? '；包：' + pkg : '') + (detail.waveId ? '；波：' + detail.waveId : '')
  const roleHint = guidance?.roles?.[wave.role]
  const sceneHint = guidance?.scenes?.[stageDef.teamScene]
  // 意图上下文三段（C② 全量变体的内嵌内容；非 continuation 派单的 prompt 本身就是全量）
  const contextParts = [
    '目标：' + task.intent.objective,
    task.intent.constraints.length ? '约束：\n' + task.intent.constraints.map((c) => '- ' + c).join('\n') : '',
    task.intent.exclusions.length ? '排除：\n' + task.intent.exclusions.map((c) => '- ' + c).join('\n') : '',
  ]
  const headParts = [
    intro,
    headLine,
    roleHint ? '## 角色指引（' + wave.role + '）\n' + roleHint : '',
    sceneHint ? '## 场景指引（' + stageDef.teamScene + '）\n' + sceneHint : '',
  ]
  const tailParts = [
    wave.role === 'owner' ? '可写路径（仅限）：\n' + (boundaries.map((b) => '- ' + b).join('\n') || '（无，纯回应派单）') : '只读派单：不得修改任何文件',
    // §4 写边界补强（phase3 方案）：声明越界后果——三层防线可见化（派单纪律/ deliver 校验/快照恢复）
    wave.role === 'owner' ? '可写范围外的修改会被 deliver 拒绝；已越界污染的产出物可在恢复轮回滚（tw restore 快照恢复）。不要尝试绕过。' : '',
    wave.scope === 'consolidation' ? '组合评审：对象是本轮全部已交付包的组合制品——重点审包间接缝、需求偏移与集成风险；findings 请标注 package 归属（哪个包的问题）。被审制品清单：' + NLART(task) : '',
    // D6（台账）：评审/裁决派单内嵌包计划事实——把编排事实给到裁决者，
    // 消除"缺包误判 rework"（topo-e2e w17 实例：expert 不知道未交付包会自动解锁派发）
    (wave.role === 'challenger' || wave.role === 'expert') && Array.isArray(task.packages) && task.packages.length
      ? '本任务包计划：' + task.packages.map((p) => {
          const delivered = task.reports.some((r) => r.kind === 'deliver' && r.package === p.id)
          return p.id + (delivered ? '（已交付）' : '（未交付' + ((p.dependsOn ?? []).length ? '，依赖满足后自动派发' : '') + '）')
        }).join('、') + '——未交付包不构成 rework 依据；对完整性的顾虑写进 findings 或 unresolved。'
      : '',
    wave.kind === 'produce' || wave.kind === 'respond' ? '完成后调用：' + deliverCmd : '完成后调用：' + reviewCmd,
    wave.kind === 'verdict' ? 'Expert 裁决语义：recommendation 概括立场；verdict 是技术裁决正文（outcome/rationale/confidence/recommendedAction）。两者都通过上面的 review 调用提交，不要只写成文字。' : '',
    wave.kind === 'respond' ? reworkContext(task, stageDef.id, pkg) : '',
    lastBlocked ? '## 上一轮 blocked 原因\n' + lastBlocked + '\n本轮可写范围已由 Lead 重新声明；若仍无法完成，请再次以 --outcome blocked 交付并在 summary 写明还缺什么。' : '',
    '上下文与派单已内嵌；不要读取 .team-work 内部状态，不要扫描项目外路径。',
  ]
  // C② 全量 prompt 变体（返工终版 §二·C）：continuation 派单的增量正文假设成员有原上下文——
  // 断链 fresh 重建 / 空壳（未收单）补发时新成员没有上下文，增量单不可执行。runtime 在导出层附
  // promptFull（objective/constraints/exclusions 内嵌），绑定层只选用不拼装（P4 与 §7.1 评审先例）。
  const join = (sections) => sections.filter(Boolean).join('\n\n')
  const prompt = join([...headParts, ...(detail.continuation ? [] : contextParts), ...tailParts])
  const promptFull = detail.continuation
    ? join([
        ['# 续派全量变体（key: ' + detail.key + '）——原会话上下文不可用时的自足派单', headLine],
        headParts.slice(2),
        contextParts,
        tailParts,
      ].flat())
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
      tier: wave.role === 'owner' ? ownerTierFor(task, sp, pkg) : wave.role === 'challenger' ? sp.challengerTier : 'expert',
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

async function cmdOpen({ projectRoot, name, objective, entry, risk }) {
  if (!name || !objective) throw fail("OPEN_INPUT_REQUIRED", "open 需要 --name 与 --objective")
  if (risk && !['normal', 'high', 'critical'].includes(risk)) throw fail("USAGE", "--risk 只能是 normal | high | critical（high→senior Owner、critical→expert Owner，仅升不降）")
  const { workflow } = await loadDefinitions(projectRoot)
  const resolvedEntry = entry ?? "research"
  if (!workflow.stages.some((s) => s.id === resolvedEntry)) throw fail("ENTRY_UNKNOWN", `未知阶段：${resolvedEntry}`)
  const completion = entry ? { mode: "through-stage", stage: entry } : { mode: "workflow" }
  await initTask({ projectRoot, name, objective, entry: resolvedEntry, completion, workflowDigest: workflow.version, stages: workflow.stages.map((s) => s.id), risk })
  const baseNote = entry ? `任务从 ${entry} 介入，将运行到该阶段验收` : "任务将运行完整工作流"
  const riskNote = risk && risk !== 'normal' ? `；按 ${risk} 档运行：Owner 将升用 ${risk === 'critical' ? 'expert' : 'senior'} 档模型` : ""
  return { ok: true, task: name, stage: resolvedEntry, status: "working", next: "run", note: baseNote + riskNote }
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
    // F3/F4 在途重建（只读）：卡内嵌原派单全文与兜底判定事实（modelHint/expectedAgentId/registered）。
    // 恢复入口 = tw-dispatch：按条目 registered/expectedAgentId 逐条自动处置（已登记等待/续派指引/补派）；
    // 无插件终端按 dsh-orchestration 的 wait-inflight 规程手工处置。
    const guidance = await loadGuidance(projectRoot) // 惰性：在途重建按需加载
    const inflight = await inflightDispatches(task, state.stage, guidance)
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
        note: "任务静止等待用户：扩大可写范围后重派（单 owner 用新范围调 tw-dispatch 的 writables / tw dispatch-plan --writable <新范围>；多包先 tw plan 重拆再推进），或决定结束",
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
      if (pending.escalationFingerprint !== undefined && pending.escalationFingerprint !== escalationFingerprint(task)) {
        // 升档指纹失效（包配置变化）：同款 stale 指引；重签由 dispatch 通道作废旧卡后重新出卡
        return { ok: true, task: name, stage: state.stage, status: "awaiting-user", next: "re-sign", transition: "await-decision", decisionId: pending.decisionId, stale: true, question: pending.reason, note: "该升档待决卡已失效（签发后包配置变化，原选项不可再 decide）：调 tw-dispatch（或 tw dispatch-plan）重签最新卡片后重新 decide" }
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

function dispatchTiers(task, state, workflow, policy) {
  const wave = state.next.wave
  const stageDef = workflow.stages.find((stage) => stage.id === state.stage)
  const scene = scenePolicy(policy, stageDef?.teamScene ?? 'implementation')
  if (wave.role === 'owner') {
    const owners = wave.owners?.length ? wave.owners : [{ package: null }]
    return owners.map((owner) => ownerTierFor(task, scene, owner.package ?? null))
  }
  return [wave.role === 'challenger' ? scene.challengerTier : 'expert']
}

function modelConfigurationCard({ name, state, resolved, missing }) {
  const summary = [...new Set(missing)].join('、')
  return {
    ok: true,
    task: name,
    stage: state.stage,
    status: 'blocked',
    next: 'configure-models',
    blockers: [{
      code: 'MODEL_CONFIG_UNRESOLVED',
      message: `DSH 全局模型配置未解析：${summary}`,
      recovery: `编辑 ${resolved.file} 的 team-work-dsh.tiers，补齐 junior、senior、expert 的 provider/model 后重试 tw dispatch-plan。`,
    }],
    note: '未写入派发事实；修复全局配置后可原样重试。',
  }
}

function withModelHint(dispatch, selectModelHint) {
  const modelHint = selectModelHint?.(dispatch.tier) ?? null
  return modelHint ? { ...dispatch, modelHint } : dispatch
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
    ...(dispatch.modelHint ? { modelHint: dispatch.modelHint } : {}),
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

// 引导库惰性加载（P3-5）：loadGuidance 只在"真正派发"与"在途重建"两个分支内按需调用——
// 任务不存在（归档卡）、终态幂等完成卡、awaiting-user 静止、advance/blocked 等非派发路径
// 零引导 I/O（每次调用 = 4 次 readdir（包内 + 项目根 roles/scenes，项目根缺失静默跳过）
// + 全部引导文件读取，见 guidance.mjs）。
// 无模块级缓存：每次派发/补发重新全量读取，保住"改引导文件即下次派发生效"的热变语义。
// 锁内执行权衡：本函数整体在任务锁（locks/task.lock，见 cmdDispatchPlan 的 withOwnerLock）内运行，
// 引导读取计入持锁时间——代价通过惰性控制在最小（仅派发/在途重建分支才读），
// 换取"判定与写入同锁"（复核修复原则）：注入引导的派单文本与 dispatched/journal 事实
// 在同一临界区内落盘，并发 run 不会出现引导内容与派发事实错位或读到半程覆盖层的竞态。
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

async function runTransition({ projectRoot, name, writable, workflow, policy, task, state, selectModelHint }) {

  // blocked 静止卡的用户恢复通道（单 owner）：Lead 携新的可写范围经 dispatch 通道重派 = 用户重派指示
  // （规则 6：awaiting-user 只由新的用户输入恢复）。直接派新 produce 波——新 dispatched 晚于 blocked 报告，
  // 波次机的 blocked 判定自然解除；多包恢复走 plan 重拆（re-planned 同样晚于 blocked）后经 dispatch 通道推进。
  if (Array.isArray(state.next?.produceBlocked) && writable.length && writable[0] !== 'none' && !(Array.isArray(task.packages) && task.packages.length)) {
    const stageDef = workflow.stages.find((st) => st.id === state.stage)
    const { waveId, dispatchSeq } = nextWaveIdentity(task)
    const decl = writable.map(parseWritableEntry)
    const round = (projectRounds({ journal: task.journal, reports: task.reports }).get(null) ?? 0) + 1
    const wave = { kind: 'produce', role: 'owner', round, owners: [{ package: null, round, continuation: false }] }
    const d = { key: 'd' + dispatchSeq + '-' + randomBytes(3).toString('hex'), waveId, package: null, round, continuation: false, writable: decl }
    const guidance = await loadGuidance(projectRoot)
    const dispatch = withModelHint(dispatchCard({ ...task, policy }, stageDef, wave, d, guidance).dispatch, selectModelHint)
    await appendEventsUnlocked(task, [{ type: 'dispatched', detail: dispatchedDetail(dispatch, wave, decl) }])
    return { ok: true, task: name, stage: state.stage, status: 'working', next: 'dispatch', transition: 'dispatch', dispatch, dispatches: [dispatch], wave: { kind: wave.kind, role: wave.role, round: wave.round }, note: '已按新可写范围重派 produce（上一轮 blocked 解除）；派单卡内嵌上一轮 blocked 原因' }
  }

  if (state.next.kind === 'dispatch') {
    if (!state.next.wave) {
      // 门失败且非人工阻塞（如裁决/指纹失效且无法自动重派）：返回 blocker 卡（I5）
      const blockers = (state.gate?.blockers ?? state.next.hint ?? []).map((b2) => (typeof b2 === 'string' ? { message: b2, recovery: b2 } : b2))
      return { ok: true, task: name, stage: state.stage, status: 'blocked', next: 'none', blockers, transition: 'blocked' }
    }
    const wave = state.next.wave
    const stageDef = workflow.stages.find((st) => st.id === state.stage)
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
      // C（pre-phase3 §C）：升档审批——包 tier 高于场景默认的派发批次需用户批准一次（合批）。
      // 幂等身份 = stage + 波轮次 + 包集；已批准同批不再出卡；拒绝 = 本批按默认档派发（忽略包 tier）。
      if (wave.kind === 'produce' || wave.kind === 'respond') {
        const spC = scenePolicy(policy, stageDef.teamScene)
        const escFp = escalationFingerprint(task)
        const escPkgs = decls.filter((d) => isEscalatedTier(task, spC, d.package)).map((d) => ({ package: d.package, tier: (task.packages ?? []).find((p) => p.id === d.package)?.tier }))
        if (escPkgs.length) {
          const batchRound = Math.max(...decls.map((d) => d.round))
          const batchKey = JSON.stringify([state.stage, batchRound, [...escPkgs.map((e) => e.package)].sort()])
          // 幽灵批准失效：批准绑定包配置指纹——re-plan 改包集/档位后，同 batchKey 的旧批准不再授权新批次
          // （历史批准记录无指纹字段同样视为失效：重新出卡是多问一次，误授权是成本事故，保守方向取前者）。
          const approved = task.decisions.find((dc) => dc.batchKey === batchKey && dc.escalationFingerprint === escFp && (dc.grant === 'approve-escalation' || dc.choice === '降回默认档继续'))
          if (!approved) {
            // 同批旧未决升档卡先作废再重签：包配置已变化，旧卡选项不可再答；不作废会让
            // pendingDecisionDetail 持续取到旧卡、decide 答旧卡永远不推进（死循环写路径）。
            const journalPending = pendingDecisionDetail(task.journal)
            if (journalPending && Array.isArray(journalPending.choices) && journalPending.choices.some((c) => c.grant === 'approve-escalation')) {
              await appendEventsUnlocked(task, [{ type: 'decided', detail: { decisionId: journalPending.decisionId, choice: 'superseded', reason: '包配置已变化，升档批次重签（旧卡与旧批准一并失效）' } }])
            }
            const decisionId = 'esc-' + randomBytes(3).toString('hex')
            const choices = [
              { n: 1, label: '批准升档', grant: 'approve-escalation', batchKey },
              { n: 2, label: '降回默认档继续', batchKey },
            ]
            // B 渲染同钉：reason 是唯一文本源（账本与签发返回卡同一字符串——重渲染禁止重算/改写）
            const escReason = '升档审批：' + escPkgs.map((e) => e.package + '→' + e.tier).join('、') + '（tier 高于场景默认档；权重倍数 junior:senior:expert = 1:10:50）'
            await appendEventsUnlocked(task, [{ type: 'decision-issued', detail: { decisionId, gateId: null, reason: escReason, choices, escalationFingerprint: escFp, batchKey } }])
            const escProgress = stageProgress(task, state.stage)
            return { ok: true, task: name, stage: state.stage, status: 'awaiting-user', next: 'decide', transition: 'await-decision', decisionId, question: escReason, escalations: escPkgs, choices, ...(escProgress ? { progress: escProgress } : {}) }
          }
        }
        // 已批准（或降回默认档）：按实际档派发——降级路径由 decisions 中 choice='降回默认档继续' 体现：包 tier 忽略。
        // 降档决定同样绑定指纹：re-plan 后旧「降回默认档」不吞掉新批次的升档询问。
        const declinedKey = JSON.stringify([state.stage, Math.max(...decls.map((d) => d.round)), [...decls.filter((d) => isEscalatedTier(task, spC, d.package)).map((d) => d.package)].sort()])
        const declined = task.decisions.some((dc) => dc.choice === '降回默认档继续' && dc.batchKey === declinedKey && dc.escalationFingerprint === escFp)
        if (declined) {
          const tiersBackup = task.packages
          task.packages = (tiersBackup ?? []).map((p) => ({ ...p, tier: undefined }))
          const guidance = await loadGuidance(projectRoot) // 惰性：降档同样要派发，派发前加载
          const cardsD = decls.map((d) => withModelHint(dispatchCard({ ...task, policy }, stageDef, wave, d, guidance).dispatch, selectModelHint))
          task.packages = tiersBackup
          await appendEventsUnlocked(task, cardsD.map((card, index) => ({ type: 'dispatched', detail: dispatchedDetail(card, wave, decls[index].writable) })))
          return { ok: true, task: name, stage: state.stage, status: 'working', next: 'dispatch', transition: 'dispatch', dispatch: cardsD[0], dispatches: cardsD, wave: { kind: wave.kind, role: wave.role, round: wave.round }, note: '用户选择降回默认档：本批按场景默认档派发' }
        }
      }
      const guidance = await loadGuidance(projectRoot) // 惰性：仅到达真正派发点才加载
      const cards = decls.map((d) => withModelHint(dispatchCard({ ...task, policy }, stageDef, wave, d, guidance).dispatch, selectModelHint))
      await appendEventsUnlocked(task, cards.map((card, index) => ({ type: 'dispatched', detail: dispatchedDetail(card, wave, decls[index].writable) })))
      return { ok: true, task: name, stage: state.stage, status: 'working', next: 'dispatch', transition: 'dispatch', dispatch: cards[0], dispatches: cards, wave: { kind: wave.kind, role: wave.role, round: wave.round } }
    }
    const key = newKey()
    const guidance = await loadGuidance(projectRoot) // 惰性：非 owner 派发同样只在派发点加载
    const card = dispatchCard({ ...task, policy }, stageDef, wave, { key, waveId, round: wave.round, continuation: wave.continuation, writable: [] }, guidance)
    const dispatch = withModelHint(card.dispatch, selectModelHint)
    await appendEventsUnlocked(task, [{ type: 'dispatched', detail: dispatchedDetail(dispatch, wave, []) }])
    return { ...card, dispatch }
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
    const guidance = await loadGuidance(projectRoot) // 惰性：在途重建（补发路径）按需加载
    const inflight = await inflightDispatches(task, state.stage, guidance)
    return {
      ok: true, task: name, stage: state.stage, status: 'working', next: 'wait', transition: 'wait-inflight',
      dispatchKey: state.next.dispatchKey,
      ...(state.next.waveId ? { waveId: state.next.waveId } : {}),
      wave: { kind: state.wave.kind, role: state.wave.role, round: state.wave.round },
      inflight,
      note: '波次 ' + state.wave.kind + '（' + state.wave.role + ' 轮次 ' + state.wave.round + '）已派发；在途派单（inflight 数组含 modelHint/expectedAgentId/registered 判定事实，可原样转发补派）：' + inflight.map((d) => d.key).join('、') + '。恢复：调 tw-dispatch（按条目自动等待/续派/补派）',
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
        note: "任务静止等待用户：扩大可写范围后重派（单 owner 用新范围调 tw-dispatch 的 writables / tw dispatch-plan --writable <新范围>；多包先 tw plan 重拆再推进），或决定结束",
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
      if (pending.gateId && pending.fingerprints && !humanDecisionFresh({ decided: pending.fingerprints, artifactFp: currentArtifactFp, reviewFp: currentReviewFp })) {
        // 指纹失效：作废旧卡（不删事实，只增 decided:superseded），落入下方重签
        await appendEventsUnlocked(task, [{ type: "decided", detail: { decisionId: pending.decisionId, choice: "superseded", reason: "等待期评审链或制品已变化，卡片自动失效重签" } }])
      } else if (pending.escalationFingerprint !== undefined && pending.escalationFingerprint !== escalationFingerprint(task)) {
        // 升档指纹失效（包配置变化）：作废旧卡后由 dispatch-plan 循环重推导重新出卡（升档签发在
        // dispatch 分支内，本函数不在此重签）——返回 re-sign 循环标记，防「静止渲染旧卡 + decide 拒答」死循环。
        await appendEventsUnlocked(task, [{ type: "decided", detail: { decisionId: pending.decisionId, choice: "superseded", reason: "签发后包配置已变化，升档卡自动失效重签" } }])
        return { ok: true, task: name, stage: state.stage, status: "working", next: "dispatch", transition: "re-sign-escalation", note: "升档待决卡因包配置变化已作废，正在按当前配置重新出卡" }
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
    // 升档审批卡同构校验：签发时绑定包配置指纹，等待期 re-plan 改动包集/档位后旧卡拒绝直答——
    // 否则答旧卡写入旧指纹批准，与当前批次指纹永不匹配（答了也白答的空转），且旧语义授权不可见地复活。
    if (pending.escalationFingerprint !== undefined && pending.escalationFingerprint !== escalationFingerprint(task)) {
      throw fail("DECISION_STALE", "该升档卡签发后包配置已变化（re-plan 改动了包集或档位），原选项不可再 decide：调 tw-dispatch / tw dispatch-plan 重签最新升档卡后重新 decide")
    }
    const decision = {
      decisionId: pending.decisionId,
      gateId: pending.gateId ?? null,
      choice: picked.label,
      ...(picked.grant ? { grant: picked.grant } : {}),
      ...(picked.batchKey ? { batchKey: picked.batchKey } : {}),
      // 升档批准绑定包配置指纹（签发指纹=当前指纹，校验已保证）：幂等查找据此识别幽灵批准
      ...(pending.escalationFingerprint !== undefined ? { escalationFingerprint: pending.escalationFingerprint } : {}),
      // F5/F6：决定绑定双指纹——artifactFingerprint（每包「包→指纹」映射）+ reviewFingerprint；
      // fingerprint 旧字段双写（§7 回滚兼容：旧版 runtime 读旧字段仍可判定）
      ...(pending.gateId ? { fingerprint: artifactsFingerprint(current), artifactFingerprint: artifactFp, reviewFingerprint: reviewFp } : {}),
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
    if (picked.label === "结束任务") events.push({ type: "task-completed", detail: { stage: stageId, by: "user", form: "partial" } })
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

async function cmdIntent({ projectRoot, name, objective, risk, addConstraint = [], addExclusion = [] }) {
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
  const gate = gateCheck({ workflow, policy, stageId: state.stage, scope: task.scope, artifacts: task.artifacts, reports: task.reports.filter((r) => r.stage === state.stage), decisions: task.decisions, journal: task.journal, packages: Array.isArray(task.packages) && task.packages.length ? task.packages : null })
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
  return { ok: true, task: name, archivedTo: path.relative(projectRoot, dest), form, kept: ["manifest.json", "artifacts/", "reviews(在 manifest)", "decisions.json", "journal-summary.jsonl"], cleaned: ["reports/", "snapshots/", "runtime 状态"] }
}

// plan（v3.2）：Lead 拆包登记 + 机械验收（P2 调用内一次查完）。
// 仅验机械属性（id 唯一/可写互斥/依赖无环/完成标准在场/路径合法）；拆分语义质量归 Lead（skill 指引）。
async function cmdPlan({ projectRoot, name, packagesJson }) {
  const { workflow, policy } = await loadDefinitions(projectRoot)
  let items
  try {
    items = JSON.parse(packagesJson)
  } catch {
    throw fail('USAGE', '--packages 不是合法 JSON 数组')
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw fail('USAGE', '--packages 必须是非空 JSON 数组：[{id, writable:["路径:kind"], done:["完成标准"], dependsOn:["包id"]}]')
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
    if (p.tier !== undefined && !['junior', 'senior', 'expert'].includes(p.tier)) reasons.push('包 ' + p.id + ' tier 非法：' + JSON.stringify(p.tier) + '（可选 junior|senior|expert；缺省用场景默认档）')
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
    // 重拆窗口（F6）：待决卡片或在途派发时禁止重拆（与 intent 修订同款语义）
    const state = deriveTask(task)
    // blocked 静止卡（produceBlocked）放行重拆：扩权重派正是该卡的恢复通道（re-planned 晚于 blocked 报告，
    // 波次机据此解除静止）；其余待决卡（人工门/路由/升档审批）仍禁止重拆，先 decide。
    if (state.status === 'awaiting-user' && !Array.isArray(state.next.produceBlocked)) throw fail('PLAN_REJECTED', '当前有待决用户卡片（' + (state.next.reason ?? '人工门') + '），禁止重拆；decide 后再试')
    // F3：在途判定统一走 waves.inflightBatch（与 derive/重建/提示同源；superseded 波不在在途）
    const inflight = inflightBatch({ journal: task.journal, reports: task.reports })
    if (inflight) throw fail('PLAN_REJECTED', '存在在途派发（' + inflight.open.map((d) => d.key).join('、') + '），禁止重拆；等成员交付或补派完成后再试')
    const had = task.packages != null
    await atomicJson(path.join(task.root, 'packages.json'), { items })
    await appendEventsUnlocked(task, [{ type: had ? 're-planned' : 'packages-planned', detail: { packages: items.map((p) => p.id) } }])
    return { ok: true, task: name, packages: items.map((p) => ({ id: p.id, dependsOn: p.dependsOn ?? [] })), replanned: had, next: 'dispatch', ...(tagWarn ? { warnings: [tagWarn] } : {}), note: had ? '包定义已更新（下一波生效）' : '包定义已登记；推进将按波组派发（tw-dispatch / tw dispatch-plan）' }
  })
}


// agent-map（v3.2/F5；定向委派第二阶段收敛为纯续派登记）：登记 dispatchKey → 平台 subagent id。
// 任务级注册表 task.root/agents.json 只保存 mappings——模型选择由 tw-tool-subagent 在创建子代理时直接指定
// （provider/model 落 agentOptions、effort 走首请求 selection），不经 agents.json 中转；modelHint 快照仍在
// journal 的 dispatched 事实内（dispatch-plan 导出给 Lead 当 target 用）。
// 续派波经 dispatch-plan 导出 expectedAgentId（同包同角色上一派发的映射）——Lead 据此 send_message 续原会话。
async function cmdAgentMap({ projectRoot, name, key, agent, modelHint }) {
  if (!key || !agent) throw fail('USAGE', 'agent-map 需要 --key <派单key> 与 --agent <平台subagentId>')
  const { workflow, policy } = await loadDefinitions(projectRoot)
  if (modelHint !== undefined) throw fail('USAGE', 'agent-map 不接受 --model-hint；模型选择在创建子代理时由 tw-tool-subagent 直接指定（target 取 dispatch-plan 的 modelHint）')
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
      note: '已登记派单映射（dispatchKey→childId，续派 send_message 用）；模型选择由 tw-tool-subagent 创建子代理时直接指定' +
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
    const resolved = await resolveTiers()
    const warnings = [...resolved.warnings]
    const planStop = (stop, card, extra = {}) => {
      const plan = { ok: true, task: name, stage: card.stage ?? null, stop, waves: [], card, ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}), ...extra }
      if (!json) plan.human = stopHumanLines(stop, card, extra)
      return plan
    }
    for (let hop = 0; hop <= workflow.stages.length + 2; hop += 1) {
      const task = await loadTask(projectRoot, name, { workflow, policy, repair: true })
      await ensureE2ePackages(task) // B：e2e 场景模板物化（幂等；advance 进入 e2e 后首轮生效）
      const state = deriveTask(task)
      if (state.next.kind === 'dispatch' && state.next.wave) {
        const unresolved = TIERS.filter((tier) => !resolved.tiers[tier]?.pool?.length)
        const unexpected = dispatchTiers(task, state, workflow, policy).filter((tier) => !TIERS.includes(tier))
        if (unresolved.length || unexpected.length) {
          return planStop('blocked', modelConfigurationCard({ name, state, resolved, missing: [...unresolved, ...unexpected] }))
        }
      }
      const usedFamilies = []
      const selectModelHint = (tier) => {
        const hint = computeModelHint(resolved.tiers[tier], usedFamilies)
        if (hint?.family) usedFamilies.push(hint.family)
        return hint
      }
      const card = await runTransition({ projectRoot, name, writable, workflow, policy, task, state, selectModelHint })
      if (card.transition === 'dispatch') {
        const list = card.dispatches ?? (card.dispatch ? [card.dispatch] : [])
        let agentMaps = {}
        try {
          agentMaps = ((await readJson(path.join(task.root, 'agents.json'), { allowMissing: true })) ?? {}).mappings ?? {}
        } catch (error) {
          // 账本损坏降级推进（I5 无死门）：续派回溯拿不到映射 → 波次导出走 expectedAgentIdMissing
          // fresh 重建路径（派单卡自带 resumeNote，恢复边在场）；dispatch-plan 是唯一推进通道，
          // 不得因派生映射文件损坏而整体抛错（那会让所有恢复路径死门）。
          warnings.push('agents.json 损坏已降级（' + String(error?.message ?? error) + '）：续派映射不可用，续派波按 fresh 重建路径恢复；可用 tw agent-map 重建登记')
        }
        // F4 续派身份回溯：journal 倒序找同角色同包范围内最近一个有映射的派发 key
        // （限定细则与排除面见 continuationPrevKey 注释；与 wait-inflight 兜底重建共用同一实现）。
        const excludedKeys = supersededKeys(task.journal)
        const prevKeyOf = (d) => continuationPrevKey({ journal: task.journal, agentMaps, excludedKeys }, d)
        const waves = list.map((d) => {
          const deliver = d.kind === 'produce' || d.kind === 'respond' ? 'deliver' : 'review'
          const hint = d.modelHint
          const pkgDef = (task.packages ?? []).find((p) => p.id === d.package)
          const example = deliver === 'deliver'
            ? twCommand() + ' deliver --task ' + name + ' --key ' + d.key + ' --outcome delivered --summary <一句话> --paths <可写路径>'
            : twCommand() + ' review --task ' + name + ' --key ' + d.key + ' --recommendation <accept|rework|escalate> --summary <一句话>' + (d.kind === 'verdict' ? ' --verdict <JSON: outcome|rationale|confidence|recommendedAction>' : '')
          return {
            dispatchKey: d.key, ...(d.waveId ? { waveId: d.waveId } : {}), kind: d.kind, role: d.role, tier: d.tier, round: d.round,
            ...(d.package != null ? { package: d.package } : {}),
            continuation: Boolean(d.continuation),
            ...(d.continuation && prevKeyOf(d) && agentMaps[prevKeyOf(d)] ? { expectedAgentId: agentMaps[prevKeyOf(d)] } : {}),
            ...(d.continuation && !(prevKeyOf(d) && agentMaps[prevKeyOf(d)]) ? { expectedAgentIdMissing: true, resumeNote: '未找到可续会话映射：用 tw-tool-subagent 新建子代理（target 取本派单 modelHint）后 tw agent-map --key <本key> --agent <新childId> 登记；若复用原派单 key，务必回填新 childId 覆盖旧映射（R3：fresh 复用同一 key 必须回填新 childId）' } : {}),
            ...(d.scope ? { scope: d.scope } : {}),
            ...(pkgDef ? { dependsOn: pkgDef.dependsOn ?? [] } : {}),
            prompt: d.prompt,
            ...(d.promptFull ? { promptFull: d.promptFull } : {}),
            deliver,
            modelHint: { provider: hint.provider, model: hint.model, source: hint.source, ...(hint.effort ? { effort: hint.effort } : {}), ...(hint.family ? { family: hint.family, ...(hint.selectedBy ? { selectedBy: hint.selectedBy } : {}) } : {}) },
            weight: policy.costWeights?.[d.tier] ?? null,
            dispatchExample: example,
          }
        })
        const plan = {
          ok: true, task: name, stage: card.stage, stop: null,
          waves,
          card: { status: card.status, next: card.next },
          modelSettings: { source: 'global-settings', file: resolved.file, path: 'team-work-dsh.tiers' },
          ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}),
        }
        if (!json) {
          plan.human = ['任务 ' + name + ' · 阶段 ' + card.stage + ' · ' + waves.length + ' 个派单']
          for (const w of waves) {
            plan.human.push('-- ' + w.role + '(' + w.tier + ') ' + w.kind + ' 第 ' + w.round + ' 轮' + (w.package ? ' · 包 ' + w.package : '') + (w.continuation ? ' · 续派' : '') + String.fromCharCode(10) + '模型：' + (w.modelHint.model ?? '(未解析)') + '（' + w.modelHint.source + '）' + String.fromCharCode(10) + '派单全文：' + String.fromCharCode(10) + w.prompt + (w.promptFull ? String.fromCharCode(10) + '断链重建/空壳补发用全量变体（原会话不可用时以此为准）：' + String.fromCharCode(10) + w.promptFull : '') + String.fromCharCode(10) + '交付示例：' + w.dispatchExample)
          }
          plan.human.push('派发后登记映射：tw agent-map --task ' + name + ' --key <派单key> --agent <childId>（DSH 内 tw-dispatch 会自动创建并登记，无需手工）')
        }
        return plan
      }

      if (card.transition === "advance") continue // stage-advanced 已写；锁内重推导下一阶段
      if (card.transition === "re-sign-escalation") continue // 升档旧卡已作废（decided:superseded）；锁内重推导重新出卡
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
    source: 'global-settings',
    file: resolved.file,
    tiers: TIERS.map((t) => ({ tier: t, ...resolved.tiers[t] })),
    ...(resolved.warnings.length ? { warnings: resolved.warnings } : {}),
    note: '只读全局 DSH settings：team-work-dsh.tiers 是唯一 tier→模型配置来源；本命令不会读取或创建项目 dsh.json。',
  }
}

// init（可选便捷命令）：只装载 skill 到 .dsh/skills/（DSH filesystem provider 扫描根）。
// 核心流程（安装 → open → run）不需要它。
async function cmdInit({ projectRoot, force = false }) {
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
  return {
    ok: true,
    skill,
    note: "init 只是便捷命令：装载 Lead 判断指引 skill；模型配置只由全局 DSH settings 管理。",
  }
}

// help（P4：CLI 即接口，--help 与拒绝输出即完整 meta）
function helpCard() {
  return {
    ok: true,
    commands: {
      plan: "tw plan --task <n> --packages <JSON数组>：登记拆分（机械验收：互斥/无环/完成标准；语义质量归 Lead）",
      "agent-map": "tw agent-map --task <n> --key <派单key> --agent <平台subagentId>：登记派单→成员续派映射（模型选择由 tw-tool-subagent 创建时直接指定）",
            open: "tw open --name <n> --objective <o> [--entry <stage>]：开任务（名字寻址；重名拒绝）",
      run: "tw run --task <n>：只读查状态（当前状态卡 + 下一步指引；不写任务事实。推进用 tw-dispatch / dispatch-plan）",
      "dispatch-plan": "tw dispatch-plan --task <n> [--json] [--writable <路径>:<kind> ...]：推进一步——推进到派发点或 stop 卡，输出波次计划（prompt + tier + modelHint）；路径以 / 结尾 = 目录授权；无 --json 输出人读 human 字段",
      decide: "tw decide --task <n> --choice <序号> [--note <...>]：回答当前卡片",
      intent: "tw intent --task <n> [--objective <...>] [--add-constraint <...>] [--add-exclusion <...>]：修订目标/约束",
      route: "tw route --task <n> --route spec|e2e --decision run|skip [--basis <依据>]：SPEC/E2E 显式路由",
      gate: "tw gate --task <n>：只读门禁检查（blockers + 修复建议）",
      models: "tw models：只读全局 DSH settings 中的 tier→模型解析结果",
      init: "tw init [--force]：可选——只装载 skill 到 .dsh/skills/",
      restore: "tw restore --task <n> --path <路径>：从最后注册快照恢复产出物",
      retire: "tw retire --task <n> --wave <wvN> --reason <原因>：作废未结波（仅 Lead；解除在途，已交付报告保留审计）",
      migrate: "tw migrate --task <n>：既有任务波身份迁移（追加 wave-assigned 事件；异 digest 冲突出选择卡）",
      archive: "tw archive --task <n>：归档（用户确认后；归档目录只读）",
      deliver: "成员交卷：tw deliver --task <n> --key <k> --outcome delivered --summary <一句话> --paths <路径...> [--checks <JSON>] [--unresolved <JSON>]",
      review: "成员阅卷：tw review --task <n> --key <k> --recommendation accept|rework|escalate --summary <一句话> [--findings <JSON>] [--verdict <JSON>]",
    },
    notes: [
      "卡片即接口：按返回卡片行动，不预判步骤；拒绝输出自带修复指引",
      "tier→模型唯一来源为 team-work-dsh.tiers；settings 路径优先级：显式 settingsFile（内部调用参数） > DSH_SETTINGS > $DSH_HOME/settings.yaml > ~/.dsh/settings.yaml；遗留项目 dsh.json 不读取也不创建",
    ],
  }
}

async function twInner(argv, { projectRoot = process.cwd(), stdout = process.stdout } = {}) {
  const [cmd, ...rest] = argv
  const args = {}
  for (let i = 0; i < rest.length; i += 2) args[rest[i].replace(/^--/, "")] = rest[i + 1]
  const flag = (key) => argv.filter((a) => a === `--${key}`).length ? [argv[argv.indexOf(`--${key}`) + 1]] : []
  const common = { projectRoot }
  try {
    switch (cmd) {
      case "open": return await cmdOpen({ ...common, name: args.name, objective: args.objective, entry: args.entry, risk: args.risk })
      case "run": {
        // run 只读化（§7.2）：--writable 是旧推进时代的参数，显式拒绝并指路 dispatch 通道（防旧习惯误用）
        const legacyWritable = collectWritable(argv)
        if (legacyWritable.length) {
          throw fail("USAGE", "run 已只读，不接受 --writable；扩权重派/推进请用 tw-dispatch（writables 参数）或 tw dispatch-plan --writable <路径>:<kind>")
        }
        return await cmdRun({ ...common, name: args.task, writable: [] })
      }
      case "decide": return await cmdDecide({ ...common, name: args.task, choice: Number(args.choice), note: args.note })
      case "intent": return await cmdIntent({ ...common, name: args.task, objective: args.objective, risk: args.risk, addConstraint: flag("add-constraint"), addExclusion: flag("add-exclusion") })
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
        throw fail("USAGE", "用法：tw help 查看全部命令（Lead：open/dispatch-plan/run 查状态/decide/intent/route/gate/models/init/restore/retire/migrate/archive；成员：deliver/review）")
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

// tw 出口（唯一公共入口：bin、DSH tw-tool、测试都经此）——汇报呈现注入的统一后处理：
// awaiting-user 用户决定点带完整呈现纪律（卡内另有 progress 素材），dispatch 带派发简报，
// advance/complete/blocked/wait-inflight 带轻量提醒。注入随每次卡片输出重新在场——
// Lead 的汇报纪律不依赖 skill 一次性装载，会话变长也不稀释（认知对等修复）。
// dispatch-plan 的嵌套 stop 卡（result.card）同样处理；拒绝卡无 status/transition 不命中。
// run 只读化后 waves 派发计划（stop=null 且 waves 非空）是派发事实的唯一出口——派发简报纪律
// 同样在此注入到 plan 顶层，纪律不随 run 撤推进而消失。
export async function tw(argv, opts = {}) {
  const card = await twInner(argv, opts)
  if (card && typeof card === "object" && !Array.isArray(card)) {
    if (card.card && typeof card.card === "object" && !Array.isArray(card.card)) {
      const wrapped = { ...card, card: attachPresentation(card.card) }
      if (wrapped.stop === null && Array.isArray(wrapped.waves) && wrapped.waves.length > 0 && !wrapped.presentation) {
        wrapped.presentation = PRESENTATION_DISPATCH
      }
      return wrapped
    }
    return attachPresentation(card)
  }
  return card
}

export { cmdOpen, cmdRun, cmdDecide, cmdIntent, cmdGate, cmdArchive }
