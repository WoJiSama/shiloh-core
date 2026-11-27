import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
import { keepEventLoopAlive } from './helpers/keepEventLoopAlive.js'

const { createAgentImageSearchTools } = await load('modules/content/infrastructure/agentImageSearchTools.js')
const { createImageSearchJsonReader } = await load('modules/content/infrastructure/agentImageSearchHttp.js')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64')
const pinned = { address: '93.184.216.34', family: 4 }, secret = 'private-host-key-123456789'
const json = value => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
const image = (body = png) => ({ status: 200, headers: { 'content-type': 'image/png' }, body })
const urls = n => Array.from({ length: n }, (_, index) => `https://images.example.test/${index}.png`)
const emoji = values => json({ data: { object_list: values.map(path => ({ photo: { path } })) } })
function setup(overrides = {}) {
  const queries = [], downloads = [], sends = [], controller = new AbortController()
  const context = {
    binding: { source: 'configured', id: 'binding-a', revision: 'rev-a', agentId: 'agent-a', personaId: 'persona-a', connectionId: 'qq-a',
      target: { account: { platform: 'qq', namespace: 'onebot', id: '10001' }, kind: 'group', id: '20001' } },
    actor: { kind: 'user', user: { platform: 'qq', namespace: 'onebot', id: '30001' } },
    request: { messageId: 'message-a', text: '帮我找猫猫图片', mentions: [] },
    signal: controller.signal, isCurrent: () => true, async ensureCurrent() {},
    async sendImage(value) { sends.push({ kind: 'image', value }); return { state: 'sent', messageId: 'sent-image' } },
    async sendBundle(value) { sends.push({ kind: 'bundle', value }); return { state: 'sent', messageId: 'sent-bundle' } },
    ...overrides.context,
  }
  const options = { emoji: { enabled: true }, bing: { enabled: true }, secrets: [secret],
    providerHttp: { async lookup() { return [pinned] }, async request(url, address, signal, policy) {
      queries.push({ url: url.href, address, signal, policy })
      if (overrides.metadata) return overrides.metadata(url, policy)
      if (url.hostname === 'www.duitang.com') return emoji(urls(24))
      if (url.hostname === 'wallpaper.soutushenqi.com') return json({ data: [{ largeUrl: urls(1)[0] }] })
      return json({ results: urls(10).slice(1).map(imageUrl => ({ imageUrl })) })
    } },
    publicWeb: { async lookup() { return [pinned] }, async request(url, address, signal) {
      downloads.push({ url: url.href, address, signal })
      return overrides.download ? overrides.download(url) : image()
    } },
    ...overrides.options,
  }
  const registry = createAgentImageSearchTools(options)
  return { options, registry, context, queries, downloads, sends, controller,
    run(input = { keyword: '猫', count: 1 }, name = 'emojiSearchTool') { return registry.builtIn.find(row => row.name === name).execute(input, context) } }
}

test('image search is opt-in and retains both legacy names and a closed integer-count contract', async () => {
  assert.deepEqual(createAgentImageSearchTools().builtIn, [])
  assert.deepEqual(createAgentImageSearchTools({ emoji: { enabled: false }, bing: { enabled: true } }).builtIn.map(row => row.name), ['bingImageSearchTool'])
  for (const bad of [{ emoji: {} }, { emoji: { enabled: 'yes' } }, { emoji: { enabled: true, endpoint: 'https://bad.test' } },
    { timeoutMs: 0 }, { timeoutMs: 90_001 }, { secrets: [null] }, { allowsText: true }]) assert.throws(() => createAgentImageSearchTools(bad))
  const f = setup()
  for (const input of [{ keyword: '' }, { keyword: 'x'.repeat(201) }, { keyword: 'cat\n' }, { keyword: secret },
    { keyword: encodeURIComponent(secret) }, { keyword: '猫', count: 0 }, { keyword: '猫', count: 11 }, { keyword: '猫', count: 1.5 },
    { keyword: '猫', count: '2' }, { keyword: '猫', account: 'other' }, { keyword: '猫', url: 'file:///etc/passwd' },
    Object.create({ keyword: '猫' }), Object.defineProperty({}, 'keyword', { get() { throw Error('getter invoked') } })]) {
    assert.equal((await f.run(input)).status, 'failed')
  }
  assert.equal(f.queries.length, 0); assert.equal(f.sends.length, 0)
})

