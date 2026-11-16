import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SemanticMemoryStore } from '../dist/backend/modules/memory/infrastructure/SemanticMemoryStore.js'
import { SemanticMemoryIndexer } from '../dist/backend/modules/memory/infrastructure/SemanticMemoryIndexer.js'
import { SemanticMemoryRetriever } from '../dist/backend/modules/memory/infrastructure/SemanticMemoryRetriever.js'
import { createArchiveManagerClass } from '../dist/backend/modules/messaging/infrastructure/messageArchive.js'

class Gateway {
  model = 'test-person'
  batchSize = 16
  texts = []
  vector(text) { return Float32Array.from([text.includes('考试') ? 1 : 0, text.includes('游戏') ? 1 : 0, 0.1]) }
  async embed(text) { this.texts.push(text); return this.vector(text) }
  async embedBatch(texts) { this.texts.push(...texts); return texts.map(text => this.vector(text)) }
}
function record(id, user, text, extra = {}) {
  return { message_id: id, user_id: user, sender: { user_id: user, nickname: '同名' }, raw_message: text,
    message: [{ type: 'text', text }], timestamp: Date.now() - 1000, source_bot_id: '900', source_persona_id: 'persona', ...extra }
}
function fixture(t, records = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'person-recall-'))
  const store = new SemanticMemoryStore({ baseDir: dir, dimension: 3, retentionDays: 30 })
  const gateway = new Gateway()
  const archive = { formatRecord: row => row.raw_message || '', readAllGroupMessages: async group => records[group] || [],
    readRecentGroupMessages: async group => records[group] || [], listArchiveGroupIds: async () => Object.keys(records) }
  const indexer = new SemanticMemoryIndexer({ store, gateway, archiveManager: archive })
  const retriever = new SemanticMemoryRetriever({ store, gateway, archiveManager: archive, config: { retrieveTimeoutMs: 1500, topK: 10 } })
  t.after(() => { retriever.dispose(); indexer.dispose(); store.dispose(); fs.rmSync(dir, { recursive: true, force: true }) })
  const options = { viewerUserId: '100', botId: '900', personaId: 'persona', allowedGroupIds: Object.keys(records), timeoutMs: 1500 }
  return { store, gateway, archive, indexer, retriever, options, dir }
}

test('人物历史按真正账号投影两群，混合块及转发的第三人内容不送给模型', async t => {
  const rows = { A: [record('a1', '100', '我下周有考试'), record('a2', '200', '别人私事不能曝光考试')],
    B: [record('b1', '100', '考试以后一起玩游戏'), record('b2', '100', '转发里的考试秘密', { source: 'forward' }),
      record('b3', '100', '机器人的考试回复', { source: 'send' })] }
  const { retriever, indexer, gateway, options, store } = fixture(t, rows)
  await indexer.backfillAll()
  assert.deepEqual(store.loadGroup('A').records[0].user_ids, ['100', '200'])
  assert.equal(store.loadGroup('A').records[0].sources[0].bot_id, '900')
  gateway.texts = []
  const found = await retriever.searchPerson('100', '考试', options)
  assert.equal(found.items.length, 2)
  assert.deepEqual(new Set(found.items.map(item => item.chunk.group_id)), new Set(['A', 'B']))
  assert.ok(found.items.every(item => item.chunk.user_ids.length === 1 && item.chunk.user_ids[0] === '100'))
  assert.ok(gateway.texts.every(text => !text.includes('别人私事') && !text.includes('转发里的') && !text.includes('机器人的')))
})

test('私聊不是查询第三人历史的权限，拒绝发生在任何读取或网络调用之前', async t => {
  const { retriever, gateway, options, archive } = fixture(t, { A: [record('a1', '200', '考试秘密')] })
  archive.readAllGroupMessages = async () => { throw new Error('must not read') }
  const found = await retriever.searchPerson('200', '考试', options)
  assert.match(found.reason, /unauthorized/)
  assert.deepEqual(gateway.texts, [])
})

test('群RAG携带可信身份时拒绝其他bot/persona和未经授权的旧接收身份', async t => {
  const { store, gateway, retriever } = fixture(t)
  const now = Date.now()
  const source = (id, bot_id, persona_id) => ({ user_id: '100', message_id: id, timestamp: now, name: '同名', text: '考试', personal_text: '考试', bot_id, persona_id })
  const rows = [source('own', '900', 'persona'), source('wrong-bot', '901', 'persona'), source('wrong-persona', '900', 'other'), source('legacy')]
  await store.appendChunks('A', rows.map(row => ({ id: row.message_id, message_ids: [row.message_id], sources: [row], text: '考试', end_ts: now, vector: gateway.vector('考试') })))
  const options = { botId: '900', personaId: 'persona', topK: 10 }
  assert.deepEqual((await retriever.search('A', '考试', options)).items.map(item => item.chunk.id), ['own'])
  assert.deepEqual(new Set((await retriever.search('A', '考试', { ...options, allowLegacySourceIdentity: true })).items.map(item => item.chunk.id)), new Set(['own', 'legacy']))
})

