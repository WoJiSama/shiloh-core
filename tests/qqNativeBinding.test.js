import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { captureQqBinding, resolveQqAgentBinding } from '../dist/backend/adapters/qqAgentBinding.js'
import { normalizeHostChatEvent } from '../dist/backend/modules/host/infrastructure/hostEvent.js'
import { queuedDeliveryAllowed } from '../dist/backend/modules/messaging/infrastructure/deliveryScope.js'
import { createQQApi } from '../dist/backend/modules/platform/infrastructure/QQApi.js'
import { createChangeCardTool } from '../dist/backend/modules/qqTools/infrastructure/ChangeCardTool.js'
import { createGrabRedBagTool } from '../dist/backend/modules/qqTools/infrastructure/GrabRedBagTool.js'
import { createJinyanTool } from '../dist/backend/modules/qqTools/infrastructure/JinyanTool.js'
import { createLikeTool } from '../dist/backend/modules/qqTools/infrastructure/LikeTool.js'
import { createMentionMembersTool } from '../dist/backend/modules/qqTools/infrastructure/MentionMembersTool.js'
import { createPokeTool } from '../dist/backend/modules/qqTools/infrastructure/PokeTool.js'
import { createQQZoneTool } from '../dist/backend/modules/qqTools/infrastructure/QQZoneTool.js'
import { createReactionTool } from '../dist/backend/modules/qqTools/infrastructure/ReactionTool.js'
import { createRecallTool } from '../dist/backend/modules/qqTools/infrastructure/RecallTool.js'

const botId = 81111
const groupId = 81112
const actorId = 81113
const targetId = 81114
const nextId = 81115
const fixedBinding = {
  id: 'fixture', source: 'configured', revision: 'v1', personaId: 'default', agentId: 'nick', connectionId: 'qq-local',
  target: { kind: 'group', id: String(groupId), account: { platform: 'qq', namespace: 'global', id: String(botId) } },
}
const members = () => new Map([
  [botId, { user_id: botId, role: 'admin' }],
  [actorId, { user_id: actorId, role: 'owner' }],
  [targetId, { user_id: targetId, nickname: '被管理成员', role: 'member' }],
  [nextId, { user_id: nextId, nickname: '下一位群友', role: 'member' }],
])
function eventFor(bot, isCurrent) {
  return { self_id: botId, group_id: groupId, user_id: actorId, message_type: 'group', sender: { user_id: actorId, role: 'owner' },
    ...(bot ? { bot } : {}), ...(isCurrent ? { _agentBinding: fixedBinding, _isAgentBindingCurrent: isCurrent } : {}) }
}
function groupFor(getMemberMap = async () => members()) {
  return { group_id: groupId, getMemberMap, pickMember() { return {} } }
}

test('a normalized QQ tool event cannot change a card after its on-disk role changes during member lookup', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-native-binding-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'agent-bindings.yaml')
  const configuration = agentId => ({
    version: 1, agents: [{ id: agentId, personaId: 'default' }],
    connections: [{ id: 'qq-local', platform: 'qq', namespace: 'global', accountId: String(botId) }],
    bindings: [{ connectionId: 'qq-local', kind: 'group', conversationId: String(groupId), agentId }],
  })
  await fs.writeFile(file, JSON.stringify(configuration('nick')))
  const library = { file: path.join(directory, 'personas.yaml'), resolve: () => ({ id: 'default' }),
    detailById: id => id === 'default' ? { id } : null }
  const dispatched = []
  const group = groupFor(async () => {
    await fs.writeFile(file, JSON.stringify(configuration('other-role')))
    return members()
  })
  const bot = { uin: botId, pickGroup: () => group, sendApi: async action => { dispatched.push(action); return { status: 'ok' } } }
  const event = normalizeHostChatEvent({ ...eventFor(bot), group, reply: async () => ({ message_id: 1 }) }, bot, true)
  const { binding } = resolveQqAgentBinding(library, event)
  assert.equal(captureQqBinding(library, event, binding), true)
  const { ChangeCardTool } = createChangeCardTool({ getBot: () => assert.fail('the current event already owns its bot') })
  const result = await new ChangeCardTool().func({ target: String(targetId), cardName: '新名片' }, event)
  assert.deepEqual(dispatched, [])
  assert.match(result, /绑定已改变/u)
})

test('group mutations stop after their confirmed prefix even if the event callback is replaced', async () => {
  let current = true
  const dispatched = []
  const group = { ...groupFor(), async muteMember(id) {
    dispatched.push(id)
    current = false
    event._isAgentBindingCurrent = () => true
    return { status: 'ok' }
  } }
  const event = eventFor({ uin: botId, pickGroup: () => group }, () => current)
  const { JinyanTool } = createJinyanTool({ getBot: () => undefined })
  const result = await new JinyanTool().func({ target: [String(targetId), String(nextId)] }, event)
  assert.deepEqual(dispatched, [targetId])
  assert.deepEqual(result.results.map(row => row.success), [true, false])
  assert.match(result.results[1].reason, /绑定已改变/u)
})

test('a guarded native group reply propagates its live check through the host queue', async () => {
  let current = true
  let sent = 0
  const group = groupFor()
  const event = { ...eventFor({ uin: botId, pickGroup: () => group }, () => current), async reply() {
    await Promise.resolve()
    current = false
    if (!queuedDeliveryAllowed()) return { state: 'failed', code: 'binding_changed' }
    sent++
    return { message_id: 7 }
  } }
  const MentionMembers = createMentionMembersTool()
  assert.match(await new MentionMembers().func({ targets: [String(targetId)] }, event), /发送失败|绑定已改变/u)
  assert.equal(sent, 0)
})

