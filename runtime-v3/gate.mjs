// gate.mjs — 门禁检查（纯函数，目录数据 → 判定）
// 门 = 一次总检查（P2/P3）：当前阶段产出物在场 + 检查通过 + 非作者评审在场 + （核心场景）Expert 裁决 + 人工门凭证。
// 每条 blocker 带 requirement/evidence/recovery（I5：拒绝必有出路）。
// AGENTS 规则 5：只检查当前阶段声明的最低必需输入；历史阶段制品缺失不阻塞（制品两分法：输入上下文不登记）。
// v3.4（F5/F6）：人工门决定绑定双指纹——artifactFingerprint（每包「包→指纹」映射）+ reviewFingerprint（评审链复合 digest）；
// 已决分支按 gateId 取最新 accept（防恒比对旧决定成环）；未决分支比对签发指纹、变化即卡片失效（await-decision 侧重签）；
// 旧决定缺 reviewFingerprint 降级仅制品指纹（R2）；旧单 fingerprint 决定降级全局比对（§7 回滚双写兼容）。

import { digestValue } from "./domain/digests.mjs"
import { writableMatch } from "./domain/writable.mjs"

export function artifactsFingerprint(items) {
  return digestValue(items.map(({ path, digest }) => ({ path, digest })).sort((a, b) => a.path.localeCompare(b.path)))
}

// F5 每包制品指纹（统一公式：gate 判定 / cmdDecide 落盘 / derive 僵局检测三处共用）：
// 按每包子集计算（当前阶段登记制品集，可空即空集 digest，不兜底全量）；
// 单 owner（无 packages）= 匿名包 [null] 拥有全部当前阶段制品；多包按 packages[].writable 路径过滤。
// 返回 {<pkg>|"null": fingerprint}（对象键恒为字符串，JSON 往返稳定）。
export function artifactFingerprints(stageItems, packages = null) {
  if (!Array.isArray(packages) || packages.length === 0) {
    return { null: artifactsFingerprint(stageItems) }
  }
  const out = {}
  for (const p of packages) {
    // 条目解析与 parseWritableEntry 同口径（lastIndexOf 冒号，路径可含冒号）；归属判定统一走
    // writableMatch（目录条目覆盖其下路径）——精确匹配会把目录条目下制品排除出包指纹，
    // 人工门双指纹（F5/F6）与僵局检测（消费规则 3）随之漏检。
    const entries = (p?.writable ?? []).map((w) => {
      const text = String(w)
      const sep = text.lastIndexOf(":")
      return { path: sep > 0 ? text.slice(0, sep) : text }
    })
    out[p.id] = artifactsFingerprint(stageItems.filter((item) => writableMatch(entries, item.path)))
  }
  return out
}

// F6 评审链指纹：最新 Challenger 报告（reportId+ver+payload digest）与核心场景最新 Expert 报告的复合 digest。
// 「最新」以 journal seq（report-accepted 事件序）为第一全序、at 次级破平（store 比较器同毫秒不可靠）；
// 指纹选取加当前阶段过滤（reports 由调用方按阶段过滤）。
export function reviewChainFingerprint({ reports = [], journal = [], core = false }) {
  const seqOf = new Map()
  for (const e of journal) {
    if (e.type === "report-accepted" && e.detail?.reportId) seqOf.set(e.detail.reportId, e.seq)
  }
  const later = (a, b) => {
    const sa = seqOf.get(a.reportId) ?? -1
    const sb = seqOf.get(b.reportId) ?? -1
    if (sa !== sb) return sa > sb
    if ((a.at ?? "") !== (b.at ?? "")) return (a.at ?? "") > (b.at ?? "")
    return (a.ver ?? 1) > (b.ver ?? 1)
  }
  const pick = (role) => {
    let best = null
    for (const r of reports) {
      if (r.kind !== "review" || r.role !== role) continue
      if (!best || later(r, best)) best = r
    }
    return best
  }
  const part = (r) => (r ? { reportId: r.reportId, ver: r.ver ?? 1, payloadDigest: r.payloadDigest ?? digestValue(r.payload ?? {}) } : null)
  return digestValue({ challenger: part(pick("challenger")), expert: core ? part(pick("expert")) : null })
}

