import { ContractError } from "./contracts.mjs"

export const RUNTIME_MAJOR = 2

export function assertRuntimeMajor(actualMajor) {
  if (actualMajor === RUNTIME_MAJOR) return actualMajor
  throw new ContractError(
    `Runtime v${RUNTIME_MAJOR} cannot open a v${actualMajor} project root`,
    [],
    "RUNTIME_MAJOR_MISMATCH",
  )
}
