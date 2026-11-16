import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket, { WebSocketServer } from 'ws'
import { createOneBotConnection } from '../dist/backend/adapters/oneBotConnection.js'

const account = { platform: 'qq', namespace: 'global', id: '123456789' }
const target = { account, kind: 'group', id: '315320' }
const token = 'bundle-local-token'
const png = { kind: 'image', mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6d8AAAAASUVORK5CYII=' }
const item = text => ({ parts: [{ kind: 'text', text }] })
const action = (items = [item('项目结果')], conversation = target) => ({ version: 1, kind: 'message.bundle.send', target: conversation, items })

async function waitFor(probe, description) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (probe()) return
    await delay(10)
  }
  assert.fail(`timed out waiting for ${description}`)
}

async function fixture(t, transport) {
  const requests = [], peers = []
  let mode = 'sent', server, url, disconnected = 0
  const respond = (peer, frame) => {
    const request = JSON.parse(String(frame))
    requests.push(request)
    if (request.action === 'get_login_info') {
      peer.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo,
        data: { user_id: account.id, nickname: '账号核验名称' } }))
      return
    }
    if (mode === 'disconnect') { peer.terminate(); return }
    peer.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo,
      data: mode === 'resource-only' ? { res_id: 'not-a-send-receipt' } : { message_id: `bundle-${requests.length}` } }))
  }
  const attach = peer => {
    peer.on('error', () => {})
    peer.on('message', frame => respond(peer, frame))
    peers.push(peer)
    return peer
  }
  if (transport === 'forward-websocket') {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(server, 'listening')
    server.on('connection', attach)
    url = `ws://127.0.0.1:${server.address().port}`
  } else {
    const allocator = createServer()
    allocator.listen(0, '127.0.0.1')
    await once(allocator, 'listening')
    url = `ws://127.0.0.1:${allocator.address().port}/onebot`
    await new Promise(resolve => allocator.close(resolve))
  }
  const adapter = createOneBotConnection({ connection: { id: 'bundle-local', account }, transport, url, accessToken: token,
    onDisconnect() { disconnected++ }, onReconnect() {}, onError() {}, onEventError() {} })
  t.after(async () => {
    adapter.stop()
    for (const peer of peers) peer.terminate()
    if (server) await new Promise(resolve => server.close(resolve))
  })
  const connectPeer = async () => {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const peer = attach(new WebSocket(url, { headers: {
        Authorization: `Bearer ${token}`, 'X-Self-ID': account.id, 'X-Client-Role': 'Universal',
      } }))
      try { await once(peer, 'open'); return peer }
      catch { peer.terminate(); await delay(10) }
    }
    assert.fail('reverse bundle listener did not accept its local peer')
  }
  const started = adapter.start(async () => {})
  void started.catch(() => {})
  if (transport === 'reverse-websocket') await connectPeer()
  await started
  return { adapter, requests, connectPeer, setMode(value) { mode = value }, disconnected: () => disconnected }
}

for (const transport of ['forward-websocket', 'reverse-websocket']) {
  test(`${transport} delivers bounded bundles to the original QQ account and fences the final write`, { timeout: 15_000 }, async t => {
    const { adapter, requests } = await fixture(t, transport)
    assert.equal(adapter.isReady(), true)
    assert.equal(typeof adapter.actions.sendBundle, 'function')
    for (const candidate of [
      action(undefined, { ...target, account: { ...account, id: '99999' } }),
      { ...action(), binding: { connectionId: 'another-connection' } },
      action([{ ...item('不得伪造作者'), sender: '99999' }]),
      action([{ parts: [{ ...png, base64: 'https://example.test/remote.png' }] }]),
    ]) assert.equal((await adapter.actions.sendBundle(candidate)).state, 'failed')
    assert.equal((await adapter.actions.sendBundle(action(), { isCurrent: () => false })).state, 'failed')
    let checks = 0
    assert.deepEqual(await adapter.actions.sendBundle(action(), { isCurrent: () => ++checks < 3 }),
      { state: 'failed', code: 'binding_changed' })
    assert.equal(checks, 3)
    assert.deepEqual(requests.map(request => request.action), ['get_login_info'])

    const items = [{ parts: [{ kind: 'text', text: '模组标题' }, png] }, item('https://modrinth.com/mod/fixture')]
    for (const [kind, api, key] of [['group', 'send_group_forward_msg', 'group_id'], ['private', 'send_private_forward_msg', 'user_id']]) {
      const receipt = await adapter.actions.sendBundle(action(items, { ...target, kind }), { isCurrent: () => true })
      const request = requests.at(-1)
      assert.deepEqual(receipt, { state: 'sent', messageId: `bundle-${requests.length}` })
      assert.equal(request.action, api)
      assert.equal(request.params[key], Number(target.id))
      assert.equal(request.params.messages.length, 2)
      for (const node of request.params.messages) {
        assert.equal(node.type, 'node')
        assert.equal(node.data.name, 'Agent')
        assert.equal(node.data.uin, account.id)
      }
      assert.deepEqual(request.params.messages[0].data.content, [
        { type: 'text', data: { text: '模组标题' } }, { type: 'image', data: { file: `base64://${png.base64}` } },
      ])
    }
    assert.deepEqual(requests.map(request => request.action), ['get_login_info', 'send_group_forward_msg', 'send_private_forward_msg'])
    adapter.stop()
    assert.equal((await adapter.actions.sendBundle(action())).state, 'failed')
    assert.equal(requests.length, 3)
  })

  test(`${transport} keeps missing message IDs and disconnects unknown without replaying a bundle`, { timeout: 15_000 }, async t => {
    const local = await fixture(t, transport)
    local.setMode('resource-only')
    assert.deepEqual(await local.adapter.actions.sendBundle(action([item('one'), item('two')])), { state: 'unknown' })
    assert.equal(local.requests.filter(row => row.action === 'send_group_forward_msg').length, 1)
    local.setMode('disconnect')
    assert.deepEqual(await local.adapter.actions.sendBundle(action()), { state: 'unknown' })
    await waitFor(() => local.disconnected() === 1, 'bundle connection close')
    local.setMode('sent')
    if (transport === 'reverse-websocket') await local.connectPeer()
    await waitFor(() => local.adapter.isReady(), 'reverified bundle connection')
    assert.equal(local.requests.filter(row => row.action === 'send_group_forward_msg').length, 2)
    assert.equal(local.requests.filter(row => row.action === 'get_login_info').length, 2)
  })
}

test('OneBot transmits the explicit 12 MiB outbound image allowance independently of the inbound frame cap', { timeout: 15_000 }, async t => {
  const { adapter, requests } = await fixture(t, 'forward-websocket')
  const bytes = Buffer.alloc(2 * 1024 * 1024)
  Buffer.from(png.base64, 'base64').copy(bytes)
  const image = { ...png, base64: bytes.toString('base64') }
  const receipt = await adapter.actions.sendBundle(action(Array.from({ length: 6 }, () => ({ parts: [image] }))))
  assert.equal(receipt.state, 'sent')
  const request = requests.at(-1)
  assert.equal(request.action, 'send_group_forward_msg')
  assert.equal(request.params.messages.length, 6)
  assert.ok(Buffer.byteLength(JSON.stringify(request)) > 16 * 1024 * 1024)
})
