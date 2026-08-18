import assert from "node:assert/strict"
import test from "node:test"

import { ContractError, RUNTIME_MAJOR, assertRuntimeMajor } from "../../../runtime/index.mjs"

test("Runtime v2 rejects a v1 project root without a compatibility fallback", () => {
  assert.equal(RUNTIME_MAJOR, 2)
  assert.equal(assertRuntimeMajor(2), 2)
  assert.throws(
    () => assertRuntimeMajor(1),
    (error) => error instanceof ContractError && error.code === "RUNTIME_MAJOR_MISMATCH",
  )
})
