import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentBindingDirectory, createAgentRuntime } from '../dist/backend/core/index.js'
import { createDefaultSimSession } from '../dist/backend/modules/simulation/domain/simConfig.js'
import { simulationAddressKey } from '../dist/backend/modules/simulation/infrastructure/simulationAddress.js'
import { simulationBusyKey, simulationSessionKey } from '../dist/backend/modules/simulation/infrastructure/simSessionStore.js'
import { agentBindingToken, agentPersonaScopeId, platformAccountKey } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { personMemoryAddress } from '../dist/backend/modules/memory/infrastructure/personMemoryContext.js'
import { characterKey } from '../dist/backend/modules/simulation/domain/characterState.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const redisTest = { skip: !redisAvailable, timeout: 20_000 }
const marker = '通用临时工具正文禁止留存'
const derived = '通用临时工具派生答复禁止留存'
const readerName = 'documentEvidenceFixtureTool'
const undeclaredName = 'ordinaryFixtureTool'
const file = { name: 'evidence.txt', mime: 'text/plain', base64: Buffer.from(marker).toString('base64') }
const call = (name, args = {}) => ({ choices: [{ message: { content: '', tool_calls: [{ id: `${name}-${Date.now()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
const finish = () => call('simFinishTurn', { choice: 'chat', reason: derived, messages: [derived] })
const section = () => ({ enabled: true, reflection: { enabled: false }, rhythm: { enabled: false }, mood: { enabled: false },
  personProfile: { enabled: false }, meme: { enabled: false }, userStyle: { enabled: false }, lifeThreads: { enabled: false },
  wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000 }, turn: { maxToolRounds: 10, minSendGapMs: 0, maxSendsPerTurn: 1 }, toolPolicy: { mode: 'open' } })

async function waitFor(check, message) {
  const until = performance.now() + 7000
  while (performance.now() < until) { if (await check()) return; await delay(15) }
  assert.fail(message())
}

async function fixture(t, options = {}) {
  const redis = await createAgentRedisFixture(t, 'simulation-file-policy'), { storage, reader, prefix } = redis
  const account = { platform: 'fixture', namespace: `file-policy-${options.undeclared ? 'ordinary' : 'temporary'}`, id: 'robot' }, target = { account, kind: 'group', id: 'room' }
  const sender = { ...account, id: 'human' }, now = Date.now()
  const binding = createAgentBindingDirectory({ version: 1, agents: [{ id: 'role', personaId: 'default' }],
    connections: [{ id: 'connection', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: [{ connectionId: 'connection', kind: 'group', conversationId: target.id, agentId: 'role' }] }, 'policy-v1').resolve(target)
  const key = simulationAddressKey(target), address = personMemoryAddress(target), identity = { botId: address.botId, personaId: agentPersonaScopeId(binding.agentId) }
  const state = createDefaultSimSession(now)
  state.bootstrapSent = true; state.botId = account.id; state.personaId = identity.personaId; state.bindingToken = agentBindingToken(binding)
  state.nextProactiveCheckAt = now + 86_400_000
  state.wakeConfig.triggers = { ...state.wakeConfig.triggers, probability: 0, question: false, nameMention: false, anyMessage: false }
  await storage.set(simulationSessionKey(key), JSON.stringify(state))
  const ckey = characterKey({ ...identity, groupId: address.scene.id }), requests = [], toolContexts = [], sends = [], diagnostics = [], observed = []
  let accept, terminal = false, readCount = 0, undeclaredCalls = 0
  const original = { version: 1, conversation: target, sender, senderName: '本人', messageId: 'policy-trigger', occurredAt: now,
    text: '请只在本轮读取当前附件并回答', parts: [{ kind: 'file', name: 'evidence.txt', resource: { kind: 'url', value: 'https://provider.example/private-reference' } }],
    mentions: [account], directedToAccount: true }
  const declared = { name: readerName, description: 'Generic temporary file evidence fixture', dataPolicy: 'ephemeral',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    async execute(_input, context) {
      toolContexts.push(context)
      assert.equal(typeof context.readFile, 'function'); assert.equal(typeof context.listFiles, 'function')
      assert.equal(context.request.messageId, original.messageId)
      const current = JSON.parse(await storage.get(ckey) || 'null')
      assert.equal(current?.receipts?.some(receipt => receipt.toolName === readerName) ?? false, false, 'no pending receipt may be persisted before the first file read')
      const found = await context.readFile({})
      assert.equal(found.origin, 'current'); assert.equal(Buffer.from(found.base64, 'base64').toString(), marker)
      return { status: 'succeeded', content: marker }
    } }
  const ordinary = { name: undeclaredName, description: 'Ordinary tool without temporary file authorization',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    async execute(_input, context) {
      undeclaredCalls++
      assert.equal(Object.hasOwn(context, 'readFile'), false); assert.equal(Object.hasOwn(context, 'listFiles'), false)
      assert.equal(context.readFile, undefined); assert.equal(context.listFiles, undefined)
      return { status: 'succeeded', content: '文件读取能力没有装配给普通工具' }
    } }
  const host = createAgentRuntime({ storage, isExecutionCurrent: redis.isCurrent, now: () => now,
    adapters: [{ id: 'connection', account, botUserId: account.id, botName: 'fixture', isReady: () => Boolean(accept),
      async start(consume) { accept = consume }, stop() {},
      async readMessage(_target, messageId, guard) { return messageId === original.messageId && guard?.isCurrent?.() !== false ? structuredClone(original) : undefined },
      async readMessageFile(_target, messageId, index, guard) {
        await guard.ensureCurrent?.(); if (messageId !== original.messageId || index !== 1 || !await guard.allowsSource(structuredClone(original))) return undefined
        readCount++; return file
      },
      async listConversationFiles() { return { target, observedAt: now, files: [], truncated: false } },
      actions: { async send(action, guard) { assert.equal(guard.isCurrent(), true); sends.push(structuredClone(action)); return { state: 'sent', messageId: 'policy-reply' } } },
    }],
    logger: { info() {}, warn(...args) { diagnostics.push(args.map(String).join(' ')) }, error(...args) { diagnostics.push(args.map(String).join(' ')) } },
    getSection: section, getExecutionConfig: () => ({ providers: 'openai', useTools: true }),
    resolvePersona: () => ({ binding, persona: { name: 'fixture' }, systemContent: '' }),
    toolRegistry: { builtIn: [declared, ordinary] }, recordToolResult: result => observed.push(result),
    async YTapi(request, _config, _signal, _current, ensureCurrent) {
      await ensureCurrent?.(); requests.push(structuredClone(request))
      if (requests.length === 1) return call(options.undeclared ? undeclaredName : readerName)
      if (!options.undeclared && requests.length === 2) {
        const result = request.messages.findLast(row => row.role === 'tool')
        assert.match(result.content, new RegExp(marker)); assert.doesNotMatch(result.content, /运行时行动回执/u)
        const current = JSON.parse(await storage.get(ckey) || 'null')
        assert.equal(current?.receipts?.some(receipt => receipt.toolName === readerName) ?? false, false)
        return call(readerName)
      }
      if (!options.undeclared && requests.length === 3) return call(undeclaredName)
      if (!options.undeclared && requests.length === 4) {
        assert.match(request.messages.findLast(row => row.role === 'tool').content, /仅供临时查证/u)
        assert.equal(undeclaredCalls, 0, 'ordinary actions stay denied after temporary reads')
      }
      terminal = true
      return options.undeclared ? call('simFinishTurn', { choice: 'silent', reason: '已检查能力范围' }) : finish()
    },
  })
  t.after(async () => { await host.stop() })
  await host.start()
  return { ...redis, host, requests, sends, toolContexts, ckey, observed,
    get readCount() { return readCount }, get undeclaredCalls() { return undeclaredCalls },
    async run() {
      await accept({ kind: 'message', message: structuredClone(original) })
      const inboxKey = prefix + `agent:inbox:simulation:${platformAccountKey(account)}`
      await waitFor(async () => terminal && !await reader.exists(prefix + simulationBusyKey(key)) && !await reader.lLen(inboxKey), () => `generic data policy turn did not settle: ${diagnostics.join('|')}`)
      await host.runtime.drain()
    },
    async assertEphemeral() {
      const character = JSON.parse(await storage.get(ckey) || 'null')
      assert.equal(character?.receipts?.some(receipt => receipt.toolName === readerName) ?? false, false)
      for (const redisKey of await reader.keys(prefix + '*')) if (await reader.type(redisKey) === 'string') assert.doesNotMatch(await reader.get(redisKey), new RegExp(`${marker}|${derived}`), redisKey)
      assert.deepEqual(observed, [])
      const session = JSON.parse(await storage.get(simulationSessionKey(key)))
      assert.equal(session.lastConfirmedChat, undefined)
    },
  }
}

test('a declared public AgentTool with an arbitrary name reads files repeatedly without pending/final receipts or durable derived content', redisTest, async t => {
  const f = await fixture(t)
  await f.run()
  assert.equal(f.requests.length, 4); assert.equal(f.readCount, 2); assert.equal(f.toolContexts.length, 2); assert.equal(f.sends.length, 1)
  assert.match(JSON.stringify(f.sends), new RegExp(derived)); await f.assertEphemeral()
})

test('an undeclared public AgentTool receives neither file read nor listing ports', redisTest, async t => {
  const f = await fixture(t, { undeclared: true })
  await f.run()
  assert.equal(f.undeclaredCalls, 1); assert.equal(f.readCount, 0); assert.equal(f.sends.length, 0)
})
