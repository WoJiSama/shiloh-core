import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket, { WebSocketServer } from 'ws'
import { createQqFileDeliveryPort } from '../dist/backend/adapters/qqFileDelivery.js'
import { createOneBotConnection } from '../dist/backend/adapters/oneBotConnection.js'

const account = { platform: 'qq', namespace: 'global', id: '123456789' }
const target = { account, kind: 'group', id: '315320' }
const file = { name: '完整报告.txt', mime: 'text/plain', base64: Buffer.from('第一行\n最后一行🙂\n').toString('base64') }
const action = (overrides = {}) => ({ version: 1, kind: 'file.upload', target, file, ...overrides })
const success = (fileId = 'file-uuid') => ({ status: 'ok', retcode: 0, data: { file_id: fileId } })
const binding = { source: 'configured', id: 'group-binding', revision: 'r1', personaId: 'default', agentId: 'alice', connectionId: 'file-local', target }

async function waitFor(probe) {
  const until = Date.now() + 3000
  while (Date.now() < until) { const value = await probe(); if (value) return value; await delay(5) }
  assert.fail('Timed out waiting for file fixture')
}
function direct(response = success()) {
  const calls = []
  const sendFile = createQqFileDeliveryPort({ account, connectionId: 'file-local', async sendApi(action, params, options) {
    calls.push({ action, params, options })
    return typeof response === 'function' ? response(action, params, options) : response
  } })
  return { calls, sendFile }
}

for (const kind of ['group', 'private']) {
  test(`QQ ${kind} upload preserves full inline bytes and constructs only fixed native parameters`, async () => {
    const d = direct(), conversation = { ...target, kind }
    assert.deepEqual(await d.sendFile(action({ target: conversation })), { state: 'uploaded', fileId: 'file-uuid' })
    assert.equal(d.calls.length, 1)
    assert.equal(d.calls[0].action, kind === 'group' ? 'upload_group_file' : 'upload_private_file')
    assert.deepEqual(d.calls[0].params, { [kind === 'group' ? 'group_id' : 'user_id']: target.id, file: `base64://${file.base64}`, name: file.name })
    assert.equal(Buffer.from(d.calls[0].params.file.slice(9), 'base64').toString('utf8'), '第一行\n最后一行🙂\n')
    assert.equal(Object.isFrozen(d.calls[0].params), true)
  })
}

test('file UUID is never substituted for a message ID, including numeric-looking file IDs', async () => {
  const d = direct({ ...success('12345'), data: { file_id: '12345', message_id: 17 } })
  assert.deepEqual(await d.sendFile(action()), { state: 'uploaded', fileId: '12345' })
})

test('only the exact account/namespace/conversation and matching binding are accepted', async () => {
  const d = direct()
  for (const conversation of [
    { ...target, kind: 'channel' }, { ...target, id: '0315320' }, { ...target, id: '' },
    { ...target, account: { ...account, id: '999999' } }, { ...target, account: { ...account, namespace: 'tenant' } },
    { ...target, account: { ...account, platform: 'telegram' } },
  ]) assert.equal((await d.sendFile(action({ target: conversation }))).state, 'failed')
  for (const invalid of [{ ...binding, connectionId: 'other' }, { ...binding, target: { ...target, id: '999999' } }]) {
    assert.equal((await d.sendFile(action({ binding: invalid }))).state, 'failed')
  }
  assert.equal(d.calls.length, 0)
  assert.deepEqual(await d.sendFile(action({ binding })), { state: 'uploaded', fileId: 'file-uuid' })
})

test('closed upload parameters reject model paths, URLs, folders, targets and accessor objects before dispatch', async () => {
  const d = direct()
  for (const extra of [{ path: '/etc/passwd' }, { url: 'https://example.com/file' }, { folder_id: 'folder' }, { target }, { origin: 'current' }]) {
    assert.equal((await d.sendFile(action({ file: { ...file, ...extra } }))).state, 'failed')
    if (!Object.hasOwn(extra, 'target')) assert.equal((await d.sendFile(action(extra))).state, 'failed')
  }
  let read = false
  const accessor = { mime: file.mime, base64: file.base64, get name() { read = true; return file.name } }
  assert.equal((await d.sendFile(action({ file: accessor }))).state, 'failed')
  assert.equal(read, false)
  assert.equal(d.calls.length, 0)
})

