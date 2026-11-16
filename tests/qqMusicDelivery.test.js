import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket, { WebSocketServer } from 'ws'
import { createQqMusicDeliveryPort, QQ_MUSIC_SEND_TIMEOUT_MS } from '../dist/backend/adapters/qqMusicDelivery.js'
import { createOneBotConnection } from '../dist/backend/adapters/oneBotConnection.js'
import { validateAgentMusicCard } from '../dist/backend/modules/media/infrastructure/agentMusicCard.js'
import { queuedDeliveryAllowed } from '../dist/backend/modules/messaging/infrastructure/deliveryScope.js'

const account = { platform: 'qq', namespace: 'global', id: '123456789' }
const target = { account, kind: 'group', id: '315320' }
const binding = { source: 'configured', id: 'music-binding', revision: 'r1', personaId: 'default', agentId: 'alice', connectionId: 'music-local', target }
const music = { title: '合成音乐卡片', artist: '合成艺人', pageUrl: 'https://y.qq.com/n/yqq/song/003ABC.html',
  audioUrl: 'http://c6.y.qq.com/rsc/fcgi-bin/fcg_pyq_play.fcg?songid=&songmid=003ABC&songtype=1&fromtag=50&uin=123456789&code=ABCDE',
  coverUrl: 'http://y.gtimg.cn/music/photo_new/T002R150x150M000001Album.jpg',
}
const action = (overrides = {}) => ({ version: 1, kind: 'music.send', target, music, ...overrides })
const success = (messageId = 6789) => ({ status: 'ok', retcode: 0, data: { message_id: messageId } })
async function waitFor(probe) {
  const until = Date.now() + 3000
  while (Date.now() < until) { const value = await probe(); if (value) return value; await delay(5) }
  assert.fail('Timed out waiting for music fixture')
}
function direct(response = success()) {
  const calls = []
  const sendMusic = createQqMusicDeliveryPort({ account, connectionId: 'music-local', async sendApi(action, params, options) {
    calls.push({ action, params, options })
    return typeof response === 'function' ? response(action, params, options) : response
  } })
  return { calls, sendMusic }
}

test('neutral music card validation owns frozen text and public URL syntax without QQ domain coupling', () => {
  const card = { ...music, title: '🙂'.repeat(300), artist: '艺'.repeat(300), pageUrl: 'https://music.example.com/song/17',
    audioUrl: 'https://cdn.example.com/audio.mp3?vkey=provider-scoped-key', coverUrl: 'https://images.example.com/cover.jpg' }
  const validated = validateAgentMusicCard(card)
  assert.deepEqual(validated, card)
  assert.notEqual(validated, card)
  assert.equal(Object.isFrozen(validated), true)
  card.title = 'mutated'
  assert.equal(Array.from(validated.title).length, 300)
  assert.equal(validateAgentMusicCard({ ...music, artist: '' }).artist, '')
  assert.equal(Object.hasOwn(validateAgentMusicCard(({ ...music, artist: undefined })), 'artist'), false)
})

test('closed music data rejects getters, symbols, inherited objects, extra fields and invalid text', async () => {
  const d = direct(); let accessed = false
  const getter = { ...music }; Object.defineProperty(getter, 'title', { get() { accessed = true; return 'unsafe' }, enumerable: true })
  for (const card of [getter, { ...music, [Symbol('hidden')]: 'secret' }, Object.assign(Object.create({ inherited: true }), music),
    { ...music, target }, { ...music, cookie: 'secret' }, { ...music, title: '' }, { ...music, title: ' ' },
    { ...music, title: '🙂'.repeat(301) }, { ...music, artist: '🙂'.repeat(301) }, { ...music, title: 'bad\0text' },
    { ...music, artist: 7 }, { ...music, coverUrl: '' }, { ...music, coverUrl: undefined },
  ]) {
    assert.throws(() => validateAgentMusicCard(card))
    assert.equal((await d.sendMusic(action({ music: card }))).state, 'failed')
  }
  assert.equal(accessed, false)
  assert.equal(d.calls.length, 0)
})

