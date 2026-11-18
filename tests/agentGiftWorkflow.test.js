import assert from 'node:assert/strict'
import test from 'node:test'
import { loadGift as load, giftAction, giftGuard, giftRedis, nativeGift } from './helpers/agentGiftSource.mjs'
const { createAgentGiftWorkflow } = await load('modules/runtime/infrastructure/agentGiftWorkflow.js')
const { createQqGiftDeliveryPort } = await load('adapters/qqGiftDelivery.js')
const { createAgentGiftTools } = await load('modules/tools/infrastructure/agentGiftTools.js')
const accepted = { state: 'confirmed', evidence: 'packet-accepted' }

test('gift workflow persists pending before native, accepts one packet, and stores only bounded hashes for seven days', { timeout: 10000 }, async t => {
  const f = await giftRedis(t), workflow = createAgentGiftWorkflow(f.storage), guard = giftGuard(), action = giftAction()
  let calls = 0
  const result = await workflow.execute({ action, ...guard, async dispatch(selected, options) {
    calls++; assert.ok(Object.isFrozen(selected)); await options.ensureCurrent()
    const [key] = await f.client.keys('agent:gift-display:v1:*'), raw = await f.client.get(key)
    assert.equal(JSON.parse(raw).state, 'pending'); assert.ok(await f.client.ttl(key) > 604790)
    return accepted
  } })
  assert.deepEqual(result, { state: 'confirmed', completed: 1 }); assert.equal(calls, 1)
  const [key] = await f.client.keys('agent:gift-display:v1:*'), raw = await f.client.get(key)
  assert.equal(JSON.parse(raw).state, 'confirmed')
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['planHash', 'state', 'tokenHash', 'version'])
  for (const secret of ['19000501', '312501', '20000101', '30000101', 'champagne', 'revision-gift-1']) assert.ok(!raw.includes(secret))
  assert.match(key, /^agent:gift-display:v1:[a-f0-9]{64}$/u)
})

test('gift concurrent claims, new workflow instances, changed recipient and changed gift never replay the same source', { timeout: 10000 }, async t => {
  const f = await giftRedis(t), action = giftAction(), guard = giftGuard(); let calls = 0
  const run = action => createAgentGiftWorkflow(f.storage).execute({ action, ...guard, async dispatch() { calls++; return accepted } })
  const results = await Promise.all(Array.from({ length: 20 }, () => run(action)))
  assert.equal(results.filter(value => value.state === 'confirmed').length, 1); assert.equal(calls, 1)
  assert.deepEqual(await run(action), { state: 'failed', completed: 0, code: 'gift_already_confirmed' })
  const changed = structuredClone(action); changed.plan.giftType = 'dragon'
  assert.equal((await run(changed)).code, 'gift_claim_conflict')
  changed.plan.recipient.id = '40000101'; assert.equal((await run(changed)).code, 'gift_claim_conflict'); assert.equal(calls, 1)
})

for (const response of [{ state: 'unknown' }, { state: 'confirmed' }, { state: 'confirmed', evidence: 'packet-accepted', messageId: 'fake' }, new Error('secret-native-error')]) {
  test('gift malformed, thrown and unknown receipts freeze after restart without message IDs', { timeout: 10000 }, async t => {
    const f = await giftRedis(t), action = giftAction(), guard = giftGuard(); let calls = 0
    const input = { action, ...guard, async dispatch() { calls++; if (response instanceof Error) throw response; return response } }
    assert.equal((await createAgentGiftWorkflow(f.storage).execute(input)).state, 'unknown')
    assert.deepEqual(await createAgentGiftWorkflow(f.storage).execute(input), { state: 'unknown', completed: 0, code: 'gift_already_unknown' })
    assert.equal(calls, 1); assert.ok(!(await f.client.get((await f.client.keys('*'))[0])).includes('secret'))
  })
}

test('gift definitive rejection is final, while a native-confirmed settlement failure freezes the pending claim', { timeout: 10000 }, async t => {
  const f = await giftRedis(t), action = giftAction(), guard = giftGuard(); let calls = 0
  const input = { action, ...guard, async dispatch() { calls++; return { state: 'failed', code: 'native_rejected' } } }
  assert.equal((await createAgentGiftWorkflow(f.storage).execute(input)).state, 'failed')
  assert.equal((await createAgentGiftWorkflow(f.storage).execute(input)).code, 'gift_already_failed')
  assert.equal(calls, 1)
  const second = giftAction(); second.source.messageId = '502'
  const broken = { get: f.storage.get, eval: (script, options) => script.includes('KEEPTTL') ? Promise.reject(new Error('storage failed')) : f.storage.eval(script, options) }
  const uncertain = await createAgentGiftWorkflow(broken).execute({ action: second, ...guard, async dispatch() { calls++; return accepted } })
  assert.deepEqual(uncertain, { state: 'unknown', completed: 1, code: 'gift_settlement_failed' })
  assert.equal((await createAgentGiftWorkflow(f.storage).execute({ action: second, ...guard, async dispatch() { calls++; return accepted } })).code, 'gift_already_unknown')
  assert.equal(calls, 2)
})

