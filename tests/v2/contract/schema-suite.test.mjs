import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import Ajv2020 from "ajv/dist/2020.js"
import addFormats from "ajv-formats"

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(testDirectory, "../../..")
const schemaDirectory = path.join(repositoryRoot, "schemas/v2")
const fixtureDirectory = path.join(repositoryRoot, "tests/v2/fixtures")

async function loadJson(file) {
  return JSON.parse(await readFile(file, "utf8"))
}

async function createValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false })
  addFormats(ajv)
  const names = (await readdir(schemaDirectory)).filter((name) => name.endsWith(".schema.json")).sort()
  for (const name of names) ajv.addSchema(await loadJson(path.join(schemaDirectory, name)))
  return { ajv, names }
}

test("every Runtime v2 JSON schema compiles under strict Draft 2020-12 validation", async () => {
  const { ajv, names } = await createValidator()
  assert.ok(names.length >= 8)
  for (const name of names) {
    const schema = await loadJson(path.join(schemaDirectory, name))
    assert.equal(typeof ajv.getSchema(schema.$id), "function", name)
  }
})

test("Runtime v2 contract fixtures accept supported inputs and reject boundary violations", async () => {
  const { ajv } = await createValidator()
  const validFixtures = await loadJson(path.join(fixtureDirectory, "contracts.valid.json"))
  const invalidFixtures = await loadJson(path.join(fixtureDirectory, "contracts.invalid.json"))

  for (const fixture of validFixtures) {
    const validate = ajv.getSchema(fixture.schemaRef)
    assert.equal(validate(fixture.data), true, `${fixture.schemaRef}: ${ajv.errorsText(validate.errors)}`)
  }
  for (const fixture of invalidFixtures) {
    const validate = ajv.getSchema(fixture.schemaRef)
    assert.equal(validate(fixture.data), false, fixture.schemaRef)
  }
})
