import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createGroupMemoryStore, groupMemoryId, stageGroupMemoryUpdate } from '../dist/backend/modules/memory/infrastructure/groupMemoryStore.js'
import { personMemoryAddress } from '../dist/backend/modules/memory/infrastructure/personMemoryContext.js'
import { agentBindingToken, agentPersonaScopeId, conversationAddressKey } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const redisTest = { skip: !redisAvailable, timeout: 20_000 }
const FAILURE = '群记忆存储不可用或状态无效，已停止读写。'
const base = 'agent:group-memory:v1'
const catalogKey = `${base}:catalog`
const stateKey = id => `${base}:state:${id}`
const epoch = 1_800_000_000_000

function binding({ platform = 'fixture', namespace = 'tenant-a', accountId = 'bot-a', kind = 'group', conversationId = 'room-a', agentId = 'daily', revision = 'first' } = {}) {
  const target = { account: { platform, namespace, id: accountId }, kind, id: conversationId }
  return { source: 'configured', id: conversationAddressKey(target), revision, agentId, personaId: 'shared-template', connectionId: 'fixture', target }
}
function message(index = 1, overrides = {}) {
  return { messageId: `message-${index}`, authorId: 'real-author', name: '当时的名字', text: `原始群发言${index}`,
    at: epoch + index, mentions: ['member-a'], files: [{ name: '地图.zip', reference: 'stable-file-id' }], ...overrides }
}
function entry(selected, index = 1, overrides = {}) {
  const source = message(index)
  return { id: `entry-${index}`, kind: 'member_definition', key: `definition-${index}`, source, excerpt: source.text,
    persona: { botId: personMemoryAddress(selected.target).botId, personaId: agentPersonaScopeId(selected.agentId),
      personaVersion: 'historical-version', personaName: '旧角色名' },
    createdBy: source.authorId, createdAt: epoch, updatedAt: epoch, subject: `组别${index}`,
    targetUserIds: ['member-a'], relatedUserIds: [], tags: [], ...overrides }
}
function agent(selected = binding(), overrides = {}) {
  return { agentId: selected.agentId, binding: selected, token: agentBindingToken(selected), records: [message()], jobs: [], entries: [],
    seen: [], consensusDone: [], teachingDone: [], deletedSources: [], nextConsensusAt: 0, ...overrides }
}
function job(index = 1, overrides = {}) {
  return { id: `job-${index}`, mode: 'consensus', messages: [message(index)], attempts: 0, retryAt: 0, invalidatedAt: 0, ...overrides }
}
function state(selected = binding(), overrides = {}) {
  return { version: 1, id: groupMemoryId(selected.target), target: selected.target, agents: [agent(selected)], entries: [], deletedSources: [], ...overrides }
}
async function fixture(t, name) {
  const redis = await createAgentRedisFixture(t, name)
  return { ...redis, store: createGroupMemoryStore(redis.storage), rawGet: key => redis.reader.get(redis.prefix + key),
    rawSet: (key, value) => redis.reader.set(redis.prefix + key, value), rawDelete: key => redis.reader.del(redis.prefix + key) }
}
async function rejects(operation) {
  await assert.rejects(operation, error => error.message === FAILURE && error.cause === undefined)
}

test('group scheduling discovers jobs added to a warm partition and drops completed jobs', redisTest, async t => {
  const f = await fixture(t, 'group-schedule-snapshot'), input = state()
  await f.store.update(input.id, () => input)
  const reads = []
  const store = createGroupMemoryStore({ ...f.storage, async eval(script, options) {
    const result = await f.storage.eval(script, options)
    if (script.includes('sha1hex') && Array.isArray(result)) reads.push(result.slice(1).filter(value => typeof value === 'string').length)
    return result
  } })
  assert.deepEqual(await store.observeSchedule(), [])
  assert.deepEqual(await store.observeSchedule(), [])
  await f.store.update(input.id, current => {
    current.agents[0].jobs.push(job())
    return current
  })
  const [scheduled] = await store.observeSchedule()
  assert.deepEqual(scheduled.agents[0].jobs, [job()])
  assert.deepEqual(await store.observeSchedule(), [scheduled])
  await f.store.update(input.id, current => {
    current.agents[0].jobs = []
    return current
  })
  assert.deepEqual(await store.observeSchedule(), [])
  assert.deepEqual(reads, [1, 0, 1, 0, 1])
})

