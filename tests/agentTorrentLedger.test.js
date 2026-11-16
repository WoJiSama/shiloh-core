import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const { createAgentTorrentLedger, agentTorrentId } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/media/infrastructure/agentTorrentLedger.js')).href)
const { connectAgentRedis, openAgentRedis, agentRedisPrefix } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/runtime/infrastructure/agentRedis.js')).href)
const { conversationAddressKey } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/runtime/domain/agentBindings.js')).href)
const initialTime = 1800000000000, hash = 'A'.repeat(40), fingerprint = 'b'.repeat(64), magnet = `magnet:?xt=urn:btih:${hash}&dn=original-name`
const metadata = { infoHash: hash, fingerprint, name: 'bundle', files: [
  { index: 1, relativePath: ['bundle', 'one.bin'], size: 20000000 },
  { index: 2, relativePath: ['bundle', 'two.bin'], size: 40000000 },
], totalBytes: 60000000 }
const sent = messageId => ({ state: 'sent', messageId })
const uploaded = { state: 'uploaded', fileId: 'private-zip', messageId: 'private-message' }
const wrap = storage => ({ get: storage.get.bind(storage), eval: storage.eval.bind(storage) })
function binding(overrides = {}) {
  const account = { platform: 'fixture', namespace: 'global', id: 'robot-a', ...overrides.account }
  const target = { account, kind: 'group', id: overrides.group || 'room-1' }
  return { source: 'configured', id: conversationAddressKey(target), revision: 'revision-1', agentId: 'role', personaId: 'default', connectionId: 'conn-a', target,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !['account', 'group'].includes(key))) }
}
function source(messageId = 'original-source', overrides = {}) {
  return { messageId, sender: { platform: 'fixture', namespace: 'global', id: 'human' }, occurredAt: initialTime - 1000, ...overrides }
}
async function fixture(t) {
  assert.equal(spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status, 0, 'torrent ledger requires actual Redis')
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-torrent-ledger-')), socket = path.join(directory, 'redis.sock')
  const server = spawn('redis-server', ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' }), exited = once(server, 'exit')
  let reader, connection, now = initialTime
  t.after(async () => {
    await connection?.close(); if (reader?.isOpen) await reader.close()
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM')
    await exited; await rm(directory, { recursive: true, force: true })
  })
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await stat(socket).then(() => true, () => false)) break
    if (server.exitCode !== null) assert.fail('Redis exited before readiness')
    await delay(10)
  }
  reader = await connectAgentRedis(`unix://${socket}`)
  connection = await openAgentRedis({ url: `unix://${socket}`, instance: 'torrent-ledger', onLost() {} })
  const prefix = agentRedisPrefix('torrent-ledger'), storage = connection.storage
  const ledger = createAgentTorrentLedger(storage, { now: () => now })
  const f = { reader, storage, prefix, ledger, get now() { return now }, advance(ms) { now += ms },
    restart(selected = wrap(storage)) { return createAgentTorrentLedger(selected, { now: () => now }) },
    async claim(messageId = 'original-source', selected = binding(), original, inputSource) {
      const trigger = inputSource || source(messageId, { sender: { ...selected.target.account, id: 'human' } })
      const session = await ledger.claim(selected, trigger, original)
      assert.ok(session); return session
    },
    async selection(messageId = 'original-source', selected = binding(), options = {}) {
      const session = await f.claim(messageId, selected)
      await session.preparing(); await session.saveSelection({ magnet, metadata, selectableIndexes: [1, 2], ...options })
      assert.equal(await ledger.readSelection(selected, session.record.source.sender), undefined, 'pending listing cannot be selected')
      await session.begin('listing'); await session.finish('listing', sent(`listing-${messageId}`)); await session.close('awaiting-selection')
      return ledger.readSelection(selected, session.record.source.sender)
    },
    async persisted() {
      const values = []
      for (const key of (await reader.keys(prefix + 'agent:torrent:v1:*')).sort()) {
        const type = await reader.type(key)
        const value = type === 'string' ? await reader.get(key) : type === 'hash' ? await reader.hGetAll(key) : assert.fail(`uninspected Redis type ${type}`)
        values.push(JSON.stringify({ key, value }))
      }
      return values.join('\n')
    },
  }
  return f
}

