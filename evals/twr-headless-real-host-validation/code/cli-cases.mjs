// 公开 CLI 合成案例。脚本扮演测试输入，不是模型、用户授权或真实 DSH 收单。
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const verdict = (outcome) => ({ outcome, rationale: '独立裁决概述（不重复具体意见）', recommendedAction: '按本次裁决处理', confidence: 'high' })
const finding = (statement, ids, disposition = 'must-fix') => ({
  severity: disposition === 'must-fix' ? 'blocker' : 'info', statement, disposition,
  scope: ids == null ? { kind: 'all-covered' } : { kind: 'packages', ids },
})
const specs = [
  { id: 'a', writable: ['a/:code-review'], done: ['完整提交甲包'], dependsOn: [] },
  { id: 'b', writable: ['b/:code-review'], done: ['完整提交乙包'], dependsOn: [] },
]
const paths = { a: ['a/x.dat', 'a/y.txt'], b: ['b/z.txt'] }
const keys = (waves) => Object.fromEntries(waves.map(w => [w.package, w]))
const choice = (card, grant) => {
  const picked = card.choices.find(x => x.grant === grant || x.label === grant)
  assert.ok(picked, '实际卡片须提供选项 ' + grant)
  return picked.n
}
const role = (out, name) => {
  assert.equal(out.stop, null, '可派发 ' + name)
  assert.equal(out.waves.length, 1, name + ' 须为唯一组合评审')
  assert.equal(out.waves[0].role, name, '必须尊重实际角色顺序')
  return out.waves[0]
}
const assertWaves = (r, kind, pkgs) => {
  assert.equal(r.stop, null)
  assert.deepEqual(r.waves.map(w => [w.kind, w.role, w.package]).sort(), pkgs.map(pkg => [kind, 'owner', pkg]), '只派预期的 Owner 包')
  return keys(r.waves)
}
function responses(wave, yes, no, sha) {
  assert.equal(wave.continuation, true, '回应应为续派')
  assert.equal(wave.promptFrozen, true, '派出时正文已冻结')
  for (const [field, digestField] of [['prompt', 'promptDigest'], ['promptFull', 'promptFullDigest']]) {
    const text = wave[field]
    assert.ok(typeof text === 'string' && text.startsWith('# ' + (field === 'prompt' ? '续派' : '续派全量变体') + '（key: ' + wave.dispatchKey + '）'), field + ' 首行精确 key')
    assert.equal(sha(text), wave[digestField], field + ' SHA-256 与实际正文一致')
    for (const item of yes) assert.ok(text.split('\n').some(line => line.endsWith(' ' + item.statement)), field + ' 必须含原文：' + item.statement)
    for (const item of no) assert.ok(!text.includes(item.statement), field + ' 不能夹入不适用意见：' + item.statement)
  }
}

