import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const { createAgentTorrentWorkflow } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/media/infrastructure/agentTorrentWorkflow.js')).href)
const { agentTorrentId } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/media/infrastructure/agentTorrentLedger.js')).href)
const { connectAgentRedis, openAgentRedis, agentRedisPrefix } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/runtime/infrastructure/agentRedis.js')).href)
const { conversationAddressKey } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/runtime/domain/agentBindings.js')).href)
const { parseAgentTorrentMagnet } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/media/domain/agentTorrent.js')).href)
const hash = 'A'.repeat(40), fingerprint = 'b'.repeat(64), magnet = `magnet:?xt=urn:btih:${hash}&dn=Original%20Magnet`
const info = { infoHash: hash, fingerprint, name: 'bundle', files: [
  { index: 1, relativePath: ['bundle', 'one.bin'], size: 20000000 },
  { index: 2, relativePath: ['bundle', 'two.bin'], size: 40000000 },
], totalBytes: 60000000 }
// A complete, uncompressed synthetic ZIP; downloader and archive verification have their own integration tests.
const zipName = Buffer.from('data.txt'), payload = Buffer.from('synthetic torrent payload')
let crc = 0xffffffff
for (const byte of payload) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? crc >>> 1 ^ 0xedb88320 : crc >>> 1 }
crc = (crc ^ 0xffffffff) >>> 0
const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22)
local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14)
local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(payload.length, 22); local.writeUInt16LE(zipName.length, 26)
central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16)
central.writeUInt32LE(payload.length, 20); central.writeUInt32LE(payload.length, 24); central.writeUInt16LE(zipName.length, 28)
end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10)
end.writeUInt32LE(central.length + zipName.length, 12); end.writeUInt32LE(local.length + zipName.length + payload.length, 16)
const zip = Buffer.concat([local, zipName, payload, central, zipName, end])
const archive = { name: 'synthetic-content.zip', mime: 'application/zip', base64: zip.toString('base64') }
const sent = messageId => ({ state: 'sent', messageId })
const uploaded = { state: 'uploaded', fileId: 'zip-file', messageId: 'private-message' }
const ready = metadata => ({ status: 'ready', metadata: metadata || info, archive })
const selection = metadata => ({ status: 'selection-required', metadata: metadata || info, selectableIndexes: [1, 2] })
const callText = call => (call.action.items ? call.action.items.flatMap(item => item.parts) : call.action.parts).map(part => part.text || '').join('')
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve }); return { promise, release } }
async function waitFor(check, description, timeout = 6000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const result = await check(); if (result) return result; await delay(10) }
  assert.fail(`timed out: ${description}`)
}
async function fixture(t, settings = {}) {
  assert.equal(spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status, 0, 'workflow evidence requires actual Redis')
  const directory = await mkdtemp(path.join(tmpdir(), 'torrent-workflow-')), socket = path.join(directory, 'redis.sock')
  const server = spawn('redis-server', ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' }), exited = once(server, 'exit')
  let reader, connection, clock = 1800000000000, workflow, current = true, waiting = false, evalHook, prepareHook, readHook, sendHook, openHook
  const runners = [], messages = new Map(), calls = [], preparations = [], reads = [], opens = [], releases = []
  t.after(async () => {
    settings.release?.(); await Promise.allSettled(runners.map(runner => runner.stop()))
    await connection?.close(); if (reader?.isOpen) await reader.close()
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM')
    await exited; await rm(directory, { recursive: true, force: true })
  })
  await waitFor(() => stat(socket).then(() => true, () => false), 'Redis ready')
  reader = await connectAgentRedis(`unix://${socket}`)
  connection = await openAgentRedis({ url: `unix://${socket}`, instance: 'torrent-workflow', onLost() {} })
  const prefix = agentRedisPrefix('torrent-workflow'), originalStorage = connection.storage
  const storage = { get: originalStorage.get.bind(originalStorage), eval: (script, options) => evalHook ? evalHook(script, options, () => originalStorage.eval(script, options)) : originalStorage.eval(script, options) }
  const account = { platform: 'fixture', namespace: 'global', id: 'robot-a' }, target = { account, kind: 'group', id: 'room-1' }
  const binding = { source: 'configured', id: conversationAddressKey(target), revision: 'revision-1', agentId: 'role', personaId: 'default', connectionId: 'conn-a', target }
  const sender = { ...account, id: 'human' }, key = (selected, id) => JSON.stringify([conversationAddressKey(selected), id])
  const source = message => ({ messageId: message.messageId, sender: message.sender, occurredAt: message.occurredAt })
  const makeContext = (record, external) => {
    const local = new AbortController(), signal = AbortSignal.any([external, local.signal])
    const active = () => current && !signal.aborted
    return { signal, isCurrent: active, async ensureCurrent() { if (!active()) throw new Error('fixture source revoked') },
      async read(id, expected) {
        reads.push({ id, expected, record }); if (readHook) await readHook(id, expected, record, f)
        if (!active()) return undefined
        return structuredClone(messages.get(key(record.binding.target, id)))
      }, release() { releases.push(record.trigger.messageId); local.abort() } }
  }
  async function deliver(action, guard, method) {
    const records = await workflow.ledger.listActive(), pending = records.filter(record => record.stages.at(-1)?.state === 'pending' &&
      conversationAddressKey(record.binding.target) === conversationAddressKey(action.target))
    assert.equal(pending.length, 1, 'pending marker must be durable before every native action')
    const record = pending[0], stage = record.stages.at(-1).stage
    assert.equal(guard.isCurrent(), true)
    if (method === 'text') assert.ok(action.parts.every(part => part.kind !== 'text' || part.text.length <= 4000), 'Core text action preserves 4000-character part bound')
    const call = { action: structuredClone(action), guard, stage, method, record }; calls.push(call)
    return sendHook ? sendHook(call, f) : stage === 'archive' ? uploaded : sent(`sent-${calls.length}`)
  }
  function create() {
    workflow = createAgentTorrentWorkflow({ storage, config: { enabled: settings.enabled !== false }, now: () => clock,
      actions: { send: (action, guard) => deliver(action, guard, 'text'), ...(settings.bundle === false ? {} : { sendBundle: (action, guard) => deliver(action, guard, 'bundle') }),
        sendRequesterArchive: (action, guard) => deliver(action, guard, 'archive') },
      provider: { async prepare(selected, selectedFiles, context) {
        const call = { magnet: selected, selectedFiles: structuredClone(selectedFiles), context }; preparations.push(call)
        return prepareHook ? prepareHook(call, f) : ready()
      } },
      ...(settings.render ? { renderListing: settings.render } : {}), isCurrent: () => current,
      responsible: () => true,
      async openContext(record, signal) {
        opens.push(record)
        const factory = () => makeContext(record, signal)
        return openHook ? openHook(record, signal, factory, f) : waiting ? 'wait' : factory()
      },
    })
    runners.push(workflow); return workflow
  }
  const f = { reader, storage, prefix, account, target, binding, sender, calls, preparations, reads, opens, releases, runners, source,
    get workflow() { return workflow }, get now() { return clock }, advance(ms) { clock += ms }, create,
    setPrepare(hook) { prepareHook = hook }, setRead(hook) { readHook = hook }, setSend(hook) { sendHook = hook }, setOpen(hook) { openHook = hook }, setEval(hook) { evalHook = hook },
    setCurrent(value) { current = value }, setWaiting(value) { waiting = value },
    message(id = 'original-source', text = magnet, overrides = {}) { return { version: 1, conversation: target, sender, messageId: id, occurredAt: clock,
      text, parts: [{ kind: 'text', text }], mentions: [], directedToAccount: false, ...overrides } },
    store(message) { messages.set(key(message.conversation, message.messageId), structuredClone(message)); return message },
    async emit(message = f.message(), selected = binding) { f.store(message); return workflow.handle(message, selected) },
    async record(message = f.message(), selected = binding) { return workflow.ledger.inspect(agentTorrentId(selected, source(message))) },
    async terminal(message = f.message(), selected = binding) { return waitFor(async () => {
      await workflow.tick(); const record = await f.record(message, selected)
      return record && ['awaiting-selection', 'completed', 'failed', 'cancelled', 'unknown'].includes(record.state) ? record : undefined
    }, `terminal ${message.messageId}`) },
    async pending() { return waitFor(() => workflow.ledger.readSelection(binding, sender), 'selection ready') },
    async restart() { await workflow.stop(); create(); await workflow.start() },
    async idle() { await delay(40); await workflow.tick(); await delay(20) },
  }
  create(); await workflow.start(); return f
}

test('initial exact magnet reaches private ZIP upload before group confirmation and never replays after restart', { timeout: 15000 }, async t => {
  const f = await fixture(t), message = f.message()
  assert.equal(await f.emit(message), true)
  assert.equal((await f.terminal(message)).state, 'completed')
  assert.deepEqual(f.calls.map(row => row.stage), ['notice', 'archive', 'confirmation'])
  assert.equal(f.preparations.length, 1); assert.equal(f.preparations[0].magnet, magnet); assert.equal(f.preparations[0].selectedFiles, undefined)
  const upload = f.calls.find(row => row.stage === 'archive').action
  assert.equal(upload.kind, 'requester-archive.upload'); assert.deepEqual(upload.source, { ...f.source(message), textSha256: createHash('sha256').update(message.text).digest('hex') }); assert.deepEqual(upload.binding, f.binding)
  assert.deepEqual(upload.target, f.target); assert.deepEqual(upload.archive, archive)
  assert.ok(f.reads.length >= 5)
  await f.emit(message); await f.restart(); await f.emit(message); await f.idle()
  assert.equal(f.calls.length, 3); assert.equal(f.preparations.length, 1)
  const raw = await f.reader.get(f.prefix + 'agent:torrent:v1:job:' + agentTorrentId(f.binding, f.source(message)))
  for (const value of [magnet, archive.base64, archive.name, 'one.bin', fingerprint]) assert.equal(raw.includes(value), false)
})

test('an over-limit listing is complete and only the same person in the original group can select and privately receive ZIP', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  f.setPrepare(call => call.selectedFiles ? ready() : selection())
  const original = f.message(); await f.emit(original); assert.equal((await f.terminal(original)).state, 'awaiting-selection')
  const pending = await f.pending(), listing = callText(f.calls.find(row => row.stage === 'listing'))
  assert.match(listing, /1｜可下载｜one\.bin｜20000000 B/u); assert.match(listing, /2｜可下载｜two\.bin｜40000000 B/u)
  assert.equal(await f.emit(f.message('impostor', '下载 1', { sender: { ...f.sender, id: 'other-human' } })), false)
  const otherTarget = { ...f.target, id: 'other-room' }, otherBinding = { ...f.binding, target: otherTarget, id: conversationAddressKey(otherTarget) }
  assert.equal(await f.emit(f.message('other-room-choice', '下载 1', { conversation: otherTarget }), otherBinding), false)
  const chosen = f.message('select', '下载 2'); assert.equal(await f.emit(chosen), true)
  assert.equal((await f.terminal(chosen)).state, 'completed')
  assert.deepEqual(f.preparations[1].selectedFiles, { indexes: [2], expectedFingerprint: pending.metadata.fingerprint })
  assert.equal(f.calls.filter(row => row.stage === 'archive').length, 1)
  assert.equal(await f.workflow.ledger.readSelection(f.binding, f.sender), undefined)
  await f.emit(chosen); await f.idle(); assert.equal(f.preparations.length, 2)
})

