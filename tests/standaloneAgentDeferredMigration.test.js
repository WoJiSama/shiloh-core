import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createClient } from '@redis/client'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const [{ runStandaloneQqMigration }, { readStandaloneAgentConfig }, { freezeDeferredAction, deferredActionHash },
  { agentBindingIdentity, agentConversationKey }, { decodeCommitment, encodeCommitment, createCommitmentStore }] = await Promise.all([
  load('bootstrap/standaloneAgentMigration.js'), load('bootstrap/standaloneAgentConfig.js'),
  load('modules/commitments/infrastructure/agentDeferredActionData.js'), load('modules/runtime/domain/agentBindings.js'),
  load('modules/commitments/infrastructure/commitmentStore.js'),
])
const available = spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status === 0
const redisTest = { skip: !available, timeout: 20_000 }
const account = { platform: 'qq', namespace: 'global', id: '23000091' }, connectionId = 'qq-main', creator = '330091'
const target = { account, kind: 'group', id: '310901' }, peer = { account, kind: 'private', id: creator }
const sourceIndex = 'bl-chat:reminder:pending:list', commitmentIndex = 'bl-chat:commitment:pending:list'
const detail = id => `bl-chat:reminder:detail:${id}`, commitment = id => `bl-chat:commitment:detail:${id}`
const hash = raw => createHash('sha256').update(raw).digest('hex')
const defaultMapping = { from: 'pokeTool', to: 'simSendPoke', definitionId: 'poke-fixture-v1', executor: 'builtin' }

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dfm-')), socket = path.join(directory, 's')
  const child = spawn('redis-server', ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  const exited = once(child, 'exit').catch(() => {})
  let reader
  t.after(async () => {
    try { if (reader?.isOpen) await reader.close() }
    finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; await rm(directory, { recursive: true, force: true }) }
  })
  for (let tries = 0; tries < 100; tries++) {
    if (await stat(socket).then(() => true, () => false)) { reader = createClient({ socket: { path: socket, reconnectStrategy: false } }); reader.on('error', () => {}); await reader.connect(); break }
    if (child.exitCode !== null) break
    await delay(20)
  }
  assert.ok(reader?.isOpen)
  const sourceBindings = path.join(directory, 'source-bindings.yaml'), configFile = path.join(directory, 'host.yaml'), sourceConfig = path.join(directory, 'message.yaml'), sourceDataDir = path.join(directory, 'data')
  const bindings = { version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: connectionId, platform: 'qq', namespace: 'global', accountId: account.id }],
    bindings: [target, peer].map(room => ({ connectionId, kind: room.kind, conversationId: room.id, agentId: 'daily' })) }
  const document = { version: 1, instance: 'deferred-migration', privateChat: { enabled: true }, groupMemory: { enabled: false },
    model: { baseUrl: 'http://127.0.0.1:9', name: 'unused', apiKeyEnv: 'UNUSED_DEFERRED_MIGRATION_KEY' },
    connections: [{ id: connectionId, url: 'ws://127.0.0.1:9' }], simulation: { enabled: options.enabled !== false, allGroups: true },
    ...(options.text ? { textGroups: [{ connectionId, conversationId: target.id }] } : {}) }
  await mkdir(sourceDataDir)
  await Promise.all([writeFile(sourceBindings, JSON.stringify(bindings)), writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify(bindings)),
    writeFile(configFile, JSON.stringify(document)), writeFile(sourceConfig, JSON.stringify({ pluginSettings: { simulation: { enabled: true, allGroups: true } } }))])
  const config = readStandaloneAgentConfig(configFile, { BL_AGENT_REDIS_URL: `unix://${socket}` }, { requireCredentials: false })
  const selectedTarget = options.private ? peer : target, binding = config.resolvePersona(selectedTarget).binding
  const prefix = 'bl-agent:deferred-migration:', at = Date.now()
  const migration = { sourceBindings, sourceConfig, sourceDataDir, connectionId, kind: selectedTarget.kind, conversationId: selectedTarget.id }
  const snapshot = async () => {
    const keys = (await reader.keys('*')).sort()
    return Object.fromEntries(await Promise.all(keys.map(async key => [key, await reader.get(key)])))
  }
  return { reader, socket, directory, configFile, sourceBindings, config, binding, selectedTarget, prefix, at, migration, snapshot,
    migrate: (apply, selections, extra = {}) => runStandaloneQqMigration(config, { ...migration, apply, ...(selections === undefined ? {} : { deferredReminders: selections }), ...extra }),
    async seed(rows, indexed = rows.filter(row => ['pending', 'sending', 'unknown'].includes(row.old.status)).map(row => ({ id: row.old.id, trigger_time: row.old.trigger_time }))) {
      await reader.set(sourceIndex, JSON.stringify(indexed))
      for (const row of rows) await reader.set(detail(row.old.id), row.raw)
    },
  }
}
function reminder(f, id, changes = {}, mapping = defaultMapping) {
  const old = { id, bot_id: account.id, bindingIdentity: agentBindingIdentity(f.binding), group_id: f.selectedTarget.kind === 'group' ? target.id : null,
    user_id: creator, message_id: 'original-human-message', content: `原提醒 ${id}`, reminder_message: `到期 ${id}`, trigger_time: f.at + 3600_000,
    created_at: f.at - 60_000, updated_at: f.at - 30_000, status: 'pending', retry_count: 1, extra_action: { tool: mapping.from, params: {} }, ...changes }
  const raw = JSON.stringify(old), params = { ...old.extra_action?.params }
  if (old.extra_action?.tool === 'pokeTool' && !params.target) params.target = [old.user_id]
  const action = freezeDeferredAction({ tool: mapping.to, executor: mapping.executor, definitionId: mapping.definitionId, params })
  const grant = { version: 1, id: `grant:${id}`, ruleId: 'explicit-migration-rule', ruleRevision: 'v1', bindingIdentity: agentBindingIdentity(f.binding), scopeKey: agentConversationKey(f.binding),
    creator: { ...account, id: old.user_id }, actionHash: deferredActionHash(action), dueAt: old.trigger_time,
    source: { kind: 'migration', id, sourceHash: hash(raw), authorizedBy: 'offline-operator', at: f.at }, issuedAt: f.at, expiresAt: f.at + 7 * 86_400_000 }
  return { old, raw, action, grant, selection: { id, mapping, grant } }
}
const counts = (moved = 0, active = 0, frozen = 0, terminal = 0, retained = 0, reasons = {}) => ({ moved, active, frozen, terminal, retained, reasons })
const readTask = async (f, id) => decodeCommitment(await f.reader.get(f.prefix + commitment(id)))
const destinationStore = f => createCommitmentStore({ logger: { warn() {} }, redis: {
  get: key => f.reader.get(f.prefix + key), set: (key, value, options) => f.reader.set(f.prefix + key, value, options), del: key => f.reader.del(f.prefix + key),
  eval: (script, options) => f.reader.eval(script, { keys: options.keys.map(key => f.prefix + key), arguments: options.arguments }),
} })

