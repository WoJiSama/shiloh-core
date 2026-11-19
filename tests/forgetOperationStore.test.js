import assert from 'node:assert/strict'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
const { createForgetOperationStore } = await load('modules/runtime/infrastructure/forgetOperationStore.js')

function storage() {
  const values = new Map()
  return {
    values,
    async get(key) { return values.get(key) ?? null },
    async eval(script, { keys, arguments: args }) {
      if (script.includes('local existing = redis.call')) {
        const existing = values.get(keys[0])
        if (existing !== undefined) return existing
        if (values.has(keys[1])) return null
        values.set(keys[0], args[0]); values.set(keys[1], args[1]); return args[0]
      }
      if (script.includes("redis.call('GET', KEYS[1]) ~= ARGV[1]")) {
        if (values.get(keys[0]) !== args[0]) return 0
        values.set(keys[0], args[1]); return 1
      }
      throw new Error('unexpected script')
    },
  }
}

const binding = {
  source: 'configured', id: 'qq.group.room', revision: 'r1', agentId: 'agent', personaId: 'persona', connectionId: 'qq-main',
  target: { kind: 'group', id: 'room', account: { platform: 'qq', namespace: 'onebot', id: 'robot' } },
}

test('forget operation receipt survives a new store instance and deduplicates request IDs', async () => {
  const redis = storage(), first = createForgetOperationStore({ redis, now: () => 100 })
  const created = await first.begin({ requestId: 'request-1', kind: 'person-entry', binding, subject: { userId: 'user', entryId: 'entry' } })
  assert.equal(created.phase, 'accepted')
  assert.equal(created.usage, 'pending')
  assert.equal(created.cleanup, 'pending')
  assert.equal(await first.readByRequestId('request-1').then(row => row?.operationId), created.operationId)

  await assert.rejects(first.begin({ requestId: 'request-1', kind: 'person-entry', binding, subject: { userId: 'different', entryId: 'different' }, now: 200 }), /编号已用于其他操作/)
  const duplicate = await first.begin({ requestId: 'request-1', kind: 'person-entry', binding, subject: { userId: 'user', entryId: 'entry' }, now: 200 })
  assert.equal(duplicate.operationId, created.operationId)
  assert.equal(duplicate.subject.userId, 'user')

  const restarted = createForgetOperationStore({ redis, now: () => 300 })
  const committed = await restarted.markCommitted(created.operationId, {
    impacts: [{ kind: 'person-memory-entry', id: 'entry', partition: 'person-memory', state: 'completed' }], sourceRevision: 'memory-r2',
  })
  assert.equal(committed.phase, 'committed')
  assert.equal(committed.usage, 'blocked')
  assert.equal(committed.cleanup, 'pending')
  const completed = await restarted.complete(created.operationId)
  assert.equal(completed.phase, 'completed')
  assert.equal(completed.cleanup, 'completed')
  assert.equal(completed.impacts[0].id, 'entry')
  assert.equal(JSON.stringify(redis.values).includes('forgotten'), false)
})

test('terminal receipts cannot be turned into a successful retry and failures retain safe state', async () => {
  const redis = storage(), store = createForgetOperationStore({ redis, now: () => 100 })
  const created = await store.begin({ requestId: 'request-2', kind: 'character-memory', binding, subject: { groupId: 'room', memoryId: 'memory' } })
  const failed = await store.fail(created.operationId, { state: 'unknown', errorCode: 'CLEANUP_TIMEOUT', now: 110 })
  assert.equal(failed.phase, 'unknown')
  assert.equal(failed.cleanup, 'unknown')
  assert.equal(failed.usage, 'unknown')
  const retry = await store.complete(created.operationId, { now: 120 })
  assert.equal(retry.phase, 'unknown')
  assert.equal(retry.cleanup, 'unknown')
  await assert.rejects(store.update(created.operationId, { phase: 'accepted', now: 130 }), /不可回退/)
})


