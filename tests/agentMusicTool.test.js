import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentMusicTool, createAgentMusicProvider } from '../dist/backend/modules/media/infrastructure/agentMusicTool.js'
import { createAgentTools } from '../dist/backend/modules/tools/infrastructure/agentTools.js'

const HOST_SECRET = 'music-host-private-token-123456/+='
const COOKIE_SECRET = 'music-explicit-cookie-key=='
const NOW = 1_800_000_000_000
const cookie = `uin=123456;qm_keyst=${COOKIE_SECRET};psrf_qqunionid=old-union-value;psrf_musickey_createtime=${NOW / 1000}`
const song = (mid = 'song0') => ({ mid, title: '歌曲标题', singer: [{ name: '歌手', mid: 'singer0' }], album: { mid: 'album0' }, file: {} })
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
function fixture(config = {}, options = {}, overrides = {}) {
  const requests = [], sent = [], ensured = []
  const controller = new AbortController()
  const context = { binding: { id: 'binding', agentId: 'agent', revision: 'revision', target: { account: { platform: 'qq', namespace: 'global', id: '987654' }, kind: 'group', id: '345678' } },
    actor: { kind: 'user', user: { platform: 'qq', namespace: 'global', id: '456789' } }, request: { messageId: 'request', text: '放首歌', mentions: [] },
    signal: controller.signal, isCurrent: () => true, async ensureCurrent() { ensured.push('ensure') },
    async sendMusic(music) { sent.push(music); return { state: 'sent', messageId: 'confirmed-music-id' } }, ...overrides }
  const tool = createAgentMusicTool({ enabled: true, ...config }, { now: () => NOW, secrets: [HOST_SECRET],
    async fetchImpl(url, init) { const body = JSON.parse(init.body); requests.push({ url, init, body })
      return json(body.search ? { code: 0, search: { data: { body: { song: { list: [song(), song('song1')] } } } } } : { req_0: { data: { midurlinfo: [{ purl: 'audio.m4a?vkey=ephemeral-only-play-key' }] } } })
    }, ...options })
  return { tool, context, controller, requests, sent, ensured, execute: input => tool.execute(input, context) }
}

test('music keeps original name and closed two-parameter schema, uses only scoped card delivery', async () => {
  const f = fixture({ cookie })
  assert.equal(f.tool.name, 'searchMusicTool'); assert.equal(f.tool.timeoutMs, 90000)
  assert.deepEqual(Object.keys(f.tool.parameters.properties), ['keyword', 'isArtistOnly'])
  assert.equal(f.tool.parameters.additionalProperties, false)
  const result = await f.execute({ keyword: '晴天' })
  assert.equal(result.status, 'succeeded'); assert.equal(f.sent.length, 1); assert.ok(f.ensured.length >= 4)
  assert.equal(f.sent[0].title, '歌曲标题'); assert.equal(f.sent[0].artist, '歌手')
  assert.match(f.sent[0].pageUrl, /song0\.html$/u); assert.match(f.sent[0].audioUrl, /ephemeral-only-play-key/u)
  assert.equal(f.requests[0].init.headers.Cookie, cookie)
})

test('registered music requires a verified human group request and scopes the effect before provider calls', async () => {
  const f = fixture()
  const presentPorts = []
  let scope = f.context
  const registry = createAgentTools({ builtIn: [{ ...f.tool, async execute(input, scoped) {
    presentPorts.push(...['sendMusic', 'sendMessage', 'interact'].filter(name => name in scoped))
    return f.tool.execute(input, scoped)
  } }] }, { signal: f.controller.signal, context: () => scope })
  const [registered] = registry.getExtraTools(['searchMusicTool'])
  const input = { keyword: '晴天', isArtistOnly: false }
  assert.match(await registered.execute({ ...input, isArtistOnly: 'false' }, {}), /^error: .*Schema/u)
  for (const overrides of [
    { actor: { kind: 'autonomous' } },
    { actor: { kind: 'commitment' } },
    { request: undefined },
    { sendMusic: undefined },
    { binding: { ...f.context.binding, target: { ...f.context.binding.target, kind: 'friend' } } },
  ]) {
    scope = { ...f.context, ...overrides }
    const result = await registered.execute(input, {})
    assert.equal(result.status, 'error')
    assert.match(result.content, /真人请求和音乐投递权限/u)
  }
  assert.deepEqual(f.requests, [])
  assert.deepEqual(f.sent, [])
  assert.deepEqual(presentPorts, [])

  scope = { ...f.context, sendMessage() {}, interact() {} }
  const result = await registered.execute(input, {})
  assert.equal(result.status, 'success')
  assert.match(result.content, /confirmed-music-id/u)
  assert.equal(f.requests.length, 2)
  assert.equal(f.sent.length, 1)
  assert.deepEqual(presentPorts, ['sendMusic'])
})

