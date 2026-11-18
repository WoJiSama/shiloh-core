import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket, { WebSocketServer } from 'ws'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'

const { createQqInteractionDeliveryPort, QQ_INTERACTION_TIMEOUT_MS } = await importBilibiliHost('adapters/qqInteractionDelivery.js')
const { queuedDeliveryAllowed } = await importBilibiliHost('modules/messaging/infrastructure/deliveryScope.js')
const { createOneBotConnection } = await importBilibiliHost('adapters/oneBotConnection.js')
const account = { platform: 'qq', namespace: 'global', id: '123456789' }
const user = { platform: 'qq', namespace: 'global', id: '324152' }
const target = { account, kind: 'group', id: '315320' }
const binding = { source: 'configured', id: 'interaction-fixture', revision: 'r1', personaId: 'default', agentId: 'alice', connectionId: 'interaction-local', target }
const requester = { ...user, id: '324153' }
const interactions = {
  poke: { kind: 'poke', user },
  'profile-like': { kind: 'profile-like', user, count: 3 },
  'message-reaction': { kind: 'message-reaction', messageId: '-42', emojiId: '128077' },
}
function action(kind = 'poke', extra = {}) {
  const ownAccount = { ...account }, ownTarget = { ...target, account: ownAccount }
  return { version: 1, kind: 'conversation.interact', target: ownTarget, binding: { ...binding, target: ownTarget }, interaction: structuredClone(interactions[kind]), ...extra }
}
const ok = (data = null, extra = {}) => ({ status: 'ok', retcode: 0, data, ...extra })
const member = (extra = {}) => ({ group_id: target.id, user_id: user.id, ...extra })
const message = (extra = {}) => ({ message_type: 'group', group_id: target.id, message_id: -42, user_id: user.id, sender: { user_id: user.id }, time: Math.floor(Date.now() / 1000) - 10, ...extra })
const isQuery = native => native === 'get_group_member_info' || native === 'get_msg'
function direct(handler, options = {}) {
  const calls = [], interact = createQqInteractionDeliveryPort({ account, connectionId: binding.connectionId, isReady: () => true,
    async callApi(native, params, scope) {
      calls.push({ native, params, scope })
      return handler ? handler(native, params, scope) : isQuery(native) ? ok(native === 'get_msg' ? message() : member()) : ok()
    }, ...options })
  return { calls, interact }
}
async function waitFor(probe) {
  const until = Date.now() + 5000
  while (Date.now() < until) { const result = probe(); if (result) return result; await delay(5) }
  assert.fail('interaction fixture did not settle')
}

for (const kind of Object.keys(interactions)) test(`QQ ${kind} proves the fixed group source then dispatches one native effect`, async () => {
  const d = direct(), input = action(kind)
  assert.deepEqual(await d.interact(input), { state: 'confirmed' })
  assert.equal(QQ_INTERACTION_TIMEOUT_MS, 30000)
  const expected = kind === 'poke' ? { native: 'send_group_poke', params: { group_id: target.id, user_id: user.id } }
    : kind === 'profile-like' ? { native: 'send_like', params: { user_id: user.id, times: 3 } }
      : { native: 'set_msg_emoji_like', params: { message_id: '-42', emoji_id: '128077' } }
  assert.deepEqual(d.calls.map(({ native, params }) => ({ native, params })), [
    kind === 'message-reaction' ? { native: 'get_msg', params: { message_id: -42 } }
      : { native: 'get_group_member_info', params: { group_id: target.id, user_id: user.id, no_cache: true } }, expected,
  ])
  for (const { params, scope } of d.calls) {
    assert.ok(Object.isFrozen(params)); assert.ok(Object.isFrozen(scope))
    assert.ok(scope.signal instanceof AbortSignal); assert.equal(typeof scope.ensureCurrent, 'function')
    assert.ok(scope.timeoutMs > 0 && scope.timeoutMs <= QQ_INTERACTION_TIMEOUT_MS)
  }
})

test('each member interaction obtains fresh native membership evidence without a cached or alternate path', async () => {
  const d = direct()
  assert.equal((await d.interact(action())).state, 'confirmed')
  assert.equal((await d.interact(action())).state, 'confirmed')
  assert.deepEqual(d.calls.map(row => row.native), ['get_group_member_info', 'send_group_poke', 'get_group_member_info', 'send_group_poke'])
})

test('QQ interaction rejects changed platform, account, group, binding, native fields and malformed operations before native queries', async () => {
  const d = direct()
  for (const patch of [
    { target: { ...target, kind: 'private' } }, { target: { ...target, id: '0315320' } }, { target: { ...target, id: 315320 } },
    { target: { ...target, account: { ...account, id: '999999' } } }, { target: { ...target, account: { ...account, namespace: 'other' } } },
    { binding: undefined }, { binding: { ...binding, connectionId: 'other' } }, { binding: { ...binding, revision: '' } },
    { binding: { ...binding, target: { ...target, id: '999999' } } }, { binding: { ...binding, native: true } },
    { interaction: { kind: 'poke', user: { ...user, platform: 'other' } } }, { interaction: { kind: 'poke', user: { ...user, namespace: 'other' } } },
    { interaction: { kind: 'poke', user: { ...user, id: '0324152' } } }, { interaction: { kind: 'poke', user, count: 1 } },
    { interaction: { kind: 'profile-like', user, count: 0 } }, { interaction: { kind: 'profile-like', user, count: 21 } },
    { interaction: { kind: 'profile-like', user, count: 1.5 } }, { interaction: { kind: 'message-reaction', messageId: '2147483648', emojiId: '128077' } },
    { interaction: { kind: 'message-reaction', messageId: '-042', emojiId: '128077' } },
    { interaction: { kind: 'message-reaction', messageId: '-42', emojiId: 'native-action' } },
    { interaction: { kind: 'send_like', user } }, { nativeAction: 'send_like' }, { group_id: '999999' },
  ]) assert.equal((await d.interact(action('poke', patch))).state, 'failed', JSON.stringify(patch))
  assert.equal(d.calls.length, 0)
})

