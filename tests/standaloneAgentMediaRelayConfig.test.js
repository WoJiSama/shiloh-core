import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const { readStandaloneMediaRelayConfig, standaloneMediaRelaySecrets } = await import(pathToFileURL(path.join(release, 'dist/backend/bootstrap/standaloneMediaRelay.js')).href)
const { readStandaloneAgentConfig } = await import(pathToFileURL(path.join(release, 'dist/backend/bootstrap/standaloneAgentConfig.js')).href)
const connections = [{ id: 'main', account: { platform: 'qq', namespace: 'global', id: '123456001' } }]
const bridge = { connectionId: 'main', listen: { host: '127.0.0.1', port: 31481 }, advertisedOrigin: 'http://127.0.0.1:31481', allowedPeers: ['127.0.0.1'] }
const enabled = extra => ({ enabled: true, bridges: [structuredClone(bridge)], ...extra })

test('standalone media relay is independently opt-in and disabled credentials are never read', () => {
  assert.deepEqual(readStandaloneMediaRelayConfig(undefined, connections, {}), { enabled: false, bridges: [], bilibili: { autoAuthorizedRetry: false } })
  const env = Object.defineProperty({}, 'BILI_COOKIE', { get() { throw new Error('disabled credentials read') } })
  assert.deepEqual(readStandaloneMediaRelayConfig({ enabled: false, bilibili: { cookieEnv: 'BILI_COOKIE' } }, connections, env).bilibili,
    { autoAuthorizedRetry: false })
  const config = readStandaloneMediaRelayConfig(enabled(), connections, {})
  assert.equal(config.enabled, true)
  assert.ok(Object.isFrozen(config)); assert.ok(Object.isFrozen(config.bridges)); assert.ok(Object.isFrozen(config.bridges[0].listen))
  assert.ok(Object.isFrozen(config.bridges[0].allowedPeers)); assert.ok(Object.isFrozen(config.bilibili))
})

test('Bilibili credentials require environment references and all cookie values enter host secret guards', () => {
  const cookie = 'SESSDATA=private-session==; bili_jct=private-jct; DedeUserID=123456'
  const input = enabled({ bilibili: { cookieEnv: 'BILI_COOKIE', autoAuthorizedRetry: true } })
  const config = readStandaloneMediaRelayConfig(input, connections, { BILI_COOKIE: cookie })
  assert.deepEqual(config.bilibili, { autoAuthorizedRetry: true, authCookie: cookie })
  assert.deepEqual(standaloneMediaRelaySecrets(config), [cookie, 'private-session==', 'private-jct', '123456'])
  assert.throws(() => readStandaloneMediaRelayConfig(input, connections, {}), /BILI_COOKIE/)
  assert.deepEqual(readStandaloneMediaRelayConfig(input, connections, {}, false).bilibili, { autoAuthorizedRetry: true })
  for (const bilibili of [{ cookie: cookie }, { cookieEnv: 'bad-name' }, { cookieEnv: 'BILI_COOKIE', autoAuthorizedRetry: 'yes' },
    { endpoint: 'https://evil.invalid' }, { cookieEnv: 'BILI_COOKIE', accountId: 'another' }]) {
    assert.throws(() => readStandaloneMediaRelayConfig(enabled({ bilibili }), connections, { BILI_COOKIE: cookie }))
  }
  for (const value of ['x'.repeat(32769), 'SESSDATA=\r\nInjected: 1', 'invalid-cookie', 'SESSDATA=']) {
    assert.throws(() => readStandaloneMediaRelayConfig(input, connections, { BILI_COOKIE: value }))
  }
})

