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
const { createAgentMediaOutboxLedger, agentMediaOutboxId, agentMediaSourceScopeKey } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/media/infrastructure/agentMediaOutboxLedger.js')).href)
const { connectAgentRedis, openAgentRedis, agentRedisPrefix } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/runtime/infrastructure/agentRedis.js')).href)
const { conversationAddressKey } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/runtime/domain/agentBindings.js')).href)
const initialTime = 1800000000000
const share = { provider: 'bilibili', reference: { kind: 'video', id: 'BV1234567890' } }
const douyinShare = (kind = 'video', id = '7123456789012345678') => ({ provider: 'douyin', reference: { kind, id } })
const xiaohongshuShare = (kind = 'note', id = '6ad4a9c200000000290162d4') => ({ provider: 'xiaohongshu', reference: { kind, id } })
const youtubeShare = (id = 'Ab_Cd-9xYz0') => ({ provider: 'youtube', reference: { kind: 'video', id } })
const pixivShare = (id = '126649495') => ({ provider: 'pixiv', reference: { kind: 'artwork', id } })
const sent = messageId => ({ state: 'sent', messageId })
const wrap = storage => ({ get: storage.get.bind(storage), eval: storage.eval.bind(storage) })
function binding(group = 'room-1', overrides = {}) {
  const target = { account: { platform: 'fixture', namespace: 'global', id: 'robot-1' }, kind: 'group', id: group }
  return { source: 'configured', id: conversationAddressKey(target), revision: 'revision-1', agentId: 'daily', personaId: 'default', connectionId: 'connection-1', target, ...overrides }
}
function source(messageId = 'source-1', overrides = {}) {
  return { messageId, sender: { platform: 'fixture', namespace: 'global', id: 'peer-1' }, occurredAt: initialTime - 1000, share, ...overrides }
}
function siblingBinding(overrides = {}) {
  const selected = binding('room-1', { connectionId: 'connection-2', ...overrides })
  selected.target.account = { ...selected.target.account, id: 'robot-2' }
  selected.id = conversationAddressKey(selected.target)
  return selected
}
async function fixture(t) {
  assert.equal(spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status, 0, 'persistent outbox tests require actual Redis')
  const directory = await mkdtemp(path.join(tmpdir(), 'media-outbox-ledger-')), socket = path.join(directory, 'redis.sock')
  const redis = spawn('redis-server', ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  const exited = once(redis, 'exit')
  let reader, connection, now = initialTime
  t.after(async () => {
    await connection?.close(); if (reader?.isOpen) await reader.close()
    if (redis.exitCode === null && redis.signalCode === null) redis.kill('SIGTERM')
    await exited; await rm(directory, { recursive: true, force: true })
  })
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await stat(socket).then(() => true, () => false)) break
    if (redis.exitCode !== null) assert.fail('Redis exited before readiness')
    await delay(10)
  }
  reader = await connectAgentRedis(`unix://${socket}`)
  connection = await openAgentRedis({ url: `unix://${socket}`, instance: 'media-outbox-ledger-test', onLost() {} })
  const prefix = agentRedisPrefix('media-outbox-ledger-test'), storage = connection.storage
  const ledger = createAgentMediaOutboxLedger(storage, { now: () => now })
  return { reader, storage, ledger, prefix, get now() { return now }, advance(ms) { now += ms },
    restart(selected = wrap(storage)) { return createAgentMediaOutboxLedger(selected, { now: () => now }) },
    async enqueue(messageId = 'source-1', selected = binding(), selectedSource = source(messageId)) {
      assert.equal(await ledger.enqueue({ source: selectedSource, binding: selected }), 'created')
      return agentMediaOutboxId(selected, messageId)
    },
    async persisted() {
      const values = []
      for (const key of (await reader.keys(prefix + 'agent:media-outbox:v1:*')).sort()) {
        const type = await reader.type(key)
        const value = type === 'string' ? await reader.get(key) : type === 'hash' ? await reader.hGetAll(key) : assert.fail(`uninspected Redis type ${type}`)
        values.push(JSON.stringify({ key, value }))
      }
      return values.join('\n')
    },
  }
}

test('outbox atomically records complete neutral ownership and unique monotone queue order', { timeout: 15000 }, async t => {
  const f = await fixture(t), selected = binding(), first = source()
  const results = await Promise.all(Array.from({ length: 16 }, () => f.ledger.enqueue({ source: first, binding: selected })))
  assert.equal(results.filter(row => row === 'created').length, 1)
  assert.equal(results.filter(row => row === 'existing').length, 15)
  const [record] = await f.ledger.listActive()
  assert.equal(record.id, agentMediaOutboxId(selected, first.messageId)); assert.equal(record.sequence, 1)
  assert.deepEqual(record.binding, selected); assert.deepEqual(record.source, first)
  assert.equal(record.state, 'queued'); assert.equal(record.prepareAttempts, 0); assert.equal(record.prepareFailures, 0)
  assert.equal(record.expiresAt - record.createdAt, 86400000)
  assert.ok(Object.isFrozen(record)); assert.ok(Object.isFrozen(record.binding.target.account)); assert.ok(Object.isFrozen(record.source.share.reference))
  assert.throws(() => { record.state = 'completed' })
  assert.equal(await f.ledger.enqueue({ source: source('source-1', { share: { provider: 'bilibili', reference: { kind: 'episode', id: '123' } } }), binding: selected }), 'existing')
  assert.deepEqual((await f.ledger.inspect(record.id)).source.share, share, 'changed media cannot create another job for the same captured message')
  await Promise.all(Array.from({ length: 12 }, (_, index) => f.ledger.enqueue({ source: source(`source-${index + 2}`), binding: selected })))
  assert.deepEqual((await f.ledger.listActive()).map(row => row.sequence), Array.from({ length: 13 }, (_, index) => index + 1))
  const ttl = await f.reader.ttl(f.prefix + 'agent:media-outbox:v1:job:' + record.id)
  assert.ok(ttl > 604790 && ttl <= 604800)
})

