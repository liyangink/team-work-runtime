// cli.mjs — tw CLI：v3 工具契约的参考实现（§4）
// 卡片输出为 JSON（Lead 在 DSH 里用 bash 调用并解析）；拒绝输出带修复指引（P2）。
import { randomBytes } from "node:crypto"
import { accessSync, constants } from "node:fs"
import { readFile, rm, cp, mkdir, access } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { initTask, loadTask, taskExists, taskRoot, archiveRoot, controlRoot, atomicJson, atomicWrite, withOwnerLock, validName, readJson } from "./store.mjs"
import { deriveTask } from "./derive.mjs"
import { gateCheck, artifactsFingerprint } from "./gate.mjs"
import { scenePolicy } from "./waves.mjs"
import { registerDelivery, registerReview } from "./intake.mjs"
import { loadGuidance } from "./guidance.mjs"
import { TIERS, resolveTiers, computeModelHint } from "./dsh-map.mjs"

// 标签机器段构造（与 skill 标签规范固定表一致）：阶段缩写·角色缩写[@包]。
// design/spec 的 review 阶段复用 DESIGN/SPEC 缩写（规范同阶段同缩写；无独立缩写）。
const STAGE_ABBREV = { research: "RES", design: "DESIGN", "design-review": "DESIGN", spec: "SPEC", "spec-review": "SPEC", implementation: "IMPL", test: "TEST", "code-review": "CR", e2e: "E2E", finish: "FIN" }
export function tagLabel(stageId, role, pkg) {
  const ab = STAGE_ABBREV[stageId] ?? String(stageId)
  const r = role === "challenger" ? "chal" : role
  return ab + "·" + r + (pkg ? "@" + pkg : "")
}

// tagHints/pendingTags 落盘：dispatched 时写入【任务级】 agents.json（taskRoot/agents.json，P4 零转录）。
// 任务级键空间（迁移方案 docs/agents-json-task-scope-plan.md）：调用处已持 task.lock，这里不再自取锁。
// 写失败降级 warn 不阻塞派发。
export async function persistTagHints(taskRoot, entries) {
  const valid = (entries ?? []).filter((e) => e && e.tag && e.hint && e.hint.provider && e.hint.model)
  if (valid.length === 0) return
  const file = path.join(taskRoot, "agents.json")
  try {
    const current = (await readJson(file, { allowMissing: true })) ?? {} // 缺失容错；损坏(STATE_CORRUPT)重抛→外层 warn 降级
    const tagHints = { ...(current?.tagHints ?? {}) }
    const pendingTags = { ...(current?.pendingTags ?? {}) }
    for (const { tag, hint } of valid) {
      tagHints[tag] = { provider: hint.provider, model: hint.model, ...(hint.effort ? { effort: hint.effort } : {}) }
    }
    // pendingTags[标签] = 最新派发 key：插件回填 mappings[key]=childId 的寻址期望（同任务串行，覆盖=最新 key）
    for (const { tag, key } of valid) {
      if (key) pendingTags[tag] = key
    }
    current.tagHints = tagHints
    current.pendingTags = pendingTags
    await atomicJson(file, current)
  } catch (error) {
    console.warn("tagHints 落盘失败（不阻塞派发，插件将回退 childId 补读）：" + String(error?.message ?? error))
  }
}
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
    MAP_INVALID: "在 DSH 全局 settings.yaml 的 team-work-dsh.tiers 配置 junior/senior/expert；每档提供非空 provider 与 model（可为候选数组）",
    STATE_CORRUPT: "控制文件损坏：任务事实在 reports/journal，可重推导；遗留 dsh.json 不参与读取",
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
  const lines = (task.packages ?? []).map((p) => {
    const paths = items.filter((it) => (p.writable ?? []).some((w) => w.split(':')[0] === it.path)).map((it) => it.path)
    return '- 包 ' + p.id + '：' + (paths.join('、') || '（无登记产出物）')
  })
  return lines.length ? String.fromCharCode(10) + lines.join(String.fromCharCode(10)) : '（当前阶段登记产出物：' + items.map((it) => it.path).join('、') + '）'
}

function parseWritableEntry(entry) {
  const sep = entry.lastIndexOf(':')
  return { path: entry.slice(0, sep), artifactKind: entry.slice(sep + 1) }
}

