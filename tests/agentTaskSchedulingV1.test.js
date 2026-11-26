import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { createAgentBindingDirectory, createAgentRuntime } from '../dist/backend/core/index.js'
import { createCommitmentStore, COMMITMENT_LEASE_MS } from '../dist/backend/modules/commitments/infrastructure/commitmentStore.js'
import { agentBindingIdentity } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const account = { platform: 'qq', namespace: 'global', id: '985302001' }
const target = { account, kind: 'group', id: '984222001' }
const author = { ...account, id: '984222002' }
const logger = { info() {}, warn() {}, error() {} }
const personalKey = 'bl-chat:agent-personal:v1:shiloh'
const followUrl = 'https://github.com/example/game'
const hash = text => createHash('sha256').update(text).digest('hex')
const response = (content, tool) => ({
  model: 'fixture',
  choices: [{ message: { content, ...(tool ? { tool_calls: [{
    id: tool.name + '-fixture', type: 'function',
    function: { name: tool.name, arguments: JSON.stringify(tool.args) },
  }] } : {}) } }],
})

async function waitFor(check, description) {
  const deadline = performance.now() + 8000
  while (performance.now() < deadline) {
    const result = await check()
    if (result) return result
    await delay(20)
  }
  assert.fail('Timed out awaiting ' + description)
}

async function fixture(t, { model, followFeed, deliver, verify }) {
  const { storage, isCurrent } = await createAgentRedisFixture(t, 'core-scheduling')
  const connections = [{ id: 'qq', platform: 'qq', namespace: 'global', accountId: account.id }]
  const directory = agentId => createAgentBindingDirectory({ version: 1, connections,
    agents: [{ id: agentId, personaId: 'default' }],
    bindings: [{ agentId, kind: 'group', connectionId: 'qq', conversationId: target.id }],
  }, agentId)
  let bindings = directory('shiloh')
  let at = Date.UTC(2026, 10, 22, 11), ready = false, receive
  const history = new Map(), sent = [], calls = []
  const store = createCommitmentStore({ redis: storage, logger })
  const adapter = {
    id: 'qq', account, botUserId: account.id, botName: '希洛',
    async start(accept) { receive = accept; ready = true },
    stop() { ready = false },
    isReady: () => ready,
    async readMessage(scene, id, guard) {
      assert.deepEqual(scene, target)
      return guard.isCurrent() ? history.get(id) : undefined
    },
    async findOwnTextDelivery(scene, proof, guard) {
      assert.deepEqual(scene, target)
      return guard.isCurrent() && verify ? verify(proof) : undefined
    },
    actions: { async send(action, guard) {
      assert.deepEqual(action.target, target)
      await guard.ensureCurrent()
      assert.equal(guard.isCurrent(), true)
      const text = action.parts.filter(part => part.kind === 'text').map(part => part.text).join('')
      const attempt = { text, parts: action.parts, messageId: String(870003000 + sent.length), at }
      sent.push(attempt)
      return deliver ? deliver(attempt) : { state: 'sent', messageId: attempt.messageId }
    } },
  }
  const options = {
    storage, isExecutionCurrent: isCurrent, adapters: [adapter], logger, now: () => at, unifiedGroupChat: true,
    personalSeeds: followFeed ? [{ id: 'shiloh', name: '希洛', identity: '测试档案' }] : [],
    managementBindings: { list: () => bindings.listBindings(), resolve: scene => bindings.resolve(scene) },
    resolvePersona(scene) {
      const binding = bindings.resolve(scene)
      return binding && { binding, persona: { name: '希洛' }, systemContent: '' }
    },
    getSection: () => ({ wake: { batchWindowMs: 1000, probability: 0, proactiveProbability: 0 }, wakeGate: { enabled: false },
      reflection: { enabled: false }, lifeThreads: { enabled: false }, personProfile: { enabled: false },
      mood: { enabled: false }, userStyle: { enabled: false } }),
    getExecutionConfig: () => ({ useTools: true }),
    ...(followFeed ? { personalFollowFeed: followFeed } : {}),
    async YTapi(request) { calls.push(request); return model(request) },
  }
  let host = createAgentRuntime(options)
  t.after(() => host.stop())
  async function message(text, directedToAccount = false) {
    const messageId = String(870002000 + history.size)
    const message = { version: 1, conversation: target, sender: author, senderName: '成员', occurredAt: at, messageId, text,
      parts: [{ kind: 'text', text }], directedToAccount, mentions: directedToAccount ? [account] : [] }
    history.set(messageId, message)
    await receive({ kind: 'message', message })
    return message
  }
  function task(id, text, nextAt, groupSource) {
    const binding = bindings.resolve(target)
    return { id, group_id: target.id, creator_id: author.id, creator_name: '成员', intent: text,
      schedule: { kind: 'once', time: nextAt }, deliver: 'static', static_message: text, mentionCreator: false,
      expiry_at: 0, next_run_at: nextAt, status: 'active', last_run_at: 0, last_result: '', retry_count: 0,
      created_at: at, bot_id: account.id, scope: binding, bindingIdentity: agentBindingIdentity(binding),
      ...(groupSource ? { groupSource, sourceAt: groupSource.at } : {}) }
  }
  return {
    storage, store, calls, sent, message, task,
    get host() { return host },
    get at() { return at },
    set at(value) { at = value },
    async restart() { await host.stop(); host = createAgentRuntime(options); await host.start() },
    replaceBinding() { bindings = directory('replacement') },
    revokeSource(id) { history.delete(id) },
    async quiet() {
      const key = await host.runtime.conversationKey(target)
      await host.runtime.setGroupReplyMode(key, 'atOnly')
      assert.equal(await host.runtime.canInitiateGroupChat(target), false)
    },
  }
}

