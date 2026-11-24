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
const { createAgentMediaOutbox } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/media/infrastructure/agentMediaOutbox.js')).href)
const { agentMediaOutboxId } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/media/infrastructure/agentMediaOutboxLedger.js')).href)
const { openAgentRedis, connectAgentRedis, agentRedisPrefix } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/runtime/infrastructure/agentRedis.js')).href)
const { createAgentBindingDirectory, conversationAddressKey } = await import(pathToFileURL(path.join(release, 'dist/backend/modules/runtime/domain/agentBindings.js')).href)
const redisAvailable = spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status === 0
const redisTest = { skip: !redisAvailable, timeout: 20_000 }
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve }); return { promise, release } }
const sent = messageId => ({ state: 'sent', messageId })
const resourceFailure = () => ({ state: 'failed', code: 'media_resource_preprocessing_failed' })
const artifact = (id, kind = 'video') => ({ id: id.repeat(32), kind, mime: kind === 'video' ? 'video/mp4' : 'image/jpeg', sizeBytes: 64, sha256: id.repeat(64) })
const cover = artifact('1', 'image'), firstVideo = artifact('2'), secondVideo = artifact('3'), thumbnail = artifact('4', 'image')
const plan = (title, separateNodes = false) => {
  const coverPart = { kind: 'image', artifact: cover }
  const intro = { parts: separateNodes ? [coverPart] : [{ kind: 'text', text: title }, coverPart] }
  const videos = [firstVideo, secondVideo].map(artifact => ({ kind: 'video', artifact, thumbnail }))
  const videoNodes = separateNodes ? videos.map(video => ({ parts: [video] }))
    : [{ parts: [videos[0], { kind: 'text', text: '中间说明' }, videos[1]] }]
  return { version: 1, items: [intro, ...videoNodes] }
}
const douyinShare = (kind = 'video', id = '7123456789012345678') => ({ provider: 'douyin', reference: { kind, id } })
const xiaohongshuShare = (kind = 'note', id = '6ad4a9c200000000290162d4') => ({ provider: 'xiaohongshu', reference: { kind, id } })
const youtubeShare = (id = 'Ab_Cd-9xYz0') => ({ provider: 'youtube', reference: { kind: 'video', id } })
const pixivShare = (id = '126649495') => ({ provider: 'pixiv', reference: { kind: 'artwork', id } })
const referenceKey = share => JSON.stringify([share.provider, share.reference.kind, share.reference.id])
const gallery = { version: 1, items: [{ parts: [{ kind: 'text', text: '抖音图集，共20张；超过20张时仅附前20张。' }] },
  ...Array.from({ length: 20 }, (_, index) => ({ parts: [{ kind: 'image', artifact: { ...cover, id: (index + 1).toString(16).padStart(32, '0'), sha256: (index + 1).toString(16).padStart(64, '0') } }] }))] }
async function bounded(promise, ms = 3000) { let timer; try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('outbox fixture hung')), ms) })]) } finally { clearTimeout(timer) } }
async function waitFor(probe, label, ms = 5000) { const end = Date.now() + ms; while (Date.now() < end) { const value = await probe(); if (value) return value; await delay(10) }; assert.fail(`timed out: ${label}`) }

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'media-outbox-redis-')), socket = path.join(directory, 'redis.sock')
  const server = spawn('redis-server', ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  const exited = once(server, 'exit').catch(() => {})
  let owner, reader, outbox, clock = 1_800_000_000_000, next = 0, prepareHook, openHook, sendHook, evalHook, readHook
  const runners = [], jobs = new Map(), byReference = new Map(), calls = [], preparations = [], releases = new Map(), contextReleases = new Map(), opens = [], reads = []
  const prefix = agentRedisPrefix('media-outbox-runner')
  t.after(async () => {
    for (const runner of runners) await bounded(runner.stop()).catch(() => {})
    await owner?.close(); if (reader?.isOpen) await reader.close()
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM')
    await exited; await rm(directory, { recursive: true, force: true })
  })
  await waitFor(() => stat(socket).then(() => true, () => false), 'Redis socket')
  const url = `unix://${socket}`; owner = await openAgentRedis({ url, instance: 'media-outbox-runner', onLost() {} }); reader = await connectAgentRedis(url)
  const storage = { get: owner.storage.get.bind(owner.storage), async eval(script, options) {
    return evalHook ? evalHook(script, options, () => owner.storage.eval(script, options)) : owner.storage.eval(script, options)
  } }
  const directoryOfBindings = createAgentBindingDirectory({ version: 1, agents: [{ id: 'alice', personaId: 'default' }],
    connections: [{ id: 'qq-a', platform: 'qq', namespace: 'global', accountId: '19000501' }, { id: 'qq-b', platform: 'qq', namespace: 'global', accountId: '19000502' }],
    bindings: [{ connectionId: 'qq-a', kind: 'group', conversationId: '312501', agentId: 'alice' }, { connectionId: 'qq-a', kind: 'group', conversationId: '312502', agentId: 'alice' }, { connectionId: 'qq-b', kind: 'group', conversationId: '312503', agentId: 'alice' }] }, 'media-revision-1')
  const bindings = ['312501', '312502', '312503'].map((id, index) => directoryOfBindings.resolve({ account: { platform: 'qq', namespace: 'global', id: index === 2 ? '19000502' : '19000501' }, kind: 'group', id }))
  const prepared = job => {
    let released = false
    const selected = job.source.share, pageUrl = selected.provider === 'bilibili' ? `https://www.bilibili.com/video/${selected.reference.id}`
      : selected.provider === 'douyin' ? `https://www.douyin.com/${selected.reference.kind === 'short' ? 'video' : selected.reference.kind}/${selected.reference.kind === 'short' ? '7123456789012345678' : selected.reference.id}`
        : selected.provider === 'youtube' ? `https://www.youtube.com/watch?v=${selected.reference.id}`
          : selected.provider === 'pixiv' ? `https://www.pixiv.net/artworks/${selected.reference.id}`
            : `https://www.xiaohongshu.com/explore/${selected.reference.kind === 'short' ? '6ad4a9c200000000290162d4' : selected.reference.id}`
    return { status: 'ready', pageUrl, infoText: `搬运 ${job.source.messageId}`, plan: ['note', 'artwork'].includes(selected.reference.kind) ? structuredClone(gallery) : plan(`搬运 ${job.source.messageId}`, selected.provider === 'bilibili'),
      async release() { if (!released) { released = true; releases.set(job.id, (releases.get(job.id) ?? 0) + 1) } } }
  }
  const makeContext = (record, signal) => {
    const job = jobs.get(record.id), combined = AbortSignal.any([signal, job.cancel.signal])
    return { signal: combined, isCurrent: () => job.current && !combined.aborted, async ensureCurrent() { if (!job.current || combined.aborted) throw new Error('source revoked') },
      async readSource() {
        reads.push(job.id)
        const read = () => job.missing ? undefined : { message: job.message, share: job.source.share, ...(job.access ? { access: job.access } : {}) }
        return readHook ? readHook(job, read) : read()
      },
      release() { contextReleases.set(job.id, (contextReleases.get(job.id) ?? 0) + 1) } }
  }
  const send = async (action, guard, method) => {
    const active = await outbox.ledger.listActive(), candidates = active.filter(record => record.binding.connectionId === action.binding.connectionId &&
      conversationAddressKey(record.binding.target) === conversationAddressKey(action.target) && record.effects.at(-1)?.state === 'pending')
    assert.equal(candidates.length, 1, 'pending effect must be durably visible before native side effect')
    const record = candidates[0], effect = record.effects.at(-1).effect
    assert.equal(record.state, 'sending'); assert.equal(guard.isCurrent(), true)
    const call = { effect, action, guard, method, id: record.id, source: record.source.messageId }; calls.push(call)
    return sendHook ? sendHook(call) : sent(`message-${calls.length}`)
  }
  const create = () => {
    outbox = createAgentMediaOutbox({ storage, now: () => clock,
      actions: { send: (action, guard) => send(action, guard, 'text'), sendMediaRelay: (action, guard) => send(action, guard, 'relay') },
      provider: { async prepare(share, scope) { const job = byReference.get(referenceKey(share)); preparations.push(job.id); return prepareHook ? prepareHook(job, scope, () => prepared(job)) : prepared(job) } },
      async openContext(record, signal) { opens.push(record.id); return openHook ? openHook(record, signal, () => makeContext(record, signal)) : makeContext(record, signal) } })
    runners.push(outbox); return outbox
  }
  create()
  return { reader, storage, prefix, calls, preparations, releases, contextReleases, opens, runners, create, reads,
    get outbox() { return outbox }, advance(ms) { clock += ms }, now: () => clock,
    setPrepare(value) { prepareHook = value }, setOpen(value) { openHook = value }, setSend(value) { sendHook = value }, setEval(value) { evalHook = value },
    setRead(value) { readHook = value },
    async enqueue(bindingIndex = 0, selectedShare) {
      const binding = bindings[bindingIndex], messageId = `source-${++next}`, share = selectedShare || { provider: 'bilibili', reference: { kind: 'video', id: `BVTest0000${next}` } }
      const source = { messageId, sender: { platform: 'qq', namespace: 'global', id: '330501' }, occurredAt: clock, share }
      const id = agentMediaOutboxId(binding, messageId), job = { id, binding, source, current: true, cancel: new AbortController(), missing: false,
        message: { version: 1, conversation: binding.target, sender: source.sender, messageId, occurredAt: clock, text: 'B站分享', parts: [], mentions: [], directedToAccount: false } }
      jobs.set(id, job); byReference.set(referenceKey(share), job)
      assert.equal(await outbox.ledger.enqueue({ binding, source }), 'created'); return job
    },
    async inspect(job) { return outbox.ledger.inspect(job.id) },
    async finished(job) { return waitFor(async () => { await outbox.tick(); const value = await outbox.ledger.inspect(job.id); return ['completed', 'failed', 'cancelled', 'unknown'].includes(value?.state) ? value : false }, `terminal ${job.id}`) },
    async idle() { await delay(40); await outbox.tick(); await delay(20) },
  }
}

