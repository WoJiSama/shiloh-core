import assert from 'node:assert/strict'
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'

// Exercise the actual host composition with isolated service boundaries. Provider,
// vault and bridge behavior are covered by their own real resource tests.
const key = Symbol.for('bl-chat-test.bilibili-quality-startup')
const state = 'globalThis[Symbol.for("bl-chat-test.bilibili-quality-startup")]'
registerHooks({ load(url, context, next) {
  if (/\/(?:src|dist\/backend)\/core\/index\.(?:ts|js)$/u.test(url)) return { format: 'module', shortCircuit: true,
    source: `export function createAgentRuntime(options) { const g = ${state}; g.core = options; g.events.push('core_create'); return {
      async start() { g.events.push('core_start'); g.onStart(options); process.emit('SIGTERM') }, async stop() { g.events.push('core_stop') } } }` }
  if (/\/modules\/runtime\/infrastructure\/agentRedis\.(?:ts|js)$/u.test(url)) return { format: 'module', shortCircuit: true,
    source: `export function agentRedisPrefix(instance) { return 'bl-agent:' + instance + ':' }
      export async function connectAgentRedis() { const g = ${state}; g.events.push('redis_check'); return { async ping() { return 'PONG' }, async close() { g.events.push('redis_check_close') } } }
      export async function openAgentRedis() { const g = ${state}; g.events.push('redis_open'); return { storage: { async get() { throw Error('startup cannot read state') }, async eval() { throw Error('startup cannot write state') } }, isCurrent: () => true, async close() { g.events.push('redis_close') } } }` }
  const result = next(url, context)
  let source = typeof result.source === 'string' ? result.source : Buffer.from(result.source ?? '').toString()
  if (/\/bootstrap\/standaloneBilibiliQuality\.(?:ts|js)$/u.test(url)) {
    source = source.replace('export async function openStandaloneBilibiliAuth(', 'async function realOpenStandaloneBilibiliAuth(') + `
      export async function openStandaloneBilibiliAuth(options) { const g = ${state}; if (!options.config.enabled) return undefined;
        g.events.push('auth_open'); g.authOptions = options; options.registerSecrets(['DYNAMIC_AUTH_PRIVATE_012345']); return g.auth }`
  } else if (/\/bootstrap\/standaloneMediaRelay\.(?:ts|js)$/u.test(url)) {
    source = source.replace('export async function openStandaloneMediaRelay(', 'async function realOpenStandaloneMediaRelay(') + `
      export async function openStandaloneMediaRelay(options) { const g = ${state}; g.events.push('media_open'); g.mediaOptions = options;
        if (g.failMedia) throw Error('synthetic media startup failure'); return { provider: {}, qualityProviderFor(binding) { g.providerBinding = binding; return g.qualityProvider },
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
async function fixture(t, enabled = true) {
  const directory = await mkdtemp(path.join(tmpdir(), 'bilibili-quality-startup-')), configFile = path.join(directory, 'agent-host.yaml'), dataDir = path.join(directory, 'data')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const previous = process.env.HQ_STARTUP_MODEL_KEY; process.env.HQ_STARTUP_MODEL_KEY = 'HQ_STARTUP_MODEL_PRIVATE_012345'
  t.after(() => { if (previous === undefined) delete process.env.HQ_STARTUP_MODEL_KEY; else process.env.HQ_STARTUP_MODEL_KEY = previous; delete globalThis[key] })
  const g = { events: [], qualityProvider: { prepare() { assert.fail('startup must not prepare media') } }, onStart() {} }
  g.auth = { async close() { g.events.push('auth_close') } }; globalThis[key] = g
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: '123456001' }], bindings: [{ connectionId: 'main', kind: 'group', conversationId: '90001', agentId: 'daily' }] }))
  await writeFile(configFile, JSON.stringify({ version: 1, instance: 'hq-startup', dataDir, model: { baseUrl: 'https://model.example/v1', name: 'model', apiKeyEnv: 'HQ_STARTUP_MODEL_KEY' },
    connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }], bilibiliQuality: { enabled, masters: [] }, mediaRelay: { enabled: false,
      ...(enabled ? { bridges: [{ connectionId: 'main', listen: { host: '127.0.0.1', port: 31587 }, advertisedOrigin: 'http://127.0.0.1:31587', allowedPeers: ['127.0.0.1'] }] } : {}) } }))
  return { g, dataDir, args: ['--config', configFile] }
}

test('HQ-only startup wires live secret guards, native auth and scoped providers, then stops Core before auth, media and Redis', async t => {
  const { g, dataDir, args } = await fixture(t)
  await main([...args, '--check']); assert.deepEqual(g.events, ['redis_check', 'redis_check_close', 'verify_onebot'])
  await assert.rejects(lstat(dataDir), { code: 'ENOENT' }); g.events.length = 0
  g.onStart = options => {
    assert.equal(options.bilibiliQuality.enabled, true); assert.equal(options.bilibiliAuthService, g.auth); assert.equal(options.isBilibiliQualityCurrent(), true)
    const binding = { target: { account: { platform: 'qq', namespace: 'global', id: '123456001' }, kind: 'group', id: '90001' }, agentId: 'daily' }
    assert.equal(options.bilibiliQualityProviderFor(binding), g.qualityProvider); assert.equal(g.providerBinding, binding)
    assert.equal(g.authOptions.isLeaseCurrent(), true); assert.equal(g.mediaOptions.config.enabled, false); assert.equal(g.mediaOptions.bilibiliQuality.authService, g.auth)
    assert.equal(options.allowsText('DYNAMIC_AUTH_PRIVATE_012345', 'outgoing'), false)
    assert.equal(g.adapterOptions.bilibiliAuth.allowsText('DYNAMIC_AUTH_PRIVATE_012345'), false)
    assert.equal(g.adapterOptions.bilibiliAuth.allowsText('正常授权状态'), true)
  }
  await main(args)
  assert.deepEqual(g.events, ['redis_open', 'auth_open', 'media_open', 'core_create', 'core_start', 'core_stop', 'adapter_stop', 'auth_close', 'media_close', 'redis_close'])
})

test('disabled HQ starts no authorization or media service, and --check retains only existing Redis and QQ validation', async t => {
  const { g, dataDir, args } = await fixture(t, false)
  await main([...args, '--check']); assert.deepEqual(g.events, ['redis_check', 'redis_check_close', 'verify_onebot'])
  await assert.rejects(lstat(dataDir), { code: 'ENOENT' }); g.events.length = 0
  g.onStart = options => { assert.equal(options.bilibiliQuality.enabled, false); assert.equal(options.bilibiliAuthService, undefined); assert.equal(options.bilibiliQualityProviderFor, undefined); assert.equal(g.adapterOptions.bilibiliAuth, undefined) }
  await main(args); assert.deepEqual(g.events, ['redis_open', 'core_create', 'core_start', 'core_stop', 'adapter_stop', 'redis_close'])
})

test('partial HQ media startup failure closes the opened authorization service before releasing Redis', async t => {
  const { g, args } = await fixture(t); g.failMedia = true
  await assert.rejects(main(args), /synthetic media startup failure/u)
  assert.deepEqual(g.events, ['redis_open', 'auth_open', 'media_open', 'auth_close', 'redis_close'])
})