test('Duitang query preserves keyword pagination and sends only validated inline bytes in one current-target attempt', async () => {
  const f = setup()
  const result = await f.run()
  assert.equal(result.status, 'succeeded'); assert.equal(f.queries.length, 1)
  const query = new URL(f.queries[0].url)
  assert.equal(query.origin + query.pathname, 'https://www.duitang.com/napi/blog/list/by_search/')
  assert.deepEqual(Object.fromEntries(query.searchParams), { kw: '猫', start: '0', limit: '24' })
  assert.deepEqual(f.queries[0].address, pinned); assert.equal(f.queries[0].policy.method, 'GET')
  assert.equal(f.downloads.length, 1); assert.equal(f.sends.length, 1); assert.equal(f.sends[0].kind, 'image')
  assert.deepEqual(f.sends[0].value, { mime: 'image/png', base64: png.toString('base64') })
  assert.doesNotMatch(result.content, /https?:|images\.example|base64|10001|20001|message-a/u)
})

test('Bing searches the original wallpaper POST first then fills the remaining count once and sends one author-free bundle', async () => {
  const f = setup()
  const result = await f.run({ query: '山间 壁纸', count: 3 }, 'bingImageSearchTool')
  assert.equal(result.status, 'succeeded'); assert.equal(f.queries.length, 2)
  const post = f.queries[0], body = new URLSearchParams(post.policy.body)
  assert.equal(post.url, 'https://wallpaper.soutushenqi.com/v1/wallpaper/list'); assert.equal(post.policy.method, 'POST')
  assert.equal(body.get('search_word'), '山间 壁纸'); assert.equal(body.get('product_id'), '52'); assert.equal(body.get('searchMode'), 'ACCURATE_SEARCH')
  const bing = new URL(f.queries[1].url); assert.equal(bing.hostname, 'cn.bing.com'); assert.equal(bing.searchParams.get('q'), '山间 壁纸'); assert.equal(bing.searchParams.get('count'), '2')
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].kind, 'bundle'); assert.equal(f.sends[0].value.length, 3)
  for (const row of f.sends[0].value) assert.deepEqual(Object.keys(row), ['parts'])
  for (const row of f.sends[0].value) assert.deepEqual(row.parts, [{ kind: 'image', mime: 'image/png', base64: png.toString('base64') }])
})

test('empty wallpaper results can fall back to one Bing lookup without repeat requests or duplicate delivery', async () => {
  const f = setup({ metadata(url) { if (url.hostname === 'wallpaper.soutushenqi.com') throw Error('private-provider-error'); return json({ results: [{ imageUrl: urls(1)[0] }] }) } })
  assert.equal((await f.run({ query: '猫', count: 1 }, 'bingImageSearchTool')).status, 'succeeded')
  assert.equal(f.queries.length, 2); assert.equal(f.sends.length, 1)
})