test('song requests select first and artist requests select randomly with actual pool size', async () => {
  const f = fixture({}, { random: () => .99 })
  const first = await f.execute({ keyword: '指定歌曲' })
  assert.equal(first.status, 'succeeded'); assert.equal(f.requests[0].body.search.param.num_per_page, 1)
  assert.match(f.sent[0].pageUrl, /song0\.html$/u)
  const artist = await f.execute({ keyword: '歌手', isArtistOnly: true })
  assert.equal(artist.status, 'succeeded'); assert.equal(f.requests[2].body.search.param.num_per_page, 20)
  assert.match(f.sent[1].pageUrl, /song1\.html$/u); assert.match(artist.content, /从2首候选中随机选择/u)
})

test('empty search results fail without dispatching a card', async () => {
  for (const payload of [{ code: 1 }, { code: 0, search: { data: { body: { song: { list: [] } } } } }]) {
    const f = fixture({}, { fetchImpl: async () => json(payload) })
    const result = await f.execute({ keyword: '不存在的歌' })
    assert.equal(result.status, 'failed'); assert.match(result.content, /未找到/u); assert.equal(f.sent.length, 0)
  }
})

test('disabled/missing media capability, injected targets, extra URLs and malformed inputs never issue HTTP', async () => {
  for (const input of [null, [], {}, { keyword: ' ' }, { keyword: 1 }, { keyword: 'x'.repeat(201) }, { keyword: 'bad\u0000' },
    { keyword: 'song', isArtistOnly: 'true' }, { keyword: 'song', audioUrl: 'https://other.test' }, { keyword: 'song', target: 'other' },
    { keyword: 'song', accountId: 'other' }, { keyword: 'song', cookie: 'other' }]) {
    const f = fixture(); assert.equal((await f.execute(input)).status, 'failed'); assert.equal(f.requests.length, 0); assert.equal(f.sent.length, 0)
  }
  const getter = Object.defineProperty({}, 'keyword', { get() { throw new Error('must not read') } })
  assert.equal((await fixture().execute(getter)).status, 'failed')
  for (const f of [fixture({ enabled: false }), fixture({}, {}, { sendMusic: undefined })]) {
    assert.equal((await f.execute({ keyword: 'song' })).status, 'failed'); assert.equal(f.requests.length, 0)
  }
})

test('host and cookie credentials in original/Unicode/percent/Base64 inputs are rejected before HTTP', async () => {
  for (const secret of [HOST_SECRET, COOKIE_SECRET]) for (const keyword of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('base64url'),
    [...secret].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')]) {
    const f = fixture({ cookie })
    assert.equal((await f.execute({ keyword })).status, 'failed'); assert.equal(f.requests.length, 0)
  }
  const f = fixture({}, { allowsText: value => !value.includes('blocked') })
  assert.equal((await f.execute({ keyword: 'blocked' })).status, 'failed'); assert.equal(f.requests.length, 0)
})

test('forbidden provider metadata and credentials fail without a card and without revealing upstream details', async () => {
  for (const title of ['blocked', HOST_SECRET, encodeURIComponent(HOST_SECRET)]) {
    const f = fixture({}, { allowsText: value => !value.includes('blocked'), fetchImpl: async () => json({ code: 0, search: { data: { body: { song: { list: [{ ...song(), title }] } } } } }) })
    const result = await f.execute({ keyword: '歌曲' })
    assert.equal(result.status, 'failed'); assert.equal(f.sent.length, 0); assert.doesNotMatch(result.content, /blocked|private-token/u)
  }
})