test('torrent attempts claim once before effects, store immutable source ownership and preserve seven-day dedupe', async t => {
  const f = await fixture(t), selected = binding(), trigger = source()
  const results = await Promise.all(Array.from({ length: 16 }, () => f.ledger.claim(selected, trigger)))
  assert.equal(results.filter(Boolean).length, 1)
  const session = results.find(Boolean), id = agentTorrentId(selected, trigger)
  assert.equal(session.record.id, id); assert.deepEqual(session.record.source, trigger); assert.deepEqual(session.record.binding, selected)
  assert.deepEqual(session.record.stages, []); assert.equal(session.record.expiresAt - session.record.createdAt, 86400000)
  assert.ok(Object.isFrozen(session.record)); assert.ok(Object.isFrozen(session.record.binding.target.account))
  assert.throws(() => { session.record.source.sender.id = 'other-user' })
  await session.preparing(); await session.close('failed')
  assert.equal(await f.ledger.claim(selected, trigger), undefined)
  assert.deepEqual(await f.ledger.listActive(), [])
  const ttl = await f.reader.ttl(f.prefix + 'agent:torrent:v1:job:' + id)
  assert.ok(ttl > 604790 && ttl <= 604800)
})

test('shared automatic source admission prevents account and binding changes from bypassing sent or unknown attempts', async t => {
  for (const outcome of ['completed', 'unknown']) await t.test(outcome, async t => {
    const f = await fixture(t), first = await f.claim(); await first.preparing(); await first.begin('archive')
    await first.finish('archive', outcome === 'completed' ? uploaded : { state: 'unknown' })
    if (outcome === 'completed') await first.close('completed')
    const sibling = binding({ account: { id: 'robot-b' }, connectionId: 'conn-b' }), revision = binding({ revision: 'changed-revision' })
    assert.equal(await f.restart().claim(sibling, source()), undefined)
    assert.equal(await f.restart().claim(revision, source()), undefined)
    assert.equal(await f.ledger.inspect(agentTorrentId(sibling, source())), undefined)
    const fresh = await f.claim('new-human-message', sibling); await fresh.close('failed')
    assert.equal((await f.reader.keys(f.prefix + 'agent:torrent:v1:admission:*')).length, 2)
  })
})

test('source admission is isolated by platform, namespace, group and current message id', async t => {
  const f = await fixture(t), first = await f.claim()
  for (const selected of [binding({ group: 'room-2' }), binding({ account: { namespace: 'another' } }), binding({ account: { platform: 'another' } })]) {
    const trigger = source('original-source', { sender: { ...selected.target.account, id: 'human' } })
    const session = await f.claim('original-source', selected, undefined, trigger); await session.close('failed')
  }
  const extra = await f.claim('another-message'); await extra.close('failed'); await first.close('failed')
})

test('queued or preparation-only attempts recover, while live local ownership cannot be stolen', async t => {
  const f = await fixture(t), session = await f.claim(); await session.preparing()
  const peer = createAgentTorrentLedger(f.storage, { now: () => f.now })
  await peer.recover(); assert.equal((await peer.inspect(session.record.id)).state, 'preparing')
  assert.equal(await peer.claim(binding(), source()), undefined)
  session.abandon()
  const restarted = f.restart(); await restarted.recover()
  assert.equal((await restarted.inspect(session.record.id)).state, 'queued')
  const resumed = await restarted.claim(binding(), source()); assert.ok(resumed)
  await resumed.preparing(); await resumed.close('failed')
  await assert.rejects(session.begin('archive'))
})

test('restart freezes every native attempt, including known notice or upload interrupted before close', async t => {
  for (const [stage, receipt] of [['notice', undefined], ['notice', sent('notice')], ['archive', uploaded], ['archive', { state: 'failed', code: 'failed' }]]) await t.test(`${stage}-${receipt?.state ?? 'pending'}`, async t => {
    const f = await fixture(t), session = await f.claim(); await session.preparing(); await session.begin(stage)
    if (receipt) await session.finish(stage, receipt)
    session.abandon(); const restarted = f.restart(); await restarted.recover()
    const record = await restarted.inspect(session.record.id)
    assert.equal(record.state, 'unknown'); assert.equal(record.stages[0].state, receipt?.state ?? 'unknown')
    assert.equal(await restarted.claim(binding(), source()), undefined); assert.deepEqual(await restarted.listActive(), [])
  })
})