test('bounded queue admits at most thirty-two jobs per lane and 128 across concurrent enqueues', { timeout: 30000 }, async t => {
  const f = await fixture(t)
  const results = await Promise.all(Array.from({ length: 5 }, (_, lane) => Array.from({ length: 40 }, (_, index) =>
    f.ledger.enqueue({ binding: binding(`room-${lane}`), source: source(`lane-${lane}-source-${index}`) }))).flat())
  assert.equal(results.filter(row => row === 'created').length, 128)
  assert.equal(results.filter(row => row === 'full').length, 72)
  const active = await f.ledger.listActive()
  const lanes = new Map()
  for (const record of active) lanes.set(record.binding.target.id, (lanes.get(record.binding.target.id) ?? 0) + 1)
  assert.ok([...lanes.values()].every(count => count <= 32))
  assert.equal(new Set(active.map(row => row.sequence)).size, 128)
  const retired = await f.ledger.claim(active[0].id); await retired.close('failed')
  assert.equal((await f.ledger.listActive()).length, 127)
  assert.equal(await f.ledger.enqueue({ binding: binding('fresh-room'), source: source('fresh-source') }), 'created')
  assert.equal(await f.ledger.enqueue({ binding: active[0].binding, source: active[0].source }), 'existing', 'terminal dedupe survives capacity release')
})

test('binding identity remains distinct while source admission survives rebind and revisions share capacity', async t => {
  const f = await fixture(t), original = binding()
  const id = await f.enqueue()
  const changed = binding('room-1', { revision: 'revision-2' })
  const other = agentMediaOutboxId(changed, 'source-1')
  assert.notEqual(id, other)
  assert.equal(await f.ledger.enqueue({ binding: changed, source: source() }), 'existing')
  assert.equal(await f.ledger.inspect(other), undefined, 'rebind cannot admit the captured source again')
  await f.enqueue('source-2', changed)
  const moved = binding('room-1', { connectionId: 'connection-2' })
  assert.notEqual(agentMediaOutboxId(moved, 'source-1'), id)
  assert.equal(await f.ledger.enqueue({ binding: moved, source: source() }), 'existing')
  for (let index = 0; index < 30; index++) assert.equal(await f.ledger.enqueue({ binding: index % 2 ? original : changed, source: source(`extra-${index}`) }), 'created')
  assert.equal(await f.ledger.enqueue({ binding: changed, source: source('lane-overflow') }), 'full')
  assert.equal(await f.ledger.enqueue({ binding: moved, source: source('other-connection') }), 'created')
})

test('source admission prevents another account from enqueueing after sent or unknown delivery', async t => {
  for (const outcome of ['sent', 'unknown']) await t.test(outcome, async t => {
    const f = await fixture(t), id = await f.enqueue(), session = await f.ledger.claim(id)
    await session.preparing(); await session.begin('forward')
    await session.finish('forward', outcome === 'sent' ? sent('first-delivery') : { state: 'unknown' })
    if (outcome === 'sent') await session.close('completed')
    const selected = siblingBinding(), peer = f.restart(), before = await f.persisted()
    assert.equal(await peer.enqueue({ binding: selected, source: source() }), 'existing', 'online election may move, but source ownership cannot')
    assert.equal(await peer.inspect(agentMediaOutboxId(selected, 'source-1')), undefined)
    const namespace = f.prefix + 'agent:media-outbox:v1:', [admission] = await f.reader.keys(namespace + 'admission:*')
    assert.ok(admission, 'verified durable enqueue creates a common admission fence')
    assert.match(admission.slice((namespace + 'admission:').length), /^[a-f0-9]{64}$/u)
    assert.equal(await f.reader.get(admission), id)
    const ttl = await f.reader.ttl(admission)
    assert.ok(ttl > 604790 && ttl <= 604800)
    assert.equal(await f.reader.get(namespace + 'sequence'), '1')
    assert.deepEqual(await peer.listActive(), [])
    assert.equal(await f.persisted(), before, 'a second account cannot create or refresh any durable state')
  })
})

