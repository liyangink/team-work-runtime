// 在本派单 code/ 内建临时夹具；复用历史用例但绝不写历史目录。无 DSH 和提供方请求。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { code, repo, sourceInputs, dependencyInputs, confirmAnchor, tree, sha, anchor, plans, task, paths } from './shared.mjs'
import { runCases } from '../../twr-headless-real-host-validation/code/cli-cases.mjs'
const mode = process.argv[2]
assert.ok(process.argv.length === 3 && ['cli','suite'].includes(mode), '用法：node offline.mjs cli|suite')
assert.equal(realpathSync(code), path.join(repo, 'evals/twr-external-headless-glm53-e2e/code'))
const root = mkdtempSync(path.join(code, '.offline-'))
const dir = name => { const p = path.join(root, name); mkdirSync(p); return p }
const runtime = dir('source'), home = dir('home'), tmp = dir('tmp')
const redact = (s) => String(s).replaceAll(root,'<SCRATCH>').replaceAll(repo,'<REPO>').replaceAll(process.execPath,'<NODE>')
const emit = event => process.stdout.write(redact(JSON.stringify(event)) + '\n')
const fixture = { provider: 'fixture-provider', model: 'fixture-model', effort: 'max' }
const env = { PATH:'/usr/bin:/bin', HOME:home, TMPDIR:tmp, TZ:'UTC', TW_CMD:'tw', TW_DSH_CONFIG:JSON.stringify({ profile:'offline-fixture', entryId:'team-work-dsh', tiers:{ junior:fixture, senior:fixture, expert:fixture } }) }
function child(args, cwd, timeout = 15000) {
  const r = spawnSync(process.execPath, args, { cwd, env, timeout, encoding:'utf8', maxBuffer:24 * 1024 * 1024 })
  assert.ifError(r.error); assert.equal(r.signal,null); return r
}
function cli(cwd, step, argv) {
  const r = child([path.join(runtime,'bin/tw.mjs'), ...argv], cwd)
  const output = JSON.parse(r.stdout || r.stderr)
  emit({ type:'cli', step, argv, status:r.status, output })
  assert.equal(r.status, output.ok === false ? 1 : 0)
  return output
}
function closure() {
  const cwd = dir(task)
  // 松耦合纯文本夹具，所有提交都通过公开 CLI；没有模拟真实宿主、真实模型或用户。
  const pass = (step, cmd, ...argv) => {
    const o = cli(cwd, task + '/' + step, [cmd, '--task', task, ...argv]); assert.notEqual(o.ok, false, step); return o
  }
  const get = step => pass(step, 'dispatch-plan')
  const choice = (step, card, name) => {
    const c = card.choices.find(x => x.grant === name || x.label === name)
    assert.ok(c); return pass(step,'decide','--decision-id',card.decisionId,'--choice',String(c.n))
  }
  const author = (step, ids, kind) => {
    const r = get(step)
    assert.equal(r.stop, null)
    assert.deepEqual(r.waves.map(w=>[w.role,w.package,w.kind]), ids.map(id=>['owner',id,kind]))
    return r.waves
  }
  const reviewer = (step, role, pathsIn, pathsOut = []) => {
    const r = get(step)
    assert.equal(r.stop,null); assert.equal(r.waves.length,1)
    const w = r.waves[0]; assert.equal(w.role,role)
    for (const p of pathsIn) assert.ok(w.prompt.includes(p), step+' 清单须含 '+p)
    for (const p of pathsOut) assert.ok(!w.prompt.includes(p), step+' 清单不能含 '+p)
    return w
  }
  const finding = (statement, id, disposition = 'must-fix') => ({ statement, scope:{kind:'packages',ids:[id]}, disposition, severity:disposition === 'must-fix' ? 'blocker' : 'info' })
  const verdict = outcome => ({ outcome, rationale:'合成状态校验', confidence:'high', recommendedAction:'按裁决收口' })
  const review = (step, w, rec, findings, v) => {
    const r = pass(step,'review','--key',w.dispatchKey,'--recommendation',rec,'--summary','合成组合评审摘要', ...(findings ? ['--findings',JSON.stringify(findings)] : []), ...(v ? ['--verdict',JSON.stringify(verdict(v))] : []))
    assert.equal(r.accepted,true); return r
  }
  const save = (p, bytes) => {
    const f = path.join(cwd,p); mkdirSync(path.dirname(f),{recursive:true}); writeFileSync(f,bytes)
    emit({type:'fixture-file', step:p, sha256:sha(bytes)})
  }
  const deliver = (step,w,expected,added,removed) => {
    const r = pass(step,'deliver','--key',w.dispatchKey,'--summary','合成完整清单','--outcome','delivered','--paths',expected.join(','))
    assert.equal(r.accepted,true)
    assert.deepEqual(r.manifest.slice().sort(),expected.slice().sort())
    assert.deepEqual((r.added ?? []).slice().sort(),added.slice().sort(),step+' 新增按同包上一份有效清单')
    assert.deepEqual((r.removed ?? []).slice().sort(),removed.slice().sort(),step+' 移出按同包上一份有效清单')
    for (const a of r.registered) assert.equal(a.digest,sha(readFileSync(path.join(cwd,a.path))),step+' 文件原始字节')
    return r
  }
  const handoff = (w, yes, no) => {
    assert.equal(w.continuation,true); assert.equal(w.promptFrozen,true)
    for (const [name,digest] of [['prompt','promptDigest'],['promptFull','promptFullDigest']]) {
      assert.equal(sha(w[name]),w[digest]); assert.ok(w[name].split('\n')[0].includes(w.dispatchKey))
      for(const f of yes) assert.equal(w[name].split(f.statement).length-1,1,'正文原文一次：'+f.statement)
      for(const f of no) assert.ok(!w[name].includes(f.statement),'不可夹带其他包意见：'+f.statement)
    }
  }
  const open = cli(cwd, task+'/open', ['open','--name',task,'--entry','code-review','--objective','验证双包回执、定点意见与人工门合成链','--raw-requirement','按合成场景真实操作公开 CLI，验证两包流水、按包返工、回执增删和最终人工门'])
  assert.equal(open.ok,true)
  pass('plan','plan','--packages',JSON.stringify(plans))
  const intake = get('intake')
  assert.equal(intake.stop,'awaiting-user'); assert.deepEqual(intake.waves,[])
  choice('simulated-intake',intake.card,'accept-intake')
  const [a0,b0] = author('initial-wave',['alpha','beta'],'produce')
  const { main,legacy,index,beta } = paths
  save(main,'状态：待复核\n');save(legacy,'旧版交接\n');save(beta,'乙包已核验\n')
  const aFirst = deliver('first-alpha',a0,[main,legacy],[main,legacy],[])
  const waiting = get('first-wave-partial'); assert.equal(waiting.stop,'wait-inflight')
  deliver('first-beta',b0,[beta],[beta],[])
  const c0 = reviewer('first-challenger','challenger',[main,legacy,beta])
  const ch = finding('CH-ALPHA-INDEX：只将甲包旧登记改为索引','alpha')
  review('challenger-selective',c0,'rework',[ch])
  const [a1] = author('challenger-rework-alpha-only',['alpha'],'respond')
  handoff(a1,[ch],[])
  const old = readFileSync(path.join(cwd,legacy))
  save(index,'索引已复核\n')
  const aSecond = deliver('changed-key-added-and-removed',a1,[main,index],[index],[legacy])
  assert.notEqual(aSecond.reportId,aFirst.reportId)
  assert.equal(aFirst.registered.find(x=>x.path===main).digest,aSecond.registered.find(x=>x.path===main).digest)
  assert.ok(readFileSync(path.join(cwd,legacy)).equals(old), '移出清单不改磁盘旧文件')
  const c1 = reviewer('challenger-review-new-set','challenger',[main,index,beta],[legacy])
  const ca = finding('CTX-ALPHA：甲包复核背景','alpha','context')
  const cb = finding('CTX-BETA：乙包复核背景','beta','context')
  review('challenger-accept-with-separate-context',c1,'accept',[ca,cb])
  const e0 = reviewer('expert-review','expert',[main,index,beta],[legacy])
  const e = finding('EX-ALPHA-READY：甲包状态须标为归档就绪','alpha')
  review('expert-accept-rework-combination',e0,'accept',[e],'rework')
  const [a2] = author('expert-rework-alpha-only',['alpha'],'respond')
  handoff(a2,[e,ca],[cb])
  save(main,'状态：归档就绪\n')
  deliver('changed-key-content-only',a2,[main,index],[],[])
  const c2 = reviewer('challenger-rereview','challenger',[main,index,beta],[legacy])
  review('challenger-final-accept',c2,'accept')
  const e1 = reviewer('expert-rerule','expert',[main,index,beta],[legacy])
  review('expert-final-accept',e1,'accept',undefined,'accept')
  pass('e2e-route','route','--route','e2e','--decision','skip','--basis','合成文本没有可部署应用，只测试显式路由')
  const final = get('final-acceptance'); assert.equal(final.stop,'awaiting-user'); assert.deepEqual(final.waves,[])
  const read = pass('final-wait','run'); assert.equal(read.status,'awaiting-user'); assert.equal(read.decisionId,final.card.decisionId)
  const gate = pass('gate-before','gate'); assert.equal(gate.passed,false)
  choice('simulated-final-accept',final.card,'accept')
  assert.equal(get('complete').stop,'completed'); assert.equal(pass('gate-passed','gate').passed,true)
  emit({type:'case-result',case:'latest-two-package-receipt-and-g3',outcome:'pass',trueRequests:0})
}
try {
  const inputs = mode === 'suite' ? [...sourceInputs, ...dependencyInputs, 'tests'] : sourceInputs
  const before = tree(repo,inputs)
  const pkgOnly = Object.fromEntries(Object.entries(before).filter(([f])=>sourceInputs.some(p=>f===p || f.startsWith(p+'/'))))
  confirmAnchor(pkgOnly)
  const copied = tree(repo,inputs,runtime)
  assert.deepEqual(copied,before)
  assert.deepEqual(tree(runtime,inputs),before)
  emit({type:'snapshot',mode,node:process.version,platform:process.platform,arch:process.arch,packageFiles:Object.keys(pkgOnly).length,packageSha256:sha(JSON.stringify(pkgOnly)),keyFiles:anchor})
  if (mode === 'cli') {
    const prev = await runCases({ cli, project:dir, home, sha, emit })
    assert.equal(prev,0,'复用的七条 CLI 用例未全通过')
    closure()
  } else {
    const excluded = ['evals-harness.test.mjs','repository-contract.test.mjs']
    const tests = readdirSync(path.join(runtime,'tests')).filter(f=>f.endsWith('.test.mjs') && !excluded.includes(f)).sort()
    emit({type:'suite', files:tests, excluded, withDshHost:false})
    const r = child(['--test','--test-reporter=tap',...tests.map(f=>'tests/'+f)],runtime,120000)
    process.stdout.write(redact(r.stdout)); process.stderr.write(redact(r.stderr))
    emit({type:'suite-exit',status:r.status})
    assert.equal(r.status,0)
  }
  assert.deepEqual(tree(repo,inputs),before,'源文件漂移')
  assert.deepEqual(tree(runtime,inputs),before,'副本漂移')
  emit({type:'source-recheck',sourceUnchanged:true,snapshotUnchanged:true,modelRequests:0})
} finally {
  assert.equal(path.dirname(realpathSync(root)),code)
  assert.ok(path.basename(root).startsWith('.offline-'))
  function cleanDir(dir) {
    assert.equal(realpathSync(dir),dir)
    const st = lstatSync(dir)
    if (!(st.mode & 0o200)) chmodSync(dir,(st.mode & 0o777) | 0o200)
    for(const child of readdirSync(dir,{withFileTypes:true})) if(child.isDirectory()) cleanDir(path.join(dir,child.name))
  }
  cleanDir(root); rmSync(root,{recursive:true}); emit({type:'cleanup',removedOwnScratch:true})
}
