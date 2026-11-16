import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { createAgentMusicExtractionLedger } from '../dist/backend/modules/media/infrastructure/agentMusicExtractionLedger.js'
import { createAgentBindingDirectory } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const redisTest = { skip: !redisAvailable, timeout: 15_000 }
const target = { account: { platform: 'qq', namespace: 'global', id: '19000501' }, kind: 'group', id: '312501' }
const binding = createAgentBindingDirectory({ version: 1, agents: [{ id: 'daily', personaId: 'default' }],
  connections: [{ id: 'qq', platform: 'qq', namespace: 'global', accountId: target.account.id }],
  bindings: [{ connectionId: 'qq', kind: 'group', conversationId: target.id, agentId: 'daily' }] }, 'revision-ledger-1').resolve(target)
const sent = messageId => ({ state: 'sent', messageId })
const uploaded = fileId => ({ state: 'uploaded', fileId })
const wrap = storage => ({ get: storage.get.bind(storage), eval: storage.eval.bind(storage) })
async function fixture(t) {
  const redis = await createAgentRedisFixture(t, 'music-extraction-ledger')
  return { ...redis, ledger: createAgentMusicExtractionLedger(redis.storage),
    async keys() { return redis.reader.keys(redis.prefix + 'agent:music-extraction:v1:*') } }
}

test('music extraction ledger persists every pending stage before delivery and keeps only bounded evidence for seven days', redisTest, async t => {
  const f = await fixture(t), session = await f.ledger.claim(binding, 'trigger-501')
  assert.ok(session)
  const [key] = await f.keys()
  assert.match(key.slice(f.prefix.length), /^agent:music-extraction:v1:[a-f0-9]{64}$/u)
  const ttl = await f.reader.ttl(key)
  assert.ok(ttl > 604_790 && ttl <= 604_800)
  let sideEffects = 0
  for (const [stage, receipt] of [
    ['file', { ...uploaded('platform-file-501'), messageId: 'platform-file-message-501', url: 'https://provider.invalid/private', title: 'PRIVATE_TITLE', base64: 'PRIVATE_BYTES', cookie: 'PRIVATE_COOKIE' }],
    ['introBundle', { state: 'failed', code: 'https://provider.invalid/PRIVATE_FAILURE_TOKEN' }],
    ['introText', sent('intro-message-501')], ['preview', sent('preview-message-501')], ['failureText', sent('failure-message-501')],
  ]) {
    await session.begin(stage)
    const pending = await f.ledger.inspect(binding, 'trigger-501')
    assert.equal(pending.state, 'active'); assert.equal(pending.stages.at(-1).stage, stage); assert.equal(pending.stages.at(-1).state, 'pending')
    sideEffects++
    await session.finish(stage, receipt)
  }
  await assert.rejects(session.begin('preview'))
  await session.close('completed')
  assert.equal(sideEffects, 5)
  const record = await f.ledger.inspect(binding, 'trigger-501')
  assert.equal(record.state, 'completed'); assert.equal(record.stages.length, 5)
  assert.deepEqual(record.stages[0].receipt, { state: 'uploaded', fileId: 'platform-file-501', messageId: 'platform-file-message-501' })
  assert.deepEqual(record.stages[1].receipt, { state: 'failed', code: null })
  assert.throws(() => { record.stages[0].receipt.fileId = 'tampered' }, TypeError)
  assert.throws(() => { record.stages.push({}) }, TypeError)
  assert.equal(await f.ledger.claim(binding, 'trigger-501'), undefined)
  const raw = await f.reader.get(key)
  for (const value of ['PRIVATE_', 'provider.invalid', target.id, target.account.id, 'trigger-501', binding.revision]) assert.ok(!raw.includes(value))
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['createdAt', 'stages', 'state', 'updatedAt', 'version'])
})

test('parallel claims and separate ledger instances sharing one host storage never steal a live session', redisTest, async t => {
  const f = await fixture(t), second = createAgentMusicExtractionLedger(f.storage)
  const claims = await Promise.all(Array.from({ length: 40 }, (_, index) => (index % 2 ? f.ledger : second).claim(binding, 'parallel-trigger')))
  assert.equal(claims.filter(Boolean).length, 1)
  const session = claims.find(Boolean)
  await session.begin('file')
  assert.equal(await second.claim(binding, 'parallel-trigger'), undefined)
  assert.equal((await second.inspect(binding, 'parallel-trigger')).stages[0].state, 'pending')
  await session.finish('file', uploaded('parallel-file'))
  await session.close('completed')
  assert.equal((await f.ledger.inspect(binding, 'parallel-trigger')).state, 'completed')
})

