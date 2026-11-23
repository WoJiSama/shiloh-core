import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { createAgentGroupMemoryModel } from '../dist/backend/modules/memory/infrastructure/agentGroupMemoryModel.js'

const apiKey = 'group-memory-provider-private-key-123456'
const config = { baseUrl: 'https://group-memory.example.com/v1', name: 'group-memory-fixture', apiKey }
const FAILURE = '群记忆提取失败：请求已取消、授权失效或模型服务不可用。'
const source = { messageId: 'private-message-id', authorId: 'speaker-id', name: '小林', text: '请记住，周三大家在活动室排练；甲是美术组成员，甲哥也是甲，地图是地图世界.zip；以后排练要通知甲。', at: 1000,
  mentions: ['member-a'], files: [{ name: '地图世界.zip', reference: 'private-file-reference' }] }
const input = { mode: 'consensus', messages: [source], members: [{ id: 'member-a', name: '甲' }, { id: 'member-b', name: '乙' }, { id: 'bot-id', name: '机器人' }], botUserId: 'bot-id' }
const fact = { kind: 'fact', sourceIndex: 1, excerpt: '周三大家在活动室排练', text: '周三在活动室排练', tags: ['排练'], relatedUserIds: ['member-a', 'speaker-id'] }
function context(overrides = {}) {
  return {
    target: { account: { platform: 'private-platform', namespace: 'private-namespace', id: 'private-account' }, kind: 'group', id: 'private-scene' },
    binding: { source: 'configured', id: 'private-binding', agentId: 'private-agent', revision: 'private-revision', personaId: 'private-persona', connectionId: 'private-connection' },
    signal: new AbortController().signal, isCurrent: () => true, ensureCurrent: async () => {}, ...overrides,
  }
}
function answer(content = JSON.stringify([fact]), extra = {}, init) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], ...extra }), init)
}
function provider(options = {}) { return createAgentGroupMemoryModel({ ...config, ...options }) }
async function rejected(operation, code, httpStatus) {
  await assert.rejects(operation, error => {
    assert.equal(error.message, FAILURE)
    assert.equal(error.cause, undefined)
    if (code) assert.equal(error.code, code)
    if (httpStatus !== undefined) assert.equal(error.httpStatus, httpStatus)
    else assert.ok(error.httpStatus === undefined || error.httpStatus === 200)
    return true
  })
}
async function listen(t, handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return `http://127.0.0.1:${server.address().port}`
}

test('group memory uses a fixed real HTTP backend with two roles, bounded data and scoped usage', async t => {
  const received = [], usage = []
  const baseUrl = await listen(t, async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    received.push({ path: request.url, method: request.method, authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify([fact]) } }],
      usage: { prompt_tokens: 8, completion_tokens: 0, total_tokens: 8, extra: 'private-usage-detail' } }))
  })
  const messages = Array.from({ length: 40 }, (_, index) => ({ ...source, messageId: `private-message-${index}`, name: '🐈'.repeat(30), text: source.text + '🎶'.repeat(500), nativeEvent: 'private-native-event' }))
  assert.deepEqual(await provider({ baseUrl: `${baseUrl}/v1` })({ ...input, messages, members: input.members.map(member => ({ ...member, name: '🧭'.repeat(30) })), authority: 'private-authority' },
    context({ recordUsage: (...args) => usage.push(args) })), [fact])
  assert.equal(received.length, 1)
  const request = received[0]
  assert.equal(request.path, '/v1/chat/completions')
  assert.equal(request.method, 'POST')
  assert.equal(request.authorization, `Bearer ${apiKey}`)
  assert.deepEqual(Object.keys(request.body), ['model', 'messages', 'stream', 'temperature', 'max_tokens'])
  assert.equal(request.body.model, config.name)
  assert.equal(request.body.stream, false)
  assert.equal(request.body.temperature, 0.2)
  assert.equal(request.body.max_tokens, 2000)
  assert.deepEqual(request.body.messages.map(row => row.role), ['system', 'user'])
  const material = JSON.parse(request.body.messages[1].content)
  assert.deepEqual(Object.keys(material), ['mode', 'messages', 'members', 'botUserId'])
  assert.equal(material.messages.length, 40)
  assert.deepEqual(material.messages.map(row => row.sourceIndex), Array.from({ length: 40 }, (_, index) => index + 1))
  for (const row of material.messages) {
    assert.equal([...row.name].length, 24)
    assert.equal([...row.text].length, 400)
    assert.equal(row.text.isWellFormed(), true)
    assert.deepEqual(row.files, [{ name: '地图世界.zip' }])
  }
  assert.ok(material.members.every(member => [...member.name].length === 24))
  assert.doesNotMatch(JSON.stringify(material), /private-|nativeEvent|reference|authority/u)
  assert.deepEqual(usage, [[config.name, { prompt_tokens: 8, completion_tokens: 0, total_tokens: 8 }]])
})

