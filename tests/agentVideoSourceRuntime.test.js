import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentBindingDirectory, createAgentRuntime } from '../dist/backend/core/index.js'
import { createAgentTools } from '../dist/backend/modules/tools/infrastructure/agentTools.js'
import { createDefaultSimSession } from '../dist/backend/modules/simulation/domain/simConfig.js'
import { compactSimMessage } from '../dist/backend/modules/simulation/domain/messageView.js'
import { normalizeSimulationMessageVideo } from '../dist/backend/modules/simulation/infrastructure/simulationAgentVideo.js'
import { simulationAddressKey } from '../dist/backend/modules/simulation/infrastructure/simulationAddress.js'
import { simulationBusyKey, simulationSessionKey } from '../dist/backend/modules/simulation/infrastructure/simSessionStore.js'
import { agentBindingToken, agentPersonaScopeId, platformAccountKey } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { createPersonMemoryStore } from '../dist/backend/modules/memory/infrastructure/personMemoryStore.js'
import { personMemoryAddress } from '../dist/backend/modules/memory/infrastructure/personMemoryContext.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const parameters = { type: 'object', properties: { prompt: { type: 'string' } }, required: [], additionalProperties: false }
const account = { platform: 'fixture', namespace: 'video-source', id: 'robot' }, target = { account, kind: 'group', id: 'room' }
const sender = { ...account, id: 'human' }
const bytes = Buffer.concat([Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex'), Buffer.from('synthetic-video-turn-input')])
const video = { mime: 'video/mp4', base64: bytes.toString('base64') }
const marker = '视频分析仅限本轮的客观描述', derived = '视频分析派生回复不得留存'
const resource = { kind: 'url', value: 'https://qq.example/video.mp4?private-video-signed-url' }
const definition = execute => ({ name: 'videoAnalysisTool', description: 'Source-scoped video analysis fixture', parameters, dataPolicy: 'ephemeral', execute })
const done = { status: 'succeeded', content: marker }
const call = (name, input = {}) => ({ choices: [{ message: { content: '', tool_calls: [{ id: name + '-call', type: 'function', function: { name, arguments: JSON.stringify(input) } }] } }] })
const finish = () => call('simFinishTurn', { choice: 'chat', reason: derived, messages: [derived] })
async function waitFor(probe, diagnostic) {
  const until = performance.now() + 8000
  while (performance.now() < until) { if (await probe()) return; await delay(15) }
  assert.fail(diagnostic())
}

test('readVideo is exposed only to declared ephemeral human group tools and owns bounded bytes', async () => {
  let reads = 0
  for (const settings of [{}, { ordinary: true }, { actor: { kind: 'autonomous' } }, { actor: { kind: 'commitment' } }, { kind: 'private' }, { kind: 'channel' }]) {
    const permitted = Object.keys(settings).length === 0
    const tool = { ...definition(async (_input, context) => {
      assert.equal(Object.hasOwn(context, 'readVideo'), permitted)
      if (permitted) { const result = await context.readVideo(); assert.deepEqual(result, video); assert.ok(Object.isFrozen(result)); assert.equal(context.sendVideo, undefined) }
      return done
    }), ...(settings.ordinary ? { dataPolicy: undefined } : {}) }
    const scope = { binding: { id: 'binding', agentId: 'role', revision: 'one', target: { ...target, kind: settings.kind ?? 'group' } }, actor: settings.actor ?? { kind: 'user', user: sender },
      isCurrent: () => true, async readVideo(current, signal) { reads++; assert.equal(current(), true); assert.equal(signal.aborted, false); return { ...video } },
      async sendVideo() { assert.fail('temporary data must not obtain an outbound video port') } }
    const wrapped = createAgentTools({ builtIn: [tool] }, { signal: new AbortController().signal, context: () => scope })
    assert.equal((await wrapped.getExtraTools([tool.name])[0].execute({}, {})).status, 'success')
  }
  assert.equal(reads, 1)
})

test('video metadata reload drops arbitrary fields and clamps direct/quoted counts', () => {
  const message = { seq: 1, userId: 'human', name: '人', text: '', at: Date.now(), imageCount: 0, videoCount: 9999,
    quoteSource: { messageId: 'quoted', invalidatedAt: 0, video: { count: 9999, authorId: 'other', occurredAt: Date.now(), url: resource.value, base64: video.base64 } } }
  const clean = normalizeSimulationMessageVideo(message)
  assert.equal(clean.videoCount, 20); assert.equal(clean.quoteSource.video.count, 20)
  assert.doesNotMatch(JSON.stringify(clean), /private-video-signed-url|base64|url/u)
  assert.match(compactSimMessage(clean, message.at), /视频/u)
})

const redisTest = { skip: !redisAvailable, timeout: 25_000 }
async function fixture(t, settings = {}) {
  const redis = await createAgentRedisFixture(t, 'video-source'), { storage, reader, prefix } = redis
  const config = { version: 1, agents: [{ id: 'role', personaId: 'default' }, { id: 'replacement', personaId: 'default' }],
    connections: [{ id: 'connection', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: [{ connectionId: 'connection', kind: 'group', conversationId: target.id, agentId: 'role' }] }
  let directory = createAgentBindingDirectory(config, 'video-initial'), accept, now = Date.now(), completed = false, attempts = 0, forwardVersion = 1
  const binding = directory.resolve(target), key = simulationAddressKey(target), address = personMemoryAddress(target)
  const identity = { botId: address.botId, personaId: agentPersonaScopeId(binding.agentId) }, memory = createPersonMemoryStore({ redis: storage, now: () => now })
  const initial = createDefaultSimSession(now)
  initial.bootstrapSent = true; initial.botId = account.id; initial.bindingToken = agentBindingToken(binding); initial.personaId = identity.personaId
  initial.wakeConfig.triggers = { ...initial.wakeConfig.triggers, probability: 0, question: false, nameMention: false, anyMessage: false }; initial.nextProactiveCheckAt = now + 86_400_000
  await storage.set(simulationSessionKey(key), JSON.stringify(initial))
  const originals = new Map(), reads = [], requests = [], sends = [], diagnostics = [], observations = []
  const forwardAuthors = [{ author: { ...account, id: 'ancestor' }, occurredAt: now - 3000 }, { author: { ...account, id: 'leaf' }, occurredAt: now - 2000 }]
  const session = async () => JSON.parse(await storage.get(simulationSessionKey(key)) || 'null')
  const settled = async () => !await reader.exists(prefix + simulationBusyKey(key)) && !await reader.lLen(prefix + `agent:inbox:simulation:${platformAccountKey(account)}`)
  let f
  const registry = { builtIn: [definition(async (_input, context) => {
    try { assert.deepEqual(await context.readVideo(), video); await settings.afterVideo?.(f, context); return done }
    finally { completed = true }
  })] }
  const host = createAgentRuntime({ storage, isExecutionCurrent: redis.isCurrent, now: () => now,
    adapters: [{ id: 'connection', account, botName: 'fixture', botUserId: account.id, isReady: () => Boolean(accept),
      async start(consume) { accept = consume }, stop() {},
      async readMessage(_target, id, guard) { return guard?.isCurrent?.() !== false && originals.has(id) ? structuredClone(originals.get(id)) : undefined },
      async readMessageVideo(selectedTarget, id, guard) {
        reads.push({ target: structuredClone(selectedTarget), id, inspectOnly: guard.inspectOnly === true })
        await guard.ensureCurrent?.()
        const root = originals.get(id)
        if (!root || !await guard.allowsSource(structuredClone(root))) return undefined
        let selected = root, origin = 'current'
        if (!root.parts.some(part => part.kind === 'video')) {
          const quoted = originals.get(root.quote?.messageId)
          if (quoted) { if (!await guard.allowsSource(structuredClone(quoted))) return undefined; selected = quoted; origin = 'reply' }
          if (!selected.parts.some(part => part.kind === 'video')) {
            if (!selected.parts.some(part => part.kind === 'forward')) return undefined
            for (const source of forwardAuthors) if (!await guard.allowsForwardSource(structuredClone(source))) return undefined
            origin = 'forward'
          }
        }
        const fingerprint = createHash('sha256').update(JSON.stringify([selected.messageId, selected.parts, origin, origin === 'forward' ? [forwardAuthors, forwardVersion] : null])).digest('hex')
        if (!guard.inspectOnly) await settings.duringVideo?.(f, guard)
        await guard.ensureCurrent?.()
        return { fingerprint, origin, ...(guard.inspectOnly ? {} : { video }) }
      },
      actions: { async send(action, guard) { if (!guard.isCurrent()) return { state: 'failed', code: 'stale' }; sends.push(structuredClone(action)); return { state: 'sent', messageId: 'video-answer' } } },
    }],
    logger: { info() {}, warn(...args) { diagnostics.push(args.join(' ')) }, error(...args) { diagnostics.push(args.join(' ')) } },
    getSection: () => ({ enabled: true, reflection: { enabled: false }, rhythm: { enabled: false }, mood: { enabled: false }, personProfile: { enabled: false }, meme: { enabled: false }, userStyle: { enabled: false }, lifeThreads: { enabled: false },
      wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000 }, turn: { minSendGapMs: 0, maxSendsPerTurn: 1, maxToolRounds: 5 }, toolPolicy: { mode: 'open' } }),
    getExecutionConfig: () => ({ providers: 'openai', useTools: true }),
    resolvePersona(address) { const selected = directory.resolve(address); return selected && { binding: selected, persona: { name: 'fixture' }, systemContent: '' } },
    toolRegistry: registry,
    recordToolResult: value => observations.push(value), recordGroupReply: () => observations.push('reply'), recordEpisode: () => observations.push('episode'),
    async YTapi(request, _config, _signal, _current, ensureCurrent) {
      attempts++; await settings.beforeModel?.(f, attempts, request); await ensureCurrent?.(); requests.push(structuredClone(request))
      if (requests.length === 1) return call('videoAnalysisTool')
      await settings.duringContinuation?.(f, { signal: _signal, isCurrent: _current, ensureCurrent })
      await settings.beforeFinish?.(f)
      return finish()
    },
  })
  f = { ...redis, host, target, sender, binding, identity, address, memory, originals, reads, requests, sends, diagnostics, observations, forwardAuthors, session, settled,
    get now() { return now }, get attempts() { return attempts },
    replaceForward() { forwardVersion++ },
    removeVideoDefinition() { registry.builtIn = [] },
    rebind() { directory = createAgentBindingDirectory({ ...config, bindings: [{ ...config.bindings[0], agentId: 'replacement' }] }, 'video-rebound') },
    recall(id) { return accept({ kind: 'recall', target, messageId: id }) },
    async emit(id, { text = '', videos = 0, quoteId, forward = false, author = sender.id, directed = false, occurredAt = now } = {}) {
      const message = { version: 1, conversation: target, sender: { ...sender, id: author }, senderName: author, messageId: id, occurredAt, text,
        parts: [...(text ? [{ kind: 'text', text }] : []), ...Array.from({ length: videos }, () => ({ kind: 'video', resource, name: 'native-video-reference-must-not-persist' })), ...(forward ? [{ kind: 'forward', id: 'forward-root' }] : [])],
        mentions: directed ? [account] : [], directedToAccount: directed, ...(quoteId ? { quote: { messageId: quoteId, author: { ...sender, id: 'forged-inbound-quote-author' }, parts: [] } } : {}) }
      originals.set(id, structuredClone(message)); await accept({ kind: 'message', message })
      if (!directed) await waitFor(async () => (await session())?.recent?.some(row => row.messageId === id) && await settled(), () => `video metadata ingress: ${diagnostics.join('|')}`)
    },
    async run(extra = {}) {
      now++; await f.emit('trigger', { text: '请分析这个视频', directed: true, videos: 1, ...extra })
      await waitFor(async () => completed && await settled(), () => `video turn: ${diagnostics.join('|')}`); await host.runtime.drain()
    },
    async assertEphemeral() {
      const snapshot = await session(); assert.equal(snapshot.lastConfirmedChat, undefined); assert.deepEqual(observations, [])
      for (const redisKey of await reader.keys(prefix + '*')) if (await reader.type(redisKey) === 'string') {
        const saved = await reader.get(redisKey)
        for (const value of [marker, derived, video.base64, resource.value, 'native-video-reference-must-not-persist']) assert.ok(!saved.includes(value), `temporary video data escaped at ${redisKey}`)
      }
      const model = JSON.stringify(requests)
      assert.ok(!model.includes(video.base64)); assert.ok(!model.includes(resource.value))
    },
  }
  t.after(() => host.stop())
  await host.start()
  return f
}

test('Core retains pure video metadata, ignores forged quote identity and strips native resources before persistence', redisTest, async t => {
  const f = await fixture(t)
  await f.emit('pure-video', { videos: 2 })
  await f.emit('quoted-video', { quoteId: 'pure-video' })
  const snapshot = await f.session(), direct = snapshot.recent.find(row => row.messageId === 'pure-video'), quoted = snapshot.recent.find(row => row.messageId === 'quoted-video')
  assert.equal(direct.videoCount, 2); assert.equal(quoted.quoteSource.video.count, 2); assert.equal(quoted.quoteSource.video.authorId, sender.id)
  assert.match(compactSimMessage(direct, f.now), /视频/u); assert.equal(f.requests.length, 0)
  await f.assertEphemeral()
})

test('current, quoted and forwarded video reading fixes the trigger, downloads once and rechecks provenance through final send', redisTest, async t => {
  for (const source of ['current', 'reply', 'forward', 'quoted-forward']) await t.test(source, async t => {
    const f = await fixture(t)
    if (source === 'reply') await f.emit('quoted', { videos: 1, author: 'quoted-human', occurredAt: f.now - 1000 })
    if (source === 'quoted-forward') await f.emit('quoted', { forward: true, author: 'quoted-human', occurredAt: f.now - 1000 })
    await f.run(source === 'current' ? {} : source === 'forward' ? { videos: 0, forward: true } : { videos: 0, quoteId: 'quoted' })
    assert.equal(f.reads.filter(read => !read.inspectOnly).length, 1); assert.ok(f.reads.filter(read => read.inspectOnly).length > 1)
    assert.ok(f.reads.every(read => read.id === 'trigger' && JSON.stringify(read.target) === JSON.stringify(target)))
    assert.ok(f.requests.some(request => request.messages.some(message => message.role === 'tool' && message.name === 'videoAnalysisTool' && message.content.includes(marker))))
    assert.equal(f.sends.length, 1); assert.match(JSON.stringify(f.sends), new RegExp(derived)); await f.assertEphemeral()
  })
})

test('a direct current video remains readable when an unrelated reply cannot be verified', redisTest, async t => {
  const f = await fixture(t)
  await f.run({ quoteId: 'unavailable-unrelated-reply' })
  assert.equal(f.reads.filter(read => !read.inspectOnly).length, 1)
  assert.ok(f.requests.some(request => request.messages.some(message => message.role === 'tool' && message.name === 'videoAnalysisTool' && message.content.includes(marker))))
  assert.equal(f.sends.length, 1); await f.assertEphemeral()
})

test('only a mention plus video provides a human-directed analysis request without visible text', redisTest, async t => {
  const f = await fixture(t)
  await f.run({ text: '' })
  assert.equal(f.reads.filter(read => !read.inspectOnly).length, 1)
  assert.ok(f.requests.some(request => request.messages.some(message => message.role === 'tool' && message.name === 'videoAnalysisTool' && message.content.includes(marker))))
  assert.equal(f.sends.length, 1); assert.equal((await f.session()).recent.find(message => message.messageId === 'trigger').text, '@你')
  await f.assertEphemeral()
})

test('a non-directed pure video survives session reload and privacy filtering without acquiring a tool turn', redisTest, async t => {
  const f = await fixture(t)
  await f.emit('pure-video', { videos: 1 })
  await f.emit('quote-only-video', { quoteId: 'pure-video' })
  assert.equal(f.requests.length, 0); assert.equal(f.reads.length, 0)
  assert.equal((await f.session()).recent.find(message => message.messageId === 'pure-video').videoCount, 1)
  await f.run()
  const retained = (await f.session()).recent.find(message => message.messageId === 'pure-video')
  assert.ok(retained, 'loading and privacy-filtering another turn preserves the bounded video source')
  assert.equal(retained.videoCount, 1); assert.equal(retained.text, '')
  const retainedQuote = (await f.session()).recent.find(message => message.messageId === 'quote-only-video')
  assert.ok(retainedQuote, 'a verified quote-only video also has a nonempty privacy-source excerpt')
  assert.equal(retainedQuote.quoteSource.video.count, 1)
  assert.ok(f.reads.every(read => read.id === 'trigger'), 'the unrelated pure video never becomes an autonomous video source')
  await f.assertEphemeral()
})

test('removing a completed video tool definition cancels its pending derived model continuation and the whole turn', redisTest, async t => {
  let cancelled = false
  const f = await fixture(t, { async duringContinuation(f, { signal, isCurrent, ensureCurrent }) {
    assert.equal(f.reads.filter(read => !read.inspectOnly).length, 1)
    assert.equal(signal.aborted, false, 'successful tool completion must not cancel its derived model call')
    assert.equal(isCurrent(), true)
    f.removeVideoDefinition()
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('revoked definition did not cancel the pending continuation')), 1000)
      signal.addEventListener('abort', () => { clearTimeout(timeout); resolve() }, { once: true })
    })
    cancelled = true
    assert.equal(isCurrent(), false)
    await assert.rejects(ensureCurrent())
    signal.throwIfAborted()
  } })
  await f.run()
  assert.equal(cancelled, true); assert.equal(f.requests.length, 2); assert.equal(f.sends.length, 0)
  await f.assertEphemeral()
})

