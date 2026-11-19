import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { createAgentLifeThreadProvider } = await load('modules/simulation/infrastructure/agentLifeThreadProvider.js')
const FAILURE = '追番资料暂时不可用：参数、来源、权限、网络或内容未通过验证'
const SECRET = 'host-private-life-thread-key-123456', B3 = 'DEVICE_PRIVATE_3', B4 = 'DEVICE_PRIVATE_4'
const address = { address: '93.184.216.34', family: 4 }
const response = (body, headers = {}, status = 200) => ({ status, headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body) })
const spi = () => response({ code: 0, data: { b_3: B3, b_4: B4 } })
const results = entries => response({ code: 0, data: { result: entries } })
const episode = (extra = {}) => ({ title: '12', long_title: '向着新的明天', pub_time: 1_795_014_000, aid: 1234567, ...extra })
const season = (episodes = [episode()], extra = {}) => response({ code: 0, result: { season_id: 12345, episodes, ...extra } })
const replies = entries => response({ code: 0, data: { replies: entries } })
const comment = (message = '真实观众的看法', like = 20) => ({ like, content: { message } })
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function context(extra = {}) {
  return { binding: { source: 'configured', id: 'binding-a', revision: 'rev-a', agentId: 'agent-a', personaId: 'template-a', connectionId: 'qq-a',
    target: { account: { platform: 'qq', namespace: 'onebot', id: '10001' }, kind: 'group', id: '20001' } },
  signal: new AbortController().signal, isCurrent: () => true, async ensureCurrent() {}, ...extra }
}
function fixture(handle, options = {}) {
  const calls = [], lookups = []
  const provider = createAgentLifeThreadProvider({ secrets: [SECRET],
    async lookup(host) { lookups.push(host); return [address] },
    async request(url, pinned, signal, policy) {
      calls.push({ url: new URL(url), pinned, signal, policy })
      if (handle) { const value = await handle(url, signal, policy); if (value !== undefined) return value }
      if (url.pathname === '/x/frontend/finger/spi') return spi()
      if (url.pathname === '/x/web-interface/search/type') return results([{ season_id: 12345, title: '真实番剧' }])
      if (url.pathname === '/pgc/view/web/season') return season()
      if (url.pathname === '/x/v2/reply') return replies([comment()])
      throw Error(`unexpected fixture path ${url.pathname}`)
    }, ...options })
  return { provider, calls, lookups }
}
const paths = fixture => fixture.calls.map(call => call.url.pathname)
const assertFailure = result => { assert.deepEqual(result, { ok: false, error: FAILURE }); assert.doesNotMatch(JSON.stringify(result), /host-private|DEVICE_PRIVATE|https?:|native-private/u) }
const assertSyncFailure = result => { assert.deepEqual(result, { error: FAILURE }); assert.doesNotMatch(JSON.stringify(result), /host-private|DEVICE_PRIVATE|https?:|native-private/u) }

test('resolve uses fixed bangumi search, anonymous device cookies and prefers the first non-dubbed real season', async () => {
  const f = fixture(url => url.pathname.endsWith('/search/type') ? results([
    { season_id: 12344, title: '真实番剧（中配）' }, { season_id: 12345, title: '<em class="keyword">真实</em>&nbsp;番剧' },
    { season_id: 12346, title: '后续番剧' }, { season_id: 'not-an-id', title: '无效条目' },
  ]) : undefined)
  const result = await f.provider.resolve({ title: ' 真实番剧 ' }, context())
  assert.deepEqual(result, { ok: true, sourceId: '12345', title: '真实 番剧' })
  assert.deepEqual(paths(f), ['/x/frontend/finger/spi', '/x/web-interface/search/type'])
  assert.deepEqual(Object.fromEntries(f.calls[1].url.searchParams), { keyword: '真实番剧', search_type: 'media_bangumi' })
  assert.equal(f.calls[0].policy.headers.Cookie, undefined)
  assert.equal(f.calls[1].policy.headers.Cookie, `buvid3=${B3}; buvid4=${B4}`)
  assert.ok(f.calls.every(call => call.url.origin === 'https://api.bilibili.com' && call.pinned === address && call.policy.maxBytes === 1024 * 1024))
  assert.doesNotMatch(JSON.stringify(result), /https?:|DEVICE_PRIVATE|12344/u)
})

