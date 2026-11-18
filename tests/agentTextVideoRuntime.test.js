import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { createAgentRuntime } = await load('core/agentRuntime.js')
const { createAgentVideoSearchTools } = await load('modules/media/infrastructure/agentVideoSearchTools.js')
const { createAgentVideoSearchStore } = await load('modules/media/infrastructure/agentVideoSearchStore.js')
const { createAgentBindingDirectory, conversationAddressKey, platformAccountKey } = await load('modules/runtime/domain/agentBindings.js')
const { createAgentDiagnostics } = await load('modules/runtime/infrastructure/agentDiagnostics.js')
const { createConversationMemoryStore, conversationMemoryId } = await load('modules/memory/infrastructure/conversationMemoryStore.js')
const redisTest = { skip: !redisAvailable, timeout: 25_000 }
const RESULT = '视频查询临时结果标记', DERIVED = '视频查询临时总结标记', SIGNED = 'https://media.invalid/video.mp4?token=PRIVATE_VIDEO_SIGNATURE'
const BYTES = 'VIDEO_BYTES_MUST_NOT_PERSIST', HOST_SECRET = 'VIDEO_HOST_PRIVATE_SECRET'
const card = { provider: 'bilibili', id: 'BV1xx411c7mD', title: RESULT, author: '合成作者', durationSeconds: 60, pageUrl: 'https://www.bilibili.com/video/BV1xx411c7mD' }
const plan = { version: 1, items: [{ parts: [{ kind: 'text', text: '完整视频附件介绍' }] },
  { parts: [{ kind: 'video', artifact: { id: 'a'.repeat(32), kind: 'video', mime: 'video/mp4', sizeBytes: 128, sha256: 'b'.repeat(64) } }] }] }
const call = (name, input = {}) => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [
  { id: name + '-call', type: 'function', function: { name, arguments: JSON.stringify(input) } },
] } }] })
const answer = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const videoNames = ['searchVideoTool', 'videoShareTool', 'videoDownloadTool']
const names = request => request.tools?.map(tool => tool.function.name) ?? []
const sourceKey = (target, id) => JSON.stringify([conversationAddressKey(target), id])
const deferred = () => Promise.withResolvers()
let fixtureId = 0
async function waitFor(probe, message, detail = () => '') {
  const deadline = performance.now() + 8_000
  while (performance.now() < deadline) { if (await probe()) return; await delay(10) }
  assert.fail(`${message}: ${detail()}`)
}

