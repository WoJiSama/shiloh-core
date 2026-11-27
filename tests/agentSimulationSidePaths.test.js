import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
const { createSimulationRuntime } = await load('modules/simulation/infrastructure/simulationRuntime.js')
const { createSimSessionStore } = await load('modules/simulation/infrastructure/simSessionStore.js')
const { createDefaultSimSession } = await load('modules/simulation/domain/simConfig.js')
const { agentBindingToken } = await load('modules/runtime/domain/agentBindings.js')
const { AgentSimulationModelError } = await load('modules/simulation/infrastructure/agentSimulationModels.js')
const { PersonProfileExtractionError } = await load('modules/memory/infrastructure/agentPersonExtractor.js')
const at = 1800000000000, bot = '90000', user = '10001', group = '10086'
const target = { account: { platform: 'qq', namespace: 'global', id: bot }, kind: 'group', id: group }
const binding = { source: 'configured', id: 'side-binding', revision: 'r1', agentId: 'side-agent', personaId: 'default', connectionId: 'qq-side', target }
const sessionKey = `shiloh:sim:g:${group}`
async function until(check) {
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(10) }
  assert.fail('side path did not reach the expected observable boundary')
}
function fixture({ meme = false, style = false, personProfile = false, ...ports } = {}) {
  const data = new Map(), models = [], writes = [], clock = { at }
  const redis = { get: async key => data.get(key) ?? null, set: async (key, value) => { data.set(key, value); if (key === sessionKey) writes.push(JSON.parse(value)); return 'OK' },
    del: async (...keys) => keys.reduce((n, key) => n + Number(data.delete(key)), 0) }
  const state = createDefaultSimSession(at)
  Object.assign(state, { botId: bot, personaId: 'agent:side-agent', bindingToken: agentBindingToken(binding), bootstrapSent: true,
    seq: 20, lastIncomingAt: at, nextProactiveCheckAt: at + 86400000, nextReplyCheckAt: at + 86400000 })
  const sidePathOnly = meme || style || personProfile
  state.wakeConfig.triggers.probability = sidePathOnly ? 0 : 1
  state.recent = Array.from({ length: 20 }, (_, i) => ({ seq: i + 1, messageId: `source-${i + 1}`, userId: user, name: '群友', text: '蓝色星期八', at,
    atSelf: false, quoteToSelf: false, imageCount: 0, kind: 'text' }))
  data.set(sessionKey, JSON.stringify(state)); data.set('shiloh:sim:known', JSON.stringify([group]))
  data.set('shiloh:sim:overrides', JSON.stringify({ explicitEnabled: [group], disabled: [], atOnly: sidePathOnly ? [group] : [], budgetCaps: {}, turnCaps: {} }))
  const runtime = createSimulationRuntime({ redis, now: () => clock.at, random: () => 0.001,
    logger: { info() {}, warn() {}, error() {} }, getSelf: () => ({ id: bot, name: '机器人' }),
    getPersona: () => ({ binding, persona: {}, systemContent: '' }), getExecutionConfig: () => ({}),
    getSection: () => ({ enabled: true, allGroups: false, groups: [group], reflection: { enabled: false }, mood: { enabled: false }, rhythm: { enabled: false },
      userStyle: { enabled: style }, personProfile: { enabled: personProfile }, meme: { enabled: meme, extractMinMessages: 20 }, lifeThreads: { enabled: false },
      wake: { probability: sidePathOnly ? 0 : 1, proactiveProbability: 0, batchWindowMs: 100 } }),
    async YTapi(request) { models.push(request); return { choices: [{ message: { content: '[SILENT]' } }] } },
    sendGroupMessage: async () => ({ ok: true, messageId: 'sent' }), ...ports })
  const store = scope => createSimSessionStore({ redis, memoryScope: scope, now: () => clock.at })
  return { data, redis, runtime, models, writes, clock, store,
    async emit(id, directed = false) { clock.at++; return runtime.ingest({ version: 1, conversation: target, sender: { ...target.account, id: user },
      senderName: '群友', messageId: id, occurredAt: clock.at, text: id, parts: [{ kind: 'text', text: id }], mentions: directed ? [target.account] : [], directedToAccount: directed }) },
    session: () => JSON.parse(data.get(sessionKey)) }
}

