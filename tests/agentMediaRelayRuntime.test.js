import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const load = name => import(pathToFileURL(path.join(release, 'dist/backend', name)).href)
const { createAgentRuntime, createAgentBindingDirectory } = await load('core/index.js')
const { conversationAddressKey, platformAccountKey, agentBindingToken } = await load('modules/runtime/domain/agentBindings.js')
const { createAgentInbox } = await load('modules/runtime/infrastructure/agentInbox.js')
const { connectAgentRedis, openAgentRedis, agentRedisPrefix } = await load('modules/runtime/infrastructure/agentRedis.js')
const { createAgentMediaOutboxLedger, agentMediaOutboxId } = await load('modules/media/infrastructure/agentMediaOutboxLedger.js')
const share = { provider: 'bilibili', reference: { kind: 'video', id: 'BV1H7Gq6zEiC' } }
const video = { id: '1'.repeat(32), kind: 'video', mime: 'video/mp4', sizeBytes: 64, sha256: '2'.repeat(64) }
const thumbnail = { id: '3'.repeat(32), kind: 'image', mime: 'image/jpeg', sizeBytes: 16, sha256: '4'.repeat(64) }
const plan = { version: 1, items: [{ parts: [{ kind: 'image', artifact: thumbnail }] }, { parts: [{ kind: 'video', artifact: video, thumbnail }] }] }
const youtubePlan = { version: 1, items: [{ parts: [{ kind: 'text', text: '合成搬运视频介绍' }] }, plan.items[1]] }
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve }); return { promise, release } }
async function waitFor(probe, label, timeout = 7000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const result = await probe(); if (result) return result; await delay(15) }
  assert.fail(`timed out: ${label}`)
}