test('shared provider refreshed credentials are immediately blocked in subsequent model inputs', async () => {
  const requests = [], persisted = []
  const options = { secrets: [HOST_SECRET], now: () => NOW, async onCookieRefresh(value) { persisted.push(value) }, async fetchImpl(_url, init) {
    const body = JSON.parse(init.body); requests.push(body)
    if (body.req_0?.method === 'Login') return json({ req_0: { code: 0, data: { openid: 'new-open-value', refresh_token: 'new-refresh-value==', access_token: 'new-access-value==',
      str_musicid: '123456', musickey: 'new-music-key==', musickeyCreateTime: NOW / 1000, unionid: 'new-union-value', encryptUin: 'new-encrypted-value==' } } })
    return json(body.search ? { code: 0, search: { data: { body: { song: { list: [song()] } } } } } : { req_0: { data: { midurlinfo: [] } } })
  } }
  const config = { enabled: true, cookie: cookie.replace(String(NOW / 1000), '1') }
  const provider = createAgentMusicProvider(config, options)
  const f = fixture(config, { ...options, provider })
  assert.equal((await f.execute({ keyword: '歌曲' })).status, 'succeeded'); assert.equal(persisted.length, 1)
  const before = requests.length
  assert.equal((await f.execute({ keyword: 'new-access-value==' })).status, 'failed')
  assert.equal((await f.execute({ keyword: encodeURIComponent('new-music-key==') })).status, 'failed')
  assert.equal(requests.length, before)
})

test('confirmed receipts include safe title/artist/song ID and message ID, never signed playback URLs', async () => {
  const f = fixture()
  const result = await f.execute({ keyword: '歌曲' })
  assert.equal(result.status, 'succeeded')
  assert.match(result.content, /歌曲标题/u); assert.match(result.content, /歌手/u); assert.match(result.content, /歌曲ID：song0/u); assert.match(result.content, /confirmed-music-id/u)
  assert.doesNotMatch(result.content, /https?:|vkey|ephemeral-only|private-token/u)
})

test('unknown/missing ID/throwing/hung card send dispatch once without fallback or repeat', async () => {
  for (const mode of ['unknown', 'no-id', 'throw', 'hung', 'failed']) {
    let sends = 0
    const f = fixture({}, { timeoutMs: 25 }, { async sendMusic() {
      sends++
      if (mode === 'throw') throw new Error(HOST_SECRET)
      if (mode === 'hung') return new Promise(() => {})
      return mode === 'no-id' ? { state: 'sent' } : { state: mode }
    } })
    const keepAlive = setTimeout(() => {}, 1000)
    try { const result = await f.execute({ keyword: '歌曲' }); assert.equal(result.status, mode === 'failed' ? 'failed' : 'unknown'); assert.equal(sends, 1); assert.doesNotMatch(result.content, /private-token|http/u) }
    finally { clearTimeout(keepAlive) }
  }
})

test('revoked/cancelled provider work or private service errors never dispatch a card', async () => {
  let current = true
  const revoked = fixture({}, { fetchImpl: async () => { current = false; return json({ code: 0 }) } }, { isCurrent: () => current })
  assert.equal((await revoked.execute({ keyword: '歌曲' })).status, 'failed'); assert.equal(revoked.sent.length, 0)
  const aborted = fixture(); aborted.controller.abort()
  assert.equal((await aborted.execute({ keyword: '歌曲' })).status, 'failed'); assert.equal(aborted.requests.length, 0)
  for (const fetchImpl of [async () => { throw new Error(HOST_SECRET) }, () => new Promise(() => {})]) {
    const f = fixture({}, { fetchImpl, timeoutMs: 20 }); const keepAlive = setTimeout(() => {}, 1000)
    try { const result = await f.execute({ keyword: '歌曲' }); assert.equal(result.status, 'failed'); assert.equal(f.sent.length, 0); assert.doesNotMatch(result.content, /private-token/u) }
    finally { clearTimeout(keepAlive) }
  }
})
