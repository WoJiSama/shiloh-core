import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import YAML from 'yaml'

// This suite deliberately loads source main, never a previously built release.
const previousSourceTest = process.env.BL_CHAT_AGENT_SOURCE_TEST
process.env.BL_CHAT_AGENT_SOURCE_TEST = '1'
const { importBilibiliHost } = await import('./helpers/bilibiliQualitySource.mjs')
if (previousSourceTest === undefined) delete process.env.BL_CHAT_AGENT_SOURCE_TEST
else process.env.BL_CHAT_AGENT_SOURCE_TEST = previousSourceTest

const key = Symbol.for('bl-chat-test.dice-engine-startup'), state = 'globalThis[Symbol.for("bl-chat-test.dice-engine-startup")]'
registerHooks({ load(url, context, next) {
  if (/\/src\/core\/index\.ts$/u.test(url)) return { format: 'module', shortCircuit: true,
    source: `export function createAgentRuntime(options) { const g = ${state}; g.core = options; g.events.push('core_create'); return {
      runtime: { async runAdministration(_guard, run) { return run() } },
      async start() { g.events.push('core_start'); await g.onStart(options); process.emit('SIGTERM') },
      async stop() { g.events.push('core_stop') } } }` }
  if (/\/modules\/runtime\/infrastructure\/agentRedis\.ts$/u.test(url)) return { format: 'module', shortCircuit: true,
    source: `function unexpected(method) { const g = ${state}; g.storageCalls.push(method); throw Error('startup must not access dice state: ' + method) }
      const storage = Object.fromEntries(['get', 'mGet', 'set', 'del', 'eval'].map(method => [method, async () => unexpected(method)]));
      export function agentRedisPrefix(instance) { return 'bl-agent:' + instance + ':' }
      export async function connectAgentRedis() { const g = ${state}; g.events.push('redis_check'); return { ...storage,
        async ping() { return 'PONG' }, async close() { g.events.push('redis_check_close') } } }
      export async function openAgentRedis() { const g = ${state}; g.events.push('redis_open'); return {
        storage, isCurrent: () => g.redisCurrent, async close() { g.events.push('redis_close') } } }` }
  // Keep the real persistence/epoch implementation; replace only HTTP/auth I/O.
  if (/\/bootstrap\/standaloneAgentConsole\.ts$/u.test(url)) return { format: 'module', shortCircuit: true,
    source: `export function createStandaloneAgentConsole(options) { const g = ${state}; g.console = options; return {
      async listen() { g.events.push('console_listen') }, async close() { g.events.push('console_close') } } }` }
  if (/\/bootstrap\/standaloneAgentConsoleAuth\.ts$/u.test(url)) return { format: 'module', shortCircuit: true,
    source: `export async function openStandaloneAgentConsoleAuth() { const g = ${state}; g.events.push('console_auth'); return {
      async authorize() { return 'allowed' }, isCurrent: () => true, async close() { g.events.push('console_auth_close') } } }` }
  const result = next(url, context), source = typeof result.source === 'string' ? result.source : Buffer.from(result.source ?? '').toString()
  if (/\/modules\/dice\/infrastructure\/agentDiceScriptProcess\.ts$/u.test(url)) {
    const names = ['executeAgentDiceScript', 'executeAgentDiceScriptSync', 'executeDarwinAgentDiceScriptDiagnostic', 'executeDarwinAgentDiceScriptDiagnosticSync']
    let captured = source
    for (const name of names) {
      const declaration = new RegExp('export (async )?function ' + name + '\\(')
      assert.match(captured, declaration)
      captured = captured.replace(declaration, (_match, async = '') => `${async}function original_${name}(`)
    }
    return { ...result, source: captured + names.map(name => `\nexport function ${name}() {
      ${state}.scriptCalls.push('${name}'); throw Error('standalone YAML must not run executable rules') }`).join('') }
  }
  if (!/\/adapters\/oneBotConnection\.ts$/u.test(url)) return result
  assert.ok(source.includes('export function createOneBotConnection('))
  assert.ok(source.includes('export async function verifyOneBotLogin('))
  return { ...result, source: source.replace('export function createOneBotConnection(', 'function realCreateOneBotConnection(')
    .replace('export async function verifyOneBotLogin(', 'async function realVerifyOneBotLogin(') + `
      export function createOneBotConnection(options) { const g = ${state}; g.adapter = options; g.events.push('adapter_create');
        const send = async () => { g.nativeCalls.push('send'); throw Error('startup must not send native messages') };
        return { account: options.connection.account, isReady: () => true, actions: { send, sendDicePrivate: send },
          stop() { g.events.push('adapter_stop') } } }
      export async function verifyOneBotLogin() { ${state}.events.push('verify_onebot') }` }
} })

