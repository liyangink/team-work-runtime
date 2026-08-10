import assert from "node:assert/strict"
import { access, readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (relativePath) => readFile(path.join(projectRoot, relativePath), "utf8")

test("new implementation and legacy archives stay explicitly separated", async () => {
  const inventory = JSON.parse(await read("docs/file-inventory.json"))
  for (const relativePath of [...inventory.newImplementation, ...inventory.sharedBuild, ...inventory.legacyArchive]) {
    await assert.doesNotReject(access(path.join(projectRoot, relativePath)), relativePath)
  }
  assert.ok(inventory.rules.some((rule) => rule.includes("must not import or execute")))
})

test("repository contract preserves OpenCode and challenger invariants", async () => {
  const agents = await read("AGENTS.md")
  assert.match(agents, /任务允许从任意研发阶段创建并介入工作流/)
  assert.match(agents, /Senior 或 Expert 挑战非本人制品/)
  assert.match(agents, /background\/non-blocking 模式派发/)
  assert.match(agents, /禁止新实现反向依赖 `archive\/`/)
  assert.match(agents, /subagent 默认使用 `gpt-5\.6-terra`/)
})

test("new implementation documents have valid local links", async () => {
  const inventory = JSON.parse(await read("docs/file-inventory.json"))
  const markdownFiles = inventory.newImplementation.filter((file) => file.endsWith(".md"))
  for (const relativeFile of markdownFiles) {
    const content = await read(relativeFile)
    for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].replace(/^<|>$/g, "").split("#", 1)[0]
      if (!target || /^(?:https?:|mailto:)/.test(target)) continue
      const resolved = path.resolve(projectRoot, path.dirname(relativeFile), decodeURIComponent(target))
      await assert.doesNotReject(access(resolved), `${relativeFile} links to missing ${target}`)
    }
  }
})
