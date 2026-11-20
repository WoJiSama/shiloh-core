import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Verify built/installed code by default; opt into isolated source validation
// without touching the shared build output while this batch is in progress.
const root = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || root), urls = new Map()
const ts = process.env.BL_CHAT_AGENT_SOURCE_TEST === '1' ? (await import('typescript')).default : undefined
function sourceUrl(relative) {
  if (!ts) return pathToFileURL(path.join(release, relative.replace(/^src\//u, 'dist/backend/').replace(/\.ts$/u, '.js'))).href
  if (urls.has(relative)) return urls.get(relative)
  const source = readFileSync(path.join(root, relative), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  const code = compiled.replace(/(\bfrom\s+)(['"])([^'"]+)\2/gu, (_all, from, quote, specifier) => {
    if (!specifier.startsWith('.')) return `${from}${quote}${import.meta.resolve(specifier)}${quote}`
    const dependency = path.relative(root, path.resolve(root, path.dirname(relative), specifier)).replace(/\.js$/u, '.ts')
    return `${from}${quote}${sourceUrl(dependency)}${quote}`
  })
  const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
  urls.set(relative, url); return url
}
const { createAgentBilibiliSearchProvider } = await import(sourceUrl('src/modules/media/infrastructure/agentBilibiliSearch.ts'))
const { bilibiliOfficialUrl } = await import(sourceUrl('src/modules/media/infrastructure/agentBilibiliRelayHttp.ts'))
const FAILURE = 'B站视频查询失败：来源、网络或内容不符合要求'
const FIRST = 'BV1xx411c7mD', SECOND = 'BV1yy411c7mE'
const B3 = 'DEVICE_PRIVATE_3', B4 = 'DEVICE_PRIVATE_4'
const address = { address: '8.8.8.8', family: 4 }
const context = (signal = new AbortController().signal) => ({ signal, isCurrent: () => true })
const response = (body, headers = {}, status = 200) => ({ status, headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body) })
const spi = () => response({ code: 0, data: { b_3: B3, b_4: B4 } })
const video = (bvid = FIRST, extra = {}) => ({ bvid, title: '相关视频', author: '作者', duration: '2:03', ...extra })
const searchResponse = (rows = [video()]) => response({ code: 0, data: { result: rows } })
const metadata = (bvid = FIRST, extra = {}) => response({ code: 0, data: { bvid, title: '详细标题', owner: { name: 'UP主' }, duration: 123, ...extra } })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function safeFailure(operation) {
  await assert.rejects(operation, error => error instanceof Error && error.message === FAILURE)
}
function fixture(handle, options = {}) {
  const calls = [], diagnostics = [], lookups = []
  const provider = createAgentBilibiliSearchProvider({
    async lookup(host) { lookups.push(host); return [address] },
    async request(url, pinned, signal, policy) {
      calls.push({ url: new URL(url), pinned, signal, policy })
      if (handle) { const result = await handle(url, signal, policy); if (result !== undefined) return result }
      if (url.pathname === '/x/frontend/finger/spi') return spi()
      if (url.pathname === '/x/web-interface/search/type') return searchResponse()
      if (url.pathname === '/x/web-interface/view') return metadata(url.searchParams.get('bvid'))
      assert.fail(`unexpected request ${url.pathname}`)
    },
    diagnostics: { emit(event) { diagnostics.push(event) } },
    ...options,
  })
  return { provider, calls, diagnostics, lookups }
}

test('keyword search preserves relevance, bounds/dedupes cards and sends only controlled device cookies', async () => {
  const rows = [video(FIRST, { title: '<em class="keyword" title=">">第一</em>&nbsp;&amp;&#x4e8c;&#39;', duration: '1:02:03', pic: 'https://untrusted.invalid/not-returned', native: { secret: 'irrelevant' } }), video(FIRST), video('BVwrong'), video(SECOND)]
  for (let i = 0; i < 12; i++) rows.push(video(`BV1xx411c7m${i}`, { title: `第 ${i} 条` }))
  const h = fixture(url => url.pathname.endsWith('/search/type') ? searchResponse(rows) : undefined)
  const result = await h.provider.search(' 测试 & 相关 ', context())
  assert.equal(result.items.length, 8)
  assert.deepEqual(result.items[0], { provider: 'bilibili', id: FIRST, title: "第一 &二'", author: '作者', durationSeconds: 3723, pageUrl: `https://www.bilibili.com/video/${FIRST}` })
  assert.equal(result.items[1].id, SECOND)
  assert.equal(new Set(result.items.map(item => item.id)).size, 8)
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.items) && result.items.every(Object.isFrozen))
  assert.equal(h.calls.length, 2)
  assert.equal(h.calls[0].policy.headers.Cookie, undefined)
  assert.equal(h.calls[1].policy.headers.Cookie, `buvid3=${B3}; buvid4=${B4}`)
  assert.equal(h.calls[1].url.hostname, 'api.bilibili.com')
  assert.deepEqual(Object.fromEntries(h.calls[1].url.searchParams), { keyword: '测试 & 相关', search_type: 'video', order: 'totalrank', page: '1' })
  assert.ok(h.calls.every(call => call.policy.maxBytes === 2 * 1024 * 1024 && call.pinned === address))
  assert.deepEqual(h.diagnostics, [])
  assert.ok(!JSON.stringify(result).includes(B3))
})

test('query resolution picks the relevant first card and never fetches playback or media', async () => {
  const h = fixture(url => url.pathname.endsWith('/search/type') ? searchResponse([video(FIRST), video(SECOND)]) : undefined)
  assert.equal((await h.provider.resolve({ query: '相关' }, context())).id, FIRST)
  assert.deepEqual(h.calls.map(call => call.url.pathname), ['/x/frontend/finger/spi', '/x/web-interface/search/type'])
})

test('zero results are normal for search and do not fabricate a resolve result', async () => {
  const h = fixture(url => url.pathname.endsWith('/search/type') ? searchResponse([]) : undefined)
  assert.deepEqual(await h.provider.search('不存在', context()), { items: [] })
  await safeFailure(h.provider.resolve({ query: '不存在' }, context()))
})

test('SPI definite failure falls back anonymously with one safe diagnostic', async () => {
  for (const broken of [response({ code: -352, message: 'native private error' }), response({ code: 0, data: { b_3: 'bad; injected=secret' } }), response('not json'), response({}, {}, 503)]) {
    const h = fixture(url => url.pathname.endsWith('/spi') ? broken : undefined)
    assert.equal((await h.provider.search('相关', context())).items[0].id, FIRST)
    assert.equal(h.calls[1].policy.headers.Cookie, undefined)
    assert.deepEqual(h.diagnostics, [{ stage: 'runtime', operation: 'bilibili_search_fingerprint', outcome: 'failed', code: 'fingerprint_unavailable_fallback' }])
    assert.ok(!JSON.stringify(h.diagnostics).includes('native'))
  }
})

test('SPI base64 b_4 tails are accepted while a rejected b_4 degrades to buvid3-only', async () => {
  const full = fixture(url => url.pathname.endsWith('/spi') ? response({ code: 0, data: { b_3: B3, b_4: '404E0022-026111822-wPC5+TsSN7zkqT5Aufv7rA==' } }) : undefined)
  assert.equal((await full.provider.search('相关', context())).items[0].id, FIRST)
  assert.equal(full.calls[1].policy.headers.Cookie, `buvid3=${B3}; buvid4=404E0022-026111822-wPC5+TsSN7zkqT5Aufv7rA==`)
  assert.deepEqual(full.diagnostics, [])
  const degraded = fixture(url => url.pathname.endsWith('/spi') ? response({ code: 0, data: { b_3: B3, b_4: 'bad; injected=secret' } }) : undefined)
  assert.equal((await degraded.provider.search('相关', context())).items[0].id, FIRST)
  assert.equal(degraded.calls[1].policy.headers.Cookie, `buvid3=${B3}`)
  assert.deepEqual(degraded.diagnostics, [])
})

test('failed diagnostics observer cannot change an anonymous successful result', async () => {
  const h = fixture(url => url.pathname.endsWith('/spi') ? response({ code: -1 }) : undefined, { diagnostics: { emit() { throw new Error('private observer failure') } } })
  assert.equal((await h.provider.search('相关', context())).items[0].id, FIRST)
})

test('SPI cancellation never downgrades and closes its late response', async () => {
  const pending = deferred(), started = deferred(), controller = new AbortController(); let closed = 0
  const h = fixture(url => { if (url.pathname.endsWith('/spi')) { started.resolve(); return pending.promise } })
  const work = h.provider.search('相关', context(controller.signal))
  await started.promise; controller.abort(); await safeFailure(work)
  pending.resolve({ ...spi(), close() { closed++ } }); await delay(15)
  assert.equal(closed, 1); assert.equal(h.calls.length, 1); assert.deepEqual(h.diagnostics, [])
})

test('stale context during SPI failure cannot trigger anonymous search', async () => {
  let current = true
  const h = fixture(url => { if (url.pathname.endsWith('/spi')) { current = false; return response({ code: -1 }) } })
  await safeFailure(h.provider.search('相关', { ...context(), isCurrent: () => current }))
  assert.equal(h.calls.length, 1); assert.deepEqual(h.diagnostics, [])
})

test('complete operation timeout prevents SPI downgrade and late metadata closes', async t => {
  const keepAlive = setInterval(() => {}, 50); t.after(() => clearInterval(keepAlive))
  const spiPending = deferred(), h = fixture(url => url.pathname.endsWith('/spi') ? spiPending.promise : undefined, { timeoutMs: 25 })
  await safeFailure(h.provider.search('相关', context()))
  assert.equal(h.calls.length, 1); assert.deepEqual(h.diagnostics, [])
  let closed = 0; spiPending.resolve({ ...spi(), close() { closed++ } }); await delay(10); assert.equal(closed, 1)
  const pending = deferred(), started = deferred(), controller = new AbortController(), q = fixture(url => {
    if (url.pathname.endsWith('/search/type')) { started.resolve(); return pending.promise }
  })
  const work = q.provider.search('相关', context(controller.signal)); await started.promise; controller.abort(); await safeFailure(work)
  pending.resolve({ ...searchResponse(), close() { closed++ } }); await delay(10); assert.equal(closed, 2)
})

test('direct official URL resolves its exact BV identity and returns reconstructed public page', async () => {
  const h = fixture()
  assert.deepEqual(await h.provider.resolve({ url: `http://m.bilibili.com/video/${FIRST}?spm_id_from=untrusted` }, context()), {
    provider: 'bilibili', id: FIRST, title: '详细标题', author: 'UP主', durationSeconds: 123, pageUrl: `https://www.bilibili.com/video/${FIRST}`,
  })
  assert.deepEqual(h.calls.map(call => call.url.pathname), ['/x/frontend/finger/spi', '/x/web-interface/view'])
  assert.equal(h.calls[1].url.searchParams.get('bvid'), FIRST)
  const wrong = fixture(url => url.pathname.endsWith('/view') ? metadata(SECOND) : undefined)
  await safeFailure(wrong.provider.resolve({ url: `https://www.bilibili.com/video/${FIRST}` }, context()))
})

test('b23 resolution follows only official redirects before exact metadata lookup', async () => {
  let closed = 0
  const h = fixture(url => {
    if (url.hostname === 'b23.tv') return { ...response('', { location: `https://www.bilibili.com/video/${FIRST}?from=share` }, 302), close() { closed++ } }
    if (url.hostname === 'www.bilibili.com') return { ...response('private HTML is never decoded', {}, 412), close() { closed++ } }
  })
  const result = await h.provider.resolve({ url: 'https://b23.tv/shortToken?from=untrusted' }, context())
  assert.equal(result.id, FIRST); assert.equal(closed, 2)
  assert.deepEqual(h.calls.map(call => call.url.pathname), ['/shortToken', `/video/${FIRST}`, '/x/frontend/finger/spi', '/x/web-interface/view'])
  assert.equal(h.calls[0].policy.headers.Cookie, undefined); assert.equal(h.calls[1].policy.headers.Cookie, undefined)
})

test('episode resolution requires exactly one matching identity and converts milliseconds', async () => {
  const episodes = [{ id: 123, title: '01', long_title: '第一集', duration: 123400 }, { id: 124, title: '其他集', duration: 999000 }]
  const h = fixture(url => url.pathname === '/pgc/view/web/season' ? response({ code: 0, result: { title: '番剧名', up_info: { uname: '番剧作者' }, episodes } }) : undefined)
  assert.deepEqual(await h.provider.resolve({ url: 'https://www.bilibili.com/bangumi/play/ep123' }, context()), {
    provider: 'bilibili', id: 'ep123', title: '第一集', author: '番剧作者', durationSeconds: 123.4, pageUrl: 'https://www.bilibili.com/bangumi/play/ep123',
  })
  for (const malformed of [[episodes[1]], [episodes[0], episodes[0]], [{ ...episodes[0], id: 123.1 }], [{ ...episodes[0], duration: '123400' }]]) {
    const q = fixture(url => url.pathname === '/pgc/view/web/season' ? response({ code: 0, result: { episodes: malformed } }) : undefined)
    await safeFailure(q.provider.resolve({ url: 'https://www.bilibili.com/bangumi/play/ep123' }, context()))
  }
})

test('resolve rejects ambiguous inputs, native keys, getters and proxies without executing them', async () => {
  const h = fixture(); let reads = 0
  const accessor = {}; Object.defineProperty(accessor, 'query', { get() { reads++; return '相关' } })
  const proxy = new Proxy({}, { get() { reads++; throw new Error('must not execute') }, ownKeys() { reads++; throw new Error('must not execute') } })
  for (const input of [{}, { query: '相关', url: `https://www.bilibili.com/video/${FIRST}` }, { query: '相关', url: undefined }, { query: '相关', endpoint: 'https://private.invalid' }, { query: undefined }, [], accessor, proxy]) await safeFailure(h.provider.resolve(input, context()))
  assert.equal(reads, 0); assert.equal(h.calls.length, 0)
})

test('malicious URL spellings and unsupported references fail before any request', async () => {
  const h = fixture()
  for (const url of ['http://127.0.0.1/video/BV1xx411c7mD', 'https://www.bilibili.com.evil.invalid/video/BV1xx411c7mD', `https://www.bilibili.com:443/video/${FIRST}`, `https://user@www.bilibili.com/video/${FIRST}`, `https://www.bilibili.com/video/${FIRST}#fragment`, `https://www.bilibili.com/a/../video/${FIRST}`, `https://www.bilibili.com/%2e%2e/video/${FIRST}`, `https://www.bilibili.com/video%2f${FIRST}`, `https://www.bilibili.com\\@evil.invalid/video/${FIRST}`, `text https://www.bilibili.com/video/${FIRST}`, `https://www.bilibili.com/video/${FIRST} trailing`, 'https://www.bilibili.com/video/BV12345678', 'https://www.bilibili.com/bangumi/play/ep0', 'https://api.bilibili.com/x/web-interface/search/type']) await safeFailure(h.provider.resolve({ url }, context()))
  assert.equal(h.calls.length, 0)
})

test('search validates the bounded keyword before networking', async () => {
  const h = fixture()
  for (const value of ['', ' '.repeat(10), 'x'.repeat(201), 'a\u0000b', '\nline', {}, null, 2]) await safeFailure(h.provider.search(value, context()))
  assert.equal(h.calls.length, 0)
  assert.equal((await h.provider.search('测'.repeat(200), context())).items.length, 1)
})

test('the search URL validator accepts only the fixed query shape', () => {
  const base = 'https://api.bilibili.com/x/web-interface/search/type?keyword=test&search_type=video&order=totalrank&page=1'
  assert.equal(bilibiliOfficialUrl(base, 'metadata').href, base)
  for (const url of [base.replace('page=1', 'page=2'), base.replace('search_type=video', 'search_type=bili_user'), base.replace('order=totalrank', 'order=click'), `${base}&callback=evil`, `${base}&keyword=again`, base.replace('keyword=test', `keyword=${'x'.repeat(201)}`), base.replace('keyword=test&', ''), base.replace('keyword=test', 'keyword=%00')]) assert.throws(() => bilibiliOfficialUrl(url, 'metadata'))
})

test('private or mixed DNS results never reach the request implementation', async () => {
  for (const addresses of [[{ address: '127.0.0.1', family: 4 }], [address, { address: '10.0.0.1', family: 4 }], [{ address: '::1', family: 6 }], [{ address: '169.254.169.254', family: 4 }], [], [{ address: '8.8.8.8', family: 6 }]]) {
    const h = fixture(undefined, { async lookup() { return addresses } })
    await safeFailure(h.provider.search('相关', context())); assert.equal(h.calls.length, 0)
  }
})

test('malicious short redirects stop before private DNS or unauthorized requests', async () => {
  for (const location of ['http://127.0.0.1/a', 'https://evil.invalid/a', `https://www.bilibili.com:443/video/${FIRST}`, `https://user@www.bilibili.com/video/${FIRST}`, `https://www.bilibili.com/a/../video/${FIRST}`, `https://www.bilibili.com/%2e%2e/video/${FIRST}`]) {
    const h = fixture(() => response('', { location }, 302))
    await safeFailure(h.provider.resolve({ url: 'https://b23.tv/abc' }, context()))
    assert.equal(h.calls.length, 1); assert.deepEqual(h.lookups, ['b23.tv'])
  }
})

test('fixed metadata requests cannot redirect to a different allowed API or change search parameters', async () => {
  for (const location of [`https://api.bilibili.com/x/web-interface/view?bvid=${FIRST}`, 'https://api.bilibili.com/x/web-interface/search/type?keyword=other&search_type=video&order=totalrank&page=1']) {
    const h = fixture(url => url.pathname.endsWith('/search/type') ? response('', { location }, 302) : undefined)
    await safeFailure(h.provider.search('相关', context())); assert.equal(h.calls.length, 2)
  }
  const h = fixture(url => url.pathname.endsWith('/view') ? response('', { location: `https://api.bilibili.com/x/web-interface/view?bvid=${SECOND}` }, 302) : undefined)
  await safeFailure(h.provider.resolve({ url: `https://www.bilibili.com/video/${FIRST}` }, context())); assert.equal(h.calls.length, 2)
})

test('malformed metadata, response budgets and API errors expose only the fixed safe error', async () => {
  const failures = [response({ code: -1, message: 'private provider error' }), response({ code: 0, data: {} }), response({ code: 0, data: { result: {} } }), response({ code: 0, data: { result: Array(1001).fill(video()) } }), response('not json'), response([], {}, 200), response('{}', { 'content-type': 'text/html' }), response('{}', { 'content-encoding': 'gzip' }), response('{}', { 'content-length': '2097153' }), response('{}', { 'content-length': '3' }), response(new Uint8Array([0xff])), response('x'.repeat(2 * 1024 * 1024 + 1))]
  for (const broken of failures) {
    let closed = 0
    const h = fixture(url => url.pathname.endsWith('/search/type') ? { ...broken, close() { closed++ } } : undefined)
    await safeFailure(h.provider.search('相关', context())); assert.equal(closed, 1)
  }
  const deep = {}; let at = deep; for (let i = 0; i < 20; i++) { at.next = {}; at = at.next }
  const h = fixture(url => url.pathname.endsWith('/search/type') ? response({ code: 0, data: { result: [], deep } }) : undefined)
  await safeFailure(h.provider.search('相关', context()))
})

test('credential filters reject raw, encoded and learned device secrets in all returned data', async () => {
  const secret = 'HOST_TOKEN_PRIVATE'
  for (const title of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), B3, Buffer.from(B4).toString('base64url')]) {
    const h = fixture(url => url.pathname.endsWith('/search/type') ? searchResponse([video(FIRST, { title })]) : undefined, { secrets: [secret] })
    await safeFailure(h.provider.search('相关', context()))
  }
  const html = [...secret].map(char => `&#${char.codePointAt(0)};`).join('')
  const h = fixture(url => url.pathname.endsWith('/search/type') ? searchResponse([video(FIRST, { title: html })]) : undefined, { secrets: [secret] })
  assert.deepEqual(await h.provider.search('相关', context()), { items: [] })
  const q = fixture(undefined, { secrets: [secret] }); await safeFailure(q.provider.search(secret, context())); assert.equal(q.calls.length, 0)
  const policy = fixture(undefined, { allowsText: text => !text.includes('相关视频') }); await safeFailure(policy.provider.search('相关', context()))
})

