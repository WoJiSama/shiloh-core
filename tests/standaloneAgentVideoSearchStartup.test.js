import assert from 'node:assert/strict'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'

// Test the real host composition; network, store and bridge lifetimes have
// separate resource tests. These seams do not claim a native QQ delivery.
const key = Symbol.for('bl-chat-test.video-attachment-startup')
const state = 'globalThis[Symbol.for("bl-chat-test.video-attachment-startup")]'
registerHooks({ load(url, context, next) {
  if (/\/(?:src|dist\/backend)\/core\/index\.(?:ts|js)$/u.test(url)) return { format: 'module', shortCircuit: true,
    source: `export function createAgentRuntime(options) { const g = ${state}; g.core = options; g.events.push('core_create'); return {
      async start() { g.events.push('core_start'); await g.onStart(options); process.emit('SIGTERM') }, async stop() { g.events.push('core_stop') } } }` }
  if (/\/modules\/runtime\/infrastructure\/agentRedis\.(?:ts|js)$/u.test(url)) return { format: 'module', shortCircuit: true,
    source: `export function agentRedisPrefix(instance) { return 'bl-agent:' + instance + ':' }
      export async function connectAgentRedis() { const g = ${state}; g.events.push('redis_check'); return { async ping() { return 'PONG' }, async close() { g.events.push('redis_check_close') } } }
      export async function openAgentRedis() { const g = ${state}; g.events.push('redis_open'); return { storage: { async get() { throw Error('startup must not read tool state') }, async set() { throw Error('startup must not write tool state') }, async eval() { throw Error('startup must not execute tool state scripts') } }, isCurrent: () => true, async close() { g.events.push('redis_close') } } }` }
  const result = next(url, context)
  let source = typeof result.source === 'string' ? result.source : Buffer.from(result.source ?? '').toString()
  if (/\/bootstrap\/standaloneMediaRelay\.(?:ts|js)$/u.test(url)) {
    source = source.replace('export async function openStandaloneMediaRelay(', 'async function realOpenStandaloneMediaRelay(') + `
      export async function openStandaloneMediaRelay(options) { const g = ${state}; g.events.push('media_open'); g.mediaOptions = options;
        return { provider: {}, videoSearchAttachmentProvider: { prepare() { throw Error('startup must not prepare resources') } },
          bridgeFor(id) { return { id } }, async close() { g.events.push('media_close') } } }`
  } else if (/\/adapters\/oneBotConnection\.(?:ts|js)$/u.test(url)) {
    source = source.replace('export function createOneBotConnection(', 'function realCreateOneBotConnection(')
      .replace('export async function verifyOneBotLogin(', 'async function realVerifyOneBotLogin(') + `
      export function createOneBotConnection(options) { const g = ${state}; g.adapterOptions = options; return { account: options.connection.account, isReady: () => true, stop() { g.events.push('adapter_stop') } } }
      export async function verifyOneBotLogin() { ${state}.events.push('verify_onebot') }`
  } else return result
  return { ...result, source }
} })
const { main } = await importBilibiliHost('bootstrap/standaloneAgent.js')
async function fixture(t, enabled = true, attachments = true) {
  const directory = await mkdtemp(path.join(tmpdir(), 'video-attachments-startup-')), configFile = path.join(directory, 'agent-host.yaml'), dataDir = path.join(directory, 'data')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const previous = process.env.VIDEO_ATTACHMENT_STARTUP_KEY; process.env.VIDEO_ATTACHMENT_STARTUP_KEY = 'VIDEO_ATTACHMENT_MODEL_PRIVATE_012345'
  t.after(() => { if (previous === undefined) delete process.env.VIDEO_ATTACHMENT_STARTUP_KEY; else process.env.VIDEO_ATTACHMENT_STARTUP_KEY = previous; delete globalThis[key] })
  const g = { events: [], onStart() {} }; globalThis[key] = g
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: '123456001' }], bindings: [{ connectionId: 'main', kind: 'group', conversationId: '90001', agentId: 'daily' }] }))
  await writeFile(configFile, JSON.stringify({ version: 1, instance: 'video-attachment-startup', dataDir, model: { baseUrl: 'https://model.example/v1', name: 'model', apiKeyEnv: 'VIDEO_ATTACHMENT_STARTUP_KEY' },
    connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }], tools: { videoSearch: { enabled, attachments } }, mediaRelay: { enabled: false,
      ...(enabled && attachments ? { bridges: [{ connectionId: 'main', listen: { host: '127.0.0.1', port: 31587 }, advertisedOrigin: 'http://127.0.0.1:31587', allowedPeers: ['127.0.0.1'] }] } : {}) } }))
  return { g, dataDir, configFile, args: ['--config', configFile] }
}

test('attachment-only startup wires native bridge and registered download tool, while check creates no resources and config revision revokes definitions', async t => {
  const { g, dataDir, configFile, args } = await fixture(t)
  await main([...args, '--check']); assert.deepEqual(g.events, ['redis_check', 'redis_check_close', 'verify_onebot'])
  await assert.rejects(lstat(dataDir), { code: 'ENOENT' }); g.events.length = 0
  g.onStart = async options => {
    assert.equal(g.mediaOptions.config.enabled, false); assert.equal(g.mediaOptions.videoSearchAttachments, true)
    assert.equal(g.mediaOptions.pixivTools, undefined); assert.equal(g.mediaOptions.bilibiliQuality, undefined)
    assert.equal(g.mediaOptions.isLeaseCurrent(), true); assert.ok(g.adapterOptions.mediaRelay)
    assert.deepEqual(options.toolRegistry.builtIn.map(tool => tool.name), ['searchVideoTool', 'videoShareTool', 'videoDownloadTool'])
    const raw = JSON.parse(await readFile(configFile, 'utf8')); raw.tools.videoSearch.enabled = false
    await writeFile(configFile, JSON.stringify(raw))
    assert.deepEqual(options.toolRegistry.builtIn, []); assert.equal(options.isVideoSearchCurrent(), false)
  }
  await main(args)
  assert.deepEqual(g.events, ['redis_open', 'media_open', 'core_create', 'core_start', 'core_stop', 'adapter_stop', 'media_close', 'redis_close'])
})

for (const [enabled, attachments] of [[true, false], [false, true]]) test(`video search enabled=${enabled} attachments=${attachments} opens no attachment host`, async t => {
  const { g, args } = await fixture(t, enabled, attachments)
  g.onStart = options => {
    assert.equal(g.adapterOptions.mediaRelay, undefined)
    assert.deepEqual(options.toolRegistry.builtIn.map(tool => tool.name), enabled ? ['searchVideoTool', 'videoShareTool'] : [])
  }
  await main(args)
  assert.deepEqual(g.events, ['redis_open', 'core_create', 'core_start', 'core_stop', 'adapter_stop', 'redis_close'])
})
