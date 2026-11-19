import assert from 'node:assert/strict'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const { createGroupMemoryStore, groupMemoryId, stageGroupMemoryUpdate } = await load('modules/memory/infrastructure/groupMemoryStore.js')
const { createGroupMemory } = await load('modules/memory/infrastructure/groupMemory.js')
const { createGroupMemoryManagement } = await load('modules/memory/infrastructure/groupMemoryManagement.js')
const { createPersonMemoryStore } = await load('modules/memory/infrastructure/personMemoryStore.js')
const { groupCleanupSelector } = await load('modules/memory/infrastructure/groupMemoryCleanup.js')
const { personMemoryAddress } = await load('modules/memory/infrastructure/personMemoryContext.js')
const { agentBindingToken, agentPersonaScopeId, conversationAddressKey } = await load('modules/runtime/domain/agentBindings.js')
const settings = { skip: !redisAvailable, timeout: 20_000 }
const prefix = 'agent:group-memory:v1', catalogKey = prefix + ':catalog', fenceKey = prefix + ':cleanup'
const stateKey = id => prefix + ':state:' + id, epoch = Date.now()
const account = { platform: 'fixture', namespace: 'group-cleanup', id: 'account-a' }
const deferred = () => Promise.withResolvers()
function binding({ agentId = 'daily', account: selected = account, kind = 'group', id = 'room-a' } = {}) {
  const target = { account: selected, kind, id }
  return { agentId, target, source: 'configured', id: conversationAddressKey(target), revision: 'v1', personaId: 'shared', connectionId: 'connection-a' }
}
function row(index = 1, extras = {}) { return { messageId: 'message-' + index, authorId: 'subject-a', name: '本人', text: 'original text ' + index, at: epoch, mentions: [], files: [], ...extras } }
function entry(selected = binding(), id = 'fact-a', extras = {}) {
  const source = extras.source ?? row(2, { authorId: 'subject-b' })
  return { id, kind: 'fact', key: id, source, excerpt: source.text, createdBy: source.authorId, createdAt: source.at, updatedAt: source.at,
    persona: { botId: personMemoryAddress(selected.target).botId, personaId: agentPersonaScopeId(selected.agentId), personaVersion: 'old-version', personaName: '旧角色' },
    text: 'mixed fact containing subject-a', targetUserIds: [], relatedUserIds: [], tags: [], ...extras }
}
function agent(selected = binding(), extras = {}) {
  return { agentId: selected.agentId, binding: selected, token: agentBindingToken(selected), records: [row()], jobs: [], entries: [], seen: [], consensusDone: [], teachingDone: [], deletedSources: [], nextConsensusAt: 0, ...extras }
}
function job(id = 'job-a', extras = {}) { return { id, mode: 'consensus', messages: [row(), row(2, { authorId: 'subject-b' })], attempts: 0, retryAt: 0, invalidatedAt: 0, ...extras } }
function state(selected = binding(), extras = {}) {
  return { version: 1, id: groupMemoryId(selected.target), target: selected.target, agents: [agent(selected)], entries: [], deletedSources: [], ...extras }
}
const selector = (extras = {}) => ({ account, agentId: 'daily', subjectId: 'subject-a', through: epoch, ...extras })
function guard() { const controller = new AbortController(); return { controller, signal: controller.signal, isCurrent: () => !controller.signal.aborted, async ensureCurrent() { controller.signal.throwIfAborted() } } }
async function fixture(t, name, wrap) {
  const redis = await createAgentRedisFixture(t, name), storage = wrap ? wrap(redis.storage) : redis.storage
  return { ...redis, storage, store: createGroupMemoryStore(storage), raw: key => redis.reader.get(redis.prefix + key), set: (key, value) => redis.reader.set(redis.prefix + key, value) }
}

