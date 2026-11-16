import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentRenderingTools } from '../dist/backend/modules/tools/infrastructure/agentRenderingTools.js'

const SECRET = 'independent-map-private-token-12345'
const HOST_SECRET = 'onebot-host-private-token-67890/+='
const PNG = { mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR9sAAAAASUVORK5CYII=' }
const backend = { baseUrl: 'https://map.example/v1', name: 'independent-map', apiKey: SECRET }
const completion = content => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 4, completion_tokens: 7, total_tokens: 11, ignored: 'provider-detail' } })
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
function fixture(options = {}, overrides = {}) {
  const renders = [], requests = [], sent = [], usage = []
  const controller = new AbortController()
  const ctx = { binding: { id: 'private-binding', agentId: 'private-agent', revision: 'private-revision', target: { account: { platform: 'fixture', namespace: 'fixture', id: 'bot' }, kind: 'group', id: 'private-target' } },
    actor: { kind: 'user', user: { platform: 'fixture', namespace: 'fixture', id: 'peer' } }, request: { messageId: 'private-request', text: 'private-conversation-history', mentions: [] },
    signal: controller.signal, isCurrent: () => true, async ensureCurrent() {}, recordUsage: (model, counts) => usage.push({ model, counts }),
    async sendImage(image) { sent.push(image); return { state: 'sent', messageId: 'confirmed' } }, ...overrides }
  const registry = createAgentRenderingTools({ rendering: { textImage: { enabled: true }, mindMap: backend }, secrets: [HOST_SECRET],
    async renderTextImage(input, context) { renders.push({ kind: 'text', input, context }); return PNG },
    async renderMindMap(input, context) { renders.push({ kind: 'map', input, context }); return PNG },
    async fetchImpl(url, init) { requests.push({ url, init }); return json(completion('# 主题\n## 分支\n- 节点')) }, ...options })
  const tools = Object.fromEntries(registry.builtIn.map(tool => [tool.name, tool]))
  return { tools, ctx, controller, renders, requests, sent, usage,
    execute(name, input) { return tools[name].execute(input, ctx) } }
}

test('rendering defaults off, keeps original tool names, closed schemas and explicit independent model', () => {
  assert.deepEqual(createAgentRenderingTools(), { builtIn: [] })
  for (const mindMap of [{}, { ...backend, apiKey: '' }, { ...backend, baseUrl: 'https://user:secret@map.example' }, { ...backend, baseUrl: 'file:///tmp/model' }, { ...backend, baseUrl: 'https://map.example?key=secret' }]) assert.throws(() => createAgentRenderingTools({ rendering: { mindMap } }))
  const { tools } = fixture()
  assert.deepEqual(Object.keys(tools), ['textImageTool', 'aiMindMapTool'])
  for (const tool of Object.values(tools)) assert.equal(tool.parameters.additionalProperties, false)
  assert.equal(tools.textImageTool.timeoutMs, 45_000)
  assert.equal(tools.aiMindMapTool.timeoutMs, 90_000)
})

test('text rendering retains auto document selection, knowledge priority and Unicode truncation before one delivery', async () => {
  const f = fixture()
  assert.equal((await f.execute('textImageTool', { text: '普通文字', nickname: '角色' })).status, 'succeeded')
  assert.deepEqual(f.renders[0].input, { text: '普通文字', template: 'chat', nickname: '角色' })
  assert.equal((await f.execute('textImageTool', { text: '```js\nconst a = 1\n```', template: 'chat' })).status, 'succeeded')
  assert.equal(f.renders[1].input.template, 'document')
  assert.equal((await f.execute('textImageTool', { text: '# 结论\n## 步骤', template: 'knowledge' })).status, 'succeeded')
  assert.equal(f.renders[2].input.template, 'knowledge')
  await f.execute('textImageTool', { text: '😀'.repeat(6000) })
  assert.equal([...f.renders[3].input.text].length, 5000)
  await f.execute('textImageTool', { text: '😀'.repeat(13000), template: 'document' })
  assert.equal([...f.renders[4].input.text].length, 12000)
  assert.equal(f.sent.length, 5)
  assert.equal(f.requests.length, 0)
})

