import assert from 'node:assert/strict'
import dns from 'node:dns/promises'
import { EventEmitter, once } from 'node:events'
import { createServer } from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import WebSocket, { WebSocketServer } from 'ws'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const compiled = name => pathToFileURL(path.join(release, 'dist/backend', name)).href
const { createQqMessageVideoReader, QQ_VIDEO_READ_TIMEOUT_MS, QQ_VIDEO_API_TIMEOUT_MS } = await import(compiled('adapters/qqMessageVideo.js'))
const { createOneBotConnection } = await import(compiled('adapters/oneBotConnection.js'))
const account = { platform: 'qq', namespace: 'global', id: '123456789' }
const group = { account, kind: 'group', id: '315320' }, author = { ...account, id: '246810' }, occurredAt = 1700000000000
const url = 'https://dynamic-video.example/native.mp4?rkey=platform-only'
const mp4 = Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex')
const webm = Buffer.from('1a45dfa3874282847765626d18538067ff', 'hex')
const ok = data => ({ status: 'ok', retcode: 0, data })
const text = value => ({ type: 'text', data: { text: value } })
const video = (value = url) => ({ type: 'video', data: { url: value } })
const forward = id => ({ type: 'forward', data: { id } })
const quote = id => ({ type: 'reply', data: { id: String(id) } })
const message = (overrides = {}) => ok({ self_id: account.id, message_type: 'group', group_id: group.id, message_id: 71,
  time: occurredAt / 1000, user_id: author.id, sender: { user_id: author.id, nickname: '视频来源作者' }, message: [video()], ...overrides })
const node = (content = [video()], overrides = {}) => ({ type: 'node', data: { user_id: '345678', time: occurredAt / 1000 - 1, content, ...overrides } })
const options = overrides => ({ signal: new AbortController().signal, isCurrent: () => true,
  allowsSource: async () => true, allowsForwardSource: async () => true, ...overrides })
const cqJson = value => `[CQ:json,data=${JSON.stringify(value).replace(/&/gu, '&amp;').replace(/,/gu, '&#44;').replace(/\[/gu, '&#91;').replace(/\]/gu, '&#93;')}]`
function direct({ response = message(), forwards = {}, info = ok({ url }), addresses = [{ address: '8.8.8.8', family: 4 }],
  request, timeoutMs, configuredAccount = account } = {}) {
  const calls = [], lookups = [], downloads = [], closed = []
  const read = createQqMessageVideoReader({ account: configuredAccount, ...(timeoutMs === undefined ? {} : { timeoutMs }),
    async readApi(action, params, guard) {
      calls.push({ action, params, guard })
      if (typeof response === 'function') return response(action, params, guard)
      if (action === 'get_msg') return response
      if (action === 'get_forward_msg') return ok({ id: params.id, messages: forwards[params.id] })
      if (action === 'get_video_info') return info
      assert.fail(`Unexpected API ${action}`)
    },
    async lookup(host) { lookups.push(host); return typeof addresses === 'function' ? addresses(host) : addresses },
    async request(target, address, signal) {
      downloads.push({ url: target, address, signal })
      if (request) return request(target, address, signal)
      return { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(mp4.length) },
        body: (async function* () { yield mp4 })(), close() { closed.push(target.href) } }
    },
  })
  return { read, calls, lookups, downloads, closed }
}
async function waitFor(probe) {
  const deadline = Date.now() + 2500
  while (Date.now() < deadline) { const value = await probe(); if (value) return value; await delay(5) }
  assert.fail('Timed out waiting for QQ video fixture')
}
function inspect(d, overrides = {}) { return d.read(group, '71', options({ inspectOnly: true, ...overrides })) }

test('inspection returns a closed stable fingerprint and never resolves URLs or bytes', async () => {
  const d = direct({ response: message({ message: [text('帮我分析这个'), { type: 'video', data: { file: 'native-file-12345' } }] }) })
  const seen = [], first = await inspect(d, { allowsSource: async source => { seen.push(source); return true } }), second = await inspect(d)
  assert.deepEqual(first, second); assert.match(first.fingerprint, /^[a-f0-9]{64}$/u); assert.equal(first.origin, 'current'); assert.ok(Object.isFrozen(first))
  assert.deepEqual(Object.keys(first), ['fingerprint', 'origin']); assert.equal(first.video, undefined)
  assert.deepEqual(d.calls.map(value => value.action), ['get_msg', 'get_msg']); assert.equal(d.lookups.length, 0); assert.equal(d.downloads.length, 0)
  for (const source of seen) {
    assert.equal(source.sender.id, author.id); assert.equal(source.messageId, '71'); assert.equal(source.occurredAt, occurredAt)
    assert.equal(source.text, '帮我分析这个'); assert.equal(source.quote, undefined); assert.ok(Object.isFrozen(source))
    for (const secret of ['native-file-12345', 'rkey', 'dynamic-video.example']) assert.equal(JSON.stringify(source).includes(secret), false)
  }
})

