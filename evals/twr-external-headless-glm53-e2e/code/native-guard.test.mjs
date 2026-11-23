// 只验证受控适配器的拼接和拒绝条件以及原 CLI 参数透传，不模拟内核通过。
import assert from 'node:assert/strict'
import test from 'node:test'
import { lstatSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { code, paths, repo, task } from './shared.mjs'
import { confinementPrefix, scopedSpawn, toolGuard } from './native-guard.mjs'
const rules='(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/fixture"))'
const plan={enforcement:'full',argv:['sandbox-exec','-p',rules,'--','/usr/bin/true']}
const prefix=confinementPrefix(plan)
test('原生规则不被替换，runner、约束或分隔形状缺证拒绝',()=>{
  assert.deepEqual(prefix,['/usr/bin/sandbox-exec','-p',rules,'--'])
  assert.throws(()=>confinementPrefix({...plan,enforcement:'partial'}))
  assert.throws(()=>confinementPrefix({...plan,argv:['custom','-p',rules,'--','/usr/bin/true']}))
  assert.throws(()=>confinementPrefix({...plan,argv:['sandbox-exec','-p','(allow default)','--','/usr/bin/true']}))
})
test('原版 CLI 两种入口都走固定单层包装，拒绝变更目标并隔离环境',()=>{
  const seen=[]
  const target='/fixture/plugin/bin/tw.mjs', loader='/fixture/cli-entry.mjs', project='/fixture/project'
  const wrap=scopedSpawn((...a)=>{seen.push(a);return {}},target,loader,prefix,project,()=>null)
  const opts={cwd:project,env:{TW_DSH_CONFIG:'{}',ELECTRON_RUN_AS_NODE:'1',TWR_E2E_GLM_KEY:'test-only-secret',TW_PROJECT_ROOT:'/unauthorized',NODE_OPTIONS:'--trace-warnings'}}
  wrap(process.execPath,[target,'help'],opts)
  wrap(process.execPath,[target,'dispatch-plan','--task','fixture-task','--json'],opts)
  assert.deepEqual(seen[0],[prefix[0],[...prefix.slice(1),process.execPath,loader,target,'help'],{cwd:project,env:{ELECTRON_RUN_AS_NODE:'1',TW_DSH_CONFIG:'{}'}}])
  assert.deepEqual(seen[1][1].slice(-4),['dispatch-plan','--task','fixture-task','--json'])
  assert.throws(()=>wrap(process.execPath,['/wrong/bin/tw.mjs','help'],opts),/没有使用/)
  assert.throws(()=>wrap(process.execPath,[target,'help'],{...opts,cwd:'/other'}),/cwd/)
  assert.throws(()=>wrap('/other-node',[target,'help'],opts))
  assert.equal(seen.length,2)
  wrap('/usr/bin/true',[])
  assert.deepEqual(seen[2],['/usr/bin/true',[]])
})
const scratch = t => {
  const p=mkdtempSync(path.join(code,'.guard-test-'))
  t.after(()=>{assert.ok(lstatSync(p).isDirectory());rmSync(p,{recursive:true})})
  return p
}
test('测试工具的白名单、文件正例与 CLI 根覆盖拒绝',t=>{
  const project=scratch(t)
  mkdirSync(path.join(project,'artifacts','alpha'),{recursive:true})
  writeFileSync(path.join(project,'SCENARIO.md'),'合成场景')
  const make=(name,args,parentSession)=>({name,arguments:args,agent:{session:{header:{cwd:project,parentSession}}}})
  const allowed=toolGuard({project},{resolve:()=>({mode:'workspace-write',workspaceRoot:project})})
  assert.equal(allowed(make('read',{file_path:'SCENARIO.md'})),undefined)
  assert.equal(allowed(make('write',{file_path:paths.main,content:'夹具'},'parent')),undefined)
  assert.equal(allowed(make('tw-dispatch',{task})),undefined)
  assert.equal(allowed(make('tw',{args:['roles','--task',task]})),undefined)
  for(const request of [make('bash',{command:'true'}),make('write',{file_path:paths.main}),make('read',{file_path:'../outside'}),
    make('tw',{args:['run','--task',task,'--project-root','/outside']}),make('tw',{args:['roles','--task',task,'--resolve']}),
    make('tw-dispatch',{task,writables:[]}),make('tw-dispatch',{task},'parent'),make('read',{file_path:'SCENARIO.md',sandbox_permissions:'danger-full-access'})]) assert.ok(allowed(request))
  const weaker=toolGuard({project},{resolve:()=>({mode:'danger-full-access',workspaceRoot:project})})
  assert.ok(weaker(make('read',{file_path:'SCENARIO.md'})))
})
test('保留原 CLI 的 help 和不存在任务的公开回执，不载入模型',t=>{
  const cwd=scratch(t), shim=path.join(code,'cli-entry.mjs'), cli=path.join(repo,'bin/tw.mjs')
  const launch=(args,exit)=>{
    const r=spawnSync(process.execPath,[shim,cli,...args],{cwd,env:{PATH:'/usr/bin:/bin',HOME:cwd},encoding:'utf8',timeout:15000})
    assert.ifError(r.error);assert.equal(r.status,exit,r.stderr)
    return JSON.parse(r.stdout || r.stderr)
  }
  assert.equal(launch(['help'],0).ok,true)
  assert.equal(launch(['dispatch-plan','--task','probe-000','--json'],1).code,'TASK_NOT_FOUND')
})
test('原 CLI 同进程的探针走专用 FD，而非污染公开回执或把未受限进程判为通过',t=>{
  const project=scratch(t), fixtureRepo=path.join(project,'fixture-repo')
  mkdirSync(path.join(fixtureRepo,'bin'),{recursive:true})
  writeFileSync(path.join(fixtureRepo,'package.json'),'{}')
  writeFileSync(path.join(fixtureRepo,'bin/tw.mjs'),'')
  const data={nonce:'a'.repeat(32), project, repo:fixtureRepo,home:project,isolatedHome:project,channel:'tw'}
  const r=spawnSync(process.execPath,[path.join(code,'cli-entry.mjs'),path.join(repo,'bin/tw.mjs'),'help'],{
    cwd:project, env:{PATH:'/usr/bin:/bin',HOME:project,TWR_ISOLATION_PROBE:Buffer.from(JSON.stringify(data)).toString('base64url')},
    stdio:['ignore','pipe','pipe','pipe'],encoding:'utf8',timeout:15000,
  })
  assert.ifError(r.error);assert.equal(r.status,0,r.stderr)
  assert.equal(JSON.parse(r.stdout).ok,true)
  const raw=JSON.parse(r.output[3]);assert.equal(raw.channel,'tw');assert.equal(raw.descendant.channel,'tw')
  assert.equal(raw.projectWrite,'ALLOWED');assert.equal(raw.repoExisting,'ALLOWED','本测试无 Seatbelt，不可宣称拒写')
  assert.equal(raw.homeCreate,undefined,'未约束时不继续尝试在 HOME 造探针文件')
})