test('Bing accepts only valid bounded JSON from its actual text/plain metadata endpoint', async () => {
  const response = { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: JSON.stringify({ results: [{ imageUrl: urls(1)[0] }] }) }
  const f = setup({ metadata(url) { return url.hostname === 'wallpaper.soutushenqi.com' ? json({ data: [] }) : response } })
  assert.equal((await f.run({ query: '山水风景', count: 1 }, 'bingImageSearchTool')).status, 'succeeded')
  assert.equal(f.sends.length, 1); assert.equal(f.queries.length, 2)
  const invalid = setup({ metadata(url) { return url.hostname === 'wallpaper.soutushenqi.com' ? json({ data: [] }) : { ...response, body: '<html>not JSON</html>' } } })
  assert.equal((await invalid.run({ query: '山水风景', count: 1 }, 'bingImageSearchTool')).status, 'failed')
  assert.equal(invalid.downloads.length, 0); assert.equal(invalid.sends.length, 0)
  const wrongProvider = setup({ metadata() { return { ...response, body: JSON.stringify({ data: { object_list: [{ photo: { path: urls(1)[0] } }] } }) } } })
  assert.equal((await wrongProvider.run()).status, 'failed')
  assert.equal(wrongProvider.downloads.length, 0); assert.equal(wrongProvider.sends.length, 0)
})

test('Duitang stops after ten pages and limits candidate downloads independently of upstream result counts', async () => {
  const f = setup({ metadata(url) { const page = Number(url.searchParams.get('start')) / 24; return emoji([`https://images.example.test/page-${page}.png`]) }, download() { return { status: 500, headers: {}, body: '' } } })
  assert.equal((await f.run({ keyword: '猫', count: 10 })).status, 'failed')
  assert.equal(f.queries.length, 10); assert.equal(f.downloads.length, 10); assert.equal(f.sends.length, 0)
  assert.deepEqual(f.queries.map(query => new URL(query.url).searchParams.get('start')), Array.from({ length: 10 }, (_, page) => String(page * 24)))
  const many = setup({ metadata() { return emoji(urls(1000)) }, download() { return { status: 500, headers: {}, body: '' } } })
  assert.equal((await many.run({ keyword: '猫', count: 10 })).status, 'failed')
  assert.equal(many.queries.length, 1); assert.equal(many.downloads.length, 24)
  const repeated = setup({ metadata() { return emoji(urls(1)) } })
  assert.equal((await repeated.run({ keyword: '猫', count: 10 })).status, 'succeeded')
  assert.equal(repeated.queries.length, 2); assert.equal(repeated.downloads.length, 1)
})

test('metadata cannot redirect its fixed operation and every response stream and declared length stays bounded', async () => {
  const guard = { signal: new AbortController().signal, isCurrent: () => true, async ensureCurrent() {} }
  for (const response of [
    { status: 302, headers: { location: 'https://internal.test/x', 'content-type': 'application/json' }, body: '{}' },
    { status: 200, headers: { 'content-type': 'text/html' }, body: '{}' },
    { status: 200, headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: '{}' },
    { status: 200, headers: { 'content-type': 'application/json', 'content-length': '99999999' }, body: '{}' },
    { status: 200, headers: { 'content-type': 'application/json', 'content-length': '3' }, body: '{}' },
    { status: 200, headers: { 'content-type': 'application/json', 'content-length': '-1' }, body: '{}' },
    { status: 200, headers: { 'content-type': 'application/json' }, body: 'a'.repeat(65) },
    { status: 200, headers: { 'content-type': 'application/json' }, body: (async function* () { yield Buffer.alloc(40); yield Buffer.alloc(40) })() },
    { status: 200, headers: { 'content-type': 'application/json' }, body: '{bad' },
  ]) {
    let requests = 0, closed = 0
    const read = createImageSearchJsonReader({ async lookup() { return [pinned] }, async request() { requests++; return { ...response, close() { closed++ } } } }, () => true)
    await assert.rejects(read(new URL('https://www.duitang.com/napi/blog/list/by_search/?kw=x'), { method: 'GET', headers: {}, maxBytes: 64 }, guard), /图片搜索不可用/u)
    assert.equal(requests, 1); assert.equal(closed, 1)
  }
})