test('whole-subject purge physically erases originals, pending copies and mixed-source facts only in the selected account and Agent', settings, async t => {
  const f = await fixture(t, 'group-cleanup-physical'), selected = binding(), other = binding({ agentId: 'work' })
  const input = state(selected, { agents: [agent(selected, { records: [row(), row(2, { authorId: 'subject-b' }), row(3, { at: epoch + 1 })], jobs: [job()], entries: [entry()] }), agent(other, { entries: [entry(other, 'work-fact')] })],
    entries: [entry(selected, 'teaching-a', { kind: 'member_definition', subject: '人物定义', targetUserIds: ['subject-a'] }), entry(other, 'work-teaching', { kind: 'member_definition', subject: '另一个Agent的教学', targetUserIds: ['subject-a'] })] })
  const retired = state(binding({ id: 'unbound-room' })), isolated = state(binding({ account: { ...account, namespace: 'elsewhere' } }))
  for (const value of [input, retired, isolated]) await f.store.update(value.id, () => value)
  assert.deepEqual(await f.store.purgeSubject(selector(), guard()), { usage: 'blocked', cleanup: 'completed', removedRecords: 2, removedJobs: 1, removedEntries: 2, removedPartitions: 1 })
  const physical = JSON.parse(await f.raw(stateKey(input.id)))
  assert.deepEqual(physical.agents[0].records, input.agents[0].records.slice(1)); assert.deepEqual(physical.agents[0].jobs, []); assert.deepEqual(physical.agents[0].entries, [])
  assert.deepEqual(physical.agents[1], input.agents[1]); assert.deepEqual(physical.entries, input.entries.slice(1))
  assert.equal(await f.raw(stateKey(retired.id)), null); assert.deepEqual(JSON.parse(await f.raw(stateKey(isolated.id))), isolated)
  assert.equal((await f.raw(fenceKey)).includes('subject-a'), false); assert.equal((await f.raw(fenceKey)).includes('account-a'), false)
})

test('full target selectors distinguish kind, namespace and account while omitted target cleans old unbound scopes', settings, async t => {
  const f = await fixture(t, 'group-cleanup-target'), values = [state(), state(binding({ kind: 'channel' })), state(binding({ id: 'room-b' })), state(binding({ account: { ...account, id: 'account-b' } }))]
  for (const value of values) await f.store.update(value.id, () => value)
  await f.store.purgeSubject(selector({ target: values[0].target }), guard()); assert.equal(await f.raw(stateKey(values[0].id)), null)
  for (const value of values.slice(1)) assert.deepEqual(JSON.parse(await f.raw(stateKey(value.id))), value)
  assert.equal((await f.store.purgeSubject(selector(), guard())).removedRecords, 2)
  assert.deepEqual(JSON.parse(await f.raw(stateKey(values[3].id))), values[3])
})

test('effective sorted subject cutoffs keep rebuilt aggregates on equivalent or older replays and revoke them on a new generation', settings, async t => {
  const f = await fixture(t, 'group-cleanup-generations'), selected = binding(), input = state(selected, { agents: [agent(selected, { records: [row(1, { at: epoch + 1 })] })] })
  await f.store.update(input.id, () => input); await f.store.purgeSubject(selector(), guard())
  const cleanupToken = await f.store.cleanupToken(selected); assert.match(cleanupToken, /^[a-f0-9]{64}$/u)
  assert.equal(await f.store.cleanupToken(binding({ agentId: 'work' })), undefined)
  await f.store.update(input.id, saved => {
    saved.agents[0].entries = [entry(selected, 'rebuilt', { cleanupToken })]
    saved.agents[0].jobs = [job('rebuilt-job', { messages: [row(2, { authorId: 'subject-b' })], cleanupToken })]
    saved.entries = [entry(selected, 'rebuilt-teaching', { kind: 'member_definition', subject: '新教学', targetUserIds: ['subject-b'], cleanupToken })]
    return saved
  })
  const before = await f.raw(stateKey(input.id)), beforeFence = await f.raw(fenceKey)
  assert.equal((await f.store.purgeSubject(selector({ through: epoch - 1 }), guard())).removedEntries, 0)
  assert.equal(await f.raw(fenceKey), beforeFence); assert.equal(await f.raw(stateKey(input.id)), before)
  await f.store.purgeSubject(selector({ target: selected.target, through: epoch - 1 }), guard())
  assert.equal(await f.store.cleanupToken(selected), cleanupToken); assert.equal(await f.raw(stateKey(input.id)), before)
  const independent = await fixture(t, 'group-cleanup-order')
  await independent.store.purgeSubject(selector({ subjectId: 'subject-c' }), guard()); await independent.store.purgeSubject(selector(), guard())
  await f.store.purgeSubject(selector({ subjectId: 'subject-c' }), guard())
  assert.equal(await f.store.cleanupToken(selected), await independent.store.cleanupToken(selected)); assert.notEqual(await f.store.cleanupToken(selected), cleanupToken)
  const raw = JSON.parse(await f.raw(stateKey(input.id)))
  assert.deepEqual(raw.agents[0].records, input.agents[0].records); assert.deepEqual(raw.agents[0].jobs, []); assert.deepEqual(raw.agents[0].entries, []); assert.deepEqual(raw.entries, [])
})

