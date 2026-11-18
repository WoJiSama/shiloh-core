import assert from 'node:assert/strict'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
const { canApplyGroupManagement, isAgentGroupManagement } = await load('modules/tools/domain/agentGroupManagement.js')
const user = id => ({ platform: 'fixture', namespace: 'management', id })
const member = (id, role = 'member') => ({ user: user(id), role })
const actor = member('actor', 'admin'), bot = member('bot', 'admin'), target = member('target')
const mute = seconds => ({ kind: 'member-mute', user: target.user, requester: actor.user, seconds })
const card = selected => ({ kind: 'member-card', user: selected.user, requester: actor.user, name: '新名片' })

test('mute and unmute require two verified managers and a known ordinary target', () => {
  for (const seconds of [0, 300]) {
    assert.equal(canApplyGroupManagement(mute(seconds), actor, bot, target), true)
    for (const role of ['owner', 'admin']) assert.equal(canApplyGroupManagement(mute(seconds), member('actor', role), member('bot', role), target), true)
    for (const role of ['member', 'unknown']) {
      assert.equal(canApplyGroupManagement(mute(seconds), member('actor', role), bot, target), false)
      assert.equal(canApplyGroupManagement(mute(seconds), actor, member('bot', role), target), false)
    }
    for (const role of ['owner', 'admin', 'unknown']) assert.equal(canApplyGroupManagement(mute(seconds), actor, bot, member('target', role)), false)
    assert.equal(canApplyGroupManagement({ ...mute(seconds), user: bot.user }, actor, bot, member('bot')), false)
  }
})

test('whole-group state requires both managers and never borrows target identity', () => {
  for (const enabled of [false, true]) {
    const operation = { kind: 'group-mute', enabled, requester: actor.user }
    assert.equal(canApplyGroupManagement(operation, actor, bot), true)
    assert.equal(canApplyGroupManagement(operation, member('actor'), bot), false)
    assert.equal(canApplyGroupManagement(operation, actor, member('bot')), false)
  }
})

test('cards preserve self-change permissions and require management when acting for another member', () => {
  assert.equal(canApplyGroupManagement(card(target), actor, bot, target), true)
  assert.equal(canApplyGroupManagement(card(actor), member('actor'), bot, member('actor')), true)
  assert.equal(canApplyGroupManagement(card(actor), member('actor'), member('bot'), member('actor')), false)
  assert.equal(canApplyGroupManagement(card(bot), actor, member('bot'), member('bot')), true)
  assert.equal(canApplyGroupManagement(card(bot), member('actor'), member('bot'), member('bot')), false)
  assert.equal(canApplyGroupManagement(card(target), member('actor'), bot, target), false)
  assert.equal(canApplyGroupManagement(card(target), actor, member('bot'), target), false)
  assert.equal(canApplyGroupManagement(card(member('target', 'owner')), actor, bot, member('target', 'owner')), true)
  assert.equal(canApplyGroupManagement(card(target), actor, bot, member('target', 'unknown')), false)
})

test('role evidence cannot substitute identities, namespaces, bot actors or missing targets', () => {
  const operation = mute(300)
  assert.equal(isAgentGroupManagement(operation), true); assert.equal(isAgentGroupManagement({ kind: 'poke', user: target.user }), false)
  for (const bad of [{ ...actor, user: user('different') }, { ...actor, user: { ...actor.user, namespace: 'other' } }]) assert.equal(canApplyGroupManagement(operation, bad, bot, target), false)
  assert.equal(canApplyGroupManagement(operation, actor, { ...bot, user: { ...bot.user, namespace: 'other' } }, target), false)
  assert.equal(canApplyGroupManagement(operation, actor, bot), false)
  assert.equal(canApplyGroupManagement(operation, actor, bot, member('different')), false)
  assert.equal(canApplyGroupManagement({ ...operation, requester: bot.user }, bot, bot, target), false)
})