test('every native stage is pending durably first and receipts retain only closed safe evidence', async t => {
  const f = await fixture(t), session = await f.claim(); await session.preparing()
  for (const [stage, receipt] of [['notice', sent('notice-1')], ['archive', uploaded], ['confirmation', sent('confirmation-1')]]) {
    await session.begin(stage)
    const record = await f.ledger.inspect(session.record.id)
    assert.equal(record.stages.at(-1).state, 'pending'); assert.equal(record.stages.at(-1).receipt, undefined)
    await assert.rejects(session.begin(stage)); await session.finish(stage, receipt)
  }
  await session.close('completed')
  const failed = await f.claim('failed'); await failed.preparing(); await failed.begin('failure')
  await failed.finish('failure', { state: 'failed', code: '/private/provider-secret?token=SECRET' }); await failed.close('failed')
  assert.deepEqual(failed.record.stages[0].receipt, { state: 'failed', code: null })
  assert.equal((await f.persisted()).includes('provider-secret'), false)
})

test('selection publication is atomic with a sent listing and retains complete bounded metadata with a thirty-minute expiry', async t => {
  const f = await fixture(t), selected = await f.selection()
  assert.equal(selected.state, 'ready'); assert.equal(selected.magnet, magnet); assert.deepEqual(selected.metadata, metadata)
  assert.deepEqual(selected.selectableIndexes, [1, 2]); assert.equal(selected.expiresAt - selected.createdAt, 1800000)
  assert.ok(Object.isFrozen(selected.metadata.files)); assert.equal((await f.ledger.inspect(selected.id)).state, 'awaiting-selection')
  const [key] = await f.reader.keys(f.prefix + 'agent:torrent:v1:selection:*')
  const ttl = await f.reader.pTTL(key); assert.ok(ttl > 1799000 && ttl <= 1800000)
  assert.deepEqual((await f.restart().readSelection(binding(), source().sender)).metadata, metadata)
  f.advance(1800000); assert.equal(await f.ledger.readSelection(binding(), source().sender), undefined)
  assert.equal(await f.reader.get(key), null)
})

test('failed or unknown listing receipts never publish a usable selection', async t => {
  for (const receipt of [{ state: 'failed', code: 'blocked' }, { state: 'unknown' }]) await t.test(receipt.state, async t => {
    const f = await fixture(t), session = await f.claim(); await session.preparing()
    await session.saveSelection({ magnet, metadata, selectableIndexes: [1] }); await session.begin('listing'); await session.finish('listing', receipt)
    assert.equal(await f.ledger.readSelection(binding(), source().sender), undefined)
    assert.deepEqual(await f.reader.keys(f.prefix + 'agent:torrent:v1:selection:*'), [])
    if (receipt.state === 'unknown') { await assert.rejects(session.begin('failure')); await assert.rejects(session.close('failed')) }
  })
})

test('all durable listing parts must be sent before ready and interrupted batches never publish a partial catalogue', async t => {
  for (const outcome of ['sent', 'failed', 'unknown', 'restart']) await t.test(outcome, async t => {
    const f = await fixture(t), session = await f.claim(); await session.preparing()
    await session.saveSelection({ magnet, metadata, selectableIndexes: [1, 2], listingParts: 3 })
    await session.begin('listing'); await session.finish('listing', sent('first-page'))
    assert.equal(await f.ledger.readSelection(binding(), source().sender), undefined)
    await assert.rejects(session.close('awaiting-selection'))
    await session.begin('listing')
    if (outcome === 'restart') {
      session.abandon(); await f.restart().recover()
      assert.equal((await f.ledger.inspect(session.record.id)).state, 'unknown')
      assert.equal(await f.ledger.readSelection(binding(), source().sender), undefined)
      return
    }
    await session.finish('listing', outcome === 'sent' ? sent('second-page') : { state: outcome, ...(outcome === 'failed' ? { code: 'refused' } : {}) })
    assert.equal(await f.ledger.readSelection(binding(), source().sender), undefined)
    if (outcome !== 'sent') { await assert.rejects(session.begin('listing')); return }
    await session.begin('listing'); await session.finish('listing', sent('last-page'))
    assert.equal((await f.ledger.readSelection(binding(), source().sender)).listingParts, 3)
    await assert.rejects(session.begin('listing')); await session.close('awaiting-selection')
    assert.equal(session.record.stages.filter(row => row.stage === 'listing').length, 3)
  })
})

