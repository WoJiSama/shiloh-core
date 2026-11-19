import assert from 'node:assert/strict'
import test from 'node:test'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'

const { createAgentDeltaForceTools } = await importBilibiliHost('modules/games/infrastructure/agentDeltaForceTools.js')
const { readStandaloneDeltaForceConfig } = await importBilibiliHost('bootstrap/standaloneDeltaForce.js')
const { buildAgentDeltaForceReportHtml, createAgentDeltaForceReportRenderer } = await importBilibiliHost('modules/games/infrastructure/agentDeltaForceReportRenderer.js')
const SECRET = 'delta-private-token-123456/+='
const HOST_SECRET = 'onebot-private-token-654321'
const PNG = { mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR9sAAAAASUVORK5CYII=' }
const config = { enabled: true, apiBaseUrl: 'https://delta.example', apiKey: SECRET, timeoutMs: 1000, objectCacheEnabled: true, objectCacheRefreshMinutes: 360 }
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
function fixture(options = {}, overrides = {}) {
  const requests = [], reports = [], sent = [], cancel = new AbortController()
  const context = { binding: { id: 'private-binding', agentId: 'private-agent', revision: 'private-revision', target: { account: { platform: 'qq', namespace: 'global', id: '123456' }, kind: 'group', id: '654321' } },
    actor: { kind: 'user', user: { platform: 'qq', namespace: 'global', id: '77777' } }, request: { text: 'private-conversation-context', messageId: 'private-message', mentions: [] },
    signal: cancel.signal, isCurrent: () => true, async ensureCurrent() {}, async sendImage(image) { sent.push(image); return { state: 'sent', messageId: 'confirmed' } }, ...overrides }
  const item = createAgentDeltaForceTools({ deltaForce: config, secrets: [HOST_SECRET],
    fetchImpl: async (url, init) => { requests.push({ url, init }); return json({ data: { list: [{ objectID: '1', objectName: '显卡', latestPrice: 123 }], total: 1, limit: 1000 } }) },
    renderReport: async report => { reports.push(report); return PNG }, ...options }).builtIn[0]
  return { item, context, requests, reports, sent, cancel, execute: input => item.execute(input, context) }
}

test('Delta is absent unless explicitly enabled, and host config resolves only an environment credential', () => {
  assert.deepEqual(createAgentDeltaForceTools(), { builtIn: [] })
  assert.equal(readStandaloneDeltaForceConfig(undefined, {}), undefined)
  assert.equal(readStandaloneDeltaForceConfig({ enabled: false }, {}), undefined)
  const raw = { enabled: true, apiBaseUrl: 'https://delta.example/', apiKeyEnv: 'DELTA_KEY', timeoutMs: 1000, objectCacheEnabled: false, objectCacheRefreshMinutes: 10 }
  assert.deepEqual(readStandaloneDeltaForceConfig(raw, { DELTA_KEY: SECRET }), { ...config, apiBaseUrl: 'https://delta.example', objectCacheEnabled: false, objectCacheRefreshMinutes: 10 })
  assert.equal(readStandaloneDeltaForceConfig(raw, {}, false).apiKey, '')
  for (const value of [{ ...raw, apiKey: SECRET }, { ...raw, apiKeyEnv: 'bad-key' }, { ...raw, apiBaseUrl: 'https://user:pass@delta.example' },
    { ...raw, apiBaseUrl: 'https://delta.example?token=x' }, { ...raw, timeoutMs: 1001.1 }, { ...raw, objectCacheEnabled: 'true' }, { ...raw, objectCacheRefreshMinutes: 1 }]) assert.throws(() => readStandaloneDeltaForceConfig(value, { DELTA_KEY: SECRET }))
  assert.throws(() => readStandaloneDeltaForceConfig(raw, {}))
})

test('daily query uses fixed configured GET only and never sends turn identities, history or model credentials', async () => {
  let checked = 0
  const f = fixture({ fetchImpl: async (url, init) => { f.requests.push({ url, init }); return json({ data: '1234' }) } }, { async ensureCurrent() { checked++ } })
  const result = await f.execute({ operation: 'daily_keyword' })
  assert.equal(result.status, 'succeeded'); assert.match(result.content, /1234/u)
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].url, 'https://delta.example/api/v1/df/tools/dailykeyword')
  assert.equal(f.requests[0].init.method, 'GET'); assert.equal(f.requests[0].init.redirect, 'error')
  assert.equal(f.requests[0].init.headers['X-API-Key'], SECRET); assert.equal(f.requests[0].init.body, undefined)
  assert.ok(f.requests[0].init.signal instanceof AbortSignal); assert.ok(checked >= 4)
  assert.doesNotMatch(JSON.stringify(f.requests), /private-binding|private-agent|private-message|private-conversation-context|onebot-private-token/u)
  assert.deepEqual(f.sent, []); assert.equal(f.item.dataPolicy, 'ephemeral')
})