test('uploads require canonical nonempty base64, safe 255-character names and at most 12 MiB', async () => {
  const d = direct()
  for (const invalid of [
    { base64: '' }, { base64: 'YQ' }, { base64: 'YR==' }, { base64: 'YQ==\n' }, { base64: 'base64://YQ==' },
    { name: '../秘密.txt' }, { name: 'a\\秘密.txt' }, { name: '.' }, { name: '..' }, { name: 'a\n.txt' }, { name: 'a'.repeat(256) },
    { mime: 'text/plain; charset=utf-8' }, { base64: Buffer.alloc(12 * 1024 * 1024 + 1).toString('base64') },
  ]) assert.equal((await d.sendFile(action({ file: { ...file, ...invalid } }))).state, 'failed')
  assert.equal(d.calls.length, 0)
  const maximum = { ...file, name: 'a'.repeat(255), base64: Buffer.alloc(12 * 1024 * 1024).toString('base64') }
  assert.equal((await d.sendFile(action({ file: maximum }))).state, 'uploaded')
  assert.equal(d.calls.length, 1)
})

test('null, empty, malformed and absent native file evidence remain unknown without a retry', async () => {
  for (const response of [undefined, null, {}, { retcode: 0 }, success(null), success(''), success(' '), success('bad\nid'),
    success(17), { status: 'ok', retcode: 0, data: { message_id: 17 } }, { status: 'async', retcode: 0, data: { file_id: 'uuid' } },
    { status: 'ok', retcode: '0', data: { file_id: 'uuid' } },
    { ...success(), self_id: '999999' }, { ...success(), group_id: '999999' },
  ]) {
    const d = direct(() => response)
    assert.deepEqual(await d.sendFile(action()), { state: 'unknown' })
    assert.equal(d.calls.length, 1)
  }
})

test('native schema rejection wins over file evidence while handler errors remain unknown', async () => {
  for (const response of [{ ...success(), status: 'failed', retcode: 400 }, { ...success(), retcode: 1400 }]) {
    const d = direct(response)
    assert.deepEqual(await d.sendFile(action()), { state: 'failed', code: String(response.retcode) })
    assert.equal(d.calls.length, 1)
  }
  for (const response of [{ ...success(), status: 'failed', retcode: 1200 }, { ...success(), retcode: 200 },
    { status: 'failed' }, { status: 'failed', retcode: 500 }, { retcode: -1 },
  ]) {
    const d = direct(response)
    assert.deepEqual(await d.sendFile(action()), { state: 'unknown' })
    assert.equal(d.calls.length, 1)
  }
})

test('transport exceptions are unknown and cannot trigger another upload', async () => {
  const d = direct(() => { throw new Error('remote may have uploaded') })
  assert.deepEqual(await d.sendFile(action()), { state: 'unknown' })
  assert.equal(d.calls.length, 1)
})

test('cancelled or stale requests fail before native dispatch', async () => {
  const d = direct(), controller = new AbortController(); controller.abort()
  assert.equal((await d.sendFile(action(), { signal: controller.signal })).state, 'failed')
  assert.equal((await d.sendFile(action(), { isCurrent: () => false })).state, 'failed')
  assert.equal(d.calls.length, 0)
})

for (const cancellation of ['signal', 'guard', 'target', 'binding']) {
  test(`a dispatched upload losing ${cancellation} reports unknown and ignores its late success`, async () => {
    let release, current = true
    const d = direct(() => new Promise(resolve => { release = resolve })), controller = new AbortController()
    const ownTarget = structuredClone(target), ownBinding = { ...binding, target: ownTarget }
    const pending = d.sendFile(action({ target: ownTarget, binding: ownBinding }), { signal: controller.signal, isCurrent: () => current })
    await waitFor(() => release)
    if (cancellation === 'signal') controller.abort()
    else if (cancellation === 'guard') current = false
    else if (cancellation === 'target') ownTarget.id = '999999'
    else ownBinding.revision = 'r2'
    assert.deepEqual(await Promise.race([pending, delay(500).then(() => 'timeout')]), { state: 'unknown' })
    assert.equal(d.calls[0].options.signal.aborted, true)
    release(success('late-id'))
    await delay(5)
    assert.equal(d.calls.length, 1)
  })
}

