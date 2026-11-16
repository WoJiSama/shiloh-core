import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { createAgentImageTools } from '../dist/backend/modules/tools/infrastructure/agentImageTools.js'

const apiKey = 'image-provider-private-key-123456'
const otherSecret = 'onebot-host-private-token-654321'
const backend = { baseUrl: 'https://images.example/v1', name: 'image-fixture', apiKey }
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII='
const pngBytes = Buffer.from(png, 'base64'), inline = `data:image/png;base64,${png}`
const publicAddress = { address: '8.8.8.8', family: 4 }
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const imageResult = extra => json({ data: [{ b64_json: png }], ...extra })
function context(overrides = {}) {
  return { binding: { source: 'configured', id: 'do-not-send-conversation', agentId: 'do-not-send-agent', revision: 'private-revision',
    personaId: 'private-persona', connectionId: 'private-connection', target: {
      account: { platform: 'qq', namespace: 'global', id: 'private-account' }, kind: 'group', id: 'private-group',
    } }, actor: { kind: 'user', user: { platform: 'qq', namespace: 'global', id: 'private-actor' } },
  signal: new AbortController().signal, isCurrent: () => true, ...overrides }
}
function delivery(overrides = {}) {
  const images = [], usage = []
  return { images, usage, context: context({
    async sendImage(image) { images.push(image); return { state: 'sent', messageId: 'platform-confirmed-image' } },
    recordUsage: (...args) => usage.push(args), ...overrides,
  }) }
}
function tool(options = {}, name = 'bananaTool') {
  return createAgentImageTools(options).builtIn.find(item => item.name === name)
}
function publicImages(options = {}) {
  const requests = []
  return { requests, dependencies: { lookup: async () => [publicAddress], async request(url, address, signal) {
    assert.deepEqual(address, publicAddress)
    assert.equal(signal.aborted, false)
    requests.push(url.href)
    return { status: 200, headers: { 'content-type': 'image/png' }, body: pngBytes }
  }, ...options } }
}
async function listen(t, handler) {
  const errors = []
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(error => { errors.push(String(error)); response.writeHead(500).end('{}') })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, errors }
}
function safeSummary(result) {
  assert.equal(typeof result.content, 'string')
  assert.doesNotMatch(result.content, /data:image|base64|https?:\/\/|private-key|private-token/u)
  assert.ok(!result.content.includes(png))
}

test('image capabilities are absent by default and expose only their configured closed schemas', () => {
  assert.deepEqual(createAgentImageTools(), { builtIn: [] })
  assert.deepEqual(createAgentImageTools({ generation: backend }).builtIn.map(item => item.name), ['bananaTool'])
  assert.deepEqual(createAgentImageTools({ edit: backend }).builtIn.map(item => item.name), ['googleImageEditTool'])
  for (const item of createAgentImageTools({ generation: backend, edit: backend }).builtIn) {
    assert.equal(item.parameters.additionalProperties, false)
    assert.ok(item.parameters.required.includes('prompt'))
    assert.ok(Object.hasOwn(item.parameters.properties, 'sourceSeq'))
  }
})

test('generation performs real JSON HTTP with only requested image data and succeeds after a platform sent receipt', async t => {
  const received = []
  const server = await listen(t, async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    received.push({ path: request.url, auth: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) })
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ b64_json: png }],
      usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10, private: 'untrusted-extra-usage-field' } }))
  })
  const sent = delivery()
  const result = await tool({ generation: { ...backend, baseUrl: `${server.baseUrl}/v1`, size: '1024x1024', quality: 'high' } })
    .execute({ prompt: '一只在月光下看书的猫' }, sent.context)
  assert.equal(result.status, 'succeeded')
  assert.equal(received.length, 1)
  assert.equal(received[0].path, '/v1/images/generations')
  assert.equal(received[0].auth, `Bearer ${apiKey}`)
  assert.equal(received[0].body.model, backend.name)
  assert.equal(received[0].body.prompt, '一只在月光下看书的猫')
  assert.equal(received[0].body.size, '1024x1024')
  assert.equal(received[0].body.quality, 'high')
  assert.ok(Object.keys(received[0].body).every(key => ['model', 'prompt', 'size', 'quality', 'n', 'response_format'].includes(key)))
  assert.doesNotMatch(JSON.stringify(received[0].body), /private-|do-not-send/u)
  assert.deepEqual(sent.images, [{ mime: 'image/png', base64: png }])
  assert.deepEqual(sent.usage, [[backend.name, { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 }]])
  assert.deepEqual(server.errors, [])
  safeSummary(result)
})

