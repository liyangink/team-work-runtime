#!/usr/bin/env node

import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { manageOpenCodePlugin } from "../src/lifecycle.mjs"

function parse(argv) {
  const command = argv[0]
  const options = {}
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === "--force" || token === "--skip-dependencies" || token === "--skip-smoke") options[token.slice(2)] = true
    else if (token.startsWith("--")) options[token.slice(2)] = argv[++index]
    else throw new Error(`未知参数：${token}`)
  }
  return { command, options }
}

const { command, options } = parse(process.argv.slice(2))
const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const modelMap = options["model-map"] ? JSON.parse(await readFile(path.resolve(options["model-map"]), "utf8")) : undefined

try {
  const result = await manageOpenCodePlugin(command, {
    projectRoot: path.resolve(options.project ?? process.cwd()),
    sourceRoot: scriptRoot,
    opencodeCommand: options.opencode ?? "opencode",
    hostVersion: options["host-version"],
    modelMap,
    force: Boolean(options.force),
    skipDependencies: Boolean(options["skip-dependencies"]),
    skipSmoke: Boolean(options["skip-smoke"]),
  })
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, code: error.code ?? "INSTALLER_ERROR", message: error.message, files: error.files }, null, 2)}\n`)
  process.exitCode = 1
}
