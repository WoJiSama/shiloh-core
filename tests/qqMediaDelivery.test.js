import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket, { WebSocketServer } from 'ws'
import { createQqMediaDeliveryPort } from '../dist/backend/adapters/qqMediaDelivery.js'
import { createQqMessageActionPort } from '../dist/backend/adapters/qqMessageDelivery.js'
import { createOneBotConnection } from '../dist/backend/adapters/oneBotConnection.js'
import { validateAgentAudioBytes, validateAgentVideoBytes, validateAgentMedia, MAX_AGENT_AUDIO_BYTES, MAX_AGENT_VIDEO_BYTES } from '../dist/backend/modules/media/infrastructure/agentMediaBytes.js'

const account = { platform: 'qq', namespace: 'global', id: '123456789' }
const target = { account, kind: 'group', id: '315320' }
const binding = { source: 'configured', id: 'media-binding', revision: 'r1', personaId: 'default', agentId: 'alice', connectionId: 'media-local', target }
const silk = Buffer.concat([Buffer.from([2]), Buffer.from('#!SILK_V3'), Buffer.from([1, 0, 10])])
const mp4 = Buffer.from('000000186674797069736f6d0000020069736f6d6d703432000000086d646174', 'hex')
const audio = { kind: 'audio', mime: 'audio/silk', base64: silk.toString('base64'), spokenText: '合成语音正文' }
const video = { kind: 'video', mime: 'video/mp4', base64: mp4.toString('base64') }
const action = (overrides = {}) => ({ version: 1, kind: 'media.send', target, media: audio, ...overrides })
const success = (messageId = 6789) => ({ status: 'ok', retcode: 0, data: { message_id: messageId } })
async function waitFor(probe) {
  const until = Date.now() + 3000
  while (Date.now() < until) { const value = await probe(); if (value) return value; await delay(5) }
  assert.fail('Timed out waiting for media fixture')
}
function direct(response = success()) {
  const calls = []
  const sendMedia = createQqMediaDeliveryPort({ account, connectionId: 'media-local', async sendApi(action, params, options) {
    calls.push({ action, params, options })
    return typeof response === 'function' ? response(action, params, options) : response
  } })
  return { calls, sendMedia }
}
function wave() {
  const value = Buffer.alloc(46)
  value.write('RIFF'); value.writeUInt32LE(38, 4); value.write('WAVEfmt ', 8); value.writeUInt32LE(16, 16)
  value.writeUInt16LE(1, 20); value.writeUInt16LE(1, 22); value.writeUInt32LE(24000, 24)
  value.writeUInt32LE(48000, 28); value.writeUInt16LE(2, 32); value.writeUInt16LE(16, 34)
  value.write('data', 36); value.writeUInt32LE(2, 40)
  return value
}

test('media validators match supported container headers, preserve spoken text and never claim decoding', () => {
  const ogg = Buffer.alloc(48); ogg.write('OggS'); ogg[26] = 1; ogg[27] = 20; ogg.write('OpusHead', 28)
  const flac = Buffer.alloc(45); flac.write('fLaC'); flac.writeUIntBE(34, 5, 3)
  const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0])
  for (const [mime, value] of [['audio/mpeg', mp3], ['audio/wav', wave()], ['audio/ogg', ogg],
    ['audio/flac', flac], ['audio/amr', Buffer.from('#!AMR\n0')], ['audio/amr-wb', Buffer.from('#!AMR-WB\n0')], ['audio/silk', silk]]) {
    const input = { mime, base64: value.toString('base64'), spokenText: '正文' }
    assert.deepEqual(validateAgentAudioBytes(input), input)
    assert.equal(Object.isFrozen(validateAgentAudioBytes(input)), true)
  }
  const quicktime = Buffer.from(mp4); quicktime.write('qt  ', 8)
  const webm = Buffer.from('1a45dfa38b4282847765626d185380670100000000000000', 'hex')
  for (const [mime, value] of [['video/mp4', mp4], ['video/quicktime', quicktime], ['video/webm', webm]]) {
    assert.deepEqual(validateAgentVideoBytes({ mime, base64: value.toString('base64') }), { mime, base64: value.toString('base64') })
  }
  assert.equal(validateAgentMedia(audio).spokenText, audio.spokenText)
  assert.equal(Array.from(validateAgentMedia({ ...audio, spokenText: '🙂'.repeat(300) }).spokenText).length, 300)
})

