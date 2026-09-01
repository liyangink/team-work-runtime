// tag-hints 写端清理回归（定向委派第二阶段）：runtime 派发不再落盘 tagHints/pendingTags——
// 模型选择快照只存在于 journal 的 dispatched 事实（dispatch-plan 导出）；agents.json 由 agent-map
// 单独登记 mappings。本文件保留最小残留断言，防止标签写端被无意恢复。
import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readFile, access } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { tw } from "../runtime-v3/cli.mjs"

test("写端清理：cli 不再导出 tagLabel/persistTagHints（标签落盘链已删）", async () => {
  const cli = await import("../runtime-v3/cli.mjs")
  assert.equal(cli.tagLabel, undefined)
  assert.equal(cli.persistTagHints, undefined)
})

test("派发不写 agents.json：run 落盘事实只在 journal（无 tagHints/pendingTags 键）", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tw-tag-"))
  const card = await tw(["open", "--name", "demo-t", "--objective", "o", "--entry", "code-review"], { projectRoot: root })
  assert.equal(card.ok, true)
  // run 对全局 tiers 未解析容忍（派单不带 modelHint 仍派发）；unresolved 拒绝只发生在 dispatch-plan。
  const run = await tw(["run", "--task", "demo-t", "--writable", "R.md:code-review"], { projectRoot: root })
  assert.equal(run.ok, true)
  const agentsFile = path.join(root, ".team-work", "tasks", "demo-t", "agents.json")
  const existed = await access(agentsFile).then(() => true, () => false)
  assert.equal(existed, false, "派发不再写 agents.json（登记唯一入口 = tw agent-map）")
  const journal = await readFile(path.join(root, ".team-work", "tasks", "demo-t", "journal.jsonl"), "utf8")
  assert.ok(journal.includes('"dispatched"'), "派发事实仍落 journal（modelHint 快照在 dispatched.detail 内）")
})
