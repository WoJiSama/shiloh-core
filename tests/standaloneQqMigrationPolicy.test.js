import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { readStandaloneAgentConfig } from '../dist/backend/bootstrap/standaloneAgentConfig.js'
import { runStandaloneQqMigration } from '../dist/backend/bootstrap/standaloneAgentMigration.js'
import { createAgentRuntime } from '../dist/backend/core/index.js'
import { COMMITMENT_PENDING_KEY, commitmentDetailKey, encodeCommitment } from '../dist/backend/modules/commitments/infrastructure/commitmentStore.js'
import { agentBindingIdentity, createAgentBindingDirectory } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { openAgentRedis } from '../dist/backend/modules/runtime/infrastructure/agentRedis.js'
import { createDefaultSimSession } from '../dist/backend/modules/simulation/domain/simConfig.js'
import { simulationAddressKey } from '../dist/backend/modules/simulation/infrastructure/simulationAddress.js'
import { SIMULATION_OVERRIDES_KEY, simulationSessionKey } from '../dist/backend/modules/simulation/infrastructure/simSessionStore.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

const account = { platform: 'qq', namespace: 'global', id: '19000001' }
const target = { account, kind: 'group', id: '310001' }
const address = simulationAddressKey(target)
const connection = { id: 'qq-main', platform: account.platform, namespace: account.namespace, accountId: account.id }
const bindingConfig = { version: 1, agents: [{ id: 'daily', personaId: 'default' }], connections: [connection],
  bindings: [{ connectionId: connection.id, kind: 'group', conversationId: target.id, agentId: 'daily' }] }
const binding = createAgentBindingDirectory(bindingConfig, 'test').resolve(target)
const overrides = ({ explicitEnabled = [], disabled = [] } = {}) => JSON.stringify({ explicitEnabled, disabled, budgetCaps: {}, turnCaps: {} })
const logger = { info() {}, warn() {}, error() {} }