test('stale update callbacks and precomputed migration staging both compare the durable fence and cannot resurrect originals or facts', settings, async t => {
  const f = await fixture(t, 'group-cleanup-stale'), input = state(binding(), { agents: [agent(binding(), { jobs: [job()], entries: [entry()] })] })
  await f.store.update(input.id, () => input)
  const originals = new Map(), staged = new Map()
  const staging = { async get(key) { const value = await f.storage.get(key); originals.set(key, value); return value }, stage(key, value) { assert.ok(originals.has(key)); staged.set(key, value) } }
  await stageGroupMemoryUpdate(staging, input.target, current => { current.deletedSources.push('staged-id'); return current })
  assert.ok(originals.has(fenceKey)); assert.equal(originals.get(fenceKey), null)
  const entered = deferred(), release = deferred(); let gate = true
  const stale = createGroupMemoryStore({ get: f.storage.get, async eval(script, options) {
    const result = await f.storage.eval(script, options)
    if (gate && script.startsWith('return {redis.call')) { gate = false; entered.resolve(); await release.promise }
    return result
  } })
  const pending = stale.update(input.id, () => input)
  await entered.promise; await f.store.purgeSubject(selector(), guard()); release.resolve(); assert.equal(await pending, true)
  assert.equal(await f.raw(stateKey(input.id)), null)
  const keys = [...originals.keys()], args = keys.flatMap(key => [originals.get(key) === null ? '0' : '1', originals.get(key) ?? '', staged.has(key) ? staged.get(key) === null ? 'delete' : 'set' : 'skip', staged.get(key) ?? ''])
  const committed = await f.storage.eval(`for i=1,#KEYS do local a=(i-1)*4 if (redis.call('GET',KEYS[i]) or false)~=(ARGV[a+1]=='1' and ARGV[a+2] or false) then return 0 end end
for i=1,#KEYS do local a=(i-1)*4 if ARGV[a+3]=='set' then redis.call('SET',KEYS[i],ARGV[a+4]) elseif ARGV[a+3]=='delete' then redis.call('DEL',KEYS[i]) end end return 1`, { keys, arguments: args })
  assert.equal(committed, 0); assert.equal(await f.raw(stateKey(input.id)), null)
  const restarted = createGroupMemoryStore(f.storage)
  await restarted.update(input.id, () => input); assert.equal(await f.raw(stateKey(input.id)), null)
  const original2 = new Map(), staged2 = new Map()
  assert.equal(await stageGroupMemoryUpdate({ async get(key) { const value = await f.storage.get(key); original2.set(key, value); return value }, stage(key, value) { staged2.set(key, value) } }, input.target, () => input), undefined)
  assert.ok(original2.has(fenceKey)); assert.equal(staged2.size, 0)
})

