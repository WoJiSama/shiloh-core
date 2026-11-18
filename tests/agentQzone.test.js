import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'
import { createQzoneRedis, qzoneRedisAvailable } from './helpers/agentQzoneRedis.mjs'
const validation = await importBilibiliHost('modules/tools/infrastructure/agentQzoneValidation.js')
const { validateAgentQzoneAction: validate, validateAgentQzoneOperation: operation, normalizeAgentQzoneLimits: limits, normalizeAgentQzoneReceipt: receipt } = validation
const { createAgentQzoneRuntime } = await importBilibiliHost('modules/runtime/infrastructure/agentQzoneRuntime.js')
const { createAgentQzoneLedger } = await importBilibiliHost('modules/runtime/infrastructure/agentQzoneLedger.js')
const account = { platform: 'fixture', namespace: 'qzone', id: 'bot' }, target = { account, kind: 'group', id: 'room' }
const binding = (overrides = {}) => ({ source: 'configured', id: 'bound', revision: 'one', agentId: 'agent', personaId: 'default', connectionId: 'conn', target: structuredClone(target), ...overrides })
const action = op => ({ version: 1, binding: binding(), operation: op })
const publish = { kind: 'publish', text: '今天的阳光很温暖。' }, visit = { kind: 'visit', userId: 'friend' }
const feed = { postId: 'post-1', userId: 'friend', text: '去了公园。', likes: 0 }
const naturalComment = '这张照片的颜色很漂亮，公园里的花开得正好，看到这样温暖的春日景色让我也想出去走走！'
function fakeLedger() {
  const claims = [], settlements = [], own = new Map(), visits = new Map()
  return { claims, settlements, own, visits,
    async claim(input) { claims.push(input); return { state: 'claimed', claim: { key: 'key', token: 'token' } } }, async isPending() { return true },
    async settle(claim, state, evidence) { settlements.push({ claim, state, evidence }); if (evidence?.ownPost) own.set(evidence.ownPost.postId, evidence.ownPost); if (evidence?.visit) visits.set(evidence.visit.id, evidence.visit); return true },
    async readOwnPost(acc, postId) { return own.get(postId) }, async readVisit(id) { return visits.get(id) },
  }
}
function fixture(options = {}, overrides = {}) {
  let active = true, granted = true, time = 1_790_000_000_000, affinity = 55
  const calls = [], reads = [], diagnostics = [], ledger = options.ledger ?? fakeLedger(), controller = new AbortController()
  const provider = options.provider ?? { async execute(selected, guard) { await guard.ensureCurrent(); calls.push(selected); return selected.operation.kind === 'publish' ? { state: 'confirmed', postId: 'own-1' }
    : selected.operation.kind === 'visit' ? { state: 'confirmed', feeds: [feed] } : { state: 'confirmed' } } }
  const runtime = createAgentQzoneRuntime({ enabled: true, limits: { enabled: true }, now: () => time, diagnostics: { emit(event) { diagnostics.push(event) } }, ...options, ledger, provider })
  const input = { binding: binding(), identity: 'human-source-1', actor: { kind: 'user', user: { ...account, id: 'requester' } }, operation: publish,
    signal: controller.signal, isCurrent: () => active, async ensureCurrent() {}, async authorize() { return granted }, async allowsText() { return true },
    affinity: () => affinity, async readMember(userId, guard) { await guard.ensureCurrent(); reads.push(userId); return { target: structuredClone(input.binding.target), observedAt: time,
      member: { user: { ...account, id: userId }, displayName: userId, role: 'member' } } }, ...overrides }
  return { runtime, input, ledger, calls, reads, diagnostics, controller, revoke() { active = false }, deny() { granted = false }, advance(ms) { time += ms }, affinity(value) { affinity = value },
    async run(op = input.operation) { input.operation = op; return runtime.execute(input) } }
}

