import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { manageOpenCodePlugin } from "../plugins/opencode/src/lifecycle.mjs"
import { loadUserConfig } from "./user-config.mjs"

export const LIFECYCLE_COMMANDS = new Set(["install", "update", "doctor", "uninstall"])
const DEFAULT_SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function parse(argv) {
  const command = argv[0]
  if (!LIFECYCLE_COMMANDS.has(command)) throw Object.assign(new Error(`未知安装器命令：${command ?? "<empty>"}`), { code: "INVALID_COMMAND" })
  const options = { force: false }
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === "--force") options.force = true
    else {
      throw Object.assign(new Error(`未知参数：${token}`), { code: "INVALID_ARGUMENT" })
    }
  }
  return { command, options }
}

export async function runInstallerCli(argv, dependencies = {}) {
  const manage = dependencies.manage ?? manageOpenCodePlugin
  const writeOut = dependencies.writeOut ?? ((text) => process.stdout.write(text))
  const writeError = dependencies.writeError ?? ((text) => process.stderr.write(text))
  const sourceRoot = dependencies.sourceRoot ?? DEFAULT_SOURCE_ROOT
  const configBase = dependencies.configBase
    ?? process.env.XDG_CONFIG_HOME
    ?? path.join(dependencies.homeDir ?? os.homedir(), ".config")
  const configRoot = path.resolve(dependencies.configRoot ?? path.join(configBase, "team-work"))
  const opencodeRoot = path.resolve(dependencies.opencodeRoot ?? path.join(configBase, "opencode"))

  try {
    const { command, options } = parse(argv)
    let platform = {
      modelMap: undefined,
      effortMap: undefined,
      opencodeCommand: "opencode",
      openspecCommand: "openspec",
    }
    if (command !== "uninstall") {
      const loaded = await loadUserConfig({
        configRoot,
        createIfMissing: command === "install",
      })
      platform = loaded.platform
    }
    const result = await manage(command, {
      installRoot: opencodeRoot,
      sourceRoot,
      modelMap: platform.modelMap,
      effortMap: platform.effortMap,
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
