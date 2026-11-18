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
const managementNames = ['jinyanTool', 'changeCardTool']
const names = request => request.tools?.map(tool => tool.function.name) ?? []
const call = (name, args = {}) => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [
  { id: name + '-call', type: 'function', function: { name, arguments: JSON.stringify(args) } },
] } }] })
const answer = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const finish = () => call('simFinishTurn', { choice: 'silent', reason: '群管理运行测试结束' })
const sourceKey = (target, id) => JSON.stringify([conversationAddressKey(target), id])
const deferred = () => Promise.withResolvers()
let fixtureId = 0
async function waitFor(probe, detail = () => '') {
  const deadline = performance.now() + 7500
  while (performance.now() < deadline) { if (await probe()) return; await delay(10) }
  assert.fail('management Core fixture did not settle: ' + detail())
}
const detail = f => JSON.stringify({ requests: f.requests.length, reads: f.reads, memberReads: f.memberReads.map(read => read.user.id),
  events: f.events.filter(event => event.operation === 'interaction'), lastInput: f.requests.at(-1)?.messages.filter(message => message.role === 'user') })

async function fixture(t, settings = {}) {
  let host, f
  t.after(async () => { settings.release?.(); await host?.stop() })
  const redis = await createAgentRedisFixture(t, 'group-management-runtime')
  const account = { platform: 'fixture', namespace: 'management-' + ++fixtureId, id: 'robot' }
  const user = id => ({ ...account, id }), sender = user('human'), first = user('member-one'), second = user('member-two')
  const group = { account, kind: 'group', id: 'room' }, otherGroup = { ...group, id: 'other-room' }, privateTarget = { account, kind: 'private', id: sender.id }
  const config = { version: 1, agents: [{ id: 'role', personaId: 'default' }, { id: 'replacement', personaId: 'default' }],
    connections: [{ id: 'connection', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: [group, otherGroup, privateTarget].map(target => ({ connectionId: 'connection', kind: target.kind, conversationId: target.id, agentId: 'role' })) }
  let directory = createAgentBindingDirectory(config, 'management-initial'), accept, ready = false, sequence = 0, clock = Date.now(), current = true
  const sources = new Map(), requests = [], attempts = [], effects = [], sends = [], reads = [], memberReads = [], lists = [], events = [], logs = [], extractions = []
  const members = new Map([
    ['human', { user: sender, displayName: '请求人', role: settings.actorRole ?? 'admin' }],
    ['member-one', { user: first, displayName: '甲群友', role: settings.targetRole ?? 'member' }],
    ['member-two', { user: second, displayName: '乙群友', role: 'member' }],
    ['member-three', { user: user('member-three'), displayName: '丙群友', role: 'member' }],
    ['robot', { user: account, displayName: '机器人', role: settings.botRole ?? 'admin' }],
  ])
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
    return createAgentRuntime({ storage: redis.storage, isExecutionCurrent: redis.isCurrent, now: () => clock, diagnostics,
      interactions: { enabled: settings.enabled !== false }, isInteractionsCurrent: () => current,
      privateChatEnabled: true, useTextGroup: target => target.kind === 'group' && !settings.simulation,
      groupTextTools: target => target.id === group.id ? settings.tools ?? managementNames : [],
      ...(settings.privateTools ? { privateTextTools: settings.privateTools } : {}),
      memorySystem: { enabled: true, userExtractDebounceSeconds: 0, userExtractMaxBatchMessages: 1 },
      async personProfileExtract(messages) { extractions.push(structuredClone(messages)); return '[]' },
      logger,
      adapters: [{ id: 'connection', account, botUserId: account.id, botName: '群管理验证', isReady: () => ready,
        async start(consume) { accept = consume; ready = true }, stop() { ready = false },
        resolvePrivatePeer: () => sender,
        ...(settings.readPort === false ? {} : { async readMessage(target, id, guard) {
          reads.push(id); await settings.read?.(target, id, f)
          return guard?.isCurrent?.() === false ? undefined : structuredClone(sources.get(sourceKey(target, id)))
        } }),
        ...(settings.listPort === false ? {} : { async listConversationMembers(target, guard) {
          lists.push({ target: structuredClone(target) })
          return guard.isCurrent() ? { target: structuredClone(target), observedAt: Date.now(), complete: true, members: structuredClone([...members.values()]) } : undefined
        } }),
        ...(settings.memberPort === false ? {} : { async readConversationMember(target, selected, guard) {
          memberReads.push({ target: structuredClone(target), user: structuredClone(selected) }); await settings.member?.(target, selected, f)
          const found = members.get(selected.id)
          return guard.isCurrent() && found ? { target: structuredClone(target), observedAt: Date.now(), member: structuredClone(found) } : undefined
        } }),
        actions: {
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
        },
      }],
      resolvePersona(target) { const binding = directory.resolve(target); return binding && { binding, persona: { name: '群管理角色' }, systemContent: '合成群管理运行测试' } },
      getSection: () => ({ enabled: true, allGroups: true, reflection: { enabled: false }, consistency: { enabled: false }, wakeGate: { enabled: false },
        rhythm: { enabled: false }, mood: { enabled: false }, personProfile: { enabled: false }, meme: { enabled: false }, userStyle: { enabled: false }, lifeThreads: { enabled: false },
        wake: { probability: 0, proactiveProbability: settings.proactive ? 1 : 0, proactiveIdleMs: 60_000, batchWindowMs: 1000, maxWakePerMinute: 100, maxWakePerHour: 100 },
        turn: { minSendGapMs: 0, maxTurnsPerDay: 1000, maxToolRounds: 5, maxSendsPerTurn: 3 },
        toolPolicy: { mode: 'open', ...(settings.simulationAllow ? { allowTools: managementNames } : {}) } }),
      getExecutionConfig: () => ({ providers: 'openai', useTools: true }),
      async YTapi(request, _config, signal, isCurrent, ensureCurrent) {
        await ensureCurrent?.(); if (signal?.aborted || isCurrent?.() === false) throw Error('stale management model')
        requests.push(structuredClone(request))
        return settings.model ? settings.model(request, requests.length, f) : answer('普通群消息')
      },
    })
  }
  f = { ...redis, account, sender, first, second, group, otherGroup, privateTarget, members, sources, requests, attempts, effects, sends, reads, memberReads, lists, events, logs, extractions,
    get host() { return host }, binding: (target = group) => directory.resolve(target), disable() { current = false },
    role(id, role) { const member = members.get(id); if (member) member.role = role },
    rebind() { directory = createAgentBindingDirectory({ ...config, bindings: config.bindings.map(binding => ({ ...binding, agentId: 'replacement' })) }, 'management-rebound') },
    message(text, extra = {}) { return { version: 1, conversation: group, sender, messageId: 'human-' + ++sequence, occurredAt: ++clock, text,
      parts: [{ kind: 'text', text }], mentions: [account], directedToAccount: true, ...extra } },
    async emit(message) { sources.set(sourceKey(message.conversation, message.messageId), structuredClone(message)); await accept({ kind: 'message', message: structuredClone(message) }) },
    async recall(message) { sources.delete(sourceKey(message.conversation, message.messageId)); await accept({ kind: 'recall', target: message.conversation, messageId: message.messageId }) },
    async drained() {
      await waitFor(async () => Number(await redis.reader.eval("local n=0;for _,key in ipairs(KEYS) do n=n+redis.call('LLEN',key) end;return n", { keys: queueKeys, arguments: [] })) === 0, () => detail(f))
      await host.runtime.drain()
      if (settings.simulation) await waitFor(async () => !await redis.reader.exists(redis.prefix + simulationBusyKey(simulationAddressKey(group))), () => logs.join('\n'))
    },
    async send(text, extra) {
      const before = requests.length, message = f.message(text, extra); await f.emit(message)
      if (settings.simulation && message.directedToAccount) await waitFor(() => requests.length > before, () => detail(f))
      await f.drained(); return message
    },
    async restart() { await host.stop(); host = makeHost(); await host.start() },
    async session() { return JSON.parse(await redis.storage.get(simulationSessionKey(simulationAddressKey(group))) || 'null') },
    async sweep() {
      const before = requests.length; clock += 2 * 60 * 60_000; await host.runtime.sweepOnce()
      await waitFor(async () => requests.length > before && !await redis.reader.exists(redis.prefix + simulationBusyKey(simulationAddressKey(group))), () => detail(f))
      await host.runtime.drain()
    },
    async records() {
      const rows = []
      for (const key of await redis.reader.keys(redis.prefix + 'agent:interaction:v1:*')) rows.push(JSON.parse(await redis.reader.get(key)))
      return rows.map(({ state, completed, requested }) => ({ state, completed, requested }))
    },
    async assertNoTextLearning() {
      await host.resumePendingWork()
      assert.equal(extractions.length, 0)
      assert.deepEqual(await createTextPersonMemoryStore(redis.storage).list(), [])
      assert.deepEqual((await createConversationMemoryStore(redis.storage).load(conversationMemoryId(f.binding())))?.episodes ?? [], [])
    },
  }
  host = makeHost(); await host.start(); return f
}

test('group management requires explicit text-tool exposure and never appears in private chat', redisTest, async t => {
  const f = await fixture(t, { tools: [], privateTools: managementNames })
  await f.send('普通群消息')
  assert.equal(names(f.requests[0]).some(name => managementNames.includes(name)), false)
  await f.send('普通私聊', { conversation: f.privateTarget, mentions: [] })
  assert.equal(names(f.requests.at(-1)).some(name => managementNames.includes(name)), false)
  assert.equal(f.attempts.length, 0)
})

for (const unavailable of [{ enabled: false }, { port: false }, { readPort: false }, { memberPort: false }, { listPort: false }]) {
  test(`group management missing capability ${JSON.stringify(unavailable)} removes both declarations`, redisTest, async t => {
    const f = await fixture(t, unavailable); await f.send('普通群消息')
    assert.equal(names(f.requests[0]).some(name => managementNames.includes(name)), false); assert.equal(f.attempts.length, 0)
  })
}

const successCases = [
  { title: 'member mute', tool: 'jinyanTool', args: { target: ['member-one'], time: 300 }, text: '禁言 member-one 300秒', kind: 'member-mute', userId: 'member-one', fields: { seconds: 300 } },
  { title: 'member unmute', tool: 'jinyanTool', args: { target: ['member-one'], time: 0 }, text: '解除 member-one 的禁言', kind: 'member-mute', userId: 'member-one', fields: { seconds: 0 } },
  { title: 'whole group mute', tool: 'jinyanTool', args: { target: 'all', time: 300, confirm: true }, text: '开启全体禁言', kind: 'group-mute', fields: { enabled: true } },
  { title: 'whole group unmute', tool: 'jinyanTool', args: { target: 'all', time: 0 }, text: '解除全体禁言', kind: 'group-mute', fields: { enabled: false } },
  { title: 'member self card', tool: 'changeCardTool', args: { target: 'human', cardName: '新的群名片' }, text: '把我的群名片改成 新的群名片', kind: 'member-card', userId: 'human', fields: { name: '新的群名片' }, settings: { actorRole: 'member' } },
  { title: 'administrator changes owner card without an invented hierarchy', tool: 'changeCardTool', args: { target: 'member-one', cardName: '新名片' }, text: '把 member-one 的群名片改成 新名片', kind: 'member-card', userId: 'member-one', fields: { name: '新名片' }, settings: { targetRole: 'owner' } },
  { title: 'member bot changes its own card', tool: 'changeCardTool', args: { target: 'robot', cardName: '机器人新名片' }, text: '把 robot 的群名片改成 机器人新名片', kind: 'member-card', userId: 'robot', fields: { name: '机器人新名片' }, settings: { botRole: 'member' } },
  { title: 'explicit self card clearing', tool: 'changeCardTool', args: { target: 'human', cardName: '' }, text: '清空我的群名片', kind: 'member-card', userId: 'human', fields: { name: '' }, settings: { actorRole: 'member' } },
]
for (const scenario of successCases) test(`text Core confirms ${scenario.title} once with a source-bound requester and no text learning`, redisTest, async t => {
  const f = await fixture(t, { ...scenario.settings, model: () => call(scenario.tool, scenario.args) })
  const original = await f.send(scenario.text)
  assert.equal(f.effects.length, 1, detail(f)); assert.equal(f.requests.length, 1); assert.equal(f.sends.length, 0)
  assert.ok(names(f.requests[0]).includes(scenario.tool))
  assert.deepEqual(f.effects[0], { version: 1, kind: 'conversation.interact', target: f.group, binding: f.binding(), interaction: {
    kind: scenario.kind, requester: f.sender, ...(scenario.userId ? { user: f.members.get(scenario.userId).user } : {}), ...scenario.fields,
  } })
  assert.ok(f.memberReads.some(read => read.user.id === f.sender.id)); assert.ok(f.memberReads.some(read => read.user.id === f.account.id))
  if (scenario.userId) assert.ok(f.memberReads.some(read => read.user.id === scenario.userId))
  assert.deepEqual(await f.records(), [{ state: 'confirmed', completed: 1, requested: 1 }])
  await f.emit(original); await f.drained(); await f.restart(); await f.emit(original); await f.drained()
  assert.equal(f.attempts.length, 1); assert.equal(f.requests.length, 1); assert.equal(f.sends.length, 0)
  await f.assertNoTextLearning()
})

for (const denied of [
  { title: 'ordinary requester mutes a member', actorRole: 'member' },
  { title: 'ordinary bot mutes a member', botRole: 'member' },
  { title: 'unknown requester role', actorRole: 'unknown' },
  { title: 'unknown bot role', botRole: 'unknown' },
  { title: 'unknown target role', targetRole: 'unknown' },
  { title: 'administrator target', targetRole: 'admin' },
  { title: 'owner target', targetRole: 'owner' },
]) test(`text Core denies ${denied.title} through fresh member authority`, redisTest, async t => {
  const f = await fixture(t, { ...denied, model: () => call('jinyanTool', { target: ['member-one'], time: 300 }) })
  await f.send('禁言 member-one 300秒')
  assert.equal(f.attempts.length, 0, detail(f)); assert.equal(f.effects.length, 0)
})

for (const denied of [
  { title: 'ordinary requester changes another card', actorRole: 'member' },
  { title: 'ordinary bot changes another card', botRole: 'member' },
  { title: 'unknown requester changes another card', actorRole: 'unknown' },
  { title: 'unknown bot changes another card', botRole: 'unknown' },
  { title: 'unknown target card', targetRole: 'unknown' },
]) test(`text Core denies ${denied.title}`, redisTest, async t => {
  const f = await fixture(t, { ...denied, model: () => call('changeCardTool', { target: 'member-one', cardName: '新名片' }) })
  await f.send('把 member-one 的群名片改成 新名片')
  assert.equal(f.attempts.length, 0, detail(f)); assert.equal(f.effects.length, 0)
})

test('text Core refuses muting its own account even for an administrator source', redisTest, async t => {
  const f = await fixture(t, { botRole: 'member', model: () => call('jinyanTool', { target: ['robot'], time: 300 }) })
  await f.send('禁言 robot 300秒'); assert.equal(f.attempts.length, 0); assert.equal(f.effects.length, 0)
})

for (const injected of [{ requester: { platform: 'fixture', namespace: 'forged', id: 'owner' } }, { senderRole: 'owner' }, { selfDecision: true }]) {
  test(`text Core rejects model-supplied management authority ${JSON.stringify(injected)}`, redisTest, async t => {
    const f = await fixture(t, { actorRole: 'member', model: () => call('jinyanTool', { target: ['member-one'], time: 300, ...injected }) })
    await f.send('禁言 member-one 300秒'); assert.equal(f.attempts.length, 0); assert.equal(f.effects.length, 0)
  })
}

for (const changed of ['human', 'robot', 'member-one']) test(`text Core rechecks ${changed} role at the native dispatch guard`, redisTest, async t => {
  const f = await fixture(t, { model: () => call('jinyanTool', { target: ['member-one'], time: 300 }),
    async interact(action, guard, run) {
      run.role(changed, changed === 'member-one' ? 'admin' : 'member')
      try { await guard.ensureCurrent() } catch { return { state: 'failed', code: 'role_revoked' } }
      if (!guard.isCurrent()) return { state: 'failed', code: 'stale' }
      run.effects.push(structuredClone(action)); return { state: 'confirmed' }
    },
  })
  await f.send('禁言 member-one 300秒')
  assert.equal(f.attempts.length, 1, detail(f)); assert.equal(f.effects.length, 0)
  assert.deepEqual(await f.records(), [{ state: 'failed', completed: 0, requested: 1 }])
})

for (const revoke of ['config', 'binding', 'source-recall', 'source-author']) test(`text Core ${revoke} change while fresh authority is pending prevents a native effect`, redisTest, async t => {
  const entered = deferred(), held = deferred()
  const f = await fixture(t, { release() { held.resolve() }, model: () => call('jinyanTool', { target: ['member-one'], time: 300 }),
    async member(_target, selected) { if (selected.id === 'robot') { entered.resolve(); await held.promise } },
  })
  const original = f.message('禁言 member-one 300秒'); await f.emit(original)
  await waitFor(() => f.memberReads.some(read => read.user.id === 'robot'), () => detail(f)); await entered.promise
  if (revoke === 'config') f.disable()
  else if (revoke === 'binding') f.rebind()
  else if (revoke === 'source-recall') await f.recall(original)
  else f.sources.get(sourceKey(f.group, original.messageId)).sender = f.first
  held.resolve(); await f.drained()
  assert.equal(f.attempts.length, 0, detail(f)); assert.equal(f.effects.length, 0)
})

for (const terminal of ['failed', 'unknown']) test(`text Core freezes a partially confirmed multi-target mute after ${terminal}`, redisTest, async t => {
  const f = await fixture(t, { model: () => call('jinyanTool', { target: ['member-one', 'member-two', 'member-three'], time: 300 }),
    async interact(action, guard, run) {
      await guard.ensureCurrent()
      if (run.attempts.length === 1) { run.effects.push(structuredClone(action)); return { state: 'confirmed' } }
      return terminal === 'unknown' ? { state: 'unknown' } : { state: 'failed', code: 'native_rejected' }
    },
  })
  const original = await f.send('禁言 member-one、member-two 和 member-three 300秒')
  assert.equal(f.attempts.length, 2, detail(f)); assert.equal(f.effects.length, 1)
  assert.deepEqual(f.effects[0].interaction.user, f.first)
  assert.equal(f.requests.length, 1); assert.equal(f.sends.length, 0)
  assert.deepEqual(await f.records(), [{ state: terminal, completed: 1, requested: 3 }])
  await f.emit(original); await f.drained(); await f.restart(); await f.emit(original); await f.drained()
  assert.equal(f.attempts.length, 2); assert.equal(f.effects.length, 1); assert.equal(f.requests.length, 1); assert.equal(f.sends.length, 0)
  await f.assertNoTextLearning()
})

test('text Core freezes an entirely unknown multi-target mute before any remaining operation or restart', redisTest, async t => {
  const f = await fixture(t, { receipt: { state: 'unknown' }, model: () => call('jinyanTool', { target: ['member-one', 'member-two'], time: 300 }) })
  const original = await f.send('禁言 member-one 和 member-two 300秒')
  assert.equal(f.attempts.length, 1, detail(f)); assert.equal(f.requests.length, 1); assert.equal(f.sends.length, 0)
  assert.deepEqual(await f.records(), [{ state: 'unknown', completed: 0, requested: 2 }])
  await f.emit(original); await f.drained(); await f.restart(); await f.emit(original); await f.drained()
  assert.equal(f.attempts.length, 1); assert.equal(f.requests.length, 1); assert.equal(f.sends.length, 0)
  await f.assertNoTextLearning()
})

test('text Core reauthorizes later mute operations after the first confirmed member and stops on requester demotion', redisTest, async t => {
  const f = await fixture(t, { model: () => call('jinyanTool', { target: ['member-one', 'member-two', 'member-three'], time: 300 }),
    async interact(action, guard, run) {
      await guard.ensureCurrent(); run.effects.push(structuredClone(action)); run.role('human', 'member')
      return { state: 'confirmed' }
    },
  })
  const original = await f.send('禁言 member-one、member-two 和 member-three 300秒')
  assert.equal(f.attempts.length, 1, detail(f)); assert.equal(f.effects.length, 1); assert.equal(f.sends.length, 0)
  assert.deepEqual(await f.records(), [{ state: 'failed', completed: 1, requested: 3 }])
  await f.emit(original); await f.drained(); await f.restart(); await f.emit(original); await f.drained()
  assert.equal(f.attempts.length, 1); assert.equal(f.effects.length, 1); assert.equal(f.requests.length, 1)
})

test('simulation restricts both management tools by default despite an open ordinary tool policy', redisTest, async t => {
  const f = await fixture(t, { simulation: true, model: () => finish() }); await f.send('普通真人群消息')
  assert.equal(names(f.requests[0]).some(name => managementNames.includes(name)), false); assert.equal(f.attempts.length, 0)
})

for (const scenario of [successCases[0], successCases[4]]) test(`simulation explicit human allow confirms ${scenario.title} with the real requester`, redisTest, async t => {
  const f = await fixture(t, { ...scenario.settings, simulation: true, simulationAllow: true,
    model: (_request, index) => index === 1 ? call(scenario.tool, scenario.args) : finish(),
  })
  const original = await f.send(scenario.text)
  assert.equal(f.effects.length, 1, detail(f)); assert.equal(f.sends.length, 0)
  assert.equal(f.requests.length, 1, 'a successful group management effect must finish before another model call')
  assert.deepEqual(f.effects[0].interaction.requester, f.sender); assert.equal(f.effects[0].interaction.kind, scenario.kind)
  assert.deepEqual(await f.records(), [{ state: 'confirmed', completed: 1, requested: 1 }])
  assert.deepEqual((await f.session()).confirmedMessageIds ?? [], [])
  await f.emit(original); await f.drained(); await f.restart(); await f.emit(original); await f.drained()
  assert.equal(f.attempts.length, 1); assert.equal(f.effects.length, 1); assert.equal(f.sends.length, 0)
})

test('simulation explicit allow never lends a background human source to autonomous management', redisTest, async t => {
  const f = await fixture(t, { simulation: true, simulationAllow: true, proactive: true,
    model: (_request, index) => index === 1 ? call('jinyanTool', { target: ['member-one'], time: 300 }) : finish(),
  })
  await f.send('群管理背景消息', { directedToAccount: false, mentions: [] }); assert.equal(f.requests.length, 0)
  await f.sweep()
  assert.equal(names(f.requests[0]).some(name => managementNames.includes(name)), false)
  assert.equal(f.attempts.length, 0); assert.equal(f.effects.length, 0); assert.equal(f.sends.length, 0)
})

for (const receipt of ['confirmed', 'unknown']) test(`simulation ${receipt} management stops a second tool in the same model response`, redisTest, async t => {
  const f = await fixture(t, { simulation: true, simulationAllow: true, receipt: { state: receipt },
    model: (_request, index) => {
      if (index > 1) return finish()
      const response = call('jinyanTool', { target: ['member-one'], time: 300 })
      response.choices[0].message.tool_calls.push({ id: 'second-card-call', type: 'function',
        function: { name: 'changeCardTool', arguments: JSON.stringify({ target: 'human', cardName: '另一张名片' }) } })
      return response
    },
  })
  const original = await f.send('禁言 member-one 300秒，再把我的群名片改成 另一张名片')
  assert.equal(f.attempts.length, 1, detail(f)); assert.equal(f.effects[0].interaction.kind, 'member-mute')
  assert.equal(f.requests.length, 1); assert.equal(f.sends.length, 0)
  assert.deepEqual(await f.records(), [{ state: receipt, completed: receipt === 'confirmed' ? 1 : 0, requested: 1 }])
  assert.deepEqual((await f.session()).confirmedMessageIds ?? [], [])
  await f.emit(original); await f.drained(); await f.restart(); await f.emit(original); await f.drained()
  assert.equal(f.attempts.length, 1); assert.equal(f.requests.length, 1); assert.equal(f.sends.length, 0)
})

for (const terminal of ['failed', 'unknown']) test(`simulation partial management ${terminal} freezes remaining targets and every follow-up model`, redisTest, async t => {
  const f = await fixture(t, { simulation: true, simulationAllow: true,
    model: (_request, index) => index === 1 ? call('jinyanTool', { target: ['member-one', 'member-two', 'member-three'], time: 300 }) : finish(),
    async interact(action, guard, run) {
      await guard.ensureCurrent()
      if (run.attempts.length === 1) { run.effects.push(structuredClone(action)); return { state: 'confirmed' } }
      return terminal === 'unknown' ? { state: 'unknown' } : { state: 'failed', code: 'native_rejected' }
    },
  })
  const original = await f.send('禁言 member-one、member-two 和 member-three 300秒')
  assert.equal(f.attempts.length, 2, detail(f)); assert.equal(f.effects.length, 1); assert.equal(f.requests.length, 1); assert.equal(f.sends.length, 0)
  assert.deepEqual(await f.records(), [{ state: terminal, completed: 1, requested: 3 }])
  assert.deepEqual((await f.session()).confirmedMessageIds ?? [], [])
  await f.emit(original); await f.drained(); await f.restart(); await f.emit(original); await f.drained()
  assert.equal(f.attempts.length, 2); assert.equal(f.effects.length, 1); assert.equal(f.requests.length, 1); assert.equal(f.sends.length, 0)
})

test('simulation unknown first management effect freezes its remaining targets without another model or replay', redisTest, async t => {
  const f = await fixture(t, { simulation: true, simulationAllow: true, receipt: { state: 'unknown' },
    model: (_request, index) => index === 1 ? call('jinyanTool', { target: ['member-one', 'member-two'], time: 300 }) : finish(),
  })
  const original = await f.send('禁言 member-one 和 member-two 300秒')
  assert.equal(f.attempts.length, 1, detail(f)); assert.equal(f.requests.length, 1); assert.equal(f.sends.length, 0)
  assert.deepEqual(await f.records(), [{ state: 'unknown', completed: 0, requested: 2 }])
  assert.deepEqual((await f.session()).confirmedMessageIds ?? [], [])
  await f.emit(original); await f.drained(); await f.restart(); await f.emit(original); await f.drained()
  assert.equal(f.attempts.length, 1); assert.equal(f.requests.length, 1); assert.equal(f.sends.length, 0)
})