test('strict validation and outgoing text policy reject before any renderer, model or public request', async () => {
  const f = fixture({ allowsText: value => !value.includes('blocked') })
  for (const input of [null, [], {}, { text: ' ' }, { text: 1 }, { text: 'x'.repeat(48001) }, { text: 'x\u0000' }, { text: SECRET }, { text: encodeURIComponent(HOST_SECRET) },
    { text: 'blocked' }, { text: 'x', template: ['chat'] }, { text: 'x', nickname: [] }, { text: 'x', nickname: 'blocked' },
    { text: 'x', avatarUrl: 'file:///private' }, { text: 'x', avatarUrl: `https://example.com/${SECRET}` }, { text: 'x', target: 'other' },
  ]) assert.equal((await f.execute('textImageTool', input)).status, 'failed')
  for (const input of [null, [], {}, { prompt: ' ' }, { prompt: [] }, { prompt: 'x'.repeat(4001) }, { prompt: SECRET }, { prompt: 'blocked' }, { prompt: 'x', width: '100' }, { prompt: 'x', height: Infinity }, { prompt: 'x', waitTime: NaN }, { prompt: 'x', model: 'main' }]) assert.equal((await f.execute('aiMindMapTool', input)).status, 'failed')
  assert.deepEqual([f.renders.length, f.sent.length, f.requests.length], [0, 0, 0])
})

test('avatar uses pinned public bytes only in chat, blocked avatar degrades without losing text', async () => {
  const calls = []
  const f = fixture({ publicImage: { lookup: async hostname => { calls.push(hostname); return [{ address: '8.8.8.8', family: 4 }] },
    request: async (url, address, signal) => { assert.equal(address.address, '8.8.8.8'); assert.ok(signal instanceof AbortSignal); return { status: 200, headers: { 'content-type': 'image/png' }, body: Buffer.from(PNG.base64, 'base64') } } } })
  await f.execute('textImageTool', { text: 'hello', avatarUrl: 'https://avatar.example/a.png' })
  assert.deepEqual(f.renders[0].input.avatar, PNG)
  await f.execute('textImageTool', { text: '## Heading', avatarUrl: 'https://avatar.example/a.png' })
  assert.equal(f.renders[1].input.avatar, undefined)
  await f.execute('textImageTool', { text: 'hello', avatarUrl: 'http://127.0.0.1/private.png' })
  assert.equal(f.renders[2].input.avatar, undefined)
  assert.deepEqual(calls, ['avatar.example'])
})

test('mind map uses one compact independent model request and attributed numeric usage', async () => {
  const f = fixture()
  const result = await f.execute('aiMindMapTool', { prompt: '学习路线', width: 960, height: 640, waitTime: 2000 })
  assert.equal(result.status, 'succeeded')
  assert.equal(f.requests.length, 1)
  const { url, init } = f.requests[0]
  assert.equal(url, 'https://map.example/v1/chat/completions')
  assert.equal(init.redirect, 'error')
  assert.equal(init.headers.Authorization, `Bearer ${SECRET}`)
  assert.ok(init.signal instanceof AbortSignal)
  const body = JSON.parse(init.body)
  assert.equal(body.model, backend.name)
  assert.equal(body.messages.length, 2)
  assert.deepEqual(body.messages[1], { role: 'user', content: '学习路线' })
  assert.doesNotMatch(init.body, /private-|onebot|persona|history/u)
  assert.deepEqual(f.usage, [{ model: backend.name, counts: { prompt_tokens: 4, completion_tokens: 7, total_tokens: 11 } }])
  assert.deepEqual(f.renders[0].input, { markdown: '# 主题\n## 分支\n- 节点', width: 960, height: 640, waitTime: 2000 })
  assert.equal(f.sent.length, 1)
  assert.ok(!JSON.stringify(result).includes(PNG.base64))
})

test('provider failures, malformed choices, credentials and forbidden generated text never reach rendering', async () => {
  const bad = [completion(SECRET), completion(encodeURIComponent(HOST_SECRET)), completion('blocked'), completion('x'.repeat(24001)),
    { choices: [] }, { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '# 截断' } }] },
    { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '# good', tool_calls: [] } }] },
    { choices: [{ finish_reason: 'stop', message: { role: 'user', content: '# good' } }] },
  ]
  for (const value of bad) {
    const f = fixture({ fetchImpl: async () => json(value), allowsText: text => !text.includes('blocked') })
    const result = await f.execute('aiMindMapTool', { prompt: 'map' })
    assert.equal(result.status, 'failed')
    assert.deepEqual([f.renders.length, f.sent.length], [0, 0])
    assert.doesNotMatch(JSON.stringify(result), /private-token|blocked|截断/u)
  }
  for (const response of [() => new Response('provider-private-detail', { status: 500 }), () => new Response('x'.repeat(256 * 1024 + 1))]) {
    const f = fixture({ fetchImpl: async () => response() })
    assert.equal((await f.execute('aiMindMapTool', { prompt: 'map' })).status, 'failed')
    assert.equal(f.sent.length, 0)
  }
})

