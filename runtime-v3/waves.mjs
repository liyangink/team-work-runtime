// waves.mjs — policy 场景 → 波次推进（纯函数）
// 波次 = 一次派单单元（v3.2 波组化）：多包任务按 DAG 分层并行派发、按包计轮、
// 组合评审（consolidation）、findings 包归属选择性重派、聚合裁决新鲜度。
// 单 owner 任务（无 packages）= 匿名单包 [null]，行为与 v3.1 一致。
// 报告形状：{reportId, role, kind, round, payload, at, package?}——
// deliver 的 package 由 runtime 从派发事件写入（成员不填，P4）；review 的 findings[].package 为模型语义（F3）。
// v3.4 波身份与恢复（docs/wave-identity-recovery-plan.md）：
// 波有实体身份 waveId（wv1/wv2/…，F1）；轮次无实体、唯一算法 = 每包 max(已交付报告 round)（F2）；
// 在途 = 存在未 superseded 的未结波（F1/F3 守卫，波与波永远串行）；superseded 波在投影/在途/回溯统一排除（F3）。

// 场景策略：场景级 ownerTier/challengerTier 优先，缺省回退 policy.roles 兜底段。
// E3：选模链不保留任何字面量默认档——场景与 roles 都没给即 null（调用方标 unresolved 并给修复指引），
// 避免 skill 之外的隐含默认值与伪报档位溯源。档位只用于 open 期一次性解析与展示，
// 派发期直接读 roles/packages 里已固化的 ModelRef。
export function scenePolicy(policy, sceneId) {
  const scene = policy?.scenes?.[sceneId]
  if (!scene) {
    const error = new Error(`team policy 没有场景 ${sceneId}`)
    error.code = "SCENE_UNKNOWN"
    throw error
  }
  const roleTiers = policy?.roles ?? {}
  return {
    ownerTier: scene.ownerTier ?? roleTiers.owner ?? null,
    challengerTier: scene.challengerTier ?? roleTiers.challenger ?? null,
    expertTier: roleTiers.expert ?? null,
    core: Boolean(scene.core),
    maxRounds: policy.maxAutonomousRounds ?? 3,
  }
}

function lastOf(reports, predicate, compare) {
  return reports.filter(predicate).sort(compare).at(-1) ?? null
}

function findingsPackages(review) {
  return (review?.payload?.findings ?? []).map((f) => f.package).filter((p) => p != null)
}

// —— §5 返工目标投影：must-fix finding 的 scope 并集 ——
// all-covered 任一条即覆盖本次被审全体；packages.ids 精确点名；context/info 不扩大范围。
// 旧形状回退（legacy 报告兼容读取，新提交已被 intake 拒绝）：无 disposition/scope 的 finding
// 按旧口径处理——有 package 视为点名，无 package 视为全组（与旧 findingsPackages 语义等价）。
export function reworkScopePackages(review) {
  const findings = review?.payload?.findings ?? []
  let all = false
  const ids = new Set()
  const legacy = !findings.some((f) => f && typeof f === "object" && (f.disposition != null || f.scope != null))
  for (const f of findings) {
    if (!f || typeof f !== "object") continue
    if (legacy) {
      if (f.package != null) ids.add(f.package)
      else all = true
      continue
    }
    if (f.disposition !== "must-fix") continue
    const scope = f.scope
    if (scope && typeof scope === "object" && !Array.isArray(scope)) {
      if (scope.kind === "all-covered") all = true
      else if (scope.kind === "packages" && Array.isArray(scope.ids)) for (const id of scope.ids) ids.add(id)
    } else if (f.package != null) {
      ids.add(f.package)
    }
  }
  return { all, ids }
}

