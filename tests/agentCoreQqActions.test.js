import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const { createAgentRuntime } = await load('core/agentRuntime.js')
const { createAgentBindingDirectory, agentBindingToken, agentPersonaScopeId, conversationAddressKey, platformAccountKey } = await load('modules/runtime/domain/agentBindings.js')
const { createAgentDiagnostics } = await load('modules/runtime/infrastructure/agentDiagnostics.js')
const { createDefaultSimSession } = await load('modules/simulation/domain/simConfig.js')
const { simulationAddressKey } = await load('modules/simulation/infrastructure/simulationAddress.js')
const { simulationSessionKey, simulationBusyKey } = await load('modules/simulation/infrastructure/simSessionStore.js')
const { personMemoryCommandText } = await load('modules/memory/domain/personMemoryCommands.js')

const redisTest = { skip: !redisAvailable, timeout: 25_000 }
const names = ['sendGiftTool', 'qqZoneTool', 'grabRedBagTool', 'simQzoneInteract']
const sourceKey = (target, id) => JSON.stringify([conversationAddressKey(target), id])
const call = (name, args = {}) => ({ id: 'core-qq-call-' + ++sequence, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const response = (...tool_calls) => ({ choices: [{ message: { content: '', tool_calls } }], usage: { total_tokens: 1 } })
const finish = () => response(call('simFinishTurn', { choice: 'silent', reason: '本次验证结束' }))
const defaultConfig = () => ({ gift: { enabled: true }, qzone: { enabled: true }, redPackets: { enabled: true, allowExplicit: true,
  automatic: { enabled: true, toolConfigured: true } } })
let sequence = 0

async function waitFor(probe, description) {
  const deadline = performance.now() + 7500
  while (performance.now() < deadline) { if (await probe()) return; await delay(10) }
  assert.fail(description())
}

async function fixture(t, settings = {}) {
  let host, diagnostics
  t.after(async () => { settings.release?.(); await host?.stop(); await diagnostics?.flush() })
  const redis = await createAgentRedisFixture(t, 'core-qq-actions')
  const account = { platform: 'qq', namespace: 'global', id: '19000001' }
  const target = { account, kind: 'group', id: '310001' }, user = { ...account, id: '170001' }
  const config = { version: 1, agents: [{ id: 'role', personaId: 'default' }, { id: 'other', personaId: 'default' }],
    connections: [{ id: 'main', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: [{ connectionId: 'main', kind: 'group', conversationId: target.id, agentId: 'role' }] }
  let directory = createAgentBindingDirectory(config, 'initial'), accept, ready = false, current = true, round = 0
  const qqConfig = settings.config ?? defaultConfig(), sources = new Map(), packets = new Map(), packetEpochs = new Map()
  const requests = [], gifts = [], qzone = [], grabs = [], passwords = [], sends = [], reads = [], diagnosticsRows = [], revocations = []
  const key = simulationAddressKey(target), sessionKey = simulationSessionKey(key)
  let epoch = 0, invalidations = 0, f
  diagnostics = createAgentDiagnostics({ logger: { info() {}, warn() {}, error() {} }, sink: { async append(row) { diagnosticsRows.push(structuredClone(row)); return true } } })
  const binding = () => directory.resolve(target)
  async function seedSession() {
    const initial = createDefaultSimSession(Date.now())
    initial.bootstrapSent = true; initial.botId = account.id; initial.bindingToken = agentBindingToken(binding()); initial.personaId = agentPersonaScopeId(binding().agentId)
    initial.nextProactiveCheckAt = Date.now() + 86_400_000
    initial.wakeConfig.triggers = { ...initial.wakeConfig.triggers, probability: 0, question: false, nameMention: false, anyMessage: false }
    await redis.storage.set(sessionKey, JSON.stringify(initial))
  }
  const validPacket = packet => packetEpochs.get(packet.packetRef) === epoch && packets.get(packet.source.messageId)?.packetRef === packet.packetRef
  const adapter = { id: 'main', account, botUserId: account.id, botName: '隔离角色', isReady: () => ready,
    start(callback) { accept = callback; ready = true }, stop() { ready = false },
    async readMessage(address, id, guard) {
      reads.push({ target: structuredClone(address), id })
      await settings.read?.(f, address, id, guard)
      if (guard?.isCurrent?.() === false) return undefined
      return structuredClone(sources.get(sourceKey(address, id)))
    },
    async readConversationMember(address, subject, guard) {
      await settings.member?.(f, address, subject, guard)
      return guard?.isCurrent?.() === false ? undefined : { target: address, observedAt: Date.now(), member: { user: subject, displayName: '当前真人', role: 'member' } }
    },
    actions: { async send(action, guard) {
      await guard?.ensureCurrent?.()
      if (guard?.isCurrent?.() === false) return { state: 'failed', code: 'stale' }
      sends.push(structuredClone(action)); return { state: 'sent', messageId: 'native-text-' + sends.length }
    } },
    ...(settings.giftPort === false ? {} : { async gift(action, guard) {
      await settings.beforeEffect?.(f, 'gift', action, guard)
      await guard.ensureCurrent(); gifts.push(structuredClone(action))
      return settings.giftReceipt ?? { state: 'confirmed', evidence: 'packet-accepted' }
    } }),
    ...(settings.qzonePort === false ? {} : { qzone: { async execute(action, guard) {
      await settings.beforeEffect?.(f, 'qzone', action, guard)
      await guard.ensureCurrent(); qzone.push(structuredClone(action))
      return settings.qzoneReceipt ?? { state: 'confirmed', postId: 'own-post-1' }
    } } }),
    ...(settings.packetPort === false ? {} : { redPackets: {
      async read(address, id, guard) { await guard.ensureCurrent(); const packet = packets.get(id); return packet && validPacket(packet) && conversationAddressKey(address) === conversationAddressKey(target) ? structuredClone(packet) : undefined },
      async recent(_address, guard) { await guard.ensureCurrent(); return [...packets.values()].filter(validPacket).reverse().slice(0, guard.limit).map(packet => structuredClone(packet)) },
      async revalidate(packet, guard) { await guard.ensureCurrent(); return validPacket(packet) },
      async sendPassword(packet, guard) { await guard.ensureCurrent(); if (!validPacket(packet)) return { state: 'failed' }; passwords.push(structuredClone(packet)); return { state: 'confirmed', messageId: 'native-password-' + passwords.length } },
      async grab(packet, guard) {
        await settings.beforeGrab?.(f, packet, guard)
        await guard.ensureCurrent()
        if (!validPacket(packet)) return { state: 'failed' }
        grabs.push(structuredClone(packet)); return settings.packetReceipt ?? { state: 'confirmed', amountFen: 123 }
      },
      revoke(address, id) { revocations.push({ target: structuredClone(address), id }); packets.delete(id) },
    } }),
    invalidateRedPacketSources() { invalidations++; epoch++; packets.clear() },
  }
  function makeHost() {
    return createAgentRuntime({ storage: redis.storage, adapters: [adapter], diagnostics, isExecutionCurrent: redis.isCurrent,
      ...(settings.omitConfig ? {} : { qqActions: qqConfig }), isQqActionsCurrent: () => current,
      ...(settings.tools ? { toolRegistry: { builtIn: settings.tools } } : {}),
      memorySystem: { enabled: false }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false }, groupMemory: { enabled: false },
      groupLog: { enabled: false },
      resolvePersona: address => ({ binding: directory.resolve(address), persona: { name: '隔离角色' }, systemContent: '只执行当前真人请求。' }),
      getSection: () => ({ enabled: true, allGroups: true, reflection: { enabled: false }, consistency: { enabled: false }, rhythm: { enabled: false }, mood: { enabled: false },
        wakeGate: { enabled: false }, personProfile: { enabled: false }, meme: { enabled: false }, userStyle: { enabled: false }, lifeThreads: { enabled: false },
        qzone: { enabled: settings.simulationQzone === true, minAffinity: 75 },
        wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000, maxWakePerMinute: 100, maxWakePerHour: 100 },
        turn: { minSendGapMs: 0, maxSendsPerTurn: 2, maxToolRounds: 3, maxTurnsPerDay: 1000 }, toolPolicy: { mode: 'open', allowTools: settings.allowTools ?? names } }),
      getExecutionConfig: () => ({ useTools: true }),
      ...(settings.allowsText ? { allowsText: settings.allowsText } : {}),
      async YTapi(request) {
        requests.push(structuredClone(request))
        return settings.script ? settings.script(round++, f, request) : round++ === 0 ? response(call('sendGiftTool', { targetQQ: '我', giftType: 'champagne' }), call('simSendMessage', { continuation: 'chat', messages: ['不许追加确认文字'] })) : finish()
      },
    })
  }
  const queues = ['group-log', 'group-text', 'simulation', 'private', 'privacy'].map(kind => redis.prefix + `agent:inbox:${kind}:${platformAccountKey(account)}`)
  f = { ...redis, account, target, user, adapter, qqConfig, requests, gifts, qzone, grabs, passwords, sends, reads, diagnosticsRows, revocations,
    get host() { return host }, get invalidations() { return invalidations }, binding,
    disable() { current = false },
    rebind() { directory = createAgentBindingDirectory({ ...config, bindings: [{ ...config.bindings[0], agentId: 'other' }] }, 'changed') },
    session: async () => JSON.parse(await redis.storage.get(sessionKey)),
    message(text = '请送给我一个香槟。', extra = {}) { return { version: 1, conversation: target, sender: user, senderName: '当前真人', messageId: 'human-source-' + ++sequence,
      occurredAt: Date.now() - 1000, text, parts: [{ kind: 'text', text }], mentions: [account], directedToAccount: true, ...extra } },
    async emit(message) { sources.set(sourceKey(message.conversation, message.messageId), structuredClone(message)); await accept({ kind: 'message', message: structuredClone(message) }) },
    async recall(message) { sources.delete(sourceKey(target, message.messageId)); await accept({ kind: 'recall', target, messageId: message.messageId }) },
    async drain() {
      await waitFor(async () => Number(await redis.reader.eval('local n=0; for _,k in ipairs(KEYS) do n=n+redis.call("LLEN",k) end; return n', { keys: queues, arguments: [] })) === 0,
        () => 'Core QQ inbox did not drain: ' + JSON.stringify(diagnosticsRows.slice(-4)))
      await host.runtime.drain()
      await waitFor(async () => !await redis.reader.exists(redis.prefix + simulationBusyKey(key)), () => 'Core QQ simulation remained busy')
    },
    async run(text, extra) { round = 0; const before = requests.length, message = f.message(text, extra); await f.emit(message)
      await waitFor(() => requests.length > before, () => 'Core QQ model request missing: ' + JSON.stringify(diagnosticsRows.slice(-5)))
      await f.drain(); return message },
    packet(extra = {}) {
      const id = 'wallet-source-' + ++sequence, at = Date.now() - 1000
      const packet = { version: 1, target, source: { messageId: id, author: user, at }, observedAt: Date.now(), packetRef: 'packet:ephemeral-' + sequence,
        packetIdentity: createHash('sha256').update(id).digest('hex'), kind: 'exclusive', title: '仅作临时展示的红包标题', exclusiveForBot: true, ...extra }
      packets.set(packet.source.messageId, structuredClone(packet)); packetEpochs.set(packet.packetRef, epoch)
      sources.set(sourceKey(target, packet.source.messageId), { version: 1, conversation: target, sender: packet.source.author, messageId: packet.source.messageId,
        occurredAt: packet.source.at, text: '', parts: [], mentions: [], directedToAccount: false })
      return packet
    },
    async automatic(packet, extra = {}) { await accept({ kind: 'red-packet', target, packet: structuredClone(packet), ...extra }) },
    async automaticDone(count) { await waitFor(() => diagnosticsRows.filter(row => row.operation === 'red_packet_automatic' && row.scope.kind === 'conversation' && row.stage === 'runtime' && row.outcome !== 'started').length >= count,
      () => 'Core automatic packet did not settle: ' + JSON.stringify(diagnosticsRows.slice(-8))) },
    async records(pattern) { const result = []; for (const redisKey of await redis.reader.keys(redis.prefix + pattern)) if (await redis.reader.type(redisKey) === 'string') result.push(JSON.parse(await redis.reader.get(redisKey))); return result },
    async restart({ clearIngress = false } = {}) {
      await host.stop()
      if (clearIngress) { const keys = await redis.reader.keys(redis.prefix + 'agent:inbox:*'); if (keys.length) await redis.reader.del(keys); await seedSession() }
      host = makeHost(); round = 0; await host.start()
    },
  }
  await seedSession(); host = makeHost(); await host.start()
  return f
}

async function assertNoChat(f, expectedBudget = 0) {
  assert.deepEqual(f.sends, [])
  const session = await f.session()
  assert.deepEqual(session.confirmedMessageIds ?? [], [])
  assert.equal(session.lastConfirmedChat, undefined)
  assert.equal(session.recent.some(row => row.userId === f.account.id), false)
  assert.equal(session.sendTimes.length, expectedBudget)
  assert.equal((await f.reader.keys(f.prefix + '*episode*')).length, 0)
}

for (const scenario of [
  { name: 'without configuration', omitConfig: true },
  { name: 'with switches disabled', config: { gift: { enabled: false }, qzone: { enabled: false }, redPackets: { enabled: false } } },
  { name: 'without adapter ports', giftPort: false, qzonePort: false, packetPort: false },
  { name: 'without explicit tool grants', allowTools: [] },
]) test(`Core hides QQ action tools ${scenario.name}`, redisTest, async t => {
  const f = await fixture(t, { ...scenario, script: () => finish() })
  await f.run('核对当前工具。')
  const exposed = f.requests[0].tools.map(row => row.function.name)
  for (const name of names) assert.equal(exposed.includes(name), false, name)
  assert.deepEqual(f.gifts, []); assert.deepEqual(f.qzone, []); assert.deepEqual(f.grabs, [])
  await assertNoChat(f)
})

test('Core simulation dispatches one scoped gift without text, follow-up model or invented chat confirmation', redisTest, async t => {
  const f = await fixture(t), message = await f.run()
  assert.equal(f.requests.length, 1); assert.equal(f.gifts.length, 1)
  assert.deepEqual(f.gifts[0], { version: 1, kind: 'qq.gift-display', binding: f.binding(), source: { messageId: message.messageId, author: f.user },
    plan: { version: 1, recipient: f.user, giftType: 'champagne' } })
  assert.deepEqual((await f.records('agent:gift-display:v1:*')).map(row => row.state), ['confirmed'])
  await assertNoChat(f, 1)
})

test('Core simulation publishes Qzone through the scoped provider and records its own stable post', redisTest, async t => {
  const f = await fixture(t, { script: () => response(call('qqZoneTool', { text: '今天想认真看看云。' }), call('simSendMessage', { continuation: 'chat', messages: ['不能追加确认'] })) })
  await f.run('请发表一条QQ空间说说。')
  assert.equal(f.requests.length, 1)
  assert.deepEqual(f.qzone, [{ version: 1, binding: f.binding(), operation: { kind: 'publish', text: '今天想认真看看云。' } }])
  const own = await f.records('agent:qzone:v1:own:*')
  assert.equal(own.length, 1); assert.equal(own[0].postId, 'own-post-1'); assert.equal(own[0].agentId, 'role')
  await assertNoChat(f, 1)
})

for (const kind of ['gift', 'qzone']) test(`Core ${kind} unknown remains fenced after a fresh chat session and runtime restart`, redisTest, async t => {
  const f = await fixture(t, { giftReceipt: { state: 'unknown' }, qzoneReceipt: { state: 'unknown' }, script: () => response(
    call(kind === 'gift' ? 'sendGiftTool' : 'qqZoneTool', kind === 'gift' ? { targetQQ: '我' } : { text: '未知结果不得重发。' }),
    call('simSendMessage', { continuation: 'chat', messages: ['未知后不得发送'] })) })
  const message = await f.run(kind === 'gift' ? undefined : '请发表一条QQ空间说说。')
  assert.equal(f.requests.length, 1); assert.equal(f[kind === 'gift' ? 'gifts' : 'qzone'].length, 1)
  const pattern = kind === 'gift' ? 'agent:gift-display:v1:*' : 'agent:qzone:v1:source:*'
  assert.deepEqual((await f.records(pattern)).map(row => row.state), ['unknown'])
  // Discard only chat/ingress state, retaining the durable effect ledger. A
  // replay must reach the model again to prove the effect fence owns deduping.
  await f.restart({ clearIngress: true }); const before = f.requests.length
  await f.emit(message); await waitFor(() => f.requests.length > before, () => 'replayed source did not reach the fresh chat session'); await f.drain()
  assert.equal(f.requests.length, 2); assert.equal(f[kind === 'gift' ? 'gifts' : 'qzone'].length, 1)
  assert.deepEqual((await f.records(pattern)).map(row => row.state), ['unknown'])
  await assertNoChat(f)
})

for (const fence of ['configuration', 'configuration snapshot', 'binding', 'recall']) test(`Core rechecks ${fence} before a gift native side effect`, redisTest, async t => {
  let applied = false
  const f = await fixture(t, { async beforeEffect(run) {
    if (applied) return; applied = true
    if (fence === 'configuration') run.disable()
    else if (fence === 'configuration snapshot') run.qqConfig.gift.enabled = false
    else if (fence === 'binding') run.rebind()
    else await run.recall({ messageId: run.giftsSource })
  } })
  const message = f.message(); f.giftsSource = message.messageId
  await f.emit(message); await waitFor(() => applied, () => 'gift provider guard was not reached'); await f.drain()
  assert.deepEqual(f.gifts, []); assert.deepEqual(f.sends, [])
  assert.deepEqual((await f.records('agent:gift-display:v1:*')).map(row => row.state), ['unknown'])
})

test('Core rejects Qzone text denied by the host before the provider or effect ledger', redisTest, async t => {
  const f = await fixture(t, { allowsText: (text, direction) => direction !== 'outgoing' || !text.includes('禁止的正文'),
    script: round => round === 0 ? response(call('qqZoneTool', { text: '禁止的正文' })) : finish() })
  await f.run('请发表一条QQ空间说说。')
  assert.deepEqual(f.qzone, []); assert.deepEqual(await f.records('agent:qzone:v1:source:*'), [])
  await assertNoChat(f)
})

for (const kind of ['exclusive', 'password']) test(`Core simulation explicitly claims a quoted ${kind} wallet through the real packet workflow`, redisTest, async t => {
  const config = defaultConfig(); config.redPackets.allowPasswordSend = true
  const f = await fixture(t, { config, script: () => response(call('grabRedBagTool'), call('simSendMessage', { continuation: 'chat', messages: ['领取后不得文字补发'] })) })
  const packet = f.packet({ kind, title: kind === 'password' ? '可信原生口令' : '定向红包' })
  await f.run('请领取这个红包。', { quote: { messageId: packet.source.messageId, author: f.user, parts: [] } })
  assert.equal(f.grabs.length, 1, JSON.stringify({ toolMessages: f.requests.at(-1)?.messages.filter(row => row.role === 'tool'), diagnostics: f.diagnosticsRows.slice(-12) }))
  assert.equal(f.requests.length, 1); assert.deepEqual(f.grabs[0], packet)
  assert.equal(f.passwords.length, kind === 'password' ? 1 : 0)
  const [record] = await f.records('agent:red-packet:v1:*')
  assert.equal(record.state, 'confirmed'); assert.equal(record.phase, 'finished'); assert.equal(record.grabbed, true)
  assert.equal(record.passwordConfirmed, kind === 'password')
  assert.doesNotMatch(JSON.stringify((await f.session()).agentHistory), new RegExp(packet.title + '|' + packet.packetRef, 'u'))
  await assertNoChat(f, 1)
})

test('Core explicit packet unknown stops later model and text actions and does not repeat after restart', redisTest, async t => {
  const f = await fixture(t, { packetReceipt: { state: 'unknown' }, script: () => response(call('grabRedBagTool'), call('simSendMessage', { continuation: 'chat', messages: ['未知后禁止发送'] })) })
  const packet = f.packet(), message = await f.run('请领取这个红包。', { quote: { messageId: packet.source.messageId, author: f.user, parts: [] } })
  assert.equal(f.grabs.length, 1); assert.equal(f.requests.length, 1)
  assert.deepEqual((await f.records('agent:red-packet:v1:*')).map(row => row.state), ['unknown'])
  await f.restart({ clearIngress: true }); const before = f.requests.length
  await f.emit(message); await waitFor(() => f.requests.length > before, () => 'unknown packet replay did not reach the new session'); await f.drain()
  assert.equal(f.grabs.length, 1); assert.equal(f.requests.length, 2)
  assert.deepEqual((await f.records('agent:red-packet:v1:*')).map(row => row.state), ['unknown'])
  await assertNoChat(f)
})

test('Core never lets an unrelated ephemeral tool result authorize a later packet claim', redisTest, async t => {
  const probe = { name: 'walletSourceProbe', description: '临时来源隔离验证', dataPolicy: 'ephemeral', parameters: { type: 'object', properties: {}, required: [] },
    async execute() { return { status: 'succeeded', content: '临时资料正文不可成为红包授权' } } }
  const f = await fixture(t, { tools: [probe], script: round => round === 0 ? response(call(probe.name)) : round === 1 ? response(call('grabRedBagTool')) : finish() })
  const packet = f.packet()
  await f.run('请领取这个红包。', { quote: { messageId: packet.source.messageId, author: f.user, parts: [] } })
  assert.equal(f.requests.length, 3); assert.deepEqual(f.grabs, []); assert.deepEqual(f.passwords, [])
  assert.deepEqual(await f.records('agent:red-packet:v1:*'), [])
  assert.doesNotMatch(JSON.stringify((await f.session()).agentHistory), /临时资料正文不可成为红包授权/u)
  await assertNoChat(f)
})

test('Core automatic wallets require their separate producer configuration and current tool authority', redisTest, async t => {
  for (const settings of [
    { config: { redPackets: { enabled: false, allowExplicit: true, automatic: { enabled: true, toolConfigured: true } } } },
    { config: { redPackets: { enabled: true, allowExplicit: true, automatic: { enabled: false, toolConfigured: true } } } },
    { config: { redPackets: { enabled: true, allowExplicit: true, automatic: { enabled: true, toolConfigured: false } } } },
    { allowTools: [] }, { packetPort: false },
  ]) {
    const f = await fixture(t, settings)
    await f.automatic(f.packet())
    if (settings.packetPort !== false && settings.config?.redPackets?.automatic?.enabled !== false) await f.automaticDone(1)
    else assert.equal(f.diagnosticsRows.some(row => row.operation === 'red_packet_automatic'), false)
    await f.host.stop()
    assert.deepEqual(f.grabs, []); assert.deepEqual(f.passwords, []); assert.deepEqual(f.requests, [])
    assert.deepEqual(await f.records('agent:red-packet:v1:*'), [])
    await assertNoChat(f)
  }
})

test('Core automatic trusted wallets work with explicit grabbing and group logging disabled, without durable raw ingress', redisTest, async t => {
  const f = await fixture(t, { config: { redPackets: { enabled: true, allowExplicit: false, automatic: { enabled: true, toolConfigured: true } } } })
  const packet = f.packet(), marker = 'native-wallet-credential-must-stay-ephemeral'
  await f.automatic(packet, { nativeWallet: { credential: marker } }); await f.automaticDone(1)
  assert.equal(f.grabs.length, 1); assert.deepEqual(f.grabs[0], packet); assert.deepEqual(f.passwords, []); assert.deepEqual(f.requests, [])
  assert.ok(f.reads.some(row => row.id === packet.source.messageId), 'a genuine wallet source may have empty ordinary message text')
  assert.deepEqual((await f.records('agent:red-packet:v1:*')).map(row => row.state), ['confirmed'])
  for (const redisKey of await f.reader.keys(f.prefix + '*')) {
    const type = await f.reader.type(redisKey)
    const stored = type === 'string' ? await f.reader.get(redisKey) : type === 'list' ? JSON.stringify(await f.reader.lRange(redisKey, 0, -1)) : ''
    assert.doesNotMatch(stored, new RegExp(marker + '|' + packet.title + '|' + packet.packetRef, 'u'))
    if (redisKey.includes('agent:inbox:')) assert.equal(stored.includes(packet.source.messageId), false)
  }
  await assertNoChat(f)
})

test('Core serializes automatic wallet events in one conversation and freezes duplicate unknown grabs across restart', redisTest, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), trace = []
  let first
  const f = await fixture(t, { packetReceipt: { state: 'unknown' }, release: () => release.resolve(), async beforeGrab(_run, packet) {
    trace.push(packet.source.messageId)
    if (packet.source.messageId === first.source.messageId) { entered.resolve(); await release.promise }
  } })
  first = f.packet(); const second = f.packet()
  await f.automatic(first); await entered.promise; await f.automatic(second); await delay(50)
  assert.deepEqual(trace, [first.source.messageId]); assert.deepEqual(f.grabs, [])
  release.resolve(); await f.automaticDone(2)
  assert.deepEqual(trace, [first.source.messageId, second.source.messageId]); assert.equal(f.grabs.length, 2)
  await f.restart(); await f.automatic(first); await f.automaticDone(3)
  assert.equal(f.grabs.length, 2); assert.deepEqual(f.passwords, []); assert.deepEqual(f.requests, [])
  await assertNoChat(f)
})

