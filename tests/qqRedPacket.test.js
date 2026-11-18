import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'

const { createQqRedPacketPort, QQ_RED_PACKET_TIMEOUT_MS } = await importBilibiliHost('adapters/qqRedPacket.js')
const { queuedDeliveryAllowed } = await importBilibiliHost('modules/messaging/infrastructure/deliveryScope.js')
const account = { platform: 'qq', namespace: 'global', id: '19000501' }, target = { account, kind: 'group', id: '312501' }
const ok = (data = null, extra = {}) => ({ status: 'ok', retcode: 0, data, ...extra })
const wallet = (patch = {}) => ({ type: 'wallet', data: { pc_body: 'PRIVATE_PC_BODY', string_index: 'PRIVATE_PACKET_INDEX', msg_seq: '102', title: '红包口令[CQ:at,qq=all]', red_type: 2, ...patch } })
const message = (patch = {}) => ({ post_type: 'message', self_id: account.id, message_type: 'group', group_id: target.id, message_id: -42,
  user_id: '222222', sender: { user_id: '222222' }, time: Math.floor(Date.now() / 1000) - 2, message_seq: 102, message: [wallet()], ...patch })
const botMember = (patch = {}) => ({ group_id: target.id, user_id: account.id, card: '绑定机器人', nickname: 'QQ昵称', ...patch })
const grab = (amount = '138', result = 0) => ok({ result: { grabRedBagRsp: { result, recvdOrder: { amount } } } })
function fixture(settings = {}) {
  const calls = [], effects = [], controller = new AbortController(); let current = true, source = message(settings.source), member = botMember(settings.member)
  const guard = { signal: controller.signal, isCurrent: () => current, async ensureCurrent() { if (!current) throw Error('REVOKED_PRIVATE_TOKEN') } }
  const port = createQqRedPacketPort({ account, connectionId: 'red-packet-socket', driver: 'napcat', supportsRedPacket: true, isReady: () => true,
    async callApi(action, params, scope) {
      calls.push({ action, params, scope })
      if (settings.callApi) return settings.callApi(action, params, scope, f)
      if (action === 'get_msg') return ok(source)
      if (action === 'get_group_msg_history') return ok({ messages: settings.history ?? [source] })
      if (action === 'get_group_member_info') return ok(member)
      effects.push(action)
      return action === 'send_group_msg' ? settings.passwordReceipt ?? ok({ message_id: -80 }) : settings.grabReceipt ?? grab()
    }, ...settings.options })
  const f = { port, calls, effects, controller, guard, setSource(value) { source = value }, setMember(value) { member = value }, revoke() { current = false },
    read: () => port.read(target, '-42', guard), async clearRead() { const packet = await f.read(); assert.ok(packet); calls.length = 0; return packet } }
  return f
}
const actions = f => f.calls.map(value => value.action)
const nativeOnly = f => f.calls.filter(value => ['send_group_msg', 'grab_red_bag'].includes(value.action))

test('QQ red packet capability is absent unless this authenticated implementation explicitly supports NapCat extensions', () => {
  for (const options of [{}, { driver: 'llbot', supportsRedPacket: true }, { driver: 'unknown', supportsRedPacket: true }, { driver: 'napcat' },
    { driver: 'napcat', supportsRedPacket: false }, { driver: 'NapCat', supportsRedPacket: true }]) {
    assert.equal(createQqRedPacketPort({ ...options }), undefined)
  }
  assert.equal(QQ_RED_PACKET_TIMEOUT_MS, 30_000)
  for (const options of [{ account: { ...account, namespace: 'other' } }, { account: { ...account, id: '019000501' } }, { connectionId: '' },
    { callApi: true }, { isReady: true }, { timeoutMs: 0 }, { timeoutMs: 30001 }]) assert.throws(() => fixture({ options }))
})

