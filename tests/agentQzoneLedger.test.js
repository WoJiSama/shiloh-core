import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'
import { createQzoneRedis, qzoneRedisAvailable } from './helpers/agentQzoneRedis.mjs'

const [{ createAgentQzoneLedger }, { createStandaloneAgentConsoleQzone }] = await Promise.all([
  importBilibiliHost('modules/runtime/infrastructure/agentQzoneLedger.js'),
  importBilibiliHost('bootstrap/standaloneAgentConsoleQzone.js'),
])
const account = { platform: 'qq', namespace: 'global', id: '100001' }
const binding = (room = '200001', agentId = 'role') => ({ source: 'configured', id: 'binding-' + room, revision: 'one', agentId,
  personaId: 'default', connectionId: 'qq-main', target: { account, kind: 'group', id: room } })
const limits = { enabled: true, visitCooldownMs: 2 * 3_600_000, minAffinity: 55, maxLikesPerDay: 6, maxCommentsPerDay: 3 }
const baseNow = Date.UTC(2026, 10, 17, 10)
const like = (postId = 'post-1') => ({ kind: 'like', userId: '300001', postId, visitId: 'visit-proof' })
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const ownKey = postId => 'agent:qzone:v1:own:' + hash([[account.platform, account.namespace, account.id], postId])
const visitKey = id => 'agent:qzone:v1:visit:' + hash(id)
const input = (operation = like(), overrides = {}) => ({ binding: binding(), identity: 'source-1', operation, now: baseNow, limits, ...overrides })
async function setup(t) {
  const fixture = await createQzoneRedis(t)
  return { ...fixture, ledger: createAgentQzoneLedger(fixture.storage) }
}
async function claimed(ledger, args) {
  const result = await ledger.claim(args)
  assert.equal(result.state, 'claimed', JSON.stringify(result))
  assert.ok(result.claim)
  assert.ok(await ledger.isPending(result.claim))
  return result.claim
}

test('durable account effects block another group, agent and changed comment text after reconnect', { skip: !qzoneRedisAvailable }, async t => {
  const { storage, ledger, connect } = await setup(t)
  const first = await claimed(ledger, input()), secondClient = await connect(), restarted = createAgentQzoneLedger(secondClient)
  assert.deepEqual(await restarted.claim(input(like(), { binding: binding('200002', 'other'), identity: 'other-source' })),
    { state: 'unknown', code: 'qzone_already_unknown' })
  assert.equal(await ledger.settle(first, 'unknown'), true)
  assert.equal(await storage.ttl(first.key), -1)
  const unknown = await restarted.claim(input(like(), { identity: 'retry-source' }))
  assert.deepEqual(unknown, { state: 'unknown', code: 'qzone_already_unknown' })
  const comment = await claimed(ledger, input({ ...like('post-comment'), kind: 'comment', text: '今天天气真不错' }, { identity: 'comment-source' }))
  assert.equal(await ledger.settle(comment, 'confirmed'), true)
  assert.deepEqual(await restarted.claim(input({ ...like('post-comment'), kind: 'comment', text: '换一条评论也不重复' },
    { binding: binding('200002', 'other'), identity: 'comment-two' })), { state: 'failed', code: 'qzone_already_confirmed' })
  const all = await storage.keys('agent:qzone:v1:*')
  for (const key of all.filter(value => value.includes(':source:') || value.includes(':effect:'))) assert.equal(await storage.ttl(key), -1)
  for (const key of all) {
    const value = await storage.get(key)
    assert.equal(value?.includes('今天天气真不错'), false)
    assert.equal(value?.includes('换一条评论也不重复'), false)
  }
})