test('Core initiates a conversation without any ingress and rechecks the group switch before delivery', {
  skip: !redisAvailable, timeout: 20_000,
}, async t => {
  let revoke = false
  const h = await fixture(t, {
    followFeed: async () => [],
    async model(request) {
      const input = JSON.parse(request.messages[1].content)
      if (!input.goals) return response('{"action":"keep"}')
      assert.equal(input.targets.length, 1)
      assert.equal(input.targets[0].history, 'empty')
      if (revoke) await h.quiet()
      return response(JSON.stringify({ action: 'contact', key: input.targets[0].key, text: '我想到一种新的书签做法。' }))
    },
  })
  await h.host.start()
  h.at += 10 * 60_000
  const receipts = async () => JSON.parse(await h.storage.get(personalKey)).receipts
  await waitFor(async () => (await receipts()).some(item => item.state === 'confirmed'), 'unsolicited contact')
  assert.deepEqual(h.sent.map(row => row.text), ['我想到一种新的书签做法。'])
  revoke = true
  h.at += 20 * 3600_000
  await waitFor(async () => (await receipts()).some(item => item.state === 'failed'), 'revoked contact')
  assert.equal(h.sent.length, 1)
})

test('Core reclaims an old reminder under the same id while a feed and a real @ turn run independently', {
  skip: !redisAvailable, timeout: 25_000,
}, async t => {
  const feedEntered = Promise.withResolvers(), feed = Promise.withResolvers(), delivery = Promise.withResolvers()
  let turns = 0
  const h = await fixture(t, {
    async followFeed(url) { assert.equal(url, followUrl); feedEntered.resolve(); return feed.promise },
    async deliver(attempt) {
      if (attempt.text === '八点的旧提醒') await delivery.promise
      return { state: 'sent', messageId: attempt.messageId }
    },
    model(request) {
      if (JSON.stringify(request.messages).includes('八点在哪里')) {
        assert.match(JSON.stringify(request.messages), /群活动八点在集合点/u)
        if (turns++ === 0) return response('', { name: 'simSendMessage', args: { continuation: 'chat', messages: ['八点在集合点。'] } })
      }
      return response('[SILENT]')
    },
  })
  t.after(() => { feed.resolve([]); delivery.resolve() })
  const due = h.at + 1000
  await h.store.createCommitment(h.task('old-group-reminder', '八点的旧提醒', due))
  const [oldClaim] = await h.store.takeDueCommitments(due)
  assert.equal(oldClaim.execution_state, 'claimed')
  assert.equal(oldClaim.next_run_at, due)
  await h.storage.set(personalKey, JSON.stringify({
    profiles: [{ revision: 0, changedAt: 0, name: '希洛', aliases: [], introduction: '', identity: '测试档案', reason: '初始' }],
    nextReviewAt: h.at + 3600_000, nextWorkAt: h.at + 3600_000, receipts: [], goals: [], tools: [],
    follows: [{ id: 'prior-follow', title: '游戏', state: 'active', url: followUrl, intervalHours: 1,
      nextAt: h.at, seen: [], failures: 0 }],
  }))
  try {
    await h.host.start()
    await feedEntered.promise
    await h.quiet()
    await h.message('群活动八点在集合点')
    h.at = due + COMMITMENT_LEASE_MS + 1
    await h.host.resumePendingWork()
    await waitFor(() => h.sent[0], 'old reminder dispatch')
    const sending = await h.store.getCommitment(oldClaim.id)
    assert.notEqual(sending.run_id, oldClaim.run_id)
    assert.equal(sending.next_run_at, due)
    assert.equal(sending.execution_state, 'executing')
    assert.equal(sending.groupDispatch.sha256, hash('八点的旧提醒'))
    await h.message('八点在哪里', true)
    await waitFor(() => turns, '@ model while the reminder send waits')
    assert.deepEqual(h.sent.map(item => item.text), ['八点的旧提醒'])
    delivery.resolve()
    await waitFor(() => h.sent.length === 2, 'queued @ reply')
    assert.deepEqual(h.sent.map(item => item.text), ['八点的旧提醒', '八点在集合点。'])
    assert.equal((await h.store.getCommitment(oldClaim.id)).status, 'completed')
    feed.resolve([])
    await waitFor(async () => JSON.parse(await h.storage.get(personalKey)).follows[0].lastCheckedAt, 'feed baseline')
  } finally { delivery.resolve(); feed.resolve([]) }
})

