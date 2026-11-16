import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createChatHistoryTool } from '../dist/backend/modules/qqTools/infrastructure/ChatHistoryTool.js'
import { createPersonMemoryStore } from '../dist/backend/modules/memory/infrastructure/personMemoryStore.js'
import { SemanticMemoryStore } from '../dist/backend/modules/memory/infrastructure/SemanticMemoryStore.js'

const identity = { botId: '900', personaId: 'persona' }
const subjectId = '100'
const at = Date.now() - 60_000
const scene = { kind: 'group', id: 'A' }
const privateScene = { kind: 'private', id: subjectId }
const record = (id, text, extra = {}) => ({ message_id: id, user_id: subjectId,
  sender: { user_id: subjectId, nickname: '同名' }, raw_message: text, message: [{ type: 'text', text }],
  timestamp: at, source_bot_id: identity.botId, source_persona_id: identity.personaId, ...extra })
const recent = (id, text, extra = {}) => ({ message_id: id, sender: { user_id: subjectId, nickname: '同名' },
  at, content: text, group_id: 'A', ...extra })

function fixture(t, rows = {}, extraPorts = {}) {
  const values = new Map()
  const redis = { async get(key) { return values.get(key) ?? null }, async set(key, value) { values.set(key, value); return 'OK' }, async del(key) { return Number(values.delete(key)) } }
  const store = createPersonMemoryStore({ redis })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-history-tool-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const archive = { readAllGroupMessages: async group => rows[group] || [], formatRecord: row => row.raw_message || '', getBaseDir: () => path.join(root, 'message_archive') }
  const Tool = createChatHistoryTool({ getPersonMemoryStore: () => store, getArchiveManager: () => archive, ...extraPorts })
  const tool = new Tool()
  const event = (extra = {}) => ({ self_id: '900', user_id: subjectId, message_id: 'current', _personaSnapshot: identity,
    _chatHistoryMessages: [], _personRecallGroupsResolver: async () => ({ allowedGroupIds: ['A', 'B'], legacyGroupIds: ['A'] }), ...extra })
  const ask = (query = {}, e = event()) => tool.execute({ question: '历史', keywords: [], ...query }, e)
  const remember = (text, extra = {}) => store.remember({ identity, subjectId, text, category: 'fact', evidenceKind: 'self',
    source: { scene, authorId: subjectId, messageId: text, at, excerpt: text }, ...extra })
  return { store, rows, archive, tool, event, ask, remember, root }
}

test('private tool reads only real self authors in host-authorized groups and supports archive paging', async t => {
  const f = fixture(t, { A: [record('a', '本人旧记录', { source_bot_id: undefined, source_persona_id: undefined }),
    record('other', '同名别人的秘密', { user_id: '200', sender: { user_id: '200', nickname: '同名' } }),
    record('forward', '转发秘密', { source: 'forward' }), record('bot', '其他bot秘密', { source_bot_id: '901' })],
  B: [record('b', '本人另一个群'), record('legacy-b', '未批准旧来源', { source_persona_id: undefined })],
  C: [record('c', '模型不能开启的群')] })
  const first = await f.ask({ source: 'archive', limit: 1, group_id: 'C', botId: '901', allowedGroupIds: ['C'] })
  assert.equal(first.status, 'found')
  assert.equal(first.messages.length, 1)
  assert.equal(first.next_offsets.archive, 1)
  const second = await f.ask({ source: 'archive', limit: 1, offset: first.next_offsets.archive })
  assert.deepEqual(new Set([...first.messages, ...second.messages].map(item => item.message_id)), new Set(['a', 'b']))
  assert.equal(second.next_offsets.archive, undefined)
  const forbidden = await f.ask({ source: 'archive', user_id: '200' })
  assert.equal(forbidden.status, 'unauthorized')
  assert.deepEqual(forbidden.messages, [])
})

test('trusted identity is required and supplied arguments cannot substitute for host identity', async t => {
  const f = fixture(t, { A: [record('a', '秘密')] })
  assert.equal((await f.ask({ source: 'archive', botId: '900', personaId: 'persona' }, f.event({ _personaSnapshot: undefined }))).status, 'unavailable')
  assert.equal((await f.ask({ source: 'archive' }, f.event({ self_id: '901' }))).status, 'unavailable')
  assert.equal((await f.ask({ source: 'archive' }, f.event({ _personRecallGroupsResolver: undefined }))).messages.length, 0)
})