test('real Redis preserves group FIFO, serializes one connection and allows two bounded preparations', redisTest, async t => {
  const f = await fixture(t), a = await f.enqueue(), b = await f.enqueue(), c = await f.enqueue(2), heldA = gate(), heldB = gate(), sendHeld = gate()
  let active = 0, maximum = 0
  f.setPrepare(async (job, _scope, prepared) => { active++; maximum = Math.max(maximum, active); try { if (job.id === a.id) await heldA.promise; if (job.id === b.id) await heldB.promise; return prepared() } finally { active-- } })
  f.setSend(async call => { if (call.id === a.id) await sendHeld.promise; return sent(`receipt-${f.calls.length}`) })
  await f.outbox.start(); await waitFor(() => f.preparations.length === 2, 'two preheats')
  assert.deepEqual(f.preparations, [a.id, b.id]); assert.equal(maximum, 2)
  heldB.release(); await waitFor(() => f.preparations.includes(c.id), 'free preparation slot')
  await f.finished(c); assert.equal(f.calls.some(call => call.id === b.id), false)
  heldA.release(); await waitFor(() => f.calls.some(call => call.id === a.id), 'FIFO head sending')
  await f.idle(); assert.equal(f.calls.some(call => call.id === b.id), false)
  sendHeld.release(); await f.finished(a); await f.finished(b)
  assert.deepEqual([...new Set(f.calls.filter(call => call.id !== c.id).map(call => call.id))], [a.id, b.id]); assert.equal(maximum, 2)
  for (const job of [a, b, c]) assert.equal(f.releases.get(job.id), 1)
})

test('different groups on one connection never execute native effects concurrently', redisTest, async t => {
  const f = await fixture(t), a = await f.enqueue(), b = await f.enqueue(1), held = gate()
  f.setSend(async call => { if (call.id === a.id) await held.promise; return sent(`receipt-${f.calls.length}`) })
  await f.outbox.start(); await waitFor(() => f.calls.length === 1 && f.preparations.length === 2, 'serialized groups with prepared successor')
  await f.idle(); assert.equal(f.calls.length, 1); held.release(); await f.finished(a); await f.finished(b)
  assert.deepEqual([...new Set(f.calls.map(call => call.id))], [a.id, b.id])
})

test('Bilibili, Douyin, Xiaohongshu, YouTube and Pixiv share one durable FIFO with a complete ordered gallery', redisTest, async t => {
  const f = await fixture(t), first = await f.enqueue(), video = await f.enqueue(0, douyinShare()), images = await f.enqueue(0, douyinShare('note', '7123456789012345679')),
    note = await f.enqueue(0, xiaohongshuShare()), youtube = await f.enqueue(0, youtubeShare()), pixiv = await f.enqueue(0, pixivShare()),
    held = gate(), jobs = [first, video, images, note, youtube, pixiv]
  t.after(() => held.release())
  f.setSend(async call => { if (call.id === first.id) await held.promise; return sent(`receipt-${f.calls.length}`) })
  await f.outbox.start(); await waitFor(() => f.calls.length === 1 && f.preparations.includes(video.id), 'mixed-provider successor preheat')
  await f.idle(); assert.equal(f.calls.length, 1)
  held.release(); for (const job of jobs) assert.equal((await f.finished(job)).state, 'completed')
  assert.deepEqual([...new Set(f.calls.map(call => call.id))], jobs.map(job => job.id))
  const galleryCall = f.calls.find(call => call.id === images.id)
  assert.deepEqual(galleryCall.action.plan, gallery)
  for (const job of jobs) assert.equal(f.releases.get(job.id), 1)
})

