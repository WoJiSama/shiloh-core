import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const [{ createStandaloneAgentObserve }, { openAgentOperationJournal }, { readAgentOperationJournal }, { AgentConsoleError }, { createStandaloneAgentConsole },
  { agentConversationKey, agentBindingToken, conversationAddressKey }] = await Promise.all([
  load('bootstrap/standaloneAgentObserve.js'), load('modules/runtime/infrastructure/agentOperationJournal.js'),
  load('modules/runtime/infrastructure/agentOperationJournalReader.js'), load('contracts/agentConsole.js'), load('bootstrap/standaloneAgentConsole.js'), load('modules/runtime/domain/agentBindings.js'),
])
const binding = (id = '10001', extra = {}) => ({ source: 'configured', id: 'same-binding-id', revision: 'binding-v1', agentId: 'daily', personaId: 'shared', connectionId: `qq-${id}`,
  target: { account: { platform: 'qq', namespace: 'global', id }, kind: 'group', id: '20001' }, ...extra })
const event = (index, selected = binding(), extra = {}) => ({ version: 1, id: `event-${index}`, traceId: `trace-${index}`, at: 1000 + index,
  scope: { kind: 'conversation', binding: selected, messageId: `source-${index}` }, stage: 'delivery', operation: 'send', outcome: 'succeeded', ...extra })
const principal = { id: 'admin', username: 'admin', via: 'session' }
const request = query => ({ method: 'GET', pathname: '/api/observe/summary', params: {}, query: query ?? {}, body: {} })
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function fixture(t, initial = []) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-observe-')), opened = [], rows = [binding(), binding('10002')], permissions = new Map(), calls = []
  t.after(async () => { for (const journal of opened) await journal.close(); await fs.rm(dataDir, { recursive: true, force: true }) })
  let journal = await openAgentOperationJournal({ dataDir }), authCurrent = true, hostCurrent = true
  opened.push(journal)
  for (const row of initial) assert.equal(await journal.append(row), true)
  const controller = new AbortController()
  const context = { principal, signal: controller.signal, isCurrent: () => hostCurrent && !controller.signal.aborted,
    ensureCurrent() { if (!this.isCurrent()) throw new AgentConsoleError('conflict') } }
  const auth = { isCurrent: () => authCurrent, async authorize(_principal, operation, selected, guard) {
    guard.ensureCurrent(); calls.push([operation, selected]); return permissions.get(`${operation}:${selected?.target.account.id ?? '*'}`) ?? 'allowed'
  } }
  const config = { processEpoch: 'epoch-v1', loadedRevision: 'configuration:v1', storedRevision: 'configuration:v1', phase: 'active', requiresRestart: false }
  const options = { bindings: { list: () => rows, resolve: target => rows.find(row => conversationAddressKey(row.target) === conversationAddressKey(target)) }, auth,
    read: guard => readAgentOperationJournal({ dataDir, guard }), health: () => journal.health(), configState: () => config, now: () => 5000 }
  const service = createStandaloneAgentObserve(options), call = async (query, ctx = context) => (await service.handle(request(query), ctx)).value
  return { dataDir, rows, permissions, calls, context, options, service, call, config, auth,
    journal: () => journal, revokeAuth: () => { authCurrent = false }, revokeHost: () => { hostCurrent = false },
    async restart() { await journal.close(); journal = await openAgentOperationJournal({ dataDir }); opened.push(journal) },
  }
}

