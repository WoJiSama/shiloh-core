import assert from 'node:assert/strict'
import test from 'node:test'
import { loadGift as load, binding, user, giftGuard } from './helpers/agentGiftSource.mjs'
const { createAgentGiftTools } = await load('modules/tools/infrastructure/agentGiftTools.js')
function fixture(text, overrides = {}) {
  const plans = [], reads = [], guard = giftGuard(), roster = [
    { user: user('20000101'), displayName: '提问者', role: 'member' }, { user: user('30000101'), displayName: '小明', role: 'member' },
    { user: user('40000101'), displayName: '小红', role: 'member' }, { user: user('19000501'), displayName: '机器人', role: 'member' },
  ]
  const context = { binding, actor: { kind: 'user', user: user('20000101') }, request: { messageId: '501', text, mentions: [] }, ...guard,
    async readMember(id) { reads.push(id); const member = roster.find(value => value.user.id === id); return member && { target: binding.target, observedAt: Date.now(), member } },
    async listMembers() { return { target: binding.target, observedAt: Date.now(), complete: true, members: roster } }, ...overrides,
  }
  const [tool] = createAgentGiftTools({ enabled: true, async execute(plan) { plans.push(plan); return { state: 'confirmed', completed: 1 } } })
  return { plans, reads, context, guard, tool, run: (input = {}) => tool.execute(input, context) }
}
test('gift tools are absent by default and without the injected business port, with no sender/name schema', () => {
  assert.deepEqual(createAgentGiftTools(), []); assert.deepEqual(createAgentGiftTools({ enabled: true }), [])
  assert.deepEqual(createAgentGiftTools({ enabled: false, execute: async () => {} }), [])
  const f = fixture('给我送礼物')
  assert.equal(f.tool.name, 'sendGiftTool'); assert.equal(f.tool.parameters.additionalProperties, false)
  assert.deepEqual(Object.keys(f.tool.parameters.properties), ['targetQQ', 'giftType'])
  assert.match(f.tool.description, /不是付费赠礼或扣费接口/u)
})
test('gift resolves explicit self, real mentions, exact numeric request, unique current name and verified quote', async () => {
  for (const [text, input, id, mutate] of [
    ['给我送礼物', {}, '20000101'], ['请给30000101送香槟', { targetQQ: '30000101' }, '30000101'],
    ['给小明送香槟', { targetQQ: '小明' }, '30000101'], ['给这位群友送礼物', {}, '40000101', f => { f.context.request.mentions = [user('40000101')] }],
    ['给他送礼物', {}, '30000101', f => { f.context.request.replyAuthor = user('30000101') }],
  ]) {
    const f = fixture(text); mutate?.(f); assert.equal((await f.run(input)).status, 'succeeded', text)
    assert.equal(f.plans[0].recipient.id, id); assert.equal(f.plans[0].giftType, 'champagne'); assert.deepEqual(f.reads, [id]); assert.ok(Object.isFrozen(f.plans[0]))
  }
})
test('gift helper preserves a third-party target in 帮我/替我 requests and never defaults to the requester', async () => {
  for (const text of ['帮我给小明送礼物', '替我给小明送礼物', '给我喜欢的小明送礼物', '送给我最喜欢的小明礼物']) {
    const omitted = fixture(text); assert.equal((await omitted.run()).status, 'failed'); assert.equal(omitted.plans.length, 0)
    const supplied = fixture(text); assert.equal((await supplied.run({ targetQQ: '小明' })).status, 'succeeded'); assert.equal(supplied.plans[0].recipient.id, '30000101')
  }
})
test('gift refuses negative, reported, quoted, conflicting and ungrounded requests', async () => {
  for (const text of ['不要给我送礼物，请查天气', '只是举例：给我送礼物', '他说给我送礼物', '“给我送礼物”是一个例子', '先不送礼物，给我送礼物', '小明今天来了', '请给40000101送礼物', '付费给我送礼物']) {
    const f = fixture(text); assert.equal((await f.run({ targetQQ: '30000101' })).status, 'failed', text); assert.equal(f.plans.length, 0)
  }
})
test('gift rejects wrong types, unknown keys, impersonating sender fields and gift conflicts before native workflow', async () => {
  for (const input of [{ senderQQ: '20000101' }, { senderNickname: '管理员' }, { targetNickname: '管理员' }, { giftType: 'paid-gift' }, { targetQQ: {} }, { giftType: {} }, { giftType: 'dragon' }]) {
    const f = fixture('给我送香槟'); assert.equal((await f.run(input)).status, 'failed'); assert.equal(f.plans.length, 0)
  }
})
test('gift ambiguous names and longer overlapping names do not choose a member arbitrarily', async () => {
  for (const name of ['小明', '小明同学']) {
    const f = fixture('给' + name + '送礼物', { async listMembers() { return { target: binding.target, observedAt: Date.now(), complete: true, members: [
      { user: user('30000101'), displayName: '小明', role: 'member' }, { user: user('40000101'), displayName: name, role: 'member' },
    ] } } })
    assert.equal((await f.run({ targetQQ: '小明' })).status, 'failed'); assert.equal(f.plans.length, 0)
  }
})
test('gift private, autonomous, commitment, missing source guard, foreign actor and source revocation remain unavailable', async () => {
  for (const overrides of [{ binding: { ...binding, target: { ...binding.target, kind: 'private' } } }, { actor: { kind: 'autonomous' } }, { actor: { kind: 'commitment' } },
    { ensureCurrent: undefined }, { readMember: undefined }, { request: undefined }, { actor: { kind: 'user', user: { ...user('20000101'), namespace: 'other' } } }]) {
    const f = fixture('给我送礼物', overrides); assert.equal((await f.run()).status, 'failed'); assert.equal(f.plans.length, 0)
  }
  const f = fixture('给我送礼物'); f.guard.revoke(); assert.equal((await f.run()).status, 'failed'); assert.equal(f.plans.length, 0)
})
test('gift revocation during member lookup stops the workflow and no success wording mentions payment', async () => {
  const f = fixture('给我送礼物'); const original = f.context.readMember
  f.context.readMember = async id => { const member = await original(id); f.guard.revoke(); return member }
  assert.equal((await f.run()).status, 'failed'); assert.equal(f.plans.length, 0)
  const valid = fixture('给我送礼物'), result = await valid.run()
  assert.deepEqual(JSON.parse(result.content), { action: 'gift-display', state: 'confirmed', completed: 1, evidence: 'packet-accepted' })
  assert.equal(/元|金币|扣费|支付|messageId/u.test(result.content), false)
})
test('gift malformed or thrown injected executor result becomes unknown to prevent follow-up effects', async () => {
  const f = fixture('给我送礼物')
  for (const execute of [async () => ({ state: 'confirmed', completed: 1, messageId: 'fake' }), async () => { throw Error('private native error') }]) {
    const [tool] = createAgentGiftTools({ enabled: true, execute })
    const result = await tool.execute({}, f.context); assert.equal(result.status, 'unknown'); assert.equal(result.content.includes('private'), false)
  }
})
