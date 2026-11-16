import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createConversationMemoryStore, conversationMemoryId } from '../dist/backend/modules/memory/infrastructure/conversationMemoryStore.js'
import { personMemoryAddress } from '../dist/backend/modules/memory/infrastructure/personMemoryContext.js'
import { agentBindingToken, agentConversationKey, agentPersonaScopeId, conversationAddressKey } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const redisTest = { skip: !redisAvailable, timeout: 20_000 }
const FAILURE = '会话记忆存储不可用或状态无效，已停止读写。'
const base = 'agent:conversation-memory:v1'
const catalogKey = `${base}:catalog`
const stateKey = id => `${base}:state:${id}`
const epoch = 1_800_000_000_000

function binding({ platform = 'fixture', namespace = 'tenant-a', accountId = 'bot-a', kind = 'group', conversationId = 'room-a', agentId = 'daily', revision = 'first' } = {}) {
  const target = { account: { platform, namespace, id: accountId }, kind, id: conversationId }
  return { source: 'configured', id: conversationAddressKey(target), revision, agentId, personaId: 'shared-template', connectionId: 'fixture', target }
}
function record(seq = 1, overrides = {}) {
  return { seq, messageId: `m${seq}`, authorId: 'real-author', name: '原始名字', text: `原始发言${seq}`, at: epoch + seq, ...overrides }
}
function episode(selected, index = 1, overrides = {}) {
  return { id: `episode-${index}`, at: epoch + index, userId: 'real-author', userName: '当时的名字',
    summary: `发生的事情${index}`, reply: `已确认的回复${index}`,
    source: { botId: personMemoryAddress(selected.target).botId, personaId: agentPersonaScopeId(selected.agentId), personaVersion: 'historical-persona-v1', personaName: '当时的角色名' },
    messageIds: [`m${index}`], replyIds: [`sent-${index}`], invalidatedAt: 0, ...overrides }
}
function state(selected = binding(), overrides = {}) {
  const scope = { agentId: selected.agentId, target: selected.target }
  const privatePeer = selected.target.kind === 'private' ? { authorId: 'real-peer', peerId: 'real-peer' } : {}
  return { version: 1, id: conversationMemoryId(scope), scope, binding: selected, token: agentBindingToken(selected), nextSeq: 2,
    records: [record(1, privatePeer)], episodes: [], dueAt: epoch, attempts: 0, retryAt: 0, ...overrides }
}
async function fixture(t, name) {
  const redis = await createAgentRedisFixture(t, name)
  return { ...redis, store: createConversationMemoryStore(redis.storage),
    rawGet: key => redis.reader.get(redis.prefix + key),
    rawSet: (key, value) => redis.reader.set(redis.prefix + key, value),
    rawDelete: key => redis.reader.del(redis.prefix + key),
  }
}
async function rejects(operation) {
  await assert.rejects(operation, error => error.message === FAILURE && error.cause === undefined)
}

test('conversation summaries, episodes and original evidence survive store recreation with host-prefixed keys', redisTest, async t => {
  const f = await fixture(t, 'conversation-store-restart')
  const input = state()
  input.summary = { text: '群里的滚动主线', updatedAt: epoch, coveredSeq: 1, invalidatedAt: 0 }
  input.episodes = [episode(input.binding)]
  assert.equal(input.id, createHash('sha256').update(agentConversationKey(input.scope)).digest('hex'))
  assert.deepEqual(await f.store.list(), [])
  assert.equal(await f.store.load(input.id), undefined)
  assert.equal(await f.store.update(input.id, current => { assert.equal(current, undefined); return input }), true)
  const restarted = createConversationMemoryStore(f.storage)
  assert.deepEqual(await restarted.list(), [input])
  assert.deepEqual(await restarted.load(input.id), input)
  assert.equal(await f.reader.exists(catalogKey), 0)
  assert.equal(await f.reader.exists(stateKey(input.id)), 0)
  assert.equal(await f.reader.exists(f.prefix + stateKey(input.id)), 1)

  const loaded = await restarted.load(input.id)
  loaded.records[0].text = '本地副本修改'
  assert.deepEqual(await f.store.load(input.id), input)
  assert.equal(await f.store.update(input.id, () => undefined), true)
  assert.equal(await restarted.load(input.id), undefined)
  assert.deepEqual(await restarted.list(), [])
  assert.equal(await f.store.update(input.id, () => undefined), true)
})