test('configured wake gate carries its exact scope; rejection preserves a new directed message and null fails open', { timeout: 15000 }, async () => {
  const entered = Promise.withResolvers(), held = Promise.withResolvers()
  const f = fixture({ async wakeGateJudge(_input, current, context) {
    assert.deepEqual(context.binding, binding); assert.deepEqual(context.target, target)
    assert.equal(current(), true); await context.ensureCurrent(); entered.resolve(); await held.promise
    return { engage: false }
  } })
  try {
    await f.emit('ordinary-low-signal'); await entered.promise
    await f.emit('new-directed-message', true); held.resolve()
    await until(() => f.models.length); await f.runtime.drain()
    assert.ok(f.models.some(request => JSON.stringify(request.messages).includes('new-directed-message')))
    assert.ok(f.session().recent.some(message => message.messageId === 'new-directed-message'))
  } finally { held.resolve(); await f.runtime.stop(); await f.runtime.drain() }
  let calls = 0
  const open = fixture({ wakeGateJudge: async () => { calls++; return null } })
  try {
    await open.emit('unavailable-gate'); await until(() => open.models.length); await open.runtime.drain()
    assert.equal(calls, 1)
    await open.emit('direct-bypasses-gate', true); await until(() => open.models.length === 2); await open.runtime.drain()
    assert.equal(calls, 1)
  } finally { await open.runtime.stop(); await open.runtime.drain() }
})

test('simulation tool switches filter definitions and block forged calls and text fallback', { timeout: 10000 }, async () => {
  const { createAgentFeatureSwitches } = await load('modules/tools/domain/agentFeatureSwitches.js')
  const policy = createAgentFeatureSwitches({ tools: { simSendMessage: { mode: 'off' }, simFinishTurn: { mode: 'off' } } })
  const requests = [], sends = []
  const f = fixture({ isToolEnabled: policy.tool, getExecutionConfig: () => ({ providers: 'openai', useTools: true }),
    sendGroupMessage: async (...args) => { sends.push(args); return { ok: true, messageId: 'sent' } },
    async YTapi(request) {
      requests.push(request)
      if (requests.length === 1) return { choices: [{ message: { content: '', tool_calls: [{ id: 'blocked-send', type: 'function',
        function: { name: 'simSendMessage', arguments: JSON.stringify({ continuation: 'chat', messages: ['这条群消息不会投递'] }) } }] } }] }
      return { choices: [{ message: { content: '这段普通正文也不会投递。' } }] }
    },
  })
  try {
    await f.emit('switch-regression', true)
    await until(() => requests.length >= 2)
    await f.runtime.drain()
    assert.ok(requests[0].tools.some(row => row.function.name === 'simGetState'))
    assert.ok(requests.every(request => request.tools.every(row => !['simSendMessage', 'simFinishTurn'].includes(row.function.name))))
    assert.ok(requests[1].messages.some(row => row.role === 'tool' && row.content.includes('已关闭此工具')))
    assert.deepEqual(sends, [])
  } finally { await f.runtime.stop(); await f.runtime.drain() }
})

test('a provider failure is recorded once and subsequent wakes bypass screening until the provider can recover', { timeout: 15000 }, async () => {
  const diagnostics = []
  let requests = 0
  const f = fixture({ diagnostics: { emit: event => diagnostics.push(event) }, async wakeGateJudge() {
    if (++requests === 1) throw new AgentSimulationModelError('http_error', 429)
    return { engage: false }
  } })
  try {
    await f.emit('provider-rate-limit'); await until(() => f.models.length === 1); await f.runtime.drain()
    await f.emit('wake-during-provider-backoff'); await until(() => f.models.length === 2); await f.runtime.drain()
    assert.equal(requests, 1)
    f.clock.at += 60_001
    await f.emit('wake-after-provider-backoff'); await until(() => requests === 2); await f.runtime.drain()
    assert.equal(f.models.length, 2)
    assert.deepEqual(diagnostics.filter(event => event.operation === 'simulation_wake_gate').map(event => [event.outcome, event.code, event.httpStatus]),
      [['failed', 'http_error', 429], ['succeeded', undefined, undefined]])
  } finally { f.runtime.stop(); await f.runtime.drain() }
})