for (const fence of ['recall', 'configuration', 'binding', 'privacy']) test(`Core cancels a queued automatic wallet at the ${fence} fence`, redisTest, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  let blocked
  const f = await fixture(t, { release: () => release.resolve(), async beforeGrab(_run, packet) {
    if (packet.source.messageId === blocked.source.messageId) { entered.resolve(); await release.promise }
  } })
  blocked = f.packet(); const queued = f.packet()
  await f.automatic(blocked); await entered.promise; await f.automatic(queued)
  if (fence === 'recall') { await f.recall({ messageId: blocked.source.messageId }); await f.recall({ messageId: queued.source.messageId }) }
  else if (fence === 'configuration') f.disable()
  else if (fence === 'binding') f.rebind()
  else {
    const command = f.message(personMemoryCommandText.forget, { mentions: [], directedToAccount: false })
    await f.emit(command)
    assert.ok(f.invalidations > 0, 'privacy admission must invalidate adapter wallet handles immediately')
    const guard = { signal: new AbortController().signal, isCurrent: () => true, async ensureCurrent() {} }
    assert.equal(await f.adapter.redPackets.revalidate(queued, guard), false)
    assert.deepEqual(await f.adapter.redPackets.sendPassword(queued, guard), { state: 'failed' })
    assert.deepEqual(await f.adapter.redPackets.grab(queued, guard), { state: 'failed' })
  }
  release.resolve(); await f.automaticDone(2); await f.drain()
  assert.deepEqual(f.grabs, []); assert.deepEqual(f.passwords, []); assert.deepEqual(f.requests, [])
  if (fence === 'recall') assert.deepEqual(f.revocations.map(row => row.id), [blocked.source.messageId, queued.source.messageId])
  if (fence === 'privacy') {
    await delay(2)
    const next = f.packet({ source: { messageId: 'fresh-wallet-source', author: { ...f.user, id: '170002' }, at: Date.now() } })
    await f.automatic(next); await f.automaticDone(3)
    assert.equal(f.grabs.length, 1); assert.equal(f.grabs[0].source.messageId, next.source.messageId)
  }
})