function staging(initial = []) {
  const stored = new Map(initial), original = new Map(), staged = new Map(), writes = []
  const storage = {
    async get(key) {
      if (!original.has(key)) original.set(key, stored.get(key) ?? null)
      return staged.has(key) ? staged.get(key) : original.get(key)
    },
    stage(key, value) {
      assert.ok(original.has(key), 'every staged key must have an original comparison')
      staged.set(key, value)
      writes.push(key)
    },
  }
  return { storage, stored, original, staged, writes }
}

function legacyEntry(selected, index = 1, part = 'knowledge') {
  return entry(selected, index, { persona: {
    kind: 'legacy-qq-observation', botId: selected.target.account.id, personaId: agentPersonaScopeId(selected.agentId),
    sourceKey: `ytbot:mem:g:${selected.target.id}:${part}`, recordId: `legacy-${index}`, fingerprint: 'a'.repeat(64),
  } })
}

test('migration staging merges validated state without writing Redis or losing retained Agent evidence', async () => {
  const selected = binding(), input = state(selected), other = binding({ agentId: 'work' })
  input.agents.push(agent(other, { records: [message(2)], entries: [entry(other, 2, { kind: 'fact', text: '保留共识' })] }))
  input.entries = [entry(selected)]
  input.deletedSources = ['revoked-source']
  input.teachingDeletedSources = ['deleted-teaching']
  input.teachingClearedAt = epoch - 1
  const catalogRaw = JSON.stringify({ version: 1, ids: [input.id] }), stateRaw = JSON.stringify(input)
  const f = staging([[catalogKey, catalogRaw], [stateKey(input.id), stateRaw]])
  const next = await stageGroupMemoryUpdate(f.storage, selected.target, current => {
    current.entries.push(entry(selected, 3))
    return current
  })
  assert.deepEqual(next, { ...input, entries: [...input.entries, entry(selected, 3)] })
  assert.deepEqual([...f.stored], [[catalogKey, catalogRaw], [stateKey(input.id), stateRaw]])
  assert.deepEqual([...f.original], [[catalogKey, catalogRaw], [stateKey(input.id), stateRaw], [`${base}:cleanup`, null]])
  assert.deepEqual(JSON.parse(f.staged.get(stateKey(input.id))), next)
  assert.equal(f.staged.get(catalogKey), catalogRaw)
  next.entries[0].source.text = '修改返回值不会改写暂存序列化结果'
  assert.equal(JSON.parse(f.staged.get(stateKey(input.id))).entries[0].source.text, input.entries[0].source.text)
})

test('successive staging uses the caller overlay while retaining the original catalog comparison', async () => {
  const first = state(), second = state(binding({ conversationId: 'another-room' })), f = staging()
  await stageGroupMemoryUpdate(f.storage, first.target, current => { assert.equal(current, undefined); return first })
  await stageGroupMemoryUpdate(f.storage, second.target, () => second)
  assert.deepEqual(JSON.parse(f.staged.get(catalogKey)), { version: 1, ids: [first.id, second.id] })
  assert.deepEqual([...f.original], [[catalogKey, null], [stateKey(first.id), null], [`${base}:cleanup`, null], [stateKey(second.id), null]])
  assert.equal(f.stored.size, 0)
  const count = f.writes.length
  assert.deepEqual(await stageGroupMemoryUpdate(f.storage, first.target, current => current), first)
  assert.equal(f.writes.length, count)
  const empty = staging()
  assert.equal(await stageGroupMemoryUpdate(empty.storage, first.target, () => undefined), undefined)
  assert.equal(empty.staged.size, 0)
  assert.deepEqual([...empty.original], [[catalogKey, null], [stateKey(first.id), null], [`${base}:cleanup`, null]])
})