test('current video wins before a reply or forwarded root can be queried', async () => {
  const d = direct({ response: message({ message: [quote(70), forward('root-id'), video()] }) })
  assert.equal((await inspect(d)).origin, 'current'); assert.deepEqual(d.calls.map(value => value.action), ['get_msg'])
})

test('native canonical, legacy, CQ and file-as-URL video shapes use their original platform source', async () => {
  const nativeId = '8a376bb6414a2a77bb0b5c66ecaf29d2.mp4'
  for (const content of [[{ type: 'video', url }], [{ type: 'video', data: { file_url: url } }],
    [{ type: 'video', data: { file: url } }], [{ type: 'video', data: { file: nativeId, url, file_size: mp4.length } }],
    `[CQ:video,file=${nativeId},url=${url},file_size=${mp4.length}]`]) {
    const d = direct({ response: message({ message: content }) }), result = await d.read(group, '71', options())
    assert.equal(result.origin, 'current'); assert.equal(result.video.mime, 'video/mp4')
    assert.equal(d.calls.some(call => call.action === 'get_video_info'), false); assert.equal(d.downloads[0].url.href, url)
  }
})

test('reply direct video wins before any current or quoted forwarded video', async () => {
  const d = direct({ response: (action, params) => {
    assert.equal(action, 'get_msg')
    return params.message_id === 71 ? message({ message: [forward('current-root'), quote(70)] }) :
      message({ message_id: 70, time: occurredAt / 1000 - 1, message: [forward('reply-root'), video()] })
  } })
  const seen = [], result = await inspect(d, { allowsSource: async source => {
    seen.push(source.messageId)
    if (source.messageId === '71') { assert.deepEqual(source.quote, { messageId: '70', parts: [] }); assert.ok(Object.isFrozen(source.quote)) }
    return true
  } })
  assert.equal(result.origin, 'reply'); assert.deepEqual(d.calls.map(({ action, params }) => ({ action, params })), [
    { action: 'get_msg', params: { message_id: 71 } }, { action: 'get_msg', params: { message_id: 70 } },
  ])
  assert.ok(seen.filter(id => id === '71').length >= 2); assert.ok(seen.includes('70'))
})

test('each forward ancestor and selected leaf is authorized with true author and time, without a fabricated message id', async () => {
  const d = direct({ response: message({ message: [forward('root-id')] }), forwards: {
    'root-id': [node([text('ancestor'), forward('nested-id')], { user_id: '345678', time: occurredAt / 1000 - 1 })],
    'nested-id': [node([video()], { user_id: '456789', time: occurredAt / 1000 - 2 })],
  } }), seen = []
  const result = await inspect(d, { allowsForwardSource: async source => { seen.push(source); return true } })
  assert.equal(result.origin, 'forward')
  assert.deepEqual(seen.slice(0, 2), [
    { author: { ...account, id: '345678' }, occurredAt: occurredAt - 1000 },
    { author: { ...account, id: '456789' }, occurredAt: occurredAt - 2000 },
  ])
  for (const source of seen) { assert.deepEqual(Object.keys(source), ['author', 'occurredAt']); assert.ok(Object.isFrozen(source)); assert.equal(source.messageId, undefined) }
  assert.deepEqual(d.calls.map(({ action, params }) => ({ action, params })), [
    { action: 'get_msg', params: { message_id: 71 } },
    { action: 'get_forward_msg', params: { id: 'root-id', message_id: 'root-id' } },
    { action: 'get_forward_msg', params: { id: 'nested-id', message_id: 'nested-id' } },
  ])
})

test('native forward JSON and CQ roots allow nested inline nodes only below the verified root', async () => {
  const card = { app: 'com.tencent.multimsg', meta: { detail: { resid: 'native-root' } } }
  for (const content of [[forward('native-root')], [{ type: 'json', data: { data: JSON.stringify(card) } }], cqJson(card)]) {
    const d = direct({ response: message({ message: content }), forwards: { 'native-root': [node([node([video()], { time: occurredAt / 1000 - 2 })])] } })
    assert.equal((await inspect(d)).origin, 'forward')
  }
  const unproven = direct({ response: message({ message: [node([video()])] }) })
  assert.equal(await inspect(unproven), undefined); assert.equal(unproven.calls.length, 1)
})

