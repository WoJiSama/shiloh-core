import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
const { createAgentBilibiliQualityStore } = await load('modules/media/infrastructure/agentBilibiliQualityStore.js')
const { conversationAddressKey } = await load('modules/runtime/domain/agentBindings.js')
const redisTest = { skip: !redisAvailable, timeout: 15000 }, HASH = 'a'.repeat(64)
const who = (id = 'human') => ({ platform: 'qq', namespace: 'global', id })
function binding(overrides = {}) { const target = overrides.target ?? { account: who('robot'), kind: 'group', id: 'room' }; return { source: 'configured', target, id: conversationAddressKey(target), agentId: 'alice', personaId: 'daily', connectionId: 'main', revision: 'r1', ...overrides } }
async function fixture(t) { const f = await createAgentRedisFixture(t, 'bilibili-quality-store'); return { ...f, store: createAgentBilibiliQualityStore(f.storage), restart: () => createAgentBilibiliQualityStore(f.storage) } }
test('claims and every native stage are durable before side effects and cannot be replayed', redisTest, async t => {
  const f = await fixture(t), b = binding(), claim = await f.store.claim(b, 'request', HASH)
  assert.ok(claim); await f.store.begin(claim, 'media')
  let raw = JSON.parse(await f.reader.get(f.prefix + claim.key)); assert.equal(raw.state, 'pending'); assert.equal(raw.effects.media, 'pending')
  await f.store.finish(claim, 'media', 'sent'); await f.store.settle(claim, 'sent')
  assert.equal(await f.store.claim(b, 'request', HASH), undefined); assert.equal(await f.store.current(claim), false)
  raw = JSON.parse(await f.reader.get(f.prefix + claim.key)); assert.equal(raw.state, 'sent'); assert.equal(raw.effects.media, 'sent')
  assert.ok(await f.reader.ttl(f.prefix + claim.key) > 604790)
  assert.deepEqual(await f.reader.sMembers(f.prefix + 'agent:bilibili-quality:v1:active'), [])
})
test('restart recovery makes all pending operations unknown without replay or credential data', redisTest, async t => {
  const f = await fixture(t), b = binding(), claim = await f.store.claim(b, 'login-source', HASH)
  await f.store.begin(claim, 'operation'); await f.store.finish(claim, 'operation', 'sent'); await f.store.begin(claim, 'qr')
  await f.restart().recover()
  const raw = JSON.parse(await f.reader.get(f.prefix + claim.key)); assert.equal(raw.state, 'unknown'); assert.equal(raw.effects.operation, 'sent'); assert.equal(raw.effects.qr, 'unknown')
  assert.equal(await f.store.current(claim), false); assert.equal(await f.store.claim(b, 'login-source', HASH), undefined)
  await assert.rejects(f.store.finish(claim, 'qr', 'sent'))
  assert.deepEqual(Object.keys(raw).sort(), ['createdAt', 'effects', 'fingerprint', 'owner', 'state', 'version'])
})
test('whitelist dynamic overrides persist deletion of static seed across revision changes and recreation', redisTest, async t => {
  const f = await fixture(t), b = binding(), seed = [who('seed')], claim = await f.store.claim(b, 'delete', HASH)
  assert.deepEqual(await f.store.users(b, seed), seed)
  await f.store.update(b, claim, seed, false); await f.store.settle(claim, 'sent')
  assert.deepEqual(await f.restart().users({ ...b, revision: 'r2' }, seed), [])
  const next = await f.store.claim(b, 'add', HASH); await f.store.update(b, next, [who('other')], true)
  assert.deepEqual(await f.store.users(b, seed), [who('other')])
  assert.deepEqual(await f.store.users({ ...b, agentId: 'bob' }, seed), seed)
})
test('whitelist mutations CAS-merge concurrent owners and reject stale claims or foreign users', redisTest, async t => {
  const f = await fixture(t), b = binding(), a = await f.store.claim(b, 'a', HASH), c = await f.store.claim(b, 'c', HASH)
  await Promise.all([f.store.update(b, a, [who('one')], true), f.store.update(b, c, [who('two')], true)])
  assert.deepEqual((await f.store.users(b, [])).map(user => user.id).sort(), ['one', 'two'])
  await assert.rejects(f.store.update(b, a, [{ ...who(), namespace: 'foreign' }], true)); await assert.rejects(f.store.update(b, a, [who('robot')], true))
  await f.store.settle(a, 'failed'); await assert.rejects(f.store.update(b, a, [who('late')], true))
})
test('full account, namespace, group, Agent and binding generation isolate command attempts', redisTest, async t => {
  const f = await fixture(t), b = binding(); assert.ok(await f.store.claim(b, 'same-message', HASH))
  const variants = [{ ...b, revision: 'r2' }, { ...b, agentId: 'bob' }, binding({ target: { ...b.target, id: 'other-room' } }),
    binding({ target: { ...b.target, account: who('other-bot') } }), binding({ target: { ...b.target, account: { ...who('robot'), namespace: 'other' } } })]
  for (const selected of variants) assert.ok(await f.store.claim(selected, 'same-message', HASH))
  const privateBinding = binding({ target: { ...b.target, kind: 'private', id: 'human' } }); assert.ok(await f.store.claim(privateBinding, 'same-message', HASH))
  await assert.rejects(f.store.users(privateBinding, []))
})
test('closed records, corrupted Redis types and storage failure cannot grant in-memory permission', redisTest, async t => {
  const f = await fixture(t), b = binding(), claim = await f.store.claim(b, 'corrupt', HASH)
  await f.reader.set(f.prefix + claim.key, '{"state":"sent","url":"https://secret.invalid"}'); await assert.rejects(f.store.recover())
  await f.reader.del(f.prefix + 'agent:bilibili-quality:v1:active'); await f.reader.rPush(f.prefix + 'agent:bilibili-quality:v1:active', 'corrupt')
  await assert.rejects(f.store.claim(b, 'new', HASH)); await assert.rejects(f.store.recover())
  const broken = createAgentBilibiliQualityStore({ get: async () => { throw Error('offline') }, eval: async () => { throw Error('offline') } })
  await assert.rejects(broken.claim(b, 'new', HASH)); await assert.rejects(broken.users(b, [who()])); assert.equal(await broken.current(claim), false)
})