test('gift cancelled authorization, corrupt ledger and unavailable storage stop before dispatch', { timeout: 10000 }, async t => {
  const f = await giftRedis(t), action = giftAction(), guard = giftGuard(); let calls = 0
  const dispatch = async () => { calls++; return accepted }
  guard.revoke(); assert.equal((await createAgentGiftWorkflow(f.storage).execute({ action, ...guard, dispatch })).state, 'failed')
  assert.equal((await f.client.keys('*')).length, 0)
  const failing = { get: async () => null, eval: async () => { throw Error('private-redis-error') } }
  assert.equal((await createAgentGiftWorkflow(failing).execute({ action, ...giftGuard(), dispatch })).code, 'gift_claim_unavailable')
  const corrupt = { get: async () => null, eval: async () => '{"secret":"not a claim"}' }
  assert.equal((await createAgentGiftWorkflow(corrupt).execute({ action, ...giftGuard(), dispatch })).code, 'gift_claim_unavailable')
  assert.equal(calls, 0)
})

test('gift lost permission after persisted claim ends the attempt and does not regain it on a new human call', { timeout: 10000 }, async t => {
  const f = await giftRedis(t), action = giftAction(), guard = giftGuard(); let calls = 0, checks = 0
  const input = { action, ...guard, async ensureCurrent() { if (++checks === 2) guard.revoke(); await guard.ensureCurrent() }, async dispatch() { calls++; return accepted } }
  assert.equal((await createAgentGiftWorkflow(f.storage).execute(input)).state, 'failed')
  assert.equal((await createAgentGiftWorkflow(f.storage).execute({ ...input, ...giftGuard() })).code, 'gift_already_failed')
  assert.equal(calls, 0)
})

test('gift timeout freezes an in-flight dispatch and ignores its later confirmation', { timeout: 10000 }, async t => {
  const f = await giftRedis(t), action = giftAction(), guard = giftGuard(), late = Promise.withResolvers(); let calls = 0
  const workflow = createAgentGiftWorkflow(f.storage, { timeoutMs: 80 })
  const input = { action, ...guard, dispatch: async () => { calls++; return late.promise } }
  assert.equal((await workflow.execute(input)).state, 'unknown'); late.resolve(accepted)
  assert.equal((await createAgentGiftWorkflow(f.storage).execute(input)).code, 'gift_already_unknown'); assert.equal(calls, 1)
})

test('gift workflow executes the complete local Redis and typed QQ adapter business path', { timeout: 10000 }, async t => {
  const f = await giftRedis(t), native = nativeGift(), dispatch = createQqGiftDeliveryPort(native.options)
  const action = giftAction(), workflow = createAgentGiftWorkflow(f.storage)
  assert.deepEqual(await workflow.execute({ action, ...native.guard, dispatch }), { state: 'confirmed', completed: 1 })
  assert.deepEqual(native.calls.map(value => value.name), ['get_msg', 'get_group_member_info', 'get_group_member_info', 'send_packet'])
  assert.equal((await createAgentGiftWorkflow(f.storage).execute({ action, ...native.guard, dispatch })).code, 'gift_already_confirmed')
  assert.equal(native.calls.length, 4)
})

test('gift human tool reaches persistent workflow and native packet once, and repeats carry no new completion or payment claim', { timeout: 10000 }, async t => {
  const f = await giftRedis(t), native = nativeGift(), dispatch = createQqGiftDeliveryPort(native.options), action = giftAction()
  const workflow = createAgentGiftWorkflow(f.storage), [tool] = createAgentGiftTools({ enabled: true,
    execute: (plan, context) => workflow.execute({ action: { version: 1, kind: 'qq.gift-display', binding: context.binding,
      source: { messageId: context.request.messageId, author: context.actor.user }, plan }, ...native.guard, dispatch }),
  })
  const context = { binding: action.binding, actor: { kind: 'user', user: action.source.author },
    request: { messageId: '501', text: '请给30000101送香槟', mentions: [] }, ...native.guard,
    async readMember(id) { return { target: action.binding.target, observedAt: Date.now(), member: { user: { ...action.plan.recipient, id }, displayName: '真实目标名', role: 'member' } } },
  }
  const result = await tool.execute({ targetQQ: '30000101' }, context)
  assert.equal(result.status, 'succeeded'); assert.equal(JSON.parse(result.content).evidence, 'packet-accepted')
  assert.equal(/金币|支付|扣费|余额|messageId/u.test(result.content), false)
  const repeat = await tool.execute({ targetQQ: '30000101' }, context)
  assert.equal(JSON.parse(repeat.content).completed, 0); assert.equal(JSON.parse(repeat.content).code, 'gift_already_confirmed')
  assert.equal(native.calls.filter(value => value.name === 'send_packet').length, 1)
})
