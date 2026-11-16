import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentModrinthTools } from '../dist/backend/modules/tools/infrastructure/agentModrinthTools.js'

const API = 'https://api.modrinth.com/v2/search'
const ENDPOINT = 'https://translation.example/v1/chat/completions'
const SECRET = 'translation-private-token-123456'
const OTHER_SECRET = 'onebot-private-token-654321/+='
const PRIVATE = 'provider-private-detail-never-disclose'
const PNG = { mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR9sAAAAASUVORK5CYII=' }
const json = (value, init = {}) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' }, ...init })
const row = (overrides = {}) => ({ project_id: 'AANobbMI', project_type: 'mod', slug: 'sodium', title: 'Sodium', author: 'public-author',
  downloads: 23, follows: 4, description: 'A high-performance rendering engine.', categories: ['fabric', 'optimization'], versions: ['1.21.1'],
  client_side: 'required', server_side: 'unsupported', date_created: '2024-01-02T03:04:05Z', date_modified: '2026-11-15T03:04:05.123Z',
  license: 'MIT', icon_url: 'https://127.0.0.1/private-icon', ...overrides })
const payload = (overrides = {}) => ({ total_hits: 1, hits: [row()], ...overrides })
const completion = (rows = [{ projectId: 'AANobbMI', zh: '高性能渲染引擎。' }], overrides = {}) => ({
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(rows) } }],
  usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 }, ...overrides,
})
function context(overrides = {}) {
  return { binding: { source: 'configured', id: 'private-binding', agentId: 'private-agent', revision: 'private-revision', personaId: 'private-persona',
    connectionId: 'private-connection', target: { account: { platform: 'fixture', namespace: 'private-namespace', id: 'private-account' }, kind: 'group', id: 'private-conversation' } },
    actor: { kind: 'user', user: { platform: 'fixture', namespace: 'private-namespace', id: 'private-actor' } }, signal: new AbortController().signal,
    isCurrent: () => true, async ensureCurrent() {}, ...overrides }
}
function fixture(options = {}) {
  const requests = [], bundles = [], usage = []
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init })
    if (String(url).startsWith(API + '?')) return typeof options.search === 'function' ? options.search(url, init) : json(options.search ?? payload())
    assert.equal(String(url), ENDPOINT, 'only the configured fixed translation endpoint is allowed')
    return typeof options.translate === 'function' ? options.translate(url, init) : json(options.translate ?? completion())
  }
  const item = createAgentModrinthTools({ modrinth: { enabled: true, translation: { baseUrl: 'https://translation.example/v1', name: 'fixed-translation', apiKey: SECRET } },
    secrets: [OTHER_SECRET], fetchImpl, now: () => Date.parse('2026-11-15T03:04:05Z'), ...options.toolOptions }).builtIn[0]
  const ctx = context({ sendBundle: async items => { bundles.push(structuredClone(items)); return { state: 'sent', messageId: 'confirmed-message' } },
    recordUsage: (model, counts) => usage.push({ model, counts }), ...options.context })
  return { item, ctx, requests, bundles, usage, async execute(input = {}) { return item.execute(input, ctx) } }
}
const bundleText = bundles => bundles.flatMap(bundle => bundle.flatMap(item => item.parts.filter(part => part.kind === 'text').map(part => part.text))).join('\n')
const variants = secret => [secret, encodeURIComponent(secret), encodeURIComponent(secret).replace(/%[A-F\d]{2}/gu, part => part.toLowerCase()), Buffer.from(secret).toString('base64'), [...secret].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')]
function safe(value) {
  const text = JSON.stringify(value)
  assert.doesNotMatch(text, /provider-private-detail|private-binding|private-revision|private-persona|private-conversation/u)
  for (const encoded of [...variants(SECRET), ...variants(OTHER_SECRET)]) assert.ok(!text.includes(encoded))
}
const nextTurn = () => new Promise(resolve => setImmediate(resolve))

test('Modrinth is absent by default and explicitly enabled with an independent translation backend and closed schema', () => {
  assert.deepEqual(createAgentModrinthTools(), { builtIn: [] })
  assert.throws(() => createAgentModrinthTools({ modrinth: { enabled: true } }))
  assert.throws(() => createAgentModrinthTools({ modrinth: { enabled: true, translation: { baseUrl: 'https://user:pass@provider.example', name: 'translate', apiKey: SECRET } } }))
  const item = fixture().item
  assert.equal(item.name, 'modrinthTool')
  assert.equal(item.timeoutMs, 90_000)
  assert.equal(item.parameters.additionalProperties, false)
  assert.deepEqual(Object.keys(item.parameters.properties).sort(), ['category', 'gameVersion', 'limit', 'loader', 'query', 'sort'])
  assert.equal(item.parameters.properties.limit.type, 'integer')
})

test('search uses one fixed GET, compact isolated translation and one complete sourced text bundle with attributed usage', async () => {
  let checks = 0
  const remote = fixture({ context: { async ensureCurrent() { checks++ } } })
  const result = await remote.execute({ query: 'shader & performance', gameVersion: '1.21.1', loader: 'fabric', category: 'optimization', limit: 1, sort: 'updated' })
  assert.equal(result.status, 'succeeded')
  assert.equal(remote.requests.length, 2)
  const search = new URL(remote.requests[0].url), searchInit = remote.requests[0].init, modelInit = remote.requests[1].init
  assert.equal(search.origin + search.pathname, API)
  assert.equal(search.searchParams.get('query'), 'shader & performance')
  assert.equal(search.searchParams.get('index'), 'updated')
  assert.equal(search.searchParams.get('limit'), '1')
  assert.deepEqual(JSON.parse(search.searchParams.get('facets')), [['project_type:mod'], ['versions:1.21.1'], ['categories:fabric'], ['categories:optimization']])
  assert.equal(searchInit.method, 'GET')
  assert.equal(searchInit.body, undefined)
  assert.equal(new Headers(searchInit.headers).get('authorization'), null)
  assert.equal(new Headers(modelInit.headers).get('authorization'), `Bearer ${SECRET}`)
  for (const request of remote.requests) { assert.equal(request.init.redirect, 'error'); assert.ok(request.init.signal instanceof AbortSignal); assert.equal(new Headers(request.init.headers).get('cookie'), null) }
  const body = JSON.parse(modelInit.body)
  assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'stream', 'temperature'])
  assert.equal(body.model, 'fixed-translation')
  assert.equal(body.messages.length, 2)
  assert.deepEqual(JSON.parse(body.messages[1].content), [{ projectId: 'AANobbMI', en: 'A high-performance rendering engine.' }])
  assert.doesNotMatch(modelInit.body, /private-|groupHistory|history|persona|tools|downloads|follows|icon_url/u)
  assert.ok(checks >= 5)
  assert.deepEqual(remote.usage, [{ model: 'fixed-translation', counts: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 } }])
  assert.equal(remote.bundles.length, 1)
  assert.equal(remote.bundles[0].length, 2)
  const text = bundleText(remote.bundles)
  for (const pattern of [/北京时间/u, /11:04:05/u, /未经核实/u, /HTML 卡片未生成/u, /名称: Sodium/u, /下载: 23/u, /中文翻译: 高性能渲染引擎。/u, /https:\/\/modrinth.com\/mod\/sodium/u]) assert.match(text, pattern)
  assert.doesNotMatch(text, /希洛|127\.0\.0\.1/u)
  safe([result, remote.bundles])
})

