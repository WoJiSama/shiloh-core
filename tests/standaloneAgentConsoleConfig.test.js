import assert from 'node:assert/strict'
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'

const { readStandaloneAgentConfig } = await importBilibiliHost('bootstrap/standaloneAgentConfig.js')
const consoleToken = 'console-config-private-token-20261117'
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-console-config-')), file = path.join(directory, 'agent-host.yaml')
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({ version: 1,
    agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: '19000911' }],
    bindings: [{ connectionId: 'main', kind: 'group', conversationId: '310911', agentId: 'daily' }] }))
  const raw = { version: 1, instance: 'console-config', dataDir: 'untouched-data',
    model: { baseUrl: 'https://main.example/v1', name: 'main-model', apiKeyEnv: 'MAIN_KEY' },
    connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }] }
  return { directory, file, async read(changes = {}, env = { MAIN_KEY: 'private-main-key' }, options) {
    await writeFile(file, JSON.stringify({ ...raw, ...changes }))
    return readStandaloneAgentConfig(file, env, options)
  } }
}
function environment(values, allowed) {
  const reads = []
  return { reads, env: new Proxy(values, { get(target, key) {
    reads.push(key); assert.ok(allowed.includes(key), `unexpected environment lookup: ${String(key)}`)
    return Reflect.get(target, key)
  } }) }
}

test('standalone console defaults off with a private dedicated user path and no credential lookup or storage writes', async t => {
  const f = await fixture(t)
  for (const changes of [{}, { console: {} }, { console: { enabled: false } }]) {
    const { env, reads } = environment({ MAIN_KEY: 'private-main-key' }, ['MAIN_KEY', 'BL_AGENT_REDIS_URL'])
    const config = await f.read(changes, env)
    assert.equal(config.console.enabled, false)
    assert.equal(config.console.host, '127.0.0.1'); assert.equal(config.console.port, 8787)
    assert.equal(config.console.userFile, path.join(f.directory, 'untouched-data', 'console', 'users.json'))
    assert.equal(path.isAbsolute(config.console.frontendDir), true)
    assert.match(config.console.frontendDir.replaceAll('\\', '/'), /\/console\/frontend\/dist$/u)
    assert.equal(config.console.tokenEnv, undefined); assert.equal(config.console.legacyUserFile, undefined)
    assert.equal(config.console.allowSetup, false); assert.equal(config.console.secureCookies, false)
    assert.ok(Object.isFrozen(config.console)); assert.deepEqual(reads, ['MAIN_KEY', 'BL_AGENT_REDIS_URL'])
  }
  await assert.rejects(lstat(path.join(f.directory, 'untouched-data')), { code: 'ENOENT' })
})

test('explicit console paths resolve against the host directory and only the declared token is read', async t => {
  const f = await fixture(t)
  const { env, reads } = environment({ MAIN_KEY: 'private-main-key', LOCAL_CONSOLE_TOKEN: consoleToken },
    ['MAIN_KEY', 'LOCAL_CONSOLE_TOKEN', 'BL_AGENT_REDIS_URL'])
  const config = await f.read({ console: { enabled: true, host: '::1', port: 19088, tokenEnv: 'LOCAL_CONSOLE_TOKEN',
    userFile: 'private/users.json', legacyUserFile: 'import/old-users.json', frontendDir: 'web/dist', allowSetup: true, secureCookies: true } }, env)
  assert.deepEqual(config.console, { enabled: true, host: '::1', port: 19088, tokenEnv: 'LOCAL_CONSOLE_TOKEN',
    userFile: path.join(f.directory, 'private/users.json'), legacyUserFile: path.join(f.directory, 'import/old-users.json'),
    frontendDir: path.join(f.directory, 'web/dist'), allowSetup: true, secureCookies: true, qqLogin: [] })
  assert.deepEqual(reads, ['MAIN_KEY', 'LOCAL_CONSOLE_TOKEN', 'BL_AGENT_REDIS_URL'])
  assert.equal(JSON.stringify(config.console).includes(consoleToken), false)
  await assert.rejects(lstat(path.join(f.directory, 'private')), { code: 'ENOENT' })
})

test('credential inspection permits a missing declared token without initializing the console user store', async t => {
  const f = await fixture(t), console = { enabled: true, tokenEnv: 'LOCAL_CONSOLE_TOKEN' }
  await assert.rejects(f.read({ console }), /控制台令牌环境变量缺失/u)
  const { env, reads } = environment({}, ['MAIN_KEY', 'LOCAL_CONSOLE_TOKEN', 'BL_AGENT_REDIS_URL'])
  const config = await f.read({ console }, env, { requireCredentials: false })
  assert.equal(config.console.enabled, true); assert.equal(config.console.tokenEnv, 'LOCAL_CONSOLE_TOKEN')
  assert.deepEqual(reads, ['MAIN_KEY', 'LOCAL_CONSOLE_TOKEN', 'BL_AGENT_REDIS_URL'])
  await assert.rejects(lstat(path.join(f.directory, 'untouched-data')), { code: 'ENOENT' })
})