test('Pixiv preserves every ordered image on retry and then sends one safe link without video fallback', redisTest, async t => {
  const f = await fixture(t), job = await f.enqueue(0, pixivShare())
  f.setSend(call => ['forward', 'forwardRetry'].includes(call.effect) ? resourceFailure() : sent('pixiv-link'))
  await f.outbox.start(); const record = await f.finished(job)
  assert.equal(record.state, 'completed'); assert.deepEqual(f.calls.map(call => call.effect), ['forward', 'forwardRetry', 'link'])
  for (const call of f.calls.slice(0, 2)) assert.deepEqual(call.action.plan, gallery)
  assert.ok(f.calls.at(-1).action.parts[0].text.includes('https://www.pixiv.net/artworks/126649495'))
  assert.equal(f.releases.get(job.id), 1)
  const raw = await f.reader.get(f.prefix + `agent:media-outbox:v1:job:${job.id}`)
  assert.deepEqual(record.source.share, pixivShare())
  for (const secret of ['https://', 'sha256', 'base64']) assert.equal(raw.includes(secret), false)
})

for (const stage of ['forward', 'forwardRetry', 'link']) test(`Pixiv ${stage} unknown freezes later effects and restart`, redisTest, async t => {
  const f = await fixture(t), job = await f.enqueue(0, pixivShare())
  f.setSend(call => call.effect === stage ? { state: 'unknown' } : resourceFailure())
  await f.outbox.start(); assert.equal((await f.finished(job)).state, 'unknown')
  const sequence = ['forward', 'forwardRetry', 'link'], expected = sequence.slice(0, sequence.indexOf(stage) + 1)
  assert.deepEqual(f.calls.map(call => call.effect), expected)
  await f.outbox.stop(); await f.create().start(); await f.idle(); assert.equal(f.calls.length, expected.length)
})

test('three Pixiv preparation failures publish only the canonical identity and correct provider name', redisTest, async t => {
  const f = await fixture(t), job = await f.enqueue(0, pixivShare())
  f.setPrepare(() => { throw new Error('https://private.pximg.net/?token=PRIVATE_TOKEN&cookie=PRIVATE_COOKIE') })
  await f.outbox.start(); await waitFor(async () => (await f.inspect(job)).prepareFailures === 1, 'first Pixiv failure')
  f.advance(1000); await f.outbox.tick(); await waitFor(async () => (await f.inspect(job)).prepareFailures === 2, 'second Pixiv failure')
  f.advance(3000); await f.outbox.tick(); assert.equal((await f.finished(job)).state, 'completed')
  assert.deepEqual(f.calls.map(call => call.effect), ['link'])
  const value = f.calls[0].action.parts[0].text
  assert.match(value, /Pixiv/u); assert.ok(value.includes('https://www.pixiv.net/artworks/126649495'))
  for (const secret of ['PRIVATE_TOKEN', 'PRIVATE_COOKIE', 'pximg.net']) assert.equal(value.includes(secret), false)
})

test('Pixiv prepared pages cannot change artwork identity, add access queries or switch provider', redisTest, async t => {
  for (const pageUrl of ['https://www.pixiv.net/artworks/126649496', 'https://www.pixiv.net/artworks/126649495?token=PRIVATE',
    'https://www.youtube.com/watch?v=Ab_Cd-9xYz0']) await t.test(pageUrl, async t => {
    const f = await fixture(t), job = await f.enqueue(0, pixivShare())
    f.setPrepare((_job, _scope, prepare) => ({ ...prepare(), pageUrl }))
    await f.outbox.start(); await waitFor(async () => (await f.inspect(job)).prepareFailures === 1, 'invalid Pixiv prepared page rejected')
    assert.equal(f.calls.length, 0); assert.equal(f.releases.get(job.id), 1)
    f.setPrepare(undefined); f.advance(1000); await f.outbox.tick()
    assert.equal((await f.finished(job)).state, 'completed'); assert.deepEqual(f.calls.map(call => call.effect), ['forward'])
  })
})

test('a Pixiv artwork switch during preparation cancels and releases the late gallery', redisTest, async t => {
  const f = await fixture(t), job = await f.enqueue(0, pixivShare()), held = gate()
  t.after(() => held.release())
  f.setPrepare(async (_job, _scope, prepared) => { const result = prepared(); await held.promise; return result })
  await f.outbox.start(); await waitFor(() => f.preparations.length === 1, 'held Pixiv preparation')
  job.source.share = pixivShare('126649496'); held.release()
  assert.equal((await f.finished(job)).state, 'cancelled'); assert.equal(f.calls.length, 0); assert.equal(f.releases.get(job.id), 1)
})

test('YouTube sends video plans as intro plus direct video without forward and reconstructs its one permitted canonical query', redisTest, async t => {
  const f = await fixture(t), job = await f.enqueue(0, youtubeShare())
  await f.outbox.start(); const record = await f.finished(job)
  assert.equal(record.state, 'completed')
  assert.deepEqual(f.calls.map(call => call.effect), ['directIntro', 'directVideo'])
  const intro = f.calls[0].action, direct = f.calls[1].action
  assert.equal(intro.mode, 'direct-video'); assert.equal(direct.mode, 'direct-video')
  assert.ok(intro.plan.items.flatMap(item => item.parts).some(part => part.kind === 'text' && /搬运 /u.test(part.text)))
  assert.ok(direct.plan.items.every(item => item.parts.every(part => part.kind === 'video')))
  assert.equal(f.releases.get(job.id), 1)
  const persisted = await f.reader.get(f.prefix + `agent:media-outbox:v1:job:${job.id}`)
  assert.equal(persisted.includes('watch?v='), false); assert.equal(persisted.includes('sha256'), false)
  assert.deepEqual(record.source.share, youtubeShare())
})

