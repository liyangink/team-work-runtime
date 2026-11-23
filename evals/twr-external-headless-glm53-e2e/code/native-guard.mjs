// 仅在专属测试宿主进程中，为原版 TWR 工具派生的 CLI 增加核级约束；不更换工具实现。
import assert from 'node:assert/strict'
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { lstatSync, readFileSync, realpathSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { physical, paths, task } from './shared.mjs'

const sentinel = '/usr/bin/true'
const allowedCommands = new Set(['help','open','plan','run','gate','roles','models','deliver','review','decide','route'])
const files = new Set(Object.values(paths))
const allowedKinds = Object.freeze(['read','skill','tw','tw-dispatch','write'])
export function confinementPrefix(result) {
  assert.equal(result.enforcement,'full')
  assert.ok(Array.isArray(result.argv) && result.argv.length === 5, '缺少原生 Seatbelt 单层执行计划')
  const [runner,flag,rules,separator,last] = result.argv
  assert.ok(['sandbox-exec','/usr/bin/sandbox-exec'].includes(runner) && flag === '-p' && separator === '--' && last === sentinel)
  assert.ok(typeof rules === 'string' && rules.includes('(deny file-write*)'), '原生规则没有拒绝默认写入')
  // 固定系统实施者，保留原服务生成的完整规则，不复制、弱化规则或嵌套两次。
  return ['/usr/bin/sandbox-exec',flag,rules,separator]
}
const callOption = (args, flag, value) => args.filter(a=>a===flag).length === 1 && args[args.indexOf(flag)+1] === value
export function toolGuard(p, policy) {
  return (exec) => {
    const refuse = { reason:'本隔离演练禁止此调用、越界路径或更宽权限' }
    const a = exec.arguments
    if (!a || !allowedKinds.includes(exec.name) || exec.parent !== undefined || a.sandbox_permissions !== undefined || a.justification !== undefined) return refuse
    const session = exec.agent?.session
    if (!session || session.header?.cwd !== p.project) return refuse
    let resolved
    try { resolved = policy.resolve({session}) } catch { return refuse }
    if (resolved.mode !== 'workspace-write' || resolved.workspaceRoot !== p.project || resolved.additionalWritableRoots?.length) return refuse
    switch (exec.name) {
      case 'skill': return ['team-work','team-work-v3'].includes(a.name) ? undefined : refuse
      case 'tw-dispatch': return a.task === task && a.writables === undefined && session.header.parentSession == null ? undefined : refuse
      case 'tw': {
        const args = a.args
        if (!Array.isArray(args) || args.some(x=>typeof x!=='string' || x.includes('\0') || x.startsWith('--project-root')) || !allowedCommands.has(args[0])) return refuse
        const member = session.header.parentSession != null
        if (member && !['help','run','gate','roles','deliver','review'].includes(args[0])) return refuse
        if (!member && ['deliver','review'].includes(args[0])) return refuse
        if (args[0] === 'open' && !callOption(args,'--name',task)) return refuse
        if (!['open','help','models'].includes(args[0]) && !callOption(args,'--task',task)) return refuse
        if (args[0] === 'roles' && (args.length !== 3 || args[1] !== '--task')) return refuse
        return
      }
      default: {
        if (typeof a.file_path !== 'string' || a.file_path.includes('\0')) return refuse
        const abs = path.resolve(p.project,a.file_path), rel = path.relative(p.project,abs)
        if (!(files.has(rel) || (exec.name === 'read' && rel === 'SCENARIO.md'))) return refuse
        if (exec.name === 'write' && session.header.parentSession == null) return refuse
        try {
          assert.equal(realpathSync(path.dirname(abs)),path.dirname(abs))
          try { const s=physical(abs); assert.ok(s.isFile() && s.nlink === 1) }
          catch(e) { if(e.code !== 'ENOENT' || exec.name !== 'write') throw e }
        } catch { return refuse }
        return
      }
    }
  }
}

// 只接受已封存副本的同一个 CLI 路径、执行程序与 project cwd；其余 spawn 不改动。
export function scopedSpawn(original, cli, loader, prefix, project, probe) {
  return function spawn(program, argv, opts) {
    if (!Array.isArray(argv) || typeof argv[0] !== 'string' || path.basename(argv[0]) !== 'tw.mjs') return Reflect.apply(original,this,arguments)
    assert.equal(argv[0],cli,'原生工具没有使用已核验源码副本的 CLI 入口')
    assert.equal(program,process.execPath)
    assert.equal(opts?.cwd,project,'原生 CLI 的 cwd 不是专属项目')
    assert.equal(opts.stdio,undefined)
    assert.equal(opts.shell,undefined)
    assert.ok(typeof opts?.env?.TW_DSH_CONFIG === 'string')
    const extra = probe()
    const env = Object.fromEntries(['HOME','DSH_HOME','TMPDIR','TMP','TEMP','TZ','PATH','ELECTRON_RUN_AS_NODE','TW_DSH_CONFIG'].filter(k=>typeof opts.env[k]==='string').map(k=>[k,opts.env[k]]))
    if (extra) env.TWR_ISOLATION_PROBE = extra.encoded
    const result = original(prefix[0],[...prefix.slice(1),program,loader,...argv],{ ...opts, env, ...(extra ? {stdio:['pipe','pipe','pipe','pipe']} : {}) })
    if (extra) extra.observe(result)
    return result
  }
}
export function installCliGuard({p,configuredCli,loader,plan}) {
  const prefix = confinementPrefix(plan)
  let active
  const original = cp.spawn
  const guarded = scopedSpawn(original,configuredCli,loader,prefix,p.project,()=>active)
  cp.spawn = guarded
  syncBuiltinESMExports()
  return {
    async withProbe(channel, run) {
      assert.ok(!active && cp.spawn===guarded)
      let seen = 0, observation
      // 每次无模型原生调用应正好进入一次真实 spawn钩子并在被沙箱限制的同 PID 产生证据。
      active = {
        encoded:Buffer.from(JSON.stringify({...p,channel})).toString('base64url'),
        observe(child) {
          seen++
          observation = new Promise(resolve=>{
            let data=''
            child.stdio[3].setEncoding('utf8').on('data',chunk=>{ if (data.length < 64000) data+=chunk })
            child.once('close',status=>resolve({ status, data }))
          })
        },
      }
      try {
        const card=await run()
        assert.equal(seen,1,'未证明原生 '+channel+' 使用同一受限进程')
        const {status,data}=await observation
        const expected=channel==='tw' ? 0 : 1
        assert.equal(status,expected,'原生 '+channel+' 探针或 CLI 未正确结算')
        assert.ok(data.length>0 && data.length<64000,'缺少来自原版 CLI 进程的独立证据：'+channel)
        return {status, card, facts:JSON.parse(data)}
      } finally { active=undefined }
    },
  }
}
export async function verifyNativeEntries(ctx,p,profileDir,loader,policy,assertFacts) {
  const tools=ctx.get('tools'), sandbox=ctx.get('sandbox'), fs=ctx.get('fs'), policyService=ctx.get('sandboxPolicy')
  assert.equal(tools.selectExecutor().constructor.name,'NativeToolExecutor','拒绝未核验的模型工具执行器')
  const entry=path.join(profileDir,'node_modules/team-work-runtime/bin/tw.mjs')
  assert.ok(physical(entry).isFile())
  const plan=await sandbox.confine([sentinel],policy,new AbortController().signal)
  const wrapped=installCliGuard({p,configuredCli:entry,loader,plan})
  // 无模型预检没有持久会话；空事件快照只验证宿主默认策略，没有权限覆写。
  const launchSession={header:{cwd:p.project},seq:0,inheritedEventCount:0,snapshotEvents:()=>[]}
  const controller=new AbortController()
  const exec={signal:controller.signal,agent:{session:launchSession}}
  const tw=await wrapped.withProbe('tw',()=>tools.get('tw').execute({args:['help']},exec))
  assert.equal(tw.card.ok,true,'探针没有返回原版 tw help 的成功回执')
  assertFacts(tw.facts,p.nonce,'tw')
  const missing='probe-'+p.nonce
  const dispatch=await wrapped.withProbe('dispatch',()=>tools.get('tw-dispatch').execute({task:missing},exec))
  assert.equal(dispatch.card.ok,false,'不存在的探针任务不得派发或创建任何成员')
  assert.equal(dispatch.card.code,'TASK_NOT_FOUND','探针没有返回真实派发拒绝')
  assertFacts(dispatch.facts,p.nonce,'dispatch')
  const tag='.twr-native-fs-'+p.nonce
  assert.equal(fs.sandboxMode,'workspace-write')
  // 原生 FS 的同一个变更前栅栏拒绝真实目录里的不存在文件；先检查拒绝，不发起真实数据写入。
  for (const outside of [path.join(p.repo,tag),path.join(p.home,tag)]) {
    await assert.rejects(()=>lstat(outside),{code:'ENOENT'})
    const target=await fs.resolve(outside)
    await assert.rejects(()=>fs.checkedTarget(target,policy),{code:'FS_SANDBOX_DENIED'})
  }
  const local=path.join(p.project,tag)
  assert.throws(()=>lstatSync(local),{code:'ENOENT'})
  const res=await tools.get('write').execute({file_path:local,content:p.nonce},{signal:controller.signal})
  assert.equal(res.operation,'create');assert.equal(res.path,local)
  assert.equal(readFileSync(local,'utf8'),p.nonce);unlinkSync(local)
  tools.guard(toolGuard(p,policyService))
  // 工具守卫是附加的收窄证据，不能替代上面的 OS 和文件服务实测。
  assert.ok(tools.checkGuards({name:'bash',arguments:{},agent:exec.agent}))
  assert.equal(tools.checkGuards({name:'tw',arguments:{args:['help']},agent:exec.agent}),undefined,'原生工具守卫必须放行本项目的 tw help')
  return { tw:{status:tw.status,nativeCard:'help',facts:tw.facts}, dispatch:{status:dispatch.status,nativeCard:dispatch.card.code,facts:dispatch.facts},
    file:{workspaceWrite:'create',repo:'FS_SANDBOX_DENIED',home:'FS_SANDBOX_DENIED'}, allowedKinds }
}
async function lstat(p) { return lstatSync(p) }