test('strict inputs reject coercion, aliases, unexpected fields and oversized text before any external request', async () => {
  const remote = fixture()
  for (const input of [null, [], 'query', { limit: '2' }, { limit: 0 }, { limit: 11 }, { limit: 1.2 }, { limit: Infinity }, { query: [] },
    { query: 'x'.repeat(121) }, { query: 'x\u0000y' }, { gameVersion: 121 }, { gameVersion: '1.21:invalid' }, { loader: 'paper' },
    { sort: 'recently_updated' }, { category: '魔法' }, { category: 'magic;drop' }, { endpoint: 'https://trap.example' }, { version: '1.21.1' },
  ]) assert.equal((await remote.execute(input)).status, 'failed', JSON.stringify(input))
  assert.equal(remote.requests.length, 0)
  assert.equal(remote.bundles.length, 0)
})

test('malformed primary fields never turn into fabricated zero counts or partial rankings', async () => {
  const invalidRows = [null, {}, row({ project_type: 'plugin' }), row({ project_id: 'bad' }), row({ title: undefined }), row({ description: 7 }),
    row({ downloads: undefined }), row({ downloads: '23' }), row({ follows: null }), row({ follows: -1 }), row({ downloads: 0.5 }),
    row({ author: {} }), row({ categories: 'fabric' }), row({ versions: [null] }), row({ client_side: 'both' }),
    row({ date_created: '2026-02-31T03:04:05Z' }), row({ license: {} }), row({ description: 'x'.repeat(1001) }),
  ]
  for (const response of [null, {}, { total_hits: '1', hits: [row()] }, { total_hits: -1, hits: [] }, { hits: [row()] },
    payload({ total_hits: 0 }), payload({ hits: [row(), row()], total_hits: 2 }), { total_hits: 1, hits: {} }, ...invalidRows.map(hit => payload({ hits: [hit] })),
  ]) {
    const remote = fixture({ search: () => json(response) })
    const result = await remote.execute({ limit: 1 })
    assert.equal(result.status, 'failed', JSON.stringify(response))
    assert.equal(remote.requests.length, 1)
    assert.equal(remote.bundles.length, 0)
    safe(result)
  }
})

