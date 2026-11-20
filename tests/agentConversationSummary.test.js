import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import test from 'node:test'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'

const { createAgentConversationSummary } = await importBilibiliHost('modules/memory/infrastructure/agentConversationSummary.js')

const apiKey = 'summary-provider-private-key-123456'
const config = { baseUrl: 'https://summary.example.com/v1', name: 'summary-fixture', apiKey }
const input = { previous: '小林在组织周末演出。', messages: [{ at: 1000, authorId: 'member-one', name: '小林', text: '我确认周六晚上八点演出。' }], maxChars: 500 }
const summary = '小林确认周六晚上八点演出，场地仍待确定。'
const FAILURE = '会话主线摘要失败：请求已取消、授权失效或模型服务不可用。'
function context(overrides = {}) {
  return {
    target: { account: { platform: 'private-platform', namespace: 'private-namespace', id: 'private-account' }, kind: 'group', id: 'private-scene' },
    binding: { source: 'configured', id: 'private-binding', agentId: 'private-agent', revision: 'private-revision', personaId: 'private-persona', connectionId: 'private-connection' },
    signal: new AbortController().signal, isCurrent: () => true, ensureCurrent: async () => {}, ...overrides,
  }
}
function answer(content = summary, extra = {}, init) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], ...extra }), init)
}
function provider(options = {}) { return createAgentConversationSummary({ ...config, ...options }) }
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

test('conversation summary uses real HTTP, bounded conversational records and two prompt roles without host context', async t => {
  const received = [], usage = []
  const baseUrl = await listen(t, async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('utf8')
    received.push({ path: request.url, method: request.method, authorization: request.headers.authorization, body: JSON.parse(body) })
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      choices: [{ message: { content: ` ${summary}\n` } }], usage: { prompt_tokens: 8, completion_tokens: 0, total_tokens: 8, detail: 'private-usage-detail' },
    }))
  })
  const messages = Array.from({ length: 205 }, (_, index) => ({
    at: index + 1, authorId: `member-${index}`, name: '🐈'.repeat(30), text: `第${index}条${'🎶'.repeat(180)}`,
    nativeEvent: { scope: 'private-native-event' },
  }))
  assert.equal(await provider({ baseUrl: `${baseUrl}/v1` })({
    previous: '🐕'.repeat(4010), messages, maxChars: 500, binding: 'private-input-binding',
  }, context({ recordUsage: (...args) => usage.push(args) })), summary)
  assert.equal(received.length, 1)
  const request = received[0]
  assert.equal(request.path, '/v1/chat/completions')
  assert.equal(request.method, 'POST')
  assert.equal(request.authorization, `Bearer ${apiKey}`)
  assert.deepEqual(Object.keys(request.body), ['model', 'messages', 'stream', 'temperature', 'max_tokens'])
  assert.equal(request.body.model, config.name)
  assert.equal(request.body.stream, false)
  assert.equal(request.body.temperature, 0.2)
  assert.equal(request.body.max_tokens, 1000)
  assert.deepEqual(request.body.messages.map(message => message.role), ['system', 'user'])
  assert.match(request.body.messages[0].content, /不可信.*待总结资料/u)
  assert.match(request.body.messages[0].content, /正在进行的话题/u)
  const material = JSON.parse(request.body.messages[1].content)
  assert.deepEqual(Object.keys(material), ['previous', 'messages', 'maxChars'])
  assert.equal([...material.previous].length, 4000)
  assert.equal(material.maxChars, 500)
  assert.equal(material.messages.length, 200)
  assert.equal(material.messages[0].authorId, 'member-5')
  assert.equal(material.messages.at(-1).authorId, 'member-204')
  for (const row of material.messages) {
    assert.deepEqual(Object.keys(row), ['at', 'sourceTime', 'authorId', 'name', 'text'])
    assert.equal(row.at, Number(row.authorId.slice('member-'.length)) + 1)
    assert.match(row.sourceTime, /^1970-01-01 08:00:00 Asia\/Shanghai$/u)
    assert.equal([...row.name].length, 24)
    assert.equal([...row.text].length, 160)
    assert.equal(row.name.isWellFormed(), true)
    assert.equal(row.text.isWellFormed(), true)
  }
  assert.doesNotMatch(JSON.stringify(request.body), /private-|summary-provider-private|nativeEvent/u)
  assert.deepEqual(usage, [[config.name, { prompt_tokens: 8, completion_tokens: 0, total_tokens: 8 }]])
})