test('first broken current, reply or forwarded video never falls through to a second video', async () => {
  const bad = video('file:///tmp/secret.mp4')
  const current = direct({ response: message({ message: [bad, video(), quote(70), forward('root-id')] }) })
  assert.equal(await current.read(group, '71', options()), undefined); assert.equal(current.downloads.length, 0); assert.equal(current.calls.length, 1)
  const reply = direct({ response: (_action, params) => params.message_id === 71 ? message({ message: [quote(70), forward('root-id')] }) :
    message({ message_id: 70, time: occurredAt / 1000 - 1, message: [bad, video()] }) })
  assert.equal(await reply.read(group, '71', options()), undefined); assert.equal(reply.downloads.length, 0); assert.equal(reply.calls.length, 2)
  const forwarded = direct({ response: message({ message: [forward('root-id')] }), forwards: { 'root-id': [node([bad, video()]), node([video()])] } })
  assert.equal(await forwarded.read(group, '71', options()), undefined); assert.equal(forwarded.downloads.length, 0); assert.equal(forwarded.calls.length, 2)
})

for (const [label, override] of [
  ['account', { self_id: '999999' }], ['group', { group_id: '999999' }], ['message id', { message_id: 72 }],
  ['author disagreement', { user_id: '999999' }], ['author absence', { user_id: undefined, sender: {} }],
  ['self author', { user_id: account.id, sender: { user_id: account.id } }], ['time absence', { time: undefined }],
  ['unsafe time', { time: Number.MAX_SAFE_INTEGER }], ['private source', { message_type: 'private' }],
]) test(`original ${label} evidence is required before lookup or download`, async () => {
  const d = direct({ response: message(override) }); assert.equal(await d.read(group, '71', options()), undefined)
  assert.equal(d.lookups.length, 0); assert.equal(d.downloads.length, 0); assert.equal(d.calls.length, 1)
})

test('quoted same-group identity, earlier time, source authorization and one exact reply are mandatory', async () => {
  for (const override of [{ group_id: '999999' }, { message_id: 69 }, { self_id: '999999' }, { time: occurredAt / 1000 + 1 }]) {
    const d = direct({ response: (_action, params) => params.message_id === 71 ? message({ message: [quote(70)] }) : message({ message_id: 70, ...override }) })
    assert.equal(await inspect(d), undefined)
  }
  for (const content of [[quote(71)], [quote(70), quote(69)], [quote('not-an-id')]]) {
    const d = direct({ response: message({ message: content }) }); assert.equal(await inspect(d), undefined); assert.equal(d.calls.length, 1)
  }
  const denied = direct({ response: (_action, params) => params.message_id === 71 ? message({ message: [quote(70)] }) : message({ message_id: 70 }) })
  assert.equal(await inspect(denied, { allowsSource: async source => source.messageId !== '70' }), undefined)
})

test('missing, conflicting, future or denied forward metadata rejects the selection without skipping it', async () => {
  for (const override of [{ user_id: undefined }, { time: undefined }, { time: occurredAt / 1000 + 1 },
    { user_id: '000345678' }, { sender: { user_id: '999999' } }, { self_id: '999999' }]) {
    const d = direct({ response: message({ message: [forward('root-id')] }), forwards: { 'root-id': [node([video()], override), node([video()])] } })
    assert.equal(await inspect(d), undefined); assert.equal(d.calls.length, 2)
  }
  const d = direct({ response: message({ message: [forward('root-id')] }), forwards: { 'root-id': [node([forward('nested-id')])], 'nested-id': [node()] } })
  assert.equal(await inspect(d, { allowsForwardSource: async () => false }), undefined); assert.equal(d.calls.length, 2)
})

test('forward source order is stable and current roots precede quoted roots', async () => {
  const d = direct({ response: (action, params) => action === 'get_msg' ? params.message_id === 71 ?
    message({ message: [quote(70), forward('current-root')] }) : message({ message_id: 70, message: [forward('reply-root')] }) :
    ok({ id: params.id, messages: [node()] }) })
  assert.equal((await inspect(d)).origin, 'forward'); assert.equal(d.calls.at(-1).params.id, 'current-root')
  assert.equal(d.calls.some(call => call.params.id === 'reply-root'), false)
})

