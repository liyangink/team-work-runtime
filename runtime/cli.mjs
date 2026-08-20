#!/usr/bin/env node

import { pathToFileURL } from "node:url"

import { createFileStore } from "./persistence/file-store.mjs"
import { assertProjectRuntimeMajor, RUNTIME_MAJOR } from "./version.mjs"

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

export function parseRuntimeArgs(argv) {
  const command = argv[0]
  if (!["version", "inspect"].includes(command)) throw fail("INVALID_COMMAND", `未知 Runtime 诊断命令：${command ?? "<empty>"}`)
  const options = { projectRoot: process.cwd() }
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === "--project") options.projectRoot = argv[++index]
    else if (token === "--task") options.taskId = argv[++index]
    else throw fail("INVALID_ARGUMENT", `未知参数：${token}`)
  }
  if (command === "inspect" && !options.taskId) throw fail("TASK_SELECTION_REQUIRED", "inspect 需要 --task <task-id>")
  return { command, ...options }
}

function projection(state) {
  return {
    taskId: state.taskId,
    title: state.title,
    status: state.status,
    stage: state.currentStageRun.stage,
    revision: state.revision,
    artifacts: state.artifacts.map(({ kind, path, digest }) => ({ kind, path, digest })),
    team: state.workGraph.assignments.map(({ assignmentId, teamRole, costTier, status }) => ({ assignmentId, teamRole, costTier, status })),
  }
}

export async function runRuntimeCli(argv, dependencies = {}) {
  const writeOut = dependencies.writeOut ?? ((text) => process.stdout.write(text))
  const writeError = dependencies.writeError ?? ((text) => process.stderr.write(text))
  try {
    const input = parseRuntimeArgs(argv)
    let data
    if (input.command === "version") {
      data = { runtimeMajor: RUNTIME_MAJOR, schemaVersion: "2.0" }
    } else {
      await assertProjectRuntimeMajor(input.projectRoot)
      data = projection(await (dependencies.store ?? createFileStore({ projectRoot: input.projectRoot })).loadTask(input.taskId))
    }
    writeOut(`${JSON.stringify({ ok: true, data }, null, 2)}\n`)
    return 0
  } catch (error) {
    writeError(`${JSON.stringify({ ok: false, code: error.code ?? "RUNTIME_ERROR", message: error.message })}\n`)
    return 1
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await runRuntimeCli(process.argv.slice(2))
}
