import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http, { createServer } from 'node:http'
import test from 'node:test'
import { createAgentMusicExtractionProvider, parseNeteaseMusicLink, validateAgentMusicShare } from '../dist/backend/modules/media/infrastructure/agentMusicExtractionProvider.js'

const SECRET = 'music-extraction-host-private-token-123/+='
const ADDRESS = { address: '8.8.8.8', family: 4 }
const WAV = Buffer.alloc(204)
WAV.write('RIFF'); WAV.writeUInt32LE(196, 4); WAV.write('WAVEfmt ', 8); WAV.writeUInt32LE(16, 16)
WAV.writeUInt16LE(1, 20); WAV.writeUInt16LE(1, 22); WAV.writeUInt32LE(8000, 24); WAV.writeUInt32LE(16000, 28)
WAV.writeUInt16LE(2, 32); WAV.writeUInt16LE(16, 34); WAV.write('data', 36); WAV.writeUInt32LE(160, 40)
const songShare = { provider: 'netease', reference: { kind: 'song', id: '123456' } }
const programShare = { provider: 'netease', reference: { kind: 'program', id: '654321' } }
const directShare = { provider: 'netease', reference: { kind: 'audio', url: 'https://m8.music.126.net/media/song.wav' }, title: '完整音乐', artist: '艺术家' }
const context = overrides => ({ signal: new AbortController().signal, isCurrent: () => true, async ensureCurrent() {}, ...overrides })
const json = value => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
const audio = () => ({ status: 200, headers: { 'content-type': 'audio/wav', 'content-length': String(WAV.length) }, body: WAV })
function fixture(options = {}) {
  const lookups = [], requests = []
  const provider = createAgentMusicExtractionProvider({ secrets: [SECRET], async lookup(hostname) { lookups.push(hostname); return [ADDRESS] },
    async request(url, address, signal, policy) {
      requests.push({ url: url.href, address, signal, policy })
      if (url.pathname === '/api/song/detail/') return json({ code: 200, songs: [{ id: 123456, name: '歌曲名称', artists: [{ name: '甲' }, { name: '乙' }] }] })
      if (url.pathname === '/api/dj/program/detail') return json({ code: 200, program: { name: '电台节目', dj: { nickname: '主播' }, mainSong: { id: 987654, name: '节目主音频' } } })
      return audio()
    }, ...options })
  return { provider, lookups, requests }
}

test('parser recognizes only plain official song/dj links and returns frozen closed references', () => {
  assert.deepEqual(parseNeteaseMusicLink('提取 https://music.163.com/song?id=123456&userid=555。'), songShare)
  assert.deepEqual(parseNeteaseMusicLink('https://y.music.163.com/dj?id=654321'), programShare)
  for (const text of ['https://music.163.com/#/song?id=123456', 'https://163cn.tv/short', 'https://music.163.com/playlist?id=123456',
    'https://music.163.com/song?id=123456#hash', 'https://music.163.com/song?id=123&id=456', 'https://evil.test/song?id=123',
    'https://music.163.com:443/song?id=123', 'https://music.163.com/song?id=../private']) assert.equal(parseNeteaseMusicLink(text), undefined)
  const parsed = parseNeteaseMusicLink('https://music.163.com/song?id=1')
  assert.ok(Object.isFrozen(parsed)); assert.ok(Object.isFrozen(parsed.reference))
})