test('forward traversal has three node levels, fifty nodes, six requests and cycle protection', async () => {
  const depth = direct({ response: message({ message: [forward('root-id')] }), forwards: {
    'root-id': [node([node([node([node()])])])],
  } }); assert.equal(await inspect(depth), undefined)
  const count = direct({ response: message({ message: [forward('root-id')] }), forwards: {
    'root-id': [...Array.from({ length: 50 }, () => node([text('empty')])), node()],
  } }); assert.equal(await inspect(count), undefined)
  const roots = Array.from({ length: 7 }, (_, index) => forward(`root-${index}`))
  const requests = direct({ response: message({ message: roots }), forwards: Object.fromEntries(roots.map((part, index) => [part.data.id, [node(index === 6 ? [video()] : [text('empty')])]])) })
  assert.equal(await inspect(requests), undefined); assert.equal(requests.calls.filter(call => call.action === 'get_forward_msg').length, 6)
  const cycle = direct({ response: message({ message: [forward('root-id')] }), forwards: { 'root-id': [node([forward('root-id')])] } })
  assert.equal(await inspect(cycle), undefined); assert.equal(cycle.calls.length, 2)
})

test('fingerprint binds native source, reply, path, ancestor identity and resource while ignoring object key insertion order', async () => {
  const base = await inspect(direct())
  for (const override of [{ message: [text('changed'), video()] }, { message: [video(`${url}&changed=1`)] },
    { sender: { user_id: '345678' }, user_id: '345678' }, { time: occurredAt / 1000 - 1 }]) {
    assert.notEqual((await inspect(direct({ response: message(override) }))).fingerprint, base.fingerprint)
  }
  const reordered = message({ message: [{ data: { url }, type: 'video' }] })
  assert.equal((await inspect(direct({ response: reordered }))).fingerprint, base.fingerprint)
  const getForward = (overrides = {}, prefix = []) => direct({ response: message({ message: [forward('root-id')] }), forwards: { 'root-id': [node([...prefix, video()], overrides)] } })
  const original = await inspect(getForward())
  for (const changed of [getForward({ user_id: '456789' }), getForward({ time: occurredAt / 1000 - 2 }), getForward({}, [text('changed')])]) {
    assert.notEqual((await inspect(changed)).fingerprint, original.fingerprint)
  }
  const replied = (extra = '') => direct({ response: (_action, params) => params.message_id === 71 ? message({ message: [text(extra), quote(70)] }) : message({ message_id: 70 }) })
  assert.notEqual((await inspect(replied('one'))).fingerprint, (await inspect(replied('two'))).fingerprint)
})

test('download rereads source before and after bytes and returns only validated owned input', async () => {
  const d = direct(), result = await d.read(group, '71', options())
  assert.equal(result.origin, 'current'); assert.equal(result.video.mime, 'video/mp4'); assert.equal(result.video.base64, mp4.toString('base64'))
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.video)); assert.deepEqual(Object.keys(result), ['fingerprint', 'origin', 'video'])
  assert.deepEqual(d.calls.map(call => call.action), ['get_msg', 'get_msg', 'get_msg']); assert.equal(d.closed.length, 1)
  assert.deepEqual(d.lookups, ['dynamic-video.example']); assert.deepEqual(d.downloads[0].address, { address: '8.8.8.8', family: 4 })
  assert.equal(JSON.stringify(result).includes('rkey'), false)
})

for (const phase of ['before', 'after']) test(`${phase} source replacement or recall revokes already selected video`, async () => {
  for (const recall of [false, true]) {
    let count = 0
    const d = direct({ response: () => {
      count++; return count === (phase === 'before' ? 2 : 3) ? recall ? { status: 'failed', retcode: 1200, data: null } :
        message({ message: [video(`${url}&replaced=1`)] }) : message()
    } })
    assert.equal(await d.read(group, '71', options()), undefined); assert.equal(d.downloads.length, phase === 'before' ? 0 : 1)
  }
})

test('download revalidates the selected forwarded ancestor and policy after bytes arrive', async () => {
  let traversals = 0
  const changed = direct({ response: (action, params) => action === 'get_msg' ? message({ message: [forward('root-id')] }) :
    ok({ id: params.id, messages: [node([video()], { user_id: ++traversals === 3 ? '456789' : '345678' })] }) })
  assert.equal(await changed.read(group, '71', options()), undefined); assert.equal(changed.downloads.length, 1); assert.equal(traversals, 3)
  let revoked = false
  const denied = direct({ request: async () => {
    revoked = true
    return { status: 200, headers: {}, body: (async function* () { yield mp4 })(), close() {} }
  } })
  assert.equal(await denied.read(group, '71', options({ allowsSource: async () => !revoked })), undefined); assert.equal(denied.downloads.length, 1)
})

