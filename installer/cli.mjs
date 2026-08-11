import path from "node:path"
import { fileURLToPath } from "node:url"

import { manageOpenCodePlugin } from "../plugins/opencode/src/lifecycle.mjs"
import { loadUserConfig } from "./user-config.mjs"

export const LIFECYCLE_COMMANDS = new Set(["install", "update", "doctor", "uninstall"])
const DEFAULT_SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function parse(argv, cwd) {
  const command = argv[0]
  if (!LIFECYCLE_COMMANDS.has(command)) throw Object.assign(new Error(`未知安装器命令：${command ?? "<empty>"}`), { code: "INVALID_COMMAND" })
  const options = { projectRoot: cwd, force: false }
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === "--force") options.force = true
    else if (token === "--project") {
      const value = argv[++index]
      if (!value || value.startsWith("--")) throw Object.assign(new Error("--project 需要路径"), { code: "INVALID_ARGUMENT" })
      options.projectRoot = value
    } else {
      throw Object.assign(new Error(`未知参数：${token}`), { code: "INVALID_ARGUMENT" })
    }
  }
  options.projectRoot = path.resolve(options.projectRoot)
  return { command, options }
}

export async function runInstallerCli(argv, dependencies = {}) {
  const manage = dependencies.manage ?? manageOpenCodePlugin
  const writeOut = dependencies.writeOut ?? ((text) => process.stdout.write(text))
  const writeError = dependencies.writeError ?? ((text) => process.stderr.write(text))
  const cwd = dependencies.cwd ?? process.cwd()
  const sourceRoot = dependencies.sourceRoot ?? DEFAULT_SOURCE_ROOT

  try {
    const { command, options } = parse(argv, cwd)
    let platform = {
      modelMap: undefined,
      opencodeCommand: "opencode",
      openspecCommand: "openspec",
    }
    if (command !== "uninstall") {
      const loaded = await loadUserConfig({
        projectRoot: options.projectRoot,
        createIfMissing: command === "install",
      })
      platform = loaded.platform
    }
    const result = await manage(command, {
      projectRoot: options.projectRoot,
      sourceRoot,
      modelMap: platform.modelMap,
      opencodeCommand: platform.opencodeCommand,
      openspecCommand: platform.openspecCommand,
      force: options.force,
    })
    writeOut(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`)
    return 0
  } catch (error) {
    writeError(`${JSON.stringify({
      ok: false,
      code: error.code ?? "INSTALLER_ERROR",
      message: error.message,
      files: error.files,
    }, null, 2)}\n`)
    return 1
  }
}