test('invalid selection cannot become a whole-torrent download and preserves the original listing for a corrected choice', { timeout: 15000 }, async t => {
  const f = await fixture(t); f.setPrepare(call => call.selectedFiles ? ready() : selection())
  await f.emit(); await f.pending()
  const invalid = f.message('bad-selection', '下载 2048')
  assert.equal(await f.emit(invalid), true); assert.equal((await f.terminal(invalid)).state, 'failed')
  assert.equal(f.preparations.length, 1); assert.equal(f.calls.filter(call => call.stage === 'archive').length, 0)
  assert.ok(await f.workflow.ledger.readSelection(f.binding, f.sender))
  const corrected = f.message('corrected', '下载 one.bin'); await f.emit(corrected)
  assert.equal((await f.terminal(corrected)).state, 'completed'); assert.deepEqual(f.preparations[1].selectedFiles.indexes, [1])
})

test('a selected preparation returning another raw metadata fingerprint never uploads or consumes the original listing', { timeout: 15000 }, async t => {
  const f = await fixture(t); f.setPrepare(call => call.selectedFiles ? ready({ ...info, fingerprint: 'c'.repeat(64) }) : selection())
  await f.emit(); await f.pending()
  const chosen = f.message('select', '下载 1'); await f.emit(chosen)
  const result = await f.terminal(chosen)
  assert.equal(result.state, 'failed'); assert.equal(f.calls.filter(row => row.stage === 'archive').length, 0)
  assert.ok(await f.workflow.ledger.readSelection(f.binding, f.sender))
})