test('video projections reject source edits, root identity, recall, binding and privacy changes before another model call', redisTest, async t => {
  for (const mode of ['resource', 'author', 'time', 'target', 'request-text', 'recall', 'binding', 'privacy']) await t.test(mode, async t => {
    const f = await fixture(t, { async beforeModel(f, attempt) {
      if (attempt !== 2) return
      const root = f.originals.get('trigger')
      if (mode === 'resource') root.parts.find(part => part.kind === 'video').resource.value += '-replacement'
      if (mode === 'author') root.sender.id = 'other'
      if (mode === 'time') root.occurredAt--
      if (mode === 'target') root.conversation.id = 'other-room'
      if (mode === 'request-text') root.text = '现在不要分析'
      if (mode === 'recall') await f.recall('trigger')
      if (mode === 'binding') f.rebind()
      if (mode === 'privacy') await f.memory.setEnabled({ identity: f.identity, subjectId: f.sender.id, enabled: false, scene: f.address.scene })
    } })
    await f.run(); assert.equal(f.requests.length, 1); assert.equal(f.sends.length, 0); await f.assertEphemeral()
  })
})

test('quoted-video root link and original identity are reauthorized again before sending a derived answer', redisTest, async t => {
  for (const mode of ['quote-link', 'quote-author', 'quote-time', 'quote-recall']) await t.test(mode, async t => {
    const f = await fixture(t, { async beforeFinish(f) {
      if (mode === 'quote-link') f.originals.get('trigger').quote.messageId = 'different-quote'
      if (mode === 'quote-author') f.originals.get('quoted').sender.id = 'different-author'
      if (mode === 'quote-time') f.originals.get('quoted').occurredAt--
      if (mode === 'quote-recall') await f.recall('quoted')
    } })
    await f.emit('quoted', { videos: 1, author: 'quoted-human', occurredAt: f.now - 1000 })
    await f.run({ videos: 0, quoteId: 'quoted' }); assert.equal(f.sends.length, 0); assert.equal(f.reads.filter(read => !read.inspectOnly).length, 1); await f.assertEphemeral()
  })
})