test('staging rejects damaged catalogs, missing or orphaned documents and all capacity overflow before staging writes', async () => {
  const input = state(), catalogRaw = JSON.stringify({ version: 1, ids: [input.id] }), stateRaw = JSON.stringify(input)
  const full = Array.from({ length: 200 }, (_, index) => state(binding({ conversationId: `full-${index}` })))
  for (const initial of [
    [[catalogKey, '{bad-json']], [[catalogKey, JSON.stringify({ version: 2, ids: [] })]],
    [[catalogKey, JSON.stringify({ version: 1, ids: [input.id, input.id] })]],
    [[catalogKey, catalogRaw]], [[stateKey(input.id), stateRaw]],
    [[catalogKey, catalogRaw], [stateKey(input.id), '{bad-json']],
    [[catalogKey, JSON.stringify({ version: 1, ids: full.map(value => value.id) })]],
  ]) {
    const f = staging(initial)
    await rejects(stageGroupMemoryUpdate(f.storage, input.target, () => input))
    assert.equal(f.staged.size, 0)
    assert.deepEqual([...f.stored], initial)
  }
  for (const change of [
    current => { current.entries = Array.from({ length: 401 }, (_, index) => entry(current.agents[0].binding, index + 1)); return current },
    current => { current.agents.push(...Array.from({ length: 20 }, (_, index) => agent(binding({ agentId: `extra-${index}` })))); return current },
  ]) {
    const f = staging([[catalogKey, catalogRaw], [stateKey(input.id), stateRaw]])
    await rejects(stageGroupMemoryUpdate(f.storage, input.target, change))
    assert.equal(f.staged.size, 0)
  }
})

test('staging shares source immutability and retained Agent transition validation with normal updates', async () => {
  const input = state(), selected = input.agents[0].binding
  input.entries = [entry(selected)]
  for (const change of [
    current => { current.agents[0].records[0].text = '改写旧证据'; return current },
    current => { current.agents[0].records = []; current.entries[0].source.at++; return current },
    current => { current.agents = []; current.entries = []; return current },
    current => { current.agents[0] = agent(binding({ agentId: 'replacement' })); current.entries = []; return current },
    current => { current.target.id = 'another-room'; return current },
    () => { throw new Error('private-storage-secret') },
  ]) {
    const initial = [[catalogKey, JSON.stringify({ version: 1, ids: [input.id] })], [stateKey(input.id), JSON.stringify(input)]]
    const f = staging(initial)
    await rejects(stageGroupMemoryUpdate(f.storage, input.target, change))
    assert.equal(f.staged.size, 0)
    assert.deepEqual([...f.stored], initial)
  }
})

test('legacy QQ teaching keeps an observation provenance without inventing historical persona snapshots', async () => {
  const selected = binding({ platform: 'qq', namespace: 'global', accountId: '10001', conversationId: '20001' })
  for (const part of ['knowledge', 'workflows', 'alias']) {
    const input = state(selected, { entries: [legacyEntry(selected, 1, part)] }), f = staging()
    assert.deepEqual(await stageGroupMemoryUpdate(f.storage, input.target, () => input), input)
    const stored = JSON.parse(f.staged.get(stateKey(input.id))).entries[0].persona
    assert.equal(stored.kind, 'legacy-qq-observation')
    assert.equal(stored.personaVersion, undefined)
    assert.equal(stored.personaName, undefined)
  }
})

