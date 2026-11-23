// 可信启动端：复用安装宿主 dsh CLI 的同一 runProfile 和 headless runner，绝不提前写入模型任务。
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { writeSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { verifyNativeEntries } from './native-guard.mjs'
import { assertNativeFacts } from './verify.mjs'

const [entry, probeFile, node, encoded, mode, session] = process.argv.slice(2)
const p = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
const { runProfile } = await import(pathToFileURL(path.join(path.dirname(entry), 'profile-boot.js')).href)
const requireHost = createRequire(entry)
const { loadLayeredEnv } = await import(pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-app-boot')).href)
const emit = (x) => writeSync(3, JSON.stringify({ nonce: p.nonce, ...x }) + '\n')
const quote = (s) => "'" + s.replaceAll("'", "'\"'\"'") + "'"
let running
try {
  const args = ['--permission-mode', 'workspace-write', '--approval-policy', 'never', '--json', ...(session ? ['--session-id', session] : []), '-']
  running = await runProfile({ environment: loadLayeredEnv('dsh'), profile: 'eval-headless', patchFiles: [], args })
  const { ctx } = running
  const startup = ctx.get('headlessStartup')
  const profileState = ctx.get('profileContext')
  assert.equal(profileState?.home, process.env.DSH_HOME, '宿主未以独立 DSH_HOME 启动')
  assert.equal(profileState?.name, 'eval-headless')
  assert.ok(profileState?.startedBundles.includes('team-work-runtime'), '待测 TWR bundle 没有装配')
  const subagents = ctx.get('subagents'), tools = ctx.get('tools')
  assert.ok(subagents && ctx.get('sessionPersistence') && tools, '原生子会话、持久化或工具服务缺失')
  for (const n of ['bash','tw','tw-dispatch','skill']) assert.ok(tools.get(n), '原生工具未注册：' + n)
  assert.equal(startup.task, '-', 'headless 必须等待父进程 stdin，不得已有提示词')
  assert.equal(startup.permissionMode, 'workspace-write')
  assert.equal(startup.approvalPolicy, 'never')
  const policy = ctx.get('sandboxPolicy').resolve()
  assert.equal(policy.mode, 'workspace-write')
  assert.equal(policy.workspaceRoot, p.project)
  assert.equal(policy.additionalWritableRoots?.length ?? 0, 0)
  const selection = ctx.get('agentDefaultModel').currentSelection()
  assert.deepEqual([selection.provider, selection.model, selection.reasoningEffort], p.model, '顶层配置不是指定模型/强度，不启动模型')
  const shell = ctx.get('shell')
  assert.equal(shell.sandboxMode, 'workspace-write')
  const argv = ['/usr/bin/env', '-i', 'HOME=' + p.isolatedHome, 'PATH=/usr/bin:/bin', node, probeFile, encoded]
  const result = await (await shell.execute(shell.resolve({ command: argv.map(quote).join(' '), workdir: p.project, sandboxPolicy: policy, timeoutMs: 15000 }))).result()
  // 与 TWR 原生首派用同一个本地精确解析方法；它不是模型请求，也不证明真实认证成功。
  assert.equal(result.sandbox?.enforcement,'full')
  const facts=JSON.parse(result.stdout.text)
  assertNativeFacts(facts,p.nonce,'shell')
  const nativeEntries=await verifyNativeEntries(ctx,p,profileState.dir,fileURLToPath(new URL('./cli-entry.mjs',import.meta.url)),policy,assertNativeFacts)
  const llm = ctx.get('llm')
  const resolved = await llm.resolveCallConfig({ provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort })
  assert.deepEqual([resolved?.provider, resolved?.model, resolved?.reasoningEffort], p.model, '宿主不能精确解析内层模型/强度')
  emit({ type: 'native-probe', mode: policy.mode, enforcement: result.sandbox?.enforcement, exitCode: result.exitCode,
    timedOut: result.timedOut, aborted: result.aborted, stdoutTruncated: result.stdout.truncated, stderrTruncated: result.stderr.truncated,
    facts, nativeEntries, route: p.model, loadedBundle: true })
  if (mode === 'probe') await running.shutdown.shutdown(0)
} catch (error) {
  emit({ type: 'native-probe-error', code: error?.code ?? error?.name ?? 'ERROR', detail: String(error?.message ?? error).slice(0, 800) })
  if (running) await running.shutdown.shutdown(2)
  else process.exitCode = 2
}
