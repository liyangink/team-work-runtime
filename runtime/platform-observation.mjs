import { requireMethods, validateContract } from "./contracts.mjs"

const OBSERVATION_SCHEMA = "https://team-work-runtime.dev/schemas/v2/platform-observation"

export function createPlatformObservationSink(handlers) {
  requireMethods(handlers, ["observe"], "PlatformObservationSink handlers")

  return Object.freeze({
    observe: async (input) => {
      validateContract(`${OBSERVATION_SCHEMA}#/$defs/observation`, input, "platform observation")
      const receipt = await handlers.observe(input)
      return validateContract(`${OBSERVATION_SCHEMA}#/$defs/receipt`, receipt, "platform observation receipt")
    },
  })
}