test('group learning requests disable reasoning only on the supported official GLM Flash route', async () => {
  for (const [baseUrl, name, expected] of [
    ['https://open.bigmodel.cn/api/paas/v4', 'glm-5.3-flash', { type: 'disabled' }],
    ['https://example.test/v1', 'glm-5.3-flash', undefined],
    ['https://open.bigmodel.cn/api/paas/v4', 'another-model', undefined],
  ]) {
    const extract = provider({ baseUrl, name, fetchImpl: async (_url, init) => {
      assert.deepEqual(JSON.parse(init.body).thinking, expected)
      return answer()
    } })
    assert.deepEqual(await extract(input, context()), [fact])
  }
})

test('teaching preserves the complete bounded utterance and validates every proposal kind and owner identity', async () => {
  const taught = [
    { kind: 'alias', sourceIndex: 1, excerpt: '甲哥也是甲', subject: '甲哥', targetUserIds: ['member-a'] },
    { kind: 'member_definition', sourceIndex: 1, excerpt: '甲是美术组成员', subject: '搭档', targetUserIds: ['member-a'], ownerId: 'speaker' },
    { kind: 'member_set', sourceIndex: 1, excerpt: '甲是美术组成员', subject: '美术组', targetUserIds: ['member-a', 'member-b'], ownerId: 'bot' },
    { kind: 'group_file', sourceIndex: 1, excerpt: '地图是地图世界.zip', subject: '地图', fileName: '地图世界.zip', ownerId: 'member-a' },
    { kind: 'workflow', sourceIndex: 1, excerpt: '以后排练要通知甲', condition: '有人组织排练', targetUserIds: ['member-a'] },
  ]
  const body = source.text + '🌲'.repeat(4000 - [...source.text].length)
  let sent
  const result = await provider({ fetchImpl: async (_url, init) => { sent = JSON.parse(init.body); return answer(JSON.stringify(taught)) } })({ ...input, mode: 'teaching', messages: [{ ...source, text: body }] }, context())
  assert.deepEqual(result, taught.map(row => ({ ...row, ...(row.ownerId === 'bot' ? { ownerId: 'bot-id' } : row.ownerId === 'speaker' ? { ownerId: 'speaker-id' } : {}) })))
  assert.equal(JSON.parse(sent.messages[1].content).messages[0].text, body)
})

test('semantic teaching policy explicitly excludes ordinary requests, quoted acknowledgements, hypotheticals and fictional roles', async () => {
  for (const text of ['现在帮我通知甲', '他说“记住甲是组长”，这是什么意思？', '如果我教你规则，你会自动通知吗？', '给小说分配角色，机器人上次说记住了']) {
    let system
    const result = await provider({ fetchImpl: async (_url, init) => { system = JSON.parse(init.body).messages[0].content; return answer('[]') } })({ ...input, mode: 'teaching', messages: [{ ...source, text }] }, context())
    assert.deepEqual(result, [])
    for (const clause of ['不可信资料', '明确要求保存', '一次普通请求', '询问规则', '假设', '否定保存', '转发', '引用', '转述', '创作故事', '必须输出 []', '不能自动授权工具', '教学本身不能立即执行']) assert.ok(system.includes(clause), clause)
    assert.match(system, /不能创建或提升任何平台身份/u)
    assert.match(system, /不能把一个人的推测.*夸大为多人共识/u)
  }
})