test('deduplication includes the full account, conversation, binding token and triggering message', redisTest, async t => {
  const f = await fixture(t)
  const bindings = [binding, { ...binding, revision: 'revision-ledger-2' }, { ...binding, agentId: 'replacement' },
    { ...binding, target: { ...target, id: 'other-room' } }, { ...binding, target: { ...target, account: { ...target.account, id: 'other-account' } } },
    { ...binding, target: { ...target, account: { ...target.account, namespace: 'other-namespace' } } },
    { ...binding, target: { ...target, account: { ...target.account, platform: 'other' } } }]
  for (const selected of bindings) {
    const session = await f.ledger.claim(selected, 'same-trigger')
    assert.ok(session); await session.close('cancelled')
  }
  const nextMessage = await f.ledger.claim(binding, 'different-trigger')
  assert.ok(nextMessage); await nextMessage.close('cancelled')
  assert.equal((await f.keys()).length, bindings.length + 1)
})

test('restart freezes every unfinished claim, including no-send and previously confirmed stages, without retrying delivery', redisTest, async t => {
  const f = await fixture(t)
  for (const mode of ['claimed', 'pending', 'confirmed']) {
    const trigger = `restart-${mode}`, session = await f.ledger.claim(binding, trigger)
    if (mode !== 'claimed') await session.begin('file')
    if (mode === 'confirmed') await session.finish('file', uploaded('confirmed-before-restart'))
    session.abandon()
    const restarted = createAgentMusicExtractionLedger(wrap(f.storage), { now: () => Date.now() + 1000 })
    assert.equal(await restarted.claim(binding, trigger), undefined)
    const record = await restarted.inspect(binding, trigger)
    assert.equal(record.state, 'unknown')
    if (mode === 'pending') assert.deepEqual(record.stages[0].receipt, { state: 'unknown' })
    if (mode === 'confirmed') assert.equal(record.stages[0].state, 'uploaded')
    const snapshot = JSON.stringify(record)
    assert.equal(await restarted.claim(binding, trigger), undefined)
    assert.equal(JSON.stringify(await restarted.inspect(binding, trigger)), snapshot, 'unknown records do not gain a fresh attempt or new timestamps')
    await assert.rejects(session.begin('preview')); await assert.rejects(session.close('cancelled'))
  }
})

test('inspection alone atomically freezes a foreign pending record and old owners cannot overwrite the result', redisTest, async t => {
  const f = await fixture(t), session = await f.ledger.claim(binding, 'foreign-reader')
  await session.begin('preview')
  const foreign = createAgentMusicExtractionLedger(wrap(f.storage))
  const record = await foreign.inspect(binding, 'foreign-reader')
  assert.equal(record.state, 'unknown'); assert.equal(record.stages[0].state, 'unknown')
  await assert.rejects(session.finish('preview', sent('late-confirmed-message')))
  assert.deepEqual(await foreign.inspect(binding, 'foreign-reader'), record)
})

test('missing, zero, malformed and wrong-kind delivery IDs become unknown and freeze all following stages', redisTest, async t => {
  const f = await fixture(t)
  const cases = [
    ['file', { state: 'uploaded' }], ['file', uploaded('')], ['file', uploaded('0')], ['file', uploaded('x\nsecret')],
    ['file', uploaded('https://provider.invalid/file')], ['file', { ...uploaded('valid-file'), messageId: '0' }], ['file', sent('not-a-file-id')],
    ['preview', { state: 'sent' }], ['preview', sent('0')], ['preview', sent('x'.repeat(129))], ['preview', sent('x\u0000y')],
    ['preview', { ...uploaded('file-id'), messageId: 'message-id' }], ['preview', { state: 'unknown', messageId: 'contradictory-id' }],
  ]
  for (const [index, [stage, receipt]] of cases.entries()) {
    const trigger = `invalid-${index}`, session = await f.ledger.claim(binding, trigger)
    await session.begin(stage); await session.finish(stage, receipt)
    const record = await f.ledger.inspect(binding, trigger)
    assert.equal(record.state, 'unknown'); assert.deepEqual(record.stages[0].receipt, { state: 'unknown' })
    await assert.rejects(session.begin('failureText')); await assert.rejects(session.close('completed')); await assert.rejects(session.close('cancelled'))
    assert.equal(await f.ledger.claim(binding, trigger), undefined)
  }
})

test('explicit rejection wins over contradictory success fields and permits a different definite-failure fallback', redisTest, async t => {
  const f = await fixture(t)
  for (const [index, [stage, receipt]] of [
    ['file', { ...uploaded('false-success-file'), retcode: 1, code: 'PRIVATE_PROVIDER_ERROR' }],
    ['introBundle', { ...sent('false-success-message'), success: false }],
    ['preview', { ...sent('false-success-message'), state: 'failed', code: 'PRIVATE_PROVIDER_ERROR' }],
  ].entries()) {
    const trigger = `failed-${index}`, session = await f.ledger.claim(binding, trigger)
    await session.begin(stage); await session.finish(stage, receipt)
    assert.deepEqual((await f.ledger.inspect(binding, trigger)).stages[0].receipt, { state: 'failed', code: null })
    await assert.rejects(session.begin(stage))
    await session.begin('failureText'); await session.finish('failureText', sent(`fallback-${index}`)); await session.close('failed')
    assert.equal((await f.ledger.inspect(binding, trigger)).state, 'failed')
  }
})

