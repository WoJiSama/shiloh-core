import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile, copyFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'
import { createQzoneRedis } from './helpers/agentQzoneRedis.mjs'

const { buildStandaloneLegacyMemorySourceProof: proofFor, validateStandaloneLegacyMemorySourceProof: validateProof,
  projectStandaloneLegacyMemoryMigration: project, migrateStandaloneLegacyMemoryState: migrate,
  acquireStandaloneLegacyMemoryEvidence: acquire, runStandaloneLegacyQqMemoryMigration: run } = await load('bootstrap/standaloneAgentLegacyMemoryMigration.js')
const [{ characterKey, createEmptyCharacterState }, { agentBindingToken, agentConversationKey, conversationAddressKey }] = await Promise.all([
  load('modules/simulation/domain/characterState.js'), load('modules/runtime/domain/agentBindings.js'),
])
const now = Date.parse('2026-11-18T08:00:00Z'), sha = value => createHash('sha256').update(value).digest('hex')
const account = { platform: 'qq', namespace: 'global', id: '19008818' }, groupId = '3108818'
const target = { account, kind: 'group', id: groupId }
const binding = { source: 'configured', id: conversationAddressKey(target), revision: 'current-binding', agentId: 'shiloh', personaId: 'default', connectionId: 'main', target }
const oldScope = { botId: account.id, personaId: 'default', groupId }, newScope = { ...oldScope, personaId: 'agent:shiloh' }
const receipt = (id, extra = {}) => ({ id, toolName: 'simSendMessage', status: 'succeeded', summary: 'Original private output must be replaced.', at: now - 1000, ...extra })
const memory = (id, evidenceRefs, extra = {}) => ({ id, kind: 'experience', content: `Memory ${id}`, epistemic: 'reported', evidenceRefs, createdAt: now - 5000, updatedAt: now - 1000, ...extra })
function fixture() {
  const state = { ...createEmptyCharacterState(oldScope), revision: 3,
    memories: [memory('portable', ['receipt:sent']), memory('message-only', ['message:7']),
      memory('pending-dependent', ['receipt:pending']), memory('pending-child', ['memory:pending-dependent'])],
    receipts: [receipt('sent'), receipt('unrelated'), receipt('pending', { status: 'pending' })],
    decision: { kind: 'engage', reason: 'Old execution decision.', at: now - 1000 } }
  const sourceRaw = JSON.stringify(state)
  const configRaw = JSON.stringify({ pluginSettings: { enabled: true, enableGroupWhitelist: true, allowedGroups: [groupId],
    persona: { enabled: true, name: 'Default' }, simulation: { enabled: true, allGroups: true } } })
  const personasRaw = JSON.stringify({ personas: [{ id: 'other-persona' }], groupBindings: {}, accountBindings: { '19008819': 'other-persona' }, privateBinding: '' })
  const evidence = { configRaw, personasRaw, sourceBindingsAbsent: true, sourceKey: characterKey(oldScope), sourceRaw,
    backupSourceRaw: sourceRaw, resolver: { kind: 'persona-library-v1', file: '/legacy/dist/personaLibrary.js', sha256: sha('reviewed resolver') },
    backup: { id: 'verified-cutover-snapshot', configData: { file: '/backup/legacy.tar.gz', sha256: sha('archive bytes') },
      redis: { file: '/backup/redis.rdb', sha256: sha('rdb bytes') }, configSha256: sha(configRaw), personasSha256: sha(personasRaw) } }
  const f = { state, evidence, binding: structuredClone(binding), sourceRaw,
    proof() { return proofFor({ evidence: this.evidence, binding: this.binding }) },
    project(targetRaw = null, extra = {}) { return project({ proof: this.proof(), evidence: this.evidence, binding: this.binding, targetRaw, now, allowsText: () => true, ...extra }) },
    source(next) { this.state = next; this.sourceRaw = JSON.stringify(next); this.evidence.sourceRaw = this.sourceRaw; this.evidence.backupSourceRaw = this.sourceRaw },
  }
  return f
}

