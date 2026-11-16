import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentVoiceTool, sanitizeAgentVoiceText } from '../dist/backend/modules/media/infrastructure/agentVoiceTool.js'

const SECRET = 'voice-service-private-token-12345'
const HOST_SECRET = 'host-private-voice-test-67890/+='
const config = { enabled: true, appId: 'app', accessToken: SECRET, resourceId: 'resource', voiceType: 'speaker', format: 'wav' }
const wav = Buffer.alloc(204)
wav.write('RIFF'); wav.writeUInt32LE(196, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16)
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28)
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(160, 40)
function fixture(settings = {}, options = {}, overrides = {}) {
  const requests = [], sent = [], checks = []
  const controller = new AbortController()
  const context = { binding: { id: 'binding', agentId: 'agent', revision: 'revision', target: { account: { platform: 'fixture', namespace: 'fixture', id: 'bot' }, kind: 'group', id: 'target' } },
    actor: { kind: 'user', user: { platform: 'fixture', namespace: 'fixture', id: 'peer' } },
    request: { messageId: 'request', text: '请发条语音', mentions: [] }, signal: controller.signal, isCurrent: () => true,
    persona: { name: '甲', version: 'v1', aliases: ['账号别名'] },
    async ensureCurrent() { checks.push('ensure') }, async sendAudio(audio) { sent.push(audio); return { state: 'sent', messageId: 'confirmed-audio-id' } }, ...overrides }
  const tool = createAgentVoiceTool({ ...config, ...settings }, { secrets: [HOST_SECRET],
    async fetchImpl(url, init) { requests.push({ url, init, body: JSON.parse(init.body) }); return new Response(wav, { headers: { 'content-type': 'audio/wav' } }) }, ...options })
  return { tool, context, controller, requests, sent, checks, execute: input => tool.execute(input, context) }
}

test('voice keeps its original name, only text/style inputs and bounded synthesis/delivery deadline', async () => {
  const f = fixture()
  assert.equal(f.tool.name, 'voiceTool')
  assert.deepEqual(Object.keys(f.tool.parameters.properties), ['text', 'style'])
  assert.equal(f.tool.parameters.additionalProperties, false)
  assert.equal(f.tool.timeoutMs, 215000)
  assert.equal(f.tool.parameters.properties.style.maxLength, 40)
  assert.equal((await f.execute({ text: '你好' })).status, 'succeeded')
  assert.ok(f.checks.length >= 4)
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].spokenText, '你好')
  assert.equal(f.sent[0].mime, 'audio/wav')
  assert.equal(f.sent[0].base64, wav.toString('base64'))
})

test('default short speech cleanup preserves 80 Unicode characters and host may configure 8–300', async () => {
  assert.equal(sanitizeAgentVoiceText('[CQ:at,qq=1] **希洛** `console.log(1)` ![图](http://x) 你好呀', 12), '希洛 console.l')
  for (const [settings, expected] of [[{}, 80], [{ maxTextLength: 12 }, 12], [{ maxTextLength: 300 }, 300]]) {
    const f = fixture(settings)
    await f.execute({ text: '😀'.repeat(400) })
    assert.equal([...f.requests[0].body.req_params.text].length, expected)
    assert.equal(f.requests[0].body.req_params.text.includes('\ufffd'), false)
  }
})

test('default styles auto-select, explicit styles win, custom styles work and unknown styles use normal', async () => {
  const f = fixture({ styles: { normal: { volumeRatio: .8 }, narration: { speedRatio: 1.2, prompt: '主持人' }, shy: { emotion: 'custom-shy' } } })
  await f.execute({ text: '不好意思啦' })
  assert.deepEqual(f.requests[0].body.req_params.audio_params, { format: 'wav', sample_rate: 24000, speech_rate: .94, pitch_rate: 1.03, volume_ratio: .8 })
  assert.equal(f.requests[0].body.req_params.additions.emotion, 'custom-shy')
  await f.execute({ text: '认真解释原因', style: 'sleepy' })
  assert.equal(f.requests[1].body.req_params.audio_params.speech_rate, .9)
  await f.execute({ text: '你好', style: 'narration' })
  assert.equal(f.requests[2].body.req_params.audio_params.speech_rate, 1.2)
  assert.equal(f.requests[2].body.req_params.additions.style, '主持人')
  for (const style of ['missing', '__proto__', 'constructor']) {
    await f.execute({ text: '你好', style })
    assert.deepEqual(f.requests.at(-1).body.req_params.audio_params, { format: 'wav', sample_rate: 24000, volume_ratio: .8 })
  }
})

