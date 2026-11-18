import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'
const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const load = name => import(pathToFileURL(path.join(release, 'dist/backend', name)).href)
const { createAgentVideoSearchStore } = await load('modules/media/infrastructure/agentVideoSearchStore.js')
const { conversationAddressKey } = await load('modules/runtime/domain/agentBindings.js')
const redisTest = { skip: !redisAvailable, timeout: 15000 }, NOW = 1_800_000_000_000
function binding(overrides = {}) {
  const target = overrides.target ?? { account: { platform: 'qq', namespace: 'global', id: 'robot' }, kind: 'group', id: 'room' }
  return { source: 'configured', target, agentId: 'alice', personaId: 'daily', revision: 'r1', connectionId: 'qq-main', ...overrides, id: conversationAddressKey(target) }
}
const source = (messageId = 'search-1', user = 'human-1') => ({ messageId, author: { platform: 'qq', namespace: 'global', id: user } })
const card = (index = 0, overrides = {}) => {
  const id = 'BV1xx411c7m' + String.fromCharCode(68 + index)
  return { provider: 'bilibili', id, title: '公开视频' + (index + 1), author: '作者', durationSeconds: 60 + index, pageUrl: `https://www.bilibili.com/video/${id}`, ...overrides }
}
async function fixture(t) {
  const redis = await createAgentRedisFixture(t, 'video-search-store'); let now = NOW
  const options = { now: () => now, allowsText: text => !text.includes('HOST_PRIVATE') }
  return { ...redis, store: createAgentVideoSearchStore(redis.storage, options), advance(ms) { now += ms },
    restart() { return createAgentVideoSearchStore(redis.storage, options) }, async raw() {
      const rows = []; for (const key of (await redis.reader.keys(redis.prefix + 'agent:video-search:v1:*')).sort()) rows.push([key, await redis.reader.get(key)])
      return JSON.stringify(rows)
    } }
}
test('one search generation immediately invalidates the prior list and fences late saves and discards', redisTest, async t => {
  const f = await fixture(t), b = binding(), first = await f.store.begin(b, source()), saved = await f.store.save(first, [card()])
  assert.deepEqual(await f.restart().load(b), saved)
  const next = await f.store.begin(b, source('search-2', 'human-2'))
  assert.equal(await f.store.load(b), undefined); assert.equal(await f.store.current(saved), false)
  assert.equal(await f.store.save(first, [card(1)]), undefined)
  const second = await f.store.save(next, [card(1)])
  await f.store.discard(first); assert.deepEqual(await f.store.load(b), second)
  assert.equal(await f.store.current(first), false); assert.equal(await f.store.current(second), true)
})
test('list expiry is absolute at five minutes and cannot be extended by reading or selecting it', redisTest, async t => {
  const f = await fixture(t), b = binding(), ticket = await f.store.begin(b, source()), saved = await f.store.save(ticket, [card()])
  f.advance(299999); assert.deepEqual(await f.store.load(b), saved); assert.equal(await f.store.current(saved), true)
  f.advance(1); assert.equal(await f.store.load(b), undefined); assert.equal(await f.store.current(saved), false)
  const key = (await f.reader.keys(f.prefix + 'agent:video-search:v1:session:*'))[0]
  assert.ok(await f.reader.pTTL(key) <= 300000)
})
test('account, namespace, platform, conversation, Agent and binding generations isolate lists and claims', redisTest, async t => {
  const f = await fixture(t), b = binding(), ticket = await f.store.begin(b, source()); await f.store.save(ticket, [card()])
  const original = await f.store.claimShare(b, source('share-1')); assert.ok(original.attempt)
  const variants = ['agentId', 'personaId', 'revision', 'connectionId'].map(key => binding({ [key]: 'other' }))
  for (const [key, value] of [['id', 'other-bot'], ['namespace', 'other'], ['platform', 'other']]) {
    variants.push(binding({ target: { ...b.target, account: { ...b.target.account, [key]: value } } }))
  }
  variants.push(binding({ target: { ...b.target, id: 'other-room' } }), binding({ target: { ...b.target, kind: 'private' } }))
  for (const selected of variants) {
    assert.equal(await f.store.load(selected), undefined)
    const currentSource = { ...source('share-1'), author: { ...source().author, platform: selected.target.account.platform, namespace: selected.target.account.namespace } }
    assert.ok((await f.store.claimShare(selected, currentSource)).attempt)
  }
  assert.equal((await f.store.load(b)).source.author.id, 'human-1')
  assert.equal((await f.store.claimShare(b, source('share-1'))).attempt, undefined)
})
test('stored lists accept only bounded public card metadata and never execute accessors or proxies', redisTest, async t => {
  const f = await fixture(t), ticket = await f.store.begin(binding(), source())
  for (const items of [[card(0, { keyword: 'private query' })], [card(0, { thumbnail: 'https://private.invalid/pic' })],
    [card(0, { pageUrl: card().pageUrl + '?token=HOST_PRIVATE' })], [card(0, { title: 'HOST_PRIVATE' })],
    [card(), card()], Array.from({ length: 9 }, (_, index) => card(index)), [card(0, { provider: 'other' })]]) await assert.rejects(f.store.save(ticket, items))
  let touched = 0
  const accessor = { ...card(), get title() { touched++; return 'unsafe' } }, proxy = new Proxy(card(), { get() { touched++; return undefined } })
  await assert.rejects(f.store.save(ticket, [accessor])); await assert.rejects(f.store.save(ticket, [proxy])); assert.equal(touched, 0)
  const items = [card()]; items.keyword = 'private query'; await assert.rejects(f.store.save(ticket, items))
  await f.store.save(ticket, [card()]); const raw = await f.raw()
  for (const text of ['keyword', 'thumbnail', 'HOST_PRIVATE', 'private query', 'base64']) assert.equal(raw.includes(text), false)
})
test('durable pending, sent, failed and unknown claims never grant a second send after recreation', redisTest, async t => {
  const f = await fixture(t), b = binding()
  for (const state of ['pending', 'sent', 'failed', 'unknown']) {
    const original = source('share-' + state), claim = await f.store.claimShare(b, original); assert.ok(claim.attempt)
    if (state !== 'pending') await f.store.finishShare(claim.attempt, state)
    const duplicate = await f.restart().claimShare(b, original)
    assert.equal(duplicate.attempt, undefined); assert.equal(duplicate.state, state)
  }
  const keys = await f.reader.keys(f.prefix + 'agent:video-search:v1:share:*'); assert.equal(keys.length, 4)
  for (const key of keys) {
    assert.ok(await f.reader.ttl(key) > 604790)
    assert.deepEqual(Object.keys(JSON.parse(await f.reader.get(key))).sort(), ['createdAt', 'owner', 'state', 'version'])
  }
})
test('a pending record from another process becomes unknown and cannot be settled by the old owner', redisTest, async t => {
  const f = await fixture(t), b = binding(), original = source('before-restart'), claim = await f.store.claimShare(b, original)
  const key = f.prefix + claim.attempt.key, raw = JSON.parse(await f.reader.get(key))
  await f.reader.set(key, JSON.stringify({ ...raw, owner: '00000000-0000-0000-0000-000000000000' }), { KEEPTTL: true })
  const duplicate = await f.restart().claimShare(b, original)
  assert.equal(duplicate.state, 'unknown'); assert.equal(duplicate.attempt, undefined)
  assert.equal(JSON.parse(await f.reader.get(key)).state, 'unknown')
  await assert.rejects(f.store.finishShare(claim.attempt, 'sent'))
})
test('corrupt Redis types, malformed stored metadata and unavailable storage fail closed', redisTest, async t => {
  const f = await fixture(t), b = binding(), ticket = await f.store.begin(b, source()); await f.store.save(ticket, [card()])
  const sessionKey = (await f.reader.keys(f.prefix + 'agent:video-search:v1:session:*'))[0]
  await f.reader.set(sessionKey, '{"version":1,"secret":"HOST_PRIVATE"}'); await assert.rejects(f.store.load(b))
  const generationKey = (await f.reader.keys(f.prefix + 'agent:video-search:v1:generation:*'))[0]
  await f.reader.del(generationKey); await f.reader.rPush(generationKey, 'corrupt')
  await assert.rejects(f.store.begin(b, source('new'))); await assert.rejects(f.store.save(ticket, [card()])); await assert.rejects(f.store.current(ticket))
  const broken = createAgentVideoSearchStore({ async get() { throw Error('offline HOST_PRIVATE') }, async eval() { throw Error('offline HOST_PRIVATE') } })
  await assert.rejects(broken.begin(b, source())); await assert.rejects(broken.load(b)); await assert.rejects(broken.claimShare(b, source()))
})
