// 只在物理 /tmp 下新建会话目录；不启动 Web，不使用 PATH 上的 dsh。
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { userInfo } from 'node:os'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { code, repo, task, profile, keyEnv, target, tiers, modelTuple, sha, readJson, jsonNew, within, physical, tree, anchor, sourceInputs, dependencyInputs, confirmAnchor, plans } from './shared.mjs'
import { assertProbe, verifyNoModelTrace, verifySessions, verifyIntake, verifyChain, verifyFinal, approvalFor, approvalInput, approvalSources, pending as pendingCard } from './verify.mjs'

const [mode, electronArg, entryArg, nodeArg] = process.argv.slice(2)
const automatic = mode === 'live-auto'
if (!['probe','live','live-auto'].includes(mode) || process.argv.length !== (automatic ? 6 : 5) ||
    !path.isAbsolute(electronArg ?? '') || !path.isAbsolute(entryArg ?? '') || (automatic && !path.isAbsolute(nodeArg ?? ''))) {
  console.error('用法：node run.mjs probe|live <Electron> <DSH lib/bin.js>；或 ELECTRON_RUN_AS_NODE=1 <Electron> run.mjs live-auto <Electron> <DSH lib/bin.js> <Node>（均用绝对路径）')
  process.exit(2)
}
process.umask(0o077)
assert.equal(process.platform, 'darwin', '只验收 macOS 原生 Seatbelt 宿主')
assert.ok(Number(process.versions.node.split('.')[0]) >= 24, '需要 Node 24 或更高版本')
assert.ok(process.getuid() > 0, '不允许 sudo/root 执行')
const home = realpathSync(userInfo().homedir)
assert.equal(realpathSync(process.env.HOME), home, '调用终端 HOME 与当前账号目录不同；不猜真实 HOME')
const tmpParent = realpathSync('/tmp')
assert.ok(!within(repo, tmpParent) && !within(home, tmpParent) && !within(tmpParent, home) && !within(tmpParent, repo), '真实仓库与 HOME 均须在 Seatbelt 的临时目录授权之外')
assert.ok(physical(path.join(repo, 'package.json')).isFile() && physical(path.join(repo, 'bin/tw.mjs')).isFile())
const electron = realpathSync(electronArg)
const entry = path.normalize(entryArg)
assert.equal(path.basename(entry), 'bin.js')
const node = automatic ? realpathSync(nodeArg) : process.execPath
const usable = value => typeof value === 'string' && value !== '' && value.trim() === value && !/[\r\n\0]/.test(value)
let secret = mode === 'live' ? process.env[keyEnv] : undefined
if (mode !== 'probe') {
  assert.equal(spawnSync('zstd', ['--version'], { timeout: 5000 }).status, 0, 'live 需要可用的 zstd 命令，先完成安装确认')
  if (automatic) {
    assert.ok(process.env.ELECTRON_RUN_AS_NODE === '1' && realpathSync(process.execPath) === electron && node !== electron,
      'live-auto 需用指定 Electron 的 Node 模式复用原生凭据解析器，并另外提供 Node 可执行文件')
    const v = spawnSync(node, ['--version'], { env: { PATH: '/usr/bin:/bin' }, timeout: 5000, encoding: 'utf8' })
    assert.ok(v.status === 0 && Number(/^v(\d+)\./.exec(v.stdout ?? '')?.[1]) >= 24, '探针和只读 CLI 需要独立 Node 24+')
  } else {
    assert.ok(process.stdin.isTTY && process.stdout.isTTY, 'live 必须交互运行；不从管道接受人工批准')
    assert.ok(usable(secret), '请先由操作者在环境变量 ' + keyEnv + ' 提供专用凭据')
  }
}
const base = mkdtempSync(path.join(tmpParent, 'twr-headless-e2e-'))
const evidence = mkdir('evidence'), project = mkdir('project'), isolatedHome = mkdir('home'), temp = mkdir('temp')
const dshHome = path.join(isolatedHome, '.dsh')
const profileDir = path.join(dshHome, 'profiles', profile)
const modules = path.join(profileDir, 'node_modules'), runtime = path.join(modules, 'team-work-runtime')
const patch = path.join(profileDir, 'cordis.patch.yml'), manifestFile = path.join(profileDir, 'package.json')
const snapshots = [...sourceInputs, ...dependencyInputs]
const packageRoots = tree(repo, sourceInputs)
confirmAnchor(packageRoots)
const depRoots = tree(repo, dependencyInputs)
const expected = { ...packageRoots, ...depRoots }
mkdirSync(runtime, { recursive: true })
assert.deepEqual(tree(repo, sourceInputs, runtime), packageRoots, '复制期间源码漂移')
assert.deepEqual(tree(repo, dependencyInputs, runtime), depRoots, '复制期间依赖漂移')
// 只建独立包目录；不为任一 Owner 预置内容。
for (const pack of ['alpha','beta']) mkdirSync(path.join(project,'artifacts',pack),{recursive:true})
const scenarioPath = path.join(project, 'SCENARIO.md')
const scenario = readFileSync(path.join(code, 'scenario.md'))
writeFileSync(scenarioPath, scenario, { flag: 'wx' })
jsonNew(manifestFile, { name: 'dsh-profile-eval-headless', private: true, dependencies: { 'team-work-runtime': 'file:node_modules/team-work-runtime' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base','@deepseek-ai/dsh-headless','team-work-runtime'] } } })
// 不继承真实 profile、系统代理、应用会话选项、权限覆盖或其他密钥。
jsonNew(patch, [
  { id: 'llm-pi-ai', config: { providers: { [target.provider]: { apiKeyEnv: keyEnv } } } },
  { id: 'agent-default-model', config: target }, { id: 'team-work-dsh', config: { tiers } },
  ...['session-title-llm','session-telemetry-otel','tool-web','tool-goal','goal-round-driver','command-goal','plugin-manager'].map(id => ({ id, disabled: true })),
  { id: 'sandbox-policy', config: { mode: 'workspace-write', workspaceRoot: project } },
  { id: 'approval', config: { policy: 'never' } },
  { id: 'permission', config: { defaultPreset: 'workspace-write', presets: { 'workspace-write': { sandbox: 'workspace-write', approval: 'never' } } } },
])
const env = {
  PATH: [path.dirname(node), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'), HOME: isolatedHome, DSH_HOME: dshHome,
  TMPDIR: temp, TMP: temp, TEMP: temp, TZ: 'UTC', DSH_TELEMETRY_DISABLED: '1', DSH_PERMISSION_MODE: 'workspace-write', ELECTRON_RUN_AS_NODE: '1',
}
const redactKey = s => secret ? s.replaceAll(JSON.stringify(secret).slice(1, -1), '<SECRET>').replaceAll(secret, '<SECRET>') : s
const redact = s => redactKey(String(s)).replaceAll(repo, '<REPO>').replaceAll(home, '<HOME>')
const raw = (name, s) => writeFileSync(path.join(evidence, name), s, { flag: 'wx', mode: 0o600 })
const log = (name, o) => raw(name + '.json', redactKey(JSON.stringify(o, null, 2)) + '\n')
console.log('隔离证据目录：' + base)
const version = spawnSync(electron, [entry, '--version'], { cwd: project, env, encoding: 'utf8', timeout: 15000 })
assert.equal(version.status, 0, redact(version.stderr ?? '无法读取 DSH 版本'))
assert.match(version.stdout.trim(), /^0\.2\.2-rc\.5$/, '此启动接缝已按 0.2.2-rc.5 源码核验，拒绝未核验版本')
const fingerprints = { patch: sha(readFileSync(patch)), profile: sha(readFileSync(manifestFile)), scenario: sha(scenario) }
function verifyFiles() {
  for (const p of [base, project, isolatedHome, dshHome, profileDir, evidence, runtime]) assert.ok(physical(p).isDirectory())
  assert.deepEqual({ ...tree(repo, sourceInputs), ...tree(repo, dependencyInputs) }, expected, '批准源码或依赖漂移')
  assert.deepEqual({ ...tree(runtime, sourceInputs), ...tree(runtime, dependencyInputs) }, expected, '加载副本或依赖漂移')
  assert.equal(sha(readFileSync(patch)), fingerprints.patch)
  assert.equal(sha(readFileSync(manifestFile)), fingerprints.profile)
  assert.equal(sha(readFileSync(scenarioPath)), fingerprints.scenario)
  for (const p of [patch, manifestFile, scenarioPath]) assert.ok(physical(p).isFile())
  for (const p of [path.join(dshHome, 'cordis.patch.yml'), path.join(project, '.env'), path.join(isolatedHome, '.env'), path.join(dshHome, '.credentials.yaml')]) {
    assert.throws(() => lstatSync(p), { code: 'ENOENT' }, '检测到不期望的配置或凭据覆盖：' + path.basename(p))
  }
}
log('build', { dshVersion: version.stdout.trim(), version: readJson(path.join(runtime, 'package.json')).version, node: process.version,
  packageFiles: Object.keys(packageRoots).length, packageSha256: sha(JSON.stringify(packageRoots)), keys: anchor, dependenciesSha256: sha(JSON.stringify(depRoots)), fingerprints, model: target })

function mkdir(rel) { const p = path.join(base, rel); mkdirSync(p, { mode: 0o700 }); return p }
async function loadTestCredential() {
  // 仅显式 live-auto 且通过独立探针后执行。复用宿主的只读解析函数，不启动存储服务或触发旧版迁移。
  const file = path.join(home, '.dsh', '.credentials.yaml')
  try {
    const { parseCredentialsDocument } = await import(pathToFileURL(createRequire(entry).resolve('@deepseek-ai/dsh-credentials-local')).href)
    assert.ok(physical(path.dirname(file)).isDirectory())
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const s = fstatSync(fd)
      assert.ok(s.isFile() && s.nlink === 1 && s.uid === process.getuid() && (s.mode & 0o077) === 0 && s.size <= 1024 * 1024)
      const key = parseCredentialsDocument(readFileSync(fd, 'utf8'), file).refs.get('ZAI_CODING_CN_API_KEY')
      assert.ok(usable(key))
      return key
    } finally { closeSync(fd) }
  } catch (e) {
    const denied = e?.code === 'EACCES' || e?.code === 'EPERM'
    // 错误对象可能包含 YAML 文本，禁止记录原错误或堆栈。
    throw new Error(denied ? '系统拒绝读取授权凭据引用，不尝试其他入口' : '无法从授权的本机私有凭据文件解析固定引用；不尝试其他凭据')
  }
}
function runRead(action, tag) {
  assert.ok(['roles','run','gate'].includes(action), '外部验证器不能代替 Lead 写 TWR')
  const r = spawnSync(node, [path.join(runtime, 'bin/tw.mjs'), action, '--task', task], {
    cwd: project, encoding: 'utf8', timeout: 15000, env: { ...env, ELECTRON_RUN_AS_NODE: '', TW_DSH_CONFIG: JSON.stringify({ tiers, entryId: 'team-work-dsh', profile }) },
  })
  assert.equal(r.status, 0, redact(r.stderr || r.stdout))
  const result = JSON.parse(r.stdout)
  log(tag, result)
  assert.equal(result.ok, true, '公开只读状态查询失败：' + action)
  return result
}
let submissions = 0
let activeChild
const stop = (signal = 'SIGTERM') => { if (activeChild?.pid) { try { process.kill(-activeChild.pid, signal) } catch (e) { if (e.code !== 'ESRCH') throw e } } }
const onSignal = () => { stop(); process.exitCode = 130; process.stdin.destroy() }
process.on('SIGINT', onSignal)
process.on('SIGTERM', onSignal)
async function turn(tag, prompt, session) {
  verifyFiles()
  const nonce = randomBytes(16).toString('hex')
  const p = { nonce, home, repo, project, isolatedHome, model: modelTuple(target) }
  const encoded = Buffer.from(JSON.stringify(p)).toString('base64url')
  const child = spawn(electron, [path.join(code, 'host-bridge.mjs'), entry, path.join(code, 'write-probe.cjs'), node, encoded, prompt ? 'live' : 'probe', ...(session ? [session] : [])], {
    cwd: project, env: prompt ? { ...env, [keyEnv]: secret } : env, detached: true, stdio: ['pipe','pipe','pipe','pipe'],
  })
  activeChild = child
  let stdout = '', stderr = '', native = '', proof = null, failure, sent = false
  let alarm, killTimer
  const abort = (error) => {
    failure ??= error
    stop(); killTimer ??= setTimeout(() => stop('SIGKILL'), 3000)
  }
  const timer = (ms) => { clearTimeout(alarm); alarm = setTimeout(() => abort(new Error('宿主阶段超时：' + tag)), ms) }
  timer(60000)
  const buffers = [child.stdout, child.stderr, child.stdio[3]]
  for (const stream of buffers) stream.setEncoding('utf8')
  buffers[0].on('data', (s) => { stdout += s; if (stdout.length > 24e6) abort(new Error('宿主输出超过保留上限')) })
  buffers[1].on('data', (s) => { stderr += s; if (stderr.length > 2e6) abort(new Error('宿主诊断超过保留上限')) })
  child.stdin.on('error', abort)
  buffers[2].on('data', (s) => {
    native += s
    if (native.length > 64000) return abort(new Error('预检通道超出协议长度'))
    if (!native.includes('\n') || failure) return
    try {
      if (proof || native.trim().includes('\n')) throw new Error('预检通道提供多份结果')
      proof = JSON.parse(native.trim())
      assertProbe(proof, nonce)
      if (prompt) {
        verifyFiles()
        assert.equal(process.exitCode ?? 0, 0, '操作者已停止')
        console.log('原生 workspace-write 已核验；提交本次提示：' + tag)
        sent = true; submissions++
        timer(tag === 'work' ? 45 * 60000 : 5 * 60000)
        child.stdin.end(prompt)
      } else {
        // runProfile 的 headless 正等 stdin；证明到达后关闭空管道，让宿主正常退出，不送任何任务。
        child.stdin.end()
      }
    } catch (error) { abort(error) }
  })
  const closed = await new Promise(resolve => {
    child.once('error', error => { failure ??= error })
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
  })
  activeChild = undefined
  clearTimeout(alarm); clearTimeout(killTimer)
  raw(tag + '.jsonl', redact(stdout)); raw(tag + '.stderr', redact(stderr)); raw(tag + '.probe.jsonl', redact(native))
  log(tag + '.status', { ...closed, promptReleased: sent, passedProbe: Boolean(proof && !failure), error: failure ? redact(failure.message) : null })
  if (failure) throw new Error(redact(failure.message))
  assert.equal(closed.exitCode, 0, '宿主退出非零（见 ' + tag + '.stderr）')
  assert.ok(proof, '没有通过私有通道收到原生预检结果')
  verifyFiles()
  if (!prompt) {
    verifyNoModelTrace(stdout,dshHome)
    return
  }
  assert.ok(sent, '提示未放行')
  const events = stdout.trim().split('\n').map(line => JSON.parse(line))
  assert.ok(events.some(x => x.type === 'final'), '缺失 headless 正式尾事件')
  const top = events.find(x => x.type === 'session')?.sessionId ?? session
  assert.ok(typeof top === 'string' && /^session-[a-f0-9-]+$/.test(top), '缺失正式顶层会话 ID')
  if (session) assert.equal(top, session, '必须冷启动同一个顶层会话')
  return top
}
const approvalSource = automatic ? approvalSources.test : approvalSources.terminal
async function approve(card, kind) {
  // 只有上一回合已退出，且调用方完成原生停门核验之后，才可能到此处。
  const a = approvalFor(card, kind, approvalSource)
  const pending = pendingCard(card)
  assert.equal(process.exitCode ?? 0, 0, '操作者已停止')
  if (automatic) console.log('已核验真实待决卡，提交合成演练测试输入：' + a.phrase)
  else {
    console.log(redact(pending.question ?? card.question ?? ('待审批：' + kind)))
    for (const c of pending.choices) console.log(redact(String(c.n) + '. ' + c.label + ' ' + (c.desc ?? '')))
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    let answer
    rl.on('SIGINT', () => { onSignal(); rl.close() })
    try { answer = await rl.question('核对后请完整输入「' + a.phrase + '」；其他回答均留门停止：') } finally { rl.close() }
    assert.equal(answer, a.phrase, '没有收到当前卡的明确批准；不送入模型、不作答')
  }
  assert.equal(process.exitCode ?? 0, 0)
  log('human-' + kind, { id: a.id, choice: a.n, explicitPhrase: a.phrase, source: a.source, at: new Date().toISOString() })
  return a
}
const initial = '你是这次隔离演练的 Lead。先用 skill 加载 team-work-v3（已注册的 TWR 技能名称以实际目录为准），再用原生 tw help；读取当前项目 SCENARIO.md。这里只开一个任务：tw open --name ' + task + ' --entry code-review；同时提交 --raw-requirement 原文「执行隔离项目 SCENARIO.md 所述的双包登记审查、按包返工和人工门，不修改非测试数据」，目标和边界依场景。随后原生 tw plan --task ' + task + ' --packages 的 JSON 精确用 ' + JSON.stringify(plans) + '。把 SCENARIO.md 作为所有角色的必须阅读输入；任务目标/范围只引用该文件并声明只写合成制品及按轮次试验，请勿在目标或约束复述具体制品路径与 CH/EX/CTX 标记，以免混淆派单中的实际清单和原文证据。原生 tw-dispatch 签发意图卡，核对角色和两个包的精确模型；只呈卡并停，不调用 decide，不派发成员直到下一条操作者消息。'
function emptyArtifacts(tag) {
  const counts=['alpha','beta'].map(pack=>Object.keys(tree(path.join(project,'artifacts',pack),['.'])).length)
  assert.deepEqual(counts,[0,0],'正式成员首次派发前不得已存在制品')
  log(tag,{alpha:0,beta:0})
}
const approvalPrompt = (a, final) => approvalInput(a) + '只用原生 tw decide --task ' + task + ' --decision-id ' + a.id + ' --choice ' + a.n + ' 回答此卡，再用原生 tw-dispatch 推进。' + (final ? '只收尾出完成卡，不归档。' : '按 SCENARIO.md 贯通真实双包。正常派发后结束回合等原生通知；收到真实结算再推进。只向成员原样传递工具派单（不代写、代 deliver/review）。如显式 E2E 路由需要，基于合成文本无应用的依据跳过；最后签发当前人工验收卡并停下，不代答。')

try {
  await turn('isolation', null)
  if (mode === 'probe') console.log('原生隔离预检通过；未提交任何模型提示。')
  else {
    if (automatic) secret = await loadTestCredential()
    emptyArtifacts('artifacts-before-intake')
    const top = await turn('intake', initial)
    const roles = runRead('roles','initial-roles')
    const intake = runRead('run','intake-card')
    verifyIntake({ state: intake, roles, sessions: verifySessions(dshHome, project), top })
    emptyArtifacts('artifacts-before-dispatch')
    const start = await approve(intake, 'intake')
    await turn('work', approvalPrompt(start, false), top)
    const gate = runRead('run','final-card')
    const stateGate = runRead('gate','gate-before-human')
    assert.equal(stateGate.passed, false, '待真实操作员决定前不得过门')
    const chain = verifyChain({ sessions: verifySessions(dshHome, project), project, top, start, gate })
    log('chain-before-human', chain)
    const end = await approve(gate, 'final')
    await turn('complete', approvalPrompt(end, true), top)
    const verified = verifyFinal({ sessions: verifySessions(dshHome, project), project, top, start, gate, end,
      status: runRead('run','completed'), finalGate: runRead('gate','gate-after-human') })
    log('verified', { ...verified, fingerprint: sha(JSON.stringify(packageRoots)), modelPromptSubmissions: submissions })
    console.log('双包真实链路与最终人工门已核验；证据见 evidence/verified.json 和原始会话日志。')
  }
  verifyFiles(); log('recheck', { sourceAndLoadUnchanged: true, modelPromptSubmissions: submissions, ...(mode === 'probe' ? {} : { approvalSource }) })
} catch (e) {
  console.error('验收停止：' + redact(e.message) + '；未完成项不得计为通过。')
  log('stopped', { error: redact(e.message), modelPromptSubmissions: submissions })
  if ((process.exitCode ?? 0) === 0) process.exitCode = 2
} finally {
  process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal)
}
