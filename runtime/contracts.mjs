import { readFileSync } from "node:fs"

import Ajv2020 from "ajv/dist/2020.js"
import addFormats from "ajv-formats"

const schemaFiles = [
  "common.schema.json",
  "lead-control.schema.json",
  "runtime-card.schema.json",
  "expert-verdict.schema.json",
  "member-delivery.schema.json",
  "platform-observation.schema.json",
  "execution-port.schema.json",
  "spec-provider.schema.json",
  "decision-packet.schema.json",
]

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false })
addFormats(ajv)
for (const file of schemaFiles) {
  const url = new URL(`../schemas/v2/${file}`, import.meta.url)
  ajv.addSchema(JSON.parse(readFileSync(url, "utf8")))
}

export class ContractError extends Error {
  constructor(message, errors = [], code = "CONTRACT_INVALID") {
    super(message)
    this.name = "ContractError"
    this.code = code
    this.errors = errors
  }
}

export function validateContract(schemaRef, value, label) {
  const validate = ajv.getSchema(schemaRef)
  if (!validate) throw new Error(`Unknown contract schema: ${schemaRef}`)
  if (validate(value)) return value
  throw new ContractError(`${label} does not match the Runtime v2 contract`, validate.errors ?? [])
}

export function requireMethods(value, methods, label) {
  if (!value || typeof value !== "object") {
    throw new ContractError(`${label} must be an object`)
  }
  const missing = methods.filter((method) => typeof value[method] !== "function")
  if (missing.length > 0) {
    throw new ContractError(`${label} is missing methods: ${missing.join(", ")}`)
  }
  return value
}
