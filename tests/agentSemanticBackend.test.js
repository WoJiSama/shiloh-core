import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { createAgentSemanticBackend } from '../dist/backend/modules/memory/infrastructure/agentSemanticBackend.js'
import { AgentSemanticMemoryTimeoutError } from '../dist/backend/modules/memory/infrastructure/agentSemanticRetrieval.js'

const embedding = { baseUrl: 'https://embedding.example/custom/embeddings', name: 'embedding-fixture', apiKey: 'embedding-private-secret-123456' }
const rerank = { baseUrl: 'https://ranking.example/independent/rerank', name: 'rerank-fixture', apiKey: 'ranking-private-secret-789012' }
const FAILURE = '语义记忆请求失败：请求已取消、来源授权失效或服务响应无效。'
const documents = [{ id: 'a', text: '我喜欢爵士乐' }, { id: 'b', text: '周末去骑车' }]
function context(overrides = {}) {
  return { target: { account: { platform: 'private-platform', namespace: 'private-namespace', id: 'private-account' }, kind: 'group', id: 'private-conversation' },
    binding: { agentId: 'private-agent', personaId: 'private-persona', id: 'private-binding', revision: 'private-revision' },
    signal: new AbortController().signal, isCurrent: () => true, ensureCurrent: async () => {}, ...overrides }
}
function backend(options = {}) { return createAgentSemanticBackend({ embedding, ...options }) }
function vectors(count = 1, dimension = 2) { return { data: Array.from({ length: count }, (_, index) => ({ index, embedding: Array.from({ length: dimension }, (_, value) => value / 2 + 0.5) })) } }
function answer(payload) { return new Response(JSON.stringify(payload)) }
async function rejected(operation) { await assert.rejects(operation, error => error.message === FAILURE && error.cause === undefined) }
async function listen(t, handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return `http://127.0.0.1:${server.address().port}`
}

test('semantic backend uses real explicit HTTP endpoints with operation-specific credentials and no host metadata', async t => {
  const received = []
  const origin = await listen(t, async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const payload = JSON.parse(body)
    received.push({ url: request.url, method: request.method, authorization: request.headers.authorization, payload })
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(request.url.endsWith('/embeddings') ? vectors(payload.input.length)
      : { results: [{ index: 1, relevance_score: 0.8 }, { index: 0, relevance_score: 0.2 }] }))
  })
  const run = backend({ embedding: { ...embedding, baseUrl: `${origin}/custom/embeddings` }, rerank: { ...rerank, baseUrl: `${origin}/independent/rerank` } })
  t.after(() => run.dispose())
  assert.deepEqual(await run.embed(['爵士乐', '骑车'], context()), [[0.5, 1], [0.5, 1]])
  assert.deepEqual([...(await run.rerank('音乐', documents, context()))], [['b', 0.8], ['a', 0.2]])
  assert.deepEqual(received, [
    { url: '/custom/embeddings', method: 'POST', authorization: `Bearer ${embedding.apiKey}`, payload: { model: embedding.name, input: ['爵士乐', '骑车'] } },
    { url: '/independent/rerank', method: 'POST', authorization: `Bearer ${rerank.apiKey}`, payload: { model: rerank.name, query: '音乐', documents: documents.map(row => row.text), top_n: 2 } },
  ])
  assert.doesNotMatch(JSON.stringify(received.map(row => row.payload)), /private-|binding|persona|namespace/u)
})

test('semantic provider identity depends only on explicit embedding endpoint and model', () => {
  const first = backend()
  const changedKey = backend({ embedding: { ...embedding, apiKey: 'another-private-key-123456' }, rerank })
  assert.match(first.id, /^[a-f0-9]{64}$/u)
  assert.equal(first.id, changedKey.id)
  assert.notEqual(first.id, backend({ embedding: { ...embedding, name: 'other-model' } }).id)
  assert.notEqual(first.id, backend({ embedding: { ...embedding, baseUrl: 'https://other.example/embeddings' } }).id)
  assert.equal(Object.hasOwn(first, 'rerank'), false)
})