test('the exact original v1 Bilibili record, source scope and job ID remain readable and recoverable', async t => {
  const f = await fixture(t), selected = binding(), id = await f.enqueue('legacy-source')
  assert.equal(id, 'd777b07b78aead2dea6d7f3a553ff162560021df96d1c9618c721d13b4ab3719')
  assert.equal(agentMediaSourceScopeKey(selected.target), 'a9ae505e719f8d18fdf3b69010cd960e7cc67eb40c4250177604970a35fd0447')
  const original = { version: 1, id, sequence: 1, source: source('legacy-source'), binding: selected, state: 'preparing',
    createdAt: initialTime, updatedAt: initialTime, expiresAt: initialTime + 86400000, prepareAttempts: 1, prepareFailures: 0, nextAttemptAt: 0, effects: [] }
  await f.reader.set(f.prefix + 'agent:media-outbox:v1:job:' + id, JSON.stringify(original))
  const restarted = f.restart()
  assert.deepEqual(await restarted.inspect(id), original)
  await restarted.recover()
  const recovered = await restarted.inspect(id)
  assert.equal(recovered.state, 'queued'); assert.deepEqual(recovered.source, original.source); assert.equal(recovered.version, 1)
  assert.equal(await restarted.enqueue({ binding: siblingBinding(), source: source('legacy-source', { share: douyinShare() }) }), 'existing')
})

test('provider switches cannot admit the same physical source again before delivery, after completion or after unknown', async t => {
  const allShares = [share, douyinShare('note'), xiaohongshuShare(), youtubeShare(), pixivShare()]
  for (const originalShare of allShares) for (const state of ['queued', 'completed', 'unknown']) await t.test(`${originalShare.provider}-${state}`, async t => {
    const f = await fixture(t)
    const id = await f.enqueue('source-1', binding(), source('source-1', { share: originalShare }))
    if (state !== 'queued') {
      const session = await f.ledger.claim(id); await session.preparing(); await session.begin('forward')
      await session.finish('forward', state === 'completed' ? sent('native-receipt') : { state: 'unknown' })
      if (state === 'completed') await session.close('completed')
    }
    const restarted = f.restart(), before = await f.persisted()
    for (const selected of [binding(), binding('room-1', { revision: 'revision-2' }), siblingBinding({ revision: 'revision-3' })]) {
      for (const nextShare of allShares.filter(value => value.provider !== originalShare.provider)) {
        assert.equal(await restarted.enqueue({ binding: selected, source: source('source-1', { share: nextShare }) }), 'existing')
      }
    }
    assert.deepEqual((await restarted.inspect(id)).source.share, originalShare)
    assert.equal(await f.persisted(), before)
  })
})

test('Xiaohongshu durable references reject all access material and retain provider-independent recall fencing', async t => {
  for (const selectedShare of [xiaohongshuShare(), xiaohongshuShare('short', 'Ab_C9'), xiaohongshuShare('short', 'a/Ab_C9')]) await t.test(selectedShare.reference.kind + '-' + selectedShare.reference.id, async t => {
    const f = await fixture(t), original = source('source-1', { share: selectedShare }), id = await f.enqueue('source-1', binding(), original)
    assert.deepEqual((await f.ledger.inspect(id)).source.share, selectedShare)
    for (const changed of [{ ...original, access: { provider: 'xiaohongshu', xsecToken: 'PRIVATE' } },
      source('unsafe', { share: { ...selectedShare, xsecToken: 'PRIVATE' } }),
      source('unsafe', { share: { ...selectedShare, reference: { ...selectedShare.reference, xsec_token: 'PRIVATE' } } }),
      source('unsafe', { share: xiaohongshuShare('short', 'Ab_C9?xsec_token=PRIVATE') })]) {
      await assert.rejects(f.ledger.enqueue({ binding: binding(), source: changed }))
    }
    const session = await f.ledger.claim(id); await session.preparing()
    await f.ledger.cancelSource(siblingBinding().target, original.messageId)
    assert.equal((await f.ledger.inspect(id)).state, 'cancelled'); await assert.rejects(session.begin('forward'))
    assert.equal(await f.restart().enqueue({ binding: siblingBinding(), source: source() }), 'existing')
    const raw = await f.persisted()
    for (const secret of ['PRIVATE', 'xsec', 'access', 'https:', 'cookie', 'base64']) assert.equal(raw.includes(secret), false)
  })
})

test('Pixiv durable references keep only artwork identity and preserve sibling-account recall fencing', async t => {
  const f = await fixture(t), selectedShare = pixivShare(), original = source('source-1', { share: selectedShare }), id = await f.enqueue('source-1', binding(), original)
  assert.deepEqual((await f.ledger.inspect(id)).source.share, selectedShare)
  for (const changed of [{ ...original, access: { provider: 'pixiv', cookie: 'PRIVATE' } },
    source('unsafe', { share: { ...selectedShare, url: 'https://www.pixiv.net/artworks/126649495?token=PRIVATE' } }),
    source('unsafe', { share: { ...selectedShare, reference: { ...selectedShare.reference, cookie: 'PRIVATE' } } }),
    source('unsafe', { share: pixivShare('126649495?token=PRIVATE') })]) await assert.rejects(f.ledger.enqueue({ binding: binding(), source: changed }))
  const session = await f.ledger.claim(id); await session.preparing()
  await f.ledger.cancelSource(siblingBinding().target, original.messageId)
  assert.equal((await f.ledger.inspect(id)).state, 'cancelled'); await assert.rejects(session.begin('forward'))
  assert.equal(await f.restart().enqueue({ binding: siblingBinding(), source: source() }), 'existing')
  const raw = await f.persisted()
  for (const secret of ['PRIVATE', 'access', 'https:', 'cookie', 'base64']) assert.equal(raw.includes(secret), false)
})

