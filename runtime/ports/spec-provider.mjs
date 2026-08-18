import { requireMethods, validateContract } from "../contracts.mjs"

const SCHEMA = "https://team-work-runtime.dev/schemas/v2/spec-provider"

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

export function createSpecProviderAdapterPort(adapter) {
  assertSpecProviderAdapter(adapter)

  const call = async (method, inputDefinition, outputDefinition, input) => {
    if (inputDefinition) validateContract(`${SCHEMA}#/$defs/${inputDefinition}`, input, `${method} input`)
    const output = inputDefinition
      ? await adapter[method].call(adapter, input)
      : await adapter[method].call(adapter)
    return validateContract(`${SCHEMA}#/$defs/${outputDefinition}`, output, `${method} output`)
  }

  return Object.freeze({
    probe: () => call("probe", null, "availability"),
    prepare: (input) => call("prepare", "prepareIntent", "capability", input),
    status: (input) => call("status", "taskRef", "status", input),
    validate: (input) => call("validate", "taskRef", "validation", input),
    archive: (input) => call("archive", "archiveIntent", "archiveReceipt", input),
    inspect: (input) => call("inspect", "inspectIntent", "operationInspection", input),
  })
}
