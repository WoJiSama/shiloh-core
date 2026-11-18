import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { importBilibiliHost } from './helpers/bilibiliQualitySource.mjs'

const defaultTools = {
  qqActions: {
    qzone: { enabled: false }, gift: { enabled: false },
    redPackets: { enabled: false, allowExplicit: false, allowRecentSearch: false, allowReferenceFallback: false,
      allowPasswordSend: false, recentLimit: 100, automatic: { enabled: false, toolConfigured: false, allowPasswordSend: false } },
  },
  deferredActions: { enabled: false, rules: [], migrationApprovals: [] },
}

const { readStandalonePixivToolsConfig, standalonePixivToolsSecrets } = await importBilibiliHost('bootstrap/standalonePixiv.js')
const { readStandaloneAgentConfig } = await importBilibiliHost('bootstrap/standaloneAgentConfig.js')
const cookie = 'PHPSESSID=PIXIV_TOOLS_PRIVATE_SESSION==; __Secure-device=PIXIV_TOOLS_PRIVATE_DEVICE'
const proxyUrl = 'socks5h://proxy-user:PIXIV_TOOLS_P%40SS@127.0.0.1:1080'
const declaration = { enabled: true, cookieEnv: 'PIXIV_TOOLS_COOKIE', proxyEnv: 'PIXIV_TOOLS_PROXY' }
const bridge = (id = 'main', port = 31481) => ({ connectionId: id, listen: { host: '127.0.0.1', port }, advertisedOrigin: `http://127.0.0.1:${port}`, allowedPeers: ['127.0.0.1'] })

test('Pixiv tools default off, remain separate from automatic relay, and never read disabled environment references', () => {
  assert.deepEqual(readStandalonePixivToolsConfig(undefined, {}), { enabled: false, allowRestricted: false })
  const env = {}
  for (const name of ['PIXIV_TOOLS_COOKIE', 'PIXIV_TOOLS_PROXY']) Object.defineProperty(env, name, { get() { throw Error('disabled credential read') } })
  const disabled = readStandalonePixivToolsConfig({ ...declaration, enabled: false, allowRestricted: true }, env)
  assert.deepEqual(disabled, { enabled: false, allowRestricted: true }); assert.ok(Object.isFrozen(disabled))
  assert.deepEqual(standalonePixivToolsSecrets(disabled), [])
  const anonymous = readStandalonePixivToolsConfig({ enabled: true }, {})
  assert.deepEqual(anonymous, { enabled: true, allowRestricted: false }); assert.ok(Object.isFrozen(anonymous))
})

test('Pixiv tools resolve environment credentials with shared cookie grammar and explicit restricted opt-in', () => {
  const config = readStandalonePixivToolsConfig({ ...declaration, allowRestricted: true }, { PIXIV_TOOLS_COOKIE: `Cookie: ${cookie};`, PIXIV_TOOLS_PROXY: proxyUrl })
  assert.deepEqual(config, { enabled: true, allowRestricted: true, authCookie: `${cookie};`, proxyUrl }); assert.ok(Object.isFrozen(config))
  const secrets = standalonePixivToolsSecrets(config)
  for (const value of [`${cookie};`, 'PIXIV_TOOLS_PRIVATE_SESSION==', 'PIXIV_TOOLS_PRIVATE_DEVICE', proxyUrl, 'proxy-user', 'PIXIV_TOOLS_P%40SS', 'PIXIV_TOOLS_P@SS']) assert.ok(secrets.includes(value), value)
  assert.equal(new Set(secrets).size, secrets.length)
  for (const [field, name] of [['cookieEnv', 'PIXIV_TOOLS_COOKIE'], ['proxyEnv', 'PIXIV_TOOLS_PROXY']]) {
    const input = { enabled: true, [field]: name }
    assert.throws(() => readStandalonePixivToolsConfig(input, {}), new RegExp(`${name}.*Pixiv`))
    assert.deepEqual(readStandalonePixivToolsConfig(input, {}, false), { enabled: true, allowRestricted: false })
  }
})

test('Pixiv tools reject unsupported fields, ambiguous declarations and accessors without invoking behavior', () => {
  for (const input of [null, [], false, {}, { enabled: 'true' }, { enabled: true, allowRestricted: 'true' },
    { enabled: true, cookie: cookie }, { enabled: true, authCookie: cookie }, { enabled: true, proxyUrl },
    { enabled: true, endpoint: 'https://other.invalid' }, { enabled: true, apiKeyEnv: 'KEY' },
    { enabled: true, browser: '/path/to/browser' }, { enabled: true, directory: '/tmp/media' },
    { enabled: true, cookieEnv: 'bad-name' }, { enabled: false, cookieEnv: '' }, { enabled: false, proxyEnv: 'bad-name' },
    Object.assign(Object.create({ inherited: true }), { enabled: true }), { enabled: true, [Symbol('secret')]: 'value' }]) assert.throws(() => readStandalonePixivToolsConfig(input, {}))
  let touched = 0
  for (const key of ['enabled', 'allowRestricted', 'cookieEnv', 'proxyEnv']) {
    const input = Object.defineProperty({ enabled: true }, key, { enumerable: true, get() { touched++; return true } })
    assert.throws(() => readStandalonePixivToolsConfig(input, {}))
  }
  assert.equal(touched, 0)
})