test('opaque original video ids use only get_video_info file, and malformed ids or local paths never dispatch it', async () => {
  for (const id of ['native-file-12345', '8a376bb6414a2a77bb0b5c66ecaf29d2.mp4']) {
    const d = direct({ response: message({ message: [{ type: 'video', data: { file: id } }] }) })
    assert.equal((await d.read(group, '71', options())).video.mime, 'video/mp4')
    assert.deepEqual(d.calls.find(call => call.action === 'get_video_info').params, { file: id })
  }
  for (const file of ['/tmp/private.mp4', 'file:///tmp/private.mp4', '../private.mp4', 'C:\\tmp\\private.mp4', 'https://name:secret@example.com/video', 'short']) {
    const d = direct({ response: message({ message: [{ type: 'video', data: { file } }] }) })
    assert.equal(await d.read(group, '71', options()), undefined); assert.equal(d.calls.some(call => call.action === 'get_video_info'), false); assert.equal(d.downloads.length, 0)
  }
  const mismatch = direct({ response: message({ message: [{ type: 'video', data: { file: 'native-file-12345' } }] }), info: ok({ file_id: 'other-file-12345', url }) })
  assert.equal(await mismatch.read(group, '71', options()), undefined); assert.equal(mismatch.downloads.length, 0)
})

test('only freshly returned public HTTP(S) video URLs pass, with every DNS answer checked', async () => {
  for (const value of ['http://127.0.0.1/private', 'https://[::1]/private', 'https://user:password@example.com/video',
    'https://dynamic-video.example:444/video', 'file:///private.mp4', '/tmp/private.mp4',
    'https://dynamic-video.example/video#secret', 'https://dynamic-video.example/%0dhidden', 'https://dynamic-video.example\\@evil.example/video']) {
    const d = direct({ response: message({ message: [video(value)] }) }); assert.equal(await d.read(group, '71', options()), undefined); assert.equal(d.downloads.length, 0)
  }
  for (const addresses of [[], [{ address: '127.0.0.1', family: 4 }], [{ address: '8.8.8.8', family: 4 }, { address: '192.168.1.2', family: 4 }],
    [{ address: '::1', family: 6 }], [{ address: '8.8.8.8', family: 6 }]]) {
    const d = direct({ addresses }); assert.equal(await d.read(group, '71', options()), undefined); assert.equal(d.downloads.length, 0)
  }
  const literal = direct({ response: message({ message: [video('https://8.8.8.8/video')] }) })
  assert.equal((await literal.read(group, '71', options())).video.mime, 'video/mp4'); assert.equal(literal.lookups.length, 0)
})

test('each redirect has separately validated DNS and numeric pinning; private, credential and downgrade targets fail', async () => {
  for (const location of ['https://redirected.example/clip.webm', '/moved.mp4']) {
    let count = 0
    const d = direct({ request: async () => ++count === 1 ? { status: 302, headers: { location }, body: (async function* () {})(), close() {} } :
      { status: 200, headers: { 'content-type': 'video/mp4' }, body: (async function* () { yield mp4 })(), close() {} } })
    assert.ok(await d.read(group, '71', options())); assert.equal(d.downloads.length, 2); assert.equal(d.lookups.length, 2)
    assert.equal(d.downloads[1].url.hostname, new URL(location, url).hostname)
    assert.deepEqual(d.downloads[1].address, { address: '8.8.8.8', family: 4 })
  }
  for (const location of ['http://redirected.example/clip', 'https://127.0.0.1/private', 'https://user:pass@redirected.example/clip', 'file:///tmp/clip']) {
    const d = direct({ request: async () => ({ status: 302, headers: { location }, body: (async function* () {})(), close() {} }) })
    assert.equal(await d.read(group, '71', options()), undefined); assert.equal(d.downloads.length, 1)
  }
  const loop = direct({ request: async () => ({ status: 302, headers: { location: '/loop' }, body: (async function* () {})(), close() {} }) })
  assert.equal(await loop.read(group, '71', options()), undefined); assert.equal(loop.downloads.length, 4)
})

for (const [label, status, headers, body] of [
  ['partial response', 206, {}, mp4], ['gzip body', 200, { 'content-encoding': 'gzip' }, mp4],
  ['length mismatch', 200, { 'content-length': String(mp4.length + 1) }, mp4], ['oversized length', 200, { 'content-length': '67108865' }, mp4],
  ['HTML MIME', 200, { 'content-type': 'text/html' }, mp4], ['wrong declared video MIME', 200, { 'content-type': 'video/webm' }, mp4],
  ['HTML bytes', 200, { 'content-type': 'video/mp4' }, Buffer.from('<html>not video</html>')],
  ['empty bytes', 200, {}, Buffer.alloc(0)], ['zero length', 200, { 'content-length': '0' }, mp4],
]) test(`${label} is denied rather than forwarded to the model`, async () => {
  const d = direct({ request: async () => ({ status, headers, body: (async function* () { yield body })(), close() {} }) })
  assert.equal(await d.read(group, '71', options()), undefined)
})

