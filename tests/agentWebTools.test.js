import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http, { createServer } from 'node:http'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createAgentWebTools } from '../dist/backend/modules/tools/infrastructure/agentWebTools.js'

const apiKey = 'search-private-key-123456'
const search = { baseUrl: 'https://search.example.com/v1', name: 'search-fixture', apiKey }
const publicAddress = { address: '8.8.8.8', family: 4 }
const lookup = async () => [publicAddress]
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const answer = (content = '已找到资料', extra = {}) => json({ choices: [{ message: { content } }], ...extra })
const webResponse = (body = '<html><title>标题</title><body><p>公开正文</p></body></html>', headers = {}) => ({
  status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers }, body,
})
function context(overrides = {}) {
  return {
    binding: { source: 'configured', id: 'do-not-send-conversation', agentId: 'do-not-send-agent', revision: 'private-revision',
      personaId: 'private-persona', connectionId: 'private-connection', target: {
        account: { platform: 'qq', namespace: 'global', id: 'private-account' }, kind: 'group', id: 'private-group',
      } },
    actor: { kind: 'user', user: { platform: 'qq', namespace: 'global', id: 'private-actor' } },
    signal: new AbortController().signal, isCurrent: () => true, ...overrides,
  }
}
function tool(options, name = 'searchInformationTool') {
  return createAgentWebTools(options).builtIn.find(item => item.name === name)
}
function webTool(dependencies = {}, extra = {}) {
  return tool({ web: { enabled: true }, publicWeb: { lookup, ...dependencies }, ...extra }, 'webParserTool')
}
async function listen(t, handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return `http://127.0.0.1:${server.address().port}`
}

test('unconfigured network capabilities are absent and configured capabilities have closed schemas', () => {
  assert.deepEqual(createAgentWebTools(), { builtIn: [] })
  assert.deepEqual(createAgentWebTools({ search }).builtIn.map(item => item.name), ['searchInformationTool'])
  assert.deepEqual(createAgentWebTools({ web: { enabled: true } }).builtIn.map(item => item.name), ['webParserTool'])
  for (const item of createAgentWebTools({ search, web: { enabled: true } }).builtIn) assert.equal(item.parameters.additionalProperties, false)
})

test('search uses actual JSON HTTP, sends only query text, stamps time and records usage', async t => {
  const received = []
  const baseUrl = await listen(t, async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    received.push({ path: request.url, auth: request.headers.authorization, body: JSON.parse(body) })
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      choices: [{ message: { content: '当前公开结果' } }], usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10, private: apiKey },
    }))
  })
  const usage = []
  const result = await tool({ search: { ...search, baseUrl: `${baseUrl}/search/v1` }, now: () => Date.UTC(2026, 10, 15, 2, 30) })
    .execute({ query: '最近的公开更新' }, context({ recordUsage: (...args) => usage.push(args) }))
  assert.equal(result.status, 'succeeded')
  assert.match(result.content, /11-15 10:30 北京时间/u)
  assert.match(result.content, /当前公开结果/u)
  assert.deepEqual(received, [{ path: '/search/v1/chat/completions', auth: `Bearer ${apiKey}`, body: {
    model: search.name, messages: [{ role: 'user', content: '最近的公开更新' }], stream: false, max_tokens: 2000,
  } }])
  assert.deepEqual(usage, [[search.name, { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 }]])
  assert.doesNotMatch(JSON.stringify(received[0].body), /private-|do-not-send/u)
})

test('search preserves explicit web_search switches and uses an exact Bigmodel host boundary', async () => {
  for (const [baseUrl, webSearch, expected] of [
    ['https://open.bigmodel.cn/api/coding/paas/v4', 'auto', true],
    ['https://open.bigmodel.cn/api/paas/v4', 'off', false],
    ['https://search.example.com/v1', 'on', true],
    ['https://bigmodel.cn.evil.example/v1', 'auto', false],
    ['https://search.example.com/bigmodel.cn/v1', 'auto', false],
  ]) {
    let payload
    const result = await tool({ search: { ...search, baseUrl, webSearch }, fetchImpl: async (_url, init) => {
      assert.equal(init.redirect, 'error'); payload = JSON.parse(init.body); return answer()
    } }).execute({ query: '公开资料' }, context())
    assert.equal(result.status, 'succeeded')
    assert.equal(Boolean(payload.tools), expected)
    if (expected) assert.deepEqual(payload.tools, [{ type: 'web_search', web_search: { enable: true, search_result: true } }])
  }
})