test('receipt validation accepts other realms while hostile accessors and proxies cannot run or manufacture success', redisTest, async t => {
  const f = await fixture(t), crossRealm = await f.ledger.claim(binding, 'cross-realm')
  await crossRealm.begin('preview')
  await crossRealm.finish('preview', vm.runInNewContext('({state:"sent",messageId:"other-realm-id"})'))
  await crossRealm.close('completed')
  assert.equal((await f.ledger.inspect(binding, 'cross-realm')).stages[0].receipt.messageId, 'other-realm-id')
  let invoked = 0
  const getter = { state: 'sent', get messageId() { invoked++; return 'manufactured-id' } }
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('host trap') } })
  for (const [index, receipt] of [getter, proxy, Object.create({ state: 'sent', messageId: 'inherited-id' })].entries()) {
    const trigger = `hostile-${index}`, session = await f.ledger.claim(binding, trigger)
    await session.begin('preview'); await session.finish('preview', receipt)
    assert.equal((await f.ledger.inspect(binding, trigger)).state, 'unknown')
  }
  assert.equal(invoked, 0)
})

test('Redis save failures before a stage or after a confirmed delivery stop the owner and never permit a resend', redisTest, async t => {
  const f = await fixture(t)
  for (const mode of ['begin-write-fails', 'finish-write-fails', 'finish-ack-lost']) {
    let failNext = false
    const faulty = { get: f.storage.get.bind(f.storage), async eval(script, options) {
      if (!failNext) return f.storage.eval(script, options)
      failNext = false
      if (mode === 'finish-ack-lost') await f.storage.eval(script, options)
      throw new Error('synthetic Redis write failure')
    } }
    const ledger = createAgentMusicExtractionLedger(faulty), session = await ledger.claim(binding, mode)
    let sends = 0
    if (mode === 'begin-write-fails') { failNext = true; await assert.rejects(session.begin('file')) }
    else {
      await session.begin('file'); sends++
      failNext = true; await assert.rejects(session.finish('file', uploaded('already-uploaded')))
    }
    await assert.rejects(session.begin('file')); await assert.rejects(session.close('cancelled'))
    const record = await ledger.inspect(binding, mode)
    assert.equal(record.state, 'unknown')
    assert.equal(sends, mode === 'begin-write-fails' ? 0 : 1)
    if (mode === 'finish-write-fails') assert.equal(record.stages[0].state, 'unknown')
    if (mode === 'finish-ack-lost') assert.equal(record.stages[0].state, 'uploaded', 'do not erase an already persisted confirmed file receipt')
    assert.equal(await ledger.claim(binding, mode), undefined)
  }
})

test('stage ordering, simultaneous calls, invalid identity and malformed stored records all fail closed', redisTest, async t => {
  const f = await fixture(t), session = await f.ledger.claim(binding, 'stage-order')
  await assert.rejects(session.finish('file', uploaded('before-begin')))
  const first = session.begin('file')
  await assert.rejects(session.begin('preview'))
  await first
  await assert.rejects(session.begin('introText')); await assert.rejects(session.close('cancelled'))
  await assert.rejects(session.finish('preview', sent('wrong-stage')))
  await session.finish('file', uploaded('once-only'))
  await assert.rejects(session.finish('file', uploaded('twice'))); await assert.rejects(session.begin('file'))
  await session.close('cancelled')
  for (const trigger of ['', '0', '000', '0\n', 'x'.repeat(129), 0, null]) await assert.rejects(f.ledger.claim(binding, trigger))
  await assert.rejects(f.ledger.claim({ ...binding, target: { ...target, account: { ...target.account, id: '' } } }, 'valid-trigger'))
  const broken = await f.ledger.claim(binding, 'malformed-record'); broken.abandon()
  const keys = await f.keys()
  const recordKey = await (async () => { for (const candidate of keys) if ((await f.reader.get(candidate)).includes('"state":"active"')) return candidate })()
  assert.ok(recordKey)
  await f.reader.set(recordKey, JSON.stringify({ version: 1, state: 'active', createdAt: 1, updatedAt: 1, stages: [], url: 'https://provider.invalid/private' }))
  await assert.rejects(f.ledger.inspect(binding, 'malformed-record'))
  await assert.rejects(f.ledger.claim(binding, 'malformed-record'))
})