test('YouTube explicit video rejection falls back to its canonical query after the intro', redisTest, async t => {
  const f = await fixture(t), job = await f.enqueue(0, youtubeShare())
  f.setSend(call => call.effect === 'directVideo' ? { state: 'failed', code: 'native_rejected' } : sent(`receipt-${f.calls.length}`))
  await f.outbox.start(); const record = await f.finished(job)
  assert.equal(record.state, 'completed')
  assert.deepEqual(f.calls.map(call => call.effect), ['directIntro', 'directVideo', 'link'])
  assert.equal(f.calls[0].action.mode, 'direct-video'); assert.equal(f.calls[1].action.mode, 'direct-video')
  assert.ok(f.calls.at(-1).action.parts[0].text.includes('https://www.youtube.com/watch?v=Ab_Cd-9xYz0'))
  assert.equal(f.releases.get(job.id), 1)
})

for (const stage of ['directIntro', 'directVideo', 'link']) test(`YouTube ${stage} unknown stops later effects and freezes restart`, redisTest, async t => {
  const f = await fixture(t), job = await f.enqueue(0, youtubeShare())
  f.setSend(call => call.effect === stage ? { state: 'unknown' }
    : call.effect === 'directVideo' ? { state: 'failed', code: 'native_rejected' } : sent(`receipt-${f.calls.length}`))
  await f.outbox.start(); assert.equal((await f.finished(job)).state, 'unknown')
  const sequence = ['directIntro', 'directVideo', 'link'], expected = sequence.slice(0, sequence.indexOf(stage) + 1)
  assert.deepEqual(f.calls.map(call => call.effect), expected)
  await f.outbox.stop(); await f.create().start(); await f.idle(); assert.equal(f.calls.length, expected.length)
})

test('three YouTube preparation failures publish only the canonical identity and correct provider name', redisTest, async t => {
  const f = await fixture(t), job = await f.enqueue(0, youtubeShare())
  f.setPrepare(() => { throw new Error('https://private.googlevideo.com/?token=PRIVATE_TOKEN&cookie=PRIVATE_COOKIE') })
  await f.outbox.start(); await waitFor(async () => (await f.inspect(job)).prepareFailures === 1, 'first YouTube failure')
  f.advance(1000); await f.outbox.tick(); await waitFor(async () => (await f.inspect(job)).prepareFailures === 2, 'second YouTube failure')
  f.advance(3000); await f.outbox.tick(); assert.equal((await f.finished(job)).state, 'completed')
  assert.deepEqual(f.calls.map(call => call.effect), ['link'])
  const value = f.calls[0].action.parts[0].text
  assert.match(value, /YouTube/u); assert.ok(value.includes('https://www.youtube.com/watch?v=Ab_Cd-9xYz0'))
  for (const secret of ['PRIVATE_TOKEN', 'PRIVATE_COOKIE', 'googlevideo.com']) assert.equal(value.includes(secret), false)
})

test('YouTube prepared pages cannot change video identity, add queries or switch provider', redisTest, async t => {
  for (const pageUrl of ['https://www.youtube.com/watch?v=Zy_Xw-8vUt1', 'https://www.youtube.com/watch?v=Ab_Cd-9xYz0&si=tracking',
    'https://www.douyin.com/video/7123456789012345678']) await t.test(pageUrl, async t => {
    const f = await fixture(t), job = await f.enqueue(0, youtubeShare())
    f.setPrepare((_job, _scope, prepare) => ({ ...prepare(), pageUrl }))
    await f.outbox.start(); await waitFor(async () => (await f.inspect(job)).prepareFailures === 1, 'invalid YouTube prepared page rejected')
    assert.equal(f.calls.length, 0); assert.equal(f.releases.get(job.id), 1)
    f.setPrepare(undefined); f.advance(1000); await f.outbox.tick()
    assert.equal((await f.finished(job)).state, 'completed'); assert.deepEqual(f.calls.map(call => call.effect), ['directIntro', 'directVideo'])
  })
})

test('a gallery retries only a definite preprocessing failure and then sends one link without direct-video effects', redisTest, async t => {
  const f = await fixture(t), job = await f.enqueue(0, douyinShare('note'))
  f.setSend(call => ['forward', 'forwardRetry'].includes(call.effect) ? resourceFailure() : sent('gallery-link'))
  await f.outbox.start(); assert.equal((await f.finished(job)).state, 'completed')
  assert.deepEqual(f.calls.map(call => call.effect), ['forward', 'forwardRetry', 'link'])
  for (const call of f.calls.slice(0, 2)) assert.deepEqual(call.action.plan, gallery)
  assert.match(f.calls[2].action.parts[0].text, /https:\/\/www\.douyin\.com\/note\/7123456789012345678/u)
  assert.equal(f.releases.get(job.id), 1)
})

test('a gallery native rejection does not trigger retry while a successful single retry needs no link', redisTest, async t => {
  for (const rejection of ['native_rejected', 'media_resource_preprocessing_failed']) await t.test(rejection, async t => {
    const f = await fixture(t), job = await f.enqueue(0, douyinShare('note'))
    f.setSend(call => call.effect === 'forward' ? { state: 'failed', code: rejection } : sent('retry-success'))
    await f.outbox.start(); assert.equal((await f.finished(job)).state, rejection === 'native_rejected' ? 'failed' : 'completed')
    assert.deepEqual(f.calls.map(call => call.effect), rejection === 'native_rejected' ? ['forward'] : ['forward', 'forwardRetry'])
  })
})

for (const stage of ['forward', 'forwardRetry', 'link']) test(`gallery ${stage} unknown freezes every later effect and survives restart`, redisTest, async t => {
  const f = await fixture(t), job = await f.enqueue(0, douyinShare('note'))
  f.setSend(call => call.effect === stage ? { state: 'unknown' } : resourceFailure())
  await f.outbox.start(); assert.equal((await f.finished(job)).state, 'unknown')
  const expected = ['forward', 'forwardRetry', 'link'].slice(0, ['forward', 'forwardRetry', 'link'].indexOf(stage) + 1)
  assert.deepEqual(f.calls.map(call => call.effect), expected)
  await f.outbox.stop(); await f.create().start(); await f.idle(); assert.equal(f.calls.length, expected.length)
})

for (const kind of ['video', 'note', 'short']) test(`three Douyin ${kind} preparation failures fall back to a safe official reference only`, redisTest, async t => {
  const f = await fixture(t), job = await f.enqueue(0, douyinShare(kind, kind === 'short' ? 'Ab_9-z' : '7123456789012345678'))
  f.setPrepare(() => { throw new Error('https://private.cdn.invalid/?token=SECRET') })
  await f.outbox.start(); await waitFor(async () => (await f.inspect(job)).prepareFailures === 1, 'first failure')
  f.advance(1000); await f.outbox.tick(); await waitFor(async () => (await f.inspect(job)).prepareFailures === 2, 'second failure')
  f.advance(3000); await f.outbox.tick(); assert.equal((await f.finished(job)).state, 'completed')
  assert.deepEqual(f.calls.map(call => call.effect), ['link'])
  const text = f.calls[0].action.parts[0].text
  assert.ok(text.includes(kind === 'short' ? 'https://v.douyin.com/Ab_9-z/' : `https://www.douyin.com/${kind}/7123456789012345678`))
  assert.match(text, /抖音作品/u); assert.equal(text.includes('SECRET'), false)
})

