import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { archive } from './helpers/requesterArchiveFixture.mjs'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const load = name => import(pathToFileURL(path.join(release, 'dist/backend', name)).href)
const { createAgentRuntime, createAgentBindingDirectory } = await load('core/index.js')
const { conversationAddressKey } = await load('modules/runtime/domain/agentBindings.js')
const { connectAgentRedis, openAgentRedis, agentRedisPrefix } = await load('modules/runtime/infrastructure/agentRedis.js')
const { createAgentTorrentLedger, agentTorrentId } = await load('modules/media/infrastructure/agentTorrentLedger.js')
const { createAgentInbox } = await load('modules/runtime/infrastructure/agentInbox.js')
const magnet = `magnet:?xt=urn:btih:${'A'.repeat(40)}`
const metadata = { infoHash: 'A'.repeat(40), fingerprint: 'b'.repeat(64), name: '素材', totalBytes: 4,
  files: [{ index: 1, relativePath: ['素材', '第一.txt'], size: 2 }, { index: 2, relativePath: ['素材', '第二.txt'], size: 2 }] }
const prepared = () => ({ status: 'ready', metadata: structuredClone(metadata), archive: archive() })
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve }); return { promise, release } }
async function waitFor(probe, label, timeout = 7000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await probe(); if (value) return value; await delay(10) }
  assert.fail(`timed out: ${label}`)
}

