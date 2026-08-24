import assert from "node:assert/strict"
import { access, readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (relativePath) => readFile(path.join(projectRoot, relativePath), "utf8")

test("repository inventory contains only the current implementation", async () => {
  const inventory = JSON.parse(await read("docs/file-inventory.json"))
  for (const relativePath of [...inventory.newImplementation, ...inventory.sharedBuild]) {
    await assert.doesNotReject(access(path.join(projectRoot, relativePath)), relativePath)
  }
  assert.equal("legacyArchive" in inventory, false)
  await assert.rejects(access(path.join(projectRoot, "archive")), (error) => error.code === "ENOENT")
  assert.ok(inventory.rules.some((rule) => rule.includes("Git history")))
})

test("v3 assets exist and v2 trees are removed (git history preserves them)", async () => {
  for (const present of ["runtime-v3/cli.mjs", "bin/tw.mjs", "skills/team-work-v3/SKILL.md", "docs/runtime-v3-charter.md"]) {
    await assert.doesNotReject(access(path.join(projectRoot, present)), present)
  }
  for (const removed of ["plugins/opencode", "installer", "runtime/application", "runtime/domain/reducer.mjs", "schemas/v2", "tests/v2"]) {
    await assert.rejects(access(path.join(projectRoot, removed)), (error) => error.code === "ENOENT", removed)
  }
})

test("package metadata is intact (install simulation once caught corruption)", async () => {
  const pkg = JSON.parse(await read("package.json"))
  assert.equal(typeof pkg.name, "string")
  assert.ok(pkg.name.length > 0)
  assert.match(pkg.version, /^\d+\.\d+\.\d+/, "version 语义化")
  assert.equal(typeof pkg.bin?.tw, "string")
  assert.ok(pkg.bin.tw.length > 0)
  for (const entry of ["bin/", "runtime-v3/", "skills/team-work-v3/", "workflow/definitions/", "team-work/policies/"]) {
    assert.ok(pkg.files.includes(entry), `files 缺 ${entry}`)
  }
})

test("dsh orchestration template stays consistent with skill surface", async () => {
  const skill = await read("skills/team-work-v3/SKILL.md")
  assert.match(skill, /dsh-orchestration\.md/, "SKILL.md 链接编排模板")
  const template = await read("skills/team-work-v3/references/dsh-orchestration.md")
  assert.match(template, /dispatch-plan/)
  assert.match(template, /agent\(/)
  assert.match(template, /modelHint/)
})

test("AGENTS.md preserves core collaboration invariants", async () => {
  const agents = await read("AGENTS.md")
  assert.match(agents, /任意研发阶段创建并介入/)
  assert.match(agents, /非作者 Senior 或 Expert 挑战/)
  assert.match(agents, /只读子派单/)
  assert.match(agents, /不得重新引入[^。\n]*旧版资产/)
  assert.match(agents, /subagent 默认使用 \`gpt-5\.6-terra\`/)
  assert.match(agents, /名字寻址/)
  assert.match(agents, /状态从事实源推导/)
  assert.match(agents, /工具调用是唯一检查点/)
})

test("charter documents have valid local links", async () => {
  const inventory = JSON.parse(await read("docs/file-inventory.json"))
  const markdownFiles = inventory.newImplementation.filter((file) => file.endsWith(".md"))
  for (const relativeFile of markdownFiles) {
    const content = await read(relativeFile)
    for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].replace(/^<|>$/g, "").split("#", 1)[0]
      if (!target || /^(?:https?:|mailto:|file:)/.test(target)) continue
      const resolved = path.resolve(projectRoot, path.dirname(relativeFile), decodeURIComponent(target))
      await assert.doesNotReject(access(resolved), `${relativeFile} links to missing ${target}`)
    }
  }
})
