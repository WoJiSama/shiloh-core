import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const { openQqMediaRelayBridge } = await import(pathToFileURL(path.join(release, 'dist/backend/adapters/qqMediaRelayBridge.js')).href)
const { createAgentMediaArtifactStore } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/media/infrastructure/agentMediaArtifactStore.js')).href)
const MiB = 1024 * 1024
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6d8AAAAASUVORK5CYII=', 'base64')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const expected = { id: '1'.repeat(32), kind: 'image', mime: 'image/png', sizeBytes: PNG.length, sha256: sha(PNG) }
const context = overrides => ({ signal: new AbortController().signal, isCurrent: () => true, async ensureCurrent() {}, ...overrides })
const gate = () => { let resolve; const promise = new Promise(release => { resolve = release }); return { promise, resolve } }
const chunks = async function* (bytes, size = 11) { for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size) }
function sourceReader(onClose = () => {}) { return { chunks: chunks(PNG), async close() { onClose() } } }
async function* videoChunks(size) {
  const block = Buffer.alloc(MiB), first = Buffer.alloc(Math.min(MiB, size))
  first.writeUInt32BE(24); first.write('ftyp', 4); first.write('isom', 8); first.write('isom', 16); first.write('mp42', 20)
  let written = 0
  while (written < size) { const bytes = written ? block.subarray(0, Math.min(MiB, size - written)) : first; written += bytes.length; yield bytes }
}
async function waitFor(probe, label, timeout = 3000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await probe()) return; await delay(10) }
  assert.fail(`timed out: ${label}`)
}
async function bounded(operation, label) {
  let timer
  try { return await Promise.race([operation, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`hung: ${label}`)), 2000) })]) }
  finally { clearTimeout(timer) }
}
async function rejected(operation, label) {
  await bounded(assert.rejects(operation, error => { assert.equal(error.message, 'QQ 媒体临时资源不可用或操作已取消'); return true }), label)
}
async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'qq-media-bridge-'))
  const sourceDirectory = path.join(directory, 'source'), bridgeDirectory = path.join(directory, 'bridge')
  await mkdir(sourceDirectory); await mkdir(bridgeDirectory)
  const source = await createAgentMediaArtifactStore({ directory: sourceDirectory })
  const bridge = await openQqMediaRelayBridge({ directory: bridgeDirectory, resources: source,
    listen: { host: '127.0.0.1', port: 0 }, advertisedOrigin: 'http://127.0.0.1:0', allowedPeers: ['127.0.0.1'], ...overrides })
  t.after(async () => { await bridge.close().catch(() => {}); await source.close(); await rm(directory, { recursive: true, force: true }) })
  return { bridge, source, directory, sourceDirectory, bridgeDirectory,
    async image() { return source.stage({ kind: 'image', mime: 'image/png', chunks: chunks(PNG) }, context()) },
    async video(size) { return source.stage({ kind: 'video', mime: 'video/mp4', chunks: videoChunks(size) }, context()) },
    async copiedFiles() {
      const values = []
      for (const child of await readdir(bridgeDirectory)) for (const file of await readdir(path.join(bridgeDirectory, child))) values.push(path.join(bridgeDirectory, child, file))
      return values
    },
  }
}
function download(url, options = {}) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256'), prefix = [], headers = options.headers ?? {}
    let size = 0
    const request = httpRequest(url, { agent: false, method: options.method ?? 'GET', headers,
      ...(options.path ? { path: options.path } : {}) }, response => {
      response.on('error', reject); response.on('aborted', () => reject(new Error('download aborted')))
      response.on('data', bytes => {
        size += bytes.length; hash.update(bytes)
        if (size <= 4096) prefix.push(bytes)
        options.onData?.(bytes, response)
      })
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, size, sha256: hash.digest('hex'), body: Buffer.concat(prefix) }))
    })
    request.on('error', reject)
    if (options.body) request.write(options.body)
    request.end()
  })
}
async function raw(url, request) {
  const parsed = new URL(url)
  return bounded(new Promise((resolve, reject) => {
    const socket = connect({ host: parsed.hostname.replace(/^\[|\]$/gu, ''), port: Number(parsed.port) })
    let received = ''
    socket.on('connect', () => socket.end(request)); socket.on('data', chunk => { received += chunk })
    socket.on('error', reject); socket.on('close', () => resolve(received))
  }), 'raw HTTP request')
}

