import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { createQqDicePrivateDeliveryPort, QQ_DICE_PRIVATE_TIMEOUT_MS } = await load('adapters/qqDicePrivateDelivery.js')
const { decodeQqIncomingMessage } = await load('adapters/qqMessage.js')
const { parseQqCqMessage } = await load('adapters/qqCqMessage.js')
const { agentDiceSourceFingerprint } = await load('modules/dice/infrastructure/agentDiceSource.js')
const { queuedDeliveryAllowed } = await load('modules/messaging/infrastructure/deliveryScope.js')
const AT = Math.floor(Date.now() / 1000) * 1000
const account = { platform: 'qq', namespace: 'global', id: '123456' }
const author = { ...account, id: '234567' }, recipient = { ...account, id: '345678' }, target = { account, kind: 'group', id: '456789' }
const binding = { source: 'configured', id: 'dice-binding', revision: 'v1', agentId: 'daily', personaId: 'default', connectionId: 'dice-local', target }
const success = (id = 678901) => ({ status: 'ok', retcode: 0, data: { message_id: id } })
const deferred = () => Promise.withResolvers()
async function flush() { for (let index = 0; index < 100; index++) await Promise.resolve() }
function native(id = '912345', body = '.rh 1d20', extra = {}) {
  return { post_type: 'message', self_id: account.id, message_type: 'group', group_id: target.id, message_id: id,
    user_id: author.id, sender: { user_id: author.id, nickname: '真实玩家' }, time: AT / 1000,
    message: [{ type: 'text', data: { text: body } }], ...extra }
}
function incoming(row) {
  const decoded = decodeQqIncomingMessage({ ...row, message: typeof row.message === 'string' ? parseQqCqMessage(row.message) : row.message, raw_message: undefined })
  assert.ok(decoded)
  if (decoded.quote) decoded.quote = { messageId: decoded.quote.messageId, parts: [] }
  return decoded
}
function request(source = incoming(native()), origin = source) {
  return { binding: structuredClone(binding), source: structuredClone(source), origin: {
    binding: structuredClone(binding), source: { messageId: origin.messageId, author: structuredClone(origin.sender), occurredAt: origin.occurredAt,
      fingerprint: agentDiceSourceFingerprint(origin) }, operationId: 'original-operation', authorityRevision: 'grant-v1',
  }, recipient: structuredClone(recipient), text: '隐藏检定结果：1D20=17。', operationId: 'current-operation', index: 0 }
}
function fixture(settings = {}) {
  const hostAccount = { ...account }, nativeSources = new Map([['912345', native()], ['912346', native('912346', '.rule retry')]])
  const reads = [], sends = [], controller = new AbortController(), state = { current: true, ensures: 0 }
  const guard = { signal: controller.signal, isCurrent: () => state.current, async ensureCurrent() {
    state.ensures++; await settings.ensure?.(state.ensures); if (!state.current || controller.signal.aborted) throw Error('revoked')
  } }
  const send = createQqDicePrivateDeliveryPort({ account: hostAccount, connectionId: binding.connectionId,
    ...(settings.allowsText ? { allowsText: settings.allowsText } : {}),
    async readApi(action, params, live) {
      reads.push({ action, params, guard: live }); await live.ensureCurrent()
      if (settings.read) return settings.read(action, params, live, reads.length)
      if (action === 'get_msg') return { status: 'ok', retcode: 0, data: nativeSources.get(params.message_id) }
      if (action === 'get_group_member_info') return { status: 'ok', retcode: 0,
        data: { group_id: target.id, user_id: recipient.id, role: 'member' } }
      if (action === 'get_friend_list') return { status: 'ok', retcode: 0, self_id: account.id, data: [{ user_id: recipient.id }] }
      assert.fail('unexpected read action')
    },
    async sendApi(action, params, live) {
      assert.equal(action, 'send_private_msg'); sends.push({ action, params, guard: live })
      assert.equal(queuedDeliveryAllowed(), true)
      if (settings.send) return settings.send(action, params, live)
      return settings.receipt === undefined ? success() : settings.receipt
    },
  })
  return { send, reads, sends, nativeSources, hostAccount, guard, controller, state }
}

