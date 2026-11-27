import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const [{ createConversationMemory }, { conversationMemoryId }, { agentBindingToken, conversationAddressKey }, { createStandaloneAgentCodingWorker },
  { modelContextMetadata }, { createStandaloneAgentObserve }, { excerptToolText }, { createAgentPersonalRuntime },
  { createAgentHistory }, { agentHistoryId }] = await Promise.all([
  load('modules/memory/infrastructure/conversationMemory.js'), load('modules/memory/infrastructure/conversationMemoryStore.js'),
  load('modules/runtime/domain/agentBindings.js'), load('bootstrap/standaloneAgentCodingWorker.js'), load('modules/models/domain/requestContext.js'),
  load('bootstrap/standaloneAgentObserve.js'), load('modules/conversation/domain/toolTextExcerpt.js'),
  load('modules/simulation/infrastructure/agentPersonalRuntime.js'), load('modules/memory/infrastructure/agentHistory.js'),
  load('modules/memory/infrastructure/agentHistoryStore.js'),
])

const account = { platform: 'dingtalk', namespace: 'example', id: 'bot-1' }
const conversation = { account, kind: 'group', id: 'room-1' }
const binding = { source: 'configured', id: conversationAddressKey(conversation), agentId: 'shiloh', personaId: 'main', connectionId: 'ding', revision: 'v1', target: conversation }
const scope = { agentId: binding.agentId, target: conversation }
const clock = Date.parse('2026-11-27T19:00:00+08:00')

test('cross-day topic recall keeps the latest qualified correction, its author and a current ledger reference', async t => {
  const stateId = conversationMemoryId(scope), old = clock - 86_400_000
  const state = { version: 1, id: stateId, scope, binding, token: agentBindingToken(binding), nextSeq: 6, dueAt: 0, attempts: 0, retryAt: 0, episodes: [], records: [
    { seq: 1, messageId: 'm-1', authorId: 'lan', name: '阿岚', text: '本群活动原定 20:00 集合。', at: old },
    { seq: 2, messageId: 'm-2', authorId: 'ming', name: '小明', text: '别的群公告说 22:00，转发给大家。', at: old + 1 },
    { seq: 3, messageId: 'm-3', authorId: 'lan', name: '阿岚', text: '本群活动改到 21:00 集合。', at: old + 2 },
    { seq: 4, messageId: 'm-4', authorId: 'lan', name: '阿岚', text: '本群活动签到入口还没确认？', at: old + 3 },
    { seq: 5, messageId: 'm-5', authorId: 'lan', name: '阿岚', text: '按之前定的时间提醒。', at: clock },
  ] }
  let status = 'active', privacy = 0, newJob = false
  const recalled = new Set()
  const store = createConversationMemory({ redis: { async get() { return null }, async eval(_script, { keys }) {
    if (keys[1].endsWith(stateId)) return [JSON.stringify({ version: 1, ids: [stateId] }), JSON.stringify(state), null]
    return [null, null, null]
  } }, memory: { async getSceneRedactions() { return { invalidatedAt: privacy } },
    async getRedactions() { return { disabled: false, forgottenBefore: 0, scenes: [], revokedSources: [], tombstones: [] } },
  }, midterm: () => undefined, episodic: () => undefined, resolve: target => conversationAddressKey(target) === conversationAddressKey(conversation) ? { binding } : undefined,
  available: () => true, privatePeer: () => undefined, isRecalled: async (_target, id) => recalled.has(id),
  isRunning: () => true, allowsText: () => true, logger: { warn() {} }, now: () => clock })
  t.after(() => store.stop())
  const query = { query: '我们本群活动按之前最后定的时间提前十分钟提醒。', messageId: 'm-5', authorId: 'lan', existing: ['m-1'], isCurrent: () => true,
    async commitments() {
      return [{ id: 'job-1', authorId: 'lan', sourceId: 'm-3', intent: '本群活动提醒', status, due: clock + 6600_000 },
        ...(newJob ? [{ id: 'job-current', authorId: 'lan', sourceId: 'm-5', intent: '本群活动按之前最后定的时间提前十分钟提醒', status: 'active', due: clock + 6600_000 }] : [])]
    } }
  const projection = await store.readTopic(binding, query)
  const frame = JSON.parse(projection.text.split('\n').at(-1))
  assert.deepEqual(projection.messageIds, ['m-3', 'm-4'])
  assert.equal(frame.latestClarification, 'm-3')
  assert.deepEqual(frame.earlierQuestions, ['m-4'])
  assert.deepEqual(frame.messages[0], { id: 'm-3', author: 'lan', speaker: '阿岚', at: new Date(old + 2).toISOString(), quote: '本群活动改到 21:00 集合。' })
  assert.deepEqual(frame.commitments.map(task => [task.id, task.status]), [['job-1', 'active']])
  assert.equal(await projection.isCurrent(), true)
  newJob = true
  assert.equal(await projection.isCurrent(), true, 'registering this turn does not change the recalled ledger')
  status = 'unknown'
  assert.equal(await projection.isCurrent(), false)
  const next = await store.readTopic(binding, query)
  assert.match(next.text, /"status":"unknown"/u)
  recalled.add('m-3')
  assert.equal(await next.isCurrent(), false)
  const afterRecall = await store.readTopic(binding, query)
  assert.doesNotMatch(afterRecall.text, /21:00|job-1/u)
  privacy = clock
  assert.equal(await store.readTopic(binding, query), undefined)
  assert.equal(await store.readTopic({ ...binding, target: { ...conversation, id: 'other' } }, query), undefined)
  recalled.clear(); privacy = 0
  state.records[2].text = '本群活动的背景资料。'.repeat(95) + '本群活动改到 21:00 集合。'
  state.records.splice(4, 0, { seq: 5, messageId: 'm-forward', authorId: 'lan', name: '阿岚', text: '转发另一个群活动改到 22:00 的公告。', at: old + 4 })
  state.records[5].seq = 6; state.nextSeq = 7
  const long = JSON.parse((await store.readTopic(binding, query)).text.split('\n').at(-1))
  assert.equal(long.latestClarification, 'm-3')
  const relevant = long.messages.find(row => row.id === 'm-3')
  assert.match(relevant.quote, /改到 21:00/u)
  assert.equal(relevant.truncated, true)
})

