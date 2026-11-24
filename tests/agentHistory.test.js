import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentHistory } from '../dist/backend/modules/memory/infrastructure/agentHistory.js'
import { agentHistoryId, createAgentHistoryStore } from '../dist/backend/modules/memory/infrastructure/agentHistoryStore.js'
import { createPersonMemoryStore } from '../dist/backend/modules/memory/infrastructure/personMemoryStore.js'
import { personMemoryAddress } from '../dist/backend/modules/memory/infrastructure/personMemoryContext.js'
import { agentBindingToken, agentPersonaScopeId, conversationAddressKey } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const redisTest = { skip: !redisAvailable, timeout: 20_000 }
const DAY = 86_400_000
const account = { platform: 'fixture', namespace: 'history', id: 'account-a' }
const peer = { ...account, id: 'person-a' }
const other = { ...account, id: 'person-b' }
const group = { account, kind: 'group', id: 'group-a' }
const groupB = { ...group, id: 'group-b' }
const privateRoom = { account, kind: 'private', id: 'opaque-private-room' }
const foreign = { ...group, account: { ...account, id: 'foreign-account' } }
const otherAgent = { ...group, id: 'other-agent-room' }

async function fixture(t, options = {}) {
  const redis = await createAgentRedisFixture(t, 'agent-explicit-history')
  const clock = { at: Date.parse('2026-11-15T12:00:00+08:00') }
  const bindings = new Map(), unavailable = new Set(), recalled = new Set(), authorized = new Set()
  const calls = { authorized: [], bodyReads: [], acquired: 0, released: 0, diagnostics: [] }
  const behavior = { authorize: undefined, afterRead: undefined, begin: undefined }
  const config = { enabled: true, timeoutMs: 5000, ...options.config }
  const memory = createPersonMemoryStore({ redis: redis.storage, now: () => clock.at })
  const storage = { ...redis.storage, async eval(script, input) {
    const result = await redis.storage.eval(script, input)
    if (script.startsWith("return {redis.call('GET'")) {
      calls.bodyReads.push(input.keys[1])
      await behavior.afterRead?.(input.keys[1], result)
    }
    return result
  } }
  const store = createAgentHistoryStore(storage)
  let composer, serial = 0, revision = 0
  const services = []
  t.after(async () => { await Promise.all(services.map(service => service.stop())) })
  const f = {
    ...redis, config, clock, memory, store, calls, behavior, authorized,
    get composer() { return composer },
    binding: target => bindings.get(conversationAddressKey(target)),
    bind(target = group, agentId = 'writer') {
      const binding = { target: structuredClone(target), agentId, source: 'configured', personaId: 'persona', connectionId: 'connection-a',
        revision: `revision-${++revision}`, id: conversationAddressKey(target) }
      bindings.set(conversationAddressKey(target), binding)
      return binding
    },
    subject(target = group, author = peer) {
      const { botId, scene } = personMemoryAddress(target, target.kind === 'private' ? peer.id : undefined)
      return { identity: { botId, personaId: agentPersonaScopeId(f.binding(target).agentId) }, scene, subjectId: author.id }
    },
    recall(target, id) { recalled.add(JSON.stringify([conversationAddressKey(target), id])) },
    unavailable(target) { unavailable.add(conversationAddressKey(target)) },
    state(target = group) { return store.read(agentHistoryId(f.binding(target))) },
    source(text = '查询聊天历史', input = {}) {
      return { messageId: `request-${++serial}`, authorId: peer.id, text, at: clock.at, mentions: [], ...input }
    },
    async capture(text, input = {}) {
      const target = input.target ?? group, author = input.author ?? peer
      const incoming = { version: 1, conversation: target, sender: author, senderName: author.id,
        messageId: input.messageId ?? `message-${++serial}`, occurredAt: input.at ?? clock.at, text,
        parts: [{ kind: 'text', text }], mentions: [], directedToAccount: false, ...input.message }
      await composer.capture(incoming, input.binding ?? f.binding(target), input.guard ?? (() => true))
      return incoming
    },
    async read(input = {}, options = {}) {
      const target = options.target ?? group
      const recall = await composer.read(options.binding ?? f.binding(target), { question: '查询历史', keywords: [], ...input },
        options.source ?? f.source(), options.guard ?? (() => true), options.signal)
      return { recall, result: JSON.parse(recall.text) }
    },
    async remember(text, input = {}) {
      const target = input.target ?? group, author = input.author ?? peer
      const saved = await memory.remember({ ...f.subject(target, author), text, category: input.category ?? 'interest', evidenceKind: 'self', sensitivity: 'ordinary',
        portable: input.portable ?? false, source: { scene: f.subject(target, author).scene, authorId: author.id,
          messageId: input.messageId ?? `memory-source-${++serial}`, at: input.at ?? clock.at, excerpt: input.excerpt ?? text } })
      assert.equal(saved.saved, true)
      return saved.entry
    },
    async restart() {
      await composer?.stop()
      composer = createAgentHistory({ redis: storage, memory, config: () => config, now: () => clock.at,
        resolve: target => { const binding = f.binding(target); return binding ? { binding } : undefined },
        available: target => !unavailable.has(conversationAddressKey(target)),
        privatePeer: target => target.kind === 'private' ? peer.id : undefined,
        isRecalled: async (target, id) => recalled.has(JSON.stringify([conversationAddressKey(target), id])),
        isRunning: redis.isCurrent, allowsText: text => !text.includes('blocked-source'), logger: { warn() {} },
        diagnostics: { emit: event => calls.diagnostics.push(event) },
        async begin(binding) {
          await behavior.begin?.(binding)
          calls.acquired++
          const controller = new AbortController()
          let released = false
          return { signal: controller.signal, isCurrent: () => !controller.signal.aborted && redis.isCurrent() && agentBindingToken(f.binding(binding.target)) === agentBindingToken(binding),
            release() { if (!released) { released = true; calls.released++ } } }
        },
        async authorizePrivateSource(viewer, source, subjectId, context) {
          calls.authorized.push({ viewer, source, subjectId, context })
          if (behavior.authorize) return behavior.authorize(viewer, source, subjectId, context)
          return authorized.has(conversationAddressKey(source.target)) && context.isCurrent()
        },
      })
      services.push(composer)
    },
  }
  for (const target of [group, groupB, privateRoom, foreign, otherAgent]) {
    f.bind(target, target === otherAgent ? 'other-writer' : 'writer')
    if (target.kind === 'group') authorized.add(conversationAddressKey(target))
  }
  await f.restart()
  return f
}

