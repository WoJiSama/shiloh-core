import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'
const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const load = name => import(pathToFileURL(path.join(release, 'dist/backend', name)).href)
const { createAgentPixivTools } = await load('modules/media/infrastructure/agentPixivTools.js')
const { createAgentPixivSessionStore } = await load('modules/media/infrastructure/agentPixivSessionStore.js')
const { conversationAddressKey } = await load('modules/runtime/domain/agentBindings.js')
const redisTest = { skip: !redisAvailable, timeout: 20000 }, NOW = 1_800_000_000_000, SECRET = 'PIXIV_HOST_PRIVATE_123456/+=', MiB = 1024 * 1024
const PNG = { mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR9sAAAAASUVORK5CYII=' }
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve }); return { promise, release } }
const sent = (messageId = 'confirmed-pixiv') => ({ state: 'sent', messageId })
const item = (index = 0, overrides = {}) => ({ id: String(126649495 + index), title: '作品' + (index + 1), userName: '画师', pageCount: 5,
  xRestrict: 0, bookmarkCount: index, thumbUrl: `https://i.pximg.net/img/${126649495 + index}_p0.jpg?ephemeral=thumbnail`, ...overrides })
const result = overrides => ({ keyword: '初音未来', mode: 'artworks', order: 'newest', orderSource: 'native', total: 24,
  items: Array.from({ length: 24 }, (_, index) => item(index)), ...overrides })
const gallery = (images = 5, size = 8 * MiB) => ({ version: 1, items: [{ parts: [{ kind: 'text', text: '完整作品说明' }] },
  ...Array.from({ length: images }, (_, index) => ({ parts: [{ kind: 'image', artifact: { id: String(index + 1).repeat(32), kind: 'image', mime: 'image/jpeg',
    sizeBytes: size, sha256: String(index + 1).repeat(64) } }] }))] })
