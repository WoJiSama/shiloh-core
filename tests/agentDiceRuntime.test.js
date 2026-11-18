import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { createAgentRuntime } = await load('core/agentRuntime.js')
const { createAgentBindingDirectory, agentBindingToken, agentPersonaScopeId, conversationAddressKey, platformAccountKey } = await load('modules/runtime/domain/agentBindings.js')
const { createAgentGroupLogStore } = await load('modules/dice/infrastructure/agentGroupLogStore.js')
const { createAgentDiceLedger } = await load('modules/dice/infrastructure/agentDiceLedger.js')
const { createAgentDiceWorkflow } = await load('modules/dice/infrastructure/agentDiceWorkflow.js')
const { resolveAgentDiceConfig } = await load('modules/dice/domain/agentDiceCommand.js')
const { createDefaultSimSession } = await load('modules/simulation/domain/simConfig.js')
const { simulationAddressKey } = await load('modules/simulation/infrastructure/simulationAddress.js')
const { simulationSessionKey, simulationBusyKey } = await load('modules/simulation/infrastructure/simSessionStore.js')
const { personMemoryCommandText: privacy } = await load('modules/memory/domain/personMemoryCommands.js')
const { connectAgentRedis } = await load('modules/runtime/infrastructure/agentRedis.js')
const { createAgentInbox } = await load('modules/runtime/infrastructure/agentInbox.js')

const redisTest = { skip: !redisAvailable, timeout: 25_000 }
const sourceKey = (target, id) => JSON.stringify([conversationAddressKey(target), id])
const textOf = action => action.parts.filter(part => part.kind === 'text').map(part => part.text).join('')
const deferred = () => Promise.withResolvers()
let fixtureSequence = 0

async function waitFor(probe, message, detail = () => '') {
  const deadline = performance.now() + 8_000
  while (performance.now() < deadline) {
    if (await probe()) return
    await delay(10)
  }
  assert.fail(`${message}: ${detail()}`)
}