test('every forward ancestor and leaf must retain identity, time and root-scope privacy permission', redisTest, async t => {
  for (const mode of ['ancestor-disabled', 'leaf-disabled', 'missing-time', 'future-time', 'foreign-namespace', 'fingerprint']) await t.test(mode, async t => {
    const f = await fixture(t, { async beforeModel(f, attempt) {
      if (attempt !== 2) return
      if (mode.endsWith('disabled')) await f.memory.setEnabled({ identity: f.identity, subjectId: mode === 'ancestor-disabled' ? 'ancestor' : 'leaf', enabled: false, scene: f.address.scene })
      if (mode === 'missing-time') f.forwardAuthors[0].occurredAt = 0
      if (mode === 'future-time') f.forwardAuthors[1].occurredAt = f.now + 1000
      if (mode === 'foreign-namespace') f.forwardAuthors[0].author.namespace = 'elsewhere'
      if (mode === 'fingerprint') f.replaceForward()
    } })
    await f.run({ videos: 0, forward: true }); assert.equal(f.requests.length, 1); assert.equal(f.sends.length, 0); await f.assertEphemeral()
  })
})

test('an in-flight video lookup is cancelled when its root is recalled and no derived result is retained', redisTest, async t => {
  const f = await fixture(t, { async duringVideo(f, guard) { await f.recall('trigger'); await assert.rejects(guard.ensureCurrent()) } })
  await f.run(); assert.equal(f.sends.length, 0); await f.assertEphemeral()
})
