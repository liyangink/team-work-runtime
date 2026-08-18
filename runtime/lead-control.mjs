import { ContractError, requireMethods, validateContract } from "./contracts.mjs"

const LEAD_SCHEMA = "https://team-work-runtime.dev/schemas/v2/lead-control"
const CARD_SCHEMA = "https://team-work-runtime.dev/schemas/v2/runtime-card"

export function createLeadControl(handlers) {
  requireMethods(handlers, ["open", "plan", "run", "steer"], "LeadControl handlers")

  const invoke = async (method, schemaRef, input) => {
    if (schemaRef) validateContract(schemaRef, input, `${method} intent`)
    const card = await handlers[method](input)
    return validateContract(CARD_SCHEMA, card, `${method} result`)
  }

  return Object.freeze({
    open: (input) => invoke("open", `${LEAD_SCHEMA}#/$defs/openIntent`, input),
    plan: (input) => invoke("plan", `${LEAD_SCHEMA}#/$defs/planIntent`, input),
    run: async (...args) => {
      if (args.length > 0) throw new ContractError("run does not accept Lead arguments")
      return await invoke("run", null, undefined)
    },
    steer: (input) => invoke("steer", `${LEAD_SCHEMA}#/$defs/steeringIntent`, input),
  })
}