async function setup(t, options = {}) {
  const { reader, url } = await createAgentRedisFixture(t)
  const dir = await mkdtemp(join(tmpdir(), 'qq-policy-cutover-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const instance = 'qq-policy-cutover'
  const prefix = `bl-agent:${instance}:`
  const sourceBindings = join(dir, 'source-bindings.yaml')
  const configPath = join(dir, 'agent-host.yaml')
  await Promise.all([
    writeFile(sourceBindings, JSON.stringify(bindingConfig)),
    writeFile(join(dir, 'agent-bindings.yaml'), JSON.stringify(bindingConfig)),
    writeFile(configPath, JSON.stringify({ version: 1, instance, simulation: options.simulation ?? {},
      model: { baseUrl: 'http://127.0.0.1:9', name: 'unused', apiKeyEnv: 'FIXTURE_KEY' },
      connections: [{ id: 'qq-main', url: 'ws://127.0.0.1:9' }],
    })),
  ])
  const config = readStandaloneAgentConfig(configPath, { BL_AGENT_REDIS_URL: url }, { requireCredentials: false })
  if (options.sourcePolicy) await reader.set(SIMULATION_OVERRIDES_KEY, overrides(options.sourcePolicy))
  if (options.targetPolicy) await reader.set(prefix + SIMULATION_OVERRIDES_KEY, overrides(options.targetPolicy))
  const now = Date.now()
  const taskId = deliver => `qq-migration-${deliver}`
  const raw = deliver => encodeCommitment({
    id: taskId(deliver), group_id: target.id, creator_id: '330019', creator_name: '测试成员', intent: '到时发送会议提醒',
    schedule: { kind: 'once', time: now - 1000 }, deliver, static_message: deliver === 'static' ? '会议提醒' : null,
    expiry_at: now + 4 * 86_400_000, next_run_at: now - 1000, status: 'active', last_run_at: 0, last_result: '', retry_count: 1,
    created_at: now - 5000, bot_id: target.account.id, scope: binding, bindingIdentity: agentBindingIdentity(binding), revision: 1,
  })
  await reader.multi().set(commitmentDetailKey(taskId('agent')), raw('agent')).set(commitmentDetailKey(taskId('static')), raw('static'))
    .set(COMMITMENT_PENDING_KEY, JSON.stringify(['agent', 'static'].map(deliver => ({ id: taskId(deliver), next_run_at: now - 1000 })))).exec()
  const migrate = (apply, moveAgentCommitments = true) => runStandaloneQqMigration(config, {
    sourceBindings, connectionId: connection.id, kind: 'group', conversationId: target.id, moveAgentCommitments, apply,
  })
  const readTask = (deliver, side = '') => reader.get(side + commitmentDetailKey(taskId(deliver)))
  return { reader, url, instance, prefix, config, now, migrate, readTask }
}

test('a disabled source group retains its agent task across cutover and restarts the static reminder', { skip: !redisAvailable, timeout: 12_000 }, async t => {
  const { reader, url, instance, prefix, config, migrate, readTask } = await setup(t, { sourcePolicy: { disabled: [address] } })
  const original = await readTask('agent')
  const preview = await migrate(false)
  assert.equal(preview.simulationControls.enabled, false)
  assert.equal(preview.agentCommitments, 0)
  assert.equal(preview.commitments, 1)
  assert.equal(preview.skipped.unsupported, 1)
  assert.equal(await readTask('agent', prefix), null)
  assert.ok(await readTask('static'))
  assert.deepEqual(await migrate(true), { ...preview, mode: 'applied' })
  assert.equal(await readTask('agent'), original)
  assert.equal(await readTask('agent', prefix), null)
  assert.equal(await readTask('static'), null)
  assert.equal(JSON.parse(await readTask('static', prefix)).retry_count, 1)

  let mainCalls = 0
  const deliveries = []
  const redis = await openAgentRedis({ url, instance, onLost() {} })
  const host = createAgentRuntime({ storage: redis.storage, isExecutionCurrent: redis.isCurrent, logger,
    resolvePersona: config.resolvePersona, getSection: () => config.simulation, getExecutionConfig: () => config.execution,
    YTapi: async () => { mainCalls++; return { choices: [] } },
    adapters: [{ account, id: connection.id, botUserId: account.id, botName: '测试QQ', start: async () => {}, stop() {}, isReady: () => true,
      actions: { async send(action) { deliveries.push(action); return { state: 'sent', messageId: '88501' } } } }],
  })
  try {
    await host.start()
    assert.equal(await host.runtime.isConversationActive(target), false)
    for (let i = 0; i < 100 && JSON.parse(await readTask('static', prefix)).status !== 'completed'; i++) await delay(15)
    assert.equal(JSON.parse(await readTask('static', prefix)).status, 'completed')
    assert.equal(deliveries.length, 1)
    assert.deepEqual(deliveries[0].target, target)
    assert.equal(deliveries[0].parts[0].user.id, '330019')
    assert.equal(mainCalls, 0)
  } finally { await host.stop(); await redis.close() }

  const oldControl = await reader.get(prefix + SIMULATION_OVERRIDES_KEY)
  const repeated = await migrate(true)
  assert.equal(repeated.simulationControls, undefined)
  assert.equal(repeated.agentCommitments, 0)
  assert.equal(await reader.get(prefix + SIMULATION_OVERRIDES_KEY), oldControl)
  assert.equal(await readTask('agent'), original)

  await reader.set(prefix + SIMULATION_OVERRIDES_KEY, overrides({ explicitEnabled: [address] }))
  assert.equal((await migrate(false)).agentCommitments, 1)
  assert.equal((await migrate(true)).agentCommitments, 1)
  assert.equal(await readTask('agent'), null)
  assert.equal(await readTask('agent', prefix), original)
})

for (const [title, options, legacyTarget, denied = true] of [
  ['destination scoped disable', { targetPolicy: { disabled: [address] } }, false],
  ['destination inherited disable', { targetPolicy: { disabled: [target.id] } }, false],
  ['destination explicit allow-list without the group', { simulation: { allGroups: false, groups: ['999999'] } }, false],
  ['destination legacy-session route ignores unrelated scoped enable', {
    simulation: { allGroups: false }, targetPolicy: { explicitEnabled: [address], disabled: [target.id] },
  }, true],
  ['destination scoped enable takes precedence over an inherited disable', {
    simulation: { allGroups: false }, targetPolicy: { explicitEnabled: [address], disabled: [target.id] },
  }, false, false],
]) {
  test(`agent commitment handover respects ${title}`, { skip: !redisAvailable, timeout: 12_000 }, async t => {
    const { reader, prefix, migrate, readTask, now } = await setup(t, options)
    if (legacyTarget) await reader.set(prefix + simulationSessionKey(target.id), JSON.stringify({ ...createDefaultSimSession(now), botId: account.id }))
    const preview = await migrate(false)
    assert.equal(preview.agentCommitments, denied ? 0 : 1)
    assert.equal(preview.commitments, denied ? 1 : 2)
    assert.equal(preview.skipped.unsupported, denied ? 1 : 0)
    assert.deepEqual(await migrate(true), { ...preview, mode: 'applied' })
    assert.equal(Boolean(await readTask('agent')), denied)
    assert.equal(Boolean(await readTask('agent', prefix)), !denied)
    assert.ok(await readTask('static', prefix))
  })
}
