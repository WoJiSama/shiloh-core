import assert from 'node:assert/strict'
import test from 'node:test'
import sharp from 'sharp'
import { createAgentTools } from '../dist/backend/modules/tools/infrastructure/agentTools.js'
import { validateAgentToolImage, validateAgentToolImageBytes } from '../dist/backend/modules/image/infrastructure/agentToolImage.js'

const png = { mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6d8AAAAASUVORK5CYII=' }
const definition = (execute, timeoutMs) => ({ name: 'imageProbe', description: 'Offline scoped image fixture',
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, execute,
  ...(timeoutMs === undefined ? {} : { timeoutMs }),
})
const scope = overrides => ({ binding: {}, actor: { kind: 'user' }, isCurrent: () => true, ...overrides })
const tool = (execute, context, timeoutMs) => createAgentTools({ builtIn: [definition(execute, timeoutMs)] }, {
  signal: new AbortController().signal, context: () => context,
}).getExtraTools(['imageProbe'])[0]

test('inline delivery validates real PNG, JPEG, WebP and GIF bytes without altering them', async () => {
  for (const format of ['png', 'jpeg', 'webp', 'gif']) {
    const bytes = await sharp({ create: { width: 72, height: 128, channels: 3, background: '#123456' } }).toFormat(format).toBuffer()
    const image = validateAgentToolImageBytes(bytes)
    assert.equal(image.mime, `image/${format}`)
    assert.deepEqual(Buffer.from(image.base64, 'base64'), bytes)
    assert.deepEqual(validateAgentToolImage(image), image)
    assert.deepEqual(validateAgentToolImageBytes(bytes, image.mime), image)
    assert.throws(() => validateAgentToolImageBytes(bytes, 'image/bmp'))
  }
})

test('inline delivery rejects URLs, paths, noncanonical base64, MIME mismatches and oversized canvases or payloads', () => {
  for (const image of [null, {}, { ...png, url: 'https://example.test/image.png' },
    { ...png, base64: 'https://example.test/image.png' }, { ...png, base64: '/tmp/image.png' },
    { ...png, base64: `base64://${png.base64}` }, { ...png, base64: `data:image/png;base64,${png.base64}` },
    { ...png, base64: png.base64 + '\n' }, { ...png, base64: 'AB==' }, { ...png, base64: 'AAAA=' },
    { ...png, base64: '' }, { ...png, mime: 'image/jpeg' }, { ...png, mime: 'image/svg+xml' },
    { ...png, base64: Buffer.from('<html>provider error</html>').toString('base64') },
  ]) assert.throws(() => validateAgentToolImage(image))
  assert.throws(() => validateAgentToolImageBytes(Buffer.alloc(20 * 1024 * 1024 + 1)))
  const invalid = Buffer.from(png.base64, 'base64')
  for (const [width, height] of [[0, 1], [16_385, 1], [1, 16_385], [8193, 8193]]) {
    invalid.writeUInt32BE(width, 16); invalid.writeUInt32BE(height, 20)
    assert.throws(() => validateAgentToolImageBytes(invalid))
  }
  invalid.writeUInt32BE(8192, 16); invalid.writeUInt32BE(8192, 20)
  assert.doesNotThrow(() => validateAgentToolImageBytes(invalid))
})

test('scoped image delivery rechecks stored permissions and revokes saved contexts after completion', async () => {
  let saved, checks = 0, sends = 0
  const receipt = { state: 'sent', messageId: 'confirmed-image' }
  const current = scope({ async ensureCurrent() { checks++ }, async sendImage(image, guard) {
    assert.deepEqual(image, png)
    assert.equal(guard(), true)
    sends++
    return receipt
  } })
  const result = await tool(async (_input, context) => {
    saved = context
    assert.deepEqual(await context.sendImage(png), receipt)
    return { status: 'succeeded', content: 'Image delivered' }
  }, current).execute({}, {})
  assert.equal(result.status, 'success')
  assert.equal(sends, 1)
  assert.ok(checks >= 4)
  assert.equal(saved.signal.aborted, true)
  await assert.rejects(saved.sendImage(png), /失效/u)
  assert.equal(sends, 1)
})

test('invalid bytes and stored permission changes are fenced before image delivery', async () => {
  let sends = 0, live = true, checks = 0
  const current = scope({ async ensureCurrent() {
    checks++
    if (!live) throw new Error('private-policy-detail')
  }, async sendImage() { sends++; return { state: 'sent', messageId: 'must-not-send' } } })
  const invalid = await tool(async (_input, context) => {
    await context.sendImage({ ...png, base64: 'https://example.test/image.png' })
    return { status: 'succeeded', content: 'wrong' }
  }, current).execute({}, {})
  assert.equal(invalid.status, 'unknown')
  assert.equal(sends, 0)
  const revoked = await tool(async (_input, context) => {
    live = false
    await context.sendImage(png)
    return { status: 'succeeded', content: 'wrong' }
  }, current).execute({}, {})
  assert.equal(revoked.status, 'unknown')
  assert.doesNotMatch(JSON.stringify(revoked), /private-policy/u)
  assert.equal(sends, 0)
  assert.ok(checks >= 3)
})

test('scoped attachment reads validate visible sequence arguments and bytes, then revoke saved contexts', async () => {
  let saved, reads = 0, checks = 0, receivedSignal
  const result = await tool(async (_input, context) => {
    saved = context
    for (const seq of [0, -1, 1.5, NaN, '1']) await assert.rejects(context.readImages(seq), /序号/u)
    assert.deepEqual(await context.readImages(7), [png])
    return { status: 'succeeded', content: 'Attached image read' }
  }, scope({ async ensureCurrent() { checks++ }, async readImages(seq, guard, signal) {
    assert.equal(seq, 7)
    assert.equal(guard(), true)
    assert.ok(signal instanceof AbortSignal)
    assert.equal(signal.aborted, false)
    receivedSignal = signal
    reads++
    return [png]
  } })).execute({}, {})
  assert.equal(result.status, 'success')
  assert.equal(reads, 1)
  assert.ok(checks >= 4)
  assert.equal(receivedSignal, saved.signal)
  assert.equal(receivedSignal.aborted, true)
  await assert.rejects(saved.readImages(7), /失效/u)
  assert.equal(reads, 1)
  for (const images of [[{ ...png, mime: 'image/jpeg' }], [png, png, png], [{ ...png, base64: 'https://private.invalid/file' }]]) {
    const invalid = await tool(async (_input, context) => {
      await context.readImages(1)
      return { status: 'succeeded', content: 'wrong' }
    }, scope({ async readImages() { return images } })).execute({}, {})
    assert.equal(invalid.status, 'unknown')
  }
})

test('aborting a tool propagates its signal to an in-progress attachment read', async () => {
  const stop = new AbortController()
  let entered, receivedSignal, saved
  const started = new Promise(resolve => { entered = resolve })
  const tools = createAgentTools({ builtIn: [definition(async (_input, context) => {
    saved = context
    await context.readImages(1)
    return { status: 'succeeded', content: 'late image must not be used' }
  })] }, {
    signal: stop.signal,
    context: () => scope({ async readImages(_seq, guard, signal) {
      assert.equal(guard(), true)
      assert.ok(signal instanceof AbortSignal)
      assert.equal(signal.aborted, false)
      receivedSignal = signal
      entered()
      return new Promise(resolve => signal.addEventListener('abort', () => resolve([png]), { once: true }))
    } }),
  })
  const work = tools.getExtraTools(['imageProbe'])[0].execute({}, {})
  await started
  stop.abort()
  assert.equal((await work).status, 'unknown')
  assert.equal(receivedSignal, saved.signal)
  assert.equal(receivedSignal.aborted, true)
  await assert.rejects(saved.readImages(1), /失效/u)
})

test('tool deadlines remain 45 seconds by default and accept only bounded explicit overrides', async t => {
  const deadlines = []
  t.mock.method(AbortSignal, 'timeout', milliseconds => { deadlines.push(milliseconds); return new AbortController().signal })
  for (const timeoutMs of [undefined, 240_000]) {
    const result = await tool(async () => ({ status: 'succeeded', content: 'done' }), scope(), timeoutMs).execute({}, {})
    assert.equal(result.status, 'success')
  }
  assert.deepEqual(deadlines, [45_000, 240_000])
  for (const timeoutMs of [null, 0, -1, 240_001, 1.5, NaN, Infinity, '240000']) {
    assert.throws(() => tool(async () => ({ status: 'succeeded', content: 'wrong' }), scope(), timeoutMs))
  }
})

test('a timed-out image waiting in a transport queue loses its final synchronous send guard', async () => {
  let entered, finish, saved, sent = 0
  const started = new Promise(resolve => { entered = resolve })
  const queued = new Promise(resolve => { finish = resolve })
  const work = tool(async (_input, context) => {
    saved = context
    await context.sendImage(png)
    return { status: 'succeeded', content: 'wrong' }
  }, scope({ async sendImage(_image, guard) {
    entered()
    await queued
    if (guard()) { sent++; return { state: 'sent', messageId: 'late-image' } }
    return { state: 'failed', code: 'cancelled' }
  } }), 25).execute({}, {})
  await started
  // Keep the event loop alive: AbortSignal.timeout intentionally uses an unreferenced timer.
  const keepAlive = setTimeout(() => {}, 1000)
  try {
    assert.equal((await work).status, 'unknown')
    assert.equal(saved.signal.aborted, true)
    finish()
    await assert.rejects(saved.sendImage(png), /失效/u)
    assert.equal(sent, 0)
  } finally { clearTimeout(keepAlive); finish() }
})
