import assert from 'node:assert/strict'
import test from 'node:test'
import { createGroupMemoryManagement } from '../dist/backend/modules/memory/infrastructure/groupMemoryManagement.js'
import { createGroupMemoryStore, groupMemoryId } from '../dist/backend/modules/memory/infrastructure/groupMemoryStore.js'
import { createPersonMemoryStore } from '../dist/backend/modules/memory/infrastructure/personMemoryStore.js'
import { personMemoryAddress } from '../dist/backend/modules/memory/infrastructure/personMemoryContext.js'
import { agentBindingToken, agentPersonaScopeId, conversationAddressKey, platformAccountKey } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const redisTest = { skip: !redisAvailable, timeout: 20_000 }, epoch = 1_800_000_000_000
const account = { platform: 'fixture', namespace: 'management', id: 'bot-a' }
const target = { account, kind: 'group', id: 'group-a' }
function binding(agentId = 'daily', room = target, revision = 'first') {
  return { source: 'configured', id: conversationAddressKey(room), target: room, agentId, revision, connectionId: 'fixture', personaId: 'shared-template' }
}
function message(index = 1, change = {}) {
  return { messageId: `message-${index}`, authorId: 'creator', name: '真实作者', text: `真实群教学原文${index}`,
    at: epoch - 10_000 + index, mentions: [], files: [], ...change }
}
function entry(index = 1, change = {}, selected = binding()) {
  const source = change.source ?? message(index), kind = change.kind ?? 'member_definition'
  return { id: `entry-${index}`, key: `key-${index}`, kind, source, excerpt: source.text,
    persona: { botId: personMemoryAddress(selected.target).botId, personaId: agentPersonaScopeId(selected.agentId), personaVersion: 'old-version', personaName: '当时角色' },
    createdBy: source.authorId, createdAt: source.at, updatedAt: source.at, targetUserIds: kind === 'fact' ? [] : ['member-a'], relatedUserIds: [], tags: [],
    ...(kind === 'fact' ? { text: `群内说法${index}` } : kind === 'workflow' ? { condition: `排练条件${index}` } : { subject: `美术组${index}` }), ...change }
}
function agent(selected = binding(), change = {}) {
  return { agentId: selected.agentId, binding: selected, token: agentBindingToken(selected), records: [], jobs: [], entries: [], seen: [],
    consensusDone: [], teachingDone: [], deletedSources: [], nextConsensusAt: 0, ...change }
}
function job(id, mode, source) { return { id, mode, messages: [source], attempts: 0, retryAt: 0, invalidatedAt: 0 } }
function state(change = {}) { return { version: 1, id: groupMemoryId(target), target, entries: [], agents: [agent(), agent(binding('work'))], deletedSources: [], ...change } }
async function fixture(t, name) {
  const redis = await createAgentRedisFixture(t, name), clock = { at: epoch }
  const store = createGroupMemoryStore(redis.storage), memory = createPersonMemoryStore({ redis: redis.storage, now: () => clock.at })
  const roles = new Map([['creator', 'member'], ['other', 'member'], ['admin', 'admin'], ['owner', 'owner']])
  const bindings = new Map([[conversationAddressKey(target), binding()]]), reads = [], recalled = new Set()
  let hook
  const adapter = { account, id: 'fixture', botUserId: 'bot-actor', botName: '角色', isReady: () => true,
    async start() {}, stop() {}, actions: { async send() { throw Error('management cannot send') } },
    async readConversationMember(room, user, options) {
      reads.push({ room, user, options })
      const modified = await hook?.(room, user, options)
      if (modified !== undefined) return modified
      return { target: room, observedAt: Date.now(), member: { user, displayName: user.id, role: roles.get(user.id) ?? 'unknown' } }
    },
  }
  const make = (storage = redis.storage, extra = {}) => createGroupMemoryManagement({ redis: storage, memory,
    adapter: room => platformAccountKey(room.account) === platformAccountKey(account) ? adapter : undefined,
    resolve: room => { const selected = bindings.get(conversationAddressKey(room)); return selected && { binding: selected } },
    isRecalled: async (_room, id) => recalled.has(id), now: () => clock.at, ...extra })
  const manager = make()
  return { ...redis, clock, store, memory, roles, bindings, reads, recalled, adapter, manager, make,
    hook(value) { hook = value },
    context(userId = 'creator', selected = bindings.get(conversationAddressKey(target)), requestMessageId = 'request-first', overrides = {}) {
      return { binding: selected, actor: { kind: 'user', user: { ...selected.target.account, id: userId } }, requestMessageId,
        signal: new AbortController().signal, isCurrent: () => true, ensureCurrent: async () => {}, ...overrides }
    },
    async save(value) { await store.update(value.id, () => value); return value },
    load: () => store.load(groupMemoryId(target)),
    identity: selected => ({ botId: personMemoryAddress(selected.target).botId, personaId: agentPersonaScopeId(selected.agentId) }),
  }
}