test('Douyin is separately opt-in and cannot configure arbitrary endpoints, credentials, browsers or binaries', () => {
  assert.equal(readStandaloneMediaRelayConfig(enabled(), connections, {}).douyin, undefined)
  const config = readStandaloneMediaRelayConfig(enabled({ douyin: { enabled: true } }), connections, {})
  assert.deepEqual(config.douyin, { enabled: true }); assert.ok(Object.isFrozen(config.douyin))
  assert.deepEqual(standaloneMediaRelaySecrets(config), [])
  assert.deepEqual(readStandaloneMediaRelayConfig(enabled({ douyin: { enabled: false } }), connections, {}).douyin, { enabled: false })
  for (const douyin of [null, [], {}, { enabled: 'true' }, { enabled: true, url: 'https://other.invalid' },
    { enabled: true, cookieEnv: 'DY_COOKIE' }, { enabled: true, browser: '/path' }, { enabled: true, ffmpeg: '/path' }]) {
    assert.throws(() => readStandaloneMediaRelayConfig(enabled({ douyin }), connections, {}))
  }
  let touched = false
  assert.throws(() => readStandaloneMediaRelayConfig(enabled({ douyin: { get enabled() { touched = true; return true } } }), connections, {}))
  assert.equal(touched, false)
})

test('Xiaohongshu is separately opt-in with environment-only cookies and disabled credentials stay unread', () => {
  const cookie = 'web_session=XHS_PRIVATE_SESSION==; a1=XHS_PRIVATE_DEVICE'
  const env = Object.defineProperty({}, 'XHS_COOKIE', { get() { throw Error('disabled secret read') } })
  for (const input of [{ enabled: false, xiaohongshu: { enabled: true, cookieEnv: 'XHS_COOKIE' } },
    enabled({ xiaohongshu: { enabled: false, cookieEnv: 'XHS_COOKIE' } })]) {
    assert.equal(readStandaloneMediaRelayConfig(input, connections, env).xiaohongshu.authCookie, undefined)
  }
  assert.equal(readStandaloneMediaRelayConfig(enabled(), connections, {}).xiaohongshu, undefined)
  const input = enabled({ xiaohongshu: { enabled: true, cookieEnv: 'XHS_COOKIE' } })
  const config = readStandaloneMediaRelayConfig(input, connections, { XHS_COOKIE: cookie })
  assert.deepEqual(config.xiaohongshu, { enabled: true, authCookie: cookie })
  assert.ok(Object.isFrozen(config.xiaohongshu))
  assert.deepEqual(standaloneMediaRelaySecrets(config), [cookie, 'XHS_PRIVATE_SESSION==', 'XHS_PRIVATE_DEVICE'])
  assert.throws(() => readStandaloneMediaRelayConfig(input, connections, {}), /XHS_COOKIE.*小红书/)
  assert.deepEqual(readStandaloneMediaRelayConfig(input, connections, {}, false).xiaohongshu, { enabled: true })
  for (const xiaohongshu of [null, [], {}, { enabled: 'true' }, { enabled: true, cookie: cookie }, { enabled: true, cookieEnv: 'bad-name' },
    { enabled: true, url: 'https://other.invalid' }, { enabled: true, browser: '/path' }, { enabled: true, ffmpeg: '/path' }]) {
    assert.throws(() => readStandaloneMediaRelayConfig(enabled({ xiaohongshu }), connections, {}))
  }
  for (const value of ['x'.repeat(32769), 'web_session=\r\nInjected: 1', 'invalid-cookie', 'web_session=']) {
    assert.throws(() => readStandaloneMediaRelayConfig(input, connections, { XHS_COOKIE: value }))
  }
  let touched = false
  assert.throws(() => readStandaloneMediaRelayConfig(enabled({ xiaohongshu: { get enabled() { touched = true; return true } } }), connections, {}))
  assert.equal(touched, false)
})

test('YouTube is separately opt-in and reads no disabled cookie, PO token or proxy environment values', () => {
  const youtube = { enabled: true, cookieEnv: 'YT_COOKIE', poTokenEnv: 'YT_PO_TOKEN', proxyEnv: 'YT_PROXY' }
  const env = {}
  for (const name of ['YT_COOKIE', 'YT_PO_TOKEN', 'YT_PROXY']) Object.defineProperty(env, name, { get() { throw Error('disabled YouTube credential read') } })
  assert.equal(readStandaloneMediaRelayConfig(enabled(), connections, {}).youtube, undefined)
  for (const input of [{ enabled: false, youtube }, enabled({ youtube: { ...youtube, enabled: false } })]) {
    const config = readStandaloneMediaRelayConfig(input, connections, env)
    assert.deepEqual(config.youtube, { enabled: input.youtube.enabled })
    assert.deepEqual(standaloneMediaRelaySecrets(config), [])
  }
  const config = readStandaloneMediaRelayConfig(enabled({ youtube: { enabled: true } }), connections, {})
  assert.deepEqual(config.youtube, { enabled: true }); assert.ok(Object.isFrozen(config.youtube))
})

