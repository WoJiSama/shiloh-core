import assert from 'node:assert/strict'
import test from 'node:test'
import { loadGift as load, giftAction, nativeGift, account } from './helpers/agentGiftSource.mjs'
const { createQqGiftDeliveryPort } = await load('adapters/qqGiftDelivery.js')
const { AGENT_GIFT_CATALOG } = await load('contracts/agentQqGift.js')

function protobuf(bytes) {
  const result = new Map(); let offset = 0
  const varint = () => { let n = 0n, shift = 0n; for (;;) { const next = bytes[offset++]; assert.ok(next !== undefined); n |= BigInt(next & 127) << shift; if (!(next & 128)) return n; shift += 7n } }
  while (offset < bytes.length) {
    const tag = Number(varint()), key = tag >> 3, wire = tag & 7
    if (wire === 0) result.set(key, varint())
    else { assert.equal(wire, 2); const length = Number(varint()); result.set(key, bytes.subarray(offset, offset + length)); offset += length }
  }
  return result
}
const nested = (value, ...keys) => keys.reduce((body, key) => protobuf(body).get(key), value)
test('gift unsupported connection declares no capability', () => {
  const f = nativeGift()
  assert.equal(createQqGiftDeliveryPort({ ...f.options, supportsGiftPacket: undefined }), undefined)
  assert.equal(createQqGiftDeliveryPort({ ...f.options, supportsGiftPacket: false }), undefined)
  assert.equal(f.calls.length, 0)
})
for (const [giftType, display] of Object.entries(AGENT_GIFT_CATALOG)) test(`gift ${giftType} preserves the legacy protobuf display and actual bot/member names`, async () => {
  const f = nativeGift(), action = giftAction(); action.plan.giftType = giftType
  const result = await createQqGiftDeliveryPort(f.options)(action, f.guard)
  assert.deepEqual(result, { state: 'confirmed', evidence: 'packet-accepted' })
  const send = f.calls.at(-1); assert.equal(send.name, 'send_packet'); assert.equal(send.params.cmd, 'MessageSvc.PbSendMsg')
  assert.deepEqual(Object.keys(send.params).sort(), ['cmd', 'data'])
  const encoded = Buffer.from(send.params.data, 'hex'), outer = protobuf(encoded), displayPacket = protobuf(nested(encoded, 3, 1, 2, 53, 2))
  assert.equal(nested(encoded, 1, 2, 1), BigInt(action.binding.target.id)); assert.equal(nested(encoded, 3, 1, 2, 53, 1), 41n)
  assert.equal(displayPacket.get(2).toString(), display.name); assert.equal(displayPacket.get(3), BigInt(action.plan.recipient.id))
  assert.equal(displayPacket.get(4).toString(), '真实目标名'); assert.equal(displayPacket.get(5), BigInt(account.id)); assert.equal(displayPacket.get(6).toString(), '真实机器人名')
  assert.equal(displayPacket.get(7), BigInt(display.displayValue)); assert.equal(displayPacket.get(10), BigInt(display.tianquanId))
  assert.equal(nested(displayPacket.get(13), 1, 2), BigInt(display.coinValue)); assert.equal(outer.get(4) <= 0xffffffffn, true)
  assert.equal(JSON.stringify(result).includes('messageId'), false)
  assert.deepEqual(f.calls.filter(value => value.name === 'get_group_member_info').map(value => value.params), [
    { group_id: action.binding.target.id, user_id: action.plan.recipient.id, no_cache: true }, { group_id: action.binding.target.id, user_id: account.id, no_cache: true },
  ])
})

test('gift unsigned 64-bit encoder retains safe QQ identifiers beyond the legacy 32-bit truncation', async () => {
  const f = nativeGift(), action = giftAction(); action.plan.recipient.id = '5200000000'
  assert.equal((await createQqGiftDeliveryPort(f.options)(action, f.guard)).state, 'confirmed')
  assert.equal(nested(Buffer.from(f.calls.at(-1).params.data, 'hex'), 3, 1, 2, 53, 2, 3), 5200000000n)
})