test('management lists shared teaching and current Agent facts with freshly verified member scope', redisTest, async t => {
  const f = await fixture(t, 'management-list'), input = state({ entries: [entry(1), entry(2, {}, binding('work'))] })
  input.agents[0].entries = [entry(3, { kind: 'fact' })]
  input.agents[1].entries = [entry(4, { kind: 'fact' }, binding('work'))]
  await f.save(input)
  assert.deepEqual((await f.manager.list(f.context())).entries.map(row => row.id), ['entry-1', 'entry-2', 'entry-3'])
  assert.equal(f.reads.length, 2)
  assert.ok(f.reads.every(read => read.user.id === 'creator' && read.options.isCurrent() === false))
  f.bindings.set(conversationAddressKey(target), binding('work'))
  assert.deepEqual((await f.manager.list(f.context())).entries.map(row => row.id), ['entry-1', 'entry-2', 'entry-4'])
  const sibling = { ...target, id: 'other-group' }
  f.bindings.set(conversationAddressKey(sibling), binding('daily', sibling))
  assert.deepEqual(await f.manager.list(f.context('creator', binding('daily', sibling))), { status: 'listed', entries: [] })
  assert.equal((await f.manager.list(f.context('creator', binding('daily', { ...target, kind: 'private' })))).status, 'forbidden')
})

test('deleting one owned teaching entry revokes every shared item from its source and all pending teaching copies without touching facts', redisTest, async t => {
  const f = await fixture(t, 'management-shared-delete'), source = message(1), input = state({ entries: [entry(1), entry(2, { kind: 'alias', source }), entry(3, { kind: 'workflow', source })] })
  for (const [index, owner] of input.agents.entries()) {
    owner.records = [source]
    owner.jobs = [job(`teaching-${index}`, 'teaching', source), job(`consensus-${index}`, 'consensus', source)]
    owner.entries = [entry(index + 10, { kind: 'fact', source }, owner.binding)]
  }
  await f.save(input)
  assert.deepEqual(await f.manager.delete({ id: 'entry-1' }, f.context()), { status: 'deleted', deleted: 3 })
  const saved = await f.load()
  assert.deepEqual(saved.entries, [])
  assert.deepEqual(saved.teachingDeletedSources, ['message-1'])
  assert.deepEqual(saved.deletedSources, [])
  for (const owner of saved.agents) {
    assert.equal(owner.entries.length, 1)
    assert.equal(owner.records.length, 1)
    assert.deepEqual(owner.jobs.map(row => row.mode), ['consensus'])
  }
  assert.deepEqual((await f.manager.list(f.context())).entries.map(row => row.kind), ['fact'])
})

test('deleting a current Agent fact keeps shared teaching, original records, teaching jobs and other Agent facts from the same source', redisTest, async t => {
  const f = await fixture(t, 'management-fact-delete'), source = message(1), input = state({ entries: [entry(1)] })
  for (const [index, owner] of input.agents.entries()) {
    owner.records = [source]
    owner.jobs = [job(`teaching-${index}`, 'teaching', source), job(`consensus-${index}`, 'consensus', source)]
    owner.entries = [entry(index + 10, { kind: 'fact', source }, owner.binding)]
  }
  await f.save(input)
  assert.deepEqual(await f.manager.delete({ id: 'entry-10' }, f.context()), { status: 'deleted', deleted: 1 })
  const saved = await f.load()
  assert.equal(saved.entries.length, 1)
  assert.deepEqual(saved.agents[0].deletedSources, ['message-1'])
  assert.deepEqual(saved.agents[0].records, [source])
  assert.deepEqual(saved.agents[0].jobs.map(row => row.mode), ['teaching'])
  assert.equal(saved.agents[1].entries.length, 1)
  assert.equal(saved.agents[1].jobs.length, 2)
  assert.deepEqual((await f.make().list(f.context())).entries.map(row => row.id), ['entry-1'])
})

