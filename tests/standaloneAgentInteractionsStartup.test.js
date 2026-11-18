import assert from 'node:assert/strict'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'

const key = Symbol.for('bl-chat-test.interactions-startup'), state = 'globalThis[Symbol.for("bl-chat-test.interactions-startup")]'
registerHooks({ load(url, context, next) {
  if (/\/(?:src|dist\/backend)\/core\/index\.(?:ts|js)$/u.test(url)) return { format: 'module', shortCircuit: true,
    source: `export function createAgentRuntime(options) { const g = ${state}; g.events.push('core_create'); return {
      async start() { g.events.push('core_start'); await g.onStart(options); process.emit('SIGTERM') }, async stop() { g.events.push('core_stop') } } }` }
  if (/\/modules\/runtime\/infrastructure\/agentRedis\.(?:ts|js)$/u.test(url)) return { format: 'module', shortCircuit: true,
    source: `export function agentRedisPrefix(instance) { return 'bl-agent:' + instance + ':' }
      export async function connectAgentRedis() { const g = ${state}; g.events.push('redis_check'); return { async ping() { return 'PONG' }, async close() { g.events.push('redis_check_close') } } }
      export async function openAgentRedis() { const g = ${state}; g.events.push('redis_open'); return { storage: { async get() { throw Error('startup cannot read interaction state') }, async eval() { throw Error('startup cannot write interaction state') } }, isCurrent: () => true, async close() { g.events.push('redis_close') } } }` }
  if (!/\/adapters\/oneBotConnection\.(?:ts|js)$/u.test(url)) return next(url, context)
  const result = next(url, context), source = typeof result.source === 'string' ? result.source : Buffer.from(result.source ?? '').toString()
  return { ...result, source: source.replace('export function createOneBotConnection(', 'function realCreateOneBotConnection(')
    .replace('export async function verifyOneBotLogin(', 'async function realVerifyOneBotLogin(') + `
      export function createOneBotConnection(options) { const g = ${state}; g.adapter = options; return { account: options.connection.account, isReady: () => true, stop() { g.events.push('adapter_stop') } } }
      export async function verifyOneBotLogin() { ${state}.events.push('verify_onebot') }` }
} })
const { main } = await importBilibiliHost('bootstrap/standaloneAgent.js')
async function fixture(t, interactions, privateChat) {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-interactions-startup-')), file = path.join(directory, 'agent-host.yaml'), dataDir = path.join(directory, 'data')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const previous = process.env.INTERACTION_STARTUP_MODEL_KEY; process.env.INTERACTION_STARTUP_MODEL_KEY = 'INTERACTION_STARTUP_MODEL_PRIVATE_123456'
  t.after(() => { if (previous === undefined) delete process.env.INTERACTION_STARTUP_MODEL_KEY; else process.env.INTERACTION_STARTUP_MODEL_KEY = previous; delete globalThis[key] })
  const g = { events: [], onStart() {} }; globalThis[key] = g
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: '123456001' }], bindings: [{ connectionId: 'main', kind: 'group', conversationId: '90001', agentId: 'daily' }] }))
  await writeFile(file, JSON.stringify({ version: 1, instance: 'interactions-startup', dataDir, model: { baseUrl: 'https://model.example/v1', name: 'main', apiKeyEnv: 'INTERACTION_STARTUP_MODEL_KEY' },
    connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }], textGroups: [{ connectionId: 'main', conversationId: '90001', tools: ['jinyanTool', 'changeCardTool'] }],
    ...(privateChat === undefined ? {} : { privateChat }), ...(interactions === undefined ? {} : { tools: { interactions } }) }))
  return { g, file, dataDir, args: ['--config', file] }
}

test('interaction startup delegates one registration to Core and revokes the loaded feature when configuration changes', async t => {
  const f = await fixture(t, { enabled: true })
  await main([...f.args, '--check']); assert.deepEqual(f.g.events, ['redis_check', 'redis_check_close', 'verify_onebot'])
  await assert.rejects(lstat(f.dataDir), { code: 'ENOENT' }); f.g.events.length = 0
  f.g.onStart = async options => {
    assert.deepEqual(options.interactions, { enabled: true }); assert.equal(options.isInteractionsCurrent(), true)
    assert.deepEqual(options.toolRegistry.builtIn, [], 'the host must not register duplicate interaction factories')
    assert.deepEqual(options.groupTextTools({ account: { platform: 'qq', namespace: 'global', id: '123456001' }, kind: 'group', id: '90001' }), ['jinyanTool', 'changeCardTool'])
    assert.deepEqual(options.groupTextTools({ account: { platform: 'qq', namespace: 'global', id: '123456001' }, kind: 'group', id: '90002' }), [])
    assert.equal(f.g.adapter.mediaRelay, undefined)
    const raw = JSON.parse(await readFile(f.file, 'utf8')); raw.tools.interactions.enabled = false
    await writeFile(f.file, JSON.stringify(raw)); assert.equal(options.isInteractionsCurrent(), false)
  }
  await main(f.args)
  assert.deepEqual(f.g.events, ['redis_open', 'core_create', 'core_start', 'core_stop', 'adapter_stop', 'redis_close'])
})

for (const interactions of [undefined, { enabled: false }]) test(`interaction startup keeps omitted=${interactions === undefined} configuration disabled`, async t => {
  const f = await fixture(t, interactions)
  f.g.onStart = options => {
    assert.deepEqual(options.interactions, { enabled: false }); assert.equal(options.isInteractionsCurrent(), false)
    assert.deepEqual(options.privateTextTools, [])
    assert.deepEqual(options.toolRegistry.builtIn, []); assert.equal(f.g.adapter.mediaRelay, undefined)
  }
  await main(f.args)
  assert.deepEqual(f.g.events, ['redis_open', 'core_create', 'core_start', 'core_stop', 'adapter_stop', 'redis_close'])
})

test('interaction startup passes explicit private grants and configuration edits revoke the loaded capability', async t => {
  const f = await fixture(t, { enabled: true }, { enabled: true, allowTools: ['likeTool', 'recallTool'] })
  f.g.onStart = async options => {
    assert.equal(options.privateChatEnabled, true); assert.deepEqual(options.privateTextTools, ['likeTool', 'recallTool'])
    assert.equal(options.isInteractionsCurrent(), true)
    const raw = JSON.parse(await readFile(f.file, 'utf8')); raw.privateChat.allowTools = []
    await writeFile(f.file, JSON.stringify(raw)); assert.equal(options.isInteractionsCurrent(), false)
  }
  await main(f.args)
  assert.deepEqual(f.g.events, ['redis_open', 'core_create', 'core_start', 'core_stop', 'adapter_stop', 'redis_close'])
})
