import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const { createAgentSemanticMemoryStore, agentSemanticMemoryId } = await load('modules/memory/infrastructure/agentSemanticMemoryStore.js')
const { createAgentSemanticMemory } = await load('modules/memory/infrastructure/agentSemanticMemory.js')
const { semanticCleanupSelector } = await load('modules/memory/infrastructure/agentSemanticMemoryCleanup.js')
const { createPersonMemoryStore } = await load('modules/memory/infrastructure/personMemoryStore.js')
const { conversationAddressKey, agentBindingToken } = await load('modules/runtime/domain/agentBindings.js')
const redisTest = { skip: !redisAvailable, timeout: 20_000 }, prefix = 'agent:semantic-memory:v1', fenceKey = prefix + ':cleanup', catalogKey = prefix + ':catalog'
const stateKey = id => prefix + ':state:' + id, providerId = 'a'.repeat(64), epoch = Date.now()
const account = { platform: 'fixture', namespace: 'cleanup-space', id: 'account-a' }
const deferred = () => Promise.withResolvers()
async function wait(check) { for (let i = 0; i < 300; i++) { const value = await check(); if (value) return value; await delay(5) } assert.fail('cleanup fixture did not reach expected boundary') }
function scope({ agentId = 'writer', account: selected = account, id = 'room-a', kind = 'group' } = {}) { return { agentId, target: { account: selected, kind, id } } }
function row(id = 'old-row', overrides = {}) { return { messageId: id, authorId: 'subject-a', name: '本人', text: 'orchard original ' + id, at: epoch, ...overrides } }
function state(selected = scope(), rows = [row()]) { return { version: 1, id: agentSemanticMemoryId(selected), scope: selected, rows } }
function guard() { const controller = new AbortController(); return { controller, signal: controller.signal, isCurrent: () => !controller.signal.aborted, async ensureCurrent() { controller.signal.throwIfAborted() } } }
const selector = (overrides = {}) => ({ agentId: 'writer', account, subjectId: 'subject-a', through: epoch, ...overrides })
async function fixture(t, name, wrapped) {
  const redis = await createAgentRedisFixture(t, name), storage = wrapped ? wrapped(redis.storage) : redis.storage
  return { ...redis, storage, store: createAgentSemanticMemoryStore(storage),
    raw: key => redis.reader.get(redis.prefix + key), set: (key, value) => redis.reader.set(redis.prefix + key, value) }
}
async function runtime(t, f, options = {}) {
  const bindings = new Map(), requests = [], now = epoch + 10_000
  const bind = selected => { const binding = { ...selected, source: 'configured', id: conversationAddressKey(selected.target), revision: 'v1', personaId: 'same-template', connectionId: 'connection-' + selected.target.account.id }; bindings.set(conversationAddressKey(selected.target), binding); return binding }
  const binding = bind(scope()), config = { enabled: options.enabled !== false, topK: 5, timeoutMs: 5000 }
  const ports = { redis: f.storage, memory: createPersonMemoryStore({ redis: f.storage, now: () => now }), config: () => config,
    backend: { id: providerId, async embed(texts, context) { const call = { texts, context }; requests.push(call); return options.embed ? options.embed(call) : texts.map(() => [1, 0]) } },
    resolve: target => { const binding = bindings.get(conversationAddressKey(target)); return binding && { binding } },
    available: () => true, privatePeer: target => target.kind === 'private' ? target.id : undefined,
    async isRecalled() { return false }, async begin(selected) { const owner = guard(); return { signal: owner.signal, isCurrent: () => !owner.signal.aborted && agentBindingToken(bindings.get(conversationAddressKey(selected.target))) === agentBindingToken(selected), release() {} } },
    isRunning: () => true, allowsText: () => true, logger: { warn() {} }, now: () => now, ...options.ports }
  const api = createAgentSemanticMemory(ports); t.after(() => api.stop())
  return { api, binding, bind, bindings, requests, config, ports,
    incoming(value = row(), selected = binding) { return { version: 1, conversation: selected.target, sender: { ...selected.target.account, id: value.authorId }, senderName: value.name,
      messageId: value.messageId, occurredAt: value.at, text: value.text, parts: [{ kind: 'text', text: value.text }], mentions: [], directedToAccount: false } } }
}

