// 自动回填清理回归（定向委派第二阶段）：插件不再按标签回填 mappings——
// 续派映射唯一入口 = tw agent-map；带标签子代若无直接选择/header 回读则继承默认模型。
// 旧字段（tagHints/pendingTags）残留不再被读取（方案 §9 增量：不做旧字段只读兼容窗口）。
import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp as mkdt, readFile as rf, mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const { makeInjectContribution } = await import("../dsh/inject.js")

test("标签纯展示：带标签子代不注入、不回填（旧 tagHints/pendingTags 残留在场也不读）", async () => {
  const root = await mkdt(path.join(os.tmpdir(), "tw-cont-"))
  const taskRoot = path.join(root, ".team-work", "tasks", "demo-t")
  await mkdir(taskRoot, { recursive: true })
  const file = path.join(taskRoot, "agents.json")
  // 升级前任务的旧字段残留：读端已删，不再参与任何决策
  await writeFile(file, JSON.stringify({
    tagHints: { "CR·owner": { provider: "p", model: "m" } },
    pendingTags: { "CR·owner": "w2-abc" },
  }))
  const installs = []
  const warnings = []
  const contribution = makeInjectContribution({ logger: { info() {}, warn: (m) => warnings.push(String(m)) } }, {
    installerNow: () => (c, sel) => { installs.push(sel) },
  })
  const child = { agent: { id: "child-a", session: { header: { cwd: root }, events: [{ type: "subagent/descriptor", data: { label: "CR·owner · 审查 #demo-t" } }] } } }
  const disposer = contribution(child)
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(installs.length, 1, "install 注册监听器（无条件）")
  assert.equal(installs[0].current, undefined, "标签不再寻址：selection 保持不干预（默认模型）")
  const after = JSON.parse(await rf(file, "utf8"))
  assert.equal(after.mappings, undefined, "不再自动回填 mappings（唯一入口 tw agent-map）")
  assert.deepEqual(after.pendingTags, { "CR·owner": "w2-abc" }, "旧文件原样保留（读端无写入面）")
  disposer()
})
