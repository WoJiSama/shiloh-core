import test from 'node:test'
import assert from 'node:assert/strict'
import { sideLLMCall } from '../../src/adapters/sideLLM.js'
import { ThinkingProcessor } from '../../src/modules/models/domain/thinkingProcessor.js'
import { sanitizeJsonValue, safeTruncateUnicode } from '../../src/modules/models/domain/unicodeText.js'

test('side channel transport preserves request fields and validates empty responses', async () => {
  const fetchImpl: typeof fetch = async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), { model: 'fixture', messages: [{ role: 'user', content: 'test' }], temperature: 0.2, max_tokens: 8 })
    return Response.json({ choices: [{ message: { content: ' ok ' } }] })
  }
  const input = { url: 'https://fixture.invalid', apikey: 'fixture', model: 'fixture', messages: [{ role: 'user', content: 'test' }], maxTokens: 8 }
  assert.deepEqual(await sideLLMCall({ ...input, fetchImpl }), { ok: true, content: 'ok' })
  const failureCases: [Response, string][] = [
    [Response.json({ choices: [] }), 'model_response_envelope_invalid'],
    [Response.json({ choices: [{ message: { content: '' } }] }), 'model_response_empty'],
    [Response.json({ choices: [{ message: { content: null }, finish_reason: 'length' }] }), 'model_response_truncated'],
    [Response.json({ choices: [{ message: { content: null, refusal: 'private-refusal' } }] }), 'model_response_refused'],
    [new Response('invalid-private-response'), 'model_response_body_invalid'],
  ]
  for (const [response, code] of failureCases) {
    const failure = await sideLLMCall({ ...input, fetchImpl: async () => response })
    assert.ok(!failure.ok)
    assert.equal(failure.status, 200)
    assert.equal(failure.code, code)
    if (failure.code === 'model_response_truncated') assert.equal(failure.limit, 8)
    assert.doesNotMatch(JSON.stringify(failure), /private/)
  }
})
test('pre-cancelled side channel requests never invoke transport', async () => {
  const controller = new AbortController()
  controller.abort()
  const result = await sideLLMCall({ url: 'https://fixture.invalid', apikey: 'fixture', model: 'fixture', messages: [{ role: 'user', content: 'test' }], signal: controller.signal,
    fetchImpl: async () => { assert.fail('cancelled request must not be sent') } })
  assert.deepEqual(result, { ok: false, code: 'provider_cancelled', error: '模型请求已取消' })
})
test('side model transport checks a captured session after preparing the request and after reading the provider response', async () => {
  const input = { url: 'https://fixture.invalid', apikey: 'fixture', model: 'fixture' }
  const revoked = { ok: false, code: 'model_source_changed', error: '角色绑定已改变，模型请求已停止' }
  let current = true
  const result = await sideLLMCall({ ...input, isCurrent: () => current,
    messages: [{ role: 'user', content: { toJSON() { current = false; return 'test' } } }],
    fetchImpl: async () => { assert.fail('stale request must not be sent') },
  })
  assert.deepEqual(result, revoked)

  current = true
  const response = sideLLMCall({ ...input, isCurrent: () => current, messages: [{ role: 'user', content: 'test' }],
    fetchImpl: async () => {
      const pending = new Response(null, { status: 400 })
      pending.text = async () => { current = false; return 'provider error with stale content' }
      return pending
    },
  })
  assert.deepEqual(await response, revoked)
})
test('thinking removal and Unicode normalization preserve visible text', () => {
  assert.equal(ThinkingProcessor.removeThinking('<think>hidden</think> visible'), 'visible')
  assert.equal(safeTruncateUnicode('😀a', 1), '😀')
  assert.deepEqual(sanitizeJsonValue({ content: '\ud800' }), { content: '�' })
  const cycle: { self?: unknown } = {}; cycle.self = cycle
  assert.deepEqual(sanitizeJsonValue(cycle), { self: null })
})

test('model deadline covers stalled body after immediate headers and preserves cancellation reason', async () => {
  const { createFetchWithTimeout } = await import('../../src/adapters/modelFetch.js')
  const transport = createFetchWithTimeout(async () => new Response(new ReadableStream({ start() {} })))
  await assert.rejects(transport('https://fixture.invalid', {}, 10), /请求超过/)
  const controller = new AbortController()
  const reason = new Error('user stopped body')
  const pending = transport('https://fixture.invalid', { signal: controller.signal }, 1000)
  setTimeout(() => controller.abort(reason), 10)
  await assert.rejects(pending, error => error === reason)
  const noContent = createFetchWithTimeout(async () => new Response(null, { status: 204 }))
  assert.equal((await noContent('https://fixture.invalid')).status, 204)
})