test('QQ wallet read obtains fresh source proof and exposes immutable opaque metadata without native credentials', async () => {
  const f = fixture(), packet = await f.read()
  assert.deepEqual(actions(f), ['get_msg']); assert.deepEqual(f.calls[0].params, { message_id: -42 })
  assert.equal(packet.source.messageId, '-42'); assert.equal(packet.source.author.id, '222222'); assert.equal(packet.source.at, f.calls.length && message().time * 1000)
  assert.equal(packet.kind, 'normal'); assert.match(packet.packetIdentity, /^[a-f0-9]{64}$/u); assert.match(packet.packetRef, /^qqrp_[a-f0-9]{48}$/u)
  assert.ok(Object.isFrozen(packet)); assert.ok(Object.isFrozen(packet.source.author)); assert.ok(Object.isFrozen(packet.target.account))
  assert.equal(JSON.stringify(packet).includes('PRIVATE_'), false)
  assert.equal(Object.hasOwn(packet, 'pc_body'), false); assert.equal(Object.hasOwn(packet, 'msg_seq'), false)
  for (const { params, scope } of f.calls) {
    assert.ok(Object.isFrozen(params)); assert.ok(Object.isFrozen(scope)); assert.ok(scope.signal instanceof AbortSignal)
    assert.ok(scope.timeoutMs > 0 && scope.timeoutMs <= 30_000); assert.equal(typeof scope.ensureCurrent, 'function')
  }
})

test('an outer native author field must agree with the source author proved by get_msg', async () => {
  const accepted = fixture({ callApi: () => ok(message(), { self_id: account.id, group_id: target.id, user_id: '222222' }) })
  assert.ok(await accepted.read())
  const rejected = fixture({ callApi: () => ok(message(), { user_id: '333333' }) })
  assert.equal(await rejected.read(), undefined)
})

for (const [kind, patch, exclusiveForBot] of [['normal', { red_type: 2 }, false], ['lucky', { red_type: 1, raw: { msgType: 3 } }, false],
  ['password', { red_channel: 32 }, false], ['exclusive', { red_channel: 1024, raw: { grapUin: [account.id] } }, true],
  ['exclusive', { raw: { redChannel: 1024, grapUin: ['333333'] } }, false], ['unknown', { red_type: 4 }, false]]) {
  test(`QQ wallet classifies ${kind} from real native wallet evidence`, async () => {
    const f = fixture({ source: { message: [wallet(patch)] } }), packet = await f.read()
    assert.equal(packet.kind, kind); assert.equal(packet.exclusiveForBot, exclusiveForBot)
  })
}

test('real packet identity is independent of source alias, human command, binding and account but includes actual native packet and group', async () => {
  const f = fixture(), first = await f.read()
  const alias = message({ message_id: -43, message_seq: 103, message: [wallet({ msg_seq: '103' })] }); f.setSource(alias)
  const second = await f.port.read(target, '-43', f.guard)
  assert.equal(first.packetIdentity, second.packetIdentity); assert.notEqual(first.packetRef, second.packetRef)
  f.setSource(message({ message: [wallet({ string_index: 'DIFFERENT_REAL_PACKET' })] }))
  const third = await f.read(); assert.notEqual(third.packetIdentity, first.packetIdentity)
})

test('QQ wallet rejects private/foreign/malformed targets before native reads', async () => {
  const f = fixture()
  for (const scope of [{ ...target, kind: 'private' }, { ...target, id: '0312501' }, { ...target, id: 312501 },
    { ...target, account: { ...account, id: '333333' } }, { ...target, account: { ...account, namespace: 'other' } }, { ...target, group_id: '333333' }]) {
    assert.equal(await f.port.read(scope, '-42', f.guard), undefined)
  }
  for (const id of ['0', '-042', '2147483648', '-2147483649', '', 'source', 42.1]) assert.equal(await f.port.read(target, id, f.guard), undefined)
  assert.equal(f.calls.length, 0)
})