test('members may delete only their own records and message-provided roles never grant authority', redisTest, async t => {
  const f = await fixture(t, 'management-owner-permission'), input = state({ entries: [entry(1, { source: message(1, { authorId: 'other' }) })] })
  await f.save(input)
  const forged = f.context('creator', binding(), 'request', { role: 'owner', isAdmin: true })
  assert.deepEqual(await f.manager.delete({ id: 'entry-1' }, forged), { status: 'forbidden' })
  assert.deepEqual(await f.manager.clear({}, forged), { status: 'forbidden' })
  assert.deepEqual(await f.load(), input)
  f.roles.set('creator', 'admin')
  assert.deepEqual(await f.manager.delete({ id: 'entry-1' }, f.context()), { status: 'deleted', deleted: 1 })
  await f.save(input)
  let calls = 0
  f.hook(async () => { if (++calls === 2) f.roles.set('creator', 'member') })
  assert.deepEqual(await f.manager.delete({ id: 'entry-1' }, f.context()), { status: 'forbidden' })
  assert.deepEqual(await f.load(), input)
})

test('exact subject forgetting rejects ambiguity and fuzzy matches while removing one atomic source group', redisTest, async t => {
  const f = await fixture(t, 'management-forget'), first = entry(1, { subject: '美术组' }), second = entry(2, { subject: '美术组' })
  await f.save(state({ entries: [first, second] }))
  assert.deepEqual(await f.manager.forget({ subject: '美术组' }, f.context()), { status: 'ambiguous' })
  assert.deepEqual(await f.manager.forget({ subject: '美术' }, f.context()), { status: 'not_found' })
  const related = entry(3, { kind: 'alias', source: first.source, subject: '美术组' })
  await f.save(state({ entries: [first, related] }))
  assert.deepEqual(await f.manager.forget({ subject: '美术组' }, f.context()), { status: 'deleted', deleted: 2 })
  assert.deepEqual((await f.load()).teachingDeletedSources, ['message-1'])
})

test('listing applies source revocation and current, origin and related-person privacy before exposing entries', redisTest, async t => {
  const f = await fixture(t, 'management-list-privacy'), input = state({ entries: [entry(1), entry(2), entry(3, { source: message(3, { authorId: 'opted-out' }) }),
    entry(4, { relatedUserIds: ['blocked-related'] }), entry(5, {}, binding('work'))] })
  await f.save(input)
  f.recalled.add('message-2')
  await f.memory.setEnabled({ identity: f.identity(binding()), subjectId: 'opted-out', enabled: false })
  await f.memory.setEnabled({ identity: f.identity(binding()), subjectId: 'blocked-related', enabled: false })
  await f.memory.setEnabled({ identity: f.identity(binding('work')), subjectId: 'creator', enabled: false })
  assert.deepEqual((await f.manager.list(f.context())).entries.map(row => row.id), ['entry-1'])
  assert.deepEqual((await f.make().list(f.context())).entries.map(row => row.id), ['entry-1'])
})

test('listing respects teaching-only tombstones and cutoffs while keeping facts independently scoped', redisTest, async t => {
  const f = await fixture(t, 'management-list-cutoff'), source = message(1), newer = message(2, { at: epoch - 1 })
  const input = state({ entries: [entry(1), entry(2, { source: newer }), entry(3, { source: message(3, { at: epoch - 1 }) })],
    teachingClearedAt: epoch - 1000, teachingDeletedSources: ['message-3'] })
  input.agents[0].entries = [entry(10, { kind: 'fact', source }), entry(11, { kind: 'fact', source: newer })]
  input.agents[0].deletedSources = ['message-2']
  await f.save(input)
  assert.deepEqual((await f.manager.list(f.context())).entries.map(row => row.id), ['entry-2', 'entry-10'])
  await f.store.update(input.id, value => { value.deletedSources = ['message-2']; return value })
  assert.deepEqual((await f.manager.list(f.context())).entries.map(row => row.id), ['entry-10'])
  await f.store.update(input.id, value => { value.agents[0].clearedAt = epoch; return value })
  assert.deepEqual((await f.manager.list(f.context())).entries, [])
})

test('listing rejects an origin persona privacy revocation during its final adapter read', redisTest, async t => {
  const f = await fixture(t, 'management-origin-privacy-race')
  await f.save(state({ entries: [entry(1, {}, binding('work'))] }))
  let reads = 0
  f.hook(async () => {
    if (++reads === 2) await f.memory.setEnabled({ identity: f.identity(binding('work')), subjectId: 'creator', enabled: false })
  })
  assert.deepEqual(await f.manager.list(f.context()), { status: 'cancelled' })
  assert.deepEqual((await f.make().list(f.context())).entries, [])
})

