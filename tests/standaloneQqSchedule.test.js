import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import YAML from 'yaml'
import { readStandaloneAgentConfig } from '../dist/backend/bootstrap/standaloneAgentConfig.js'
import { runStandaloneQqMigration } from '../dist/backend/bootstrap/standaloneAgentMigration.js'
import { createAgentRuntime } from '../dist/backend/core/index.js'
import { createCharacterStore } from '../dist/backend/modules/simulation/infrastructure/characterStore.js'
import { characterReflectionKey } from '../dist/backend/modules/simulation/infrastructure/characterReflection.js'
import { createDefaultSimSession } from '../dist/backend/modules/simulation/domain/simConfig.js'
import { agentBindingToken, agentPersonaScopeId } from '../dist/backend/modules/runtime/domain/agentBindings.js'
import { createAgentBindingConfig } from '../dist/backend/modules/runtime/infrastructure/agentBindingConfig.js'
import { openAgentRedis } from '../dist/backend/modules/runtime/infrastructure/agentRedis.js'
import { simulationAddressKey } from '../dist/backend/modules/simulation/infrastructure/simulationAddress.js'
import {
  SIMULATION_KNOWN_GROUPS_KEY, simulationRhythmKey, simulationSessionKey,
} from '../dist/backend/modules/simulation/infrastructure/simSessionStore.js'
import { createAgentRedisFixture, redisAvailable } from './helpers/agentRedis.js'