test('conversation IDs partition full platform accounts, Agents and scenes while binding revisions remain updateable', redisTest, async t => {
  const f = await fixture(t, 'conversation-store-identities')
  const entries = [state(), state(binding({ platform: 'matrix' })), state(binding({ namespace: 'tenant-b' })),
    state(binding({ accountId: 'bot-b' })), state(binding({ agentId: 'other' })),
    state(binding({ conversationId: 'room-b' })), state(binding({ kind: 'private' })),
    state(binding({ kind: 'channel' })), state(binding({ kind: 'thread' }))]
  for (const entry of entries.slice(-2)) entry.episodes = [episode(entry.binding)]
  assert.equal(new Set(entries.map(entry => entry.id)).size, entries.length)
  for (const entry of entries) assert.equal(await f.store.update(entry.id, () => entry), true)
  assert.deepEqual((await createConversationMemoryStore(f.storage).list()).map(entry => entry.id).sort(), entries.map(entry => entry.id).sort())

  const original = entries[0]
  const selected = binding({ revision: 'second' })
  assert.equal(conversationMemoryId(selected), original.id)
  assert.equal(await f.store.update(original.id, current => ({ ...current, binding: selected, token: 'new-text-routing-token', dueInvalidatedAt: epoch })), true)
  const updated = await f.store.load(original.id)
  assert.equal(updated.binding.revision, 'second')
  assert.equal(updated.token, 'new-text-routing-token')
  assert.equal(updated.dueInvalidatedAt, epoch)
  assert.deepEqual(updated.records, original.records)
})

test('private histories retain different verified peers independently and every record and episode must match its own peer', redisTest, async t => {
  const f = await fixture(t, 'conversation-store-private-peers')
  const input = state(binding({ kind: 'private', conversationId: 'opaque-room' }))
  input.records.push(record(2, { authorId: 'next-peer', peerId: 'next-peer' }))
  input.nextSeq = 3
  input.episodes = [
    episode(input.binding, 1, { userId: 'real-peer', peerId: 'real-peer' }),
    episode(input.binding, 2, { userId: 'next-peer', peerId: 'next-peer' }),
  ]
  assert.equal(await f.store.update(input.id, () => input), true)
  assert.deepEqual(await f.store.load(input.id), input)
  for (const change of [
    value => { value.records[0].authorId = 'someone-else'; return value },
    value => { delete value.records[0].peerId; return value },
    value => { value.episodes[1].userId = 'real-peer'; return value },
    value => { delete value.episodes[0].userId; return value },
    value => { delete value.episodes[0].peerId; return value },
  ]) await rejects(f.store.update(input.id, change))
  const sameIdPeer = state(binding({ kind: 'private', conversationId: 'real-peer' }))
  delete sameIdPeer.records[0].peerId
  sameIdPeer.episodes = [episode(sameIdPeer.binding, 1, { userId: 'real-peer' })]
  assert.equal(await f.store.update(sameIdPeer.id, () => sameIdPeer), true)
})

test('concurrent CAS retries preserve new ingress, a summary and a confirmed episode without overwriting one another', redisTest, async t => {
  const f = await fixture(t, 'conversation-store-concurrent-state')
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
  const outcomes = await Promise.all(Array.from({ length: parallel }, (_, index) => createConversationMemoryStore(gated).update(input.id, current => {
    if (index === 0) current.summary = { text: '从第一条来源总结的主线', updatedAt: epoch + 100, coveredSeq: 1, invalidatedAt: 0 }
    else if (index === 1) current.episodes.push(episode(input.binding))
    else {
      current.records.push(record(current.nextSeq, { messageId: `parallel-${index}` }))
      current.nextSeq++
    }
    return current
  })))
  assert.ok(outcomes.every(Boolean))
  const recovered = await f.store.load(input.id)
  assert.equal(recovered.records.length, 9)
  assert.equal(recovered.nextSeq, 10)
  assert.deepEqual(recovered.records.map(item => item.seq), Array.from({ length: 9 }, (_, index) => index + 1))
  assert.deepEqual(recovered.records.map(item => item.messageId).sort(), ['m1', ...Array.from({ length: 8 }, (_, index) => `parallel-${index + 2}`)].sort())
  assert.equal(recovered.summary.text, '从第一条来源总结的主线')
  assert.deepEqual(recovered.episodes, [episode(input.binding)])
})