test('clear requires another genuine message, the same user and the complete bound conversation before its 30 second deadline', redisTest, async t => {
  const f = await fixture(t, 'management-clear-confirm'), input = state({ entries: [entry(1)] })
  await f.save(input)
  const first = await f.manager.clear({}, f.context('admin'))
  assert.equal(first.status, 'confirmation_required')
  assert.equal(first.expiresAt, epoch + 30_000)
  assert.deepEqual(await f.manager.clear({ confirmationId: first.confirmationId }, f.context('admin')), { status: 'invalid_confirmation' })
  assert.deepEqual(await f.manager.clear({ confirmationId: first.confirmationId }, f.context('owner', binding(), 'confirm-message')), { status: 'invalid_confirmation' })
  const sibling = { ...target, id: 'other-group' }
  f.bindings.set(conversationAddressKey(sibling), binding('daily', sibling))
  assert.deepEqual(await f.manager.clear({ confirmationId: first.confirmationId }, f.context('admin', binding('daily', sibling), 'confirm-message')), { status: 'invalid_confirmation' })
  const revised = binding('daily', target, 'second')
  f.bindings.set(conversationAddressKey(target), revised)
  assert.deepEqual(await f.manager.clear({ confirmationId: first.confirmationId }, f.context('admin', revised, 'confirm-message')), { status: 'invalid_confirmation' })
  f.bindings.set(conversationAddressKey(target), binding())
  f.clock.at += 30_000
  assert.deepEqual(await f.manager.clear({ confirmationId: first.confirmationId }, f.context('admin', binding(), 'confirm-message')), { status: 'invalid_confirmation' })
  assert.deepEqual(await f.load(), input)
})

test('confirmed clear atomically removes shared teaching and current Agent state but preserves other Agent facts and records', redisTest, async t => {
  const f = await fixture(t, 'management-clear-scope'), sharedSource = message(1), input = state({ entries: [entry(1), entry(2)] })
  for (const [index, owner] of input.agents.entries()) {
    owner.records = [sharedSource, message(3)]
    owner.jobs = [job(`teaching-${index}`, 'teaching', sharedSource), job(`consensus-${index}`, 'consensus', message(3))]
    owner.entries = [entry(index + 10, { kind: 'fact', source: sharedSource }, owner.binding)]
    owner.nextConsensusAt = epoch + 60_000
  }
  await f.save(input)
  const first = await f.manager.clear({}, f.context('admin'))
  f.clock.at += 29_999
  assert.deepEqual(await f.manager.clear({ confirmationId: first.confirmationId }, f.context('admin', binding(), 'actual-confirmation')), { status: 'cleared', deleted: 3 })
  const saved = await f.load()
  assert.equal(saved.teachingClearedAt, f.clock.at)
  assert.equal(saved.agents[0].clearedAt, f.clock.at)
  assert.deepEqual(saved.entries, [])
  assert.deepEqual(saved.agents[0].entries, [])
  assert.deepEqual(saved.agents[0].records, [])
  assert.deepEqual(saved.agents[0].jobs, [])
  assert.deepEqual(saved.agents[0].deletedSources.sort(), ['message-1', 'message-3'])
  assert.equal(saved.agents[1].entries.length, 1)
  assert.equal(saved.agents[1].records.length, 2)
  assert.deepEqual(saved.agents[1].jobs.map(row => row.mode), ['consensus'])
  f.bindings.set(conversationAddressKey(target), binding('work'))
  assert.deepEqual((await f.make().list(f.context())).entries.map(row => row.id), ['entry-11'])
  f.bindings.set(conversationAddressKey(target), binding())
  assert.deepEqual(await f.manager.clear({ confirmationId: first.confirmationId }, f.context('admin', binding(), 'another-confirmation')), { status: 'invalid_confirmation' })
})