test('standalone observation survives a real journal restart and preserves configuration and native receipt metadata', async t => {
  const old = event(1), actual = event(2, binding(), { configurationRevision: 'configuration:old-process', delivery: { state: 'sent', messageId: 'native-17' } })
  const f = await fixture(t, [old, actual]); await f.restart()
  const result = await f.call()
  assert.deepEqual([f.service.operation, f.service.path, f.service.scope], ['observe.read', '/api/observe/summary', 'global'])
  assert.equal(result.mode, 'standalone'); assert.equal(result.processEpoch, 'epoch-v1'); assert.equal(result.observedAt, 5000)
  assert.deepEqual(result.configuration, { loadedRevision: f.config.loadedRevision, storedRevision: f.config.storedRevision, phase: 'active', requiresRestart: false })
  assert.deepEqual(result.events.map(row => row.id), ['event-2', 'event-1'])
  assert.equal(result.events[0].configurationRevision, 'configuration:old-process'); assert.deepEqual(result.events[0].delivery, { state: 'sent', messageId: 'native-17' })
  assert.equal(Object.hasOwn(result.events[1], 'configurationRevision'), false); assert.equal(Object.hasOwn(result.events[1], 'delivery'), false)
  assert.equal(result.events[0].scopeKey, agentConversationKey(f.rows[0])); assert.equal(result.events[0].bindingToken, agentBindingToken(f.rows[0]))
  assert.equal(result.journal.available, true); assert.equal(result.journal.written, 0)
  assert.deepEqual(result.scan, { truncated: false, invalidRecords: 0, scannedEvents: 2, hostCountersVisible: true })
})

test('a result-unknown delivery stays unknown and cannot acquire a native message ID', async t => {
  const f = await fixture(t, [event(1, binding(), { outcome: 'unknown', delivery: { state: 'unknown' } })])
  const result = await f.call({ outcome: 'unknown', traceId: 'trace-1', limit: '1' })
  assert.equal(result.events.length, 1); assert.deepEqual(result.events[0].delivery, { state: 'unknown' }); assert.equal(result.events[0].outcome, 'unknown')
  assert.equal((await f.call({ outcome: 'failed' })).events.length, 0)
})

test('the real HTTP observation service remains readable after execution retirement using loaded bindings and live authentication', async t => {
  const f = await fixture(t, [event(1, binding(), { configurationRevision: 'configuration:v1', delivery: { state: 'sent', messageId: 'native-1' } })])
  f.config.storedRevision = 'configuration:v2'; f.config.requiresRestart = true; f.config.phase = 'restart-required'
  const execution = new AbortController(); execution.abort()
  const authority = new AbortController(), frontendDir = path.join(f.dataDir, 'frontend'); await fs.mkdir(frontendDir)
  await fs.writeFile(path.join(frontendDir, 'index.html'), '<title>Fixture</title>')
  const app = createStandaloneAgentConsole({ frontendDir, port: 0, services: [f.service],
    bindings: { list: () => [], resolve: () => undefined }, execution: { signal: execution.signal, isCurrent: () => false },
    authority: { signal: authority.signal, isCurrent: () => f.context.isCurrent() }, allowsResponse: () => true,
    auth: { ...f.auth, async authenticate(credentials, guard) { guard.ensureCurrent(); return credentials.token === 'fixture-token' ? principal : undefined },
      async state() { return { hasUser: true, username: 'admin', tokenWorks: true, via: 'token' } }, async run() { return {} } },
  })
  t.after(() => app.close())
  const address = await app.listen(), base = `http://127.0.0.1:${address.port}`
  const headers = { 'x-console-token': 'fixture-token' }
  assert.equal((await fetch(base + '/api/observe/summary')).status, 401)
  const response = await fetch(base + '/api/observe/summary', { headers }); assert.equal(response.status, 200)
  const view = await response.json(); assert.equal(view.configuration.requiresRestart, true); assert.equal(view.configuration.loadedRevision, 'configuration:v1')
  assert.equal(view.events[0].scopeKey, agentConversationKey(f.rows[0])); assert.equal(view.events[0].delivery.messageId, 'native-1')
  assert.equal((await fetch(base + '/api/bindings', { headers })).status, 409)
  assert.equal((await fetch(base + '/api/observe/summary', { headers, method: 'POST' })).status, 405)
  f.revokeHost(); assert.equal((await fetch(base + '/api/observe/summary', { headers })).status, 409)
})

