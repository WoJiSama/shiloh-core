import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
import { createQzoneRedis, qzoneRedisAvailable } from './helpers/agentQzoneRedis.mjs'

const [{ runStandaloneQqMigration }, { readStandaloneAgentConfig }, { agentHistoryId, createAgentHistoryStore },
  { createPersonMemoryStore }, { delegatedMemoryStorageKey }, { KEY }] = await Promise.all([
  load('bootstrap/standaloneAgentMigration.js'), load('bootstrap/standaloneAgentConfig.js'),
  load('modules/memory/infrastructure/agentHistoryStore.js'), load('modules/memory/infrastructure/personMemoryStore.js'),
  load('modules/memory/infrastructure/delegatedMemoryStore.js'), load('modules/memory/infrastructure/engine/constants.js'),
])
const settings = { timeout: 30_000 }
const account = { platform: 'qq', namespace: 'global', id: '19008817' }, connectionId = 'qq-main', author = '3308817'
const target = { account, kind: 'group', id: '3108817' }, peer = { account, kind: 'private', id: author }
const identity = { botId: account.id, personaId: 'agent:daily' }, scene = { kind: 'group', id: target.id }
const memoryBase = `shiloh:person-memory:v1:${account.id}:agent%3Adaily`
const scoped = (reader, prefix) => ({ get: key => reader.get(prefix + key),
  set: (key, value, options) => reader.set(prefix + key, value, options), del: key => reader.del(prefix + key),
  eval: (script, options) => reader.eval(script, { keys: options.keys.map(key => prefix + key), arguments: options.arguments }) })
const original = (at, mid = '8817', text = '  保留完整原话、空白与时间。\n下一行。', extra = {}) => ({ version: 1,
  message_type: 'group', group_id: target.id, source_bot_id: account.id, source_persona_id: identity.personaId,
  message_id: mid, user_id: author, sender: { user_id: author, nickname: '原始提交者', card: '', role: 'member' },
  timestamp: at, raw_message: text, raw_truncated: false, message: [{ type: 'text', text }], source: null, ...extra })
const privateOriginal = (at, mid = '8817', text = '  本人私聊原文。\n保留原始空白。', extra = {}) =>
  original(at, mid, text, { message_type: 'private', group_id: null, ...extra })
const privateAddress = JSON.stringify([account.platform, account.namespace, account.id, peer.kind, peer.id])
const privateRecall = mid => 'agent:inbox:receipt:' + createHash('sha256').update(JSON.stringify(['recall', privateAddress, mid])).digest('hex')
const evalCalls = async reader => Number((await reader.info('commandstats')).match(/^cmdstat_eval:calls=(\d+)/mu)?.[1] ?? 0)

async function fileSnapshot(root) {
  const rows = []
  const visit = async directory => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(name)
      else rows.push([path.relative(root, name), (await readFile(name)).toString('base64')])
    }
  }
  await visit(root)
  return rows
}