test('all legacy query families remain available with one bounded image, while explicit text skips rendering', async () => {
  for (const operation of ['object_value', 'solution_list', 'place_profit', 'profit_rank']) {
    const f = fixture()
    assert.equal((await f.execute({ operation, keyword: '显卡', limit: 1 })).status, 'succeeded', operation)
    assert.equal(f.sent.length, 1, operation); assert.equal(f.reports.length, 1)
  }
  const f = fixture()
  assert.equal((await f.execute({ operation: 'object_value', keyword: '显卡', output: 'text' })).status, 'succeeded')
  assert.deepEqual(f.sent, []); assert.deepEqual(f.reports, [])
  assert.equal((await f.execute({ operation: 'help' })).status, 'succeeded')
  assert.equal(f.requests.length, 1)
})

test('price history preserves the legacy generated graph and report data without external image resources', async () => {
  const f = fixture({ fetchImpl: async (url, init) => { f.requests.push({ url, init }); return json({ data: { list: url.includes('history')
    ? [{ price: 100, timestamp: 1763472000 }, { price: 120, timestamp: 1763558400 }]
    : [{ objectID: '1', objectName: '<img src="https://trap.example">', latestPrice: 120 }], total: 1, limit: 1000 } }) } })
  assert.equal((await f.execute({ operation: 'price_history', keyword: '显卡', limit: 1 })).status, 'succeeded')
  assert.equal(f.sent.length, 1); assert.match(f.reports[0].rows[0].chartSvg, /<path/u)
  const html = buildAgentDeltaForceReportHtml(f.reports[0])
  assert.match(html, /<svg/u); assert.match(html, /&lt;img/u); assert.doesNotMatch(html, /<img\s/u)
  assert.match(html, /script-src 'none'/u); assert.match(html, /connect-src 'none'/u)
})

test('closed typed query validation rejects endpoints, targets, coerced values and secrets before fetching', async () => {
  const f = fixture()
  for (const input of [null, [], {}, { operation: 'other' }, { operation: 'object_value' }, { operation: 'daily_keyword', endpoint: 'https://trap.example' },
    { operation: 'daily_keyword', target: 'other' }, { operation: 'daily_keyword', output: ['text'] }, { operation: 'daily_keyword', limit: '2' },
    { operation: 'daily_keyword', days: 100 }, { operation: 'daily_keyword', keyword: 'x'.repeat(257) }, { operation: 'daily_keyword', keyword: SECRET },
    { operation: 'daily_keyword', prompt: Buffer.from(HOST_SECRET).toString('base64') }, { operation: 'place_profit', place: 'unknown' }]) assert.equal((await f.execute(input)).status, 'failed')
  assert.deepEqual(f.requests, []); assert.deepEqual(f.sent, [])
})

test('provider secrets, oversized bodies, bad JSON, HTTP errors and redirected responses never reach output or renderer', async () => {
  for (const response of [() => json({ data: SECRET }), () => json({ data: Buffer.from(HOST_SECRET).toString('base64') }),
    () => new Response('x'.repeat(1024 * 1024 + 1)), () => new Response('bad-json'), () => new Response('private-error', { status: 500 }),
    () => { const r = json({ data: '1234' }); Object.defineProperty(r, 'redirected', { value: true }); return r }]) {
    const f = fixture({ fetchImpl: async () => response() })
    const result = await f.execute({ operation: 'daily_keyword' })
    assert.equal(result.status, 'failed'); assert.doesNotMatch(result.content, /private|bad-json|xxxx/u)
    assert.deepEqual(f.sent, []); assert.deepEqual(f.reports, [])
  }
})

