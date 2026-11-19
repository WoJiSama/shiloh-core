import assert from 'node:assert/strict'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
const { createForgetOperationStore } = await load('modules/runtime/infrastructure/forgetOperationStore.js')
const { agentConversationKey } = await load('modules/runtime/domain/agentBindings.js')
const { createStandaloneAgentForgetOperations } = await load('bootstrap/standaloneAgentForgetOperations.js')
const { createCharacterWorkspace } = await load('modules/simulation/infrastructure/characterWorkspace.js')

const binding = {
  source: 'configured', id: 'scope', revision: 'r1', agentId: 'agent', personaId: 'persona', connectionId: 'qq-main',
  target: { kind: 'group', id: '10001', account: { platform: 'qq', namespace: 'global', id: 'robot' } },
}
function fixture(options = {}, activeBinding = binding) {
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
    async list() { return deleted ? [] : [{ binding: activeBinding, profile: { userId: 'u1', entries: [{ id: 'entry-1', category: 'fact', text: 'secret body' }] } }] },
    async remove() { calls.profile++; deleted = true; return true },
    async removeField() { calls.profile++; deleted = true; return { userId: 'u1', entries: [] } },
  }
  const characters = {
    async describeGroup() { return { character: { memories: deleted ? [] : [{ id: 'memory-1' }], goals: [] }, activities: { works: [], shared: [], sharedPending: [] } } },
    async controlCharacter() { calls.character++; deleted = true; return '角色状态已更新' },
  }
  const auth = { async authorize() { return 'allowed' } }
  const context = { principal: { id: 'admin', username: 'admin', via: 'session' }, binding: activeBinding, signal: new AbortController().signal,
    isCurrent: () => true, ensureCurrent() {}, }
  const ops = createStandaloneAgentForgetOperations({ store, bindings: { resolve: () => activeBinding }, auth, profiles, characters, ...options })
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

test('one failed owner does not block the other owners and same request resumes only unfinished cleanup after restart', async () => {
  const calls = { emoji: [], semantic: [], conversation: [] }, fixedTime = 1_795_075_800_000
  const cleanup = {
    localEmojiCleanup: { async purgeSubject(input) {
      calls.emoji.push(structuredClone(input))
      if (calls.emoji.length === 1) throw Error('emoji storage unavailable')
      return { usage: 'blocked', cleanup: 'completed', removedSources: 1, removedImages: 1, unattributedImages: 0 }
    } },
    semanticMemoryCleanup: { async purgeSubject(input) {
      calls.semantic.push(structuredClone(input))
      return { usage: 'blocked', cleanup: 'completed', removedRows: 1, removedVectors: 1, removedPartitions: 1 }
    } },
    conversationMemoryCleanup: { async purgeSubject(input) {
      calls.conversation.push(structuredClone(input))
      return { usage: 'blocked', cleanup: 'completed', removedRecords: 1, removedSummaries: 1, removedEpisodes: 1, removedPartitions: 1 }
    } },
  }
  const f = fixture(cleanup), begin = f.store.begin
  f.store.begin = (input, guard) => begin({ ...input, now: fixedTime }, guard)
  const first = await f.ops.profile({ userId: 'u1', requestId: 'resume-owners' }, f.context)
  assert.equal(first.phase, 'unknown'); assert.equal(first.usage, 'blocked')
  assert.equal(calls.emoji.length, 1); assert.equal(calls.semantic.length, 1); assert.equal(calls.conversation.length, 1)
  assert.equal(first.cleanupPlan.sourceCommitted, true)
  assert.ok(first.impacts.some(row => row.id === 'semantic-memory-sources' && row.state === 'completed'))
  assert.ok(first.impacts.some(row => row.id === 'conversation-memory-records' && row.state === 'completed'))
  const restarted = createStandaloneAgentForgetOperations({ store: f.store, bindings: { resolve: () => binding },
    auth: f.auth, profiles: f.profiles, characters: f.characters, ...cleanup })
  const result = await restarted.profile({ userId: 'u1', requestId: 'resume-owners' }, f.context)
  assert.equal(result.operationId, first.operationId); assert.equal(result.createdAt, fixedTime)
  assert.equal(result.phase, 'completed'); assert.equal(result.cleanup, 'unsupported')
  assert.equal(calls.emoji.length, 2); assert.equal(calls.semantic.length, 1); assert.equal(calls.conversation.length, 1)
  assert.deepEqual(calls.emoji[1], calls.emoji[0]); assert.equal(calls.emoji[1].through, fixedTime)
  assert.equal(f.calls.profile, 1)
})

