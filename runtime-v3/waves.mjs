// waves.mjs — policy 场景 → 波次推进（纯函数）
// 波次 = 一次派单单元（v3.2 波组化）：多包任务按 DAG 分层并行派发、按包计轮、
// 组合评审（consolidation）、findings 包归属选择性重派、聚合裁决新鲜度。
// 单 owner 任务（无 packages）= 匿名单包 [null]，行为与 v3.1 一致。
// 报告形状：{reportId, role, kind, round, payload, at, package?}——
// deliver 的 package 由 runtime 从派发事件写入（成员不填，P4）；review 的 findings[].package 为模型语义（F3）。

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

// 返回波组描述符：
//   {kind:"produce"|"respond", role:"owner", round, owners:[{package,round,continuation}]}
//   {kind:"review",  role:"challenger", round, scope?, continuation}   // 多包组合评审 scope="consolidation"
//   {kind:"verdict", role:"expert", round}
//   {kind:"gate"} | {kind:"converge-user", reason}
// owners 的 package 为 null 表示单 owner 匿名包；continuation = 该包该角色已有报告（增量续派）。
export function nextWave({ scenePolicy: sp, reports, extraRounds = 0, packages = null }) {
  const items = Array.isArray(packages) ? packages : null
  const ids = items ? items.map((p) => p.id) : [null]
  const depsOf = (id) => items?.find((p) => p.id === id)?.dependsOn ?? []
  const maxRounds = sp.maxRounds + extraRounds

  // 每包 owner 交付事实（reports 已按 at 升序）
  const delivers = new Map()
  for (const r of reports) {
    if (r.role !== "owner" || r.kind !== "deliver") continue
    const key = r.package ?? null
    if (!delivers.has(key)) delivers.set(key, [])
    delivers.get(key).push(r)
  }
  const roundOf = (id) => delivers.get(id)?.length ?? 0
  const lastDeliverAt = (id) => delivers.get(id)?.at(-1)?.at ?? ""
  const depsSatisfied = (id) => depsOf(id).every((d) => roundOf(d) > 0)

  // —— 每包状态推导（F2 按包计轮：轮 = 该包 owner 交付数）——
  // latest challenger review 评审"当轮已交付活跃包"组合
  const challenger = lastOf(reports, (r) => r.role === "challenger" && r.kind === "review")
  const expert = lastOf(reports, (r) => r.role === "expert" && r.kind === "review")

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

  // —— converge-user 判定（F2 按包触发）——
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
  // 2) 返工修复（respond）：选择性重派只含被点名包；新解锁包等修复收敛后再派（F3 + 收敛纪律）
  const reworkTodo = [...reworkP].filter((id) => active.includes(id))
  if (reworkTodo.length) {
    const owners = reworkTodo.map((id) => ({ package: id, round: roundOf(id) + 1, continuation: true }))
    return { kind: "respond", role: "owner", round: Math.max(...owners.map((o) => o.round)), owners }
  }
  // 3) 核心场景待裁决：裁决先于新包派发（裁决可能 rework 既有包，新包应基于已裁决的稳定基线开工）
  if (sp.core && accepted.size) {
    return { kind: "verdict", role: "expert", round: Math.max(...[...accepted].map((id) => roundOf(id))) }
  }
  // 4) 新交付派发（produce）：依赖满足且未交付的包（F1 分层：依赖包交付后解锁）
  const pending = active.filter((id) => !byId.get(id).delivered && byId.get(id).depsOk)
  if (pending.length) {
    const owners = pending.map((id) => ({ package: id, round: roundOf(id) + 1, continuation: false }))
    return { kind: "produce", role: "owner", round: Math.max(...owners.map((o) => o.round)), owners }
  }
  // 5) 活跃集空 → 门
  return { kind: "gate" }
}
