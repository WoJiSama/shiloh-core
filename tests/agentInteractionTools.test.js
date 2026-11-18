import assert from 'node:assert/strict'
import test from 'node:test'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'
const { createAgentInteractionTools } = await importBilibiliHost('modules/tools/infrastructure/agentInteractionTools.js')
const account = { platform: 'fixture', namespace: 'interaction-tools', id: 'robot' }, target = { account, kind: 'group', id: 'room' }
const user = id => ({ ...account, id }), member = (id, name) => ({ user: user(id), displayName: name, role: 'member' })
const roster = [member('actor', '提问者'), member('one', '小明'), member('two', '小红'), member('robot', '机器人')]
const tools = createAgentInteractionTools({ enabled: true }), tool = name => tools.find(value => value.name === name)
function fixture(text, overrides = {}) {
  const plans = [], reads = [], controller = new AbortController(); let current = true
  const context = { binding: { source: 'configured', id: 'bound-room', revision: 'one', agentId: 'role', personaId: 'default', connectionId: 'connection', target },
    actor: { kind: 'user', user: user('actor') }, request: { messageId: 'current-1', text, mentions: [] }, botUserId: 'robot',
    signal: controller.signal, isCurrent: () => current, async ensureCurrent() {},
    async listMembers() { return { target, observedAt: Date.now(), complete: true, members: roster } },
    async readMember(id) { reads.push(id); const found = roster.find(value => value.user.id === id); return found && { target, observedAt: Date.now(), member: found } },
    async interact(plan) { plans.push(plan); return { state: 'confirmed', completed: plan.operations.length, requested: plan.operations.length } },
    ...overrides,
  }
  return { context, plans, reads, controller, revoke() { current = false }, async execute(name, input = {}) { return tool(name).execute(input, context) } }
}

