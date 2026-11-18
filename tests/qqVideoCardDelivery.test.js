import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket, { WebSocketServer } from 'ws'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'
const { createQqVideoCardDeliveryPort, QQ_VIDEO_CARD_SEND_TIMEOUT_MS } = await importBilibiliHost('adapters/qqVideoCardDelivery.js')
const { createOneBotConnection } = await importBilibiliHost('adapters/oneBotConnection.js')
const { queuedDeliveryAllowed } = await importBilibiliHost('modules/messaging/infrastructure/deliveryScope.js')

const account = { platform: 'qq', namespace: 'global', id: '123456789' }, target = { account, kind: 'group', id: '315320' }
const binding = { source: 'configured', id: 'video-binding', revision: 'r1', personaId: 'default', agentId: 'alice', connectionId: 'video-local', target }
const card = { provider: 'bilibili', id: 'BV1xx411c7mD', title: '合成视频 "引号" <字符>', author: '合成作者', durationSeconds: 123, pageUrl: 'https://www.bilibili.com/video/BV1xx411c7mD' }
const action = (overrides = {}) => ({ version: 1, kind: 'video-card.send', target, binding, card, ...overrides })
const success = (id = 6789) => ({ status: 'ok', retcode: 0, data: { message_id: id } })
async function waitFor(probe) { const until = Date.now() + 3000; while (Date.now() < until) { const value = await probe(); if (value) return value; await delay(5) }; assert.fail('video fixture did not settle') }
function direct(response = success()) {
  const calls = [], sendVideoCard = createQqVideoCardDeliveryPort({ account, connectionId: binding.connectionId,
    async sendApi(action, params, guard) { calls.push({ action, params, guard }); return typeof response === 'function' ? response(action, params, guard) : response },
  }); return { calls, sendVideoCard }
}
function assertCard(params) {
  assert.equal(params.group_id, target.id); assert.equal(params.message.length, 1)
  assert.equal(params.message[0].type, 'json'); assert.deepEqual(Object.keys(params.message[0].data), ['data'])
  const native = JSON.parse(params.message[0].data.data)
  assert.deepEqual(native, { app: 'com.bilibili.app', view: 'min', ver: '1.0.0.0', prompt: `[视频]${card.title}`,
    meta: { detail_1: { appid: '1109937557', title: '哔哩哔哩', desc: card.title, author: card.author, duration: 123, qqdocurl: card.pageUrl, url: card.pageUrl } },
    config: { autosize: 1, forward: 1 },
  })
  assert.equal(JSON.stringify(native).includes('preview'), false); assert.equal(JSON.stringify(native).includes('thumbnail'), false)
}

test('QQ video adapter builds exactly one fixed native JSON card from captured six-field metadata', async () => {
  const d = direct(); assert.deepEqual(await d.sendVideoCard(action()), { state: 'sent', messageId: '6789' })
  assert.equal(d.calls.length, 1); assert.equal(d.calls[0].action, 'send_group_msg'); assertCard(d.calls[0].params)
  assert.ok(Object.isFrozen(d.calls[0].params)); assert.ok(Object.isFrozen(d.calls[0].params.message[0].data))
  assert.equal(QQ_VIDEO_CARD_SEND_TIMEOUT_MS, 30000)
})

test('QQ video accepts the exact official episode identity without introducing a media URL', async () => {
  const d = direct(), episode = { ...card, id: 'ep12345', pageUrl: 'https://www.bilibili.com/bangumi/play/ep12345', durationSeconds: 123.456 }
  assert.deepEqual(await d.sendVideoCard(action({ card: episode })), { state: 'sent', messageId: '6789' })
  const native = JSON.parse(d.calls[0].params.message[0].data.data)
  assert.equal(native.meta.detail_1.qqdocurl, episode.pageUrl); assert.equal(native.meta.detail_1.duration, 123.456)
  assert.equal(Object.keys(native.meta.detail_1).some(key => /audio|video|preview|thumb/iu.test(key)), false)
})