test('a provider or item switch during preparation cancels its source and releases late resources', redisTest, async t => {
  for (const changed of [douyinShare('note', '7123456789012345679'), { provider: 'bilibili', reference: { kind: 'video', id: 'BV1234567890' } }]) await t.test(changed.provider, async t => {
    const f = await fixture(t), job = await f.enqueue(0, douyinShare('note')), held = gate()
    t.after(() => held.release())
    f.setPrepare(async (_job, _scope, prepared) => { const value = prepared(); await held.promise; return value })
    await f.outbox.start(); await waitFor(() => f.preparations.length === 1, 'held provider')
    job.source.share = changed; held.release()
    assert.equal((await f.finished(job)).state, 'cancelled'); assert.equal(f.calls.length, 0)
    assert.equal(f.releases.get(job.id), 1)
  })
})

test('a prepared cross-provider page or changed direct ID never reaches a native relay', redisTest, async t => {
  for (const url of ['https://www.bilibili.com/video/BV1234567890', 'https://www.douyin.com/note/8123456789012345678']) await t.test(url, async t => {
    const f = await fixture(t), job = await f.enqueue(0, douyinShare('note'))
    f.setPrepare((_job, _scope, prepare) => ({ ...prepare(), pageUrl: url }))
    await f.outbox.start(); await waitFor(async () => (await f.inspect(job)).prepareFailures === 1, 'invalid prepared page rejected')
    assert.equal(f.calls.length, 0); assert.equal(f.releases.get(job.id), 1)
    f.setPrepare(undefined); f.advance(1000); await f.outbox.tick()
    assert.equal((await f.finished(job)).state, 'completed'); assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0].effect, 'forward')
  })
})

test('Xiaohongshu prepares with a narrow immutable access reader and never persists temporary access', redisTest, async t => {
  const f = await fixture(t), job = await f.enqueue(0, xiaohongshuShare()), original = { provider: 'xiaohongshu', xsecToken: 'SOURCE_PRIVATE_TOKEN=', xsecSource: 'app_share', mediaKind: 'image' }
  job.access = original
  let scope, observed
  f.setPrepare(async (_job, context, prepared) => {
    scope = context
    assert.deepEqual(Object.keys(context).sort(), ['ensureCurrent', 'isCurrent', 'readSourceAccess', 'signal'])
    assert.ok(Object.isFrozen(context)); assert.equal(context.readSource, undefined); assert.equal(context.release, undefined)
    observed = await context.readSourceAccess()
    assert.deepEqual(observed, original); assert.notEqual(observed, original); assert.ok(Object.isFrozen(observed))
    assert.ok(f.reads.length >= 2, 'access was separately reread after initial preparation authorization')
    return prepared()
  })
  await f.outbox.start(); assert.equal((await f.finished(job)).state, 'completed')
  assert.equal(scope.signal.aborted, true); await assert.rejects(scope.readSourceAccess())
  const record = await f.reader.get(f.prefix + `agent:media-outbox:v1:job:${job.id}`)
  for (const secret of ['SOURCE_PRIVATE_TOKEN', 'xsecToken', 'xsecSource', 'app_share', 'access', 'base64']) assert.equal(record.includes(secret), false)
  assert.equal(JSON.stringify(f.calls).includes('SOURCE_PRIVATE_TOKEN'), false)
})

test('Xiaohongshu source access is reacquired from the original message after an unsent restart', redisTest, async t => {
  const f = await fixture(t), job = await f.enqueue(0, xiaohongshuShare()), held = gate(), access = []
  t.after(() => held.release())
  job.access = { provider: 'xiaohongshu', xsecToken: 'FIRST_PRIVATE_TOKEN' }
  f.setPrepare(async (_job, context, prepared) => { access.push(await context.readSourceAccess()); await held.promise; return prepared() })
  await f.outbox.start(); await waitFor(() => access.length === 1, 'first task-local access read')
  await f.outbox.stop(); held.release(); await waitFor(() => f.releases.get(job.id) === 1, 'late first lease released')
  job.access = { provider: 'xiaohongshu', xsecToken: 'FRESH_PRIVATE_TOKEN' }
  f.setPrepare(async (_job, context, prepared) => { access.push(await context.readSourceAccess()); return prepared() })
  await f.create().start(); assert.equal((await f.finished(job)).state, 'completed')
  assert.deepEqual(access.map(value => value.xsecToken), ['FIRST_PRIVATE_TOKEN', 'FRESH_PRIVATE_TOKEN'])
  assert.equal(f.calls.length, 1); assert.equal(f.releases.get(job.id), 2)
  const raw = await f.reader.get(f.prefix + `agent:media-outbox:v1:job:${job.id}`)
  for (const token of ['FIRST_PRIVATE_TOKEN', 'FRESH_PRIVATE_TOKEN']) assert.equal(raw.includes(token), false)
})

for (const change of ['share', 'sender', 'occurredAt', 'visibility', 'privacy']) test(`Xiaohongshu access reread ${change} revocation cancels without a link fallback`, redisTest, async t => {
  const f = await fixture(t), job = await f.enqueue(0, xiaohongshuShare())
  job.access = { provider: 'xiaohongshu', xsecToken: 'DO_NOT_BORROW' }
  let context
  f.setPrepare(async (_job, scope, prepared) => {
    context = scope
    if (change === 'share') job.source.share = xiaohongshuShare('note', '651a2b3c000000000d0e0f10')
    if (change === 'sender') job.message.sender = { ...job.message.sender, id: 'replacement-human' }
    if (change === 'occurredAt') job.message.occurredAt--
    if (change === 'visibility') job.missing = true
    if (change === 'privacy') job.current = false
    await assert.rejects(scope.readSourceAccess())
    return prepared()
  })
  await f.outbox.start(); assert.equal((await f.finished(job)).state, 'cancelled')
  assert.equal(context.signal.aborted, true); assert.equal(f.calls.length, 0)
  await f.create().start(); await f.idle(); assert.equal(f.calls.length, 0)
})

