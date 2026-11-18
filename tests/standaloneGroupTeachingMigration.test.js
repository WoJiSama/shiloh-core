import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { decodeQqIncomingMessage } from '../dist/backend/adapters/qqMessage.js'
import { createAgentRuntime } from '../dist/backend/core/index.js'
import { readStandaloneAgentConfig } from '../dist/backend/bootstrap/standaloneAgentConfig.js'
import { runStandaloneQqMigration } from '../dist/backend/bootstrap/standaloneAgentMigration.js'
import { KEY } from '../dist/backend/modules/memory/infrastructure/engine/constants.js'
import { createGroupMemoryManagement } from '../dist/backend/modules/memory/infrastructure/groupMemoryManagement.js'
import { createGroupMemory } from '../dist/backend/modules/memory/infrastructure/groupMemory.js'
import { createGroupMemoryStore, groupMemoryId } from '../dist/backend/modules/memory/infrastructure/groupMemoryStore.js'
import { createPersonMemoryStore } from '../dist/backend/modules/memory/infrastructure/personMemoryStore.js'
import { personMemoryAddress } from '../dist/backend/modules/memory/infrastructure/personMemoryContext.js'
import { createArchiveManagerClass } from '../dist/backend/modules/messaging/infrastructure/messageArchive.js'
import { agentBindingToken, agentPersonaScopeId } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const redisTest = { skip: !redisAvailable, timeout: 20_000 }
const runNode = promisify(execFile)
const repo = fileURLToPath(new URL('../', import.meta.url))
const cliEntry = path.join(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo, 'scripts/start-agent.mjs')
const account = { platform: 'qq', namespace: 'global', id: '19000071' }
const target = { account, kind: 'group', id: '310701' }
const otherTarget = { ...target, id: '310702' }
const privateTarget = { ...target, kind: 'private', id: '330071' }
const creator = '330071', member = '330072', otherMember = '330073'
const connectionId = 'qq-main'
const teachingKeys = ['knowledge', 'workflows', 'alias', 'meta'].map(category => KEY[category](target.id))
const skipped = changes => ({ disabled: 0, source: 0, authorization: 0, unsupported: 0, privacy: 0, revoked: 0, ...changes })
const report = (imported = 0, retained = 0, alreadyImported = 0, reasons = {}) => ({ imported, retained, alreadyImported, skipped: skipped(reasons) })
const fileReference = (id, name) => `qq:file:${Buffer.from(JSON.stringify({ id, name })).toString('base64url')}`

function archive(id = 'source-definition', text = '记住绘图组是小吴。', changes = {}) {
  return { version: 1, message_type: 'group', group_id: target.id, user_id: creator,
    sender: { user_id: creator, nickname: '真实提交者', role: 'member' },
    source_bot_id: account.id, source_persona_id: 'agent:daily', message_id: id,
    timestamp: Math.floor(Date.now() / 1000) * 1000 - 60_000, raw_message: text, raw_truncated: false,
    message: [{ type: 'text', text }], ...changes }
}
function knowledge(source = archive(), changes = {}) {
  return { id: `legacy-${source.message_id}`, kind: 'member_definition', subject: '绘图组', subjectKey: '绘图组',
    targetUserIds: [member], targets: [{ userId: member, displayName: '小吴' }],
    sourceText: source.message.filter(part => part.type === 'text').map(part => part.text).join(''), sourceMessageId: source.message_id,
    proposalId: `proposal-${source.message_id}`, createdBy: source.user_id, at: source.timestamp, updatedAt: source.timestamp, enabled: true, ...changes }
}
function workflow(source = archive('source-workflow', '有人询问排练时请找小吴。'), changes = {}) {
  return { ...knowledge(source), kind: 'mention_members', condition: '有人询问排练', conditionKey: '有人询问排练', ...changes }
}
function alias(source = archive('source-alias', '记住小吴也叫画师。'), changes = {}) {
  return { qq: member, authority: 'teaching', confidence: 0.95, at: source.timestamp, by: [creator],
    createdBy: source.user_id, sourceMessageId: source.message_id, proposalId: `proposal-${source.message_id}`, display: '画师', ...changes }
}
function scopedRedis(reader, prefix) {
  return { get: key => reader.get(prefix + key), set: (key, value, options) => reader.set(prefix + key, value, options),
    del: key => reader.del(prefix + key),
    eval: (script, options) => reader.eval(script, { keys: options.keys.map(key => prefix + key), arguments: options.arguments }) }
}