test('share validator excludes getters, unknown fields, unsupported references and unsafe official URL spelling', () => {
  assert.deepEqual(validateAgentMusicShare(directShare), directShare)
  const invalid = [null, [], { ...songShare, provider: 'qq' }, { ...songShare, target: 'other' }, { ...songShare, title: 'x'.repeat(301) },
    { ...songShare, artist: 'bad\u0000' }, { ...songShare, reference: { kind: 'song', id: '1', url: 'https://music.163.com' } },
    { ...songShare, reference: { kind: 'song', id: '../private' } }, { ...songShare, reference: { kind: 'audio', url: directShare.reference.url, id: '1' } }]
  for (const value of invalid) assert.throws(() => validateAgentMusicShare(value))
  for (const url of ['http://127.0.0.1/a', 'https://user:pass@music.163.com/a', 'https://music.163.com:443/a', 'file:///private/audio',
    'https://music.163.com.evil.test/a', 'https://music.126.net/a', 'https://music.163.com/a#fragment', 'https://music.163.com/a\\b',
    'https://music.163.com/%2fprivate', 'https://music.163.com/a%0dInjected', 'https://music.163.com/a/%2e%2e/private', 'https://music.163.com/a/../private']) {
    assert.throws(() => validateAgentMusicShare({ provider: 'netease', reference: { kind: 'audio', url } }))
  }
  const getter = Object.defineProperty({}, 'provider', { get() { throw new Error(SECRET) } })
  assert.throws(() => validateAgentMusicShare(getter), error => !error.message.includes(SECRET))
})

test('song detail protocol produces one complete downloadable attachment and identical playable bytes', async () => {
  const f = fixture()
  const result = await f.provider.prepare(songShare, context())
  assert.equal(f.requests.length, 2)
  assert.equal(f.requests[0].url, 'https://music.163.com/api/song/detail/?ids=[123456]')
  assert.equal(f.requests[1].url, 'https://music.163.com/song/media/outer/url?id=123456')
  assert.equal(f.requests[0].policy.maxBytes, 2 * 1024 * 1024); assert.equal(f.requests[1].policy.maxBytes, 20 * 1024 * 1024)
  assert.equal(result.title, '歌曲名称'); assert.equal(result.artist, '甲/乙')
  assert.equal(result.attachment.name, '歌曲名称-甲 乙.wav')
  assert.equal(result.attachment.mime, 'audio/wav'); assert.equal(result.audio.mime, 'audio/wav')
  assert.equal(result.attachment.base64, WAV.toString('base64')); assert.equal(result.audio.base64, result.attachment.base64)
  assert.deepEqual(Object.keys(result.attachment), ['name', 'mime', 'base64'])
  assert.ok(f.requests.every(call => call.address === ADDRESS && call.signal instanceof AbortSignal))
})

test('program uses mainSong and DJ fallback, direct official musicUrl requires no metadata request', async () => {
  const f = fixture()
  const program = await f.provider.prepare(programShare, context())
  assert.equal(f.requests[0].url, 'https://music.163.com/api/dj/program/detail?id=654321')
  assert.equal(f.requests[1].url, 'https://music.163.com/song/media/outer/url?id=987654')
  assert.equal(program.title, '节目主音频'); assert.equal(program.artist, '主播')
  const direct = fixture()
  const result = await direct.provider.prepare(directShare, context())
  assert.equal(direct.requests.length, 1); assert.equal(direct.requests[0].url, directShare.reference.url)
  assert.equal(result.title, '完整音乐'); assert.equal(result.artist, '艺术家')
})

test('all DNS results must be public and family-consistent before a pinned request is allowed', async () => {
  for (const addresses of [[], [ADDRESS, { address: '127.0.0.1', family: 4 }], [{ address: '10.0.0.8', family: 4 }],
    [{ address: '169.254.169.254', family: 4 }], [{ address: '::1', family: 6 }], [{ address: '::ffff:8.8.8.8', family: 6 }], [{ address: '8.8.8.8', family: 6 }]]) {
    let requests = 0
    const f = fixture({ lookup: async () => addresses, request: async () => { requests++; return audio() } })
    await assert.rejects(f.provider.prepare(directShare, context())); assert.equal(requests, 0)
  }
  const publicV6 = { address: '2606:4700:4700::1111', family: 6 }
  let address
  const f = fixture({ lookup: async () => [publicV6, ADDRESS], request: async (_url, pinned) => { address = pinned; return audio() } })
  await f.provider.prepare(directShare, context()); assert.equal(address, publicV6)
})

