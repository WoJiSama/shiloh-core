import assert from 'node:assert/strict'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const { createAgentHistory } = await load('modules/memory/infrastructure/agentHistory.js')
const { agentHistoryId, createAgentHistoryStore } = await load('modules/memory/infrastructure/agentHistoryStore.js')
const { createPersonMemoryStore } = await load('modules/memory/infrastructure/personMemoryStore.js')
const { personMemoryAddress } = await load('modules/memory/infrastructure/personMemoryContext.js')
const { agentBindingToken, agentPersonaScopeId, conversationAddressKey } = await load('modules/runtime/domain/agentBindings.js')
const redisTest = { skip: !redisAvailable, timeout: 20000 }
const DAY = 86400000
const target = { account: { platform: 'fixture', namespace: 'style-history', id: 'bot-a' }, kind: 'group', id: 'group-a' }

async function fixture(t, config = {}) {
  const redis = await createAgentRedisFixture(t, 'agent-style-history')
  const state = { config: { enabled: true, ...config }, at: 1800000000000, online: true, running: true, recalled: new Set(), reads: [], writes: 0,
    begin: 0, released: 0, afterRead: undefined, beforeBegin: undefined }
  const binding = { source: 'configured', id: 'binding-a', revision: 'revision-a', agentId: 'writer', personaId: 'shared-template', connectionId: 'connection-a', target: structuredClone(target) }
  const bindings = new Map([[conversationAddressKey(target), binding]])
  const storage = { ...redis.storage, async eval(script, input) {
    const result = await redis.storage.eval(script, input)
    if (script.startsWith("return {redis.call('GET'")) {
      state.reads.push(input.keys[1])
      await state.afterRead?.(input.keys[1], result)
    } else state.writes++
    return result
  } }
  const store = createAgentHistoryStore(storage), memory = createPersonMemoryStore({ redis: redis.storage, now: () => state.at })
  const subject = (userId = 'person-a') => ({ identity: { botId: personMemoryAddress(target).botId, personaId: agentPersonaScopeId(binding.agentId) }, subjectId: userId })
  const composer = createAgentHistory({ redis: storage, memory, config: () => state.config, now: () => state.at,
    resolve: room => { const found = bindings.get(conversationAddressKey(room)); return found && { binding: found } },
    available: () => state.online, privatePeer: () => 'person-a', isRunning: () => state.running && redis.isCurrent(),
    isRecalled: async (_room, id) => state.recalled.has(id), allowsText: text => !text.includes('blocked-source'), logger: { warn() {} },
    async begin(captured) {
      await state.beforeBegin?.()
      state.begin++
      let released = false
      return { signal: new AbortController().signal,
        isCurrent: () => state.running && redis.isCurrent() && agentBindingToken(bindings.get(conversationAddressKey(captured.target))) === agentBindingToken(captured),
        release() { if (!released) { released = true; state.released++ } } }
    },
  })
  t.after(() => composer.stop())
  let serial = 0
  const row = (text, input = {}) => ({ messageId: `message-${++serial}`, authorId: 'person-a', name: '', text, at: state.at, ...input })
  async function seed(rows, selected = binding) {
    await store.update(agentHistoryId(selected), () => ({ version: 1, id: agentHistoryId(selected), scope: { agentId: selected.agentId, target: structuredClone(selected.target) }, rows }))
  }
  return { ...redis, state, binding, bindings, composer, memory, store, subject, row, seed,
    read(days = 7, guard = () => true, signal) { return composer.readStyleSources(binding, days, guard, signal) } }
}