test('a late source access result cannot survive revocation while its read is pending', redisTest, async t => {
  const f = await fixture(t), job = await f.enqueue(0, xiaohongshuShare()), entered = gate(), held = gate()
  t.after(() => held.release())
  job.access = { provider: 'xiaohongshu', xsecToken: 'LATE_PRIVATE_TOKEN' }
  f.setPrepare(async (_job, context, prepared) => {
    f.setRead(async (_job, read) => { const result = read(); entered.release(); await held.promise; return result })
    await assert.rejects(context.readSourceAccess())
    return prepared()
  })
  await f.outbox.start(); await entered.promise; job.current = false; held.release()
  assert.equal((await f.finished(job)).state, 'cancelled'); assert.equal(f.calls.length, 0)
})

for (const shape of ['getter', 'inherited']) test(`Xiaohongshu ${shape} access never invokes behavior or returns a token`, redisTest, async t => {
  const f = await fixture(t), job = await f.enqueue(0, xiaohongshuShare())
  let touched = false, supplied = false
  f.setPrepare(async (_job, context, prepared) => {
    f.setRead((_job, read) => {
      const original = read(), access = { provider: 'xiaohongshu', xsecToken: 'HIDDEN_PRIVATE_TOKEN' }
      if (shape === 'inherited') return Object.assign(Object.create({ access }), original)
      return Object.defineProperty(original, 'access', { get() { touched = true; return access } })
    })
    await assert.rejects(context.readSourceAccess()); supplied = true
    return prepared()
  })
  await f.outbox.start(); assert.equal((await f.finished(job)).state, 'cancelled')
  assert.equal(touched, false); assert.equal(supplied, true); assert.equal(f.calls.length, 0)
})

test('revocation during the final access guard prevents a validated token from leaving the narrow context', redisTest, async t => {
  const f = await fixture(t), job = await f.enqueue(0, xiaohongshuShare()), entered = gate(), held = gate()
  t.after(() => held.release())
  job.access = { provider: 'xiaohongshu', xsecToken: 'GUARDED_PRIVATE_TOKEN' }
  let active = false, checks = 0, returned = false
  f.setOpen((_record, _signal, create) => {
    const context = create(), original = context.ensureCurrent
    return { ...context, async ensureCurrent() {
      await original()
      if (active && ++checks === 3) { entered.release(); await held.promise }
    } }
  })
  f.setPrepare(async (_job, context, prepared) => {
    active = true
    await assert.rejects(context.readSourceAccess()); returned = true
    return prepared()
  })
  await f.outbox.start(); await entered.promise; job.current = false; held.release()
  assert.equal((await f.finished(job)).state, 'cancelled'); assert.equal(returned, true); assert.equal(f.calls.length, 0)
})

for (const stage of ['forward', 'forwardRetry', 'link']) test(`Xiaohongshu gallery ${stage} unknown remains frozen after restart`, redisTest, async t => {
  const f = await fixture(t), job = await f.enqueue(0, xiaohongshuShare())
  f.setSend(call => call.effect === stage ? { state: 'unknown' } : resourceFailure())
  await f.outbox.start(); assert.equal((await f.finished(job)).state, 'unknown')
  const expected = ['forward', 'forwardRetry', 'link'].slice(0, ['forward', 'forwardRetry', 'link'].indexOf(stage) + 1)
  assert.deepEqual(f.calls.map(call => call.effect), expected)
  await f.outbox.stop(); await f.create().start(); await f.idle(); assert.equal(f.calls.length, expected.length)
})

test('three Xiaohongshu preparation failures publish only a safe canonical link and correct provider name', redisTest, async t => {
  for (const selected of [xiaohongshuShare(), xiaohongshuShare('short', 'a/Ab_C9')]) await t.test(selected.reference.kind, async t => {
    const f = await fixture(t), job = await f.enqueue(0, selected)
    f.setPrepare(() => { throw new Error('https://www.xiaohongshu.com/explore/id?xsec_token=PRIVATE') })
    await f.outbox.start(); await waitFor(async () => (await f.inspect(job)).prepareFailures === 1, 'first XHS failure')
    f.advance(1000); await f.outbox.tick(); await waitFor(async () => (await f.inspect(job)).prepareFailures === 2, 'second XHS failure')
    f.advance(3000); await f.outbox.tick(); assert.equal((await f.finished(job)).state, 'completed')
    assert.deepEqual(f.calls.map(call => call.effect), ['link'])
    const value = f.calls[0].action.parts[0].text
    assert.match(value, /小红书笔记/u)
    assert.ok(value.includes(selected.reference.kind === 'short' ? 'https://xhslink.com/a/Ab_C9' : 'https://www.xiaohongshu.com/explore/6ad4a9c200000000290162d4'))
    assert.equal(value.includes('xsec_token'), false); assert.equal(value.includes('PRIVATE'), false)
  })
})

test('disconnected wait contexts remain queued without recursive polling or preparation', redisTest, async t => {
  const f = await fixture(t), job = await f.enqueue(); let waiting = true
  f.setOpen((_record, _signal, create) => waiting ? 'wait' : create())
  await f.outbox.start(); await delay(100)
  assert.equal(f.opens.length, 1); assert.equal(f.preparations.length, 0); assert.equal((await f.inspect(job)).state, 'queued')
  await f.outbox.tick(); await delay(50); assert.equal(f.opens.length, 2)
  waiting = false; await f.outbox.tick(); assert.equal((await f.finished(job)).state, 'completed')
})

test('expired preheats release all leases before a fresh preparation can deliver', redisTest, async t => {
  const f = await fixture(t), first = await f.enqueue(), second = await f.enqueue(), held = gate()
  f.setSend(async call => { if (call.id === first.id) await held.promise; return sent(`receipt-${f.calls.length}`) })
  await f.outbox.start(); await waitFor(() => f.calls.length === 1 && f.preparations.includes(second.id), 'successor preheated')
  await f.idle()
  f.advance(180_001); await f.outbox.tick(); await waitFor(() => f.releases.get(second.id) === 1, 'expired preheat release')
  assert.equal(f.calls.some(call => call.id === second.id), false)
  held.release(); await f.finished(first); await f.finished(second)
  assert.equal(f.preparations.filter(id => id === second.id).length, 2); assert.equal(f.releases.get(second.id), 2)
})

test('Bilibili delivers one forward with the card followed by every video and thumbnail', redisTest, async t => {
  const f = await fixture(t), job = await f.enqueue()
  await f.outbox.start(); const record = await f.finished(job)
  assert.equal(record.state, 'completed'); assert.deepEqual(f.calls.map(call => call.effect), ['forward'])
  const forward = f.calls[0].action
  assert.equal(forward.mode, 'forward'); assert.deepEqual(forward.plan, plan(`搬运 ${job.source.messageId}`, true))
  assert.deepEqual(record.effects.map(row => [row.effect, row.state]), [['forward', 'sent']]); assert.equal(f.releases.get(job.id), 1)
  const raw = await f.reader.get(f.prefix + `agent:media-outbox:v1:job:${job.id}`)
  for (const secret of ['sha256', firstVideo.id, '搬运 source', 'bilivideo.com', 'base64', '/tmp/']) assert.equal(raw.includes(secret), false)
})