test('multiple explicit source blocks keep contradictory final evidence under their original citations', () => {
  const a = '来源：https://example.com/notice-a', b = '来源：https://example.com/notice-b'
  const output = excerptToolText(`${a}\n${'背景事项与其它说明。'.repeat(250)}\n最后改到 21:00。\n${b}\n${'往年安排及交通资讯。'.repeat(250)}\n最终确认 22:00。`, 1024, '最后确认活动时间')
  assert.ok(output.length <= 1024)
  assert.match(output, /notice-a[\s\S]+21:00[\s\S]+notice-b[\s\S]+22:00/u)
})

test('large history pages keep complete JSON and resume at the first omitted message', async t => {
  const id = agentHistoryId(binding), originals = Array.from({ length: 10 }, (_, index) => ({
    messageId: 'notice-' + index, authorId: 'lan', name: '阿岚', at: clock - index - 1, text: '预算记录：'.repeat(350),
  }))
  const data = new Map([
    ['agent:history:v1:catalog', JSON.stringify({ version: 1, entries: [{ id, scope }] })],
    ['agent:history:v1:state:' + id, JSON.stringify({ version: 1, id, scope, rows: originals })],
  ])
  const privacy = { disabled: false, forgottenBefore: 0, scenes: [], revokedSources: [], tombstones: [] }
  const history = createAgentHistory({
    redis: { async get(key) { return data.get(key) ?? null }, async eval(_script, input) { return input.keys.map(key => data.get(key) ?? null) } },
    memory: { async getRedactions() { return privacy } },
    config: () => ({ enabled: true }), now: () => clock, isRunning: () => true, available: () => true,
    resolve: target => target.id === conversation.id ? { binding } : undefined, privatePeer() {}, async isRecalled() { return false },
    allowsText: () => true, logger: { warn() {} },
    async begin() { return { signal: new AbortController().signal, isCurrent: () => true, release() {} } },
  })
  t.after(() => history.stop())
  const query = { question: '查询预算记录', source: 'recent', limit: 10, keywords: ['预算'] }
  const source = { messageId: 'new-request', authorId: 'lan', text: '查一下群里的预算记录', at: clock, mentions: [] }
  const ids = []
  let offset = 0
  for (let page = 0; page < originals.length && offset !== undefined; page++) {
    const result = await history.read(binding, { ...query, offset }, source, () => true)
    assert.ok(result.text.length <= 8000)
    assert.equal(await result.isCurrent(), true)
    const value = JSON.parse(result.text)
    assert.ok(value.messages.length)
    assert.equal(value.returned_count, value.messages.length)
    assert.equal(value.messages[0].message_id, originals[offset].messageId)
    assert.equal(value.messages[0].sender, '阿岚')
    assert.equal(value.messages[0].time, new Date(originals[offset].at).toISOString())
    ids.push(...value.messages.map(row => row.message_id))
    offset = value.next_offsets.recent
  }
  assert.deepEqual(ids, originals.map(row => row.messageId))
})

