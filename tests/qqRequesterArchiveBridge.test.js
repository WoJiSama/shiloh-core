import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { archive, download, sha, waitFor, zip } from './helpers/requesterArchiveFixture.mjs'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const { openQqRequesterArchiveBridge, QQ_REQUESTER_ARCHIVE_TIMEOUT_MS } = await import(pathToFileURL(path.join(release, 'dist/backend/adapters/qqRequesterArchiveBridge.js')).href)
const context = extra => ({ signal: new AbortController().signal, isCurrent: () => true, ...extra })
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'qq-requester-zip-')), bridgeDirectory = path.join(directory, 'bridge')
  await mkdir(bridgeDirectory)
  const bridge = await openQqRequesterArchiveBridge({ directory: bridgeDirectory, listen: { host: '127.0.0.1', port: 0 },
    advertisedOrigin: 'http://127.0.0.1:0', allowedPeers: ['127.0.0.1'], ...options })
  t.after(async () => { await bridge.close().catch(() => {}); await rm(directory, { recursive: true, force: true }) })
  return { bridge, directory, bridgeDirectory, async files() {
    return (await Promise.all((await readdir(bridgeDirectory)).map(async child => (await readdir(path.join(bridgeDirectory, child))).map(file => path.join(bridgeDirectory, child, file))))).flat()
  } }
}

test('ZIP bridge retains complete owned bytes and revokes an opaque capability without exposing name or paths', async t => {
  const f = await fixture(t), bytes = zip(120000), lease = await f.bridge.stage(archive(bytes), context())
  assert.deepEqual(Object.keys(lease), ['nativeUrl', 'release']); assert.ok(Object.isFrozen(lease))
  assert.match(new URL(lease.nativeUrl).pathname, /^\/qq-requester-archive\/[a-f\d]{64}$/u)
  assert.equal(lease.nativeUrl.includes(f.directory), false); assert.equal(lease.nativeUrl.includes('下载'), false)
  const result = await download(lease.nativeUrl)
  assert.equal(result.status, 200); assert.equal(result.size, bytes.length); assert.equal(result.sha256, sha(bytes))
  assert.equal(result.headers['content-type'], 'application/zip'); assert.equal(result.headers['content-length'], String(bytes.length))
  assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.headers['x-content-type-options'], 'nosniff')
  assert.equal(result.headers['accept-ranges'], 'none')
  await lease.release(); await lease.release(); assert.equal((await download(lease.nativeUrl)).status, 404)
  assert.deepEqual(await f.files(), [])
})

test('capabilities reject query/path/range/body methods, unknown tokens and peers', async t => {
  const f = await fixture(t), lease = await f.bridge.stage(archive(), context()), url = new URL(lease.nativeUrl)
  assert.equal((await download(lease.nativeUrl, { method: 'HEAD' })).status, 200)
  assert.equal((await download(lease.nativeUrl, { method: 'POST' })).status, 405)
  assert.equal((await download(lease.nativeUrl, { headers: { Range: 'bytes=0-10' } })).status, 416)
  assert.equal((await download(lease.nativeUrl, { path: `${url.pathname}?secret=1` })).status, 404)
  assert.equal((await download(lease.nativeUrl, { path: `${url.pathname}/` })).status, 404)
  assert.equal((await download(lease.nativeUrl, { path: '/qq-requester-archive/' + '0'.repeat(64) })).status, 404)
  const denied = await fixture(t, { allowedPeers: ['192.168.1.20'] }), deniedLease = await denied.bridge.stage(archive(), context())
  assert.equal((await download(deniedLease.nativeUrl)).status, 403)
})

test('bounded instance bytes/count, GET byte budget and request count release capacity', async t => {
  const f = await fixture(t, { maxArchives: 1, maxTotalBytes: 256 }), lease = await f.bridge.stage(archive(zip(256)), context())
  await assert.rejects(f.bridge.stage(archive(), context()))
  for (let i = 0; i < 8; i++) assert.equal((await download(lease.nativeUrl)).status, 200)
  assert.equal((await download(lease.nativeUrl)).status, 429)
  await lease.release(); const next = await f.bridge.stage(archive(), context())
  for (let i = 0; i < 32; i++) assert.equal((await download(next.nativeUrl, { method: 'HEAD' })).status, 200)
  assert.equal((await download(next.nativeUrl, { method: 'HEAD' })).status, 429)
})

test('revocation, absolute TTL and binding invalidation delete copies and stop active HTTP bodies', async t => {
  assert.equal(QQ_REQUESTER_ARCHIVE_TIMEOUT_MS, 600000)
  const f = await fixture(t, { timeoutMs: 120 }), lease = await f.bridge.stage(archive(), context())
  await delay(170); assert.equal((await download(lease.nativeUrl)).status, 404); await waitFor(async () => (await f.files()).length === 0)
  let current = true
  const second = await f.bridge.stage(archive(), context({ isCurrent: () => current }))
  current = false
  await waitFor(async () => (await f.files()).length === 0)
  assert.equal((await download(second.nativeUrl)).status, 404)
  const g = await fixture(t), controller = new AbortController(), large = await g.bridge.stage(archive(zip(8 * 1024 * 1024)), context({ signal: controller.signal }))
  await assert.rejects(download(large.nativeUrl, { onData(_chunk, response) { response.pause(); controller.abort(); response.resume() } }))
  await waitFor(async () => (await g.files()).length === 0)
})

test('tampered copies are never returned with a successful full ZIP body', async t => {
  const f = await fixture(t), lease = await f.bridge.stage(archive(), context()), [filename] = await f.files()
  await chmod(filename, 0o600); await writeFile(filename, zip())
  try { assert.equal((await download(lease.nativeUrl)).status, 404) }
  catch (error) { assert.equal(error.code, 'ECONNRESET') }
  await waitFor(async () => (await f.files()).length === 0)
})

test('invalid archive, hostile guard, oversize and malformed origin fail closed', async t => {
  const f = await fixture(t)
  for (const value of [{ ...archive(), name: '../a.zip' }, { ...archive(), mime: 'video/mp4' }, { ...archive(), base64: Buffer.from('PK\x03\x04').toString('base64') }]) await assert.rejects(f.bridge.stage(value, context()))
  await assert.rejects(f.bridge.stage(archive(), context({ signal: new Proxy(new AbortController().signal, {}) })))
  await assert.rejects(f.bridge.stage(archive(), { get signal() { throw Error('secret') } }))
  for (const advertisedOrigin of ['http://example.com', 'http://127.0.0.1/a/..', 'http://127.0.0.1?x=1', 'http://127.0.0.1@evil.test']) {
    await assert.rejects(openQqRequesterArchiveBridge({ directory: f.directory, listen: { host: '127.0.0.1', port: 0 }, advertisedOrigin, allowedPeers: ['127.0.0.1'] }))
  }
  assert.deepEqual(await f.files(), [])
})

test('close cancels pending authorization and preserves unrelated directory contents', async t => {
  const f = await fixture(t); await writeFile(path.join(f.bridgeDirectory, 'foreign'), 'keep')
  let started = false
  const pending = f.bridge.stage(archive(), context({ ensureCurrent() { started = true; return new Promise(() => {}) } }))
  const rejected = assert.rejects(pending); await waitFor(() => started); await f.bridge.close(); await rejected
  assert.deepEqual(await readdir(f.bridgeDirectory), ['foreign']); await assert.rejects(f.bridge.stage(archive(), context()))
})