test('disabled interaction tools expose no capability and enabled schemas preserve neutral legacy parameters', () => {
  assert.deepEqual(createAgentInteractionTools({ enabled: false }), [])
  assert.deepEqual(tools.map(value => value.name), ['pokeTool', 'likeTool', 'reactionTool', 'recallTool', 'jinyanTool', 'changeCardTool'])
  assert.ok(Object.isFrozen(tools)); assert.ok(tools.every(value => value.parameters.additionalProperties === false))
  assert.deepEqual(Object.keys(tool('pokeTool').parameters.properties), ['target', 'times', 'random'])
  assert.deepEqual(Object.keys(tool('likeTool').parameters.properties), ['qq', 'count', 'random'])
  assert.deepEqual(Object.keys(tool('reactionTool').parameters.properties), ['message_id', 'count'])
  assert.deepEqual(Object.keys(tool('recallTool').parameters.properties), ['message_id'])
  assert.deepEqual(Object.keys(tool('jinyanTool').parameters.properties), ['target', 'time', 'random', 'confirm', 'selfDecision'])
  assert.deepEqual(Object.keys(tool('changeCardTool').parameters.properties), ['target', 'cardName'])
  assert.equal(tool('likeTool').parameters.properties.count.default, 10)
  assert.equal(JSON.stringify(tools).includes('sendApi'), false)
})
for (const name of ['pokeTool', 'likeTool', 'reactionTool', 'recallTool']) test(`${name} cannot act without a current proven human source`, async () => {
  for (const override of [{ actor: { kind: 'autonomous' } }, { actor: { kind: 'commitment' } }, { request: undefined }, { interact: undefined },
    { actor: { kind: 'user', user: { ...user('actor'), namespace: 'foreign' } } }, { binding: { ...fixture('x').context.binding, target: { ...target, kind: 'private' } } }]) {
    const f = fixture('戳我一下，给我点赞，对本条消息贴表情', override)
    assert.equal((await f.execute(name)).status, 'failed'); assert.equal(f.plans.length, 0)
  }
  const aborted = fixture('戳我一下'); aborted.controller.abort(); assert.equal((await aborted.execute(name)).status, 'failed')
  const stale = fixture('给我点赞'); stale.revoke(); assert.equal((await stale.execute(name)).status, 'failed')
})
function privateFixture(text, overrides = {}) {
  return fixture(text, { binding: { ...fixture(text).context.binding, target: { account, kind: 'private', id: 'actor' } },
    privatePeer: user('actor'), listMembers: undefined, readMember: undefined, ...overrides })
}
test('private likes permit only the proven current peer requesting likes for themselves and default to ten', async () => {
  for (const [text, input] of [['点赞', {}], ['给我点赞', {}], ['给我点3个赞', { count: 3 }], ['给我的名片点赞', { qq: '我', count: 20 }]]) {
    const f = privateFixture(text), result = await f.execute('likeTool', input)
    assert.equal(result.status, 'succeeded', text)
    assert.deepEqual(f.plans[0].operations, [{ kind: 'profile-like', user: user('actor'), count: input.count ?? 10 }]); assert.deepEqual(f.reads, [])
  }
  const group = fixture('给我点赞'); assert.equal((await group.execute('likeTool')).status, 'succeeded'); assert.equal(group.plans[0].operations[0].count, 10)
  const poke = fixture('戳我一下'); await poke.execute('pokeTool'); assert.equal(poke.plans[0].operations.length, 1)
  const opaque = privateFixture('点赞', { binding: { ...fixture('点赞').context.binding, target: { account, kind: 'private', id: 'opaque-conversation' } } })
  assert.equal((await opaque.execute('likeTool')).status, 'succeeded'); assert.equal(opaque.plans[0].operations[0].user.id, 'actor')
})
test('private likes reject absent or foreign peers, third parties, random selection and borrowed target phrasing', async () => {
  for (const [text, input, overrides] of [['给我点赞', {}, { privatePeer: undefined }], ['给我点赞', {}, { privatePeer: user('one') }],
    ['给我点赞', {}, { privatePeer: { ...user('actor'), namespace: 'foreign' } }],
    ['给我点赞', {}, { actor: { kind: 'user', user: user('one') } }], ['给小明点赞', { qq: 'one' }, {}],
    ['帮我给小明点赞', {}, {}], ['替我给他点赞', { qq: 'actor' }, {}], ['随机给群友点赞', { random: true }, {}],
    ['不要给我点赞，请查天气', {}, {}], ['只是举例：给我点赞', {}, {}]]) {
    const f = privateFixture(text, overrides), result = await f.execute('likeTool', input)
    assert.equal(result.status, 'failed', text); assert.equal(f.plans.length, 0)
  }
  for (const name of ['pokeTool', 'reactionTool']) {
    const f = privateFixture('戳我一下，贴表情'); assert.equal((await f.execute(name)).status, 'failed'); assert.equal(f.plans.length, 0)
  }
})
test('recall uses only a trusted quote or an exact supplied ID and leaves ownership to Core', async () => {
  for (const make of [fixture, privateFixture]) for (const quoted of [false, true]) {
    const f = make(quoted ? '请撤回这条消息' : '请撤回消息 out-42')
    if (quoted) f.context.request.replyMessageId = 'quoted-1'
    const result = await f.execute('recallTool', quoted ? {} : { message_id: 'out-42' })
    assert.equal(result.status, 'succeeded'); assert.deepEqual(f.plans[0].operations, [{ kind: 'message-recall', messageId: quoted ? 'quoted-1' : 'out-42' }])
  }
  const missing = fixture('撤回你刚才的消息'), missingResult = await missing.execute('recallTool')
  assert.equal(missingResult.status, 'failed'); assert.equal(JSON.parse(missingResult.content).code, 'interaction_needs_target'); assert.equal(missing.plans.length, 0)
  for (const [text, input] of [['撤回这条消息', { message_id: 'current-1' }], ['撤回消息 out-42-extra', { message_id: 'out-42' }],
    ['撤回消息 12345', { message_id: '2345' }], ['普通聊天', { message_id: 'current-1' }]]) {
    const f = fixture(text); assert.equal((await f.execute('recallTool', input)).status, 'failed'); assert.equal(f.plans.length, 0)
  }
})
test('recall refuses negative, quoted, reported and mixed conflicts even with a target ID', async () => {
  for (const text of ['不要撤回 out-42，请查天气', '不要把 out-42 撤回，请查天气', '先不撤回 out-42，撤回 out-42',
    '只是举例：撤回 out-42，请查天气', '他说撤回 out-42，请查天气', '“撤回 out-42”是个例子，请查天气', '没有让你撤回 out-42，请查天气']) {
    const f = fixture(text); assert.equal((await f.execute('recallTool', { message_id: 'out-42' })).status, 'failed', text); assert.equal(f.plans.length, 0)
  }
})
test('poke owns multiple grounded targets and exact repetitions and refreshes each selected real member', async () => {
  const f = fixture('戳小明和小红各两次')
  const result = await f.execute('pokeTool', { target: ['小明', '小红', '小明'], times: 2 })
  assert.equal(result.status, 'succeeded'); assert.deepEqual(JSON.parse(result.content), { action: 'poke', state: 'confirmed', completed: 4, requested: 4 })
  assert.deepEqual(f.reads, ['one', 'two']); assert.deepEqual(f.plans[0].operations.map(value => value.user.id), ['one', 'one', 'two', 'two'])
  assert.ok(Object.isFrozen(f.plans[0])); assert.ok(Object.isFrozen(f.plans[0].operations[0].user))
})
test('real mentions and explicit self requests supply default targets without accepting invented user IDs', async () => {
  const self = fixture('戳我一下'); assert.equal((await self.execute('pokeTool')).status, 'succeeded'); assert.equal(self.plans[0].operations[0].user.id, 'actor')
  const like = fixture('给我点3个赞'); assert.equal((await like.execute('likeTool', { count: 3 })).status, 'succeeded'); assert.deepEqual(like.plans[0].operations[0], { kind: 'profile-like', user: user('actor'), count: 3 })
  const mention = fixture('戳一下这个群友'); mention.context.request.mentions = [user('two')]
  assert.equal((await mention.execute('pokeTool', { times: 2 })).status, 'succeeded'); assert.equal(mention.plans[0].operations[0].user.id, 'two')
  const reply = fixture('给他点个赞'); reply.context.request.replyAuthor = user('one')
  assert.equal((await reply.execute('likeTool')).status, 'succeeded'); assert.equal(reply.plans[0].operations[0].user.id, 'one')
  for (const [text, name, input] of [['戳小红', 'pokeTool', { target: ['one'] }], ['小明今天来了', 'likeTool', { qq: 'actor' }], ['给他点赞', 'likeTool', {}], ['戳一戳', 'pokeTool', {}]]) {
    const f = fixture(text); assert.equal((await f.execute(name, input)).status, 'failed'); assert.equal(f.plans.length, 0)
  }
})
test('requesting help for another member never defaults the action recipient to the requester', async () => {
  for (const [name, text, input] of [['pokeTool', '帮我戳小明一下', { target: '小明' }], ['pokeTool', '替我拍一拍小明', { target: '小明' }],
    ['likeTool', '帮我给小明点赞', { qq: '小明' }], ['likeTool', '替我给小明点3个赞', { qq: '小明', count: 3 }]]) {
    const omitted = fixture(text), result = await omitted.execute(name)
    assert.equal(result.status, 'failed'); assert.equal(JSON.parse(result.content).code, 'interaction_needs_target'); assert.equal(omitted.plans.length, 0)
    const explicit = fixture(text)
    assert.equal((await explicit.execute(name, input)).status, 'succeeded'); assert.equal(explicit.plans[0].operations[0].user.id, 'one')
  }
})
test('strict self targets and quoted third-party targets retain their recipients', async () => {
  for (const [name, text] of [['pokeTool', '戳我一下'], ['pokeTool', '拍我一下'], ['pokeTool', '拍一拍我'],
    ['likeTool', '给我点赞'], ['likeTool', '给我点3个赞'], ['likeTool', '赞我'], ['likeTool', '给我的名片点赞'], ['likeTool', '我的名片点3个赞']]) {
    const f = fixture(text)
    assert.equal((await f.execute(name)).status, 'succeeded', text); assert.equal(f.plans[0].operations[0].user.id, 'actor')
  }
  for (const [name, text] of [['pokeTool', '帮我戳他一下'], ['likeTool', '帮我给他点赞']]) {
    const f = fixture(text); f.context.request.replyAuthor = user('one')
    assert.equal((await f.execute(name)).status, 'succeeded'); assert.equal(f.plans[0].operations[0].user.id, 'one')
  }
})
test('random selection cannot silently override an explicit interaction target', async () => {
  for (const [name, text, input] of [['pokeTool', '随机戳一位群友', { random: true, target: '小明' }],
    ['pokeTool', '随机戳一位群友', { random: true, target: ['小明'] }], ['likeTool', '随机给群友点赞', { random: true, qq: '小明' }]]) {
    const f = fixture(text), result = await f.execute(name, input)
    assert.equal(result.status, 'failed'); assert.equal(JSON.parse(result.content).code, 'interaction_invalid_input'); assert.equal(f.plans.length, 0); assert.equal(f.reads.length, 0)
  }
})
test('ambiguous names and conflicting shorter names fail without selecting the first member', async () => {
  const f = fixture('戳小明一下', { async listMembers() { return { target, complete: true, observedAt: Date.now(), members: [...roster, member('three', '小明')] } } })
  assert.equal((await f.execute('pokeTool', { target: ['小明'] })).status, 'failed'); assert.equal(f.plans.length, 0)
  const shorter = fixture('戳小明同学', { async listMembers() { return { target, complete: true, observedAt: Date.now(), members: [...roster, member('three', '小明同学')] } } })
  assert.equal((await shorter.execute('pokeTool', { target: ['one'] })).status, 'failed'); assert.equal(shorter.plans.length, 0)
})
test('random poke requires actual random intent and chooses only a refreshed current member excluding self and bot', async () => {
  const f = fixture('随机戳一位群友')
  assert.equal((await f.execute('pokeTool', { random: true, times: 2 })).status, 'succeeded')
  assert.equal(f.plans[0].operations.length, 2); assert.ok(['one', 'two'].includes(f.plans[0].operations[0].user.id))
  assert.equal(f.plans[0].operations[0].user.id, f.plans[0].operations[1].user.id)
  const denied = fixture('戳小明'); assert.equal((await denied.execute('pokeTool', { random: true })).status, 'failed'); assert.equal(denied.plans.length, 0)
})
test('random like keeps its legacy option, requires a positive random-like request and excludes self and bot', async () => {
  const f = fixture('随机给群友点个赞')
  assert.equal((await f.execute('likeTool', { random: true, count: 2 })).status, 'succeeded')
  assert.equal(f.plans[0].operations.length, 1); assert.equal(f.plans[0].operations[0].count, 2)
  assert.ok(['one', 'two'].includes(f.plans[0].operations[0].user.id))
  const invented = fixture('随机挑一个群友')
  assert.equal((await invented.execute('likeTool', { random: true })).status, 'failed'); assert.equal(invented.plans.length, 0)
  const actor = fixture('我来群里了')
  assert.equal((await actor.execute('likeTool', { qq: 'actor' })).status, 'failed'); assert.equal(actor.plans.length, 0)
  const unrelated = fixture('随机查个天气，给小明点赞')
  assert.equal((await unrelated.execute('likeTool', { random: true })).status, 'failed'); assert.equal(unrelated.plans.length, 0)
  const explicit = fixture('给小明点赞')
  assert.equal((await explicit.execute('likeTool', { random: true })).status, 'failed'); assert.equal(explicit.plans.length, 0)
  const missing = fixture('随便给群友点赞', { async listMembers() { return { target, observedAt: Date.now(), complete: true, members: [roster[0], roster[3]] } } })
  assert.equal((await missing.execute('likeTool', { random: true })).status, 'failed'); assert.equal(missing.plans.length, 0)
})
test('target or message parameters cannot authorize an action absent positive request intent', async () => {
  for (const [name, text, input] of [['pokeTool', '随机挑一位群友', { random: true }], ['pokeTool', '小明今天在线', { target: ['小明'] }],
    ['likeTool', '小红刚才发言了', { qq: 'two' }], ['likeTool', '随机挑一位群友', { random: true }],
    ['reactionTool', '这条消息挺有意思', { message_id: 'current-1' }]]) {
    const f = fixture(text); assert.equal((await f.execute(name, input)).status, 'failed'); assert.equal(f.plans.length, 0)
  }
})
test('member evidence must match the current conversation, namespace and refreshed identity', async () => {
  for (const override of [
    { async listMembers() { return { target: { ...target, id: 'foreign' }, complete: true, observedAt: 1, members: roster } } },
    { async listMembers() { return { target, complete: true, observedAt: 1, members: [member('one', '小明'), { ...member('two', '小红'), user: { ...user('two'), namespace: 'foreign' } }] } } },
    { async listMembers() { return { target, complete: false, observedAt: 1, members: roster } } },
    { async readMember() { return { target, observedAt: 1, member: member('two', '小红') } } },
    { async readMember() { return { target: { ...target, id: 'foreign' }, observedAt: 1, member: member('one', '小明') } } },
    { async readMember() { return undefined } },
  ]) {
    const f = fixture('戳小明', override); assert.equal((await f.execute('pokeTool', { target: ['小明'] })).status, 'failed'); assert.equal(f.plans.length, 0)
  }
})
test('pending member reads reauthorize the source before handing a plan to Core', async () => {
  const f = fixture('戳小明'); f.context.readMember = async () => { f.revoke(); return { target, observedAt: Date.now(), member: roster[1] } }
  assert.equal((await f.execute('pokeTool', { target: ['小明'] })).status, 'failed'); assert.equal(f.plans.length, 0)
})
test('target arrays are snapshotted before member lookup yields', async () => {
  let release, enter
  const entered = new Promise(resolve => { enter = resolve }), paused = new Promise(resolve => { release = resolve })
  const f = fixture('戳小明和小红', { async listMembers() { enter(); await paused; return { target, observedAt: Date.now(), complete: true, members: roster } } })
  const targets = ['小明'], pending = f.execute('pokeTool', { target: targets })
  await entered; targets[0] = '小红'; release()
  assert.equal((await pending).status, 'succeeded'); assert.equal(f.plans[0].operations[0].user.id, 'one')
})
test('reaction accepts only current, verified quoted or exactly supplied message IDs and draws bounded trusted emoji', async () => {
  for (const [text, reply, input, expected] of [['贴一下表情', undefined, {}, 'current-1'], ['对引用消息贴表情', 'quoted-1', { count: 20 }, 'quoted-1'], ['给消息 msg-42 贴表情', undefined, { message_id: 'msg-42' }, 'msg-42']]) {
    const f = fixture(text); if (reply) f.context.request.replyMessageId = reply
    assert.equal((await f.execute('reactionTool', input)).status, 'succeeded')
    for (const op of f.plans[0].operations) { assert.equal(op.messageId, expected); const emoji = Number(op.emojiId); assert.ok(emoji >= 1 && emoji <= 500 || emoji >= 127801 && emoji <= 128563) }
  }
  for (const [text, id] of [['贴表情', 'foreign-message'], ['给消息 msg-42-extra 贴表情', 'msg-42'], ['给消息 12345 贴表情', '2345']]) {
    const f = fixture(text); assert.equal((await f.execute('reactionTool', { message_id: id })).status, 'failed'); assert.equal(f.plans.length, 0)
  }
})
test('denied actions remain denied even when another clause requests a different tool', async () => {
  for (const [name, text, input] of [['pokeTool', '不要戳小明，请给我点赞', { target: ['小明'] }], ['likeTool', '别点赞小明，请戳我', { qq: '小明' }],
    ['reactionTool', '别给消息贴表情，请查资料', {}], ['pokeTool', '只是举例戳小明', { target: ['小明'] }]]) {
    const f = fixture(text); assert.equal((await f.execute(name, input)).status, 'failed'); assert.equal(f.plans.length, 0)
  }
})
test('malicious input objects, arrays and extra native controls never invoke getters or proxy traps', async () => {
  let touched = 0
  const proxied = new Proxy({}, { ownKeys() { touched++; throw Error('PRIVATE_PROXY') }, get() { touched++; throw Error('PRIVATE_PROXY') }, getPrototypeOf() { touched++; throw Error('PRIVATE_PROXY') } })
  for (const [name, input] of [['pokeTool', { get target() { touched++; return ['小明'] } }], ['pokeTool', proxied],
    ['pokeTool', { target: new Proxy(['小明'], { getPrototypeOf() { touched++; return Array.prototype } }) }],
    ['likeTool', { qq: '小明', target: 'foreign' }], ['reactionTool', { message_id: 'current-1', emojiId: '1' }]]) {
    const f = fixture('戳小明，给小明点赞，贴表情'); assert.equal((await f.execute(name, input)).status, 'failed'); assert.equal(f.plans.length, 0)
  }
  assert.equal(touched, 0)
})
test('count bounds reject oversized or fractional plans without partial admission', async () => {
  for (const [name, input] of [['pokeTool', { target: ['小明'], times: 11 }], ['pokeTool', { target: ['小明'], times: 0 }],
    ['likeTool', { qq: '小明', count: 21 }], ['reactionTool', { count: 21 }], ['reactionTool', { count: 1.5 }]]) {
    const f = fixture('戳小明，给小明点赞，贴表情'); assert.equal((await f.execute(name, input)).status, 'failed'); assert.equal(f.plans.length, 0)
  }
})
for (const state of ['failed', 'unknown']) test(`${state} Core results retain partial counts and never trigger a tool retry or text send`, async () => {
  let calls = 0
  const f = fixture('戳小明三次', { async interact(plan) { calls++; return { state, completed: 1, requested: plan.operations.length } }, async sendMessage() { assert.fail('interaction tool must not send extra text') } })
  const result = await f.execute('pokeTool', { target: ['小明'], times: 3 })
  assert.equal(result.status, state); assert.deepEqual(JSON.parse(result.content), { action: 'poke', state, completed: 1, requested: 3 }); assert.equal(calls, 1)
})
test('post-dispatch exceptions or malicious/malformed result data always remain unknown without leaking provider details', async () => {
  let touched = 0
  for (const interact of [async () => { throw Error('PRIVATE_PROVIDER_URL') }, async () => ({ get state() { touched++; return 'confirmed' } }),
    async () => ({ state: 'confirmed', completed: 0, requested: 1 }), async () => ({ state: 'sent', messageId: 'fake' })]) {
    const f = fixture('给我点赞', { interact }), result = await f.execute('likeTool')
    assert.equal(result.status, 'unknown'); assert.doesNotMatch(result.content, /PRIVATE_PROVIDER_URL/u)
  }
  assert.equal(touched, 0)
})

