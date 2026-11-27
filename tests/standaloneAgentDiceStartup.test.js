import assert from 'node:assert/strict'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'

const key = Symbol.for('bl-chat-test.dice-startup'), state = 'globalThis[Symbol.for("bl-chat-test.dice-startup")]'
registerHooks({ load(url, context, next) {
  if (/\/(?:src|dist\/backend)\/core\/index\.(?:ts|js)$/u.test(url)) return { format: 'module', shortCircuit: true,
    source: `export { createLinuxSystemdAgentDiceScriptRunner } from '../modules/dice/infrastructure/agentDiceScriptProcess.js'
      export function createAgentRuntime(options) { const g = ${state}; g.events.push('core_create'); return {
      async start() { g.events.push('core_start'); await g.onStart(options); process.emit('SIGTERM') }, async stop() { g.events.push('core_stop') } } }` }
  if (/\/modules\/runtime\/infrastructure\/agentRedis\.(?:ts|js)$/u.test(url)) return { format: 'module', shortCircuit: true,
    source: `export function agentRedisPrefix(instance) { return 'bl-agent:' + instance + ':' }
      export async function connectAgentRedis() { const g = ${state}; g.events.push('redis_check'); return { async ping() { return 'PONG' }, async close() { g.events.push('redis_check_close') } } }
      export async function openAgentRedis() { const g = ${state}; g.events.push('redis_open'); return { storage: { async get() { throw Error('startup cannot read dice state') }, async eval() { throw Error('startup cannot write dice state') } }, isCurrent: () => true, async close() { g.events.push('redis_close') } } }` }
  if (!/\/adapters\/oneBotConnection\.(?:ts|js)$/u.test(url)) return next(url, context)
  const result = next(url, context), source = typeof result.source === 'string' ? result.source : Buffer.from(result.source ?? '').toString()
  return { ...result, source: source.replace('export function createOneBotConnection(', 'function realCreateOneBotConnection(')
    .replace('export async function verifyOneBotLogin(', 'async function realVerifyOneBotLogin(') + `
      export function createOneBotConnection(options) { const g = ${state}; g.adapter = options; return { account: options.connection.account, isReady: () => true, stop() { g.events.push('adapter_stop') } } }
      export async function verifyOneBotLogin() { ${state}.events.push('verify_onebot') }` }
} })
const { main } = await importBilibiliHost('bootstrap/standaloneAgent.js')
async function fixture(t, dice) {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-dice-startup-')), file = path.join(directory, 'agent-host.yaml'), dataDir = path.join(directory, 'data')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const previous = process.env.DICE_STARTUP_MODEL_KEY; process.env.DICE_STARTUP_MODEL_KEY = 'DICE_STARTUP_MODEL_PRIVATE_123456'
  t.after(() => { if (previous === undefined) delete process.env.DICE_STARTUP_MODEL_KEY; else process.env.DICE_STARTUP_MODEL_KEY = previous; delete globalThis[key] })
  const g = { events: [], onStart() {} }; globalThis[key] = g
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: '123456001' }], bindings: [{ connectionId: 'main', kind: 'group', conversationId: '90001', agentId: 'daily' }] }))
  await writeFile(file, JSON.stringify({ version: 1, instance: 'dice-startup', dataDir, model: { baseUrl: 'https://model.example/v1', name: 'main', apiKeyEnv: 'DICE_STARTUP_MODEL_KEY' },
    connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }], ...(dice === undefined ? {} : { dice }) }))
  return { g, file, dataDir, args: ['--config', file] }
}

test('dice check is read-only and startup delegates immutable bounded authorization to Core', async t => {
  const dice = { enabled: true, maxDiceCount: 30, maxDiceSides: 1000, maxRounds: 4 }, f = await fixture(t, dice)
  await main([...f.args, '--check']); assert.deepEqual(f.g.events, ['redis_check', 'redis_check_close', 'verify_onebot'])
  await assert.rejects(lstat(f.dataDir), { code: 'ENOENT' }); f.g.events.length = 0
  f.g.onStart = async options => {
    assert.deepEqual(options.dice, dice); assert.ok(Object.isFrozen(options.dice)); assert.equal(options.isDiceCurrent(), true)
    assert.deepEqual(options.toolRegistry.builtIn, [], 'dice commands must be registered once by Core')
    assert.equal(f.g.adapter.mediaRelay, undefined)
    const raw = JSON.parse(await readFile(f.file, 'utf8')); raw.dice.enabled = false
    await writeFile(f.file, JSON.stringify(raw)); assert.equal(options.isDiceCurrent(), false)
  }
  await main(f.args)
  assert.deepEqual(f.g.events, ['redis_open', 'core_create', 'core_start', 'core_stop', 'adapter_stop', 'redis_close'])
})

for (const dice of [undefined, {}, { enabled: false }]) test(`dice startup preserves disabled authorization for ${JSON.stringify(dice)}`, async t => {
  const f = await fixture(t, dice)
  f.g.onStart = options => {
    assert.deepEqual(options.dice, { enabled: false, maxDiceCount: 100, maxDiceSides: 100_000, maxRounds: 20 })
    assert.equal(options.isDiceCurrent(), false); assert.deepEqual(options.toolRegistry.builtIn, [])
  }
  await main(f.args)
  assert.deepEqual(f.g.events, ['redis_open', 'core_create', 'core_start', 'core_stop', 'adapter_stop', 'redis_close'])
})

test('changing a dice bound revokes the loaded capability before a late action', async t => {
  const f = await fixture(t, { enabled: true })
  f.g.onStart = async options => {
    assert.equal(options.isDiceCurrent(), true)
    const raw = JSON.parse(await readFile(f.file, 'utf8')); raw.dice.maxRounds = 1
    await writeFile(f.file, JSON.stringify(raw)); assert.equal(options.isDiceCurrent(), false)
  }
  await main(f.args)
})