test('wake screening distinguishes recalled sources from source-check errors', { timeout: 15000 }, async () => {
  for (const [sourceState, expected] of [
    ['recalled', ['cancelled', 'wake_gate_source_changed']],
    ['read-error', ['failed', 'wake_gate_source_check_failed']],
  ]) {
    const events = []
    const sourceId = `screened-source-${sourceState}`
    let screened = false
    const f = fixture({ diagnostics: { emit: event => events.push(event) },
      async isMessageRecalled(_target, messageId) {
        if (!screened || messageId !== sourceId) return false
        if (sourceState === 'read-error') throw new Error('private read error')
        return true
      },
      async wakeGateJudge() { screened = true; return { engage: true } },
    })
    try {
      await f.emit(sourceId)
      await until(() => events.some(event => event.operation === 'simulation_wake_gate')).catch(() => {
        assert.fail(JSON.stringify({ sourceState, screened, operations: events.map(row => [row.operation, row.outcome, row.code]) }))
      })
      await f.runtime.drain()
      assert.equal(screened, true)
      assert.equal(f.models.length, 0)
      assert.deepEqual(events.filter(event => event.operation === 'simulation_wake_gate').map(event => [event.outcome, event.code]), [expected])
    } finally { f.runtime.stop(); await f.runtime.drain() }
  }
})

test('meme extraction discards a late recalled result while preserving new ingress and its pending wake', { timeout: 10000 }, async () => {
  const entered = Promise.withResolvers(), held = Promise.withResolvers()
  const f = fixture({ meme: true, async memeExtract(_messages, current, context) {
    assert.deepEqual(context.binding, binding); await context.ensureCurrent(); assert.equal(current(), true)
    entered.resolve(context); await held.promise; return '[{"content":"蓝色星期八","source_id":"1"}]'
  } })
  let sweep
  try {
    sweep = f.runtime.sweepOnce(); const context = await entered.promise
    await f.emit('arrival-during-meme', true)
    assert.equal(f.models.length, 0)
    assert.ok(f.session().pendingWakeReasons.some(reason => reason.kind === 'atMention' && reason.seq === 21))
    await f.runtime.handleRecall({ group_id: group, message_id: 'source-1' }); assert.equal(context.signal.aborted, true)
    held.resolve(); await sweep; await until(() => f.models.length); await f.runtime.drain()
    assert.equal(f.session().memeCursor, undefined)
    assert.ok(f.session().recent.some(message => message.messageId === 'arrival-during-meme'))
    assert.ok(f.models.some(request => JSON.stringify(request.messages).includes('arrival-during-meme')))
    assert.deepEqual(await f.store(binding).loadMemories(group), [])
  } finally { held.resolve(); await f.runtime.stop(); if (sweep) await sweep; await f.runtime.drain() }
})

test('a valid empty batch advances its cursor and does not reprocess old messages after cooldown', async () => {
  const events = []
  let attempts = 0
  const f = fixture({ meme: true, diagnostics: { emit: event => events.push(event) },
    async memeExtract() { attempts++; return '```json\n[]\n```' } })
  try {
    await f.runtime.sweepOnce()
    assert.deepEqual(f.session().memeCursor, { seq: 20, at })
    assert.equal(f.session().memeRetryAt, undefined)
    f.clock.at += 600_000
    await f.runtime.sweepOnce()
    assert.equal(attempts, 1)
    assert.ok(events.some(event => event.code === 'meme_batch_empty' && event.outcome === 'succeeded'))
    assert.deepEqual(await f.store(binding).loadMemories(group), [])
  } finally { await f.runtime.stop() }
})

test('a failed meme batch keeps its cursor, reports the HTTP failure once and retries after cooldown', async () => {
  const events = []
  let attempts = 0
  const f = fixture({ meme: true, diagnostics: { emit: event => events.push(event) },
    async memeExtract() {
      attempts++
      if (attempts === 1) throw new AgentSimulationModelError('http_error', 503)
      return '[]'
    } })
  try {
    await f.runtime.sweepOnce()
    assert.equal(f.session().memeCursor, undefined)
    assert.equal(f.session().memeRetryAt, at + 600_000)
    f.clock.at += 599_999
    await f.runtime.sweepOnce()
    assert.equal(attempts, 1)
    assert.deepEqual(events.filter(event => event.outcome === 'failed').map(event => [event.operation, event.code, event.httpStatus]), [
      ['simulation_meme_extract', 'http_error', 503],
    ])
    f.clock.at++
    await f.runtime.sweepOnce()
    assert.equal(attempts, 2)
    assert.equal(f.session().memeCursor.seq, 20)
    assert.equal(f.session().memeRetryAt, undefined)
  } finally { await f.runtime.stop() }
})

