import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { createSimulationRuntime } = await load('modules/simulation/infrastructure/simulationRuntime.js')
const { simulationSessionKey } = await load('modules/simulation/infrastructure/simSessionStore.js')
const { createDefaultSimSession } = await load('modules/simulation/domain/simConfig.js')
const { simulationAddressKey } = await load('modules/simulation/infrastructure/simulationAddress.js')
const { agentBindingToken, agentPersonaScopeId } = await load('modules/runtime/domain/agentBindings.js')
const AT = 1_800_000_000_000, IMAGE = { mime: 'image/png', base64: 'dGVzdC1pbWFnZQ==' }
let sequence = 0
const call = (name, args) => ({ id: `emoji-${++sequence}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const response = (...tool_calls) => ({ choices: [{ message: { content: '', tool_calls } }] })
async function until(probe, errors) {
  const deadline = performance.now() + 6500
  while (performance.now() < deadline) { if (await probe()) return; await delay(10) }
  assert.fail(`sticker collection did not settle: ${errors.join('|')}`)
}
async function fixture(t, settings = {}) {
  const data = new Map(), requests = [], reads = [], collections = [], errors = [], recalled = new Set()
  const redis = { get: async key => data.get(key) ?? null, set: async (key, value) => { data.set(key, value); return 'OK' },
    del: async (...keys) => keys.reduce((count, key) => count + Number(data.delete(key)), 0) }
  const account = { platform: 'qq', namespace: 'global', id: '90000' }, target = { account, kind: 'group', id: '10086' }
  const binding = { source: 'configured', id: 'emoji-binding', revision: 'first', agentId: 'emoji-agent', personaId: 'same-template', connectionId: 'qq-emoji', target }
  const key = simulationAddressKey(target), memory = new AbortController(), user = { ...account, id: '10001' }
  const incoming = { version: 1, conversation: target, sender: user, senderName: '图片发言者', messageId: `emoji-source-${++sequence}`, occurredAt: AT - 1000,
    text: '看看这张图。', parts: [{ kind: 'text', text: '看看这张图。' }, { kind: 'image', resource: { kind: 'reference', value: 'incoming-image' } }],
    mentions: [account], directedToAccount: true }
  const original = settings.quote ? { ...incoming, sender: { ...user, id: '10002' }, messageId: 'quoted-original', occurredAt: AT - 2000, text: '真实引用附图' } : incoming
  if (settings.quote) { incoming.parts = [{ kind: 'text', text: incoming.text }]; incoming.quote = { messageId: original.messageId, parts: [] } }
  const state = createDefaultSimSession(AT)
  Object.assign(state, { botId: account.id, bindingToken: agentBindingToken(binding), personaId: agentPersonaScopeId(binding.agentId), bootstrapSent: true,
    nextProactiveCheckAt: AT + 86400000, nextReplyCheckAt: AT + 86400000 })
  state.wakeConfig.triggers = { ...state.wakeConfig.triggers, probability: 0, question: false, nameMention: false, anyMessage: false }
  data.set(simulationSessionKey(key), JSON.stringify(state)); data.set('shiloh:sim:known', JSON.stringify([key]))
  const f = { data, redis, target, account, user, binding, originalBinding: binding, key, memory, memoryCurrent: true, emojiCurrent: true,
    requests, reads, collections, errors, incoming, original, recalled }
  let round = 0
  f.runtime = createSimulationRuntime({ redis, now: () => AT, random: () => 0.99, durableIngress: true,
    logger: { info() {}, warn(...args) { errors.push(args.join(' ')) }, error(...args) { errors.push(args.join(' ')) } },
    handlesTarget: () => true, allowsConversationAI: () => true, isAccountReady: () => true,
    getSelf: () => ({ id: account.id, name: '收藏角色' }),
    getPersona: () => ({ binding: f.binding, personaId: agentPersonaScopeId(f.binding.agentId), persona: {}, systemContent: '' }),
    getSection: () => ({ enabled: true, allGroups: true, reflection: { enabled: false }, consistency: { enabled: false }, rhythm: { enabled: false },
      mood: { enabled: false }, wakeGate: { enabled: false }, userStyle: { enabled: false }, meme: { enabled: false }, personProfile: { enabled: false }, lifeThreads: { enabled: false },
      toolPolicy: { mode: 'open' }, wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 100 },
      turn: { minSendGapMs: 0, maxSendsPerTurn: 3, maxToolRounds: 5, maxTurnsPerDay: 100 } }),
    getExecutionConfig: () => ({ useTools: true }), supportsMessageImages: () => true,
    beginMemoryTurn: async () => ({ signal: memory.signal, isCurrent: () => f.memoryCurrent, release() {} }),
    isLocalEmojiCurrent: () => f.emojiCurrent, isMessageRecalled: async (_target, id) => recalled.has(id),
    readQuotedMessage: async () => original,
    async readMessageImages(address, source, guard) {
      reads.push({ address, source, guard }); assert.deepEqual(address, target); assert.equal(guard.isCurrent(), true)
      if (settings.read) return settings.read(f, guard)
      return await guard.allowsSource(original) ? [IMAGE] : []
    },
    async collectMessageSticker(image, guard) {
      collections.push({ image, guard }); assert.deepEqual(image, IMAGE); assert.deepEqual(guard.binding, f.originalBinding)
      await guard.ensureCurrent(); assert.equal(guard.isCurrent(), true); assert.equal(guard.signal.aborted, false)
      return settings.collect ? settings.collect(f, guard) : { ok: true }
    },
    messageActions: { send: async () => ({ state: 'sent', messageId: 'sent-emoji' }) },
    async YTapi(request) { requests.push(structuredClone(request)); return round++ === 0
      ? response(call('simCollectSticker', { seq: settings.seq ?? 1 }))
      : response(call('simFinishTurn', { choice: 'silent', reason: '收藏验证结束' })) } })
  f.run = async () => {
    await f.runtime.ingest(incoming)
    await until(async () => requests.length > 0 && !(await f.runtime.describeGroup(key)).running, errors)
    await f.runtime.drain()
  }
  f.toolResults = () => requests.flatMap(request => request.messages.filter(message => message.role === 'tool' && message.name === 'simCollectSticker').map(message => message.content))
  t.after(async () => { f.runtime.stop(); await f.runtime.drain() })
  return f
}

for (const quote of [false, true]) test(`collection re-reads a visible ${quote ? 'quoted' : 'primary'} image with its actual source author, id and time without a vision model`, { timeout: 12000 }, async t => {
  const f = await fixture(t, { quote, async read(run, guard) {
    const original = run.original
    assert.equal(await guard.allowsSource(original), true)
    for (const changed of [
      { ...original, messageId: 'wrong-original' },
      { ...original, sender: { ...original.sender, id: '19999' } },
      { ...original, sender: { ...original.sender, platform: 'other-platform' } },
      { ...original, sender: { ...original.sender, namespace: 'other-namespace' } },
      { ...original, occurredAt: original.occurredAt + 1 },
      { ...original, conversation: { ...run.target, account: { ...run.account, id: '90001' } } },
      { ...original, conversation: { ...run.target, id: '10087' } },
    ]) assert.equal(await guard.allowsSource(changed), false)
    return [IMAGE]
  } })
  await f.run(); assert.equal(f.reads.length, 1); assert.equal(f.collections.length, 1)
  assert.deepEqual(f.reads[0].source, { messageId: f.incoming.messageId, ...(quote ? { quotedMessageId: f.original.messageId } : {}) })
  assert.deepEqual(f.collections[0].guard.source, { messageId: f.original.messageId, author: f.original.sender, occurredAt: f.original.occurredAt })
  assert.ok(f.requests[0].tools.some(tool => tool.function.name === 'simCollectSticker'))
  assert.ok(f.toolResults().some(result => result.includes('"ok":true')))
})

for (const seq of [0, -1, 999, 1.5]) test(`collection rejects unavailable image sequence ${seq}`, { timeout: 12000 }, async t => {
  const f = await fixture(t, { seq }); await f.run()
  assert.deepEqual(f.reads, []); assert.deepEqual(f.collections, [])
  assert.ok(f.toolResults().every(result => !result.includes('"ok":true')))
})

test('an unproven adapter image source cannot reach the collector', { timeout: 12000 }, async t => {
  const f = await fixture(t, { async read(run, guard) {
    const different = { ...run.original, sender: { ...run.user, id: '19999' } }
    return await guard.allowsSource(different) ? [IMAGE] : []
  } })
  await f.run(); assert.equal(f.reads.length, 1); assert.deepEqual(f.collections, [])
  assert.ok(f.toolResults().some(result => result.startsWith('error:')))
})

test('a source recalled during the image reread cannot start collection', { timeout: 12000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const f = await fixture(t, { async read(run, guard) { assert.equal(await guard.allowsSource(run.original), true); entered.resolve(); await release.promise; return [IMAGE] } })
  let running
  try {
    running = f.run(); await entered.promise; f.recalled.add(f.original.messageId)
    await f.runtime.handleRecall({ group_id: f.target.id, message_id: f.original.messageId }, f.target)
    release.resolve(); await running; assert.deepEqual(f.collections, [])
  } finally { release.resolve(); if (running) await running }
})

for (const scenario of ['binding', 'primary recall', 'quoted recall', 'cancel', 'forget', 'collector disabled']) {
  test(`a collector held across ${scenario} cannot return a late success`, { timeout: 12000 }, async t => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers()
    const f = await fixture(t, { quote: scenario === 'quoted recall', async collect(_run, guard) { entered.resolve(guard); await release.promise; return { ok: true } } })
    let running
    try {
      running = f.run(); const guard = await entered.promise
      if (scenario === 'binding') f.binding = { ...f.binding, revision: 'second', agentId: 'other-agent' }
      else if (scenario === 'cancel') f.runtime.invalidateConversation(f.target)
      else if (scenario === 'forget') { f.memoryCurrent = false; f.memory.abort() }
      else if (scenario === 'collector disabled') f.emojiCurrent = false
      else { f.recalled.add(f.original.messageId); await f.runtime.handleRecall({ group_id: f.target.id, message_id: f.original.messageId }, f.target) }
      release.resolve(); await running; await delay(30); await f.runtime.drain()
      await assert.rejects(guard.ensureCurrent()); assert.equal(guard.isCurrent(), false)
      assert.ok(f.toolResults().every(result => !result.includes('"ok":true')))
    } finally { release.resolve(); if (running) await running }
  })
}
