import { requireMethods } from "../contracts.mjs"

export const SPEC_PROVIDER_ADAPTER_METHODS = Object.freeze([
  "probe",
  "prepare",
  "status",
  "validate",
  "archive",
  "inspect",
])

export function assertSpecProviderAdapter(adapter) {
  return requireMethods(adapter, SPEC_PROVIDER_ADAPTER_METHODS, "SpecProviderAdapter")
}