test('bridge copies complete host bytes and serves a remote-style GET with a bounded capability URL', async t => {
  const f = await fixture(t), original = await f.image(), lease = await f.bridge.stage(original.artifact, context())
  assert.deepEqual(Object.keys(lease), ['nativeUrl', 'release']); assert.ok(Object.isFrozen(lease))
  const url = new URL(lease.nativeUrl)
  assert.equal(url.hostname, '127.0.0.1'); assert.notEqual(url.port, '0'); assert.match(url.pathname, /^\/agent-media-relay\/[a-f\d]{64}$/u)
  for (const secret of [original.artifact.id, f.directory, PNG.toString('base64'), 'file:']) assert.equal(lease.nativeUrl.includes(secret), false)
  await original.release()
  const response = await download(lease.nativeUrl)
  assert.equal(response.status, 200); assert.equal(response.size, PNG.length); assert.equal(response.sha256, sha(PNG))
  assert.equal(response.headers['content-type'], 'image/png'); assert.equal(response.headers['content-length'], String(PNG.length))
  assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.headers['x-content-type-options'], 'nosniff')
  assert.equal(response.headers['accept-ranges'], 'none'); assert.deepEqual(response.body, PNG)
  await lease.release(); await lease.release()
  assert.equal((await download(lease.nativeUrl)).status, 404); assert.deepEqual(await f.copiedFiles(), [])
})

test('real 512 MiB video stages and serves its full hash without base64 or in-memory whole-file conversion', { timeout: 60_000 }, async t => {
  const f = await fixture(t), original = await f.video(512 * MiB)
  const lease = await f.bridge.stage(original.artifact, context()); await original.release()
  const result = await download(lease.nativeUrl, { onData(bytes) { assert.ok(bytes.length <= MiB) } })
  assert.equal(result.status, 200); assert.equal(result.size, 512 * MiB); assert.equal(result.sha256, original.artifact.sha256)
  assert.equal(result.headers['content-type'], 'video/mp4'); assert.equal(result.headers['content-length'], String(512 * MiB))
  await lease.release(); assert.deepEqual(await f.copiedFiles(), [])
})

test('HEAD serves fixed metadata without opening content and rejects Range requests', async t => {
  const f = await fixture(t), original = await f.image(), lease = await f.bridge.stage(original.artifact, context())
  const [filename] = await f.copiedFiles(), changed = Buffer.from(PNG); changed[40] ^= 1
  await chmod(filename, 0o600); await writeFile(filename, changed); await chmod(filename, 0o400)
  const head = await download(lease.nativeUrl, { method: 'HEAD' })
  assert.equal(head.status, 200); assert.equal(head.size, 0); assert.equal(head.headers['content-length'], String(PNG.length))
  assert.equal((await download(lease.nativeUrl, { headers: { Range: 'bytes=0-9' } })).status, 416)
  await assert.rejects(download(lease.nativeUrl), 'GET rechecks the complete private copy before sending headers')
  await lease.release()
})

test('each capability allows thirty-two GET/HEAD requests and at most eight complete GET byte budgets', async t => {
  const f = await fixture(t), original = await f.image(), heads = await f.bridge.stage(original.artifact, context())
  for (let index = 0; index < 32; index++) assert.equal((await download(heads.nativeUrl, { method: 'HEAD' })).status, 200)
  assert.equal((await download(heads.nativeUrl, { method: 'HEAD' })).status, 429)
  const bytes = await f.bridge.stage(original.artifact, context())
  const responses = await Promise.all(Array.from({ length: 9 }, () => download(bytes.nativeUrl)))
  assert.equal(responses.filter(row => row.status === 200).length, 8)
  assert.equal(responses.filter(row => row.status === 429).length, 1)
  assert.equal(responses.reduce((sum, row) => sum + row.size, 0), PNG.length * 8)
  await heads.release(); await bytes.release()
})

test('only exact peer IPs may fetch capabilities and forwarded headers never grant access', async t => {
  const f = await fixture(t, { allowedPeers: ['192.0.2.7'] }), original = await f.image(), lease = await f.bridge.stage(original.artifact, context())
  const denied = await download(lease.nativeUrl, { headers: { 'X-Forwarded-For': '192.0.2.7', Forwarded: 'for=192.0.2.7', 'X-Real-IP': '192.0.2.7' } })
  assert.equal(denied.status, 403); assert.equal(denied.size, 0)
  await lease.release()
  const mapped = await fixture(t, { allowedPeers: ['::ffff:127.0.0.1'] }), mappedSource = await mapped.image()
  const mappedLease = await mapped.bridge.stage(mappedSource.artifact, context())
  assert.equal((await download(mappedLease.nativeUrl)).status, 200); await mappedLease.release()
})

