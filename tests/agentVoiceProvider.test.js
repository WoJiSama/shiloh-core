import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { buildAgentVoiceRequest, createAgentVoiceProvider, parseAgentVoiceAudio } from '../dist/backend/modules/media/infrastructure/agentVoiceProvider.js'

const SECRET = 'voice-provider-private-key-12345'
const AUTH = 'voice-optional-bearer-private-67890'
const config = { enabled: true, appId: 'fixture-app', accessToken: SECRET, resourceId: 'fixture-resource', voiceType: 'fixture-voice', format: 'wav' }
function wav() {
  const result = Buffer.alloc(204)
  result.write('RIFF', 0); result.writeUInt32LE(result.length - 8, 4); result.write('WAVEfmt ', 8)
  result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22)
  result.writeUInt32LE(8000, 24); result.writeUInt32LE(16000, 28); result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34)
  result.write('data', 36); result.writeUInt32LE(160, 40)
  return result
}
const WAV = wav()
const audio = { mime: 'audio/wav', base64: WAV.toString('base64') }
const context = overrides => ({ signal: new AbortController().signal, isCurrent: () => true, async ensureCurrent() {}, ...overrides })
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
const frame = value => `data: ${JSON.stringify(value)}\n\n`
async function localServer(handler, work) {
  const server = http.createServer(handler)
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try { await work(`http://127.0.0.1:${server.address().port}`) }
  finally { server.close(); server.closeAllConnections(); await once(server, 'close') }
}

test('V3 request keeps credentials in headers and applies trusted per-style speaker/resource/audio overrides', () => {
  const request = buildAgentVoiceRequest({ ...config, authorization: AUTH, sampleRate: 24000, speedRatio: 1.1, stylePrompt: '默认风格' }, {
    text: '你好', style: { voiceType: 'style-voice', resourceId: 'style-resource', format: 'ogg', sampleRate: 16000, speedRatio: .94, pitchRatio: 1.03, volumeRatio: .8, emotion: 'shy', prompt: '轻声' }
  })
  assert.equal(request.endpoint, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional')
  assert.equal(request.mime, 'audio/ogg')
  assert.equal(request.headers['X-Api-App-Id'], 'fixture-app')
  assert.equal(request.headers['X-Api-Access-Key'], SECRET)
  assert.equal(request.headers['X-Api-Resource-Id'], 'style-resource')
  assert.equal(request.headers.Authorization, `Bearer ${AUTH}`)
  assert.match(request.headers['X-Api-Connect-Id'], /^[0-9a-f-]{36}$/u)
  assert.deepEqual(request.body.req_params, { text: '你好', speaker: 'style-voice', audio_params: {
    format: 'ogg', sample_rate: 16000, speech_rate: .94, pitch_rate: 1.03, volume_ratio: .8
  }, additions: { emotion: 'shy', style: '轻声' } })
  assert.doesNotMatch(JSON.stringify(request.body), /private-key|private-67890/u)
})

test('real localhost HTTP supports raw WAV, split SSE, NDJSON and pretty JSON through exact controlled bytes', async () => {
  const calls = []
  await localServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part)
    calls.push({ headers: req.headers, body: JSON.parse(Buffer.concat(parts).toString()) })
    if (req.url === '/raw') { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(WAV); return }
    const a = { code: 0, data: WAV.subarray(0, 44).toString('base64') }
    const b = { code: 0, audio_data: WAV.subarray(44).toString('base64') }
    const end = { code: 20000000, message: 'finished' }
    const body = req.url === '/sse' ? frame(a) + frame(b) + frame(end) : req.url === '/ndjson' ? [a, b, end].map(value => JSON.stringify(value)).join('\n') : JSON.stringify({ code: 0, data: audio.base64 }, null, 2)
    res.writeHead(200, { 'content-type': req.url === '/sse' ? 'text/event-stream' : req.url === '/ndjson' ? 'application/x-ndjson' : 'application/json' })
    for (const part of [body.slice(0, 17), body.slice(17, 99), body.slice(99)]) res.write(part)
    res.end()
  }, async base => {
    for (const path of ['/raw', '/sse', '/ndjson', '/json']) {
      assert.deepEqual(await createAgentVoiceProvider({ ...config, endpoint: base + path }).synthesize({ text: '本地协议验收' }, context()), audio)
    }
  })
  assert.equal(calls.length, 4)
  assert.equal(calls[0].headers['x-api-access-key'], SECRET)
  assert.equal(calls[0].body.req_params.text, '本地协议验收')
})

test('real HTTP redirect never forwards credentials and non-2xx bodies remain private', async () => {
  let forwarded = 0
  await localServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/leak' }); res.end(); return }
    if (req.url === '/leak') forwarded++
    res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ detail: SECRET + AUTH }))
  }, async base => {
    for (const path of ['/redirect', '/error']) await assert.rejects(createAgentVoiceProvider({ ...config, endpoint: base + path }).synthesize({ text: 'hello' }, context()), error => {
      assert.doesNotMatch(error.message, /private-|127\.0\.0\.1|403/u); return true
    })
  })
  assert.equal(forwarded, 0)
})

