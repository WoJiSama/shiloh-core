import assert from 'node:assert/strict'
import test from 'node:test'
import { createForgetOperationStore } from '../dist/backend/modules/runtime/infrastructure/forgetOperationStore.js'
import { agentConversationKey } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { createStandaloneAgentForgetOperations } from '../dist/backend/bootstrap/standaloneAgentForgetOperations.js'
import { createCharacterWorkspace } from '../dist/backend/modules/simulation/infrastructure/characterWorkspace.js'

const binding = {
  source: 'configured', id: 'scope', revision: 'r1', agentId: 'agent', personaId: 'persona', connectionId: 'qq-main',
  target: { kind: 'group', id: '10001', account: { platform: 'qq', namespace: 'global', id: 'robot' } },
}
function fixture() {
  const receipts = new Map(), calls = { profile: 0, character: 0 }, values = new Map()
  const store = createForgetOperationStore({ redis: {
    async get(key) { return values.get(key) ?? null },
    async eval(script, { keys, arguments: args }) {
      if (script.includes('local existing = redis.call')) {
        if (values.has(keys[0])) return values.get(keys[0])
        if (values.has(keys[1])) return null
        values.set(keys[0], args[0]); values.set(keys[1], args[1]); return args[0]
      }
      if (values.get(keys[0]) !== args[0]) return 0
      values.set(keys[0], args[1]); return 1
    },
  } })
  let deleted = false
  const profiles = {
    async list() { return deleted ? [] : [{ binding, profile: { userId: 'u1', entries: [{ id: 'entry-1', category: 'fact', text: 'secret body' }] } }] },
    async remove() { calls.profile++; deleted = true; return true },
    async removeField() { calls.profile++; deleted = true; return { userId: 'u1', entries: [] } },
  }
  const characters = {
    async describeGroup() { return { character: { memories: deleted ? [] : [{ id: 'memory-1' }], goals: [] }, activities: { works: [], shared: [], sharedPending: [] } } },
    async controlCharacter() { calls.character++; deleted = true; return '角色状态已更新' },
  }
  const auth = { async authorize() { return 'allowed' } }
  const context = { principal: { id: 'admin', username: 'admin', via: 'session' }, binding, signal: new AbortController().signal,
    isCurrent: () => true, ensureCurrent() {}, }
  const ops = createStandaloneAgentForgetOperations({ store, bindings: { resolve: () => binding }, auth, profiles, characters })
  return { ops, context, receipts, calls, store, values, profiles, characters, auth, get deleted() { return deleted } }
}

test('profile forget returns a durable safe receipt and request retry is idempotent', async () => {
  const f = fixture(), first = await f.ops.profile({ userId: 'u1', requestId: 'request-1' }, f.context)
  assert.equal(first.phase, 'completed')
  assert.equal(first.impacts.filter(row => row.kind === 'person-memory-entry').length, 1)
  assert.equal(JSON.stringify(first).includes('secret body'), false)
  const duplicate = await f.ops.profile({ userId: 'u1', requestId: 'request-1' }, f.context)
  assert.equal(duplicate.operationId, first.operationId)
  assert.equal(f.calls.profile, 1)
})

test('character memory forget reports source and derived partitions without storing content', async () => {
  const f = fixture(), result = await f.ops.character({ scopeKey: agentConversationKey(binding), memoryId: 'memory-1', requestId: 'request-2' }, f.context)
  assert.equal(result.phase, 'completed')
  assert.ok(result.impacts.some(row => row.kind === 'character-memory' && row.id === 'memory-1'))
  assert.ok(result.impacts.some(row => row.kind === 'partition'))
  assert.equal(JSON.stringify(result).includes('secret body'), false)
  assert.equal(f.calls.character, 1)
})