test('purge physically removes bounded original rows and vectors, retires last-row partitions and preserves fresh or unrelated scopes', redisTest, async t => {
  const f = await fixture(t, 'semantic-cleanup-physical')
  const selected = state(scope(), [row('old', { vector: [1, 0], providerId }), row('fresh', { at: epoch + 1 }), row('other', { authorId: 'subject-b', vector: [0, 1], providerId })])
  const retired = state(scope({ id: 'unbound-old-room' }), [row('retired', { vector: [1, 0], providerId })])
  const otherAgent = state(scope({ agentId: 'research' })), otherAccount = state(scope({ account: { ...account, id: 'account-b' } }))
  for (const value of [selected, retired, otherAgent, otherAccount]) await f.store.update(value.id, () => value)
  const live = await runtime(t, f, { enabled: false, ports: { backend: undefined, resolve() { throw Error('cleanup must not resolve live binding') }, available: () => false } })
  const receipt = await live.api.purgeSubject(selector(), guard())
  assert.deepEqual(receipt, { usage: 'blocked', cleanup: 'completed', removedRows: 2, removedVectors: 2, removedPartitions: 1 })
  assert.equal(await f.raw(stateKey(retired.id)), null)
  assert.deepEqual(JSON.parse(await f.raw(stateKey(selected.id))).rows, selected.rows.slice(1))
  for (const value of [otherAgent, otherAccount]) assert.deepEqual(JSON.parse(await f.raw(stateKey(value.id))), value)
  const catalog = JSON.parse(await f.raw(catalogKey)); assert.equal(catalog.entries.length, 3); assert.equal(catalog.entries.some(entry => entry.id === retired.id), false)
  const fence = await f.raw(fenceKey); assert.equal(fence.includes('subject-a'), false); assert.equal(fence.includes('account-a'), false)
  const restarted = createAgentSemanticMemoryStore(f.storage)
  await restarted.update(retired.id, () => retired); assert.equal(await f.raw(stateKey(retired.id)), null)
  const replay = await restarted.purgeSubject(selector({ through: epoch - 1 }), guard()); assert.equal(replay.removedRows, 0)
  assert.deepEqual(JSON.parse(await f.raw(stateKey(selected.id))).rows, selected.rows.slice(1))
})

test('full target purge isolates conversation kinds and accounts while omitted target covers only this Agent and account subject', redisTest, async t => {
  const f = await fixture(t, 'semantic-cleanup-target')
  const a = state(), b = state(scope({ id: 'room-b' })), c = state(scope({ kind: 'channel' })), d = state(scope({ account: { ...account, namespace: 'other-space' } }))
  for (const value of [a, b, c, d]) await f.store.update(value.id, () => value)
  assert.equal((await f.store.purgeSubject(selector({ target: a.scope.target }), guard())).removedRows, 1)
  assert.equal(await f.raw(stateKey(a.id)), null)
  for (const value of [b, c, d]) assert.deepEqual(JSON.parse(await f.raw(stateKey(value.id))), value)
  assert.equal((await f.store.purgeSubject(selector(), guard())).removedRows, 2); assert.deepEqual(JSON.parse(await f.raw(stateKey(d.id))), d)
})