test('QQ interaction rejects getters and Proxy inputs, guards, functions and signals without executing traps', async () => {
  const d = direct(); let touched = 0
  const proxy = value => new Proxy(value, { get() { touched++; throw Error('trap') }, ownKeys() { touched++; throw Error('trap') }, getPrototypeOf() { touched++; throw Error('trap') }, apply() { touched++; throw Error('trap') } })
  const accessor = { ...interactions.poke }; Object.defineProperty(accessor, 'user', { enumerable: true, get() { touched++; return user } })
  const accountAccessor = { ...account }; Object.defineProperty(accountAccessor, 'id', { enumerable: true, get() { touched++; return account.id } })
  for (const input of [proxy(action()), action('poke', { interaction: accessor }), action('poke', { interaction: proxy(interactions.poke) }),
    action('poke', { binding: proxy(binding) }), action('poke', { target: { ...target, account: accountAccessor } }),
  ]) assert.equal((await d.interact(input)).state, 'failed')
  const ownSignal = new AbortController().signal
  Object.defineProperty(ownSignal, 'aborted', { get() { touched++; return false } })
  for (const guard of [null, [], proxy({}), { get isCurrent() { touched++; return () => true } },
    { get ensureCurrent() { touched++; return async () => {} } }, { get signal() { touched++; return new AbortController().signal } },
    { isCurrent: proxy(() => true) }, { ensureCurrent: proxy(async () => {}) }, { signal: proxy(new AbortController().signal) },
    { signal: ownSignal }, { isCurrent: true }, { ensureCurrent: true }, { signal: {} }, { signal: Object.create(AbortSignal.prototype) }, { extra: true },
  ]) assert.equal((await d.interact(action(), guard)).state, 'failed')
  assert.equal(touched, 0); assert.equal(d.calls.length, 0)
})

test('not-ready, already cancelled and revoked guards never make a native query', async () => {
  const controller = new AbortController(); controller.abort()
  const d = direct()
  for (const guard of [{ signal: controller.signal }, { isCurrent: () => false }, { isCurrent() { throw Error('revoked') } }]) assert.equal((await d.interact(action(), guard)).state, 'failed')
  assert.equal(d.calls.length, 0)
  for (const isReady of [() => false, () => undefined, () => { throw Error('disconnected') }]) {
    const notReady = direct(undefined, { isReady }); assert.equal((await notReady.interact(action())).state, 'failed'); assert.equal(notReady.calls.length, 0)
  }
})

test('member proof requires a native strict success and the exact user, group and any reported self ID', async () => {
  for (const proof of [null, {}, ok(null), ok({ user_id: user.id }), ok(member({ group_id: '999999' })), ok(member({ user_id: '999999' })),
    ok(member({ user_id: '0324152' })), ok(member({ self_id: '999999' })), ok(member(), { self_id: '999999' }),
    ok(member(), { group_id: '999999' }), ok(member(), { user_id: '999999' }), { ...ok(member()), retcode: '0' },
    { status: 'failed', retcode: 400 }, { status: 'failed', retcode: 1200 },
  ]) for (const kind of ['poke', 'profile-like']) {
    const d = direct(() => proof)
    assert.equal((await d.interact(action(kind))).state, 'failed'); assert.equal(d.calls.length, 1)
    assert.equal(d.calls[0].native, 'get_group_member_info')
  }
})

test('reaction proof rejects cross-group, private, substituted message IDs, invalid authors and invalid timestamps', async () => {
  for (const patch of [
    { message_type: 'private' }, { group_id: '999999' }, { group_id: undefined }, { message_id: -43 }, { message_id: '-042' },
    { message_id: undefined }, { message_id: 2147483648 }, { user_id: undefined }, { user_id: '0324152' },
    { sender: { user_id: '999999' } }, { sender: {} }, { self_id: '999999' }, { time: 0 }, { time: -1 }, { time: 1.5 },
    { time: String(Math.floor(Date.now() / 1000)) }, { time: NaN }, { time: Math.floor(Date.now() / 1000) + 120 }, { post_type: 'notice' },
  ]) {
    const d = direct(() => ok(message(patch)))
    assert.equal((await d.interact(action('message-reaction'))).state, 'failed', JSON.stringify(patch)); assert.equal(d.calls.length, 1)
  }
  for (const outer of [{ self_id: '999999' }, { group_id: '999999' }, { user_id: '999999' }]) {
    const d = direct(() => ok(message(), outer)); assert.equal((await d.interact(action('message-reaction'))).state, 'failed'); assert.equal(d.calls.length, 1)
  }
})

test('malicious native membership, message and receipt objects do not execute accessors or Proxy traps', async () => {
  let touched = 0
  const proxy = value => new Proxy(value, { ownKeys() { touched++; throw Error('trap') }, get() { touched++; throw Error('trap') }, getPrototypeOf() { touched++; throw Error('trap') } })
  const getter = value => { const row = { ...value }; Object.defineProperty(row, 'self_id', { enumerable: true, get() { touched++; return account.id } }); return row }
  for (const kind of Object.keys(interactions)) for (const proof of [getter(ok(member())),
    ok(proxy(kind === 'message-reaction' ? message() : member())), ok(getter(kind === 'message-reaction' ? message() : member())),
  ]) {
    const d = direct(() => proof); assert.equal((await d.interact(action(kind))).state, 'failed'); assert.equal(d.calls.length, 1)
  }
  for (const result of [getter(ok()), ok(proxy({})), ok(getter({}))]) {
    const d = direct(native => isQuery(native) ? ok(member()) : result)
    assert.deepEqual(await d.interact(action()), { state: 'unknown' }); assert.equal(d.calls.length, 2)
  }
  assert.equal(touched, 0)
})