test('本人归档检索不被更短的向量保留期限截断', async t => {
  const { retriever, options } = fixture(t, { A: [record('old', '100', '以前的考试', { timestamp: Date.now() - 90 * 86400000 })] })
  const found = await retriever.searchPerson('100', '考试', options)
  assert.deepEqual(found.items.map(item => item.chunk.message_ids[0]), ['old'], JSON.stringify(found))
  assert.deepEqual((await retriever.readPersonHistory('100', '考试', options)).items.map(item => item.source.messageId), ['old'])
})

test('接收bot/persona必须匹配，旧档案只有显式允许的群能回源', async t => {
  const rows = { A: [record('wrong-bot', '100', '其他机器人考试', { source_bot_id: '901' }),
    record('wrong-persona', '100', '另一个人格考试', { source_persona_id: 'other' }),
    record('legacy', '100', '旧记录考试', { source_bot_id: undefined, source_persona_id: undefined })],
    B: [record('not-allowed', '100', '未授权群考试')] }
  const { retriever, gateway, options } = fixture(t, rows)
  const opts = { ...options, allowedGroupIds: ['A'] }
  assert.equal((await retriever.searchPerson('100', '考试', opts)).items.length, 0)
  const found = await retriever.searchPerson('100', '考试', { ...opts, legacyGroupIds: ['A', 'B'] })
  assert.deepEqual(found.items.map(item => item.chunk.message_ids[0]), ['legacy'])
  assert.ok(gateway.texts.every(text => !/其他机器人|另一个人格|未授权群/.test(text)))
})

test('旧多人窗口不能凭昵称推断作者；有原归档时按messageId回源', async t => {
  const { store, gateway, retriever, options, archive } = fixture(t, { A: [] })
  const now = Date.now()
  await store.appendChunks('A', [{ id: 'A:legacy', group_id: 'A', message_ids: ['one', 'two'], speakers: ['同名'],
    text: '同名: 考试秘密\n同名: 考试公开', start_ts: now, end_ts: now, vector: gateway.vector('考试') }])
  const legacyOpts = { ...options, legacyGroupIds: ['A'] }
  assert.equal((await retriever.searchPerson('100', '考试', legacyOpts)).items.length, 0)
  archive.readAllGroupMessages = async () => [record('one', '200', '考试秘密'), record('two', '100', '我的考试公开')]
  gateway.texts = []
  const found = await retriever.searchPerson('100', '考试', legacyOpts)
  assert.equal(found.items.length, 1)
  assert.equal(found.items[0].chunk.message_ids[0], 'two')
  assert.ok(gateway.texts.every(text => !text.includes('考试秘密')))
})

test('撤回后的归档覆盖缓存索引，不能继续回忆已撤回原文', async t => {
  const rows = { A: [record('a1', '100', '考试消息撤回')] }
  const { retriever, indexer, gateway, options } = fixture(t, rows)
  await indexer.backfillAll()
  rows.A[0].recalled = true
  gateway.texts = []
  assert.equal((await retriever.searchPerson('100', '考试', options)).items.length, 0)
  assert.deepEqual(gateway.texts, [])
})

test('记忆删除过滤在网络之前和返回之前执行，没有跨身份结果缓存', async t => {
  const { retriever, gateway, options } = fixture(t, { A: [record('a1', '100', '考试信息')] })
  let allowed = true
  const filterSource = source => { assert.equal(source.authorId, '100'); return allowed }
  const embed = gateway.embedBatch.bind(gateway)
  gateway.embedBatch = async texts => { const result = await embed(texts); allowed = false; return result }
  assert.equal((await retriever.searchPerson('100', '考试', { ...options, filterSource })).items.length, 0)
  gateway.texts = []
  assert.equal((await retriever.searchPerson('100', '考试', { ...options, filterSource })).items.length, 0)
  assert.deepEqual(gateway.texts, [])
})

test('群记忆删除挡住包含被删来源的整个窗口，重排前完成过滤', async t => {
  const rows = { A: [record('a1', '100', '考试公开'), record('a2', '200', '考试秘密')] }
  const { retriever, indexer, gateway } = fixture(t, rows)
  await indexer.backfillAll()
  gateway.texts = []
  let reranked = false
  retriever.reranker = { async rerank() { reranked = true; return null } }
  const found = await retriever.search('A', '考试', { filterSource: source => source.authorId !== '200', rerank: true })
  assert.equal(found.items.length, 0)
  assert.equal(reranked, false)
})

