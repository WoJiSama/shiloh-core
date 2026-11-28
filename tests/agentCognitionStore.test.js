import assert from 'node:assert/strict'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const { COGNITION_LIMITS, cognitionKey, cognitionSourceId, createEmptyCognitionState, validateCognitionState,
  recordCognitionSources, invalidateCognitionState } = await load('modules/memory/domain/cognitionState.js')
const { createCognitionStore } = await load('modules/memory/infrastructure/cognitionStore.js')
const { agentErrorDetails } = await load('modules/runtime/infrastructure/agentDiagnostics.js')
const agentId = 'daily', at = 1_800_000_000_000
const scene = (id = 'room-a', kind = 'group') => ({ account: { platform: 'qq', namespace: 'global', id: 'bot-a' }, kind, id })
function source(nativeId = 'message-1', overrides = {}) {
  const row = { agentId, conversation: scene(), kind: 'message', nativeId, authorId: 'user-a', occurredAt: at,
    content: '和大家合作完成了游戏任务', revision: 1, participantIds: ['user-a'], status: 'active', ...overrides }
  return { ...row, id: cognitionSourceId(row.agentId, row.conversation, row.kind, row.nativeId) }
}
const expression = (nativeId, overrides = {}) => source(nativeId, { kind: 'self-expression', authorId: 'bot-a', participantIds: ['bot-a'], ...overrides })
function node(id, evidence, overrides = {}) {
  return { id, kind: 'experience', content: '一次合作游戏经历', topic: '游戏', epistemic: 'observed',
    conversation: evidence[0].conversation, audience: 'scene', sourceIds: evidence.map(row => row.id),
    sourceVersions: Object.fromEntries(evidence.map(row => [row.id, row.revision])), status: 'active', createdAt: at, updatedAt: at, ...overrides }
}
function withNodes(...evidence) {
  const state = recordCognitionSources(createEmptyCognitionState(agentId), evidence)
  state.nodes = evidence.map((row, index) => node(`node-${index}`, [row]))
  return state
}
function guard() {
  let valid = true
  const controller = new AbortController()
  return { signal: controller.signal, isCurrent: () => valid, async ensureCurrent() { assert.ok(valid) },
    revoke() { valid = false }, abort() { controller.abort() } }
}
function memoryRedis(kv = new Map(), atomic = false) {
  const control = { beforeGet: undefined, beforeCommit: undefined, failWrite: false, commits: 0 }
  const redis = {
    async get(key) { await control.beforeGet?.(key); return kv.get(key) ?? null },
    async set(key, value) { if (control.failWrite) throw new Error('write failed'); kv.set(key, value); control.commits++; return 'OK' },
  }
  if (atomic) redis.eval = async (_script, { keys: [key], arguments: [exists, previous, mode, next] }) => {
    await control.beforeCommit?.(key)
    if (exists === '0' ? kv.has(key) : kv.get(key) !== previous) return 0
    if (mode === 'set') {
      if (control.failWrite) throw new Error('write failed')
      kv.set(key, next); control.commits++
    }
    return 1
  }
  return { redis, kv, control }
}

test('cognition source IDs bind the full address, agent, kind and native event; state remains per agent', () => {
  const base = source(), others = [source('other'), source('message-1', { agentId: 'other' }),
    source('message-1', { kind: 'receipt' }), source('message-1', { conversation: scene('room-b') }),
    source('message-1', { conversation: scene('room-a', 'private') }),
    ...['platform', 'namespace', 'id'].map(field => source('message-1', { conversation: { ...scene(), account: { ...scene().account, [field]: 'other' } } }))]
  assert.equal(new Set([base, ...others].map(row => row.id)).size, others.length + 1)
  assert.notEqual(cognitionKey(agentId), cognitionKey('other'))
  assert.throws(() => cognitionKey('../other'))
  assert.throws(() => recordCognitionSources(createEmptyCognitionState(agentId), [others[1]]))
})