test('legacy proof derives default ownership from actual routing and pins source bytes, backup and current target', () => {
  const f = fixture(), proof = f.proof()
  assert.equal(proof.kind, 'qq-implicit-default-memory')
  assert.deepEqual(proof.source.scope, oldScope); assert.equal(proof.source.key, characterKey(oldScope)); assert.equal(proof.source.sha256, sha(f.sourceRaw))
  assert.equal(proof.destination.scopeKey, agentConversationKey(binding)); assert.equal(proof.destination.bindingToken, agentBindingToken(binding))
  assert.equal(proof.backup.redis.sha256, f.evidence.backup.redis.sha256)
  assert.equal(validateProof(proof, { evidence: f.evidence, binding: f.binding }), true)
  const serialized = JSON.stringify(proof)
  for (const text of ['Memory portable', 'Original private output', 'Old execution decision', 'Default']) assert.equal(serialized.includes(text), false)
  assert.equal(Object.isFrozen(proof.source.scope), true)
})

test('proof rejects a claimed default route, unbacked source, foreign owner or changed destination', () => {
  const variants = [
    f => { f.evidence.sourceBindingsAbsent = false },
    f => { f.evidence.personasRaw = JSON.stringify({ personas: [{ id: 'other' }], groupBindings: { [groupId]: 'other' }, accountBindings: {}, privateBinding: '' }); f.evidence.backup.personasSha256 = sha(f.evidence.personasRaw) },
    f => { f.evidence.personasRaw = JSON.stringify({ personas: [{ id: 'other' }], groupBindings: {}, accountBindings: { [account.id]: 'other' }, privateBinding: '' }); f.evidence.backup.personasSha256 = sha(f.evidence.personasRaw) },
    f => { f.evidence.backupSourceRaw = f.evidence.sourceRaw + ' ' },
    f => { f.evidence.sourceKey = characterKey({ ...oldScope, botId: '19008819' }) },
    f => { f.evidence.backup.configSha256 = sha('different config') },
    f => { f.binding.agentId = 'other' }, f => { f.binding.personaId = 'other' },
    f => { f.binding.target.kind = 'private' }, f => { f.binding.target.account.namespace = 'other' },
    f => { f.evidence.configRaw = JSON.stringify({ pluginSettings: { enabled: true, enableGroupWhitelist: true, allowedGroups: ['3108819'] } }); f.evidence.backup.configSha256 = sha(f.evidence.configRaw) },
  ]
  for (const change of variants) { const f = fixture(); change(f); assert.throws(() => f.proof(), /旧默认人格记忆来源/u) }
  const f = fixture(), proof = f.proof()
  assert.equal(validateProof({ ...proof, destination: { ...proof.destination, bindingToken: 'invented' } }, { evidence: f.evidence, binding: f.binding }), false)
  f.binding.revision = 'new'; assert.equal(validateProof(proof, { evidence: f.evidence, binding: f.binding }), false)
})

test('projection imports only closed memory evidence and never old decisions, goals, queue or unrelated receipts', () => {
  const f = fixture(), before = structuredClone(f.evidence), result = f.project()
  assert.deepEqual(result.state.scope, newScope)
  assert.deepEqual(result.state.memories.map(m => m.id), ['portable'])
  assert.deepEqual(result.state.receipts.map(r => [r.id, r.status, r.summary]), [['sent', 'succeeded', '工具执行返回成功']])
  assert.deepEqual(result.state.goals, []); assert.equal(result.state.decision, undefined); assert.equal(result.state.paused, false)
  assert.deepEqual(result.report, { sourceMemories: 4, importedMemories: 1, alreadyImportedMemories: 0, retainedMemories: 3,
    importedReceipts: 1, skipped: { unportableEvidence: 1, unsettledEvidence: 2, policy: 0 } })
  assert.deepEqual(f.evidence, before); assert.equal(result.expectedTargetSha256, null)
  assert.deepEqual(result.receipt.memories.map(row => row.id), ['portable'])
  assert.equal(result.receipt.proof.source.scope.personaId, 'default')
})