async function fixture(t, settings = {}) {
  let host, f
  t.after(async () => { settings.release?.(); await host?.stop() })
  const redis = settings.redis ?? await createAgentRedisFixture(t, 'dice-runtime')
  const namespace = settings.namespace ?? 'dice-' + ++fixtureSequence
  const accounts = ['robot-one', 'robot-two'].map(id => ({ platform: 'fixture', namespace, id }))
  const user = (id = 'human', account = accounts[0]) => ({ ...account, id })
  const group = { account: accounts[0], kind: 'group', id: 'room' }
  const otherGroup = { ...group, id: 'other-room' }, otherAgentGroup = { ...group, id: 'other-agent-room' }
  const otherAccountGroup = { ...group, account: accounts[1] }, privateTarget = { account: accounts[0], kind: 'private', id: 'human' }
  const targets = [group, otherGroup, otherAgentGroup, otherAccountGroup, privateTarget]
  const config = { version: 1, agents: [{ id: 'daily', personaId: 'default' }, { id: 'other', personaId: 'default' }],
    connections: accounts.map((account, index) => ({ id: `connection-${index}`, platform: account.platform, namespace: account.namespace, accountId: account.id })),
    bindings: targets.map(target => ({ connectionId: `connection-${accounts.indexOf(target.account)}`, kind: target.kind,
      conversationId: target.id, agentId: target === otherAgentGroup ? 'other' : 'daily' })) }
  let directory = createAgentBindingDirectory(config, 'dice-initial'), current = true, clock = Date.now(), sequence = 0, receiptSequence = 0
  const receives = new Map(), ready = new Map(), sources = new Map(), requests = [], attempts = [], sends = [], deliveries = [], reads = [], logs = []
  const store = createAgentGroupLogStore(redis.storage)
  const queueKeys = accounts.flatMap(account => ['group-log', 'group-text', 'simulation', 'private', 'privacy']
    .map(kind => redis.prefix + `agent:inbox:${kind}:${platformAccountKey(account)}`))
  if (settings.simulation) {
    const initial = createDefaultSimSession(clock), binding = directory.resolve(group)
    initial.bootstrapSent = true; initial.botId = group.account.id; initial.bindingToken = agentBindingToken(binding); initial.personaId = agentPersonaScopeId(binding.agentId)
    initial.nextProactiveCheckAt = clock + 86_400_000
    initial.wakeConfig.triggers = { ...initial.wakeConfig.triggers, probability: 0, question: false, nameMention: false, anyMessage: false }
    await redis.storage.set(simulationSessionKey(simulationAddressKey(group)), JSON.stringify(initial))
  }
  function makeHost() {
    const adapters = accounts.map((account, index) => ({ id: `connection-${index}`, account, botUserId: account.id, botName: '公开掷骰验证',
      isReady: () => ready.get(platformAccountKey(account)) === true,
      async start(consume) { receives.set(platformAccountKey(account), consume); ready.set(platformAccountKey(account), true) },
      stop() { ready.set(platformAccountKey(account), false) },
      ...(settings.readPort === false ? {} : { async readMessage(target, id, guard) {
        reads.push({ target: structuredClone(target), id })
        await settings.read?.(f, target, id, guard)
        if (guard?.isCurrent?.() === false) return undefined
        return structuredClone(sources.get(sourceKey(target, id)))
      } }),
      async readConversationMember(target, subject, guard) {
        return guard?.isCurrent?.() === false ? undefined : { target, observedAt: Date.now(), member: { user: subject, displayName: '当前群友', role: 'admin' } }
      },
      actions: { async send(action, guard) {
        attempts.push(structuredClone(action))
        await settings.beforeSend?.(f, action, guard)
        try { await guard?.ensureCurrent?.() } catch { return { state: 'failed', code: 'stale' } }
        if (!guard?.isCurrent?.()) return { state: 'failed', code: 'stale' }
        sends.push(structuredClone(action))
        const receipt = settings.receipt ? await settings.receipt(f, action, guard) : { state: 'sent', messageId: 'native-outbound-' + ++receiptSequence }
        deliveries.push({ action: structuredClone(action), receipt: structuredClone(receipt) })
        return receipt
      } },
    }))
    return createAgentRuntime({ storage: redis.storage, adapters, isExecutionCurrent: redis.isCurrent, now: () => clock,
      ...(settings.omitDice ? {} : { dice: { enabled: settings.enabled !== false, ...settings.dice } }), isDiceCurrent: () => current,
      groupLog: { enabled: settings.groupLog === true }, privateChatEnabled: true,
      useTextGroup: target => target.kind === 'group' && !settings.simulation, textGroupRevision: 'dice-text-fixture',
      resolvePersona(target) { const binding = directory.resolve(target); return binding && { binding, persona: { name: '公开掷骰角色' }, systemContent: '隔离的公开掷骰运行测试' } },
      getSection: () => ({ enabled: true, allGroups: true, reflection: { enabled: false }, consistency: { enabled: false }, wakeGate: { enabled: false },
        rhythm: { enabled: false }, mood: { enabled: false }, personProfile: { enabled: false }, meme: { enabled: false }, userStyle: { enabled: false }, lifeThreads: { enabled: false },
        wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000, maxWakePerMinute: 100, maxWakePerHour: 100 },
        turn: { minSendGapMs: 0, maxTurnsPerDay: 1000, maxToolRounds: 2, maxSendsPerTurn: 1 }, toolPolicy: { mode: 'open' } }),
      getExecutionConfig: () => ({}),
      logger: { info: line => logs.push(line), warn: line => logs.push(line), error: line => logs.push(line) },
      async YTapi(request) {
        requests.push(structuredClone(request))
        return { choices: [{ message: { content: '普通聊天模型回复。' } }] }
      },
    })
  }
  f = { ...redis, accounts, user, group, otherGroup, otherAgentGroup, otherAccountGroup, privateTarget, store,
    sources, requests, attempts, sends, deliveries, reads, logs,
    get host() { return host }, get now() { return clock }, binding: (target = group) => directory.resolve(target),
    owner: (target = group, agentId = directory.resolve(target)?.agentId ?? 'daily') => ({ target, agentId }),
    disable() { current = false }, enable() { current = true },
    rebind(target = group) { directory = createAgentBindingDirectory({ ...config, bindings: config.bindings.map(binding =>
      binding.kind === target.kind && binding.conversationId === target.id && config.connections.find(connection => connection.id === binding.connectionId)?.accountId === target.account.id
        ? { ...binding, agentId: 'other' } : binding) }, 'dice-rebound') },
    message(text = '.r 1d2', extra = {}) {
      const target = extra.conversation ?? group
      return { version: 1, conversation: target, sender: user('human', target.account), senderName: '真人骰手-原始昵称', messageId: 'source-' + ++sequence,
        occurredAt: ++clock, text, parts: [{ kind: 'text', text }], mentions: [], directedToAccount: false, ...extra }
    },
    async emit(message) { sources.set(sourceKey(message.conversation, message.messageId), structuredClone(message)); await receives.get(platformAccountKey(message.conversation.account))({ kind: 'message', message: structuredClone(message) }) },
    async recall(message) { sources.delete(sourceKey(message.conversation, message.messageId)); await receives.get(platformAccountKey(message.conversation.account))({ kind: 'recall', target: message.conversation, messageId: message.messageId }) },
    async drained() {
      await waitFor(async () => Number(await redis.reader.eval("local total = 0; for _, key in ipairs(KEYS) do total = total + redis.call('LLEN', key) end; return total",
        { keys: queueKeys, arguments: [] })) === 0, 'dice inboxes did not drain', () => logs.slice(-5).join('\n'))
      await host.runtime.drain()
      if (settings.simulation) await waitFor(async () => !await redis.reader.exists(redis.prefix + simulationBusyKey(simulationAddressKey(group))), 'simulation dice turn did not settle')
    },
    async send(text, extra) { const message = f.message(text, extra); await f.emit(message); await f.drained(); return message },
    async startLog(target = group) { await f.send('.log on 公开骰子', { conversation: target }); assert.equal((await store.read(f.owner(target))).active, true) },
    async rows(target = group, agentId) { const owner = f.owner(target, agentId), state = await store.read(owner); return (await Promise.all(state.logs.map(log => store.snapshot(owner, log.id)))).flatMap(snapshot => snapshot.sourceRows) },
    async records() {
      const records = []
      for (const key of (await redis.reader.keys(redis.prefix + 'agent:dice:v1:operation:*')).sort()) {
        assert.match(key.slice(redis.prefix.length), /^agent:dice:v1:operation:[a-f\d]{64}$/u)
        assert.equal(await redis.reader.type(key), 'string')
        const record = JSON.parse(await redis.reader.get(key))
        for (const field of ['bindingHash', 'sourceHash', 'globalIndex', 'sceneIndex']) assert.match(record[field], /^[a-f\d]{64}$/u)
        records.push(record)
      }
      return records
    },
    async assertScrubbed() {
      for (const record of await f.records()) {
        assert.ok(['confirmed', 'failed', 'unknown'].includes(record.state), 'a drained operation must not retain ready or pending output')
        assert.equal(Object.hasOwn(record, 'items'), false, 'terminal dice records retain counters and hashes, never generated output')
      }
      assert.equal(JSON.stringify(await f.records()).includes('真人骰手-原始昵称'), false)
    },
    async restart() { await host.stop(); host = makeHost(); await host.start() },
    sendsFor(message) { return sends.filter(action => action.replyTo === message.messageId && conversationAddressKey(action.target) === conversationAddressKey(message.conversation)) },
    attemptsFor(message) { return attempts.filter(action => action.replyTo === message.messageId && conversationAddressKey(action.target) === conversationAddressKey(message.conversation)) },
  }
  host = makeHost(); if (settings.start !== false) await host.start(); return f
}

