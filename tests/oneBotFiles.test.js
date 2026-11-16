import assert from 'node:assert/strict'
import dns from 'node:dns/promises'
import { EventEmitter, once } from 'node:events'
import http from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocketServer } from 'ws'
import { createOneBotConnection } from '../dist/backend/adapters/oneBotConnection.js'
import { decodeQqIncomingMessage } from '../dist/backend/adapters/qqMessage.js'
import { parseQqFileResource, downloadQqFile, withQqFileRead, QQ_FILE_MAX_BYTES } from '../dist/backend/adapters/qqMessageFile.js'
import { createQqConversationFiles } from '../dist/backend/adapters/qqConversationFiles.js'

const account = { platform: 'qq', namespace: 'global', id: '123456789' }
const target = { account, kind: 'group', id: '315320' }
const uploader = '324152'
const success = data => ({ status: 'ok', retcode: 0, data })
const options = overrides => ({ signal: new AbortController().signal, isCurrent: () => true,
  allowsSource: async () => true, allowsFile: async () => true, ...overrides })
const file = overrides => ({ file_id: '真实-fid', file_name: '预算.xlsx', busid: 10, file_size: 123,
  uploader: Number(uploader), upload_time: 1_800_000_000, ...overrides })
const message = overrides => ({ message_type: 'group', group_id: target.id, message_id: 17,
  time: 1_800_000_000, sender: { user_id: uploader }, message: [{ type: 'file', data: {
    file_id: '真实-fid', file: '预算.xlsx', name: '预算.xlsx', busid: 10, url: 'https://untrusted.example/shadow.xlsx',
  } }], ...overrides })

async function waitFor(probe) {
  const deadline = Date.now() + 1500
  while (Date.now() < deadline) { const value = probe(); if (value) return value; await delay(5) }
  assert.fail('Timed out waiting for fixture')
}
async function fixture(t, handler = request => {
  if (request.action === 'get_msg') return success(message())
  if (request.action === 'get_group_root_files') return success({ files: [file()], folders: [] })
  if (request.action === 'get_group_file_url') return success({ url: 'http://files.example:43210/workbook.xlsx?sig=signed' })
}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const requests = [], events = []
  let peer, respond = handler
  server.on('connection', socket => {
    peer = socket
    socket.on('error', () => {})
    socket.on('message', raw => {
      const request = JSON.parse(String(raw)); requests.push(request)
      const result = request.action === 'get_login_info' ? success({ user_id: account.id, nickname: '文件测试' }) : respond(request)
      if (result) socket.send(JSON.stringify({ ...result, echo: request.echo }))
    })
  })
  const adapter = createOneBotConnection({ connection: { id: 'file-fixture', account },
    url: `ws://127.0.0.1:${server.address().port}`, accessToken: 'test-only',
    onDisconnect() {}, onReconnect() {}, onError() {}, onEventError() {},
  })
  t.after(async () => { adapter.stop(); for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)) })
  await adapter.start(async event => { events.push(event) })
  return { adapter, requests, events, peer: () => peer, setHandler(value) { respond = value } }
}

/** Native HTTP mock retains DNS validation, pinned lookup options, AbortSignal and bounded body reads. */
function network(t, { body = Buffer.from('workbook bytes'), hold = false, lookup = async () => [{ address: '8.8.8.8', family: 4 }], headers = {} } = {}) {
  const calls = [], lookups = []
  const dnsMock = t.mock.method(dns, 'lookup', async hostname => { lookups.push(hostname); return lookup(hostname) })
  const nativeRequest = http.request
  const httpMock = t.mock.method(http, 'request', (...args) => {
    const [url, config, callback] = args
    if (!(url instanceof URL) || url.hostname !== 'files.example') return nativeRequest(...args)
    const request = new EventEmitter(), response = new PassThrough()
    response.statusCode = 200; response.headers = headers
    const call = { url, config, request, response }; calls.push(call)
    request.destroyed = false
    request.destroy = error => {
      if (!request.destroyed) { request.destroyed = true; response.destroy(); queueMicrotask(() => request.emit('error', error ?? new Error('cancelled'))) }
      return request
    }
    const abort = () => request.destroy(config.signal.reason)
    config.signal.addEventListener('abort', abort, { once: true })
    response.once('close', () => config.signal.removeEventListener('abort', abort))
    request.end = () => queueMicrotask(() => {
      if (request.destroyed) return
      callback(response)
      if (hold) response.write(body)
      else response.end(body)
    })
    return request
  })
  syncBuiltinESMExports()
  t.after(() => { for (const call of calls) call.response.destroy(); dnsMock.mock.restore(); httpMock.mock.restore(); syncBuiltinESMExports() })
  return { calls, lookups }
}