test('fresh Core state is merged without losing its decision, pause, goals or evidence and repeat import is idempotent', () => {
  const f = fixture(), current = { ...createEmptyCharacterState(newScope), revision: 9, paused: true,
    memories: [memory('new-core-memory', ['receipt:new-core-receipt'])], receipts: [receipt('new-core-receipt')],
    decision: { kind: 'silent', reason: 'Current Core decision.', at: now } }
  const raw = JSON.stringify(current), result = f.project(raw)
  assert.deepEqual(result.state.memories.map(row => row.id), ['new-core-memory', 'portable'])
  assert.deepEqual(result.state.decision, current.decision); assert.equal(result.state.paused, true); assert.equal(result.state.revision, 10)
  assert.equal(result.expectedTargetSha256, sha(raw)); assert.equal(JSON.stringify(current), raw)
  const repeated = f.project(JSON.stringify(result.state))
  assert.equal(repeated.changed, false); assert.equal(repeated.report.importedMemories, 0); assert.equal(repeated.report.alreadyImportedMemories, 1)
  assert.deepEqual(repeated.state, result.state)
  const collision = { ...current, memories: [memory('portable', ['receipt:new-core-receipt'], { content: 'New Core owns this ID.' })] }
  assert.throws(() => f.project(JSON.stringify(collision)), /目标已有不同内容/u)
})

test('goal-linked and pending evidence is excluded to a fixed point, including supersession chains and blocked text', () => {
  const f = fixture(), createdAt = now - 60 * 60000
  const goal = { id: 'old-goal', kind: 'autonomous', title: 'Do not execute', motivation: 'Historical', nextStep: 'Historical', completionCriteria: 'Historical',
    stopConditions: ['Stop'], evidenceRefs: ['message:9'], status: 'active', nextCheckAt: createdAt + 16 * 60000,
    expiresAt: now + 86400000, attempts: 0, maxAttempts: 1, revision: 1, createdAt, updatedAt: createdAt }
  f.source({ ...f.state, goals: [goal], receipts: [...f.state.receipts, receipt('goal-receipt', { goalId: goal.id })],
    memories: [...f.state.memories, memory('goal-dependent', ['receipt:goal-receipt']), memory('replacement', ['memory:pending-dependent'], { supersedes: 'pending-dependent' })] })
  const result = f.project(); assert.deepEqual(result.state.goals, []); assert.deepEqual(result.state.memories.map(m => m.id), ['portable'])
  assert.equal(result.state.receipts.some(r => r.goalId || r.status === 'pending'), false)
  const blocked = f.project(null, { allowsText: () => false }); assert.equal(blocked.changed, false)
  assert.deepEqual(blocked.state.memories, []); assert.deepEqual(blocked.state.receipts, []); assert.equal(blocked.report.skipped.policy, 1)
})

test('an original unknown receipt remains uncertain audit and only its actual memory dependencies are imported', () => {
  const f = fixture(); f.source({ ...f.state, receipts: [...f.state.receipts, receipt('unknown', { status: 'unknown' })],
    memories: [...f.state.memories, memory('uncertain-memory', ['receipt:unknown'])] })
  const result = f.project(), audit = result.state.receipts.find(row => row.id === 'unknown')
  assert.equal(audit.status, 'unknown'); assert.equal(audit.summary, '动作结果无法确认')
  assert.equal(result.receipt.receipts.find(row => row.id === audit.id).status, 'unknown')
  assert.equal(result.state.receipts.some(row => row.id === 'unrelated'), false)
})

