import assert from 'node:assert/strict'
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'

const defaultTools = {
  localEmoji: { enabled: false, config: {} },
  qqActions: {
    qzone: { enabled: false }, gift: { enabled: false },
    redPackets: { enabled: false, allowExplicit: false, allowRecentSearch: false, allowReferenceFallback: false,
      allowPasswordSend: false, recentLimit: 100, automatic: { enabled: false, toolConfigured: false, allowPasswordSend: false } },
  },
  deferredActions: { enabled: false, rules: [], migrationApprovals: [] },
}

const { readStandaloneAgentConfig } = await importBilibiliHost('bootstrap/standaloneAgentConfig.js')
const defaults = { enabled: false, maxDiceCount: 100, maxDiceSides: 100_000, maxRounds: 20 }
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-dice-config-')), file = path.join(directory, 'agent-host.yaml')
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: '123456001' }],
    bindings: [{ connectionId: 'main', kind: 'group', conversationId: '90001', agentId: 'daily' }] }))
  const raw = { version: 1, instance: 'dice-config', dataDir: 'untouched-data', model: { baseUrl: 'https://model.example/v1', name: 'main', apiKeyEnv: 'MAIN_KEY' },
    connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }] }
  return { directory, async read(changes = {}, env = { MAIN_KEY: 'private-model-key' }, options) {
    await writeFile(file, JSON.stringify({ ...raw, ...changes })); return readStandaloneAgentConfig(file, env, options)
  } }
}

test('dice is independently disabled by default with bounded immutable defaults and no extra credentials or writes', async t => {
  const f = await fixture(t)
  for (const changes of [{}, { dice: {} }, { dice: { enabled: false } }]) {
    const config = await f.read(changes)
    assert.deepEqual(config.dice, defaults); assert.ok(Object.isFrozen(config.dice))
    assert.deepEqual(config.tools, defaultTools); assert.equal(config.groupLog.enabled, false)
  }
  const reads = [], env = new Proxy({ MAIN_KEY: 'private-model-key' }, { get(target, key) {
    reads.push(key); assert.ok(['MAIN_KEY', 'BL_AGENT_REDIS_URL'].includes(key)); return target[key]
  } })
  const config = await f.read({ dice: { enabled: true } }, env)
  assert.deepEqual(config.dice, { ...defaults, enabled: true }); assert.ok(Object.isFrozen(config.dice))
  assert.ok(reads.every(key => ['MAIN_KEY', 'BL_AGENT_REDIS_URL'].includes(key)))
  assert.deepEqual((await f.read({ dice: { enabled: true } }, {}, { requireCredentials: false })).dice, config.dice)
  await assert.rejects(lstat(path.join(f.directory, 'untouched-data')), { code: 'ENOENT' })
})

test('dice accepts explicit limits at both boundaries without enabling an omitted capability', async t => {
  const f = await fixture(t)
  for (const limits of [{ maxDiceCount: 1, maxDiceSides: 2, maxRounds: 1 }, { maxDiceCount: 10_000, maxDiceSides: 100_000_000, maxRounds: 1000 }]) {
    assert.deepEqual((await f.read({ dice: limits })).dice, { enabled: false, ...limits })
    assert.deepEqual((await f.read({ dice: { enabled: true, ...limits } })).dice, { enabled: true, ...limits })
  }
  assert.deepEqual((await f.read({ dice: { enabled: true, maxRounds: 3 } })).dice, { ...defaults, enabled: true, maxRounds: 3 })
})

test('dice rejects unknown options, nonboolean enablement and invalid numeric limits even while disabled', async t => {
  const f = await fixture(t)
  for (const dice of [null, [], 1, true, 'true', { enabled: null }, { enabled: 'true' }, { enabled: 1 },
    { enabled: true, apiKeyEnv: 'DICE_KEY' }, { enabled: false, rules: 'custom' }, { enabled: true, endpoint: 'http://localhost/dice' }]) {
    await assert.rejects(f.read({ dice }))
  }
  for (const [key, minimum, maximum] of [['maxDiceCount', 1, 10_000], ['maxDiceSides', 2, 100_000_000], ['maxRounds', 1, 1000]]) {
    for (const value of [null, false, String(minimum), minimum - 1, maximum + 1, minimum + 0.5]) {
      await assert.rejects(f.read({ dice: { enabled: false, [key]: value } }), new RegExp(`dice\\.${key}`, 'u'))
    }
  }
  await assert.rejects(lstat(path.join(f.directory, 'untouched-data')), { code: 'ENOENT' })
})

test('editing dice authorization or a numeric bound invalidates the loaded host snapshot', async t => {
  const f = await fixture(t)
  const first = await f.read({ dice: { enabled: true } }); assert.equal(first.isConfigCurrent(), true)
  const second = await f.read({ dice: { enabled: true, maxDiceCount: 2 } }); assert.equal(first.isConfigCurrent(), false)
  assert.equal(second.isConfigCurrent(), true)
  await f.read({ dice: { enabled: false, maxDiceCount: 2 } }); assert.equal(second.isConfigCurrent(), false)
})
