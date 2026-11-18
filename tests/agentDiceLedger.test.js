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

const { createAgentDiceLedger } = await load('modules/dice/infrastructure/agentDiceLedger.js')
const { connectAgentRedis, openAgentRedis, agentRedisPrefix } = await load('modules/runtime/infrastructure/agentRedis.js')
const { conversationAddressKey, platformAccountKey } = await load('modules/runtime/domain/agentBindings.js')
const root = 'agent:dice:v1'
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const account = { platform: 'fixture', namespace: 'dice-ledger', id: 'bot' }
const target = { account, kind: 'group', id: 'room' }
const source = (messageId = 'source', overrides = {}) => ({ target, agentId: 'agent', authorId: 'person', messageId, ...overrides })
const binding = (selected = source(), overrides = {}) => ({ source: 'configured', id: 'binding', revision: 'one', agentId: selected.agentId, personaId: 'persona', connectionId: 'connection', target: selected.target, ...overrides })
const items = (label = 'frozen') => [
  { eventId: hash([label, 'one']), text: `${label}: 2D6[1+6]=7`, result: true },
  { eventId: hash([label, 'two']), text: `${label}: invalid-expression-notice`, result: false },
]
const options = { timeout: 15_000 }
function indexes(selected) {
  return { operation: hash([conversationAddressKey(selected.target), selected.messageId]),
    global: hash([platformAccountKey(selected.target.account), selected.agentId, selected.authorId]),
    scene: hash([conversationAddressKey(selected.target), selected.agentId, selected.authorId]) }
}
function terminal(record, state, completed = record.completed) {
  const { items: _items, ...rest } = record
  return { ...rest, state, completed }
}
async function fixture(t) {
  assert.equal(spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status, 0, 'dice ledger tests require actual isolated Redis')
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-dice-ledger-')), socket = path.join(directory, 'redis.sock')
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
  const url = `unix://${socket}`, instance = 'agent-dice-ledger-test'
  reader = await connectAgentRedis(url)
  connection = await openAgentRedis({ url, instance, onLost() {} })
  const storage = connection.storage, prefix = agentRedisPrefix(instance), store = createAgentDiceLedger(storage)
  return { reader, storage, store, prefix,
    key(selected) { return prefix + root + ':operation:' + indexes(selected).operation },
    async prepare(selected = source(), label = 'frozen') {
      const epochs = await store.capture(selected), payload = items(label)
      const row = await store.prepare(selected, binding(selected), hash([label, 'input']), payload, epochs)
      assert.ok(row)
      return { row, epochs, payload }
    },
    async active(selected) {
      const ids = indexes(selected)
      return { global: await reader.sMembers(prefix + root + ':active:global:' + ids.global),
        scene: await reader.sMembers(prefix + root + ':active:scene:' + ids.scene) }
    },
  }
}

test('capture, prepare, reconstruction and CAS preserve frozen output without ambient state', options, async t => {
  const f = await fixture(t), selected = source(), epochs = await f.store.capture(selected)
  assert.deepEqual(epochs, { global: '0', scene: '0', recalled: false })
  assert.equal(await f.store.read(selected), undefined)
  const payload = items(), expected = structuredClone(payload), sourceHash = hash('original source')
  const prepared = await f.store.prepare(selected, binding(selected), sourceHash, payload, epochs)
  assert.equal(prepared.record.bindingHash, f.store.bindingHash(binding(selected)))
  assert.equal(prepared.record.sourceHash, sourceHash)
  assert.deepEqual(prepared.record.items, expected)
  assert.equal(prepared.record.state, 'ready'); assert.equal(prepared.record.completed, 0); assert.equal(prepared.record.requested, 2)
  payload[0].text = 'mutated caller data'
  const restarted = createAgentDiceLedger(f.storage), restored = await restarted.read(selected)
  assert.deepEqual(restored.record.items, expected)
  assert.equal(restored.raw, prepared.raw)
  const pending = await restarted.change(selected, restored, { ...restored.record, state: 'pending', completed: 1,
    items: restored.record.items.map((item, index) => index === 0 ? { ...item, text: '' } : item) }, epochs)
  assert.ok(pending)
  assert.equal((await restarted.read(selected)).record.completed, 1)
  assert.equal((await restarted.read(selected)).record.items[0].text, '')
  assert.equal(await restarted.change(selected, restored, restored.record, epochs), undefined, 'stale raw cannot restore consumed text')
})