test('store preserves evidence across recreation and exact replay does not advance revision', async () => {
  const f = memoryRedis(), store = createCognitionStore(f.redis), evidence = source()
  assert.deepEqual(await store.read(agentId), createEmptyCognitionState(agentId))
  const saved = await store.update(agentId, state => recordCognitionSources(state, [evidence]), guard())
  assert.equal(saved.revision, 1)
  const replay = await store.update(agentId, state => recordCognitionSources(state, [evidence]), guard())
  assert.equal(replay.revision, 1)
  assert.equal(f.control.commits, 1)
  saved.sources[0].content = '局部修改'
  assert.equal((await createCognitionStore(f.redis).read(agentId)).sources[0].content, evidence.content)
})

test('shared get/set substitute serializes store instances, and write failure releases the queue', async () => {
  const f = memoryRedis(), stores = [createCognitionStore(f.redis), createCognitionStore(f.redis)]
  f.control.beforeGet = () => new Promise(resolve => setTimeout(resolve, 1))
  await Promise.all(Array.from({ length: 12 }, (_, i) => stores[i % 2].update(agentId, state => recordCognitionSources(state, [source(`m${i}`)]), guard())))
  assert.equal((await stores[0].read(agentId)).revision, 12)
  assert.equal((await stores[0].read(agentId)).sources.length, 12)
  f.control.failWrite = true
  await assert.rejects(stores[0].update(agentId, state => recordCognitionSources(state, [source('retry')]), guard()), error => {
    assert.match(error.message, /write failed/u)
    assert.equal(agentErrorDetails(error)?.step, 'cognition_store_commit')
    return true
  })
  f.control.failWrite = false
  assert.equal((await stores[1].update(agentId, state => recordCognitionSources(state, [source('retry')]), guard())).revision, 13)
})

test('independent clients use compare-and-set so a concurrent erasure wins over a late source', async () => {
  const kv = new Map(), first = memoryRedis(kv, true), second = memoryRedis(kv, true)
  const a = createCognitionStore(first.redis), b = createCognitionStore(second.redis)
  let injected = false
  first.control.beforeCommit = async () => {
    if (injected) return
    injected = true
    await b.update(agentId, state => invalidateCognitionState(state, { id: 'erase', conversation: scene(), before: at }), guard())
  }
  const saved = await a.update(agentId, state => recordCognitionSources(state, [source()]), guard())
  assert.equal(saved.sources[0].status, 'revoked')
  assert.equal(saved.sources[0].content, '')
  assert.equal(saved.invalidations[0].id, 'erase')
  assert.equal(saved.revision, 2)
})

test('corrupt or foreign storage is never replaced by an empty state', async () => {
  for (const raw of ['{bad', JSON.stringify(createEmptyCognitionState('other')), JSON.stringify({ version: 999 }), 5]) {
    const f = memoryRedis(), store = createCognitionStore(f.redis)
    f.kv.set(cognitionKey(agentId), raw)
    await assert.rejects(store.read(agentId))
    let invoked = false
    await assert.rejects(store.update(agentId, () => { invoked = true }, guard()))
    assert.equal(invoked, false)
    assert.equal(f.kv.get(cognitionKey(agentId)), raw)
  }
})

test('revoked guards before and after an await prevent storage mutation', async () => {
  const f = memoryRedis(), store = createCognitionStore(f.redis), selected = guard()
  f.control.beforeGet = () => selected.revoke()
  await assert.rejects(store.update(agentId, state => recordCognitionSources(state, [source()]), selected))
  assert.equal(f.control.commits, 0)
  const aborted = guard(); aborted.abort()
  await assert.rejects(store.update(agentId, state => state, aborted))
})

test('source corrections invalidate old derived content and links, while stale and duplicate replays are inert', () => {
  const old = source(), other = source('m2'), state = withNodes(old, other)
  state.links = [{ id: 'supports-1', from: old.id, to: 'node-0', kind: 'supports', sourceIds: [old.id] }]
  const corrected = { ...old, revision: 2, content: '实际上没有完成游戏任务' }
  const next = recordCognitionSources(state, [corrected])
  assert.equal(next.nodes[0].status, 'invalid')
  assert.equal(next.nodes[1].status, 'active')
  assert.deepEqual(next.links, [])
  assert.deepEqual(recordCognitionSources(next, [old, corrected]), next)
  assert.throws(() => recordCognitionSources(state, [{ ...old, content: 'same revision forged' }]))
  assert.throws(() => recordCognitionSources(state, [{ ...corrected, authorId: 'forged' }]))
  assert.equal(state.nodes[0].status, 'active', 'pure function leaves input intact')
})