test('generation with references and explicit editing use real native multipart image edits without forwarding reference URLs', async t => {
  const received = [], refs = ['https://references.example/first.png', 'https://references.example/second.png']
  const server = await listen(t, async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const type = request.headers['content-type']
    const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': type } }).formData()
    const fields = {}, files = []
    for (const [name, value] of form.entries()) {
      if (typeof value === 'string') fields[name] = value
      else files.push({ field: name, mime: value.type, bytes: Buffer.from(await value.arrayBuffer()).toString('base64') })
    }
    received.push({ path: request.url, auth: request.headers.authorization, type, fields, files })
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ b64_json: png }] }))
  })
  for (const name of ['bananaTool', 'googleImageEditTool']) {
    const publicImage = publicImages(), sent = delivery()
    const selected = { ...backend, baseUrl: `${server.baseUrl}/v1`, size: '1024x1024', quality: 'high' }
    const result = await tool({ ...(name === 'bananaTool' ? { generation: selected } : { edit: selected }), publicImage: publicImage.dependencies }, name)
      .execute({ prompt: '保留主体，把背景改为森林', images: refs }, sent.context)
    assert.equal(result.status, 'succeeded')
    assert.deepEqual(publicImage.requests, refs)
    assert.deepEqual(sent.images, [{ mime: 'image/png', base64: png }])
    safeSummary(result)
  }
  assert.equal(received.length, 2)
  for (const row of received) {
    assert.equal(row.path, '/v1/images/edits')
    assert.equal(row.auth, `Bearer ${apiKey}`)
    assert.match(row.type, /^multipart\/form-data; boundary=/u)
    assert.equal(row.fields.model, backend.name)
    assert.equal(row.fields.prompt, '保留主体，把背景改为森林')
    assert.equal(row.fields.size, '1024x1024')
    assert.equal(row.fields.quality, 'high')
    assert.equal(row.files.length, 2)
    assert.ok(row.files.every(file => /^image(?:\[\])?$/u.test(file.field) && file.mime === 'image/png' && file.bytes === png))
    assert.doesNotMatch(JSON.stringify(row), /references\.example|private-group|private-actor|private-persona/u)
  }
  assert.deepEqual(server.errors, [])
})

test('chat image backends receive text and downloaded inline references and return only one validated image', async t => {
  const received = []
  const server = await listen(t, async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    received.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString()) })
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: {
      images: [{ image_url: { url: inline } }, { image_url: { url: 'https://unused.example/second.png' } }], content: '说明文字不替代图片回执',
    } }], usage: { total_tokens: 17 } }))
  })
  const publicImage = publicImages(), sent = delivery()
  const result = await tool({ generation: { ...backend, baseUrl: `${server.baseUrl}/chat/v1`, protocol: 'chat' }, publicImage: publicImage.dependencies })
    .execute({ prompt: '把参考图画成水彩', images: ['https://references.example/input.png'] }, sent.context)
  assert.equal(result.status, 'succeeded')
  assert.equal(received[0].path, '/chat/v1/chat/completions')
  assert.equal(received[0].body.model, backend.name)
  assert.ok(received[0].body.messages.every(message => message.role === 'user'))
  assert.match(JSON.stringify(received[0].body.messages), /把参考图画成水彩/u)
  assert.ok(JSON.stringify(received[0].body.messages).includes(inline))
  assert.doesNotMatch(JSON.stringify(received[0].body), /private-|do-not-send|references\.example/u)
  assert.deepEqual(publicImage.requests, ['https://references.example/input.png'])
  assert.deepEqual(sent.images, [{ mime: 'image/png', base64: png }])
  assert.deepEqual(sent.usage, [[backend.name, { total_tokens: 17 }]])
  safeSummary(result)
  assert.deepEqual(server.errors, [])
})