test('a physical failure retains a durable read barrier across restart and only a raw retry can prove completed deletion', settings, async t => {
  let unavailable = false
  const f = await fixture(t, 'group-cleanup-unknown', storage => ({ get: storage.get, async eval(script, options) {
    if (unavailable && options.keys.some(key => key.startsWith(prefix + ':state:'))) throw Error('physical read unavailable')
    return storage.eval(script, options)
  } })), input = state(binding(), { agents: [agent(binding(), { jobs: [job()], entries: [entry()] })] })
  await f.store.update(input.id, () => input); unavailable = true
  assert.deepEqual(await f.store.purgeSubject(selector(), guard()), { usage: 'blocked', cleanup: 'unknown', removedRecords: 0, removedJobs: 0, removedEntries: 0, removedPartitions: 0 })
  assert.deepEqual(JSON.parse(await f.raw(stateKey(input.id))), input); unavailable = false
  const restarted = createGroupMemoryStore(f.storage)
  assert.equal(await restarted.load(input.id), undefined); assert.deepEqual(await restarted.list(), [])
  const projected = await restarted.filterState(input)
  assert.deepEqual(projected.agents[0].records, []); assert.deepEqual(projected.agents[0].jobs, []); assert.deepEqual(projected.agents[0].entries, [])
  assert.deepEqual(await restarted.purgeSubject(selector(), guard()), { usage: 'blocked', cleanup: 'completed', removedRecords: 1, removedJobs: 1, removedEntries: 1, removedPartitions: 1 })
  assert.equal(await f.raw(stateKey(input.id)), null); assert.deepEqual(JSON.parse(await f.raw(catalogKey)).ids, [])
})

test('publication errors and asynchronous authority revocation reject instead of reporting a blocked or completed cleanup', settings, async t => {
  let unavailable = false, ambiguous = false
  const f = await fixture(t, 'group-cleanup-authority', storage => ({ get: storage.get, async eval(script, options) {
    const publication = options.keys.length === 1 && options.keys[0] === fenceKey && script.includes("redis.call('SET'")
    if (unavailable && publication) throw Error('publication unavailable')
    const result = await storage.eval(script, options)
    if (ambiguous && publication) throw Error('publication acknowledgement lost')
    return result
  } })), input = state(); await f.store.update(input.id, () => input)
  const denied = guard(); denied.ensureCurrent = async () => { throw Error('authority denied') }
  await assert.rejects(() => f.store.purgeSubject(selector(), denied)); assert.equal(await f.raw(fenceKey), null)
  await assert.rejects(() => f.store.purgeSubject(selector(), { signal: guard().signal, isCurrent: () => true })); assert.equal(await f.raw(fenceKey), null)
  unavailable = true; await assert.rejects(() => f.store.purgeSubject(selector(), guard())); assert.equal(await f.raw(fenceKey), null)
  unavailable = false; ambiguous = true; await assert.rejects(() => f.store.purgeSubject(selector(), guard())); assert.ok(await f.raw(fenceKey))
  assert.deepEqual(JSON.parse(await f.raw(stateKey(input.id))), input); ambiguous = false
  let checks = 0; const late = guard(); late.ensureCurrent = async () => { if (++checks === 3) throw Error('late denial') }
  await assert.rejects(() => f.store.purgeSubject(selector(), late)); assert.deepEqual(JSON.parse(await f.raw(stateKey(input.id))), input)
})

test('abort during a pending raw read stops physical deletion and bounded selector fences never evict earlier cutoffs', settings, async t => {
  const entered = deferred(), release = deferred(); let delayed = false
  const f = await fixture(t, 'group-cleanup-cancel', storage => ({ get: storage.get, async eval(script, options) {
    if (delayed && options.keys.some(key => key.startsWith(prefix + ':state:')) && !script.includes("redis.call('SET'")) { delayed = false; entered.resolve(); await release.promise }
    return storage.eval(script, options)
  } })), input = state(); await f.store.update(input.id, () => input)
  const authority = guard(); delayed = true; const pending = f.store.purgeSubject(selector(), authority)
  await entered.promise; authority.controller.abort(); release.resolve(); await assert.rejects(pending)
  assert.deepEqual(JSON.parse(await f.raw(stateKey(input.id))), input)
  const entries = Array.from({ length: 4096 }, (_, index) => groupCleanupSelector(selector({ subjectId: 'other-' + index })))
  await f.set(fenceKey, JSON.stringify({ version: 1, entries })); const before = await f.raw(fenceKey)
  await assert.rejects(() => f.store.purgeSubject(selector(), guard())); assert.equal(await f.raw(fenceKey), before)
  await f.store.purgeSubject(selector({ subjectId: 'other-0', through: epoch - 1 }), guard()); assert.equal(await f.raw(fenceKey), before)
  await f.set(fenceKey, '{damaged'); await assert.rejects(() => f.store.load(input.id)); await assert.rejects(() => f.store.filterState(input)); await assert.rejects(() => f.store.cleanupToken(binding()))
})