// 人工门决定/签发快照新鲜度（F5/F6 统一比对；gate 判定与 cmdDecide 校验共用同一判定，判定链不双轨）：
// - artifactFingerprint（每包映射）：包集与逐包指纹一致
// - 旧单 fingerprint 字符串决定：降级全局制品指纹比对（artifactFp.null，旧语义）
// - reviewFingerprint：与当前评审链指纹一致；缺失 → 降级仅制品指纹（R2）
export function humanDecisionFresh({ decided, artifactFp, reviewFp }) {
  if (decided?.artifactFingerprint && typeof decided.artifactFingerprint === "object" && !Array.isArray(decided.artifactFingerprint)) {
    const keys = Object.keys(decided.artifactFingerprint).sort().join("\u0000")
    const currentKeys = Object.keys(artifactFp ?? {}).sort().join("\u0000")
    if (keys !== currentKeys) return false
    for (const [pkg, fp] of Object.entries(decided.artifactFingerprint)) {
      if (artifactFp?.[pkg] !== fp) return false
    }
  } else if (typeof decided?.fingerprint === "string") {
    if (artifactFp?.null !== decided.fingerprint) return false
  }
  if (decided?.reviewFingerprint !== undefined) {
    if (decided.reviewFingerprint !== reviewFp) return false
  }
  return true
}

// gate 只认当前阶段登记过的产出物（deliver 时写入 artifacts.items）；
// 历史阶段制品缺失不检查（AGENTS 规则 5 / 制品两分法）。
function stageArtifacts(artifacts, stageId) {
  return artifacts.items.filter((item) => item.stage === stageId)
}