async function fixture(t, settings = {}) {
  const selectedShare = settings.share ?? share
  const selectedPage = selectedShare.provider === 'xiaohongshu' ? `https://www.xiaohongshu.com/explore/${selectedShare.reference.id}`
    : selectedShare.provider === 'douyin' ? `https://www.douyin.com/${selectedShare.reference.kind}/${selectedShare.reference.id}`
    : selectedShare.provider === 'youtube' ? `https://www.youtube.com/watch?v=${selectedShare.reference.id}`
    : selectedShare.provider === 'pixiv' ? `https://www.pixiv.net/artworks/${selectedShare.reference.id}`
    : `https://www.bilibili.com/video/${selectedShare.reference.id}`
  assert.equal(spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status, 0, 'Core workflow proof requires Redis')
  const directory = await mkdtemp(path.join(tmpdir(), 'core-media-relay-')), socket = path.join(directory, 'redis.sock')
  const server = spawn('redis-server', ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  const exited = once(server, 'exit')
  let reader, connection, host
  t.after(async () => {
    settings.release?.(); await host?.stop(); await connection?.close(); if (reader?.isOpen) await reader.close()
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM')
    await exited; await rm(directory, { recursive: true, force: true })
  })
  await waitFor(() => stat(socket).then(() => true, () => false), 'Redis ready')
  reader = await connectAgentRedis(`unix://${socket}`)
  connection = await openAgentRedis({ url: `unix://${socket}`, instance: 'media-runtime', onLost() {} })
  const prefix = agentRedisPrefix('media-runtime'), { storage } = connection, now = Date.now()
  const accounts = ['robot-a', 'robot-b'].map((id, index) => ({ platform: 'fixture', namespace: settings.siblings ? 'same' : `ns-${index}`, id }))
  const targets = accounts.map(account => ({ account, kind: 'group', id: 'room' }))
  const sender = { ...accounts[0], id: 'human' }, privateTarget = { account: accounts[0], kind: 'private', id: sender.id }
  const target = settings.private ? privateTarget : targets[0]
  const config = { version: 1, agents: [{ id: 'role', personaId: 'default' }, { id: 'replacement', personaId: 'default' }],
    connections: accounts.map((account, index) => ({ id: `conn-${index}`, platform: account.platform, namespace: account.namespace, accountId: account.id })),
    bindings: [...targets.map((selected, index) => ({ connectionId: `conn-${index}`, kind: 'group', conversationId: selected.id, agentId: 'role' })),
      { connectionId: 'conn-0', kind: 'private', conversationId: privateTarget.id, agentId: 'role' }] }
  let bindings = createAgentBindingDirectory(config, 'media-initial'), current = true, enabled = true, releases = 0
  const accepts = new Map(), ready = new Set(), sources = new Map(), calls = [], preparations = [], reads = [], requests = [], logs = []
  const sourceKey = (selected, id) => JSON.stringify([conversationAddressKey(selected), id])
  const ledger = createAgentMediaOutboxLedger(storage)
  const section = { enabled: true, reflection: { enabled: false }, rhythm: { enabled: false }, mood: { enabled: false },
    personProfile: { enabled: false }, meme: { enabled: false }, userStyle: { enabled: false }, lifeThreads: { enabled: false },
    wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000 }, turn: { minSendGapMs: 0 }, toolPolicy: { mode: 'open' } }
  const adapters = accounts.map((account, index) => ({ id: `conn-${index}`, account, botUserId: account.id, botName: '搬运验收机器人',
    isReady: () => ready.has(account.id), async start(accept) { ready.add(account.id); accepts.set(account.id, accept) }, stop() { ready.delete(account.id) },
    async readMessage(selected, id, guard) { if (guard?.isCurrent?.() === false) return; return structuredClone(sources.get(sourceKey(selected, id))?.message) },
    async readMediaShare(selected, id, guard) {
      reads.push({ selected, id, guard }); await settings.read?.(selected, id, guard, f)
      guard.signal.throwIfAborted()
      const row = sources.get(sourceKey(selected, id))
      if (row && guard.isCurrent() && await guard.allowsSource(row.message)) return structuredClone(row)
    },
    actions: {
      async sendMediaRelay(action, guard) { return deliver(action.mode === 'forward' ? 'forward' : 'directVideo', action, guard) },
      async send(action, guard) { return deliver('text', action, guard) },
    },
  }))
  async function deliver(stage, action, guard) {
    assert.equal(guard.isCurrent(), true)
    const record = await ledger.inspect(agentMediaOutboxId(action.binding, 'source'))
    if (record?.effects.length) assert.equal(record.effects.at(-1)?.state, 'pending', 'durable marker precedes native effect')
    calls.push({ stage, action: structuredClone(action), guard })
    return settings.deliver ? settings.deliver(stage, action, guard, f) : { state: 'sent', messageId: `sent-${calls.length}` }
  }
  function makeHost() {
    return createAgentRuntime({ storage, adapters, now: () => now, isExecutionCurrent: () => connection.isCurrent() && current,
      privateChatEnabled: true, useTextGroup: () => settings.mode === 'text', history: { enabled: true, retentionDays: 30, maxMessagesPerConversation: 1000 },
      mediaRelay: { enabled: settings.enabled !== false, ...(settings.providers ? { providers: settings.providers } : {}) }, isMediaRelayCurrent: () => enabled,
      mediaRelayProvider: { async prepare(selected, context) {
        preparations.push({ selected: structuredClone(selected), context })
        if (settings.prepare) return settings.prepare(selected, context, f)
        return { status: 'ready', pageUrl: selectedPage, infoText: '合成搬运视频介绍', plan: structuredClone(settings.plan ?? (selectedShare.provider === 'youtube' ? youtubePlan : plan)), async release() { releases++ } }
      } },
      ...(settings.allowsText ? { allowsText: settings.allowsText } : {}),
      logger: { info() {}, warn(...args) { logs.push(args.map(String).join(' ')) }, error(...args) { logs.push(args.map(String).join(' ')) } },
      getSection: () => section, getExecutionConfig: () => ({ providers: 'openai', useTools: true }),
      resolvePersona(selected) { const binding = bindings.resolve(selected); return binding && { binding, persona: { name: '搬运角色' }, systemContent: '' } },
      async YTapi(request) { requests.push(request); return { choices: [{ message: { content: '' } }] } },
    })
  }
  const f = { accounts, targets, target, sender, now, storage, reader, prefix, ledger, calls, preparations, reads, requests, logs,
    get host() { return host }, get releases() { return releases }, ready,
    binding(selected = target) { return bindings.resolve(selected) },
    message(overrides = {}) { return { version: 1, conversation: target, sender, messageId: 'source', occurredAt: now,
      text: selectedPage, parts: [{ kind: 'extension', platform: target.account.platform, type: 'json' }], mentions: [], directedToAccount: false, ...overrides } },
    store(message, selected = selectedShare, access = settings.access) { sources.set(sourceKey(message.conversation, message.messageId), { message: structuredClone(message), share: structuredClone(selected), ...(access ? { access: structuredClone(access) } : {}) }); return message },
    async emit(message = f.message(), selected = selectedShare) { f.store(message, selected); await accepts.get(message.conversation.account.id)({ kind: 'message', message: structuredClone(message) }) },
    async recall(id = 'source', selected = target) { await accepts.get(selected.account.id)({ kind: 'recall', target: selected, messageId: id }) },
    async record(id = 'source', binding = f.binding()) { return ledger.inspect(agentMediaOutboxId(binding, id)) },
    async drain() { await waitFor(async () => {
      for (const key of await reader.keys(prefix + 'agent:inbox:*')) if (await reader.type(key) === 'list' && await reader.lLen(key)) return false
      return true
    }, 'inbox ACK'); await host.runtime.drain() },
    async terminal(id = 'source', binding = f.binding()) { return waitFor(async () => { const record = await f.record(id, binding); return record && ['completed', 'failed', 'cancelled', 'unknown'].includes(record.state) && record }, `terminal ${id}`) },
    rebind() { bindings = createAgentBindingDirectory({ ...config, bindings: config.bindings.map(row => row.connectionId === 'conn-0' ? { ...row, agentId: 'replacement' } : row) }, 'media-rebound') },
    setCurrent(value) { current = value }, setEnabled(value) { enabled = value },
    async restart() { await host.stop(); host = makeHost(); await host.start() },
    async assertPrivate() {
      assert.equal(requests.length, 0, 'accepted relay bypasses all models')
      const stored = []
      for (const key of await reader.keys(prefix + '*')) {
        const type = await reader.type(key)
        if (type === 'string') stored.push(await reader.get(key))
        else if (type === 'list') stored.push(...await reader.lRange(key, 0, -1))
        else if (type === 'hash') stored.push(JSON.stringify(await reader.hGetAll(key)))
        else if (type === 'zset') stored.push(JSON.stringify(await reader.zRangeWithScores(key, 0, -1)))
        else if (type === 'set') stored.push(...await reader.sMembers(key))
        else assert.equal(type, 'none')
      }
      const raw = stored.join('\n')
      for (const value of settings.forbidden ?? []) assert.ok(!raw.includes(value), 'ephemeral source access never persists')
      for (const value of ['合成搬运视频介绍', video.id, video.sha256, thumbnail.id]) assert.ok(!raw.includes(value), 'plans and artifacts stay out of durable conversation/queue records')
    },
  }
  if (settings.queued) await ledger.enqueue({ binding: f.binding(), source: {
    messageId: 'source', sender, occurredAt: now, share: selectedShare,
  } })
  await settings.beforeStart?.(f)
  host = makeHost(); await host.start(); return f
}