async function freezeReadyDice(f, message, config = resolveAgentDiceConfig({ enabled: true })) {
  const ledger = createAgentDiceLedger(f.storage)
  const source = { target: message.conversation, agentId: f.binding(message.conversation).agentId, authorId: message.sender.id, messageId: message.messageId }
  const workflow = createAgentDiceWorkflow(config, { ledger: { ...ledger,
    async change(_source, _before, record) { assert.equal(record.state, 'pending'); return undefined },
  }, actions: { async send() { assert.fail('ready fixture cannot perform a native send') } }, allowsText: () => true })
  await workflow.handle(message, f.binding(message.conversation), { signal: new AbortController().signal, isCurrent: () => true, async ensureCurrent() {} })
  const ready = await ledger.read(source)
  assert.equal(ready.record.state, 'ready'); assert.ok(ready.record.items[0].text.includes(message.senderName))
  return { ledger, source, ready }
}

async function crashBeforeDiceClaim(f, message) {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 12_000,
    env: { ...process.env, BL_DICE_CRASH_CHILD: '1', BL_DICE_CRASH_READY: '1', BL_DICE_REDIS_URL: f.url,
      BL_DICE_REDIS_PREFIX: f.prefix, BL_DICE_NAMESPACE: f.accounts[0].namespace, BL_DICE_SOURCE: JSON.stringify(message) } })
  assert.equal(child.status, 0, child.stderr); assert.equal(child.error, undefined)
  assert.deepEqual(JSON.parse(child.stdout), { stage: 'before-ready-claim' })
  const ledger = createAgentDiceLedger(f.storage), inbox = createAgentInbox(f.storage)
  const source = { target: message.conversation, agentId: f.binding().agentId, authorId: message.sender.id, messageId: message.messageId }
  const queue = { account: message.conversation.account, kind: 'group-log' }, item = await inbox.next(queue)
  assert.equal(item.entry.event.message.messageId, message.messageId, 'the crashed Core retains its actual accepted control queue entry')
  assert.equal(item.entry.bindingToken, agentBindingToken(f.binding()))
  const ready = await ledger.read(source)
  assert.equal(ready.record.state, 'ready'); assert.ok(ready.record.items[0].text.includes(message.senderName))
  f.sources.set(sourceKey(message.conversation, message.messageId), structuredClone(message))
  return { ledger, inbox, source, queue, item, ready }
}

if (process.env.BL_DICE_CRASH_CHILD === '1') {
  const reader = await connectAgentRedis(process.env.BL_DICE_REDIS_URL), prefix = process.env.BL_DICE_REDIS_PREFIX
  const storage = {
    get: key => reader.get(prefix + key), set: (key, value, options) => reader.set(prefix + key, value, options),
    del: (...keys) => reader.del(keys.map(key => prefix + key)),
    eval(script, options) {
      if (process.env.BL_DICE_CRASH_READY === '1' && options.keys[0] === 'agent:dice:v1' && options.arguments.length === 7 &&
          options.arguments[6].startsWith('{') &&
          JSON.parse(options.arguments[6]).state === 'pending') {
        process.stdout.write(JSON.stringify({ stage: 'before-ready-claim' }), () => process.exit(0))
        return new Promise(() => {})
      }
      return reader.eval(script, { ...options, keys: options.keys.map(key => prefix + key) })
    },
    async *scanIterator(options) { for await (const keys of reader.scanIterator({ ...options, MATCH: prefix + options.MATCH })) yield keys.map(key => key.slice(prefix.length)) },
    async keys(pattern) { return (await reader.keys(prefix + pattern)).map(key => key.slice(prefix.length)) },
  }
  const crash = await fixture({ after() {} }, { redis: { reader, storage, prefix, isCurrent: () => reader.isReady }, namespace: process.env.BL_DICE_NAMESPACE,
    async receipt(_run, action) {
      process.stdout.write(JSON.stringify({ action }), () => process.exit(0))
      return new Promise(() => {})
    } })
  await crash.emit(JSON.parse(process.env.BL_DICE_SOURCE))
  await new Promise(() => {})
}

for (const simulation of [false, true]) test(`${simulation ? 'simulation' : 'text'} Core executes public dice before model routing without a group-log dependency`, redisTest, async t => {
  const f = await fixture(t, { simulation }), original = await f.send('。 roll 2#1d2')
  assert.equal(f.requests.length, 0); assert.equal(f.sendsFor(original).length, 1)
  const action = f.sendsFor(original)[0]
  assert.deepEqual(action.target, f.group); assert.deepEqual(action.binding, f.binding())
  assert.equal(action.replyTo, original.messageId)
  assert.equal(textOf(action).split('\n').length, 2, 'a multi-round subcommand uses one platform send')
  assert.ok(textOf(action).includes(original.senderName))
  assert.deepEqual(await f.rows(), [])
  const [record] = await f.records()
  assert.deepEqual({ state: record.state, completed: record.completed, requested: record.requested }, { state: 'confirmed', completed: 1, requested: 1 })
  await f.emit(original); await f.drained(); await f.restart(); await f.emit(original); await f.drained()
  assert.equal(f.sendsFor(original).length, 1); assert.equal(f.requests.length, 0)
  await f.assertScrubbed()
})