test('file decoder keeps true file_id/busid/name when filename and URL appear first', () => {
  const decoded = decodeQqIncomingMessage({ ...message(), self_id: account.id, user_id: uploader })
  assert.deepEqual(parseQqFileResource(decoded.parts[0].resource), { id: '真实-fid', name: '预算.xlsx', busid: '10' })
  assert.equal(decoded.parts[0].resource.kind, 'reference')
  assert.equal(decoded.parts[0].resource.value.includes('untrusted.example'), false)
})

test('real NapCat file/file_id/file_size shape retains its display filename without treating it as ID', () => {
  const decoded = decodeQqIncomingMessage({ ...message({ message: [{ type: 'file', data: { file: '实际预算.xlsx', file_id: 'real-napcat-uuid', file_size: 123 } }] }), self_id: account.id, user_id: uploader })
  assert.equal(decoded.parts[0].name, '实际预算.xlsx')
  assert.deepEqual(parseQqFileResource(decoded.parts[0].resource), { id: 'real-napcat-uuid', name: '实际预算.xlsx' })
  for (const unsafe of ['https://evil.test/a.xlsx', 'file:///tmp/a.xlsx', '/tmp/a.xlsx', '../a.xlsx', 'dir\\a.xlsx']) {
    const denied = decodeQqIncomingMessage({ ...message({ message: [{ type: 'file', data: { file: unsafe, file_id: 'real-id' } }] }), self_id: account.id, user_id: uploader })
    assert.equal(denied.parts[0].name, undefined)
    assert.equal(denied.parts[0].resource, undefined)
  }
})

test('get_msg reread selects one-based original file index and retrieves URL only by verified ID', { timeout: 5000 }, async t => {
  const f = await fixture(t), n = network(t)
  let source
  const result = await f.adapter.readMessageFile(target, '17', 1, options({ async allowsSource(value) { source = value; return true } }))
  assert.equal(result.name, '预算.xlsx')
  assert.equal(Buffer.from(result.base64, 'base64').toString(), 'workbook bytes')
  assert.equal(source.conversation.id, target.id)
  assert.equal(source.sender.id, uploader)
  assert.deepEqual(f.requests.filter(row => row.action !== 'get_login_info').map(({ action, params }) => ({ action, params })), [
    { action: 'get_msg', params: { message_id: 17 } },
    { action: 'get_group_file_url', params: { group_id: target.id, file_id: '真实-fid', busid: '10' } },
  ])
  assert.equal(n.calls[0].url.href, 'http://files.example:43210/workbook.xlsx?sig=signed')
  assert.equal(n.calls[0].config.headers['Accept-Encoding'], 'identity')
  n.calls[0].config.lookup('files.example', {}, (error, address, family) => {
    assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4)
  })
})

test('invalid first attachment does not shift indexes or permit a filename as file ID', { timeout: 5000 }, async t => {
  const f = await fixture(t, request => request.action === 'get_msg' ? success(message({ message: [
    { type: 'file', data: { file: '坏.xlsx', name: '坏.xlsx' } },
    { type: 'file', data: { file_id: 'good-fid', name: '好.xlsx', busid: 0 } },
  ] })) : success({ url: 'http://files.example/a.xlsx' })), n = network(t)
  assert.equal(await f.adapter.readMessageFile(target, '17', 1, options()), undefined)
  assert.equal(f.requests.some(row => row.action === 'get_group_file_url'), false)
  assert.equal((await f.adapter.readMessageFile(target, '17', 2, options())).name, '好.xlsx')
  assert.equal(f.requests.find(row => row.action === 'get_group_file_url').params.file_id, 'good-fid')
  assert.equal(n.calls.length, 1)
})

