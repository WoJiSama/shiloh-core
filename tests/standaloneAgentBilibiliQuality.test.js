import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'

const { readStandaloneBilibiliQualityConfig: read, openStandaloneBilibiliAuth } = await importBilibiliHost('bootstrap/standaloneBilibiliQuality.js')
const { readStandaloneAgentConfig } = await importBilibiliHost('bootstrap/standaloneAgentConfig.js')
const account = { platform: 'qq', namespace: 'global', id: '123456001' }, master = { ...account, id: '123456002' }, user = { ...account, id: '123456003' }
const connections = [{ id: 'main', account }], target = { account, kind: 'group', id: '90001' }
const config = (changes = {}) => ({ enabled: true, masters: [{ ...master }], whitelist: [{ target: structuredClone(target), users: [{ ...user }] }], ...changes })
const binding = (changes = {}) => ({ source: 'configured', id: 'binding-one', revision: 'revision-one', agentId: 'daily', personaId: 'default', connectionId: 'main', target, ...changes })
const context = () => ({ signal: new AbortController().signal, isCurrent: () => true })
const vaultFor = (directory, instance) => path.join(directory, `.agent-bilibili-auth-${createHash('sha256').update(instance).digest('hex').slice(0, 32)}`)
async function directory(t) { const result = await realpath(await mkdtemp(path.join(tmpdir(), 'standalone-bilibili-quality-'))); t.after(() => rm(result, { recursive: true, force: true })); return result }
const bridge = (port = 31487) => ({ connectionId: 'main', listen: { host: '127.0.0.1', port }, advertisedOrigin: `http://127.0.0.1:${port}`, allowedPeers: ['127.0.0.1'] })
async function fixture(t) {
  const root = await directory(t), file = path.join(root, 'agent-host.yaml')
  await writeFile(path.join(root, 'agent-bindings.yaml'), JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: account.id }], bindings: [{ connectionId: 'main', kind: 'group', conversationId: target.id, agentId: 'daily' }] }))
  const raw = { version: 1, instance: 'bilibili-quality-host', dataDir: 'untouched-data', model: { baseUrl: 'https://main.example/v1', name: 'main-model', apiKeyEnv: 'MAIN_KEY' },
    connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }], mediaRelay: { enabled: false, bilibili: { cookieEnv: 'BILI_COOKIE' }, bridges: [bridge()] }, bilibiliQuality: config() }
  const env = { MAIN_KEY: 'PRIVATE_MODEL_KEY' }; Object.defineProperty(env, 'BILI_COOKIE', { get() { throw Error('disabled automatic cookie was read') } })
  return { root, file, raw, env, async read(changes = {}) { await writeFile(file, JSON.stringify({ ...raw, ...changes })); return readStandaloneAgentConfig(file, env) } }
}

test('HQ configuration defaults off, owns frozen full identities and rejects unknown account scopes without invoking accessors', () => {
  assert.deepEqual(read(undefined, connections), { enabled: false, masters: [], whitelist: [] })
  const raw = config(), result = read(raw, connections); raw.masters[0].id = 'changed'; raw.whitelist[0].users[0].id = 'changed'
  assert.equal(result.masters[0].id, '123456002'); assert.equal(result.whitelist[0].users[0].id, '123456003')
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.masters)); assert.ok(Object.isFrozen(result.whitelist[0].target.account))
  let touched = false
  for (const invalid of [null, [], {}, { enabled: true }, config({ masters: ['123456002'] }), config({ cookieEnv: 'COOKIE' }), config({ masters: [master, master] }),
    config({ whitelist: [{ target: { ...target, account: { ...account, id: '123456999' } }, users: [] }] }),
    { get enabled() { touched = true; return true }, masters: [] }, new Proxy({}, { ownKeys() { touched = true; throw Error('trap') } })]) assert.throws(() => read(invalid, connections))
  assert.equal(touched, false)
})

test('HQ-only configuration requires every bridge but parses without cookie reads, directories, or authorization traffic', async t => {
  const f = await fixture(t), result = await f.read()
  assert.equal(result.bilibiliQuality.enabled, true); assert.equal(result.mediaRelay.enabled, false); assert.equal(result.mediaRelay.bilibili.authCookie, undefined)
  assert.equal(result.isConfigCurrent(), true); await assert.rejects(lstat(path.join(f.root, 'untouched-data')), { code: 'ENOENT' })
  await assert.rejects(f.read({ mediaRelay: { enabled: false } }), /bilibiliQuality.*mediaRelay.bridges/u)
  const disabled = await f.read({ bilibiliQuality: config({ enabled: false }), mediaRelay: { enabled: false, bilibili: { cookieEnv: 'BILI_COOKIE' } } })
  assert.equal(disabled.bilibiliQuality.enabled, false); assert.equal(result.isConfigCurrent(), false)
  await assert.rejects(lstat(path.join(f.root, 'untouched-data')), { code: 'ENOENT' })
})