export function gateCheck({ workflow, policy, stageId, scope, artifacts, reports, decisions, journal, packages = null }) {
  const stageDef = workflow.stages.find((s) => s.id === stageId)
  if (!stageDef) {
    return { passed: false, blockers: [{ requirement: `workflow 没有阶段 ${stageId}`, evidence: [], recovery: "检查 scope.json 的 entry 与 workflow 定义" }] }
  }
  const blockers = []
  const current = stageArtifacts(artifacts, stageId)

  // 1. 产出物在场：阶段合同 outputs 的每个 kind 至少一个登记产出物
  for (const kind of stageDef.outputs ?? []) {
    if (!current.some((item) => item.kind === kind)) {
      blockers.push({
        requirement: `阶段产出物 ${kind} 尚未登记`,
        evidence: current.map(({ path }) => path),
        recovery: "派发 Owner 波次产出该制品并用 deliver 登记路径",
      })
    }
  }

  // 2. 检查通过：Owner 报告里的 checks 不得有 fail（声称不算数，平台观察对账在 DSH 绑定层）
  const ownerReports = reports.filter((r) => r.role === "owner" && r.kind === "deliver")
  const failed = ownerReports.flatMap((r) => (r.payload?.checks ?? []).filter((c) => c.result === "fail").map((c) => ({ report: r.reportId, check: c })))
  for (const f of failed) {
    blockers.push({
      requirement: `检查未通过：${f.check.name}`,
      evidence: [f.report],
      recovery: "Owner 修复后重新 deliver（同路径原地修订）",
    })
  }

  // 3. 非作者评审在场：最新 challenger review 为 accept（能走到门=波次机已判收敛，多包下
  // 轮次按包计，不再用 ownerReports 数当全局轮；rework/escalate 不会走到门，此处防御）
  const challenger = reports.filter((r) => r.role === "challenger").at(-1)
  if (!challenger || challenger.payload?.recommendation !== "accept") {
    blockers.push({
      requirement: "非作者评审未接受当前交付",
      evidence: challenger ? [challenger.reportId] : [],
      recovery: "派发 Challenger 评审波次；未收敛时按波次推进处理",
    })
  }

  // 4. 核心场景 Expert 裁决在场
  const sp = { core: policy.scenes[stageDef.teamScene]?.core }
  if (sp.core) {
    const expert = reports.filter((r) => r.role === "expert").at(-1)
    if (!expert || expert.payload?.verdict?.outcome !== "accept") {
      blockers.push({
        requirement: "核心场景缺少非作者 Expert 接受裁决",
        evidence: expert ? [expert.reportId] : [],
        recovery: "派发 Expert 裁决波次（verdict）",
      })
    }
  }

  // 5. 路由门（I9/AGENTS 15）：阶段带 route 时显式判定；skip 需可定位证据
  if (stageDef.route === "e2e") {
    const e2eDecision = decisions.find((d) => d.route === "e2e")
    if (!e2eDecision) {
      blockers.push({
        requirement: "E2E 路由未判定（适用性需证据，不猜测）",
        evidence: [],
        recovery: "Lead 按用户目标与影响面判定：运行 E2E（--route run）或给出跳过依据（--route skip --basis <依据>）",
        awaitingUser: true,
        route: "e2e",
      })
    }
  }
  if (stageDef.route === "spec") {
    const specDecision = decisions.find((d) => d.route === "spec")
    if (!specDecision) {
      blockers.push({
        requirement: "SPEC 路由未判定",
        evidence: [],
        recovery: "按项目配置判定 use/skip；disabled 配置下可直接 skip",
        awaitingUser: true,
        route: "spec",
      })
    }
  }

  // 6. 人工门（AGENTS 17）：workflow 声明的门 + through-stage 的 scoped final-acceptance
  const humanRequired = (workflow.gates ?? []).find((g) => g.stage === stageId && g.requirement === "required")
    ?? ((scope.completion?.mode === "through-stage" && scope.completion.stage === stageId && !(workflow.gates ?? []).some((g) => g.stage === stageId))
      ? { gateId: `scoped-final-${stageId}`, stage: stageId, requirement: "required" }
      : null)
  if (humanRequired) {
    const issued = journal.filter((e) => e.type === "decision-issued" && e.detail?.gateId === humanRequired.gateId).at(-1)
    // F6-1 已决分支：按 gateId 倒序取最新 accept（decisions 追加序即时间序），杜绝恒比对旧决定成环
    const decided = decisions.filter((d) => d.gateId === humanRequired.gateId && d.choice === "accept").at(-1)
    // F5 每包制品指纹（统一公式，不兜底全量）+ F6 评审链指纹
    const artifactFp = artifactFingerprints(current, packages)
    const reviewFp = reviewChainFingerprint({ reports, journal, core: Boolean(sp.core) })
    if (!decided) {
      // F6-2 未决分支：签发指纹 vs 当前指纹，变化 → 卡片失效（runTransition 作废旧卡重签新卡）
      const issuedFp = issued?.detail?.fingerprints
      const stale = issuedFp ? !humanDecisionFresh({ decided: issuedFp, artifactFp, reviewFp }) : false
      blockers.push({
        requirement: `人工门 ${humanRequired.gateId} 等待用户决定`,
        evidence: issued ? [issued.detail.decisionId] : [],
        recovery: "向用户呈现卡片并等待 decide；任务保持静止",
        awaitingUser: true,
        ...(stale ? { staleFingerprint: true, note: "等待期评审链或制品已变化，旧卡已失效，将重新签发" } : {}),
      })
    } else if (!humanDecisionFresh({ decided, artifactFp, reviewFp })) {
      blockers.push({
        requirement: `人工门 ${humanRequired.gateId} 的批准指纹已过期（制品或评审链在批准后发生变化）`,
        evidence: [decided.decisionId],
        recovery: "重新呈现卡片请求用户确认",
        awaitingUser: true,
      })
    }
  }

  return { passed: blockers.length === 0, blockers, humanGate: humanRequired?.gateId ?? null }
}
