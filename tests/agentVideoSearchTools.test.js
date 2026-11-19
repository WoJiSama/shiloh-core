import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'
const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const load = name => import(pathToFileURL(path.join(release, 'dist/backend', name)).href)
const { createAgentVideoSearchTools } = await importBilibiliHost('modules/media/infrastructure/agentVideoSearchTools.js')
const { createAgentVideoSearchStore } = await importBilibiliHost('modules/media/infrastructure/agentVideoSearchStore.js')
const { createAgentToolSourceGuard } = await importBilibiliHost('modules/runtime/infrastructure/agentToolSourceGuard.js')
const { conversationAddressKey } = await load('modules/runtime/domain/agentBindings.js')
const redisTest = { skip: !redisAvailable, timeout: 20000 }, NOW = 1_800_000_000_000, SECRET = 'VIDEO_HOST_PRIVATE_123456/+='
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve }); return { promise, release } }
const sent = (messageId = 'confirmed-video') => ({ state: 'sent', messageId })
const card = (index = 0, overrides = {}) => {
  const id = 'BV1xx411c7m' + String.fromCharCode(68 + index)
  return { provider: 'bilibili', id, title: '公开视频' + (index + 1), author: '作者', durationSeconds: 60 + index, pageUrl: `https://www.bilibili.com/video/${id}`, ...overrides }
}
function preparedVideo(id = card().id, overrides = {}) {
  return { status: 'ready', pageUrl: id.startsWith('ep') ? `https://www.bilibili.com/bangumi/play/${id}` : `https://www.bilibili.com/video/${id}`,
    infoText: '完整视频介绍', plan: { version: 1, items: [{ parts: [{ kind: 'text', text: '完整视频介绍' }] },
      { parts: [{ kind: 'video', artifact: { id: 'a'.repeat(32), kind: 'video', mime: 'video/mp4', sizeBytes: 128, sha256: 'b'.repeat(64) } }] }] },
    async release() {}, ...overrides }
}
async function fixture(t, settings = {}) {
  const redis = await createAgentRedisFixture(t, 'video-search-tools'); let now = NOW, current = true, sequence = 0
  const searches = [], resolutions = [], cards = [], downloads = [], relays = [], releases = [], diagnostics = [], sourceChecks = [], knownSources = new Map()
  const target = { account: { platform: 'qq', namespace: 'global', id: 'robot' }, kind: 'group', id: 'room' }
  const binding = { source: 'configured', id: conversationAddressKey(target), target, agentId: 'alice', personaId: 'daily', revision: 'r1', connectionId: 'qq-main' }
  const store = createAgentVideoSearchStore(redis.storage, { now: () => now })
  let searchHook = settings.search, resolveHook = settings.resolve, sendHook = settings.send
  const provider = { async search(keyword, context) { searches.push({ keyword, context }); return searchHook ? searchHook(keyword, context) : { items: Array.from({ length: 12 }, (_, index) => card(index)) } },
    async resolve(input, context) { resolutions.push({ input, context }); return resolveHook ? resolveHook(input, context) : card() } }
  const attachmentProvider = settings.attachments ? { async prepare(share, context) {
    downloads.push({ share, context })
    return settings.prepare ? settings.prepare(share, context) : preparedVideo(share.reference.kind === 'episode' ? 'ep' + share.reference.id : share.reference.id, {
      async release() { releases.push(share); if (settings.release) await settings.release() },
    })
  } } : undefined
  const toolStorage = settings.storage ? settings.storage(redis.storage) : redis.storage
  const build = () => createAgentVideoSearchTools({ enabled: true }, { storage: toolStorage, provider, now: () => now, secrets: [SECRET],
    ...(attachmentProvider ? { attachmentProvider } : {}), allowsText: text => !text.includes('FORBIDDEN'), diagnostics: { traceId: () => 'video-test', emit(event) { diagnostics.push(event) } } })
  let registry = build()
  const tool = name => registry.builtIn.find(tool => tool.name === name)
  const context = (overrides = {}) => {
    const controller = new AbortController()
    const ctx = { binding, actor: { kind: 'user', user: { platform: 'qq', namespace: 'global', id: 'human-1' } },
      request: { messageId: 'request-' + ++sequence, text: '查询或分享当前视频', mentions: [] }, signal: controller.signal, isCurrent: () => current,
      async ensureCurrent() { if (!current || controller.signal.aborted) throw Error(SECRET) },
      async isSourceAvailable(source) { sourceChecks.push(source); return knownSources.get(source.messageId) !== false },
      async sendVideoCard(value, guard) { cards.push(value); await assertPending(); return sendHook ? sendHook(value, ctx, guard) : sent() },
      async sendMediaRelay(value, guard) { relays.push(value); await assertPending(); return settings.sendRelay ? settings.sendRelay(value, ctx, guard) : sent() }, ...overrides }
    if (ctx.request) knownSources.set(ctx.request.messageId, true)
    return { ...ctx, controller }
  }
  async function assertPending() {
    const keys = await redis.reader.keys(redis.prefix + 'agent:video-search:v1:share:*')
    assert.ok((await Promise.all(keys.map(key => redis.reader.get(key)))).some(raw => JSON.parse(raw).state === 'pending'), 'durable pending must precede the sole native send')
  }
  return { ...redis, binding, store, provider, searches, resolutions, cards, downloads, relays, releases, diagnostics, sourceChecks, knownSources, context, tool,
    restart() { registry = build() }, advance(ms) { now += ms }, setCurrent(value) { current = value }, setSearch(value) { searchHook = value },
    setResolve(value) { resolveHook = value }, setSend(value) { sendHook = value },
    search(input = { keyword: '风景视频' }, ctx = context()) { return tool('searchVideoTool').execute(input, ctx) },
    share(input = { index: 1 }, ctx = context()) { return tool('videoShareTool').execute(input, ctx) },
    download(input = { index: 1 }, ctx = context()) { return tool('videoDownloadTool').execute(input, ctx) },
    async raw() { const rows = []; for (const key of (await redis.reader.keys(redis.prefix + 'agent:video-search:v1:*')).sort()) rows.push([key, await redis.reader.get(key)]); return JSON.stringify(rows) } }
}
function ownedContext(f, context = f.context()) {
  const reads = [], ensureTurn = context.ensureCurrent
  const source = { messageId: context.request.messageId, author: structuredClone(context.actor.user) }
  Object.assign(context, createAgentToolSourceGuard(context, async () => {
    await ensureTurn()
    reads.push(structuredClone(source))
    if (f.knownSources.get(source.messageId) === false) throw Error('owned request source revoked')
  }))
  return { context, reads }
}

