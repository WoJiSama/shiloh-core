import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { Readable } from 'node:stream'
import test from 'node:test'
import { readAgentPublicImage, readAgentPublicWeb } from '../dist/backend/modules/tools/infrastructure/agentPublicWeb.js'

const publicAddress = { address: '8.8.8.8', family: 4 }
const lookup = async () => [publicAddress]
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1cAAAAASUVORK5CYII=', 'base64')
const signedUrl = 'https://images.example.com/result?token=provider-token&signature=provider-signature#unused'
const response = (body = png, headers = {}) => ({ status: 200, headers: { 'content-type': 'image/png', ...headers }, body })
const context = (overrides = {}) => ({ signal: new AbortController().signal, isCurrent: () => true, ...overrides })
const read = (dependencies = {}, turn = context(), url = signedUrl) => readAgentPublicImage(url, turn, { lookup, ...dependencies })
const failed = pending => assert.rejects(pending, error => {
  assert.equal(error.message, '公共图片读取失败：地址、授权或图片响应无效')
  assert.doesNotMatch(JSON.stringify(error), /provider-token|provider-signature|private-detail/u)
  return true
})

test('provider image downloads accept signed queries and return validated inline bytes without exposing the URL', async () => {
  for (const type of ['image/png; charset=binary', 'application/octet-stream', undefined]) {
    const seen = []
    const image = await read({ request: async (url, address, signal) => {
      seen.push(url.href)
      assert.deepEqual(address, publicAddress)
      assert.equal(signal.aborted, false)
      return response(png, { 'content-type': type })
    } })
    assert.deepEqual(image, { mime: 'image/png', base64: png.toString('base64') })
    assert.deepEqual(seen, [signedUrl.split('#')[0]])
    assert.deepEqual(Object.keys(image).sort(), ['base64', 'mime'])
  }
  let requests = 0
  await assert.rejects(readAgentPublicWeb(signedUrl, context(), { lookup, request: async () => { requests++; return response() } }), /凭据参数/u)
  assert.equal(requests, 0, 'the text URL contract still rejects signed credential queries')
})

test('image downloads reject URL credentials and private destinations before DNS or transport', async () => {
  let requests = 0, lookups = 0
  for (const url of ['file:///tmp/image.png', 'data:image/png;base64,private-detail', 'https://u:p@example.com/image',
    'https://localhost/image', 'https://box.internal/image', 'https://box.local/image', 'http://127.1/image',
    'https://0x7f000001/image', 'http://169.254.169.254/image', 'https://[::1]/image', 'https://10.0.0.1/image',
    'https://example.com/\\private']) {
    await failed(read({ lookup: async () => { lookups++; return [publicAddress] }, request: async () => { requests++; return response() } }, context(), url))
  }
  assert.equal(requests, 0)
  assert.equal(lookups, 0)
})

test('image DNS validates all answers and declared families before using the pinned address', async () => {
  for (const addresses of [[], [publicAddress, { address: '10.0.0.1', family: 4 }],
    [{ address: '8.8.8.8', family: 6 }], [{ address: 'fc00::1', family: 6 }], [{ address: '2002:0808:0808::', family: 6 }]]) {
    let requests = 0
    await failed(read({ lookup: async () => addresses, request: async () => { requests++; return response() } }))
    assert.equal(requests, 0)
  }
})

test('every image redirect is revalidated, signed CDN targets work and at most three redirects are followed', async () => {
  const hosts = [], urls = []
  const image = await read({ lookup: async host => { hosts.push(host); return [publicAddress] }, request: async url => {
    urls.push(url.href)
    return urls.length <= 3 ? { status: 302, headers: { location: `https://cdn${urls.length}.example.org/file?signature=cdn-signature` }, body: '' } : response()
  } })
  assert.equal(image.mime, 'image/png')
  assert.deepEqual(hosts, ['images.example.com', 'cdn1.example.org', 'cdn2.example.org', 'cdn3.example.org'])
  assert.equal(urls.length, 4)
  for (const location of ['http://127.0.0.1/image', 'https://u:p@example.org/image']) {
    let calls = 0
    await failed(read({ request: async () => { calls++; return { status: 302, headers: { location }, body: '' } } }))
    assert.equal(calls, 1)
  }
  let calls = 0
  await failed(read({ request: async () => { calls++; return { status: 302, headers: { location: '/again?token=cdn-token' }, body: '' } } }))
  assert.equal(calls, 4)
  let requests = 0
  await failed(read({ lookup: async host => host === 'images.example.com' ? [publicAddress] : [{ address: '192.168.1.1', family: 4 }],
    request: async () => { requests++; return { status: 302, headers: { location: 'https://cdn.example.org/file' }, body: '' } } }))
  assert.equal(requests, 1)
})

