import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAgentMediaOutbox } from '../dist/backend/modules/media/infrastructure/agentMediaOutbox.js'
import { agentMediaOutboxId } from '../dist/backend/modules/media/infrastructure/agentMediaOutboxLedger.js'
import { createAgentMusicExtraction } from '../dist/backend/modules/media/infrastructure/agentMusicExtraction.js'
import { createAgentMusicExtractionLedger } from '../dist/backend/modules/media/infrastructure/agentMusicExtractionLedger.js'
import { createAgentTorrentWorkflow } from '../dist/backend/modules/media/infrastructure/agentTorrentWorkflow.js'
import { agentTorrentId } from '../dist/backend/modules/media/infrastructure/agentTorrentLedger.js'
import { createAgentDiagnostics } from '../dist/backend/modules/runtime/infrastructure/agentDiagnostics.js'
import { conversationAddressKey } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const redisTest = { skip: !redisAvailable, timeout: 20_000 }
const account = { platform: 'fixture', namespace: 'global', id: 'robot-a' }
const target = { account, kind: 'group', id: 'workflow-room' }
const sender = { ...account, id: 'operator' }
const binding = { source: 'configured', id: conversationAddressKey(target), revision: 'workflow-v1', agentId: 'role', personaId: 'default', connectionId: 'conn-a', target }
const explanation = '这次没有取得可交付的结果，请稍后再试。'
const secret = 'https://private.invalid/?token=PRIVATE_WORKFLOW_SECRET'
const sent = messageId => ({ state: 'sent', messageId })
const sourceOf = message => ({ messageId: message.messageId, sender: message.sender, occurredAt: message.occurredAt })
const message = (id, text) => ({ version: 1, conversation: target, sender, messageId: id, occurredAt: 1_800_000_000_000,
  text, parts: [{ kind: 'text', text }], mentions: [], directedToAccount: false })
async function until(probe, description) {
  const end = Date.now() + 6000
  while (Date.now() < end) { const value = await probe(); if (value) return value; await delay(10) }
  assert.fail(`timed out: ${description}`)
}
function observers() {
  const rows = [], notices = [], scopes = []
  const diagnostics = createAgentDiagnostics({ sink: { async append(row) { rows.push(row); return true } } })
  return { rows, notices, scopes, diagnostics,
    ports: { diagnostics, withDiagnosticScope(scope, operation, run) { scopes.push({ scope, operation }); return diagnostics.run(scope, operation, run) },
      async explainFailure(input) { notices.push(input.detail); assert.equal(await input.isCurrent(), true); assert.equal(input.signal.aborted, false); return explanation } },
    async verify() {
      await diagnostics.flush()
      assert.doesNotMatch(JSON.stringify([rows, notices]), /private.invalid|PRIVATE_WORKFLOW_SECRET/)
      const work = rows.filter(row => row.operation.includes('provider') || row.stage === 'delivery')
      assert.ok(work.length)
      assert.ok(work.every(row => row.scope.kind === 'conversation' && row.scope.binding.id === binding.id && row.scope.messageId))
    } }
}

async function mediaFixture(t, mode) {
  const { storage } = await createAgentRedisFixture(t, 'workflow-media-diagnostics'), seen = observers()
  let clock = 1_800_000_000_000, calls = 0, preparations = 0, active = true
  const incoming = message('media-source', '媒体分享'), share = { provider: 'pixiv', reference: { kind: 'artwork', id: '126649495' } }
  const source = { ...sourceOf(incoming), share }, id = agentMediaOutboxId(binding, incoming.messageId)
  const sends = [], plan = { version: 1, items: [{ parts: [{ kind: 'text', text: '作品介绍' }] }] }
  const outbox = createAgentMediaOutbox({ storage, now: () => clock, ...seen.ports,
    actions: { async send(action) { sends.push(action); calls++; return sent(`media-${calls}`) }, async sendMediaRelay() { calls++; return { state: 'unknown' } } },
    provider: { async prepare() { preparations++; if (mode !== 'unknown') throw Error(secret); return { status: 'metadata-only', pageUrl: 'https://www.pixiv.net/artworks/126649495', infoText: '作品介绍', plan, async release() {} } } },
    async openContext(_record, signal) { return { signal, isCurrent: () => active && !signal.aborted, async ensureCurrent() { if (!active) throw Error('revoked') },
      async readSource() { return { message: incoming, share } }, release() {} } },
  })
  t.after(() => outbox.stop()); await outbox.ledger.enqueue({ binding, source }); await outbox.start()
  const inspect = () => outbox.ledger.inspect(id)
  if (mode !== 'unknown') {
    await until(async () => (await inspect()).prepareFailures === 1, 'media first failure'); clock += 1000; await outbox.tick()
    await until(async () => (await inspect()).prepareFailures === 2, 'media second failure'); clock += 3000
    if (mode === 'revoked') active = false
    await outbox.tick()
  }
  const result = await until(async () => { await outbox.tick(); const record = await inspect(); return ['completed', 'failed', 'cancelled', 'unknown'].includes(record.state) ? record : undefined }, 'media terminal')
  return { seen, result, sends, get calls() { return calls }, get preparations() { return preparations } }
}

