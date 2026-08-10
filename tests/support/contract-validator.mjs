import Ajv2020 from "ajv/dist/2020.js"
import addFormats from "ajv-formats"

export function createContractValidator(schemas) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true })
  addFormats(ajv)
  for (const schema of schemas) ajv.addSchema(schema)

  return function validate(schemaId, value) {
    const compiled = ajv.getSchema(schemaId)
    if (!compiled) throw new Error(`Unknown schema: ${schemaId}`)
    if (compiled(value)) return []
    return compiled.errors.map(({ instancePath, keyword, message, params }) => {
      const detail = params.additionalProperty ?? params.missingProperty ?? ""
      return `${instancePath || "$"} ${detail} ${keyword}: ${message}`.replace(/\s+/g, " ").trim()
    })
  }
}
