import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentBindingDirectory, createAgentRuntime } from '../dist/backend/core/index.js'
import { createAgentHistoryStore, agentHistoryId } from '../dist/backend/modules/memory/infrastructure/agentHistoryStore.js'
import { createPersonMemoryStore } from '../dist/backend/modules/memory/infrastructure/personMemoryStore.js'
import { personMemoryAddress } from '../dist/backend/modules/memory/infrastructure/personMemoryContext.js'
import { createConversationMemoryStore, conversationMemoryId } from '../dist/backend/modules/memory/infrastructure/conversationMemoryStore.js'
import { agentBindingToken, agentPersonaScopeId, platformAccountKey } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { createDefaultSimSession } from '../dist/backend/modules/simulation/domain/simConfig.js'
import { characterKey } from '../dist/backend/modules/simulation/domain/characterState.js'
import { createSimulationRuntime } from '../dist/backend/modules/simulation/infrastructure/simulationRuntime.js'
import { simulationAddressKey } from '../dist/backend/modules/simulation/infrastructure/simulationAddress.js'
import { simulationBusyKey, simulationNotebookKey, simulationSessionKey } from '../dist/backend/modules/simulation/infrastructure/simSessionStore.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const redisTest = { skip: !redisAvailable, timeout: 30_000 }
const sourceMarker = '仅供历史查询的原始证据'
const derivedMarker = '历史查证后模型派生正文'
const reply = `${derivedMarker}：当时的预算尚待确认。`
const oldTexts = Array.from({ length: 3 }, (_, index) => `${sourceMarker}-${index}：${'这是以前说过的预算资料。'.repeat(140)}证据结尾-${index}`)
const query = { question: '查证我以前说过的话', source: 'recent', keywords: [], user_id: 'requester', limit: 20 }
const section = () => ({ enabled: true, reflection: { enabled: false }, rhythm: { enabled: false }, mood: { enabled: false },
  personProfile: { enabled: false }, meme: { enabled: false }, userStyle: { enabled: false }, lifeThreads: { enabled: false },
  wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000 },
  turn: { maxToolRounds: 10, minSendGapMs: 0, maxSendsPerTurn: 1 }, toolPolicy: { mode: 'open' } })