test('QQ video rejects arbitrary native JSON, unsafe provider URLs and unknown action/card fields without a native request', async () => {
  const d = direct(); let touched = false
  const getter = { ...card }; Object.defineProperty(getter, 'title', { enumerable: true, get() { touched = true; return 'unsafe' } })
  const proxy = new Proxy(card, { ownKeys() { touched = true; throw Error('proxy trap') } })
  for (const invalid of [getter, proxy, { ...card, app: 'com.tencent.miniapp_01' }, { ...card, thumbnail: 'https://example.com/private.jpg' },
    { ...card, provider: 'youtube' }, { ...card, pageUrl: card.pageUrl + '?token=secret' }, { ...card, pageUrl: 'https://evil.example/' },
    { ...card, pageUrl: 'http://www.bilibili.com/video/' + card.id }, { ...card, id: 'BV1xx411c7mE' },
    { ...card, title: '' }, { ...card, durationSeconds: -1 },
  ]) assert.equal((await d.sendVideoCard(action({ card: invalid }))).state, 'failed')
  for (const invalid of [{ json: '{}' }, { type: 'json' }, { thumbnail: 'https://example.com/' }, { kind: 'message.send' }]) assert.equal((await d.sendVideoCard(action(invalid))).state, 'failed')
  assert.equal(touched, false); assert.equal(d.calls.length, 0)
})

test('QQ video requires an exact global QQ group, configured account and complete binding without fallback', async () => {
  const d = direct()
  for (const invalid of [{ ...target, kind: 'private' }, { ...target, id: '0315320' }, { ...target, id: 315320 }, { ...target, extra: true },
    { ...target, account: { ...account, namespace: 'tenant' } }, { ...target, account: { ...account, id: '999999' } },
  ]) assert.equal((await d.sendVideoCard(action({ target: invalid }))).state, 'failed')
  for (const invalid of [undefined, null, { ...binding, connectionId: 'other' }, { ...binding, revision: '' },
    { ...binding, target: { ...target, id: '999999' } }, { ...binding, source: 'forged' }, { ...binding, extra: true },
  ]) assert.equal((await d.sendVideoCard(action({ binding: invalid }))).state, 'failed')
  assert.equal(d.calls.length, 0)
})

test('QQ video guards reject accessors, proxies and malformed scopes without invoking them', async () => {
  const d = direct(); let touched = false
  const getter = { get isCurrent() { touched = true; return () => true } }, proxy = new Proxy({}, { ownKeys() { touched = true; return [] } })
  for (const guard of [null, [], getter, proxy, { isCurrent: true }, { signal: {} }, { extra: true }, { isCurrent: () => false }]) assert.equal((await d.sendVideoCard(action(), guard)).state, 'failed')
  const controller = new AbortController(); controller.abort(); assert.equal((await d.sendVideoCard(action(), { signal: controller.signal })).state, 'failed')
  assert.equal(touched, false); assert.equal(d.calls.length, 0)
})

test('QQ video delivery confirms only an actual native message ID and matching account/group receipt', async () => {
  for (const response of [null, {}, { retcode: 0 }, success(0), success('0'), success('0001'), success('echo-uuid'), success('1\n'),
    success(Number.MAX_SAFE_INTEGER + 1), { ...success(), retcode: '0' }, { ...success(), group_id: '999999' },
    { ...success(), data: { message_id: 7, user_id: '315320' } }, { ...success(), data: { message_id: 7, self_id: '999999' } },
  ]) { const d = direct(response); assert.deepEqual(await d.sendVideoCard(action()), { state: 'unknown' }); assert.equal(d.calls.length, 1) }
  for (const id of [-42, '-42', '42']) assert.deepEqual(await direct(success(id)).sendVideoCard(action()), { state: 'sent', messageId: String(id) })
  for (const retcode of [400, 1400]) assert.deepEqual(await direct({ status: 'failed', retcode }).sendVideoCard(action()), { state: 'failed', code: String(retcode) })
  for (const retcode of [1200, 500, 1]) { const d = direct({ status: 'failed', retcode }); assert.deepEqual(await d.sendVideoCard(action()), { state: 'unknown' }); assert.equal(d.calls.length, 1) }
  const d = direct(() => { throw Error('possibly sent') }); assert.deepEqual(await d.sendVideoCard(action()), { state: 'unknown' }); assert.equal(d.calls.length, 1)
})