test('empty results are a valid sourced response without translation or rendering, while actual zero counts stay zero', async () => {
  const empty = fixture({ search: { total_hits: 0, hits: [] }, toolOptions: { renderCard: async () => assert.fail('no cards for an empty result') } })
  assert.equal((await empty.execute()).status, 'succeeded')
  assert.equal(empty.requests.length, 1)
  assert.equal(empty.bundles[0].length, 1)
  assert.match(bundleText(empty.bundles), /没有符合条件的项目/u)
  const zero = fixture({ search: payload({ hits: [row({ description: '', downloads: 0, follows: 0, categories: undefined, versions: undefined, client_side: undefined, server_side: undefined, date_created: undefined, date_modified: undefined, license: undefined })] }) })
  assert.equal((await zero.execute()).status, 'succeeded')
  assert.equal(zero.requests.length, 1)
  assert.match(bundleText(zero.bundles), /下载: 0\n关注: 0/u)
  assert.match(bundleText(zero.bundles), /中文翻译: 未提供（无原文简介）/u)
  assert.match(bundleText(zero.bundles), /安装侧: 客户端未提供 \| 服务端未提供/u)
})

test('microsecond API timestamps and long public version lists remain valid with explicit bounded samples', async () => {
  const remote = fixture({ search: payload({ hits: [row({ description: '', date_created: '2024-01-02T03:04:05.123456Z',
    versions: Array.from({ length: 100 }, (_, index) => `snapshot-${index}`) })] }) })
  assert.equal((await remote.execute()).status, 'succeeded')
  const text = bundleText(remote.bundles)
  assert.match(text, /创建时间: 2024-01-02/u)
  assert.match(text, /共 100 项，展示前 8 项/u)
  assert.doesNotMatch(text, /snapshot-99/u)
})

