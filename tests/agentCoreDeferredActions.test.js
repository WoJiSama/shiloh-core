import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const { createAgentRuntime } = await load('core/agentRuntime.js')
const { createAgentBindingDirectory, agentBindingIdentity, agentBindingToken, agentConversationKey, agentPersonaScopeId,
  conversationAddressKey, platformAccountKey } = await load('modules/runtime/domain/agentBindings.js')
const { createCommitmentStore, commitmentDetailKey } = await load('modules/commitments/infrastructure/commitmentStore.js')
const { createDefaultSimSession } = await load('modules/simulation/domain/simConfig.js')
const { simulationAddressKey } = await load('modules/simulation/infrastructure/simulationAddress.js')
const { simulationSessionKey, simulationBusyKey } = await load('modules/simulation/infrastructure/simSessionStore.js')
const { personMemoryCommandText } = await load('modules/memory/domain/personMemoryCommands.js')

const redisTest = { skip: !redisAvailable, timeout: 25_000 }
const sourceKey = (target, id) => JSON.stringify([conversationAddressKey(target), id])
const toolNames = request => request.tools?.map(tool => tool.function.name) ?? []
const call = (name, args = {}) => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [
  { id: 'deferred-call-' + ++sequence, type: 'function', function: { name, arguments: JSON.stringify(args) } },
] } }], usage: { total_tokens: 1 } })
const finish = () => call('simFinishTurn', { choice: 'silent', reason: '延期提醒验证结束' })
const answer = () => ({ choices: [{ message: { role: 'assistant', content: '已核对当前提醒。' } }] })
const fixedText = '去喝水，休息一下。'
let sequence = 0

async function waitFor(probe, detail) {
  const deadline = performance.now() + 8000
  while (performance.now() < deadline) { if (await probe()) return; await delay(10) }
  assert.fail(detail())
}