test('HTTP routing never maps queries, traversal, methods, oversized headers or request bodies to files', async t => {
  const f = await fixture(t), original = await f.image(), lease = await f.bridge.stage(original.artifact, context()), url = new URL(lease.nativeUrl)
  for (const pathname of ['/', '/private/file', '/agent-media-relay/' + '0'.repeat(64), `${url.pathname}?file=/private/secret`, `${url.pathname}/extra`,
    url.pathname.replace('/agent-media-relay/', '/agent-media-relay/%2e%2e/'), url.pathname.replace(/.$/u, 'Z')]) {
    assert.equal((await download(lease.nativeUrl, { path: pathname })).status, 404)
  }
  assert.equal((await download(lease.nativeUrl, { method: 'POST' })).status, 405)
  assert.equal((await download(lease.nativeUrl, { headers: { 'Content-Length': '1' }, body: 'x' })).status, 413)
  const tooLarge = await raw(lease.nativeUrl, `GET ${url.pathname} HTTP/1.1\r\nHost: localhost\r\nX-Large: ${'x'.repeat(9000)}\r\n\r\n`)
  assert.doesNotMatch(tooLarge, /HTTP\/1\.1 200/u)
  const headers = Array.from({ length: 33 }, (_, index) => `X-${index}: value`).join('\r\n')
  const excessive = await raw(lease.nativeUrl, `GET ${url.pathname} HTTP/1.1\r\nHost: localhost\r\n${headers}\r\n\r\n`)
  assert.match(excessive, /HTTP\/1\.1 431/u)
  const upgrade = await raw(lease.nativeUrl, `GET ${url.pathname} HTTP/1.1\r\nHost: localhost\r\nConnection: upgrade\r\nUpgrade: websocket\r\n\r\n`)
  assert.doesNotMatch(upgrade, /HTTP\/1\.1 200/u)
  assert.equal((await download(lease.nativeUrl)).status, 200)
  await lease.release()
})

test('stage verifies complete size, hash, kind and MIME before publishing a route and restores quotas on failure', async t => {
  let closes = 0
  const f = await fixture(t, { resources: { async open() { return sourceReader(() => closes++) } }, maxArtifacts: 1, maxTotalBytes: PNG.length + 1 })
  for (const changed of [{ sha256: '0'.repeat(64) }, { sizeBytes: PNG.length + 1 }, { kind: 'video', mime: 'video/mp4' }]) {
    await rejected(f.bridge.stage({ ...expected, ...changed }, context()), 'metadata mismatch')
    assert.deepEqual(await f.copiedFiles(), [])
  }
  const lease = await f.bridge.stage(expected, context()); assert.equal(closes, 4)
  assert.equal((await download(lease.nativeUrl)).sha256, sha(PNG))
  await rejected(f.bridge.stage(expected, context()), 'artifact quota')
  await lease.release()
  const again = await f.bridge.stage(expected, context()); await again.release()
  await rejected(f.bridge.stage({ ...expected, sizeBytes: 32 * MiB + 1 }, context()), 'image cap')
  await rejected(f.bridge.stage({ ...expected, kind: 'video', mime: 'video/mp4', sizeBytes: 512 * MiB + 1 }, context()), 'video cap')
})

test('bridge source opens reserve global quotas atomically before awaiting external readers', async t => {
  const reached = gate(), late = gate(); let opens = 0
  const f = await fixture(t, { maxArtifacts: 1, maxTotalBytes: PNG.length, resources: { async open() { opens++; reached.resolve(); return late.promise } } })
  const pending = f.bridge.stage(expected, context()); await reached.promise
  await rejected(f.bridge.stage(expected, context()), 'concurrent quota'); assert.equal(opens, 1)
  late.resolve(sourceReader()); const lease = await pending; await lease.release()
})

test('cancelled uncooperative source.open closes its late reader after bridge close and never publishes bytes', async t => {
  const reached = gate(), late = gate(), controller = new AbortController(); let closed = 0
  const f = await fixture(t, { resources: { async open() { reached.resolve(); return late.promise } } })
  const pending = f.bridge.stage(expected, context({ signal: controller.signal })), refused = rejected(pending, 'late open')
  await reached.promise; controller.abort(new Error('/private/host-secret'))
  await refused; await bounded(f.bridge.close(), 'bridge close before late reader')
  late.resolve(sourceReader(() => closed++)); await waitFor(() => closed === 1, 'late source reader is closed once')
  assert.deepEqual(await readdir(f.bridgeDirectory), [])
})