test('owned video source proofs authorize matching primary and ticket without duplicate generic reads', redisTest, async t => {
  for (const delivery of ['card', 'attachment']) await t.test(delivery, async t => {
    const f = await fixture(t, { attachments: true }), owned = ownedContext(f)
    assert.equal((await f.search(undefined, owned.context)).status, 'succeeded')
    const before = owned.reads.length
    assert.ok(before > 0); assert.deepEqual(f.sourceChecks, [])
    const result = delivery === 'card' ? await f.share({ index: 1 }, owned.context) : await f.download({ index: 1 }, owned.context)
    assert.equal(result.status, 'succeeded'); assert.ok(owned.reads.length > before, 'delivery obtains fresh source proofs after search completed')
    assert.deepEqual(f.sourceChecks, [], 'only the exact branded primary/ticket source can reuse its complete validator')
    assert.equal(f.cards.length, delivery === 'card' ? 1 : 0); assert.equal(f.relays.length, delivery === 'attachment' ? 1 : 0)
  })
})

test('owned video source proof rereads revoke an in-flight attachment before native delivery', redisTest, async t => {
  const reached = gate(), held = gate(), cleaned = gate(); let released = 0
  t.after(() => held.release())
  const f = await fixture(t, { attachments: true, async prepare(_share, context) {
    reached.release(context); await held.promise
    return preparedVideo(card().id, { async release() { released++; cleaned.release() } })
  } }), owned = ownedContext(f)
  assert.equal((await f.search(undefined, owned.context)).status, 'succeeded')
  const pending = f.download({ index: 1 }, owned.context), guard = await reached.promise
  const before = owned.reads.length
  await guard.ensureCurrent(); assert.ok(owned.reads.length > before)
  f.knownSources.set(owned.context.request.messageId, false)
  const lastAuthorized = owned.reads.length
  await assert.rejects(guard.ensureCurrent()); assert.ok(owned.reads.length > lastAuthorized, 'a prior successful proof never authorizes a later invocation')
  held.release(); assert.equal((await pending).status, 'failed'); await cleaned.promise
  assert.equal(f.downloads.length, 1); assert.equal(f.relays.length, 0); assert.equal(f.cards.length, 0); assert.equal(released, 1)
  assert.deepEqual(f.sourceChecks, [])
})

test('owned video source proof cannot authorize a different recalled search source', redisTest, async t => {
  const f = await fixture(t, { attachments: true }), original = ownedContext(f)
  assert.equal((await f.search(undefined, original.context)).status, 'succeeded')
  const selected = ownedContext(f, f.context({ actor: { kind: 'user', user: { ...original.context.actor.user, id: 'human-2' } } }))
  f.knownSources.set(original.context.request.messageId, false)
  assert.equal((await f.download({ index: 1 }, selected.context)).status, 'failed')
  assert.ok(selected.reads.length > 0, 'the selecting request remains independently authorized')
  assert.ok(f.sourceChecks.some(source => source.messageId === original.context.request.messageId && source.author.id === original.context.actor.user.id))
  assert.ok(f.sourceChecks.every(source => source.messageId !== selected.context.request.messageId))
  assert.equal(f.downloads.length, 0); assert.equal(f.relays.length, 0); assert.equal(f.cards.length, 0)
})