async function redisFixture(t) {
  const f = fixture(), { storage } = await createQzoneRedis(t), prefix = 'bl-agent:legacy-proof:', targetKey = prefix + characterKey(newScope)
  await storage.set(f.evidence.sourceKey, f.evidence.sourceRaw)
  const input = { evidence: f.evidence, binding: f.binding, redis: storage, instance: 'legacy-proof', apply: false, now, isCurrent: () => true, allowsText: () => true }
  return { ...f, storage, prefix, targetKey, input, markerKey: prefix + 'agent:migration:qq-legacy-memory:v1:' + encodeURIComponent(agentConversationKey(binding)) }
}

test('preview is read-only, apply uses one real source/target/lease CAS and repeat cannot resurrect forgotten memory', { timeout: 30000 }, async t => {
  const f = await redisFixture(t), current = { ...createEmptyCharacterState(newScope), revision: 7, paused: true,
    decision: { kind: 'silent', reason: 'Current state retained.', at: now } }
  await f.storage.set(f.targetKey, JSON.stringify(current))
  const before = await f.storage.get(f.targetKey), preview = await migrate(f.input)
  assert.equal(preview.mode, 'preview'); assert.equal(preview.importedMemories, 1)
  assert.equal(await f.storage.get(f.targetKey), before); assert.equal(await f.storage.get(f.markerKey), null)
  const applied = await migrate({ ...f.input, apply: true }); assert.equal(applied.mode, 'applied'); assert.equal(applied.importedMemories, 1)
  const saved = JSON.parse(await f.storage.get(f.targetKey)); assert.deepEqual(saved.decision, current.decision); assert.equal(saved.paused, true)
  assert.equal(await f.storage.get(f.evidence.sourceKey), f.evidence.sourceRaw)
  const marker = await f.storage.get(f.markerKey); assert.equal(JSON.parse(marker).proof.source.sha256, sha(f.evidence.sourceRaw))
  assert.equal(marker.includes('Memory portable'), false)
  saved.memories = []; saved.receipts = []; saved.revision++
  const forgotten = JSON.stringify(saved); await f.storage.set(f.targetKey, forgotten)
  const repeated = await migrate({ ...f.input, apply: true }); assert.equal(repeated.alreadyApplied, true)
  assert.equal(await f.storage.get(f.targetKey), forgotten); assert.equal(await f.storage.get(f.markerKey), marker)
})

test('active lease allows read-only preview and rejects apply; every lock and source/target race fails before either write', { timeout: 30000 }, async t => {
  const f = await redisFixture(t), lease = f.prefix + 'agent:host-lease'
  await f.storage.set(lease, 'active'); assert.equal((await migrate(f.input)).requiresOffline, true)
  await assert.rejects(migrate({ ...f.input, apply: true }), /停止Core/u)
  await f.storage.del(lease)
  for (const race of [lease, f.targetKey, f.evidence.sourceKey]) {
    await f.storage.del([f.targetKey, f.markerKey, lease]); await f.storage.set(f.evidence.sourceKey, f.evidence.sourceRaw)
    const redis = { mGet: keys => f.storage.mGet(keys), async eval(script, options) {
      await f.storage.set(race, race === f.evidence.sourceKey ? f.evidence.sourceRaw + ' ' : 'concurrent writer')
      return f.storage.eval(script, options)
    } }
    await assert.rejects(migrate({ ...f.input, apply: true, redis }), /来源、目标、锁或租约已改变/u)
    assert.equal(await f.storage.get(f.markerKey), null)
    if (race !== f.targetKey) assert.equal(await f.storage.get(f.targetKey), null)
  }
  await f.storage.set(f.evidence.sourceKey, f.evidence.sourceRaw); await f.storage.del([f.targetKey, lease])
  await assert.rejects(migrate({ ...f.input, isCurrent: () => false, apply: true }), /宿主或来源配置/u)
})

