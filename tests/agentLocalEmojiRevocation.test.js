import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile, symlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { setImmediate as tick } from 'node:timers/promises'
import sharp from 'sharp'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { createAgentLocalEmojiRuntime } = await load('modules/emoji/infrastructure/agentLocalEmojiRuntime.js')
const digest = value => createHash('sha256').update(value).digest('hex')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function until(check) { for (let i = 0; i < 1000; i++) { if (check()) return; await tick() } assert.fail('fixture boundary unavailable') }
const model = { baseUrl: 'https://emoji.example.test/v1', model: 'fixture-vision', apiKey: 'fixture-provenance-secret' }
const response = value => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { headers: { 'content-type': 'application/json' } })
const accepted = () => response({ is_emoji: true, safe: true, confidence: 0.99 })
function guard() { const controller = new AbortController(); return { signal: controller.signal, isCurrent: () => !controller.signal.aborted, async ensureCurrent() { controller.signal.throwIfAborted() }, controller } }
function context({ agent = 'alice', account = '10001', group = '20001', subject = 'source-person', id = 'message-1', at = 1000 } = {}) {
  const fence = guard(), sent = []
  const binding = { source: 'configured', id: 'binding-' + account + '-' + group, revision: 'v1', agentId: agent, personaId: 'shared-template', connectionId: 'connection-' + account,
    target: { account: { platform: 'qq', namespace: 'global', id: account }, kind: 'group', id: group } }
  const author = { platform: 'qq', namespace: 'global', id: subject }
  return { ...fence, sent, binding, source: { messageId: id, author, occurredAt: at }, actor: { kind: 'user', user: author }, request: { messageId: id, text: '开心表情', mentions: [] },
    async sendImage(image, supplied) { await supplied?.ensureCurrent?.(); assert.notEqual(supplied?.isCurrent(), false); sent.push(image); return { state: 'sent', messageId: 'sent-1' } },
    async sendBundle(items, supplied) { await supplied?.ensureCurrent?.(); assert.notEqual(supplied?.isCurrent(), false); sent.push(items); return { state: 'sent', messageId: 'sent-1' } } }
}
async function image(seed = 0) {
  const pixels = Buffer.from(Array.from({ length: 100 * 100 * 3 }, (_, i) => (i * 37 + Math.floor(i / 79) * 19 + seed) % 256))
  return { mime: 'image/png', base64: (await sharp(pixels, { raw: { width: 100, height: 100, channels: 3 } }).png().toBuffer()).toString('base64') }
}
async function fixture(t, extra = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'emoji-revocation-')))
  const options = { dataDir: root, enabled: true, config: { useEmbedding: false, doReplace: false, sendAsSticker: false }, analysis: model,
    async fetch(url, init) {
      if (extra.fetch) return extra.fetch(url, init)
      const body = JSON.parse(init.body)
      return body.messages[0].content[0]?.text?.includes('判定一') ? accepted() : response({ description: '开心猫猫', tags: ['开心'], use_cases: ['接梗'] })
    }, ...extra.options }
  const f = { root, options, runtime: createAgentLocalEmojiRuntime(options),
    folder(agent = 'alice') { return path.join(root, 'emoji', 'agents', digest(agent)) },
    async items(agent) { const text = await readFile(path.join(this.folder(agent), 'emoji-packs.ndjson'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error }); return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) },
    async sources(agent) { return JSON.parse(await readFile(path.join(this.folder(agent), 'emoji-sources.json'), 'utf8')) },
    async restart(overrides = {}) { await this.runtime.close(); this.runtime = createAgentLocalEmojiRuntime({ ...options, ...overrides }); return this.runtime },
    send(ctx, input = { tags: ['开心'] }) { return this.runtime.builtIn[0].execute(input, ctx) },
    purge(ctx, through, extra = {}) { return this.runtime.purgeSubject({ agentId: ctx.binding.agentId, account: ctx.binding.target.account, subjectId: ctx.source.author.id, through, ...extra }, guard()) },
    revoke(ctx) { return this.runtime.revokeSource({ target: ctx.binding.target, messageId: ctx.source.messageId }, guard()) } }
  t.after(async () => { await f.runtime.close(); await rm(root, { recursive: true, force: true }) })
  return f
}