test('media final preparation failure explains once in its FIFO scope and retains canonical link fallback', redisTest, async t => {
  const f = await mediaFixture(t, 'failed')
  assert.equal(f.preparations, 3); assert.equal(f.seen.notices.length, 1); assert.equal(f.sends.length, 1)
  assert.ok(f.sends[0].parts[0].text.includes(explanation)); assert.ok(f.sends[0].parts[0].text.includes('https://www.pixiv.net/artworks/126649495'))
  assert.equal(f.result.state, 'completed'); assert.ok(f.seen.scopes.some(row => row.operation === 'media_prepare')); assert.ok(f.seen.scopes.some(row => row.operation === 'media_deliver'))
  await f.seen.verify(); assert.ok(f.seen.rows.some(row => row.code === 'provider_threw'))
})

test('media unknown effects and revoked preparation produce no explanation or supplementary send', redisTest, async t => {
  for (const mode of ['unknown', 'revoked']) await t.test(mode, async t => {
    const f = await mediaFixture(t, mode)
    assert.equal(f.seen.notices.length, 0); assert.equal(f.sends.length, 0)
    assert.equal(f.result.state, mode === 'unknown' ? 'unknown' : 'cancelled')
    await f.seen.diagnostics.flush()
    if (mode === 'unknown') assert.ok(f.seen.rows.some(row => row.code === 'effect_unknown'))
  })
})

async function musicFixture(t, mode) {
  const fixture = await createAgentRedisFixture(t, 'workflow-music-diagnostics'), seen = observers()
  let failedLedger = false
  const storage = { get: fixture.storage.get.bind(fixture.storage), async eval(script, options) {
    let next
    try { next = JSON.parse(options.arguments[1]) } catch {}
    const result = await fixture.storage.eval(script, options)
    if (mode === 'ledger' && !failedLedger && next?.stages?.at(-1)?.stage === 'file' && next.stages.at(-1).state !== 'pending') { failedLedger = true; throw Error(secret) }
    return result
  } }
  const incoming = { ...message('music-command', '.音乐提取'), quote: { messageId: 'music-source', parts: [] } }
  const original = message('music-source', '网易云音乐分享'), signal = new AbortController().signal
  const base64 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0]), Buffer.from('audio-owned-by-fixture')]).toString('base64')
  const share = { provider: 'netease', reference: { kind: 'audio', url: 'https://m701.music.126.net/private.mp3' } }
  let preparations = 0
  const calls = [], workflow = createAgentMusicExtraction({ storage, config: { enabled: true, operators: [sender] }, ...seen.ports,
    provider: { async prepare() { preparations++; if (mode === 'provider') throw Error(secret); return { attachment: { name: 'audio.mp3', mime: 'audio/mpeg', base64 }, audio: { mime: 'audio/mpeg', base64 }, title: 'Title', artist: 'Artist' } } },
    actions: { async send(action) { calls.push({ stage: 'failure', action }); return sent('music-notice') },
      async sendAudioFile() { calls.push({ stage: 'file' }); return mode === 'unknown' ? { state: 'unknown' } : { state: 'failed', code: 'rejected' } },
      async sendMedia() { calls.push({ stage: 'preview' }); return sent('preview') } },
    async readShare() { return { message: original, share } },
  })
  await workflow.handle(incoming, binding, { signal, isCurrent: () => true, async ensureCurrent() {}, async allowsSource() { return true } })
  const result = await createAgentMusicExtractionLedger(storage).inspect(binding, incoming.messageId)
  return { seen, calls, result, preparations }
}

