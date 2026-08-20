import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { createFileContextComposer } from "../../../runtime/application/context-composer.mjs"
async function setup() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-context-"))
  await mkdir(path.join(projectRoot, ".team-work", "tasks", "context-task"), { recursive: true })
  await writeFile(path.join(projectRoot, ".team-work", "project.json"), `${JSON.stringify({ runtimeMajor: 2, schemaVersion: "2.0" })}\n`)
  const state = {
    taskId: "context-task",
    title: "Prepare bounded member context",
    objective: "Implement without copying full artifacts",
    currentStageRun: { stageRunId: "stage-run-1", stage: "implementation" },
    artifacts: [{ artifactId: "requirement", kind: "requirement", path: "requirements/task.md", digest: "a".repeat(64) }],
    workGraph: { assignments: [{
      assignmentId: "owner-1",
      teamRole: "owner",
      assignmentKind: "implementation",
      costTier: "junior",
      dependsOn: [],
      readableRefs: ["artifact:requirement"],
      writableRefs: ["artifact:source"],
      completionCriteria: ["produce the requested source change", "run focused tests"],
      execution: {
        agentId: "junior-luna",
        capabilitySnapshotDigest: "b".repeat(64),
        contextRef: ".team-work/tasks/context-task/context/owner-1.md",
        promptRef: ".team-work/tasks/context-task/prompts/owner-1.md",
      },
      status: "planned",
      attempts: [],
    }] },
  }
  return { projectRoot, store: { loadTask: async () => structuredClone(state) } }
}