test('Douyin references retain v1 privacy bounds and shared recall fences across video, note and short jobs', async t => {
  for (const kind of ['video', 'note', 'short']) await t.test(kind, async t => {
    const f = await fixture(t), selectedShare = douyinShare(kind, kind === 'short' ? 'Ab_9-z' : '7123456789012345678'),
      original = source('source-1', { share: selectedShare }), id = await f.enqueue('source-1', binding(), original)
    assert.deepEqual((await f.ledger.inspect(id)).source.share, selectedShare)
    const session = await f.ledger.claim(id); await session.preparing()
    await f.ledger.cancelSource(siblingBinding().target, original.messageId)
    assert.equal((await f.ledger.inspect(id)).state, 'cancelled'); await assert.rejects(session.begin('forward'))
    assert.equal(await f.restart().enqueue({ binding: siblingBinding(), source: source('source-1') }), 'existing')
    for (const changed of [{ ...selectedShare, url: 'https://v.douyin.com/Ab_9-z/?token=SECRET' },
      { ...selectedShare, reference: { ...selectedShare.reference, cookie: 'SECRET' } }, douyinShare(kind, 'https://private.cdn.invalid/')]) {
      await assert.rejects(f.ledger.enqueue({ binding: binding(), source: source('unsafe-source', { share: changed }) }))
    }
    const raw = await f.persisted()
    for (const forbidden of ['https:', 'SECRET', 'private.cdn', 'base64', 'cookie', 'artifact', 'plan']) assert.equal(raw.includes(forbidden), false)
  })
})

test('concurrent account enqueues share one source admission but platform, namespace, kind and group remain isolated', async t => {
  const f = await fixture(t), first = binding(), second = siblingBinding()
  const results = await Promise.all([first, second].flatMap(selected => Array.from({ length: 8 }, () => f.ledger.enqueue({ binding: selected, source: source() }))))
  assert.equal(results.filter(value => value === 'created').length, 1)
  assert.equal(results.filter(value => value === 'existing').length, 15)
  const isolated = [binding('other-room'), binding(), binding(), binding(), siblingBinding()]
  isolated[1].target.account.namespace = 'another-namespace'
  isolated[2].target.account.platform = 'another-platform'
  isolated[3].target.kind = 'private'
  isolated[4].target.kind = 'private'
  for (const selected of isolated) {
    selected.id = conversationAddressKey(selected.target)
    assert.equal(await f.ledger.enqueue({ binding: selected, source: source('source-1', { sender: { ...selected.target.account, id: 'peer-1' } }) }), 'created')
  }
  assert.equal((await f.ledger.listActive()).length, 6)
  const namespace = f.prefix + 'agent:media-outbox:v1:'
  assert.equal((await f.reader.keys(namespace + 'admission:*')).length, 6)
  assert.equal(await f.reader.get(namespace + 'sequence'), '6')
})

test('source admission is written only with an accepted job and retained even if the job record disappears', async t => {
  const f = await fixture(t), id = await f.enqueue()
  const namespace = f.prefix + 'agent:media-outbox:v1:', [admission] = await f.reader.keys(namespace + 'admission:*')
  assert.ok(admission)
  for (let index = 0; index < 31; index++) await f.enqueue(`full-${index}`)
  const before = await f.reader.keys(namespace + 'admission:*')
  assert.equal(await f.ledger.enqueue({ binding: binding(), source: source('overflow') }), 'full')
  assert.deepEqual(await f.reader.keys(namespace + 'admission:*'), before, 'capacity refusal cannot reserve a source')
  await f.reader.del(namespace + 'job:' + id)
  assert.equal(await f.ledger.enqueue({ binding: siblingBinding(), source: source() }), 'existing')
  assert.equal(await f.reader.get(admission), id)
  assert.equal((await f.ledger.listActive()).length, 31)
})

test('only one local session can claim a job and every effect is pending durably before native execution', async t => {
  const f = await fixture(t), id = await f.enqueue(), peer = createAgentMediaOutboxLedger(f.storage, { now: () => f.now })
  const sessions = await Promise.all([f.ledger.claim(id), peer.claim(id), f.ledger.claim(id)])
  assert.equal(sessions.filter(Boolean).length, 1)
  const session = sessions.find(Boolean); await session.preparing()
  assert.equal(session.record.prepareAttempts, 1)
  for (const [effect, receipt] of [['forward', { state: 'failed', code: '/private/failure-secret' }], ['forwardRetry', { state: 'failed', code: 'other-private-secret' }],
    ['directIntro', sent('intro-1')], ['directVideo', { state: 'failed', code: 'video-failed' }], ['link', sent('link-1')]]) {
    await session.begin(effect)
    const persisted = await f.ledger.inspect(id)
    assert.equal(persisted.state, 'sending'); assert.equal(persisted.effects.at(-1).effect, effect)
    assert.equal(persisted.effects.at(-1).state, 'pending'); assert.equal(persisted.effects.at(-1).receipt, undefined)
    await assert.rejects(session.begin(effect)); await session.finish(effect, receipt)
    if (receipt.state === 'failed') assert.deepEqual(session.record.effects.at(-1).receipt, { state: 'failed', code: null })
  }
  await session.close('completed'); session.abandon(); session.abandon()
  assert.equal(session.record.state, 'completed'); assert.equal(await peer.claim(id), undefined)
  assert.deepEqual(await f.ledger.listActive(), [])
  for (const value of ['/private/failure-secret', 'other-private-secret', 'video-failed']) assert.equal((await f.persisted()).includes(value), false)
})

