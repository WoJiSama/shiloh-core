import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { openAgentOperationJournal } = await load('modules/runtime/infrastructure/agentOperationJournal.js')
const { createAgentDiagnostics } = await load('modules/runtime/infrastructure/agentDiagnostics.js')
const { createAgentSecretTextCheck } = await load('modules/messaging/infrastructure/agentSecretText.js')
const account = { platform: 'qq', namespace: 'global', id: '19000001' }
const binding = () => ({ id: 'binding', revision: 'revision', source: 'configured', agentId: 'daily', personaId: 'default', connectionId: 'main', target: { account: { ...account }, kind: 'group', id: '310001' } })
const event = (index = 1, extra = {}) => ({ version: 1, id: 'event-' + index, traceId: 'trace-' + index, at: 1794816000000, scope: { kind: 'conversation', binding: binding(), messageId: 'message-' + index }, stage: 'tool', operation: 'video.analysis', outcome: 'succeeded', durationMs: 45, ...extra })
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { resolve, promise } }
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-journal-')), opened = []
  t.after(async () => { for (const journal of opened) await journal.close(); await fs.rm(dataDir, { force: true, recursive: true }) })
  return { dataDir, directory: path.join(dataDir, 'operations'), async open(options = {}) { const journal = await openAgentOperationJournal({ dataDir, ...options }); opened.push(journal); return journal } }
}
async function files(directory) { return (await fs.readdir(directory)).filter(name => name.endsWith('.ndjson')).sort() }
async function rows(directory) { const out = []; for (const name of await files(directory)) out.push(...(await fs.readFile(path.join(directory, name), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))); return out }
function captureEmergency(t) { const stderr = []; t.mock.method(process.stderr, 'write', value => { stderr.push(String(value)); return true }); return stderr }

test('journal commits owned structured scopes in private files and close drains pending records', async t => {
  const f = await fixture(t), journal = await f.open(), original = event(1), first = journal.append(original)
  original.scope.binding.target.id = 'mutated'; original.operation = 'mutated'
  assert.equal(await first, true); assert.equal(await journal.append(event(2, { scope: { kind: 'account', account } })), true)
  const last = journal.append(event(3, { scope: { kind: 'host' } })); assert.equal(await journal.close(), true); assert.equal(await last, true); assert.equal(await journal.flush(), true)
  const stored = await rows(f.directory); assert.equal(stored.length, 3); assert.equal(stored[0].scope.binding.target.id, '310001'); assert.equal(stored[0].operation, 'video.analysis'); assert.deepEqual(stored[1].scope.account, account)
  assert.equal((await fs.stat(f.directory)).mode & 0o777, 0o700); for (const name of await files(f.directory)) assert.equal((await fs.stat(path.join(f.directory, name))).mode & 0o777, 0o600)
  assert.deepEqual(journal.health(), { degraded: false, written: 3, failed: 0, lastWrittenAt: journal.health().lastWrittenAt }); assert.ok(journal.health().lastWrittenAt > 0)
})

test('successful append waits for file fsync and a newly created directory entry sync', async t => {
  const f = await fixture(t), journal = await f.open(), original = fs.open, entered = gate(), released = gate(); let fileSyncs = 0, directorySyncs = 0, settled = false
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await original(...args), target = String(args[0]), sync = handle.sync.bind(handle)
    return new Proxy(handle, { get(owner, key) { if (key === 'sync') return async () => { if (target.endsWith('.ndjson')) { fileSyncs++; entered.resolve(); await released.promise } else directorySyncs++; return sync() }; const value = Reflect.get(owner, key, owner); return typeof value === 'function' ? value.bind(owner) : value } })
  })
  const pending = journal.append(event()).then(value => { settled = true; return value }); await entered.promise; assert.equal(settled, false); released.resolve()
  assert.equal(await pending, true); assert.equal(fileSyncs, 1); assert.ok(directorySyncs >= 1)
})