async function acquisitionFixture(t) {
  const f = await redisFixture(t), directory = await realpath(await mkdtemp(path.join(tmpdir(), 'legacy-memory-acquire-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const sourceRoot = path.join(directory, 'legacy'), backupDir = path.join(directory, 'backup'), configDir = path.join(sourceRoot, 'config')
  const resolverFile = path.join(sourceRoot, 'dist/backend/modules/conversation/infrastructure/personaLibrary.js')
  await Promise.all([mkdir(configDir, { recursive: true }), mkdir(path.dirname(resolverFile), { recursive: true }), mkdir(backupDir)])
  await writeFile(path.join(configDir, 'message.yaml'), f.evidence.configRaw)
  await writeFile(path.join(configDir, 'persona-library.yaml'), f.evidence.personasRaw)
  await copyFile(new URL('../dist/backend/modules/conversation/infrastructure/personaLibrary.js', import.meta.url), resolverFile)
  const archive = () => execFileSync('tar', ['-czf', path.join(backupDir, 'legacy-config-data.tar.gz'), '-C', sourceRoot, 'config'], { stdio: 'ignore' })
  archive()
  await f.storage.sendCommand(['SAVE'])
  const config = await f.storage.configGet(['dir', 'dbfilename'])
  await copyFile(path.join(config.dir, config.dbfilename), path.join(backupDir, 'redis.rdb'))
  return { ...f, directory, sourceRoot, backupDir, resolverFile, configDir, archive,
    options: { sourceRoot, backupDir, binding: f.binding, redis: f.storage } }
}

test('acquisition reads actual archive members, approved resolver and isolated RDB rather than trusting proof declarations', { timeout: 30000 }, async t => {
  const f = await acquisitionFixture(t), captured = await acquire(f.options)
  assert.equal(captured.isCurrent(), true); assert.equal(captured.evidence.backupSourceRaw, f.evidence.sourceRaw)
  assert.equal(validateProof(captured.proof, { evidence: captured.evidence, binding: f.binding }), true)
  const config = { instance: 'legacy-proof', connections: [{ connection: { id: 'main', account } }], simulation: { enabled: true },
    isConfigCurrent: () => true, resolvePersona: () => ({ binding: f.binding }), redisUrl: 'unix://' + f.storage.options.socket.path,
    forbiddenWords: { enabled: false }, tools: {}, execution: {}, semanticMemory: {}, console: {} }
  const report = await run(config, { sourceRoot: f.sourceRoot, backupDir: f.backupDir, connectionId: 'main', groupId, apply: false })
  assert.equal(report.importedMemories, 1); assert.equal(await f.storage.get(f.targetKey), null)
  for (const value of [f.evidence.sourceRaw, sha(f.evidence.sourceRaw)]) assert.equal(JSON.stringify(report).includes(value), false)
  await writeFile(path.join(f.configDir, 'message.yaml'), f.evidence.configRaw + '\n')
  assert.equal(captured.isCurrent(), false)
  await assert.rejects(acquire(f.options), /无法核验/u)
  await writeFile(path.join(f.configDir, 'message.yaml'), f.evidence.configRaw)
  await writeFile(f.resolverFile, 'export const invented = true')
  await assert.rejects(acquire(f.options), /无法核验/u)
})

test('a live/backup state mismatch and either a live or archived explicit binding refuse acquisition', { timeout: 30000 }, async t => {
  const f = await acquisitionFixture(t)
  await f.storage.set(f.evidence.sourceKey, f.evidence.sourceRaw + ' ')
  await assert.rejects(acquire(f.options), /无法核验/u)
  await f.storage.set(f.evidence.sourceKey, f.evidence.sourceRaw)
  const file = path.join(f.configDir, 'agent-bindings.yaml'); await writeFile(file, '{}')
  await assert.rejects(acquire(f.options), /无法核验/u)
  f.archive(); await rm(file)
  await assert.rejects(acquire(f.options), /无法核验/u)
})