test('owned video source proof retains the search generation fence even for its matching ticket source', redisTest, async t => {
  const reached = gate(), held = gate(), cleaned = gate(); let released = 0
  t.after(() => held.release())
  const f = await fixture(t, { attachments: true, async prepare(_share, context) {
    reached.release(context); await held.promise
    return preparedVideo(card().id, { async release() { released++; cleaned.release() } })
  } }), owned = ownedContext(f)
  assert.equal((await f.search(undefined, owned.context)).status, 'succeeded')
  const pending = f.download({ index: 1 }, owned.context), guard = await reached.promise
  const replacement = f.context()
  assert.equal((await f.search({ keyword: '替换搜索' }, replacement)).status, 'succeeded')
  assert.equal(f.knownSources.get(owned.context.request.messageId), true, 'the primary source itself is still live')
  await assert.rejects(guard.ensureCurrent())
  held.release(); assert.equal((await pending).status, 'failed'); await cleaned.promise
  assert.equal((await f.store.load(f.binding)).source.messageId, replacement.request.messageId)
  assert.equal(f.relays.length, 0); assert.equal(f.cards.length, 0); assert.equal(released, 1)
})

test('owned video source fallback revalidates unbranded, replaced and borrowed validators', redisTest, async t => {
  for (const mode of ['forged-marker', 'replaced-method', 'borrowed-method']) await t.test(mode, async t => {
    const f = await fixture(t), owned = ownedContext(f), context = mode === 'replaced-method' ? owned.context : f.context()
    if (mode === 'forged-marker') context.ensureCurrent = Object.assign(async () => {}, { ownedSource: true, matchesSource: () => true })
    if (mode === 'replaced-method') context.ensureCurrent = async () => {}
    if (mode === 'borrowed-method') context.ensureCurrent = owned.context.ensureCurrent
    f.knownSources.set(context.request.messageId, false)
    assert.equal((await f.search(undefined, context)).status, 'failed')
    assert.ok(f.sourceChecks.some(source => source.messageId === context.request.messageId && source.author.id === context.actor.user.id))
    assert.equal(f.searches.length, 0); assert.equal(f.resolutions.length, 0); assert.equal(f.cards.length, 0)
    assert.equal(await f.store.load(f.binding), undefined)
    assert.equal(owned.reads.length > 0, mode === 'borrowed-method', 'a foreign owner cannot lend its identity to the recalled current request')
  })
})