async function fixture(t, settings = {}) {
  let host, f
  t.after(async () => { settings.release?.(); await host?.stop() })
  const redis = await createAgentRedisFixture(t, 'core-deferred-actions')
  const account = { platform: 'fixture', namespace: 'deferred-' + ++sequence, id: 'robot' }
  const creator = { ...account, id: 'human' }, friend = { ...account, id: 'friend' }
  const group = { account, kind: 'group', id: 'room' }, privateTarget = { account, kind: 'private', id: creator.id }
  const config = { version: 1, agents: [{ id: 'role', personaId: 'default' }, { id: 'replacement', personaId: 'default' }],
    connections: [{ id: 'connection', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: [group, privateTarget].map(target => ({ connectionId: 'connection', kind: target.kind, conversationId: target.id, agentId: 'role' })) }
  let directory = createAgentBindingDirectory(config, 'deferred-initial'), accept, ready = false, current = true
  let clock = Date.now(), round = 0, ordinaryCalls = 0
  const sources = new Map(), requests = [], reads = [], memberReads = [], attempts = [], effects = [], sends = [], order = [], customCalls = [], logs = []
  const logger = { info: row => logs.push(row), warn: row => logs.push(row), error: row => logs.push(row) }
  const store = createCommitmentStore({ redis: redis.storage, logger })
  const binding = (target = group) => directory.resolve(target)
  const customDefinition = { name: 'fixedCustomTool', executor: 'custom', definitionId: 'fixture:deferred-custom:v1',
    isCurrent: () => true, validate: params => params.value === 'fixed' && Object.keys(params).length === 1,
    async execute(params, context) {
      customCalls.push({ params: structuredClone(params), context }); order.push('custom')
      await settings.custom?.(params, context, f)
      await context.ensureCurrent()
      return { status: 'succeeded', content: 'temporary custom output must not be persisted' }
    } }
  const policy = settings.policy ?? { enabled: true, rules: [{ id: 'deferred-rule', revision: 'r1',
    bindingIdentity: agentBindingIdentity(binding()), scopeKey: agentConversationKey(binding()), creatorIds: [creator.id],
    tool: settings.customTool ? customDefinition.name : 'pokeTool', executor: settings.customTool ? 'custom' : 'builtin',
    definitionId: settings.customTool ? customDefinition.definitionId : 'core:deferred-poke:v1', maxDelayMs: 86_400_000 }] }
  const sessionId = simulationAddressKey(group), sessionKey = simulationSessionKey(sessionId)
  const queueKeys = ['group-text', 'private', 'privacy', 'simulation', 'group-log'].map(kind => redis.prefix + `agent:inbox:${kind}:${platformAccountKey(account)}`)

  const adapter = { id: 'connection', account, botUserId: account.id, botName: '延期角色', isReady: () => ready,
    start(callback) { accept = callback; ready = true }, stop() { ready = false },
    resolvePrivatePeer(target) { return target.kind === 'private' && target.id === privateTarget.id ? creator : undefined },
    async readMessage(target, id, guard) {
      reads.push({ target: structuredClone(target), id }); await settings.read?.(target, id, f, guard)
      return guard?.isCurrent?.() === false ? undefined : structuredClone(sources.get(sourceKey(target, id)))
    },
    async readConversationMember(target, user, guard) {
      memberReads.push({ target: structuredClone(target), user: structuredClone(user) }); await settings.member?.(target, user, f, guard)
      if (guard?.isCurrent?.() === false || ![creator.id, friend.id, account.id].includes(user.id)) return undefined
      return { target: structuredClone(target), observedAt: Date.now(), member: { user: structuredClone(user), displayName: user.id, role: 'member' } }
    },
    actions: {
      async interact(action, guard) {
        attempts.push({ action: structuredClone(action), guard }); await settings.beforeEffect?.(f, action, guard)
        await guard.ensureCurrent?.()
        if (guard.signal?.aborted || !guard.isCurrent()) return { state: 'failed', code: 'stale' }
        effects.push(structuredClone(action)); order.push('extra')
        return settings.receipt ?? { state: 'confirmed' }
      },
      async send(action, guard) {
        await settings.beforeSend?.(f, action, guard)
        await guard?.ensureCurrent?.()
        if (guard?.isCurrent?.() === false) return { state: 'failed', code: 'stale' }
        sends.push(structuredClone(action)); order.push('text')
        return { state: 'sent', messageId: 'native-text-' + sends.length }
      },
    },
  }

  function makeHost() {
    return createAgentRuntime({ storage: redis.storage, adapters: [adapter], logger, now: () => clock, isExecutionCurrent: redis.isCurrent,
      interactions: { enabled: true }, privateChatEnabled: true,
      ...(settings.omitConfig ? {} : { deferredActions: policy }), isDeferredActionsCurrent: () => current,
      ...(settings.customTool ? { getDeferredActionDefinitions: () => [customDefinition], toolRegistry: { custom: [{ name: customDefinition.name,
        description: '普通工具可见性不授予延期权限。', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
        async execute() { ordinaryCalls++; return { status: 'succeeded', content: 'ordinary only' } } }] } } : {}),
      useTextGroup: target => target.kind === 'group' && settings.mode === 'text', groupTextTools: () => ['commitmentTool'],
      memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, groupMemory: { enabled: false }, groupLog: { enabled: false },
      resolvePersona(target) { const resolved = binding(target); return resolved && { binding: resolved, persona: { name: '延期角色' }, systemContent: '只执行本条真人明确委托的提醒。' } },
      getSection: () => ({ enabled: true, allGroups: true, reflection: { enabled: false }, consistency: { enabled: false }, rhythm: { enabled: false }, mood: { enabled: false },
        wakeGate: { enabled: false }, personProfile: { enabled: false }, meme: { enabled: false }, userStyle: { enabled: false }, lifeThreads: { enabled: false },
        wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000, maxWakePerMinute: 100, maxWakePerHour: 100 },
        turn: { minSendGapMs: 0, maxSendsPerTurn: 2, maxToolRounds: 3, maxTurnsPerDay: 1000 },
        toolPolicy: { mode: 'open', allowTools: ['pokeTool', 'reminderTool'] }, extraTools: settings.customTool ? [customDefinition.name] : [] }),
      getExecutionConfig: () => ({ useTools: true }),
      async YTapi(request) {
        requests.push(structuredClone(request))
        const currentRound = round++
        return settings.script ? settings.script(currentRound, f, request) : currentRound === 0 ? call('reminderTool', f.reminderArgs()) : finish()
      },
    })
  }

  f = { ...redis, account, creator, friend, group, privateTarget, adapter, store, policy, customDefinition,
    sources, requests, reads, memberReads, attempts, effects, sends, order, customCalls, logs, binding,
    get host() { return host }, get now() { return clock }, get ordinaryCalls() { return ordinaryCalls },
    disable() { current = false },
    rebind() { directory = createAgentBindingDirectory({ ...config, bindings: config.bindings.map(item => ({ ...item, agentId: 'replacement' })) }, 'deferred-rebound') },
    reminderArgs(extra = {}) { return { action: 'create', reminder_time: new Date(clock + 60_000).toISOString(), content: '喝水', reminder_message: fixedText,
      extra_action: { tool: settings.customTool ? customDefinition.name : 'pokeTool', params: settings.customTool ? { value: 'fixed' } : {} }, ...extra } },
    message(text = '一分钟后提醒我喝水，并戳我一下。', extra = {}) { return { version: 1, conversation: group, sender: creator, senderName: '当前真人',
      messageId: 'human-source-' + ++sequence, occurredAt: clock - 1000, text, parts: [{ kind: 'text', text }], mentions: [account], directedToAccount: true, ...extra } },
    async emit(message) { sources.set(sourceKey(message.conversation, message.messageId), structuredClone(message)); await accept({ kind: 'message', message: structuredClone(message) }) },
    async recall(message) { sources.delete(sourceKey(message.conversation, message.messageId)); await accept({ kind: 'recall', target: message.conversation, messageId: message.messageId }) },
    async forget() { await f.emit(f.message(personMemoryCommandText.forget, { directedToAccount: false, mentions: [] })); await f.drain() },
    async drain() {
      await waitFor(async () => Number(await redis.reader.eval('local n=0;for _,k in ipairs(KEYS) do n=n+redis.call("LLEN",k) end;return n', { keys: queueKeys, arguments: [] })) === 0,
        () => 'deferred Core inbox remained pending: ' + logs.slice(-6).join('\n'))
      await host.runtime.drain()
      await waitFor(async () => !await redis.reader.exists(redis.prefix + simulationBusyKey(sessionId)), () => 'deferred Core simulation remained busy: ' + logs.slice(-6).join('\n'))
    },
    async run(text, extra) {
      round = 0; const before = requests.length, message = f.message(text, extra); await f.emit(message)
      await waitFor(() => requests.length > before, () => 'deferred Core model request missing: ' + logs.slice(-6).join('\n'))
      await f.drain(); return message
    },
    async task() { const records = await store.listDeferredActions(); assert.equal(records.length, 1, JSON.stringify({ records, logs: logs.slice(-5), requests: requests.map(row => row.messages.slice(-2)) })); return records[0] },
    async due(id, expected = ['completed', 'cancelled', 'unknown']) {
      clock += 60_001
      await waitFor(async () => { await host.resumePendingWork(); return expected.includes((await store.getCommitment(id))?.status ?? null) },
        () => 'due deferred task did not settle: ' + JSON.stringify({ effects, sends, logs: logs.slice(-6) }))
      return store.getCommitment(id)
    },
    async restart() { await host.stop(); host = makeHost(); round = 0; await host.start() },
  }
  const initial = createDefaultSimSession(clock)
  initial.bootstrapSent = true; initial.botId = account.id; initial.bindingToken = agentBindingToken(binding()); initial.personaId = agentPersonaScopeId(binding().agentId)
  initial.nextProactiveCheckAt = clock + 86_400_000
  initial.wakeConfig.triggers = { ...initial.wakeConfig.triggers, probability: 0, question: false, nameMention: false, anyMessage: false }
  await redis.storage.set(sessionKey, JSON.stringify(initial))
  host = makeHost(); await host.start(); return f
}

const reminderSends = f => f.sends.filter(action => action.parts.some(part => part.kind === 'text' && part.text.trim() === fixedText))

test('Core registers a real human reminder, freezes its creator, and executes one extra before fixed text without a due model', redisTest, async t => {
  const f = await fixture(t), message = await f.run(), task = await f.task()
  assert.ok(toolNames(f.requests[0]).includes('reminderTool'))
  assert.deepEqual(task.deferredAction.action, { tool: 'pokeTool', executor: 'builtin', definitionId: 'core:deferred-poke:v1', params: { target: [f.creator.id] } })
  assert.deepEqual(task.deferredAction.grant.source, { kind: 'message', messageId: message.messageId, at: message.occurredAt })
  assert.equal(task.deliver, 'static'); assert.equal(task.static_message, fixedText)
  assert.deepEqual(f.effects, []); assert.deepEqual(reminderSends(f), [])
  const modelCalls = f.requests.length, saved = await f.due(task.id)
  assert.equal(saved.status, 'completed'); assert.equal(saved.deferredAction.state, 'succeeded')
  assert.equal(f.requests.length, modelCalls); assert.equal(f.effects.length, 1)
  assert.deepEqual(f.effects[0].target, f.group); assert.deepEqual(f.effects[0].binding, f.binding())
  assert.deepEqual(f.effects[0].interaction, { kind: 'poke', user: f.creator })
  assert.deepEqual(f.order, ['extra', 'text'])
  assert.deepEqual(reminderSends(f)[0].parts, [{ kind: 'mention', user: f.creator }, { kind: 'text', text: ' ' + fixedText }])
  assert.equal(reminderSends(f)[0].replyTo, undefined)
  await f.restart(); await f.host.resumePendingWork(); await f.host.stop()
  assert.equal(f.effects.length, 1); assert.equal(reminderSends(f).length, 1)
})

test('Core custom deferred definitions receive frozen params and a delegated context without a synthetic human request', redisTest, async t => {
  const f = await fixture(t, { customTool: true }); await f.run('一分钟后提醒我喝水，并执行宿主授权的固定动作。')
  const task = await f.task(), callsBefore = f.requests.length
  await f.due(task.id)
  assert.equal(f.customCalls.length, 1); assert.equal(f.ordinaryCalls, 0); assert.equal(f.requests.length, callsBefore)
  const { params, context } = f.customCalls[0]
  assert.deepEqual(params, { value: 'fixed' }); assert.equal(context.kind, 'deferred'); assert.equal(context.taskId, task.id)
  assert.deepEqual(context.creator, f.creator); assert.deepEqual(context.binding, f.binding())
  for (const key of ['actor', 'request', 'user_id', 'isMaster']) assert.equal(Object.hasOwn(context, key), false, key)
  assert.equal(context.delegation.id, task.deferredAction.grant.id)
  assert.deepEqual(f.order, ['custom', 'text'])
  assert.equal(JSON.stringify(await f.task()).includes('temporary custom output'), false)
})

test('Core persists unknown extra results across runtime restart without text or a second native attempt', redisTest, async t => {
  const f = await fixture(t, { receipt: { state: 'unknown' } }); await f.run()
  const task = await f.task(), saved = await f.due(task.id)
  assert.equal(saved.status, 'unknown'); assert.equal(saved.deferredAction.state, 'unknown')
  assert.equal(f.attempts.length, 1); assert.deepEqual(reminderSends(f), [])
  const callsBefore = f.requests.length
  await f.restart(); await f.host.resumePendingWork(); await f.host.stop()
  assert.equal((await f.task()).status, 'unknown'); assert.equal(f.attempts.length, 1)
  assert.deepEqual(reminderSends(f), []); assert.equal(f.requests.length, callsBefore)
})

async function revoke(f, fence, message) {
  if (fence === 'configuration') f.disable()
  else if (fence === 'binding') f.rebind()
  else if (fence === 'recall') await f.recall(message)
  else await f.forget()
}

for (const fence of ['configuration', 'binding', 'recall', 'privacy']) {
  test(`Core ${fence} revocation before due time prevents the delegated extra`, redisTest, async t => {
    const f = await fixture(t), message = await f.run(), task = await f.task()
    if (fence === 'privacy') assert.equal(await f.reader.exists(f.prefix + commitmentDetailKey(task.id)), 1)
    await revoke(f, fence, message)
    if (fence === 'privacy') {
      const sendsBeforeDue = f.sends.length, modelCalls = f.requests.length
      assert.equal(await f.reader.exists(f.prefix + commitmentDetailKey(task.id)), 0)
      assert.equal(await f.store.getCommitment(task.id), null)
      assert.deepEqual(await f.store.listDeferredActions(), [])
      assert.equal(await f.due(task.id, [null]), null)
      await f.restart(); await f.host.resumePendingWork(); await f.host.stop()
      assert.equal(await f.reader.exists(f.prefix + commitmentDetailKey(task.id)), 0)
      assert.equal(await f.store.getCommitment(task.id), null)
      assert.deepEqual(f.attempts, []); assert.deepEqual(f.effects, []); assert.deepEqual(reminderSends(f), [])
      assert.equal(f.sends.length, sendsBeforeDue); assert.equal(f.requests.length, modelCalls)
    } else {
      const saved = await f.due(task.id)
      assert.equal(saved.status, 'cancelled'); assert.deepEqual(f.attempts, []); assert.deepEqual(reminderSends(f), [])
    }
  })

  test(`Core rechecks ${fence} after a native extra is queued and blocks its dispatch`, redisTest, async t => {
    let original, revoked = false
    const f = await fixture(t, { async beforeEffect(run) { revoked = true; await revoke(run, fence, original) } })
    original = await f.run(); const task = await f.task()
    if (fence === 'privacy') assert.equal(await f.reader.exists(f.prefix + commitmentDetailKey(task.id)), 1)
    const saved = await f.due(task.id, fence === 'privacy' ? [null] : undefined)
    assert.equal(revoked, true); assert.equal(f.attempts.length, 1)
    if (fence === 'privacy') {
      assert.equal(saved, null)
      assert.equal(await f.reader.exists(f.prefix + commitmentDetailKey(task.id)), 0)
      assert.deepEqual(await f.store.listDeferredActions(), [])
    } else assert.equal(saved.status, 'unknown')
    assert.deepEqual(f.effects, []); assert.deepEqual(reminderSends(f), [])
    const sendsBeforeRestart = f.sends.length, modelCalls = f.requests.length
    await f.restart(); await f.host.resumePendingWork(); await f.host.stop()
    assert.equal(f.attempts.length, 1)
    if (fence === 'privacy') {
      assert.equal(await f.reader.exists(f.prefix + commitmentDetailKey(task.id)), 0)
      assert.equal(await f.store.getCommitment(task.id), null)
      assert.deepEqual(f.effects, []); assert.deepEqual(reminderSends(f), [])
      assert.equal(f.sends.length, sendsBeforeRestart); assert.equal(f.requests.length, modelCalls)
    }
  })
}

test('Core rechecks a revoked policy before fixed body dispatch after an already confirmed extra', redisTest, async t => {
  const f = await fixture(t, { async beforeSend(run, action) {
    if (action.parts.some(part => part.kind === 'text' && part.text.trim() === fixedText)) run.policy.rules[0].revision = 'r2'
  } }); await f.run()
  const task = await f.task(), saved = await f.due(task.id)
  assert.equal(f.effects.length, 1); assert.equal(saved.deferredAction.state, 'succeeded')
  assert.equal(saved.status, 'unknown'); assert.deepEqual(reminderSends(f), [])
  await f.restart(); await f.host.resumePendingWork(); await f.host.stop()
  assert.equal(f.effects.length, 1)
})

for (const scenario of [{ name: 'without configuration', omitConfig: true }, { name: 'when disabled', policy: { enabled: false, rules: [] } }]) {
  test(`Core hides deferred reminder registration ${scenario.name}`, redisTest, async t => {
    const f = await fixture(t, scenario); await f.run()
    assert.equal(toolNames(f.requests[0]).includes('reminderTool'), false)
    assert.deepEqual(await f.store.listDeferredActions(), []); assert.deepEqual(f.attempts, []); assert.deepEqual(reminderSends(f), [])
  })
}

test('Core ordinary extraTools visibility and a custom definition do not grant deferred authority', redisTest, async t => {
  const f = await fixture(t, { customTool: true, policy: { enabled: true, rules: [] } }); await f.run()
  assert.ok(toolNames(f.requests[0]).includes('reminderTool')); assert.ok(toolNames(f.requests[0]).includes('fixedCustomTool'))
  assert.deepEqual(await f.store.listDeferredActions(), []); assert.deepEqual(f.customCalls, []); assert.equal(f.ordinaryCalls, 0)
})

test('Core verifies the original source timestamp when registering instead of trusting a newer source snapshot', redisTest, async t => {
  const f = await fixture(t, { async read(target, id, run) {
    const source = run.sources.get(sourceKey(target, id)); if (source) source.occurredAt++
  } }); await f.run()
  assert.deepEqual(await f.store.listDeferredActions(), []); assert.deepEqual(f.attempts, [])
})

test('Core group text keeps reminders static and does not expose deferred extra actions', redisTest, async t => {
  const f = await fixture(t, { mode: 'text', script: (round, run) => round === 0 ? call('commitmentTool', {
    action: 'create', schedule_kind: 'once', schedule_time: new Date(run.now + 60_000).toISOString(), static_message: fixedText,
  }) : answer() }); await f.run('一分钟后提醒我去喝水。')
  assert.equal(toolNames(f.requests[0]).includes('reminderTool'), false); assert.ok(toolNames(f.requests[0]).includes('commitmentTool'))
  const records = await f.store.listActiveCommitments()
  assert.equal(records.length, 1); assert.equal(records[0].deliver, 'static'); assert.equal(records[0].deferredAction, undefined)
  const before = f.requests.length; await f.due(records[0].id, ['completed'])
  assert.equal(f.requests.length, before); assert.deepEqual(f.attempts, []); assert.equal(reminderSends(f).length, 1)
})

test('Core private reminder surface permits only list and cancel and rejects a model-invented create', redisTest, async t => {
  const f = await fixture(t, { script: round => round === 0 ? call('commitmentTool', { action: 'create' }) : answer() })
  await f.run('一分钟后提醒我并戳我一下。', { conversation: f.privateTarget, mentions: [] })
  const definition = f.requests[0].tools.find(tool => tool.function.name === 'commitmentTool')
  assert.ok(definition); assert.deepEqual(definition.function.parameters.properties.action.enum, ['list', 'cancel'])
  assert.equal(toolNames(f.requests[0]).includes('reminderTool'), false)
  assert.deepEqual(await f.store.listActiveCommitments(), []); assert.deepEqual(f.attempts, [])
})