test('source identity cannot change a pending or completed publication payload', { skip: !qzoneRedisAvailable }, async t => {
  const { ledger } = await setup(t), operation = { kind: 'publish', text: '自己的纯文字动态' }
  const first = await claimed(ledger, input(operation))
  assert.deepEqual(await ledger.claim(input({ ...operation, text: '改写也不重放' })), { state: 'unknown', code: 'qzone_claim_conflict' })
  const source = binding(), ownPost = { account, agentId: source.agentId, postId: 'published-1', source }
  assert.equal(await ledger.settle(first, 'confirmed', { ownPost }), true)
  assert.deepEqual(await ledger.readOwnPost(account, 'published-1'), ownPost)
  assert.deepEqual(await ledger.claim(input(operation)), { state: 'failed', code: 'qzone_already_confirmed' })
  assert.equal(await ledger.isPending(first), false)
  assert.equal(await ledger.settle(first, 'failed'), false)
  const otherAccount = { ...account, id: '100002' }
  assert.equal(await ledger.readOwnPost(otherAccount, 'published-1'), undefined)
})

test('Core console checks the selected QQ binding and never repeats a confirmed or unknown native publication', { skip: !qzoneRedisAvailable }, async t => {
  const { ledger } = await setup(t), calls = []
  const first = binding()
  let current = first, ready = true
  const adapter = { id: first.connectionId, account, botName: '夹具机器人', isReady: () => ready,
    qzone: { async execute(action, guard) {
      await guard.ensureCurrent()
      calls.push(action)
      if (action.operation.text === '结果待确认') throw new Error('fixture timeout')
      return { state: 'confirmed', postId: 'native-post-1' }
    } } }
  const services = createStandaloneAgentConsoleQzone({ bindings: { list: () => [current], resolve: () => current },
    adapters: [adapter], auth: { authorize: async () => 'allowed' }, ledger, allowsText: () => true })
  const context = { principal: { id: 'console-operator', username: 'operator', via: 'session' },
    signal: new AbortController().signal, isCurrent: () => true, ensureCurrent() {} }
  const invoke = (operation, body) => services.find(service => service.operation === operation).handle({ body }, context)
  const { value } = await invoke('qzone.accounts')
  assert.deepEqual(value.bots.map(row => row.qq), [account.id])
  const request = { botIds: [account.id], requestId: randomUUID(), content: '已确认的发布',
    bindingTokens: { [account.id]: value.bots[0].bindingToken } }
  const submit = async body => (await invoke('qzone.publish', body)).value.results[0]
  assert.equal((await submit(request)).tid, 'native-post-1')
  assert.equal((await submit(request)).ok, true)
  assert.equal(calls.length, 1)
  assert.equal((await ledger.readOwnPost(account, 'native-post-1')).source.id, first.id)
  const second = { ...request, requestId: randomUUID(), content: '结果待确认' }
  assert.match((await submit(second)).error, /待确认/u)
  assert.match((await submit(second)).error, /待确认/u)
  assert.equal(calls.length, 2)
  current = { ...first, revision: 'new-binding' }
  assert.equal((await submit({ ...request, requestId: randomUUID() })).ok, false)
  ready = false
  assert.deepEqual((await invoke('qzone.accounts')).value.bots, [])
  assert.equal(calls.length, 2)
})

test('publication sources keep their original outcome across binding revision or agent changes', { skip: !qzoneRedisAvailable }, async t => {
  const { ledger } = await setup(t), publication = { kind: 'publish', text: '绑定变更也不能补发未知说说' }
  for (const state of ['pending', 'unknown', 'confirmed', 'failed']) {
    const identity = 'publication-' + state, first = await claimed(ledger, input(publication, { identity }))
    if (state !== 'pending') assert.equal(await ledger.settle(first, state, state === 'confirmed'
      ? { ownPost: { account, agentId: 'role', postId: 'published-' + state, source: binding() } } : undefined), true)
    for (const next of [{ ...binding(), revision: 'two' }, binding('200001', 'other-agent')]) {
      const uncertain = state === 'pending' || state === 'unknown'
      assert.deepEqual(await ledger.claim(input(publication, { identity, binding: next })),
        { state: uncertain ? 'unknown' : 'failed', code: uncertain ? 'qzone_already_unknown' : 'qzone_already_' + state })
    }
  }
  assert.equal((await ledger.readOwnPost(account, 'published-confirmed')).agentId, 'role')
})