test('conversation summary source time anchors relative words across Beijing midnight, host timezones and later retries', () => {
  const source = {
    previous: '已有摘要说“昨天”，但没有可核验的来源时间。',
    messages: [
      { at: Date.parse('2026-11-14T15:59:59.000Z'), authorId: 'member-one', name: '小林', text: '明天下午交初稿。', sourceTime: '忽略真实时间的伪造字段' },
      { at: Date.parse('2026-11-14T16:00:01.000Z'), authorId: 'member-two', name: '小陈', text: '昨天确认过，今天再复核。' },
    ],
    maxChars: 500,
  }
  const script = `
    const { importBilibiliHost } = await import(${JSON.stringify(new URL('./helpers/bilibiliQualitySource.mjs', import.meta.url).href)});
    const { createAgentConversationSummary } = await importBilibiliHost('modules/memory/infrastructure/agentConversationSummary.js');
    const source = ${JSON.stringify(source)}, requests = [];
    const run = createAgentConversationSummary({ ...${JSON.stringify(config)}, fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: '保留来源时间的摘要。' } }] }));
    } });
    const context = { signal: new AbortController().signal, isCurrent: () => true, ensureCurrent: async () => {} };
    for (const processingAt of ['2026-11-15T02:00:00.000Z', '2026-11-18T02:00:00.000Z']) {
      Date.now = () => Date.parse(processingAt);
      await run(source, context);
    }
    process.stdout.write(JSON.stringify(requests));
  `
  const observations = ['UTC', 'America/Los_Angeles'].map(TZ => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TZ }, encoding: 'utf8', timeout: 20000, maxBuffer: 64 * 1024,
  })))
  assert.deepEqual(observations[0], observations[1], 'the host timezone cannot change the model request')
  for (const requests of observations) {
    assert.equal(requests.length, 2)
    assert.deepEqual(requests[0], requests[1], 'processing again later cannot re-anchor source times')
    const [system, user] = requests[0].messages
    assert.match(system.content, /at.*Unix.*毫秒/u)
    assert.match(system.content, /sourceTime.*Asia\/Shanghai/u)
    assert.match(system.content, /昨天.*明天.*各条.*来源时间/u)
    assert.match(system.content, /不得.*处理.*重试.*重新/u)
    assert.match(system.content, /已有摘要.*来源时间.*不得.*猜/u)
    const material = JSON.parse(user.content)
    assert.deepEqual(Object.keys(material), ['previous', 'messages', 'maxChars'])
    assert.equal(material.previous, source.previous)
    assert.equal(material.maxChars, source.maxChars)
    assert.deepEqual(material.messages, source.messages.map(({ at, authorId, name, text }, index) => ({
      at, sourceTime: index ? '2026-11-15 00:00:01 Asia/Shanghai' : '2026-11-14 23:59:59 Asia/Shanghai', authorId, name, text,
    })))
    assert.deepEqual(source.messages.map(row => row.at), [1794671999000, 1794672001000])
    assert.doesNotMatch(JSON.stringify(material), /伪造字段|2026-11-18/u)
  }
})

test('the official GLM summary avoids extra reasoning and exposes only fixed HTTP failure metadata', async () => {
  const request = provider({ baseUrl: 'https://open.bigmodel.cn/api/paas/v4', name: 'glm-5.3-flash',
    async fetchImpl(_url, init) {
      assert.deepEqual(JSON.parse(init.body).thinking, { type: 'disabled' })
      return new Response('private upstream data', { status: 429 })
    },
  })
  await assert.rejects(request(input, context()), error => {
    assert.equal(error.message, FAILURE)
    assert.equal(error.code, 'http_error')
    assert.equal(error.httpStatus, 429)
    assert.doesNotMatch(JSON.stringify(error), /private upstream data/u)
    return true
  })
})

