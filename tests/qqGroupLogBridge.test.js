import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { download, sha, waitFor } from './helpers/requesterArchiveFixture.mjs'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const compiled = name => pathToFileURL(path.join(release, 'dist/backend', name)).href
const { openQqGroupLogBridge, QQ_GROUP_LOG_TIMEOUT_MS } = await import(compiled('adapters/qqGroupLogBridge.js'))
const { openQqRequesterArchiveBridge, QQ_REQUESTER_ARCHIVE_TIMEOUT_MS } = await import(compiled('adapters/qqRequesterArchiveBridge.js'))
const context = extra => ({ signal: new AbortController().signal, isCurrent: () => true, ...extra })
const log = (text = '玩家：你好\n希洛：开始冒险。\n', html = false) => ({ name: html ? '跑团记录.html' : '跑团记录.txt',
  mime: html ? 'text/html' : 'text/plain', base64: Buffer.from(text).toString('base64') })
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'qq-group-log-')), bridgeDirectory = path.join(directory, 'bridge')
  await mkdir(bridgeDirectory)
  const bridge = await openQqGroupLogBridge({ directory: bridgeDirectory, listen: { host: '127.0.0.1', port: 0 },
    advertisedOrigin: 'http://127.0.0.1:0', allowedPeers: ['127.0.0.1'], ...options })
  t.after(async () => { await bridge.close().catch(() => {}); await rm(directory, { recursive: true, force: true }) })
  return { bridge, directory, bridgeDirectory, async files() {
    return (await Promise.all((await readdir(bridgeDirectory)).map(async child => (await readdir(path.join(bridgeDirectory, child))).map(file => path.join(bridgeDirectory, child, file))))).flat()
  } }
}

test('TXT and HTML capabilities preserve complete UTF8 bytes and MIME with private files and opaque URLs', async t => {
  const f = await fixture(t)
  for (const html of [false, true]) {
    const input = log(html ? '<!doctype html><meta charset="utf-8"><pre>玩家：你好 &amp; 世界。</pre>' : undefined, html)
    const bytes = Buffer.from(input.base64, 'base64'), lease = await f.bridge.stage(input, context())
    assert.deepEqual(Object.keys(lease), ['nativeUrl', 'release']); assert.ok(Object.isFrozen(lease))
    assert.match(new URL(lease.nativeUrl).pathname, /^\/qq-group-log\/[a-f\d]{64}$/u)
    assert.equal(lease.nativeUrl.includes(f.directory), false); assert.equal(lease.nativeUrl.includes('跑团'), false)
    const [filename] = await f.files()
    assert.equal((await lstat(path.dirname(filename))).mode & 0o777, 0o700)
    assert.equal((await lstat(filename)).mode & 0o777, 0o400)
    const result = await download(lease.nativeUrl)
    assert.equal(result.status, 200); assert.equal(result.size, bytes.length); assert.equal(result.sha256, sha(bytes))
    assert.equal(result.headers['content-type'], input.mime); assert.equal(result.headers['content-length'], String(bytes.length))
    assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.headers['x-content-type-options'], 'nosniff')
    assert.equal(result.headers['accept-ranges'], 'none')
    await lease.release(); await lease.release(); assert.equal((await download(lease.nativeUrl)).status, 404)
    assert.deepEqual(await f.files(), [])
  }
})

test('group-log capabilities enforce exact peer ACL, strict path and bounded HTTP methods and requests', async t => {
  const f = await fixture(t), lease = await f.bridge.stage(log(), context()), url = new URL(lease.nativeUrl)
  assert.equal((await download(lease.nativeUrl, { method: 'HEAD' })).status, 200)
  assert.equal((await download(lease.nativeUrl, { method: 'POST' })).status, 405)
  assert.equal((await download(lease.nativeUrl, { headers: { Range: 'bytes=0-10' } })).status, 416)
  for (const suffix of ['?token=secret', '/', '%2f', '/../']) assert.equal((await download(lease.nativeUrl, { path: url.pathname + suffix })).status, 404)
  assert.equal((await download(lease.nativeUrl, { path: '/qq-requester-archive/' + url.pathname.split('/').at(-1) })).status, 404)
  const denied = await fixture(t, { allowedPeers: ['127.0.0.2'] }), deniedLease = await denied.bridge.stage(log(), context())
  assert.equal((await download(deniedLease.nativeUrl)).status, 403)
})

