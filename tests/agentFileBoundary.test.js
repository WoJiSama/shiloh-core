import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createAgentExcelTool } from '../dist/backend/modules/content/infrastructure/agentExcelTool.js'
import { snapshotAgentFileRequest, validateAgentFileBytes, validateAgentFileListing, MAX_AGENT_FILE_BYTES } from '../dist/backend/modules/content/infrastructure/agentFileBytes.js'
import { readAgentPublicFile } from '../dist/backend/modules/tools/infrastructure/agentPublicWeb.js'
import { createAgentTools } from '../dist/backend/modules/tools/infrastructure/agentTools.js'

const file = { name: '数据.xlsx', mime: 'application/octet-stream', base64: Buffer.from('PK synthetic').toString('base64'), origin: 'current' }
const guard = () => ({ signal: new AbortController().signal, isCurrent: () => true })
const address = { address: '8.8.8.8', family: 4 }
const response = { status: 200, headers: {}, body: Buffer.from('PK synthetic') }

test('file boundary owns closed request and validates canonical bounded bytes without invoking accessors', () => {
  const input = { sourceSeq: 2, fileIndex: 1, fileName: '数据.xlsx' }
  const result = snapshotAgentFileRequest(input)
  input.fileName = 'changed.xlsx'
  assert.equal(result.fileName, '数据.xlsx')
  assert.ok(Object.isFrozen(result))
  let invoked = false
  assert.throws(() => snapshotAgentFileRequest({ get fileName() { invoked = true; return 'x' } }))
  assert.equal(invoked, false)
  for (const value of [{ sourceSeq: 0 }, { fileIndex: 1.2 }, { fileName: '../x' }, { folderPath: 'a\nb' }, { resource: 'secret-id' }, { fileUrl: 'x'.repeat(2049) }]) assert.throws(() => snapshotAgentFileRequest(value))
  assert.deepEqual(validateAgentFileBytes(file), file)
  for (const value of [{ ...file, base64: 'YR==' }, { ...file, base64: 'YQ' }, { ...file, base64: '' }, { ...file, name: '/local/path' }, { ...file, mime: 'text/plain\r\nsecret' }, { ...file, origin: 'model' }]) assert.throws(() => validateAgentFileBytes(value))
  const large = Buffer.alloc(MAX_AGENT_FILE_BYTES)
  assert.equal(validateAgentFileBytes({ ...file, base64: large.toString('base64') }).base64.length, large.toString('base64').length)
  assert.throws(() => validateAgentFileBytes({ ...file, base64: Buffer.alloc(MAX_AGENT_FILE_BYTES + 1).toString('base64') }))
})

test('file directory boundary strips adapter references and rejects invalid totals and entries', () => {
  const input = { files: [{ name: '数据.xlsx', folderPath: '/财务', size: 7, reference: 'secret-platform-id', url: 'secret-url' }], totalFiles: 1, truncated: false }
  const output = validateAgentFileListing(input)
  assert.deepEqual(output, { files: [{ name: '数据.xlsx', folderPath: '/财务', size: 7 }], totalFiles: 1, truncated: false })
  assert.ok(Object.isFrozen(output.files[0]))
  for (const value of [{ ...input, totalFiles: 0 }, { ...input, totalFiles: 2001 }, { ...input, files: [{ name: 'x', folderPath: '', size: -1 }] }]) assert.throws(() => validateAgentFileListing(value))
})

test('public file download pins the validated address and exposes only safe bytes and file name', async () => {
  let requested
  const value = await readAgentPublicFile('https://files.example/%E6%95%B0%E6%8D%AE.xlsx?token=user-supplied', guard(), {
    lookup: async () => [address], request: async (url, pinned, signal) => { requested = { url: url.href, pinned }; assert.ok(!signal.aborted); return response },
  })
  assert.deepEqual(requested, { url: 'https://files.example/%E6%95%B0%E6%8D%AE.xlsx?token=user-supplied', pinned: address })
  assert.equal(value.name, '数据.xlsx')
  assert.equal(value.origin, 'explicit')
  assert.deepEqual(Buffer.from(value.base64, 'base64'), response.body)
  assert.doesNotMatch(JSON.stringify(value), /https:|files\.example/u)
})

