import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { createAgentDiceState } = await load('modules/dice/infrastructure/agentDiceState.js')
const { connectAgentRedis, openAgentRedis, agentRedisPrefix } = await load('modules/runtime/infrastructure/agentRedis.js')
const { conversationAddressKey, agentBindingIdentity, agentConversationKey } = await load('modules/runtime/domain/agentBindings.js')
const root = 'agent:dice:engine:v1', options = { timeout: 15_000 }
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const account = { platform: 'fixture', namespace: 'settlement', id: 'bot' }
const binding = (changes = {}) => ({ source: 'configured', id: 'binding', revision: 'one', agentId: 'daily', personaId: 'persona', connectionId: 'connection',
  target: { account, kind: 'group', id: 'room' }, ...changes })
const source = id => ({ messageId: id, authorId: 'alice', sourceHash: hash(['source', id]), occurredAt: 1_800_000_000_000 })
const ownerHash = selected => hash([agentBindingIdentity(selected), agentConversationKey(selected)])
const operationId = (selected, id) => hash([conversationAddressKey(selected.target), id])
const privateRef = (origin, index = 0, deliveryId = `delivery-${origin}-${index}`) => ({ packId: 'pack', deliveryId, originMessageId: origin, index })
const lookup = (origin, index = 0) => ({ packId: 'pack', deliveryId: privateRef(origin, index).deliveryId })
const data = (selected, id, count = 1, value = 10) => {
  const operation = operationId(selected, id), effects = [], refs = [], queue = []
  for (let index = 0; index < count; index++) {
    const ref = privateRef(id, index), recipientId = index ? 'carol' : 'bob'
    refs.push(ref); effects.push({ kind: 'private', recipientId, text: `PRIVATE-BODY-${id}-${index}`, packId: ref.packId, deliveryId: ref.deliveryId })
    queue.push({ deliveryId: ref.deliveryId, userId: recipientId, text: effects.at(-1).text, state: 'unknown', attempts: 0,
      origin: { source: { messageId: id, author: { id: 'alice' } }, operationId: operation }, attempt: { operationId: operation, index } })
  }
  effects.push({ kind: 'public', text: 'private results delivered' })
  return { state: { version: 1, cards: { alice: { hp: value } }, rules: { version: 1, packs: { pack: { players: {}, group: {
    privateDeliveries: queue, audit: [{ id: `audit-${id}`, source: { messageId: id, authorId: 'alice' }, output: `AUDIT-BODY-${id}`, args: { roll: 'PRIVATE-ARGS' }, targets: [{ id: 'bob', kind: 'player' }] }],
  } } } } }, effects, event: [{ kind: 'roll', subjectId: 'bob', text: `EVENT-BODY-${id}` }], privateDeliveries: refs, subjectIds: ['alice', 'bob'] }
}
const group = state => state.rules.packs.pack.group

