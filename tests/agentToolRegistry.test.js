import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentBindingDirectory, createAgentRuntime } from '../dist/backend/core/index.js'
import { createAgentTools } from '../dist/backend/modules/tools/infrastructure/agentTools.js'
import { createDefaultSimSession } from '../dist/backend/modules/simulation/domain/simConfig.js'
import { simulationAddressKey } from '../dist/backend/modules/simulation/infrastructure/simulationAddress.js'
import { simulationBusyKey, simulationSessionKey } from '../dist/backend/modules/simulation/infrastructure/simSessionStore.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const schema = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false }
const definition = (name, execute = async () => ({ status: 'succeeded', content: 'result' })) => ({ name, description: 'Scoped lookup fixture', parameters: schema, execute })
const image = { mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6d8AAAAASUVORK5CYII=' }
async function waitFor(probe, message, timeout = 5000) {
  const until = Date.now() + timeout
  while (Date.now() < until) { const result = await probe(); if (result) return result; await delay(15) }
  assert.fail(typeof message === 'function' ? message() : message)
}

test('public tool registry rejects name collisions, reserved capabilities and invalid schemas', () => {
  const ports = { signal: new AbortController().signal, context: () => undefined }
  for (const registry of [
    { builtIn: [definition('simSendMessage')] },
    { custom: [definition('commitmentTool')] },
    { builtIn: [definition('lookup')], custom: [definition('lookup')] },
    { builtIn: [{ ...definition('lookup'), parameters: { type: 'object', properties: {}, required: ['absent'] } }] },
  ]) assert.throws(() => createAgentTools(registry, ports))
})

test('registry validates the canonical schema and selects capabilities per action before entering the tool', async () => {
  const account = { platform: 'qq', namespace: 'global', id: '10001' }
  const sender = { ...account, id: '20001' }
  const projected = [], deliveries = []
  const result = { status: 'succeeded', content: 'fixture-result' }
  let scope = {
    binding: { target: { account, kind: 'group', id: '30001' } }, actor: { kind: 'user', user: sender },
    request: { messageId: 'active-request', text: '请查一下', mentions: [] }, isCurrent: () => true,
    async sendBundle(items) { deliveries.push(items); return { state: 'unknown' } },
    async sendMessage() { assert.fail('an unknown bundle must fence other sends') },
    async readFile() { assert.fail('a delivery must never get the file reader') },
  }
  const properties = {
    mode: { enum: ['text', 'bundle'] },
    filter: { type: 'object', properties: { page: { type: 'integer', minimum: 1 } }, required: ['page'], additionalProperties: false },
  }
  const tool = {
    name: 'scopedLookup', description: 'Fixture with text and bundle actions',
    parameters: { type: 'object', properties: { mode: properties.mode }, required: ['mode'], additionalProperties: false },
    inputSchema: { type: 'object', properties, required: ['mode', 'filter'], additionalProperties: false },
    effect: input => input.mode === 'bundle'
      ? { actor: 'user', conversation: 'group', required: ['sendBundle'], optional: ['sendMessage'] }
      : {},
    async execute(input, context) {
      projected.push(Object.keys(context).sort())
      if (input.mode === 'bundle') {
        assert.deepEqual(await context.sendBundle([{ parts: [{ kind: 'text', text: 'fixture message' }] }]), { state: 'unknown' })
        await assert.rejects(context.sendMessage({ text: 'fixture fallback' }), /结果未知/u)
      }
      return result
    },
  }
  const [registered] = createAgentTools({ builtIn: [tool] }, { signal: new AbortController().signal, context: () => scope }).getExtraTools([tool.name])
  for (const params of [[], null, { mode: 'text' }, { mode: 'text', filter: { page: '1' } }, { mode: 'text', filter: { page: 1, extra: true } }]) {
    assert.match(await registered.execute(params, {}), /^error:/u)
  }
  const valid = { filter: { page: 1 }, mode: 'text' }
  assert.equal((await registered.execute(valid, {})).status, 'success')
  assert.deepEqual(projected, [['actor', 'binding', 'ensureCurrent', 'isCurrent', 'signal']])
  const authorized = scope
  for (const change of [
    { actor: { kind: 'autonomous' } }, { actor: { kind: 'user', user: account } }, { request: undefined }, { sendBundle: undefined },
  ]) {
    scope = { ...authorized, ...change }
    assert.equal((await registered.execute({ ...valid, mode: 'bundle' }, {})).status, 'error')
  }
  assert.equal(projected.length, 1)
  assert.equal(deliveries.length, 0)
  scope = authorized
  assert.equal((await registered.execute({ ...valid, mode: 'bundle' }, {})).status, 'unknown')
  assert.deepEqual(projected[1], ['actor', 'binding', 'ensureCurrent', 'isCurrent', 'sendBundle', 'sendMessage', 'signal'])
  assert.equal(deliveries.length, 1)
})

test('canonical schemas validate object constants and tuple rules without inherited properties', async () => {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false,
    required: ['constructor', 'tuple'], properties: {
      constructor: { const: { source: 'public' } },
      tuple: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'integer' }], minItems: 2, items: false },
    },
  }
  const host = createAgentTools({ builtIn: [{ ...definition('schemaLookup'), inputSchema: schema, effect: 'read' }] }, {
    signal: new AbortController().signal, context: () => ({ binding: {}, actor: { kind: 'autonomous' }, isCurrent: () => true }),
  })
  const [tool] = host.getExtraTools(['schemaLookup'])
  assert.match(await tool.execute({ tuple: ['label', 1] }, {}), /^error: .*Schema/u)
  assert.match(await tool.execute({ constructor: { source: 'other' }, tuple: ['label', 1] }, {}), /^error: .*Schema/u)
  assert.match(await tool.execute({ constructor: { source: 'public' }, tuple: ['label', '1'] }, {}), /^error: .*Schema/u)
  assert.equal((await tool.execute({ constructor: { source: 'public' }, tuple: ['label', 1] }, {})).status, 'success')
})