for (const mode of ['signal', 'guard', 'target', 'binding', 'account']) test(`dispatched QQ video losing ${mode} becomes unknown and ignores a late success`, async () => {
  const controller = new AbortController(), ownAccount = { ...account }, ownTarget = { ...target, account: ownAccount }, ownBinding = { ...binding, target: ownTarget }
  let release, current = true; const d = direct(() => new Promise(resolve => { release = resolve }))
  const pending = d.sendVideoCard(action({ target: ownTarget, binding: ownBinding }), { signal: controller.signal, isCurrent: () => current }); await waitFor(() => release)
  if (mode === 'signal') controller.abort(); else if (mode === 'guard') current = false; else if (mode === 'target') ownTarget.id = '999999'; else if (mode === 'binding') ownBinding.revision = 'r2'; else ownAccount.id = '999999'
  assert.deepEqual(await Promise.race([pending, delay(500).then(() => 'timeout')]), { state: 'unknown' }); assert.equal(d.calls[0].guard.signal.aborted, true)
  release(success(7777)); await delay(5); assert.equal(d.calls.length, 1)
})

test('captured video metadata stays immutable while a revoked queued guard blocks publishing', async () => {
  let enter, current = true, published = 0
  const own = { ...card }, d = direct(async (_action, params, scope) => { enter = true; await delay(40); assertCard(params); if (scope.isCurrent() && queuedDeliveryAllowed()) published++; return success() })
  const pending = d.sendVideoCard(action({ card: own }), { isCurrent: () => current }); await waitFor(() => enter)
  own.title = 'changed'; own.pageUrl = 'https://evil.example/'; current = false
  assert.deepEqual(await pending, { state: 'unknown' }); await delay(50); assert.equal(published, 0)
})