test('YouTube resolves environment-only credentials and protects full cookies, cookie values, PO token and proxy password', () => {
  const cookie = '__Secure-3PSID=YT_PRIVATE_SESSION==; SAPISID=YT_PRIVATE_SAPI', poToken = 'YT_PRIVATE_PO_+./=-',
    proxyUrl = 'http://proxy-user:YT_PRIVATE_P%40SS@127.0.0.1:7890'
  const youtube = { enabled: true, cookieEnv: 'YT_COOKIE', poTokenEnv: 'YT_PO_TOKEN', proxyEnv: 'YT_PROXY' }
  const config = readStandaloneMediaRelayConfig(enabled({ youtube }), connections, { YT_COOKIE: cookie, YT_PO_TOKEN: poToken, YT_PROXY: proxyUrl })
  assert.deepEqual(config.youtube, { enabled: true, authCookie: cookie, poToken, proxyUrl })
  assert.ok(Object.isFrozen(config.youtube))
  const secrets = standaloneMediaRelaySecrets(config)
  for (const value of [cookie, 'YT_PRIVATE_SESSION==', 'YT_PRIVATE_SAPI', poToken, proxyUrl, 'YT_PRIVATE_P@SS']) assert.ok(secrets.includes(value), value)
  for (const [field, name] of [['cookieEnv', 'YT_COOKIE'], ['poTokenEnv', 'YT_PO_TOKEN'], ['proxyEnv', 'YT_PROXY']]) {
    const input = enabled({ youtube: { enabled: true, [field]: name } })
    assert.throws(() => readStandaloneMediaRelayConfig(input, connections, {}), new RegExp(name))
    assert.deepEqual(readStandaloneMediaRelayConfig(input, connections, {}, false).youtube, { enabled: true })
  }
})

test('YouTube declarations reject embedded secrets, custom executables, arbitrary endpoints and behavioral objects', () => {
  for (const youtube of [null, [], {}, { enabled: 'true' }, { enabled: true, cookie: 'SID=PRIVATE' },
    { enabled: true, authCookie: 'SID=PRIVATE' }, { enabled: true, poToken: 'PRIVATE' }, { enabled: true, proxyUrl: 'http://127.0.0.1:7890' },
    { enabled: true, cookieEnv: 'bad-name' }, { enabled: true, poTokenEnv: 'bad-name' }, { enabled: true, proxyEnv: 'bad-name' },
    { enabled: true, endpoint: 'https://other.invalid' }, { enabled: true, url: 'https://other.invalid' },
    { enabled: true, browser: '/path' }, { enabled: true, ffmpeg: '/path' }, { enabled: true, ytDlp: '/path' },
    Object.assign(Object.create({ inherited: true }), { enabled: true })]) {
    assert.throws(() => readStandaloneMediaRelayConfig(enabled({ youtube }), connections, {}))
  }
  let touched = false
  assert.throws(() => readStandaloneMediaRelayConfig(enabled({ youtube: { get enabled() { touched = true; return true } } }), connections, {}))
  assert.equal(touched, false)
})

test('YouTube cookie and PO token values remain bounded and reject malformed or ambiguous credentials', () => {
  for (const value of ['x'.repeat(32769), 'SID=\r\nInjected: 1', 'invalid-cookie', 'SID=', 'SID=one; SID=two', 'SID=has space', 'SID=中文']) {
    assert.throws(() => readStandaloneMediaRelayConfig(enabled({ youtube: { enabled: true, cookieEnv: 'YT_COOKIE' } }), connections, { YT_COOKIE: value }))
  }
  for (const value of ['x'.repeat(8193), 'token value', 'token\nvalue', 'token:private', '中文', 'token;private']) {
    assert.throws(() => readStandaloneMediaRelayConfig(enabled({ youtube: { enabled: true, poTokenEnv: 'YT_PO_TOKEN' } }), connections, { YT_PO_TOKEN: value }))
  }
  const config = readStandaloneMediaRelayConfig(enabled({ youtube: { enabled: true, poTokenEnv: 'YT_PO_TOKEN' } }), connections, { YT_PO_TOKEN: 'x'.repeat(8192) })
  assert.equal(config.youtube.poToken.length, 8192)
})