test('tombstones intersect scene/author/time selectors and block future ingestion without deleting unrelated tasks', () => {
  const selected = source(), other = source('other', { conversation: scene('room-b') }), later = source('later', { occurredAt: at + 1 })
  const state = withNodes(selected, other, later)
  state.nodes[1].kind = 'goal'
  const rule = { id: 'forget-person', conversation: scene(), authorId: 'user-a', before: at }
  const next = invalidateCognitionState(state, rule)
  assert.deepEqual(next.sources.map(s => s.status), ['revoked', 'active', 'active'])
  assert.deepEqual(next.nodes.map(s => s.status), ['invalid', 'active', 'active'])
  assert.equal(next.nodes[1].kind, 'goal')
  const delayed = recordCognitionSources(next, [source('late-arrival'), { ...selected, revision: 5 }])
  assert.equal(delayed.sources[0].status, 'revoked')
  assert.equal(delayed.sources[0].revision, 1)
  assert.equal(delayed.sources.at(-1).status, 'revoked')
  assert.deepEqual(invalidateCognitionState(next, rule), next)
  assert.throws(() => invalidateCognitionState(next, { ...rule, before: at + 1 }))
})

test('account tombstones isolate the same author across account IDs, namespaces and platforms and fence late sources', () => {
  const target = scene('user-a', 'private'), account = target.account
  const selected = source('shared-native', { conversation: target })
  const sameAccount = source('same-account', { conversation: scene('room-b') })
  const foreign = ['id', 'namespace', 'platform'].map(field => source('shared-native', {
    conversation: { ...target, account: { ...account, [field]: 'other' } },
  }))
  const otherAuthor = source('other-author', { conversation: target, authorId: 'user-b', participantIds: ['user-b'] })
  const later = source('later', { conversation: target, occurredAt: at + 1 })
  const rule = { id: 'forget-account-person', account, authorId: 'user-a', before: at }
  const next = invalidateCognitionState(withNodes(selected, sameAccount, ...foreign, otherAuthor, later), rule)
  assert.deepEqual(next.sources.map(row => row.status), ['revoked', 'revoked', 'active', 'active', 'active', 'active', 'active'])
  assert.deepEqual(next.nodes.map(row => row.status), ['invalid', 'invalid', 'active', 'active', 'active', 'active', 'active'])
  const delayed = recordCognitionSources(next, [source('late-target', { conversation: target }),
    source('late-other-account', { conversation: foreign[0].conversation })])
  assert.equal(delayed.sources.at(-2).status, 'revoked')
  assert.equal(delayed.sources.at(-2).content, '')
  assert.equal(delayed.sources.at(-1).status, 'active')
})

test('account invalidation intersects every selector and omitted account retains agent-wide author erasure', () => {
  const selected = source(), otherScene = source('other-scene', { conversation: scene('room-b') })
  const otherAuthor = source('other-author', { authorId: 'user-b', participantIds: ['user-b'] }), otherId = source('other-id')
  const foreign = source('foreign', { conversation: { ...scene(), account: { ...scene().account, namespace: 'other' } } })
  const state = withNodes(selected, otherScene, otherAuthor, otherId, foreign)
  const rule = { id: 'intersect', account: scene().account, conversation: scene(),
    sourceIds: [selected.id, otherScene.id, otherAuthor.id, foreign.id], authorId: 'user-a', before: at }
  assert.deepEqual(invalidateCognitionState(state, rule).sources.map(row => row.status), ['revoked', 'active', 'active', 'active', 'active'])
  assert.deepEqual(invalidateCognitionState(state, { ...rule, account: foreign.conversation.account }).sources.map(row => row.status),
    ['active', 'active', 'active', 'active', 'active'])
  assert.deepEqual(invalidateCognitionState(state, { id: 'legacy-agent-author', authorId: 'user-a', before: at }).sources.map(row => row.status),
    ['revoked', 'revoked', 'active', 'revoked', 'revoked'])
})