// 在途派单重建（F4）：journal 尾部连续 dispatched 批次中尚无 report 的派发，重建完整派单文本
function inflightDispatches(task, stageId, guidance = null) {
  const stageDef = task.workflow.stages.find((st) => st.id === stageId)
  const settled = new Set(task.reports.map((r) => r.dispatchKey))
  const batch = []
  const lastIdx = task.journal.map((e) => e.type).lastIndexOf('dispatched')
  for (let i = lastIdx; i >= 0 && task.journal[i].type === 'dispatched'; i -= 1) batch.unshift(task.journal[i].detail)
  return batch
    .filter((d) => !settled.has(d.key))
    .map((d) => {
      const card = dispatchCard({ ...task, policy: task.policy }, stageDef, { kind: d.kind, role: d.role, round: d.round, ...(d.scope ? { scope: d.scope } : {}) }, { key: d.key, package: d.package ?? null, round: d.round, continuation: d.continuation, writable: d.writable ?? [] }, guidance).dispatch
      return { ...card, dispatchKey: card.key }  // D4：输出层补 dispatchKey（与 dispatch-plan waves[] 字段统一；key 字段保留兼容）
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

// 派单卡（v3.2 波组：detail = {key, package, round, continuation, writable}）
// guidance（可选）：角色/场景公共引导库（team-work/guidance），按 role+teamScene 检索注入；
// 缺失或未加载时跳过——引导是增强，不阻塞派发。
function dispatchCard(task, stageDef, wave, detail, guidance = null) {
  const sp = scenePolicy(task.policy, stageDef.teamScene)
  const pkg = detail.package ?? null
  const boundaries = detail.writable.map(({ path: p, artifactKind }) => p + (pkg ? '（包 ' + pkg + '，产出物 ' + artifactKind + '）' : '（产出物 ' + artifactKind + '）'))
  const deliverCmd = twCommand() + ' deliver --task ' + task.name + ' --key ' + detail.key + ' --outcome delivered --summary <一句话> --paths <可写路径>'
  const verdictArg = ' --verdict <JSON: outcome|rationale|confidence|recommendedAction>'
  const reviewCmd = twCommand() + ' review --task ' + task.name + ' --key ' + detail.key + ' --recommendation <accept|rework|escalate> --summary <一句话>' + (wave.kind === 'verdict' ? verdictArg : '')
  const intro = detail.continuation ? '# 续派（key: ' + detail.key + '）——你在原上下文基础上继续' : '# 派单（key: ' + detail.key + '）'
  const headLine = '任务：' + task.name + '；阶段：' + stageDef.id + '（' + stageDef.label + '）；角色：' + wave.role + '；轮次：' + (detail.round ?? wave.round) + (pkg ? '；包：' + pkg : '')
  const roleHint = guidance?.roles?.[wave.role]
  const sceneHint = guidance?.scenes?.[stageDef.teamScene]
  const parts = [
    intro,
    headLine,
    roleHint ? '## 角色指引（' + wave.role + '）\n' + roleHint : '',
    sceneHint ? '## 场景指引（' + stageDef.teamScene + '）\n' + sceneHint : '',
    detail.continuation ? '' : '目标：' + task.intent.objective,
    detail.continuation ? '' : (task.intent.constraints.length ? '约束：\n' + task.intent.constraints.map((c) => '- ' + c).join('\n') : ''),
    detail.continuation ? '' : (task.intent.exclusions.length ? '排除：\n' + task.intent.exclusions.map((c) => '- ' + c).join('\n') : ''),
    wave.role === 'owner' ? '可写路径（仅限）：\n' + (boundaries.map((b) => '- ' + b).join('\n') || '（无，纯回应派单）') : '只读派单：不得修改任何文件',,
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
    '上下文与派单已内嵌；不要读取 .team-work 内部状态，不要扫描项目外路径。',
  ]
  return {
    ok: true,
    task: task.name,
    stage: stageDef.id,
    status: 'working',
    next: 'dispatch',
    transition: 'dispatch',
    dispatch: {
      key: detail.key,
      role: wave.role,
      tier: wave.role === 'owner' ? ownerTierFor(task, sp, pkg) : wave.role === 'challenger' ? sp.challengerTier : 'expert',
      round: detail.round ?? wave.round,
      kind: wave.kind,
      ...(pkg != null ? { package: pkg } : {}),
      continuation: Boolean(detail.continuation),
      ...(wave.scope ? { scope: wave.scope } : {}),
      prompt: parts.filter(Boolean).join('\n\n'),
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

async function cmdRun({ projectRoot, name, writable = [] }) {
  const { workflow, policy } = await loadDefinitions(projectRoot)
  const guidance = await loadGuidance(projectRoot)
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
  // run 派单同样固化全局配置模型快照（修复回归：9b0b92c 后仅 dispatch-plan 固化，run 派单丢失
  // modelHint → agent-map 无快照可落 → 插件注入静默失效，Lead 主通道子代全部默认模型）。
  // 与 dispatch-plan 同源：resolveTiers 全局读取 + usedFamilies 波内家族去重闭包。
  const resolved = await resolveTiers()
  const usedFamilies = []
  const selectModelHint = (tier) => {
    const hint = computeModelHint(resolved.tiers[tier], usedFamilies)
    if (hint?.family) usedFamilies.push(hint.family)
    return hint
  }
  return withOwnerLock(path.join(early.root, "locks", "task.lock"), async () => {
    const task = await loadTask(projectRoot, name, { workflow, policy })
    await ensureE2ePackages(task) // B：e2e 场景无 packages 时按模板物化（幂等；在 derive 前生效）
    const state = deriveTask(task)
    return runTransition({ projectRoot, name, writable, workflow, policy, task, state, selectModelHint, guidance })
  })
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
    ...(dispatch.modelHint ? { modelHint: dispatch.modelHint } : {}),
  }
}

async function runTransition({ projectRoot, name, writable, workflow, policy, task, state, selectModelHint, guidance }) {

  if (state.next.kind === 'dispatch') {
    if (!state.next.wave) {
      // 门失败且非人工阻塞（如裁决/指纹失效且无法自动重派）：返回 blocker 卡（I5）
      const blockers = (state.gate?.blockers ?? state.next.hint ?? []).map((b2) => (typeof b2 === 'string' ? { message: b2, recovery: b2 } : b2))
      return { ok: true, task: name, stage: state.stage, status: 'blocked', next: 'none', blockers, transition: 'blocked' }
    }
    const wave = state.next.wave
    const stageDef = workflow.stages.find((st) => st.id === state.stage)
    const pkgItems = Array.isArray(task.packages) && task.packages.length ? task.packages : null
    if (wave.role === 'owner') {
      let decls
      if (pkgItems) {
        // 多包：可写范围来自包定义（--writable 不适用）；每包独立 key/轮次/continuation
        decls = wave.owners.map((o) => {
          const pkg = pkgItems.find((p) => p.id === o.package)
          return { key: 'w' + (task.journal.length + 1) + '-' + randomBytes(3).toString('hex'), package: o.package, round: o.round, continuation: o.continuation, writable: (pkg?.writable ?? []).map(parseWritableEntry) }
        })
      } else {
        if (!writable.length) {
          const outputs = (stageDef.outputs ?? []).map((k) => '  --writable <路径>:' + k).join('\n')
          throw fail('DISPATCH_INPUT_REQUIRED', 'Owner 波次需要声明可写路径与产物类型。阶段 ' + stageDef.id + ' 的产出物合同：\n' + (outputs || '  （无声明产出物，纯调查/回应类派单可直接 --writable none）'))
        }
        const o = wave.owners?.[0]
        // --writable none = 无产物派单（纯调查/回应，outputs 为空的阶段）；其余按 路径:kind 解析
        const decl = writable.length === 1 && writable[0] === 'none' ? [] : writable.map(parseWritableEntry)
        decls = [{ key: 'w' + (task.journal.length + 1) + '-' + randomBytes(3).toString('hex'), package: null, round: o?.round ?? wave.round, continuation: o?.continuation ?? false, writable: decl }]
      }
      // C（pre-phase3 §C）：升档审批——包 tier 高于场景默认的派发批次需用户批准一次（合批）。
      // 幂等身份 = stage + 波轮次 + 包集；已批准同批不再出卡；拒绝 = 本批按默认档派发（忽略包 tier）。
      if (wave.kind === 'produce' || wave.kind === 'respond') {
        const spC = scenePolicy(policy, stageDef.teamScene)
        const escPkgs = decls.filter((d) => isEscalatedTier(task, spC, d.package)).map((d) => ({ package: d.package, tier: (task.packages ?? []).find((p) => p.id === d.package)?.tier }))
        if (escPkgs.length) {
          const batchRound = Math.max(...decls.map((d) => d.round))
          const batchKey = JSON.stringify([state.stage, batchRound, [...escPkgs.map((e) => e.package)].sort()])
          const approved = task.decisions.find((dc) => dc.batchKey === batchKey && (dc.grant === 'approve-escalation' || dc.choice === '降回默认档继续'))
          if (!approved) {
            const decisionId = 'esc-' + randomBytes(3).toString('hex')
            const choices = [
              { n: 1, label: '批准升档', grant: 'approve-escalation', batchKey },
              { n: 2, label: '降回默认档继续', batchKey },
            ]
            await appendEventsUnlocked(task, [{ type: 'decision-issued', detail: { decisionId, gateId: null, reason: '升档审批：' + escPkgs.map((e) => e.package + '→' + e.tier).join('、'), choices } }])
            return { ok: true, task: name, stage: state.stage, status: 'awaiting-user', next: 'decide', transition: 'await-decision', decisionId, question: '以下包的 tier 高于场景默认档，是否批准按升档派发？（权重倍数 junior:senior:expert = 1:10:50）', escalations: escPkgs, choices }
          }
        }
        // 已批准（或降回默认档）：按实际档派发——降级路径由 decisions 中 choice='降回默认档继续' 体现：包 tier 忽略
        const declinedKey = JSON.stringify([state.stage, Math.max(...decls.map((d) => d.round)), [...decls.filter((d) => isEscalatedTier(task, spC, d.package)).map((d) => d.package)].sort()])
        const declined = task.decisions.some((dc) => dc.choice === '降回默认档继续' && dc.batchKey === declinedKey)
        if (declined) {
          const tiersBackup = task.packages
          task.packages = (tiersBackup ?? []).map((p) => ({ ...p, tier: undefined }))
          const cardsD = decls.map((d) => withModelHint(dispatchCard({ ...task, policy }, stageDef, wave, d, guidance).dispatch, selectModelHint))
          task.packages = tiersBackup
          await appendEventsUnlocked(task, cardsD.map((card, index) => ({ type: 'dispatched', detail: dispatchedDetail(card, wave, decls[index].writable) })))
          await persistTagHints(task.root, cardsD.map((c) => ({ tag: tagLabel(state.stage, c.role, c.package), key: c.key, hint: c.modelHint })))
          return { ok: true, task: name, stage: state.stage, status: 'working', next: 'dispatch', transition: 'dispatch', dispatch: cardsD[0], dispatches: cardsD, wave: { kind: wave.kind, role: wave.role, round: wave.round }, note: '用户选择降回默认档：本批按场景默认档派发' }
        }
      }
      const cards = decls.map((d) => withModelHint(dispatchCard({ ...task, policy }, stageDef, wave, d, guidance).dispatch, selectModelHint))
      await appendEventsUnlocked(task, cards.map((card, index) => ({ type: 'dispatched', detail: dispatchedDetail(card, wave, decls[index].writable) })))
      await persistTagHints(task.root, cards.map((c) => ({ tag: tagLabel(state.stage, c.role, c.package), key: c.key, hint: c.modelHint })))
      return { ok: true, task: name, stage: state.stage, status: 'working', next: 'dispatch', transition: 'dispatch', dispatch: cards[0], dispatches: cards, wave: { kind: wave.kind, role: wave.role, round: wave.round } }
    }
    const key = 'w' + (task.journal.length + 1) + '-' + randomBytes(3).toString('hex')
    const card = dispatchCard({ ...task, policy }, stageDef, wave, { key, round: wave.round, continuation: wave.continuation, writable: [] }, guidance)
    const dispatch = withModelHint(card.dispatch, selectModelHint)
    await appendEventsUnlocked(task, [{ type: 'dispatched', detail: dispatchedDetail(dispatch, wave, []) }])
    await persistTagHints(task.root, [{ tag: tagLabel(state.stage, dispatch.role, dispatch.package), key: dispatch.key, hint: dispatch.modelHint }])
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
    // F4：在途卡内嵌原派单全文（从 journal dispatched 事实重建），断链后可原样转发补派
    const inflight = inflightDispatches(task, state.stage, guidance)
    return {
      ok: true, task: name, stage: state.stage, status: 'working', next: 'wait', transition: 'wait-inflight',
      dispatchKey: state.next.dispatchKey,
      wave: { kind: state.wave.kind, role: state.wave.role, round: state.wave.round },
      inflight,
      note: '波次 ' + state.wave.kind + '（' + state.wave.role + ' 轮次 ' + state.wave.round + '）已派发；在途派单（inflight 数组可原样转发补派）：' + inflight.map((d) => d.key).join('、'),
    }
  }

  if (state.next.kind === "await-decision") {
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
        note: "先做路由判定（tw route），完成后人工门卡才会出现",
      }
    }
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
      ...(picked.batchKey ? { batchKey: picked.batchKey } : {}),
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
      if (paths[i].path === paths[j].path) reasons.push('可写范围重叠：' + paths[i].pkg + ' 与 ' + paths[j].pkg + ' 都写 ' + paths[i].path)
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
    const task = await loadTask(projectRoot, name, { workflow, policy })
    // 重拆窗口（F6）：待决卡片或在途派发时禁止重拆（与 intent 修订同款语义）
    const state = deriveTask(task)
    if (state.status === 'awaiting-user') throw fail('PLAN_REJECTED', '当前有待决用户卡片（' + (state.next.reason ?? '人工门') + '），禁止重拆；decide 后再试')
    const batch = []
    const lastIdx = task.journal.map((e) => e.type).lastIndexOf('dispatched')
    for (let i = lastIdx; i >= 0 && task.journal[i].type === 'dispatched'; i -= 1) batch.unshift(task.journal[i].detail)
    const settledKeys = new Set(task.reports.map((r) => r.dispatchKey))
    const inflight = batch.filter((d) => !settledKeys.has(d.key))
    if (inflight.length) throw fail('PLAN_REJECTED', '存在在途派发（' + inflight.map((d) => d.key).join('、') + '），禁止重拆；等成员交付或补派完成后再试')
    const had = task.packages != null
    await atomicJson(path.join(task.root, 'packages.json'), { items })
    await appendEventsUnlocked(task, [{ type: had ? 're-planned' : 'packages-planned', detail: { packages: items.map((p) => p.id) } }])
    return { ok: true, task: name, packages: items.map((p) => ({ id: p.id, dependsOn: p.dependsOn ?? [] })), replanned: had, next: 'run', ...(tagWarn ? { warnings: [tagWarn] } : {}), note: had ? '包定义已更新（下一波生效）' : '包定义已登记；下一次 run 将按波组派发' }
  })
}


// agent-map（v3.2/F5）：登记 dispatchKey → 平台 subagent id（Lead 实际开 subagent 后调用）。
// 存 .team-work/platform/agents.json（平台绑定事实，Lead 维护；runtime 只读写不调平台）。
// 续派波经 dispatch-plan 导出 expectedAgentId（同包同角色上一派发的映射）——Lead 据此 send_message 续原会话。
async function cmdAgentMap({ projectRoot, name, key, agent, modelHint }) {
  if (!key || !agent) throw fail('USAGE', 'agent-map 需要 --key <派单key> 与 --agent <平台subagentId>')
  const { workflow, policy } = await loadDefinitions(projectRoot)
  if (modelHint !== undefined) throw fail('USAGE', 'agent-map 不接受 --model-hint；模型选择只能使用 dispatch-plan 已登记的全局配置快照')
  const task0 = await loadTask(projectRoot, name, { workflow, policy })
  return withOwnerLock(path.join(task0.root, 'locks', 'task.lock'), async () => {
    const task = await loadTask(projectRoot, name, { workflow, policy })
    const dispatch = task.journal.find((e) => e.type === 'dispatched' && e.detail.key === key)
    if (!dispatch) {
      throw fail('USAGE', 'key ' + key + ' 不是本任务的派单 key（从派单卡或 dispatch-plan 输出复制）')
    }
    // dispatch-plan 在写 dispatched 事实时已持久化精确选中的 hint。这里绝不重新读配置或重选家族，
    // 因此全局 settings 热更新、同波第二 Owner 的 diversity 选择都不会让 child 注入漂移。
    const hint = dispatch.detail.modelHint?.provider && dispatch.detail.modelHint?.model ? dispatch.detail.modelHint : null
    // 任务级注册表（迁移方案）：file=task.root/agents.json；task.lock 已持有（写 journal 同锁域）
    const file = path.join(task.root, 'agents.json')
    const current = (await readJson(file, { allowMissing: true })) ?? {}
    current.mappings = { ...(current.mappings ?? {}) }
    current.modelHints = { ...(current.modelHints ?? {}) }
    current.mappings[key] = agent
    if (hint) current.modelHints[agent] = hint
    await atomicJson(file, current)
    return { ok: true, task: name, key, agent, ...(hint ? { modelHint: hint } : {}), note: hint ? '已登记派单映射并落盘 dispatch-plan 的模型快照（modelHints[childId]，插件注入消费）' : '已登记；该派单没有 dispatch-plan 模型快照（例如由 tw run 直接派发），成员将继承平台默认模型' }
  })
}

// dispatch-plan（§1.1）：编排脚本的唯一输入。锁内追非派发转移（advance/complete/人工门卡片）
// 直到派发点或 stop；派发点注册 dispatched 事件并导出机器可读波次（prompt + tier→模型解析）。
async function cmdDispatchPlan({ projectRoot, name, writable = [], json = false }) {
  const { workflow, policy } = await loadDefinitions(projectRoot)
  const guidance = await loadGuidance(projectRoot)
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
    const planStop = (stop, card, extra = {}) => ({ ok: true, task: name, stage: card.stage ?? null, stop, waves: [], card, ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}), ...extra })
    for (let hop = 0; hop <= workflow.stages.length + 2; hop += 1) {
      const task = await loadTask(projectRoot, name, { workflow, policy })
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
      const card = await runTransition({ projectRoot, name, writable, workflow, policy, task, state, selectModelHint, guidance })
      if (card.transition === 'dispatch') {
        const list = card.dispatches ?? (card.dispatch ? [card.dispatch] : [])
        const agentMaps = (await readJson(path.join(task.root, 'agents.json'), { allowMissing: true }) ?? {}).mappings ?? {}
        // 同包同角色上一派发 key（expectedAgentId 推导源）
        // D3（评审 B-F3 限定放宽）：无包波（challenger/expert 的 review/verdict，package=null）按"同角色"匹配上一派发；
        // 包波必须同包同角色——全局放宽会让包2 respond 误继承包1 的 agent、续错会话。
        const prevKeyOf = (d) => {
          const prior = task.journal.filter((e) => e.type === 'dispatched' && e.detail.key !== d.key && e.detail.role === d.role
            && ((d.package ?? null) === null ? true : (e.detail.package ?? null) === d.package)).at(-1)
          return prior?.detail.key ?? null
        }
        const waves = list.map((d) => {
          const deliver = d.kind === 'produce' || d.kind === 'respond' ? 'deliver' : 'review'
          const hint = d.modelHint
          const pkgDef = (task.packages ?? []).find((p) => p.id === d.package)
          const example = deliver === 'deliver'
            ? twCommand() + ' deliver --task ' + name + ' --key ' + d.key + ' --outcome delivered --summary <一句话> --paths <可写路径>'
            : twCommand() + ' review --task ' + name + ' --key ' + d.key + ' --recommendation <accept|rework|escalate> --summary <一句话>' + (d.kind === 'verdict' ? ' --verdict <JSON: outcome|rationale|confidence|recommendedAction>' : '')
          return {
            dispatchKey: d.key, kind: d.kind, role: d.role, tier: d.tier, round: d.round,
            ...(d.package != null ? { package: d.package } : {}),
            continuation: Boolean(d.continuation),
            ...(d.continuation && prevKeyOf(d) && agentMaps[prevKeyOf(d)] ? { expectedAgentId: agentMaps[prevKeyOf(d)] } : {}),
            ...(d.continuation && !(prevKeyOf(d) && agentMaps[prevKeyOf(d)]) ? { expectedAgentIdMissing: true, resumeNote: '未找到可续会话（自动回填缺失或无标签）：请新开同标签 fresh subagent（插件自愈覆盖），或 tw agent-map 兜底登记' } : {}),
            ...(d.scope ? { scope: d.scope } : {}),
            ...(pkgDef ? { dependsOn: pkgDef.dependsOn ?? [] } : {}),
            prompt: d.prompt,
            deliver,
            modelHint: { provider: hint.provider, model: hint.model, source: hint.source, ...(hint.effort ? { effort: hint.effort, effortNote: "Lead 派发原语暂无下发通道；Phase 3 插件经 registerContinuableSetup 注入 continuable 成员" } : {}), ...(hint.family ? { family: hint.family, ...(hint.selectedBy ? { selectedBy: hint.selectedBy } : {}) } : {}) },
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
            plan.human.push('-- ' + w.role + '(' + w.tier + ') ' + w.kind + ' 第 ' + w.round + ' 轮' + (w.package ? ' · 包 ' + w.package : '') + (w.continuation ? ' · 续派' : '') + String.fromCharCode(10) + '模型：' + (w.modelHint.model ?? '(未解析)') + '（' + w.modelHint.source + '）' + String.fromCharCode(10) + '派单全文：' + String.fromCharCode(10) + w.prompt + String.fromCharCode(10) + '交付示例：' + w.dispatchExample)
          }
        }
        return plan
      }

      if (card.transition === "advance") continue // stage-advanced 已写；锁内重推导下一阶段
      if (card.transition === "complete") return planStop("completed", card)
      if (card.transition === "wait-inflight") return planStop("wait-inflight", card, { dispatchKey: card.dispatchKey, inflight: card.inflight ?? [] })
      if (card.transition === "await-decision") return planStop("awaiting-user", card)
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
      "agent-map": "tw agent-map --task <n> --key <派单key> --agent <平台subagentId>：登记派单→成员映射，并复用 dispatch-plan 的模型快照",
            open: "tw open --name <n> --objective <o> [--entry <stage>]：开任务（名字寻址；重名拒绝）",
      run: "tw run --task <n> [--writable <路径>:<kind> ...]：推进一步（返回卡片或派单）",
      "dispatch-plan": "tw dispatch-plan --task <n> [--json] [--writable ...]：编排输入——推进到派发点或 stop，输出波次计划（prompt + tier + modelHint）",
      decide: "tw decide --task <n> --choice <序号> [--note <...>]：回答当前卡片",
      intent: "tw intent --task <n> [--objective <...>] [--add-constraint <...>] [--add-exclusion <...>]：修订目标/约束",
      route: "tw route --task <n> --route spec|e2e --decision run|skip [--basis <依据>]：SPEC/E2E 显式路由",
      gate: "tw gate --task <n>：只读门禁检查（blockers + 修复建议）",
      models: "tw models：只读全局 DSH settings 中的 tier→模型解析结果",
      init: "tw init [--force]：可选——只装载 skill 到 .dsh/skills/",
      restore: "tw restore --task <n> --path <路径>：从最后注册快照恢复产出物",
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

export async function tw(argv, { projectRoot = process.cwd(), stdout = process.stdout } = {}) {
  const [cmd, ...rest] = argv
  const args = {}
  for (let i = 0; i < rest.length; i += 2) args[rest[i].replace(/^--/, "")] = rest[i + 1]
  const flag = (key) => argv.filter((a) => a === `--${key}`).length ? [argv[argv.indexOf(`--${key}`) + 1]] : []
  const common = { projectRoot }
  try {
    switch (cmd) {
      case "open": return await cmdOpen({ ...common, name: args.name, objective: args.objective, entry: args.entry, risk: args.risk })
      case "run": return await cmdRun({ ...common, name: args.task, writable: collectWritable(argv) })
      case "decide": return await cmdDecide({ ...common, name: args.task, choice: Number(args.choice), note: args.note })
      case "intent": return await cmdIntent({ ...common, name: args.task, objective: args.objective, risk: args.risk, addConstraint: flag("add-constraint"), addExclusion: flag("add-exclusion") })
      case "route": return await cmdRoute({ ...common, name: args.task, route: args.route, decision: args.decision, basis: args.basis })
      case "restore": return await cmdRestore({ ...common, name: args.task, target: args.path })
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
