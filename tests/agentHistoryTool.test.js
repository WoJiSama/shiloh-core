import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentHistoryTool } from '../dist/backend/modules/tools/infrastructure/agentHistoryTool.js'

const tool = createAgentHistoryTool()
const account = { platform: 'fixture', namespace: 'tenant', id: 'robot' }
const target = { account, kind: 'group', id: 'room' }
const user = { ...account, id: 'requester' }

function fixture(overrides = {}) {
  const controller = new AbortController(), calls = [], checks = []
  const context = {
    binding: { source: 'configured', id: 'binding', agentId: 'agent', revision: 'revision', connectionId: 'connection', target },
    actor: { kind: 'user', user }, request: { messageId: 'trigger', text: '查一下昨天讨论的预算', mentions: [] },
    signal: controller.signal, isCurrent: () => true,
    async ensureCurrent() { checks.push('current') },
    async readHistory(input) { calls.push(input); return '{"status":"found","messages":[{"content":"预算待定"}]}' },
    ...overrides,
  }
  return { context, controller, calls, checks, execute: (input = { question: '昨天讨论的预算' }) => tool.execute(input, context) }
}
const data = result => JSON.parse(result.content)

test('history tool exposes the existing closed explicit-query contract', () => {
  assert.equal(tool.name, 'chatHistoryTool')
  assert.equal(tool.parameters.additionalProperties, false)
  assert.deepEqual(tool.parameters.required, ['question'])
  assert.deepEqual(Object.keys(tool.parameters.properties), ['question', 'user_id', 'start_time', 'end_time', 'keywords', 'limit', 'offset', 'source', 'memory_ids'])
  assert.deepEqual(tool.parameters.properties.source.enum, ['all', 'recent', 'archive', 'memory'])
  assert.equal(tool.parameters.properties.limit.maximum, 50)
  assert.equal(tool.parameters.properties.offset.maximum, 100000)
  assert.equal(tool.parameters.properties.keywords.maxItems, 20)
  assert.equal(tool.parameters.properties.memory_ids.maxItems, 50)
})

test('a real current request forwards parameters and result unchanged between asynchronous authorization checks', async () => {
  const f = fixture()
  const input = { question: ' 昨天讨论的预算 ', user_id: 'member/source-123', start_time: '2026-11-15', end_time: '2026-11-15',
    keywords: ['预算', '原话'], limit: 50, offset: 100000, source: 'memory', memory_ids: ['actual-memory-id'] }
  const original = structuredClone(input), binding = structuredClone(f.context.binding), actor = structuredClone(f.context.actor)
  const result = await f.execute(input)
  assert.deepEqual(result, { status: 'succeeded', content: '{"status":"found","messages":[{"content":"预算待定"}]}' })
  assert.equal(f.calls[0], input)
  assert.deepEqual(input, original)
  assert.deepEqual(f.context.binding, binding); assert.deepEqual(f.context.actor, actor)
  assert.deepEqual(f.checks, ['current', 'current'])
  assert.doesNotMatch(result.content, /binding|revision|tenant|requester/u)
})

test('absence of a real current author or request never reaches the history reader', async () => {
  for (const overrides of [
    { actor: { kind: 'autonomous' } }, { actor: { kind: 'commitment' } }, { actor: { kind: 'user' } },
    { request: undefined }, { request: { messageId: '', text: '查询历史', mentions: [] } }, { isCurrent: () => false },
  ]) {
    const f = fixture(overrides), result = await f.execute()
    assert.equal(result.status, 'failed'); assert.equal(data(result).status, 'unavailable')
    assert.deepEqual(f.calls, []); assert.deepEqual(f.checks, [])
  }
})

test('current request denial and discussion remain forbidden despite affirmative model arguments', async () => {
  for (const text of ['不要翻聊天记录，查一下成员资料', '只是讨论“查询聊天记录”这种功能', '别查昨天的发言记录']) {
    const f = fixture({ request: { messageId: 'trigger', text, mentions: [] } })
    const result = await f.execute({ question: '请查询历史', source: 'all' })
    assert.equal(result.status, 'failed', text); assert.equal(data(result).status, 'forbidden', text)
    assert.deepEqual(f.calls, []); assert.deepEqual(f.checks, [])
  }
})