test('interrupted committed cleanup resumes without a profile read or source mutation', async () => {
  let purges = 0
  const f = fixture({ semanticMemoryCleanup: { async purgeSubject() {
    purges++; return { usage: 'blocked', cleanup: 'completed', removedRows: 0, removedVectors: 0, removedPartitions: 0 }
  } } })
  const receipt = await f.store.begin({ requestId: 'interrupted-cleanup', requestDigest: (await import('node:crypto')).createHash('sha256')
    .update(JSON.stringify(['person-profile', 'u1', null, null])).digest('hex'), kind: 'person-profile', binding,
    subject: { userId: 'u1' }, cleanupOwners: ['semantic-memory'] })
  await f.store.markCommitted(receipt.operationId)
  f.profiles.list = async () => { throw Error('source must not be read again') }
  const result = await f.ops.profile({ userId: 'u1', requestId: 'interrupted-cleanup' }, f.context)
  assert.equal(result.phase, 'completed'); assert.equal(purges, 1); assert.equal(f.calls.profile, 0)
})

test('interruption between source deletion and receipt commit is recovered by authorized absence readback without replay', async () => {
  let purges = 0
  const f = fixture({ semanticMemoryCleanup: { async purgeSubject() {
    purges++; return { usage: 'blocked', cleanup: 'completed', removedRows: 0, removedVectors: 0, removedPartitions: 0 }
  } } }), commit = f.store.markCommitted
  f.store.markCommitted = async () => { throw Error('receipt connection interrupted') }
  await assert.rejects(f.ops.profile({ userId: 'u1', requestId: 'source-commit-window' }, f.context), /receipt connection interrupted/u)
  const before = await f.store.readByRequestId('source-commit-window')
  assert.equal(before.cleanupPlan.sourceCommitted, false); assert.equal(before.usage, 'unknown')
  assert.equal(purges, 0); assert.equal(f.calls.profile, 1)
  f.store.markCommitted = commit
  const receipt = await f.ops.profile({ userId: 'u1', requestId: 'source-commit-window' }, f.context)
  assert.equal(receipt.operationId, before.operationId); assert.equal(receipt.phase, 'completed')
  assert.equal(receipt.cleanupPlan.sourceCommitted, true); assert.equal(purges, 1); assert.equal(f.calls.profile, 1)
  assert.ok(receipt.impacts.some(row => row.kind === 'person-memory-entry' && row.state === 'completed'))
})

test('a failed final receipt write can resume settlement without rerunning completed owners', async () => {
  let purges = 0
  const f = fixture({ semanticMemoryCleanup: { async purgeSubject() {
    purges++; return { usage: 'blocked', cleanup: 'completed', removedRows: 0, removedVectors: 0, removedPartitions: 0 }
  } } }), update = f.store.update
  f.store.update = async (id, patch, guard) => {
    if (patch.phase === 'completed') throw Error('final receipt unavailable')
    return update(id, patch, guard)
  }
  await assert.rejects(f.ops.profile({ userId: 'u1', requestId: 'final-receipt-retry' }, f.context), /final receipt unavailable/u)
  const pending = await f.store.readByRequestId('final-receipt-retry')
  assert.equal(pending.phase, 'unknown'); assert.equal(pending.cleanupPlan.owners[0].state, 'completed')
  f.store.update = update
  const receipt = await f.ops.profile({ userId: 'u1', requestId: 'final-receipt-retry' }, f.context)
  assert.equal(receipt.phase, 'completed'); assert.equal(f.calls.profile, 1); assert.equal(purges, 1)
})

test('Core source removal can throw after deletion and its readback still commits a recoverable cleanup plan', async () => {
  let emojiCalls = 0, conversationCalls = 0
  const f = fixture({ localEmojiCleanup: { async purgeSubject() {
    emojiCalls++; return { usage: 'blocked', cleanup: 'completed', removedSources: 0, removedImages: 0, unattributedImages: 0 }
  } }, conversationMemoryCleanup: { async purgeSubject() {
    conversationCalls++; return { usage: 'blocked', cleanup: 'completed', removedRecords: 0, removedSummaries: 0, removedEpisodes: 0, removedPartitions: 0 }
  } } })
  const remove = f.profiles.remove
  f.profiles.remove = async (...args) => { await remove(...args); throw Error('Core downstream owner unknown') }
  const receipt = await f.ops.profile({ userId: 'u1', requestId: 'core-source-deleted' }, f.context)
  assert.equal(receipt.phase, 'completed'); assert.equal(receipt.cleanupPlan.sourceCommitted, true)
  assert.equal(f.calls.profile, 1); assert.equal(emojiCalls, 1); assert.equal(conversationCalls, 1)
  await f.ops.profile({ userId: 'u1', requestId: 'core-source-deleted' }, f.context)
  assert.equal(f.calls.profile, 1); assert.equal(emojiCalls, 1); assert.equal(conversationCalls, 1)
})

