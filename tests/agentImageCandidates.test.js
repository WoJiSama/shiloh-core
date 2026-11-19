import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { agentImageBackends, createAgentImageTools } = await load('modules/tools/infrastructure/agentImageTools.js')
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII='
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const success = (extra = {}) => json({ data: [{ b64_json: png }], ...extra })
const backend = (name = 'preferred', model = 'upstream-image', extra = {}) => ({ baseUrl: `https://${name}.example/v1`, name, model, apiKey: `${name}-private-key-123456`, ...extra })
function setup(generation, fetchImpl, overrides = {}) {
  const sends = [], usage = []
  const context = { signal: new AbortController().signal, isCurrent: () => true,
    async sendImage(image) { sends.push(image); return { state: 'sent', messageId: 'confirmed-image' } },
    recordUsage: (...row) => usage.push(row), ...overrides }
  const tool = createAgentImageTools({ generation, fetchImpl }).builtIn[0]
  return { context, sends, usage, run(input = { prompt: '画一棵树' }) { return tool.execute(input, context) } }
}

test('backend normalization accepts legacy singles and ordered frozen candidates with distinct channel/model/aliases', () => {
  assert.deepEqual(agentImageBackends(undefined), [])
  const legacy = backend(); delete legacy.model
  assert.equal(agentImageBackends(legacy)[0].model, legacy.name)
  const rows = agentImageBackends([backend(' first ', ' model-a ', { baseUrl: 'https://first.example/v1', aliases: [' alias ', 'alias', 'another'] }), backend('second', 'model-b')])
  assert.deepEqual(rows.map(row => [row.name, row.model, row.aliases]), [['first', 'model-a', ['alias', 'another']], ['second', 'model-b', undefined]])
  assert.ok(Object.isFrozen(rows)); assert.ok(Object.isFrozen(rows[0])); assert.ok(Object.isFrozen(rows[0].aliases))
  for (const bad of [[], Array(9).fill(backend()), Array(1), null, false, [null],
    backend(' ', 'ok'), backend('a', ''), backend('a', null), backend('a', 'unsafe\nmodel'), backend('a', 'a'.repeat(201)),
    backend('a', 'm', { aliases: 'alias' }), backend('a', 'm', { aliases: [''] }), backend('a', 'm', { aliases: ['control\u0000'] }),
    backend('a', 'm', { aliases: Array(17).fill('alias') }), backend('a', 'm', { aliases: Array(1) })]) {
    assert.throws(() => agentImageBackends(bad))
  }
})

test('upstream model controls the request and usage while provider remains a separate exact channel identity', async () => {
  const requests = [], one = backend('friendly-channel', 'gpt-image-1', { aliases: ['画图'] })
  const f = setup([one], async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return success({ usage: { total_tokens: 11 } }) })
  assert.equal((await f.run({ prompt: '画一棵树', provider: '画图' })).status, 'succeeded')
  assert.equal(requests[0].body.model, 'gpt-image-1')
  assert.equal(Object.hasOwn(requests[0].body, 'response_format'), false)
  assert.deepEqual(f.usage, [['gpt-image-1', { total_tokens: 11 }]])
  assert.equal((await f.run({ prompt: 'safe', provider: 'gpt-image-1' })).status, 'failed', 'an upstream model does not become an implicit alias')
  assert.equal((await f.run({ prompt: 'safe', provider: ' Friendly-channel' })).status, 'failed')
  assert.equal(requests.length, 1)
})