async function fixture(t, name, options = {}) {
  const { reader, url } = await createAgentRedisFixture(t, `source-${name}`)
  const directory = await mkdtemp(path.join(tmpdir(), 'group-teaching-migration-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const instance = `teaching-${name}`, prefix = `bl-agent:${instance}:`, sourceBindings = path.join(directory, 'source-bindings.yaml')
  const configFile = path.join(directory, 'agent-host.yaml'), sourceDataDir = path.join(directory, 'data')
  const archiveDir = path.join(sourceDataDir, 'message_archive', 'group', target.id)
  await mkdir(archiveDir, { recursive: true })
  const bindings = { version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: connectionId, platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: [target, otherTarget, privateTarget].map(room => ({ connectionId, kind: room.kind, conversationId: room.id, agentId: 'daily' })) }
  await Promise.all([
    writeFile(sourceBindings, JSON.stringify(bindings)),
    writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify(bindings)),
    writeFile(configFile, JSON.stringify({ version: 1, instance, privateChat: { enabled: true },
      groupMemory: { enabled: options.enabled ?? true },
      model: { baseUrl: 'http://127.0.0.1:9', name: 'unused', apiKeyEnv: 'UNUSED_MIGRATION_KEY' },
      textGroups: [{ connectionId, conversationId: target.id }], connections: [{ id: connectionId, url: 'ws://127.0.0.1:9' }],
      simulation: { enabled: false },
    })),
  ])
  const config = readStandaloneAgentConfig(configFile, { BL_AGENT_REDIS_URL: url }, { requireCredentials: false })
  const binding = config.resolvePersona(target).binding, storage = scopedRedis(reader, prefix)
  const store = createGroupMemoryStore(storage), address = personMemoryAddress(target)
  const identity = { botId: address.botId, personaId: agentPersonaScopeId(binding.agentId) }
  const memory = createPersonMemoryStore({ redis: storage }), sourceMemory = createPersonMemoryStore({ redis: reader })
  const adapter = { id: connectionId, account, botUserId: account.id, botName: '迁移测试QQ', isReady: () => true,
    async start() {}, stop() {}, actions: { async send() { assert.fail('offline migration never sends to QQ') } },
    async readConversationMember(room, user) { return { target: room, observedAt: Date.now(), member: { user, displayName: '管理员', role: 'admin' } } } }
  const management = createGroupMemoryManagement({ redis: storage, memory, adapter: () => adapter, resolve: () => ({ binding }), isRecalled: async () => false })
  const readKeys = async keys => Object.fromEntries(await Promise.all(keys.sort().map(async key => [key, await reader.get(key)])))
  return { reader, url, directory, configFile, sourceDataDir, sourceBindings, config, prefix, binding, identity, scene: address.scene,
    store, storage, memory, sourceMemory, management,
    context: (id = 'management-request') => ({ binding, requestMessageId: id, actor: { kind: 'user', user: { ...account, id: creator } },
      signal: new AbortController().signal, isCurrent: () => true }),
    migrate: (apply, extra = {}) => runStandaloneQqMigration(config, { sourceBindings, sourceDataDir, connectionId, kind: 'group',
      conversationId: target.id, moveGroupTeaching: true, apply, ...extra }),
    async seed(documents = {}, rows = []) {
      const docs = { knowledge: [], workflows: [], alias: {}, meta: { disabled: false, optedOut: [] }, ...documents }
      await reader.mSet(Object.fromEntries(Object.entries(docs).map(([category, value]) => [KEY[category](target.id), JSON.stringify(value)])))
      await writeFile(path.join(archiveDir, '2026-11-15.ndjson'), rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    },
    load: () => store.load(groupMemoryId(target)),
    sourceSnapshot: () => readKeys([...teachingKeys]),
    destinationSnapshot: async () => readKeys(await reader.keys(prefix + '*')),
    initial: () => ({ version: 1, id: groupMemoryId(target), target, entries: [], deletedSources: [], agents: [{ agentId: binding.agentId,
      binding, token: agentBindingToken(binding), records: [], jobs: [], entries: [], seen: [], consensusDone: [], teachingDone: [], deletedSources: [], nextConsensusAt: 0 }] }),
  }
}

test('group teaching handover is opt-in, previews without writes, copies all supported teaching kinds and remains idempotent', redisTest, async t => {
  const f = await fixture(t, 'closed-loop')
  const definition = archive(), set = archive('source-set', '记住排练组是小吴和小许。'),
    file = archive('source-file', '记住小吴的排练表是排练表.pdf。', { message: [{ type: 'text', text: '记住小吴的排练表是排练表.pdf。' }, { type: 'file', name: '排练表.pdf', file: 'opaque-file-1' }] }),
    flow = archive('source-workflow', '有人询问排练时请找小吴。', { sender: { user_id: creator, nickname: '真实管理员', role: 'admin' } }),
    nickname = archive('source-alias', '记住小吴也叫画师。')
  await f.seed({ knowledge: [knowledge(definition), knowledge(set, { kind: 'member_set', subject: '排练组', targetUserIds: [member, otherMember] }),
    knowledge(file, { kind: 'group_file', subject: '排练表', targetUserIds: [], ownerQQ: member, resource: { fileName: '排练表.pdf', fileId: fileReference('opaque-file-1', '排练表.pdf') } })],
  workflows: [workflow(flow)], alias: { 画师: alias(nickname) } }, [definition, set, file, flow, nickname])
  const source = await f.sourceSnapshot(), before = await f.destinationSnapshot()
  assert.equal((await f.migrate(true, { moveGroupTeaching: false })).groupTeaching, undefined)
  assert.deepEqual(await f.destinationSnapshot(), before)
  const preview = await f.migrate(false)
  assert.deepEqual(preview.groupTeaching, report(5))
  assert.deepEqual(await f.destinationSnapshot(), before)
  assert.deepEqual(await f.sourceSnapshot(), source)
  assert.deepEqual((await f.migrate(true)).groupTeaching, preview.groupTeaching)
  const saved = await f.load()
  assert.equal(saved.entries.length, 5)
  assert.deepEqual(saved.entries.map(entry => entry.kind).sort(), ['alias', 'group_file', 'member_definition', 'member_set', 'workflow'])
  assert.deepEqual(saved.agents[0].entries, [])
  for (const entry of saved.entries) {
    const original = [definition, set, file, flow, nickname].find(row => row.message_id === entry.source.messageId)
    assert.ok(original)
    assert.equal(entry.source.authorId, creator)
    assert.equal(entry.source.at, original.timestamp)
    assert.equal(entry.createdBy, creator)
    assert.equal(entry.persona.kind, 'legacy-qq-observation')
    assert.equal(entry.persona.botId, f.identity.botId)
    assert.equal(entry.persona.personaId, 'agent:daily')
    assert.equal(Object.hasOwn(entry.persona, 'personaVersion'), false)
    assert.equal(Object.hasOwn(entry.persona, 'personaName'), false)
  }
  assert.deepEqual(saved.entries.find(entry => entry.kind === 'group_file').file, { name: '排练表.pdf', reference: fileReference('opaque-file-1', '排练表.pdf') })
  assert.deepEqual(await f.sourceSnapshot(), source)
  assert.deepEqual((await f.migrate(true)).groupTeaching, report(0, 0, 5))
  assert.deepEqual(await f.load(), saved)
  assert.deepEqual(await f.sourceSnapshot(), source)
  assert.equal(await f.store.load(groupMemoryId(otherTarget)), undefined)
})

test('the teaching flag rejects private conversations and disabled destination group memory before writing', redisTest, async t => {
  for (const enabled of [true, false]) {
    const f = await fixture(t, `flag-${enabled}`, { enabled })
    await f.seed({ knowledge: [knowledge()] }, [archive()])
    const before = await f.destinationSnapshot(), source = await f.sourceSnapshot()
    await assert.rejects(f.migrate(true, enabled ? { kind: 'private', conversationId: privateTarget.id } : {}), /群教学迁移只用于已启用 groupMemory 的群会话/u)
    assert.deepEqual(await f.destinationSnapshot(), before)
    assert.deepEqual(await f.sourceSnapshot(), source)
  }
})

test('missing, conflicting or untrusted archive provenance never turns a bare legacy group key into authority', redisTest, async t => {
  const f = await fixture(t, 'source-authority')
  const original = archive(), candidate = knowledge(original)
  const cases = [
    [],
    [archive(original.message_id, original.raw_message, { source_bot_id: '19000072' })],
    [archive(original.message_id, original.raw_message, { source_persona_id: 'agent:other' })],
    [archive(original.message_id, original.raw_message, { raw_truncated: true })],
    [archive(original.message_id, original.raw_message, { sender: { user_id: otherMember, role: 'owner' } })],
    [archive(original.message_id, original.raw_message, { source: { personaId: 'agent:daily' } })],
    [archive(original.message_id, original.raw_message, { message: [{ type: 'text', text: original.raw_message }, { type: 'forward', id: 'foreign-forward' }] })],
    [original, archive(original.message_id, '同一编号的另一段原话')],
  ]
  for (const rows of cases) {
    await f.seed({ knowledge: [candidate] }, rows)
    const before = await f.destinationSnapshot(), source = await f.sourceSnapshot()
    assert.deepEqual((await f.migrate(true)).groupTeaching, report(0, 1, 0, { source: 1 }))
    assert.deepEqual(await f.destinationSnapshot(), before)
    assert.deepEqual(await f.sourceSnapshot(), source)
  }
  await f.seed({ knowledge: [knowledge(original, { sourceText: '原文中并不存在的教学说明' })] }, [original])
  assert.deepEqual((await f.migrate(true)).groupTeaching, report(0, 1, 0, { source: 1 }))
  assert.equal(await f.load(), undefined)
})

test('workflow migration requires the submitting author to have an administrator or owner role in the original archive', redisTest, async t => {
  const f = await fixture(t, 'workflow-role')
  const rows = ['member', 'unknown', 'admin', 'owner'].map((role, index) => archive(`flow-${index}`, `原始排练规则${index}。`,
    { sender: { user_id: creator, nickname: '提交者', role } }))
  await f.seed({ workflows: rows.map((row, index) => workflow(row, { condition: `排练条件${index}` })) }, rows)
  const source = await f.sourceSnapshot()
  assert.deepEqual((await f.migrate(false)).groupTeaching, report(2, 2, 0, { authorization: 2 }))
  assert.equal(await f.load(), undefined)
  assert.deepEqual((await f.migrate(true)).groupTeaching, report(2, 2, 0, { authorization: 2 }))
  assert.deepEqual((await f.load()).entries.map(entry => entry.source.messageId).sort(), ['flow-2', 'flow-3'])
  assert.deepEqual(await f.sourceSnapshot(), source)
})

test('disabled source records and unsupported teaching remain on the old side with explicit report reasons', redisTest, async t => {
  const f = await fixture(t, 'unsupported')
  const rows = [archive(), archive('disabled-record', '这项已停用的教学。'), archive('unsupported-record', '不支持的旧教学类型。'),
    archive('unsupported-workflow', '不支持的自动动作。')]
  const docs = { knowledge: [knowledge(rows[0]), knowledge(rows[1], { enabled: false, subject: '已停用' }),
    knowledge(rows[2], { kind: 'arbitrary_instruction', subject: '不支持' })],
  workflows: [workflow(rows[3], { kind: 'run_shell' })] }
  await f.seed({ ...docs, meta: { disabled: true, optedOut: [] } }, rows)
  const before = await f.destinationSnapshot()
  assert.deepEqual((await f.migrate(true)).groupTeaching, report(0, 4, 0, { disabled: 4 }))
  assert.deepEqual(await f.destinationSnapshot(), before)
  await f.seed(docs, rows)
  assert.deepEqual((await f.migrate(true)).groupTeaching, report(1, 3, 0, { disabled: 1, unsupported: 2 }))
  assert.equal((await f.load()).entries.length, 1)
})

test('legacy opt-out is transferred once as scene privacy, preview is read-only, and a later user opt-in remains authoritative', redisTest, async t => {
  const f = await fixture(t, 'optout')
  const source = archive()
  await f.seed({ knowledge: [knowledge(source)], meta: { disabled: false, optedOut: [member] } }, [source])
  const old = await f.sourceSnapshot(), before = await f.destinationSnapshot()
  assert.deepEqual((await f.migrate(false)).groupTeaching, report(0, 1, 0, { privacy: 1 }))
  assert.deepEqual(await f.destinationSnapshot(), before)
  assert.deepEqual((await f.migrate(true)).groupTeaching, report(0, 1, 0, { privacy: 1 }))
  const privacy = await f.memory.getRedactions({ identity: f.identity, subjectId: member })
  assert.ok(privacy.scenes.some(rule => rule.disabled && rule.scene.kind === 'group' && rule.scene.id === target.id))
  assert.equal(privacy.disabled, false)
  assert.deepEqual(await f.sourceSnapshot(), old)
  await f.memory.setEnabled({ identity: f.identity, subjectId: member, scene: f.scene, enabled: true })
  // Enabling again does not revive the old source; only later teaching is eligible.
  assert.deepEqual((await f.migrate(true)).groupTeaching, report(0, 1, 0, { privacy: 1 }))
  assert.equal((await f.memory.getRedactions({ identity: f.identity, subjectId: member })).scenes.some(rule => rule.disabled), false)
  const fresh = archive('new-source-after-optin', '记住绘图组是小吴。', { timestamp: Math.ceil(Date.now() / 1000) * 1000 + 1000 })
  await f.seed({ knowledge: [knowledge(fresh)], meta: { disabled: false, optedOut: [member] } }, [source, fresh])
  assert.deepEqual((await f.migrate(true)).groupTeaching, report(1))
  assert.equal((await f.load()).entries.length, 1)
  assert.equal((await f.memory.getRedactions({ identity: f.identity, subjectId: member })).scenes.some(rule => rule.disabled), false)
})

test('source and destination person privacy and source revocations block imported teaching', redisTest, async t => {
  for (const side of ['source', 'destination']) {
    for (const restriction of ['disabled', 'source-revoked']) {
      const f = await fixture(t, `privacy-${side}-${restriction}`), original = archive()
      await f.seed({ knowledge: [knowledge(original)] }, [original])
      const memory = side === 'source' ? f.sourceMemory : f.memory
      if (restriction === 'disabled') await memory.setEnabled({ identity: f.identity, subjectId: member, scene: f.scene, enabled: false })
      else await memory.revokeSource({ identity: f.identity, scene: f.scene, messageId: original.message_id })
      const source = await f.sourceSnapshot()
      assert.deepEqual((await f.migrate(true)).groupTeaching, report(0, 1, 0, { privacy: 1 }))
      assert.equal(await f.load(), undefined)
      assert.deepEqual(await f.sourceSnapshot(), source)
    }
  }
})

test('archive recalls, teaching tombstones and clear cutoffs prevent importing revoked sources', redisTest, async t => {
  for (const reason of ['recall', 'tombstone', 'cutoff']) {
    const f = await fixture(t, `revoked-${reason}`), source = archive()
    const rows = [source, ...(reason === 'recall' ? [{ version: 1, message_type: 'group', group_id: target.id,
      archive_kind: 'notice', notice_type: 'group_recall', message_id: source.message_id }] : [])]
    await f.seed({ knowledge: [knowledge(source)] }, rows)
    if (reason !== 'recall') await f.store.update(groupMemoryId(target), () => ({ ...f.initial(),
      ...(reason === 'tombstone' ? { teachingDeletedSources: [source.message_id] } : { teachingClearedAt: Date.now() }) }))
    const before = await f.destinationSnapshot(), old = await f.sourceSnapshot()
    assert.deepEqual((await f.migrate(true)).groupTeaching, report(0, 1, 0, { revoked: 1 }))
    assert.deepEqual(await f.destinationSnapshot(), before)
    assert.deepEqual(await f.sourceSnapshot(), old)
  }
})

test('persisted migration receipts survive ordinary delete and clear so preserved legacy records never resurrect', redisTest, async t => {
  for (const action of ['delete', 'clear']) {
    const f = await fixture(t, `no-resurrection-${action}`), source = archive()
    await f.seed({ knowledge: [knowledge(source)] }, [source])
    assert.deepEqual((await f.migrate(true)).groupTeaching, report(1))
    const entry = (await f.load()).entries[0]
    if (action === 'delete') assert.deepEqual(await f.management.delete({ id: entry.id }, f.context()), { status: 'deleted', deleted: 1 })
    else {
      const confirmation = await f.management.clear({}, f.context('clear-request'))
      assert.equal(confirmation.status, 'confirmation_required')
      assert.deepEqual(await f.management.clear({ confirmationId: confirmation.confirmationId }, f.context('clear-confirmation')), { status: 'cleared', deleted: 1 })
    }
    const before = await f.destinationSnapshot(), old = await f.sourceSnapshot()
    assert.deepEqual((await f.migrate(true)).groupTeaching, report(0, 0, 1))
    assert.deepEqual((await f.load()).entries, [])
    assert.deepEqual(await f.destinationSnapshot(), before)
    assert.deepEqual(await f.sourceSnapshot(), old)
  }
})

test('a conflicting destination teaching ID aborts the complete batch without copying earlier records or privacy metadata', redisTest, async t => {
  const f = await fixture(t, 'id-conflict'), original = archive()
  await f.seed({ knowledge: [knowledge(original)] }, [original])
  assert.deepEqual((await f.migrate(true)).groupTeaching, report(1))
  const fresh = archive('fresh-before-conflict', '记住排练组是小许。'), conflicting = archive('new-source-same-subject', '现在绘图组是小许。')
  await f.seed({ knowledge: [knowledge(fresh, { subject: '排练组', targetUserIds: [otherMember] }),
    knowledge(conflicting, { targetUserIds: [otherMember] })] }, [original, fresh, conflicting])
  const before = await f.destinationSnapshot(), old = await f.sourceSnapshot()
  await assert.rejects(f.migrate(true), /目标已有相同群教学编号，迁移未覆盖/u)
  assert.deepEqual(await f.destinationSnapshot(), before)
  assert.deepEqual(await f.sourceSnapshot(), old)
  assert.equal((await f.load()).entries.length, 1)
})

test('Core reads and lists migrated teaching as legacy evidence with fresh user membership even without an extraction model', redisTest, async t => {
  const f = await fixture(t, 'core-consumer'), original = archive()
  await f.seed({ knowledge: [knowledge(original)] }, [original])
  assert.deepEqual((await f.migrate(true)).groupTeaching, report(1))
  const requests = [], deliveries = [], memberReads = [], warnings = []
  let accept, ready = false
  const host = createAgentRuntime({ storage: f.storage, isExecutionCurrent: () => true,
    groupMemory: { enabled: true }, midtermMemory: { enabled: false }, episodicMemory: { enabled: false },
    useTextGroup: room => room.kind === 'group', groupTextTools: () => ['groupKnowledgeTool'],
    resolvePersona: f.config.resolvePersona, getExecutionConfig: () => ({}),
    getSection: () => ({ enabled: true, allGroups: true, reflection: { enabled: false }, rhythm: { enabled: false },
      personProfile: { enabled: false }, wake: { probability: 0, proactiveProbability: 0 }, turn: { minSendGapMs: 0 } }),
    logger: { info() {}, warn: value => warnings.push(value), error() {} },
    adapters: [{ id: connectionId, account, botUserId: account.id, botName: '新宿主当前人格',
      async start(receive) { accept = receive; ready = true }, stop() { ready = false }, isReady: () => ready,
      async readConversationMember(room, user, options) {
        assert.equal(options.signal.aborted, false)
        assert.equal(options.isCurrent(), true)
        memberReads.push({ room, user })
        return { target: room, observedAt: Date.now(), member: { user, displayName: '当前真人', role: 'member' } }
      },
      actions: { async send(action, guard) {
        assert.equal(guard.isCurrent(), true)
        assert.ok(action.parts.every(part => part.kind === 'text'), 'viewing legacy teaching does not authorize mentions or workflow notification')
        deliveries.push(action)
        return { state: 'sent', messageId: `core-reply-${deliveries.length}` }
      } },
    }],
    async YTapi(request) {
      requests.push(request)
      if (request.messages.at(-1).content === '请列出本群资料') return { choices: [{ message: { tool_calls: [{ id: 'list-imported', type: 'function',
        function: { name: 'groupKnowledgeTool', arguments: JSON.stringify({ action: 'list' }) } }] } }] }
      return { choices: [{ message: { content: '收到这次查看请求。' } }] }
    },
  })
  const send = async (id, text) => {
    const count = deliveries.length
    await accept({ kind: 'message', message: { version: 1, conversation: target, sender: { ...account, id: creator }, senderName: '当前真人',
      messageId: id, occurredAt: Date.now(), text, parts: [{ kind: 'text', text }], mentions: [], directedToAccount: true } })
    for (let attempt = 0; attempt < 300 && deliveries.length === count; attempt++) await delay(15)
    assert.equal(deliveries.length, count + 1, `the actual Core turn must finish: ${warnings.join('; ')}`)
    return deliveries.at(-1)
  }
  try {
    await host.start()
    await send('read-imported', '查看绘图组的历史定义')
    const evidence = requests[0].messages.find(message => message.role === 'user' && String(message.content).includes('【本群已保存资料】'))
    assert.ok(evidence)
    assert.match(evidence.content, /绘图组/u)
    assert.match(evidence.content, /旧群教学.*提交人格版本未记录/u)
    assert.equal(requests[0].messages.some(message => message.role === 'system' && String(message.content).includes('绘图组')), false)
    const listed = await send('list-imported', '请列出本群资料')
    assert.match(listed.parts[0].text, /绘图组/u)
    assert.match(listed.parts[0].text, /旧群教学，提交人格版本未记录/u)
    assert.ok(memberReads.length >= 2)
    assert.ok(memberReads.every(read => read.user.id === creator && read.room.id === target.id))
    assert.equal(requests.length, 2)
  } finally { await host.stop() }
})

test('a valid archive copy cannot hide a same-ID observation with conflicting account, Agent, author or truncation evidence', redisTest, async t => {
  for (const [name, changes] of [
    ['account', { source_bot_id: '19000072' }],
    ['agent', { source_persona_id: 'agent:other' }],
    ['sender-author', { sender: { user_id: otherMember, nickname: '矛盾作者', role: 'admin' } }],
    ['both-authors', { user_id: otherMember, sender: { user_id: otherMember, nickname: '另一作者', role: 'admin' } }],
    ['truncation', { raw_truncated: true }],
  ]) {
    const f = await fixture(t, `duplicate-${name}`), original = archive()
    await f.seed({ knowledge: [knowledge(original)] }, [original, { ...structuredClone(original), ...changes }])
    const before = await f.destinationSnapshot(), old = await f.sourceSnapshot()
    assert.deepEqual((await f.migrate(true)).groupTeaching, report(0, 1, 0, { source: 1 }))
    assert.deepEqual(await f.destinationSnapshot(), before)
    assert.deepEqual(await f.sourceSnapshot(), old)
  }
})

test('migrated text spacing and file references match native QQ capture so replaying the same source remains valid', redisTest, async t => {
  const f = await fixture(t, 'native-source-replay')
  const text = '  记住小吴的排练表是排练表.pdf。  '
  const original = archive('native-file-source', text, { timestamp: Math.floor(Date.now() / 1000) * 1000 - 60_000,
    message: [{ type: 'text', text }, { type: 'at', qq: member }, { type: 'file', name: '排练表.pdf', file: 'opaque-native-file' }] })
  await f.seed({ knowledge: [knowledge(original, { kind: 'group_file', subject: '排练表', targetUserIds: [], ownerQQ: member,
    resource: { fileName: '排练表.pdf' } })] }, [original])
  assert.deepEqual((await f.migrate(true)).groupTeaching, report(1))
  const incoming = decodeQqIncomingMessage({ ...original, self_id: original.source_bot_id, time: original.timestamp / 1000 }, { binding: f.binding })
  assert.ok(incoming)
  assert.equal(incoming.text, text)
  let modelCalls = 0
  const groupMemory = createGroupMemory({ redis: f.storage, memory: f.memory, config: () => ({ enabled: true }),
    model: async () => { modelCalls++; return [] },
    resolve: () => ({ binding: f.binding, viewer: { ...f.identity, personaVersion: 'current-v1', personaName: '当前人格' } }),
    botUserId: () => account.id, available: () => true, members: async () => undefined, member: async () => undefined,
    isRecalled: async () => false, begin: async () => ({ signal: new AbortController().signal, isCurrent: () => true, release() {} }),
    isRunning: () => true, allowsText: () => true, logger: { warn() {} },
  })
  try {
    await assert.doesNotReject(groupMemory.capture(incoming, f.binding, () => true))
    const state = await f.load(), native = state.agents.find(owner => owner.agentId === 'daily').records.find(row => row.messageId === original.message_id)
    assert.ok(native)
    assert.deepEqual(state.entries[0].source, native)
    assert.equal(native.text, text)
    assert.deepEqual(native.files, [{ name: '排练表.pdf', reference: fileReference('opaque-native-file', '排练表.pdf') }])
    assert.deepEqual(state.entries[0].file, native.files[0])
    assert.equal(modelCalls, 0)
  } finally { await groupMemory.stop() }
})

test('workflow migration retains a 21-person notification instead of creating an unusable fan-out rule', redisTest, async t => {
  const f = await fixture(t, 'workflow-target-limit'), original = archive('too-many-targets', '排练时通知这些成员。',
    { sender: { user_id: creator, nickname: '管理员', role: 'admin' } })
  const targetUserIds = Array.from({ length: 21 }, (_, index) => String(340000 + index))
  await f.seed({ workflows: [workflow(original, { targetUserIds })] }, [original])
  const before = await f.destinationSnapshot(), old = await f.sourceSnapshot()
  assert.deepEqual((await f.migrate(true)).groupTeaching, report(0, 1, 0, { unsupported: 1 }))
  assert.deepEqual(await f.destinationSnapshot(), before)
  assert.deepEqual(await f.sourceSnapshot(), old)
})

test('a malformed recall notice aborts the entire handover without copying otherwise eligible teaching', redisTest, async t => {
  for (const [name, messageId] of [['missing', undefined], ['empty', ''], ['zero', '0'], ['object', { bad: 'id' }], ['control', 'bad\nmessage']]) {
    const f = await fixture(t, `bad-recall-${name}`), original = archive()
    await f.seed({ knowledge: [knowledge(original)] }, [original, { version: 1, message_type: 'group', group_id: target.id,
      archive_kind: 'notice', notice_type: 'group_recall', ...(messageId === undefined ? {} : { message_id: messageId }) }])
    const before = await f.destinationSnapshot(), old = await f.sourceSnapshot()
    await assert.rejects(f.migrate(true), /归档|撤回/u)
    assert.deepEqual(await f.destinationSnapshot(), before)
    assert.deepEqual(await f.sourceSnapshot(), old)
  }
})

test('CLI include-group-teaching previews, applies and repeats without credentials or removing source keys', redisTest, async t => {
  const f = await fixture(t, 'cli'), original = archive()
  await f.seed({ knowledge: [knowledge(original)] }, [original])
  const environment = { ...process.env, BL_AGENT_REDIS_URL: f.url }
  delete environment.UNUSED_MIGRATION_KEY
  const run = async apply => {
    const result = await runNode(process.execPath, [cliEntry, '--config', f.configFile, '--migrate-qq-state',
      '--source-bindings', f.sourceBindings, '--source-data-dir', f.sourceDataDir, '--connection', connectionId,
      '--group', target.id, '--include-group-teaching', ...(apply ? ['--apply'] : [])],
    { cwd: f.directory, env: environment, timeout: 12_000 })
    return JSON.parse(result.stdout.trim().split('\n').at(-1))
  }
  const old = await f.sourceSnapshot(), before = await f.destinationSnapshot(), preview = await run(false)
  assert.equal(preview.mode, 'preview')
  assert.deepEqual(preview.groupTeaching, report(1))
  assert.deepEqual(await f.destinationSnapshot(), before)
  const applied = await run(true)
  assert.equal(applied.mode, 'applied')
  assert.deepEqual(applied.groupTeaching, preview.groupTeaching)
  assert.deepEqual(await f.sourceSnapshot(), old)
  const saved = await f.load(), repeated = await run(true)
  assert.equal(repeated.mode, 'applied')
  assert.deepEqual(repeated.groupTeaching, report(0, 0, 1))
  assert.deepEqual(await f.load(), saved)
  assert.deepEqual(await f.sourceSnapshot(), old)
})

test('file teaching requires a named native file reference and leaves incomplete archive-writer output on the source', redisTest, async t => {
  const f = await fixture(t, 'file-evidence')
  const text = '记住小吴的排练表是排练表.pdf。', fidOnly = archive('file-fid-only', text,
    { message: [{ type: 'text', text }, { type: 'file', name: '排练表.pdf', fid: 'legacy-fid-only' }] })
  await f.seed({ knowledge: [knowledge(fidOnly, { kind: 'group_file', subject: '排练表', targetUserIds: [],
    resource: { fileName: '排练表.pdf', fileId: 'legacy-fid-only' } })] }, [fidOnly])
  assert.deepEqual((await f.migrate(true)).groupTeaching, report(0, 1, 0, { source: 1 }))
  const Archive = createArchiveManagerClass({ safeTruncateUnicode: (value, max) => value.slice(0, max), getMentionTargetId: () => '', queue: {} })
  const writer = new Archive({ cwd: f.directory })
  const written = writer.buildRecord({ message_type: 'group', group_id: target.id, user_id: creator, self_id: account.id,
    sender: { user_id: creator, nickname: '真实提交者', role: 'member' }, message_id: 'writer-file-source',
    time: Math.floor(Date.now() / 1000) - 60, raw_message: text,
    _personaSnapshot: { botId: account.id, personaId: 'agent:daily' },
    message: [{ type: 'text', text }, { type: 'file', name: '排练表.pdf', file: 'writer-native-file' }] })
  assert.equal(written.message.find(part => part.type === 'file').name, undefined)
  await f.seed({ knowledge: [knowledge(written, { kind: 'group_file', subject: '排练表', targetUserIds: [], createdBy: creator,
    resource: { fileName: '排练表.pdf', fileId: 'writer-native-file' } })] }, [written])
  const before = await f.destinationSnapshot(), old = await f.sourceSnapshot()
  assert.deepEqual((await f.migrate(true)).groupTeaching, report(0, 1, 0, { source: 1 }))
  assert.deepEqual(await f.destinationSnapshot(), before)
  assert.deepEqual(await f.sourceSnapshot(), old)
})

test('bot-authored and persona-attributed output cannot be imported as human teaching', redisTest, async t => {
  for (const [name, changes] of [
    ['bot-author', { user_id: account.id, sender: { user_id: account.id, nickname: '机器人', role: 'owner' } }],
    ['persona-output', { personaSource: { botId: account.id, personaId: 'agent:daily', personaVersion: 'old-version', personaName: '旧角色' } }],
  ]) {
    const f = await fixture(t, `not-human-${name}`), original = archive('not-human-source', '记住绘图组是小吴。', changes)
    await f.seed({ knowledge: [knowledge(original)] }, [original])
    const before = await f.destinationSnapshot(), old = await f.sourceSnapshot()
    assert.deepEqual((await f.migrate(true)).groupTeaching, report(0, 1, 0, { source: 1 }))
    assert.deepEqual(await f.destinationSnapshot(), before)
    assert.deepEqual(await f.sourceSnapshot(), old)
  }
})

test('extra archive msg and native mention shortcuts cannot replace the verified text or add source participants', redisTest, async t => {
  const f = await fixture(t, 'archive-extra-fields')
  const original = archive('allowlisted-source', '记住绘图组是小吴。', { msg: '未经核验的替代正文', at: otherMember, at_user: [otherMember],
    message: [{ type: 'text', text: '记住绘图组是小吴。' }, { type: 'at', qq: member }] })
  await f.seed({ knowledge: [knowledge(original)] }, [original])
  assert.deepEqual((await f.migrate(true)).groupTeaching, report(1))
  const entry = (await f.load()).entries[0]
  assert.equal(entry.source.text, '记住绘图组是小吴。')
  assert.deepEqual(entry.source.mentions, [member])
  assert.equal(JSON.stringify(entry).includes('未经核验的替代正文'), false)
  assert.equal(JSON.stringify(entry.source).includes(otherMember), false)
})
