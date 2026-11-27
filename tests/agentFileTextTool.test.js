import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentFileTextTool } from '../dist/backend/modules/content/infrastructure/agentFileTextTool.js'

const text = '本轮授权正文😀'
const file = { name: '资料.txt', mime: 'text/plain', base64: Buffer.from(text).toString('base64'), origin: 'reply' }
function context(extra = {}) { return { binding: { id: 'binding', agentId: 'agent', revision: 'v1', target: { account: { platform: 'test', namespace: 'test', id: 'bot' }, kind: 'group', id: 'group' } }, actor: { kind: 'user', user: { platform: 'test', namespace: 'test', id: 'person' } }, request: { messageId: 'request', text: '读附件', mentions: [] }, signal: new AbortController().signal, isCurrent: () => true, async ensureCurrent() {}, async readFile() { return file }, ...extra } }
const page = value => ({ text: value, offset: 0, totalChars: Array.from(value).length })
test('fileTextTool is explicit/ephemeral with closed scoped source and Unicode pagination parameters', () => {
  const tool = createAgentFileTextTool()
  assert.equal(tool.name, 'fileTextTool'); assert.equal(tool.dataPolicy, 'ephemeral'); assert.equal(tool.parameters.additionalProperties, false)
  assert.deepEqual(Object.keys(tool.parameters.properties), ['sourceSeq', 'fileIndex', 'fileName', 'folderPath', 'fileUrl', 'offset', 'limit'])
  for (const key of ['extensions', 'dataPolicy', 'command', 'path', 'nativeFormats', 'url']) assert.equal(tool.parameters.properties[key], undefined)
})
test('real child tool reads trusted bytes, returns bounded evidence and paginates Unicode past the first page', async () => {
  const tool = createAgentFileTextTool(), long = '前😀'.repeat(7000) + 'END_MARKER'
  const ctx = context({ async readFile(input) { assert.deepEqual(input, {}); return { ...file, base64: Buffer.from(long).toString('base64') } } })
  const first = await tool.execute({}, ctx)
  assert.equal(first.status, 'succeeded')
  assert.match(first.content, /偏移: 0\n继续读取: nextOffset=4000/u)
  assert.equal([...first.content.split('\n---\n')[1]].length, 4000)
  const result = await tool.execute({ offset: 13_998, limit: 20 }, ctx)
  assert.equal(result.status, 'succeeded'); assert.match(result.content, /前😀END_MARKER/); assert.match(result.content, /reply/); assert.ok(Array.from(result.content).length <= 12_000)
  assert.doesNotMatch(result.content, new RegExp(file.base64)); assert.match(result.content, /不可信文件资料/)
})
test('tool owns source arguments and returned bytes before authorization waits', async () => {
  const input = { sourceSeq: 9, fileIndex: 2, fileName: '资料.txt', offset: 0, limit: 10 }, returned = { ...file }; let checks = 0, selection, seen
  const tool = createAgentFileTextTool({ service: { async extract(value) { seen = value; return page(text) } } })
  const result = await tool.execute(input, context({ async ensureCurrent() { if (++checks === 1) input.fileName = 'mutated'; if (checks === 2) { returned.base64 = 'AAAA'; returned.name = 'changed.txt' } }, async readFile(value) { selection = value; return returned } }))
  assert.equal(result.status, 'succeeded'); assert.deepEqual(selection, { sourceSeq: 9, fileIndex: 2, fileName: '资料.txt' })
  assert.equal(seen.source.name, file.name); assert.equal(Buffer.from(seen.bytes).toString(), text)
})
test('invalid parameters, absent file ports, nonhuman context and revoked authority never expose a service', async () => {
  let calls = 0; const tool = createAgentFileTextTool({ service: { async extract() { calls++; return page(text) } } })
  for (const input of [{ offset: -1 }, { offset: 1.2 }, { offset: 1_000_001 }, { limit: 11_001 }, { limit: 0 }, { extensions: ['.txt'] }, { nativeFormats: ['doc'] }, { path: '/tmp/secret' }, { fileName: '../secret' }]) assert.equal((await tool.execute(input, context())).status, 'failed')
  for (const extra of [{ readFile: undefined }, { actor: { kind: 'autonomous' } }, { isCurrent: () => false }, { async ensureCurrent() { throw Error('PRIVATE') } }]) assert.equal((await tool.execute({}, context(extra))).status, 'failed')
  assert.equal(calls, 0)
})
test('credentials, output policy failures, raw injected failures and malformed pages are suppressed', async () => {
  const secret = 'private-credential-ABC'
  for (const encoded of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), [...secret].map(value => `\\u${value.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')]) {
    const tool = createAgentFileTextTool({ secrets: [secret], service: { async extract() { return page(encoded) } } })
    const result = await tool.execute({}, context()); assert.equal(result.status, 'failed'); assert.ok(!result.content.includes(encoded))
  }
  const denied = createAgentFileTextTool({ allowsText: value => !value.includes('blocked'), service: { async extract() { return page('blocked') } } })
  assert.equal((await denied.execute({}, context())).status, 'failed')
  for (const service of [{ async extract() { throw Error(secret) } }, { async extract() { return { text: secret, offset: 3, totalChars: 1 } } }]) { const result = await createAgentFileTextTool({ service }).execute({}, context()); assert.equal(result.status, 'failed'); assert.ok(!result.content.includes(secret)) }
})