async function fixture(t, settings = {}) {
  const redis = await createAgentRedisFixture(t, 'pixiv-tools-test'); let now = NOW, current = true, requestSequence = 0, released = 0
  const searches = [], renders = [], preparations = [], images = [], relays = [], sourceChecks = [], knownSources = new Map()
  const target = { account: { platform: 'qq', namespace: 'global', id: 'robot' }, kind: 'group', id: 'room' }
  const binding = { source: 'configured', id: conversationAddressKey(target), target, agentId: 'alice', personaId: 'daily', revision: 'r1', connectionId: 'qq-main' }
  const store = createAgentPixivSessionStore(redis.storage, { now: () => now })
  let searchHook = settings.search, renderHook = settings.render, prepareHook = settings.prepare, imageHook = settings.image, relayHook = settings.relay
  const provider = { async search(input, context) { searches.push({ input, context }); return searchHook ? searchHook(input, context) : result({ keyword: input.keyword }) },
    async renderList(data, context) { renders.push({ data, context }); if (renderHook) return renderHook(data, context); return PNG } }
  const relayProvider = { async prepare(share, context) {
    preparations.push({ share, context })
    const prepared = { status: 'ready', pageUrl: `https://www.pixiv.net/artworks/${share.reference.id}`, infoText: '完整作品说明', plan: gallery(), async release() { released++ } }
    return prepareHook ? prepareHook(share, context, prepared) : prepared
  } }
  const build = () => createAgentPixivTools({ enabled: true, ...settings.config }, { provider, relayProvider, storage: redis.storage, now: () => now,
    secrets: [SECRET], allowsText: text => !text.includes('FORBIDDEN') })
  let tools = build()
  const tool = name => tools.builtIn.find(tool => tool.name === name)
  const context = (overrides = {}) => {
    const controller = new AbortController(), messageId = `request-${++requestSequence}`
    const ctx = { binding, actor: { kind: 'user', user: { platform: 'qq', namespace: 'global', id: 'human-1' } },
      request: { messageId, text: '当前真人请求', mentions: [] }, signal: controller.signal, isCurrent: () => current,
      async ensureCurrent() { if (!current || controller.signal.aborted) throw Error('source invalid') },
      async isSourceAvailable(source) { sourceChecks.push(source); return knownSources.get(source.messageId) !== false },
      async sendImage(image) { images.push(image); await assertPending(); return imageHook ? imageHook(image, ctx) : sent() },
      async sendMediaRelay(plan) { relays.push(plan); await assertPending(); return relayHook ? relayHook(plan, ctx) : sent() }, ...overrides }
    knownSources.set(ctx.request?.messageId, true)
    return { ...ctx, controller }
  }
  async function assertPending() {
    const keys = await redis.reader.keys(redis.prefix + 'agent:pixiv-tools:v1:attempt:*')
    assert.ok((await Promise.all(keys.map(key => redis.reader.get(key)))).some(raw => JSON.parse(raw).state === 'pending'), 'Redis marker must precede native send')
  }
  const f = { ...redis, store, binding, searches, renders, preparations, images, relays, sourceChecks, context, tool, knownSources,
    get released() { return released }, advance(ms) { now += ms }, setCurrent(value) { current = value }, restart() { tools = build() },
    setSearch(value) { searchHook = value }, setRender(value) { renderHook = value }, setPrepare(value) { prepareHook = value }, setImage(value) { imageHook = value }, setRelay(value) { relayHook = value },
    async search(input = { keyword: '初音未来' }, ctx = context()) { return tool('pixivSearchTool').execute(input, ctx) },
    async download(target = '1', ctx = context()) { return tool('pixivDownloadTool').execute({ target }, ctx) },
    async raw() { const rows = []; for (const key of (await redis.reader.keys(redis.prefix + 'agent:pixiv-tools:v1:*')).sort()) rows.push([key, await redis.reader.get(key)]); return JSON.stringify(rows) },
  }
  return f
}
test('Pixiv preserves two model tools, closed schemas and explicit disabled activation', redisTest, async t => {
  assert.deepEqual(createAgentPixivTools({ enabled: false }, {}), { builtIn: [] })
  const f = await fixture(t)
  assert.deepEqual(['pixivSearchTool', 'pixivDownloadTool'].map(name => f.tool(name).name), ['pixivSearchTool', 'pixivDownloadTool'])
  assert.deepEqual(Object.keys(f.tool('pixivSearchTool').parameters.properties), ['keyword', 'searchType', 'orderBy'])
  assert.deepEqual(Object.keys(f.tool('pixivDownloadTool').parameters.properties), ['target'])
  assert.equal(f.tool('pixivSearchTool').dataPolicy, 'ephemeral'); assert.equal(f.tool('pixivDownloadTool').timeoutMs, 240000)
})
test('search sends one checked card, persists twenty safe rows and shares the slot across group users', redisTest, async t => {
  const f = await fixture(t), searchContext = f.context(), outcome = await f.search({ keyword: '初音未来', searchType: 'artist', orderBy: 'popular' }, searchContext)
  assert.equal(outcome.status, 'succeeded'); assert.match(outcome.content, /已确认送达/u)
  assert.equal(f.images.length, 1); assert.equal(f.searches.length, 1); assert.equal(f.renders.length, 1)
  assert.deepEqual(f.searches[0].input, { keyword: '初音未来', searchType: 'artist', orderBy: 'popular' })
  const saved = await f.store.load(f.binding); assert.equal(saved.data.items.length, 20); assert.equal(saved.source.messageId, searchContext.request.messageId)
  const ctx = f.context({ actor: { kind: 'user', user: { platform: 'qq', namespace: 'global', id: 'human-2' } } })
  assert.equal((await f.download('8', ctx)).status, 'succeeded'); assert.equal(f.preparations[0].share.reference.id, '126649502')
  assert.equal(f.relays[0].items.length, 6); assert.deepEqual(f.relays[0], gallery()); assert.equal(f.released, 1)
  assert.equal(f.sourceChecks.at(-1).author.id, 'human-1')
  const raw = await f.raw(); for (const value of ['thumbUrl', 'base64', 'ephemeral=thumbnail', '初音未来', 'keyword', 'https://', SECRET]) assert.equal(raw.includes(value), false, value)
})
test('renderer errors or definite card rejection return the complete first-eight text list without false delivery claims', redisTest, async t => {
  for (const mode of ['render', 'failed', 'missing-port']) await t.test(mode, async t => {
    const f = await fixture(t, mode === 'render' ? { render: async () => { throw Error(SECRET) } } : mode === 'failed' ? { image: async () => ({ state: 'failed' }) } : {})
    const outcome = await f.search(undefined, mode === 'missing-port' ? f.context({ sendImage: undefined }) : f.context())
    assert.equal(outcome.status, 'succeeded'); assert.match(outcome.content, /文字结果/u); assert.match(outcome.content, /8\. 作品8/u)
    assert.doesNotMatch(outcome.content, /9\. 作品9|已确认送达|PRIVATE/u); assert.equal(f.images.length, mode === 'failed' ? 1 : 0)
  })
})
test('card unknown, malformed sent receipt or throwing send never exposes a text fallback or resends after restart', redisTest, async t => {
  for (const mode of ['unknown', 'no-id', 'throw']) await t.test(mode, async t => {
    const f = await fixture(t, { image: async () => { if (mode === 'throw') throw Error(SECRET); return mode === 'no-id' ? { state: 'sent' } : { state: 'unknown' } } }), ctx = f.context()
    const first = await f.search(undefined, ctx); assert.equal(first.status, 'unknown'); assert.doesNotMatch(first.content, /作品1|126649495|PRIVATE/u)
    f.restart(); assert.equal((await f.search(undefined, ctx)).status, 'unknown'); assert.equal(f.images.length, 1)
  })
})
test('a newer started search fences an older late provider result from saving or sending', redisTest, async t => {
  const held = gate(), reached = gate(), f = await fixture(t)
  t.after(() => held.release())
  f.setSearch(async input => { if (input.keyword === '旧查询') { reached.release(); await held.promise }; return result({ keyword: input.keyword, items: [item(input.keyword === '旧查询' ? 0 : 1)] }) })
  const old = f.search({ keyword: '旧查询' }); await reached.promise
  assert.equal((await f.search({ keyword: '新查询' })).status, 'succeeded'); held.release()
  assert.equal((await old).status, 'failed'); assert.equal(f.images.length, 1)
  assert.equal((await f.store.load(f.binding)).data.items[0].id, '126649496')
})
test('indexed downloads require a live original source and an authorization port on every load', redisTest, async t => {
  for (const mode of ['recalled', 'missing-port', 'rebind', 'expired']) await t.test(mode, async t => {
    const f = await fixture(t), ctx = f.context(); await f.search(undefined, ctx)
    let download = f.context()
    if (mode === 'recalled') f.knownSources.set(ctx.request.messageId, false)
    if (mode === 'missing-port') download.isSourceAvailable = undefined
    if (mode === 'rebind') download.binding = { ...download.binding, revision: 'r2' }
    if (mode === 'expired') f.advance(300000)
    assert.equal((await f.download('1', download)).status, 'failed'); assert.equal(f.preparations.length, 0); assert.equal(f.relays.length, 0)
  })
})
test('standalone IDs work without a list while accepted short index aliases stay bounded to one selection', redisTest, async t => {
  const f = await fixture(t)
  assert.equal((await f.download('126649495', f.context({ isSourceAvailable: undefined }))).status, 'succeeded')
  await f.search()
  for (const target of ['#1', 'No.2', 'No3', '第4']) assert.equal((await f.download(target)).status, 'succeeded', target)
  const before = f.preparations.length
  for (const target of ['0', '9', '20', '0126649495', '1234', '1,2', '1、2', 'magnet:?xt=private', '126649495 extra']) assert.equal((await f.download(target)).status, 'failed', target)
  assert.equal(f.preparations.length, before)
})
test('confirmed image delivery alone renews the selected session; metadata-only, failed and unknown do not', redisTest, async t => {
  for (const mode of ['sent', 'failed', 'unknown', 'metadata']) await t.test(mode, async t => {
    const f = await fixture(t); await f.search(); const original = await f.store.load(f.binding); f.advance(200000)
    if (mode !== 'metadata') f.setRelay(async () => mode === 'sent' ? sent() : { state: mode })
    else f.setPrepare((_share, _context, prepared) => ({ ...prepared, status: 'metadata-only', plan: gallery(0) }))
    const outcome = await f.download(); assert.equal(outcome.status, mode === 'failed' ? 'failed' : mode === 'unknown' ? 'unknown' : 'succeeded')
    assert.equal((await f.store.load(f.binding)).savedAt, mode === 'sent' ? NOW + 200000 : original.savedAt)
    assert.equal(f.released, 1)
  })
})
test('a newer list created during a download is never overwritten or extended by the old confirmed receipt', redisTest, async t => {
  const f = await fixture(t); await f.search(); f.advance(100000)
  const held = gate(), reached = gate(); t.after(() => held.release())
  f.setRelay(async () => { reached.release(); await held.promise; return sent() })
  const pending = f.download(); await reached.promise
  f.setSearch(async input => result({ keyword: input.keyword, items: [item(1)] })); await f.search(); const next = await f.store.load(f.binding)
  f.advance(1000); held.release(); assert.equal((await pending).status, 'succeeded')
  assert.deepEqual(await f.store.load(f.binding), next)
})
test('restricted list entries fail before relay preparation unless explicitly allowed by the host', redisTest, async t => {
  for (const allowRestricted of [false, true]) await t.test(String(allowRestricted), async t => {
    const f = await fixture(t, { config: { allowRestricted }, search: async input => result({ keyword: input.keyword, items: [item(0, { xRestrict: 1 })] }) })
    await f.search(); assert.equal((await f.download()).status, allowRestricted ? 'succeeded' : 'failed')
    assert.equal(f.preparations.length, allowRestricted ? 1 : 0)
  })
})
test('relay plans retain complete 16MiB images and reject excess count, bytes, changed IDs or video parts', redisTest, async t => {
  for (const mode of ['16MiB', 'too-large', 'too-many', 'total', 'wrong-id', 'query', 'restricted', 'video']) await t.test(mode, async t => {
    const f = await fixture(t, { prepare: (_share, _context, prepared) => ({ ...prepared,
      ...(mode === 'wrong-id' ? { pageUrl: 'https://www.pixiv.net/artworks/126649496' } : {}), ...(mode === 'query' ? { pageUrl: prepared.pageUrl + '?token=PRIVATE' } : {}),
      ...(mode === 'restricted' ? { status: 'restricted' } : {}), plan: mode === '16MiB' ? gallery(2, 16 * MiB) : mode === 'too-large' ? gallery(1, 16 * MiB + 1)
        : mode === 'too-many' ? gallery(6, MiB) : mode === 'total' ? gallery(3, 16 * MiB) : mode === 'video' ? { version: 1, items: [{ parts: [{ kind: 'video', artifact: { ...gallery(1).items[1].parts[0].artifact, kind: 'video', mime: 'video/mp4' } }] }] } : prepared.plan }) })
    assert.equal((await f.download('126649495')).status, mode === '16MiB' ? 'succeeded' : 'failed')
    assert.equal(f.relays.length, mode === '16MiB' ? 1 : 0); assert.equal(f.released, 1)
    if (mode === '16MiB') assert.equal(f.relays[0].items[1].parts[0].artifact.sizeBytes, 16 * MiB)
  })
})
test('download pending and unknown markers prohibit duplicate effects across recreated registries', redisTest, async t => {
  const f = await fixture(t, { relay: async () => ({ state: 'unknown' }) }), ctx = f.context()
  assert.equal((await f.download('126649495', ctx)).status, 'unknown'); f.restart()
  assert.equal((await f.download('126649495', ctx)).status, 'unknown'); assert.equal(f.relays.length, 1); assert.equal(f.preparations.length, 1)
  const next = f.context(); await f.store.claimAttempt(f.binding, next.request.messageId, 'download'); f.restart()
  assert.equal((await f.download('126649495', next)).status, 'unknown'); assert.equal(f.relays.length, 1)
})
test('aborted in-flight image and relay sends become durable unknown without text fallback or another effect', redisTest, async t => {
  for (const kind of ['search', 'download']) await t.test(kind, async t => {
    const held = gate(), reached = gate(), send = async () => { reached.release(); await held.promise; return sent() }
    t.after(() => held.release())
    const f = await fixture(t, kind === 'search' ? { image: send } : { relay: send }), ctx = f.context()
    const pending = kind === 'search' ? f.search(undefined, ctx) : f.download('126649495', ctx)
    await reached.promise; ctx.controller.abort()
    const outcome = await pending; assert.equal(outcome.status, 'unknown'); assert.doesNotMatch(outcome.content, /作品1|文字结果/u)
    held.release(); f.restart()
    assert.equal((await (kind === 'search' ? f.search(undefined, ctx) : f.download('126649495', ctx))).status, 'failed', 'revoked context remains unavailable')
    const fresh = f.context({ request: ctx.request })
    assert.equal((await (kind === 'search' ? f.search(undefined, fresh) : f.download('126649495', fresh))).status, 'unknown')
    assert.equal(f.images.length + f.relays.length, 1)
  })
})
test('late cancelled preparations release their lease and cannot dispatch or restore session data', redisTest, async t => {
  const held = gate(), reached = gate(), f = await fixture(t, { prepare: async (_share, _scope, prepared) => { reached.release(); await held.promise; return prepared } })
  t.after(() => held.release())
  const ctx = f.context(), pending = f.download('126649495', ctx); await reached.promise; ctx.controller.abort()
  assert.equal((await pending).status, 'failed'); held.release(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.relays.length, 0); assert.equal(f.released, 1)
})
test('revoking the selected search source while preparing prevents late download delivery', redisTest, async t => {
  const f = await fixture(t), original = f.context(); await f.search(undefined, original)
  f.setPrepare((_share, _scope, prepared) => { f.knownSources.set(original.request.messageId, false); return prepared })
  assert.equal((await f.download()).status, 'failed'); assert.equal(f.relays.length, 0); assert.equal(f.released, 1)
})
test('nonhuman, missing request, closed input, secret and policy failures never call a provider or send', redisTest, async t => {
  const f = await fixture(t)
  for (const ctx of [f.context({ actor: { kind: 'autonomous' } }), f.context({ actor: { kind: 'commitment' } }), f.context({ request: undefined }),
    f.context({ actor: { kind: 'user', user: { platform: 'qq', namespace: 'other', id: 'human' } } })]) assert.equal((await f.search(undefined, ctx)).status, 'failed')
  for (const input of [null, [], {}, { keyword: 'x', target: 'elsewhere' }, { keyword: SECRET }, { keyword: encodeURIComponent(SECRET) },
    { keyword: Buffer.from(SECRET).toString('base64') }, { keyword: 'FORBIDDEN' }, { keyword: 'x', searchType: '画师' }]) assert.equal((await f.search(input)).status, 'failed')
  let touched = false; assert.equal((await f.search({ get keyword() { touched = true; return 'x' } })).status, 'failed'); assert.equal(touched, false)
  assert.equal(f.searches.length, 0); assert.equal(f.images.length, 0)
})
test('provider secrets and invalid rendered images fail without leaking details or writing unsafe session metadata', redisTest, async t => {
  const f = await fixture(t, { search: async input => result({ keyword: input.keyword, items: [item(0, { title: SECRET })] }) })
  const outcome = await f.search(); assert.equal(outcome.status, 'failed'); assert.equal(f.images.length, 0); assert.equal((await f.raw()).includes(SECRET), false)
  assert.doesNotMatch(outcome.content, /PRIVATE/u)
})