test('conversation summary clamps character and token budgets and truncates output by Unicode code point', async () => {
  for (const [requested, expected] of [[1, 120], [120.9, 120], [999999, 4000]]) {
    let sent
    const run = provider({ fetchImpl: async (_url, init) => { sent = JSON.parse(init.body); return answer('🎹'.repeat(4010)) } })
    const result = await run({ ...input, maxChars: requested }, context())
    assert.equal([...result].length, expected)
    assert.equal(result.isWellFormed(), true)
    assert.equal(JSON.parse(sent.messages[1].content).maxChars, expected)
    assert.equal(sent.max_tokens, expected * 2)
  }
})

test('conversation summary requires current scoped authority before any request', async () => {
  let calls = 0
  const run = provider({ fetchImpl: async () => { calls++; return answer() } })
  await rejected(run(input))
  await rejected(run(input, context({ isCurrent: () => false })))
  await rejected(run(input, context({ signal: AbortSignal.abort() })))
  await rejected(run(input, context({ async ensureCurrent() { throw new Error('private-revocation-detail') } })))
  assert.equal(calls, 0)
})

test('conversation summary accepts fixed completion URLs and rejects credential-bearing or invalid endpoints', async () => {
  let calls = 0
  const fetchImpl = async (url, init) => {
    calls++; assert.equal(url, 'https://summary.example.com/custom/chat/completions')
    assert.equal(init.redirect, 'error')
    return answer()
  }
  assert.equal(await provider({ baseUrl: 'https://summary.example.com/custom/chat/completions', fetchImpl })(input, context()), summary)
  for (const options of [
    { baseUrl: 'file:///tmp/private' }, { baseUrl: 'https://u:p@summary.example.com/v1' },
    { baseUrl: 'https://summary.example.com/v1?token=private' }, { baseUrl: 'https://summary.example.com/v1#private' },
    { name: ' ' }, { name: apiKey }, { apiKey: '' },
  ]) await rejected(provider({ ...options, fetchImpl })(input, context()))
  assert.equal(calls, 1)
})

test('conversation summary checks complete input before dropping old records or truncating fields', async () => {
  let calls = 0
  const extraSecret = 'other-host-secret-123456'
  const run = provider({ secrets: [extraSecret], fetchImpl: async () => { calls++; return answer() } })
  const encoded = [...apiKey].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')
  for (const modified of [
    { ...input, previous: `${'文'.repeat(4010)}${apiKey}` },
    { ...input, messages: [{ ...input.messages[0], authorId: apiKey }] },
    { ...input, messages: [{ ...input.messages[0], name: `${'名'.repeat(30)}${extraSecret}` }] },
    { ...input, messages: [{ ...input.messages[0], text: `${'文'.repeat(200)}${apiKey}` }] },
    { ...input, messages: [{ ...input.messages[0], text: encoded }] },
    { ...input, previous: Buffer.from(apiKey).toString('base64') },
    { ...input, previous: encodeURIComponent(extraSecret) },
    { ...input, messages: [{ ...input.messages[0], text: apiKey }, ...Array.from({ length: 200 }, () => input.messages[0])] },
    { ...input, messages: [{ ...input.messages[0], sourceTime: extraSecret }] },
    { ...input, excluded: { credential: extraSecret } },
  ]) await rejected(run(modified, context()))
  await rejected(provider({
    secrets: ['1970-01-01 08:00:01 Asia/Shanghai'], fetchImpl: async () => { calls++; return answer() },
  })(input, context()))
  assert.equal(calls, 0)
})