test('semantic backend rejects invalid endpoint configuration synchronously with safe errors', () => {
  for (const override of [{ baseUrl: 'https://embedding.example/v1' }, { baseUrl: `${embedding.baseUrl}/` },
    { baseUrl: 'file:///tmp/embeddings' }, { baseUrl: `https://user:private-value@embedding.example/embeddings` },
    { baseUrl: `${embedding.baseUrl}?token=private-value` }, { baseUrl: `${embedding.baseUrl}#private-value` },
    { name: ' ' }, { name: 'line\nbreak' }, { apiKey: '' }, { apiKey: 'private-value\nheader' },
  ]) assert.throws(() => backend({ embedding: { ...embedding, ...override } }), error => error.message === FAILURE)
  assert.throws(() => backend({ rerank: { ...rerank, baseUrl: embedding.baseUrl } }), error => error.message === FAILURE)
})

test('semantic input credential detection runs before text truncation or any request', async () => {
  let calls = 0
  const extra = 'other-host-private-secret-123456'
  const run = backend({ rerank, secrets: [extra], fetchFn: async () => { calls++; return answer(vectors()) } })
  for (const text of [embedding.apiKey, rerank.apiKey, extra, Buffer.from(extra).toString('base64'), encodeURIComponent(extra),
    [...embedding.apiKey].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''),
  ]) {
    await rejected(run.embed([`前文${'。'.repeat(5000)}${text}`], context()))
    await rejected(run.rerank(text, documents, context()))
    await rejected(run.rerank('音乐', [{ id: text, text: '内容' }], context()))
    await rejected(run.rerank('音乐', [{ id: 'id', text }], context()))
  }
  for (const texts of [null, [null], [1], [''], Array(2001).fill('abc'), ['文'.repeat(1024 * 1024)]]) await rejected(run.embed(texts, context()))
  assert.equal(calls, 0)
})

test('semantic authorization is checked before network, between actual batches and after a response', async () => {
  for (const override of [{ isCurrent: () => false }, { signal: AbortSignal.abort() }, { async ensureCurrent() { throw new Error('private-detail') } }]) {
    let calls = 0
    const run = backend({ fetchFn: async () => { calls++; return answer(vectors()) } })
    await rejected(run.embed(['内容'], context(override)))
    assert.equal(calls, 0)
  }
  let checks = 0, calls = 0, revoked = false
  const run = backend({ fetchFn: async (_url, init) => {
    calls++; const count = JSON.parse(init.body).input.length
    return answer(vectors(count))
  } })
  const scoped = context({ async ensureCurrent() {
    if (++checks === 3) { revoked = true; throw new Error('source-private-revoked') }
  }, isCurrent: () => !revoked })
  await rejected(run.embed(Array.from({ length: 17 }, (_, index) => `内容${index}`), scoped))
  assert.equal(calls, 1, 'second actual embedding batch must request fresh authorization')
  assert.equal(checks, 3, 'the first request and its response each checked authorization')
  let current = true
  await rejected(backend({ fetchFn: async () => { current = false; return answer(vectors()) } }).embed(['内容'], context({ isCurrent: () => current })))
})

test('semantic embedding responses require complete unique indices and consistent finite nonzero vectors', async () => {
  for (const payload of [null, {}, { data: [] }, { data: [{ index: 0, embedding: [] }] },
    { data: [{ index: 0, embedding: [1] }] }, { data: [{ index: 0, embedding: [0, 0] }] },
    { data: [{ index: 0, embedding: ['1', 2] }] }, { data: [{ index: 0, embedding: [null, 1] }] },
    { data: [{ index: 0, embedding: [Number.MAX_VALUE, 1] }] }, { data: [{ index: 0, embedding: [1e-100, 0] }] },
    { data: [{ index: -1, embedding: [1, 2] }] }, { data: [{ index: '0', embedding: [1, 2] }] }, { data: [{ index: null, embedding: [1, 2] }] },
    { data: [{ index: 0, embedding: Array(4097).fill(1) }] }, { ...vectors(), error: { message: embedding.apiKey } },
  ]) await rejected(backend({ fetchFn: async () => answer(payload) }).embed(['内容'], context()))
  for (const payload of [
    { data: [{ index: 0, embedding: [1, 2] }, { index: 0, embedding: [1, 2] }] },
    { data: [{ index: 0, embedding: [1, 2] }, { index: 1, embedding: [1, 2, 3] }] },
  ]) await rejected(backend({ fetchFn: async () => answer(payload) }).embed(['一', '二'], context()))
  assert.equal((await backend({ fetchFn: async () => answer(vectors(1, 4096)) }).embed(['内容'], context()))[0].length, 4096)
})