for (const mode of ['simulation', 'text']) test(`Core ${mode} group relay persists before ACK and delivers neutral plans outside model/history`, { timeout: 20000 }, async t => {
  const f = await fixture(t, { mode }); await f.emit(f.message({ text: '' })); await f.drain()
  assert.equal((await f.terminal()).state, 'completed')
  assert.deepEqual(f.calls.map(row => row.stage), ['forward']); assert.deepEqual(f.calls[0].action.plan, plan)
  assert.deepEqual(f.calls[0].action.binding, f.binding()); assert.deepEqual(f.calls[0].action.target, f.target)
  assert.ok(f.reads.length >= 4); assert.deepEqual(f.reads[0].guard.expectedSource, { author: f.sender, occurredAt: f.now })
  await waitFor(() => f.releases === 1, 'prepared lease released'); await f.assertPrivate()
  await f.emit(); await f.drain(); await f.restart(); await f.emit(); await f.drain()
  assert.equal(f.preparations.length, 1); assert.equal(f.calls.length, 1)
})

test('Core unknown native receipt survives duplicate input and host restart without another effect', { timeout: 20000 }, async t => {
  const f = await fixture(t, { deliver: async () => ({ state: 'unknown' }) })
  await f.emit(); await f.drain(); assert.equal((await f.terminal()).state, 'unknown')
  await f.emit(); await f.drain(); await f.restart(); await f.emit(); await f.drain()
  assert.equal(f.calls.length, 1); assert.equal(f.preparations.length, 1); await f.assertPrivate()
})

