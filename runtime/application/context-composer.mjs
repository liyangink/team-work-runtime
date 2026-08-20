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

function referenceList(state, refs) {
  return list(refs.map((ref) => {
    if (!ref.startsWith("artifact:")) return ref
    const artifact = state.artifacts.find(({ artifactId }) => artifactId === artifactIdentity(ref).artifactId)
    return artifact ? `${ref} → ${artifact.path}` : `${ref}（本轮待产出）`
  }))
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
      ])
      const role = roleLabels[assignment.teamRole] ?? assignment.teamRole
      const guide = roleGuides[assignment.teamRole] ?? "只处理本派单范围，依据事实交付，不替 Lead 推进流程。"
      const context = [
        "# 受管成员上下文",
        "",
        `- 任务：${state.title}`,
        `- 阶段：${state.currentStageRun.stage}`,
        `- 角色：${role}`,
        `- Agent：${assignment.execution.agentId}`,
        `- Assignment：${assignment.assignmentId}`,
        "",
        "## 可读引用",
        "",
        referenceList(state, assignment.readableRefs),
        "",
        "## 可写引用",
        "",
        referenceList(state, assignment.writableRefs),
        "",
        "## 角色规则",
        "",
        guide.trim(),
        "",
        "只读取完成任务所需的引用和项目文件；不要复制完整历史会话。",
      ].join("\n")
      const objective = state.taskIntent?.objective ?? state.objective ?? state.title
      const prompt = [
        "# 本轮派单",
        "",
        `目标：${objective}`,
        "",
        "## 完成条件",
        "",
        list(assignment.completionCriteria),
        "",
        "完成后先自检，再调用 `team_work_report` 提交结构化结论、制品路径和证据；不要等待 Lead 轮询。",
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
