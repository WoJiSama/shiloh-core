import assert from 'node:assert/strict'
import test from 'node:test'
import { agentFileUploadText, normalizeFileDeliveryReceipt, validateAgentFileUpload } from '../dist/backend/modules/messaging/infrastructure/agentFileDelivery.js'
import { createAgentSecretTextCheck } from '../dist/backend/modules/messaging/infrastructure/agentSecretText.js'

const file = { name: '验收.txt', mime: 'text/plain', base64: Buffer.from('完整内容\n').toString('base64') }

test('upload boundary owns canonical bounded bytes and rejects native paths, targets and download references', () => {
  const source = { ...file }, owned = validateAgentFileUpload(source)
  source.name = 'changed.txt'; source.base64 = 'Yg=='
  assert.deepEqual(owned, file)
  assert.ok(Object.isFrozen(owned))
  for (const value of [{ ...file, url: 'https://example.com' }, { ...file, target: 'other' }, { ...file, path: '/tmp/private' },
    { ...file, origin: 'current' }, { ...file, name: '../private' }, { ...file, name: '..' }, { ...file, base64: 'YQ=' },
    { ...file, base64: 'YR==' }, { ...file, base64: Buffer.alloc(12 * 1024 * 1024 + 1).toString('base64') }]) assert.throws(() => validateAgentFileUpload(value))
  let read = false
  assert.throws(() => validateAgentFileUpload({ ...file, get base64() { read = true; return file.base64 } }))
  assert.equal(read, false)
})

test('file ID confirms an upload without inventing a message ID; missing or invalid evidence remains unknown', () => {
  assert.deepEqual(normalizeFileDeliveryReceipt({ state: 'uploaded', fileId: '/opaque-uuid' }), { state: 'uploaded', fileId: '/opaque-uuid' })
  assert.deepEqual(normalizeFileDeliveryReceipt({ state: 'uploaded', fileId: 'file', messageId: '42' }), { state: 'uploaded', fileId: 'file', messageId: '42' })
  assert.deepEqual(normalizeFileDeliveryReceipt({ state: 'failed', code: 'explicit_rejection', fileId: 'ignored' }), { state: 'failed', code: 'explicit_rejection' })
  for (const value of [undefined, {}, { state: 'sent', messageId: '42' }, { state: 'uploaded', fileId: null },
    { state: 'uploaded', fileId: '' }, { state: 'uploaded', fileId: 'x\n' }, { state: 'uploaded', fileId: 'file', messageId: '0' }]) assert.deepEqual(normalizeFileDeliveryReceipt(value), { state: 'unknown' })
})

test('text uploads cannot hide their body behind octet-stream or a textual MIME; invalid UTF8 fails closed', () => {
  assert.equal(agentFileUploadText(file), '完整内容\n')
  assert.equal(agentFileUploadText({ ...file, mime: 'application/octet-stream' }), '完整内容\n')
  assert.equal(agentFileUploadText({ ...file, name: 'data.bin', mime: 'application/json' }), '完整内容\n')
  assert.equal(agentFileUploadText({ ...file, name: 'archive.zip', mime: 'application/zip' }), undefined)
  assert.throws(() => agentFileUploadText({ ...file, base64: Buffer.from([0xff, 0xfe]).toString('base64') }))
})

test('known host credentials cannot escape through text files even in encoded forms', () => {
  const secret = 'ordinary-credential+示例', safe = createAgentSecretTextCheck([secret])
  assert.equal(safe('普通文件内容'), true)
  for (const value of [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1), Buffer.from(secret).toString('base64'),
    [...secret].map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')]) assert.equal(safe(value), false)
  assert.equal(createAgentSecretTextCheck([])('任何普通正文'), true)
})