test('image results accept first OpenAI URL, chat image URL or markdown image and keep URLs out of model content', async () => {
  for (const [protocol, output] of [
    ['images', { data: [{ url: 'https://cdn.example/output.png?signature=signed-result' }, { url: 'http://127.0.0.1/not-requested' }] }],
    ['chat', { choices: [{ message: { images: [{ image_url: { url: 'https://cdn.example/output.png?signature=signed-result' } }] } }] }],
    ['chat', { choices: [{ message: { content: `![result](${inline})` } }] }],
    ['chat', { choices: [{ message: { content: '![result](https://cdn.example/output.png?signature=signed-result)' } }] }],
  ]) {
    const publicImage = publicImages(), sent = delivery()
    const result = await tool({ generation: { ...backend, protocol }, fetchImpl: async () => json(output), publicImage: publicImage.dependencies })
      .execute({ prompt: '画一幅山水' }, sent.context)
    assert.equal(result.status, 'succeeded', JSON.stringify(output))
    assert.equal(sent.images.length, 1)
    assert.ok(publicImage.requests.every(url => url.startsWith('https://cdn.example/output.png')))
    safeSummary(result)
  }
})

test('only the selected provider is accepted and invalid image inputs never begin HTTP or public downloads', async () => {
  let calls = 0, downloads = 0
  const publicImage = publicImages({ request: async () => { downloads++; throw Error('unexpected public request') } })
  const generator = tool({ generation: backend, secrets: [otherSecret], fetchImpl: async () => { calls++; return imageResult() }, publicImage: publicImage.dependencies })
  const editor = tool({ edit: backend, fetchImpl: async () => { calls++; return imageResult() } }, 'googleImageEditTool')
  for (const input of [null, {}, { prompt: '' }, { prompt: 1 }, { prompt: 'safe', extra: 'unused' },
    { prompt: 'safe', provider: 'other-backend' }, { prompt: 'safe', aspectRatio: '999:1' },
    { prompt: 'safe', images: 'https://references.example/input.png' }, { prompt: 'safe', images: [1] },
    { prompt: 'safe', images: Array(11).fill('https://references.example/input.png') },
    { prompt: apiKey }, { prompt: otherSecret }, { prompt: 'safe', images: [`https://example.com/${otherSecret}`] },
    ...['file:///tmp/private.png', '/tmp/private.png', inline, 'http://127.0.0.1/private.png', 'https://user:password@example.com/image.png'].map(url => ({ prompt: 'safe', images: [url] })),
  ]) assert.equal((await generator.execute(input, delivery().context)).status, 'failed')
  for (const input of [{ prompt: 'safe' }, { prompt: 'safe', images: [] }]) assert.equal((await editor.execute(input, delivery().context)).status, 'failed')
  assert.equal(calls, 0)
  assert.equal(downloads, 0)
  const allowed = await tool({ generation: backend, fetchImpl: async () => imageResult() })
    .execute({ prompt: 'safe', provider: backend.name, aspectRatio: '1:1' }, delivery().context)
  assert.equal(allowed.status, 'succeeded')
})

test('missing delivery authority, cancelled turns, stale turns and asynchronous authorization failures never call the provider', async () => {
  let calls = 0
  const item = tool({ generation: backend, fetchImpl: async () => { calls++; return imageResult() } })
  for (const selected of [context(), delivery({ signal: AbortSignal.abort() }).context,
    delivery({ isCurrent: () => false }).context, delivery({ ensureCurrent: async () => { throw Error('private-authorization-detail') } }).context]) {
    const result = await item.execute({ prompt: 'safe' }, selected)
    assert.equal(result.status, 'failed')
    assert.doesNotMatch(result.content, /private-authorization/u)
  }
  assert.equal(calls, 0)
})