test('a blocked file sync identifies both the syncing event and the queued event, then records both late receipts', async t => {
  const f = await fixture(t), journal = await f.open(), original = fs.open
  const entered = gate(), released = gate(), alerts = [], late = []
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(console, 'error', () => {})
  t.mock.method(console, 'info', line => { late.push(line) })
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await original(...args), sync = handle.sync.bind(handle)
    if (String(args[0]).endsWith('.ndjson')) handle.sync = async () => {
      entered.resolve()
      await released.promise
      await sync()
    }
    return handle
  })
  const diagnostics = createAgentDiagnostics({ sink: journal, onFailure: event => alerts.push(event),
    logger: { info() {}, warn() {}, error() {} } })
  try {
    diagnostics.emit({ stage: 'inbox', operation: 'first_ingest', outcome: 'succeeded' })
    await entered.promise
    diagnostics.emit({ stage: 'inbox', operation: 'queued_ingest', outcome: 'succeeded' })
    await new Promise(resolve => setImmediate(resolve))
    t.mock.timers.tick(5_000)
    await diagnostics.flush()
    assert.equal(late.length, 0)
    assert.deepEqual(alerts.map(row => [row.code, row.outcome, row.details.step, row.details.blockingStep]), [
      ['diagnostic_journal_timeout', 'unknown', 'journal_sync', undefined],
      ['diagnostic_journal_timeout', 'unknown', 'journal_queue', 'journal_sync'],
    ])
    assert.ok(alerts.every(row => row.details.limit === 5_000 && row.details.queueMs >= 0 && row.details.stepMs >= 0))
  } finally {
    released.resolve()
    await journal.flush()
  }
  await new Promise(resolve => setImmediate(resolve))
  const stored = await rows(f.directory)
  assert.deepEqual(stored.map(row => row.operation), ['first_ingest', 'queued_ingest'])
  assert.deepEqual(alerts.map(row => row.details.causeEventId), stored.map(row => row.id))
  assert.equal(late.length, 2)
  for (const [index, line] of late.entries()) {
    assert.match(line, /diagnostic_journal_late_confirmed/u)
    assert.ok(line.includes(`causeEventId=${stored[index].id}`))
  }
})

test('concurrent events share a durable file sync and keep their order', async t => {
  const f = await fixture(t), journal = await f.open(), original = fs.open
  let fileSyncs = 0
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await original(...args), sync = handle.sync.bind(handle)
    if (String(args[0]).endsWith('.ndjson')) handle.sync = async () => { fileSyncs++; await sync() }
    return handle
  })
  const events = Array.from({ length: 24 }, (_, index) => event(index))
  assert.ok((await Promise.all(events.map(item => journal.append(item)))).every(Boolean))
  assert.equal(fileSyncs, 1)
  assert.deepEqual((await rows(f.directory)).map(item => item.id), events.map(item => item.id))
})

test('date and size rotation applies global maxFiles and retention while keeping complete bounded records', async t => {
  const f = await fixture(t); await fs.mkdir(f.directory, { mode: 0o700 })
  const expired = path.join(f.directory, '2000-01-01.000000.ndjson'); await fs.writeFile(expired, JSON.stringify(event()) + '\n', { mode: 0o600 })
  const journal = await f.open({ maxFileBytes: 65536, maxFiles: 2, retentionDays: 1 })
  await assert.rejects(fs.stat(expired), error => error.code === 'ENOENT')
  for (let index = 0; index < 70; index++) { const item = event(index); item.scope.binding.id = 'b'.repeat(4000); assert.equal(await journal.append(item), true) }
  const names = await files(f.directory); assert.equal(names.length, 2); assert.match(names[0], /^\d{4}-\d{2}-\d{2}\.\d{6}\.ndjson$/u)
  for (const name of names) { const file = path.join(f.directory, name); assert.ok((await fs.stat(file)).size <= 65536); assert.ok((await fs.readFile(file, 'utf8')).endsWith('\n')) }
  const stored = await rows(f.directory); assert.ok(stored.length < 70); assert.equal(stored.at(-1).id, 'event-69'); assert.equal(journal.health().written, 70)
})