test('history is explicitly opt-in and never imports an embedding backend or legacy cache', redisTest, async t => {
  const f = await fixture(t, { config: { enabled: false } })
  await f.capture('未启用时不得归档')
  assert.equal(await f.state(), undefined)
  assert.equal((await f.read({ source: 'recent' })).result.status, 'unavailable')
  f.config.enabled = true
  await f.capture('启用后保存')
  assert.equal((await f.state()).rows[0].text, '启用后保存')
  assert.equal((await f.read({ source: 'recent' })).result.status, 'found')
})

test('capture attributes only text parts and rejects forwarded, wrong namespace and mismatched private senders', redisTest, async t => {
  const f = await fixture(t)
  await f.capture('描述不应被归入本人原话', { message: { parts: [{ kind: 'image', resource: { kind: 'url', value: 'https://example.org/pic' } }] } })
  await f.capture('保留原话', { message: { text: '附件描述和引用', parts: [{ kind: 'text', text: '保留原话' }] } })
  await f.capture('转发不能冒名', { message: { parts: [{ kind: 'text', text: '转发不能冒名' }, { kind: 'forward', id: 'forward-a' }] } })
  await f.capture('错误命名空间', { author: { ...peer, namespace: 'wrong' } })
  await f.capture('不是本人', { target: privateRoom, author: other })
  assert.deepEqual((await f.state()).rows.map(row => row.text), ['保留原话'])
  assert.equal(await f.state(privateRoom), undefined)
})

test('group recent includes all current-group authors, excludes the current request and survives reconstruction', redisTest, async t => {
  const f = await fixture(t)
  const a = await f.capture('本人原话')
  const b = await f.capture('其他群友的发言', { author: other })
  await f.capture('另一个群', { target: groupB })
  const request = f.source('查看大家刚才在聊什么', { messageId: a.messageId })
  await f.restart()
  const { result, recall } = await f.read({ source: 'recent' }, { source: request })
  assert.deepEqual(result.messages.map(item => item.message_id), [b.messageId])
  assert.equal(result.query.user_id, null)
  assert.equal(result.complete_history, false)
  assert.equal(await recall.isCurrent(), true)
})

