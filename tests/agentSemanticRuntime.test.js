import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentBindingDirectory, createAgentRuntime } from '../dist/backend/core/index.js'
import { createAgentSemanticMemoryStore, agentSemanticMemoryId } from '../dist/backend/modules/memory/infrastructure/agentSemanticMemoryStore.js'
import { createConversationMemoryStore, conversationMemoryId } from '../dist/backend/modules/memory/infrastructure/conversationMemoryStore.js'
import { createAgentInbox } from '../dist/backend/modules/runtime/infrastructure/agentInbox.js'
import { createModelExecutor } from '../dist/backend/modules/models/application/modelExecution.js'
import { agentBindingToken, agentPersonaScopeId, platformAccountKey } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { createDefaultSimSession } from '../dist/backend/modules/simulation/domain/simConfig.js'
import { createSimulationRuntime } from '../dist/backend/modules/simulation/infrastructure/simulationRuntime.js'
import { simulationAddressKey } from '../dist/backend/modules/simulation/infrastructure/simulationAddress.js'
import { simulationSessionKey } from '../dist/backend/modules/simulation/infrastructure/simSessionStore.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const redisTest = { skip: !redisAvailable, timeout: 20_000 }
const account = { platform: 'qq', namespace: 'global', id: '90001' }
const author = { ...account, id: '10001' }
const group = { account, kind: 'group', id: '20001' }
const friend = { account, kind: 'private', id: author.id }
const logger = { info() {}, warn() {}, error() {} }
const providerId = 'a'.repeat(64)
const projectionText = '语义召回专用标记：以前在雨天参加过陶艺课程'
const replyText = '语义派生回复专用标记：那次雨天的陶艺课程很有意思。'
const section = () => ({ enabled: true, allGroups: true,
  reflection: { enabled: false }, rhythm: { enabled: false }, mood: { enabled: false },
  personProfile: { enabled: false }, meme: { enabled: false }, userStyle: { enabled: false }, lifeThreads: { enabled: false },
  wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000,
    triggers: { question: false, nameMention: false, anyMessage: false } },
  turn: { minSendGapMs: 0, maxTurnsPerDay: 1000 },
})
function directory() {
  return createAgentBindingDirectory({ version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'fixture', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: [group, friend].map(target => ({ connectionId: 'fixture', kind: target.kind, conversationId: target.id, agentId: 'daily' })),
  }, 'semantic-runtime-v1')
}
function persona(binding) {
  return { binding, personaId: agentPersonaScopeId(binding.agentId), persona: { name: '验收角色' }, systemContent: '固定身份' }
}
async function waitFor(probe, label) {
  const until = performance.now() + 6000
  while (performance.now() < until) {
    const result = await probe()
    if (result) return result
    await delay(10)
  }
  assert.fail(`timed out waiting for ${label}`)
}
function finish(reply = replyText) {
  return { choices: [{ message: { content: '', tool_calls: [{ id: 'semantic-finish', type: 'function', function: {
    name: 'simFinishTurn', arguments: JSON.stringify({ choice: 'chat', reason: '接着当前话题回复', messages: [reply] }),
  } }] } }] }
}

