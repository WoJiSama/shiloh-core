import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const { createAgentGroupLogRenderer, renderLogText, renderLogHtml, MAX_AGENT_GROUP_LOG_BYTES } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/dice/infrastructure/agentGroupLog.js')).href)
const MiB = 1024 * 1024
const document = { title: '团录 <script> &', startedAt: '2026-11-16T12:00:00Z', endedAt: '2026-11-16T13:00:00Z' }
const rows = [{ at: '2026-11-16T12:01:00Z', userId: 'player', name: '甲', content: '正文 <script>alert("x")</script>\n第二行' },
  { at: '2026-11-16T12:02:00Z', userId: 'player', name: '甲', content: '侦查：大成功', type: 'dice_result' }]

test('Core renderer produces complete owned UTF8 TXT/HTML through the shared fixed templates', () => {
  const render = createAgentGroupLogRenderer()
  for (const format of ['txt', 'html']) {
    const result = render(document, rows, format), text = Buffer.from(result.base64, 'base64').toString('utf8')
    assert.equal(text, (format === 'html' ? renderLogHtml : renderLogText)(document, rows))
    assert.equal(result.mime, format === 'html' ? 'text/html' : 'text/plain')
    assert.match(result.name, format === 'html' ? /-[a-f\d]{12}\.html$/u : /-[a-f\d]{12}\.txt$/u)
    assert.ok(Object.isFrozen(result)); assert.deepEqual(Object.keys(result), ['name', 'mime', 'base64'])
    if (format === 'html') { assert.doesNotMatch(text, /<script>/u); assert.match(text, /&lt;script&gt;/u); assert.doesNotMatch(text, /(?:src|href)=/u) }
  }
  assert.deepEqual(render(document, rows), render(document, rows))
})

test('Core export keeps all rows and rejects the complete artifact rather than silently truncating', () => {
  const line = { userId: '1', content: '' }, header = Buffer.byteLength(renderLogText({}, [line]))
  const exact = 'x'.repeat(MiB - header), render = createAgentGroupLogRenderer({ maxBytes: MiB })
  const result = render({}, [{ ...line, content: exact }])
  assert.equal(Buffer.from(result.base64, 'base64').length, MiB)
  assert.equal(Buffer.from(result.base64, 'base64').toString('utf8'), renderLogText({}, [{ ...line, content: exact }]))
  assert.throws(() => render({}, [{ ...line, content: exact + 'x' }]))
  assert.throws(() => render({}, [{ ...line, content: '&'.repeat(MiB / 4) }], 'html'))
  assert.equal(MAX_AGENT_GROUP_LOG_BYTES, 100 * MiB)
})

test('Core export enforces known secrets in every field, encoded text and cross-row boundaries', () => {
  const secret = 'GROUP_LOG_PRIVATE_20261116', render = createAgentGroupLogRenderer({ secrets: [secret] })
  for (const value of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), [...secret].map(char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('')]) {
    assert.throws(() => render({}, [{ content: value }]), error => !error.message.includes(secret))
  }
  assert.throws(() => render({ title: secret }, []))
  assert.throws(() => render({}, [{ name: secret, content: 'normal' }]))
  assert.throws(() => render({}, [{ content: secret.slice(0, 8) }, { content: secret.slice(8) }]))
  assert.throws(() => createAgentGroupLogRenderer({ allowsText: value => !value.includes('blocked') })({}, [{ content: 'blocked' }]))
})

test('Core renderer snapshots closed data and does not execute accessors or proxy traps', () => {
  const render = createAgentGroupLogRenderer(); let touched = 0
  const proxy = new Proxy({}, { getPrototypeOf() { touched++; throw Error('private') }, ownKeys() { touched++; throw Error('private') } })
  for (const args of [[proxy, rows], [document, proxy], [document, [proxy]], [{ get title() { touched++; throw Error('private') } }, rows], [document, [{ get content() { touched++; throw Error('private') } }]]]) {
    assert.throws(() => render(...args))
  }
  assert.throws(() => createAgentGroupLogRenderer(proxy))
  assert.equal(touched, 0)
  for (const args of [[{ ...document, file: '/tmp/legacy.jsonl' }, rows], [document, [{ content: 'normal', url: 'https://secret.test' }]], [document, new Array(1)]]) assert.throws(() => render(...args))
})

test('Core renderer validates budgets, malformed Unicode, formats and bounded metadata', () => {
  for (const maxBytes of [0, MiB - 1, 100 * MiB + 1, Infinity, '8388608']) assert.throws(() => createAgentGroupLogRenderer({ maxBytes }))
  assert.throws(() => createAgentGroupLogRenderer({ unknown: true }))
  const render = createAgentGroupLogRenderer()
  for (const content of ['nul\0x', '\u001b[31m', '\ud800']) assert.throws(() => render({}, [{ content }]))
  assert.throws(() => render({}, rows, 'pdf')); assert.throws(() => render({ title: 'x'.repeat(81) }, []))
  assert.throws(() => render({}, [{ content: 'normal', type: 'nativePlatformObject' }]))
  assert.match(Buffer.from(render({}, []).base64, 'base64').toString('utf8'), /COC Log/u)
})

test('derived names, all row fields and renderer configuration retain strict secret and Unicode boundaries', () => {
  assert.throws(() => createAgentGroupLogRenderer({ secrets: ['SECRET_KEY'] })({ title: 'SECRET KEY' }, [{ content: 'normal' }]))
  for (const format of ['txt', 'html']) assert.throws(() => createAgentGroupLogRenderer({ secrets: ['SECRET_KEY'] })({}, [{ at: 'SECRET_', name: 'KEY', content: 'normal' }], format))
  const result = createAgentGroupLogRenderer()({ title: 'a'.repeat(49) + '😀' }, [{ content: 'normal' }])
  assert.ok(result.name.includes('😀')); assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(result.name)), result.name)
  assert.throws(() => createAgentGroupLogRenderer({ maxBytes: null }))
  for (const secrets of [Object.assign(['safe'], { extra: true }), Object.assign(['safe'], { [Symbol('extra')]: true }), Object.setPrototypeOf(['safe'], null)]) assert.throws(() => createAgentGroupLogRenderer({ secrets }))
})
