import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'
const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const { createAgentPixivSessionStore } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/media/infrastructure/agentPixivSessionStore.js')).href)
const { conversationAddressKey } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/runtime/domain/agentBindings.js')).href)
const redisTest = { skip: !redisAvailable, timeout: 15000 }, NOW = 1_800_000_000_000
function binding(overrides = {}) {
  const target = { account: { platform: 'qq', namespace: 'global', id: 'robot' }, kind: 'group', id: 'room' }
  return { source: 'configured', id: conversationAddressKey(target), target, agentId: 'alice', personaId: 'daily', revision: 'r1', connectionId: 'qq-main', ...overrides }
}
const source = (messageId = 'request-1', user = 'human-1') => ({ messageId, author: { platform: 'qq', namespace: 'global', id: user } })
const data = (id = '126649495') => ({ mode: 'artworks', order: 'popular', orderSource: 'rerank', total: 24,
  items: [{ id, title: '插画作品', userName: '画师', pageCount: 5, xRestrict: 0, bookmarkCount: 120 }] })
async function fixture(t) {
  const redis = await createAgentRedisFixture(t, 'pixiv-session-test'); let now = NOW
  return { ...redis, store: createAgentPixivSessionStore(redis.storage, { now: () => now }), advance(ms) { now += ms },
    restart() { return createAgentPixivSessionStore(redis.storage, { now: () => now }) }, async raw() {
      const result = []; for (const key of (await redis.reader.keys(redis.prefix + 'agent:pixiv-tools:v1:*')).sort()) result.push([key, await redis.reader.get(key)])
      return JSON.stringify(result)
    } }
}
test('single-slot search generations prevent late saves and old downloads from refreshing a new list', redisTest, async t => {
  const f = await fixture(t), b = binding(), a = await f.store.begin(b, source()), first = await f.store.save(a, data())
  const next = await f.store.begin(b, source('request-2', 'human-2'))
  assert.equal(await f.store.load(b), undefined, 'starting a search immediately replaces the old slot')
  assert.equal(await f.store.save(a, data()), undefined); assert.equal(await f.store.touch(first), false)
  const second = await f.store.save(next, data('126649496'))
  assert.deepEqual(await f.restart().load(b), second)
  await f.store.discard(a); assert.deepEqual(await f.store.load(b), second)
  assert.equal(await f.store.current(a), false); assert.equal(await f.store.current(next), true)
})
test('five-minute expiry is absolute until a confirmed download explicitly touches the same session', redisTest, async t => {
  const f = await fixture(t), b = binding(), ticket = await f.store.begin(b, source()), session = await f.store.save(ticket, data())
  f.advance(299999); assert.deepEqual(await f.store.load(b), session); assert.equal(await f.store.touch(session), true)
  const touched = await f.store.load(b); assert.equal(touched.savedAt, NOW + 299999)
  assert.equal(await f.store.touch(session), false, 'stale snapshots cannot refresh twice')
  f.advance(300000); assert.equal(await f.store.load(b), undefined); assert.equal(await f.store.touch(touched), false)
})
test('complete account, namespace, conversation, agent, persona and revision scope isolate sessions', redisTest, async t => {
  const f = await fixture(t), b = binding(), ticket = await f.store.begin(b, source()); await f.store.save(ticket, data())
  const variants = [binding({ agentId: 'other' }), binding({ personaId: 'other' }), binding({ revision: 'r2' }), binding({ connectionId: 'other' }), binding()]
  variants[4].target = { ...variants[4].target, account: { ...variants[4].target.account, id: 'other-robot' } }
  for (const [field, value] of [['namespace', 'other'], ['platform', 'other']]) {
    const selected = binding(); selected.target = { ...selected.target, account: { ...selected.target.account, [field]: value } }; variants.push(selected)
  }
  variants.push(binding({ target: { ...b.target, id: 'other-room' } }), binding({ target: { ...b.target, kind: 'private' } }))
  for (const selected of variants) assert.equal(await f.store.load(selected), undefined)
  assert.equal((await f.store.load(b)).source.author.id, 'human-1', 'the slot belongs to the group, not the selecting user')
})
test('session writes are closed and bounded and never accept query, URL, image bytes or credentials', redisTest, async t => {
  const f = await fixture(t), ticket = await f.store.begin(binding(), source())
  for (const value of [{ ...data(), keyword: 'private query' }, { ...data(), url: 'https://private' },
    { ...data(), items: [{ ...data().items[0], thumbUrl: 'https://private' }] }, { ...data(), items: [{ ...data().items[0], base64: 'secret' }] },
    { ...data(), items: [{ ...data().items[0], id: '0123' }] }, { ...data(), items: Array(21).fill(data().items[0]) },
    { ...data(), items: [data().items[0], data().items[0]] }]) await assert.rejects(f.store.save(ticket, value))
  let touched = false
  const malicious = { ...data(), get items() { touched = true; return data().items } }
  await assert.rejects(f.store.save(ticket, malicious)); assert.equal(touched, false)
  await f.store.save(ticket, data()); const raw = await f.raw()
  for (const value of ['keyword', 'thumbUrl', 'base64', 'https:', 'private query']) assert.equal(raw.includes(value), false)
})
test('attempt markers persist before send and block pending, unknown, failed and sent requests after restart', redisTest, async t => {
  const f = await fixture(t), b = binding()
  for (const state of ['pending', 'sent', 'failed', 'unknown']) {
    const messageId = 'attempt-' + state, claimed = await f.store.claimAttempt(b, messageId, 'download')
    assert.ok(claimed.attempt)
    if (state !== 'pending') await f.store.finishAttempt(claimed.attempt, state)
    const result = await f.restart().claimAttempt(b, messageId, 'download')
    assert.equal(result.attempt, undefined); assert.equal(result.state, state)
    assert.ok((await f.store.claimAttempt(b, messageId, 'search')).attempt, 'tool kinds have separate attempts')
  }
  const attempts = await f.reader.keys(f.prefix + 'agent:pixiv-tools:v1:attempt:*')
  assert.equal(attempts.length, 8)
  for (const key of attempts) { assert.ok(await f.reader.ttl(key) > 604790); assert.deepEqual(Object.keys(JSON.parse(await f.reader.get(key))).sort(), ['createdAt', 'state', 'version']) }
})
test('atomic start, save and attempt claims fail closed on corrupt Redis key types and storage failures', redisTest, async t => {
  const f = await fixture(t), b = binding(), ticket = await f.store.begin(b, source())
  const key = (await f.reader.keys(f.prefix + 'agent:pixiv-tools:v1:generation:*'))[0]
  await f.reader.del(key); await f.reader.rPush(key, 'corrupt')
  await assert.rejects(f.store.begin(b, source('new'))); await assert.rejects(f.store.save(ticket, data()))
  const broken = createAgentPixivSessionStore({ async get() { throw Error('offline') }, async eval() { throw Error('offline') } })
  await assert.rejects(broken.begin(b, source())); await assert.rejects(broken.load(b)); await assert.rejects(broken.claimAttempt(b, 'request', 'search'))
})