test('image downloads reject compression, excess bytes, unsupported content and MIME or dimension mismatches', async () => {
  const zeroWidth = Buffer.from(png)
  zeroWidth.writeUInt32BE(0, 16)
  for (const reply of [response(Buffer.alloc(20 * 1024 * 1024 + 1)),
    response(png, { 'content-length': String(20 * 1024 * 1024 + 1) }), response(png, { 'content-encoding': 'gzip' }),
    response(png, { 'content-type': 'image/jpeg' }), response(png, { 'content-type': 'image/svg+xml' }),
    response(Buffer.from('<html>private-detail</html>'), { 'content-type': 'image/png' }), response(zeroWidth),
    response(png.toString('base64')), { status: 403, headers: {}, body: Buffer.from('private-detail') }]) {
    await failed(read({ request: async () => reply }))
  }
})

test('native image transport pins the public IP, keeps identity encoding and sends no ambient authorization or cookies', async t => {
  let captured
  t.mock.method(http, 'request', (url, options, callback) => {
    captured = { url, options }
    const request = new EventEmitter()
    request.end = () => {
      const incoming = Readable.from([png])
      incoming.statusCode = 200
      incoming.headers = { 'content-type': 'image/png' }
      callback(incoming)
    }
    return request
  })
  const image = await read({}, context(), 'http://images.example.com/image?signature=cdn-signature')
  assert.equal(image.mime, 'image/png')
  assert.equal(captured.options.agent, false)
  assert.equal(captured.options.method, 'GET')
  assert.equal(captured.options.family, 4)
  assert.deepEqual(captured.options.headers, { Accept: 'image/png, image/jpeg, image/webp, image/gif',
    'Accept-Encoding': 'identity', 'User-Agent': 'BL-Agent-Public-Web/1.0' })
  captured.options.lookup('images.example.com', {}, (error, address, family) => {
    assert.equal(error, null)
    assert.equal(address, publicAddress.address)
    assert.equal(family, publicAddress.family)
  })
})

test('native image streaming enforces the 20 MiB limit without Content-Length', async t => {
  let incoming
  t.mock.method(http, 'request', (_url, _options, callback) => {
    const request = new EventEmitter()
    request.end = () => {
      incoming = Readable.from([Buffer.alloc(20 * 1024 * 1024), Buffer.from('overflow')])
      incoming.statusCode = 200
      incoming.headers = { 'content-type': 'image/png' }
      callback(incoming)
    }
    return request
  })
  await failed(read({}, context(), 'http://images.example.com/image'))
  assert.equal(incoming.destroyed, true)
})

test('stale or asynchronously denied image requests stop before DNS, after DNS, after arrival and before final return', async () => {
  for (const turn of [context({ isCurrent: () => false }), context({ signal: AbortSignal.abort() }),
    context({ async ensureCurrent() { throw new Error('private-detail') } })]) {
    let lookups = 0, requests = 0
    await failed(read({ lookup: async () => { lookups++; return [publicAddress] }, request: async () => { requests++; return response() } }, turn))
    assert.equal(lookups, 0)
    assert.equal(requests, 0)
  }
  let current = true, requests = 0
  await failed(read({ lookup: async () => { current = false; return [publicAddress] }, request: async () => { requests++; return response() } }, context({ isCurrent: () => current })))
  assert.equal(requests, 0)
  current = true
  await failed(read({ request: async () => { current = false; return response() } }, context({ isCurrent: () => current })))
  let checks = 0
  await failed(read({ request: async () => response() }, context({ async ensureCurrent() {
    checks++
    if (checks === 4) throw new Error('private-detail')
  } })))
  assert.equal(checks, 4, 'validated bytes cannot bypass the final asynchronous authorization check')
})

test('cancellation and the shared deadline interrupt hanging image authorization, DNS and transport', async () => {
  for (const stage of ['authorization', 'dns', 'request']) for (const interrupt of ['abort', 'deadline']) {
    const controller = new AbortController()
    let transportSignal
    const pending = read({ timeoutMs: interrupt === 'deadline' ? 10 : undefined,
      lookup: async () => stage === 'dns' ? new Promise(() => {}) : [publicAddress],
      request: async (_url, _address, signal) => { transportSignal = signal; return new Promise(() => {}) },
    }, context({ signal: controller.signal, ...(stage === 'authorization' ? { ensureCurrent: async () => new Promise(() => {}) } : {}) }))
    const timer = setTimeout(() => controller.abort(), interrupt === 'abort' ? 10 : 1000)
    try { await failed(pending) } finally { clearTimeout(timer) }
    if (transportSignal) assert.equal(transportSignal.aborted, true)
  }
})

test('image transport failures never expose a signed provider URL or raw failure details', async () => {
  await failed(read({ request: async () => { throw new Error(`private-detail ${signedUrl}`) } }))
})