test('restricted users see only individually authorized scopes and receive no global journal health or hidden record counts', async t => {
  const f = await fixture(t, [event(1), event(2, binding('10002')), event(3, binding(), { scope: { kind: 'host' } }),
    event(4, binding(), { scope: { kind: 'account', account: binding().target.account } })])
  f.permissions.set('observe.host:*', 'denied'); f.permissions.set('connections.read:*', 'denied'); f.permissions.set('bindings.read:10002', 'denied')
  const result = await f.call()
  assert.deepEqual(result.events.map(row => row.id), ['event-1']); assert.deepEqual(result.journal, { available: false })
  assert.deepEqual(result.scan, { truncated: false, invalidRecords: 0, scannedEvents: 1, hostCountersVisible: false })
  assert.equal(f.calls.some(([operation, row]) => operation === 'observe.read' && row?.target.account.id === '10002'), false)
  f.permissions.set('observe.read:10001', 'denied')
  assert.deepEqual((await f.call()).events, [])
})

test('account diagnostics require the global connection directory permission separately from host diagnostics', async t => {
  const f = await fixture(t, [event(1, binding(), { scope: { kind: 'account', account: binding().target.account } }), event(2, binding(), { scope: { kind: 'host' } })])
  f.permissions.set('observe.host:*', 'denied')
  assert.deepEqual((await f.call()).events.map(row => row.id), ['event-1'])
  f.permissions.set('connections.read:*', 'denied'); f.permissions.set('observe.host:*', 'allowed')
  assert.deepEqual((await f.call()).events.map(row => row.id), ['event-2'])
})

test('historical revisions remain attributable to the same owner but never become a current binding link', async t => {
  const f = await fixture(t, [event(1, binding('10001', { revision: 'binding-old' })), event(2)])
  let result = await f.call()
  const old = result.events.find(row => row.id === 'event-1')
  assert.equal(old.currentBinding, false); assert.equal(old.bindingToken, undefined); assert.equal(old.scopeKey, undefined)
  f.rows[0].agentId = 'new-owner'
  result = await f.call(); assert.deepEqual(result.events, [])
})

test('equal binding IDs cannot authorize another account, connection or Persona', async t => {
  const f = await fixture(t, [event(1), event(2, binding('10002')), event(3, binding('10001', { connectionId: 'foreign' })),
    event(4, binding('10001', { personaId: 'foreign' }))])
  f.permissions.set('bindings.read:10002', 'denied')
  assert.deepEqual((await f.call()).events.map(row => row.id), ['event-1'])
})

test('binding changes, host revocation and authentication revocation during asynchronous reads reject the whole result', async t => {
  for (const change of [f => { f.rows[0].revision = 'changed' }, f => f.revokeHost(), f => f.revokeAuth()]) {
    const f = await fixture(t, [event(1)]), original = f.options.read
    f.options.read = async guard => { const result = await original(guard); change(f); return result }
    const service = createStandaloneAgentObserve(f.options)
    await assert.rejects(service.handle(request(), f.context), { code: 'conflict' })
  }
})

test('a permission revoked after the first successful check is rechecked before any response is returned', async t => {
  const f = await fixture(t, [event(1)]), original = f.options.read
  f.options.read = async guard => { const result = await original(guard); f.permissions.set('observe.read:*', 'denied'); return result }
  await assert.rejects(createStandaloneAgentObserve(f.options).handle(request(), f.context), { code: 'conflict' })
})

test('an in-flight per-conversation authorization cannot survive a resolver or directory replacement', async t => {
  const f = await fixture(t, [event(1)]), entered = gate(), release = gate(), original = f.auth.authorize
  f.auth.authorize = async (...args) => { const result = await original(...args); if (args[1] === 'bindings.read' && args[2]) { entered.resolve(); await release.promise } return result }
  const pending = f.call(); await entered.promise; f.rows[0].connectionId = 'rebound'; release.resolve()
  await assert.rejects(pending, { code: 'conflict' })
})

test('invalid requests and unknown authorization states never read the journal', async t => {
  const f = await fixture(t); let reads = 0
  f.options.read = async () => { reads++; return { events: [], truncated: false, invalidRecords: 0 } }
  const service = createStandaloneAgentObserve(f.options)
  for (const fields of [{ limit: '0' }, { limit: '201' }, { outcome: 'delivered' }, { traceId: 'unsafe\ntrace' }, { unknown: 'x' }]) {
    await assert.rejects(service.handle(request(fields), f.context), { code: 'invalid_request' })
  }
  f.permissions.set('observe.read:*', 'unavailable')
  await assert.rejects(service.handle(request(), f.context), { code: 'unavailable' })
  assert.equal(reads, 0)
})

