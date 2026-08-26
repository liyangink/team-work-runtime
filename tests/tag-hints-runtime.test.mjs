// tagLabel/persistTagHints 单测（任务级注册表：persistTagHints(taskRoot, entries)）
import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const { tagLabel, persistTagHints } = await import("../runtime-v3/cli.mjs")
const DOT = String.fromCharCode(183)

test("tagLabel：阶段缩写映射/角色归一化/@包拼接/无包省略", () => {
  assert.equal(tagLabel("research", "owner"), "RES" + DOT + "owner")
  assert.equal(tagLabel("implementation", "owner", "store"), "IMPL" + DOT + "owner@store")
  assert.equal(tagLabel("code-review", "challenger"), "CR" + DOT + "chal", "challenger 归一 chal")
  assert.equal(tagLabel("design-review", "expert"), "DESIGN" + DOT + "expert", "review 复用父阶段缩写")
  assert.equal(tagLabel("spec-review", "chal"), "SPEC" + DOT + "chal")
})

test("persistTagHints：任务级落盘/续派覆盖/并发合并/损坏降级", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tw-tag-"))
  const taskRoot = path.join(root, ".team-work", "tasks", "demo-t")
  await mkdir(taskRoot, { recursive: true })
  const file = path.join(taskRoot, "agents.json")
  await writeFile(file, JSON.stringify({ mappings: { k: "old" } }))
  await persistTagHints(taskRoot, [{ tag: "CR" + DOT + "owner", hint: { provider: "p1", model: "m1", effort: "max" } }])
  let d = JSON.parse(await readFile(file, "utf8"))
  assert.equal(d.tagHints["CR" + DOT + "owner"].model, "m1")
  assert.equal(d.mappings.k, "old", "既有字段保留（非整覆盖）")
  await persistTagHints(taskRoot, [{ tag: "CR" + DOT + "owner", hint: { provider: "p2", model: "m2" } }])
  d = JSON.parse(await readFile(file, "utf8"))
  assert.equal(d.tagHints["CR" + DOT + "owner"].model, "m2", "同标签续派覆盖")
  // 生产语义：persistTagHints 总在 task.lock 内被调（runTransition 持锁）；锁串行化后合并不丢键
  const { withOwnerLock } = await import("../runtime-v3/persistence/transactions.mjs")
  await mkdir(path.join(taskRoot, "locks"), { recursive: true })
  await withOwnerLock(path.join(taskRoot, "locks", "task.lock"), async () => {
    await persistTagHints(taskRoot, [{ tag: "RES" + DOT + "owner", hint: { provider: "a", model: "a1" } }])
    await persistTagHints(taskRoot, [{ tag: "TEST" + DOT + "owner", hint: { provider: "b", model: "b1" } }])
  })
  d = JSON.parse(await readFile(file, "utf8"))
  assert.equal(d.tagHints["RES" + DOT + "owner"].model, "a1")
  assert.equal(d.tagHints["TEST" + DOT + "owner"].model, "b1", "持锁串行合并不丢键")
  await writeFile(file, "{ 坏json")
  await persistTagHints(taskRoot, [{ tag: "CR" + DOT + "chal", hint: { provider: "c", model: "c1" } }])
  const raw = await readFile(file, "utf8")
  assert.equal(raw, "{ 坏json", "损坏文件不被覆盖")
})
