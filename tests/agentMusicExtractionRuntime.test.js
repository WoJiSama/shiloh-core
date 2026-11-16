import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentBindingDirectory, createAgentRuntime } from '../dist/backend/core/index.js'
import { conversationAddressKey, platformAccountKey } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { createAgentMusicExtractionLedger } from '../dist/backend/modules/media/infrastructure/agentMusicExtractionLedger.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const redisTest = { skip: !redisAvailable, timeout: 20_000 }
const privateUrl = 'https://m701.music.126.net/PRIVATE_AUDIO_SOURCE_TOKEN/full.mp3'
const audioBytes = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.from('PRIVATE_OWNED_AUDIO_BYTES_FOR_EXTRACTION')])
const base64 = audioBytes.toString('base64')
const prepared = { attachment: { name: '合成完整音频.mp3', mime: 'audio/mpeg', base64 }, audio: { mime: 'audio/mpeg', base64 }, title: '合成音频标题', artist: '合成作者' }
const share = { provider: 'netease', reference: { kind: 'audio', url: privateUrl } }
const sent = messageId => ({ state: 'sent', messageId })
const uploaded = fileId => ({ state: 'uploaded', fileId })
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve }); return { promise, release } }
let fixtureId = 0

async function waitFor(probe, label, timeout = 7000) {
  const until = Date.now() + timeout
  while (Date.now() < until) { const result = await probe(); if (result) return result; await delay(15) }
  assert.fail(`timed out: ${typeof label === 'function' ? label() : label}`)
}