test('structured memories outlive the raw archive and can be paged then read by actual ID', async t => {
  const f = fixture(t)
  await f.remember('旧考试经历', { source: { scene, authorId: subjectId, messageId: 'old', at: at - 100 * 86_400_000, excerpt: '当时考试了' } })
  await f.remember('另一次考试经历')
  const first = await f.ask({ source: 'memory', limit: 1 }, f.event({ _chatHistoryUnavailable: true }))
  assert.equal(first.status, 'found')
  assert.equal(first.next_offsets.memory, 1)
  const second = await f.ask({ source: 'memory', offset: 1, limit: 1 })
  assert.notEqual(first.memory_index[0].id, second.memory_index[0].id)
  const detail = await f.ask({ memory_ids: [first.memory_index[0].id], question: '展开详情', keywords: ['无关词'] })
  assert.equal(detail.memories.length, 1)
  assert.equal(detail.memories[0].id, first.memory_index[0].id)
  assert.equal(detail.memories[0].source.author_id, subjectId)
  assert.deepEqual((await f.ask({ memory_ids: ['invented-id'] })).memory_index, [])
})

test('group tool excludes other-group episodes and hides the provenance of portable facts', async t => {
  const f = fixture(t, { A: [record('a', '群A秘密')] })
  await f.remember('喜欢星际', { category: 'interest', sensitivity: 'ordinary', portable: true })
  const secret = await f.remember('只在群A发生的事')
  await f.remember('群B经历', { source: { scene: { kind: 'group', id: 'B' }, authorId: subjectId, messageId: 'b-event', at, excerpt: '群B经历' } })
  const e = f.event({ group_id: 'B' })
  const result = await f.ask({ source: 'memory' }, e)
  assert.deepEqual(result.memories.map(item => item.text).sort(), ['喜欢星际', '群B经历'])
  assert.equal(result.memories.find(item => item.text === '喜欢星际').source, undefined)
  assert.doesNotMatch(JSON.stringify(result.memory_index), /只在群A|群A发生/)
  assert.deepEqual((await f.ask({ memory_ids: [secret.entry.id] }, e)).memories, [])
  assert.equal((await f.ask({ source: 'archive', group_id: 'A' }, e)).status, 'unauthorized')
})

test('every tool call rechecks revocations despite a previously injected history snapshot', async t => {
  const f = fixture(t)
  const e = f.event({ group_id: 'A', _chatHistoryMessages: [recent('a', '自己的原话'), recent('unknown', '无身份', { sender: {} }), recent('', '无引用'), recent('other-bot', '其他bot来源', { source_bot_id: '901' })] })
  assert.deepEqual((await f.ask({ source: 'recent' }, e)).messages.map(item => item.message_id), ['a'])
  await f.store.revokeSource({ identity, scene, messageId: 'a' })
  assert.deepEqual((await f.ask({ source: 'recent' }, e)).messages, [])
})

test('a deletion during archive IO also clears old generated text from the final projection', async t => {
  const f = fixture(t, { A: [record('a', '需要删除的原文')] })
  const rows = [recent('private-own', '私聊缓存中的旧话', { group_id: undefined })]
  f.archive.readAllGroupMessages = async () => {
    await f.store.forget({ identity, subjectId })
    return [record('a', '需要删除的原文')]
  }
  const result = await f.ask({}, f.event({ _chatHistoryMessages: rows }))
  assert.deepEqual(result.messages, [])
  assert.deepEqual(result.memories, [])
})

test('a group deletion during memory lookup clears generated replies selected earlier in the call', async t => {
  const f = fixture(t)
  const query = f.store.query.bind(f.store)
  f.store.query = async input => {
    await f.store.forget({ identity, subjectId })
    return query(input)
  }
  const result = await f.ask({}, f.event({ group_id: 'A', _chatHistoryMessages: [recent('generated', '机器人复述旧事', { sender: { user_id: '900' }, source: 'send' })] }))
  assert.deepEqual(result.messages, [])
})

test('core deletion and manual RAG forgetting are enforced even with embeddings disabled', async t => {
  const f = fixture(t, { A: [record('forgotten', '人工忘掉的考试'), record('revoked', '撤回的考试'), record('safe', '保留的考试')] })
  const rag = new SemanticMemoryStore({ baseDir: path.join(f.root, 'semantic_memory'), dimension: 3 })
  await rag.appendChunks('A', [{ id: 'chunk', group_id: 'A', message_ids: ['forgotten'], text: '人工忘掉的考试', start_ts: at, end_ts: at, vector: new Float32Array([1, 0, 0]) }])
  assert.equal(await rag.forgetChunk('A', 'chunk'), true)
  rag.dispose()
  await f.store.revokeSource({ identity, scene, messageId: 'revoked' })
  const result = await f.ask({ source: 'archive' })
  assert.deepEqual(result.messages.map(item => item.message_id), ['safe'])
})

test('opt-out suppresses both archived utterances and existing structured memory', async t => {
  const f = fixture(t, { A: [record('a', '考试原话')] })
  await f.remember('考试事实')
  await f.store.setEnabled({ identity, subjectId, enabled: false })
  const result = await f.ask()
  assert.deepEqual(result.messages, [])
  assert.deepEqual(result.memories, [])
})