test('style sources are scoped retained human originals, with bounded text and no derived writes', redisTest, async t => {
  const f = await fixture(t)
  const valid = f.row('😀'.repeat(200)), other = f.row('另一个真人', { authorId: 'person-b' })
  const recalled = f.row('已撤回'), privateRow = f.row('非法私聊元数据', { peerId: 'person-a' })
  await f.seed([valid, other, f.row('机器人输出', { authorId: target.account.id }), f.row('#删除记忆'), f.row('.r 1d6'), f.row('/command'),
    f.row('!command'), f.row('[CQ:forward,id=one]'), f.row('blocked-source'), recalled, f.row('不在窗口', { at: f.state.at - 8 * DAY }), f.row('未来原话', { at: f.state.at + 1 })])
  f.state.recalled.add(recalled.messageId)
  const foreign = { ...f.binding, target: { ...target, account: { ...target.account, id: 'bot-b' } } }
  const otherAgent = { ...f.binding, agentId: 'other-writer' }
  const otherGroup = { ...f.binding, target: { ...target, id: 'group-b' } }
  for (const selected of [foreign, otherAgent, otherGroup]) await f.seed([f.row('其他分区原话')], selected)
  const beforeWrites = f.state.writes
  f.state.reads = []
  const sources = await f.read()
  assert.deepEqual(sources.messages, [{ userId: 'person-a', text: '😀'.repeat(160) }, { userId: 'person-b', text: other.text }])
  assert.equal(await sources.isCurrent(), true)
  assert.ok(f.state.reads.every(key => key.endsWith(agentHistoryId(f.binding))))
  assert.equal(f.state.writes, beforeWrites)
  assert.equal(f.state.begin, f.state.released)
  // Group history rejects private metadata at the owning parser, rather than guessing its origin.
  await assert.rejects(f.seed([privateRow]), /历史来源存储/)
})

test('style reads require opt-in history, a current online configured group and a valid 1-14 day window', redisTest, async t => {
  const f = await fixture(t, { enabled: false })
  await f.seed([f.row('不得读取')])
  f.state.reads = []
  let sources = await f.read()
  assert.deepEqual(sources.messages, [])
  assert.equal(await sources.isCurrent(), false)
  assert.equal(f.state.begin, 0)
  f.state.config.enabled = true
  for (const days of [0, 15, 1.5, NaN]) assert.deepEqual((await f.read(days)).messages, [])
  for (const selected of [{ ...f.binding, source: 'legacy' }, { ...f.binding, target: { ...target, kind: 'private' } }, { ...f.binding, revision: 'stale' }]) {
    sources = await f.composer.readStyleSources(selected, 7, () => true)
    assert.deepEqual(sources.messages, [])
    assert.equal(await sources.isCurrent(), false)
  }
  f.state.online = false
  assert.deepEqual((await f.read()).messages, [])
  f.state.online = true
  f.state.running = false
  assert.deepEqual((await f.read()).messages, [])
  assert.deepEqual(f.state.reads, [])
  assert.equal(f.state.writes, 1)
})

test('style windows and row caps remain constrained by the existing retention policy', redisTest, async t => {
  const f = await fixture(t, { retentionDays: 1, maxMessagesPerConversation: 50 })
  await f.seed([f.row('两天前', { at: f.state.at - 2 * DAY }), ...Array.from({ length: 70 }, (_, index) => f.row(`消息${index}`))])
  const sources = await f.read(14)
  assert.equal(sources.messages.length, 50)
  assert.equal(sources.messages[0].text, '消息20')
  assert.equal(await sources.isCurrent(), true)
  f.state.at += 2 * DAY
  assert.equal(await sources.isCurrent(), false)
})

test('same binding token from a resolver cannot substitute another complete account or group', redisTest, async t => {
  const f = await fixture(t)
  await f.seed([f.row('原会话')])
  for (const changed of [{ ...target, id: 'other-group' }, { ...target, account: { ...target.account, id: 'other-account' } }]) {
    const sources = await f.read()
    assert.equal(sources.messages.length, 1)
    f.bindings.set(conversationAddressKey(target), { ...f.binding, target: changed })
    assert.equal(await sources.isCurrent(), false)
    f.bindings.set(conversationAddressKey(target), f.binding)
    assert.equal(await sources.isCurrent(), false)
  }
})

test('privacy changes, recalls and invalidation permanently revoke prior style evidence', redisTest, async t => {
  const f = await fixture(t)
  const original = f.row('有来源的口头禅')
  await f.seed([original])
  let sources = await f.read()
  f.state.recalled.add(original.messageId)
  assert.equal(await sources.isCurrent(), false)
  f.state.recalled.clear()
  assert.equal(await sources.isCurrent(), false)
  sources = await f.read()
  await f.memory.setEnabled({ ...f.subject(), enabled: false })
  await f.memory.setEnabled({ ...f.subject(), enabled: true })
  assert.equal(await sources.isCurrent(), false)
  sources = await f.read()
  assert.equal(await sources.isCurrent(), true)
  f.composer.invalidate(target)
  assert.equal(await sources.isCurrent(), false)
})

