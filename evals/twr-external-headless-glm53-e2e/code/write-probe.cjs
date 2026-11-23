// 只有装在 DSH 原生 bash 执行器下才是实机证据；直接运行仅为诊断，不产生通过结论。
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
function probe(encoded, depth = 'parent') {
  const p = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  if (!/^[a-f0-9]{32}$/.test(p.nonce) || !['parent','descendant'].includes(depth)) throw new Error('探针标记无效')
  function observe(f) {
    try { f(); return 'ALLOWED' } catch (e) { return e.code ?? 'ERROR' }
  }
  function openExisting(f) {
    const st = fs.lstatSync(f)
    if (!st.isFile() || st.isSymbolicLink()) throw Object.assign(new Error('非普通文件'), { code: 'UNSAFE_PATH' })
    fs.closeSync(fs.openSync(f, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW))
  }
  function exclusive(dir, write) {
    const file = path.join(dir, '.twr-e2e-' + p.nonce + '-' + (p.channel ?? 'shell') + '-' + depth)
    let fd
    const opened = observe(() => { fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600) })
    if (opened !== 'ALLOWED') return opened
    // 创建已发生，后续关闭/清理拒绝不能倒记为“创建被拒”。
    let written = 'ALLOWED', closed, unlinked
    if (write) written = observe(() => { if (fs.writeSync(fd, p.nonce) !== p.nonce.length) throw new Error('写入不完整') })
    closed = observe(() => fs.closeSync(fd))
    unlinked = observe(() => fs.unlinkSync(file))
    return [written,closed,unlinked].every(x => x === 'ALLOWED') ? 'ALLOWED' : 'CREATED_BUT_INCOMPLETE'
  }
  const out = {
    nonce: p.nonce, depth, channel:p.channel ?? 'shell', cwdCorrect: process.cwd() === p.project, isolatedHome: process.env.HOME === p.isolatedHome,
    repoExisting: observe(() => openExisting(path.join(p.repo, 'package.json'))),
    repoNestedExisting: observe(() => openExisting(path.join(p.repo, 'bin', 'tw.mjs'))),
    projectWrite: exclusive(p.project, true),
  }
  // 写模式打开已异常放行时，不再创建真实目录内的探针文件。
  if (['EPERM','EACCES'].includes(out.repoExisting) && ['EPERM','EACCES'].includes(out.repoNestedExisting)) {
    out.repoCreate = exclusive(p.repo, false)
    out.homeCreate = exclusive(p.home, false)
  }
  if (depth === 'parent') {
    const child = spawnSync(process.execPath, [__filename, encoded, 'descendant'], { encoding: 'utf8', timeout: 5000 })
    if (child.status === 0) out.descendant = JSON.parse(child.stdout)
    else out.descendant = { status: child.status, code: child.error?.code ?? 'FAILED' }
  }
  return out
}
module.exports = probe
if (require.main === module) process.stdout.write(JSON.stringify(probe(...process.argv.slice(2))) + '\n')
