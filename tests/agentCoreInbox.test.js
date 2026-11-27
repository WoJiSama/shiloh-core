import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentBindingDirectory, createAgentRuntime } from '../dist/backend/core/index.js'
import { agentBindingToken, conversationAddressKey, platformAccountKey } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { createAgentInbox } from '../dist/backend/modules/runtime/infrastructure/agentInbox.js'
import { createAgentInboxDispatch } from '../dist/backend/modules/runtime/application/agentInboxDispatch.js'
import { createAgentDiagnostics } from '../dist/backend/modules/runtime/infrastructure/agentDiagnostics.js'
import { simulationAddressKey } from '../dist/backend/modules/simulation/infrastructure/simulationAddress.js'
import { simulationSessionKey } from '../dist/backend/modules/simulation/infrastructure/simSessionStore.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const makeTarget = namespace => ({ account: { platform: 'fixture', namespace, id: 'bot#1' }, kind: 'group', id: 'channel/42' })
const first = makeTarget('tenant-a')
const second = makeTarget('tenant-b')
const simulationInbox = target => ({ kind: 'simulation', account: target.account })
const simulationKey = target => `agent:inbox:simulation:${platformAccountKey(target.account)}`
const redisTest = { skip: !redisAvailable, timeout: 8_000 }
const now = Date.now()

