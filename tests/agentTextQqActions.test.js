import assert from 'node:assert/strict'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { createTextConversation } = await load('modules/conversation/infrastructure/textConversation.js')
const { groupTextScopedToolNames, groupTextQqActionToolNames, createGroupTextTools } = await load('modules/conversation/infrastructure/groupTextTools.js')
const { isToolActionDenied } = await load('modules/conversation/domain/toolActionPolicy.js')
const names = ['sendGiftTool', 'grabRedBagTool', 'qqZoneTool']
const requests = { sendGiftTool: '请送给我一个香槟', grabRedBagTool: '请抢这个红包', qqZoneTool: '请发布一条QQ空间说说' }
const kinds = { sendGiftTool: 'gift', grabRedBagTool: 'red-packet', qqZoneTool: 'qzone' }
const confirmed = name => name === 'sendGiftTool' ? { state: 'confirmed', completed: 1 }
  : name === 'grabRedBagTool' ? { state: 'confirmed', phase: 'finished', code: 'red_packet_grabbed', passwordConfirmed: false, grabbed: true, amountFen: 123 }
    : { state: 'confirmed', kind: 'publish', postId: 'own-post-1', terminal: true }
const unknown = name => name === 'sendGiftTool' ? { state: 'unknown', completed: 0, code: 'gift_outcome_unknown' }
  : name === 'grabRedBagTool' ? { state: 'unknown', phase: 'grab_pending', code: 'red_packet_outcome_unknown', passwordConfirmed: false, grabbed: false }
    : { state: 'unknown', kind: 'publish', terminal: true, code: 'qzone_outcome_unknown' }
const rejected = name => name === 'sendGiftTool' ? { state: 'failed', completed: 0, code: 'gift_source_unavailable' }
  : name === 'grabRedBagTool' ? { state: 'failed', phase: 'claimed', code: 'red_packet_source_unavailable', passwordConfirmed: false, grabbed: false }
    : { state: 'failed', kind: 'publish', terminal: false, code: 'qzone_source_unavailable' }
const answer = content => ({ choices: [{ message: { content } }] })
const call = (name, input = {}) => ({ choices: [{ message: { content: '', tool_calls: [{ id: 'qq-action-call', type: 'function', function: { name, arguments: JSON.stringify(input) } }] } }] })

