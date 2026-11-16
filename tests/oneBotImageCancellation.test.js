import assert from 'node:assert/strict'
import dns from 'node:dns/promises'
import { EventEmitter, once } from 'node:events'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocketServer } from 'ws'
import { createOneBotConnection } from '../dist/backend/adapters/oneBotConnection.js'

const account = { platform: 'qq', namespace: 'global', id: '123456789' }
const target = { account, kind: 'group', id: '315320' }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6d8AAAAASUVORK5CYII=', 'base64')
const urls = ['https://gchat.qpic.cn/download?id=first', 'https://gchat.qpic.cn/download?id=second']
const address = { address: '93.184.216.34', family: 4 }
const success = data => ({ status: 'ok', retcode: 0, data })
const original = () => success({ message_type: 'group', group_id: target.id, message_id: 17,
  time: Math.floor(Date.now() / 1000), sender: { user_id: '324152' },
  message: urls.map(url => ({ type: 'image', data: { url, file: 'opaque-image' } })),
})
const guard = overrides => ({ isCurrent: () => true, allowsSource: async () => true, ...overrides })

async function waitFor(probe, description, milliseconds = 1000) {
  const until = Date.now() + milliseconds
  while (Date.now() < until) {
    const result = probe()
    if (result) return result
    await delay(5)
  }
  assert.fail(`timed out waiting for ${description}`)
}

async function fixture(t, holdMessage = false, messageResponse = original) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  let peer
  const requests = []
  const reply = (request, response) => peer.send(JSON.stringify({ ...response, echo: request.echo }))
  server.on('connection', socket => {
    peer = socket
    socket.on('error', () => {})
    socket.on('message', data => {
      const request = JSON.parse(String(data))
      requests.push(request)
      if (request.action === 'get_login_info') reply(request, success({ user_id: account.id, nickname: '本地取图取消测试' }))
      else if (request.action === 'get_msg' && !holdMessage) reply(request, messageResponse())
    })
  })
  const adapter = createOneBotConnection({
    connection: { id: 'image-cancel-test', account }, url: `ws://127.0.0.1:${server.address().port}`, accessToken: 'test-only',
    onDisconnect() {}, onReconnect() {}, onError() {}, onEventError() {},
  })
  t.after(async () => {
    adapter.stop()
    for (const socket of server.clients) socket.terminate()
    await new Promise(resolve => server.close(resolve))
  })
  await adapter.start(async () => {})
  return { adapter, requests, reply, peer: () => peer }
}

/** Mock the native HTTPS boundary while preserving ClientRequest's AbortSignal behavior. */
function network(t, { lookup = async () => [address], complete = false } = {}) {
  const calls = [], lookups = []
  const dnsMock = t.mock.method(dns, 'lookup', async host => { lookups.push(host); return lookup(host) })
  const httpsMock = t.mock.method(https, 'request', (url, options, callback) => {
    const request = new EventEmitter(), response = new PassThrough()
    response.statusCode = 200; response.headers = { 'content-type': 'image/png' }
    const call = { url: String(url), options, request, response, requestDestroyed: 0, responseDestroyed: 0, headersDelivered: false }
    calls.push(call)
    const destroyResponse = response.destroy.bind(response)
    response.destroy = error => { call.responseDestroyed++; return destroyResponse(error) }
    request.destroyed = false
    request.destroy = error => {
      if (request.destroyed) return request
      request.destroyed = true
      call.requestDestroyed++
      queueMicrotask(() => request.emit('error', error ?? new Error('request aborted')))
      return request
    }
    const abort = () => request.destroy(options.signal.reason)
    options.signal.addEventListener('abort', abort, { once: true })
    response.once('end', () => options.signal.removeEventListener('abort', abort))
    request.end = () => queueMicrotask(() => {
      if (request.destroyed) return
      call.headersDelivered = true
      callback(response)
      if (complete) response.end(png)
      else response.write(png.subarray(0, 12)) // Headers and some body arrive; the rest never does.
    })
    return request
  })
  syncBuiltinESMExports()
  t.after(() => {
    for (const call of calls) call.response.destroy()
    dnsMock.mock.restore(); httpsMock.mock.restore(); syncBuiltinESMExports()
  })
  return { calls, lookups }
}