async function fixture(t, transport, mediaRelay) {
  const requests = [], peers = []; let peer, server, url, handler = () => success()
  const attach = socket => { peer = socket; peers.push(socket); socket.on('error', () => {}); socket.on('message', raw => {
    const request = JSON.parse(String(raw)); requests.push(request)
    const response = request.action === 'get_login_info' ? { status: 'ok', retcode: 0, data: { user_id: account.id, nickname: '视频合成验收' } } : handler(request)
    if (response) socket.send(JSON.stringify({ ...response, echo: request.echo }))
  }); return socket }
  if (transport === 'forward-websocket') { server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening'); server.on('connection', (socket, request) => { assert.equal(request.headers.authorization, 'Bearer video-fixture'); attach(socket) }); url = `ws://127.0.0.1:${server.address().port}` }
  else { const allocator = createServer(); allocator.listen(0, '127.0.0.1'); await once(allocator, 'listening'); url = `ws://127.0.0.1:${allocator.address().port}/onebot`; await new Promise(resolve => allocator.close(resolve)) }
  const adapter = createOneBotConnection({ connection: { id: binding.connectionId, account }, transport, url, accessToken: 'video-fixture', ...(mediaRelay ? { mediaRelay } : {}), onDisconnect() {}, onReconnect() {}, onError() {}, onEventError() {} })
  t.after(async () => { adapter.stop(); for (const socket of peers) socket.terminate(); if (server) await new Promise(resolve => server.close(resolve)) })
  assert.equal((await adapter.actions.sendVideoCard(action())).state, 'failed'); const start = adapter.start(async () => {}); void start.catch(() => {})
  if (transport === 'reverse-websocket') await waitFor(async () => { const socket = attach(new WebSocket(url, { headers: { Authorization: 'Bearer video-fixture', 'X-Self-ID': account.id, 'X-Client-Role': 'Universal' } })); try { await once(socket, 'open'); return true } catch { socket.terminate(); return false } })
  await start; return { adapter, requests, peer: () => peer, setHandler(next) { handler = next } }
}
for (const transport of ['forward-websocket', 'reverse-websocket']) {
  test(`${transport} sends one fixed JSON card through the captured authenticated socket`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport); assert.deepEqual(await f.adapter.actions.sendVideoCard(action()), { state: 'sent', messageId: '6789' })
    const sent = f.requests.filter(row => row.action !== 'get_login_info'); assert.equal(sent.length, 1); assertCard(sent[0].params)
  })
  for (const mode of ['abort', 'stop', 'disconnect', 'binding']) test(`${transport} dispatched video ${mode} never retries or changes socket`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport), controller = new AbortController(); let current = true; f.setHandler(() => undefined)
    const pending = f.adapter.actions.sendVideoCard(action(), { signal: controller.signal, isCurrent: () => current }), request = await waitFor(() => f.requests.find(row => row.action === 'send_group_msg'))
    if (mode === 'abort') controller.abort(); else if (mode === 'stop') f.adapter.stop(); else if (mode === 'disconnect') f.peer().terminate(); else current = false
    assert.deepEqual(await Promise.race([pending, delay(600).then(() => 'timeout')]), { state: 'unknown' })
    if (f.peer().readyState === WebSocket.OPEN) f.peer().send(JSON.stringify({ ...success(7777), echo: request.echo }))
    await delay(10); assert.equal(f.requests.filter(row => row.action === 'send_group_msg').length, 1)
  })
}
test('QQ video awaits an async final source check before native dispatch and reports a rejected check as unsent', async () => {
  let checked = 0
  const d = direct((_action, _params) => { assert.equal(checked, 1); return success() })
  assert.deepEqual(await d.sendVideoCard(action(), { async ensureCurrent() { checked++ } }), { state: 'sent', messageId: '6789' })
  const rejected = direct(); let denied = 0
  assert.equal((await rejected.sendVideoCard(action(), { async ensureCurrent() { denied++; throw Error('source revoked') } })).state, 'failed')
  assert.equal(denied, 1); assert.equal(rejected.calls.length, 0)
})
test('QQ video async authority waits stop on cancellation before dispatch and ignore late authorization', async () => {
  const controller = new AbortController(); let release, entered = false
  const d = direct(), pending = d.sendVideoCard(action(), { signal: controller.signal, async ensureCurrent() { entered = true; await new Promise(resolve => { release = resolve }) } })
  await waitFor(() => entered); controller.abort()
  assert.equal((await pending).state, 'failed'); assert.equal(d.calls.length, 0)
  release(); await delay(5); assert.equal(d.calls.length, 0)
})
test('QQ video async guard rejects accessors and proxied functions without executing them', async () => {
  const d = direct(); let touched = 0
  const proxy = new Proxy(async () => { touched++ }, { apply() { touched++; return Promise.resolve() } })
  for (const guard of [{ get ensureCurrent() { touched++; return async () => {} } }, { ensureCurrent: proxy }, { ensureCurrent: true }]) assert.equal((await d.sendVideoCard(action(), guard)).state, 'failed')
  assert.equal(touched, 0); assert.equal(d.calls.length, 0)
})

for (const transport of ['forward-websocket', 'reverse-websocket']) {
  for (const type of ['card', 'media']) test(`${transport} preserves async ${type} authority through OneBot to final dispatch`, { timeout: 8000 }, async t => {
    const bridge = { async stage() { throw Error('text-only plan needs no resources') }, async close() {} }
    const f = await fixture(t, transport, { bridge })
    const send = type === 'card' ? f.adapter.actions.sendVideoCard : f.adapter.actions.sendMediaRelay
    const input = type === 'card' ? action() : { version: 1, kind: 'media-relay.send', target, binding, mode: 'forward', plan: { version: 1, items: [{ parts: [{ kind: 'text', text: '受控媒体说明' }] }] } }
    let checked = 0
    assert.equal((await send(input, { async ensureCurrent() { checked++ } })).state, 'sent'); assert.ok(checked >= 1)
    const count = f.requests.length; let rejected = 0
    assert.equal((await send(input, { async ensureCurrent() { rejected++; throw Error('revoked current source') } })).state, 'failed')
    assert.equal(rejected, 1); assert.equal(f.requests.length, count)
    let touched = 0
    const callback = new Proxy(async () => { touched++ }, { apply() { touched++; return Promise.resolve() } })
    for (const guard of [{ get ensureCurrent() { touched++; return async () => {} } }, { ensureCurrent: callback }]) assert.equal((await send(input, guard)).state, 'failed')
    assert.equal(touched, 0); assert.equal(f.requests.length, count)
  })
}