test('an old update snapshot conflicts with a concurrent durable fence and cannot restore the deleted text or vector', redisTest, async t => {
  const gate = deferred(), arrived = deferred(); let blocked = true
  const f = await fixture(t, 'semantic-cleanup-cas'), original = state(); await f.store.update(original.id, () => original)
  const stale = createAgentSemanticMemoryStore({ get: f.storage.get, async eval(script, options) {
    const result = await f.storage.eval(script, options)
    if (blocked && options.keys.includes(stateKey(original.id)) && !script.includes("redis.call('SET'")) { blocked = false; arrived.resolve(); await gate.promise }
    return result
  } })
  const updating = stale.update(original.id, current => ({ ...(current ?? original), rows: [{ ...original.rows[0], vector: [1, 0], providerId }] }))
  await arrived.promise; assert.equal((await f.store.purgeSubject(selector(), guard())).cleanup, 'completed')
  gate.resolve(); assert.equal(await updating, true); assert.equal(await f.raw(stateKey(original.id)), null)
})

test('physical IO failure returns unknown only after publication, while reads and recreated updates enforce the durable watermarks', redisTest, async t => {
  let failState = false
  const f = await fixture(t, 'semantic-cleanup-unknown', storage => ({ get: storage.get, async eval(script, options) {
    if (failState && options.keys.some(key => key.startsWith(prefix + ':state:'))) throw Error('fixture physical read/write failed')
    return storage.eval(script, options)
  } })), original = state(scope(), [row('old', { vector: [1, 0], providerId })])
  await f.store.update(original.id, () => original); failState = true
  const receipt = await f.store.purgeSubject(selector(), guard()); assert.equal(receipt.cleanup, 'unknown'); assert.equal(receipt.usage, 'blocked')
  assert.ok(await f.raw(fenceKey)); assert.deepEqual(JSON.parse(await f.raw(stateKey(original.id))), original)
  failState = false
  assert.equal(await createAgentSemanticMemoryStore(f.storage).read(original.id), undefined)
  const live = await runtime(t, f); assert.equal((await live.api.read(live.binding, 'orchard', () => true)).text, ''); assert.equal(live.requests.length, 0)
  const retried = await live.api.purgeSubject(selector(), guard()); assert.equal(retried.cleanup, 'completed'); assert.equal(retried.removedRows, 1); assert.equal(await f.raw(stateKey(original.id)), null)
})

test('publication failure and async authority rejection reject without a blocked receipt or raw changes', redisTest, async t => {
  let denyPublication = false
  const f = await fixture(t, 'semantic-cleanup-publication', storage => ({ get: storage.get, async eval(script, options) {
    if (denyPublication && options.keys.includes(fenceKey) && script.includes("redis.call('SET'")) throw Error('fixture fence publication failed')
    return storage.eval(script, options)
  } })), original = state(); await f.store.update(original.id, () => original)
  const denied = guard(); denied.ensureCurrent = async () => { await delay(1); throw Error('fixture authorization denied') }
  const live = await runtime(t, f)
  await assert.rejects(() => live.api.purgeSubject(selector(), denied)); assert.equal(await f.raw(fenceKey), null); assert.deepEqual(JSON.parse(await f.raw(stateKey(original.id))), original)
  denyPublication = true
  await assert.rejects(() => live.api.purgeSubject(selector(), guard())); assert.equal(await f.raw(fenceKey), null); assert.deepEqual(JSON.parse(await f.raw(stateKey(original.id))), original)
  denyPublication = false; assert.equal((await live.api.purgeSubject(selector(), guard())).cleanup, 'completed')
})

test('cleanup authorization and stop cancellation gate physical writes and never return a completed receipt after revocation', redisTest, async t => {
  const gate = deferred(), reached = deferred(); let delayed = false
  const f = await fixture(t, 'semantic-cleanup-cancel', storage => ({ get: storage.get, async eval(script, options) {
    if (delayed && options.keys.some(key => key.startsWith(prefix + ':state:')) && !script.includes("redis.call('SET'")) { delayed = false; reached.resolve(); await gate.promise }
    return storage.eval(script, options)
  } })), original = state(); await f.store.update(original.id, () => original)
  const live = await runtime(t, f), authority = guard(); delayed = true
  const cleaning = live.api.purgeSubject(selector(), authority); await reached.promise; authority.controller.abort(); gate.resolve()
  await assert.rejects(() => cleaning); assert.deepEqual(JSON.parse(await f.raw(stateKey(original.id))), original); assert.ok(await f.raw(fenceKey))
  await live.api.stop(); await assert.rejects(() => live.api.purgeSubject(selector(), guard()))
})

