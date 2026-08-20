import { lstat, mkdir, realpath } from "node:fs/promises"
import path from "node:path"

import { artifactIdentity } from "../domain/artifact-reference.mjs"
import { atomicWrite } from "../persistence/transactions.mjs"

const roleLabels = { owner: "Owner", challenger: "Challenger", expert: "Expert" }

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function list(values) {
  return values?.length ? values.map((value) => `- ${value}`).join("\n") : "- 无"
}

function referenceList(state, refs, suggestedPaths = new Map()) {
  return list(refs.map((ref) => {
    if (!ref.startsWith("artifact:")) return ref
    const artifact = state.artifacts.find(({ artifactId }) => artifactId === artifactIdentity(ref).artifactId)
    const suggested = suggestedPaths.get(ref)
    return artifact ? `${ref} → ${artifact.path}` : suggested ? `${ref} → ${suggested}` : `${ref}（本轮待产出；由 Owner 按项目结构选定路径）`
  }))
}

function clip(value, limit) {
  const text = typeof value === "string" ? value.trim() : ""
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

function acceptedReviewDependencies(state, assignment) {
  if (!assignment.execution.resumeAssignmentId) return []
  return assignment.dependsOn.flatMap((dependencyId) => {
    const dependency = state.workGraph.assignments.find(({ assignmentId }) => assignmentId === dependencyId)
    if (!dependency || !["challenger", "expert"].includes(dependency.teamRole)) return []
    const attempt = dependency.attempts.at(-1)
    if (dependency.status !== "accepted" || attempt?.status !== "accepted" || !attempt.reportRef) return []
    return [{ role: roleLabels[dependency.teamRole], ref: `report:${attempt.reportRef}`, reportId: attempt.reportRef }]
  })
}

function renderReviewReport(entry, record) {
  const report = record?.report ?? {}
  const lines = [
    `### ${entry.role} · ${entry.ref}`,
    "",
    `结论：${clip(report.summary, 900) || "未提供摘要"}`,
    ...(report.recommendation ? [`建议：${report.recommendation}`] : []),
    ...(report.findings?.slice(0, 8).map(({ severity, statement }) => `- ${severity}: ${clip(statement, 320)}`) ?? []),
    ...(report.verdict ? [
      `裁决：${report.verdict.outcome}`,
      `依据：${clip(report.verdict.rationale, 700)}`,
      `建议动作：${clip(report.verdict.recommendedAction, 400)}`,
    ] : []),
  ]
  return clip(lines.join("\n"), 2_200)
}

function planningProposalRef(state) {
  return `artifact:stage-plan-proposal:${state.currentStageRun.stageRunId}`
}

function planningProposalPath(state) {
  return `.team-work/tasks/${state.taskId}/deliverables/stage-plan-proposal-${state.currentStageRun.stageRunId}.json`
}

function planningInstructions(state, assignment) {
  if (assignment.assignmentKind !== "planning" || !assignment.writableRefs.includes(planningProposalRef(state))) return []
  return [
    "",
    "## 规划提案格式",
    "",
    "只写入上述唯一制品路径。JSON 只需包含 `integrationRequired` 与 `workPackages`；无需填写 `proposalId`、`stageRunId`、`stage` 或 `digest`，Runtime 会补齐并校验。",
    "",
    "每个 work package 必须包含：`packageId`、`objective`、`inputRefs`、`outputRefs`、`completionCriteria`、`dependsOn`；引用使用 `artifact:<名称>`。拓扑和集成要求以本次派单的完成条件为准。",
    "",
    "`inputRefs` 与 `outputRefs` 只写逻辑引用，不写文件路径。修改已有文件时必须复用可读引用中的原 artifact ref，禁止另建别名。规划 Owner 只拆分工作，不执行审查、修改或测试。",
    "",
    "不要读取 `.team-work` 中的 state、events、bindings 或 operations 来猜测流程；本派单已经给出了全部必需输入、输出路径和完成条件。",
  ]
}

function assignmentBrief(state, assignment) {
  if (state.preflight?.status === "active") {
    if (assignment.assignmentKind === "planning" && assignment.teamRole === "owner" && !assignment.execution.resumeAssignmentId) {
      return {
        objective: `为 ${state.currentStageRun.stage} 阶段产出可执行的工作包提案`,
        boundary: "只规划工作包、依赖、输出与验收条件；不得把产品中待审查的问题当作提案失败，也不得提前执行后续工作包。",
      }
    }
    if (assignment.teamRole === "challenger") {
      return {
        objective: `挑战 ${state.currentStageRun.stage} 阶段规划提案的完整性与可执行性`,
        boundary: "审查对象是规划提案是否覆盖目标、视角、依赖、成本、输出和失败路径；产品本身存在待审问题是计划输入，不等于提案不通过。",
      }
    }
    if (assignment.teamRole === "expert") {
      return {
        objective: `对 ${state.currentStageRun.stage} 阶段规划提案作独立技术裁决`,
        boundary: "裁决提案能否可靠驱动后续执行；不要把尚待执行包解决的产品问题误判为规划缺陷。",
      }
    }
    if (assignment.execution.resumeAssignmentId) {
      return {
        objective: "核验 Challenger 与 Expert 对规划提案的意见并作有证据的回应",
        boundary: "只判断提案是否需要修订；接受或反驳评审意见时必须引用对应报告，不执行后续产品工作。",
      }
    }
  }
  if (assignment.teamRole === "challenger") {
    return {
      objective: state.taskIntent?.objective ?? state.objective ?? state.title,
      boundary: "recommendation 只评价 Owner 本轮制品是否正确、完整且满足任务，不评价被审查产品本身是否无缺陷。若只读审查制品已准确记录产品缺陷、风险和待决策项，应选择 accept；只有制品遗漏、失实或不可推进时才选择 rework。",
    }
  }
  if (assignment.teamRole === "expert") {
    return {
      objective: state.taskIntent?.objective ?? state.objective ?? state.title,
      boundary: "verdict 与 recommendation 只裁决本轮制品及其证据链是否可靠；被审查产品存在缺陷或契约待确认，不等于审查制品必须返工。",
    }
  }
  if (assignment.execution.resumeAssignmentId) {
    return {
      objective: "核验 Challenger 与 Expert 对本轮制品的意见并作有证据的回应",
      boundary: "逐条核验已接收报告；接受或反驳时必须引用对应 report 引用，只在制品确有缺口时建议返工。",
    }
  }
  return { objective: state.taskIntent?.objective ?? state.objective ?? state.title }
}

async function ensureOwnedDirectory(taskRoot, name) {
  const target = path.join(taskRoot, name)
  await mkdir(target, { recursive: true })
  const metadata = await lstat(target)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw fail("CONTEXT_PATH_INVALID", `${name} must be a Runtime-owned directory`)
  return target
}

function expectedRef(taskId, directory, assignmentId) {
  return `.team-work/tasks/${taskId}/${directory}/${assignmentId}.md`
}

export function createFileContextComposer({ projectRoot, store, roleGuides = {} } = {}) {
  if (typeof projectRoot !== "string" || projectRoot === "") throw new TypeError("projectRoot is required")
  if (!store || typeof store.loadTask !== "function") throw new TypeError("Context Composer requires a Store")

  return Object.freeze({
    async prepare({ taskId, assignmentId }) {
      const state = await store.loadTask(taskId)
      const assignment = state.workGraph.assignments.find((entry) => entry.assignmentId === assignmentId)
      if (!assignment?.execution) throw fail("ASSIGNMENT_UNKNOWN", `cannot compose context for ${assignmentId}`)
      const contextRef = expectedRef(taskId, "context", assignmentId)
      const promptRef = expectedRef(taskId, "prompts", assignmentId)
      if (assignment.execution.contextRef !== contextRef || assignment.execution.promptRef !== promptRef) {
        throw fail("CONTEXT_PATH_INVALID", `assignment ${assignmentId} does not use its Runtime-owned context paths`)
      }
      const root = await realpath(path.resolve(projectRoot))
      const taskRoot = await realpath(path.join(root, ".team-work", "tasks", taskId))
      const relative = path.relative(root, taskRoot)
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw fail("CONTEXT_PATH_INVALID", "task context root escapes the project")
      const [contextDirectory, promptDirectory] = await Promise.all([
        ensureOwnedDirectory(taskRoot, "context"),
        ensureOwnedDirectory(taskRoot, "prompts"),
        ensureOwnedDirectory(taskRoot, "deliverables"),
      ])
      const role = roleLabels[assignment.teamRole] ?? assignment.teamRole
      const guide = roleGuides[assignment.teamRole] ?? "只处理本派单范围，依据事实交付，不替 Lead 推进流程。"
      const acceptedReviews = acceptedReviewDependencies(state, assignment)
      const acceptedReviewContext = await Promise.all(acceptedReviews.map(async (entry) => {
        if (typeof store.loadRecord !== "function") return `### ${entry.role} · ${entry.ref}`
        return renderReviewReport(entry, await store.loadRecord(taskId, "report", entry.reportId))
      }))
      const suggestedPaths = new Map()
      if (assignment.assignmentKind === "planning" && assignment.writableRefs.includes(planningProposalRef(state))) {
        suggestedPaths.set(planningProposalRef(state), planningProposalPath(state))
      }
      const context = [
        "# 受管成员上下文",
        "",
        `- 任务：${state.title}`,
        `- 阶段：${state.currentStageRun.stage}`,
        `- 角色：${role}`,
        `- Agent：${assignment.execution.agentId}`,
        `- Assignment：${assignment.assignmentId}`,
        "",
        "## 任务约束",
        "",
        list(state.taskIntent?.constraints),
        "",
        "## 排除项",
        "",
        list(state.taskIntent?.exclusions),
        "",
        "## 可读引用",
        "",
        referenceList(state, [...assignment.readableRefs, ...acceptedReviews.map(({ ref }) => ref)]),
        ...(acceptedReviewContext.length ? [
          "",
          "## 已接收审查结论",
          "",
          acceptedReviewContext.join("\n\n"),
        ] : []),
        "",
        "## 可写引用",
        "",
        referenceList(state, assignment.writableRefs, suggestedPaths),
        "",
        "## 角色规则",
        "",
        guide.trim(),
        "",
        "派单消息已经内嵌本上下文与本轮提示全文；不要再次读取 contextRef、promptRef 或 `.team-work` 中的对应文件，也不要对 `.team-work`、项目外路径或文件系统根目录执行 glob/search。",
        "只读取完成任务所需的引用和项目文件；除本派单明确列出的可读/可写制品外，禁止读取 `.team-work` 内部的 state、events、operations、bindings、packets 或其他运行状态，也不要自行复算、比较或猜测 Runtime 摘要。Runtime 负责状态、摘要与制品完整性校验；发现产品文件疑似变化时在报告中陈述事实即可。不要复制完整历史会话。",
      ].join("\n")
      const brief = assignmentBrief(state, assignment)
      const prompt = [
        "# 本轮派单",
        "",
        `目标：${brief.objective}`,
        ...(brief.boundary ? ["", "## 本轮边界", "", brief.boundary] : []),
        "",
        "## 完成条件",
        "",
        list(assignment.completionCriteria),
        ...(acceptedReviews.length ? [
          "",
          `回应时必须在 \`evidence_refs\` 中逐一引用：${acceptedReviews.map(({ ref }) => ref).join("、")}。`,
        ] : []),
        ...planningInstructions(state, assignment),
        "",
        "`recommendation` 只评价当前派单交付是否已正确、完整并满足完成条件：交付合格填 `accept`，只有本轮制品或结论必须重做时填 `rework`。产品代码存在缺陷、风险或待决策项应写入 findings/unresolved；在只读审查任务中，准确记录这些问题后仍应填 `accept`。",
        "",
        "完成后先自检，再调用 `team_work_report` 提交结构化结论、制品路径和证据；`evidence_refs` 只能使用派单中已有的 artifact 引用、自己的输出引用或已接收的 report/check 引用，不能填写说明文字；没有稳定证据引用时省略 check 的 evidence_ref。只有 Expert 填写 verdict，Owner 与 Challenger 必须省略。不要重复读取派单上下文，也不要等待 Lead 轮询。",
      ].join("\n")
      if (context.length + prompt.length > 12_000) throw fail("CONTEXT_BUDGET_EXCEEDED", "member context exceeds the bounded projection budget")
      await Promise.all([
        atomicWrite(path.join(contextDirectory, `${assignmentId}.md`), `${context}\n`),
        atomicWrite(path.join(promptDirectory, `${assignmentId}.md`), `${prompt}\n`),
      ])
      return { contextRef, promptRef }
    },
  })
}