test('music URLs reject unsafe schemes, local/IP hosts, userinfo, credential queries and ambiguous URL syntax', () => {
  for (const url of ['file:///etc/passwd', 'data:text/plain,hello', 'ftp://example.com/a', 'https://127.0.0.1/a',
    'http://2130706433/a', 'http://127.1/a', 'http://[::1]/a', 'https://localhost/a', 'https://thing.local/a',
    'https://service.internal/a', 'https://service.lan/a', 'https://127.0.0.1.nip.io/a', 'https://single/a',
    'https://user:password@example.com/a', 'https://example.com/a#fragment', 'https://example.com/a\\b',
    'https://example.com/a\nb', ' https://example.com/a', 'https://example.com/a%00b', 'https://example.com/a%5cb',
    'https://example.com/a?access_token=secret', 'https://example.com/a?Cookie=secret', 'https://example.com/a?api_key=secret',
    'https://example.com/' + 'a'.repeat(4096),
  ]) for (const field of ['pageUrl', 'audioUrl', 'coverUrl']) assert.throws(() => validateAgentMusicCard({ ...music, [field]: url }), url)
})

test('QQ sends exactly one native custom music segment with content artist and no alternate send', async () => {
  const d = direct()
  assert.deepEqual(await d.sendMusic(action({ binding })), { state: 'sent', messageId: '6789' })
  assert.equal(d.calls.length, 1)
  assert.equal(d.calls[0].action, 'send_group_msg')
  assert.deepEqual(d.calls[0].params, { group_id: target.id, message: [{ type: 'music', data: { type: 'custom',
    url: music.pageUrl, audio: music.audioUrl, title: music.title, image: music.coverUrl, content: music.artist } }] })
  assert.equal(Object.isFrozen(d.calls[0].params.message[0].data), true)
  assert.equal(Object.hasOwn(d.calls[0].params.message[0].data, 'singer'), false)
  assert.deepEqual(await direct().sendMusic(action({ music: { ...music, artist: undefined } })), { state: 'sent', messageId: '6789' })
})

test('QQ provider URLs accept official variants and provider-scoped vkeys', async () => {
  for (const prefix of ['T062R150x150M000', 'T002R150x150M000', 'T001R150x150M000']) {
    const d = direct()
    assert.equal((await d.sendMusic(action({ music: { ...music, coverUrl: `https://y.gtimg.cn/music/photo_new/${prefix}001Abc.jpg`,
      audioUrl: 'https://ws.stream.qqmusic.qq.com/M500003ABC.mp3?vkey=ABC0123&guid=ab1234&uin=0&fromtag=66' } }))).state, 'sent')
    assert.equal(d.calls.length, 1)
  }
})