async function fixture(t, options = {}) {
  const redis = await createAgentRedisFixture(t, 'music-extraction-runtime'), { storage, reader, prefix } = redis
  const namespace = `extract-${++fixtureId}`, accounts = ['robot-a', 'robot-b'].map((id, index) => ({ platform: 'fixture', namespace: index ? `${namespace}-other` : namespace, id }))
  const targets = accounts.map(account => ({ account, kind: 'group', id: 'same-room' }))
  const sender = { ...accounts[0], id: 'operator' }, privateTarget = { account: accounts[0], kind: 'private', id: sender.id }
  const target = options.mode === 'private' ? privateTarget : targets[0], now = Date.now()
  const config = { version: 1, agents: [{ id: 'role', personaId: 'default' }, { id: 'replacement', personaId: 'default' }],
    connections: accounts.map((account, index) => ({ id: `connection-${index}`, platform: account.platform, namespace: account.namespace, accountId: account.id })),
    bindings: [...targets.map((selected, index) => ({ connectionId: `connection-${index}`, kind: 'group', conversationId: selected.id, agentId: 'role' })),
      { connectionId: 'connection-0', kind: 'private', conversationId: privateTarget.id, agentId: 'role' }] }
  let directory = createAgentBindingDirectory(config, 'extraction-initial'), host
  const accepts = new Map(), ready = new Set(), sources = new Map(), reads = [], calls = [], requests = [], contexts = [], diagnostics = []
  const sourceKey = (selected, messageId) => JSON.stringify([conversationAddressKey(selected), messageId])
  const ledger = createAgentMusicExtractionLedger(storage)
  const section = { enabled: true, reflection: { enabled: false }, rhythm: { enabled: false }, mood: { enabled: false },
    personProfile: { enabled: false }, meme: { enabled: false }, userStyle: { enabled: false }, lifeThreads: { enabled: false },
    wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000 }, turn: { minSendGapMs: 0 }, toolPolicy: { mode: 'open' } }
  const adapters = accounts.map((account, index) => ({ id: `connection-${index}`, account, botUserId: account.id, botName: '提取验收机器人',
    isReady: () => ready.has(account.id),
    async start(accept) { accepts.set(account.id, accept); ready.add(account.id) }, stop() { ready.delete(account.id) },
    async readMessage(selected, messageId, guard) {
      if (guard?.isCurrent?.() === false) return undefined
      const row = sources.get(sourceKey(selected, messageId))
      return row && structuredClone(row.message)
    },
    async readMusicShare(selected, messageId, guard) {
      reads.push({ selected: structuredClone(selected), messageId, guard })
      await options.onRead?.(selected, messageId, guard, f)
      guard.signal.throwIfAborted()
      const row = sources.get(sourceKey(selected, messageId))
      if (!row?.share || !guard.isCurrent() || !await guard.allowsSource(row.message)) return undefined
      return structuredClone(row)
    },
    actions: {
      async sendAudioFile(action, guard) { return deliver('file', action, guard, uploaded(`file-${calls.length + 1}`)) },
      async sendBundle(action, guard) { return deliver('introBundle', action, guard, sent(`bundle-${calls.length + 1}`)) },
      async sendMedia(action, guard) { return deliver('preview', action, guard, sent(`preview-${calls.length + 1}`)) },
      async send(action, guard) {
        const text = action.parts.filter(part => part.kind === 'text').map(part => part.text).join('')
        const stage = /已清空|已禁用|已启用/u.test(text) ? 'privacy' : text.startsWith('网易云音乐') ? 'introText' : 'failureText'
        return deliver(stage, action, guard, sent(`text-${calls.length + 1}`))
      },
    },
  }))
  async function deliver(stage, action, guard, receipt) {
    assert.equal(guard.isCurrent(), true)
    assert.equal(guard.signal?.aborted ?? false, false)
    const row = { stage, action: structuredClone(action), guard }
    calls.push(row)
    const result = options.receipts?.[stage] ?? receipt
    if (options.deliver) return options.deliver(stage, action, guard, f, result)
    return result
  }
  function makeHost() {
    return createAgentRuntime({ storage, adapters, isExecutionCurrent: redis.isCurrent, now: () => now,
      privateChatEnabled: true, useTextGroup: () => options.mode === 'text',
      history: { enabled: true, retentionDays: 30, maxMessagesPerConversation: 1000 },
      musicExtraction: { enabled: true, operators: [sender] },
      ...(options.isMusicExtractionCurrent ? { isMusicExtractionCurrent: options.isMusicExtractionCurrent } : {}),
      musicExtractionProvider: { async prepare(selected, context) {
        contexts.push({ share: structuredClone(selected), context })
        return options.prepare ? options.prepare(selected, context, f) : structuredClone(prepared)
      } },
      ...(options.allowsText ? { allowsText: options.allowsText } : {}),
      logger: { info() {}, warn(...args) { diagnostics.push(args.map(String).join(' ')) }, error(...args) { diagnostics.push(args.map(String).join(' ')) } },
      getSection: () => section, getExecutionConfig: () => ({ providers: 'openai', useTools: true }),
      resolvePersona(selected) { const binding = directory.resolve(selected); return binding && { binding, persona: { name: '提取角色' }, systemContent: '' } },
      async YTapi(request) { requests.push(structuredClone(request)); return { choices: [{ message: { content: '', tool_calls: [{ id: 'finish', type: 'function', function: {
        name: 'simFinishTurn', arguments: JSON.stringify({ choice: 'silent', reason: '模型不应处理音乐提取入口' }),
      } }] } }] } },
    })
  }
  const message = (overrides = {}) => ({ version: 1, conversation: target, sender, messageId: 'music-source', occurredAt: now,
    text: '', parts: [{ kind: 'extension', platform: target.account.platform, type: 'music' }], mentions: [], directedToAccount: false, ...overrides })
  const f = { ...redis, target, targets, privateTarget, accounts, sender, now, calls, requests, contexts, reads, diagnostics, ledger, message,
    get host() { return host },
    binding(selected = target) { return directory.resolve(selected) },
    store(incoming, selectedShare = share) { sources.set(sourceKey(incoming.conversation, incoming.messageId), { message: structuredClone(incoming), ...(selectedShare ? { share: structuredClone(selectedShare) } : {}) }); return incoming },
    async emit(incoming, selectedShare = share) {
      f.store(incoming, selectedShare)
      await accepts.get(incoming.conversation.account.id)({ kind: 'message', message: structuredClone(incoming) })
    },
    async recall(messageId, selected = target) { await accepts.get(selected.account.id)({ kind: 'recall', target: selected, messageId }) },
    async drain() {
      await waitFor(async () => {
        for (const key of await reader.keys(prefix + 'agent:inbox:*')) if (await reader.type(key) === 'list' && await reader.lLen(key)) return false
        return true
      }, () => `music extraction inbox drains: ${JSON.stringify(diagnostics)}`)
      await host.runtime.drain()
    },
    async record(trigger = 'music-source', captured = directory.resolve(target)) { return ledger.inspect(captured, trigger) },
    async restart(restore) { await host.stop(); await restore?.(); host = makeHost(); await host.start() },
    rebind() { directory = createAgentBindingDirectory({ ...config, bindings: config.bindings.map(row => row.connectionId === 'connection-0' && row.kind === target.kind ? { ...row, agentId: 'replacement' } : row) }, 'extraction-rebound') },
    async assertPrivate() {
      assert.equal(requests.length, 0, 'deterministic extraction consumes the message before any model prompt')
      const rows = []
      for (const key of await reader.keys(prefix + '*')) {
        const type = await reader.type(key)
        if (type === 'string') rows.push(await reader.get(key))
        else if (type === 'list') rows.push(...await reader.lRange(key, 0, -1))
        else if (type === 'hash') rows.push(JSON.stringify(await reader.hGetAll(key)))
        else if (type === 'set') rows.push(...await reader.sMembers(key))
        else if (type === 'zset') rows.push(JSON.stringify(await reader.zRangeWithScores(key, 0, -1)))
        else assert.equal(type, 'none', `inspect every stored type: ${type}`)
      }
      const persisted = rows.join('\n')
      for (const value of [privateUrl, base64, 'PRIVATE_AUDIO_SOURCE_TOKEN', '合成音频标题', '合成完整音频.mp3']) assert.ok(!persisted.includes(value), 'provider references, complete bytes and relay metadata never enter conversation stores')
      for (const value of [privateUrl, base64]) assert.ok(!diagnostics.join('\n').includes(value))
    },
  }
  host = makeHost()
  t.after(async () => { options.release?.(); await host.stop() })
  await host.start()
  return f
}