test('YouTube accepts only bounded HTTP or SOCKS host proxy URLs without arbitrary paths or query data', () => {
  const input = enabled({ youtube: { enabled: true, proxyEnv: 'YT_PROXY' } })
  for (const value of ['http://127.0.0.1:7890', 'https://proxy.example:8443', 'socks5://127.0.0.1:1080',
    'socks5h://proxy-user:proxy-password@[::1]:1080']) {
    const config = readStandaloneMediaRelayConfig(input, connections, { YT_PROXY: value })
    assert.equal(config.youtube.proxyUrl, value)
    assert.ok(standaloneMediaRelaySecrets(config).includes(value))
  }
  for (const value of ['file:///tmp/proxy', 'ftp://proxy.example', 'http://proxy.example/path', 'http://proxy.example?token=PRIVATE',
    'http://proxy.example#PRIVATE', 'http://proxy.example?', 'http://proxy.example#', 'http://proxy.example\\evil',
    'http://proxy.example/\npath', 'http://proxy.example/a%2fpath', `http://${'x'.repeat(2049)}`]) {
    assert.throws(() => readStandaloneMediaRelayConfig(input, connections, { YT_PROXY: value }), value.slice(0, 100))
  }
})

test('Pixiv is separately opt-in and disabled credentials are never read while restricted access stays explicit', () => {
  const env = {}
  for (const name of ['PIXIV_COOKIE', 'PIXIV_PROXY']) Object.defineProperty(env, name, { get() { throw Error('disabled Pixiv credential read') } })
  const declarations = { enabled: true, cookieEnv: 'PIXIV_COOKIE', proxyEnv: 'PIXIV_PROXY' }
  assert.equal(readStandaloneMediaRelayConfig(enabled(), connections, {}).pixiv, undefined)
  for (const input of [{ enabled: false, pixiv: declarations }, enabled({ pixiv: { ...declarations, enabled: false } })]) {
    const config = readStandaloneMediaRelayConfig(input, connections, env)
    assert.deepEqual(config.pixiv, { enabled: input.pixiv.enabled, allowRestricted: false })
    assert.deepEqual(standaloneMediaRelaySecrets(config), [])
  }
  const config = readStandaloneMediaRelayConfig(enabled({ pixiv: { enabled: true } }), connections, {})
  assert.deepEqual(config.pixiv, { enabled: true, allowRestricted: false }); assert.ok(Object.isFrozen(config.pixiv))
  assert.deepEqual(readStandaloneMediaRelayConfig(enabled({ pixiv: { enabled: true, allowRestricted: true } }), connections, {}).pixiv,
    { enabled: true, allowRestricted: true })
  assert.deepEqual(readStandaloneMediaRelayConfig(enabled({ pixiv: { enabled: true, allowRestricted: false } }), connections, {}).pixiv,
    { enabled: true, allowRestricted: false })
})

test('Pixiv resolves only referenced RFC cookies and host proxies and protects every credential value', () => {
  const authCookie = 'PHPSESSID=PIXIV_PRIVATE_SESSION==; __Secure-device-id=PIXIV_PRIVATE_DEVICE', proxyUrl = 'socks5h://user:PIXIV_PRIVATE_P%40SS@127.0.0.1:1080'
  const pixiv = { enabled: true, cookieEnv: 'PIXIV_COOKIE', proxyEnv: 'PIXIV_PROXY', allowRestricted: false }
  const config = readStandaloneMediaRelayConfig(enabled({ pixiv }), connections, { PIXIV_COOKIE: authCookie, PIXIV_PROXY: proxyUrl })
  assert.deepEqual(config.pixiv, { enabled: true, allowRestricted: false, authCookie, proxyUrl })
  const secrets = standaloneMediaRelaySecrets(config)
  for (const value of [authCookie, 'PIXIV_PRIVATE_SESSION==', 'PIXIV_PRIVATE_DEVICE', proxyUrl, 'PIXIV_PRIVATE_P@SS']) assert.ok(secrets.includes(value), value)
  for (const [field, name] of [['cookieEnv', 'PIXIV_COOKIE'], ['proxyEnv', 'PIXIV_PROXY']]) {
    const input = enabled({ pixiv: { enabled: true, [field]: name } })
    assert.throws(() => readStandaloneMediaRelayConfig(input, connections, {}), new RegExp(name))
    assert.deepEqual(readStandaloneMediaRelayConfig(input, connections, {}, false).pixiv, { enabled: true, allowRestricted: false })
  }
})

