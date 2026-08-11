#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto"

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exitCode = 2
}

function seedNumber(seed) {
  return createHash("sha256").update(seed).digest().readUInt32LE(0) || 1
}

function randomSource(seed) {
  let state = seedNumber(seed ?? randomBytes(32).toString("hex"))
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

function shuffled(values, random) {
  const result = [...values]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1))
    ;[result[index], result[target]] = [result[target], result[index]]
  }
  return result
}

function selectMembers({ candidates, tier, count, seed }) {
  if (!Array.isArray(candidates) || !candidates.length) throw new Error("candidates 候选列表不能为空")
  if (typeof tier !== "string" || !tier) throw new Error("tier 必须是非空字符串")
  if (!Number.isInteger(count) || count < 1) throw new Error("count 必须是正整数")

  const ids = new Set()
  for (const candidate of candidates) {
    if (!candidate || typeof candidate.id !== "string" || !candidate.id || typeof candidate.model !== "string" || !candidate.model || typeof candidate.tier !== "string") {
      throw new Error("每个 candidate 必须包含非空 id、model 和 tier")
    }
    if (ids.has(candidate.id)) throw new Error(`候选 id 重复: ${candidate.id}`)
    ids.add(candidate.id)
  }

  const pool = candidates.filter((candidate) => candidate.tier === tier)
  if (pool.length < count) throw new Error(`${tier} 档候选不足：需要 ${count}，实际 ${pool.length}`)

  const random = randomSource(seed)
  const groups = new Map()
  for (const candidate of shuffled(pool, random)) {
    const group = groups.get(candidate.model) ?? []
    group.push(candidate)
    groups.set(candidate.model, group)
  }

  const modelGroups = shuffled([...groups.entries()], random).map(([model, members]) => ({ model, members: shuffled(members, random) }))
  const selected = []
  while (selected.length < count) {
    let madeProgress = false
    for (const group of modelGroups) {
      const member = group.members.shift()
      if (!member) continue
      selected.push(member)
      madeProgress = true
      if (selected.length === count) break
    }
    if (!madeProgress) break
  }
  return { tier, requested: count, selected, seed: seed ?? null, strategy: "model-diverse-random-without-replacement" }
}

let input = ""
process.stdin.setEncoding("utf8")
for await (const chunk of process.stdin) input += chunk

try {
  const request = JSON.parse(input)
  process.stdout.write(`${JSON.stringify(selectMembers(request))}\n`)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