test('confirmed clear persists both cutoffs even before the current Agent has any stored input', redisTest, async t => {
  const f = await fixture(t, 'management-empty-clear')
  const first = await f.manager.clear({}, f.context('admin'))
  assert.deepEqual(await f.manager.clear({ confirmationId: first.confirmationId }, f.context('admin', binding(), 'confirm-empty')), { status: 'cleared', deleted: 0 })
  const saved = await f.load()
  assert.deepEqual(saved.target, target)
  assert.equal(saved.id, groupMemoryId(target))
  assert.equal(saved.teachingClearedAt, epoch)
  assert.deepEqual(saved.agents, [agent(binding(), { clearedAt: epoch })])

  const other = await fixture(t, 'management-missing-agent-clear')
  const sibling = state({ agents: [agent(binding('work'))], entries: [entry(2, {}, binding('work'))] })
  await other.save(sibling)
  const next = await other.manager.clear({}, other.context('admin'))
  assert.deepEqual(await other.manager.clear({ confirmationId: next.confirmationId }, other.context('admin', binding(), 'confirm-missing-agent')), { status: 'cleared', deleted: 1 })
  const refreshed = await other.load()
  assert.equal(refreshed.agents.length, 2)
  assert.deepEqual(refreshed.agents.find(owner => owner.agentId === 'work'), sibling.agents[0])
  assert.deepEqual(refreshed.agents.find(owner => owner.agentId === 'daily'), agent(binding(), { clearedAt: epoch }))
})

test('clear rechecks real roles and expiration immediately before persistence', redisTest, async t => {
  const f = await fixture(t, 'management-clear-role'), input = state({ entries: [entry(1)] })
  await f.save(input)
  const first = await f.manager.clear({}, f.context('admin'))
  f.roles.set('admin', 'member')
  assert.deepEqual(await f.manager.clear({ confirmationId: first.confirmationId }, f.context('admin', binding(), 'confirmation')), { status: 'forbidden' })
  f.roles.set('admin', 'admin')
  let calls = 0
  f.hook(async () => { if (++calls === 2) f.clock.at += 30_000 })
  assert.deepEqual(await f.manager.clear({ confirmationId: first.confirmationId }, f.context('admin', binding(), 'confirmation')), { status: 'invalid_confirmation' })
  assert.deepEqual(await f.load(), input)
})

test('unsupported, stale, mismatched or unknown adapter membership evidence never grants management access', redisTest, async t => {
  const f = await fixture(t, 'management-membership'), input = state({ entries: [entry(1)] })
  await f.save(input)
  for (const change of [
    { observedAt: Date.now() - 6000 }, { observedAt: Date.now() + 6000 }, { target: { ...target, id: 'wrong-group' } },
    { member: { user: { ...account, id: 'other' }, displayName: '其他人', role: 'owner' } },
    { member: { user: { ...account, namespace: 'foreign', id: 'creator' }, displayName: '伪造作者', role: 'owner' } },
    { member: { user: { ...account, id: 'creator' }, displayName: '作者', role: 'unknown' } },
  ]) {
    f.hook(async (_room, user) => ({ target, observedAt: Date.now(), member: { user, displayName: '作者', role: 'owner' }, ...change }))
    assert.deepEqual(await f.manager.delete({ id: 'entry-1' }, f.context()), { status: 'forbidden' })
  }
  f.hook(undefined)
  const noReader = { ...f.adapter, readConversationMember: undefined }
  assert.deepEqual(await f.make(f.storage, { adapter: () => noReader }).list(f.context()), { status: 'forbidden' })
  assert.deepEqual(await f.load(), input)
})

test('cancelled or rebound operations cannot commit after an asynchronous adapter read', redisTest, async t => {
  const f = await fixture(t, 'management-cancel'), input = state({ entries: [entry(1)] })
  await f.save(input)
  for (const mode of ['abort', 'rebind']) {
    f.bindings.set(conversationAddressKey(target), binding())
    const controller = new AbortController()
    f.hook(async () => { if (mode === 'abort') controller.abort(); else f.bindings.set(conversationAddressKey(target), binding('daily', target, 'changed')); await new Promise(resolve => setTimeout(resolve, 30)) })
    assert.deepEqual(await f.manager.delete({ id: 'entry-1' }, f.context('creator', binding(), `request-${mode}`, { signal: controller.signal })), { status: 'cancelled' })
    assert.deepEqual(await f.load(), input)
  }
})

test('CAS cancellation at the storage boundary refuses every deletion without partial tombstones', redisTest, async t => {
  const f = await fixture(t, 'management-cas-cancel'), input = state({ entries: [entry(1)] })
  await f.save(input)
  let live = true
  const manager = f.make({ get: f.storage.get, async eval(script, options) {
    const result = await f.storage.eval(script, options)
    if (script.includes("return {redis.call('GET'")) live = false
    return result
  } })
  assert.deepEqual(await manager.delete({ id: 'entry-1' }, f.context('creator', binding(), 'request', { isCurrent: () => live })), { status: 'cancelled' })
  assert.deepEqual(await f.load(), input)
})