for (const mode of ['simulation', 'text', 'private']) test(`Core ${mode} music extraction uploads complete bytes, sends introduction then preview before model or history capture`, redisTest, async t => {
  const f = await fixture(t, { mode })
  let incoming = f.message()
  if (mode === 'simulation') incoming = f.message({ parts: [{ kind: 'extension', platform: f.target.account.platform, type: 'json' }] })
  if (mode === 'private') {
    const source = f.store(f.message({ messageId: 'quoted-music' }))
    incoming = f.message({ messageId: 'extract-command', text: '.音乐提取', parts: [{ kind: 'text', text: '.音乐提取' }],
      quote: { messageId: source.messageId, parts: [] } })
  }
  await f.emit(incoming, mode === 'private' ? null : share); await f.drain()
  assert.deepEqual(f.calls.map(row => row.stage), ['file', 'introBundle', 'preview'])
  const file = f.calls[0].action
  assert.equal(file.kind, 'audio-file.upload'); assert.deepEqual(file.attachment, prepared.attachment)
  assert.equal(f.calls[2].action.media.kind, 'audio'); assert.equal(f.calls[2].action.media.base64, base64)
  for (const { action } of f.calls) { assert.deepEqual(action.target, f.target); assert.deepEqual(action.binding, f.binding()) }
  assert.match(f.calls[1].action.items[0].parts[0].text, /网易云音乐\n合成音频标题 - 合成作者/u)
  const record = await f.record(incoming.messageId)
  assert.equal(record.state, 'completed'); assert.equal(record.stages[0].receipt.state, 'uploaded')
  assert.ok(record.stages[0].receipt.fileId); assert.equal(record.stages[0].receipt.messageId, undefined)
  assert.deepEqual(record.stages.map(row => row.state), ['uploaded', 'sent', 'sent'])
  assert.ok(f.reads.length >= 4, 'the adapter rechecks the source between external stages')
  await f.assertPrivate()
})