async function fixture(t, settings = {}) {
  let host, f
  t.after(async () => { settings.release?.(); await host?.stop() })
  const redis = await createAgentRedisFixture(t, 'text-video-runtime')
  const account = { platform: 'fixture', namespace: 'text-video-' + ++fixtureId, id: 'robot' }, sender = { ...account, id: 'human' }
  const group = { account, kind: 'group', id: 'room' }, otherGroup = { ...group, id: 'other-room' }, privateTarget = { account, kind: 'private', id: sender.id }
  const config = { version: 1, agents: [{ id: 'role', personaId: 'default' }, { id: 'replacement', personaId: 'default' }],
    connections: [{ id: 'connection', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: [group, otherGroup, privateTarget].map(target => ({ connectionId: 'connection', kind: target.kind, conversationId: target.id, agentId: 'role' })) }
  let directory = createAgentBindingDirectory(config, 'text-video-initial'), accept, ready = false, sequence = 0, clock = Date.now(), configCurrent = true
  const sources = new Map(), requests = [], searches = [], resolutions = [], preparations = [], media = [], cards = [], sends = [], reads = [], events = [], logs = []
  const logger = { info: line => logs.push(line), warn: line => logs.push(line), error: line => logs.push(line) }
  const diagnostics = createAgentDiagnostics({ logger, now: () => clock, sink: { async append(event) { events.push(event); return true } } })
  const provider = {
    async search(keyword, context) { searches.push({ keyword, context }); return settings.search ? settings.search(keyword, context, f) : { items: [card] } },
    async resolve(input, context) { resolutions.push({ input, context }); return settings.resolve ? settings.resolve(input, context, f) : card },
  }
  const registry = createAgentVideoSearchTools({ enabled: true }, { storage: redis.storage, provider, diagnostics, now: () => clock, secrets: [HOST_SECRET],
    attachmentProvider: { async prepare(share, context) {
      const row = { share: structuredClone(share), context, releases: 0 }; preparations.push(row)
      const prepared = { status: 'ready', pageUrl: card.pageUrl, infoText: '完整视频附件介绍', plan,
        async release() { row.releases++ } }
      return settings.prepare ? settings.prepare(share, context, f, prepared) : prepared
    } },
  })
  const runtimeStorage = { ...redis.storage, async eval(script, options) {
    const result = await redis.storage.eval(script, options)
    await settings.onStorageEval?.(script, options, result, f)
    return result
  } }
  const queueKeys = ['group-text', 'private', 'privacy', 'simulation', 'group-log'].map(kind => redis.prefix + `agent:inbox:${kind}:${platformAccountKey(account)}`)
  function makeHost() {
    return createAgentRuntime({ storage: runtimeStorage, isExecutionCurrent: redis.isCurrent, now: () => clock, diagnostics,
      privateChatEnabled: true, useTextGroup: target => target.kind === 'group', textGroupRevision: 'text-video-config',
      groupTextTools: target => target.id === group.id ? settings.tools ?? videoNames : [], toolRegistry: registry,
      isVideoSearchCurrent: () => configCurrent,
      ...(settings.history ? { history: { enabled: true, retentionDays: 30, maxMessagesPerConversation: 100 } } : {}),
      allowsText: text => !text.includes(HOST_SECRET), allowsToolInput: text => !text.includes(HOST_SECRET),
      adapters: [{ id: 'connection', account, botUserId: account.id, botName: '群文字视频验证', isReady: () => ready,
        async start(consume) { accept = consume; ready = true }, stop() { ready = false },
        async readMessage(target, id, guard) {
          reads.push({ target: structuredClone(target), id }); await settings.read?.(target, id, f)
          return guard?.isCurrent?.() === false ? undefined : structuredClone(sources.get(sourceKey(target, id)))
        },
        actions: {
          async send(action, guard) { if (!guard.isCurrent()) return { state: 'failed', code: 'stale' }; sends.push(structuredClone(action)); return { state: 'sent', messageId: 'text-' + ++sequence } },
          async sendMediaRelay(action, guard) {
            assert.ok(guard.signal instanceof AbortSignal)
            if (settings.sendMedia) return settings.sendMedia(action, guard, f)
            if (!guard.isCurrent() || guard.signal.aborted) return { state: 'failed', code: 'stale' }
            media.push(structuredClone(action)); return settings.receipt ?? { state: 'sent', messageId: 'media-' + ++sequence }
          },
          async sendVideoCard(action, guard) {
            if (!guard.isCurrent() || guard.signal?.aborted) return { state: 'failed', code: 'stale' }
            cards.push(structuredClone(action)); return settings.receipt ?? { state: 'sent', messageId: 'card-' + ++sequence }
          },
        },
      }],
      logger,
      resolvePersona(target) { const binding = directory.resolve(target); return binding && { binding, persona: { name: '视频角色' }, systemContent: '合成群文字测试' } },
      getSection: () => ({ enabled: true, reflection: { enabled: false }, rhythm: { enabled: false }, mood: { enabled: false }, personProfile: { enabled: false },
        meme: { enabled: false }, userStyle: { enabled: false }, lifeThreads: { enabled: false }, wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000 },
        turn: { minSendGapMs: 0, maxTurnsPerDay: 1000 } }),
      getExecutionConfig: () => ({ providers: 'openai', useTools: true }),
      async YTapi(request, _config, signal, current, ensureCurrent) {
        await ensureCurrent?.(); if (signal?.aborted || current?.() === false) throw Error('stale fixture model')
        requests.push(structuredClone(request))
        return settings.model ? settings.model(request, requests.length, f) : requests.length === 1
          ? call('searchVideoTool', { keyword: '风景视频' }) : call('videoDownloadTool', { index: 1 })
      },
    })
  }
  f = { ...redis, account, sender, group, otherGroup, privateTarget, sources, requests, searches, resolutions, preparations, media, cards, sends, reads, events, logs,
    get host() { return host }, binding: (target = group) => directory.resolve(target),
    disable() { configCurrent = false },
    rebind() { directory = createAgentBindingDirectory({ ...config, bindings: config.bindings.map(binding => ({ ...binding, agentId: 'replacement' })) }, 'text-video-rebound') },
    message(text = '请搜索风景视频并下载第一个', extra = {}) {
      return { version: 1, conversation: group, sender, messageId: 'trigger-' + ++sequence, occurredAt: ++clock, text,
        parts: [{ kind: 'text', text }], mentions: [account], directedToAccount: true, ...extra }
    },
    async emit(message) { sources.set(sourceKey(message.conversation, message.messageId), structuredClone(message)); await accept({ kind: 'message', message: structuredClone(message) }) },
    async recall(message) { sources.delete(sourceKey(message.conversation, message.messageId)); await accept({ kind: 'recall', target: message.conversation, messageId: message.messageId }) },
    async drained() {
      await waitFor(async () => Number(await redis.reader.eval("local total = 0; for _, key in ipairs(KEYS) do total = total + redis.call('LLEN', key) end; return total", { keys: queueKeys, arguments: [] })) === 0,
        'text-video inbox did not settle', () => JSON.stringify(events.slice(-5)))
      await host.runtime.drain()
    },
    async send(text, extra) { const message = f.message(text, extra); await f.emit(message); await f.drained(); return message },
    async restart() { await host.stop(); host = makeHost(); await host.start() },
    async raw(pattern = '*') {
      const rows = []
      for (const key of await redis.reader.keys(redis.prefix + pattern)) if (await redis.reader.type(key) === 'string') rows.push([key.slice(redis.prefix.length), await redis.reader.get(key)])
      return JSON.stringify(rows)
    },
    async assertEphemeral() {
      const history = await f.raw('agent:group-text-history:*')
      assert.equal(history.includes(RESULT), false); assert.equal(history.includes(DERIVED), false)
      const narrative = await createConversationMemoryStore(redis.storage).load(conversationMemoryId(f.binding()))
      assert.deepEqual(narrative?.episodes ?? [], [])
      const all = await f.raw()
      for (const marker of [SIGNED, BYTES, HOST_SECRET]) {
        assert.equal(all.includes(marker), false); assert.equal(JSON.stringify(requests).includes(marker), false)
        assert.equal(JSON.stringify(events).includes(marker), false); assert.equal(logs.join('\n').includes(marker), false)
      }
      assert.equal(JSON.stringify(events).includes(RESULT), false); assert.equal(logs.join('\n').includes(RESULT), false)
    },
  }
  host = makeHost(); await host.start(); return f
}

for (const action of ['videoDownloadTool', 'videoShareTool']) test(`text Core search -> ${action} sends once to the fixed group and retains no temporary response`, redisTest, async t => {
  const f = await fixture(t, { model: (_request, index) => index === 1 ? call('searchVideoTool', { keyword: '风景视频' }) : call(action, { index: 1 }) })
  const original = await f.send()
  assert.equal(f.requests.length, 2); assert.ok(names(f.requests[0]).includes(action))
  assert.match(f.requests[1].messages.find(message => message.role === 'tool').content, new RegExp(RESULT, 'u'))
  assert.equal(f.searches.length, 1); assert.equal(f.sends.length, 0)
  const delivered = action === 'videoDownloadTool' ? f.media : f.cards
  assert.equal(delivered.length, 1); assert.deepEqual(delivered[0].target, f.group); assert.deepEqual(delivered[0].binding, f.binding())
  if (action === 'videoDownloadTool') { assert.equal(f.preparations[0].releases, 1); assert.equal(delivered[0].mode, 'forward'); assert.deepEqual(delivered[0].plan, plan) }
  await f.emit(original); await f.drained(); await f.restart(); await f.emit(original); await f.drained()
  assert.equal(delivered.length, 1); assert.equal(f.requests.length, 2); await f.assertEphemeral()
})

test('text Core metadata-only search can produce one ephemeral answer without media or retained model evidence', redisTest, async t => {
  const f = await fixture(t, { model: (_request, index) => index === 1 ? call('searchVideoTool', { keyword: '风景视频' }) : answer(DERIVED) })
  await f.send('请只查询风景视频')
  assert.equal(f.media.length, 0); assert.equal(f.cards.length, 0); assert.equal(f.preparations.length, 0)
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].parts[0].text, DERIVED)
  await f.assertEphemeral()
})

