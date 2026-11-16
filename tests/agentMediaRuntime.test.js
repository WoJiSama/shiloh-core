import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentBindingDirectory, createAgentRuntime } from '../dist/backend/core/index.js'
import { createDefaultSimSession } from '../dist/backend/modules/simulation/domain/simConfig.js'
import { simulationAddressKey } from '../dist/backend/modules/simulation/infrastructure/simulationAddress.js'
import { simulationBusyKey, simulationSessionKey } from '../dist/backend/modules/simulation/infrastructure/simSessionStore.js'
import { agentBindingToken, agentPersonaScopeId, platformAccountKey } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const redisTest = { skip: !redisAvailable, timeout: 20_000 }
const producerName = 'generatedMediaFixtureTool', readerName = 'temporaryMediaFixtureTool', externalName = 'mediaExternalFixtureTool'
const parameters = { type: 'object', properties: {}, required: [], additionalProperties: false }
const spokenText = '本次生成的短语音。', temporary = '本轮临时资料不得生成音视频'
const historySource = '仅在媒体权限验收中读取的历史正文。'
function audioBytes(sample = 1000) {
  const bytes = Buffer.alloc(48)
  bytes.write('RIFF', 0); bytes.writeUInt32LE(40, 4); bytes.write('WAVE', 8)
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(4, 40); bytes.writeInt16LE(sample, 44); bytes.writeInt16LE(-sample, 46)
  return bytes.toString('base64')
}
const audio = { mime: 'audio/wav', base64: audioBytes(), spokenText }
const anotherAudio = { ...audio, base64: audioBytes(500), spokenText: '另一句不同的语音。' }
// This fixture proves validated MP4 transport, not decoder or playback acceptance.
const mp4 = Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex')
const video = { mime: 'video/mp4', base64: mp4.toString('base64') }
const call = (name, input = {}) => ({ choices: [{ message: { content: '', tool_calls: [{ id: `${name}-call`, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } }] })
const finish = () => call('simFinishTurn', { choice: 'silent', reason: '本轮媒体验证已完成' })
let fixtureId = 0

async function waitFor(check, message, timeout = 7000) {
  const end = performance.now() + timeout
  while (performance.now() < end) { if (await check()) return; await delay(15) }
  assert.fail(typeof message === 'function' ? message() : message)
}

async function attempt(operation) {
  try { return { status: 'fulfilled', value: await operation() } }
  catch (error) { return { status: 'rejected', reason: String(error) } }
}

async function fixture(t, options = {}) {
  const redis = await createAgentRedisFixture(t, 'media-runtime'), { storage, reader, prefix } = redis
  const account = { platform: 'fixture', namespace: `media-${++fixtureId}`, id: 'robot' }
  const target = { account, kind: 'group', id: 'room' }, sender = { ...account, id: 'human' }
  const now = Date.now()
  const config = { version: 1, agents: [{ id: 'role', personaId: 'default' }, { id: 'replacement', personaId: 'default' }],
    connections: [{ id: 'connection', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: [{ connectionId: 'connection', kind: 'group', conversationId: target.id, agentId: 'role' }] }
  let directory = createAgentBindingDirectory(config, 'media-initial'), accept, terminal = false
  const binding = directory.resolve(target), key = simulationAddressKey(target)
  const initial = createDefaultSimSession(now)
  initial.bootstrapSent = true; initial.botId = account.id; initial.personaId = agentPersonaScopeId(binding.agentId); initial.bindingToken = agentBindingToken(binding)
  initial.nextProactiveCheckAt = now + 86_400_000
  initial.wakeConfig.triggers = { ...initial.wakeConfig.triggers, probability: 0, question: false, nameMention: false, anyMessage: false }
  await storage.set(simulationSessionKey(key), JSON.stringify(initial))
  const requests = [], contexts = [], mediaAttempts = [], media = [], messages = [], observed = [], diagnostics = [], outputs = []
  let producerCalls = 0, externalCalls = 0, reads = 0
  const original = { version: 1, conversation: target, sender, messageId: 'media-trigger', occurredAt: now,
    text: options.temporary ? '请只在本轮查看当前附件。' : '请完成本轮生成媒体并发送给我。',
    parts: options.temporary ? [{ kind: 'file', name: 'source.txt', resource: { kind: 'url', value: 'https://provider.example/private-media-source' } }] : [],
    mentions: [account], directedToAccount: true }
  let f
  const producer = { name: producerName, description: 'Generate owned media in the current conversation', parameters,
    async execute(input, context) {
      producerCalls++; contexts.push(context)
      return options.execute ? options.execute(input, context, f) : { status: 'succeeded', content: '媒体生成器已执行' }
    } }
  const ephemeral = { name: readerName, description: 'Read temporary source evidence only', dataPolicy: 'ephemeral', parameters,
    async execute(_input, context) {
      contexts.push(context)
      outputs.push({ absentBeforeRead: !Object.hasOwn(context, 'sendAudio') && !Object.hasOwn(context, 'sendVideo') && context.sendAudio === undefined && context.sendVideo === undefined })
      const result = await context.readFile({})
      outputs.push({ result, absentAfterRead: !Object.hasOwn(context, 'sendAudio') && !Object.hasOwn(context, 'sendVideo') && context.sendAudio === undefined && context.sendVideo === undefined })
      return { status: 'succeeded', content: temporary }
    } }
  const external = { name: externalName, description: 'External side effect fixture', parameters,
    async execute() { externalCalls++; return { status: 'succeeded', content: '外部动作已发生' } } }
  const section = { enabled: true, reflection: { enabled: false }, rhythm: { enabled: false }, mood: { enabled: false },
    personProfile: { enabled: false }, meme: { enabled: false }, userStyle: { enabled: false }, lifeThreads: { enabled: false },
    wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000 },
    turn: { maxToolRounds: 12, maxSendsPerTurn: options.maxSends ?? 1, minSendGapMs: 0 }, toolPolicy: { mode: 'open' } }
  const host = createAgentRuntime({ storage, isExecutionCurrent: redis.isCurrent, now: () => now,
    ...(options.history ? { history: { enabled: true, retentionDays: 30, maxMessagesPerConversation: 1000 } } : {}),
    adapters: [{ id: 'connection', account, botUserId: account.id, botName: 'fixture', isReady: () => Boolean(accept),
      async start(consume) { accept = consume }, stop() {},
      async readMessage(_target, messageId, guard) { return messageId === original.messageId && guard?.isCurrent?.() !== false ? structuredClone(original) : undefined },
      async readMessageFile(selected, messageId, index, guard) {
        await guard.ensureCurrent?.()
        if (messageId !== original.messageId || index !== 1 || !await guard.allowsSource(structuredClone(original))) return undefined
        assert.deepEqual(selected, target); reads++
        return { name: 'source.txt', mime: 'text/plain', base64: Buffer.from(temporary).toString('base64') }
      },
      async listConversationFiles() { return { target, observedAt: now, files: [], truncated: false } },
      actions: {
        async send(action, guard) {
          if (!guard.isCurrent()) return { state: 'failed', code: 'stale_fixture_send' }
          messages.push(structuredClone(action)); return { state: 'sent', messageId: `text-${messages.length}` }
        },
        async sendMedia(action, guard) {
          mediaAttempts.push({ action: structuredClone(action), guard })
          if (options.deliver) return options.deliver(action, guard, f)
          if (!guard.isCurrent() || guard.signal?.aborted) return { state: 'failed', code: 'stale_fixture_media' }
          media.push(structuredClone(action)); return { state: 'sent', messageId: `media-${media.length}` }
        },
      },
    }],
    logger: { info() {}, warn(...args) { diagnostics.push(args.map(String).join(' ')) }, error(...args) { diagnostics.push(args.map(String).join(' ')) } },
    getSection: () => section, getExecutionConfig: () => ({ providers: 'openai', useTools: true }),
    resolvePersona(selected) { const selectedBinding = directory.resolve(selected); return selectedBinding && { binding: selectedBinding, persona: { name: '媒体角色' }, systemContent: '' } },
    toolRegistry: { builtIn: [producer, ephemeral, external] }, recordToolResult: result => observed.push(result),
    ...(options.allowsText ? { allowsText: options.allowsText } : {}),
    async YTapi(request, _config, _signal, _current, ensureCurrent) {
      await ensureCurrent?.(); requests.push(structuredClone(request))
      if (options.model) {
        const next = await options.model(requests.length, request, f)
        if (next) return next
      } else if (requests.length === 1) return call(producerName)
      terminal = true
      return finish()
    },
  })
  t.after(async () => { options.release?.(); await host.stop() })
  const session = async () => JSON.parse(await storage.get(simulationSessionKey(key)) || 'null')
  const settled = async () => {
    const state = await session()
    return state && !state.queuedIngressWake && !await reader.exists(prefix + simulationBusyKey(key)) &&
      !await reader.lLen(prefix + `agent:inbox:simulation:${platformAccountKey(account)}`)
  }
  f = { ...redis, host, target, sender, account, binding, key, now, original, requests, contexts, mediaAttempts, media, messages, observed, diagnostics, outputs, session, settled,
    get producerCalls() { return producerCalls }, get externalCalls() { return externalCalls }, get reads() { return reads },
    rebind() { directory = createAgentBindingDirectory({ ...config, bindings: [{ ...config.bindings[0], agentId: 'replacement' }] }, 'media-rebound') },
    async recall() { await accept({ kind: 'recall', target, messageId: original.messageId }) },
    async emit() { await accept({ kind: 'message', message: structuredClone(original) }) },
    async run() {
      await f.emit()
      await waitFor(async () => terminal && await settled(), () => `media turn did not drain: ${JSON.stringify({ diagnostics, requests: requests.map(row => row.messages.filter(message => message.role === 'tool')) })}`)
      await host.runtime.drain()
    },
    async receipts() {
      const receipts = []
      for (const redisKey of await reader.keys(prefix + 'shiloh:character:v1:*')) if (await reader.type(redisKey) === 'string') {
        receipts.push(...(JSON.parse(await reader.get(redisKey)).receipts ?? []))
      }
      return receipts
    },
  }
  await host.start()
  if (options.history) {
    await accept({ kind: 'message', message: { ...structuredClone(original), messageId: 'media-history-source', occurredAt: now - 60_000,
      text: historySource, parts: [{ kind: 'text', text: historySource }], mentions: [], directedToAccount: false } })
    await waitFor(async () => (await session())?.recent?.some(row => row.messageId === 'media-history-source') && await settled(), 'historical human source captured without a model wake')
    assert.equal(requests.length, 0)
  }
  return f
}

test('public audio fixes target/binding/owned bytes, confirms its real message id, deduplicates audio/text and revokes the completed port', redisTest, async t => {
  let context, first, duplicate, textDuplicate, otherMedia, forgedTarget
  const f = await fixture(t, { async execute(_input, selected) {
    context = selected
    const mutable = { ...audio }, pending = selected.sendAudio(mutable)
    mutable.base64 = anotherAudio.base64; mutable.spokenText = '调用后篡改的正文'
    first = await pending
    duplicate = await selected.sendAudio({ ...audio })
    textDuplicate = await selected.sendMessage({ text: spokenText })
    otherMedia = await attempt(() => selected.sendVideo(video))
    forgedTarget = await attempt(() => selected.sendAudio({ ...audio, target: { kind: 'private', id: 'somebody-else' } }))
    return { status: 'succeeded', content: `音频发送回执：${first.messageId}` }
  } })
  await f.run()
  assert.deepEqual(first, { state: 'sent', messageId: 'media-1' })
  assert.deepEqual(duplicate, { state: 'failed', code: 'duplicate_media' })
  assert.deepEqual(textDuplicate, { state: 'failed', code: 'duplicate_message' })
  assert.equal(otherMedia.status, 'rejected'); assert.match(otherMedia.reason, /上限/u)
  assert.equal(forgedTarget.status, 'rejected'); assert.match(forgedTarget.reason, /闭合|参数/u)
  assert.equal(f.mediaAttempts.length, 1); assert.equal(f.media.length, 1); assert.equal(f.messages.length, 0)
  assert.deepEqual(f.media[0], { version: 1, kind: 'media.send', target: f.target, media: { kind: 'audio', ...audio }, binding: f.binding })
  assert.ok(f.mediaAttempts[0].guard.signal instanceof AbortSignal)
  const state = await f.session()
  assert.deepEqual(state.sendTimes, [f.now]); assert.equal(state.lastAiSendAt, f.now)
  assert.deepEqual(state.confirmedMessageIds, ['media-1'])
  assert.equal(context.persona.name, '媒体角色')
  assert.equal(context.signal.aborted, true); assert.equal(context.isCurrent(), false)
  await assert.rejects(context.sendAudio(anotherAudio), /失效/u)
  assert.equal(f.mediaAttempts.length, 1)
})

test('ordinary text sent before audio consumes the same allowance, and identical spoken text is suppressed in both directions', redisTest, async t => {
  await t.test('text then a different utterance shares its cap', async t => {
    let sent, blocked
    const f = await fixture(t, { async execute(_input, context) {
      sent = await context.sendMessage({ text: '普通文字占用发送配额。' })
      blocked = await attempt(() => context.sendAudio(audio))
      return { status: 'succeeded', content: '文字已经确认，不额外发送音频' }
    } })
    await f.run()
    assert.deepEqual(sent, { state: 'sent', messageId: 'text-1' })
    assert.equal(blocked.status, 'rejected'); assert.match(blocked.reason, /上限/u)
    assert.equal(f.messages.length, 1); assert.equal(f.mediaAttempts.length, 0)
    assert.deepEqual((await f.session()).sendTimes, [f.now])
  })
  await t.test('text then identical audio remains a duplicate with spare budget', async t => {
    let duplicate
    const f = await fixture(t, { maxSends: 3, async execute(_input, context) {
      await context.sendMessage({ text: spokenText })
      duplicate = await context.sendAudio(audio)
      return { status: 'succeeded', content: '相同正文不再语音复读' }
    } })
    await f.run()
    assert.deepEqual(duplicate, { state: 'failed', code: 'duplicate_media' })
    assert.equal(f.messages.length, 1); assert.equal(f.mediaAttempts.length, 0)
  })
  await t.test('different audio bytes with identical spoken text remain duplicate', async t => {
    let duplicate
    const f = await fixture(t, { maxSends: 3, async execute(_input, context) {
      await context.sendAudio(audio)
      duplicate = await context.sendAudio({ ...anotherAudio, spokenText })
      return { status: 'succeeded', content: '重新合成同一句也不再投递' }
    } })
    await f.run()
    assert.deepEqual(duplicate, { state: 'failed', code: 'duplicate_media' })
    assert.equal(f.mediaAttempts.length, 1)
  })
})

test('public video transports controlled bytes to the same fixed conversation and shares the media send allowance', redisTest, async t => {
  let receipt, audioAfter
  const f = await fixture(t, { async execute(_input, context) {
    receipt = await context.sendVideo(video)
    audioAfter = await attempt(() => context.sendAudio(audio))
    return { status: 'succeeded', content: '视频回执已确认' }
  } })
  await f.run()
  assert.deepEqual(receipt, { state: 'sent', messageId: 'media-1' })
  assert.deepEqual(f.media[0], { version: 1, kind: 'media.send', target: f.target, media: { kind: 'video', ...video }, binding: f.binding })
  assert.equal(audioAfter.status, 'rejected'); assert.match(audioAfter.reason, /上限/u)
  assert.equal(f.mediaAttempts.length, 1); assert.equal(f.messages.length, 0)
  assert.deepEqual((await f.session()).confirmedMessageIds, ['media-1'])
})

test('unknown audio and malformed video success cannot be relabeled successful or followed by media, text or external actions', redisTest, async t => {
  for (const mode of ['audio-unknown', 'video-no-message-id']) await t.test(mode, async t => {
    let first, mediaAfter, textAfter
    const f = await fixture(t, {
      maxSends: 4,
      async deliver(action, guard, selected) {
        assert.equal(guard.isCurrent(), true); selected.media.push(structuredClone(action))
        return mode === 'audio-unknown' ? { state: 'unknown' } : { state: 'sent' }
      },
      async execute(_input, context) {
        first = mode === 'audio-unknown' ? await context.sendAudio(audio) : await context.sendVideo(video)
        mediaAfter = await attempt(() => context.sendAudio(anotherAudio))
        textAfter = await attempt(() => context.sendMessage({ text: '未知媒体之后的额外文字' }))
        return { status: 'succeeded', content: '生成器错误声称媒体已发送成功' }
      },
      model(round) {
        if (round === 1 || round === 3) return call(producerName)
        if (round === 2) return call(externalName)
        if (round === 4) return call('simSendMessage', { continuation: 'chat', messages: ['未知媒体后的额外普通发送'] })
      },
    })
    await f.run()
    assert.deepEqual(first, { state: 'unknown' })
    for (const result of [mediaAfter, textAfter]) { assert.equal(result.status, 'rejected'); assert.match(result.reason, /未知/u) }
    assert.equal(f.producerCalls, 1); assert.equal(f.externalCalls, 0)
    assert.equal(f.mediaAttempts.length, 1); assert.equal(f.media.length, 1); assert.equal(f.messages.length, 0)
    assert.deepEqual((await f.session()).sendTimes, [])
    assert.deepEqual((await f.session()).confirmedMessageIds ?? [], [])
    const receipts = await f.receipts()
    assert.ok(receipts.some(receipt => receipt.toolName === producerName && receipt.status === 'unknown'))
    assert.equal(receipts.some(receipt => receipt.toolName === producerName && receipt.status === 'succeeded'), false)
    assert.match(f.observed.find(row => row.name === producerName).content, /未知/u)
  })
})

test('a confirmed media send whose accounting save fails becomes unknown even when the producer catches errors and reports success', redisTest, async t => {
  let first, second, injected = false, failedSaves = 0, restoreStorage
  const f = await fixture(t, {
    maxSends: 4,
    async deliver(action, guard, selected) {
      assert.equal(guard.isCurrent(), true); selected.media.push(structuredClone(action))
      if (!injected) {
        injected = true
        const save = selected.storage.set
        restoreStorage = () => { selected.storage.set = save }
        selected.storage.set = (name, value, ...args) => {
          if (name === simulationSessionKey(selected.key) && failedSaves === 0) { failedSaves++; throw new Error('fixture post-media accounting write failed') }
          return save(name, value, ...args)
        }
      }
      return { state: 'sent', messageId: 'confirmed-before-save' }
    },
    async execute(_input, context) {
      first = await attempt(() => context.sendAudio(audio))
      second = await attempt(() => context.sendVideo(video))
      return { status: 'succeeded', content: '生成器捕获异常并错误声称本轮媒体发送成功' }
    },
    model(round) {
      if (round === 1) return call(producerName)
      if (round === 2) return call(externalName)
      if (round === 3) return call('simSendMessage', { continuation: 'chat', messages: ['本地记账失败后的额外消息'] })
    },
  })
  t.after(() => restoreStorage?.())
  await f.run()
  assert.equal(failedSaves, 1, 'the failure occurs after confirmed native delivery')
  assert.deepEqual(first, { status: 'fulfilled', value: { state: 'unknown' } })
  assert.equal(second.status, 'rejected'); assert.match(second.reason, /未知/u)
  assert.equal(f.mediaAttempts.length, 1); assert.equal(f.media.length, 1)
  assert.equal(f.messages.length, 0); assert.equal(f.externalCalls, 0)
  const receipts = await f.receipts()
  assert.ok(receipts.some(receipt => receipt.toolName === producerName && receipt.status === 'unknown'))
  assert.equal(receipts.some(receipt => receipt.toolName === producerName && receipt.status === 'succeeded'), false)
})

test('binding replacement and source recall cancel queued audio/video before adapter dispatch', redisTest, async t => {
  for (const mode of ['binding', 'recall']) await t.test(mode, async t => {
    let release, context, adapterWaiting = false, outcomes
    const gate = new Promise(resolve => { release = resolve })
    const f = await fixture(t, {
      maxSends: 3, release: () => release(),
      async deliver(action, guard, selected) {
        adapterWaiting = true; await gate
        if (!guard.isCurrent() || guard.signal?.aborted) return { state: 'failed', code: 'cancelled_before_dispatch' }
        selected.media.push(structuredClone(action)); return { state: 'sent', messageId: 'late-media-must-not-dispatch' }
      },
      async execute(_input, selected) {
        context = selected
        outcomes = await Promise.allSettled([selected.sendAudio(audio), selected.sendVideo(video)])
        return { status: 'succeeded', content: '排队媒体发送已结束' }
      },
    })
    await f.emit()
    await waitFor(() => adapterWaiting, () => `media did not reach the adapter queue: ${f.diagnostics.join('|')}`)
    assert.equal(f.mediaAttempts.length, 1); assert.equal(f.media.length, 0)
    if (mode === 'binding') f.rebind()
    else await f.recall()
    await waitFor(() => context.signal.aborted, 'queued media tool cancellation')
    assert.equal(context.isCurrent(), false)
    assert.equal(f.mediaAttempts[0].guard.isCurrent(), false)
    assert.equal(f.mediaAttempts[0].guard.signal.aborted, true)
    release()
    await waitFor(async () => outcomes && await f.settled(), () => `cancelled media queue did not drain: ${f.diagnostics.join('|')}`)
    await f.host.runtime.drain()
    assert.equal(f.mediaAttempts.length, 1, 'the second queued media never reaches the adapter')
    assert.equal(f.media.length, 0); assert.equal(f.messages.length, 0)
    assert.ok(outcomes.every(result => result.status === 'rejected'))
  })
})

test('temporary file tools receive no media ports and subsequent producers cannot send derived audio/video', redisTest, async t => {
  const f = await fixture(t, {
    temporary: true,
    async execute(_input, context) { await context.sendAudio(audio); return { status: 'succeeded', content: '不应执行的临时资料口播' } },
    model(round) { if (round === 1) return call(readerName); if (round === 2) return call(producerName) },
  })
  await f.run()
  assert.equal(f.reads, 1); assert.equal(f.producerCalls, 0)
  assert.equal(f.outputs[0].absentBeforeRead, true); assert.equal(f.outputs[1].absentAfterRead, true)
  assert.equal(Buffer.from(f.outputs[1].result.base64, 'base64').toString(), temporary)
  assert.equal(f.mediaAttempts.length, 0); assert.equal(f.messages.length, 0)
  assert.equal((await f.receipts()).some(receipt => [readerName, producerName].includes(receipt.toolName)), false)
  assert.deepEqual(f.observed, [])
})

test('a tool that reads explicit history cannot use its previously obtained audio/video ports afterward', redisTest, async t => {
  let history, deniedAudio, deniedVideo, hadPorts
  const f = await fixture(t, { history: true, async execute(_input, context) {
    hadPorts = typeof context.sendAudio === 'function' && typeof context.sendVideo === 'function'
    history = await context.readHistory({ question: '查看本轮请求', source: 'recent', keywords: [], user_id: 'human', limit: 1 })
    deniedAudio = await attempt(() => context.sendAudio(audio))
    deniedVideo = await attempt(() => context.sendVideo(video))
    return { status: 'succeeded', content: '历史资料只在本轮使用' }
  } })
  await f.run()
  assert.equal(hadPorts, true)
  assert.equal(typeof history, 'string')
  assert.ok(history.includes(historySource), 'real Core history port supplies the captured earlier human source')
  for (const result of [deniedAudio, deniedVideo]) { assert.equal(result.status, 'rejected'); assert.match(result.reason, /临时资料/u) }
  assert.equal(f.mediaAttempts.length, 0); assert.equal(f.messages.length, 0)
  assert.deepEqual(f.observed, [])
})

test('Core inspects spoken text for output and credential policy before native media transport', redisTest, async t => {
  const forbidden = '不允许口播的正文', credential = 'MEDIA_HOST_CREDENTIAL_982363'
  const inspected = [], receipts = []
  const f = await fixture(t, {
    allowsText(text, direction) { inspected.push({ text, direction }); return ![forbidden, credential].some(value => text.includes(value)) },
    async execute(_input, context) {
      for (const value of [forbidden, credential]) receipts.push(await context.sendAudio({ ...audio, spokenText: value }))
      return { status: 'succeeded', content: '口播输出策略已执行' }
    },
  })
  await f.run()
  assert.deepEqual(receipts, [{ state: 'failed', code: 'forbidden_text' }, { state: 'failed', code: 'forbidden_text' }])
  for (const value of [forbidden, credential]) assert.ok(inspected.some(row => row.direction === 'outgoing' && row.text.includes(value)))
  assert.equal(f.mediaAttempts.length, 0); assert.equal(f.messages.length, 0)
  assert.deepEqual((await f.session()).sendTimes, [])
})