test('legacy observations reject invented versions, unknown origins, foreign identities and Agent facts', async () => {
  const selected = binding({ platform: 'qq', namespace: 'global', accountId: '10001', conversationId: '20001' })
  for (const change of [
    value => { value.entries[0].persona.personaVersion = 'fake-history' },
    value => { value.entries[0].persona.personaName = '伪造当时角色' },
    value => { value.entries[0].persona.kind = 'unknown-provenance' },
    value => { delete value.entries[0].persona.kind },
    value => { value.entries[0].persona.sourceKey = 'ytbot:mem:g:other-group:knowledge' },
    value => { value.entries[0].persona.sourceKey = 'ytbot:mem:g:20001:meta' },
    value => { value.entries[0].persona.botId = 'other-bot' },
    value => { value.entries[0].persona.personaId = 'agent:unregistered' },
    value => { value.entries[0].persona.recordId = '0' },
    value => { value.entries[0].persona.recordId = 'x'.repeat(129) },
    value => { value.entries[0].persona.fingerprint = 'a'.repeat(63) },
    value => { value.entries[0].persona.fingerprint = 'z'.repeat(64) },
    value => { value.entries[0].persona.fingerprint = 'A'.repeat(64) },
    value => { const fact = value.entries.pop(); fact.kind = 'fact'; fact.text = '旧教学不可冒充自动共识'; value.agents[0].entries.push(fact) },
  ]) {
    const input = state(selected, { entries: [legacyEntry(selected)] }), f = staging()
    change(input)
    await rejects(stageGroupMemoryUpdate(f.storage, input.target, () => input))
    assert.equal(f.staged.size, 0)
  }
  for (const wrong of [binding(), binding({ platform: 'qq' }), binding({ platform: 'qq', namespace: 'global', kind: 'private' }),
    binding({ platform: 'qq', namespace: 'global', kind: 'channel' }), binding({ platform: 'qq', namespace: 'global', kind: 'thread' })]) {
    const input = state(wrong, { entries: [legacyEntry(wrong)] }), f = staging()
    await rejects(stageGroupMemoryUpdate(f.storage, input.target, () => input))
    assert.equal(f.staged.size, 0)
  }
})

test('shared teaching and Agent facts, sources, jobs and acknowledgements survive restart with prefixed keys', redisTest, async t => {
  const f = await fixture(t, 'group-store-restart'), input = state()
  const selected = input.agents[0].binding
  input.entries = [entry(selected)]
  input.agents[0].entries = [entry(selected, 2, { kind: 'fact', text: '群共识的原意' })]
  input.agents[0].jobs = [job(3, { mode: 'teaching', attempts: 2, retryAt: epoch, invalidatedAt: epoch })]
  input.agents[0].seen = ['message-1']
  input.agents[0].consensusDone = ['message-2']
  input.agents[0].teachingDone = ['message-1']
  input.agents[0].deletedSources = ['revoked-agent-source']
  input.deletedSources = ['revoked-shared-source']
  assert.equal(input.id, createHash('sha256').update(conversationAddressKey(input.target)).digest('hex'))
  assert.deepEqual(await f.store.list(), [])
  assert.equal(await f.store.load(input.id), undefined)
  assert.equal(await f.store.update(input.id, current => { assert.equal(current, undefined); return input }), true)
  const restarted = createGroupMemoryStore(f.storage)
  assert.deepEqual(await restarted.list(), [input])
  assert.deepEqual(await restarted.load(input.id), input)
  assert.equal(await f.reader.exists(catalogKey), 0)
  assert.equal(await f.reader.exists(stateKey(input.id)), 0)
  const copy = await restarted.load(input.id)
  copy.entries[0].source.text = '修改本地副本'
  assert.deepEqual(await restarted.load(input.id), input)
  assert.equal(await restarted.update(input.id, () => undefined), true)
  assert.equal(await restarted.load(input.id), undefined)
  assert.deepEqual(await restarted.list(), [])
  assert.equal(await restarted.update(input.id, () => undefined), true)
})

test('full accounts and conversation kinds partition documents while shared teaching belongs to all retained Agents', redisTest, async t => {
  const f = await fixture(t, 'group-store-identities')
  const entries = [state(), state(binding({ platform: 'matrix' })), state(binding({ namespace: 'tenant-b' })),
    state(binding({ accountId: 'bot-b' })), state(binding({ conversationId: 'room-b' })),
    state(binding({ kind: 'private' })), state(binding({ kind: 'channel' })), state(binding({ kind: 'thread' }))]
  assert.equal(new Set(entries.map(value => value.id)).size, entries.length)
  for (const value of entries) assert.equal(await f.store.update(value.id, () => value), true)
  const original = entries[0], other = binding({ agentId: 'work' })
  assert.equal(groupMemoryId(other.target), original.id)
  assert.equal(await f.store.update(original.id, current => {
    current.agents.push(agent(other, { entries: [entry(other, 2, { kind: 'fact', text: '工作 Agent 独有共识' })] }))
    current.entries.push(entry(other, 3))
    return current
  }), true)
  const revised = binding({ revision: 'reloaded' })
  await f.store.update(original.id, current => {
    current.agents[0].binding = revised
    current.agents[0].token = 'updated-routing-token'
    return current
  })
  const loaded = await f.store.load(original.id)
  assert.equal(loaded.agents[0].binding.revision, 'reloaded')
  assert.equal(loaded.entries[0].persona.personaId, 'agent:work')
  assert.equal(loaded.entries[0].persona.personaVersion, 'historical-version')
  assert.equal(loaded.agents[0].entries.length, 0)
  assert.equal(loaded.agents[1].entries[0].text, '工作 Agent 独有共识')
  assert.deepEqual((await f.store.list()).map(value => value.id).sort(), entries.map(value => value.id).sort())
})

