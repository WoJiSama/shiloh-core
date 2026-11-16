import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentMemberTools } from '../dist/backend/modules/tools/infrastructure/agentMemberTools.js'

const account = { platform: 'qq', namespace: 'global', id: '123456789' }
const target = { account, kind: 'group', id: '315320' }
const actor = { platform: 'qq', namespace: 'global', id: '324151' }
const ref = id => ({ platform: 'qq', namespace: 'global', id })
const member = (id, displayName, role = 'member', profile = {}) => ({ user: ref(id), displayName, role, profile: { nickname: displayName, ...profile } })
const self = member(actor.id, '提问者', 'member', { nickname: '本人的昵称', conversationName: '本人群名片' })
const lin = member('324152', '小林', 'admin', { nickname: '林', conversationName: '小林' })
const wu = member('324153', '小吴', 'member', { nickname: '吴', conversationName: '小吴' })
const owner = member('324156', '群主本人', 'owner')
const bot = member(account.id, '机器人', 'admin')
const baseMembers = [self, lin, wu, owner, bot]
const observedAt = Date.parse('2026-11-16T02:03:04Z')

function fixture({ members = baseMembers, text = '查询成员资料', mentions = [], replyAuthor, context = {}, receipt = { state: 'sent', messageId: 'confirmed-mention' } } = {}) {
  const reads = [], lists = [], sends = [], otherSends = [], checks = []
  const ctx = {
    binding: { source: 'configured', id: 'binding-fixture', agentId: 'agent-fixture', revision: 'revision-fixture', personaId: 'persona-fixture',
      connectionId: 'connection-fixture', target }, actor: { kind: 'user', user: actor }, botUserId: account.id,
    request: { messageId: 'current-user-request', text, mentions: mentions.map(id => typeof id === 'string' ? ref(id) : id), ...(replyAuthor ? { replyAuthor: ref(replyAuthor) } : {}) },
    signal: new AbortController().signal, isCurrent: () => true, async ensureCurrent() { checks.push('current') },
    async listMembers() { lists.push('list'); return { target, observedAt, members, complete: true } },
    async readMember(id) {
      reads.push(id)
      const found = members.find(item => item.user.id === id)
      return found ? { target, observedAt, member: { ...found, profile: { ...found.profile, title: `仅此人的头衔-${id}`, level: '0', joinedAt: 1_600_000_000_000 } } } : undefined
    },
    async sendMessage(message) { sends.push(structuredClone(message)); return receipt },
    async sendBundle(message) { otherSends.push({ kind: 'bundle', message }); return { state: 'sent', messageId: 'unexpected-bundle' } },
    async sendImage(message) { otherSends.push({ kind: 'image', message }); return { state: 'sent', messageId: 'unexpected-image' } },
    ...context,
  }
  const tools = new Map(createAgentMemberTools().map(tool => [tool.name, tool]))
  return { ctx, reads, lists, sends, otherSends, checks,
    async execute(name, input = {}) { return tools.get(name).execute(input, ctx) } }
}
const resultData = result => JSON.parse(result.content)
const assertNoSideEffects = f => { assert.deepEqual(f.reads, []); assert.deepEqual(f.lists, []); assert.deepEqual(f.sends, []); assert.deepEqual(f.otherSends, []) }

test('member tools expose closed separate query and real mention contracts', () => {
  const tools = createAgentMemberTools()
  assert.deepEqual(tools.map(tool => tool.name), ['memberInfoTool', 'mentionMembersTool', 'mentionAdminsTool'])
  assert.ok(Object.isFrozen(tools))
  for (const tool of tools) assert.equal(tool.parameters.additionalProperties, false)
  assert.deepEqual(tools[0].parameters.required, [])
  assert.deepEqual(tools[1].parameters.required, ['targets'])
  assert.equal(tools[1].parameters.properties.targets.maxItems, 20)
  assert.equal(tools[2].parameters.properties.includeOwner.type, 'boolean')
})