test('listing pagination has a closed maximum of 512 batches without silently trimming the catalogue', async t => {
  const f = await fixture(t), session = await f.claim(); await session.preparing()
  await assert.rejects(session.saveSelection({ magnet, metadata, selectableIndexes: [1], listingParts: 513 }))
  await assert.rejects(session.saveSelection({ magnet, metadata, selectableIndexes: [1], listingParts: 0 }))
  await session.saveSelection({ magnet, metadata, selectableIndexes: [1], listingParts: 512 })
  await session.close('cancelled')
})

test('selection scope includes full account, binding revision, group, platform, namespace and original sender', async t => {
  const f = await fixture(t); await f.selection()
  for (const selected of [binding({ account: { id: 'robot-b' }, connectionId: 'conn-b' }), binding({ revision: 'changed' }), binding({ group: 'room-2' }),
    binding({ account: { namespace: 'other' } }), binding({ account: { platform: 'other' } })]) {
    const trigger = source('selection', { sender: { ...selected.target.account, id: 'human' } })
    assert.equal(await f.ledger.readSelection(selected, trigger.sender), undefined)
    assert.equal(await f.ledger.reserveSelection(selected, trigger), undefined)
  }
  const impostor = source('selection', { sender: { ...source().sender, id: 'other-human' } })
  assert.equal(await f.ledger.readSelection(binding(), impostor.sender), undefined)
  assert.equal(await f.ledger.reserveSelection(binding(), impostor), undefined)
  assert.ok(await f.ledger.readSelection(binding(), source().sender))
})

test('selection reservation is atomic across competing messages and records both original and selection sources', async t => {
  const f = await fixture(t); await f.selection()
  const results = await Promise.all(['select-1', 'select-2', 'select-3'].map(id => f.ledger.reserveSelection(binding(), source(id))))
  assert.equal(results.filter(Boolean).length, 1)
  const reservation = results.find(Boolean), { session } = reservation
  assert.equal(reservation.selection.state, 'reserved'); assert.equal(reservation.selection.reservedBy, session.record.id)
  assert.equal(session.record.source.messageId, 'original-source'); assert.match(session.record.trigger.messageId, /^select-/u)
  assert.equal(await f.ledger.readSelection(binding(), source().sender), undefined)
  await reservation.release(); await reservation.release(); await session.close('failed')
  assert.ok(await f.ledger.readSelection(binding(), source().sender))
  await assert.rejects(reservation.commit())
})

test('a queued reserved selection can resume after restart but obsolete reservations cannot mutate its owner', async t => {
  const f = await fixture(t); await f.selection()
  const first = await f.ledger.reserveSelection(binding(), source('select'))
  first.session.abandon()
  const restarted = f.restart(); await restarted.recover()
  const second = await restarted.reserveSelection(binding(), source('select'))
  assert.ok(second); assert.equal(second.session.record.id, first.session.record.id)
  await assert.rejects(first.release(), 'stale owner cannot borrow the new ownership token')
  await second.session.preparing(); await second.release(); await second.session.close('failed')
  assert.ok(await restarted.readSelection(binding(), source().sender))
})