test('qzone contract owns immutable closed actions and rejects positional/native/foreign extras', () => {
  const raw = action(publish), selected = validate(raw)
  raw.binding.agentId = 'changed'; raw.binding.target.id = 'changed'
  assert.equal(selected.binding.agentId, 'agent'); assert.equal(selected.binding.target.id, 'room')
  for (const value of [selected, selected.binding, selected.binding.target, selected.binding.target.account, selected.operation]) assert.ok(Object.isFrozen(value))
  for (const op of [{ ...publish, images: [] }, { kind: 'delete', pos: 1 }, { kind: 'delete', postId: 'x', userId: 'stranger' }, { ...visit, native: true },
    { kind: 'like', userId: 'friend', postId: 'x' }, { ...publish, text: 'a'.repeat(2001) }]) assert.throws(() => validate(action(op)))
  assert.throws(() => validate({ ...action(visit), binding: binding({ target: { ...target, kind: 'private' } }) }))
  assert.throws(() => validate({ ...action(publish), binding: binding({ source: 'legacy' }) }))
})

test('qzone validators reject accessors and proxies without executing behavior', () => {
  let touched = 0
  const proxy = new Proxy(publish, { get() { touched++; throw Error('secret') }, getPrototypeOf() { touched++; throw Error('secret') }, ownKeys() { touched++; throw Error('secret') } })
  const getter = { kind: 'publish', get text() { touched++; return 'secret' } }
  for (const value of [proxy, getter, { ...publish, text: { toString() { touched++; return 'secret' } } }]) assert.throws(() => operation(value))
  const getterReceipt = { get state() { touched++; return 'confirmed' } }
  assert.deepEqual(receipt(getterReceipt, publish), { state: 'unknown' }); assert.equal(touched, 0)
})

test('runtime descriptor checks reject source getter mutation after authorization without executing it', async () => {
  let touched = 0
  const f = fixture({}, { async authorize() {
    Object.defineProperty(f.input, 'operation', { configurable: true, get() { touched++; return publish } })
    return true
  } })
  assert.equal((await f.run()).state, 'failed'); assert.equal(touched, 0); assert.equal(f.calls.length, 0)
})

test('qzone defaults preserve disabled simulation and legacy bounds', () => {
  assert.deepEqual(limits(), { enabled: false, visitCooldownMs: 7_200_000, minAffinity: 55, maxLikesPerDay: 6, maxCommentsPerDay: 3 })
  assert.deepEqual(limits({ enabled: true, visitCooldownMs: 0, minAffinity: 999, maxLikesPerDay: 999, maxCommentsPerDay: -1 }),
    { enabled: true, visitCooldownMs: 1_800_000, minAffinity: 100, maxLikesPerDay: 50, maxCommentsPerDay: 0 })
  for (const value of [{ enabled: 'true' }, { minAffinity: NaN }, { maxLikesPerDay: '6' }, { unknown: true }]) assert.throws(() => limits(value))
})

test('comment uses 120 UTF16 units, avoids split surrogates and redacts before output policy', () => {
  const comment = text => operation({ kind: 'comment', userId: 'friend', postId: 'p', visitId: 'v', text }).text
  assert.equal(comment('好'.repeat(121)), '好'.repeat(120))
  assert.equal(comment('好'.repeat(119) + '🌻'), '好'.repeat(119))
  assert.equal(comment(naturalComment + ' stage=initial'), naturalComment)
  for (const text of ['stage=initial group=123456', '\ud800', 'hello\u0001world', 'password=SECRET_LONG_VALUE']) assert.throws(() => comment(text))
})