async function simulation(t, name, overrides = {}) {
  const f = await createAgentRedisFixture(t, name)
  const at = Date.now(), binding = directory().resolve(group), address = simulationAddressKey(group)
  const sessionKey = simulationSessionKey(address)
  const messages = ['陶艺课程后来怎么样了', '想起那天一起聊的话题'].map((text, index) => ({
    seq: index + 1, messageId: `unread-${index + 1}`, userId: author.id, name: '来源作者', text, at,
    atSelf: false, quoteToSelf: false, imageCount: 0, kind: 'text',
  }))
  const state = { ...createDefaultSimSession(at), botId: account.id, personaId: agentPersonaScopeId(binding.agentId),
    bindingToken: agentBindingToken(binding), bootstrapSent: true, seq: 2, unread: messages, recent: messages,
    lastIncomingAt: at, ...(overrides.durableIngress === false
      ? { pendingWakeReasons: [{ kind: 'session', seq: 2 }] }
      : { queuedIngressWake: { kind: 'session', seq: 2 } }),
    nextProactiveCheckAt: at + 86_400_000, nextReplyCheckAt: at + 86_400_000,
  }
  await f.storage.set(sessionKey, JSON.stringify(state))
  await f.storage.set('shiloh:sim:known', JSON.stringify([address]))
  const controller = new AbortController(), requests = [], deliveries = [], recalls = [], episodes = [], learning = [], diagnostics = []
  const persisted = []
  const storage = { ...f.storage, async set(key, value, options) {
    if (key === sessionKey) persisted.push(JSON.parse(value))
    return f.storage.set(key, value, options)
  } }
  const released = Promise.withResolvers()
  let settled = false
  void released.promise.then(() => { settled = true })
  const runtime = createSimulationRuntime({ redis: storage, logger: {
    info: text => diagnostics.push(text), warn: text => diagnostics.push(text), error: (...args) => diagnostics.push(args.map(String).join(' ')),
  }, now: () => at, durableIngress: true,
    getSection: section, getExecutionConfig: () => ({}), getSelf: () => ({ id: account.id, name: '验收角色' }),
    getPersona: () => persona(binding), handlesTarget: () => true, isAccountReady: () => true,
    async beginMemoryTurn() { return { signal: controller.signal, isCurrent: () => !controller.signal.aborted, release: released.resolve } },
    async readSemanticMemory(...args) { recalls.push(args); return { text: projectionText, isCurrent: async () => true } },
    async YTapi(request) { requests.push(structuredClone(request)); return finish() },
    messageActions: { async send(action, guard) {
      if (!guard.isCurrent()) return { state: 'failed', code: 'stale' }
      deliveries.push(action); return { state: 'sent', messageId: 'confirmed-semantic-reply' }
    } },
    recordEpisode: async input => { episodes.push(input) }, recordGroupReply: async (...args) => { learning.push(args) },
    ...overrides,
  })
  t.after(async () => { runtime.stop(); await runtime.drain() })
  return { ...f, runtime, requests, deliveries, recalls, episodes, learning, controller, released, persisted,
    session: async () => JSON.parse(await f.storage.get(sessionKey)),
    async run() {
      await runtime.sweepOnce()
      try { await waitFor(() => settled, 'semantic simulation turn') }
      catch (error) { throw new Error(`${error.message}: ${JSON.stringify(diagnostics)}`) }
      await runtime.drain()
    },
  }
}

test('simulation session recall receives the complete address, memory-turn signal and unread exclusions, and keeps projection and reply ephemeral', redisTest, async t => {
  const f = await simulation(t, 'semantic-simulation-live')
  await f.run()
  assert.equal(f.recalls.length, 1)
  const [target, query, current, signal, excluded] = f.recalls[0]
  assert.deepEqual(target, group)
  assert.notEqual(target, simulationAddressKey(group))
  assert.match(query, /陶艺课程/u)
  assert.equal(signal, f.controller.signal)
  assert.deepEqual(excluded, ['unread-1', 'unread-2'])
  assert.equal(typeof current, 'function')
  assert.equal(f.requests.length, 1)
  assert.ok(f.requests[0].messages.some(row => row.role === 'user' && String(row.content).includes(projectionText)))
  assert.equal(f.requests[0].messages.some(row => row.role === 'system' && String(row.content).includes(projectionText)), false)
  assert.equal(f.deliveries.length, 1)
  assert.ok(JSON.stringify(f.deliveries).includes(replyText))
  const state = await f.session()
  assert.ok(state.agentHistory.length > 0)
  assert.doesNotMatch(JSON.stringify(state.agentHistory), /语义召回专用标记|语义派生回复专用标记/u)
  assert.equal(state.lastConfirmedChat, undefined)
  assert.ok(f.persisted.length > 0)
  for (const written of f.persisted) {
    assert.doesNotMatch(JSON.stringify(written.agentHistory), /语义召回专用标记|语义派生回复专用标记/u)
    assert.equal(written.lastConfirmedChat, undefined)
  }
  assert.deepEqual(f.episodes, [])
  assert.deepEqual(f.learning, [])
})

