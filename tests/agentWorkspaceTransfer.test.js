import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runStandaloneQqMigration } from '../dist/backend/bootstrap/standaloneAgentMigration.js'
import { readStandaloneAgentConfig } from '../dist/backend/bootstrap/standaloneAgentConfig.js'
import { createPersonMemoryStore } from '../dist/backend/modules/memory/infrastructure/personMemoryStore.js'
import { agentBindingToken, agentPersonaScopeId } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { createAgentBindingConfig } from '../dist/backend/modules/runtime/infrastructure/agentBindingConfig.js'
import { characterKey, createEmptyCharacterState, validateCharacterState } from '../dist/backend/modules/simulation/domain/characterState.js'
import { createDefaultSimSession } from '../dist/backend/modules/simulation/domain/simConfig.js'
import { createCharacterStore } from '../dist/backend/modules/simulation/infrastructure/characterStore.js'
import { characterWorkspaceKey, createCharacterWorkspace } from '../dist/backend/modules/simulation/infrastructure/characterWorkspace.js'
import { simulationAddressKey } from '../dist/backend/modules/simulation/infrastructure/simulationAddress.js'
import { simulationSessionKey } from '../dist/backend/modules/simulation/infrastructure/simSessionStore.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const logger = { info() {}, warn() {}, error() {} }
const bot = '96001'
const groupId = '97001'
const agent = 'draft-author'
const target = { account: { platform: 'qq', namespace: 'global', id: bot }, kind: 'group', id: groupId }
const scope = { botId: bot, personaId: agentPersonaScopeId(agent), groupId }

async function fixture(t) {
  // Use an instance distinct from the fixture's leased namespace because
  // cutover requires both source and destination hosts to be stopped.
  const { reader, url } = await createAgentRedisFixture(t, 'test-lease')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-transfer-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const source = path.join(directory, 'source-bindings.yaml')
  const destination = path.join(directory, 'agent-bindings.yaml')
  const configFile = path.join(directory, 'agent-host.yaml')
  const bindings = {
    version: 1, agents: [{ id: agent, personaId: 'default' }], connections: [
      { id: 'qq-local', platform: 'qq', namespace: 'global', accountId: bot },
    ], bindings: [{ connectionId: 'qq-local', kind: 'group', conversationId: groupId, agentId: agent }],
  }
  await Promise.all([
    fs.writeFile(source, JSON.stringify(bindings)),
    fs.writeFile(destination, JSON.stringify(bindings)),
    fs.writeFile(configFile, JSON.stringify({ version: 1, instance: 'draft-target', persona: { name: 'fixture' },
      model: { baseUrl: 'http://127.0.0.1:8999', name: 'fixture-text', apiKeyEnv: 'WORKSPACE_TEST_KEY' },
      connections: [{ id: 'qq-local', url: 'ws://127.0.0.1:8989' }] })),
  ])
  const config = readStandaloneAgentConfig(configFile, { BL_AGENT_REDIS_URL: url }, { requireCredentials: false })
  const oldBinding = createAgentBindingConfig(source)().resolve(target)
  const prefix = 'bl-agent:draft-target:'
  const workKey = characterWorkspaceKey(scope)
  const roleKey = characterKey(scope)
  const at = Date.now() - 30_000
  const oldRole = () => validateCharacterState({
    ...createEmptyCharacterState(scope), revision: 2,
    memories: [{ id: 'old', kind: 'opinion', epistemic: 'inferred', content: '旧推测', evidenceRefs: ['receipt:old-send'], createdAt: at, updatedAt: at },
      { id: 'active', kind: 'opinion', epistemic: 'inferred', content: '仍有效的角色推测', evidenceRefs: ['memory:old', 'receipt:old-send'],
        supersedes: 'old', createdAt: at, updatedAt: at },
      { id: 'erased-chat', kind: 'experience', epistemic: 'reported', content: '已删除的原消息线索', evidenceRefs: ['message:999'], createdAt: at, updatedAt: at }],
    receipts: [
      { id: 'old-send', toolName: 'simSendMessage', status: 'succeeded', summary: '原群发送回执正文', at: at - 1000 },
      { id: 'workspace-only-receipt', toolName: 'simGoalCheck', status: 'succeeded', summary: '仅作品依赖旧回执', at: at - 500 },
      { id: 'old-worker', toolName: 'simWorkerTask', status: 'succeeded', summary: '外部工作器派生资料', at },
      { id: 'pending-transfer', toolName: 'simSendMessage', status: 'pending', summary: '在途动作', at },
      ...Array.from({ length: 65 }, (_, index) => ({ id: `audit-${index}`, toolName: 'simSendMessage', status: 'succeeded', summary: '常规审计', at: at + index })),
    ],
  }, scope)
  const store = createCharacterWorkspace({ redis: reader, scope, now: () => at })
  const run = (apply = false, overrides = {}, afterStaging) => {
    let configChecks = 0
    const currentConfig = afterStaging ? { ...config, isConfigCurrent() {
      if (!config.isConfigCurrent()) return false
      if (++configChecks === 2) afterStaging(url)
      return true
    } } : config
    return runStandaloneQqMigration(currentConfig, {
      sourceBindings: source, connectionId: 'qq-local', conversationId: groupId, kind: 'group', moveCharacterState: true, apply, ...overrides,
    })
  }
  async function seedRole(useScopedSession = false) {
    const sessionId = useScopedSession ? simulationAddressKey(target) : groupId
    await reader.set(simulationSessionKey(sessionId), JSON.stringify({ ...createDefaultSimSession(at),
      botId: bot, personaId: scope.personaId, bindingToken: agentBindingToken(oldBinding), bootstrapSent: true }))
    await reader.set(roleKey, JSON.stringify(oldRole()))
  }
  return { reader, prefix, roleKey, workKey, at, store, run, seedRole }
}

