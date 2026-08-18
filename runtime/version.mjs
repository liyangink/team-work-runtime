import { readFile, realpath } from "node:fs/promises"
import path from "node:path"

import { ContractError, validateContract } from "./contracts.mjs"

export const RUNTIME_MAJOR = 2

export function assertRuntimeMajor(actualMajor) {
  if (actualMajor === RUNTIME_MAJOR) return actualMajor
  throw new ContractError(
    `Runtime v${RUNTIME_MAJOR} cannot open a v${actualMajor} project root`,
    [],
    "RUNTIME_MAJOR_MISMATCH",
  )
}

export async function assertProjectRuntimeMajor(projectRoot) {
  let markerPath
  try {
    const resolvedRoot = await realpath(path.resolve(projectRoot))
    const controlRoot = await realpath(path.join(resolvedRoot, ".team-work"))
    const relativeControl = path.relative(resolvedRoot, controlRoot)
    if (!relativeControl || relativeControl === ".." || relativeControl.startsWith(`..${path.sep}`) || path.isAbsolute(relativeControl)) {
      throw new ContractError("Runtime control root escapes the project root", [], "STATE_CORRUPT")
    }
    markerPath = await realpath(path.join(controlRoot, "project.json"))
    if (path.dirname(markerPath) !== controlRoot) {
      throw new ContractError("Runtime project marker escapes the control root", [], "STATE_CORRUPT")
    }
  } catch (error) {
    if (error instanceof ContractError) throw error
    throw new ContractError(
      "Cannot resolve Runtime project marker safely",
      [{ message: error.message }],
      "STATE_CORRUPT",
    )
  }

  let marker
  try {
    marker = JSON.parse(await readFile(markerPath, "utf8"))
  } catch (error) {
    throw new ContractError(
      `Cannot read Runtime project marker at ${markerPath}`,
      [{ message: error.message }],
      "STATE_CORRUPT",
    )
  }
  assertRuntimeMajor(marker.runtimeMajor)
  validateContract("https://team-work-runtime.dev/schemas/v2/project-marker", marker, "project marker")
  return marker
}