test('duplicate image records independent verified sources and removes bytes only after the final source is revoked', async t => {
  const f = await fixture(t), bytes = await image(), a = context(), b = context({ id: 'message-2', subject: 'other-person', group: 'other-group', at: 2000 })
  assert.equal((await f.runtime.collect(bytes, a)).ok, true); assert.equal((await f.runtime.collect(bytes, b)).ok, true)
  const [item] = await f.items(), proof = await f.sources()
  assert.equal(proof.images[item.hash].sources.length, 2)
  assert.equal(JSON.stringify(proof).includes('source-person'), false); assert.equal(JSON.stringify(proof).includes('message-1'), false)
  assert.deepEqual(await f.revoke(a), { usage: 'blocked', cleanup: 'completed', removedSources: 1, removedImages: 0, unattributedImages: 0 })
  const sending = context({ account: 'different-connection' }); assert.equal((await f.send(sending)).status, 'succeeded'); assert.equal(sending.sent.length, 1)
  assert.deepEqual(await f.revoke(b), { usage: 'blocked', cleanup: 'completed', removedSources: 1, removedImages: 1, unattributedImages: 0 })
  assert.deepEqual(await f.items(), []); assert.equal(fs.existsSync(path.join(f.folder(), item.file)), false)
  assert.equal((await f.runtime.collect(bytes, a)).ok, false); assert.equal((await f.runtime.collect(bytes, b)).ok, false)
})

test('source revocation scans unopened persistent Agents and preserves complete-account and conversation boundaries', async t => {
  const f = await fixture(t), bytes = await image(), alice = context(), bob = context({ agent: 'bob' }), otherAccount = context({ account: '10002' }), otherGroup = context({ group: '20002' })
  for (const ctx of [alice, bob, otherAccount, otherGroup]) assert.equal((await f.runtime.collect(bytes, ctx)).ok, true)
  await f.restart()
  const receipt = await f.revoke(alice)
  assert.equal(receipt.cleanup, 'completed'); assert.equal(receipt.removedSources, 2); assert.equal(receipt.removedImages, 1)
  assert.deepEqual(await f.items('bob'), []); assert.equal((await f.items()).length, 1)
  assert.equal(Object.values((await f.sources()).images)[0].sources.length, 2)
  await f.restart()
  assert.equal((await f.runtime.collect(bytes, alice)).ok, false)
  const alive = context({ account: '10002' }); await f.send(alive); assert.equal(alive.sent.length, 1)
})

test('subject purge is isolated by Agent, account and optional full target, and works after owner binding changes', async t => {
  const f = await fixture(t), a = context(), b = context({ group: 'second-group', id: 'second' }), c = context({ agent: 'bob' }), d = context({ account: '10002' })
  for (const [index, ctx] of [a, b, c, d].entries()) await f.runtime.collect(await image(index), ctx)
  assert.equal((await f.purge(a, 2000, { target: a.binding.target })).removedImages, 1)
  assert.equal((await f.items()).length, 2); assert.equal((await f.items('bob')).length, 1)
  a.binding.revision = 'after-owner-rebinding'
  const allAccount = await f.purge(a, 3000)
  assert.equal(allAccount.removedImages, 1); assert.equal(allAccount.cleanup, 'completed')
  assert.equal((await f.items()).length, 1); assert.equal((await f.items('bob')).length, 1)
})

test('accepted purge watermarks include existing clock-skewed sources, while same and older through values never absorb new sources', async t => {
  const f = await fixture(t), a = context({ at: 1000 }), skewed = context({ id: 'future-old', at: 10_000 })
  await f.runtime.collect(await image(), a); await f.runtime.collect(await image(1), skewed)
  assert.equal((await f.purge(a, 2000)).removedImages, 2)
  const fresh = context({ id: 'fresh-after-command', at: 20_000 }); assert.equal((await f.runtime.collect(await image(2), fresh)).ok, true)
  await f.restart()
  for (const through of [2000, 1000]) { const replay = await f.purge(a, through); assert.equal(replay.removedImages, 0); assert.equal(replay.cleanup, 'completed') }
  assert.equal((await f.items()).length, 1)
  assert.equal((await f.purge(a, 3000)).removedImages, 1)
})

