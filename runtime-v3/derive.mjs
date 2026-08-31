// derive.mjs — 任务目录数据 → 当前状态（纯函数，P1：目录即状态）
// 输入是已解析的目录文件（加载见 store.mjs/CLI）；本模块不做 I/O。
// 推导链：scope + journal 尾部 → 当前阶段；reports → 波次；gate → 门；decisions → 人工门。
// v3.4 重排（F3/F5）：先算波（含人工门 rework 的 respond 覆盖波，结构因果绑定）→ converge-user →
// gate 判定（不再内含派发）→ 所有派发路径统一经过 waveId 批次守卫（在途语义见 waves.mjs inflightBatch）。

import { nextWave, scenePolicy, projectRounds, inflightBatch, supersededKeys, waveIdOf } from "./waves.mjs"
import { gateCheck, artifactFingerprints } from "./gate.mjs"

const state2Packages = (packages) => (Array.isArray(packages) ? packages : null)

// 当前阶段推导（唯一实现：intake 等消费点共用，消除原两处重复）
export function currentStageOf(journal, scope) {
  return journal.filter((e) => e.type === "stage-advanced").map((e) => e.detail.to).at(-1) ?? scope.entry
}

// F5 人工门 rework 结构因果（台账 P1-2 落地）：判定链 = decisionId → dispatched(causeDecisionId) → report。
// 只认绑定该 rework 决定的 respond 派发及其报告；决定前旧 key 重交结构性无效（不靠时间/指纹近似）。
// 绑定波按 waveId 聚合（多包覆盖波 = 同 waveId 多条派发），跳过 superseded 波——整波 retire 后视为无绑定、
// 回全包覆盖波（不用残留单条派发重派丢包）。
// 核验（评审 unresolved 5）：人工门 rework 决定必带 gateId（decide 只在人工门卡签发 rework 选项）；
// 无 gateId 的 rework 决定（历史/损坏数据）不构成人工门返工绑定、被忽略——不触发覆盖波，回退正常 gate 判定。
function reworkBinding({ journal, decisions }) {
  const decision = decisions.filter((d) => d.choice === "rework" && d.gateId).at(-1)
  if (!decision) return null
  const excluded = supersededKeys(journal)
  const matches = journal.filter((e) => e.type === "dispatched" && e.detail?.causeDecisionId === decision.decisionId && !excluded.has(e.detail?.key))
  if (matches.length === 0) return { decision, bound: null, boundEntries: [] }
  const last = matches.at(-1)
  const lastWave = last.detail.waveId ?? waveIdOf(journal, last.detail.key)
  const boundEntries = matches.filter((e) => (e.detail.waveId ?? waveIdOf(journal, e.detail.key)) === lastWave)
  return { decision, bound: last, boundEntries }
}

// F5 消费规则 3：每包指纹的用途 = 僵局检测（不参与完成判定）——
// report=delivered 且该包 writable 非空、该包指纹较决定时未变 → 该包实际未修（僵局）。
// 指纹公式与 gate 判定/cmdDecide 落盘同一纯函数（R2）。
function stalematePackages({ decision, bound, artifacts, stageId, packages }) {
  if (!decision.artifactFingerprint || !bound) return []
  const items = (artifacts?.items ?? []).filter((i) => i.stage === stageId)
  const current = artifactFingerprints(items, state2Packages(packages))
  const writableOf = (id) => {
    if (Array.isArray(packages) && packages.length) {
      return (packages.find((p) => p.id === id)?.writable ?? []).map(String)
    }
    // 单 owner：绑定波的可写集（writable 为空 = 纯回应派单 → 报告 delivered 即完成，不判僵局）
    return (bound.detail?.writable ?? []).map((w) => w?.path ?? String(w)).filter(Boolean)
  }
  const pkgIds = Array.isArray(packages) && packages.length ? packages.map((p) => p.id) : [null]
  const out = []
  for (const id of pkgIds) {
    const key = String(id)
    if (current[key] === undefined || current[key] !== decision.artifactFingerprint[key]) continue
    if (writableOf(id).length > 0) out.push(id)
  }
  return out
}