test('explicit QQ self and actual mention evidence override a model-supplied different member ID', async () => {
  for (const entry of [
    { text: '查一下我的群名片和入群时间', expected: self.user.id },
    { text: '这位群友的成员资料是什么？', mentions: [account.id, lin.user.id], expected: lin.user.id },
    { text: '[CQ:at,qq=324152] 这位的入群时间', expected: lin.user.id },
    { text: '查一下QQ号324152的成员资料', expected: lin.user.id },
    { text: '查一下被回复的这位的资料', replyAuthor: wu.user.id, expected: wu.user.id },
  ]) {
    const f = fixture(entry)
    const result = await f.execute('memberInfoTool', { user_id: owner.user.id })
    assert.equal(result.status, 'succeeded', entry.text)
    assert.deepEqual(f.reads, [entry.expected], 'only trusted current-turn evidence determines the read subject')
    assert.deepEqual(f.lists, [])
    assert.deepEqual(f.sends, [])
    const content = resultData(result)
    assert.equal(content.data.user_id, entry.expected)
    assert.equal(content.data.title, `仅此人的头衔-${entry.expected}`)
    assert.equal(content.data.level, '0')
    assert.equal(content.observedAt, observedAt)
    assert.doesNotMatch(result.content, /binding-fixture|connection-fixture|revision-fixture|persona-fixture/u)
  }
})

test('membership alone, unrelated numbers and unresolved pronouns cannot authorize an invented query ID', async () => {
  for (const text of ['这位群友是谁？', '他是谁？', '说说成员资料', '刚发了编号13241529的工单', '请查看 https://example.test/324152 的文档']) {
    const f = fixture({ text })
    const result = await f.execute('memberInfoTool', { user_id: lin.user.id })
    assert.equal(result.status, 'failed', text)
    assertNoSideEffects(f)
    assert.doesNotMatch(result.content, /仅此人的头衔/u)
  }
  const modelName = fixture({ text: '你了解其他成员吗？' })
  assert.equal((await modelName.execute('memberInfoTool', { nickname: '小林' })).status, 'failed')
  assertNoSideEffects(modelName)
})

test('multiple actual QQ mentions require clarification instead of reading the model-selected member', async () => {
  const f = fixture({ text: '他们的资料呢？', mentions: [lin.user.id, wu.user.id] })
  const result = await f.execute('memberInfoTool', { user_id: lin.user.id })
  assert.equal(result.status, 'failed')
  assert.equal(resultData(result).status, 'needs_clarification')
  assertNoSideEffects(f)
})

test('shared nicknames return bounded distinct candidates and never fetch either person’s private detail', async () => {
  const first = member('324154', '项目一', 'admin', { nickname: '同名', conversationName: '项目一' })
  const second = member('324155', '项目二', 'member', { nickname: '同名', conversationName: '项目二' })
  const f = fixture({ members: [first, second], text: '同名的成员资料给我看看' })
  const result = await f.execute('memberInfoTool', { nickname: '同名' })
  assert.equal(result.status, 'failed')
  const content = resultData(result)
  assert.equal(content.status, 'needs_clarification')
  assert.equal(content.total_candidates, 2)
  assert.deepEqual(content.candidates, [{ user_id: first.user.id, nickname: '同名', card: '项目一' }, { user_id: second.user.id, nickname: '同名', card: '项目二' }])
  assert.equal(f.lists.length, 1)
  assert.deepEqual(f.reads, [])
  assert.deepEqual(f.sends, [])
  assert.doesNotMatch(result.content, /头衔|joinedAt/u)
})

test('full nickname or group-card matches take precedence over larger fuzzy name matches', async () => {
  for (const exactProfile of [{ nickname: '小林', conversationName: '精确名片' }, { nickname: '别的昵称', conversationName: '小林' }]) {
    const exact = member('324154', '精确显示名', 'member', exactProfile)
    const longer = member('324155', '小林同学', 'member', { nickname: '小林同学', conversationName: '小林同学的名片' })
    const f = fixture({ members: [longer, exact], text: '查小林的入群时间' })
    const result = await f.execute('memberInfoTool', { nickname: '小林' })
    assert.equal(result.status, 'succeeded')
    assert.deepEqual(f.reads, [exact.user.id])
    assert.equal(resultData(result).data.displayName, '精确显示名')
  }
})

test('a unique name substring may identify one detailed lookup, while an ambiguous or absent substring may not', async () => {
  const first = member('324154', '极光设计', 'member', { nickname: 'Aurora Design' })
  const second = member('324155', '极光研发', 'member', { nickname: 'Aurora Dev' })
  const unique = fixture({ members: [first, wu], text: '查Aurora的群名片' })
  assert.equal((await unique.execute('memberInfoTool', { nickname: 'Aurora' })).status, 'succeeded')
  assert.deepEqual(unique.reads, [first.user.id])
  const ambiguous = fixture({ members: [first, second], text: '查Aurora的资料' })
  const result = await ambiguous.execute('memberInfoTool', { nickname: 'Aurora' })
  assert.equal(result.status, 'failed')
  assert.equal(resultData(result).total_candidates, 2)
  assert.deepEqual(ambiguous.reads, [])
  const missing = fixture({ members: [first], text: '查不存在的群友资料' })
  assert.equal((await missing.execute('memberInfoTool', { nickname: '不存在' })).status, 'failed')
  assert.deepEqual(missing.reads, [])
})