test('Pixiv tools share strict RFC cookie and bounded host-proxy validation in normal and preview reads', () => {
  for (const cookieValue of ['invalid-cookie', 'PHPSESSID=', 'PHPSESSID=one; PHPSESSID=two', 'PHPSESSID=has space',
    'PHPSESSID=private\r\nInjected: 1', 'PHPSESSID=中文', 'PHPSESSID=' + 'x'.repeat(32769)]) {
    for (const requireCredentials of [true, false]) assert.throws(() => readStandalonePixivToolsConfig({ enabled: true, cookieEnv: 'COOKIE' }, { COOKIE: cookieValue }, requireCredentials))
  }
  for (const value of ['http://127.0.0.1:7890', 'https://proxy.example:8443', 'socks5://127.0.0.1:1080', proxyUrl]) {
    assert.equal(readStandalonePixivToolsConfig({ enabled: true, proxyEnv: 'PROXY' }, { PROXY: value }).proxyUrl, value)
  }
  for (const value of ['file:///tmp/proxy', 'ftp://proxy.example', 'http://proxy.example/path', 'http://proxy.example?secret=value',
    'http://proxy.example#fragment', 'http://proxy.example?', 'http://proxy.example#', 'http://proxy.example\\other',
    'http://user:bad%0apassword@proxy.example', 'http://user:bad%zzpassword@proxy.example', `http://${'a'.repeat(2050)}`]) {
    assert.throws(() => readStandalonePixivToolsConfig({ enabled: true, proxyEnv: 'PROXY' }, { PROXY: value }))
  }
})

function hostFixture(t, count = 1) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-pixiv-tools-config-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const connections = Array.from({ length: count }, (_, index) => ({ id: index ? `extra${index}` : 'main', platform: 'qq', namespace: 'global', accountId: String(123456001 + index) }))
  fs.writeFileSync(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({ version: 1, agents: [{ id: 'daily', personaId: 'default' }], connections,
    bindings: connections.map(connection => ({ connectionId: connection.id, kind: 'group', conversationId: '90001', agentId: 'daily' })) }))
  const file = path.join(directory, 'agent-host.yaml')
  const read = (overrides = {}, env = {}, requireCredentials = true) => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, instance: 'pixiv-tools-config', model: { baseUrl: 'https://main.example/v1', name: 'main-model', apiKeyEnv: 'MAIN_KEY' },
      connections: connections.map((connection, index) => ({ id: connection.id, url: `ws://127.0.0.1:${3001 + index}` })), ...overrides }))
    return readStandaloneAgentConfig(file, Object.defineProperties({ MAIN_KEY: 'main-key' }, Object.getOwnPropertyDescriptors(env)), { requireCredentials })
  }
  return { read, directory }
}

test('host Pixiv tools require all connection bridges while automatic relay can stay disabled', t => {
  const { read } = hostFixture(t, 2)
  assert.deepEqual(read().tools, defaultTools)
  const env = Object.defineProperty({}, 'PIXIV_TOOLS_COOKIE', { get() { throw Error('disabled cookie read') } })
  assert.deepEqual(read({ tools: { pixiv: { enabled: false, cookieEnv: 'PIXIV_TOOLS_COOKIE' } } }, env).tools, defaultTools)
  const tools = { pixiv: { enabled: true } }, bridges = [bridge(), bridge('extra1', 31482)]
  for (const mediaRelay of [undefined, { enabled: false }, { enabled: false, bridges: [bridge()] }]) {
    assert.throws(() => read({ tools, ...(mediaRelay ? { mediaRelay } : {}) }), /tools\.pixiv.*mediaRelay\.bridges/u)
    assert.throws(() => read({ tools, ...(mediaRelay ? { mediaRelay } : {}) }, {}, false), /tools\.pixiv.*mediaRelay\.bridges/u)
  }
  const config = read({ tools, mediaRelay: { enabled: false, bridges } })
  assert.equal(config.mediaRelay.enabled, false); assert.deepEqual(config.tools.pixiv, { enabled: true, allowRestricted: false })
  assert.deepEqual(config.mediaRelay.bridges, bridges); assert.equal(config.mediaRelay.pixiv, undefined)
  assert.equal(read({ tools, mediaRelay: { enabled: true, bridges } }).mediaRelay.enabled, true)
})

test('host normal/check-style reads reject missing explicit Pixiv credentials while preview can inspect declarations', t => {
  const { read } = hostFixture(t)
  const config = { tools: { pixiv: declaration }, mediaRelay: { enabled: false, bridges: [bridge()] } }
  assert.throws(() => read(config), /PIXIV_TOOLS_COOKIE.*Pixiv Cookie/u)
  assert.throws(() => read(config, { PIXIV_TOOLS_COOKIE: cookie }), /PIXIV_TOOLS_PROXY.*Pixiv 代理/u)
  const preview = read(config, {}, false)
  assert.deepEqual(preview.tools.pixiv, { enabled: true, allowRestricted: false }); assert.equal(preview.mediaRelay.enabled, false)
  const live = read(config, { PIXIV_TOOLS_COOKIE: cookie, PIXIV_TOOLS_PROXY: proxyUrl })
  assert.deepEqual(live.tools.pixiv, { enabled: true, allowRestricted: false, authCookie: cookie, proxyUrl })
})

test('tool-only Pixiv resource bridges cannot collide with active torrent listeners', t => {
  const { read } = hostFixture(t)
  const config = { tools: { pixiv: { enabled: true } }, mediaRelay: { enabled: false, bridges: [bridge()] },
    torrentDownload: { enabled: true, bridges: [bridge()] } }
  assert.throws(() => read(config), /不同监听地址/u)
  assert.throws(() => read(config, {}, false), /不同监听地址/u)
  const separate = { ...config, torrentDownload: { enabled: true, bridges: [bridge('main', 31483)] } }
  assert.equal(read(separate).torrentDownload.enabled, true)
  assert.equal(read({ ...config, tools: { pixiv: { enabled: false } } }).torrentDownload.enabled, true)
  assert.equal(read({ ...config, torrentDownload: { enabled: false, bridges: [bridge()] } }).tools.pixiv.enabled, true)
})