function fixture(settings = {}) {
  const name = settings.name ?? 'sendGiftTool', account = { platform: 'qq', namespace: 'global', id: '19000601' }, sender = { ...account, id: '20000601' }
  const target = { account, kind: settings.privateChat ? 'private' : 'group', id: settings.privateChat ? sender.id : '310601' }
  const binding = { source: 'configured', id: 'text-qq-binding', revision: 'one', personaId: 'default', agentId: 'role', connectionId: 'connection', target }
  const now = Date.now(), signal = new AbortController().signal, models = [], effects = [], sends = [], history = [], learning = [], episodes = [], receipts = [], reviews = []
  let state = 'pending', recall = 'one', current = true, invalidatedAt = 0, resultText, calls = 0
  let f
  const scoped = names.map(toolName => ({ name: toolName, description: '可信QQ业务动作组合服务', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: [], additionalProperties: false },
    async execute(input, context) {
      calls++
      if (settings.execute) return settings.execute(toolName, input, context, f)
      const result = await context.runQqAction(kinds[toolName], async guard => {
        assert.ok(guard.signal instanceof AbortSignal); assert.equal(guard.isCurrent(), true); await guard.ensureCurrent()
        if (toolName === 'qqZoneTool' && input.text !== undefined && !await context.reviewQqText(input.text)) return rejected(toolName)
        await settings.beforeEffect?.(f, guard)
        await guard.ensureCurrent(); const value = settings.result ?? confirmed(toolName)
        if (value.state !== 'failed') effects.push({ name: toolName, binding: context.binding, request: context.request })
        return value
      })
      return { status: result.state === 'confirmed' ? 'succeeded' : result.state, content: JSON.stringify(result) }
    },
  }))
  const inbox = {
    async isTextReplyPending() { return state === 'pending' }, async isTextReplyConfirmed() { return state === 'confirmed-text' },
    async textActionReceipt() { return state === 'action' || state === 'confirmed-action' ? '' : state === 'result' ? resultText : undefined },
    async textRecallVersion() { return recall }, async loadTextHistory() { return undefined },
    async claimTextAction(_target, id, expected) { if (expected !== recall || state !== 'pending') return false; state = 'action'; receipts.push(['claim', id]); return true },
    async confirmTextInteraction(_target, id, expected) { if (expected !== recall || state !== 'action') return false; state = 'confirmed-action'; receipts.push(['interaction', id]); return true },
    async confirmTextMedia() { receipts.push(['unexpected-media']); return true },
    async finishTextAction(_target, _id, expected, text) { if (expected !== recall || state !== 'action') return false; state = 'result'; resultText = text; return true },
    async claimTextReply(_target, _id, expected, text) {
      if (expected !== recall || (text === undefined ? state !== 'pending' : state !== 'result' || resultText !== text)) return false
      state = 'attempted'; return true
    },
    async confirmTextReply() { state = 'confirmed-text'; return true }, async saveTextHistory(...args) { history.push(args) },
  }
  const ports = { inbox, actions: { async send(action) { sends.push(action); return { state: 'sent', messageId: 'text-reply-1' } } },
    personMemory: { async getSceneRedactions() { return { invalidatedAt } }, async query() { return { items: [] } } },
    bindingToken: selected => JSON.stringify(selected), groupToolNames: () => settings.tools ?? names,
    groupTools: { definitions: () => [], async execute() { assert.fail('QQ actions cannot use legacy text tools') } },
    scopedTools: () => scoped,
    scopedContext(incoming, selected, check, ensure, toolSignal) { return { binding: selected, actor: { kind: 'user', user: incoming.sender },
      request: { messageId: incoming.messageId, text: incoming.text, mentions: [] }, signal: toolSignal, isCurrent: check,
      async ensureCurrent() { await ensure(); if (!current) throw Error('source withdrawn') },
    } },
    isPrivatePeer: () => true, allowsText: text => !text.includes('FORBIDDEN_TEXT'), allowsToolInput: text => !text.includes('PRIVATE_CREDENTIAL'),
    async reserveGroupTurn() { return true }, now: () => now,
    async model(request, _target, _signal, check, ensure) {
      assert.equal(check(), true); await ensure?.(); models.push(request)
      return models.length === 1 ? call(name, settings.input ?? {}) : answer('这次没能执行，我先停在这里。')
    },
    async learnConfirmed() { learning.push(true) }, async recordEpisode(...args) { episodes.push(args) },
  }
  const incoming = { version: 1, conversation: target, sender, messageId: 'human-trigger', occurredAt: now,
    text: settings.text ?? requests[name], parts: [{ kind: 'text', text: settings.text ?? requests[name] }], mentions: [], directedToAccount: true }
  const selected = { binding, persona: { name: '原有角色', blacklist: ['人格禁用短语'] }, systemContent: '保持原有角色口吻。' }
  const runtime = createTextConversation(ports)
  f = { name, models, effects, sends, history, learning, episodes, receipts, reviews, incoming, selected, ports,
    get calls() { return calls }, get state() { return state },
    revoke(kind = 'binding') { if (kind === 'recall') recall = 'withdrawn'; else if (kind === 'privacy') invalidatedAt++; else current = false },
    reply: () => runtime.reply(incoming, selected, () => current, signal),
    restart: () => createTextConversation(ports).reply(incoming, selected, () => current, signal),
  }
  return f
}

test('QQ action names join explicit group grants and are absent from legacy/private definitions', () => {
  assert.deepEqual(groupTextQqActionToolNames, names)
  for (const name of names) assert.ok(groupTextScopedToolNames.includes(name))
  const unavailable = { name: 'stub', description: '', parameters: { type: 'object', properties: {}, required: [] } }
  const registry = createGroupTextTools({ commitment: unavailable, memory: unavailable })
  assert.deepEqual(registry.definitions(names), []); assert.deepEqual(registry.definitions(names, true), [])
})

for (const name of names) test(`public text ${name} shares one action claim and confirms without text, followup model or learning`, async () => {
  const f = fixture({ name }); await f.reply(); await f.reply(); await f.restart()
  assert.equal(f.models.length, 1); assert.equal(f.calls, 1); assert.equal(f.effects.length, 1)
  assert.ok(f.models[0].tools.some(tool => tool.function.name === name))
  assert.deepEqual(f.receipts, [['claim', 'human-trigger'], ['interaction', 'human-trigger']])
  assert.equal(f.effects[0].request.messageId, 'human-trigger'); assert.deepEqual(f.effects[0].binding, f.selected.binding)
  assert.deepEqual(f.sends, []); assert.deepEqual(f.learning, []); assert.deepEqual(f.episodes, []); assert.deepEqual(f.history, [])
})

for (const name of names) test(`public text ${name} unknown is terminal across duplicate and reconstructed conversations`, async () => {
  const f = fixture({ name, result: unknown(name) }); await f.reply(); await f.reply(); await f.restart()
  assert.equal(f.models.length, 1); assert.equal(f.effects.length, 1); assert.equal(f.calls, 1)
  assert.deepEqual(f.receipts, [['claim', 'human-trigger']]); assert.deepEqual(f.sends, []); assert.deepEqual(f.learning, [])
})

