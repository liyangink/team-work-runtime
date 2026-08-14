import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { manageOpenCodePlugin } from "../plugins/opencode/src/lifecycle.mjs"
import { loadUserConfig, resolveUserConfigRoot, setOpenCodeEnabled } from "./user-config.mjs"

export const LIFECYCLE_COMMANDS = new Set(["install", "update", "doctor", "uninstall", "enable", "disable"])
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
  const env = dependencies.env ?? process.env
  const platformName = dependencies.platform ?? process.platform
  const homeDir = dependencies.homeDir ?? os.homedir()
  const configBase = dependencies.configBase
    ?? env.XDG_CONFIG_HOME
    ?? (platformName === "win32" ? env.APPDATA : undefined)
    ?? path.join(homeDir, ".config")
  const configRoot = dependencies.configRoot
    ? path.resolve(dependencies.configRoot)
    : resolveUserConfigRoot({ env, platform: platformName, homeDir })
  const opencodeRoot = path.resolve(dependencies.opencodeRoot ?? path.join(configBase, "opencode"))

  try {
    const { command, options } = parse(argv)
    if (command === "enable" || command === "disable") {
      const enabled = command === "enable"
      const changed = await setOpenCodeEnabled({ configRoot, enabled })
      writeOut(`${JSON.stringify({
        ok: true,
        status: command === "enable" ? "enabled" : "disabled",
        changed: changed.changed,
        restartRequired: true,
        configPath: changed.path,
      }, null, 2)}\n`)
      return 0
    }
    let platform = {
      modelMap: undefined,
      opencodeCommand: "opencode",
      openspecCommand: "openspec",
      specMode: "auto",
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
      platformEnabled: platform.enabled,
      modelMap: platform.modelMap,
      helper: platform.helper,
      opencodeCommand: platform.opencodeCommand,
      openspecCommand: platform.openspecCommand,
      specMode: platform.specMode,
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