test('model question and invented IDs cannot grant another identity; raw explicit ID, same-account mention and verified reply can', redisTest, async t => {
  const f = await fixture(t)
  await f.capture('目标原话', { author: other })
  const input = { source: 'recent', user_id: other.id, question: `查询 ${other.id}` }
  assert.equal((await f.read(input, { source: f.source('查询本人历史') })).result.status, 'unauthorized')
  for (const source of [f.source(`查用户号${other.id}的历史`), f.source('查这个人的历史', { mentions: [other] }), f.source('查引用者', { replyAuthor: other })]) {
    const { result } = await f.read(input, { source })
    assert.equal(result.status, 'found')
    assert.equal(result.messages[0].user_id, other.id)
  }
  assert.equal((await f.read(input, { source: f.source('查这个人', { mentions: [{ ...other, namespace: 'wrong' }] }) })).result.status, 'unauthorized')
  assert.equal((await f.read(input, { target: privateRoom, source: f.source(`查询 ${other.id}`) })).result.status, 'unauthorized')
  assert.equal((await f.read({ source: 'recent' }, { source: f.source('查他之前说的话') })).result.status, 'needs_clarification')
})

test('query validation rejects unknown fields, malformed dates, clocks without zones and invalid pagination', redisTest, async t => {
  const f = await fixture(t)
  for (const input of [{ extra: true }, { question: '' }, { start_time: '2026-02-30' }, { start_time: '2026-11-15T12:00:00' },
    { start_time: '2026-11-16', end_time: '2026-11-15' }, { limit: 51 }, { limit: 1.5 }, { offset: -1 }, { offset: 100001 },
    { keywords: 'word' }, { keywords: Array(21).fill('keyword') }, { keywords: ['a'.repeat(101)] }, { keywords: Array(1) }, { memory_ids: Array(1) },
    { memory_ids: [''] }, { memory_ids: ['real'], source: 'recent' }, { source: 'legacy' }]) {
    assert.equal((await f.read(input)).result.status, 'invalid_query', JSON.stringify(input))
  }
  assert.equal((await f.read({ source: 'archive' })).result.status, 'unauthorized')
  assert.equal((await f.read({ source: 'recent', start_time: '', end_time: '', keywords: Array(20).fill('a'.repeat(100)) })).result.status, 'not_found')
  assert.equal((await f.read({ source: 'recent', start_time: '2026-11-14T10:20:30.123456+08:00' })).result.status, 'not_found')
  await f.capture('抱石兴趣')
  assert.equal((await f.read({ source: 'recent', keywords: ['  ', '抱石'] })).result.status, 'found')
})

test('inclusive Beijing calendar days and per-source pagination preserve reachable matching evidence', redisTest, async t => {
  const f = await fixture(t)
  const times = ['2026-11-13T23:59:59.999+08:00', '2026-11-14T00:00:00+08:00', '2026-11-14T23:59:59.999+08:00', '2026-11-15T00:00:00+08:00']
  const rows = []
  for (const at of times) rows.push(await f.capture('日历测试', { at: Date.parse(at) }))
  const input = { source: 'recent', start_time: '2026-11-14', end_time: '2026-11-14', limit: 1 }
  const first = (await f.read(input)).result
  assert.equal(first.messages[0].message_id, rows[2].messageId)
  assert.equal(first.next_offsets.recent, 1)
  const second = (await f.read({ ...input, offset: first.next_offsets.recent })).result
  assert.equal(second.messages[0].message_id, rows[1].messageId)
  assert.equal(second.next_offsets.recent, undefined)
})

