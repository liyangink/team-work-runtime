// 只读复核外部终端留下的专属测试运行；不执行宿主、模型、任务或用户决定。
import assert from 'node:assert/strict'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { assertProbe, verifyNoModelTrace, verifySessions, verifyIntake, verifyFinal, approvalFor, approvalInput, approvalSources } from './verify.mjs'
import { confirmAnchor, dependencyInputs, expectedPackageSha, modelTuple, physical, readJson, sha, sourceInputs, target, tree } from './shared.mjs'
const [input] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && path.isAbsolute(input ?? ''), '用法：node audit.mjs <启动脚本打印的绝对专属目录>')
const root = path.normalize(input)
assert.ok(path.dirname(root) === realpathSync('/tmp') && /^twr-headless-e2e-[A-Za-z0-9]+$/.test(path.basename(root)), '只接受启动器创建的独立目录')
const dir = rel => { const p = path.join(root,rel); assert.ok(physical(p).isDirectory()); return p }
const evidence = dir('evidence'), project = dir('project'), home = dir('home/.dsh')
const profile = dir('home/.dsh/profiles/eval-headless')
const runtime = dir('home/.dsh/profiles/eval-headless/node_modules/team-work-runtime')
const file = (rel) => {
  assert.match(rel,/^[a-z0-9.-]+$/)
  const p = path.join(evidence,rel)
  const s = physical(p); assert.ok(s.isFile() && s.nlink===1)
  return p
}
const o = (name) => readJson(file(name+'.json'))
assert.throws(()=>lstatSync(path.join(evidence,'stopped.json')), { code:'ENOENT' }, '本次记录过中止，不能宣称完整通过')
const build = o('build'), recheck = o('recheck')
assert.equal(build.dshVersion,'0.2.2-rc.5'); assert.deepEqual(modelTuple(build.model),modelTuple(target))
assert.equal(recheck.sourceAndLoadUnchanged,true)
const source = tree(runtime,sourceInputs); confirmAnchor(source)
assert.equal(sha(JSON.stringify(source)),build.packageSha256); assert.equal(build.packageSha256,expectedPackageSha)
assert.equal(sha(JSON.stringify(tree(runtime,dependencyInputs))),build.dependenciesSha256)
assert.equal(sha(readFileSync(path.join(profile,'cordis.patch.yml'))),build.fingerprints.patch)
assert.equal(sha(readFileSync(path.join(profile,'package.json'))),build.fingerprints.profile)
assert.equal(sha(readFileSync(path.join(project,'SCENARIO.md'))),build.fingerprints.scenario)
const tags = recheck.modelPromptSubmissions === 0 ? ['isolation'] : ['isolation','intake','work','complete']
assert.equal(recheck.modelPromptSubmissions,tags.length-1,'只允许三次顶层输入，不是总模型请求次数')
const probes = tags.map((tag,i)=>{
  const r = o(tag+'.status'), proof = readJson(file(tag+'.probe.jsonl'))
  assert.equal(r.exitCode,0);assert.equal(r.passedProbe,true);assert.equal(r.promptReleased,i>0)
  assert.match(proof.nonce,/^[a-f0-9]{32}$/);assertProbe(proof,proof.nonce)
  return proof.nonce
})
assert.equal(new Set(probes).size,probes.length)
verifyNoModelTrace(readFileSync(file('isolation.jsonl'),'utf8'),tags.length === 1 ? home : undefined)
if (tags.length === 1) {
  console.log(JSON.stringify({ isolationVerified:true, modelExecuted:false, packageSha256:build.packageSha256 },null,2))
} else {
  const readEvents = tag => {
    const rows = readFileSync(file(tag+'.jsonl'),'utf8').trim().split('\n').map(JSON.parse)
    assert.ok(rows.some(e=>e.type==='final'), '缺少回合执行结束证据：'+tag)
    return rows
  }
  const top = readEvents('intake').find(e=>e.type==='session')?.sessionId
  assert.ok(top)
  for (const tag of ['work','complete']) {
    const session = readEvents(tag).find(e=>e.type==='session')?.sessionId
    assert.equal(session ?? top,top,'恢复回合不属于同一 Lead')
  }
  const sessions = verifySessions(home,project), lead = sessions.find(s=>s.id===top)
  assert.ok(lead)
  const approvalSource = recheck.approvalSource ?? approvalSources.terminal
  const approve = (name, card) => {
    const h=o('human-'+name)
    const approved = approvalFor(card,name,approvalSource)
    assert.deepEqual({id:h.id,n:h.choice,phrase:h.explicitPhrase,source:h.source ?? approvalSources.terminal},approved,
      '当前待决卡、批准选项或来源与记录不符：'+name)
    assert.ok(Number.isFinite(Date.parse(h.at)))
    return approved
  }
  const intake=o('intake-card'), final=o('final-card')
  const start=approve('intake',intake), end=approve('final',final)
  const firstHuman=lead.prompts.find(m=>m.text.startsWith(approvalInput(start)))
  assert.ok(firstHuman)
  verifyIntake({state:intake, roles:o('initial-roles'), top, sessions:[{...lead,calls:lead.calls.filter(c=>c.seq<firstHuman.seq)}]})
  assert.deepEqual(o('artifacts-before-intake'),{alpha:0,beta:0})
  assert.deepEqual(o('artifacts-before-dispatch'),{alpha:0,beta:0})
  assert.equal(o('gate-before-human').passed,false)
  const checked=verifyFinal({sessions,project,top,start,end,gate:final,status:o('completed'),finalGate:o('gate-after-human')})
  const { fingerprint,modelPromptSubmissions,...recorded }=o('verified')
  assert.equal(fingerprint,build.packageSha256);assert.equal(modelPromptSubmissions,3)
  assert.deepEqual(checked,recorded,'重新计算的证据与启动器验收记录不一致')
  console.log(JSON.stringify({isolationVerified:true,modelExecuted:true,approvalSource,packageSha256:fingerprint,...checked},null,2))
}