test('a visible official link also enters deterministic extraction before conversation capture', redisTest, async t => {
  const f = await fixture(t), text = 'https://music.163.com/song?id=501'
  await f.emit(f.message({ text, parts: [{ kind: 'text', text }] })); await f.drain()
  assert.deepEqual(f.calls.map(row => row.stage), ['file', 'introBundle', 'preview'])
  assert.equal((await f.record()).state, 'completed'); await f.assertPrivate()
})

test('the dedicated complete-audio transport accepts a twenty MiB attachment beyond the generic twelve MiB file limit', redisTest, async t => {
  const bytes = Buffer.alloc(20 * 1024 * 1024); audioBytes.copy(bytes)
  const large = bytes.toString('base64')
  const f = await fixture(t, { prepare: async () => ({ ...prepared, attachment: { ...prepared.attachment, base64: large }, audio: { ...prepared.audio, base64: large } }) })
  await f.emit(f.message()); await f.drain()
  assert.deepEqual(f.calls.map(row => row.stage), ['file', 'introBundle', 'preview'])
  assert.equal(Buffer.from(f.calls[0].action.attachment.base64, 'base64').byteLength, 20 * 1024 * 1024)
  assert.equal((await f.record()).state, 'completed')
  await f.assertPrivate()
})

test('an unknown receipt at any stage freezes the workflow with no retry, alternate upload or later delivery', redisTest, async t => {
  for (const [stage, expected, receipts] of [
    ['file', ['file'], {}], ['introBundle', ['file', 'introBundle'], {}],
    ['introText', ['file', 'introBundle', 'introText'], { introBundle: { state: 'failed', code: 'explicit_bundle_failure' } }],
    ['preview', ['file', 'introBundle', 'preview'], {}],
    ['failureText', ['file', 'preview', 'failureText'], { file: { state: 'failed', code: 'explicit_upload_failure' } }],
  ]) await t.test(stage, async t => {
    let replay
    const f = await fixture(t, { receipts: { ...receipts, [stage]: { state: 'unknown' } },
      async deliver(_stage, _action, _guard, f, receipt) {
        if (!replay) replay = await f.reader.lIndex(f.prefix + `agent:inbox:simulation:${platformAccountKey(f.accounts[0])}`, 0)
        return receipt
      } })
    await f.emit(f.message()); await f.drain()
    assert.deepEqual(f.calls.map(row => row.stage), expected)
    assert.equal((await f.record()).state, 'unknown')
    await f.emit(f.message()); await f.drain()
    assert.ok(replay)
    await f.restart(async () => { await f.reader.rPush(f.prefix + `agent:inbox:simulation:${platformAccountKey(f.accounts[0])}`, replay) })
    await f.emit(f.message()); await f.drain()
    assert.deepEqual(f.calls.map(row => row.stage), expected, 'duplicate reports and restart must not repeat unknown effects')
    assert.equal(f.contexts.length, 1); await f.assertPrivate()
  })
})

test('a definite file failure sends one playable preview and explicit failure text without another upload', redisTest, async t => {
  const f = await fixture(t, { receipts: { file: { state: 'failed', code: 'explicit_upload_failure' } } })
  await f.emit(f.message()); await f.drain()
  assert.deepEqual(f.calls.map(row => row.stage), ['file', 'preview', 'failureText'])
  assert.match(f.calls[2].action.parts[0].text, /可下载文件发送失败/u)
  assert.equal((await f.record()).state, 'failed'); await f.assertPrivate()
})