test('real Modrinth RFC3339 microseconds and numeric offsets produce calendar-checked UTC dates', async () => {
  for (const sample of [
    { created: '2021-01-22T11:04:41.419169+00:00', modified: '2026-11-11T13:44:04.147601+00:00', expectedCreated: '2021-01-22', expectedModified: '2026-11-11', versions: 396 },
    { created: '2024-03-01T00:15:00.000001+08:30', modified: '2024-02-29T23:45:00.999999-03:30', expectedCreated: '2024-02-29', expectedModified: '2024-03-01', versions: 1 },
    { created: '2000-02-29T12:34:56+00:00', modified: '1900-02-28T12:34:56-00:00', expectedCreated: '2000-02-29', expectedModified: '1900-02-28', versions: 1 },
  ]) {
    const remote = fixture({ search: payload({ hits: [row({ description: '', date_created: sample.created, date_modified: sample.modified,
      versions: Array.from({ length: sample.versions }, (_, index) => `version-${index}`) })] }) })
    assert.equal((await remote.execute()).status, 'succeeded', sample.created)
    const text = bundleText(remote.bundles)
    assert.ok(text.includes(`创建时间: ${sample.expectedCreated}`))
    assert.ok(text.includes(`最近更新: ${sample.expectedModified}`))
    if (sample.versions > 8) assert.match(text, /共 396 项，展示前 8 项/u)
    assert.equal(remote.requests.length, 1)
  }
})

test('RFC3339 offsets never normalize invalid dates, clock values or timezone components into valid output', async () => {
  for (const value of ['2026-02-30T11:04:41.419169+00:00', '1900-02-29T11:04:41+00:00', '2024-02-30T11:04:41Z',
    '2026-00-11T11:04:41+00:00', '2026-13-11T11:04:41+00:00', '2026-11-00T11:04:41+00:00',
    '2026-11-11T24:00:00+00:00', '2026-11-11T23:60:00+00:00', '2026-11-11T11:04:60+00:00',
    ...['+24:00', '-24:00', '+00:60', '+14:60', '+0:00', '+0000', '+00:00:00', '+99:99', 'Zextra'].map(offset => `2026-11-11T11:04:41${offset}`),
  ]) {
    const remote = fixture({ search: payload({ hits: [row({ description: '', date_created: value })] }) })
    assert.equal((await remote.execute()).status, 'failed', value)
    assert.equal(remote.requests.length, 1)
    assert.equal(remote.bundles.length, 0)
  }
})

test('a host without bundle delivery may query and translate but cannot render or claim delivery', async () => {
  const remote = fixture({ context: { sendBundle: undefined }, toolOptions: { renderCard: async () => assert.fail('unsupported host must not render') } })
  const result = await remote.execute()
  assert.equal(result.status, 'succeeded')
  assert.match(result.content, /展示未投递/u)
  assert.match(result.content, /名称: Sodium/u)
  assert.match(result.content, /中文翻译: 高性能渲染引擎/u)
  assert.equal(remote.requests.length, 2)
  assert.equal(remote.bundles.length, 0)
  safe(result)
})

test('translation mappings must be exact, typed and complete; invalid results preserve English without inventing Chinese', async () => {
  const valid = { projectId: 'AANobbMI', zh: '不应出现的坏译文' }
  for (const content of [JSON.stringify([]), JSON.stringify([valid, valid]), JSON.stringify([{ ...valid, projectId: 'wrong-id' }]),
    JSON.stringify([{ ...valid, zh: {} }]), JSON.stringify([{ ...valid, zh: 0 }]), JSON.stringify([{ ...valid, zh: ' ' }]),
    JSON.stringify([{ ...valid, zh: 'x'.repeat(1201) }]), JSON.stringify([{ ...valid, downloads: 999999 }]),
    JSON.stringify({ translations: [valid] }), '```json\n' + JSON.stringify([valid]) + '\n```', 'not JSON',
  ]) {
    const remote = fixture({ translate: completion([], { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] }) })
    const result = await remote.execute()
    assert.equal(result.status, 'succeeded', content)
    assert.equal(remote.requests.length, 2)
    assert.equal(remote.bundles.length, 1)
    assert.match(bundleText(remote.bundles), /英文简介: A high-performance rendering engine\./u)
    assert.match(bundleText(remote.bundles), /中文翻译: 未提供/u)
    assert.doesNotMatch(bundleText(remote.bundles), /不应出现的坏译文|999999|\[object Object\]/u)
  }
})

