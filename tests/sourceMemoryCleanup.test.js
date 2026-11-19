import assert from 'node:assert/strict'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const { createAgentHistoryStore, agentHistoryId } = await load('modules/memory/infrastructure/agentHistoryStore.js')
const { createTextPersonMemoryStore, textPersonMemoryBatchId } = await load('modules/memory/infrastructure/textPersonMemoryStore.js')
const { createDelegatedMemoryStore, delegatedMemoryStorageKey } = await load('modules/memory/infrastructure/delegatedMemoryStore.js')
const { conversationAddressKey, agentBindingToken } = await load('modules/runtime/domain/agentBindings.js')
const config = { skip: !redisAvailable, timeout: 20000 }, at = 1800000000000
const account = { platform: 'fixture', namespace: 'source-cleanup', id: 'account-a' }
function binding(overrides = {}) {
  const target = { account, kind: 'group', id: 'room-a', ...overrides.target }
  return { source: 'configured', id: conversationAddressKey(target), revision: 'r1', agentId: 'daily', personaId: 'shared', connectionId: 'main', ...overrides, target }
}
const subject = (overrides = {}) => ({ account, agentId: 'daily', subjectId: 'alice', through: at, ...overrides })
const guard = () => ({ signal: new AbortController().signal, isCurrent: () => true, async ensureCurrent() {} })
function row(id = 'old', overrides = {}) { return { messageId: id, authorId: 'alice', name: 'Alice', text: id + '-original', at, ...overrides } }
function history(selected = binding(), rows = [row()]) {
  const scope = { agentId: selected.agentId, target: selected.target }
  return { version: 1, id: agentHistoryId(scope), scope, rows }
}
function batch(selected = binding(), subjectId = 'alice', messages = [row()]) {
  const token = agentBindingToken(selected), id = textPersonMemoryBatchId(selected, token, subjectId)
  return { version: 1, id, binding: selected, token, subjectId, messages: messages.map(({ authorId, ...message }) => message), dueAt: at, attempts: 0, retryAt: 0 }
}
function delegated(id = 'old', overrides = {}) {
  return { id, owner: 'alice', ownerName: 'Alice', content: id + '-delegated', dueAt: 0, status: 'active', createdAt: at, updatedAt: at, sourceAt: at, ...overrides }
}
function stores(redis) {
  return { history: createAgentHistoryStore(redis), text: createTextPersonMemoryStore(redis),
    delegated: createDelegatedMemoryStore({ redis, logger: { info() {}, warn() {}, error() {} }, loadConfig: () => ({}), now: () => at }) }
}
async function fixture(t, name, wrap) {
  const f = await createAgentRedisFixture(t, name), redis = wrap ? wrap(f.storage) : f.storage
  return { ...f, redis, ...stores(redis), raw: key => f.reader.get(f.prefix + key) }
}

test('history author cutoffs physically remove inclusive rows, retire empty scopes and preserve other owners and future sources', config, async t => {
  const f = await fixture(t, 'source-history-raw')
  const selected = history(binding(), [row(), row('future', { at: at + 1 }), row('bob', { authorId: 'bob' })])
  const retired = history(binding({ target: { id: 'unbound' } }))
  const other = [history(binding({ agentId: 'other' })), history(binding({ target: { account: { ...account, id: 'account-b' } } }))]
  for (const state of [selected, retired, ...other]) await f.history.update(state.id, () => state)
  assert.deepEqual(await f.history.purgeSubject(subject(), guard()), { id: 'history-records', cleanup: 'completed', removedRecords: 2, removedPartitions: 1 })
  assert.deepEqual(JSON.parse(await f.raw('agent:history:v1:state:' + selected.id)).rows, selected.rows.slice(1))
  assert.equal(await f.raw('agent:history:v1:state:' + retired.id), null)
  for (const state of other) assert.deepEqual(await f.history.read(state.id), state)
  await stores(f.redis).history.update(retired.id, () => retired)
  assert.equal(await f.raw('agent:history:v1:state:' + retired.id), null)
  const rawFence = await f.raw('agent:history:v1:cleanup')
  assert.ok(!rawFence.includes('alice') && !rawFence.includes('account-a'))
})

test('extraction purge removes all old originals and the proposal derived from them while preserving new messages and other authors', config, async t => {
  const f = await fixture(t, 'source-extraction-raw'), selected = batch(binding(), 'alice', [row(), row('future', { at: at + 1 })])
  selected.result = { raw: '[{"userId":"alice","entries":[{"text":"old-derived"}]}]', messageIds: ['old'] }
  const bob = batch(binding(), 'bob', [row('bob')]), other = batch(binding({ agentId: 'other' }))
  for (const value of [selected, bob, other]) await f.text.update(value.id, () => value)
  assert.deepEqual(await f.text.purgeSubject(subject(), guard()), { id: 'person-extraction-batches', cleanup: 'completed', removedRecords: 2, removedPartitions: 0 })
  const raw = JSON.parse(await f.raw('agent:person-memory:text:v1:batch:' + selected.id))
  assert.deepEqual(raw.messages, selected.messages.slice(1)); assert.equal(raw.result, undefined)
  assert.deepEqual(await f.text.filterMessages(selected, selected.messages), selected.messages.slice(1))
  await f.text.update(selected.id, () => selected)
  assert.deepEqual(JSON.parse(await f.raw('agent:person-memory:text:v1:batch:' + selected.id)), raw)
  assert.deepEqual((await f.text.list()).filter(item => item.subjectId === 'bob'), [bob])
  await f.text.purgeSubject(subject({ through: at + 1 }), guard())
  assert.equal(await f.raw('agent:person-memory:text:v1:batch:' + selected.id), null)
  assert.deepEqual((await f.text.list()).map(item => item.id).sort(), [bob.id, other.id].sort())
})