for (const changed of ['text', 'time']) test(`text Core refuses a current trigger whose native ${changed} changed before source reauthorization`, redisTest, async t => {
  let altered = false
  const f = await fixture(t, { model: () => call('videoDownloadTool', { query: '风景视频' }), read(target, id, run) {
    if (altered) return; altered = true
    const key = sourceKey(target, id), previous = run.sources.get(key)
    run.sources.set(key, { ...previous, ...(changed === 'text' ? { text: '替换后的请求正文' } : { occurredAt: previous.occurredAt + 1 }) })
  } })
  await f.send()
  assert.equal(f.resolutions.length, 0); assert.equal(f.preparations.length, 0); assert.equal(f.media.length, 0); assert.equal(f.cards.length, 0)
  assert.equal(f.sends.length, 0, 'a replaced trigger cannot authorize a fallback notification')
  assert.equal(f.requests.length, 1, 'a replaced trigger cannot authorize an explanation model request')
  assert.ok(f.events.some(event => event.operation === 'text_video' && event.outcome === 'failed'))
})

for (const revoke of ['recall', 'config', 'binding']) test(`text Core ${revoke} revocation cancels attachment preparation and suppresses late delivery`, redisTest, async t => {
  const entered = deferred(), held = deferred(); let message
  const f = await fixture(t, { model: () => call('videoDownloadTool', { query: '风景视频' }), release() { held.resolve() },
    async prepare(_share, context, _run, prepared) { entered.resolve(context); await held.promise; return prepared },
  })
  message = f.message(); await f.emit(message); const context = await entered.promise
  if (revoke === 'recall') await f.recall(message)
  else if (revoke === 'config') f.disable()
  else f.rebind()
  await f.drained(); assert.equal(context.signal.aborted, true); held.resolve(); await delay(25)
  assert.equal(f.media.length, 0); assert.equal(f.cards.length, 0); assert.equal(f.sends.length, 0)
  assert.equal(f.preparations[0].releases, 1)
})

