import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket, { WebSocketServer } from 'ws'
import { createQqAudioFileDeliveryPort, QQ_AUDIO_FILE_SEND_TIMEOUT_MS } from '../dist/backend/adapters/qqAudioFileDelivery.js'
import { createOneBotConnection } from '../dist/backend/adapters/oneBotConnection.js'
import { validateAgentAudioAttachment } from '../dist/backend/modules/media/infrastructure/agentAudioAttachment.js'
import { MAX_AGENT_AUDIO_BYTES } from '../dist/backend/modules/media/infrastructure/agentMediaBytes.js'
import { queuedDeliveryAllowed } from '../dist/backend/modules/messaging/infrastructure/deliveryScope.js'

const account = { platform: 'qq', namespace: 'global', id: '123456789' }
const target = { account, kind: 'group', id: '315320' }
const binding = { source: 'configured', id: 'audio-file-binding', revision: 'r1', personaId: 'default', agentId: 'alice', connectionId: 'audio-file-local', target }
const bytes = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0])
const attachment = { name: '合成音乐.mp3', mime: 'audio/mpeg', base64: bytes.toString('base64') }
const action = (overrides = {}) => ({ version: 1, kind: 'audio-file.upload', target, attachment, ...overrides })
const success = (fileId = 'native-file-uuid') => ({ status: 'ok', retcode: 0, data: { file_id: fileId } })
function direct(response = success()) {
  const calls = [], sendAudioFile = createQqAudioFileDeliveryPort({ account, connectionId: 'audio-file-local', async sendApi(action, params, options) {
    calls.push({ action, params, options }); return typeof response === 'function' ? response(action, params, options) : response
  } })
  return { calls, sendAudioFile }
}
async function waitFor(probe) {
  const until = Date.now() + 3000
  while (Date.now() < until) { const value = await probe(); if (value) return value; await delay(5) }
  assert.fail('Timed out waiting for audio file fixture')
}

test('audio attachment owns a frozen complete byte snapshot with MIME/header and safe-name checks', () => {
  const input = { ...attachment }, output = validateAgentAudioAttachment(input)
  assert.deepEqual(output, input); assert.notEqual(output, input); assert.equal(Object.isFrozen(output), true)
  input.base64 = 'changed'; assert.equal(output.base64, attachment.base64)
  assert.equal(validateAgentAudioAttachment({ ...attachment, name: 'A'.repeat(251) + '.mp3' }).name.length, 255)
})

test('audio attachment denies paths, arbitrary native arguments, accessors, forged formats and unsafe names', async () => {
  let accessed = false
  const getter = { ...attachment }; Object.defineProperty(getter, 'base64', { get() { accessed = true; return attachment.base64 }, enumerable: true })
  const d = direct()
  for (const value of [getter, { ...attachment, path: '/etc/passwd' }, { ...attachment, url: 'https://example.com/a.mp3' },
    { ...attachment, file_id: 'native-ref' }, { ...attachment, target }, { ...attachment, [Symbol('hidden')]: 'secret' },
    Object.assign(Object.create({ inherited: true }), attachment), { ...attachment, mime: 'audio/wav' }, { ...attachment, mime: 'audio/aac' },
    { ...attachment, base64: Buffer.from('not audio').toString('base64') }, { ...attachment, base64: 'YQ' },
    { ...attachment, base64: attachment.base64 + '\n' }, { ...attachment, base64: '' }, { ...attachment, name: 'audio.exe' },
    ...['', ' audio.mp3', 'audio.mp3 ', '../a.mp3', '/a.mp3', 'C:\\a.mp3', 'audio\0.mp3', 'audio:secret.mp3',
      'CON.mp3', 'NUL.mp3', 'audio.mp3.', 'A'.repeat(252) + '.mp3'].map(name => ({ ...attachment, name })),
  ]) {
    assert.throws(() => validateAgentAudioAttachment(value))
    assert.equal((await d.sendAudioFile(action({ attachment: value }))).state, 'failed')
  }
  assert.equal(accessed, false); assert.equal(d.calls.length, 0)
})

test('complete audio attachments allow exactly 20 MiB and reject overflow before upload', () => {
  const data = Buffer.alloc(MAX_AGENT_AUDIO_BYTES + 1); bytes.copy(data)
  assert.equal(validateAgentAudioAttachment({ ...attachment, base64: data.subarray(0, MAX_AGENT_AUDIO_BYTES).toString('base64') }).mime, 'audio/mpeg')
  assert.throws(() => validateAgentAudioAttachment({ ...attachment, base64: data.toString('base64') }))
})

for (const kind of ['group', 'private']) {
  test(`QQ ${kind} uploads one complete audio file with exactly the fixed target, bytes and safe name`, async () => {
    const d = direct(), conversation = { ...target, kind }
    assert.deepEqual(await d.sendAudioFile(action({ target: conversation, binding: { ...binding, target: conversation } })), { state: 'uploaded', fileId: 'native-file-uuid' })
    assert.equal(d.calls.length, 1); assert.equal(d.calls[0].action, kind === 'group' ? 'upload_group_file' : 'upload_private_file')
    assert.deepEqual(d.calls[0].params, { [kind === 'group' ? 'group_id' : 'user_id']: target.id, file: 'base64://' + attachment.base64, name: attachment.name })
    assert.equal(Object.isFrozen(d.calls[0].params), true)
    assert.equal(Buffer.from(d.calls[0].params.file.slice('base64://'.length), 'base64').equals(bytes), true)
    assert.equal(Object.hasOwn(d.calls[0].params, 'mime'), false)
  })
}