const douyinShare = { provider: 'douyin', reference: { kind: 'note', id: '7482233445566778899' } }
const youtubeShare = { provider: 'youtube', reference: { kind: 'video', id: 'AbC_123-xYz' } }
const pixivShare = { provider: 'pixiv', reference: { kind: 'artwork', id: '123456789' } }
const image = { id: '5'.repeat(32), kind: 'image', mime: 'image/png', sizeBytes: 32, sha256: '6'.repeat(64) }
const gallery = { version: 1, items: [{ parts: [{ kind: 'text', text: '合成抖音图集' }] }, { parts: [{ kind: 'image', artifact: image }] }] }
const douyinGallery = { version: 1, items: [{ parts: [{ kind: 'image', artifact: thumbnail }] }, gallery.items[1]] }
const xhsShare = { provider: 'xiaohongshu', reference: { kind: 'note', id: '66aabbccddeeff0011223344' } }
const xhsPage = `https://www.xiaohongshu.com/explore/${xhsShare.reference.id}`
for (const mode of ['simulation', 'text']) test(`Core ${mode} persists safe Xiaohongshu references while refreshing ephemeral access from the exact original source`, { timeout: 20000 }, async t => {
  const secret = 'XHS_EPHEMERAL_FIRST=', updated = 'XHS_EPHEMERAL_NEXT='
  const sourceText = `${xhsPage}?xsec_token=${encodeURIComponent(secret)}&xsec_source=app_share&type=normal`
  const rawChecks = [], accessReads = []
  const f = await fixture(t, { mode, share: xhsShare, providers: ['xiaohongshu'], access: { provider: 'xiaohongshu', xsecToken: secret, mediaKind: 'image' },
    forbidden: [secret, updated, 'xsec_token', 'xsec_source'],
    allowsText(text, direction) { if (direction === 'incoming') rawChecks.push(text); return true },
    async prepare(selected, context, f) {
      assert.deepEqual(selected, xhsShare)
      assert.equal(context.readSource, undefined, 'provider cannot read source text or native messages')
      accessReads.push(await context.readSourceAccess())
      f.store(f.message({ text: `${xhsPage}?xsec_token=${encodeURIComponent(updated)}`, parts: [{ kind: 'text', text: sourceText }] }), xhsShare,
        { provider: 'xiaohongshu', xsecToken: updated, mediaKind: 'image' })
      accessReads.push(await context.readSourceAccess())
      return { status: 'ready', infoText: '合成小红书', pageUrl: xhsPage, plan: gallery, async release() {} }
    } })
  await f.emit(f.message({ text: sourceText, senderName: sourceText, parts: [{ kind: 'text', text: sourceText }],
    quote: { messageId: 'quoted', text: sourceText, parts: [{ kind: 'text', text: sourceText }] } }))
  f.ready.delete(f.target.account.id)
  await delay(100)
  assert.equal(f.preparations.length, 0)
  await f.assertPrivate()
  f.ready.add(f.target.account.id)
  await f.drain(); assert.equal((await f.terminal()).state, 'completed')
  assert.deepEqual(accessReads.map(value => value.xsecToken), [secret, updated])
  assert.ok(rawChecks.some(text => text.includes(secret) || text.includes(encodeURIComponent(secret))), 'source policy sees original access-bearing text')
  assert.equal(f.calls.length, 1); await f.assertPrivate()
})

test('restored Xiaohongshu v1 work stays cancelled under Bilibili-only activation', { timeout: 20000 }, async t => {
  const f = await fixture(t, { share: xhsShare, queued: true })
  assert.equal((await f.terminal()).state, 'cancelled')
  assert.equal(f.preparations.length, 0); assert.equal(f.calls.length, 0); assert.equal(f.reads.length, 0)
})