test('platform unknown or failed image receipts never become successful tool results and are never resent', async () => {
  for (const state of ['unknown', 'failed']) {
    let calls = 0, sends = 0
    const result = await tool({ generation: backend, fetchImpl: async () => { calls++; return imageResult() } })
      .execute({ prompt: 'safe' }, context({ async sendImage() { sends++; return state === 'failed' ? { state, code: 'transport_failure' } : { state } } }))
    assert.equal(result.status, state)
    assert.equal(calls, 1)
    assert.equal(sends, 1)
    safeSummary(result)
  }
})

test('a thrown platform transport failure does not trigger a second provider request or image send', async () => {
  let calls = 0, sends = 0
  const result = await tool({ generation: backend, fetchImpl: async () => { calls++; return imageResult() } })
    .execute({ prompt: 'safe' }, context({ async sendImage() { sends++; throw Error(`private-send-error ${apiKey}`) } }))
  assert.notEqual(result.status, 'succeeded')
  assert.equal(calls, 1)
  assert.equal(sends, 1)
  assert.doesNotMatch(result.content, /private-send-error/u)
  safeSummary(result)
})

test('a 400 or 422 explicitly rejecting response_format permits exactly one compatibility retry without that field', async () => {
  for (const status of [400, 422]) {
    const bodies = [], sent = delivery()
    const result = await tool({ generation: backend, fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); bodies.push(body)
      assert.equal(options.redirect, 'error')
      return bodies.length === 1 ? json({ error: { message: "Unsupported parameter: 'response_format'" }, usage: { total_tokens: 2 } }, status)
        : imageResult({ usage: { total_tokens: 3 } })
    } }).execute({ prompt: 'safe' }, sent.context)
    assert.equal(result.status, 'succeeded')
    assert.equal(bodies.length, 2)
    assert.equal(bodies[0].response_format, 'b64_json')
    const { response_format: _format, ...rest } = bodies[0]
    assert.deepEqual(bodies[1], rest)
    assert.equal(sent.images.length, 1)
    assert.deepEqual(sent.usage, [[backend.name, { total_tokens: 2 }], [backend.name, { total_tokens: 3 }]])
  }
})

test('server errors, ambiguous provider results and generic client errors are never retried', async () => {
  for (const response of [
    () => json({ error: { message: 'provider-private-error' } }, 500),
    () => json({ error: { message: 'provider-private-error' } }, 429),
    () => json({ error: { message: 'generic bad request' } }, 400),
    () => json({ data: [] }), () => json({ choices: [{ message: { content: '完成但没有图片' } }] }),
    () => json({ choices: [{ message: { tool_calls: [{ id: 'unexpected', function: { name: 'sendElsewhere' } }], images: [{ image_url: { url: inline } }] } }] }),
    () => new Response('{incomplete JSON'),
  ]) {
    let calls = 0
    const sent = delivery()
    const result = await tool({ generation: backend, fetchImpl: async () => { calls++; return response() } }).execute({ prompt: 'safe' }, sent.context)
    assert.notEqual(result.status, 'succeeded')
    assert.equal(calls, 1)
    assert.equal(sent.images.length, 0)
    assert.doesNotMatch(result.content, /provider-private-error|sendElsewhere/u)
    safeSummary(result)
  }
})

test('known secrets in provider output and errors are rejected before image delivery and never enter tool content', async () => {
  for (const value of [apiKey, otherSecret, encodeURIComponent(otherSecret), Buffer.from(otherSecret).toString('base64')]) {
    for (const output of [{ data: [{ b64_json: png, revised_prompt: value }] }, { error: { message: value }, data: [{ b64_json: png }] }]) {
      const sent = delivery()
      const result = await tool({ generation: backend, secrets: [otherSecret], fetchImpl: async () => json(output) }).execute({ prompt: 'safe' }, sent.context)
      assert.notEqual(result.status, 'succeeded')
      assert.equal(sent.images.length, 0)
      assert.ok(!result.content.includes(value))
      safeSummary(result)
    }
  }
})