test('search refuses real HTTP redirects without sending credentials to their target', async t => {
  let targetCalls = 0
  const baseUrl = await listen(t, (request, response) => {
    if (request.url === '/trap') { targetCalls++; response.end(apiKey); return }
    response.writeHead(307, { Location: '/trap' }).end()
  })
  const result = await tool({ search: { ...search, baseUrl } }).execute({ query: '公开资料' }, context())
  assert.equal(result.status, 'failed')
  assert.equal(targetCalls, 0)
  assert.ok(!result.content.includes(apiKey))
})

test('search never exposes provider error bodies, thrown details or configured credentials', async () => {
  const leaked = 'provider-private-error'
  const encoded = [...apiKey].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')
  for (const fetchImpl of [
    async () => new Response(JSON.stringify({ error: { message: `${leaked} ${apiKey}` } }), { status: 403 }),
    async () => { throw new Error(`${leaked} ${apiKey}`) },
    async () => answer(apiKey), async () => answer(encoded), async () => answer(Buffer.from(apiKey).toString('base64')),
    async () => json({ error: { message: apiKey }, choices: [{ message: { content: '不得当成功' } }] }),
    async () => new Response('<html>not JSON</html>'),
    async () => json({ choices: [{ message: { tool_calls: [{ function: { name: 'sideEffect' } }], content: '不得当成功' } }] }),
  ]) {
    let calls = 0
    const result = await tool({ search, fetchImpl: (...args) => { calls++; return fetchImpl(...args) } })
      .execute({ query: '公开资料' }, context())
    assert.equal(result.status, 'failed')
    assert.equal(calls, 1)
    assert.ok(!result.content.includes(apiKey))
    assert.ok(!result.content.includes(leaked))
  }
})

test('a valid search usage report is retained even when the content is unusable', async () => {
  const usage = []
  const result = await tool({ search, fetchImpl: async () => answer('', { usage: { total_tokens: 9, prompt_tokens: -1, completion_tokens: 'invalid' } }) })
    .execute({ query: '公开资料' }, context({ recordUsage: (...args) => usage.push(args) }))
  assert.equal(result.status, 'failed')
  assert.deepEqual(usage, [[search.name, { total_tokens: 9 }]])
})

test('a JSON provider error can report usage without exposing its body', async () => {
  const usage = []
  const result = await tool({ search, fetchImpl: async () => new Response(JSON.stringify({ error: { message: apiKey }, usage: { total_tokens: 5 } }), { status: 429 }) })
    .execute({ query: '公开资料' }, context({ recordUsage: (...args) => usage.push(args) }))
  assert.equal(result.status, 'failed')
  assert.deepEqual(usage, [[search.name, { total_tokens: 5 }]])
  assert.ok(!result.content.includes(apiKey))
})

test('search records parsed usage before asynchronously revoked authorization rejects the result', async () => {
  let revoked = false, calls = 0
  const usage = []
  const result = await tool({ search, fetchImpl: async () => {
    calls++; revoked = true
    return answer('late-private-search-result', { usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 } })
  } }).execute({ query: 'safe' }, context({
    async ensureCurrent() { if (revoked) throw new Error('private-authorization-detail') },
    recordUsage: (...args) => usage.push(args),
  }))
  assert.equal(result.status, 'failed')
  assert.equal(calls, 1)
  assert.deepEqual(usage, [[search.name, { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 }]])
  assert.doesNotMatch(result.content, /late-private|private-authorization/u)
})