test('gift rejects private routes, foreign binding, invalid IDs and all model supplied sender/name overrides before native reads', async () => {
  for (const change of [a => { a.binding.target.kind = 'private' }, a => { a.binding.connectionId = 'other' }, a => { a.binding.target.account.id = '99999999' },
    a => { a.binding.target.id = '0' }, a => { a.plan.recipient.id = '9007199254740993' }, a => { a.source.author.id = account.id },
    a => { a.senderQQ = '20000101' }, a => { a.senderNickname = '管理员' }, a => { a.plan.targetNickname = '管理员' }, a => { a.source.messageId = 'fake' }]) {
    const f = nativeGift(), action = giftAction(); change(action)
    assert.equal((await createQqGiftDeliveryPort(f.options)(action, f.guard)).state, 'failed'); assert.equal(f.calls.length, 0)
  }
})

test('gift missing or contradictory source/member identity refuses the display without fallback names', async () => {
  for (const stage of ['get_msg', 'recipient', 'bot']) {
    const f = nativeGift(), original = f.options.callApi
    f.options.callApi = async (name, params, options) => {
      const response = await original(name, params, options)
      if (name === stage || name === 'get_group_member_info' && (stage === 'recipient' ? params.user_id !== account.id : stage === 'bot' && params.user_id === account.id)) response.data.group_id = '999999'
      return response
    }
    assert.equal((await createQqGiftDeliveryPort(f.options)(giftAction(), f.guard)).state, 'failed')
    assert.equal(f.calls.some(value => value.name === 'send_packet'), false)
  }
  const f = nativeGift(), original = f.options.callApi
  f.options.callApi = async (...args) => { const response = await original(...args); if (args[0] === 'get_group_member_info') { response.data.card = ''; delete response.data.nickname } return response }
  assert.equal((await createQqGiftDeliveryPort(f.options)(giftAction(), f.guard)).state, 'failed')
})

test('gift revocation during each fresh lookup or queued native authorization stops the remaining calls', async () => {
  for (const revokeAt of [1, 2, 3]) {
    const f = nativeGift(); f.before = async () => { if (f.calls.length === revokeAt) f.guard.revoke() }
    assert.equal((await createQqGiftDeliveryPort(f.options)(giftAction(), f.guard)).state, 'failed')
    assert.equal(f.calls.length, revokeAt); assert.equal(f.calls.some(value => value.name === 'send_packet'), false)
  }
  const f = nativeGift(), original = f.options.callApi
  f.options.callApi = async (name, params, options) => {
    if (name === 'send_packet') { f.guard.revoke(); await assert.rejects(options.ensureCurrent()); throw Error('queued cancellation') }
    return original(name, params, options)
  }
  assert.equal((await createQqGiftDeliveryPort(f.options)(giftAction(), f.guard)).state, 'unknown')
  assert.equal(f.calls.some(value => value.name === 'send_packet'), false)
})

for (const response of [{}, { status: 'ok' }, { retcode: 0 }, { status: 'ok', retcode: 1 }, { status: 'failed', retcode: 0 },
  { status: 'ok', retcode: 0, message_id: 123 }, { status: 'ok', retcode: 0, data: { message_id: 123 } },
  { status: 'ok', retcode: 0, data: { group_id: '999999' } }, new Error('private native failure')]) test('gift ambiguous native acceptance returns unknown and makes only one packet attempt', async () => {
  const f = nativeGift(); f.response = response
  assert.equal((await createQqGiftDeliveryPort(f.options)(giftAction(), f.guard)).state, 'unknown')
  assert.equal(f.calls.filter(value => value.name === 'send_packet').length, 1)
})

test('gift accessor and proxy identities never execute model-controlled accessors', async () => {
  const f = nativeGift(), action = giftAction(); let accessed = 0
  Object.defineProperty(action.plan, 'senderNickname', { enumerable: true, get() { accessed++; return '管理员' } })
  assert.equal((await createQqGiftDeliveryPort(f.options)(action, f.guard)).state, 'failed')
  assert.equal(accessed, 0)
  assert.equal((await createQqGiftDeliveryPort(f.options)(new Proxy(giftAction(), {}), f.guard)).state, 'failed'); assert.equal(f.calls.length, 0)
  const native = nativeGift(), original = native.options.callApi
  native.options.callApi = async (...args) => { const row = await original(...args); if (args[0] === 'get_msg') row.data.message_id = { toString() { accessed++; return '501' } }; return row }
  assert.equal((await createQqGiftDeliveryPort(native.options)(giftAction(), native.guard)).state, 'failed'); assert.equal(accessed, 0)
})