test('offline selections preview authorized extra actions and atomically merge ordinary reminders without changing attribution', redisTest, async t => {
  const f = await fixture(t), deferred = reminder(f, 'extra-1'), plain = reminder(f, 'plain-1', { extra_action: null }), retained = reminder(f, 'unselected')
  await f.seed([deferred, plain, retained], [deferred, plain, retained].map(row => ({ id: row.old.id, trigger_time: row.old.trigger_time, originalIndexNote: row.old.id })))
  const original = await f.snapshot()
  const noFlag = await f.migrate(false)
  assert.equal(noFlag.deferredReminders, undefined); assert.equal(noFlag.reminders, 1); assert.deepEqual(await f.snapshot(), original)
  const preview = await f.migrate(false, [deferred.selection])
  assert.deepEqual(preview.deferredReminders, counts(1, 1)); assert.equal(preview.reminders, 1); assert.deepEqual(await f.snapshot(), original)
  const applied = await f.migrate(true, [deferred.selection]); assert.deepEqual(applied.deferredReminders, preview.deferredReminders)
  const task = await readTask(f, deferred.old.id)
  assert.deepEqual([task.id, task.creator_id, task.created_at, task.schedule.time, task.retry_count, task.status],
    [deferred.old.id, creator, deferred.old.created_at, deferred.old.trigger_time, 1, 'active'])
  assert.deepEqual(task.deferredAction.action, deferred.action); assert.deepEqual(task.deferredAction.grant, deferred.grant)
  assert.equal(task.deferredAction.legacy.originalMessageId, deferred.old.message_id); assert.equal(task.deferredAction.legacy.rawSha256, hash(deferred.raw))
  assert.equal(task.deferredAction.legacy.detailKey, detail(deferred.old.id)); assert.deepEqual(task.deferredAction.legacy.explicitToolMapping, defaultMapping)
  assert.equal(task.deferredAction.state, 'pending'); assert.equal(task.deferredAction.attemptedAt, 0)
  assert.equal(JSON.stringify(task).includes('isMaster'), false); assert.equal(JSON.stringify(task).includes('actor'), false)
  assert.deepEqual(JSON.parse(await f.reader.get(sourceIndex)), [{ id: retained.old.id, trigger_time: retained.old.trigger_time, originalIndexNote: retained.old.id }])
  assert.equal(await f.reader.get(detail(deferred.old.id)), null); assert.equal(await f.reader.get(detail(plain.old.id)), null); assert.equal(await f.reader.get(detail(retained.old.id)), retained.raw)
  assert.deepEqual(JSON.parse(await f.reader.get(f.prefix + commitmentIndex)).map(row => row.id).sort(), ['extra-1', 'plain-1'])
  const transferred = await f.snapshot(), repeated = await f.migrate(true, [deferred.selection])
  assert.deepEqual(repeated.deferredReminders, counts(0, 0, 0, 0, 1, { invalid: 1 })); assert.deepEqual(await f.snapshot(), transferred)
})