test('invalid search parameters, stale turns and cancelled turns never send requests', async () => {
  let calls = 0
  const item = tool({ search, fetchImpl: async () => { calls++; return answer() } })
  for (const input of [{}, { query: '' }, { query: 4 }, { query: apiKey }, { query: 'safe', endpoint: 'https://evil.example' }, null, { query: 'x'.repeat(4001) }]) {
    assert.equal((await item.execute(input, context())).status, 'failed')
  }
  assert.equal((await item.execute({ query: 'safe' }, context({ isCurrent: () => false }))).status, 'failed')
  assert.equal((await item.execute({ query: 'safe' }, context({ signal: AbortSignal.abort() }))).status, 'failed')
  assert.equal(calls, 0)
})

test('asynchronous authorization failures prevent search requests and public web DNS', async () => {
  let calls = 0
  const ensureCurrent = async () => { throw new Error('private-authorization-detail') }
  const searchResult = await tool({ search, fetchImpl: async () => { calls++; return answer() } })
    .execute({ query: 'safe' }, context({ ensureCurrent }))
  const webResult = await webTool({ lookup: async () => { calls++; return [publicAddress] }, request: async () => { calls++; return webResponse() } })
    .execute({ url: 'https://example.com' }, context({ ensureCurrent }))
  assert.equal(calls, 0)
  for (const result of [searchResult, webResult]) {
    assert.equal(result.status, 'failed')
    assert.doesNotMatch(result.content, /private-authorization/u)
  }
})

test('asynchronous authorization waits obey cancellation and the full tool deadline', async () => {
  for (const kind of ['search', 'web']) for (const interruption of ['abort', 'deadline']) {
    const controller = new AbortController()
    let requests = 0, checks = 0
    const item = kind === 'search'
      ? tool({ search, searchTimeoutMs: interruption === 'deadline' ? 10 : undefined, fetchImpl: async () => { requests++; return answer() } })
      : webTool({ timeoutMs: interruption === 'deadline' ? 10 : undefined, lookup: async () => { requests++; return [publicAddress] } })
    const timer = setTimeout(() => controller.abort(), interruption === 'abort' ? 10 : 1000)
    try {
      const result = await item.execute(kind === 'search' ? { query: 'safe' } : { url: 'https://example.com' }, context({
        signal: controller.signal, ensureCurrent: async () => { checks++; return new Promise(() => {}) },
      }))
      assert.equal(result.status, 'failed', `${kind}: ${interruption}`)
      assert.equal(checks, 1)
      assert.equal(requests, 0)
    } finally { clearTimeout(timer) }
  }
})

test('search rejects stale results and cancels an oversized response stream', async () => {
  let current = true
  let staleCancelled = false
  const staleBody = new ReadableStream({ cancel() { staleCancelled = true } })
  const stale = await tool({ search, fetchImpl: async () => { current = false; return new Response(staleBody) } })
    .execute({ query: 'safe' }, context({ isCurrent: () => current }))
  assert.equal(stale.status, 'failed')
  assert.doesNotMatch(stale.content, /迟到资料/u)
  assert.equal(staleCancelled, true)
  let cancelled = false
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(512 * 1024 + 1)) }, cancel() { cancelled = true } })
  const large = await tool({ search, fetchImpl: async () => new Response(body) }).execute({ query: 'safe' }, context())
  assert.equal(large.status, 'failed')
  assert.equal(cancelled, true)
})

test('search deadline includes the response body and never retries a timeout', async () => {
  let cancelled = false, calls = 0, timer
  const body = new ReadableStream({ start(controller) { timer = setTimeout(() => controller.close(), 1000) }, cancel() { cancelled = true; clearTimeout(timer) } })
  const result = await tool({ search, searchTimeoutMs: 10, fetchImpl: async () => { calls++; return new Response(body) } })
    .execute({ query: 'safe' }, context())
  assert.equal(result.status, 'failed')
  assert.equal(calls, 1)
  assert.equal(cancelled, true)
})

