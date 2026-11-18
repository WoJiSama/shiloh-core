import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { createAgentOutboundMessages } = await load('modules/runtime/infrastructure/agentOutboundMessages.js')
const account = { platform: 'fixture', namespace: 'outbound', id: 'bot' }
const target = { account, kind: 'group', id: 'room' }
const binding = { source: 'configured', id: 'binding-id', revision: 'v1', agentId: 'role', personaId: 'shared', connectionId: 'connection', target }
const redisTest = { skip: !redisAvailable, timeout: 12_000 }

test('confirmed outbound ownership survives recreation, expires in seven days, and stores no identity or text', redisTest, async t => {
  const f = await createAgentRedisFixture(t, 'outbound-ownership'), store = createAgentOutboundMessages(f.storage)
  assert.equal(await store.owns(binding, 'private-receipt'), false)
  await store.remember(binding, 'private-receipt')
  assert.equal(await createAgentOutboundMessages(f.storage).owns(binding, 'private-receipt'), true)
  const keys = await f.reader.keys(f.prefix + 'agent:outbound:v1:*')
  assert.equal(keys.length, 1); assert.doesNotMatch(keys[0], /binding-id|private-receipt|room|shared|outbound:bot/u)
  assert.equal(await f.reader.get(keys[0]), '1')
  const ttl = await f.reader.ttl(keys[0]); assert.ok(ttl >= 604790 && ttl <= 604800)
  await f.reader.expire(keys[0], 10)
  await store.remember(binding, 'private-receipt')
  assert.ok(await f.reader.ttl(keys[0]) <= 10, 'a repeated receipt must not extend the ownership window')
  await f.reader.del(keys[0]); assert.equal(await store.owns(binding, 'private-receipt'), false)
})

test('ownership isolates the full binding, account, namespace, conversation kind and receipt ID', redisTest, async t => {
  const f = await createAgentRedisFixture(t, 'outbound-isolation'), store = createAgentOutboundMessages(f.storage)
  await store.remember(binding, 'receipt')
  for (const field of ['source', 'id', 'revision', 'agentId', 'personaId', 'connectionId']) {
    assert.equal(await store.owns({ ...binding, [field]: field === 'source' ? 'legacy' : 'other' }, 'receipt'), false, field)
  }
  for (const other of [{ ...target, id: 'other' }, { ...target, kind: 'private' },
    { ...target, account: { ...account, id: 'other' } }, { ...target, account: { ...account, namespace: 'other' } },
    { ...target, account: { ...account, platform: 'other' } }]) assert.equal(await store.owns({ ...binding, target: other }, 'receipt'), false)
  assert.equal(await store.owns(binding, 'other-receipt'), false)
})

test('corrupt and wrong-type storage never creates recall ownership', redisTest, async t => {
  const f = await createAgentRedisFixture(t, 'outbound-corrupt'), store = createAgentOutboundMessages(f.storage)
  await store.remember(binding, 'receipt')
  const [key] = await f.reader.keys(f.prefix + 'agent:outbound:v1:*')
  await f.reader.set(key, '{"confirmed":true}')
  assert.equal(await store.owns(binding, 'receipt'), false)
  await assert.rejects(store.remember(binding, 'receipt'))
  await f.reader.del(key); await f.reader.rPush(key, '1')
  await assert.rejects(store.owns(binding, 'receipt')); await assert.rejects(store.remember(binding, 'receipt'))
})