test('QQ restricts provider origins, shapes and c6 account/song relationship without a fallback', async () => {
  const d = direct()
  const invalid = {
    pageUrl: ['http://y.qq.com/n/yqq/song/003ABC.html', 'https://y.qq.com.evil.com/n/yqq/song/003ABC.html',
      music.pageUrl + '?redirect=https://example.com', music.pageUrl.replace('/n/', '/outside/../n/'),
      music.pageUrl.replace('y.qq.com', 'y.qq.com:443'), music.pageUrl.replace('003ABC', '003%41BC')],
    coverUrl: ['https://example.com/cover.jpg', music.coverUrl.replace('T002R150x150M000', 'T002R500x500M000'),
      music.coverUrl + '?size=100', music.coverUrl.replace('/music/', '/outside/../music/')],
    audioUrl: ['https://example.com/a.mp3', music.audioUrl.replace('songmid=003ABC', 'songmid=other'),
      music.audioUrl.replace('uin=123456789', 'uin=999999'), music.audioUrl + '&other=1', music.audioUrl + '&uin=123456789',
      music.audioUrl.replace('songtype=1', 'songtype=0'), music.audioUrl.replace('code=ABCDE', 'code=abcde'),
      'http://ws.stream.qqmusic.qq.com/../M500003ABC.mp3', 'http://ws.stream.qqmusic.qq.com/safe/../M500003ABC.mp3',
      'http://ws.stream.qqmusic.qq.com//example.com/audio.mp3', 'http://ws.stream.qqmusic.qq.com/M500003ABC%2emp3',
      'http://ws.stream.qqmusic.qq.com/M500003ABC.mp3?redirect=https://example.com',
      'http://ws.stream.qqmusic.qq.com/M500003ABC.mp3?vkey=one&vkey=two',
      'http://ws.stream.qqmusic.qq.com/M500003ABC.mp3?vkey=hello%2fworld',
    ],
  }
  for (const [field, urls] of Object.entries(invalid)) for (const url of urls) {
    assert.equal((await d.sendMusic(action({ music: { ...music, [field]: url } }))).state, 'failed', url)
  }
  assert.equal(d.calls.length, 0)
})

test('fixed QQ global account, explicit group and complete binding deny private sends and account fallback', async () => {
  const d = direct()
  for (const conversation of [{ ...target, kind: 'private' }, { ...target, kind: 'channel' }, { ...target, id: '0315320' },
    { ...target, id: null }, { ...target, id: 315320 }, { ...target, account: { ...account, id: null } },
    { ...target, account: { ...account, platform: 'telegram' } }, { ...target, account: { ...account, namespace: 'tenant' } },
    { ...target, account: { ...account, id: '999999' } }, { ...target, arbitrary: true }]) {
    assert.equal((await d.sendMusic(action({ target: conversation }))).state, 'failed')
  }
  for (const invalid of [{ ...binding, connectionId: 'other' }, { ...binding, revision: '' }, { ...binding, source: 'untrusted' },
    { ...binding, target: { ...target, id: '999999' } }, { ...binding, agentId: undefined }, { ...binding, extra: 'data' }]) {
    assert.equal((await d.sendMusic(action({ binding: invalid }))).state, 'failed')
  }
  assert.equal(d.calls.length, 0)
})

test('only ok/numeric-zero/native integer message IDs confirm music delivery', async () => {
  for (const response of [null, {}, { retcode: 0 }, success(null), success(0), success(''), success('0'), success('0007'),
    success('file-uuid'), success('echo-request-id'), success('17\n'), success(Number.MAX_SAFE_INTEGER + 1),
    { status: 'ok', retcode: '0', data: { message_id: 17 } }, { status: 'ok', retcode: 0, data: { file_id: 'uuid' } },
    { ...success(), self_id: '999999' }, { ...success(), group_id: '999999' }, { ...success(), user_id: target.id },
  ]) {
    const d = direct(response)
    assert.deepEqual(await d.sendMusic(action()), { state: 'unknown' })
    assert.equal(d.calls.length, 1)
  }
  for (const id of [-42, '-42', '42']) assert.deepEqual(await direct(success(id)).sendMusic(action()), { state: 'sent', messageId: String(id) })
})

test('schema reject is failed while native handler errors/transport exceptions remain unknown and never resend', async () => {
  for (const retcode of [200, 1200, 500, 1, -1]) {
    const d = direct({ ...success(), status: 'failed', retcode })
    assert.deepEqual(await d.sendMusic(action()), { state: 'unknown' }); assert.equal(d.calls.length, 1)
  }
  for (const retcode of [400, 1400]) assert.deepEqual(await direct({ status: 'failed', retcode }).sendMusic(action()), { state: 'failed', code: String(retcode) })
  assert.deepEqual(await direct({ state: 'failed', code: 'onebot_disconnected' }).sendMusic(action()), { state: 'failed', code: 'onebot_disconnected' })
  const thrown = direct(() => { throw Error('possibly dispatched') })
  assert.deepEqual(await thrown.sendMusic(action()), { state: 'unknown' }); assert.equal(thrown.calls.length, 1)
})

