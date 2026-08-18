import assert from "node:assert/strict"
import test from "node:test"

import {
  ContractError,
  assertExecutionAdapter,
  assertSpecProviderAdapter,
} from "../../../runtime/index.mjs"

test("ExecutionAdapter requires the complete recovery-aware port", () => {
  const adapter = {
    capabilities() {},
    bindLead() {},
    ensureExecution() {},
    inspectExecution() {},
    quiesce() {},
    verifyHumanDecision() {},
    stopExecution() {},
  }

  assert.equal(assertExecutionAdapter(adapter), adapter)
  assert.throws(
    () => assertExecutionAdapter({ ...adapter, inspectExecution: undefined }),
    (error) => error instanceof ContractError && /inspectExecution/.test(error.message),
  )
})

test("SpecProviderAdapter cannot omit inspection of in-doubt effects", () => {
  const adapter = {
    probe() {},
    prepare() {},
    status() {},
    validate() {},
    archive() {},
    inspect() {},
  }

  assert.equal(assertSpecProviderAdapter(adapter), adapter)
  assert.throws(
    () => assertSpecProviderAdapter({ ...adapter, inspect: undefined }),
    (error) => error instanceof ContractError && /inspect/.test(error.message),
  )
})