test('a definite bundle failure falls back to text once and then sends the preview', redisTest, async t => {
  const f = await fixture(t, { receipts: { introBundle: { state: 'failed', code: 'explicit_bundle_failure' } } })
  await f.emit(f.message()); await f.drain()
  assert.deepEqual(f.calls.map(row => row.stage), ['file', 'introBundle', 'introText', 'preview'])
  assert.equal(f.calls[1].action.items[0].parts[0].text, f.calls[2].action.parts[0].text)
  assert.equal((await f.record()).state, 'completed'); await f.assertPrivate()
})

test('duplicate accepted shares survive host restart while different accounts and later binding requests remain independent', redisTest, async t => {
  let replay
  const f = await fixture(t, { async deliver(stage, _action, _guard, f, receipt) {
    if (!replay && stage === 'file') replay = await f.reader.lIndex(f.prefix + `agent:inbox:simulation:${platformAccountKey(f.accounts[0])}`, 0)
    return receipt
  } }), original = f.message(), initialBinding = f.binding()
  await f.emit(original); await f.drain()
  await Promise.all([f.emit(original), f.emit(original)]); await f.drain()
  assert.ok(replay, 'capture the real pending inbox row before its workflow commits')
  await f.restart(async () => { await f.reader.rPush(f.prefix + `agent:inbox:simulation:${platformAccountKey(f.accounts[0])}`, replay) })
  await f.emit(original); await f.drain()
  assert.equal(f.calls.filter(row => row.stage === 'file').length, 1); assert.equal(f.contexts.length, 1)
  const second = f.message({ conversation: f.targets[1], sender: { ...f.accounts[1], id: f.sender.id } })
  await f.emit(second); await f.drain()
  assert.equal(f.calls.filter(row => row.stage === 'file').length, 2)
  f.rebind()
  await f.emit(f.message({ messageId: 'next-binding-source' })); await f.drain()
  assert.equal(f.calls.filter(row => row.stage === 'file').length, 3)
  assert.equal((await f.record(original.messageId, initialBinding)).state, 'completed')
  assert.equal((await f.record('next-binding-source')).state, 'completed')
  const files = f.calls.filter(row => row.stage === 'file')
  assert.equal(files[0].action.target.account.id, f.accounts[0].id); assert.equal(files[1].action.target.account.id, f.accounts[1].id)
  assert.equal(files[2].action.binding.agentId, 'replacement'); await f.assertPrivate()
})

test('Core snapshots prepared attachment, preview and metadata before a source recheck can mutate the provider object', redisTest, async t => {
  const produced = structuredClone(prepared), replacement = Buffer.concat([audioBytes, Buffer.from('MUTATED_AFTER_PREPARATION')]).toString('base64')
  let mutated = false
  const f = await fixture(t, { prepare: async () => produced, onRead(_target, _messageId, _guard, f) {
    if (f.contexts.length && !mutated) {
      produced.attachment.base64 = replacement; produced.audio.base64 = replacement
      produced.attachment.name = '换掉的文件.mp3'; produced.title = '换掉的标题'; mutated = true
    }
  } })
  await f.emit(f.message()); await f.drain()
  assert.equal(mutated, true)
  assert.deepEqual(f.calls.map(row => row.stage), ['file', 'introBundle', 'preview'])
  assert.deepEqual(f.calls[0].action.attachment, prepared.attachment)
  assert.equal(f.calls[2].action.media.base64, base64)
  assert.match(f.calls[1].action.items[0].parts[0].text, /合成音频标题/u)
  assert.ok(!JSON.stringify(f.calls.map(row => row.action)).includes('换掉'))
  await f.assertPrivate()
})