test('account selectors require an exact valid platform, namespace and ID record', () => {
  const target = scene().account
  for (const account of [null, [], {}, { platform: 'qq', namespace: 'global' },
    { ...target, platform: ' qq' }, { ...target, namespace: '' }, { ...target, id: ' ' }, { ...target, extra: true }]) {
    const rule = { id: 'invalid-account', account, before: at }
    assert.throws(() => invalidateCognitionState(createEmptyCognitionState(agentId), rule))
    assert.throws(() => validateCognitionState({ ...createEmptyCognitionState(agentId), invalidations: [rule] }))
  }
})

test('persisted account tombstone replay keeps its original cutoff and preserves new evidence', async () => {
  const f = memoryRedis(), store = createCognitionStore(f.redis), target = scene('user-a', 'private')
  const rule = { id: 'privacy-replay', account: target.account, authorId: 'user-a', before: at }
  await store.update(agentId, state => invalidateCognitionState(state, rule), guard())
  const saved = await store.update(agentId, state => recordCognitionSources(state, [
    source('late-old', { conversation: target }), source('new-after-command', { conversation: target, occurredAt: at + 1 }),
  ]), guard())
  const replay = await createCognitionStore(f.redis).update(agentId, state => invalidateCognitionState(state, structuredClone(rule)), guard())
  assert.deepEqual(replay, saved)
  assert.equal(replay.privacyRevision, 1)
  assert.equal(replay.invalidations[0].before, at)
  assert.deepEqual(replay.sources.map(row => row.status), ['revoked', 'active'])
  assert.equal(replay.sources[1].content, '和大家合作完成了游戏任务')
  assert.equal(f.control.commits, 2)
})

test('explicit unknown source tombstones survive restart and prevent rehydration of the deleted native event', async () => {
  const f = memoryRedis(), evidence = source(), store = createCognitionStore(f.redis)
  await store.update(agentId, state => invalidateCognitionState(state, { id: 'native-recall', sourceIds: [evidence.id], before: at }), guard())
  const restarted = createCognitionStore(f.redis)
  const next = await restarted.update(agentId, state => recordCognitionSources(state, [evidence]), guard())
  assert.equal(next.sources[0].status, 'revoked')
  assert.equal(next.privacyRevision, 1)
  await assert.rejects(restarted.update(agentId, state => { state.invalidations = [] }, guard()))
})

test('every active node requires current source versions and scene-consistent evidence', () => {
  const evidence = source(), state = withNodes(evidence)
  for (const edit of [
    s => { s.nodes[0].sourceIds = []; s.nodes[0].sourceVersions = {} },
    s => { s.nodes[0].sourceIds = ['unknown']; s.nodes[0].sourceVersions = { unknown: 1 } },
    s => { s.nodes[0].sourceVersions[evidence.id] = 0 },
    s => { s.nodes[0].sourceVersions.extra = 1 },
    s => { s.nodes[0].conversation = scene('elsewhere') },
    s => { s.sources[0].status = 'revoked' },
  ]) { const bad = structuredClone(state); edit(bad); assert.throws(() => validateCognitionState(bad)) }
  const own = expression('expression-1'), shared = withNodes(own)
  shared.nodes[0].audience = 'self'; shared.nodes[0].kind = 'interest'; shared.nodes[0].conversation = scene('elsewhere')
  assert.doesNotThrow(() => validateCognitionState(shared))
})

function dependentExpressions() {
  const raw = source(), first = expression('first'), second = expression('second'), independent = expression('independent')
  const state = withNodes(raw, first, second, independent)
  state.nodes[2].audience = 'self'; state.nodes[2].kind = 'interest'
  state.links = [
    { id: 'raw-first', from: raw.id, to: first.id, kind: 'supports', sourceIds: [raw.id] },
    { id: 'first-node', from: 'node-1', to: second.id, kind: 'result', sourceIds: [first.id] },
    { id: 'unrelated', from: raw.id, to: independent.id, kind: 'related', sourceIds: [raw.id] },
  ]
  return { state, raw, first, second, independent }
}