test('only strict native success confirms an interaction and all ambiguous effects remain unknown without retry', async () => {
  for (const result of [null, {}, { status: 'ok' }, { retcode: 0 }, { ...ok(), retcode: '0' },
    { status: 'failed', retcode: 1200 }, { status: 'failed', retcode: 200 }, { status: 'failed', retcode: 500 },
    { state: 'unknown' }, { state: 'sent', messageId: '42' }, { status: 'async', retcode: 0 },
    ok(null, { self_id: '999999' }), ok({ group_id: '999999' }), ok({ user_id: '999999' }), ok('malformed'),
  ]) {
    const d = direct(native => isQuery(native) ? ok(member()) : result)
    assert.deepEqual(await d.interact(action()), { state: 'unknown' }); assert.equal(d.calls.length, 2)
  }
  for (const result of [ok(), ok(undefined), ok({ self_id: account.id, group_id: target.id, user_id: user.id }), { status: 'ok', retcode: 0 }]) {
    const d = direct(native => isQuery(native) ? ok(member()) : result)
    assert.deepEqual(await d.interact(action()), { state: 'confirmed' }); assert.equal(d.calls.length, 2)
  }
  for (const code of [400, 1400]) {
    const d = direct(native => isQuery(native) ? ok(member()) : { status: 'failed', retcode: code })
    assert.deepEqual(await d.interact(action()), { state: 'failed', code: String(code) }); assert.equal(d.calls.length, 2)
  }
  const refused = direct(native => isQuery(native) ? ok(member()) : { state: 'failed', code: 'onebot_disconnected' })
  assert.deepEqual(await refused.interact(action()), { state: 'failed', code: 'onebot_disconnected' })
  const thrown = direct(native => { if (isQuery(native)) return ok(member()); throw Error('possibly sent') })
  assert.deepEqual(await thrown.interact(action()), { state: 'unknown' }); assert.equal(thrown.calls.length, 2)
})

for (const phase of ['during-query', 'after-query']) for (const mode of ['signal', 'guard', 'ready', 'binding', 'target', 'user', 'account']) {
  test(`${phase} ${mode} revocation prevents native interaction dispatch`, async () => {
    const input = action(), configuredAccount = { ...account }, controller = new AbortController()
    let current = true, ready = true, release, checked = 0
    const revoke = () => {
      if (mode === 'signal') controller.abort(); else if (mode === 'guard') current = false; else if (mode === 'ready') ready = false
      else if (mode === 'binding') input.binding.revision = 'r2'; else if (mode === 'target') input.target.id = '999999'
      else if (mode === 'user') input.interaction.user.id = '999999'; else configuredAccount.id = '999999'
    }
    const d = direct(() => phase === 'during-query' ? new Promise(resolve => { release = resolve }) : ok(member()), { account: configuredAccount, isReady: () => ready })
    const pending = d.interact(input, { signal: controller.signal, isCurrent: () => current,
      async ensureCurrent() { if (++checked === 2 && phase === 'after-query') revoke() },
    })
    if (phase === 'during-query') { await waitFor(() => release); revoke() }
    assert.equal((await pending).state, 'failed'); assert.equal(d.calls.length, 1)
    if (release) { release(ok(member())); await delay(5); assert.equal(d.calls.length, 1) }
  })
}

test('the final asynchronous source check completes after evidence and before the native effect', async () => {
  let checked = 0
  const d = direct(native => { assert.equal(checked, isQuery(native) ? 1 : 2); return isQuery(native) ? ok(member()) : ok() })
  assert.equal((await d.interact(action(), { async ensureCurrent() { checked++ } })).state, 'confirmed')
  for (const afterQuery of [false, true]) {
    let count = 0
    const rejected = direct()
    assert.equal((await rejected.interact(action(), { async ensureCurrent() { if (++count === (afterQuery ? 2 : 1)) throw Error('source revoked') } })).state, 'failed')
    assert.equal(rejected.calls.length, afterQuery ? 1 : 0)
  }
})

test('cancellation while final asynchronous authorization waits ignores late authorization', async () => {
  const controller = new AbortController(); let checked = 0, release
  const d = direct(), pending = d.interact(action(), { signal: controller.signal, async ensureCurrent() {
    if (++checked === 2) await new Promise(resolve => { release = resolve })
  } })
  await waitFor(() => release); controller.abort()
  assert.equal((await pending).state, 'failed'); assert.equal(d.calls.length, 1)
  release(); await delay(5); assert.equal(d.calls.length, 1)
})

test('a host-owned native queue retains the synchronous and asynchronous guards and never publishes after revocation', async () => {
  let queued, release, current = true, published = 0, checked = 0
  const d = direct(async (native, _params, scope) => {
    if (isQuery(native)) return ok(member())
    queued = true; await new Promise(resolve => { release = resolve })
    try { await scope.ensureCurrent() } catch { return { state: 'failed', code: 'source_unavailable' } }
    if (scope.isCurrent() && queuedDeliveryAllowed()) published++
    return ok()
  })
  const pending = d.interact(action(), { isCurrent: () => current, async ensureCurrent() { checked++ } })
  await waitFor(() => queued); current = false
  assert.deepEqual(await pending, { state: 'unknown' }); assert.equal(d.calls.length, 2)
  release(); await delay(5); assert.equal(published, 0); assert.equal(checked, 2)
})

for (const mode of ['signal', 'guard', 'ready', 'binding', 'target', 'account']) test(`dispatched interaction losing ${mode} stays unknown and ignores late success`, async () => {
  const controller = new AbortController(), input = action(), configuredAccount = { ...account }
  let current = true, ready = true, release
  const d = direct(native => isQuery(native) ? ok(member()) : new Promise(resolve => { release = resolve }), { account: configuredAccount, isReady: () => ready })
  const pending = d.interact(input, { signal: controller.signal, isCurrent: () => current })
  await waitFor(() => release)
  if (mode === 'signal') controller.abort(); else if (mode === 'guard') current = false; else if (mode === 'ready') ready = false
  else if (mode === 'binding') input.binding.revision = 'r2'; else if (mode === 'target') input.target.id = '999999'; else configuredAccount.id = '999999'
  assert.deepEqual(await pending, { state: 'unknown' }); assert.equal(d.calls.length, 2); assert.equal(d.calls[1].scope.signal.aborted, true)
  release(ok()); await delay(5); assert.equal(d.calls.length, 2)
})