test('bounded cleanup capacity rejects new selectors without evicting or advancing an old fixed timestamp', redisTest, async t => {
  const f = await fixture(t, 'semantic-cleanup-capacity'), entries = Array.from({ length: 4096 }, (_, index) => semanticCleanupSelector(selector({ subjectId: 'subject-' + index })))
  await f.set(fenceKey, JSON.stringify({ version: 1, entries }))
  const previous = await f.raw(fenceKey); await assert.rejects(() => f.store.purgeSubject(selector({ subjectId: 'new-subject' }), guard())); assert.equal(await f.raw(fenceKey), previous)
  assert.equal((await f.store.purgeSubject(selector({ subjectId: 'subject-0', through: epoch - 1 }), guard())).cleanup, 'completed'); assert.equal(await f.raw(fenceKey), previous)
})

test('an unchanged empty state remains a catalog member and every legitimate update filters only blocked rows', redisTest, async t => {
  const f = await fixture(t, 'semantic-cleanup-empty'), empty = state(scope({ id: 'empty-room' }), []), selected = state()
  await f.store.update(empty.id, () => empty); await f.store.update(selected.id, () => selected)
  await f.store.purgeSubject(selector(), guard()); assert.deepEqual(JSON.parse(await f.raw(stateKey(empty.id))), empty)
  await f.store.update(selected.id, () => state(selected.scope, [row('old-again'), row('future', { at: epoch + 1, vector: [0, 1], providerId })]))
  assert.deepEqual(JSON.parse(await f.raw(stateKey(selected.id))).rows.map(item => item.messageId), ['future'])
})

test('invalid selectors, damaged fences and lost host leases cannot publish or disguise successful cleanup', redisTest, async t => {
  const f = await fixture(t, 'semantic-cleanup-invalid'), original = state(); await f.store.update(original.id, () => original)
  for (const input of [selector({ through: -1 }), selector({ subjectId: '' }), selector({ agentId: '../bad' }), selector({ target: { ...scope().target, account: { ...account, id: 'other' } } })]) await assert.rejects(() => f.store.purgeSubject(input, guard()))
  assert.equal(await f.raw(fenceKey), null)
  await f.set(fenceKey, '{damaged'); await assert.rejects(() => f.store.purgeSubject(selector(), guard())); await assert.rejects(() => f.store.update(original.id, () => original)); await assert.rejects(() => f.store.read(original.id))
  await f.reader.del(f.prefix + fenceKey); await f.reader.set(f.prefix + 'agent:host-lease', 'lost-owner')
  await assert.rejects(() => f.store.purgeSubject(selector(), guard())); assert.equal(await f.raw(fenceKey), null); assert.deepEqual(JSON.parse(await f.raw(stateKey(original.id))), original)
})

test('an asynchronous authority rejection after publication must reject even when its synchronous observation remains true', redisTest, async t => {
  const f = await fixture(t, 'semantic-cleanup-async-revocation'), original = state()
  await f.store.update(original.id, () => original)
  const authority = guard(); let checks = 0
  authority.ensureCurrent = async () => { if (++checks === 3) throw Error('one authoritative denial') }
  await assert.rejects(() => f.store.purgeSubject(selector(), authority))
  assert.ok(await f.raw(fenceKey)); assert.deepEqual(JSON.parse(await f.raw(stateKey(original.id))), original)
})

