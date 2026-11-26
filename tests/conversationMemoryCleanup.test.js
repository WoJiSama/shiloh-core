import assert from 'node:assert/strict'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const { createConversationMemoryStore, conversationMemoryId } = await load('modules/memory/infrastructure/conversationMemoryStore.js')
const { conversationCleanupSelector } = await load('modules/memory/infrastructure/conversationMemoryCleanup.js')
const { personMemoryAddress } = await load('modules/memory/infrastructure/personMemoryContext.js')
const { agentBindingToken, agentPersonaScopeId, conversationAddressKey } = await load('modules/runtime/domain/agentBindings.js')
const settings = { skip: !redisAvailable, timeout: 20_000 }
const prefix = 'agent:conversation-memory:v1', catalogKey = prefix + ':catalog', fenceKey = prefix + ':cleanup'
const stateKey = id => prefix + ':state:' + id, epoch = Date.now()
const account = { platform: 'fixture', namespace: 'conversation-cleanup', id: 'account-a' }
const deferred = () => Promise.withResolvers()
function scope({ agentId = 'daily', account: selected = account, kind = 'group', id = 'room-a' } = {}) { return { agentId, target: { account: selected, kind, id } } }
function record(seq = 1, overrides = {}) { return { seq, messageId: 'message-' + seq, authorId: 'subject-a', name: '本人', text: 'original text ' + seq, at: epoch, ...overrides } }
function state(selected = scope(), records = [record()], extras = {}) {
  const binding = { ...selected, source: 'configured', id: conversationAddressKey(selected.target), revision: 'v1', personaId: 'shared', connectionId: 'connection-a' }
  return { version: 1, id: conversationMemoryId(selected), scope: selected, binding, token: agentBindingToken(binding),
    nextSeq: Math.max(0, ...records.map(row => row.seq)) + 1, records, episodes: [], dueAt: 0, attempts: 0, retryAt: 0, ...extras }
}
function episode(selected = scope(), id = 'episode-a', extras = {}) {
  return { id, at: epoch, userId: 'subject-b', userName: '另一个人', summary: 'mixed historical summary mentioning subject-a', reply: 'historic reply',
    source: { botId: personMemoryAddress(selected.target).botId, personaId: agentPersonaScopeId(selected.agentId), personaVersion: 'old-persona', personaName: 'old-name' },
    messageIds: ['message-1'], replyIds: ['sent-a'], invalidatedAt: 0, ...extras }
}
const summary = extras => ({ text: 'mixed rolling summary mentioning subject-a', updatedAt: epoch, coveredSeq: 1, invalidatedAt: 0, ...extras })
const selector = (extras = {}) => ({ account, agentId: 'daily', subjectId: 'subject-a', through: epoch, ...extras })
function guard() { const controller = new AbortController(); return { controller, signal: controller.signal, isCurrent: () => !controller.signal.aborted, async ensureCurrent() { controller.signal.throwIfAborted() } } }
async function fixture(t, name, wrap) {
  const redis = await createAgentRedisFixture(t, name), storage = wrap ? wrap(redis.storage) : redis.storage
  return { ...redis, storage, store: createConversationMemoryStore(storage), raw: key => redis.reader.get(redis.prefix + key),
    set: (key, value) => redis.reader.set(redis.prefix + key, value) }
}

test('whole-subject purge physically deletes inclusive original records and all legacy aggregates without guessing episode authors', settings, async t => {
  const f = await fixture(t, 'conversation-cleanup-physical')
  const selected = state(scope(), [record(), record(2, { at: epoch + 1 }), record(3, { authorId: 'subject-b' })], { summary: summary(), episodes: [episode(), episode(scope(), 'episode-b', { userId: undefined })] })
  const retired = state(scope({ id: 'unbound-room' }), [record()], { summary: summary(), episodes: [episode(scope({ id: 'unbound-room' }))] })
  const otherAgent = state(scope({ agentId: 'other' }), [record()], { summary: summary() })
  const otherAccount = state(scope({ account: { ...account, id: 'account-b' } }))
  for (const value of [selected, retired, otherAgent, otherAccount]) await f.store.update(value.id, () => value)
  assert.deepEqual(await f.store.purgeSubject(selector(), guard()), { usage: 'blocked', cleanup: 'completed', removedRecords: 2, removedSummaries: 2, removedEpisodes: 3, removedPartitions: 1 })
  const physical = JSON.parse(await f.raw(stateKey(selected.id)))
  assert.deepEqual(physical.records, selected.records.slice(1)); assert.equal(physical.summary, undefined); assert.deepEqual(physical.episodes, [])
  assert.equal(await f.raw(stateKey(retired.id)), null)
  assert.deepEqual(JSON.parse(await f.raw(catalogKey)).ids.sort(), [selected.id, otherAgent.id, otherAccount.id].sort())
  for (const value of [otherAgent, otherAccount]) assert.deepEqual(JSON.parse(await f.raw(stateKey(value.id))), value)
  const fence = await f.raw(fenceKey); assert.equal(fence.includes('subject-a'), false); assert.equal(fence.includes('account-a'), false)
})

