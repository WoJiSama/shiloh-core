import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { createAgentRuntime } = await load('core/agentRuntime.js')
const { createAgentBindingDirectory, agentBindingToken, agentPersonaScopeId, conversationAddressKey, platformAccountKey } = await load('modules/runtime/domain/agentBindings.js')
const { createAgentDiagnostics } = await load('modules/runtime/infrastructure/agentDiagnostics.js')
const { createTextPersonMemoryStore } = await load('modules/memory/infrastructure/textPersonMemoryStore.js')
const { createConversationMemoryStore, conversationMemoryId } = await load('modules/memory/infrastructure/conversationMemoryStore.js')
const { createDefaultSimSession } = await load('modules/simulation/domain/simConfig.js')
const { simulationAddressKey } = await load('modules/simulation/infrastructure/simulationAddress.js')
const { simulationSessionKey, simulationBusyKey } = await load('modules/simulation/infrastructure/simSessionStore.js')
const redisTest = { skip: !redisAvailable, timeout: 25_000 }
const toolNames = ['pokeTool', 'likeTool', 'reactionTool']
const names = request => request.tools?.map(tool => tool.function.name) ?? []
const call = (name, args = {}) => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [
  { id: name + '-call', type: 'function', function: { name, arguments: JSON.stringify(args) } },
] } }] })
const answer = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const finish = () => call('simFinishTurn', { choice: 'silent', reason: '互动专项验证结束' })
const sourceKey = (target, id) => JSON.stringify([conversationAddressKey(target), id])
const deferred = () => Promise.withResolvers()
let fixtureId = 0
async function waitFor(probe, detail = () => '') {
  const deadline = performance.now() + 8000
  while (performance.now() < deadline) { if (await probe()) return; await delay(10) }
  assert.fail('interaction Core fixture did not settle: ' + detail())
}