test('pre-dispatch abort or stale scope sends nothing, and the adapter uses a 30 second deadline', async () => {
  const d = direct(), controller = new AbortController(); controller.abort()
  assert.equal((await d.sendMusic(action(), { signal: controller.signal })).state, 'failed')
  assert.equal((await d.sendMusic(action(), { isCurrent: () => false })).state, 'failed')
  assert.equal(d.calls.length, 0)
  assert.equal(QQ_MUSIC_SEND_TIMEOUT_MS, 30000)
})

test('uncooperative native music transport times out as unknown after the 30 second adapter deadline', { timeout: 35000 }, async () => {
  const d = direct(() => new Promise(() => {})), started = Date.now()
  assert.deepEqual(await d.sendMusic(action()), { state: 'unknown' })
  const elapsed = Date.now() - started
  assert.ok(elapsed >= 29500 && elapsed < 34000, `Music deadline took ${elapsed}ms`)
  assert.equal(d.calls.length, 1)
  assert.equal(d.calls[0].options.signal.aborted, true)
})

for (const cancellation of ['signal', 'guard', 'target', 'binding', 'account']) {
  test(`dispatched music losing ${cancellation} becomes unknown and ignores late success`, async () => {
    let release, current = true
    const ownAccount = { ...account }, ownTarget = { ...target, account: ownAccount }, ownBinding = { ...binding, target: ownTarget }
    const d = direct(() => new Promise(resolve => { release = resolve })), controller = new AbortController()
    const pending = d.sendMusic(action({ target: ownTarget, binding: ownBinding }), { signal: controller.signal, isCurrent: () => current })
    await waitFor(() => release)
    if (cancellation === 'signal') controller.abort()
    else if (cancellation === 'guard') current = false
    else if (cancellation === 'target') ownTarget.id = '999999'
    else if (cancellation === 'binding') ownBinding.revision = 'r2'
    else ownAccount.id = '999999'
    assert.deepEqual(await Promise.race([pending, delay(500).then(() => 'timeout')]), { state: 'unknown' })
    assert.equal(d.calls[0].options.signal.aborted, true)
    release(success(7777)); await delay(5); assert.equal(d.calls.length, 1)
  })
}

test('music card is captured immutably and queue scope is revoked before publishing', async () => {
  let enter, current = true, published = 0
  const ownMusic = { ...music }, d = direct(async (_action, params, options) => {
    enter = true; await delay(40)
    assert.equal(params.message[0].data.title, music.title)
    assert.equal(params.message[0].data.audio, music.audioUrl)
    if (options.isCurrent() && queuedDeliveryAllowed()) published++
    return success()
  })
  const pending = d.sendMusic(action({ music: ownMusic }), { isCurrent: () => current })
  await waitFor(() => enter); ownMusic.title = 'replacement'; ownMusic.audioUrl = 'https://example.com/replacement.mp3'; current = false
  assert.deepEqual(await pending, { state: 'unknown' }); await delay(50); assert.equal(published, 0)
})