test('a queued transport receives a live guard and cannot publish after it closes', async () => {
  let current = true, sent = 0, enter
  const d = direct(async (_action, _params, options) => {
    enter = true
    await delay(40)
    if (options.isCurrent()) sent++
    return success()
  })
  const pending = d.sendFile(action(), { isCurrent: () => current })
  await waitFor(() => enter)
  current = false
  assert.deepEqual(await pending, { state: 'unknown' })
  await delay(50)
  assert.equal(sent, 0)
})

async function fixture(t, transport) {
  const requests = [], peers = []
  let peer, server, url, handler = () => success()
  const attach = socket => {
    peer = socket; peers.push(socket); socket.on('error', () => {})
    socket.on('message', raw => {
      const request = JSON.parse(String(raw)); requests.push(request)
      const response = request.action === 'get_login_info' ? { status: 'ok', retcode: 0, data: { user_id: account.id, nickname: '上传合成验收' } } : handler(request, socket)
      if (response) socket.send(JSON.stringify({ ...response, echo: request.echo }))
    })
    return socket
  }
  if (transport === 'forward-websocket') {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening')
    server.on('connection', attach); url = `ws://127.0.0.1:${server.address().port}`
  } else {
    const allocator = createServer(); allocator.listen(0, '127.0.0.1'); await once(allocator, 'listening')
    url = `ws://127.0.0.1:${allocator.address().port}/onebot`; await new Promise(resolve => allocator.close(resolve))
  }
  const adapter = createOneBotConnection({ connection: { id: 'file-local', account }, transport, url, accessToken: 'upload-fixture',
    onDisconnect() {}, onReconnect() {}, onError() {}, onEventError() {},
  })
  t.after(async () => { adapter.stop(); for (const socket of peers) socket.terminate(); if (server) await new Promise(resolve => server.close(resolve)) })
  assert.equal((await adapter.actions.sendFile(action())).state, 'failed', 'login is required before upload')
  const start = adapter.start(async () => {}); void start.catch(() => {})
  if (transport === 'reverse-websocket') {
    await waitFor(async () => {
      const socket = attach(new WebSocket(url, { headers: { Authorization: 'Bearer upload-fixture', 'X-Self-ID': account.id, 'X-Client-Role': 'Universal' } }))
      try { await once(socket, 'open'); return true }
      catch { socket.terminate(); return false }
    })
  }
  await start
  return { adapter, requests, peer: () => peer, setHandler(value) { handler = value } }
}

for (const transport of ['forward-websocket', 'reverse-websocket']) {
  test(`${transport} uploads to fixed QQ group and private targets over authenticated sockets`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport)
    for (const kind of ['group', 'private']) {
      assert.deepEqual(await f.adapter.actions.sendFile(action({ target: { ...target, kind } })), { state: 'uploaded', fileId: 'file-uuid' })
    }
    assert.deepEqual(f.requests.filter(row => row.action !== 'get_login_info').map(row => ({ action: row.action, params: row.params })), [
      { action: 'upload_group_file', params: { group_id: target.id, file: `base64://${file.base64}`, name: file.name } },
      { action: 'upload_private_file', params: { user_id: target.id, file: `base64://${file.base64}`, name: file.name } },
    ])
    assert.equal(f.adapter.isReady(), true)
  })
  for (const mode of ['abort', 'stop', 'disconnect', 'binding']) {
    test(`${transport} dispatched upload ${mode} remains unknown with exactly one native request`, { timeout: 8000 }, async t => {
      const f = await fixture(t, transport), controller = new AbortController()
      let current = true
      f.setHandler(() => undefined)
      const pending = f.adapter.actions.sendFile(action(), { signal: controller.signal, isCurrent: () => current })
      await waitFor(() => f.requests.find(row => row.action === 'upload_group_file'))
      if (mode === 'abort') controller.abort()
      else if (mode === 'stop') f.adapter.stop()
      else if (mode === 'disconnect') f.peer().terminate()
      else current = false
      assert.deepEqual(await Promise.race([pending, delay(600).then(() => 'timeout')]), { state: 'unknown' })
      assert.equal(f.requests.filter(row => row.action === 'upload_group_file').length, 1)
    })
  }
}
