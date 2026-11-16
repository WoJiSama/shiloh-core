import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { createAgentMusicProvider } from '../dist/backend/modules/media/infrastructure/agentMusicProvider.js'

const NOW = 1_800_000_000_000
const HOST_SECRET = 'music-host-private-credential-789/+='
const oldCookie = `uin=123456;qm_keyst=old-music-key==;psrf_qqunionid=old-union-value;psrf_qqopenid=old-open-value;psrf_qqaccess_token=old-access-value;psrf_qqrefresh_token=old-refresh-value;psrf_musickey_createtime=1;empty=`
const freshCookie = oldCookie.replace('psrf_musickey_createtime=1', `psrf_musickey_createtime=${NOW / 1000}`)
const song = (mid = 'song0', patch = {}) => ({ mid, title: `<em>${mid}标题</em>`, singer: [{ name: '歌手', mid: 'singer0' }], album: { mid: 'album0' },
  file: { media_mid: 'media0', size_flac: 100, size_320mp3: 20 }, ...patch })
const searchResult = songs => ({ code: 0, search: { code: 0, data: { body: { song: { list: songs } } } } })
const vkeyResult = purl => ({ code: 0, req_0: { code: 0, data: { midurlinfo: [{ purl }] } } })
const loginResult = patch => ({ code: 0, req_0: { code: 0, data: { openid: 'new-open-value', refresh_token: 'new-refresh-value==', access_token: 'new-access-value==',
  str_musicid: '654321', musickey: 'new-music-key==', musickeyCreateTime: NOW / 1000, unionid: 'new-union-value', encryptUin: 'new-encrypted-value==', ...patch } } })
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const context = overrides => ({ signal: new AbortController().signal, isCurrent: () => true, async ensureCurrent() {}, ...overrides })
const input = patch => ({ keyword: '关键词', accountId: '987654', ...patch })
function fixture(config = {}, options = {}) {
  const requests = [], persisted = [], registered = []
  const provider = createAgentMusicProvider({ enabled: true, ...config }, { now: () => NOW, secrets: [HOST_SECRET],
    async fetchImpl(url, init) { const body = JSON.parse(init.body); requests.push({ url, init, body }); return json(body.search ? searchResult([song()]) : body.req_0.method === 'Login' ? loginResult() : vkeyResult('C400song0.m4a?vkey=ephemeral-play-key')) },
    registerSecrets: values => registered.push(...values), async onCookieRefresh(cookie) { persisted.push(cookie) }, ...options })
  return { provider, requests, persisted, registered }
}

test('fixed search/vkey protocol uses explicit cookie, song first result and current account only', async () => {
  const f = fixture({ cookie: freshCookie })
  const result = await f.provider.search(input(), context())
  assert.equal(result.id, 'song0'); assert.equal(result.poolSize, 1)
  assert.equal(result.music.title, 'song0标题'); assert.equal(result.music.artist, '歌手')
  assert.match(result.music.pageUrl, /song0\.html$/u); assert.match(result.music.coverUrl, /T002R150x150M000album0\.jpg$/u)
  assert.equal(f.requests.length, 2)
  const [search, vkey] = f.requests
  assert.equal(search.url, 'https://u.y.qq.com/cgi-bin/musicu.fcg')
  assert.equal(search.init.redirect, 'error'); assert.ok(search.init.signal instanceof AbortSignal)
  assert.equal(search.init.headers.Cookie, freshCookie)
  assert.deepEqual(search.body.search.param, { grp: 1, num_per_page: 1, page_num: 1, query: '关键词', remoteplace: 'miniapp.1109523715', search_type: 0, searchid: String(NOW) })
  assert.equal(search.body.search.method, 'DoSearchForQQMusicMobile')
  assert.equal(vkey.body.req_0.method, 'CgiGetVkey'); assert.equal(vkey.body.comm.authst, 'old-music-key=='); assert.equal(vkey.body.comm.uin, '123456')
  assert.deepEqual(vkey.body.req_0.param.filename, ['F000media0.flac', 'M800media0.mp3'])
  assert.equal(f.persisted.length, 0)
})

