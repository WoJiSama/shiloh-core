import assert from 'node:assert/strict'
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { readStandaloneAgentConfig } = await load('bootstrap/standaloneAgentConfig.js')
const { createAgentBindingDirectory, agentBindingIdentity, agentConversationKey } = await load('modules/runtime/domain/agentBindings.js')
const bindings = { version: 1, agents: [{ id: 'daily', personaId: 'default' }],
  connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: '123456001' }],
  bindings: [{ connectionId: 'main', kind: 'group', conversationId: '90001', agentId: 'daily' }] }
const binding = createAgentBindingDirectory(bindings, 'test-revision').resolve({
  account: { platform: 'qq', namespace: 'global', id: '123456001' }, kind: 'group', id: '90001',
})
const rule = extra => ({ id: 'allowed-poke', revision: 'v1', bindingIdentity: agentBindingIdentity(binding), scopeKey: agentConversationKey(binding),
  creatorIds: ['200001'], tool: 'pokeTool', executor: 'builtin', definitionId: 'core:deferred-poke:v1', maxDelayMs: 86_400_000, ...extra })
const defaults = { enabled: false, rules: [], migrationApprovals: [] }

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-deferred-host-config-')), file = path.join(directory, 'agent-host.yaml')
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify(bindings))
  const raw = { version: 1, instance: 'deferred-config', dataDir: 'untouched-data',
    model: { baseUrl: 'https://model.example/v1', name: 'main', apiKeyEnv: 'MAIN_KEY' }, connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }] }
  return { directory, async read(changes = {}, env = { MAIN_KEY: 'private-model-key' }, options) {
    await writeFile(file, JSON.stringify({ ...raw, ...changes })); return readStandaloneAgentConfig(file, env, options)
  } }
}

test('standalone tools.deferredActions defaults to frozen denial without credentials, connections or data writes', async t => {
  const f = await fixture(t), reads = []
  const env = new Proxy({ MAIN_KEY: 'private-model-key' }, { get(target, key) {
    reads.push(key); assert.ok(['MAIN_KEY', 'BL_AGENT_REDIS_URL'].includes(key)); return target[key]
  } })
  for (const tools of [undefined, {}, { deferredActions: {} }, { deferredActions: { enabled: false } }]) {
    const config = await f.read(tools === undefined ? {} : { tools }, env)
    assert.deepEqual(config.tools.deferredActions, defaults)
    assert.ok(Object.isFrozen(config.tools.deferredActions)); assert.ok(Object.isFrozen(config.tools.deferredActions.rules))
    assert.equal(config.tools.qqActions.gift.enabled, false); assert.equal(config.tools.interactions, undefined)
  }
  assert.ok(reads.every(key => ['MAIN_KEY', 'BL_AGENT_REDIS_URL'].includes(key)))
  assert.deepEqual((await f.read({}, {}, { requireCredentials: false })).tools.deferredActions, defaults)
  await assert.rejects(lstat(path.join(f.directory, 'untouched-data')), { code: 'ENOENT' })
})

test('standalone host preserves exact deferred delegation rules without enabling ordinary tool grants', async t => {
  const f = await fixture(t), selected = rule()
  for (const enabled of [false, true]) {
    const config = await f.read({ tools: { deferredActions: { enabled, rules: [selected] } } })
    assert.deepEqual(config.tools.deferredActions, { ...defaults, enabled, rules: [{ ...selected, executionWindowMs: 300_000 }] })
    assert.ok(Object.isFrozen(config.tools.deferredActions.rules[0])); assert.ok(Object.isFrozen(config.tools.deferredActions.rules[0].creatorIds))
    assert.deepEqual(config.privateTextTools, []); assert.equal(config.tools.interactions, undefined)
    assert.equal(config.tools.mcp, undefined); assert.equal(config.tools.qqActions.gift.enabled, false)
  }
  const empty = await f.read({ tools: { deferredActions: { enabled: true } } })
  assert.deepEqual(empty.tools.deferredActions, { ...defaults, enabled: true })
})

test('standalone tools delegates strict closed parsing to deferred policy even while disabled', async t => {
  const f = await fixture(t)
  for (const deferredActions of [null, [], true, 'true', { enabled: 'false' }, { enabled: false, verifyMigration: true },
    { enabled: false, migrationAuthorization: 'implied' }, { rules: [rule({ maxDelayMs: 999 })] },
    { enabled: false, rules: [rule({ executor: 'native' })] }, { rules: [rule({ creatorIds: [] })] },
    { rules: [rule({ bindingIdentity: 'not-a-binding' })] }, { rules: [rule(), rule()] }]) {
    await assert.rejects(f.read({ tools: { deferredActions } }), /tools\.deferredActions/u)
  }
  await assert.rejects(f.read({ tools: { deferredAction: { enabled: true } } }), /tools/u)
  await assert.rejects(lstat(path.join(f.directory, 'untouched-data')), { code: 'ENOENT' })
})

test('changing a deferred rule or enablement revokes the loaded standalone configuration snapshot', async t => {
  const f = await fixture(t), selected = rule()
  const first = await f.read({ tools: { deferredActions: { enabled: true, rules: [selected] } } })
  assert.equal(first.isConfigCurrent(), true)
  const second = await f.read({ tools: { deferredActions: { enabled: true, rules: [rule({ revision: 'v2' })] } } })
  assert.equal(first.isConfigCurrent(), false); assert.equal(second.isConfigCurrent(), true)
  assert.equal(first.tools.deferredActions.rules[0].revision, 'v1')
  await f.read({ tools: { deferredActions: { enabled: false, rules: [rule({ revision: 'v2' })] } } })
  assert.equal(second.isConfigCurrent(), false)
})

test('deferred enablement does not expand the existing private tool allowlist', async t => {
  const f = await fixture(t), tools = { deferredActions: { enabled: true, rules: [rule()] } }
  const config = await f.read({ tools, privateChat: { enabled: true, allowTools: ['likeTool', 'recallTool'] } })
  assert.equal(config.privateChatEnabled, true); assert.deepEqual(config.privateTextTools, ['likeTool', 'recallTool'])
  await assert.rejects(f.read({ tools, privateChat: { enabled: true, allowTools: ['reminderTool'] } }), /privateChat\.allowTools/u)
})