test('secret-bearing records become fresh safe host events across common encodings with no original scope or identifiers', async t => {
  const f = await fixture(t), secret = 'JOURNAL_PRIVATE_TOKEN_123456', allowsText = createAgentSecretTextCheck([secret]), journal = await f.open({ allowsText })
  for (const [index, value] of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), '\\u004aOURNAL_PRIVATE_TOKEN_123456'].entries()) {
    const item = event(index); item.scope.binding.personaId = value; assert.equal(await journal.append(item), true)
  }
  const stored = await rows(f.directory); assert.equal(stored.length, 4)
  for (const item of stored) { assert.deepEqual(item.scope, { kind: 'host' }); assert.equal(item.code, 'DIAGNOSTIC_REDACTED'); assert.equal(item.operation, 'diagnostic.redacted'); assert.ok(!item.id.startsWith('event-')); assert.equal(allowsText(JSON.stringify(item)), true); assert.equal(JSON.stringify(item).includes('310001'), false) }
})

test('redaction keeps an internal trace and safe failure metadata when only the scope contains protected data', async t => {
  const f = await fixture(t), secret = 'JOURNAL_PRIVATE_FIXTURE_123456'
  const journal = await f.open({ allowsText: createAgentSecretTextCheck([secret]) })
  const traceId = randomUUID(), id = randomUUID()
  const item = event(1, { id, traceId, outcome: 'failed', operation: 'simFinishTurn', code: 'tool_schema_invalid',
    details: { field: 'reason', rule: 'minLength', limit: 1, result: 'not_dispatched' } })
  item.scope.binding.personaId = secret
  assert.equal(await journal.append(item), true)
  const [row] = await rows(f.directory)
  assert.deepEqual(row.scope, { kind: 'host' })
  assert.equal(row.traceId, traceId)
  assert.equal(row.operation, item.operation)
  assert.equal(row.code, item.code)
  assert.equal(row.details.field, 'reason')
  assert.doesNotMatch(JSON.stringify(row), /JOURNAL_PRIVATE_FIXTURE|310001/u)
})

test('closed descriptor validation never evaluates getters or persists free-form errors, unsafe tokens or arbitrary fields', async t => {
  const f = await fixture(t), emergency = [], stderr = captureEmergency(t), journal = await f.open({ onEmergency: (...args) => emergency.push(args) }); let accessed = false
  const getter = event(); Object.defineProperty(getter, 'operation', { get() { accessed = true; throw Error('PRIVATE_GETTER') } })
  const nested = event(); Object.defineProperty(nested.scope.binding.target.account, 'id', { get() { accessed = true; throw Error('PRIVATE_NESTED') } })
  for (const item of [getter, nested, { ...event(), detail: 'PRIVATE_ERROR_BODY' }, { ...event(), error: new Error('PRIVATE') }, event(1, { operation: 'https://private/path' }), event(1, { code: 'bad\nline' }), event(1, { durationMs: -1 }), event(1, { httpStatus: 999 }), event(1, { scope: { kind: 'host', account } }), Object.assign(Object.create({}), event())]) assert.equal(await journal.append(item), false)
  assert.equal(accessed, false); assert.deepEqual(await rows(f.directory), []); assert.equal(journal.health().failed, 10); assert.equal(journal.health().degraded, true); assert.equal(await journal.flush(), false)
  assert.ok(emergency.every(([safe, code]) => safe === undefined && code === 'JOURNAL_INVALID_EVENT')); assert.equal(stderr.join('').includes('PRIVATE'), false)
  assert.equal(await journal.append(event(2, { outcome: 'failed', code: 'runtime_warning', sourceTag: '海龟汤' })), true)
  assert.equal((await rows(f.directory)).find(row => row.id === 'event-2').sourceTag, '海龟汤')
  for (const badTag of ['bad<script>', 'x'.repeat(25), 42]) assert.equal(await journal.append(event(3, { sourceTag: badTag })), false)
})