test('queued and preparation-only work recovers while live local holders are never stolen', async t => {
  const f = await fixture(t), queued = await f.enqueue('queued'), preparing = await f.enqueue('preparing')
  const session = await f.ledger.claim(preparing); await session.preparing()
  await f.ledger.recover()
  const sameStorage = createAgentMediaOutboxLedger(f.storage, { now: () => f.now }); await sameStorage.recover()
  assert.equal((await sameStorage.inspect(preparing)).state, 'preparing')
  assert.equal(await sameStorage.claim(preparing), undefined)
  session.abandon()
  const restarted = f.restart(); await restarted.recover()
  assert.equal((await restarted.inspect(queued)).state, 'queued')
  const reset = await restarted.inspect(preparing)
  assert.equal(reset.state, 'queued'); assert.equal(reset.prepareAttempts, 1); assert.deepEqual(reset.effects, [])
  const next = await restarted.claim(preparing); await next.preparing(); assert.equal(next.record.prepareAttempts, 2); await next.close('failed')
})

test('restart freezes pending or previously attempted sends, including a known receipt interrupted before workflow close', async t => {
  for (const receipt of [undefined, sent('confirmed-message'), { state: 'failed', code: 'explicit-failure' }]) await t.test(String(receipt?.state ?? 'pending'), async t => {
    const f = await fixture(t), id = await f.enqueue(), session = await f.ledger.claim(id)
    await session.preparing(); await session.begin('forward')
    if (receipt) await session.finish('forward', receipt)
    session.abandon()
    const restarted = f.restart(); await restarted.recover()
    const record = await restarted.inspect(id)
    assert.equal(record.state, 'unknown'); assert.deepEqual(await restarted.listActive(), [])
    assert.equal(record.effects[0].state, receipt ? receipt.state : 'unknown')
    assert.equal(await restarted.claim(id), undefined)
    assert.equal(await restarted.enqueue({ binding: binding(), source: source() }), 'existing')
  })
})

test('preparation retries distinguish failed work from released prewarm results and abandon sessions automatically', async t => {
  const f = await fixture(t), id = await f.enqueue()
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await f.ledger.claim(id); await current.preparing(); await current.retry(f.now, false)
    assert.equal(current.record.prepareFailures, 0); current.abandon()
  }
  for (let failure = 1; failure <= 3; failure++) {
    const current = await f.ledger.claim(id); await current.preparing()
    const retryAt = f.now + 1000; await current.retry(retryAt)
    assert.equal(current.record.prepareFailures, failure)
    assert.equal(await f.ledger.claim(id), undefined, 'backoff is enforced')
    f.advance(1000)
  }
  const exhausted = await f.ledger.claim(id)
  assert.equal(exhausted.record.prepareAttempts, 8); await assert.rejects(exhausted.preparing())
  await exhausted.close('failed')
  assert.equal(exhausted.record.prepareFailures, 3)
})

test('absolute twenty-four-hour expiry cancels unsent work and freezes attempted work without deleting dedupe', async t => {
  const f = await fixture(t), queued = await f.enqueue('queued'), preparing = await f.enqueue('preparing'), sending = await f.enqueue('sending')
  const warm = await f.ledger.claim(preparing); await warm.preparing(); warm.abandon()
  const action = await f.ledger.claim(sending); await action.preparing(); await action.begin('forward'); action.abandon()
  f.advance(86400000)
  await f.ledger.recover()
  assert.equal((await f.ledger.inspect(queued)).state, 'cancelled')
  assert.equal((await f.ledger.inspect(preparing)).state, 'cancelled')
  assert.equal((await f.ledger.inspect(sending)).state, 'unknown')
  assert.deepEqual(await f.ledger.listActive(), [])
  assert.equal(await f.ledger.enqueue({ binding: binding(), source: source('queued') }), 'existing')
})

