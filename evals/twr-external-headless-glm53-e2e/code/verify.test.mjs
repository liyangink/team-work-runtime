// 以下事件全部是测试夹具；即使断言通过，也不作实机、模型或用户许可证据。
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { code, modelTuple, target, task, paths } from './shared.mjs'
import { assertProbe, verifyNoModelTrace, parseEvents, verifyIntake, verifyChain, verifyFinal, approvalFor, approvalInput, approvalSources } from './verify.mjs'
import { fixtureText, renderFile } from './verify-files.mjs'
const model = modelTuple(target), nonce = 'fixture-nonce'
function proof() {
  const facts = { nonce, cwdCorrect:true, isolatedHome:true, projectWrite:'ALLOWED', repoExisting:'EPERM', repoNestedExisting:'EPERM', repoCreate:'EPERM', homeCreate:'EACCES' }
  const through = channel => ({...facts,channel,depth:'parent',descendant:{...facts,channel,depth:'descendant'}})
  return { nonce, type:'native-probe', mode:'workspace-write', enforcement:'full', exitCode:0, timedOut:false, aborted:false, stdoutTruncated:false, stderrTruncated:false, route:model, loadedBundle:true,
    facts:through('shell'), nativeEntries:{allowedKinds:['read','skill','tw','tw-dispatch','write'],
      tw:{status:0,nativeCard:'help',facts:through('tw')},dispatch:{status:1,nativeCard:'TASK_NOT_FOUND',facts:through('dispatch')},
      file:{workspaceWrite:'create',repo:'FS_SANDBOX_DENIED',home:'FS_SANDBOX_DENIED'}} }
}
test('原生预检必须同时证明本轮、原生写限制、正例、拒写与后代继承', () => {
  assert.equal(assertProbe(proof(),nonce),true)
  for (const [f,msg] of [
    [o=>o.nonce='other', /不属于本次/], [o=>o.enforcement='partial', /完全写限制/],
    [o=>o.facts.repoCreate='ALLOWED', /repoCreate/], [o=>o.facts.homeCreate='ENOENT', /homeCreate/],
    [o=>o.facts.repoNestedExisting='EISDIR', /repoNestedExisting/], [o=>o.facts.projectWrite='EACCES', /未实写/],
    [o=>delete o.facts.descendant, /descendant/], [o=>o.stdoutTruncated=true,/Expected values/],
    [o=>delete o.nativeEntries, /仅有 shell/], [o=>o.nativeEntries.tw.facts.descendant.homeCreate='ALLOWED', /homeCreate/],
    [o=>o.nativeEntries.dispatch.facts=o.facts, /入口证据/], [o=>o.nativeEntries.file.repo='EROFS',/Expected values/],
    [o=>o.route=['other','other','max'],/Expected values/],
    [o=>Object.assign(o,{type:'native-probe-error',code:'SANDBOX_UNAVAILABLE',detail:'sandbox_apply'}), /SANDBOX_UNAVAILABLE.*sandbox_apply/],
  ]) { const sample = proof(); f(sample); assert.throws(()=>assertProbe(sample,nonce),msg) }
})
test('无模型探针只接受空 stdin 的诊断，拒绝额外事件或持久会话', (t) => {
  const dir=mkdtempSync(path.join(code,'.no-model-'))
  t.after(()=>rmSync(dir,{recursive:true}))
  const eof=JSON.stringify({type:'error',message:'a task is required, for example: dsh --profile headless "run the tests"'})
  assert.equal(verifyNoModelTrace('',dir),true)
  assert.equal(verifyNoModelTrace(eof,dir),true)
  assert.throws(()=>verifyNoModelTrace(eof+'\n'+JSON.stringify({type:'final'}),dir),/无模型探针不应有运行轨迹/)
  assert.throws(()=>verifyNoModelTrace(JSON.stringify({type:'error',message:'mismatch'}),dir),/无模型探针不应有运行轨迹/)
  mkdirSync(path.join(dir,'sessions'))
  writeFileSync(path.join(dir,'sessions/session.v1.jsonl.zstd'),'synthetic')
  assert.throws(()=>verifyNoModelTrace(eof,dir),/意外产生会话日志/)
})
const modelEvents = [
  { seq:0,type:'sandbox/mode',data:{mode:'workspace-write'} }, { seq:1,type:'approval/policy',data:{policy:'never'} },
  { seq:2,type:'request/header',data:{header:{config:target}} },
  { seq:3,type:'assistant/message',data:{message:{source:{kind:'model', provider:target.provider,model:target.model}}} },
]
test('实际请求头不能由描述符、缺省强度或未收到提供方的输出代替', () => {
  assert.equal(parseEvents({id:'fixture'}, modelEvents).requests.length,1)
  const broken = structuredClone(modelEvents)
  delete broken[2].data.header.config.reasoningEffort
  assert.throws(()=>parseEvents({id:'fixture'}, broken),/request\/header/)
  assert.throws(()=>parseEvents({id:'fixture'}, modelEvents.slice(0,-1)),/提供方响应/)
  assert.throws(()=>parseEvents({id:'fixture'},[...modelEvents,{seq:4,type:'sandbox/mode',data:{mode:'danger-full-access'}}]),/非预期沙箱/)
})