test('concurrent CAS writes retain shared teaching, each Agent fact, ingress, jobs and acknowledgements', redisTest, async t => {
  const f = await fixture(t, 'group-store-concurrent'), input = state()
  input.agents.push(agent(binding({ agentId: 'work' })))
  await f.store.update(input.id, () => input)
  const parallel = 10, gate = Promise.withResolvers()
  let reads = 0
  const gated = { get: f.storage.get, async eval(script, options) {
    const result = await f.storage.eval(script, options)
    if (script.includes("return {redis.call('GET'") && reads < parallel) {
      if (++reads === parallel) gate.resolve()
      await gate.promise
    }
    return result
  } }
  const outcomes = await Promise.all(Array.from({ length: parallel }, (_, index) => createGroupMemoryStore(gated).update(input.id, current => {
    const owner = current.agents[index % 2]
    owner.records.push(message(index + 10))
    owner.jobs.push(job(index + 10))
    owner.entries.push(entry(owner.binding, index + 10, { kind: 'fact', text: `共识${index}` }))
    owner.seen.push(`message-${index + 10}`)
    owner.consensusDone.push(`done-${index}`)
    current.entries.push(entry(owner.binding, index + 10))
    return current
  })))
  assert.ok(outcomes.every(Boolean))
  const loaded = await f.store.load(input.id)
  assert.equal(loaded.entries.length, parallel)
  for (const owner of loaded.agents) {
    assert.equal(owner.records.length, 6)
    assert.equal(owner.jobs.length, 5)
    assert.equal(owner.entries.length, 5)
    assert.equal(owner.seen.length, 5)
    assert.equal(owner.consensusDone.length, 5)
    assert.ok(owner.entries.every(value => value.persona.personaId === agentPersonaScopeId(owner.agentId)))
  }
})

test('concurrent catalog writes and catalog changes during list preserve all documents', redisTest, async t => {
  const f = await fixture(t, 'group-store-catalog')
  const entries = Array.from({ length: 10 }, (_, index) => state(binding({ conversationId: `room-${index}` })))
  assert.ok((await Promise.all(entries.map(value => f.store.update(value.id, () => value)))).every(Boolean))
  const last = state(binding({ conversationId: 'new-room' }))
  let changed = false
  const reader = createGroupMemoryStore({ async get(key) {
    const result = await f.storage.get(key)
    if (!changed) { changed = true; await f.store.update(last.id, () => last) }
    return result
  }, eval: f.storage.eval })
  assert.deepEqual((await reader.list()).map(value => value.id).sort(), [...entries, last].map(value => value.id).sort())
})

test('synchronous revocation guards fence reads, updater work and the final commit, including thrown guards', redisTest, async t => {
  const f = await fixture(t, 'group-store-guards'), input = state()
  let live = true, changes = 0, commits = 0
  const store = createGroupMemoryStore({ get: f.storage.get, async eval(script, options) {
    const result = await f.storage.eval(script, options)
    if (script.includes("return {redis.call('GET'")) live = false
    if (script.includes("redis.call('SET'")) commits++
    return result
  } })
  assert.equal(await store.update(input.id, () => { changes++; return input }, () => live), false)
  assert.equal(changes, 0)
  assert.equal(commits, 0)
  live = true
  assert.equal(await f.store.update(input.id, () => { live = false; return input }, () => live), false)
  let checks = 0
  assert.equal(await f.store.update(input.id, () => input, () => ++checks < 4), false)
  assert.equal(checks, 4)
  assert.equal(await f.store.update(input.id, () => input, () => { throw new Error('secret scope detail') }), false)
  assert.deepEqual(await f.store.list(), [])
})

