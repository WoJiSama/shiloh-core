import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket, { WebSocketServer } from 'ws'
import { createQqMusicShareReader, extractQqMusicShare } from '../dist/backend/adapters/qqMusicShare.js'
import { createOneBotConnection } from '../dist/backend/adapters/oneBotConnection.js'

const account = { platform: 'qq', namespace: 'global', id: '123456789' }
const group = { account, kind: 'group', id: '315320' }
const peer = { account, kind: 'private', id: '246810' }
const song = { provider: 'netease', reference: { kind: 'song', id: '17' } }
const card = { meta: { music: { title: '合成曲目', desc: '合成艺人', musicUrl: 'https://m7.music.126.net/synthetic.mp3' } } }
const canonical = [{ type: 'json', data: { data: JSON.stringify(card) } }]
const native = [{ type: 'music', data: { type: '163', id: '17' } }]
const ok = data => ({ status: 'ok', retcode: 0, data })
function message(target = group, overrides = {}) {
  return ok({ self_id: account.id, message_type: target.kind, message_id: 71, time: 1700000000,
    user_id: peer.id, sender: { user_id: peer.id, nickname: '合成分享者' }, message: canonical,
    ...(target.kind === 'group' ? { group_id: target.id } : { sub_type: 'friend', post_type: 'message' }), ...overrides })
}
const options = overrides => ({ signal: new AbortController().signal, isCurrent: () => true, allowsSource: async () => true, ...overrides })
function direct(response = message(), friends = ok([{ user_id: peer.id }])) {
  const calls = [], read = createQqMusicShareReader({ account, async readApi(action, params, guard) {
    calls.push({ action, params, guard })
    const value = action === 'get_msg' ? response : friends
    return typeof value === 'function' ? value(action, params, guard) : value
  } })
  return { calls, read }
}
const cq = value => `[CQ:json,data=${JSON.stringify(value).replace(/&/gu, '&amp;').replace(/,/gu, '&#44;').replace(/\[/gu, '&#91;').replace(/\]/gu, '&#93;')}]`
async function waitFor(probe) {
  const until = Date.now() + 3000
  while (Date.now() < until) { const value = await probe(); if (value) return value; await delay(5) }
  assert.fail('Timed out waiting for music share fixture')
}

test('bounded QQ music reader accepts legacy/canonical JSON objects/strings and original CQ JSON', () => {
  const expected = { provider: 'netease', reference: { kind: 'audio', url: card.meta.music.musicUrl }, title: '合成曲目', artist: '合成艺人' }
  for (const input of [[{ type: 'json', data: JSON.stringify(card) }], [{ type: 'json', data: card }],
    canonical, [{ type: 'json', data: { data: card } }], cq(card)]) {
    assert.deepEqual(extractQqMusicShare(input), expected)
  }
})

test('native 163 segments and ordinary official song/dj links become only neutral references', () => {
  assert.deepEqual(extractQqMusicShare(native), song)
  assert.deepEqual(extractQqMusicShare('[CQ:music,type=163,id=17]'), song)
  assert.deepEqual(extractQqMusicShare('请提取 https://music.163.com/song?id=17'), song)
  assert.deepEqual(extractQqMusicShare([{ type: 'text', data: { text: 'https://y.music.163.com/dj?id=23' } }]),
    { provider: 'netease', reference: { kind: 'program', id: '23' } })
  assert.deepEqual(extractQqMusicShare([{ type: 'json', data: { data: { meta: { music: { title: '歌', jumpUrl: 'https://music.163.com/song?id=17' } } } } }]),
    { ...song, title: '歌' })
})

test('source references deny unofficial URLs, native targets, ambiguous shares and malformed JSON', () => {
  for (const url of ['https://music.163.com.evil.com/a.mp3', 'https://music.126.net.evil.com/a.mp3', 'https://127.0.0.1/a.mp3',
    'https://evil.com/?next=https://music.163.com/song?id=17', 'https://name:secret@music.163.com/a.mp3',
    'https://music.163.com/a.mp3#fragment', 'https://music.163.com:443/a.mp3', 'https://music.163.com/a/../b.mp3',
    'https://m7.music.126.net/a%2fb.mp3', 'https://music.163.com/a.mp3\\escape',
  ]) assert.equal(extractQqMusicShare([{ type: 'json', data: { musicUrl: url } }]), undefined, url)
  for (const input of [undefined, {}, [{ type: 'json', data: '{broken' }], [{ type: 'music', data: { type: 'qq', id: '17' } }],
    [{ type: 'music', data: { type: '163', id: Number.MAX_SAFE_INTEGER + 1 } }],
    [...native, { type: 'text', data: { text: 'https://music.163.com/song?id=18' } }],
    'https://evil.com/https://music.163.com/song?id=17', 'https://music.163.com/#/song?id=17',
  ]) assert.equal(extractQqMusicShare(input), undefined)
})