test('missing history capability returns a clear unavailable result without another transport', async () => {
  const f = fixture({ readHistory: undefined })
  const result = await f.execute()
  assert.equal(result.status, 'failed'); assert.equal(data(result).status, 'unavailable')
  assert.match(data(result).message, /历史查询端口/u)
  assert.deepEqual(f.calls, [])
})

test('cancellation before admission, during a check or during history IO cannot expose a result', async () => {
  const before = fixture(); before.controller.abort()
  assert.equal((await before.execute()).status, 'failed')
  assert.deepEqual(before.calls, [])

  const duringCheck = fixture()
  duringCheck.context.ensureCurrent = async () => duringCheck.controller.abort()
  await assert.rejects(duringCheck.execute(), /失效/u)
  assert.deepEqual(duringCheck.calls, [])

  const duringRead = fixture()
  duringRead.context.readHistory = async () => { duringRead.controller.abort(); return '不应泄露的迟到原文' }
  await assert.rejects(duringRead.execute(), /失效/u)

  const rebind = fixture()
  rebind.context.readHistory = async () => { rebind.context.isCurrent = () => false; return '已失去授权的群历史' }
  await assert.rejects(rebind.execute(), /失效/u)

  const deniedAtUse = fixture()
  deniedAtUse.context.ensureCurrent = async () => { if (deniedAtUse.checks.length) throw new Error('source revoked'); deniedAtUse.checks.push('first') }
  await assert.rejects(deniedAtUse.execute(), /source revoked/u)
  assert.equal(deniedAtUse.calls.length, 1)
})

test('bounded parameters reject overflows and attempts to substitute a binding or actor', async () => {
  const invalid = [
    {}, { question: '' }, { question: '   ' }, { question: '字'.repeat(2001) }, { user_id: '' }, { user_id: 123 }, { user_id: 'x'.repeat(241) },
    { keywords: Array(21).fill('词') }, { keywords: ['x'.repeat(101)] }, { keywords: [null] }, { keywords: Array(1) },
    { memory_ids: Array(51).fill('id') }, { memory_ids: ['x'.repeat(201)] }, { memory_ids: [' '] }, { memory_ids: [123] }, { memory_ids: Array(1) },
    { limit: 0 }, { limit: 51 }, { limit: 1.5 }, { limit: '20' }, { limit: Number.MAX_SAFE_INTEGER + 1 },
    { offset: -1 }, { offset: 100001 }, { offset: 0.5 }, { offset: Infinity }, { offset: NaN },
    { start_time: 'x'.repeat(101) }, { end_time: {} }, { source: 'other-group' },
    { binding: { target: { ...target, id: 'other-room' } } }, { actor: { kind: 'user', user: { ...user, id: 'other-person' } } },
    { group_id: 'other-room' }, { allowedGroupIds: ['other-room'] },
  ]
  for (const change of invalid) {
    const input = Object.keys(change).length ? { question: '历史', ...change } : {}, f = fixture()
    const result = await f.execute(input)
    assert.equal(result.status, 'failed', JSON.stringify(change))
    assert.equal(data(result).status, 'invalid_query', JSON.stringify(change))
    assert.deepEqual(f.calls, []); assert.deepEqual(f.checks, [])
  }
})

test('date meaning and missing-evidence statuses remain the query service responsibility', async () => {
  for (const date of ['', '2026-02-30', '2026-11-15T10:00:00', 'not-a-date']) {
    const f = fixture({ async readHistory(input) {
      assert.equal(input.start_time, date)
      return '{"status":"invalid_query","messages":[]}'
    } })
    assert.deepEqual(await f.execute({ question: '历史', start_time: date }), { status: 'succeeded', content: '{"status":"invalid_query","messages":[]}' })
  }
  const f = fixture({ async readHistory() { return '{"status":"not_found","messages":[]}' } })
  assert.equal((await f.execute()).content, '{"status":"not_found","messages":[]}')
})
