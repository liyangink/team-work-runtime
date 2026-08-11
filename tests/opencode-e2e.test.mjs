import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { executeRuntime } from "../runtime/core.mjs"
import { createOpenCodeAdapter } from "../plugins/opencode/src/opencode-adapter.mjs"
import { manageOpenCodePlugin } from "../plugins/opencode/src/lifecycle.mjs"

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const modelMap = {
  "junior-flash": "gateway/deepseek-v4-flash",
  "junior-luna": "gateway/gpt-5.6-luna",
  "senior-terra": "gateway/gpt-5.6-terra",
  "senior-glm": "gateway/glm-5.2",
  "senior-qwen": "gateway/qwen3.8-max",
  "expert-opus": "official/claude-opus-5",
  "expert-k3": "gateway/kimi-k3",
}

function lifecycleOptions(projectRoot) {
  return {
    projectRoot,
    sourceRoot,
    hostVersion: "1.18.15",
    modelMap,
    skipDependencies: true,
    openspecCommand: path.join(projectRoot, "missing-openspec"),
  }
}

test("lifecycle, adapter, and Runtime integration survives a gateway fault without corrupting task state", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "team-work-opencode-e2e-"))
  await manageOpenCodePlugin("install", lifecycleOptions(projectRoot))
  await writeFile(path.join(projectRoot, "result.md"), "pending\n")

  const run = (request) => executeRuntime({ ...request, projectRoot })
  assert.equal((await run({ command: "task.create", input: { taskId: "gateway-recovery", entryStage: "implementation" } })).exitCode, 0)
  assert.equal((await run({
    command: "task.team",
    input: { taskId: "gateway-recovery", mode: "team", reason: "并行实现并独立挑战", expectedRevision: 0 },
  })).exitCode, 0)
  assert.equal((await run({
    command: "work.create",
    input: {
      taskId: "gateway-recovery",
      workItemId: "impl-1",
      owner: "junior-luna",
      scope: "实现指定范围",
      doneWhen: ["产出实现与证据"],
      artifactPaths: ["result.md"],
      expectedRevision: 1,
    },
  })).exitCode, 0)

  let gatewayAvailable = false
  const calls = []
  const client = {
    session: {
      async create(input) {
        calls.push(["create", input])
        return { data: { id: "child-e2e" } }
      },
      async promptAsync(input) {
        calls.push(["promptAsync", input])
        if (!gatewayAvailable) throw new TypeError("gateway capacity exhausted")
        return { data: undefined }
      },
      async prompt() {
        calls.push(["prompt"])
        throw new Error("blocking dispatch is forbidden")
      },
    },
  }
  const adapter = createOpenCodeAdapter({ client, projectRoot, runtimeExecutor: run })

  await assert.rejects(
    adapter.spawn({
      taskId: "gateway-recovery",
      workItemId: "impl-1",
      parentSessionId: "lead-e2e",
      agent: "junior-luna",
      contextProfile: "implement",
      prompt: "后台执行实现任务",
    }),
    (error) => error.code === "OPENCODE_API_ERROR" && error.retryable,
  )
  gatewayAvailable = true
  const resumed = await adapter.resume({ taskId: "gateway-recovery", workItemId: "impl-1", prompt: "网关恢复，继续原任务" })
  assert.equal(resumed.mode, "background")
  assert.equal(resumed.sessionId, "child-e2e")
  assert.equal(calls.some(([name]) => name === "prompt"), false)

  const context = await adapter.contextForSession("child-e2e")
  assert.match(context, /profile: implement/)
  await adapter.handleEvent({ type: "session.deleted", properties: { info: { id: "child-e2e" } } })

  const task = (await run({ command: "task.show", input: { taskId: "gateway-recovery" } })).envelope.data.task
  const workItem = (await run({ command: "work.show", input: { taskId: "gateway-recovery", workItemId: "impl-1" } })).envelope.data.workItem
  const events = (await run({ command: "event.list", input: { taskId: "gateway-recovery" } })).envelope.data.events
  assert.equal(task.status, "active")
  assert.equal(task.revision, 2)
  assert.equal(workItem.status, "queued")
  assert.deepEqual(events.map(({ type }) => type), [
    "task.team-decided",
    "work.created",
    "platform.dispatch.failed",
    "platform.resume.accepted",
    "platform.session.lost",
  ])

  const mapping = JSON.parse(await readFile(path.join(projectRoot, ".team-work/platform/opencode/sessions/gateway-recovery/impl-1.json"), "utf8"))
  assert.equal(mapping.sessionId, "child-e2e")
  assert.ok(mapping.lostRecordedAt)

  const removed = await manageOpenCodePlugin("uninstall", lifecycleOptions(projectRoot))
  assert.equal(removed.status, "uninstalled")
  assert.equal((await run({ command: "task.show", input: { taskId: "gateway-recovery" } })).exitCode, 0)
})