test('public web rejects URL credentials, credential queries and internal addresses before transport', async () => {
  let requests = 0, lookups = 0
  const item = webTool({ lookup: async () => { lookups++; return [publicAddress] }, request: async () => { requests++; return webResponse() } })
  for (const url of ['file:///tmp/private', 'javascript:alert(1)', 'https://u:p@example.com', 'https://example.com?%74oken=secret',
    'https://example.com?api_key=secret', 'https://localhost/a', 'https://box.internal/a', 'https://box.local/a',
    'http://127.1/a', 'https://0x7f000001/a', 'https://2130706433/a', 'http://169.254.169.254/latest',
    'https://[::1]/a', 'https://[::ffff:8.8.8.8]/a', 'https://10.0.0.1/a', 'https://example.com/\\private']) {
    assert.equal((await item.execute({ url }, context())).status, 'failed', url)
  }
  assert.equal(requests, 0)
  assert.equal(lookups, 0)
})

test('public web validates every DNS address and requires the declared address family', async () => {
  for (const addresses of [[], [publicAddress, { address: '10.0.0.1', family: 4 }],
    [{ address: '8.8.8.8', family: 6 }], [{ address: 'fc00::1', family: 6 }], [{ address: '2002:0808:0808::', family: 6 }]]) {
    let calls = 0
    const result = await webTool({ lookup: async () => addresses, request: async () => { calls++; return webResponse() } })
      .execute({ url: 'https://example.com/article' }, context())
    assert.equal(result.status, 'failed')
    assert.equal(calls, 0)
  }
})

test('public web reads HTTP(S) static HTML through pinned public addresses and never loads subresources', async () => {
  const seen = [], resolved = []
  const html = '<!doctype html><html><head><title>标题 &amp; &#x4e2d;&#25991;</title><style>.secret{}</style></head><body>'
    + '<script>fetch("http://127.0.0.1/private"); const secret="script-private"</script><noscript>fallback-private</noscript>'
    + '<main><h1>公开文章</h1><p>事实 &amp; 资料&nbsp;&lt;原文&gt;</p><img src="http://127.0.0.1/pixel"><iframe src="http://127.0.0.1/inside"></iframe></main>'
    + '<!-- comment-private --></body></html>'
  const result = await webTool({ lookup: async host => { resolved.push(host); return [publicAddress] }, request: async (url, address, signal) => {
    seen.push(url.href); assert.deepEqual(address, publicAddress); assert.equal(signal.aborted, false)
    return seen.length === 1 ? { status: 302, headers: { location: 'https://news.example.org/article' }, body: '' } : webResponse(html)
  } }).execute({ url: 'http://example.com/article#fragment' }, context())
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(resolved, ['example.com', 'news.example.org'])
  assert.deepEqual(seen, ['http://example.com/article', 'https://news.example.org/article'])
  assert.match(result.content, /标题 & 中文/u)
  assert.match(result.content, /公开文章/u)
  assert.match(result.content, /事实 & 资料 <原文>/u)
  assert.doesNotMatch(result.content, /script-private|fallback-private|comment-private|127\.0\.0\.1|\.secret/u)
})

test('public web reads bounded JSON and plain text without interpreting their text as markup', async () => {
  for (const [type, body] of [['application/json', '{"fact":"公开资料"}'], ['text/plain', '原样 <example> 文本']]) {
    const result = await webTool({ request: async () => webResponse(body, { 'content-type': type }) })
      .execute({ url: 'https://example.com/article' }, context())
    assert.equal(result.status, 'succeeded')
    assert.ok(result.content.includes(body))
  }
})

test('native public web transport pins the validated IP and sends no ambient credentials', async t => {
  let captured
  t.mock.method(http, 'request', (url, options, callback) => {
    captured = { url, options }
    const request = new EventEmitter()
    request.end = () => {
      const response = Readable.from([Buffer.from('<title>真实传输边界</title><p>静态正文</p>')])
      response.statusCode = 200
      response.headers = { 'content-type': 'text/html' }
      callback(response)
    }
    return request
  })
  const result = await webTool().execute({ url: 'http://example.com/article' }, context())
  assert.equal(result.status, 'succeeded')
  assert.equal(captured.url.hostname, 'example.com')
  assert.equal(captured.options.agent, false)
  assert.equal(captured.options.family, 4)
  assert.equal(captured.options.method, 'GET')
  assert.equal(captured.options.headers['Accept-Encoding'], 'identity')
  assert.ok(!JSON.stringify(captured.options.headers).includes(apiKey))
  assert.equal(captured.options.headers.Authorization, undefined)
  assert.equal(captured.options.headers.Cookie, undefined)
  captured.options.lookup('example.com', {}, (error, address, family) => {
    assert.equal(error, null); assert.equal(address, publicAddress.address); assert.equal(family, publicAddress.family)
  })
})