test('one source can interact with two visited posts while a changed comment on the same post stays frozen', { skip: !qzoneRedisAvailable }, async t => {
  const { ledger } = await setup(t)
  const first = await claimed(ledger, input(like('first-post'))), second = await claimed(ledger, input(like('second-post')))
  assert.notEqual(first.key, second.key)
  assert.equal(await ledger.settle(first, 'confirmed'), true)
  assert.equal(await ledger.settle(second, 'confirmed'), true)
  const comment = { ...like('third-post'), kind: 'comment', text: '给这条动态自然留言' }
  await claimed(ledger, input(comment))
  assert.deepEqual(await ledger.claim(input({ ...comment, text: '改变评论也不能重复发送' })), { state: 'unknown', code: 'qzone_claim_conflict' })
  await claimed(ledger, input({ ...comment, postId: 'fourth-post' }))
})

test('only matching confirmed publication evidence can atomically create durable ownership', { skip: !qzoneRedisAvailable }, async t => {
  const { ledger, storage } = await setup(t), publication = await claimed(ledger, input({ kind: 'publish', text: '发布结果由真实tid确认' }))
  const good = { account, agentId: 'role', postId: 'own-1', source: binding() }
  for (const evidence of [undefined, {}, { visit: {} }, { ownPost: { ...good, agentId: 'foreign' } },
    { ownPost: { ...good, account: { ...account, id: '100002' } } }, { ownPost: { ...good, source: binding('other-room') } }]) {
    assert.equal(await ledger.settle(publication, 'confirmed', evidence), false)
    assert.equal(await ledger.isPending(publication), true)
  }
  assert.equal(await ledger.settle(publication, 'failed', { ownPost: good }), false)
  assert.equal(await ledger.settle(publication, 'confirmed', { ownPost: good }), true)
  assert.equal(await storage.ttl(ownKey('own-1')), -1)
  const collision = await claimed(ledger, input({ kind: 'publish', text: '其他角色的动态' }, { binding: binding('200002', 'other'), identity: 'second' }))
  assert.equal(await ledger.settle(collision, 'confirmed', { ownPost: { ...good, agentId: 'other', source: binding('200002', 'other') } }), false)
  assert.equal(await ledger.isPending(collision), true)
  assert.deepEqual(await ledger.readOwnPost(account, 'own-1'), good)
})

test('real Lua atomically permits exactly six likes and three comments per account group in UTC+8 day', { skip: !qzoneRedisAvailable }, async t => {
  const { ledger } = await setup(t), beforeMidnight = Date.UTC(2026, 10, 17, 15, 59, 59, 999)
  const attempts = await Promise.all(Array.from({ length: 20 }, (_, index) => ledger.claim(input(like('p-' + index),
    { identity: 'like-' + index, binding: binding('200001', 'role-' + index), now: beforeMidnight }))))
  assert.equal(attempts.filter(row => row.state === 'claimed').length, 6)
  assert.equal(attempts.filter(row => row.code === 'qzone_daily_limit').length, 14)
  const comments = await Promise.all(Array.from({ length: 10 }, (_, index) => ledger.claim(input({ ...like('c-' + index), kind: 'comment', text: '自然的一句短评' },
    { identity: 'comment-' + index, now: beforeMidnight }))))
  assert.equal(comments.filter(row => row.state === 'claimed').length, 3)
  assert.equal(comments.filter(row => row.code === 'qzone_daily_limit').length, 7)
  await claimed(ledger, input(like('after-midnight'), { identity: 'new-day', now: beforeMidnight + 1 }))
  await claimed(ledger, input(like('another-room'), { identity: 'other-room', binding: binding('200002'), now: beforeMidnight }))
  const otherAccount = { ...account, id: '100002' }, bound = binding()
  await claimed(ledger, input(like('another-account'), { identity: 'other-account', binding: { ...bound, target: { ...bound.target, account: otherAccount } }, now: beforeMidnight }))
})