test('image provider redirects never forward credentials to the target', async t => {
  let calls = 0, trapCalls = 0
  const server = await listen(t, (request, response) => {
    calls++
    if (request.url === '/trap') { trapCalls++; response.end(JSON.stringify({ data: [{ b64_json: png }] })); return }
    response.writeHead(307, { location: '/trap' }).end()
  })
  const sent = delivery()
  const result = await tool({ generation: { ...backend, baseUrl: server.baseUrl } }).execute({ prompt: 'safe' }, sent.context)
  assert.notEqual(result.status, 'succeeded')
  assert.equal(calls, 1)
  assert.equal(trapCalls, 0)
  assert.equal(sent.images.length, 0)
  safeSummary(result)
})

test('provider endpoints reject credentials and unsafe URL schemes before requests', () => {
  let calls = 0
  for (const baseUrl of ['file:///tmp/private', 'not-a-url', 'https://user:password@images.example/v1',
    'https://images.example/v1?api_key=private', 'https://images.example/v1#private']) {
    assert.throws(() => tool({ generation: { ...backend, baseUrl }, fetchImpl: async () => { calls++; return imageResult() } }))
  }
  assert.equal(calls, 0)
})

test('provider response limits cancel declared and streamed bodies above 32 MiB without sending images', async () => {
  for (const declared of [true, false]) {
    let cancelled = false
    const body = new ReadableStream({ start(controller) {
      if (!declared) controller.enqueue(new Uint8Array(32 * 1024 * 1024 + 1))
    }, cancel() { cancelled = true } })
    const sent = delivery()
    const result = await tool({ generation: backend, fetchImpl: async () => new Response(body,
      { headers: declared ? { 'content-length': String(32 * 1024 * 1024 + 1) } : {} }) }).execute({ prompt: 'safe' }, sent.context)
    assert.notEqual(result.status, 'succeeded')
    assert.equal(cancelled, true)
    assert.equal(sent.images.length, 0)
  }
})

test('invalid inline image data, MIME mismatches and excessive image dimensions never reach platform delivery', async () => {
  const tooWide = Buffer.from(pngBytes), tooManyPixels = Buffer.from(pngBytes)
  tooWide.writeUInt32BE(16_385, 16)
  tooManyPixels.writeUInt32BE(8193, 16); tooManyPixels.writeUInt32BE(8193, 20)
  for (const output of [
    { data: [{ b64_json: 'not-canonical-base64' }] },
    { data: [{ b64_json: Buffer.from('not an image').toString('base64') }] },
    { data: [{ b64_json: tooWide.toString('base64') }] }, { data: [{ b64_json: tooManyPixels.toString('base64') }] },
    { choices: [{ message: { images: [{ image_url: { url: `data:image/jpeg;base64,${png}` } }] } }] },
  ]) {
    const sent = delivery()
    const result = await tool({ generation: backend, fetchImpl: async () => json(output) }).execute({ prompt: 'safe' }, sent.context)
    assert.notEqual(result.status, 'succeeded')
    assert.equal(sent.images.length, 0)
    safeSummary(result)
  }
})

test('public image results enforce public DNS and redirect destinations without using provider credentials', async () => {
  for (const [url, publicImage] of [
    ['http://127.0.0.1/output.png', publicImages()],
    ['https://cdn.example/output.png', publicImages({ lookup: async () => [publicAddress, { address: '10.0.0.1', family: 4 }] })],
    ['https://cdn.example/output.png', publicImages({ request: async () => ({ status: 302, headers: { location: 'http://169.254.169.254/secret' }, body: '' }) })],
  ]) {
    const sent = delivery()
    const result = await tool({ generation: backend, fetchImpl: async () => json({ data: [{ url }] }), publicImage: publicImage.dependencies })
      .execute({ prompt: 'safe' }, sent.context)
    assert.notEqual(result.status, 'succeeded')
    assert.equal(sent.images.length, 0)
    safeSummary(result)
  }
})

