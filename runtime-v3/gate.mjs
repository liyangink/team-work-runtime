// gate.mjs — 门禁检查（纯函数，目录数据 → 判定）
// 门 = 一次总检查（P2/P3）：当前阶段产出物在场 + 检查通过 + 非作者评审在场 + （核心场景）Expert 裁决 + 人工门凭证。
// 每条 blocker 带 requirement/evidence/recovery（I5：拒绝必有出路）。
// AGENTS 规则 5：只检查当前阶段声明的最低必需输入；历史阶段制品缺失不阻塞（制品两分法：输入上下文不登记）。

import { digestValue } from "./domain/digests.mjs"

export function artifactsFingerprint(items) {
  return digestValue(items.map(({ path, digest }) => ({ path, digest })).sort((a, b) => a.path.localeCompare(b.path)))
}

// gate 只认当前阶段登记过的产出物（deliver 时写入 artifacts.items）；
// 历史阶段制品缺失不检查（AGENTS 规则 5 / 制品两分法）。
function stageArtifacts(artifacts, stageId) {
  return artifacts.items.filter((item) => item.stage === stageId)
}

export function gateCheck({ workflow, policy, stageId, scope, artifacts, reports, decisions, journal }) {
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
    const decided = decisions.find((d) => d.gateId === humanRequired.gateId && d.choice === "accept")
    const fingerprint = artifactsFingerprint(current.length ? current : artifacts.items)
    if (!decided) {
      blockers.push({
        requirement: `人工门 ${humanRequired.gateId} 等待用户决定`,
        evidence: issued ? [issued.detail.decisionId] : [],
        recovery: "向用户呈现卡片并等待 decide；任务保持静止",
        awaitingUser: true,
      })
    } else if (decided.fingerprint !== fingerprint) {
      blockers.push({
        requirement: `人工门 ${humanRequired.gateId} 的批准指纹已过期（制品在批准后发生变化）`,
        evidence: [decided.decisionId],
        recovery: "重新呈现卡片请求用户确认",
        awaitingUser: true,
      })
    }
  }

  return { passed: blockers.length === 0, blockers, humanGate: humanRequired?.gateId ?? null }
}
