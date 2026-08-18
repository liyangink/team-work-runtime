import { readFile } from "node:fs/promises"
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
  const markerPath = path.join(path.resolve(projectRoot), ".team-work", "project.json")
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