for (const stage of ['notice', 'listing', 'archive', 'confirmation', 'failure']) test(`${stage} unknown freezes every downstream effect and survives duplicate input plus restart`, { timeout: 15000 }, async t => {
  const f = await fixture(t)
  f.setPrepare(() => stage === 'listing' ? selection() : stage === 'failure' ? Promise.reject(new Error('synthetic provider failure')) : ready())
  f.setSend(call => call.stage === stage ? { state: 'unknown' } : call.stage === 'archive' ? uploaded : sent(`sent-${f.calls.length}`))
  const message = f.message(); await f.emit(message)
  assert.equal((await f.terminal(message)).state, 'unknown')
  const at = f.calls.findIndex(row => row.stage === stage)
  assert.equal(at, f.calls.length - 1, 'no effect follows unknown')
  const count = f.calls.length; await f.emit(message); await f.restart(); await f.emit(message); await f.idle()
  assert.equal(f.calls.length, count)
})

test('recall cancels an uncooperative preparation and ignores late ZIP before any upload', { timeout: 15000 }, async t => {
  const hold = gate(), f = await fixture(t, { release: hold.release })
  f.setPrepare(async () => { await hold.promise; return ready() })
  const message = f.message(); await f.emit(message); await waitFor(() => f.preparations.length === 1, 'preparation started')
  await f.workflow.cancelSource(f.target, message.messageId)
  assert.equal(f.preparations[0].context.signal.aborted, true)
  hold.release(); await f.terminal(message); await f.idle()
  assert.equal(f.calls.filter(row => row.stage === 'archive' || row.stage === 'confirmation').length, 0)
})