test('HQ-only bridges participate in torrent and group log listener collision checks', async t => {
  const f = await fixture(t)
  await assert.rejects(f.read({ torrentDownload: { enabled: true, bridges: [bridge()] } }), /不同监听地址/u)
  await assert.rejects(f.read({ groupLog: { enabled: true, bridges: [bridge()] } }), /独立监听端口/u)
  assert.equal((await f.read({ torrentDownload: { enabled: true, bridges: [bridge(31488)] }, groupLog: { enabled: true, bridges: [bridge(31489)] } })).bilibiliQuality.enabled, true)
})

test('only leased enabled auth creates missing data, while linked or writable data parents cannot hold credentials', async t => {
  const root = await directory(t), missing = path.join(root, 'missing'), options = { config: config(), dataDir: missing, instance: 'host', isLeaseCurrent: () => true, registerSecrets() {} }
  assert.equal(await openStandaloneBilibiliAuth({ ...options, config: config({ enabled: false }), isLeaseCurrent() { throw Error('disabled lease was read') } }), undefined)
  await assert.rejects(lstat(missing), { code: 'ENOENT' })
  await assert.rejects(openStandaloneBilibiliAuth({ ...options, isLeaseCurrent: () => false })); await assert.rejects(lstat(missing), { code: 'ENOENT' })
  const service = await openStandaloneBilibiliAuth(options); await service.close()
  assert.equal((await lstat(missing)).mode & 0o7777, 0o700); assert.equal((await lstat(vaultFor(missing, 'host'))).mode & 0o7777, 0o700)
  const parent = path.join(root, 'data'); await mkdir(parent, { mode: 0o700 })
  await assert.rejects(openStandaloneBilibiliAuth({ ...options, dataDir: parent, isLeaseCurrent: () => false })); assert.deepEqual(await readdir(parent), [])
  await chmod(parent, 0o777); await assert.rejects(openStandaloneBilibiliAuth({ ...options, dataDir: parent })); assert.deepEqual(await readdir(parent), [])
  await chmod(parent, 0o700); const alias = path.join(root, 'linked'); await symlink(parent, alias)
  await assert.rejects(openStandaloneBilibiliAuth({ ...options, dataDir: alias })); assert.deepEqual(await readdir(parent), [])
})

test('leased auth survives reopen in its private persistent instance vault and registers loaded secrets dynamically without network', async t => {
  const root = await directory(t), secrets = [], options = { config: config(), dataDir: root, instance: 'persistent-host', isLeaseCurrent: () => true,
    registerSecrets: values => secrets.push(...values), lookup() { assert.fail('vault open/read must not resolve DNS') }, request() { assert.fail('vault open/read must not request HTTP') } }
  const owner = JSON.stringify(['qq', 'global', account.id, 'daily']), cookie = 'SESSDATA=PRIVATE_SESSION_0123456789; bili_jct=0123456789abcdef0123456789abcdef; DedeUserID=123456789'
  let service = await openStandaloneBilibiliAuth(options); await service.close()
  const vault = vaultFor(root, options.instance); assert.equal((await lstat(vault)).mode & 0o7777, 0o700)
  await writeFile(path.join(vault, createHash('sha256').update(owner).digest('hex') + '.json'), JSON.stringify({ version: 1, owner, cookie, updatedAt: 1234 }) + '\n', { mode: 0o600 })
  service = await openStandaloneBilibiliAuth(options); t.after(() => service.close())
  assert.equal(await service.credential(binding(), context()), cookie); assert.ok(secrets.includes(cookie)); assert.ok(secrets.includes('PRIVATE_SESSION_0123456789'))
  assert.deepEqual(await service.status(binding({ agentId: 'another' }), context()), { authorized: false })
  const other = await openStandaloneBilibiliAuth({ ...options, instance: 'another-instance' }); t.after(() => other.close())
  assert.deepEqual(await other.status(binding(), context()), { authorized: false }); assert.notEqual(vault, vaultFor(root, 'another-instance'))
  await service.close(); assert.equal((await readdir(vault)).length, 1)
})