test('resolve retains dubbed-only fallback, reports genuine zero results and never fabricates a season ID', async () => {
  const dubbed = fixture(url => url.pathname.endsWith('/search/type') ? results([{ season_id: '12345', title: '配音版作品' }]) : undefined)
  assert.deepEqual(await dubbed.provider.resolve({ title: '作品' }, context()), { ok: true, sourceId: '12345', title: '配音版作品' })
  const empty = fixture(url => url.pathname.endsWith('/search/type') ? results([{ season_id: '0', title: '无效' }]) : undefined)
  assert.deepEqual(await empty.provider.resolve({ title: '不存在' }, context()), { ok: false, error: '没有找到符合要求的番剧资料' })
})

test('sync keeps latest episode official and audience notes separate and only examines the first three hot replies', async () => {
  const at = 1_795_014_000
  const f = fixture(url => url.pathname === '/x/v2/reply' ? replies([
    comment('真实\n观众意见', 27), comment('赞数不足', 9), comment('长看法'.repeat(50), 12), comment('第四条不能引入', 999),
  ]) : undefined)
  const result = await f.provider.sync({ sourceId: '12345', title: '真实番剧', lastEpisode: 11 }, context())
  assert.deepEqual(result, { newNotes: [
    `〔官方〕第12集「向着新的明天」（${new Date(at * 1000 + 8 * 3600_000).toISOString().slice(0, 10)} 更新）`,
    '〔观众·27赞〕真实 观众意见', `〔观众·12赞〕${'长看法'.repeat(20)}`,
  ], episode: 12 })
  assert.deepEqual(paths(f), ['/x/frontend/finger/spi', '/pgc/view/web/season', '/x/v2/reply'])
  assert.deepEqual(Object.fromEntries(f.calls[1].url.searchParams), { season_id: '12345' })
  assert.deepEqual(Object.fromEntries(f.calls[2].url.searchParams), { type: '1', oid: '1234567', sort: '1', ps: '5' })
  assert.ok(result.newNotes.every(note => note.length <= 120))
})

test('sync skips comments when there is no new episode and keeps official observations when comments are unavailable', async () => {
  const unchanged = fixture()
  assert.deepEqual(await unchanged.provider.sync({ sourceId: '12345', title: '真实番剧', lastEpisode: 12 }, context()), { newNotes: [], episode: 12 })
  assert.deepEqual(paths(unchanged), ['/x/frontend/finger/spi', '/pgc/view/web/season'])
  const none = fixture(url => url.pathname === '/pgc/view/web/season' ? season([]) : undefined)
  assert.deepEqual(await none.provider.sync({ sourceId: '12345', title: '真实番剧' }, context()), { newNotes: [] })
  for (const bad of [() => { throw Error('native-private-error') }, () => response({ code: -400, message: 'native-private-error' }),
    () => response('not JSON'), () => response({ code: 0, data: { replies: [] }, secret: SECRET })]) {
    const f = fixture(url => url.pathname === '/x/v2/reply' ? bad() : undefined)
    const result = await f.provider.sync({ sourceId: '12345', title: '真实番剧' }, context())
    assert.equal(result.episode, 12); assert.equal(result.newNotes.length, 1); assert.match(result.newNotes[0], /^〔官方〕/u)
    assert.doesNotMatch(JSON.stringify(result), /native-private|host-private|https?:/u)
  }
})

test('input and host options fail before requests for invalid titles, IDs, fields and hidden accessors', async () => {
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: 30_001 }, { timeoutMs: 1.5 }, { allowsText: false }, { secrets: [null] }, { request: true }, { lookup: 'native' }]) {
    assert.throws(() => createAgentLifeThreadProvider(options), error => error.message === FAILURE)
  }
  const f = fixture()
  for (const input of [null, {}, { title: '' }, { title: 'x'.repeat(41) }, { title: '作品\n' }, { title: SECRET },
    { title: 'https://internal.test/season' }, { title: '番剧', sourceId: '12345' }, { title: '番剧', url: 'https://elsewhere.test' },
    Object.defineProperty({}, 'title', { get() { throw Error('getter invoked') } })]) assertFailure(await f.provider.resolve(input, context()))
  for (const input of [{ sourceId: '', title: '番剧' }, { sourceId: 12345, title: '番剧' }, { sourceId: '0', title: '番剧' }, { sourceId: '01', title: '番剧' },
    { sourceId: '1/2', title: '番剧' }, { sourceId: '1'.repeat(17), title: '番剧' }, { sourceId: '12345', title: '' },
    { sourceId: '12345', title: '番剧', lastEpisode: 0 }, { sourceId: '12345', title: '番剧', lastEpisode: 1.5 },
    { sourceId: '12345', title: '番剧', lastEpisode: 1_000_001 }, { sourceId: '12345', title: '番剧', target: 'other' }]) assertSyncFailure(await f.provider.sync(input, context()))
  assert.equal(f.calls.length, 0)
})

