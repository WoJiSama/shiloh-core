import assert from 'node:assert/strict'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { createAgentMediaOutboxReader, agentMediaOutboxId } = await load('modules/media/infrastructure/agentMediaOutboxLedger.js')
const { conversationAddressKey } = await load('modules/runtime/domain/agentBindings.js')
const at = 1800000000000, prefix = 'agent:media-outbox:v1:job:'
function persisted(state = 'queued', index = 0, selected = {}) {
  const target = { account: { platform: 'qq', namespace: 'global', id: '10001' }, kind: 'group', id: '30001' }
  const binding = { source: 'configured', id: conversationAddressKey(target), revision: 'revision-1', agentId: 'daily', personaId: 'default', connectionId: 'qq-main', target, ...selected }
  const source = { messageId: `PRIVATE-SOURCE-${index}`, sender: { ...target.account, id: 'PRIVATE-SENDER' }, occurredAt: at - 1000,
    share: { provider: 'bilibili', reference: { kind: 'video', id: 'BV1234567890' } } }
  const effects = ['completed', 'sending', 'unknown'].includes(state)
    ? [{ effect: 'forward', beganAt: at + index, state: state === 'completed' ? 'sent' : state === 'sending' ? 'pending' : 'unknown',
      ...(state === 'sending' ? {} : { finishedAt: at + index + 100, receipt: state === 'completed'
        ? { state: 'sent', messageId: 'PRIVATE-NATIVE-RECEIPT' } : { state: 'unknown' } }) }]
    : []
  const record = { version: 1, id: agentMediaOutboxId(binding, source.messageId), sequence: index + 1, source, binding, state,
    createdAt: at, updatedAt: at + index + 100, expiresAt: at + 86400000, prepareAttempts: state === 'queued' ? 0 : 1,
    prepareFailures: 0, nextAttemptAt: 0, effects }
  return [prefix + record.id, JSON.stringify(record)]
}
function fixture(entries, batches = [entries.map(([key]) => key)]) {
  const values = new Map(entries), reads = [], scanned = [], iteratorCalls = []
  const storage = {
    async get(key) { reads.push(key); return values.get(key) ?? null },
    async *scanIterator(options) {
      scanned.push(options)
      try { for (const batch of batches) { iteratorCalls.push(batch); yield batch } }
      finally { iteratorCalls.push('closed') }
    },
  }
  return { values, reads, scanned, iteratorCalls, storage, reader: createAgentMediaOutboxReader(storage) }
}

test('read-only media observations include retained terminal evidence and remove all source and native receipt details', async () => {
  const entries = ['queued', 'preparing', 'sending', 'completed', 'failed', 'cancelled', 'unknown'].map((state, index) => persisted(state, index))
  const f = fixture(entries), before = [...f.values]
  const result = await f.reader.read()
  assert.equal(result.scanTruncated, false)
  assert.deepEqual(result.records.map(row => row.state), ['unknown', 'cancelled', 'failed', 'completed', 'sending', 'preparing', 'queued'])
  assert.deepEqual(f.scanned, [{ MATCH: prefix + '*', COUNT: 100 }])
  assert.deepEqual([...f.values], before, 'observation cannot recover or refresh any record')
  const done = result.records.find(row => row.state === 'completed')
  assert.deepEqual(done.effects, [{ effect: 'forward', state: 'sent', beganAt: at + 3, finishedAt: at + 103 }])
  assert.deepEqual(done.binding, JSON.parse(entries[3][1]).binding, 'the console receives complete versioned ownership for authorization')
  assert.equal(done.provider, 'bilibili'); assert.equal(done.prepareAttempts, 1); assert.equal(done.expiresAt, at + 86400000)
  const printed = JSON.stringify(result)
  for (const secret of ['PRIVATE-SOURCE', 'PRIVATE-SENDER', 'PRIVATE-NATIVE-RECEIPT', 'BV1234567890', 'receipt', 'share', 'https:', 'url']) {
    assert.equal(printed.includes(secret), false, secret)
  }
  assert.equal(Object.hasOwn(done, 'source'), false)
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.records)); assert.ok(Object.isFrozen(done.effects[0]))
  assert.ok(Object.isFrozen(done.binding.target.account))
})

