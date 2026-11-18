import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import WebSocket, { WebSocketServer } from 'ws'
import { download, sha, waitFor } from './helpers/requesterArchiveFixture.mjs'
const logBytes = (size = 128) => Buffer.alloc(size, 'a')
const artifact = (bytes = logBytes()) => ({ name: '跑团记录.txt', mime: 'text/plain', base64: bytes.toString('base64') })

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const compiled = name => pathToFileURL(path.join(release, 'dist/backend', name)).href
const { createQqGroupLogDeliveryPort } = await import(compiled('adapters/qqGroupLogDelivery.js'))
const { createOneBotConnection, openQqGroupLogBridge } = await import(compiled('adapters/oneBotConnection.js'))
const { withDeliveryGuard, queuedDeliveryAllowed } = await import(compiled('modules/messaging/infrastructure/deliveryScope.js'))
const account = { platform: 'qq', namespace: 'global', id: '123456789' }, sender = { ...account, id: '324152' }
const target = { account, kind: 'group', id: '315320' }, occurredAt = 1800000000000
const binding = { source: 'configured', id: 'group-log-binding', revision: 'r1', personaId: 'default', agentId: 'alice', connectionId: 'log-local', target }
const action = () => ({ version: 1, kind: 'group-log.upload', target: structuredClone(target), binding: structuredClone(binding),
  source: { sender: { ...sender }, occurredAt, messageId: '71', textSha256: sha(Buffer.from('.log export current')) }, log: artifact() })
const success = () => ({ status: 'ok', retcode: 0, data: { file_id: 'native-file-17' } })
const message = extra => ({ status: 'ok', retcode: 0, data: { self_id: account.id, message_type: 'group', group_id: target.id,
  message_id: 71, user_id: sender.id, sender: { user_id: sender.id }, time: occurredAt / 1000, message: [{ type: 'text', data: { text: '.log export current' } }], ...extra } })
function bridgeFixture(stage) {
  const stages = [], contexts = []; let released = 0
  return { stages, contexts, released: () => released, bridge: { async stage(value, context) {
    stages.push(value); contexts.push(context)
    return stage ? stage(value, context) : { nativeUrl: 'http://127.0.0.1:4242/qq-group-log/' + 'a'.repeat(64), async release() { released++ } }
  }, async close() {} } }
}
function direct(options = {}) {
  const f = options.fixture ?? bridgeFixture(), reads = [], sends = []
  const send = createQqGroupLogDeliveryPort({ account, connectionId: 'log-local', bridge: f.bridge,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.allowsText ? { allowsText: options.allowsText } : {}),
    async readApi(native, params, scope) { reads.push({ native, params, scope }); return options.read ? options.read(reads.length, scope) : message() },
    async sendApi(native, params, scope) { sends.push({ native, params, scope }); return options.send ? options.send(params, scope) : success() },
  })
  return { ...f, reads, sends, send }
}

test('source is verified around staging and native upload with fixed original group parameters', async () => {
  const order = [], f = bridgeFixture(async value => {
    order.push('stage'); assert.equal(value.mime, 'text/plain')
    return { nativeUrl: 'http://127.0.0.1:4242/qq-group-log/' + 'a'.repeat(64), async release() { order.push('release') } }
  })
  const d = direct({ fixture: f, read() { order.push('get_msg'); return message() }, send(params, scope) {
    order.push('upload_group_file'); assert.equal(scope.timeoutMs, 600000); assert.equal(scope.isCurrent(), true)
    assert.equal(queuedDeliveryAllowed(), true); assert.deepEqual(Object.keys(params), ['group_id', 'file', 'name'])
    return success()
  } })
  assert.deepEqual(await d.send(action()), { state: 'uploaded', fileId: 'native-file-17' })
  assert.deepEqual(order, ['get_msg', 'stage', 'get_msg', 'upload_group_file', 'get_msg', 'release'])
  assert.equal(d.sends.length, 1); assert.equal(d.sends[0].params.group_id, target.id); assert.equal(d.sends[0].params.user_id, undefined)
  assert.ok(d.reads.every(row => row.native === 'get_msg' && row.params.message_id === 71 && row.scope.timeoutMs === 1500))
})