test('meme output validation retries once with current sources and accounts for both calls', async () => {
  for (const recovers of [true, false]) {
    const events = [], requests = [], usage = []
    const f = fixture({ meme: true, diagnostics: { emit: event => events.push(event) },
      recordTokens: record => usage.push(record),
      async memeExtract(messages, current, context) {
        await context.ensureCurrent()
        assert.equal(current(), true)
        requests.push(messages)
        context.recordUsage('fixture', { total_tokens: 10 })
        if (requests.length === 1 || !recovers) throw new AgentSimulationModelError('meme_output_schema_invalid')
        return '[{"content":"蓝色星期八","source_id":1}]'
      },
    })
    try {
      await f.runtime.sweepOnce()
      assert.equal(requests.length, 2)
      assert.deepEqual(requests[0], requests[1])
      assert.equal(usage.filter(row => row.stage === 'meme-extract').length, 2)
      assert.ok(events.some(row => row.operation === 'simulation_meme_extract_response' &&
        row.outcome === 'failed' && row.code === 'meme_output_schema_invalid' && row.details.result === 'retry_scheduled'))
      if (recovers) {
        assert.equal(f.session().memeCursor.seq, 20)
        assert.equal(f.session().memeRetryAt, undefined)
        assert.deepEqual((await f.store(binding).loadMemories(group)).map(row => row.content), ['蓝色星期八'])
        assert.ok(events.some(row => row.operation === 'simulation_meme_extract_response' && row.outcome === 'succeeded' && row.code === 'meme_output_schema_recovered'))
      } else {
        assert.equal(f.session().memeCursor, undefined)
        assert.equal(f.session().memeRetryAt, at + 600_000)
        assert.deepEqual(events.filter(row => row.operation === 'simulation_meme_extract').map(row => [row.outcome, row.code]),
          [['failed', 'meme_output_schema_invalid']])
      }
    } finally { await f.runtime.stop() }
  }
})

test('style cache separates account and Agent, and revoked originals cannot replace a prior scoped cache', async () => {
  let allow = false
  const f = fixture({ style: true, readUserStyleSources: async (address, _days, current, signal) => {
    assert.deepEqual(address, target); assert.equal(current(), true); assert.equal(signal.aborted, false)
    return { messages: Array.from({ length: 60 }, () => ({ userId: user, text: '独家短语' })), isCurrent: async () => allow }
  } })
  const first = f.store(binding), otherAgent = f.store({ ...binding, agentId: 'other-agent' }),
    otherAccount = f.store({ ...binding, target: { ...target, account: { ...target.account, id: '90001' } } })
  try {
    await first.saveUserStyle(group, { [user]: ['原有风格'] })
    assert.deepEqual((await otherAgent.loadUserStyle(group)).users, {})
    assert.deepEqual((await otherAccount.loadUserStyle(group)).users, {})
    f.clock.at += 86400000
    await f.runtime.sweepOnce()
    assert.deepEqual((await first.loadUserStyle(group)).users, { [user]: ['原有风格'] })
    allow = true; await f.runtime.sweepOnce()
    assert.notDeepEqual((await first.loadUserStyle(group)).users, { [user]: ['原有风格'] })
    assert.deepEqual((await otherAgent.loadUserStyle(group)).users, {})
    assert.deepEqual((await otherAccount.loadUserStyle(group)).users, {})
  } finally { await f.runtime.stop() }
})

test('person profile timeout reports one alarm and preserves the original batch until its retry', async () => {
  const events = [], batches = []
  const f = fixture({ personProfile: true, diagnostics: { emit: event => events.push(event) },
    async personProfileExtract(messages) {
      batches.push(structuredClone(messages))
      if (batches.length === 1) throw new PersonProfileExtractionError('provider_timeout')
      return '[]'
    } })
  try {
    await f.runtime.sweepOnce()
    assert.equal(f.session().personProfileCursor, undefined)
    assert.equal(f.session().personProfileRetryAt, at + 60_000)
    assert.deepEqual(events.filter(event => event.outcome === 'failed').map(event => [event.operation, event.code]), [
      ['simulation_person_profile_extract', 'provider_timeout'],
    ])
    f.clock.at += 59_999
    await f.runtime.sweepOnce()
    assert.equal(batches.length, 1)
    f.clock.at++
    await f.runtime.sweepOnce()
    assert.equal(batches.length, 2)
    assert.deepEqual(batches[1], batches[0])
    assert.equal(f.session().personProfileCursor.seq, 20)
    assert.equal(f.session().personProfileRetryAt, undefined)
  } finally { await f.runtime.stop() }
})