test('actual WebM EBML/DocType input is normalized independently from an octet-stream MIME', async () => {
  const d = direct({ request: async () => ({ status: 200, headers: { 'content-type': 'application/octet-stream' }, body: (async function* () { yield webm })(), close() {} }) })
  const result = await d.read(group, '71', options()); assert.equal(result.video.mime, 'video/webm'); assert.equal(result.video.base64, webm.toString('base64'))
})

test('streaming size is bounded even without content-length', async () => {
  let iterations = 0, closed = false
  const d = direct({ request: async () => ({ status: 200, headers: {}, body: (async function* () {
    const chunk = Buffer.alloc(1024 * 1024)
    while (iterations++ < 70) yield chunk
  })(), close() { closed = true } }) })
  assert.equal(await d.read(group, '71', options()), undefined); assert.equal(iterations, 65); assert.equal(closed, true)
})

for (const stage of ['get_msg', 'source policy', 'forward policy', 'dns', 'request', 'stream']) {
  test(`abort releases a held ${stage} and discards every late result`, { timeout: 2500 }, async () => {
    let entered = false, resume, closed = false
    const hold = () => { entered = true; return new Promise(resolve => { resume = resolve }) }, controller = new AbortController()
    const d = direct({
      response: stage === 'get_msg' ? hold : stage === 'forward policy' ? message({ message: [forward('root-id')] }) : message(),
      forwards: { 'root-id': [node()] }, ...(stage === 'dns' ? { addresses: hold } : {}),
      ...(stage === 'request' ? { request: hold } : stage === 'stream' ? { request: async () => ({ status: 200, headers: {},
        body: { [Symbol.asyncIterator]() { return { next: hold, return: async () => ({ done: true }) } } }, close() { closed = true } }) } : {}),
    })
    const pending = d.read(group, '71', options({ signal: controller.signal,
      ...(stage === 'source policy' ? { allowsSource: hold } : stage === 'forward policy' ? { allowsForwardSource: hold } : {}) }))
    await waitFor(() => entered); controller.abort(); assert.equal(await Promise.race([pending, delay(600).then(() => 'timeout')]), undefined)
    resume(stage === 'get_msg' ? message() : stage === 'dns' ? [{ address: '8.8.8.8', family: 4 }] : stage === 'request' ?
      { status: 200, headers: {}, body: (async function* () { yield mp4 })(), close() { closed = true } } : stage === 'stream' ? { done: false, value: mp4 } : true)
    await delay(10)
    assert.equal(d.downloads.length, ['request', 'stream'].includes(stage) ? 1 : 0)
    if (['request', 'stream'].includes(stage)) assert.equal(closed, true)
  })
}

for (const mutation of ['target', 'account', 'guard policy', 'guard current', 'guard signal', 'inspect']) {
  test(`in-flight ${mutation} mutation revokes source access`, async () => {
    const target = { ...group, account: { ...account } }, configuredAccount = { ...account }
    let entered = false, resume
    const guard = options({ inspectOnly: true, allowsSource: async () => { entered = true; return new Promise(resolve => { resume = resolve }) } })
    const d = direct({ configuredAccount }), pending = d.read(target, '71', guard)
    await waitFor(() => entered)
    if (mutation === 'target') target.id = '999999'
    if (mutation === 'account') configuredAccount.id = '999999'
    if (mutation === 'guard policy') guard.allowsSource = async () => true
    if (mutation === 'guard current') guard.isCurrent = () => true
    if (mutation === 'guard signal') guard.signal = new AbortController().signal
    if (mutation === 'inspect') guard.inspectOnly = false
    assert.equal(await Promise.race([pending, delay(600).then(() => 'timeout')]), undefined); resume(true)
    assert.equal(d.downloads.length, 0)
  })
}

test('descriptor snapshots reject accessors, prototypes, cycles and oversized protocol values without invoking getters', async () => {
  let invoked = false
  const accessor = message(); Object.defineProperty(accessor.data, 'message', { enumerable: true, get() { invoked = true; return [video()] } })
  const cycle = message(); cycle.data.cycle = cycle
  const prototype = message(); Object.setPrototypeOf(prototype.data, { inherited: true })
  const huge = message({ message: [text('x'.repeat(128001)), video()] })
  for (const response of [accessor, cycle, prototype, huge]) {
    const d = direct({ response }); assert.equal(await inspect(d), undefined); assert.equal(d.lookups.length, 0)
  }
  assert.equal(invoked, false)
  const d = direct(), guard = options({ inspectOnly: true }); Object.defineProperty(guard, 'allowsSource', { get() { invoked = true; return async () => true } })
  assert.equal(await d.read(group, '71', guard), undefined); assert.equal(invoked, false); assert.equal(d.calls.length, 0)
})