test('redirects resolve and validate every official hop with a maximum of three transitions', async () => {
  const lookups = [], requests = []
  const f = fixture({ lookup: async host => { lookups.push(host); return [ADDRESS] }, request: async (url, address, signal) => {
    requests.push({ url: url.href, address, signal })
    const hop = Number(url.searchParams.get('hop') ?? 0)
    return hop < 3 ? { status: 302, headers: { location: `https://m${hop + 1}.music.126.net/song.wav?hop=${hop + 1}` }, body: '' } : audio()
  } })
  await f.provider.prepare(directShare, context())
  assert.equal(requests.length, 4); assert.deepEqual(lookups, ['m8.music.126.net', 'm1.music.126.net', 'm2.music.126.net', 'm3.music.126.net'])
  let calls = 0
  const loop = fixture({ request: async () => { calls++; return { status: 302, headers: { location: '/same.wav' }, body: '' } } })
  await assert.rejects(loop.provider.prepare(directShare, context())); assert.equal(calls, 4)
})

test('unsafe redirect targets and private DNS at a later hop are rejected before that hop receives a request', async () => {
  for (const location of ['https://evil.test/song.wav', 'http://127.0.0.1/audio', 'https://user:pass@music.163.com/audio',
    'https://music.163.com:443/audio', '//music.163.com:443/audio', 'https://m8.music.126.net/a%2fb', '/audio%0dHeader', '/audio\\private']) {
    let calls = 0
    const f = fixture({ request: async () => { calls++; return { status: 302, headers: { location }, body: '' } } })
    await assert.rejects(f.provider.prepare(directShare, context())); assert.equal(calls, 1)
  }
  let calls = 0
  const f = fixture({ lookup: async host => host === 'music.163.com' ? [{ address: '192.168.0.8', family: 4 }] : [ADDRESS],
    request: async () => { calls++; return { status: 302, headers: { location: 'https://music.163.com/audio.wav' }, body: '' } } })
  await assert.rejects(f.provider.prepare(directShare, context())); assert.equal(calls, 1)
})

test('metadata and audio enforce separate byte caps, reject compressed/error/empty bodies', async () => {
  for (const response of [{ status: 200, headers: { 'content-length': String(2 * 1024 * 1024 + 1) }, body: '{}' },
    { status: 200, headers: {}, body: 'x'.repeat(2 * 1024 * 1024 + 1) }, { status: 500, headers: {}, body: SECRET }]) {
    const f = fixture({ request: async () => response }); await assert.rejects(f.provider.prepare(songShare, context()), error => !error.message.includes(SECRET))
  }
  for (const response of [{ ...audio(), headers: { 'content-type': 'audio/wav', 'content-length': String(20 * 1024 * 1024 + 1) } },
    { ...audio(), body: Buffer.alloc(20 * 1024 * 1024 + 1) }, { ...audio(), headers: { 'content-type': 'audio/wav', 'content-encoding': 'gzip' } },
    { ...audio(), body: Buffer.alloc(0) }, { ...audio(), headers: { 'content-type': 'audio/wav', 'content-length': '-1' } }]) {
    const f = fixture({ request: async () => response }); await assert.rejects(f.provider.prepare(directShare, context()))
  }
})

test('declared audio MIME must match a supported real header; HTML, octet-stream and corrupt audio never become files', async () => {
  for (const response of [{ ...audio(), headers: { 'content-type': 'text/html' } }, { ...audio(), headers: { 'content-type': 'application/octet-stream' } },
    { ...audio(), headers: { 'content-type': 'audio/mpeg' } }, { ...audio(), body: Buffer.from('not audio') }]) {
    const f = fixture({ request: async () => response }); await assert.rejects(f.provider.prepare(directShare, context()))
  }
  const aliases = fixture({ request: async () => ({ ...audio(), headers: { 'content-type': 'audio/x-wav; charset=binary' } }) })
  assert.equal((await aliases.provider.prepare(directShare, context())).attachment.mime, 'audio/wav')
})