test('every member tool rejects non-user, private or missing-current-request contexts before reading or sending', async () => {
  for (const context of [{ actor: { kind: 'autonomous' } }, { actor: { kind: 'commitment' } }, { actor: { kind: 'user' } },
    { binding: { source: 'configured', id: 'private-binding', target: { ...target, kind: 'private', id: actor.id } } },
    { request: undefined }, { request: { messageId: '', text: '通知所有管理员', mentions: [] } },
    { signal: AbortSignal.abort() }, { isCurrent: () => false },
  ]) for (const [name, input] of [['memberInfoTool', {}], ['mentionMembersTool', { targets: ['小林'], message: '测试通知' }], ['mentionAdminsTool', {}]]) {
    const f = fixture({ text: '查我的资料并通知所有管理员和小林', context })
    assert.equal((await f.execute(name, input)).status, 'failed', `${name}/${JSON.stringify(context)}`)
    assertNoSideEffects(f)
  }
})

test('member notifications emit one true unique mention list for exact current ID and nickname evidence, with explicit partial skips', async () => {
  const f = fixture({ text: '通知QQ号324152和小吴开会；重名和不存在的先别猜', members: [...baseMembers,
    member('324154', '另一个一', 'member', { nickname: '重名' }), member('324155', '另一个二', 'member', { nickname: '重名' })] })
  const result = await f.execute('mentionMembersTool', { targets: [lin.user.id, '小吴', lin.user.id, '重名', '不存在'], message: '  十点开会  ' })
  assert.equal(result.status, 'succeeded')
  assert.equal(f.sends.length, 1)
  assert.deepEqual(f.sends[0].mentionUserIds, [lin.user.id, wu.user.id])
  assert.match(f.sends[0].text, /^十点开会/u)
  assert.match(f.sends[0].text, /未艾特：重名、不存在/u)
  assert.doesNotMatch(f.sends[0].text, /@324152|\[CQ:at/u)
  assert.deepEqual(resultData(result).skipped, ['重名', '不存在'])
  assert.equal(resultData(result).count, 2)
  assert.deepEqual(f.reads, [], 'notifications use role/name evidence without reading demographics')
  assert.deepEqual(f.otherSends, [])
})

test('notifications require exact unique names and genuine mention or boundary-delimited ID evidence, never fuzzy or model-only targets', async () => {
  for (const entry of [
    { text: '提醒一下大家', targets: [lin.user.id] },
    { text: '通知QQ号13241529的成员', targets: [lin.user.id] },
    { text: '通知 https://example.test/324152 里的联系人', targets: [lin.user.id] },
    { text: '通知小林同学', targets: ['小林'], members: [member('324154', '小林同学')] },
    { text: '通知重名', targets: ['重名'], members: [member('324154', '第一人', 'member', { nickname: '重名' }), member('324155', '第二人', 'member', { nickname: '重名' })] },
  ]) {
    const f = fixture(entry)
    assert.equal((await f.execute('mentionMembersTool', { targets: entry.targets, message: '通知正文' })).status, 'failed', entry.text)
    assert.deepEqual(f.sends, [])
    assert.deepEqual(f.otherSends, [])
  }
  const actual = fixture({ text: '请通知这位集合', mentions: [lin.user.id] })
  assert.equal((await actual.execute('mentionMembersTool', { targets: [lin.user.id], message: '集合' })).status, 'succeeded')
  assert.deepEqual(actual.sends, [{ text: '集合', mentionUserIds: [lin.user.id] }])
})

test('explicit singular owner notification remains a single owner mention and cannot expand into administrator collection', async () => {
  const f = fixture({ text: '通知群主来处理一下' })
  assert.equal((await f.execute('mentionMembersTool', { targets: ['群主'], message: '请处理一下' })).status, 'succeeded')
  assert.deepEqual(f.sends, [{ text: '请处理一下', mentionUserIds: [owner.user.id] }])
  const singularAsCollection = fixture({ text: '通知群主来处理一下' })
  assert.equal((await singularAsCollection.execute('mentionAdminsTool', { includeOwner: true })).status, 'failed')
  assertNoSideEffects(singularAsCollection)
})

test('administrator collection defaults exclude the bot, owner, ordinary members and unknown roles', async () => {
  const secondAdmin = member('324154', '另一位管理员', 'admin')
  const f = fixture({ text: '通知所有管理员十点集合', members: [bot, owner, lin, wu, secondAdmin, member('324155', '未知角色', 'unknown')] })
  const result = await f.execute('mentionAdminsTool', { message: '十点集合' })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(f.sends, [{ text: '十点集合', mentionUserIds: [lin.user.id, secondAdmin.user.id] }])
  assert.equal(resultData(result).includeOwner, false)
  assert.equal(resultData(result).count, 2)
  assert.deepEqual(f.reads, [])
})

test('administrator collections require an explicit plural collection request rather than a singular role or discussion', async () => {
  for (const text of ['通知管理员过来', '请管理员处理一下', '艾特群主', '群里有哪些管理员？', '所有管理员都很忙', '查一下管理员的资料']) {
    const f = fixture({ text })
    assert.equal((await f.execute('mentionAdminsTool', { message: '模型自行补的通知' })).status, 'failed', text)
    assertNoSideEffects(f)
  }
})

test('including the owner requires both includeOwner and current-request wording that explicitly includes the owner', async () => {
  const noOwnerWording = fixture({ text: '通知所有管理员开会' })
  assert.equal((await noOwnerWording.execute('mentionAdminsTool', { includeOwner: true })).status, 'failed')
  assertNoSideEffects(noOwnerWording)
  const explicit = fixture({ text: '通知所有管理员以及群主开会' })
  assert.equal((await explicit.execute('mentionAdminsTool', { includeOwner: true, message: '开会' })).status, 'succeeded')
  assert.deepEqual(explicit.sends[0].mentionUserIds, [lin.user.id, owner.user.id])
  assert.ok(!explicit.sends[0].mentionUserIds.includes(account.id))
  const wordingOnly = fixture({ text: '通知所有管理员以及群主开会' })
  assert.equal((await wordingOnly.execute('mentionAdminsTool', {})).status, 'succeeded')
  assert.deepEqual(wordingOnly.sends[0].mentionUserIds, [lin.user.id], 'a model opt-in remains necessary even when the owner is mentioned in the request')
})

test('mentioning the owner only to exclude them cannot authorize model-requested inclusion', async () => {
  for (const text of ['通知所有管理员，不要叫群主', '通知所有管理员，群主不用通知', '通知所有管理员，但不包括群主']) {
    const f = fixture({ text })
    const result = await f.execute('mentionAdminsTool', { includeOwner: true, message: '开会' })
    assert.equal(result.status, 'failed', text)
    assert.deepEqual(f.sends, [], 'a conflicting owner exclusion must stop the batch rather than follow the guessed includeOwner flag')
  }
})

test('a unique exact and grounded administrator exclusion removes only that member; ambiguous, fuzzy or invented exclusions stop the whole batch', async () => {
  const secondAdmin = member('324154', '第二管理员', 'admin')
  const exact = fixture({ text: '通知所有管理员，除了小林', members: [...baseMembers, secondAdmin] })
  assert.equal((await exact.execute('mentionAdminsTool', { excludeTargets: ['小林'], message: '开会' })).status, 'succeeded')
  assert.deepEqual(exact.sends, [{ text: '开会', mentionUserIds: [secondAdmin.user.id] }])
  assert.equal(resultData(await fixture({ text: '通知所有管理员，除了QQ号324152', members: [...baseMembers, secondAdmin] })
    .execute('mentionAdminsTool', { excludeTargets: [lin.user.id] })).excluded, 1)
  for (const entry of [
    { text: '通知所有管理员，除了同名', excludeTargets: ['同名'], members: [member('324154', '甲', 'admin', { nickname: '同名' }), member('324155', '乙', 'admin', { nickname: '同名' }), lin] },
    { text: '通知所有管理员', excludeTargets: ['小林'], members: [...baseMembers, secondAdmin] },
    { text: '通知所有管理员，除了第二', excludeTargets: ['第二'], members: [...baseMembers, secondAdmin] },
    { text: '通知所有管理员，除了不存在', excludeTargets: ['不存在'], members: [...baseMembers, secondAdmin] },
  ]) {
    const f = fixture(entry)
    const result = await f.execute('mentionAdminsTool', { excludeTargets: entry.excludeTargets, message: '不应误发' })
    assert.equal(result.status, 'failed', entry.text)
    assert.equal(resultData(result).status, 'needs_clarification')
    assert.deepEqual(f.sends, [], 'exclusion ambiguity must reject the entire collection rather than silently notify everybody')
    assert.deepEqual(f.otherSends, [])
  }
})

test('unknown or definite failed receipts never trigger a text/image/bundle fallback or a second notification', async () => {
  for (const name of ['mentionMembersTool', 'mentionAdminsTool']) for (const receipt of [{ state: 'unknown' }, { state: 'failed', code: 'safe-fixture-failure' }]) {
    const f = fixture({ text: '通知所有管理员和小林开会', receipt })
    const result = await f.execute(name, name === 'mentionMembersTool' ? { targets: ['小林'], message: '开会' } : { message: '开会' })
    assert.equal(result.status, receipt.state === 'unknown' ? 'unknown' : 'failed')
    assert.equal(f.sends.length, 1)
    assert.deepEqual(f.otherSends, [])
    assert.deepEqual(f.reads, [])
    if (receipt.state === 'unknown') assert.match(resultData(result).message, /不要.*重发/u)
    assert.equal(resultData(result).success, receipt.state === 'failed' ? false : undefined)
  }
})

test('a longer full name in the actual request cannot authorize querying or notifying a different member with its shorter prefix', async t => {
  const shorter = member('324157', '小明', 'member', { nickname: '小明', conversationName: '小明' })
  const longer = member('324158', '小明同学', 'member', { nickname: '小明同学', conversationName: '小明同学' })
  await t.test('member query rejects or corrects the model-selected shorter nickname', async () => {
    const f = fixture({ members: [shorter, longer], text: '查一下小明同学的资料' })
    const result = await f.execute('memberInfoTool', { nickname: '小明' })
    assert.ok(!f.reads.includes(shorter.user.id), 'the shorter full-name member is a different person and has no request authority')
    assert.ok(f.reads.every(id => id === longer.user.id), 'only the actual longer-name subject may have details read')
    assert.ok(!result.content.includes(`仅此人的头衔-${shorter.user.id}`), 'the wrong person’s private details never leave the reader')
    assert.deepEqual(f.sends, [])
    assert.deepEqual(f.otherSends, [])
  })
  await t.test('member notification rejects or corrects the model-selected shorter target', async () => {
    const f = fixture({ members: [shorter, longer], text: '通知小明同学开会' })
    await f.execute('mentionMembersTool', { targets: ['小明'], message: '开会' })
    assert.ok(f.sends.every(message => message.mentionUserIds.every(id => id === longer.user.id)), 'short-name substring grounding must not notify the other member')
    assert.deepEqual(f.reads, [])
    assert.deepEqual(f.otherSends, [])
  })
})

test('explicit denial and discussion never authorize member details or notifications even with valid target evidence', async t => {
  const cases = [
    { name: 'memberInfoTool', text: '不要查询这位的成员资料', mentions: [lin.user.id], input: { user_id: lin.user.id } },
    { name: 'memberInfoTool', text: '只是在讨论小林的成员资料，不用查询', input: { nickname: '小林' } },
    { name: 'mentionMembersTool', text: '不要通知小林', input: { targets: ['小林'], message: '模型自行补的通知' } },
    { name: 'mentionMembersTool', text: '别艾特小林，只是在讨论小林', mentions: [lin.user.id], input: { targets: [lin.user.id], message: '模型自行补的通知' } },
    { name: 'mentionAdminsTool', text: '不要通知所有管理员', input: { message: '模型自行补的通知' } },
    { name: 'mentionAdminsTool', text: '这只是举例：通知所有管理员', input: { message: '模型自行补的通知' } },
  ]
  for (const entry of cases) await t.test(`${entry.name}: ${entry.text}`, async () => {
    const f = fixture(entry)
    const result = await f.execute(entry.name, entry.input)
    assert.deepEqual(f.reads, [], 'a referenced real member does not override denial or quoted/discussed intent')
    assert.deepEqual(f.sends, [], 'denied or discussed notifications never cross the send boundary')
    assert.deepEqual(f.otherSends, [])
    assert.equal(result.status, 'failed')
    assert.doesNotMatch(result.content, /仅此人的头衔/u)
  })
})

test('an explicit instruction not to notify the owner overrides the model includeOwner flag for an administrator collection', async () => {
  const f = fixture({ text: '通知所有管理员，不要通知群主' })
  const result = await f.execute('mentionAdminsTool', { includeOwner: true, message: '开会' })
  assert.deepEqual(f.sends, [], 'a model flag must not add the expressly excluded owner to the notification')
  assert.deepEqual(f.reads, [])
  assert.deepEqual(f.otherSends, [])
  assert.equal(result.status, 'failed')
})