test('forged provenance and malformed job or entry tokens fail validation before cleanup filtering while intentional empty states remain', settings, async t => {
  const f = await fixture(t, 'group-cleanup-validation'), selected = binding(), input = state(selected)
  const empty = state(binding({ id: 'empty-room' }), { agents: [agent(binding({ id: 'empty-room' }), { records: [] })] })
  await f.store.update(input.id, () => input); await f.store.update(empty.id, () => empty)
  for (const token of ['', null, 1, 'a'.repeat(63), 'A'.repeat(64)]) {
    await assert.rejects(() => f.store.update(input.id, current => { current.agents[0].entries = [entry(selected, 'invalid', { cleanupToken: token })]; return current }))
    await assert.rejects(() => f.store.update(input.id, current => { current.agents[0].jobs = [job('invalid-job', { cleanupToken: token })]; return current }))
  }
  await f.store.purgeSubject(selector(), guard())
  assert.deepEqual(JSON.parse(await f.raw(stateKey(empty.id))), empty)
  // This bad source must reject even though the durable fence would remove it.
  await f.set(catalogKey, JSON.stringify({ version: 1, ids: [input.id, empty.id] })); await f.set(stateKey(input.id), JSON.stringify(input))
  await assert.rejects(() => f.store.update(input.id, () => ({ ...input, agents: [agent(selected, { records: [row(1, { text: 'forged original' })] })] })))
  assert.deepEqual(JSON.parse(await f.raw(stateKey(input.id))), input)
})

test('removing the last source preserves another Agent and existing clear, recall and acknowledgement barriers', settings, async t => {
  const f = await fixture(t, 'group-cleanup-metadata'), selected = binding(), other = binding({ agentId: 'work' })
  const metadata = agent(other, { records: [], deletedSources: ['recalled-by-other-agent'], clearedAt: epoch - 1, seen: ['seen-by-other-agent'] })
  const input = state(selected, { agents: [agent(selected), metadata], teachingDeletedSources: ['old-teaching'], teachingClearedAt: epoch - 2 })
  await f.store.update(input.id, () => input)
  assert.equal((await f.store.purgeSubject(selector(), guard())).removedPartitions, 0)
  const raw = JSON.parse(await f.raw(stateKey(input.id)))
  assert.deepEqual(raw.agents[0].records, []); assert.deepEqual(raw.agents[1], metadata)
  assert.deepEqual(raw.teachingDeletedSources, input.teachingDeletedSources); assert.equal(raw.teachingClearedAt, input.teachingClearedAt)
  assert.ok(JSON.parse(await f.raw(catalogKey)).ids.includes(input.id))
})

function runtime(f, selected = binding(), extra = {}) {
  const memory = extra.memory ?? createPersonMemoryStore({ redis: f.storage, now: () => epoch })
  return createGroupMemory({ redis: f.storage, memory, config: () => ({ enabled: true, groupExtractMinIntervalMinutes: 0 }),
    resolve: () => ({ binding: selected, viewer: { botId: personMemoryAddress(selected.target).botId, personaId: agentPersonaScopeId(selected.agentId), personaVersion: 'v1', personaName: '当前角色' } }),
    botUserId: () => 'bot-user', available: () => true, members: async () => undefined, member: async () => undefined,
    isRecalled: async () => false, begin: async () => { const controller = new AbortController(); return { signal: controller.signal, isCurrent: () => !controller.signal.aborted, release() { controller.abort() } } },
    isRunning: () => true, allowsText: () => true, logger: { warn() {} }, now: () => epoch + 10, ...extra })
}