test('opaque full bindings and JSON scope partitions round trip', async () => {
  const redis = storage(), store = createForgetOperationStore({ redis })
  const opaque = { ...binding, id: 'binding|opaque', revision: 'revision|opaque', target: { ...binding.target, id: '测试群/123' } }
  const scope = JSON.stringify(['agent', 'qq', 'global', 'robot', 'group', '测试群/123'])
  const created = await store.begin({ requestId: 'opaque', kind: 'character-memory', binding: opaque, subject: { groupId: scope, memoryId: 'm1' } })
  const finished = await store.complete(created.operationId, { impacts: [{ kind: 'character-memory', id: 'm1', partition: `character:${scope}`, state: 'completed' }] })
  assert.deepEqual(finished.binding, opaque)
  assert.equal(finished.impacts[0].partition, `character:${scope}`)
})

test('revocation after an awaited Redis read prevents the next write', async () => {
  const redis = storage(), store = createForgetOperationStore({ redis }), original = redis.get
  const created = await store.begin({ requestId: 'guard', kind: 'person-profile', binding, subject: { userId: 'u1' } })
  let valid = true, writes = 0
  redis.get = async key => { const result = await original(key); valid = false; return result }
  const originalEval = redis.eval
  redis.eval = async (...args) => { writes++; return originalEval(...args) }
  await assert.rejects(store.complete(created.operationId, {}, { ensureCurrent() { if (!valid) throw new Error('revoked') } }), /revoked/)
  assert.equal(writes, 0)
})

test('an operation ID collision cannot overwrite an existing receipt or claim a new request', async () => {
  const redis = storage(), store = createForgetOperationStore({ redis })
  const first = await store.begin({ requestId: 'original', kind: 'person-profile', binding, subject: { userId: 'u1' } })
  await assert.rejects(store.begin({ requestId: 'collision', operationId: first.operationId, kind: 'person-profile', binding, subject: { userId: 'u2' } }))
  assert.equal((await store.read(first.operationId)).subject.userId, 'u1')
  assert.equal(await store.readByRequestId('collision'), undefined)
})

test('cleanup plans survive restart and only confirmed source deletion can resume failed owners', async () => {
  const redis = storage(), first = createForgetOperationStore({ redis, now: () => 100 })
  const receipt = await first.begin({ requestId: 'cleanup-plan', kind: 'person-profile', binding,
    subject: { userId: 'u1' }, cleanupOwners: ['local-emoji', 'semantic-memory'] })
  assert.deepEqual(receipt.cleanupPlan, { version: 1, sourceCommitted: false,
    owners: [{ owner: 'local-emoji', state: 'pending' }, { owner: 'semantic-memory', state: 'pending' }] })
  await assert.rejects(first.resumeCleanup(receipt.operationId), /来源删除尚未确认/u)
  await first.markCommitted(receipt.operationId)
  await first.update(receipt.operationId, { cleanupOwner: { owner: 'semantic-memory', state: 'completed' } })
  await first.fail(receipt.operationId, { state: 'unknown', errorCode: 'OWNER_UNAVAILABLE' })
  const restarted = createForgetOperationStore({ redis, now: () => 200 })
  const resumed = await restarted.resumeCleanup(receipt.operationId)
  assert.equal(resumed.phase, 'settling'); assert.equal(resumed.cleanup, 'pending'); assert.equal(resumed.usage, 'blocked')
  assert.equal(resumed.createdAt, 100); assert.deepEqual(resumed.binding, binding)
  assert.equal(resumed.cleanupPlan.sourceCommitted, true)
  assert.deepEqual(resumed.cleanupPlan.owners, [{ owner: 'local-emoji', state: 'pending' }, { owner: 'semantic-memory', state: 'completed' }])
  await assert.rejects(restarted.update(receipt.operationId, { cleanupOwner: { owner: 'semantic-memory', state: 'unknown' } }), /已确认的清理结果不可回退/u)
  await assert.rejects(restarted.update(receipt.operationId, { cleanupOwner: { owner: 'conversation-memory', state: 'completed' } }), /清理负责人不在原计划中/u)
})
