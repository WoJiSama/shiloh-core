import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket, { WebSocketServer } from 'ws'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const qq = await load('adapters/oneBotConnection.js')
const { createOneBotConnection } = qq
const { withDeliveryGuard } = await load('modules/messaging/infrastructure/deliveryScope.js')
const account = { platform: 'qq', namespace: 'global', id: '19000501' }, target = { account, kind: 'group', id: '312501' }
const connection = { id: 'qq-actions-socket', account }, token = 'isolated-qq-actions-token'
const binding = { source: 'configured', id: 'bound', revision: 'r1', agentId: 'agent', personaId: 'default', connectionId: connection.id, target }
const ok = (data = null) => ({ status: 'ok', retcode: 0, data })
const guard = (overrides = {}) => ({ signal: new AbortController().signal, isCurrent: () => true, async ensureCurrent() {}, ...overrides })
const gift = () => ({ version: 1, kind: 'qq.gift-display', binding: structuredClone(binding), source: { messageId: '501', author: { ...account, id: '20000101' } },
  plan: { version: 1, recipient: { ...account, id: '30000101' }, giftType: 'champagne' } })
const qzone = (kind = 'publish') => ({ version: 1, binding: structuredClone(binding), operation: kind === 'publish' ? { kind, text: '空间测试正文' } : { kind, postId: 'post_1' } })
const wallet = (id = -42) => ({ post_type: 'message', self_id: account.id, message_type: 'group', group_id: target.id, message_id: id,
  user_id: '20000101', sender: { user_id: '20000101' }, time: Math.floor(Date.now() / 1000) - 2, message_seq: 102,
  message: [{ type: 'wallet', data: { pc_body: 'PRIVATE_PC_BODY', string_index: 'PRIVATE_PACKET_INDEX_' + id, msg_seq: '102', title: '红包口令', red_channel: 32 } }] })
const recall = id => ({ post_type: 'notice', notice_type: 'group_recall', self_id: account.id, group_id: target.id, user_id: '20000101', operator_id: '20000101', message_id: id })
const qqActions = { driver: 'napcat', giftDisplay: true, qzone: true, redPackets: true }
function reply(peer, request, result) { peer.send(JSON.stringify({ ...result, echo: request.echo })) }
async function waitFor(probe, description, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await probe(); if (value) return value; await delay(5) }
  assert.fail(`timed out: ${description}`)
}
async function fixture(t, { transport = 'forward-websocket', actions = qqActions, holdLogin = false, ownPost = true } = {}) {
  const server = createServer((_request, outgoing) => outgoing.writeHead(404).end())
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const url = `ws://127.0.0.1:${server.address().port}/onebot`, reverse = transport === 'reverse-websocket'
  const sockets = reverse ? undefined : new WebSocketServer({ noServer: true }), peers = [], requests = [], events = [], errors = []
  let peer, disconnected = 0, reconnected = 0, fatal = 0, source = wallet()
  const native = request => {
    if (request.action === 'get_msg') return ok(request.params.message_id === 501
      ? { message_id: 501, message_type: 'group', group_id: target.id, user_id: '20000101' } : source)
    if (request.action === 'get_group_member_info') return ok({ group_id: target.id, user_id: request.params.user_id, card: request.params.user_id === account.id ? '可信机器人' : '可信目标', role: 'member' })
    if (request.action === 'send_packet') return ok()
    if (request.action === 'send_qzone_msg') return ok({ tid: 'post_1' })
    if (request.action === 'delete_qzone_msg') return ok()
    if (request.action === 'get_group_msg_history') return ok({ messages: [source] })
    if (request.action === 'send_group_msg') return ok({ message_id: -80 })
    if (request.action === 'grab_red_bag') return ok({ result: { grabRedBagRsp: { result: 0, recvdOrder: { amount: '138' } } } })
    assert.fail(`unexpected native request: ${request.action}`)
  }
  let handler = native
  const attach = value => {
    peer = value; peers.push(value); value.on('error', () => {})
    value.on('message', frame => {
      try {
        const request = JSON.parse(String(frame)); requests.push({ ...request, peer: value })
        if (request.action === 'get_login_info') { if (!holdLogin) reply(value, request, ok({ user_id: account.id, nickname: '认证机器人' })); return }
        const result = handler(request, value)
        if (result !== undefined) reply(value, request, result)
      } catch (error) { errors.push(error) }
    })
  }
  if (reverse) await new Promise(resolve => server.close(resolve))
  else server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/onebot' || request.headers.authorization !== `Bearer ${token}`) { socket.destroy(); return }
    sockets.handleUpgrade(request, socket, head, attach)
  })
  const adapter = createOneBotConnection({ connection, url, transport, accessToken: token,
    ...(actions ? { qqActions: actions } : {}), ...(ownPost ? { async qzoneOwnPost(selected, id) { return { account: selected, agentId: binding.agentId, postId: id, source: binding } } } : {}),
    onDisconnect() { disconnected++ }, onReconnect() { reconnected++ }, onError() { fatal++ }, onEventError() { errors.push(Error('unexpected event error')) },
  })
  t.after(async () => {
    adapter.stop(); for (const value of peers) value.terminate()
    if (sockets) await new Promise(resolve => sockets.close(resolve))
    server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve))
    assert.deepEqual(errors, [])
  })
  async function connectPeer(headers = {}) {
    assert.equal(reverse, true)
    return waitFor(async () => {
      const value = new WebSocket(url, { handshakeTimeout: 300, headers: { Authorization: `Bearer ${token}`, 'X-Self-ID': account.id, 'X-Client-Role': 'Universal', ...headers } })
      attach(value)
      try { await once(value, 'open'); return value } catch { value.terminate(); return undefined }
    }, 'reverse peer')
  }
  const started = adapter.start(async event => { events.push(event) }); void started.catch(() => {})
  if (reverse) await connectPeer()
  await waitFor(() => requests.find(request => request.action === 'get_login_info'), 'login')
  if (!holdLogin) await started
  return { adapter, started, requests, events, errors, connectPeer, native, peer: () => peer,
    setHandler(value) { handler = value }, setSource(value) { source = value },
    status: () => ({ disconnected, reconnected, fatal }), nonLogin: () => requests.filter(request => request.action !== 'get_login_info'),
    send(event, binary = false) { peer.send(JSON.stringify(event), { binary }) },
  }
}