test('whole-person forget tracks group learning and independent source store partitions with the exact original selector', async () => {
  const seen = [], f = fixture({
    groupMemoryCleanup: { async purgeSubject(input, guard) {
      await guard.ensureCurrent(); seen.push(structuredClone(input))
      return { usage: 'blocked', cleanup: 'completed', removedRecords: 2, removedJobs: 1, removedEntries: 1, removedPartitions: 1 }
    } },
    sourceMemoryCleanup: { async purgeSubject(input, guard) {
      await guard.ensureCurrent(); seen.push(structuredClone(input))
      return { usage: 'blocked', partitions: [
        { id: 'history-records', cleanup: 'completed', removedRecords: 1, removedPartitions: 1 },
        { id: 'person-extraction-batches', cleanup: 'unknown', removedRecords: 0, removedPartitions: 0 },
        { id: 'delegated-memory', cleanup: 'completed', removedRecords: 1, removedPartitions: 1 },
        { id: 'commitments', cleanup: 'completed', removedRecords: 0, removedPartitions: 0 },
      ] }
    } },
  })
  const receipt = await f.ops.profile({ userId: 'u1', requestId: 'all-source-stores' }, f.context)
  assert.deepEqual(seen, [0, 1].map(() => ({ account: binding.target.account, agentId: binding.agentId, subjectId: 'u1', target: binding.target, through: receipt.createdAt })))
  assert.deepEqual(receipt.impacts.filter(row => row.id.startsWith('group-memory-')).map(row => [row.id, row.state]), [
    ['group-memory-records', 'completed'], ['group-memory-jobs', 'completed'], ['group-memory-entries', 'completed'],
  ])
  assert.deepEqual(receipt.impacts.filter(row => ['history-records', 'person-extraction-batches', 'delegated-memory', 'commitments'].includes(row.id)).map(row => [row.id, row.state]), [
    ['history-records', 'completed'], ['person-extraction-batches', 'unknown'], ['delegated-memory', 'completed'], ['commitments', 'completed'],
  ])
  assert.equal(receipt.phase, 'unknown'); assert.equal(receipt.cleanup, 'unknown')
  assert.equal(receipt.cleanupPlan.owners.find(row => row.owner === 'group-memory').state, 'completed')
  assert.equal(receipt.cleanupPlan.owners.find(row => row.owner === 'source-memory').state, 'unknown')
  assert.ok(receipt.impacts.some(row => row.id === 'source-consumers' && row.state === 'unsupported'))
})

test('field deletion excludes new group/source owners and missing original owners remain resumable', async () => {
  const unavailable = { async purgeSubject() { throw Error('must not run for field') } }
  const field = fixture({ groupMemoryCleanup: unavailable, sourceMemoryCleanup: unavailable })
  const receipt = await field.ops.profile({ userId: 'u1', field: 'entries', value: 'entry-1', requestId: 'new-owners-field' }, field.context)
  assert.equal(receipt.cleanupPlan, undefined)
  const f = fixture({ localEmojiCleanup: { async purgeSubject() { throw Error('temporarily unavailable') } } })
  const first = await f.ops.profile({ userId: 'u1', requestId: 'original-owner-absent' }, f.context)
  const restarted = createStandaloneAgentForgetOperations({ store: f.store, bindings: { resolve: () => binding },
    auth: f.auth, profiles: f.profiles, characters: f.characters,
    semanticMemoryCleanup: { async purgeSubject() { throw Error('new owner must not be added to the old plan') } } })
  const again = await restarted.profile({ userId: 'u1', requestId: 'original-owner-absent' }, f.context)
  assert.equal(again.phase, 'unknown'); assert.equal(again.operationId, first.operationId)
  assert.deepEqual(again.cleanupPlan.owners, [{ owner: 'local-emoji', state: 'unknown' }]); assert.equal(f.calls.profile, 1)
})

test('whole-person forget reports only proven emoji source cleanup and retries do not purge again', async () => {
  const purges = [], f = fixture({ localEmojiCleanup: { async purgeSubject(input, guard) {
    assert.equal(guard.isCurrent(), true); await guard.ensureCurrent()
    purges.push(structuredClone(input))
    return { usage: 'blocked', cleanup: 'completed', removedSources: 2, removedImages: 1, unattributedImages: 3 }
  } } })
  const result = await f.ops.profile({ userId: 'u1', requestId: 'emoji-whole-person' }, f.context)
  assert.equal(purges.length, 1)
  assert.deepEqual(purges[0], { account: binding.target.account, agentId: binding.agentId, subjectId: 'u1', target: binding.target, through: result.createdAt })
  assert.ok(result.impacts.some(row => row.id === 'local-emoji-attributed-sources' && row.state === 'completed'))
  assert.ok(result.impacts.some(row => row.id === 'local-emoji-unattributed' && row.state === 'unsupported'))
  assert.equal(result.cleanup, 'unsupported')
  assert.deepEqual((await f.ops.read(result.operationId, f.context)).impacts, result.impacts)
  assert.equal(JSON.stringify(result).includes('secret body'), false)
  const again = await f.ops.profile({ userId: 'u1', requestId: 'emoji-whole-person' }, f.context)
  assert.equal(again.operationId, result.operationId); assert.equal(purges.length, 1)
})