for (const phase of ['query', 'effect']) test(`${phase} timeout settles once without retry or late confirmation`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let release, entered
  const started = new Promise(resolve => { entered = resolve })
  const d = direct(native => {
    if (phase === 'effect' && isQuery(native)) return ok(member())
    entered(); return new Promise(resolve => { release = resolve })
  })
  const pending = d.interact(action()); await started
  t.mock.timers.tick(QQ_INTERACTION_TIMEOUT_MS + 1)
  assert.deepEqual(await pending, phase === 'effect' ? { state: 'unknown' } : { state: 'failed', code: 'source_unavailable' })
  assert.equal(d.calls.length, phase === 'effect' ? 2 : 1)
  release(phase === 'effect' ? ok() : ok(member())); await Promise.resolve(); await Promise.resolve()
  assert.equal(d.calls.length, phase === 'effect' ? 2 : 1)
})

async function socketFixture(t, transport) {
  const requests = [], peers = [], token = 'local-interaction-fixture'
  let server, peer, url, handler = request => ok(request.action === 'get_msg' ? message() : request.action === 'get_group_member_info' ? member() : null)
  const attach = socket => {
    peer = socket; peers.push(socket); socket.on('error', () => {})
    socket.on('message', frame => {
      const request = JSON.parse(String(frame)); requests.push({ ...request, peer: socket })
      const response = request.action === 'get_login_info' ? ok({ user_id: account.id, nickname: '本地互动验收' }) : handler(request)
      if (response !== undefined && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ ...response, echo: request.echo }))
    })
    return socket
  }
  if (transport === 'forward-websocket') {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening')
    server.on('connection', (socket, request) => { assert.equal(request.headers.authorization, `Bearer ${token}`); attach(socket) })
    url = `ws://127.0.0.1:${server.address().port}`
  } else {
    const allocator = createServer(); allocator.listen(0, '127.0.0.1'); await once(allocator, 'listening')
    url = `ws://127.0.0.1:${allocator.address().port}/onebot`; await new Promise(resolve => allocator.close(resolve))
  }
  const adapter = createOneBotConnection({ connection: { id: binding.connectionId, account }, transport, url, accessToken: token,
    onDisconnect() {}, onReconnect() {}, onError() {}, onEventError() {},
  })
  t.after(async () => { adapter.stop(); for (const socket of peers) socket.terminate(); if (server) await new Promise(resolve => server.close(resolve)) })
  // The reverse listener starts asynchronously; its local client may need one retry.
  const connectReverse = async () => {
    if (transport !== 'reverse-websocket') return
    const until = Date.now() + 5000
    while (Date.now() < until) {
      const socket = attach(new WebSocket(url, { handshakeTimeout: 500, headers: { Authorization: `Bearer ${token}`, 'X-Self-ID': account.id, 'X-Client-Role': 'Universal' } }))
      try { await once(socket, 'open'); return } catch { socket.terminate(); await delay(5) }
    }
    assert.fail('local reverse interaction listener did not open')
  }
  assert.equal((await adapter.actions.interact(action())).state, 'failed')
  const started = adapter.start(async () => {}); void started.catch(() => {})
  await connectReverse(); await started
  return { adapter, requests, peer: () => peer, setHandler(next) { handler = next },
    async reconnect() { await connectReverse(); await waitFor(() => adapter.isReady()) },
  }
}

for (const transport of ['forward-websocket', 'reverse-websocket']) {
  test(`${transport} confirms all three native interactions without a message ID on the authenticated socket`, { timeout: 10000 }, async t => {
    const f = await socketFixture(t, transport)
    for (const kind of Object.keys(interactions)) assert.deepEqual(await f.adapter.actions.interact(action(kind)), { state: 'confirmed' })
    const requests = f.requests.filter(row => row.action !== 'get_login_info')
    assert.deepEqual(requests.map(row => row.action), ['get_group_member_info', 'send_group_poke', 'get_group_member_info', 'send_like', 'get_msg', 'set_msg_emoji_like'])
    assert.ok(requests.every(row => row.peer === f.peer()))
    assert.ok(requests.filter(row => row.action === 'get_group_member_info').every(row => row.params.no_cache === true && row.params.group_id === target.id && row.params.user_id === user.id))
  })
  test(`${transport} source query cannot resume an old interaction on a newly authenticated socket`, { timeout: 12000 }, async t => {
    const f = await socketFixture(t, transport); let release, suspended = false
    const pending = f.adapter.actions.interact(action(), { async ensureCurrent() {
      if (!suspended && f.requests.some(row => row.action === 'get_group_member_info')) {
        suspended = true; await new Promise(resolve => { release = resolve })
      }
    } })
    await waitFor(() => release); const original = f.peer(); original.terminate()
    assert.equal((await pending).state, 'failed')
    await f.reconnect(); assert.notEqual(f.peer(), original)
    release(); await delay(10)
    assert.equal(f.requests.filter(row => row.action === 'send_group_poke').length, 0)
    assert.equal(f.requests.filter(row => row.action === 'get_group_member_info').length, 1)
    assert.deepEqual(await f.adapter.actions.interact(action()), { state: 'confirmed' })
    assert.equal(f.requests.filter(row => row.action === 'send_group_poke').length, 1)
    assert.equal(f.requests.find(row => row.action === 'send_group_poke').peer, f.peer())
  })
  test(`${transport} disconnect after native dispatch freezes the effect without sending it on reconnect`, { timeout: 12000 }, async t => {
    const f = await socketFixture(t, transport)
    f.setHandler(request => request.action === 'get_group_member_info' ? ok(member()) : undefined)
    const pending = f.adapter.actions.interact(action()); await waitFor(() => f.requests.some(row => row.action === 'send_group_poke'))
    const original = f.peer(); original.terminate()
    assert.deepEqual(await pending, { state: 'unknown' })
    await f.reconnect(); assert.notEqual(f.peer(), original); await delay(10)
    assert.equal(f.requests.filter(row => row.action === 'send_group_poke').length, 1)
    assert.equal(f.requests.find(row => row.action === 'send_group_poke').peer, original)
  })
}