test('music source parsing rejects getters, symbols, prototypes, cycles and depth/node/length excess', () => {
  let accessed = false
  const getter = { type: 'json', get data() { accessed = true; return card } }
  const cycle = {}; cycle.loop = cycle
  let deep = card; for (let n = 0; n < 20; n++) deep = { nested: deep }
  for (const input of [[getter], [{ type: 'json', data: { ...card, [Symbol('hidden')]: true } }],
    [{ type: 'json', data: Object.assign(Object.create({ inherited: true }), card) }], [{ type: 'json', data: cycle }],
    [{ type: 'json', data: deep }], [{ type: 'json', data: ' '.repeat(65537) }],
    Array.from({ length: 129 }, () => native[0]), [{ type: 'json', data: { values: Array.from({ length: 500 }, () => Array(20).fill(0)) } }],
  ]) assert.equal(extractQqMusicShare(input), undefined)
  assert.equal(accessed, false)
})

test('get_msg full account/conversation/message/sender/time evidence is verified before source policy', async () => {
  for (const override of [{ self_id: '99999' }, { group_id: '99999' }, { message_id: 72 }, { message_type: 'private' },
    { time: 0 }, { time: '1700000000' }, { time: Number.MAX_SAFE_INTEGER }, { sender: {} },
    { sender: { user_id: '99999' } }, { user_id: null }, { user_id: '0246810' }, { message: null },
  ]) {
    let authorized = 0
    const d = direct(message(group, override))
    assert.equal(await d.read(group, '71', options({ allowsSource: async () => { authorized++; return true } })), undefined)
    assert.equal(authorized, 0)
  }
  for (const response of [{ ...message(), self_id: '99999' }, { ...message(), status: 'failed' }, { ...message(), retcode: '0' }]) {
    assert.equal(await direct(response).read(group, '71', options()), undefined)
  }
  const d = direct(); let checks = 0
  const result = await d.read(group, '71', options({ allowsSource: async source => {
    checks++; assert.equal(source.messageId, '71'); assert.deepEqual(source.conversation, group)
    assert.equal(source.sender.id, peer.id); assert.equal(source.occurredAt, 1700000000000)
    assert.equal(source.text, ''); assert.deepEqual(source.parts, [{ kind: 'extension', platform: 'qq', type: 'json' }])
    assert.equal(JSON.stringify(source).includes('musicUrl'), false); assert.equal(Object.isFrozen(source), true); return true
  } }))
  assert.equal(checks, 2); assert.equal(result.share.reference.kind, 'audio')
  assert.deepEqual(d.calls.map(row => [row.action, row.params]), [['get_msg', { message_id: 71 }]])
})

test('incoming private music requires current complete friend proof even when NapCat labels a stranger friend', async () => {
  const d = direct(message(peer)); let checks = 0
  const result = await d.read(peer, '71', options({ allowsSource: async () => { checks++; return true } }))
  assert.equal(result.message.sender.id, peer.id); assert.deepEqual(result.message.conversation, peer); assert.equal(checks, 2)
  assert.deepEqual(d.calls.map(row => [row.action, row.params]), [['get_msg', { message_id: 71 }], ['get_friend_list', {}]])
  const noSelf = message(peer); delete noSelf.data.self_id; delete noSelf.data.sub_type
  assert.ok(await direct(noSelf).read(peer, '71', options()))
  for (const friends of [ok([]), ok([{ user_id: '99999' }]), ok([{ user_id: peer.id }, { user_id: peer.id }]),
    ok([{ user_id: peer.id }, { user_id: null }]), { ...ok([{ user_id: peer.id }]), complete: false },
    ok(Array.from({ length: 10001 }, (_, index) => ({ user_id: String(index + 1) }))), { status: 'ok', retcode: 0, data: { friends: [{ user_id: peer.id }] } },
  ]) assert.equal(await direct(message(peer), friends).read(peer, '71', options()), undefined)
  let reads = 0
  const changing = direct(message(peer), () => ok(++reads === 1 ? [{ user_id: peer.id }] : []))
  assert.ok(await changing.read(peer, '71', options()))
  assert.equal(await changing.read(peer, '71', options()), undefined)
  assert.equal(reads, 2)
})