test('Bilibili preserves the image-only card after a definite video rejection', redisTest, async t => {
  const f = await fixture(t), job = await f.enqueue()
  f.setSend(call => call.effect === 'link' ? sent('bilibili-link') : resourceFailure())
  await f.outbox.start(); const record = await f.finished(job)
  assert.equal(record.state, 'completed'); assert.deepEqual(f.calls.map(call => call.effect), ['forward', 'forwardRetry', 'link'])
  const fallback = f.calls[1].action.plan.items
  assert.equal(fallback.length, 1)
  assert.deepEqual(fallback[0].parts, [{ kind: 'image', artifact: cover }])
  assert.match(f.calls[2].action.parts[0].text, /已附原作品链接/u)
  assert.deepEqual(record.effects.map(effect => effect.state), ['failed', 'failed', 'sent'])
})

for (const stage of ['forward', 'forwardRetry', 'link']) test(`Bilibili ${stage} unknown stops every later fallback and cannot replay on restart`, redisTest, async t => {
  const f = await fixture(t), job = await f.enqueue()
  f.setSend(call => call.effect === stage ? { state: 'unknown' } : resourceFailure())
  const sequence = ['forward', 'forwardRetry', 'link'], expected = sequence.slice(0, sequence.indexOf(stage) + 1)
  await f.outbox.start(); const record = await f.finished(job)
  assert.equal(record.state, 'unknown'); assert.deepEqual(f.calls.map(call => call.effect), expected)
  await f.outbox.stop(); const restarted = f.create(); await restarted.start(); await f.idle(); assert.equal(f.calls.length, expected.length)
})

test('a channel thumbnail rejection can deliver the native card while videos stay provider-owned until cleanup', redisTest, async t => {
  const f = await fixture(t), job = await f.enqueue()
  f.setSend(call => call.effect === 'forward' ? { state: 'failed', code: 'video_thumbnail_missing' } : sent(`receipt-${f.calls.length}`))
  await f.outbox.start(); const record = await f.finished(job)
  assert.equal(record.state, 'completed'); assert.deepEqual(f.calls.map(call => call.effect), ['forward', 'forwardRetry']); assert.equal(f.releases.get(job.id), 1)
})

for (const fault of ['begin-not-written', 'begin-ack-lost', 'finish-not-written', 'finish-ack-lost']) test(`${fault} obeys durable pending evidence and never advances an uncertain effect`, redisTest, async t => {
  const f = await fixture(t), job = await f.enqueue(); let armed = true, faults = 0
  f.setEval(async (_script, options, run) => {
    let next; try { next = JSON.parse(options.arguments[1]) } catch {}
    const effect = next?.effects?.at(-1)
    const selected = fault.startsWith('begin') ? effect?.state === 'pending' : effect?.state === 'sent'
    if (!armed || !selected) return run()
    armed = false; faults++
    if (fault.endsWith('ack-lost')) await run()
    throw new Error('synthetic Redis response failure')
  })
  await f.outbox.start(); const record = await f.finished(job)
  assert.equal(faults, 1)
  if (fault === 'begin-not-written') { assert.equal(record.state, 'completed'); assert.equal(f.calls.length, 1); assert.equal(f.preparations.length, 2) }
  else { assert.equal(record.state, 'unknown'); assert.equal(f.calls.length, fault === 'begin-ack-lost' ? 0 : 1) }
  await f.outbox.stop(); await f.create().start(); await f.idle(); assert.equal(f.calls.length, fault === 'begin-ack-lost' ? 0 : 1)
})

test('source revocation cleans a preheat and a late preparation result without any native send', redisTest, async t => {
  const f = await fixture(t), first = await f.enqueue(), second = await f.enqueue(), held = gate(), reached = gate()
  f.setPrepare(async (job, _scope, prepared) => { if (job.id === first.id) { reached.release(); await held.promise }; return prepared() })
  await f.outbox.start(); await bounded(reached.promise); await waitFor(() => f.preparations.includes(second.id), 'second preparation')
  await f.outbox.cancelSource(first.binding.target, first.source.messageId); held.release()
  assert.equal((await f.finished(first)).state, 'cancelled'); assert.equal((await f.finished(second)).state, 'completed')
  await waitFor(() => f.releases.get(first.id) === 1, 'late result lease cleanup'); assert.equal(f.calls.some(call => call.id === first.id), false)
})

test('revoking an already prepared FIFO successor releases it immediately and never schedules it later', redisTest, async t => {
  const f = await fixture(t), first = await f.enqueue(), second = await f.enqueue(), held = gate()
  f.setSend(async call => { if (call.id === first.id) await held.promise; return sent('first-receipt') })
  await f.outbox.start(); await waitFor(() => f.calls.length === 1 && f.preparations.includes(second.id), 'queued preheat'); await f.idle()
  await f.outbox.cancelSource(second.binding.target, second.source.messageId)
  assert.equal(f.releases.get(second.id), 1); assert.equal((await f.inspect(second)).state, 'cancelled')
  held.release(); await f.finished(first); await f.idle(); assert.deepEqual([...new Set(f.calls.map(call => call.id))], [first.id])
})

