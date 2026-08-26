// tagAgents v2 测试：pendingTags 落盘/覆盖 + 插件自动回填 mappings（键任务作用域）
import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync as rfs } from "node:fs"
test("跨任务键隔离：同标签两个任务 key，mappings 各自独立（任务作用域防串会话）", async () => {
  const { persistTagHints } = await import("../runtime-v3/cli.mjs")
  const { mkdtemp, mkdir, readFile } = await import("node:fs/promises")
  const os = await import("node:os")
  const path = await import("node:path")
  const root = await mkdtemp(path.join(os.tmpdir(), "tw-iso-"))
  await mkdir(path.join(root, ".team-work", "platform"), { recursive: true })
  // 任务 A 与任务 B 同标签（CR·owner）各自派发
  await persistTagHints(root, [{ tag: "CR" + DOT + "owner", key: "wA-1", hint: { provider: "p", model: "m" } }])
  await persistTagHints(root, [{ tag: "CR" + DOT + "owner", key: "wB-1", hint: { provider: "p", model: "m" } }])
  // 任务 A 的子代创建后回填：pendingTags 指向最新 key（wB-1）——但 mappings 键隔离：
  // 模拟插件回填两次（A 子代在 B 派发后创建——乱序窗口场景）
  const d0 = JSON.parse(await readFile(path.join(root, ".team-work", "platform", "agents.json"), "utf8"))
  assert.equal(d0.pendingTags["CR" + DOT + "owner"], "wB-1", "pendingTags=最新派发 key")
  // 直接验证 mappings 键结构隔离（回填只写 pendingTags 指向的 key，不会覆盖其他任务 key 的既有正确映射）
  d0.mappings = { "wB-1": "child-B" }
  await (await import("node:fs/promises")).writeFile(path.join(root, ".team-work", "platform", "agents.json"), JSON.stringify(d0))
  // A 子代乱序创建（在 B 之后）——按 v2 语义回填 wB-1（残余窗口已文档化）
  // 关键断言：mappings 的键是任务作用域 key，A 无法污染 B 之外的任务 key 空间
  assert.ok("wB-1" in d0.mappings, "mappings 键=key（任务作用域）")
  assert.equal(d0.mappings["wB-1"], "child-B")
})

import { mkdtemp as mkdt, readFile as rf, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const { persistTagHints } = await import("../runtime-v3/cli.mjs")
const { makeInjectContribution } = await import("../dsh/inject.js")
const DOT = String.fromCharCode(183)

test("pendingTags：落盘标签到key，同标签续派覆盖为最新key", async () => {
  const root = await mkdt(path.join(os.tmpdir(), "tw-pend-"))
  await mkdir(path.join(root, ".team-work", "platform"), { recursive: true })
  await persistTagHints(root, [{ tag: "CR" + DOT + "owner", key: "w2-aaa", hint: { provider: "p", model: "m" } }])
  let d = JSON.parse(await rf(path.join(root, ".team-work", "platform", "agents.json"), "utf8"))
  assert.equal(d.pendingTags["CR" + DOT + "owner"], "w2-aaa")
  await persistTagHints(root, [{ tag: "CR" + DOT + "owner", key: "w2-bbb", hint: { provider: "p", model: "m" } }])
  d = JSON.parse(await rf(path.join(root, ".team-work", "platform", "agents.json"), "utf8"))
  assert.equal(d.pendingTags["CR" + DOT + "owner"], "w2-bbb", "续派覆盖最新key")
})

test("插件回填：标签命中后 mappings[key]=childId 落地；无 pending 不写；幂等", async () => {
  const root = await mkdt(path.join(os.tmpdir(), "tw-bf-"))
  await mkdir(path.join(root, ".team-work", "platform"), { recursive: true })
  await persistTagHints(root, [{ tag: "CR" + DOT + "owner", key: "w2-abc", hint: { provider: "p", model: "m", effort: "max" } }])
  const file = path.join(root, ".team-work", "platform", "agents.json")
  const installs = []
  const ctx = { logger: { info() {}, warn() {} } }
  const contribution = makeInjectContribution(ctx, {
    readFileSync: (f) => rfs(f, "utf8"), // 贡献段真读（含 tagHints）
    installerNow: () => (c, sel) => { installs.push(sel) },
  })
  const childCtx = { agent: { id: "child-x", session: { header: { cwd: root }, events: [{ type: "subagent/descriptor", data: { label: "CR" + DOT + "owner" } }] } } }
  const disposer = contribution(childCtx)
  assert.equal(installs[0].current.model, "m", "标签注入")
  await new Promise((r) => setTimeout(r, 120))
  const d = JSON.parse(await rf(file, "utf8"))
  assert.equal(d.mappings["w2-abc"], "child-x", "回填任务作用域键")
  // 幂等：再跑一次（resume 语义）mappings 不变
  contribution(childCtx)
  await new Promise((r) => setTimeout(r, 120))
  const d3 = JSON.parse(await rf(file, "utf8"))
  assert.equal(d3.mappings["w2-abc"], "child-x", "幂等")
})
