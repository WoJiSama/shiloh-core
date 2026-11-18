import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const { validateAgentGroupLogArtifact, MAX_AGENT_GROUP_LOG_BYTES } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/media/infrastructure/agentGroupLogArtifact.js')).href)
const artifact = (text = '团录\n甲：你好\t世界\r\n', name = '团录.txt', mime = 'text/plain') => ({ name, mime, base64: Buffer.from(text).toString('base64') })

test('group log artifacts own frozen complete UTF-8 TXT and HTML snapshots', () => {
  for (const input of [artifact(), artifact('<!doctype html><html><body>甲 &amp; 乙</body></html>', '团录.HTML', 'text/html'), artifact('正文', '团录.htm', 'text/html'), Object.assign(Object.create(null), artifact())]) {
    const expected = { ...input }, owned = validateAgentGroupLogArtifact(input)
    assert.deepEqual(owned, expected)
    assert.notEqual(owned, input)
    assert.equal(Object.isFrozen(owned), true)
    input.base64 = 'mutated'
    assert.equal(owned.base64, expected.base64)
  }
  // This boundary validates encoding and ownership, not HTML sanitization.
  assert.equal(validateAgentGroupLogArtifact(artifact('<script>producer must not emit this</script>', 'log.html', 'text/html')).mime, 'text/html')
})

test('closed data rejects proxies without invoking traps, getters, extra fields and symbols', () => {
  let invoked = false
  const trap = () => { invoked = true; throw Error('PRIVATE_ACCESS') }
  const proxy = new Proxy(artifact(), { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap })
  const revocable = Proxy.revocable(artifact(), {}); revocable.revoke()
  const getter = Object.defineProperty(artifact(), 'base64', { enumerable: true, get: trap })
  const hidden = Object.defineProperty(artifact(), 'path', { value: '/private/log.txt' })
  for (const input of [null, undefined, [], 'log.txt', {}, new String('text'), proxy, revocable.proxy, getter, hidden, { ...artifact(), [Symbol('private')]: 'hidden' }, { ...artifact(), target: 'another-group' }, Object.create(artifact()), new (class { constructor() { Object.assign(this, artifact()) } })()]) {
    assert.throws(() => validateAgentGroupLogArtifact(input), error => !String(error).includes('PRIVATE_ACCESS'))
  }
  assert.equal(invoked, false)
})

test('artifact names and exact MIME suffix pairs reject paths, control characters and unsafe names', () => {
  for (const name of ['', '.', '..', '../log.txt', '/log.txt', 'a\\log.txt', 'C:log.txt', 'log\u0000.txt', 'log\u001b.txt', 'log\u007f.txt', 'log\u0085.txt', 'log\ud800.txt', 'log\udfff.txt', ' log.txt', 'log.txt ', 'log.txt.', 'log?.txt', 'log*.txt', 'log|.txt', 'log<.txt', 'log>.txt', 'log".txt', 'CON.txt', 'lpt1.txt', 'a'.repeat(252) + '.txt', 'log.log', 'log.html']) {
    assert.throws(() => validateAgentGroupLogArtifact({ ...artifact(), name }))
  }
  for (const [name, mime] of [['log.txt', 'text/html'], ['log.html', 'text/plain'], ['log.txt', 'TEXT/PLAIN'], ['log.html', 'text/html; charset=utf-8'], ['log.txt', 'application/octet-stream']]) {
    assert.throws(() => validateAgentGroupLogArtifact({ ...artifact(), name, mime }))
  }
  assert.equal(validateAgentGroupLogArtifact(artifact('正文', 'a'.repeat(251) + '.txt')).name.length, 255)
  assert.equal(validateAgentGroupLogArtifact(artifact('正文', '团录😀𠮷.txt')).name, '团录😀𠮷.txt')
})

test('canonical base64 rejects permissive decoding aliases and preserves exact small byte boundaries', () => {
  for (const text of ['a', 'ab', 'abc', 'abcd']) assert.equal(Buffer.from(validateAgentGroupLogArtifact(artifact(text)).base64, 'base64').toString('utf8'), text)
  for (const base64 of ['', 'YQ', 'YQ=', 'YQ===', 'YR==', 'YWJ=', 'YQ==\n', ' YQ==', 'YQ==YQ==', 'YQ--', 'YQ__', '!!!!', '====', 'data:text/plain;base64,YQ==']) {
    assert.throws(() => validateAgentGroupLogArtifact({ ...artifact(), base64 }))
  }
})

test('fatal UTF-8 and text policy reject malformed bytes, NUL and dangerous controls', () => {
  for (const bytes of [[0xff], [0xc3, 0x28], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x82], [0xef, 0xbb, 0xbf]]) {
    assert.throws(() => validateAgentGroupLogArtifact({ ...artifact(), base64: Buffer.from(bytes).toString('base64') }))
  }
  for (const control of ['\u0000', '\u0001', '\u0008', '\u000b', '\u000c', '\u000e', '\u001b', '\u001f', '\u007f', '\u0085', '\u009f']) {
    assert.throws(() => validateAgentGroupLogArtifact(artifact(`before${control}after`)))
  }
  assert.equal(validateAgentGroupLogArtifact(artifact('实际替代字符：\ufffd')).base64, artifact('实际替代字符：\ufffd').base64)
})

test('100 MiB is accepted complete without truncation and the next byte is rejected', () => {
  assert.equal(MAX_AGENT_GROUP_LOG_BYTES, 100 * 1024 * 1024)
  const bytes = Buffer.alloc(MAX_AGENT_GROUP_LOG_BYTES, 0x61)
  bytes.write('END', bytes.length - 3)
  const input = { name: '完整团录.txt', mime: 'text/plain', base64: bytes.toString('base64') }
  const owned = validateAgentGroupLogArtifact(input)
  assert.equal(owned.base64, input.base64)
  const decoded = Buffer.from(owned.base64, 'base64')
  assert.equal(decoded.length, MAX_AGENT_GROUP_LOG_BYTES)
  assert.equal(decoded.subarray(-3).toString('utf8'), 'END')
  assert.throws(() => validateAgentGroupLogArtifact({ ...input, base64: Buffer.alloc(MAX_AGENT_GROUP_LOG_BYTES + 1, 0x61).toString('base64') }))
  assert.throws(() => validateAgentGroupLogArtifact({ ...input, base64: 'A'.repeat(Math.ceil(MAX_AGENT_GROUP_LOG_BYTES / 3) * 4 + 4) }))
})
