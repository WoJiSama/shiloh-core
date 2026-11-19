import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import sharp from 'sharp'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { createAgentLocalEmojiRuntime } = await load('modules/emoji/infrastructure/agentLocalEmojiRuntime.js')
const model = { baseUrl: 'https://models.example.test/v1', model: 'fixture-vision', apiKey: 'fixture-local-emoji-api-secret' }
const embedding = { ...model, baseUrl: 'https://models.example.test/v1/embeddings', model: 'fixture-embedding' }
const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
const message = value => json({ choices: [{ message: { content: JSON.stringify(value) } }] })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const partition = (root, agent = 'alice') => path.join(root, 'emoji', 'agents', hash(agent))
async function image(seed = 0) {
  const pixels = Buffer.from(Array.from({ length: 128 * 128 * 3 }, (_, index) => ((index * 73 + Math.floor(index / 97) * 31 + seed) % 256)))
  return { mime: 'image/png', base64: (await sharp(pixels, { raw: { width: 128, height: 128, channels: 3 } }).png().toBuffer()).toString('base64') }
}
function context({ agent = 'alice', account = '10001', group = '20001', source = 'source-1' } = {}) {
  const controller = new AbortController(); let current = true
  const binding = { source: 'configured', id: 'binding-' + account, revision: 'binding-v1', agentId: agent, personaId: 'shared-persona', connectionId: 'connection-' + account,
    target: { account: { platform: 'qq', namespace: 'global', id: account }, kind: 'group', id: group } }
  const author = { platform: 'qq', namespace: 'global', id: '30001' }, sent = []
  const value = { binding, source: { messageId: source, author, occurredAt: 1795000000000 }, signal: controller.signal,
    isCurrent() { return current }, async ensureCurrent() { if (!current) throw Error('revoked fixture source') },
    actor: { kind: 'user', user: author }, request: { messageId: source, text: '来张表情', mentions: [] },
    async sendImage(value) { sent.push({ kind: 'image', value }); return { state: 'sent', messageId: 'sent-1' } },
    async sendBundle(value) { sent.push({ kind: 'bundle', value }); return { state: 'sent', messageId: 'sent-1' } },
  }
  return { value, sent, controller, revoke() { current = false } }
}
async function fixture(t, overrides = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-local-emoji-'))), calls = []
  const options = { dataDir: root, enabled: true,
    config: { autoCollect: true, maxItems: 600, doReplace: true, useEmbedding: true, sendAsSticker: false }, analysis: model, embedding, tools: model,
    secrets: [model.apiKey],
    async fetch(url, init) {
      const body = JSON.parse(init.body); calls.push({ url: String(url), init, body })
      assert.equal(init.redirect, 'error'); assert.equal(init.headers.Authorization, 'Bearer ' + model.apiKey)
      if (overrides.response) return overrides.response(url, init, body)
      if (String(url).endsWith('/embeddings')) return json({ data: [{ embedding: [0.1, 0.4, 0.8] }] })
      if (body.messages[0].content[0]?.text?.includes('判定一')) return message({ is_emoji: true, safe: true, confidence: 0.99, reason: 'fixture accepted' })
      if (typeof body.messages[0].content === 'string') return message({ index: 0 })
      return message({ description: '猫猫开心大笑，群友分享快乐时使用。', tags: ['开心', '笑死'], use_cases: ['分享快乐', '接梗吐槽'] })
    }, ...overrides.options }
  const runtime = createAgentLocalEmojiRuntime(options)
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }) })
  return { root, runtime, calls, options, run(input, ctx) { return runtime.builtIn[0].execute(input, ctx) },
    async items(agent) { return (await readFile(path.join(partition(root, agent), 'emoji-packs.ndjson'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) } }
}

test('standalone emoji configuration is explicit, rejects plugin paths and never reads plugin settings', async t => {
  const f = await fixture(t)
  assert.equal(f.runtime.builtIn[0].name, 'sendLocalEmojiTool')
  for (const options of [
    { ...f.options, dataDir: 'plugins/shiloh-plugin/database' },
    { ...f.options, config: { dbPath: '/tmp/other' } }, { ...f.options, config: { storeDir: '/tmp/other' } },
    { ...f.options, config: { enabled: true } }, { ...f.options, config: { maxItems: 0 } },
    { ...f.options, config: { useEmbedding: true }, embedding: undefined },
    { ...f.options, config: { contentFiltration: true }, analysis: undefined },
  ]) assert.throws(() => createAgentLocalEmojiRuntime(options))
  const disabled = createAgentLocalEmojiRuntime({ dataDir: f.root, enabled: false, config: {} })
  assert.deepEqual(disabled.builtIn, []); await disabled.close()
})

test('real manager performs dual VLM review, tagging and embedding before a verified library commit', async t => {
  const f = await fixture(t), ctx = context(), bytes = await image()
  assert.deepEqual(await f.runtime.collect(bytes, ctx.value), { ok: true })
  assert.equal(f.calls.length, 3)
  assert.equal(f.calls[0].body.model, model.model); assert.equal(f.calls[2].body.model, embedding.model)
  const [item] = await f.items()
  assert.deepEqual(item.tags, ['开心', '笑死']); assert.deepEqual(item.useCases, ['分享快乐', '接梗吐槽'])
  assert.deepEqual(item.embedding, [0.1, 0.4, 0.8]); assert.equal(item.usedCount, 0)
  assert.match(item.source, /^verified-source:[a-f0-9]{64}$/u)
  assert.equal(JSON.stringify(item).includes('source-1'), false)
  assert.equal(await readFile(path.join(partition(f.root), item.file), 'base64'), bytes.base64)
})

test('explicit verified collection remains available with automatic ingress collection disabled', async t => {
  const f = await fixture(t, { options: { config: { autoCollect: false, useEmbedding: false } } })
  assert.deepEqual(await f.runtime.collect(await image(), context().value), { ok: true })
  assert.equal((await f.items()).length, 1)
})

test('same Agent shares its library across connections while shared-persona Agents remain isolated', async t => {
  const f = await fixture(t), owner = context(), otherConnection = context({ account: '10002' }), otherAgent = context({ agent: 'bob' })
  await f.runtime.collect(await image(), owner.value)
  assert.equal((await f.run({ tags: ['开心'] }, otherConnection.value)).status, 'succeeded')
  assert.equal(otherConnection.sent.length, 1); assert.equal(otherConnection.sent[0].value.mime, 'image/png')
  const missing = await f.run({ tags: ['开心'] }, otherAgent.value)
  assert.equal(missing.status, 'succeeded'); assert.match(missing.content, /没有可用/u); assert.equal(otherAgent.sent.length, 0)
  assert.equal((await f.items())[0].usedCount, 1)
  assert.notEqual(partition(f.root), partition(f.root, 'bob'))
})

test('independent runtime restarts read the same verified library without a process singleton', async t => {
  const f = await fixture(t), ctx = context()
  await f.runtime.collect(await image(), ctx.value)
  await f.runtime.close()
  const restarted = createAgentLocalEmojiRuntime(f.options)
  t.after(() => restarted.close())
  assert.equal((await restarted.builtIn[0].execute({ tags: ['开心'] }, ctx.value)).status, 'succeeded')
  assert.equal(ctx.sent.length, 1); assert.equal((await f.items())[0].usedCount, 1)
})

test('enabled maintenance runs under the next current operation and marks missing files without unowned timers', async t => {
  const f = await fixture(t, { options: { config: { autoCollect: true, useEmbedding: false, sendAsSticker: false, enableMaintenance: true, checkIntervalMinutes: 1 } } }), ctx = context()
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  await f.runtime.collect(await image(), ctx.value)
  const [item] = await f.items()
  await rm(path.join(partition(f.root), item.file))
  now += 61_000
  const result = await f.run({ tags: ['开心'] }, ctx.value)
  assert.equal(result.status, 'succeeded'); assert.equal(ctx.sent.length, 0)
  assert.equal((await f.items())[0].noFileFlag, true)
})

test('tag and use-case selection, follow-up order, familiarity and per-complete-conversation rate limits are preserved', async t => {
  const f = await fixture(t, { options: { config: { autoCollect: true, useEmbedding: false, maxItems: 600, rateLimitMaxPerWindow: 1, sendAsSticker: false } } }), ctx = context()
  await f.runtime.collect(await image(), ctx.value)
  const result = await f.run({ tags: ['开心'], useCases: ['分享快乐'], query: '猫猫', leadText: '一起开心', followUpText: '晚点见' }, ctx.value)
  assert.equal(result.status, 'succeeded'); assert.equal(ctx.sent.length, 1)
  assert.deepEqual(ctx.sent[0].value[0].parts.map(row => row.kind), ['text', 'image', 'text'])
  assert.equal(ctx.sent[0].value[0].parts[0].text, '一起开心'); assert.equal(ctx.sent[0].value[0].parts[2].text, '晚点见')
  assert.equal((await f.items())[0].usedCount, 1)
  assert.equal((await f.run({ tags: ['开心'] }, ctx.value)).status, 'failed'); assert.equal(ctx.sent.length, 1)
  const other = context({ account: '10002' }); assert.equal((await f.run({ tags: ['开心'] }, other.value)).status, 'succeeded')
  assert.doesNotMatch(result.content, /emoji_files|[a-f0-9]{64}|base64|source-1/u)
})

test('unsafe, non-emoji and low-confidence reviews do not write files or catalog records', async t => {
  for (const verdict of [{ is_emoji: false, safe: true, confidence: 1 }, { is_emoji: true, safe: false, confidence: 1 }, { is_emoji: true, safe: true, confidence: 0.1 }]) {
    const f = await fixture(t, { response: () => message(verdict) })
    assert.equal((await f.runtime.collect(await image(), context().value)).ok, false)
    assert.deepEqual(await readdir(path.join(partition(f.root), 'emoji_files')), [])
    await assert.rejects(readFile(path.join(partition(f.root), 'emoji-packs.ndjson')), { code: 'ENOENT' })
  }
})

test('tag failure at capacity does not remove an existing item or leave a staged orphan', async t => {
  const ctx = context(); let count = 0
  const g = await fixture(t, { options: { config: { autoCollect: true, maxItems: 1, doReplace: true, useEmbedding: false } }, response(_url, _init, body) {
    if (typeof body.messages[0].content === 'string') return message({ index: 0 })
    if (body.messages[0].content[0].text.includes('判定一')) return message({ is_emoji: true, safe: true, confidence: 1 })
    count++; return count === 1 ? message({ tags: ['开心'], use_cases: ['分享快乐'], description: '开心的猫猫' }) : message({ tags: [], description: '' })
  } })
  await g.runtime.collect(await image(), ctx.value)
  const prior = await g.items()
  assert.equal((await g.runtime.collect(await image(19), ctx.value)).ok, false)
  assert.deepEqual(await g.items(), prior)
  assert.deepEqual(await readdir(path.join(partition(g.root), 'emoji_files')), [path.basename(prior[0].file)])
})

test('successful full-library replacement uses the existing LLM decision and removes only the selected old asset', async t => {
  const f = await fixture(t, { options: { config: { autoCollect: true, maxItems: 1, doReplace: true, useEmbedding: false, sendAsSticker: false } } }), ctx = context()
  const first = await image(), second = await image(19)
  assert.equal((await f.runtime.collect(first, ctx.value)).ok, true)
  assert.equal((await f.runtime.collect(second, ctx.value)).ok, true)
  const rows = await f.items()
  assert.equal(rows.length, 1); assert.equal(rows[0].hash, hash(Buffer.from(second.base64, 'base64')))
  assert.ok(f.calls.some(row => typeof row.body.messages[0].content === 'string' && row.body.messages[0].content.includes('候选列表')))
  assert.deepEqual(await readdir(path.join(partition(f.root), 'emoji_files')), [path.basename(rows[0].file)])
})

test('embedding fallback selects semantically related requests without replacing exact tag selection', async t => {
  const f = await fixture(t), ctx = context()
  await f.runtime.collect(await image(), ctx.value)
  const before = f.calls.length
  assert.equal((await f.run({ tags: [], query: '星际旅行' }, ctx.value)).status, 'succeeded')
  assert.equal(ctx.sent.length, 1)
  assert.equal(f.calls.length, before + 1); assert.equal(f.calls.at(-1).body.input, '星际旅行')
})

test('sticker presentation and autonomous sends use one fixed-target image attempt', async t => {
  const f = await fixture(t, { options: { config: { autoCollect: true, useEmbedding: false, sendAsSticker: true } } }), human = context(), autonomous = context()
  await f.runtime.collect(await image(), human.value)
  autonomous.value.actor = { kind: 'autonomous' }; delete autonomous.value.request
  const result = await f.run({ tags: ['开心'] }, autonomous.value)
  assert.equal(result.status, 'succeeded'); assert.equal(autonomous.sent.length, 1)
  assert.equal(autonomous.sent[0].value.presentation, 'sticker')
})

test('host secrets, redirects, oversized responses and unsafe image metadata cannot enter the library', async t => {
  for (const response of [
    () => message({ is_emoji: true, safe: true, confidence: 1, reason: model.apiKey }),
    () => new Response('', { status: 302, headers: { location: 'https://other.example.test' } }),
    () => new Response('x'.repeat(512 * 1024 + 1), { status: 200, headers: { 'content-type': 'application/json' } }),
  ]) {
    const f = await fixture(t, { response })
    assert.equal((await f.runtime.collect(await image(), context().value)).ok, false)
    assert.deepEqual(await readdir(path.join(partition(f.root), 'emoji_files')), [])
  }
  const f = await fixture(t)
  const invalid = { mime: 'image/png', base64: Buffer.from('not an actual image').toString('base64') }
  assert.equal((await f.runtime.collect(invalid, context().value)).ok, false); assert.equal(f.calls.length, 0)
})

test('revocation during VLM prevents late provider results from changing storage', async t => {
  let release, entered
  const ready = new Promise(resolve => { entered = resolve })
  const f = await fixture(t, { response() { entered(); return new Promise(resolve => { release = resolve }) } }), ctx = context()
  const collecting = f.runtime.collect(await image(), ctx.value)
  await ready; ctx.revoke(); ctx.controller.abort()
  assert.equal((await collecting).ok, false)
  release(message({ is_emoji: true, safe: true, confidence: 1 })); await delay(20)
  assert.deepEqual(await readdir(path.join(partition(f.root), 'emoji_files')), [])
  await assert.rejects(readFile(path.join(partition(f.root), 'emoji-packs.ndjson')), { code: 'ENOENT' })
})

test('queue waits recheck full binding and source before provider dispatch', async t => {
  let release, entered
  const ready = new Promise(resolve => { entered = resolve })
  const f = await fixture(t, { response() { entered(); return new Promise(resolve => { release = resolve }) } }), first = context(), second = context({ source: 'source-2' })
  const one = f.runtime.collect(await image(), first.value)
  await ready
  const two = f.runtime.collect(await image(19), second.value)
  second.value.binding.revision = 'new-binding'
  first.controller.abort(); release(message({ is_emoji: true, safe: true, confidence: 1 }))
  assert.equal((await one).ok, false); assert.equal((await two).ok, false)
  assert.equal(f.calls.length, 1)
})

test('missing and unsafe source identities fail before any filesystem or external request', async t => {
  const f = await fixture(t), bytes = await image()
  for (const mutate of [ctx => { ctx.source.messageId = '' }, ctx => { ctx.source.author.namespace = 'other' }, ctx => { ctx.source.occurredAt = NaN }, ctx => { ctx.binding.agentId = '../other' }]) {
    const ctx = context(); mutate(ctx.value)
    assert.equal((await f.runtime.collect(bytes, ctx.value)).ok, false)
  }
  assert.equal(f.calls.length, 0); assert.deepEqual(await readdir(f.root), [])
})

test('symlinked files and corrupted paths cannot send data outside the Agent partition', async t => {
  const f = await fixture(t), ctx = context()
  await f.runtime.collect(await image(), ctx.value)
  const [item] = await f.items(), ownFile = path.join(partition(f.root), item.file), outside = path.join(f.root, 'outside.png')
  await writeFile(outside, Buffer.from((await image(77)).base64, 'base64')); await rm(ownFile); await symlink(outside, ownFile)
  const result = await f.run({ tags: ['开心'] }, ctx.value)
  assert.equal(ctx.sent.length, 0); assert.equal(result.content.includes(outside), false)
  item.file = '../../outside.png'
  await writeFile(path.join(partition(f.root), 'emoji-packs.ndjson'), JSON.stringify(item) + '\n')
  assert.equal((await f.run({ tags: ['开心'] }, ctx.value)).status, 'failed'); assert.equal(ctx.sent.length, 0)
})

test('unknown native delivery stops after one attempt, without usage claims or model data disclosure', async t => {
  const f = await fixture(t), ctx = context()
  await f.runtime.collect(await image(), ctx.value)
  ctx.value.sendImage = async value => { ctx.sent.push(value); return { state: 'unknown' } }
  const result = await f.run({ tags: ['开心'] }, ctx.value)
  assert.equal(result.status, 'unknown'); assert.equal(ctx.sent.length, 1)
  assert.equal((await f.items())[0].usedCount, 0)
  assert.doesNotMatch(result.content, /[a-f0-9]{64}|base64|source-1|emoji_files|https?:/u)
})

test('close cancels active and queued operations, and retained model responses cannot write later', async t => {
  let entered, release
  const ready = new Promise(resolve => { entered = resolve })
  const f = await fixture(t, { response() { entered(); return new Promise(resolve => { release = resolve }) } }), ctx = context()
  const collecting = f.runtime.collect(await image(), ctx.value)
  await ready
  await f.runtime.close()
  assert.equal((await collecting).ok, false)
  release(message({ is_emoji: true, safe: true, confidence: 1 })); await delay(20)
  assert.deepEqual(await readdir(path.join(partition(f.root), 'emoji_files')), [])
  assert.equal((await f.runtime.collect(await image(), ctx.value)).ok, false)
})