test('only genuine group native file_id proves uploaded; handler ambiguity remains unknown without fallback', async () => {
  const responses = [
    [success(), 'uploaded'], [{ status: 'ok', retcode: 0, data: { message_id: 1 } }, 'unknown'],
    [{ status: 'ok', retcode: 0, data: { file_id: null } }, 'unknown'], [{ status: 'ok', retcode: 0, data: { file_id: 'has space' } }, 'unknown'],
    [{ status: 'ok', retcode: 0, data: { file_id: 'file', user_id: '999999' } }, 'unknown'],
    [{ status: 'ok', retcode: 0, data: { file_id: 'file', group_id: target.id } }, 'uploaded'],
    [{ status: 'ok', retcode: 0, data: { file_id: 'file', group_id: '999999' } }, 'unknown'],
    [{ status: 'failed', retcode: 1200, message: 'secret native error' }, 'unknown'], [{ status: 'failed', retcode: 1400 }, 'failed'],
    [{ state: 'failed', code: 'onebot_disconnected' }, 'failed'], [undefined, 'unknown'],
  ]
  for (const [response, state] of responses) {
    const d = direct({ send: () => response }); assert.equal((await d.send(action())).state, state)
    assert.equal(d.sends.length, 1); assert.equal(d.released(), 1)
  }
})

test('all source identity mismatches, self requests and private and cross-binding targets fail before upload', async () => {
  for (const extra of [{ group_id: '999999' }, { user_id: '999999' }, { sender: { user_id: '999999' } }, { message_id: 72 },
    { self_id: '999999' }, { time: occurredAt / 1000 + 1 }, { message_type: 'private' }, { message_sent_type: 'self' }]) {
    const d = direct({ read: () => message(extra) }); assert.equal((await d.send(action())).state, 'failed'); assert.equal(d.stages.length, 0); assert.equal(d.sends.length, 0)
  }
  for (const mutate of [a => { a.target.kind = 'private' }, a => { a.binding.connectionId = 'other' }, a => { a.source.sender = account },
    a => { a.source.messageId = '2147483648' }, a => { a.source.messageId = '071' }, a => { a.target.account.id = '999999' }, a => { delete a.binding }, a => { delete a.source.textSha256 },
    a => { a.log.name = '../owned.txt' }]) {
    const d = direct(), value = action(); mutate(value); assert.equal((await d.send(value)).state, 'failed'); assert.equal(d.reads.length, 0)
  }
})

test('source body changes before dispatch fail; changes after dispatch freeze as unknown', async () => {
  for (const changedAt of [2, 3]) {
    const d = direct({ read: count => message(count >= changedAt ? { message: 'changed' } : {}) })
    assert.equal((await d.send(action())).state, changedAt === 2 ? 'failed' : 'unknown')
    assert.equal(d.sends.length, changedAt === 2 ? 0 : 1); assert.equal(d.released(), 1)
  }
})

test('Core neutral source text digest rejects a replacement already present at the adapter first read', async () => {
  const expected = action(); expected.source.textSha256 = sha(Buffer.from('.log export current'))
  const unchanged = direct({ read: () => message({ raw_message: 'ignored raw native text' }) })
  assert.equal((await unchanged.send(expected)).state, 'uploaded'); assert.equal(unchanged.reads.length, 3)
  const changed = direct({ read: () => message({ message: [{ type: 'text', data: { text: 'same identity, replacement source' } }] }) })
  assert.equal((await changed.send(expected)).state, 'failed'); assert.equal(changed.reads.length, 1)
  assert.equal(changed.stages.length, 0); assert.equal(changed.sends.length, 0)
})