test('deleting one person field does not purge unrelated emoji sources', async () => {
  let purges = 0
  const f = fixture({ localEmojiCleanup: { async purgeSubject() { purges++; throw Error('must not purge') } } })
  const result = await f.ops.profile({ userId: 'u1', field: 'entries', value: 'entry-1', requestId: 'emoji-one-field' }, f.context)
  assert.equal(purges, 0); assert.equal(result.impacts.some(row => row.id.startsWith('local-emoji-')), false)
})

test('console deletion of a private scene keeps cleanup restricted to that displayed source', async () => {
  const privateBinding = { ...binding, target: { ...binding.target, kind: 'private', id: 'u1' } }, purges = []
  const f = fixture({ localEmojiCleanup: { async purgeSubject(input) {
    purges.push(input)
    return { usage: 'blocked', cleanup: 'completed', removedSources: 1, removedImages: 1, unattributedImages: 0 }
  } } }, privateBinding)
  await f.ops.profile({ userId: 'u1', requestId: 'emoji-private-scene' }, f.context)
  assert.equal(purges.length, 1); assert.deepEqual(purges[0].target, privateBinding.target)
})

test('uncertain emoji deletion remains uncertain without claiming complete downstream cleanup', async () => {
  const f = fixture({ localEmojiCleanup: { async purgeSubject() {
    return { usage: 'blocked', cleanup: 'unknown', removedSources: 1, removedImages: 0, unattributedImages: 0 }
  } } })
  const result = await f.ops.profile({ userId: 'u1', requestId: 'emoji-unknown' }, f.context)
  assert.ok(result.impacts.some(row => row.id === 'local-emoji-attributed-sources' && row.state === 'unknown'))
  assert.equal(result.cleanup, 'unknown'); assert.equal(result.phase, 'unknown')
})

test('quarantined old emoji without attributable sources remains unsupported in the durable receipt', async () => {
  const f = fixture({ localEmojiCleanup: { async purgeSubject() {
    return { usage: 'blocked', cleanup: 'unsupported', removedSources: 0, removedImages: 0, unattributedImages: 1 }
  } } })
  const result = await f.ops.profile({ userId: 'u1', requestId: 'emoji-unattributed' }, f.context)
  assert.equal(result.cleanup, 'unsupported'); assert.equal(result.usage, 'blocked')
  assert.ok(result.impacts.some(row => row.id === 'local-emoji-attributed-sources' && row.state === 'unsupported'))
  assert.ok(result.impacts.some(row => row.id === 'local-emoji-unattributed' && row.state === 'unsupported'))
})

test('failed emoji owner leaves a durable unknown operation and does not replay the source deletion', async () => {
  let purges = 0
  const f = fixture({ localEmojiCleanup: { async purgeSubject() { purges++; throw Error('storage unavailable') } } })
  const first = await f.ops.profile({ userId: 'u1', requestId: 'emoji-owner-failed' }, f.context)
  assert.equal(first.phase, 'unknown'); assert.equal(first.usage, 'blocked')
  const receipt = await f.ops.profile({ userId: 'u1', requestId: 'emoji-owner-failed' }, f.context)
  assert.equal(receipt.phase, 'unknown'); assert.equal(receipt.cleanup, 'unknown')
  assert.equal(purges, 2); assert.equal(f.calls.profile, 1)
})

test('emoji owner cannot publish a completion receipt after authorization changes during cleanup', async () => {
  let f
  f = fixture({ localEmojiCleanup: { async purgeSubject(_input, guard) {
    await guard.ensureCurrent(); f.auth.authorize = async () => 'denied'
    return { usage: 'blocked', cleanup: 'completed', removedSources: 1, removedImages: 1, unattributedImages: 0 }
  } } })
  await assert.rejects(f.ops.profile({ userId: 'u1', requestId: 'emoji-late-revoke' }, f.context), error => error.code === 'forbidden')
  const receipt = await f.store.readByRequestId('emoji-late-revoke')
  assert.notEqual(receipt.phase, 'completed'); assert.equal(receipt.impacts.some(row => row.id === 'local-emoji-attributed-sources'), false)
})

