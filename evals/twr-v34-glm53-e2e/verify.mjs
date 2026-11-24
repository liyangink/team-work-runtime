// 只读生成的 /tmp 证据；不启动模型、不读本机正式会话或工作区 .team-work。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, globSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

const [liveArg, gapArg, retryArg, roundArg, pipeArg, seamArg] = process.argv.slice(2)
if (process.argv.length !== 8) {
  console.error('用法：node verify.mjs <TMP_LIVE> <TMP_GAP> <TMP_RETRY> <TMP_ROUND> <TMP_PIPE> <TMP_SEAM>')
  process.exit(2)
}
const route = ['zai-coding-cn','glm-5.3','max']
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const text = blocks => (blocks ?? []).filter(b => b.type === 'text').map(b=>b.text).join('\n')
const decode = b => new TextDecoder('utf-8',{fatal:true}).decode(b)
const jsonl = bytes => decode(bytes).split('\n').filter(Boolean).map(JSON.parse)
function parse(s) { try { return typeof s === 'string' ? JSON.parse(s) : s } catch { return null } }
const charLength = s => [...s].length
const tuple = o => [o?.provider,o?.modelName ?? o?.model,o?.effort ?? o?.reasoningEffort]
const mark = s => /^A-(?:NOISE-OPEN|NOISE-CHECK|BLOCK-REQUEST|LEAD-ASK|LEAD-ANSWER|EXACT-RETRY)\b/.exec(s)?.[0] ?? null
const exactly = (rows,label) => { assert.equal(rows.length,1,label); return rows[0] }
function root(arg, kind) {
  const dir = realpathSync(arg)
  assert.ok(path.dirname(dir) === realpathSync('/tmp') && new RegExp('^twr-v34-'+kind+'-[A-Za-z0-9.]+$').test(path.basename(dir)), '拒绝隔离样本以外的目录')
  return dir
}
function fileAt(dir, rel) {
  const file = path.resolve(dir,rel)
  assert.ok(file.startsWith(dir + path.sep), '超出隔离证据边界')
  const st = lstatSync(file)
  assert.ok(realpathSync(file) === file && st.isFile() && st.nlink === 1 && st.size <= 128*1024*1024, '证据不是隔离目录的普通文件')
  return file
}
const raw = (dir,rel) => readFileSync(fileAt(dir,rel))
const evidence = (dir,name) => JSON.parse(decode(raw(dir,'evidence/'+name+'.json')))
const jsonEvidence = (dir,name) => existsSync(path.join(dir,'evidence',name+'.json')) ? evidence(dir,name) : null
const modelNames = ['lead','owner','challenger','expert']
function readSession(dir, rel) {
  const file = fileAt(dir, rel), original = readFileSync(file)
  // DSH 追加多个帧；zstd CLI 解完所有帧，不能把第一帧当完整会话。
  const rows = jsonl(file.endsWith('.zstd') ? execFileSync('zstd',['-dqc','--',file],{maxBuffer:128*1024*1024,timeout:15000}) : original)
  const [header, ...events] = rows
  assert.equal(header?.type,'session')
  assert.equal(header.cwd,path.join(dir,'project'))
  let turn, step, cursor = -1, lastInbox, pendingApproval, mode
  const calls = new Map(), inbox = [], wakeups = [], hints = [], requests = [], responses = [], prompts = []
  for (const {seq,type,data:d} of events) {
    assert.ok(Number.isSafeInteger(seq) && seq > cursor, '会话事件顺序不完整：'+header.id)
    cursor=seq
    if (type === 'approval/policy') pendingApproval = d.policy
    if (type === 'sandbox/mode') mode = d.mode
    if (type === 'turn/start') {
      turn = d.turn; step = null
      const source = lastInbox?.seq === seq-1 ? lastInbox.inserted?.[0]?.source : null
      wakeups.push({ seq, turn, kind:source?.kind ?? 'unknown', sender:source?.senderSessionId ?? null })
    }
    if (type === 'step/start') { turn = d.turn; step = d.step }
    if (type === 'agent/inbox/spliced') {
      lastInbox = { seq, inserted:d.inserted }
      for (const m of d.inserted ?? []) {
        const message = text(m.content)
        const marker=(m.content ?? []).filter(b=>b.type==='text').map(b=>mark(b.text)).find(Boolean) ?? null
        const row = { seq, turn, step, id:m.id, kind:m.source?.kind, sender:m.source?.senderSessionId, mark:marker, message }
        inbox.push(row)
        if (row.kind === 'twr-member-message') hints.push(seq)
      }
    }
    if (type === 'request/header') {
      requests.push({ seq, target:tuple(d.header?.config), mode, approval:pendingApproval })
    }
    if (type === 'assistant/message' && d.message?.source?.kind === 'model') {
      responses.push({ seq, target:tuple(d.message.source).slice(0,2), message:text(d.message.content) })
    }
    if (type === 'user/message' && d.source?.kind === 'user') prompts.push({seq,message:text(d.content)})
    if (type === 'tool/call') {
      assert.ok(!calls.has(d.callId),'重复工具调用 ID')
      calls.set(d.callId,{ seq,turn,step,id:d.callId,name:d.name,args:parse(d.arguments) })
    }
    if (type === 'tool/result') {
      const m = d.message, call = calls.get(m?.toolCallId)
      if (call) {
        assert.equal(call.resultSeq,undefined,'重复工具结果')
        call.resultSeq = seq; call.errored = m.isError === true; call.resultText = text(m.content); call.output = parse(call.resultText)
      }
    }
  }
  return { id:header.id,parent:header.parentSession ?? null,file:rel,sha256:sha(original),
    calls:[...calls.values()],inbox,wakeups,hints,requests,responses,prompts }
}
function caseAt(arg, kind, name) {
  const dir = root(arg,kind), journalFile = 'project/.team-work/tasks/'+name+'/journal.jsonl'
  const journal = jsonl(raw(dir,journalFile))
  assert.ok(journal.every((e,i) => Number.isSafeInteger(e.seq) && e.seq > (journal[i-1]?.seq ?? 0)), '合成任务日志顺序无法对账')
  const rootRel = 'home/.dsh/sessions'
  assert.equal(realpathSync(path.join(dir,rootRel)),path.join(dir,rootRel))
  const sessions = globSync('**/session.v*.jsonl*',{cwd:path.join(dir,rootRel)}).sort().map(rel=>readSession(dir,path.join(rootRel,rel)))
  assert.equal(new Set(sessions.map(s=>s.id)).size,sessions.length,'重复会话日志')
  const lead=exactly(sessions.filter(s=>!s.parent),'应有一个真实 Lead 会话')
  assert.ok(sessions.every(s=>s===lead || s.parent===lead.id),'检测到非同父级派发或多层委派')
  const byId=new Map(sessions.map(s=>[s.id,s]))
  const builds = evidence(dir,'build')
  const agents = JSON.parse(decode(raw(dir,'project/.team-work/tasks/'+name+'/agents.json')))
  const dispatches=journal.filter(e=>e.type==='dispatched')
  return {dir,name,journal,journalFile,sessions,lead,byId,builds,agents,dispatches}
}
const tw = (s,cmd) => s.calls.filter(c=>c.name==='tw' && c.args?.args?.[0]===cmd)
const flag = (c,name) => { const args=c.args?.args ?? []; const i=args.indexOf(name); return i<0 ? undefined : args[i+1] }
const dispatchCalls = s => s.calls.filter(c=>c.name==='tw-dispatch')
const cardOf = c => c.output?.card ?? c.output
const withRoute = () => ({ requests:0,responses:0,sessions:0 })
function modelStats(c) {
  const totals=Object.fromEntries(modelNames.map(k=>[k,withRoute()]))
  for (const s of c.sessions) {
    const roles=[...new Set(c.dispatches.filter(d=>c.agents.mappings?.[d.detail.key]===s.id).map(d=>d.detail.role))]
    const role=s===c.lead ? 'lead' : exactly(roles,'未可定位同一角色的成员会话')
    assert.ok(s.requests.length>0 && s.responses.length>0,'缺实际模型请求或提供方响应：'+s.id)
    for (const r of s.requests) {
      assert.deepEqual(r.target,route,'实际 request/header 非指定模型及强度')
      assert.equal(r.mode,'workspace-write'); assert.equal(r.approval,'never')
    }
    for (const r of s.responses) assert.deepEqual(r.target,route.slice(0,2),'响应模型不一致')
    totals[role].sessions++; totals[role].requests+=s.requests.length; totals[role].responses+=s.responses.length
  }
  return totals
}
function formalChains(c) {
  return c.dispatches.map(e=>{
    const d=e.detail,id=c.agents.mappings?.[d.key], s=c.byId.get(id)
    assert.ok(s && s.parent===c.lead.id,'派单映射没有父子会话：'+d.key)
    assert.deepEqual(tuple(d.modelRef),route)
    const dispatched = dispatchCalls(c.lead).flatMap(call=>(call.output?.dispatched ?? []).filter(x=>x.key===d.key && x.ok && x.registered && x.receiptVerified).map(item=>({ call,item })))
    const {call,item}=exactly(dispatched,'派单缺唯一、实际的已收单回执：'+d.key)
    assert.equal(item.sessionId,id)
    if (item.provider !== undefined) assert.deepEqual(tuple(item),route)
    const received=s.inbox.find(m=>m.id===item.messageId && ['派单','续派'].some(title=>m.message.includes('# '+title+'（key: '+d.key+'）')))
    assert.ok(received,'成员未实际接纳该 key 正文：'+d.key)
    // CLI 续派可能走全量正文；不以产品内部拼接渲染作为本次行为判据。
    const command=d.role==='owner' ? 'deliver' : 'review'
    const commits=c.journal.filter(r=>r.type==='report-committed' && r.detail?.dispatchKey===d.key)
    const report=commits.at(-1)
    assert.ok(report,'没有任务日志的正式报告：'+d.key)
    const accepted=tw(s,command).find(t=>t.output?.accepted===true && t.output.reportId===report.detail.reportId && t.output.ver===report.detail.ver && flag(t,'--task')===c.name && flag(t,'--key')===d.key)
    assert.ok(accepted && received.seq<accepted.seq && s.requests.some(r=>r.seq>received.seq && r.seq<accepted.seq),'未找到本轮真实请求和正式回执：'+d.key)
    return { role:d.role,round:d.round,key:d.key,journalDispatch:e.seq,journalCommit:report.seq,
      leadDispatchResult:call.resultSeq,got:received.seq,reported:accepted.resultSeq,session:id,
      outcome:report.detail.outcome ?? report.detail.recommendation, cause:d.causeDecisionId ?? null }
  })
}
function direct(c) {
  const open=exactly(tw(c.lead,'open').filter(t=>t.output?.ok),'未确认公开开单调用')
  const issued=c.journal.filter(e=>e.type==='decision-issued' && e.detail?.gateId==='intake-approval')
  const auth=exactly(c.journal.filter(e=>e.type==='intent-authorized'),'未记录唯一直接授权')
  const first=dispatchCalls(c.lead).find(t=>t.output?.dispatched?.some(x=>x.ok===true && x.receiptVerified===true))
  assert.ok(first && parse(flag(open,'--user-direction'))?.quote && first.args?.userDirection?.fields?.writable?.length &&
    c.dispatches[0]?.seq>auth.seq && auth.detail.proof?.mode==='caller-reported' && auth.detail.snapshot?.intent?.gaps?.length===0 && !issued.length,'无 gap 样本未证明免首卡实际派发')
  return { authorization:auth.seq,firstDispatch:c.dispatches[0].seq,leadDispatchResult:first.resultSeq,intakeCards:issued.length }
}
function gapCheck(c) {
  const open=exactly(tw(c.lead,'open').filter(t=>t.output?.ok),'缺真实 gap 开单')
  const issue=exactly(c.journal.filter(e=>e.type==='decision-issued'),'有 gap 应只有一张实际签发卡'), d=issue.detail
  const call=exactly(dispatchCalls(c.lead).filter(t=>cardOf(t)?.decisionId===d.decisionId),'原生派发未返回签发卡')
  const card=cardOf(call), ro=evidence(c.dir,'gap-state')
  assert.deepEqual(card.template,{version:1,form:'full'})
  assert.equal(card.kind,'intent'); assert.equal(call.output.stop,'awaiting-user'); assert.deepEqual(call.output.waves,[])
  assert.equal(card.intakeFingerprint,d.intakeFingerprint); assert.equal(ro.intakeFingerprint,d.intakeFingerprint)
  assert.equal(card.question,d.reason); assert.equal(ro.question,d.reason); assert.deepEqual(card.choices,d.choices)
  assert.ok(!call.output.presentation && !card.presentation && !ro.presentation && !c.dispatches.length && c.sessions.length===1 &&
    !tw(c.lead,'decide').length && d.reason.includes(flag(open,'--raw-requirement')) && d.reason.includes(parse(flag(open,'--gap')).question), '有 gap 不得续派、答卡、改写原话或携带呈现规则')
  assert.ok(!c.journal.some(e=>e.type==='decided'||e.type==='intent-authorized'),'有 gap 却获得直接授权或代答')
  const headings=d.reason.split('\n').filter(l=>l.startsWith('## '))
  assert.deepEqual(headings,['## 你的原始需求（不摘要、不删改）','## 目标 / 约束 / 排除','## 范围与产出','## 角色模型（3 行，恒定显示）','## 完整分包计划（执行分工）','## 待对齐的信息差','## 选项'])
  return { decision:d.decisionId,journal:issue.seq,result:call.resultSeq,headings:headings.length,cardChars:charLength(d.reason),
    exactMarkdownInModelReply:c.lead.responses.some(r=>r.message.includes(d.reason)),firstCardFingerprint:d.intakeFingerprint,dispatched:0 }
}
function msgCalls(s) {
  return s.calls.filter(c=>c.name==='send_message').map(c=>({ ...c, marker:mark(c.args?.message ?? ''),
    skipped:c.errored && /这条消息(?:还没发|未发送)/.test(c.resultText ?? ''), sent:c.errored===false && (/^message delivered to agent\b/.test(c.resultText ?? '') || typeof c.output?.messageId==='string') }))
}
const relays = (s, marker, sender) => s.inbox.filter(r=>r.kind==='agent-message' && (!marker || r.mark===marker) && (!sender || r.sender===sender))
function messageStats(c, exactRetry) {
  const ownerDispatch = c.dispatches.find(d=>d.detail.role==='owner' && d.detail.round===1)
  const owner=c.byId.get(c.agents.mappings?.[ownerDispatch?.detail.key])
  assert.ok(owner,'没有可定位的首轮 Owner')
  const memberCalls=msgCalls(owner), leadCalls=msgCalls(c.lead), noise='A-NOISE-OPEN', laterNoise='A-NOISE-CHECK'
  const urgent=exactRetry ? 'A-EXACT-RETRY' : 'A-BLOCK-REQUEST'
  const probe=exactRetry ? urgent : noise
  const attempts=memberCalls.filter(m=>m.marker===probe)
  const shown=attempts[0], sent=exactly(memberCalls.filter(m=>m.marker===urgent && m.sent),'未找到唯一成功的必要协调发送')
  assert.ok(shown?.skipped && shown.turn===sent.turn && shown.step<sent.step && owner.hints.some(seq=>seq>shown.seq && seq<sent.seq),'首条未拦截、没收到引导或没在更晚 Step 发送')
  assert.ok(attempts.length===(exactRetry ? 2 : 1),'不符合约定的重发/不重发次数')
  if (exactRetry) assert.deepEqual(sent.args,shown.args,'必要请求重发不是同地址、同正文')
  else {
    assert.ok(!memberCalls.some(m=>m.marker===laterNoise) && !relays(c.lead,noise,owner.id).length && !relays(c.lead,laterNoise,owner.id).length,
      '无效播报仍尝试或实际到达')
    assert.ok(leadCalls.some(m=>m.marker==='A-LEAD-ASK' && m.sent),'Lead 未主动问询')
    exactly(relays(owner,'A-LEAD-ASK',c.lead.id),'主动问询未实际到达 Owner')
  }
  const received=exactly(relays(c.lead,urgent,owner.id),'Lead 未唯一收到必要协调消息')
  const answer=exactly(relays(owner,'A-LEAD-ANSWER',c.lead.id),'Lead 纠偏未唯一到达 Owner')
  assert.ok(leadCalls.some(m=>m.marker==='A-LEAD-ANSWER' && m.sent && m.seq>received.seq),'Lead 未实际回应求助')
  assert.ok(tw(owner,'deliver').some(t=>t.seq>answer.seq && t.output?.accepted===true && flag(t,'--key')===ownerDispatch.detail.key),'协调未恢复正式交付')
  const wake = c.lead.wakeups.reduce((o,w) => { o[w.kind] = (o[w.kind] ?? 0)+1; return o },{})
  const members=c.sessions.filter(s=>s!==c.lead).flatMap(msgCalls)
  return { leadWakeups:wake, leadRelays:relays(c.lead).map(r=>({seq:r.seq,mark:r.mark,sender:r.sender})),
    memberAttempts:members.length,memberSoftBlocks:members.filter(m=>m.skipped).length,memberAccepted:members.filter(m=>m.sent).length,
    memberHintInjections:c.sessions.filter(s=>s!==c.lead).reduce((n,s)=>n+s.hints.length,0),
    leadAttempts:leadCalls.length,leadAccepted:leadCalls.filter(m=>m.sent).length, laterNoiseAttempts:members.filter(m=>m.marker===laterNoise).length,
    first:{seq:shown.seq,resultSeq:shown.resultSeq,turn:shown.turn,step:shown.step}, necessary:{seq:sent.seq,resultSeq:sent.resultSeq,turn:sent.turn,step:sent.step,leadInbox:received.seq,ownerAnswerInbox:answer.seq},
    ptcOuterCalls:c.sessions.flatMap(s=>s.calls).filter(c=>c.name==='run_code').length }
}
function decision(c, issued, tag, label) {
  const input=evidence(c.dir,'input-'+tag), id=issued.detail.decisionId
  const choice=issued.detail.choices.find(ch=>ch.n===input.n)
  assert.ok(input.source==='synthetic-operator-input' && input.id===id && choice?.label===label && choice.label===input.label,'外部测试答复没有绑定原卡')
  const call=exactly(tw(c.lead,'decide').filter(t=>flag(t,'--decision-id')===id),'同卡响应不恰好一次')
  assert.ok(call.output?.ok===true && flag(call,'--choice')===String(input.n) && c.lead.prompts.some(p=>p.seq<call.seq && p.message.includes(id) && p.message.includes('外部合成用户回复')), '未从原生用户输入走原生 decide')
  const event=exactly(c.journal.filter(e=>e.type==='decided' && e.detail.decisionId===id),'无唯一落盘的决定')
  assert.ok(event.seq>issued.seq && event.detail.choice===label,'决定没有在原卡后落盘')
  // 额度直接在同一 journal 事件提交凭证；人工门旧合同的凭证保留在 decisions 投影。
  const proof = issued.detail.kind==='round-limit' ? event.detail.proof : exactly(
    JSON.parse(decode(raw(c.dir,'project/.team-work/tasks/'+c.name+'/decisions.json'))).items.filter(d=>d.decisionId===id &&
      d.gateId===issued.detail.gateId && d.choice===label),'缺人工门决定凭证').proof
  assert.equal(proof?.mode,'caller-reported','决定来源不是调用方报告')
  return { event,call }
}
function rounds(c) {
  const human=c.journal.filter(e=>e.type==='decision-issued' && e.detail.gateId==='scoped-final-code-review')
  const limited=exactly(c.journal.filter(e=>e.type==='decision-issued' && e.detail.kind==='round-limit'),'预期一张实际自主额度卡')
  assert.equal(human.length,2,'预期两张独立人工验收卡')
  const rework=decision(c,human[0],'rework','rework')
  const grantChoice=exactly(limited.detail.choices.filter(ch=>ch.grant==='extra-round'),'缺追加一轮选项')
  const grant=decision(c,limited,'extra-round',grantChoice.label)
  const finish=decision(c,human[1],'finish','accept')
  const owners=c.dispatches.filter(e=>e.detail.role==='owner')
  assert.deepEqual(owners.map(e=>e.detail.round),[1,2,3,4,5])
  assert.ok(owners[1].detail.causeDecisionId===human[0].detail.decisionId && rework.event.seq<owners[1].seq &&
    owners[3].seq<limited.seq && limited.seq<grant.event.seq && grant.event.seq<owners[4].seq && owners[4].seq<human[1].seq,
    '人工返工、上限、单次决定和下一轮顺序无法证明')
  assert.equal(grant.event.detail.grant,'extra-round')
  assert.deepEqual(grant.event.detail.roundLimit,limited.detail.roundLimit,'批准没有沿用原耗尽绑定')
  const budget=exactly(limited.detail.roundLimit.exhausted,'单 Owner 应只有一项额度耗尽')
  assert.ok(budget.package===null && budget.round===4 && budget.used===3 && budget.limit===3,'展示轮与自主额度不符 4 / 3 / 3')
  const reviews=c.journal.filter(e=>e.type==='report-committed' && e.detail.role==='challenger')
  assert.deepEqual(reviews.map(e=>[e.detail.round,e.detail.recommendation]),[[1,'accept'],[2,'rework'],[3,'rework'],[4,'rework'],[5,'accept']])
  assert.ok(evidence(c.dir,'completed').status==='completed' && finish.event.seq>human[1].seq,'未完成末轮及最终验收')
  return { owners:owners.map(e=>({ round:e.detail.round,journal:e.seq,key:e.detail.key,cause:e.detail.causeDecisionId??null })),
    firstHuman:{ id:human[0].detail.decisionId,issued:human[0].seq,decided:rework.event.seq },
    roundLimit:{ id:limited.detail.decisionId,issued:limited.seq,decided:grant.event.seq,binding:limited.detail.roundLimit,grantBinding:grant.event.detail.roundLimit,leadDecide:grant.call.seq },
    final:{ id:human[1].detail.decisionId,issued:human[1].seq,decided:finish.event.seq },status:'completed' }
}
function presentation(c, required) {
  const cards=c.lead.calls.filter(t=>['tw','tw-dispatch'].includes(t.name)&&t.output?.ok===true)
  const groups={ dispatch:[],human:[],progress:[],quiet:[], roundLimit:[] }
  for (const call of cards) {
    const output=call.output, card=cardOf(call)
    const values=[output.presentation,...(card!==output?[card.presentation]:[])].filter(x=>x!==undefined)
    assert.ok(values.length<=1 && values.every(v=>typeof v==='string'),'呈现规则重复或形状变化')
    assert.ok(!call.resultText.includes('�') && output.code!=='TW_OUTPUT_UNPARSEABLE','原生结果有 UTF-8 损坏')
    const body=(values[0]??'').split('\n').filter(l=>!l.startsWith('详细规范（')).join('\n').trim()
    const entry={ seq:call.resultSeq,chars:charLength(body),totalChars:charLength(values[0]??''),
      reviewSections:(body.match(/^## clarity 审阅短节选$/gm)??[]).length }
    assert.ok(!body.includes('## 明晰表达必读') && entry.reviewSections<=1,'重复或混入公共明晰段')
    if (output.dispatched?.some(d=>d.ok&&d.receiptVerified)) groups.dispatch.push(entry)
    if (call.name==='tw-dispatch' && card?.gateId==='scoped-final-code-review') groups.human.push(entry)
    if (call.name==='tw-dispatch' && card?.kind==='round-limit') groups.roundLimit.push(entry)
    if (call.name==='tw-dispatch' && output.stop==='completed') groups.progress.push(entry)
    if (call.name==='tw' && call.args?.args?.[0]==='run' && ['working','wait-inflight'].includes(output.status)) groups.quiet.push(entry)
  }
  const missing = Object.entries(required).filter(([kind])=>!groups[kind].length).map(([,label])=>label)
  assert.ok(!missing.length,'未覆盖：缺少原生回执（'+missing.join('、')+'）')
  assert.ok(groups.dispatch.length && groups.dispatch.every(p=>p.chars>0&&p.chars<=120),'例行派发不精简或未实测')
  assert.ok(groups.human.length && groups.human.every(p=>p.chars>0&&p.chars<=360&&p.reviewSections===1),'真实审批缺短规则或超预算')
  assert.ok(groups.quiet.every(p=>p.chars===0) && groups.roundLimit.every(p=>p.chars===0),'例行状态或机械卡带规则')
  if (groups.progress.length) assert.ok(groups.progress.every(p=>p.chars>0&&p.chars<=180),'完成呈现缺短规则或超预算')
  return groups
}
function verifyPipe(arg) {
  const dir=root(arg,'pipe'), events=jsonl(raw(dir,'evidence/probe.native.jsonl')), event=exactly(events,'管道证据应是一次真实宿主预检')
  assert.ok(event.ok && event.pipe?.length)
  for (const row of event.pipe) {
    const bytes=raw(dir,'evidence/'+row.file)
    assert.equal(sha(bytes),row.sha256); assert.equal(bytes.length,row.bytes)
    let cursor=0
    const chunks=row.chunks.map(n=>{ const start=cursor; cursor+=n; return bytes.subarray(start,cursor) })
    assert.equal(cursor,bytes.length)
    cursor=0
    const boundaries=row.chunks.slice(0,-1).map(n=>cursor+=n)
    assert.deepEqual(row.splits.map(s=>s.offset),boundaries.filter(n=>(bytes[n]&0xc0)===0x80))
    assert.equal(chunks.map(c=>c.toString('utf8')).join('').includes('�'),row.replacementIfDecodedPerChunk)
    const card=JSON.parse(decode(bytes)), question=row.command==='run'?card.question:card.card?.question
    assert.ok(sha(question)===row.questionSha256 && !question.includes('�'))
  }
  for (const cmd of ['dispatch-plan','run']) assert.ok(event.pipe.some(row=>row.command===cmd && row.splits.length && row.replacementIfDecodedPerChunk))
  return event.pipe
}
function verifySeam(arg) {
  const dir=root(arg,'seam'), stat=evidence(dir,'seam'), tap=raw(dir,'evidence/tap.log')
  assert.equal(sha(tap),stat.tapSha256); assert.equal(sha(raw(dir,'evidence/stderr.log')),stat.stderrSha256)
  const counts=Object.fromEntries([...decode(tap).matchAll(/^# (tests|pass|fail|skipped) (\d+)$/gm)].map(m=>[m[1],Number(m[2])]))
  for (const [key,n] of Object.entries(counts)) assert.equal(stat[key],n)
  assert.ok(stat.dsh==='0.2.2-rc.5' && stat.unchanged)
  return { ...stat,meetsBaseline:stat.pass===10 && stat.tests===10 && stat.fail===0 && stat.skipped===0 && stat.exitCode===0 }
}

const verified = {}
function check(name, action) {
  try { verified[name]={ ok:true, result:action() } }
  catch (error) { verified[name]={ ok:false, reason:String(error.message).split('\n')[0] } }
}
let live,gap,retry,round
check('载入样本',()=>{
  live=caseAt(liveArg,'live','coordination-sample'); gap=caseAt(gapArg,'gap','gap-sample'); retry=caseAt(retryArg,'retry','urgent-retry-sample')
  const builds=[live,gap,retry].map(c=>c.builds.sourceSha256).concat(evidence(root(pipeArg,'pipe'),'build').sourceSha256)
  assert.ok(new Set(builds).size===1,'样本未采用相同源码快照')
  return builds[0]
})
if (live) {
  check('模型和真实回执',()=>{
    const models=modelStats(live)
    assert.ok(modelNames.every(r=>models[r].requests>0),'主样本有未执行的角色')
    return { models, formal:formalChains(live) }
  })
  check('A-降噪和主动协调',()=>messageStats(live,false))
  check('B-无信息差直接派发',()=>direct(live))
  check('D-精简呈现',()=>presentation(live,{quiet:'普通状态'}))
}
check('载入轮次样本',()=>{
  round=caseAt(roundArg,'round','round-sample')
  assert.equal(round.builds.sourceSha256,live?.builds.sourceSha256,'轮次样本并非同一源码快照')
  return round.builds.sourceSha256
})
if (round) {
  check('C-单次追加下一轮',()=>rounds(round))
  check('C-各轮模型及正式回执',()=>({models:modelStats(round),formal:formalChains(round)}))
  check('D-额度和完成呈现',()=>presentation(round,{roundLimit:'轮次上限卡',progress:'完成'}))
}
if (retry) check('A-必要消息原样重发',()=>({ ...messageStats(retry,true),models:modelStats(retry),formal:formalChains(retry) }))
if (gap) check('B-有信息差固定首卡',()=>({ ...gapCheck(gap),models:modelStats(gap) }))
check('D-真实管道 UTF-8',()=>verifyPipe(pipeArg))
check('接缝原始计数',()=>verifySeam(seamArg))
for (const c of [live,gap,retry,round].filter(Boolean)) {
  verified[c.name]={ journal:c.journalFile,journalSha256:sha(raw(c.dir,c.journalFile)),
    sessions:c.sessions.map(s=>({id:s.id,file:s.file,sha256:s.sha256,requests:s.requests.length,responses:s.responses.length})),
    runner:jsonEvidence(c.dir,'finish'), initialStop:jsonEvidence(c.dir,'stopped'), resumeStop:jsonEvidence(c.dir,'stopped-resume') }
}
console.log(JSON.stringify(verified,null,2))
if (Object.values(verified).some(r=>r.ok===false || r.result?.meetsBaseline===false)) process.exitCode=1