test('semantic reranking accepts only unique valid document indices and finite 0..1 scores', async () => {
  for (const results of [[], [{ index: 0, relevance_score: -0.1 }], [{ index: 0, relevance_score: 1.1 }],
    [{ index: 0, relevance_score: '0.5' }], [{ index: 1, relevance_score: 0.5 }], [{ index: 0.1, relevance_score: 0.5 }],
    [{ index: null, relevance_score: 0.5 }], [{ relevance_score: 0.5 }],
  ]) await rejected(backend({ rerank, fetchFn: async () => answer({ results }) }).rerank('音乐', [documents[0]], context()))
  await rejected(backend({ rerank, fetchFn: async () => answer({ results: [{ index: 0, relevance_score: 1 }, { index: 0, relevance_score: 0 }] }) }).rerank('音乐', documents, context()))
  const scores = await backend({ rerank, fetchFn: async () => answer({ results: [{ index: 0, relevance_score: 0 }, { index: 1, relevance_score: 1 }] }) }).rerank('音乐', documents, context())
  assert.deepEqual([...scores], [['a', 0], ['b', 1]])
})

test('semantic HTTP errors, raw provider exceptions and oversized responses expose only the fixed failure', async () => {
  for (const fetchFn of [async () => { throw new Error(`private-provider-detail ${embedding.apiKey}`) },
    async () => new Response(`private-provider-body ${embedding.apiKey}`, { status: 500 }),
    async () => new Response('not-json'),
    async () => { const response = answer(vectors()); Object.defineProperty(response, 'redirected', { value: true }); return response },
    async () => { const response = answer(vectors()); Object.defineProperty(response, 'url', { value: 'https://other.example/embeddings' }); return response },
  ]) await rejected(backend({ fetchFn }).embed(['内容'], context()))
  for (const declared of [false, true]) {
    let cancelled = false
    const stream = new ReadableStream({ start(controller) { if (!declared) controller.enqueue(new Uint8Array(1024 * 1024 + 1)) }, cancel() { cancelled = true } })
    await rejected(backend({ fetchFn: async () => new Response(stream, declared ? { headers: { 'content-length': String(1024 * 1024 + 1) } } : undefined) }).embed(['内容'], context()))
    assert.equal(cancelled, true)
  }
})

test('semantic real HTTP redirects never follow to another endpoint or replay the credential', async t => {
  let calls = 0, redirectedCalls = 0
  const origin = await listen(t, (request, response) => {
    calls++
    if (request.url === '/trap') { redirectedCalls++; response.end(embedding.apiKey); return }
    response.writeHead(307, { location: '/trap' }).end('private-provider-body')
  })
  await rejected(backend({ embedding: { ...embedding, baseUrl: `${origin}/embeddings` } }).embed(['内容'], context()))
  assert.equal(calls, 1)
  assert.equal(redirectedCalls, 0)
})

