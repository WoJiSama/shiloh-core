import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentDiagnostics } from '../dist/backend/modules/runtime/infrastructure/agentDiagnostics.js'

const account = { platform: 'qq', namespace: 'global', id: '10001' }
const binding = { source: 'configured', id: 'scope', revision: 'rev1', agentId: 'daily', personaId: 'default', connectionId: 'main', target: { account, kind: 'group', id: '20001' } }
const quiet = { info() {}, warn() {}, error() {} }

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
  const lines = []; t.mock.method(process.stderr, 'write', line => { lines.push(String(line)); return true })
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
  assert.ok(lines[0].includes('diagnostic_journal_failed'))
})