test('missing or stale explicit migration authorization and unsupported mapping stay at source without ordinary fallback', redisTest, async t => {
  const f = await fixture(t), rows = ['no-grant', 'no-map', 'wrong-creator', 'wrong-hash', 'wrong-source', 'expired', 'unsupported-map'].map(id => reminder(f, id))
  await f.seed(rows)
  const selections = rows.map(row => structuredClone(row.selection))
  delete selections[0].grant; delete selections[1].mapping; selections[2].grant.creator.id = '330092'; selections[3].grant.actionHash = 'a'.repeat(64)
  selections[4].grant.source.sourceHash = 'b'.repeat(64); selections[5].grant.expiresAt = f.at - 1; selections[6].mapping.from = 'unmapped-tool'
  const before = await f.snapshot(), result = await f.migrate(true, selections)
  assert.deepEqual(result.deferredReminders, counts(0, 0, 0, 0, 7, { authorization: 5, unsupported: 2 })); assert.equal(result.reminders, 0)
  assert.deepEqual(await f.snapshot(), before)
})

test('ordinary commitments and extra actions share one destination index while retaining unrelated destination metadata', redisTest, async t => {
  const f = await fixture(t), row = reminder(f, 'extra-1'); await f.seed([row])
  const task = { id: 'source-commitment', group_id: target.id, bot_id: account.id, scope: f.binding, bindingIdentity: agentBindingIdentity(f.binding),
    creator_id: creator, creator_name: '原创建者', intent: '普通承诺', schedule: { kind: 'once', time: row.old.trigger_time }, deliver: 'static', static_message: '普通承诺正文',
    expiry_at: 0, next_run_at: row.old.trigger_time, status: 'active', last_run_at: 0, last_result: '', retry_count: 0, created_at: f.at - 60_000, revision: 1 }
  const sourceRaw = encodeCommitment(task), existingRaw = encodeCommitment({ ...task, id: 'destination-existing' })
  const existingIndex = { id: 'destination-existing', next_run_at: row.old.trigger_time + 1000, metadata: { note: '保留目标索引附加字段' } }
  await f.reader.set(commitment(task.id), sourceRaw); await f.reader.set(commitmentIndex, JSON.stringify([{ id: task.id, next_run_at: task.next_run_at }]))
  await f.reader.set(f.prefix + commitment(existingIndex.id), existingRaw); await f.reader.set(f.prefix + commitmentIndex, JSON.stringify([existingIndex]))
  const before = await f.snapshot(), preview = await f.migrate(false, [row.selection])
  assert.equal(preview.commitments, 1); assert.deepEqual(preview.deferredReminders, counts(1, 1)); assert.deepEqual(await f.snapshot(), before)
  const result = await f.migrate(true, [row.selection]); assert.equal(result.commitments, 1); assert.deepEqual(result.deferredReminders, counts(1, 1))
  const pending = JSON.parse(await f.reader.get(f.prefix + commitmentIndex))
  assert.deepEqual(pending.find(item => item.id === existingIndex.id), existingIndex)
  assert.deepEqual(pending.map(item => item.id).sort(), ['destination-existing', 'extra-1', 'source-commitment'])
  assert.equal(await f.reader.get(f.prefix + commitment(task.id)), sourceRaw); assert.equal(await f.reader.get(f.prefix + commitment(existingIndex.id)), existingRaw)
  assert.equal(await f.reader.get(commitment(task.id)), null); assert.deepEqual(JSON.parse(await f.reader.get(commitmentIndex)), [])
  assert.equal(await f.reader.get(detail(row.old.id)), null); assert.deepEqual(JSON.parse(await f.reader.get(sourceIndex)), [])
})