test('a prepared file and preview with different complete bytes cause no native action', redisTest, async t => {
  const replacement = Buffer.concat([audioBytes, Buffer.from('DIFFERENT_PREVIEW_BYTES')]).toString('base64')
  const f = await fixture(t, { prepare: async () => ({ ...structuredClone(prepared), audio: { mime: 'audio/mpeg', base64: replacement } }) })
  await f.emit(f.message()); await f.drain()
  assert.deepEqual(f.calls, []); assert.equal((await f.record()).state, 'failed')
  await f.assertPrivate()
})

test('commands require the configured full operator identity and an explicit quoted share', redisTest, async t => {
  const f = await fixture(t, { mode: 'private' })
  const noQuote = f.message({ messageId: 'command-without-quote', text: '.音乐提取', parts: [{ kind: 'text', text: '.音乐提取' }] })
  await f.emit(noQuote, null); await f.drain()
  assert.deepEqual(f.calls.map(row => row.stage), ['failureText']); assert.match(f.calls[0].action.parts[0].text, /请引用/u)
  const source = f.store(f.message({ messageId: 'operator-source' }))
  // A group member sharing an operator ID in another namespace is not that operator.
  const wrongAccount = f.message({ conversation: f.targets[1], sender: { ...f.accounts[1], id: f.sender.id }, messageId: 'wrong-operator',
    text: '.音乐提取', parts: [{ kind: 'text', text: '.音乐提取' }], quote: { messageId: source.messageId, parts: [] } })
  await f.emit(wrongAccount, null); await f.drain()
  assert.equal(f.calls.length, 1); assert.equal(f.contexts.length, 0); await f.assertPrivate()
})

for (const invalidation of ['source-recall', 'command-recall', 'rebind', 'privacy']) test(`Core ${invalidation} during preparation aborts the provider and prevents all late music actions`, redisTest, async t => {
  const held = gate()
  const f = await fixture(t, { prepare: async () => { await held.promise; return structuredClone(prepared) }, release: held.release })
  const source = f.store(f.message({ messageId: 'held-source' })), binding = f.binding()
  const command = f.message({ messageId: 'held-command', text: '.音乐提取', parts: [{ kind: 'text', text: '.音乐提取' }], quote: { messageId: source.messageId, parts: [] } })
  await f.emit(command, null)
  await waitFor(() => f.contexts.length === 1, 'provider prepares a verified quoted share')
  const context = f.contexts[0].context
  if (invalidation === 'source-recall') await f.recall(source.messageId)
  else if (invalidation === 'command-recall') await f.recall(command.messageId)
  else if (invalidation === 'rebind') f.rebind()
  else await f.emit(f.message({ messageId: 'privacy-command', text: '#清空我的记忆', parts: [{ kind: 'text', text: '#清空我的记忆' }] }), null)
  await waitFor(() => context.signal.aborted, 'provider receives cancellation')
  assert.equal(context.isCurrent(), false)
  held.release(); await f.drain()
  assert.deepEqual(f.calls.filter(row => row.stage !== 'privacy'), [])
  const record = await f.record(command.messageId, binding)
  assert.equal(record.state, 'cancelled'); assert.equal(record.stages.length, 0)
  await f.assertPrivate()
})

test('revoking music extraction configuration during preparation cancels the provider and blocks every late native action', redisTest, async t => {
  const held = gate()
  let enabled = true
  const f = await fixture(t, { isMusicExtractionCurrent: () => enabled,
    prepare: async () => { await held.promise; return structuredClone(prepared) }, release: held.release })
  await f.emit(f.message())
  await waitFor(() => f.contexts.length === 1, 'provider starts under the captured configuration')
  const context = f.contexts[0].context
  assert.equal(context.isCurrent(), true)
  enabled = false
  await waitFor(() => context.signal.aborted, 'configuration revocation cancels the in-flight provider')
  assert.equal(context.isCurrent(), false)
  held.release(); await f.drain()
  assert.deepEqual(f.calls, [], 'a producer returning after configuration revocation cannot upload, introduce or preview music')
  const record = await f.record()
  assert.equal(record.state, 'cancelled'); assert.equal(record.stages.length, 0)
  await f.assertPrivate()
})
