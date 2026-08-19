import { validateContract } from "../contracts.mjs"
import { digestValue } from "../domain/digests.mjs"

const MAX_VISIBLE_CODE_POINTS = 12_000
const MAX_ROSTER = 8
const MAX_CLAIMS = 6
const MAX_ROUNDS = 3
const MAX_ARTIFACTS = 6
const MAX_STATEMENT_CODE_POINTS = 320
const MAX_REF_CODE_POINTS = 160
const MAX_PATH_CODE_POINTS = 300

const CHOICE_LABELS = {
  accept: "接受并继续",
  rework: "补充意见后返工",
  replan: "调整范围或预算后重规划",
  stop: "停止任务",
}

function codePoints(value) {
  return Array.from(value)
}

export function decisionPacketCodePointLength(value) {
  if (typeof value === "string") return codePoints(value).length
  if (Array.isArray(value)) return value.reduce((total, item) => total + decisionPacketCodePointLength(item), 0)
  if (!value || typeof value !== "object") return 0
  return Object.values(value).reduce((total, item) => total + decisionPacketCodePointLength(item), 0)
}

function concise(value, limit = MAX_STATEMENT_CODE_POINTS) {
  const points = codePoints(value.trim())
  return points.length <= limit ? points.join("") : `${points.slice(0, limit - 1).join("")}…`
}

function boundedRef(value, limit = MAX_REF_CODE_POINTS) {
  return typeof value === "string" && codePoints(value).length <= limit ? value : null
}

function reportClaim(entry) {
  const summary = entry.report?.summary
  if (typeof summary !== "string" || summary.trim() === "") return null
  return {
    authorRef: `assignment:${entry.assignment.assignmentId}`,
    statement: concise(summary),
    evidenceRefs: [...new Set([
      ...(entry.report.evidenceRefs ?? []),
      ...(entry.report.findings ?? []).flatMap(({ evidenceRefs }) => evidenceRefs ?? []),
      ...(entry.report.verdict?.evidenceRefs ?? []),
    ])].map((ref) => boundedRef(ref)).filter(Boolean).slice(0, 4),
  }
}

function rosterEntry({ assignment, report }) {
  const attempt = assignment.attempts.at(-1)
  return {
    memberRef: `assignment:${assignment.assignmentId}`,
    role: assignment.teamRole,
    assignmentKind: assignment.assignmentKind,
    tier: assignment.costTier,
    ...(assignment.execution?.agentId ? { modelLabel: concise(assignment.execution.agentId, 80) } : {}),
    status: report?.recommendation === "rework" ? "要求返工" : assignment.status,
  }
}

function roundProjection(state, reports) {
  const unresolved = reports.flatMap(({ assignment, report }) => (
    report.recommendation === "rework" || (assignment.teamRole === "expert" && report.verdict?.outcome !== "accept")
      ? [concise(report.summary, 240)]
      : []
  ))
  const resolved = reports.flatMap(({ report }) => report.recommendation === "accept" ? [concise(report.summary, 240)] : [])
  return {
    round: state.currentStageRun.round,
    outcome: unresolved.length > 0 ? "存在待处理分歧" : "团队复核已完成",
    resolved: resolved.slice(0, MAX_CLAIMS),
    unresolved: unresolved.slice(0, MAX_CLAIMS),
  }
}

function packetVersion(state) {
  return state.revision + 1
}

export function composeDecisionPacket({ taskState, decision, reports = [] } = {}) {
  if (!taskState || !decision || !Array.isArray(decision.artifactRefs) || !Array.isArray(decision.choices)) {
    throw new TypeError("DecisionPacket requires task state, decision, artifacts, and choices")
  }
  const artifactIds = new Set(decision.artifactRefs)
  const sourceArtifacts = taskState.artifacts
    .filter(({ artifactId }) => artifactIds.has(artifactId))
  if (sourceArtifacts.length === 0) throw new TypeError("DecisionPacket requires at least one registered decision artifact")
  const artifactRefs = sourceArtifacts
    .map(({ path }) => boundedRef(path, MAX_PATH_CODE_POINTS))
    .filter(Boolean)
    .slice(-MAX_ARTIFACTS)

  const relevantReports = reports
    .filter(({ assignment, report }) => assignment?.attempts?.at(-1)?.stageRunId === taskState.currentStageRun.stageRunId && report)
    .slice(-MAX_ROSTER)
  const roster = relevantReports.map(rosterEntry)
  const claims = relevantReports.map(reportClaim).filter(Boolean).slice(-MAX_CLAIMS)
  const previousRounds = taskState.stageRuns
    .filter(({ stage }) => stage === taskState.currentStageRun.stage)
    .slice(-(MAX_ROUNDS - 1))
    .map(({ round, status, reason }) => ({
      round,
      outcome: status,
      resolved: status === "completed" ? [concise(reason ?? "该轮已完成", 240)] : [],
      unresolved: status === "rework" ? [concise(reason ?? "该轮要求返工", 240)] : [],
    }))
  const choices = decision.choices.map((value) => ({ value, label: CHOICE_LABELS[value] ?? value }))
  const sourceFacts = {
    taskId: taskState.taskId,
    stageRunId: taskState.currentStageRun.stageRunId,
    decisionId: decision.decisionId,
    question: decision.question,
    reports: reports.map(({ assignment, report }) => ({
      assignmentId: assignment.assignmentId,
      role: assignment.teamRole,
      summary: report.summary,
      evidenceRefs: report.evidenceRefs ?? [],
      findings: report.findings ?? [],
      verdict: report.verdict ?? null,
    })),
    artifacts: sourceArtifacts,
    choices: decision.choices,
  }
  const facts = {
    taskId: taskState.taskId,
    stageRunId: taskState.currentStageRun.stageRunId,
    decisionId: decision.decisionId,
    question: concise(decision.question, 600),
    roster,
    claims,
    rounds: [...previousRounds, roundProjection(taskState, relevantReports)].slice(-MAX_ROUNDS),
    artifactRefs,
    choices,
  }
  const factsDigest = digestValue(sourceFacts)
  const version = packetVersion(taskState)
  const packet = {
    packetId: `decision-${digestValue({ decisionId: decision.decisionId, version, factsDigest }).slice(0, 24)}`,
    version,
    factsDigest,
    question: facts.question,
    stage: taskState.currentStageRun.stage,
    roster,
    claims,
    rounds: facts.rounds,
    artifactRefs,
    choices,
  }
  while (decisionPacketCodePointLength(packet) > MAX_VISIBLE_CODE_POINTS && packet.claims.length > 0) packet.claims.pop()
  while (decisionPacketCodePointLength(packet) > MAX_VISIBLE_CODE_POINTS && packet.roster.length > 0) packet.roster.pop()
  while (decisionPacketCodePointLength(packet) > MAX_VISIBLE_CODE_POINTS && packet.artifactRefs.length > 0) packet.artifactRefs.pop()
  if (decisionPacketCodePointLength(packet) > MAX_VISIBLE_CODE_POINTS) {
    packet.rounds = packet.rounds.slice(-1).map((round) => ({ ...round, resolved: [], unresolved: [] }))
  }
  return validateContract("https://team-work-runtime.dev/schemas/v2/decision-packet", packet, "decision packet")
}

export function decisionPacketRef(taskId, packetId) {
  return `.team-work/tasks/${taskId}/packets/${packetId}.json`
}