const { main } = await importBilibiliHost('bootstrap/standaloneAgent.js')
const { readStandaloneAgentConfig } = await importBilibiliHost('bootstrap/standaloneAgentConfig.js')
const { createAgentBindingConfig } = await importBilibiliHost('modules/runtime/infrastructure/agentBindingConfig.js')
const settings = { timeout: 15_000 }, account = { platform: 'qq', namespace: 'global', id: '123456001' }
const target = { account, kind: 'group', id: '90001' }, actorId = '10001', subjectId = '10002'
const modelKeyName = 'DICE_ENGINE_STARTUP_MODEL_KEY', modelKey = 'DICE_ENGINE_STARTUP_PRIVATE_123456'
const bounds = { enabled: true, maxDiceCount: 30, maxDiceSides: 1000, maxRounds: 4 }
const sha = value => createHash('sha256').update(value).digest('hex')
const clone = value => structuredClone(value)
const guard = (extra = {}) => ({ signal: new AbortController().signal, isCurrent: () => true, ensureCurrent: async () => {}, ...extra })
function source(binding, sender = actorId) {
  return { version: 1, conversation: clone(binding.target), sender: { ...binding.target.account, id: sender },
    senderName: 'Untrusted native administrator label', messageId: '190001', occurredAt: 1_800_000_000_000,
    text: '.r 1d20', parts: [{ kind: 'text', text: '.r 1d20' }], mentions: [], directedToAccount: false, binding: clone(binding) }
}
function frozen(value) {
  if (!value || typeof value !== 'object') return
  assert.equal(Object.isFrozen(value), true)
  for (const child of Object.values(value)) frozen(child)
}
async function fixture(t, dice, consoleEnabled = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-dice-engine-startup-'))
  const file = path.join(directory, 'agent-host.yaml'), bindingsFile = path.join(directory, 'agent-bindings.yaml'), dataDir = path.join(directory, 'data')
  const previous = process.env[modelKeyName]; process.env[modelKeyName] = modelKey
  const g = { events: [], nativeCalls: [], scriptCalls: [], storageCalls: [], redisCurrent: true, onStart() {} }; globalThis[key] = g
  t.after(async () => {
    if (previous === undefined) delete process.env[modelKeyName]; else process.env[modelKeyName] = previous
    delete globalThis[key]
    await rm(directory, { recursive: true, force: true })
  })
  const bindings = { version: 1, agents: [{ id: 'daily', personaId: 'default' }, { id: 'other', personaId: 'default' }],
    connections: [{ id: 'main', platform: account.platform, namespace: account.namespace, accountId: account.id }], bindings: [
      { connectionId: 'main', kind: 'group', conversationId: target.id, agentId: 'daily' },
      { connectionId: 'main', kind: 'group', conversationId: '90002', agentId: 'other' },
    ] }
  await writeFile(bindingsFile, YAML.stringify(bindings))
  const raw = { version: 1, instance: 'dice-engine-startup', dataDir,
    model: { baseUrl: 'https://model.example/v1', name: 'main', apiKeyEnv: modelKeyName },
    connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }],
    forbiddenWords: { enabled: true, blockOutput: true, words: ['STARTUP_BLOCKED_WORD'] },
    ...(consoleEnabled ? { console: { enabled: true } } : {}), ...(dice === undefined ? {} : { dice }) }
  await writeFile(file, YAML.stringify(raw))
  return { g, file, bindingsFile, directory, dataDir, args: ['--config', file],
    async update(change) { const raw = YAML.parse(await readFile(file, 'utf8')); change(raw); await writeFile(file, YAML.stringify(raw)) },
    noEffects() { assert.deepEqual(g.nativeCalls, []); assert.deepEqual(g.scriptCalls, []); assert.deepEqual(g.storageCalls, []) },
  }
}
async function engineFixture(t, consoleEnabled = false) {
  const f = await fixture(t, bounds, consoleEnabled)
  // Capture a real full binding before inserting grants. Only the host YAML changes.
  const initial = readStandaloneAgentConfig(f.file, process.env), binding = clone(initial.resolvePersona(target).binding)
  const bindingsRaw = await readFile(f.bindingsFile, 'utf8')
  const pack = { version: 1, id: 'startup-rules', name: 'Startup YAML', aliases: ['startup'],
    character: { fields: { hp: { type: 'integer', default: 12, min: 0, max: 20 } } },
    commands: [{ id: 'hello', aliases: ['hello'], output: 'YAML reached startup.' }] }
  const yaml = YAML.stringify(pack), rulePackage = { kind: 'yaml', source: yaml, sourceHash: sha(yaml), revision: 'startup-rules-one' }
  const grant = { binding: clone(binding), revision: 'startup-grant-one', actorId, permissions: ['player', 'gm', 'delegate', 'hidden', 'card'],
    subjects: [{ id: subjectId, permissions: ['player', 'gm'] }] }
  await f.update(raw => { raw.dice.engine = { enabled: true, revision: 'startup-engine-one', deliveryTimeoutMs: 1000,
    builtin: { allowHiddenRoll: true }, rulePackages: [rulePackage], grants: [grant] } })
  const configured = readStandaloneAgentConfig(f.file, process.env)
  assert.equal(await readFile(f.bindingsFile, 'utf8'), bindingsRaw)
  assert.deepEqual(configured.resolvePersona(target).binding, binding, 'writing host grants must not change the untouched binding revision')
  assert.deepEqual(createAgentBindingConfig(f.bindingsFile)().resolve(target), binding,
    'source-snapshot and live binding readers must agree on the complete revision')
  assert.deepEqual(configured.diceEngineConfig.grants[0].binding, binding)
  return { ...f, binding, bindingsRaw, grant, rulePackage, request: () => ({ binding: clone(binding), source: source(binding) }) }
}