test('receipts require operation-specific evidence; no invented message ID confirms an effect', () => {
  assert.deepEqual(receipt({ state: 'confirmed', postId: 'own-1' }, publish), { state: 'confirmed', postId: 'own-1' })
  for (const raw of [{ state: 'confirmed' }, { state: 'confirmed', postId: 'x', messageId: 'fake' }, { status: 'ok', retcode: 0, tid: 'x' }]) assert.deepEqual(receipt(raw, publish), { state: 'unknown' })
  assert.deepEqual(receipt({ state: 'confirmed', feeds: [] }, visit), { state: 'confirmed', feeds: [] })
  for (const raw of [{ state: 'confirmed' }, { state: 'confirmed', feeds: [{ ...feed, userId: 'other' }] }, { state: 'confirmed', feeds: [feed, feed] }, { state: 'confirmed', feeds: [, feed] }]) assert.equal(receipt(raw, visit).state, 'failed')
  assert.deepEqual(receipt({ state: 'failed', code: 'provider_secret_token' }, publish), { state: 'failed', code: 'qzone_rejected' })
})

test('only current host-authorized human actors can perform qzone operations', async () => {
  for (const actor of [{ kind: 'autonomous' }, { kind: 'commitment' }, { kind: 'user', user: { ...account, namespace: 'other', id: 'requester' } }, { kind: 'user', user: account }]) {
    const f = fixture({}, { actor }); assert.equal((await f.run()).state, 'failed'); assert.equal((await f.run(visit)).state, 'failed'); assert.equal(f.calls.length, 0); assert.equal(f.ledger.claims.length, 0)
  }
  for (const setup of [f => f.revoke(), f => f.deny(), f => f.controller.abort()]) { const f = fixture(); setup(f); assert.equal((await f.run()).state, 'failed'); assert.equal(f.calls.length, 0) }
  const disabled = fixture({ enabled: false }); assert.equal((await disabled.run()).state, 'failed')
  const simDisabled = fixture({ limits: {} }); assert.equal((await simDisabled.run(visit)).state, 'failed')
})

test('outbound text must pass the final persona policy and is never persisted in the ledger claim record', async () => {
  const texts = [], f = fixture({}, { async allowsText(text) { texts.push(text); return false } })
  assert.equal((await f.run()).state, 'failed'); assert.deepEqual(texts, [publish.text]); assert.equal(f.calls.length, 0)
  const missing = fixture({}, { allowsText: undefined }); assert.equal((await missing.run()).state, 'failed')
  const accepted = fixture(); assert.deepEqual(await accepted.run(), { state: 'confirmed', kind: 'publish', postId: 'own-1', terminal: true })
  assert.equal(accepted.ledger.own.get('own-1').agentId, 'agent'); assert.equal(accepted.ledger.settlements[0].state, 'confirmed')
})

test('deletion requires a confirmed owned stable ID of this account and agent', async () => {
  const f = fixture(); assert.equal((await f.run({ kind: 'delete', postId: 'random' })).state, 'failed'); assert.equal(f.calls.length, 0)
  await f.run(publish); assert.equal((await f.run({ kind: 'delete', postId: 'own-1' })).state, 'confirmed')
  for (const mutate of [own => { own.agentId = 'other'; own.source.agentId = 'other' }, own => { own.account.id = 'other'; own.source.target.account.id = 'other' }]) {
    const g = fixture(); await g.run(); const own = structuredClone(g.ledger.own.get('own-1')); mutate(own); g.ledger.own.set('own-1', own)
    assert.equal((await g.run({ kind: 'delete', postId: 'own-1' })).state, 'failed'); assert.equal(g.calls.length, 1)
  }
})

test('visit requires affinity and fresh current requester/target membership and returns an opaque source-bound proof', async () => {
  const f = fixture(), result = await f.run(visit)
  assert.equal(result.state, 'confirmed'); assert.equal(result.terminal, false); assert.ok(result.visitId); assert.deepEqual(result.feeds, [feed])
  assert.ok(f.reads.includes('requester')); assert.ok(f.reads.includes('friend'))
  const proof = f.ledger.visits.get(result.visitId); assert.deepEqual(proof.postIds, ['post-1']); assert.equal(proof.sourceId, f.input.identity); assert.equal(proof.expiresAt - proof.observedAt, 900_000); assert.equal(JSON.stringify(proof).includes(feed.text), false)
  const low = fixture(); low.affinity(54); assert.equal((await low.run(visit)).state, 'failed'); assert.equal(low.calls.length, 0)
  const stale = fixture({}, { async readMember(userId) { return { target, observedAt: 1, member: { user: { ...account, id: userId }, displayName: userId, role: 'member' } } } }); assert.equal((await stale.run(visit)).state, 'failed')
  const foreign = fixture({}, { async readMember(userId) { return { target: { ...target, id: 'other' }, observedAt: 1_790_000_000_000, member: { user: { ...account, id: userId }, displayName: userId, role: 'member' } } } }); assert.equal((await foreign.run(visit)).state, 'failed')
})