test('sending/unknown/attempted or unindexed pending actions only migrate frozen; terminal records never enter pending', redisTest, async t => {
  const f = await fixture(t), changes = [
    ['sending', { status: 'sending' }], ['unknown', { status: 'unknown' }], ['attempted', { extra_attempted: true }],
    ['orphan-pending', {}], ['completed', { status: 'completed' }], ['failed', { status: 'failed' }], ['cancelled', { status: 'cancelled' }],
  ], rows = changes.map(([id, change]) => reminder(f, id, change))
  await f.seed(rows, rows.filter(row => row.old.id !== 'orphan-pending').map(row => ({ id: row.old.id, trigger_time: row.old.trigger_time })))
  const first = await f.migrate(false, rows.map(row => row.selection))
  assert.deepEqual(first.deferredReminders, counts(3, 0, 0, 3, 4, { 'in-flight': 4 }))
  const selections = rows.map(row => ({ ...row.selection, freezeUncertain: true })), moved = await f.migrate(true, selections)
  assert.deepEqual(moved.deferredReminders, counts(7, 0, 4, 3))
  assert.equal(await f.reader.get(f.prefix + commitmentIndex), null); assert.deepEqual(JSON.parse(await f.reader.get(sourceIndex)), [])
  for (const [id, change] of changes) {
    const task = await readTask(f, id)
    assert.equal(task.status, ['completed', 'failed', 'cancelled'].includes(change.status) ? change.status : 'unknown')
    assert.equal(task.next_run_at, 0); assert.equal(task.deferredAction.legacy.originalStatus, change.status ?? 'pending')
  }
  assert.deepEqual(await destinationStore(f).takeDueCommitments(f.at + 7200_000), [])
})