test('whole-person forget persists separate semantic source and vector cleanup proof with a stable cutoff', async () => {
  const purges = [], operations = [], fixedTime = 1_795_075_800_000
  const f = fixture({ semanticMemoryCleanup: { async purgeSubject(input, guard) {
    assert.equal(guard.signal, f.context.signal); assert.equal(guard.isCurrent(), true)
    await guard.ensureCurrent(); purges.push(structuredClone(input))
    return { usage: 'blocked', cleanup: 'completed', removedRows: 3, removedVectors: 2, removedPartitions: 1 }
  } } })
  f.auth.authorize = async (_principal, operation) => { operations.push(operation); return 'allowed' }
  const begin = f.store.begin
  f.store.begin = (input, guard) => begin({ ...input, now: fixedTime }, guard)
  const result = await f.ops.profile({ userId: 'u1', requestId: 'semantic-person' }, f.context)
  assert.deepEqual(purges, [{ account: binding.target.account, agentId: binding.agentId, subjectId: 'u1', target: binding.target, through: fixedTime }])
  assert.equal(result.createdAt, fixedTime); assert.equal(result.phase, 'completed'); assert.equal(result.usage, 'blocked')
  const semantic = result.impacts.filter(row => row.id.startsWith('semantic-memory-'))
  assert.deepEqual(semantic.map(row => [row.kind, row.id, row.state]), [
    ['partition', 'semantic-memory-sources', 'completed'], ['partition', 'semantic-memory-vectors', 'completed'],
  ])
  assert.match(semantic[0].partition, /^semantic-memory:[a-f0-9]{64}$/u)
  assert.equal(semantic[0].partition, semantic[1].partition)
  assert.equal(result.cleanup, 'unsupported')
  assert.ok(result.impacts.some(row => row.id === 'source-consumers' && row.state === 'unsupported'))
  assert.deepEqual((await f.ops.read(result.operationId, f.context)).impacts, result.impacts)
  assert.equal([...f.values.values()].join('\n').includes('secret body'), false)
  assert.ok(operations.includes('profiles.delete'))
  const again = await f.ops.profile({ userId: 'u1', requestId: 'semantic-person' }, f.context)
  assert.equal(again.operationId, result.operationId); assert.equal(again.createdAt, fixedTime)
  assert.equal(purges.length, 1); assert.equal(f.calls.profile, 1)
})

test('an absent semantic cleanup owner does not claim semantic partitions were erased', async () => {
  const f = fixture({ semanticMemoryCleanup: undefined })
  const result = await f.ops.profile({ userId: 'u1', requestId: 'semantic-disabled' }, f.context)
  assert.equal(result.phase, 'completed'); assert.equal(result.cleanup, 'unsupported')
  assert.equal(result.impacts.some(row => row.id.startsWith('semantic-memory-')), false)
})

test('semantic cleanup uncertainty persists for both partitions without claiming global cleanup', async () => {
  const f = fixture({ semanticMemoryCleanup: { async purgeSubject() {
    return { usage: 'blocked', cleanup: 'unknown', removedRows: 1, removedVectors: 0, removedPartitions: 0 }
  } } })
  const result = await f.ops.profile({ userId: 'u1', requestId: 'semantic-unknown' }, f.context)
  assert.deepEqual(result.impacts.filter(row => row.id.startsWith('semantic-memory-')).map(row => row.state), ['unknown', 'unknown'])
  assert.equal(result.cleanup, 'unknown'); assert.equal(result.phase, 'unknown')
  assert.deepEqual((await f.ops.read(result.operationId, f.context)).impacts, result.impacts)
})