test('activation exposes only the two human video tools and closed neutral input schemas', redisTest, async t => {
  assert.deepEqual(createAgentVideoSearchTools({ enabled: false }, {}), { builtIn: [] })
  const f = await fixture(t)
  assert.deepEqual(['searchVideoTool', 'videoShareTool'].map(name => f.tool(name).name), ['searchVideoTool', 'videoShareTool'])
  assert.deepEqual(Object.keys(f.tool('searchVideoTool').parameters.properties), ['keyword'])
  assert.deepEqual(Object.keys(f.tool('videoShareTool').parameters.properties), ['id', 'index', 'url', 'query'])
  assert.equal(f.tool('searchVideoTool').parameters.additionalProperties, false); assert.equal(f.tool('videoShareTool').parameters.additionalProperties, false)
  assert.equal(f.tool('searchVideoTool').dataPolicy, undefined)
})
test('search is metadata-only, retains relevance order and source and saves no keyword or native card data', redisTest, async t => {
  const f = await fixture(t), original = f.context(), outcome = await f.search({ keyword: '风景视频' }, original)
  assert.equal(outcome.status, 'succeeded'); assert.match(outcome.content, /尚未发送视频卡片/u)
  assert.equal(f.cards.length, 0); assert.equal(f.resolutions.length, 0); assert.equal(f.searches.length, 1)
  const saved = await f.store.load(f.binding)
  assert.equal(saved.items.length, 8); assert.deepEqual(saved.items.map(item => item.id), Array.from({ length: 8 }, (_, index) => card(index).id))
  assert.deepEqual(saved.source, { messageId: original.request.messageId, author: original.actor.user })
  assert.match(outcome.content, /1\. 公开视频1/u); assert.match(outcome.content, /8\. 公开视频8/u); assert.doesNotMatch(outcome.content, /9\. /u)
  assert.deepEqual(Object.keys(f.searches[0].context).sort(), ['ensureCurrent', 'isCurrent', 'signal'])
  const raw = await f.raw(); for (const text of ['风景视频', 'keyword', 'thumbnail', 'base64', 'native', SECRET]) assert.equal(raw.includes(text), false)
})
test('a different group user may explicitly select one live list result by index or exact ID', redisTest, async t => {
  const f = await fixture(t), original = f.context(); await f.search(undefined, original)
  const selected = f.context({ actor: { kind: 'user', user: { platform: 'qq', namespace: 'global', id: 'human-2' } } })
  assert.equal((await f.share({ index: 2 }, selected)).status, 'succeeded'); assert.deepEqual(f.cards, [card(1)])
  assert.ok(f.sourceChecks.some(source => source.messageId === original.request.messageId && source.author.id === 'human-1'))
  assert.equal((await f.share({ id: card(2).id })).status, 'succeeded'); assert.deepEqual(f.cards.at(-1), card(2))
  assert.equal(f.resolutions.length, 0)
})
test('direct URLs and queries must occur in the current real request and require no synthetic media source', redisTest, async t => {
  const f = await fixture(t)
  for (const input of [{ query: '风景视频' }, { url: card().pageUrl }, { url: 'https://b23.tv/abc123' }]) {
    const value = input.query ?? input.url, ctx = f.context({ request: { messageId: 'direct-' + f.resolutions.length, text: '发送 ' + value, mentions: [] } })
    assert.equal((await f.share(input, ctx)).status, 'succeeded')
    assert.deepEqual(f.resolutions.at(-1).input, input)
  }
  assert.equal(f.cards.length, 3); assert.equal(await f.store.load(f.binding), undefined)
  for (const input of [{ id: card().id }, { query: '未在本轮提供' }, { url: card().pageUrl }, { url: 'https://example.invalid/video' }]) assert.equal((await f.share(input)).status, 'failed')
  assert.equal(f.resolutions.length, 3); assert.equal(f.cards.length, 3)
})
test('explicit episode URLs retain canonical identity and a provider cannot replace a fixed video URL', redisTest, async t => {
  const episode = card(0, { id: 'ep123456', pageUrl: 'https://www.bilibili.com/bangumi/play/ep123456', author: '', durationSeconds: 1.25 })
  const f = await fixture(t, { resolve: async input => input.url.includes('/bangumi/') ? episode : card(1), search: async () => ({ items: [episode] }) })
  const ctx = f.context({ request: { messageId: 'explicit-episode', text: '发送 ' + episode.pageUrl, mentions: [] } })
  assert.equal((await f.share({ url: episode.pageUrl }, ctx)).status, 'succeeded'); assert.deepEqual(f.cards, [episode])
  const mismatch = f.context({ request: { messageId: 'explicit-bv', text: '发送 ' + card().pageUrl, mentions: [] } })
  assert.equal((await f.share({ url: card().pageUrl }, mismatch)).status, 'failed'); assert.equal(f.cards.length, 1)
  await f.search(); assert.equal((await f.share({ id: episode.id })).status, 'succeeded'); assert.deepEqual(f.cards.at(-1), episode)
})
test('expired or recalled original searches and missing share ports cannot authorize sends', redisTest, async t => {
  for (const mode of ['expired', 'recalled', 'missing-port', 'other-binding']) await t.test(mode, async t => {
    const f = await fixture(t), original = f.context(); await f.search(undefined, original)
    if (mode === 'expired') f.advance(300000)
    if (mode === 'recalled') f.knownSources.set(original.request.messageId, false)
    const selected = f.context(mode === 'missing-port' ? { sendVideoCard: undefined } : mode === 'other-binding' ? { binding: { ...f.binding, revision: 'r2' } } : {})
    assert.equal((await f.share({ index: 1 }, selected)).status, 'failed'); assert.equal(f.cards.length, 0); assert.equal(f.resolutions.length, 0)
  })
})
test('a newer search cancels an older pending provider and cannot be overwritten by its late result', redisTest, async t => {
  const held = gate(), reached = gate(), f = await fixture(t)
  t.after(() => held.release())
  f.setSearch(async keyword => { if (keyword === '旧查询') { reached.release(); await held.promise }; return { items: [card(keyword === '旧查询' ? 0 : 1)] } })
  const old = f.search({ keyword: '旧查询' }); await reached.promise
  assert.equal((await f.search({ keyword: '新查询' })).status, 'succeeded')
  assert.equal((await old).status, 'failed'); held.release(); await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual((await f.store.load(f.binding)).items, [card(1)]); assert.equal(f.cards.length, 0)
})
test('polling source recall or turn invalidation cancels pending search and resolve before sending', redisTest, async t => {
  for (const mode of ['search-recall', 'resolve-recall', 'resolve-stale', 'resolve-abort']) await t.test(mode, async t => {
    const held = gate(), reached = gate(), waiting = async () => { reached.release(); await held.promise; return card() }
    t.after(() => held.release())
    const f = await fixture(t, mode === 'search-recall' ? { search: async () => ({ items: [await waiting()] }) } : { resolve: waiting })
    const ctx = f.context({ request: { messageId: 'revoked-request', text: '发送明确关键词', mentions: [] } })
    const pending = mode === 'search-recall' ? f.search(undefined, ctx) : f.share({ query: '明确关键词' }, ctx)
    await reached.promise
    if (mode.endsWith('recall')) f.knownSources.set(ctx.request.messageId, false)
    if (mode.endsWith('stale')) f.setCurrent(false)
    if (mode.endsWith('abort')) ctx.controller.abort()
    assert.equal((await pending).status, 'failed'); held.release(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.cards.length, 0); assert.equal(await f.store.load(f.binding), undefined)
  })
})
test('nonhuman actors, unavailable real sources and closed malicious inputs never reach a provider', redisTest, async t => {
  const f = await fixture(t)
  const invalidContexts = [f.context({ actor: { kind: 'autonomous' } }), f.context({ actor: { kind: 'commitment' } }),
    f.context({ request: undefined }), f.context({ isSourceAvailable: undefined }),
    f.context({ actor: { kind: 'user', user: { platform: 'qq', namespace: 'other', id: 'human' } } }),
    f.context({ actor: { kind: 'user', user: f.binding.target.account } }),
    f.context({ request: { messageId: '0', text: '伪造请求', mentions: [] } })]
  const recalled = f.context(); f.knownSources.set(recalled.request.messageId, false); invalidContexts.push(recalled)
  for (const ctx of invalidContexts) { assert.equal((await f.search(undefined, ctx)).status, 'failed'); assert.equal((await f.share({ query: '查询' }, ctx)).status, 'failed') }
  for (const input of [null, [], {}, { keyword: 'x', target: 'other' }, { keyword: SECRET }, { keyword: encodeURIComponent(SECRET) },
    { keyword: Buffer.from(SECRET).toString('base64') }, { keyword: 'FORBIDDEN' }, { keyword: 'a\nb' }]) assert.equal((await f.search(input)).status, 'failed')
  for (const input of [{}, { index: 0 }, { index: 1.5 }, { index: 9 }, { id: 'arbitrary' }, { id: card().id, index: 1 },
    { query: 'x', target: 'other' }, { query: SECRET }]) assert.equal((await f.share(input)).status, 'failed')
  let touched = 0
  for (const input of [{ get keyword() { touched++; return 'x' } }, new Proxy({ keyword: 'x' }, { get() { touched++; return 'x' } })]) assert.equal((await f.search(input)).status, 'failed')
  assert.equal(touched, 0); assert.equal(f.searches.length, 0); assert.equal(f.resolutions.length, 0); assert.equal(f.cards.length, 0)
})
test('unsafe provider metadata and raw provider exceptions never leak into results, storage or diagnostics', redisTest, async t => {
  for (const mode of ['secret-title', 'extra-thumbnail', 'secret-url', 'raw-error']) await t.test(mode, async t => {
    const f = await fixture(t, { search: async () => {
      if (mode === 'raw-error') throw Error(SECRET)
      return { items: [card(0, mode === 'secret-title' ? { title: SECRET } : mode === 'extra-thumbnail' ? { thumbnail: 'https://private.invalid/' + SECRET } : { pageUrl: card().pageUrl + '?token=' + SECRET })] }
    } })
    const outcome = await f.search(); assert.equal(outcome.status, 'failed'); assert.equal(f.cards.length, 0); assert.equal(await f.store.load(f.binding), undefined)
    for (const value of [outcome.content, await f.raw(), JSON.stringify(f.diagnostics)]) assert.equal(value.includes(SECRET), false)
  })
})
test('one request retains a durable receipt and cannot change selectors or resend after registry recreation', redisTest, async t => {
  const f = await fixture(t); await f.search(); const ctx = f.context()
  assert.equal((await f.share({ index: 1 }, ctx)).status, 'succeeded'); f.restart()
  assert.equal((await f.share({ index: 2 }, ctx)).status, 'succeeded'); assert.deepEqual(f.cards, [card()])
  const key = (await f.reader.keys(f.prefix + 'agent:video-search:v1:share:*'))[0]
  assert.equal(JSON.parse(await f.reader.get(key)).state, 'sent')
})
test('a duplicate receipt cannot bypass recall of the selected search source', redisTest, async t => {
  const f = await fixture(t), original = f.context(); await f.search(undefined, original); const selected = f.context()
  assert.equal((await f.share({ index: 1 }, selected)).status, 'succeeded')
  f.knownSources.set(original.request.messageId, false); f.restart()
  assert.equal((await f.share({ index: 1 }, selected)).status, 'failed'); assert.equal(f.cards.length, 1)
})
test('unknown, malformed or throwing send receipts remain unknown and never produce another send', redisTest, async t => {
  for (const mode of ['unknown', 'no-id', 'zero-id', 'extra-native', 'throw']) await t.test(mode, async t => {
    const f = await fixture(t, { send: async () => {
      if (mode === 'throw') throw Error(SECRET)
      return mode === 'no-id' ? { state: 'sent' } : mode === 'zero-id' ? sent('0') : mode === 'extra-native' ? { ...sent(), native: SECRET } : { state: 'unknown' }
    } }); await f.search(); const ctx = f.context()
    assert.equal((await f.share({ index: 1 }, ctx)).status, 'unknown'); f.restart()
    const duplicate = await f.share({ index: 1 }, ctx); assert.equal(duplicate.status, 'unknown'); assert.doesNotMatch(duplicate.content, /已确认发送|HOST_PRIVATE/u)
    assert.equal(f.cards.length, 1)
  })
})
test('definite rejection and preexisting pending claims prohibit another resolution or send', redisTest, async t => {
  const f = await fixture(t, { send: async () => ({ state: 'failed', code: 'rejected' }) }); await f.search(); const ctx = f.context()
  assert.equal((await f.share({ index: 1 }, ctx)).status, 'failed'); f.restart()
  assert.equal((await f.share({ index: 1 }, ctx)).status, 'failed'); assert.equal(f.cards.length, 1)
  const pending = f.context({ request: { messageId: 'already-pending', text: '发送明确关键词', mentions: [] } })
  await f.store.claimShare(f.binding, { messageId: pending.request.messageId, author: pending.actor.user })
  assert.equal((await f.share({ query: '明确关键词' }, pending)).status, 'unknown'); assert.equal(f.resolutions.length, 0); assert.equal(f.cards.length, 1)
})
test('aborting an in-flight native send persists unknown and late confirmation never permits a resend', redisTest, async t => {
  const held = gate(), reached = gate(), f = await fixture(t, { send: async () => { reached.release(); await held.promise; return sent() } })
  t.after(() => held.release()); await f.search(); const ctx = f.context(), pending = f.share({ index: 1 }, ctx)
  await reached.promise; ctx.controller.abort(); assert.equal((await pending).status, 'unknown')
  held.release(); await new Promise(resolve => setImmediate(resolve)); f.restart()
  const fresh = f.context({ request: ctx.request }); assert.equal((await f.share({ index: 1 }, fresh)).status, 'unknown'); assert.equal(f.cards.length, 1)
})
test('the precise source and generation guard survives queueing and rejects stale native dispatch', redisTest, async t => {
  for (const mode of ['current-recall', 'original-recall', 'new-search']) await t.test(mode, async t => {
    const held = gate(), reached = gate(), settled = gate(); let delivered = 0
    t.after(() => held.release())
    const f = await fixture(t, { send: async (_card, _ctx, guard) => {
      try {
        assert.ok(guard.signal instanceof AbortSignal); assert.equal(typeof guard.isCurrent, 'function'); assert.equal(typeof guard.ensureCurrent, 'function')
        reached.release(); await held.promise; await guard.ensureCurrent()
        if (!guard.isCurrent() || guard.signal.aborted) throw Error('queued permission revoked')
        delivered++; return sent()
      } finally { settled.release() }
    } })
    const original = f.context(); await f.search(undefined, original); const ctx = f.context(), pending = f.share({ index: 1 }, ctx)
    await reached.promise
    if (mode === 'current-recall') f.knownSources.set(ctx.request.messageId, false)
    if (mode === 'original-recall') f.knownSources.set(original.request.messageId, false)
    if (mode === 'new-search') assert.equal((await f.search({ keyword: '另一个查询' })).status, 'succeeded')
    assert.equal((await pending).status, 'unknown'); held.release(); await settled.promise
    assert.equal(delivered, 0)
  })
})
test('source recall during a confirmed native send prevents a stale success claim and duplicate send', redisTest, async t => {
  const f = await fixture(t, { send: async (_card, ctx) => { f.knownSources.set(ctx.request.messageId, false); return sent() } }); await f.search(); const ctx = f.context()
  const outcome = await f.share({ index: 1 }, ctx)
  assert.equal(outcome.status, 'unknown'); assert.doesNotMatch(outcome.content, /已确认发送/u)
  f.knownSources.set(ctx.request.messageId, true); f.restart()
  assert.equal((await f.share({ index: 1 }, ctx)).status, 'succeeded'); assert.equal(f.cards.length, 1)
})
test('attachment capability is separately injected, has a closed selector and never changes metadata-only search', redisTest, async t => {
  const off = await fixture(t); assert.equal(off.tool('videoDownloadTool'), undefined)
  const f = await fixture(t, { attachments: true })
  assert.equal(f.tool('videoDownloadTool').timeoutMs, 240000)
  assert.deepEqual(Object.keys(f.tool('videoDownloadTool').parameters.properties), ['id', 'index', 'url', 'query'])
  assert.equal(f.tool('videoDownloadTool').parameters.additionalProperties, false)
  assert.equal((await f.search()).status, 'succeeded')
  assert.equal(f.downloads.length, 0); assert.equal(f.relays.length, 0); assert.equal(f.cards.length, 0)
})
test('explicit download selects a live canonical result, sends one owned plan and releases its resources', redisTest, async t => {
  const f = await fixture(t, { attachments: true }); await f.search(); const ctx = f.context()
  const outcome = await f.download({ index: 2 }, ctx)
  assert.equal(outcome.status, 'succeeded'); assert.match(outcome.content, /完整低清附件及说明已确认发送/u)
  assert.deepEqual(f.downloads[0].share, { provider: 'bilibili', reference: { kind: 'video', id: card(1).id } })
  assert.deepEqual(f.relays, [preparedVideo(card(1).id).plan]); assert.equal(f.cards.length, 0); assert.equal(f.releases.length, 1)
  assert.deepEqual(Object.keys(f.downloads[0].context).sort(), ['ensureCurrent', 'isCurrent', 'signal'])
  f.restart(); assert.equal((await f.download({ index: 1 }, ctx)).status, 'succeeded')
  assert.equal(f.relays.length, 1); assert.equal(f.downloads.length, 1)
  const raw = await f.raw(); for (const forbidden of [SECRET, 'artifact', 'sha256', 'base64', 'sizeBytes', '完整视频介绍']) assert.equal(raw.includes(forbidden), false)
})
test('explicit attachment URL/query and episode selection use only canonical resolved video identities', redisTest, async t => {
  const episode = card(0, { id: 'ep123456', pageUrl: 'https://www.bilibili.com/bangumi/play/ep123456', author: '' })
  const f = await fixture(t, { attachments: true, resolve: async input => input.url?.includes('/bangumi/') ? episode : card() })
  for (const input of [{ query: '明确视频' }, { url: card().pageUrl }, { url: episode.pageUrl }]) {
    const ctx = f.context({ request: { messageId: 'download-direct-' + f.downloads.length, text: '下载 ' + (input.query ?? input.url), mentions: [] } })
    assert.equal((await f.download(input, ctx)).status, 'succeeded')
  }
  assert.deepEqual(f.downloads.at(-1).share, { provider: 'bilibili', reference: { kind: 'episode', id: '123456' } })
  assert.equal(f.downloads.length, 3); assert.equal(f.relays.length, 3)
  const missing = await f.download({ query: '不在原文的查询' }); assert.equal(missing.status, 'failed'); assert.equal(f.downloads.length, 3)
})
test('attachment execution rejects nonhuman, private, missing-source and missing-delivery capabilities before preparation', redisTest, async t => {
  const f = await fixture(t, { attachments: true }); await f.search()
  for (const overrides of [{ actor: { kind: 'autonomous' } }, { actor: { kind: 'commitment' } },
    { binding: { ...f.binding, target: { ...f.binding.target, kind: 'private' } } }, { request: undefined },
    { isSourceAvailable: undefined }, { sendMediaRelay: undefined }]) {
    assert.equal((await f.download({ index: 1 }, f.context(overrides))).status, 'failed')
  }
  assert.equal(f.downloads.length, 0); assert.equal(f.relays.length, 0)
})
test('incomplete, mismatched, unsafe and oversized attachment plans fail closed and still release resources', redisTest, async t => {
  for (const mode of ['metadata-only', 'preview', 'restricted', 'wrong-page', 'no-video', 'too-many', 'too-large', 'secret-info', 'secret-plan']) await t.test(mode, async t => {
    let released = 0
    const f = await fixture(t, { attachments: true, async prepare() {
      const result = preparedVideo(card().id, { async release() { released++ } })
      if (['metadata-only', 'preview', 'restricted'].includes(mode)) result.status = mode
      if (mode === 'wrong-page') result.pageUrl = card(1).pageUrl
      if (mode === 'no-video') result.plan.items.pop()
      if (mode === 'too-many') result.plan.items.push(result.plan.items[1], result.plan.items[1])
      if (mode === 'too-large') result.plan.items[1].parts[0].artifact.sizeBytes = 30 * 1024 * 1024 + 1
      if (mode === 'secret-info') result.infoText = SECRET
      if (mode === 'secret-plan') result.plan.items[0].parts[0].text = SECRET
      return result
    } }); await f.search(); const outcome = await f.download()
    assert.equal(outcome.status, 'failed'); assert.equal(f.relays.length, 0); assert.equal(released, 1)
    for (const text of [outcome.content, JSON.stringify(f.diagnostics), await f.raw()]) assert.equal(text.includes(SECRET), false)
  })
})
test('revocation while preparing an attachment cancels promptly and releases a late prepared lease', redisTest, async t => {
  for (const mode of ['current-recall', 'original-recall', 'new-search', 'invalidated', 'aborted']) await t.test(mode, async t => {
    const reached = gate(), held = gate(), released = gate()
    t.after(() => held.release())
    const f = await fixture(t, { attachments: true, async prepare() { reached.release(); await held.promise; return preparedVideo(card().id, { async release() { released.release() } }) } })
    const original = f.context(); await f.search(undefined, original)
    const ctx = f.context(), pending = f.download({ index: 1 }, ctx); await reached.promise
    if (mode === 'current-recall') f.knownSources.set(ctx.request.messageId, false)
    if (mode === 'original-recall') f.knownSources.set(original.request.messageId, false)
    if (mode === 'new-search') assert.equal((await f.search({ keyword: '新搜索' })).status, 'succeeded')
    if (mode === 'invalidated') f.setCurrent(false)
    if (mode === 'aborted') ctx.controller.abort()
    assert.equal((await pending).status, 'failed'); held.release(); await released.promise
    assert.equal(f.relays.length, 0)
  })
})
test('attachment queue receives the precise async source/generation guard and cannot dispatch after replacement', redisTest, async t => {
  for (const mode of ['original-recall', 'new-search']) await t.test(mode, async t => {
    const reached = gate(), held = gate(), settled = gate(); let delivered = 0
    t.after(() => held.release())
    const f = await fixture(t, { attachments: true, async sendRelay(_plan, _ctx, guard) {
      try {
        assert.ok(guard.signal instanceof AbortSignal); assert.equal(typeof guard.ensureCurrent, 'function')
        reached.release(); await held.promise; await guard.ensureCurrent()
        if (!guard.isCurrent() || guard.signal.aborted) throw Error('source changed')
        delivered++; return sent()
      } finally { settled.release() }
    } })
    const original = f.context(); await f.search(undefined, original)
    const ctx = f.context(), pending = f.download({ index: 1 }, ctx); await reached.promise
    if (mode === 'original-recall') f.knownSources.set(original.request.messageId, false)
    else await f.search({ keyword: '新搜索' })
    assert.equal((await pending).status, 'unknown'); held.release(); await settled.promise
    assert.equal(delivered, 0); assert.equal(f.releases.length, 1)
  })
})
test('unknown attachment delivery, native exceptions and post-send receipt loss freeze both outbound tools', redisTest, async t => {
  for (const mode of ['unknown', 'malformed', 'throw', 'receipt-store-failed']) await t.test(mode, async t => {
    let rejected = false
    const f = await fixture(t, { attachments: true,
      storage: base => ({ ...base, async eval(script, input) {
        if (mode === 'receipt-store-failed' && !rejected && script.includes('KEEPTTL') && input.arguments[1].includes('"state":"sent"')) { rejected = true; throw Error(SECRET) }
        return base.eval(script, input)
      } }),
      async sendRelay() { if (mode === 'throw') throw Error(SECRET); return mode === 'malformed' ? { state: 'sent' } : mode === 'receipt-store-failed' ? sent() : { state: 'unknown' } },
    }); await f.search(); const ctx = f.context()
    const outcome = await f.download({ index: 1 }, ctx); assert.equal(outcome.status, 'unknown')
    f.restart(); assert.equal((await f.download({ index: 1 }, ctx)).status, 'unknown'); assert.equal((await f.share({ index: 1 }, ctx)).status, 'unknown')
    assert.equal(f.relays.length, 1); assert.equal(f.cards.length, 0); assert.equal(f.downloads.length, 1); assert.equal(f.releases.length, 1)
    if (mode === 'receipt-store-failed') assert.ok(f.diagnostics.some(row => row.code === 'delivery_receipt_store_failed'))
    for (const text of [outcome.content, JSON.stringify(f.diagnostics), await f.raw()]) assert.equal(text.includes(SECRET), false)
  })
})
test('cross-tool duplicate receipts never describe a prior card as a completed attachment download', redisTest, async t => {
  const f = await fixture(t, { attachments: true }); await f.search(); const ctx = f.context()
  assert.equal((await f.share({ index: 1 }, ctx)).status, 'succeeded')
  const outcome = await f.download({ index: 1 }, ctx)
  assert.equal(outcome.status, 'succeeded'); assert.match(outcome.content, /已有视频投递确认/u); assert.doesNotMatch(outcome.content, /附件|已下载/u)
  assert.equal(f.cards.length, 1); assert.equal(f.downloads.length, 0); assert.equal(f.relays.length, 0)
})
test('attachment cleanup failures remain explicit static diagnostics without undoing confirmed delivery', redisTest, async t => {
  const f = await fixture(t, { attachments: true, async release() { throw Error(SECRET) } }); await f.search()
  const outcome = await f.download(); assert.equal(outcome.status, 'succeeded'); assert.equal(f.relays.length, 1)
  assert.ok(f.diagnostics.some(event => event.operation === 'video_download' && event.code === 'prepared_release_failed' && event.outcome === 'failed'))
  assert.equal(JSON.stringify(f.diagnostics).includes(SECRET), false)
})
test('two complete 30MiB attachment segments preserve their order in one neutral delivery', redisTest, async t => {
  const result = preparedVideo()
  const first = result.plan.items[1].parts[0]; first.artifact.sizeBytes = 30 * 1024 * 1024
  result.plan.items.push({ parts: [{ ...first, artifact: { ...first.artifact, id: 'c'.repeat(32), sha256: 'd'.repeat(64) } }] })
  const f = await fixture(t, { attachments: true, async prepare() { return result } }); await f.search()
  assert.equal((await f.download()).status, 'succeeded'); assert.equal(f.relays.length, 1)
  assert.deepEqual(f.relays[0].items.flatMap(item => item.parts.filter(part => part.kind === 'video').map(part => part.artifact.id)), ['a'.repeat(32), 'c'.repeat(32)])
})
test('attachment preparation errors and unsafe release accessors produce fixed diagnostics without leaking or invoking getters', redisTest, async t => {
  for (const mode of ['prepare-failed', 'unsafe-release']) await t.test(mode, async t => {
    let touched = 0
    const f = await fixture(t, { attachments: true, async prepare() {
      if (mode === 'prepare-failed') throw Error(SECRET)
      const result = preparedVideo(); Object.defineProperty(result, 'release', { get() { touched++; return async () => {} } }); return result
    } }); await f.search(); const outcome = await f.download()
    assert.equal(outcome.status, 'failed'); assert.equal(f.relays.length, 0); assert.equal(touched, 0)
    assert.ok(f.diagnostics.some(event => event.operation === 'video_download' && event.outcome === 'failed'))
    if (mode === 'unsafe-release') assert.ok(f.diagnostics.some(event => event.code === 'prepared_release_failed'))
    for (const text of [outcome.content, JSON.stringify(f.diagnostics), await f.raw()]) assert.equal(text.includes(SECRET), false)
  })
})