test('hung source iteration and asynchronous authorization are cancellable without late stage continuation', async t => {
  for (const mode of ['iterator', 'ensure']) await t.test(mode, async t => {
    const reached = gate(), late = gate(), controller = new AbortController(); let reads = 0, closes = 0
    const f = await fixture(t, { resources: { async open() {
      reads++
      return { chunks: { [Symbol.asyncIterator]() { return { async next() { reached.resolve(); return late.promise },
        get return() { throw new Error('/private/producer-return-secret') } } } }, async close() { closes++ } }
    } } })
    const ctx = context({ signal: controller.signal, ...(mode === 'ensure' ? { async ensureCurrent() { reached.resolve(); await late.promise } } : {}) })
    const pending = f.bridge.stage(expected, ctx), refused = rejected(pending, mode)
    await reached.promise; controller.abort(); await refused
    late.resolve(mode === 'iterator' ? { done: false, value: PNG } : undefined)
    await bounded(f.bridge.close(), 'cancelled stage closes bridge')
    assert.equal(reads, mode === 'ensure' ? 0 : 1); assert.equal(closes, mode === 'ensure' ? 0 : 1)
    assert.deepEqual(await readdir(f.bridgeDirectory), [])
  })
})

test('route expiry and source authorization revocation deny new HTTP requests and clear private copies', async t => {
  for (const mode of ['expiry', 'signal', 'current']) await t.test(mode, async t => {
    const f = await fixture(t, { timeoutMs: mode === 'expiry' ? 80 : 1000 }), original = await f.image(), controller = new AbortController()
    let current = true
    const lease = await f.bridge.stage(original.artifact, context({ signal: controller.signal, isCurrent: () => current }))
    if (mode === 'expiry') await delay(100)
    else if (mode === 'signal') controller.abort()
    else { current = false; await delay(30) }
    assert.equal((await download(lease.nativeUrl)).status, 404)
    await lease.release(); assert.deepEqual(await f.copiedFiles(), [])
  })
})

test('route release cancels hanging HTTP authorization and awaits its active task cleanup', async t => {
  const f = await fixture(t), original = await f.image(), reached = gate(), late = gate(); let hold = false
  const lease = await f.bridge.stage(original.artifact, context({ async ensureCurrent() { if (hold) { reached.resolve(); await late.promise } } }))
  hold = true
  const pending = download(lease.nativeUrl), rejectedDownload = assert.rejects(pending)
  await reached.promise; await bounded(lease.release(), 'release HTTP ensure')
  await rejectedDownload; late.resolve(); assert.deepEqual(await f.copiedFiles(), [])
  assert.equal((await download(lease.nativeUrl)).status, 404)
})

test('HTTP streaming cancellation and release interrupt backpressure without delivering the remainder', { timeout: 30_000 }, async t => {
  const f = await fixture(t), original = await f.video(31 * MiB), controller = new AbortController()
  const lease = await f.bridge.stage(original.artifact, context({ signal: controller.signal }))
  let received = 0, cancelled = false
  const request = download(lease.nativeUrl, { onData(bytes) {
    received += bytes.length
    if (!cancelled) { cancelled = true; controller.abort() }
  } })
  await assert.rejects(request); await bounded(lease.release(), 'release streaming socket')
  assert.ok(received > 0 && received < original.artifact.sizeBytes)
  assert.deepEqual(await f.copiedFiles(), [])
})

test('a peer disconnect records the active transfer step and byte count without disclosing the bridge URL', async t => {
  const failures = [], f = await fixture(t, { diagnostics: { emit: event => failures.push(event) } })
  const original = await f.video(16 * MiB), lease = await f.bridge.stage(original.artifact, context())
  await assert.rejects(download(lease.nativeUrl, { onData(_bytes, response) { response.destroy() } }))
  await waitFor(() => failures.length === 1, 'observe peer closing the socket')
  assert.equal(failures[0].code, 'media_bridge_peer_closed')
  assert.equal(failures[0].httpStatus, 200)
  assert.equal(failures[0].details.bytesExpected, 16 * MiB)
  assert.ok(failures[0].details.bytesWritten > 0 && failures[0].details.bytesWritten < 16 * MiB)
  assert.ok(!JSON.stringify(failures[0]).includes(lease.nativeUrl))
  await lease.release(); await original.release()
})

