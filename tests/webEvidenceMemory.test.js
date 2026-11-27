import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentBindingDirectory } from '../dist/backend/core/index.js'
import { createWebEvidenceMemory, WEB_EVIDENCE_KEY } from '../dist/backend/modules/memory/infrastructure/webEvidenceMemory.js'

const account = { platform: 'qq', namespace: 'global', id: '10000' }
const day = 86_400_000
const at = Date.UTC(2026, 10, 12)
const url = 'https://guide.example.org/2026/ceramics'
const directory = createAgentBindingDirectory({ version: 1, agents: [{ id: 'daily', personaId: 'default' }],
  connections: [{ id: 'qq', platform: account.platform, namespace: account.namespace, accountId: account.id }],
  bindings: Array.from({ length: 38 }, (_, i) => ({ connectionId: 'qq', kind: i >= 36 ? 'private' : 'group',
    conversationId: String(5000 + i), agentId: 'daily' })),
}, 'bindings-v1')
const binding = (i = 0) => directory.resolve({ account, kind: i >= 36 ? 'private' : 'group', id: String(5000 + i) })
const question = (messageId, text = '秋日陶艺的报名表怎么填？', authorId = '20101', time = at) => ({ messageId, text, authorId, at: time })
const page = (overrides = {}) => ({ requestedUrl: url, url, title: '秋日陶艺报名指南',
  text: '第一节：工作室历史。\n秋日陶艺报名表在蓝色入口。\n建议穿围裙。', freshForMs: 10 * day, ...overrides })
const current = () => true
const turn = () => new AbortController().signal

function fixture() {
  let revision = '', atNow = at, epoch = 0, enabled = true, peer = '20101', collisions = 0
  const revoked = new Set(), disabled = new Set(), stored = new Map()
  const revisionKey = `${WEB_EVIDENCE_KEY}:revision`
  const bytes = () => stored.size ? Buffer.byteLength(revisionKey + revision + WEB_EVIDENCE_KEY) +
    [...stored].reduce((total, [field, value]) => total + Buffer.byteLength(field + value), 0) : 0
  const redis = {
    async get(key) { assert.equal(key, revisionKey); return revision || null },
    async eval(script, { keys, arguments: args }) {
      assert.deepEqual(keys, [revisionKey, WEB_EVIDENCE_KEY])
      if (script.startsWith('-- agent-web-evidence-read-v1')) return [revision, ...[...stored].filter(([field]) => field.startsWith(args[0])).flat()]
      assert.match(script, /^-- agent-web-evidence-update-v1/u)
      const [previous, next, ttl, dropCount, ...fields] = args
      assert.ok(Number(ttl) > 0)
      if (previous !== revision) { collisions++; return 0 }
      for (const field of fields.slice(0, Number(dropCount))) stored.delete(field)
      const writes = fields.slice(Number(dropCount))
      assert.ok(writes.length <= 4, 'writes carry only changed rows')
      for (let i = 0; i < writes.length; i += 2) stored.set(writes[i], writes[i + 1])
      revision = stored.size ? next : ''
      assert.ok(bytes() <= 512 * 1024)
      return 1
    },
  }
  const create = () => createWebEvidenceMemory({ redis, now: () => atNow, allowsBinding: () => enabled,
    privatePeer: target => target.kind === 'private' ? peer : undefined, allowsText: text => !text.includes('forbidden-secret'),
    isRecalled: async (_target, id) => revoked.has(id),
    memory: { async getSceneRedactions() { return { invalidatedAt: epoch } }, async getRedactions({ subjectId }) {
      return { disabled: disabled.has(subjectId), forgottenBefore: 0, scenes: [], revokedSources: [], tombstones: [] }
    } },
  })
  let memory = create()
  return { get memory() { return memory }, get collisions() { return collisions }, bytes,
    get raw() { return stored.size ? [...stored.values()].join('\n') : null }, get rows() { return [...stored.values()].map(value => JSON.parse(value)) }, now: () => atNow,
    advance(ms) { atNow += ms }, invalidate() { epoch = atNow }, restart() { memory = create() },
    enable(value) { enabled = value }, setPeer(value) { peer = value }, recallMessage(id) { revoked.add(id) }, disable(id) { disabled.add(id) },
  }
}

test('a different speaker reuses a relevant excerpt after restart, with no other conversation or peer access', async () => {
  const f = fixture()
  await f.memory.observe(binding(), question('q1', '秋日陶艺报名表，另有不应被保存的聊天文字'), page(), turn(), current)
  assert.equal(f.rows.length, 1)
  assert.doesNotMatch(f.raw, /不应被保存|工作室历史|建议穿围裙/u)
  f.restart(); f.advance(7 * day)
  const q = question('q2', '陶艺活动那个报名表在哪儿？', '20102', f.now())
  const hit = await f.memory.recall(binding(), q, current)
  assert.match(hit.text, /网页缓存有效/u)
  assert.match(hit.text, /秋日陶艺报名表在蓝色入口/u)
  assert.equal(await hit.isCurrent(), true)
  for (const other of [binding(1), binding(36), { ...binding(), revision: 'new-binding' }]) {
    assert.equal(await f.memory.recall(other, q, current), undefined)
  }
  assert.equal(await f.memory.recall(binding(), question('off-topic', '周末看猫咪纪录片？'), current), undefined)
  assert.equal(await f.memory.recall(binding(), question('other-edition', '2025 年秋日陶艺报名表在哪？'), current), undefined)
  assert.equal(await f.memory.recall(binding(), question('other-url', `这份秋日陶艺报名表 ${url}-alternate`), current), undefined)
  assert.equal(await f.memory.recall(binding(), question('reminder', '提醒我去填秋日陶艺报名表。'), current), undefined)
  await f.memory.observe(binding(36), question('private-1', undefined, '20101', f.now()), page({ text: '秋日陶艺报名表在私聊看到的公开绿色入口。' }), turn(), current)
  assert.match((await f.memory.recall(binding(36), { ...q, authorId: '20101' }, current)).text, /绿色入口/u)
  assert.doesNotMatch((await f.memory.recall(binding(), q, current)).text, /绿色入口/u)
  f.setPeer('20102')
  assert.equal(await f.memory.recall(binding(36), q, current), undefined)
  f.enable(false)
  assert.equal(await hit.isCurrent(), false)
})

