import assert from "node:assert/strict"
import test from "node:test"

import { ContractError, createPlatformObservationSink } from "../../../runtime/index.mjs"

test("PlatformObservationSink accepts normalized execution facts", async () => {
  const sink = createPlatformObservationSink({
    observe: async () => ({ observationId: "observation-1", sequence: 4, duplicate: false }),
  })

  const receipt = await sink.observe({
    kind: "execution",
    observationId: "host-event-1",
    dedupeKey: "session-1:idle:3",
    executionRef: "session-1",
    assignmentId: "assignment-1",
    state: "idle",
    observedAt: "2026-08-18T10:00:00.000Z",
  })

  assert.deepEqual(receipt, { observationId: "observation-1", sequence: 4, duplicate: false })
})

test("PlatformObservationSink rejects platform-private payloads", async () => {
  const sink = createPlatformObservationSink({ observe: async () => assert.fail("handler must not run") })

  await assert.rejects(
    sink.observe({
      kind: "execution",
      observationId: "host-event-1",
      dedupeKey: "event-1",
      executionRef: "session-1",
      assignmentId: "assignment-1",
      state: "idle",
      observedAt: "2026-08-18T10:00:00.000Z",
      opencodeSession: { id: "private" },
    }),
    (error) => error instanceof ContractError,
  )
})