test('semantic disposal and caller cancellation interrupt request and body waits including ignored fetch signals', async () => {
  for (const phase of ['fetch', 'body', 'authorization']) {
    for (const mode of ['dispose', 'caller']) {
      const controller = new AbortController()
      let entered
      const ready = new Promise(resolve => { entered = resolve })
      let transportSignal, cancelled = false, calls = 0
      const run = backend({ fetchFn: async (_url, init) => {
        calls++; transportSignal = init.signal; entered()
        if (phase === 'fetch') return new Promise(() => {})
        return new Response(new ReadableStream({ cancel() { cancelled = true } }))
      } })
      const operation = run.embed(['内容'], context({ signal: controller.signal, ...(phase === 'authorization' ? { async ensureCurrent() { entered(); return new Promise(() => {}) } } : {}) }))
      await ready
      if (phase === 'body') await new Promise(resolve => setImmediate(resolve))
      if (mode === 'dispose') run.dispose(); else controller.abort()
      await rejected(operation)
      if (phase === 'authorization') assert.equal(calls, 0)
      else assert.equal(transportSignal.aborted, true)
      if (phase === 'body') assert.equal(cancelled, true)
    }
  }
})

test('semantic late successful fetch is canceled and cannot return a vector after disposal', async () => {
  let resolveFetch, started
  const ready = new Promise(resolve => { started = resolve })
  const run = backend({ fetchFn: async () => { started(); return new Promise(resolve => { resolveFetch = resolve }) } })
  const operation = run.embed(['内容'], context())
  await ready
  run.dispose()
  await rejected(operation)
  let cancelled = false
  resolveFetch(new Response(new ReadableStream({ cancel() { cancelled = true } })))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cancelled, true)
  await rejected(run.embed(['内容'], context()))
})

test('provider diagnostics distinguish a local budget while waiting for headers from a rejected or invalid response', async () => {
  const rows = []
  const diagnostics = { emit: event => rows.push(event) }
  const controller = new AbortController(), started = Promise.withResolvers()
  const stalled = backend({ diagnostics, fetchFn: async () => {
    started.resolve()
    return new Promise(() => {})
  } })
  const wait = stalled.embed(['private-query-content'], context({ signal: controller.signal }))
  await started.promise
  controller.abort(new AgentSemanticMemoryTimeoutError('embedding', 1_000))
  await rejected(wait)
  for (const response of [new Response('private-provider-response', { status: 503 }), answer({ data: [] })]) {
    await rejected(backend({ diagnostics, fetchFn: async () => response }).embed(['private-query-content'], context()))
  }
  assert.deepEqual(rows.map(({ code, outcome, httpStatus, details: { stepMs, ...details } }) => {
    assert.ok(Number.isSafeInteger(stepMs) && stepMs >= 0)
    return [code, outcome, httpStatus, details]
  }), [
    ['semantic_provider_budget_elapsed', 'cancelled', undefined,
      { step: 'response_headers', dispatched: true, limit: 1_000, result: 'discarded' }],
    ['http_error', 'failed', 503, { step: 'response_headers', dispatched: true, result: 'discarded' }],
    ['model_response_envelope_invalid', 'failed', 200, { step: 'response_validation', dispatched: true, result: 'discarded' }],
  ])
  assert.ok(rows.every(row => row.operation === 'semantic_embedding_provider' && Number.isFinite(row.durationMs)))
  assert.doesNotMatch(JSON.stringify(rows), /private-|embedding\.example/u)
})

test('a transient transport failure is reported before one reauthorized embedding attempt in the same deadline', async () => {
  const rows = [], requests = []
  let authorizations = 0
  const run = backend({ diagnostics: { emit: row => rows.push(row) }, fetchFn: async (_url, { signal }) => {
    requests.push([signal, authorizations])
    if (requests.length === 1) throw new TypeError('private-transport-message', { cause: Object.assign(new Error('private-address'), { code: 'ETIMEDOUT' }) })
    return answer(vectors())
  } })
  assert.deepEqual(await run.embed(['private-query-content'], context({ async ensureCurrent() { authorizations++ } })), [[0.5, 1]])
  assert.deepEqual(requests.map(([, checks]) => checks), [1, 2])
  assert.equal(requests[0][0], requests[1][0])
  assert.equal(authorizations, 3)
  assert.deepEqual(rows.map(row => [row.outcome, row.code, row.details.cause, row.details.attempt]), [
    ['failed', 'provider_transport_error', 'network_timeout', 1],
    ['succeeded', 'semantic_embedding_retry_recovered', undefined, 2],
  ])
  assert.doesNotMatch(JSON.stringify(rows), /private-/u)
})
