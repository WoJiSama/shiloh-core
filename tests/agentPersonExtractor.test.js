import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { createAgentPersonExtractor } from '../dist/backend/modules/memory/infrastructure/agentPersonExtractor.js'
import { buildPersonProfileExtractPrompt } from '../dist/backend/modules/simulation/domain/personProfile.js'

const apiKey = 'person-extractor-private-key-123456'
const config = { baseUrl: 'https://extract.example.com/v1', name: 'person-fixture', apiKey }
const messages = [{ userId: 'member-one', name: '作者', text: '我一直很喜欢爵士乐' }]
const raw = ' [ { "userId": "member-one", "entries": [] } ] '
const FAILURE = '人物事实抽取失败：请求已取消、授权失效或模型服务不可用。'
function context(overrides = {}) {
  return {
    target: { account: { platform: 'private-platform', namespace: 'private-namespace', id: 'private-account' }, kind: 'group', id: 'private-scene' },
    binding: { source: 'configured', id: 'private-binding', agentId: 'private-agent', revision: 'private-revision', personaId: 'private-persona', connectionId: 'private-connection' },
    signal: new AbortController().signal, isCurrent: () => true, ensureCurrent: async () => {}, ...overrides,
  }
}
function answer(content = raw, extra = {}, init) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], ...extra }), init)
}
function extractor(options = {}) { return createAgentPersonExtractor({ ...config, ...options }) }
async function rejected(operation) {
  await assert.rejects(operation, error => {
    assert.equal(error.message, FAILURE)
    assert.equal(error.cause, undefined)
    return true
  })
}
async function listen(t, handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return `http://127.0.0.1:${server.address().port}`
}

test('person extractor uses real JSON HTTP with only bounded author/text prompts and records valid usage', async t => {
  const received = [], usage = []
  const baseUrl = await listen(t, async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    received.push({ path: request.url, method: request.method, authorization: request.headers.authorization, body: JSON.parse(body) })
    response.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ choices: [{ message: { content: raw } }], usage: { prompt_tokens: 4, completion_tokens: 0, total_tokens: 4, hidden: 99 } }))
  })
  const input = Array.from({ length: 45 }, (_, index) => ({ userId: `member-${index}`, name: '名字'.repeat(20), text: `${index}:我一直喜欢爵士乐${'。'.repeat(500)}`, nativeEvent: { scope: 'private-native-event' } }))
  const result = await extractor({ baseUrl: `${baseUrl}/v1` })(input, () => true, context({ recordUsage: (...args) => usage.push(args) }))
  assert.equal(result, raw, 'the runtime receives the original array string for parsing and grounding')
  const prompt = buildPersonProfileExtractPrompt(input)
  assert.deepEqual(received, [{ path: '/v1/chat/completions', method: 'POST', authorization: `Bearer ${apiKey}`, body: {
    model: config.name, messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }], stream: false, max_tokens: 2000,
  } }])
  const rows = JSON.parse(received[0].body.messages[1].content)
  assert.equal(rows.length, 40)
  assert.equal(rows[0].userId, 'member-5')
  assert.equal(rows[0].sourceIndex, 1)
  assert.equal(rows[39].sourceIndex, 40)
  for (const row of rows) {
    assert.deepEqual(Object.keys(row), ['sourceIndex', 'userId', 'name', 'text'])
    assert.equal(row.name.length, 20)
    assert.equal(row.text.length, 400)
  }
  assert.doesNotMatch(JSON.stringify(received[0].body), /private-|person-extractor-private|nativeEvent/u)
  assert.deepEqual(usage, [[config.name, { prompt_tokens: 4, completion_tokens: 0, total_tokens: 4 }]])
})

test('person extraction requires scoped context and current synchronous/async authorization before any request', async () => {
  let calls = 0
  const run = extractor({ fetchImpl: async () => { calls++; return answer() } })
  await rejected(run(messages))
  await rejected(run(messages, () => false, context()))
  await rejected(run(messages, undefined, context({ isCurrent: () => false })))
  await rejected(run(messages, undefined, context({ signal: AbortSignal.abort() })))
  await rejected(run(messages, undefined, context({ async ensureCurrent() { throw new Error('private-revocation-detail') } })))
  assert.equal(calls, 0)
  assert.equal(await run([], undefined, context()), '[]')
  assert.equal(calls, 0)
})