test('QQ wallet requires exact source ID, author, conversation, timestamp and a single complete native wallet', async () => {
  for (const patch of [{ message_type: 'private' }, { group_id: '999999' }, { group_id: undefined }, { message_id: -43 }, { message_id: '-042' },
    { user_id: undefined }, { user_id: '0222222' }, { sender: {} }, { sender: { user_id: '333333' } }, { self_id: '999999' },
    { time: 0 }, { time: 1.5 }, { time: String(message().time) }, { time: Math.floor(Date.now() / 1000) + 120 }, { post_type: 'notice' },
    { message: [{ type: 'extension', data: wallet().data }] }, { message: [] }, { message: [wallet(), wallet()] },
    { message: [wallet({ pc_body: undefined })] }, { message: [wallet({ pc_body: '' })] }, { message: [wallet({ pc_body: 'x'.repeat(65537) })] },
    { message: [wallet({ string_index: undefined })] }, { message: [wallet({ msg_seq: '103' })] }, { message_seq: undefined, message: [wallet({ msg_seq: undefined })] },
    { message: [wallet({ red_channel: 32, title: '' })] }, { message: [wallet({ title: 'bad\u0000title' })] }]) {
    const f = fixture({ source: patch }); assert.equal(await f.read(), undefined, JSON.stringify(patch)); assert.equal(nativeOnly(f).length, 0)
  }
  for (const reply of [{ status: 'ok', retcode: '0', data: message() }, ok(message(), { self_id: '999999' }), ok(message(), { group_id: '999999' }),
    { status: 'failed', retcode: 1200 }, ok(null), { state: 'confirmed' }]) {
    const f = fixture({ callApi: () => reply }); assert.equal(await f.read(), undefined)
  }
})

test('recent wallet search is bounded, newest first and cannot invoke native side effects', async () => {
  const history = [message({ message_id: -40, time: message().time - 10 }), message({ message_id: -42 }), message({ message_id: -41, time: message().time - 5 }),
    message({ message_id: -44, message: [{ type: 'text', data: { text: 'ordinary message' } }] })]
  const f = fixture({ history }), packets = await f.port.recent(target, { ...f.guard, limit: 1000 })
  assert.deepEqual(packets.map(value => value.source.messageId), ['-42', '-41', '-40'])
  assert.deepEqual(f.calls[0].params, { group_id: target.id, count: 1000 }); assert.equal(nativeOnly(f).length, 0); assert.ok(Object.isFrozen(packets))
  f.calls.length = 0
  for (const limit of [0, 1001, 1.5, '100', undefined]) assert.deepEqual(await f.port.recent(target, { ...f.guard, limit }), [])
  assert.equal(f.calls.length, 0)
  const tooMany = fixture({ history }); assert.deepEqual(await tooMany.port.recent(target, { ...tooMany.guard, limit: 1 }), [])
})

test('revalidate freshly reads exact native credentials and source rather than trusting a previous snapshot', async () => {
  const f = fixture(), packet = await f.clearRead()
  assert.equal(await f.port.revalidate(packet, f.guard), true); assert.deepEqual(actions(f), ['get_msg'])
  for (const patch of [{ message: [wallet({ pc_body: 'CHANGED_SECRET' })] }, { message: [wallet({ string_index: 'CHANGED_INDEX' })] },
    { message: [wallet({ title: 'CHANGED_TITLE' })] }, { message: [wallet({ red_channel: 32 })] },
    { message_seq: 103, message: [wallet({ msg_seq: '103' })] }, { user_id: '333333', sender: { user_id: '333333' } }, { time: message().time - 1 }]) {
    f.setSource(message(patch)); assert.equal(await f.port.revalidate(packet, f.guard), false); assert.equal((await f.port.grab(packet, f.guard)).state, 'failed')
  }
  assert.equal(nativeOnly(f).length, 0)
})

test('opaque packet handles cannot be forged, altered, reused on another adapter or retained after revoke', async () => {
  const f = fixture(), packet = await f.clearRead(), foreign = fixture()
  for (const fake of [{ ...packet, title: 'model password' }, { ...packet, kind: 'password' }, { ...packet, packetIdentity: 'a'.repeat(64) },
    { ...packet, source: { ...packet.source, author: { ...account, id: '333333' } } }, { ...packet, target: { ...target, id: '333333' } },
    { ...packet, pc_body: 'forged' }, { ...packet, packetRef: 'qqrp_' + 'a'.repeat(48) }, { ...packet, observedAt: packet.observedAt + 1 }]) {
    assert.equal(await f.port.revalidate(fake, f.guard), false); assert.equal((await f.port.grab(fake, f.guard)).state, 'failed')
  }
  assert.equal(await foreign.port.revalidate(packet, foreign.guard), false); assert.equal(f.calls.length, 0)
  f.port.revoke(target, '-42'); assert.equal(await f.port.revalidate(packet, f.guard), false); assert.equal(f.calls.length, 0)
})

