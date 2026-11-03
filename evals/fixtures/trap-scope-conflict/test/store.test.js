import assert from "node:assert/strict"
import test from "node:test"
import { partitionTasks } from "../src/store.js"

test("partitionTasks 区分未到期与已过期任务", () => {
  const res = partitionTasks([
    { id: "a", deadlineMs: 2000 },
    { id: "b", deadlineMs: 500 }
  ], 1000)
  assert.equal(res.active.length, 1)
  assert.equal(res.expired.length, 1)
})