test('Pixiv normalizes an optional Cookie prefix and permits exactly one trailing semicolon', () => {
  const cookie = 'PHPSESSID=PIXIV_PRIVATE_SESSION==; __Secure-device-id=PIXIV_PRIVATE_DEVICE;'
  const input = enabled({ pixiv: { enabled: true, cookieEnv: 'PIXIV_COOKIE' } })
  for (const value of [cookie, `Cookie: ${cookie}`, `  cOoKiE :  ${cookie}  `]) {
    const config = readStandaloneMediaRelayConfig(input, connections, { PIXIV_COOKIE: value })
    assert.equal(config.pixiv.authCookie, cookie)
    const secrets = standaloneMediaRelaySecrets(config)
    for (const secret of [cookie, 'PIXIV_PRIVATE_SESSION==', 'PIXIV_PRIVATE_DEVICE']) assert.ok(secrets.includes(secret), secret)
  }
  for (const value of ['PHPSESSID=PRIVATE;;', 'PHPSESSID=PRIVATE; ;', ';PHPSESSID=PRIVATE',
    'PHPSESSID=PRIVATE;;device=OTHER', 'PHPSESSID=PRIVATE; ; device=OTHER', 'Cookie: ;', 'Cookie: PHPSESSID=PRIVATE;;']) {
    assert.throws(() => readStandaloneMediaRelayConfig(input, connections, { PIXIV_COOKIE: value }), value)
  }
})

test('Pixiv rejects inline credentials, malformed cookies, custom endpoints, binary paths and nonboolean restriction settings', () => {
  for (const pixiv of [null, [], {}, { enabled: 'true' }, { enabled: true, cookie: 'PHPSESSID=PRIVATE' },
    { enabled: true, authCookie: 'PHPSESSID=PRIVATE' }, { enabled: true, proxyUrl: 'http://127.0.0.1:7890' },
    { enabled: true, cookieEnv: 'bad-name' }, { enabled: true, proxyEnv: 'bad-name' },
    { enabled: true, endpoint: 'https://other.invalid' }, { enabled: true, url: 'https://other.invalid' },
    { enabled: true, browser: '/path' }, { enabled: true, ffmpeg: '/path' }, { enabled: true, maxPages: 5 },
    { enabled: true, allowRestricted: 'true' }, { enabled: true, allowRestricted: 1 }, { enabled: true, allowRestricted: null },
    Object.assign(Object.create({ inherited: true }), { enabled: true })]) assert.throws(() => readStandaloneMediaRelayConfig(enabled({ pixiv }), connections, {}))
  for (const value of ['x'.repeat(32769), 'PHPSESSID=\r\nInjected: 1', 'invalid-cookie', 'PHPSESSID=',
    'PHPSESSID=one; PHPSESSID=two', 'PHPSESSID=has space', 'PHPSESSID=中文']) {
    assert.throws(() => readStandaloneMediaRelayConfig(enabled({ pixiv: { enabled: true, cookieEnv: 'PIXIV_COOKIE' } }), connections, { PIXIV_COOKIE: value }))
  }
  let touched = false
  assert.throws(() => readStandaloneMediaRelayConfig(enabled({ pixiv: { get enabled() { touched = true; return true } } }), connections, {}))
  assert.equal(touched, false)
})

