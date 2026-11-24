// 用已安装 Electron 的 Node 模式运行；只在 /tmp 部署可核对的当前工作区副本。
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { constants, readFileSync, writeFileSync, readdirSync, lstatSync, realpathSync, mkdirSync, mkdtempSync, copyFileSync, openSync, fstatSync, closeSync } from 'node:fs'
import { createRequire } from 'node:module'
import { userInfo } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const code = path.dirname(fileURLToPath(import.meta.url))
const repo = realpathSync(path.join(code, '../..'))
const [mode, entry, nodeArg] = process.argv.slice(2)
if (!['seam','probe','gap','live','round','retry','pipe'].includes(mode) || !path.isAbsolute(entry ?? '') || !path.isAbsolute(nodeArg ?? '') || process.argv.length !== 5) {
  console.error('用法：ELECTRON_RUN_AS_NODE=1 <DSH_ELECTRON> run.mjs seam|probe|gap|live|round|retry|pipe <DSH_ENTRY> <NODE24>（均为绝对路径）')
  process.exit(2)
}
assert.ok(process.platform === 'darwin' && process.getuid() !== 0 && process.env.ELECTRON_RUN_AS_NODE === '1' && process.versions.electron, '需要本机 macOS Electron 非 root 的 Node 模式')
process.umask(0o077)
const electron = process.execPath, node = realpathSync(nodeArg)
assert.notEqual(realpathSync(electron), node, '需另提供独立 Node')
assert.equal(path.basename(entry), 'bin.js')
const home = realpathSync(userInfo().homedir)
assert.equal(home, realpathSync(process.env.HOME), '调用者 HOME 与当前用户不一致')
const tmp = realpathSync('/tmp')
const within = (p, root) => p === root || p.startsWith(root + path.sep)
assert.ok(![repo, home].some(p => within(tmp, p) || within(p, tmp)), '/tmp 不得包含真实工作区或 HOME')
const base = mkdtempSync(path.join(tmp, 'twr-v34-' + mode + '-'))
const dir = (rel) => {
  const p = path.join(base, rel)
  mkdirSync(p, { recursive: true, mode: 0o700 })
  assert.ok(realpathSync(p) === p && lstatSync(p).isDirectory(), '隔离目录不符：'+rel)
  return p
}
const project = dir('project'), isolatedHome = dir('home'), temp = dir('temp'), evidence = dir('evidence')
const dshHome = path.join(isolatedHome, '.dsh'), profile = 'eval-v34', profileDir = dir('home/.dsh/profiles/' + profile)
const runtime = path.join(profileDir, 'node_modules/team-work-runtime')
const tw = path.join(runtime, 'bin/tw.mjs')
const target = { provider: 'zai-coding-cn', model: 'glm-5.3', reasoningEffort: 'max' }
const tier = { provider: target.provider, model: target.model, effort: target.reasoningEffort }
const tiers = { junior: tier, senior: tier, expert: tier }
const keyEnv = 'TWR_E2E_GLM_KEY'
const env = { PATH: [path.dirname(node),'/usr/bin','/bin','/usr/sbin','/sbin'].join(':'), HOME: isolatedHome,
  DSH_HOME: dshHome, TMPDIR: temp, TMP: temp, TEMP: temp, TZ: 'UTC', ELECTRON_RUN_AS_NODE: '1',
  DSH_TELEMETRY_DISABLED: '1', DSH_PERMISSION_MODE: 'workspace-write' }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const newFile = (file, bytes) => writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 })