test('revocation is durable and cancels in-flight collection without waiting for an uncooperative model', async t => {
  const gate = deferred(), started = deferred(), f = await fixture(t, { fetch(_url, init) { started.resolve(init.signal); return gate.promise } }), ctx = context({ at: 50_000 })
  const collecting = f.runtime.collect(await image(), ctx); const signal = await started.promise
  const cleaning = f.purge(ctx, 1000)
  await until(() => signal.aborted)
  assert.equal(signal.aborted, true)
  const receipt = await cleaning
  assert.equal(receipt.cleanup, 'completed'); assert.equal((await collecting).ok, false)
  const durable = JSON.parse(await readFile(path.join(f.root, 'emoji', 'revocations.json'), 'utf8'))
  assert.equal(durable.subjects[0].effectiveThrough, 50_000)
  gate.resolve(accepted()); await tick(); assert.deepEqual(await f.items(), [])
})

test('last-source revocation invalidates the supplied delivery guard before a queued image or bundle can dispatch', async t => {
  for (const bundle of [false, true]) {
    const f = await fixture(t), ctx = context(), bytes = await image()
    await f.runtime.collect(bytes, ctx)
    const gate = deferred(), started = deferred(); let dispatched = 0, supplied
    const deliver = async (_value, extra) => { supplied = extra; started.resolve(); await gate.promise; if (extra.isCurrent()) { await extra.ensureCurrent(); dispatched++ } return { state: 'failed' } }
    if (bundle) ctx.sendBundle = deliver; else ctx.sendImage = deliver
    const sending = f.send(ctx, { tags: ['开心'], ...(bundle ? { leadText: '一起开心' } : {}) }); await started.promise
    const cleaning = f.revoke(ctx)
    await until(() => !supplied.isCurrent())
    assert.equal(supplied.isCurrent(), false); assert.equal(supplied.signal.aborted, true)
    const receipt = await cleaning; assert.equal(receipt.cleanup, 'completed')
    gate.resolve(); await sending; await tick(); assert.equal(dispatched, 0)
  }
})

test('revoking one of multiple sources preserves an already selected send whose other source remains valid', async t => {
  const f = await fixture(t), a = context(), b = context({ id: 'another', subject: 'another-person' }), bytes = await image()
  await f.runtime.collect(bytes, a); await f.runtime.collect(bytes, b)
  const gate = deferred(), started = deferred(); let supplied, dispatched = 0
  a.sendImage = async (_value, extra) => { supplied = extra; started.resolve(); await gate.promise; await extra.ensureCurrent(); dispatched++; return { state: 'sent', messageId: 'sent-1' } }
  const sending = f.send(a); await started.promise
  const cleaning = f.revoke(a)
  await until(() => fs.existsSync(path.join(f.root, 'emoji', 'revocations.json')))
  assert.equal(supplied.isCurrent(), true); assert.equal(supplied.signal.aborted, false)
  gate.resolve(); assert.equal((await sending).status, 'succeeded'); assert.equal(dispatched, 1)
  assert.equal((await cleaning).removedSources, 1); assert.equal((await f.items()).length, 1)
})

test('unlink failure leaves durable blocked deletion intent, prevents maintenance resurrection, and permits safe cleanup retry after restart', async t => {
  const f = await fixture(t, { options: { config: { useEmbedding: false, enableMaintenance: true, visionTagOnAdd: false, checkIntervalMinutes: 1 } } }), ctx = context()
  await f.runtime.collect(await image(), ctx)
  const [item] = await f.items(), location = path.join(f.folder(), item.file), original = fs.unlinkSync
  const mock = t.mock.method(fs, 'unlinkSync', target => { if (String(target) === location) throw Object.assign(Error('fixture unlink refused'), { code: 'EACCES' }); return original(target) })
  const failed = await f.revoke(ctx)
  assert.equal(failed.cleanup, 'unknown'); assert.equal(failed.removedSources, 1); assert.equal(failed.removedImages, 0); assert.equal(fs.existsSync(location), true)
  assert.deepEqual(await f.items(), []); assert.equal((await f.sources()).images[item.hash].pendingDelete, true)
  mock.mock.restore(); await f.restart()
  const sender = context({ id: 'new-send' }); await f.send(sender); assert.equal(sender.sent.length, 0); assert.deepEqual(await f.items(), [])
  const retried = await f.revoke(ctx); assert.equal(retried.cleanup, 'completed'); assert.equal(retried.removedImages, 1); assert.equal(fs.existsSync(location), false)
})

