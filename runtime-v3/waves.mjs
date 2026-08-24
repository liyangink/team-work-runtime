// waves.mjs — policy 场景 → 波次推进（纯函数）
// 波次 = 一次派单单元。房间内只推进波次；门禁在 gate.mjs。
// 报告形状：{reportId, role: "owner"|"challenger"|"expert", round, kind: "deliver"|"review", payload, at}

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

// 返回下一波次描述符，或收敛/门终态：
//   {kind:"produce"|"respond", role:"owner", round}
//   {kind:"review", role:"challenger", round}
//   {kind:"verdict", role:"expert", round}
//   {kind:"gate"}                     — 波次收敛，去过门
//   {kind:"converge-user", reason}    — 三轮未收敛或需用户裁决（I6；卡片选项由 cards.mjs 给）
export function nextWave({ scenePolicy: sp, reports }) {
  const ownerReports = reports.filter((r) => r.role === "owner" && r.kind === "deliver")
  const round = ownerReports.length
  if (round === 0) return { kind: "produce", role: "owner", round: 1 }

  const challenger = lastOf(reports, (r) => r.role === "challenger" && r.round === round)
  if (!challenger) return { kind: "review", role: "challenger", round }

  const recommendation = challenger.payload?.recommendation
  if (recommendation === "rework") {
    if (round >= sp.maxRounds) return { kind: "converge-user", reason: `challenger 第 ${round} 轮仍要求返工，已达自主轮次上限` }
    return { kind: "respond", role: "owner", round: round + 1 }
  }
  if (recommendation === "escalate") {
    return { kind: "converge-user", reason: "challenger 建议升级用户裁决" }
  }

  if (!sp.core) return { kind: "gate" }

  const expert = lastOf(reports, (r) => r.role === "expert" && r.kind === "review")
  const lastOwnerAt = ownerReports[ownerReports.length - 1]?.at ?? ""
  // 裁决新鲜度：Expert 结论必须晚于最后一次 Owner 交付（E2E-07 教训：
  // 返工后的制品不能靠返工前的裁决放行）；不新鲜则重新裁决
  if (!expert || expert.at <= lastOwnerAt) return { kind: "verdict", role: "expert", round }
  const outcome = expert.payload?.verdict?.outcome
  if (outcome === "accept") return { kind: "gate" }
  if (outcome === "rework") {
    if (round >= sp.maxRounds) return { kind: "converge-user", reason: `expert 第 ${round} 轮后仍要求返工，已达自主轮次上限` }
    return { kind: "respond", role: "owner", round: round + 1 }
  }
  return { kind: "converge-user", reason: `expert 结论 ${outcome ?? "unknown"} 需要用户或 Lead 裁决` }
}