test('durable and non-durable simulation projections block stale model calls and sends after source revocation', redisTest, async t => {
  for (const durableIngress of [true, false]) for (const phase of ['before-model', 'before-send']) {
    let live = phase !== 'before-model', models = 0, sends = 0
    const f = await simulation(t, `semantic-simulation-${durableIngress}-${phase}`, {
      durableIngress,
      async readSemanticMemory() { return { text: projectionText, isCurrent: async () => live } },
      async YTapi() { models++; live = false; return finish() },
      messageActions: { async send() { sends++; return { state: 'sent', messageId: 'must-not-send' } } },
    })
    await f.run()
    assert.equal(models, phase === 'before-model' ? 0 : 1, phase)
    assert.equal(sends, 0, phase)
    const state = await f.session()
    assert.doesNotMatch(JSON.stringify(state.agentHistory), /语义召回专用标记|语义派生回复专用标记/u)
    assert.equal(state.lastConfirmedChat, undefined)
    assert.deepEqual(f.episodes, [])
    assert.deepEqual(f.learning, [])
  }
})

test('Simulation passes semantic authority into the consistency reviewer so a compatibility retry cannot resend revoked derived content', redisTest, async t => {
  let live = true
  const reviews = [], providerCalls = []
  const execution = { providers: 'oneapi', chatAiConfig: {
    chatApiUrl: 'https://review.invalid/v1', chatApiModel: 'review', chatApiKey: 'fixture-review',
  } }
  const { YTapi } = createModelExecutor({
    logger, resolveChatCompletionUrl: url => `${url}/chat/completions`,
    removeToolPromptsFromMessages: messages => messages,
    summarizeToolResultForAgent: () => '', shouldAcceptPlannerTextResponse: () => false,
    resolveAgentBackend: config => ({ apiUrl: config.chatAiConfig.chatApiUrl, model: config.chatAiConfig.chatApiModel, apiKey: config.chatAiConfig.chatApiKey }),
    async fetch(url, init) {
      providerCalls.push({ url, payload: JSON.parse(init.body) })
      live = false
      return new Response('unsupported max_tokens', { status: 400 })
    },
  })
  const f = await simulation(t, 'semantic-review-dispatch-authority', {
    getSection: () => ({ ...section(), consistency: { enabled: true } }),
    async readSemanticMemory() { return { text: projectionText, isCurrent: async () => live } },
    async reviewCharacter(request, _config, signal, isCurrent, ensureCurrent) {
      reviews.push({ request, signal, isCurrent, ensureCurrent })
      return YTapi(request, execution, undefined, undefined, {
        signal, isCurrent, ensureCurrent, generation: { maxOutputTokens: 900 },
      })
    },
  })
  await f.run()
  assert.equal(reviews.length, 1)
  assert.equal(typeof reviews[0].ensureCurrent, 'function')
  assert.equal(providerCalls.length, 1)
  assert.ok(JSON.stringify(providerCalls[0].payload.messages).includes(replyText))
  assert.deepEqual(f.deliveries, [])
  assert.deepEqual(f.episodes, [])
  assert.deepEqual(f.learning, [])
  assert.doesNotMatch(JSON.stringify((await f.session()).agentHistory), /语义召回专用标记|语义派生回复专用标记/u)
})

