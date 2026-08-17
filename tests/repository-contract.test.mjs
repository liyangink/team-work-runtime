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

test("repository contract preserves OpenCode and challenger invariants", async () => {
  const agents = await read("AGENTS.md")
  assert.match(agents, /任务允许从任意研发阶段创建并介入工作流/)
  assert.match(agents, /非作者 Senior 或 Expert 挑战/)
  assert.match(agents, /background\/non-blocking 模式派发/)
  assert.match(agents, /不得重新引入[^。\n]*旧版资产/)
  assert.match(agents, /subagent 默认使用 `gpt-5\.6-terra`/)
})

test("OpenCode guide preserves child sessions and emits clickable file references", async () => {
  const guide = await read("plugins/opencode/guides/team-work.md")
  const recovery = await read("plugins/opencode/guides/recovery.md")
  const combined = `${guide}\n${recovery}`

  assert.match(combined, /同一 work item[^。\n]*(?:team_work_resume|同一 child session)/i)
  assert.match(combined, /Expert[^。\n]*同一阶段[^。\n]*(?:session|会话)/i)
  assert.match(combined, /\[.+\]\(file:\/\/\/<absolute-path>\)/)
  assert.match(combined, /用户[^。\n]*(?:文件|制品|代码)[^。\n]*(?:Markdown|可点击)/i)
})

test("OpenCode managed resume distinguishes its arguments from generic delegation tools", async () => {
  const plugin = await read("plugins/opencode/assets/team-work.js")
  const guide = await read("plugins/opencode/guides/team-work.md")
  const recovery = await read("plugins/opencode/guides/recovery.md")
  const combined = `${plugin}\n${guide}\n${recovery}`

  assert.match(plugin, /team_work_resume[^]*只传[^。\n]*task_id[^。\n]*work_item_id[^。\n]*prompt/)
  assert.match(combined, /不要传[^。\n]*session_id[^。\n]*run_in_background[^。\n]*background/)
  assert.match(guide, /team_work_resume[^。\n]*自身[^。\n]*非阻塞/)
  assert.match(guide, /参数[^。\n]*(?:错误|误用)[^。\n]*(?:不代表|不是)[^。\n]*(?:session|网关)/i)
  assert.match(guide, /参数[^。\n]*(?:错误|误用)[^。\n]*(?:不得|不要)[^。\n]*(?:降级|容灾|重建)/)
  assert.match(recovery, /team_work_resume[^。\n]*(?:网关|session)[^。\n]*(?:status|恢复)/i)
})

test("OpenCode bounded wait remains a synchronization hint rather than a completion signal", async () => {
  const plugin = await read("plugins/opencode/assets/team-work.js")
  const guide = await read("plugins/opencode/guides/team-work.md")

  assert.match(plugin, /team_work_wait/)
  assert.match(plugin, /最长 30 秒/)
  assert.match(guide, /ready[^。\n]*不表示[^。\n]*验收/)
  assert.match(guide, /待同步[^]*不复制成员正文/)
  assert.match(guide, /不会[^。\n]*第二套调度队列|不会[^。\n]*自动推进 Workflow/)
})

test("OpenCode exposes a strongly typed work-item creation tool before managed spawn", async () => {
  const plugin = await read("plugins/opencode/assets/team-work.js")
  const guide = await read("plugins/opencode/guides/team-work.md")
  const genericCommands = plugin.slice(plugin.indexOf("const runtimeCommands"), plugin.indexOf("const contextFor"))
  assert.match(plugin, /team_work_work_create:\s*tool\(/)
  assert.match(plugin, /workItemId:\s*args\.work_item_id/)
  assert.match(plugin, /artifactPaths:\s*args\.artifact_paths/)
  assert.match(plugin, /doneWhen:\s*args\.done_when/)
  assert.doesNotMatch(genericCommands, /"work\.create"/)
  assert.match(guide, /team_work_work_create.*work\.start.*team_work_spawn/s)
})

test("new implementation documents have valid local links", async () => {
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

test("README is the single user guide with intro, quick start, and one fixed config", async () => {
  const usage = await read("README.md")
  const report = await read("docs/validation/opencode-real-gateway-2026-08-11.md")
  const evidence = JSON.parse(await read("docs/validation/opencode-real-gateway-2026-08-11.json"))
  const quickStart = usage.slice(usage.indexOf("## QuickStart"), usage.indexOf("## 使用说明"))
  const faq = usage.slice(usage.indexOf("## 常见问题"))
  assert.ok(usage.indexOf("## 简介") < usage.indexOf("## QuickStart"))
  assert.ok(usage.indexOf("## QuickStart") < usage.indexOf("## 使用说明"))
  assert.ok(usage.indexOf("## 使用说明") < usage.indexOf("## 成本控制与团队分档"))
  assert.ok(usage.indexOf("## 成本控制与团队分档") < usage.indexOf("## 工作流"))
  assert.match(usage, /npx team-work-runtime@latest install/)
  assert.match(quickStart, /全局插件目录[^。\n]*tui\.json[^。\n]*不会修改[^。\n]*opencode\.json/i)
  assert.match(usage, /~\/\.config\/team-work\/config\.json/)
  assert.match(usage, /首次调用.*`.team-work\/`/s)
  assert.match(usage, /TEAM_WORK_CONFIG_HOME/)
  assert.match(usage, /%APPDATA%/)
  assert.match(usage, /Junior.*Senior.*Expert/s)
  assert.equal([...usage.matchAll(/flowchart TB/g)].length, 2)
  assert.match(usage, /OpenSpec 与工作流/)
  assert.match(usage, /auto.*required.*disabled/s)
  assert.match(usage, /E2E 小循环/)
  assert.match(usage, /挑战者参与每一轮/)
  assert.match(usage, /Lead[^。\n]*(?:不得|不)[^。\n]*(?:具体工作|具体内容)/)
  assert.match(usage, /solo[^。\n]*(?:单一|一个)[^。\n]*Owner/i)
  assert.match(usage, /核心[^。\n]*(?:Expert|专家)[^。\n]*(?:裁决|把关)|(?:Expert|专家)[^。\n]*核心[^。\n]*(?:裁决|把关)/)
  assert.match(usage, /三轮[^。\n]*用户[^。\n]*追加轮次/)
  assert.match(usage, /同一 work item[^。\n]*(?:同一|复用)[^。\n]*(?:session|会话)/i)
  assert.match(usage, /"\$schema"/)
  assert.doesNotMatch(usage, /schemaVersion/)
  assert.match(usage, /"effort"/)
  assert.match(usage, /"helper"/)
  assert.match(usage, /team-work-explore.*team-work-librarian/s)
  assert.match(usage, /reasoningEffort/)
  assert.match(usage, /\/workflow/)
  assert.match(usage, /\/team-work/)
  assert.match(usage, /任意阶段/)
  assert.match(usage, /查看或继续任务/)
  assert.match(usage, /修改配置后只需重启 OpenCode/)
  assert.match(usage, /team-work-runtime@latest disable/)
  assert.match(usage, /team-work-runtime@latest enable/)
  assert.match(usage, /停用[^。\n]*保留[^。\n]*(?:配置|任务|\.team-work)/)
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