test('public reference-image revocation prevents the paid provider call', async () => {
  let revoked = false, calls = 0
  const publicImage = publicImages({ request: async () => { revoked = true; return { status: 200, headers: { 'content-type': 'image/png' }, body: pngBytes } } })
  const sent = delivery({ ensureCurrent: async () => { if (revoked) throw Error('private-authorization-detail') } })
  const result = await tool({ generation: backend, publicImage: publicImage.dependencies, fetchImpl: async () => { calls++; return imageResult() } })
    .execute({ prompt: 'safe', images: ['https://references.example/input.png'] }, sent.context)
  assert.equal(result.status, 'failed')
  assert.equal(calls, 0)
  assert.equal(sent.images.length, 0)
  safeSummary(result)
})

test('parsed usage is sanitized once before asynchronous revocation prevents image delivery', async () => {
  let revoked = false
  const sent = delivery({ ensureCurrent: async () => { if (revoked) throw Error('private-authorization-detail') } })
  const result = await tool({ generation: backend, fetchImpl: async () => {
    revoked = true
    return imageResult({ usage: { total_tokens: 9, prompt_tokens: -1, completion_tokens: 'invalid', private: 'do-not-record' } })
  } }).execute({ prompt: 'safe' }, sent.context)
  assert.notEqual(result.status, 'succeeded')
  assert.deepEqual(sent.usage, [[backend.name, { total_tokens: 9 }]])
  assert.equal(sent.images.length, 0)
  safeSummary(result)
})

test('the whole-request deadline interrupts real HTTP body reads and never retries an uncertain provider call', async t => {
  let calls = 0
  const server = await listen(t, (_request, response) => { calls++; response.writeHead(200, { 'content-type': 'application/json' }); response.write('{') })
  const sent = delivery()
  const result = await tool({ generation: { ...backend, baseUrl: server.baseUrl }, timeoutMs: 50 }).execute({ prompt: 'safe' }, sent.context)
  assert.equal(result.status, 'unknown')
  assert.equal(calls, 1)
  assert.equal(sent.images.length, 0)
  safeSummary(result)
})

test('late transports and unbounded asynchronous authorization cannot escape cancellation or send after timeout', async () => {
  const held = Promise.withResolvers(), sent = delivery()
  let calls = 0
  const pending = tool({ generation: backend, timeoutMs: 10, fetchImpl: async () => { calls++; return held.promise } })
    .execute({ prompt: 'safe' }, sent.context)
  await delay(30)
  assert.equal((await pending).status, 'unknown')
  held.resolve(imageResult())
  await delay(5)
  assert.equal(calls, 1)
  assert.equal(sent.images.length, 0)
  let requests = 0
  const blocked = tool({ generation: backend, timeoutMs: 10, fetchImpl: async () => { requests++; return imageResult() } })
    .execute({ prompt: 'safe' }, delivery({ ensureCurrent: async () => new Promise(() => {}) }).context)
  await delay(30)
  assert.equal((await blocked).status, 'failed')
  assert.equal(requests, 0)
})

test('caller cancellation and synchronous current-scope revocation discard late image results without retrying', async () => {
  for (const reason of ['abort', 'rebind']) {
    const controller = new AbortController(), held = Promise.withResolvers()
    let current = true, calls = 0
    const sent = delivery({ signal: controller.signal, isCurrent: () => current })
    const pending = tool({ generation: backend, fetchImpl: async () => { calls++; return held.promise } }).execute({ prompt: 'safe' }, sent.context)
    await delay(5)
    if (reason === 'abort') controller.abort(); else current = false
    held.resolve(imageResult())
    const result = await pending
    assert.notEqual(result.status, 'succeeded')
    assert.equal(calls, 1)
    assert.equal(sent.images.length, 0)
    safeSummary(result)
  }
})