test('mixed public/private metadata DNS, malformed addresses and untrusted endpoints fail before transport', async () => {
  for (const addresses of [[pinned, { address: '127.0.0.1', family: 4 }], [{ address: '8.8.8.8', family: 6 }], [], Array(33).fill(pinned)]) {
    let requests = 0
    const read = createImageSearchJsonReader({ async lookup() { return addresses }, async request() { requests++; return json({}) } }, () => true)
    await assert.rejects(read(new URL('https://www.duitang.com/napi/blog/list/by_search/?kw=x'), { method: 'GET', headers: {}, maxBytes: 64 }, { signal: new AbortController().signal, isCurrent: () => true }))
    assert.equal(requests, 0)
  }
  let lookups = 0
  const read = createImageSearchJsonReader({ async lookup() { lookups++; return [pinned] } }, () => true)
  for (const url of ['http://www.duitang.com/napi/blog/list/by_search/', 'https://www.duitang.com/other', 'https://user:pass@www.duitang.com/napi/blog/list/by_search/', 'https://127.0.0.1/napi/blog/list/by_search/']) {
    await assert.rejects(read(new URL(url), { method: 'GET', headers: {}, maxBytes: 64 }, { signal: new AbortController().signal, isCurrent: () => true }))
  }
  assert.equal(lookups, 0)
})

test('metadata secrets including escaped values, invalid rows and excessive nested JSON never become image queries or results', async () => {
  let nested = {}; for (let index = 0; index < 30; index++) nested = { child: nested }
  for (const payload of [json({ data: { object_list: [] }, ignored: secret }),
    { status: 200, headers: { 'content-type': 'application/json' }, body: `{"data":{"object_list":[]},"unused":"${secret.replaceAll('p', '\\u0070')}"}` },
    json({ data: { object_list: Array(1001).fill({}) } }), json({ data: { object_list: 'unexpected' } }), json(nested)]) {
    const f = setup({ metadata() { return payload } })
    const result = await f.run()
    assert.equal(result.status, 'failed'); assert.equal(f.downloads.length, 0); assert.equal(f.sends.length, 0)
    assert.doesNotMatch(result.content, /private-host|\\u0070|https?:/u)
  }
})

test('only provider-returned public HTTP images are downloaded and CDN redirects cannot reach a private address', async () => {
  const f = setup({ metadata() { return emoji(['file:///etc/passwd', 'http://127.0.0.1/x', 'https://user:pass@images.example.test/x', 'https://images.example.test/x.png']) },
    download() { return { status: 302, headers: { location: 'http://127.0.0.1/private' }, body: '' } } })
  assert.equal((await f.run()).status, 'failed'); assert.equal(f.downloads.length, 1); assert.equal(f.sends.length, 0)
  const redirectSecret = setup({ download() { return { status: 302, headers: { location: `https://images.example.test/${secret}` }, body: '' } } })
  assert.equal((await redirectSecret.run()).status, 'failed'); assert.equal(redirectSecret.downloads.length, 24); assert.equal(redirectSecret.sends.length, 0)
  assert.ok(redirectSecret.downloads.every(row => !row.url.includes(secret)))
})

test('public images must be real supported bytes and stay within the existing bundle byte boundary', async () => {
  for (const response of [{ status: 200, headers: { 'content-type': 'image/png' }, body: Buffer.from('not-a-png') },
    { status: 200, headers: { 'content-type': 'text/html' }, body: png }, image(Buffer.concat([png, Buffer.from(secret)])), image(Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]))]) {
    const f = setup({ download() { return response } })
    assert.equal((await f.run()).status, 'failed'); assert.equal(f.sends.length, 0)
  }
  const f = setup({ download() { return image(Buffer.concat([png, Buffer.alloc(1536 * 1024)])) } })
  const result = await f.run({ keyword: '猫', count: 10 })
  assert.equal(result.status, 'succeeded'); assert.equal(f.sends.length, 1); assert.equal(f.sends[0].value.length, 7)
  assert.match(result.content, /请求 10 张/u)
})

