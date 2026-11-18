import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket, { WebSocketServer } from 'ws'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { createOneBotConnection, createQqDicePrivateDeliveryPort, QQ_DICE_PRIVATE_TIMEOUT_MS } = await load('adapters/oneBotConnection.js')
const { decodeQqIncomingMessage } = await load('adapters/qqMessage.js')
const { agentDiceSourceFingerprint } = await load('modules/dice/infrastructure/agentDiceSource.js')
const { withDeliveryGuard } = await load('modules/messaging/infrastructure/deliveryScope.js')
const AT = Math.floor(Date.now() / 1000) * 1000
const account = { platform: 'qq', namespace: 'global', id: '123456' }
const author = { ...account, id: '234567' }, recipient = { ...account, id: '345678' }, target = { account, kind: 'group', id: '456789' }
const binding = { source: 'configured', id: 'dice-binding', revision: 'v1', agentId: 'daily', personaId: 'default', connectionId: 'dice-local', target }
const success = (id = 678901) => ({ status: 'ok', retcode: 0, data: { message_id: id } })
const deferred = () => Promise.withResolvers()
function native(id = '912345', text = '.rh 1d20') {
  return { post_type: 'message', self_id: account.id, message_type: 'group', group_id: target.id, message_id: id,
    user_id: author.id, sender: { user_id: author.id, nickname: '真实玩家' }, time: AT / 1000,
    message: [{ type: 'text', data: { text } }] }
}
function request(retry = false) {
  const origin = decodeQqIncomingMessage(native()), source = retry ? decodeQqIncomingMessage(native('912346', '.rule retry')) : origin
  assert.ok(origin); assert.ok(source)
  return { binding: structuredClone(binding), source: structuredClone(source), origin: {
    binding: structuredClone(binding), source: { messageId: origin.messageId, author: structuredClone(origin.sender), occurredAt: origin.occurredAt,
      fingerprint: agentDiceSourceFingerprint(origin) }, operationId: 'original-operation', authorityRevision: 'grant-v1',
  }, recipient: structuredClone(recipient), text: '隐藏检定结果：1D20=17。', operationId: 'current-operation', index: 0 }
}
function live(replacements = {}) {
  return { signal: new AbortController().signal, isCurrent: () => true, async ensureCurrent() {}, ...replacements }
}
async function waitFor(check, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) { if (await check()) return; await delay(10) }
  assert.fail('OneBot fixture condition timed out')
}
async function bounded(pending) {
  let timer
  try { return await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('private relay did not settle')), 1000) })]) }
  finally { clearTimeout(timer) }
}
async function fixture(t, transport, settings = {}) {
  const requests = [], peers = [], events = []; let peer, server, url, handler
  const nativeSources = new Map([['912345', native()], ['912346', native('912346', '.rule retry')]])
  function defaultResponse(row) {
    if (row.action === 'get_msg') return { status: 'ok', retcode: 0, data: nativeSources.get(row.params.message_id) }
    if (row.action === 'get_group_member_info') return { status: 'ok', retcode: 0, data: { group_id: target.id, user_id: recipient.id, role: 'member' } }
    if (row.action === 'get_friend_list') return { status: 'ok', retcode: 0, self_id: account.id, data: [{ user_id: recipient.id }] }
    if (row.action === 'send_private_msg') return success()
    assert.fail(`unexpected OneBot API ${row.action}`)
  }
  function respond(row, response) {
    if (response && row.peer.readyState === WebSocket.OPEN) row.peer.send(JSON.stringify({ ...response, echo: row.echo }))
  }
  function attach(socket) {
    peer = socket; peers.push(socket); socket.on('error', () => {})
    socket.on('message', raw => {
      const row = { ...JSON.parse(String(raw)), peer: socket }; requests.push(row)
      const response = row.action === 'get_login_info'
        ? { status: 'ok', retcode: 0, data: { user_id: account.id, nickname: '私密骰点合成验收' } }
        : handler ? handler(row) : defaultResponse(row)
      respond(row, response)
    })
    return socket
  }
  if (transport === 'forward-websocket') {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening')
    server.on('connection', (socket, raw) => { assert.equal(raw.headers.authorization, 'Bearer dice-fixture'); attach(socket) })
    url = `ws://127.0.0.1:${server.address().port}`
  } else {
    const allocator = createServer(); allocator.listen(0, '127.0.0.1'); await once(allocator, 'listening')
    url = `ws://127.0.0.1:${allocator.address().port}/onebot`; await new Promise(resolve => allocator.close(resolve))
  }
  const adapter = createOneBotConnection({ connection: { id: binding.connectionId, account }, transport, url, accessToken: 'dice-fixture',
    ...(settings.allowsText ? { dicePrivate: { allowsText: settings.allowsText } } : {}),
    onDisconnect() {}, onReconnect() {}, onError() {}, onEventError() {},
  })
  t.after(async () => { adapter.stop(); for (const socket of peers) socket.terminate(); if (server) await new Promise(resolve => server.close(resolve)) })
  assert.equal((await adapter.actions.sendDicePrivate(request(), live())).state, 'failed')
  const connectReverse = async () => {
    const socket = attach(new WebSocket(url, { headers: { Authorization: 'Bearer dice-fixture', 'X-Self-ID': account.id, 'X-Client-Role': 'Universal' } }))
    try { await once(socket, 'open'); return true } catch { socket.terminate(); return false }
  }
  const start = adapter.start(async event => { events.push(event) }); void start.catch(() => {})
  if (transport === 'reverse-websocket') await waitFor(connectReverse)
  await start
  return { adapter, requests, events, nativeSources, respond, defaultResponse, peer: () => peer,
    send: (input = request(), guard = live()) => adapter.actions.sendDicePrivate(input, guard),
    setHandler(next) { handler = next },
    async reconnect() {
      const previous = peer
      await waitFor(() => !adapter.isReady())
      if (transport === 'reverse-websocket') await waitFor(connectReverse)
      await waitFor(() => peer !== previous && adapter.isReady())
    },
  }
}
const sideEffects = f => f.requests.filter(row => !['get_login_info', 'get_msg', 'get_group_member_info', 'get_friend_list'].includes(row.action))

