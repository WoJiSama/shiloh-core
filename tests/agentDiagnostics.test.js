import assert from 'node:assert/strict'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
const { createAgentDiagnostics, annotateAgentError } = await load('modules/runtime/infrastructure/agentDiagnostics.js')

const account = { platform: 'qq', namespace: 'global', id: '10001' }
const binding = { source: 'configured', id: 'scope', revision: 'rev1', agentId: 'daily', personaId: 'default', connectionId: 'main', target: { account, kind: 'group', id: '20001' } }
const quiet = { info() {}, warn() {}, error() {} }

test('diagnostics link nested failures without hiding unrelated failures from the same trace', async () => {
  const rows = [], alerts = []
  const d = createAgentDiagnostics({ sink: { async append(event) { rows.push(event); return true } },
    logger: quiet, onFailure: event => alerts.push(event) })
  const scope = { kind: 'host' }
  const failure = annotateAgentError(new Error('private redis key'), { step: 'list', cause: 'redis_command_queue_timeout' })
  await d.withScope(scope, 'periodic_check', async () => {
    d.emit({ stage: 'host', operation: 'redis_command', outcome: 'failed', error: failure, code: 'redis_command_queue_timeout' })
    d.emitFailure({ stage: 'runtime', operation: 'torrent_tick', outcome: 'failed', error: failure, code: 'tick_failed' })
    await assert.rejects(d.run(scope, 'separate_failure', async () => { throw new Error('different private exception') }))
  })
  await d.flush()
  const report = rows.find(event => event.operation === 'torrent_tick')
  assert.equal(report.details.causeEventId, rows[0].id)
  assert.equal(report.details.step, 'list')
  assert.deepEqual(alerts.map(event => event.operation), ['redis_command', 'separate_failure'])
  assert.doesNotMatch(JSON.stringify(rows), /private/)
})

test('diagnostics correlate nested model and delivery operations while isolating concurrent turns', async () => {
  const rows = [], d = createAgentDiagnostics({ sink: { async append(event) { rows.push(event); return true } }, logger: quiet })
  await Promise.all(['1', '2'].map(messageId => d.run({ kind: 'conversation', binding, messageId }, 'text_turn', async () => {
    await new Promise(resolve => setImmediate(resolve))
    await d.run(d.scope(), 'provider_http', async () => ({ error: 'secret provider response' }), 'model')
    return await d.run(d.scope(), 'send', async () => ({ state: 'unknown' }), 'delivery')
  }, 'inbox')))
  await d.flush()
  assert.equal(new Set(rows.map(row => row.traceId)).size, 2)
  for (const messageId of ['1', '2']) {
    const events = rows.filter(row => row.scope.messageId === messageId)
    assert.equal(events.length, 6); assert.equal(new Set(events.map(row => row.traceId)).size, 1)
    assert.ok(events.some(row => row.stage === 'model' && row.outcome === 'failed'))
    assert.ok(events.some(row => row.stage === 'delivery' && row.outcome === 'unknown'))
  }
  assert.ok(!JSON.stringify(rows).includes('secret provider response'))
})

test('real delivery receipts and the immutable loaded configuration accompany only delivery events', async () => {
  const rows = [], d = createAgentDiagnostics({ configurationRevision: 'configuration:loaded-v1', logger: quiet,
    sink: { async append(event) { rows.push(event); return true } } })
  for (const receipt of [{ state: 'sent', messageId: 'native-17' }, { state: 'unknown' }, { state: 'failed', code: 'native_rejected' }]) {
    await d.run({ kind: 'conversation', binding, messageId: 'source-1' }, 'send', async () => ({ ...receipt, body: 'PRIVATE_RESPONSE' }), 'delivery')
  }
  await d.run({ kind: 'conversation', binding, messageId: 'source-1' }, 'tool', async () => ({ state: 'confirmed', messageId: 'not-a-delivery' }), 'tool')
  await d.flush()
  assert.ok(rows.every(row => row.configurationRevision === 'configuration:loaded-v1'))
  const completed = rows.filter(row => row.stage === 'delivery' && row.outcome !== 'started')
  assert.deepEqual(completed.map(row => row.delivery), [{ state: 'sent', messageId: 'native-17' }, { state: 'unknown' }, { state: 'failed', code: 'native_rejected' }])
  assert.deepEqual(completed.map(row => row.outcome), ['succeeded', 'unknown', 'failed'])
  assert.equal(rows.some(row => row.stage === 'tool' && row.delivery), false)
  assert.equal(JSON.stringify(rows).includes('PRIVATE_RESPONSE'), false)
})