const peerTarget = { account, kind: 'private', id: user.id }
function extendedAction(kind, destination = target) {
  return action('poke', { target: destination, binding: { ...binding, target: destination }, interaction:
    kind === 'message-recall' ? { kind, messageId: '-42' } : { kind: 'profile-like', user, count: 3 } })
}
function ownMessage(destination = target, patch = {}) {
  return { message_type: destination.kind, ...(destination.kind === 'group' ? { group_id: destination.id } : { target_id: destination.id, post_type: 'message_sent', message_sent_type: 'self' }),
    self_id: account.id, message_id: -42, user_id: account.id, sender: { user_id: account.id }, time: Math.floor(Date.now() / 1000) - 1, ...patch }
}
const friends = (extra = {}) => ok([{ user_id: user.id }], extra)
for (const destination of [target, peerTarget]) test(`QQ own-message recall proves ${destination.kind} ownership then deletes once without a message receipt`, async () => {
  const d = direct(native => native === 'get_friend_list' ? friends() : native === 'get_msg' ? ok(ownMessage(destination)) : ok())
  assert.deepEqual(await d.interact(extendedAction('message-recall', destination)), { state: 'confirmed' })
  assert.deepEqual(d.calls.map(row => row.native), [...(destination.kind === 'private' ? ['get_friend_list'] : []), 'get_msg', 'delete_msg'])
  assert.deepEqual(d.calls.at(-1).params, { message_id: -42 })
})

test('private profile-like verifies the current friend on every call and never asks for group membership', async () => {
  const d = direct(native => native === 'get_friend_list' ? friends() : ok())
  for (let index = 0; index < 2; index++) assert.deepEqual(await d.interact(extendedAction('profile-like', peerTarget)), { state: 'confirmed' })
  assert.deepEqual(d.calls.map(row => row.native), ['get_friend_list', 'send_like', 'get_friend_list', 'send_like'])
  assert.ok(d.calls.filter(row => row.native === 'send_like').every(row => JSON.stringify(row.params) === JSON.stringify({ user_id: user.id, times: 3 })))
  const before = d.calls.length
  for (const interaction of [{ kind: 'profile-like', user: { ...user, id: '999999' }, count: 3 }, interactions.poke, interactions['message-reaction']]) {
    assert.equal((await d.interact({ ...extendedAction('profile-like', peerTarget), interaction })).state, 'failed')
  }
  assert.equal(d.calls.length, before)
})

test('private actions reject incomplete, duplicated, missing and wrong-account friend evidence before any effect', async () => {
  for (const proof of [ok([]), ok([{ user_id: '999999' }]), ok([{ user_id: user.id }, { user_id: user.id }]), friends({ self_id: '999999' }),
    friends({ complete: false }), friends({ truncated: true }), friends({ has_more: true }), { ...friends(), retcode: '0' }, ok({ user_id: user.id }),
    ok(Array.from({ length: 10001 }, (_, index) => ({ user_id: String(index + 1) })))]) {
    for (const kind of ['profile-like', 'message-recall']) {
      const d = direct(() => proof); assert.equal((await d.interact(extendedAction(kind, peerTarget))).state, 'failed')
      assert.deepEqual(d.calls.map(row => row.native), ['get_friend_list'])
    }
  }
})

for (const destination of [target, peerTarget]) test(`QQ ${destination.kind} own-recall refuses substituted message, author, conversation or time proof`, async () => {
  const patches = [{ message_id: -43 }, { message_id: '-042' }, { user_id: user.id }, { sender: { user_id: user.id } }, { user_id: undefined }, { sender: {} },
    { self_id: '999999' }, { time: 0 }, { time: 1.5 }, { time: String(Math.floor(Date.now() / 1000)) }, { time: Number.MAX_SAFE_INTEGER }, { time: Math.floor(Date.now() / 1000) + 120 },
    ...(destination.kind === 'group' ? [{ group_id: undefined }, { group_id: '999999' }, { message_type: 'private' }, { post_type: 'notice' }]
      : [{ target_id: undefined }, { target_id: '999999' }, { target_id: '0324152' }, { sub_type: 'group' }, { group_id: 0 }, { temp_source: 0 }, { isGroup: true },
        { sender: { user_id: account.id, group_id: target.id } }, { message_type: 'group' }, { post_type: 'message', message_sent_type: undefined }])]
  for (const patch of patches) {
    const d = direct(native => native === 'get_friend_list' ? friends() : ok(ownMessage(destination, patch)))
    assert.equal((await d.interact(extendedAction('message-recall', destination))).state, 'failed', JSON.stringify(patch))
    assert.equal(d.calls.some(row => row.native === 'delete_msg'), false)
  }
})

test('own-recall confirms only native strict success and never retries an uncertain dispatched deletion', async () => {
  for (const receipt of [undefined, null, {}, { status: 'async', retcode: 0 }, { status: 'failed', retcode: 1200 }, { ...ok(), retcode: '0' }, ok({ message_id: '-43' })]) {
    const d = direct(native => native === 'get_msg' ? ok(ownMessage()) : receipt)
    assert.deepEqual(await d.interact(extendedAction('message-recall')), { state: 'unknown' })
    assert.deepEqual(d.calls.map(row => row.native), ['get_msg', 'delete_msg'])
  }
  const thrown = direct(native => { if (native === 'get_msg') return ok(ownMessage()); throw Error('possibly deleted') })
  assert.deepEqual(await thrown.interact(extendedAction('message-recall')), { state: 'unknown' }); assert.equal(thrown.calls.length, 2)
})