test('durable cleanup cancels pending capture and indexing so late work cannot restore original text or a vector', redisTest, async t => {
  for (const operation of ['capture', 'index']) await t.test(operation, async t => {
    const f = await fixture(t, 'semantic-cleanup-pending-' + operation), gate = deferred(), reached = deferred(), original = state()
    let live, pending
    if (operation === 'capture') {
      const memory = createPersonMemoryStore({ redis: f.storage, now: () => epoch + 10_000 })
      const register = memory.registerSource.bind(memory)
      live = await runtime(t, f, { ports: { memory: { ...memory, async registerSource(...args) { reached.resolve(); await gate.promise; return register(...args) } } } })
      pending = live.api.capture(live.incoming(), live.binding, () => true)
      void pending.catch(() => {})
    } else {
      await f.store.update(original.id, () => original)
      live = await runtime(t, f, { embed() { reached.resolve(); return gate.promise } })
      await live.api.tick()
    }
    await reached.promise
    assert.equal((await live.api.purgeSubject(selector(), guard())).cleanup, 'completed')
    gate.resolve([[1, 0]])
    if (pending) await assert.rejects(pending)
    else await wait(() => live.requests[0].context.signal.aborted)
    await delay(10)
    assert.equal(await f.raw(stateKey(original.id)), null)
    assert.equal((await createAgentSemanticMemoryStore(f.storage).list()).length, 0)
  })
})

test('denied asynchronous cleanup authority cannot abort an ongoing index or publish its fence', redisTest, async t => {
  const f = await fixture(t, 'semantic-cleanup-denied-index'), original = state(), reached = deferred(), gate = deferred()
  await f.store.update(original.id, () => original)
  const live = await runtime(t, f, { embed() { reached.resolve(); return gate.promise } })
  await live.api.tick(); await reached.promise
  const authority = guard(); authority.ensureCurrent = async () => { await Promise.resolve(); throw Error('authorization denied') }
  await assert.rejects(() => live.api.purgeSubject(selector(), authority))
  assert.equal(await f.raw(fenceKey), null); assert.equal(live.requests[0].context.signal.aborted, false)
  await live.requests[0].context.ensureCurrent()
  gate.resolve([[1, 0]])
  await wait(async () => JSON.parse(await f.raw(stateKey(original.id))).rows[0].vector)
  assert.deepEqual(JSON.parse(await f.raw(stateKey(original.id))).rows[0].vector, [1, 0])
})

test('durable fences invalidate retained recall after unknown deletion and reject an unstored stale private query proof', redisTest, async t => {
  let failState = false
  const f = await fixture(t, 'semantic-cleanup-projections', storage => ({ get: storage.get, async eval(script, options) {
    if (failState && options.keys.some(key => key.startsWith(prefix + ':state:'))) throw Error('physical source temporarily unavailable')
    return storage.eval(script, options)
  } })), original = state(scope(), [row('old', { vector: [1, 0], providerId })])
  await f.store.update(original.id, () => original)
  const live = await runtime(t, f, { ports: { authorizePrivateSource: async () => true } })
  const retained = await live.api.read(live.binding, 'orchard', () => true)
  assert.match(retained.text, /orchard original/); assert.equal(await retained.isCurrent(), true)
  failState = true; assert.equal((await live.api.purgeSubject(selector(), guard())).cleanup, 'unknown'); failState = false
  assert.deepEqual(JSON.parse(await f.raw(stateKey(original.id))), original)
  assert.equal(await retained.isCurrent(), false)
  const fresh = state(scope(), [row('fresh', { at: epoch + 1, vector: [1, 0], providerId })])
  await f.store.update(fresh.id, () => fresh)
  const privateBinding = live.bind(scope({ kind: 'private', id: 'subject-a' })), calls = live.requests.length
  const stale = await live.api.read(privateBinding, 'orchard', () => true, undefined, [], { authorId: 'subject-a', messageId: 'unstored-query', at: epoch })
  assert.equal(stale.text, ''); assert.equal(live.requests.length, calls)
  const allowed = await live.api.read(privateBinding, 'orchard', () => true, undefined, [], { authorId: 'subject-a', messageId: 'new-query', at: epoch + 1 })
  assert.match(allowed.text, /orchard original fresh/); assert.equal(live.requests.length, calls + 1)
})