test('fingerprint failures may fall back anonymously while valid new tokens cannot appear in search results or notes', async () => {
  const anonymous = fixture(url => url.pathname.endsWith('/spi') ? response({ code: -1, message: 'native-private-error' }) : undefined)
  assert.equal((await anonymous.provider.resolve({ title: '番剧' }, context())).ok, true)
  assert.equal(anonymous.calls[1].policy.headers.Cookie, undefined)
  const invalid = fixture(url => url.pathname.endsWith('/search/type') ? results([{ season_id: 12345, title: B3 }]) : undefined)
  assertFailure(await invalid.provider.resolve({ title: '番剧' }, context()))
  const invalidNotes = fixture(url => url.pathname === '/pgc/view/web/season' ? season([episode({ long_title: B4 })]) : undefined)
  assertSyncFailure(await invalidNotes.provider.sync({ sourceId: '12345', title: '番剧' }, context()))
})

test('provider errors and malformed untrusted JSON are fixed failures and never pass through third-party messages', async () => {
  let nested = {}; for (let index = 0; index < 24; index++) nested = { child: nested }
  for (const value of [response({ code: -400, message: 'native-private-error' }), response('not-json'), response('[]'),
    response('<!DOCTYPE html>native-private-error', { 'content-type': 'text/html' }), response({ code: 0, data: { result: [] }, extra: SECRET }),
    response(`{"code":0,"data":{"result":[]},"extra":"${SECRET.replaceAll('h', '\\u0068')}"}`),
    response({ code: 0, data: { result: [] }, nested }), results(Array(1001).fill({ season_id: 1, title: '番剧' }))]) {
    const f = fixture(url => url.pathname.endsWith('/search/type') ? value : undefined)
    assertFailure(await f.provider.resolve({ title: '番剧' }, context()))
  }
  for (const value of [season([episode()], { season_id: 99999 }), season([episode({ pub_time: -2 })]),
    season([episode({ long_title: '\u0000bad' })]), season([episode({ long_title: 'https://internal.test/raw' })])]) {
    const f = fixture(url => url.pathname === '/pgc/view/web/season' ? value : undefined)
    assertSyncFailure(await f.provider.sync({ sourceId: '12345', title: '番剧' }, context()))
  }
})

test('every metadata response is bounded, rejects compression, partial lengths and redirects before another endpoint can run', async () => {
  for (const value of [response({}, { 'content-encoding': 'gzip' }), response({}, { 'content-length': '99999999' }),
    response({}, { 'content-length': '3' }), response({}, { 'content-length': '-1' }), response({}, { 'content-type': 'text/html' }),
    response({}, { location: 'https://127.0.0.1/private' }, 302), response(Buffer.alloc(1024 * 1024 + 1)),
    { status: 200, headers: { 'content-type': 'application/json' }, body: (async function* () { yield Buffer.alloc(700_000); yield Buffer.alloc(700_000) })() },
  ]) {
    let closed = 0
    const f = fixture(url => url.pathname.endsWith('/search/type') ? { ...value, close() { closed++ } } : undefined)
    assertFailure(await f.provider.resolve({ title: '番剧' }, context()))
    assert.equal(f.calls.length, 2); assert.equal(closed, 1)
  }
})

test('metadata DNS must be entirely public and malformed or mixed answers never reach the pinned transport', async () => {
  for (const entries of [[address, { address: '127.0.0.1', family: 4 }], [{ address: '8.8.8.8', family: 6 }], [], Array(33).fill(address)]) {
    const f = fixture(undefined, { lookup: async () => entries })
    assertFailure(await f.provider.resolve({ title: '番剧' }, context()))
    assert.equal(f.calls.length, 0)
  }
})

