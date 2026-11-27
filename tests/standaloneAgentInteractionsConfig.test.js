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
const names = ['pokeTool', 'likeTool', 'reactionTool', 'recallTool', 'jinyanTool', 'changeCardTool']
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-interactions-config-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const account = { platform: 'qq', namespace: 'global', id: '123456001' }, file = path.join(directory, 'agent-host.yaml')
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: account.id }],
    bindings: ['90001', '90002'].map(conversationId => ({ connectionId: 'main', kind: 'group', conversationId, agentId: 'daily' })) }))
  const raw = { version: 1, instance: 'interaction-config', dataDir: 'untouched-data', model: { baseUrl: 'https://model.example/v1', name: 'main', apiKeyEnv: 'MAIN_KEY' },
    connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }] }
  return { directory, file, raw, account, async read(changes = {}, env = { MAIN_KEY: 'private-model-key' }, options) {
    await writeFile(file, JSON.stringify({ ...raw, ...changes })); return readStandaloneAgentConfig(file, env, options)
  } }
}

test('standalone interactions default off, accept one explicit boolean and need no credentials or native endpoint', async t => {
  const f = await fixture(t)
  assert.deepEqual((await f.read()).tools, defaultTools)
  assert.deepEqual((await f.read({ tools: { interactions: { enabled: false } } })).tools, defaultTools)
  const reads = [], env = new Proxy({ MAIN_KEY: 'private-model-key' }, { get(target, key) { reads.push(key); assert.ok(['MAIN_KEY', 'BL_AGENT_REDIS_URL'].includes(key)); return target[key] } })
  const enabled = await f.read({ tools: { interactions: { enabled: true } } }, env)
  assert.deepEqual(enabled.tools, { ...defaultTools, interactions: { enabled: true } }); assert.ok(Object.isFrozen(enabled.tools.interactions))
  assert.ok(reads.every(key => ['MAIN_KEY', 'BL_AGENT_REDIS_URL'].includes(key)))
  assert.equal(enabled.mediaRelay.enabled, false); assert.equal(enabled.tools.videoSearch, undefined)
  assert.deepEqual((await f.read({ tools: { interactions: { enabled: true } } }, {}, { requireCredentials: false })).tools, enabled.tools)
  await assert.rejects(lstat(path.join(f.directory, 'untouched-data')), { code: 'ENOENT' })
})

test('standalone interactions reject implicit enablement, nonbooleans, credentials and native API fields even when disabled', async t => {
  const f = await fixture(t)
  for (const interactions of [null, [], 1, true, {}, { enabled: 'true' }, { enabled: 1 },
    { enabled: true, apiKeyEnv: 'INTERACTION_KEY' }, { enabled: false, endpoint: 'http://127.0.0.1/native' },
    { enabled: true, action: 'send_poke' }, { enabled: false, token: 'private-native-token' }, { enabled: true, count: 10 }]) {
    await assert.rejects(f.read({ tools: { interactions } }))
  }
})

test('interaction tool names require explicit per-group grants and config changes invalidate the loaded snapshot', async t => {
  const f = await fixture(t), tools = { interactions: { enabled: true } }, textGroups = [
    { connectionId: 'main', conversationId: '90001', tools: names }, { connectionId: 'main', conversationId: '90002' },
  ]
  const config = await f.read({ tools, textGroups })
  assert.deepEqual(config.groupTextTools({ account: f.account, kind: 'group', id: '90001' }), names)
  assert.deepEqual(config.groupTextTools({ account: f.account, kind: 'group', id: '90002' }), [])
  assert.deepEqual(config.groupTextTools({ account: f.account, kind: 'group', id: '90003' }), [])
  assert.equal(config.isConfigCurrent(), true)
  await f.read({ tools: { interactions: { enabled: false } }, textGroups }); assert.equal(config.isConfigCurrent(), false)
  await assert.rejects(f.read({ tools, textGroups: [{ ...textGroups[0], tools: ['pokeTool', 'pokeTool'] }] }), /textGroups.tools/u)
  await assert.rejects(lstat(path.join(f.directory, 'untouched-data')), { code: 'ENOENT' })
})

test('private interaction grants default empty and accept only explicit unique like and own-recall tools', async t => {
  const f = await fixture(t)
  for (const privateChat of [undefined, {}, { enabled: true }, { enabled: false }]) {
    assert.deepEqual((await f.read(privateChat === undefined ? {} : { privateChat })).privateTextTools, [])
  }
  const first = await f.read({ privateChat: { enabled: true, allowTools: ['likeTool', 'recallTool'] } })
  assert.deepEqual(first.privateTextTools, ['likeTool', 'recallTool']); assert.ok(Object.isFrozen(first.privateTextTools))
  assert.equal(first.isConfigCurrent(), true)
  await f.read({ privateChat: { enabled: true, allowTools: ['likeTool'] } }); assert.equal(first.isConfigCurrent(), false)
  const group = await f.read({ textGroups: [{ connectionId: 'main', conversationId: '90001', tools: ['recallTool'] }] })
  assert.deepEqual(group.groupTextTools({ account: f.account, kind: 'group', id: '90001' }), ['recallTool'])
  for (const allowTools of [null, true, 'likeTool', ['pokeTool'], ['reactionTool'], ['jinyanTool'], ['changeCardTool'], ['commitmentTool'], ['recallTool', 'recallTool'], ['likeTool', 'native'], [1]]) {
    await assert.rejects(f.read({ privateChat: { enabled: false, allowTools } }), /privateChat.allowTools/u)
  }
  await assert.rejects(f.read({ privateChat: { enabled: true, allowTools: [], native: true } }), /privateChat/u)
  await assert.rejects(lstat(path.join(f.directory, 'untouched-data')), { code: 'ENOENT' })
})