test('host cancellation stops waiting for an uncooperative tool and never exposes its exception', async () => {
  const stopped = new AbortController()
  let entered = false
  const tools = createAgentTools({ builtIn: [definition('lookup', async () => { entered = true; return new Promise(() => {}) })] }, {
    signal: stopped.signal, context: () => ({ binding: {}, actor: { kind: 'autonomous' }, isCurrent: () => true }),
  })
  const result = tools.getExtraTools(['lookup'])[0].execute({ query: 'fixture' }, {})
  await waitFor(() => entered, 'tool entered')
  stopped.abort()
  assert.equal((await result).status, 'unknown')
  const failing = createAgentTools({ builtIn: [definition('lookup', async () => { throw new Error('provider-secret') })] }, {
    signal: new AbortController().signal, context: () => ({ binding: {}, actor: { kind: 'user' }, isCurrent: () => true }),
  })
  const failure = await failing.getExtraTools(['lookup'])[0].execute({ query: 'fixture' }, {})
  assert.equal(failure.status, 'unknown')
  assert.ok(!JSON.stringify(failure).includes('provider-secret'))
})

test('custom tools cannot borrow built-in autonomous names and completed calls revoke their context', async () => {
  let called = 0, savedContext
  const tools = createAgentTools({
    custom: [definition('searchInformationTool', async () => { called++; return { status: 'succeeded', content: 'wrong' } })],
    builtIn: [definition('webParserTool', async (_input, context) => { savedContext = context; return { status: 'succeeded', content: 'done' } })],
  }, { signal: new AbortController().signal, context: () => ({ binding: {}, actor: { kind: 'autonomous' }, isCurrent: () => true }) })
  assert.equal(tools.isExtraToolAutonomous('searchInformationTool'), false)
  assert.equal(tools.isExtraToolAutonomous('webParserTool'), true)
  assert.equal((await tools.getExtraTools(['searchInformationTool'])[0].execute({ query: 'fixture' }, {})).status, 'error')
  assert.equal(called, 0)
  assert.equal((await tools.getExtraTools(['webParserTool'])[0].execute({ query: 'fixture' }, {})).status, 'success')
  assert.equal(savedContext.signal.aborted, true)
  assert.equal(savedContext.isCurrent(), false)
})