async function fixture(t, settings = {}) {
  let host, f
  t.after(async () => { settings.release?.(); await host?.stop() })
  const redis = await createAgentRedisFixture(t, 'interaction-core-runtime')
  const account = { platform: 'fixture', namespace: 'interactions-' + ++fixtureId, id: 'robot' }, sender = { ...account, id: 'human' }, friend = { ...account, id: 'friend' }
  const group = { account, kind: 'group', id: 'room' }, otherGroup = { ...group, id: 'other-room' }, privateTarget = { account, kind: 'private', id: sender.id }
  const config = { version: 1, agents: [{ id: 'role', personaId: 'default' }, { id: 'replacement', personaId: 'default' }],
    connections: [{ id: 'connection', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: [group, otherGroup, privateTarget].map(target => ({ connectionId: 'connection', kind: target.kind, conversationId: target.id, agentId: 'role' })) }
  let directory = createAgentBindingDirectory(config, 'interactions-initial'), accept, ready = false, sequence = 0, clock = Date.now(), current = true
  const sources = new Map(), requests = [], attempts = [], effects = [], sends = [], reads = [], memberReads = [], lists = [], events = [], logs = [], extractions = []
  const members = [
    { user: sender, displayName: '真人群友', role: 'member' }, { user: friend, displayName: '另一位群友', role: 'member' }, { user: account, displayName: '机器人', role: 'member' },
  ]
  const logger = { info: line => logs.push(line), warn: line => logs.push(line), error: line => logs.push(line) }
  const diagnostics = createAgentDiagnostics({ logger, now: () => clock, sink: { async append(event) { events.push(event); return true } } })
  const queueKeys = ['group-text', 'private', 'privacy', 'simulation', 'group-log'].map(kind => redis.prefix + `agent:inbox:${kind}:${platformAccountKey(account)}`)
  if (settings.simulation) {
    const initial = createDefaultSimSession(clock), binding = directory.resolve(group)
    initial.bootstrapSent = true; initial.botId = account.id; initial.bindingToken = agentBindingToken(binding); initial.personaId = agentPersonaScopeId(binding.agentId)
    initial.nextProactiveCheckAt = settings.proactive ? 0 : clock + 86_400_000
    initial.wakeConfig.triggers = { ...initial.wakeConfig.triggers, probability: 0, question: false, nameMention: false, anyMessage: false }
    await redis.storage.set(simulationSessionKey(simulationAddressKey(group)), JSON.stringify(initial))
  }
  function makeHost() {
    const actions = {
      async send(action, guard) {
        if (!guard.isCurrent()) return { state: 'failed', code: 'stale' }
        sends.push(structuredClone(action)); return { state: 'sent', messageId: 'text-' + ++sequence }
      },
      ...(settings.port === false ? {} : { async interact(action, guard) {
        attempts.push({ action: structuredClone(action), guard })
        if (settings.interact) return settings.interact(action, guard, f)
        await guard.ensureCurrent?.()
        if (guard.signal?.aborted || !guard.isCurrent()) return { state: 'failed', code: 'stale' }
        effects.push(structuredClone(action)); return settings.receipt ?? { state: 'confirmed' }
      } }),
    }
    return createAgentRuntime({ storage: redis.storage, isExecutionCurrent: redis.isCurrent, now: () => clock, diagnostics,
      interactions: { enabled: settings.enabled !== false }, isInteractionsCurrent: () => current,
      privateChatEnabled: true, useTextGroup: target => target.kind === 'group' && !settings.simulation, textGroupRevision: 'interaction-text-config',
      groupTextTools: target => target.id === group.id ? settings.tools ?? toolNames : [],
      ...(settings.history ? { history: { enabled: true, retentionDays: 30, maxMessagesPerConversation: 100 } } : {}),
      memorySystem: { enabled: true, userExtractDebounceSeconds: 0, userExtractMaxBatchMessages: 1 },
      async personProfileExtract(messages) { extractions.push(structuredClone(messages)); return '[]' },
      adapters: [{ id: 'connection', account, botUserId: account.id, botName: '中立互动验证', isReady: () => ready,
        async start(consume) { accept = consume; ready = true }, stop() { ready = false }, actions,
        ...(settings.readPort === false ? {} : { async readMessage(target, id, guard) {
          reads.push({ target: structuredClone(target), id }); await settings.read?.(target, id, f)
          if (guard?.isCurrent?.() === false) return undefined
          return structuredClone(sources.get(sourceKey(target, id)))
        } }),
        async listConversationMembers(target, guard) {
          lists.push({ target: structuredClone(target), guard })
          return guard.isCurrent() ? { target: structuredClone(target), observedAt: Date.now(), complete: true, members: structuredClone(members) } : undefined
        },
        async readConversationMember(target, user, guard) {
          memberReads.push({ target: structuredClone(target), user: structuredClone(user), guard }); await settings.member?.(target, user, f)
          const found = members.find(member => member.user.id === user.id)
          return guard.isCurrent() && found ? { target: structuredClone(target), observedAt: Date.now(), member: structuredClone(found) } : undefined
        },
      }],
      logger,
      resolvePersona(target) { const binding = directory.resolve(target); return binding && { binding, persona: { name: '互动角色' }, systemContent: '合成互动专项测试' } },
      getSection: () => ({ enabled: true, allGroups: true, reflection: { enabled: false }, consistency: { enabled: false }, wakeGate: { enabled: false },
        rhythm: { enabled: false }, mood: { enabled: false }, personProfile: { enabled: false }, meme: { enabled: false }, userStyle: { enabled: false }, lifeThreads: { enabled: false },
        wake: { probability: 0, proactiveProbability: settings.proactive ? 1 : 0, proactiveIdleMs: 60_000, batchWindowMs: 1000, maxWakePerMinute: 100, maxWakePerHour: 100 },
        turn: { minSendGapMs: 0, maxTurnsPerDay: 1000, maxToolRounds: 5, maxSendsPerTurn: 3 }, toolPolicy: { mode: 'open' } }),
      getExecutionConfig: () => ({ providers: 'openai', useTools: true }),
      async YTapi(request, _config, signal, isCurrent, ensureCurrent) {
        await ensureCurrent?.(); if (signal?.aborted || isCurrent?.() === false) throw Error('stale interaction model')
        requests.push(structuredClone(request))
        return settings.model ? settings.model(request, requests.length, f) : settings.simulation
          ? requests.length === 1 ? call('pokeTool', { target: sender.id }) : finish() : call('pokeTool', { target: sender.id })
      },
    })
  }
  f = { ...redis, account, sender, friend, group, otherGroup, privateTarget, sources, requests, attempts, effects, sends, reads, memberReads, lists, events, logs, extractions,
    get host() { return host }, binding: (target = group) => directory.resolve(target), disable() { current = false },
    rebind() { directory = createAgentBindingDirectory({ ...config, bindings: config.bindings.map(binding => ({ ...binding, agentId: 'replacement' })) }, 'interactions-rebound') },
    message(text = '请戳我一下', extra = {}) { return { version: 1, conversation: group, sender, messageId: 'source-' + ++sequence, occurredAt: ++clock, text,
      parts: [{ kind: 'text', text }], mentions: [account], directedToAccount: true, ...extra } },
    async emit(message) { sources.set(sourceKey(message.conversation, message.messageId), structuredClone(message)); await accept({ kind: 'message', message: structuredClone(message) }) },
    async recall(message) { sources.delete(sourceKey(message.conversation, message.messageId)); await accept({ kind: 'recall', target: message.conversation, messageId: message.messageId }) },
    async drained() {
      await waitFor(async () => Number(await redis.reader.eval("local total = 0; for _, key in ipairs(KEYS) do total = total + redis.call('LLEN', key) end; return total", { keys: queueKeys, arguments: [] })) === 0,
        () => JSON.stringify(events.slice(-5)))
      await host.runtime.drain()
      if (settings.simulation) await waitFor(async () => !await redis.reader.exists(redis.prefix + simulationBusyKey(simulationAddressKey(group))), () => logs.join('\n'))
    },
    async send(text, extra) {
      const before = requests.length, message = f.message(text, extra); await f.emit(message)
      if (settings.simulation && message.directedToAccount) await waitFor(() => requests.length > before, () => logs.join('\n'))
      await f.drained(); return message
    },
    async restart() { await host.stop(); host = makeHost(); await host.start() },
    async session() { return JSON.parse(await redis.storage.get(simulationSessionKey(simulationAddressKey(group))) || 'null') },
    async sweep() {
      const before = requests.length; clock += 2 * 60 * 60_000; await host.runtime.sweepOnce()
      await waitFor(async () => requests.length > before && !await redis.reader.exists(redis.prefix + simulationBusyKey(simulationAddressKey(group))), () => logs.join('\n'))
      await host.runtime.drain()
    },
    async raw(pattern = '*') {
      const rows = []
      for (const key of await redis.reader.keys(redis.prefix + pattern)) if (await redis.reader.type(key) === 'string') rows.push([key.slice(redis.prefix.length), await redis.reader.get(key)])
      return JSON.stringify(rows)
    },
    async assertNoTextLearning() {
      await host.resumePendingWork()
      assert.equal(extractions.length, 0)
      assert.deepEqual(await createTextPersonMemoryStore(redis.storage).list(), [])
      const narrative = await createConversationMemoryStore(redis.storage).load(conversationMemoryId(f.binding()))
      assert.deepEqual(narrative?.episodes ?? [], [])
      assert.equal((await f.raw()).includes('confirmed-text'), false)
    },
  }
  host = makeHost(); await host.start(); return f
}

for (const scenario of [
  { name: 'pokeTool', text: '请戳我两次', args: { target: 'human', times: 2 }, kind: 'poke', amount: 2 },
  { name: 'likeTool', text: '给我的资料点三个赞', args: { count: 3 }, kind: 'profile-like', amount: 1 },
  { name: 'reactionTool', text: '给这条消息贴两个表情', args: { count: 2 }, kind: 'message-reaction', amount: 2 },
]) test(`text Core ${scenario.name} owns one fixed interaction plan and confirms without text learning`, redisTest, async t => {
  const f = await fixture(t, { model: () => call(scenario.name, scenario.args) }), original = await f.send(scenario.text)
  assert.equal(f.requests.length, 1); assert.ok(names(f.requests[0]).includes(scenario.name))
  assert.equal(f.effects.length, scenario.amount); assert.equal(f.sends.length, 0)
  for (const effect of f.effects) {
    assert.deepEqual(effect.target, f.group); assert.deepEqual(effect.binding, f.binding()); assert.equal(effect.interaction.kind, scenario.kind)
    if (scenario.kind === 'message-reaction') { assert.equal(effect.interaction.messageId, original.messageId); assert.match(effect.interaction.emojiId, /^[1-9]\d{0,5}$/u) }
    else { assert.deepEqual(effect.interaction.user, f.sender); if (scenario.kind === 'profile-like') assert.equal(effect.interaction.count, 3) }
  }
  assert.ok(f.reads.some(read => read.id === original.messageId)); assert.ok((await f.raw()).includes('confirmed-action'))
  await f.emit(original); await f.drained(); await f.restart(); await f.emit(original); await f.drained()
  assert.equal(f.effects.length, scenario.amount); assert.equal(f.requests.length, 1); assert.equal(f.sends.length, 0)
  await f.assertNoTextLearning()
})

test('text Core unknown interaction freezes duplicate entries and restart with no explanation, confirmation or learning', redisTest, async t => {
  const f = await fixture(t, { receipt: { state: 'unknown' } }), message = await f.send()
  await f.emit(message); await f.drained(); await f.restart(); await f.emit(message); await f.drained()
  assert.equal(f.effects.length, 1); assert.equal(f.requests.length, 1); assert.equal(f.sends.length, 0)
  assert.ok(f.events.some(event => event.operation === 'interaction' && event.outcome === 'unknown'))
  assert.equal((await f.raw()).includes('confirmed-action'), false); await f.assertNoTextLearning()
})

test('text Core partial interaction preserves one confirmed prefix, stops on definitive failure and never explains or replays it', redisTest, async t => {
  const f = await fixture(t, {
    model: () => call('pokeTool', { target: 'human', times: 3 }),
    async interact(action, guard, run) {
      await guard.ensureCurrent()
      if (run.attempts.length === 1) { run.effects.push(structuredClone(action)); return { state: 'confirmed' } }
      return { state: 'failed', code: 'native_rejected' }
    },
  })
  const original = await f.send('请戳我三次')
  assert.equal(f.attempts.length, 2); assert.equal(f.effects.length, 1)
  assert.equal(f.requests.length, 1); assert.equal(f.sends.length, 0)
  const records = []
  for (const key of await f.reader.keys(f.prefix + 'agent:interaction:v1:*')) records.push(JSON.parse(await f.reader.get(key)))
  assert.equal(records.length, 1)
  assert.deepEqual({ state: records[0].state, completed: records[0].completed, requested: records[0].requested }, { state: 'failed', completed: 1, requested: 3 })
  await f.emit(original); await f.drained(); await f.restart(); await f.emit(original); await f.drained()
  assert.equal(f.attempts.length, 2); assert.equal(f.effects.length, 1)
  assert.equal(f.requests.length, 1); assert.equal(f.sends.length, 0)
  await f.assertNoTextLearning()
})

test('text Core history evidence cannot authorize a later model-invented interaction', redisTest, async t => {
  const f = await fixture(t, { history: true, model: (_request, index) => index === 1
    ? call('chatHistoryTool', { question: '之前谁想被戳', source: 'recent' }) : call('pokeTool', { target: 'human' }) })
  await f.send('请查历史看看之前谁想被戳')
  assert.equal(f.requests.length, 2)
  assert.ok(f.requests[1].messages.some(message => message.role === 'tool' && message.name === 'chatHistoryTool'))
  assert.equal(names(f.requests[1]).some(name => toolNames.includes(name)), false)
  assert.equal(f.attempts.length, 0); assert.equal(f.effects.length, 0); assert.equal(f.sends.length, 0)
  await f.assertNoTextLearning()
})

for (const scenario of [
  { name: 'likeTool', text: '给引用的人点赞', args: { count: 2 }, kind: 'profile-like' },
  { name: 'pokeTool', text: '戳一下引用的他', args: {}, kind: 'poke' },
]) test(`text Core ${scenario.name} resolves the quoted friend instead of defaulting to the current actor`, redisTest, async t => {
  const f = await fixture(t, { model: () => call(scenario.name, scenario.args) })
  const quoted = f.message('另一位群友的原始发言', { sender: f.friend, directedToAccount: false, mentions: [] })
  await f.emit(quoted); await f.drained(); assert.equal(f.requests.length, 0, 'the quoted friend is admitted without waking a model')
  await f.send(scenario.text, { quote: { messageId: quoted.messageId, author: f.friend, parts: [] } })
  assert.equal(f.requests.length, 1); assert.equal(f.attempts.length, 1); assert.equal(f.effects.length, 1); assert.equal(f.sends.length, 0)
  assert.deepEqual(f.effects[0].interaction, { kind: scenario.kind, user: f.friend, ...(scenario.kind === 'profile-like' ? { count: 2 } : {}) })
  assert.notEqual(f.effects[0].interaction.user.id, f.sender.id)
  assert.ok(f.reads.some(read => read.id === quoted.messageId && conversationAddressKey(read.target) === conversationAddressKey(f.group)))
  await f.assertNoTextLearning()
})

for (const name of ['likeTool', 'pokeTool']) for (const revoke of ['recall', 'author']) {
  test(`text Core ${name} refuses quote ${revoke} changes after resolving the quoted friend and before dispatch`, redisTest, async t => {
    let quoted, changed = false
    const f = await fixture(t, { model: () => call(name), async member(_target, user, run) {
      if (changed || user.id !== run.friend.id) return
      assert.ok(run.reads.some(read => read.id === quoted.messageId), 'the quoted source must be resolved before member proof')
      changed = true
      if (revoke === 'recall') await run.recall(quoted)
      else run.sources.set(sourceKey(quoted.conversation, quoted.messageId), { ...quoted, sender: run.sender })
    } })
    quoted = f.message('另一位群友的原始发言', { sender: f.friend, directedToAccount: false, mentions: [] })
    await f.emit(quoted); await f.drained(); assert.equal(f.requests.length, 0)
    await f.send(name === 'likeTool' ? '给引用的人点赞' : '戳一下引用的他', { quote: { messageId: quoted.messageId, author: f.friend, parts: [] } })
    assert.equal(changed, true, 'the source is revoked only after resolving its original author')
    assert.equal(f.attempts.length, 0); assert.equal(f.effects.length, 0)
    assert.ok(f.reads.some(read => read.id === quoted.messageId))
    assert.equal(f.requests.length, 1, 'an invalidated pinned quote cannot authorize a failure-explanation model')
    assert.equal(f.sends.length, 0, 'an invalidated pinned quote cannot authorize explanation text')
  })
}

for (const name of ['likeTool', 'pokeTool']) test(`text Core ${name} stops all model calls when the pinned quote author changes before member proof`, redisTest, async t => {
  let quoted, changed = false
  const f = await fixture(t, { model: () => call(name), read(target, id, run) {
    if (changed || id !== quoted?.messageId || !run.lists.length) return
    // listMembers is invoked only after its guard has resolved and pinned the quote.
    changed = true
    run.sources.set(sourceKey(target, id), { ...quoted, sender: run.sender })
  } })
  quoted = f.message('另一位群友的原始发言', { sender: f.friend, directedToAccount: false, mentions: [] })
  await f.emit(quoted); await f.drained()
  await f.send(name === 'likeTool' ? '给引用的人点赞' : '戳一下引用的他', { quote: { messageId: quoted.messageId, author: f.friend, parts: [] } })
  assert.equal(changed, true); assert.equal(f.lists.length, 1)
  assert.equal(f.memberReads.length, 0); assert.equal(f.attempts.length, 0); assert.equal(f.effects.length, 0)
  assert.equal(f.requests.length, 1, 'a revoked pinned quote cannot authorize an explanation model')
  assert.equal(f.sends.length, 0)
})

for (const field of ['text', 'time', 'author', 'conversation']) test(`text Core rejects a freshly read trigger with substituted ${field}`, redisTest, async t => {
  let replaced = false
  const f = await fixture(t, { read(target, id, run) {
    if (replaced) return; replaced = true
    const key = sourceKey(target, id), previous = run.sources.get(key)
    run.sources.set(key, { ...previous, ...(field === 'text' ? { text: '被替换的真人请求' } : field === 'time' ? { occurredAt: previous.occurredAt + 1 }
      : field === 'author' ? { sender: run.friend } : { conversation: run.otherGroup }) })
  } })
  await f.send(); assert.equal(replaced, true); assert.equal(f.requests.length, 1)
  assert.equal(f.attempts.length, 0); assert.equal(f.effects.length, 0); assert.equal(f.sends.length, 0)
})

for (const revoke of ['source', 'recall', 'config', 'binding']) test(`text Core ${revoke} revocation reaches the consumer final asynchronous check`, redisTest, async t => {
  const entered = deferred(), held = deferred(), finished = deferred()
  const f = await fixture(t, { release() { held.resolve() }, async interact(_action, guard, run) {
    entered.resolve(guard); await held.promise
    try {
      await assert.rejects(guard.ensureCurrent())
      assert.equal(run.effects.length, 0); finished.resolve()
      return { state: 'failed', code: 'source_unavailable' }
    } catch (error) { finished.reject(error); throw error }
  } })
  const message = f.message(); await f.emit(message); const guard = await entered.promise
  if (revoke === 'source') f.sources.set(sourceKey(message.conversation, message.messageId), { ...message, text: '排队后被替换的请求' })
  else if (revoke === 'recall') await f.recall(message); else if (revoke === 'config') f.disable(); else f.rebind()
  held.resolve(); await finished.promise; await f.drained()
  assert.equal(f.attempts.length, 1); assert.equal(f.effects.length, 0); assert.equal(f.sends.length, 0)
  assert.ok(guard.signal instanceof AbortSignal)
})

test('text Core only declares each group selected interaction tools and excludes private chats', redisTest, async t => {
  const f = await fixture(t, { tools: ['pokeTool'], model: () => answer('普通回复') })
  await f.send('本群普通对话'); assert.ok(names(f.requests[0]).includes('pokeTool')); assert.equal(names(f.requests[0]).includes('likeTool'), false)
  await f.send('另一个群普通对话', { conversation: f.otherGroup }); assert.equal(names(f.requests[1]).some(name => toolNames.includes(name)), false)
  await f.send('好友普通私聊', { conversation: f.privateTarget }); assert.equal(names(f.requests[2]).some(name => toolNames.includes(name)), false)
  assert.equal(f.effects.length, 0)
})

for (const settings of [{ enabled: false }, { port: false }, { readPort: false }]) test(`text Core unavailable interaction capability ${JSON.stringify(settings)} is never declared`, redisTest, async t => {
  const f = await fixture(t, { ...settings, model: () => answer('普通回复') })
  await f.send('普通群对话'); assert.equal(names(f.requests[0]).some(name => toolNames.includes(name)), false)
  assert.equal(f.attempts.length, 0); assert.equal(f.effects.length, 0)
})

test('simulation human poke uses the same neutral Core interaction workflow and never fabricates a message confirmation', redisTest, async t => {
  const f = await fixture(t, { simulation: true }), original = await f.send()
  assert.ok(names(f.requests[0]).includes('pokeTool')); assert.equal(f.effects.length, 1); assert.equal(f.sends.length, 0)
  assert.deepEqual(f.effects[0], { version: 1, kind: 'conversation.interact', target: f.group, binding: f.binding(), interaction: { kind: 'poke', user: f.sender } })
  assert.ok(f.reads.some(read => read.id === original.messageId))
  const session = await f.session(); assert.equal(session.sendTimes.length, 1); assert.deepEqual(session.confirmedMessageIds ?? [], [])
})

test('simulation unknown interaction freezes a subsequent explicit text send and duplicate inbox replay after restart', redisTest, async t => {
  const f = await fixture(t, { simulation: true, receipt: { state: 'unknown' }, model(_request, index, run) {
    return index === 1 ? call('pokeTool', { target: run.sender.id }) : index === 2
      ? call('simSendMessage', { continuation: 'chat', messages: ['未知互动后不得发布的额外说明'] }) : finish()
  } })
  const original = await f.send()
  assert.equal(f.effects.length, 1); assert.equal(f.sends.length, 0)
  assert.ok(f.events.some(event => event.operation === 'interaction' && event.outcome === 'unknown'))
  const previousRequests = f.requests.length
  await f.emit(original); await f.drained(); await f.restart(); await f.emit(original); await f.drained()
  assert.equal(f.effects.length, 1); assert.equal(f.sends.length, 0); assert.equal(f.requests.length, previousRequests)
  const session = await f.session(); assert.equal(session.sendTimes.length, 0); assert.deepEqual(session.confirmedMessageIds ?? [], [])
})

test('simulation autonomous poke uses a fresh member proof and an opaque neutral user ID without borrowing a human trigger', redisTest, async t => {
  let proactiveStarted = false
  const f = await fixture(t, { simulation: true, proactive: true, model(_request, _index, run) {
    if (!proactiveStarted) { proactiveStarted = true; return call('simSendPoke', { userId: run.friend.id }) }
    return finish()
  } })
  await f.send('普通背景消息', { directedToAccount: false, mentions: [] }); assert.equal(f.requests.length, 0)
  await f.sweep()
  assert.ok(names(f.requests[0]).includes('simSendPoke')); assert.equal(names(f.requests[0]).some(name => toolNames.includes(name)), false)
  assert.equal(f.effects.length, 1); assert.equal(f.sends.length, 0)
  assert.deepEqual(f.effects[0].interaction, { kind: 'poke', user: f.friend }); assert.deepEqual(f.effects[0].target, f.group)
  assert.ok(f.memberReads.some(read => read.user.id === f.friend.id)); assert.equal(f.reads.length, 0)
  const session = await f.session(); assert.equal(session.lastWakeReason.kind, 'proactiveCheck'); assert.equal(session.sendTimes.length, 1)
  assert.deepEqual(session.confirmedMessageIds ?? [], [])
})

test('simulation without an interaction port declares neither human interaction tools nor autonomous poke', redisTest, async t => {
  const f = await fixture(t, { simulation: true, proactive: true, port: false, model: () => finish() })
  await f.send(); assert.equal(names(f.requests[0]).some(name => toolNames.includes(name) || name === 'simSendPoke'), false)
  assert.equal(f.effects.length, 0); assert.equal(f.attempts.length, 0)
  const count = f.requests.length; await f.sweep()
  assert.ok(f.requests.length > count)
  assert.ok(f.requests.slice(count).every(request => names(request).every(name => !toolNames.includes(name) && name !== 'simSendPoke')))
})