test('concurrent prepare and CAS select exactly one frozen result and one delivery transition', options, async t => {
  const f = await fixture(t), selected = source(), epochs = await f.store.capture(selected)
  const first = items('candidate-a'), second = items('candidate-b')
  const attempts = await Promise.all([first, second].map(payload => f.store.prepare(selected, binding(selected), hash(payload), payload, epochs)))
  assert.equal(attempts.filter(Boolean).length, 1)
  const ready = attempts.find(Boolean)
  assert.equal((await f.store.read(selected)).raw, ready.raw)
  assert.ok([first, second].some(payload => JSON.stringify(payload) === JSON.stringify(ready.record.items)))
  const cas = await Promise.all([
    f.store.change(selected, ready, { ...ready.record, state: 'pending' }, epochs),
    f.store.change(selected, ready, terminal(ready.record, 'failed'), epochs),
  ])
  assert.equal(cas.filter(Boolean).length, 1)
  assert.equal((await f.store.read(selected)).raw, cas.find(Boolean).raw)
})

test('all terminal states remove items and both active reverse indexes while retaining dedupe', options, async t => {
  const f = await fixture(t)
  for (const state of ['confirmed', 'failed', 'unknown']) {
    const selected = source(state), { row, epochs } = await f.prepare(selected, state)
    assert.deepEqual(await f.active(selected), { global: [indexes(selected).operation], scene: [indexes(selected).operation] })
    await assert.rejects(f.store.change(selected, row, { ...row.record, state }, epochs), /骰子持久状态不可用/u)
    assert.equal((await f.store.read(selected)).raw, row.raw)
    const finished = await f.store.change(selected, row, terminal(row.record, state, state === 'confirmed' ? 2 : 0), epochs)
    assert.ok(finished); assert.equal(Object.hasOwn(finished.record, 'items'), false)
    assert.equal(Object.hasOwn((await f.store.read(selected)).record, 'items'), false)
    assert.deepEqual(await f.active(selected), { global: [], scene: [] })
    assert.equal(await f.store.prepare(selected, binding(selected), hash('repeat'), items('repeat'), epochs), undefined)
    assert.equal(await f.store.change(selected, row, row.record, epochs), undefined)
  }
})

test('same captured source cannot be overwritten after binding, persona, agent or author changes', options, async t => {
  const f = await fixture(t), selected = source(), { row, epochs } = await f.prepare(selected)
  for (const nextBinding of [binding(selected, { revision: 'two' }), binding(selected, { id: 'other' }), binding(selected, { connectionId: 'other' }),
    binding(selected, { personaId: 'other' }), binding(selected, { agentId: 'other' })]) {
    const result = await Promise.allSettled([f.store.prepare(selected, nextBinding, hash('edited source'), items('reroll'), epochs)])
    if (result[0].status === 'fulfilled') assert.equal(result[0].value, undefined)
    else assert.match(result[0].reason.message, /骰子持久状态不可用/u)
  }
  for (const changed of [{ ...selected, agentId: 'other' }, { ...selected, authorId: 'other' }]) {
    assert.equal(await f.store.prepare(changed, binding(changed), hash('edited source'), items('reroll'), await f.store.capture(changed)), undefined)
  }
  assert.equal((await f.store.read(selected)).raw, row.raw)
})

test('recall atomically scrubs ready and pending text, indexes, and stale CAS resurrection', options, async t => {
  const f = await fixture(t)
  for (const state of ['ready', 'pending']) {
    const selected = source(state), prepared = await f.prepare(selected, `secret-${state}`)
    const before = state === 'ready' ? prepared.row : await f.store.change(selected, prepared.row, { ...prepared.row.record, state }, prepared.epochs)
    const results = await Promise.all([
      f.store.revokeSource(selected.target, selected.messageId),
      f.store.change(selected, before, { ...before.record, state: 'pending' }, prepared.epochs),
    ])
    assert.equal(Number(results[0]), 1)
    const after = await f.store.read(selected)
    assert.equal(after.record.state, 'unknown'); assert.equal(Object.hasOwn(after.record, 'items'), false)
    assert.doesNotMatch(after.raw, /secret-|invalid-expression-notice/u)
    assert.deepEqual(await f.active(selected), { global: [], scene: [] })
    assert.equal((await f.store.capture(selected)).recalled, true)
    assert.equal(await f.store.change(selected, before, before.record, prepared.epochs), undefined)
    assert.equal(await f.store.prepare(selected, binding(selected), hash('resurrect'), items('resurrect'), await f.store.capture(selected)), undefined)
  }
  const recalledBeforePrepare = source('recall-first')
  assert.equal(Number(await f.store.revokeSource(recalledBeforePrepare.target, recalledBeforePrepare.messageId)), 0)
  assert.equal((await f.store.capture(recalledBeforePrepare)).recalled, true)
  assert.equal(await f.store.prepare(recalledBeforePrepare, binding(recalledBeforePrepare), hash('late'), items('late'), await f.store.capture(recalledBeforePrepare)), undefined)
})

