// Checkout-only comparison against the original archive producer. The standalone
// package consumes original rows but does not publish the legacy producer.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const [{ stageStandaloneAgentArchiveMigration: stage }, { createAgentHistoryStore, agentHistoryId },
  { createPersonMemoryStore }, { KEY }, { createArchiveManagerClass }, { createAgentHistory },
  { createEventEnvelope, envelopeToRuntimeEvent }] = await Promise.all([
  load('bootstrap/standaloneAgentArchiveMigration.js'), load('modules/memory/infrastructure/agentHistoryStore.js'),
  load('modules/memory/infrastructure/personMemoryStore.js'), load('modules/memory/infrastructure/engine/constants.js'),
  load('modules/messaging/infrastructure/messageArchive.js'), load('modules/memory/infrastructure/agentHistory.js'),
  load('modules/messaging/infrastructure/eventEnvelope.js'),
])
const settings = { timeout: 30000 }
const now = Date.parse('2026-11-17T10:00:00+08:00'), account = { platform: 'qq', namespace: 'global', id: '19007717' }
const target = { account, kind: 'group', id: '3107717' }, author = '3307717'
const binding = { source: 'configured', id: 'archive-binding', revision: 'destination', agentId: 'daily', personaId: 'default', connectionId: 'main', target }
const peer = { account, kind: 'private', id: author }
const original = (id = '7717', text = '完整原文与原时间。', extra = {}) => ({ version: 1, message_type: 'group', group_id: target.id,
  source_bot_id: account.id, source_persona_id: 'agent:daily', message_id: id, user_id: author,
  sender: { user_id: author, nickname: '来源作者', card: '', role: 'member' },
  timestamp: now - 60000, raw_message: text, raw_truncated: false, message: [{ type: 'text', text }], source: null, ...extra })
const scoped = (reader, prefix) => ({ get: key => reader.get(prefix + key),
  set: (key, value, options) => reader.set(prefix + key, value, options), del: key => reader.del(prefix + key),
  eval: (script, options) => reader.eval(script, { keys: options.keys.map(key => prefix + key), arguments: options.arguments }) })
const recallKey = (kind, mid) => `agent:inbox:${kind === 'text-recall' ? 'text-recall-receipt' : 'receipt'}:${createHash('sha256')
  .update(JSON.stringify([kind, JSON.stringify([account.platform, account.namespace, account.id, target.kind, target.id]), mid])).digest('hex')}`
const commitScript = `
for i,key in ipairs(KEYS) do
  local prior=redis.call('GET',key)
  if (prior or false) ~= (ARGV[(i-1)*4+1]=='1' and ARGV[(i-1)*4+2] or false) then return 0 end
end
for i,key in ipairs(KEYS) do
  local mode=ARGV[(i-1)*4+3]
  if mode=='set' then redis.call('SET',key,ARGV[(i-1)*4+4]) elseif mode=='del' then redis.call('DEL',key) end
end
return 1`