test('malformed semantic cleanup receipts cannot publish completed impacts', async () => {
  const valid = { usage: 'blocked', cleanup: 'completed', removedRows: 0, removedVectors: 0, removedPartitions: 0 }
  const invalid = [null, undefined, {}, { ...valid, usage: 'pending' }, { ...valid, cleanup: 'unsupported' },
    ...['removedRows', 'removedVectors', 'removedPartitions'].flatMap(key =>
      [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1', NaN, Infinity, undefined].map(value => ({ ...valid, [key]: value }))),
  ]
  for (const [index, receipt] of invalid.entries()) {
    let purges = 0
    const f = fixture({ semanticMemoryCleanup: { async purgeSubject() { purges++; return receipt } } })
    const requestId = 'semantic-invalid-' + index
    assert.equal((await f.ops.profile({ userId: 'u1', requestId }, f.context)).phase, 'unknown')
    const recorded = await f.store.readByRequestId(requestId)
    assert.equal(recorded.phase, 'unknown'); assert.equal(recorded.cleanup, 'unknown')
    assert.ok(recorded.impacts.filter(row => row.id.startsWith('semantic-memory-')).every(row => row.state === 'unknown'))
    assert.equal((await f.ops.profile({ userId: 'u1', requestId }, f.context)).operationId, recorded.operationId)
    assert.equal(purges, 2); assert.equal(f.calls.profile, 1)
  }
})

test('a failed semantic cleanup owner leaves an unknown receipt without replaying deletion', async () => {
  let purges = 0
  const f = fixture({ semanticMemoryCleanup: { async purgeSubject() { purges++; throw Error('semantic unavailable') } } })
  const first = await f.ops.profile({ userId: 'u1', requestId: 'semantic-owner-failed' }, f.context)
  assert.equal(first.phase, 'unknown'); assert.equal(first.usage, 'blocked')
  const result = await f.ops.profile({ userId: 'u1', requestId: 'semantic-owner-failed' }, f.context)
  assert.equal(result.phase, 'unknown'); assert.equal(result.cleanup, 'unknown')
  assert.equal(purges, 2); assert.equal(f.calls.profile, 1)
})

test('semantic cleanup cannot publish completion after delete permission or binding lease is revoked', async () => {
  for (const mode of ['permission', 'binding']) {
    let f, current = true
    f = fixture({ semanticMemoryCleanup: { async purgeSubject(_input, guard) {
      await guard.ensureCurrent()
      if (mode === 'permission') f.auth.authorize = async (_principal, operation) => operation === 'profiles.delete' ? 'denied' : 'allowed'
      else { current = false; assert.equal(guard.isCurrent(), false) }
      await assert.rejects(guard.ensureCurrent(), error => error.code === (mode === 'permission' ? 'forbidden' : 'conflict'))
      return { usage: 'blocked', cleanup: 'completed', removedRows: 1, removedVectors: 1, removedPartitions: 1 }
    } } })
    f.context.isCurrent = () => current
    const requestId = 'semantic-revoke-' + mode
    await assert.rejects(f.ops.profile({ userId: 'u1', requestId }, f.context), error => error.code === (mode === 'permission' ? 'forbidden' : 'conflict'))
    const receipt = await f.store.readByRequestId(requestId)
    assert.notEqual(receipt.phase, 'completed'); assert.equal(receipt.impacts.some(row => row.id.startsWith('semantic-memory-')), false)
  }
})

test('deleting a profile field never purges semantic rows or vectors', async () => {
  let purges = 0
  const f = fixture({ semanticMemoryCleanup: { async purgeSubject() { purges++; throw Error('must not purge') } } })
  const result = await f.ops.profile({ userId: 'u1', field: 'entries', value: 'entry-1', requestId: 'semantic-field' }, f.context)
  assert.equal(purges, 0); assert.equal(result.impacts.some(row => row.id.startsWith('semantic-memory-')), false)
})

test('semantic cleanup waits for source deletion readback', async () => {
  let purges = 0
  const f = fixture({ semanticMemoryCleanup: { async purgeSubject() { purges++; throw Error('must not purge') } } })
  f.profiles.list = async () => [{ binding, profile: { userId: 'u1', entries: [{ id: 'entry-1', category: 'fact', text: 'secret body' }] } }]
  await assert.rejects(f.ops.profile({ userId: 'u1', requestId: 'semantic-source-retained' }, f.context), error => error.code === 'unavailable')
  assert.equal(purges, 0)
  assert.equal((await f.store.readByRequestId('semantic-source-retained')).phase, 'unknown')
})

test('semantic cleanup retains the full exact account and conversation scope including private scenes', async () => {
  const variants = [binding,
    { ...binding, agentId: 'other-agent' },
    { ...binding, target: { ...binding.target, account: { ...binding.target.account, namespace: 'other' } } },
    { ...binding, target: { ...binding.target, kind: 'private', id: 'u1' } },
  ], partitions = new Set()
  for (const [index, selected] of variants.entries()) {
    const purges = [], f = fixture({ semanticMemoryCleanup: { async purgeSubject(input, guard) {
      await guard.ensureCurrent(); purges.push(structuredClone(input))
      return { usage: 'blocked', cleanup: 'completed', removedRows: 0, removedVectors: 0, removedPartitions: 0 }
    } } }, selected)
    const result = await f.ops.profile({ userId: 'u1', requestId: 'semantic-scope-' + index }, f.context)
    assert.deepEqual(purges, [{ account: selected.target.account, agentId: selected.agentId, subjectId: 'u1', target: selected.target, through: result.createdAt }])
    const partition = result.impacts.find(row => row.id === 'semantic-memory-sources').partition
    partitions.add(partition)
    assert.equal(partition.includes(selected.target.id), false)
  }
  assert.equal(partitions.size, variants.length)
})

test('whole-person forget persists separate conversation record, summary and episode cleanup proof with a stable cutoff', async () => {
  const purges = [], operations = [], fixedTime = 1_795_075_800_000
  const f = fixture({ conversationMemoryCleanup: { async purgeSubject(input, guard) {
    assert.equal(guard.signal, f.context.signal); assert.equal(guard.isCurrent(), true)
    await guard.ensureCurrent(); purges.push(structuredClone(input))
    return { usage: 'blocked', cleanup: 'completed', removedRecords: 3, removedSummaries: 2, removedEpisodes: 1, removedPartitions: 1 }
  } } })
  f.auth.authorize = async (_principal, operation) => { operations.push(operation); return 'allowed' }
  const begin = f.store.begin
  f.store.begin = (input, guard) => begin({ ...input, now: fixedTime }, guard)
  const result = await f.ops.profile({ userId: 'u1', requestId: 'conversation-person' }, f.context)
  assert.deepEqual(purges, [{ account: binding.target.account, agentId: binding.agentId, subjectId: 'u1', target: binding.target, through: fixedTime }])
  assert.equal(result.createdAt, fixedTime); assert.equal(result.phase, 'completed'); assert.equal(result.usage, 'blocked')
  const conversation = result.impacts.filter(row => row.id.startsWith('conversation-memory-'))
  assert.deepEqual(conversation.map(row => [row.kind, row.id, row.state]), [
    ['partition', 'conversation-memory-records', 'completed'], ['partition', 'conversation-memory-summaries', 'completed'], ['partition', 'conversation-memory-episodes', 'completed'],
  ])
  assert.match(conversation[0].partition, /^conversation-memory:[a-f0-9]{64}$/u)
  assert.equal(conversation[0].partition, conversation[1].partition); assert.equal(conversation[0].partition, conversation[2].partition)
  assert.equal(result.cleanup, 'unsupported')
  assert.ok(result.impacts.some(row => row.id === 'source-consumers' && row.state === 'unsupported'))
  assert.deepEqual((await f.ops.read(result.operationId, f.context)).impacts, result.impacts)
  assert.equal([...f.values.values()].join('\n').includes('secret body'), false)
  assert.ok(operations.includes('profiles.delete'))
  const again = await f.ops.profile({ userId: 'u1', requestId: 'conversation-person' }, f.context)
  assert.equal(again.operationId, result.operationId); assert.equal(again.createdAt, fixedTime)
  assert.equal(purges.length, 1); assert.equal(f.calls.profile, 1)
})

test('an absent conversation cleanup owner does not claim conversation partitions were erased', async () => {
  const f = fixture({ conversationMemoryCleanup: undefined })
  const result = await f.ops.profile({ userId: 'u1', requestId: 'conversation-disabled' }, f.context)
  assert.equal(result.phase, 'completed'); assert.equal(result.cleanup, 'unsupported')
  assert.equal(result.impacts.some(row => row.id.startsWith('conversation-memory-')), false)
})

test('conversation cleanup uncertainty persists for all three partitions without claiming global cleanup', async () => {
  const f = fixture({ conversationMemoryCleanup: { async purgeSubject() {
    return { usage: 'blocked', cleanup: 'unknown', removedRecords: 1, removedSummaries: 0, removedEpisodes: 0, removedPartitions: 0 }
  } } })
  const result = await f.ops.profile({ userId: 'u1', requestId: 'conversation-unknown' }, f.context)
  assert.deepEqual(result.impacts.filter(row => row.id.startsWith('conversation-memory-')).map(row => row.state), ['unknown', 'unknown', 'unknown'])
  assert.equal(result.cleanup, 'unknown'); assert.equal(result.phase, 'unknown')
  assert.deepEqual((await f.ops.read(result.operationId, f.context)).impacts, result.impacts)
})

test('malformed conversation cleanup receipts cannot publish completed impacts', async () => {
  const valid = { usage: 'blocked', cleanup: 'completed', removedRecords: 0, removedSummaries: 0, removedEpisodes: 0, removedPartitions: 0 }
  const invalid = [null, undefined, {}, { ...valid, usage: 'pending' }, { ...valid, cleanup: 'unsupported' },
    ...['removedRecords', 'removedSummaries', 'removedEpisodes', 'removedPartitions'].flatMap(key =>
      [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1', NaN, Infinity, undefined].map(value => ({ ...valid, [key]: value }))),
  ]
  for (const [index, receipt] of invalid.entries()) {
    let purges = 0
    const f = fixture({ conversationMemoryCleanup: { async purgeSubject() { purges++; return receipt } } })
    const requestId = 'conversation-invalid-' + index
    assert.equal((await f.ops.profile({ userId: 'u1', requestId }, f.context)).phase, 'unknown')
    const recorded = await f.store.readByRequestId(requestId)
    assert.equal(recorded.phase, 'unknown'); assert.equal(recorded.cleanup, 'unknown')
    assert.ok(recorded.impacts.filter(row => row.id.startsWith('conversation-memory-')).every(row => row.state === 'unknown'))
    assert.equal((await f.ops.profile({ userId: 'u1', requestId }, f.context)).operationId, recorded.operationId)
    assert.equal(purges, 2); assert.equal(f.calls.profile, 1)
  }
})

test('a failed conversation cleanup owner leaves an unknown receipt without replaying deletion', async () => {
  let purges = 0
  const f = fixture({ conversationMemoryCleanup: { async purgeSubject() { purges++; throw Error('conversation unavailable') } } })
  const first = await f.ops.profile({ userId: 'u1', requestId: 'conversation-owner-failed' }, f.context)
  assert.equal(first.phase, 'unknown'); assert.equal(first.usage, 'blocked')
  const result = await f.ops.profile({ userId: 'u1', requestId: 'conversation-owner-failed' }, f.context)
  assert.equal(result.phase, 'unknown'); assert.equal(result.cleanup, 'unknown')
  assert.equal(purges, 2); assert.equal(f.calls.profile, 1)
})

test('conversation cleanup cannot publish completion after delete permission or binding lease is revoked', async () => {
  for (const mode of ['permission', 'binding', 'stopped']) {
    let f
    const controller = new AbortController()
    f = fixture({ conversationMemoryCleanup: { async purgeSubject(_input, guard) {
      await guard.ensureCurrent()
      if (mode === 'permission') f.auth.authorize = async (_principal, operation) => operation === 'profiles.delete' ? 'denied' : 'allowed'
      else {
        if (mode === 'binding') f.context.binding = { ...binding, revision: 'r2' }
        else controller.abort()
        assert.equal(guard.isCurrent(), false)
      }
      await assert.rejects(guard.ensureCurrent(), error => error.code === (mode === 'permission' ? 'forbidden' : 'conflict'))
      return { usage: 'blocked', cleanup: 'completed', removedRecords: 1, removedSummaries: 1, removedEpisodes: 1, removedPartitions: 1 }
    } } })
    f.context.signal = controller.signal
    const requestId = 'conversation-revoke-' + mode
    await assert.rejects(f.ops.profile({ userId: 'u1', requestId }, f.context), error => error.code === (mode === 'permission' ? 'forbidden' : 'conflict'))
    const receipt = await f.store.readByRequestId(requestId)
    assert.notEqual(receipt.phase, 'completed'); assert.equal(receipt.impacts.some(row => row.id.startsWith('conversation-memory-')), false)
  }
})

test('deleting a profile field never purges conversation records, summaries or episodes', async () => {
  let purges = 0
  const f = fixture({ conversationMemoryCleanup: { async purgeSubject() { purges++; throw Error('must not purge') } } })
  const result = await f.ops.profile({ userId: 'u1', field: 'entries', value: 'entry-1', requestId: 'conversation-field' }, f.context)
  assert.equal(purges, 0); assert.equal(result.impacts.some(row => row.id.startsWith('conversation-memory-')), false)
})

test('conversation cleanup waits for source deletion readback', async () => {
  let purges = 0
  const f = fixture({ conversationMemoryCleanup: { async purgeSubject() { purges++; throw Error('must not purge') } } })
  f.profiles.list = async () => [{ binding, profile: { userId: 'u1', entries: [{ id: 'entry-1', category: 'fact', text: 'secret body' }] } }]
  await assert.rejects(f.ops.profile({ userId: 'u1', requestId: 'conversation-source-retained' }, f.context), error => error.code === 'unavailable')
  assert.equal(purges, 0)
  assert.equal((await f.store.readByRequestId('conversation-source-retained')).phase, 'unknown')
})

test('conversation cleanup retains the full exact account and conversation scope including private scenes', async () => {
  const variants = [binding,
    { ...binding, agentId: 'other-agent' },
    { ...binding, target: { ...binding.target, account: { ...binding.target.account, namespace: 'other' } } },
    { ...binding, target: { ...binding.target, kind: 'private', id: 'u1' } },
  ], partitions = new Set()
  for (const [index, selected] of variants.entries()) {
    const purges = [], f = fixture({ conversationMemoryCleanup: { async purgeSubject(input, guard) {
      await guard.ensureCurrent(); purges.push(structuredClone(input))
      return { usage: 'blocked', cleanup: 'completed', removedRecords: 0, removedSummaries: 0, removedEpisodes: 0, removedPartitions: 0 }
    } } }, selected)
    const result = await f.ops.profile({ userId: 'u1', requestId: 'conversation-scope-' + index }, f.context)
    assert.deepEqual(purges, [{ account: selected.target.account, agentId: selected.agentId, subjectId: 'u1', target: selected.target, through: result.createdAt }])
    const partition = result.impacts.find(row => row.id === 'conversation-memory-records').partition
    partitions.add(partition)
    assert.equal(partition.includes(selected.target.id), false)
  }
  assert.equal(partitions.size, variants.length)
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