test('an explicit image abort stops get_msg waiting and ignores its late image reply', { timeout: 5000 }, async t => {
  const f = await fixture(t, true), n = network(t), controller = new AbortController()
  let authorized = 0
  const pending = f.adapter.readMessageImages(target, '17', guard({ signal: controller.signal, async allowsSource() { authorized++; return true } }))
  const request = await waitFor(() => f.requests.find(request => request.action === 'get_msg'), 'get_msg dispatch')
  const abortedAt = Date.now()
  controller.abort()
  assert.equal(await pending, undefined)
  assert.ok(Date.now() - abortedAt < 500, 'abort must not wait for the get_msg timeout')
  f.reply(request, original())
  await delay(30)
  assert.equal(authorized, 0)
  assert.equal(n.lookups.length, 0)
  assert.equal(n.calls.length, 0)
  assert.equal(f.adapter.isReady(), true)
})

test('aborting a pending QQ image DNS lookup never starts HTTPS, even after late DNS resolution', { timeout: 5000 }, async t => {
  let resolveDns
  const n = network(t, { lookup: () => new Promise(resolve => { resolveDns = resolve }) }), f = await fixture(t)
  const controller = new AbortController()
  const pending = f.adapter.readMessageImages(target, '17', guard({ signal: controller.signal }))
  await waitFor(() => resolveDns, 'DNS wait')
  controller.abort()
  assert.equal(await pending, undefined)
  assert.equal(n.calls.length, 0)
  resolveDns([address])
  await delay(30)
  assert.equal(n.calls.length, 0)
  assert.equal(n.lookups.length, 1)
})

for (const source of ['url', 'inline']) {
  test(`abort releases a suspended source authorization for ${source} images before downloading`, { timeout: 5000 }, async t => {
    const n = network(t), f = await fixture(t, false, () => {
      const response = original()
      if (source === 'inline') response.data.message = [{ type: 'image', data: { file: `base64://${png.toString('base64')}` } }]
      return response
    }), controller = new AbortController()
    let entered = false, releaseAuthorization
    const authorization = new Promise(resolve => { releaseAuthorization = resolve })
    const pending = f.adapter.readMessageImages(target, '17', guard({ signal: controller.signal,
      async allowsSource() { entered = true; return authorization },
    }))
    await waitFor(() => entered, 'source authorization wait')
    controller.abort()
    const timeout = Symbol('authorization cancellation timed out')
    const result = await Promise.race([pending, delay(500).then(() => timeout)])
    // Release an uncooperative check even on failure so a regression cannot hang this test process.
    releaseAuthorization(true)
    await pending
    await delay(30)
    assert.notEqual(result, timeout, 'aborting must release the image operation without waiting for an unrelated policy promise')
    assert.equal(result, undefined)
    assert.equal(n.calls.length, 0)
    assert.equal(n.lookups.length, source === 'url' ? 1 : 0)
  })
}

for (const cancellation of ['signal', 'binding-guard', 'socket']) {
  test(`${cancellation} cancellation destroys an already streaming QQ image and never starts the second image`, { timeout: 5000 }, async t => {
    const n = network(t), f = await fixture(t), controller = new AbortController()
    let current = true, authorized = 0
    const pending = f.adapter.readMessageImages(target, '17', guard({
      ...(cancellation === 'signal' ? { signal: controller.signal } : {}), isCurrent: () => current,
      async allowsSource() { authorized++; return true },
    }))
    const first = await waitFor(() => n.calls.find(call => call.headersDelivered), 'hanging response body')
    assert.equal(first.options.signal.aborted, false)
    const cancelledAt = Date.now()
    if (cancellation === 'signal') controller.abort()
    else if (cancellation === 'binding-guard') current = false
    else f.peer().terminate()
    assert.equal(await pending, undefined)
    assert.ok(Date.now() - cancelledAt < 500, 'cancellation must interrupt the body before the 5-second deadline')
    assert.equal(first.options.signal.aborted, true)
    assert.ok(first.requestDestroyed >= 1, 'native request observes its AbortSignal')
    assert.ok(first.responseDestroyed >= 1, 'the already received body stream is destroyed')
    assert.equal(first.response.destroyed, true)
    assert.equal(n.calls.length, 1)
    assert.equal(authorized, 1)
    await delay(35)
    assert.equal(n.calls.length, 1, 'no retry or second attachment follows cancellation')
  })
}

test('uncancelled QQ image reads preserve both validated images and a healthy connection', { timeout: 5000 }, async t => {
  const n = network(t, { complete: true }), f = await fixture(t), controller = new AbortController()
  let authorized = 0
  const images = await f.adapter.readMessageImages(target, '17', guard({ signal: controller.signal, async allowsSource() { authorized++; return true } }))
  assert.deepEqual(images, [{ mime: 'image/png', base64: png.toString('base64') }, { mime: 'image/png', base64: png.toString('base64') }])
  assert.equal(n.calls.length, 2)
  assert.equal(authorized, 2)
  assert.equal(controller.signal.aborted, false)
  assert.equal(f.adapter.isReady(), true)
})