test('console authentication configuration rejects invalid token names before lookup and invalid token values before startup', async t => {
  const f = await fixture(t)
  for (const tokenEnv of ['', null, 1, 'bad-name', 'lowercase', 'A'.repeat(129)]) {
    const { env, reads } = environment({ MAIN_KEY: 'private-main-key' }, ['MAIN_KEY'])
    await assert.rejects(f.read({ console: { enabled: true, tokenEnv } }, env), /console\.tokenEnv/u)
    assert.deepEqual(reads, ['MAIN_KEY']); assert.equal(reads.includes(''), false)
  }
  for (const value of ['short', ' with-leading-whitespace', 'private-key-with\nnewline', 'x'.repeat(8193)]) {
    await assert.rejects(f.read({ console: { enabled: true, tokenEnv: 'LOCAL_CONSOLE_TOKEN' } },
      { MAIN_KEY: 'main', LOCAL_CONSOLE_TOKEN: value }), /控制台令牌格式无效/u)
  }
})

test('first-user setup is allowed only on explicit loopback listeners including disabled declarations', async t => {
  const f = await fixture(t)
  for (const host of ['127.0.0.1', '::1']) {
    const config = await f.read({ console: { enabled: true, host, allowSetup: true } })
    assert.equal(config.console.allowSetup, true); assert.equal(config.console.tokenEnv, undefined)
  }
  for (const host of ['0.0.0.0', '::']) {
    for (const enabled of [false, true]) await assert.rejects(f.read({ console: { enabled, host, allowSetup: true } }), /仅允许回环地址/u)
    assert.equal((await f.read({ console: { host, allowSetup: false } })).console.host, host)
  }
})

test('console rejects unknown fields, malformed listeners, ambiguous switches and unsafe path strings', async t => {
  const f = await fixture(t)
  for (const console of [null, [], true, 'enabled', { enabled: 'true' }, { allowSetup: 1 }, { secureCookies: 'false' },
    { token: consoleToken }, { password: 'raw-password' }, { proxy: 'http://localhost' },
    ...['localhost', 'example.com', '127.0.0.2', ' 127.0.0.1'].map(host => ({ host })),
    ...[0, 65536, 1.5, '8787', null].map(port => ({ port })),
    ...['userFile', 'frontendDir', 'legacyUserFile'].flatMap(key => ['', ' ', 1, false, 'file\nname', 'x'.repeat(4097)].map(value => ({ [key]: value }))),
  ]) await assert.rejects(f.read({ console }))
  await assert.rejects(lstat(path.join(f.directory, 'untouched-data')), { code: 'ENOENT' })
})

test('changing console enablement or its credential declaration revokes the previous host snapshot', async t => {
  const f = await fixture(t), first = await f.read()
  assert.equal(first.isConfigCurrent(), true)
  const second = await f.read({ console: { enabled: true } })
  assert.equal(first.isConfigCurrent(), false); assert.equal(second.isConfigCurrent(), true)
  await f.read({ console: { enabled: true, tokenEnv: 'LOCAL_CONSOLE_TOKEN' } }, { MAIN_KEY: 'main', LOCAL_CONSOLE_TOKEN: consoleToken })
  assert.equal(second.isConfigCurrent(), false)
})

test('creating, editing and deleting the persona library revoke captured host snapshots without storage writes', async t => {
  const f = await fixture(t), file = path.join(f.directory, 'persona-library.yaml')
  const beforeCreation = await f.read(), reload = () => readStandaloneAgentConfig(f.file, { MAIN_KEY: 'private-main-key' })
  assert.equal(beforeCreation.isConfigCurrent(), true)
  await assert.rejects(lstat(file), { code: 'ENOENT' })
  await writeFile(file, JSON.stringify({ personas: [{ id: 'fixture', name: '合成人设', tone: '原始语气' }] }))
  assert.equal(beforeCreation.isConfigCurrent(), false)
  const beforeEdit = reload(); assert.equal(beforeEdit.isConfigCurrent(), true)
  await writeFile(file, JSON.stringify({ personas: [{ id: 'fixture', name: '合成人设', tone: '修改后的语气' }] }))
  assert.equal(beforeEdit.isConfigCurrent(), false)
  const beforeDelete = reload(); assert.equal(beforeDelete.isConfigCurrent(), true)
  await rm(file)
  assert.equal(beforeDelete.isConfigCurrent(), false)
  assert.equal(reload().isConfigCurrent(), true)
  await assert.rejects(lstat(path.join(f.directory, 'untouched-data')), { code: 'ENOENT' })
})