for (const transport of ['forward-websocket', 'reverse-websocket']) {
  test(`${transport} own metadata and deletion prove the current private peer independently without exposing content`, { timeout: 12000 }, async t => {
    const f = await socketFixture(t, transport)
    f.setHandler(request => request.action === 'get_friend_list' ? friends() : request.action === 'get_msg' ? ok(ownMessage(peerTarget, { message: 'never returned private body' })) : ok())
    const snapshot = await f.adapter.readOwnMessage(peerTarget, '-42', { signal: new AbortController().signal, isCurrent: () => true })
    assert.deepEqual(snapshot, { conversation: peerTarget, messageId: '-42', author: account, occurredAt: snapshot.occurredAt })
    assert.deepEqual(Object.keys(snapshot).sort(), ['author', 'conversation', 'messageId', 'occurredAt']); assert.ok(Object.isFrozen(snapshot))
    assert.equal(await f.adapter.readMessage(peerTarget, '-42', { isCurrent: () => true }), undefined, 'the human-source reader remains closed to bot messages')
    assert.deepEqual(await f.adapter.actions.interact(extendedAction('message-recall', peerTarget)), { state: 'confirmed' })
    const requests = f.requests.filter(row => row.action !== 'get_login_info')
    assert.deepEqual(requests.map(row => row.action), ['get_friend_list', 'get_msg', 'get_friend_list', 'get_msg', 'get_friend_list', 'get_msg', 'delete_msg'])
    assert.ok(requests.every(row => row.peer === f.peer()))
    f.setHandler(request => request.action === 'get_msg' ? ok(ownMessage()) : ok())
    assert.equal((await f.adapter.readOwnMessage(target, '-42', { isCurrent: () => true })).author.id, account.id)
  })
  test(`${transport} current-friend proof and private metadata cannot cross a disconnected authenticated socket`, { timeout: 12000 }, async t => {
    const f = await socketFixture(t, transport)
    f.setHandler(() => undefined)
    const pending = f.adapter.readOwnMessage(peerTarget, '-42', { signal: new AbortController().signal, isCurrent: () => true })
    await waitFor(() => f.requests.some(row => row.action === 'get_friend_list')); const original = f.peer(); original.terminate()
    assert.equal(await pending, undefined); await f.reconnect(); assert.notEqual(f.peer(), original)
    assert.equal(f.requests.some(row => row.action === 'get_msg'), false)
    f.setHandler(request => request.action === 'get_friend_list' ? friends() : request.action === 'get_msg' ? ok(ownMessage(peerTarget)) : ok())
    assert.equal((await f.adapter.readOwnMessage(peerTarget, '-42', { isCurrent: () => true })).author.id, account.id)
  })
}

test('own-recall evidence and deletion receipts never invoke accessors or coercion on native fields', async () => {
  let touched = 0
  const hostile = {}; Object.defineProperty(hostile, 'user_id', { get() { touched++; return account.id } })
  const messageGetter = ownMessage(); Object.defineProperty(messageGetter, 'message', { get() { touched++; return 'private body' } })
  const poison = { toString() { touched++; return '-42' } }
  for (const proof of [ok(ownMessage(target, { sender: hostile })), ok(messageGetter), ok(ownMessage(target, { message_id: poison }))]) {
    const d = direct(() => proof); assert.equal((await d.interact(extendedAction('message-recall'))).state, 'failed'); assert.equal(d.calls.length, 1)
  }
  const d = direct(native => native === 'get_msg' ? ok(ownMessage()) : ok({ message_id: poison }))
  assert.deepEqual(await d.interact(extendedAction('message-recall')), { state: 'unknown' }); assert.equal(d.calls.length, 2); assert.equal(touched, 0)
})

test('private friend and own-message query revocation prevents any native deletion or like', async () => {
  for (const kind of ['profile-like', 'message-recall']) for (const phase of ['friend', 'own-message']) {
    if (kind === 'profile-like' && phase === 'own-message') continue
    let current = true
    const d = direct(native => {
      if (native === 'get_friend_list') { if (phase === 'friend') current = false; return friends() }
      if (native === 'get_msg') { current = false; return ok(ownMessage(peerTarget)) }
      assert.fail('revocation must prevent native effects')
    })
    assert.equal((await d.interact(extendedAction(kind, peerTarget), { isCurrent: () => current })).state, 'failed')
    assert.deepEqual(d.calls.map(row => row.native), phase === 'friend' ? ['get_friend_list'] : ['get_friend_list', 'get_msg'])
  }
})

for (const transport of ['forward-websocket', 'reverse-websocket']) {
  test(`${transport} own metadata reader rejects malformed guards and revokes pending target or caller changes`, { timeout: 12000 }, async t => {
    const f = await socketFixture(t, transport); let touched = 0
    const proxy = new Proxy({}, { get() { touched++; throw Error('trap') }, ownKeys() { touched++; throw Error('trap') }, getPrototypeOf() { touched++; throw Error('trap') } })
    const getter = {}; Object.defineProperty(getter, 'isCurrent', { get() { touched++; return () => true } })
    const aborted = new AbortController(); aborted.abort()
    const before = f.requests.length
    for (const guard of [proxy, getter, { isCurrent: true }, { ensureCurrent: true }, { signal: {} }, { signal: Object.create(AbortSignal.prototype) }, { signal: aborted.signal }, { isCurrent: () => false }]) {
      assert.equal(await f.adapter.readOwnMessage(target, '-42', guard), undefined)
    }
    assert.equal(await f.adapter.readOwnMessage(proxy, '-42', {}), undefined)
    assert.equal(await f.adapter.readOwnMessage(target, '-042', {}), undefined)
    assert.equal(touched, 0); assert.equal(f.requests.length, before)
    for (const mode of ['guard', 'target', 'abort']) {
      const destination = structuredClone(peerTarget), controller = new AbortController(); let current = true
      f.setHandler(request => request.action === 'get_friend_list' ? friends() : undefined)
      const start = f.requests.length, pending = f.adapter.readOwnMessage(destination, '-42', { signal: controller.signal, isCurrent: () => current })
      await waitFor(() => f.requests.slice(start).some(row => row.action === 'get_msg'))
      if (mode === 'guard') current = false; else if (mode === 'target') destination.id = '999999'; else controller.abort()
      assert.equal(await pending, undefined)
      const request = f.requests.slice(start).find(row => row.action === 'get_msg')
      f.peer().send(JSON.stringify({ ...ok(ownMessage(peerTarget)), echo: request.echo })); await delay(5)
    }
  })
  test(`${transport} disconnect after private own deletion remains unknown without reconnect retry`, { timeout: 12000 }, async t => {
    const f = await socketFixture(t, transport)
    f.setHandler(request => request.action === 'get_friend_list' ? friends() : request.action === 'get_msg' ? ok(ownMessage(peerTarget)) : undefined)
    const pending = f.adapter.actions.interact(extendedAction('message-recall', peerTarget))
    await waitFor(() => f.requests.some(row => row.action === 'delete_msg')); const original = f.peer(); original.terminate()
    assert.deepEqual(await pending, { state: 'unknown' }); await f.reconnect(); await delay(10)
    assert.equal(f.requests.filter(row => row.action === 'delete_msg').length, 1)
    assert.equal(f.requests.find(row => row.action === 'delete_msg').peer, original)
  })
}