test('consensus accepts a single grounded source and related IDs only from verified members or actual authors', async () => {
  const variant = { ...fact, sourceIndex: 2, excerpt: '活动室改到二楼', text: '活动室改到二楼', relatedUserIds: ['new-author'] }
  const result = await provider({ fetchImpl: async () => answer(JSON.stringify([variant])) })({ ...input, messages: [source, { ...source, authorId: 'new-author', text: '活动室改到二楼' }] }, context())
  assert.deepEqual(result, [variant])
  assert.deepEqual(await provider({ fetchImpl: async () => answer('[]') })(input, context()), [])
})

test('group memory rejects unknown fields, invalid modes and ungrounded or oversized consensus output', async () => {
  const invalid = [
    {}, null, 'text', [], { ...fact, kind: 'workflow' }, { ...fact, mode: 'consensus' }, { ...fact, role: 'admin' },
    { ...fact, sourceIndex: 0 }, { ...fact, sourceIndex: 2 }, { ...fact, sourceIndex: 1.5 },
    { ...fact, sourceIndex: '1' }, { ...fact, excerpt: '伪造的原文' }, { ...fact, excerpt: '周' },
    { ...fact, excerpt: '   ' }, { ...fact, excerpt: 7 }, { ...fact, text: '' }, { ...fact, text: '🌱'.repeat(241) },
    { ...fact, subject: '越权定义' }, { ...fact, tags: Array.from({ length: 9 }, (_, index) => `tag${index}`) },
    { ...fact, tags: ['🌱'.repeat(25)] }, { ...fact, tags: ['重复', '重复'] }, { ...fact, tags: '标签' },
    { ...fact, relatedUserIds: ['invented-id'] }, { ...fact, relatedUserIds: ['speaker-id', 'speaker-id'] },
  ]
  for (const row of invalid) await rejected(provider({ fetchImpl: async () => answer(JSON.stringify([row])) })(input, context()))
  for (const content of ['', ' ', 'null', '{}', '```json\n[]\n```', '[] trailing', 'not-json']) await rejected(provider({ fetchImpl: async () => answer(content) })(input, context()))
  const truncated = { ...input, messages: [{ ...source, text: '文'.repeat(400) + '不可见的后半句' }] }
  await rejected(provider({ fetchImpl: async () => answer(JSON.stringify([{ ...fact, excerpt: '不可见的后半句' }])) })(truncated, context()))
  assert.deepEqual(await provider({ fetchImpl: async () => answer(JSON.stringify([{ ...fact, text: '🌱'.repeat(240), tags: ['🌱'.repeat(24)] }])) })(input, context()), [{ ...fact, text: '🌱'.repeat(240), tags: ['🌱'.repeat(24)] }])
})