test('text Core unknown delivery freezes duplicate inbox entries and restart without fallback or a second model call', redisTest, async t => {
  const f = await fixture(t, { receipt: { state: 'unknown' }, model: () => call('videoDownloadTool', { query: '风景视频' }) })
  const message = await f.send(); await f.emit(message); await f.drained(); await f.restart(); await f.emit(message); await f.drained()
  assert.equal(f.media.length, 1); assert.equal(f.requests.length, 1); assert.equal(f.sends.length, 0); assert.equal(f.preparations[0].releases, 1)
  assert.ok(f.events.some(event => event.operation === 'text_video' && event.outcome === 'unknown')); await f.assertEphemeral()
})

test('text Core exposes only each group explicit video list and never declares video tools in private chats', redisTest, async t => {
  const f = await fixture(t, { tools: ['searchVideoTool'], model: () => answer('普通对话回复') })
  await f.send('当前群查询'); assert.ok(names(f.requests[0]).includes('searchVideoTool')); assert.equal(names(f.requests[0]).includes('videoDownloadTool'), false)
  await f.send('其他群对话', { conversation: f.otherGroup }); assert.equal(names(f.requests[1]).some(name => videoNames.includes(name)), false)
  await f.send('好友私聊', { conversation: f.privateTarget }); assert.equal(names(f.requests[2]).some(name => videoNames.includes(name)), false)
  assert.equal(f.media.length, 0); assert.equal(f.cards.length, 0)
})

test('text Core refuses video output derived from a preceding ephemeral history tool even if a model invents the call', redisTest, async t => {
  const f = await fixture(t, { history: true, model: (_request, index) => index === 1
    ? call('chatHistoryTool', { question: '之前的风景视频', source: 'recent' }) : call('videoDownloadTool', { query: '风景视频' }) })
  await f.send('先查历史再下载风景视频')
  assert.equal(f.requests.length, 2); assert.ok(f.requests[1].messages.some(message => message.role === 'tool' && message.name === 'chatHistoryTool'))
  assert.equal(names(f.requests[1]).some(name => videoNames.includes(name)), false)
  assert.equal(f.preparations.length, 0); assert.equal(f.media.length, 0); assert.equal(f.cards.length, 0); assert.equal(f.sends.length, 0)
  await f.assertEphemeral()
})