test('complete binding identity and source fence changes across awaits discard search results and stop further HTTP', async () => {
  for (const mutate of [ctx => { ctx.binding.revision = 'rev-b' }, ctx => { ctx.binding.agentId = 'agent-b' }, ctx => { ctx.binding.personaId = 'template-b' },
    ctx => { ctx.binding.target.account.id = '10002' }, ctx => { ctx.binding.target.id = '20002' }, ctx => { ctx.binding.target.kind = 'private' },
    ctx => { ctx.ensureCurrent = async () => {} }, ctx => { ctx.isCurrent = () => true }, ctx => { ctx.signal = new AbortController().signal }]) {
    const ctx = context(), f = fixture(url => { if (url.pathname.endsWith('/search/type')) { mutate(ctx); return results([{ season_id: 12345, title: '番剧' }]) } })
    assertFailure(await f.provider.resolve({ title: '番剧' }, ctx)); assert.equal(f.calls.length, 2)
  }
  let allowed = true
  const f = fixture(url => { if (url.pathname.endsWith('/spi')) { allowed = false; throw Error('native-private-error') } })
  assertFailure(await f.provider.resolve({ title: '番剧' }, context({ isCurrent: () => allowed }))); assert.equal(f.calls.length, 1)
})

test('a cancelled HTTP wait closes its late response and never returns observed data or starts follow-up work', async () => {
  const pending = defer(), started = defer(), controller = new AbortController(); let closed = 0
  const f = fixture(url => { if (url.pathname.endsWith('/search/type')) { started.resolve(); return pending.promise } })
  const work = f.provider.resolve({ title: '番剧' }, context({ signal: controller.signal }))
  await started.promise; controller.abort(); assertFailure(await work)
  pending.resolve({ ...results([{ season_id: 12345, title: '不应返回' }]), close() { closed++ } })
  await delay(15); assert.equal(closed, 1); assert.equal(f.calls.length, 2)
})

test('sync cancellation during optional comments discards the prepared official note rather than reporting a partial success', async () => {
  const pending = defer(), started = defer(), controller = new AbortController(); let closed = 0
  const f = fixture(url => { if (url.pathname === '/x/v2/reply') { started.resolve(); return pending.promise } })
  const work = f.provider.sync({ sourceId: '12345', title: '番剧' }, context({ signal: controller.signal }))
  await started.promise; controller.abort(); assertSyncFailure(await work)
  pending.resolve({ ...replies([comment('不应出现')]), close() { closed++ } }); await delay(15)
  assert.equal(closed, 1); assert.equal(f.calls.length, 3)
})

test('hung authority and DNS are bounded by the operation deadline and late DNS cannot start transport', async () => {
  const keepAlive = setInterval(() => {}, 50)
  try {
    const authority = fixture(undefined, { timeoutMs: 15 })
    assertFailure(await authority.provider.resolve({ title: '番剧' }, context({ ensureCurrent: () => new Promise(() => {}) })))
    assert.equal(authority.calls.length, 0)
    const pending = defer(), f = fixture(undefined, { timeoutMs: 15, lookup: () => pending.promise })
    assertFailure(await f.provider.resolve({ title: '番剧' }, context()))
    pending.resolve([address]); await delay(15); assert.equal(f.calls.length, 0)
  } finally { clearInterval(keepAlive) }
})

test('host text policy and unsafe audience rows cannot introduce forbidden or URL-derived notes', async () => {
  const blocked = fixture(undefined, { allowsText: text => !text.includes('禁词') })
  assertFailure(await blocked.provider.resolve({ title: '禁词' }, context())); assert.equal(blocked.calls.length, 0)
  const f = fixture(url => url.pathname === '/x/v2/reply' ? replies([comment('https://unsafe.test/raw', 999), comment('\u0000not-text', 30), comment('有效意见', 10)]) : undefined)
  const result = await f.provider.sync({ sourceId: '12345', title: '番剧' }, context())
  assert.equal(result.newNotes.length, 2); assert.equal(result.newNotes[1], '〔观众·10赞〕有效意见')
})

test('an asynchronous response close cannot extend the complete provider deadline', async () => {
  const keepAlive = setInterval(() => {}, 50)
  try {
    const f = fixture(url => url.pathname.endsWith('/search/type') ? { ...results([{ season_id: 12345, title: '番剧' }]), close: () => new Promise(() => {}) } : undefined,
      { timeoutMs: 15 })
    assertFailure(await f.provider.resolve({ title: '番剧' }, context()))
  } finally { clearInterval(keepAlive) }
})
