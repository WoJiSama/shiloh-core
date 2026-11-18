import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const [{ stageStandaloneAgentArchiveMigration: stage }, { createAgentHistoryStore, agentHistoryId },
  { createPersonMemoryStore }, { KEY }, { createAgentHistory }, { agentMemoryScope }] = await Promise.all([
  load('bootstrap/standaloneAgentArchiveMigration.js'), load('modules/memory/infrastructure/agentHistoryStore.js'),
  load('modules/memory/infrastructure/personMemoryStore.js'), load('modules/memory/infrastructure/engine/constants.js'),
  load('modules/memory/infrastructure/agentHistory.js'),
  load('modules/memory/domain/memoryScope.js'),
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
const privateOriginal = (id = '7717', text = '完整私聊原文与原时间。', extra = {}) => original(id, text, { message_type: 'private', group_id: null, ...extra })
const addressKey = room => JSON.stringify([room.account.platform, room.account.namespace, room.account.id, room.kind, room.id])
const recallKey = (kind, mid, room = target) => `agent:inbox:${kind === 'text-recall' ? 'text-recall-receipt' : 'receipt'}:${createHash('sha256')
  .update(JSON.stringify([kind, addressKey(room), mid])).digest('hex')}`
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

test('unscoped, foreign, generated, truncated, ambiguous and unsupported sources remain untouched', settings, async t => {
  const f = await fixture(t, 'scope'), changes = [
    { source_bot_id: undefined }, { source_persona_id: undefined }, { source_bot_id: '19007718' }, { source_persona_id: 'agent:other' },
    { group_id: '3107718' }, { raw_truncated: true }, { source: 'send' }, { user_id: account.id, sender: { user_id: account.id } },
    { personaSource: { botId: account.id, personaId: 'agent:daily' } }, { sender: { user_id: '3307718' } },
    { message: [{ type: 'reply', id: '999' }] }, { message: [{ type: 'forward', id: 'foreign' }] },
    { raw_message: '与分段内容冲突' }, { sender: { user_id: author, nickname: '长'.repeat(25) } },
    { message_id: 'opaque-legacy-id' }, { message_id: 0 },
  ]
  await f.seed(changes.map((extra, index) => original(String(8000 + index), '完整原文与原时间。', extra)))
  const result = await f.stage(); assert.equal(result.report.imported, 0); assert.equal(result.report.retained, changes.length)
  assert.equal(await f.commit(result), 1); assert.deepEqual(await f.destination(), [])
  for (const extra of [{ binding: { ...binding, agentId: 'other' } }, { binding: { ...binding, target: { ...target, account: { ...account, namespace: 'isolated' } } } },
    { binding: { ...binding, target: { ...target, kind: 'private', id: author } } }, { history: { enabled: false } },
    { binding: {} }, { sourceBinding: { ...binding, target: null } }, { binding: { ...binding, personaId: undefined } }]) {
    await assert.rejects(f.stage(extra), /QQ\/global群或私聊绑定/u); assert.deepEqual(await f.destination(), [])
  }
})

test('conflicting copies never win by position and a destination conflict leaves the shared staging map unchanged', settings, async t => {
  const f = await fixture(t, 'conflict')
  await f.seed([original(), original('7717', '相同编号，另一段文字。')])
  assert.equal((await f.stage()).report.skipped.conflict, 1); assert.deepEqual(await f.destination(), [])
  await f.seed([original()])
  await f.store.update(f.id, () => ({ version: 1, id: f.id, scope: { agentId: binding.agentId, target },
    rows: [{ messageId: '7717', authorId: author, name: '来源作者', text: '目标已有其他文字', at: now - 60000 }] }))
  f.checks.clear()
  const seed = { key: f.prefix + 'parent-staged', value: null, write: 'preserve' }; f.checks.set(seed.key, seed)
  const before = structuredClone([...f.checks])
  await assert.rejects(stage(f.options), /目标已有同编号/u)
  assert.deepEqual([...f.checks], before)
})

test('recall flags, notices in another archive file and both inbox recall forms suppress original imports', settings, async t => {
  const f = await fixture(t, 'recall')
  await f.seed([original('7717', '撤回标记', { recalled: true }), original('7718', '撤回通知'), original('7719', '正常保留'),
    original('7720', '来源事件撤回'), original('7721', '来源文字撤回'), original('7722', '目标事件撤回'), original('7723', '目标文字撤回')])
  for (const [kind, mid, base] of [['recall', '7720', ''], ['text-recall', '7721', ''], ['recall', '7722', f.prefix], ['text-recall', '7723', f.prefix]]) {
    await f.reader.set(base + recallKey(kind, mid), '1')
  }
  await f.seed([{ version: 1, archive_kind: 'notice', message_type: 'group', group_id: target.id,
    notice_type: 'group.recall', source_bot_id: account.id, message_id: '7718' }], '2026-11-16')
  const result = await f.stage(); assert.equal(result.report.imported, 1); assert.equal(result.report.skipped.recalled, 6)
  assert.equal(await f.commit(result), 1); assert.equal((await f.saved())[0].messageId, '7719')
  await f.seed([original('7717', '撤回标记', { recalled: true }), original('7718', '撤回通知'), original('7719', '正常保留', { recalled: true })])
  const withdrawal = await f.stage(); assert.equal(withdrawal.report.removed, 1); assert.equal(await f.commit(withdrawal), 1)
  assert.deepEqual(await f.saved(), [])
  const privacy = await f.targetMemory.getRedactions({ identity: f.identity, subjectId: author })
  assert.ok(privacy.revokedSources.some(key => key.includes('7719')))
})

test('receipt-owned rows still withdraw after conflicting, incomplete or missing source copies', settings, async t => {
  const f = await fixture(t, 'withdrawal'), rows = [original('7717', '冲突后撤回'), original('7718', '文件缺失后撤回'),
    original('7719', '分段损坏后撤回'), original('7720', '来源归档缺失后的遗忘')]
  await f.seed(rows); assert.equal(await f.commit(await f.stage()), 1)
  await f.seed([original('7717', '冲突后撤回', { recalled: true }), original('7717', '出现冲突的另一副本'),
    original('7719', '分段损坏后撤回', { raw_truncated: true })])
  await f.reader.set(recallKey('recall', '7718'), '1')
  await f.reader.set(f.prefix + recallKey('text-recall', '7719'), '1')
  await f.sourceMemory.forget({ identity: f.identity, subjectId: author, scene: f.scene, text: rows[3].raw_message, before: now })
  const result = await f.stage(); assert.equal(result.report.removed, 4); assert.equal(result.report.imported, 0)
  assert.equal(result.report.skipped.conflict, 1); assert.equal(result.report.skipped.incomplete, 1)
  assert.equal(await f.commit(result), 1); assert.deepEqual(await f.saved(), [])
  const privacy = await f.targetMemory.getRedactions({ identity: f.identity, subjectId: author })
  assert.ok(rows.every(row => privacy.revokedSources.some(key => key.includes(row.message_id))))
  await f.seed(rows); const replay = await f.stage(); assert.equal(replay.report.imported, 0)
  assert.equal(await f.commit(replay), 1); assert.deepEqual(await f.saved(), [])
})

test('source and target JSON property order does not change exact row identity or its durable receipt', settings, async t => {
  const f = await fixture(t, 'field-order'), row = original()
  const reversed = Object.fromEntries(Object.entries({ ...row, sender: Object.fromEntries(Object.entries(row.sender).reverse()) }).reverse())
  await f.seed([row, reversed]); const first = await f.stage()
  assert.equal(first.report.imported, 1); assert.equal(first.report.duplicates, 1); assert.equal(await f.commit(first), 1)
  assert.equal(await f.store.update(f.id, state => ({ ...state, rows: state.rows.map(row => Object.fromEntries(Object.entries(row).reverse())) })), true)
  const saved = await f.destination(), replay = await f.stage()
  assert.equal(replay.report.alreadyImported, 1); assert.equal(replay.report.imported, 0); assert.equal(await f.commit(replay), 1)
  assert.deepEqual(await f.destination(), saved)
  const adopted = await fixture(t, 'existing-order')
  await adopted.store.update(adopted.id, () => ({ version: 1, id: adopted.id, scope: { agentId: binding.agentId, target },
    rows: [{ at: row.timestamp, text: row.raw_message, name: row.sender.nickname, authorId: author, messageId: row.message_id }] }))
  await adopted.seed([row]); assert.equal((await adopted.stage()).report.imported, 1)
})

test('a changed target row cannot be claimed or withdrawn by an old migration receipt', settings, async t => {
  const f = await fixture(t, 'receipt-conflict'); await f.seed([original()]); assert.equal(await f.commit(await f.stage()), 1)
  const key = f.prefix + 'agent:history:v1:state:' + f.id, state = JSON.parse(await f.reader.get(key))
  state.rows[0].text = '目标内容已被替换'
  await f.reader.set(key, JSON.stringify(state)); await f.reader.set(recallKey('recall', '7717'), '1')
  f.checks.clear(); const seed = { key: f.prefix + 'parent-staged', value: null, write: 'preserve' }; f.checks.set(seed.key, seed)
  const before = structuredClone([...f.checks]), destination = await f.destination()
  await assert.rejects(stage(f.options), /目标原文与既有交接来源冲突/u)
  assert.deepEqual([...f.checks], before); assert.deepEqual(await f.destination(), destination)
})

test('source and target person erasure, group opt-outs and output policy are checked without generating portable facts', settings, async t => {
  const f = await fixture(t, 'privacy')
  await f.seed([original('7717', '应被遗忘的正文'), original('7718', '新的允许原文'), original('7719', 'PRIVATE_HOST_CREDENTIAL')])
  await f.sourceMemory.forget({ identity: f.identity, subjectId: author, scene: f.scene, text: '应被遗忘的正文', before: now })
  const result = await f.stage(); assert.equal(result.report.imported, 1); assert.equal(result.report.skipped.privacy, 1); assert.equal(result.report.skipped.policy, 1)
  assert.equal(await f.commit(result), 1)
  const facts = await f.targetMemory.query({ identity: f.identity, subjectId: author, scene: f.scene, viewerUserId: author })
  assert.deepEqual(facts.items, [], 'registering a source is not a new inferred or portable person fact')
  await f.targetMemory.setEnabled({ identity: f.identity, subjectId: author, scene: f.scene, enabled: false })
  const revoked = await f.stage(); assert.equal(revoked.report.removed, 1); assert.equal(await f.commit(revoked), 1); assert.deepEqual(await f.saved(), [])
  const opted = await fixture(t, 'opted'); await opted.seed([original()])
  await opted.reader.set(KEY.meta(target.id), JSON.stringify({ disabled: false, optedOut: [author] }))
  assert.equal((await opted.stage()).report.skipped.privacy, 1); assert.deepEqual(await opted.destination(), [])
})

test('semantic message tombstones are respected; unresolved chunk lineage blocks the scope and corrupt tombstones fail closed', settings, async t => {
  const f = await fixture(t, 'semantic')
  await f.seed([original(), original('7718', '保留的另一条原话')]); await f.semantic({ ids: [], messages: ['7717'] })
  const result = await f.stage(); assert.equal(result.report.imported, 1); assert.equal(result.report.skipped.recalled, 1)
  await f.semantic({ ids: ['old-chunk'], messages: ['7717'] }, [{ id: 'old-chunk', message_ids: ['7717'] }])
  assert.equal((await f.stage()).report.imported, 1)
  await f.semantic({ ids: ['missing-chunk'], messages: ['7717'] })
  const unresolved = await f.stage(); assert.equal(unresolved.report.imported, 0); assert.equal(unresolved.report.skipped.semanticDependency, 2)
  await f.semantic('{bad tombstone'); await assert.rejects(f.stage(), /语义遗忘记录损坏/u); assert.deepEqual(f.checks.size, 0)
  assert.deepEqual(await f.destination(), [])
})

test('unresolved semantic erasure withdraws only verified migration-owned rows without inventing chunk lineage', settings, async t => {
  const f = await fixture(t, 'semantic-withdrawal')
  await f.store.update(f.id, () => ({ version: 1, id: f.id, scope: { agentId: binding.agentId, target },
    rows: [{ messageId: '9000', authorId: author, name: '', text: '目标原有原话', at: now - 1000 }] }))
  await f.seed([original(), original('7718', '第二条完整原文')]); assert.equal(await f.commit(await f.stage()), 1)
  await f.semantic({ ids: ['missing-chunk'], messages: [] })
  const result = await f.stage(); assert.equal(result.report.removed, 2); assert.equal(result.report.imported, 0)
  assert.equal(result.report.skipped.semanticDependency, 2); assert.equal(await f.commit(result), 1)
  assert.deepEqual((await f.saved()).map(row => row.messageId), ['9000'])
  const source = await readFile(path.join(f.groupDir, '2026-11-17.ndjson'), 'utf8')
  assert.equal(source.includes('第二条完整原文'), true)
})

test('retention, capacity and canonical history consumers preserve all accepted source fields and authority', settings, async t => {
  const f = await fixture(t, 'history')
  await f.seed([original('7717', '过期旧消息', { timestamp: now - 31 * 86400000 }), original('7718', '可核实的完整原文')])
  const result = await f.stage(); assert.equal(result.report.skipped.expired, 1); assert.equal(result.report.imported, 1); assert.equal(await f.commit(result), 1)
  const runtime = createAgentHistory({ redis: f.storage, memory: f.targetMemory, config: () => ({ enabled: true }), resolve: () => ({ binding }),
    available: () => true, privatePeer: () => undefined, isRecalled: async () => false, isRunning: () => true,
    begin: async () => ({ isCurrent: () => true, signal: new AbortController().signal, release() {} }), allowsText: () => true, now: () => now,
    logger: { warn() {} } })
  const answer = await runtime.read(binding, { question: '完整原文', source: 'recent' },
    { messageId: '9000', authorId: author, text: '查一下我的完整原文', at: now, mentions: [] }, () => true)
  assert.equal(answer.text.includes('可核实的完整原文'), true); assert.equal(await answer.isCurrent(), true)
  const full = await fixture(t, 'capacity')
  await full.store.update(full.id, () => ({ version: 1, id: full.id, scope: { agentId: binding.agentId, target },
    rows: Array.from({ length: 50 }, (_, index) => ({ messageId: String(10000 + index), authorId: author, name: '', text: '目标既有原话', at: now - 1000 })) }))
  await full.seed([original()]); const capacity = await full.stage({ history: { enabled: true, maxMessagesPerConversation: 50 } })
  assert.equal(capacity.report.skipped.capacity, 1); assert.equal(capacity.report.imported, 0); assert.equal((await full.saved()).length, 50)
})

test('filesystem/config changes and Redis CAS races cannot turn a stale preview into a partial import', settings, async t => {
  const f = await fixture(t, 'stale'); await f.seed([original()])
  const changed = await f.stage(); await f.seed([original('7717', '预览之后改变')]); assert.equal(changed.isCurrent(), false)
  await f.seed([original()]); const added = await f.stage(); await f.seed([original('7718')], '2026-11-16'); assert.equal(added.isCurrent(), false)
  await rm(path.join(f.groupDir, '2026-11-16.ndjson'))
  await f.seed([original()]); const missing = await f.stage(); await f.semantic({ ids: [], messages: ['7717'] }); assert.equal(missing.isCurrent(), false)
  const fresh = await f.stage(); f.revoke(); assert.equal(fresh.isCurrent(), false)
  const race = await fixture(t, 'race'); await race.seed([original()]); const result = await race.stage()
  await race.reader.set(race.prefix + 'agent:host-lease', 'new-owner')
  assert.equal(await race.commit(result), 0); assert.deepEqual(await race.saved(), [])
  assert.equal((await race.reader.keys(race.prefix + 'agent:migration:*')).length, 0)
  const privacy = await fixture(t, 'privacy-race'); await privacy.seed([original()]); const stale = await privacy.stage()
  await privacy.sourceMemory.forget({ identity: privacy.identity, subjectId: author, scene: privacy.scene, text: original().raw_message, before: now })
  assert.equal(await privacy.commit(stale), 0); assert.deepEqual(await privacy.destination(), [])
})

test('bad archive JSON, symlink sources and an active privacy lock abort without mutating parent staging', settings, async t => {
  const f = await fixture(t, 'invalid'); const file = path.join(f.groupDir, '2026-11-17.ndjson')
  await writeFile(file, JSON.stringify(original()) + '\n{broken\n'); await assert.rejects(f.stage(), /归档损坏/u)
  assert.equal(f.checks.size, 0); await rm(file); const outside = path.join(f.directory, 'outside.ndjson')
  await writeFile(outside, JSON.stringify(original()) + '\n'); await symlink(outside, file)
  await assert.rejects(f.stage(), /符号链接/u); assert.equal(f.checks.size, 0); await rm(file)
  await f.seed([original()]); await f.reader.set(`shiloh:person-memory:v1:${account.id}:agent%3Adaily:lock`, 'busy')
  await assert.rejects(f.stage(), /隐私仍在更新/u); assert.equal(f.checks.size, 0); assert.deepEqual(await f.destination(), [])
})

test('private admission never infers account, Agent or peer and rejects outgoing, incomplete or transformed text', settings, async t => {
  const f = await fixture(t, 'private-admission', peer), changes = [
    { source_bot_id: undefined }, { source_persona_id: undefined }, { source_bot_id: '19007718' }, { source_persona_id: 'agent:other' },
    { message_type: 'group', group_id: author }, { group_id: author }, { group_id: undefined },
    { user_id: '3307718', sender: { user_id: '3307718' } }, { sender: { user_id: '3307718' } },
    { user_id: account.id, sender: { user_id: account.id } }, { source: 'send' }, { source: 'tool' },
    { personaSource: { botId: account.id, personaId: 'agent:daily' } }, { raw_truncated: true }, { raw_truncated: undefined },
    { message: [{ type: 'forward', id: '7717' }] }, { message: [{ type: 'image', file: 'private' }] },
    { message: [{ type: 'text', text: '被转换的文本' }] }, { timestamp: 0 }, { timestamp: now + 60001 }, { message_id: undefined },
  ]
  await f.seed(changes.map((extra, index) => privateOriginal(String(8100 + index), '完整私聊原文与原时间。', extra)))
  const result = await f.stage(); assert.equal(result.report.imported, 0); assert.equal(result.report.retained, changes.length)
  assert.equal(await f.commit(result), 1); assert.deepEqual(await f.destination(), [])
  for (const extra of [{ history: { enabled: false } }, { sourceBinding: { ...f.options.sourceBinding, agentId: 'other' } },
    { sourceBinding: { ...f.options.sourceBinding, target: { ...peer, id: '3307718' } } }]) await assert.rejects(f.stage(extra), /QQ\/global/u)
})

test('private scope ignores same-number group privacy and unrelated account, Agent and peer evidence', settings, async t => {
  const f = await fixture(t, 'private-isolation', peer); await f.seed([privateOriginal()])
  await f.reader.set(KEY.meta(author), '{invalid group privacy')
  await f.semantic('{invalid group semantic tombstone')
  for (const room of [{ ...peer, kind: 'group' }, { ...peer, id: '3307718' }, { ...peer, account: { ...account, id: '19007718' } }]) {
    for (const base of ['', f.prefix]) await f.reader.set(base + recallKey('recall', '7717', room), '1')
  }
  await f.sourceMemory.setEnabled({ identity: { ...f.identity, personaId: 'agent:other' }, subjectId: author, enabled: false })
  await f.sourceMemory.setEnabled({ identity: { ...f.identity, botId: '19007718' }, subjectId: author, enabled: false })
  await f.sourceMemory.forgetScene({ identity: f.identity, scene: { kind: 'group', id: author }, before: now })
  await f.targetMemory.forgetScene({ identity: f.identity, scene: { kind: 'private', id: '3307718' }, before: now })
  const result = await f.stage(); assert.equal(result.report.imported, 1); assert.equal(f.checks.has(KEY.meta(author)), false)
  await f.semantic('{changed but still unrelated group tombstone'); assert.equal(result.isCurrent(), true)
  assert.equal(await f.commit(result), 1); assert.equal((await f.saved()).length, 1)
})

test('private source and destination erasures, recalls and exact private metadata suppress imports', settings, async t => {
  const f = await fixture(t, 'private-privacy', peer), rows = Array.from({ length: 8 }, (_, index) => privateOriginal(String(8200 + index), `本人原文${index}`))
  rows[6].recalled = true
  await f.seed(rows)
  for (const [index, store] of [[0, f.sourceMemory], [1, f.targetMemory]]) await store.forget({ identity: f.identity, subjectId: author,
    scene: f.scene, text: rows[index].raw_message, before: now })
  await f.reader.set(recallKey('recall', '8202', peer), '1'); await f.reader.set(f.prefix + recallKey('recall', '8203', peer), '1')
  await f.sourceMemory.revokeSource({ identity: f.identity, scene: f.scene, messageId: '8204' })
  await f.targetMemory.revokeSource({ identity: f.identity, scene: f.scene, messageId: '8205' })
  const result = await f.stage(); assert.equal(result.report.imported, 1); assert.equal(result.report.skipped.privacy, 4); assert.equal(result.report.skipped.recalled, 3)
  assert.equal(await f.commit(result), 1); assert.deepEqual((await f.saved()).map(row => row.messageId), ['8207'])
  for (const base of ['', f.prefix]) for (const scope of [agentMemoryScope(f.options.binding), `private:${account.id}:agent%3Adaily:${author}`]) {
    const g = await fixture(t, `private-meta-${base ? 'target' : 'source'}-${scope.startsWith('agent:') ? 'agent' : 'legacy'}`, peer)
    await g.seed([privateOriginal()]); await g.reader.set((base ? g.prefix : '') + KEY.meta(scope), JSON.stringify({ disabled: false, optedOut: [author] }))
    const blocked = await g.stage(); assert.equal(blocked.report.imported, 0); assert.equal(blocked.report.skipped.privacy, 1)
  }
})

test('private conflicts abort without leaking planned writes and receipt withdrawal survives source loss', settings, async t => {
  const f = await fixture(t, 'private-conflict', peer)
  await f.seed([privateOriginal(), privateOriginal('7717', '不同副本')]); assert.equal((await f.stage()).report.skipped.conflict, 1)
  await f.seed([privateOriginal(), privateOriginal('7718', '副本消失后撤回')]); assert.equal(await f.commit(await f.stage()), 1)
  const file = path.join(f.groupDir, '2026-11-17.ndjson'); await rm(file)
  await f.sourceMemory.forget({ identity: f.identity, subjectId: author, scene: f.scene, text: privateOriginal().raw_message, before: now })
  await f.reader.set(f.prefix + recallKey('recall', '7718', peer), '1')
  const withdrawn = await f.stage(); assert.equal(withdrawn.report.removed, 2); assert.equal(await f.commit(withdrawn), 1)
  await f.seed([privateOriginal(), privateOriginal('7718', '副本消失后撤回')]); assert.equal((await f.stage()).report.imported, 0)
  const g = await fixture(t, 'private-target-conflict', peer)
  await g.seed([privateOriginal()]); await g.store.update(g.id, () => ({ version: 1, id: g.id, scope: { agentId: 'daily', target: peer },
    rows: [{ messageId: '7717', authorId: author, peerId: author, name: '', text: '目标同编号其他内容', at: now - 60000 }] }))
  const entry = { key: g.prefix + 'parent', value: null, write: 'preserve' }; g.checks.set(entry.key, entry)
  const before = structuredClone([...g.checks]); await assert.rejects(stage(g.options), /目标已有同编号/u); assert.deepEqual([...g.checks], before)
})

test('private final CAS fences both sides of recall, privacy documents, locks and recall epochs', settings, async t => {
  const memoryBase = `shiloh:person-memory:v1:${account.id}:agent%3Adaily`
  for (const base of ['', 'target']) for (const suffix of [memoryBase + ':scope', memoryBase + ':person:' + author,
    memoryBase + ':lock', 'shiloh:person-memory:v1:identities:lock', recallKey('recall', '7717', peer),
    'agent:private-recall:' + addressKey(peer), KEY.meta(agentMemoryScope({ ...binding, target: peer })), KEY.meta(`private:${account.id}:agent%3Adaily:${author}`)]) {
    const f = await fixture(t, `private-race-${base || 'source'}-${suffix.includes('recall') ? 'recall' : 'privacy'}`, peer)
    await f.seed([privateOriginal()]); const result = await f.stage(), key = (base ? f.prefix : '') + suffix
    assert.equal(f.checks.has(key), true, `final CAS must compare ${key}`)
    const before = await f.destination(); await f.reader.set(key, 'concurrent-change')
    assert.equal(await f.commit(result), 0)
    assert.deepEqual(await f.destination(), base ? [...before, [key, 'concurrent-change']].sort((a, b) => a[0].localeCompare(b[0])) : before)
    assert.deepEqual(await f.saved(), [])
  }
})

test('private source file, directory and binding changes invalidate staged imports', settings, async t => {
  const f = await fixture(t, 'private-stale', peer); await f.seed([privateOriginal()])
  const changed = await f.stage(); await f.seed([privateOriginal('7717', '预览后的改动')]); assert.equal(changed.isCurrent(), false)
  const added = await f.stage(); await f.seed([privateOriginal('7718')], '2026-11-16'); assert.equal(added.isCurrent(), false)
  const removed = await f.stage(); await rm(path.join(f.groupDir, '2026-11-17.ndjson')); assert.equal(removed.isCurrent(), false)
  const rebound = await f.stage(); f.revoke(); assert.equal(rebound.isCurrent(), false); assert.deepEqual(await f.destination(), [])
})