test('runtime cleanup works when learning is disabled and the old scene has no live binding, and stopped authority rejects', settings, async t => {
  const f = await fixture(t, 'group-cleanup-disabled'), input = state(); await f.store.update(input.id, () => input)
  const owner = runtime(f, binding(), { config: () => ({ enabled: false }), available: () => false, resolve: () => { throw Error('old binding gone') } })
  assert.equal((await owner.purgeSubject(selector(), guard())).cleanup, 'completed'); assert.equal(await f.raw(stateKey(input.id)), null)
  await owner.stop(); const before = await f.raw(fenceKey)
  await assert.rejects(() => owner.purgeSubject(selector({ subjectId: 'subject-b' }), guard())); assert.equal(await f.raw(fenceKey), before)
})

test('an already running mixed-source model cannot publish its late fact after cleanup even if it ignores cancellation', settings, async t => {
  const f = await fixture(t, 'group-cleanup-late-model'), selected = binding(), input = state(selected, { agents: [agent(selected, { records: [row(), row(2, { authorId: 'subject-b' })], jobs: [job()] })] })
  await f.store.update(input.id, () => input)
  const entered = deferred(), release = deferred()
  const owner = runtime(f, selected, { async model(_input, context) { entered.resolve(context); await release.promise; return [{ kind: 'fact', sourceIndex: 2, excerpt: row(2, { authorId: 'subject-b' }).text, text: 'late mixed fact from forgotten A' }] } })
  t.after(() => owner.stop()); await owner.tick(); const context = await entered.promise
  assert.equal((await owner.purgeSubject(selector(), guard())).cleanup, 'completed'); assert.equal(context.isCurrent(), false)
  release.resolve(); await new Promise(setImmediate); await owner.stop()
  const physical = JSON.parse(await f.raw(stateKey(input.id)))
  assert.deepEqual(physical.agents[0].records, [input.agents[0].records[1]]); assert.deepEqual(physical.agents[0].jobs, []); assert.deepEqual(physical.agents[0].entries, [])
})

test('runtime and management reads recheck the durable fence after loading an old mixed-source entry', settings, async t => {
  for (const surface of ['runtime', 'management']) {
    const f = await fixture(t, 'group-cleanup-read-' + surface), selected = binding(), input = state(selected, { agents: [agent(selected, { entries: [entry()] })] })
    await f.store.update(input.id, () => input)
    const entered = deferred(), release = deferred(), memory = createPersonMemoryStore({ redis: f.storage, now: () => epoch }); let block = true
    const readerMemory = { ...memory, async getRedactions(query) { if (block) { block = false; entered.resolve(); await release.promise }; return memory.getRedactions(query) } }
    let pending, owner
    if (surface === 'runtime') { owner = runtime(f, selected, { memory: readerMemory }); pending = owner.read(selected, () => true) }
    else {
      const adapter = { id: selected.connectionId, account, botUserId: 'bot-user', isReady: () => true, async readConversationMember(target, user) { return { target, observedAt: Date.now(), member: { user, displayName: user.id, role: 'member' } } } }
      const manager = createGroupMemoryManagement({ redis: f.storage, memory: readerMemory, adapter: () => adapter, resolve: () => ({ binding: selected }), isRecalled: async () => false, now: () => epoch })
      pending = manager.list({ binding: selected, actor: { kind: 'user', user: { ...account, id: 'reader' } }, requestMessageId: 'request-a', signal: new AbortController().signal, isCurrent: () => true, ensureCurrent: async () => {} })
    }
    await entered.promise; await f.store.purgeSubject(selector(), guard()); release.resolve()
    assert.deepEqual(await pending, surface === 'runtime' ? '' : { status: 'listed', entries: [] }); await owner?.stop()
  }
})
