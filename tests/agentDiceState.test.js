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
const { agentBindingIdentity, agentBindingToken, agentConversationKey, conversationAddressKey } = await load('modules/runtime/domain/agentBindings.js')
const root = 'agent:dice:engine:v1'
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const account = { platform: 'fixture', namespace: 'dice-state', id: 'bot' }
const binding = (changes = {}) => ({ source: 'configured', id: 'binding', revision: 'one', agentId: 'daily', personaId: 'persona', connectionId: 'connection',
  target: { account, kind: 'group', id: 'room' }, ...changes })
const source = (messageId = 'source', changes = {}) => ({ messageId, authorId: 'person', sourceHash: hash(['frozen-message', messageId]), occurredAt: 1_800_000_000_000, ...changes })
const payload = (label = 'one', effects = [{ kind: 'message', visibility: 'private', text: 'SECRET-ROLL-' + label }, { kind: 'public', text: 'hidden roll completed' }]) =>
  ({ state: { cards: { person: { san: 59 } }, label }, effects, event: [{ kind: 'card_changed', source: { messageId: label }, change: 'SAN -1' }] })
const options = { timeout: 15_000 }
const ownerHash = selected => hash([agentBindingIdentity(selected), agentConversationKey(selected)])
const operationId = (selected, id) => hash([conversationAddressKey(selected.target), id])

async function fixture(t) {
  assert.equal(spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status, 0, 'state tests require an actual isolated Redis')
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-dice-state-')), socket = path.join(directory, 'redis.sock')
  const server = spawn('redis-server', ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  const exited = once(server, 'exit').catch(() => {})
  let reader, connection
  t.after(async () => {
    try { await connection?.close(); if (reader?.isOpen) await reader.close() }
    finally {
      if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM')
      await exited; await rm(directory, { recursive: true, force: true })
    }
  })
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await stat(socket).then(() => true, () => false)) break
    if (server.exitCode !== null) assert.fail('Redis exited before readiness')
    await delay(10)
  }
  const instance = 'agent-dice-state-test', url = `unix://${socket}`
  reader = await connectAgentRedis(url)
  connection = await openAgentRedis({ url, instance, onLost() {} })
  const storage = connection.storage, prefix = agentRedisPrefix(instance), store = createAgentDiceState(storage)
  return { reader, storage, prefix, store,
    operationKey: (selected, id) => prefix + root + ':operation:' + operationId(selected, id),
    stateKey: selected => prefix + root + ':state:' + ownerHash(selected),
    async prepare(id = 'source', data = payload(id), selected = binding()) {
      const selectedSource = source(id), started = await store.begin(selected, selectedSource)
      assert.equal(started.kind, 'started')
      const row = await store.commit(selected, started.claim, data)
      assert.ok(row)
      return { row, claim: started.claim, source: selectedSource, binding: selected }
    },
  }
}

test('a winning source claim freezes randomness before atomic business state, effects and audit commit', options, async t => {
  const f = await fixture(t), selected = binding(), original = source()
  assert.equal(await f.store.read(selected), null)
  const begun = await f.store.begin(selected, original)
  assert.equal(begun.kind, 'started'); assert.equal(begun.snapshot, null)
  assert.match(begun.claim.seed, /^[a-f0-9]{32}$/u); assert.match(begun.claim.token, /^[a-f0-9]{32}$/u)
  assert.equal(begun.claim.revision, 0)
  assert.equal(begun.claim.bindingHash, hash([agentBindingToken(selected), conversationAddressKey(selected.target)]))
  const before = JSON.parse(await f.reader.get(f.operationKey(selected, original.messageId)))
  assert.equal(before.state, 'preparing'); assert.equal(before.seed, begun.claim.seed)
  assert.equal(await f.store.read(selected), null)
  const data = payload(), expected = structuredClone(data), committed = await f.store.commit(selected, begun.claim, data)
  assert.equal(committed.state, 'ready'); assert.equal(committed.committedRevision, 1)
  assert.equal(Object.isFrozen(committed), true); assert.equal(Object.isFrozen(committed.effects[0]), true)
  assert.equal('seed' in committed, false); assert.equal('token' in committed, false)
  data.state.label = 'caller mutation'; data.effects[0].text = 'changed'; data.event[0].change = 'changed'
  const snapshot = await createAgentDiceState(f.storage).read(selected)
  assert.deepEqual(snapshot.state, expected.state); assert.deepEqual(snapshot.source, original)
  assert.deepEqual(committed.effects, expected.effects); assert.deepEqual(committed.event, expected.event)
  assert.equal(Object.isFrozen(snapshot.state.cards.person), true)
  const second = await f.store.begin(selected, source('next'))
  assert.equal(second.kind, 'started'); assert.equal(second.claim.revision, 1)
  assert.deepEqual(second.snapshot, snapshot)
  assert.equal(await f.store.commit(selected, begun.claim, payload('reroll')), undefined)
})

