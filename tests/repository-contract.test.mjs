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

test("v3 assets exist and historical trees are removed (git history preserves them)", async () => {
  for (const present of ["runtime-v3/cli.mjs", "bin/tw.mjs", "dsh/index.js", "dsh/client/badge.js", "cordis.patch.yml", "tests/e2e-root.test.mjs", "skills/team-work-v3/SKILL.md", "docs/runtime-v3-charter.md"]) {
    await assert.doesNotReject(access(path.join(projectRoot, present)), present)
  }
  for (const removed of ["plugins/opencode", "installer", "runtime", "runtime/application", "runtime/domain/reducer.mjs", "schemas/v2", "tests/v2", "packages/dsh-plugin", "scripts/install-local.mjs", "scripts/uninstall-local.mjs", "scripts/e2e-c1.mjs", "docs/phase3-plugin-plan.md", "docs/pre-phase3-plan.md", "dsh/inject.js", "dsh/tw-tool-subagent.js"]) {
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
  assert.equal(pkg.main, "./dsh/index.js", "唯一根制品直接提供 DSH host 入口")
  assert.equal(pkg.exports?.["./client"], "./dsh/client/badge.js", "唯一根制品直接提供 Web client")
  assert.equal(pkg.dsh?.bundle?.patch, "./cordis.patch.yml", "唯一根制品声明 DSH bundle patch")
  assert.equal(pkg.peerDependencies?.["@deepseek-ai/dsh"], "0.2.0-rc.2", "只声明已核验的新版宿主")
  assert.equal(pkg.peerDependencies?.["@deepseek-ai/dsh-agent"], undefined, "模型注入安装器已下线")
  assert.equal(pkg.dependencies?.["@deepseek-ai/schemastery"], "~3.18.4", "直接使用的 schema 依赖在根制品声明")
  assert.ok(!pkg.files.some((entry) => entry.startsWith("packages/")), "唯一根制品不得收编旧 packages 子包")
  for (const entry of ["bin/", "cordis.patch.yml", "dsh/", "runtime-v3/", "skills/team-work-v3/", "skills/clarity-writing/", "skills/clarity-review/", "skills/clarity-guidance/", "workflow/definitions/", "team-work/policies/"]) {
    assert.ok(pkg.files.includes(entry), `files 缺 ${entry}`)
  }
})

test("clarity 技能携带同级公共资源，必读段各只有一个原文来源", async () => {
  const inventory = JSON.parse(await read("docs/file-inventory.json"))
  const files = [
    "skills/clarity-guidance/output-standard.md",
    "skills/clarity-writing/SKILL.md",
    "skills/clarity-review/SKILL.md",
    "skills/clarity-review/references/review-rules.md",
    "skills/clarity-review/references/standalone-records.md",
    "skills/clarity-review/references/examples.md",
  ]
  for (const file of files) {
    assert.ok(inventory.newImplementation.includes(file), file)
    assert.ok(!inventory.planned.includes(file), file)
  }
  for (const name of ["clarity-writing", "clarity-review"]) {
    const skill = await read(`skills/${name}/SKILL.md`)
    assert.ok(skill.startsWith(`---\nname: ${name}\n`), name)
    assert.ok(skill.includes("../clarity-guidance/output-standard.md"), "两个入口链接同一公共规范")
  }
  for (const file of [files[0], files[3]]) {
    const content = await read(file)
    const begin = "<!-- clarity:required:begin -->"
    const end = "<!-- clarity:required:end -->"
    assert.equal(content.split(begin).length, 2, `${file} 唯一开始标记`)
    assert.equal(content.split(end).length, 2, `${file} 唯一结束标记`)
    assert.ok(content.indexOf(begin) < content.indexOf(end), `${file} 标记顺序`)
    assert.ok(content.slice(content.indexOf(begin) + begin.length, content.indexOf(end)).trim(), `${file} 必读原文非空`)
  }
  await assert.rejects(access(path.join(projectRoot, "skills/clarity-guidance/SKILL.md")), (error) => error.code === "ENOENT", "公共资源不是第三个新技能")
  await assert.rejects(access(path.join(projectRoot, "skills/clarity-review/references/state-model.md")), (error) => error.code === "ENOENT", "状态模型并入独立记录，无副本")
})

test("dsh orchestration template stays consistent with skill surface", async () => {
  const skill = await read("skills/team-work-v3/SKILL.md")
  assert.match(skill, /dsh-orchestration\.md/, "SKILL.md 链接编排模板")
  const template = await read("skills/team-work-v3/references/dsh-orchestration.md")
  assert.match(template, /dispatch-plan/)
  assert.match(template, /tw-dispatch/)
  assert.match(template, /modelHint/)
})

test("AGENTS.md preserves core collaboration invariants", async () => {
  const agents = await read("AGENTS.md")
  assert.match(agents, /任意研发阶段创建并介入/)
  assert.match(agents, /非作者 Senior 或 Expert 挑战/)
  assert.match(agents, /只读子派单/)
  assert.match(agents, /不得重新引入[^。\n]*旧版资产/)
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
