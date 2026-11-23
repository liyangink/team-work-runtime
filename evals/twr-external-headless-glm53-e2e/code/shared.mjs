import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync, mkdirSync, copyFileSync, writeFileSync, constants } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const code = path.dirname(fileURLToPath(import.meta.url))
export const repo = realpathSync(path.resolve(code, '../../..'))
export const task = 'sample-register'
export const profile = 'eval-headless'
export const keyEnv = 'TWR_E2E_GLM_KEY'
// 这是验收固定目标，不是从当前宿主配置推得的默认值。
export const target = { provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'max' }
export const tier = { provider: target.provider, model: target.model, effort: target.reasoningEffort }
export const tiers = { junior: tier, senior: tier, expert: tier }
export const modelTuple = (o) => [o?.provider, o?.modelName ?? o?.model, o?.effort ?? o?.reasoningEffort]
export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
export const jsonNew = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
export const within = (p, root) => p === root || p.startsWith(root + path.sep)
export const physical = (p) => { assert.equal(realpathSync(p), p, '路径含符号链接：' + path.basename(p)); return lstatSync(p) }
export const anchor = {
  'runtime-v3/intake.mjs': '26aeede8614e058ae84cd205b736c17306927e275bc242f194bb02c9ae731a1b',
  'runtime-v3/store.mjs': 'a9629280bf0d7559f42cc1415c4d48e709ecddd07fa4666767e99914fa11a3ae',
  'runtime-v3/waves.mjs': 'd9de8e2dedc677d1aa88f5f3b3f2ebebcfb1f2c1c4982e6d0eb0b9bf045a9241',
}
export const expectedPackageSha = 'ebec38d1a11694765b98062586fd7885bccc12a3595abf426d921d745d644587'
export const sourceInputs = ['package.json', 'README.md', 'LICENSE', 'cordis.patch.yml', 'bin', 'dsh', 'runtime-v3', 'policy', 'workflow', 'team-work', 'spec-providers', 'skills']
export const dependencyInputs = ['node_modules/@deepseek-ai/schemastery', 'node_modules/@deepseek-ai/cosmokit', 'node_modules/@standard-schema/spec']
export function tree(root, inputs, dest) {
  const files = {}
  function visit(rel) {
    const p = path.join(root, rel)
    const stat = physical(p)
    if (stat.isDirectory()) {
      if (dest) mkdirSync(path.join(dest, rel), { recursive: true })
      for (const entry of readdirSync(p).sort()) visit(path.join(rel, entry))
    } else {
      assert.ok(stat.isFile() && stat.nlink === 1, '只接受普通、非硬链接文件：' + rel)
      files[rel] = sha(readFileSync(p))
      if (dest) copyFileSync(p, path.join(dest, rel), constants.COPYFILE_EXCL)
    }
  }
  for (const input of inputs) visit(input)
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
}
export function confirmAnchor(manifest) {
  for (const [p, expected] of Object.entries(anchor)) assert.equal(manifest[p], expected, '不等于本轮验收快照（不自动放行）：' + p)
  assert.equal(sha(JSON.stringify(manifest)), expectedPackageSha, '整树不等于本轮测试源码；不得临时改脚本绕开')
}
export const paths = {
  main: 'artifacts/alpha/main.md', legacy: 'artifacts/alpha/legacy.md', index: 'artifacts/alpha/index.md', beta: 'artifacts/beta/main.md',
}
export const plans = [
  { id: 'alpha', writable: ['artifacts/alpha/:code-review'], done: ['按 SCENARIO.md 的本包轮次要求提交完整甲包审查清单'], dependsOn: [] },
  { id: 'beta', writable: ['artifacts/beta/:code-review'], done: ['按 SCENARIO.md 首次完整提交乙包审查清单'], dependsOn: [] },
]