test('concurrent begins expose one computation claim and recovery of preparing never releases another seed', options, async t => {
  const f = await fixture(t), selected = binding(), original = source()
  const attempts = await Promise.all(Array.from({ length: 12 }, () => f.store.begin(selected, original)))
  assert.equal(attempts.filter(result => result.kind === 'started').length, 1)
  const winner = attempts.find(result => result.kind === 'started')
  assert.ok(attempts.filter(result => result.kind === 'existing').every(result => result.operation.seed === winner.claim.seed))
  const recovered = await createAgentDiceState(f.storage).recoverOperation(selected, original)
  assert.equal(recovered.state, 'unknown'); assert.equal('seed' in recovered, false)
  assert.equal('effects' in recovered, false)
  const replay = await f.store.begin(selected, original)
  assert.equal(replay.kind, 'existing'); assert.equal(replay.operation.state, 'unknown')
  assert.equal(await f.store.commit(selected, winner.claim, payload('must-not-commit')), undefined)
  assert.equal(await f.store.read(selected), null)
})

test('concurrent business transactions CAS one snapshot and atomically fence the stale computed source as unknown', options, async t => {
  const f = await fixture(t), selected = binding()
  const first = await f.store.begin(selected, source('one')), second = await f.store.begin(selected, source('two'))
  const committed = await Promise.all([f.store.commit(selected, first.claim, payload('one')), f.store.commit(selected, second.claim, payload('two'))])
  assert.equal(committed.filter(Boolean).length, 1)
  const winning = committed.find(Boolean), losingSource = source(winning.source.messageId === 'one' ? 'two' : 'one')
  const snapshot = await f.store.read(selected)
  assert.equal(snapshot.revision, 1); assert.equal(snapshot.state.label, winning.source.messageId)
  const replay = await f.store.begin(selected, losingSource)
  assert.equal(replay.kind, 'existing'); assert.equal(replay.operation.state, 'unknown')
  assert.equal('effects' in replay.operation, false); assert.equal('seed' in replay.operation, false)
  assert.equal(await f.store.claimEffect(selected, losingSource, 0), undefined)
})

test('effect claims are once only and a recovered pending private delivery stays unknown without public continuation', options, async t => {
  const f = await fixture(t), p = await f.prepare()
  const claims = await Promise.all(Array.from({ length: 8 }, () => f.store.claimEffect(p.binding, p.source, 0)))
  assert.equal(claims.filter(Boolean).length, 1)
  assert.equal(claims.find(Boolean).effect.text, 'SECRET-ROLL-source')
  assert.equal(await f.store.claimEffect(p.binding, p.source, 1), undefined)
  const restarted = createAgentDiceState(f.storage), recovered = await restarted.recoverOperation(p.binding, p.source)
  assert.equal(recovered.state, 'unknown'); assert.equal('effects' in recovered, false)
  assert.equal(await restarted.claimEffect(p.binding, p.source, 0), undefined)
  assert.equal(await restarted.claimEffect(p.binding, p.source, 1), undefined)
  assert.equal(await restarted.settleEffect(p.binding, p.source, 0, { state: 'sent', messageId: 'late-real-id' }), undefined)
  assert.equal((await restarted.begin(p.binding, p.source)).operation.state, 'unknown')
})