test('nested traces distinguish identical binding IDs across accounts, owners, connections and binding versions', async () => {
  const rows = [], d = createAgentDiagnostics({ logger: quiet, sink: { async append(event) { rows.push(event); return true } } })
  const variants = [
    { ...binding, target: { ...binding.target, account: { ...account, id: '10002' } } },
    { ...binding, agentId: 'other' }, { ...binding, personaId: 'other' }, { ...binding, connectionId: 'other' },
    { ...binding, revision: 'rev2' }, { ...binding, target: { ...binding.target, id: 'other-group' } },
  ]
  await d.run({ kind: 'conversation', binding, messageId: 'source' }, 'parent', async () => {
    const original = d.traceId()
    await d.run({ kind: 'conversation', binding }, 'same', async () => { assert.equal(d.traceId(), original); assert.equal(d.scope().messageId, 'source') })
    for (const next of variants) await d.run({ kind: 'conversation', binding: next, messageId: 'source' }, 'different', async () => assert.notEqual(d.traceId(), original))
    await d.run({ kind: 'account', account }, 'account', async () => assert.notEqual(d.traceId(), original))
  })
  await d.flush()
  assert.equal(new Set(rows.map(row => row.traceId)).size, variants.length + 2)
})

test('receipt classification never invokes getters or Proxy traps', async () => {
  let traps = 0
  const rows = [], d = createAgentDiagnostics({ logger: quiet, sink: { async append(event) { rows.push(event); return true } } })
  const getter = Object.defineProperty({}, 'state', { get() { traps++; throw new Error('PRIVATE') } })
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { traps++; throw new Error('PRIVATE') }, getPrototypeOf() { traps++; throw new Error('PRIVATE') } })
  for (const value of [getter, proxy]) await d.run({ kind: 'host' }, 'send', async () => value, 'delivery')
  await d.flush()
  assert.equal(traps, 0); assert.equal(rows.some(row => row.delivery), false)
})

test('runtime warnings expose only a sanitized bracketed source tag, never the message body', async () => {
  const rows = [], d = createAgentDiagnostics({ sink: { async append(event) { rows.push(event); return true } }, logger: quiet })
  d.logger.warn('[海龟汤] 超时检查失败: /private/path?token=SECRET')
  d.logger.warn('[MCP] 服务器 x 连接异常')
  d.logger.warn('no leading label stays tag-free even with [brackets] later')
  d.logger.warn('[bad tag<script>alert(1)</script>] ignored')
  d.logger.warn('[over-long-' + 'x'.repeat(30) + '] ignored')
  await d.flush()
  const warnings = rows.filter(row => row.code === 'runtime_warning')
  assert.deepEqual(warnings.map(row => row.sourceTag), ['海龟汤', 'MCP', undefined, undefined, undefined])
  assert.ok(!/SECRET|private\/path|服务器 x|brackets|script/u.test(JSON.stringify(warnings)))
})

test('compatibility logger never persists raw exceptions, content or credential-bearing first arguments', async () => {
  const rows = [], d = createAgentDiagnostics({ sink: { async append(event) { rows.push(event); return true } }, logger: quiet })
  await d.run({ kind: 'conversation', binding, messageId: '1' }, 'text_turn', async () => {
    d.logger.error('Authorization: bearer PRIVATE_KEY and user text', new TypeError('secret-url?signature=ABC'))
    d.logger.warn('another body', new Error('raw private exception'))
  })
  await d.flush()
  assert.equal(rows.find(row => row.code === 'runtime_error').errorKind, 'TypeError')
  assert.ok(!/PRIVATE_KEY|user text|secret-url|signature|raw private|another body/u.test(JSON.stringify(rows)))
})

test('hostile exception objects cannot run getters or Proxy traps during safe classification', async () => {
  const rows = [], d = createAgentDiagnostics({ sink: { async append(event) { rows.push(event); return true } }, logger: quiet }); let traps = 0
  const proxy = new Proxy({}, { get() { traps++; throw new Error('trap') }, getPrototypeOf() { traps++; throw new Error('trap') }, getOwnPropertyDescriptor() { traps++; throw new Error('trap') } })
  const getter = Object.defineProperty({}, 'name', { get() { traps++; throw new Error('getter') } })
  d.emit({ stage: 'tool', operation: 'tool', outcome: 'failed', error: proxy })
  d.emit({ stage: 'tool', operation: 'tool', outcome: 'failed', error: getter })
  await d.flush(); assert.equal(traps, 0); assert.equal(rows[0].errorKind, 'Unknown')
})

test('sink rejection and false acknowledgements remain visible without recursive logging or operation replay', async t => {
  const lines = []; t.mock.method(process.stderr, 'write', line => { lines.push(String(line)); return true }); let calls = 0
  const d = createAgentDiagnostics({ sink: { async append() { calls++; if (calls === 1) throw new Error('PRIVATE_FS_PATH'); return false } }, logger: quiet })
  let actions = 0
  const result = await d.run({ kind: 'host' }, 'task', async () => { actions++; return 42 })
  await d.flush(); assert.equal(result, 42); assert.equal(actions, 1); assert.equal(calls, 2)
  assert.equal(lines.length, 2); assert.ok(lines.every(line => line.includes('diagnostic_journal_failed'))); assert.ok(!lines.join('').includes('PRIVATE_FS_PATH'))
})