test('bridge.close removes only its own copies and listener while preserving host resources and neighbors', async t => {
  const f = await fixture(t), original = await f.image(), lease = await f.bridge.stage(original.artifact, context())
  await writeFile(path.join(f.bridgeDirectory, 'neighbor.txt'), 'retained')
  await Promise.all([f.bridge.close(), f.bridge.close()])
  await assert.rejects(download(lease.nativeUrl)); await lease.release()
  assert.deepEqual(await readdir(f.bridgeDirectory), ['neighbor.txt'])
  assert.equal(await readFile(path.join(f.bridgeDirectory, 'neighbor.txt'), 'utf8'), 'retained')
  const reader = await f.source.open(original.artifact, context()), parts = []
  for await (const value of reader.chunks) parts.push(value)
  assert.deepEqual(Buffer.concat(parts), PNG)
  await rejected(f.bridge.stage(original.artifact, context()), 'closed bridge stage')
  await original.release()
})

test('bridge validates bind IPs, exact peers, private HTTP or HTTPS proxy origins, and shortened bounds', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'qq-media-origin-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const defaults = { directory, resources: { async open() { return sourceReader() } }, listen: { host: '127.0.0.1', port: 0 },
    advertisedOrigin: 'http://127.0.0.1:0', allowedPeers: ['127.0.0.1'] }
  for (const advertisedOrigin of ['http://localhost:0', 'http://10.0.0.8:0', 'http://172.16.0.8:0', 'http://192.168.1.8:0', 'http://127.8.9.10:0',
    'http://[::1]:0', 'http://[fd00::1]:0', 'https://media-proxy.example', 'https://203.0.113.8:443']) {
    const bridge = await openQqMediaRelayBridge({ ...defaults, advertisedOrigin })
    const lease = await bridge.stage(expected, context())
    assert.equal(new URL(lease.nativeUrl).hostname, new URL(advertisedOrigin).hostname)
    assert.notEqual(new URL(lease.nativeUrl).port, '0'); await lease.release(); await bridge.close()
  }
  for (const advertisedOrigin of ['http://example.com', 'http://8.8.8.8', 'http://0.0.0.0', 'http://[::]', 'http://224.0.0.1',
    'http://169.254.169.254', 'http://[fe80::1]', 'http://127.1', 'http://2130706433', 'http://0x7f000001', 'http://127.0.0.1/a/..',
    'https://user:secret@proxy.example', 'https://proxy.example/path', 'https://proxy.example?token=secret', 'https://proxy.example#fragment',
    'https://proxy.example?', 'https://proxy.example#', 'https://proxy.example\\private', 'file:///private/secret']) {
    await rejected(openQqMediaRelayBridge({ ...defaults, advertisedOrigin }), 'origin policy')
  }
  for (const changed of [{ listen: { host: 'localhost', port: 0 } }, { listen: { host: '127.0.0.1', port: -1 } },
    { listen: { host: '127.0.0.1', port: 65536 } }, { listen: { host: '127.0.0.1', port: 1.5 } }, { allowedPeers: [] },
    { allowedPeers: ['localhost'] }, { allowedPeers: ['127.0.0.0/8'] }, { allowedPeers: Array(33).fill('127.0.0.1') },
    { timeoutMs: 5400001 }, { timeoutMs: 0 }, { maxTotalBytes: 16 * 1024 ** 3 + 1 }, { maxArtifacts: 129 }]) {
    await rejected(openQqMediaRelayBridge({ ...defaults, ...changed }), 'configuration bounds')
  }
  assert.deepEqual(await readdir(directory), [])
})

test('bridge captures context callbacks once and generalizes upstream errors without URLs or private paths', async t => {
  let reads = 0
  const f = await fixture(t, { resources: { async open() { throw new Error('/private/source-secret?token=secret') } } })
  await rejected(f.bridge.stage(expected, context()), 'upstream error')
  for (const field of ['signal', 'isCurrent', 'ensureCurrent']) {
    const malicious = Object.defineProperty(context(), field, { get() { throw new Error('/private/context-secret') } })
    await rejected(f.bridge.stage(expected, malicious), 'context getter')
  }
  const proxySignal = new Proxy(new AbortController().signal, { get() { throw new Error('/private/signal-proxy-secret') } })
  await rejected(f.bridge.stage(expected, context({ signal: proxySignal })), 'native signal constructor')
  const normal = await fixture(t, { resources: { async open() { return sourceReader() } } })
  const once = Object.defineProperty(context(), 'signal', { get() { if (++reads > 1) throw new Error('/private/second-getter-secret'); return new AbortController().signal } })
  const lease = await normal.bridge.stage(expected, once)
  assert.equal(reads, 1); await lease.release()
  assert.deepEqual(await f.copiedFiles(), [])
})