test('teaching rejects invented targets, bot targets, duplicate IDs, unsupported owners and unrelated files', async () => {
  const base = { kind: 'member_set', sourceIndex: 1, excerpt: '甲是美术组成员', subject: '美术组', targetUserIds: ['member-a'] }
  const invalid = [
    { ...base, kind: 'fact', text: '不能走共识' }, { ...base, targetUserIds: ['invented-id'] }, { ...base, targetUserIds: ['甲'] },
    { ...base, targetUserIds: ['bot-id'] }, { ...base, targetUserIds: [] }, { ...base, targetUserIds: ['member-a', 'member-a'] },
    { ...base, targetUserIds: 'member-a' }, { ...base, targetUserIds: undefined }, { ...base, ownerId: 'invented-id' },
    { ...base, subject: '字'.repeat(81) }, { ...base, kind: 'alias', targetUserIds: ['member-a', 'member-b'] },
    { ...base, kind: 'member_definition', targetUserIds: ['member-a', 'member-b'] },
    { kind: 'workflow', sourceIndex: 1, excerpt: '以后排练要通知甲', condition: '字'.repeat(121), targetUserIds: ['member-a'] },
    { kind: 'workflow', sourceIndex: 1, excerpt: '以后排练要通知甲', condition: '排练', targetUserIds: ['member-a'], permission: true },
    { kind: 'group_file', sourceIndex: 1, excerpt: '地图是地图世界.zip', subject: '地图', fileName: '另一个文件.zip' },
    { kind: 'group_file', sourceIndex: 1, excerpt: '地图是地图世界.zip', subject: '地图', fileName: 'https://files.example/map.zip' },
  ]
  for (const row of invalid) await rejected(provider({ fetchImpl: async () => answer(JSON.stringify([row])) })({ ...input, mode: 'teaching' }, context()))
  await rejected(provider({ fetchImpl: async () => answer(JSON.stringify([{ kind: 'group_file', sourceIndex: 1, excerpt: '地图是地图世界.zip', subject: '地图', fileName: 'https://files.example/map.zip' }])) })({ ...input, mode: 'teaching', messages: [{ ...source, files: [{ name: 'https://files.example/map.zip' }] }] }, context()))
})

test('group memory rejects malformed input and caps message and verified-member counts before dispatch', async () => {
  let calls = 0
  const run = provider({ fetchImpl: async () => { calls++; return answer() } })
  const invalid = [
    null, { ...input, mode: 'other' }, { ...input, botUserId: '' }, { ...input, messages: [] }, { ...input, messages: null },
    { ...input, messages: Array.from({ length: 41 }, () => source) }, { ...input, members: Array.from({ length: 13 }, (_, index) => ({ id: `id${index}`, name: '人' })) },
    { ...input, members: [...input.members, input.members[0]] }, { ...input, members: [{ id: 3, name: '甲' }] },
    { ...input, mode: 'teaching', messages: [{ ...source, text: '🌱'.repeat(4001) }] },
    ...[null, { ...source, messageId: '' }, { ...source, authorId: null }, { ...source, name: 3 }, { ...source, text: '' },
      { ...source, at: Infinity }, { ...source, at: -1 }, { ...source, at: 0.5 }, { ...source, mentions: [4] }, { ...source, files: [{ name: '' }] }]
      .map(row => ({ ...input, messages: [row] })),
  ]
  for (const row of invalid) await rejected(run(row, context()))
  assert.equal(calls, 0)
})

test('complete input credentials are checked before Unicode truncation or removal of host fields', async () => {
  let calls = 0
  const extra = 'another-host-private-credential-123456'
  const run = provider({ secrets: [extra], fetchImpl: async () => { calls++; return answer() } })
  const encoded = [...apiKey].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')
  for (const row of [
    { ...input, messages: [{ ...source, name: '名'.repeat(30) + apiKey }] },
    { ...input, messages: [{ ...source, text: '文'.repeat(500) + apiKey }] },
    { ...input, messages: [{ ...source, messageId: extra }] },
    { ...input, messages: [{ ...source, files: [{ name: '地图.zip', reference: apiKey }] }] },
    { ...input, members: [{ id: 'member-a', name: '名'.repeat(30) + extra }] },
    { ...input, hidden: { [extra]: 'value' } }, { ...input, hidden: encoded },
    { ...input, hidden: Buffer.from(apiKey).toString('base64') }, { ...input, hidden: encodeURIComponent(extra) },
  ]) await rejected(run(row, context()))
  assert.equal(calls, 0)
})