function draft(title, content, evidenceRefs, extra = {}) {
  return { title, kind: 'note', content, evidenceRefs, ...extra }
}

test('QQ workspace cutover preserves complete draft evidence and strict source and target snapshots', {
  skip: !redisAvailable, timeout: 12_000,
}, async t => {
  const { reader, prefix, roleKey, workKey, at, store, run, seedRole } = await fixture(t)
  await seedRole()
  const clean = await store.write(draft('完整证据的草稿', '只依赖可接续的角色记忆', ['memory:active', 'receipt:workspace-only-receipt']))
  let partial = await store.write(draft('可证明的初稿', '可接续的旧版内容', ['receipt:old-send']))
  partial = await store.write(draft('来自原群消息的危险标题', '仅依赖原群序号的版本', ['message:4'],
    { id: partial.id, expectedRevision: partial.revision }))
  partial = await store.restore(partial.id, 1, partial.revision)
  partial = await store.archive(partial.id, true)
  await store.write(draft('共享偏好作品', '源端共享偏好线索', ['memory:active'], { sharedSources: ['shared-other-group'] }))
  await store.write(draft('工作器作品', '源端工作器线索', ['receipt:old-worker']))
  await store.write(draft('旧记忆作品', '源端已被替换的旧线索', ['memory:old']))
  await store.write(draft('未完成的在途发送', '仍依赖结果未知的回执', ['receipt:pending-transfer']))
  await store.write(draft('后来擦除的聊天', '引用了已删除的聊天派生记录', ['memory:erased-chat']))
  await createPersonMemoryStore({ redis: reader, now: () => at + 3000 }).revokeSource({
    identity: { botId: bot, personaId: scope.personaId }, scene: { kind: 'group', id: groupId }, messageId: 'rolled-back',
  })
  const unrelated = createCharacterWorkspace({ redis: reader, scope: { ...scope, botId: '96002' }, now: () => at })
  await unrelated.write(draft('其他账号工作区', '禁止复制的另一个账号草稿', ['memory:active']))

  const sourceRaw = await reader.get(workKey)
  const sourceRole = await reader.get(roleKey)
  // Use a real Redis lock to exercise conflict and preserve the workspace.
  await reader.set(`${workKey}:lock`, 'writer-in-progress')
  await assert.rejects(run(true), /作品仍有进行中的工作/u)
  assert.equal(await reader.get(prefix + roleKey), null)
  await reader.del(`${workKey}:lock`)
  await reader.set(prefix + workKey, JSON.stringify({ schemaVersion: 1, scope, works: [] }))
  await assert.rejects(run(true), /目标已有角色作品/u)
  assert.equal(await reader.get(prefix + roleKey), null)
  await reader.del(prefix + workKey)

  const report = { works: 2, versions: 3, retainedWorks: 5, retainedVersions: 6 }
  assert.equal((await run(false, { moveCharacterState: false })).characterWorkspace, undefined)
  const preview = await run()
  assert.deepEqual(preview.characterWorkspace, report)
  assert.ok(!/草稿|危险标题|workspace-only-receipt/u.test(JSON.stringify(preview)))
  assert.equal(await reader.get(workKey), sourceRaw)
  assert.equal(await reader.get(prefix + workKey), null)
  assert.equal(await reader.get(prefix + roleKey), null)

  const concurrentSource = JSON.parse(sourceRaw)
  concurrentSource.works.find(work => work.id === clean.id).title = '预览后编辑的作品'
  const changedRaw = JSON.stringify(concurrentSource)
  await assert.rejects(run(true, {}, url => {
    // The second configuration check runs after staging and before the atomic write.
    const module = new URL('../dist/backend/modules/runtime/infrastructure/agentRedis.js', import.meta.url).href
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { connectAgentRedis } = await import(process.argv[1])
      const client = await connectAgentRedis(process.argv[2])
      try { await client.set(process.argv[3], process.argv[4]) } finally { await client.close() }
    `, module, url, workKey, changedRaw], { timeout: 5_000 })
  }), /迁移期间账本有变更/u)
  assert.equal(await reader.get(workKey), changedRaw)
  assert.equal(await reader.get(prefix + workKey), null)
  assert.equal(await reader.get(prefix + roleKey), null)
  await reader.set(workKey, sourceRaw)

  const applied = await run(true)
  assert.deepEqual(applied.characterWorkspace, report)
  assert.equal(await reader.get(workKey), sourceRaw)
  assert.equal(await reader.get(roleKey), sourceRole)
  const targetRedis = {
    get: key => reader.get(prefix + key), set: (key, value) => reader.set(prefix + key, value), del: key => reader.del(prefix + key),
  }
  const destination = createCharacterWorkspace({ redis: targetRedis, scope, now: () => at + 3000 })
  assert.deepEqual(await destination.read(clean.id), clean)
  const retained = await destination.read(partial.id)
  assert.deepEqual(retained, { ...partial, title: '来源已整理的作品', versions: partial.versions.filter(item => item.revision !== 2) })
  await assert.rejects(destination.restore(partial.id, 2, partial.revision), /版本不存在/u)
  const roles = createCharacterStore({ redis: targetRedis, now: () => at + 3000,
    retainEvidenceRefs: async () => (await destination.list()).flatMap(work => work.versions.flatMap(version => version.evidenceRefs)) })
  const compacted = await roles.update(scope, current => current)
  assert.ok(compacted.receipts.some(receipt => receipt.id === 'workspace-only-receipt'))
  await destination.pruneEvidence([
    ...compacted.memories.filter(row => row.id === 'active').map(row => `memory:${row.id}`),
    ...compacted.receipts.map(row => `receipt:${row.id}`),
  ])
  assert.equal((await destination.list()).length, 2)
  await destination.remove(clean.id)
  const retry = await run(true)
  assert.equal(retry.characterWorkspace, undefined)
  assert.deepEqual((await destination.list()).map(row => row.id), [partial.id])
  assert.equal(await reader.get(prefix + characterWorkspaceKey({ ...scope, botId: '96002' })), null)
})

test('workspace reports omit malformed source draft text', { skip: !redisAvailable, timeout: 10_000 }, async t => {
  const { reader, prefix, roleKey, workKey, run, seedRole } = await fixture(t)
  await seedRole()
  const invalid = '原作品敏感文本，非 JSON 格式'
  await reader.set(workKey, invalid)
  await assert.rejects(run(true), { message: '来源角色作品空间无效，迁移未写入' })
  assert.equal(await reader.get(workKey), invalid)
  assert.equal(await reader.get(prefix + workKey), null)
  assert.equal(await reader.get(prefix + roleKey), null)
})

test('workspace evidence is checked again against an already migrated role after a scoped-source cutover', {
  skip: !redisAvailable, timeout: 10_000,
}, async t => {
  const { reader, prefix, roleKey, store, run, seedRole } = await fixture(t)
  await seedRole(true)
  await run(true)
  const rejected = await store.write(draft('只依赖目标中已编辑的回执', '不可跳过已迁证据的内容比较', ['receipt:workspace-only-receipt']))
  const accepted = await store.write(draft('对应项仍然可见', '应可接续的内容', ['memory:active']))
  const targetRole = JSON.parse(await reader.get(prefix + roleKey))
  targetRole.receipts.find(item => item.id === 'workspace-only-receipt').summary = '在目标更改了的不同回执'
  await reader.set(prefix + roleKey, JSON.stringify(targetRole))
  const report = await run(true)
  assert.deepEqual(report.characterWorkspace, { works: 1, versions: 1, retainedWorks: 1, retainedVersions: 1 })
  const key = prefix + characterWorkspaceKey(scope)
  const migrated = JSON.parse(await reader.get(key))
  assert.deepEqual(migrated.works, [accepted])
  assert.ok(!(await reader.get(key)).includes(rejected.id))
})
