import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { createAgentRuntime } = await load('core/agentRuntime.js')
const { createAgentBindingDirectory, agentBindingToken, agentPersonaScopeId, conversationAddressKey, platformAccountKey } = await load('modules/runtime/domain/agentBindings.js')
const { createAgentInbox } = await load('modules/runtime/infrastructure/agentInbox.js')
const { createAgentDiagnostics } = await load('modules/runtime/infrastructure/agentDiagnostics.js')
const { createAgentOutboundMessages } = await load('modules/runtime/infrastructure/agentOutboundMessages.js')
const { createDefaultSimSession } = await load('modules/simulation/domain/simConfig.js')
const { simulationAddressKey } = await load('modules/simulation/infrastructure/simulationAddress.js')
const { simulationSessionKey, simulationBusyKey } = await load('modules/simulation/infrastructure/simSessionStore.js')
const redisTest = { skip: !redisAvailable, timeout: 20_000 }
const interactionNames = ['pokeTool', 'likeTool', 'reactionTool', 'recallTool']
const names = request => request.tools?.map(tool => tool.function.name) ?? []
const call = (name, args = {}) => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [
  { id: name + '-call', type: 'function', function: { name, arguments: JSON.stringify(args) } },
] } }] })
const answer = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const finish = () => call('simFinishTurn', { choice: 'silent', reason: '自有消息撤回验证结束' })
const key = (target, id) => JSON.stringify([conversationAddressKey(target), id])
const deferred = () => Promise.withResolvers()
const details = f => JSON.stringify({ requests: f.requests.length, reads: f.reads.map(read => read.id), ownReads: f.ownReads.map(read => read.id),
  interactions: f.events.filter(event => event.operation === 'interaction'), lastModelInput: f.requests.at(-1)?.messages.filter(message => message.role === 'user') })
async function assertSettlement(f, state, completed) {
  const keys = await f.reader.keys(f.prefix + 'agent:interaction:v1:*')
  assert.equal(keys.length, 1)
  const saved = JSON.parse(await f.reader.get(keys[0]))
  assert.deepEqual({ state: saved.state, completed: saved.completed, requested: saved.requested }, { state, completed, requested: 1 })
}
let fixtureId = 0
async function waitFor(probe, detail = () => '') {
  const until = performance.now() + 7000
  while (performance.now() < until) { if (await probe()) return; await delay(10) }
  assert.fail('private interaction fixture did not settle: ' + detail())
}

