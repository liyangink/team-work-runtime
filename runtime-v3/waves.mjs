// waves.mjs — policy 场景 → 波次推进（纯函数）
// 波次 = 一次派单单元（v3.2 波组化）：多包任务按 DAG 分层并行派发、按包计轮、
// 组合评审（consolidation）、findings 包归属选择性重派、聚合裁决新鲜度。
// 单 owner 任务（无 packages）= 匿名单包 [null]，行为与 v3.1 一致。
// 报告形状：{reportId, role, kind, round, payload, at, package?}——
// deliver 的 package 由 runtime 从派发事件写入（成员不填，P4）；review 的 findings[].package 为模型语义（F3）。
// v3.4 波身份与恢复（docs/wave-identity-recovery-plan.md）：
// 波有实体身份 waveId（wv1/wv2/…，F1）；轮次无实体、唯一算法 = 每包 max(已交付报告 round)（F2）；
// 在途 = 存在未 superseded 的未结波（F1/F3 守卫，波与波永远串行）；superseded 波在投影/在途/回溯统一排除（F3）。

export function scenePolicy(policy, sceneId) {
  const scene = policy?.scenes?.[sceneId]
  if (!scene) {
    const error = new Error(`team policy 没有场景 ${sceneId}`)
    error.code = "SCENE_UNKNOWN"
    throw error
  }
  return {
    ownerTier: scene.ownerTier ?? "junior",
    challengerTier: scene.challengerTier ?? "senior",
    core: Boolean(scene.core),
    maxRounds: policy.maxAutonomousRounds ?? 3,
  }
}

function lastOf(reports, predicate) {
  const matched = reports.filter(predicate)
  return matched[matched.length - 1] ?? null
}

function findingsPackages(review) {
  return (review?.payload?.findings ?? []).map((f) => f.package).filter((p) => p != null)
}

// —— F1/F9 波身份解析 ——
// 派发 → waveId：dispatched.detail.waveId 直接事实优先；wave-assigned join（F9 迁移追加式，不改写既有行）；
// 两者皆无 → null（退化语义 B8：每条派发按 key 各自成波，列为迁移验收「迁移前后状态等价」的一部分）。
export function waveIdOf(journal, dispatchKey) {
  const dispatch = journal.find((e) => e.type === "dispatched" && e.detail?.key === dispatchKey)
  if (dispatch?.detail?.waveId) return dispatch.detail.waveId
  const assigned = journal.find((e) => e.type === "wave-assigned" && (e.detail?.dispatchKeys ?? []).includes(dispatchKey))
  return assigned?.detail?.waveId ?? null
}

// 已作废波（dispatch-superseded {waveId, reason}，F3 只增恢复边）→ 其派发 key 集合（含 wave-assigned join 解析）。
// 投影/快照/依赖/耗尽/回溯/在途统一以此为排除源。
export function supersededKeys(journal) {
  const superseded = new Set(journal.filter((e) => e.type === "dispatch-superseded" && e.detail?.waveId).map((e) => e.detail.waveId))
  if (superseded.size === 0) return new Set()
  const keys = new Set()
  for (const e of journal) {
    if (e.type !== "dispatched" || !e.detail?.key) continue
    const wid = e.detail.waveId ?? waveIdOf(journal, e.detail.key)
    if (wid && superseded.has(wid)) keys.add(e.detail.key)
  }
  return keys
}

// 波分组（journal 序）：{waveId|null, keys[]}[]；无 waveId 事实按 key 各自成波（退化语义）。
// wave-assigned join 解析（F9 迁移追加式事实，与 waveIdOf 同源）：迁移赋号的派发必须按其波分组，
// 否则 retire/在途卡等消费点对迁移波一律判「未知波」（retire 恢复边死门）。
export function waveGroups(journal) {
  const assigned = new Map() // 预建 join 索引：dispatchKey → waveId（O(n)，避免逐条 waveIdOf 的 O(n²)）
  for (const e of journal) {
    if (e.type === "wave-assigned" && e.detail?.waveId && Array.isArray(e.detail?.dispatchKeys)) {
      for (const k of e.detail.dispatchKeys) if (!assigned.has(k)) assigned.set(k, e.detail.waveId)
    }
  }
  const groups = []
  const index = new Map()
  for (const e of journal) {
    if (e.type !== "dispatched" || !e.detail?.key) continue
    const wid = e.detail.waveId ?? assigned.get(e.detail.key) ?? null
    const groupKey = wid ?? `key:${e.detail.key}`
    let group = index.get(groupKey)
    if (!group) {
      group = { waveId: wid, keys: [] }
      index.set(groupKey, group)
      groups.push(group)
    }
    group.keys.push(e.detail.key)
  }
  return groups
}