const managementCases = [
  { kind: 'member-mute', operation: { kind: 'member-mute', user, requester, seconds: 60 }, native: 'set_group_ban', params: { group_id: target.id, user_id: user.id, duration: 60 } },
  { kind: 'member-unmute', operation: { kind: 'member-mute', user, requester, seconds: 0 }, native: 'set_group_ban', params: { group_id: target.id, user_id: user.id, duration: 0 } },
  { kind: 'group-mute', operation: { kind: 'group-mute', requester, enabled: true }, native: 'set_group_whole_ban', params: { group_id: target.id, enable: true } },
  { kind: 'group-unmute', operation: { kind: 'group-mute', requester, enabled: false }, native: 'set_group_whole_ban', params: { group_id: target.id, enable: false } },
  { kind: 'member-card', operation: { kind: 'member-card', user, requester, name: '群名片🙂' }, native: 'set_group_card', params: { group_id: target.id, user_id: user.id, card: '群名片🙂' } },
  { kind: 'clear-card', operation: { kind: 'member-card', user, requester, name: '' }, native: 'set_group_card', params: { group_id: target.id, user_id: user.id, card: '' } },
]
const managementAction = operation => action('poke', { interaction: structuredClone(operation) })
const managementMember = (id, extra = {}) => member({ user_id: id, role: id === user.id ? 'member' : 'admin', ...extra })
const managementHandler = (native, params) => native === 'get_group_member_info' ? ok(managementMember(params.user_id)) : ok()

for (const scenario of managementCases) test(`QQ ${scenario.kind} rereads current requester, bot and target before exact native parameters`, async () => {
  const d = direct(managementHandler), input = managementAction(scenario.operation)
  for (let attempt = 0; attempt < 2; attempt++) assert.deepEqual(await d.interact(input), { state: 'confirmed' })
  const ids = [requester.id, account.id, ...(scenario.operation.kind === 'group-mute' ? [] : [user.id])]
  const expected = [...ids.map(id => ({ native: 'get_group_member_info', params: { group_id: target.id, user_id: id, no_cache: true } })), { native: scenario.native, params: scenario.params }]
  assert.deepEqual(d.calls.map(({ native, params }) => ({ native, params })), [...expected, ...expected])
  for (const call of d.calls) assert.ok(call.scope.timeoutMs > 0 && call.scope.timeoutMs <= 30000)
})

test('QQ management refuses malformed and private operations before native reads', async () => {
  const base = managementCases[0].operation, d = direct(managementHandler)
  for (const operation of [
    { ...base, requester: { ...requester, id: '0324153' } }, { ...base, requester: { ...requester, namespace: 'other' } },
    { ...base, requester: { ...requester, platform: 'other' } }, { ...base, requester: undefined }, { ...base, role: 'owner' },
    { ...base, seconds: -1 }, { ...base, seconds: 1.5 }, { ...base, seconds: 2592001 },
    { kind: 'group-mute', requester, enabled: true, seconds: 60 }, { kind: 'group-mute', requester, enabled: 'true' },
    { kind: 'member-card', requester, user, name: 'a'.repeat(61) }, { kind: 'member-card', requester, user, name: '\ud800' },
    { kind: 'member-card', requester, user, name: 'x\nx' }, { kind: 'member-card', requester, user, name: 'x\u0080x' },
  ]) assert.equal((await d.interact(managementAction(operation))).state, 'failed', JSON.stringify(operation))
  for (const { operation } of managementCases) {
    const destination = { ...target, kind: 'private' }
    assert.equal((await d.interact(action('poke', { target: destination, binding: { ...binding, target: destination }, interaction: operation }))).state, 'failed')
  }
  assert.deepEqual(d.calls, [])
})

test('QQ management rejects missing, stale-scope and unknown role evidence independently for every participant', async () => {
  for (const id of [requester.id, account.id, user.id]) for (const patch of [
    { role: undefined }, { role: 'unknown' }, { role: 'administrator' }, { group_id: '99999' }, { group_id: undefined },
    { user_id: '99999' }, { user_id: undefined }, { self_id: '99999' }, { self_id: undefined },
  ]) {
    const d = direct((native, params) => native === 'get_group_member_info'
      ? ok(managementMember(params.user_id, params.user_id === id ? patch : {})) : assert.fail('invalid evidence cannot dispatch'))
    assert.equal((await d.interact(managementAction(managementCases[0].operation))).state, 'failed', JSON.stringify({ id, patch }))
    assert.ok(d.calls.every(call => call.native === 'get_group_member_info'))
  }
  for (const roleId of [requester.id, account.id]) {
    const d = direct((native, params) => native === 'get_group_member_info'
      ? ok(managementMember(params.user_id, params.user_id === roleId ? { role: 'member' } : {})) : assert.fail('member cannot administer'))
    assert.equal((await d.interact(managementAction(managementCases[0].operation))).state, 'failed')
  }
  for (const role of ['admin', 'owner']) for (const seconds of [60, 0]) {
    const d = direct((native, params) => native === 'get_group_member_info'
      ? ok(managementMember(params.user_id, params.user_id === user.id ? { role } : {})) : assert.fail('administrator targets cannot be muted or unmuted'))
    assert.equal((await d.interact(managementAction({ ...managementCases[0].operation, seconds }))).state, 'failed')
  }
})