for (const stage of ['preparing', 'prepared', 'sending']) test(`a sibling account recall aborts ${stage} work before a durable cancellation CAS failure and cleans it once`, redisTest, async t => {
  const f = await fixture(t), first = await f.enqueue(), second = await f.enqueue(), victim = stage === 'sending' ? first : second,
    unaffected = stage === 'sending' ? second : first, providerHeld = gate(), nativeHeld = gate(), nativeReached = gate(), tombstoneReached = gate(), ledgerHeld = gate()
  const scopes = new Map(), releaseCalls = new Map()
  let tombstoneKey, faults = 0
  t.after(() => { providerHeld.release(); nativeHeld.release(); ledgerHeld.release() })
  f.setPrepare(async (job, scope, create) => {
    scopes.set(job.id, scope)
    if (job.id === victim.id && stage === 'preparing') await providerHeld.promise
    const value = create()
    return { ...value, async release() { releaseCalls.set(job.id, (releaseCalls.get(job.id) ?? 0) + 1); await value.release() } }
  })
  f.setSend(async call => {
    if (call.id === first.id) { nativeReached.release(); await nativeHeld.promise }
    return call.id === victim.id ? resourceFailure() : sent('unaffected-receipt')
  })
  await f.outbox.start(); await waitFor(async () => { await f.outbox.tick(); return f.calls.length === 1 }, 'native lane head'); await bounded(nativeReached.promise)
  await waitFor(() => scopes.size === 2, 'both owned contexts')
  if (stage !== 'preparing') await f.idle()
  f.setEval(async (script, options, run) => {
    if (script.includes('return redis.call("SET", KEYS[1], "1", "EX", ARGV[1])')) {
      const result = await run(); tombstoneKey = options.keys[0]; tombstoneReached.release(); await ledgerHeld.promise; return result
    }
    let next; try { next = JSON.parse(options.arguments[1]) } catch {}
    if (next?.id === victim.id && ['cancelled', 'unknown'].includes(next.state)) {
      await tombstoneReached.promise; faults++; throw new Error('synthetic cancellation CAS response failure')
    }
    return run()
  })
  const observer = { ...victim.binding.target, account: { ...victim.binding.target.account, id: '19000502' } }
  const cancellation = assert.rejects(f.outbox.cancelSource(observer, victim.source.messageId))
  assert.equal(scopes.get(victim.id).signal.aborted, true, 'in-memory revocation precedes every Redis await')
  assert.equal(scopes.get(unaffected.id).signal.aborted, false, 'another source retains its context')
  await bounded(tombstoneReached.promise); assert.equal(await f.reader.get(f.prefix + tombstoneKey), '1')
  providerHeld.release()
  if (stage === 'sending') nativeHeld.release()
  ledgerHeld.release(); await bounded(cancellation)
  await waitFor(() => f.contextReleases.get(victim.id) === 1, 'cancelled context release')
  await waitFor(() => releaseCalls.get(victim.id) === 1, 'late or prepared artifact release')
  assert.ok(faults >= 8, 'durable cancellation exhausted its CAS retries after saving the tombstone')
  f.setEval(undefined); nativeHeld.release(); await f.finished(unaffected); await f.idle()
  assert.equal((await f.finished(victim)).state, stage === 'sending' ? 'unknown' : 'cancelled')
  assert.deepEqual(f.calls.filter(call => call.id === victim.id).map(call => call.effect), stage === 'sending' ? ['forward'] : [])
  await f.outbox.stop(); await f.outbox.stop()
  for (const job of [victim, unaffected]) { assert.equal(f.contextReleases.get(job.id), 1); assert.equal(releaseCalls.get(job.id), 1); assert.equal(f.releases.get(job.id), 1) }
})

test('three bounded preparation failures preserve FIFO and send a native card with the safe link', redisTest, async t => {
  const f = await fixture(t), first = await f.enqueue(), second = await f.enqueue()
  f.setPrepare(async (job, _scope, prepared) => { if (job.id === first.id) throw new Error('/private/provider/url?credential=SECRET'); return prepared() })
  await f.outbox.start()
  await waitFor(async () => (await f.inspect(first)).prepareFailures === 1, 'first preparation backoff'); await f.idle(); assert.equal(f.calls.length, 0)
  f.advance(1000); await f.outbox.tick(); await waitFor(async () => (await f.inspect(first)).prepareFailures === 2, 'second preparation backoff')
  assert.equal(f.calls.length, 0); f.advance(3000); await f.outbox.tick()
  const record = await f.finished(first); await f.finished(second)
  assert.equal(record.prepareAttempts, 3); assert.equal(record.state, 'completed')
  assert.deepEqual(f.calls.map(call => [call.id, call.effect]), [[first.id, 'forward'], [second.id, 'forward']])
  const parts = f.calls[0].action.plan.items.flatMap(item => item.parts)
  assert.deepEqual(parts.map(part => part.kind), ['text'])
  assert.match(parts[0].text, /视频资源准备失败/)
  assert.equal(parts[0].text.includes('SECRET'), false)
})

test('stop during preparation cleans late results and restart safely re-prepares only unsent work', redisTest, async t => {
  const f = await fixture(t), job = await f.enqueue(), held = gate(), reached = gate()
  f.setPrepare(async (_job, _scope, prepared) => { reached.release(); await held.promise; return prepared() })
  await f.outbox.start(); await bounded(reached.promise); await bounded(f.outbox.stop())
  held.release(); await waitFor(() => f.releases.get(job.id) === 1, 'stopped late preheat release')
  assert.equal(f.calls.length, 0); f.setPrepare(undefined); await f.create().start(); assert.equal((await f.finished(job)).state, 'completed')
  assert.equal(f.calls.length, 1); assert.equal(f.releases.get(job.id), 2)
})

test('stop while Redis claim is pending never opens a context after returning or leaves a live owner', redisTest, async t => {
  const f = await fixture(t), job = await f.enqueue(), reached = gate(), held = gate(); let intercepted = false
  f.setEval(async (script, options, run) => {
    const value = await run()
    if (!intercepted && script.includes("redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])")) { intercepted = true; reached.release(); await held.promise }
    return value
  })
  const start = f.outbox.start(); await bounded(reached.promise); await bounded(f.outbox.stop()); held.release(); await bounded(start); await delay(50)
  assert.equal(f.opens.length, 0); assert.equal(f.preparations.length, 0); assert.equal(f.calls.length, 0)
  await waitFor(async () => await f.reader.get(f.prefix + `agent:media-outbox:v1:owner:${job.id}`) === null, 'late owner release')
  f.setEval(undefined); await f.create().start(); assert.equal((await f.finished(job)).state, 'completed')
})

test('stop during openContext releases a late host context and does not prepare or send', redisTest, async t => {
  const f = await fixture(t), job = await f.enqueue(), reached = gate(), held = gate()
  f.setOpen(async (_record, _signal, create) => { reached.release(); await held.promise; return create() })
  await f.outbox.start(); await bounded(reached.promise); await bounded(f.outbox.stop()); held.release()
  await waitFor(() => f.contextReleases.get(job.id) === 1, 'late open context cleanup')
  assert.equal(f.preparations.length, 0); assert.equal(f.calls.length, 0)
})

test('stop during a dispatched native call freezes its pending effect and prevents every fallback', redisTest, async t => {
  const f = await fixture(t), job = await f.enqueue(), reached = gate()
  f.setSend(async call => { reached.release(); await new Promise(resolve => call.guard.signal.addEventListener('abort', resolve, { once: true })); return sent('late-native-success') })
  await f.outbox.start(); await bounded(reached.promise); await bounded(f.outbox.stop())
  await f.create().start(); await f.idle(); assert.equal((await f.inspect(job)).state, 'unknown'); assert.equal(f.calls.length, 1)
})
