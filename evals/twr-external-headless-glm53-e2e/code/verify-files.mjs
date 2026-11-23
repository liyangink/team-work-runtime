import assert from 'node:assert/strict'
import path from 'node:path'
import { paths, sha } from './shared.mjs'

// 每个制品固定为单行加 LF；既能从原生 read 完整正文复核版本，也避免推断未呈现的多行/截断内容。
export const fixtureText = Object.freeze({ initial:'状态：待复核\n', ready:'状态：归档就绪\n', legacy:'旧版交接\n', index:'索引已复核\n', beta:'乙包已核验\n' })
export function renderFile(kind, file, value) {
  const body = kind === 'read' ? '1: '+value.slice(0,-1)+'\n\n(End of file - total 1 lines)' : (value==='create'?'Created':'Updated')+' file'
  return '<path>'+file+'</path>\n<type>file</type>\n<content>\n'+body+'\n</content>'
}
const fileOf = (project, call) => typeof call.args?.file_path==='string' ? path.resolve(project,call.args.file_path) : null
export function verifyFileTrail({project,lead,stage,m1,m2,m3,b1}) {
  const [firstAlpha,firstBeta,firstC,reworkAlpha,secondC,firstE,expertAlpha,lastC,lastE]=stage
  const all = [lead,firstAlpha.s,firstBeta.s,firstC.s,firstE.s]
  const digestAt = (expected,bytes,message)=>assert.equal(expected,sha(bytes),message)
  const requirements = [
    [firstAlpha,'write',paths.main,fixtureText.initial,m1[paths.main],'create'],
    [firstAlpha,'write',paths.legacy,fixtureText.legacy,m1[paths.legacy],'create'],
    [firstBeta,'write',paths.beta,fixtureText.beta,b1[paths.beta],'create'],
    [reworkAlpha,'write',paths.index,fixtureText.index,m2[paths.index],'create'],
    [expertAlpha,'read',paths.main,fixtureText.initial,m2[paths.main]],
    [expertAlpha,'write',paths.main,fixtureText.ready,m3[paths.main],'update'],
  ]
  for (const step of [firstC,secondC,firstE,lastC,lastE]) {
    const previous = step===firstC, afterExpert = [lastC,lastE].includes(step)
    const version=previous?m1:afterExpert?m3:m2
    requirements.push([step,'read',paths.main,afterExpert?fixtureText.ready:fixtureText.initial,version[paths.main]],
      [step,'read',previous?paths.legacy:paths.index,previous?fixtureText.legacy:fixtureText.index,version[previous?paths.legacy:paths.index]],
      [step,'read',paths.beta,fixtureText.beta,b1[paths.beta]])
  }
  const commits = new Set(), evidence=[]
  for (const [step,kind,rel,bytes,digest,operation] of requirements) {
    const abs=path.join(project,rel)
    const label=step.prompt.key+' '+kind+' '+rel
    // 不能用上一轮读取或延迟到报告之后才完成的调用充数。
    const candidates=step.s.calls.filter(c=>c.name===kind && fileOf(project,c)===abs && c.seq>step.prompt.seq && c.seq<step.call.seq &&
      c.error===false && Number.isInteger(c.resultSeq) && c.resultSeq>c.seq && c.resultSeq<step.call.seq)
    assert.ok(candidates.length,label+' 缺少本轮完成且成功的原生文件调用')
    digestAt(digest,bytes,label+' 文件内容和本轮登记的 SHA 不一致')
    if (kind==='write') assert.equal(candidates.length,1,label+' 必须是唯一写入')
    const matched=candidates.find(c=> c.fileText===renderFile(kind,abs,operation??bytes) && (kind==='read' || c.args.content===bytes))
    assert.ok(matched,label+' 原生回执版本、实际操作或初始状态不符')
    if (kind==='write') commits.add(matched)
    // 读取没有写入操作；省略字段，和 verified.json 的落盘表示一致。
    evidence.push({session:step.s.id,key:step.prompt.key,path:rel,kind,...(operation === undefined ? {} : {operation}),callSeq:matched.seq,resultSeq:matched.resultSeq,sha256:digest})
  }
  // Lead/审查人预写、额外改写，或在正式派单以外写件均不能混入通过样本。
  for (const s of all) for (const c of s.calls) if(c.name==='write') assert.ok(commits.has(c),'存在未对应正式交付的写入：'+s.id+'#'+c.seq)
  const read=evidence.find(x=>x.key===expertAlpha.prompt.key&&x.kind==='read')
  const write=evidence.find(x=>x.key===expertAlpha.prompt.key&&x.kind==='write')
  assert.ok(read.resultSeq<write.callSeq,'Expert 返工 Owner 须先读待复核版本才修改')
  return evidence
}
