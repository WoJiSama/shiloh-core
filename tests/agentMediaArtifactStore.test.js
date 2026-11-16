import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, open, readdir, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const { createAgentMediaArtifactStore, MAX_AGENT_ARTIFACT_VIDEO_BYTES, MAX_AGENT_ARTIFACT_IMAGE_BYTES } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/media/infrastructure/agentMediaArtifactStore.js')).href)
const MiB = 1024 * 1024
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6d8AAAAASUVORK5CYII=', 'base64')
const context = overrides => ({ signal: new AbortController().signal, isCurrent: () => true, async ensureCurrent() {}, ...overrides })
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve }); return { promise, release } }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const chunks = async function* (bytes, size = 11) { for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size) }
const image = (bytes = PNG, mime = 'image/png') => ({ kind: 'image', mime, chunks: chunks(bytes) })
function mp4(size = 64, brand = 'isom') {
  const bytes = Buffer.alloc(size)
  bytes.writeUInt32BE(24); bytes.write('ftyp', 4); bytes.write(brand, 8); bytes.write(brand, 16); bytes.write(brand, 20)
  return bytes
}
async function* videoChunks(size, onChunk) {
  let remaining = size, number = 0
  const first = mp4(Math.min(MiB, remaining)), rest = Buffer.alloc(MiB)
  while (remaining) {
    const bytes = number++ ? rest.subarray(0, Math.min(MiB, remaining)) : first
    remaining -= bytes.length; onChunk?.(bytes); yield bytes
  }
}
const video = (size, onChunk) => ({ kind: 'video', mime: 'video/mp4', chunks: videoChunks(size, onChunk) })
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-artifact-test-'))
  const store = await createAgentMediaArtifactStore({ directory, ...options })
  t.after(async () => { await store.close().catch(() => {}); await rm(directory, { recursive: true, force: true }) })
  const child = (await readdir(directory))[0], privateDirectory = path.join(directory, child)
  return { store, directory, privateDirectory, filename: artifact => path.join(privateDirectory, artifact.id) }
}
async function collect(reader) {
  const values = []
  for await (const value of reader.chunks) { assert.ok(value.byteLength <= MiB); values.push(value) }
  return Buffer.concat(values)
}
async function boundedRejected(operation, label) {
  let timer
  try { await Promise.race([assert.rejects(operation, error => { assert.equal(error.message, '媒体资源不可用或操作已取消'); return true }),
    new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`hung: ${label}`)), 1500) })]) }
  finally { clearTimeout(timer) }
}

test('store stages private immutable bytes and returns only opaque complete metadata', async t => {
  const f = await fixture(t)
  const lease = await f.store.stage(image(), context())
  assert.deepEqual(Object.keys(lease), ['artifact', 'retain', 'release'])
  assert.deepEqual(Object.keys(lease.artifact), ['id', 'kind', 'mime', 'sizeBytes', 'sha256'])
  assert.match(lease.artifact.id, /^[a-f0-9]{32}$/u); assert.equal(lease.artifact.sizeBytes, PNG.length)
  assert.equal(lease.artifact.sha256, hash(PNG)); assert.equal(lease.artifact.mime, 'image/png')
  assert.ok(Object.isFrozen(lease)); assert.ok(Object.isFrozen(lease.artifact))
  for (const secret of [f.directory, 'file:', 'https:', PNG.toString('base64')]) assert.equal(JSON.stringify(lease).includes(secret), false)
  assert.equal((await stat(f.privateDirectory)).mode & 0o777, 0o700)
  assert.equal((await stat(f.filename(lease.artifact))).mode & 0o777, 0o400)
  assert.deepEqual(await collect(await f.store.open({ ...lease.artifact }, context())), PNG)
  await lease.release(); assert.deepEqual(await readdir(f.privateDirectory), [])
})