test('async or replaced guard methods cannot grant service or reader authority', async t => {
  const f = await fixture(t, [event(1)])
  for (const context of [
    { ...f.context, isCurrent: async () => true },
    { ...f.context, ensureCurrent: async () => {} },
  ]) {
    await assert.rejects(f.service.handle(request(), context), { code: 'conflict' })
    await assert.rejects(readAgentOperationJournal({ dataDir: f.dataDir, guard: context }))
  }
})

test('reader reports malformed and unknown records and leaves incomplete writer tails untouched', async t => {
  const f = await fixture(t, [event(1)]); await f.journal().close()
  const file = path.join(f.dataDir, 'operations', (await fs.readdir(path.join(f.dataDir, 'operations')))[0])
  await fs.appendFile(file, '{bad json}\n' + JSON.stringify({ ...event(2), privateBody: 'PRIVATE_CONTENT' }) + '\n' + '{"incomplete":')
  const before = await fs.readFile(file), result = await readAgentOperationJournal({ dataDir: f.dataDir, guard: f.context })
  assert.deepEqual(result.events.map(row => row.id), ['event-1']); assert.equal(result.invalidRecords, 2); assert.equal(result.truncated, true)
  assert.equal(JSON.stringify(result).includes('PRIVATE_CONTENT'), false); assert.deepEqual(await fs.readFile(file), before)
})

test('reader rejects symlinks and nonprivate files without reading their bodies', async t => {
  for (const link of [true, false]) {
    const f = await fixture(t, [event(1)]); await f.journal().close()
    const directory = path.join(f.dataDir, 'operations'), file = path.join(directory, (await fs.readdir(directory))[0])
    if (link) { const actual = file + '-actual'; await fs.rename(file, actual); await fs.symlink(actual, file) }
    else await fs.chmod(file, 0o644)
    await assert.rejects(readAgentOperationJournal({ dataDir: f.dataDir, guard: f.context }), error => error.message === '操作日志读取不可用' && !error.message.includes(f.dataDir))
  }
})

test('reader obeys byte and record limits while keeping newest complete records first', async t => {
  const f = await fixture(t, Array.from({ length: 30 }, (_, index) => event(index)))
  const limited = await readAgentOperationJournal({ dataDir: f.dataDir, guard: f.context, maxEvents: 2 })
  assert.deepEqual(limited.events.map(row => row.id), ['event-29', 'event-28']); assert.equal(limited.truncated, true)
  const bounded = await readAgentOperationJournal({ dataDir: f.dataDir, guard: f.context, maxReadBytes: 8192 })
  assert.ok(bounded.events.length < 30); assert.equal(bounded.events[0].id, 'event-29'); assert.equal(bounded.truncated, true); assert.equal(bounded.invalidRecords, 0)
  const traced = await readAgentOperationJournal({ dataDir: f.dataDir, guard: f.context, traceId: 'trace-1', maxEvents: 2 })
  assert.deepEqual(traced.events.map(row => row.id), ['event-1']); assert.equal(traced.truncated, false)
})

test('new journal receipt fields retain closed descriptor validation and no arbitrary content', async t => {
  const f = await fixture(t); let getters = 0
  const receipt = { state: 'sent' }; Object.defineProperty(receipt, 'messageId', { get() { getters++; return 'PRIVATE' } })
  const original = process.stderr.write; process.stderr.write = () => true
  try {
    assert.equal(await f.journal().append(event(1, binding(), { delivery: receipt })), false)
    assert.equal(await f.journal().append(event(2, binding(), { delivery: { state: 'sent', messageId: 'native', body: 'PRIVATE' } })), false)
    assert.equal(await f.journal().append(event(3, binding(), { configurationRevision: 'unsafe\nrevision' })), false)
  } finally { process.stderr.write = original }
  assert.equal(getters, 0); assert.deepEqual((await f.call()).events, [])
})