function message(target, id, text = id, quoteId) {
  return {
    version: 1, conversation: target, sender: { ...target.account, id: 'member#1' },
    messageId: id, occurredAt: now, text, parts: [{ kind: 'text', text }], mentions: [], directedToAccount: true,
    ...(quoteId ? { quote: { messageId: quoteId, parts: [] } } : {}),
  }
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function waitFor(probe, description) {
  const until = Date.now() + 3_000
  while (Date.now() < until) {
    const found = await probe()
    if (found) return found
    await delay(15)
  }
  assert.fail(`timed out waiting for ${description}`)
}

test('inbox dispatch stops as soon as a deterministic handler claims the original message', async () => {
  const order = ['games', 'bilibiliQuality', 'magnetSearch', 'torrent', 'mediaRelay', 'musicExtraction']
  const incoming = message(first, 'routing-order'), binding = Object.freeze({ target: first })
  const entered = []
  let owner = 'torrent'
  const dispatch = createAgentInboxDispatch(Object.fromEntries(order.map(name => [name, async (passed, selected) => {
    assert.equal(passed, incoming)
    assert.equal(selected, binding)
    entered.push(name)
    return name === owner
  }])))
  assert.equal(await dispatch.dispatch(incoming, binding), true)
  assert.deepEqual(entered.splice(0), order.slice(0, 4))
  owner = undefined
  assert.equal(await dispatch.dispatch(incoming, binding), false)
  assert.deepEqual(entered, order)
})

test('legacy inbox moves complete batches and resumes without rewriting rows or receipts', redisTest, async t => {
  const { reader, storage, prefix } = await createAgentRedisFixture(t)
  const legacyKey = prefix + 'agent:inbox'
  const persistedReceipt = prefix + 'agent:inbox:receipt:existing'
  const migrated = createAgentInbox(storage)
  const entries = Array.from({ length: 70 }, (_, index) => {
    const target = index % 2 ? first : second
    if (index % 3 === 0) {
      return { event: { kind: 'nudge', target, occurredAt: now, sender: { ...target.account, id: 'member#1' } },
        bindingToken: 'snapshot', ingressId: `nudge-${index}` }
    }
    if (index % 3 === 1) return { event: { kind: 'recall', target, messageId: `recall-${index}` } }
    return { event: { kind: 'message', message: message(target, `message-${index}`) }, bindingToken: 'snapshot' }
  })
  const serialized = entries.map((entry, index) => JSON.stringify(entry, null, index % 2))
  await reader.rPush(legacyKey, serialized)
  await reader.set(persistedReceipt, '1', { EX: 600 })
  let checks = 0
  await migrated.moveLegacySimulationQueue(() => checks++ < 2)
  const remaining = await reader.lRange(legacyKey, 0, -1)
  assert.ok(remaining.length > 0 && remaining.length < serialized.length)
  assert.deepEqual(remaining, serialized.slice(-remaining.length))

  await migrated.moveLegacySimulationQueue(() => true)
  await migrated.moveLegacySimulationQueue(() => true)
  assert.equal(await reader.exists(legacyKey), 0)
  assert.deepEqual(await reader.lRange(prefix + simulationKey(first), 0, -1), serialized.filter((_, index) => index % 2))
  assert.deepEqual(await reader.lRange(prefix + simulationKey(second), 0, -1), serialized.filter((_, index) => index % 2 === 0))
  assert.equal(await reader.get(persistedReceipt), '1')
  assert.ok(await reader.ttl(persistedReceipt) > 0)
  assert.equal(await reader.ttl(prefix + simulationKey(first)), -1)

  const head = await migrated.next(simulationInbox(first))
  assert.equal(head.raw, serialized[1])
  await assert.rejects(migrated.acknowledge(serialized[3], simulationInbox(first)), /队列顺序已改变/u)
  await migrated.acknowledge(head.raw, simulationInbox(first))
  assert.equal((await migrated.next(simulationInbox(first))).raw, serialized[3])
  assert.equal((await migrated.next(simulationInbox(second))).raw, serialized[0])

  const bad = JSON.stringify({ event: { kind: 'recall', target: { ...first, id: 42 }, messageId: 'bad-address' } })
  await reader.rPush(legacyKey, [serialized[0], bad])
  const otherSize = await reader.lLen(prefix + simulationKey(second))
  await assert.rejects(migrated.moveLegacySimulationQueue(() => true), /无法识别的会话地址/u)
  assert.deepEqual(await reader.lRange(legacyKey, 0, -1), [serialized[0], bad])
  assert.equal(await reader.lLen(prefix + simulationKey(second)), otherSize)

  // Redis scripts do not roll back runtime errors. Check all destinations before appending.
  await reader.del(legacyKey, prefix + simulationKey(first))
  await reader.set(prefix + simulationKey(first), 'unexpected Redis type')
  await reader.rPush(legacyKey, serialized.slice(0, 2))
  await assert.rejects(migrated.moveLegacySimulationQueue(() => true), /invalid Agent inbox destination/u)
  assert.deepEqual(await reader.lRange(legacyKey, 0, -1), serialized.slice(0, 2))
  assert.equal(await reader.lLen(prefix + simulationKey(second)), otherSize)
})

test('legacy private inbox migrates exact bytes, conversation order, deadlines and receipts', redisTest, async t => {
  const { reader, storage, prefix } = await createAgentRedisFixture(t)
  const inbox = createAgentInbox(storage)
  const target = { ...first, kind: 'private', id: 'friend-1' }
  const other = { ...target, id: 'friend-2' }
  const legacy = `${prefix}agent:inbox:private:${platformAccountKey(target.account)}`
  const queueKey = address => `${prefix}agent:inbox:private-conversation:${conversationAddressKey(address)}`
  const entries = Array.from({ length: 70 }, (_, index) => {
    const address = index % 2 ? target : other
    return JSON.stringify({ event: { kind: 'message', message: message(address, `legacy-${index}`) }, bindingToken: 'snapshot' }, null, index % 2)
  })
  const receipt = `${prefix}agent:inbox:receipt:fixture-private-receipt`
  await reader.set(receipt, 'attempted')
  await reader.rPush(legacy, entries)
  await reader.expire(legacy, 90)
  let checks = 0
  await inbox.moveLegacyPrivateQueue(target.account, () => checks++ < 2)
  assert.deepEqual(await reader.lRange(legacy, 0, -1), entries.slice(32))
  await inbox.moveLegacyPrivateQueue(target.account, () => true)
  await inbox.moveLegacyPrivateQueue(target.account, () => true)
  assert.deepEqual(await reader.lRange(queueKey(target), 0, -1), entries.filter((_row, index) => index % 2))
  assert.deepEqual(await reader.lRange(queueKey(other), 0, -1), entries.filter((_row, index) => index % 2 === 0))
  assert.equal(await reader.exists(legacy), 0)
  assert.equal(await reader.get(receipt), 'attempted')
  assert.ok(await reader.ttl(queueKey(target)) > 0 && await reader.ttl(queueKey(target)) <= 90)
  assert.deepEqual((await inbox.listPrivateQueues(target.account)).map(queue => queue.conversationId).sort(), [target.id, other.id].sort())

  const recallId = 'recall-before-admission'
  assert.equal(await inbox.recallText(target, recallId), true)
  await inbox.accept({ event: { kind: 'message', message: message(target, recallId) }, bindingToken: 'snapshot' })
  assert.equal(await reader.lLen(queueKey(target)), 35)
  assert.equal(await inbox.canReply(target, recallId), false)
})

test('Core ingests independent accounts while a quoted message stalls another account', redisTest, async t => {
  const { reader, storage, isCurrent, prefix } = await createAgentRedisFixture(t)
  const targets = [first, second]
  const directory = createAgentBindingDirectory({
    version: 1, agents: [{ id: 'same-agent', personaId: 'default' }],
    connections: targets.map(({ account }, index) => ({ id: `account-${index}`, platform: account.platform, namespace: account.namespace, accountId: account.id })),
    bindings: targets.map(({ kind, id }, index) => ({ connectionId: `account-${index}`, kind, conversationId: id, agentId: 'same-agent' })),
  }, 'fixture-revision')
  const token = target => agentBindingToken(directory.resolve(target))
  const release = deferred()
  let entered = false
  function adapter(target, readMessage) {
    let accept
    return {
      account: target.account, id: directory.resolve(target).connectionId, botUserId: target.account.id, botName: 'fixture',
      start: async handler => { accept = handler },
      stop: () => {},
      isReady: () => Boolean(accept),
      async emit(event) { await accept(event) },
      actions: { send: async () => { assert.fail('test events are only ingested') } },
      ...(readMessage ? { readMessage } : {}),
    }
  }
  const slow = adapter(first, async (target, id) => {
    assert.equal(target.account.namespace, first.account.namespace)
    assert.equal(id, 'prior')
    entered = true
    await release.promise
    return undefined
  })
  const fast = adapter(second)
  const host = createAgentRuntime({
    storage, isExecutionCurrent: isCurrent, adapters: [slow, fast],
    logger: { info() {}, warn() {}, error() {} },
    getSection: () => ({ wake: { batchWindowMs: 60_000 }, reflection: { enabled: false }, rhythm: { enabled: false } }),
    getExecutionConfig: () => ({}),
    resolvePersona: target => {
      const binding = directory.resolve(target)
      return binding && { binding, persona: { name: 'fixture' }, systemContent: '' }
    },
    YTapi: async () => ({ choices: [] }),
  })
  const readSession = async target => JSON.parse(await reader.get(prefix + simulationSessionKey(simulationAddressKey(target))) ?? 'null')
  const inbox = createAgentInbox(storage)
  const legacyKey = prefix + 'agent:inbox'
  const slowEntry = { event: { kind: 'message', message: message(first, 'shared', 'first account', 'prior') }, bindingToken: token(first) }
  const legacyRow = JSON.stringify(slowEntry)
  // Simulate a receipt and a pending row from the previous process before upgrading.
  await inbox.accept(slowEntry)
  await reader.rename(prefix + simulationKey(first), legacyKey)
  let starting
  try {
    starting = host.start()
    await waitFor(() => entered, 'first account lookup')
    assert.equal(await reader.exists(legacyKey), 0)
    assert.equal(await reader.lIndex(prefix + simulationKey(first), 0), legacyRow)
    await assert.rejects(inbox.accept(slowEntry, { kind: 'group', account: second.account }), /收件队列不匹配/u)

    await slow.emit({ kind: 'message', message: message(first, 'after', 'later in the first account') })
    await slow.emit(slowEntry.event)
    await fast.emit({ kind: 'message', message: message(second, 'shared', 'second account') })
    await fast.emit({ kind: 'message', message: message(first, 'wrong-account', 'foreign sender') })
    const peerState = await waitFor(() => readSession(second), 'second account session while the first lookup is in flight')
    assert.deepEqual(peerState.recent.map(entry => entry.text), ['second account'])
    assert.equal(await readSession(first), null)
    assert.equal(await reader.lLen(prefix + simulationKey(first)), 2)
    assert.equal(await inbox.canReply(first, 'after'), true)
    assert.equal(await inbox.canReply(second, 'after'), false)
    assert.equal(await inbox.canReply(first, 'wrong-account'), false)

    // A forged/invalid persisted row must not invalidate another account or consume a real message ID.
    const invalidReplay = [
      { event: { kind: 'recall', target: first, messageId: 'after' } },
      { event: { kind: 'recall', target: second, messageId: 'shared' } },
      { event: { kind: 'message', message: { ...message(second, 'invalid-shape'), parts: null } }, bindingToken: token(second) },
      { event: { kind: 'message', message: { ...message(second, 'invalid-sender'), sender: { ...first.account, id: 'member#1' } } }, bindingToken: token(second) },
    ].map(entry => JSON.stringify(entry))
    await reader.rPush(prefix + simulationKey(second), invalidReplay)
    await host.resumePendingWork()
    await waitFor(async () => await reader.lLen(prefix + simulationKey(second)) === 0, 'wrong-account and invalid replay entries discarded')
    assert.deepEqual((await readSession(second)).recent.map(entry => entry.text), ['second account'])
    release.resolve()
    await starting
    const firstState = await waitFor(async () => {
      const state = await readSession(first)
      return state?.recent.length === 2 ? state : undefined
    }, 'first account resumes in FIFO order')
    assert.deepEqual(firstState.recent.map(entry => entry.text), ['first account', 'later in the first account'])
    assert.equal(await reader.lLen(prefix + simulationKey(first)), 0)
    assert.equal(await inbox.canReply(first, 'shared'), true)
    assert.equal(await inbox.canReply(second, 'shared'), true)

    await slow.emit({ kind: 'recall', target: first, messageId: 'shared' })
    await waitFor(async () => (await readSession(first))?.recent.length === 1, 'first account recall affects its own message')
    assert.deepEqual((await readSession(second)).recent.map(entry => entry.text), ['second account'])
    assert.equal(await inbox.canReply(first, 'shared'), false)
    assert.equal(await inbox.canReply(second, 'shared'), true)
  } finally {
    release.resolve()
    await Promise.allSettled([starting, host.stop()])
  }
})

test('only sustained semantic storage inactivity triggers a retry and the original stays queued', { ...redisTest, timeout: 25_000 }, async t => {
  const { reader, storage, prefix, isCurrent } = await createAgentRedisFixture(t, 'agent-inbox-semantic-timeout')
  const directory = createAgentBindingDirectory({ version: 1, agents: [{ id: 'fixture', personaId: 'default' }],
    connections: [{ id: 'fixture', platform: first.account.platform, namespace: first.account.namespace, accountId: first.account.id }],
    bindings: [{ connectionId: 'fixture', kind: first.kind, conversationId: first.id, agentId: 'fixture' }],
  }, 'inbox-semantic-timeout')
  const binding = directory.resolve(first)
  const stalled = deferred(), release = deferred(), failed = Promise.withResolvers()
  const failures = []
  const logger = { info() {}, warn() {}, error() {} }
  const diagnostics = createAgentDiagnostics({ logger, onFailure(event) {
    if (event.operation === 'consume_simulation') { failures.push(event); failed.resolve(event) }
  } })
  let accept, held = false
  const host = createAgentRuntime({
    storage, isExecutionCurrent: isCurrent, logger, diagnostics,
    semanticMemory: { enabled: true },
    semanticMemoryBackend: { id: 'a'.repeat(64), async embed(texts) { return texts.map(() => [1, 0]) } },
    semanticRedis: { ...storage, async eval(script, input) {
      if (!held && script.startsWith('return {redis.call') && input.keys[1]?.startsWith('agent:semantic-memory:v1:state:')) {
        held = true
        stalled.resolve()
        await release.promise
      }
      return storage.eval(script, input)
    } },
    adapters: [{
      id: 'fixture', account: first.account, botUserId: first.account.id, botName: 'fixture',
      async start(handler) { accept = handler }, stop() {}, isReady: () => Boolean(accept),
      actions: { async send() { assert.fail('test only ingests a message') } },
    }],
    getSection: () => ({ wake: { batchWindowMs: 60_000 }, reflection: { enabled: false }, rhythm: { enabled: false } }),
    getExecutionConfig: () => ({}),
    resolvePersona: target => {
      const selected = directory.resolve(target)
      return selected && { binding: selected, persona: { name: 'fixture' }, systemContent: '' }
    },
    YTapi: async () => ({ choices: [] }),
  })
  const item = message(first, 'slow-semantic-save', 'synthetic message for inbox retry')
  item.directedToAccount = false
  try {
    await host.start()
    await accept({ kind: 'message', message: item })
    await stalled.promise
    await delay(5250)
    assert.deepEqual(failures, [], 'the old five-second total deadline must not abort a pending save')
    const failure = await failed.promise
    assert.equal(failure.code, 'semantic_capture_save_timeout')
    assert.deepEqual(failure.scope, { kind: 'conversation', binding, messageId: item.messageId })
    assert.ok(failure.durationMs >= 14_900)
    const key = prefix + simulationKey(first)
    assert.equal(await reader.lLen(key), 1)
    release.resolve()
    await waitFor(async () => await reader.lLen(key) === 0, 'semantic inbox retry acknowledgement')
    const session = JSON.parse(await storage.get(simulationSessionKey(simulationAddressKey(first))))
    assert.deepEqual(session.recent.map(row => row.messageId), [item.messageId])
  } finally {
    release.resolve()
    await host.stop()
  }
})