test('source/node evidence chains recursively revoke derived expressions and self nodes, but related links do not revoke their targets', () => {
  const { state, raw, first, second, independent } = dependentExpressions()
  assert.doesNotThrow(() => validateCognitionState(state))
  const next = invalidateCognitionState(state, { id: 'forget-root', sourceIds: [raw.id], before: Number.MAX_SAFE_INTEGER })
  for (const id of [raw.id, first.id, second.id]) {
    const row = next.sources.find(s => s.id === id)
    assert.equal(row.status, 'revoked'); assert.equal(row.content, '')
  }
  assert.equal(next.sources.find(s => s.id === independent.id).status, 'active')
  assert.deepEqual(next.nodes.map(n => n.status), ['invalid', 'invalid', 'invalid', 'active'])
  assert.deepEqual(next.links, [])
  assert.deepEqual(recordCognitionSources(next, [{ ...first, revision: 9 }, second]), next)
})

test('source revision changes retire downstream expressions even when they arrive revised in the same batch', () => {
  const { state, raw, first, second } = dependentExpressions()
  const next = recordCognitionSources(state, [{ ...raw, revision: 2, content: '新事实' }, { ...first, revision: 2, content: '旧依据的新版自述' }])
  assert.equal(next.sources.find(s => s.id === raw.id).status, 'active')
  for (const id of [first.id, second.id]) {
    assert.equal(next.sources.find(s => s.id === id).status, 'revoked')
    assert.equal(next.sources.find(s => s.id === id).content, '')
  }
  assert.equal(next.nodes[2].status, 'invalid')
})

test('store cannot hide dependent expressions by dropping their edges in the same correction', async () => {
  const { state, raw } = dependentExpressions(), f = memoryRedis(), store = createCognitionStore(f.redis)
  await store.update(agentId, () => state, guard())
  await assert.rejects(store.update(agentId, s => {
    s.sources.find(row => row.id === raw.id).revision++
    s.nodes[0].status = 'invalid'; s.links = []
  }, guard()))
  const saved = await store.update(agentId, s => recordCognitionSources(s, [{ ...raw, revision: 2, content: '修订' }]), guard())
  assert.deepEqual(saved.sources.map(s => s.status), ['active', 'revoked', 'revoked', 'active'])
})

test('evidence cycles include source-to-source and implicit source-to-node dependencies', () => {
  const { state, raw, first } = dependentExpressions()
  assert.throws(() => validateCognitionState({ ...state, links: [...state.links,
    { id: 'source-cycle', from: first.id, to: raw.id, kind: 'refines', sourceIds: [first.id] }] }))
  assert.throws(() => validateCognitionState({ ...state, links: [...state.links,
    { id: 'implicit-cycle', from: 'node-1', to: first.id, kind: 'supports', sourceIds: [raw.id] }] }))
})

test('self storage rejects private, foreign-author, third-party and unsupported-kind projections', () => {
  const own = expression('self'), valid = withNodes(own)
  valid.nodes[0].audience = 'self'; valid.nodes[0].kind = 'interest'
  assert.doesNotThrow(() => validateCognitionState(valid))
  for (const badSource of [source(), expression('private', { conversation: scene('user-a', 'private') }),
    expression('foreign', { authorId: 'user-a' }), expression('others', { participantIds: ['bot-a', 'user-a'] }),
    expression('missing-participant', { participantIds: [] })]) {
    const state = withNodes(badSource); state.nodes[0].audience = 'self'; state.nodes[0].kind = 'interest'
    assert.throws(() => validateCognitionState(state))
  }
  for (const kind of ['experience', 'procedure', 'page', 'goal', 'receipt', 'person', 'observation']) {
    const state = structuredClone(valid); state.nodes[0].kind = kind
    assert.throws(() => validateCognitionState(state))
  }
})

test('a self habit needs two independently identified group expressions rather than source revisions', () => {
  const first = expression('first'), second = expression('second'), state = withNodes(first)
  state.nodes[0].audience = 'self'; state.nodes[0].kind = 'habit'
  assert.throws(() => validateCognitionState(state))
  const ready = recordCognitionSources(createEmptyCognitionState(agentId), [first, second])
  ready.nodes.push(node('habit', [first, second], { audience: 'self', kind: 'habit' }))
  assert.doesNotThrow(() => validateCognitionState(ready))
  const revised = recordCognitionSources(createEmptyCognitionState(agentId), [first, { ...first, revision: 2 }])
  revised.nodes.push(node('habit', revised.sources, { audience: 'self', kind: 'habit' }))
  assert.throws(() => validateCognitionState(revised))
})