test('sequential confirmed effects scrub consumed text and preserve only actual receipts without invented IDs', options, async t => {
  const f = await fixture(t), p = await f.prepare()
  await f.store.claimEffect(p.binding, p.source, 0)
  const next = await f.store.settleEffect(p.binding, p.source, 0, { state: 'sent', messageId: 'platform-private-id' })
  assert.equal(next.state, 'ready'); assert.equal(next.completed, 1)
  assert.deepEqual(next.effects[0], null)
  assert.deepEqual(next.receipts, [{ state: 'sent', messageId: 'platform-private-id' }])
  assert.equal((await f.store.claimEffect(p.binding, p.source, 1)).effect.kind, 'public')
  const terminal = await f.store.settleEffect(p.binding, p.source, 1, { state: 'confirmed' })
  assert.equal(terminal.state, 'confirmed'); assert.equal(terminal.completed, 2)
  assert.equal('effects' in terminal, false)
  assert.deepEqual(terminal.receipts, [{ state: 'sent', messageId: 'platform-private-id' }, { state: 'confirmed' }])
  assert.equal(await f.store.claimEffect(p.binding, p.source, 1), undefined)
  assert.equal(await f.store.settleEffect(p.binding, p.source, 1, { state: 'sent', messageId: 'replacement' }), undefined)
  const noEffects = await f.prepare('no-effects', payload('no-effects', []))
  assert.equal(noEffects.row.state, 'confirmed'); assert.equal(noEffects.row.requested, 0)
  assert.equal('effects' in noEffects.row, false)
})

test('failed, unknown and malformed delivery receipts stop and scrub all later effects', options, async t => {
  const f = await fixture(t)
  for (const [index, receipt] of [{ state: 'failed' }, { state: 'unknown' }, { state: 'sent' }, { state: 'sent', messageId: '0' },
    { state: 'sent', messageId: ' valid ' }, { state: 'confirmed', messageId: 'fake' }].entries()) {
    const p = await f.prepare('bad-receipt-' + index)
    await f.store.claimEffect(p.binding, p.source, 0)
    const settled = await f.store.settleEffect(p.binding, p.source, 0, receipt)
    assert.equal(settled.state, receipt.state === 'failed' ? 'failed' : 'unknown')
    assert.equal(settled.completed, 0); assert.equal('effects' in settled, false)
    assert.equal(await f.store.claimEffect(p.binding, p.source, 1), undefined)
    assert.ok(!JSON.stringify(settled).includes('SECRET-ROLL'))
  }
})

test('business state partitions all account, agent, scene and binding identity dimensions while source fences prevent rebinding rerolls', options, async t => {
  const f = await fixture(t), original = binding(), p = await f.prepare('original')
  const variations = [
    binding({ agentId: 'other-agent' }), binding({ id: 'other-binding' }), binding({ personaId: 'other-persona' }), binding({ connectionId: 'other-connection' }),
    binding({ target: { ...original.target, id: 'other-scene' } }), binding({ target: { ...original.target, kind: 'private' } }),
    ...['id', 'platform', 'namespace'].map(field => binding({ target: { ...original.target, account: { ...account, [field]: 'other-' + field } } })),
  ]
  for (const [index, selected] of variations.entries()) {
    assert.equal(await f.store.read(selected), null)
    const sameScene = conversationAddressKey(selected.target) === conversationAddressKey(original.target)
    if (sameScene) await assert.rejects(f.store.begin(selected, p.source), /骰子业务持久状态不可用/u)
    else assert.equal((await f.store.begin(selected, p.source)).kind, 'started')
    const independent = await f.store.begin(selected, source('variation-' + index))
    assert.equal(independent.kind, 'started')
    await f.store.commit(selected, independent.claim, payload('partition-' + index, []))
    assert.equal((await f.store.read(selected)).state.label, 'partition-' + index)
  }
  const revised = binding({ revision: 'two' })
  assert.deepEqual(await f.store.read(revised), await f.store.read(original), 'revision retains business ownership')
  await assert.rejects(f.store.begin(revised, p.source), /骰子业务持久状态不可用/u)
  await assert.rejects(f.store.claimEffect(revised, p.source, 0), /骰子业务持久状态不可用/u)
  assert.equal((await f.store.read(original)).state.label, 'original')
  for (const changes of [{ authorId: 'other-author' }, { sourceHash: hash('edited') }, { occurredAt: p.source.occurredAt + 1 }]) {
    await assert.rejects(f.store.begin(original, { ...p.source, ...changes }), /骰子业务持久状态不可用/u)
  }
})