test('translation HTTP, tool-call, malformed envelope and truncation failures cannot fall back to a conversation model', async () => {
  for (const respond of [async () => { throw new Error(PRIVATE) }, async () => new Response(PRIVATE, { status: 502 }),
    async () => json(completion([], { choices: [] })), async () => json(completion([], { choices: [{ message: { content: '[]', tool_calls: [] } }] })),
    async () => json(completion([], { choices: [{ finish_reason: 'length', message: { content: '[{"projectId":"AANobbMI","zh":"bad"}]' } }] })),
  ]) {
    const remote = fixture({ translate: respond })
    const result = await remote.execute()
    assert.equal(result.status, 'succeeded')
    assert.equal(remote.requests.length, 2)
    assert.match(bundleText(remote.bundles), /中文翻译未提供/u)
    safe([result, remote.bundles])
  }
})

test('full raw and decoded JSON scans reject credentials in selected, ignored and nested-key fields before any output', async () => {
  for (const secret of [SECRET, OTHER_SECRET]) for (const value of variants(secret)) {
    const input = fixture()
    assert.equal((await input.execute({ query: value })).status, 'failed')
    assert.equal(input.requests.length, 0)
    for (const response of [payload({ ignored: value }), payload({ ignored: { [value]: true } }), payload({ hits: [row({ description: 'x'.repeat(2000) + value })] })]) {
      const remote = fixture({ search: response })
      const result = await remote.execute()
      assert.equal(result.status, 'failed')
      assert.equal(remote.requests.length, 1)
      assert.equal(remote.bundles.length, 0)
      safe(result)
    }
    const remote = fixture({ translate: completion(undefined, { ignored: value }) })
    const result = await remote.execute()
    assert.equal(result.status, 'failed')
    assert.equal(remote.requests.length, 2)
    assert.equal(remote.bundles.length, 0)
    safe(result)
    const inner = fixture({ translate: completion([{ projectId: 'AANobbMI', zh: value }]) })
    const innerResult = await inner.execute()
    assert.equal(innerResult.status, 'failed')
    assert.equal(inner.bundles.length, 0)
    safe(innerResult)
  }
})

test('primary errors, redirects and oversized bodies are safely rejected without retry, translation or delivery', async () => {
  for (const search of [async () => { throw new Error(PRIVATE) }, async () => new Response(PRIVATE, { status: 503 }),
    async () => new Response(PRIVATE, { status: 302 }), async () => { const value = json(payload()); Object.defineProperty(value, 'redirected', { value: true }); return value },
    async () => { const value = json(payload()); Object.defineProperty(value, 'url', { value: 'https://trap.example/private' }); return value },
    async () => new Response('{}', { headers: { 'content-length': String(1024 * 1024 + 1) } }),
    async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)) } })),
  ]) {
    const remote = fixture({ search })
    const result = await remote.execute()
    assert.equal(result.status, 'failed')
    assert.equal(remote.requests.length, 1)
    assert.equal(remote.bundles.length, 0)
    safe(result)
  }
})

