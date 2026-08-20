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
  assert.match(context, /artifact:requirement/)
  assert.match(context, /artifact:requirement → requirements\/task\.md/)
  assert.match(context, /artifact:source（本轮待产出）/)
  assert.match(prompt, /produce the requested source change/)
  assert.match(prompt, /team_work_report/)
  assert.ok(context.length + prompt.length < 5_000)
})

test("the context composer refuses refs outside its current task directories", async () => {
  const { projectRoot, store } = await setup()
  const state = await store.loadTask("context-task")
  state.workGraph.assignments[0].execution.contextRef = "README.md"
  const unsafeStore = { ...store, loadTask: async () => state }
  const composer = createFileContextComposer({ projectRoot, store: unsafeStore })
  await assert.rejects(composer.prepare({ taskId: "context-task", assignmentId: "owner-1" }), (error) => error.code === "CONTEXT_PATH_INVALID")
})