test('streamed video beyond the legacy thirty MiB limit stays chunked and hash-exact', { timeout: 30_000 }, async t => {
  const f = await fixture(t), expected = createHash('sha256'), size = 31 * MiB + 23
  const lease = await f.store.stage(video(size, bytes => expected.update(bytes)), context())
  assert.equal(lease.artifact.sizeBytes, size); assert.equal(lease.artifact.sha256, expected.digest('hex'))
  const reader = await f.store.open(lease.artifact, context()), actual = createHash('sha256')
  let read = 0
  for await (const bytes of reader.chunks) { assert.ok(bytes.length <= MiB); read += bytes.length; actual.update(bytes) }
  assert.equal(read, size); assert.equal(actual.digest('hex'), lease.artifact.sha256)
  assert.throws(() => reader.chunks[Symbol.asyncIterator](), /媒体资源不可用/u)
  await lease.release()
})

test('video accepts exactly 512 MiB and rejects the next streamed byte without leaking quota or files', { timeout: 60_000 }, async t => {
  assert.equal(MAX_AGENT_ARTIFACT_VIDEO_BYTES, 512 * MiB); assert.equal(MAX_AGENT_ARTIFACT_IMAGE_BYTES, 32 * MiB)
  const f = await fixture(t)
  const lease = await f.store.stage(video(512 * MiB), context())
  assert.equal(lease.artifact.sizeBytes, 512 * MiB); assert.equal((await stat(f.filename(lease.artifact))).size, 512 * MiB)
  await lease.release()
  await assert.rejects(f.store.stage(video(512 * MiB + 1), context()), /媒体资源不可用/u)
  assert.deepEqual(await readdir(f.privateDirectory), [])
  const next = await f.store.stage(image(), context()); await next.release()
})

test('image has its own 32 MiB cap and oversized chunks fail before writing their data', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(32 * MiB + 1); PNG.copy(bytes)
  await assert.rejects(f.store.stage({ kind: 'image', mime: 'image/png', chunks: chunks(bytes, bytes.length) }, context()))
  assert.deepEqual(await readdir(f.privateDirectory), [])
})

test('global byte and artifact budgets reserve concurrent work atomically and are restored after release', async t => {
  const f = await fixture(t, { maxTotalBytes: 3 * MiB, maxArtifacts: 2 }), held = gate(), reached = gate()
  const pending = f.store.stage({ kind: 'video', mime: 'video/mp4', chunks: (async function* () {
    yield mp4(2 * MiB); reached.release(); await held.promise; yield Buffer.alloc(1)
  })() }, context())
  await reached.promise
  await assert.rejects(f.store.stage(video(2 * MiB), context()), /媒体资源不可用/u)
  const small = await f.store.stage(image(), context())
  await assert.rejects(f.store.stage(image(), context()), /媒体资源不可用/u)
  await small.release(); held.release()
  const large = await pending; assert.equal(large.artifact.sizeBytes, 2 * MiB + 1)
  await large.release()
  const full = await f.store.stage(video(3 * MiB), context()); await full.release()
  assert.deepEqual(await readdir(f.privateDirectory), [])
})

test('retain holds immutable bytes until the final independent lease releases, revoking active readers', async t => {
  const f = await fixture(t), lease = await f.store.stage(video(2 * MiB), context()), retained = await lease.retain()
  assert.equal(retained.artifact, lease.artifact)
  await lease.release(); await lease.release()
  await assert.rejects(lease.retain(), /媒体资源不可用/u)
  const reader = await f.store.open(retained.artifact, context()), iterator = reader.chunks[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).value.length, MiB)
  await retained.release(); await retained.release()
  await assert.rejects(iterator.next(), /媒体资源不可用/u)
  await reader.close(); assert.deepEqual(await readdir(f.privateDirectory), [])
  await assert.rejects(f.store.open(retained.artifact, context()))
  await assert.rejects(retained.retain())
})