test('source main injects compiled pure YAML and explicit full-binding actor/subject grants into Core', settings, async t => {
  const f = await engineFixture(t)
  f.g.onStart = async options => {
    assert.deepEqual(options.dice, bounds); frozen(options.dice)
    assert.equal(options.isDiceCurrent(), true)
    assert.deepEqual(options.resolvePersona(target).binding, f.binding)
    const engine = options.diceEngine; frozen(engine)
    assert.equal(engine.enabled, true); assert.equal(engine.revision, 'startup-engine-one'); assert.equal(engine.deliveryTimeoutMs, 1000)
    assert.deepEqual(engine.builtin, { maxDiceCount: 30, maxDiceSides: 1000, maxRounds: 4, allowHiddenRoll: true })
    assert.equal(engine.rulePackages.length, 1)
    const compiled = engine.rulePackages[0]
    assert.equal(compiled.kind, 'yaml'); assert.equal(compiled.id, 'startup-rules'); assert.equal(compiled.source, f.rulePackage.source)
    assert.equal(compiled.sourceHash, f.rulePackage.sourceHash); assert.equal(compiled.revision, f.rulePackage.revision)
    assert.equal(compiled.pack.character.fields.hp.default, 12)
    assert.equal(await compiled.instantiate(() => assert.fail('pure YAML startup must not draw entropy'), 1), compiled.pack)
    assert.equal(Object.hasOwn(engine, 'grants'), false)
    const granted = await options.readDiceGrant(f.request(), guard()); assert.deepEqual(granted, f.grant); frozen(granted)
    assert.equal(await options.readDiceGrant({ binding: f.binding, source: source(f.binding, subjectId) }, guard()), undefined,
      'a named subject does not receive an implicit actor grant')
    const otherBinding = options.resolvePersona({ ...target, id: '90002' }).binding
    assert.equal(await options.readDiceGrant({ binding: otherBinding, source: source(otherBinding) }, guard()), undefined)
    const stale = f.request(); stale.binding.revision = 'different-binding-revision'
    assert.equal(await options.readDiceGrant(stale, guard()), undefined)
    assert.deepEqual(options.toolRegistry.builtIn, [], 'main must not separately register duplicate dice tools')
    assert.equal(f.g.adapter.dicePrivate.allowsText('private dice result'), true)
    for (const text of [modelKey, Buffer.from(modelKey).toString('base64'), 'contains STARTUP_BLOCKED_WORD']) {
      assert.equal(f.g.adapter.dicePrivate.allowsText(text), false, text)
    }
    f.noEffects()
  }
  await main(f.args)
  assert.equal(await f.g.core.readDiceGrant(f.request(), guard()), undefined, 'stopping the host retires captured grants')
  assert.equal(await readFile(f.bindingsFile, 'utf8'), f.bindingsRaw); f.noEffects()
})

for (const [label, dice, expected, engineEnabled] of [
  ['default disabled dice', undefined, { enabled: false, maxDiceCount: 100, maxDiceSides: 100_000, maxRounds: 20 }, undefined],
  ['legacy expressions without dice.engine', bounds, bounds, undefined],
  ['an explicitly disabled replacement engine', { ...bounds, engine: { enabled: false } }, bounds, false],
]) test(`source main preserves ${label} without inventing grants`, settings, async t => {
  const f = await fixture(t, dice)
  f.g.onStart = async options => {
    assert.deepEqual(options.dice, expected); frozen(options.dice)
    assert.equal(options.isDiceCurrent(), expected.enabled)
    assert.equal(options.diceEngine?.enabled, engineEnabled)
    assert.equal(await options.readDiceGrant({ binding: options.resolvePersona(target).binding,
      source: source(options.resolvePersona(target).binding) }, guard()), undefined)
    assert.deepEqual(options.toolRegistry.builtIn, []); f.noEffects()
  }
  await main(f.args); f.noEffects()
})

