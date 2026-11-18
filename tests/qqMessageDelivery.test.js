import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket, { WebSocketServer } from 'ws'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'

const { createQqMessageActionPort } = await importBilibiliHost('adapters/qqMessageDelivery.js')
const { createOneBotConnection } = await importBilibiliHost('adapters/oneBotConnection.js')
const account = { platform: 'qq', namespace: 'global', id: '123456789' }, target = { account, kind: 'group', id: '315320' }
const methods = {
  send: () => ({ version: 1, kind: 'message.send', target, parts: [{ kind: 'text', text: '待最终核验的消息' }] }),
  sendBundle: () => ({ version: 1, kind: 'message.bundle.send', target, items: [{ parts: [{ kind: 'text', text: '待最终核验的节点' }] }] }),
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function waitFor(probe, label) {
  const until = Date.now() + 5000
  while (Date.now() < until) { if (probe()) return; await delay(10) }
  assert.fail(`timed out: ${label}`)
}

for (const [method, action] of Object.entries(methods)) {
  test(`QQ ${method} awaits final authority after preparation and dispatches exactly once`, async t => {
    const gate = deferred(), events = [], input = action()
    t.after(() => gate.resolve())
    const port = createQqMessageActionPort({ async sendApi(api, params) {
      events.push('native'); assert.equal(params.group_id, Number(target.id))
      assert.equal(api, method === 'send' ? 'send_group_msg' : 'send_group_forward_msg')
      const content = method === 'send' ? params.message : params.messages[0].data.content
      assert.equal(content[0].data.text, method === 'send' ? '待最终核验的消息' : '待最终核验的节点')
      return { status: 'ok', retcode: 0, data: { message_id: 77 } }
    } })
    const guard = { isCurrent: () => true, async ensureCurrent() { assert.equal(this, guard); events.push('ensure'); await gate.promise; events.push('authorized') } }
    const pending = port[method](input, guard)
    await delay(0); assert.deepEqual(events, ['ensure'], 'no native API may run while final authorization waits')
    if (method === 'send') input.parts[0].text = '后来改写的正文'
    else input.items[0].parts[0].text = '后来改写的节点'
    gate.resolve(); assert.deepEqual(await pending, { state: 'sent', messageId: '77' })
    assert.deepEqual(events, ['ensure', 'authorized', 'native'])
  })

  test(`QQ ${method} rechecks synchronous authority after the awaited check and sends nothing when revoked`, async t => {
    const gate = deferred(); let entered = false, current = true, calls = 0
    t.after(() => gate.resolve())
    const port = createQqMessageActionPort({ async sendApi() { calls++; return { message_id: 77 } } })
    const pending = port[method](action(), { isCurrent: () => current, async ensureCurrent() { entered = true; await gate.promise } })
    await delay(0); assert.equal(entered, true); assert.equal(calls, 0)
    current = false; gate.resolve(); assert.equal((await pending).state, 'failed'); assert.equal(calls, 0)
  })

  test(`QQ ${method} classifies a final authority exception as failed before dispatch`, async () => {
    let checks = 0, calls = 0
    const port = createQqMessageActionPort({ async sendApi() { calls++; return { message_id: 77 } } })
    const receipt = await port[method](action(), { async ensureCurrent() { checks++; throw Error('fresh source is gone') } })
    assert.equal(receipt.state, 'failed'); assert.equal(checks, 1); assert.equal(calls, 0)
  })

  test(`QQ ${method} retains unknown after native dispatch throws and never retries`, async () => {
    let checks = 0, calls = 0
    const port = createQqMessageActionPort({ async sendApi() { calls++; throw Error('connection lost after native write') } })
    assert.deepEqual(await port[method](action(), { async ensureCurrent() { checks++ } }), { state: 'unknown' })
    assert.equal(checks, 1); assert.equal(calls, 1)
  })
}

async function socketFixture(t, transport) {
  const requests = [], peers = [], token = 'message-finalguard-token'
  let server, url, held
  const source = { post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: Number(account.id), group_id: Number(target.id),
    user_id: 324152, sender: { user_id: 324152, nickname: '当前发送者' }, message_id: 721, time: Math.floor(Date.now() / 1000),
    message: [{ type: 'text', data: { text: '当前来源' } }] }
  const attach = peer => {
    peers.push(peer); peer.on('error', () => {}); peer.on('message', frame => {
      const request = JSON.parse(String(frame)); requests.push(request)
      const reply = data => peer.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo, data }))
      if (request.action === 'get_login_info') reply({ user_id: account.id, nickname: '最终核验机器人' })
      else if (request.action === 'get_msg') { assert.equal(String(request.params.message_id), '721'); held = () => reply(source) }
      else if (['send_group_msg', 'send_group_forward_msg'].includes(request.action)) reply({ message_id: 881 })
      else assert.fail(`unexpected final-guard socket action ${request.action}`)
    }); return peer
  }
  if (transport === 'forward-websocket') {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening'); server.on('connection', attach)
    url = `ws://127.0.0.1:${server.address().port}`
  } else {
    const allocator = createServer(); allocator.listen(0, '127.0.0.1'); await once(allocator, 'listening')
    url = `ws://127.0.0.1:${allocator.address().port}/onebot`; await new Promise(resolve => allocator.close(resolve))
  }
  const adapter = createOneBotConnection({ connection: { id: 'message-finalguard', account }, transport, url, accessToken: token,
    onDisconnect() {}, onReconnect() {}, onError() {}, onEventError() {} })
  t.after(async () => { adapter.stop(); for (const peer of peers) peer.terminate(); if (server) await new Promise(resolve => server.close(resolve)) })
  const started = adapter.start(async () => {}); void started.catch(() => {})
  if (transport === 'reverse-websocket') {
    let connected = false
    const until = Date.now() + 5000
    while (Date.now() < until && !connected) {
      const peer = attach(new WebSocket(url, { headers: { Authorization: `Bearer ${token}`, 'X-Self-ID': account.id, 'X-Client-Role': 'Universal' } }))
      try { await once(peer, 'open'); connected = true } catch { peer.terminate(); await delay(10) }
    }
    assert.equal(connected, true, 'reverse socket must open before final guard proof')
  }
  await started
  return { adapter, requests, async releaseSource() { await waitFor(() => held, 'fresh get_msg before native dispatch'); held() }, hasSourceRead: () => !!held }
}