test('unknown and definite failures conservatively consume quota; configured zero forbids writes', { skip: !qzoneRedisAvailable }, async t => {
  const { ledger } = await setup(t)
  assert.deepEqual(await ledger.claim(input(like(), { limits: { ...limits, maxLikesPerDay: 0 } })), { state: 'failed', code: 'qzone_daily_limit' })
  const first = await claimed(ledger, input(like('one'), { limits: { ...limits, maxLikesPerDay: 1 } }))
  assert.equal(await ledger.settle(first, 'failed'), true)
  assert.deepEqual(await ledger.claim(input(like('two'), { identity: 'other', limits: { ...limits, maxLikesPerDay: 1 } })),
    { state: 'failed', code: 'qzone_daily_limit' })
  assert.deepEqual(await ledger.claim(input(like('one'), { identity: 'new-attempt' })), { state: 'failed', code: 'qzone_already_failed' })
  assert.deepEqual(await ledger.claim(input(like('disabled'), { limits: { ...limits, enabled: false } })), { state: 'failed', code: 'qzone_disabled' })
})

test('visit cooldown is atomic across agents and does not turn failed visits into confirmed capabilities', { skip: !qzoneRedisAvailable }, async t => {
  const { ledger } = await setup(t), operation = { kind: 'visit', userId: '300001' }
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => ledger.claim(input(operation,
    { identity: 'visit-' + index, binding: binding('200001', 'role-' + index) }))))
  assert.equal(results.filter(row => row.state === 'claimed').length, 1)
  assert.equal(results.filter(row => row.code === 'qzone_visit_cooldown').length, 7)
  assert.equal(await ledger.settle(results.find(row => row.state === 'claimed').claim, 'failed'), true)
  assert.equal(await ledger.readVisit('never-created'), undefined)
  assert.deepEqual(await ledger.claim(input(operation, { identity: 'too-early', now: baseNow + limits.visitCooldownMs - 1 })),
    { state: 'failed', code: 'qzone_visit_cooldown' })
  await claimed(ledger, input(operation, { identity: 'ready', now: baseNow + limits.visitCooldownMs }))
  await claimed(ledger, input(operation, { identity: 'another-room', binding: binding('200002') }))
})

test('only matching source-bound visit evidence is persisted, with bounded lifetime and no feed body', { skip: !qzoneRedisAvailable }, async t => {
  const { ledger, storage } = await setup(t), operation = { kind: 'visit', userId: '300001' }, claim = await claimed(ledger, input(operation))
  const visit = { id: 'trusted-visit', binding: binding(), sourceId: 'source-1', userId: '300001', postIds: ['post-1', 'post-2'],
    observedAt: baseNow + 1_000, expiresAt: baseNow + 1_000 + 15 * 60_000 }
  for (const changed of [{ sourceId: 'wrong-source' }, { binding: binding('200002') }, { userId: '300002' },
    { observedAt: baseNow - 1 }, { expiresAt: visit.expiresAt + 1 }, { text: 'must never persist feed text' }]) {
    assert.equal(await ledger.settle(claim, 'confirmed', { visit: { ...visit, ...changed } }), false)
    assert.equal(await ledger.isPending(claim), true)
  }
  assert.equal(await ledger.settle(claim, 'confirmed', { visit }), true)
  assert.deepEqual(await ledger.readVisit(visit.id), visit)
  assert.ok(await storage.pTTL(visitKey(visit.id)) <= 15 * 60_000)
  assert.ok(await storage.pTTL(visitKey(visit.id)) > 14 * 60_000)
  assert.equal(await storage.ttl(claim.key), -1)
  assert.equal(await ledger.readVisit('foreign-id'), undefined)
})