test('artist request selects randomly from at most twenty valid songs, song request selects first', async () => {
  const requests = []
  const f = fixture({}, { random: () => .999, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body)
    return json(body.search ? searchResult([null, { mid: 'invalid' }, ...Array.from({ length: 25 }, (_, index) => song(`s${index}`))]) : vkeyResult('audio.m4a'))
  } })
  const artist = await f.provider.search(input({ isArtistOnly: true }), context())
  assert.equal(artist.poolSize, 20); assert.equal(artist.id, 's19'); assert.equal(requests[0].search.param.num_per_page, 20)
  const single = await f.provider.search(input(), context())
  assert.equal(single.id, 's0'); assert.equal(single.poolSize, 1); assert.equal(requests[2].search.param.num_per_page, 1)
})

test('alternate item_song response, video/album/singer cover priority and all quality prefixes remain supported', async () => {
  const requests = []
  const f = fixture({}, { fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body); requests.push(body)
    return json(body.search ? { code: 0, search: { data: { body: { item_song: [song('song0', { vs: ['', 'video0'], file: { media_mid: 'media0',
      size_flac: 1, size_hires: 1, size_96ogg: 1, size_320mp3: 1, size_192ogg: 1, size_128mp3: 1, size_96aac: 1 } })] } } } } : vkeyResult(''))
  } })
  assert.match((await f.provider.search(input(), context())).music.coverUrl, /T062R150x150M000video0/u)
  assert.deepEqual(requests[1].req_0.param.filename, ['F000media0.flac', 'RS01media0.flac', 'O800media0.ogg', 'M800media0.mp3', 'O600media0.ogg', 'M500media0.mp3', 'C400media0.m4a'])
  const singer = fixture({}, { fetchImpl: async (_url, init) => json(JSON.parse(init.body).search ? searchResult([song('song0', { album: {} })]) : vkeyResult('')) })
  assert.match((await singer.provider.search(input(), context())).music.coverUrl, /T001R150x150M000singer0/u)
})

test('ordinary nonzero/failed vkey falls back to event account c6 preview, while missing artwork fails', async () => {
  for (const vkey of [() => json({ code: 1 }), () => json({ req_0: { code: 3 } }), () => json(vkeyResult('')), () => { throw new Error(HOST_SECRET) }]) {
    const f = fixture({}, { fetchImpl: async (_url, init) => JSON.parse(init.body).search ? json(searchResult([song()])) : vkey() })
    const result = await f.provider.search(input({ accountId: '998877' }), context())
    assert.match(result.music.audioUrl, /^http:\/\/c6\.y\.qq\.com\/rsc\/fcgi-bin\/fcg_pyq_play\.fcg\?/u)
    assert.match(result.music.audioUrl, /uin=998877/u)
  }
  const noCover = fixture({}, { fetchImpl: async () => json(searchResult([song('song0', { album: {}, singer: [] })])) })
  await assert.rejects(noCover.provider.search(input(), context()))
})

