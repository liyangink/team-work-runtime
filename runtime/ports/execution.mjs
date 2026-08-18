import { requireMethods } from "../contracts.mjs"

export const EXECUTION_ADAPTER_METHODS = Object.freeze([
  "capabilities",
  "bindLead",
  "ensureExecution",
  "inspectExecution",
  "quiesce",
  "verifyHumanDecision",
  "stopExecution",
])

export function assertExecutionAdapter(adapter) {
  return requireMethods(adapter, EXECUTION_ADAPTER_METHODS, "ExecutionAdapter")
}