test('factory and nested event proxies fail without invoking any proxy trap', async t => {
  const f = await fixture(t), stderr = captureEmergency(t); let traps = 0
  const proxy = value => new Proxy(value, { get() { traps++; throw Error('PRIVATE_PROXY') }, ownKeys() { traps++; throw Error('PRIVATE_PROXY') }, getPrototypeOf() { traps++; throw Error('PRIVATE_PROXY') }, getOwnPropertyDescriptor() { traps++; throw Error('PRIVATE_PROXY') } })
  await assert.rejects(openAgentOperationJournal(proxy({ dataDir: f.dataDir })), /操作日志不可用/u)
  const journal = await f.open()
  for (const part of ['root', 'scope', 'binding', 'target', 'account']) {
    const item = event()
    if (part === 'root') assert.equal(await journal.append(proxy(item)), false)
    else { const parent = part === 'scope' ? item : part === 'binding' ? item.scope : part === 'target' ? item.scope.binding : item.scope.binding.target; parent[part] = proxy(parent[part]); assert.equal(await journal.append(item), false) }
  }
  assert.equal(traps, 0); assert.deepEqual(await rows(f.directory), []); assert.equal(stderr.join('').includes('PRIVATE_PROXY'), false)
})

test('bounded pending queue reports overflow safely without abandoning admitted writes', async t => {
  const f = await fixture(t), stderr = captureEmergency(t), emergency = [], journal = await f.open({ onEmergency: (...args) => emergency.push(args) })
  const results = await Promise.all(Array.from({ length: 300 }, (_, index) => journal.append(event(index))))
  assert.equal(results.filter(Boolean).length, 256); assert.equal(results.filter(value => !value).length, 44); assert.equal((await rows(f.directory)).length, 256)
  assert.deepEqual(journal.health(), { degraded: true, written: 256, failed: 44, lastWrittenAt: journal.health().lastWrittenAt }); assert.equal(await journal.close(), false)
  assert.ok(emergency.every(([safe, code]) => safe?.version === 1 && code === 'JOURNAL_OVERFLOW')); assert.match(stderr.join(''), /JOURNAL_OVERFLOW/u)
})

test('write and fsync failures return false, expose fixed emergency metadata and keep health and close degraded', async t => {
  const f = await fixture(t), stderr = captureEmergency(t), emergency = [], journal = await f.open({ onEmergency(safe, code) { emergency.push([safe, code]); throw Error('PRIVATE_EMERGENCY') } }), original = fs.open
  t.mock.method(fs, 'open', async (...args) => {
    if (!String(args[0]).endsWith('.ndjson')) return original(...args)
    const handle = await original(...args)
    return new Proxy(handle, { get(owner, key) { if (key === 'sync') return async () => { throw Error('PRIVATE_FS_KEY /private/local/path') }; const value = Reflect.get(owner, key, owner); return typeof value === 'function' ? value.bind(owner) : value } })
  })
  assert.equal(await journal.append(event()), false); assert.equal(await journal.flush(), false); assert.equal(await journal.close(), false); assert.equal(journal.health().written, 0); assert.equal(journal.health().failed, 1)
  assert.equal(emergency.length, 1); assert.equal(emergency[0][1], 'JOURNAL_WRITE_FAILED'); assert.equal(stderr.join('').includes('PRIVATE'), false); assert.equal(stderr.join('').includes('/private/local'), false)
})