export async function runCases({ cli, project, home, sha, emit }) {
  function setup(name) {
    const root = project(name)
    const c = (step, cmd, ...argv) => cli(root, name + '/' + step, [cmd, '--task', name, ...argv])
    const ok = (step, cmd, ...argv) => {
      const r = c(step, cmd, ...argv)
      assert.notEqual(r.ok, false, step + ': ' + JSON.stringify(r))
      return r
    }
    const reject = (step, cmd, ...argv) => {
      const r = c(step, cmd, ...argv)
      assert.equal(r.ok, false, step + ' 必须拒绝')
      return r
    }
    const plan = step => ok(step, 'dispatch-plan')
    const decide = (step, card, grant) => ok(step, 'decide', '--decision-id', card.decisionId, '--choice', String(choice(card, grant)))
    const write = (file, content) => {
      const p = path.join(root, file)
      mkdirSync(path.dirname(p), { recursive: true })
      writeFileSync(p, content)
      emit({ type:'fixture-file', case: name, file, size: Buffer.byteLength(content), bytesBase64: Buffer.from(content).toString('base64'), sha256: sha(content) })
    }
    const deliverArgs = (wave, files) => ['--key', wave.dispatchKey, '--outcome', 'delivered', '--summary', '合成完整交付', '--paths', files.join(',')]
    const deliver = (step, wave, files) => {
      const r = ok(step, 'deliver', ...deliverArgs(wave, files))
      assert.equal(r.accepted, true, step + ' 已登记制品')
      return r
    }
    const reviewArgs = (wave, recommendation, findings, outcome) => ['--key', wave.dispatchKey, '--summary', '组合证据摘要（不重复具体意见）', '--recommendation', recommendation,
      ...(findings ? ['--findings', JSON.stringify(findings)] : []), ...(outcome ? ['--verdict', JSON.stringify(verdict(outcome))] : [])]
    const review = (step, ...args) => {
      const r = ok(step, 'review', ...reviewArgs(...args))
      assert.equal(r.accepted, true, step + ' 已登记评审')
      return r
    }
    const pending = (step, ids) => {
      const result = ok(step, 'run')
      assert.equal(result.status, 'awaiting-user', '有待决卡时保持静止')
      assert.deepEqual(result.pendingDecisions.map(x => x.decisionId).sort(), [...ids].sort(), '只列实际尚未收口的卡')
      return result
    }
    const initial = () => {
      const open = cli(root, name + '/open', ['open', '--name', name, '--entry', 'code-review', '--objective', '验证虚构清单的组合评审流程', '--raw-requirement', '测试操作者要求记录合成清单的变更'])
      assert.notEqual(open.ok, false, '仅在虚构项目开测试任务')
      ok('declare-plan', 'plan', '--packages', JSON.stringify(specs))
      const same = ok('same-plan', 'plan', '--packages', JSON.stringify(specs))
      assert.equal(same.changed, false, '相同计划回执不可声称有变更')
      const intake = plan('intake')
      assert.equal(intake.stop, 'awaiting-user', '意图未确认不派成员')
      const registry = ok('roles', 'roles')
      assert.deepEqual(Object.keys(registry.roles).sort(), ['challenger', 'expert', 'owner'])
      for (const { provider, modelName, effort } of Object.values(registry.roles)) assert.deepEqual([provider, modelName, effort], ['fixture-provider', 'fixture-model', 'max'], '这里只证明虚构角色登记')
      decide('confirm-fixture-intake', intake.card, 'accept-intake')
      const owner = assertWaves(plan('initial-two-owners'), 'produce', ['a', 'b'])
      for (const [id, w] of Object.entries(owner)) {
        const agent = '00000000-0000-4000-8000-00000000000' + (id === 'a' ? '1' : '2')
        ok('register-' + id, 'agent-map', '--key', w.dispatchKey, '--agent', agent)
        assert.equal(ok('repeat-mapping-' + id, 'agent-map', '--key', w.dispatchKey, '--agent', agent).idempotent, true)
      }
      write(paths.a[0], Buffer.from([0x00, 0xff, 0x41, 0x0d, 0x0a]))
      write(paths.a[1], '甲包第二份清单\n')
      write(paths.b[0], '乙包初稿\n')
      return owner
    }
    const acceptPair = (step) => {
      const cWave = role(plan(step + '-challenger'), 'challenger')
      review(step + '-challenger-accept', cWave, 'accept')
      const eWave = role(plan(step + '-expert'), 'expert')
      review(step + '-expert-accept', eWave, 'accept', undefined, 'accept')
      return { cWave, eWave }
    }
    const routeSkip = () => ok('skip-unrelated-e2e', 'route', '--route', 'e2e', '--decision', 'skip', '--basis', '合成审查场景没有可部署应用，E2E 路由只验证显式跳过')
    const gate = (step) => {
      const result = plan(step)
      assert.equal(result.stop, 'awaiting-user', '非作者评审完成仍应停在用户门')
      assert.ok(result.card.decisionId && result.card.choices.some(c => c.label === 'accept'), '必须是具有实际批准选项的人工门')
      return result.card
    }
    return { root, c, ok, reject, plan, decide, write, deliver, deliverArgs, review, reviewArgs, pending, initial, acceptPair, routeSkip, gate }
  }

  const cases = [
    ['two-package-chain', () => {
      const f = setup('two-package-chain')
      const owner = f.initial()
      const invalid = f.reject('typed-checks', 'deliver', ...f.deliverArgs(owner.a, paths.a), '--checks', '[{"name":"","result":"wrong","extra":true}]')
      assert.equal(invalid.code, 'INTAKE_REJECTED')
      for (const field of ['extra', 'check.name', 'check.result']) assert.ok(invalid.reasons.some(r => r.includes(field)), '同步列出 ' + field)
      const a1 = f.deliver('a-complete-v1', owner.a, paths.a)
      const again = f.deliver('same-key-same-bytes', owner.a, [...paths.a].reverse())
      assert.equal(again.ver, a1.ver)
      assert.equal(again.idempotent, true, '相同清单及字节交换路径顺序幂等')
      f.write(paths.a[0], Buffer.from([0x00, 0xff, 0x42, 0x0d, 0x0a]))
      const a2 = f.deliver('same-key-new-bytes', owner.a, paths.a)
      assert.equal(a2.ver, a1.ver + 1, '字节变化产生新的报告版本')
      const files = a2.registered
      assert.deepEqual(files.map(x => x.path).sort(), paths.a)
      for (const item of files) {
        assert.equal(item.digest, sha(readFileSync(path.join(f.root, item.path))), '直接对磁盘原始字节取 SHA-256')
      }
      const partial = f.plan('partial-wave')
      assert.equal(partial.stop, 'wait-inflight', '部分交付仍在同一波，不抢派评审')
      assert.ok((partial.inflight ?? partial.card.inflight).some(w => (w.dispatchKey ?? w.key) === owner.b.dispatchKey))
      f.deliver('b-complete', owner.b, paths.b)
      const c1 = role(f.plan('initial-challenger'), 'challenger')
      const ca = finding('挑战甲项：甲包的日期列需补零（原文）', ['a'])
      const cb = finding('挑战乙项：乙包的单位缩写需展开（原文）', ['b'])
      const all = finding('挑战通用项：各包表头统一大写（原文）')
      // 唯一非法输入是旧 packages 字段；通用 scope 示例不能满足专项拒绝断言。
      const old = f.reject('fn1-legacy-packages-rejected', 'review', ...f.reviewArgs(c1, 'rework', [{ ...ca, packages: ['a'] }, cb, all]))
      assert.equal(old.code, 'INTAKE_REJECTED')
      assert.ok(old.reasons.some(reason => reason.includes('未知字段「packages」')), '必须明确拒绝 finding 的旧 packages 字段')
      const waiting = f.plan('rejected-review-stays-open')
      assert.equal(waiting.stop, 'wait-inflight')
      assert.ok((waiting.inflight ?? waiting.card.inflight).some(w => (w.dispatchKey ?? w.key) === c1.dispatchKey), '拒绝后原评审 key 仍可提交')
      const corrected = f.review('challenger-corrected-original-key', c1, 'rework', [ca, cb, all])
      assert.equal(corrected.ver, 1, '只删除旧字段，同 key 首次成功登记')
      const r2 = assertWaves(f.plan('challenger-rework'), 'respond', ['a', 'b'])
      responses(r2.a, [ca, all], [cb], sha)
      responses(r2.b, [cb, all], [ca], sha)
      assert.equal(r2.a.expectedAgentId, '00000000-0000-4000-8000-000000000001', '续派对到合成映射')
      const newRule = '新规则标识：只影响后续派单'
      f.write('team-work/rules/owner/README.md', ['## 规范', '', '- ' + newRule, ''].join(String.fromCharCode(10)))
      const inflight = f.plan('frozen-reentry')
      assert.equal(inflight.stop, 'wait-inflight')
      for (const [pkg, original] of Object.entries(r2)) {
        const rebuilt = (inflight.inflight ?? inflight.card.inflight).find(w => w.package === pkg)
        assert.ok(rebuilt, '按包恢复原派单')
        for (const k of ['prompt', 'promptFull', 'promptDigest', 'promptFullDigest']) assert.equal(rebuilt[k], original[k], '重入不可改变冻结 ' + k)
      }
      f.write(paths.a[0], Buffer.from([0x00, 0xff, 0x43, 0x0d, 0x0a]))
      f.write(paths.b[0], '乙包修订一\n')
      const aRespond = f.deliver('a-r2-retain-full-list', r2.a, paths.a)
      assert.equal(aRespond.registered.find(x => x.path === paths.a[1]).digest, files.find(x => x.path === paths.a[1]).digest, '保留未变 Y 的摘要')
      f.deliver('b-r2-complete', r2.b, paths.b)
      const c2 = role(f.plan('challenger-after-rework'), 'challenger')
      const cx = finding('挑战甲备注：本备注只用于甲包背景（原文）', ['a'], 'context')
      const cy = finding('挑战乙备注：本备注只用于乙包背景（原文）', ['b'], 'context')
      f.review('challenger-accept-with-context', c2, 'accept', [cx, cy])
      const e2 = role(f.plan('expert-after-rework'), 'expert')
      f.reject('expert-missing-verdict', 'review', ...f.reviewArgs(e2, 'accept'))
      const ea = finding('裁决甲定点：第一列需要显式日期格式（原文）', ['a'])
      f.review('expert-f9-target-a', e2, 'accept', [ea], 'rework')
      const r3 = assertWaves(f.plan('expert-f9-respond-only-a'), 'respond', ['a']).a
      responses(r3, [ea, cx], [cy], sha)
      assert.ok(r3.prompt.includes(newRule), '后续新派单应装载更新后的规则')
      f.write(paths.a[0], Buffer.from([0x00, 0xff, 0x44, 0x0d, 0x0a]))
      f.deliver('a-r3-retain-full-list', r3, paths.a)
      f.acceptPair('after-f9')
      f.routeSkip()
      const g = f.gate('human-gate')
      f.pending('unchanged-while-human-pending', [g.decisionId])
      f.decide('simulated-user-accept', g, 'accept')
      assert.equal(f.plan('complete').stop, 'completed')
    }],
    ...['same-key', 'cross-key'].map(variant => ['manifest-removal-' + variant, () => {
      const name = 'manifest-removal-' + variant
      const f = setup(name)
      const owner = f.initial()
      const [x, y] = paths.a
      const original = f.deliver('a-first-x-and-y', owner.a, paths.a)
      assert.deepEqual(original.manifest, paths.a, '首交显式登记 X 和 Y')
      const yPath = path.join(f.root, y)
      const before = readFileSync(yPath)
      const beforeDigest = sha(before)
      assert.equal(original.registered.find(file => file.path === y)?.digest, beforeDigest, '原清单确实使用工作区 Y')
      let next = owner.a
      if (variant === 'cross-key') {
        f.deliver('b-complete', owner.b, paths.b)
        const firstReview = role(f.plan('review-original-manifest'), 'challenger')
        assert.ok([x, y, ...paths.b].every(p => firstReview.prompt.includes(p)), '移出前评审基线含 X、Y、Z')
        f.review('request-a-rework', firstReview, 'rework', [finding('只重做甲包交付，清单以新报告为准', ['a'])])
        next = assertWaves(f.plan('respond-only-a'), 'respond', ['a']).a
        assert.notEqual(next.dispatchKey, owner.a.dispatchKey, '跨 key 返工使用新派单')
      }
      const revised = f.deliver('a-replace-with-x-only', next, [x])
      assert.deepEqual(revised.manifest, [x], '只交 X 后本次完整清单不继承 Y')
      assert.deepEqual(revised.registered.map(file => file.path), [x], '只登记当前清单中的 X')
      if (variant === 'same-key') {
        assert.equal(revised.ver, original.ver + 1, '同 key 清单变化应生成新版报告')
        assert.deepEqual(revised.removed, [y], '同 key 回执列出移出的 Y')
      }
      const retained = readFileSync(yPath)
      assert.deepEqual(retained, before, '移出 Y 不得删除或改写磁盘 Y')
      emit({ type: 'fixture-retained-file', case: name, file: y, beforeSha256: beforeDigest, afterSha256: sha(retained), bytesUnchanged: true })
      if (variant === 'same-key') f.deliver('b-complete', owner.b, paths.b)
      f.write(y, '修改已移出清单的 Y；不应阻塞当前基线')
      const review = role(f.plan('review-current-manifest'), 'challenger')
      assert.ok([x, ...paths.b].every(p => review.prompt.includes(p)), '新评审仍覆盖甲包 X 和乙包 Z')
      assert.ok(!review.prompt.includes(y), '新评审的有效清单不得包含已移出的 Y')
      f.review('accept-with-changed-omitted-file', review, 'accept')
    }]),
    ['expert-all-covered', () => {
      const f = setup('expert-all-covered')
      const owner = f.initial()
      f.deliver('a-complete', owner.a, paths.a)
      f.deliver('b-complete', owner.b, paths.b)
      const c = role(f.plan('challenger'), 'challenger')
      f.review('challenger-accept', c, 'accept')
      const e = role(f.plan('expert'), 'expert')
      const ea = finding('裁决甲项：甲包尾注须交代计算依据（原文）', ['a'])
      const eb = finding('裁决乙项：乙包尾注须说明取样范围（原文）', ['b'])
      const all = finding('裁决通用项：复核各自清单的顺序（原文）')
      const context = finding('裁决背景：这不是必须项（原文）', null, 'context')
      f.review('expert-all-and-local', e, 'accept', [ea, eb, all, context], 'rework')
      const respond = assertWaves(f.plan('both-owners-respond'), 'respond', ['a', 'b'])
      responses(respond.a, [ea, all], [eb, context], sha)
      responses(respond.b, [eb, all], [ea, context], sha)
    }],
    ['multi-card-refresh', () => {
      const f = setup('multi-card-refresh')
      const owner = f.initial()
      f.deliver('a-complete', owner.a, paths.a)
      f.deliver('b-complete', owner.b, paths.b)
      f.acceptPair('before-drift')
      f.routeSkip()
      const c1 = f.gate('human-gate-c1')
      f.write(paths.a[0], Buffer.from([0x00, 0xfe, 0x50]))
      f.write(paths.b[0], '合成用户更新乙包')
      const prep = (pkg) => f.ok('prepare-refresh-' + pkg, 'refresh-artifacts', '--package', pkg, '--reason', '合成用户要求把确认过的当前字节登记待审')
      const a = prep('a'), b = prep('b')
      const state = f.pending('all-three-cards', [c1.decisionId, a.decisionId, b.decisionId])
      assert.equal(state.needsDecisionId, true)
      const missing = f.reject('reject-no-card-id', 'decide', '--choice', '1')
      for (const id of [c1.decisionId, a.decisionId, b.decisionId]) assert.ok(JSON.stringify(missing).includes(id), '拒绝需列全卡 ID')
      f.reject('reject-stale-human-gate', 'decide', '--decision-id', c1.decisionId, '--choice', String(choice(c1, 'accept')))
      f.pending('temporary-block-does-not-cancel', [c1.decisionId, a.decisionId, b.decisionId])
      const doneB = f.ok('approve-b-not-queue-head', 'decide', '--decision-id', b.decisionId, '--choice', '1')
      assert.match(JSON.stringify(doneB), new RegExp('refresh-' + b.decisionId), '确认登记来源报告而非提前批准人工门')
      f.pending('a-remains-pending-and-old-gate-is-closed', [a.decisionId])
      f.reject('reject-superseded-c1', 'decide', '--decision-id', c1.decisionId, '--choice', '1')
      const again = f.ok('replay-b-same-id', 'decide', '--decision-id', b.decisionId, '--choice', '1')
      assert.equal(again.replay, true)
      f.pending('replaying-b-does-not-answer-a', [a.decisionId])
      f.ok('approve-a-own-id', 'decide', '--decision-id', a.decisionId, '--choice', '1')
      f.acceptPair('new-baseline')
      const cNew = f.gate('must-reissue-human-gate')
      assert.notEqual(cNew.decisionId, c1.decisionId)
      f.pending('leave-new-human-gate-open', [cNew.decisionId])
    }],
    ['package-recovery', () => {
      const f = setup('package-recovery')
      const owner = f.initial()
      const block = (pkg) => f.ok('block-' + pkg, 'deliver', '--key', owner[pkg].dispatchKey, '--outcome', 'blocked', '--summary', '合成阻塞只影响本包')
      const invalid = f.reject('reject-blocked-with-paths', 'deliver', '--key', owner.a.dispatchKey, '--outcome', 'blocked', '--summary', '不合法路径', '--paths', paths.a[0])
      assert.equal(invalid.code, 'INTAKE_REJECTED')
      for (const pkg of ['a', 'b']) assert.equal(block(pkg).accepted, true)
      const blocked = (step) => {
        const state = f.plan(step)
        assert.equal(state.stop, 'awaiting-user', '仍有阻塞不可直接推进')
        return Object.fromEntries((state.blockedPackages ?? state.card.blockedPackages).map(p => [p.package, p.ref]))
      }
      const refs = blocked('both-blocked')
      assert.deepEqual(Object.keys(refs).sort(), ['a', 'b'])
      const same = f.ok('same-plan-while-blocked', 'plan', '--packages', JSON.stringify(specs))
      assert.equal(same.changed, false)
      assert.deepEqual(blocked('same-plan-keeps-both-references'), refs)
      const changed = specs.map(item => item.id === 'b' ? { ...item, done: ['乙包完成标准修订'] } : item)
      const edit = f.ok('change-b-only', 'plan', '--packages', JSON.stringify(changed))
      assert.equal(edit.changed, true)
      const intake = f.plan('reconfirm-b-plan')
      assert.equal(intake.stop, 'awaiting-user')
      f.decide('simulate-user-accept-b-plan', intake.card, 'accept-intake')
      const now = blocked('b-plan-edit-does-not-unblock-any-package')
      assert.deepEqual(Object.keys(now).sort(), ['a', 'b'])
      const prep = (pkg) => f.ok('prepare-' + pkg, 'plan', '--resolve-blocked', JSON.stringify({ package: pkg, action: 'retry', reason: '合成用户要求仅重试该包' }), '--blocked-ref', now[pkg])
      const b = prep('b'), a = prep('a')
      f.pending('two-recovery-cards', [a.decisionId,b.decisionId])
      f.ok('confirm-a-second-card', 'decide', '--decision-id', a.decisionId, '--choice', '1')
      f.pending('b-still-pending', [b.decisionId])
      f.ok('cancel-b', 'decide', '--decision-id', b.decisionId, '--choice', '2')
      const batch = f.plan('only-a-is-retried')
      assert.equal(batch.stop, null)
      assert.deepEqual(batch.waves.map(w => w.package), ['a'], '批准 A 不解除 B 的阻塞')
      assert.match(batch.waves[0].prompt, /合成阻塞只影响本包/, 'A 新派单要保留本包阻塞原文')
    }],
    ['lead-rule-path', () => {
      const root = project('lead-rule-path')
      const f = (step) => cli(root, 'lead-rule-path/' + step, ['help'])
      const shipped = f('package-fallback')
      assert.ok(shipped.leadGeneralRules?.trim(), '以实际 bin 的 help 返回 Lead 通用规则')
      const userPath = path.join(home, '.team-work/rules/lead/README.md')
      const projectPath = path.join(root, 'team-work/rules/lead/README.md')
      for (const [file, marker] of [[userPath, '合成用户通用规则替代内容'], [projectPath, '合成项目追加规则内容']]) {
        mkdirSync(path.dirname(file), { recursive: true })
        writeFileSync(file, '## 规范\n\n- ' + marker + '\n')
      }
      const overlaid = f('own-home-override-and-project-append')
      assert.match(overlaid.leadGeneralRules, /合成用户通用规则替代内容/)
      assert.match(overlaid.leadGeneralRules, /合成项目追加规则内容/)
      assert.notEqual(overlaid.leadGeneralRules, shipped.leadGeneralRules)
    }],
  ]
  let failures = 0
  for (const [name, fn] of cases) {
    try { fn(); emit({ type: 'case', name, status: 'pass' }) }
    catch (error) { failures++; emit({ type: 'case', name, status: 'fail', error: String(error.stack ?? error) }) }
  }
  emit({ type: 'cli-summary', total: cases.length, pass: cases.length - failures, fail: failures, skip: 0, realModelRequests: 0 })
  return failures ? 1 : 0
}