test('full target selectors isolate kind and complete account while omitted targets cover old unbound partitions only under their Agent', settings, async t => {
  const f = await fixture(t, 'conversation-cleanup-target')
  const values = [state(), state(scope({ kind: 'channel' })), state(scope({ id: 'room-b' })), state(scope({ account: { ...account, namespace: 'elsewhere' } }))]
  for (const value of values) await f.store.update(value.id, () => value)
  assert.equal((await f.store.purgeSubject(selector({ target: values[0].scope.target }), guard())).removedRecords, 1)
  assert.equal(await f.raw(stateKey(values[0].id)), null)
  for (const value of values.slice(1)) assert.deepEqual(JSON.parse(await f.raw(stateKey(value.id))), value)
  assert.equal((await f.store.purgeSubject(selector(), guard())).removedRecords, 2)
  assert.deepEqual(JSON.parse(await f.raw(stateKey(values[3].id))), values[3])
})

test('scope cleanup tokens depend only on sorted effective subject cutoffs and preserve newly rebuilt aggregates on old or equivalent replay', settings, async t => {
  const f = await fixture(t, 'conversation-cleanup-generation'), selected = state(scope(), [record(1, { at: epoch + 1 })])
  await f.store.update(selected.id, () => selected)
  assert.equal(await f.store.cleanupToken(selected.scope), undefined)
  await f.store.purgeSubject(selector(), guard())
  const token = await f.store.cleanupToken(selected.scope); assert.match(token, /^[a-f0-9]{64}$/u)
  assert.equal(await f.store.cleanupToken(scope({ agentId: 'other' })), undefined)
  await f.store.update(selected.id, current => ({ ...current, dueCleanupToken: token, summary: summary({ cleanupToken: token }), episodes: [episode(selected.scope, 'rebuilt', { cleanupToken: token })] }))
  assert.equal((await f.store.load(selected.id)).dueCleanupToken, token)
  const rebuilt = await f.raw(stateKey(selected.id)), fence = await f.raw(fenceKey)
  assert.equal((await f.store.purgeSubject(selector({ through: epoch - 1 }), guard())).removedSummaries, 0)
  assert.equal(await f.raw(fenceKey), fence); assert.equal(await f.raw(stateKey(selected.id)), rebuilt)
  await f.store.purgeSubject(selector({ target: selected.scope.target, through: epoch - 1 }), guard())
  assert.equal(await f.store.cleanupToken(selected.scope), token); assert.equal(await f.raw(stateKey(selected.id)), rebuilt)
  const independent = await fixture(t, 'conversation-cleanup-order')
  for (const subjectId of ['subject-b', 'subject-a']) await independent.store.purgeSubject(selector({ subjectId }), guard())
  await f.store.purgeSubject(selector({ subjectId: 'subject-b' }), guard())
  assert.equal(await f.store.cleanupToken(selected.scope), await independent.store.cleanupToken(selected.scope))
  assert.notEqual(await f.store.cleanupToken(selected.scope), token)
  assert.equal(JSON.parse(await f.raw(stateKey(selected.id))).summary, undefined)
})