test('an investigation resumes from source references after interruption and summarizes a long run only once', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'shiloh-context-worker-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const source = path.join(directory, 'source'), jobs = path.join(directory, 'jobs'), baseCommit = 'a'.repeat(40)
  await mkdir(path.join(source, 'src'), { recursive: true })
  const body = Array.from({ length: 90 }, (_, i) => `// evidence-${i + 1} ${'真实资料'.repeat(32)}`).join('\n') + '\n'
  await writeFile(path.join(source, 'src', 'case.ts'), body)
  await writeFile(path.join(source, 'package.json'), '{"type":"module"}')
  await writeFile(path.join(source, 'tsconfig.backend.json'), '{"compilerOptions":{"target":"es2022","types":[]},"include":["src/**/*.ts"]}')
  await writeFile(path.join(source, 'source-commit'), baseCommit)
  await symlink(await realpath('node_modules'), path.join(source, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  const input = '只读检查 case.ts 并报告可核验的证据', jobId = randomUUID()
  const reply = value => ({ choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] })
  let calls = 0, summaries = 0, continued = 0
  const work = { mode: 'investigate', jobId, async ensureCurrent() {} }
  const options = { source, jobs, baseCommit, allowsText: () => true }
  const interrupted = createStandaloneAgentCodingWorker({ ...options, async model() {
    if (++calls > 1) throw new Error('interrupted process')
    return reply({ op: 'read', path: 'src/case.ts', start: 1, count: 60 })
  } })
  await assert.rejects(() => interrupted('shiloh', input, new AbortController().signal, work), /interrupted process/u)
  assert.equal(await interrupted.canResume('shiloh', jobId, input), true)
  assert.equal(await interrupted.canResume('another-agent', jobId, input), false)
  const file = (await readdir(jobs)).find(name => name.endsWith('.checkpoint'))
  assert.doesNotMatch(await readFile(path.join(jobs, file), 'utf8'), /真实资料|只读检查/u)
  const origin = { key: 'room-source', revision: 'v1', message: { messageId: 'engineering-request', authorId: 'lan', at: clock } }
  const candidateId = randomUUID(), key = 'bl-chat:agent-personal:v1:shiloh'
  const storage = new Map([[key, JSON.stringify({
    profiles: [{ revision: 0, changedAt: 0, name: '希洛', aliases: [], introduction: '', identity: '测试角色', reason: '初始' }],
    goals: [[jobId, 'investigate'], [candidateId, 'candidate']].map(([id, mode]) => ({ id, title: '工程任务', draft: input,
      targetKey: origin.key, nextAt: clock, state: 'active', engineering: { mode, status: 'running', origin } })),
    receipts: [], tools: [], nextReviewAt: clock, nextWorkAt: clock,
  })]])
  const personal = coding => createAgentPersonalRuntime({ coding, seeds: [{ id: 'shiloh', name: '希洛' }],
    redis: { async get(key) { return storage.get(key) ?? null }, async set(key, value) { storage.set(key, value) } },
    now: () => clock, allowsText: () => true, isCurrent: () => true, failed(_stage, error) { throw error },
    async workSourceCurrent(_agent, source, signal, isCurrent) { assert.deepEqual(source, origin); return isCurrent() && !signal.aborted },
  })
  const restarted = createStandaloneAgentCodingWorker({ ...options, async model(request) {
    const metadata = modelContextMetadata(request)
    if (metadata.purpose === 'engineering_summary') {
      summaries++
      assert.equal(request.tools, undefined)
      return reply('遗漏了旧证据的工作记录。')
    }
    if (continued++ === 0) {
      assert.equal(metadata.round, 2)
      assert.match(JSON.stringify(request.messages), /src\/case\.ts:1-60.*evidence-1/u)
    }
    if (summaries) {
      assert.match(JSON.stringify(request.messages), /遗漏了旧证据.*src\/case\.ts:1-60.*evidence-1/u)
      await secondHost.stop()
      throw new Error('interrupted after summary')
    }
    return reply({ op: 'read', path: 'src/case.ts', start: continued, count: 60 })
  } })
  const secondHost = personal(restarted)
  t.after(() => secondHost.stop())
  await secondHost.load()
  const summary = secondHost.workSummary('shiloh', () => true)
  assert.deepEqual(summary.goals.map(row => [row.id, row.engineering.status]), [[jobId, 'queued'], [candidateId, 'unknown']])
  await [...secondHost.dueEngineeringWork()][0].run()
  assert.equal(JSON.parse(await readFile(path.join(jobs, file), 'utf8')).summarized, true)
  assert.equal(JSON.parse(storage.get(key)).goals[0].engineering.status, 'running')
  let reloaded = 0
  const lastWorker = createStandaloneAgentCodingWorker({ ...options, async model(request) {
    assert.equal(modelContextMetadata(request).purpose, 'engineering')
    assert.match(JSON.stringify(request.messages), /src\/case\.ts:1-60.*evidence-1/u)
    if (++reloaded >= 11) return reply({ op: 'done', summary: '已核对 src/case.ts 的 evidence-1。' })
    return reply({ op: 'read', path: 'src/case.ts', start: reloaded + 10, count: 60 })
  } })
  const lastHost = personal(lastWorker)
  t.after(() => lastHost.stop())
  await lastHost.load()
  await [...lastHost.dueEngineeringWork()][0].run()
  assert.equal(summaries, 1)
  assert.match(lastHost.workSummary('shiloh', () => true).goals.find(row => row.id === jobId).engineering.result, /evidence-1/u)
  assert.equal(await lastWorker.canResume('shiloh', jobId, input), false)
  assert.deepEqual([...lastHost.dueEngineeringWork()], [])
})