test('music provider and definite upload failures each explain once without repeating preparation or changing effect order', redisTest, async t => {
  for (const mode of ['provider', 'rejected']) await t.test(mode, async t => {
    const f = await musicFixture(t, mode)
    assert.equal(f.preparations, 1); assert.equal(f.seen.notices.length, 1); assert.equal(f.result.state, 'failed')
    assert.deepEqual(f.calls.map(row => row.stage), mode === 'provider' ? ['failure'] : ['file', 'preview', 'failure'])
    assert.equal(f.calls.at(-1).action.parts[0].text, explanation)
    await f.seen.verify()
  })
})

test('music unknown upload emits an unknown diagnostic and never explains or attempts preview', redisTest, async t => {
  const f = await musicFixture(t, 'unknown')
  assert.deepEqual(f.calls.map(row => row.stage), ['file']); assert.equal(f.result.state, 'unknown'); assert.equal(f.seen.notices.length, 0)
  await f.seen.verify(); assert.ok(f.seen.rows.some(row => row.code === 'effect_unknown'))
})

async function torrentFixture(t, mode) {
  const { storage } = await createAgentRedisFixture(t, 'workflow-torrent-diagnostics'), seen = observers()
  const original = message('torrent-source', 'magnet:?xt=urn:btih:' + 'A'.repeat(40)), source = sourceOf(original)
  let preparations = 0
  const calls = [], workflow = createAgentTorrentWorkflow({ storage, config: { enabled: true }, ...seen.ports,
    isCurrent: () => true, responsible: () => true,
    provider: { async prepare() { preparations++; throw Error(secret) } },
    actions: { async send(action) { calls.push(action); return mode === 'unknown' ? { state: 'unknown' } : sent(`torrent-${calls.length}`) } },
    async openContext(_record, signal) { return { signal, isCurrent: () => !signal.aborted, async ensureCurrent() {}, async read() { return original }, release() {} } },
  })
  t.after(() => workflow.stop()); await workflow.start(); await workflow.handle(original, binding)
  const result = await until(async () => { await workflow.tick(); const record = await workflow.ledger.inspect(agentTorrentId(binding, source)); return record && ['failed', 'unknown'].includes(record.state) ? record : undefined }, 'torrent terminal')
  return { seen, calls, result, preparations }
}

test('torrent provider failure explains once after the original notice without retrying provider', redisTest, async t => {
  const f = await torrentFixture(t, 'provider')
  assert.equal(f.preparations, 1); assert.equal(f.seen.notices.length, 1); assert.equal(f.calls.length, 2)
  assert.equal(f.calls[1].parts[0].text, explanation); assert.equal(f.result.state, 'failed')
  await f.seen.verify(); assert.ok(f.seen.rows.some(row => row.code === 'provider_threw'))
})

test('torrent unknown first notice freezes the workflow before provider or explanation', redisTest, async t => {
  const f = await torrentFixture(t, 'unknown')
  assert.equal(f.preparations, 0); assert.equal(f.seen.notices.length, 0); assert.equal(f.calls.length, 1); assert.equal(f.result.state, 'unknown')
  await f.seen.verify(); assert.ok(f.seen.rows.some(row => row.code === 'effect_unknown'))
})


test('music receipt ledger acknowledgement failure logs unknown and prevents a later explanation', redisTest, async t => {
  const f = await musicFixture(t, 'ledger')
  assert.deepEqual(f.calls.map(row => row.stage), ['file']); assert.equal(f.seen.notices.length, 0)
  assert.equal(f.result.state, 'unknown'); await f.seen.verify()
  assert.ok(f.seen.rows.some(row => row.code === 'effect_ledger_failed' && row.outcome === 'unknown'))
})

test('media startup and tick ledger errors are observable without provider exception text', async () => {
  const seen = observers(), outbox = createAgentMediaOutbox({ storage: { async get() { throw Error(secret) }, async eval() { throw Error(secret) } }, actions: { async send() { return sent('unused') } },
    ...seen.ports, async openContext() { return undefined } })
  await assert.rejects(outbox.start()); await outbox.stop(); await seen.diagnostics.flush()
  assert.ok(seen.rows.some(row => row.code === 'start_failed')); assert.doesNotMatch(JSON.stringify(seen.rows), /private.invalid|PRIVATE_WORKFLOW_SECRET/)
})