test('OneBot exports the private dice factory and global transport deadline', () => {
  assert.equal(typeof createQqDicePrivateDeliveryPort, 'function'); assert.equal(QQ_DICE_PRIVATE_TIMEOUT_MS, 30000)
})
for (const transport of ['forward-websocket', 'reverse-websocket']) {
  test(`${transport} proves both exact sources, fresh member and friend then sends private text once`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport), input = request(true)
    assert.deepEqual(await f.send(input), { state: 'sent', messageId: '678901' })
    const proof = f.requests.filter(row => row.action !== 'get_login_info')
    assert.deepEqual(proof.map(row => row.action), ['get_msg', 'get_msg', 'get_group_member_info', 'get_friend_list', 'send_private_msg'])
    assert.deepEqual(proof.slice(0, 2).map(row => row.params.message_id), ['912346', '912345'])
    assert.deepEqual(proof[2].params, { group_id: target.id, user_id: recipient.id, no_cache: true })
    assert.deepEqual(proof[4].params, { user_id: recipient.id, message: [{ type: 'text', data: { text: input.text } }] })
    assert.equal(proof.every(row => row.peer === f.peer()), true); assert.equal(f.events.length, 0)
    const before = f.requests.length
    assert.equal((await f.send()).state, 'sent')
    assert.equal(f.requests.slice(before).filter(row => row.action === 'get_msg').length, 1, 'shared current/origin reads once')
  })
  test(`${transport} rejects untrusted entry guards and input before native reads without running traps`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport); let touched = false
    const getter = live(); Object.defineProperty(getter, 'signal', { enumerable: true, get() { touched = true; throw Error('getter') } })
    const proxy = new Proxy(live(), { ownKeys() { touched = true; throw Error('proxy') } })
    const before = f.requests.length
    for (const guard of [getter, proxy, null, {}, live({ isCurrent: () => false }), live({ signal: AbortSignal.abort() })]) assert.equal((await f.send(request(), guard)).state, 'failed')
    const wrong = request(); wrong.origin.binding.revision = 'v2'
    assert.equal((await f.send(wrong)).state, 'failed'); assert.equal(touched, false); assert.equal(f.requests.length, before)
  })
  test(`${transport} source and recipient identity proof failures never send or use TEMP fallback`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport)
    for (const stage of ['current', 'origin', 'member', 'friend']) {
      f.setHandler(row => {
        const response = f.defaultResponse(row)
        if (stage === 'current' && row.action === 'get_msg' && row.params.message_id === '912346') response.data = { ...response.data, message_id: '999999' }
        if (stage === 'origin' && row.action === 'get_msg' && row.params.message_id === '912345') response.data = { ...response.data, sender: { user_id: '999999' } }
        if (stage === 'member' && row.action === 'get_group_member_info') response.data.user_id = '999999'
        if (stage === 'friend' && row.action === 'get_friend_list') response.data = []
        return response
      })
      assert.equal((await f.send(request(true))).state, 'failed', stage)
    }
    assert.deepEqual(sideEffects(f), [])
  })
  test(`${transport} host text filter applies before reads and while a source read is pending`, { timeout: 8000 }, async t => {
    let allowed = false; const f = await fixture(t, transport, { allowsText: () => allowed }), before = f.requests.length
    assert.equal((await f.send()).state, 'failed'); assert.equal(f.requests.length, before)
    allowed = true; const entered = deferred()
    f.setHandler(row => { if (row.action === 'get_msg') { entered.resolve(row); return undefined }; return f.defaultResponse(row) })
    const pending = f.send(), held = await entered.promise; allowed = false
    assert.equal((await bounded(pending)).state, 'failed'); f.respond(held, f.defaultResponse(held))
    await delay(40); assert.deepEqual(sideEffects(f), [])
  })
  for (const mode of ['signal', 'host', 'queue', 'stop']) {
    test(`${transport} ${mode} invalidation before source proof prevents every side effect`, { timeout: 8000 }, async t => {
      const f = await fixture(t, transport), entered = deferred(), controller = new AbortController(); let current = true, queued = true
      f.setHandler(row => { if (row.action === 'get_msg') { entered.resolve(row); return undefined }; return f.defaultResponse(row) })
      const pending = withDeliveryGuard(() => queued, () => f.send(request(), live({ signal: controller.signal, isCurrent: () => current })))
      const held = await entered.promise
      if (mode === 'signal') controller.abort(); else if (mode === 'host') current = false; else if (mode === 'queue') queued = false; else f.adapter.stop()
      if (mode === 'queue') f.respond(held, f.defaultResponse(held))
      assert.equal((await bounded(pending)).state, 'failed')
      f.respond(held, f.defaultResponse(held)); await delay(40); assert.deepEqual(sideEffects(f), [])
    })
  }
  test(`${transport} a disconnected proof cannot migrate to a replacement authenticated socket`, { timeout: 10000 }, async t => {
    const f = await fixture(t, transport), entered = deferred()
    f.setHandler(row => { if (row.action === 'get_msg') { entered.resolve(row); return undefined }; return f.defaultResponse(row) })
    const pending = f.send(), held = await entered.promise; f.peer().terminate()
    assert.equal((await bounded(pending)).state, 'failed'); await f.reconnect()
    f.setHandler(undefined); f.respond(held, f.defaultResponse(held)); await delay(40)
    assert.deepEqual(sideEffects(f), []); assert.deepEqual(await f.send(), { state: 'sent', messageId: '678901' })
    assert.equal(sideEffects(f).length, 1); assert.notEqual(sideEffects(f)[0].peer, held.peer)
  })
  for (const mode of ['signal', 'host', 'disconnect', 'stop']) {
    test(`${transport} ${mode} invalidation after native send remains unknown without retry or public fallback`, { timeout: 8000 }, async t => {
      const f = await fixture(t, transport), entered = deferred(), controller = new AbortController(); let current = true
      f.setHandler(row => { if (row.action === 'send_private_msg') { entered.resolve(row); return undefined }; return f.defaultResponse(row) })
      const pending = f.send(request(), live({ signal: controller.signal, isCurrent: () => current })), held = await entered.promise
      if (mode === 'signal') controller.abort(); else if (mode === 'host') current = false; else if (mode === 'disconnect') f.peer().terminate(); else f.adapter.stop()
      assert.deepEqual(await bounded(pending), { state: 'unknown' }); f.respond(held, success())
      await delay(40); assert.equal(sideEffects(f).length, 1); assert.equal(sideEffects(f)[0].action, 'send_private_msg')
    })
  }
  test(`${transport} asynchronous source ensure is repeated immediately before native send and fences queued revocation`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport), entered = deferred(), release = deferred(); let friendSeen = false, afterFriend = 0, queued = true
    f.setHandler(row => { if (row.action === 'get_friend_list') friendSeen = true; return f.defaultResponse(row) })
    const pending = withDeliveryGuard(() => queued, () => f.send(request(), live({ async ensureCurrent() {
      if (friendSeen && ++afterFriend === 2) { entered.resolve(); await release.promise }
    } })))
    await entered.promise; assert.deepEqual(sideEffects(f), []); queued = false; release.resolve()
    assert.equal((await bounded(pending)).state, 'failed'); assert.deepEqual(sideEffects(f), [])
  })
  test(`${transport} source read handler ambiguity stays unknown while explicit schema rejection fails`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport)
    for (const action of ['get_msg', 'get_group_member_info', 'get_friend_list']) {
      for (const response of [{ state: 'failed', code: 'forged' }, { state: 'unknown' }, { status: 'failed', retcode: 1200 }, {}, { status: 'ok', retcode: '0' }]) {
        f.setHandler(row => row.action === action ? response : f.defaultResponse(row))
        assert.deepEqual(await f.send(), { state: 'unknown' }, `${action}: ${JSON.stringify(response)}`)
      }
      for (const retcode of [400, 1400]) {
        f.setHandler(row => row.action === action ? { status: 'failed', retcode } : f.defaultResponse(row))
        assert.equal((await f.send()).state, 'failed', `${action}: ${retcode}`)
      }
    }
    assert.deepEqual(sideEffects(f), [])
  })
  test(`${transport} private send native receipts cannot forge pre-dispatch failure or trigger retries`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport)
    for (const response of [{ state: 'failed', code: 'forged' }, { state: 'unknown' }, { status: 'failed', retcode: 1200 }, {},
      { status: 'ok', retcode: 0, data: {} }, success('opaque-echo'), { ...success(), data: { message_id: 678901, group_id: target.id } }]) {
      const before = sideEffects(f).length
      f.setHandler(row => row.action === 'send_private_msg' ? response : f.defaultResponse(row))
      assert.deepEqual(await f.send(), { state: 'unknown' }, JSON.stringify(response)); assert.equal(sideEffects(f).length, before + 1)
    }
    for (const retcode of [400, 1400]) {
      f.setHandler(row => row.action === 'send_private_msg' ? { status: 'failed', retcode } : f.defaultResponse(row))
      assert.deepEqual(await f.send(), { state: 'failed', code: String(retcode) })
    }
    assert.equal(sideEffects(f).every(row => row.action === 'send_private_msg' && !Object.hasOwn(row.params, 'group_id')), true)
  })
}