test('password send freshly proves the source, sends only the exact native text segment, and requires a native message ID', async () => {
  const f = fixture({ source: { message: [wallet({ red_channel: 32 })] } }), packet = await f.clearRead()
  assert.deepEqual(await f.port.sendPassword(packet, f.guard), { state: 'confirmed', messageId: '-80' })
  assert.deepEqual(actions(f), ['get_msg', 'send_group_msg'])
  assert.deepEqual(f.calls[1].params, { group_id: target.id, message: [{ type: 'text', data: { text: wallet().data.title } }] })
  assert.equal(f.calls.some(value => value.action === 'grab_red_bag'), false)
  const normal = fixture(), regular = await normal.clearRead(); assert.equal((await normal.port.sendPassword(regular, normal.guard)).state, 'failed'); assert.equal(normal.calls.length, 0)
})

test('password receipt omissions, contradictory scopes and arbitrary success markers freeze as unknown', async () => {
  for (const receipt of [ok(), ok({}), ok({ message_id: 0 }), ok({ message_id: 2147483648 }), ok({ message_id: '-080' }),
    ok({ message_id: -80, group_id: '333333' }), ok({ message_id: -80, self_id: '333333' }), ok({ message_id: -80, user_id: '222222' }),
    ok({ message_id: -80 }, { message_id: -81 }), ok({ message_id: -80, messageId: '-80' }), { state: 'sent', messageId: '-80' },
    { status: 'ok', retcode: '0', data: { message_id: -80 } }, { status: 'failed', retcode: 1200 }, { state: 'unknown' }]) {
    const f = fixture({ source: { message: [wallet({ red_channel: 32 })] }, passwordReceipt: receipt }), packet = await f.clearRead()
    assert.deepEqual(await f.port.sendPassword(packet, f.guard), { state: 'unknown' }, JSON.stringify(receipt)); assert.equal(nativeOnly(f).length, 1)
  }
})

test('grab uses fresh packet and current bot membership evidence and returns only confirmed integer fen', async () => {
  const f = fixture(), packet = await f.clearRead(), receipt = await f.port.grab(packet, f.guard)
  assert.deepEqual(receipt, { state: 'confirmed', amountFen: 138 }); assert.equal(Object.hasOwn(receipt, 'messageId'), false)
  assert.deepEqual(actions(f), ['get_msg', 'get_group_member_info', 'grab_red_bag'])
  assert.deepEqual(f.calls[1].params, { group_id: target.id, user_id: account.id, no_cache: true })
  assert.deepEqual(f.calls[2].params, { recv_uin: target.id, recv_type: 2, peer_uid: target.id, name: '绑定机器人',
    pc_body: 'PRIVATE_PC_BODY', wishing: wallet().data.title, msg_seq: '102', index: 'PRIVATE_PACKET_INDEX' })
  const nick = fixture({ member: { card: '' } }), nickPacket = await nick.clearRead(); await nick.port.grab(nickPacket, nick.guard)
  assert.equal(nick.calls.at(-1).params.name, 'QQ昵称')
})