test('disabled, missing capabilities and invalid inputs never contact the provider', async () => {
  const invalid = [null, [], {}, { text: ' ' }, { text: 1 }, { text: 'x'.repeat(12001) }, { text: 'x\u0000' }, { text: 'hello', style: [] },
    { text: 'hello', style: 'x'.repeat(41) }, { text: 'hello', style: 'normal\n' }, { text: 'hello', endpoint: 'https://other.test' },
    { text: 'hello', target: 'other' }, { text: 'hello', voiceType: 'other' }, { text: 'hello', file: '/private/path' },
  ]
  for (const input of invalid) {
    const f = fixture(); assert.equal((await f.execute(input)).status, 'failed'); assert.equal(f.requests.length, 0); assert.equal(f.sent.length, 0)
  }
  const getter = Object.defineProperty({}, 'text', { get() { throw new Error('should not read') } })
  assert.equal((await fixture().execute(getter)).status, 'failed')
  for (const f of [fixture({ enabled: false }), fixture({}, {}, { sendAudio: undefined })]) {
    assert.equal((await f.execute({ text: 'hello' })).status, 'failed'); assert.equal(f.requests.length, 0)
  }
})

test('host credentials in raw/JSON/Unicode/percent/Base64 text and forbidden speech are blocked before HTTP', async () => {
  const variants = [SECRET, HOST_SECRET, JSON.stringify(HOST_SECRET).slice(1, -1), encodeURIComponent(HOST_SECRET),
    Buffer.from(HOST_SECRET).toString('base64'), Buffer.from(HOST_SECRET).toString('base64url'),
    [...HOST_SECRET].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')]
  for (const text of [...variants, 'blocked']) {
    const f = fixture({}, { allowsText: value => !value.includes('blocked') })
    assert.equal((await f.execute({ text })).status, 'failed'); assert.equal(f.requests.length, 0); assert.equal(f.sent.length, 0)
  }
  const f = fixture({}, { allowsText: value => value !== '叫我甲就好。' })
  assert.equal((await f.execute({ text: '欸，别突然这么叫呀，有点不好意思啦。' })).status, 'failed')
  assert.equal(f.requests.length, 0)
})

test('guard runs before speech cleanup with captured persona/guard, missing guard keeps defaults and aliases work', async () => {
  const f = fixture({}, {}, { persona: { name: '甲', version: 'v1', aliases: ['账号别名'] },
    async ensureCurrent() { f.context.persona.name = '乙'; f.context.persona.guard = { enabled: false } } })
  await f.execute({ text: '欸，别突然这么叫呀，有点不好意思啦。' })
  assert.equal(f.sent[0].spokenText, '叫我甲就好。')
  const disabled = fixture({}, {}, { persona: { name: '甲', version: 'v1', guard: { enabled: false } } })
  await disabled.execute({ text: '作为AI，很抱歉，你好。' })
  assert.equal(disabled.sent[0].spokenText, '作为AI，很抱歉，你好。')
  const alias = fixture({}, {}, { request: { messageId: 'r', text: '账号别名是不是机器人', mentions: [] } })
  await alias.execute({ text: '我才不是机器人！' })
  assert.doesNotMatch(alias.sent[0].spokenText, /不是机器人/u)
})


test('confirmed sent receipts expose their ID without repeating spoken text or raw bytes', async () => {
  const f = fixture()
  const result = await f.execute({ text: '这是唯一口播验收内容' })
  assert.equal(result.status, 'succeeded')
  assert.match(result.content, /confirmed-audio-id/u)
  assert.doesNotMatch(result.content, /这是唯一口播验收内容|UklGR|private-token/u)
})

test('unknown/missing-ID/throwing/hung send dispatch once and never retry or repeat speech', async () => {
  for (const mode of ['unknown', 'missing-id', 'throw', 'hung', 'failed']) {
    let sends = 0
    const f = fixture({}, { timeoutMs: 25 }, { async sendAudio() {
      sends++
      if (mode === 'throw') throw new Error(SECRET)
      if (mode === 'hung') return new Promise(() => {})
      return mode === 'missing-id' ? { state: 'sent' } : { state: mode }
    } })
    const keepAlive = setTimeout(() => {}, 1000)
    try {
      const result = await f.execute({ text: '不要重复的口播内容' })
      assert.equal(result.status, mode === 'failed' ? 'failed' : 'unknown'); assert.equal(sends, 1); assert.equal(f.requests.length, 1)
      assert.doesNotMatch(result.content, /不要重复的口播内容|private-token/u)
    } finally { clearTimeout(keepAlive) }
  }
})

test('revoked/aborted synthesis and provider failures stay private and never send', async () => {
  let current = true
  const revoked = fixture({}, { fetchImpl: async () => { current = false; return new Response(wav, { headers: { 'content-type': 'audio/wav' } }) } }, { isCurrent: () => current })
  assert.equal((await revoked.execute({ text: 'hello' })).status, 'failed'); assert.equal(revoked.sent.length, 0)
  const aborted = fixture(); aborted.controller.abort()
  assert.equal((await aborted.execute({ text: 'hello' })).status, 'failed'); assert.equal(aborted.requests.length, 0)
  for (const fetchImpl of [async () => { throw new Error(SECRET) }, async () => new Response(SECRET, { status: 403 }), () => new Promise(() => {})]) {
    const f = fixture({}, { fetchImpl, timeoutMs: 20 })
    const keepAlive = setTimeout(() => {}, 1000)
    try { const result = await f.execute({ text: 'hello' }); assert.equal(result.status, 'failed'); assert.equal(f.sent.length, 0); assert.doesNotMatch(result.content, /private-token|403/u) }
    finally { clearTimeout(keepAlive) }
  }
})