test('delegated cleanup discovers old unbound scopes and removes only attributed content across recreation', config, async t => {
  const f = await fixture(t, 'source-delegated-raw'), selected = binding(), unbound = binding({ target: { id: 'unbound' } }), other = binding({ agentId: 'other' })
  const entries = [delegated(), delegated('bob', { owner: 'bob' }), delegated('future', { sourceAt: at + 1, createdAt: at + 1 })]
  await f.delegated.update(selected, () => ({ entries, result: true }))
  await f.delegated.update(unbound, () => ({ entries: [delegated()], result: true }))
  await f.delegated.update(other, () => ({ entries: [delegated()], result: true }))
  assert.deepEqual(await f.delegated.purgeSubject(subject(), guard()), { id: 'delegated-memory', cleanup: 'completed', removedRecords: 2, removedPartitions: 1 })
  assert.deepEqual(JSON.parse(await f.raw(delegatedMemoryStorageKey(selected))), entries.slice(1))
  assert.equal(await f.raw(delegatedMemoryStorageKey(unbound)), null)
  assert.deepEqual(await f.delegated.load(other), [delegated()])
  const restarted = stores(f.redis).delegated
  await restarted.update(unbound, () => ({ entries: [delegated()], result: true }))
  assert.equal(await f.raw(delegatedMemoryStorageKey(unbound)), null)
  assert.deepEqual(await restarted.loadForManagement(selected, async () => {}), entries.slice(1))
})

test('full target cleanup preserves another scene, namespace and account even with reused author IDs', config, async t => {
  const f = await fixture(t, 'source-complete-target'), selected = binding()
  const states = [history(selected), history(binding({ target: { id: 'room-b' } })), history(binding({ target: { account: { ...account, namespace: 'elsewhere' } } }))]
  for (const value of states) await f.history.update(value.id, () => value)
  await f.history.purgeSubject(subject({ target: selected.target }), guard())
  assert.equal(await f.history.read(states[0].id), undefined)
  for (const value of states.slice(1)) assert.deepEqual(await f.history.read(value.id), value)
})

test('late history, extraction and delegated snapshots must compare the persistent fence before committing', config, async t => {
  const f = await fixture(t, 'source-late-writes'), selected = history(), learning = batch(), owner = binding(), entry = delegated()
  await f.history.update(selected.id, () => selected); await f.text.update(learning.id, () => learning)
  await f.delegated.update(owner, () => ({ entries: [entry], result: true }))
  const reached = Promise.withResolvers(), release = Promise.withResolvers(); let gate = true
  const delayed = stores({ ...f.redis, async eval(script, args) {
    const result = await f.redis.eval(script, args)
    if (gate && !script.includes("redis.call('SET'")) { gate = false; reached.resolve(); await release.promise }
    return result
  } })
  const pending = delayed.history.update(selected.id, () => selected)
  await reached.promise
  await Promise.all([f.history.purgeSubject(subject(), guard()), f.text.purgeSubject(subject(), guard()), f.delegated.purgeSubject(subject(), guard())])
  release.resolve(); assert.equal(await pending, true)
  await delayed.text.update(learning.id, () => learning)
  await delayed.delegated.update(owner, () => ({ entries: [entry], result: true }))
  assert.equal(await f.history.read(selected.id), undefined); assert.deepEqual(await f.text.list(), []); assert.deepEqual(await f.delegated.load(owner), [])
})

test('I/O failure after publishing is unknown, reads remain filtered and retry proves raw physical deletion', config, async t => {
  let failPhysical = false
  const f = await fixture(t, 'source-unknown', redis => ({ ...redis, async eval(script, args) {
    if (failPhysical && args.keys.some(key => key.startsWith('agent:history:v1:state:'))) throw Error('physical unavailable')
    return redis.eval(script, args)
  } }))
  const state = history(); await f.history.update(state.id, () => state); failPhysical = true
  assert.equal((await f.history.purgeSubject(subject(), guard())).cleanup, 'unknown')
  assert.deepEqual(JSON.parse(await f.raw('agent:history:v1:state:' + state.id)), state)
  failPhysical = false
  assert.equal(await f.history.read(state.id), undefined)
  assert.equal((await f.history.purgeSubject(subject(), guard())).cleanup, 'completed')
  assert.equal(await f.raw('agent:history:v1:state:' + state.id), null)
})

test('asynchronous authorization rejection never publishes a fence or reports unknown completion', config, async t => {
  const f = await fixture(t, 'source-denied'), state = history(); await f.history.update(state.id, () => state)
  const denied = { ...guard(), async ensureCurrent() { throw Error('denied') } }
  for (const owner of [f.history, f.text, f.delegated]) await assert.rejects(owner.purgeSubject(subject(), denied), /denied/)
  for (const key of ['agent:history:v1:cleanup', 'agent:person-memory:text:v1:cleanup', 'bl-chat:delegated:v2:cleanup']) assert.equal(await f.raw(key), null)
  assert.deepEqual(await f.history.read(state.id), state)
})