test('a definitively failed selected preparation releases its listing while any attempted archive cannot', async t => {
  const f = await fixture(t); await f.selection()
  const first = await f.ledger.reserveSelection(binding(), source('select-1')); await first.session.preparing()
  await first.session.begin('failure'); await first.session.finish('failure', sent('selection-failed'))
  await first.session.close('failed')
  assert.ok(await f.ledger.readSelection(binding(), source().sender), 'pre-archive failure permits the original person to choose again')
  const second = await f.ledger.reserveSelection(binding(), source('select-2')); await second.session.preparing()
  await second.session.begin('archive'); await second.session.finish('archive', { state: 'failed', code: 'refused' }); await second.session.close('failed')
  assert.equal(await f.ledger.readSelection(binding(), source().sender), undefined)
})

test('release is forbidden after any archive attempt and unknown removes the reservation permanently', async t => {
  for (const state of ['pending', 'failed', 'unknown', 'uploaded']) await t.test(state, async t => {
    const f = await fixture(t); await f.selection()
    const reservation = await f.ledger.reserveSelection(binding(), source('select'))
    await reservation.session.preparing(); await reservation.session.begin('archive')
    if (state !== 'pending') await reservation.session.finish('archive', state === 'uploaded' ? uploaded : { state, ...(state === 'failed' ? { code: 'failed' } : {}) })
    await assert.rejects(reservation.release())
    assert.equal(await f.ledger.readSelection(binding(), source().sender), undefined)
    if (state === 'unknown') {
      assert.equal(await f.ledger.reserveSelection(binding(), source('new-select')), undefined)
      assert.equal(await f.restart().claim(binding(), source('select'), source()), undefined)
    } else if (state === 'uploaded') {
      await reservation.commit(); await reservation.commit(); await reservation.session.close('completed')
      assert.equal(await f.ledger.reserveSelection(binding(), source('new-select')), undefined)
    } else reservation.session.abandon()
  })
})

test('initial-source or selection-message recall fences late preparation and pending upload receipts', async t => {
  for (const recalled of ['original-source', 'select']) await t.test(recalled, async t => {
    const f = await fixture(t); await f.selection()
    const reservation = await f.ledger.reserveSelection(binding(), source('select'))
    await reservation.session.preparing(); await reservation.session.begin('archive')
    const observer = binding({ account: { id: 'robot-b' }, connectionId: 'conn-b' })
    await f.ledger.cancelSource(observer.target, recalled)
    await assert.rejects(reservation.session.finish('archive', uploaded)); await assert.rejects(reservation.release())
    assert.equal((await f.ledger.inspect(reservation.session.record.id)).state, 'unknown')
    assert.equal(await f.ledger.readSelection(binding(), source().sender), undefined)
  })
})

test('a persisted recall tombstone rejects late finish before cancellation can finalize the record', { timeout: 10000 }, async t => {
  const f = await fixture(t), session = await f.claim(); await session.preparing(); await session.begin('archive')
  let reached, resume
  const barrier = new Promise(resolve => { reached = resolve }), held = new Promise(resolve => { resume = resolve })
  t.after(() => resume())
  const storage = { get: f.storage.get.bind(f.storage), async eval(script, options) {
    if (options.arguments[1]?.includes('"state":"unknown"') && options.arguments[5] === '1') { reached(); await held }
    return f.storage.eval(script, options)
  } }
  const cancellation = f.restart(storage).cancelSource(binding().target, 'original-source')
  await barrier
  await assert.rejects(session.finish('archive', uploaded))
  assert.equal((await f.ledger.inspect(session.record.id)).stages[0].state, 'pending')
  resume(); await cancellation
  assert.equal((await f.ledger.inspect(session.record.id)).state, 'unknown')
})

test('scope cancellation removes only the exact binding and author selection while other authors remain available', async t => {
  const f = await fixture(t); await f.selection()
  const otherTrigger = source('other-source', { sender: { ...source().sender, id: 'other-human' } })
  const other = await f.claim('other-source', binding(), undefined, otherTrigger); await other.preparing()
  await other.saveSelection({ magnet, metadata, selectableIndexes: [1] }); await other.begin('listing'); await other.finish('listing', sent('other-listing')); await other.close('awaiting-selection')
  await f.ledger.cancelScope(binding(), source().sender)
  assert.equal(await f.ledger.readSelection(binding(), source().sender), undefined)
  assert.ok(await f.ledger.readSelection(binding(), otherTrigger.sender))
  assert.equal(await f.ledger.claim(binding(), source()), undefined)
  const fresh = await f.claim('fresh-authorized-message'); await fresh.close('failed')
  await f.ledger.cancelScope(binding()); assert.equal(await f.ledger.readSelection(binding(), otherTrigger.sender), undefined)
})

