// tag-hints 写端清理回归（定向委派第二阶段）：runtime 派发不再落盘 tagHints/pendingTags——
// 模型选择快照只存在于 journal 的 dispatched 事实（dispatch-plan 导出）；agents.json 由 agent-map
// 单独登记 mappings。本文件保留最小残留断言，防止标签写端被无意恢复。
import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { tw } from "../runtime-v3/cli.mjs"

// open 期从调用快照解析三角色（roles 固化后派发零配置反查）——本文件独立于 v3-fixtures，进程级装一份临时快照。
process.env.TW_DSH_CONFIG = JSON.stringify({ entryId: "team-work-dsh", profile: "profile-example", tiers: {
  junior: { provider: "provider-example", model: "model-junior" },
  senior: { provider: "provider-example", model: "model-senior" },
  expert: { provider: "provider-example", model: "model-expert" },
} })

test("写端清理：cli 不再导出 tagLabel/persistTagHints（标签落盘链已删）", async () => {
  const cli = await import("../runtime-v3/cli.mjs")
  assert.equal(cli.tagLabel, undefined)
  assert.equal(cli.persistTagHints, undefined)
})

test("agents.json 只保留 mappings + roles：派发落盘事实只在 journal（无 tagHints/pendingTags/modelHints 键）", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tw-tag-"))
  const card = await tw(["open", "--name", "demo-t", "--objective", "o", "--entry", "code-review"], { projectRoot: root })
  assert.equal(card.ok, true)
  // 新任务先确认意图，再派发（确认卡是 open 后的正常人工门）。
  assert.equal((await tw(["decide", "--task", "demo-t", "--choice", "1"], { projectRoot: root })).ok, true)
  const plan = await tw(["dispatch-plan", "--task", "demo-t", "--writable", "R.md:code-review"], { projectRoot: root })
  assert.equal(plan.ok, true)
  assert.equal(plan.stop, null)
  assert.ok(plan.waves.length > 0)
  const agents = JSON.parse(await readFile(path.join(root, ".team-work", "tasks", "demo-t", "agents.json"), "utf8"))
  assert.deepEqual(Object.keys(agents).sort(), ["mappings", "roles"], "agents.json 只保留 mappings + roles")
  assert.deepEqual(agents.mappings, {}, "派发不写续派映射（登记唯一入口 = tw agent-map）")
  assert.deepEqual(Object.keys(agents.roles).sort(), ["challenger", "expert", "owner"], "open 期固化三角色 ModelRef")
  const journal = await readFile(path.join(root, ".team-work", "tasks", "demo-t", "journal.jsonl"), "utf8")
  assert.ok(journal.includes('"dispatched"'), "派发事实仍落 journal（modelRef 快照在 dispatched.detail 内）")
  const dispatched = JSON.parse(journal.trim().split("\n").find((line) => line.includes('"dispatched"')))
  assert.ok(dispatched.detail.modelRef?.provider && dispatched.detail.modelRef?.modelName, "journal 快照带 modelRef")
  assert.equal(dispatched.detail.modelHint, undefined, "新派发不再写 modelHint")
})
