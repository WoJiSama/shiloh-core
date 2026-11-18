import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import WebSocket, { WebSocketServer } from 'ws'

const root = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || root)
const sourceTest = process.env.BL_CHAT_AGENT_SOURCE_TEST === '1', ts = sourceTest ? (await import('typescript')).default : undefined, urls = new Map()
function moduleUrl(relative) {
  if (!sourceTest) return pathToFileURL(path.join(release, relative.replace(/^src\//u, 'dist/backend/').replace(/\.ts$/u, '.js'))).href
  if (urls.has(relative)) return urls.get(relative)
  const fresh = new Set(['qqBilibiliAuthDelivery', 'oneBotConnection'])
  const compiled = ts.transpileModule(readFileSync(path.join(root, relative), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  const code = compiled.replace(/(\bfrom\s+)(['"])([^'"]+)\2/gu, (_all, from, quote, specifier) => {
    if (!specifier.startsWith('.')) return `${from}${quote}${specifier.startsWith('node:') ? specifier : import.meta.resolve(specifier)}${quote}`
    const dependency = path.relative(root, path.resolve(root, path.dirname(relative), specifier))
    return `${from}${quote}${fresh.has(path.basename(dependency, '.js')) ? moduleUrl(dependency.replace(/\.js$/u, '.ts')) : pathToFileURL(path.join(root, dependency.replace(/^src\//u, 'dist/backend/'))).href}${quote}`
  })
  const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`; urls.set(relative, url); return url
}
const { createQqBilibiliAuthDeliveryPort, QQ_BILIBILI_AUTH_TIMEOUT_MS } = await import(moduleUrl('src/adapters/qqBilibiliAuthDelivery.ts'))
const { createOneBotConnection } = await import(moduleUrl('src/adapters/oneBotConnection.ts'))
const qr = createRequire(import.meta.url)('qrcode'), PNG = await qr.toBuffer('synthetic requester QR', { type: 'png', width: 480, margin: 2 })
const account = { platform: 'qq', namespace: 'global', id: '123456789' }, author = { platform: 'qq', namespace: 'global', id: '778899' }
const target = { account, kind: 'group', id: '315320' }, AT = 1790000000000, TEXT = '请给我B站授权二维码'
const bindingFor = (destination = target) => ({ source: 'configured', id: 'auth-binding', revision: 'r1', personaId: 'default', agentId: 'alice', connectionId: 'auth-local', target: destination })
const sourceFor = (destination = target) => ({ target: destination, messageId: '912345', author, occurredAt: AT, textSha256: createHash('sha256').update(TEXT).digest('hex') })
const action = (overrides = {}) => ({ version: 1, kind: 'bilibili-auth.notify', binding: bindingFor(), source: sourceFor(), content: { kind: 'qr', mime: 'image/png', base64: PNG.toString('base64') }, ...overrides })
const sourceReply = (destination = target, changes = {}) => ({ status: 'ok', retcode: 0, data: { message_id: 912345, self_id: account.id, message_type: destination.kind, user_id: author.id, sender: { user_id: author.id },
  ...(destination.kind === 'group' ? { group_id: destination.id } : {}), time: AT / 1000, message: [{ type: 'at', data: { qq: account.id } }, { type: 'text', data: { text: TEXT } }], raw_message: `[CQ:at,qq=${account.id}]${TEXT}`, ...changes } })
const success = (id = 6789) => ({ status: 'ok', retcode: 0, data: { message_id: id } })
const live = (changes = {}) => ({ signal: new AbortController().signal, isCurrent: () => true, ...changes })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function waitFor(probe, timeout = 3500) { const until = Date.now() + timeout; while (Date.now() < until) { const value = await probe(); if (value) return value; await delay(5) }; assert.fail('auth fixture did not settle') }
function direct(settings = {}) {
  const reads = [], sends = [], hostAccount = settings.account ?? { ...account }
  const send = createQqBilibiliAuthDeliveryPort({ account: hostAccount, connectionId: 'auth-local', ...(settings.allowsText ? { allowsText: settings.allowsText } : {}),
    async readApi(name, params, guard) { reads.push({ name, params, guard }); return settings.read ? settings.read(name, params, guard, reads.length) : sourceReply(settings.target ?? target) },
    async sendApi(name, params, guard) { sends.push({ name, params, guard }); return settings.send ? settings.send(name, params, guard) : Object.hasOwn(settings, 'receipt') ? settings.receipt : success() },
  })
  return { reads, sends, hostAccount, send }
}

test('verified group request sends one QR privately to its fixed original author using TEMP group context', async () => {
  const f = direct(); assert.deepEqual(await f.send(action(), live()), { state: 'sent', messageId: '6789' })
  assert.equal(f.reads.length, 2); assert.ok(f.reads.every(row => row.name === 'get_msg' && row.params.message_id === '912345'))
  assert.equal(f.sends.length, 1); const sent = f.sends[0]; assert.equal(sent.name, 'send_private_msg')
  assert.deepEqual(sent.params, { user_id: author.id, group_id: target.id, message: [{ type: 'image', data: { file: `base64://${PNG.toString('base64')}` } }] })
  assert.equal(QQ_BILIBILI_AUTH_TIMEOUT_MS, 30000); assert.ok(Object.isFrozen(sent.params)); assert.ok(Object.isFrozen(sent.params.message[0].data)); assert.equal(sent.guard.signal.aborted, true)
})

test('private request sends only to the proven author without any group context or optional target', async () => {
  const destination = { account, kind: 'private', id: author.id }, f = direct({ target: destination })
  assert.deepEqual(await f.send(action({ binding: bindingFor(destination), source: sourceFor(destination), content: { kind: 'text', text: 'B站授权已完成。' } }), live()), { state: 'sent', messageId: '6789' })
  assert.deepEqual(f.sends[0].params, { user_id: author.id, message: [{ type: 'text', data: { text: 'B站授权已完成。' } }] })
  const rejected = direct(); for (const extra of [{ user_id: '99999' }, { target: { ...target, id: '99999' } }, { recipient: '99999' }]) assert.equal((await rejected.send(action(extra), live())).state, 'failed')
  assert.equal(rejected.reads.length, 0); assert.equal(rejected.sends.length, 0)
})

test('source must match real get_msg author, account, conversation, timestamp, unquoted text and SHA256 before dispatch', async () => {
  const changes = [
    { user_id: '99999' }, { sender: { user_id: '99999' } }, { self_id: '99999' }, { message_id: '912346' }, { group_id: '99999' }, { time: AT / 1000 + 1 },
    { message_type: 'private' }, { raw_message: 'different request' }, { message: [{ type: 'image', data: { file: 'remote' } }], raw_message: TEXT },
    { message: [{ type: 'reply', data: { id: '111' } }, { type: 'text', data: { text: TEXT } }], raw_message: TEXT },
  ]
  for (const value of changes) { const f = direct({ read: () => sourceReply(target, value) }); assert.equal((await f.send(action(), live())).state, 'failed'); assert.equal(f.sends.length, 0) }
  const f = direct(); assert.equal((await f.send(action({ source: { ...sourceFor(), textSha256: 'f'.repeat(64) } }), live())).state, 'failed'); assert.equal(f.sends.length, 0)
  const cq = direct({ read: () => sourceReply(target, { message: `[CQ:at,qq=${account.id}]${TEXT}` }) }); assert.equal((await cq.send(action(), live())).state, 'sent')
})

test('source and binding validation rejects fabricated owners, private recipient swaps and noncanonical QQ identities', async () => {
  const f = direct()
  for (const replacement of [
    { source: { ...sourceFor(), author: account } }, { source: { ...sourceFor(), author: { ...author, namespace: 'other' } } },
    { source: { ...sourceFor(), target: { ...target, id: 'other' } } }, { source: { ...sourceFor(), messageId: '0' } },
    { source: { ...sourceFor(), occurredAt: 0 } }, { source: { ...sourceFor(), textSha256: 'bad' } },
    { binding: { ...bindingFor(), connectionId: 'other' } }, { binding: { ...bindingFor(), source: 'legacy' } },
    { binding: { ...bindingFor(), target: { ...target, account: { ...account, id: '999999' } } } },
  ]) assert.equal((await f.send(action(replacement), live())).state, 'failed')
  const privateTarget = { account, kind: 'private', id: '999999' }
  assert.equal((await f.send(action({ binding: bindingFor(privateTarget), source: sourceFor(privateTarget) }), live())).state, 'failed')
  assert.equal(f.reads.length, 0); assert.equal(f.sends.length, 0)
})

test('auth content rejects arbitrary native segments, accessors/proxies, unsafe text and secret text without invoking traps', async () => {
  let touched = false; const getter = { ...action() }; Object.defineProperty(getter, 'content', { get() { touched = true; return action().content }, enumerable: true })
  const proxy = new Proxy(action(), { ownKeys() { touched = true; throw Error('trap') } }), f = direct({ allowsText: text => !text.includes('HOST_SECRET') })
  for (const input of [getter, proxy, action({ content: { kind: 'qr', mime: 'image/png', base64: PNG.toString('base64'), user_id: '99999' } }),
    action({ content: { kind: 'text', text: 'HOST_SECRET' } }), action({ content: { kind: 'text', text: '' } }), action({ content: { kind: 'text', text: 'x'.repeat(2001) } }),
    action({ content: { kind: 'json', data: '{}' } }), action({ content: { kind: 'qr', mime: 'image/jpeg', base64: PNG.toString('base64') } }),
  ]) assert.equal((await f.send(input, live())).state, 'failed')
  assert.equal(touched, false); assert.equal(f.reads.length, 0); assert.equal(f.sends.length, 0)
})

test('QR accepts bounded canonical inline PNG and rejects over 2MiB, remote paths and oversized canvases', async () => {
  const f = direct(), huge = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024 + 1 - PNG.length)]), canvas = Buffer.from(PNG); canvas.writeUInt32BE(2049, 16)
  const tall = Buffer.from(PNG); tall.writeUInt32BE(2049, 20)
  for (const base64 of [huge.toString('base64'), 'https://example.com/qr.png', '/tmp/qr.png', 'base64://' + PNG.toString('base64'), PNG.toString('base64') + '\n', canvas.toString('base64'), tall.toString('base64')]) assert.equal((await f.send(action({ content: { kind: 'qr', mime: 'image/png', base64 } }), live())).state, 'failed')
  assert.equal(f.reads.length, 0); assert.equal(f.sends.length, 0)
})

test('send receipts without a real native ID, handler failures or mismatched author/account remain unknown', async () => {
  for (const response of [null, {}, success(0), success('0001'), success('echo-uuid'), success(Number.MAX_SAFE_INTEGER + 1),
    { ...success(), retcode: '0' }, { ...success(), data: { message_id: 1, user_id: '99999' } }, { ...success(), data: { message_id: 1, self_id: '99999' } },
    { ...success(), data: { message_id: 1, group_id: target.id } }, { status: 'failed', retcode: 1200 },
  ]) { const f = direct({ receipt: response }); assert.deepEqual(await f.send(action(), live()), { state: 'unknown' }); assert.equal(f.sends.length, 1) }
  const throwing = direct({ send: () => { throw Error('socket error after dispatch') } }); assert.deepEqual(await throwing.send(action(), live()), { state: 'unknown' }); assert.equal(throwing.sends.length, 1)
  for (const code of [400, 1400]) { const f = direct({ receipt: { status: 'failed', retcode: code } }); assert.deepEqual(await f.send(action(), live()), { state: 'failed', code: String(code) }) }
})

test('source recall before send fails; changed or recalled source after send becomes unknown', async () => {
  const before = direct({ read: () => ({ status: 'failed', retcode: 1400 }) }); assert.equal((await before.send(action(), live())).state, 'failed'); assert.equal(before.sends.length, 0)
  for (const change of ['recall', 'text', 'fingerprint']) {
    const f = direct({ read: (_name, _params, _guard, count) => count === 1 ? sourceReply() : change === 'recall' ? { status: 'failed', retcode: 1400 } : sourceReply(target, change === 'text' ? { raw_message: 'changed' } : { raw_message: TEXT }) })
    assert.deepEqual(await f.send(action(), live()), { state: 'unknown' }); assert.equal(f.sends.length, 1)
  }
})

test('host and socket guards abort before native send, and uncertainty after dispatch never retries a late success', async () => {
  const aborted = new AbortController(); aborted.abort(); const before = direct()
  for (const guard of [live({ signal: aborted.signal }), live({ isCurrent: () => false }), {}, null, { signal: {} }]) assert.equal((await before.send(action(), guard)).state, 'failed')
  assert.equal(before.sends.length, 0)
  for (const mode of ['signal', 'guard', 'account']) {
    const entered = deferred(), late = deferred(), controller = new AbortController(); let current = true
    const f = direct({ send: () => { entered.resolve(); return late.promise } }), pending = f.send(action(), live({ signal: controller.signal, isCurrent: () => current })); await entered.promise
    if (mode === 'signal') controller.abort(); else if (mode === 'guard') current = false; else f.hostAccount.id = '99999'
    assert.deepEqual(await Promise.race([pending, delay(400).then(() => 'timeout')]), { state: 'unknown' }); late.resolve(success()); assert.equal(f.sends.length, 1); assert.equal(f.sends[0].guard.signal.aborted, true)
  }
})

async function fixture(t, transport, settings = {}) {
  const requests = [], peers = [], events = []; let peer, server, url, handler = request => request.action === 'get_msg' ? sourceReply() : success(),
    friendReply = { status: 'ok', retcode: 0, self_id: account.id, data: [{ user_id: author.id }] }
  const attach = socket => { peer = socket; peers.push(socket); socket.on('error', () => {}); socket.on('message', raw => {
    const request = JSON.parse(String(raw)); requests.push(request)
    const response = request.action === 'get_login_info' ? { status: 'ok', retcode: 0, data: { user_id: account.id, nickname: '授权合成验收' } }
      : request.action === 'get_friend_list' ? friendReply : handler(request)
    if (response) socket.send(JSON.stringify({ ...response, echo: request.echo }))
  }); return socket }
  if (transport === 'forward-websocket') { server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening'); server.on('connection', (socket, request) => { assert.equal(request.headers.authorization, 'Bearer auth-fixture'); attach(socket) }); url = `ws://127.0.0.1:${server.address().port}` }
  else { const allocator = createServer(); allocator.listen(0, '127.0.0.1'); await once(allocator, 'listening'); url = `ws://127.0.0.1:${allocator.address().port}/onebot`; await new Promise(resolve => allocator.close(resolve)) }
  const adapter = createOneBotConnection({ connection: { id: 'auth-local', account }, transport, url, accessToken: 'auth-fixture', ...(settings.allowsText ? { bilibiliAuth: { allowsText: settings.allowsText } } : {}), onDisconnect() {}, onReconnect() {}, onError() {}, onEventError() {} })
  t.after(async () => { adapter.stop(); for (const socket of peers) socket.terminate(); if (server) await new Promise(resolve => server.close(resolve)) })
  assert.equal((await adapter.actions.sendRequesterBilibiliAuth(action(), live())).state, 'failed')
  const start = adapter.start(async event => { events.push(event) }); void start.catch(() => {})
  if (transport === 'reverse-websocket') await waitFor(async () => { const socket = attach(new WebSocket(url, { headers: { Authorization: 'Bearer auth-fixture', 'X-Self-ID': account.id, 'X-Client-Role': 'Universal' } })); try { await once(socket, 'open'); return true } catch { socket.terminate(); return false } })
  await start; return { adapter, requests, events, peer: () => peer, setHandler(next) { handler = next }, setFriendReply(next) { friendReply = next },
    async reconnect() { if (transport === 'reverse-websocket') { const next = attach(new WebSocket(url, { headers: { Authorization: 'Bearer auth-fixture', 'X-Self-ID': account.id, 'X-Client-Role': 'Universal' } })); await once(next, 'open') }; await waitFor(() => requests.filter(row => row.action === 'get_login_info').length >= 2 && adapter.isReady()) },
  }
}
for (const transport of ['forward-websocket', 'reverse-websocket']) {
  test(`${transport} private auth readMessage matches friend ingress and preserves normalized quote markers`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport), destination = { account, kind: 'private', id: author.id }, command = '.B站授权 状态'
    const variants = [
      { message: [{ type: 'text', data: { text: command } }], raw_message: command },
      { time: String(AT / 1000), message: command, raw_message: command },
      { message: [{ type: 'reply', data: { id: '111', qq: '99999', text: '不可信引用' } }, { type: 'text', data: { text: command } }], raw_message: `[CQ:reply,id=111]${command}` },
      { message: `[CQ:reply,id=111,qq=99999]${command}`, raw_message: `[CQ:reply,id=111]${command}` },
      { message: [{ type: 'reply', data: {} }, { type: 'text', data: { text: command } }], raw_message: command },
    ]
    for (const [index, variant] of variants.entries()) {
      const response = sourceReply(destination, { sub_type: 'friend', ...variant })
      f.setHandler(request => request.action === 'get_msg' ? response : success())
      f.peer().send(JSON.stringify({ post_type: 'message', ...response.data }))
      await waitFor(() => f.events.length === index + 1)
      const read = await f.adapter.readMessage(destination, '912345', live())
      assert.deepEqual(read, f.events[index].message, 'authoritative read must have the same shape as ingress')
      assert.equal(read.text, command); assert.equal(read.sender.id, destination.id); assert.equal(read.occurredAt, AT)
      if (index >= 2) { assert.deepEqual(read.quote, index === 4 ? { parts: [] } : { parts: [], messageId: '111' }); assert.equal(read.quote.author, undefined); assert.equal(read.quote.text, undefined) }
    }
    f.setHandler(request => request.action === 'get_msg' ? sourceReply(destination, { sub_type: undefined, user_id: undefined,
      message: [{ type: 'text', data: { text: command } }], raw_message: command }) : success())
    assert.equal((await f.adapter.readMessage(destination, '912345', live())).text, command, 'standard get_msg uses sender identity with fresh friend proof')
    assert.equal(f.requests.filter(row => row.action === 'get_friend_list').length, variants.length + 1)
    f.setHandler(request => request.action === 'get_msg' ? sourceReply() : success())
    const group = await f.adapter.readMessage(target, '912345', live()); assert.equal(group.conversation.kind, 'group'); assert.equal(group.text, TEXT)
  })
  test(`${transport} private auth readMessage rejects TEMP sources and mismatched identity, time, scope or liveness`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport), destination = { account, kind: 'private', id: author.id }, command = '.B站授权 登录'
    const valid = () => sourceReply(destination, { sub_type: 'friend', message: [{ type: 'text', data: { text: command } }], raw_message: command })
    const invalid = [
      { sub_type: 'group' }, { sub_type: 'other' }, { group_id: target.id }, { group_id: 0 }, { temp_source: 0 }, { isGroup: true },
      { message_type: 'group' }, { user_id: '99999' }, { user_id: account.id }, { sender: { user_id: '99999' } }, { sender: {} },
      { sender: { user_id: author.id, group_id: target.id } }, { self_id: '99999' }, { self_id: ` ${account.id}` }, { message_id: '912346' }, { message_id: ' 912345' }, { message_id: '0912345' },
      { time: 0 }, { time: -1 }, { time: 'invalid' }, { time: Number.MAX_SAFE_INTEGER }, { message: null },
    ]
    for (const changes of invalid) {
      const response = valid(); Object.assign(response.data, changes); f.setHandler(request => request.action === 'get_msg' ? response : success())
      assert.equal(await f.adapter.readMessage(destination, '912345', live()), undefined, JSON.stringify(changes))
    }
    for (const response of [{ ...valid(), self_id: '99999' }, { ...valid(), status: 'failed' }, { ...valid(), retcode: '0' }]) {
      f.setHandler(request => request.action === 'get_msg' ? response : success()); assert.equal(await f.adapter.readMessage(destination, '912345', live()), undefined)
    }
    f.setHandler(request => request.action === 'get_msg' ? valid() : success())
    const before = f.requests.length, cancel = new AbortController(); cancel.abort()
    for (const [selected, guard] of [[{ ...destination, account: { ...account, namespace: 'other' } }, live()], [{ ...destination, id: account.id }, live()], [destination, live({ isCurrent: () => false })], [destination, live({ signal: cancel.signal })]]) assert.equal(await f.adapter.readMessage(selected, '912345', guard), undefined)
    assert.equal(f.requests.length, before)
    assert.equal((await f.adapter.readMessage(destination, '912345', live()))?.text, command)
  })
  test(`${transport} private auth readMessage requires a bounded current friend proof and cancels list reads across sockets`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport), destination = { account, kind: 'private', id: author.id }
    f.setHandler(request => request.action === 'get_msg' ? sourceReply(destination, { sub_type: undefined }) : success())
    const good = { status: 'ok', retcode: 0, self_id: account.id, data: [{ user_id: author.id }] }
    for (const response of [{ ...good, data: [] }, { ...good, data: [{ user_id: '99999' }] }, { ...good, data: [{ user_id: author.id }, { user_id: author.id }] },
      { ...good, self_id: '99999' }, { ...good, data: [{ user_id: author.id, self_id: '99999' }] }, { ...good, data: [{ user_id: `0${author.id}` }] },
      { ...good, data: { user_id: author.id } }, { ...good, data: Array.from({ length: 10001 }, (_, i) => ({ user_id: String(i + 1) })) },
      { ...good, complete: false }, { ...good, truncated: true }, { ...good, has_more: true }, { ...good, status: 'failed' }, { ...good, retcode: '0' }]) {
      f.setFriendReply(response); const before = f.requests.filter(row => row.action === 'get_msg').length
      assert.equal(await f.adapter.readMessage(destination, '912345', live()), undefined)
      assert.equal(f.requests.filter(row => row.action === 'get_msg').length, before)
    }
    f.setFriendReply(undefined)
    const before = f.requests.length, pending = f.adapter.readMessage(destination, '912345', live())
    await waitFor(() => f.requests.slice(before).some(row => row.action === 'get_friend_list')); f.peer().terminate(); assert.equal(await pending, undefined)
    assert.equal(f.requests.slice(before).some(row => row.action === 'get_msg'), false)
    f.setFriendReply(good); await f.reconnect(); assert.ok(await f.adapter.readMessage(destination, '912345', live()))
  })
  test(`${transport} private auth re-read cannot outlive its exact target, guard or socket`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport), destination = { account: { ...account }, kind: 'private', id: author.id }, command = '.B站授权 状态'
    const reply = () => sourceReply({ account, kind: 'private', id: author.id }, { sub_type: 'friend', message: [{ type: 'text', data: { text: command } }] })
    let current = true
    for (const mode of ['guard', 'target', 'account', 'abort']) {
      f.setHandler(() => undefined)
      const before = f.requests.length, controller = new AbortController(), pending = f.adapter.readMessage(destination, '912345', live({ signal: controller.signal, isCurrent: () => current }))
      const request = await waitFor(() => f.requests.slice(before).find(row => row.action === 'get_msg'))
      if (mode === 'guard') current = false
      else if (mode === 'target') destination.id = '99999'
      else if (mode === 'account') destination.account.namespace = 'other'
      else controller.abort()
      f.peer().send(JSON.stringify({ ...reply(), echo: request.echo }))
      assert.equal(await pending, undefined)
      current = true; destination.id = author.id; destination.account.namespace = 'global'
    }
    f.setHandler(() => undefined)
    const before = f.requests.length, pending = f.adapter.readMessage(destination, '912345', live())
    await waitFor(() => f.requests.slice(before).some(row => row.action === 'get_msg')); f.peer().terminate()
    assert.equal(await pending, undefined); f.setHandler(request => request.action === 'get_msg' ? reply() : success()); await f.reconnect()
    assert.equal((await f.adapter.readMessage(destination, '912345', live()))?.text, command)
  })
  test(`${transport} verifies get_msg twice and sends TEMP QR only to the original author`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport); assert.deepEqual(await f.adapter.actions.sendRequesterBilibiliAuth(action(), live()), { state: 'sent', messageId: '6789' })
    const sent = f.requests.filter(row => row.action !== 'get_login_info'); assert.deepEqual(sent.map(row => row.action), ['get_msg', 'send_private_msg', 'get_msg'])
    assert.equal(sent[1].params.user_id, author.id); assert.equal(sent[1].params.group_id, target.id); assert.equal(sent[1].params.message[0].type, 'image')
  })
  test(`${transport} verifies a private request and omits TEMP group fields from the private notice`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport), destination = { account, kind: 'private', id: author.id }
    f.setHandler(request => request.action === 'get_msg' ? sourceReply(destination) : success())
    assert.deepEqual(await f.adapter.actions.sendRequesterBilibiliAuth(action({ binding: bindingFor(destination), source: sourceFor(destination), content: { kind: 'text', text: 'B站授权已完成。' } }), live()), { state: 'sent', messageId: '6789' })
    const sent = f.requests.find(row => row.action === 'send_private_msg'); assert.equal(sent.params.user_id, author.id); assert.equal(Object.hasOwn(sent.params, 'group_id'), false)
  })
  test(`${transport} enforces live host text secrets while its dedicated QR field remains deliverable`, { timeout: 8000 }, async t => {
    const secrets = [PNG.toString('base64'), 'HOST_PRIVATE_SECRET'], f = await fixture(t, transport, { allowsText: text => !secrets.some(secret => text.includes(secret)) })
    assert.equal((await f.adapter.actions.sendRequesterBilibiliAuth(action(), live())).state, 'sent')
    const before = f.requests.length
    assert.equal((await f.adapter.actions.sendRequesterBilibiliAuth(action({ content: { kind: 'text', text: 'HOST_PRIVATE_SECRET' } }), live())).state, 'failed')
    assert.equal(f.requests.length, before)
    const terminal = 'B站授权已完成。'; secrets.push(terminal)
    assert.equal((await f.adapter.actions.sendRequesterBilibiliAuth(action({ content: { kind: 'text', text: terminal } }), live())).state, 'failed')
    assert.equal(f.requests.length, before); assert.equal(f.requests.filter(row => row.action === 'send_private_msg').length, 1)
  })
  test(`${transport} loss of the original socket during source verification cannot publish on a new authenticated socket`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport); f.setHandler(() => undefined)
    const pending = f.adapter.actions.sendRequesterBilibiliAuth(action(), live()); await waitFor(() => f.requests.some(row => row.action === 'get_msg'))
    f.peer().terminate(); assert.equal((await pending).state, 'failed')
    f.setHandler(request => request.action === 'get_msg' ? sourceReply() : success()); await f.reconnect(); await delay(40)
    assert.equal(f.requests.filter(row => row.action === 'send_private_msg').length, 0)
  })
  for (const mode of ['abort', 'stop', 'disconnect', 'binding']) test(`${transport} ${mode} after dispatch stays unknown and never moves the QR to another socket`, { timeout: 8000 }, async t => {
    const f = await fixture(t, transport), controller = new AbortController(); let current = true
    f.setHandler(request => request.action === 'get_msg' ? sourceReply() : undefined)
    const pending = f.adapter.actions.sendRequesterBilibiliAuth(action(), live({ signal: controller.signal, isCurrent: () => current })), request = await waitFor(() => f.requests.find(row => row.action === 'send_private_msg'))
    if (mode === 'abort') controller.abort(); else if (mode === 'stop') f.adapter.stop(); else if (mode === 'disconnect') f.peer().terminate(); else current = false
    assert.deepEqual(await Promise.race([pending, delay(600).then(() => 'timeout')]), { state: 'unknown' })
    if (f.peer().readyState === WebSocket.OPEN) f.peer().send(JSON.stringify({ ...success(7777), echo: request.echo }))
    await delay(10); assert.equal(f.requests.filter(row => row.action === 'send_private_msg').length, 1)
  })
}

test('an actual 30s adapter deadline leaves dispatched QR unknown and never retries', { timeout: 35000 }, async () => {
  const f = direct({ send: () => new Promise(() => {}) }), before = Date.now()
  assert.deepEqual(await f.send(action(), live()), { state: 'unknown' }); assert.ok(Date.now() - before >= 29000); assert.equal(f.sends.length, 1); assert.equal(f.sends[0].guard.signal.aborted, true)
})