test('cards use only public validated view fields and inline bytes; delivery waits for the complete batch', async () => {
  const views = []
  const remote = fixture({ search: payload({ total_hits: 2, hits: [row(), row({ project_id: 'YL57xq9U', slug: 'iris', title: 'Iris', description: '' })] }),
    toolOptions: { renderCard: async (view, ctx) => { views.push(view); assert.equal(remote.bundles.length, 0); assert.ok(ctx.signal instanceof AbortSignal); await ctx.ensureCurrent(); return PNG } } })
  const result = await remote.execute({ limit: 2 })
  assert.equal(result.status, 'succeeded')
  assert.equal(views.length, 2)
  assert.equal(remote.bundles.length, 1)
  assert.deepEqual(remote.bundles[0].map(item => item.parts.map(part => part.kind)), [['text'], ['image', 'text'], ['image', 'text']])
  assert.equal(views[0].descriptionZh, '高性能渲染引擎。')
  assert.equal(views[0].serverSide, '不支持')
  assert.equal(views[1].descriptionZh, '未提供（无原文简介）')
  assert.match(remote.bundles[0][2].parts[1].text, /\/mod\/iris/u)
  assert.match(remote.bundles[0][1].parts[1].text, /英文简介: A high-performance rendering engine\./u)
  assert.match(remote.bundles[0][1].parts[1].text, /中文翻译: 高性能渲染引擎。/u)
  assert.doesNotMatch(JSON.stringify(views), /127\.0\.0\.1|private-|iconUrl|icon_url|希洛/u)
  assert.doesNotMatch(result.content, /iVBOR/u)
  safe([views, remote.bundles, result])
})

test('single-card and total image byte limits degrade before the first send, while text stays complete', async () => {
  for (const total of [false, true]) {
    const bytes = Buffer.concat([Buffer.from(PNG.base64, 'base64'), Buffer.alloc(2 * 1024 * 1024 - Buffer.from(PNG.base64, 'base64').length + (total ? 0 : 1))])
    const image = { mime: 'image/png', base64: bytes.toString('base64') }
    const items = Array.from({ length: total ? 7 : 1 }, (_, index) => row({ project_id: `Abcd000${index}`, slug: `mod-${index}`, description: '' }))
    const remote = fixture({ search: { total_hits: items.length, hits: items }, toolOptions: { renderCard: async () => image } })
    assert.equal((await remote.execute({ limit: items.length })).status, 'succeeded')
    assert.equal(remote.bundles.length, 1)
    assert.equal(remote.bundles[0].length, items.length + 1)
    assert.ok(remote.bundles[0].every(item => item.parts.every(part => part.kind === 'text')))
    assert.match(bundleText(remote.bundles), /HTML 卡片渲染失败/u)
  }
})

test('any render failure or invalid image discards prepared images and falls back to one complete text bundle', async () => {
  for (const invalidImage of [null, { mime: 'image/png', base64: 'https://trap.example/private-image' }, { ...PNG, path: '/private/file' }, 'throw']) {
    let renders = 0
    const remote = fixture({ search: payload({ total_hits: 2, hits: [row(), row({ project_id: 'YL57xq9U', slug: 'iris', description: '' })] }),
      toolOptions: { renderCard: async () => { if (++renders === 1) return PNG; if (invalidImage === 'throw') throw new Error(PRIVATE); return invalidImage } } })
    const result = await remote.execute({ limit: 2 })
    assert.equal(result.status, 'succeeded')
    assert.equal(remote.bundles.length, 1)
    assert.ok(remote.bundles[0].every(item => item.parts.every(part => part.kind === 'text')))
    assert.match(bundleText(remote.bundles), /HTML 卡片渲染失败/u)
    assert.match(bundleText(remote.bundles), /英文简介: A high-performance/u)
    assert.match(bundleText(remote.bundles), /中文翻译: 高性能/u)
    safe([result, remote.bundles])
  }
})

test('failed or unknown delivery never retries or falls back to another send, and absent IDs cannot claim success', async () => {
  for (const receipt of [{ state: 'failed', code: PRIVATE }, { state: 'unknown' }, { state: 'sent', messageId: '' }, 'throw']) {
    let sends = 0
    const remote = fixture({ context: { sendBundle: async () => { sends++; if (receipt === 'throw') throw new Error(PRIVATE); return receipt } } })
    const result = await remote.execute()
    assert.equal(result.status, receipt.state === 'failed' ? 'failed' : 'unknown')
    assert.equal(sends, 1)
    assert.match(result.content, /不.*重发/u)
    safe(result)
  }
})