for (const mode of ['simulation', 'text']) test(`Core ${mode} removes Xiaohongshu access from ordinary history even when media relay is disabled`, { timeout: 20000 }, async t => {
  const text = `一条普通分享 ${xhsPage}?xsec_token=XHS_HISTORY_ACCESS%3D&xsec_source=app_share&type=normal`
  const f = await fixture(t, { mode, enabled: false, share: xhsShare, forbidden: ['XHS_HISTORY_ACCESS', 'xsec_token', 'xsec_source'] })
  await f.emit(f.message({ text, parts: [{ kind: 'text', text }] })); await f.drain()
  assert.equal(f.preparations.length, 0); assert.equal(f.calls.length, 0)
  await f.assertPrivate()
})

test('recovered pre-upgrade inbox keeps exact ACK identity while removing source access from new history', { timeout: 20000 }, async t => {
  const text = `旧积压 ${xhsPage}?xsec_token=XHS_OLD_QUEUE_ACCESS%3D&type=normal`
  const f = await fixture(t, { enabled: false, share: xhsShare, forbidden: ['XHS_OLD_QUEUE_ACCESS', 'xsec_token'],
    async beforeStart(f) {
      const inbox = createAgentInbox(f.storage)
      await inbox.accept({ event: { kind: 'message', message: f.message({ text, senderName: text, parts: [{ kind: 'text', text }] }) },
        bindingToken: agentBindingToken(f.binding()) })
    } })
  await f.drain(); assert.equal(f.preparations.length, 0); assert.equal(f.calls.length, 0); await f.assertPrivate()
})

test('Xiaohongshu unknown forward survives restart without a fallback or another native effect', { timeout: 20000 }, async t => {
  const f = await fixture(t, { share: xhsShare, providers: ['xiaohongshu'], plan: gallery, deliver: async () => ({ state: 'unknown' }) })
  await f.emit(f.message({ text: '', parts: [{ kind: 'extension', platform: 'fixture', type: 'xiaohongshu' }] })); await f.drain()
  assert.equal((await f.terminal()).state, 'unknown')
  await f.restart(); await f.emit(); await f.drain()
  assert.equal(f.calls.length, 1); assert.equal(f.preparations.length, 1); await f.assertPrivate()
})

for (const mode of ['simulation', 'text']) test(`Core ${mode} routes verified Douyin gallery through the same neutral outbox with no model`, { timeout: 20000 }, async t => {
  const f = await fixture(t, { mode, share: douyinShare, providers: ['bilibili', 'douyin'], plan: douyinGallery })
  await f.emit(f.message({ text: '', parts: [{ kind: 'extension', platform: 'fixture', type: 'douyin' }] })); await f.drain()
  assert.equal((await f.terminal()).state, 'completed')
  assert.deepEqual(f.preparations[0].selected, douyinShare); assert.deepEqual(f.calls.map(row => row.stage), ['forward'])
  assert.deepEqual(f.calls[0].action.plan, douyinGallery); await f.assertPrivate()
  await f.emit(); await f.drain(); await f.restart(); await f.emit(); await f.drain()
  assert.equal(f.calls.length, 1)
})

test('existing Bilibili-only activation does not enqueue or prepare a Douyin JSON reference', { timeout: 20000 }, async t => {
  const f = await fixture(t, { share: douyinShare })
  await f.emit(); await f.drain()
  assert.equal(await f.record(), undefined); assert.equal(f.preparations.length, 0); assert.equal(f.calls.length, 0)
})

test('a persisted queued Douyin v1 record is cancelled under old Bilibili-only activation without a fallback link', { timeout: 20000 }, async t => {
  const f = await fixture(t, { share: douyinShare, queued: true })
  assert.equal((await f.terminal()).state, 'cancelled')
  assert.equal(f.preparations.length, 0); assert.equal(f.calls.length, 0); assert.equal(f.reads.length, 0)
  await f.assertPrivate()
})

test('removing only Douyin provider permission aborts preparation while global relay remains enabled', { timeout: 20000 }, async t => {
  const hold = gate(), providers = ['bilibili', 'douyin']; let released = 0
  const f = await fixture(t, { share: douyinShare, providers, release: hold.release, async prepare() {
    await hold.promise
    return { status: 'ready', infoText: '合成抖音图集', pageUrl: `https://www.douyin.com/note/${douyinShare.reference.id}`, plan: gallery,
      async release() { released++ } }
  } })
  await f.emit(); await f.drain(); await waitFor(() => f.preparations.length, 'Douyin preparation')
  providers.splice(providers.indexOf('douyin'), 1)
  await waitFor(() => f.preparations[0].context.signal.aborted, 'provider permission revoked')
  hold.release(); await waitFor(() => released === 1, 'revoked late gallery release')
  assert.equal((await f.terminal()).state, 'cancelled'); assert.equal(f.calls.length, 0)
})