test('QQ public entry exports constructors and explicit NapCat flags alone expose ports', { timeout: 10000 }, async t => {
  for (const name of ['createQqGiftDeliveryPort', 'createQqQzoneProvider', 'createQqRedPacketPort']) assert.equal(typeof qq[name], 'function')
  for (const actions of [null, { driver: 'napcat' }, { driver: 'llbot', giftDisplay: true, qzone: true, redPackets: true }]) {
    const f = await fixture(t, { actions })
    for (const name of ['gift', 'qzone', 'redPackets']) assert.equal(Object.hasOwn(f.adapter, name), false)
    f.send(wallet()); await delay(15)
    assert.equal(f.events.some(event => event.kind === 'red-packet'), false)
    assert.equal(JSON.stringify(f.events).includes('PRIVATE_'), false)
  }
})

for (const transport of ['forward-websocket', 'reverse-websocket']) {
  test(`${transport} gift and Qzone use one authenticated account and native ownership`, { timeout: 10000 }, async t => {
    const f = await fixture(t, { transport })
    assert.deepEqual(await f.adapter.gift(gift(), guard()), { state: 'confirmed', evidence: 'packet-accepted' })
    assert.deepEqual(f.nonLogin().map(({ action }) => action), ['get_msg', 'get_group_member_info', 'get_group_member_info', 'send_packet'])
    assert.equal(f.nonLogin().at(-1).params.cmd, 'MessageSvc.PbSendMsg')
    assert.match(f.nonLogin().at(-1).params.data, /^[a-f0-9]+$/u)
    assert.deepEqual(await f.adapter.qzone.execute(qzone(), guard()), { state: 'confirmed', postId: 'post_1' })
    assert.deepEqual(await f.adapter.qzone.execute(qzone('delete'), guard()), { state: 'confirmed' })
    assert.deepEqual(f.nonLogin().slice(-2).map(({ action, params }) => ({ action, params })), [
      { action: 'send_qzone_msg', params: { content: '空间测试正文' } }, { action: 'delete_qzone_msg', params: { tid: 'post_1' } },
    ])
  })

  test(`${transport} wallet ingress is separately proved and cannot leak native wallet credentials`, { timeout: 10000 }, async t => {
    const f = await fixture(t, { transport })
    f.send(wallet())
    const event = await waitFor(() => f.events.find(value => value.kind === 'red-packet'), 'red packet ingress')
    assert.deepEqual(event.target, target); assert.equal(event.packet.source.messageId, '-42')
    assert.equal(event.packet.kind, 'password'); assert.equal(JSON.stringify(event).includes('PRIVATE_'), false)
    assert.equal(f.events.some(value => value.kind === 'message'), false)
    assert.deepEqual(f.nonLogin().map(({ action, params }) => ({ action, params })), [{ action: 'get_msg', params: { message_id: -42 } }])
    assert.equal(await f.adapter.redPackets.revalidate(event.packet, guard()), true)
    assert.deepEqual(await f.adapter.redPackets.sendPassword(event.packet, guard()), { state: 'confirmed', messageId: '-80' })
    assert.deepEqual(await f.adapter.redPackets.grab(event.packet, guard()), { state: 'confirmed', amountFen: 138 })
    assert.equal(f.nonLogin().filter(row => row.action === 'send_group_msg').length, 1)
    assert.equal(f.nonLogin().filter(row => row.action === 'grab_red_bag').length, 1)
    assert.equal(JSON.stringify(f.events).includes('PRIVATE_'), false)
    f.send(recall(-42)); await waitFor(() => f.events.some(value => value.kind === 'recall'), 'recall')
    const count = f.nonLogin().length
    assert.equal(await f.adapter.redPackets.revalidate(event.packet, guard()), false)
    assert.equal(f.nonLogin().length, count)
  })

  test(`${transport} untrusted wallets and recalled queued ingress never become Core packets`, { timeout: 10000 }, async t => {
    const f = await fixture(t, { transport })
    f.send({ ...wallet(), self_id: '999999' }); f.send(wallet(), true)
    f.send({ ...wallet(), message_type: 'private', sub_type: 'friend' })
    f.send({ ...wallet(), message: [{ type: 'text', data: { text: 'wallet PRIVATE_PC_BODY' } }] })
    await delay(20)
    assert.equal(f.events.some(event => event.kind === 'red-packet'), false)
    assert.equal(f.nonLogin().length, 0)
    f.send(wallet()); f.send(recall(-42))
    await waitFor(() => f.events.some(event => event.kind === 'recall'), 'queued recall')
    assert.equal(f.events.some(event => event.kind === 'red-packet'), false)
    const held = []; f.setHandler(request => { if (request.action === 'get_msg') { held.push(request); return undefined }; return f.native(request) })
    f.setSource(wallet(-43)); f.send(wallet(-43)); await waitFor(() => held.length, 'held wallet proof')
    f.send(recall(-43)); await waitFor(() => f.events.filter(event => event.kind === 'recall').length === 2, 'in-flight wallet recall')
    reply(f.peer(), held[0], ok(wallet(-43))); await delay(15)
    assert.equal(f.events.some(event => event.kind === 'red-packet'), false)
  })

  test(`${transport} cancellation and invalid scopes before dispatch fail without native writes`, { timeout: 10000 }, async t => {
    const f = await fixture(t, { transport }), invalid = gift(); invalid.binding.connectionId = 'foreign'
    assert.equal((await f.adapter.gift(invalid, guard())).state, 'failed')
    assert.equal((await f.adapter.gift(gift(), guard({ isCurrent: () => false }))).state, 'failed')
    assert.equal((await f.adapter.qzone.execute(qzone(), guard({ async ensureCurrent() { throw Error('withdrawn') } }))).state, 'failed')
    assert.equal((await withDeliveryGuard(() => false, () => f.adapter.gift(gift(), guard()))).state, 'failed')
    assert.equal((await withDeliveryGuard(() => false, () => f.adapter.qzone.execute(qzone(), guard()))).state, 'failed')
    const controller = new AbortController(); controller.abort()
    assert.equal((await f.adapter.qzone.execute(qzone(), guard({ signal: controller.signal }))).state, 'failed')
    const accessor = { ...guard() }; let touched = 0
    Object.defineProperty(accessor, 'isCurrent', { get() { touched++; return () => true } })
    assert.equal((await f.adapter.gift(gift(), accessor)).state, 'failed'); assert.equal(touched, 0)
    assert.equal(f.nonLogin().length, 0)
    const packet = await f.adapter.redPackets.read(target, '-42', guard())
    assert.ok(packet)
    const count = f.nonLogin().length
    assert.equal((await f.adapter.redPackets.grab(packet, guard({ isCurrent: () => false }))).state, 'failed')
    assert.equal(f.nonLogin().length, count)
  })

  test(`${transport} dispatched gift and Qzone cancellation remain unknown without retry`, { timeout: 10000 }, async t => {
    const f = await fixture(t, { transport }), held = [], controller = new AbortController()
    f.setHandler(request => { if (request.action === 'send_qzone_msg') { held.push(request); return undefined }; return f.native(request) })
    const sending = f.adapter.qzone.execute(qzone(), guard({ signal: controller.signal }))
    await waitFor(() => held.length, 'dispatched Qzone write'); controller.abort()
    assert.equal((await sending).state, 'unknown'); reply(f.peer(), held[0], ok({ tid: 'late-post' }))
    const giftController = new AbortController()
    f.setHandler(request => { if (request.action === 'send_packet') { held.push(request); return undefined }; return f.native(request) })
    const gifting = f.adapter.gift(gift(), guard({ signal: giftController.signal }))
    await waitFor(() => held.length === 2, 'dispatched gift'); giftController.abort()
    assert.equal((await gifting).state, 'unknown'); reply(f.peer(), held[1], ok())
    await delay(15)
    assert.equal(f.nonLogin().filter(row => row.action === 'send_qzone_msg').length, 1)
    assert.equal(f.nonLogin().filter(row => row.action === 'send_packet').length, 1)
  })

  test(`${transport} the final awaited transport authorization can reject each write before socket dispatch`, { timeout: 10000 }, async t => {
    const f = await fixture(t, { transport })
    const rejectAt = count => {
      let checks = 0
      return guard({ async ensureCurrent() { if (++checks === count) throw Error('final native authorization denied') } })
    }
    assert.equal((await f.adapter.gift(gift(), rejectAt(8))).state, 'failed')
    assert.equal(f.nonLogin().some(row => row.action === 'send_packet'), false)
    assert.equal((await f.adapter.qzone.execute(qzone(), rejectAt(3))).state, 'failed')
    assert.equal(f.nonLogin().some(row => row.action === 'send_qzone_msg'), false)
    const packet = await f.adapter.redPackets.read(target, '-42', guard())
    assert.ok(packet)
    for (const [method, proofs] of [['sendPassword', ['get_msg']], ['grab', ['get_msg', 'get_group_member_info']]]) {
      const before = f.nonLogin().length
      let proofRead = false
      f.setHandler(request => {
        const result = f.native(request)
        if (request.action === proofs.at(-1)) proofRead = true
        return result
      })
      const result = await f.adapter.redPackets[method](packet, guard({
        async ensureCurrent() { if (proofRead) throw Error('final native authorization denied') },
      }))
      assert.equal(result.state, 'failed')
      assert.deepEqual(f.nonLogin().slice(before).map(row => row.action), proofs)
    }
  })

  test(`${transport} awaiting source checks cannot move an old invocation onto a reauthenticated socket`, { timeout: 12000 }, async t => {
    const f = await fixture(t, { transport }); let release, entered = false
    const waiting = new Promise(resolve => { release = resolve })
    const pending = f.adapter.qzone.execute(qzone(), guard({ async ensureCurrent() { entered = true; await waiting } }))
    await waitFor(() => entered, 'awaited source guard'); f.peer().terminate()
    await waitFor(() => f.status().disconnected === 1, 'guard disconnect')
    if (transport === 'reverse-websocket') await f.connectPeer()
    await waitFor(() => f.status().reconnected === 1, 'guard reconnect'); release()
    assert.equal((await pending).state, 'failed')
    assert.equal(f.nonLogin().length, 0)
  })

  test(`${transport} a native peer cannot forge a pre-dispatch failure after receiving an effect`, { timeout: 10000 }, async t => {
    const f = await fixture(t, { transport })
    const effects = new Set(['send_packet', 'send_qzone_msg', 'send_group_msg', 'grab_red_bag'])
    f.setHandler(request => effects.has(request.action) ? { state: 'failed', code: 'qq_action_cancelled' } : f.native(request))
    assert.equal((await f.adapter.gift(gift(), guard())).state, 'unknown')
    assert.equal((await f.adapter.qzone.execute(qzone(), guard())).state, 'unknown')
    const packet = await f.adapter.redPackets.read(target, '-42', guard())
    assert.equal((await f.adapter.redPackets.sendPassword(packet, guard())).state, 'unknown')
    assert.equal((await f.adapter.redPackets.grab(packet, guard())).state, 'unknown')
    for (const name of effects) assert.equal(f.nonLogin().filter(row => row.action === name).length, 1)
  })

  test(`${transport} wallet reads cancel without a snapshot and dispatched packet writes stay unknown`, { timeout: 10000 }, async t => {
    const f = await fixture(t, { transport }), held = [], readController = new AbortController()
    f.setHandler(request => { if (request.action === 'get_msg') { held.push(request); return undefined }; return f.native(request) })
    const reading = f.adapter.redPackets.read(target, '-42', guard({ signal: readController.signal }))
    await waitFor(() => held.length === 1, 'wallet source read'); readController.abort()
    assert.equal(await reading, undefined); reply(f.peer(), held[0], ok(wallet()))
    f.setHandler(f.native)
    const packet = await f.adapter.redPackets.read(target, '-42', guard())
    for (const [method, action] of [['sendPassword', 'send_group_msg'], ['grab', 'grab_red_bag']]) {
      let effect
      const controller = new AbortController()
      f.setHandler(request => { if (request.action === action) { effect = request; return undefined }; return f.native(request) })
      const executing = f.adapter.redPackets[method](packet, guard({ signal: controller.signal }))
      await waitFor(() => effect, action); controller.abort()
      assert.equal((await executing).state, 'unknown')
      reply(f.peer(), effect, f.native(effect))
      assert.equal(f.nonLogin().filter(request => request.action === action).length, 1)
    }
  })

  test(`${transport} reconnect clears old wallet handles and pending writes never move sockets`, { timeout: 12000 }, async t => {
    const f = await fixture(t, { transport }), originalPeer = f.peer()
    const packet = await f.adapter.redPackets.read(target, '-42', guard())
    let held
    f.setHandler(request => { if (request.action === 'send_qzone_msg') { held = request; return undefined }; return f.native(request) })
    const pending = f.adapter.qzone.execute(qzone(), guard())
    await waitFor(() => held, 'pending native write'); originalPeer.terminate()
    assert.equal((await pending).state, 'unknown')
    await waitFor(() => f.status().disconnected === 1, 'disconnect callback')
    if (transport === 'reverse-websocket') await f.connectPeer()
    await waitFor(() => f.status().reconnected === 1 && f.adapter.isReady(), 'reconnect')
    assert.notEqual(f.peer(), originalPeer)
    const before = f.nonLogin().length
    assert.equal(await f.adapter.redPackets.revalidate(packet, guard()), false)
    assert.equal(f.nonLogin().length, before)
    f.setHandler(f.native)
    const fresh = await f.adapter.redPackets.read(target, '-42', guard())
    assert.ok(fresh); assert.notEqual(fresh.packetRef, packet.packetRef)
    assert.deepEqual(await f.adapter.qzone.execute(qzone(), guard()), { state: 'confirmed', postId: 'post_1' })
    assert.equal(f.nonLogin().filter(row => row.action === 'send_qzone_msg').length, 2, 'only the new explicit request may use the new socket')
    f.adapter.stop(); assert.equal((await f.adapter.redPackets.grab(fresh, guard())).state, 'failed')
  })
}