test('eight active attempts cap admission without reserving a ninth source, and expiry releases capacity', async t => {
  const f = await fixture(t), sessions = []
  for (let index = 0; index < 8; index++) sessions.push(await f.claim(`message-${index}`))
  await assert.rejects(f.ledger.claim(binding(), source('ninth')))
  assert.equal((await f.reader.keys(f.prefix + 'agent:torrent:v1:admission:*')).length, 8)
  await sessions[0].close('failed')
  const ninth = await f.claim('ninth'); assert.ok(ninth)
  for (const session of [...sessions, ninth]) session.abandon()
  f.advance(86400000); await f.ledger.recover()
  assert.deepEqual(await f.ledger.listActive(), [])
  assert.equal((await f.ledger.inspect(ninth.record.id)).state, 'cancelled')
})

test('selection expiry never renews during reserve or release and configured TTL can only shorten thirty minutes', async t => {
  const f = await fixture(t); const original = await f.selection('original-source', binding(), { ttlSeconds: 10 })
  assert.equal(original.expiresAt - original.createdAt, 10000)
  f.advance(8000)
  const reserved = await f.ledger.reserveSelection(binding(), source('select')); await reserved.session.preparing(); await reserved.release(); await reserved.session.close('failed')
  assert.equal((await f.ledger.readSelection(binding(), source().sender)).expiresAt, original.expiresAt)
  f.advance(2000); assert.equal(await f.ledger.readSelection(binding(), source().sender), undefined)
  const next = await f.claim('fresh'); await next.preparing()
  await assert.rejects(next.saveSelection({ magnet, metadata, selectableIndexes: [1], ttlSeconds: 1801 }))
  await assert.rejects(next.saveSelection({ magnet, metadata, selectableIndexes: [1], ttlSeconds: 0 }))
  await next.close('failed')
})

test('closed metadata preserves every file and rejects raw fields, unsafe paths, oversized inputs and mismatched identities', async t => {
  const f = await fixture(t), session = await f.claim(); await session.preparing()
  const altered = [
    { ...metadata, url: 'https://private.invalid/secret' }, { ...metadata, totalBytes: 1 }, { ...metadata, infoHash: 'C'.repeat(40) },
    { ...metadata, fingerprint: 'invalid' }, { ...metadata, files: metadata.files.slice(0, 1) },
    { ...metadata, files: [{ ...metadata.files[0], relativePath: ['bundle', '..'] }, metadata.files[1]] },
    { ...metadata, files: [{ ...metadata.files[0], relativePath: ['bundle', 'x'.repeat(181)] }, metadata.files[1]] },
    { ...metadata, files: [{ ...metadata.files[0], relativePath: ['bundle', ...Array(32).fill('deep')] }, metadata.files[1]] },
  ]
  for (const candidate of altered) await assert.rejects(session.saveSelection({ magnet, metadata: candidate, selectableIndexes: [1] }))
  await assert.rejects(session.saveSelection({ magnet: magnet + '&dn=' + 'x'.repeat(16384), metadata, selectableIndexes: [1] }))
  await assert.rejects(session.saveSelection({ magnet, metadata, selectableIndexes: [3] }))
  await assert.rejects(session.saveSelection({ magnet, metadata, selectableIndexes: [1, 1] }))
  const files = Array.from({ length: 2048 }, (_, index) => ({ index: index + 1, relativePath: ['bundle', `file-${index}`], size: 1 }))
  await session.saveSelection({ magnet, metadata: { ...metadata, files, totalBytes: 2048 }, selectableIndexes: [1, 2048] })
  await assert.rejects(session.saveSelection({ magnet, metadata: { ...metadata, files: [...files, { index: 2049, relativePath: ['bundle', 'extra'], size: 1 }], totalBytes: 2049 }, selectableIndexes: [1] }))
  const deep = files.map(file => ({ ...file, relativePath: ['bundle', ...Array.from({ length: 31 }, (_, index) => 'x'.repeat(170) + index), 'end'].slice(0, 31).concat(`file-${file.index}`) }))
  await assert.rejects(session.saveSelection({ magnet, metadata: { ...metadata, files: deep, totalBytes: 2048 }, selectableIndexes: [1] }), 'the complete record must fit one MiB; never truncate')
  await session.begin('listing'); await session.finish('listing', sent('complete-listing')); await session.close('awaiting-selection')
  const complete = await f.ledger.readSelection(binding(), source().sender)
  assert.equal(complete.metadata.files.length, 2048); assert.equal(complete.metadata.files.at(-1).index, 2048)
  for (const key of await f.reader.keys(f.prefix + 'agent:torrent:v1:job:*')) assert.equal((await f.reader.get(key)).includes(magnet), false, 'long-lived attempts do not retain magnet or metadata content')
})

