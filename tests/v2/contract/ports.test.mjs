import assert from "node:assert/strict"
import test from "node:test"

import {
  ContractError,
  assertExecutionAdapter,
  assertSpecProviderAdapter,
  createExecutionAdapterPort,
  createSpecProviderAdapterPort,
} from "../../../runtime/index.mjs"

test("ExecutionAdapter requires the complete recovery-aware port", () => {
  const adapter = {
    capabilities() {},
    bindLead() {},
    ensureExecution() {},
    inspectExecution() {},
    quiesce() {},
    inspectQuiesce() {},
    verifyHumanDecision() {},
    stopExecution() {},
    inspectStop() {},
  }

  assert.equal(assertExecutionAdapter(adapter), adapter)
  assert.throws(
    () => assertExecutionAdapter({ ...adapter, inspectExecution: undefined }),
    (error) => error instanceof ContractError && /inspectExecution/.test(error.message),
  )
  assert.throws(
    () => assertExecutionAdapter({ ...adapter, inspectStop: undefined }),
    (error) => error instanceof ContractError && /inspectStop/.test(error.message),
  )
  assert.throws(
    () => assertExecutionAdapter({ ...adapter, inspectQuiesce: undefined }),
    (error) => error instanceof ContractError && /inspectQuiesce/.test(error.message),
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

test("Execution port validates every effect and receipt at the adapter boundary", async () => {
  let called = false
  const adapter = {
    capabilities: async () => ({ bad: true }),
    bindLead() {},
    ensureExecution: async () => {
      called = true
      return {}
    },
    inspectExecution() {},
    quiesce() {},
    inspectQuiesce() {},
    verifyHumanDecision() {},
    stopExecution() {},
    inspectStop() {},
  }
  const port = createExecutionAdapterPort(adapter)

  await assert.rejects(port.capabilities(), ContractError)
  await assert.rejects(
    port.ensureExecution({ operationId: "op-1", opencodeSessionId: "private" }),
    ContractError,
  )
  assert.equal(called, false)
})

test("SPEC port validates provider inputs and outputs instead of trusting method shape", async () => {
  let called = false
  const adapter = {
    probe: async () => ({ providerId: "openspec", status: "ready", observedAt: "invalid" }),
    prepare() {},
    status() {},
    validate() {},
    archive() {},
    inspect: async () => {
      called = true
      return {}
    },
  }
  const port = createSpecProviderAdapterPort(adapter)

  await assert.rejects(port.probe(), ContractError)
  await assert.rejects(port.inspect({ operationId: "op-1", providerPrivatePath: "changes/x" }), ContractError)
  assert.equal(called, false)
})