test("the context composer materializes bounded role context at Runtime-owned refs", async () => {
  const { projectRoot, store } = await setup()
  const composer = createFileContextComposer({ projectRoot, store, roleGuides: { owner: "核验事实并完成自己的范围。" } })
  const result = await composer.prepare({ taskId: "context-task", assignmentId: "owner-1" })

  assert.deepEqual(result, {
    contextRef: ".team-work/tasks/context-task/context/owner-1.md",
    promptRef: ".team-work/tasks/context-task/prompts/owner-1.md",
  })
  const context = await readFile(path.join(projectRoot, result.contextRef), "utf8")
  const prompt = await readFile(path.join(projectRoot, result.promptRef), "utf8")
  assert.match(context, /角色：Owner/)
  assert.match(context, /## 任务约束/)
  assert.match(context, /## 排除项/)
  assert.match(context, /禁止读取 `\.team-work` 内部的 state、events、operations、bindings、packets/)
  assert.match(context, /不要再次读取 contextRef、promptRef/)
  assert.match(context, /文件系统根目录执行 glob\/search/)
  assert.match(context, /不要自行复算、比较或猜测 Runtime 摘要/)
  assert.match(context, /artifact:requirement/)
  assert.match(context, /artifact:requirement → requirements\/task\.md/)
  assert.match(context, /artifact:source（本轮待产出；由 Owner 按项目结构选定路径）/)
  assert.match(prompt, /produce the requested source change/)
  assert.match(prompt, /recommendation.*只评价当前派单交付/)
  assert.match(prompt, /只读审查任务中.*仍应填 `accept`/)
  assert.match(prompt, /team_work_report/)
  assert.ok(context.length + prompt.length < 5_000)
})

test("a planning Owner receives one concrete proposal path and a compact data contract", async () => {
  const { projectRoot, store } = await setup()
  const state = await store.loadTask("context-task")
  state.currentStageRun.stage = "code-review"
  state.taskIntent = { objective: "Review and fix divide-by-zero", preferences: { execution: "team" } }
  state.workGraph.assignments[0].assignmentKind = "planning"
  state.workGraph.assignments[0].writableRefs = ["artifact:stage-plan-proposal:stage-run-1"]
  state.workGraph.assignments[0].completionCriteria.push("define at least two independent work packages")
  const composer = createFileContextComposer({ projectRoot, store: { loadTask: async () => structuredClone(state) } })

  const result = await composer.prepare({ taskId: "context-task", assignmentId: "owner-1" })
  const context = await readFile(path.join(projectRoot, result.contextRef), "utf8")
  const prompt = await readFile(path.join(projectRoot, result.promptRef), "utf8")

  assert.match(context, /artifact:stage-plan-proposal:stage-run-1 → \.team-work\/tasks\/context-task\/deliverables\/stage-plan-proposal-stage-run-1\.json/)
  assert.match(prompt, /只写入上述唯一制品路径/)
  assert.match(prompt, /workPackages/)
  assert.match(prompt, /define at least two independent work packages/)
  assert.match(prompt, /拓扑和集成要求以本次派单的完成条件为准/)
  assert.match(prompt, /无需填写.*proposalId.*stageRunId.*stage.*digest/s)
  assert.match(prompt, /规划 Owner 只拆分工作，不执行审查、修改或测试/)
  assert.match(prompt, /不要读取 `\.team-work` 中的 state、events、bindings 或 operations/)
  assert.ok(context.length + prompt.length < 6_000)
})

test("preflight reviewers are explicitly scoped to the proposal rather than the product work", async () => {
  const { projectRoot, store } = await setup()
  const state = await store.loadTask("context-task")
  state.currentStageRun.stage = "code-review"
  state.preflight = { status: "active", kind: "planning-bootstrap" }
  state.workGraph.assignments[0] = {
    ...state.workGraph.assignments[0],
    assignmentId: "challenger-1",
    teamRole: "challenger",
    assignmentKind: "review",
    writableRefs: [],
    execution: {
      ...state.workGraph.assignments[0].execution,
      contextRef: ".team-work/tasks/context-task/context/challenger-1.md",
      promptRef: ".team-work/tasks/context-task/prompts/challenger-1.md",
    },
  }
  const composer = createFileContextComposer({ projectRoot, store: { loadTask: async () => structuredClone(state) } })

  const result = await composer.prepare({ taskId: "context-task", assignmentId: "challenger-1" })
  const prompt = await readFile(path.join(projectRoot, result.promptRef), "utf8")

  assert.match(prompt, /审查对象是规划提案/)
  assert.match(prompt, /产品本身存在待审问题.*不等于提案不通过/)
})

test("a formal Challenger judges the delivered review rather than requiring a defect-free product", async () => {
  const { projectRoot, store } = await setup()
  const state = await store.loadTask("context-task")
  state.currentStageRun.stage = "code-review"
  state.taskIntent = { objective: "Review divide-by-zero", constraints: [], exclusions: [] }
  state.workGraph.assignments[0] = {
    ...state.workGraph.assignments[0],
    assignmentId: "challenger-formal",
    teamRole: "challenger",
    assignmentKind: "review",
    writableRefs: [],
    execution: {
      ...state.workGraph.assignments[0].execution,
      contextRef: ".team-work/tasks/context-task/context/challenger-formal.md",
      promptRef: ".team-work/tasks/context-task/prompts/challenger-formal.md",
    },
  }
  const composer = createFileContextComposer({ projectRoot, store: { loadTask: async () => structuredClone(state) } })

  const result = await composer.prepare({ taskId: "context-task", assignmentId: "challenger-formal" })
  const prompt = await readFile(path.join(projectRoot, result.promptRef), "utf8")

  assert.match(prompt, /只评价 Owner 本轮制品/)
  assert.match(prompt, /产品本身是否无缺陷/)
  assert.match(prompt, /准确记录产品缺陷.*应选择 accept/)
})

test("an Owner response receives accepted review ids and bounded conclusions", async () => {
  const { projectRoot, store } = await setup()
  const state = await store.loadTask("context-task")
  state.taskIntent = { objective: "Review divide-by-zero", constraints: [], exclusions: [] }
  const owner = state.workGraph.assignments[0]
  owner.assignmentId = "owner-response"
  owner.dependsOn = ["challenger-1", "expert-1"]
  owner.writableRefs = []
  owner.execution = {
    ...owner.execution,
    resumeAssignmentId: "owner-original",
    contextRef: ".team-work/tasks/context-task/context/owner-response.md",
    promptRef: ".team-work/tasks/context-task/prompts/owner-response.md",
  }
  state.workGraph.assignments.push(
    {
      assignmentId: "challenger-1", teamRole: "challenger", status: "accepted",
      attempts: [{ status: "accepted", reportRef: "report-challenger" }],
    },
    {
      assignmentId: "expert-1", teamRole: "expert", status: "accepted",
      attempts: [{ status: "accepted", reportRef: "report-expert" }],
    },
  )
  const reports = {
    "report-challenger": { report: { summary: "挑战者发现测试缺口。", recommendation: "accept", findings: [{ severity: "risk", statement: "除零分支未测试。" }] } },
    "report-expert": { report: { summary: "专家独立核验通过。", recommendation: "accept", verdict: { outcome: "accept", rationale: "代码事实支持审查结论。", recommendedAction: "接受并记录风险。" } } },
  }
  const composer = createFileContextComposer({
    projectRoot,
    store: {
      loadTask: async () => structuredClone(state),
      loadRecord: async (_taskId, kind, reportId) => {
        assert.equal(kind, "report")
        return structuredClone(reports[reportId])
      },
    },
  })

  const result = await composer.prepare({ taskId: "context-task", assignmentId: "owner-response" })
  const context = await readFile(path.join(projectRoot, result.contextRef), "utf8")
  const prompt = await readFile(path.join(projectRoot, result.promptRef), "utf8")

  assert.match(context, /report:report-challenger/)
  assert.match(context, /挑战者发现测试缺口/)
  assert.match(context, /report:report-expert/)
  assert.match(context, /专家独立核验通过/)
  assert.match(prompt, /evidence_refs.*report:report-challenger、report:report-expert/)
  assert.ok(context.length + prompt.length < 12_000)
})

test("the context composer refuses refs outside its current task directories", async () => {
  const { projectRoot, store } = await setup()
  const state = await store.loadTask("context-task")
  state.workGraph.assignments[0].execution.contextRef = "README.md"
  const unsafeStore = { ...store, loadTask: async () => state }
  const composer = createFileContextComposer({ projectRoot, store: unsafeStore })
  await assert.rejects(composer.prepare({ taskId: "context-task", assignmentId: "owner-1" }), (error) => error.code === "CONTEXT_PATH_INVALID")
})