test('group memory requires current revocable authority before requests and before returning proposals', async () => {
  let calls = 0
  const run = provider({ fetchImpl: async () => { calls++; return answer() } })
  await rejected(run(input))
  await rejected(run(input, context({ isCurrent: () => false })))
  await rejected(run(input, context({ signal: AbortSignal.abort() })))
  await rejected(run(input, context({ async ensureCurrent() { throw Error('private-auth-error') } })))
  assert.equal(calls, 0)
  let checks = 0
  await rejected(run(input, context({ async ensureCurrent() { if (++checks === 3) throw Error('private-final-revocation') } })))
  assert.equal(checks, 3)
  assert.equal(calls, 1)
})

test('provider credentials, malformed/tool output and HTTP errors produce one fixed safe failure without retries', async () => {
  const encoded = [...apiKey].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')
  for (const [fetchImpl, code, httpStatus] of [
    [async () => { throw Error(`private-provider-error ${apiKey}`) }, 'provider_transport_error'],
    [async () => new Response(`private-error ${apiKey}`, { status: 500 }), 'http_error', 500],
    [async () => answer(JSON.stringify([{ ...fact, text: apiKey }])), 'model_response_invalid'],
    [async () => answer('[]', { metadata: { credential: encoded } }), 'model_response_invalid'],
    [async () => answer('[]', { metadata: { credential: Buffer.from(apiKey).toString('base64') } }), 'model_response_invalid'],
    [async () => answer('[]', { choices: [{ message: { content: '[]', tool_calls: [] } }] }), 'model_response_invalid'],
    [async () => answer('[]', { choices: [{ message: { content: '[]', function_call: null } }] }), 'model_response_invalid'],
    [async () => answer('[]', { error: { message: 'private-provider-error' } }), 'model_response_invalid'],
    [async () => { const response = answer(); Object.defineProperty(response, 'redirected', { value: true }); return response }, 'model_response_invalid'],
  ]) {
    let calls = 0
    await rejected(provider({ fetchImpl: (...args) => { calls++; return fetchImpl(...args) } })(input, context()), code, httpStatus)
    assert.equal(calls, 1)
  }
})

test('usage is recorded once before asynchronous stale rejection and invalid provider output', async () => {
  for (const mode of ['stale', 'invalid', 'http-error', 'secret']) {
    let stale = false
    const usage = []
    const run = provider({ fetchImpl: async () => { stale = mode === 'stale'; return answer(mode === 'invalid' ? '{}' : mode === 'secret' ? apiKey : JSON.stringify([fact]),
      { usage: { total_tokens: 9, prompt_tokens: -1, completion_tokens: 'bad', extra: 'private-usage-detail' } }, mode === 'http-error' ? { status: 429 } : undefined) } })
    await rejected(run(input, context({ ensureCurrent: async () => { if (stale) throw Error('private-stale-detail') }, recordUsage: (...args) => usage.push(args) })),
      mode === 'http-error' ? 'http_error' : 'model_response_invalid', mode === 'http-error' ? 429 : undefined)
    assert.deepEqual(usage, [[config.name, { total_tokens: 9 }]])
  }
})

test('group memory validates the fixed endpoint and refuses real redirects without forwarding credentials', async t => {
  let calls = 0, targetCalls = 0
  const baseUrl = await listen(t, (request, response) => {
    calls++
    if (request.url === '/trap') { targetCalls++; response.end(apiKey); return }
    response.writeHead(307, { location: '/trap' }).end('private-redirect')
  })
  await rejected(provider({ baseUrl })(input, context()))
  assert.equal(calls, 1)
  assert.equal(targetCalls, 0)
  for (const change of [{ baseUrl: 'file:///tmp/private' }, { baseUrl: 'https://u:p@example.com' }, { baseUrl: `${baseUrl}?key=x` }, { baseUrl: `${baseUrl}#x` }, { apiKey: '' }, { name: apiKey }, { name: ' ' }]) {
    await rejected(provider({ ...change, fetchImpl: async () => { calls++; return answer() } })(input, context()))
  }
  assert.equal(calls, 1)
  assert.deepEqual(await provider({ baseUrl: 'https://group-memory.example.com/custom/chat/completions', fetchImpl: async (url, init) => {
    assert.equal(url, 'https://group-memory.example.com/custom/chat/completions'); assert.equal(init.redirect, 'error'); return answer()
  } })(input, context()), [fact])
})