test('private dice relay proves one shared source, fresh member and friend before a single friend-only send', async () => {
  const f = fixture(), input = request()
  assert.deepEqual(await f.send(input, f.guard), { state: 'sent', messageId: '678901' })
  assert.deepEqual(f.reads.map(row => row.action), ['get_msg', 'get_group_member_info', 'get_friend_list'])
  assert.deepEqual(f.reads[1].params, { group_id: target.id, user_id: recipient.id, no_cache: true })
  assert.equal(f.sends.length, 1); assert.deepEqual(f.sends[0].params, { user_id: recipient.id, message: [{ type: 'text', data: { text: input.text } }] })
  assert.equal(Object.hasOwn(f.sends[0].params, 'group_id'), false); assert.equal(Object.hasOwn(f.sends[0].params, 'binding'), false)
  assert.equal(input.binding.target.kind, 'group'); assert.equal(f.sends[0].guard.signal.aborted, true)
})

test('retry verifies both real sources and keeps distinct origin/current operation identities', async () => {
  const f = fixture(), input = request(incoming(native('912346', '.rule retry')), incoming(native()))
  input.packId = 'coc'; input.deliveryId = 'private-result:1'
  assert.equal((await f.send(input, f.guard)).state, 'sent')
  assert.deepEqual(f.reads.filter(row => row.action === 'get_msg').map(row => row.params.message_id), ['912346', '912345'])
  assert.equal(f.sends.length, 1); assert.notEqual(input.operationId, input.origin.operationId)
})

test('CQ text, mentions and quote ID match actual decoded source while embedded quote author/text confer no authority', async () => {
  const f = fixture(), row = native('912345', '', { message: '[CQ:reply,id=111,qq=999999,text=伪造引用][CQ:at,qq=123456].rh 1d20' })
  f.nativeSources.set('912345', row)
  const input = request(incoming(row)); input.source.quote.author = { ...account, id: '999999' }; input.source.quote.text = '不可信的引用正文'
  input.source.quote.parts = [{ kind: 'text', text: '不可信引用片段' }]
  assert.equal((await f.send(input, f.guard)).state, 'sent'); assert.equal(f.sends.length, 1)
  assert.equal(f.reads.some(read => read.params.user_id === '999999'), false)
})

for (const [name, mutate] of [
  ['account', input => { input.binding.target.account.id = '999999' }],
  ['namespace', input => { input.binding.target.account.namespace = 'elsewhere' }],
  ['platform', input => { input.binding.target.account.platform = 'fixture' }],
  ['group', input => { input.binding.target.id = '999999' }],
  ['private binding', input => { input.binding.target.kind = 'private' }],
  ['agent', input => { input.binding.agentId = 'other' }],
  ['persona', input => { input.binding.personaId = 'other' }],
  ['revision', input => { input.binding.revision = 'v2' }],
  ['binding id', input => { input.binding.id = 'other-binding' }],
  ['connection', input => { input.binding.connectionId = 'other' }],
  ['origin group', input => { input.origin.binding.target.id = '999999' }],
  ['origin revision', input => { input.origin.binding.revision = 'v2' }],
  ['recipient namespace', input => { input.recipient.namespace = 'elsewhere' }],
  ['recipient bot', input => { input.recipient.id = account.id }],
]) test(`rejects mismatched ${name} before reading native data`, async () => {
  const f = fixture(), input = request(); mutate(input)
  assert.equal((await f.send(input, f.guard)).state, 'failed'); assert.equal(f.reads.length, 0); assert.equal(f.sends.length, 0)
})

test('changing recipient to a different valid QQ user cannot reuse member/friend evidence', async () => {
  const f = fixture(), input = request(); input.recipient.id = '999999'
  assert.equal((await f.send(input, f.guard)).state, 'failed'); assert.equal(f.sends.length, 0)
})