test('configured custom and MCP tool mappings preserve frozen parameters and source hash exactly', redisTest, async t => {
  const f = await fixture(t), rows = ['custom', 'mcp'].map(executor => reminder(f, executor, { extra_action: { tool: 'legacy_lookup', params: { query: '固定查询', nested: { z: 2, a: 1 } } } },
    { from: 'legacy_lookup', to: 'mapped_lookup', executor, definitionId: `definition-${executor}-v1` }))
  await f.seed(rows)
  const configured = JSON.parse(JSON.stringify(rows.map(row => row.selection)))
  assert.deepEqual((await f.migrate(true, configured)).deferredReminders, counts(2, 2))
  for (const row of rows) {
    const task = await readTask(f, row.old.id); assert.deepEqual(task.deferredAction.action, row.action); assert.equal(task.deferredAction.grant.source.sourceHash, hash(row.raw))
  }
})

test('text, disabled simulation and private destinations retain active extras but can archive frozen and terminal details', redisTest, async t => {
  for (const options of [{ text: true }, { enabled: false }, { private: true }]) {
    const f = await fixture(t, options), active = reminder(f, 'active'), frozen = reminder(f, 'frozen', { status: 'unknown' }), terminal = reminder(f, 'terminal', { status: 'cancelled' })
    await f.seed([active, frozen, terminal])
    const result = await f.migrate(true, [active.selection, { ...frozen.selection, freezeUncertain: true }, terminal.selection])
    assert.deepEqual(result.deferredReminders, counts(2, 0, 1, 1, 1, { unsupported: 1 }))
    assert.equal(await f.reader.get(detail(active.old.id)), active.raw); assert.equal(await f.reader.get(f.prefix + commitmentIndex), null)
  }
})

test('strict offline selection validation rejects aliases, duplicates, unknown fields, unsafe arrays and invalid grants before any Redis writes', redisTest, async t => {
  const f = await fixture(t), row = reminder(f, 'extra-1'); await f.seed([row]); const before = await f.snapshot()
  const invalid = [null, {}, [row.selection, row.selection], [, row.selection], [{ ...row.selection, freezeUncertain: 'true' }], [{ ...row.selection, nativeEvent: {} }],
    [{ ...row.selection, id: 'bad\nkey' }], [{ ...row.selection, mapping: { ...defaultMapping, extra: true } }],
    [{ ...row.selection, mapping: { ...defaultMapping, executor: 'local' } }], [{ ...row.selection, grant: { ...row.grant, isMaster: true } }],
    [{ ...row.selection, grant: { ...row.grant, creator: { ...row.grant.creator, role: 'admin' } } }], [{ ...row.selection, grant: { ...row.grant, dueAt: 'tomorrow' } }]]
  for (const selections of invalid) await assert.rejects(f.migrate(true, selections), /延期提醒迁移/u)
  let touched = 0
  const getter = { id: row.old.id, get mapping() { touched++; return defaultMapping } }, proxy = new Proxy([], { getPrototypeOf() { touched++; return Array.prototype }, ownKeys() { touched++; return [] } })
  for (const selections of [[getter], proxy]) await assert.rejects(f.migrate(true, selections), /延期提醒迁移/u)
  const opts = { ...f.migration, apply: true, get deferredReminders() { touched++; return [row.selection] } }
  await assert.rejects(runStandaloneQqMigration(f.config, opts), /延期提醒迁移/u)
  await assert.rejects(f.migrate('false', [row.selection]), /迁移参数无效/u)
  await assert.rejects(f.migrate(true, [row.selection], { moveAgentCommitments: 'true' }), /迁移参数无效/u)
  assert.equal(touched, 0); assert.deepEqual(await f.snapshot(), before)
})

test('missing source-cleanup permission aborts the full ordinary-plus-extra CAS before any target write', redisTest, async t => {
  const f = await fixture(t), row = reminder(f, 'extra-1'), plain = reminder(f, 'plain-1', { extra_action: null }); await f.seed([row, plain])
  const before = await f.snapshot()
  await f.reader.sendCommand(['ACL', 'SETUSER', 'default', '-del'])
  await assert.rejects(f.migrate(true, [row.selection]), /Redis 账号缺少迁移所需/u)
  assert.deepEqual(await f.snapshot(), before)
})