test('group memory accepts exactly 512 KiB and cancels larger declared or streamed bodies', async t => {
  let calls = 0
  const valid = JSON.stringify({ choices: [{ message: { content: JSON.stringify([fact]) } }] })
  const maximum = valid + ' '.repeat(512 * 1024 - Buffer.byteLength(valid))
  const baseUrl = await listen(t, (_request, response) => { calls++; response.writeHead(200, { 'content-type': 'application/json' }).end(calls === 1 ? maximum : maximum + ' ') })
  assert.deepEqual(await provider({ baseUrl })(input, context()), [fact])
  await rejected(provider({ baseUrl })(input, context()))
  assert.equal(calls, 2)
  for (const declared of [false, true]) {
    let cancelled = false
    const body = new ReadableStream({ start(controller) { if (!declared) controller.enqueue(new Uint8Array(512 * 1024 + 1)) }, cancel() { cancelled = true } })
    await rejected(provider({ fetchImpl: async () => new Response(body, declared ? { headers: { 'content-length': String(512 * 1024 + 1) } } : undefined) })(input, context()))
    assert.equal(cancelled, true)
  }
})

test('whole-request deadline and caller cancellation cover real HTTP body reads', async t => {
  let calls = 0
  const baseUrl = await listen(t, (_request, response) => { calls++; response.writeHead(200, { 'content-type': 'application/json' }); response.flushHeaders(); response.write('{"choices":[') })
  for (const mode of ['deadline', 'abort']) {
    const controller = new AbortController()
    const timer = mode === 'abort' ? setTimeout(() => controller.abort(), 50) : undefined
    try {
      await rejected(provider({ baseUrl, timeoutMs: mode === 'deadline' ? 50 : 1000 })(input, context({ signal: controller.signal })),
        mode === 'deadline' ? 'provider_timeout' : 'request_cancelled')
    }
    finally { clearTimeout(timer) }
  }
  assert.equal(calls, 2)
})

test('whole-request cancellation bounds authorization and transports that ignore the signal', async () => {
  for (const stage of ['authority', 'transport']) for (const mode of ['deadline', 'abort']) {
    const controller = new AbortController()
    let calls = 0
    const timer = setTimeout(() => controller.abort(), mode === 'abort' ? 10 : 1000)
    try {
      await rejected(provider({ timeoutMs: mode === 'deadline' ? 10 : 1000, fetchImpl: async () => { calls++; return new Promise(() => {}) } })(input,
        context({ signal: controller.signal, ensureCurrent: async () => { if (stage === 'authority') return await new Promise(() => {}) } })))
      assert.equal(calls, stage === 'transport' ? 1 : 0)
    } finally { clearTimeout(timer) }
  }
  const controller = new AbortController()
  await rejected(provider({ fetchImpl: () => { controller.abort(); return Promise.reject(Error('private-late-error')) } })(input, context({ signal: controller.signal })))
  await new Promise(resolve => setImmediate(resolve))
})

test('group memory cannot increase its fixed 30 second deadline', async t => {
  const deadlines = []
  t.mock.method(AbortSignal, 'timeout', value => { deadlines.push(value); return new AbortController().signal })
  for (const [requested, expected] of [[undefined, 30000], [120000, 30000], [0, 1], [25.9, 25]]) {
    assert.deepEqual(await provider({ timeoutMs: requested, fetchImpl: async () => answer() })(input, context()), [fact])
    assert.equal(deadlines.at(-1), expected)
  }
})
