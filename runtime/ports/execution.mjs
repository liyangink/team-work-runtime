import { requireMethods, validateContract } from "../contracts.mjs"

const SCHEMA = "https://team-work-runtime.dev/schemas/v2/execution-port"

export const EXECUTION_ADAPTER_METHODS = Object.freeze([
  "capabilities",
  "bindLead",
  "ensureExecution",
  "inspectExecution",
  "quiesce",
  "inspectQuiesce",
  "verifyHumanDecision",
  "stopExecution",
  "inspectStop",
])

export function assertExecutionAdapter(adapter) {
  return requireMethods(adapter, EXECUTION_ADAPTER_METHODS, "ExecutionAdapter")
}

export function createExecutionAdapterPort(adapter) {
  assertExecutionAdapter(adapter)

  const call = async (method, inputDefinition, outputDefinition, input) => {
    if (inputDefinition) validateContract(`${SCHEMA}#/$defs/${inputDefinition}`, input, `${method} input`)
    const output = inputDefinition
      ? await adapter[method].call(adapter, input)
      : await adapter[method].call(adapter)
    return validateContract(`${SCHEMA}#/$defs/${outputDefinition}`, output, `${method} output`)
  }

  return Object.freeze({
    capabilities: () => call("capabilities", null, "capabilitySnapshot"),
    bindLead: (input) => call("bindLead", "bindLeadIntent", "bindingReceipt", input),
    ensureExecution: (input) => call("ensureExecution", "dispatchEffect", "executionReceipt", input),
    inspectExecution: (input) => call("inspectExecution", "dispatchEffect", "executionReceipt", input),
    quiesce: (input) => call("quiesce", "quiesceIntent", "quiesceReceipt", input),
    inspectQuiesce: (input) => call("inspectQuiesce", "quiesceIntent", "quiesceReceipt", input),
    verifyHumanDecision: (input) => call("verifyHumanDecision", "verifyHumanIntent", "verifiedHumanDecision", input),
    stopExecution: (input) => call("stopExecution", "stopIntent", "stopReceipt", input),
    inspectStop: (input) => call("inspectStop", "stopIntent", "stopReceipt", input),
  })
}