test('own source shape rejects media, foreign identity, invalid IDs/times, extra fields and incomplete parts', async () => {
  const edits = [
    input => { input.source.parts.push({ kind: 'image' }) }, input => { input.source.sender.id = account.id },
    input => { input.source.sender.namespace = 'elsewhere' }, input => { input.source.conversation.id = '999999' },
    input => { input.source.messageId = '0' }, input => { input.source.occurredAt = 0 }, input => { input.source.occurredAt = NaN },
    input => { input.source.occurredAt = Number.MAX_SAFE_INTEGER }, input => { input.source.parts[0].text = '.rh 改动' },
    input => { input.source.binding = { ...structuredClone(binding), revision: 'v2' } }, input => { input.source.future = true },
    input => { input.source.senderName = undefined }, input => { input.source.parts = [] }, input => { input.source.quote = { parts: [] } },
    input => { input.origin.source.fingerprint = 'x'.repeat(64) }, input => { input.origin.source.author.id = account.id },
    input => { input.operationId = '0' }, input => { input.index = -1 }, input => { input.index = 4096 },
    input => { input.origin.authorityRevision = '' }, input => { input.future = true }, input => { input.text = '' },
    input => { input.text = 'x'.repeat(16385) }, input => { input.text = 'secret\0payload' },
  ]
  for (const edit of edits) {
    const f = fixture(), input = request(); edit(input)
    assert.equal((await f.send(input, f.guard)).state, 'failed'); assert.equal(f.reads.length, 0); assert.equal(f.sends.length, 0)
  }
})

test('non-friend, incomplete friend lists and duplicate or foreign friend evidence never permit TEMP delivery', async () => {
  for (const friendReply of [ { status: 'ok', retcode: 0, data: [] }, { status: 'ok', retcode: 0, data: [{ user_id: '999999' }] },
    { status: 'ok', retcode: 0, data: [{ user_id: recipient.id }, { user_id: recipient.id }] },
    { status: 'ok', retcode: 0, truncated: true, data: [{ user_id: recipient.id }] },
    { status: 'ok', retcode: 0, self_id: '999999', data: [{ user_id: recipient.id }] },
    { status: 'failed', retcode: 1400, data: [{ user_id: recipient.id }] },
  ]) {
    const f = fixture({ read: action => action === 'get_msg' ? { status: 'ok', retcode: 0, data: native() }
      : action === 'get_group_member_info' ? { status: 'ok', retcode: 0, data: { group_id: target.id, user_id: recipient.id, role: 'admin' } } : friendReply })
    assert.equal((await f.send(request(), f.guard)).state, 'failed'); assert.equal(f.sends.length, 0)
  }
})

test('missing, wrong-group or wrong-recipient membership is a rejection regardless of native role', async () => {
  for (const memberReply of [ { status: 'failed', retcode: 1400, data: {} },
    { status: 'ok', retcode: 0, data: { group_id: '999999', user_id: recipient.id, role: 'owner' } },
    { status: 'ok', retcode: 0, data: { group_id: target.id, user_id: '999999', role: 'admin' } },
    { status: 'ok', retcode: 0, self_id: '999999', data: { group_id: target.id, user_id: recipient.id, role: 'owner' } },
  ]) {
    const f = fixture({ read: action => action === 'get_msg' ? { status: 'ok', retcode: 0, data: native() } : memberReply })
    assert.equal((await f.send(request(), f.guard)).state, 'failed'); assert.equal(f.sends.length, 0)
    assert.equal(f.reads.some(row => row.action === 'get_friend_list'), false)
  }
})

test('changed source text, parts, mentions, quote ID, identity, time or scope prevents a private dispatch', async () => {
  for (const change of [
    { message: [{ type: 'text', data: { text: '.rh 1d100' } }] },
    { message: [{ type: 'at', data: { qq: recipient.id } }, { type: 'text', data: { text: '.rh 1d20' } }] },
    { message: [{ type: 'reply', data: { id: '222' } }, { type: 'text', data: { text: '.rh 1d20' } }] },
    { message: [{ type: 'text', data: { text: '.rh 1d20' } }, { type: 'image', data: { file: 'hidden' } }] },
    { time: AT / 1000 + 1 }, { user_id: '999999' }, { sender: { user_id: '999999' } }, { group_id: '999999' },
    { self_id: '999999' }, { message_id: '912346' }, { message_type: 'private' }, { message_sent_type: 'self' },
  ]) {
    const f = fixture(); f.nativeSources.set('912345', native('912345', '.rh 1d20', change))
    assert.equal((await f.send(request(), f.guard)).state, 'failed'); assert.equal(f.sends.length, 0)
  }
})