test('directory replacement or a closed journal cannot silently accept further records', async t => {
  const f = await fixture(t), stderr = captureEmergency(t), journal = await f.open(); await fs.rename(f.directory, f.directory + '-original'); await fs.mkdir(f.directory, { mode: 0o700 })
  assert.equal(await journal.append(event()), false); assert.equal(journal.health().failed, 1); assert.equal(await journal.close(), false)
  assert.equal(await journal.append(event(2)), false); assert.equal(journal.health().failed, 2); assert.match(stderr.join(''), /JOURNAL_CLOSED/u); assert.deepEqual(await rows(f.directory), [])
})

test('startup rejects symlink roots, journal directories, named files and nonprivate or multiply linked files', async t => {
  const f = await fixture(t), stderr = captureEmergency(t), actual = path.join(f.dataDir, 'actual'); await fs.mkdir(actual)
  const linkedRoot = path.join(f.dataDir, 'linked-root'); await fs.symlink(actual, linkedRoot)
  await assert.rejects(openAgentOperationJournal({ dataDir: linkedRoot }), /操作日志不可用/u)
  await fs.symlink(actual, f.directory); await assert.rejects(f.open(), /操作日志不可用/u); await fs.unlink(f.directory); await fs.mkdir(f.directory, { mode: 0o700 })
  const target = path.join(actual, 'private.ndjson'), named = path.join(f.directory, '2026-11-16.000000.ndjson'); await fs.writeFile(target, 'unchanged', { mode: 0o600 }); await fs.symlink(target, named)
  await assert.rejects(f.open(), /操作日志不可用/u); await fs.unlink(named); await fs.link(target, named); await assert.rejects(f.open(), /操作日志不可用/u); await fs.unlink(named)
  await fs.writeFile(named, '{}\n', { mode: 0o644 }); await assert.rejects(f.open(), /操作日志不可用/u); assert.equal(await fs.readFile(target, 'utf8'), 'unchanged'); assert.equal(stderr.join('').includes(target), false)
})

test('startup repairs an incomplete tail before appending and preserves all complete historical records', async t => {
  const f = await fixture(t); await fs.mkdir(f.directory, { mode: 0o700 }); const name = new Date().toISOString().slice(0, 10) + '.000000.ndjson', file = path.join(f.directory, name), kept = event(1)
  await fs.writeFile(file, JSON.stringify(kept) + '\n' + '{"private-uncommitted":' + 'x'.repeat(20000), { mode: 0o600 })
  const journal = await f.open(); assert.equal(await fs.readFile(file, 'utf8'), JSON.stringify(kept) + '\n'); assert.equal(await journal.append(event(2)), true)
  assert.deepEqual((await rows(f.directory)).map(item => item.id), ['event-1', 'event-2']); assert.equal(journal.health().degraded, false)
})

test('factory descriptor and rotation config validation are closed, bounded and generic', async t => {
  const f = await fixture(t); let accessed = false; const getter = { dataDir: f.dataDir }; Object.defineProperty(getter, 'maxFiles', { get() { accessed = true; throw Error('PRIVATE_CONFIG') } })
  for (const value of [getter, { dataDir: f.dataDir, other: true }, { dataDir: f.dataDir, maxFileBytes: 65535 }, { dataDir: f.dataDir, maxFiles: 0 }, { dataDir: f.dataDir, retentionDays: 366 }, { dataDir: f.dataDir, allowsText: 'yes' }]) await assert.rejects(openAgentOperationJournal(value), error => error.message === '操作日志不可用')
  assert.equal(accessed, false)
})

test('same-directory writers conflict without stealing ownership and a closed writer permits a new session', async t => {
  const f = await fixture(t), stderr = captureEmergency(t), first = await f.open()
  await assert.rejects(f.open(), /操作日志不可用/u)
  assert.equal(await first.append(event(1)), true); assert.equal(await first.close(), true)
  const next = await f.open(); assert.equal(await next.append(event(2)), true); assert.equal(await next.close(), true)
  assert.deepEqual((await rows(f.directory)).map(item => item.id), ['event-1', 'event-2']); assert.match(stderr.join(''), /JOURNAL_OPEN_FAILED/u)
})