test('API and whole-read deadlines stay bounded, including an uncooperative response cleanup', { timeout: 3500 }, async () => {
  assert.equal(QQ_VIDEO_READ_TIMEOUT_MS, 60000); assert.equal(QQ_VIDEO_API_TIMEOUT_MS, 1500)
  let captured
  const api = direct({ response: (_action, _params, guard) => { captured = guard; return new Promise(() => {}) } }), started = Date.now()
  assert.equal(await Promise.race([api.read(group, '71', options()), delay(2500).then(() => 'timeout')]), undefined)
  assert.ok(Date.now() - started >= 1400); assert.equal(captured.signal.aborted, true)
  const whole = direct({ timeoutMs: 40, addresses: () => new Promise(() => {}) })
  assert.equal(await Promise.race([whole.read(group, '71', options()), delay(500).then(() => 'timeout')]), undefined)
  const cleanup = direct({ request: async () => ({ status: 200, headers: {}, body: (async function* () { yield mp4 })(), close: () => new Promise(() => {}) }) })
  assert.ok(await Promise.race([cleanup.read(group, '71', options()), delay(500).then(() => undefined)]))
})

async function fixture(t, transport) {
  const requests = [], peers = []; let peer, server, endpoint, handler = () => message()
  const attach = socket => {
    peer = socket; peers.push(socket); socket.on('error', () => {})
    socket.on('message', raw => {
      const request = JSON.parse(String(raw)); requests.push(request)
      const response = request.action === 'get_login_info' ? ok({ user_id: account.id, nickname: '视频来源合成验收' }) : handler(request)
      if (response) socket.send(JSON.stringify({ ...response, echo: request.echo }))
    }); return socket
  }
  if (transport === 'forward-websocket') {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening')
    server.on('connection', (socket, request) => { assert.equal(request.headers.authorization, 'Bearer video-fixture'); attach(socket) })
    endpoint = `ws://127.0.0.1:${server.address().port}`
  } else {
    const allocator = createServer(); allocator.listen(0, '127.0.0.1'); await once(allocator, 'listening')
    endpoint = `ws://127.0.0.1:${allocator.address().port}/onebot`; await new Promise(resolve => allocator.close(resolve))
  }
  const adapter = createOneBotConnection({ connection: { id: 'video-local-fixture', account }, transport, url: endpoint, accessToken: 'video-fixture',
    onDisconnect() {}, onReconnect() {}, onError() {}, onEventError() {} })
  t.after(async () => { adapter.stop(); for (const socket of peers) socket.terminate(); if (server) await new Promise(resolve => server.close(resolve)) })
  assert.equal(await adapter.readMessageVideo(group, '71', options()), undefined)
  const started = adapter.start(async () => {}); void started.catch(() => {})
  if (transport === 'reverse-websocket') await waitFor(async () => {
    const socket = attach(new WebSocket(endpoint, { headers: { Authorization: 'Bearer video-fixture', 'X-Self-ID': account.id, 'X-Client-Role': 'Universal' } }))
    try { await once(socket, 'open'); return true } catch { socket.terminate(); return false }
  })
  await started
  return { adapter, requests, socket: () => peer, setHandler(value) { handler = value } }
}

function nativeNetwork(t, { hold = false } = {}) {
  const calls = [], lookups = []
  const dnsMock = t.mock.method(dns, 'lookup', async host => { lookups.push(host); return [{ address: '8.8.8.8', family: 4 }, { address: '2001:4860:4860::8888', family: 6 }] })
  const nativeRequest = https.request
  const requestMock = t.mock.method(https, 'request', (...args) => {
    const [target, config, callback] = args
    if (!(target instanceof URL) || target.hostname !== 'dynamic-video.example') return nativeRequest(...args)
    const request = new EventEmitter(), response = new PassThrough()
    response.statusCode = 200; response.headers = { 'content-type': 'video/mp4', 'content-length': String(mp4.length) }
    const call = { target, config, request, response }; calls.push(call)
    request.destroyed = false
    request.destroy = error => {
      if (!request.destroyed) { request.destroyed = true; response.destroy(); queueMicrotask(() => request.emit('error', error ?? new Error('cancelled'))) }
      return request
    }
    const abort = () => request.destroy(config.signal.reason)
    config.signal.addEventListener('abort', abort, { once: true }); response.once('close', () => config.signal.removeEventListener('abort', abort))
    request.end = () => queueMicrotask(() => { if (request.destroyed) return; callback(response); if (hold) response.write(mp4); else response.end(mp4) })
    return request
  })
  syncBuiltinESMExports()
  t.after(() => { for (const call of calls) call.response.destroy(); dnsMock.mock.restore(); requestMock.mock.restore(); syncBuiltinESMExports() })
  return { calls, lookups }
}