async function fixture(t, name, options = {}) {
  const room = options.private ? peer : target
  assert.equal(qzoneRedisAvailable, true, 'public archive cutover requires isolated local Redis')
  const { storage: reader } = await createQzoneRedis(t)
  const socket = reader.options.socket.path
  const directory = await mkdtemp(path.join(tmpdir(), 'archive-public-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const sourceRoot = path.join(directory, 'legacy-plugin'), sourceSettingsDir = path.join(sourceRoot, 'config')
  const destinationRoot = path.join(directory, 'standalone'), sourceDataDir = path.join(directory, 'deliberately-unrelated-data')
  const sourceBindings = path.join(sourceSettingsDir, 'agent-bindings.yaml'), sourceConfig = path.join(sourceSettingsDir, 'message.yaml')
  const configFile = path.join(destinationRoot, 'agent-host.yaml'), destinationBindings = path.join(destinationRoot, 'agent-bindings.yaml')
  const baseDir = options.baseDir === null ? undefined : options.baseDir ?? 'custom/original-logs'
  const archiveRoot = path.resolve(sourceRoot, baseDir ?? 'data/message_archive'), groupDir = path.join(archiveRoot, room.kind, room.id)
  await Promise.all([sourceSettingsDir, destinationRoot, sourceDataDir, groupDir].map(directory => mkdir(directory, { recursive: true })))
  const bindings = { version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: connectionId, platform: 'qq', namespace: 'global', accountId: account.id }],
    bindings: [target, peer].map(room => ({ connectionId, kind: room.kind, conversationId: room.id, agentId: 'daily' })) }
  const sourceDocument = { pluginSettings: { simulation: { enabled: false }, ...(baseDir === undefined ? {} : { messageArchive: { baseDir } }) } }
  const hostDocument = { version: 1, instance: `archive-public-${name}`, privateChat: { enabled: true },
    history: { enabled: options.history !== false }, groupMemory: { enabled: false }, simulation: { enabled: false },
    textGroups: [{ connectionId, conversationId: target.id }],
    model: { baseUrl: 'http://127.0.0.1:9', name: 'unused', apiKeyEnv: 'UNUSED_ARCHIVE_MIGRATION_KEY' },
    connections: [{ id: connectionId, url: 'ws://127.0.0.1:9' }] }
  await Promise.all([writeFile(sourceBindings, JSON.stringify(bindings)), writeFile(destinationBindings, JSON.stringify(bindings)),
    writeFile(sourceConfig, JSON.stringify(sourceDocument)), writeFile(configFile, JSON.stringify(hostDocument))])
  const config = readStandaloneAgentConfig(configFile, { BL_AGENT_REDIS_URL: `unix://${socket}` }, { requireCredentials: false })
  const binding = config.resolvePersona(room).binding, prefix = `bl-agent:${config.instance}:`, storage = scoped(reader, prefix)
  const sourceMemory = createPersonMemoryStore({ redis: reader }), targetMemory = createPersonMemoryStore({ redis: storage })
  const at = Math.floor(Date.now() / 1000) * 1000 - 60_000, file = path.join(groupDir, '2026-11-17.ndjson')
  const migrationOptions = { sourceBindings, sourceConfig, ...(options.private ? {} : { sourceDataDir }), connectionId, kind: room.kind, conversationId: room.id }
  const snapshot = async () => {
    const keys = (await reader.keys('*')).sort()
    return Object.fromEntries(await Promise.all(keys.map(async key => [key, await reader.get(key)])))
  }
  const f = { reader, socket, directory, sourceRoot, sourceConfig, sourceDocument, sourceBindings, destinationBindings,
    configFile, config, bindings, prefix, storage, binding, at, file, archiveRoot, groupDir, sourceDataDir, migrationOptions,
    sourceMemory, targetMemory, store: createAgentHistoryStore(storage), id: agentHistoryId(binding), snapshot,
    migrate: (apply, extra = {}) => runStandaloneQqMigration(config, { ...migrationOptions, moveMessageArchive: true, apply, ...extra }),
    async seed(rows = [(options.private ? privateOriginal : original)(at)]) { await writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n') },
    async delegated() {
      const key = delegatedMemoryStorageKey(binding), raw = JSON.stringify([{ id: 'delegated-original', owner: author,
        ownerName: '原始提交者', content: '一并交接的旧托付', dueAt: 0, status: 'active', createdAt: at, updatedAt: at }])
      await reader.set(key, raw)
      return { key, raw }
    },
    async saved() { return (await f.store.read(f.id))?.rows ?? [] },
  }
  return f
}

// The public config guard is the existing synchronous race seam. Count only the
// parent orchestration's direct guards, excluding the archive's own guard calls.
// The third direct guard runs after every stage and before its final disk/CAS check.
function beforeFinalCheck(f, change) {
  const current = f.config.isConfigCurrent
  let parentChecks = 0, changed = false
  f.config.isConfigCurrent = () => {
    if (/at migrateStandaloneQqState\b/u.test(new Error().stack.split('\n')[3] ?? '') && ++parentChecks === 3) {
      change(); changed = true
    }
    return current()
  }
  return () => assert.equal(changed, true, 'the competing change must finish after staging and before the public final check')
}
function writeRedisSynchronously(f, key, value) {
  const writer = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createClient } from '@redis/client'
    const client = createClient({ socket: { path: process.argv[1], reconnectStrategy: false } })
    await client.connect()
    await client.set(process.argv[2], process.argv[3])
    await client.close()
  `, f.socket, key, value], { encoding: 'utf8', timeout: 5000 })
  assert.equal(writer.status, 0, writer.stderr)
}

test('public preview/apply atomically joins archive, existing person facts and delegated memory while preserving legacy files', settings, async t => {
  const f = await fixture(t, 'atomic'), row = original(f.at, '-8817'), delegated = await f.delegated()
  await f.seed([row, row, original(f.at, '8818', '归属不明保留', { source_persona_id: undefined })])
  const fact = await f.sourceMemory.remember({ identity, subjectId: author, scene,
    source: { scene, authorId: author, messageId: '88001', at: f.at, excerpt: '我喜欢画画。' },
    text: '喜欢画画', category: 'interest', evidenceKind: 'self', sensitivity: 'personal', portable: false })
  assert.equal(fact.saved, true)
  for (const [relative, raw] of [['midterm_memory/group/' + target.id + '.json', '{"summary":"旧群摘要"}'],
    ['episodic/group/' + target.id + '.json', '[{"summary":"旧压缩情节"}]'],
    ['semantic_memory/group/' + target.id + '.ndjson', '{"id":"old-vector","emb":"AAAAAA=="}\n']]) {
    const file = path.join(path.dirname(f.archiveRoot), relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, raw)
  }
  const disk = await fileSnapshot(f.sourceRoot), before = await f.snapshot(), evaluations = await evalCalls(f.reader)
  const preview = await f.migrate(false), repeatedPreview = await f.migrate(false)
  assert.equal(preview.mode, 'preview'); assert.deepEqual(repeatedPreview, preview)
  assert.equal(preview.delegatedMemories, 1); assert.equal(preview.personFacts, 1)
  assert.equal(preview.messageArchive.imported, 1); assert.equal(preview.messageArchive.duplicates, 1)
  assert.equal(preview.messageArchive.skipped.identity, 1); assert.deepEqual(await f.snapshot(), before)
  assert.equal(await evalCalls(f.reader), evaluations)
  const applied = await f.migrate(true)
  assert.deepEqual(applied, { ...preview, mode: 'applied' })
  assert.equal(await evalCalls(f.reader), evaluations + 1, 'all source removals and target archive/privacy writes share one real EVAL')
  assert.equal(await f.reader.get(delegated.key), null); assert.equal(await f.reader.get(f.prefix + delegated.key), delegated.raw)
  assert.deepEqual(await f.saved(), [{ messageId: row.message_id, authorId: author, name: row.sender.nickname, text: row.raw_message, at: row.timestamp }])
  const facts = await f.targetMemory.query({ identity, subjectId: author, scene, viewerUserId: author })
  assert.deepEqual(facts.items.map(item => item.id), [fact.entry.id]); assert.equal(facts.items[0].portable, false)
  const marker = JSON.parse(await f.reader.get(f.prefix + 'agent:migration:qq-archive:v1:' + f.id))
  assert.deepEqual(marker.scope, { agentId: 'daily', target }); assert.equal(marker.imported[0].source.file, `group/${target.id}/2026-11-17.ndjson`)
  assert.equal(marker.imported[0].source.line, 1); assert.equal(JSON.stringify(marker).includes(f.directory), false)
  assert.deepEqual(await fileSnapshot(f.sourceRoot), disk)
  const saved = await f.snapshot(), repeatEvaluations = await evalCalls(f.reader), repeatPreview = await f.migrate(false), repeatApply = await f.migrate(true)
  assert.equal(repeatPreview.messageArchive.imported, 0); assert.equal(repeatPreview.messageArchive.alreadyImported, 1)
  assert.deepEqual(repeatApply, { ...repeatPreview, mode: 'applied' }); assert.deepEqual(await f.snapshot(), saved)
  assert.deepEqual(await fileSnapshot(f.sourceRoot), disk); assert.equal(await evalCalls(f.reader), repeatEvaluations)
})

test('public migration leaves archive opt-in off by default and rejects invalid archive flags and scopes before writing', settings, async t => {
  const f = await fixture(t, 'flags'); await f.seed()
  const disk = await fileSnapshot(f.sourceRoot), preview = await runStandaloneQqMigration(f.config, { ...f.migrationOptions, apply: false })
  assert.equal(preview.messageArchive, undefined)
  const applied = await runStandaloneQqMigration(f.config, { ...f.migrationOptions, apply: true })
  assert.equal(applied.messageArchive, undefined); assert.deepEqual(await f.saved(), [])
  assert.equal((await f.reader.keys(f.prefix + 'agent:migration:qq-archive:*')).length, 0)
  assert.deepEqual(await fileSnapshot(f.sourceRoot), disk)
  const before = await f.snapshot()
  for (const extra of [{ kind: 'channel', conversationId: peer.id }, { moveMessageArchive: 'true' },
    { moveMessageArchive: false, sourceArchiveDir: f.archiveRoot }, { sourceArchiveDir: '' }]) {
    await assert.rejects(f.migrate(true, extra), /群会话|参数无效|延期提醒迁移|显式归档目录/u)
    assert.deepEqual(await f.snapshot(), before)
  }
  const disabled = await fixture(t, 'history-off', { history: false }); await disabled.seed()
  const disabledBefore = await disabled.snapshot()
  await assert.rejects(disabled.migrate(true), /history.enabled=true/u); assert.deepEqual(await disabled.snapshot(), disabledBefore)
  const foreign = structuredClone(f.bindings); foreign.agents[0].id = 'another-agent'; foreign.bindings.forEach(row => { row.agentId = 'another-agent' })
  await writeFile(f.sourceBindings, JSON.stringify(foreign))
  await assert.rejects(f.migrate(true), /来源和目标必须显式绑定/u); assert.deepEqual(await f.snapshot(), before)
})

test('public archive location follows the old plugin root, honors an explicit override and supports the configured default', settings, async t => {
  const f = await fixture(t, 'override'); await f.seed([original(f.at, '8817', '配置目录里的原文')])
  const explicit = path.join(f.directory, 'operator-selected-archive'), explicitGroup = path.join(explicit, 'group', target.id)
  const decoy = path.join(f.sourceDataDir, 'message_archive', 'group', target.id)
  await mkdir(explicitGroup, { recursive: true }); await mkdir(decoy, { recursive: true })
  await writeFile(path.join(explicitGroup, '2026-11-17.ndjson'), JSON.stringify(original(f.at, '8818', '显式目录里的原文')) + '\n')
  await writeFile(path.join(decoy, '2026-11-17.ndjson'), JSON.stringify(original(f.at, '8819', '不应猜测的data目录')) + '\n')
  const sourceFiles = await fileSnapshot(f.sourceRoot), overrideFiles = await fileSnapshot(explicit)
  const selected = await f.migrate(true, { sourceArchiveDir: explicit }); assert.equal(selected.messageArchive.imported, 1)
  assert.deepEqual((await f.saved()).map(row => row.messageId), ['8818'])
  const configured = await f.migrate(true); assert.equal(configured.messageArchive.imported, 1)
  assert.deepEqual((await f.saved()).map(row => row.messageId).sort(), ['8817', '8818'])
  assert.deepEqual(await fileSnapshot(f.sourceRoot), sourceFiles); assert.deepEqual(await fileSnapshot(explicit), overrideFiles)
  const standard = await fixture(t, 'default-directory', { baseDir: null }); await standard.seed()
  assert.equal((await standard.migrate(true)).messageArchive.imported, 1)
  assert.equal((await standard.saved())[0].messageId, '8817')
})

test('public staging honors both source and destination erasure without exposing a preview or regenerating person facts', settings, async t => {
  const f = await fixture(t, 'privacy'), rows = [original(f.at, '8817', '来源侧已遗忘'), original(f.at, '8818', '目标侧已遗忘'), original(f.at, '8819', '允许的完整原文')]
  await f.seed(rows)
  await f.sourceMemory.forget({ identity, subjectId: author, scene, text: rows[0].raw_message, before: Date.now() })
  await f.targetMemory.forget({ identity, subjectId: author, scene, text: rows[1].raw_message, before: Date.now() })
  const before = await f.snapshot(), disk = await fileSnapshot(f.sourceRoot), evaluations = await evalCalls(f.reader)
  const preview = await f.migrate(false)
  assert.equal(preview.messageArchive.imported, 1); assert.equal(preview.messageArchive.skipped.privacy, 2)
  assert.deepEqual(await f.snapshot(), before); assert.equal(await evalCalls(f.reader), evaluations)
  const applied = await f.migrate(true); assert.deepEqual(applied, { ...preview, mode: 'applied' })
  assert.deepEqual((await f.saved()).map(row => row.messageId), ['8819'])
  assert.deepEqual((await f.targetMemory.query({ identity, subjectId: author, scene, viewerUserId: author })).items, [])
  assert.deepEqual(await fileSnapshot(f.sourceRoot), disk)
})

test('a public destination message collision or active privacy lock aborts all previously staged transfers', settings, async t => {
  for (const scenario of ['history-collision', 'source-privacy-lock', 'target-privacy-lock']) {
    const f = await fixture(t, scenario); await f.seed(); const delegated = await f.delegated()
    if (scenario === 'history-collision') await f.store.update(f.id, () => ({ version: 1, id: f.id, scope: { agentId: 'daily', target },
      rows: [{ messageId: '8817', authorId: author, name: '原始提交者', text: '相同编号已有不同原文', at: f.at }] }))
    else await f.reader.set((scenario === 'target-privacy-lock' ? f.prefix : '') + memoryBase + ':lock', 'active-privacy-writer')
    const before = await f.snapshot(), disk = await fileSnapshot(f.sourceRoot), evaluations = await evalCalls(f.reader)
    await assert.rejects(f.migrate(true), /目标已有同编号|人物记忆正在更新/u)
    assert.deepEqual(await f.snapshot(), before); assert.deepEqual(await fileSnapshot(f.sourceRoot), disk)
    assert.equal(await f.reader.get(delegated.key), delegated.raw); assert.equal(await evalCalls(f.reader), evaluations)
  }
})

test('public final disk/config rechecks reject post-staging source changes before any atomic handover', settings, async t => {
  for (const scenario of ['archive-file', 'new-file', 'semantic-tombstone', 'source-config', 'target-config', 'source-binding']) {
    const f = await fixture(t, scenario); await f.seed(); await f.delegated()
    const before = await f.snapshot(), evaluations = await evalCalls(f.reader)
    const changed = beforeFinalCheck(f, () => {
      if (scenario === 'archive-file') fs.writeFileSync(f.file, JSON.stringify(original(f.at, '8817', '最终复核之前发生改变')) + '\n')
      if (scenario === 'new-file') fs.writeFileSync(path.join(f.groupDir, '2026-11-16.ndjson'), JSON.stringify(original(f.at, '8818')) + '\n')
      if (scenario === 'semantic-tombstone') {
        const directory = path.join(path.dirname(f.archiveRoot), 'semantic_memory', 'redactions'); fs.mkdirSync(directory, { recursive: true })
        fs.writeFileSync(path.join(directory, target.id + '.json'), JSON.stringify({ ids: [], messages: ['8817'] }))
      }
      if (scenario === 'source-config') fs.writeFileSync(f.sourceConfig, JSON.stringify({ ...f.sourceDocument, changed: true }))
      if (scenario === 'target-config') fs.appendFileSync(f.configFile, '\n')
      if (scenario === 'source-binding') fs.appendFileSync(f.sourceBindings, '\n')
    })
    await assert.rejects(f.migrate(true), /配置|绑定|归档|迁移期间/u)
    changed(); assert.deepEqual(await f.snapshot(), before); assert.equal(await evalCalls(f.reader), evaluations)
  }
})

test('public final CAS rejects source/destination privacy or recall races and leaves every other ledger byte unchanged', settings, async t => {
  for (const scenario of ['source-person', 'target-person', 'legacy-meta', 'inbox-recall', 'host-lease']) {
    const f = await fixture(t, scenario); await f.seed(); await f.delegated()
    await f.sourceMemory.registerSource({ identity, subjectId: author, source: { scene, authorId: author, messageId: '8817', at: f.at, excerpt: original(f.at).raw_message } })
    const personKey = memoryBase + ':person:' + author, person = JSON.parse(await f.reader.get(personKey)); person.enabled = false; person.revision++
    const recall = 'agent:inbox:text-recall-receipt:' + createHash('sha256')
      .update(JSON.stringify(['text-recall', JSON.stringify([account.platform, account.namespace, account.id, target.kind, target.id]), '8817'])).digest('hex')
    const [key, value] = scenario === 'source-person' ? [personKey, JSON.stringify(person)]
      : scenario === 'target-person' ? [f.prefix + personKey, JSON.stringify(person)]
        : scenario === 'legacy-meta' ? [KEY.meta(target.id), JSON.stringify({ disabled: true, optedOut: [] })]
          : scenario === 'inbox-recall' ? [f.prefix + recall, '1'] : [f.prefix + 'agent:host-lease', 'new-host-owner']
    const before = await f.snapshot(), disk = await fileSnapshot(f.sourceRoot), evaluations = await evalCalls(f.reader)
    const changed = beforeFinalCheck(f, () => writeRedisSynchronously(f, key, value))
    await assert.rejects(f.migrate(true), /迁移期间账本有变更/u)
    changed(); assert.deepEqual(await f.snapshot(), { ...before, [key]: value }); assert.deepEqual(await fileSnapshot(f.sourceRoot), disk)
    assert.equal(await evalCalls(f.reader), evaluations + 1, 'the only attempted handover is the rejecting atomic CAS')
  }
})

test('missing source cleanup permission rejects the public archive-plus-ledger CAS before writing either side', settings, async t => {
  const f = await fixture(t, 'acl'); await f.seed(); await f.delegated()
  const before = await f.snapshot(), disk = await fileSnapshot(f.sourceRoot), evaluations = await evalCalls(f.reader)
  await f.reader.sendCommand(['ACL', 'SETUSER', 'default', '-del'])
  try { await assert.rejects(f.migrate(true), /Redis 账号缺少迁移所需的账本写入权限/u) }
  finally { await f.reader.sendCommand(['ACL', 'SETUSER', 'default', '+del']) }
  assert.deepEqual(await f.snapshot(), before); assert.deepEqual(await fileSnapshot(f.sourceRoot), disk)
  assert.equal(await evalCalls(f.reader), evaluations + 1)
})

test('public private archive remains opt-in and joins existing private person facts in one source-preserving CAS', settings, async t => {
  const f = await fixture(t, 'private-apply', { private: true }), row = privateOriginal(f.at)
  await f.seed([row, row, privateOriginal(f.at, '8818', '历史流水线缺接收Agent', { source_persona_id: undefined })])
  const privateScene = { kind: 'private', id: author }
  const fact = await f.sourceMemory.remember({ identity, subjectId: author, source: { scene: privateScene, authorId: author,
    messageId: row.message_id, at: f.at, excerpt: row.raw_message }, text: '喜欢画画', category: 'interest', evidenceKind: 'self', sensitivity: 'personal', portable: false })
  assert.equal(fact.saved, true)
  const before = await f.snapshot(), disk = await fileSnapshot(f.sourceRoot), evaluations = await evalCalls(f.reader)
  const off = await f.migrate(false, { moveMessageArchive: false }); assert.equal(off.messageArchive, undefined)
  const preview = await f.migrate(false)
  assert.equal(preview.friendId, author); assert.equal(preview.messageArchive.imported, 1); assert.equal(preview.messageArchive.duplicates, 1)
  assert.equal(preview.messageArchive.skipped.identity, 1); assert.equal(preview.personFacts, 1)
  assert.deepEqual(await f.snapshot(), before); assert.equal(await evalCalls(f.reader), evaluations)
  const applied = await f.migrate(true); assert.deepEqual(applied, { ...preview, mode: 'applied' })
  assert.equal(await evalCalls(f.reader), evaluations + 1)
  assert.deepEqual(await f.saved(), [{ messageId: row.message_id, authorId: author, peerId: author, name: row.sender.nickname, text: row.raw_message, at: row.timestamp }])
  const facts = await f.targetMemory.query({ identity, subjectId: author, scene: privateScene, viewerUserId: author })
  assert.deepEqual(facts.items.map(item => [item.id, item.text, item.portable]), [[fact.entry.id, '喜欢画画', false]])
  const marker = JSON.parse(await f.reader.get(f.prefix + 'agent:migration:qq-archive:v1:' + f.id))
  assert.equal(marker.imported[0].source.file, `private/${author}/2026-11-17.ndjson`)
  const snapshot = await f.snapshot(), repeated = await f.migrate(true)
  assert.equal(repeated.messageArchive.imported, 0); assert.equal(repeated.messageArchive.alreadyImported, 1)
  assert.deepEqual(await f.snapshot(), snapshot); assert.deepEqual(await fileSnapshot(f.sourceRoot), disk)
})

test('public private source config and explicit archive roots resolve independently of group-only data directories', settings, async t => {
  const f = await fixture(t, 'private-path', { private: true }); await f.seed()
  const explicit = path.join(f.sourceRoot, 'selected-private'), selected = path.join(explicit, 'private', author)
  await mkdir(selected, { recursive: true }); await writeFile(path.join(selected, '2026-11-17.ndjson'), JSON.stringify(privateOriginal(f.at, '8899', '显式目录私聊原文')) + '\n')
  const preview = await f.migrate(false, { sourceArchiveDir: explicit }); assert.equal(preview.messageArchive.imported, 1)
  assert.equal((await f.migrate(true, { sourceArchiveDir: explicit })).messageArchive.imported, 1)
  assert.deepEqual((await f.saved()).map(row => row.messageId), ['8899'])
  const standard = await fixture(t, 'private-default', { private: true, baseDir: null }); await standard.seed()
  assert.equal((await standard.migrate(true)).messageArchive.imported, 1)
})

test('public private imports honor source and destination recalls and privacy while ignoring same-number groups', settings, async t => {
  const f = await fixture(t, 'private-suppression', { private: true }), privateScene = { kind: 'private', id: author }
  const rows = Array.from({ length: 5 }, (_, index) => privateOriginal(f.at, String(8900 + index), `私聊完整原话${index}`))
  await f.seed(rows)
  await f.reader.set(KEY.meta(author), '{invalid same-number group privacy')
  const unrelated = path.join(path.dirname(f.archiveRoot), 'semantic_memory', 'redactions'); await mkdir(unrelated, { recursive: true })
  await writeFile(path.join(unrelated, author + '.json'), '{invalid same-number group erasure')
  await f.sourceMemory.forget({ identity, subjectId: author, scene: privateScene, text: rows[0].raw_message, before: Date.now() })
  await f.targetMemory.forget({ identity, subjectId: author, scene: privateScene, text: rows[1].raw_message, before: Date.now() })
  await f.reader.set(privateRecall('8902'), '1'); await f.reader.set(f.prefix + privateRecall('8903'), '1')
  const before = await f.snapshot(), disk = await fileSnapshot(f.sourceRoot), preview = await f.migrate(false)
  assert.equal(preview.messageArchive.imported, 1); assert.equal(preview.messageArchive.skipped.privacy, 2); assert.equal(preview.messageArchive.skipped.recalled, 2)
  assert.deepEqual(await f.snapshot(), before); await f.migrate(true)
  assert.deepEqual((await f.saved()).map(row => row.messageId), ['8904']); assert.deepEqual(await fileSnapshot(f.sourceRoot), disk)
})

test('public private final checks reject source files, source config and source/target binding changes', settings, async t => {
  for (const scenario of ['archive-file', 'new-file', 'source-config', 'source-binding', 'target-binding']) {
    const f = await fixture(t, 'private-' + scenario, { private: true }); await f.seed()
    const before = await f.snapshot(), evaluations = await evalCalls(f.reader)
    const changed = beforeFinalCheck(f, () => {
      if (scenario === 'archive-file') fs.writeFileSync(f.file, JSON.stringify(privateOriginal(f.at, '8817', '最终检查前更改')) + '\n')
      if (scenario === 'new-file') fs.writeFileSync(path.join(f.groupDir, '2026-11-16.ndjson'), JSON.stringify(privateOriginal(f.at, '8818')) + '\n')
      if (scenario === 'source-config') fs.appendFileSync(f.sourceConfig, '\n')
      if (scenario === 'source-binding') fs.appendFileSync(f.sourceBindings, '\n')
      if (scenario === 'target-binding') fs.appendFileSync(f.destinationBindings, '\n')
    })
    await assert.rejects(f.migrate(true), /配置|绑定|归档|迁移期间/u)
    changed(); assert.deepEqual(await f.snapshot(), before); assert.equal(await evalCalls(f.reader), evaluations)
  }
})

test('public private CAS rejects either side of privacy or recall changes without partially moving person facts', settings, async t => {
  for (const destination of [false, true]) for (const suffix of ['scope', 'person', 'privacy-lock', 'identity-lock', 'recall', 'recall-epoch']) {
    const f = await fixture(t, `private-cas-${destination ? 'target' : 'source'}-${suffix}`, { private: true }); await f.seed()
    await f.sourceMemory.remember({ identity, subjectId: author, source: { scene: { kind: 'private', id: author }, authorId: author,
      messageId: '8817', at: f.at, excerpt: privateOriginal(f.at).raw_message }, text: '待交接的人物事实', category: 'fact', evidenceKind: 'self' })
    const key = (destination ? f.prefix : '') + (suffix === 'scope' ? memoryBase + ':scope' : suffix === 'person' ? memoryBase + ':person:' + author
      : suffix === 'privacy-lock' ? memoryBase + ':lock' : suffix === 'identity-lock' ? 'shiloh:person-memory:v1:identities:lock'
        : suffix === 'recall' ? privateRecall('8817') : 'agent:private-recall:' + privateAddress)
    const before = await f.snapshot(), disk = await fileSnapshot(f.sourceRoot), evaluations = await evalCalls(f.reader)
    const changed = beforeFinalCheck(f, () => writeRedisSynchronously(f, key, 'concurrent-change'))
    await assert.rejects(f.migrate(true), /迁移期间账本有变更/u)
    changed(); assert.deepEqual(await f.snapshot(), { ...before, [key]: 'concurrent-change' }); assert.deepEqual(await fileSnapshot(f.sourceRoot), disk)
    assert.equal(await evalCalls(f.reader), evaluations + 1)
  }
})