test('invalid row identities, unsafe HTML and malformed duration are omitted without random replacement', async () => {
  const h = fixture(url => url.pathname.endsWith('/search/type') ? searchResponse([
    video('bad'), video(FIRST, { duration: '1:99' }), video(FIRST, { title: '<em unclosed' }), video(FIRST, { title: '&#0;' }), video(FIRST, { title: '&amp;lt;em&amp;gt;有效&amp;lt;/em&amp;gt;' }), video(SECOND),
  ]) : undefined)
  const result = await h.provider.search('相关', context())
  assert.deepEqual(result.items.map(item => [item.id, item.title]), [[FIRST, '有效'], [SECOND, '相关视频']])
})

test('common named HTML entities decode completely with bounded nested decoding', async () => {
  const title = '&eacute; &auml; &euro; &hellip; &trade; &rarr; &Alpha; &hearts;'
  const h = fixture(url => url.pathname.endsWith('/search/type') ? searchResponse([
    video(FIRST, { title, author: 'Cr&egrave;me &amp; Co.' }),
    video(SECOND, { title: '&amp;amp;amp;copy; &#x1f600; &Tab; fin' }),
  ]) : undefined)
  assert.deepEqual((await h.provider.search('相关', context())).items.map(item => [item.title, item.author]), [
    ['é ä € … ™ → Α ♥', 'Crème & Co.'], ['© 😀 fin', '作者'],
  ])
  const q = fixture(url => url.pathname.endsWith('/view') ? metadata(FIRST, { title }) : undefined)
  assert.equal((await q.provider.resolve({ url: `https://www.bilibili.com/video/${FIRST}` }, context())).title, 'é ä € … ™ → Α ♥')
})