test('source digest uses the same CQ decoding as Core and rejects malformed, wrong and getter digests', async () => {
  const expected = action(); expected.source.textSha256 = sha(Buffer.from('.log export [request] & raw'))
  const cq = direct({ read: () => message({ message: '[CQ:reply,id=12][CQ:at,qq=123456789].log export &#91;request&#93; &amp; raw', raw_message: 'not neutral text' }) })
  assert.equal((await cq.send(expected)).state, 'uploaded')
  for (const digest of ['0'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), '', undefined, 123]) {
    const value = action(); value.source.textSha256 = digest
    const d = direct(); assert.equal((await d.send(value)).state, 'failed'); assert.equal(d.stages.length, 0); assert.equal(d.sends.length, 0)
    if (digest !== '0'.repeat(64)) assert.equal(d.reads.length, 0)
  }
  let accessed = false
  const value = action(); Object.defineProperty(value.source, 'textSha256', { enumerable: true, get() { accessed = true; throw Error('secret') } })
  const d = direct(); assert.equal((await d.send(value)).state, 'failed'); assert.equal(accessed, false); assert.equal(d.reads.length, 0)
})

test('host filename and UTF8 body policy is checked before preparation and again before native dispatch', async () => {
  const denied = direct({ allowsText: () => false })
  assert.equal((await denied.send(action())).state, 'failed'); assert.equal(denied.stages.length, 0); assert.equal(denied.reads.length, 0)
  let allowed = true, finish, released = 0
  const f = bridgeFixture(() => new Promise(resolve => { finish = resolve })), d = direct({ fixture: f, allowsText: name => allowed && (name.endsWith('.txt') || name === logBytes().toString('utf8')) })
  const pending = d.send(action()); await waitFor(() => finish); allowed = false
  finish({ nativeUrl: 'http://127.0.0.1/private', async release() { released++ } })
  assert.equal((await pending).state, 'failed'); assert.equal(d.sends.length, 0); assert.equal(released, 1)
})

test('HTML and TXT body policy applies to the full strict UTF8 content, not only a harmless filename', async () => {
  for (const mime of ['text/plain', 'text/html']) {
    const value = action(), calls = []
    value.log = { name: mime === 'text/html' ? '安全团录.html' : '安全团录.txt', mime,
      base64: Buffer.from('前半段允许；后半段包含 forbidden-secret').toString('base64') }
    const denied = direct({ allowsText(text) { calls.push(text); return !text.includes('forbidden-secret') } })
    assert.equal((await denied.send(value)).state, 'failed'); assert.equal(denied.reads.length, 0); assert.equal(denied.sends.length, 0)
    assert.ok(calls.includes(value.log.name)); assert.ok(calls.includes(Buffer.from(value.log.base64, 'base64').toString('utf8')))
  }
  const value = action(); value.log = { name: '记录.html', mime: 'text/html', base64: Buffer.from('<!doctype html><pre>完整团录 &amp; 结果</pre>').toString('base64') }
  const allowed = direct(); assert.equal((await allowed.send(value)).state, 'uploaded'); assert.equal(allowed.sends[0].params.name, '记录.html')
})

test('source and binding mutations during stage cancel prepared uploads; late leases are released', async () => {
  for (const mutate of [a => { a.source.sender.id = '999999' }, a => { a.source.occurredAt++ }, a => { a.binding.revision = 'r2' },
    a => { a.target.id = '999999' }, a => { a.log.name = 'replacement.txt' }]) {
    let finish, releases = 0
    const f = bridgeFixture(() => new Promise(resolve => { finish = resolve })), d = direct({ fixture: f }), value = action(), pending = d.send(value)
    await waitFor(() => finish); mutate(value)
    assert.equal((await pending).state, 'failed'); assert.equal(d.sends.length, 0)
    finish({ nativeUrl: 'http://127.0.0.1/late', async release() { releases++ } }); await waitFor(() => releases === 1)
  }
})