for (const transport of ['forward-websocket', 'reverse-websocket']) for (const [method, action] of Object.entries(methods)) {
  for (const revoke of [false, true]) test(`${transport} ${method} waits for real final get_msg; revoked=${revoke}`, { timeout: 15000 }, async t => {
    const f = await socketFixture(t, transport); let current = true, checks = 0
    const pending = f.adapter.actions[method](action(), { isCurrent: () => current, async ensureCurrent() {
      checks++
      const source = await f.adapter.readMessage(target, '721', { isCurrent: () => current })
      if (!source || source.sender.id !== '324152' || source.text !== '当前来源') throw Error('fresh source unavailable')
    } })
    await waitFor(() => f.hasSourceRead(), 'fresh source request')
    assert.deepEqual(f.requests.map(row => row.action), ['get_login_info', 'get_msg'])
    if (revoke) current = false
    await f.releaseSource(); const receipt = await pending
    assert.equal(checks, 1)
    if (revoke) {
      assert.equal(receipt.state, 'failed'); assert.deepEqual(f.requests.map(row => row.action), ['get_login_info', 'get_msg'])
    } else {
      assert.deepEqual(receipt, { state: 'sent', messageId: '881' })
      assert.deepEqual(f.requests.map(row => row.action), ['get_login_info', 'get_msg', method === 'send' ? 'send_group_msg' : 'send_group_forward_msg'])
    }
  })
}