test('person extraction accepts a fixed completion URL but refuses credential-bearing or invalid endpoint configuration', async () => {
  let calls = 0
  const fetchImpl = async (url, init) => {
    calls++; assert.equal(url, 'https://extract.example.com/custom/chat/completions')
    assert.equal(init.redirect, 'error')
    return answer()
  }
  assert.equal(await extractor({ baseUrl: 'https://extract.example.com/custom/chat/completions', fetchImpl })(messages, undefined, context()), raw)
  for (const options of [
    { baseUrl: 'file:///tmp/private' }, { baseUrl: 'https://u:p@extract.example.com/v1' },
    { baseUrl: 'https://extract.example.com/v1?token=private' }, { baseUrl: 'https://extract.example.com/v1#private' },
    { name: ' ' }, { apiKey: '' },
  ]) await rejected(extractor({ ...options, fetchImpl })(messages, undefined, context()))
  assert.equal(calls, 1)
})

test('person extraction checks author/name/text credentials before trimming input', async () => {
  let calls = 0
  const extraSecret = 'other-host-secret-123456'
  const run = extractor({ secrets: [extraSecret], fetchImpl: async () => { calls++; return answer() } })
  for (const message of [
    { ...messages[0], userId: apiKey },
    { ...messages[0], name: `${'名'.repeat(30)}${apiKey}` },
    { ...messages[0], text: `${'文'.repeat(450)}${extraSecret}` },
    { ...messages[0], text: Buffer.from(apiKey).toString('base64') },
    { ...messages[0], text: [...apiKey].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('') },
  ]) await rejected(run([message], undefined, context()))
  for (const input of [null, [null], [{ ...messages[0], text: 4 }]]) await rejected(run(input, undefined, context()))
  assert.equal(calls, 0)
})

test('person extraction refuses real redirects without forwarding credentials or retrying', async t => {
  let calls = 0, targetCalls = 0
  const baseUrl = await listen(t, (request, response) => {
    calls++
    if (request.url === '/trap') { targetCalls++; response.end(apiKey); return }
    response.writeHead(307, { location: '/trap' }).end('private-redirect-body')
  })
  await rejected(extractor({ baseUrl })(messages, undefined, context()))
  assert.equal(calls, 1)
  assert.equal(targetCalls, 0)
})

test('person extraction suppresses provider bodies, credentials and all tool/function calls', async () => {
  const extraSecret = 'other-host-secret-123456'
  const encoded = [...apiKey].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')
  for (const fetchImpl of [
    async () => { throw new Error(`private-provider-detail ${apiKey}`) },
    async () => new Response(`private-provider-body ${apiKey}`, { status: 500 }),
    async () => answer(raw, { error: { message: apiKey } }),
    async () => answer(JSON.stringify([{ fact: apiKey }])),
    async () => answer(JSON.stringify([{ fact: extraSecret }])),
    async () => answer(`[ { "fact": "${encoded}" } ]`),
    async () => answer(JSON.stringify([{ fact: Buffer.from(apiKey).toString('base64') }])),
    async () => answer(raw, { choices: [{ message: { content: raw, tool_calls: [] } }] }),
    async () => answer(raw, { choices: [{ message: { content: raw, function_call: null } }] }),
    async () => { const response = answer(); Object.defineProperty(response, 'redirected', { value: true }); return response },
  ]) {
    let calls = 0
    await rejected(extractor({ secrets: [extraSecret], fetchImpl: (...args) => { calls++; return fetchImpl(...args) } })(messages, undefined, context()))
    assert.equal(calls, 1)
  }
})

