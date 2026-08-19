import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")

test("the architecture fault matrix is completely classified with executable V2-6 evidence", async () => {
  const matrix = JSON.parse(await readFile(path.join(root, "tests/v2/e2e/fault-matrix.json"), "utf8"))
  assert.deepEqual(matrix.map(({ id }) => id), Array.from({ length: 23 }, (_, index) => index + 1))
  for (const entry of matrix) {
    assert.ok(["v2-5", "v2-6"].includes(entry.scope), `fault ${entry.id} has no milestone`)
    assert.ok(entry.evidence?.length > 0, `fault ${entry.id} has no executable evidence`)
    for (const evidence of entry.evidence) {
      const source = await readFile(path.join(root, evidence.file), "utf8")
      assert.ok(source.includes(`test("${evidence.title}"`), `fault ${entry.id} points to a missing test: ${evidence.title}`)
    }
  }
})