test('unknown native grab results never become successful money amounts or fabricated messages', async () => {
  for (const receipt of [ok(), ok({}), ok({ result: {} }), grab('1.5'), grab('1e2'), grab(' 138'), grab('+138'), grab('0138'), grab(-1), grab(0.1),
    grab('9007199254740992'), grab('138', 7), grab('138', '0'), ok({ result: { grabRedBagRsp: { result: 0 } } }),
    ok({ result: { grabRedBagRsp: { result: 0, recvdOrder: { amount: '138' }, message_id: -99 } } }),
    ok({ result: { grabRedBagRsp: { result: 0, recvdOrder: { amount: '138' } } } }, { self_id: '333333' }),
    { state: 'confirmed', amountFen: 138 }, { status: 'failed', retcode: 1200 }]) {
    const f = fixture({ grabReceipt: receipt }), packet = await f.clearRead()
    assert.deepEqual(await f.port.grab(packet, f.guard), { state: 'unknown' }, JSON.stringify(receipt)); assert.equal(nativeOnly(f).length, 1)
  }
  for (const [receipt, code] of [[grab('0'), 'red_packet_already_received'], [grab('0', 7), 'red_packet_empty_or_expired'],
    [ok({ result: { grabRedBagRsp: { result: 7 } } }), 'red_packet_empty_or_expired']]) {
    const f = fixture({ grabReceipt: receipt }), packet = await f.clearRead(); assert.deepEqual(await f.port.grab(packet, f.guard), { state: 'failed', code })
  }
})

test('native schema rejection is definite failure and handler exceptions remain unknown after a dispatch', async () => {
  for (const operation of ['grab', 'sendPassword']) for (const [receipt, state] of [[{ status: 'failed', retcode: 400 }, 'failed'],
    [{ status: 'failed', retcode: 1400 }, 'failed'], [{ state: 'failed', code: 'INTERNAL_PRE_DISPATCH_REJECTION' }, 'failed'], [{ status: 'failed', retcode: 200 }, 'unknown']]) {
    const f = fixture({ source: { message: [wallet({ red_channel: 32 })] }, grabReceipt: receipt, passwordReceipt: receipt }), packet = await f.clearRead()
    const result = await f.port[operation](packet, f.guard); assert.equal(result.state, state); assert.equal(JSON.stringify(result).includes('INTERNAL_'), false)
  }
})

test('grab cannot borrow an absent/foreign bot member, a model nickname, or another user exclusive packet', async () => {
  for (const patch of [{ group_id: undefined }, { group_id: '333333' }, { user_id: undefined }, { user_id: '222222' }, { self_id: '333333' },
    { card: '', nickname: '' }, { card: '', nickname: undefined }, { card: 'bad\u0000name' }]) {
    const f = fixture({ member: patch }), packet = await f.clearRead(); assert.equal((await f.port.grab(packet, f.guard)).state, 'failed'); assert.equal(nativeOnly(f).length, 0)
  }
  const f = fixture({ source: { message: [wallet({ red_channel: 1024, raw: { grapUin: ['333333'] } })] } }), packet = await f.clearRead()
  assert.equal((await f.port.grab(packet, f.guard)).state, 'failed'); assert.equal(f.calls.length, 0)
})

test('source revocation between fresh read and dispatch stops every later native call', async () => {
  for (const boundary of ['get_msg', 'get_group_member_info']) {
    let active = false
    const f = fixture({ callApi(action, params, scope, own) {
      if (action === 'get_msg') { if (active && boundary === 'get_msg') own.revoke(); return ok(message()) }
      if (action === 'get_group_member_info') { if (active) own.revoke(); return ok(botMember()) }
      assert.fail('native side effect ran after revocation')
    } }), packet = await f.clearRead(); active = true
    assert.equal((await f.port.grab(packet, f.guard)).state, 'failed'); assert.equal(nativeOnly(f).length, 0)
    assert.deepEqual(actions(f), boundary === 'get_msg' ? ['get_msg'] : ['get_msg', 'get_group_member_info'])
  }
})

test('captured guard is propagated through the native queue and cancellation prevents a queued effect', async () => {
  let reached, release; const queued = new Promise(resolve => { reached = resolve }), gate = new Promise(resolve => { release = resolve })
  const f = fixture({ async callApi(action, params, scope, own) {
    if (action === 'get_msg') return ok(message())
    if (action === 'get_group_member_info') return ok(botMember())
    assert.equal(queuedDeliveryAllowed(), true); reached(scope); await gate
    assert.equal(scope.isCurrent(), false); assert.equal(queuedDeliveryAllowed(), false)
    await assert.rejects(scope.ensureCurrent()); own.effects.push('checked_rejected_queue')
    return { state: 'failed', code: 'cancelled_before_native_dispatch' }
  } }), packet = await f.clearRead(), pending = f.port.grab(packet, f.guard)
  const scope = await queued; f.revoke(); release()
  assert.deepEqual(await pending, { state: 'unknown' }); assert.deepEqual(f.effects, ['checked_rejected_queue']); assert.equal(scope.signal.aborted, true)
})

