// tagLabel/persistTagHints 单测（交叉审查修正2：落盘/覆盖/并发/损坏降级 + 缩写映射）
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

test("persistTagHints：落盘/续派覆盖/并发合并/损坏降级", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tw-tag-"))
  await mkdir(path.join(root, ".team-work", "platform"), { recursive: true })
  await writeFile(path.join(root, ".team-work", "platform", "agents.json"), JSON.stringify({ mappings: { k: "old" } }))
  // 落盘 + 保既有字段
  await persistTagHints(root, [{ tag: "CR" + DOT + "owner", hint: { provider: "p1", model: "m1", effort: "max" } }])
  let d = JSON.parse(await readFile(path.join(root, ".team-work", "platform", "agents.json"), "utf8"))
  assert.equal(d.tagHints["CR" + DOT + "owner"].model, "m1")
  assert.equal(d.mappings.k, "old", "既有字段保留（非整覆盖）")
  // 续派覆盖：同标签新 hint
  await persistTagHints(root, [{ tag: "CR" + DOT + "owner", hint: { provider: "p2", model: "m2" } }])
  d = JSON.parse(await readFile(path.join(root, ".team-work", "platform", "agents.json"), "utf8"))
  assert.equal(d.tagHints["CR" + DOT + "owner"].model, "m2", "同标签续派覆盖")
  // 并发合并：两键并行写，两键俱在（项目锁串行化）
  await Promise.all([
    persistTagHints(root, [{ tag: "RES" + DOT + "owner", hint: { provider: "a", model: "a1" } }]),
    persistTagHints(root, [{ tag: "TEST" + DOT + "owner", hint: { provider: "b", model: "b1" } }]),
  ])
  d = JSON.parse(await readFile(path.join(root, ".team-work", "platform", "agents.json"), "utf8"))
  assert.equal(d.tagHints["RES" + DOT + "owner"].model, "a1")
  assert.equal(d.tagHints["TEST" + DOT + "owner"].model, "b1", "并发合并不丢键")
  // 损坏降级：STATE_CORRUPT 不覆盖（console.warn 静默）
  await writeFile(path.join(root, ".team-work", "platform", "agents.json"), "{ 坏json")
  await persistTagHints(root, [{ tag: "CR" + DOT + "chal", hint: { provider: "c", model: "c1" } }])
  const raw = await readFile(path.join(root, ".team-work", "platform", "agents.json"), "utf8")
  assert.equal(raw, "{ 坏json", "损坏文件不被覆盖（降级 warn 保留原文件）")
})