test('revoked binding and cancellation stop late results and never send fallback content', async () => {
  for (const mode of ['revoke', 'cancel']) {
    let current = true, complete
    const pending = new Promise(resolve => { complete = resolve })
    const f = fixture({ fetchImpl: async () => { if (mode === 'revoke') current = false; else f.cancel.abort(); return pending } }, { isCurrent: () => current })
    const work = f.execute({ operation: 'object_value', keyword: '显卡' })
    await new Promise(resolve => setImmediate(resolve)); complete(json({ data: { list: [] } }))
    assert.equal((await work).status, 'failed'); assert.deepEqual(f.sent, []); assert.deepEqual(f.reports, [])
  }
})

test('unknown or thrown image send attempts once and never turns into a text fallback', async () => {
  for (const send of [async () => ({ state: 'unknown' }), async () => { throw new Error(SECRET) }]) {
    let attempts = 0
    const f = fixture({}, { async sendImage() { attempts++; return send() } })
    const result = await f.execute({ operation: 'object_value', keyword: '显卡' })
    assert.equal(result.status, 'unknown'); assert.equal(attempts, 1); assert.doesNotMatch(result.content, /显卡|private-token/u)
  }
})

test('rendering failure degrades before any send, output policy rejects before rasterization, name cache is lazy', async () => {
  const degraded = fixture({ renderReport: async () => { throw new Error('renderer detail') } })
  const result = await degraded.execute({ operation: 'object_value', keyword: '显卡' })
  assert.equal(result.status, 'succeeded'); assert.match(result.content, /文字结果/u); assert.deepEqual(degraded.sent, [])
  const denied = fixture({ allowsText: () => false })
  assert.equal((await denied.execute({ operation: 'object_value', keyword: '显卡' })).status, 'failed'); assert.deepEqual(denied.reports, [])
  const cached = fixture()
  assert.deepEqual(cached.requests, [])
  await cached.execute({ operation: 'place_profit', output: 'text' }); await cached.execute({ operation: 'profit_rank', output: 'text' })
  assert.equal(cached.requests.filter(request => request.url.includes('/object/list')).length, 1)
})

test('standalone report renderer blocks scripts, service workers and network before rendering and cleans owned browser', async () => {
  const calls = []
  const page = { setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, async setJavaScriptEnabled(value) { calls.push(['js', value]) },
    async setBypassServiceWorker(value) { calls.push(['worker', value]) }, async setRequestInterception(value) { calls.push(['requests', value]) }, on() {},
    async setOfflineMode(value) { calls.push(['offline', value]) }, async setViewport() {}, async setContent(html) { calls.push(['html', html]) },
    async evaluate() { return 700 }, async screenshot() { return Buffer.from(PNG.base64, 'base64') }, async close() { calls.push(['pageClose']) } }
  const browser = { async newPage() { return page }, async close() { calls.push(['browserClose']) }, process() { return null } }
  const renderer = createAgentDeltaForceReportRenderer({ launch: async () => browser })
  const report = { kind: 'solution-list', columns: ['名称'], rows: [{ name: '<script>bad</script>' }], title: '三角洲' }
  assert.deepEqual(await renderer.render(report, { signal: new AbortController().signal, isCurrent: () => true }), PNG)
  assert.deepEqual(calls.slice(0, 4), [['js', false], ['worker', true], ['requests', true], ['offline', true]])
  assert.ok(calls.some(row => row[0] === 'pageClose')); assert.ok(calls.some(row => row[0] === 'browserClose'))
  assert.throws(() => buildAgentDeltaForceReportHtml({ ...report, kind: 'price-history', rows: [{ chartSvg: '<svg onload="alert(1)"></svg>' }] }))
})