test('QQ state handover restores the reflection deadline, used evidence and actual scoped rhythm', {
  skip: !redisAvailable, timeout: 15_000,
}, async t => {
  const { reader, url } = await createAgentRedisFixture(t)
  const directory = await mkdtemp(path.join(tmpdir(), 'qq-schedule-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const account = { platform: 'qq', namespace: 'global', id: '19000001' }
  const target = { account, kind: 'group', id: '310001' }
  const other = { ...target, id: '310002' }
  const bindingConfig = {
    version: 1, agents: [{ id: 'daily', personaId: 'default' }, { id: 'another', personaId: 'default' }],
    connections: [{ id: 'qq-main', platform: account.platform, namespace: account.namespace, accountId: account.id }],
    bindings: [target, other].map(({ kind, id }) => ({ connectionId: 'qq-main', kind, conversationId: id, agentId: 'daily' })),
  }
  const sourceBindings = path.join(directory, 'source.yaml')
  const targetBindings = path.join(directory, 'agent-bindings.yaml')
  await Promise.all([sourceBindings, targetBindings].map(file => writeFile(file, YAML.stringify(bindingConfig))))
  const configPath = path.join(directory, 'agent-host.yaml')
  const instance = 'schedule-transfer'
  await writeFile(configPath, YAML.stringify({
    version: 1, instance,
    model: { baseUrl: 'http://127.0.0.1:9', name: 'unused', apiKeyEnv: 'FIXTURE_KEY' },
    connections: [{ id: 'qq-main', url: 'ws://127.0.0.1:9' }],
    simulation: { rhythm: { enabled: true, sleepFrom: 10, sleepTo: 11 }, wake: { probability: 0, proactiveProbability: 0 } },
  }))
  const config = readStandaloneAgentConfig(configPath, { BL_AGENT_REDIS_URL: url }, { requireCredentials: false })
  const scope = { botId: account.id, personaId: agentPersonaScopeId('daily'), groupId: target.id }
  const otherScope = { ...scope, groupId: other.id }
  const source = createAgentBindingConfig(sourceBindings)().resolve(target)
  const address = simulationAddressKey(target)
  const destination = `bl-agent:${instance}:`
  const schedule = {
    schemaVersion: 1, lastRunAt: 0, nextRunAt: 0, lastOutcome: '旧反思正文留在原端', runsToday: 0, day: '', processed: [],
  }
  const persona = config.resolvePersona(target)
  let clock = Date.parse('2026-11-14T08:00:00.000Z')
  const sourceRhythm = { sleepFrom: 15, sleepTo: 17, setBy: 'agent', updatedAt: clock - 1000 }
  const reflectionKey = characterReflectionKey(scope)
  const rhythmKey = simulationRhythmKey(scope)
  const anotherRhythmKey = simulationRhythmKey(otherScope)
  const evidenceAt = clock - 30_000
  const receipt = {
    id: 'moved-receipt', toolName: 'simSendMessage', status: 'succeeded', summary: '原平台已确认发送', at: evidenceAt,
  }
  const memories = ['moved-fact-a', 'moved-fact-b'].map((id, i) => ({
    id, kind: 'interest', epistemic: 'inferred', content: `角色公开兴趣 ${i}`, evidenceRefs: [`receipt:${receipt.id}`],
    createdAt: evidenceAt, updatedAt: evidenceAt,
  }))
  const sourceSession = JSON.stringify({
    ...createDefaultSimSession(clock), botId: account.id, personaId: scope.personaId, bindingToken: agentBindingToken(source), bootstrapSent: true,
  })
  await reader.multi().set(simulationRhythmKey(), JSON.stringify({ sleepFrom: 8, sleepTo: 12, setBy: 'agent' }))
    .set(rhythmKey, JSON.stringify(sourceRhythm)).set(anotherRhythmKey, JSON.stringify({ sleepFrom: 18, sleepTo: 19 }))
    .set(reflectionKey, JSON.stringify(schedule)).set(simulationSessionKey(address), sourceSession).exec()
  const sourceCharacterStore = createCharacterStore({ redis: reader, now: () => clock })
  await sourceCharacterStore.update(scope, state => ({ ...state, memories, receipts: [receipt] }))
  const migrate = (apply, room = target) => runStandaloneQqMigration(config, {
    sourceBindings, connectionId: 'qq-main', kind: 'group', conversationId: room.id, moveCharacterState: true, apply,
  })
  const preview = await migrate(false)
  assert.deepEqual(preview.characterSchedule, {
    rhythmTransferred: true, reflectionTransferred: true, nextReflectionAt: 0, reflectionRunsToday: 0,
  })
  assert.ok(!JSON.stringify(preview).includes(schedule.lastOutcome))
  const destinationSession = destination + simulationSessionKey(address)
  assert.equal(await reader.get(destinationSession), null)
  assert.equal(await reader.get(destination + reflectionKey), null)
  assert.equal(await reader.get(destination + anotherRhythmKey), null)
  await reader.set(destination + reflectionKey, '{}')
  await assert.rejects(migrate(true), /目标已有角色作息或反思排期/)
  assert.equal(await reader.get(destinationSession), null)
  assert.equal(await reader.get(destination + rhythmKey), null)
  await reader.del(destination + reflectionKey)
  await reader.set(reflectionKey + ':lock', 'writer')
  await assert.rejects(migrate(true), /仿真群或角色仍有进行中的工作/)
  assert.equal(await reader.get(destination + reflectionKey), null)
  await reader.del(reflectionKey + ':lock')

  assert.deepEqual(await migrate(true), { ...preview, mode: 'applied' })
  const migratedSession = JSON.parse(await reader.get(destinationSession))
  assert.equal(migratedSession.bindingToken, agentBindingToken(persona.binding))
  assert.deepEqual(migratedSession.recent, [])
  assert.deepEqual(JSON.parse(await reader.get(destination + SIMULATION_KNOWN_GROUPS_KEY)), [address])
  assert.deepEqual(JSON.parse(await reader.get(destination + rhythmKey)), sourceRhythm)
  assert.equal(await reader.get(destination + anotherRhythmKey), null)
  assert.equal(await reader.get(destination + simulationRhythmKey()), null)
  assert.equal(await reader.get(simulationSessionKey(address)), sourceSession)
  assert.deepEqual(JSON.parse(await reader.get(reflectionKey)), schedule)

  const runtimeRedis = await openAgentRedis({ url, instance, onLost: () => {} })
  const store = createCharacterStore({ redis: runtimeRedis.storage, now: () => clock })
  const requests = []
  const host = createAgentRuntime({
    storage: runtimeRedis.storage, isExecutionCurrent: runtimeRedis.isCurrent, now: () => clock,
    adapters: [{
      account, id: 'qq-main', botUserId: account.id, botName: '模拟 QQ', start: async () => {}, isReady: () => true, stop: () => {},
      actions: { async send() { assert.fail('background reflection does not send to QQ') } },
    }],
    logger: { info() {}, warn() {}, error() {} },
    resolvePersona: config.resolvePersona, getSection: () => config.simulation, getExecutionConfig: () => config.execution,
    YTapi: async () => ({ choices: [] }),
    reflectCharacter: async request => {
      requests.push(request)
      return { choices: [{ message: { content: JSON.stringify({ summary: '这次无需新增意见', updates: [], goals: [] }) } }] }
    },
  })
  try {
    assert.deepEqual((await store.load(scope)).memories, memories)
    // 16:00 in China is inside the migrated rhythm and outside the host default.
    await host.start()
    assert.equal(requests.length, 0)
    clock += 2 * 3_600_000
    await host.resumePendingWork()
    assert.equal(requests.length, 1)
    const updated = JSON.parse(await reader.get(destination + reflectionKey))
    assert.equal(updated.lastRunAt, clock)
    assert.equal(updated.runsToday, 1)
    assert.deepEqual(updated.processed, [`receipt:${receipt.id}`, ...memories.map(memory => `memory:${memory.id}`)])
    clock += 7 * 3_600_000
    await host.resumePendingWork()
    assert.equal(requests.length, 1)
  } finally {
    await host.stop()
    await runtimeRedis.close()
  }
  assert.equal((await migrate(true)).characterSchedule, undefined)
  assert.deepEqual(JSON.parse(await reader.get(reflectionKey)), schedule)
})