test('Douyin unknown forward cannot emit links or repeat after restart', { timeout: 20000 }, async t => {
  const f = await fixture(t, { share: douyinShare, providers: ['douyin'], plan: douyinGallery, deliver: async () => ({ state: 'unknown' }) })
  await f.emit(); await f.drain(); assert.equal((await f.terminal()).state, 'unknown')
  await f.restart(); await f.emit(); await f.drain(); assert.equal(f.calls.length, 1); await f.assertPrivate()
})

for (const selectedShare of [youtubeShare, pixivShare]) for (const mode of ['simulation', 'text']) for (const native of [false, true]) test(`Core ${mode} routes verified ${selectedShare.provider} ${native ? 'native' : 'text'} shares without a model`, { timeout: 20000 }, async t => {
  const f = await fixture(t, { mode, share: selectedShare, providers: [selectedShare.provider], ...(selectedShare.provider === 'pixiv' ? { plan: gallery } : {}) })
  const youtube = selectedShare.provider === 'youtube'
  const text = youtube ? 'https://youtu.be/AbC_123-xYz' : `https://www.pixiv.net/artworks/${selectedShare.reference.id}`
  await f.emit(f.message(native ? { text: '', parts: [{ kind: 'extension', platform: 'fixture', type: selectedShare.provider }] } : { parts: [{ kind: 'text', text }] }))
  await f.drain(); assert.equal((await f.terminal()).state, 'completed')
  const expectedModes = youtube ? ['direct-video', 'direct-video'] : ['forward']
  assert.deepEqual(f.preparations[0].selected, selectedShare)
  assert.deepEqual(f.calls.map(row => row.action.mode), expectedModes)
  if (youtube) assert.deepEqual(f.calls.map(row => row.action.plan.items.flatMap(item => item.parts.map(part => part.kind))), [['text'], ['video']])
  await f.emit(); await f.drain(); await f.restart(); await f.emit(); await f.drain()
  assert.equal(f.calls.length, expectedModes.length); await f.assertPrivate()
})

for (const selectedShare of [youtubeShare, pixivShare]) for (const queued of [false, true]) test(`${selectedShare.provider} remains disabled under the original Bilibili-only activation (${queued ? 'persisted' : 'new'})`, { timeout: 20000 }, async t => {
  const f = await fixture(t, { share: selectedShare, queued })
  if (queued) assert.equal((await f.terminal()).state, 'cancelled')
  else { await f.emit(); await f.drain(); assert.equal(await f.record(), undefined) }
  assert.equal(f.preparations.length, 0); assert.equal(f.calls.length, 0); await f.assertPrivate()
})

for (const selectedShare of [douyinShare, xhsShare, youtubeShare, pixivShare]) for (const invalidation of ['recall', 'rebind', 'disable', 'lease', 'privacy']) test(`Core ${selectedShare.provider} ${invalidation} aborts preparation and releases late gallery`, { timeout: 20000 }, async t => {
  const hold = gate(); let released = 0
  const f = await fixture(t, { share: selectedShare, providers: [selectedShare.provider], release: hold.release, async prepare() {
    await hold.promise
    return { status: 'ready', infoText: '合成媒体图集', pageUrl: selectedShare.provider === 'douyin' ? `https://www.douyin.com/note/${douyinShare.reference.id}` : selectedShare.provider === 'youtube' ? 'https://www.youtube.com/watch?v=AbC_123-xYz' : selectedShare.provider === 'pixiv' ? `https://www.pixiv.net/artworks/${selectedShare.reference.id}` : xhsPage, plan: gallery,
      async release() { released++ } }
  } })
  const binding = f.binding(); await f.emit(); await f.drain(); await waitFor(() => f.preparations.length, 'Douyin preparation')
  if (invalidation === 'recall') await f.recall()
  else if (invalidation === 'rebind') f.rebind()
  else if (invalidation === 'disable') f.setEnabled(false)
  else if (invalidation === 'privacy') await f.emit(f.message({ messageId: 'clear-person', text: '#清空我的记忆', parts: [{ kind: 'text', text: '#清空我的记忆' }] }))
  else f.setCurrent(false)
  await waitFor(() => f.preparations[0].context.signal.aborted, 'provider cancellation')
  hold.release(); await waitFor(() => released === 1, 'late gallery release')
  assert.equal(f.calls.filter(row => row.stage === 'forward' || row.stage === 'directVideo').length, 0)
  if (invalidation !== 'lease') assert.equal((await f.terminal('source', binding)).state, 'cancelled')
})