const managementRoster = (roles = {}) => roster.map(value => ({ ...value, role: roles[value.user.id] ?? (['actor', 'robot'].includes(value.user.id) ? 'admin' : 'member') }))
function managementFixture(text, overrides = {}, population = managementRoster()) {
  const f = fixture(text, overrides)
  if (!Object.hasOwn(overrides, 'listMembers')) f.context.listMembers = async () => ({ target, observedAt: Date.now(), complete: true, members: population })
  if (!Object.hasOwn(overrides, 'readMember')) f.context.readMember = async id => {
    f.reads.push(id); const found = population.find(value => value.user.id === id)
    return found && { target, observedAt: Date.now(), member: found }
  }
  return f
}
test('member mute defaults to five minutes, deduplicates explicit targets and carries only the actual requester', async () => {
  const f = managementFixture('禁言小明和小红'), result = await f.execute('jinyanTool', { target: ['小明', '小红', '小明'] })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(f.plans[0].operations, ['one', 'two'].map(id => ({ kind: 'member-mute', user: user(id), seconds: 300, requester: user('actor') })))
  assert.deepEqual(f.reads, ['actor', 'robot', 'one', 'actor', 'robot', 'two'])
  assert.ok(Object.isFrozen(f.plans[0].operations[0].requester))
  const omitted = managementFixture('禁言小明')
  assert.equal((await omitted.execute('jinyanTool')).status, 'succeeded'); assert.equal(omitted.plans[0].operations[0].user.id, 'one')
  const absent = managementFixture('禁言'), unresolved = await absent.execute('jinyanTool')
  assert.equal(unresolved.status, 'failed'); assert.equal(JSON.parse(unresolved.content).code, 'interaction_needs_target'); assert.equal(absent.plans.length, 0)
})
test('member mute normalizes old integer bounds but preserves the explicit mute versus unmute direction', async () => {
  for (const [text, time, seconds] of [['禁言小明一分钟', 60, 60], ['禁言小明', 999999999, 2592000], ['解禁小明', 0, 0], ['解除小明禁言', -3, 0]]) {
    const f = managementFixture(text), result = await f.execute('jinyanTool', { target: '小明', time })
    assert.equal(result.status, 'succeeded', text); assert.equal(f.plans[0].operations[0].seconds, seconds)
  }
  for (const [text, time] of [['禁言小明', 0], ['禁言小明', -1], ['解禁小明', undefined], ['解除小明禁言', 60],
    ['禁言小明', 1.5], ['禁言小明', NaN], ['禁言小明', Infinity], ['禁言小明', '60']]) {
    const f = managementFixture(text); assert.equal((await f.execute('jinyanTool', { target: '小明', ...(time === undefined ? {} : { time }) })).status, 'failed', text)
    assert.equal(f.plans.length, 0)
  }
})
test('group management refuses borrowed actors, private scope, forged role fields and autonomous selfDecision', async () => {
  for (const [name, text, input] of [['jinyanTool', '禁言小明', { target: '小明' }], ['changeCardTool', '把小明名片改成新名', { target: '小明', cardName: '新名' }]]) {
    for (const overrides of [{ actor: { kind: 'autonomous' } }, { actor: { kind: 'commitment' } }, { request: undefined }, { interact: undefined },
      { binding: { ...fixture(text).context.binding, target: { ...target, kind: 'private' } } }]) {
      const f = managementFixture(text, overrides); assert.equal((await f.execute(name, input)).status, 'failed'); assert.equal(f.plans.length, 0)
    }
    const forged = managementFixture(text)
    assert.equal((await forged.execute(name, { ...input, senderRole: 'owner' })).status, 'failed'); assert.equal(forged.plans.length, 0)
  }
  for (const input of [{ target: '小明', selfDecision: true }, { target: '小明', random: 'true' }, { target: '小明', confirm: 1 }, { target: '小明', selfDecision: 'false' }]) {
    const f = managementFixture('禁言小明'); assert.equal((await f.execute('jinyanTool', input)).status, 'failed'); assert.equal(f.plans.length, 0)
  }
  const legacyFalse = managementFixture('禁言小明')
  assert.equal((await legacyFalse.execute('jinyanTool', { target: '小明', selfDecision: false })).status, 'succeeded')
})
test('fresh manager and ordinary-target evidence is mandatory for every personal mute or unmute', async () => {
  for (const [roleChange, text, time] of [[{ actor: 'member' }, '禁言小明', 60], [{ actor: 'unknown' }, '禁言小明', 60],
    [{ robot: 'member' }, '禁言小明', 60], [{ robot: 'unknown' }, '禁言小明', 60], [{ one: 'admin' }, '禁言小明', 60],
    [{ one: 'owner' }, '禁言小明', 60], [{ one: 'unknown' }, '禁言小明', 60], [{ one: 'admin' }, '解禁小明', 0]]) {
    const f = managementFixture(text, {}, managementRoster(roleChange))
    assert.equal((await f.execute('jinyanTool', { target: '小明', time })).status, 'failed', JSON.stringify(roleChange)); assert.equal(f.plans.length, 0)
  }
  for (const observedAt of [0, Date.now() - 10000, Date.now() + 10000, undefined]) {
    const f = managementFixture('禁言小明', { async readMember(id) { const member = managementRoster().find(value => value.user.id === id); return { target, observedAt, member } } })
    assert.equal((await f.execute('jinyanTool', { target: '小明' })).status, 'failed'); assert.equal(f.plans.length, 0)
  }
})
test('member observations retain Core five-second tolerance without a new aggregate permission TTL', async t => {
  const origin = Date.now(); let now = origin
  t.mock.method(Date, 'now', () => now)
  const f = managementFixture('禁言小明', { async readMember(id) {
    const observedAt = now; now += 1100
    return { target, observedAt, member: managementRoster().find(value => value.user.id === id) }
  } })
  assert.equal((await f.execute('jinyanTool', { target: '小明' })).status, 'succeeded')
  assert.equal(now - origin, 3300); assert.equal(f.plans.length, 1)
  for (const offset of [-2000, 2000]) {
    const f = managementFixture('禁言小明', { async readMember(id) {
      return { target, observedAt: now + offset, member: managementRoster().find(value => value.user.id === id) }
    } })
    assert.equal((await f.execute('jinyanTool', { target: '小明' })).status, 'succeeded', String(offset))
  }
})
test('random mute belongs to the same positive clause and cannot replace an explicit target', async () => {
  const f = managementFixture('随机禁言一位群友')
  assert.equal((await f.execute('jinyanTool', { random: true })).status, 'succeeded')
  assert.ok(['one', 'two'].includes(f.plans[0].operations[0].user.id)); assert.equal(f.plans[0].operations.length, 1)
  for (const [text, input] of [['禁言小明', { random: true }], ['随机讲个笑话，禁言小明', { random: true }],
    ['随机禁言小明', { random: true }], ['随机禁言一位群友', { random: true, target: '小明' }],
    ['随机禁言一位群友', { random: true, target: ['小明'] }]]) {
    const f = managementFixture(text); assert.equal((await f.execute('jinyanTool', input)).status, 'failed', text); assert.equal(f.plans.length, 0)
  }
})
test('random unmute selects only a freshly known currently muted ordinary member', async () => {
  const population = managementRoster().map(value => ({ ...value, profile: { mutedUntil: value.user.id === 'one' ? Date.now() + 300000 : Date.now() - 1 } }))
  const f = managementFixture('随机解禁一位群友', {}, population)
  assert.equal((await f.execute('jinyanTool', { time: 0, random: true })).status, 'succeeded')
  assert.equal(f.plans[0].operations[0].user.id, 'one'); assert.equal(f.plans[0].operations[0].seconds, 0)
  for (const population of [managementRoster(), managementRoster().map(value => ({ ...value, profile: { mutedUntil: Date.now() - 1 } }))]) {
    const f = managementFixture('随机解禁一位群友', {}, population)
    assert.equal((await f.execute('jinyanTool', { time: 0, random: true })).status, 'failed'); assert.equal(f.plans.length, 0)
  }
})
test('whole-group mute is an explicitly confirmed untimed switch and whole-group unmute sends only a false switch', async () => {
  for (const [text, input, enabled] of [['开启全体禁言', { target: 'all', confirm: true }, true], ['确认开启全体禁言。', { target: 'all', time: 300, confirm: true }, true],
    ['解除全体禁言', { target: 'all', time: 0 }, false], ['关闭全体禁言', { target: 'all', time: 0 }, false]]) {
    const f = managementFixture(text)
    assert.equal((await f.execute('jinyanTool', input)).status, 'succeeded', text)
    assert.deepEqual(f.plans[0].operations, [{ kind: 'group-mute', enabled, requester: user('actor') }]); assert.deepEqual(f.reads, ['actor', 'robot'])
  }
  for (const [text, input] of [['开启全体禁言', { target: 'all' }], ['全体禁言十分钟', { target: 'all', confirm: true, time: 600 }],
    ['开启全体禁言直到晚上八点', { target: 'all', confirm: true }], ['禁言小明', { target: 'all', confirm: true }],
    ['全体禁言', { target: ['all'], confirm: true }], ['关闭全体禁言', { target: 'all', time: 300 }]]) {
    const f = managementFixture(text); assert.equal((await f.execute('jinyanTool', input)).status, 'failed', text); assert.equal(f.plans.length, 0)
  }
})
test('group cards allow members to edit themselves and managers to edit known targets without an invented hierarchy', async () => {
  for (const [text, input, roles, expected] of [['把我名片改成新名', { target: '我', cardName: '新名' }, { actor: 'member' }, 'actor'],
    ['修改本人的群名片为新名', { target: '本人', cardName: '新名' }, { actor: 'member' }, 'actor'],
    ['把机器人的名片改成新名', { target: '机器人', cardName: '新名' }, { robot: 'member' }, 'robot'],
    ['把你的群名片改成新名', { target: '你', cardName: '新名' }, { robot: 'member' }, 'robot'],
    ['把小明名片改成新名', { target: '小明', cardName: '新名' }, { one: 'owner' }, 'one'],
    ['帮我把小明名片改成新名', { target: '小明', cardName: '新名' }, {}, 'one'],
    ['帮我改名片为新名', { target: '我', cardName: '新名' }, {}, 'actor']]) {
    const f = managementFixture(text, {}, managementRoster(roles)), result = await f.execute('changeCardTool', input)
    assert.equal(result.status, 'succeeded', text); assert.deepEqual(f.plans[0].operations, [{ kind: 'member-card', user: user(expected), name: '新名', requester: user('actor') }])
  }
  for (const roles of [{ actor: 'member' }, { robot: 'member' }, { actor: 'unknown' }, { robot: 'unknown' }, { one: 'unknown' }]) {
    const f = managementFixture('把小明名片改成新名', {}, managementRoster(roles))
    assert.equal((await f.execute('changeCardTool', { target: '小明', cardName: '新名' })).status, 'failed'); assert.equal(f.plans.length, 0)
  }
})
test('a proposed new card cannot ground a different member or turn helper pronouns into the target', async () => {
  for (const input of [{ target: '小红', cardName: '小红' }, { target: 'two', cardName: '小红' }, { target: '我', cardName: '小红' }, { target: '你', cardName: '小红' }]) {
    const f = managementFixture('帮我把小明名片改成小红')
    assert.equal((await f.execute('changeCardTool', input)).status, 'failed', JSON.stringify(input)); assert.equal(f.plans.length, 0)
  }
  for (const text of ['替我把小明名片改成小红', '给我改小明名片为小红', '你把小明名片改成小红']) {
    for (const target of ['我', '你']) {
      const f = managementFixture(text)
      assert.equal((await f.execute('changeCardTool', { target, cardName: '小红' })).status, 'failed', text); assert.equal(f.plans.length, 0)
    }
  }
  const f = managementFixture('把小明名片改成小红')
  assert.equal((await f.execute('changeCardTool', { target: '小明', cardName: '小红' })).status, 'succeeded'); assert.equal(f.plans[0].operations[0].user.id, 'one')
  const omitted = managementFixture('把小明名片改成小红')
  assert.equal((await omitted.execute('changeCardTool', { cardName: '小红' })).status, 'succeeded'); assert.equal(omitted.plans[0].operations[0].user.id, 'one')
})
test('card payloads are exact current positive wording, and empty cards need a clear request', async () => {
  for (const [text, name] of [['把小明名片改成“小希😀”', '小希😀'], ['把小明名片改成小希吧', '小希'],
    ['把小明名片改成' + '😀'.repeat(60), '😀'.repeat(60)], ['清空小明的群名片', ''], ['把小明名片清空', '']]) {
    const f = managementFixture(text), result = await f.execute('changeCardTool', { target: '小明', cardName: name })
    assert.equal(result.status, 'succeeded', text); assert.equal(f.plans[0].operations[0].name, name)
  }
  for (const [text, name] of [['把小明名片改成小红', '小'], ['把小明名片改成小红', 'Red'], ['把小明名片改成小红', ''],
    ['把小明名片改成清空', ''], ['把小明名片改成“清空名片”', ''],
    ['把小明名片改成新名，朋友说小红', '小红'], ['朋友说把小明名片改成小红', '小红'], ['“把小明名片改成小红”是个例子', '小红'],
    ['把小明名片改成' + '😀'.repeat(61), '😀'.repeat(61)], ['把小明名片改成x\n', 'x\n'], ['把小明名片改成\ud800', '\ud800'], ['把小明名片改成\u0085', '\u0085']]) {
    const f = managementFixture(text); assert.equal((await f.execute('changeCardTool', { target: '小明', cardName: name })).status, 'failed', text); assert.equal(f.plans.length, 0)
  }
})
test('group-management denials, reports and ambiguous identities cannot yield a plan', async () => {
  for (const [name, text, input] of [['jinyanTool', '别解禁小明，请查天气', { target: '小明', time: 0 }],
    ['jinyanTool', '不要解除小明禁言，请查天气', { target: '小明', time: 0 }], ['jinyanTool', '只是举例：禁言小明，请查天气', { target: '小明' }],
    ['jinyanTool', '他说禁言小明', { target: '小明' }], ['changeCardTool', '别改小明昵称，请查天气', { target: '小明', cardName: '新名' }],
    ['changeCardTool', '不要把小明名片改成新名，请查天气', { target: '小明', cardName: '新名' }]]) {
    const f = managementFixture(text); assert.equal((await f.execute(name, input)).status, 'failed', text); assert.equal(f.plans.length, 0)
  }
  const population = [...managementRoster(), member('three', '小明')]
  for (const [name, text, input] of [['jinyanTool', '禁言小明', { target: '小明' }], ['changeCardTool', '把小明名片改成新名', { target: '小明', cardName: '新名' }]]) {
    const f = managementFixture(text, {}, population); assert.equal((await f.execute(name, input)).status, 'failed'); assert.equal(f.plans.length, 0)
  }
})
test('revocation during each fresh member check prevents group-management submission', async () => {
  for (const revoked of ['actor', 'robot', 'one']) {
    const f = managementFixture('禁言小明', { async readMember(id) {
      const found = managementRoster().find(value => value.user.id === id)
      if (id === revoked) f.revoke()
      return { target, observedAt: Date.now(), member: found }
    } })
    assert.equal((await f.execute('jinyanTool', { target: '小明' })).status, 'failed'); assert.equal(f.plans.length, 0)
  }
})
for (const state of ['failed', 'unknown']) test(`group-management ${state} results retain partial progress without retrying or extra text`, async () => {
  let calls = 0
  const f = managementFixture('禁言小明和小红', { async interact(plan) { calls++; return { state, completed: 1, requested: plan.operations.length } }, async sendMessage() { assert.fail('no extra text') } })
  const result = await f.execute('jinyanTool', { target: ['小明', '小红'] })
  assert.equal(result.status, state); assert.deepEqual(JSON.parse(result.content), { action: 'member-mute', state, completed: 1, requested: 2 }); assert.equal(calls, 1)
})
