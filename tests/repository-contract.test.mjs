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

test("README is the single user guide with intro, quick start, and one fixed config", async () => {
  const usage = await read("README.md")
  const report = await read("docs/validation/opencode-real-gateway-2026-08-11.md")
  const evidence = JSON.parse(await read("docs/validation/opencode-real-gateway-2026-08-11.json"))
  const quickStart = usage.slice(usage.indexOf("## QuickStart"), usage.indexOf("## 工作流"))
  const faq = usage.slice(usage.indexOf("## 常见问题"))
  assert.ok(usage.indexOf("## 简介") < usage.indexOf("## QuickStart"))
  assert.ok(usage.indexOf("## QuickStart") < usage.indexOf("## 配置"))
  assert.match(usage, /npx team-work-runtime@latest install/)
  assert.match(usage, /项目根目录.*team-work\.config\.json/s)
  assert.match(usage, /与 macOS、Linux、Windows 无关/)
  assert.match(usage, /team-work\.config\.json/)
  assert.equal([...usage.matchAll(/flowchart TB/g)].length, 2)
  assert.match(usage, /OpenSpec 与工作流的关系/)
  assert.match(usage, /负责第 4、5 阶段.*第 10 阶段/)
  assert.match(usage, /"effort"/)
  assert.match(usage, /reasoningEffort/)
  assert.match(usage, /从 Workflow 开始/)
  assert.match(usage, /直接使用 Team-work/)
  assert.match(usage, /任意阶段/)
  assert.match(usage, /查看或继续任务/)
  assert.doesNotMatch(quickStart, /doctor|debug agent|model-map|plugins\/opencode\/scripts/)
  assert.equal([...faq.matchAll(/^### /gm)].length, 1)
  assert.doesNotMatch(usage, /USAGE\.md|--model-map|## OpenCode 注意事项|OMO|## 开发文档|archive/)
  assert.doesNotMatch(usage, /发布前真实网关验收|下一项最小验收/)
  assert.doesNotMatch(report, /下一项最小验收/)
  assert.match(report, /双成员后台派发/)
  assert.match(report, /跨进程续派/)
  assert.match(report, /不是完整 Team-work 策略验收/)
  assert.equal(evidence.backgroundTeamRun.children.length, 2)
  assert.ok(evidence.backgroundTeamRun.children.every(({ spawnMode }) => spawnMode === "background"))
  assert.equal(evidence.crossProcessResume.sessionIdBefore, evidence.crossProcessResume.sessionIdAfter)
  assert.equal(evidence.crossProcessResume.newRuntimeEvent, "platform.resume.accepted")
})