test('retained source evidence is immutable across records, jobs, shared entries and Agent transitions', redisTest, async t => {
  const f = await fixture(t, 'group-store-immutable'), input = state()
  input.entries = [entry(input.agents[0].binding)]
  input.agents[0].jobs = [job()]
  await f.store.update(input.id, () => input)
  for (const change of [
    value => { value.agents[0].records[0].text = '伪造内容'; return value },
    value => { for (const source of [value.agents[0].records[0], value.agents[0].jobs[0].messages[0], value.entries[0].source]) source.at++; return value },
    value => { value.agents[0].records[0].mentions = []; return value },
    value => { value.agents[0].records[0].files[0].reference = 'another-id'; return value },
    value => { value.agents[0].records[0].name = '伪造名字'; return value },
    value => { value.agents[0].records[0].authorId = 'forged'; return value },
    value => { value.agents[0].records = []; value.agents[0].jobs = []; value.entries[0].source.name = '移位后伪造'; return value },
    value => { value.agents = []; value.entries = []; return value },
    value => { value.agents[0].agentId = 'renamed'; value.agents[0].binding.agentId = 'renamed'; value.entries = []; return value },
  ]) await rejects(f.store.update(input.id, change))
  assert.deepEqual(await f.store.load(input.id), input)
  assert.equal(await f.store.update(input.id, value => { value.agents[0].records = []; value.agents[0].jobs = []; return value }), true)
  assert.equal((await f.store.load(input.id)).entries[0].source.text, input.entries[0].source.text)
})

test('malformed ownership, bindings, entry kinds, provenance and job state fail closed', redisTest, async t => {
  const f = await fixture(t, 'group-store-invalid'), input = state()
  input.entries = [entry(input.agents[0].binding)]
  input.agents[0].jobs = [job()]
  await f.store.update(input.id, () => input)
  for (const change of [
    value => { value.version = 2; return value },
    value => { value.target.id = 'other-room'; return value },
    value => { value.agents[0].binding.source = 'legacy'; return value },
    value => { value.agents[0].binding.target.account.id = 'different-account'; return value },
    value => { value.agents[0].binding.id = 'forged-binding'; return value },
    value => { value.agents[0].binding.agentId = 'foreign'; return value },
    value => { value.agents[0].token = ''; return value },
    value => { value.agents[0].records[0].text = '   '; return value },
    value => { value.agents[0].records[0].at = 0; return value },
    value => { value.agents[0].records[0].at = 0.5; return value },
    value => { value.agents[0].records[0].messageId = '0'; return value },
    value => { value.agents[0].records[0].mentions = ['member-a', 'member-a']; return value },
    value => { value.agents.push(structuredClone(value.agents[0])); return value },
    value => { value.entries[0].kind = 'fact'; value.entries[0].text = '不能共享自动共识'; return value },
    value => { value.agents[0].entries.push(entry(value.agents[0].binding)); return value },
    value => { value.entries[0].createdBy = 'someone-else'; return value },
    value => { value.entries[0].excerpt = '原文不存在的证据'; return value },
    value => { value.entries[0].persona.botId = 'another-account'; return value },
    value => { value.entries[0].persona.personaId = 'agent:unregistered'; return value },
    value => { value.entries[0].persona.systemContent = '不应存储的提示词'; return value },
    value => { value.entries[0].targetUserIds.push('member-a'); return value },
    value => { value.agents[0].entries.push(entry(binding({ agentId: 'work' }), 2, { kind: 'fact', text: '错误归属' })); return value },
    value => { value.agents[0].jobs[0].mode = 'unknown'; return value },
    value => { value.agents[0].jobs[0].attempts = 4; return value },
    value => { value.agents[0].jobs[0].retryAt = -1; return value },
    value => { value.agents[0].jobs[0].invalidatedAt = 0.5; return value },
    value => { value.agents[0].jobs[0].messages = []; return value },
    value => { value.agents[0].jobs.push(structuredClone(value.agents[0].jobs[0])); return value },
    value => { value.deletedSources = ['0']; return value },
    value => { value.agents[0].seen = ['source', 'source']; return value },
    value => { value.agents[0].nextConsensusAt = Number.MAX_SAFE_INTEGER + 1; return value },
    value => { value.entries[0].unrecognized = true; return value },
  ]) await rejects(f.store.update(input.id, change))
  assert.deepEqual(await f.store.load(input.id), input)
})