test('a delayed CAS read expires membership evidence and cannot persist a stale administrator decision', redisTest, async t => {
  const f = await fixture(t, 'management-role-freshness'), input = state({ entries: [entry(1, { source: message(1, { authorId: 'other' }) })] })
  await f.save(input)
  const finished = Promise.withResolvers()
  const manager = f.make({ get: f.storage.get, async eval(script, options) {
    const result = await f.storage.eval(script, options)
    if (script.includes("return {redis.call('GET'")) {
      f.roles.set('admin', 'member')
      await new Promise(resolve => setTimeout(resolve, 1600))
      finished.resolve()
    }
    return result
  } })
  assert.deepEqual(await manager.delete({ id: 'entry-1' }, f.context('admin')), { status: 'cancelled' })
  await finished.promise
  assert.equal(f.reads.length, 2)
  assert.deepEqual(await f.load(), input)
})

test('concurrent CAS deletions preserve both teaching tombstones and an unrelated entry', redisTest, async t => {
  const f = await fixture(t, 'management-cas-parallel'), input = state({ entries: [entry(1), entry(2), entry(3)] })
  await f.save(input)
  const gate = Promise.withResolvers()
  let reads = 0
  const storage = { get: f.storage.get, async eval(script, options) {
    const result = await f.storage.eval(script, options)
    if (script.includes("return {redis.call('GET'") && reads < 2) { if (++reads === 2) gate.resolve(); await gate.promise }
    return result
  } }
  assert.deepEqual(await Promise.all([1, 2].map(index => f.make(storage).delete({ id: `entry-${index}` }, f.context()))), [{ status: 'deleted', deleted: 1 }, { status: 'deleted', deleted: 1 }])
  const saved = await f.load()
  assert.deepEqual(saved.entries.map(row => row.id), ['entry-3'])
  assert.deepEqual(saved.teachingDeletedSources.sort(), ['message-1', 'message-2'])
})

test('tombstone capacity rejects deletion and clear instead of discarding old revocations', redisTest, async t => {
  const f = await fixture(t, 'management-tombstone-capacity')
  const full = Array.from({ length: 1000 }, (_, index) => `old-deleted-${index}`)
  const teaching = state({ entries: [entry(1)], teachingDeletedSources: full })
  await f.save(teaching)
  assert.deepEqual(await f.manager.delete({ id: 'entry-1' }, f.context()), { status: 'capacity_exceeded' })
  assert.deepEqual(await f.load(), teaching)
  const facts = state()
  facts.agents[0].entries = [entry(10, { kind: 'fact' })]
  facts.agents[0].records = [message(10)]
  facts.agents[0].deletedSources = full
  await f.save(facts)
  assert.deepEqual(await f.manager.delete({ id: 'entry-10' }, f.context()), { status: 'capacity_exceeded' })
  const first = await f.manager.clear({}, f.context('admin'))
  assert.deepEqual(await f.manager.clear({ confirmationId: first.confirmationId }, f.context('admin', binding(), 'confirm')), { status: 'capacity_exceeded' })
  assert.deepEqual(await f.load(), facts)
})

test('store strictly validates the optional teaching and Agent revocation fields', redisTest, async t => {
  const f = await fixture(t, 'management-tombstone-schema'), input = state({ teachingDeletedSources: ['old-source'], teachingClearedAt: epoch })
  await f.save(input)
  assert.deepEqual(await f.load(), input)
  for (const change of [{ teachingDeletedSources: ['same', 'same'] }, { teachingDeletedSources: 'source' }, { teachingClearedAt: -1 }, { teachingClearedAt: 0.5 }, { teachingClearedAt: 'now' },
    { teachingDeletedSources: Array.from({ length: 1001 }, (_, index) => `source-${index}`) }]) {
    await assert.rejects(f.store.update(input.id, current => ({ ...current, ...change })), /群记忆存储不可用/u)
    assert.deepEqual(await f.load(), input)
  }
  await f.store.update(input.id, current => { current.agents[0].clearedAt = epoch; return current })
  const valid = await f.load()
  for (const clearedAt of [-1, 0.5, 'now', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(f.store.update(input.id, current => { current.agents[0].clearedAt = clearedAt; return current }), /群记忆存储不可用/u)
    assert.deepEqual(await f.load(), valid)
  }
})