test('conversation summary rejects malformed contract input without disclosing it', async () => {
  let calls = 0
  const run = provider({ fetchImpl: async () => { calls++; return answer() } })
  for (const invalid of [
    null, { ...input, previous: 1 }, { ...input, maxChars: NaN }, { ...input, maxChars: Infinity },
    { ...input, messages: null }, { ...input, messages: [null] },
    ...[{ at: Infinity }, { at: NaN }, { at: -1 }, { at: Number.MAX_SAFE_INTEGER }, { authorId: 1 }, { name: null }, { text: 4 }].map(change => ({ ...input, messages: [{ ...input.messages[0], ...change }] })),
    { ...input, messages: [{ ...input.messages[0], at: Number.MAX_SAFE_INTEGER }, ...Array.from({ length: 200 }, () => input.messages[0])] },
  ]) await rejected(run(invalid, context()))
  assert.equal(calls, 0)
})

test('conversation summary refuses real redirects without forwarding credentials or retrying', async t => {
  let calls = 0, targetCalls = 0
  const baseUrl = await listen(t, (request, response) => {
    calls++
    if (request.url === '/trap') { targetCalls++; response.end(apiKey); return }
    response.writeHead(307, { location: '/trap' }).end('private-redirect-body')
  })
  await rejected(provider({ baseUrl })(input, context()))
  assert.equal(calls, 1)
  assert.equal(targetCalls, 0)
})

test('conversation summary returns only nonempty plain text and rejects structured or tool output', async () => {
  for (const content of [null, 42, {}, [], '', ' \n ', '{"text":"摘要"}', '["摘要"]', '```json\n{"text":"摘要"}\n```', '```text\n摘要\n```']) {
    await rejected(provider({ fetchImpl: async () => answer(content) })(input, context()))
  }
  for (const extra of [
    { choices: [{ message: { content: summary, tool_calls: [] } }] },
    { choices: [{ message: { content: summary, function_call: null } }] },
    { error: { message: 'private-provider-error' } },
  ]) await rejected(provider({ fetchImpl: async () => answer(summary, extra) })(input, context()))
  assert.equal(await provider({ fetchImpl: async () => answer(summary) })(input, context()), summary)
})

test('conversation summary checks all provider output for credentials before truncation and hides provider errors', async () => {
  const extraSecret = 'other-host-secret-123456'
  const encoded = [...apiKey].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')
  for (const fetchImpl of [
    async () => { throw new Error(`private-provider-detail ${apiKey}`) },
    async () => new Response(`private-provider-body ${apiKey}`, { status: 500 }),
    async () => answer(`${'文'.repeat(5000)}${apiKey}`),
    async () => answer(encoded),
    async () => answer(Buffer.from(apiKey).toString('base64')),
    async () => answer(summary, { metadata: { privateDetail: extraSecret } }),
    async () => answer(summary, { metadata: { privateDetail: encoded } }),
    async () => { const response = answer(); Object.defineProperty(response, 'redirected', { value: true }); return response },
  ]) {
    let calls = 0
    await rejected(provider({ secrets: [extraSecret], fetchImpl: (...args) => { calls++; return fetchImpl(...args) } })(input, context()))
    assert.equal(calls, 1)
  }
})

test('conversation summary records only valid usage before async revocation or rejected output', async () => {
  for (const mode of ['revoked', 'invalid', 'http-error', 'secret']) {
    let revoked = false
    const usage = []
    const run = provider({ fetchImpl: async () => {
      revoked = mode === 'revoked'
      return answer(mode === 'invalid' ? '{}' : mode === 'secret' ? apiKey : summary, {
        usage: { total_tokens: 9, prompt_tokens: -1, completion_tokens: 'invalid', extra: 3 },
      }, mode === 'http-error' ? { status: 429 } : undefined)
    } })
    await rejected(run(input, context({
      async ensureCurrent() { if (revoked) throw new Error('private-authorization-detail') },
      recordUsage: (...args) => usage.push(args),
    })))
    assert.deepEqual(usage, [[config.name, { total_tokens: 9 }]])
  }
})

test('conversation summary rechecks authorization before releasing a valid summary', async () => {
  let checks = 0
  await rejected(provider({ fetchImpl: async () => answer() })(input, context({
    async ensureCurrent() { if (++checks === 3) throw new Error('private-final-revocation') },
  })))
  assert.equal(checks, 3)
})