test('likes/comments accept only fresh proof from this same binding/source/member and validated post ID', async () => {
  const f = fixture(), seen = await f.run(visit), like = { kind: 'like', userId: 'friend', postId: 'post-1', visitId: seen.visitId }
  assert.equal((await f.run(like)).state, 'confirmed')
  assert.equal((await f.run({ ...like, postId: 'forged' })).state, 'failed')
  assert.equal((await f.run({ ...like, userId: 'other' })).state, 'failed')
  assert.equal((await f.run({ ...like, visitId: 'forged' })).state, 'failed')
  const proof = f.ledger.visits.get(seen.visitId)
  for (const key of ['agentId', 'revision', 'connectionId']) { const changed = structuredClone(proof); changed.binding[key] = 'other'; f.ledger.visits.set(seen.visitId, changed); assert.equal((await f.run(like)).state, 'failed') }
  f.ledger.visits.set(seen.visitId, proof); f.input.identity = 'other-source'; assert.equal((await f.run(like)).state, 'failed')
  f.input.identity = 'human-source-1'; f.advance(900_000); assert.equal((await f.run(like)).state, 'failed')
})

test('revocation during fresh reads or final authorization prevents every subsequent provider call', async () => {
  const f = fixture(); f.input.readMember = async userId => { f.revoke(); return { target, observedAt: 1_790_000_000_000, member: { user: { ...account, id: userId }, displayName: userId, role: 'member' } } }
  assert.equal((await f.run(visit)).state, 'failed'); assert.equal(f.calls.length, 0)
  let enabled = true
  const g = fixture({ getLimits: () => ({ enabled }) }); g.input.readMember = async userId => { enabled = false; return { target, observedAt: 1_790_000_000_000, member: { user: { ...account, id: userId }, displayName: userId, role: 'member' } } }
  assert.equal((await g.run(visit)).state, 'failed'); assert.equal(g.calls.length, 0)
  let maxLikesPerDay = 6
  const h = fixture({ getLimits: () => ({ enabled: true, maxLikesPerDay }) })
  h.input.readMember = async userId => { maxLikesPerDay = 0; return { target, observedAt: 1_790_000_000_000, member: { user: { ...account, id: userId }, displayName: userId, role: 'member' } } }
  assert.equal((await h.run(visit)).state, 'failed'); assert.equal(h.calls.length, 0)
})

test('visit revocation while durable settlement is pending discards late private feed and capability', async () => {
  const f = fixture(), settle = f.ledger.settle
  f.ledger.settle = async (...args) => { const saved = await settle(...args); f.revoke(); return saved }
  const result = await f.run(visit)
  assert.equal(result.state, 'failed'); assert.equal(result.feeds, undefined); assert.equal(result.visitId, undefined)
})

test('unknown/throws are durable terminal outcomes and never cause retries or leaked exception content', async () => {
  const f = fixture({ provider: { async execute() { throw Error('SECRET_COOKIE_BODY') } } })
  assert.deepEqual(await f.run(), { state: 'unknown', kind: 'publish', code: 'qzone_outcome_unknown', terminal: true })
  assert.equal(f.ledger.settlements[0].state, 'unknown'); assert.equal(JSON.stringify(f.diagnostics).includes('SECRET'), false)
  const malformed = fixture({ provider: { async execute() { return { state: 'confirmed', messageId: 'fake' } } } }); assert.equal((await malformed.run()).state, 'unknown')
})

