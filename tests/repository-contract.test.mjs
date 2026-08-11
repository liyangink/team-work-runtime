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

test("OpenCode operator docs cover setup, standalone use, recovery, and real gateway boundaries", async () => {
  const usage = await read("plugins/opencode/USAGE.md")
  const report = await read("plugins/opencode/REAL-GATEWAY-E2E.md")
  const evidence = JSON.parse(await read("plugins/opencode/evidence/2026-08-11-real-gateway.json"))
  assert.match(usage, /从 Workflow 开始/)
  assert.match(usage, /显式使用 Team-work/)
  assert.match(usage, /从任意阶段介入/)
  assert.match(usage, /跨会话继续与故障恢复/)
  assert.match(usage, /不要把 `opencode --pure` 当作 Team-work 的日常启动方式/)
  assert.match(report, /双成员后台派发/)
  assert.match(report, /跨进程续派/)
  assert.match(report, /不是完整 Team-work 策略验收/)
  assert.equal(evidence.backgroundTeamRun.children.length, 2)
  assert.ok(evidence.backgroundTeamRun.children.every(({ spawnMode }) => spawnMode === "background"))
  assert.equal(evidence.crossProcessResume.sessionIdBefore, evidence.crossProcessResume.sessionIdAfter)
  assert.equal(evidence.crossProcessResume.newRuntimeEvent, "platform.resume.accepted")
})