test('Core keeps a disconnected media source in the inbox until its exact account reconnects', { timeout: 20000 }, async t => {
  const f = await fixture(t)
  await f.emit(); f.ready.delete(f.target.account.id); await delay(100)
  assert.equal(f.preparations.length, 0); assert.equal(await f.record(), undefined)
  const queues = await f.reader.keys(f.prefix + 'agent:inbox:simulation:*')
  let queued = 0
  for (const key of queues) if (await f.reader.type(key) === 'list') queued += await f.reader.lLen(key)
  assert.equal(queued, 1, 'no ACK before durable outbox acceptance')
  f.ready.add(f.target.account.id)
  await f.drain(); assert.equal((await f.terminal()).state, 'completed'); assert.equal(f.calls.length, 1)
})

test('disconnect during the initial verified source read does not consume the source as an ordinary model turn', { timeout: 20000 }, async t => {
  const f = await fixture(t, { async read(_target, _id, _guard, f) { if (f.reads.length === 1) f.ready.delete(f.target.account.id) } })
  await f.emit(); await waitFor(() => f.reads.length === 1, 'initial source read'); await delay(100)
  assert.equal(f.preparations.length, 0); assert.equal(f.requests.length, 0); assert.equal(await f.record(), undefined)
  f.ready.add(f.target.account.id)
  await f.drain(); assert.equal((await f.terminal()).state, 'completed'); assert.equal(f.calls.length, 1)
})

for (const invalidation of ['recall', 'rebind', 'disable', 'lease', 'privacy']) test(`Core ${invalidation} cancels an in-flight preparation before any native effect`, { timeout: 20000 }, async t => {
  const hold = gate(); let producedReleased = 0
  const f = await fixture(t, { release: hold.release, async prepare(_share, context) {
    await hold.promise
    return { status: 'ready', infoText: '取消后不应发送', pageUrl: `https://www.bilibili.com/video/${share.reference.id}`, plan,
      async release() { producedReleased++ } }
  } })
  const binding = f.binding(); await f.emit(); await f.drain(); await waitFor(() => f.preparations.length, 'preparation starts')
  if (invalidation === 'recall') await f.recall()
  else if (invalidation === 'rebind') f.rebind()
  else if (invalidation === 'disable') f.setEnabled(false)
  else if (invalidation === 'privacy') await f.emit(f.message({ messageId: 'clear-person', text: '#清空我的记忆', parts: [{ kind: 'text', text: '#清空我的记忆' }] }))
  else f.setCurrent(false)
  await waitFor(() => f.preparations[0].context.signal.aborted, 'provider cancelled')
  hold.release(); await waitFor(() => producedReleased === 1, 'late result released')
  assert.equal(f.calls.filter(call => call.stage === 'forward' || call.stage === 'directVideo').length, 0)
  if (invalidation !== 'lease') assert.equal((await f.terminal('source', binding)).state, 'cancelled')
})

test('Core rereads author, timestamp, share and source visibility before preparing', { timeout: 30000 }, async t => {
  for (const field of ['sender', 'occurredAt', 'share']) await t.test(field, async t => {
    const f = await fixture(t, { async read(_target, _id, _guard, f) {
      if (f.reads.length !== 2) return
      const changed = structuredClone(f.message())
      if (field === 'sender') changed.sender.id = 'substituted-human'
      if (field === 'occurredAt') changed.occurredAt--
      f.store(changed, field === 'share' ? { provider: 'bilibili', reference: { kind: 'video', id: 'BV1234567890' } } : share)
    } })
    await f.emit(); await f.drain(); assert.equal((await f.terminal()).state, 'cancelled')
    assert.equal(f.preparations.length, 0); assert.equal(f.calls.length, 0)
  })
})

