import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { createServer, get } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import WebSocket, { WebSocketServer } from 'ws'

const repo = fileURLToPath(new URL('../', import.meta.url))
const release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const { createOneBotConnection, openQqMediaRelayBridge } = await import(pathToFileURL(path.join(release, 'dist/backend/adapters/oneBotConnection.js')).href)
const { createAgentMediaArtifactStore } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/media/infrastructure/agentMediaArtifactStore.js')).href)
const { withDeliveryGuard } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/messaging/infrastructure/deliveryScope.js')).href)
const account = { platform: 'qq', namespace: 'global', id: '123456789' }
const target = { account, kind: 'group', id: '315320' }
const connectionId = 'relay-local-integration'
const binding = { source: 'configured', id: 'relay-binding', revision: 'r1', personaId: 'default', agentId: 'alice', connectionId, target }
const token = 'media-relay-local-onebot-token'
const MiB = 1024 * 1024
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6d8AAAAASUVORK5CYII=', 'base64')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0])
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve }); return { promise, release } }
const context = overrides => ({ signal: new AbortController().signal, isCurrent: () => true, ...overrides })
const success = messageId => ({ status: 'ok', retcode: 0, data: { message_id: messageId } })
const action = (items, mode = 'forward', address = target) => ({ version: 1, kind: 'media-relay.send', target: address,
  binding: { ...binding, target: address }, mode, plan: { version: 1, items } })
const partsOf = request => request.params.messages ? request.params.messages.flatMap(node => node.data.content) : request.params.message
const urlsOf = request => partsOf(request).flatMap(part => part.type === 'video' ? [part.data.file, part.data.thumb] : part.type === 'image' ? [part.data.file] : [])