test('recall before or after commit atomically scrubs private output and rejects stale claims without rolling back committed card data', options, async t => {
  const f = await fixture(t), selected = binding()
  assert.equal(await f.store.revokeSource(selected, 'recall-before'), 0)
  await assert.rejects(f.store.begin(selected, source('recall-before')), /骰子业务持久状态不可用/u)
  const p = await f.prepare('recall-after')
  const claims = await Promise.all([f.store.claimEffect(selected, p.source, 0), f.store.revokeSource(selected, p.source.messageId)])
  assert.equal(claims[1], 1)
  const raw = await f.reader.get(f.operationKey(selected, p.source.messageId)), row = JSON.parse(raw)
  assert.equal(row.state, 'unknown')
  assert.ok(!raw.includes('SECRET-ROLL')); assert.equal('event' in row, false); assert.equal('receipts' in row, false)
  assert.equal('seed' in row, false)
  assert.equal((await f.store.read(selected)).state.label, 'recall-after')
  assert.equal(await f.store.commit(selected, p.claim, payload('resurrect')), undefined)
  assert.equal(await f.store.claimEffect(selected, p.source, 1), undefined)
  await assert.rejects(f.store.begin(selected, p.source), /骰子业务持久状态不可用/u)
})

test('strict own-data validation rejects hostile inputs, malformed source IDs and bounded payload violations without invoking input code', options, async t => {
  const f = await fixture(t), selected = binding()
  let getters = 0, traps = 0
  for (const input of [source('0'), source(' spaced'), source('good', { authorId: ' bad' }), source('good', { sourceHash: 'A'.repeat(64) }),
    source('good', { occurredAt: '1' }), source('good', { occurredAt: 0 }), source('good', { unknown: true }),
    { ...source(), get authorId() { getters++; return 'person' } }, new Proxy(source(), { get() { traps++; throw Error('proxy should not run') } })]) {
    await assert.rejects(f.store.begin(selected, input), /骰子业务持久状态不可用/u)
  }
  await assert.rejects(f.store.begin(binding({ source: 'legacy' }), source()), /骰子业务持久状态不可用/u)
  const begun = await f.store.begin(selected, source('strict'))
  const sparse = []; sparse.length = 1
  const cycle = {}; cycle.self = cycle
  const revoked = Proxy.revocable({}, {}); revoked.revoke()
  for (const state of [undefined, NaN, Infinity, new Date(), () => {}, cycle, sparse, Object.create({ inherited: 'unsafe' }),
    { get card() { getters++; return 'unsafe' } }, { [Symbol('unsafe')]: 'value' }, revoked.proxy,
    Object.defineProperty({}, 'hidden', { value: true }), { toJSON() { getters++; return 'unsafe' } },
    { huge: 'x'.repeat(1024 * 1024) }]) {
    await assert.rejects(f.store.commit(selected, begun.claim, { state, effects: [], event: null }), /骰子业务持久状态不可用/u)
  }
  await assert.rejects(f.store.commit(selected, begun.claim, payload('too-many', Array(129).fill(null))), /骰子业务持久状态不可用/u)
  assert.equal(getters, 0); assert.equal(traps, 0)
  assert.equal((await f.store.begin(selected, source('strict'))).operation.state, 'preparing')
  const maximum = await f.store.commit(selected, begun.claim, payload('bounded', Array(128).fill(null)))
  assert.equal(maximum.requested, 128)
})