test('wrong source group/account, denied authorization and arbitrary entries never resolve file URLs', { timeout: 5000 }, async t => {
  const f = await fixture(t), n = network(t)
  f.setHandler(() => success(message({ group_id: '999999' })))
  assert.equal(await f.adapter.readMessageFile(target, '17', 1, options()), undefined)
  f.setHandler(() => success(message({ self_id: '999999' })))
  assert.equal(await f.adapter.readMessageFile(target, '17', 1, options()), undefined)
  f.setHandler(() => success(message()))
  assert.equal(await f.adapter.readMessageFile(target, '17', 1, options({ allowsSource: async () => false })), undefined)
  assert.equal(await f.adapter.readConversationFile(target, { reference: 'qq:group-file:arbitrary', name: '偷.xlsx', folderPath: '/', size: 1 }, options()), undefined)
  assert.equal(f.requests.some(row => row.action === 'get_group_file_url'), false)
  assert.equal(n.calls.length, 0)
})

for (const stage of ['ensureCurrent', 'allowsSource', 'dns']) {
  test(`aborting a suspended ${stage} releases the file operation without later network effects`, { timeout: 5000 }, async t => {
    let entered = false, release
    const hold = () => { entered = true; return new Promise(resolve => { release = resolve }) }
    const n = network(t, stage === 'dns' ? { lookup: hold } : {}), f = await fixture(t), controller = new AbortController()
    const pending = f.adapter.readMessageFile(target, '17', 1, options({ signal: controller.signal,
      ...(stage === 'ensureCurrent' ? { ensureCurrent: hold } : stage === 'allowsSource' ? { allowsSource: hold } : {}),
    }))
    await waitFor(() => entered)
    controller.abort()
    assert.equal(await Promise.race([pending, delay(500).then(() => 'timeout')]), undefined)
    release(stage === 'dns' ? [{ address: '8.8.8.8', family: 4 }] : true)
    await delay(20)
    assert.equal(n.calls.length, 0)
  })
}

for (const mode of ['signal', 'scope', 'socket']) {
  test(`${mode} cancellation destroys an in-flight native file body`, { timeout: 5000 }, async t => {
    const f = await fixture(t), n = network(t, { hold: true }), controller = new AbortController()
    let current = true
    const pending = f.adapter.readMessageFile(target, '17', 1, options({ signal: controller.signal, isCurrent: () => current }))
    const call = await waitFor(() => n.calls[0])
    if (mode === 'signal') controller.abort()
    else if (mode === 'scope') current = false
    else f.peer().terminate()
    assert.equal(await Promise.race([pending, delay(600).then(() => 'timeout')]), undefined)
    assert.equal(call.response.destroyed, true)
    assert.equal(call.config.signal.aborted, true)
  })
}

test('abort cancels the original get_msg wait without file URL calls or late network effects', { timeout: 5000 }, async t => {
  const f = await fixture(t, () => undefined), n = network(t), controller = new AbortController()
  const pending = f.adapter.readMessageFile(target, '17', 1, options({ signal: controller.signal }))
  const request = await waitFor(() => f.requests.find(row => row.action === 'get_msg'))
  controller.abort()
  assert.equal(await Promise.race([pending, delay(500).then(() => 'timeout')]), undefined)
  f.peer().send(JSON.stringify({ ...success(message()), echo: request.echo }))
  await delay(20)
  assert.equal(n.calls.length, 0)
  assert.equal(f.requests.some(row => row.action === 'get_group_file_url'), false)
})

