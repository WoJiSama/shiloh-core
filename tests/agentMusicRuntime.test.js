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
const producerName = 'generatedMusicFixtureTool', readerName = 'temporaryMusicFixtureTool', externalName = 'musicExternalFixtureTool'
const parameters = { type: 'object', properties: {}, required: [], additionalProperties: false }
const temporary = '本轮临时资料不得生成音乐卡片'
const historySource = '仅在音乐权限验收中读取的历史正文。'
const musicCard = { title: '合成音乐', artist: '合成歌手', pageUrl: 'https://y.qq.com/n/yqq/song/SongMid1.html',
  audioUrl: 'http://ws.stream.qqmusic.qq.com/SongMid1.mp3?vkey=FIXTUREVKEY',
  coverUrl: 'http://y.gtimg.cn/music/photo_new/T002R150x150M000AlbumMid1.jpg' }
const anotherCard = { ...musicCard, title: '另一首合成音乐', pageUrl: 'https://y.qq.com/n/yqq/song/SongMid2.html',
  audioUrl: 'http://ws.stream.qqmusic.qq.com/SongMid2.mp3?vkey=ANOTHERFIXTUREVKEY' }
const call = (name, input = {}) => ({ choices: [{ message: { content: '', tool_calls: [{ id: `${name}-call`, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } }] })
const finish = () => call('simFinishTurn', { choice: 'silent', reason: '本轮音乐验证已完成' })
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
  const redis = await createAgentRedisFixture(t, 'music-runtime'), { storage, reader, prefix } = redis
  const account = { platform: 'fixture', namespace: `music-${++fixtureId}`, id: 'robot' }
  const target = { account, kind: 'group', id: 'room' }, sender = { ...account, id: 'human' }
  const now = Date.now()
  const config = { version: 1, agents: [{ id: 'role', personaId: 'default' }, { id: 'replacement', personaId: 'default' }],
    connections: [{ id: 'connection', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: [{ connectionId: 'connection', kind: 'group', conversationId: target.id, agentId: 'role' }] }
  let directory = createAgentBindingDirectory(config, 'music-initial'), accept, terminal = false
  const binding = directory.resolve(target), key = simulationAddressKey(target)
  const initial = createDefaultSimSession(now)
  initial.bootstrapSent = true; initial.botId = account.id; initial.personaId = agentPersonaScopeId(binding.agentId); initial.bindingToken = agentBindingToken(binding)
  initial.nextProactiveCheckAt = now + 86_400_000
  initial.wakeConfig.triggers = { ...initial.wakeConfig.triggers, probability: 0, question: false, nameMention: false, anyMessage: false }
  await storage.set(simulationSessionKey(key), JSON.stringify(initial))
  const requests = [], contexts = [], musicAttempts = [], music = [], messages = [], observed = [], diagnostics = [], outputs = []
  let producerCalls = 0, externalCalls = 0, reads = 0
  const original = { version: 1, conversation: target, sender, messageId: 'music-trigger', occurredAt: now,
    text: options.temporary ? '请只在本轮查看当前附件。' : '请完成本轮点歌并发送音乐卡片。',
    parts: options.temporary ? [{ kind: 'file', name: 'source.txt', resource: { kind: 'url', value: 'https://provider.example/private-music-source' } }] : [],
    mentions: [account], directedToAccount: true }
  let f
  const producer = { name: producerName, description: 'Generate owned music in the current conversation', parameters,
    async execute(input, context) {
      producerCalls++; contexts.push(context)
      return options.execute ? options.execute(input, context, f) : { status: 'succeeded', content: '音乐生成器已执行' }
    } }
  const ephemeral = { name: readerName, description: 'Read temporary source evidence only', dataPolicy: 'ephemeral', parameters,
    async execute(_input, context) {
      contexts.push(context)
      outputs.push({ absentBeforeRead: !Object.hasOwn(context, 'sendMusic') && context.sendMusic === undefined })
      const result = await context.readFile({})
      outputs.push({ result, absentAfterRead: !Object.hasOwn(context, 'sendMusic') && context.sendMusic === undefined })
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
        async sendMusic(action, guard) {
          musicAttempts.push({ action: structuredClone(action), guard })
          if (options.deliver) return options.deliver(action, guard, f)
          if (!guard.isCurrent() || guard.signal?.aborted) return { state: 'failed', code: 'stale_fixture_music' }
          music.push(structuredClone(action)); return { state: 'sent', messageId: `music-${music.length}` }
        },
      },
    }],
    logger: { info() {}, warn(...args) { diagnostics.push(args.map(String).join(' ')) }, error(...args) { diagnostics.push(args.map(String).join(' ')) } },
    getSection: () => section, getExecutionConfig: () => ({ providers: 'openai', useTools: true }),
    resolvePersona(selected) { const selectedBinding = directory.resolve(selected); return selectedBinding && { binding: selectedBinding, persona: { name: '音乐角色' }, systemContent: '' } },
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
  f = { ...redis, host, target, sender, account, binding, key, now, original, requests, contexts, musicAttempts, music, messages, observed, diagnostics, outputs, session, settled,
    get producerCalls() { return producerCalls }, get externalCalls() { return externalCalls }, get reads() { return reads },
    rebind() { directory = createAgentBindingDirectory({ ...config, bindings: [{ ...config.bindings[0], agentId: 'replacement' }] }, 'music-rebound') },
    async recall() { await accept({ kind: 'recall', target, messageId: original.messageId }) },
    async emit() { await accept({ kind: 'message', message: structuredClone(original) }) },
    async run() {
      await f.emit()
      await waitFor(async () => terminal && await settled(), () => `music turn did not drain: ${JSON.stringify({ diagnostics, requests: requests.map(row => row.messages.filter(message => message.role === 'tool')) })}`)
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
    await accept({ kind: 'message', message: { ...structuredClone(original), messageId: 'music-history-source', occurredAt: now - 60_000,
      text: historySource, parts: [{ kind: 'text', text: historySource }], mentions: [], directedToAccount: false } })
    await waitFor(async () => (await session())?.recent?.some(row => row.messageId === 'music-history-source') && await settled(), 'historical human source captured without a model wake')
    assert.equal(requests.length, 0)
  }
  return f
}

test('public music owns its card snapshot, fixes target and binding, deduplicates, charges the shared budget and revokes its completed port', redisTest, async t => {
  let context, first, duplicate, renewedVkey, extraText, anotherMusic, forgedTarget
  const f = await fixture(t, { async execute(_input, selected) {
    context = selected
    const mutable = { ...musicCard }, pending = selected.sendMusic(mutable)
    mutable.title = '调用后篡改的标题'; mutable.audioUrl = anotherCard.audioUrl
    first = await pending
    duplicate = await selected.sendMusic({ ...musicCard })
    renewedVkey = await selected.sendMusic({ ...musicCard, audioUrl: 'http://ws.stream.qqmusic.qq.com/SongMid1.mp3?vkey=RENEWEDFIXTUREVKEY' })
    extraText = await attempt(() => selected.sendMessage({ text: '音乐卡片之后尝试额外消息。' }))
    anotherMusic = await attempt(() => selected.sendMusic(anotherCard))
    forgedTarget = await attempt(() => selected.sendMusic({ ...musicCard, target: { kind: 'private', id: 'somebody-else' } }))
    return { status: 'succeeded', content: `音乐发送回执：${first.messageId}` }
  } })
  await f.run()
  assert.deepEqual(first, { state: 'sent', messageId: 'music-1' })
  assert.deepEqual(duplicate, { state: 'failed', code: 'duplicate_music' })
  assert.deepEqual(renewedVkey, { state: 'failed', code: 'duplicate_music' }, 'renewing the same song playback key cannot create a duplicate card')
  for (const result of [extraText, anotherMusic]) { assert.equal(result.status, 'rejected'); assert.match(result.reason, /上限/u) }
  assert.equal(forgedTarget.status, 'rejected'); assert.match(forgedTarget.reason, /闭合|参数/u)
  assert.equal(f.musicAttempts.length, 1); assert.equal(f.music.length, 1); assert.equal(f.messages.length, 0)
  assert.deepEqual(f.music[0], { version: 1, kind: 'music.send', target: f.target, music: musicCard, binding: f.binding })
  assert.ok(f.musicAttempts[0].guard.signal instanceof AbortSignal)
  const state = await f.session()
  assert.deepEqual(state.sendTimes, [f.now]); assert.equal(state.lastAiSendAt, f.now)
  assert.deepEqual(state.confirmedMessageIds, ['music-1'])
  assert.equal(context.persona.name, '音乐角色')
  assert.equal(context.signal.aborted, true); assert.equal(context.isCurrent(), false)
  await assert.rejects(context.sendMusic(anotherCard), /失效/u)
  assert.equal(f.musicAttempts.length, 1)
})

test('ordinary text sent before a music card consumes the same per-turn allowance', redisTest, async t => {
  let sent, blocked
  const f = await fixture(t, { async execute(_input, context) {
    sent = await context.sendMessage({ text: '普通文字先占用发送配额。' })
    blocked = await attempt(() => context.sendMusic(musicCard))
    return { status: 'succeeded', content: '普通文字已确认，不额外发送音乐' }
  } })
  await f.run()
  assert.deepEqual(sent, { state: 'sent', messageId: 'text-1' })
  assert.equal(blocked.status, 'rejected'); assert.match(blocked.reason, /上限/u)
  assert.equal(f.messages.length, 1); assert.equal(f.musicAttempts.length, 0)
  assert.deepEqual((await f.session()).sendTimes, [f.now])
})

test('a genuinely different music card can use a spare send while a copied card remains a duplicate', redisTest, async t => {
  let first, second, duplicate
  const f = await fixture(t, { maxSends: 3, async execute(_input, context) {
    first = await context.sendMusic(musicCard)
    second = await context.sendMusic(anotherCard)
    duplicate = await context.sendMusic({ ...musicCard })
    return { status: 'succeeded', content: '两个不同音乐卡片均已收到回执' }
  } })
  await f.run()
  assert.deepEqual(first, { state: 'sent', messageId: 'music-1' })
  assert.deepEqual(second, { state: 'sent', messageId: 'music-2' })
  assert.deepEqual(duplicate, { state: 'failed', code: 'duplicate_music' })
  assert.equal(f.musicAttempts.length, 2)
  assert.deepEqual((await f.session()).sendTimes, [f.now, f.now])
})

test('unknown and invalid-id music receipts cannot be relabeled successful or followed by card, text or external actions', redisTest, async t => {
  for (const mode of ['unknown', 'missing-id', 'invalid-id']) await t.test(mode, async t => {
    let first, cardAfter, textAfter
    const f = await fixture(t, {
      maxSends: 4,
      async deliver(action, guard, selected) {
        assert.equal(guard.isCurrent(), true); selected.music.push(structuredClone(action))
        return mode === 'unknown' ? { state: 'unknown' } : mode === 'missing-id' ? { state: 'sent' } : { state: 'sent', messageId: '0' }
      },
      async execute(_input, context) {
        first = await context.sendMusic(musicCard)
        cardAfter = await attempt(() => context.sendMusic(anotherCard))
        textAfter = await attempt(() => context.sendMessage({ text: '未知音乐回执之后的额外文字' }))
        return { status: 'succeeded', content: '生成器错误声称音乐已经发送成功' }
      },
      model(round) {
        if (round === 1 || round === 3) return call(producerName)
        if (round === 2) return call(externalName)
        if (round === 4) return call('simSendMessage', { continuation: 'chat', messages: ['未知音乐后的额外普通发送'] })
      },
    })
    await f.run()
    assert.deepEqual(first, { state: 'unknown' })
    for (const result of [cardAfter, textAfter]) { assert.equal(result.status, 'rejected'); assert.match(result.reason, /未知/u) }
    assert.equal(f.producerCalls, 1); assert.equal(f.externalCalls, 0)
    assert.equal(f.musicAttempts.length, 1); assert.equal(f.music.length, 1); assert.equal(f.messages.length, 0)
    assert.deepEqual((await f.session()).sendTimes, [])
    assert.deepEqual((await f.session()).confirmedMessageIds ?? [], [])
    const receipts = await f.receipts()
    assert.ok(receipts.some(receipt => receipt.toolName === producerName && receipt.status === 'unknown'))
    assert.equal(receipts.some(receipt => receipt.toolName === producerName && receipt.status === 'succeeded'), false)
    assert.match(f.observed.find(row => row.name === producerName).content, /未知/u)
  })
})

test('a confirmed music send whose accounting save fails becomes unknown even when the producer catches errors and reports success', redisTest, async t => {
  let first, second, injected = false, failedSaves = 0, restoreStorage
  const f = await fixture(t, {
    maxSends: 4,
    async deliver(action, guard, selected) {
      assert.equal(guard.isCurrent(), true); selected.music.push(structuredClone(action))
      if (!injected) {
        injected = true
        const save = selected.storage.set
        restoreStorage = () => { selected.storage.set = save }
        selected.storage.set = (name, value, ...args) => {
          if (name === simulationSessionKey(selected.key) && failedSaves === 0) { failedSaves++; throw new Error('fixture post-music accounting write failed') }
          return save(name, value, ...args)
        }
      }
      return { state: 'sent', messageId: 'confirmed-before-save' }
    },
    async execute(_input, context) {
      first = await attempt(() => context.sendMusic(musicCard))
      second = await attempt(() => context.sendMusic(anotherCard))
      return { status: 'succeeded', content: '生成器捕获异常并错误声称本轮音乐发送成功' }
    },
    model(round) {
      if (round === 1) return call(producerName)
      if (round === 2) return call(externalName)
      if (round === 3) return call('simSendMessage', { continuation: 'chat', messages: ['本地音乐记账失败后的额外消息'] })
    },
  })
  t.after(() => restoreStorage?.())
  await f.run()
  assert.equal(failedSaves, 1)
  assert.deepEqual(first, { status: 'fulfilled', value: { state: 'unknown' } })
  assert.equal(second.status, 'rejected'); assert.match(second.reason, /未知/u)
  assert.equal(f.musicAttempts.length, 1); assert.equal(f.music.length, 1)
  assert.equal(f.messages.length, 0); assert.equal(f.externalCalls, 0)
  const receipts = await f.receipts()
  assert.ok(receipts.some(receipt => receipt.toolName === producerName && receipt.status === 'unknown'))
  assert.equal(receipts.some(receipt => receipt.toolName === producerName && receipt.status === 'succeeded'), false)
})

test('binding replacement and source recall cancel queued music cards before adapter dispatch', redisTest, async t => {
  for (const mode of ['binding', 'recall']) await t.test(mode, async t => {
    let release, context, adapterWaiting = false, outcomes
    const gate = new Promise(resolve => { release = resolve })
    const f = await fixture(t, {
      maxSends: 3, release: () => release(),
      async deliver(action, guard, selected) {
        adapterWaiting = true; await gate
        if (!guard.isCurrent() || guard.signal?.aborted) return { state: 'failed', code: 'cancelled_before_dispatch' }
        selected.music.push(structuredClone(action)); return { state: 'sent', messageId: 'late-music-must-not-dispatch' }
      },
      async execute(_input, selected) {
        context = selected
        outcomes = await Promise.allSettled([selected.sendMusic(musicCard), selected.sendMusic(anotherCard)])
        return { status: 'succeeded', content: '排队音乐发送已结束' }
      },
    })
    await f.emit()
    await waitFor(() => adapterWaiting, () => `music did not reach adapter queue: ${f.diagnostics.join('|')}`)
    assert.equal(f.musicAttempts.length, 1); assert.equal(f.music.length, 0)
    if (mode === 'binding') f.rebind()
    else await f.recall()
    await waitFor(() => context.signal.aborted, 'queued music tool cancellation')
    assert.equal(context.isCurrent(), false)
    assert.equal(f.musicAttempts[0].guard.isCurrent(), false); assert.equal(f.musicAttempts[0].guard.signal.aborted, true)
    release()
    await waitFor(async () => outcomes && await f.settled(), () => `cancelled music queue did not drain: ${f.diagnostics.join('|')}`)
    await f.host.runtime.drain()
    assert.equal(f.musicAttempts.length, 1, 'the second queued card never reaches the adapter')
    assert.equal(f.music.length, 0); assert.equal(f.messages.length, 0)
    assert.ok(outcomes.every(result => result.status === 'rejected'))
  })
})

test('temporary file tools receive no music port and subsequent producers cannot publish a derived card', redisTest, async t => {
  const f = await fixture(t, {
    temporary: true,
    async execute(_input, context) { await context.sendMusic(musicCard); return { status: 'succeeded', content: '不应执行的临时资料音乐' } },
    model(round) { if (round === 1) return call(readerName); if (round === 2) return call(producerName) },
  })
  await f.run()
  assert.equal(f.reads, 1); assert.equal(f.producerCalls, 0)
  assert.equal(f.outputs[0].absentBeforeRead, true); assert.equal(f.outputs[1].absentAfterRead, true)
  assert.equal(Buffer.from(f.outputs[1].result.base64, 'base64').toString(), temporary)
  assert.equal(f.musicAttempts.length, 0); assert.equal(f.messages.length, 0)
  assert.equal((await f.receipts()).some(receipt => [readerName, producerName].includes(receipt.toolName)), false)
  assert.deepEqual(f.observed, [])
})

test('a tool that reads explicit history cannot use its previously obtained music port afterward', redisTest, async t => {
  let history, denied, hadPort
  const f = await fixture(t, { history: true, async execute(_input, context) {
    hadPort = typeof context.sendMusic === 'function'
    history = await context.readHistory({ question: '查看之前的记录', source: 'recent', keywords: [], user_id: 'human', limit: 1 })
    denied = await attempt(() => context.sendMusic(musicCard))
    return { status: 'succeeded', content: '历史资料只在本轮使用' }
  } })
  await f.run()
  assert.equal(hadPort, true); assert.equal(typeof history, 'string'); assert.ok(history.includes(historySource))
  assert.equal(denied.status, 'rejected'); assert.match(denied.reason, /临时资料/u)
  assert.equal(f.musicAttempts.length, 0); assert.equal(f.messages.length, 0); assert.deepEqual(f.observed, [])
})

test('Core applies output policy to title, artist and all three music URLs before transport', redisTest, async t => {
  const inspected = [], results = [], marker = 'MUSIC_HOST_CREDENTIAL_78291'
  const candidates = [
    { ...musicCard, title: marker }, { ...musicCard, artist: marker },
    { ...musicCard, pageUrl: `https://y.qq.com/n/yqq/song/${marker.replaceAll('_', '')}.html` },
    { ...musicCard, audioUrl: `http://ws.stream.qqmusic.qq.com/SongMid1.mp3?vkey=${marker}` },
    { ...musicCard, coverUrl: `http://y.gtimg.cn/music/photo_new/T002R150x150M000${marker.replaceAll('_', '')}.jpg` },
  ]
  const compactMarker = marker.replaceAll('_', '')
  const f = await fixture(t, {
    allowsText(text, direction) { inspected.push({ text, direction }); return !text.includes(marker) && !text.includes(compactMarker) },
    async execute(_input, context) {
      for (const card of candidates) results.push(await attempt(() => context.sendMusic(card)))
      return { status: 'succeeded', content: '音乐卡片的输出策略已执行' }
    },
  })
  await f.run()
  assert.ok(results.every(result => result.status === 'fulfilled' && result.value.state === 'failed' && result.value.code === 'forbidden_music'))
  for (const card of candidates) {
    const field = Object.keys(card).find(key => card[key] !== musicCard[key])
    assert.ok(inspected.some(row => row.direction === 'outgoing' && row.text.includes(card[field])), `host output policy inspects ${field}`)
  }
  assert.equal(f.musicAttempts.length, 0); assert.equal(f.messages.length, 0)
  assert.deepEqual((await f.session()).sendTimes, [])
})