test('revocation before search, before translation, during rendering or before send prevents every later external step', async () => {
  for (const phase of ['initial', 'translation', 'render', 'send']) {
    let current = phase !== 'initial', checks = 0, renders = 0, sends = 0
    const remote = fixture({ context: { isCurrent: () => current, async ensureCurrent() { checks++; if (phase === 'send' && checks === 5) current = false },
      sendBundle: async () => { sends++; return { state: 'sent', messageId: 'bad-send' } } },
      search: () => { if (phase === 'translation') current = false; return json(payload()) },
      toolOptions: phase === 'render' ? { renderCard: async () => { renders++; current = false; return PNG } } : {} })
    const result = await remote.execute()
    assert.equal(result.status, 'failed', phase)
    assert.equal(sends, 0, phase)
    if (phase === 'initial') assert.equal(remote.requests.length, 0)
    if (phase === 'translation') assert.equal(remote.requests.length, 1)
    if (phase === 'render') assert.equal(renders, 1)
    safe(result)
  }
})

test('caller cancellation and total deadline bound hung fetch, body and authority waits without leaking or sending', async () => {
  for (const phase of ['fetch', 'body', 'authority']) for (const interrupt of ['caller', 'deadline']) {
    const caller = new AbortController()
    let entered, cancelled = false
    const ready = new Promise(resolve => { entered = resolve })
    const remote = fixture({ toolOptions: { timeoutMs: interrupt === 'deadline' ? 10 : 1000 }, context: { signal: caller.signal,
      ...(phase === 'authority' ? { ensureCurrent: () => { entered(); return new Promise(() => {}) } } : {}) },
      search: () => { entered(); return phase === 'fetch' ? new Promise(() => {}) : new Response(new ReadableStream({ cancel() { cancelled = true } })) } })
    const resultPromise = remote.execute()
    await ready
    if (interrupt === 'caller') caller.abort()
    const result = await resultPromise
    assert.equal(result.status, 'failed', `${phase}/${interrupt}`)
    assert.equal(remote.bundles.length, 0)
    if (phase === 'body') { await nextTurn(); assert.equal(cancelled, true) }
    safe(result)
  }
})

test('late primary response is cancelled and cannot resurrect translation or delivery after cancellation', async () => {
  const caller = new AbortController()
  let finish, entered, cancelled = false
  const ready = new Promise(resolve => { entered = resolve })
  const remote = fixture({ context: { signal: caller.signal }, search: () => { entered(); return new Promise(resolve => { finish = resolve }) } })
  const pending = remote.execute()
  await ready
  caller.abort()
  assert.equal((await pending).status, 'failed')
  finish(new Response(new ReadableStream({ cancel() { cancelled = true } })))
  await nextTurn()
  assert.equal(cancelled, true)
  assert.equal(remote.requests.length, 1)
  assert.equal(remote.bundles.length, 0)
})

test('cancellation during translation or rendering prevents delivery; cancellation during a started send is unknown', async () => {
  for (const phase of ['translation', 'render', 'send']) {
    const caller = new AbortController()
    let entered, sends = 0
    const ready = new Promise(resolve => { entered = resolve })
    const remote = fixture({ context: { signal: caller.signal, sendBundle: async () => { sends++; if (phase === 'send') { entered(); return new Promise(() => {}) } return { state: 'sent', messageId: 'bad-send' } } },
      ...(phase === 'translation' ? { translate: () => { entered(); return new Promise(() => {}) } } : {}),
      ...(phase === 'render' ? { toolOptions: { renderCard: async () => { entered(); return new Promise(() => {}) } } } : {}) })
    const pending = remote.execute()
    await ready
    caller.abort()
    const result = await pending
    assert.equal(result.status, phase === 'send' ? 'unknown' : 'failed')
    assert.equal(sends, phase === 'send' ? 1 : 0)
    safe(result)
  }
})
