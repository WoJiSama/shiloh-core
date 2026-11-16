import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const module = name => import(pathToFileURL(path.join(release, `dist/backend/modules/media/infrastructure/${name}.js`)).href)
const { createAgentTorrentProvider } = await module('agentTorrentProvider')
const { parseAgentTorrentMetadata } = await module('agentTorrentMetadata')
const { createTorrentHttp, nativeAgentTorrentRequest, torrentCacheUrls } = await module('agentTorrentHttp')
const { nativeAgentTorrentCommand, torrentGuard } = await module('agentTorrentNative')
const { torrentZipCrc32 } = await module('agentTorrentZip')
const { getTorrentInfoHash } = await module('torrentDownload')
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve }); return { promise, release } }
async function bounded(operation, timeout = 3000) { let timer; try { return await Promise.race([operation, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('torrent fixture hung')), timeout) })]) } finally { clearTimeout(timer) } }
const context = (controller = new AbortController()) => ({ signal: controller.signal, isCurrent: () => !controller.signal.aborted })
const response = bytes => ({ status: 200, headers: {}, body: bytes })
const encode = value => {
  if (Buffer.isBuffer(value) || typeof value === 'string') { const bytes = Buffer.from(value); return Buffer.concat([Buffer.from(`${bytes.length}:`), bytes]) }
  if (typeof value === 'number') return Buffer.from(`i${value}e`)
  if (Array.isArray(value)) return Buffer.concat([Buffer.from('l'), ...value.map(encode), Buffer.from('e')])
  return Buffer.concat([Buffer.from('d'), ...Object.entries(value).flatMap(([key, item]) => [encode(key), encode(item)]), Buffer.from('e')])
}
function torrent(files = [{ name: ['safe.bin'], bytes: Buffer.from('safe') }], { pieceLength = 4, info = {}, outer = {}, single = files.length === 1 } = {}) {
  const payload = Buffer.concat(files.map(file => file.bytes)), pieces = []
  for (let at = 0; at < payload.length; at += pieceLength) pieces.push(createHash('sha1').update(payload.subarray(at, at + pieceLength)).digest())
  const value = { name: single ? files[0].name[0] : 'bundle', ...(single ? { length: payload.length } : { files: files.map(file => ({ length: file.bytes.length, path: file.name })) }),
    'piece length': pieceLength, pieces: Buffer.concat(pieces), ...info }
  return encode({ announce: 'http://127.0.0.1:9999/secret-tracker', 'url-list': ['http://10.0.0.1/private'], nodes: [['127.0.0.1', 9999]], ...outer, info: value })
}
function storedZip(entries) {
  const locals = [], central = []; let offset = 0
  for (const [name, content] of entries) {
    const filename = Buffer.from(name), crc = torrentZipCrc32(content), local = Buffer.alloc(30), directory = Buffer.alloc(46)
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt32LE(crc, 14); local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(filename.length, 26)
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x031e, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(content.length, 20); directory.writeUInt32LE(content.length, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(0x81a40000, 38); directory.writeUInt32LE(offset, 42)
    locals.push(local, filename, content); central.push(directory, filename); offset += local.length + filename.length + content.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'torrent-provider-test-')), controller = new AbortController(), raw = options.raw ?? torrent(options.files)
  const hash = getTorrentInfoHash(raw), magnet = `magnet:?xt=urn:btih:${hash}&tr=http%3A%2F%2F127.0.0.1%3A9999&ws=http%3A%2F%2F10.0.0.1%2Fsecret&x.pe=127.0.0.1:88&as=file:///etc/passwd`
  const requests = [], commands = [], lookups = []
  let current = true, ensure = true, metadata = raw, cache = options.cache ?? true
  t.after(async () => { controller.abort(); await rm(directory, { recursive: true, force: true }) })
  const request = async (url, address, signal, policy) => {
    const call = { url: new URL(url), address, signal, policy }; requests.push(call)
    if (options.request) return options.request(call)
    if (!cache) throw new Error('synthetic cache outage')
    return response(metadata)
  }
  const commandRunner = async (command, args, own) => {
    const call = { command, args, ...own }; commands.push(call)
    assert.equal((await lstat(path.dirname(own.cwd))).mode & 0o777, 0o700)
    assert.ok(own.signal instanceof AbortSignal)
    if (options.command) { const handled = await options.command(call); if (handled === true) return }
    if (command === 'zip') {
      const entries = await Promise.all(args.slice(5).map(async name => [name.replace(/^\.\//u, ''), await readFile(path.join(own.cwd, name))]))
      await writeFile(args[4], storedZip(entries), { mode: 0o600 }); return
    }
    assert.ok(args.includes('--no-conf=true')); assert.ok(args.includes('--daemon=false')); assert.ok(args.includes('--enable-rpc=false')); assert.ok(args.includes('--seed-time=0'))
    if (args.includes('--bt-metadata-only=true')) {
      await writeFile(path.join(own.cwd, `${hash}.torrent`), metadata, { mode: 0o600 }); return
    }
    const native = await readFile(args.at(-1))
    assert.equal(getTorrentInfoHash(native), hash); assert.equal(native.includes(Buffer.from('127.0.0.1')), false); assert.equal(native.includes(Buffer.from('url-list')), false)
    assert.ok(args.includes('--check-integrity=true'))
    const parsed = parseAgentTorrentMetadata(metadata, hash).metadata, files = options.files ?? [{ name: ['safe.bin'], bytes: Buffer.from('safe') }]
    for (const [index, file] of parsed.files.entries()) {
      const target = path.join(own.cwd, ...file.relativePath)
      await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, files[index].bytes, { mode: 0o600 })
    }
  }
  const provider = createAgentTorrentProvider({ directory, minFreeBytes: 1, request, lookup: async host => { lookups.push(host); return [{ address: '8.8.8.8', family: 4 }] }, commandRunner, ...options.provider })
  return { directory, controller, provider, requests, commands, lookups, raw, hash, magnet,
    scope: { signal: controller.signal, isCurrent: () => current && !controller.signal.aborted, async ensureCurrent() { if (!ensure) throw new Error('synthetic permission revoked') } },
    setCurrent(value) { current = value }, setEnsure(value) { ensure = value }, setMetadata(value) { metadata = value }, setCache(value) { cache = value },
    async prepare(selection) { return provider.prepare(magnet, selection, this.scope) },
    async clean() { assert.deepEqual(await readdir(directory), []) } }
}
async function rejected(operation) { await assert.rejects(bounded(operation), error => { assert.equal(error.message, '磁链处理失败：来源、权限、网络、完整性或资源限制不符合要求'); return true }) }

test('Core produces a complete stored ZIP, strips every untrusted network extension and leaves no private paths', async t => {
  const f = await fixture(t), result = await f.prepare()
  assert.equal(result.status, 'ready'); assert.equal(result.metadata.infoHash, f.hash); assert.equal(result.metadata.fingerprint, createHash('sha256').update(f.raw).digest('hex'))
  assert.equal(result.archive.mime, 'application/zip'); assert.equal(Buffer.from(result.archive.base64, 'base64').readUInt32LE(0), 0x04034b50)
  assert.deepEqual(Object.keys(result), ['status', 'metadata', 'archive']); assert.equal(JSON.stringify(result).includes(f.directory), false)
  assert.deepEqual(f.lookups, ['itorrents.net']); assert.equal(f.commands.filter(call => call.command === 'aria2c').length, 1)
  const payload = f.commands[0]; assert.equal(payload.args.includes(f.magnet), false); assert.ok(payload.args.includes('--index-out=1=./safe.bin'))
  assert.deepEqual(f.commands[1].args.slice(0, 4), ['-q', '-X', '-0', '-MM']); assert.deepEqual(f.commands[1].args.slice(5), ['./safe.bin']); await f.clean()
})

test('hashing uses the original noncanonical info bytes and fingerprint includes outer metadata', () => {
  const a = torrent(), b = torrent(undefined, { outer: { comment: 'different outer metadata' } }), hash = getTorrentInfoHash(a)
  assert.equal(getTorrentInfoHash(b), hash)
  const parsed = parseAgentTorrentMetadata(a, hash), changed = parseAgentTorrentMetadata(b, hash)
  assert.equal(getTorrentInfoHash(parsed.nativeMetadata), hash); assert.notEqual(parsed.metadata.fingerprint, changed.metadata.fingerprint)
  assert.throws(() => parseAgentTorrentMetadata(Buffer.concat([a, Buffer.from('junk')]), hash))
  assert.throws(() => parseAgentTorrentMetadata(a, '0'.repeat(40)))
})

test('metadata rejects ambiguous path extensions, symlinks, collisions, malformed pieces and invalid bencode', () => {
  const cases = [
    torrent(undefined, { info: { 'name.utf-8': 'other.bin' } }), torrent(undefined, { info: { attr: 'l', 'symlink path': ['etc', 'passwd'] } }),
    torrent(undefined, { info: { files: [{ length: 4, path: ['other.bin'] }] } }), torrent(undefined, { info: { pieces: Buffer.alloc(19) } }),
    torrent(undefined, { info: { 'piece length': 0 } }), torrent(undefined, { info: { 'piece length': 64 * 1024 * 1024 + 1 } }),
    torrent([{ name: ['../bad'], bytes: Buffer.from('one') }]), torrent([{ name: ['..'], bytes: Buffer.from('one') }]),
    torrent([{ name: ['a\\b'], bytes: Buffer.from('one') }]), torrent([{ name: ['C:drive'], bytes: Buffer.from('one') }]),
    torrent([{ name: ['A.bin'], bytes: Buffer.from('one') }, { name: ['a.bin'], bytes: Buffer.from('two') }]),
    torrent([{ name: ['a'], bytes: Buffer.from('one') }, { name: ['a', 'b'], bytes: Buffer.from('two') }]),
    torrent([{ name: ['e\u0301.bin'], bytes: Buffer.from('one') }, { name: ['é.bin'], bytes: Buffer.from('two') }]),
    encode({ info: { name: 'safe.bin', length: 4, 'piece length': 4, pieces: Buffer.alloc(20), files: [] } }),
  ]
  for (const bytes of cases) assert.throws(() => parseAgentTorrentMetadata(bytes, getTorrentInfoHash(bytes)))
  const repeated = Buffer.from('d4:infod4:name1:a4:name1:b6:lengthi1e12:piece lengthi1e6:pieces20:00000000000000000000ee')
  assert.throws(() => parseAgentTorrentMetadata(repeated, getTorrentInfoHash(repeated)))
})

test('legal GBK and NFC names survive with a fixed native index output, and option-like names stay file arguments', async t => {
  for (const name of [Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), 'e\u0301.bin', '-T.bin']) await t.test(String(name), async t => {
    const files = [{ name: [name], bytes: Buffer.from('safe') }], f = await fixture(t, { files, raw: torrent(files) }), result = await f.prepare()
    assert.equal(result.status, 'ready'); assert.ok(f.commands[0].args.includes(`--index-out=1=./${result.metadata.name}`)); assert.equal(f.commands.at(-1).args[5], `./${result.metadata.name}`); await f.clean()
  })
})

test('over-limit torrents expose the complete listing without payload, and a selection rechecks its raw fingerprint', async t => {
  const files = [1, 2, 3, 4].map(index => ({ name: [`${index}.bin`], bytes: Buffer.from(String(index).repeat(3)) })), f = await fixture(t, { files })
  const listing = await f.prepare(); assert.equal(listing.status, 'selection-required'); assert.deepEqual(listing.selectableIndexes, [1, 2, 3, 4]); assert.equal(f.commands.length, 0); await f.clean()
  const chosen = await f.prepare({ indexes: [2], expectedFingerprint: listing.metadata.fingerprint })
  assert.equal(chosen.status, 'ready'); assert.equal(chosen.metadata.files.length, 4); assert.ok(f.commands[0].args.includes('--select-file=2')); assert.deepEqual(f.commands[1].args.slice(5), ['./bundle/2.bin']); await f.clean()
  f.setMetadata(torrent(files, { outer: { comment: 'changed while user chose files' } }))
  await rejected(f.prepare({ indexes: [2], expectedFingerprint: listing.metadata.fingerprint })); assert.equal(f.commands.length, 2); await f.clean()
})

test('piece integrity checks selected content and neighbor spill, while only selected files enter ZIP', async t => {
  const files = [{ name: ['a.bin'], bytes: Buffer.from('abc') }, { name: ['b.bin'], bytes: Buffer.from('def') }], raw = torrent(files, { pieceLength: 4 })
  const f = await fixture(t, { files, raw, provider: { maxFiles: 1 } }), listing = await f.prepare(), selected = { indexes: [2], expectedFingerprint: listing.metadata.fingerprint }
  assert.equal((await f.prepare(selected)).status, 'ready'); assert.deepEqual(f.commands.at(-1).args.slice(5), ['./bundle/b.bin']); await f.clean()
  const broken = await fixture(t, { files, raw, command: async call => {
    if (call.command !== 'aria2c' || call.args.includes('--bt-metadata-only=true')) return
    await mkdir(path.join(call.cwd, 'bundle')); await writeFile(path.join(call.cwd, 'bundle/b.bin'), 'def'); return true
  } })
  await rejected(broken.prepare({ indexes: [2], expectedFingerprint: createHash('sha256').update(raw).digest('hex') })); assert.equal(broken.commands.some(call => call.command === 'zip'), false); await broken.clean()
  for (const spilled of ['d', 'x']) await t.test(`one-byte neighbor spill ${spilled}`, async t => {
    const partial = await fixture(t, { files, raw, command: async call => {
      if (call.command !== 'aria2c' || call.args.includes('--bt-metadata-only=true')) return
      await mkdir(path.join(call.cwd, 'bundle')); await writeFile(path.join(call.cwd, 'bundle/a.bin'), 'abc'); await writeFile(path.join(call.cwd, 'bundle/b.bin'), spilled); return true
    } })
    const operation = partial.prepare({ indexes: [1], expectedFingerprint: createHash('sha256').update(raw).digest('hex') })
    if (spilled === 'd') { assert.equal((await operation).status, 'ready'); assert.deepEqual(partial.commands.at(-1).args.slice(5), ['./bundle/a.bin']) }
    else { await rejected(operation); assert.equal(partial.commands.some(call => call.command === 'zip'), false) }
    await partial.clean()
  })
})

test('neither same-size corrupt payload nor malformed ZIP can produce ready bytes', async t => {
  for (const fault of ['payload', 'zip', 'zip-crc', 'symlink', 'short']) await t.test(fault, async t => {
    const f = await fixture(t, { command: async call => {
      if (call.command === 'aria2c' && !call.args.includes('--bt-metadata-only=true') && ['payload', 'symlink', 'short'].includes(fault)) {
        if (fault === 'symlink') { await writeFile(path.join(call.cwd, 'outside.bin'), 'safe'); await symlink(path.join(call.cwd, 'outside.bin'), path.join(call.cwd, 'safe.bin')) }
        else await writeFile(path.join(call.cwd, 'safe.bin'), fault === 'short' ? 's' : 'evil')
        return true
      }
      if (call.command === 'zip' && fault.startsWith('zip')) { const bytes = fault === 'zip' ? Buffer.from('zip') : storedZip([['safe.bin', Buffer.from('evil')]]); await writeFile(call.args[4], bytes); return true }
    } })
    await rejected(f.prepare()); await f.clean()
  })
})

test('cache failure tries canonical DHT and then only fixed trackers before payload', async t => {
  let first = true
  const f = await fixture(t, { cache: false, command: async call => {
    if (call.args.includes('--bt-metadata-only=true') && first) { first = false; throw new Error('synthetic no DHT metadata') }
  } })
  assert.equal((await f.prepare()).status, 'ready'); assert.deepEqual(f.lookups, ['itorrents.net', 'torrage.info'])
  const attempts = f.commands.filter(call => call.args.includes('--bt-metadata-only=true'))
  assert.equal(attempts.length, 2)
  for (const attempt of attempts) assert.equal(attempt.args.at(-1), `magnet:?xt=urn:btih:${f.hash}`)
  assert.equal(attempts[0].args.some(arg => arg.startsWith('--bt-tracker=')), false); assert.ok(attempts[1].args.find(arg => arg.startsWith('--bt-tracker=')).includes('tracker.opentrackr.org')); await f.clean()
})

test('only a trusted host proxy option reaches native HTTP tracker arguments and never enters results', async t => {
  const f = await fixture(t, { provider: { proxyUrl: 'http://127.0.0.1:7890' } }), result = await f.prepare()
  assert.equal(result.status, 'ready'); assert.ok(f.commands[0].args.includes('--all-proxy=http://127.0.0.1:7890/')); assert.equal(JSON.stringify(result).includes('7890'), false); await f.clean()
  for (const proxyUrl of ['file:///etc/passwd', 'http://127.0.0.1:7890/path', 'http://127.0.0.1:7890/?secret=1']) assert.throws(() => createAgentTorrentProvider({ proxyUrl }))
})

test('hard limits cannot exceed 50,000,000 bytes, three files or the ZIP reserve, even with enlarged options', async t => {
  const files = [1, 2, 3, 4].map(index => ({ name: [`${index}.bin`], bytes: Buffer.from('safe') })), f = await fixture(t, { files, provider: { maxFiles: 99, maxTotalBytes: 1e9, maxArchiveBytes: 1e9, maxSingleFileBytes: 1e9 } })
  assert.equal((await f.prepare()).status, 'selection-required'); await f.clean()
  await rejected(f.prepare({ indexes: [1, 2, 3, 4], expectedFingerprint: createHash('sha256').update(f.raw).digest('hex') })); assert.equal(f.commands.length, 0)
  const limit = await fixture(t, { provider: { maxArchiveBytes: 3 } }); await rejected(limit.prepare()); assert.equal(limit.commands.length, 0); await limit.clean()
  for (const length of [50_000_001, 49_000_001]) await t.test(String(length), async t => {
    const raw = encode({ info: { name: 'over-limit.bin', length, 'piece length': 64 * 1024 * 1024, pieces: Buffer.alloc(20) } }), f = await fixture(t, { raw, provider: { maxTotalBytes: 1e9, maxSingleFileBytes: 1e9, maxArchiveBytes: 1e9 } })
    await rejected(f.prepare()); assert.equal(f.commands.length, 0, 'neither payload nor ZIP is started above the 50 MB or reserve limit'); await f.clean()
  })
})

test('metadata accepts the full original two-MiB budget while parsed output and native metadata remain compact', async t => {
  const raw = torrent(undefined, { outer: { comment: 'x'.repeat(2_000_001) } }), f = await fixture(t, { raw })
  assert.ok(raw.length < 2 * 1024 * 1024); assert.equal((await f.prepare()).status, 'ready'); await f.clean()
})

test('metadata sources reject declared and actual oversized bodies without publishing bytes', async t => {
  for (const declared of [true, false]) await t.test(String(declared), async t => {
    const f = await fixture(t, { request: () => ({ status: 200, headers: declared ? { 'content-length': String(2 * 1024 * 1024 + 1) } : {}, body: Buffer.alloc(2 * 1024 * 1024 + 1) }),
      command: () => { throw new Error('synthetic native outage') } })
    await rejected(f.prepare()); assert.equal(f.requests.length, 2); assert.equal(f.commands.length, 2); await f.clean()
  })
})

test('current-source cancellation, permission revocation and explicit abort stop a hanging native child before private cleanup', async t => {
  for (const mode of ['signal', 'current', 'ensure']) await t.test(mode, async t => {
    const reached = gate(); let ownSignal, closed = false
    const f = await fixture(t, { command: async call => {
      if (call.command !== 'aria2c' || call.args.includes('--bt-metadata-only=true')) return
      ownSignal = call.signal; reached.release(); await new Promise((_resolve, reject) => call.signal.addEventListener('abort', () => { closed = true; reject(new Error('synthetic native process closed')) }, { once: true })); return true
    } })
    const outcome = rejected(f.prepare()); await bounded(reached.promise)
    if (mode === 'signal') f.controller.abort(); else if (mode === 'current') f.setCurrent(false); else f.setEnsure(false)
    await outcome; assert.equal(ownSignal.aborted, true); assert.equal(closed, true); assert.equal(f.commands.some(call => call.command === 'zip'), false); await f.clean()
  })
})

test('one provider rejects concurrent work, native timeouts stop before ZIP, and subsequent work can recover', async t => {
  let hold = true; const reached = gate()
  const f = await fixture(t, { provider: { downloadTimeoutMs: 30 }, command: async call => {
    if (call.command !== 'aria2c' || call.args.includes('--bt-metadata-only=true') || !hold) return
    reached.release(); await new Promise((_resolve, reject) => call.signal.addEventListener('abort', () => reject(new Error('synthetic timeout')), { once: true })); return true
  } })
  const outcome = rejected(f.prepare()); await bounded(reached.promise); await rejected(f.prepare()); await outcome; await f.clean()
  hold = false; assert.equal((await f.prepare()).status, 'ready'); await f.clean()
})

test('archive cancellation waits for the native zip to close before removing the private run', async t => {
  const reached = gate(); let closed = false
  const f = await fixture(t, { command: async call => {
    if (call.command !== 'zip') return
    reached.release(); await new Promise((_resolve, reject) => call.signal.addEventListener('abort', () => { closed = true; reject(new Error('synthetic zip closed')) }, { once: true })); return true
  } })
  const outcome = rejected(f.prepare()); await bounded(reached.promise); f.controller.abort(); await outcome; assert.equal(closed, true); await f.clean()
})

test('a shortened working-directory quota stops payload before any native download can start', async t => {
  const f = await fixture(t, { provider: { maxWorkingBytes: 1 } }); await rejected(f.prepare()); assert.equal(f.commands.length, 0); await f.clean()
})

test('HTTPS cache transport rejects private or mismatched DNS families before requests and rechecks redirect targets', async t => {
  for (const answers of [[{ address: '127.0.0.1', family: 4 }], [{ address: '8.8.8.8', family: 6 }], [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]]) await t.test(JSON.stringify(answers), async () => {
    let requested = false
    const own = torrentGuard(context(), 1000), http = createTorrentHttp({ lookup: async () => answers, request: async () => { requested = true; return response(Buffer.from('x')) } })
    try { await rejected(http(torrentCacheUrls('A'.repeat(40))[0], 'A'.repeat(40), own)); assert.equal(requested, false) } finally { own.close() }
  })
  for (const target of ['https://127.0.0.1/x', 'https://itorrents.net.evil.test/x', 'https://user@itorrents.net/torrent/X.torrent', 'http://itorrents.net/torrent/X.torrent', 'https://itorrents.net/torrent/../x']) await t.test(target, async () => {
    let requests = 0; const own = torrentGuard(context(), 1000), hash = 'A'.repeat(40)
    const http = createTorrentHttp({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], request: async () => { requests++; return { status: 302, headers: { location: target }, body: Buffer.from('') } } })
    try { await rejected(http(torrentCacheUrls(hash)[0], hash, own)); assert.equal(requests, 1) } finally { own.close() }
  })
})

test('a hanging cache stream is closed on cancellation and its late bytes cannot start native work', async t => {
  const reached = gate(), held = gate(); let closed = 0
  t.after(() => held.release())
  const f = await fixture(t, { request: () => ({ status: 200, headers: {}, body: (async function* () { reached.release(); await held.promise; yield Buffer.from('late') })(), close() { closed++ } }) })
  const outcome = rejected(f.prepare()); await bounded(reached.promise); f.controller.abort(); await outcome
  assert.equal(closed, 1); assert.equal(f.commands.length, 0); await f.clean(); held.release()
})

test('native cache HTTPS pins the validated address and IP family without another DNS request', async () => {
  const original = https.request; let captured, pinned
  https.request = (_url, options, callback) => {
    captured = options
    const request = new EventEmitter(), response = new EventEmitter()
    response.statusCode = 200; response.headers = {}; response.destroy = () => {}; request.destroy = () => {}
    request.end = () => callback(response)
    options.lookup('itorrents.net', {}, (_error, address, family) => { pinned = { address, family } })
    return request
  }
  try {
    const result = await nativeAgentTorrentRequest(new URL(torrentCacheUrls('A'.repeat(40))[0]), { address: '2606:4700:4700::1111', family: 6 }, new AbortController().signal, { maxBytes: 2 * 1024 * 1024 })
    assert.deepEqual(pinned, { address: '2606:4700:4700::1111', family: 6 }); assert.equal(captured.family, 6); assert.equal(captured.headers['Accept-Encoding'], 'identity'); await result.close()
  } finally { https.request = original }
})

test('the fixed native zip command produces verifiable Unicode archives locally without any P2P activity', { skip: spawnSync('zip', ['-v'], { stdio: 'ignore' }).status !== 0 }, async t => {
  const f = await fixture(t, { files: [{ name: ['-中文.txt'], bytes: Buffer.from('safe') }], command: async call => {
    if (call.command === 'zip') { await nativeAgentTorrentCommand('zip', call.args, call); return true }
  } })
  assert.equal((await f.prepare()).status, 'ready'); await f.clean()
})

test('configured host secrets cannot become metadata or errors', async t => {
  const files = [{ name: ['HOST_PRIVATE_KEY.bin'], bytes: Buffer.from('safe') }], f = await fixture(t, { files, provider: { secrets: ['HOST_PRIVATE_KEY'] } })
  await rejected(f.prepare()); assert.equal(f.commands.length, 0); await f.clean()
})