test('oversized output images and more than 40 MiB of decoded references stop before platform or provider side effects', async () => {
  const large = Buffer.alloc(20 * 1024 * 1024)
  pngBytes.copy(large)
  let providerCalls = 0, requests = 0
  const references = publicImages({ async request() {
    requests++
    return { status: 200, headers: { 'content-type': 'image/png' }, body: requests <= 2 ? large : pngBytes }
  } })
  const sent = delivery()
  const result = await tool({ generation: backend, publicImage: references.dependencies, fetchImpl: async () => { providerCalls++; return imageResult() } })
    .execute({ prompt: 'safe', images: ['https://refs.example/first.png', 'https://refs.example/second.png', 'https://refs.example/third.png'] }, sent.context)
  assert.equal(result.status, 'failed')
  assert.equal(requests, 3)
  assert.equal(providerCalls, 0)
  assert.equal(sent.images.length, 0)
  const oversized = publicImages({ request: async () => ({ status: 200, headers: { 'content-type': 'image/png' }, body: new Uint8Array(20 * 1024 * 1024 + 1) }) })
  const output = await tool({ generation: backend, publicImage: oversized.dependencies,
    fetchImpl: async () => json({ data: [{ url: 'https://cdn.example/too-large.png' }] }) }).execute({ prompt: 'safe' }, sent.context)
  assert.equal(output.status, 'unknown')
  assert.equal(sent.images.length, 0)
})

test('public tool backends reject malformed credentials, dimensions and quality before exposing a tool', () => {
  for (const changes of [{ apiKey: null }, { apiKey: 1 }, { apiKey: '' }, { name: null }, { name: false },
    { size: false }, { size: 1024 }, { size: '' }, { size: '0x1024' }, { size: '20000x1' }, { size: '8193x8193' },
    { quality: false }, { quality: 1 }, { quality: '' }, { quality: 'unsupported-quality' }, { protocol: 'auto' }]) {
    assert.throws(() => createAgentImageTools({ generation: { ...backend, ...changes } }))
  }
})

test('image operations can shorten but never exceed their fixed four-minute deadline', async t => {
  const deadlines = []
  t.mock.method(AbortSignal, 'timeout', value => { deadlines.push(value); return new AbortController().signal })
  for (const [requested, expected] of [[undefined, 240_000], [900_000, 240_000], [0, 1], [25.9, 25]]) {
    const result = await tool({ generation: backend, timeoutMs: requested, fetchImpl: async () => imageResult() }).execute({ prompt: 'safe' }, delivery().context)
    assert.equal(result.status, 'succeeded')
    assert.equal(deadlines.at(-1), expected)
  }
})

test('generation and editing can use current visible source images without an external image GET or source identity in provider requests', async () => {
  for (const name of ['bananaTool', 'googleImageEditTool']) {
    let checks = 0, checkedAtRead = 0, reads = 0, calls = 0, publicGets = 0
    const sent = delivery({ async ensureCurrent() { checks++ }, async readImages(sourceSeq) {
      assert.equal(sourceSeq, 7)
      assert.ok(checks > 0)
      checkedAtRead = checks; reads++
      return [{ mime: 'image/png', base64: png }]
    } })
    const result = await tool({ ...(name === 'bananaTool' ? { generation: backend } : { edit: backend }),
      publicImage: publicImages({ request: async () => { publicGets++; throw Error('source port must avoid public GET') } }).dependencies,
      fetchImpl: async (url, options) => {
        calls++
        assert.ok(checks > checkedAtRead, 'the port result requires another authorization check before the provider')
        assert.equal(url, 'https://images.example/v1/images/edits')
        assert.ok(options.body instanceof FormData)
        assert.equal(options.body.get('prompt'), '把本条原图改成水彩')
        assert.equal(options.body.has('sourceSeq'), false)
        const files = [...options.body.values()].filter(value => typeof value !== 'string')
        assert.equal(files.length, 1)
        assert.equal(Buffer.from(await files[0].arrayBuffer()).toString('base64'), png)
        return imageResult()
      },
    }, name).execute({ prompt: '把本条原图改成水彩', sourceSeq: 7 }, sent.context)
    assert.equal(result.status, 'succeeded')
    assert.equal(reads, 1)
    assert.equal(calls, 1)
    assert.equal(publicGets, 0)
    assert.deepEqual(sent.images, [{ mime: 'image/png', base64: png }])
    safeSummary(result)
  }
})

