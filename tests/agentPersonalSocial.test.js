import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentBindingDirectory, createAgentRuntime } from '../dist/backend/core/index.js'
import { createAgentQzoneLedger } from '../dist/backend/modules/runtime/infrastructure/agentQzoneLedger.js'
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