test('a group with multiple same-namespace accounts elects one explicitly bound account, including multiple mentions', { timeout: 30000 }, async t => {
  for (const mentions of [[], ['robot-a'], ['robot-a', 'robot-b']]) await t.test(JSON.stringify(mentions), async t => {
    const f = await fixture(t, { siblings: true })
    for (const target of f.targets) await f.emit(f.message({ conversation: target, sender: { ...target.account, id: 'human' },
      mentions: mentions.map(id => ({ ...target.account, id })) }))
    await f.drain(); await waitFor(() => f.calls.length === 1, 'one elected sender')
    await delay(100); assert.equal(f.calls.length, 1); assert.equal(f.preparations.length, 1)
    if (mentions.length === 1) assert.equal(f.calls[0].action.target.account.id, mentions[0])
  })
})

for (const receipt of ['sent', 'unknown']) test(`a ${receipt} relay on one account cannot be repeated when a sibling becomes responsible after disconnect`, { timeout: 20000 }, async t => {
  const f = await fixture(t, { siblings: true, deliver: async () => receipt === 'sent' ? { state: 'sent', messageId: 'first-confirmed' } : { state: 'unknown' } })
  const key = `room:${f.accounts.map(account => account.id).sort().join(',')}`
  let hash = 2166136261
  for (let i = 0; i < key.length; i++) { hash ^= key.charCodeAt(i); hash = Math.imul(hash, 16777619) >>> 0 }
  const selected = f.targets[hash % f.targets.length], sibling = f.targets.find(target => target !== selected)
  const incoming = target => f.message({ conversation: target, sender: { ...target.account, id: 'human' } })
  await f.emit(incoming(selected)); await f.drain(); await f.terminal('source', f.binding(selected))
  f.ready.delete(selected.account.id)
  await f.emit(incoming(sibling)); await f.drain(); await delay(150)
  assert.equal(f.calls.length, 1); assert.equal(f.preparations.length, 1)
  assert.equal(await f.record('source', f.binding(sibling)), undefined)
})

test('a recall received by a sibling cancels the original account preparation and its late resources', { timeout: 20000 }, async t => {
  const hold = gate(); let released = 0
  const f = await fixture(t, { siblings: true, release: hold.release, async prepare() {
    await hold.promise
    return { status: 'ready', pageUrl: `https://www.bilibili.com/video/${share.reference.id}`, infoText: '共享撤回', plan, async release() { released++ } }
  } })
  await f.emit(f.message({ mentions: [f.accounts[0]] })); await f.drain(); await waitFor(() => f.preparations.length === 1, 'original prepare')
  await f.recall('source', f.targets[1]); await waitFor(() => f.preparations[0].context.signal.aborted, 'cross-account recall cancels provider')
  hold.release(); await waitFor(() => released === 1, 'late resources released')
  assert.equal(f.calls.length, 0); assert.equal((await f.terminal()).state, 'cancelled')
})

test('Core does not relay sibling bot messages or private Bilibili shares', { timeout: 20000 }, async t => {
  const f = await fixture(t, { siblings: true })
  await f.emit(f.message({ sender: f.accounts[1] })); await f.drain()
  await f.emit(f.message({ conversation: { account: f.accounts[0], kind: 'private', id: f.sender.id }, messageId: 'private-source' })); await f.drain()
  assert.equal(f.preparations.length, 0); assert.equal(f.calls.filter(call => call.stage === 'forward').length, 0)
})

test('Core leaves media storage untouched when media relay is disabled', { timeout: 20000 }, async t => {
  const f = await fixture(t, { enabled: false })
  await f.emit(); await f.drain(); await f.recall(); await delay(100)
  assert.deepEqual(await f.reader.keys(f.prefix + 'agent:media-outbox:*'), [])
  assert.equal(f.preparations.length, 0)
})

test('Core rejects enabled relay without a provider before starting adapters or Redis work', () => {
  assert.throws(() => createAgentRuntime({ mediaRelay: { enabled: true } }), /媒体提供器/u)
})