test('unsafe vkey URLs and raw/decoded host credentials fail closed instead of degrading to preview', async () => {
  const urls = ['https://evil.test/track', '//evil.test/track', '../track', 'track%0dInjected', 'track\\secret', `track?vkey=${encodeURIComponent(HOST_SECRET)}`]
  for (const purl of urls) {
    const f = fixture({}, { fetchImpl: async (_url, init) => json(JSON.parse(init.body).search ? searchResult([song()]) : vkeyResult(purl)) })
    await assert.rejects(f.provider.search(input(), context()), error => !error.message.includes(HOST_SECRET))
  }
  for (const value of [HOST_SECRET, encodeURIComponent(HOST_SECRET), Buffer.from(HOST_SECRET).toString('base64'), [...HOST_SECRET].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')]) {
    const f = fixture({}, { fetchImpl: async () => json({ ...searchResult([song()]), metadata: { value } }) })
    await assert.rejects(f.provider.search(input(), context()))
  }
})

test('QQ and WeChat refresh preserve JSON/form protocol, padding and register-before-persist ordering', async () => {
  for (const wechat of [false, true]) {
    const events = [], requests = []
    const cookie = wechat ? 'wxuin=123456;wxunionid=old-union-value;wxopenid=old-open-value;wxaccess_token=old-access-value;wxrefresh_token=old-refresh-value;qm_keyst=old-music-key==' : oldCookie
    const f = fixture({ cookie }, { registerSecrets(values) { events.push({ type: 'register', values }) }, async onCookieRefresh(value) { events.push({ type: 'persist', value }) },
      fetchImpl: async (_url, init) => { requests.push({ init, body: JSON.parse(init.body) }); return json(loginResult()) } })
    await f.provider.refresh(context())
    const req = requests[0]
    assert.equal(req.init.headers['Content-Type'], 'application/x-www-form-urlencoded'); assert.equal(req.init.headers.Cookie, undefined)
    assert.equal(req.body.req_0.module, 'music.login.LoginServer'); assert.equal(req.body.req_0.param.refresh_token, 'old-refresh-value')
    assert.equal(req.body.req_0.param.access_token, 'old-access-value'); assert.equal(req.body.req_0.param.musickey, 'old-music-key==')
    assert.equal(wechat ? req.body.req_0.param.strAppid : req.body.req_0.param.appid, wechat ? 'wx48db31d50e334801' : 100497308)
    assert.equal(events.at(-1).type, 'persist'); assert.equal(events.at(-2).type, 'register')
    assert.match(events.at(-1).value, /qm_keyst=new-music-key==/u)
    assert.match(events.at(-1).value, wechat ? /wxaccess_token=new-access-value==/u : /psrf_qqaccess_token=new-access-value==/u)
    assert.ok(f.provider.getSecrets().includes('new-access-value==')); assert.ok(f.provider.getSecrets().includes('old-music-key=='))
  }
})

test('ten-minute checks and twelve-hour expiry are preserved; trusted force requests a refresh', async () => {
  let now = NOW
  const f = fixture({ cookie: freshCookie }, { now: () => now })
  await f.provider.refresh(context()); now += 9 * 60 * 1000; await f.provider.refresh(context())
  assert.equal(f.requests.length, 0)
  now = NOW + 12 * 60 * 60 * 1000 + 1; await f.provider.refresh(context())
  assert.equal(f.requests.length, 1)
  await f.provider.refresh(context()); assert.equal(f.requests.length, 1)
  await f.provider.refresh(context(), { force: true }); assert.equal(f.requests.length, 2)
})

test('shared refresh uses host context; one cancelled caller cannot cancel another waiter or receive late completion', async () => {
  let finish, logins = 0
  const f = fixture({ cookie: oldCookie }, { serviceContext: context(), fetchImpl: async () => { logins++; return await new Promise(resolve => { finish = () => resolve(json(loginResult())) }) } })
  const cancelled = new AbortController()
  const first = f.provider.refresh(context({ signal: cancelled.signal }))
  const rejection = assert.rejects(first)
  const second = f.provider.refresh(context())
  for (let index = 0; index < 10 && !finish; index++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(logins, 1); cancelled.abort(); await rejection
  finish(); await second
  assert.equal(f.persisted.length, 1); assert.ok(f.provider.getSecrets().includes('new-music-key=='))
})

test('revoked host refresh and persistence failure retain old cookie; retries wait for the next ten-minute check', async () => {
  let current = true, persists = 0, logins = 0, now = NOW
  const revoked = fixture({ cookie: oldCookie }, { serviceContext: context({ isCurrent: () => current }), fetchImpl: async () => { current = false; return json(loginResult()) } })
  await assert.rejects(revoked.provider.refresh(context())); assert.equal(revoked.persisted.length, 0)
  const f = fixture({ cookie: oldCookie }, { now: () => now, async onCookieRefresh() { persists++; throw new Error(HOST_SECRET) }, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body)
    if (body.req_0?.method === 'Login') { logins++; return json(loginResult()) }
    if (body.search) { assert.equal(init.headers.Cookie, oldCookie); return json(searchResult([song()])) }
    assert.equal(body.comm.authst, 'old-music-key=='); return json(vkeyResult(''))
  } })
  await assert.rejects(f.provider.refresh(context()), error => !error.message.includes(HOST_SECRET))
  assert.equal((await f.provider.search(input(), context())).id, 'song0')
  assert.equal(persists, 1); assert.equal(logins, 1)
  now += 10 * 60 * 1000
  assert.equal((await f.provider.search(input(), context())).id, 'song0')
  assert.equal(persists, 2); assert.equal(logins, 2)
})