test('native public web stream stops after the byte limit even without Content-Length', async t => {
  let response
  t.mock.method(http, 'request', (_url, _options, callback) => {
    const request = new EventEmitter()
    request.end = () => {
      response = Readable.from([Buffer.alloc(2 * 1024 * 1024), Buffer.from('overflow')])
      response.statusCode = 200
      response.headers = { 'content-type': 'text/plain' }
      callback(response)
    }
    return request
  })
  const result = await webTool().execute({ url: 'http://example.com/article' }, context())
  assert.equal(result.status, 'failed')
  assert.equal(response.destroyed, true)
})

test('static extraction handles quoted tag delimiters, raw text and incomplete markup without fetching it', async () => {
  const body = '<head><title>静态文章</title></head><body><p data-info="a > b">保留正文 &amp; 内容</p>'
    + '<script>忽略 </scriptNotARealClose> 仍为脚本</script><p>下一段</p>' + '<unfinished '.repeat(10000)
  const result = await webTool({ request: async () => webResponse(body) }).execute({ url: 'https://example.com/article' }, context())
  assert.equal(result.status, 'succeeded')
  assert.match(result.content, /保留正文 & 内容/u)
  assert.match(result.content, /下一段/u)
  assert.doesNotMatch(result.content, /仍为脚本|unfinished/u)
})

test('public web rechecks redirect destinations and follows no more than three redirects', async () => {
  for (const location of ['http://127.0.0.1/private', 'https://u:p@example.org', 'https://example.org/?token=secret']) {
    let calls = 0
    const result = await webTool({ request: async () => { calls++; return { status: 302, headers: { location }, body: '' } } })
      .execute({ url: 'https://example.com/article' }, context())
    assert.equal(result.status, 'failed')
    assert.equal(calls, 1)
  }
  let calls = 0
  const loop = await webTool({ request: async () => { calls++; return { status: 302, headers: { location: '/again' }, body: '' } } })
    .execute({ url: 'https://example.com/article' }, context())
  assert.equal(loop.status, 'failed')
  assert.equal(calls, 4)
})

test('public web rejects oversized, compressed, binary and unsuccessful responses without disclosing their bodies', async () => {
  const secret = 'web-private-body'
  for (const response of [webResponse('a'.repeat(2 * 1024 * 1024 + 1)),
    webResponse(new Uint8Array(2 * 1024 * 1024 + 1)), webResponse(secret, { 'content-length': String(2 * 1024 * 1024 + 1) }),
    webResponse(secret, { 'content-encoding': 'gzip' }), webResponse(secret, { 'content-type': 'image/png' }),
    { status: 403, headers: { 'content-type': 'text/html' }, body: secret }]) {
    const result = await webTool({ request: async () => response }).execute({ url: 'https://example.com' }, context())
    assert.equal(result.status, 'failed')
    assert.ok(!result.content.includes(secret))
  }
})

test('public web checks current authorization after DNS and after response arrival', async () => {
  let current = true, calls = 0
  const beforeRequest = await webTool({ lookup: async () => { current = false; return [publicAddress] }, request: async () => { calls++; return webResponse() } })
    .execute({ url: 'https://example.com' }, context({ isCurrent: () => current }))
  assert.equal(beforeRequest.status, 'failed')
  assert.equal(calls, 0)
  current = true
  const afterResponse = await webTool({ request: async () => { current = false; return webResponse('不得使用的迟到资料') } })
    .execute({ url: 'https://example.com' }, context({ isCurrent: () => current }))
  assert.equal(afterResponse.status, 'failed')
  assert.doesNotMatch(afterResponse.content, /迟到资料/u)
})