// —— F2 轮次唯一投影 ——
// 投影输入集钉死：kind=deliver 且 outcome=delivered 且非 superseded 波；blocked 报告不入投影；
// 旧报告无 waveId 回退按 dispatchKey 独立条目（与 max 口径等价，防御性）。
// 唯一权威源：每包 max(已交付报告 round 字段)，round 由派发事件抄写（P4，成员不填）；
// 报告上的 waveId 仅作展示字段，投影判定一律经 dispatchKey join journal 解析（杜绝新旧双源分叉）。
// 去重由 max 天然完成，不另设 waveId 去重步骤；同 key 多 ver 取最大 ver 唯一化（F7 防御）。
export function effectiveDelivers({ journal = [], reports = [] }) {
  const excluded = supersededKeys(journal)
  const latest = new Map()
  for (const r of reports) {
    if (r.role !== "owner" || r.kind !== "deliver") continue
    if (r.payload?.outcome !== "delivered") continue
    if (r.dispatchKey != null && excluded.has(r.dispatchKey)) continue
    // 同 key 多 ver 取最大 ver（F7 防御）；无 dispatchKey 的旧报告按 reportId 独立条目（与 max 口径等价，防御性）
    const k = `${r.package ?? null}\u0000${r.dispatchKey ?? r.reportId}`
    const prev = latest.get(k)
    if (!prev || (r.ver ?? 1) > (prev.ver ?? 1)) latest.set(k, r)
  }
  return [...latest.values()]
}

// 每包投影轮（唯一算法）：Map<pkg, round>；produce/respond 轮次 = 投影轮 + 1（该包最大派发 round + 1）。
export function projectRounds({ journal = [], reports = [] }) {
  const rounds = new Map()
  for (const r of effectiveDelivers({ journal, reports })) {
    const pkg = r.package ?? null
    const round = r.round ?? 1
    if (!rounds.has(pkg) || round > rounds.get(pkg)) rounds.set(pkg, round)
  }
  return rounds
}

// —— 有效 blocked（seq 因果，导出纯函数：nextWave 静止卡判定与 derive 的 F5 消费规则 2 共用）——
// 语义：blocked 只对"当前范围承诺"有效。锚 = 该包最新 owner 报告（blocked）所属派发的 journal seq；
// 锚之后出现同包 owner 派发（Lead 扩权重派）或任意重拆（packages-planned/re-planned）= 新范围承诺
// 已在场，旧 blocked 降级为派单卡上下文（cli 重派时内嵌原因），不再静止。
// 因果用 journal seq 全序（与 reviewChainFingerprint 同口径：report-accepted seq 第一全序、at 次级破平、
// ver 再破平），不用墙钟 at 比较——同毫秒误判、时钟回拨误静止。
// 报告全序也用于"最新 owner 报告"选取（旧实现 at 比较同样受墙钟影响）。
// 返回 Map<pkg, 报告>（键即有效 blocked 包集合，值为该包最新 blocked 报告，供静止卡文案与 F5 判定）。
export function effectiveBlockedSet({ journal = [], reports = [], packages = null }) {
  const ids = Array.isArray(packages) ? packages.map((p) => p.id) : [null]
  // 单次扫描建索引：报告 seq / 派发 seq / 每包 owner 派发最大 seq / 全局重拆最大 seq
  const reportSeq = new Map()
  const dispatchSeq = new Map()
  let lastPlanSeq = -1
  const ownerDispatchSeq = new Map()
  for (const e of journal) {
    if (e.type === "report-accepted" && e.detail?.reportId) reportSeq.set(e.detail.reportId, e.seq ?? -1)
    else if (e.type === "dispatched" && e.detail?.key) {
      dispatchSeq.set(e.detail.key, e.seq ?? -1)
      if (e.detail?.role === "owner") {
        const pkg = e.detail.package ?? null
        if ((e.seq ?? -1) > (ownerDispatchSeq.get(pkg) ?? -1)) ownerDispatchSeq.set(pkg, e.seq ?? -1)
      }
    } else if (e.type === "packages-planned" || e.type === "re-planned") {
      if ((e.seq ?? -1) > lastPlanSeq) lastPlanSeq = e.seq ?? -1
    }
  }
  const later = (a, b) => {
    const sa = reportSeq.get(a.reportId) ?? -1
    const sb = reportSeq.get(b.reportId) ?? -1
    if (sa !== sb) return sa > sb
    if ((a.at ?? "") !== (b.at ?? "")) return (a.at ?? "") > (b.at ?? "")
    return (a.ver ?? 1) > (b.ver ?? 1)
  }
  const lastOfPkg = new Map()
  for (const r of reports) {
    if (r.role !== "owner" || r.kind !== "deliver") continue
    const pkg = r.package ?? null
    const prev = lastOfPkg.get(pkg)
    if (!prev || later(r, prev)) lastOfPkg.set(pkg, r)
  }
  const out = new Map()
  for (const id of ids) {
    const r = lastOfPkg.get(id)
    if (r?.payload?.outcome !== "blocked") continue
    // 锚找不到（旧形状无 dispatchKey / journal 缺派发事件）→ -1：任意范围承诺事件都解除该 blocked
    // （保守方向：宁可多派一轮，不误静止）。
    const anchor = r.dispatchKey != null ? (dispatchSeq.get(r.dispatchKey) ?? -1) : -1
    if ((ownerDispatchSeq.get(id) ?? -1) > anchor || lastPlanSeq > anchor) continue
    out.set(id, r)
  }
  return out
}