test('settlement failure retains an unknown fence even after a provider confirms', async () => {
  const ledger = fakeLedger(); ledger.settle = async () => false
  const f = fixture({ ledger }); assert.deepEqual(await f.run(), { state: 'unknown', kind: 'publish', code: 'qzone_settlement_failed', terminal: true }); assert.equal(f.calls.length, 1)
})

test('deadlines and cancellation bound an uncooperative provider without replay', async () => {
  const f = fixture({ timeoutMs: 25, provider: { execute: () => new Promise(() => {}) } })
  const result = await f.run(); assert.equal(result.state, 'unknown'); assert.equal(result.terminal, true); assert.equal(f.ledger.settlements[0].state, 'unknown')
  const g = fixture({ provider: { async execute() { g.revoke(); await delay(35); return { state: 'confirmed', postId: 'late' } } } })
  assert.equal((await g.run()).state, 'unknown'); assert.equal(g.ledger.own.has('late'), false)
})

test('real Redis business closure publishes, restarts, deletes stable own ID, and never replays confirmed/unknown', async t => {
  assert.equal(qzoneRedisAvailable, true)
  const redis = await createQzoneRedis(t), ledger = createAgentQzoneLedger(redis.storage), f = fixture({ ledger })
  assert.equal((await f.run()).state, 'confirmed')
  const restored = createAgentQzoneLedger(await redis.connect()), g = fixture({ ledger: restored })
  const replay = await g.run(); assert.equal(replay.state, 'failed'); assert.equal(replay.terminal, true); assert.equal(g.calls.length, 0)
  assert.equal((await g.run({ kind: 'delete', postId: 'own-1' })).state, 'confirmed'); assert.equal(g.calls.length, 1)
  const other = fixture({ ledger: restored }, { binding: binding({ agentId: 'other-agent' }) }); assert.equal((await other.run({ kind: 'delete', postId: 'own-1' })).state, 'failed')
  const unknown = fixture({ ledger: restored, provider: { async execute() { return { state: 'unknown' } } } }, { identity: 'unknown-source' }); assert.equal((await unknown.run()).state, 'unknown')
  const again = fixture({ ledger: createAgentQzoneLedger(await redis.connect()) }, { identity: 'unknown-source' }); assert.equal((await again.run()).state, 'unknown'); assert.equal(again.calls.length, 0)
  const rebound = fixture({ ledger: createAgentQzoneLedger(await redis.connect()) }, { identity: 'unknown-source', binding: binding({ revision: 'new-version', agentId: 'replacement' }) })
  assert.equal((await rebound.run()).state, 'unknown'); assert.equal(rebound.calls.length, 0)
})

test('real Redis visit proof drives a comment, across-group/agent effects dedupe and text never persists', async t => {
  const redis = await createQzoneRedis(t), ledger = createAgentQzoneLedger(redis.storage), f = fixture({ ledger }), seen = await f.run(visit)
  const comment = { kind: 'comment', userId: 'friend', postId: 'post-1', visitId: seen.visitId, text: naturalComment + ' stage=initial' }
  assert.equal((await f.run(comment)).state, 'confirmed'); assert.equal(f.calls.at(-1).operation.text, naturalComment)
  const otherTarget = { ...target, id: 'other-room' }, g = fixture({ ledger }, { binding: binding({ agentId: 'other-agent', target: otherTarget }), identity: 'other-source' }), visit2 = await g.run(visit)
  assert.equal(visit2.state, 'confirmed'); assert.equal((await g.run({ ...comment, visitId: visit2.visitId, text: '换句话再评论' })).state, 'failed')
  assert.equal(g.calls.length, 1)
  const keys = await redis.storage.keys('agent:qzone:v1:*'), records = await Promise.all(keys.map(key => redis.storage.get(key))), joined = records.join('\n')
  assert.equal(joined.includes(feed.text), false); assert.equal(joined.includes('照片'), false); assert.equal(joined.includes('stage=initial'), false)
})