test('source cancellation is durable across bindings and blocks late prepare, receipt and fresh enqueue', async t => {
  const f = await fixture(t), selected = binding(), queued = await f.enqueue('queued')
  const preparing = await f.enqueue('preparing'), sending = await f.enqueue('sending'), sentJob = await f.enqueue('sent')
  const warm = await f.ledger.claim(preparing); await warm.preparing()
  const action = await f.ledger.claim(sending); await action.preparing(); await action.begin('forward')
  const done = await f.ledger.claim(sentJob); await done.preparing(); await done.begin('forward'); await done.finish('forward', sent('first-message'))
  for (const messageId of ['queued', 'preparing', 'sending', 'sent']) await f.ledger.cancelSource(selected.target, messageId)
  assert.equal((await f.ledger.inspect(queued)).state, 'cancelled'); assert.equal((await f.ledger.inspect(preparing)).state, 'cancelled')
  assert.equal((await f.ledger.inspect(sending)).state, 'unknown'); assert.equal((await f.ledger.inspect(sentJob)).state, 'unknown')
  await assert.rejects(warm.retry(f.now)); await assert.rejects(action.finish('forward', sent('late-message'))); await assert.rejects(done.begin('link'))
  assert.equal((await f.ledger.inspect(sending)).effects[0].receipt.state, 'unknown')
  assert.equal(await f.ledger.enqueue({ binding: binding('room-1', { revision: 'new-revision' }), source: source('sending') }), 'existing')
  await f.ledger.cancelSource(selected.target, 'not-yet-enqueued')
  assert.equal(await f.ledger.enqueue({ binding: selected, source: source('not-yet-enqueued') }), 'existing')
  assert.deepEqual(await f.ledger.listActive(), [])
})

test('a sibling account recall cancels preparing work and fences late preparation or a fresh account enqueue', async t => {
  const f = await fixture(t), selected = binding(), observer = siblingBinding()
  const id = await f.enqueue(), session = await f.ledger.claim(id)
  await session.preparing()
  assert.equal(agentMediaSourceScopeKey(selected.target), agentMediaSourceScopeKey(observer.target))
  await f.ledger.cancelSource(observer.target, 'source-1')
  assert.equal((await f.ledger.inspect(id)).state, 'cancelled')
  await assert.rejects(session.retry(f.now)); await assert.rejects(session.begin('forward'))
  assert.equal(await f.restart().enqueue({ binding: observer, source: source() }), 'existing')
  assert.equal(await f.ledger.inspect(agentMediaOutboxId(observer, 'source-1')), undefined)
  await f.ledger.cancelSource(observer.target, 'before-enqueue')
  assert.equal(await f.ledger.enqueue({ binding: selected, source: source('before-enqueue') }), 'existing', 'shared recall tombstone exists even before a job is admitted')
  assert.deepEqual(await f.ledger.listActive(), [])
})

test('shared group recalls cannot cancel other groups, namespaces, platforms, message ids or private accounts', async t => {
  const f = await fixture(t), root = binding(), observer = siblingBinding()
  const cancelled = await f.enqueue(), otherMessage = await f.enqueue('other-message')
  const isolated = [binding('other-room'), binding(), binding(), binding(), siblingBinding()]
  isolated[1].target.account.namespace = 'another-namespace'
  isolated[2].target.account.platform = 'another-platform'
  isolated[3].target.kind = 'private'; isolated[4].target.kind = 'private'
  const ids = []
  for (const selected of isolated) {
    selected.id = conversationAddressKey(selected.target)
    ids.push(await f.enqueue('source-1', selected, source('source-1', { sender: { ...selected.target.account, id: 'peer-1' } })))
    assert.notEqual(agentMediaSourceScopeKey(root.target), agentMediaSourceScopeKey(selected.target))
  }
  assert.notEqual(agentMediaSourceScopeKey(isolated[3].target), agentMediaSourceScopeKey(isolated[4].target))
  await f.ledger.cancelSource(observer.target, 'source-1')
  assert.equal((await f.ledger.inspect(cancelled)).state, 'cancelled')
  for (const id of [...ids, otherMessage]) assert.equal((await f.ledger.inspect(id)).state, 'queued')
  await f.ledger.cancelSource(isolated[4].target, 'source-1')
  assert.equal((await f.ledger.inspect(ids[4])).state, 'cancelled')
  assert.equal((await f.ledger.inspect(ids[3])).state, 'queued', 'private recall remains account-local')
})

test('unknown receipts immediately terminate ownership and prohibit every follow-up effect or retry', async t => {
  const f = await fixture(t), id = await f.enqueue(), session = await f.ledger.claim(id)
  await session.preparing(); await session.begin('forward'); await session.finish('forward', { state: 'unknown' })
  assert.equal(session.record.state, 'unknown'); assert.equal((await f.ledger.inspect(id)).state, 'unknown')
  for (const operation of [() => session.begin('forwardRetry'), () => session.begin('link'), () => session.retry(f.now), () => session.close('completed')]) await assert.rejects(operation())
  assert.equal(await f.ledger.claim(id), undefined); assert.deepEqual(await f.ledger.listActive(), [])
})