async function waitFor(probe, description, timeout = 5_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await probe(); if (value) return value; await delay(10) }
  assert.fail(`timed out waiting for ${description}`)
}
async function bounded(promise, description, timeout = 5_000) {
  let timer
  try { return await Promise.race([promise, new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${description}`)), timeout)
  })]) } finally { clearTimeout(timer) }
}
async function* chunks(bytes) { for (let at = 0; at < bytes.length; at += 11) yield bytes.subarray(at, at + 11) }
async function* videoChunks(size, onChunk) {
  const first = Buffer.alloc(Math.min(MiB, size)), rest = Buffer.alloc(MiB)
  first.writeUInt32BE(24); first.write('ftyp', 4); first.write('isom', 8); first.write('isom', 16); first.write('isom', 20)
  let remaining = size, index = 0
  while (remaining) {
    const bytes = index++ ? rest.subarray(0, Math.min(MiB, remaining)) : first
    remaining -= bytes.length; onChunk?.(bytes); yield bytes
  }
}
async function consume(url, artifact) {
  const response = await new Promise((resolve, reject) => { const request = get(url, resolve); request.on('error', reject) })
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['content-type'], artifact.mime)
  assert.equal(response.headers['content-length'], String(artifact.sizeBytes))
  assert.equal(response.headers['cache-control'], 'no-store')
  const digest = createHash('sha256'); let size = 0
  for await (const bytes of response) { size += bytes.length; digest.update(bytes) }
  assert.equal(size, artifact.sizeBytes)
  assert.equal(digest.digest('hex'), artifact.sha256)
  return { url, size, sha256: artifact.sha256 }
}
async function status(url) {
  return new Promise((resolve, reject) => {
    const request = get(url, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); response.on('error', reject) })
    request.on('error', reject)
  })
}
async function pausedConsumption(url, trackRequest) {
  const reached = gate(), finished = gate()
  let response, bytes = 0, ended = false, aborted = false, paused = true, socketClosed = false
  const request = get(url, incoming => {
    response = incoming
    incoming.on('error', () => {})
    incoming.once('aborted', () => { aborted = true; finished.release() })
    incoming.once('end', () => { ended = true; finished.release() })
    incoming.once('close', () => { finished.release() })
    incoming.on('data', value => { bytes += value.length; if (paused) incoming.pause(); reached.release() })
    if (incoming.statusCode !== 200) { incoming.resume(); reached.release() }
  })
  trackRequest(request)
  request.once('socket', socket => socket.once('close', () => { socketClosed = true; finished.release(); response?.resume() }))
  request.on('error', () => { finished.release(); reached.release() })
  await bounded(reached.promise, 'first real HTTP video block')
  assert.equal(response?.statusCode, 200)
  assert.ok(bytes > 0)
  return { response, request, get bytes() { return bytes }, get ended() { return ended }, get aborted() { return aborted }, get socketClosed() { return socketClosed },
    resume() { paused = false; response.resume() },
    finished: finished.promise }
}

async function fixture(t, transport) {
  const directory = await mkdtemp(path.join(tmpdir(), 'qq-relay-integration-'))
  const sourceDirectory = path.join(directory, 'source'), bridgeDirectory = path.join(directory, 'bridge')
  await mkdir(sourceDirectory); await mkdir(bridgeDirectory)
  const store = await createAgentMediaArtifactStore({ directory: sourceDirectory })
  let openHook, bridgeClosed = false, disconnected = 0, handler = async () => success(123456)
  const bridge = await openQqMediaRelayBridge({ directory: bridgeDirectory, resources: { async open(artifact, scope) {
    const reader = await store.open(artifact, scope)
    if (openHook) await openHook(artifact, scope)
    return reader
  } }, listen: { host: '127.0.0.1', port: 0 }, advertisedOrigin: 'http://127.0.0.1:0', allowedPeers: ['127.0.0.1'] })
  const peers = [], requests = [], frames = [], errors = [], operations = new Set(), leases = [], httpRequests = new Set()
  let server, url
  const attach = peer => {
    peers.push(peer); peer.on('error', () => {})
    peer.on('message', raw => {
      const request = JSON.parse(String(raw)); requests.push(request); frames.push(String(raw))
      const operation = Promise.resolve().then(async () => {
        const response = request.action === 'get_login_info'
          ? { status: 'ok', retcode: 0, data: { user_id: account.id, nickname: '本机媒体传输夹具' } }
          : await handler(request, peer)
        if (response && peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ ...response, echo: request.echo }))
      }).catch(error => {
        errors.push(error)
        if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ status: 'failed', retcode: 1200, data: null, echo: request.echo }))
      })
      operations.add(operation); void operation.finally(() => operations.delete(operation))
    })
    return peer
  }
  if (transport === 'forward-websocket') {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening')
    server.on('connection', attach); url = `ws://127.0.0.1:${server.address().port}`
  } else {
    const allocator = createServer(); allocator.listen(0, '127.0.0.1'); await once(allocator, 'listening')
    url = `ws://127.0.0.1:${allocator.address().port}/onebot`
    await new Promise(resolve => allocator.close(resolve))
  }
  const adapter = createOneBotConnection({ connection: { id: connectionId, account }, transport, url, accessToken: token,
    mediaRelay: { bridge }, onDisconnect() { disconnected++ }, onReconnect() {}, onError() {}, onEventError() {} })
  const connectPeer = async () => {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const peer = attach(new WebSocket(url, { headers: {
        Authorization: `Bearer ${token}`, 'X-Self-ID': account.id, 'X-Client-Role': 'Universal',
      } }))
      try { await once(peer, 'open'); return peer } catch { peer.terminate(); await delay(10) }
    }
    assert.fail('reverse media listener did not accept its local peer')
  }
  const closeBridge = async () => { await bridge.close(); bridgeClosed = true; assert.deepEqual(await readdir(bridgeDirectory), []) }
  t.after(async () => {
    adapter.stop()
    for (const request of httpRequests) request.destroy()
    for (const peer of peers) peer.terminate()
    await closeBridge()
    await Promise.allSettled([...operations])
    if (server) await new Promise(resolve => server.close(resolve))
    await Promise.allSettled(leases.map(lease => lease.release()))
    await store.close(); assert.deepEqual(await readdir(sourceDirectory), [])
    await rm(directory, { recursive: true, force: true })
  })
  const started = adapter.start(async () => {}); void started.catch(() => {})
  if (transport === 'reverse-websocket') await connectPeer()
  await started
  return { adapter, bridge, store, directory, bridgeDirectory, requests, frames, errors, connectPeer, closeBridge,
    trackRequest(request) { httpRequests.add(request); request.once('close', () => httpRequests.delete(request)) },
    disconnectPeer() { peers.findLast(peer => peer.readyState === WebSocket.OPEN)?.terminate() },
    setHandler(value) { handler = value }, setOpenHook(value) { openHook = value }, disconnected: () => disconnected,
    async image(bytes = PNG, mime = 'image/png') { const lease = await store.stage({ kind: 'image', mime, chunks: chunks(bytes) }, context()); leases.push(lease); return lease.artifact },
    async video(size) {
      const expected = createHash('sha256')
      const lease = await store.stage({ kind: 'video', mime: 'video/mp4', chunks: videoChunks(size, bytes => expected.update(bytes)) }, context())
      leases.push(lease); assert.equal(lease.artifact.sha256, expected.digest('hex')); return lease.artifact
    },
    sends() { return requests.filter(request => request.action !== 'get_login_info') },
    async assertCleanRoutes(urls) {
      if (!bridgeClosed) for (const url of urls) assert.equal(await status(url), 404)
      await waitFor(async () => (await Promise.all((await readdir(bridgeDirectory)).map(async name =>
        (await readdir(path.join(bridgeDirectory, name)).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))).length === 0))).every(Boolean), 'bridge files release')
      assert.deepEqual(errors, [])
    },
  }
}