test('missing host capabilities and corrupt image bytes fail without dispatch', async () => {
  for (const name of ['textImageTool', 'aiMindMapTool']) {
    const input = name === 'textImageTool' ? { text: 'hello' } : { prompt: 'map' }
    const missing = fixture({}, { sendImage: undefined })
    assert.equal((await missing.execute(name, input)).status, 'failed')
    assert.equal(missing.requests.length, 0)
    const corrupt = fixture({ renderTextImage: async () => ({ mime: 'image/png', base64: 'corrupt' }), renderMindMap: async () => ({ mime: 'image/png', base64: 'corrupt' }) })
    assert.equal((await corrupt.execute(name, input)).status, 'failed')
    assert.equal(corrupt.sent.length, 0)
  }
})

test('render completion and every send reauthorize, revoked and aborted work never sends', async () => {
  for (const name of ['textImageTool', 'aiMindMapTool']) {
    const input = name === 'textImageTool' ? { text: 'hello' } : { prompt: 'map' }
    let current = true
    const f = fixture({ renderTextImage: async () => { current = false; return PNG }, renderMindMap: async () => { current = false; return PNG } }, { isCurrent: () => current })
    assert.equal((await f.execute(name, input)).status, 'failed')
    assert.equal(f.sent.length, 0)
    const aborted = fixture()
    aborted.controller.abort()
    assert.equal((await aborted.execute(name, input)).status, 'failed')
    assert.equal(aborted.requests.length, 0)
    assert.equal(aborted.renders.length, 0)
  }
})

test('unknown, missing-ID, throwing and hung send outcomes dispatch once and never fall back', async () => {
  for (const mode of ['unknown', 'no-id', 'throw', 'hung', 'failed']) {
    let sends = 0
    const f = fixture({ timeoutMs: 50 }, { async sendImage() { sends++; if (mode === 'throw') throw new Error('provider-private-detail'); if (mode === 'hung') return new Promise(() => {}); return mode === 'no-id' ? { state: 'sent' } : { state: mode } } })
    const keepAlive = setTimeout(() => {}, 200)
    try {
      const result = await f.execute('textImageTool', { text: 'hello' })
      assert.equal(result.status, mode === 'failed' ? 'failed' : 'unknown')
      assert.equal(sends, 1)
      assert.doesNotMatch(result.content, /provider-private-detail/u)
    } finally { clearTimeout(keepAlive) }
  }
})

test('hung model/body/renderer honor total cancellation without outgoing delivery', async () => {
  const pending = () => new Promise(() => {})
  for (const options of [{ fetchImpl: pending }, { fetchImpl: async () => new Response(new ReadableStream({ start() {} })) }, { renderMindMap: pending }]) {
    const f = fixture({ ...options, timeoutMs: 30 })
    const keepAlive = setTimeout(() => {}, 200)
    try { assert.equal((await f.execute('aiMindMapTool', { prompt: 'map' })).status, 'failed'); assert.equal(f.sent.length, 0) }
    finally { clearTimeout(keepAlive) }
  }
})

test('a model response arriving after cancellation has its body canceled and cannot render', async () => {
  let resolveResponse, canceled = 0
  const f = fixture({ timeoutMs: 30, fetchImpl: () => new Promise(resolve => { resolveResponse = resolve }) })
  const keepAlive = setTimeout(() => {}, 200)
  try {
    assert.equal((await f.execute('aiMindMapTool', { prompt: 'map' })).status, 'failed')
    resolveResponse(new Response(new ReadableStream({ cancel() { canceled++ } })))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(canceled, 1)
    assert.equal(f.renders.length, 0)
    assert.equal(f.sent.length, 0)
  } finally { clearTimeout(keepAlive) }
})

test('renderer receives a visible-text policy blocking formatted forbidden words and credentials before send', async () => {
  for (const visible of ['blocked', SECRET, HOST_SECRET]) for (const name of ['textImageTool', 'aiMindMapTool']) {
    let checked = false
    const render = async (_input, context) => { checked = typeof context.assertText === 'function'; context.assertText?.(visible); return PNG }
    const f = fixture({ allowsText: value => !value.includes('blocked'), renderTextImage: render, renderMindMap: render })
    assert.equal((await f.execute(name, name === 'textImageTool' ? { text: 'blo**ck**ed' } : { prompt: 'map' })).status, 'failed')
    assert.equal(checked, true)
    assert.equal(f.sent.length, 0)
  }
})