async function fixture(t, settings = {}) {
  let host, f
  t.after(async () => { settings.release?.(); await host?.stop() })
  const redis = await createAgentRedisFixture(t, 'private-interaction-core'), inbox = createAgentInbox(redis.storage), outbound = createAgentOutboundMessages(redis.storage)
  const account = { platform: 'fixture', namespace: 'private-interactions-' + ++fixtureId, id: 'robot' }
  const peer = { ...account, id: 'verified-friend' }, otherPeer = { ...account, id: 'other-friend' }
  // Conversation IDs deliberately differ from verified peer IDs.
  const target = { account, kind: 'private', id: 'conversation-one' }, otherTarget = { ...target, id: 'conversation-two' }
  const group = { account, kind: 'group', id: 'group-room' }
  const config = { version: 1, agents: [{ id: 'role', personaId: 'default' }, { id: 'replacement', personaId: 'default' }],
    connections: [{ id: 'connection', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: [target, otherTarget, group].map(address => ({ connectionId: 'connection', kind: address.kind, conversationId: address.id, agentId: 'role' })) }
  let directory = createAgentBindingDirectory(config, 'private-interactions-initial'), accept, ready = false, enabled = true, sequence = 0, clock = Date.now()
  const peers = new Map([[conversationAddressKey(target), peer], [conversationAddressKey(otherTarget), otherPeer], [conversationAddressKey(group), peer]])
  const sources = new Map(), ownMessages = new Map(), requests = [], sends = [], confirmed = [], attempts = [], effects = [], reads = [], ownReads = [], events = [], logs = []
  const logger = { info: line => logs.push(line), warn: line => logs.push(line), error: line => logs.push(line) }
  const diagnostics = createAgentDiagnostics({ logger, now: () => clock, sink: { async append(event) { events.push(event); return true } } })
  const queueKeys = ['private', 'privacy', 'simulation', 'group-text', 'group-log'].map(kind => redis.prefix + `agent:inbox:${kind}:${platformAccountKey(account)}`)
  if (settings.simulation) {
    const initial = createDefaultSimSession(clock), binding = directory.resolve(group)
    initial.bootstrapSent = true; initial.botId = account.id; initial.bindingToken = agentBindingToken(binding); initial.personaId = agentPersonaScopeId(binding.agentId)
    initial.nextProactiveCheckAt = clock + 86_400_000
    initial.wakeConfig.triggers = { ...initial.wakeConfig.triggers, probability: 0, question: false, nameMention: false, anyMessage: false }
    await redis.storage.set(simulationSessionKey(simulationAddressKey(group)), JSON.stringify(initial))
  }
  function makeHost() {
    return createAgentRuntime({ storage: redis.storage, isExecutionCurrent: redis.isCurrent, now: () => clock, diagnostics,
      privateChatEnabled: true, interactions: { enabled: settings.enabled !== false }, isInteractionsCurrent: () => enabled,
      useTextGroup: address => address.kind === 'group' && !settings.simulation,
      ...(settings.tools === undefined ? {} : { privateTextTools: settings.tools }),
      groupTextTools: () => settings.groupTools ?? ['pokeTool', 'likeTool', 'reactionTool'],
      logger,
      adapters: [{ id: 'connection', account, botUserId: account.id, botName: '私聊互动验证', isReady: () => ready,
        async start(consume) { accept = consume; ready = true }, stop() { ready = false },
        resolvePrivatePeer(address) { return peers.get(conversationAddressKey(address)) },
        async readMessage(address, id, guard) {
          reads.push({ target: structuredClone(address), id }); await settings.read?.(address, id, guard, f)
          return guard?.isCurrent?.() === false ? undefined : structuredClone(sources.get(key(address, id)))
        },
        ...(settings.ownPort === false ? {} : { async readOwnMessage(address, id, guard) {
          ownReads.push({ target: structuredClone(address), id, guard }); await settings.ownRead?.(address, id, guard, f)
          return guard?.isCurrent?.() === false ? undefined : structuredClone(ownMessages.get(key(address, id)))
        } }),
        async readConversationMember() { assert.fail('friend-private interaction must not borrow group membership') },
        async listConversationMembers() { assert.fail('friend-private interaction must not list an unrelated group') },
        actions: {
          async send(action, guard) {
            if (!guard?.isCurrent?.()) return { state: 'failed', code: 'stale' }
            sends.push(structuredClone(action))
            const receipt = settings.send ? await settings.send(action, guard, f) : { state: 'sent', messageId: 'outbound-' + ++sequence }
            if (receipt.state === 'sent' && typeof receipt.messageId === 'string') {
              confirmed.push({ action: structuredClone(action), messageId: receipt.messageId })
              ownMessages.set(key(action.target, receipt.messageId), { conversation: structuredClone(action.target), messageId: receipt.messageId, author: { ...account }, occurredAt: clock })
            }
            return receipt
          },
          ...(settings.port === false ? {} : { async interact(action, guard) {
            attempts.push({ action: structuredClone(action), guard })
            if (settings.interact) return settings.interact(action, guard, f)
            await guard.ensureCurrent?.()
            if (!guard.isCurrent() || guard.signal?.aborted) return { state: 'failed', code: 'stale' }
            effects.push(structuredClone(action)); return settings.receipt ?? { state: 'confirmed' }
          } }),
        },
      }],
      resolvePersona(address) { const binding = directory.resolve(address); return binding && { binding, persona: { name: '私聊角色' }, systemContent: '好友私聊测试' } },
      getSection: () => ({ enabled: true, allGroups: true, reflection: { enabled: false }, consistency: { enabled: false }, wakeGate: { enabled: false }, rhythm: { enabled: false }, mood: { enabled: false },
        personProfile: { enabled: false }, meme: { enabled: false }, userStyle: { enabled: false }, lifeThreads: { enabled: false },
        wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000 }, turn: { minSendGapMs: 0, maxTurnsPerDay: 1000, maxToolRounds: 5, maxSendsPerTurn: 3 },
        toolPolicy: { mode: 'open', ...(settings.simulationAllow ? { allowTools: ['recallTool'] } : {}) } }),
      getExecutionConfig: () => ({ providers: 'openai', useTools: true }),
      async YTapi(request, _config, signal, current, ensureCurrent) {
        await ensureCurrent?.(); if (signal?.aborted || current?.() === false) throw Error('stale private fixture model')
        requests.push(structuredClone(request))
        return settings.model ? settings.model(request, requests.length, f) : answer('已确认的普通私聊文字')
      },
    })
  }
  f = { ...redis, inbox, outbound, account, peer, otherPeer, target, otherTarget, group, sources, ownMessages, requests, sends, confirmed, attempts, effects, reads, ownReads, events, logs,
    get host() { return host }, binding: (address = target) => directory.resolve(address), disable() { enabled = false },
    rebind() { directory = createAgentBindingDirectory({ ...config, bindings: config.bindings.map(binding => ({ ...binding, agentId: 'replacement' })) }, 'private-interactions-rebound') },
    replacePeer() { peers.set(conversationAddressKey(target), otherPeer) },
    message(text = '请给我点赞', extra = {}) {
      const address = extra.conversation ?? target
      return { version: 1, conversation: address, sender: peers.get(conversationAddressKey(address)), messageId: 'human-' + ++sequence, occurredAt: ++clock,
        text, parts: [{ kind: 'text', text }], mentions: [], directedToAccount: true, ...extra }
    },
    async emit(message) { sources.set(key(message.conversation, message.messageId), structuredClone(message)); await accept({ kind: 'message', message: structuredClone(message) }) },
    async recall(address, id) { sources.delete(key(address, id)); await accept({ kind: 'recall', target: address, messageId: id }) },
    async drained() {
      await waitFor(async () => Number(await redis.reader.eval("local total=0;for _,key in ipairs(KEYS) do total=total+redis.call('LLEN',key) end;return total", { keys: queueKeys, arguments: [] })) === 0, () => logs.join('\n'))
      await host.runtime.drain()
      if (settings.simulation) await waitFor(async () => !await redis.reader.exists(redis.prefix + simulationBusyKey(simulationAddressKey(group))), () => logs.join('\n'))
    },
    async send(text, extra) {
      const before = requests.length, message = f.message(text, extra); await f.emit(message)
      if (settings.simulation && message.conversation.kind === 'group') await waitFor(() => requests.length > before, () => logs.join('\n'))
      await f.drained(); return message
    },
    async restart() { await host.stop(); host = makeHost(); await host.start() },
    async seedOutbound(address = target) {
      await f.send('请普通回复这一条', { conversation: address })
      const sent = confirmed.at(-1); assert.ok(sent, 'the seed must have a real Core confirmed text receipt')
      assert.deepEqual(sent.action.target, address); return sent.messageId
    },
    quote(id) { return { quote: { messageId: id, author: account, parts: [] } } },
  }
  host = makeHost(); await host.start(); return f
}

test('private Core declares no interaction tools by default despite group interaction authorization', redisTest, async t => {
  const f = await fixture(t); await f.send('普通私聊')
  assert.equal(names(f.requests[0]).some(name => interactionNames.includes(name)), false)
  assert.equal(f.attempts.length, 0)
})

test('private Core explicit authorization declares only like and recall, never group poke or reaction', redisTest, async t => {
  const f = await fixture(t, { tools: ['likeTool', 'recallTool'] }); await f.send('普通私聊')
  assert.deepEqual(names(f.requests[0]).filter(name => interactionNames.includes(name)).sort(), ['likeTool', 'recallTool'])
})

for (const settings of [{ enabled: false }, { port: false }]) test(`private Core missing interaction capability ${JSON.stringify(settings)} declares no interaction tool`, redisTest, async t => {
  const f = await fixture(t, { tools: ['likeTool', 'recallTool'], ...settings }); await f.send('普通私聊')
  assert.equal(names(f.requests[0]).some(name => interactionNames.includes(name)), false); assert.equal(f.attempts.length, 0)
})

test('private Core without readOwnMessage declares profile like but never offers recall', redisTest, async t => {
  const f = await fixture(t, { tools: ['likeTool', 'recallTool'], ownPort: false }); await f.send('普通私聊')
  assert.deepEqual(names(f.requests[0]).filter(name => interactionNames.includes(name)), ['likeTool'])
})

test('private Core profile like defaults to ten and targets the verified peer instead of its opaque conversation ID', redisTest, async t => {
  const f = await fixture(t, { tools: ['likeTool'], model: () => call('likeTool') })
  await f.send('请给我的资料点赞')
  assert.equal(f.effects.length, 1, details(f)); assert.equal(f.requests.length, 1); assert.equal(f.sends.length, 0)
  assert.deepEqual(f.effects[0], { version: 1, kind: 'conversation.interact', target: f.target, binding: f.binding(), interaction: { kind: 'profile-like', user: f.peer, count: 10 } })
  await assertSettlement(f, 'confirmed', 1)
})

test('private Core rejects a model-selected profile-like target outside the current verified peer', redisTest, async t => {
  const f = await fixture(t, { tools: ['likeTool'], model: () => call('likeTool', { qq: 'other-friend', count: 2 }) })
  await f.send('给 other-friend 点两个赞')
  assert.equal(f.attempts.length, 0); assert.equal(f.effects.length, 0)
})

test('private Core recalls its confirmed outbound text through a fresh own-message proof with no new text or replay after restart', redisTest, async t => {
  const f = await fixture(t, { tools: ['recallTool'], model: (_request, index) => index === 1 ? answer('只属于本会话的确收文字') : call('recallTool') })
  const id = await f.seedOutbound(), beforeHistory = await f.inbox.loadTextHistory(f.target)
  assert.equal(await f.outbound.owns(f.binding(), id), true)
  const ledgerKeys = await f.reader.keys(f.prefix + 'agent:outbound:v1:*')
  assert.equal(ledgerKeys.length, 1); assert.ok(await f.reader.pTTL(ledgerKeys[0]) > 6 * 86_400_000)
  assert.ok(beforeHistory?.turns.some(turn => turn.reply === '只属于本会话的确收文字'))
  const original = await f.send('撤回你刚才这条消息', f.quote(id))
  assert.equal(f.effects.length, 1, details(f)); assert.equal(f.requests.length, 2); assert.equal(f.sends.length, 1)
  assert.deepEqual(f.effects[0], { version: 1, kind: 'conversation.interact', target: f.target, binding: f.binding(), interaction: { kind: 'message-recall', messageId: id } })
  assert.ok(f.ownReads.some(read => read.id === id && conversationAddressKey(read.target) === conversationAddressKey(f.target)))
  assert.equal(await f.inbox.isRecalled(f.target, id), true, 'confirmation must use the existing recall invalidation chain')
  assert.equal(await f.inbox.loadTextHistory(f.target), undefined)
  await assertSettlement(f, 'confirmed', 1)
  await f.emit(original); await f.drained(); await f.restart(); await f.emit(original); await f.drained()
  assert.equal(f.effects.length, 1); assert.equal(f.attempts.length, 1); assert.equal(f.requests.length, 2); assert.equal(f.sends.length, 1)
})

for (const denied of ['human', 'unrecorded-bot', 'unknown-outbound', 'other-binding', 'other-conversation']) {
  test(`private Core refuses ${denied} recall even if the model supplies a real-looking native message ID`, redisTest, async t => {
    let recall = false
    const f = await fixture(t, { tools: ['recallTool'], model: () => recall ? call('recallTool') : answer('账本隔离种子'),
      ...(denied === 'unknown-outbound' ? { async send() { return { state: 'unknown' } } } : {}),
    })
    let id
    if (denied === 'human') {
      const original = await f.send('真人的普通发言'); id = original.messageId
      f.ownMessages.set(key(f.target, id), { conversation: f.target, messageId: id, author: f.peer, occurredAt: original.occurredAt })
    } else if (denied === 'unrecorded-bot') {
      id = 'external-bot-outbound'; f.ownMessages.set(key(f.target, id), { conversation: f.target, messageId: id, author: f.account, occurredAt: Date.now() })
    } else if (denied === 'unknown-outbound') {
      await f.send('发送结果未知的原话'); id = 'unconfirmed-native-outbound'
      f.ownMessages.set(key(f.target, id), { conversation: f.target, messageId: id, author: f.account, occurredAt: Date.now() })
    } else {
      id = await f.seedOutbound(denied === 'other-conversation' ? f.otherTarget : f.target)
      if (denied === 'other-binding') f.rebind()
      else f.ownMessages.set(key(f.target, id), { conversation: f.target, messageId: id, author: f.account, occurredAt: Date.now() })
    }
    recall = true; await f.send('撤回你这条消息', f.quote(id))
    assert.equal(f.attempts.length, 0); assert.equal(f.effects.length, 0)
    assert.equal(await f.outbound.owns(f.binding(), id), false)
    assert.equal(await f.inbox.isRecalled(f.target, id), false)
  })
}

test('private Core unknown recall freezes its command across restart and preserves previously confirmed text history', redisTest, async t => {
  const f = await fixture(t, { tools: ['recallTool'], receipt: { state: 'unknown' }, model: (_request, index) => index === 1 ? answer('未知撤回时仍保留的确收文字') : call('recallTool') })
  const id = await f.seedOutbound(), history = await f.inbox.loadTextHistory(f.target)
  const original = await f.send('撤回你这条消息', f.quote(id))
  assert.equal(f.effects.length, 1); assert.equal(f.requests.length, 2); assert.equal(f.sends.length, 1)
  assert.equal(await f.inbox.isRecalled(f.target, id), false)
  assert.equal(await f.outbound.owns(f.binding(), id), true)
  assert.deepEqual(await f.inbox.loadTextHistory(f.target), history)
  await assertSettlement(f, 'unknown', 0)
  await f.emit(original); await f.drained(); await f.restart(); await f.emit(original); await f.drained()
  assert.equal(f.attempts.length, 1); assert.equal(f.effects.length, 1); assert.equal(f.requests.length, 2); assert.equal(f.sends.length, 1)
  assert.deepEqual(await f.inbox.loadTextHistory(f.target), history)
})

for (const revoke of ['config', 'binding', 'peer', 'trigger-recall', 'outbound-recall']) {
  test(`private Core ${revoke} revocation during fresh own-message proof prevents native recall`, redisTest, async t => {
    const entered = deferred(), held = deferred(); let checking = false
    const f = await fixture(t, { tools: ['recallTool'], release() { held.resolve() },
      model: (_request, index) => index === 1 ? answer('即将测试撤回权限的确收文字') : call('recallTool'),
      async ownRead() { if (checking) { entered.resolve(); await held.promise } },
    })
    const id = await f.seedOutbound(); checking = true
    const trigger = f.message('撤回你这条消息', f.quote(id)); await f.emit(trigger)
    await waitFor(() => f.ownReads.length > 0, () => JSON.stringify({ requests: f.requests.length, effects: f.effects.length, logs: f.logs })); await entered.promise
    if (revoke === 'config') f.disable(); else if (revoke === 'binding') f.rebind(); else if (revoke === 'peer') f.replacePeer()
    else await f.recall(f.target, revoke === 'trigger-recall' ? trigger.messageId : id)
    held.resolve(); await f.drained()
    assert.equal(f.attempts.length, 0); assert.equal(f.effects.length, 0)
    assert.equal(f.requests.length, 2); assert.equal(f.sends.length, 1)
  })
}

test('group text Core recalls only its own confirmed outbound message and invalidates the old history without another model call', redisTest, async t => {
  const f = await fixture(t, { groupTools: ['recallTool'], model: (_request, index) => index === 1 ? answer('普通群文字确收种子') : call('recallTool') })
  const id = await f.seedOutbound(f.group)
  assert.equal(await f.outbound.owns(f.binding(f.group), id), true)
  const original = await f.send('撤回你这条消息', { conversation: f.group, ...f.quote(id) })
  assert.equal(f.effects.length, 1); assert.equal(f.requests.length, 2); assert.equal(f.sends.length, 1)
  assert.deepEqual(f.effects[0].target, f.group); assert.deepEqual(f.effects[0].interaction, { kind: 'message-recall', messageId: id })
  assert.equal(await f.inbox.isRecalled(f.group, id), true); assert.equal(await f.inbox.loadTextHistory(f.group), undefined)
  await assertSettlement(f, 'confirmed', 1)
  await f.emit(original); await f.drained(); await f.restart(); await f.emit(original); await f.drained()
  assert.equal(f.attempts.length, 1); assert.equal(f.effects.length, 1); assert.equal(f.requests.length, 2); assert.equal(f.sends.length, 1)
})

test('simulation keeps own-message recall restricted by default', redisTest, async t => {
  const f = await fixture(t, { simulation: true, model: () => finish() })
  await f.send('普通真人群消息', { conversation: f.group })
  assert.equal(names(f.requests[0]).includes('recallTool'), false); assert.equal(f.attempts.length, 0)
})

test('simulation explicit recall authorization confirms one self-recall and stops the turn before a follow-up model or text', redisTest, async t => {
  let recalling = false, id
  const f = await fixture(t, { simulation: true, simulationAllow: true, model: (_request, index) => !recalling
    ? index === 1 ? call('simSendMessage', { continuation: 'chat', messages: ['仿真普通群文字确收种子'] }) : finish()
    : call('recallTool', { message_id: id }),
  })
  id = await f.seedOutbound(f.group); const previousRequests = f.requests.length
  assert.equal(await f.outbound.owns(f.binding(f.group), id), true)
  recalling = true
  const original = await f.send('撤回你发出的消息 ' + id, { conversation: f.group })
  assert.equal(f.effects.length, 1); assert.equal(f.attempts.length, 1)
  assert.equal(f.requests.length, previousRequests + 1); assert.equal(f.sends.length, 1)
  assert.ok(names(f.requests.at(-1)).includes('recallTool'))
  assert.equal(await f.inbox.isRecalled(f.group, id), true)
  await assertSettlement(f, 'confirmed', 1)
  await f.emit(original); await f.drained(); await f.restart(); await f.emit(original); await f.drained()
  assert.equal(f.effects.length, 1); assert.equal(f.attempts.length, 1)
  assert.equal(f.requests.length, previousRequests + 1); assert.equal(f.sends.length, 1)
})
