import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createClient } from '@redis/client'
import { createTextPersonMemoryStore, textPersonMemoryBatchId } from '../dist/backend/modules/memory/infrastructure/textPersonMemoryStore.js'
import { agentBindingToken, conversationAddressKey } from '../dist/backend/modules/runtime/domain/agentBindings.js'

const available = spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status === 0
const FAILURE = '文字人物记忆队列不可用或状态无效，已停止读写。'
const base = 'agent:person-memory:text:v1'
const catalogKey = `${base}:catalog`
const batchKey = id => `${base}:batch:${id}`
const epoch = 1_800_000_000_000
function binding({ platform = 'qq', namespace = 'global', accountId = '90001', kind = 'group', conversationId = '20001', agentId = 'daily', revision = 'first' } = {}) {
  const target = { account: { platform, namespace, id: accountId }, kind, id: conversationId }
  return { source: 'configured', id: conversationAddressKey(target), revision, agentId, personaId: 'shared-template', connectionId: 'fixture', target }
}
function message(index = 1, text = `本人原话${index}`) { return { messageId: `m${index}`, at: epoch + index, name: '作者', text } }
function batch({ selected = binding(), token = agentBindingToken(selected), subjectId = '10001', peerId, messages = [message()] } = {}) {
  const id = textPersonMemoryBatchId(selected, token, subjectId, peerId)
  return { version: 1, id, binding: selected, token, subjectId, ...(peerId === undefined ? {} : { peerId }), messages, dueAt: epoch, attempts: 0, retryAt: 0 }
}
async function rejects(operation) {
  await assert.rejects(operation, error => error.message === FAILURE && error.cause === undefined)
}
async function fixture(t, prefix = '') {
  const directory = await mkdtemp(path.join(tmpdir(), 'text-person-memory-'))
  const socket = path.join(directory, 'redis.sock')
  const process = spawn('redis-server', ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  const exited = once(process, 'exit')
  let client
  t.after(async () => {
    if (client?.isOpen) await client.close()
    if (process.exitCode === null && process.signalCode === null) process.kill('SIGTERM')
    await exited
    await rm(directory, { recursive: true, force: true })
  })
  const deadline = Date.now() + 5000
  while (!await stat(socket).catch(() => false)) {
    if (Date.now() > deadline) assert.fail('isolated Redis did not start')
    await delay(10)
  }
  client = createClient({ socket: { path: socket, reconnectStrategy: false } })
  client.on('error', () => {})
  await client.connect()
  const redis = {
    get: key => client.get(prefix + key),
    eval: (script, options) => client.eval(script, { keys: options.keys.map(key => prefix + key), arguments: options.arguments }),
  }
  return { client, redis, store: createTextPersonMemoryStore(redis) }
}

test('text learning tasks and completed ledgers survive store recreation with results intact and keys prefixable', { skip: !available }, async t => {
  const f = await fixture(t, 'isolated-host:')
  assert.deepEqual(await f.store.list(), [])
  const input = batch()
  input.result = { raw: ' [ { "userId": "10001", "entries": [] } ] ', messageIds: ['m1'] }
  assert.equal(await f.store.update(input.id, current => { assert.equal(current, undefined); return input }), true)
  assert.deepEqual(await createTextPersonMemoryStore(f.redis).list(), [input])
  const completed = { ...input, messages: [], completedMessageIds: ['m1'], dueAt: epoch + 1000 }
  delete completed.result
  assert.equal(await f.store.update(input.id, () => completed), true)
  assert.deepEqual(await createTextPersonMemoryStore(f.redis).list(), [completed])
  assert.equal(await f.client.exists(catalogKey), 0)
  assert.equal(await f.client.exists(batchKey(input.id)), 0)
  assert.equal(await f.client.exists('isolated-host:' + catalogKey), 1)
  assert.equal(await f.store.update(input.id, current => { current.messages.push(message(2)); return current }), true)
  const recovered = (await f.store.list())[0]
  assert.deepEqual(recovered.completedMessageIds, ['m1'])
  assert.deepEqual(recovered.messages, [message(2)])
  assert.equal(await f.store.update(input.id, () => undefined), true)
  assert.deepEqual(await f.store.list(), [])
  assert.equal(await f.store.update(input.id, () => undefined), true)
})

test('text learning IDs partition complete accounts, scenes, roles, routing tokens, subjects and private peers', { skip: !available }, async t => {
  const f = await fixture(t)
  const entries = [batch(), batch({ selected: binding({ platform: 'matrix' }) }), batch({ selected: binding({ namespace: 'tenant-two' }) }),
    batch({ selected: binding({ accountId: '90002' }) }), batch({ selected: binding({ conversationId: '20002' }) }),
    batch({ selected: binding({ agentId: 'other' }) }), batch({ token: 'other-route-token' }), batch({ subjectId: '10002' }),
    batch({ selected: binding({ kind: 'private', conversationId: 'room-one' }), peerId: '10001' }),
    batch({ selected: binding({ kind: 'private', conversationId: 'room-one' }), peerId: '10002', subjectId: '10002' })]
  assert.equal(new Set(entries.map(entry => entry.id)).size, entries.length)
  for (const entry of entries) assert.equal(await f.store.update(entry.id, () => entry), true)
  assert.deepEqual((await createTextPersonMemoryStore(f.redis).list()).map(entry => entry.id).sort(), entries.map(entry => entry.id).sort())
})

test('text learning enforces message, ledger, output and catalog bounds without truncating source evidence', { skip: !available }, async t => {
  const f = await fixture(t)
  const input = batch({ messages: Array.from({ length: 60 }, (_, index) => message(index + 1, '文'.repeat(4000))) })
  input.messages[0].name = '名'.repeat(20)
  input.result = { raw: `["${'文'.repeat(63_996)}"]`, messageIds: ['m1'] }
  input.completedMessageIds = Array.from({ length: 60 }, (_, index) => `done${index}`)
  assert.equal(await f.store.update(input.id, () => input), true)
  for (const change of [
    value => { value.messages.push(message(61)); return value },
    value => { value.messages[0].text += '文'; return value },
    value => { value.messages[0].name += '名'; return value },
    value => { value.completedMessageIds.push('overflow'); return value },
    value => { value.result.raw = `["${'文'.repeat(63_997)}"]`; return value },
    value => { value.result.raw = '{}'; return value },
    value => { value.result.messageIds = ['missing-source']; return value },
    value => { value.result.messageIds = ['m1', 'm1']; return value },
    value => { value.messages[1].messageId = 'm1'; return value },
    value => { value.completedMessageIds = ['done', 'done']; return value },
  ]) await rejects(f.store.update(input.id, change))
  assert.deepEqual((await f.store.list())[0], input)
  const empty = batch({ messages: [] })
  assert.equal(await f.store.update(input.id, () => empty), true)
  for (let index = 1; index < 200; index++) {
    const entry = batch({ subjectId: `subject-${index}`, messages: [] })
    assert.equal(await f.store.update(entry.id, () => entry), true)
  }
  const excess = batch({ subjectId: 'excess', messages: [] })
  await rejects(f.store.update(excess.id, () => excess))
  assert.equal(await f.client.exists(batchKey(excess.id)), 0)
  assert.equal((await f.store.list()).length, 200)
})

test('text learning CAS retries preserve concurrent inbound messages and a captured extraction result', { skip: !available }, async t => {
  const f = await fixture(t)
  const original = batch()
  await f.store.update(original.id, () => original)
  let waiting = 0, release
  const ready = new Promise(resolve => { release = resolve })
  const parallel = 8
  const gated = {
    get: f.redis.get,
    async eval(script, options) {
      const result = await f.redis.eval(script, options)
      if (script.includes("return {redis.call('GET'") && waiting < parallel) {
        if (++waiting === parallel) release()
        await ready
      }
      return result
    },
  }
  const stores = Array.from({ length: parallel }, () => createTextPersonMemoryStore(gated))
  const outcomes = await Promise.all(stores.map((store, index) => store.update(original.id, current => {
    if (index === 0) current.result = { raw: '[]', messageIds: ['m1'] }
    else current.messages.push(message(index + 1))
    return current
  })))
  assert.ok(outcomes.every(Boolean))
  const recovered = (await createTextPersonMemoryStore(f.redis).list())[0]
  assert.deepEqual(recovered.messages.map(message => message.messageId).sort(), Array.from({ length: parallel }, (_, index) => `m${index + 1}`).sort())
  assert.deepEqual(recovered.result, { raw: '[]', messageIds: ['m1'] })
})

test('text learning CAS also preserves simultaneous additions of different catalog entries', { skip: !available }, async t => {
  const f = await fixture(t)
  const entries = Array.from({ length: 10 }, (_, index) => batch({ subjectId: `person-${index}` }))
  assert.ok((await Promise.all(entries.map(entry => createTextPersonMemoryStore(f.redis).update(entry.id, () => entry)))).every(Boolean))
  assert.deepEqual((await f.store.list()).map(entry => entry.id).sort(), entries.map(entry => entry.id).sort())
})

test('text learning rechecks a synchronous guard after waiting for a storage read and before commit', { skip: !available }, async t => {
  const f = await fixture(t)
  const input = batch()
  let current = true, called = false, commits = 0
  const stale = createTextPersonMemoryStore({ get: f.redis.get, async eval(script, options) {
    const result = await f.redis.eval(script, options)
    if (script.includes("return {redis.call('GET'")) current = false
    else if (script.includes("redis.call('SET'")) commits++
    return result
  } })
  assert.equal(await stale.update(input.id, () => { called = true; return input }, () => current), false)
  assert.equal(called, false)
  assert.equal(commits, 0)
  assert.deepEqual(await f.store.list(), [])
  current = true
  assert.equal(await f.store.update(input.id, () => { current = false; return input }, () => current), false)
  assert.deepEqual(await f.store.list(), [])
  assert.equal(await f.store.update(input.id, () => input, () => false), false)
})

test('text learning rejects scope, source and private peer mutation under an existing task ID', { skip: !available }, async t => {
  const f = await fixture(t)
  const input = batch()
  await f.store.update(input.id, () => input)
  for (const change of [
    value => { value.binding.target.account.id = '90002'; return value },
    value => { value.binding.revision = 'new-revision'; return value },
    value => { value.binding.agentId = 'other'; return value },
    value => { value.token = 'other'; return value },
    value => { value.subjectId = 'other'; return value },
    value => { value.peerId = '10001'; return value },
    value => { value.messages[0].at++; return value },
    value => { value.messages[0].text = '伪造新的原话'; return value },
  ]) await rejects(f.store.update(input.id, change))
  for (const invalid of [
    batch({ selected: binding({ kind: 'private', conversationId: 'room' }) }),
    batch({ selected: binding({ kind: 'private', conversationId: 'room' }), peerId: 'other' }),
    batch({ selected: binding({ kind: 'channel' }) }),
  ]) await rejects(f.store.update(invalid.id, () => invalid))
  assert.deepEqual(await f.store.list(), [input])
})

test('text learning fails closed on malformed catalog, batches, source fields and missing batch keys', { skip: !available }, async t => {
  const f = await fixture(t)
  const input = batch()
  for (const invalid of ['{invalid-json', '[]', JSON.stringify({ version: 2, ids: [] }), JSON.stringify({ version: 1, ids: ['bad'] }), JSON.stringify({ version: 1, ids: [input.id, input.id] })]) {
    await f.client.set(catalogKey, invalid)
    await rejects(f.store.list())
    await rejects(f.store.update(input.id, () => input))
    assert.equal(await f.client.get(catalogKey), invalid)
    assert.equal(await f.client.exists(batchKey(input.id)), 0)
  }
  for (const corrupt of [
    '{invalid-json',
    JSON.stringify({ ...input, version: 2 }),
    JSON.stringify({ ...input, binding: { ...input.binding, id: 'forged' } }),
    JSON.stringify({ ...input, binding: { ...input.binding, source: 'legacy' } }),
    JSON.stringify({ ...input, token: 'x'.repeat(4097) }),
    JSON.stringify({ ...input, attempts: -1 }),
    JSON.stringify({ ...input, dueAt: 0.5 }),
    JSON.stringify({ ...input, retryAt: NaN }),
    JSON.stringify({ ...input, messages: [{ ...message(), messageId: '0' }] }),
    JSON.stringify({ ...input, messages: [{ ...message(), at: 0 }] }),
    JSON.stringify({ ...input, messages: [{ ...message(), text: '' }] }),
    JSON.stringify({ ...input, result: { raw: '```json\n[]\n```', messageIds: ['m1'] } }),
  ]) {
    await f.client.set(catalogKey, JSON.stringify({ version: 1, ids: [input.id] }))
    await f.client.set(batchKey(input.id), corrupt)
    await rejects(f.store.list())
    await rejects(f.store.update(input.id, () => undefined))
    assert.equal(await f.client.get(batchKey(input.id)), corrupt)
  }
  await f.client.del(batchKey(input.id))
  await rejects(f.store.list())
  await rejects(f.store.update(input.id, () => input))
  await f.client.set(catalogKey, JSON.stringify({ version: 1, ids: [] }))
  await f.client.set(batchKey(input.id), JSON.stringify(input))
  await rejects(f.store.update(input.id, () => input))
})

test('text learning stops after twenty CAS conflicts without overwriting concurrent state', { skip: !available }, async t => {
  const f = await fixture(t)
  const input = batch()
  await f.store.update(input.id, () => input)
  let conflicts = 0
  const store = createTextPersonMemoryStore({ get: f.redis.get, async eval(script, options) {
    if (script.includes("redis.call('SET'")) {
      conflicts++
      const entry = JSON.parse(await f.client.get(batchKey(input.id)))
      entry.attempts++
      await f.client.set(batchKey(input.id), JSON.stringify(entry))
    }
    return f.redis.eval(script, options)
  } })
  await rejects(store.update(input.id, current => { current.retryAt = epoch + 1000; return current }))
  assert.equal(conflicts, 20)
  const persisted = (await f.store.list())[0]
  assert.equal(persisted.attempts, 20)
  assert.equal(persisted.retryAt, 0)
})