const json = (name, value) => newFile(path.join(evidence, name + '.json'), JSON.stringify(value, null, 2) + '\n')
let secret
const redact = value => {
  const text = String(value).replaceAll(repo, '<REPO>').replaceAll(home, '<HOME>')
  return secret ? text.replaceAll(secret, '<SECRET>').replaceAll(JSON.stringify(secret).slice(1,-1), '<SECRET>') : text
}
console.log('隔离证据目录：' + path.join('/tmp', path.basename(base)))
const version = spawnSync(electron, [entry, '--version'], { cwd: project, env, encoding: 'utf8', timeout: 15000 })
assert.ok(version.status === 0 && version.stdout.trim() === '0.2.2-rc.5', '需本机 DSH 0.2.2-rc.5')
const metadata = { dsh: version.stdout.trim(), electron: process.versions.electron, electronNode: process.version, mode }
if (mode === 'seam') {
  const name = 'tests/dsh-plugin-e2e.test.mjs'
  const before = sha(readFileSync(path.join(repo, name)))
  const fds = ['tap.log','stderr.log'].map(n => openSync(path.join(evidence, n), 'wx', 0o600))
  let result
  try {
    result = spawnSync(electron, ['--test','--test-reporter=tap',name], { cwd: repo, timeout: 120000,
      env: { ...env, DSH_TEST_HOST: path.dirname(path.dirname(entry)) }, stdio: ['ignore', ...fds] })
  } finally { for (const fd of fds) closeSync(fd) }
  const stdout = readFileSync(path.join(evidence, 'tap.log'))
  const n = Object.fromEntries([...stdout.toString().matchAll(/^# (tests|pass|fail|skipped) (\d+)$/gm)].map(m => [m[1],Number(m[2])]))
  const unchanged = before === sha(readFileSync(path.join(repo, name)))
  json('seam', { ...metadata, ...n, exitCode: result.status, signal: result.signal, unchanged, testSha256: before, tapSha256: sha(stdout),
    stderrSha256: sha(readFileSync(path.join(evidence, 'stderr.log'))) })
  console.log(JSON.stringify(n))
  process.exit(unchanged && result.status === 0 && n.tests === 10 && n.pass === 10 && n.fail === 0 && n.skipped === 0 ? 0 : 1)
}

const manifest = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'))
const sources = ['package.json', ...manifest.files]
const dependencies = ['node_modules/@deepseek-ai/schemastery','node_modules/@deepseek-ai/cosmokit','node_modules/@standard-schema/spec']
function files(root, inputs, dest) {
  const entries = []
  function visit(rel) {
    const p = path.resolve(root, rel)
    assert.ok(within(p,root), '打包条目越出工作树')
    const s = lstatSync(p)
    assert.equal(realpathSync(p), p, '输入须为物理路径：' + rel)
    if (s.isDirectory()) {
      for (const sub of readdirSync(p).sort()) visit(path.join(rel, sub))
      return
    }
    assert.ok(s.isFile() && s.nlink === 1, '输入须为单链接普通文件：' + rel)
    entries.push([rel, sha(readFileSync(p))])
    if (dest) {
      mkdirSync(path.dirname(path.join(dest,rel)), { recursive: true })
      copyFileSync(p, path.join(dest,rel), constants.COPYFILE_EXCL)
    }
  }
  for (const input of inputs) visit(path.normalize(input).replace(/\/$/, ''))
  return Object.fromEntries(entries.sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0))
}
const inputs = [...sources, ...dependencies]
const snapshot = files(repo, inputs)
assert.deepEqual(files(repo, inputs, runtime), snapshot, '复制期间源码或依赖变化')
const digest = sha(JSON.stringify(files(runtime, sources)))
function verifyLoaded() {
  assert.deepEqual(files(runtime, inputs), snapshot, '加载副本发生变化')
}
verifyLoaded()
dir('project/artifacts')
const scenario = path.join(code, mode === 'retry' ? 'scenario-retry.md' : mode === 'round' ? 'scenario-round.md' : 'scenario.md')
const fixture = readFileSync(scenario)
newFile(path.join(project, 'SCENARIO.md'),fixture)
newFile(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-eval-v34', private: true,
  dependencies: { 'team-work-runtime': 'file:node_modules/team-work-runtime' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base','@deepseek-ai/dsh-headless','team-work-runtime'] } } }))
newFile(path.join(profileDir, 'cordis.patch.yml'), JSON.stringify([
  { id: 'llm-pi-ai', config: { providers: { [target.provider]: { apiKeyEnv: keyEnv } } } },
  { id: 'agent-default-model', config: target }, { id: 'team-work-dsh', config: { tiers } },
  ...['session-title-llm','session-telemetry-otel','tool-bash','tool-web','tool-goal','goal-round-driver','command-goal','plugin-manager'].map(id => ({ id, disabled: true })),
  { id: 'sandbox-policy', config: { mode: 'workspace-write', workspaceRoot: project } },
  { id: 'approval', config: { policy: 'never' } },
  { id: 'permission', config: { defaultPreset: 'workspace-write', presets: { 'workspace-write': { sandbox: 'workspace-write', approval: 'never' } } } },
]))
const nodeVersion = spawnSync(node, ['--version'], { env, encoding: 'utf8', timeout: 5000 })
assert.ok(nodeVersion.status === 0 && Number(/^v(\d+)\./.exec(nodeVersion.stdout)?.[1]) >= 24, '需要独立 Node 24+')
json('build', { ...metadata, runtime: manifest.version, node: nodeVersion.stdout.trim(), sourceSha256: digest, scenarioSha256: sha(fixture),
  dependencySha256: sha(JSON.stringify(files(runtime, dependencies))), sourceFiles: Object.keys(files(runtime, sources)).length, target })
json('inputs', snapshot)

async function credential() {
  // 仅打开宿主的一个已知引用；调用宿主自身只读 parser，不初始化或迁移全局凭据服务。
  const file = path.join(home, '.dsh/.credentials.yaml')
  try {
    assert.equal(realpathSync(path.dirname(file)), path.dirname(file))
    const { parseCredentialsDocument } = await import(pathToFileURL(createRequire(entry).resolve('@deepseek-ai/dsh-credentials-local')).href)
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const s = fstatSync(fd)
      assert.ok(s.isFile() && s.nlink === 1 && s.uid === process.getuid() && (s.mode & 0o077) === 0 && s.size < 1024*1024)
      const value = parseCredentialsDocument(readFileSync(fd, 'utf8'), file).refs.get('ZAI_CODING_CN_API_KEY')
      assert.ok(typeof value === 'string' && value.trim() === value && value !== '' && !/[\r\n\0]/.test(value))
      return value
    } finally { closeSync(fd) }
  } catch {
    throw new Error('宿主原生凭据解析失败；不尝试读取其他文件、回退其他模型或输出原错误')
  }
}

let child, interrupted = false, submissions = 0
const kill = (signal) => {
  if (child?.pid) try { process.kill(-child.pid, signal) } catch (e) { if (e.code !== 'ESRCH') throw e }
}
const interrupt = () => { interrupted = true; kill('SIGTERM') }
process.on('SIGTERM', interrupt); process.on('SIGINT', interrupt)
async function turn(tag, prompt, session) {
  assert.ok(!interrupted)
  verifyLoaded()
  const nonce = randomBytes(16).toString('hex')
  child = spawn(electron, [path.join(code,'host.mjs'),entry,nonce,prompt ? 'live' : mode === 'pipe' ? 'pipe' : 'probe', ...(session ? [session] : [])], {
    cwd: project, env: prompt ? { ...env, [keyEnv]: secret } : env, detached: true, stdio: ['pipe','pipe','pipe','pipe'],
  })
  let stdout = '', stderr = '', native = '', proof, failure, sent = false, forced
  const abort = (reason) => { failure ??= reason; kill('SIGTERM'); forced ??= setTimeout(() => kill('SIGKILL'), 3000) }
  let timer = setTimeout(() => abort('预检超时'),60000)
  for (const stream of [child.stdout,child.stderr,child.stdio[3]]) stream.setEncoding('utf8')
  child.stdout.on('data', s => { stdout += s; if (stdout.length > 24e6) abort('输出超限') })
  child.stderr.on('data', s => { stderr += s; if (stderr.length > 2e6) abort('诊断超限') })
  child.stdin.on('error', () => abort('不能向宿主提交输入'))
  child.stdio[3].on('data', s => {
    native += s
    if (native.length > 100000) return abort('预检输出超限')
    if (!native.includes('\n') || failure || proof) return
    try {
      proof = JSON.parse(native.slice(0,native.indexOf('\n')))
      if (proof.nonce !== nonce || proof.ok !== true) return abort(proof.error ?? '原生预检未通过')
      clearTimeout(timer)
      timer = setTimeout(() => abort('宿主阶段超时'), prompt ? 15 * 60000 : 60000)
      if (prompt) {
        if (interrupted) return abort('操作者已中断')
        sent = true; submissions++
        child.stdin.end(prompt)
      } else child.stdin.end()
    } catch { abort('预检协议不合法') }
  })
  const closed = await new Promise(resolve => {
    child.once('error', () => { failure ??= '宿主无法启动' })
    child.once('close', (exitCode,signal) => resolve({ exitCode,signal }))
  })
  child = undefined; clearTimeout(timer); clearTimeout(forced)
  for (const [ext, text] of [['jsonl',stdout],['stderr',stderr],['native.jsonl',native]]) newFile(path.join(evidence,tag+'.'+ext),redact(text))
  json(tag+'.status',{ ...closed, promptReleased: sent, passedProbe: proof?.ok === true, error: failure ? redact(failure) : null })
  assert.ok(!failure && !interrupted && proof?.ok === true && closed.exitCode === 0, tag + ' 停止，见对应 status/stderr/native')
  verifyLoaded()
  if (!sent) return
  const rows = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(rows.some(e => e.type === 'final'), '无 headless 正常尾事件')
  const top = rows.find(e => e.type === 'session')?.sessionId ?? session
  assert.match(top ?? '', /^session-[0-9a-f-]+$/)
  if (session) assert.equal(top, session, '恢复的顶层会话 ID 变化')
  json(tag+'.session',{ id:top })
  return top
}

const task = 'coordination-sample', gapTask = 'gap-sample', model = tier.provider + '/' + tier.model + '@' + tier.effort
const modelFields = Object.fromEntries(['owner','challenger','expert'].map(role => ['roles.'+role, model]))
const objective = '核对合成审查记录并按测试剧本完成口径协调和轮次验证'
const quote = '以 code-review 入口执行「'+objective+'」，单 Owner 只交 artifacts/review.md（code-review），不拆包；Lead、Owner、Challenger、Expert 使用 '+model+'。'
const writable = [{ path:'artifacts/review.md',kind:'code-review' }]
function openArgs(name, obj, raw, extra = [], covered = {}) {
  return ['open','--name',name,'--entry','code-review','--objective',obj,'--raw-requirement',raw,...extra,'--user-direction',
    JSON.stringify({ quote:raw, fields:{ 'intent.objective':obj, 'scope.entry':'code-review', ...modelFields, ...covered } })]
}
const dispatch = { task, writables:writable, userDirection:{ quote, fields:{ writable:['artifacts/review.md:code-review'] } } }
const common = '你是 /tmp 隔离测试项目的 Lead。以下都是合成输入，绝非真实任务/人员。用宿主工具，不能访问真实工作区、环境、密钥，不运行 shell 或其他任意代码，只可用 PTC 调用指定原生工具。先用 skill 加载 team-work，读 SCENARIO.md；最新工具契约若和旧说明冲突，以本次公开接口为准。'
const liveInput = common + '\n用户原话：'+quote+'\n用 tw 的 args 逐项输入：'+JSON.stringify(openArgs(task,objective,quote))+'；再用 tw-dispatch 参数 '+JSON.stringify(dispatch)+'（userDirection 必须实际传入；SDK 如需通过 run_code 用 tools["tw-dispatch"]）。不擅加约束、改路径、改模型、开别的任务或自行答卡。派出 Owner 后按 SCENARIO.md 主动发送 A-LEAD-ASK，按真实收信协调，等正式结项通知继续推进至第 1 轮的合成最终验收卡。遇到用户卡只呈现后结束回合，绝不自己作答。'
const gapObj = '核对甲乙口径归属', gapQuote = '以 code-review 入口核对甲乙口径归属，Owner 只交 artifacts/review.md（code-review），各角色使用 '+model+'。我不能判断应以甲还是乙为准，请先让我确认。'
const gap = { id:'source-of-truth',question:'以甲口径还是乙口径为准？',whyItMatters:'会改变报告依据与审查结果',proposedDefault:'甲口径，须用户确认' }
const gapInput = common+'\n用户原话：'+gapQuote+'\n原样用 tw 的 args '+JSON.stringify(openArgs(gapTask,gapObj,gapQuote,['--gap',JSON.stringify(gap)]))+'；再用 tw-dispatch 参数 '+JSON.stringify({ task:gapTask,writables:writable,userDirection:{quote:gapQuote, fields:{ writable:['artifacts/review.md:code-review'] }}})+'。就原样展示冻结的意图首卡并结束；不得答卡、派发、写制品，也不得把派发描述当作发生。'
const retryTask = 'urgent-retry-sample', retryObj = '核对合成阻塞请求能否下一 Step 原样重发'
const retryQuote = '以 code-review 入口执行「'+retryObj+'」，单 Owner 只交 artifacts/review.md（code-review），不拆包；Lead、Owner、Challenger、Expert 使用 '+model+'。'
const retryInput = common+'\n用户原话：'+retryQuote+'\n原样用 tw 的 args '+JSON.stringify(openArgs(retryTask,retryObj,retryQuote))+'；再用 tw-dispatch 参数 '+JSON.stringify({ task:retryTask,writables:writable,userDirection:{quote:retryQuote, fields:{ writable:['artifacts/review.md:code-review'] }}})+'。只完成 SCENARIO.md 的必要请求原样重发及本轮交卷，不派第二波、不自答用户卡。'
const roundTask = 'round-sample', roundObj = '核对合成审查的人工返工与自主轮次上限'
const rubric = '各角色每轮先读 SCENARIO.md，严格执行表中的合成写入和审查口径；Challenger 在第 2、3、4 轮缺追踪编号时必须提交 rework，第 1、5 轮按表核对。'
const roundQuote = '以 code-review 入口执行「'+roundObj+'」，单 Owner 只交 artifacts/review.md（code-review），不拆包。'+rubric+'Lead、Owner、Challenger、Expert 均用 '+model+'。'
const roundInput = common+'\n用户原话：'+roundQuote+'\n用 tw 的 args '+JSON.stringify(openArgs(roundTask,roundObj,roundQuote,['--constraint',rubric],{'intent.constraints':[rubric]}))+'；再用 tw-dispatch 参数 '+JSON.stringify({ task:roundTask,writables:writable,userDirection:{quote:roundQuote,fields:{writable:['artifacts/review.md:code-review']}}})+'。按剧本推进第 1 轮，等待新的外部测试输入，不自答人工门。'
function readPublic(name, tag, command = 'run') {
  const result = spawnSync(node, [tw,command,'--task',name], { cwd:project, timeout:15000, encoding:'utf8', env:{...env,ELECTRON_RUN_AS_NODE:'',
    TW_DSH_CONFIG:JSON.stringify({ tiers,profile,entryId:'team-work-dsh' }) } })
  assert.ok(result.status === 0, '公开只读核对失败：'+tag)
  const card = JSON.parse(result.stdout)
  json(tag,card)
  assert.equal(card.ok,true,'只读核对未成功：'+tag)
  return card
}
function answer(name, card, tag, select) {
  const choices = card.choices?.filter(select)
  assert.ok(card.status === 'awaiting-user' && /^dec-/.test(card.decisionId ?? '') && choices?.length === 1 && Number.isSafeInteger(choices[0].n), '未找到唯一可答的真实卡：'+tag)
  const { n, label } = choices[0]
  json('input-'+tag,{ source:'synthetic-operator-input', id:card.decisionId, n,label })
  return '【隔离测试的外部合成用户回复，不代表真人授权】我现在明确选择 '+card.decisionId+' 的第 '+n+' 项「'+label+'」。仅通过真实原生 tw decide 的 args：'+
    JSON.stringify(['decide','--task',name,'--decision-id',card.decisionId,'--choice',String(n)])+'。只答这张卡一次，再用 tw-dispatch 推进同一任务（不必再传首派范围，沿用已授权范围）。后续按 SCENARIO.md 随真实结项继续，不擅自批准下一张卡；真实等待再结束。'
}

try {
  await turn('probe')
  if (!['probe','pipe'].includes(mode)) {
    secret = await credential()
    if (mode === 'gap') {
      await turn('gap',gapInput)
      const card = readPublic(gapTask,'gap-state')
      assert.ok(card.choices?.some(c => c.grant === 'accept-intake') && card.status === 'awaiting-user' && card.question?.includes(gap.question), '未收到有实际信息差的固定首卡')
    } else if (mode === 'retry') {
      await turn('retry',retryInput)
      readPublic(retryTask,'retry-state')
      assert.equal(readFileSync(path.join(project,'artifacts/review.md'),'utf8').trim(),'重发核验：已收到甲口径。','求助样本未完成真实协调')
    } else {
      const name = mode === 'round' ? roundTask : task
      const top = await turn('start',mode === 'round' ? roundInput : liveInput)
      const human = readPublic(name,'first-human')
      assert.equal(human.gateId,'scoped-final-code-review','第 1 轮未到本阶段验收门，不代答其他卡')
      if (mode === 'round') {
        await turn('rework',answer(name,human,'rework',c => c.grant === 'rework' || c.label === 'rework')+
          '\n第 2 轮人工返工要求：Owner 把制品从甲口径改成乙口径，继续合成核验。',top)
        const round = readPublic(name,'round-limit')
        assert.equal(round.kind,'round-limit','人工返工后未到自主上限，不代答其他卡')
        await turn('extra-round',answer(name,round,'extra-round',c => c.grant === 'extra-round'),top)
        const final = readPublic(name,'final-human')
        assert.equal(final.gateId,'scoped-final-code-review','一次批准后未完成下一审查轮；不继续追加')
        await turn('finish',answer(name,final,'finish',c => c.grant === 'accept' || c.label === 'accept'),top)
        assert.equal(readPublic(name,'completed').status,'completed')
      }
    }
  }
  verifyLoaded()
  json('finish',{ ok:true, sourceMatchesAtEnd:sha(JSON.stringify(files(repo,sources)))===digest, submissions })
} catch (error) {
  json('stopped',{ reason:redact(error instanceof assert.AssertionError ? error.message.split('\n')[0] : error.message), submissions })
  console.error('验证停止；保留隔离证据，未完成项不计通过。')
  process.exitCode = 1
} finally {
  process.off('SIGTERM',interrupt); process.off('SIGINT',interrupt)
}