test('RAG单条遗忘保留墓碑，重新索引和重启后也不能从归档恢复', async t => {
  const rows = { A: [record('a1', '100', '考试要忘掉'), record('a2', '100', '考试不再记得')] }
  const { retriever, indexer, store, gateway, dir, options } = fixture(t, rows)
  await indexer.backfillAll()
  const first = [...store.loadGroup('A').chunks.keys()][0]
  assert.equal(await store.forgetChunk('A', first), true)
  await indexer.backfillAll()
  assert.equal(store.loadGroup('A').chunks.size, 0)
  assert.equal((await retriever.searchPerson('100', '考试', options)).items.length, 0)
  const restarted = new SemanticMemoryStore({ baseDir: dir, dimension: 3, retentionDays: 30 })
  assert.deepEqual(restarted.searchBM25('A', '考试'), [])
  assert.equal(await restarted.appendChunks('A', [{ id: first, message_ids: ['a1', 'a2'], text: '考试', end_ts: Date.now(), vector: gateway.vector('考试') }]), 0)
  restarted.dispose()
})

test('停滞的归档读和群过滤都受同一检索截止控制', async t => {
  const { retriever, archive, options, indexer } = fixture(t, { A: [record('a1', '100', '考试')] })
  await indexer.backfillAll()
  archive.readAllGroupMessages = () => new Promise(() => {})
  const start = Date.now()
  const personal = await retriever.searchPerson('100', '考试', { ...options, timeoutMs: 200 })
  assert.equal(personal.reason, 'timeout')
  const group = await retriever.search('A', '考试', { timeoutMs: 200, filterSource: () => true })
  assert.equal(group.reason, 'timeout')
  assert.ok(Date.now() - start < 1000)
})

test('embedding慢时仍返回已授权的全文关键词召回', async t => {
  const { retriever, gateway, options } = fixture(t, { A: [record('a1', '100', '考试日期')] })
  gateway.embed = () => new Promise(() => {})
  gateway.embedBatch = () => new Promise(() => {})
  const result = await retriever.searchPerson('100', '考试', { ...options, timeoutMs: 300 })
  assert.equal(result.items.length, 1)
  assert.ok(result.elapsedMs < 500)
})

test('归档保存实际接收机器人，仅接受与它匹配的人格快照', () => {
  const Manager = createArchiveManagerClass({ safeTruncateUnicode: (text, max) => text.slice(0, max), getMentionTargetId: () => '', queue: {} })
  const manager = new Manager()
  const base = { message_type: 'group', group_id: 12, user_id: 100, self_id: 900, message_id: 'msg', message: [{ type: 'text', text: '考试' }] }
  const correct = manager.buildRecord({ ...base, _personaSnapshot: { botId: '900', personaId: 'persona' } })
  assert.equal(correct.source_bot_id, '900')
  assert.equal(correct.source_persona_id, 'persona')
  const mismatch = manager.buildRecord({ ...base, _personaSnapshot: { botId: '901', personaId: 'other' } })
  assert.equal(mismatch.source_bot_id, '900')
  assert.equal(mismatch.source_persona_id, undefined)
  assert.equal(manager.buildRecord({ ...base, self_id: undefined }).source_bot_id, undefined)
})

test('回复消息仅检索本人文字，不把被引用的正文归给本人', async t => {
  const rows = { A: [record('reply', '100', '考试自己的答复', { message: [
    { type: 'reply', id: 'other', text: '考试别人引用里的秘密' }, { type: 'text', text: '考试自己的答复' }
  ] })] }
  const { retriever, gateway, options } = fixture(t, rows)
  const result = await retriever.searchPerson('100', '考试', options)
  assert.equal(result.items.length, 1)
  assert.ok(gateway.texts.every(text => !text.includes('别人引用')))
})

test('群检索重排过程中忘记的分块，不从已排好名的候选里返回', async t => {
  const { store, retriever, gateway } = fixture(t, { A: [] })
  const now = Date.now()
  await store.appendChunks('A', ['a1', 'a2'].map(id => ({ id, message_ids: [id], text: `考试${id}`, end_ts: now, vector: gateway.vector('考试') })))
  retriever.reranker = { async rerank() { await store.forgetChunk('A', 'a1'); return new Map([['a1', 1], ['a2', 0.5]]) } }
  const found = await retriever.search('A', '考试', { rerank: true })
  assert.deepEqual(found.items.map(item => item.chunk.id), ['a2'])
})