test('recent is at most sixty messages, raw retention is bounded, and returned JSON and individual originals are bounded', redisTest, async t => {
  const f = await fixture(t, { config: { maxMessagesPerConversation: 60, retentionDays: 1 } })
  await f.capture('过期原话', { at: f.clock.at - 2 * DAY })
  for (let index = 0; index < 64; index++) await f.capture(`${index}:` + '长原文'.repeat(1100))
  assert.equal((await f.state()).rows.length, 60)
  const { result, recall } = await f.read({ source: 'recent', limit: 50 })
  assert.ok(recall.text.length <= 16000)
  assert.ok(result.messages.length > 0 && result.messages.length < 50)
  assert.ok(result.messages.every(item => item.content.length <= 2000 && item.content_truncated))
  assert.ok(result.truncated)
  assert.ok(result.budget_truncated)
  assert.ok(result.next_offsets.recent < 50)
  const seen = new Set(result.messages.map(item => item.message_id))
  let offset = result.next_offsets.recent
  while (offset !== undefined) {
    const page = (await f.read({ source: 'recent', limit: 50, offset })).result
    for (const item of page.messages) seen.add(item.message_id)
    assert.ok(page.next_offsets.recent === undefined || page.next_offsets.recent > offset)
    offset = page.next_offsets.recent
  }
  assert.equal(seen.size, 60)
  f.clock.at += 2 * DAY
  await f.composer.tick()
  assert.equal((await f.state()).rows.length, 0)
  assert.equal((await f.read({ source: 'recent' })).result.status, 'not_found')
})

test('private archive reads only authorized same-account same-agent scopes and only the real peer originals', redisTest, async t => {
  const f = await fixture(t)
  const own = await f.capture('授权群本人原话')
  await f.capture('授权群他人原话', { author: other })
  await f.capture('未授权群本人原话', { target: groupB })
  await f.capture('其他账号本人原话', { target: foreign, author: { ...peer, id: peer.id } })
  await f.capture('其他角色本人原话', { target: otherAgent })
  f.authorized.delete(conversationAddressKey(groupB))
  f.calls.bodyReads.length = 0
  const { result, recall } = await f.read({ source: 'archive' }, { target: privateRoom })
  assert.deepEqual(result.messages.map(item => item.message_id), [own.messageId])
  for (const target of [groupB, foreign, otherAgent]) assert.ok(!f.calls.bodyReads.some(key => key.endsWith(agentHistoryId(f.binding(target)))))
  assert.equal(await recall.isCurrent(), true)
  assert.ok(f.calls.authorized.length >= 3)
})

test('archive projection reauthorizes current platform membership, current source binding and recall before each use', redisTest, async t => {
  const f = await fixture(t)
  const original = await f.capture('新鲜授权证据')
  const first = await f.read({ source: 'archive' }, { target: privateRoom })
  assert.equal(first.result.status, 'found')
  f.authorized.delete(conversationAddressKey(group))
  assert.equal(await first.recall.isCurrent(), false)
  f.authorized.add(conversationAddressKey(group))
  const second = await f.read({ source: 'archive' }, { target: privateRoom })
  f.bind(group)
  assert.equal(await second.recall.isCurrent(), false)
  const third = await f.read({ source: 'archive' }, { target: privateRoom })
  f.recall(group, original.messageId)
  assert.equal(await third.recall.isCurrent(), false)
  assert.equal((await f.read({ source: 'archive' }, { target: privateRoom })).result.status, 'not_found')
})

test('request recall, source opt-out, excerpt erasure and source removal invalidate already returned raw evidence', redisTest, async t => {
  const f = await fixture(t)
  const original = await f.capture('原话包含想忘掉的片段')
  const source = f.source()
  const first = await f.read({ source: 'recent' }, { source })
  f.recall(group, source.messageId)
  assert.equal(await first.recall.isCurrent(), false)
  const second = await f.read({ source: 'recent' })
  await f.memory.setEnabled({ ...f.subject(), enabled: false })
  assert.equal(await second.recall.isCurrent(), false)
  await f.memory.setEnabled({ ...f.subject(), enabled: true })
  f.clock.at++
  const newer = await f.capture(original.text)
  const third = await f.read({ source: 'recent' })
  const entry = await f.remember('想忘掉的片段', { messageId: newer.messageId, excerpt: '想忘掉的片段' })
  await f.memory.forget({ ...f.subject(), id: entry.id, before: f.clock.at })
  assert.equal(await third.recall.isCurrent(), false)
  assert.equal((await f.read({ source: 'recent' })).result.status, 'not_found')
})