test('closed plain media parameters deny accessors, arbitrary paths/URLs, target selectors and MIME spoofing', async () => {
  const d = direct()
  for (const media of [
    { ...audio, path: '/etc/passwd' }, { ...audio, url: 'https://example.com/media' }, { ...audio, target }, { ...audio, name: 'voice.silk' },
    { ...audio, base64: '' }, { ...audio, base64: 'YQ' }, { ...audio, base64: 'YR==' }, { ...audio, base64: audio.base64 + '\n' },
    { ...audio, base64: 'base64://' + audio.base64 }, { ...audio, mime: 'audio/wav' }, { ...audio, mime: 'audio/aac' },
    { ...audio, spokenText: 'x'.repeat(301) }, { ...audio, spokenText: 'bad\0text' },
    { ...video, spokenText: 'not video metadata' }, { ...video, mime: 'video/webm' }, { ...video, mime: 'video/avi' },
    { ...audio, base64: Buffer.from('ID3 fake text').toString('base64'), mime: 'audio/mpeg' },
    Object.assign(Object.create({ inherited: true }), audio),
  ]) assert.equal((await d.sendMedia(action({ media }))).state, 'failed')
  let invoked = false
  assert.equal((await d.sendMedia(action({ media: { mime: audio.mime, kind: 'audio', get base64() { invoked = true; return audio.base64 } } }))).state, 'failed')
  const own = { ...audio, [Symbol('hidden')]: 'secret' }
  assert.equal((await d.sendMedia(action({ media: own }))).state, 'failed')
  assert.equal(invoked, false)
  assert.equal(d.calls.length, 0)
})

test('audio 20 MiB and video 30 MiB accept the exact byte limit and reject overflow before dispatch', () => {
  for (const [sample, limit, validate] of [[silk, MAX_AGENT_AUDIO_BYTES, validateAgentAudioBytes], [mp4, MAX_AGENT_VIDEO_BYTES, validateAgentVideoBytes]]) {
    const bytes = Buffer.alloc(limit + 1); sample.copy(bytes)
    const mime = sample === silk ? 'audio/silk' : 'video/mp4'
    assert.equal(validate({ mime, base64: bytes.subarray(0, limit).toString('base64') }).mime, mime)
    assert.throws(() => validate({ mime, base64: bytes.toString('base64') }))
  }
})

for (const kind of ['group', 'private']) for (const media of [audio, video]) {
  test(`QQ ${kind} ${media.kind} constructs one native playable segment with owned bytes`, async () => {
    const d = direct(), conversation = { ...target, kind }
    assert.deepEqual(await d.sendMedia(action({ target: conversation, media })), { state: 'sent', messageId: '6789' })
    assert.equal(d.calls.length, 1)
    assert.equal(d.calls[0].action, kind === 'group' ? 'send_group_msg' : 'send_private_msg')
    assert.deepEqual(d.calls[0].params, { [kind === 'group' ? 'group_id' : 'user_id']: target.id,
      message: [{ type: media.kind === 'audio' ? 'record' : 'video', data: { file: 'base64://' + media.base64 } }],
    })
    assert.equal(JSON.stringify(d.calls[0].params).includes('spokenText'), false)
    assert.equal(Object.isFrozen(d.calls[0].params.message[0].data), true)
  })
}

test('full account namespace target and binding are rechecked without account fallback', async () => {
  const d = direct()
  for (const conversation of [{ ...target, kind: 'channel' }, { ...target, id: '0315320' }, { ...target, id: '' },
    { ...target, account: { ...account, id: '999999' } }, { ...target, account: { ...account, namespace: 'tenant' } },
    { ...target, account: { ...account, platform: 'telegram' } }]) assert.equal((await d.sendMedia(action({ target: conversation }))).state, 'failed')
  for (const invalid of [{ ...binding, connectionId: 'other' }, { ...binding, target: { ...target, id: '999999' } }]) {
    assert.equal((await d.sendMedia(action({ binding: invalid }))).state, 'failed')
  }
  assert.equal(d.calls.length, 0)
  assert.deepEqual(await d.sendMedia(action({ binding })), { state: 'sent', messageId: '6789' })
})