async function fixture(t) {
  assert.equal(spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status, 0, 'settlement tests require real isolated Redis')
  const directory = await mkdtemp(path.join(tmpdir(), 'dice-settlement-')), socket = path.join(directory, 'redis.sock')
  const server = spawn('redis-server', ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' }), exited = once(server, 'exit')
  let reader, connection
  t.after(async () => {
    try { await connection?.close(); if (reader?.isOpen) await reader.close() }
    finally { if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM'); await exited; await rm(directory, { recursive: true, force: true }) }
  })
  for (let tries = 0; tries < 100; tries++) { if (await stat(socket).then(() => true, () => false)) break; await delay(10) }
  reader = await connectAgentRedis(`unix://${socket}`)
  connection = await openAgentRedis({ url: `unix://${socket}`, instance: 'settlement', onLost() {} })
  const storage = connection.storage, prefix = agentRedisPrefix('settlement'), store = createAgentDiceState(storage)
  return { reader, storage, prefix, store,
    operationKey: (selected, id) => prefix + root + ':operation:' + operationId(selected, id),
    stateKey: selected => prefix + root + ':state:' + ownerHash(selected),
    async prepare(id, selected = binding(), payload = data(selected, id)) {
      const selectedSource = source(id), begin = await store.begin(selected, selectedSource)
      assert.equal(begin.kind, 'started')
      const row = await store.commit(selected, begin.claim, payload); assert.ok(row)
      return { row, source: selectedSource, binding: selected, payload }
    },
  }
}

test('each private receipt and full business snapshot commit atomically before the next effect is claimable', options, async t => {
  const f = await fixture(t), p = await f.prepare('multi', binding(), data(binding(), 'multi', 2))
  assert.equal((await f.store.readDelivery(p.binding, lookup('multi'))).state, 'unknown')
  for (let index = 0; index < 2; index++) {
    assert.ok(await f.store.claimEffect(p.binding, p.source, index))
    const snapshot = await f.store.read(p.binding), nextState = structuredClone(snapshot.state)
    group(nextState).privateDeliveries = group(nextState).privateDeliveries.filter(item => item.deliveryId !== privateRef('multi', index).deliveryId)
    const receipts = await Promise.all(Array.from({ length: 4 }, () => f.store.settleEffectAndState(p.binding, p.source, index,
      { state: 'sent', messageId: `native-${index}` }, { snapshot, nextState })))
    assert.equal(receipts.filter(Boolean).length, 1)
    const committed = receipts.find(Boolean)
    assert.equal(committed.state, 'ready'); assert.equal(committed.completed, index + 1); assert.equal(committed.committedRevision, index + 2)
    assert.equal((await f.store.readDelivery(p.binding, lookup('multi', index))).state, 'sent')
    assert.equal(group((await f.store.read(p.binding)).state).privateDeliveries.length, 1 - index)
  }
  assert.ok(await f.store.claimEffect(p.binding, p.source, 2))
  const complete = await f.store.settleEffect(p.binding, p.source, 2, { state: 'confirmed' })
  assert.equal(complete.state, 'confirmed'); assert.equal(complete.committedRevision, 3); assert.equal(complete.receipts.length, 3)
  assert.equal((await f.store.read(p.binding)).state.cards.alice.hp, 10)
})

test('concurrent card state wins a stale settlement CAS and the operation and private index freeze unknown together', options, async t => {
  const f = await fixture(t), p = await f.prepare('conflict')
  await f.store.claimEffect(p.binding, p.source, 0)
  const snapshot = await f.store.read(p.binding), nextState = structuredClone(snapshot.state); group(nextState).privateDeliveries = []
  const other = await f.store.begin(p.binding, source('newer-card')), newest = structuredClone(snapshot.state); newest.cards.alice.hp = 27
  assert.ok(await f.store.commit(p.binding, other.claim, { state: newest, effects: [], event: null }))
  assert.equal(await f.store.settleEffectAndState(p.binding, p.source, 0, { state: 'sent', messageId: 'late-native' }, { snapshot, nextState }), undefined)
  const current = await f.store.read(p.binding), row = JSON.parse(await f.reader.get(f.operationKey(p.binding, 'conflict')))
  assert.equal(current.revision, 2); assert.equal(current.state.cards.alice.hp, 27); assert.equal(group(current.state).privateDeliveries.length, 1)
  assert.equal(row.state, 'unknown'); assert.equal('effects' in row, false); assert.equal('receipts' in row, false)
  assert.equal((await f.store.readDelivery(p.binding, lookup('conflict'))).state, 'unknown')
  assert.equal(await f.store.claimEffect(p.binding, p.source, 1), undefined)
})

test('settlement compares the exact observed Redis snapshot bytes and never canonicalizes a concurrent rewrite', options, async t => {
  const f = await fixture(t), p = await f.prepare('raw-cas')
  const initial = await f.reader.get(f.stateKey(p.binding)); await f.reader.set(f.stateKey(p.binding), ' ' + initial)
  await f.store.claimEffect(p.binding, p.source, 0)
  const snapshot = await f.store.read(p.binding), nextState = structuredClone(snapshot.state); group(nextState).privateDeliveries = []
  assert.ok(await f.store.settleEffectAndState(p.binding, p.source, 0, { state: 'sent', messageId: 'exact-read' }, { snapshot, nextState }))
  const second = await f.prepare('raw-conflict'), observed = await f.store.read(second.binding)
  await f.store.claimEffect(second.binding, second.source, 0)
  await f.reader.set(f.stateKey(second.binding), ' ' + await f.reader.get(f.stateKey(second.binding)))
  assert.equal(await f.store.settleEffectAndState(second.binding, second.source, 0, { state: 'sent', messageId: 'stale-bytes' }, { snapshot: observed, nextState: observed.state }), undefined)
})

test('a lost settlement acknowledgement is abandoned from ready and never authorizes the public continuation', options, async t => {
  const f = await fixture(t), p = await f.prepare('lost-settle')
  await f.store.claimEffect(p.binding, p.source, 0)
  const snapshot = await f.store.read(p.binding), nextState = structuredClone(snapshot.state); group(nextState).privateDeliveries = []
  const lost = createAgentDiceState({ get: key => f.storage.get(key), async eval(script, args) { await f.storage.eval(script, args); throw Error('lost-native-ack') } })
  await assert.rejects(lost.settleEffectAndState(p.binding, p.source, 0, { state: 'sent', messageId: 'real-receipt' }, { snapshot, nextState }), /骰子业务持久状态不可用/u)
  assert.equal(JSON.parse(await f.reader.get(f.operationKey(p.binding, 'lost-settle'))).state, 'ready')
  assert.equal((await f.store.read(p.binding)).revision, 2); assert.equal(group((await f.store.read(p.binding)).state).privateDeliveries.length, 0)
  assert.equal((await f.store.abandonOperation(p.binding, p.source)).state, 'unknown')
  assert.equal((await f.store.readDelivery(p.binding, lookup('lost-settle'))).state, 'sent', 'a durable native receipt remains evidence')
  assert.equal(await createAgentDiceState(f.storage).claimEffect(p.binding, p.source, 1), undefined)
  for (const state of ['preparing', 'pending']) {
    const id = `abandon-${state}`, begin = await f.store.begin(p.binding, source(id))
    if (state === 'pending') { await f.store.commit(p.binding, begin.claim, data(p.binding, id)); await f.store.claimEffect(p.binding, source(id), 0) }
    assert.equal((await f.store.abandonOperation(p.binding, source(id))).state, 'unknown')
    assert.equal(await f.store.claimEffect(p.binding, source(id), 0), undefined)
  }
})

test('abandon rechecks a ready operation concurrently claimed pending rather than leaving an authorized attempt alive', options, async t => {
  const f = await fixture(t), p = await f.prepare('abandon-race')
  let raced = false
  const concurrent = createAgentDiceState({ get: key => f.storage.get(key), async eval(script, args) {
    if (!raced && args.arguments.at(-1) === 'abandon') {
      raced = true; assert.ok(await f.store.claimEffect(p.binding, p.source, 0))
    }
    return f.storage.eval(script, args)
  } })
  assert.equal((await concurrent.abandonOperation(p.binding, p.source)).state, 'unknown')
  assert.equal(raced, true)
  assert.equal(await f.store.settleEffect(p.binding, p.source, 0, { state: 'sent', messageId: 'late-platform' }), undefined)
  assert.equal(await f.store.claimEffect(p.binding, p.source, 1), undefined)
})

test('explicit retries require the same owner and a failed origin index and atomically consume that proof', options, async t => {
  const f = await fixture(t), p = await f.prepare('origin')
  await f.store.claimEffect(p.binding, p.source, 0)
  const snapshot = await f.store.read(p.binding), failedState = structuredClone(snapshot.state); group(failedState).privateDeliveries[0].state = 'failed'
  assert.equal((await f.store.settleEffectAndState(p.binding, p.source, 0, { state: 'failed' }, { snapshot, nextState: failedState })).state, 'failed')
  assert.equal((await f.store.readDelivery(p.binding, lookup('origin'))).state, 'failed')
  const makeRetry = async (id, selected = p.binding) => {
    const begin = await f.store.begin(selected, source(id)), payload = data(selected, id)
    payload.privateDeliveries = [privateRef('origin')]
    return { begin, payload, selected }
  }
  const foreign = await makeRetry('foreign-retry', binding({ agentId: 'other' }))
  assert.equal(await f.store.commit(foreign.selected, foreign.begin.claim, foreign.payload), undefined)
  const retry = await makeRetry('retry-one')
  assert.ok(await f.store.commit(p.binding, retry.begin.claim, retry.payload))
  const index = await f.store.readDelivery(p.binding, lookup('origin'))
  assert.equal(index.state, 'unknown'); assert.equal(index.operationId, operationId(p.binding, 'retry-one'))
  const duplicate = await makeRetry('retry-two')
  assert.equal(await f.store.commit(p.binding, duplicate.begin.claim, duplicate.payload), undefined)
  assert.equal(await f.store.claimEffect(p.binding, source('retry-two'), 0), undefined)
  assert.equal(await f.store.settleEffect(p.binding, p.source, 0, { state: 'sent', messageId: 'late-original' }), undefined)
  assert.equal((await f.store.readDelivery(p.binding, lookup('origin'))).operationId, operationId(p.binding, 'retry-one'))
})

test('target recall seals every origin attempt across rebind, scrubs old-owner queue and audits, and preserves all committed cards', options, async t => {
  const f = await fixture(t), p = await f.prepare('recall-origin')
  await f.store.claimEffect(p.binding, p.source, 0)
  await f.store.settleEffect(p.binding, p.source, 0, { state: 'failed' })
  const retrySource = source('recall-retry'), retry = await f.store.begin(p.binding, retrySource), payload = data(p.binding, 'recall-origin')
  payload.privateDeliveries = [privateRef('recall-origin')]
  assert.ok(await f.store.commit(p.binding, retry.claim, payload))
  await f.store.claimEffect(p.binding, retrySource, 0)
  const rebound = binding({ id: 'rebound', revision: 'two', agentId: 'other' }), other = await f.prepare('other-source', rebound, data(rebound, 'other-source', 1, 83))
  const count = await createAgentDiceState(f.storage).revokeSourceByTarget(rebound.target, 'recall-origin')
  assert.equal(count, 2)
  for (const id of ['recall-origin', 'recall-retry']) {
    const raw = await f.reader.get(f.operationKey(p.binding, id)), row = JSON.parse(raw)
    assert.equal(row.state, 'unknown'); assert.equal('event' in row, false); assert.equal('effects' in row, false); assert.equal('receipts' in row, false)
    await assert.rejects(f.store.begin(rebound, source(id)), /骰子业务持久状态不可用/u)
  }
  const old = await f.store.read(p.binding)
  assert.equal(group(old.state).privateDeliveries.length, 0); assert.ok(!JSON.stringify(group(old.state).audit).includes('AUDIT-BODY'))
  assert.equal(old.state.cards.alice.hp, 10); assert.equal((await f.store.read(rebound)).state.cards.alice.hp, 83)
  assert.equal((await f.store.readDelivery(p.binding, lookup('recall-origin'))).state, 'unknown')
  assert.ok(await f.store.claimEffect(other.binding, other.source, 0))
  assert.equal(await f.store.settleEffect(p.binding, retrySource, 0, { state: 'sent', messageId: 'late-retry' }), undefined)
})

test('recall reprojects only the scrub onto a concurrent card update and survives deleted operation data via durable owner indexes', options, async t => {
  const f = await fixture(t), p = await f.prepare('reproject')
  let injected = false
  const interleaved = createAgentDiceState({ get: key => f.storage.get(key), async eval(script, args) {
    if (!injected && script.includes('local key = root ..')) {
      injected = true
      const snapshot = await f.store.read(p.binding), state = structuredClone(snapshot.state); state.cards.alice.hp = 72
      const begin = await f.store.begin(p.binding, source('card-during-scrub'))
      assert.ok(await f.store.commit(p.binding, begin.claim, { state, effects: [], event: null }))
    }
    return f.storage.eval(script, args)
  } })
  assert.equal(await interleaved.revokeSourceByTarget(p.binding.target, 'reproject'), 1)
  const result = await f.store.read(p.binding)
  assert.equal(injected, true); assert.equal(result.state.cards.alice.hp, 72); assert.equal(group(result.state).privateDeliveries.length, 0)
  const deleted = await f.prepare('deleted-operation')
  await f.reader.del(f.operationKey(deleted.binding, 'deleted-operation'))
  assert.equal(await f.store.revokeSourceByTarget(deleted.binding.target, 'deleted-operation'), 0)
  assert.equal(group((await f.store.read(deleted.binding)).state).privateDeliveries.length, 0)
  await assert.rejects(f.store.begin(deleted.binding, deleted.source), /骰子业务持久状态不可用/u)
})

test('subject purge follows recipient and explicit delegation indexes across rebind, keeps cards and account/Agent isolation, and repeats after restart', options, async t => {
  const f = await fixture(t), original = binding(), p = await f.prepare('purge-bob', original, data(original, 'purge-bob', 2, 61))
  const rebound = binding({ id: 'rebound', agentId: 'other' }), other = await f.prepare('other-agent', rebound, data(rebound, 'other-agent', 1, 99))
  const scope = { account, agentId: original.agentId, subjectId: 'bob' }
  assert.equal(await createAgentDiceState(f.storage).purgeSubject(scope), 1)
  const cleaned = await f.store.read(original), untouched = await f.store.read(rebound)
  assert.equal(cleaned.state.cards.alice.hp, 61); assert.equal(group(cleaned.state).privateDeliveries.length, 0)
  assert.ok(!JSON.stringify(group(cleaned.state).audit).includes('AUDIT-BODY'))
  assert.equal(untouched.state.cards.alice.hp, 99); assert.equal(group(untouched.state).privateDeliveries.length, 1)
  assert.equal(await createAgentDiceState(f.storage).purgeSubject(scope), 1)
  assert.deepEqual(await f.store.read(rebound), untouched)
  assert.equal(await f.store.claimEffect(original, p.source, 0), undefined)
  assert.ok(await f.store.claimEffect(other.binding, other.source, 0))
  const delegated = await f.store.begin(original, source('delegated')), state = (await f.store.read(original)).state
  await f.store.commit(original, delegated.claim, { state, effects: [{ kind: 'public', text: 'DELEGATED-SECRET' }], event: null, subjectIds: ['delegator'] })
  assert.equal(await f.store.purgeSubject({ account, agentId: original.agentId, subjectId: 'delegator', target: original.target }), 1)
  assert.ok(!(await f.reader.get(f.operationKey(original, 'delegated'))).includes('DELEGATED-SECRET'))
})

test('purge epochs fence in-flight computations and foreign accounts or scene addresses cannot select another subject scope', options, async t => {
  const f = await fixture(t), selected = binding(), pending = await f.store.begin(selected, source('before-purge'))
  await f.store.purgeSubject({ account, agentId: selected.agentId, subjectId: 'bob' })
  assert.equal(await f.store.commit(selected, pending.claim, data(selected, 'before-purge')), undefined)
  assert.equal(await f.store.read(selected), null)
  const after = await f.prepare('after-purge'), before = await f.store.read(selected)
  assert.equal(await f.store.purgeSubject({ account: { ...account, id: 'different-bot' }, agentId: selected.agentId, subjectId: 'bob' }), 0)
  assert.deepEqual(await f.store.read(selected), before)
  await assert.rejects(f.store.purgeSubject({ account, agentId: selected.agentId, subjectId: 'bob', target: { ...selected.target, account: { ...account, id: 'different-bot' } } }), /骰子业务持久状态不可用/u)
  await assert.rejects(f.store.purgeSubject({ account, agentId: selected.agentId, subjectId: 'bob', target: { ...selected.target, kind: 'private' } }), /骰子业务持久状态不可用/u)
  assert.ok(await f.store.claimEffect(selected, after.source, 0))
})

test('a recalled origin, mismatched durable attempt and an unacknowledged private receipt never advance or send a later effect', options, async t => {
  const f = await fixture(t), selected = binding()
  const missing = await f.store.begin(selected, source('missing-origin')), missingData = data(selected, 'missing-origin')
  missingData.privateDeliveries[0].originMessageId = 'never-existed'
  assert.equal(await f.store.commit(selected, missing.claim, missingData), undefined)
  assert.equal(await f.store.read(selected), null)
  const p = await f.prepare('index-owner'), index = await f.store.readDelivery(selected, lookup('index-owner'))
  const indexKey = f.prefix + root + ':delivery:' + hash([index.ownerHash, index.packId, index.deliveryId])
  await f.reader.set(indexKey, JSON.stringify({ ...index, operationId: hash('different-attempt') }))
  assert.equal(await f.store.claimEffect(selected, p.source, 0), undefined)
  assert.equal(JSON.parse(await f.reader.get(f.operationKey(selected, 'index-owner'))).state, 'unknown')
  const ambiguous = await f.prepare('ambiguous-private')
  await f.store.claimEffect(selected, ambiguous.source, 0)
  const snapshot = await f.store.read(selected)
  const sealed = await f.store.settleEffectAndState(selected, ambiguous.source, 0, { state: 'confirmed' }, { snapshot, nextState: snapshot.state })
  assert.equal(sealed.state, 'unknown'); assert.equal((await f.store.readDelivery(selected, lookup('ambiguous-private'))).state, 'unknown')
  assert.equal(await f.store.claimEffect(selected, ambiguous.source, 1), undefined)
  const doomed = await f.store.begin(selected, source('recalled-draft')), before = await f.store.read(selected)
  await f.store.revokeSourceByTarget(selected.target, 'recalled-draft')
  assert.equal(await f.store.commit(selected, doomed.claim, data(selected, 'recalled-draft')), undefined)
  assert.deepEqual(await f.store.read(selected), before)
})

test('source existence queries use durable provenance across restart and never read private bodies or fence unknown messages', options, async t => {
  const f = await fixture(t), selected = binding(), before = await f.reader.keys(f.prefix + root + '*')
  let gets = 0
  const readOnly = createAgentDiceState({ get() { gets++; throw Error('source lookup must not read bodies') }, eval: (script, args) => {
    assert.ok(!script.includes("redis.call('GET'")); assert.ok(!script.includes("redis.call('SET'")); return f.storage.eval(script, args)
  } })
  assert.equal(await readOnly.hasSourceByTarget(selected.target, 'ordinary-chat-message'), false)
  assert.deepEqual(await f.reader.keys(f.prefix + root + '*'), before, 'unknown sources must not allocate durable tombstones')
  const p = await f.prepare('known-private')
  assert.equal(await readOnly.hasSourceByTarget(selected.target, p.source.messageId), true)
  assert.equal(await createAgentDiceState(f.storage).hasSourceByTarget(selected.target, p.source.messageId), true)
  await f.reader.set(f.operationKey(selected, 'imported-unknown'), '{"state":"unknown","effects":["PRIVATE-IMPORTED-BODY"]}')
  assert.equal(await readOnly.hasSourceByTarget(selected.target, 'imported-unknown'), true, 'an opaque imported row is still a durable source fence')
  await f.reader.del(f.operationKey(selected, 'known-private'))
  assert.equal(await readOnly.hasSourceByTarget(selected.target, 'known-private'), true, 'durable origin ownership survives operation pruning')
  const origin = operationId(selected, 'known-private')
  await f.reader.del(f.prefix + root + ':origin:' + origin + ':owners')
  assert.equal(await readOnly.hasSourceByTarget(selected.target, 'known-private'), true, 'attempt index independently proves a known source')
  assert.equal(gets, 0)
})

test('source existence is isolated by every conversation namespace and validates identifiers without writing a fence', options, async t => {
  const f = await fixture(t), selected = binding(), p = await f.prepare('same-opaque-message-id')
  const variations = [
    { ...selected.target, id: 'other-room' }, { ...selected.target, kind: 'private' },
    ...['platform', 'namespace', 'id'].map(key => ({ ...selected.target, account: { ...account, [key]: 'other' } })),
  ]
  for (const target of variations) assert.equal(await f.store.hasSourceByTarget(target, p.source.messageId), false)
  assert.equal(await createAgentDiceState(f.storage).hasSourceByTarget(selected.target, p.source.messageId), true)
  const before = await f.reader.keys(f.prefix + root + '*')
  for (const id of ['0', '', ' leading-space', 'trailing-space ', 'line\nbreak']) await assert.rejects(f.store.hasSourceByTarget(selected.target, id), /骰子业务持久状态不可用/u)
  let getters = 0
  await assert.rejects(f.store.hasSourceByTarget({ ...selected.target, get id() { getters++; return 'room' } }, p.source.messageId), /骰子业务持久状态不可用/u)
  assert.equal(getters, 0)
  assert.deepEqual((await f.reader.keys(f.prefix + root + '*')).sort(), before.sort())
})