test('a chat-created group reminder keeps its dispatch proof across restart and reconciles a lost receipt', {
  skip: !redisAvailable, timeout: 25_000,
}, async t => {
  let planned, attempt, lookups = 0
  const h = await fixture(t, {
    model(request) {
      if (request.messages.some(message => message.role === 'tool')) return response('[SILENT]')
      assert.ok(request.tools.some(tool => tool.function.name === 'commitmentTool'))
      return response('', { name: 'commitmentTool', args: { action: 'create', intent: '稍后提醒集合', schedule_kind: 'once',
        schedule_time: new Date(planned).toISOString(), deliver: 'static', static_message: '记得集合', mention_creator: true } })
    },
    async deliver(value) {
      if (value.text.trim() !== '记得集合') return { state: 'sent', messageId: value.messageId }
      attempt = value
      return { state: 'unknown' }
    },
    verify(proof) {
      lookups++
      assert.equal(proof.mentionId, author.id)
      assert.equal(proof.sha256, hash(attempt.text))
      assert.ok(attempt.at >= proof.from && attempt.at < proof.until)
      return { conversation: target, author: account, messageId: attempt.messageId, occurredAt: attempt.at }
    },
  })
  planned = h.at + 60_000
  await h.host.start()
  await h.quiet()
  const request = await h.message('稍后提醒集合', true)
  const registered = await waitFor(async () => (await h.store.listActiveCommitments())[0], 'genuine group registration')
  assert.deepEqual(registered.groupSource, { messageId: request.messageId, authorId: author.id, at: request.occurredAt })
  assert.equal(registered.next_run_at, planned)
  assert.equal(h.sent.filter(value => value.text.trim() === '记得集合').length, 0)
  h.at = planned + 1
  await h.host.resumePendingWork()
  const uncertain = await waitFor(async () => {
    const saved = await h.store.getCommitment(registered.id)
    return saved.status === 'unknown' && saved
  }, 'uncertain group receipt')
  assert.equal(uncertain.groupDispatch.mentionId, author.id)
  assert.equal(lookups, 0)
  h.at = uncertain.groupDispatch.nextCheckAt + 1
  await h.restart()
  await waitFor(async () => (await h.store.getCommitment(registered.id)).status === 'completed', 'receipt verified after restart')
  const confirmed = await h.store.getCommitment(registered.id)
  assert.equal(confirmed.groupDispatch.at, uncertain.groupDispatch.at)
  assert.equal(confirmed.groupDispatch.messageId, attempt.messageId)
  assert.equal(h.sent.filter(value => value.text.trim() === '记得集合').length, 1)
  assert.equal(lookups, 1)
})

test('due group reminders with a vanished source or a changed binding stop before dispatch', {
  skip: !redisAvailable, timeout: 20_000,
}, async t => {
  const h = await fixture(t, { model: () => assert.fail('no model turn'), deliver: () => assert.fail('no delivery') })
  await h.host.start()
  await h.quiet()
  const source = await h.message('原活动时间的依据')
  const proof = { messageId: source.messageId, authorId: author.id, at: source.occurredAt }
  await h.store.createCommitment(h.task('vanished-source', '取消的来源', h.at + 1000, proof))
  await h.store.createCommitment(h.task('old-binding', '旧角色的任务', h.at + 2000))
  h.revokeSource(source.messageId)
  h.at += 1001
  await h.host.resumePendingWork()
  await waitFor(async () => (await h.store.getCommitment('vanished-source')).status === 'cancelled', 'source revocation')
  h.replaceBinding()
  h.at += 1000
  await h.host.resumePendingWork()
  await waitFor(async () => (await h.store.getCommitment('old-binding')).status === 'cancelled', 'binding revocation')
  assert.deepEqual(h.sent, [])
})

test('a process interrupted after dispatch leaves one recoverable proof and never sends again', {
  skip: !redisAvailable, timeout: 20_000,
}, async t => {
  const attempts = []
  const h = await fixture(t, {
    model: () => assert.fail('no model turn'),
    deliver: () => assert.fail('the old process already tried to send'),
    verify(proof) {
      attempts.push(proof)
      return { conversation: target, author: account, messageId: '870004000', occurredAt: proof.from }
    },
  })
  await h.store.createCommitment(h.task('in-flight-on-restart', '部署前已尝试派发', h.at))
  const [claimed] = await h.store.takeDueCommitments(h.at)
  const at = h.at
  assert.ok(await h.store.beginGroupDispatch(claimed, { at, sha256: hash('部署前已尝试派发'), nextCheckAt: at + 5000 }, () => true))
  h.at = at + COMMITMENT_LEASE_MS + 1
  await h.host.start()
  await waitFor(async () => (await h.store.getCommitment(claimed.id)).status === 'completed', 'pre-restart dispatch confirmed')
  assert.deepEqual(attempts, [{ sha256: hash('部署前已尝试派发'), from: at, until: at + 60_000 }])
  assert.equal((await h.store.getCommitment(claimed.id)).groupDispatch.messageId, '870004000')
  assert.deepEqual(h.sent, [])
})
