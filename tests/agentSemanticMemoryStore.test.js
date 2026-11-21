import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createConnection, createServer } from 'node:net'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { agentSemanticMemoryId, createAgentSemanticMemoryStore } from '../dist/backend/modules/memory/infrastructure/agentSemanticMemoryStore.js'
import { agentConversationKey } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { openAgentRedis } from '../dist/backend/modules/runtime/infrastructure/agentRedis.js'
import { commitStandaloneTransfer } from '../dist/backend/bootstrap/standaloneAgentMigration.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const redisTest = { skip: !redisAvailable, timeout: 20_000 }
const FAILURE = '语义记忆存储不可用或状态无效，已停止读写。'
const prefix = 'agent:semantic-memory:v1'
const catalogKey = `${prefix}:catalog`
const stateKey = id => `${prefix}:state:${id}`
const providerId = createHash('sha256').update('provider/model/dimensions').digest('hex')
const epoch = 1_800_000_000_000

function scope({ platform = 'fixture', namespace = 'tenant-a', accountId = 'bot-a', kind = 'group', conversationId = 'room-a', agentId = 'daily' } = {}) {
  return { agentId, target: { account: { platform, namespace, id: accountId }, kind, id: conversationId } }
}
function row(index = 1, overrides = {}) {
  return { messageId: `message-${index}`, authorId: 'real-author', name: '原始名字', text: `原始发言${index}`, at: epoch + index, ...overrides }
}
function state(selected = scope(), rows) {
  return { version: 1, id: agentSemanticMemoryId(selected), scope: selected,
    rows: rows ?? [row(1, selected.target.kind === 'private' ? { authorId: 'real-peer', peerId: 'real-peer' } : {})] }
}
function catalog(entries = []) {
  return JSON.stringify({ version: 1, entries: entries.map(({ id, scope }) => ({ id, scope })) })
}
async function fixture(t, name) {
  const redis = await createAgentRedisFixture(t, name)
  return { ...redis, store: createAgentSemanticMemoryStore(redis.storage),
    rawGet: key => redis.reader.get(redis.prefix + key),
    rawSet: (key, value) => redis.reader.set(redis.prefix + key, value),
    rawDelete: key => redis.reader.del(redis.prefix + key),
  }
}
async function rejects(operation) {
  await assert.rejects(operation, error => error.message === FAILURE && error.cause === undefined)
}

test('semantic sources and vectors survive store recreation with host-prefixed keys and no binding or persona snapshots', redisTest, async t => {
  const f = await fixture(t, 'semantic-store-restart')
  const input = state(scope(), [row(1, { vector: [0.1, 0.9], providerId }), row(2)])
  assert.equal(input.id, createHash('sha256').update(agentConversationKey(input.scope)).digest('hex'))
  assert.deepEqual(await f.store.listScopes(), [])
  assert.deepEqual(await f.store.list(), [])
  assert.equal(await f.store.read(input.id), undefined)
  assert.equal(await f.store.update(input.id, current => { assert.equal(current, undefined); return input }), true)
  const restarted = createAgentSemanticMemoryStore(f.storage)
  assert.deepEqual(await restarted.read(input.id), input)
  assert.deepEqual(await restarted.list(), [input])
  assert.deepEqual(await restarted.listScopes(), [{ id: input.id, scope: input.scope }])
  assert.equal(await f.rawGet(catalogKey), catalog([input]))
  assert.equal(await f.reader.exists(catalogKey), 0)
  assert.equal(await f.reader.exists(stateKey(input.id)), 0)
  assert.equal(await f.reader.exists(f.prefix + stateKey(input.id)), 1)
  const loaded = await restarted.read(input.id)
  loaded.rows[0].text = '调用者本地修改'
  loaded.rows[0].vector[0] = 9
  assert.deepEqual(await f.store.read(input.id), input)
  assert.equal(await f.store.update(input.id, () => undefined), true)
  assert.equal(await restarted.read(input.id), undefined)
  assert.deepEqual(await restarted.list(), [])
  assert.deepEqual(await restarted.listScopes(), [])
  assert.equal(await f.store.update(input.id, () => undefined), true)
})