test('a source deletion during authorized archive IO cannot escape the final fresh projection', redisTest, async t => {
  const f = await fixture(t)
  const original = await f.capture('读取期间被撤回')
  const key = agentHistoryId(f.binding(group))
  f.behavior.afterRead = async stateKey => {
    if (!stateKey.endsWith(key)) return
    f.behavior.afterRead = undefined
    await f.memory.revokeSource({ ...f.subject(), messageId: original.messageId })
  }
  const { result } = await f.read({ source: 'archive' }, { target: privateRoom })
  assert.equal(result.status, 'not_found')
  assert.deepEqual(result.messages, [])
})

test('long-term self facts remain readable after raw expiry; private cross-group facts still need fresh authorization', redisTest, async t => {
  const f = await fixture(t, { config: { retentionDays: 1 } })
  const original = await f.capture('喜欢手工票根')
  const entry = await f.remember('喜欢收集票根', { messageId: original.messageId, excerpt: original.text })
  f.clock.at += 2 * DAY
  await f.composer.tick()
  assert.deepEqual((await f.state()).rows, [])
  const { result, recall } = await f.read({ source: 'memory' }, { target: privateRoom })
  assert.equal(result.messages.length, 0)
  assert.equal(result.memories[0].id, entry.id)
  assert.equal(result.coverage.memory.original_source_retention_required, false)
  assert.equal(await recall.isCurrent(), true)
  f.authorized.delete(conversationAddressKey(group))
  assert.equal(await recall.isCurrent(), false)
})

test('portable facts hide other-group provenance even on ID detail reads; local private facts and invented IDs stay scoped', redisTest, async t => {
  const f = await fixture(t)
  const portable = await f.remember('喜欢纸质车票', { target: groupB, portable: true })
  await f.remember('不应跨群公开的事实', { target: groupB, category: 'fact', portable: false })
  const listing = (await f.read({ source: 'memory' })).result
  assert.deepEqual(listing.memories.map(item => item.id), [portable.id])
  assert.equal(listing.memories[0].source, undefined)
  const detail = (await f.read({ memory_ids: [portable.id] })).result
  assert.equal(detail.memories[0].source, undefined)
  assert.equal((await f.read({ memory_ids: ['invented-id'] })).result.status, 'not_found')
  const local = await f.remember('本人私聊记忆', { target: privateRoom, category: 'fact' })
  const personal = (await f.read({ memory_ids: [local.id] }, { target: privateRoom })).result
  assert.equal(personal.memories[0].id, local.id)
  assert.equal(personal.memories[0].source.scene.kind, 'private')
})

test('memory projections rehydrate details after return and apply fresh forgetting without requiring original corpus', redisTest, async t => {
  const f = await fixture(t)
  const entry = await f.remember('兴趣的长期事实')
  const { result, recall } = await f.read({ memory_ids: [entry.id] })
  assert.equal(result.status, 'found')
  await f.memory.forget({ ...f.subject(), id: entry.id })
  assert.equal(await recall.isCurrent(), false)
  assert.equal((await f.read({ memory_ids: [entry.id] })).result.status, 'not_found')
})

test('completed tool read cancellation does not poison subsequent projection checks, which reacquire and release privacy turns', redisTest, async t => {
  const f = await fixture(t)
  await f.capture('临时读取的证据')
  const controller = new AbortController()
  const { result, recall } = await f.read({ source: 'recent' }, { signal: controller.signal })
  assert.equal(result.status, 'found')
  const before = f.calls.acquired
  controller.abort()
  assert.equal(await recall.isCurrent(), true)
  assert.ok(f.calls.acquired > before)
  assert.equal(f.calls.acquired, f.calls.released)
})

test('in-flight source invalidation and timeouts terminate bounded reads and release late-acquired privacy turns', redisTest, async t => {
  const f = await fixture(t, { config: { timeoutMs: 100 } })
  await f.capture('有界超时证据')
  let release
  const waiting = new Promise(resolve => { release = resolve })
  f.behavior.authorize = async () => { await waiting; return true }
  const started = Date.now()
  const pending = f.read({ source: 'archive' }, { target: privateRoom })
  await delay(20)
  f.composer.invalidate(group)
  const { result } = await pending
  assert.equal(result.status, 'unavailable')
  assert.ok(Date.now() - started < 1500)
  release()
  f.behavior.authorize = undefined
  f.behavior.begin = () => delay(200)
  const late = await f.read({ source: 'recent' })
  assert.equal(late.result.status, 'unavailable')
  await delay(250)
  assert.equal(f.calls.acquired, f.calls.released)
})