test('text Core failed attachment preparation records safe diagnostics and explains without leaking private provider data', redisTest, async t => {
  const f = await fixture(t, { model: (_request, index) => index === 1 ? call('videoDownloadTool', { query: '风景视频' }) : answer('这次没有取得完整视频，暂时无法发送。'),
    async prepare() { throw Error(SIGNED + BYTES + HOST_SECRET) },
  })
  await f.send()
  assert.equal(f.preparations.length, 1); assert.equal(f.media.length, 0); assert.equal(f.sends.length, 1); assert.equal(f.requests.length, 2)
  assert.ok(f.events.some(event => event.outcome === 'failed')); await f.assertEphemeral()
})

test('text Core rejects an index selection when another search replaces the list before the follow-up model returns', redisTest, async t => {
  let replaced = false, replacementSource
  const f = await fixture(t, { async model(_request, index, run) {
    if (index === 1) return call('searchVideoTool', { keyword: '风景视频' })
    const cached = await createAgentVideoSearchStore(run.storage).load(run.binding())
    assert.ok(cached)
    const store = createAgentVideoSearchStore(run.storage, { now: () => cached.savedAt })
    const ticket = await store.begin(run.binding(), { messageId: replacementSource.messageId, author: replacementSource.sender })
    const saved = await store.save(ticket, [{ ...card, id: 'BV1xx411c7mE', title: '新查询替换的作品', pageUrl: 'https://www.bilibili.com/video/BV1xx411c7mE' }])
    assert.ok(saved); assert.notEqual(saved.generation, cached.generation); assert.equal(saved.savedAt, cached.savedAt)
    replaced = true
    return call('videoDownloadTool', { index: 1 })
  } })
  replacementSource = f.message('另一个合法查询的来源', { sender: { ...f.sender, id: 'other-human' }, directedToAccount: false, mentions: [] })
  await f.emit(replacementSource); await f.drained()
  assert.equal(f.requests.length, 0, 'replacement source is admitted without waking a model')
  await f.send()
  assert.equal(replaced, true); assert.equal(f.requests.length, 2)
  assert.equal(f.preparations.length, 0); assert.equal(f.resolutions.length, 0); assert.equal(f.media.length, 0); assert.equal(f.sends.length, 0)
})

test('text Core rechecks the original trigger after claiming its final search-only text reply', redisTest, async t => {
  let replaced = false
  const f = await fixture(t, { model: (_request, index) => index === 1 ? call('searchVideoTool', { keyword: '风景视频' }) : answer(DERIVED),
    onStorageEval(_script, options, result, run) {
      if (replaced || !run || result !== 1 || options.arguments[2] !== '1' || options.arguments[3] !== 'attempted') return
      const key = run.sources.keys().next().value, original = run.sources.get(key)
      assert.ok(original); run.sources.set(key, { ...original, text: '最终回复领取期间被替换的原消息' }); replaced = true
    },
  })
  await f.send('只查询风景视频并简短介绍')
  assert.equal(replaced, true); assert.equal(f.requests.length, 2); assert.equal(f.searches.length, 1)
  assert.equal(f.sends.length, 0); assert.equal(f.media.length, 0); assert.equal(f.cards.length, 0); await f.assertEphemeral()
})

test('text Core carries the asynchronous source finalizer into a media consumer staging phase', redisTest, async t => {
  let staged = false, rejected = false
  const f = await fixture(t, { model: () => call('videoDownloadTool', { query: '风景视频' }),
    async sendMedia(_action, guard, run) {
      assert.equal(typeof guard.ensureCurrent, 'function')
      await guard.ensureCurrent(); assert.equal(guard.isCurrent(), true)
      await Promise.resolve() // A real consumer can stage an artifact asynchronously here.
      const key = run.sources.keys().next().value, original = run.sources.get(key)
      run.sources.set(key, { ...original, text: '制品暂存后被替换的原消息' }); staged = true
      await assert.rejects(guard.ensureCurrent(), /失效|unavailable/u); rejected = true
      return { state: 'failed', code: 'source_changed_before_native_dispatch' }
    },
  })
  await f.send()
  assert.equal(staged, true); assert.equal(rejected, true); assert.equal(f.preparations[0].releases, 1)
  assert.equal(f.media.length, 0); assert.equal(f.sends.length, 0); assert.equal(f.requests.length, 1)
})