test('one active plus four waiting bounds group-log source read and staging; cancelled queued work frees slots', async () => {
  let finish
  const d = direct({ read: count => count === 1 ? new Promise(resolve => { finish = resolve }) : message() }), first = d.send(action())
  await waitFor(() => finish)
  const controllers = Array.from({ length: 4 }, () => new AbortController()), pending = controllers.map(c => d.send(action(), { signal: c.signal }))
  assert.deepEqual(await d.send(action()), { state: 'failed', code: 'group_log_busy' }); assert.equal(d.stages.length, 0)
  controllers[0].abort(); assert.equal((await pending[0]).state, 'failed')
  const extra = new AbortController(), replacement = d.send(action(), { signal: extra.signal })
  controllers.slice(1).forEach(c => c.abort()); extra.abort()
  assert.ok((await Promise.all([...pending.slice(1), replacement])).every(row => row.state === 'failed'))
  finish(message()); assert.equal((await first).state, 'uploaded'); assert.equal(d.sends.length, 1)
})

test('each queued log retains its authorization scope after the previous caller is revoked', async () => {
  let finish, firstCurrent = true
  const d = direct({ send: () => d.sends.length === 1 ? new Promise(resolve => { finish = resolve }) : success() })
  const first = withDeliveryGuard(() => firstCurrent, () => d.send(action())); await waitFor(() => finish)
  const second = withDeliveryGuard(() => true, () => d.send(action())); firstCurrent = false
  assert.equal((await first).state, 'unknown'); assert.equal((await second).state, 'uploaded')
  assert.equal(d.sends.length, 2); finish(success())
})

test('abort after dispatch and native deadline freeze without retries and release resources', async () => {
  for (const mode of ['abort', 'timeout']) {
    let started = false
    const controller = new AbortController(), d = direct({ ...(mode === 'timeout' ? { timeoutMs: 70 } : {}), send() { started = true; return new Promise(() => {}) } })
    const pending = d.send(action(), { signal: controller.signal }); await waitFor(() => started)
    if (mode === 'abort') controller.abort()
    assert.equal((await pending).state, 'unknown'); assert.equal(d.sends.length, 1); assert.equal(d.released(), 1)
  }
})

test('hostile getters, Proxy AbortSignals and oversized native sources return closed failures', async () => {
  for (const guard of [{ get signal() { throw Error('secret') } }, { get isCurrent() { throw Error('secret') } }, { signal: new Proxy(new AbortController().signal, {}) }]) {
    const d = direct(); await assert.doesNotReject(async () => assert.equal((await d.send(action(), guard)).state, 'failed')); assert.equal(d.reads.length, 0)
  }
  const d = direct({ read: () => message({ message: 'a'.repeat(131073) }) })
  assert.equal((await d.send(action())).state, 'failed'); assert.equal(d.sends.length, 0)
})