// —— F1/F3 在途批次（唯一实现；derive / cli 在途重建 / intake 提示 / plan 重拆四处共用）——
// 波与波永远串行（F1 模型基线）：存在任何未 superseded 的未结波 → 该波在途（wait-inflight）。
// 未结波 = 同 waveId 的派发集合中至少一条尚无报告（settled = 报告的 dispatchKey 集合）；
// 多包部分交付只等未交付包（open，组合评审等齐语义）。
// 无 waveId 退化：每条派发按 key 各自成波，与现状「尾部连续批次」判定等价（B8）。
// 返回 journal 序最早未结波 {waveId|null, entries, open}；全部已结 → null。
export function inflightBatch({ journal = [], reports = [] }) {
  const settled = new Set(reports.map((r) => r.dispatchKey))
  const excluded = supersededKeys(journal)
  for (const group of waveGroups(journal)) {
    const openKeys = group.keys.filter((k) => !settled.has(k) && !excluded.has(k))
    if (openKeys.length === 0) continue
    const entries = journal.filter((e) => e.type === "dispatched" && group.keys.includes(e.detail?.key)).map((e) => e.detail)
    return { waveId: group.waveId, entries, open: entries.filter((d) => openKeys.includes(d.key)) }
  }
  return null
}

// 返回波组描述符：
//   {kind:"produce"|"respond", role:"owner", round, owners:[{package,round,continuation}]}
//   {kind:"review",  role:"challenger", round, scope?, continuation}   // 多包组合评审 scope="consolidation"
//   {kind:"verdict", role:"expert", round, continuation}  // continuation = 已有 expert 报告（重裁续派，台账门槛 3）
//   {kind:"gate"} | {kind:"converge-user", reason}
// owners 的 package 为 null 表示单 owner 匿名包；continuation = 该包该角色已有报告（增量续派）。
export function nextWave({ scenePolicy: sp, reports, extraRounds = 0, packages = null, journal = [] }) {
  const items = Array.isArray(packages) ? packages : null
  const ids = items ? items.map((p) => p.id) : [null]
  const depsOf = (id) => items?.find((p) => p.id === id)?.dependsOn ?? []
  const maxRounds = sp.maxRounds + extraRounds

  // F2 唯一算法：轮次 = 每包 max(已交付报告 round) 投影；报告计数口径删除。
  const rounds = projectRounds({ journal, reports })
  const roundOf = (id) => rounds.get(id) ?? 0
  // 每包有效交付事实（裁决新鲜度等用 at 口径，§8 后置保留）
  const delivers = new Map()
  for (const r of effectiveDelivers({ journal, reports })) {
    const key = r.package ?? null
    if (!delivers.has(key)) delivers.set(key, [])
    delivers.get(key).push(r)
  }
  const lastDeliverAt = (id) => delivers.get(id)?.at(-1)?.at ?? ""
  const depsSatisfied = (id) => depsOf(id).every((d) => roundOf(d) > 0)

  // —— 每包状态推导（F2 按包计轮：轮 = 该包投影轮）——
  // latest challenger review 评审"当轮已交付活跃包"组合
  const challenger = lastOf(reports, (r) => r.role === "challenger" && r.kind === "review")
  const expert = lastOf(reports, (r) => r.role === "expert" && r.kind === "review")

  // 有效 blocked（produce/respond 静止卡判定源）：seq 因果统一投影（effectiveBlockedSet，与 derive 的
  // F5 消费规则 2 同源）——该包最新 owner 报告为 blocked，且锚（报告所属派发的 journal seq）之后无
  // 同包 owner 派发、无任意重拆；blocked 只对"当前范围承诺"有效。
  // 消费动机：blocked 不入投影轮（F2）→ roundOf 恒 0 → 轮次上限永不触发，历史上会无限重派同形状派单。
  const blockedP = effectiveBlockedSet({ journal, reports, packages: items })

  // 当轮包集合 = 活跃包中已交付、且交付时间晚于上一份 challenger 评审（同轮修订不再重评）
  // 简化口径：包的最新交付是否晚于其最近一次被评审时的交付。用事实近似：直接按下面每包状态机判定。
  const state = ids.map((id) => {
    const round = roundOf(id)
    return { id, round, delivered: round > 0, depsOk: depsSatisfied(id) }
  })
  const byId = new Map(state.map((s) => [s.id, s]))

  // 判定"包 p 的最新交付是否已被最新 challenger 评审覆盖"：
  // 首选报告内快照 reviewedPackages（registerReview 时 runtime 写入：评审时各包最新轮次，P4）。
  // 覆盖 = 该包当前轮 <= 快照轮次；快照缺失该包或轮次更高 = 未覆盖。旧形状/无字段退化为 at 近似。
  const reviewedP = new Set()
  if (challenger) {
    if (Array.isArray(challenger.reviewedPackages) && challenger.reviewedPackages.every((e) => e && typeof e === "object")) {
      const snap = new Map(challenger.reviewedPackages.map((e) => [e.package ?? null, e.round]))
      for (const s of state) {
        if (!s.delivered) continue
        const snapRound = snap.get(s.id)
        if (snapRound !== undefined && s.round <= snapRound) reviewedP.add(s.id)
      }
    } else if (Array.isArray(challenger.reviewedPackages)) {
      for (const p of challenger.reviewedPackages) reviewedP.add(p ?? null)
    } else {
      for (const s of state) {
        if (s.delivered && lastDeliverAt(s.id) <= challenger.at) reviewedP.add(s.id)
      }
    }
  }

  // F3 归属解析：rework 点名集合
  const named = new Set(findingsPackages(challenger))
  const recommendation = challenger?.payload?.recommendation
  const verdictOutcome = expert?.payload?.verdict?.outcome
  // 裁决新鲜度（F8 聚合）：专家结论必须晚于全部活跃已交付包的最新交付
  const freshDeliverAt = ids.filter((id) => byId.get(id).delivered).reduce((m, id) => (lastDeliverAt(id) > m ? lastDeliverAt(id) : m), "")
  const verdictFresh = expert && expert.at > freshDeliverAt

  // 活跃集演化：从全包出发，应用收敛规则，得到每包终态
  const accepted = new Set() // 本轮已过挑战（等 verdict 或出集）
  const reworkP = new Set() // 被点名待修（下一轮 respond）
  const doneP = new Set() // 收敛出集
  const escalateP = []

  const activeDelivered = state.filter((s) => s.delivered && s.depsOk)
  if (challenger) {
    if (recommendation === "escalate") {
      for (const s of activeDelivered) escalateP.push(s.id)
    } else if (recommendation === "rework") {
      for (const s of activeDelivered) {
        if (!reviewedP.has(s.id)) continue // 评审未覆盖的交付（新交付）不走 rework，进下一轮评审
        if (named.size === 0 || named.has(s.id)) reworkP.add(s.id)
        else accepted.add(s.id) // 未被点名的包视同本轮通过（F3 选择性）
      }
    } else if (recommendation === "accept") {
      for (const s of activeDelivered) if (reviewedP.has(s.id)) accepted.add(s.id)
    }
  }
  // 非核心：accept 即出集；核心：等 verdict
  if (!sp.core) {
    for (const id of accepted) doneP.add(id)
    accepted.clear()
  } else if (expert && verdictFresh) {
    if (verdictOutcome === "accept") {
      for (const id of accepted) doneP.add(id)
      accepted.clear()
    } else if (verdictOutcome === "rework") {
      // 裁决无结构化归属（保守：全组重派）
      for (const id of accepted) reworkP.add(id)
      accepted.clear()
    }
    // other verdict（choose-option/need-more-evidence/escalate-to-user）→ converge-user
  }

  const active = ids.filter((id) => !doneP.has(id))

  // —— converge-user 判定（F2 按包触发，轮次按投影真实轮消耗）——
  const exhausted = [...reworkP].filter((id) => roundOf(id) >= maxRounds)
  if (exhausted.length) {
    const names = exhausted.map((id) => id ?? "（单 owner）").join("、")
    const reason = items
      ? `包 ${names} 已达自主轮次上限（${maxRounds}）仍未收敛`
      : `challenger 第 ${roundOf(exhausted[0])} 轮仍要求返工，已达自主轮次上限`
    return { kind: "converge-user", reason }
  }
  if (escalateP.length || (sp.core && expert && verdictFresh && !["accept", "rework"].includes(verdictOutcome))) {
    const reason = escalateP.length
      ? (items ? `包 ${escalateP.map((id) => id ?? "（单 owner）").join("、")} 的挑战者建议升级用户裁决` : "challenger 建议升级用户裁决")
      : `expert 结论 ${verdictOutcome ?? "unknown"} 需要用户或 Lead 裁决`
    return { kind: "converge-user", reason }
  }

  // —— 波选择（优先级：评审反馈优先消化，收敛期不开新范围）——
  // 1) 已交付、未过评审、且未被 rework 点名（点名包走 respond 修复，不重复评审）→ 组合评审
  const awaitingReview = active.filter((id) => byId.get(id).delivered && !accepted.has(id) && !reworkP.has(id))
  if (awaitingReview.length) {
    const round = Math.max(...awaitingReview.map((id) => roundOf(id)))
    return {
      kind: "review",
      role: "challenger",
      round,
      ...(items ? { scope: "consolidation" } : {}),
      continuation: Boolean(challenger),
    }
  }
  // 2) 返工修复（respond）：选择性重派只含被点名包；新解锁包等修复收敛后再派（F3 + 收敛纪律）；
  // 有效 blocked 包不自动重派（无限重派同形状派单 = 空转；恢复靠扩权重派，见分支 5）
  const reworkTodo = [...reworkP].filter((id) => active.includes(id) && !blockedP.has(id))
  if (reworkTodo.length) {
    const owners = reworkTodo.map((id) => ({ package: id, round: roundOf(id) + 1, continuation: true }))
    return { kind: "respond", role: "owner", round: Math.max(...owners.map((o) => o.round)), owners }
  }
  // 3) 核心场景待裁决：裁决先于新包派发（裁决可能 rework 既有包，新包应基于已裁决的稳定基线开工）。
  // continuation 仅在重裁（已有 expert 报告）时输出 true：重裁为续派——D3 同角色倒序回溯解析原 Expert 会话
  // （台账 V3-E2E-02「同类问题也发生在 Expert 重裁」的修复落点，缺此前每次重裁断链 fresh 新会话；
  // 首次裁决无报告、无 continuation 语义，与 produce/respond 的 owners[].continuation 风格区分）
  if (sp.core && accepted.size) {
    return { kind: "verdict", role: "expert", round: Math.max(...[...accepted].map((id) => roundOf(id))), ...(expert ? { continuation: true } : {}) }
  }
  // 4) 新交付派发（produce）：依赖满足、未交付且未 blocked 的包（F1 分层：依赖包交付后解锁）
  const pending = active.filter((id) => !byId.get(id).delivered && byId.get(id).depsOk)
  const dispatchable = pending.filter((id) => !blockedP.has(id))
  if (dispatchable.length) {
    const owners = dispatchable.map((id) => ({ package: id, round: roundOf(id) + 1, continuation: false }))
    return { kind: "produce", role: "owner", round: Math.max(...owners.map((o) => o.round)), owners }
  }
  // 5) 有效 blocked 静止卡：评审/返工/新派发均无可派波时，被 blocked 挡住的包出用户卡
  //（awaiting-user 静止；恢复 = 扩权重派，入口在 dispatch 通道：单 owner 用新范围调 tw-dispatch / dispatch-plan、
  // 多包 plan 重拆后推进；或用户决定结束）
  const blockedActive = active.filter((id) => blockedP.has(id))
  if (blockedActive.length) {
    const parts = blockedActive.map((id) => {
      const summary = String(blockedP.get(id)?.payload?.summary ?? "")
      const brief = summary.slice(0, 160) + (summary.length > 160 ? "…" : "")
      return `${id == null ? "（单 owner）" : `包 ${id}`}：${brief || "（无说明）"}`
    })
    const reason = `Owner 交付 blocked（无法在可写范围内完成）——${parts.join("；")}。恢复：扩大可写范围后重派（单 owner 用新范围调 tw-dispatch 的 writables / tw dispatch-plan --writable <新范围>；多包先 tw plan 重拆再推进），或由用户决定结束`
    return { kind: "converge-user", reason, produceBlocked: blockedActive }
  }
  // 6) 活跃集空 → 门
  return { kind: "gate" }
}