test('source signal, current predicate and close cancel a hanging iterator without waiting for its return', async t => {
  for (const cause of ['signal', 'current', 'close']) await t.test(cause, async t => {
    const f = await fixture(t), reached = gate(), late = gate(), controller = new AbortController()
    let current = true, returns = 0
    const iterator = { [Symbol.asyncIterator]() { return this }, async next() { reached.release(); return late.promise },
      return() { returns++; return new Promise(() => {}) } }
    const operation = f.store.stage({ kind: 'image', mime: 'image/png', chunks: iterator }, context({ signal: controller.signal, isCurrent: () => current }))
    const rejected = boundedRejected(operation, cause)
    await reached.promise
    if (cause === 'signal') controller.abort(new Error(f.directory))
    else if (cause === 'current') current = false
    else await f.store.close()
    await rejected; late.release({ done: false, value: PNG }); await delay(25)
    assert.equal(returns, 1)
    assert.deepEqual(await readdir(f.privateDirectory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error)), [])
  })
})

test('hanging asynchronous permission checks cancel before staging or yielding a reader block', async t => {
  const f = await fixture(t), controller = new AbortController(), reached = gate(), late = gate()
  const operation = f.store.stage(image(), context({ signal: controller.signal, async ensureCurrent() { reached.release(); await late.promise } }))
  const rejected = boundedRejected(operation, 'stage permission')
  await reached.promise; controller.abort(); await rejected; late.release()
  assert.deepEqual(await readdir(f.privateDirectory), [])
  const lease = await f.store.stage(image(), context()), readController = new AbortController(), readGate = gate()
  let block = false
  const reader = await f.store.open(lease.artifact, context({ signal: readController.signal, async ensureCurrent() { if (block) await readGate.promise } }))
  block = true
  const next = reader.chunks[Symbol.asyncIterator]().next(), rejectedRead = boundedRejected(next, 'reader permission')
  await delay(25); readController.abort(); await rejectedRead; readGate.release()
  await reader.close(); await lease.release()
})

test('each reader consumes once, enforces a bounded handle quota, and releases cancelled readers', async t => {
  const f = await fixture(t), lease = await f.store.stage(image(), context()), readers = []
  for (let count = 0; count < 130; count++) {
    const unopened = await f.store.open(lease.artifact, context()), iterator = unopened.chunks[Symbol.asyncIterator]()
    assert.deepEqual(await iterator.return(), { done: true, value: undefined })
    await assert.rejects(iterator.next())
  }
  for (let count = 0; count < 128; count++) readers.push(await f.store.open(lease.artifact, context()))
  await assert.rejects(f.store.open(lease.artifact, context()))
  await Promise.all(readers.map(reader => reader.close()))
  const controller = new AbortController(), reader = await f.store.open(lease.artifact, context({ signal: controller.signal }))
  controller.abort(); await delay(10)
  assert.throws(() => reader.chunks[Symbol.asyncIterator]())
  const replacement = await f.store.open(lease.artifact, context()); await replacement.close()
  await lease.release()
})

test('revocation at the final open check closes the handle and releases exactly one quota slot', async t => {
  const f = await fixture(t), lease = await f.store.stage(image(), context())
  let checks = 0
  const baseline = await f.store.open(lease.artifact, context({ isCurrent: () => { checks++; return true } }))
  await baseline.close()
  const finalCheck = checks
  let nextChecks = 0
  await assert.rejects(f.store.open(lease.artifact, context({ isCurrent: () => ++nextChecks < finalCheck })))
  assert.equal(nextChecks, finalCheck)
  const readers = []
  for (let count = 0; count < 128; count++) readers.push(await f.store.open(lease.artifact, context()))
  await assert.rejects(f.store.open(lease.artifact, context()), 'quota cannot become negative after failed open')
  await Promise.all(readers.map(reader => reader.close())); await lease.release()
})