test('lost storage acknowledgements preserve durable source fences and atomic state instead of authorizing recomputation', options, async t => {
  const f = await fixture(t), selected = binding(), original = source('lost-begin')
  const failing = createAgentDiceState({ get: key => f.storage.get(key), async eval(script, options) {
    await f.storage.eval(script, options); throw Error('private-storage-detail')
  } })
  await assert.rejects(failing.begin(selected, original), /骰子业务持久状态不可用/u)
  const existing = await f.store.begin(selected, original)
  assert.equal(existing.kind, 'existing'); assert.equal(existing.operation.state, 'preparing')
  assert.equal((await f.store.recoverOperation(selected, original)).state, 'unknown')
  const begun = await f.store.begin(selected, source('lost-commit'))
  await assert.rejects(failing.commit(selected, begun.claim, payload('lost-commit')), /骰子业务持久状态不可用/u)
  const recovered = await createAgentDiceState(f.storage).begin(selected, source('lost-commit'))
  assert.equal(recovered.kind, 'existing'); assert.equal(recovered.operation.state, 'ready')
  assert.equal((await f.store.read(selected)).state.label, 'lost-commit')
  assert.equal(recovered.operation.committedRevision, 1)
})

test('revoked or interrupted guards do not dispatch reads or mutations and never release a durable claim twice', options, async t => {
  const f = await fixture(t), selected = binding(), controller = new AbortController()
  const guard = { signal: controller.signal, isCurrent: () => !controller.signal.aborted, async ensureCurrent() {} }
  controller.abort()
  await assert.rejects(f.store.begin(selected, source('aborted'), guard), /骰子业务持久状态不可用/u)
  assert.equal(await f.reader.get(f.operationKey(selected, 'aborted')), null)
  const waiting = new AbortController()
  const pending = f.store.begin(selected, source('hanging'), { signal: waiting.signal, isCurrent: () => true, ensureCurrent: async () => new Promise(() => {}) })
  waiting.abort()
  await assert.rejects(pending, /骰子业务持久状态不可用/u)
  assert.equal(await f.reader.get(f.operationKey(selected, 'hanging')), null)
  const begun = await f.store.begin(selected, source('revoked-before-commit'))
  await assert.rejects(f.store.commit(selected, begun.claim, payload(), guard), /骰子业务持久状态不可用/u)
  assert.equal((await f.store.begin(selected, source('revoked-before-commit'))).operation.state, 'preparing')
  assert.equal(await f.store.read(selected), null)
})

test('legacy or malformed storage never becomes neutral game state or a new source computation', options, async t => {
  const f = await fixture(t), selected = binding()
  await f.reader.set(f.prefix + 'dice:state', JSON.stringify({ users: { person: { cards: { legacy: { san: 99 } } } }, groups: { room: {} } }))
  assert.equal(await f.store.read(selected), null)
  for (const raw of ['', '{"users":{"person":{}}}']) {
    await f.reader.set(f.stateKey(selected), raw)
    await assert.rejects(f.store.read(selected), /骰子业务持久状态不可用/u)
    await assert.rejects(f.store.begin(selected, source()), /骰子业务持久状态不可用/u)
    assert.equal(await f.reader.get(f.operationKey(selected, 'source')), null)
  }
  await f.reader.del(f.stateKey(selected))
  await f.reader.set(f.operationKey(selected, 'corrupt'), '{"state":"ready"}')
  await assert.rejects(f.store.begin(selected, source('corrupt')), /骰子业务持久状态不可用/u)
  assert.equal(await f.reader.get(f.operationKey(selected, 'corrupt')), '{"state":"ready"}')
})