test('console context metrics only aggregate authorized scopes and distinguish estimated input', async () => {
  const denied = { ...binding, id: 'hidden', target: { ...conversation, id: 'hidden-room' } }
  const row = (id, owner, details, code = 'completed') => ({ version: 1, id: `event-${id}`, traceId: 'trace-1', at: 100 + id,
    scope: { kind: 'conversation', binding: owner, messageId: 'm-1' }, stage: 'model', operation: 'provider_context',
    outcome: code === 'completed' ? 'succeeded' : 'failed', code, durationMs: id * 5, details: { contextPurpose: 'text', contextModel: 'fixture', contextRoute: 'chat', requestBytes: 500, ...details } })
  const service = createStandaloneAgentObserve({ bindings: { list: () => [binding, denied], resolve: target => target.id === conversation.id ? binding : denied },
    auth: { isCurrent: () => true, async authorize(_principal, _op, owner) { return owner === denied || owner?.id === 'hidden' ? 'denied' : 'allowed' } },
    async read() { return { events: [row(1, binding, { inputTokens: 100, cachedInputTokens: 60, contextRound: 1 }),
      row(2, binding, { estimatedInputTokens: 120, contextRound: 2, savedContextBytes: 300, repeatedContextReads: 1 }, 'context_length_exceeded'),
      row(3, denied, { inputTokens: 2000 })], truncated: false, invalidRecords: 0 } },
    health: () => ({ written: 3, failed: 0, degraded: false }), configState: () => ({ processEpoch: 'p', loadedRevision: 'r', storedRevision: 'r', phase: 'active', requiresRestart: false }) })
  const result = await service.handle({ method: 'GET', pathname: '/api/observe/summary', params: {}, query: {}, body: {} }, {
    principal: { id: 'admin', via: 'session' }, signal: new AbortController().signal, isCurrent: () => true, ensureCurrent() {},
  })
  const [metrics] = result.value.contextMetrics
  assert.equal(metrics.first.requests, 1)
  assert.deepEqual(metrics.first.inputTokens, { p50: 100, p95: 100 })
  assert.deepEqual(metrics.followup.estimatedInputTokens, { p50: 120, p95: 120 })
  assert.equal(metrics.turns.inputTokens, null)
  assert.equal(metrics.overflow, 1)
  assert.equal(metrics.cachePercent, 60)
  assert.equal(metrics.savedBytes, 300)
  assert.equal(metrics.repeatedReads, 1)
})