test('open rejects foreign IDs, modified metadata, getters, symlinks and tampered bytes without exposing paths', async t => {
  const first = await fixture(t), second = await fixture(t), lease = await first.store.stage(image(), context())
  await boundedRejected(second.store.open(lease.artifact, context()), 'foreign')
  for (const changed of [{ id: '0'.repeat(32) }, { sizeBytes: PNG.length + 1 }, { sha256: '0'.repeat(64) }, { mime: 'image/jpeg' }, { kind: 'video' }, { path: '/private/secret' }]) {
    await boundedRejected(first.store.open({ ...lease.artifact, ...changed }, context()), 'metadata')
  }
  const getter = Object.defineProperty({ ...lease.artifact }, 'id', { get() { throw new Error('/private/secret') } })
  await boundedRejected(first.store.open(getter, context()), 'getter')
  const filename = first.filename(lease.artifact), outside = path.join(first.directory, 'neighbor-private.bin')
  await writeFile(outside, PNG); await unlink(filename); await symlink(outside, filename)
  await boundedRejected(first.store.open(lease.artifact, context()), 'symlink')
  await lease.release(); assert.deepEqual(await readFile(outside), PNG)
  const tampered = await first.store.stage(image(), context()), target = first.filename(tampered.artifact)
  await chmod(target, 0o600); const bytes = Buffer.from(PNG); bytes[40] ^= 1; await writeFile(target, bytes); await chmod(target, 0o400)
  await boundedRejected(first.store.open(tampered.artifact, context()), 'changed content')
  await tampered.release()
})

test('reader checks bytes again after open and never yields a changed later block', async t => {
  const f = await fixture(t), lease = await f.store.stage(video(2 * MiB), context()), reader = await f.store.open(lease.artifact, context())
  const iterator = reader.chunks[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).value.length, MiB)
  const filename = f.filename(lease.artifact)
  await chmod(filename, 0o600)
  const file = await open(filename, 'r+'); await file.write(Buffer.from([42]), 0, 1, MiB + 10); await file.close(); await chmod(filename, 0o400)
  await boundedRejected(iterator.next(), 'changed later block'); await lease.release()
})

test('store.close cancels active stages and readers and removes only its own child directory', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-artifact-neighbor-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await chmod(directory, 0o755)
  const originalMode = (await stat(directory)).mode & 0o777
  await writeFile(path.join(directory, 'neighbor.txt'), 'retained neighbor')
  const first = await createAgentMediaArtifactStore({ directory }), second = await createAgentMediaArtifactStore({ directory })
  t.after(() => second.close())
  const lease = await first.stage(image(), context()), other = await second.stage(image(), context())
  const reader = await first.open(lease.artifact, context()), iterator = reader.chunks[Symbol.asyncIterator]()
  const reached = gate(), late = gate()
  const staging = first.stage({ kind: 'image', mime: 'image/png', chunks: (async function* () { reached.release(); await late.promise; yield PNG })() }, context())
  const rejected = boundedRejected(staging, 'close active stage'); await reached.promise
  await Promise.all([first.close(), first.close()]); await rejected; late.release()
  await assert.rejects(iterator.next()); await reader.close(); await lease.release()
  assert.equal((await stat(directory)).mode & 0o777, originalMode)
  assert.equal(await readFile(path.join(directory, 'neighbor.txt'), 'utf8'), 'retained neighbor')
  assert.deepEqual(await collect(await second.open(other.artifact, context())), PNG)
  assert.equal((await readdir(directory)).filter(name => name.startsWith('agent-media-')).length, 1)
  await assert.rejects(first.stage(image(), context())); await assert.rejects(lease.retain())
  await other.release(); await second.close()
  assert.deepEqual(await readdir(directory), ['neighbor.txt'])
})