test('group-log action, guard and native data reject Proxies before any reflective or accessor trap', async () => {
  let traps = 0
  const poison = value => new Proxy(value, {
    get() { traps++; throw Error('get trap') }, getPrototypeOf() { traps++; throw Error('prototype trap') },
    ownKeys() { traps++; throw Error('keys trap') }, getOwnPropertyDescriptor() { traps++; throw Error('descriptor trap') },
    apply() { traps++; throw Error('apply trap') },
  })
  const values = [poison(action())]
  for (const mutate of [a => { a.target = poison(a.target) }, a => { a.target.account = poison(a.target.account) },
    a => { a.binding = poison(a.binding) }, a => { a.binding.target = poison(a.binding.target) },
    a => { a.source = poison(a.source) }, a => { a.source.sender = poison(a.source.sender) }, a => { a.log = poison(a.log) }]) {
    const value = action(); mutate(value); values.push(value)
  }
  for (const value of values) {
    const d = direct(); assert.equal((await d.send(value)).state, 'failed'); assert.equal(d.reads.length, 0)
  }
  for (const guard of [poison({ isCurrent: () => true }), { isCurrent: poison(() => true) }, { signal: poison(new AbortController().signal) }]) {
    const d = direct(); assert.equal((await d.send(action(), guard)).state, 'failed'); assert.equal(d.reads.length, 0)
  }
  for (const mutate of [r => { r.data = poison(r.data) }, r => { r.data.sender = poison(r.data.sender) },
    r => { r.data.message = poison(r.data.message) }, r => { r.data.message[0] = poison(r.data.message[0]) },
    r => { Object.defineProperty(r.data, 'message', { enumerable: true, get() { traps++; throw Error('getter') } }) }]) {
    const response = message(); mutate(response)
    const d = direct({ read: () => response }); assert.equal((await d.send(action())).state, 'failed'); assert.equal(d.sends.length, 0)
  }
  const response = success(); response.data = poison(response.data)
  const uploaded = direct({ send: () => response }); assert.equal((await uploaded.send(action())).state, 'unknown'); assert.equal(uploaded.sends.length, 1)
  assert.equal(traps, 0)
})

async function socketFixture(t, transport, bridge, handler) {
  let server, url, peer
  const requests = [], peers = []
  const attach = socket => {
    peer = socket; peers.push(socket); socket.on('error', () => {})
    socket.on('message', async raw => {
      const request = { ...JSON.parse(String(raw)), frameBytes: raw.length }; requests.push(request)
      const response = request.action === 'get_login_info' ? { status: 'ok', retcode: 0, data: { user_id: account.id, nickname: 'Group log fixture' } }
        : request.action === 'get_msg' ? message() : await handler(request, socket)
      if (response && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ ...response, echo: request.echo }))
    })
    return socket
  }
  if (transport === 'forward-websocket') {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 50 * 1024 * 1024 }); await once(server, 'listening')
    server.on('connection', attach); url = `ws://127.0.0.1:${server.address().port}`
  } else {
    const allocator = createServer(); allocator.listen(0, '127.0.0.1'); await once(allocator, 'listening')
    url = `ws://127.0.0.1:${allocator.address().port}/onebot`; await new Promise(resolve => allocator.close(resolve))
  }
  const adapter = createOneBotConnection({ connection: { id: 'log-local', account }, transport, url, accessToken: 'log-fixture', groupLog: { bridge },
    onDisconnect() {}, onReconnect() {}, onError() {}, onEventError() {} })
  t.after(async () => { adapter.stop(); peers.forEach(socket => socket.terminate()); if (server) await new Promise(resolve => server.close(resolve)) })
  const start = adapter.start(async () => {}); void start.catch(() => {})
  if (transport === 'reverse-websocket') await waitFor(async () => {
    const socket = attach(new WebSocket(url, { maxPayload: 50 * 1024 * 1024, headers: { Authorization: 'Bearer log-fixture', 'X-Self-ID': account.id, 'X-Client-Role': 'Universal' } }))
    try { await once(socket, 'open'); return true } catch { socket.terminate(); return false }
  })
  await start
  return { adapter, requests, peer: () => peer, attach, url }
}