test('each explicitly rejected status allows ordered default fallback and uses the actual candidate credentials and model', async () => {
  for (const status of [400, 404, 405, 413, 415, 422, 429]) {
    const first = backend('first', 'model-a'), second = backend('second', 'model-b'), requests = []
    const f = setup([first, second], async (url, options) => {
      requests.push([url, options.headers.Authorization, JSON.parse(options.body).model])
      return requests.length === 1 ? json({ error: { message: 'request rejected' }, usage: { total_tokens: 1 } }, status) : success({ usage: { total_tokens: 3 } })
    })
    assert.equal((await f.run()).status, 'succeeded', String(status))
    assert.deepEqual(requests, [['https://first.example/v1/images/generations', `Bearer ${first.apiKey}`, 'model-a'],
      ['https://second.example/v1/images/generations', `Bearer ${second.apiKey}`, 'model-b']])
    assert.deepEqual(f.usage, [['model-a', { total_tokens: 1 }], ['model-b', { total_tokens: 3 }]])
    assert.equal(f.sends.length, 1)
  }
})

test('explicit names or aliases select only one same-name candidate group without crossing to another channel', async () => {
  const candidates = [backend('other', 'other-model', { aliases: ['shared'] }), backend('chosen', 'chosen-a', { aliases: ['picked'] }),
    backend('chosen', 'chosen-b'), backend('third', 'third-model', { aliases: ['picked'] })]
  for (const provider of ['chosen', 'picked']) {
    const requests = [], f = setup(candidates, async (_url, options) => { requests.push(JSON.parse(options.body).model); return json({}, 429) })
    assert.equal((await f.run({ prompt: 'safe', provider })).status, 'failed')
    assert.deepEqual(requests, ['chosen-a', 'chosen-b'])
    assert.equal(f.sends.length, 0)
  }
  const requests = [], f = setup([backend('alias-owner', 'alias', { aliases: ['chosen'] }), ...candidates], async (_url, options) => {
    requests.push(JSON.parse(options.body).model); return success()
  })
  assert.equal((await f.run({ prompt: 'safe', provider: 'chosen' })).status, 'succeeded')
  assert.deepEqual(requests, ['chosen-a'], 'exact channel name wins over a colliding alias')
})

test('one response_format compatibility retry precedes fallback but an ambiguous retry freezes the request', async () => {
  for (const retryUnknown of [false, true]) {
    const requests = [], f = setup([backend(), backend('fallback', 'model-b')], async (_url, options) => {
      const body = JSON.parse(options.body); requests.push(body)
      if (requests.length === 1) return json({ error: { message: "Unsupported parameter: 'response_format'" } }, 422)
      if (requests.length === 2) return retryUnknown ? json({ error: { message: 'upstream state unavailable' } }, 503) : json({}, 404)
      return success()
    })
    assert.equal((await f.run()).status, retryUnknown ? 'unknown' : 'succeeded')
    assert.equal(requests.length, retryUnknown ? 2 : 3)
    assert.equal(requests[0].response_format, 'b64_json'); assert.equal(Object.hasOwn(requests[1], 'response_format'), false)
    if (!retryUnknown) assert.equal(requests[2].model, 'model-b')
  }
})

test('network failures, timeouts, 5xx, malformed 2xx and non-whitelisted errors never switch channels', async () => {
  for (const response of [
    () => { throw Error('private-network-state') }, () => { throw new DOMException('timeout', 'TimeoutError') },
    ...[401, 403, 408, 409, 418, 500, 503].map(status => () => json({ error: { message: 'private-error' } }, status)),
    () => new Response('{bad-json'), () => json({ data: [] }), () => json({ error: { message: 'not-ready' } }),
  ]) {
    let requests = 0
    const f = setup([backend(), backend('fallback')], async () => { requests++; return response() })
    const result = await f.run()
    assert.notEqual(result.status, 'succeeded'); assert.equal(requests, 1); assert.equal(f.sends.length, 0)
    assert.doesNotMatch(result.content, /private-|https?:|base64/u)
  }
})

test('platform refusal or unknown receipt freezes generation even with more candidates configured', async () => {
  for (const state of ['failed', 'unknown', 'throw']) {
    let requests = 0, sends = 0
    const f = setup([backend(), backend('fallback')], async () => { requests++; return success() }, {
      async sendImage() { sends++; if (state === 'throw') throw Error('private-send'); return { state } },
    })
    const result = await f.run()
    assert.equal(result.status, state === 'failed' ? 'failed' : 'unknown')
    assert.equal(requests, 1); assert.equal(sends, 1)
  }
})