test('pre-ledger verified records stay quarantined and retained, report unsupported, and only verified recollection restores proof', async t => {
  const f = await fixture(t), old = context(), bytes = await image()
  await f.runtime.collect(bytes, old); const [item] = await f.items()
  await f.runtime.close(); await rm(path.join(f.folder(), 'emoji-sources.json')); await f.restart()
  const caller = context({ id: 'later-request', at: 5000 }); await f.send(caller); assert.equal(caller.sent.length, 0)
  const receipt = await f.revoke(old)
  assert.equal(receipt.cleanup, 'unsupported'); assert.equal(receipt.unattributedImages, 1); assert.equal((await f.items()).length, 1); assert.equal(fs.existsSync(path.join(f.folder(), item.file)), true)
  assert.equal((await f.runtime.collect(bytes, old)).ok, false)
  assert.equal((await f.runtime.collect(bytes, caller)).ok, true); await f.send(caller); assert.equal(caller.sent.length, 1)
})

test('legacy archive provenance is never fabricated or subject-deleted, and disabled runtime can still clear attributable history', async t => {
  const f = await fixture(t), ctx = context()
  await f.runtime.collect(await image(), ctx)
  const [item] = await f.items(); item.source = 'legacy-archive:' + 'a'.repeat(64)
  await writeFile(path.join(f.folder(), 'emoji-packs.ndjson'), JSON.stringify(item) + '\n'); await rm(path.join(f.folder(), 'emoji-sources.json'))
  await f.restart({ enabled: false, config: {} }); assert.deepEqual(f.runtime.builtIn, [])
  assert.deepEqual(await f.purge(ctx, 2000), { usage: 'blocked', cleanup: 'completed', removedSources: 0, removedImages: 0, unattributedImages: 1 })
  assert.equal((await f.items()).length, 1)
  await f.restart(); const second = context({ id: 'real-new-source', at: 5000 }); await f.runtime.collect(await image(1), second)
  await f.restart({ enabled: false, config: {} })
  const cleaned = await f.revoke(second); assert.equal(cleaned.cleanup, 'completed'); assert.equal(cleaned.removedImages, 1); assert.equal(cleaned.unattributedImages, 1)
  assert.equal((await f.items()).length, 1)
})

test('unknown orphan images and corrupt or substituted provenance fail closed without becoming collectible maintenance records', async t => {
  const f = await fixture(t), ctx = context(), bytes = await image()
  await f.runtime.collect(bytes, ctx); const [item] = await f.items()
  await f.runtime.close(); await writeFile(path.join(f.folder(), 'emoji-packs.ndjson'), ''); await rm(path.join(f.folder(), 'emoji-sources.json'))
  await f.restart(); const isolated = await f.revoke(ctx); assert.equal(isolated.unattributedImages, 1); assert.equal(isolated.cleanup, 'unsupported')
  const caller = context({ id: 'later' }); await f.send(caller); assert.equal(caller.sent.length, 0); assert.deepEqual(await f.items(), [])
  assert.equal(fs.existsSync(path.join(f.folder(), item.file)), true)
  await f.runtime.close(); const outside = path.join(f.root, 'outside.json'); await writeFile(outside, 'untouched')
  await symlink(outside, path.join(f.folder(), 'emoji-sources.json')); await f.restart()
  assert.equal((await f.revoke(ctx)).cleanup, 'unknown'); assert.equal(await readFile(outside, 'utf8'), 'untouched')
})

test('bounded tombstone capacity never evicts old revocations and persists a fail-closed overflow gate', async t => {
  const f = await fixture(t), folder = path.join(f.root, 'emoji'), old = Array.from({ length: 8192 }, (_, i) => digest('revoked-' + i))
  await mkdir(folder, { recursive: true }); await writeFile(path.join(folder, 'revocations.json'), JSON.stringify({ version: 1, overflow: false, messages: old, subjects: [] }))
  assert.equal((await f.revoke(context())).cleanup, 'unknown')
  const saved = JSON.parse(await readFile(path.join(folder, 'revocations.json'), 'utf8'))
  assert.equal(saved.overflow, true); assert.deepEqual(saved.messages, old)
  await f.restart(); assert.equal((await f.runtime.collect(await image(), context({ id: 'new' }))).ok, false)
})

