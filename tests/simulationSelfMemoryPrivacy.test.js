import assert from 'node:assert/strict'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { createSimSessionStore } = await load('modules/simulation/infrastructure/simSessionStore.js')
const { createPersonMemoryStore } = await load('modules/memory/infrastructure/personMemoryStore.js')
const { characterKey } = await load('modules/simulation/domain/characterState.js')
const settings = { timeout: 20_000 }, epoch = Date.now()
const scope = { botId: 'account-a', personaId: 'agent:daily', groupId: 'room-a' }, subject = 'subject-a'
const key = selected => characterKey(selected) + ':legacy:self-memories'
function note(id, extras = {}) { return { id, kind: 'note', content: 'self note ' + id, done: false, createdAt: epoch, updatedAt: epoch, source: 'agent', ...extras } }
function source(id, extras = {}) { return { scene: { kind: 'group', id: scope.groupId }, authorId: subject, messageId: id, at: epoch, excerpt: 'real original ' + id, ...extras } }
function fixture() {
  const values = new Map(), clock = { at: epoch }
  const storage = { async get(key) { return values.get(key) ?? null }, async set(key, value) { values.set(key, value); return 'OK' }, async del(key) { return Number(values.delete(key)) } }
  return { clock, person: createPersonMemoryStore({ redis: storage, now: () => clock.at }),
    store: selected => createSimSessionStore({ redis: storage, characterScope: selected ?? scope, now: () => clock.at }),
    raw: selected => storage.get(key(selected ?? scope)),
    set: (entries, selected) => storage.set(key(selected ?? scope), JSON.stringify(entries)) }
}

test('self memories apply the same source, person and scene redactions as scene notebooks on both reads and writes', settings, async t => {
  const f = await fixture(t, 'self-memory-privacy'), store = f.store()
  const input = [note('legacy-unproven'), note('subject-direct', { aboutUser: subject, memorySource: source('direct'), memoryIdentity: scope }),
    note('other-person-about-A', { aboutUser: 'subject-b', memorySource: source('author-a'), memoryIdentity: scope }),
    note('author-without-about', { memorySource: source('author-without-about'), memoryIdentity: scope }),
    note('unrelated-source', { aboutUser: 'subject-b', memorySource: source('unrelated', { authorId: 'subject-b' }), memoryIdentity: scope }),
    note('wrong-identity', { memoryIdentity: { botId: 'account-b', personaId: scope.personaId } })]
  await f.set(input); assert.equal((await store.loadSelfMemories()).length, 5)
  f.clock.at++; await f.person.forget({ identity: scope, subjectId: subject })
  const expected = [input[4]]
  assert.deepEqual(await f.store().loadSelfMemories(), expected)
  assert.deepEqual(JSON.parse(await f.raw()), input, 'read filtering is not a physical purge receipt')
  await store.saveSelfMemories(input); assert.deepEqual(JSON.parse(await f.raw()), expected)
  assert.deepEqual(await store.loadSelfMemories(), expected)
})

test('self notes retain fresh timestamps and unrelated account, Agent and proven scene sources after privacy', settings, async t => {
  const f = await fixture(t, 'self-memory-new-notes'), input = [note('old')]
  for (const selected of [scope, { ...scope, botId: 'account-b' }, { ...scope, personaId: 'agent:work' }, { ...scope, groupId: 'room-b' }]) await f.set(input, selected)
  f.clock.at++; await f.person.forget({ identity: scope, subjectId: subject, scene: { kind: 'group', id: scope.groupId } })
  const current = f.clock.at + 1, fresh = [note('new-unproven', { createdAt: current, updatedAt: current }),
    note('new-provenance', { aboutUser: subject, createdAt: current, updatedAt: current, memorySource: source('new-original', { at: current }), memoryIdentity: scope })]
  await f.store().saveSelfMemories([...input, ...fresh]); assert.deepEqual(await f.store().loadSelfMemories(), fresh)
  assert.deepEqual(JSON.parse(await f.raw()), fresh)
  for (const selected of [{ ...scope, botId: 'account-b' }, { ...scope, personaId: 'agent:work' }]) assert.deepEqual(await f.store(selected).loadSelfMemories(), input)
  // Aggregate legacy notes have no per-scene evidence; the existing identity
  // invalidation conservatively hides old unproven notes in another scene too.
  assert.deepEqual(await f.store({ ...scope, groupId: 'room-b' }).loadSelfMemories(), [])
  const sceneB = note('scene-b-provenance', { aboutUser: subject, memorySource: source('scene-b-original', { scene: { kind: 'group', id: 'room-b' } }), memoryIdentity: scope })
  await f.set([sceneB], { ...scope, groupId: 'room-b' }); assert.deepEqual(await f.store({ ...scope, groupId: 'room-b' }).loadSelfMemories(), [sceneB])
})