test('QQ card preserves requester self and bot self exceptions without inventing target hierarchy', async () => {
  for (const [operation, roles] of [
    [{ kind: 'member-card', requester: user, user, name: '本人' }, { [user.id]: 'member', [account.id]: 'admin' }],
    [{ kind: 'member-card', requester, user: account, name: '机器人' }, { [requester.id]: 'admin', [account.id]: 'member' }],
    [{ kind: 'member-card', requester, user, name: '群主名片' }, { [requester.id]: 'admin', [account.id]: 'admin', [user.id]: 'owner' }],
  ]) {
    const d = direct((native, params) => native === 'get_group_member_info' ? ok(managementMember(params.user_id, { role: roles[params.user_id] })) : ok())
    assert.deepEqual(await d.interact(managementAction(operation)), { state: 'confirmed' })
    assert.equal(d.calls.filter(call => call.native === 'set_group_card').length, 1)
  }
})

test('QQ management checks authority after every awaited member proof and before the native effect', async () => {
  for (const revokeAt of [1, 2, 3, 4]) {
    let checked = 0, current = true
    const d = direct(managementHandler)
    assert.equal((await d.interact(managementAction(managementCases[0].operation), { isCurrent: () => current,
      async ensureCurrent() { if (++checked === revokeAt) current = false },
    })).state, 'failed')
    assert.equal(d.calls.some(call => call.native === 'set_group_ban'), false)
  }
  for (const queryIndex of [1, 2, 3]) {
    let queried = 0, current = true, release
    const d = direct((native, params) => {
      assert.equal(native, 'get_group_member_info')
      if (++queried === queryIndex) return new Promise(resolve => { release = () => resolve(ok(managementMember(params.user_id))) })
      return ok(managementMember(params.user_id))
    })
    const pending = d.interact(managementAction(managementCases[0].operation), { isCurrent: () => current })
    await waitFor(() => release); current = false; release()
    assert.equal((await pending).state, 'failed'); assert.equal(d.calls.some(call => call.native === 'set_group_ban'), false)
  }
})

test('QQ management native confirmation checks optional scope and operation fields and never fabricates message IDs', async () => {
  for (const { operation, params } of managementCases) {
    const reported = { ...params, requester_id: requester.id, self_id: account.id }
    const rows = [ok(), { status: 'ok', retcode: 0 }, ok(reported), ok(null, reported)]
    for (const result of rows) {
      const d = direct((native, params) => native === 'get_group_member_info' ? ok(managementMember(params.user_id)) : result)
      assert.deepEqual(await d.interact(managementAction(operation)), { state: 'confirmed' })
    }
    for (const patch of [
      { group_id: '999999' }, { self_id: '999999' }, { user_id: '999999' }, { requester_id: '999999' },
      { group_id: undefined }, { self_id: undefined }, { user_id: undefined },
      { target_id: '999999' }, { message_id: 42 }, { messageId: '42' },
      operation.kind === 'member-mute' ? { duration: String(operation.seconds) } : { duration: 60 },
      operation.kind === 'group-mute' ? { enable: !operation.enabled } : { enable: true },
      operation.kind === 'member-card' ? { card: operation.name + 'wrong' } : { card: 'wrong' },
    ]) for (const result of [ok(patch), ok(null, patch)]) {
      const d = direct((native, params) => native === 'get_group_member_info' ? ok(managementMember(params.user_id)) : result)
      assert.deepEqual(await d.interact(managementAction(operation)), { state: 'unknown' }, JSON.stringify({ operation, patch }))
    }
    for (const result of [{ state: 'confirmed', messageId: '42' }, { status: 'failed', retcode: 1200 }, { status: 'failed', retcode: 200 }, undefined]) {
      const d = direct((native, params) => native === 'get_group_member_info' ? ok(managementMember(params.user_id)) : result)
      assert.deepEqual(await d.interact(managementAction(operation)), { state: 'unknown' })
      assert.equal(d.calls.filter(call => call.native !== 'get_group_member_info').length, 1)
    }
  }
})

for (const transport of ['forward-websocket', 'reverse-websocket']) {
  test(`${transport} group management uses fresh roles and exact effects on its original authenticated socket`, { timeout: 15000 }, async t => {
    const f = await socketFixture(t, transport)
    f.setHandler(request => managementHandler(request.action, request.params))
    for (const scenario of managementCases) assert.deepEqual(await f.adapter.actions.interact(managementAction(scenario.operation)), { state: 'confirmed' })
    const effects = f.requests.filter(row => row.action.startsWith('set_group_'))
    assert.deepEqual(effects.map(({ action, params }) => ({ action, params })), managementCases.map(row => ({ action: row.native, params: row.params })))
    assert.ok(f.requests.every(row => row.peer === f.peer()))
    assert.ok(f.requests.filter(row => row.action === 'get_group_member_info').every(row => row.params.no_cache === true))
  })
  test(`${transport} cannot resume group management role evidence after socket replacement`, { timeout: 15000 }, async t => {
    const f = await socketFixture(t, transport); let release, held = false
    f.setHandler(request => managementHandler(request.action, request.params))
    const pending = f.adapter.actions.interact(managementAction(managementCases[0].operation), { async ensureCurrent() {
      if (!held && f.requests.filter(row => row.action === 'get_group_member_info').length === 2) { held = true; await new Promise(resolve => { release = resolve }) }
    } })
    await waitFor(() => release); const original = f.peer(); original.terminate()
    assert.equal((await pending).state, 'failed'); await f.reconnect(); release(); await delay(10)
    assert.equal(f.requests.some(row => row.action === 'set_group_ban'), false)
    assert.equal(f.requests.filter(row => row.action === 'get_group_member_info').length, 2)
  })
  test(`${transport} uncertain native group management is never retried on reconnect`, { timeout: 15000 }, async t => {
    const f = await socketFixture(t, transport)
    f.setHandler(request => request.action === 'get_group_member_info' ? managementHandler(request.action, request.params) : undefined)
    const pending = f.adapter.actions.interact(managementAction(managementCases[0].operation))
    await waitFor(() => f.requests.some(row => row.action === 'set_group_ban')); const original = f.peer(); original.terminate()
    assert.deepEqual(await pending, { state: 'unknown' }); await f.reconnect(); await delay(10)
    assert.equal(f.requests.filter(row => row.action === 'set_group_ban').length, 1)
    assert.equal(f.requests.find(row => row.action === 'set_group_ban').peer, original)
  })
}