test('raw and common encoded host credentials in titles, artists, URLs or metadata stop extraction', async () => {
  for (const secret of [SECRET, encodeURIComponent(SECRET), Buffer.from(SECRET).toString('base64'), Buffer.from(SECRET).toString('base64url'),
    [...SECRET].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')]) {
    for (const share of [{ ...directShare, title: secret }, { ...directShare, artist: secret },
      { ...directShare, reference: { kind: 'audio', url: `https://m8.music.126.net/song.wav?value=${secret}` } }]) {
      const f = fixture(); await assert.rejects(f.provider.prepare(share, context())); assert.equal(f.requests.length, 0)
    }
    let calls = 0
    const f = fixture({ request: async () => { calls++; return json({ code: 200, songs: [{ id: 123456, name: '名称' }], metadata: { secret } }) } })
    await assert.rejects(f.provider.prepare(songShare, context())); assert.equal(calls, 1)
  }
  const forbidden = fixture({ allowsText: value => !value.includes('blocked') })
  await assert.rejects(forbidden.provider.prepare({ ...directShare, title: 'blocked' }, context())); assert.equal(forbidden.requests.length, 0)
})

test('metadata schema, returned song identity and depth errors never trigger a download', async () => {
  let deep = {}; for (let index = 0; index < 20; index++) deep = { deep }
  for (const payload of [{ code: 500 }, { code: 200, songs: [] }, { code: 200, songs: [{ id: 999999, name: 'wrong song' }] },
    { code: 200, songs: [{ id: 123456, name: 'ok' }], deep }]) {
    let calls = 0
    const f = fixture({ request: async () => { calls++; return json(payload) } })
    await assert.rejects(f.provider.prepare(songShare, context())); assert.equal(calls, 1)
  }
})

test('caller cancellation and revoked authorization block initial lookup and late metadata cannot start audio download', async () => {
  const cancelled = new AbortController(); cancelled.abort(new Error(SECRET))
  const before = fixture(); await assert.rejects(before.provider.prepare(songShare, context({ signal: cancelled.signal })), error => !error.message.includes(SECRET)); assert.equal(before.lookups.length, 0)
  const revoked = fixture(); await assert.rejects(revoked.provider.prepare(songShare, context({ isCurrent: () => false }))); assert.equal(revoked.lookups.length, 0)
  let finish, calls = 0
  const controller = new AbortController()
  const f = fixture({ request: async () => { calls++; return await new Promise(resolve => { finish = resolve }) } })
  const operation = f.provider.prepare(songShare, context({ signal: controller.signal }))
  const rejected = assert.rejects(operation)
  for (let index = 0; index < 10 && !finish; index++) await new Promise(resolve => setImmediate(resolve))
  controller.abort(); await rejected
  finish(json({ code: 200, songs: [{ id: 123456, name: 'late' }] }))
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1)
})

test('metadata/entire deadlines bound hung lookup and requests, and reauthorize after each network stage', async () => {
  for (const options of [{ lookup: () => new Promise(() => {}), timeoutMs: 20 }, { request: () => new Promise(() => {}), metadataTimeoutMs: 20 },
    { request: () => new Promise(() => {}), timeoutMs: 20 }]) {
    const keepAlive = setTimeout(() => {}, 1000)
    try { await assert.rejects(fixture(options).provider.prepare(options.metadataTimeoutMs ? songShare : directShare, context())) }
    finally { clearTimeout(keepAlive) }
  }
  let current = true, calls = 0
  const f = fixture({ request: async () => { calls++; current = false; return json({ code: 200, songs: [{ id: 123456, name: 'revoked' }] }) } })
  await assert.rejects(f.provider.prepare(songShare, context({ isCurrent: () => current }))); assert.equal(calls, 1)
})