test('binding, complete account and original source mutations across metadata awaits prevent every subsequent download and send', async () => {
  for (const mutate of [context => { context.binding.revision = 'new-revision' }, context => { context.binding.target.account.id = 'another-account' },
    context => { context.binding.target.id = 'another-group' }, context => { context.request.messageId = 'another-source' }, context => { context.actor.user.id = 'another-user' }]) {
    let f; f = setup({ async metadata() { mutate(f.context); return emoji(urls(24)) } })
    assert.equal((await f.run()).status, 'failed'); assert.equal(f.downloads.length, 0); assert.equal(f.sends.length, 0)
  }
  for (const actor of [{ kind: 'autonomous' }, { kind: 'commitment' }, { kind: 'user', user: { platform: 'qq', namespace: 'other', id: '30001' } }]) {
    const f = setup({ context: { actor } }); assert.equal((await f.run()).status, 'failed'); assert.equal(f.queries.length, 0)
  }
})

test('cancelled or revoked metadata, DNS and image waits discard late replies and do not escape operation deadlines', async t => {
  keepEventLoopAlive(t)
  let resolveRequest, close = 0
  const f = setup({ options: { timeoutMs: 15 }, metadata() { return new Promise(resolve => { resolveRequest = resolve }) } })
  const result = await f.run(); assert.equal(result.status, 'failed'); assert.equal(f.sends.length, 0)
  resolveRequest({ ...emoji(urls(24)), close() { close++ } }); await delay(5)
  assert.equal(close, 1); assert.equal(f.downloads.length, 0)
  let resolveDns, requests = 0
  const dns = setup({ options: { timeoutMs: 15, providerHttp: { lookup: () => new Promise(resolve => { resolveDns = resolve }), async request() { requests++; return emoji(urls(24)) } } } })
  assert.equal((await dns.run()).status, 'failed'); resolveDns([pinned]); await delay(5); assert.equal(requests, 0)
  const download = setup({ options: { timeoutMs: 15 }, download: () => new Promise(() => {}) })
  assert.equal((await download.run()).status, 'failed'); assert.equal(download.downloads.length, 1); assert.equal(download.sends.length, 0)
  let allowed = true, revoked
  revoked = setup({ context: { isCurrent: () => allowed }, async metadata() { allowed = false; return emoji(urls(24)) } })
  assert.equal((await revoked.run()).status, 'failed'); assert.equal(revoked.downloads.length, 0)
})

test('an unbounded asynchronous permission callback is abortable and prevents all external requests', async t => {
  keepEventLoopAlive(t)
  const f = setup({ context: { ensureCurrent: () => new Promise(() => {}) }, options: { timeoutMs: 15 } })
  assert.equal((await f.run()).status, 'failed'); assert.equal(f.queries.length, 0); assert.equal(f.sends.length, 0)
})

test('failed, unknown, thrown and invalid successful receipts never trigger another query or send', async () => {
  for (const receipt of [{ state: 'failed', code: null }, { state: 'unknown' }, { state: 'sent' }, { state: 'sent', messageId: '0' }, null, 'throw']) {
    let attempts = 0
    const f = setup({ context: { async sendImage() { attempts++; if (receipt === 'throw') throw Error(secret); return receipt } } })
    const result = await f.run()
    assert.equal(result.status, receipt?.state === 'failed' ? 'failed' : 'unknown')
    assert.equal(attempts, 1); assert.equal(f.queries.length, 1); assert.equal(f.downloads.length, 1)
    assert.doesNotMatch(result.content, /private-host|https?:/u)
  }
  let attempted = 0
  const noBundle = setup({ context: { sendBundle: undefined, async sendImage() { attempted++; return { state: 'sent', messageId: 'one' } } } })
  assert.equal((await noBundle.run({ keyword: '猫', count: 2 })).status, 'failed'); assert.equal(attempted, 0); assert.equal(noBundle.queries.length, 0)
})
