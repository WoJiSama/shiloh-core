import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { loadRedPacketSource as load, redPacketRedis } from './helpers/agentRedPacketSource.mjs'

const { createAgentRedPacketRuntime, createAgentRedPacketAutomaticProducer } = await load('modules/runtime/infrastructure/agentRedPacketRuntime.js')
const { createAgentRedPacketTools } = await load('modules/tools/infrastructure/agentRedPacketTools.js')
const { createAgentRedPacketLedger } = await load('modules/runtime/infrastructure/agentRedPacketLedger.js')
const { createQqRedPacketPort } = await load('adapters/qqRedPacket.js')
const account = { platform: 'qq', namespace: 'global', id: '10001' }, author = { ...account, id: '20001' }, target = { account, kind: 'group', id: '30001' }
const binding = { source: 'configured', id: 'bound', revision: 'one', agentId: 'role', personaId: 'default', connectionId: 'qq', target }
const ok = data => ({ status: 'ok', retcode: 0, data })
const wallet = (index, kind) => ({ post_type: 'message', self_id: account.id, message_type: 'group', group_id: target.id, message_id: index,
  user_id: author.id, sender: { user_id: author.id }, time: Math.floor(Date.now() / 1000) - 1, message_seq: 700 + index,
  message: [{ type: 'wallet', data: { pc_body: 'PRIVATE_WALLET_CREDENTIAL_' + index, string_index: 'PRIVATE_WALLET_INDEX_' + index, msg_seq: String(700 + index),
    red_type: 2, red_channel: kind === 'password' ? 32 : kind === 'exclusive' ? 1024 : 0, title: '真实口令[CQ:at,qq=all]', raw: kind === 'exclusive' ? { grapUin: [account.id] } : {} } }] })