for (const transport of ['forward-websocket', 'reverse-websocket']) {
  test(`${transport} inspects current, reply and nested native forward provenance over real OneBot API frames`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport), network = nativeNetwork(t)
    for (const origin of ['current', 'reply', 'forward']) {
      const authors = [], sources = []
      f.setHandler(request => request.action === 'get_msg' ? request.params.message_id === 71 ? message({ message: origin === 'current' ? [video()] :
        origin === 'reply' ? [quote(70)] : [forward('root-id')] }) : message({ message_id: 70, time: occurredAt / 1000 - 1 }) :
        request.action === 'get_forward_msg' ? ok({ id: request.params.id, messages: request.params.id === 'root-id' ? [node([forward('nested-id')])] :
          [node([video()], { user_id: '456789', time: occurredAt / 1000 - 2 })] }) : undefined)
      const result = await f.adapter.readMessageVideo(group, '71', options({ inspectOnly: true,
        allowsSource: async source => { sources.push(source.messageId); return true },
        allowsForwardSource: async source => { authors.push(source.author.id); assert.equal(source.messageId, undefined); return true } }))
      assert.equal(result.origin, origin); assert.equal(result.video, undefined); assert.match(result.fingerprint, /^[a-f0-9]{64}$/u)
      assert.ok(sources.includes('71')); if (origin === 'reply') assert.ok(sources.includes('70'))
      if (origin === 'forward') assert.deepEqual(authors.slice(0, 2), ['345678', '456789'])
    }
    assert.equal(network.calls.length, 0); assert.equal(network.lookups.length, 0); assert.equal(f.requests.some(request => request.action === 'get_video_info'), false)
  })

  test(`${transport} downloads only the reread native URL with pinned DNS and no cookies or credentials`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport), n = nativeNetwork(t)
    const result = await f.adapter.readMessageVideo(group, '71', options())
    assert.equal(result.video.base64, mp4.toString('base64')); assert.equal(result.video.mime, 'video/mp4')
    assert.equal(f.requests.filter(row => row.action === 'get_msg').length, 3); assert.equal(n.calls.length, 1); assert.deepEqual(n.lookups, ['dynamic-video.example'])
    const { target, config } = n.calls[0]
    assert.equal(target.href, url); assert.equal(config.agent, false); assert.equal(config.headers['Accept-Encoding'], 'identity')
    assert.equal(config.headers.Cookie, undefined); assert.equal(config.headers.Authorization, undefined); assert.equal(config.family, 4)
    config.lookup('dynamic-video.example', {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4) })
  })

  test(`${transport} disconnect cancels a held source API and ignores a late reply from that socket`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport); f.setHandler(() => undefined)
    const pending = f.adapter.readMessageVideo(group, '71', options({ inspectOnly: true }))
    const held = await waitFor(() => f.requests.find(request => request.action === 'get_msg'))
    f.socket().terminate(); assert.equal(await Promise.race([pending, delay(600).then(() => 'timeout')]), undefined)
    assert.ok(held.echo); assert.equal(f.requests.filter(request => request.action === 'get_msg').length, 1)
  })

  test(`${transport} abort cancels native stream and prevents a late policy result from disclosing bytes`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport), n = nativeNetwork(t, { hold: true }), controller = new AbortController()
    const pending = f.adapter.readMessageVideo(group, '71', options({ signal: controller.signal }))
    await waitFor(() => n.calls.length); controller.abort()
    assert.equal(await Promise.race([pending, delay(600).then(() => 'timeout')]), undefined); assert.equal(n.calls[0].request.destroyed, true)
    let entered = false, resume
    const policyController = new AbortController(), policy = f.adapter.readMessageVideo(group, '71', options({ inspectOnly: true, signal: policyController.signal,
      allowsSource: async () => { entered = true; return new Promise(resolve => { resume = resolve }) } }))
    await waitFor(() => entered); policyController.abort(); assert.equal(await policy, undefined); resume(true); await delay(10)
    assert.equal(n.calls.length, 1)
  })
}