test('private direction and peer evidence reject temporary, foreign and unproven self-sent messages', async () => {
  for (const override of [{ sub_type: 'group' }, { group_id: group.id }, { temp_source: 0 }, { target_id: '99999' },
    { sender: { user_id: '99999' }, user_id: '99999' }, { post_type: 'message_sent' }, { message_sent_type: 'self' },
    { sender: { user_id: account.id }, user_id: account.id, post_type: 'message_sent', message_sent_type: 'self' },
  ]) assert.equal(await direct(message(peer, override)).read(peer, '71', options()), undefined)
  const own = message(peer, { sender: { user_id: account.id }, user_id: account.id, target_id: peer.id,
    post_type: 'message_sent', message_sent_type: 'self' })
  const result = await direct(own).read(peer, '71', options())
  assert.equal(result.message.sender.id, account.id); assert.deepEqual(result.message.conversation, peer)
})

test('invalid scope/ID and pre-aborted source read cause no native requests', async () => {
  const d = direct(), cancel = new AbortController(); cancel.abort()
  for (const target of [{ ...group, id: null }, { ...group, id: 315320 }, { ...group, account: { ...account, id: '99999' } },
    { ...group, account: { ...account, namespace: 'tenant' } }, { ...group, kind: 'channel' }, { ...peer, id: account.id }]) {
    assert.equal(await d.read(target, '71', options()), undefined)
  }
  for (const id of ['0', '071', ' 71', '2147483648', '-2147483649', 'uuid']) assert.equal(await d.read(group, id, options()), undefined)
  assert.equal(await d.read(group, '71', options({ signal: cancel.signal })), undefined)
  assert.equal(await d.read(group, '71', options({ isCurrent: () => false })), undefined)
  assert.equal(d.calls.length, 0)
})

test('source authorization runs before parsing and again after asynchronous work using a captured native snapshot', async () => {
  const response = message(), d = direct(response); let checks = 0
  const result = await d.read(group, '71', options({ allowsSource: async () => {
    checks++; if (checks === 1) { response.data.message = [{ type: 'music', data: { type: '163', id: '999' } }]; await delay(5) }
    return true
  } }))
  assert.equal(checks, 2); assert.equal(result.share.reference.kind, 'audio')
  let denied = 0
  assert.equal(await direct().read(group, '71', options({ allowsSource: async () => ++denied < 2 })), undefined)
  assert.equal(denied, 2)
  let current = true
  assert.equal(await direct().read(group, '71', options({ isCurrent: () => current, allowsSource: async () => { current = false; return true } })), undefined)
})

for (const stage of ['get_msg', 'get_friend_list', 'allowsSource']) {
  test(`abort during ${stage} releases an uncooperative read and ignores late source success`, async () => {
    const controller = new AbortController(); let entered = false, release
    const stalled = () => { entered = true; return new Promise(resolve => { release = resolve }) }
    const d = direct(stage === 'get_msg' ? stalled : message(stage === 'get_friend_list' ? peer : group), stage === 'get_friend_list' ? stalled : ok([{ user_id: peer.id }]))
    const pending = d.read(stage === 'get_friend_list' ? peer : group, '71', options({ signal: controller.signal,
      ...(stage === 'allowsSource' ? { allowsSource: stalled } : {}) }))
    await waitFor(() => entered); controller.abort()
    assert.equal(await Promise.race([pending, delay(500).then(() => 'timeout')]), undefined)
    release(stage === 'allowsSource' ? true : stage === 'get_msg' ? message() : ok([{ user_id: peer.id }]))
    await delay(5)
  })
}