test('silent Core group log records one real command and every confirmed result in original subcommand order', redisTest, async t => {
  const f = await fixture(t, { groupLog: true })
  await f.startLog()
  const original = await f.send('.r 1d2.roll 1d3。 r 1d4')
  const sends = f.sendsFor(original), rows = await f.rows(), results = rows.filter(row => row.type === 'dice_result')
  assert.equal(sends.length, 3); assert.equal(f.requests.length, 0)
  assert.deepEqual(results.map(row => row.content), sends.map(textOf))
  for (const [index, sides] of [2, 3, 4].entries()) assert.match(textOf(sends[index]), new RegExp(`1[Dd]${sides}`))
  assert.equal(rows.filter(row => row.type === 'message' && row.messageId === original.messageId).length, 1)
  assert.equal(new Set(results.map(row => row.eventId)).size, 3)
  assert.ok(results.every(row => typeof row.eventId === 'string' && row.eventId.length > 0))
  const receipts = f.deliveries.filter(({ action }) => action.replyTo === original.messageId).map(({ receipt }) => receipt.messageId)
  assert.deepEqual(results.map(row => row.deliveryMessageId), receipts)
  assert.ok(results.every(row => row.messageId === original.messageId && row.authorId === original.sender.id && row.name === original.senderName))
  assert.ok(results.every(row => row.deliveryMessageId !== row.messageId))
  const before = structuredClone(results)
  await f.emit(original); await f.drained(); await f.restart(); await f.emit(original); await f.drained()
  assert.deepEqual((await f.rows()).filter(row => row.type === 'dice_result'), before)
  assert.equal(f.sendsFor(original).length, 3)
  await f.assertScrubbed()
})

test('public dice remains independent of log activation and accepts five ordered subcommands', redisTest, async t => {
  const f = await fixture(t, { groupLog: true })
  const original = await f.send('.r 1d2.r 1d3.r 1d4.r 1d5.r 1d6')
  assert.equal(f.sendsFor(original).length, 5)
  for (const [index, sides] of [2, 3, 4, 5, 6].entries()) assert.match(textOf(f.sendsFor(original)[index]), new RegExp(`1[Dd]${sides}`))
  assert.deepEqual(await f.rows(), []); assert.equal(f.requests.length, 0)
})

test('Core dice erases the confirmed prefix from a frozen multi-result plan before the next native send', redisTest, async t => {
  let inspected = false
  const f = await fixture(t, { async beforeSend(run, action) {
    if (action.replyTo !== 'scrub-prefix' || run.sendsFor({ messageId: 'scrub-prefix', conversation: run.group }).length !== 1) return
    const [record] = await run.records()
    assert.equal(record.state, 'pending'); assert.equal(record.completed, 1); assert.equal(record.requested, 2)
    assert.equal(record.items[0].text, '')
    assert.ok(record.items[1].text.includes('真人骰手-原始昵称'))
    inspected = true
  } })
  const original = await f.send('.r 1d2.r 1d3', { messageId: 'scrub-prefix' })
  assert.equal(inspected, true); assert.equal(f.sendsFor(original).length, 2); assert.equal(f.requests.length, 0)
  await f.assertScrubbed()
})

test('Core public dice uses the real opaque sender ID when the inbound display name is absent', redisTest, async t => {
  const f = await fixture(t), original = await f.send('.r 1d2', { sender: f.user('opaque-player-id'), senderName: '' })
  assert.equal(f.sendsFor(original).length, 1)
  assert.ok(textOf(f.sendsFor(original)[0]).includes(original.sender.id))
  assert.equal(f.requests.length, 0)
})

for (const scenario of [
  { name: 'dice count', dice: { maxDiceCount: 1 }, text: '.r 2d6' },
  { name: 'dice sides', dice: { maxDiceSides: 6 }, text: '.r 1d7' },
  { name: 'round count', dice: { maxRounds: 1 }, text: '.r 2#1d6' },
  { name: 'subcommand count', dice: {}, text: '.r 1d2.r 1d2.r 1d2.r 1d2.r 1d2.r 1d2' },
]) test(`Core dice enforces configured ${scenario.name} before publishing any result`, redisTest, async t => {
  const f = await fixture(t, { groupLog: true, dice: scenario.dice })
  await f.startLog()
  const original = await f.send(scenario.text)
  assert.equal((await f.rows()).filter(row => row.type === 'dice_result').length, 0)
  assert.ok(f.sendsFor(original).every(action => !textOf(action).includes(original.senderName)))
  assert.equal(f.requests.length, 0)
  await f.assertScrubbed()
})

test('same inbound ID and dice event positions remain isolated across accounts, groups and Agents', redisTest, async t => {
  const f = await fixture(t, { groupLog: true })
  const targets = [f.group, f.otherGroup, f.otherAgentGroup, f.otherAccountGroup]
  for (const target of targets) {
    await f.startLog(target)
    await f.send('.r 1d2.r 1d3', { conversation: target, messageId: 'same-real-source' })
  }
  assert.equal(f.requests.length, 0)
  assert.equal((await f.records()).length, 4)
  for (const target of targets) {
    const rows = await f.rows(target), results = rows.filter(row => row.type === 'dice_result')
    assert.equal(results.length, 2)
    assert.deepEqual(rows.map(row => row.messageId), ['same-real-source', 'same-real-source', 'same-real-source'])
    assert.ok(results.every(row => row.authorId === 'human'))
  }
})

