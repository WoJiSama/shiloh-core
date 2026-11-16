import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentTools } from '../dist/backend/modules/tools/infrastructure/agentTools.js'

const items = [{ parts: [{ kind: 'text', text: '原文与中文译文' }] }]
function fixture(execute, overrides = {}, timeoutMs) {
  const definition = { name: 'bundleProbe', description: 'Scoped bundle fixture',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    execute, ...(timeoutMs ? { timeoutMs } : {}) }
  return createAgentTools({ builtIn: [definition] }, {
    signal: new AbortController().signal,
    context: () => ({ binding: {}, actor: { kind: 'user' }, isCurrent: () => true, ...overrides }),
  }).getExtraTools(['bundleProbe'])[0]
}

test('bundle delivery owns its data before authorization waits and revokes saved tool contexts', async () => {
  let calls = 0, checks = 0, saved
  const mutable = structuredClone(items)
  const result = await fixture(async (_input, context) => {
    saved = context
    const pending = context.sendBundle(mutable)
    mutable[0].parts[0].text = 'late mutation must never be sent'
    assert.deepEqual(await pending, { state: 'sent', messageId: 'confirmed' })
    return { status: 'succeeded', content: 'sent' }
  }, {
    async ensureCurrent() { checks++ },
    async sendBundle(owned, guard) {
      assert.equal(guard(), true)
      assert.deepEqual(owned, items)
      calls++
      return { state: 'sent', messageId: 'confirmed' }
    },
  }).execute({}, {})
  assert.equal(result.status, 'success')
  assert.equal(calls, 1)
  assert.ok(checks >= 4)
  await assert.rejects(saved.sendBundle(items), /失效/u)
  assert.equal(calls, 1)
})

test('bundle delivery rejects unbounded resources and stored permission revocation before transport', async () => {
  let calls = 0, active = true
  for (const input of [[{ parts: [{ kind: 'image', mime: 'image/png', base64: 'https://evil.example/image' }] }],
    [{ parts: [{ kind: 'text', text: 'x'.repeat(4001) }] }], Array.from({ length: 13 }, () => items[0]),
  ]) {
    const result = await fixture(async (_input, context) => {
      await context.sendBundle(input)
      return { status: 'succeeded', content: 'wrong' }
    }, { async sendBundle() { calls++; return { state: 'sent', messageId: 'wrong' } } }).execute({}, {})
    assert.equal(result.status, 'unknown')
  }
  const revoked = await fixture(async (_input, context) => {
    active = false
    await context.sendBundle(items)
    return { status: 'succeeded', content: 'wrong' }
  }, {
    async ensureCurrent() { if (!active) throw new Error('private stored permission') },
    async sendBundle() { calls++; return { state: 'sent', messageId: 'wrong' } },
  }).execute({}, {})
  assert.equal(revoked.status, 'unknown')
  assert.doesNotMatch(JSON.stringify(revoked), /private stored permission/u)
  assert.equal(calls, 0)
})

test('tool cancellation removes a queued bundle final transport permission', async () => {
  let entered, release, guard, saved
  const started = new Promise(resolve => { entered = resolve })
  const queue = new Promise(resolve => { release = resolve })
  const work = fixture(async (_input, context) => {
    saved = context
    await context.sendBundle(items)
    return { status: 'succeeded', content: 'late result' }
  }, { async sendBundle(_items, check) {
    guard = check
    entered()
    await queue
    return check() ? { state: 'sent', messageId: 'late' } : { state: 'failed', code: 'cancelled' }
  } }, 25).execute({}, {})
  await started
  const keepAlive = setTimeout(() => {}, 1000)
  try {
    assert.equal((await work).status, 'unknown')
    assert.equal(saved.signal.aborted, true)
    assert.equal(guard(), false)
  } finally { release(); clearTimeout(keepAlive) }
})