test('public web rechecks asynchronous authorization after DNS before opening a connection', async () => {
  let revoked = false, requests = 0
  const result = await webTool({ lookup: async () => { revoked = true; return [publicAddress] }, request: async () => { requests++; return webResponse() } })
    .execute({ url: 'https://example.com' }, context({ async ensureCurrent() { if (revoked) throw new Error('private-authorization-detail') } }))
  assert.equal(result.status, 'failed')
  assert.equal(requests, 0)
  assert.doesNotMatch(result.content, /private-authorization/u)
})

test('public web stops after the first redirect response when asynchronous authorization is revoked', async () => {
  let revoked = false
  const requests = [], resolved = []
  const result = await webTool({
    lookup: async hostname => { resolved.push(hostname); return [publicAddress] },
    request: async url => {
      requests.push(url.href); revoked = true
      return { status: 302, headers: { location: 'https://news.example.org/private' }, body: 'private-redirect-body' }
    },
  }).execute({ url: 'https://example.com/article' }, context({
    async ensureCurrent() { await Promise.resolve(); if (revoked) throw new Error('private-authorization-detail') },
  }))
  assert.equal(result.status, 'failed')
  assert.deepEqual(requests, ['https://example.com/article'])
  assert.deepEqual(resolved, ['example.com'])
  assert.doesNotMatch(result.content, /private-redirect|private-authorization/u)
})

test('public web observes a transport rejection even when that transport aborts before returning', async () => {
  const controller = new AbortController()
  const result = await webTool({ request: () => {
    controller.abort()
    return Promise.reject(new Error('private-late-rejection'))
  } }).execute({ url: 'https://example.com' }, context({ signal: controller.signal }))
  assert.equal(result.status, 'failed')
  assert.doesNotMatch(result.content, /private-late/u)
  await new Promise(resolve => setImmediate(resolve))
})

test('public web cancellation interrupts DNS and signals an in-flight request', async () => {
  for (const stage of ['dns', 'request']) {
    const controller = new AbortController()
    let calls = 0, transportSignal
    const item = webTool({ lookup: async () => stage === 'dns' ? new Promise(() => {}) : [publicAddress],
      request: async (_url, _address, signal) => { calls++; transportSignal = signal; return new Promise(() => {}) } })
    const pending = item.execute({ url: 'https://example.com' }, context({ signal: controller.signal }))
    const timer = setTimeout(() => controller.abort(), 10)
    const result = await pending
    clearTimeout(timer)
    assert.equal(result.status, 'failed')
    assert.equal(calls, stage === 'dns' ? 0 : 1)
    if (transportSignal) assert.equal(transportSignal.aborted, true)
  }
})

test('public web has a full-request deadline and excludes extra host credentials', async () => {
  let timer
  const timedOut = await webTool({ timeoutMs: 10, request: async () => new Promise(resolve => { timer = setTimeout(() => resolve(webResponse()), 1000) }) })
    .execute({ url: 'https://example.com' }, context())
  clearTimeout(timer)
  assert.equal(timedOut.status, 'failed')
  const secret = 'other-host-credential-1234'
  const escaped = [...secret].map(char => `&#${char.charCodeAt(0)};`).join('')
  const result = await webTool({ request: async () => webResponse(`<p>${escaped}</p>`) }, { secrets: [secret] })
    .execute({ url: 'https://example.com' }, context())
  assert.equal(result.status, 'failed')
  assert.ok(!result.content.includes(secret))
  const acrossLimit = await webTool({ request: async () => webResponse(`<p>${'a'.repeat(7995)}${secret}</p>`) }, { secrets: [secret] })
    .execute({ url: 'https://example.com' }, context())
  assert.equal(acrossLimit.status, 'failed', 'credential checks precede output truncation')
})