for (const scenario of [
  { name: 'unknown native outcome', receipt: { state: 'unknown' }, state: 'unknown' },
  { name: 'sent without a native ID', receipt: { state: 'sent' }, state: 'unknown' },
  { name: 'sent with an empty native ID', receipt: { state: 'sent', messageId: '' }, state: 'unknown' },
  { name: 'sent with a padded native ID', receipt: { state: 'sent', messageId: ' invalid ' }, state: 'unknown' },
  { name: 'definitive native rejection', receipt: { state: 'failed', code: 'native_rejected' }, state: 'failed' },
]) test(`Core dice ${scenario.name} freezes remaining subcommands and duplicate/restart without an explanation`, redisTest, async t => {
  const f = await fixture(t, { groupLog: true, receipt: (run, action) => action.replyTo === 'dice-source' ? scenario.receipt : { state: 'sent', messageId: 'control-receipt' } })
  await f.startLog()
  const original = await f.send('.r 1d2.r 1d3', { messageId: 'dice-source' })
  assert.equal(f.attemptsFor(original).length, 1); assert.equal(f.sendsFor(original).length, 1); assert.equal(f.requests.length, 0)
  assert.deepEqual((await f.rows()).map(row => row.type), ['message'])
  const [record] = await f.records()
  assert.deepEqual({ state: record.state, completed: record.completed, requested: record.requested }, { state: scenario.state, completed: 0, requested: 2 })
  await f.emit(original); await f.drained(); await f.restart(); await f.emit(original); await f.drained()
  assert.equal(f.attemptsFor(original).length, 1); assert.equal(f.requests.length, 0)
  await f.assertScrubbed()
})

for (const terminal of ['unknown', 'failed']) test(`Core dice keeps one confirmed prefix and stops at a later ${terminal} delivery`, redisTest, async t => {
  let effects = 0
  const f = await fixture(t, { groupLog: true, receipt: (_run, action) => action.replyTo !== 'partial-source'
    ? { state: 'sent', messageId: 'control' } : ++effects === 1 ? { state: 'sent', messageId: 'first-real-outbound' } : { state: terminal } })
  await f.startLog()
  const original = await f.send('.r 1d2.r 1d3.r 1d4', { messageId: 'partial-source' })
  assert.equal(f.attemptsFor(original).length, 2); assert.equal(f.requests.length, 0)
  const results = (await f.rows()).filter(row => row.type === 'dice_result')
  assert.equal(results.length, 1); assert.equal(results[0].deliveryMessageId, 'first-real-outbound')
  assert.equal(results[0].messageId, original.messageId)
  const [record] = await f.records()
  assert.deepEqual({ state: record.state, completed: record.completed, requested: record.requested }, { state: terminal, completed: 1, requested: 3 })
  await f.restart(); await f.emit(original); await f.drained()
  assert.equal(f.attemptsFor(original).length, 2)
  assert.deepEqual((await f.rows()).filter(row => row.type === 'dice_result'), results)
  await f.assertScrubbed()
})

test('another process exiting after native dispatch leaves pending dice that restart freezes without reroll or resend', redisTest, async t => {
  const f = await fixture(t, { start: false }), original = f.message('.r 1d2.r 1d3', { messageId: 'crash-native-source' })
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 12_000,
    env: { ...process.env, BL_DICE_CRASH_CHILD: '1', BL_DICE_REDIS_URL: f.url, BL_DICE_REDIS_PREFIX: f.prefix,
      BL_DICE_NAMESPACE: f.accounts[0].namespace, BL_DICE_SOURCE: JSON.stringify(original) } })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(child.error, undefined)
  const dispatched = JSON.parse(child.stdout).action
  assert.equal(dispatched.replyTo, original.messageId)
  assert.ok(textOf(dispatched).includes(original.senderName))
  const [pending] = await f.records()
  assert.equal(pending.state, 'pending'); assert.equal(pending.items.length, 2)
  f.sources.set(sourceKey(original.conversation, original.messageId), structuredClone(original))
  await f.host.start(); await f.drained()
  const [restored] = await f.records()
  assert.deepEqual({ state: restored.state, completed: restored.completed, requested: restored.requested }, { state: 'unknown', completed: 0, requested: 2 })
  await f.emit(original); await f.drained(); await f.restart(); await f.emit(original); await f.drained()
  assert.equal(f.attemptsFor(original).length, 0); assert.equal(f.requests.length, 0)
  await f.assertScrubbed()
})

for (const field of ['text', 'sender', 'occurredAt']) test(`Core dice rejects authoritative source ${field} replacement before native dispatch`, redisTest, async t => {
  let replaced = false
  const f = await fixture(t, { async read(run, target, id) {
    if (replaced || id !== 'replaced-source') return
    replaced = true
    const previous = run.sources.get(sourceKey(target, id))
    run.sources.set(sourceKey(target, id), field === 'text' ? { ...previous, text: '.r 1d100', parts: [{ kind: 'text', text: '.r 1d100' }] }
      : field === 'sender' ? { ...previous, sender: run.user('other-human') } : { ...previous, occurredAt: previous.occurredAt + 1 })
  } })
  const original = await f.send('.r 1d2', { messageId: 'replaced-source' })
  assert.equal(replaced, true); assert.equal(f.attemptsFor(original).length, 0); assert.equal(f.requests.length, 0)
  await f.restart(); await f.emit(original); await f.drained()
  assert.equal(f.attemptsFor(original).length, 0, 'source replacement is terminal for the already claimed operation')
})

test('Core dice cannot borrow a different name from a later source read or a model', redisTest, async t => {
  const f = await fixture(t, { async read(run, target, id) {
    const previous = run.sources.get(sourceKey(target, id))
    if (previous) run.sources.set(sourceKey(target, id), { ...previous, senderName: '后来改掉的昵称' })
  } })
  const original = await f.send('.r 1d2')
  assert.equal(f.sendsFor(original).length, 1)
  assert.ok(textOf(f.sendsFor(original)[0]).includes(original.senderName))
  assert.ok(!textOf(f.sendsFor(original)[0]).includes('后来改掉的昵称'))
  assert.equal(f.requests.length, 0)
})

