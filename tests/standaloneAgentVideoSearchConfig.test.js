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
const { readStandaloneVideoSearchConfig: read } = await importBilibiliHost('bootstrap/standaloneVideoSearch.js')

test('video search defaults off and accepts only a frozen explicit boolean without credential declarations', () => {
  assert.deepEqual(read(undefined), { enabled: false }); assert.deepEqual(read({ enabled: false }), { enabled: false }); assert.deepEqual(read({ enabled: true }), { enabled: true })
  assert.ok(Object.isFrozen(read({ enabled: true })))
  assert.deepEqual(read({ enabled: true, attachments: true }), { enabled: true, attachments: true })
  assert.deepEqual(read({ enabled: true, attachments: false }), { enabled: true, attachments: false })
  let touched = false
  const accessor = { get enabled() { touched = true; return true } }, proxy = new Proxy({}, { ownKeys() { touched = true; throw Error('proxy trap') } })
  for (const input of [null, [], {}, 1, { enabled: 1 }, { enabled: 'true' }, { enabled: true, attachments: 'true' }, { enabled: true, attachments: 1 }, { enabled: true, cookieEnv: 'COOKIE' }, { enabled: false, apiKeyEnv: 'KEY' }, { enabled: true, baseUrl: 'https://other.example' }, { enabled: true, quality: 80 }, accessor, proxy]) assert.throws(() => read(input))
  assert.equal(touched, false)
})

test('video attachments require all bridges even without automatic relay, retain read-only parsing and detect port conflicts', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-video-attachments-config-')); t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: '123456001' }], bindings: [{ connectionId: 'main', kind: 'group', conversationId: '90001', agentId: 'daily' }] }))
  const file = path.join(directory, 'agent-host.yaml'), raw = { version: 1, instance: 'video-attachments-config', dataDir: 'untouched-data', model: { baseUrl: 'https://main.example/v1', name: 'main-model', apiKeyEnv: 'MAIN_KEY' },
    connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }], tools: { videoSearch: { enabled: true, attachments: true } } }
  const readConfig = async value => { await writeFile(file, JSON.stringify(value)); return readStandaloneAgentConfig(file, { MAIN_KEY: 'private' }) }
  await assert.rejects(readConfig(raw), /tools.videoSearch.attachments/u)
  const bridge = { connectionId: 'main', listen: { host: '127.0.0.1', port: 31591 }, advertisedOrigin: 'http://127.0.0.1:31591', allowedPeers: ['127.0.0.1'] }
  const withBridge = { ...raw, mediaRelay: { enabled: false, bridges: [bridge] } }, config = await readConfig(withBridge)
  assert.equal(config.mediaRelay.enabled, false); assert.deepEqual(config.tools.videoSearch, { enabled: true, attachments: true })
  await assert.rejects(lstat(path.join(directory, 'untouched-data')), { code: 'ENOENT' })
  await assert.rejects(readConfig({ ...withBridge, torrentDownload: { enabled: true, bridges: [bridge] } }), /不同监听地址/u)
  await assert.rejects(readConfig({ ...withBridge, groupLog: { enabled: true, bridges: [bridge] } }), /独立监听端口/u)
  const disabled = await readConfig({ ...raw, tools: { videoSearch: { enabled: false, attachments: true } } })
  assert.deepEqual(disabled.tools, defaultTools)
})
test('standalone video search parses read-only independently from video analysis and media relay, and revision changes revoke its snapshot', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-video-search-config-')); t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: '123456001' }], bindings: [{ connectionId: 'main', kind: 'group', conversationId: '90001', agentId: 'daily' }] }))
  const file = path.join(directory, 'agent-host.yaml'), raw = { version: 1, instance: 'video-search-config', dataDir: 'untouched-data', model: { baseUrl: 'https://main.example/v1', name: 'main-model', apiKeyEnv: 'MAIN_KEY' }, connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }] }
  await writeFile(file, JSON.stringify({ ...raw, tools: { videoSearch: { enabled: true } } }))
  const config = readStandaloneAgentConfig(file, { MAIN_KEY: 'private' }); assert.deepEqual(config.tools, { ...defaultTools, videoSearch: { enabled: true } }); assert.equal(config.isConfigCurrent(), true)
  assert.equal(config.mediaRelay.enabled, false); assert.equal(config.tools.videoAnalysis, undefined)
  await assert.rejects(lstat(path.join(directory, 'untouched-data')), { code: 'ENOENT' })
  await writeFile(file, JSON.stringify({ ...raw, tools: { videoSearch: { enabled: false } } })); assert.equal(config.isConfigCurrent(), false); assert.deepEqual(readStandaloneAgentConfig(file, { MAIN_KEY: 'private' }).tools, defaultTools)
  await writeFile(file, JSON.stringify(raw)); assert.deepEqual(readStandaloneAgentConfig(file, { MAIN_KEY: 'private' }).tools, defaultTools)
})

test('explicit text group video tools remain scoped to the declared group and do not enable external services', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-text-video-config-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const account = { platform: 'qq', namespace: 'global', id: '123456001' }
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: account.id }], bindings: ['90001', '90002'].map(conversationId => ({ connectionId: 'main', kind: 'group', conversationId, agentId: 'daily' })) }))
  const file = path.join(directory, 'agent-host.yaml'), names = ['searchVideoTool', 'videoShareTool', 'videoDownloadTool'], raw = { version: 1, instance: 'text-video-config', dataDir: 'untouched-data',
    model: { baseUrl: 'https://main.example/v1', name: 'main-model', apiKeyEnv: 'MAIN_KEY' }, connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }],
    textGroups: [{ connectionId: 'main', conversationId: '90001', tools: names }, { connectionId: 'main', conversationId: '90002' }] }
  await writeFile(file, JSON.stringify(raw))
  const config = readStandaloneAgentConfig(file, { MAIN_KEY: 'private' })
  assert.deepEqual(config.groupTextTools({ account, kind: 'group', id: '90001' }), names)
  assert.deepEqual(config.groupTextTools({ account, kind: 'group', id: '90002' }), [])
  assert.deepEqual(config.groupTextTools({ account, kind: 'group', id: '90003' }), [])
  assert.deepEqual(config.tools, defaultTools); assert.equal(config.mediaRelay.enabled, false)
  await assert.rejects(lstat(path.join(directory, 'untouched-data')), { code: 'ENOENT' })
})