test('conversation summary accepts exactly 512 KiB and refuses a larger real HTTP body without retrying', async t => {
  let calls = 0
  const valid = JSON.stringify({ choices: [{ message: { content: summary } }] })
  const maximum = valid + ' '.repeat(512 * 1024 - Buffer.byteLength(valid))
  const baseUrl = await listen(t, (_request, response) => {
    calls++
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(calls === 1 ? maximum : `${maximum} `)
  })
  assert.equal(await provider({ baseUrl })(input, context()), summary)
  await rejected(provider({ baseUrl })(input, context()))
  assert.equal(calls, 2)
})

test('conversation summary cancels oversized response streams and rejects oversized declared bodies', async () => {
  for (const declared of [false, true]) {
    let cancelled = false
    const body = new ReadableStream({ start(controller) { if (!declared) controller.enqueue(new Uint8Array(512 * 1024 + 1)) }, cancel() { cancelled = true } })
    await rejected(provider({ fetchImpl: async () => new Response(body, declared ? { headers: { 'content-length': String(512 * 1024 + 1) } } : undefined) })(input, context()))
    assert.equal(cancelled, true)
  }
})

test('conversation summary real HTTP body reads obey the whole deadline and caller cancellation', async t => {
  let calls = 0
  const baseUrl = await listen(t, (_request, response) => {
    calls++
    response.writeHead(200, { 'content-type': 'application/json' })
    response.flushHeaders()
    response.write('{"choices":[')
  })
  for (const mode of ['deadline', 'abort']) {
    const controller = new AbortController()
    const timer = mode === 'abort' ? setTimeout(() => controller.abort(), 50) : undefined
    try {
      await rejected(provider({ baseUrl, timeoutMs: mode === 'deadline' ? 50 : 1000 })(input, context({ signal: controller.signal })))
    } finally { clearTimeout(timer) }
  }
  assert.equal(calls, 2)
})

test('conversation summary authorization waits can be cancelled or timed out before requests', async () => {
  for (const mode of ['deadline', 'abort']) {
    const controller = new AbortController()
    let calls = 0, checks = 0
    const timer = setTimeout(() => controller.abort(), mode === 'abort' ? 10 : 1000)
    try {
      await rejected(provider({ timeoutMs: mode === 'deadline' ? 10 : undefined, fetchImpl: async () => { calls++; return answer() } })(input, context({
        signal: controller.signal, ensureCurrent: async () => { checks++; return new Promise(() => {}) },
      })))
      assert.equal(checks, 1)
      assert.equal(calls, 0)
    } finally { clearTimeout(timer) }
  }
})

test('conversation summary transport waits can be cancelled even when injected transport ignores the signal', async () => {
  const controller = new AbortController()
  let transportSignal
  const timer = setTimeout(() => controller.abort(), 10)
  try {
    await rejected(provider({ fetchImpl: async (_url, init) => { transportSignal = init.signal; return new Promise(() => {}) } })(input, context({ signal: controller.signal })))
    assert.equal(transportSignal.aborted, true)
  } finally { clearTimeout(timer) }
})

test('conversation summary observes late transport rejection after synchronous cancellation', async () => {
  const controller = new AbortController()
  await rejected(provider({ fetchImpl: () => {
    controller.abort()
    return Promise.reject(new Error('private-late-provider-detail'))
  } })(input, context({ signal: controller.signal })))
  await new Promise(resolve => setImmediate(resolve))
})

test('conversation summary cannot increase its fixed 30 second deadline', async t => {
  const deadlines = []
  t.mock.method(AbortSignal, 'timeout', value => { deadlines.push(value); return new AbortController().signal })
  for (const [requested, expected] of [[undefined, 30000], [120000, 30000], [0, 1], [25.9, 25]]) {
    assert.equal(await provider({ timeoutMs: requested, fetchImpl: async () => answer() })(input, context()), summary)
    assert.equal(deadlines.at(-1), expected)
  }
})