test('scene and global purges isolate accounts, agents, people and conversation kind/id', options, async t => {
  const f = await fixture(t)
  const variations = [
    source('scene-one'), source('scene-two'),
    source('other-room', { target: { ...target, id: 'other-room' } }),
    source('other-kind', { target: { ...target, kind: 'private' } }),
    source('other-agent', { agentId: 'other-agent' }), source('other-person', { authorId: 'other-person' }),
    source('other-account', { target: { ...target, account: { ...account, id: 'other-bot' } } }),
    source('other-namespace', { target: { ...target, account: { ...account, namespace: 'other-namespace' } } }),
    source('other-platform', { target: { ...target, account: { ...account, platform: 'other-platform' } } }),
  ]
  const prepared = await Promise.all(variations.map((selected, index) => f.prepare(selected, `secret-${index}`)))
  assert.equal(Number(await f.store.purgeSubject({ account, agentId: 'agent', subjectId: 'person', target })), 2)
  for (let index = 0; index < variations.length; index++) {
    const selected = variations[index], row = await f.store.read(selected)
    assert.equal(row.record.state, index < 2 ? 'unknown' : 'ready', selected.messageId)
    assert.equal(Object.hasOwn(row.record, 'items'), index >= 2, selected.messageId)
    if (index < 2) assert.equal(await f.store.change(selected, prepared[index].row, prepared[index].row.record, prepared[index].epochs), undefined)
    else assert.equal(row.raw, prepared[index].row.raw)
  }
  const affected = await f.store.capture(variations[0]), room = await f.store.capture(variations[2])
  assert.deepEqual(affected, { global: '0', scene: '1', recalled: false })
  assert.deepEqual(room, { global: '0', scene: '0', recalled: false })
  assert.equal(Number(await f.store.purgeSubject({ account, agentId: 'agent', subjectId: 'person' })), 2)
  for (let index = 0; index < variations.length; index++) {
    const row = await f.store.read(variations[index])
    assert.equal(row.record.state, index < 4 ? 'unknown' : 'ready', variations[index].messageId)
  }
  for (const selected of variations.slice(0, 4)) assert.deepEqual(await f.active(selected), { global: [], scene: [] })
  for (const selected of variations.slice(4)) assert.ok((await f.active(selected)).global.length > 0)
})

test('purge epochs fence uncaptured work and old raw while allowing a genuinely new source', options, async t => {
  const f = await fixture(t), selected = source(), { row, epochs } = await f.prepare(selected)
  const notPrepared = source('not-prepared'), stale = await f.store.capture(notPrepared)
  assert.equal(Number(await f.store.purgeSubject({ account, agentId: 'agent', subjectId: 'person' })), 1)
  assert.equal(await f.store.change(selected, row, row.record, epochs), undefined)
  assert.equal(await f.store.prepare(notPrepared, binding(notPrepared), hash('late'), items('late'), stale), undefined)
  assert.equal(await f.store.read(notPrepared), undefined)
  const current = await f.store.capture(notPrepared)
  assert.deepEqual(current, { global: '1', scene: '0', recalled: false })
  assert.ok(await f.store.prepare(notPrepared, binding(notPrepared), hash('new'), items('new'), current))
  assert.equal(await f.store.change(selected, row, row.record, current), undefined, 'fresh epochs cannot revive old raw')
  assert.equal(await f.store.prepare(selected, binding(selected), hash('old'), items('old'), current), undefined)
  assert.equal((await f.store.read(selected)).record.state, 'unknown')
})

