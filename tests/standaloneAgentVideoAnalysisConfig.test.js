import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
const { readStandaloneVideoAnalysisConfig } = await importBilibiliHost('bootstrap/standaloneVideoAnalysis.js')
const declared = { enabled: true, baseUrl: 'https://video.example/v1', name: 'video-model', apiKeyEnv: 'VIDEO_KEY' }
test('video analysis defaults off, validates disabled declarations and never reads disabled credentials', () => {
  const env = Object.defineProperty({}, 'VIDEO_KEY', { get() { assert.fail('disabled video credential was read') } })
  assert.equal(readStandaloneVideoAnalysisConfig(undefined, env), undefined)
  assert.equal(readStandaloneVideoAnalysisConfig({ ...declared, enabled: false }, env), undefined)
  assert.equal(readStandaloneVideoAnalysisConfig({ enabled: false }, env), undefined)
  assert.throws(() => readStandaloneVideoAnalysisConfig({ enabled: false, baseUrl: 'https://video.example/?key=SECRET' }, env))
})
test('video analysis requires its own explicit endpoint, model and environment credential, including check/preview rules', () => {
  const result = readStandaloneVideoAnalysisConfig(declared, { VIDEO_KEY: 'video-private' })
  assert.deepEqual(result, { enabled: true, baseUrl: 'https://video.example/v1', name: 'video-model', apiKey: 'video-private', inputMode: 'inline' })
  assert.ok(Object.isFrozen(result))
  assert.throws(() => readStandaloneVideoAnalysisConfig(declared, {}), /VIDEO_KEY/)
  assert.equal(readStandaloneVideoAnalysisConfig(declared, {}, false).apiKey, '')
  for (const field of ['baseUrl', 'name', 'apiKeyEnv']) { const input = { ...declared }; delete input[field]; assert.throws(() => readStandaloneVideoAnalysisConfig(input, {})) }
  const upload = readStandaloneVideoAnalysisConfig({ ...declared, inputMode: 'bigmodel-upload', uploadHosts: ['media.example'] }, { VIDEO_KEY: 'private' })
  assert.deepEqual(upload.uploadHosts, ['media.example']); assert.equal(upload.inputMode, 'bigmodel-upload')
})
test('video analysis rejects unknown configuration, malformed authority, input modes and unbounded credential data', () => {
  for (const input of [null, [], {}, { enabled: 1 }, { ...declared, apiKey: 'inline-private' }, { ...declared, uploadUrl: 'https://other.example/' },
    { ...declared, baseUrl: 'file:///tmp/video' }, { ...declared, baseUrl: 'https://user:pass@video.example/v1' }, { ...declared, baseUrl: 'https://video.example/#secret' },
    { ...declared, name: '' }, { ...declared, name: 'x'.repeat(201) }, { ...declared, apiKeyEnv: 'bad-name' }, { ...declared, inputMode: 'url' },
    { ...declared, uploadHosts: ['*.example'] }, { ...declared, uploadHosts: ['127.0.0.1'] }, { ...declared, uploadHosts: [] }]) {
    assert.throws(() => readStandaloneVideoAnalysisConfig(input, { VIDEO_KEY: 'key' }), JSON.stringify(input))
  }
  assert.throws(() => readStandaloneVideoAnalysisConfig(declared, { VIDEO_KEY: 'key\nheader' }))
})
test('standalone host wires video analysis only when enabled and revision invalidates its configuration snapshot', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-video-config-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: '123456001' }],
    bindings: [{ connectionId: 'main', kind: 'group', conversationId: '90001', agentId: 'daily' }] }))
  const file = path.join(directory, 'agent-host.yaml'), raw = { version: 1, instance: 'video-config',
    model: { baseUrl: 'https://main.example/v1', name: 'main-model', apiKeyEnv: 'MAIN_KEY' },
    connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }], tools: { videoAnalysis: declared } }
  await writeFile(file, JSON.stringify(raw))
  const config = readStandaloneAgentConfig(file, { MAIN_KEY: 'main-private', VIDEO_KEY: 'video-private' })
  assert.equal(config.tools.videoAnalysis.name, 'video-model'); assert.equal(config.tools.videoAnalysis.apiKey, 'video-private')
  assert.equal(config.mediaRelay.enabled, false); assert.equal(config.isConfigCurrent(), true)
  await writeFile(file, JSON.stringify({ ...raw, tools: { videoAnalysis: { enabled: false } } }))
  assert.equal(config.isConfigCurrent(), false)
  assert.deepEqual(readStandaloneAgentConfig(file, { MAIN_KEY: 'main-private' }).tools, defaultTools)
})