test('live questions get a lead, expiry never renews on a hit, and observed changes replace the old excerpt', async () => {
  const f = fixture()
  await f.memory.observe(binding(), question('q1'), page({ freshForMs: 60_000 }), turn(), current)
  const live = () => f.memory.recall(binding(), question('q2', '秋日陶艺今天还能报名吗？', undefined, f.now()), current)
  const prior = await live()
  assert.match(prior.text, /guide\.example\.org/u)
  assert.doesNotMatch(prior.text, /蓝色入口/u)
  f.advance(60_001)
  const after = await f.memory.recall(binding(), question('q3', undefined, undefined, f.now()), current)
  assert.match(after.text, /当前内容待核实/u)
  assert.doesNotMatch(after.text, /蓝色入口/u)
  const historical = await f.memory.recall(binding(), question('q4', '上次查到的秋日陶艺报名表是什么？', undefined, f.now()), current)
  assert.match(historical.text, /蓝色入口/u)
  await f.memory.observe(binding(), question('q2', undefined, undefined, f.now()), page({ text: '秋日陶艺报名表改到红色入口。' }), turn(), current)
  const updated = await f.memory.recall(binding(), question('q5', undefined, undefined, f.now()), current)
  assert.match(updated.text, /红色入口/u)
  assert.doesNotMatch(updated.text, /蓝色入口/u)
  const { freshForMs: _omit, ...uncacheable } = page()
  await f.memory.observe(binding(), question('q6', undefined, undefined, f.now()), uncacheable, turn(), current)
  assert.equal(f.raw, null)
  await f.memory.observe(binding(), question('q7', undefined, undefined, f.now()), page(), turn(), current)
  f.advance(14 * day)
  assert.equal(await live(), undefined)
})

test('recall and forget revoke projections before reuse and clean up the matching durable rows', async () => {
  const f = fixture(), selected = binding()
  await f.memory.observe(selected, question('withdrawn'), page(), turn(), current)
  await f.memory.observe(binding(1), question('leave-in-other-scene'), page(), turn(), current)
  const hit = await f.memory.recall(selected, question('review'), current)
  f.recallMessage('withdrawn')
  assert.equal(await hit.isCurrent(), false)
  await f.memory.revoke(selected.target, 'withdrawn', current)
  assert.equal(f.rows.length, 1)
  await f.memory.observe(selected, question('forgetme'), page(), turn(), current)
  const toForget = await f.memory.recall(selected, question('review-again'), current)
  f.advance(1000); f.invalidate(); f.disable('20101')
  assert.equal(await toForget.isCurrent(), false)
  await f.memory.observe(selected, question('late-writer'), page(), turn(), current)
  const result = await f.memory.purgeSubject({ account, agentId: selected.agentId, subjectId: '20101', target: selected.target, through: f.now() },
    { signal: turn(), isCurrent: current, ensureCurrent() {} })
  assert.equal(result.removedRecords, 1)
  assert.deepEqual(f.rows.map(row => row.messageId), ['leave-in-other-scene'])
})

test('serialized byte and entry budgets hold on multilingual pages, retries and concurrent writers', async () => {
  const f = fixture(), oneTurn = turn(), use = (i, j, signal = turn(), id = `q-${i}-${j}`) => {
    const source = `${url}/${j}-` + 'z'.repeat(195)
    return f.memory.observe(binding(i), question(id, undefined, undefined, f.now()),
      page({ url: source, requestedUrl: source, text: '秋日陶艺报名资料'.repeat(30) + '🏺'.repeat(30) }), signal, current)
  }
  await Promise.all(Array.from({ length: 8 }, (_, j) => use(0, j, oneTurn, 'many')))
  assert.equal(f.rows.length, 2)
  assert.ok(f.bytes() <= 2 * 1024)
  await use(0, 99, turn(), 'many') // replay with a different local turn object
  assert.equal(f.rows.length, 2)
  for (let j = 0; j < 40; j++) {
    f.advance(1)
    await use(1, j)
  }
  assert.equal(f.rows.length, 34)
  assert.ok(!f.rows.some(row => row.messageId === 'q-1-0'))
  for (let j = 0; j < 18; j++) {
    f.advance(1)
    for (let i = 2; i < 36; i += 3) await Promise.all(Array.from({ length: Math.min(3, 36 - i) }, (_, k) => use(i + k, j)))
  }
  assert.ok(f.collisions > 0)
  assert.equal(f.rows.length, 512)
  assert.ok(f.rows.every(row => Buffer.byteLength(JSON.stringify(row)) <= 1024))
  assert.ok(f.bytes() <= 512 * 1024)
  assert.ok(!f.rows.some(row => row.messageId === 'many'))
})