test('only strict success with native message ID confirms media; file UUIDs, echoes and malformed IDs do not', async () => {
  for (const response of [null, {}, { retcode: 0 }, success(null), success(0), success(''), success('0'), success('bad\nid'),
    success(Number.MAX_SAFE_INTEGER + 1), { status: 'ok', retcode: '0', data: { message_id: 17 } },
    { status: 'ok', retcode: 0, data: { file_id: 'uuid', echo: 'request-id' } },
    { ...success(), self_id: '999999' }, { ...success(), group_id: '999999' },
  ]) {
    const d = direct(response)
    assert.deepEqual(await d.sendMedia(action()), { state: 'unknown' })
    assert.equal(d.calls.length, 1)
  }
})

test('schema rejections are definite while NapCat handler timeout and other native errors remain unknown', async () => {
  for (const retcode of [200, 1200, 500, 1, -1]) {
    const d = direct({ ...success(), status: 'failed', retcode })
    assert.deepEqual(await d.sendMedia(action()), { state: 'unknown' })
    assert.equal(d.calls.length, 1)
  }
  for (const retcode of [400, 1400]) {
    assert.deepEqual(await direct({ ...success(), status: 'failed', retcode }).sendMedia(action()), { state: 'failed', code: String(retcode) })
  }
  assert.deepEqual(await direct({ state: 'failed', code: 'onebot_disconnected' }).sendMedia(action()), { state: 'failed', code: 'onebot_disconnected' })
})

test('existing QQ send and bundle boundaries retain handler ambiguity without changing legacy normalization', async () => {
  for (const method of ['send', 'sendBundle']) for (const retcode of [200, 1200, 400, 1400]) {
    let calls = 0
    const port = createQqMessageActionPort({ async sendApi() { calls++; return { ...success(), status: 'failed', retcode } } })
    const input = method === 'send' ? { version: 1, kind: 'message.send', target, parts: [{ kind: 'text', text: 'hello' }] }
      : { version: 1, kind: 'message.bundle.send', target, items: [{ parts: [{ kind: 'text', text: 'hello' }] }] }
    assert.deepEqual(await port[method](input), retcode === 400 || retcode === 1400 ? { state: 'failed', code: String(retcode) } : { state: 'unknown' })
    assert.equal(calls, 1)
  }
})

test('pre-dispatch cancellation and stale guards cause zero native requests; thrown transports remain unknown', async () => {
  const d = direct(), controller = new AbortController(); controller.abort()
  assert.equal((await d.sendMedia(action(), { signal: controller.signal })).state, 'failed')
  assert.equal((await d.sendMedia(action(), { isCurrent: () => false })).state, 'failed')
  assert.equal(d.calls.length, 0)
  const thrown = direct(() => { throw Error('may have sent') })
  assert.deepEqual(await thrown.sendMedia(action()), { state: 'unknown' })
  assert.equal(thrown.calls.length, 1)
})

for (const cancellation of ['signal', 'guard', 'target', 'binding']) {
  test(`dispatched media losing ${cancellation} returns unknown and ignores late success`, async () => {
    let release, current = true
    const d = direct(() => new Promise(resolve => { release = resolve })), controller = new AbortController()
    const ownTarget = structuredClone(target), ownBinding = { ...binding, target: ownTarget }
    const pending = d.sendMedia(action({ target: ownTarget, binding: ownBinding }), { signal: controller.signal, isCurrent: () => current })
    await waitFor(() => release)
    if (cancellation === 'signal') controller.abort()
    else if (cancellation === 'guard') current = false
    else if (cancellation === 'target') ownTarget.id = '999999'
    else ownBinding.revision = 'r2'
    assert.deepEqual(await Promise.race([pending, delay(500).then(() => 'timeout')]), { state: 'unknown' })
    assert.equal(d.calls[0].options.signal.aborted, true)
    release(success('late-success')); await delay(5)
    assert.equal(d.calls.length, 1)
  })
}

test('captured media bytes cannot mutate while queued and a revoked queue never publishes', async () => {
  let enter, current = true, sent = 0
  const original = { ...audio }, d = direct(async (_action, params, options) => {
    enter = true; await delay(40)
    assert.equal(params.message[0].data.file, 'base64://' + audio.base64)
    if (options.isCurrent()) sent++
    return success()
  })
  const pending = d.sendMedia(action({ media: original }), { isCurrent: () => current })
  await waitFor(() => enter); original.base64 = 'late replacement'; current = false
  assert.deepEqual(await pending, { state: 'unknown' }); await delay(50)
  assert.equal(sent, 0)
})