test('links require existing endpoints and evidence; directed evidence cycles are rejected', () => {
  const evidence = source(), state = withNodes(evidence)
  state.nodes.push(node('node-1', [evidence]))
  const link = { id: 'link-1', from: 'node-0', to: 'node-1', kind: 'supports', sourceIds: [evidence.id] }
  for (const overrides of [{ to: 'unknown' }, { sourceIds: [] }, { sourceIds: ['unknown'] }, { to: 'node-0' }]) {
    assert.throws(() => validateCognitionState({ ...state, links: [{ ...link, ...overrides }] }))
  }
  assert.throws(() => validateCognitionState({ ...state, links: [link, { ...link, id: 'link-2', from: 'node-1', to: 'node-0' }] }))
  assert.doesNotThrow(() => validateCognitionState({ ...state, links: [link, { ...link, id: 'link-2', from: 'node-1', to: 'node-0', kind: 'related' }] }))
})

test('superseded chains are acyclic, keep older versions retired and cannot revive after deleting the successor', async () => {
  const evidence = source(), state = withNodes(evidence), f = memoryRedis(), store = createCognitionStore(f.redis)
  state.nodes[0].status = 'superseded'
  state.nodes.push(node('node-1', [evidence], { supersedes: 'node-0' }))
  await store.update(agentId, () => state, guard())
  await assert.rejects(store.update(agentId, s => { s.nodes[0].status = 'active' }, guard()))
  await assert.rejects(store.update(agentId, s => { s.nodes.pop(); s.nodes[0].status = 'active' }, guard()))
  const cyclic = structuredClone(state); cyclic.nodes[0].supersedes = 'node-1'; cyclic.nodes[1].status = 'superseded'
  assert.throws(() => validateCognitionState(cyclic))
  await store.update(agentId, s => invalidateCognitionState(s, { id: 'delete', sourceIds: [evidence.id], before: at }), guard())
  await assert.rejects(store.update(agentId, s => { s.nodes[0].status = 'superseded' }, guard()))
})

test('processed fingerprints and revoked sources cannot be discarded by arbitrary mutators', async () => {
  const f = memoryRedis(), store = createCognitionStore(f.redis), evidence = source()
  await store.update(agentId, state => { const next = recordCognitionSources(state, [evidence]); next.processed.push('processed-1'); return next }, guard())
  await assert.rejects(store.update(agentId, state => { state.processed = [] }, guard()))
  await store.update(agentId, state => invalidateCognitionState(state, { id: 'delete', before: at }), guard())
  await assert.rejects(store.update(agentId, state => { state.sources = [] }, guard()))
  await assert.rejects(store.update(agentId, state => { state.sources[0].status = 'active' }, guard()))
})

test('capacity exhaustion rejects a write instead of compacting away evidence or tombstones', async () => {
  const f = memoryRedis(), store = createCognitionStore(f.redis)
  await store.update(agentId, state => recordCognitionSources(state, [source()]), guard())
  const before = f.kv.get(cognitionKey(agentId))
  await assert.rejects(store.update(agentId, state => { state.processed = Array.from({ length: COGNITION_LIMITS.processed + 1 }, (_, i) => `done-${i}`) }, guard()))
  assert.equal(f.kv.get(cognitionKey(agentId)), before)
})

test('real Redis CAS persists prefixed state and combines separate-client concurrent updates', { skip: !redisAvailable, timeout: 20_000 }, async t => {
  const f = await createAgentRedisFixture(t, 'cognition-store'), a = createCognitionStore(f.storage)
  const b = createCognitionStore({ get: key => f.storage.get(key), set: (key, value) => f.storage.set(key, value), eval: (script, options) => f.storage.eval(script, options) })
  await Promise.all(Array.from({ length: 6 }, (_, i) => (i % 2 ? a : b).update(agentId, state => recordCognitionSources(state, [source(`native-${i}`)]), guard())))
  const saved = await a.read(agentId)
  assert.equal(saved.revision, 6)
  assert.equal(saved.sources.length, 6)
  assert.equal(await f.reader.exists(cognitionKey(agentId)), 0)
  assert.equal(await f.reader.exists(f.prefix + cognitionKey(agentId)), 1)
})