for (const field of ['sender', 'occurredAt', 'magnet', 'selection-source']) test(`reread ${field} change cancels before archive and cannot reauthorize from the current selection`, { timeout: 15000 }, async t => {
  const hold = gate(), f = await fixture(t, { release: hold.release })
  if (field === 'selection-source') {
    f.setPrepare(call => call.selectedFiles ? hold.promise.then(() => ready()) : selection())
    await f.emit(); await f.pending()
  } else f.setPrepare(async () => { await hold.promise; return ready() })
  const message = field === 'selection-source' ? f.message('select', '下载 1') : f.message()
  await f.emit(message); await waitFor(() => f.preparations.length === (field === 'selection-source' ? 2 : 1), 'held preparation')
  const changed = f.message()
  if (field === 'sender') changed.sender = { ...f.sender, id: 'substituted-human' }
  if (field === 'occurredAt') changed.occurredAt--
  if (field === 'magnet' || field === 'selection-source') changed.text = `magnet:?xt=urn:btih:${'D'.repeat(40)}`
  f.store(changed); hold.release(); await f.terminal(message)
  assert.equal(f.calls.filter(row => row.stage === 'archive').length, 0)
})

test('a changed source body with the exact same magnet aborts preparation before private archive upload', { timeout: 15000 }, async t => {
  const hold = gate(), f = await fixture(t, { release: hold.release })
  f.setPrepare(async () => { await hold.promise; return ready() })
  const original = f.message('original-source', `原始请求\n${magnet}`)
  await f.emit(original); await waitFor(() => f.preparations.length === 1, 'held preparation')
  const changed = f.message(original.messageId, `更新后的请求\n${magnet}`)
  assert.notEqual(changed.text, original.text)
  assert.equal(parseAgentTorrentMagnet(changed.text), parseAgentTorrentMagnet(original.text))
  f.store(changed); hold.release()
  // The notice already has a native receipt, so cancellation conservatively freezes this attempt.
  assert.equal((await f.terminal(original)).state, 'unknown')
  assert.equal(f.preparations[0].context.signal.aborted, true)
  assert.equal(f.calls.filter(row => row.stage === 'archive' || row.stage === 'confirmation').length, 0)
})

test('queued initial and reserved selection jobs recover from Redis with source rereads and original fingerprint', { timeout: 20000 }, async t => {
  const f = await fixture(t), original = f.store(f.message())
  f.setPrepare(call => call.selectedFiles ? ready() : selection())
  const initial = await f.workflow.ledger.claim(f.binding, f.source(original)); await initial.preparing(); initial.abandon()
  await f.restart(); await f.pending()
  const chosen = f.store(f.message('select', '下载 1'))
  const reservation = await f.workflow.ledger.reserveSelection(f.binding, f.source(chosen)); await reservation.session.preparing(); reservation.session.abandon()
  await f.restart(); assert.equal((await f.terminal(chosen)).state, 'completed')
  assert.deepEqual(f.preparations.map(row => row.selectedFiles), [undefined, { indexes: [1], expectedFingerprint: fingerprint }])
  assert.equal(f.calls.filter(row => row.stage === 'archive').length, 1)
})