test('audio upload retains full string account/target/binding identity without recipient or account fallback', async () => {
  const d = direct()
  for (const conversation of [{ ...target, id: null }, { ...target, id: 315320 }, { ...target, id: '0315320' },
    { ...target, kind: 'channel' }, { ...target, account: { ...account, id: null } }, { ...target, account: { ...account, id: '99999' } },
    { ...target, account: { ...account, namespace: 'tenant' } }, { ...target, account: { ...account, platform: 'telegram' } },
    { ...target, kind: 'private', id: account.id },
  ]) assert.equal((await d.sendAudioFile(action({ target: conversation }))).state, 'failed')
  for (const invalid of [{ ...binding, connectionId: 'other' }, { ...binding, source: 'untrusted' }, { ...binding, revision: '' },
    { ...binding, agentId: undefined }, { ...binding, extra: true }, { ...binding, target: { ...target, id: '99999' } },
  ]) assert.equal((await d.sendAudioFile(action({ binding: invalid }))).state, 'failed')
  assert.equal(d.calls.length, 0)
})

test('only native ok/numeric-zero/real file ID confirms an upload, never a message or echo ID', async () => {
  for (const response of [null, {}, success(null), success(''), success(17), success('uuid\n'), success(' uuid'),
    { status: 'ok', retcode: '0', data: { file_id: 'native-file' } }, { status: 'ok', retcode: 0, data: { message_id: 17, echo: 'request' } },
    { ...success(), self_id: '99999' }, { ...success(), group_id: '99999' }, { ...success(), user_id: target.id },
  ]) {
    const d = direct(response)
    assert.deepEqual(await d.sendAudioFile(action()), { state: 'unknown' }); assert.equal(d.calls.length, 1)
  }
  assert.deepEqual(await direct({ ...success(), data: { file_id: 'native-file', message_id: 17 } }).sendAudioFile(action()), { state: 'uploaded', fileId: 'native-file' })
})

test('native handler errors and thrown transports stay unknown without retry or record/text fallback', async () => {
  for (const retcode of [200, 1200, 500, 1]) {
    const d = direct({ status: 'failed', retcode, data: { file_id: 'possibly-published' } })
    assert.deepEqual(await d.sendAudioFile(action()), { state: 'unknown' }); assert.equal(d.calls.length, 1)
  }
  for (const retcode of [400, 1400]) assert.deepEqual(await direct({ status: 'failed', retcode }).sendAudioFile(action()), { state: 'failed', code: String(retcode) })
  assert.deepEqual(await direct({ state: 'failed', code: 'onebot_disconnected' }).sendAudioFile(action()), { state: 'failed', code: 'onebot_disconnected' })
  const d = direct(() => { throw Error('may have uploaded') })
  assert.deepEqual(await d.sendAudioFile(action()), { state: 'unknown' }); assert.equal(d.calls.length, 1)
})

test('pre-aborted or stale audio upload scope sends nothing and keeps its 180 second deadline', async () => {
  const d = direct(), cancel = new AbortController(); cancel.abort()
  assert.equal((await d.sendAudioFile(action(), { signal: cancel.signal })).state, 'failed')
  assert.equal((await d.sendAudioFile(action(), { isCurrent: () => false })).state, 'failed')
  assert.equal(d.calls.length, 0); assert.equal(QQ_AUDIO_FILE_SEND_TIMEOUT_MS, 180000)
})

for (const mode of ['abort', 'guard', 'target', 'binding', 'account']) {
  test(`dispatched audio file losing ${mode} becomes unknown and ignores late uploaded evidence`, async () => {
    let release, current = true
    const d = direct(() => new Promise(resolve => { release = resolve })), cancel = new AbortController()
    const ownAccount = { ...account }, ownTarget = { ...target, account: ownAccount }, ownBinding = { ...binding, target: ownTarget }
    const pending = d.sendAudioFile(action({ target: ownTarget, binding: ownBinding }), { signal: cancel.signal, isCurrent: () => current })
    await waitFor(() => release)
    if (mode === 'abort') cancel.abort()
    else if (mode === 'guard') current = false
    else if (mode === 'target') ownTarget.id = '99999'
    else if (mode === 'binding') ownBinding.revision = 'r2'
    else ownAccount.id = '99999'
    assert.deepEqual(await Promise.race([pending, delay(500).then(() => 'timeout')]), { state: 'unknown' })
    assert.equal(d.calls[0].options.signal.aborted, true)
    release(success('late-file')); await delay(5); assert.equal(d.calls.length, 1)
  })
}

