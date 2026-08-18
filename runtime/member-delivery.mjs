import { requireMethods, validateContract } from "./contracts.mjs"

const MEMBER_SCHEMA = "https://team-work-runtime.dev/schemas/v2/member-delivery"

export function createMemberDelivery(handlers) {
  requireMethods(handlers, ["report"], "MemberDelivery handlers")

  return Object.freeze({
    report: async (input) => {
      validateContract(`${MEMBER_SCHEMA}#/$defs/memberReport`, input, "member report")
      const receipt = await handlers.report(input)
      return validateContract(`${MEMBER_SCHEMA}#/$defs/memberReceipt`, receipt, "member receipt")
    },
  })
}