test('supported MIME headers are checked against actual bytes and unsupported or corrupt data is rejected', async t => {
  const f = await fixture(t)
  const gif = Buffer.alloc(14); gif.write('GIF89a'); gif.writeUInt16LE(1, 6); gif.writeUInt16LE(1, 8)
  const bmp = Buffer.alloc(58); bmp.write('BM'); bmp.writeUInt32LE(58, 2); bmp.writeUInt32LE(54, 10); bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(1, 18); bmp.writeInt32LE(1, 22); bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28)
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0])
  const webp = Buffer.alloc(30); webp.write('RIFF'); webp.writeUInt32LE(22, 4); webp.write('WEBPVP8X', 8); webp.writeUInt32LE(10, 16)
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d, 0x18, 0x53, 0x80, 0x67]), Buffer.alloc(10)])
  const flv = Buffer.alloc(14); flv.write('FLV'); flv[3] = 1; flv[4] = 5; flv.writeUInt32BE(9, 5)
  for (const [kind, mime, bytes] of [['image', 'image/png', PNG], ['image', 'image/gif', gif], ['image', 'image/jpeg', jpeg],
    ['image', 'image/bmp', bmp], ['image', 'image/webp', webp], ['image', 'image/avif', mp4(32, 'avif')],
    ['video', 'video/mp4', mp4()], ['video', 'video/quicktime', mp4(32, 'qt  ')], ['video', 'video/webm', webm], ['video', 'video/x-flv', flv]]) {
    const lease = await f.store.stage({ kind, mime, chunks: chunks(bytes) }, context()); await lease.release()
    await assert.rejects(f.store.stage({ kind, mime, chunks: chunks(Buffer.from('<html>not media</html>')) }, context()))
  }
  for (const invalid of [{ kind: 'image', mime: 'image/svg+xml', chunks: chunks(PNG) }, { kind: 'video', mime: 'video/mp4', chunks: chunks(PNG) },
    { kind: 'image', mime: 'image/png;secret=1', chunks: chunks(PNG) }, { kind: 'image', mime: 'image/png', chunks: chunks(Buffer.alloc(0)) },
    { kind: 'image', mime: 'image/png', chunks: (async function* () { yield 'secret path' })() }]) await assert.rejects(f.store.stage(invalid, context()))
  const oversizedBox = mp4(); oversizedBox.writeUInt32BE(65540)
  await assert.rejects(f.store.stage({ kind: 'video', mime: 'video/mp4', chunks: chunks(oversizedBox) }, context()))
  assert.deepEqual(await readdir(f.privateDirectory), [])
})

test('factory accepts only shortened valid limits and generalizes native filesystem errors', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-artifact-config-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const invalid of [{ maxTotalBytes: 16 * 1024 ** 3 + 1 }, { maxArtifacts: 129 }, { maxArtifacts: 0 }, { maxTotalBytes: -1 },
    { maxArtifacts: 1.5 }, { directory: path.join(directory, 'secret-absent') }, { directory: 'relative-secret' }]) {
    await boundedRejected(createAgentMediaArtifactStore({ directory, ...invalid }), 'factory options')
  }
  const f = await fixture(t), sourceError = (async function* () { throw new Error('/private/secret/file?token=private') })()
  await boundedRejected(f.store.stage({ kind: 'image', mime: 'image/png', chunks: sourceError }, context()), 'source error')
  const lease = await f.store.stage(image(), context())
  for (const field of ['signal', 'isCurrent', 'ensureCurrent']) {
    const malicious = Object.defineProperty(context(), field, { get() { throw new Error('/private/context-secret') } })
    await boundedRejected(f.store.stage(image(), malicious), 'context getter stage')
    await boundedRejected(f.store.open(lease.artifact, malicious), 'context getter open')
  }
  let signalReads = 0
  const singleRead = Object.defineProperty(context(), 'signal', { get() { if (++signalReads > 1) throw new Error('/private/second-getter-secret'); return new AbortController().signal } })
  const captured = await f.store.stage(image(), singleRead)
  assert.equal(signalReads, 1); await captured.release(); await lease.release()
  const maliciousProducer = { [Symbol.asyncIterator]() { return this }, async next() { return { done: false, value: 'invalid-media-chunk' } },
    get return() { throw new Error('/private/return-getter-secret') } }
  const quota = await fixture(t, { maxTotalBytes: PNG.length, maxArtifacts: 1 })
  await boundedRejected(quota.store.stage({ kind: 'image', mime: 'image/png', chunks: maliciousProducer }, context()), 'producer return getter')
  assert.deepEqual(await readdir(quota.privateDirectory), [])
  const recovered = await quota.store.stage(image(), context()); await recovered.release()
  assert.deepEqual(await readdir(directory), [])
})