test('a mismatched or missing account cannot use the host default for a bound QQ action', async () => {
  const dispatched = []
  let defaultLookups = 0
  const other = { uin: nextId, sendApi: async action => { dispatched.push(action); return { status: 'ok' } } }
  const exact = { uin: botId, sendApi: async action => { dispatched.push(action); return { status: 'ok' } } }
  const tool = new (createReactionTool({ getBot: () => { defaultLookups++; return other } }))()
  assert.doesNotMatch(JSON.stringify(await tool.func({ message_id: '42' }, eventFor(other, () => true))), /"success":true/u)
  assert.equal(defaultLookups, 0)
  assert.doesNotMatch(JSON.stringify(await tool.func({ message_id: '42' }, eventFor(undefined, () => true))), /"success":true/u)
  assert.deepEqual(dispatched, [])
  const multi = new (createReactionTool({ getBot: () => ({ uin: [nextId, botId], bots: { [botId]: exact } }) }))()
  assert.equal((await multi.func({ message_id: '42' }, eventFor(undefined, () => true))).success, true)
  assert.deepEqual(dispatched, ['set_msg_emoji_like'])
  assert.equal((await tool.func({ message_id: '42' }, { group_id: groupId })).success, true)
  assert.equal(dispatched.length, 2)
})

test('QQ Zone performs neither read nor write HTTP after the captured guard closes during credential lookup', async () => {
  for (const command of [api => api.getQzone(), api => api.setQzone('新说说'), api => api.delQzone('123', 'source'), api => api.likeQzoneFeed(targetId, '123'), api => api.commentQzoneFeed(targetId, '123', '留言')]) {
    let current = true
    let requests = 0
    const bot = { uin: botId, async sendApi() {
      await Promise.resolve()
      current = false
      return { data: { cookies: 'fixture-cookie', token: 123 } }
    } }
    const Api = createQQApi({ bot: () => assert.fail('the event already owns its bot'),
      request: { get: async () => { requests++ }, post: async () => { requests++ } } })
    await assert.rejects(command(new Api(eventFor(bot, () => current))), /绑定已改变/u)
    assert.equal(requests, 0)
  }
})

test('native lookups cannot dispatch like and recall after losing the captured turn', async () => {
  let current = true
  let dispatched = 0
  const group = groupFor(async () => { current = false; return members() })
  const liker = { uin: botId, pickGroup: () => group, pickFriend: () => ({ thumbUp: () => { dispatched++ } }) }
  const Like = createLikeTool({ getBot: () => undefined }).LikeTool
  assert.match((await new Like().func({ random: true }, eventFor(liker, () => current))).error, /绑定已改变/u)
  current = true
  const retractor = { uin: botId, async sendApi(action) {
    if (action === 'get_msg') {
      current = false
      return { data: { message_id: '42' } }
    }
    dispatched++
    return { status: 'ok' }
  } }
  const Recall = createRecallTool()
  assert.match(await new Recall().func({}, { ...eventFor(retractor, () => current), source: { seq: 8 } }), /绑定已改变/u)
  assert.equal(dispatched, 0)
})

test('poke and reaction batches preserve only the effects confirmed before rebinding', async () => {
  let current = true
  const poked = []
  const bot = { uin: botId, async sendApi(action, params) {
    if (action === 'get_group_member_list') return { status: 'ok', data: [...members().values()] }
    assert.equal(action, 'send_group_poke')
    poked.push(params.user_id)
    await Promise.resolve()
    current = false
    return { status: 'ok' }
  } }
  const Poke = createPokeTool({ getBot: () => undefined }).PokeTool
  const poke = await new Poke().func({ target: [String(targetId), String(nextId)] }, eventFor(bot, () => current))
  assert.deepEqual(poked, [targetId])
  assert.equal(poke.success.targets[0].times, 1)
  assert.match(poke.errors[0].error, /绑定已改变/u)

  current = true
  let reacted = 0
  const reactionBot = { uin: botId, async sendApi(action) {
    assert.equal(action, 'set_msg_emoji_like')
    reacted++
    current = false
    return { status: 'ok' }
  } }
  const Reaction = createReactionTool()
  const reaction = await new Reaction().func({ message_id: '42', count: 2 }, eventFor(reactionBot, () => current))
  assert.equal(reacted, 1)
  assert.equal(reaction.emoji_count, 1)
  assert.match(reaction.error, /绑定已改变/u)
})

test('a confirmed red packet password does not authorize a stale claim', async () => {
  let current = true
  const sent = []
  const bot = { uin: botId, pickGroup: () => ({ async sendMsg(text) {
    sent.push(text)
    current = false
    return { message_id: 42 }
  } }), sendApi: async action => { sent.push(action) } }
  const event = { ...eventFor(bot, () => current), getReply: async () => ({
    message: [{ type: 'wallet', data: { title: '口令', red_channel: 32 } }], message_seq: 1,
  }) }
  const GrabRedBag = createGrabRedBagTool({ getBot: () => undefined }).GrabRedBagTool
  assert.match(await new GrabRedBag().func({}, event), /绑定已改变/u)
  assert.deepEqual(sent, ['口令'])
})

test('QQ Zone listing cannot authorize a later stale delete', async () => {
  let current = true
  let deleted = 0
  const Qzone = createQQZoneTool(() => ({ async getQzone() {
    current = false
    return { msglist: [{ tid: '42', t1_source: 'feed' }] }
  }, async delQzone() { deleted++; return { subcode: 0 } } }))
  const result = await new Qzone().func({ type: true }, eventFor({ uin: botId }, () => current))
  assert.match(result.error, /绑定已改变/u)
  assert.equal(deleted, 0)
})