test('person and scene erasure exclude old originals before any style extraction', redisTest, async t => {
  const f = await fixture(t)
  const one = f.row('应删除的来源'), two = f.row('其他人的原话', { authorId: 'person-b' })
  await f.seed([one, two])
  await f.memory.revokeSource({ identity: f.subject().identity, scene: personMemoryAddress(target).scene, messageId: one.messageId })
  assert.deepEqual((await f.read()).messages, [{ userId: two.authorId, text: two.text }])
  await f.memory.forgetScene({ identity: f.subject().identity, scene: personMemoryAddress(target).scene, before: f.state.at })
  assert.deepEqual((await f.read()).messages, [])
})

test('changed or deleted stored originals invalidate a returned result while unrelated new rows do not', redisTest, async t => {
  const f = await fixture(t), original = f.row('原始发言')
  await f.seed([original])
  const sources = await f.read()
  await f.store.update(agentHistoryId(f.binding), saved => ({ ...saved, rows: [...saved.rows, f.row('新发言')] }))
  assert.equal(await sources.isCurrent(), true)
  await f.store.update(agentHistoryId(f.binding), saved => ({ ...saved, rows: saved.rows.filter(row => row.messageId !== original.messageId) }))
  assert.equal(await sources.isCurrent(), false)
  // Reusing the same message ID with altered text cannot revive the old observation.
  await f.store.update(agentHistoryId(f.binding), saved => ({ ...saved, rows: [...saved.rows, { ...original, text: '替换文字' }] }))
  assert.equal(await sources.isCurrent(), false)
})

test('a source removed during the first read yields no usable style result', redisTest, async t => {
  const f = await fixture(t), original = f.row('读取期间删除')
  await f.seed([original])
  let intercepted = false
  f.state.afterRead = async () => {
    if (intercepted) return
    intercepted = true
    await f.store.update(agentHistoryId(f.binding), saved => ({ ...saved, rows: [] }))
  }
  const sources = await f.read()
  assert.deepEqual(sources.messages, [])
  assert.equal(await sources.isCurrent(), false)
  assert.equal(f.state.begin, f.state.released)
})

test('signals, caller guards and stop revoke projections and release each acquired lifecycle', redisTest, async t => {
  const f = await fixture(t)
  await f.seed([f.row('取消测试')])
  let allowed = true
  const controller = new AbortController(), sources = await f.read(7, () => allowed, controller.signal)
  assert.equal(await sources.isCurrent(), true)
  controller.abort()
  assert.equal(await sources.isCurrent(), false)
  const guarded = await f.read(7, () => allowed)
  allowed = false
  assert.equal(await guarded.isCurrent(), false)
  allowed = true
  assert.equal(await guarded.isCurrent(), false)
  const stopped = await f.read()
  await f.composer.stop()
  assert.equal(await stopped.isCurrent(), false)
  assert.equal(f.state.begin, f.state.released)
})

test('forwarded capture cannot become a source and private background history never opens', redisTest, async t => {
  const f = await fixture(t)
  await f.composer.capture({ version: 1, conversation: target, sender: { ...target.account, id: 'person-a' }, senderName: 'person-a',
    messageId: 'forward-one', occurredAt: f.state.at, text: '转发文本', parts: [{ kind: 'text', text: '转发文本' }, { kind: 'forward', id: 'forward' }],
    mentions: [], directedToAccount: false }, f.binding, () => true)
  assert.equal(await f.store.read(agentHistoryId(f.binding)), undefined)
  const privateBinding = { ...f.binding, target: { ...target, kind: 'private', id: 'person-a' } }
  f.bindings.set(conversationAddressKey(privateBinding.target), privateBinding)
  await f.seed([f.row('私聊原文', { peerId: 'person-a' })], privateBinding)
  f.state.reads = []
  const sources = await f.composer.readStyleSources(privateBinding, 7, () => true)
  assert.deepEqual(sources.messages, [])
  assert.equal(await sources.isCurrent(), false)
  assert.deepEqual(f.state.reads, [])
})