for (const transport of ['forward-websocket', 'reverse-websocket']) {
  test(`${transport} group-log entry rejects hostile guard accessors and nontrue current checks before native work`, { timeout: 8000 }, async t => {
    const b = bridgeFixture(), f = await socketFixture(t, transport, b.bridge, success), before = f.requests.length
    let accessed = false
    const proxy = value => new Proxy(value, { getPrototypeOf() { accessed = true; throw Error('prototype trap') },
      ownKeys() { accessed = true; throw Error('keys trap') }, get() { accessed = true; throw Error('get trap') }, apply() { accessed = true; throw Error('apply trap') } })
    for (const guard of [proxy({ isCurrent: () => true }), { isCurrent: proxy(() => true) }, { signal: proxy(new AbortController().signal) }, { get isCurrent() { accessed = true; throw Error('secret') } }, { get signal() { accessed = true; throw Error('secret') } },
      { isCurrent: () => undefined }, { isCurrent: () => 0 }, { signal: new Proxy(new AbortController().signal, {}) }]) {
      assert.equal((await f.adapter.actions.sendGroupLog(action(), guard)).state, 'failed')
    }
    assert.equal(accessed, false); assert.equal(b.stages.length, 0); assert.equal(f.requests.length, before)
  })

  test(`${transport} transmits a complete 100 MiB group log via local HTTP with small native WebSocket frames`, { timeout: 30000 }, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'qq-log-100m-'))
    const bridge = await openQqGroupLogBridge({ directory, listen: { host: '127.0.0.1', port: 0 }, advertisedOrigin: 'http://127.0.0.1:0', allowedPeers: ['127.0.0.1'] })
    t.after(async () => { await bridge.close(); await rm(directory, { recursive: true, force: true }) })
    const bytes = logBytes(104857600), expectedHash = sha(bytes), owned = artifact(bytes); let nativeUrl
    const f = await socketFixture(t, transport, bridge, async request => {
      assert.equal(request.action, 'upload_group_file'); assert.equal(request.params.group_id, target.id)
      assert.deepEqual(Object.keys(request.params), ['group_id', 'file', 'name']); assert.ok(request.frameBytes < 2048)
      nativeUrl = request.params.file; assert.match(nativeUrl, /^http:\/\/127\.0\.0\.1:\d+\/qq-group-log\/[a-f\d]{64}$/u)
      const result = await download(nativeUrl)
      assert.equal(result.status, 200); assert.equal(result.size, 104857600); assert.equal(result.sha256, expectedHash)
      return success()
    })
    assert.deepEqual(await f.adapter.actions.sendGroupLog({ ...action(), log: owned }), { state: 'uploaded', fileId: 'native-file-17' })
    assert.deepEqual(f.requests.map(row => row.action), ['get_login_info', 'get_msg', 'get_msg', 'upload_group_file', 'get_msg'])
    assert.equal((await download(nativeUrl)).status, 404)
    const oversized = artifact(logBytes(104857601)), before = f.requests.length
    assert.equal((await f.adapter.actions.sendGroupLog({ ...action(), log: oversized })).state, 'failed'); assert.equal(f.requests.length, before)
  })

  test(`${transport} disconnect after native dispatch returns unknown and never retries`, { timeout: 8000 }, async t => {
    const b = bridgeFixture(), f = await socketFixture(t, transport, b.bridge, (_request, socket) => { socket.terminate(); return undefined })
    assert.equal((await f.adapter.actions.sendGroupLog(action())).state, 'unknown')
    assert.equal(f.requests.filter(row => row.action === 'upload_group_file').length, 1); assert.equal(b.released(), 1)
  })

  test(`${transport} stopping during staging invalidates the captured original socket before upload`, { timeout: 8000 }, async t => {
    let finish, released = 0
    const b = bridgeFixture(() => new Promise(resolve => { finish = resolve })), f = await socketFixture(t, transport, b.bridge, success)
    const pending = f.adapter.actions.sendGroupLog(action()); await waitFor(() => finish); f.adapter.stop()
    assert.equal((await pending).state, 'failed')
    finish({ nativeUrl: 'http://127.0.0.1/late', async release() { released++ } }); await waitFor(() => released === 1)
    assert.equal(f.requests.some(row => row.action === 'upload_group_file'), false)
  })
}

test('OneBot group-log port is absent without explicit bridge configuration', async () => {
  const adapter = createOneBotConnection({ connection: { id: 'log-local', account }, url: 'ws://127.0.0.1:31415', onDisconnect() {}, onReconnect() {}, onError() {}, onEventError() {} })
  try { assert.equal(Object.hasOwn(adapter.actions, 'sendGroupLog'), false) } finally { adapter.stop() }
})