test('person extraction returns only strict JSON arrays within its character bound', async () => {
  for (const content of ['not JSON', '{}', 'null', '```json\n[]\n```', 'prefix []', JSON.stringify([{ fact: '文'.repeat(64_000) }])]) {
    await rejected(extractor({ fetchImpl: async () => answer(content) })(messages, undefined, context()))
  }
  const maximum = `["${'文'.repeat(63_996)}"]`
  assert.equal(maximum.length, 64_000)
  assert.equal(await extractor({ fetchImpl: async () => answer(maximum) })(messages, undefined, context()), maximum)
  assert.equal(await extractor({ fetchImpl: async () => answer('[]') })(messages, undefined, context()), '[]')
})

test('person extraction records valid usage before async revocation or invalid provider content', async () => {
  for (const mode of ['revoked', 'invalid', 'http-error']) {
    let revoked = false
    const usage = []
    const run = extractor({ fetchImpl: async () => {
      revoked = mode === 'revoked'
      return answer(mode === 'invalid' ? '{}' : raw, { usage: { total_tokens: 9, prompt_tokens: -1, completion_tokens: 'invalid' } }, mode === 'http-error' ? { status: 429 } : undefined)
    } })
    await rejected(run(messages, undefined, context({
      async ensureCurrent() { if (revoked) throw new Error('private-authorization-detail') },
      recordUsage: (...args) => usage.push(args),
    })))
    assert.deepEqual(usage, [[config.name, { total_tokens: 9 }]])
  }
})

test('person extraction rechecks authorization before releasing an otherwise valid array', async () => {
  let checks = 0
  await rejected(extractor({ fetchImpl: async () => answer() })(messages, undefined, context({
    async ensureCurrent() { if (++checks === 3) throw new Error('private-final-revocation') },
  })))
  assert.equal(checks, 3)
})

test('person extraction cancels oversized streams and refuses oversized Content-Length', async () => {
  for (const declared of [false, true]) {
    let cancelled = false
    const body = new ReadableStream({ start(controller) { if (!declared) controller.enqueue(new Uint8Array(512 * 1024 + 1)) }, cancel() { cancelled = true } })
    await rejected(extractor({ fetchImpl: async () => new Response(body, declared ? { headers: { 'content-length': String(512 * 1024 + 1) } } : undefined) })(messages, undefined, context()))
    assert.equal(cancelled, true)
  }
})

test('person extraction body reads obey the full deadline and caller cancellation without retrying', async () => {
  for (const mode of ['deadline', 'abort']) {
    const controller = new AbortController()
    let cancelled = false, calls = 0, transportSignal
    const body = new ReadableStream({ cancel() { cancelled = true } })
    const timer = setTimeout(() => controller.abort(), mode === 'abort' ? 10 : 1000)
    try {
      await rejected(extractor({ timeoutMs: mode === 'deadline' ? 10 : undefined, fetchImpl: async (_url, init) => {
        calls++; transportSignal = init.signal; return new Response(body)
      } })(messages, undefined, context({ signal: controller.signal })))
      assert.equal(calls, 1)
      assert.equal(cancelled, true)
      assert.equal(transportSignal.aborted, true)
    } finally { clearTimeout(timer) }
  }
})

test('person extraction authorization waits can be cancelled or timed out before any request', async () => {
  for (const mode of ['deadline', 'abort']) {
    const controller = new AbortController()
    let calls = 0, checks = 0
    const timer = setTimeout(() => controller.abort(), mode === 'abort' ? 10 : 1000)
    try {
      await rejected(extractor({ timeoutMs: mode === 'deadline' ? 10 : undefined, fetchImpl: async () => { calls++; return answer() } })(messages, undefined, context({
        signal: controller.signal, ensureCurrent: async () => { checks++; return new Promise(() => {}) },
      })))
      assert.equal(checks, 1)
      assert.equal(calls, 0)
    } finally { clearTimeout(timer) }
  }
})

test('person extraction observes a late transport rejection when transport cancels before returning', async () => {
  const controller = new AbortController()
  await rejected(extractor({ fetchImpl: () => {
    controller.abort()
    return Promise.reject(new Error('private-late-provider-detail'))
  } })(messages, undefined, context({ signal: controller.signal })))
  await new Promise(resolve => setImmediate(resolve))
})