async function core(t, name, model = async () => ({ choices: [{ message: { content: replyText } }] })) {
  const f = await createAgentRedisFixture(t, name), bindings = directory()
  const requests = [], deliveries = [], embeddings = []
  let receive, ready = false
  const adapter = { id: 'fixture', account, botUserId: account.id, botName: '验收角色',
    resolvePrivatePeer: () => author,
    async start(handler) { receive = handler; ready = true }, isReady: () => ready, stop() { ready = false },
    actions: { async send(action, guard) {
      if (!guard.isCurrent()) return { state: 'failed', code: 'stale' }
      deliveries.push(action); return { state: 'sent', messageId: `sent-${deliveries.length}` }
    } },
  }
  const semantic = createAgentSemanticMemoryStore(f.storage)
  for (const target of [group, friend]) {
    const scope = { agentId: 'daily', target }, id = agentSemanticMemoryId(scope)
    await semantic.update(id, () => ({ version: 1, id, scope, rows: [{
      messageId: `historical-${target.kind}`, authorId: author.id, name: '来源作者', text: projectionText, at: Date.now() - 86_400_000,
      vector: [1, 0], providerId, ...(target.kind === 'private' ? { peerId: author.id } : {}),
    }] }))
  }
  const runtime = createAgentRuntime({ storage: f.storage, adapters: [adapter], logger, isExecutionCurrent: f.isCurrent,
    privateChatEnabled: true, useTextGroup: () => true, getSection: section, getExecutionConfig: () => ({}),
    midtermMemory: { enabled: false }, episodicMemory: { enabled: true },
    semanticMemory: { enabled: true, minScore: 0, timeoutMs: 5000 },
    semanticMemoryBackend: { id: providerId, async embed(texts, context) {
      embeddings.push({ texts: [...texts], context }); return texts.map(() => [1, 0])
    } },
    resolvePersona(target) { const binding = bindings.resolve(target); return binding && persona(binding) },
    async YTapi(request, _config, signal) { requests.push(structuredClone(request)); return model(request, signal) },
  })
  t.after(() => runtime.stop())
  await runtime.start()
  const inbox = createAgentInbox(f.storage), history = createConversationMemoryStore(f.storage)
  return { ...f, runtime, requests, deliveries, embeddings, inbox,
    emit: event => receive(event),
    send: (target, messageId) => receive({ kind: 'message', message: {
      version: 1, conversation: target, messageId, sender: author, senderName: '来源作者', occurredAt: Date.now(),
      text: '那次陶艺课程后来怎样', parts: [{ kind: 'text', text: '那次陶艺课程后来怎样' }], mentions: [], directedToAccount: true,
    } }),
    memory: target => history.load(conversationMemoryId(bindings.resolve(target))),
  }
}

test('Core text-group and private replies use semantic user data without retaining derived text history or episodes', redisTest, async t => {
  const f = await core(t, 'semantic-core-retention')
  for (const target of [group, friend]) {
    const before = f.requests.length
    await f.send(target, `query-${target.kind}`)
    const saved = await waitFor(() => f.inbox.loadTextHistory(target), `${target.kind} text history settled`)
    assert.deepEqual(saved.turns, [])
    assert.equal(f.deliveries.length, before + 1)
    const request = f.requests[before]
    assert.ok(request.messages.some(row => row.role === 'user' && String(row.content).includes(projectionText)))
    assert.equal(request.messages.some(row => row.role === 'system' && String(row.content).includes(projectionText)), false)
    const memory = await f.memory(target)
    assert.deepEqual(memory.episodes, [])
    assert.equal(memory.records.some(row => row.text.includes(replyText)), false)
    const queryEmbedding = f.embeddings.find(row => row.texts.length === 1 && row.texts[0] === '那次陶艺课程后来怎样' && row.context.target.kind === target.kind)
    assert.ok(queryEmbedding)
    assert.deepEqual(queryEmbedding.context.target, target)
  }
})

test('Core recall of a semantic source during group-text or private model work prevents the in-flight reply', redisTest, async t => {
  for (const target of [group, friend]) {
    const entered = Promise.withResolvers(), release = Promise.withResolvers(), completed = Promise.withResolvers()
    const f = await core(t, `semantic-core-recall-${target.kind}`, async request => {
      assert.ok(JSON.stringify(request.messages).includes(projectionText))
      entered.resolve(); await release.promise
      completed.resolve(); return { choices: [{ message: { content: replyText } }] }
    })
    await f.send(target, `inflight-${target.kind}`)
    await entered.promise
    await f.emit({ kind: 'recall', target, messageId: `historical-${target.kind}` })
    release.resolve()
    await completed.promise
    await f.runtime.resumePendingWork()
    const mode = target.kind === 'private' ? 'private' : 'group-text'
    await waitFor(async () => await f.reader.lLen(f.prefix + `agent:inbox:${mode}:${platformAccountKey(target.account)}`) === 0, 'recalled turn inbox drained')
    assert.deepEqual(f.deliveries, [])
    const history = await f.inbox.loadTextHistory(target)
    assert.ok(!history || history.turns.length === 0)
    assert.deepEqual((await f.memory(target))?.episodes ?? [], [])
  }
})
