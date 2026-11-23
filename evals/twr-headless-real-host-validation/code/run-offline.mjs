// 仅运行 TWR Node CLI 及本仓库自动测试；不是实机启动器，不加载 DSH 或真实 profile。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const code = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(code, '../../..')
const mode = process.argv[2]
assert.ok(process.argv.length === 3 && ['cli', 'suite'].includes(mode), '用法：node run-offline.mjs cli|suite')
assert.equal(realpathSync(code), path.join(realpathSync(repo), 'evals/twr-headless-real-host-validation/code'), '拒绝非授权产物目录')
const scratch = mkdtempSync(path.join(code, '.offline-'))
const snapshot = path.join(scratch, 'source')
const home = path.join(scratch, 'home')
const tmp = path.join(scratch, 'tmp')
const packageRoots = ['package.json', 'README.md', 'LICENSE', 'cordis.patch.yml', 'bin', 'dsh', 'runtime-v3', 'policy', 'workflow', 'team-work', 'skills', 'spec-providers']
const dependencies = ['node_modules/@deepseek-ai/schemastery', 'node_modules/@deepseek-ai/cosmokit', 'node_modules/@standard-schema/spec']
export const sha = (value) => createHash('sha256').update(value).digest('hex')
function manifest(root, inputs) {
  const result = {}
  function scan(rel) {
    const p = path.join(root, rel)
    const info = lstatSync(p)
    assert.equal(realpathSync(p), p, '闭包内不接受符号链接：' + rel)
    if (info.isDirectory()) for (const name of readdirSync(p).sort()) scan(path.join(rel, name))
    else {
      assert.ok(info.isFile(), '只接受普通文件：' + rel)
      result[rel] = sha(readFileSync(p))
    }
  }
  for (const rel of inputs) scan(rel)
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
}
const redact = (text) => String(text).replaceAll(scratch, '<SCRATCH>').replaceAll(repo, '<REPO>').replaceAll(process.execPath, '<NODE>')
const emit = (event) => console.log(redact(JSON.stringify(event)))
const target = { provider: 'fixture-provider', model: 'fixture-model', effort: 'max' }
// 只构造必要变量；没有真实凭据或 DSH 启动参数。
const env = {
  PATH: '/usr/bin:/bin', HOME: home, TMPDIR: tmp, TZ: 'UTC',
  TW_CMD: 'tw', TW_DSH_CONFIG: JSON.stringify({ profile: 'offline-fixture', entryId: 'team-work-dsh', tiers: { junior: target, senior: target, expert: target } }),
}
function node(args, cwd, timeout = 15000) {
  const r = spawnSync(process.execPath, args, { cwd, env, timeout, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  assert.ifError(r.error)
  assert.equal(r.signal, null, '子进程未正常退出')
  return r
}
try {
  for (const dir of [home, tmp, snapshot]) mkdirSync(dir)
  // 夹具与既有测试固定在这个副本，排除真实任务目录、配置、安装插件和历史评测数据。
  const inputs = mode === 'suite' ? [...packageRoots, ...dependencies, 'tests'] : packageRoots
  const source = realpathSync(repo)
  const before = manifest(source, inputs)
  for (const rel of inputs) {
    const dest = path.join(snapshot, rel)
    mkdirSync(path.dirname(dest), { recursive: true })
    cpSync(path.join(source, rel), dest, { recursive: true, errorOnExist: true, force: false })
  }
  const copied = manifest(realpathSync(snapshot), inputs)
  assert.deepEqual(copied, before, '工作树与测试副本逐文件字节摘要一致')
  const packageManifest = Object.fromEntries(Object.entries(copied).filter(([file]) => packageRoots.some(root => file === root || file.startsWith(root + '/'))))
  emit({ type: 'snapshot', mode, version: JSON.parse(readFileSync(path.join(snapshot, 'package.json'))).version, node: process.version, platform: process.platform, arch: process.arch, packageFiles: Object.keys(packageManifest).length, packageSha256: sha(JSON.stringify(packageManifest)), inputSha256: sha(JSON.stringify(copied)), keyFiles: Object.fromEntries(['bin/tw.mjs','runtime-v3/cli.mjs','dsh/tw-dispatch.js','dsh/subagent-session.js','runtime-v3/twr-framework-architecture-design.md'].map(f => [f, copied[f]])) })
  if (mode === 'suite') {
    // 真实宿主测试缺 DSH_TEST_HOST 时由原用例跳过；历史评测驱动和整仓静态合同不属于此离线副本。
    const excluded = ['evals-harness.test.mjs','repository-contract.test.mjs']
    const files = readdirSync(path.join(snapshot, 'tests')).filter(f => f.endsWith('.test.mjs') && !excluded.includes(f)).sort()
    emit({ type: 'suite', files, excluded, hostEnvPassed: false })
    const r = node(['--test','--test-reporter=tap', ...files.map(f => 'tests/' + f)], snapshot, 120000)
    process.stdout.write(redact(r.stdout))
    process.stderr.write(redact(r.stderr))
    emit({ type: 'suite-exit', status: r.status })
    process.exitCode = r.status
  } else {
    const { runCases } = await import('./cli-cases.mjs')
    const project = (name) => {
      assert.match(name, /^[a-z0-9-]+$/)
      const p = path.join(scratch, name)
      mkdirSync(p)
      return p
    }
    const cli = (cwd, step, argv) => {
      const r = node([path.join(snapshot, 'bin/tw.mjs'), ...argv], cwd)
      const raw = r.stdout || r.stderr
      const output = JSON.parse(raw)
      emit({ type: 'cli', step, argv, status: r.status, output, ...(r.stdout && r.stderr ? { stderr: r.stderr } : {}) })
      assert.equal(r.status, output.ok === false ? 1 : 0, step + ' 的退出码与公开回执一致')
      return output
    }
    const p = project('inheritance-probe')
    const grandchild = 'import { writeFileSync } from "node:fs"; writeFileSync("grandchild.txt", process.env.HOME, { flag: "wx" });'
    const child = node(['--input-type=module', '-e',
      'import { spawnSync } from "node:child_process"; import { writeFileSync } from "node:fs"; ' +
      'writeFileSync("child.txt", "child", { flag: "wx" }); ' +
      'const r=spawnSync(process.execPath,["--input-type=module","-e",' + JSON.stringify(grandchild) +
      '], { stdio: "inherit" }); process.exitCode=r.status ?? 1;'], p)
    assert.equal(child.status, 0, child.stderr)
    assert.equal(readFileSync(path.join(p, 'child.txt'), 'utf8'), 'child')
    assert.equal(readFileSync(path.join(p, 'grandchild.txt'), 'utf8'), home)
    emit({ type: 'offline-inheritance', childWroteFixture: true, grandchildWroteFixture: true, grandchildInheritedSyntheticHome: true, provesHostIsolation: false })
    process.exitCode = await runCases({ cli, project, home, sha, emit })
  }
  assert.deepEqual(manifest(source, inputs), before, '试验所取源文件前后字节不变')
  assert.deepEqual(manifest(realpathSync(snapshot), inputs), copied, '试验所取包/测试文件在副本内也未漂移')
  emit({ type: 'source-recheck', sourceUnchanged: true, snapshotUnchanged: true })
} catch (error) {
  process.stderr.write(redact(error.stack ?? error) + '\n')
  process.exitCode = 1
} finally {
  assert.equal(path.dirname(realpathSync(scratch)), code, '只清理本次创建的专用目录')
  assert.ok(path.basename(scratch).startsWith('.offline-'))
  // 归档用例会故意将其合成档案设为只读；恢复本次临时目录的 owner 写位，仅用于删除它。
  function prepareCleanup(dir) {
    assert.equal(realpathSync(dir), dir, '清理不跟随符号链接')
    const info = lstatSync(dir)
    if (!(info.mode & 0o200)) chmodSync(dir, (info.mode & 0o777) | 0o200)
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) prepareCleanup(path.join(dir, entry.name))
    }
  }
  prepareCleanup(scratch)
  rmSync(scratch, { recursive: true })
  emit({ type: 'cleanup', removedOwnScratch: true })
}