test('character forget reports a retained work whose dependent version was actually pruned', async () => {
  const f = fixture(), values = new Map(), workspace = createCharacterWorkspace({
    redis: { get: async key => values.get(key) ?? null, set: async (key, value) => { values.set(key, value); return 'OK' } },
    scope: { botId: 'robot', personaId: 'agent', groupId: '10001' }, now: () => 1_795_075_800_000,
  })
  const first = await workspace.write({ title: 'private work title', kind: 'research', content: 'surviving independent body', evidenceRefs: ['message:1'] })
  await workspace.write({ id: first.id, expectedRevision: first.revision, title: 'private work title', kind: 'research',
    content: 'forgotten derived body', evidenceRefs: ['memory:memory-1'] })
  const unaffected = await workspace.write({ title: 'unaffected title', kind: 'note', content: 'independent body', evidenceRefs: ['message:2'] })
  const describe = f.characters.describeGroup, control = f.characters.controlCharacter
  f.characters.describeGroup = async () => ({ ...await describe(), activities: { works: await workspace.list(), shared: [], sharedPending: [] } })
  f.characters.controlCharacter = async (...args) => {
    const result = await control(...args)
    await workspace.pruneEvidence([])
    return result
  }
  const result = await f.ops.character({ scopeKey: agentConversationKey(binding), memoryId: 'memory-1', requestId: 'pruned-version' }, f.context)
  const retained = await workspace.read(first.id)
  assert.deepEqual(retained.versions.map(version => version.revision), [1])
  assert.equal(retained.versions[0].content, 'surviving independent body')
  assert.equal(retained.revision, 3)
  await assert.rejects(workspace.read(first.id, 2), /不存在/)
  assert.deepEqual(await workspace.read(unaffected.id), unaffected)
  assert.deepEqual(result.impacts.filter(row => row.kind === 'character-work'), [{
    kind: 'character-work', id: first.id, partition: `character:${agentConversationKey(binding)}`, state: 'completed',
  }])
  assert.equal(result.cleanup, 'unsupported')
  assert.ok(result.impacts.some(row => row.kind === 'partition' && row.state === 'unsupported'))
  assert.deepEqual((await f.ops.read(result.operationId, f.context)).impacts, result.impacts)
  const persisted = [...f.values.values()].join('\n')
  for (const text of ['private work title', 'unaffected title', 'surviving independent body', 'forgotten derived body', 'memory:memory-1'])
    assert.equal(persisted.includes(text), false)
})

test('work edits, archival and unrelated pruned versions are not reported as memory cleanup', async () => {
  const f = fixture(), values = new Map(), workspace = createCharacterWorkspace({
    redis: { get: async key => values.get(key) ?? null, set: async (key, value) => { values.set(key, value); return 'OK' } },
    scope: { botId: 'robot', personaId: 'agent', groupId: '10001' }, now: () => 1_795_075_800_000,
  })
  const draft = (changes = {}) => ({ title: 'independent work', kind: 'note', content: 'work body', evidenceRefs: ['memory:memory-1'], ...changes })
  const edited = await workspace.write(draft()), archived = await workspace.write(draft())
  const unrelated = await workspace.write(draft({ evidenceRefs: ['message:1'] }))
  await workspace.write(draft({ id: unrelated.id, expectedRevision: unrelated.revision, evidenceRefs: ['memory:other-memory'] }))
  const describe = f.characters.describeGroup, control = f.characters.controlCharacter
  f.characters.describeGroup = async () => ({ ...await describe(), activities: { works: await workspace.list(), shared: [], sharedPending: [] } })
  f.characters.controlCharacter = async (...args) => {
    const result = await control(...args)
    await workspace.write(draft({ id: edited.id, expectedRevision: edited.revision, content: 'ordinary edit', evidenceRefs: ['message:2'] }))
    await workspace.archive(archived.id, true)
    await workspace.pruneEvidence(['memory:memory-1'])
    return result
  }
  const result = await f.ops.character({ scopeKey: agentConversationKey(binding), memoryId: 'memory-1', requestId: 'unrelated-work-changes' }, f.context)
  assert.equal((await workspace.read(edited.id)).revision, 2)
  assert.equal((await workspace.read(archived.id)).status, 'archived')
  assert.deepEqual((await workspace.read(unrelated.id)).versions.map(version => version.revision), [1])
  assert.deepEqual(result.impacts.filter(row => row.kind === 'character-work'), [])
  assert.equal(result.cleanup, 'unsupported')
})


test('one concurrent request ID executes the source mutation once', async () => {
  const f = fixture()
  const results = await Promise.all([f.ops.profile({ userId: 'u1', requestId: 'parallel' }, f.context), f.ops.profile({ userId: 'u1', requestId: 'parallel' }, f.context)])
  assert.equal(results[0].operationId, results[1].operationId)
  assert.equal(f.calls.profile, 1)
})