test('public web failure diagnostics expose only controlled stages and safe metadata', async () => {
  for (const [stage, dependencies, url, guard, status] of [
    ['url', {}, 'https://localhost/private', {}, undefined],
    ['authority', {}, 'https://example.com/private', { isCurrent: () => false }, undefined],
    ['dns', { lookup: async () => { throw new Error('private-dns-detail') } }, 'https://example.com/private', {}, undefined],
    ['request', { request: async () => { throw Object.assign(new Error('private-transport-detail'), { code: 'ECONNRESET' }) } }, 'https://example.com/private', {}, undefined],
    ['redirect', { request: async () => ({ status: 302, headers: { location: 'https://localhost/private' }, body: 'private-body' }) }, 'https://example.com/private', {}, 302],
    ['response', { request: async () => ({ status: 403, headers: {}, body: 'private-body' }) }, 'https://example.com/private', {}, 403],
    ['response', { request: async () => webResponse('private-body', { 'content-type': 'image/png' }) }, 'https://example.com/private', {}, 200],
    ['response', { request: async () => webResponse('<script>private-body</script>') }, 'https://example.com/private', {}, 200],
    ['response', { request: async () => webResponse(new Uint8Array([65]), { 'content-type': 'text/plain; charset=invalid-private' }) }, 'https://example.com/private', {}, 200],
  ]) {
    const failures = [], events = []
    const result = await webTool({ ...dependencies, onFailure: event => failures.push(event) }, { diagnostics: { emit: event => events.push(event) } })
      .execute({ url }, context(guard))
    assert.equal(result.status, 'failed')
    assert.equal(failures.length, 1, stage)
    assert.equal(failures[0].stage, stage)
    assert.equal(failures[0].httpStatus, status)
    assert.ok(Number.isSafeInteger(failures[0].durationMs) && failures[0].durationMs >= 0)
    assert.equal(events.length, 1)
    assert.equal(events[0].operation, 'public_web_read')
    assert.match(events[0].code, new RegExp(`^public_web_${stage}_`))
    assert.doesNotMatch(JSON.stringify([failures, events]), /private|https?:|8\.8\.8\.8/u)
  }
})

test('public web distinguishes its deadline from caller cancellation without changing results', async () => {
  for (const stage of ['authority', 'dns', 'request']) for (const interruption of ['deadline', 'cancelled']) {
    const controller = new AbortController(), failures = []
    const timer = setTimeout(() => controller.abort(), interruption === 'cancelled' ? 10 : 1000)
    try {
      const result = await webTool({ timeoutMs: interruption === 'deadline' ? 10 : undefined,
        lookup: async () => stage === 'dns' ? new Promise(() => {}) : [publicAddress],
        request: async () => new Promise(() => {}), onFailure: event => failures.push(event),
      }).execute({ url: 'https://example.com/private' }, context({ signal: controller.signal,
        ...(stage === 'authority' ? { ensureCurrent: async () => new Promise(() => {}) } : {}),
      }))
      assert.equal(result.status, 'failed')
      assert.equal(failures.length, 1)
      assert.equal(failures[0].stage, stage)
      assert.equal(failures[0].kind, interruption)
    } finally { clearTimeout(timer) }
  }
})

test('public web ignores diagnostic observer errors and unsafe transport error properties', async () => {
  let getters = 0, requests = 0
  const unsafe = new Error('private-detail')
  Object.defineProperty(unsafe, 'code', { get() { getters++; return 'ECONNRESET' } })
  for (const error of [unsafe, new Proxy({}, { get() { throw new Error('private-proxy') } })]) {
    const failures = []
    const result = await webTool({ request: async () => { requests++; throw error }, onFailure: event => { failures.push(event); throw new Error('private-observer') } },
      { diagnostics: { emit() { throw new Error('private-diagnostics') } } }).execute({ url: 'https://example.com/private' }, context())
    assert.equal(result.status, 'failed')
    assert.equal(failures.length, 1)
    assert.equal(failures[0].kind, 'transport_unknown')
    assert.doesNotMatch(result.content, /private/u)
  }
  assert.equal(getters, 0)
  assert.equal(requests, 2)
})