test('simultaneous catalog additions retain every independently scoped conversation', redisTest, async t => {
  const f = await fixture(t, 'conversation-store-concurrent-catalog')
  const entries = Array.from({ length: 12 }, (_, index) => state(binding({ accountId: `bot-${index}` })))
  const outcomes = await Promise.all(entries.map(entry => createConversationMemoryStore(f.storage).update(entry.id, () => entry)))
  assert.ok(outcomes.every(Boolean))
  assert.deepEqual((await f.store.list()).map(entry => entry.id).sort(), entries.map(entry => entry.id).sort())
})

test('list retries when its catalog snapshot changes before the atomic multi-state read', redisTest, async t => {
  const f = await fixture(t, 'conversation-store-list-snapshot')
  const first = state(), second = state(binding({ conversationId: 'second-room' }))
  await f.store.update(first.id, () => first)
  let changed = false
  const reader = createConversationMemoryStore({
    async get(key) {
      const result = await f.storage.get(key)
      if (key === catalogKey && !changed) { changed = true; await f.store.update(second.id, () => second) }
      return result
    }, eval: f.storage.eval,
  })
  assert.deepEqual((await reader.list()).map(entry => entry.id).sort(), [first.id, second.id].sort())
})

test('synchronous guards fence storage waits, updater side effects and the final commit without leaking an exception', redisTest, async t => {
  const f = await fixture(t, 'conversation-store-guards')
  const input = state()
  let live = true, changed = false, commits = 0
  const store = createConversationMemoryStore({ get: f.storage.get, async eval(script, options) {
    const result = await f.storage.eval(script, options)
    if (script.includes("return {redis.call('GET'")) live = false
    if (script.includes("redis.call('SET'")) commits++
    return result
  } })
  assert.equal(await store.update(input.id, () => { changed = true; return input }, () => live), false)
  assert.equal(changed, false)
  assert.equal(commits, 0)
  live = true
  assert.equal(await f.store.update(input.id, () => { live = false; return input }, () => live), false)
  let checks = 0
  assert.equal(await f.store.update(input.id, () => input, () => ++checks < 4), false)
  assert.equal(checks, 4)
  assert.equal(await f.store.update(input.id, () => input, () => { throw new Error('private guard detail') }), false)
  assert.equal(await f.store.update(input.id, () => input, () => false), false)
  assert.deepEqual(await f.store.list(), [])
})

test('existing source evidence and sequence numbers are immutable and nextSeq never rolls backwards', redisTest, async t => {
  const f = await fixture(t, 'conversation-store-evidence')
  const input = state()
  await f.store.update(input.id, () => input)
  for (const change of [
    value => { value.records[0].at++; return value },
    value => { value.records[0].authorId = 'forged-author'; return value },
    value => { value.records[0].name = 'forged-name'; return value },
    value => { value.records[0].text = 'forged-utterance'; return value },
    value => { value.records[0].seq = 2; value.nextSeq = 3; return value },
    value => { value.records = []; value.nextSeq = 1; return value },
    value => { value.records = [record(1, { messageId: 'replacement' })]; return value },
    value => { value.binding.target.account.id = 'other-bot'; return value },
    value => { value.scope.agentId = 'other'; return value },
  ]) await rejects(f.store.update(input.id, change))
  assert.deepEqual(await f.store.load(input.id), input)
  assert.equal(await f.store.update(input.id, current => { current.records = []; return current }), true)
  assert.equal((await f.store.load(input.id)).nextSeq, 2)
})