test('corrupt ready, pending and terminal records fail closed without an overwrite', options, async t => {
  const f = await fixture(t), selected = source(), { row, epochs } = await f.prepare(selected)
  const corruptions = [
    'invalid-json', 'null', '[]', '1', '{}',
    ...[{ ...row.record, version: 2 }, { ...row.record, bindingHash: 'invalid' }, { ...row.record, sourceHash: 'invalid' },
      { ...row.record, globalIndex: 'invalid' }, { ...row.record, sceneIndex: 'invalid' }, { ...row.record, state: 'sent' },
      { ...row.record, requested: 0 }, { ...row.record, requested: 6 }, { ...row.record, completed: -1 }, { ...row.record, completed: 3 },
      { ...row.record, completed: 0.5 }, { ...row.record, items: null }, { ...row.record, items: [] },
      { ...row.record, items: [{ ...row.record.items[0], eventId: 'invalid' }, row.record.items[1]] },
      { ...row.record, items: [{ ...row.record.items[0], result: 'true' }, row.record.items[1]] },
      { ...row.record, items: [{ ...row.record.items[0], text: ' ' }, row.record.items[1]] },
      { ...row.record, state: 'pending', items: [{ ...row.record.items[0], text: 'x'.repeat(8001) }, row.record.items[1]] },
      ...['confirmed', 'failed', 'unknown'].map(state => ({ ...row.record, state })),
    ].map(value => JSON.stringify(value)),
  ]
  for (const raw of corruptions) {
    await f.reader.set(f.key(selected), raw)
    await assert.rejects(f.store.read(selected))
    assert.equal(await f.store.prepare(selected, binding(selected), hash('overwrite'), items('overwrite'), epochs), undefined)
    assert.equal(await f.store.change(selected, row, row.record, epochs), undefined)
    assert.equal(await f.reader.get(f.key(selected)), raw)
  }
  await f.reader.del(f.key(selected)); await f.reader.rPush(f.key(selected), 'wrong redis type')
  await assert.rejects(f.store.read(selected))
})

test('invalid prepare payloads never reach persistent storage', options, async t => {
  const f = await fixture(t), selected = source(), epochs = await f.store.capture(selected)
  for (const payload of [[], Array.from({ length: 6 }, (_, index) => items(String(index))[0]), [{ eventId: hash('event'), text: '', result: true }],
    [{ eventId: 'bad', text: 'text', result: true }], [{ eventId: hash('event'), text: 'text', result: 1 }]]) {
    await assert.rejects(f.store.prepare(selected, binding(selected), hash('source'), payload, epochs), /骰子持久状态不可用/u)
    assert.equal(await f.store.read(selected), undefined)
  }
  await assert.rejects(f.store.prepare(selected, binding(selected), 'invalid-source-digest', items(), epochs), /骰子持久状态不可用/u)
  assert.deepEqual(await f.active(selected), { global: [], scene: [] })
})

test('same message IDs stay separate across full account and conversation addresses', options, async t => {
  const f = await fixture(t), targets = [target, { ...target, kind: 'private' }, { ...target, id: 'other-room' },
    { ...target, account: { ...account, id: 'other-bot' } }, { ...target, account: { ...account, namespace: 'other-namespace' } },
    { ...target, account: { ...account, platform: 'other-platform' } }]
  const selected = targets.map(target => source('same-source-id', { target }))
  const prepared = await Promise.all(selected.map((value, index) => f.prepare(value, `isolated-${index}`)))
  assert.equal(new Set(selected.map(value => f.key(value))).size, selected.length)
  assert.equal(Number(await f.store.revokeSource(target, 'same-source-id')), 1)
  assert.equal((await f.store.read(selected[0])).record.state, 'unknown')
  for (let index = 1; index < selected.length; index++) {
    assert.equal((await f.store.read(selected[index])).raw, prepared[index].row.raw)
    assert.equal((await f.store.capture(selected[index])).recalled, false)
  }
})

test('scene and global purge win concurrent CAS without leaving text or reverse indexes', options, async t => {
  const f = await fixture(t)
  for (const sceneOnly of [true, false]) {
    const selected = source(sceneOnly ? 'scene-race' : 'global-race'), { row, epochs } = await f.prepare(selected, 'race-secret')
    const results = await Promise.all([
      f.store.change(selected, row, { ...row.record, state: 'pending' }, epochs),
      f.store.purgeSubject({ account, agentId: 'agent', subjectId: 'person', ...(sceneOnly ? { target } : {}) }),
    ])
    assert.equal(Number(results[1]), 1)
    const after = await f.store.read(selected)
    assert.equal(after.record.state, 'unknown'); assert.equal(Object.hasOwn(after.record, 'items'), false)
    assert.doesNotMatch(after.raw, /race-secret/u)
    assert.deepEqual(await f.active(selected), { global: [], scene: [] })
    assert.equal(await f.store.change(selected, row, row.record, epochs), undefined)
    assert.equal(await f.store.change(selected, row, row.record, await f.store.capture(selected)), undefined)
  }
})