test('lost claim acknowledgements preserve durable queued work and lost receipt writes stop all follow-ups', async t => {
  for (const committed of [false, true]) await t.test(committed ? 'lost acknowledgement' : 'write rejected', async t => {
    const f = await fixture(t); let armed = 'claim'
    const storage = { get: f.storage.get.bind(f.storage), async eval(script, options) {
      const hit = armed === 'claim' && script.includes('local admission =') || armed === 'receipt' && options.arguments[1]?.includes('"receipt":')
      if (hit) { armed = ''; if (committed) await f.storage.eval(script, options); throw new Error('/private/redis-secret') }
      return f.storage.eval(script, options)
    } }
    const ledger = f.restart(storage)
    await assert.rejects(ledger.claim(binding(), source()), error => error.message === '磁链下载账本不可用或任务已失效')
    const session = await ledger.claim(binding(), source()); assert.ok(session)
    await session.preparing(); await session.begin('archive'); armed = 'receipt'
    await assert.rejects(session.finish('archive', uploaded))
    await assert.rejects(session.begin('confirmation'))
    await ledger.recover(); assert.equal((await ledger.inspect(session.record.id)).state, 'unknown')
    assert.equal((await f.persisted()).includes('redis-secret'), false)
  })
})

test('enqueue and selection publication preflight corrupt key types or source ownership before any Redis mutation', async t => {
  for (const corruption of ['active-type', 'admission-type', 'admission-value', 'selection-index-type']) await t.test(corruption, async t => {
    const f = await fixture(t); let before, armed = true
    const storage = { get: f.storage.get.bind(f.storage), async eval(script, options) {
      if (armed && script.includes('local admission =')) {
        armed = false
        const keys = options.keys.map(key => f.prefix + key)
        if (corruption === 'active-type') await f.reader.set(keys[1], 'wrong-type')
        if (corruption === 'admission-type') await f.reader.hSet(keys[5], 'field', 'value')
        if (corruption === 'admission-value') await f.reader.set(keys[5], 'not-a-job-id')
        if (corruption === 'selection-index-type') await f.reader.set(keys[7], 'wrong-type')
        before = await f.persisted()
      }
      return f.storage.eval(script, options)
    } }
    await assert.rejects(f.restart(storage).claim(binding(), source()))
    assert.equal(armed, false); assert.equal(await f.ledger.inspect(agentTorrentId(binding(), source())), undefined)
    assert.equal(await f.persisted(), before)
  })
  await t.test('a broken selection index cannot replace a pending native marker', async t => {
    const f = await fixture(t), session = await f.claim(); await session.preparing()
    await session.saveSelection({ magnet, metadata, selectableIndexes: [1] }); await session.begin('listing')
    const record = await f.ledger.inspect(session.record.id), key = f.prefix + 'agent:torrent:v1:selections'
    await f.reader.del(key); await f.reader.set(key, 'broken')
    const before = await f.reader.get(f.prefix + 'agent:torrent:v1:job:' + session.record.id)
    await assert.rejects(session.finish('listing', sent('confirmed-listing')))
    assert.equal(await f.reader.get(f.prefix + 'agent:torrent:v1:job:' + session.record.id), before)
    assert.equal(record.stages[0].state, 'pending')
  })
})