test('stale state snapshots and old-token aggregate callbacks cannot resurrect erased records, summaries or episodes after restart', settings, async t => {
  const f = await fixture(t, 'conversation-cleanup-cas'), original = state(scope(), [record()], { summary: summary(), episodes: [episode()] })
  await f.store.update(original.id, () => original)
  const entered = deferred(), release = deferred(); let gate = true
  const stale = createConversationMemoryStore({ get: f.storage.get, async eval(script, args) {
    const result = await f.storage.eval(script, args)
    if (gate && args.keys.includes(stateKey(original.id)) && !script.includes("redis.call('SET'")) { gate = false; entered.resolve(); await release.promise }
    return result
  } })
  const pending = stale.update(original.id, () => original)
  await entered.promise; await f.store.purgeSubject(selector(), guard()); release.resolve(); assert.equal(await pending, true)
  assert.equal(await f.raw(stateKey(original.id)), null)
  const restarted = createConversationMemoryStore(f.storage)
  await restarted.update(original.id, () => original); assert.equal(await f.raw(stateKey(original.id)), null)
  const cleanupToken = await restarted.cleanupToken(original.scope), fresh = state(scope(), [record(1, { at: epoch + 1 })], { summary: summary({ cleanupToken }), episodes: [episode(scope(), 'rebuilt', { cleanupToken })] })
  await restarted.update(fresh.id, () => fresh)
  await restarted.purgeSubject(selector({ through: epoch + 1 }), guard())
  await restarted.update(fresh.id, () => fresh); assert.equal(await f.raw(stateKey(fresh.id)), null)
})

test('after physical failure the durable fence filters raw leftovers, captured state and restarted loads before a retry proves deletion', settings, async t => {
  let failPhysical = false
  const f = await fixture(t, 'conversation-cleanup-unknown', storage => ({ get: storage.get, async eval(script, args) {
    if (failPhysical && args.keys.some(key => key.startsWith(prefix + ':state:'))) throw Error('physical reads unavailable')
    return storage.eval(script, args)
  } })), original = state(scope(), [record()], { summary: summary(), episodes: [episode()] })
  await f.store.update(original.id, () => original)
  assert.equal((await f.store.observeSchedule()).length, 1)
  failPhysical = true
  assert.deepEqual(await f.store.purgeSubject(selector(), guard()), { usage: 'blocked', cleanup: 'unknown', removedRecords: 0, removedSummaries: 0, removedEpisodes: 0, removedPartitions: 0 })
  assert.deepEqual(JSON.parse(await f.raw(stateKey(original.id))), original); failPhysical = false
  assert.equal(await createConversationMemoryStore(f.storage).load(original.id), undefined)
  assert.deepEqual(await f.store.list(), [])
  assert.deepEqual(await f.store.observeSchedule(), [])
  const projected = await f.store.filterState(original)
  assert.deepEqual(projected.records, []); assert.deepEqual(projected.episodes, []); assert.equal(projected.summary, undefined)
  const retried = await f.store.purgeSubject(selector(), guard())
  assert.equal(retried.cleanup, 'completed'); assert.equal(retried.removedSummaries, 1); assert.equal(retried.removedEpisodes, 1); assert.equal(retried.removedRecords, 1)
  assert.equal(await f.raw(stateKey(original.id)), null); assert.deepEqual(JSON.parse(await f.raw(catalogKey)).ids, [])
})

test('publication failures and asynchronous authority denial reject without a blocked receipt or unauthorized physical changes', settings, async t => {
  let failPublication = false
  const f = await fixture(t, 'conversation-cleanup-publication', storage => ({ get: storage.get, async eval(script, args) {
    if (failPublication && args.keys.includes(fenceKey) && script.includes("redis.call('SET'")) throw Error('fence unavailable')
    return storage.eval(script, args)
  } })), original = state(); await f.store.update(original.id, () => original)
  const authority = guard(); authority.ensureCurrent = async () => { throw Error('authoritative denial') }
  await assert.rejects(() => f.store.purgeSubject(selector(), authority)); assert.equal(await f.raw(fenceKey), null)
  failPublication = true; await assert.rejects(() => f.store.purgeSubject(selector(), guard())); assert.equal(await f.raw(fenceKey), null)
  assert.deepEqual(JSON.parse(await f.raw(stateKey(original.id))), original)
  failPublication = false
  let checks = 0; const late = guard(); late.ensureCurrent = async () => { if (++checks === 3) throw Error('transient authoritative denial') }
  await assert.rejects(() => f.store.purgeSubject(selector(), late)); assert.ok(await f.raw(fenceKey)); assert.deepEqual(JSON.parse(await f.raw(stateKey(original.id))), original)
})

