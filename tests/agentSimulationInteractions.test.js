import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const { createSimulationRuntime } = await importBilibiliHost('modules/simulation/infrastructure/simulationRuntime.js')
const { createAgentTools } = await importBilibiliHost('modules/tools/infrastructure/agentTools.js')
const { createAgentInteractionTools } = await importBilibiliHost('modules/tools/infrastructure/agentInteractionTools.js')
const { createDefaultSimSession } = await importBilibiliHost('modules/simulation/domain/simConfig.js')
const { simulationAddressKey } = await importBilibiliHost('modules/simulation/infrastructure/simulationAddress.js')
const { simulationSessionKey } = await importBilibiliHost('modules/simulation/infrastructure/simSessionStore.js')
const { agentBindingToken, agentPersonaScopeId } = await importBilibiliHost('modules/runtime/domain/agentBindings.js')
const { createAgentRuntime, createAgentBindingDirectory } = await importBilibiliHost('core/index.js')

const redisTest = { skip: !redisAvailable, timeout: 25000 }, AT = 1_790_000_000_000
const names = ['pokeTool', 'likeTool', 'reactionTool']
let sequence = 0
const call = (name, args = {}) => ({ id: `interaction-call-${++sequence}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const response = (...tool_calls) => ({ choices: [{ message: { content: '', tool_calls } }], usage: { total_tokens: 1 } })
const finish = () => call('simFinishTurn', { choice: 'silent', reason: '本次互动验证结束' })
const schema = { type: 'object', properties: {}, required: [], additionalProperties: false }
async function waitFor(probe, description) {
  const until = performance.now() + 7500
  while (performance.now() < until) { if (await probe()) return; await delay(15) }
  assert.fail(description())
}
async function fixture(t, settings = {}) {
  const redis = await createAgentRedisFixture(t, 'simulation-interaction'), clock = { value: AT }
  const account = { platform: 'fixture', namespace: 'sim-interaction', id: 'robot' }, target = { account, kind: 'group', id: 'room' }, actor = { ...account, id: 'human' }
  const binding = { source: 'configured', id: 'interaction-binding', revision: 'initial', agentId: 'role', personaId: 'default', connectionId: 'main', target }
  const key = simulationAddressKey(target), requests = [], interactions = [], sends = [], observed = [], episodes = [], groupReplies = [], errors = [], contexts = []
  const initial = createDefaultSimSession(clock.value)
  initial.bootstrapSent = true; initial.botId = account.id; initial.bindingToken = agentBindingToken(binding); initial.personaId = agentPersonaScopeId(binding.agentId)
  initial.nextProactiveCheckAt = settings.proactive ? 0 : clock.value + 86_400_000
  initial.wakeConfig.triggers = { ...initial.wakeConfig.triggers, probability: 0, question: false, nameMention: false, anyMessage: false }
  await redis.storage.set(simulationSessionKey(key), JSON.stringify(initial))
  const definitions = [...createAgentInteractionTools({ enabled: settings.enabled !== false }), ...(settings.tools ?? [])]
  let runtime, round = 0, toolReady = settings.support !== false
  const registry = createAgentTools({ builtIn: definitions }, {
    signal: new AbortController().signal,
    context(event) {
      contexts.push(event)
      return { binding: event._agentBinding, actor: { kind: event.simulationActor.kind, ...(event.simulationActor.userId ? { user: { ...account, id: event.simulationActor.userId } } : {}) },
        request: event._agentToolRequest, botUserId: account.id, isCurrent: event._isAgentBindingCurrent, ensureCurrent: event._ensureAgentToolCurrent,
        listMembers: async () => ({ target, observedAt: clock.value, complete: true, members: [{ user: actor, displayName: '来源作者' }] }),
        readMember: async id => id === actor.id ? { target, observedAt: clock.value, member: { user: actor, displayName: '来源作者' } } : undefined,
        ...(event._interactAgentTool ? { interact: (plan, current, signal, ensure) => event._interactAgentTool(plan, current, signal, ensure) } : {}),
        ...(event._readAgentHistory ? { readHistory: (input, current, signal) => event._readAgentHistory(input, current, signal) } : {}),
        ...(event._sendAgentToolMessage ? { sendMessage: (message, current) => event._sendAgentToolMessage(message, current) } : {}),
      }
    },
  })
  const f = { ...redis, clock, account, target, actor, binding, key, requests, interactions, sends, observed, episodes, groupReplies, errors, contexts,
    mode: '', phase: 'first', setSupport(value) { toolReady = value },
    session: async () => JSON.parse(await redis.storage.get(simulationSessionKey(key))),
    async run(text = '戳我一下。', extra = {}) {
      round = 0; const before = requests.length, id = `human-source-${++sequence}`, occurredAt = clock.value - 300_000
      await runtime.ingest({ version: 1, conversation: target, sender: actor, senderName: '来源作者', messageId: id, occurredAt,
        text, parts: [{ kind: 'text', text }], mentions: [account], directedToAccount: true, ...extra })
      await waitFor(async () => requests.length > before && !(await runtime.describeGroup(key)).running, () => `interaction human turn did not settle: ${errors.join('|')}`)
      await runtime.drain(); return { messageId: id, author: actor, occurredAt, text }
    },
    async background() {
      await runtime.ingest({ version: 1, conversation: target, sender: actor, senderName: '来源作者', messageId: `background-${++sequence}`, occurredAt: clock.value,
        text: '普通聊天背景。', parts: [{ kind: 'text', text: '普通聊天背景。' }], mentions: [], directedToAccount: false })
      await runtime.drain()
    },
    async sweep(ms = 120000) {
      const before = requests.length; round = 0; clock.value += ms; await runtime.sweepOnce()
      await waitFor(async () => requests.length > before && !(await runtime.describeGroup(key)).running, () => `interaction autonomous turn did not settle: ${errors.join('|')}`)
      await runtime.drain()
    },
  }
  runtime = createSimulationRuntime({
    redis: redis.storage, now: () => clock.value, random: () => 0.99, durableIngress: true,
    logger: { info() {}, warn(...args) { errors.push(args.join(' ')) }, error(...args) { errors.push(args.join(' ')) } },
    handlesTarget: () => true, allowsConversationAI: () => true, isAccountReady: () => true,
    getSelf: () => ({ id: account.id, name: '角色' }), getPersona: () => ({ binding, personaId: agentPersonaScopeId(binding.agentId), persona: { name: '角色' }, systemContent: '' }),
    getSection: () => ({ enabled: true, allGroups: true, reflection: { enabled: false }, consistency: { enabled: false }, rhythm: { enabled: false }, mood: { enabled: false },
      wakeGate: { enabled: false }, userStyle: { enabled: false }, meme: { enabled: false }, personProfile: { enabled: false }, lifeThreads: { enabled: false },
      wake: { probability: 0, proactiveProbability: settings.proactive ? 1 : 0, proactiveIdleMs: 60000, proactiveCheckMinMs: 60000, proactiveCheckMaxMs: 60000, batchWindowMs: 1000, maxWakePerMinute: 100, maxWakePerHour: 100 },
      turn: { minSendGapMs: 0, maxSendsPerTurn: 10, maxToolRounds: 12, maxTurnsPerDay: 100 }, toolPolicy: { mode: 'open' } }),
    getExecutionConfig: () => ({ useTools: true }), extraToolsPlatformNeutral: true,
    ...registry,
    ...(settings.enabled !== false && settings.port !== false ? { supportsInteractions: () => toolReady, async performInteractions(input) {
      await input.ensureCurrent(); assert.equal(input.isCurrent(), true); assert.equal(input.signal.aborted, false)
      interactions.push(input)
      return settings.perform ? settings.perform(input, f) : { state: 'confirmed', completed: input.plan.operations.length, requested: input.plan.operations.length }
    } } : {}),
    ...(settings.history ? { readHistory: async () => ({ text: '临时历史正文不可外发', isCurrent: async () => true }) } : {}),
    messageActions: { async send(action, guard) { assert.equal(guard.isCurrent(), true); sends.push(action); return { state: 'sent', messageId: `text-${sends.length}` } } },
    recordToolResult: value => observed.push(value), recordEpisode: value => episodes.push(value), recordGroupReply: value => groupReplies.push(value),
    async YTapi(request) { requests.push(structuredClone(request)); return settings.script ? settings.script(round++, f, request) : round++ === 0 ? response(call(f.mode || 'pokeTool', f.mode === 'likeTool' ? { count: 3 } : f.mode === 'reactionTool' ? { count: 1 } : { times: 1 })) : response(finish()) },
  })
  f.runtime = runtime
  t.after(async () => { runtime.stop(); await runtime.drain() })
  return f
}

test('simulation human tools preserve exact trigger text, author and occurrence time at the Core interaction boundary', redisTest, async t => {
  const f = await fixture(t)
  for (const [tool, text] of [['pokeTool', '戳我一下。'], ['likeTool', '给我点3个赞。'], ['reactionTool', '给本条消息贴一个表情。']]) {
    f.mode = tool; const source = await f.run(text), input = f.interactions.at(-1)
    assert.deepEqual(input.source, source); assert.equal(input.identity, 'human:' + source.messageId)
    assert.deepEqual(input.binding, f.binding); assert.deepEqual(input.target, f.target)
    assert.ok(input.signal instanceof AbortSignal); assert.equal(typeof input.ensureCurrent, 'function')
    assert.equal(input.source.occurredAt < f.clock.value, true, 'processing time must not replace source time')
  }
  assert.deepEqual(f.interactions.map(input => input.plan.kind), ['poke', 'profile-like', 'message-reaction'])
  assert.equal(f.interactions[1].plan.operations[0].count, 3)
  assert.deepEqual(f.sends, []); assert.deepEqual(f.episodes, [])
  const session = await f.session(); assert.deepEqual(session.confirmedMessageIds ?? [], []); assert.equal(session.lastConfirmedChat, undefined)
  assert.equal(session.recent.some(row => row.userId === f.account.id), false)
})

test('autonomous neutral poke retains six per hour while never borrowing human like or reaction authority', redisTest, async t => {
  const f = await fixture(t, { proactive: true, script(round, f, request) {
    const exposed = (request.tools ?? []).map(row => row.function.name)
    assert.equal(exposed.includes('simSendPoke'), true)
    for (const name of names) assert.equal(exposed.includes(name), false, name)
    if (f.phase === 'first' && round < 7) return response(call('simSendPoke', { userId: f.actor.id }))
    if (f.phase === 'after-hour' && round === 0) return response(call('simSendPoke', { userId: f.actor.id }))
    return response(finish())
  } })
  await f.background(); assert.equal(f.requests.length, 0); await f.sweep()
  assert.equal(f.interactions.length, 6, JSON.stringify({ errors: f.errors, toolResults: f.requests.at(-1).messages.filter(message => message.role === 'tool').slice(-4) })); assert.ok(f.interactions.every(input => input.source === undefined && input.identity.startsWith('turn:') && input.plan.kind === 'poke'))
  assert.match(JSON.stringify(f.requests.at(-1)), /本小时.*6|上限/u)
  f.clock.value += 3_600_001; await f.background(); f.phase = 'after-hour'; await f.sweep(); assert.equal(f.interactions.length, 7)
  assert.deepEqual(f.sends, []); assert.deepEqual(f.episodes, []); assert.deepEqual((await f.session()).confirmedMessageIds ?? [], [])
})

test('unknown simulation interaction blocks later native and text actions without manufacturing a message confirmation', redisTest, async t => {
  const probeResults = [], probe = { name: 'interactionProbeTool', description: '互动未知回执验证', parameters: schema, async execute(_input, context) {
    const plan = { version: 1, kind: 'poke', operations: [{ kind: 'poke', user: context.actor.user }] }
    probeResults.push(await context.interact(plan))
    await assert.rejects(context.interact(plan), /未知/u)
    await assert.rejects(context.sendMessage({ text: '未知后不许文字补发' }), /未知/u)
    return { status: 'unknown', content: '本次互动结果未知' }
  } }
  const f = await fixture(t, { tools: [probe], perform: input => ({ state: 'unknown', completed: 0, requested: input.plan.operations.length }),
    script: round => round === 0 ? response(call(probe.name), call('simSendMessage', { messages: ['本轮不许后续文字'] })) : response(finish()) })
  await f.run(); assert.equal(f.interactions.length, 1); assert.deepEqual(probeResults, [{ state: 'unknown', completed: 0, requested: 1 }])
  assert.deepEqual(f.sends, []); assert.deepEqual(f.episodes, []); assert.deepEqual((await f.session()).confirmedMessageIds ?? [], [])
})

test('ephemeral Agent tools receive no interaction port and history reads fence later interaction attempts', redisTest, async t => {
  const checks = [], ephemeral = { name: 'ephemeralInteractionProbe', description: '临时资料能力验证', parameters: schema, dataPolicy: 'ephemeral', async execute(_args, context) {
    checks.push(context.interact); return { status: 'succeeded', content: '临时资料正文不可外发' }
  } }
  const history = { name: 'historyInteractionProbe', description: '历史资料能力验证', parameters: schema, async execute(_args, context) {
    assert.equal(typeof context.interact, 'function'); assert.equal(await context.readHistory({}), '临时历史正文不可外发')
    await assert.rejects(context.interact({ version: 1, kind: 'poke', operations: [{ kind: 'poke', user: context.actor.user }] }), /临时资料/u)
    checks.push('history-blocked'); return { status: 'succeeded', content: '历史读取后未执行互动' }
  } }
  for (const tool of [ephemeral, history]) {
    const f = await fixture(t, { tools: [tool], history: true, script: round => round === 0 ? response(call(tool.name)) : round === 1 ? response(call('pokeTool', { times: 1 }), call('simSendPoke', { userId: 'human' })) : response(finish()) })
    await f.run(); assert.deepEqual(f.interactions, []); assert.deepEqual(f.sends, []); assert.deepEqual(f.episodes, [])
    assert.doesNotMatch(JSON.stringify((await f.session()).agentHistory), /临时资料正文不可外发|临时历史正文不可外发/u)
  }
  assert.deepEqual(checks, [undefined, 'history-blocked'])
})

test('simulation capability checks hide scoped poke without an enabled current interaction port', redisTest, async t => {
  for (const settings of [{ enabled: false }, { port: false }, { support: false }]) {
    const f = await fixture(t, { ...settings, script(_round, _f, request) {
      assert.equal(request.tools.some(row => row.function.name === 'simSendPoke'), false); return response(finish())
    } })
    await f.run(); assert.deepEqual(f.interactions, [])
  }
})

test('Core simulation omits all human interactions and scoped poke when disabled or the adapter has no interaction action', redisTest, async t => {
  for (const settings of [{ enabled: false, port: true }, { enabled: true, port: false }]) {
    const redis = await createAgentRedisFixture(t, 'simulation-interactions-capability')
    const account = { platform: 'fixture', namespace: 'sim-capability', id: 'robot' }, target = { account, kind: 'group', id: 'room' }, requests = [], errors = []
    const directory = createAgentBindingDirectory({ version: 1, agents: [{ id: 'role', personaId: 'default' }], connections: [{ id: 'main', platform: account.platform, namespace: account.namespace, accountId: account.id }], bindings: [{ connectionId: 'main', kind: 'group', conversationId: target.id, agentId: 'role' }] }, 'capability-revision')
    const initial = createDefaultSimSession(Date.now()), binding = directory.resolve(target)
    initial.bootstrapSent = true; initial.botId = account.id; initial.bindingToken = agentBindingToken(binding); initial.personaId = agentPersonaScopeId(binding.agentId)
    initial.nextProactiveCheckAt = Date.now() + 86_400_000
    await redis.storage.set(simulationSessionKey(simulationAddressKey(target)), JSON.stringify(initial))
    let ready = false, accept
    const host = createAgentRuntime({ storage: redis.storage, isExecutionCurrent: redis.isCurrent,
      adapters: [{ id: 'main', account, botUserId: account.id, botName: '角色', isReady: () => ready, start(callback) { accept = callback; ready = true }, stop() { ready = false },
        actions: { async send() { assert.fail('capability probe cannot send') }, ...(settings.port ? { async interact() { assert.fail('disabled probe cannot interact') } } : {}) } }],
      interactions: { enabled: settings.enabled }, memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, groupMemory: { enabled: false },
      logger: { info() {}, warn(...args) { errors.push(args.join(' ')) }, error(...args) { errors.push(args.join(' ')) } }, resolvePersona: address => ({ binding: directory.resolve(address), persona: { name: '角色' }, systemContent: '' }),
      getSection: () => ({ enabled: true, allGroups: true, reflection: { enabled: false }, rhythm: { enabled: false }, mood: { enabled: false },
        personProfile: { enabled: false }, meme: { enabled: false }, wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000 }, turn: { minSendGapMs: 0 }, toolPolicy: { mode: 'open' } }), getExecutionConfig: () => ({ useTools: true }),
      async YTapi(request) { requests.push(request); for (const name of [...names, 'simSendPoke']) assert.equal(request.tools.some(row => row.function.name === name), false, name); return response(finish()) },
    })
    try {
      await host.start(); await accept({ kind: 'message', message: { version: 1, conversation: target, sender: { ...account, id: 'human' }, messageId: 'capability-source', occurredAt: Date.now(), text: '检查互动工具。', parts: [{ kind: 'text', text: '检查互动工具。' }], mentions: [account], directedToAccount: true } })
      await waitFor(() => requests.length > 0, () => `Core simulation capability request missing: ${errors.join('|')}`); await host.runtime.drain()
    } finally { await host.stop() }
  }
})