test('a capture timeout identifies a pending authorization acquisition and releases it when it arrives', redisTest, async t => {
  const f = await fixture(t, { config: { timeoutMs: 100 } })
  let open
  const held = new Promise(resolve => { open = resolve })
  f.behavior.begin = () => held
  try {
    await f.capture('未授权的原文')
    assert.equal(await f.state(), undefined)
    const [event] = f.calls.diagnostics
    assert.equal(event.code, 'history_source_timeout')
    assert.deepEqual(event.details, { step: 'acquire', result: 'not_saved', limit: 100 })
  } finally { open() }
  f.behavior.begin = undefined
  await f.capture('另一次成功的原文')
  assert.equal((await f.state()).rows.length, 1)
  assert.equal(f.calls.acquired, f.calls.released)
})

test('history store rejects corrupt scopes and source rewrites rather than accepting a legacy or changed original', redisTest, async t => {
  const f = await fixture(t)
  await f.capture('不可变的来源')
  const id = agentHistoryId(f.binding(group))
  await assert.rejects(f.store.update(id, state => ({ ...state, rows: state.rows.map(row => ({ ...row, text: '悄悄改写' })) })))
  assert.equal((await f.state()).rows[0].text, '不可变的来源')
  await f.storage.set(`agent:history:v1:state:${id}`, JSON.stringify({ ...(await f.state()), scope: { agentId: 'foreign-agent', target: group } }))
  assert.equal((await f.read({ source: 'recent' })).result.status, 'unavailable')
})

test('cleanup physically expires offline and previously bound agents without requiring readable source authorization', redisTest, async t => {
  const f = await fixture(t, { config: { retentionDays: 1 } })
  await f.capture('旧角色原文', { target: otherAgent })
  const oldId = agentHistoryId(f.binding(otherAgent))
  await f.capture('离线群原文', { target: groupB })
  f.bind(otherAgent, 'new-owner')
  f.unavailable(groupB)
  f.clock.at += 2 * DAY
  await f.composer.tick()
  assert.deepEqual((await f.store.read(oldId)).rows, [])
  assert.deepEqual((await f.state(groupB)).rows, [])
})

test('equal message IDs in another authorized group do not exclude its original as the current private request', redisTest, async t => {
  const f = await fixture(t)
  const original = await f.capture('另一场景相同ID', { messageId: 'same-message-id' })
  const { result } = await f.read({ source: 'archive' }, { target: privateRoom, source: f.source('查询历史', { messageId: 'same-message-id' }) })
  assert.deepEqual(result.messages.map(item => item.message_id), [original.messageId])
})

test('a denied group binding does not enter a selected evidence projection', redisTest, async t => {
  const f = await fixture(t)
  await f.capture('已授权来源')
  await f.capture('拒绝的来源', { target: groupB })
  f.authorized.delete(conversationAddressKey(groupB))
  const { recall, result } = await f.read({ source: 'archive' }, { target: privateRoom })
  assert.equal(result.status, 'found')
  f.bind(groupB)
  assert.equal(await recall.isCurrent(), true)
})

test('a budget-starved source remains reachable by its returned offset and a single-source query', redisTest, async t => {
  const f = await fixture(t)
  for (let index = 0; index < 12; index++) {
    await f.capture(`local-${index}:` + '原文'.repeat(1500), { target: privateRoom })
    await f.capture(`archive-${index}:` + '原文'.repeat(1500))
  }
  const all = (await f.read({ source: 'all', limit: 50 }, { target: privateRoom })).result
  assert.equal(all.budget_truncated, true)
  assert.equal(all.next_offsets.archive, 0)
  const archive = (await f.read({ source: 'archive', offset: all.next_offsets.archive, limit: 1 }, { target: privateRoom })).result
  assert.equal(archive.messages.length, 1)
  assert.equal(archive.messages[0].source, 'archive')
})