async function fixture(t, name, room = target) {
  assert.equal(redisAvailable, true, 'offline archive migration tests require actual isolated Redis')
  const { reader } = await createAgentRedisFixture(t, `archive-source-${name}`)
  const directory = await mkdtemp(path.join(tmpdir(), 'archive-migration-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const selectedBinding = { ...structuredClone(binding), target: structuredClone(room) }
  const sourceArchiveDir = path.join(directory, 'custom-originals'), groupDir = path.join(sourceArchiveDir, room.kind, room.id)
  const prefix = `bl-agent:archive-target-${name}:`, storage = scoped(reader, prefix), checks = new Map()
  await mkdir(groupDir, { recursive: true })
  let current = true
  const options = { redis: reader, prefix, binding: selectedBinding, sourceBinding: { ...structuredClone(selectedBinding), revision: 'source' },
    sourceArchiveDir, history: { enabled: true }, now, checks, isCurrent: () => current,
    allowsText: text => !text.includes('PRIVATE_HOST_CREDENTIAL') }
  const memory = base => createPersonMemoryStore({ now: () => now, redis: scoped(reader, base) })
  const f = { reader, prefix, storage, directory, sourceArchiveDir, groupDir, checks, options,
    sourceMemory: memory(''), targetMemory: memory(prefix), identity: { botId: account.id, personaId: 'agent:daily' }, scene: { kind: room.kind, id: room.id },
    store: createAgentHistoryStore(storage), id: agentHistoryId(selectedBinding),
    async seed(rows, day = '2026-11-17') {
      await writeFile(path.join(groupDir, `${day}.ndjson`), rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    },
    async semantic(value, chunks) {
      const base = path.join(directory, 'semantic_memory'); await mkdir(path.join(base, 'redactions'), { recursive: true })
      await writeFile(path.join(base, 'redactions', `${room.id}.json`), typeof value === 'string' ? value : JSON.stringify(value))
      if (chunks) { await mkdir(path.join(base, 'group'), { recursive: true }); await writeFile(path.join(base, 'group', `${room.id}.ndjson`), chunks.map(row => JSON.stringify(row)).join('\n') + '\n') }
    },
    async stage(extra = {}) { checks.clear(); return stage({ ...options, ...extra }) },
    async commit(result) {
      assert.equal(result.isCurrent(), true, 'source and configuration must still match before parent CAS')
      const rows = [...checks.values()]
      return reader.eval(commitScript, { keys: rows.map(row => row.key), arguments: rows.flatMap(row => [row.value === null ? '0' : '1', row.value ?? '',
        row.write === undefined ? 'keep' : row.write === null ? 'del' : 'set', row.write ?? '']) })
    },
    async destination() { const keys = (await reader.keys(prefix + '*')).sort(); return Promise.all(keys.map(async key => [key, await reader.get(key)])) },
    async saved() { return (await f.store.read(f.id))?.rows ?? [] },
    revoke() { current = false },
  }
  return f
}

test('actual legacy producer rows preview without writes and import exact originals with portable provenance and idempotence', settings, async t => {
  const f = await fixture(t, 'producer')
  const Archive = createArchiveManagerClass({ queue: { run: (_key, work) => work() }, getMentionTargetId: () => undefined,
    safeTruncateUnicode: text => text, qqFaceText: () => '',
    enrichBilibiliMessageSegments: async message => message, enrichDouyinMessageSegments: async message => message,
    enrichYoutubeMessageSegments: async message => message, enrichPixivMessageSegments: async message => message,
    formatBilibiliHistoryLinks: () => '', formatBilibiliHistoryText: () => '', formatDouyinHistoryLinks: () => '', formatDouyinHistoryText: () => '',
    formatYoutubeHistoryLinks: () => '', formatYoutubeHistoryText: () => '', formatPixivHistoryLinks: () => '', formatPixivHistoryText: () => '' })
  const archive = new Archive(), text = '  保留原始空白、时间及原话。\n第二行。'
  const row = archive.buildRecord({ self_id: account.id, group_id: target.id, user_id: author, message_type: 'group',
    sender: { user_id: author, nickname: '真实归档作者' }, message_id: -7717, time: (now - 60000) / 1000,
    _personaSnapshot: { botId: account.id, personaId: 'agent:daily' }, raw_message: text, message: [{ type: 'text', data: { text } }] },
  { maxMessageLength: 5000, storeMediaUrl: true })
  await f.seed([row, row]); const file = path.join(f.groupDir, '2026-11-17.ndjson'), before = await readFile(file, 'utf8')
  const result = await f.stage()
  assert.equal(result.report.imported, 1); assert.equal(result.report.duplicates, 1); assert.deepEqual(await f.destination(), [])
  assert.ok([...f.checks.values()].every(check => check.write === undefined || check.key.startsWith(f.prefix)))
  assert.equal(await f.commit(result), 1)
  assert.deepEqual(await f.saved(), [{ messageId: '-7717', authorId: author, name: '真实归档作者', text, at: now - 60000 }])
  const receipt = JSON.parse(await f.reader.get(f.prefix + 'agent:migration:qq-archive:v1:' + f.id))
  assert.equal(receipt.scope.agentId, 'daily'); assert.deepEqual(receipt.scope.target, target)
  assert.equal(receipt.imported[0].source.file, `group/${target.id}/2026-11-17.ndjson`)
  assert.equal(receipt.imported[0].source.line, 1); assert.match(receipt.imported[0].source.sha256, /^[a-f0-9]{64}$/u)
  assert.equal(JSON.stringify(receipt).includes(f.directory), false)
  const snapshot = await f.destination(), replay = await f.stage()
  assert.equal(replay.report.imported, 0); assert.equal(replay.report.alreadyImported, 1); assert.equal(await f.commit(replay), 1)
  assert.deepEqual(await f.destination(), snapshot); assert.equal(await readFile(file, 'utf8'), before)
  await f.store.update(f.id, saved => ({ ...saved, rows: [] }))
  const cleared = await f.stage(); assert.equal(cleared.report.alreadyImported, 1); assert.equal(await f.commit(cleared), 1)
  assert.deepEqual(await f.saved(), [], 'a durable migration receipt prevents resurrection after target pruning')
})

test('private producer originals preserve peer, text, IDs and time while standard unattributed pipeline rows stay at source', settings, async t => {
  const f = await fixture(t, 'private-producer', peer)
  const Archive = createArchiveManagerClass({}), archive = new Archive()
  const text = '  本人私聊原文。\n保留原始空白和时间。', event = { self_id: account.id, user_id: author,
    message_type: 'private', sender: { user_id: author, nickname: '私聊本人' }, message_id: '-7717', time: (now - 60000) / 1000,
    _personaSnapshot: { botId: account.id, personaId: 'agent:daily' }, raw_message: text, message: [{ type: 'text', data: { text } }] }
  const config = { maxMessageLength: 5000, storeMediaUrl: true }
  const row = archive.buildRecord(event, config)
  const unattributed = archive.buildRecord(envelopeToRuntimeEvent(createEventEnvelope({ ...event, message_id: '7718' })), config)
  assert.equal(unattributed.source_bot_id, account.id); assert.equal(unattributed.source_persona_id, undefined)
  await f.seed([row, row, unattributed])
  const file = path.join(f.groupDir, '2026-11-17.ndjson'), before = await readFile(file, 'utf8'), preview = await f.stage()
  assert.equal(preview.report.imported, 1); assert.equal(preview.report.duplicates, 1); assert.equal(preview.report.skipped.identity, 1)
  assert.deepEqual(await f.destination(), []); assert.ok([...f.checks.values()].every(check => check.write === undefined || check.key.startsWith(f.prefix)))
  assert.equal(await f.commit(preview), 1)
  assert.deepEqual(await f.saved(), [{ messageId: '-7717', authorId: author, peerId: author, name: '私聊本人', text, at: now - 60000 }])
  const marker = JSON.parse(await f.reader.get(f.prefix + 'agent:migration:qq-archive:v1:' + f.id))
  assert.deepEqual(marker.scope, { agentId: 'daily', target: peer }); assert.equal(marker.imported[0].source.file, `private/${author}/2026-11-17.ndjson`)
  assert.equal(marker.imported[0].source.line, 1); assert.match(marker.imported[0].source.sha256, /^[a-f0-9]{64}$/u)
  const runtime = createAgentHistory({ redis: f.storage, memory: f.targetMemory, config: () => ({ enabled: true }), resolve: () => ({ binding: f.options.binding }),
    available: () => true, privatePeer: () => author, isRecalled: async () => false, isRunning: () => true,
    begin: async () => ({ isCurrent: () => true, signal: new AbortController().signal, release() {} }), allowsText: () => true, now: () => now, logger: { warn() {} } })
  const answer = await runtime.read(f.options.binding, { question: '本人私聊原文', source: 'recent' },
    { messageId: '9000', authorId: author, text: '查一下我的原文', at: now, mentions: [] }, () => true)
  assert.equal(answer.text.includes('本人私聊原文'), true); assert.equal(await answer.isCurrent(), true)
  const facts = await f.targetMemory.query({ identity: f.identity, subjectId: author, scene: f.scene, viewerUserId: author })
  assert.deepEqual(facts.items, [])
  const saved = await f.destination(), replay = await f.stage()
  assert.equal(replay.report.alreadyImported, 1); assert.equal(await f.commit(replay), 1); assert.deepEqual(await f.destination(), saved)
  await f.store.update(f.id, state => ({ ...state, rows: [] }))
  const pruned = await f.stage(); assert.equal(pruned.report.alreadyImported, 1); assert.equal(await f.commit(pruned), 1); assert.deepEqual(await f.saved(), [])
  assert.equal(await readFile(file, 'utf8'), before)
})