test('trusted native wallet ingress accepts no-text wallets and requires its fresh exact authenticated source', async () => {
  const f = fixture(), incoming = message(), packet = await f.port.readIncoming(target, incoming, f.guard)
  assert.ok(packet); assert.equal(packet.source.messageId, '-42'); assert.deepEqual(actions(f), ['get_msg']); assert.equal(Object.hasOwn(packet, 'text'), false)
  f.calls.length = 0
  for (const input of [{ ...incoming, self_id: '333333' }, { ...incoming, self_id: undefined }, { ...incoming, post_type: 'notice' },
    { ...incoming, message: [{ type: 'extension', data: wallet().data }] }]) assert.equal(await f.port.readIncoming(target, input, f.guard), undefined)
  assert.equal(f.calls.length, 0)
  const changed = { ...incoming, message: [wallet({ title: 'SUBSTITUTED_WALLET' })] }
  assert.equal(await f.port.readIncoming(target, changed, f.guard), undefined); assert.deepEqual(actions(f), ['get_msg'])
})

test('timeout or cancellation after native dispatch freezes as unknown without retrying or grabbing after a password', async () => {
  for (const operation of ['grab', 'sendPassword']) {
    const f = fixture({ options: { timeoutMs: 40 }, source: { message: [wallet({ red_channel: 32 })] }, callApi(action) {
      if (action === 'get_msg') return ok(message({ message: [wallet({ red_channel: 32 })] }))
      if (action === 'get_group_member_info') return ok(botMember())
      return new Promise(() => {})
    } }), packet = await f.clearRead(), result = await f.port[operation](packet, f.guard)
    assert.deepEqual(result, { state: 'unknown' }); assert.equal(nativeOnly(f).length, 1)
    assert.equal(f.calls.at(-1).scope.signal.aborted, true)
  }
  const read = fixture({ options: { timeoutMs: 40 }, callApi: () => new Promise(() => {}) })
  assert.equal(await read.read(), undefined); assert.equal(read.calls.length, 1)
})

test('port close, source revoke, readiness loss and already aborted scopes prevent stale credential reuse', async () => {
  for (const stop of [f => f.port.close(), f => f.port.revoke(target), f => f.revoke(), f => f.controller.abort()]) {
    const f = fixture(), packet = await f.clearRead(); stop(f)
    assert.equal((await f.port.grab(packet, f.guard)).state, 'failed'); assert.equal(f.calls.length, 0)
  }
  const notReady = fixture({ options: { isReady: () => false } }); assert.equal(await notReady.read(), undefined); assert.equal(notReady.calls.length, 0)
  let entered; const reached = new Promise(resolve => { entered = resolve })
  const f = fixture({ callApi() { entered(); return new Promise(() => {}) } }), pending = f.read()
  await reached; f.port.close(); assert.equal(await pending, undefined); assert.equal(f.calls[0].scope.signal.aborted, true)
})

test('source revoke aborts an in-flight read and does not reintroduce its credentials after a late native reply', async () => {
  let entered, release
  const reached = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
  const f = fixture({ async callApi() { entered(); await gate; return ok(message()) } }), pending = f.read()
  await reached; f.port.revoke(target, '-42'); release()
  assert.equal(await pending, undefined); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].scope.signal.aborted, true)
})

test('cached native credentials expire and cannot be revived by a stale handle', async t => {
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock)
  const f = fixture(), packet = await f.clearRead(); clock += 5 * 60_000
  assert.equal(await f.port.revalidate(packet, f.guard), false); assert.equal((await f.port.grab(packet, f.guard)).state, 'failed'); assert.equal(f.calls.length, 0)
})