for (const revoke of ['config', 'binding', 'recall', 'source-text', 'source-author', 'source-time']) test(`final adapter dice guard rejects ${revoke} revocation before any native effect`, redisTest, async t => {
  const f = await fixture(t, { async beforeSend(run, action, guard) {
    if (action.replyTo !== 'guard-source') return
    assert.equal(guard.isCurrent(), true)
    if (revoke === 'config') run.disable()
    else if (revoke === 'binding') run.rebind()
    else if (revoke === 'recall') await run.recall(run.original)
    else {
      const source = run.sources.get(sourceKey(run.original.conversation, run.original.messageId))
      run.sources.set(sourceKey(source.conversation, source.messageId), revoke === 'source-text'
        ? { ...source, text: '.r 1d100', parts: [{ kind: 'text', text: '.r 1d100' }] }
        : revoke === 'source-author' ? { ...source, sender: run.user('late-other-human') } : { ...source, occurredAt: source.occurredAt + 1 })
    }
  } })
  const original = f.original = f.message('.r 1d2.r 1d3', { messageId: 'guard-source' })
  await f.emit(original); await f.drained()
  assert.equal(f.attemptsFor(original).length, 1); assert.equal(f.sendsFor(original).length, 0); assert.equal(f.requests.length, 0)
  await f.assertScrubbed()
})

for (const revoke of ['config', 'binding', 'recall']) test(`Core dice ${revoke} after one native send stops the next subcommand`, redisTest, async t => {
  let revoked = false
  const f = await fixture(t, { async receipt(run, action) {
    if (action.replyTo === 'between-source' && !revoked) {
      revoked = true
      if (revoke === 'config') run.disable()
      else if (revoke === 'binding') run.rebind()
      else await run.recall(run.original)
    }
    return { state: 'sent', messageId: 'native-confirmed-before-revocation' }
  } })
  const original = f.original = f.message('.r 1d2.r 1d3', { messageId: 'between-source' })
  await f.emit(original); await f.drained()
  assert.equal(revoked, true); assert.equal(f.attemptsFor(original).length, 1); assert.equal(f.requests.length, 0)
  await f.assertScrubbed()
})

test('source recall clears pending dice output and every original/derived log row without late or restart revival', redisTest, async t => {
  const reached = deferred(), release = deferred()
  const f = await fixture(t, { groupLog: true, release: () => release.resolve(), async beforeSend(_run, action) {
    if (action.replyTo === 'privacy-source') { reached.resolve(); await release.promise }
  } })
  await f.startLog()
  const original = f.message('.r 1d2.r 1d3', { messageId: 'privacy-source' })
  await f.emit(original); await reached.promise
  const [pending] = await f.records()
  assert.equal(pending.state, 'pending'); assert.equal(pending.items.length, 2)
  assert.ok(pending.items.every(item => item.text.includes(original.senderName)))
  await f.recall(original); release.resolve(); await f.drained()
  assert.equal(f.sendsFor(original).length, 0); assert.deepEqual(await f.rows(), [])
  await f.restart(); await f.emit(original); await f.drained()
  assert.equal(f.sendsFor(original).length, 0); assert.deepEqual(await f.rows(), [])
  assert.equal(f.requests.length, 0)
  await f.assertScrubbed()
})

for (const command of ['forget', 'disable']) test(`in-flight ${command} privacy command clears dice output and logs while preserving another scope`, redisTest, async t => {
  const reached = deferred(), release = deferred()
  const f = await fixture(t, { groupLog: true, release: () => release.resolve(), async beforeSend(_run, action) {
    if (action.replyTo === 'private-dice-source') { reached.resolve(); await release.promise }
  } })
  await f.startLog(); await f.startLog(f.otherGroup)
  const preserved = await f.send('.r 1d2', { conversation: f.otherGroup })
  const original = f.message('.r 1d2.r 1d3', { messageId: 'private-dice-source' })
  await f.emit(original); await reached.promise
  assert.ok((await f.records()).some(record => record.state === 'pending' && record.items.length === 2))
  const before = await f.store.capture(f.owner(), original.sender.id)
  await f.emit(f.message(privacy[command], { messageId: 'real-privacy-command' }))
  await waitFor(async () => (await f.store.capture(f.owner(), original.sender.id)).sceneEpoch !== before.sceneEpoch, 'privacy epoch did not advance')
  release.resolve(); await f.drained()
  assert.equal(f.sendsFor(original).length, 0); assert.deepEqual(await f.rows(), [])
  assert.equal((await f.rows(f.otherGroup)).filter(row => row.type === 'dice_result').length, 1)
  assert.equal(f.sendsFor(preserved).length, 1)
  await f.restart(); await f.emit(original); await f.drained()
  assert.equal(f.sendsFor(original).length, 0); assert.deepEqual(await f.rows(), [])
  assert.equal(f.requests.length, 0)
  await f.assertScrubbed()
})

for (const groupLog of [false, true]) test(`queued dice admitted before forget cannot revive with a future native timestamp and groupLog=${groupLog}`, redisTest, async t => {
  const reached = deferred(), release = deferred()
  const f = await fixture(t, { groupLog, release: () => release.resolve(), async beforeSend(_run, action) {
    if (action.replyTo === 'privacy-queue-blocker') { reached.resolve(); await release.promise }
  } })
  if (groupLog) await f.startLog()
  const blocker = f.message('.r 1d2', { messageId: 'privacy-queue-blocker' })
  await f.emit(blocker); await reached.promise
  const queued = f.message('.r 1d2', { messageId: 'before-forget-queued', occurredAt: f.now + 60_000 })
  await f.emit(queued)
  const before = await f.store.capture(f.owner(), queued.sender.id)
  await f.emit(f.message(privacy.forget, { messageId: 'real-queued-forget' }))
  await waitFor(async () => (await f.store.capture(f.owner(), queued.sender.id)).sceneEpoch !== before.sceneEpoch, 'privacy epoch did not advance')
  release.resolve(); await f.drained()
  assert.equal(f.sendsFor(blocker).length, 0)
  assert.equal(f.sendsFor(queued).length, 0, 'admission epochs fence old queued sources independently of native timestamps')
  assert.deepEqual(await f.rows(), []); assert.equal(f.requests.length, 0)
  const fresh = await f.send('.r 1d2', { messageId: 'after-forget-fresh' })
  assert.equal(f.sendsFor(fresh).length, 1, 'a genuinely new request after forget remains executable')
  await f.assertScrubbed()
})