test('record, episode, source-ID, summary and catalog limits are enforced without truncating valid evidence', redisTest, async t => {
  const f = await fixture(t, 'conversation-store-bounds')
  const input = state()
  input.records = Array.from({ length: 1000 }, (_, index) => record(index + 1))
  input.records[0].name = '名'.repeat(24)
  input.records[0].text = '文'.repeat(4000)
  input.nextSeq = 1001
  input.episodes = Array.from({ length: 1000 }, (_, index) => episode(input.binding, index + 1))
  input.episodes[0].userName = '人'.repeat(24)
  input.episodes[0].summary = '摘'.repeat(240)
  input.episodes[0].reply = '复'.repeat(240)
  input.episodes[0].messageIds = Array.from({ length: 1000 }, (_, index) => `source-${index}`)
  input.episodes[0].replyIds = Array.from({ length: 1000 }, (_, index) => `reply-${index}`)
  input.summary = { text: '😀'.repeat(4000), updatedAt: epoch, coveredSeq: 1000, invalidatedAt: 0 }
  assert.equal(await f.store.update(input.id, () => input), true)
  for (const change of [
    value => { value.records.push(record(1001)); value.nextSeq++; return value },
    value => { value.records[0].name += '名'; return value },
    value => { value.records[0].text += '文'; return value },
    value => { value.episodes.push(episode(input.binding, 1001)); return value },
    value => { value.episodes[0].userName += '人'; return value },
    value => { value.episodes[0].summary += '摘'; return value },
    value => { value.episodes[0].reply += '复'; return value },
    value => { value.episodes[0].messageIds.push('too-many'); return value },
    value => { value.episodes[0].replyIds.push('too-many'); return value },
    value => { value.summary.text += '😀'; return value },
  ]) await rejects(f.store.update(input.id, change))
  assert.deepEqual(await f.store.load(input.id), input)
  await f.store.update(input.id, current => ({ ...current, records: [], episodes: [], summary: undefined }))
  for (let index = 1; index < 200; index++) {
    const entry = state(binding({ conversationId: `room-${index}` }), { records: [], episodes: [] })
    assert.equal(await f.store.update(entry.id, () => entry), true)
  }
  const excess = state(binding({ conversationId: 'excess-room' }))
  await rejects(f.store.update(excess.id, () => excess))
  assert.equal(await f.rawGet(stateKey(excess.id)), null)
  assert.equal((await f.store.list()).length, 200)
})

test('malformed scopes, source provenance, peers, counters and duplicate IDs fail closed without overwriting persisted state', redisTest, async t => {
  const f = await fixture(t, 'conversation-store-validation')
  const input = state()
  input.episodes = [episode(input.binding)]
  input.summary = { text: '合法摘要', updatedAt: epoch, coveredSeq: 1, invalidatedAt: 0 }
  await f.store.update(input.id, () => input)
  for (const change of [
    value => { value.version = 2; return value },
    value => { value.scope.target.kind = 'unknown-kind'; value.binding.target.kind = 'unknown-kind'; return value },
    value => { value.scope.target.account.extra = 'hidden'; return value },
    value => { value.binding.id = 'forged'; return value },
    value => { value.binding.source = 'legacy'; return value },
    value => { value.binding.connectionId = 'invalid connection id'; return value },
    value => { value.binding.revision = ''; return value },
    value => { value.token = 't'.repeat(4097); return value },
    value => { value.nextSeq = 1; return value },
    value => { value.dueAt = -1; return value },
    value => { value.dueInvalidatedAt = -1; return value },
    value => { value.dueInvalidatedAt = 0.5; return value },
    value => { value.dueInvalidatedAt = null; return value },
    value => { value.retryAt = 0.5; return value },
    value => { value.attempts = NaN; return value },
    value => { value.records[0].messageId = '0'; return value },
    value => { value.records[0].at = 0; return value },
    value => { value.records[0].text = ' '; return value },
    value => { value.records[0].peerId = 'real-author'; return value },
    value => { value.records.push(record(2, { messageId: 'm1' })); value.nextSeq = 3; return value },
    value => { value.records.push(record(1, { messageId: 'new' })); return value },
    value => { value.episodes[0].source.botId = 'forged-bot'; return value },
    value => { value.episodes[0].source.personaId = 'agent:other'; return value },
    value => { delete value.episodes[0].source.personaVersion; return value },
    value => { value.episodes[0].source.personaName = ''; return value },
    value => { value.episodes[0].source.extra = 'runtime-view'; return value },
    value => { value.episodes[0].replyIds = []; return value },
    value => { value.episodes[0].replyIds = ['sent', 'sent']; return value },
    value => { value.episodes[0].messageIds = ['m1', 'm1']; return value },
    value => { value.episodes[0].peerId = 'real-author'; return value },
    value => { value.episodes.push(structuredClone(value.episodes[0])); return value },
    value => { value.episodes[0].at = 0; return value },
    value => { value.episodes[0].invalidatedAt = -1; return value },
    value => { value.summary.coveredSeq = value.nextSeq; return value },
    value => { value.summary.updatedAt = -1; return value },
    value => { value.summary.invalidatedAt = -1; return value },
  ]) await rejects(f.store.update(input.id, change))
  assert.deepEqual(await f.store.load(input.id), input)
  assert.equal(await f.store.update(input.id, current => {
    current.dueAt = 0
    current.dueInvalidatedAt = 0
    current.retryAt = 0
    current.summary = { text: '', updatedAt: 0, coveredSeq: 0, invalidatedAt: 0 }
    current.episodes.push(episode(input.binding, 2, { userId: undefined, userName: '', messageIds: [], reply: '', source: { ...episode(input.binding).source, personaVersion: 'another-historical-version' } }))
    return current
  }), true)
  assert.equal((await f.store.load(input.id)).dueInvalidatedAt, 0)
})

