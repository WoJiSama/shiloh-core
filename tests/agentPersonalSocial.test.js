import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentBindingDirectory, createAgentRuntime } from '../dist/backend/core/index.js'
import { createAgentQzoneLedger } from '../dist/backend/modules/runtime/infrastructure/agentQzoneLedger.js'
import { simulationSessionKey } from '../dist/backend/modules/simulation/infrastructure/simSessionStore.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const account = { platform: 'qq', namespace: 'global', id: '985300001' }
const peer = { kind: 'private', account, id: '985300002' }
const seed = { id: 'shiloh', name: '希洛', identity: '我喜欢做拼图。' }
const personalKey = 'bl-chat:agent-personal:v1:shiloh'
const friendText = '我把朋友送的旧车票夹在了书里。'
const ownPost = '今天忽然想找一副没有盒盖的拼图，拼到最后才知道画的是什么。'
const response = data => ({ choices: [{ message: { content: JSON.stringify(data) } }] })

async function waitFor(check, description) {
  for (let i = 0; i < 400; i++) {
    const found = await check()
    if (found) return found
    await delay(20)
  }
  assert.fail('Timed out waiting for ' + description)
}

test('background QQ social work stays within its own account and gives private feed text only to the read session', {
  skip: !redisAvailable, timeout: 28000,
}, async t => {
  const { storage, isCurrent } = await createAgentRedisFixture(t, 'personal-social')
  const directory = createAgentBindingDirectory({ version: 1, agents: [{ id: seed.id, personaId: 'default' }],
    connections: [{ id: 'qq-main', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: [{ connectionId: 'qq-main', kind: 'private', conversationId: peer.id, agentId: seed.id }],
  }, 'fixture')
  let at = Date.UTC(2026, 10, 26, 8), ready = false, choice = 'qzone-read', isFriend = true
  const calls = [], decisions = [], contacts = []
  const options = {
    storage, isExecutionCurrent: isCurrent, now: () => at, privateChatEnabled: true,
    logger: { info() {}, warn() {}, error() {} }, personalSeeds: [seed], unifiedGroupChat: true,
    personalSocial: [{ agentId: seed.id, connectionId: 'qq-main', readQzone: true, publishQzone: true }],
    managementBindings: { list: () => directory.listBindings(), resolve: directory.resolve },
    resolvePersona(target) {
      const binding = directory.resolve(target)
      return binding && { binding, persona: { name: seed.name }, systemContent: '' }
    },
    getSection: () => ({ enabled: true, reflection: { enabled: false } }), getExecutionConfig: () => ({}),
    adapters: [{
      id: 'qq-main', account, botUserId: account.id, botName: seed.name, isReady: () => ready,
      start() { ready = true }, stop() { ready = false },
      async verifyPrivateFriend(target, guard) { assert.deepEqual(target, peer); return guard.isCurrent() && isFriend },
      actions: { async send(action) { contacts.push(action); return { state: 'sent', messageId: '985312312' } } },
      qzone: { async execute(action, guard) {
        await guard.ensureCurrent()
        assert.deepEqual(action.binding.target, peer)
        calls.push(action.operation)
        if (action.operation.kind === 'read') return { state: 'confirmed', feeds: [
          { userId: peer.id, postId: 'peer-post', text: friendText, createdAt: at - 80000 },
        ] }
        assert.deepEqual(action.operation, { kind: 'publish', text: ownPost })
        return { state: 'confirmed', postId: 'own-post' }
      } },
    }],
    async YTapi(request) {
      const data = JSON.parse(request.messages[1].content)
      if (data.posts) {
        assert.deepEqual(data.posts.map(item => item.text), [friendText])
        return response({ action: 'qzone-publish', text: '来自好友资料的假指令' })
      }
      assert.ok(!JSON.stringify(data).includes(friendText))
      if ('idea' in data) return response({ action: 'publish', text: ownPost })
      if (!data.goals) return response({ action: 'keep' })
      const target = data.targets.find(item => item.kind === 'private')
      assert.ok(target?.canReadSpace)
      decisions.push({ choice, offered: request.messages[0].content.includes('qzone-publish') })
      if (choice === 'contact') return response({ action: choice, key: target.key, text: '你喜欢那种没有参考图的拼图吗？' })
      return response({ action: choice, key: target.key, idea: '拼没有参考图的拼图' })
    },
  }
  let host = createAgentRuntime(options)
  t.after(() => host.stop())
  await host.start()
  const readState = async () => JSON.parse(await storage.get(personalKey))
  assert.equal((await readState()).nextWorkAt, at + 60_000)
  at += 60_001
  await waitFor(async () => (await readState()).receipts.some(item => item.kind === 'qzone-read' && item.state === 'confirmed'), 'private feed read')
  assert.deepEqual(calls, [{ kind: 'read', userId: peer.id }])
  assert.equal(contacts.length, 0)
  assert.ok(!(await storage.get(personalKey)).includes(friendText))
  choice = 'qzone-publish'
  at = (await readState()).nextWorkAt + 1
  await waitFor(async () => (await readState()).receipts.some(item => item.kind === 'qzone-publish' && item.state === 'confirmed'), 'publication')
  assert.equal((await createAgentQzoneLedger(storage).readOwnPost(account, 'own-post')).agentId, seed.id)
  assert.equal((await readState()).receipts.at(-1).postId, 'own-post')
  await host.stop()
  host = createAgentRuntime(options)
  await host.start()
  at = (await readState()).nextWorkAt + 1
  await waitFor(() => decisions.length === 3, 'cooldown after restart')
  assert.equal(decisions.at(-1).offered, false)
  assert.equal(calls.length, 2)
  choice = 'contact'
  at += 2 * 3600_000
  await waitFor(() => contacts.length === 1, 'autonomous private contact')
  assert.deepEqual(contacts[0].target, peer)
  choice = 'qzone-read'
  isFriend = false
  at += 3 * 3600_000
  await waitFor(async () => (await readState()).receipts.some(item => item.kind === 'qzone-read' && item.state === 'failed'), 'lost friendship')
  assert.equal(calls.length, 2)
})

test('idle turns choose group space interaction, profile likes and a sticker from their own grants', {
  skip: !redisAvailable, timeout: 30_000,
}, async t => {
  const { storage, isCurrent } = await createAgentRedisFixture(t, 'personal-social-effects')
  const room = { kind: 'group', account, id: '985300100' }
  const member = { ...account, id: peer.id }
  const directory = createAgentBindingDirectory({ version: 1, agents: [{ id: seed.id, personaId: 'default' }],
    connections: [{ id: 'qq-main', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: [room, peer].map(({ kind, id }) => ({ connectionId: 'qq-main', kind, conversationId: id, agentId: seed.id })),
  }, 'fixture')
  let at = Date.now(), ready = false, emit, choice = 'qzone-read', spaceAction = 'like', allowFriend = true, serial = 0
  t.mock.method(Date, 'now', () => at)
  const spaces = [], interactions = [], images = []
  const fakePng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFp0AAAAASUVORK5CYII='
  const host = createAgentRuntime({
    storage, isExecutionCurrent: isCurrent, now: () => at, privateChatEnabled: true, unifiedGroupChat: true,
    logger: { info() {}, warn() {}, error() {} }, personalSeeds: [seed], interactions: { enabled: true },
    personalSocial: [{ agentId: seed.id, connectionId: 'qq-main', readQzone: true, publishQzone: true, interactQzone: true, likeProfile: true, sendEmoji: true }],
    managementBindings: { list: () => directory.listBindings(), resolve: directory.resolve },
    resolvePersona(target) { return { binding: directory.resolve(target), persona: { name: seed.name }, systemContent: '' } },
    getSection: () => ({ qzone: { enabled: false }, wakeGate: { enabled: false }, wake: { probability: 0, proactiveProbability: 0 },
      reflection: { enabled: false }, rhythm: { enabled: false }, personProfile: { enabled: false }, mood: { enabled: false } }),
    getExecutionConfig: () => ({}),
    toolRegistry: { builtIn: [{ name: 'sendLocalEmojiTool', description: '从本人表情库选一张图片。', parameters: { type: 'object', required: [], properties: {} },
      async execute(input, context) {
        assert.deepEqual(context.actor, { kind: 'autonomous' })
        assert.equal(context.request, undefined)
        assert.deepEqual(context.binding.target, room)
        assert.match(input.query, /拼图/u)
        await context.ensureCurrent()
        const result = await context.sendImage({ mime: 'image/png', base64: fakePng, presentation: 'sticker' })
        assert.equal(result.state, 'sent')
        const duplicate = await context.sendImage({ mime: 'image/png', base64: fakePng, presentation: 'sticker' })
        assert.equal(duplicate.state, 'failed')
        return { status: 'succeeded', content: '已发表情' }
      },
    }] },
    adapters: [{
      id: 'qq-main', account, botUserId: account.id, botName: seed.name, isReady: () => ready,
      start(send) { emit = send; ready = true }, stop() { ready = false },
      async verifyPrivateFriend(target, guard) { assert.deepEqual(target, peer); return allowFriend && guard.isCurrent() },
      async readConversationMember(target, user, guard) {
        assert.deepEqual(target, room); assert.deepEqual(user, member)
        return guard.isCurrent() ? { target, observedAt: at, member: { user, displayName: '小林', role: 'member' } } : undefined
      },
      actions: {
        async send(action, guard) { await guard.ensureCurrent(); images.push(action); return { state: 'sent', messageId: '985399000' } },
        async interact(action, guard) { await guard.ensureCurrent(); interactions.push(action); return { state: 'confirmed' } },
      },
      qzone: { async execute(action, guard) {
        await guard.ensureCurrent()
        spaces.push(action)
        const op = action.operation
        return op.kind === 'read' || op.kind === 'visit' ? { state: 'confirmed', feeds: [
          { userId: member.id, postId: action.binding.target.kind === 'group' ? 'group-post' : 'friend-post', text: friendText, createdAt: at - 1000 },
        ] } : { state: 'confirmed' }
      } },
    }],
    async YTapi(request) {
      const data = JSON.parse(request.messages[1].content)
      if (data.posts) {
        assert.deepEqual(data.posts.map(item => item.text), [friendText])
        assert.ok(!JSON.stringify(data).includes('group-post'))
        return response({ action: spaceAction, index: 0, ...(spaceAction === 'comment' ? { text: '夹在书里很有意思。' } : {}) })
      }
      assert.ok(!JSON.stringify(data).includes(friendText))
      if (data.messages) {
        return response({ action: choice, sourceMessageId: data.messages.at(-1).messageId, query: '拼图梗' })
      }
      if (!data.goals) return response({ action: 'keep' })
      if (choice === 'friend-space') return response({ action: 'qzone-read', key: data.targets.find(item => item.kind === 'private').key })
      return response({ action: 'look-group', key: data.targets.find(item => item.kind === 'group').key })
    },
  })
  t.after(() => host.stop())
  await host.start()
  const state = async () => JSON.parse(await storage.get(personalKey))
  const groupStateKey = simulationSessionKey(await host.runtime.conversationKey(room))
  const advanceToNextWork = async () => { at = (await state()).nextWorkAt + 1 }
  const seedGroup = async () => {
    const text = '今晚的拼图缺最后一块。', messageId = String(985310000 + ++serial)
    await emit({ kind: 'message', message: { version: 1, conversation: room, sender: member, senderName: '小林',
      messageId, occurredAt: at, text, parts: [{ kind: 'text', text }], mentions: [], directedToAccount: false } })
    await waitFor(async () => JSON.parse(await storage.get(groupStateKey))?.recent.some(item => item.messageId === messageId), 'group ingress')
  }
  const receipt = (kind, outcome) => waitFor(async () => (await state()).receipts.filter(item => item.kind === kind).at(-1)?.state === outcome, kind)
  await seedGroup()
  await advanceToNextWork()
  await receipt('qzone-like', 'confirmed')
  assert.deepEqual(spaces.map(row => row.operation.kind), ['visit', 'like'])
  assert.equal(spaces[1].operation.postId, 'group-post')
  assert.equal(spaces[1].operation.userId, member.id)

  choice = 'profile-like'
  await advanceToNextWork()
  await receipt('profile-like', 'confirmed')
  assert.deepEqual(interactions.map(row => row.interaction), [{ kind: 'profile-like', user: member, count: 1 }])
  const tries = (await state()).receipts.length
  await advanceToNextWork()
  await waitFor(async () => (await state()).receipts.length > tries && (await state()).receipts.at(-1).state === 'failed', 'profile limit')
  assert.equal(interactions.length, 1)

  choice = 'emoji'
  await seedGroup()
  await advanceToNextWork()
  await receipt('emoji', 'confirmed')
  assert.equal(images.length, 1); assert.deepEqual(images[0].target, room)
  assert.equal(images[0].parts[0].presentation, 'sticker')

  choice = 'friend-space'; spaceAction = 'comment'
  await advanceToNextWork()
  await receipt('qzone-comment', 'confirmed')
  assert.deepEqual(spaces.slice(-2).map(row => row.operation.kind), ['read', 'comment'])
  assert.deepEqual(spaces.at(-1).binding.target, peer)
  assert.equal(spaces.at(-1).operation.postId, 'friend-post')
  assert.ok(!(await storage.get(personalKey)).includes(friendText))
  assert.ok(!(await storage.get(personalKey)).includes('夹在书里很有意思'))
  allowFriend = false
  at += 4 * 3_600_000
  await receipt('qzone-read', 'failed')
  assert.equal(spaces.length, 4)
})