test('DNS all-address validation rejects one private answer before HTTP', { timeout: 5000 }, async t => {
  const f = await fixture(t), n = network(t, { lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] })
  assert.equal(await f.adapter.readMessageFile(target, '17', 1, options()), undefined)
  assert.equal(n.calls.length, 0)
})

for (const headers of [{ 'content-encoding': 'gzip' }, { 'content-length': String(QQ_FILE_MAX_BYTES + 1) }]) {
  test(`file body rejects unsafe headers ${JSON.stringify(headers)}`, { timeout: 5000 }, async t => {
    const f = await fixture(t), n = network(t, { headers })
    assert.equal(await f.adapter.readMessageFile(target, '17', 1, options()), undefined)
    assert.equal(n.calls[0].response.destroyed, true)
  })
}

test('the streaming byte limit holds without a Content-Length header', { timeout: 5000 }, async t => {
  const f = await fixture(t), n = network(t, { body: Buffer.alloc(QQ_FILE_MAX_BYTES + 1) })
  assert.equal(await f.adapter.readMessageFile(target, '17', 1, options()), undefined)
  assert.equal(n.calls[0].response.destroyed, true)
})

test('group catalog contains non-Excel files, stable scoped references and upload evidence; reading fresh relists', { timeout: 5000 }, async t => {
  const n = network(t), f = await fixture(t, request => {
    if (request.action === 'get_group_root_files') return success({ files: [file({ file_id: 'notes', file_name: '说明.txt' })], folders: [{ folder_id: 'finance', folder_name: '财务' }] })
    if (request.action === 'get_group_files_by_folder') return success({ files: [file()], folders: [] })
    if (request.action === 'get_group_file_url') return success({ url: 'http://files.example/预算.xlsx' })
  })
  const first = await f.adapter.listConversationFiles(target, options()), second = await f.adapter.listConversationFiles(target, options())
  assert.equal(first.files.length, 2)
  assert.equal(first.truncated, false)
  assert.deepEqual(first.files, second.files)
  const selected = first.files[1]
  assert.equal(selected.folderPath, '/财务/')
  assert.deepEqual(selected.uploadedBy, { platform: 'qq', namespace: 'global', id: uploader })
  assert.equal(selected.uploadedAt, 1_800_000_000_000)
  const result = await f.adapter.readConversationFile(target, selected, options())
  assert.equal(result.name, '预算.xlsx')
  assert.equal(n.calls.length, 1)
  assert.equal(f.requests.filter(row => row.action === 'get_group_root_files').length, 3)
  assert.deepEqual(f.requests.find(row => row.action === 'get_group_file_url').params, { group_id: target.id, file_id: '真实-fid', busid: '10' })
  assert.equal(await f.adapter.readConversationFile({ ...target, id: '999999' }, selected, options()), undefined)
})

for (const changed of [{ file_id: 'other' }, { busid: 11 }, { file_name: '改.xlsx' }, { file_size: 124 }, { uploader: 324153 }, { upload_time: 1_800_000_001 }]) {
  test(`fresh group evidence must exactly retain ${Object.keys(changed)[0]}`, { timeout: 5000 }, async t => {
    const f = await fixture(t), n = network(t)
    const catalog = await f.adapter.listConversationFiles(target, options())
    f.setHandler(() => success({ files: [file(changed)], folders: [] }))
    assert.equal(await f.adapter.readConversationFile(target, catalog.files[0], options()), undefined)
    assert.equal(f.requests.some(row => row.action === 'get_group_file_url'), false)
    assert.equal(n.calls.length, 0)
  })
}

test('catalog caps all files at 2000 and Excel files at 500 with explicit truncation', async () => {
  for (const [count, name, maximum] of [[2001, '说明.txt', 2000], [501, '预算.xlsx', 500]]) {
    const reader = createQqConversationFiles()
    const result = await reader.list(target, options(), async () => success({ files: Array.from({ length: count }, (_, index) => file({ file_id: `file-${index}`, file_name: name })), folders: [] }))
    assert.equal(result.files.length, maximum)
    assert.equal(result.truncated, true)
  }
})