test('standalone semantic snapshot traffic cannot hold up the inbox socket or dispatch a revoked queued write', redisTest, async t => {
  const f = await fixture(t, 'semantic-store-isolation')
  const peers = []
  const proxy = createServer(front => {
    const back = createConnection({ path: new URL(f.url).pathname })
    front.on('error', () => back.destroy()).once('close', () => back.destroy())
    back.on('error', () => front.destroy()).once('close', () => front.destroy())
    front.pipe(back).pipe(front)
    peers.push({ front, back })
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  let redis
  t.after(async () => {
    await redis?.close()
    for (const { front, back } of peers) { front.destroy(); back.destroy() }
    await new Promise(resolve => proxy.close(resolve))
  })
  const events = []
  redis = await openAgentRedis({ url: `redis://127.0.0.1:${proxy.address().port}`, instance: 'isolated-semantic-owner',
    onLost() {}, onCommandFailure: event => events.push(event) })
  const input = state(scope(), [row(1, { vector: [0.1, 0.9], providerId })])
  const corpus = createAgentSemanticMemoryStore(redis.semanticStorage)
  assert.equal(await corpus.update(input.id, () => input), true)
  assert.equal(peers.length, 2)
  await redis.storage.set('inbox', 'ready')
  const socket = peers[1].back
  socket.pause()
  try {
    const blocked = corpus.read(input.id)
    let current = true
    const write = redis.semanticStorage.eval("return redis.call('SET', KEYS[1], ARGV[1])",
      { keys: ['revoked'], arguments: ['written'], isCurrent: () => current })
    const remaining = Array.from({ length: 6 }, () => redis.semanticStorage.get('inbox'))
    await assert.rejects(redis.semanticStorage.get('over-limit'))
    assert.deepEqual(events.map(event => [event.operation, event.code]), [['semantic_redis_command', 'redis_command_queue_full']])
    assert.equal(await redis.storage.get('inbox'), 'ready')
    current = false
    const pending = await Promise.race([blocked.then(() => false, () => false), delay(2_150, true)])
    assert.equal(pending, true)
    socket.resume()
    assert.deepEqual(await blocked, input)
    assert.equal(await write, 0)
    assert.deepEqual(await Promise.all(remaining), Array(6).fill('ready'))
    assert.equal(await redis.storage.get('revoked'), null)
    await f.reader.lPush('bl-agent:isolated-semantic-owner:wrong-type', 'sample')
    await assert.rejects(redis.semanticStorage.getSnapshot(['wrong-type']))
    assert.equal(events.at(-1).code, 'redis_command_rejected')
  } finally { socket.resume() }
})

test('source import is read-only until CAS and a concurrent cleanup aborts the parent history commit', redisTest, async t => {
  const f = await fixture(t, 'semantic-store-source-import')
  const selected = scope(), id = agentSemanticMemoryId(selected)
  const before = await f.store.planSourceImport(selected, [row(1), row(2, { authorId: 'another-author' }), row(3)], 2)
  assert.equal(before.imported, 2)
  assert.deepEqual(await f.store.list(), [])
  const guard = { signal: new AbortController().signal, isCurrent: () => true, async ensureCurrent() {} }
  await f.store.purgeSubject({ account: selected.target.account, agentId: selected.agentId,
    target: selected.target, subjectId: 'real-author', through: epoch + 3 }, guard)
  const witness = f.prefix + 'history-witness'
  const commit = staged => commitStandaloneTransfer(f.reader, [
    { key: witness, value: null, write: 'history' },
    ...staged.checks.map(check => ({ ...check, key: f.prefix + check.key })),
  ])
  await assert.rejects(commit(before))
  assert.equal(await f.reader.get(witness), null)
  assert.deepEqual(await f.store.list(), [])
  const after = await f.store.planSourceImport(selected, [row(1), row(2, { authorId: 'another-author' }), row(3)], 2)
  assert.equal(after.imported, 1)
  await commit(after)
  assert.equal(await f.reader.get(witness), 'history')
  assert.deepEqual((await f.store.read(id)).rows, [row(2, { authorId: 'another-author' })])
})

test('scope discovery reads only bounded catalog metadata without loading message or vector state bodies', redisTest, async t => {
  const f = await fixture(t, 'semantic-store-discovery')
  const entries = [state(scope(), [row(1, { vector: [1, 0], providerId })]), state(scope({ agentId: 'other' }))]
  for (const entry of entries) await f.store.update(entry.id, () => entry)
  const reads = []
  const lightweight = createAgentSemanticMemoryStore({ async get(key) {
    reads.push(key)
    assert.equal(key, catalogKey)
    return f.storage.get(key)
  }, async eval() { assert.fail('scope discovery must not fetch state bodies') } })
  // Metadata discovery deliberately leaves full state validation to read().
  await f.rawSet(stateKey(entries[0].id), '{unreadable-private-body')
  const loaded = await lightweight.listScopes()
  assert.deepEqual(loaded, entries.map(({ id, scope }) => ({ id, scope })))
  assert.deepEqual(reads, [catalogKey])
  loaded[0].scope.target.account.id = 'local-change'
  assert.deepEqual(await lightweight.listScopes(), entries.map(({ id, scope }) => ({ id, scope })))
  await rejects(f.store.read(entries[0].id))
  await f.rawSet(stateKey(entries[0].id), JSON.stringify(entries[0]))
  await f.store.update(entries[0].id, current => ({ ...current, rows: [] }))
  assert.deepEqual(await lightweight.listScopes(), entries.map(({ id, scope }) => ({ id, scope })))
  await f.store.update(entries[0].id, () => undefined)
  assert.deepEqual(await lightweight.listScopes(), [{ id: entries[1].id, scope: entries[1].scope }])
})

test('semantic IDs partition the complete platform account, Agent, conversation kind and conversation ID', redisTest, async t => {
  const f = await fixture(t, 'semantic-store-scope')
  const entries = [state(), state(scope({ platform: 'matrix' })), state(scope({ namespace: 'tenant-b' })),
    state(scope({ accountId: 'bot-b' })), state(scope({ agentId: 'other' })), state(scope({ conversationId: 'room-b' })),
    state(scope({ kind: 'private' })), state(scope({ kind: 'channel' })), state(scope({ kind: 'thread' }))]
  assert.equal(new Set(entries.map(entry => entry.id)).size, entries.length)
  for (const entry of entries) assert.equal(await f.store.update(entry.id, () => entry), true)
  assert.deepEqual((await createAgentSemanticMemoryStore(f.storage).list()).map(entry => entry.id).sort(), entries.map(entry => entry.id).sort())
  assert.deepEqual((await f.store.listScopes()).map(entry => agentConversationKey(entry.scope)).sort(), entries.map(entry => agentConversationKey(entry.scope)).sort())
  const input = entries[0]
  for (const mutate of [
    value => { value.scope.agentId = 'other'; return value },
    value => { value.scope.target.account.platform = 'other'; return value },
    value => { value.scope.target.account.namespace = 'other'; return value },
    value => { value.scope.target.account.id = 'other'; return value },
    value => { value.scope.target.id = 'other'; return value },
    value => { value.scope.target.kind = 'channel'; return value },
  ]) await rejects(f.store.update(input.id, mutate))
  assert.deepEqual(await f.store.read(input.id), input)
})

test('existing message provenance is immutable while vectors may be added, replaced or removed and rows may be appended or deleted', redisTest, async t => {
  const f = await fixture(t, 'semantic-store-provenance')
  const input = state()
  await f.store.update(input.id, () => input)
  for (const mutate of [
    value => { value.rows[0].authorId = 'forged-author'; return value },
    value => { value.rows[0].name = '伪造名字'; return value },
    value => { value.rows[0].text = '伪造原文'; return value },
    value => { value.rows[0].at++; return value },
  ]) await rejects(f.store.update(input.id, mutate))
  assert.deepEqual(await f.store.read(input.id), input)
  assert.equal(await f.store.update(input.id, current => { current.rows[0].vector = [1, 0]; current.rows[0].providerId = providerId; return current }), true)
  assert.equal(await f.store.update(input.id, current => { current.rows[0].vector = [0, -1, 0.5]; current.rows[0].providerId = 'b'.repeat(64); current.rows.push(row(2)); return current }), true)
  const refreshed = await f.store.read(input.id)
  assert.deepEqual(refreshed.rows[0], { ...input.rows[0], vector: [0, -1, 0.5], providerId: 'b'.repeat(64) })
  assert.equal(await f.store.update(input.id, current => { delete current.rows[0].vector; delete current.rows[0].providerId; current.rows.pop(); return current }), true)
  assert.deepEqual(await f.store.read(input.id), input)
  assert.equal(await f.store.update(input.id, current => ({ ...current, rows: [] })), true)
  assert.deepEqual((await f.store.read(input.id)).rows, [])
})

test('private rows retain independently verified peers and never transfer a source message between peers', redisTest, async t => {
  const f = await fixture(t, 'semantic-store-private')
  const input = state(scope({ kind: 'private', conversationId: 'opaque-room' }), [
    row(1, { authorId: 'real-peer', peerId: 'real-peer' }), row(2, { authorId: 'next-peer', peerId: 'next-peer' }),
  ])
  assert.equal(await f.store.update(input.id, () => input), true)
  for (const mutate of [
    value => { value.rows[0].authorId = 'next-peer'; return value },
    value => { value.rows[0].peerId = 'next-peer'; return value },
    value => { value.rows[0].authorId = 'next-peer'; value.rows[0].peerId = 'next-peer'; return value },
    value => { delete value.rows[0].peerId; return value },
  ]) await rejects(f.store.update(input.id, mutate))
  const sameId = state(scope({ kind: 'private', conversationId: 'real-peer' }), [row(1, { authorId: 'real-peer' })])
  assert.equal(await f.store.update(sameId.id, () => sameId), true)
  assert.deepEqual(await f.store.read(input.id), input)
})

test('malformed scopes, unexpected runtime data, invalid source fields and duplicate message IDs fail closed', redisTest, async t => {
  const f = await fixture(t, 'semantic-store-validation')
  const input = state()
  await f.store.update(input.id, () => input)
  for (const mutate of [
    value => { value.version = 2; return value },
    value => { value.id = 'a'.repeat(64); return value },
    value => { value.scope.agentId = 'invalid id'; return value },
    value => { value.scope.target.kind = 'unsupported'; return value },
    value => { value.scope.target.account.platform = 'invalid platform'; return value },
    value => { value.scope.target.account.namespace = ''; return value },
    value => { value.scope.target.account.id = ''; return value },
    value => { value.scope.target.account.extra = 'hidden'; return value },
    value => { value.scope.target.extra = true; return value },
    value => { value.scope.extra = true; return value },
    value => { value.binding = { revision: 'fake' }; return value },
    value => { value.persona = 'fake-persona'; return value },
    value => { value.rows[0].extra = true; return value },
    value => { value.rows[0].messageId = '0'; return value },
    value => { value.rows[0].messageId = ''; return value },
    value => { value.rows[0].authorId = '0'; return value },
    value => { value.rows[0].authorId = ' '; return value },
    value => { value.rows[0].authorId = 'author\n'; return value },
    value => { value.rows[0].name = false; return value },
    value => { value.rows[0].text = ' '; return value },
    value => { value.rows[0].at = 0; return value },
    value => { value.rows[0].at = -1; return value },
    value => { value.rows[0].at = 0.5; return value },
    value => { value.rows[0].at = Number.MAX_SAFE_INTEGER + 1; return value },
    value => { value.rows[0].at = NaN; return value },
    value => { value.rows[0].peerId = 'real-author'; return value },
    value => { value.rows.push(row(2, { messageId: value.rows[0].messageId })); return value },
  ]) await rejects(f.store.update(input.id, mutate))
  assert.deepEqual(await f.store.read(input.id), input)
})

test('vectors require a matching provider fingerprint, finite nonzero values and between two and 4096 dimensions', redisTest, async t => {
  const f = await fixture(t, 'semantic-store-vectors')
  const input = state()
  await f.store.update(input.id, () => input)
  for (const vector of [null, false, {}, '1,0', [], [1], Array(4097).fill(1), [0, 0], [0, -0], [NaN, 1], [Infinity, 0], ['1', 0], [null, 1]]) {
    await rejects(f.store.update(input.id, current => { current.rows[0].vector = vector; current.rows[0].providerId = providerId; return current }))
  }
  for (const fingerprint of [null, false, '', 'model', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64)]) {
    await rejects(f.store.update(input.id, current => { current.rows[0].vector = [1, 0]; current.rows[0].providerId = fingerprint; return current }))
  }
  await rejects(f.store.update(input.id, current => { current.rows[0].vector = [1, 0]; return current }))
  await rejects(f.store.update(input.id, current => { current.rows[0].providerId = providerId; return current }))
  const maximum = [1, ...Array(4095).fill(0)]
  assert.equal(await f.store.update(input.id, current => { current.rows[0].vector = maximum; current.rows[0].providerId = providerId; return current }), true)
  assert.deepEqual((await f.store.read(input.id)).rows[0].vector, maximum)
})

test('row and catalog bounds reject excess data without trimming evidence or evicting another conversation', redisTest, async t => {
  const f = await fixture(t, 'semantic-store-bounds')
  const input = state(scope(), Array.from({ length: 2000 }, (_, index) => row(index + 1)))
  input.rows[0].name = '名'.repeat(24)
  input.rows[0].text = '文'.repeat(1600)
  assert.equal(await f.store.update(input.id, () => input), true)
  for (const mutate of [
    value => { value.rows.push(row(2001)); return value },
    value => { value.rows[0].name += '名'; return value },
    value => { value.rows[0].text += '文'; return value },
  ]) await rejects(f.store.update(input.id, mutate))
  assert.deepEqual(await f.store.read(input.id), input)
  await f.store.update(input.id, current => ({ ...current, rows: [] }))
  for (let index = 1; index < 200; index++) {
    const entry = state(scope({ conversationId: `room-${index}` }), [])
    assert.equal(await f.store.update(entry.id, () => entry), true)
  }
  const excess = state(scope({ conversationId: 'excess-room' }))
  await rejects(f.store.update(excess.id, () => excess))
  assert.equal(await f.rawGet(stateKey(excess.id)), null)
  assert.equal((await f.store.list()).length, 200)
  assert.equal((await f.store.listScopes()).length, 200)
})

test('simultaneous CAS mutations retain source additions and vector work instead of overwriting them', redisTest, async t => {
  const f = await fixture(t, 'semantic-store-concurrent')
  const input = state()
  await f.store.update(input.id, () => input)
  const parallel = 10
  const gate = Promise.withResolvers()
  let reads = 0
  const gated = { get: f.storage.get, async eval(script, options) {
    const result = await f.storage.eval(script, options)
    if (script.includes("return {redis.call('GET'") && reads < parallel) {
      if (++reads === parallel) gate.resolve()
      await gate.promise
    }
    return result
  } }
  const outcomes = await Promise.all(Array.from({ length: parallel }, (_, index) => createAgentSemanticMemoryStore(gated).update(input.id, current => {
    if (index === 0) { current.rows[0].vector = [1, 0]; current.rows[0].providerId = providerId }
    else current.rows.push(row(index + 1))
    return current
  })))
  assert.ok(outcomes.every(Boolean))
  const saved = await f.store.read(input.id)
  assert.equal(saved.rows.length, 10)
  assert.deepEqual(saved.rows.map(item => item.messageId).sort(), Array.from({ length: 10 }, (_, index) => `message-${index + 1}`).sort())
  assert.deepEqual(saved.rows.find(item => item.messageId === 'message-1'), { ...input.rows[0], vector: [1, 0], providerId })
})

test('concurrent catalog additions and list snapshot retries preserve every complete scoped state', redisTest, async t => {
  const f = await fixture(t, 'semantic-store-catalog')
  const entries = Array.from({ length: 10 }, (_, index) => state(scope({ accountId: `bot-${index}` })))
  assert.ok((await Promise.all(entries.map(entry => createAgentSemanticMemoryStore(f.storage).update(entry.id, () => entry)))).every(Boolean))
  const extra = state(scope({ conversationId: 'extra-room' }))
  let changed = false
  const reader = createAgentSemanticMemoryStore({ async get(key) {
    const result = await f.storage.get(key)
    if (key === catalogKey && !changed) { changed = true; await f.store.update(extra.id, () => extra) }
    return result
  }, eval: f.storage.eval })
  assert.deepEqual((await reader.list()).map(entry => entry.id).sort(), [...entries, extra].map(entry => entry.id).sort())
})

test('cancelled or throwing guards fence storage waits, mutation callbacks and the final synchronous commit', redisTest, async t => {
  const f = await fixture(t, 'semantic-store-cancelled')
  const input = state()
  let live = true, mutated = false, commits = 0
  const store = createAgentSemanticMemoryStore({ get: f.storage.get, async eval(script, options) {
    const result = await f.storage.eval(script, options)
    if (script.includes("return {redis.call('GET'")) live = false
    if (script.includes("redis.call('SET'")) commits++
    return result
  } })
  assert.equal(await store.update(input.id, () => { mutated = true; return input }, () => live), false)
  assert.equal(mutated, false)
  assert.equal(commits, 0)
  live = true
  assert.equal(await f.store.update(input.id, () => { live = false; return input }, () => live), false)
  let checks = 0
  assert.equal(await f.store.update(input.id, () => input, () => ++checks < 4), false)
  assert.equal(checks, 4)
  assert.equal(await f.store.update(input.id, () => input, () => { throw Error('private guard details') }), false)
  assert.equal(await f.store.update(input.id, () => input, () => false), false)
  assert.deepEqual(await f.store.list(), [])
})

test('corrupted catalogs or states, missing entries and orphaned values fail closed on read and mutation', redisTest, async t => {
  const f = await fixture(t, 'semantic-store-corruption')
  const input = state()
  const entry = { id: input.id, scope: input.scope }
  for (const invalid of ['{private-json', '[]', JSON.stringify({ version: 2, entries: [] }), JSON.stringify({ version: 1, ids: [input.id] }),
    JSON.stringify({ version: 1, entries: [{ ...entry, id: 'bad-id' }] }), catalog([input, input]),
    JSON.stringify({ version: 1, entries: [], hidden: true }), JSON.stringify({ version: 1, entries: [{ id: input.id }] }),
    JSON.stringify({ version: 1, entries: [{ scope: input.scope }] }), JSON.stringify({ version: 1, entries: [{ ...entry, rows: input.rows }] }),
    JSON.stringify({ version: 1, entries: [{ ...entry, scope: { ...input.scope, agentId: 'forged' } }] }),
    JSON.stringify({ version: 1, entries: [{ ...entry, scope: { ...input.scope, hidden: true } }] }),
    JSON.stringify({ version: 1, entries: [{ ...entry, scope: { ...input.scope, target: { ...input.scope.target, hidden: true } } }] }),
    catalog(Array.from({ length: 201 }, (_, index) => state(scope({ conversationId: `room-${index}` }), []))),
  ]) {
    await f.rawSet(catalogKey, invalid)
    await rejects(f.store.listScopes())
    await rejects(f.store.list())
    await rejects(f.store.read(input.id))
    await rejects(f.store.update(input.id, () => input))
    assert.equal(await f.rawGet(catalogKey), invalid)
    assert.equal(await f.rawGet(stateKey(input.id)), null)
  }
  await f.rawSet(catalogKey, catalog([input]))
  for (const invalid of ['{private-json', JSON.stringify({ ...input, version: 2 }), JSON.stringify({ ...input, scope: { ...input.scope, agentId: 'forged' } }),
    JSON.stringify({ ...input, rows: [{ ...input.rows[0], vector: [1, 0] }] })]) {
    await f.rawSet(stateKey(input.id), invalid)
    await rejects(f.store.list())
    await rejects(f.store.read(input.id))
    await rejects(f.store.update(input.id, () => undefined))
    assert.equal(await f.rawGet(stateKey(input.id)), invalid)
  }
  await f.rawDelete(stateKey(input.id))
  await rejects(f.store.list())
  await rejects(f.store.read(input.id))
  await rejects(f.store.update(input.id, () => input))
  await f.rawSet(catalogKey, catalog())
  await f.rawSet(stateKey(input.id), JSON.stringify(input))
  await rejects(f.store.read(input.id))
  await rejects(f.store.update(input.id, () => input))
  for (const id of ['', 'invalid', input.id.toUpperCase()]) {
    await rejects(f.store.read(id))
    await rejects(f.store.update(id, () => input))
  }
})

test('bounded CAS conflicts preserve the newer state and lost host leases prevent writes through explicit Redis keys', redisTest, async t => {
  const f = await fixture(t, 'semantic-store-conflicts')
  const input = state()
  await f.store.update(input.id, () => input)
  let conflicts = 0
  const competing = createAgentSemanticMemoryStore({ get: f.storage.get, async eval(script, options) {
    if (script.includes("redis.call('SET'")) {
      conflicts++
      const concurrent = JSON.parse(await f.rawGet(stateKey(input.id)))
      concurrent.rows.push(row(conflicts + 1))
      await f.rawSet(stateKey(input.id), JSON.stringify(concurrent))
    }
    return f.storage.eval(script, options)
  } })
  await rejects(competing.update(input.id, current => { current.rows[0].vector = [1, 0]; current.rows[0].providerId = providerId; return current }))
  assert.equal(conflicts, 20)
  const newer = await f.store.read(input.id)
  assert.equal(newer.rows.length, 21)
  assert.equal(newer.rows[0].vector, undefined)
  await f.reader.set(f.prefix + 'agent:host-lease', 'other-process')
  await rejects(f.store.update(input.id, current => ({ ...current, rows: [] })))
  assert.deepEqual(JSON.parse(await f.rawGet(stateKey(input.id))), newer)
})