async function fixture(t, transport) {
  const requests = [], peers = []
  let peer, server, url, handler = () => success()
  const attach = socket => {
    peer = socket; peers.push(socket); socket.on('error', () => {})
    socket.on('message', raw => {
      const request = JSON.parse(String(raw)); requests.push(request)
      const response = request.action === 'get_login_info' ? { status: 'ok', retcode: 0, data: { user_id: account.id, nickname: '媒体合成验收' } } : handler(request, socket)
      if (response) socket.send(JSON.stringify({ ...response, echo: request.echo }))
    })
    return socket
  }
  if (transport === 'forward-websocket') {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening')
    server.on('connection', attach); url = `ws://127.0.0.1:${server.address().port}`
  } else {
    const allocator = createServer(); allocator.listen(0, '127.0.0.1'); await once(allocator, 'listening')
    url = `ws://127.0.0.1:${allocator.address().port}/onebot`; await new Promise(resolve => allocator.close(resolve))
  }
  const adapter = createOneBotConnection({ connection: { id: 'media-local', account }, transport, url, accessToken: 'media-fixture',
    onDisconnect() {}, onReconnect() {}, onError() {}, onEventError() {},
  })
  t.after(async () => { adapter.stop(); for (const socket of peers) socket.terminate(); if (server) await new Promise(resolve => server.close(resolve)) })
  assert.equal((await adapter.actions.sendMedia(action())).state, 'failed')
  const start = adapter.start(async () => {}); void start.catch(() => {})
  if (transport === 'reverse-websocket') await waitFor(async () => {
    const socket = attach(new WebSocket(url, { headers: { Authorization: 'Bearer media-fixture', 'X-Self-ID': account.id, 'X-Client-Role': 'Universal' } }))
    try { await once(socket, 'open'); return true } catch { socket.terminate(); return false }
  })
  await start
  return { adapter, requests, peer: () => peer, setHandler(value) { handler = value } }
}

for (const transport of ['forward-websocket', 'reverse-websocket']) {
  test(`${transport} sends audio/video to fixed group/private over authenticated real local sockets`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport)
    for (const kind of ['group', 'private']) for (const media of [audio, video]) {
      assert.deepEqual(await f.adapter.actions.sendMedia(action({ target: { ...target, kind }, media })), { state: 'sent', messageId: '6789' })
    }
    const sent = f.requests.filter(row => row.action !== 'get_login_info')
    assert.equal(sent.length, 4)
    assert.deepEqual(sent.map(row => row.params.message[0].type), ['record', 'video', 'record', 'video'])
    assert.deepEqual(sent.map(row => row.action), ['send_group_msg', 'send_group_msg', 'send_private_msg', 'send_private_msg'])
    assert.equal(sent.every(row => Object.keys(row.params).length === 2), true)
  })
  for (const mode of ['abort', 'stop', 'disconnect', 'binding']) {
    test(`${transport} dispatched media ${mode} is unknown with one native request`, { timeout: 8000 }, async t => {
      const f = await fixture(t, transport), controller = new AbortController(); let current = true
      f.setHandler(() => undefined)
      const pending = f.adapter.actions.sendMedia(action(), { signal: controller.signal, isCurrent: () => current })
      await waitFor(() => f.requests.find(row => row.action === 'send_group_msg'))
      if (mode === 'abort') controller.abort()
      else if (mode === 'stop') f.adapter.stop()
      else if (mode === 'disconnect') f.peer().terminate()
      else current = false
      assert.deepEqual(await Promise.race([pending, delay(600).then(() => 'timeout')]), { state: 'unknown' })
      assert.equal(f.requests.filter(row => row.action === 'send_group_msg').length, 1)
    })
  }
  test(`${transport} native handler error 1200 is unknown and never resent as another segment type`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport)
    f.setHandler(() => ({ status: 'failed', retcode: 1200, data: { message_id: 42 } }))
    assert.deepEqual(await f.adapter.actions.sendMedia(action({ media: video })), { state: 'unknown' })
    assert.equal(f.requests.filter(row => row.action !== 'get_login_info').length, 1)
  })
}