const clip = readFileSync(path.join(code,'offline-cli.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse)
const steps = new Map(clip.filter(x=>x.step?.startsWith(task+'/')).map(x=>[x.step.slice(task.length+1),x]))
const row = step => { const r = steps.get(step); assert.ok(r,'离线输出须在本测试前刷新：'+step); return r }
const native = (step,seq) => ({ name:'tw',args:{args:row(step).argv},output:row(step).output,seq,resultSeq:seq+1,error:false })
const passCard = (step,seq) => ({ name:'tw-dispatch',args:{task},seq,resultSeq:seq+1,error:false,output:row(step).output })
function fixture(project) {
  const state = { ...row('intake').output.card }
  const final = row('final-wait').output
  const approve = (s,grant) => {
    const n = s.choices.find(x=>x.grant===grant || x.label===grant).n
    return { id:s.decisionId,n,phrase:'批准 '+s.decisionId+' '+n }
  }
  const start = approve(state,'accept-intake'), end = approve(final,'accept')
  const lead = { id:'fixture-top', parent:null, depth:0, requests:[target], providerResponses:1,
    receipts:[],prompts:[],calls:[{ name:'skill',args:{name:'team-work'},seq:0,resultSeq:1 },{ name:'tw',args:{args:['help']},seq:2,resultSeq:3,output:{ok:true} },native('plan',4),passCard('intake',6)] }
  const r = lead.calls[2].output.packages[0].model
  const actual = { provider:target.provider,modelName:target.model,effort:target.reasoningEffort }
  assert.equal(r.modelName,'fixture-model')
  lead.calls[3].output = structuredClone(lead.calls[3].output)
  for (const p of lead.calls[3].output.card.intake.packages) { p.modelRef = actual; p.model = actual }
  const roles = { roles:{ owner:actual, challenger:actual, expert:actual } }
  const copyBefore = structuredClone(lead)
  lead.prompts.push({seq:8,text:'外部终端操作者已明确输入：'+start.phrase+'。'})
  lead.calls.push(native('simulated-intake',9))
  const member = role => ({ id:'fixture-'+role,parent:lead.id,depth:1,requests:[],receipts:[],calls:[],providerResponses:1,
    descriptor:{label:'CR·'+role+' · 审查夹具 #'+task, agentProvider:model[0],agentModel:model[1],agentReasoningEffort:model[2]} })
  const a=member('owner@alpha'), b=member('owner@beta'), c=member('chal'), e=member('expert')
  const groups = [
    ['initial-wave',[[a,'first-alpha'],[b,'first-beta']]],
    ['first-challenger',[[c,'challenger-selective']]],
    ['challenger-rework-alpha-only',[[a,'changed-key-added-and-removed']]],
    ['challenger-review-new-set',[[c,'challenger-accept-with-separate-context']]],
    ['expert-review',[[e,'expert-accept-rework-combination']]],
    ['expert-rework-alpha-only',[[a,'changed-key-content-only']]],
    ['challenger-rereview',[[c,'challenger-final-accept']]],
    ['expert-rerule',[[e,'expert-final-accept']]],
  ]
  const {initial,ready,legacy,index,beta}=fixtureText
  const reads=(v,old=false)=>[['read',paths.main,v],['read',old?paths.legacy:paths.index,old?legacy:index],['read',paths.beta,beta]]
  const events={ 'first-alpha':[['write',paths.main,'create',initial],['write',paths.legacy,'create',legacy]],
    'first-beta':[['write',paths.beta,'create',beta]], 'challenger-selective':reads(initial,true),
    'changed-key-added-and-removed':[['write',paths.index,'create',index]], 'challenger-accept-with-separate-context':reads(initial),
    'expert-accept-rework-combination':reads(initial), 'changed-key-content-only':[['read',paths.main,initial],['write',paths.main,'update',ready]],
    'challenger-final-accept':reads(ready),'expert-final-accept':reads(ready) }
  for (const [i,[name,assignments]] of groups.entries()) {
    const result = passCard(name,20+i*12)
    result.output = structuredClone(result.output)
    result.output.dispatched = result.output.waves.map((w,j)=>{
      const [s,report] = assignments[j], offset = s.receipts.length*40
      s.receipts.push({key:w.dispatchKey,text:w.prompt,seq:offset+1})
      s.requests.push({seq:offset+2,...target})
      for (const [k,[kind,file,value,contents]] of events[report].entries()) {
        const seq=offset+3+k*2
        s.calls.push({name:kind,args:{file_path:file,...(kind==='write'?{content:contents}:{})},seq,resultSeq:seq+1,error:false,fileText:renderFile(kind,path.join(project,file),value)})
      }
      s.calls.push(native(report,offset+20))
      return {key:w.dispatchKey,sessionId:s.id,waveId:w.waveId,ok:true,registered:true,receiptVerified:true,action:s.calls.length===1?'created':'followup'}
    })
    lead.calls.push(result)
  }
  lead.calls.push(native('e2e-route',122),passCard('final-acceptance',126))
  for (const [p,txt] of [[paths.main,'状态：归档就绪'],[paths.index,'索引已复核'],[paths.beta,'乙包已核验'],[paths.legacy,'旧版交接']]) {
    const f=path.join(project,p);mkdirSync(path.dirname(f),{recursive:true});writeFileSync(f,txt+'\n')
  }
  return { lead, input:{sessions:[lead,a,b,c,e],project,top:lead.id,start,gate:final}, end, copyBefore, state, roles }
}

test('外部测试驱动仅为当前、未过期的两道指定卡生成绑定短句', () => {
  const intake = row('intake').output.card
  const final = row('final-wait').output
  for (const [card, kind] of [[intake,'intake'], [final,'final']]) {
    const a = approvalFor(card,kind,approvalSources.test)
    assert.equal(a.id, card.decisionId)
    assert.equal(a.phrase, '批准 ' + card.decisionId + ' ' + a.n)
    assert.match(approvalInput(a), /^外部测试驱动器/)
    assert.throws(()=>approvalFor({...card,status:'completed'},kind,approvalSources.test))
    assert.throws(()=>approvalFor({...card,stale:true},kind,approvalSources.test))
    assert.throws(()=>approvalFor(card,kind,'unknown-source'), /外部输入来源/)
  }
  assert.throws(()=>approvalFor(intake,'final',approvalSources.test), /最终人工门/)
  assert.throws(()=>approvalFor(final,'intake',approvalSources.test), /意图卡/)
  const duplicate = structuredClone(intake)
  duplicate.choices.push({...duplicate.choices[0],n:99})
  assert.throws(()=>approvalFor(duplicate,'intake',approvalSources.test), /恰有一项/)
})

test('合成自动应答不可冒充人工，且必须晚于每道门的实际回执', (t) => {
  const p=mkdtempSync(path.join(code,'.validator-auto-'))
  t.after(()=>rmSync(p,{recursive:true}))
  const {lead,input,end,state}=fixture(p)
  input.start = approvalFor(state,'intake',approvalSources.test)
  assert.throws(()=>verifyChain(input),/明确批准输入消息/)
  lead.prompts[0].text=approvalInput(input.start)
  assert.equal(verifyChain(input).mappings.length,9)
  const final=approvalFor(input.gate,'final',approvalSources.test)
  assert.equal(final.id,end.id)
  lead.prompts.push({seq:128,text:approvalInput(final)})
  lead.calls.push(native('simulated-final-accept',129),passCard('complete',133))
  const complete={...input,end:final,status:{status:'completed'},finalGate:row('gate-passed').output}
  assert.equal(verifyFinal(complete).completed,true)
  lead.prompts[1].seq=127
  assert.throws(()=>verifyFinal(complete),/先收到待决回执/)
  lead.prompts[1].seq=128
  lead.prompts[0].seq=7
  assert.throws(()=>verifyFinal(complete),/先收到待决回执/)
})

test('使用真实 CLI 输出构造合成轨迹，验证九个派单键、角色、清单、原文和两道人门的严格判定', (t) => {
  const p=mkdtempSync(path.join(code,'.validator-'))
  t.after(()=>rmSync(p,{recursive:true}))
  const {lead,input,end,copyBefore,state,roles}=fixture(p)
  assert.equal(verifyIntake({state,roles,sessions:[copyBefore],top:input.top}),true)
  const chain=verifyChain(input)
  assert.equal(chain.mappings.length,9)
  assert.equal(chain.artifacts.omittedLegacyKept,true)
  assert.equal(chain.fileTrail.filter(x=>x.kind==='write').length,5)
  assert.equal(chain.fileTrail.filter(x=>x.kind==='read').length,16)
  assert.ok(chain.fileTrail.filter(x=>x.kind==='read').every(x=>!Object.hasOwn(x,'operation')), '读证据无写操作字段')
  assert.deepEqual(JSON.parse(JSON.stringify(chain.fileTrail)),chain.fileTrail, '落盘后可逐字段重算读写证据')
  assert.match(chain.handoff.expert,/EX-ALPHA-READY/)
  lead.prompts.push({seq:128,text:'外部终端操作者已明确输入：'+end.phrase+'。'})
  lead.calls.push(native('simulated-final-accept',129),passCard('complete',133))
  assert.throws(()=>verifyChain(input),/人工门未获批准/)
  const complete={...input,end,status:{status:'completed'},finalGate:row('gate-passed').output}
  assert.equal(verifyFinal(complete).completed,true)
  const wrongChoice=structuredClone(complete);wrongChoice.end.n++
  assert.throws(()=>verifyFinal(wrongChoice),/明确批准/)
  const wrongBinding=structuredClone(complete);wrongBinding.sessions[2].parent='other'
  assert.throws(()=>verifyFinal(wrongBinding),/Expected values/)
  const missingReceipt=structuredClone(complete);missingReceipt.sessions[1].receipts.pop()
  assert.throws(()=>verifyFinal(missingReceipt),/同 key 单块宿主接单/)
  const wrongDiff=structuredClone(complete);wrongDiff.sessions[1].calls.find(c=>c.output?.removed?.length).output.removed=[]
  assert.throws(()=>verifyFinal(wrongDiff),/removed/)
  const wrongHandoff=structuredClone(complete);wrongHandoff.sessions[1].receipts[2].text+='\nCTX-BETA'
  assert.throws(()=>verifyFinal(wrongHandoff),/混入其他包意见/)
  const noRead=structuredClone(complete); noRead.sessions[3].calls.shift()
  assert.throws(()=>verifyFinal(noRead),/缺少本轮完成且成功的原生文件调用/)
  const noWrite=structuredClone(complete); noWrite.sessions[1].calls.shift()
  assert.throws(()=>verifyFinal(noWrite),/缺少本轮完成且成功的原生文件调用/)
  const prefabricated=structuredClone(complete); prefabricated.sessions[1].calls[0].fileText=renderFile('write',path.join(p,paths.main),'update')
  assert.throws(()=>verifyFinal(prefabricated),/实际操作或初始状态不符/)
  const wrongInitial=structuredClone(complete); wrongInitial.sessions[1].calls[0].args.content=fixtureText.ready
  assert.throws(()=>verifyFinal(wrongInitial),/初始状态不符/)
  const stale=structuredClone(complete); const lastC=stale.sessions[3].calls.find(c=>c.name==='read'&&c.seq>80)
  lastC.fileText=renderFile('read',path.join(p,paths.main),fixtureText.initial)
  assert.throws(()=>verifyFinal(stale),/原生回执版本/)
  const late=structuredClone(complete); late.sessions[3].calls[0].resultSeq=500
  assert.throws(()=>verifyFinal(late),/缺少本轮完成/)
  const leadWrite=structuredClone(complete); leadWrite.sessions[0].calls.push({...leadWrite.sessions[1].calls[0]})
  assert.throws(()=>verifyFinal(leadWrite),/未对应正式交付|不得/)
  const earlyGate=structuredClone(complete);earlyGate.finalGate.passed=false
  assert.throws(()=>verifyFinal(earlyGate),/Expected values/)
})