test('sourceSeq accepts only a positive safe integer before opening the source-image port or provider', async () => {
  let calls = 0, reads = 0
  const item = tool({ edit: backend, fetchImpl: async () => { calls++; return imageResult() } }, 'googleImageEditTool')
  for (const sourceSeq of [0, -1, 0.5, '7', null, true, {}, [], NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const sent = delivery({ async readImages() { reads++; return [{ mime: 'image/png', base64: png }] } })
    assert.equal((await item.execute({ prompt: 'safe', sourceSeq }, sent.context)).status, 'failed')
  }
  assert.equal(calls, 0)
  assert.equal(reads, 0)
})

test('missing, empty, excessive or invalid source-image bytes fail before the paid provider call', async () => {
  let calls = 0
  const item = tool({ edit: backend, fetchImpl: async () => { calls++; return imageResult() } }, 'googleImageEditTool')
  for (const readImages of [undefined, async () => [], async () => [{ mime: 'image/png', base64: 'not-image-bytes' }],
    async () => [{ mime: 'image/jpeg', base64: png }], async () => Array(11).fill({ mime: 'image/png', base64: png })]) {
    const sent = delivery({ readImages })
    const result = await item.execute({ prompt: 'safe', sourceSeq: 7 }, sent.context)
    assert.equal(result.status, 'failed')
    assert.equal(sent.images.length, 0)
  }
  assert.equal(calls, 0)
})

test('source-image port authorization is checked before and after reading and revocation stops provider dispatch', async () => {
  for (const stage of ['before', 'after']) {
    let reads = 0, calls = 0, revoked = stage === 'before'
    const sent = delivery({ async ensureCurrent() { if (revoked) throw Error('private-source-revocation') }, async readImages() {
      reads++; revoked = true; return [{ mime: 'image/png', base64: png }]
    } })
    const result = await tool({ edit: backend, fetchImpl: async () => { calls++; return imageResult() } }, 'googleImageEditTool')
      .execute({ prompt: 'safe', sourceSeq: 7 }, sent.context)
    assert.equal(result.status, 'failed')
    assert.equal(reads, stage === 'before' ? 0 : 1)
    assert.equal(calls, 0)
    assert.equal(sent.images.length, 0)
    assert.doesNotMatch(result.content, /private-source-revocation/u)
  }
})

test('a source-image port that ignores cancellation cannot call the provider or send its late result', async () => {
  const held = Promise.withResolvers()
  let calls = 0, reads = 0
  const sent = delivery({ async readImages() { reads++; return held.promise } })
  const pending = tool({ edit: backend, timeoutMs: 10, fetchImpl: async () => { calls++; return imageResult() } }, 'googleImageEditTool')
    .execute({ prompt: 'safe', sourceSeq: 7 }, sent.context)
  await delay(30)
  assert.equal((await pending).status, 'failed')
  held.resolve([{ mime: 'image/png', base64: png }])
  await delay(5)
  assert.equal(reads, 1)
  assert.equal(calls, 0)
  assert.equal(sent.images.length, 0)
})

test('visible source images and public references may be combined but share one ten-image bound', async () => {
  const publicImage = publicImages(), sent = delivery({ readImages: async () => [{ mime: 'image/png', base64: png }] })
  let calls = 0, fileCount = 0
  const item = tool({ edit: backend, publicImage: publicImage.dependencies, fetchImpl: async (_url, options) => {
    calls++; fileCount = [...options.body.values()].filter(value => typeof value !== 'string').length
    return imageResult()
  } }, 'googleImageEditTool')
  assert.equal((await item.execute({ prompt: 'safe', sourceSeq: 7, images: ['https://refs.example/input.png'] }, sent.context)).status, 'succeeded')
  assert.equal(fileCount, 2)
  assert.equal(calls, 1)
  assert.deepEqual(publicImage.requests, ['https://refs.example/input.png'])
  const excessive = delivery({ readImages: async () => Array(10).fill({ mime: 'image/png', base64: png }) })
  assert.equal((await item.execute({ prompt: 'safe', sourceSeq: 7, images: ['https://refs.example/input.png'] }, excessive.context)).status, 'failed')
  assert.equal(calls, 1)
  assert.equal(excessive.images.length, 0)
})