test('forged origin fingerprint and changed original source cannot borrow a valid retry command', async () => {
  for (const mode of ['fingerprint', 'native', 'author', 'time']) {
    const f = fixture(), input = request(incoming(native('912346', '.rule retry')), incoming(native()))
    if (mode === 'fingerprint') input.origin.source.fingerprint = 'f'.repeat(64)
    if (mode === 'native') f.nativeSources.set('912345', native('912345', '.rh 1d100'))
    if (mode === 'author') input.origin.source.author.id = '999999'
    if (mode === 'time') input.origin.source.occurredAt += 1000
    assert.equal((await f.send(input, f.guard)).state, 'failed'); assert.equal(f.sends.length, 0)
    assert.equal(f.reads.filter(row => row.action === 'get_msg').length, 2)
  }
})

test('all request and native evidence objects reject getters, proxies, cycles and sparse arrays without invoking user code', async () => {
  let touched = 0
  const getter = (value, key) => { Object.defineProperty(value, key, { enumerable: true, get() { touched++; throw Error('unsafe getter') } }); return value }
  const proxy = value => new Proxy(value, { ownKeys() { touched++; throw Error('unsafe proxy') }, get() { touched++; throw Error('unsafe proxy') } })
  for (const make of [ () => getter(request(), 'text'), () => proxy(request()), () => { const input = request(); input.source = proxy(input.source); return input },
    () => { const input = request(); input.source.parts = proxy(input.source.parts); return input },
    () => { const input = request(); input.origin.source = getter(input.origin.source, 'fingerprint'); return input },
    () => { const input = request(); input.source.parts = new Array(1); return input },
    () => { const input = request(); input.recipient = getter(input.recipient, 'id'); return input },
    () => { const input = request(), loop = {}; loop.self = loop; input.source.quote = { messageId: '111', parts: [loop] }; return input },
  ]) {
    const f = fixture(); assert.equal((await f.send(make(), f.guard)).state, 'failed'); assert.equal(f.reads.length, 0); assert.equal(f.sends.length, 0)
  }
  const loop = {}; loop.self = loop
  for (const response of [ { status: 'ok', retcode: 0, data: proxy(native()) }, getter({ status: 'ok', retcode: 0 }, 'data'),
    { status: 'ok', retcode: 0, data: { ...native(), message: proxy([]) } },
    { status: 'ok', retcode: 0, data: { ...native(), sender: getter({}, 'user_id') } },
    { status: 'ok', retcode: 0, data: { ...native(), sender: loop } },
  ]) { const f = fixture({ read: () => response }); assert.equal((await f.send(request(), f.guard)).state, 'failed'); assert.equal(f.sends.length, 0) }
  assert.equal(touched, 0)
})

test('source/recipient mutations or late host-account changes during reads fail closed', async () => {
  for (const mode of ['recipient', 'source', 'account', 'revision']) {
    const entered = deferred(), late = deferred(), input = request(), f = fixture({ read: async () => { entered.resolve(); return late.promise } })
    const pending = f.send(input, f.guard); await entered.promise
    if (mode === 'recipient') input.recipient.id = '999999'
    if (mode === 'source') input.source.text = '.rh 1d100'
    if (mode === 'account') f.hostAccount.id = '999999'
    if (mode === 'revision') input.origin.binding.revision = 'v2'
    late.resolve({ status: 'ok', retcode: 0, data: native() })
    assert.equal((await pending).state, 'failed'); assert.equal(f.sends.length, 0)
  }
})

test('revocation before and after transport queueing checks async authority and never dispatches the queued payload', async () => {
  const entered = deferred(), release = deferred(), f = fixture({ send: async (_action, _params, guard) => {
    entered.resolve(); await release.promise
    assert.equal(queuedDeliveryAllowed(), false)
    await assert.rejects(guard.ensureCurrent())
    return { state: 'failed', code: 'binding_changed' }
  } })
  const pending = f.send(request(), f.guard); await entered.promise; f.state.current = false; release.resolve()
  assert.deepEqual(await pending, { state: 'failed', code: 'binding_changed' }); assert.equal(f.sends.length, 1)
  const before = fixture(), controller = new AbortController(); controller.abort()
  for (const guard of [{ ...before.guard, signal: controller.signal }, { ...before.guard, isCurrent: () => false }, {}, null,
    { ...before.guard, ensureCurrent: new Proxy(async () => {}, {}) }]) assert.equal((await before.send(request(), guard)).state, 'failed')
  assert.equal(before.sends.length, 0)
})