test('abort while a raw storage read is pending never commits deletion or reports completed', settings, async t => {
  const entered = deferred(), release = deferred(); let delayed = false
  const f = await fixture(t, 'conversation-cleanup-cancelled', storage => ({ get: storage.get, async eval(script, args) {
    if (delayed && args.keys.some(key => key.startsWith(prefix + ':state:')) && !script.includes("redis.call('SET'")) { delayed = false; entered.resolve(); await release.promise }
    return storage.eval(script, args)
  } })), original = state(); await f.store.update(original.id, () => original)
  const authority = guard(); delayed = true
  const pending = f.store.purgeSubject(selector(), authority); await entered.promise; authority.controller.abort(); release.resolve()
  await assert.rejects(pending); assert.ok(await f.raw(fenceKey)); assert.deepEqual(JSON.parse(await f.raw(stateKey(original.id))), original)
})

test('bounded selector capacity never evicts watermarks and corrupt fences or lost execution leases fail closed', settings, async t => {
  const f = await fixture(t, 'conversation-cleanup-capacity')
  const entries = Array.from({ length: 4096 }, (_, index) => conversationCleanupSelector(selector({ subjectId: 'subject-' + index })))
  await f.set(fenceKey, JSON.stringify({ version: 1, entries })); const before = await f.raw(fenceKey)
  await assert.rejects(() => f.store.purgeSubject(selector(), guard())); assert.equal(await f.raw(fenceKey), before)
  await f.store.purgeSubject(selector({ subjectId: 'subject-0', through: epoch - 1 }), guard()); assert.equal(await f.raw(fenceKey), before)
  await f.set(fenceKey, '{damaged')
  await assert.rejects(() => f.store.cleanupToken(scope())); await assert.rejects(() => f.store.filterState(state()))
  await assert.rejects(() => f.store.load(state().id)); await assert.rejects(() => f.store.purgeSubject(selector(), guard()))
  await f.reader.del(f.prefix + fenceKey); await f.reader.set(f.prefix + 'agent:host-lease', 'lost-owner')
  await assert.rejects(() => f.store.purgeSubject(selector(), guard())); assert.equal(await f.raw(fenceKey), null)
})

test('ordinary empty states survive while malformed aggregate tokens and forged provenance still reject before filtering', settings, async t => {
  const f = await fixture(t, 'conversation-cleanup-empty'), empty = state(scope({ id: 'empty-room' }), []), selected = state(scope(), [record(1, { at: epoch + 1 })])
  await f.store.update(empty.id, () => empty); await f.store.update(selected.id, () => selected)
  await f.store.purgeSubject(selector(), guard()); assert.deepEqual(JSON.parse(await f.raw(stateKey(empty.id))), empty)
  const cleanupToken = await f.store.cleanupToken(selected.scope)
  assert.equal((await f.store.load(selected.id)).dueCleanupToken, undefined, 'legacy states without a scheduling generation remain readable')
  await f.store.update(selected.id, current => ({ ...current, dueCleanupToken: cleanupToken, summary: summary({ cleanupToken }), episodes: [episode(scope(), 'fresh', { cleanupToken })] }))
  assert.equal((await createConversationMemoryStore(f.storage).load(selected.id)).dueCleanupToken, cleanupToken)
  for (const change of [
    current => ({ ...current, summary: summary({ cleanupToken: 'bad-token' }) }),
    current => ({ ...current, episodes: [episode(scope(), 'bad', { cleanupToken: null })] }),
    current => ({ ...current, records: current.records.map(row => ({ ...row, text: 'forged original' })) }),
  ]) await assert.rejects(() => f.store.update(selected.id, change))
  for (const dueCleanupToken of ['', 'A'.repeat(64), 'a'.repeat(63), null, 1]) {
    await assert.rejects(() => f.store.update(selected.id, current => ({ ...current, dueCleanupToken })))
  }
  assert.equal((await f.store.load(selected.id)).summary.cleanupToken, cleanupToken)
  assert.equal((await f.store.load(selected.id)).dueCleanupToken, cleanupToken)
})