async function fixture(t, transport) {
  const requests = [], peers = []; let peerSocket, server, url, handler = request => request.action === 'get_friend_list' ? ok([{ user_id: peer.id }]) : message()
  const attach = socket => {
    peerSocket = socket; peers.push(socket); socket.on('error', () => {})
    socket.on('message', raw => {
      const request = JSON.parse(String(raw)); requests.push(request)
      const response = request.action === 'get_login_info' ? ok({ user_id: account.id, nickname: '分享合成验收' }) : handler(request)
      if (response) socket.send(JSON.stringify({ ...response, echo: request.echo }))
    })
    return socket
  }
  if (transport === 'forward-websocket') {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening')
    server.on('connection', (socket, request) => { assert.equal(request.headers.authorization, 'Bearer music-read-fixture'); attach(socket) })
    url = `ws://127.0.0.1:${server.address().port}`
  } else {
    const allocator = createServer(); allocator.listen(0, '127.0.0.1'); await once(allocator, 'listening')
    url = `ws://127.0.0.1:${allocator.address().port}/onebot`; await new Promise(resolve => allocator.close(resolve))
  }
  const adapter = createOneBotConnection({ connection: { id: 'music-read-local', account }, transport, url, accessToken: 'music-read-fixture', onDisconnect() {}, onReconnect() {}, onError() {}, onEventError() {} })
  t.after(async () => { adapter.stop(); for (const socket of peers) socket.terminate(); if (server) await new Promise(resolve => server.close(resolve)) })
  assert.equal(await adapter.readMusicShare(group, '71', options()), undefined)
  const start = adapter.start(async () => {}); void start.catch(() => {})
  if (transport === 'reverse-websocket') await waitFor(async () => {
    const socket = attach(new WebSocket(url, { headers: { Authorization: 'Bearer music-read-fixture', 'X-Self-ID': account.id, 'X-Client-Role': 'Universal' } }))
    try { await once(socket, 'open'); return true } catch { socket.terminate(); return false }
  })
  await start
  return { adapter, requests, socket: () => peerSocket, setHandler(value) { handler = value } }
}

for (const transport of ['forward-websocket', 'reverse-websocket']) {
  test(`${transport} reads music and revalidates the private readMessage friend through real authenticated sockets`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport)
    assert.equal((await f.adapter.readMusicShare(group, '71', options())).share.reference.kind, 'audio')
    f.setHandler(request => request.action === 'get_friend_list' ? ok([{ user_id: peer.id }]) : message(peer, { message: native }))
    assert.deepEqual((await f.adapter.readMusicShare(peer, '71', options())).share, song)
    const before = f.requests.length
    const source = await f.adapter.readMessage(peer, '71')
    assert.deepEqual(source.conversation, peer); assert.equal(source.sender.id, peer.id); assert.equal(source.messageId, '71')
    assert.deepEqual(f.requests.slice(before).map(row => [row.action, row.params]), [['get_friend_list', {}], ['get_msg', { message_id: 71 }]])
    assert.deepEqual(f.requests.filter(row => row.action !== 'get_login_info').map(row => [row.action, row.params]),
      [['get_msg', { message_id: 71 }], ['get_msg', { message_id: 71 }], ['get_friend_list', {}], ['get_friend_list', {}], ['get_msg', { message_id: 71 }]])
  })
  for (const mode of ['abort', 'stop', 'disconnect', 'rebind']) {
    test(`${transport} ${mode} drops a pending source without a retry`, { timeout: 8000 }, async t => {
      const f = await fixture(t, transport), controller = new AbortController(); let current = true
      f.setHandler(() => undefined)
      const pending = f.adapter.readMusicShare(group, '71', options({ signal: controller.signal, isCurrent: () => current }))
      const request = await waitFor(() => f.requests.find(row => row.action === 'get_msg'))
      if (mode === 'abort') controller.abort()
      else if (mode === 'stop') f.adapter.stop()
      else if (mode === 'disconnect') f.socket().terminate()
      else current = false
      assert.equal(await Promise.race([pending, delay(600).then(() => 'timeout')]), undefined)
      if (f.socket().readyState === WebSocket.OPEN) f.socket().send(JSON.stringify({ ...message(), echo: request.echo }))
      await delay(5); assert.equal(f.requests.filter(row => row.action === 'get_msg').length, 1)
    })
  }
}