test('unresolved entities and excessive nesting never leave encoded markup in public cards', async () => {
  for (const title of ['unrecognized &DoesNotExist;', '&amp;amp;amp;amp;copy;']) {
    const h = fixture(url => url.pathname.endsWith('/search/type') ? searchResponse([video(FIRST, { title }), video(SECOND)]) : undefined)
    assert.deepEqual((await h.provider.search('相关', context())).items.map(item => item.id), [SECOND])
    const q = fixture(url => url.pathname.endsWith('/view') ? metadata(FIRST, { title }) : undefined)
    await safeFailure(q.provider.resolve({ url: `https://www.bilibili.com/video/${FIRST}` }, context()))
  }
})

test('card metadata rejects C1 controls, malformed Unicode and numeric control references in each path', async () => {
  for (const title of ['raw\u0080control', 'raw\u009fcontrol', 'raw\ud800surrogate', 'raw\udfffSurrogate', '&#128;', '&#x85;', '&#159;', '&#x1f;', '&#55296;', '&#xDFFF;', '&#x110000;']) {
    const h = fixture(url => url.pathname.endsWith('/search/type') ? searchResponse([video(FIRST, { title }), video(SECOND)]) : undefined)
    assert.deepEqual((await h.provider.search('相关', context())).items.map(item => item.id), [SECOND], JSON.stringify(title))
    const q = fixture(url => url.pathname.endsWith('/view') ? metadata(FIRST, { title }) : undefined)
    await safeFailure(q.provider.resolve({ url: `https://www.bilibili.com/video/${FIRST}` }, context()))
  }
  const author = fixture(url => url.pathname.endsWith('/search/type') ? searchResponse([video(FIRST, { author: 'bad\u0081author' }), video(SECOND)]) : undefined)
  assert.deepEqual((await author.provider.search('相关', context())).items.map(item => item.id), [SECOND])
})