async function fixture(t, transport) {
  const requests = [], peers = []
  let peer, server, url, handler = () => success()
  const attach = socket => {
    peer = socket; peers.push(socket); socket.on('error', () => {})
    socket.on('message', raw => {
      const request = JSON.parse(String(raw)); requests.push(request)
      const response = request.action === 'get_login_info' ? { status: 'ok', retcode: 0, data: { user_id: account.id, nickname: '音乐合成验收' } } : handler(request, socket)
      if (response) socket.send(JSON.stringify({ ...response, echo: request.echo }))
    })
    return socket
  }
  if (transport === 'forward-websocket') {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening')
    server.on('connection', (socket, request) => { assert.equal(request.headers.authorization, 'Bearer music-fixture'); attach(socket) })
    url = `ws://127.0.0.1:${server.address().port}`
  } else {
    const allocator = createServer(); allocator.listen(0, '127.0.0.1'); await once(allocator, 'listening')
    url = `ws://127.0.0.1:${allocator.address().port}/onebot`; await new Promise(resolve => allocator.close(resolve))
  }
  const adapter = createOneBotConnection({ connection: { id: 'music-local', account }, transport, url, accessToken: 'music-fixture',
    onDisconnect() {}, onReconnect() {}, onError() {}, onEventError() {},
  })
  t.after(async () => { adapter.stop(); for (const socket of peers) socket.terminate(); if (server) await new Promise(resolve => server.close(resolve)) })
  assert.equal((await adapter.actions.sendMusic(action())).state, 'failed')
  const start = adapter.start(async () => {}); void start.catch(() => {})
  if (transport === 'reverse-websocket') await waitFor(async () => {
    const socket = attach(new WebSocket(url, { headers: { Authorization: 'Bearer music-fixture', 'X-Self-ID': account.id, 'X-Client-Role': 'Universal' } }))
    try { await once(socket, 'open'); return true } catch { socket.terminate(); return false }
  })
  await start
  return { adapter, requests, peer: () => peer, setHandler(value) { handler = value } }
}

for (const transport of ['forward-websocket', 'reverse-websocket']) {
  test(`${transport} authenticates and sends one fixed-group custom music card with a real native ID`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport)
    assert.deepEqual(await f.adapter.actions.sendMusic(action({ binding })), { state: 'sent', messageId: '6789' })
    assert.equal((await f.adapter.actions.sendMusic(action({ target: { ...target, kind: 'private' } }))).state, 'failed')
    const sent = f.requests.filter(row => row.action !== 'get_login_info')
    assert.equal(sent.length, 1); assert.equal(sent[0].action, 'send_group_msg')
    assert.deepEqual(sent[0].params, { group_id: target.id, message: [{ type: 'music', data: { type: 'custom',
      url: music.pageUrl, audio: music.audioUrl, title: music.title, image: music.coverUrl, content: music.artist } }] })
  })
  for (const mode of ['abort', 'stop', 'disconnect', 'binding']) {
    test(`${transport} dispatched music ${mode} is unknown with one native request and late success ignored`, { timeout: 8000 }, async t => {
      const f = await fixture(t, transport), controller = new AbortController(); let current = true
      f.setHandler(() => undefined)
      const pending = f.adapter.actions.sendMusic(action(), { signal: controller.signal, isCurrent: () => current })
      const request = await waitFor(() => f.requests.find(row => row.action === 'send_group_msg'))
      if (mode === 'abort') controller.abort()
      else if (mode === 'stop') f.adapter.stop()
      else if (mode === 'disconnect') f.peer().terminate()
      else current = false
      assert.deepEqual(await Promise.race([pending, delay(600).then(() => 'timeout')]), { state: 'unknown' })
      if (f.peer().readyState === WebSocket.OPEN) f.peer().send(JSON.stringify({ ...success(7777), echo: request.echo }))
      await delay(10)
      assert.equal(f.requests.filter(row => row.action === 'send_group_msg').length, 1)
    })
  }
  for (const retcode of [1400, 1200]) {
    test(`${transport} native ${retcode} remains classified without a retry or text/JSON fallback`, { timeout: 8000 }, async t => {
      const f = await fixture(t, transport)
      f.setHandler(() => ({ status: 'failed', retcode, data: { message_id: 42 } }))
      assert.deepEqual(await f.adapter.actions.sendMusic(action()), retcode === 1400 ? { state: 'failed', code: '1400' } : { state: 'unknown' })
      assert.equal(f.requests.filter(row => row.action !== 'get_login_info').length, 1)
    })
  }
}