test('QQ tools require each group grant, a current positive request, and never appear in private chats', async () => {
  for (const settings of [{ tools: [] }, { privateChat: true }, { text: '今天一起吃饭吧' },
    { text: '不要送礼物，请搜索天气' }, { text: '他说要送我香槟' }, { text: '“请送我香槟”是个例子' }, { text: '请查香槟的价格' }]) {
    const f = fixture(settings); await f.reply(); assert.equal(f.calls, 0, JSON.stringify(settings)); assert.deepEqual(f.effects, [])
    assert.ok(!(f.models[0].tools ?? []).some(tool => tool.function.name === 'sendGiftTool'))
  }
})

test('QQ runner rejects a second action and a different action kind from the same model-selected tool', async () => {
  for (const different of [false, true]) {
    let rejected = 0
    const f = fixture({ async execute(_name, _input, context, owner) {
      const run = async guard => { await guard.ensureCurrent(); owner.effects.push('one'); return confirmed('sendGiftTool') }
      if (different) { await assert.rejects(context.runQqAction('qzone', run)); rejected++; return { status: 'failed', content: '{}' } }
      const result = await context.runQqAction('gift', run)
      await assert.rejects(context.runQqAction('gift', run)); rejected++
      return { status: 'succeeded', content: JSON.stringify(result) }
    } })
    await f.reply(); assert.equal(rejected, 1); assert.equal(f.effects.length, different ? 0 : 1)
  }
})

for (const kind of ['binding', 'privacy', 'recall']) test(`public text QQ action rechecks ${kind} before dispatch without a failure followup`, async () => {
  const f = fixture({ async beforeEffect(owner, guard) { owner.revoke(kind); await assert.rejects(guard.ensureCurrent()) } })
  await f.reply(); assert.deepEqual(f.effects, []); assert.deepEqual(f.sends, []); assert.equal(f.models.length, 1)
})

for (const name of names) test(`undispatched ${name} failure uses one tool-free explanation and never learns`, async () => {
  const f = fixture({ name, result: rejected(name) }); await f.reply(); await f.reply()
  assert.equal(f.models.length, 2); assert.deepEqual(f.models[1].tools, []); assert.equal(f.models[1].tool_choice, 'none')
  assert.equal(f.sends.length, 1); assert.deepEqual(f.effects, []); assert.deepEqual(f.learning, []); assert.deepEqual(f.episodes, [])
})

test('qzone outbound review accepts only unchanged safe text and never treats a grounding replacement as approval', async () => {
  const cases = [
    ['今天沿河散步，晚风很舒服。', true], ['首先，今天沿河散步。', false], ['人格禁用短语今天出现。', false],
    ['FORBIDDEN_TEXT', false], ['PRIVATE_CREDENTIAL', false], ['我会在完成后主动发给你。', false],
    [' 今天沿河散步。 ', false], ['长'.repeat(4001), false],
  ]
  for (const [text, expected] of cases) {
    const f = fixture({ name: 'qqZoneTool', async execute(_name, _input, context, owner) {
      const accepted = await context.reviewQqText(text); owner.reviews.push(accepted)
      if (!accepted) return { status: 'failed', content: JSON.stringify(rejected('qqZoneTool')) }
      const result = await context.runQqAction('qzone', async guard => { await guard.ensureCurrent(); owner.effects.push(text); return confirmed('qqZoneTool') })
      return { status: 'succeeded', content: JSON.stringify(result) }
    } })
    await f.reply(); assert.deepEqual(f.reviews, [expected], text.slice(0, 80)); assert.equal(f.effects.length, expected ? 1 : 0)
    assert.deepEqual(f.learning, []); assert.deepEqual(f.episodes, [])
  }
})

test('QQ action policy keeps mixed negative requests separate and refuses reported, quoted or unrelated intent', () => {
  for (const name of names) assert.equal(isToolActionDenied(requests[name], name), false)
  for (const [text, denied, allowed] of [
    ['不要送礼物，请抢这个红包', 'sendGiftTool', 'grabRedBagTool'],
    ['别抢红包，请发布一条QQ空间说说', 'grabRedBagTool', 'qqZoneTool'],
    ['不要发布空间说说，请给我送香槟', 'qqZoneTool', 'sendGiftTool'],
  ]) { assert.equal(isToolActionDenied(text, denied), true); assert.equal(isToolActionDenied(text, allowed), false) }
  for (const text of ['普通聊天', '他说抢红包', '“请发布说说”只是举例', '查查香槟价格', '今天有红包', '不要送礼物，还是送我香槟']) {
    const name = /红包/u.test(text) ? 'grabRedBagTool' : /说说/u.test(text) ? 'qqZoneTool' : 'sendGiftTool'
    assert.equal(isToolActionDenied(text, name), true, text)
  }
})
