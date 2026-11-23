// 只认真实宿主持久化事件与公开监督回执；输入缺损、出现其他模型或无法对账均停止。
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { physical, target, modelTuple, task, paths, plans, sha, tree } from './shared.mjs'
import { verifyFileTrail } from './verify-files.mjs'

const expected = modelTuple(target)
const rejected = new Set(['EPERM','EACCES'])
export function assertProbe(row, nonce) {
  assert.equal(row?.nonce, nonce, '原生预检结果不属于本次子进程')
  if (row.type === 'native-probe-error') throw new Error(row.code + ': ' + row.detail)
  assert.equal(row.type, 'native-probe')
  assert.equal(row.mode, 'workspace-write')
  assert.equal(row.enforcement, 'full', '只能在原生执行器报告完全写限制时放行')
  assert.equal(row.loadedBundle, true)
  assert.deepEqual(row.route, expected)
  assert.equal(row.exitCode, 0); assert.equal(row.timedOut, false); assert.equal(row.aborted, false)
  assert.equal(row.stdoutTruncated, false); assert.equal(row.stderrTruncated, false)
  assertNativeFacts(row.facts,nonce,'shell')
  const n=row.nativeEntries
  assert.ok(n?.tw && n?.dispatch && n?.file,'仅有 shell 证据，原生工具写边界未证')
  assert.deepEqual([n.tw.status,n.tw.nativeCard,n.dispatch.status,n.dispatch.nativeCard],[0,'help',1,'TASK_NOT_FOUND'])
  assertNativeFacts(n.tw.facts,nonce,'tw')
  assertNativeFacts(n.dispatch.facts,nonce,'dispatch')
  assert.deepEqual(n.file,{workspaceWrite:'create',repo:'FS_SANDBOX_DENIED',home:'FS_SANDBOX_DENIED'})
  assert.deepEqual(n.allowedKinds,['read','skill','tw','tw-dispatch','write'])
  return true
}
export function assertNativeFacts(root,nonce,channel) {
  for (const [level, facts] of [['parent',root],['descendant',root?.descendant]]) {
    assert.equal(facts?.channel,channel,channel+'：缺少 '+level+' 的入口证据')
    assert.equal(facts?.nonce, nonce, level + ' 原生执行未到达探针')
    assert.equal(facts.depth, level)
    assert.equal(facts.cwdCorrect, true)
    assert.equal(facts.isolatedHome, true)
    assert.equal(facts.projectWrite, 'ALLOWED', level + ' 隔离工作区中未实写成功')
    for (const k of ['repoExisting', 'repoNestedExisting', 'repoCreate', 'homeCreate']) assert.ok(rejected.has(facts[k]), level + ' 已有文件/目录的拒写证据不足：' + k + '=' + facts[k])
  }
  return true
}
export function verifyNoModelTrace(stdout, dshHome) {
  // rc.5 在空 stdin EOF 后最多返回一条已观察的缺任务诊断；不能有任何会话或模型轨迹。
  const lines=stdout.trim() ? stdout.trim().split('\n').map(JSON.parse) : []
  if (lines.length) assert.deepEqual(lines,[{type:'error',message:'a task is required, for example: dsh --profile headless "run the tests"'}], '无模型探针不应有运行轨迹')
  if (dshHome) {
    const sessions=path.join(dshHome,'sessions')
    assert.ok(!existsSync(sessions) || !Object.keys(tree(sessions,['.'])).some(name=>/session\.v\d+\.jsonl/.test(name)), '无模型探针意外产生会话日志')
  }
  return true
}
const text = (blocks) => (Array.isArray(blocks) ? blocks : []).filter(b => b.type === 'text').map(b => b.text).join('')
const receiptKey = (s) => /^# (?:派单|续派|续派全量变体)（key: (d\d+-[a-f0-9]+)）(?:——[^\r\n]*)?$/.exec(s.split('\n', 1)[0].replace(/\r$/, ''))?.[1]
function parse(input) { try { return typeof input === 'string' ? JSON.parse(input) : input } catch { return null } }
function argv(call) { return call.args?.args ?? [] }
const arg = (a, name) => { const i = a.indexOf(name); return i < 0 ? undefined : a[i + 1] }
function exactly(array, label) { assert.equal(array.length, 1, label + ' 必须恰有一项'); return array[0] }
function readRows(file) {
  const raw = readFileSync(file)
  let buf = raw
  if (file.endsWith('.zstd')) {
    // 宿主按增量写多个压缩帧；Node 同步解码只读首帧。CLI -dc 会读完所有帧。
    const r = spawnSync('zstd', ['-dqc', '--', file], { maxBuffer: 128 * 1024 * 1024, timeout: 15000 })
    assert.equal(r.status, 0, 'zstd 未完整解压会话日志（需要本机 zstd CLI）')
    buf = r.stdout
  }
  return { rows: buf.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)), fileHash: sha(raw) }
}
export function verifySessions(dshHome, project) {
  const root = path.join(dshHome, 'sessions')
  const sessions = []
  function walk(dir) {
    assert.ok(physical(dir).isDirectory())
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      const stat = physical(p)
      if (stat.isDirectory()) walk(p)
      else if (/^session\.v\d+\.jsonl(?:\.zstd)?$/.test(entry.name)) {
        assert.ok(stat.isFile() && stat.nlink === 1 && stat.size < 128 * 1024 * 1024, '会话文件不符合私有普通日志边界')
        const { rows, fileHash } = readRows(p)
        const [header, ...evs] = rows
        assert.equal(header?.type, 'session')
        assert.equal(header.cwd, project)
        assert.ok(typeof header.id === 'string' && header.id)
        const parsed = parseEvents(header, evs)
        sessions.push({ ...parsed, file: path.relative(dshHome, p), fileHash })
      }
    }
  }
  walk(root)
  assert.equal(new Set(sessions.map(s => s.id)).size, sessions.length, '一会话多份日志，不能择优判定')
  return sessions
}
export function parseEvents(header, evs) {
  const calls = [], ids = new Map(), receipts = [], prompts = [], requests = []
  let prior = -1, mode, approval, descriptor, providerResponses = 0
  for (const e of evs) {
    assert.ok(Number.isInteger(e.seq) && e.seq > prior, '宿主日志不完整/事件顺序不明确：' + header.id)
    prior = e.seq
    const d = e.data
    if (e.type === 'sandbox/mode') { mode = d.mode; assert.equal(mode, 'workspace-write', '会话切换到非预期沙箱') }
    if (e.type === 'approval/policy') {
      approval = d.policy
      // 顶层先通过 permission preset 记 ask、再由 headless 在同次请求前明确覆盖为 never。
      assert.ok(['ask','never'].includes(approval), '未知审批策略')
    }
    if (e.type === 'subagent/descriptor') descriptor = d
    if (e.type === 'request/header') {
      const c = d?.header?.config
      assert.deepEqual([c?.provider, c?.model, c?.reasoningEffort], expected, 'request/header 不是精确目标：' + header.id + '#' + e.seq)
      assert.equal(mode, 'workspace-write', '请求前缺少会话真实沙箱事件')
      assert.equal(approval, 'never', '请求前缺少禁用审批事件')
      requests.push({ seq: e.seq, provider: c.provider, model: c.model, effort: c.reasoningEffort })
    }
    if (e.type === 'assistant/message' && d?.message?.source?.kind === 'model') {
      assert.deepEqual([d.message.source.provider, d.message.source.model], expected.slice(0, 2), '提供方响应记录与请求头不一致')
      providerResponses++
    }
    if (e.type === 'user/message' && d?.source?.kind === 'user') prompts.push({ seq: e.seq, text: text(d.content) })
    if (e.type === 'agent/inbox/spliced') for (const m of d?.inserted ?? []) {
      for (const b of m.content ?? []) {
        const key = b.type === 'text' && typeof b.text === 'string' ? receiptKey(b.text) : null
        if (key) receipts.push({ key, seq: e.seq, text: b.text })
      }
    }
    if (e.type === 'tool/call') {
      assert.ok(!ids.has(d.callId), '工具调用 ID 重复')
      const item = { id: d.callId, name: d.name, args: parse(d.arguments), seq: e.seq }
      calls.push(item); ids.set(d.callId, item)
      assert.ok(!['subagent','subagent_fork','workflow','create_goal','update_goal'].includes(item.name), '出现非正式委派或自动 Goal')
      assert.ok(!item.args?.sandbox_permissions || item.args.sandbox_permissions === 'workspace-write', '模型尝试更宽写权限')
    }
    if (e.type === 'tool/result') {
      const m = d?.message
      const item = ids.get(m?.toolCallId)
      if (item) {
        assert.ok(item.resultSeq === undefined, '同一个工具调用有冲突结果')
        item.resultSeq = e.seq; item.output = parse(text(m.content)); item.error = m.isError === true
        if (['read','write'].includes(item.name)) item.fileText=text(m.content)
      }
    }
  }
  assert.ok(requests.length && providerResponses, '没有真实请求头及提供方响应：' + header.id)
  assert.equal(approval, 'never'); assert.equal(mode, 'workspace-write')
  return { id: header.id, parent: header.parentSession ?? null, depth: header.delegationDepth ?? 0, descriptor, calls, requests, providerResponses, receipts, prompts }
}
function acceptedTool(call, msg) { assert.ok(call && !call.error && call.output?.ok !== false && (call.output?.ok === true || call.output?.accepted === true), msg); return call.output }
function twCalls(s, cmd) { return s.calls.filter(c => c.name === 'tw' && argv(c)[0] === cmd) }
function dispatches(s) { return s.calls.filter(c => c.name === 'tw-dispatch' && c.args?.task === task) }
const cardId = (output) => output?.decisionId ?? output?.card?.decisionId
const rolePattern = (label, role) => typeof label === 'string' && label.startsWith('CR·' + role) && label.endsWith(' #' + task)
function pending(state) {
  assert.equal(state.status, 'awaiting-user')
  assert.equal(state.next, 'decide')
  assert.equal(state.stale, undefined)
  const card = exactly(state.pendingDecisions ?? [{ decisionId: state.decisionId, question: state.question, choices: state.choices }], '只允许一张当前待决卡')
  assert.ok(card.decisionId && card.choices?.length)
  return card
}
export { pending }
export const approvalSources = Object.freeze({ terminal: 'terminal-operator', test: 'test-driver' })
const approvalPrefixes = new Map([
  [approvalSources.terminal, '外部终端操作者已明确输入：'],
  [approvalSources.test, '外部测试驱动器按本次合成演练授权提交：'],
])
export function approvalFor(state, kind, source) {
  const card = pending(state)
  assert.ok(approvalPrefixes.has(source), '批准必须有已知的外部输入来源')
  let options
  if (kind === 'intake') {
    assert.ok(state.intakeFingerprint, '意图卡必须绑定当前指纹')
    options = card.choices.filter(c => c.grant === 'accept-intake')
  } else {
    assert.ok(kind === 'final' && card.kind === 'human-gate' && card.gateId === 'scoped-final-code-review', '不是本次验收的最终人工门')
    options = card.choices.filter(c => c.label === 'accept')
  }
  const { n } = exactly(options, '当前卡的批准选项')
  assert.ok(Number.isInteger(n) && n > 0 && /^[a-z0-9-]+$/.test(card.decisionId), '决定 ID 或选项编号不正确')
  return { id: card.decisionId, n, phrase: '批准 ' + card.decisionId + ' ' + n, source }
}
export function approvalInput({ source = approvalSources.terminal, phrase }) {
  assert.ok(approvalPrefixes.has(source), '批准必须有已知的外部输入来源')
  return approvalPrefixes.get(source) + phrase + '。'
}
export function verifyIntake({ state, roles, sessions, top }) {
  const card = pending(state)
  assert.ok(card.choices.some(c => c.grant === 'accept-intake') && state.intakeFingerprint, '须是绑定完整指纹的意图卡')
  assert.equal(sessions.length, 1, '意图确认之前不得生成内层成员')
  const lead = sessions[0]
  assert.equal(lead.id, top); assert.equal(lead.parent, null); assert.equal(lead.depth, 0)
  assert.equal(twCalls(lead, 'decide').length, 0, 'Lead 不能代答意图')
  assert.ok(!lead.calls.some(c=>c.name==='write'), 'Lead 不得在意图回合预置文件')
  assert.ok(twCalls(lead, 'help').some(c => c.output?.ok === true), '缺少工具给出的 Lead 规则')
  assert.ok(lead.calls.some(c => c.name === 'skill' && !c.error && ['team-work','team-work-v3'].includes(c.args?.name) && Number.isInteger(c.resultSeq)), '未真实加载工作流技能')
  const declared = exactly(twCalls(lead, 'plan'), '两包单一计划调用')
  acceptedTool(declared, '两包计划未生效')
  assert.deepEqual(parse(arg(argv(declared), '--packages')), plans, '计划没有采用本次互斥两包')
  assert.deepEqual(Object.keys(roles.roles).sort(), ['challenger','expert','owner'])
  for (const r of Object.values(roles.roles)) assert.deepEqual(modelTuple(r), expected, '真实任务角色登记不一致')
  const stopped = exactly(dispatches(lead).filter(c => c.output?.stop === 'awaiting-user' && cardId(c.output) === card.decisionId), 'Lead 须实际看到原卡')
  assert.ok(!stopped.output.dispatched?.length)
  const packages = stopped.output.card?.intake?.packages ?? stopped.output.intake?.packages ?? state.intake?.packages
  assert.deepEqual(packages?.map(p => [p.id, modelTuple(p.modelRef ?? p.model)]), plans.map(p => [p.id, expected]), '意图卡的逐包物化模型不匹配')
  return true
}
function decision(lead, a, label) {
  const c = exactly(twCalls(lead, 'decide').filter(c => arg(argv(c), '--decision-id') === a.id), label + ' 的正式决定调用')
  const m = exactly(lead.prompts.filter(m => m.text.startsWith(approvalInput(a))), label + ' 的明确批准输入消息')
  const stopped = exactly(dispatches(lead).filter(d => d.output?.stop === 'awaiting-user' && cardId(d.output) === a.id), label + ' 的真实待决回执')
  assert.ok(Number.isInteger(stopped.resultSeq) && stopped.resultSeq < m.seq && c.seq > m.seq && arg(argv(c), '--choice') === String(a.n),
    label + ' 决定须先收到待决回执、再收到明确批准，且只使用实际选项')
  acceptedTool(c, label + ' 决定未生效')
  return c
}
function finding(call, marker, scope, disposition) {
  const payload = parse(arg(argv(call), '--findings'))
  assert.ok(Array.isArray(payload), '评审须结构化提交 ' + marker)
  const f = exactly(payload.filter(f => f.statement?.includes(marker)), marker)
  assert.deepEqual(f.scope, { kind: 'packages', ids: [scope] }, marker + ' 范围不准确')
  assert.equal(f.disposition, disposition)
  assert.ok(!arg(argv(call), '--summary')?.includes(marker) && !arg(argv(call), '--verdict')?.includes(marker), '不得从摘要伪证原文交接')
  return f.statement
}
const keysFor = (s, c) => {
  const key = arg(argv(c), '--key')
  const prompt = exactly(s.receipts.filter(x => x.key === key), '同 key 单块宿主接单：' + key)
  assert.ok(prompt.seq < c.seq, '报告登记晚于本轮实际收件')
  assert.ok(s.requests.some(h => h.seq > prompt.seq && h.seq < c.seq), '本轮实际模型请求缺失：' + key)
  return prompt
}
function manifest(call, manifest, added, removed) {
  const r = acceptedTool(call, '交付没有成功回执')
  assert.equal(r.accepted, true)
  assert.equal(arg(argv(call), '--outcome'), 'delivered')
  assert.deepEqual(r.manifest?.slice().sort(), [...manifest].sort(), '完整清单有漏项或多项')
  assert.deepEqual((r.added ?? []).slice().sort(), [...added].sort(), '跨 key 的 added 必须按上一份有效清单计算')
  assert.deepEqual((r.removed ?? []).slice().sort(), [...removed].sort(), '跨 key 的 removed 必须按上一份有效清单计算')
  assert.deepEqual(r.registered?.map(x => x.path).sort(), [...manifest].sort())
  for (const f of r.registered) assert.match(f.digest, /^[0-9a-f]{64}$/)
  return Object.fromEntries(r.registered.map(f => [f.path, f.digest]))
}
function review(c, recommendation, outcome) {
  assert.equal(acceptedTool(c, '评审未成功登记').accepted, true)
  assert.equal(arg(argv(c), '--recommendation'), recommendation)
  assert.equal(parse(arg(argv(c), '--verdict'))?.outcome, outcome)
}
function allFindings(c, required) {
  const items = parse(arg(argv(c), '--findings')) ?? []
  assert.equal(items.length, required, '有额外返工或上下文，不能按预设路径记为通过')
}
function matchesBody(prompt, statements, absent = []) {
  for (const s of statements) assert.equal(prompt.text.split(s).length - 1, 1, '实际收件须有且仅有一次评审意见原文')
  for (const marker of absent) assert.ok(!prompt.text.includes(marker), '实际收件混入其他包意见：' + marker)
}
export function verifyChain({ sessions, project, top, start, gate, end }) {
  const lead = exactly(sessions.filter(s => s.id === top), '真实顶层会话')
  assert.equal(lead.parent, null); assert.equal(lead.depth, 0)
  const children = sessions.filter(s => s.id !== top)
  assert.equal(children.length, 4, '两名 Owner 加两位评审须是四个独立会话')
  for (const s of children) {
    assert.equal(s.parent, top); assert.equal(s.depth, 1)
    const d = s.descriptor
    assert.deepEqual([d?.agentProvider, d?.agentModel, d?.agentReasoningEffort], expected, '子会话实际角色描述不一致')
    assert.equal(dispatches(s).length, 0, '成员不得推进派发')
    for (const cmd of ['open','plan','decide','route','roles']) assert.equal(twCalls(s, cmd).length, 0, '成员代做 Lead 的 ' + cmd)
  }
  const member = (role) => exactly(children.filter(s => rolePattern(s.descriptor?.label, role)), role)
  const alpha = member('owner@alpha '), beta = member('owner@beta '), challenger = member('chal '), expert = member('expert ')
  const a = twCalls(alpha, 'deliver'), b = twCalls(beta, 'deliver'), c = twCalls(challenger, 'review'), e = twCalls(expert, 'review')
  assert.deepEqual([a.length,b.length,c.length,e.length], [3,1,3,2], '不可缺交、多派或用错误试投掩盖流程')
  assert.equal(twCalls(lead, 'deliver').length + twCalls(lead, 'review').length, 0)
  assert.equal(twCalls(alpha,'review').length + twCalls(beta,'review').length + twCalls(challenger,'deliver').length + twCalls(expert,'deliver').length, 0)
  const m1 = manifest(a[0], [paths.main,paths.legacy], [paths.main,paths.legacy], [])
  const b1 = manifest(b[0], [paths.beta], [paths.beta], [])
  const m2 = manifest(a[1], [paths.main,paths.index], [paths.index], [paths.legacy])
  const m3 = manifest(a[2], [paths.main,paths.index], [], [])
  assert.equal(m2[paths.main], m1[paths.main], 'Challenger 返工保留原 main 字节')
  assert.equal(m3[paths.index], m2[paths.index], 'Expert 返工保留索引字节')
  assert.notEqual(m3[paths.main], m2[paths.main], 'Expert 返工真实改变主文件')
  assert.notEqual(a[0].output.reportId, a[1].output.reportId)
  assert.notEqual(a[1].output.reportId, a[2].output.reportId)
  for (const [file, hash] of Object.entries({ ...m3, ...b1, [paths.legacy]: m1[paths.legacy] })) {
    const p = path.join(project, file)
    assert.ok(physical(p).isFile())
    const bytes = readFileSync(p)
    assert.equal(sha(bytes), hash, '最终磁盘字节和登记 SHA 不符：' + file)
    const expectedText = { [paths.main]: '状态：归档就绪', [paths.index]: '索引已复核', [paths.beta]: '乙包已核验', [paths.legacy]: '旧版交接' }[file]
    assert.ok(bytes.toString('utf8').includes(expectedText), '合成制品未完成预期内容：' + file)
  }
  review(c[0], 'rework'); allFindings(c[0], 1)
  review(c[1], 'accept'); allFindings(c[1], 2)
  review(e[0], 'accept', 'rework'); allFindings(e[0], 1)
  review(c[2], 'accept'); review(e[1], 'accept', 'accept')
  assert.equal(new Set([...c,...e].map(x => x.output.reportId).filter(Boolean)).size, 5, '重评重裁必须提供五份不同报告')
  const ca = finding(c[0], 'CH-ALPHA-INDEX', 'alpha', 'must-fix')
  const xa = finding(c[1], 'CTX-ALPHA', 'alpha', 'context'), xb = finding(c[1], 'CTX-BETA', 'beta', 'context')
  const ea = finding(e[0], 'EX-ALPHA-READY', 'alpha', 'must-fix')
  assert.notEqual(xa, xb)
  const ordered = [[alpha,a[0]],[beta,b[0]],[challenger,c[0]],[alpha,a[1]],[challenger,c[1]],[expert,e[0]],[alpha,a[2]],[challenger,c[2]],[expert,e[1]]]
  const stage = ordered.map(([s, call]) => ({ s, call, prompt: keysFor(s, call) }))
  assert.equal(new Set(stage.map(x => x.prompt.key)).size, 9, '九份不同派单 key')
  const fileTrail = verifyFileTrail({project,lead,stage,m1,m2,m3,b1})
  for (const child of children) assert.deepEqual(child.receipts.map(x => x.key).sort(), stage.filter(x => x.s === child).map(x => x.prompt.key).sort(), '出现额外或重复收单')
  matchesBody(stage[3].prompt, [ca], ['EX-ALPHA-READY','CTX-BETA'])
  matchesBody(stage[6].prompt, [ea, xa], ['CTX-BETA'])
  for (const [index, current] of [[2,[paths.main,paths.legacy,paths.beta]],[4,[paths.main,paths.index,paths.beta]],[5,[paths.main,paths.index,paths.beta]],[7,[paths.main,paths.index,paths.beta]],[8,[paths.main,paths.index,paths.beta]]]) {
    const prompt = stage[index].prompt.text
    for (const p of current) assert.ok(prompt.includes(p), '组合评审/裁决缺制品路径 ' + p)
    if (index !== 2) assert.ok(!prompt.includes(paths.legacy), '已移出文件不能出现在有效评审清单')
  }
  const mappings = stage.map(({ s, call, prompt }) => {
    assert.equal(arg(argv(call), '--task'), task)
    const found = dispatches(lead).flatMap(c => [...(c.output?.dispatched ?? []), ...(c.output?.inflight ?? [])].filter(x => x.key === prompt.key && x.ok && x.registered && x.receiptVerified).map(item => ({ item, c })))
    assert.ok(found.length > 0, 'Lead 没有收到原生登记与实收回执：' + prompt.key)
    assert.ok(found.every(f => f.item.sessionId === s.id), '宿主实收与 TWR 登记不是同一会话')
    const { item, c } = found[0]
    if (item.provider) assert.deepEqual(modelTuple(item), expected, '首派回执没有选中规定模型')
    return { key: prompt.key, session: s.id, wave: item.waveId, action: item.action, leadCallSeq: c.seq, receivedSeq: prompt.seq, reportSeq: call.resultSeq, reportId: call.output.reportId, promptSha256: sha(prompt.text) }
  })
  assert.equal(mappings[0].leadCallSeq, mappings[1].leadCallSeq, '首派必须为同一次两包波次')
  assert.ok(mappings[0].wave && mappings[0].wave === mappings[1].wave)
  for (let i = 2; i < mappings.length; i++) assert.ok(mappings[i].leadCallSeq > mappings[i-1].leadCallSeq, '异常角色推进顺序')
  const startCall = decision(lead, start, '意图')
  assert.ok(startCall.seq < mappings[0].leadCallSeq, '意图确认前不得推进首波')
  const route = exactly(twCalls(lead, 'route').filter(c => arg(argv(c), '--route') === 'e2e'), 'E2E 合成跳过路由')
  acceptedTool(route, '需要按真实无应用依据选择 skip')
  assert.equal(arg(argv(route), '--decision'), 'skip'); assert.ok(arg(argv(route), '--basis'))
  const final = pending(gate)
  assert.ok(final.kind === 'human-gate' && final.gateId === 'scoped-final-code-review' && final.decisionId !== start.id && final.choices.some(x => x.label === 'accept'), '必须是单独的正式最终人工门')
  const finalCall = exactly(dispatches(lead).filter(c => c.output?.stop === 'awaiting-user' && cardId(c.output) === final.decisionId), 'Lead 实际收到尾门')
  assert.ok(finalCall.seq > mappings.at(-1).leadCallSeq && !finalCall.output.dispatched?.length)
  const answers = twCalls(lead, 'decide')
  assert.equal(answers.length, end ? 2 : 1, '人工门未获批准前不得回答或消费别的卡')
  if (!end) assert.ok(!dispatches(lead).some(c => c.output?.stop === 'completed'), '没有用户确认却已完成')
  return {
    model: expected, mappings, fileTrail, finalDecisionId: final.decisionId,
    sessions: sessions.map(s => ({ id: s.id, parent: s.parent, role: s.descriptor?.label ?? 'Lead', requests: s.requests, providerResponses: s.providerResponses, file: s.file, fileSha256: s.fileHash })),
    handoff: { challenger: ca, expert: ea, alphaContext: xa, excludedBetaContext: xb },
    artifacts: { firstAlpha: m1, secondAlpha: m2, thirdAlpha: m3, beta: b1, omittedLegacyKept: true },
  }
}
export function verifyFinal({ sessions, project, top, start, gate, end, status, finalGate }) {
  const result = verifyChain({ sessions, project, top, start, gate, end })
  assert.equal(end.id, result.finalDecisionId)
  const lead = sessions.find(s => s.id === top)
  const answer = decision(lead, end, '最终人工门')
  const completed = exactly(dispatches(lead).filter(c => c.output?.stop === 'completed'), 'Lead 正式完成回执')
  assert.ok(completed.seq > answer.seq)
  assert.equal(status.status, 'completed'); assert.equal(finalGate.passed, true)
  return { ...result, completed: true, finalHumanChoice: end.n, finalDecisionSeq: answer.seq, finalLeadReceiptSeq: completed.resultSeq }
}