test('destination collision, corrupt index or active host/ledger locks reject the whole transfer without source deletion', redisTest, async t => {
  for (const scenario of ['detail', 'pending', 'corrupt', 'source-lock', 'target-lock', 'host']) {
    const f = await fixture(t), row = reminder(f, 'extra-1'), plain = reminder(f, 'plain-1', { extra_action: null }); await f.seed([row, plain])
    if (scenario === 'detail') await f.reader.set(f.prefix + commitment(row.old.id), 'existing-destination')
    if (scenario === 'pending') await f.reader.set(f.prefix + commitmentIndex, JSON.stringify([{ id: row.old.id, next_run_at: row.old.trigger_time }]))
    if (scenario === 'corrupt') await f.reader.set(sourceIndex, '[{"id":"broken","trigger_time":"tomorrow"}]')
    if (scenario === 'source-lock') await f.reader.set('bl-chat:reminder:lock', 'locked')
    if (scenario === 'target-lock') await f.reader.set(f.prefix + 'bl-chat:commitment:lock', 'locked')
    if (scenario === 'host') await f.reader.set(f.prefix + 'agent:host-lease', 'running')
    const before = await f.snapshot()
    await assert.rejects(f.migrate(true, [row.selection]), /目标已有|索引|停止|解锁/u)
    assert.deepEqual(await f.snapshot(), before, scenario)
  }
})

test('selection/config withdrawal during asynchronous staging cancels both ordinary and extra transfers', redisTest, async t => {
  for (const changed of ['selection', 'config']) {
    const f = await fixture(t), row = reminder(f, 'extra-1'), plain = reminder(f, 'plain-1', { extra_action: null }); await f.seed([row, plain])
    const selections = [structuredClone(row.selection)], snapshot = await f.snapshot(), originalCurrent = f.config.isConfigCurrent
    let checks = 0
    f.config.isConfigCurrent = () => {
      checks++
      if (checks === 3) {
        if (changed === 'selection') selections[0].mapping.definitionId = 'revoked'
        else return false
      }
      return originalCurrent()
    }
    await assert.rejects(f.migrate(true, selections), /配置|绑定|迁移期间/u)
    assert.deepEqual(await f.snapshot(), snapshot)
  }
})

test('source or target detail changing before final CAS prevents every staged write and cleanup', redisTest, async t => {
  for (const side of ['source', 'target']) {
    const f = await fixture(t), row = reminder(f, 'extra-1'), plain = reminder(f, 'plain-1', { extra_action: null }); await f.seed([row, plain])
    const originalCurrent = f.config.isConfigCurrent, selectedKey = side === 'source' ? detail(row.old.id) : f.prefix + commitment(row.old.id)
    let checks = 0, changed = false
    f.config.isConfigCurrent = () => {
      checks++
      if (checks === 4) {
        const writer = spawnSync(process.execPath, ['--input-type=module', '-e', `
          import { createClient } from '@redis/client'
          const client = createClient({ socket: { path: process.argv[1], reconnectStrategy: false } })
          await client.connect()
          await client.set(process.argv[2], 'racing-writer')
          await client.close()
        `, f.socket, selectedKey], { encoding: 'utf8', timeout: 5000 })
        assert.equal(writer.status, 0, writer.stderr); changed = true
      }
      return originalCurrent()
    }
    // Complete the competing local write during the final check, before the migration EVAL can run.
    await assert.rejects(f.migrate(true, [row.selection]), /迁移期间账本有变更/u)
    assert.equal(changed, true)
    assert.equal(await f.reader.get(detail(row.old.id)), side === 'source' ? 'racing-writer' : row.raw)
    assert.equal(await f.reader.get(detail(plain.old.id)), plain.raw)
    assert.equal(await f.reader.get(f.prefix + commitment(plain.old.id)), null); assert.equal(await f.reader.get(f.prefix + commitmentIndex), null)
    assert.equal(await f.reader.get(f.prefix + commitment(row.old.id)), side === 'target' ? 'racing-writer' : null)
  }
})