for (const scenario of [
  { name: 'dice count', dice: { maxDiceCount: 1 }, text: '.r 2d6' },
  { name: 'dice sides', dice: { maxDiceSides: 6 }, text: '.r 1d100' },
  { name: 'round count', dice: { maxRounds: 1 }, text: '.r 2#1d6' },
]) test(`ready dice recovery permanently scrubs a frozen result after ${scenario.name} configuration changes`, redisTest, async t => {
  const f = await fixture(t, { start: false, dice: scenario.dice })
  const original = f.message(scenario.text, { messageId: 'ready-config-source' })
  const originalConfig = resolveAgentDiceConfig({ enabled: true })
  const { ledger, source } = await freezeReadyDice(f, original, originalConfig)
  const context = { signal: new AbortController().signal, isCurrent: () => true, async ensureCurrent() {} }
  const rollbackSends = []
  const actions = { async send(action) { rollbackSends.push(action); return { state: 'sent', messageId: 'forbidden-rollback-send' } } }
  await f.host.start(); await f.emit(original); await f.drained()
  assert.equal(f.sendsFor(original).length, 0, 'recovery must not deliver a result frozen under different dice limits')
  const frozen = await ledger.read(source)
  assert.equal(frozen.record.state, 'unknown'); assert.equal(Object.hasOwn(frozen.record, 'items'), false)
  assert.equal((await ledger.capture(source)).recalled, true, 'configuration mismatch permanently revokes this source')
  await f.host.stop()
  const rolledBack = createAgentDiceWorkflow(originalConfig, { ledger, actions, allowsText: () => true })
  await rolledBack.handle(original, f.binding(), context)
  assert.equal(rollbackSends.length, 0, 'restoring the original configuration cannot revive the frozen request')
  assert.equal(f.requests.length, 0)
  await f.assertScrubbed()
})

test('ready dice recovery with unchanged configuration sends the exact frozen results once', redisTest, async t => {
  const f = await fixture(t, { start: false }), original = f.message('.r 1d100.r 2d6', { messageId: 'ready-unchanged-source' })
  const { ledger, source, ready } = await freezeReadyDice(f, original)
  const frozen = ready.record.items.map(item => item.text)
  await f.host.start(); await f.emit(original); await f.drained()
  assert.deepEqual(f.sendsFor(original).map(textOf), frozen, 'recovery uses the existing plan instead of rerolling')
  assert.equal((await ledger.read(source)).record.state, 'confirmed')
  await f.restart(); await f.emit(original); await f.drained()
  assert.deepEqual(f.sendsFor(original).map(textOf), frozen)
  assert.equal(f.requests.length, 0)
  await f.assertScrubbed()
})

for (const replacement of ['text', 'sender', 'occurredAt', 'binding']) test(`ready dice recovery permanently scrubs ${replacement} authority replacement before dispatch`, redisTest, async t => {
  const f = await fixture(t, { start: false }), original = f.message('.r 1d100', { messageId: 'ready-replaced-source' })
  const originalBinding = f.binding()
  const { ledger, source } = await freezeReadyDice(f, original)
  const changed = replacement === 'text' ? { ...original, text: '.r 1d6', parts: [{ kind: 'text', text: '.r 1d6' }] }
    : replacement === 'sender' ? { ...original, sender: f.user('new-source-author') }
    : replacement === 'occurredAt' ? { ...original, occurredAt: original.occurredAt + 1 } : original
  if (replacement === 'binding') f.rebind()
  await f.host.start(); await f.emit(changed); await f.drained()
  assert.equal(f.sendsFor(original).length, 0)
  const revoked = await ledger.read(source)
  assert.equal(revoked.record.state, 'unknown'); assert.equal(Object.hasOwn(revoked.record, 'items'), false)
  assert.equal((await ledger.capture(source)).recalled, true)
  await f.host.stop()
  const workflow = createAgentDiceWorkflow(resolveAgentDiceConfig({ enabled: true }), { ledger,
    actions: { async send() { assert.fail('restoring original authority cannot revive a revoked source') } }, allowsText: () => true })
  await workflow.handle(original, originalBinding, { signal: new AbortController().signal, isCurrent: () => true, async ensureCurrent() {} })
  assert.equal(f.requests.length, 0)
  await f.assertScrubbed()
})

for (const field of ['text', 'sender', 'occurredAt', 'missing']) test(`ready dice recovery permanently scrubs a fresh native ${field} change before reading frozen authority`, redisTest, async t => {
  const f = await fixture(t, { start: false, async read(run, target, id) {
    const previous = run.sources.get(sourceKey(target, id))
    if (field === 'missing') run.sources.delete(sourceKey(target, id))
    else run.sources.set(sourceKey(target, id), field === 'text'
      ? { ...previous, text: '.r 1d6', parts: [{ kind: 'text', text: '.r 1d6' }] }
      : field === 'sender' ? { ...previous, sender: run.user('native-replaced-author') } : { ...previous, occurredAt: previous.occurredAt + 1 })
  } })
  const original = f.message('.r 1d100', { messageId: 'ready-native-replaced' })
  const { ledger, source } = await freezeReadyDice(f, original)
  await f.host.start(); await f.emit(original); await f.drained()
  assert.equal(f.sendsFor(original).length, 0)
  const revoked = await ledger.read(source)
  assert.equal(revoked.record.state, 'unknown'); assert.equal(Object.hasOwn(revoked.record, 'items'), false)
  assert.equal((await ledger.capture(source)).recalled, true)
  await f.host.stop()
  const workflow = createAgentDiceWorkflow(resolveAgentDiceConfig({ enabled: true }), { ledger,
    actions: { async send() { assert.fail('restoring the native source cannot revive a revoked frozen request') } }, allowsText: () => true })
  await workflow.handle(original, f.binding(), { signal: new AbortController().signal, isCurrent: () => true, async ensureCurrent() {} })
  assert.equal(f.requests.length, 0)
  await f.assertScrubbed()
})