// 报告的 journal 提交序；缺事件 → -1。
// B3：同 reportId 多次提交（v1/v2 覆盖）时取**最后**一条 report 事件——报告文件只存最新 ver，
// 新鲜度与基线先后判定必须锚定当前 ver 的提交序（首个事件会让 v2 交付被误判已被旧评审覆盖）。
function journalSeqOf(journal, report) {
  if (!report?.reportId) return -1
  let exact = -1
  let any = -1
  for (const e of journal) {
    if ((e.type === "report-accepted" || e.type === "report-committed") && e.detail?.reportId === report.reportId) {
      any = Math.max(any, e.seq ?? -1)
      if ((e.detail.ver ?? 1) === (report.ver ?? 1)) exact = Math.max(exact, e.seq ?? -1)
    }
  }
  return exact >= 0 ? exact : any
}

// 报告全序比较器（§2.2 统一口径）：journal seq（report-accepted/report-committed 事件）第一全序、
// at 次级破平（同毫秒不可靠）、ver 再破平。store/gate/derive 各消费点共用同一口径，不再各比各的。
// R3-3：seq 锚按 (reportId, ver) 匹配事件——跨 key 交错时（d1/v1 → d2/v1 → d1/v2），旧 ver 的锚
// 不能被同 reportId 更高 ver 的事件顶替（否则旧清单被错误复活为"最新"）；报告无 ver 匹配任意事件
// 时回退该 reportId 的最大 seq（防御）。
export function reportOrderComparator(journal = []) {
  const seqOf = new Map() // reportId|ver → seq
  const maxSeqOf = new Map() // reportId → max seq
  for (const e of journal) {
    if ((e.type === "report-accepted" || e.type === "report-committed") && e.detail?.reportId) {
      seqOf.set(e.detail.reportId + "\u0000" + (e.detail.ver ?? 1), e.seq ?? -1)
      maxSeqOf.set(e.detail.reportId, Math.max(maxSeqOf.get(e.detail.reportId) ?? -1, e.seq ?? -1))
    }
  }
  return (a, b) => {
    const sa = seqOf.get(a?.reportId + "\u0000" + (a?.ver ?? 1)) ?? maxSeqOf.get(a?.reportId) ?? -1
    const sb = seqOf.get(b?.reportId + "\u0000" + (b?.ver ?? 1)) ?? maxSeqOf.get(b?.reportId) ?? -1
    if (sa !== sb) return sa > sb ? 1 : -1
    if ((a?.at ?? "") !== (b?.at ?? "")) return (a?.at ?? "") > (b?.at ?? "") ? 1 : -1
    return (a?.ver ?? 1) - (b?.ver ?? 1)
  }
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
// —— §6.1 每包完整清单基线（用户拍板：paths 是完整交付清单，不是增量） ——
// 每包有效基线 = 该包按 journal 提交序（report-accepted/report-committed 全序锚）选择的
// 最新一条未作废且 outcome=delivered 的报告；同 key 多 ver 由报告文件唯一性（当前 ver 覆盖）收敛，
// 缺 journal 事件的报告按 at 稳定序补尾（P1：报告是事实源，不因事件缺失丢弃）。
// lead-refresh 来源报告（origin=user-authorized-lead-refresh）同样入选——形成待评审基线，
// 但不推高 Owner 投影轮（§6.2.1：不充当 Owner 新一轮派单、不消耗自主轮次）。
// 返回 Map<pkg, {report, seq, round}>：round 为展示轮（refresh 报告继承包内非 refresh 最大轮，无则 0）。
export function deliverBaselines({ journal = [], reports = [], groupedByStage = false }) {
  const excluded = supersededKeys(journal)
  const later = reportOrderComparator(journal)
  const latest = new Map()
  for (const r of reports) {
    if (r.role !== "owner" || r.kind !== "deliver") continue
    if (r.payload?.outcome !== "delivered") continue
    if (r.dispatchKey != null && excluded.has(r.dispatchKey)) continue
    const key = groupedByStage ? `${r.stage ?? ""}\u0000${r.package ?? null}` : (r.package ?? null)
    const prev = latest.get(key)
    if (!prev || later(r, prev) > 0) latest.set(key, r)
  }
  const seqOf = new Map()
  for (const e of journal) {
    if ((e.type === "report-accepted" || e.type === "report-committed") && e.detail?.reportId) {
      seqOf.set(e.detail.reportId + "\u0000" + (e.detail.ver ?? 1), e.seq ?? 0)
    }
  }
  const out = new Map()
  for (const [key, report] of latest) {
    out.set(key, { report, seq: seqOf.get(report.reportId + "\u0000" + (report.ver ?? 1)) ?? 0, round: report.round ?? 0, stage: report.stage ?? null, package: report.package ?? null })
  }
  return out
}

// 旧导出兼容：有效 delivered 报告集合 = 各包基线报告（每包一条）。
export function effectiveDelivers({ journal = [], reports = [] }) {
  return [...deliverBaselines({ journal, reports }).values()].map((b) => b.report)
}

// 每包投影轮（唯一算法）：Map<pkg, round>；produce/respond 轮次 = 投影轮 + 1（该包最大派发 round + 1）。
// §6.2.1：lead-refresh 报告不推高投影轮（refresh 报告 round 继承自包内非 refresh 报告的最大轮）。
export function projectRounds({ journal = [], reports = [] }) {
  const rounds = new Map()
  const baselines = deliverBaselines({ journal, reports })
  // 先扫全部 delivered 报告取包内非 refresh 最大轮（superseded/blocked 排除口径与 baselines 一致）
  const excluded = supersededKeys(journal)
  for (const r of reports) {
    if (r.role !== "owner" || r.kind !== "deliver") continue
    if (r.payload?.outcome !== "delivered") continue
    if (r.dispatchKey != null && excluded.has(r.dispatchKey)) continue
    if (r.origin === "user-authorized-lead-refresh") continue
    const pkg = r.package ?? null
    const round = r.round ?? 1
    if (!rounds.has(pkg) || round > rounds.get(pkg)) rounds.set(pkg, round)
  }
  // 无非 refresh 报告但有 refresh 基线的包：轮 0（已形成待评审基线、未消耗 Owner 轮次）
  for (const pkg of baselines.keys()) if (!rounds.has(pkg)) rounds.set(pkg, 0)
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
  // 单次扫描建索引：报告 seq / 派发 seq / 每包 blocked-resolved 事件（§6.3 按包恢复）
  const dispatchSeq = new Map()
  const resolved = []
  for (const e of journal) {
    if (e.type === "dispatched" && e.detail?.key) dispatchSeq.set(e.detail.key, e.seq ?? -1)
    else if (e.type === "blocked-resolved") resolved.push(e)
  }
  // 与有效交付基线共用 (reportId, ver) 提交序，不能按 reportId 混淆不同版本。
  const compareReports = reportOrderComparator(journal)
  const blockedExcluded = supersededKeys(journal)
  const lastOfPkg = new Map()
  for (const r of reports) {
    if (r.role !== "owner" || r.kind !== "deliver") continue
    // R3-4/§6.1：整波作废的报告不参与 blocked 投影——部分交付波（A blocked、B 未交）retire 后，
    // A 的 blocked 报告随波忽略（回到上一条未作废 delivered 基线），nextWave 正常重派 A 而非漏派。
    if (r.dispatchKey != null && blockedExcluded.has(r.dispatchKey)) continue
    const pkg = r.package ?? null
    const prev = lastOfPkg.get(pkg)
    if (!prev || compareReports(r, prev) > 0) lastOfPkg.set(pkg, r)
  }
  const out = new Map()
  for (const id of ids) {
    const r = lastOfPkg.get(id)
    if (r?.payload?.outcome !== "blocked") continue
    // 锚找不到（旧形状无 dispatchKey / journal 缺派发事件）→ -1。
    const anchor = r.dispatchKey != null ? (dispatchSeq.get(r.dispatchKey) ?? -1) : -1
    // §6.3（F-N3）：计划变更（重拆）与新派发都不再自动解除 blocked——被恢复的包必须由
    // 已获用户明确方向的 Lead 显式选择：package-recovery 卡经用户确认后写 blocked-resolved 事件。
    // 事件必须晚于 blocked 报告锚，且绑定的 dispatchKey/报告版本与当前 blocked 报告匹配
    // （旧恢复事件不得解除新 blocked 版本；重放不消费新版本）。
    const reportVersion = r.ver ?? 1
    const resolvedBy = resolved.some((e) => (e.seq ?? -1) > anchor
      && (e.detail?.package ?? null) === id
      && e.detail?.dispatchKey === r.dispatchKey
      && (e.detail?.reportVersion ?? 1) === reportVersion)
    if (resolvedBy) continue
    out.set(id, r)
  }
  return out
}

// 按包 retry 已获确认，但只有该决定之后的新 Owner 派单及其已提交报告才能消费重试。
// 旧评审、旧 key 迟到报告和作废波均不能代替这个回应；新报告为 blocked 时由 blocked 投影接管。
// reports 由调用方限定当前阶段，恢复事件通过原 blocked 派单及同阶段报告定位，不另存状态。
function pendingRecoveryRetries({ journal, reports, ids }) {
  const active = new Set(ids)
  const excluded = supersededKeys(journal)
  const dispatches = new Map()
  const commits = new Map()
  for (const event of journal) {
    if (event.type === "dispatched" && event.detail?.key) dispatches.set(event.detail.key, event)
    if ((event.type === "report-accepted" || event.type === "report-committed") && event.detail?.reportId) {
      commits.set(event.detail.reportId + "\u0000" + (event.detail.ver ?? 1), event.seq ?? -1)
    }
  }
  const ownerReports = reports.filter((r) => r.role === "owner" && r.kind === "deliver" && r.dispatchKey != null && !excluded.has(r.dispatchKey))
  const completedDispatchSeq = new Map()
  for (const report of ownerReports) {
    const dispatch = dispatches.get(report.dispatchKey)
    if (dispatch?.detail?.role !== "owner" || !["delivered", "blocked"].includes(report.payload?.outcome)) continue
    const pkg = report.package ?? null
    if ((dispatch.detail.package ?? null) !== pkg) continue
    const dispatchSeq = dispatch.seq ?? -1
    const commitSeq = commits.get(report.reportId + "\u0000" + (report.ver ?? 1)) ?? -1
    if (commitSeq > dispatchSeq) completedDispatchSeq.set(pkg, Math.max(completedDispatchSeq.get(pkg) ?? -1, dispatchSeq))
  }
  const recoveries = new Map()
  for (const event of journal) {
    if (event.type !== "blocked-resolved" || event.detail?.action !== "retry") continue
    const pkg = event.detail.package ?? null
    const key = event.detail.dispatchKey
    // 原派单已作废或不属于本阶段报告时，其恢复事实不再对当前包生效。
    if (!active.has(pkg) || !key || excluded.has(key) || !dispatches.has(key)) continue
    if (!ownerReports.some((r) => r.dispatchKey === key && (r.package ?? null) === pkg)) continue
    recoveries.set(pkg, Math.max(recoveries.get(pkg) ?? -1, event.seq ?? -1))
  }
  return new Set([...recoveries].filter(([pkg, seq]) => (completedDispatchSeq.get(pkg) ?? -1) <= seq).map(([pkg]) => pkg))
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
  // lead-refresh 报告不推高投影轮（§6.2.1），但形成待评审基线（delivered 判定含 refresh）。
  const rounds = projectRounds({ journal, reports })
  const roundOf = (id) => rounds.get(id) ?? 0
  // §6.1/§6.2.1 每包完整清单基线：Map<pkg, {report, seq, round}>——delivered 判定与评审覆盖
  // （challenger 报告须晚于基线提交）都以基线身份为准，刷新报告自动触发重新评审。
  const baselines = deliverBaselines({ journal, reports })
  const lastDeliverAt = (id) => baselines.get(id)?.report.at ?? ""
  // B10/§6.2.1：依赖就绪 = 依赖包已形成有效完整基线（含 Lead 刷新来源，round=0 也算），
  // 不再以 Owner 投影轮 > 0 判断——只有刷新基线的包不应卡住依赖包派发。
  const depsSatisfied = (id) => depsOf(id).every((d) => baselines.has(d))

  // —— 每包状态推导（F2 按包计轮：轮 = 该包投影轮）——
  // latest challenger review 评审"当轮已交付活跃包"组合
  const compareReports = reportOrderComparator(journal)
  const challenger = lastOf(reports, (r) => r.role === "challenger" && r.kind === "review", compareReports)
  const expert = lastOf(reports, (r) => r.role === "expert" && r.kind === "review", compareReports)

  // 有效 blocked（produce/respond 静止卡判定源）：seq 因果统一投影（effectiveBlockedSet，与 derive 的
  // F5 消费规则 2 同源）——该包最新 owner 报告为 blocked，且锚（报告所属派发的 journal seq）之后无
  // 同包 owner 派发、无任意重拆；blocked 只对"当前范围承诺"有效。
  // 消费动机：blocked 不入投影轮（F2）→ roundOf 恒 0 → 轮次上限永不触发，历史上会无限重派同形状派单。
  const blockedP = effectiveBlockedSet({ journal, reports, packages: items })
  const pendingRetries = pendingRecoveryRetries({ journal, reports, ids })

  // 当轮包集合 = 活跃包中已交付、且交付时间晚于上一份 challenger 评审（同轮修订不再重评）
  // 简化口径：包的最新交付是否晚于其最近一次被评审时的交付。用事实近似：直接按下面每包状态机判定。
  const state = ids.map((id) => {
    const round = roundOf(id)
    return { id, round, delivered: baselines.has(id), depsOk: depsSatisfied(id) }
  })
  const byId = new Map(state.map((s) => [s.id, s]))

  // 判定"包 p 的最新交付是否已被最新 challenger 评审覆盖"：
  // 首选报告内快照 reviewedPackages（registerReview 时 runtime 写入：评审时各包最新轮次，P4）。
  // 覆盖 = 该包当前轮 <= 快照轮次；快照缺失该包或轮次更高 = 未覆盖。旧形状/无字段退化为 at 近似。
  // §6.2/§6.2.1 补充：评审还必须晚于该包基线提交（challengerSeq >= baselineSeq）——
  // 刷新报告或迟到重交形成新基线后，旧评审不再视为覆盖，自动进入重新评审。
  const challengerSeq = challenger ? journalSeqOf(journal, challenger) : -1
  const reviewedP = new Set()
  if (challenger) {
    if (Array.isArray(challenger.reviewedPackages) && challenger.reviewedPackages.every((e) => e && typeof e === "object")) {
      const snap = new Map(challenger.reviewedPackages.map((e) => [e.package ?? null, e.round]))
      for (const s of state) {
        if (!s.delivered) continue
        const base = baselines.get(s.id)
        if (challengerSeq >= 0 && base && challengerSeq < base.seq) continue
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

  // §5 归属解析：rework 目标 = must-fix scope 并集（all-covered 或 packages.ids 精确点名）
  const scopeOf = (review) => reworkScopePackages(review)
  const challengerScope = challenger ? scopeOf(challenger) : { all: false, ids: new Set() }
  const recommendation = challenger?.payload?.recommendation
  const verdictOutcome = expert?.payload?.verdict?.outcome
  // 裁决新鲜度（F8 聚合，§6.2 基线口径）：专家结论必须晚于全部活跃已交付包的最新基线——
  // journal seq 全序优先（含刷新/迟到重交形成的新基线），报告缺事件（旧任务）回退 at 墙钟近似。
  const expertSeq = expert ? journalSeqOf(journal, expert) : -1
  const deliveredIds = ids.filter((id) => byId.get(id).delivered)
  const freshDeliverAt = deliveredIds.reduce((m, id) => (lastDeliverAt(id) > m ? lastDeliverAt(id) : m), "")
  const verdictFreshBySeq = expertSeq >= 0 && deliveredIds.every((id) => {
    const base = baselines.get(id)
    if (!base || base.seq === 0) return true // 无基线或基线缺事件锚（旧任务）→ 不构成 seq 约束
    return expertSeq >= base.seq
  })
  const verdictFresh = Boolean(expert) && (verdictFreshBySeq || (expertSeq < 0 && expert.at > freshDeliverAt))

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
        if (!reviewedP.has(s.id)) continue // 评审未覆盖的交付（新基线）不走 rework，进下一轮评审
        if (challengerScope.all || challengerScope.ids.has(s.id)) reworkP.add(s.id)
        else accepted.add(s.id) // 未被点名的包视同本轮通过（F3/§5 选择性）
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
      // §5/§6.1：技术返工目标 = verdict 报告 must-fix scope 并集（不再无条件全组重派）；
      // 旧形状 verdict（无 scope findings）回退全组（legacy 保守口径）。
      const expertScope = reworkScopePackages(expert)
      for (const id of accepted) {
        if (expertScope.all || expertScope.ids.size === 0 || expertScope.ids.has(id)) {
          reworkP.add(id)
          accepted.delete(id)
        }
        // 未点名的包保留已评状态，避免旧 verdict 反复触发无关复审。
      }
      for (const id of expertScope.ids) if (!reworkP.has(id) && activeDelivered.some((s) => s.id === id)) reworkP.add(id)
    }
    // other verdict（choose-option/need-more-evidence/escalate-to-user）→ converge-user
  }

  // B10/§6.1：有效 blocked 优先于收敛出集——包在有效 blocked 投影中时，即使本轮评审 accept
  // 也不进入 done/accepted（最新事实是 blocked，不得以旧清单绕过阻塞直接过门），留给 blockedActive
  // 静止卡走 §6.3 按包恢复；人工门 rework 的其余既有情况由 derive 的 F5 消费规则接管。
  for (const id of blockedP.keys()) {
    doneP.delete(id)
    accepted.delete(id)
    reworkP.delete(id)
  }
  // retry 是用户已确认的重试承诺；期间其他包的组合 accept 不得消费该包的 Owner 回应。
  for (const id of pendingRetries) {
    doneP.delete(id)
    accepted.delete(id)
    if (!blockedP.has(id) && baselines.has(id)) reworkP.add(id)
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
  // 1) 先消化已明确的返工，避免未覆盖包的评审反复抢占被点名包的修复机会。
  // 有效 blocked 包不自动重派；用户明确方向后按报告引用确认恢复。
  const reworkTodo = [...reworkP].filter((id) => active.includes(id) && !blockedP.has(id)
    && (!pendingRetries.has(id) || (depsSatisfied(id) && depsOf(id).every((dep) => !blockedP.has(dep) && !pendingRetries.has(dep)))))
  if (reworkTodo.length) {
    const owners = reworkTodo.map((id) => ({ package: id, round: roundOf(id) + 1, continuation: true }))
    return { kind: "respond", role: "owner", round: Math.max(...owners.map((o) => o.round)), owners }
  }
  // 2) 已交付、未过评审、且未被 rework 点名（点名包走 respond 修复，不重复评审）→ 组合评审；
  // 有效 blocked 的包不进评审（其当前事实是待恢复，旧基线评审已消费，见 B10/§6.1）
  const awaitingReview = active.filter((id) => byId.get(id).delivered && !accepted.has(id) && !reworkP.has(id) && !blockedP.has(id))
  if (awaitingReview.length) {
    // 展示轮至少 1（§6.2.1：刷新形成基线而未消耗 Owner 轮时，评审展示轮号不取 0；仅展示序号）
    const round = Math.max(1, ...awaitingReview.map((id) => roundOf(id)))
    return {
      kind: "review",
      role: "challenger",
      round,
      ...(items ? { scope: "consolidation" } : {}),
      continuation: Boolean(challenger),
    }
  }
  // 3) 核心场景待裁决：裁决先于新包派发（裁决可能 rework 既有包，新包应基于已裁决的稳定基线开工）。
  // continuation 仅在重裁（已有 expert 报告）时输出 true：重裁为续派——D3 同角色倒序回溯解析原 Expert 会话
  // （台账 V3-E2E-02「同类问题也发生在 Expert 重裁」的修复落点，缺此前每次重裁断链 fresh 新会话；
  // 首次裁决无报告、无 continuation 语义，与 produce/respond 的 owners[].continuation 风格区分）
  // 有效 rework 裁决已给出时，未点名包仍保留已审状态，但不应重复派 Expert；
  // 若被点名包 blocked，应继续走下方恢复卡，而不是在 verdict 波里空转。
  if (sp.core && accepted.size && !(expert && verdictFresh && verdictOutcome === "rework")) {
    return { kind: "verdict", role: "expert", round: Math.max(...[...accepted].map((id) => roundOf(id))), ...(expert ? { continuation: true } : {}) }
  }
  // 4) 新交付派发（produce）：依赖满足、未交付且未 blocked 的包（F1 分层：依赖包交付后解锁）
  const pending = active.filter((id) => !byId.get(id).delivered && byId.get(id).depsOk)
  // 旧基线可继续评审，但前置包 blocked 或确认 retry 后尚未回应时不能解锁新包。
  const dispatchable = pending.filter((id) => !blockedP.has(id) && depsOf(id).every((dep) => !blockedP.has(dep) && !pendingRetries.has(dep)))
  if (dispatchable.length) {
    const owners = dispatchable.map((id) => ({ package: id, round: roundOf(id) + 1, continuation: false }))
    return { kind: "produce", role: "owner", round: Math.max(...owners.map((o) => o.round)), owners }
  }
  // 5) 有效 blocked 静止卡：评审/返工/新派发均无可派波时，被 blocked 挡住的包出用户卡
  //（awaiting-user 静止；按 §6.3 绑定 blocked 报告及用户方向准备恢复卡，确认后才能解除阻塞）
  const blockedActive = active.filter((id) => blockedP.has(id))
  if (blockedActive.length) {
    const parts = blockedActive.map((id) => {
      const summary = String(blockedP.get(id)?.payload?.summary ?? "")
      const brief = summary.slice(0, 160) + (summary.length > 160 ? "…" : "")
      return `${id == null ? "（单 owner）" : `包 ${id}`}：${brief || "（无说明）"}`
    })
    const reason = `Owner 交付 blocked（当前条件下无法完成）——${parts.join("；")}。先核必要性和授权，用户明确方向与授权后按该包的 blocked 报告引用准备并确认恢复卡，或决定结束；计划变更和路径参数不代表恢复授权`
    // Expert 定点返工目标已 blocked 时，走 §6.3 按包恢复，不能退回旧的整波人工门重派。
    const expertScope = sp.core && expert && verdictFresh && verdictOutcome === "rework" ? reworkScopePackages(expert) : null
    const packageRecoveryRequired = expertScope && !expertScope.all && expertScope.ids.size > 0 && blockedActive.some((id) => expertScope.ids.has(id))
    return { kind: "converge-user", reason, produceBlocked: blockedActive, ...(packageRecoveryRequired ? { packageRecoveryRequired: true } : {}) }
  }
  // 6) 活跃集空 → 门
  return { kind: "gate" }
}