test('a sibling recall tombstone fences an in-flight receipt before the cancellation record transition finishes', { timeout: 10000 }, async t => {
  const f = await fixture(t), id = await f.enqueue(), session = await f.ledger.claim(id)
  await session.preparing(); await session.begin('forward')
  let reached, resume
  const reachedPromise = new Promise(resolve => { reached = resolve }), held = new Promise(resolve => { resume = resolve })
  t.after(() => resume())
  const storage = { get: f.storage.get.bind(f.storage), async eval(script, options) {
    if (options.arguments[1]?.includes('"state":"unknown"') && options.arguments[7] === '1') { reached(); await held }
    return f.storage.eval(script, options)
  } }
  const cancellation = f.restart(storage).cancelSource(siblingBinding().target, 'source-1')
  await reachedPromise
  assert.equal((await f.ledger.inspect(id)).effects[0].state, 'pending', 'terminal CAS is deliberately still waiting')
  await assert.rejects(session.finish('forward', sent('late-confirmed-message')))
  assert.equal((await f.ledger.inspect(id)).effects[0].state, 'pending', 'the source tombstone rejects the stale finish before terminal CAS')
  resume(); await cancellation
  assert.equal((await f.ledger.inspect(id)).state, 'unknown')
  assert.deepEqual((await f.ledger.inspect(id)).effects[0].receipt, { state: 'unknown' })
})

test('receipt persistence failures preserve at-most-once evidence for recovery even when the acknowledgement is lost', async t => {
  for (const committed of [false, true]) await t.test(committed ? 'lost acknowledgement' : 'write rejected', async t => {
    const f = await fixture(t)
    let armed = false
    const storage = { get: f.storage.get.bind(f.storage), async eval(script, options) {
      if (armed && options.arguments[1]?.includes('"receipt":')) {
        armed = false
        if (committed) await f.storage.eval(script, options)
        throw new Error('/private/storage-secret?token=secret')
      }
      return f.storage.eval(script, options)
    } }
    const ledger = f.restart(storage), id = agentMediaOutboxId(binding(), 'source-1')
    assert.equal(await ledger.enqueue({ binding: binding(), source: source() }), 'created')
    const session = await ledger.claim(id); await session.preparing(); await session.begin('forward'); armed = true
    await assert.rejects(session.finish('forward', sent('native-confirmed')), error => error.message === '媒体投递账本不可用或任务已失效')
    assert.equal((await ledger.inspect(id)).effects[0].state, committed ? 'sent' : 'pending')
    await assert.rejects(session.begin('link'))
    await ledger.recover(); assert.equal((await ledger.inspect(id)).state, 'unknown'); assert.equal(await ledger.claim(id), undefined)
    assert.equal((await f.persisted()).includes('storage-secret'), false)
  })
})

test('owner fences and CAS stop obsolete sessions from overwriting recovery or concurrent transitions', async t => {
  const f = await fixture(t), id = await f.enqueue(), old = await f.ledger.claim(id); await old.preparing()
  const restarted = f.restart(); await restarted.recover()
  const current = await restarted.claim(id); await current.preparing()
  await assert.rejects(old.close('failed'))
  assert.equal((await restarted.inspect(id)).state, 'preparing')
  const results = await Promise.allSettled([current.begin('forward'), current.begin('link')])
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1)
  const pending = (await restarted.inspect(id)).effects.at(-1)
  await current.finish(pending.effect, sent('cas-message')); await current.close('completed')
})

test('persistent data is closed, bounded and free of URLs, native plans, artifact bytes or raw exceptions', async t => {
  const f = await fixture(t), selected = binding(), id = await f.enqueue(), session = await f.ledger.claim(id)
  await session.preparing(); await session.begin('forward')
  const secret = 'https://cdn.invalid/private?token=SECRET_BASE64_BYTES'
  await session.finish('forward', { state: 'failed', code: secret }); await session.begin('link')
  await session.finish('link', { state: 'sent', messageId: secret })
  assert.equal(session.record.state, 'unknown')
  for (const altered of [{ source: { ...source('bad'), url: secret }, binding: selected },
    { source: source('bad', { share: { ...share, url: secret } }), binding: selected },
    { source: source('bad', { share: { provider: 'bilibili', reference: { kind: 'video', id: share.reference.id, url: secret } } }), binding: selected },
    { source: source('bad'), binding: { ...selected, path: '/private/source' } },
    { source: source('bad'), binding: { ...selected, revision: secret } }]) await assert.rejects(f.ledger.enqueue(altered))
  const getter = Object.defineProperty(source('getter'), 'sender', { get() { throw new Error(secret) } })
  await assert.rejects(f.ledger.enqueue({ source: getter, binding: selected }), error => !error.message.includes('cdn.invalid'))
  const large = binding('界'.repeat(128)), account = { platform: 'fixture', namespace: '界'.repeat(128), id: '界'.repeat(128) }
  large.target.account = account; large.id = conversationAddressKey(large.target); large.revision = '界'.repeat(4096)
  large.agentId = large.personaId = large.connectionId = '界'.repeat(64)
  await assert.rejects(f.ledger.enqueue({ binding: large, source: source('界'.repeat(128), { sender: { ...account, id: '另'.repeat(128) } }) }))
  const persisted = await f.persisted()
  for (const forbidden of [secret, 'cdn.invalid', 'SECRET_BASE64_BYTES', '/private/source', 'artifact', 'nativeUrl', 'base64', 'plan']) assert.equal(persisted.includes(forbidden), false)
  for (const record of await f.ledger.listActive()) assert.ok(Buffer.byteLength(JSON.stringify(record)) <= 16384)
})

