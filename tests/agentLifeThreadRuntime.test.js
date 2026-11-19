import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { createAgentLifeThreadRuntime } = await load('modules/simulation/infrastructure/agentLifeThreadRuntime.js')
const { createSimulationRuntime } = await load('modules/simulation/infrastructure/simulationRuntime.js')
const { createSimSessionStore, simulationSessionKey } = await load('modules/simulation/infrastructure/simSessionStore.js')
const { createDefaultSimSession } = await load('modules/simulation/domain/simConfig.js')
const { simulationAddressKey } = await load('modules/simulation/infrastructure/simulationAddress.js')
const { agentBindingToken, agentPersonaScopeId } = await load('modules/runtime/domain/agentBindings.js')
const { personMemoryAddress } = await load('modules/memory/infrastructure/personMemoryContext.js')
const AT = 1_800_000_000_000
let sequence = 0
const call = (name, args) => ({ id: `life-${++sequence}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const response = (...tool_calls) => ({ choices: [{ message: { content: '', tool_calls } }] })
const finish = () => response(call('simFinishTurn', { choice: 'silent', reason: '生活线验证结束' }))
async function until(probe, errors = []) {
  const deadline = performance.now() + 6500
  while (performance.now() < deadline) { if (await probe()) return; await delay(10) }
  assert.fail(`life thread did not reach its observable boundary: ${errors.join('|')}`)
}
function memoryRedis() {
  const data = new Map(), writes = []
  return { data, writes, redis: { get: async key => data.get(key) ?? null,
    set: async (key, value) => { data.set(key, value); writes.push({ key, value }); return 'OK' },
    del: async (...keys) => keys.reduce((count, key) => count + Number(data.delete(key)), 0) } }
}
function scopedStore(redis, binding, now = () => AT) {
  const { botId, scene } = personMemoryAddress(binding.target)
  return createSimSessionStore({ redis, now, memoryScope: binding,
    characterScope: { botId, personaId: agentPersonaScopeId(binding.agentId), groupId: scene.id } })
}
function context(binding, extra = {}) {
  return { binding, signal: new AbortController().signal, isCurrent: () => true, ensureCurrent: async () => {}, ...extra }
}
function bindingFor(agentId = 'life-agent', accountId = '90000', groupId = '10086') {
  return { source: 'configured', id: `life-binding-${agentId}`, revision: 'first', agentId, personaId: 'shared-persona', connectionId: 'qq-life',
    target: { account: { platform: 'qq', namespace: 'global', id: accountId }, kind: 'group', id: groupId } }
}
async function fixture(t, settings = {}) {
  const mem = memoryRedis(), binding = bindingFor(), target = binding.target, key = simulationAddressKey(target), errors = [], requests = []
  const config = { enabled: true, allGroups: true, reflection: { enabled: false }, consistency: { enabled: false }, rhythm: { enabled: false },
    mood: { enabled: false }, wakeGate: { enabled: false }, userStyle: { enabled: false }, meme: { enabled: false }, personProfile: { enabled: false },
    lifeThreads: { enabled: true, syncIntervalMs: 60000 }, toolPolicy: { mode: 'open' },
    wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 100, maxWakePerMinute: 100, maxWakePerHour: 100 },
    turn: { minSendGapMs: 0, maxSendsPerTurn: 3, maxToolRounds: 8, maxTurnsPerDay: 100 } }
  const state = createDefaultSimSession(AT)
  Object.assign(state, { botId: target.account.id, bindingToken: agentBindingToken(binding), personaId: agentPersonaScopeId(binding.agentId),
    bootstrapSent: true, nextProactiveCheckAt: AT + 86400000, nextReplyCheckAt: AT + 86400000 })
  state.wakeConfig.triggers = { ...state.wakeConfig.triggers, probability: 0, question: false, nameMention: false, anyMessage: false }
  mem.data.set(simulationSessionKey(key), JSON.stringify(state)); mem.data.set('shiloh:sim:known', JSON.stringify([key]))
  const f = { ...mem, target, key, binding, originalBinding: binding, config, requests, errors, clock: AT, memoryCurrent: true, memory: new AbortController() }
  let round = 0
  f.runtime = createSimulationRuntime({ redis: mem.redis, now: () => f.clock, random: () => 0.99, durableIngress: true,
    logger: { info() {}, warn(...args) { errors.push(args.join(' ')) }, error(...args) { errors.push(args.join(' ')) } },
    handlesTarget: () => true, allowsConversationAI: () => true, isAccountReady: () => true,
    getSelf: () => ({ id: target.account.id, name: '生活线角色' }),
    getPersona: () => ({ binding: f.binding, personaId: agentPersonaScopeId(f.binding.agentId), persona: {}, systemContent: '' }),
    getSection: () => config, getExecutionConfig: () => ({ useTools: true }), lifeThreadProvider: settings.provider,
    beginMemoryTurn: async () => ({ signal: f.memory.signal, isCurrent: () => f.memoryCurrent, release() {} }),
    messageActions: { send: async () => ({ state: 'sent', messageId: 'sent-life' }) },
    async YTapi(request) { requests.push(structuredClone(request)); return settings.script ? settings.script(round++, f, request) : round++ === 0
      ? response(call('simLifeThread', { action: 'follow', title: '测试作品' })) : finish() } })
  f.store = chosen => scopedStore(mem.redis, chosen ?? f.originalBinding, () => f.clock)
  f.run = async () => {
    const before = requests.length; round = 0; f.lastMessageId = `life-source-${++sequence}`
    await f.runtime.ingest({ version: 1, conversation: target, sender: { ...target.account, id: '10001' }, senderName: '真人群友',
      messageId: f.lastMessageId, occurredAt: f.clock - 1000, text: '请管理正在追的作品。', parts: [{ kind: 'text', text: '请管理正在追的作品。' }],
      mentions: [target.account], directedToAccount: true })
    await until(async () => requests.length > before && !(await f.runtime.describeGroup(key)).running, errors)
    await f.runtime.drain()
  }
  t.after(async () => { f.runtime.stop(); await f.runtime.drain() })
  return f
}

test('life thread follow, list and drop run through actual simulation tools with the complete provider context', { timeout: 12000 }, async t => {
  const resolved = []
  const f = await fixture(t, { provider: { async resolve(input, guard) {
    resolved.push(input); assert.deepEqual(guard.binding, f.binding); assert.equal(guard.isCurrent(), true)
    assert.equal(guard.signal.aborted, false); await guard.ensureCurrent()
    return { ok: true, sourceId: '12345', title: '测试作品', episode: 2 }
  }, async sync() { assert.fail('a foreground tool must not start background sync') } }, script(round) {
    return round === 0 ? response(call('simLifeThread', { action: 'follow', title: '测试作品' }))
      : round === 1 || round === 3 ? response(call('simLifeThread', { action: 'list' }))
        : round === 2 ? response(call('simLifeThread', { action: 'drop', title: '测试作品' })) : finish()
  } })
  await f.run()
  assert.deepEqual(resolved, [{ title: '测试作品' }]); assert.equal(f.requests.length, 5)
  assert.match(JSON.stringify(f.requests[2].messages), /测试作品.*在追.*第 2 集/u)
  assert.match(JSON.stringify(f.requests[4].messages), /测试作品.*已弃/u)
  const threads = await f.store().loadLifeThreads()
  assert.equal(threads.length, 1); assert.equal(threads[0].sourceId, '12345'); assert.equal(threads[0].status, 'dropped')
})

test('life thread storage separates Agents with one persona, accounts and conversations', async () => {
  const { redis } = memoryRedis(), binding = bindingFor(), runtime = createAgentLifeThreadRuntime({
    resolve: async ({ title }) => ({ ok: true, title, sourceId: '12345' }), sync: async () => ({ newNotes: [] }) }, () => AT)
  const variants = [bindingFor('another-agent'), bindingFor('life-agent', '90001'), bindingFor('life-agent', '90000', '10087')]
  await runtime.follow('只属于第一个角色', scopedStore(redis, binding), context(binding))
  for (const other of variants) {
    assert.equal(other.personaId, binding.personaId)
    assert.deepEqual(await runtime.list(scopedStore(redis, other), context(other)), [])
  }
  assert.equal((await runtime.list(scopedStore(redis, binding), context(binding)))[0].title, '只属于第一个角色')
})

test('empty sync persists lastSyncAt and background scheduling respects that checkpoint', { timeout: 12000 }, async t => {
  const calls = []
  const f = await fixture(t, { provider: { resolve: async () => ({ ok: true, sourceId: '12345', title: '测试作品', episode: 3 }),
    async sync(input, guard) { calls.push(input); assert.deepEqual(guard.binding, f.originalBinding); await guard.ensureCurrent(); return { newNotes: [], episode: 3 } } } })
  await createAgentLifeThreadRuntime({ resolve: async () => ({ ok: true, sourceId: '12345', title: '测试作品', episode: 3 }), sync: async () => ({ newNotes: [] }) }, () => f.clock)
    .follow('测试作品', f.store(), context(f.binding))
  await f.runtime.sweepOnce(); await f.runtime.drain()
  const [saved] = await f.store().loadLifeThreads()
  assert.equal(calls.length, 1); assert.equal(saved.lastSyncAt, AT); assert.equal(saved.lastEpisode, 3); assert.deepEqual(saved.notes, [])
  await f.runtime.sweepOnce(); await f.runtime.drain(); assert.equal(calls.length, 1)
})

test('sync, follow and drop serialize their complete read-provider-write operations without losing an update', async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), binding = bindingFor(), mem = memoryRedis(), store = scopedStore(mem.redis, binding)
  const runtime = createAgentLifeThreadRuntime({ resolve: async ({ title }) => ({ ok: true, title, sourceId: title === '第一部' ? '1' : '2' }),
    async sync() { entered.resolve(); await release.promise; return { newNotes: ['真实新集'], episode: 2 } } }, () => AT)
  await runtime.follow('第一部', store, context(binding))
  const sync = runtime.sync(1, store, context(binding)); await entered.promise
  const follow = runtime.follow('第二部', store, context(binding)), drop = runtime.drop('第一部', store, context(binding))
  release.resolve(); await Promise.all([sync, follow, drop])
  const saved = await store.loadLifeThreads()
  assert.equal(saved.length, 2); assert.equal(saved.find(thread => thread.title === '第一部').status, 'dropped')
  assert.deepEqual(saved.find(thread => thread.title === '第一部').notes, ['真实新集'])
  assert.equal(saved.find(thread => thread.title === '第二部').status, 'active')
})

test('six retained dropped entries cannot evict a newly followed active work', async () => {
  const binding = bindingFor(), mem = memoryRedis(), store = scopedStore(mem.redis, binding)
  await store.saveLifeThreads(Array.from({ length: 6 }, (_, index) => ({ id: `old-${index}`, kind: 'anime', title: `已弃作品${index}`,
    sourceId: String(index + 1), status: 'dropped', addedAt: AT - index - 1, lastSyncAt: 0, notes: [] })))
  const runtime = createAgentLifeThreadRuntime({ resolve: async ({ title }) => ({ ok: true, title, sourceId: '12345' }),
    sync: async () => ({ newNotes: [] }) }, () => AT)
  assert.equal((await runtime.follow('新追作品', store, context(binding))).ok, true)
  const saved = await store.loadLifeThreads()
  assert.ok(saved.some(thread => thread.title === '新追作品' && thread.status === 'active'))
  assert.equal(saved.length, 6)
})

for (const scenario of ['binding', 'role pause', 'simulation disabled', 'life thread disabled', 'cancel', 'forget', 'source recall']) {
  test(`a life thread provider held across ${scenario} cannot make a late persistence write`, { timeout: 12000 }, async t => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers()
    const f = await fixture(t, { provider: { async resolve(_input, guard) {
      entered.resolve(guard); await release.promise; return { ok: true, sourceId: '12345', title: '迟到作品' }
    }, sync: async () => ({ newNotes: [] }) } })
    let running
    try {
      running = f.run(); const guard = await entered.promise
      if (scenario === 'binding') f.binding = { ...f.binding, revision: 'second', agentId: 'replacement-agent' }
      else if (scenario === 'role pause') await f.runtime.controlCharacter(f.key, 'pause')
      else if (scenario === 'simulation disabled') f.config.enabled = false
      else if (scenario === 'life thread disabled') f.config.lifeThreads.enabled = false
      else if (scenario === 'cancel') f.runtime.invalidateConversation(f.target)
      else if (scenario === 'forget') { f.memoryCurrent = false; f.memory.abort() }
      else await f.runtime.handleRecall({ group_id: f.target.id, message_id: f.lastMessageId }, f.target)
      release.resolve(); await running; await delay(30); await f.runtime.drain()
      await assert.rejects(guard.ensureCurrent())
      assert.deepEqual(await f.store().loadLifeThreads(), [])
      assert.equal(f.writes.filter(write => write.key.endsWith(':life-threads')).length, 0)
    } finally { release.resolve(); if (running) await running }
  })
}