test('group-log capacity is reserved atomically and released; GET bytes and HEAD counts are bounded', async t => {
  const f = await fixture(t, { maxLogs: 1, maxTotalBytes: 256 }), lease = await f.bridge.stage(log('x'.repeat(256)), context())
  await assert.rejects(f.bridge.stage(log(), context()))
  for (let i = 0; i < 8; i++) assert.equal((await download(lease.nativeUrl)).status, 200)
  assert.equal((await download(lease.nativeUrl)).status, 429)
  await lease.release(); const next = await f.bridge.stage(log(), context())
  for (let i = 0; i < 32; i++) assert.equal((await download(next.nativeUrl, { method: 'HEAD' })).status, 200)
  assert.equal((await download(next.nativeUrl, { method: 'HEAD' })).status, 429)
  await next.release()
  let unblock, called = false
  const first = f.bridge.stage(log(), context({ ensureCurrent() { called = true; return new Promise(resolve => { unblock = resolve }) } }))
  await waitFor(() => called); await assert.rejects(f.bridge.stage(log(), context()))
  // Cancel the pending authorization through bridge shutdown, without leaking a reserved slot or file.
  const rejected = assert.rejects(first); await f.bridge.close(); await rejected; unblock()
})

test('group-log TTL, caller abort and binding loss revoke copies and interrupt streaming downloads', async t => {
  assert.equal(QQ_GROUP_LOG_TIMEOUT_MS, 600000)
  const f = await fixture(t, { timeoutMs: 100 }), lease = await f.bridge.stage(log(), context())
  await delay(150); assert.equal((await download(lease.nativeUrl)).status, 404); await waitFor(async () => (await f.files()).length === 0)
  let current = true
  const second = await f.bridge.stage(log(), context({ isCurrent: () => current }))
  current = false; await waitFor(async () => (await f.files()).length === 0)
  assert.equal((await download(second.nativeUrl)).status, 404)
  const g = await fixture(t), controller = new AbortController(), large = await g.bridge.stage(log('x'.repeat(8 * 1024 * 1024)), context({ signal: controller.signal }))
  await assert.rejects(download(large.nativeUrl, { onData(_chunk, response) { response.pause(); controller.abort(); response.resume() } }))
  await waitFor(async () => (await g.files()).length === 0)
})

test('tampered files and symlink replacements cannot produce a successful complete log', async t => {
  for (const replace of [false, true]) {
    const f = await fixture(t), lease = await f.bridge.stage(log(), context()), [filename] = await f.files()
    if (replace) {
      const foreign = path.join(f.directory, 'foreign'); await writeFile(foreign, 'secret foreign bytes')
      await rm(filename); await symlink(foreign, filename)
    } else { await chmod(filename, 0o600); await writeFile(filename, 'tampered') }
    try { assert.equal((await download(lease.nativeUrl)).status, 404) } catch (error) { assert.equal(error.code, 'ECONNRESET') }
    await waitFor(async () => (await f.files()).length === 0)
  }
})