test('reusing a request ID for a different subject or kind conflicts', async () => {
  const f = fixture()
  await f.ops.profile({ userId: 'u1', requestId: 'same' }, f.context)
  await assert.rejects(f.ops.profile({ userId: 'u2', requestId: 'same' }, f.context), error => error.code === 'conflict')
  await assert.rejects(f.ops.character({ scopeKey: agentConversationKey(binding), memoryId: 'memory-1', requestId: 'same' }, f.context), error => error.code === 'conflict')
})

test('character receipt does not invent completion for unobservable partitions', async () => {
  const f = fixture(), result = await f.ops.character({ scopeKey: agentConversationKey(binding), memoryId: 'memory-1', requestId: 'limited-proof' }, f.context)
  assert.equal(result.usage, 'blocked')
  assert.equal(result.cleanup, 'unsupported')
  assert.ok(result.impacts.some(row => row.kind === 'partition' && row.state === 'unsupported'))
})

test('a request ID cannot change an entry selector after the original completed', async () => {
  const f = fixture()
  await f.ops.profile({ userId: 'u1', field: 'entries', value: 'entry-1', requestId: 'entry-selector' }, f.context)
  await assert.rejects(f.ops.profile({ userId: 'u1', field: 'entries', value: 'entry-2', requestId: 'entry-selector' }, f.context), error => error.code === 'conflict')
})

test('revoked read permission is checked before exposing an existing receipt', async () => {
  const f = fixture(), receipt = await f.ops.profile({ userId: 'u1', requestId: 'private-receipt' }, f.context)
  f.auth.authorize = async (_principal, operation) => operation === 'forgetting.read' ? 'denied' : 'allowed'
  await assert.rejects(f.ops.read(receipt.operationId, f.context), error => error.code === 'forbidden')
})

test('a receipt read cannot return data after authority disappears during storage', async () => {
  const f = fixture(), receipt = await f.ops.profile({ userId: 'u1', requestId: 'stale-read' }, f.context)
  const read = f.store.read
  let valid = true
  f.store.read = async (...args) => { const result = await read(...args); valid = false; return result }
  f.context.ensureCurrent = () => { if (!valid) throw new Error('revoked') }
  await assert.rejects(f.ops.read(receipt.operationId, f.context), /revoked/)
})

test('source readback must prove deletion before marking usage blocked', async () => {
  const f = fixture()
  f.characters.controlCharacter = async () => 'source did not change'
  await assert.rejects(f.ops.character({ scopeKey: agentConversationKey(binding), memoryId: 'memory-1', requestId: 'no-effect' }, f.context), error => error.code === 'unavailable')
  const receipt = await f.store.readByRequestId('no-effect')
  assert.equal(receipt.phase, 'unknown')
  assert.equal(receipt.usage, 'unknown')
})

test('an accepted operation without an active owner becomes unknown and is never replayed', async () => {
  const f = fixture()
  const created = await f.store.begin({ requestId: 'interrupted', kind: 'person-profile', binding, subject: { userId: 'u1' } })
  const receipt = await f.ops.read(created.operationId, f.context)
  assert.equal(receipt.phase, 'unknown')
  assert.equal(receipt.cleanup, 'unknown')
  assert.equal(receipt.errorCode, 'HOST_OPERATION_INTERRUPTED')
  assert.equal(f.calls.profile, 0)
})

test('reading a newly persisted operation before begin returns preserves its active owner', async () => {
  for (const kind of ['profile', 'character']) {
    const f = fixture(), begin = f.store.begin
    f.store.begin = async (...args) => {
      const created = await begin(...args)
      const observed = await f.ops.read(created.operationId, f.context)
      assert.equal(observed.phase, 'accepted')
      return created
    }
    const result = kind === 'profile'
      ? await f.ops.profile({ userId: 'u1', requestId: 'active-profile' }, f.context)
      : await f.ops.character({ scopeKey: agentConversationKey(binding), memoryId: 'memory-1', requestId: 'active-character' }, f.context)
    assert.equal(result.phase, 'completed')
    assert.equal(f.calls[kind], 1)
  }
})