async function fixture(t, settings = {}) {
  assert.equal(spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status, 0)
  const directory = await mkdtemp(path.join(tmpdir(), 'core-torrent-')), socket = path.join(directory, 'redis.sock')
  const server = spawn('redis-server', ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' }), exited = once(server, 'exit')
  let reader, connection, host, current = true, enabled = true
  t.after(async () => { settings.release?.(); await host?.stop(); await connection?.close(); if (reader?.isOpen) await reader.close();
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM'); await exited; await rm(directory, { recursive: true, force: true }) })
  await waitFor(() => stat(socket).then(() => true, () => false), 'Redis ready')
  reader = await connectAgentRedis(`unix://${socket}`)
  connection = await openAgentRedis({ url: `unix://${socket}`, instance: 'torrent-runtime', onLost() {} })
  const storage = new Proxy(connection.storage, { get(target, property) {
    if (property === 'eval') return (script, input) => settings.eval ? settings.eval(script, input, () => target.eval(script, input)) : target.eval(script, input)
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
  } }),
    prefix = agentRedisPrefix('torrent-runtime'), now = Date.now()
  const accounts = ['robot-a', 'robot-b'].map((id, i) => ({ platform: 'fixture', namespace: settings.siblings ? 'same' : `ns-${i}`, id }))
  const targets = accounts.map(account => ({ account, kind: 'group', id: 'room' })), target = targets[0], sender = { ...accounts[0], id: 'human' }
  const config = { version: 1, agents: [{ id: 'role', personaId: 'default' }, { id: 'replacement', personaId: 'default' }],
    connections: accounts.map((account, i) => ({ id: `conn-${i}`, platform: account.platform, namespace: account.namespace, accountId: account.id })),
    bindings: targets.map((value, i) => ({ connectionId: `conn-${i}`, kind: 'group', conversationId: value.id, agentId: 'role' })) }
  let bindings = createAgentBindingDirectory(config, 'torrent-initial')
  const accepts = new Map(), ready = new Set(), sources = new Map(), calls = [], preparations = [], requests = [], logs = []
  const key = (selected, id) => JSON.stringify([conversationAddressKey(selected), id]), ledger = createAgentTorrentLedger(storage)
  const section = { enabled: true, reflection: { enabled: false }, rhythm: { enabled: false }, mood: { enabled: false }, personProfile: { enabled: false },
    meme: { enabled: false }, userStyle: { enabled: false }, lifeThreads: { enabled: false }, wake: { probability: 0, proactiveProbability: 0, batchWindowMs: 1000 },
    turn: { minSendGapMs: 0 }, toolPolicy: { mode: 'open' } }
  const deliver = async (stage, action, guard) => {
    assert.equal(guard.isCurrent(), true)
    const rows = (await ledger.listActive()).filter(row => row.binding.connectionId === action.binding.connectionId && row.stages.at(-1)?.state === 'pending')
    assert.equal(rows.length, 1, 'durable pending must precede every native effect')
    calls.push({ stage, action: structuredClone(action), guard })
    return settings.deliver ? settings.deliver(stage, action, guard, f) : stage === 'archive' ? { state: 'uploaded', fileId: `zip-${calls.length}` } : { state: 'sent', messageId: `sent-${calls.length}` }
  }
  const adapters = accounts.map((account, i) => ({ id: `conn-${i}`, account, botUserId: account.id, botName: '磁链验收机器人', isReady: () => ready.has(account.id),
    async start(accept) { ready.add(account.id); accepts.set(account.id, accept) }, stop() { ready.delete(account.id) },
    async readMessage(selected, id, guard) { await settings.read?.(selected, id, guard, f); if (guard?.isCurrent?.() === false) return;
      return structuredClone(sources.get(key(selected, id))) },
    actions: { send: (action, guard) => deliver('text', action, guard), sendBundle: (action, guard) => deliver('listing', action, guard),
      sendRequesterArchive: (action, guard) => deliver('archive', action, guard) } }))
  const makeHost = () => createAgentRuntime({ storage, adapters, now: () => now, isExecutionCurrent: () => connection.isCurrent() && current,
    useTextGroup: () => settings.mode === 'text', history: { enabled: true }, torrentDownload: { enabled: settings.enabled !== false }, isTorrentDownloadCurrent: () => enabled,
    torrentProvider: { async prepare(value, selection, context) { preparations.push({ magnet: value, selection: structuredClone(selection), context });
      return settings.prepare ? settings.prepare(value, selection, context, f) : prepared() } },
    ...(settings.mediaRelay ? { mediaRelay: { enabled: true }, mediaRelayProvider: { async prepare() { throw Error('No Bili source expected') } } } : {}),
    ...(settings.allowsText ? { allowsText: settings.allowsText } : {}),
    logger: { info() {}, warn(...args) { logs.push(args.map(String).join(' ')) }, error(...args) { logs.push(args.map(String).join(' ')) } },
    getSection: () => section, getExecutionConfig: () => ({ providers: 'openai', useTools: true }),
    resolvePersona(selected) { const binding = bindings.resolve(selected); return binding && { binding, persona: { name: '搬运角色' }, systemContent: '' } },
    async YTapi(request) { requests.push(request); return { choices: [{ message: { content: '' } }] } } })
  const f = { storage, reader, prefix, target, targets, accounts, sender, now, ready, calls, preparations, requests, ledger, logs,
    get host() { return host }, binding(selected = target) { return bindings.resolve(selected) },
    message(overrides = {}) { return { version: 1, conversation: target, sender, messageId: 'source', occurredAt: now, text: magnet,
      parts: [{ kind: 'text', text: magnet }], mentions: [], directedToAccount: false, ...overrides } },
    store(message) { sources.set(key(message.conversation, message.messageId), structuredClone(message)) },
    async emit(message = f.message()) { f.store(message); await accepts.get(message.conversation.account.id)({ kind: 'message', message: structuredClone(message) }) },
    async recall(id = 'source', selected = target) { await accepts.get(selected.account.id)({ kind: 'recall', target: selected, messageId: id }) },
    async record(id = 'source', binding = f.binding()) { return ledger.inspect(agentTorrentId(binding, { messageId: id, sender, occurredAt: now })) },
    async terminal(id = 'source', binding = f.binding()) { return waitFor(async () => { const row = await f.record(id, binding); return ['completed', 'awaiting-selection', 'unknown', 'failed', 'cancelled'].includes(row?.state) && row }, `terminal ${id}`) },
    async drain() { await waitFor(async () => { for (const name of await reader.keys(prefix + 'agent:inbox:*')) if (await reader.type(name) === 'list' && await reader.lLen(name)) return false; return true }, 'inbox ACK'); await host.runtime.drain() },
    async restart() { await host.stop(); host = makeHost(); await host.start() },
    rebind() { bindings = createAgentBindingDirectory({ ...config, bindings: config.bindings.map(row => ({ ...row, agentId: 'replacement' })) }, 'torrent-rebound') },
    revoke() { enabled = false }, loseLease() { current = false },
  }
  host = makeHost(); await host.start(); return f
}

for (const mode of ['simulation', 'text']) test(`Core ${mode}: group magnet produces ZIP for verified original requester without private binding`, { timeout: 20000 }, async t => {
  const f = await fixture(t, { mode }); await f.emit(); await f.drain(); assert.equal((await f.terminal()).state, 'completed')
  assert.deepEqual(f.calls.map(row => row.stage), ['text', 'archive', 'text']); const upload = f.calls[1].action
  assert.deepEqual(upload.target, f.target); assert.deepEqual(upload.source, { messageId: 'source', sender: f.sender, occurredAt: f.now,
    textSha256: createHash('sha256').update(magnet).digest('hex') })
  assert.equal(upload.archive.mime, 'application/zip'); assert.equal(f.preparations.length, 1); assert.equal(f.requests.length, 0)
  await f.emit(); await f.drain(); await f.restart(); await f.emit(); await f.drain(); assert.equal(f.preparations.length, 1)
  const stored = []
  for (const name of await f.reader.keys(f.prefix + 'agent:torrent:*')) { const type = await f.reader.type(name); if (type === 'string') stored.push(await f.reader.get(name)) }
  assert.ok(!stored.join('\n').includes(upload.archive.base64), 'binary ZIP is not persisted in the workflow ledger')
})

test('Core list then exact original-person selection rechecks fingerprint and completes private ZIP', { timeout: 20000 }, async t => {
  const f = await fixture(t, { prepare: async (_magnet, selection) => selection ? prepared() : { status: 'selection-required', metadata, selectableIndexes: [1, 2] } })
  await f.emit(); await f.drain(); assert.equal((await f.terminal()).state, 'awaiting-selection')
  assert.equal(f.calls.filter(row => row.stage === 'archive').length, 0)
  await f.emit(f.message({ messageId: 'choice', text: '下载 2', parts: [{ kind: 'text', text: '下载 2' }] })); await f.drain()
  assert.equal((await f.terminal('choice')).state, 'completed')
  assert.deepEqual(f.preparations[1].selection, { indexes: [2], expectedFingerprint: metadata.fingerprint })
  assert.equal(f.calls.filter(row => row.stage === 'archive').length, 1); assert.equal(f.requests.length, 0)
})

test('Core invalid selection cannot become a fresh whole-torrent download', { timeout: 20000 }, async t => {
  const f = await fixture(t, { prepare: async () => ({ status: 'selection-required', metadata, selectableIndexes: [1] }) })
  await f.emit(); await f.drain(); await f.terminal()
  await f.emit(f.message({ messageId: 'bad-choice', text: '下载 99' })); await f.drain(); assert.equal((await f.terminal('bad-choice')).state, 'failed')
  assert.equal(f.preparations.length, 1); assert.equal(f.calls.filter(row => row.stage === 'archive').length, 0)
  assert.ok(await f.ledger.readSelection(f.binding(), f.sender))
})

for (const stage of ['notice', 'archive', 'confirmation']) test(`Core unknown ${stage} freezes duplicate and restart without a resend`, { timeout: 20000 }, async t => {
  let textCount = 0
  const f = await fixture(t, { deliver: async (kind) => {
    if (kind === 'text') textCount++
    if (kind === 'archive' && stage === 'archive' || kind === 'text' && textCount === (stage === 'notice' ? 1 : 2)) return { state: 'unknown' }
    return kind === 'archive' ? { state: 'uploaded', fileId: 'zip-proof' } : { state: 'sent', messageId: `text-${textCount}` }
  } })
  await f.emit(); await f.drain(); assert.equal((await f.terminal()).state, 'unknown'); const count = f.calls.length
  await f.restart(); await f.emit(); await f.drain(); assert.equal(f.calls.length, count)
})

for (const event of ['recall', 'rebind', 'disable', 'lease', 'stop', 'source-change']) test(`Core ${event} fences a queued provider result before private upload`, { timeout: 20000 }, async t => {
  const blocker = gate(), entered = gate()
  const f = await fixture(t, { release: blocker.release, prepare: async (_value, _selection, _context) => { entered.release(); await blocker.promise; return prepared() } })
  await f.emit(); await f.drain(); await entered.promise
  assert.equal((await f.record()).stages[0].state, 'sent', 'inbox ACK occurs after durable claim while provider remains in background')
  if (event === 'recall') await f.recall()
  else if (event === 'rebind') f.rebind()
  else if (event === 'disable') f.revoke()
  else if (event === 'lease') f.loseLease()
  else if (event === 'source-change') f.store(f.message({ text: `magnet:?xt=urn:btih:${'C'.repeat(40)}` }))
  const stopping = event === 'stop' ? f.host.stop() : undefined
  blocker.release(); await stopping
  await waitFor(() => f.preparations[0].context.signal.aborted || f.calls.some(row => row.stage === 'archive'), 'cancel provider scope')
  assert.equal(f.calls.filter(row => row.stage === 'archive').length, 0)
})

test('Core sibling accounts admit one physical group source and share recall fencing', { timeout: 20000 }, async t => {
  const f = await fixture(t, { siblings: true })
  for (const target of f.targets) await f.emit(f.message({ conversation: target }))
  await f.drain(); await waitFor(() => f.calls.some(row => row.stage === 'archive'), 'responsible account upload')
  assert.equal(f.preparations.length, 1); assert.equal(f.calls.filter(row => row.stage === 'archive').length, 1)
})

test('Core explicitly failed private upload reports failure without group ZIP or success confirmation', { timeout: 20000 }, async t => {
  const f = await fixture(t, { deliver: async (stage, _action, _guard, state) => stage === 'archive' ? { state: 'failed', code: 'permission_denied' } : { state: 'sent', messageId: `msg-${state.calls.length}` } })
  await f.emit(); await f.drain(); assert.equal((await f.terminal()).state, 'failed')
  assert.deepEqual(f.calls.map(row => row.stage), ['text', 'archive', 'text'])
  assert.match(f.calls.at(-1).action.parts[0].text, /查询编号：[a-f\d-]+/u)
  assert.equal(f.requests.length, 1, 'failed upload asks the model once before using the query-reference fallback')
})

test('Core rejects a known-secret archive filename before adapter upload', { timeout: 20000 }, async t => {
  const f = await fixture(t, { allowsText: text => !text.includes('HOST_SECRET'), prepare: async () => { const value = prepared(); value.archive.name = 'HOST_SECRET.zip'; return value } })
  await f.emit(); await f.drain(); assert.equal((await f.terminal()).state, 'failed'); assert.equal(f.calls.filter(row => row.stage === 'archive').length, 0)
})

test('a failing sibling media ledger cannot prevent torrent and inbox recall fencing', { timeout: 20000 }, async t => {
  const blocker = gate(), entered = gate(); let failMediaCancel = false
  const f = await fixture(t, { mediaRelay: true, release: blocker.release,
    eval: async (_script, input, run) => { if (failMediaCancel && input.keys.some(key => key.startsWith('agent:media-outbox:'))) throw Error('synthetic media storage outage'); return run() },
    prepare: async () => { entered.release(); await blocker.promise; return prepared() } })
  await f.emit(); await f.drain(); await entered.promise; failMediaCancel = true
  await assert.rejects(f.recall(), /synthetic|媒体/u)
  blocker.release(); await waitFor(() => f.preparations[0].context.signal.aborted, 'torrent revoked despite sibling storage failure')
  assert.equal(f.calls.filter(row => row.stage === 'archive').length, 0)
  assert.equal(await createAgentInbox(f.storage).isRecalled(f.target, 'source'), true)
})