test('Pixiv supports referenced HTTP, HTTPS and SOCKS host proxies within the same closed grammar', () => {
  const input = enabled({ pixiv: { enabled: true, proxyEnv: 'PIXIV_PROXY' } })
  for (const value of ['http://127.0.0.1:7890', 'https://proxy.example:8443', 'socks5://127.0.0.1:1080', 'socks5h://user:password@[::1]:1080']) {
    const config = readStandaloneMediaRelayConfig(input, connections, { PIXIV_PROXY: value })
    assert.equal(config.pixiv.proxyUrl, value); assert.ok(standaloneMediaRelaySecrets(config).includes(value))
  }
  for (const value of ['file:///tmp/proxy', 'ftp://proxy.example', 'http://proxy.example/path', 'http://proxy.example?token=PRIVATE',
    'http://proxy.example#PRIVATE', 'http://proxy.example?', 'http://proxy.example#', 'http://proxy.example\\evil',
    'http://proxy.example/\npath', 'http://proxy.example/a%2fpath', `http://${'x'.repeat(2049)}`]) {
    assert.throws(() => readStandaloneMediaRelayConfig(input, connections, { PIXIV_PROXY: value }), value.slice(0, 100))
  }
})

test('every hosted account has an explicit independent bridge with bounded literal peers and valid origin', () => {
  const second = { id: 'second', account: { ...connections[0].account, id: '123456002' } }
  assert.throws(() => readStandaloneMediaRelayConfig(enabled(), [...connections, second], {}))
  const both = readStandaloneMediaRelayConfig(enabled({ bridges: [bridge, { ...bridge, connectionId: 'second',
    listen: { host: '127.0.0.1', port: 31482 }, advertisedOrigin: 'http://192.168.1.4:31482' }] }), [...connections, second], {})
  assert.equal(both.bridges.length, 2)
  const invalid = [null, [], {}, { enabled: 1 }, enabled({ ignored: true }), enabled({ bridges: [] }),
    enabled({ bridges: [bridge, bridge] }), enabled({ bridges: [{ ...bridge, connectionId: 'missing' }] }),
    enabled({ bridges: [{ ...bridge, listen: { host: 'localhost', port: 31481 } }] }),
    enabled({ bridges: [{ ...bridge, listen: { host: '127.0.0.1', port: 0 } }] }),
    enabled({ bridges: [{ ...bridge, allowedPeers: [] }] }), enabled({ bridges: [{ ...bridge, allowedPeers: ['127.0.0.1', '127.0.0.1'] }] }),
    enabled({ bridges: [{ ...bridge, allowedPeers: ['napcat.local'] }] }),
    ...['http://public.example', 'http://8.8.8.8', 'https://u:p@host', 'https://host/path', 'https://host?token=secret',
      'https://host/#fragment', 'http://127.0.0.1/a/..', 'http://[fe80::1%25lo0]'].map(advertisedOrigin => enabled({ bridges: [{ ...bridge, advertisedOrigin }] })),
  ]
  for (const value of invalid) assert.throws(() => readStandaloneMediaRelayConfig(value, connections, {}))
  let touched = 0
  assert.throws(() => readStandaloneMediaRelayConfig({ enabled: true, get bridges() { touched++; return [bridge] } }, connections, {}))
  assert.equal(touched, 0)
})

test('host configuration exposes neutral enabled separately from private provider and transport configuration', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-media-config-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({ version: 1,
    agents: [{ id: 'daily', personaId: 'default' }], connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: '123456001' }],
    bindings: [{ connectionId: 'main', kind: 'group', conversationId: '90001', agentId: 'daily' }] }))
  const file = path.join(directory, 'agent-host.yaml')
  const read = mediaRelay => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, instance: 'media-config', model: { baseUrl: 'https://model.example/v1', name: 'main', apiKeyEnv: 'MAIN_KEY' },
      connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }], ...(mediaRelay === undefined ? {} : { mediaRelay }) }))
    return readStandaloneAgentConfig(file, { MAIN_KEY: 'main-key', BILI_COOKIE: 'SESSDATA=private-session' })
  }
  assert.equal(read().mediaRelay.enabled, false)
  const config = read(enabled({ bilibili: { cookieEnv: 'BILI_COOKIE' } }))
  assert.equal(config.mediaRelay.enabled, true)
  assert.equal(config.mediaRelay.bilibili.authCookie, 'SESSDATA=private-session')
  assert.equal(config.musicExtraction.enabled, false)
})