test('generation references stay on each selected candidate edit endpoint and are read once before fallback', async () => {
  const requests = [], candidates = [backend('selected', 'edit-model-a', { aliases: ['editing'] }), backend('selected', 'edit-model-b'), backend('other')]
  let reads = 0
  const f = setup(candidates, async (url, options) => {
    assert.ok(options.body instanceof FormData)
    const file = options.body.get('image')
    assert.equal(Buffer.from(await file.arrayBuffer()).toString('base64'), png)
    requests.push([url, options.body.get('model')])
    return requests.length === 1 ? json({}, 415) : success()
  }, { async readImages(seq) { reads++; assert.equal(seq, 3); return [{ mime: 'image/png', base64: png }] } })
  assert.equal((await f.run({ prompt: '编辑树的颜色', sourceSeq: 3, provider: 'editing' })).status, 'succeeded')
  assert.deepEqual(requests, [['https://selected.example/v1/images/edits', 'edit-model-a'], ['https://selected.example/v1/images/edits', 'edit-model-b']])
  assert.equal(reads, 1); assert.equal(f.sends.length, 1)
  let calls = 0
  const editor = createAgentImageTools({ edit: candidates, fetchImpl: async () => { calls++; return success() } }).builtIn[0]
  assert.equal((await editor.execute({ prompt: 'safe' }, f.context)).status, 'failed')
  assert.equal(calls, 0)
})

test('revocation after an explicit rejection stops before fallback and timeout cannot activate another candidate', async () => {
  let current = true, requests = 0
  const f = setup([backend(), backend('fallback')], async () => { requests++; current = false; return json({}, 429) }, { isCurrent: () => current })
  assert.equal((await f.run()).status, 'unknown'); assert.equal(requests, 1)
  const controller = new AbortController(), requests2 = []
  const tool = createAgentImageTools({ generation: [backend(), backend('fallback')], timeoutMs: 10, fetchImpl: async url => {
    requests2.push(url); return new Promise(() => {})
  } }).builtIn[0]
  const pending = tool.execute({ prompt: 'safe' }, { ...f.context, signal: controller.signal, isCurrent: () => true })
  await delay(30)
  assert.equal((await pending).status, 'unknown'); assert.equal(requests2.length, 1)
})

test('secrets from every candidate are rejected before requests or image delivery and never trigger fallback', async () => {
  const a = backend(), b = backend('fallback'), secret = b.apiKey
  for (const inPrompt of [true, false]) {
    let requests = 0
    const f = setup([a, b], async () => { requests++; return json({ error: { message: secret } }, 400) })
    const result = await f.run({ prompt: inPrompt ? secret : 'safe' })
    assert.equal(result.status, inPrompt ? 'failed' : 'unknown'); assert.equal(requests, inPrompt ? 0 : 1)
    assert.equal(f.sends.length, 0); assert.equal(result.content.includes(secret), false)
  }
  let requests = 0
  const f = setup([a, b], async () => { requests++; return new Response(`<h1>${secret}</h1>`, { status: 429 }) })
  assert.equal((await f.run()).status, 'unknown'); assert.equal(requests, 1)
})

test('fully read plain gateway rejections and empty rejected bodies retain safe ordered fallback', async () => {
  for (const rejection of [() => new Response('<h1>request too large</h1>', { status: 413 }), () => new Response(null, { status: 429 })]) {
    let requests = 0
    const f = setup([backend(), backend('fallback')], async () => ++requests === 1 ? rejection() : success())
    assert.equal((await f.run()).status, 'succeeded'); assert.equal(requests, 2); assert.equal(f.sends.length, 1)
  }
})