test('stalled sink admission stays bounded and resumes after queued writes settle', async t => {
  const lines = []; t.mock.method(process.stderr, 'write', line => { lines.push(String(line)); return true })
  let calls = 0, release
  const stalled = new Promise(resolve => { release = resolve })
  const d = createAgentDiagnostics({ logger: quiet, sink: { async append() { calls++; await stalled; return true } } })
  try {
    for (let i = 0; i < 300; i++) d.emit({ stage: 'runtime', operation: 'burst', outcome: 'succeeded' })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls, 256)
    assert.equal(lines.length, 44)
    assert.ok(lines.every(line => line.includes('diagnostic_queue_overflow')))
  } finally {
    release()
    await d.flush()
  }
  d.emit({ stage: 'runtime', operation: 'after_burst', outcome: 'succeeded' })
  await d.flush()
  assert.equal(calls, 257)
})

test('DOMException classification bypasses hostile instance name getters and preserves cancellation', async () => {
  const rows = [], d = createAgentDiagnostics({ logger: quiet, sink: { async append(event) { rows.push(event); return true } } })
  let getterCalls = 0
  const hostile = name => Object.defineProperty(new DOMException('PRIVATE_EXCEPTION_BODY', name), 'name', {
    get() { getterCalls++; throw new Error('PRIVATE_GETTER_BODY') },
  })
  const abort = hostile('AbortError'), timeout = hostile('TimeoutError')
  assert.doesNotThrow(() => d.emit({ stage: 'tool', operation: 'cancelled_tool', outcome: 'cancelled', error: abort }))
  assert.doesNotThrow(() => d.emit({ stage: 'tool', operation: 'timed_out_tool', outcome: 'failed', error: timeout }))
  await assert.rejects(d.run({ kind: 'host' }, 'cancelled_task', async () => { throw abort }), error => error === abort)
  await d.flush()
  assert.equal(getterCalls, 0)
  assert.equal(rows.find(row => row.operation === 'cancelled_tool').errorKind, 'AbortError')
  assert.equal(rows.find(row => row.operation === 'timed_out_tool').errorKind, 'TimeoutError')
  assert.equal(rows.find(row => row.code === 'operation_exception').outcome, 'cancelled')
  assert.ok(!JSON.stringify(rows).includes('PRIVATE_'))
})

test('stalled sink times out visibly so flush completes without waiting for the underlying sink', async t => {
  const lines = []
  t.mock.method(console, 'error', line => {
    if (typeof line === 'string' && line.startsWith('[Agent] ')) lines.push(line)
  })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0, flushFinished = false
  const d = createAgentDiagnostics({ logger: quiet, sink: { append() { calls++; return new Promise(() => {}) } } })
  d.emit({ stage: 'runtime', operation: 'stalled_write', outcome: 'succeeded' })
  const flushing = d.flush().then(() => { flushFinished = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
  t.mock.timers.tick(4_999)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(flushFinished, false)
  assert.equal(lines.length, 0)
  t.mock.timers.tick(1)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(flushFinished, true)
  await flushing
  assert.equal(calls, 1)
  assert.equal(lines.length, 1)
  assert.ok(lines[0].includes('diagnostic_journal_timeout'))
})

test('a timeout after journal acknowledgement reports traffic separately', async t => {
  const alerts = [], lines = []
  let at = 0
  t.mock.method(performance, 'now', () => at)
  t.mock.method(console, 'error', () => {})
  t.mock.method(console, 'info', line => { lines.push(line) })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let release
  const counter = new Promise(resolve => { release = resolve })
  const diagnostics = createAgentDiagnostics({ logger: quiet, onFailure: event => alerts.push(event), sink: {
    async append(_event, observe) {
      observe('journal_sync')
      at = 4_900
      observe('traffic_counter')
      await counter
      return true
    },
  } })
  try {
    diagnostics.emit({ stage: 'inbox', operation: 'inbound_message', outcome: 'succeeded' })
    await new Promise(resolve => setImmediate(resolve))
    at = 5_000
    t.mock.timers.tick(5_000)
    await diagnostics.flush()
    assert.deepEqual(alerts.map(event => [event.operation, event.code, event.details.step]), [
      ['traffic_counter', 'diagnostic_traffic_timeout', 'traffic_counter'],
    ])
    assert.equal(alerts[0].details.stepMs, 100)
    assert.equal(alerts[0].details.slowestCompletedStep, 'journal_sync')
    assert.equal(alerts[0].details.slowestCompletedStepMs, 4_900)
  } finally { release() }
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(lines.length, 1)
  assert.match(lines[0], /diagnostic_traffic_late_settled/u)
})
