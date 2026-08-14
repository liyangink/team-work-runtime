import assert from "node:assert/strict"
import test from "node:test"

import { loadOpenCodeActivation } from "../plugins/opencode/src/activation.mjs"

test("OpenCode activation returns no platform state while disabled", async () => {
  const disabled = { platform: { id: "opencode", enabled: false } }
  const enabled = { platform: { id: "opencode", enabled: true } }

  assert.equal(await loadOpenCodeActivation(async () => disabled), null)
  assert.equal(await loadOpenCodeActivation(async () => enabled), enabled)
})