function assertNativeWire(fixture, request) {
  const encoded = JSON.stringify(request)
  assert.ok(Buffer.byteLength(encoded) < 16_384)
  for (const privateValue of ['base64://', fixture.directory, 'sha256', 'sizeBytes', 'artifact', PNG.toString('base64')]) assert.equal(encoded.includes(privateValue), false)
  for (const url of urlsOf(request)) {
    assert.match(url, /^http:\/\/127\.0\.0\.1:[1-9]\d*\/agent-media-relay\/[a-f\d]{64}$/u)
    assert.ok(url.length < 160)
  }
}

for (const transport of ['forward-websocket', 'reverse-websocket']) {
  test(`${transport} streams full mixed relay and all direct videos through real HTTP with native receipts`, { timeout: 60_000 }, async t => {
    const f = await fixture(t, transport), cover = await f.image(), thumbnail = await f.image(JPEG, 'image/jpeg')
    // These header-valid byte fixtures verify transport integrity, not decoding or QQ playback.
    const large = await f.video(101 * MiB + 17), second = await f.video(2 * MiB + 13)
    const fetched = [], seenUrls = []
    f.setHandler(async request => {
      assertNativeWire(f, request)
      const expected = request.action === 'send_group_forward_msg' ? [cover, large, thumbnail, second, thumbnail] : [large, thumbnail, second, thumbnail]
      const urls = urlsOf(request); seenUrls.push(...urls)
      assert.equal(urls.length, expected.length)
      for (let index = 0; index < urls.length; index++) fetched.push(await consume(urls[index], expected[index]))
      return success(request.action === 'send_group_forward_msg' ? 910001 : 910002)
    })
    const mixed = [{ parts: [{ kind: 'text', text: '第一段说明' }, { kind: 'image', artifact: cover }] },
      { parts: [{ kind: 'video', artifact: large, thumbnail }, { kind: 'text', text: '视频之间的说明' }, { kind: 'video', artifact: second, thumbnail }] }]
    assert.deepEqual(await f.adapter.actions.sendMediaRelay(action(mixed), { isCurrent: () => true }), { state: 'sent', messageId: '910001' })
    const forward = f.sends()[0]
    assert.equal(forward.action, 'send_group_forward_msg'); assert.equal(forward.params.group_id, target.id)
    assert.equal(forward.params.messages.length, 2)
    for (const node of forward.params.messages) assert.deepEqual({ type: node.type, name: node.data.name, uin: node.data.uin }, { type: 'node', name: 'Agent', uin: account.id })
    assert.deepEqual(forward.params.messages.map(node => node.data.content.map(part => part.type)), [['text', 'image'], ['video', 'text', 'video']])
    assert.equal(forward.params.messages[0].data.content[0].data.text, '第一段说明')
    assert.equal(forward.params.messages[1].data.content[1].data.text, '视频之间的说明')
    assert.equal(fetched.filter(row => row.size > 100 * MiB).length, 1)
    await f.assertCleanRoutes(seenUrls)

    assert.deepEqual(await f.adapter.actions.sendMediaRelay(action([{ parts: [{ kind: 'video', artifact: large, thumbnail }] },
      { parts: [{ kind: 'video', artifact: second, thumbnail }] }], 'direct-video')), { state: 'sent', messageId: '910002' })
    assert.equal(f.sends().length, 2)
    assert.equal(f.sends()[1].action, 'send_group_msg')
    assert.deepEqual(f.sends()[1].params.message.map(part => part.type), ['video', 'video'])
    assert.equal(fetched.filter(row => row.size > 100 * MiB).length, 2)
    await f.assertCleanRoutes(seenUrls)
  })

  test(`${transport} keeps missing IDs and disconnects unknown without retries or reconnect replay`, { timeout: 20_000 }, async t => {
    const f = await fixture(t, transport), cover = await f.image(), items = [{ parts: [{ kind: 'image', artifact: cover }] }], urls = []
    f.setHandler(async request => {
      assertNativeWire(f, request); urls.push(...urlsOf(request)); await consume(urls.at(-1), cover)
      return { status: 'ok', retcode: 0, data: { res_id: 'resource-is-not-message-id' } }
    })
    assert.deepEqual(await f.adapter.actions.sendMediaRelay(action(items)), { state: 'unknown' })
    await f.assertCleanRoutes(urls)
    f.setHandler(async (request, peer) => { urls.push(...urlsOf(request)); peer.terminate() })
    assert.deepEqual(await f.adapter.actions.sendMediaRelay(action(items)), { state: 'unknown' })
    await waitFor(() => f.disconnected() === 1, 'media socket disconnect')
    if (transport === 'reverse-websocket') await f.connectPeer()
    await waitFor(() => f.adapter.isReady(), 'reverified media socket')
    await delay(80)
    assert.equal(f.sends().length, 2)
    assert.equal(f.requests.filter(request => request.action === 'get_login_info').length, 2)
    await f.assertCleanRoutes(urls)
  })

  test(`${transport} revoked queued delivery never stages or publishes a later native action`, { timeout: 20_000 }, async t => {
    const f = await fixture(t, transport), cover = await f.image(), reached = gate(), held = gate(), urls = []
    let opens = 0, firstCurrent = true, secondCurrent = true
    f.setOpenHook(async () => { if (++opens === 1) { reached.release(); await held.promise } })
    f.setHandler(async request => { urls.push(...urlsOf(request)); await consume(urls.at(-1), cover); return success(910010) })
    const items = [{ parts: [{ kind: 'image', artifact: cover }] }]
    const first = withDeliveryGuard(() => firstCurrent, () => f.adapter.actions.sendMediaRelay(action(items)))
    await bounded(reached.promise, 'first real artifact reader')
    const second = withDeliveryGuard(() => secondCurrent, () => f.adapter.actions.sendMediaRelay(action(items)))
    secondCurrent = false; held.release()
    assert.deepEqual(await first, { state: 'sent', messageId: '910010' })
    assert.equal((await bounded(second, 'revoked queued relay')).state, 'failed')
    firstCurrent = false; await delay(80)
    assert.equal(opens, 1); assert.equal(f.sends().length, 1)
    await f.assertCleanRoutes(urls)
  })

  test(`${transport} a reconnect during artifact preparation cannot move the old relay onto a new socket`, { timeout: 20_000 }, async t => {
    const f = await fixture(t, transport), cover = await f.image(), reached = gate(), held = gate()
    f.setOpenHook(async () => { reached.release(); await held.promise })
    const pending = f.adapter.actions.sendMediaRelay(action([{ parts: [{ kind: 'image', artifact: cover }] }]))
    await bounded(reached.promise, 'staging before reconnect')
    f.disconnectPeer()
    await waitFor(() => f.disconnected() === 1, 'preparation socket disconnect')
    if (transport === 'reverse-websocket') await f.connectPeer()
    await waitFor(() => f.adapter.isReady(), 'reverified socket during preparation')
    held.release()
    assert.equal((await bounded(pending, 'old socket preparation cancellation')).state, 'failed')
    assert.equal(f.sends().length, 0)
    await delay(50)
    assert.equal(f.requests.filter(request => request.action === 'get_login_info').length, 2)
    await f.assertCleanRoutes([])
  })

  for (const cancellation of ['guard', 'stop', 'bridge-close']) {
    test(`${transport} ${cancellation} disconnects an actual in-flight HTTP video and removes temporary resources`, { timeout: 30_000 }, async t => {
      const f = await fixture(t, transport), video = await f.video(24 * MiB + 1), thumbnail = await f.image(JPEG, 'image/jpeg')
      const reached = gate(); let current = true, consumption, nativeUrl
      f.setHandler(async request => {
        assertNativeWire(f, request); nativeUrl = urlsOf(request)[0]
        consumption = await pausedConsumption(nativeUrl, f.trackRequest); reached.release()
        await consumption.finished
        return cancellation === 'bridge-close' ? { status: 'failed', retcode: 1200, data: null, message: 'HTTP resource unavailable' } : success(910099)
      })
      const pending = f.adapter.actions.sendMediaRelay(action([{ parts: [{ kind: 'video', artifact: video, thumbnail }] }]), { isCurrent: () => current })
      await bounded(reached.promise, 'paused native video HTTP consumption')
      assert.ok(consumption.bytes < video.sizeBytes)
      let closing
      if (cancellation === 'guard') current = false
      else if (cancellation === 'stop') f.adapter.stop()
      else closing = f.closeBridge()
      // Keep the response paused while the server revokes its active route. Then
      // drain only kernel/client buffers so Node can observe the peer's close.
      await delay(50); consumption.resume()
      if (closing) await closing
      assert.deepEqual(await bounded(pending, 'cancelled dispatched relay'), { state: 'unknown' })
      await bounded(consumption.finished, 'aborted native HTTP response')
      await waitFor(() => consumption.socketClosed, 'closed native HTTP socket')
      assert.equal(consumption.ended, false); assert.equal(consumption.aborted, true)
      assert.ok(consumption.bytes < video.sizeBytes)
      await delay(50); assert.equal(f.sends().length, 1)
      await f.assertCleanRoutes([nativeUrl])
      await f.closeBridge()
      assert.deepEqual(await readdir(f.bridgeDirectory), [])
    })
  }
}