test('stored permission checks fence execution and discard revoked results without waiting past cancellation', async () => {
  let current = true, calls = 0, saved
  const stop = new AbortController()
  const tools = createAgentTools({ builtIn: [definition('lookup', async (_input, context) => {
    calls++; saved = context; current = false
    return { status: 'succeeded', content: 'revoked-tool-private-material' }
  })] }, { signal: stop.signal, context: () => ({ binding: {}, actor: { kind: 'user' }, isCurrent: () => true,
    async ensureCurrent() { if (!current) throw new Error('stored-policy-private-details') },
  }) })
  const result = await tools.getExtraTools(['lookup'])[0].execute({ query: 'fixture' }, {})
  assert.equal(result.status, 'unknown')
  assert.equal(calls, 1)
  assert.equal(saved.signal.aborted, true)
  assert.doesNotMatch(JSON.stringify(result), /private-material|private-details/u)
  await tools.getExtraTools(['lookup'])[0].execute({ query: 'fixture' }, {})
  assert.equal(calls, 1)
  let checking = false
  const waiting = createAgentTools({ builtIn: [definition('lookup')] }, { signal: stop.signal,
    context: () => ({ binding: {}, actor: { kind: 'user' }, isCurrent: () => true,
      async ensureCurrent() { checking = true; await new Promise(() => {}) },
    }),
  }).getExtraTools(['lookup'])[0].execute({ query: 'fixture' }, {})
  await waitFor(() => checking, 'stored check starts')
  stop.abort()
  assert.equal((await waiting).status, 'unknown')
})

