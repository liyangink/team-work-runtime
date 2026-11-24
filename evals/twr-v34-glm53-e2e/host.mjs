// 通过本机 DSH 相同的 profile 启动器启动，私有 fd 只回报无凭据的隔离预检结果。
import assert from 'node:assert/strict'
import { writeSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const [entry, nonce, mode, session] = process.argv.slice(2)
const emit = value => writeSync(3, JSON.stringify({ nonce, ...value }) + '\n')
let running, observer
try {
  if (mode === 'pipe') observer = (await import('./pipe.mjs')).observePipe()
  const require = createRequire(entry)
  const { loadLayeredEnv } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)
  const { runProfile } = await import(pathToFileURL(path.join(path.dirname(entry), 'profile-boot.js')).href)
  const args = ['--permission-mode', 'workspace-write', '--approval-policy', 'never', '--json', ...(session ? ['--session-id', session] : []), '-']
  running = await runProfile({ environment: loadLayeredEnv('dsh'), profile: 'eval-v34', patchFiles: [], args })
  const { ctx } = running
  const profile = ctx.get('profileContext')
  const startup = ctx.get('headlessStartup')
  assert.equal(profile?.home, process.env.DSH_HOME, '未使用隔离 DSH_HOME')
  assert.equal(profile?.name, 'eval-v34')
  assert.ok(profile?.startedBundles.includes('team-work-runtime'), '未加载隔离 TWR bundle')
  assert.ok(ctx.get('subagents') && ctx.get('sessionPersistence'), '未装配原生子会话及持久化服务')
  const tools = ctx.get('tools')
  for (const name of ['tw','tw-dispatch','skill','read','write','send_message']) assert.ok(tools?.get(name), '工具缺失：' + name)
  assert.equal(startup.task, '-', '宿主必须先等待 stdin')
  assert.equal(startup.permissionMode, 'workspace-write')
  assert.equal(startup.approvalPolicy, 'never')
  const policy = ctx.get('sandboxPolicy').resolve()
  assert.equal(policy.mode, 'workspace-write')
  assert.equal(policy.workspaceRoot, process.cwd())
  assert.equal(policy.additionalWritableRoots?.length ?? 0, 0)
  const { provider, model, reasoningEffort } = ctx.get('agentDefaultModel').currentSelection()
  const route = [provider, model, reasoningEffort]
  assert.deepEqual(route, ['zai-coding-cn', 'glm-5.3', 'max'])
  const resolved = await ctx.get('llm').resolveCallConfig({ provider, model, reasoningEffort })
  assert.deepEqual([resolved?.provider, resolved?.model, resolved?.reasoningEffort], route, '宿主精确解析的模型不一致')
  assert.equal(Boolean(tools.get('bash')), false, '隔离剧本不需要 shell；不在 bash 开启时提交提示')
  const pipe = observer ? await (await import('./pipe.mjs')).probePipe(ctx, observer) : undefined
  observer?.restore()
  emit({ ok: true, mode: policy.mode, bundle: 'team-work-runtime', route, approval: startup.approvalPolicy, bashAvailable: false, ...(pipe ? { pipe } : {}) })
  if (mode === 'probe' || mode === 'pipe') await running.shutdown.shutdown(0)
} catch (error) {
  observer?.restore()
  // 不把 provider 配置、错误对象和堆栈写入预检通道。
  emit({ ok: false, error: error instanceof assert.AssertionError ? error.message.split('\n')[0] : 'DSH 装配失败' })
  if (running) await running.shutdown.shutdown(2)
  else process.exitCode = 2
}