test('SSE and NDJSON reject trailing error codes/events even after valid audio or completion', () => {
  const first = { code: 0, data: audio.base64 }
  for (const payload of [frame(first) + frame({ code: 500, message: SECRET }), frame(first) + frame({ error: { message: SECRET } }),
    frame(first) + 'event: error\ndata: {}\n\n', frame(first) + frame({ code: 20000000 }) + frame({ code: 3001 }),
    JSON.stringify(first) + '\n' + JSON.stringify({ status: 'failed', message: SECRET }), frame(first) + 'data: [DONE]\n\n' + frame(first),
  ]) assert.throws(() => parseAgentVoiceAudio(Buffer.from(payload), payload.startsWith('data:') ? 'text/event-stream' : 'application/x-ndjson', 'audio/wav'), error => {
    assert.doesNotMatch(error.message, /private-key|3001|500/u); return true
  })
})

test('only explicit audio slots and canonical Base64 with valid matching audio headers are accepted', () => {
  assert.deepEqual(parseAgentVoiceAudio(Buffer.from(JSON.stringify({ data: { audio_data: audio.base64 } })), 'application/json', 'audio/wav'), audio)
  const bad = [{ metadata: { arbitrary: audio.base64 } }, { data: { nested: { audio_data: audio.base64 } } },
    { audio_data: audio.base64.replace(/=+$/u, '') }, { data: audio.base64 + '\n' }, { data: '!!!!' }, { data: Buffer.from('not audio').toString('base64') },
    { data: audio.base64, audio: audio.base64 }, { code: 1, data: audio.base64 },
  ]
  // This WAV has no Base64 padding; force an unpadded alternate byte count for that case.
  bad[2] = { data: WAV.subarray(0, WAV.length - 1).toString('base64').replace(/=+$/u, '') }
  for (const value of bad) assert.throws(() => parseAgentVoiceAudio(Buffer.from(JSON.stringify(value)), 'application/json', 'audio/wav'))
  for (const [raw, type, mime] of [[WAV, 'audio/mpeg', 'audio/wav'], [WAV, 'audio/wav', 'audio/mpeg'], [Buffer.from('not audio'), 'audio/wav', 'audio/wav'], [WAV, 'text/html', 'audio/wav']]) {
    assert.throws(() => parseAgentVoiceAudio(raw, type, mime))
  }
  assert.throws(() => parseAgentVoiceAudio(Buffer.from(`{"data":"${SECRET}`), 'application/json', 'audio/wav'), error => !error.message.includes(SECRET))
})

test('body budget rejects declared and chunked responses over 20MiB and always cancels their streams', async () => {
  let cancelled = 0
  for (const oversizedHeader of [true, false]) {
    const provider = createAgentVoiceProvider(config, { fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { if (!oversizedHeader) { controller.enqueue(new Uint8Array(20 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)) } },
      cancel() { cancelled++ }
    }), { headers: { 'content-type': 'audio/wav', ...(oversizedHeader ? { 'content-length': String(20 * 1024 * 1024 + 1) } : {}) } }) })
    await assert.rejects(provider.synthesize({ text: 'hello' }, context()))
  }
  assert.equal(cancelled, 2)
})

test('HTTP fetch/body honor deadline and caller abort even when transports do not settle', async () => {
  const pending = () => new Promise(() => {})
  for (const fetchImpl of [pending, async () => new Response(new ReadableStream({ start() {} }))]) {
    const keepAlive = setTimeout(() => {}, 1000)
    try { await assert.rejects(createAgentVoiceProvider(config, { fetchImpl, timeoutMs: 20 }).synthesize({ text: 'hello' }, context())) }
    finally { clearTimeout(keepAlive) }
  }
  let requests = 0
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(createAgentVoiceProvider(config, { fetchImpl: async () => { requests++; return json({ data: audio.base64 }) } }).synthesize({ text: 'hello' }, context({ signal: aborted.signal })))
  assert.equal(requests, 0)
})

test('authorization is checked before HTTP and after body; revoked work yields no usable audio', async () => {
  let requests = 0, current = true, checks = 0
  const provider = createAgentVoiceProvider(config, { fetchImpl: async (_url, init) => {
    requests++; assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal)
    return json({ data: audio.base64 })
  } })
  await assert.rejects(provider.synthesize({ text: 'hello' }, context({ isCurrent: () => false })))
  assert.equal(requests, 0)
  await assert.rejects(provider.synthesize({ text: 'hello' }, context({ isCurrent: () => current, async ensureCurrent() { if (++checks === 2) current = false } })))
  assert.equal(requests, 1)
})

test('invalid trusted configuration rejects before transport without exposing secrets', async () => {
  let requests = 0
  for (const patch of [{ enabled: false }, { provider: 'other' }, { appId: '' }, { accessToken: SECRET + '\nInjected: yes' }, { resourceId: '' },
    { voiceType: '' }, { authorization: AUTH + '\r' }, { format: 'pcm' }, { sampleRate: 48001 }, { speedRatio: 0 }, { pitchRatio: 3 }, { volumeRatio: 5 },
    { endpoint: `file:///tmp/${SECRET}` }, { endpoint: `https://user:${SECRET}@example.test/tts` }, { endpoint: `https://example.test/tts?token=${SECRET}` },
  ]) await assert.rejects(createAgentVoiceProvider({ ...config, ...patch }, { fetchImpl: async () => { requests++; return json({ data: audio.base64 }) } }).synthesize({ text: 'hello' }, context()), error => !error.message.includes(SECRET))
  assert.equal(requests, 0)
})