test('Core tools obey policy and pass neutral identities, scoped usage and binding cancellation', {
  skip: !redisAvailable, timeout: 20_000,
}, async t => {
  const { reader, storage, prefix, isCurrent } = await createAgentRedisFixture(t, 'tool-registry')
  const account = { platform: 'fixture', namespace: 'tenant', id: 'bot/account' }
  const target = { account, kind: 'channel', id: 'space/thread' }
  const sender = { ...account, id: 'member/person' }
  const config = {
    version: 1, agents: [{ id: 'role', personaId: 'default' }, { id: 'new-role', personaId: 'default' }],
    connections: [{ id: 'connection', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: [{ connectionId: 'connection', kind: target.kind, conversationId: target.id, agentId: 'role' }],
  }
  let directory = createAgentBindingDirectory(config, 'one')
  let accept, delayedContext, releaseDelayed
  let now = Date.now()
  const requests = [], calls = [], sends = [], usage = [], errors = []
  const section = { enabled: true, reflection: { enabled: false }, rhythm: { enabled: false },
    wake: { batchWindowMs: 1000, proactiveProbability: 0, probability: 0 }, turn: { minSendGapMs: 0, maxSendsPerTurn: 1 }, toolPolicy: { mode: 'open' },
  }
  const state = createDefaultSimSession(now)
  state.bootstrapSent = true
  state.botId = account.id
  state.wakeConfig.triggers.probability = 0
  state.nextProactiveCheckAt = 0
  const key = simulationAddressKey(target)
  await storage.set(simulationSessionKey(key), JSON.stringify(state))
  const lookup = definition('readProbe', async (input, context) => {
    calls.push({ input, context })
    assert.equal(context.binding.agentId, 'role')
    assert.deepEqual(context.binding.target, target)
    assert.deepEqual(context.actor, { kind: 'user', user: sender })
    assert.equal(context.isCurrent(), true)
    assert.equal(context.reply, undefined)
    assert.equal(context.bot, undefined)
    assert.ok(Object.isFrozen(context.binding.target.account))
    context.recordUsage('lookup-model', { total_tokens: 17 })
    if (input.query === 'image') {
      const results = await Promise.allSettled([context.sendImage(image), context.sendImage(image)])
      assert.deepEqual(results.filter(result => result.status === 'fulfilled').map(result => result.value), [{ state: 'sent', messageId: 'out-1' }])
      assert.equal(results.filter(result => result.status === 'rejected').length, 1)
      return { status: 'succeeded', content: 'Image delivered' }
    }
    if (['late', 'recall', 'activity', 'policy'].includes(input.query)) {
      delayedContext = context
      return new Promise(resolve => { releaseDelayed = () => resolve({ status: 'succeeded', content: 'revoked-private-result' }) })
    }
    return { status: 'succeeded', content: 'lookup-evidence' }
  })
  const custom = definition('customProbe', async (input, context) => { calls.push({ input, context, custom: true }); return { status: 'succeeded', content: 'custom-evidence' } })
  const host = createAgentRuntime({
    storage, isExecutionCurrent: isCurrent, now: () => now,
    adapters: [{ id: 'connection', account, botName: 'fixture', botUserId: account.id, isReady: () => !!accept,
      async start(consume) { accept = consume }, stop() {},
      actions: { async send(action, guard) { assert.ok(guard.isCurrent()); sends.push(action); return { state: 'sent', messageId: 'out-' + sends.length } } },
    }],
    logger: { info() {}, warn() {}, error(...args) { errors.push(args.map(String).join(' ')) } },
    getSection: () => section, getExecutionConfig: () => ({ providers: 'openai', useTools: true }),
    toolRegistry: { builtIn: [lookup], custom: [custom] }, recordTokens: row => usage.push(row),
    resolvePersona(address) { const binding = directory.resolve(address); return binding && { binding, persona: { name: 'fixture' }, systemContent: '' } },
    async YTapi(request) {
      const start = request.messages.findLastIndex(row => typeof row.content === 'string' && row.content.includes('【执行主体】'))
      const wake = String(request.messages[start]?.content)
      const results = request.messages.slice(start + 1).filter(row => row.role === 'tool')
      const label = [...wake.matchAll(/command-(builtin|custom|denied|activity|policy|recall|late|image|invalid)/gu)].at(-1)?.[1]
      requests.push({ request, label, results })
      const name = label === 'custom' ? 'customProbe' : 'readProbe'
      const shouldCall = label && label !== 'denied' && !results.length
      return { choices: [{ message: { content: '', tool_calls: [{ id: 'call', type: 'function', function: {
        name: shouldCall ? name : 'simFinishTurn', arguments: JSON.stringify(shouldCall ? { query: label === 'invalid' ? 99 : label }
          : { choice: 'silent', reason: 'fixture complete', throughSeq: sequence }),
      } }] } }] }
    },
  })
  let sequence = 0
  const emit = async label => {
    now += 65_000
    const text = 'command-' + label
    await accept({ kind: 'message', message: { version: 1, conversation: target, sender, messageId: 'in-' + ++sequence,
      occurredAt: now, text, parts: [{ kind: 'text', text }], mentions: [account], directedToAccount: true } })
  }
  const settled = async () => {
    const saved = JSON.parse(await reader.get(prefix + simulationSessionKey(key)) ?? 'null')
    return saved && !saved.queuedIngressWake && !await reader.exists(prefix + simulationBusyKey(key))
  }
  try {
    await host.start()
    await emit('builtin')
    await waitFor(() => calls.length === 1, 'builtin executes in a neutral channel: ' + errors.join('|'))
    await waitFor(settled, 'builtin turn completes')
    const names = requests.find(row => row.label === 'builtin').request.tools.map(tool => tool.function.name)
    assert.ok(names.includes('readProbe'))
    assert.ok(!names.includes('customProbe'))
    assert.ok(usage.some(row => row.scope === key && row.stage === 'agent-tool' && row.model === 'lookup-model' && row.usage.total_tokens === 17))
    await emit('image')
    await waitFor(() => sends.length === 1, 'image sends through the neutral platform action port')
    await waitFor(settled, 'image turn completes')
    assert.deepEqual(sends[0].target, target)
    assert.deepEqual(sends[0].parts, [{ kind: 'image', resource: { kind: 'reference', value: `base64://${image.base64}` } }])
    const savedImageTurn = JSON.parse(await reader.get(prefix + simulationSessionKey(key)))
    assert.ok(savedImageTurn.sendTimes.includes(now))
    assert.equal(savedImageTurn.lastAiSendAt, now)
    await assert.rejects(calls.find(call => call.input.query === 'image').context.sendImage(image), /失效/u)
    assert.equal(sends.length, 1)
    section.toolPolicy.allowTools = ['customProbe']
    await emit('custom')
    await waitFor(() => calls.some(call => call.custom), () => 'explicit custom authorization executes: ' + JSON.stringify({ errors, requests: requests.map(row => ({ label: row.label, results: row.results, tools: row.request.tools?.map(tool => tool.function.name) })) }))
    await waitFor(settled, 'custom turn completes')
    section.toolPolicy.denyTools = ['readProbe', 'customProbe']
    await emit('denied')
    await waitFor(() => requests.some(row => row.label === 'denied'), 'denied turn executes')
    await waitFor(settled, 'denied turn completes')
    const denied = requests.find(row => row.label === 'denied').request.tools.map(tool => tool.function.name)
    assert.ok(!denied.includes('readProbe') && !denied.includes('customProbe'))
    assert.equal(calls.length, 3)
    section.toolPolicy.denyTools = []
    const readProbeReceiptCount = async () => {
      const keys = await reader.keys(prefix + 'shiloh:character:v1:*')
      const rows = await Promise.all(keys.map(async key => JSON.parse(await reader.get(key)).receipts ?? []))
      return rows.flat().filter(receipt => receipt.toolName === 'readProbe').length
    }
    const receiptsBeforeInvalid = await readProbeReceiptCount()
    await emit('invalid')
    await waitFor(() => requests.some(row => row.label === 'invalid' && row.results.some(result => /Schema/u.test(result.content))),
      'invalid schema fails visibly in the model loop')
    await waitFor(settled, 'invalid tool turn completes')
    assert.equal(calls.length, 3)
    assert.equal(await readProbeReceiptCount(), receiptsBeforeInvalid, 'invalid input cannot take a durable action slot')
    await emit('policy')
    await waitFor(() => delayedContext, 'tool starts with current policy')
    section.toolPolicy.denyTools = ['readProbe']
    await waitFor(() => delayedContext.signal.aborted, 'updated deny list aborts an in-flight call')
    releaseDelayed()
    await waitFor(settled, 'revoked tool turn completes')
    delayedContext = undefined
    section.toolPolicy.denyTools = []
    await emit('activity')
    await waitFor(() => delayedContext, 'tool waits while its stored activity remains current')
    await storage.set(simulationSessionKey(key) + ':activity-version', 'external-revocation')
    releaseDelayed()
    await waitFor(settled, 'stored activity revocation fences the returned result')
    assert.equal(delayedContext.signal.aborted, true)
    const storedCharacters = await reader.keys(prefix + 'shiloh:character:v1:*')
    assert.ok(storedCharacters.length > 0)
    const receipts = []
    for (const storedKey of storedCharacters) {
      const value = await reader.get(storedKey)
      assert.ok(!value.includes('revoked-private-result'))
      receipts.push(...(JSON.parse(value).receipts ?? []))
    }
    assert.ok(receipts.some(receipt => receipt.toolName === 'readProbe' && receipt.status === 'unknown'))
    delayedContext = undefined
    await emit('recall')
    await waitFor(() => delayedContext, 'recalled tool starts')
    await accept({ kind: 'recall', target, messageId: 'in-' + sequence })
    assert.equal(delayedContext.signal.aborted, true)
    assert.equal(delayedContext.isCurrent(), false)
    releaseDelayed()
    await waitFor(settled, 'recalled turn completes')
    delayedContext = undefined
    await emit('late')
    await waitFor(() => delayedContext, 'late tool starts')
    directory = createAgentBindingDirectory({ ...config, bindings: [{ ...config.bindings[0], agentId: 'new-role' }] }, 'two')
    await waitFor(() => delayedContext.signal.aborted, 'binding change aborts external tool')
    assert.equal(delayedContext.isCurrent(), false)
    releaseDelayed()
    await waitFor(settled, 'revoked turn completes')
    assert.ok(!JSON.stringify(requests).includes('revoked-private-result'))
    assert.equal(sends.length, 1)
  } finally { releaseDelayed?.(); await host.stop() }
})

test('Core revokes an in-flight creative tool when autonomous permission is withdrawn', {
  skip: !redisAvailable, timeout: 20_000,
}, async t => {
  const { reader, storage, prefix, isCurrent } = await createAgentRedisFixture(t, 'tool-autonomous')
  const account = { platform: 'qq', namespace: 'global', id: '10001' }
  const sender = { ...account, id: '20001' }
  const target = { account, kind: 'group', id: '30001' }
  const directory = createAgentBindingDirectory({
    version: 1, agents: [{ id: 'role', personaId: 'default' }],
    connections: [{ id: 'connection', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: [{ connectionId: 'connection', kind: target.kind, conversationId: target.id, agentId: 'role' }],
  }, 'one')
  let now = Date.now(), accept, context
  const requests = [], sends = [], release = Promise.withResolvers()
  const section = { enabled: true, reflection: { enabled: false }, rhythm: { enabled: false },
    wake: { batchWindowMs: 1000, proactiveIdleMs: 60_000, proactiveProbability: 1, probability: 0 },
    autonomousTools: ['bananaTool'],
  }
  const key = simulationAddressKey(target)
  const session = createDefaultSimSession(now)
  session.bootstrapSent = true
  session.botId = account.id
  session.nextProactiveCheckAt = 0
  await storage.set(simulationSessionKey(key), JSON.stringify(session))
  const tool = { ...definition('bananaTool', async (_input, scoped) => { context = scoped; return release.promise }),
    effect: { required: ['sendImage'] } }
  const host = createAgentRuntime({
    storage, isExecutionCurrent: isCurrent, now: () => now,
    adapters: [{ id: 'connection', account, botName: 'fixture', botUserId: account.id, isReady: () => !!accept,
      async start(consume) { accept = consume }, stop() {},
      actions: { async send(action) { sends.push(action); return { state: 'sent', messageId: 'unexpected' } } },
    }],
    logger: { info() {}, warn() {}, error() {} },
    getSection: () => section, getExecutionConfig: () => ({ providers: 'openai', useTools: true }),
    toolRegistry: { builtIn: [tool] },
    resolvePersona(address) { const binding = directory.resolve(address); return binding && { binding, persona: { name: 'fixture' }, systemContent: '' } },
    async YTapi(request) {
      requests.push(request)
      const create = requests.length === 1
      return { choices: [{ message: { content: '', tool_calls: [{ id: 'autonomous-' + requests.length, type: 'function', function: {
        name: create ? tool.name : 'simFinishTurn', arguments: JSON.stringify(create ? { query: 'image' } : { choice: 'silent', reason: 'fixture' }),
      } }] } }] }
    },
  })
  try {
    await host.start()
    const text = '一条普通聊天'
    await accept({ kind: 'message', message: { version: 1, conversation: target, sender, messageId: 'incoming-1',
      occurredAt: now, text, parts: [{ kind: 'text', text }], mentions: [], directedToAccount: false } })
    await waitFor(async () => JSON.parse(await reader.get(prefix + simulationSessionKey(key)) ?? 'null')?.recent.length === 1,
      'group has ordinary chat for an idle wake')
    now += 2 * 60 * 60_000
    await host.runtime.sweepOnce()
    await waitFor(() => context, 'configured autonomous tool starts')
    assert.equal(context.actor.kind, 'autonomous')
    section.autonomousTools = []
    await waitFor(() => context.signal.aborted, 'revoked autonomous permission aborts the tool')
    assert.equal(context.isCurrent(), false)
    await assert.rejects(context.sendImage(image), /失效/u)
    release.resolve({ status: 'succeeded', content: 'revoked-autonomous-result' })
    await host.runtime.drain()
    assert.equal(sends.length, 0)
    assert.ok(!JSON.stringify(requests).includes('revoked-autonomous-result'))
  } finally { release.resolve({ status: 'failed', content: '' }); await host.stop() }
})

test('Core attachment tools read visible QQ and quoted images without vision, then stop on binding changes', {
  skip: !redisAvailable, timeout: 20_000,
}, async t => {
  const { reader, storage, prefix, isCurrent } = await createAgentRedisFixture(t, 'tool-attachments')
  const account = { platform: 'qq', namespace: 'global', id: '10001' }
  const target = { account, kind: 'group', id: '20001' }, sender = { ...account, id: '30001' }
  const config = {
    version: 1, agents: [{ id: 'daily', personaId: 'default' }, { id: 'replacement', personaId: 'default' }],
    connections: [{ id: 'qq', platform: 'qq', namespace: 'global', accountId: account.id }],
    bindings: [{ connectionId: 'qq', kind: 'group', conversationId: target.id, agentId: 'daily' }],
  }
  let directory = createAgentBindingDirectory(config, 'first'), accept, now = Date.now(), sequence = 0
  let saved, readWaiting = false, releaseRead, pendingReadSignal
  const waitRead = new Promise(resolve => { releaseRead = resolve })
  const sources = new Map(), requests = [], materialized = [], results = [], errors = []
  const state = createDefaultSimSession(now)
  state.bootstrapSent = true; state.botId = account.id; state.wakeConfig.triggers.probability = 0; state.nextProactiveCheckAt = 0
  const address = simulationAddressKey(target)
  await storage.set(simulationSessionKey(address), JSON.stringify(state))
  const read = definition('attachmentProbe', async (input, context) => {
    saved = context
    await assert.rejects(context.readImages(999), /本轮可见/u)
    const images = await context.readImages(sequence)
    results.push({ label: input.query, images })
    return { status: 'succeeded', content: 'Read verified attachments for the image editor' }
  })
  const host = createAgentRuntime({
    storage, isExecutionCurrent: isCurrent, now: () => now,
    adapters: [{ id: 'qq', account, botName: 'fixture', botUserId: account.id, isReady: () => !!accept,
      async start(consume) { accept = consume }, stop() {},
      async readMessage(_target, id, guard) { return guard.isCurrent() ? sources.get(id) : undefined },
      async readMessageImages(selected, id, guard) {
        assert.deepEqual(selected, target)
        assert.ok(guard.signal instanceof AbortSignal)
        assert.equal(guard.signal.aborted, false)
        if (id === 'in-rebind') { pendingReadSignal = guard.signal; readWaiting = true; await waitRead }
        const original = sources.get(id)
        if (!guard.isCurrent() || !original || !await guard.allowsSource(original) || !guard.isCurrent()) return undefined
        materialized.push(id)
        return [image]
      },
      actions: { async send() { assert.fail('attachment reading must not send') } },
    }],
    logger: { info() {}, warn() {}, error(...args) { errors.push(args.map(String).join(' ')) } },
    getSection: () => ({ enabled: true, reflection: { enabled: false }, rhythm: { enabled: false },
      wake: { batchWindowMs: 1000, proactiveProbability: 0, probability: 0 }, toolPolicy: { mode: 'open' },
    }),
    getExecutionConfig: () => ({ providers: 'openai', useTools: true }), toolRegistry: { builtIn: [read] },
    resolvePersona(selected) { const binding = directory.resolve(selected); return binding && { binding, persona: { name: 'fixture' }, systemContent: '' } },
    async YTapi(request) {
      requests.push(request)
      assert.ok(!request.tools.some(tool => tool.function.name === 'simGetMessageImages'), 'vision tools remain gated without a vision model')
      const start = request.messages.findLastIndex(row => typeof row.content === 'string' && row.content.includes('【执行主体】'))
      const label = [...String(request.messages[start]?.content).matchAll(/image-(direct|quoted|rebind)/gu)].at(-1)?.[1]
      const finished = request.messages.slice(start + 1).some(row => row.role === 'tool')
      return { choices: [{ message: { content: '', tool_calls: [{ id: 'call', type: 'function', function: {
        name: finished ? 'simFinishTurn' : 'attachmentProbe',
        arguments: JSON.stringify(finished ? { choice: 'silent', reason: 'fixture complete', throughSeq: sequence } : { query: label }),
      } }] } }] }
    },
  })
  const emit = async label => {
    now += 65_000; sequence++
    const message = { version: 1, conversation: target, sender, messageId: `in-${label}`, occurredAt: now,
      text: `image-${label}`, parts: label === 'quoted' ? [] : [{ kind: 'image', resource: { kind: 'url', value: 'http://127.0.0.1/private-source' } }],
      mentions: [account], directedToAccount: true,
      ...(label === 'quoted' ? { quote: { messageId: 'quoted-original', parts: [] } } : {}),
    }
    sources.set(message.messageId, message)
    if (label === 'quoted') sources.set('quoted-original', { ...message, messageId: 'quoted-original', occurredAt: now - 1000,
      sender: { ...account, id: '40001' }, text: '图片原消息', parts: [{ kind: 'image' }], quote: undefined,
    })
    await accept({ kind: 'message', message })
  }
  const settled = async () => {
    const current = JSON.parse(await reader.get(prefix + simulationSessionKey(address)) ?? 'null')
    return current && !current.queuedIngressWake && !await reader.exists(prefix + simulationBusyKey(address))
  }
  try {
    await host.start()
    for (const label of ['direct', 'quoted']) {
      await emit(label)
      await waitFor(() => results.some(result => result.label === label), () => `attachment ${label}: ${errors.join('|')}`)
      await waitFor(settled, `attachment ${label} turn completes`)
      await assert.rejects(saved.readImages(sequence), /失效/u)
    }
    assert.deepEqual(materialized, ['in-direct', 'quoted-original'])
    assert.ok(results.every(result => JSON.stringify(result.images) === JSON.stringify([image])))
    assert.ok(!JSON.stringify(requests).includes(image.base64))
    assert.ok(!JSON.stringify(requests).includes('127.0.0.1/private-source'))
    await emit('rebind')
    await waitFor(() => readWaiting, 'attachment read waits before downloading')
    directory = createAgentBindingDirectory({ ...config, bindings: [{ ...config.bindings[0], agentId: 'replacement' }] }, 'changed')
    await waitFor(() => saved.signal.aborted, 'binding change cancels attachment tool')
    assert.equal(pendingReadSignal.aborted, true, 'the adapter receives the tool cancellation signal')
    releaseRead()
    await waitFor(settled, 'revoked attachment turn completes')
    assert.deepEqual(materialized, ['in-direct', 'quoted-original'])
    assert.equal(results.length, 2)
  } finally { releaseRead(); await host.stop() }
})