test('file references accept stable opaque IDs and reject URLs, local paths and extra transport metadata', redisTest, async t => {
  const f = await fixture(t, 'group-store-files')
  for (const reference of [undefined, 'stable:id/part', 'opaque-file-id']) {
    const input = state(binding({ conversationId: `valid-${reference ?? 'name-only'}`.replaceAll('/', '-') }))
    input.agents[0].records[0].files = [{ name: '合法名称.zip', ...(reference === undefined ? {} : { reference }) }]
    assert.equal(await f.store.update(input.id, () => input), true)
  }
  for (const file of [
    { name: 'a', reference: 'https://temporary.example/file' }, { name: 'a', reference: 'file:///tmp/a' },
    { name: 'a', reference: '/tmp/a' }, { name: 'a', reference: 'C:\\Temp\\a' }, { name: 'a', reference: '../secret' },
    { name: 'a', reference: '\\\\server\\share' }, { name: 'a', reference: '~/private' },
    { name: 'a', reference: 'data:text/plain,secret' }, { name: 'a', reference: 'x'.repeat(241) },
    { name: 'a'.repeat(181) }, { name: 'a', reference: 'stable', url: 'https://temporary.example' },
  ]) {
    const input = state()
    input.agents[0].records[0].files = [file]
    await rejects(f.store.update(input.id, () => input))
    assert.equal(await f.store.load(input.id), undefined)
  }
})

test('document, Agent, source and acknowledgement limits reject overflow without truncating evidence', redisTest, async t => {
  const f = await fixture(t, 'group-store-limits'), input = state()
  const owner = input.agents[0]
  owner.records = Array.from({ length: 60 }, (_, i) => message(i + 1))
  owner.records[0].name = '名'.repeat(24)
  owner.records[0].text = '文'.repeat(4000)
  owner.records[0].mentions = Array.from({ length: 50 }, (_, i) => `member-${i}`)
  owner.records[0].files = Array.from({ length: 20 }, (_, i) => ({ name: `文件${i}`, reference: `opaque-${i}` }))
  owner.jobs = Array.from({ length: 60 }, (_, i) => job(i + 100))
  owner.jobs[0].messages = Array.from({ length: 40 }, (_, i) => message(i + 100))
  owner.entries = Array.from({ length: 50 }, (_, i) => entry(owner.binding, i + 200, { kind: 'fact', text: `共识${i}` }))
  input.entries = Array.from({ length: 400 }, (_, i) => entry(owner.binding, i + 1000))
  for (const key of ['seen', 'consensusDone', 'teachingDone', 'deletedSources']) owner[key] = Array.from({ length: 1000 }, (_, i) => `id-${i}`)
  input.deletedSources = [...owner.deletedSources]
  input.agents.push(...Array.from({ length: 19 }, (_, i) => agent(binding({ agentId: `agent-${i}` }), { records: [] })))
  assert.equal(await f.store.update(input.id, () => input), true)
  for (const change of [
    value => { value.agents.push(agent(binding({ agentId: 'overflow' }))); return value },
    value => { value.agents[0].records.push(message(999)); return value },
    value => { value.agents[0].records[0].name += '名'; return value },
    value => { value.agents[0].records[0].text += '文'; return value },
    value => { value.agents[0].records[0].mentions.push('overflow'); return value },
    value => { value.agents[0].records[0].files.push({ name: 'overflow' }); return value },
    value => { value.agents[0].jobs.push(job(999)); return value },
    value => { value.agents[0].jobs[0].messages.push(message(999)); return value },
    value => { value.agents[0].entries.push(entry(owner.binding, 999, { kind: 'fact', text: 'overflow' })); return value },
    value => { value.entries.push(entry(owner.binding, 999)); return value },
    ...['seen', 'consensusDone', 'teachingDone', 'deletedSources'].map(key => value => { value.agents[0][key].push('overflow'); return value }),
    value => { value.deletedSources.push('overflow'); return value },
  ]) await rejects(f.store.update(input.id, change))
  assert.deepEqual(await f.store.load(input.id), input)
})

