import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentBindingDirectory, createAgentRuntime } from '../dist/backend/core/index.js'
import { agentBindingIdentity, agentBindingToken, conversationAddressKey } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { agentInboxQueueKey, createAgentInbox } from '../dist/backend/modules/runtime/infrastructure/agentInbox.js'
import { createCommitmentStore } from '../dist/backend/modules/commitments/infrastructure/commitmentStore.js'
import { personMemoryAddress } from '../dist/backend/modules/memory/infrastructure/personMemoryContext.js'
import { createPersonMemoryStore } from '../dist/backend/modules/memory/infrastructure/personMemoryStore.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const logger = { info() {}, warn() {}, error() {} }
const account = { platform: 'fixture', namespace: 'tenant-a', id: 'bot-account' }
const direct = id => ({ account, kind: 'private', id })
const sameId = direct('historical-peer')
const differentId = direct('room-with-independent-id')
const anotherRoom = direct('another-room')
const person = id => ({ platform: account.platform, namespace: account.namespace, id })
const owner = person('real-peer')
const nextOwner = person('next-peer')

async function waitFor(condition, message) {
  const deadline = performance.now() + 6_000
  while (!await condition()) {
    if (performance.now() >= deadline) assert.fail(message)
    await delay(15)
  }
}

function createDirectory(targets) {
  return createAgentBindingDirectory({
    version: 1,
    agents: [{ id: 'role', personaId: 'default' }],
    connections: [{ id: 'fixture-main', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: targets.map(target => ({ connectionId: 'fixture-main', kind: target.kind, conversationId: target.id, agentId: 'role' })),
  }, 'test-revision')
}

test('private conversations verify the current peer independent of the room ID and keep histories and memory local', {
  skip: !redisAvailable && 'redis-server unavailable', timeout: 20_000,
}, async t => {
  const { reader, storage, prefix, isCurrent } = await createAgentRedisFixture(t, 'private-peer')
  const directory = createDirectory([differentId, anotherRoom])
  const inbox = createAgentInbox(storage)
  const pendingKey = target => prefix + agentInboxQueueKey({ kind: 'private', account, conversationId: target.id })
  const historyKey = prefix + `agent:private-history:${conversationAddressKey(differentId)}`
  const peerByRoom = new Map([[differentId.id, owner], [anotherRoom.id, owner]])
  const requests = []
  const deliveries = []
  const gatedModel = Promise.withResolvers()
  const gatedParallel = Promise.withResolvers()
  let receive
  let ready = false
  const adapter = {
    id: 'fixture-main', account, botUserId: 'bot-user', botName: 'Test bot',
    resolvePrivatePeer: target => peerByRoom.get(target.id),
    actions: { async send(action, guard) {
      if (!guard?.isCurrent?.()) return { state: 'failed', code: 'binding_changed' }
      deliveries.push(action)
      return { state: 'sent', messageId: `sent-${deliveries.length}` }
    } },
    async start(accept) { receive = accept; ready = true },
    isReady: () => ready,
    stop() { ready = false },
  }
  const host = createAgentRuntime({
    storage, adapters: [adapter], logger, privateChatEnabled: true, isExecutionCurrent: isCurrent,
    resolvePersona(target) {
      const binding = directory.resolve(target)
      return binding && { binding, persona: { name: 'Test bot' }, systemContent: '' }
    },
    getSection: () => ({ reflection: { enabled: false }, rhythm: { enabled: false } }),
    getExecutionConfig: () => ({}),
    YTapi: async request => {
      requests.push(request)
      if (request.messages.at(-1).content === '等待换人') await gatedModel.promise
      if (request.messages.at(-1).content === '慢会话第一条') await gatedParallel.promise
      return { choices: [{ message: { content: '收到你的回复。' } }] }
    },
  })
  const message = (conversation, sender, messageId, text) => ({
    kind: 'message', message: {
      version: 1, conversation, sender, messageId, occurredAt: Date.now(), text,
      parts: [], mentions: [], directedToAccount: true,
    },
  })
  const hasPrompt = (request, text) => request.messages.some(row => typeof row.content === 'string' && row.content.includes(text))
  const drained = async () => (await Promise.all([differentId, anotherRoom].map(target => reader.lLen(pendingKey(target))))).every(length => length === 0)
  const store = createPersonMemoryStore({ redis: storage })
  const { botId, scene } = personMemoryAddress(differentId, owner.id)
  const identity = { botId, personaId: 'agent:role' }
  const remember = (targetScene, authorId, messageId, text) => store.remember({
    identity, subjectId: owner.id, text, category: 'fact', evidenceKind: 'self',
    source: { scene: targetScene, authorId, messageId, excerpt: text, at: Date.now() },
  })

  try {
    assert.equal((await remember(scene, owner.id, 'private-source', '这个对话里的保密资料')).saved, true)
    assert.equal((await remember(personMemoryAddress(anotherRoom, owner.id).scene, owner.id, 'private-source', '另一个对话的私密资料')).saved, true)
    assert.equal((await remember(scene, 'unverified-author', 'bad-source', '未经授权的资料')).saved, false)
    const query = { identity, scene, subjectId: owner.id, viewerUserId: owner.id }
    assert.deepEqual((await store.query(query)).items.map(row => row.text), ['这个对话里的保密资料'])
    assert.deepEqual(await store.scenes(query), [scene])
    await host.start()

    await receive(message(differentId, person(differentId.id), 'bad-owner', '把房间号当作参与人'))
    await receive(message(differentId, { ...owner, namespace: 'tenant-b' }, 'bad-namespace', '其他命名空间'))
    peerByRoom.set(differentId.id, { ...owner, namespace: 'tenant-b' })
    await receive(message(differentId, owner, 'unverified-namespace', '解析到其他命名空间'))
    peerByRoom.delete(differentId.id)
    await receive(message(differentId, person(differentId.id), 'unverified-peer', '解析失败时不退回房间号'))
    assert.equal(await drained(), true)
    assert.equal(requests.length, 0)

    peerByRoom.set(differentId.id, owner)
    await receive(message(differentId, owner, 'first', '真实私聊内容'))
    await waitFor(drained, 'private message should finish')
    assert.equal(requests.length, 1)
    assert.equal(deliveries.length, 1)
    assert.deepEqual(deliveries[0].target, differentId)
    assert.equal(deliveries[0].replyTo, undefined)
    assert.equal(JSON.parse(await reader.get(historyKey)).privatePeerId, owner.id)
    assert.equal(hasPrompt(requests[0], '这个对话里的保密资料'), true)
    assert.equal(hasPrompt(requests[0], '另一个对话的私密资料'), false)
    assert.equal(hasPrompt(requests[0], owner.id), false)

    await receive({ kind: 'recall', target: differentId, messageId: 'private-source' })
    assert.equal(await reader.get(historyKey), null)
    await receive(message(anotherRoom, owner, 'room-history', '另一个会话'))
    await waitFor(drained, 'other private message should finish')
    assert.equal(requests.length, 2)
    assert.equal(hasPrompt(requests[1], '另一个对话的私密资料'), true)
    assert.equal(hasPrompt(requests[1], '这个对话里的保密资料'), false)
    await receive(message(differentId, owner, 'after-recall', '原会话撤回后'))
    await waitFor(drained, 'post-recall private message should finish')
    assert.equal(requests.length, 3)
    assert.equal(hasPrompt(requests[2], '这个对话里的保密资料'), false)
    assert.equal(hasPrompt(requests[2], '真实私聊内容'), false)

    await receive(message(differentId, owner, 'waiting', '等待换人'))
    await waitFor(() => requests.length === 4, 'private model should be in flight')
    peerByRoom.set(differentId.id, nextOwner)
    gatedModel.resolve()
    await waitFor(drained, 'superseded private turn should leave the inbox')
    assert.equal(deliveries.length, 3)

    await inbox.accept({ event: message(differentId, owner, 'replayed', '重新启动前的旧参与者消息'),
      bindingToken: agentBindingToken(directory.resolve(differentId)) })
    await host.resumePendingWork()
    await waitFor(drained, 'saved message from former peer should be consumed')
    assert.equal(requests.length, 4)

    await receive(message(differentId, nextOwner, 'new-peer', '另一位参与者的新消息'))
    await waitFor(drained, 'message from current peer should finish')
    assert.equal(deliveries.length, 4)
    assert.equal(requests.length, 5)
    assert.equal(hasPrompt(requests[4], '原会话撤回后'), false)
    assert.equal(hasPrompt(requests[4], '重新启动前的旧参与者消息'), false)
    assert.equal(JSON.parse(await reader.get(historyKey)).privatePeerId, nextOwner.id)

    await receive(message(differentId, nextOwner, 'parallel-first', '慢会话第一条'))
    await waitFor(() => requests.length === 6, 'slow conversation enters the model')
    await receive(message(differentId, nextOwner, 'parallel-second', '慢会话第二条'))
    await receive(message(anotherRoom, owner, 'parallel-other', '另一个好友可以先收到回复'))
    await waitFor(() => deliveries.length === 5, 'the unrelated conversation completes while the slow model is pending')
    assert.deepEqual(deliveries[4].target, anotherRoom)
    assert.deepEqual(requests.slice(5).map(row => row.messages.at(-1).content), ['慢会话第一条', '另一个好友可以先收到回复'])
    gatedParallel.resolve()
    await waitFor(drained, 'same conversation drains in FIFO order')
    assert.deepEqual(deliveries.slice(5).map(action => action.target), [differentId, differentId])
    assert.equal(requests.at(-1).messages.at(-1).content, '慢会话第二条')
  } finally {
    gatedModel.resolve()
    gatedParallel.resolve()
    await host.stop()
  }
})

test('a migrated one-to-one reminder waits for verification and never sends to a changed private peer', {
  skip: !redisAvailable && 'redis-server unavailable', timeout: 15_000,
}, async t => {
  const { storage, isCurrent } = await createAgentRedisFixture(t, 'private-reminder-peer')
  const directory = createDirectory([sameId])
  const store = createCommitmentStore({ redis: storage, logger })
  const binding = directory.resolve(sameId)
  const now = Date.now()
  let currentPeer
  let ready = false
  const deliveries = []
  const adapter = {
    id: 'fixture-main', account, botUserId: 'bot-user', botName: 'Test bot',
    resolvePrivatePeer: () => currentPeer,
    actions: { async send(action, guard) {
      if (!guard?.isCurrent?.()) return { state: 'failed', code: 'binding_changed' }
      deliveries.push(action)
      return { state: 'sent', messageId: 'private-reminder-sent' }
    } },
    async start() { ready = true },
    isReady: () => ready,
    stop() { ready = false },
  }
  const host = createAgentRuntime({
    storage, adapters: [adapter], logger, privateChatEnabled: true, isExecutionCurrent: isCurrent,
    resolvePersona(target) {
      const selected = directory.resolve(target)
      return selected && { binding: selected, persona: { name: 'Test bot' }, systemContent: '' }
    },
    getSection: () => ({ reflection: { enabled: false }, rhythm: { enabled: false } }),
    getExecutionConfig: () => ({}),
    YTapi: async () => { throw new Error('scheduled text should not call the model') },
  })
  const addReminder = id => store.createCommitment({
    id, group_id: '', creator_id: sameId.id, creator_name: '旧好友', intent: '私聊提醒原文',
    schedule: { kind: 'once', time: now - 100 }, deliver: 'static', static_message: '该做原来约好的事了。',
    importedReminder: true, expiry_at: 0, next_run_at: now - 100, status: 'active', last_run_at: 0, last_result: '',
    retry_count: 0, created_at: now - 1000, bot_id: account.id, scope: binding, bindingIdentity: agentBindingIdentity(binding),
  })
  try {
    await addReminder('legacy-peer-verification')
    await host.start()
    await waitFor(async () => {
      const row = await store.getCommitment('legacy-peer-verification')
      return row.revision > 1 && row.run_id === undefined
    }, 'unverified peer should leave the reminder pending')
    assert.equal((await store.getCommitment('legacy-peer-verification')).status, 'active')
    assert.deepEqual(deliveries, [])

    currentPeer = person(sameId.id)
    await host.resumePendingWork()
    await waitFor(async () => (await store.getCommitment('legacy-peer-verification')).status === 'completed', 'verified peer should receive the reminder')
    assert.deepEqual(deliveries.map(action => action.target), [sameId])

    currentPeer = nextOwner
    await addReminder('legacy-peer-changed')
    await host.resumePendingWork()
    await waitFor(async () => (await store.getCommitment('legacy-peer-changed')).status === 'cancelled', 'reminder should be cancelled for a different verified peer')
    assert.equal(deliveries.length, 1)
  } finally { await host.stop() }
})