test('corrupt persisted state fails closed and missing records leave capacity without clearing source admission', async t => {
  const f = await fixture(t), id = await f.enqueue(), key = f.prefix + 'agent:media-outbox:v1:job:' + id
  const original = await f.reader.get(key)
  await f.reader.set(key, JSON.stringify({ ...JSON.parse(original), state: 'sending', effects: [] }))
  await assert.rejects(f.ledger.inspect(id)); await assert.rejects(f.ledger.recover())
  await f.reader.del(key)
  assert.deepEqual(await f.ledger.listActive(), [])
  assert.equal(await f.ledger.enqueue({ binding: binding(), source: source() }), 'existing')
  assert.equal(await f.ledger.enqueue({ binding: binding(), source: source('fresh') }), 'created')
  assert.equal((await f.ledger.listActive())[0].sequence, 2)
})

test('Lua preflights key types and index integers before any enqueue or terminal-record mutation', async t => {
  for (const corruption of ['active-type', 'lanes-type', 'sequence-type', 'lane-integer', 'sequence-integer', 'admission-type', 'admission-value']) await t.test(corruption, async t => {
    const f = await fixture(t); await f.enqueue()
    const namespace = f.prefix + 'agent:media-outbox:v1:', candidateId = agentMediaOutboxId(binding(), 'candidate')
    const activeBefore = await f.reader.hGetAll(namespace + 'active'), [lane] = Object.values(activeBefore)
    let before, armed = true
    const storage = { get: f.storage.get.bind(f.storage), async eval(script, options) {
      if (armed && script.includes('media outbox sequence exhausted')) {
        armed = false
        if (corruption.startsWith('admission-')) {
          const key = f.prefix + options.keys[5]
          if (corruption === 'admission-type') await f.reader.hSet(key, 'invalid', 'type')
          else await f.reader.set(key, 'not-a-job-id')
        } else if (corruption.endsWith('-type')) {
          const key = namespace + corruption.slice(0, -5)
          await f.reader.del(key)
          if (corruption === 'sequence-type') await f.reader.hSet(key, 'field', 'value')
          else await f.reader.set(key, 'wrong-type')
        } else if (corruption === 'lane-integer') await f.reader.hSet(namespace + 'lanes', lane, 'not-an-integer')
        else await f.reader.set(namespace + 'sequence', '1.5')
        before = await f.persisted()
      }
      return f.storage.eval(script, options)
    } }
    await assert.rejects(f.restart(storage).enqueue({ binding: binding(), source: source('candidate') }))
    assert.equal(armed, false, 'corruption is introduced after recovery and before the enqueue Lua executes')
    assert.equal(await f.reader.get(namespace + 'job:' + candidateId), null)
    assert.equal(await f.persisted(), before, 'Lua error must leave all persisted keys byte-for-byte unchanged')
  })
  await t.test('terminal write checks the lane integer before replacing its pending evidence', async t => {
    const f = await fixture(t), id = await f.enqueue(), session = await f.ledger.claim(id)
    await session.preparing(); await session.begin('link'); await session.finish('link', sent('confirmed'))
    const namespace = f.prefix + 'agent:media-outbox:v1:', [lane] = Object.values(await f.reader.hGetAll(namespace + 'active'))
    const before = await f.reader.get(namespace + 'job:' + id)
    await f.reader.hSet(namespace + 'lanes', lane, 'broken')
    await assert.rejects(session.close('completed'))
    assert.equal(await f.reader.get(namespace + 'job:' + id), before)
    assert.equal(await f.reader.hGet(namespace + 'active', id), lane)
    await f.reader.hSet(namespace + 'lanes', lane, '1'); await f.ledger.recover()
    assert.equal((await f.ledger.inspect(id)).state, 'unknown')
  })
})

test('atomic enqueue checks the actual sequence-expanded UTF-8 record size before incrementing the counter', async t => {
  const f = await fixture(t), existing = await f.enqueue(), template = await f.ledger.inspect(existing)
  const selected = binding('界'.repeat(128)), account = { platform: 'fixture', namespace: '界'.repeat(128), id: '界'.repeat(128) }
  selected.target.account = account; selected.id = conversationAddressKey(selected.target)
  selected.agentId = selected.personaId = selected.connectionId = '界'.repeat(64)
  selected.revision = '界'.repeat(4096)
  const origin = source('界'.repeat(128), { sender: { ...account, id: '另'.repeat(128) } })
  const bytes = () => Buffer.byteLength(JSON.stringify({ ...template, id: agentMediaOutboxId(selected, origin.messageId), sequence: 0, source: origin, binding: selected }))
  while (bytes() > 16384) selected.revision = selected.revision.slice(0, -1)
  selected.revision += 'x'.repeat(16384 - bytes())
  assert.equal(bytes(), 16384)
  const sequenceKey = f.prefix + 'agent:media-outbox:v1:sequence', before = '999999999999999'
  await f.reader.set(sequenceKey, before)
  await assert.rejects(f.ledger.enqueue({ binding: selected, source: origin }))
  assert.equal(await f.reader.get(sequenceKey), before)
  assert.equal(await f.ledger.inspect(agentMediaOutboxId(selected, origin.messageId)), undefined)
  assert.equal((await f.ledger.listActive()).length, 1)
})