test('Unicode names remain intact and safe downloadable filenames are bounded without local paths', async () => {
  const f = fixture()
  const result = await f.provider.prepare({ ...directShare, title: '😀'.repeat(100), artist: '/恶意:*?<>|'.repeat(20) }, context())
  assert.equal(result.title, '😀'.repeat(100))
  assert.ok(Buffer.byteLength(result.attachment.name) <= 224); assert.ok(!/[\\/:*?"<>|]/u.test(result.attachment.name))
  assert.equal(result.attachment.name.includes('\ufffd'), false)
  assert.match(result.attachment.name, /\.wav$/u)
  assert.doesNotMatch(JSON.stringify(Object.keys(result)), /filePath|sourceUrl|tempDir/u)
})

test('native HTTP connector pins lookup, disables pooling, omits credentials and enforces declared/chunked caps', async () => {
  const original = http.request
  let mode = 'valid', destroyed = 0, starts = 0
  http.request = (url, init, callback) => {
    starts++
    assert.equal(url.hostname, 'm8.music.126.net'); assert.equal(init.agent, false)
    assert.equal(init.family, ADDRESS.family, 'pinning the family disables Node autoSelectFamily lookup-all semantics')
    assert.ok(init.signal instanceof AbortSignal); assert.equal(init.headers['Accept-Encoding'], 'identity')
    assert.equal(init.headers.Cookie, undefined); assert.equal(init.headers.Authorization, undefined)
    init.lookup('untrusted-resolve-again', {}, (error, address, family) => {
      assert.equal(error, null); assert.equal(address, ADDRESS.address); assert.equal(family, ADDRESS.family)
    })
    const req = new EventEmitter()
    req.end = () => queueMicrotask(() => {
      const response = new EventEmitter()
      response.statusCode = 200; response.headers = { 'content-type': 'audio/wav', ...(mode === 'declared' ? { 'content-length': String(20 * 1024 * 1024 + 1) } : {}) }
      response.destroy = error => { destroyed++; if (error) queueMicrotask(() => response.emit('error', error)) }
      callback(response)
      if (mode === 'declared') return
      if (mode === 'chunked') { response.emit('data', Buffer.alloc(20 * 1024 * 1024)); response.emit('data', Buffer.alloc(1)); return }
      response.emit('data', WAV); response.emit('end')
    })
    return req
  }
  try {
    const provider = createAgentMusicExtractionProvider({ lookup: async () => [ADDRESS] })
    const share = { ...directShare, reference: { kind: 'audio', url: 'http://m8.music.126.net/song.wav' } }
    assert.equal((await provider.prepare(share, context())).audio.base64, WAV.toString('base64'))
    for (mode of ['declared', 'chunked']) await assert.rejects(provider.prepare(share, context()))
    assert.equal(starts, 3); assert.equal(destroyed, 2)
  } finally { http.request = original }
})

test('native Node HTTP completes a real response using the pinned single-address lookup contract', async t => {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'audio/wav'); response.end(WAV)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const original = http.request
  let lookups = 0
  http.request = (url, init, callback) => {
    assert.equal(init.family, 4, 'Node must not request an array from a scalar pinned lookup')
    const local = new URL(url); local.port = String(server.address().port)
    return original(local, { ...init, lookup(hostname, options, done) {
      lookups++
      assert.equal(options.all, undefined, 'the actual Node connector keeps the single-address lookup contract')
      init.lookup(hostname, options, (error, address, family) => {
        assert.equal(error, null); assert.equal(address, ADDRESS.address); assert.equal(family, ADDRESS.family)
        // Only the final socket destination changes; Node itself invokes the real pinned lookup.
        done(null, '127.0.0.1', family)
      })
    } }, callback)
  }
  try {
    const provider = createAgentMusicExtractionProvider({ lookup: async () => [ADDRESS] })
    const share = { ...directShare, reference: { kind: 'audio', url: 'http://m8.music.126.net/song.wav' } }
    assert.equal((await provider.prepare(share, context())).audio.base64, WAV.toString('base64'))
    assert.equal(lookups, 1)
  } finally { http.request = original }
})