export function deriveTask({ scope, intent, artifacts, reports, decisions, journal, workflow, policy, packages = null }) {
  const completedEvent = journal.find((e) => e.type === "task-completed")
  if (completedEvent) {
    return { stage: completedEvent.detail.stage, status: "completed", wave: { kind: "done" }, gate: null, next: { kind: "none" } }
  }

  const stageId = currentStageOf(journal, scope)
  const stageDef = workflow.stages.find((s) => s.id === stageId)
  if (!stageDef) {
    return { stage: stageId, status: "blocked", wave: null, gate: null, next: { kind: "blocked", reason: `scope.entry ${stageId} 不在 workflow 定义中` } }
  }
  const sp = scenePolicy(policy, stageDef.teamScene)
  const stageReports = reports.filter((r) => r.stage === stageId)
  // F9 迁移冲突卡待决期间任务静止：未决冲突内容不得继续参与推导/派发（run 不推进、不代答）
  const settledDecisions = new Set(journal.filter((e) => e.type === "decided").map((e) => e.detail.decisionId))
  const pendingMigrate = journal.find((e) => e.type === "decision-issued" && e.detail?.migrate && !settledDecisions.has(e.detail.decisionId))
  if (pendingMigrate) {
    return { stage: stageId, status: "awaiting-user", wave: { kind: "converge-user", reason: pendingMigrate.detail.reason }, gate: null, next: { kind: "await-decision", reason: pendingMigrate.detail.reason, migratePending: true } }
  }
  const extraRounds = decisions.filter((d) => d.grant === "extra-round").length
  let wave = nextWave({ scenePolicy: sp, reports: stageReports, extraRounds, packages: state2Packages(packages), journal })

  // converge-user（波次机仲裁，静止）
  if (wave.kind === "converge-user") {
    return { stage: stageId, status: "awaiting-user", wave, gate: null, next: { kind: "await-decision", reason: wave.reason } }
  }

  // gate 分支（F5：人工门 rework 结构因果覆盖波；判定链不含派发，派发统一过守卫）
  if (wave.kind === "gate") {
    const binding = reworkBinding({ journal, decisions })
    const pkgIds = Array.isArray(packages) && packages.length ? packages.map((p) => p.id) : [null]
    // 覆盖波构造：轮次 = 投影轮 + 1（F2 唯一算法，derive 不再独立计数）
    const respondWave = (ownerIds, causeDecisionId) => {
      const rounds = projectRounds({ journal, reports: stageReports })
      const owners = ownerIds.map((id) => ({ package: id, round: (rounds.get(id) ?? 0) + 1, continuation: true }))
      return { kind: "respond", role: "owner", round: Math.max(...owners.map((o) => o.round)), owners, causeDecisionId }
    }
    if (binding) {
      const boundReports = binding.boundEntries.map((e) => stageReports.filter((r) => r.dispatchKey === e.detail.key).at(-1) ?? null)
      if (binding.boundEntries.length === 0) {
        // 消费规则 1 前置：人工门 rework 后总是派 respond 覆盖波（无任何自动判定前置）；
        // 绑定波整波 retire（superseded）后同样回全包覆盖波（不按残留单条派发重派丢包）
        wave = respondWave(pkgIds, binding.decision.decisionId)
      } else if (!boundReports.every((r) => r != null)) {
        // 绑定波部分在途：复用该波身份落入统一守卫（wait-inflight），不重复派发
        const owner = { package: binding.bound.detail.package ?? null, round: binding.bound.detail.round ?? 1, continuation: true }
        wave = { kind: "respond", role: "owner", round: binding.bound.detail.round ?? 1, owners: [owner], causeDecisionId: binding.decision.decisionId }
      } else if (boundReports.some((r) => r.payload?.outcome === "blocked")) {
        // 消费规则 2：blocked → converge-user 人工仲裁，不无限重派 respond。
        // 选项边界（F5 钉死，实证修正）：blocked 卡专用两选项「重派 respond（新绑定波）/ 结束任务」——
        // 不得沿用普通 converge-user 的「追加一轮」（extra-round 无派发路径，绑定波报告仍 blocked → 空转循环）。
        const stance = decisions.filter((d) => d.gateId === binding.decision.gateId && d.grant === "rework-rerun").at(-1)
        const reason = "Owner 无法完成本次返工（blocked 交付），待用户仲裁"
        if (stance && (binding.bound.at ?? "") < (stance.at ?? "")) {
          // 用户选择重派（决定晚于绑定波派发 = 未消费）：新 respond 波绑定同一 rework 决定、含绑定波整波包集
          wave = respondWave([...new Set(binding.boundEntries.map((e) => e.detail.package ?? null))], binding.decision.decisionId)
        } else {
          return { stage: stageId, status: "awaiting-user", wave: { kind: "converge-user", reason }, gate: null, next: { kind: "await-decision", reason, reworkBlocked: true, gateId: binding.decision.gateId } }
        }
      } else {
        // 消费规则 3/4：僵局检测与多包混合（部分已改/部分未修 → 仲裁卡列未修包清单）
        const stale = stalematePackages({ decision: binding.decision, bound: binding.bound, artifacts, stageId, packages })
        const stance = decisions.filter((d) => d.gateId === binding.decision.gateId && ["accept-as-is", "rework-unfixed"].includes(d.grant)).at(-1)
        if (stale.length && stance?.grant === "accept-as-is" && (binding.decision.at ?? "") < (stance.at ?? "")) {
          // 用户接受现状（决定须晚于当前 rework 决定，防旧 accept-as-is 吞掉第二次 rework 的僵局卡）
        } else if (stale.length && stance?.grant === "rework-unfixed" && (binding.decision.at ?? "") < (stance.at ?? "") && (binding.bound.at ?? "") < (stance.at ?? "")) {
          // 「仅重派未修包」（决定须属于当前 rework 且未消费）：新 respond 波绑定同一 rework 决定、只含未修包
          wave = respondWave(stale, binding.decision.decisionId)
        } else if (stale.length) {
          const names = stale.map((id) => id ?? "（单 owner）").join("、")
          const reason = `返工僵局：包 ${names} 的制品指纹较返工决定时未变（实际未修），待用户仲裁`
          return { stage: stageId, status: "awaiting-user", wave: { kind: "converge-user", reason }, gate: null, next: { kind: "await-decision", reason, reworkStalemate: stale, gateId: binding.decision.gateId } }
        }
        // stale 空 → 返工完成 → 落入 gateCheck
      }
    }
    if (wave.kind === "gate") {
      const gate = gateCheck({ workflow, policy, stageId, scope, artifacts, reports: stageReports, decisions, journal, packages: state2Packages(packages) })
      if (gate.passed) {
        const isCompletion = scope.completion?.mode === "through-stage"
          ? scope.completion.stage === stageId
          : (workflow.terminalStages ?? []).includes(stageId)
        return { stage: stageId, status: "working", wave, gate, next: isCompletion ? { kind: "complete" } : { kind: "advance" } }
      }
      const awaiting = gate.blockers.some((b) => b.awaitingUser)
      return {
        stage: stageId,
        status: awaiting ? "awaiting-user" : "working",
        wave,
        gate,
        next: awaiting ? { kind: "await-decision" } : { kind: "dispatch", hint: gate.blockers.map((b) => b.recovery) },
      }
    }
    // wave 已被 rework 覆盖为 respond → 落入统一守卫
  }

  // F1/F3 统一守卫：所有派发路径（produce/respond/review/verdict）统一经过 waveId 批次守卫——
  // 存在任何未 superseded 的未结波一律 wait-inflight（幂等语义钉死，属性匹配仅决定复用哪张在途卡）。
  if (["produce", "respond", "review", "verdict"].includes(wave.kind)) {
    const inflight = inflightBatch({ journal, reports })
    if (inflight) {
      return {
        stage: stageId,
        status: "working",
        wave,
        gate: null,
        next: { kind: "wait-inflight", dispatchKey: inflight.open[0].key, waveId: inflight.waveId, wave },
      }
    }
  }

  return { stage: stageId, status: "working", wave, gate: null, next: { kind: "dispatch", wave } }
}