test('stable deletion effects are account-wide and never depend on list position or source room', { skip: !qzoneRedisAvailable }, async t => {
  const { ledger } = await setup(t), first = await claimed(ledger, input({ kind: 'delete', postId: 'own-post' }))
  assert.deepEqual(await ledger.claim(input({ kind: 'delete', postId: 'own-post' }, { binding: binding('200002', 'other'), identity: 'another' })),
    { state: 'unknown', code: 'qzone_already_unknown' })
  assert.equal(await ledger.settle(first, 'confirmed'), true)
  assert.deepEqual(await ledger.claim(input({ kind: 'delete', postId: 'own-post' }, { identity: 'again' })),
    { state: 'failed', code: 'qzone_already_confirmed' })
})

test('corrupt state, wrong Redis types and CAS mismatches fail closed without overwriting evidence', { skip: !qzoneRedisAvailable }, async t => {
  const { ledger, storage } = await setup(t), first = await claimed(ledger, input())
  assert.equal(await ledger.isPending({ ...first, token: 'forged' }), false)
  assert.equal(await ledger.settle({ ...first, token: 'forged' }, 'confirmed'), false)
  const raw = await storage.get(first.key)
  await storage.set(first.key, raw + 'corrupt')
  assert.equal(await ledger.isPending(first), false)
  assert.equal(await ledger.settle(first, 'confirmed'), false)
  assert.deepEqual(await ledger.claim(input()), { state: 'failed', code: 'qzone_ledger_unavailable' })
  await storage.del(first.key)
  await storage.lPush(first.key, 'wrong type')
  assert.deepEqual(await ledger.claim(input()), { state: 'failed', code: 'qzone_ledger_unavailable' })
  await storage.set(ownKey('corrupt'), '{}')
  await assert.rejects(ledger.readOwnPost(account, 'corrupt'))
  await storage.set(visitKey('corrupt'), '{}')
  await assert.rejects(ledger.readVisit('corrupt'))
})

test('settlement checks the account effect replica and quota corruption never partly claims a new source', { skip: !qzoneRedisAvailable }, async t => {
  const { ledger, storage } = await setup(t), first = await claimed(ledger, input())
  const raw = await storage.get(first.key), effect = (await storage.keys('agent:qzone:v1:effect:*'))[0]
  await storage.set(effect, JSON.stringify({ ...JSON.parse(raw), token: 'changed-owner' }))
  assert.equal(await ledger.isPending(first), false)
  assert.equal(await ledger.settle(first, 'confirmed'), false)
  assert.equal(await storage.get(first.key), raw)
  const quota = (await storage.keys('agent:qzone:v1:quota:*'))[0]
  await storage.set(quota, 'broken-counter')
  const before = await storage.keys('agent:qzone:v1:source:*')
  assert.deepEqual(await ledger.claim(input(like('new-post'), { identity: 'new-source' })), { state: 'failed', code: 'qzone_ledger_unavailable' })
  assert.deepEqual(await storage.keys('agent:qzone:v1:source:*'), before)
  assert.equal((await storage.keys('agent:qzone:v1:effect:*')).length, 1)
})

test('descriptor validation never invokes getters and rejects malformed claims', { skip: !qzoneRedisAvailable }, async t => {
  const { ledger } = await setup(t)
  let touched = 0
  const getter = { ...input(), get identity() { touched++; return 'fake' } }
  assert.deepEqual(await ledger.claim(getter), { state: 'failed', code: 'qzone_ledger_unavailable' })
  assert.equal(touched, 0)
  assert.equal(await ledger.isPending({ key: 'foreign:key', token: 'secret' }), false)
  assert.equal(await ledger.settle({ key: 'foreign:key', token: 'secret' }, 'confirmed'), false)
})