test('public file download rejects credentials, mixed private DNS, unsafe redirects and bounded bodies', async () => {
  let requests = 0
  const deps = { lookup: async () => [address], request: async () => { requests++; return response } }
  for (const url of ['file:///tmp/private', 'http://127.0.0.1/x', 'https://user:pass@files.example/x']) await assert.rejects(readAgentPublicFile(url, guard(), deps), /公共文件读取失败/u)
  assert.equal(requests, 0)
  await assert.rejects(readAgentPublicFile('https://files.example/a.xlsx', guard(), { ...deps, lookup: async () => [address, { address: '127.0.0.1', family: 4 }] }))
  assert.equal(requests, 0)
  for (const bad of [{ status: 302, headers: { location: 'http://127.0.0.1/x' }, body: '' }, { ...response, headers: { 'content-encoding': 'gzip' } }, { ...response, headers: { 'content-length': String(MAX_AGENT_FILE_BYTES + 1) } }, { ...response, body: Buffer.alloc(MAX_AGENT_FILE_BYTES + 1) }]) {
    await assert.rejects(readAgentPublicFile('https://files.example/a.xlsx', guard(), { ...deps, request: async () => bad }))
  }
})

test('public file download bounds hung authorization and discards bytes after revocation', async () => {
  let requests = 0
  const deps = { timeoutMs: 20, lookup: async () => [address], request: async () => { requests++; return response } }
  const keepAlive = setInterval(() => {}, 1000)
  try { await assert.rejects(readAgentPublicFile('https://files.example/a.xlsx', { ...guard(), ensureCurrent: async () => await new Promise(() => {}) }, deps)) }
  finally { clearInterval(keepAlive) }
  assert.equal(requests, 0)
  let current = true
  await assert.rejects(readAgentPublicFile('https://files.example/a.xlsx', { ...guard(), isCurrent: () => current }, { ...deps, request: async () => { current = false; return response } }))
})

test('tool file wrappers snapshot selection before awaits, strip raw ports and expire after completion', async () => {
  let captured, context, checks = 0
  const input = { fileName: '数据.xlsx' }
  const definition = { name: 'fileProbe', dataPolicy: 'ephemeral', description: 'synthetic file boundary probe', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, async execute(_args, scoped) {
    context = scoped
    const output = await scoped.readFile(input)
    assert.deepEqual(output, file)
    await scoped.listFiles({})
    return { status: 'succeeded', content: 'done' }
  } }
  const tools = createAgentTools({ builtIn: [definition] }, { signal: new AbortController().signal, context: () => ({ binding: {}, actor: { kind: 'user' }, isCurrent: () => true,
    async ensureCurrent() { if (++checks === 2) input.fileName = 'mutated.xlsx' },
    async readFile(selection, current, signal) { assert.ok(current() && !signal.aborted); captured = selection; return file },
    async listFiles(selection, current, signal) { assert.deepEqual(selection, {}); assert.ok(current() && !signal.aborted); return { files: [], totalFiles: 0, truncated: false } },
  }) })
  assert.equal((await tools.getExtraTools(['fileProbe'])[0].execute({}, {})).status, 'success')
  assert.equal(captured.fileName, '数据.xlsx')
  assert.equal(context.signal.aborted, true)
  await assert.rejects(context.readFile({}))
  await assert.rejects(context.listFiles({}))
})

test('undeclared host tools receive no file capabilities even when the runtime offers raw ports', async () => {
  let context
  const tool = { name: 'ordinaryProbe', description: 'synthetic undeclared file probe', parameters: { type: 'object', properties: {}, required: [] },
    async execute(_args, value) { context = value; return { status: 'succeeded', content: 'done' } } }
  const registry = createAgentTools({ builtIn: [tool] }, { signal: new AbortController().signal, context: () => ({ binding: {}, actor: { kind: 'user' }, isCurrent: () => true, async readFile() { throw new Error('raw must never escape') }, async listFiles() { throw new Error('raw must never escape') } }) })
  assert.equal((await registry.getExtraTools(['ordinaryProbe'])[0].execute({}, {})).status, 'success')
  assert.equal(context.readFile, undefined)
  assert.equal(context.listFiles, undefined)
})

test('a verified named workbook survives a signed CDN redirect and is read by the real Excel worker', async () => {
  const workbook = await readFile(new URL('./fixtures/agentWorkbook.xlsx', import.meta.url))
  let requests = 0
  const file = await readAgentPublicFile('https://files.example/budget.xlsx', guard(), {
    lookup: async () => [address], request: async () => ++requests === 1
      ? { status: 302, headers: { location: 'https://cdn.example/download?signature=provider-only' }, body: '' }
      : { status: 200, headers: {}, body: workbook },
  })
  assert.equal(requests, 2)
  assert.equal(file.name, 'budget.xlsx')
  const result = await createAgentExcelTool().execute({ operation: 'read_cell', cell: 'B2' }, {
    ...guard(), binding: { target: { kind: 'group' } }, actor: { kind: 'user', user: { id: 'member' } },
    request: { messageId: 'verified-request', text: '读取工作簿', mentions: [] }, async readFile() { return file },
  })
  assert.equal(result.status, 'succeeded')
  assert.match(result.content, /公式: =2\+3/u)
  assert.match(result.content, /值: 5/u)
  assert.doesNotMatch(result.content, /signature|provider-only|https:/u)
})