for (const grants of [undefined, []]) test(`source main rejects enabled dice.engine with ${grants === undefined ? 'missing' : 'empty'} grants before I/O`, settings, async t => {
  const f = await fixture(t, { ...bounds, engine: { enabled: true, ...(grants === undefined ? {} : { grants }) } })
  for (const extra of [[], ['--check']]) await assert.rejects(main([...f.args, ...extra]), /骰子/u)
  assert.deepEqual(f.g.events, []); f.noEffects(); await assert.rejects(lstat(f.dataDir), { code: 'ENOENT' })
})

test('source main check validates an enabled YAML engine without state writes, native sends or startup', settings, async t => {
  const f = await engineFixture(t), host = await readFile(f.file, 'utf8'), names = (await readdir(f.directory)).sort()
  await main([...f.args, '--check'])
  assert.deepEqual(f.g.events, ['redis_check', 'redis_check_close', 'verify_onebot'])
  assert.equal(f.g.core, undefined); assert.equal(f.g.adapter, undefined)
  f.noEffects(); await assert.rejects(lstat(f.dataDir), { code: 'ENOENT' })
  assert.equal(await readFile(f.file, 'utf8'), host); assert.equal(await readFile(f.bindingsFile, 'utf8'), f.bindingsRaw)
  assert.deepEqual((await readdir(f.directory)).sort(), names)
})

for (const duringLookup of [false, true]) test(`source main revokes grants when YAML changes ${duringLookup ? 'during an awaited grant check' : 'before a late grant check'}`, settings, async t => {
  const f = await engineFixture(t)
  f.g.onStart = async options => {
    assert.deepEqual(await options.readDiceGrant(f.request(), guard()), f.grant)
    const revoke = () => f.update(raw => { raw.dice.engine.grants = [] })
    if (!duringLookup) await revoke()
    assert.equal(await options.readDiceGrant(f.request(), guard(duringLookup ? { ensureCurrent: revoke } : {})), undefined)
    assert.equal(options.isDiceCurrent(), false); assert.equal(options.signal.aborted, false); assert.equal(f.g.redisCurrent, true)
    assert.equal(await options.readDiceGrant(f.request(), guard()), undefined); f.noEffects()
  }
  await main(f.args)
})

test('source main binds grants to the real console execution epoch and cannot revive a retired epoch', settings, async t => {
  const f = await engineFixture(t, true)
  f.g.onStart = async options => {
    const execution = f.g.console.execution
    assert.ok(execution.processEpoch); assert.equal(execution.signal, options.signal); assert.equal(execution.isCurrent(), true)
    assert.deepEqual(await options.readDiceGrant(f.request(), guard()), f.grant)
    f.g.redisCurrent = false
    assert.equal(execution.isCurrent(), false); assert.equal(options.signal.aborted, true)
    assert.equal(await options.readDiceGrant(f.request(), guard()), undefined)
    f.g.redisCurrent = true
    assert.equal(readStandaloneAgentConfig(f.file, process.env).isConfigCurrent(), true, 'the on-disk configuration remains current')
    assert.equal(execution.isCurrent(), false); assert.equal(options.isDiceCurrent(), false)
    assert.equal(await options.readDiceGrant(f.request(), guard()), undefined, 'fresh lease availability cannot revive an old epoch')
    f.noEffects()
  }
  await main(f.args)
  assert.ok(f.g.events.includes('console_listen')); f.noEffects()
})

for (const kind of ['js', 'seal']) test(`source main rejects ${kind} rule configuration before compiling or starting a host`, settings, async t => {
  const f = await engineFixture(t)
  const executable = kind === 'js' ? 'module.exports = { version: 1, id: "startup-js" }' : 'const extension = seal.ext.new("startup-seal", "fixture", "1"); seal.ext.register(extension)'
  await f.update(raw => { raw.dice.engine.rulePackages = [{ kind, source: executable, sourceHash: sha(executable), revision: 'executable-one' }] })
  for (const extra of [[], ['--check']]) await assert.rejects(main([...f.args, ...extra]), /骰子/u)
  assert.deepEqual(f.g.events, []); f.noEffects(); await assert.rejects(lstat(f.dataDir), { code: 'ENOENT' })
})
