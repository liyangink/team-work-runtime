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

const MARKER_REPAIR_HINTS = {
  PROJECT_MARKER_MISSING: "inspect 是只读命令，不会自动修复；通过工作流入口（workflow_open）打开任务时项目标记会自动初始化。",
  RUNTIME_MAJOR_MISMATCH: ".team-work/project.json 属于其他 Runtime 主版本；确认来源后备份并移除，v2 才能重建标记。",
  PATH_ESCAPE: ".team-work 必须是真实目录；移除占位的符号链接或文件后再触发工作流。",
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
    const repair = MARKER_REPAIR_HINTS[error.code]
    writeError(`${JSON.stringify({ ok: false, code: error.code ?? "RUNTIME_ERROR", message: error.message, ...(repair ? { repair } : {}) }, null, 2)}\n`)
    return 1
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await runRuntimeCli(process.argv.slice(2))
}