for (const changed of ['disabled', 'binding']) test(`restart consumes the actual old dice control queue and revokes ready output after ${changed} authority`, redisTest, async t => {
  const f = await fixture(t, { start: false, enabled: changed !== 'disabled' })
  const original = f.message('.r 1d100', { messageId: 'crash-ready-control-source' }), originalBinding = f.binding()
  const { ledger, inbox, source, queue } = await crashBeforeDiceClaim(f, original)
  if (changed === 'binding') f.rebind()
  await f.host.start(); await f.drained()
  assert.equal(await inbox.next(queue), null, 'recovery acknowledges the real pre-crash queue after its original authority is revoked')
  const restored = await ledger.read(source)
  assert.equal(restored.record.state, 'unknown'); assert.equal(Object.hasOwn(restored.record, 'items'), false)
  assert.equal((await ledger.capture(source)).recalled, true)
  assert.equal(f.sendsFor(original).length, 0); assert.equal(f.requests.length, 0)
  await f.host.stop()
  const workflow = createAgentDiceWorkflow(resolveAgentDiceConfig({ enabled: true }), { ledger,
    actions: { async send() { assert.fail('restoring pre-crash authority cannot revive an old control request') } }, allowsText: () => true })
  await workflow.handle(original, originalBinding, { signal: new AbortController().signal, isCurrent: () => true, async ensureCurrent() {} })
  await f.assertScrubbed()
})

test('disabled dice ingress revokes an old ready source before re-enable without requiring a pending control queue', redisTest, async t => {
  const settings = { start: false, enabled: false }, f = await fixture(t, settings)
  const original = f.message('.r 1d100', { messageId: 'disabled-ingress-ready-source' })
  const { ledger, inbox, source, queue, item } = await crashBeforeDiceClaim(f, original)
  await inbox.acknowledge(item.raw, queue)
  await f.host.start()
  assert.equal((await ledger.read(source)).record.state, 'ready', 'no queue or source event implies no scan of arbitrary operations')
  await f.emit(original); await f.drained()
  const revoked = await ledger.read(source)
  assert.equal(revoked.record.state, 'unknown'); assert.equal(Object.hasOwn(revoked.record, 'items'), false)
  assert.equal((await ledger.capture(source)).recalled, true)
  settings.enabled = true
  await f.restart(); await f.emit(original); await f.drained()
  assert.equal(f.sendsFor(original).length, 0)
  await f.host.stop()
  const workflow = createAgentDiceWorkflow(resolveAgentDiceConfig({ enabled: true }), { ledger,
    actions: { async send() { assert.fail('re-enabling dice cannot restore a source revoked during disabled ingress') } }, allowsText: () => true })
  await workflow.handle(original, f.binding(), { signal: new AbortController().signal, isCurrent: () => true, async ensureCurrent() {} })
  await f.assertScrubbed()
})

for (const configuration of ['omitted', 'disabled']) test(`Core public dice is closed when configuration is ${configuration}`, redisTest, async t => {
  const f = await fixture(t, { omitDice: configuration === 'omitted', enabled: false })
  const original = await f.send('.r 1d2')
  assert.equal(f.sendsFor(original).length, 0); assert.deepEqual(await f.records(), []); assert.equal(f.requests.length, 0)
})

for (const restriction of ['quote', 'quote-without-id', 'mention', 'attachment', 'parts-mismatch']) test(`Core public dice never evaluates a ${restriction} command`, redisTest, async t => {
  const f = await fixture(t, { groupLog: true })
  await f.startLog()
  const extra = restriction === 'quote' ? { quote: { messageId: 'real-quoted-message', parts: [] } }
    : restriction === 'quote-without-id' ? { quote: { parts: [] } }
    : restriction === 'mention' ? { mentions: [f.user('someone-else')], parts: [{ kind: 'mention', user: f.user('someone-else') }, { kind: 'text', text: '.r 1d2' }] }
    : restriction === 'attachment' ? { parts: [{ kind: 'text', text: '.r 1d2' }, { kind: 'image' }] }
    : { parts: [{ kind: 'text', text: '.r 1d100' }] }
  const original = await f.send('.r 1d2', extra)
  assert.equal((await f.rows()).filter(row => row.type === 'dice_result').length, 0)
  assert.ok(f.sendsFor(original).every(action => !textOf(action).includes(original.senderName)), 'a refusal may explain syntax but cannot produce a player result')
  assert.equal(f.requests.length, 0)
  await f.assertScrubbed()
})

test('private .r preserves ordinary friend-chat routing without dice effects, log rows or dice ledger entries', redisTest, async t => {
  const f = await fixture(t, { groupLog: true }), original = await f.send('.r 1d2', { conversation: f.privateTarget })
  assert.equal(f.requests.length, 1)
  assert.ok(f.requests[0].messages.some(message => message.role === 'user' && String(message.content).includes(original.text)))
  assert.deepEqual(await f.records(), []); assert.deepEqual(await f.rows(), [])
  const replies = f.sends.filter(action => conversationAddressKey(action.target) === conversationAddressKey(f.privateTarget))
  assert.equal(replies.length, 1)
  assert.equal(textOf(replies[0]), '普通聊天模型回复。')
})

test('Core dice without an authoritative message reader cannot dispatch a result', redisTest, async t => {
  const f = await fixture(t, { readPort: false }), original = await f.send('.r 1d2')
  assert.equal(f.sendsFor(original).length, 0); assert.equal(f.requests.length, 0)
})
