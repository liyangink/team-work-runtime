// 观察真实 CLI 子进程的 stdout data 事件；不重分块，不替换/注入字节，不模拟宿主执行。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import path from 'node:path'

const sha = value => createHash('sha256').update(value).digest('hex')
export function observePipe() {
  const cp = createRequire(import.meta.url)('node:child_process')
  const spawn = cp.spawn, rows = []
  cp.spawn = function (...args) {
    const child = Reflect.apply(spawn, this, args)
    const [file, command] = args[1] ?? []
    if (typeof file !== 'string' || !file.endsWith('/team-work-runtime/bin/tw.mjs') || !['run','dispatch-plan'].includes(command)) return child
    const chunks = []
    child.stdout.on('data', chunk => chunks.push(Buffer.from(chunk)))
    child.once('close', code => rows.push({ command, code, chunks }))
    return child
  }
  syncBuiltinESMExports()
  return { rows, restore() { cp.spawn = spawn; syncBuiltinESMExports() } }
}

export async function probePipe(ctx, captured) {
  const tools = ctx.get('tools'), tw = tools.get('tw'), dispatch = tools.get('tw-dispatch')
  // 此适配只提供工具公开执行口的隔离 cwd；有 gap，探针永远不触发成员创建。
  const exec = { agent:{ session:{ header:{ cwd:process.cwd() } } }, signal:AbortSignal.timeout(30000) }
  const sampleDir = path.resolve(process.cwd(),'../evidence')
  const observations = []
  const commands = ['dispatch-plan','run']
  for (let offset = 0; offset < 8; offset++) {
    const task = 'pipe-probe-' + offset
    const raw = '字节边界：' + 'a'.repeat(offset) + '中🧪'.repeat(11500) + '安全围栏~~~~结束'
    const gap = { id:'choose', question:'哪一段作为边界依据？', whyItMatters:'有意保持待决，不派发' }
    const opened = await tw.execute({ args:['open','--name',task,'--entry','code-review','--objective','测量真实管道分块','--raw-requirement',raw,'--gap',JSON.stringify(gap)] },exec)
    assert.equal(opened.ok,true,'无法准备大文本意图')
    const dispatched = await dispatch.execute({ task,writables:[{path:'artifacts/sample.md',kind:'code-review'}] },exec)
    const read = await tw.execute({ args:['run','--task',task] },exec)
    assert.ok(dispatched.ok && dispatched.stop === 'awaiting-user' && dispatched.waves?.length === 0 && read.ok, '有 gap 的大输入必须停卡且无派发')
    assert.ok(dispatched.card.kind === 'intent' && read.choices?.some(c => c.grant === 'accept-intake') && dispatched.card.decisionId === read.decisionId, '只读投影与签发卡身份不一致')
    assert.equal(dispatched.card.question,read.question,'两条原生插件入口的冻结正文不同')
    assert.ok(!dispatched.presentation && !dispatched.card.presentation && !read.presentation,'固定意图卡不附呈现规则')
    assert.ok(read.question.includes(raw) && !read.question.includes('�'),'完整原话未逐字回传')
    for (const [i, row] of captured.rows.splice(0).entries()) {
      assert.equal(row.command,commands[i],'预期观察两个真实 CLI 进程')
      const bytes = Buffer.concat(row.chunks)
      assert.equal(row.code,0)
      const json = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))
      assert.equal(row.command === 'run' ? json.question : json.card?.question,read.question,'管道原字节与原生工具卡不一致')
      let boundary = 0
      const splits = []
      for (const chunk of row.chunks.slice(0,-1)) {
        boundary += chunk.length
        if ((bytes[boundary] & 0xc0) !== 0x80) continue
        let start = boundary - 1
        while ((bytes[start] & 0xc0) === 0x80) start--
        const charBytes = bytes[start] >= 0xf0 ? 4 : bytes[start] >= 0xe0 ? 3 : 2
        const character = new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(start,start+charBytes))
        splits.push({ offset:boundary, character, charBytes })
      }
      const file = task + '-' + row.command + '.raw.json'
      writeFileSync(path.join(sampleDir,file),bytes,{flag:'wx',mode:0o600})
      observations.push({ command:row.command, file, bytes:bytes.length, sha256:sha(bytes), chunks:row.chunks.map(c=>c.length), splits,
        replacementIfDecodedPerChunk:row.chunks.map(c=>c.toString('utf8')).join('').includes('�'), questionSha256:sha(read.question) })
    }
    assert.equal(observations.length, (offset+1)*2, '每个偏移必须有两条实际管道记录')
    if (commands.every(command => observations.some(row => row.command===command && row.splits.length))) return observations
  }
  assert.fail('本机输出未观测到两条工具各自真实拆开多字节；不能以大输出替代跨块覆盖')
}