test('owned attachment survives mutation while queued and revoked queue prevents upload', async () => {
  let entered, current = true, uploaded = 0
  const own = { ...attachment }, d = direct(async (_action, params, options) => {
    entered = true; await delay(40)
    assert.equal(params.file, 'base64://' + attachment.base64); assert.equal(params.name, attachment.name)
    if (options.isCurrent() && queuedDeliveryAllowed()) uploaded++
    return success()
  })
  const pending = d.sendAudioFile(action({ attachment: own }), { isCurrent: () => current })
  await waitFor(() => entered); own.base64 = 'replacement'; own.name = 'replacement.mp3'; current = false
  assert.deepEqual(await pending, { state: 'unknown' }); await delay(50); assert.equal(uploaded, 0)
})

async function fixture(t, transport) {
  const requests = [], peers = []; let peer, server, url, handler = () => success()
  const attach = socket => {
    peer = socket; peers.push(socket); socket.on('error', () => {})
    socket.on('message', raw => {
      const request = JSON.parse(String(raw)); requests.push(request)
      const response = request.action === 'get_login_info' ? { status: 'ok', retcode: 0, data: { user_id: account.id, nickname: '音频文件合成验收' } } : handler(request)
      if (response) socket.send(JSON.stringify({ ...response, echo: request.echo }))
    }); return socket
  }
  if (transport === 'forward-websocket') {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening')
    server.on('connection', (socket, request) => { assert.equal(request.headers.authorization, 'Bearer audio-file-fixture'); attach(socket) })
    url = `ws://127.0.0.1:${server.address().port}`
  } else {
    const allocator = createServer(); allocator.listen(0, '127.0.0.1'); await once(allocator, 'listening')
    url = `ws://127.0.0.1:${allocator.address().port}/onebot`; await new Promise(resolve => allocator.close(resolve))
  }
  const adapter = createOneBotConnection({ connection: { id: 'audio-file-local', account }, transport, url, accessToken: 'audio-file-fixture', onDisconnect() {}, onReconnect() {}, onError() {}, onEventError() {} })
  t.after(async () => { adapter.stop(); for (const socket of peers) socket.terminate(); if (server) await new Promise(resolve => server.close(resolve)) })
  assert.equal((await adapter.actions.sendAudioFile(action())).state, 'failed')
  const start = adapter.start(async () => {}); void start.catch(() => {})
  if (transport === 'reverse-websocket') await waitFor(async () => {
    const socket = attach(new WebSocket(url, { headers: { Authorization: 'Bearer audio-file-fixture', 'X-Self-ID': account.id, 'X-Client-Role': 'Universal' } }))
    try { await once(socket, 'open'); return true } catch { socket.terminate(); return false }
  })
  await start
  return { adapter, requests, socket: () => peer, setHandler(value) { handler = value } }
}

for (const transport of ['forward-websocket', 'reverse-websocket']) {
  test(`${transport} uploads bounded owned audio to fixed group/private through authenticated local sockets`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport)
    for (const kind of ['group', 'private']) assert.deepEqual(await f.adapter.actions.sendAudioFile(action({ target: { ...target, kind } })), { state: 'uploaded', fileId: 'native-file-uuid' })
    const sent = f.requests.filter(row => row.action !== 'get_login_info')
    assert.deepEqual(sent.map(row => row.action), ['upload_group_file', 'upload_private_file'])
    assert.deepEqual(sent.map(row => row.params), ['group', 'private'].map(kind => ({ [kind === 'group' ? 'group_id' : 'user_id']: target.id,
      file: 'base64://' + attachment.base64, name: attachment.name })))
  })
  for (const mode of ['abort', 'stop', 'disconnect', 'rebind']) {
    test(`${transport} dispatched audio upload ${mode} is unknown and ignores late UUIDs without resend`, { timeout: 8000 }, async t => {
      const f = await fixture(t, transport), cancel = new AbortController(); let current = true
      f.setHandler(() => undefined)
      const pending = f.adapter.actions.sendAudioFile(action(), { signal: cancel.signal, isCurrent: () => current })
      const request = await waitFor(() => f.requests.find(row => row.action === 'upload_group_file'))
      if (mode === 'abort') cancel.abort()
      else if (mode === 'stop') f.adapter.stop()
      else if (mode === 'disconnect') f.socket().terminate()
      else current = false
      assert.deepEqual(await Promise.race([pending, delay(600).then(() => 'timeout')]), { state: 'unknown' })
      if (f.socket().readyState === WebSocket.OPEN) f.socket().send(JSON.stringify({ ...success('late-file'), echo: request.echo }))
      await delay(5); assert.equal(f.requests.filter(row => row.action !== 'get_login_info').length, 1)
    })
  }
  for (const retcode of [1400, 1200]) {
    test(`${transport} native audio file ${retcode} is classified without fallback`, { timeout: 8000 }, async t => {
      const f = await fixture(t, transport)
      f.setHandler(() => ({ status: 'failed', retcode, data: { file_id: 'possibly-published' } }))
      assert.deepEqual(await f.adapter.actions.sendAudioFile(action()), retcode === 1400 ? { state: 'failed', code: '1400' } : { state: 'unknown' })
      assert.equal(f.requests.filter(row => row.action !== 'get_login_info').length, 1)
    })
  }
}