test('invalid cleanup selectors or lost initial authority never mutate source ownership', async t => {
  const f = await fixture(t), ctx = context(); await f.runtime.collect(await image(), ctx)
  const inputs = [{ target: ctx.binding.target, messageId: '' }, { target: { ...ctx.binding.target, id: '' }, messageId: 'x' }]
  for (const value of inputs) await assert.rejects(() => f.runtime.revokeSource(value, guard()))
  await assert.rejects(() => f.purge(ctx, -1)); await assert.rejects(() => f.purge(ctx, 2000, { target: { ...ctx.binding.target, account: { ...ctx.binding.target.account, id: 'other' } } }))
  const revoked = guard(); revoked.controller.abort(); await assert.rejects(() => f.runtime.revokeSource({ target: ctx.binding.target, messageId: ctx.source.messageId }, revoked))
  assert.equal((await f.items()).length, 1); assert.equal(Object.values((await f.sources()).images)[0].sources.length, 1)
})

test('asynchronously rejected cleanup authority cannot install a memory fence or change owned files', async t => {
  const f = await fixture(t), ctx = context(); await f.runtime.collect(await image(), ctx)
  const index = path.join(f.folder(), 'emoji-packs.ndjson'), sources = path.join(f.folder(), 'emoji-sources.json')
  const beforeIndex = await readFile(index), beforeSources = await readFile(sources), denied = guard()
  denied.ensureCurrent = async () => { await tick(); throw Error('fixture async authorization denied') }
  await assert.rejects(() => f.runtime.revokeSource({ target: ctx.binding.target, messageId: ctx.source.messageId }, denied))
  assert.deepEqual(await readFile(index), beforeIndex); assert.deepEqual(await readFile(sources), beforeSources)
  assert.equal(fs.existsSync(path.join(f.root, 'emoji', 'revocations.json')), false)
  assert.equal((await f.send(ctx)).status, 'succeeded'); assert.equal(ctx.sent.length, 1)
})

test('failed revocation file or directory fsync rejects instead of returning durable blocked usage', async t => {
  for (const phase of ['file', 'directory']) {
    const f = await fixture(t), ctx = context(); await f.runtime.collect(await image(), ctx)
    const index = path.join(f.folder(), 'emoji-packs.ndjson'), before = await readFile(index), descriptors = new Set()
    const originalOpen = fs.openSync, originalSync = fs.fsyncSync
    const opened = t.mock.method(fs, 'openSync', (location, ...args) => {
      const fd = originalOpen(location, ...args), name = String(location)
      if (phase === 'file' ? path.basename(name).startsWith('.revocations.json.') : name === path.join(f.root, 'emoji')) descriptors.add(fd)
      else descriptors.delete(fd)
      return fd
    })
    const synced = t.mock.method(fs, 'fsyncSync', fd => { if (descriptors.has(fd)) throw Object.assign(Error('fixture persistence failure'), { code: 'EIO' }); return originalSync(fd) })
    try { await assert.rejects(() => f.revoke(ctx)) }
    finally { synced.mock.restore(); opened.mock.restore() }
    assert.deepEqual(await readFile(index), before)
    assert.equal((await f.revoke(ctx)).cleanup, 'completed')
  }
})

test('quarantined untagged and stale records retain their exact index and images through maintenance and full-library replacement', async t => {
  const f = await fixture(t), ctx = context()
  await f.runtime.collect(await image(), ctx); await f.runtime.collect(await image(1), context({ id: 'second-old' }))
  await f.runtime.close()
  const items = await f.items(); items[0].tags = []; items[0].useCases = []; items[0].description = ''; items[0].embedding = null
  for (const item of items) { item.registeredAt = '2000-01-01T00:00:00.000Z'; item.lastUsedAt = null; item.noFileFlag = false }
  const index = path.join(f.folder(), 'emoji-packs.ndjson'), exact = items.map(item => JSON.stringify(item)).join('\n') + '\n'
  await writeFile(index, exact); await rm(path.join(f.folder(), 'emoji-sources.json'))
  const files = await Promise.all(items.map(item => readFile(path.join(f.folder(), item.file))))
  await f.restart({ config: { useEmbedding: false, maxItems: 2, doReplace: true, enableMaintenance: true, visionTagOnAdd: true,
    checkIntervalMinutes: 1, stalePruneEnabled: true, stalePruneCount: 2, minItemsToKeep: 1 }, tools: model })
  await f.send(ctx); assert.equal(ctx.sent.length, 0)
  assert.equal((await f.runtime.collect(await image(2), context({ id: 'fresh-at-capacity', at: 5000 }))).ok, false)
  assert.equal(await readFile(index, 'utf8'), exact)
  for (let i = 0; i < items.length; i++) assert.deepEqual(await readFile(path.join(f.folder(), items[i].file)), files[i])
})