test('a full 200-conversation catalog permits updates and deletion but refuses a new conversation', redisTest, async t => {
  const f = await fixture(t, 'group-store-full-catalog')
  const entries = Array.from({ length: 200 }, (_, i) => state(binding({ conversationId: `room-${i}` })))
  for (const value of entries) await f.rawSet(stateKey(value.id), JSON.stringify(value))
  await f.rawSet(catalogKey, JSON.stringify({ version: 1, ids: entries.map(value => value.id) }))
  assert.equal((await f.store.list()).length, 200)
  const overflow = state(binding({ conversationId: 'overflow' }))
  await rejects(f.store.update(overflow.id, () => overflow))
  assert.equal(await f.store.load(overflow.id), undefined)
  assert.equal(await f.store.update(entries[0].id, value => { value.agents[0].nextConsensusAt = epoch; return value }), true)
  assert.equal(await f.store.update(entries[1].id, () => undefined), true)
  assert.equal(await f.store.update(overflow.id, () => overflow), true)
  assert.equal((await f.store.list()).length, 200)
})

test('corrupted catalogs, malformed documents, missing and orphaned states block reads and mutations', redisTest, async t => {
  const f = await fixture(t, 'group-store-corruption'), input = state()
  for (const invalid of ['{bad-json', '[]', JSON.stringify({ version: 2, ids: [] }), JSON.stringify({ version: 1, ids: ['invalid'] }),
    JSON.stringify({ version: 1, ids: [input.id, input.id] })]) {
    await f.rawSet(catalogKey, invalid)
    await rejects(f.store.list()); await rejects(f.store.load(input.id)); await rejects(f.store.update(input.id, () => input))
    assert.equal(await f.rawGet(catalogKey), invalid)
  }
  await f.rawSet(catalogKey, JSON.stringify({ version: 1, ids: [input.id] }))
  for (const invalid of ['{bad-json', JSON.stringify({ ...input, version: 2 }), JSON.stringify({ ...input, target: { ...input.target, id: 'forged' } })]) {
    await f.rawSet(stateKey(input.id), invalid)
    await rejects(f.store.list()); await rejects(f.store.load(input.id)); await rejects(f.store.update(input.id, () => undefined))
    assert.equal(await f.rawGet(stateKey(input.id)), invalid)
  }
  await f.rawDelete(stateKey(input.id))
  await rejects(f.store.list()); await rejects(f.store.load(input.id)); await rejects(f.store.update(input.id, () => input))
  await f.rawSet(catalogKey, JSON.stringify({ version: 1, ids: [] }))
  await f.rawSet(stateKey(input.id), JSON.stringify(input))
  await rejects(f.store.load(input.id)); await rejects(f.store.update(input.id, () => input))
  for (const id of ['', 'bad-id', input.id.toUpperCase()]) {
    await rejects(f.store.load(id)); await rejects(f.store.update(id, () => input))
  }
})

test('twenty CAS conflicts stop without overwriting newer state or leaking storage secrets', redisTest, async t => {
  const f = await fixture(t, 'group-store-conflicts'), input = state()
  await f.store.update(input.id, () => input)
  let conflicts = 0
  const competing = createGroupMemoryStore({ get: f.storage.get, async eval(script, options) {
    if (script.includes("redis.call('SET'")) {
      conflicts++
      const value = JSON.parse(await f.rawGet(stateKey(input.id)))
      value.agents[0].nextConsensusAt++
      await f.rawSet(stateKey(input.id), JSON.stringify(value))
    }
    return f.storage.eval(script, options)
  } })
  await rejects(competing.update(input.id, value => { value.deletedSources.push('should-not-commit'); return value }))
  assert.equal(conflicts, 20)
  assert.equal((await f.store.load(input.id)).agents[0].nextConsensusAt, 20)
  assert.deepEqual((await f.store.load(input.id)).deletedSources, [])
  const unavailable = createGroupMemoryStore({ async get() { throw new Error('redis://private:secret@host') }, async eval() { throw new Error('private-credential') } })
  await rejects(unavailable.list()); await rejects(unavailable.load(input.id)); await rejects(unavailable.update(input.id, () => input))
})