test('a claim committed as stop begins remains queued and recoverable without an old task using a new context', { timeout: 15000 }, async t => {
  const f = await fixture(t), hold = gate(), entered = gate()
  t.after(() => hold.release())
  let armed = true
  f.setEval(async (script, options, execute) => {
    const result = await execute()
    if (armed && script.includes('local admission =')) { armed = false; entered.release(); await hold.promise }
    return result
  })
  const original = f.message(), admission = f.emit(original)
  await entered.promise; await f.workflow.stop(); hold.release(); assert.equal(await admission, true)
  assert.equal((await f.record(original)).state, 'queued'); assert.equal(f.calls.length, 0)
  f.setEval(undefined); f.create(); await f.workflow.start()
  assert.equal((await f.terminal(original)).state, 'completed'); assert.equal(f.calls.filter(row => row.stage === 'archive').length, 1)
})

test('a full text listing is split within native text bounds and retains every listed file', { timeout: 15000 }, async t => {
  const f = await fixture(t), files = Array.from({ length: 90 }, (_, offset) => ({ index: offset + 1, relativePath: ['bundle', `file-${offset}-` + 'x'.repeat(50)], size: 1000000 }))
  f.setPrepare(() => ({ status: 'selection-required', metadata: { ...info, files, totalBytes: 90000000 }, selectableIndexes: files.map(file => file.index) }))
  await f.emit(); const record = await f.terminal()
  assert.equal(record.state, 'awaiting-selection')
  const listing = f.calls.filter(row => row.stage === 'listing').map(callText).join('')
  for (const file of files) assert.ok(listing.includes(file.relativePath[1]), `complete file ${file.index}`)
  assert.equal((await f.pending()).metadata.files.length, 90)
})

for (const bundle of [true, false]) test(`a complete 2048-file catalogue publishes only after every ${bundle ? 'bundle' : 'text'} batch is sent`, { timeout: 20000 }, async t => {
  const f = await fixture(t, { bundle }), files = Array.from({ length: 2048 }, (_, offset) => ({ index: offset + 1,
    relativePath: ['bundle', `file-${offset}-` + 'x'.repeat(50)], size: 1 }))
  f.setPrepare(() => ({ status: 'selection-required', metadata: { ...info, files, totalBytes: 2048 }, selectableIndexes: files.map(file => file.index) }))
  let pages = 0
  f.setSend(async call => {
    if (call.stage === 'listing') {
      pages++
      assert.equal(await f.workflow.ledger.readSelection(f.binding, f.sender), undefined, 'even the final pending page cannot be selected before its receipt')
      if (call.action.items) for (const item of call.action.items) for (const part of item.parts) if (part.kind === 'text') assert.ok(part.text.length <= 4000)
    }
    return sent(`page-${f.calls.length}`)
  })
  await f.emit(); assert.equal((await f.terminal()).state, 'awaiting-selection')
  assert.ok(pages > 1); assert.equal((await f.pending()).listingParts, pages)
  const text = f.calls.filter(row => row.stage === 'listing').map(callText).join('')
  for (const file of files) assert.ok(text.includes(file.relativePath[1]), `retained file ${file.index}`)
})

test('an unknown middle catalogue page never publishes a partial selectable session or sends later pages', { timeout: 15000 }, async t => {
  const f = await fixture(t), files = Array.from({ length: 1200 }, (_, offset) => ({ index: offset + 1, relativePath: ['bundle', `file-${offset}-` + 'x'.repeat(50)], size: 1 }))
  f.setPrepare(() => ({ status: 'selection-required', metadata: { ...info, files, totalBytes: 1200 }, selectableIndexes: [1, 1200] }))
  let pages = 0
  f.setSend(call => call.stage === 'listing' && ++pages === 2 ? { state: 'unknown' } : sent(`sent-${f.calls.length}`))
  await f.emit(); assert.equal((await f.terminal()).state, 'unknown')
  assert.equal(pages, 2); assert.equal(await f.workflow.ledger.readSelection(f.binding, f.sender), undefined)
  assert.equal(await f.emit(f.message('later-selection', '下载 1')), false)
  await f.restart(); await f.idle(); assert.equal(pages, 2)
})

test('disabled workflow creates no ledger state or external work', async t => {
  const f = await fixture(t, { enabled: false })
  assert.equal(await f.emit(), false); await f.idle()
  assert.deepEqual(await f.reader.keys(f.prefix + 'agent:torrent:v1:*'), [])
  assert.equal(f.calls.length, 0); assert.equal(f.preparations.length, 0)
})