function call(name, args, id = name) {
  return { choices: [{ message: { content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }
}
const finish = () => call('simFinishTurn', { choice: 'chat', reason: reply, messages: [reply] })
function decodeHistory(content) {
  const value = JSON.parse(content)
  return value.kind === 'tool_outcome' ? JSON.parse(value.content) : value
}
async function waitFor(probe, label) {
  const until = performance.now() + 6500
  while (performance.now() < until) { const found = await probe(); if (found) return found; await delay(15) }
  assert.fail(typeof label === 'function' ? label() : label)
}
function historyResult(request) {
  const row = request.messages.findLast(message => message.role === 'tool' && message.name === 'chatHistoryTool')
  assert.ok(row, 'the real history tool response reaches the next model request')
  assert.ok(row.content.length > 4000, 'long evidence is not silently clipped at the generic 4000-character tool limit')
  const value = decodeHistory(row.content)
  assert.equal(value.status, 'found')
  assert.deepEqual(new Set(value.messages.map(message => message.message_id)), new Set(['old-0', 'old-1', 'old-2']))
  for (const [index, text] of oldTexts.entries()) assert.equal(value.messages.find(message => message.message_id === `old-${index}`).content, text)
  return value
}

async function fixture(t, options = {}) {
  const redis = await createAgentRedisFixture(t, 'history-runtime')
  const { reader, storage, prefix, isCurrent } = redis
  const account = { platform: 'fixture', namespace: 'history-tenant', id: 'robot' }
  const target = { account, kind: 'group', id: 'room' }, sender = { ...account, id: 'requester' }
  const config = { version: 1, agents: [{ id: 'role', personaId: 'default' }, { id: 'other', personaId: 'default' }],
    connections: [{ id: 'connection', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: [{ connectionId: 'connection', kind: 'group', conversationId: target.id, agentId: 'role' }] }
  let directory = createAgentBindingDirectory(config, 'initial'), accept, host, attempts = 0, terminal = false, secondSeen = false
  const now = Date.now(), key = simulationAddressKey(target), requests = [], sends = [], diagnostics = []
  const initialBinding = directory.resolve(target), address = personMemoryAddress(target)
  const identity = { botId: address.botId, personaId: agentPersonaScopeId(initialBinding.agentId) }
  const history = createAgentHistoryStore(storage), memory = createPersonMemoryStore({ redis: storage, now: () => now })
  const state = createDefaultSimSession(now)
  state.bootstrapSent = true; state.botId = account.id; state.personaId = identity.personaId; state.bindingToken = agentBindingToken(initialBinding)
  state.wakeConfig.triggers = { ...state.wakeConfig.triggers, probability: 0, question: false, nameMention: false, anyMessage: false }
  state.nextProactiveCheckAt = now + 86_400_000
  await storage.set(simulationSessionKey(key), JSON.stringify(state))
  const inboxKey = prefix + `agent:inbox:${options.text ? 'group-text' : 'simulation'}:${platformAccountKey(account)}`
  const f = { ...redis, account, target, sender, key, identity, address, initialBinding, history, memory, requests, sends, diagnostics,
    get host() { return host }, get attempts() { return attempts }, get terminal() { return terminal }, get secondSeen() { return secondSeen },
    binding: () => directory.resolve(target),
    rebind() { directory = createAgentBindingDirectory({ ...config, bindings: [{ ...config.bindings[0], agentId: 'other' }] }, 'replacement') },
    async revoke(messageId = 'old-0') { await memory.revokeSource({ identity, scene: address.scene, messageId }) },
    async recall(messageId = 'old-0') { await accept({ kind: 'recall', target, messageId }) },
    async emit(id, text, directed = false, at = now) {
      await accept({ kind: 'message', message: { version: 1, conversation: target, sender, senderName: '本人',
        messageId: id, occurredAt: at, text, parts: [{ kind: 'text', text }], mentions: directed ? [account] : [], directedToAccount: directed } })
    },
    async session() { return JSON.parse(await storage.get(simulationSessionKey(key))) },
    async idle() { return !await reader.exists(prefix + simulationBusyKey(key)) && !await reader.lLen(inboxKey) },
    async settled() { return terminal && await f.idle() },
    async wait() { await waitFor(f.settled, () => `history turn does not settle: ${diagnostics.join('|')}`); await host.runtime.drain() },
    async trigger() { await f.emit('trigger', '查证我以前说过的话', true) },
    async assertEphemeral() {
      const session = await f.session()
      assert.doesNotMatch(JSON.stringify(session.agentHistory), new RegExp(`${sourceMarker}|${derivedMarker}`))
      assert.equal(session.lastConfirmedChat, undefined)
      const character = JSON.parse(await storage.get(characterKey({ ...identity, groupId: address.scene.id })) || 'null')
      if (character) {
        assert.deepEqual(character.memories, []); assert.deepEqual(character.goals, [])
        assert.doesNotMatch(JSON.stringify(character), new RegExp(`${sourceMarker}|${derivedMarker}`))
        assert.equal(character.receipts.some(receipt => receipt.toolName === 'chatHistoryTool'), false)
      }
      const notebook = await storage.get(simulationNotebookKey(initialBinding))
      assert.doesNotMatch(notebook || '', new RegExp(`${sourceMarker}|${derivedMarker}`))
      const narrative = await createConversationMemoryStore(storage).load(conversationMemoryId(initialBinding))
      assert.deepEqual(narrative?.episodes ?? [], [])
      for (const redisKey of await reader.keys(prefix + '*')) {
        if (await reader.type(redisKey) !== 'string') continue
        assert.doesNotMatch(await reader.get(redisKey), new RegExp(derivedMarker), `derived evidence leaked to ${redisKey.slice(prefix.length)}`)
      }
    },
  }
  host = createAgentRuntime({ storage, isExecutionCurrent: isCurrent, now: () => now,
    history: { enabled: true, retentionDays: 30, maxMessagesPerConversation: 1000 },
    ...(options.text ? { useTextGroup: () => true } : {}),
    adapters: [{ id: 'connection', account, botUserId: account.id, botName: 'fixture', isReady: () => Boolean(accept),
      async start(consume) { accept = consume }, stop() {}, actions: { async send(action, guard) {
        if (!guard.isCurrent()) return { state: 'failed', code: 'cancelled' }
        sends.push(structuredClone(action)); return { state: 'sent', messageId: 'confirmed-history-reply' }
      } } }],
    logger: { info() {}, warn(text) { diagnostics.push(text) }, error(...args) { diagnostics.push(args.map(String).join(' ')) } },
    getSection: section, getExecutionConfig: () => ({ providers: 'openai', useTools: true }),
    resolvePersona(address) { const binding = directory.resolve(address); return binding && { binding, persona: { name: 'fixture' }, systemContent: '' } },
    async YTapi(request, _config, _signal, _current, ensureCurrent) {
      attempts++
      const hasHistory = request.messages.some(row => row.role === 'tool' && row.name === 'chatHistoryTool')
      if (hasHistory) {
        secondSeen = true
        if (options.beforeModel && attempts === 2) await options.beforeModel(f, request)
      }
      try { await ensureCurrent?.() } catch (error) { terminal = true; throw error }
      requests.push(structuredClone(request))
      if (requests.length === 1) return call('chatHistoryTool', query)
      if (options.beforeReply && requests.length === 2) await options.beforeReply(f, request)
      const result = options.script ? await options.script(f, requests.length, request) : options.text
        ? { choices: [{ message: { content: reply } }] } : finish()
      const name = result.choices?.[0]?.message?.tool_calls?.[0]?.function?.name
      if (name === 'simFinishTurn' && !options.script || options.text || options.terminalRound === requests.length) terminal = true
      return result
    },
  })
  t.after(async () => { await host.stop() })
  await host.start()
  for (const [index, text] of oldTexts.entries()) await f.emit(`old-${index}`, text, false, now - 60_000 + index)
  await waitFor(async () => (await history.read(agentHistoryId(initialBinding)))?.rows.length === 3 && await f.idle(), 'real Core history capture without a semantic backend')
  assert.equal(requests.length, 0, 'ordinary old sources do not wake the synthetic model')
  // Old evidence remains in the history store while the ordinary wake window has expired.
  const old = await f.session(); old.recent = []; old.unread = []; old.modelSeenSeqs = []; old.lastReadThroughSeq = old.seq
  await storage.set(simulationSessionKey(key), JSON.stringify(old))
  return f
}

test('Core explicit history works without embeddings, gives the model complete long JSON and keeps evidence and its reply ephemeral', redisTest, async t => {
  const f = await fixture(t)
  await f.trigger(); await f.wait()
  assert.equal(f.requests.length, 2)
  assert.ok(f.requests[0].tools.some(tool => tool.function.name === 'chatHistoryTool'))
  historyResult(f.requests[1])
  assert.equal(f.sends.length, 1)
  assert.deepEqual(f.sends[0].parts, [{ kind: 'text', text: reply }])
  assert.equal((await f.session()).sendTimes.length, 1)
  await f.assertEphemeral()
})

test('after history is read, attempts to save social memory, finish memories or a goal fail before a safe chat finish succeeds', redisTest, async t => {
  const f = await fixture(t, { terminalRound: 5, async script(_f, round, request) {
    if (round === 2) { historyResult(request); return call('simRemember', { kind: 'pendingEvent', content: reply, aboutUser: 'requester' }) }
    const result = request.messages.findLast(row => row.role === 'tool')
    assert.match(result.content, /历史资料仅供临时查证/u)
    if (round === 3) return call('simFinishTurn', { choice: 'chat', reason: reply, memories: [{ text: reply }], messages: [reply] }, 'attempt-memory')
    if (round === 4) return call('simFinishTurn', { choice: 'schedule', reason: reply, goal: { title: reply }, messages: [reply] }, 'attempt-goal')
    return finish()
  } })
  await f.trigger(); await f.wait()
  assert.equal(f.requests.length, 5)
  assert.equal(f.sends.length, 1)
  await f.assertEphemeral()
})

test('history grants are rechecked at the provider boundary and before sending after source revocation, recall or rebinding', redisTest, async t => {
  for (const mode of ['revoke-before-model', 'rebind-before-model', 'source-recall-before-reply', 'trigger-recall-before-reply']) await t.test(mode, async t => {
    const beforeModel = mode.endsWith('before-model') ? async (f, request) => {
      historyResult(request)
      if (mode.startsWith('revoke')) await f.revoke()
      else f.rebind()
    } : undefined
    const beforeReply = mode.endsWith('before-reply') ? async (f, request) => {
      historyResult(request)
      await f.recall(mode.startsWith('trigger') ? 'trigger' : 'old-0')
    } : undefined
    const f = await fixture(t, { beforeModel, beforeReply })
    await f.trigger(); await f.wait()
    assert.equal(f.secondSeen, true)
    assert.equal(f.requests.length, beforeModel ? 1 : 2)
    assert.equal(f.sends.length, 0)
    assert.equal((await f.session()).sendTimes.length, 0)
    await f.assertEphemeral()
  })
})

test('binding replacement clears old recent rows before the new role can query history', redisTest, async t => {
  const f = await fixture(t, { terminalRound: 2, async script(_f, _round, request) {
    const result = decodeHistory(request.messages.findLast(row => row.role === 'tool' && row.name === 'chatHistoryTool').content)
    assert.equal(result.status, 'not_found'); assert.deepEqual(result.messages, [])
    return call('simFinishTurn', { choice: 'silent', reason: '新角色没有旧历史' })
  } })
  const previous = await f.session()
  previous.recent = [{ seq: previous.seq, messageId: 'old-0', userId: 'requester', name: '旧角色来源', text: sourceMarker, at: Date.now() - 60000,
    atSelf: false, quoteToSelf: false, imageCount: 0, kind: 'text' }]
  await f.storage.set(simulationSessionKey(f.key), JSON.stringify(previous))
  f.rebind(); await f.trigger(); await f.wait()
  assert.doesNotMatch(JSON.stringify(f.requests), new RegExp(sourceMarker))
  assert.deepEqual((await f.session()).recent.map(row => row.messageId), ['trigger'])
  assert.equal(f.sends.length, 0)
})

test('text Core history has complete transient evidence, and the simulation observer never receives historical tool results', redisTest, async t => {
  await t.test('real text Core sends the reply and retains no tool evidence or derived reply', async t => {
    const f = await fixture(t, { text: true })
    await f.trigger(); await f.wait()
    assert.equal(f.requests.length, 2); historyResult(f.requests[1]); assert.equal(f.sends.length, 1)
    await f.assertEphemeral()
    const textKeys = await f.reader.keys(f.prefix + 'agent:group-text-history:*')
    assert.equal(textKeys.length, 1)
    assert.deepEqual(JSON.parse(await f.reader.get(textKeys[0])).turns, [])
  })
  await t.test('simulation observer is suppressed after explicit read', async t => {
    const f = await createAgentRedisFixture(t, 'history-runtime-observer'), requests = [], observed = [], diagnostics = []
    const account = { platform: 'fixture', namespace: 'observer', id: 'robot' }, target = { account, kind: 'group', id: 'room' }
    const observerBinding = createAgentBindingDirectory({ version: 1,
      agents: [{ id: 'role', personaId: 'default' }],
      connections: [{ id: 'connection', platform: account.platform, namespace: account.namespace, accountId: account.id }],
      bindings: [{ connectionId: 'connection', kind: 'group', conversationId: target.id, agentId: 'role' }],
    }, 'observer-v1').resolve(target)
    const now = Date.now(), key = simulationAddressKey(target), state = createDefaultSimSession(now)
    state.bootstrapSent = true; state.botId = account.id; state.wakeConfig.triggers.probability = 0
    await f.storage.set(simulationSessionKey(key), JSON.stringify(state))
    const historyText = JSON.stringify({ status: 'found', messages: oldTexts.map((content, index) => ({ message_id: `old-${index}`, content })) })
    const extra = { name: 'chatHistoryTool', description: 'Synthetic explicit history port', parameters: { type: 'object', properties: {}, required: [] },
      async execute(input, event) { return event._readAgentHistory(input, () => true, new AbortController().signal) } }
    const runtime = createSimulationRuntime({ redis: f.storage, logger: { info() {}, warn(...args) { diagnostics.push(args.map(String).join(' ')) }, error(...args) { diagnostics.push(args.map(String).join(' ')) } },
      now: () => now, handlesTarget: () => true, isAccountReady: () => true,
      messageActions: { async send() { assert.fail('silent observer turn must not send') } },
      getSelf: () => ({ id: account.id, name: 'fixture' }), getPersona: () => ({ binding: observerBinding, personaId: 'fixture', persona: { name: 'fixture' }, systemContent: '' }),
      getSection: section, getExecutionConfig: () => ({ providers: 'openai', useTools: true }), extraToolsPlatformNeutral: true,
      listRegistryToolNames: () => ({ builtIn: ['chatHistoryTool'], all: ['chatHistoryTool'] }), getExtraTools: () => [extra],
      readHistory: async () => ({ text: historyText, isCurrent: async () => true }), recordToolResult: result => observed.push(result),
      async YTapi(request) {
        requests.push(structuredClone(request))
        return requests.length === 1 ? call('chatHistoryTool', {}) : call('simFinishTurn', { choice: 'silent', reason: reply })
      },
    })
    t.after(async () => { runtime.stop(); await runtime.drain() })
    await runtime.ingest({ version: 1, conversation: target, sender: { ...account, id: 'requester' }, messageId: 'trigger', occurredAt: now,
      text: '查询历史', parts: [{ kind: 'text', text: '查询历史' }], mentions: [account], directedToAccount: true })
    await waitFor(async () => requests.length >= 2 && !await f.reader.exists(f.prefix + simulationBusyKey(key)), () => diagnostics.join('|'))
    await runtime.drain()
    assert.equal(requests[1].messages.find(row => row.name === 'chatHistoryTool').content, historyText)
    assert.deepEqual(observed, [])
    assert.doesNotMatch(JSON.stringify(JSON.parse(await f.storage.get(simulationSessionKey(key))).agentHistory), new RegExp(`${sourceMarker}|${derivedMarker}`))
  })
})