test('scrubbing corrupt operation JSON removes content and fences old raw despite opaque orphan indexes', options, async t => {
  const f = await fixture(t)
  for (const mode of ['recall', 'scene', 'global']) {
    const selected = source(`corrupt-${mode}`), { row, epochs } = await f.prepare(selected, `private-${mode}`)
    await f.reader.set(f.key(selected), 'corrupt-operation-json private-content')
    if (mode === 'recall') await f.store.revokeSource(selected.target, selected.messageId)
    else await f.store.purgeSubject({ account, agentId: 'agent', subjectId: 'person', ...(mode === 'scene' ? { target } : {}) })
    assert.doesNotMatch(await f.reader.get(f.key(selected)), /private-|corrupt-operation-json/u)
    await assert.rejects(f.store.read(selected))
    assert.equal(await f.store.change(selected, row, row.record, epochs), undefined)
    assert.equal(await f.store.change(selected, row, row.record, await f.store.capture(selected)), undefined)
    const remaining = await f.active(selected)
    assert.ok([...remaining.global, ...remaining.scene].every(id => /^[a-f0-9]{64}$/u.test(id)))
  }
})

for (const mode of ['recall', 'scene', 'global']) test(`${mode} scrubs sensitive content from corrupt JSON, metadata and Redis types`, options, async t => {
  const f = await fixture(t)
  for (const corruption of ['array', 'metadata', 'redis-type']) {
    const selected = source(`${mode}-${corruption}`), { row, epochs } = await f.prepare(selected, 'sensitive-output')
    const corrupt = corruption === 'array' ? JSON.stringify(['sensitive-output', row.record.items])
      : JSON.stringify({ ...row.record, sourceHash: 'sensitive-original-text', unexpectedOutput: 'sensitive-result-copy' })
    if (corruption === 'redis-type') {
      await f.reader.del(f.key(selected)); await f.reader.rPush(f.key(selected), 'sensitive-output-in-wrong-redis-type')
    } else await f.reader.set(f.key(selected), corrupt)
    if (mode === 'recall') await f.store.revokeSource(selected.target, selected.messageId)
    else await f.store.purgeSubject({ account, agentId: 'agent', subjectId: 'person', ...(mode === 'scene' ? { target } : {}) })
    assert.doesNotMatch(await f.reader.get(f.key(selected)), /sensitive-|invalid-expression-notice/u)
    await assert.rejects(f.store.read(selected))
    assert.equal(await f.store.change(selected, row, row.record, epochs), undefined)
    assert.equal(await f.store.change(selected, row, row.record, await f.store.capture(selected)), undefined)
  }
})

test('CAS cannot change frozen ownership, source identity or requested count', options, async t => {
  const f = await fixture(t), selected = source(), { row, epochs } = await f.prepare(selected)
  for (const field of ['bindingHash', 'sourceHash', 'globalIndex', 'sceneIndex']) {
    await assert.rejects(f.store.change(selected, row, { ...row.record, [field]: hash(['other', field]) }, epochs), /骰子持久状态不可用/u)
    assert.equal((await f.store.read(selected)).raw, row.raw)
  }
  await assert.rejects(f.store.change(selected, row, { ...row.record, requested: 1, items: row.record.items.slice(0, 1) }, epochs), /骰子持久状态不可用/u)
  for (const other of [{ ...selected, agentId: 'other-agent' }, { ...selected, authorId: 'other-person' },
    { ...selected, target: { ...target, id: 'other-room' } }, { ...selected, target: { ...target, account: { ...account, id: 'other-bot' } } }]) {
    await assert.rejects(f.store.change(other, row, { ...row.record, state: 'pending' }, await f.store.capture(other)), /骰子持久状态不可用/u)
  }
  await assert.rejects(f.store.change(selected, { raw: 'corrupt-before-json' }, { ...row.record, state: 'pending' }, epochs))
  assert.equal((await f.store.read(selected)).raw, row.raw)
})