async function fixture(t, settings = {}) {
  const redis = await redPacketRedis(t), packets = new Map([[41, wallet(41, settings.kind ?? 'password')], [42, wallet(42, 'exclusive')]])
  const wire = [], stages = [], waits = [], sourceChecks = []
  let current = true, sourceCurrent = true
  const policy = { enabled: true, allowExplicit: true, allowPasswordSend: true,
    automatic: { enabled: true, toolConfigured: true, allowPasswordSend: true } }
  const server = createServer(async (req, response) => {
    let body = ''; for await (const chunk of req) body += chunk
    const { action, params } = JSON.parse(body); wire.push({ action, params })
    let output
    if (action === 'get_msg') output = ok(packets.get(Number(params.message_id)))
    else if (action === 'get_group_member_info') output = ok({ group_id: target.id, user_id: account.id, card: '可信机器人', nickname: 'QQ原昵称' })
    else if (action === 'get_group_msg_history') output = ok({ messages: [...packets.values()] })
    else if (action === 'send_group_msg') { stages.push((await ledger.inspect(account, f.packet.packetIdentity)).phase); output = settings.passwordReceipt ?? ok({ message_id: -91 }) }
    else if (action === 'grab_red_bag') { stages.push((await ledger.inspect(account, f.packet.packetIdentity)).phase); output = settings.grabReceipt ?? ok({ result: { grabRedBagRsp: { result: 0, recvdOrder: { amount: '567' } } } }) }
    else throw new Error('Unexpected local QQ action')
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(output))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const port = createQqRedPacketPort({ account, connectionId: binding.connectionId, driver: 'napcat', supportsRedPacket: true, isReady: () => true,
    async callApi(action, params, guard) {
      await guard.ensureCurrent()
      if (!guard.isCurrent()) return { state: 'failed', code: 'cancelled' }
      return (await fetch(`http://127.0.0.1:${server.address().port}/`, { method: 'POST', body: JSON.stringify({ action, params }), signal: guard.signal })).json()
    } })
  t.after(() => port.close())
  const guard = { signal: new AbortController().signal, isCurrent: () => current, async ensureCurrent() { if (!current) throw Error('revoked') } }
  const sourceAvailable = async source => { sourceChecks.push(source.messageId); return sourceCurrent }
  const runtime = createAgentRedPacketRuntime({ storage: redis.storage, port, policy: () => policy, random: () => 0,
    async wait(ms) { waits.push(ms); const state = await ledger.inspect(account, f.packet.packetIdentity); assert.equal(state.phase, 'password_confirmed'); await settings.wait?.(f) } })
  const ledger = createAgentRedPacketLedger(redis.storage)
  const context = { binding, actor: { kind: 'user', user: author }, request: { messageId: 'human-command-1', text: '帮我领取这个红包', mentions: [], replyMessageId: '41' },
    ...guard, isSourceAvailable: sourceAvailable }
  const [tool] = createAgentRedPacketTools({ enabled: true, execute: (request, ctx) => runtime.execute({ ...ctx, isSourceAvailable: sourceAvailable }, request) })
  const packet = await port.read(target, '41', guard)
  assert.ok(packet)
  let f = { redis, wire, stages, waits, sourceChecks, port, context, runtime, ledger, packet, packets, policy, tool,
    revoke() { current = false }, revokeSource() { sourceCurrent = false }, run: () => tool.execute({}, context),
    auto: packet => createAgentRedPacketAutomaticProducer(runtime).accept({ binding, ...guard, isSourceAvailable: sourceAvailable }, packet) }
  wire.length = 0
  return f
}

test('current-source tool, real Redis, typed QQ adapter and loopback JSON transport complete two-phase money flow', async t => {
  const f = await fixture(t), done = await f.run()
  assert.equal(done.status, 'succeeded'); assert.equal(JSON.parse(done.content).amountFen, 567)
  assert.deepEqual(f.stages, ['password_pending', 'grab_pending']); assert.deepEqual(f.waits, [500])
  assert.deepEqual(f.wire.filter(value => ['send_group_msg', 'grab_red_bag'].includes(value.action)).map(value => value.action), ['send_group_msg', 'grab_red_bag'])
  const password = f.wire.find(value => value.action === 'send_group_msg')
  assert.deepEqual(password.params, { group_id: target.id, message: [{ type: 'text', data: { text: '真实口令[CQ:at,qq=all]' } }] })
  const native = f.wire.find(value => value.action === 'grab_red_bag')
  assert.deepEqual(native.params, { recv_uin: target.id, recv_type: 2, peer_uid: target.id, name: '可信机器人', pc_body: 'PRIVATE_WALLET_CREDENTIAL_41',
    wishing: '真实口令[CQ:at,qq=all]', msg_seq: '741', index: 'PRIVATE_WALLET_INDEX_41' })
  const saved = await f.ledger.inspect(account, f.packet.packetIdentity)
  assert.equal(saved.phase, 'finished'); assert.equal(saved.passwordMessageId, '-91'); assert.equal(saved.amountFen, 567)
  for (const key of await f.redis.reader.keys(f.redis.prefix + 'agent:red-packet:v1:*')) assert.equal((await f.redis.reader.get(key)).includes('PRIVATE_'), false)
  assert.equal(done.content.includes('PRIVATE_'), false); assert.equal(Object.hasOwn(JSON.parse(done.content), 'messageId'), false)
  const effects = f.wire.length
  f.context.request = { ...f.context.request, messageId: 'another-human' }
  assert.equal((await f.run()).status, 'failed'); assert.equal(f.wire.filter(value => ['send_group_msg', 'grab_red_bag'].includes(value.action)).length, 2)
  assert.ok(f.wire.length > effects) // fresh proof is still required; dedup prevents every later effect
  assert.ok(f.sourceChecks.includes('human-command-1')); assert.ok(f.sourceChecks.includes('41'))
})

test('actual typed password unknown freezes the real packet across a new runtime and produces no grab or extra notice', async t => {
  const f = await fixture(t, { passwordReceipt: ok({}) })
  assert.equal((await f.run()).status, 'unknown'); assert.deepEqual(f.waits, [])
  assert.deepEqual(f.wire.filter(value => ['send_group_msg', 'grab_red_bag'].includes(value.action)).map(value => value.action), ['send_group_msg'])
  const replay = createAgentRedPacketRuntime({ storage: f.redis.storage, port: f.port, policy: () => f.policy })
  assert.equal((await replay.execute(f.context)).state, 'unknown')
  assert.equal(f.wire.filter(value => ['send_group_msg', 'grab_red_bag'].includes(value.action)).length, 1)
})

test('confirmed password followed by real source revocation never reaches later QQ reads or grab', async t => {
  const f = await fixture(t, { wait: async f => { f.revokeSource(); f.port.revoke(target, '41') } })
  const stopped = await f.run(); assert.equal(stopped.status, 'failed'); assert.equal(JSON.parse(stopped.content).passwordConfirmed, true)
  assert.equal(f.wire.at(-1).action, 'send_group_msg'); assert.equal(f.wire.some(value => value.action === 'grab_red_bag'), false)
  assert.equal((await f.ledger.inspect(account, f.packet.packetIdentity)).state, 'cancelled')
})

test('trusted no-text native wallet ingress runs separate automatic producer and never grants a human tool', async t => {
  const f = await fixture(t, { kind: 'normal' }); f.policy.allowExplicit = false
  assert.equal((await f.run()).status, 'failed'); assert.deepEqual(f.wire, [])
  const packet = await f.port.readIncoming(target, f.packets.get(42), { signal: f.context.signal, isCurrent: f.context.isCurrent, ensureCurrent: f.context.ensureCurrent })
  assert.ok(packet); assert.equal(Object.hasOwn(packet, 'text'), false)
  f.packet = packet
  const result = await f.auto(packet); assert.equal(result.state, 'confirmed'); assert.equal(result.passwordConfirmed, false)
  assert.deepEqual(f.wire.filter(value => ['send_group_msg', 'grab_red_bag'].includes(value.action)).map(value => value.action), ['grab_red_bag'])
})