test('search and resolution share the neutral card duration ceiling and isolate invalid search rows', async () => {
  for (const duration of [31_536_001, '525600:01']) {
    const h = fixture(url => url.pathname.endsWith('/search/type') ? searchResponse([video(FIRST, { duration }), video(SECOND)]) : undefined)
    assert.deepEqual((await h.provider.search('相关', context())).items.map(item => item.id), [SECOND])
    assert.equal((await h.provider.resolve({ query: '相关' }, context())).id, SECOND)
    const q = fixture(url => url.pathname.endsWith('/view') ? metadata(FIRST, { duration }) : undefined)
    await safeFailure(q.provider.resolve({ url: `https://www.bilibili.com/video/${FIRST}` }, context()))
  }
  const h = fixture(url => url.pathname.endsWith('/view') ? metadata(FIRST, { duration: 31_536_000 }) : undefined)
  assert.equal((await h.provider.resolve({ url: `https://www.bilibili.com/video/${FIRST}` }, context())).durationSeconds, 31_536_000)
  const episode = fixture(url => url.pathname === '/pgc/view/web/season' ? response({ code: 0, result: { episodes: [{ id: 123, title: '越界番剧', duration: 31_536_000_001 }] } }) : undefined)
  await safeFailure(episode.provider.resolve({ url: 'https://www.bilibili.com/bangumi/play/ep123' }, context()))
})