test('corrupted catalogs, malformed states, missing entries and orphaned states block reads and mutations', redisTest, async t => {
  const f = await fixture(t, 'conversation-store-corrupt-storage')
  const input = state()
  for (const invalid of ['{invalid-json', '[]', JSON.stringify({ version: 2, ids: [] }), JSON.stringify({ version: 1, ids: ['bad-id'] }), JSON.stringify({ version: 1, ids: [input.id, input.id] })]) {
    await f.rawSet(catalogKey, invalid)
    await rejects(f.store.list())
    await rejects(f.store.load(input.id))
    await rejects(f.store.update(input.id, () => input))
    assert.equal(await f.rawGet(catalogKey), invalid)
    assert.equal(await f.rawGet(stateKey(input.id)), null)
  }
  await f.rawSet(catalogKey, JSON.stringify({ version: 1, ids: [input.id] }))
  for (const invalid of ['{invalid-json', JSON.stringify({ ...input, version: 2 }), JSON.stringify({ ...input, scope: { ...input.scope, agentId: 'forged' } })]) {
    await f.rawSet(stateKey(input.id), invalid)
    await rejects(f.store.list())
    await rejects(f.store.load(input.id))
    await rejects(f.store.update(input.id, () => undefined))
    assert.equal(await f.rawGet(stateKey(input.id)), invalid)
  }
  await f.rawDelete(stateKey(input.id))
  await rejects(f.store.list())
  await rejects(f.store.load(input.id))
  await rejects(f.store.update(input.id, () => input))
  await f.rawSet(catalogKey, JSON.stringify({ version: 1, ids: [] }))
  await f.rawSet(stateKey(input.id), JSON.stringify(input))
  await rejects(f.store.load(input.id))
  await rejects(f.store.update(input.id, () => input))
  for (const id of ['invalid', '', input.id.toUpperCase()]) {
    await rejects(f.store.load(id))
    await rejects(f.store.update(id, () => input))
  }
})

test('twenty CAS conflicts stop the update while preserving the newer stored state', redisTest, async t => {
  const f = await fixture(t, 'conversation-store-conflicts')
  const input = state()
  await f.store.update(input.id, () => input)
  let conflicts = 0
  const competing = createConversationMemoryStore({ get: f.storage.get, async eval(script, options) {
    if (script.includes("redis.call('SET'")) {
      conflicts++
      const concurrent = JSON.parse(await f.rawGet(stateKey(input.id)))
      concurrent.attempts++
      await f.rawSet(stateKey(input.id), JSON.stringify(concurrent))
    }
    return f.storage.eval(script, options)
  } })
  await rejects(competing.update(input.id, current => ({ ...current, dueAt: epoch + 1000 })))
  assert.equal(conflicts, 20)
  const persisted = await f.store.load(input.id)
  assert.equal(persisted.attempts, 20)
  assert.equal(persisted.dueAt, epoch)
})