test('invalid refreshed cookie fails before persistence and caller/config disable prevents HTTP', async () => {
  for (const patch of [{ musickey: 'injected;cookie=value' }, { refresh_token: '' }, { str_musicid: 'bad' }, { musickeyCreateTime: 'bad' },
    { access_token: HOST_SECRET }, { musickey: encodeURIComponent(HOST_SECRET) }]) {
    const f = fixture({ cookie: oldCookie }, { fetchImpl: async () => json(loginResult(patch)) })
    await assert.rejects(f.provider.refresh(context())); assert.equal(f.persisted.length, 0)
  }
  const disabled = fixture({ enabled: false, cookie: oldCookie })
  await disabled.provider.refresh(context()); await assert.rejects(disabled.provider.search(input(), context())); assert.equal(disabled.requests.length, 0)
  const f = fixture(); const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(f.provider.search(input(), context({ signal: cancelled.signal }))); assert.equal(f.requests.length, 0)
  await assert.rejects(f.provider.refresh(context({ async ensureCurrent() { throw new Error(HOST_SECRET) } })), error => !error.message.includes(HOST_SECRET))
  const privateAbort = new AbortController(); privateAbort.abort(new Error(HOST_SECRET))
  await assert.rejects(f.provider.refresh(context({ signal: privateAbort.signal })), error => !error.message.includes(HOST_SECRET))
})

test('oversized headers/chunked bodies cancel streams, malformed depth and unsafe song metadata reject', async () => {
  let cancelled = 0
  for (const declared of [true, false]) {
    const f = fixture({}, { fetchImpl: async () => new Response(new ReadableStream({ start(controller) { if (!declared) { controller.enqueue(new Uint8Array(2 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)) } }, cancel() { cancelled++ } }),
      { headers: declared ? { 'content-length': String(2 * 1024 * 1024 + 1) } : {} }) })
    await assert.rejects(f.provider.search(input(), context()))
  }
  assert.equal(cancelled, 2)
  let deep = {}; for (let index = 0; index < 20; index++) deep = { nested: deep }
  for (const payload of [{ ...searchResult([song()]), deep }, searchResult([song('../bad')]), searchResult([song('song0', { title: 'bad\u0000' })])]) {
    const f = fixture({}, { fetchImpl: async () => json(payload) }); await assert.rejects(f.provider.search(input(), context()))
  }
})

test('HTTP fetch/body deadline and post-response authorization apply without exposing upstream detail', async () => {
  for (const fetchImpl of [() => new Promise(() => {}), async () => new Response(new ReadableStream({ start() {} })), async () => new Response(HOST_SECRET, { status: 403 })]) {
    const keepAlive = setTimeout(() => {}, 1000)
    try { await assert.rejects(fixture({}, { fetchImpl, timeoutMs: 20 }).provider.search(input(), context()), error => !error.message.includes(HOST_SECRET)) }
    finally { clearTimeout(keepAlive) }
  }
  let current = true
  const f = fixture({}, { fetchImpl: async () => { current = false; return json(searchResult([song()])) } })
  await assert.rejects(f.provider.search(input(), context({ isCurrent: () => current })))
})

test('fixed-origin protocol can run through a real local HTTP transport and never follows redirects', async () => {
  const calls = []
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(body)
    if (req.url === '/redirect') { res.writeHead(302, { location: '/forbidden' }); res.end(); return }
    assert.notEqual(req.url, '/forbidden')
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body.search ? searchResult([song()]) : vkeyResult('audio.m4a?vkey=temporary-play-key')))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const f = fixture({}, { fetchImpl: (url, init) => { assert.equal(url, 'https://u.y.qq.com/cgi-bin/musicu.fcg'); return fetch(base + '/api', init) } })
    assert.equal((await f.provider.search(input(), context())).id, 'song0'); assert.equal(calls.length, 2)
    const redirect = fixture({}, { fetchImpl: (_url, init) => fetch(base + '/redirect', init) })
    await assert.rejects(redirect.provider.search(input(), context())); assert.equal(calls.length, 3)
  } finally { server.close(); server.closeAllConnections(); await once(server, 'close') }
})