test('response streaming observes privacy invalidation and always closes the response', async () => {
  let current = true, closed = 0
  const h = fixture(url => url.pathname.endsWith('/search/type') ? {
    status: 200, headers: { 'content-type': 'application/json' },
    body: (async function* () { yield Buffer.from('{"code":0,'); current = false; yield Buffer.from('"data":{"result":[]}}') })(),
    close() { closed++ },
  } : undefined)
  await safeFailure(h.provider.search('相关', { ...context(), isCurrent: () => current })); assert.equal(closed, 1)
})

test('streamed metadata is bounded without trusting Content-Length', async () => {
  let closed = 0, yielded = 0
  const h = fixture(url => url.pathname.endsWith('/search/type') ? {
    status: 200, headers: { 'content-type': 'application/json' },
    body: (async function* () { for (let i = 0; i < 4; i++) { yielded++; yield Buffer.alloc(1024 * 1024, 0x20) } })(),
    close() { closed++ },
  } : undefined)
  await safeFailure(h.provider.search('相关', context()))
  assert.equal(yielded, 3); assert.equal(closed, 1)
})

test('async source revocation cancels pending metadata and prevents late cards', async t => {
  const keepAlive = setInterval(() => {}, 50); t.after(() => clearInterval(keepAlive))
  const pending = deferred(), started = deferred(); let allowed = true, closed = 0
  const h = fixture(url => { if (url.pathname.endsWith('/search/type')) { started.resolve(); return pending.promise } })
  const work = h.provider.search('相关', { ...context(), async ensureCurrent() { if (!allowed) throw new Error('private revoked provenance') } })
  await started.promise; allowed = false; await safeFailure(work)
  pending.resolve({ ...searchResponse(), close() { closed++ } }); await delay(10)
  assert.equal(closed, 1); assert.deepEqual(h.diagnostics, [])
})

test('constructor rejects invalid budgets and host secret lists with a fixed safe error', () => {
  for (const options of [null, { timeoutMs: 0 }, { timeoutMs: 15001 }, { timeoutMs: NaN }, { secrets: [1] }, { secrets: Array(257).fill('x') }, { request: 'bad' }, { allowsText: 2 }]) assert.throws(() => createAgentBilibiliSearchProvider(options), { message: FAILURE })
})