test('enabled ports remain unusable before verified login and Qzone delete needs durable own-post proof', { timeout: 10000 }, async t => {
  const f = await fixture(t, { holdLogin: true })
  assert.equal((await f.adapter.gift(gift(), guard())).state, 'failed')
  assert.equal((await f.adapter.qzone.execute(qzone(), guard())).state, 'failed')
  assert.equal(await f.adapter.redPackets.read(target, '-42', guard()), undefined)
  assert.equal(f.nonLogin().length, 0)
  reply(f.peer(), f.requests[0], ok({ user_id: account.id })); await f.started
  const missing = await fixture(t, { ownPost: false })
  assert.equal((await missing.adapter.qzone.execute(qzone('delete'), guard())).state, 'failed')
  assert.equal(missing.nonLogin().length, 0)
})

test('account privacy invalidation retires wallet handles on the same socket while a new wallet remains usable', { timeout: 10000 }, async t => {
  const f = await fixture(t), facade = f.adapter.redPackets, peer = f.peer()
  const old = await facade.read(target, '-42', guard())
  assert.ok(old)
  f.adapter.invalidateRedPacketSources()
  assert.equal(f.adapter.redPackets, facade)
  assert.equal(f.peer(), peer); assert.equal(f.adapter.isReady(), true)
  const before = f.nonLogin().length
  assert.equal(await facade.revalidate(old, guard()), false)
  assert.equal((await facade.grab(old, guard())).state, 'failed')
  assert.equal(f.nonLogin().length, before)
  f.setSource(wallet(-43)); f.send(wallet(-43))
  const event = await waitFor(() => f.events.find(event => event.kind === 'red-packet'), 'fresh wallet after invalidation')
  assert.equal(event.packet.source.messageId, '-43'); assert.notEqual(event.packet.packetRef, old.packetRef)
  assert.equal(await facade.revalidate(event.packet, guard()), true)
})