test('malicious source objects, native responses, guards and handles cannot execute getters, proxies or coercions', async () => {
  let touched = 0
  const proxy = value => new Proxy(value, { get() { touched++; throw Error('trap') }, ownKeys() { touched++; throw Error('trap') }, getPrototypeOf() { touched++; throw Error('trap') } })
  const accessor = (value, key) => { const row = { ...value }; Object.defineProperty(row, key, { enumerable: true, get() { touched++; throw Error('getter') } }); return row }
  const f = fixture(), packet = await f.clearRead()
  for (const input of [proxy(target), accessor(target, 'id'), { ...target, account: proxy(account) }]) assert.equal(await f.port.read(input, '-42', f.guard), undefined)
  for (const guard of [proxy(f.guard), accessor(f.guard, 'isCurrent'), { ...f.guard, isCurrent: proxy(() => true) },
    { ...f.guard, signal: proxy(f.guard.signal) }, { ...f.guard, ensureCurrent: true }, { ...f.guard, extra: true }]) assert.equal(await f.port.read(target, '-42', guard), undefined)
  for (const input of [proxy(packet), accessor(packet, 'packetRef'), { ...packet, source: proxy(packet.source) },
    { ...packet, title: { toJSON() { touched++; return 'forged' } } }, { ...packet, observedAt: { toJSON() { touched++; return 123 } } }]) {
    assert.equal((await f.port.grab(input, f.guard)).state, 'failed')
  }
  // A Promise itself assimilates an outer proxy's `then` before an adapter can see it; native JSON payloads are plain data.
  for (const proof of [accessor(ok(message()), 'self_id'), ok(proxy(message())), ok(accessor(message(), 'group_id')), ok(message({ message: [proxy(wallet())] })),
    ok(message({ message: [{ type: 'wallet', data: proxy(wallet().data) }] }))]) {
    const native = fixture({ callApi: () => proof }); assert.equal(await native.read(), undefined)
  }
  assert.equal(touched, 0); assert.equal(f.calls.length, 0)
})

test('native credential cache is bounded and oldest handles are invalidated', async () => {
  const f = fixture(), first = await f.read()
  for (let index = 0; index < 256; index++) assert.ok(await f.read())
  f.calls.length = 0; assert.equal(await f.port.revalidate(first, f.guard), false); assert.equal(f.calls.length, 0)
})

test('actual loopback JSON transport completes fresh password and grab contracts without external services', async t => {
  const received = [], source = message({ message: [wallet({ red_channel: 32 })] }), server = createServer(async (request, reply) => {
    let bytes = ''; for await (const chunk of request) bytes += chunk
    const input = JSON.parse(bytes); received.push(input)
    const output = input.action === 'get_msg' ? ok(source) : input.action === 'get_group_member_info' ? ok(botMember())
      : input.action === 'send_group_msg' ? ok({ message_id: -80 }) : grab('567')
    reply.writeHead(200, { 'content-type': 'application/json' }); reply.end(JSON.stringify(output))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)))
  const port = createQqRedPacketPort({ account, connectionId: 'local-http-socket', driver: 'napcat', supportsRedPacket: true, isReady: () => true,
    async callApi(action, params, scope) {
      await scope.ensureCurrent(); assert.equal(scope.isCurrent(), true)
      return (await fetch(`http://127.0.0.1:${server.address().port}/`, { method: 'POST', body: JSON.stringify({ action, params }), signal: scope.signal })).json()
    } })
  t.after(() => port.close())
  const guard = { signal: new AbortController().signal, isCurrent: () => true, async ensureCurrent() {} }, packet = await port.read(target, '-42', guard)
  assert.deepEqual(await port.sendPassword(packet, guard), { state: 'confirmed', messageId: '-80' })
  assert.deepEqual(await port.grab(packet, guard), { state: 'confirmed', amountFen: 567 })
  assert.deepEqual(received.map(value => value.action), ['get_msg', 'get_msg', 'send_group_msg', 'get_msg', 'get_group_member_info', 'grab_red_bag'])
  assert.equal(JSON.stringify(packet).includes('PRIVATE_'), false)
})