test('invalid, missing, duplicate and cross-key records cannot leak or trigger unbounded reads', async () => {
  const good = persisted(), missing = persisted('queued', 1)[0], mismatched = persisted('queued', 2), corrupt = persisted('queued', 3)
  const wrongKey = prefix + 'f'.repeat(64), poisonKey = 'ytbot:message_pipeline:PRIVATE-TOKEN'
  const f = fixture([good, [wrongKey, mismatched[1]], [corrupt[0], '{"source":"PRIVATE-RAW-SECRET"}']],
    [[poisonKey, prefix + 'not-a-job', good[0], good[0], missing, wrongKey, corrupt[0]]])
  const result = await f.reader.read()
  assert.equal(result.scanTruncated, false); assert.deepEqual(result.records.map(row => row.id), [JSON.parse(good[1]).id])
  assert.deepEqual(f.reads, [good[0], missing, wrongKey, corrupt[0]])
  assert.equal(JSON.stringify(result).includes('PRIVATE-RAW-SECRET'), false)
  f.values.set(corrupt[0], JSON.stringify({ ...JSON.parse(corrupt[1]), binding: { ...JSON.parse(corrupt[1]).binding, id: 'foreign-binding' } }))
  assert.deepEqual((await f.reader.read()).records.map(row => row.id), [JSON.parse(good[1]).id])
})

test('work remains bounded for oversized batches, repeated keys and a sparse scan', async () => {
  const entries = Array.from({ length: 20 }, (_, index) => persisted('queued', index))
  const f = fixture(entries)
  const result = await f.reader.read({ maxScanned: 3 })
  assert.equal(result.scanTruncated, true); assert.equal(result.records.length, 3); assert.equal(f.reads.length, 3)
  assert.equal(f.iteratorCalls.at(-1), 'closed')
  const repeated = fixture([entries[0]], [Array(50000).fill(entries[0][0])])
  assert.equal((await repeated.reader.read({ maxScanned: 2 })).scanTruncated, true)
  assert.equal(repeated.reads.length, 1)
  const empty = fixture([], Array.from({ length: 1000 }, () => []))
  assert.equal((await empty.reader.read()).scanTruncated, true)
  assert.equal(empty.iteratorCalls.length, 66, 'at most 65 yielded batches are inspected before cleanup')
  const clipped = fixture(entries)
  const limited = await clipped.reader.read({ limit: 2 })
  assert.equal(limited.scanTruncated, true)
  assert.deepEqual(limited.records.map(row => row.updatedAt), [at + 119, at + 118])
})

test('guard and abort invalidation stop reads and retain the caller error instead of returning stale rows', async () => {
  const entries = [persisted(), persisted('completed', 1)], f = fixture(entries), revoked = new Error('binding changed')
  let current = true
  const originalGet = f.storage.get
  f.storage.get = async key => { const raw = await originalGet(key); current = false; return raw }
  await assert.rejects(f.reader.read({ guard: { ensureCurrent() { if (!current) throw revoked } } }), error => error === revoked)
  assert.equal(f.reads.length, 1)
  const abort = new AbortController(), blocked = fixture(entries)
  blocked.storage.get = async key => { blocked.reads.push(key); abort.abort(); return blocked.values.get(key) }
  await assert.rejects(blocked.reader.read({ signal: abort.signal }), error => error.name === 'AbortError')
  assert.equal(blocked.reads.length, 1)
  const once = fixture(entries)
  let checked = 0
  await assert.rejects(once.reader.read({ guard: { ensureCurrent() { if (++checked === 3) throw revoked } } }), error => error === revoked)
})

test('invalid limits and storage failures return sanitized errors without exposing backend material', async () => {
  const f = fixture([persisted()])
  for (const options of [{ maxScanned: 0 }, { maxScanned: 2001 }, { maxScanned: 1.5 }, { limit: 0 }, { limit: 2001 }]) {
    await assert.rejects(f.reader.read(options), /媒体投递账本不可用或任务已失效/u)
  }
  assert.deepEqual(f.scanned, []); assert.deepEqual(f.reads, [])
  f.storage.get = async () => { throw new Error('PRIVATE-REDIS-TOKEN') }
  await assert.rejects(f.reader.read(), error => !String(error).includes('PRIVATE-REDIS-TOKEN'))
  f.storage.scanIterator = async function* () { throw new Error('PRIVATE-SCAN-CONNECTION') }
  await assert.rejects(f.reader.read(), error => !String(error).includes('PRIVATE-SCAN-CONNECTION'))
})