test('the directory scan bounds depth and folder requests, exposing truncation without out-of-scope APIs', async () => {
  const deepCalls = [], deepReader = createQqConversationFiles()
  const deep = await deepReader.list(target, options(), async (action, params) => {
    deepCalls.push({ action, params })
    const depth = params.folder_id ? Number(params.folder_id.slice(1)) : 0
    return success({ files: [file({ file_id: `f${depth}` })], folders: [{ folder_id: `d${depth + 1}`, folder_name: `层${depth + 1}` }] })
  })
  assert.equal(deep.files.length, 6)
  assert.equal(deepCalls.length, 6)
  assert.equal(deep.truncated, true)
  assert.ok(deepCalls.every(call => call.params.group_id === target.id))
  const wideCalls = [], wideReader = createQqConversationFiles()
  const wide = await wideReader.list(target, options(), async (action, params) => {
    wideCalls.push({ action, params })
    return success({ files: [], folders: action === 'get_group_root_files' ? Array.from({ length: 101 }, (_, i) => ({ folder_id: `d${i}`, folder_name: `目录${i}` })) : [] })
  })
  assert.equal(wideCalls.length, 100)
  assert.equal(wide.truncated, true)
})

test('moving an otherwise identical file to another folder invalidates its listed evidence', { timeout: 5000 }, async t => {
  let folderName = '财务'
  const f = await fixture(t, request => request.action === 'get_group_root_files' ?
    success({ files: [], folders: [{ folder_id: 'folder', folder_name: folderName }] }) : success({ files: [file()], folders: [] })), n = network(t)
  const catalog = await f.adapter.listConversationFiles(target, options())
  folderName = '归档'
  assert.equal(await f.adapter.readConversationFile(target, catalog.files[0], options()), undefined)
  assert.equal(f.requests.some(row => row.action === 'get_group_file_url'), false)
  assert.equal(n.calls.length, 0)
})

test('aborting a suspended directory file authorization never resolves its URL', { timeout: 5000 }, async t => {
  const f = await fixture(t), n = network(t), catalog = await f.adapter.listConversationFiles(target, options())
  const controller = new AbortController()
  let release, entered = false
  const pending = f.adapter.readConversationFile(target, catalog.files[0], options({ signal: controller.signal, async allowsFile() {
    entered = true; return new Promise(resolve => { release = resolve })
  } }))
  await waitFor(() => entered)
  controller.abort()
  assert.equal(await Promise.race([pending, delay(500).then(() => 'timeout')]), undefined)
  release(true)
  await delay(20)
  assert.equal(f.requests.some(row => row.action === 'get_group_file_url'), false)
  assert.equal(n.calls.length, 0)
})

test('foreign group/account directory response proofs cannot issue trusted references', async () => {
  for (const data of [{ group_id: '999999', files: [file()] }, { self_id: '999999', files: [file()] }]) {
    const reader = createQqConversationFiles()
    assert.equal(await reader.list(target, options(), async () => success(data)), undefined)
  }
})

test('redirects reauthorize and recheck DNS each hop, never following a fourth redirect', async () => {
  let lookups = 0, requests = 0, authorized = 0
  const result = await withQqFileRead(options(), guard => downloadQqFile('http://files.example/1', '预算.xlsx', guard,
    async () => { authorized++; return true }, { lookup: async () => { lookups++; return [{ address: '8.8.8.8', family: 4 }] },
      request: async () => { requests++; return { redirect: `http://files.example/${requests + 1}` } },
    }))
  assert.equal(result, undefined)
  assert.equal(requests, 4)
  assert.equal(lookups, 4)
  assert.equal(authorized, 8)
})

test('group_upload notice never manufactures a messageId or regular message event', { timeout: 5000 }, async t => {
  const f = await fixture(t)
  f.peer().send(JSON.stringify({ post_type: 'notice', notice_type: 'group_upload', self_id: account.id, group_id: target.id,
    user_id: uploader, time: 1_800_000_000, file: file() }))
  await delay(30)
  assert.deepEqual(f.events, [])
})