test('final asynchronous source guard is awaited after all native proofs before sendApi', async () => {
  const f = fixture({ ensure: count => { if (count === 8) throw Error('privacy changed at final dispatch') } })
  // Initial guard plus adapter/fixture guard around each of the three reads is
  // seven checks; the eighth is the immediate pre-dispatch durable check.
  assert.equal((await f.send(request(), f.guard)).state, 'unknown')
  assert.equal(f.reads.length, 3); assert.equal(f.sends.length, 0)
})

test('unexpected native read failures are unknown and never trigger a private fallback or retry', async () => {
  const f = fixture({ read: () => { throw Error('unconfirmed transport failure') } })
  assert.deepEqual(await f.send(request(), f.guard), { state: 'unknown' }); assert.equal(f.reads.length, 1); assert.equal(f.sends.length, 0)
})

test('credential/output filtering can revoke a payload before evidence or after a queued read', async () => {
  const rejected = fixture({ allowsText: () => false }); assert.equal((await rejected.send(request(), rejected.guard)).state, 'failed'); assert.equal(rejected.reads.length, 0)
  let permitted = true
  const entered = deferred(), late = deferred(), f = fixture({ allowsText: () => permitted, read: async () => { entered.resolve(); return late.promise } })
  const pending = f.send(request(), f.guard); await entered.promise; permitted = false; late.resolve({ status: 'ok', retcode: 0, data: native() })
  assert.equal((await pending).state, 'failed'); assert.equal(f.sends.length, 0)
})

test('only an unambiguous native message ID confirms and ambiguous delivery never retries or emits fallback text', async () => {
  for (const response of [ null, {}, success(0), success('0001'), success('uuid'), success(Number.MAX_SAFE_INTEGER + 1),
    { ...success(), retcode: '0' }, { status: 'failed', retcode: 1200, data: { message_id: 1 } },
    { ...success(), data: { message_id: 1, user_id: '999999' } }, { ...success(), data: { message_id: 1, self_id: '999999' } },
    { ...success(), data: { message_id: 1, group_id: target.id } },
  ]) {
    const f = fixture({ receipt: response }); assert.deepEqual(await f.send(request(), f.guard), { state: 'unknown' }); assert.equal(f.sends.length, 1)
  }
  const throwing = fixture({ send: () => { throw Error('after dispatch') } }); assert.deepEqual(await throwing.send(request(), throwing.guard), { state: 'unknown' }); assert.equal(throwing.sends.length, 1)
  for (const code of [400, 1400]) {
    const f = fixture({ receipt: { status: 'failed', retcode: code, data: { message_id: 1 } } })
    assert.deepEqual(await f.send(request(), f.guard), { state: 'failed', code: String(code) }); assert.equal(f.sends.length, 1)
  }
})

test('abort after sendApi starts returns unknown without waiting for or retrying the late receipt', async () => {
  const entered = deferred(), late = deferred(), f = fixture({ send: () => { entered.resolve(); return late.promise } })
  const pending = f.send(request(), f.guard); await entered.promise; f.controller.abort()
  assert.deepEqual(await Promise.race([pending, delay(500).then(() => 'timeout')]), { state: 'unknown' })
  late.resolve(success()); await flush(); assert.equal(f.sends.length, 1)
})

test('a real adapter deadline fences hanging pre-dispatch and post-dispatch operations', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  assert.equal(QQ_DICE_PRIVATE_TIMEOUT_MS, 30000)
  const entered = deferred(), f = fixture({ send: () => { entered.resolve(); return new Promise(() => {}) } })
  const pending = f.send(request(), f.guard); await entered.promise; t.mock.timers.tick(30000)
  assert.deepEqual(await pending, { state: 'unknown' }); assert.equal(f.sends.length, 1); assert.equal(f.sends[0].guard.signal.aborted, true)
  const before = fixture({ read: () => new Promise(() => {}) }), rejected = before.send(request(), before.guard)
  await flush(); t.mock.timers.tick(30000); assert.equal((await rejected).state, 'unknown'); assert.equal(before.sends.length, 0)
})