test('malformed UTF8, noncanonical bytes, filenames, MIME, proxy signals and unsafe origins fail closed', async t => {
  const f = await fixture(t)
  for (const value of [{ ...log(), name: '../log.txt' }, { ...log(), mime: 'application/zip' },
    { ...log(), base64: Buffer.from([0xc3, 0x28]).toString('base64') }, { ...log(), base64: log().base64 + '\n' }]) await assert.rejects(f.bridge.stage(value, context()))
  await assert.rejects(f.bridge.stage(log(), context({ signal: new Proxy(new AbortController().signal, {}) })))
  await assert.rejects(f.bridge.stage(log(), { get signal() { throw Error('secret') } }))
  for (const advertisedOrigin of ['http://example.com', 'http://127.0.0.1/a/..', 'http://127.0.0.1?x=1', 'http://127.0.0.1@evil.test']) {
    await assert.rejects(openQqGroupLogBridge({ directory: f.directory, listen: { host: '127.0.0.1', port: 0 }, advertisedOrigin, allowedPeers: ['127.0.0.1'] }))
  }
  assert.deepEqual(await f.files(), [])
})

test('group-log defaults permit four files and retain independent ZIP hard caps and public errors', async t => {
  const f = await fixture(t), leases = []
  for (let i = 0; i < 4; i++) leases.push(await f.bridge.stage(log(), context()))
  await assert.rejects(f.bridge.stage(log(), context()), { message: 'QQ 团录临时资源不可用或操作已取消' })
  await Promise.all(leases.map(lease => lease.release()))
  assert.equal(QQ_REQUESTER_ARCHIVE_TIMEOUT_MS, 600000)
  const common = { directory: f.directory, listen: { host: '127.0.0.1', port: 0 }, advertisedOrigin: 'http://127.0.0.1:0', allowedPeers: ['127.0.0.1'] }
  for (const options of [{ maxLogs: 5 }, { maxTotalBytes: 400 * 1024 * 1024 + 1 }, { timeoutMs: 600001 }]) {
    await assert.rejects(openQqGroupLogBridge({ ...common, ...options }), { message: 'QQ 团录临时资源不可用或操作已取消' })
  }
  for (const options of [{ maxArchives: 5 }, { maxTotalBytes: 200000001 }, { timeoutMs: 600001 }]) {
    await assert.rejects(openQqRequesterArchiveBridge({ ...common, ...options }), { message: 'QQ 请求者压缩包临时资源不可用或操作已取消' })
  }
})

test('closing group-log bridge cancels pending authorization and preserves unrelated contents', async t => {
  const f = await fixture(t); await writeFile(path.join(f.bridgeDirectory, 'foreign'), 'keep')
  let started = false
  const pending = f.bridge.stage(log(), context({ ensureCurrent() { started = true; return new Promise(() => {}) } }))
  const rejected = assert.rejects(pending); await waitFor(() => started); await f.bridge.close(); await rejected
  assert.deepEqual(await readdir(f.bridgeDirectory), ['foreign'])
  await assert.rejects(f.bridge.stage(log(), context()), { message: 'QQ 团录临时资源不可用或操作已取消' })
})


test('group-log bridge rejects hostile contexts and callback or signal Proxies before any trap', async t => {
  const f = await fixture(t); let traps = 0
  const poison = value => new Proxy(value, { get() { traps++; throw Error('get trap') },
    getPrototypeOf() { traps++; throw Error('prototype trap') }, ownKeys() { traps++; throw Error('keys trap') },
    getOwnPropertyDescriptor() { traps++; throw Error('descriptor trap') }, apply() { traps++; throw Error('apply trap') } })
  for (const value of [poison(context()), context({ isCurrent: poison(() => true) }), context({ signal: poison(new AbortController().signal) }),
    context({ ensureCurrent: poison(async () => {}) }), { get signal() { traps++; throw Error('getter') } },
    { signal: new AbortController().signal, get isCurrent() { traps++; throw Error('getter') } }]) {
    await assert.rejects(f.bridge.stage(log(), value), { message: 'QQ 团录临时资源不可用或操作已取消' })
  }
  await assert.rejects(f.bridge.stage(poison(log()), context()), { message: 'QQ 团录临时资源不可用或操作已取消' })
  assert.equal(traps, 0); assert.deepEqual(await f.files(), [])
})
