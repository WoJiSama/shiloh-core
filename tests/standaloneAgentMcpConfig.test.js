import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readStandaloneAgentConfig } from '../dist/backend/bootstrap/standaloneAgentConfig.js'

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mcp-config-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'agent-bindings.yaml'), JSON.stringify({
    version: 1, agents: [{ id: 'daily', personaId: 'default' }],
    connections: [{ id: 'main', platform: 'qq', namespace: 'global', accountId: '123456001' }],
    bindings: [{ connectionId: 'main', kind: 'group', conversationId: '90001', agentId: 'daily' }],
  }))
  const file = path.join(directory, 'agent-host.yaml')
  const env = { TEST_MAIN_KEY: 'main-private-key', TEST_MCP_TOKEN: 'Bearer mcp-private-token',
    TEST_MCP_KEY: 'mcp-private-key', UNRELATED_PRIVATE_KEY: 'unrelated-private-secret' }
  function read(mcp, options, credentials = env, sections = {}) {
    fs.writeFileSync(file, JSON.stringify({ version: 1, instance: 'mcp-config',
      model: { baseUrl: 'https://main.example/v1', name: 'main-model', apiKeyEnv: 'TEST_MAIN_KEY' },
      connections: [{ id: 'main', url: 'ws://127.0.0.1:3001' }],
      ...(mcp === undefined ? {} : { tools: { mcp } }), ...sections,
    }))
    return readStandaloneAgentConfig(file, credentials, options)
  }
  const http = { type: 'http', baseUrl: 'https://mcp.example/tools' }
  const stdio = { type: 'stdio', command: 'node' }
  const servers = (server = http, name = 'lookup') => ({ servers: { [name]: server } })
  return { directory, read, env, http, stdio, servers }
}

function safeError(action) {
  assert.throws(action, error => !/mcp-private|unrelated-private|raw-private/u.test(String(error)))
}

test('MCP remains absent unless active servers are explicitly configured and never reads legacy MCP configuration', t => {
  const { directory, read, http, servers } = fixture(t)
  fs.writeFileSync(path.join(directory, 'mcp.yaml'), 'mcpServers:\n  legacy:\n    command: raw-private-command\n')
  assert.deepEqual(read().tools, {})
  assert.deepEqual(read({ servers: {} }).tools, {})
  assert.deepEqual(read(servers({ ...http, enabled: false })).tools, {})
  assert.deepEqual(read().tools, {})
})

test('network MCP servers resolve only declared header environment references and preserve independent server options', t => {
  const { read, http } = fixture(t)
  const parsed = read({ servers: {
    lookup: { ...http, enabled: true, headersFromEnv: { Authorization: 'TEST_MCP_TOKEN', 'X-Api-Key': 'TEST_MCP_KEY' },
      includeTools: ['lookup', 'weather.current'], excludeTools: ['delete'], connectTimeoutMs: 100, toolCallTimeoutMs: 120_000,
      autoReconnect: true, reconnectMaxAttempts: 3 },
    events: { type: 'sse', baseUrl: 'http://127.0.0.1:3123/sse', autoReconnect: false, reconnectMaxAttempts: 0 },
  } }).tools.mcp
  assert.deepEqual(parsed, { servers: {
    lookup: { type: 'http', baseUrl: 'https://mcp.example/tools', headers: { Authorization: 'Bearer mcp-private-token', 'X-Api-Key': 'mcp-private-key' },
      includeTools: ['lookup', 'weather.current'], excludeTools: ['delete'], connectTimeoutMs: 100, toolCallTimeoutMs: 120_000,
      autoReconnect: true, reconnectMaxAttempts: 3 },
    events: { type: 'sse', baseUrl: 'http://127.0.0.1:3123/sse', autoReconnect: false, reconnectMaxAttempts: 0 },
  } })
  assert.ok(!JSON.stringify(parsed).includes('main-private-key'))
  assert.ok(!JSON.stringify(parsed).includes('unrelated-private-secret'))
  assert.ok(!JSON.stringify(parsed).includes('TEST_MCP_'))
})

test('stdio MCP resolves cwd from the host file and passes only explicit environment mappings', t => {
  const { directory, read, stdio, servers } = fixture(t)
  const parsed = read(servers({ ...stdio, args: ['server.mjs', '--label', '', 'a b'], cwd: '../tools',
    envFrom: { SERVER_KEY: 'TEST_MCP_KEY', otherToken: 'TEST_MCP_TOKEN' }, includeTools: [], excludeTools: [] })).tools.mcp.servers.lookup
  assert.deepEqual(parsed, { type: 'stdio', command: 'node', args: ['server.mjs', '--label', '', 'a b'],
    cwd: path.resolve(directory, '../tools'), env: { SERVER_KEY: 'mcp-private-key', otherToken: 'Bearer mcp-private-token' },
    includeTools: [], excludeTools: [] })
  assert.ok(!Object.hasOwn(parsed.env, 'TEST_MAIN_KEY'))
  assert.ok(!Object.hasOwn(parsed.env, 'UNRELATED_PRIVATE_KEY'))
  const absolute = path.join(directory, 'absolute')
  assert.equal(read(servers({ ...stdio, cwd: absolute })).tools.mcp.servers.lookup.cwd, absolute)
})

test('disabled servers skip credential reads while migration preview tolerates missing active credentials', t => {
  const { read, http, stdio, env } = fixture(t)
  const disabled = { servers: {
    network: { ...http, enabled: false, headersFromEnv: { Authorization: 'MISSING_TOKEN' } },
    process: { ...stdio, enabled: false, envFrom: { SECRET: 'TEST_MCP_KEY' } },
  } }
  assert.deepEqual(read(disabled, undefined, { TEST_MAIN_KEY: env.TEST_MAIN_KEY, TEST_MCP_KEY: '\0' }).tools, {})
  const required = { servers: {
    network: { ...http, headersFromEnv: { Authorization: 'MISSING_TOKEN' } },
    process: { ...stdio, envFrom: { SECRET: 'MISSING_KEY' } },
  } }
  assert.throws(() => read(required), /MISSING_TOKEN/u)
  const preview = read(required, { requireCredentials: false }, {}).tools.mcp.servers
  assert.deepEqual(preview.network.headers, { Authorization: '' })
  assert.deepEqual(preview.process.env, { SECRET: '' })
  assert.equal(read({ servers: { process: required.servers.process } }, { requireCredentials: false }, {}).tools.mcp.servers.process.command, 'node')
  assert.throws(() => read({ servers: { process: required.servers.process } }), /MISSING_KEY/u)
})

test('MCP validates closed object shapes, exact transport types and transport-specific fields even when disabled', t => {
  const { read, http, stdio, servers } = fixture(t)
  for (const invalid of [null, false, true, [], 'enabled', 1, {}, { enabled: true }, { servers: null }, { servers: [] },
    { servers: false }, { servers: {}, fallback: true }, { servers: { bad: null } }, { servers: { bad: [] } },
    ...[undefined, null, false, true, ['http'], {}, '', 'websocket'].map(type => servers({ ...http, type })),
    servers({ ...http, enabled: 'false' }), servers({ ...http, autoReconnect: 1 }),
    servers({ ...http, command: 'node' }), servers({ ...http, envFrom: {} }), servers({ ...http, args: [] }), servers({ ...http, cwd: '.' }),
    servers({ ...stdio, baseUrl: 'https://mcp.example' }), servers({ ...stdio, headersFromEnv: {} }),
    ...['headers', 'env', 'apiKey', 'accessToken', 'transport', 'retry', 'fallback'].map(key => servers({ ...http, [key]: 'raw-private-value' })),
    servers({ ...http, enabled: false, headers: {} }), servers({ ...stdio, enabled: false, args: [false] }),
  ]) safeError(() => read(invalid))
})

test('MCP names and declared server counts are bounded including disabled entries', t => {
  const { read, http, servers } = fixture(t)
  for (const name of ['', '0server', 'server.name', 'with space', 'a'.repeat(41), '中文', 'a\n']) safeError(() => read(servers(http, name)))
  const eight = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`server_${index}`, http]))
  assert.equal(Object.keys(read({ servers: eight }).tools.mcp.servers).length, 8)
  safeError(() => read({ servers: { ...eight, ninth: { ...http, enabled: false } } }))
  const magic = read(servers(http, '__proto__')).tools.mcp.servers
  assert.ok(Object.hasOwn(magic, '__proto__'))
  assert.equal(magic.__proto__.type, 'http')
  assert.equal(Object.getPrototypeOf(magic), Object.prototype)
  assert.ok(read(servers(http, 'a'.repeat(40))).tools.mcp)
})

test('network MCP rejects credentials, queries, fragments, malformed URLs and unsupported protocols without exposing values', t => {
  const { read, http, servers } = fixture(t)
  for (const baseUrl of ['', ' ', false, null, [], {}, 1, 'not a url', 'file:///tmp/raw-private-value', 'ws://mcp.example',
    'https://user:raw-private-value@mcp.example', 'https://mcp.example?key=raw-private-value', 'https://mcp.example#raw-private-value',
    'https://mcp.example?', 'https://mcp.example#', 'https://mcp.example\n', 'https:\\mcp.example', 'https://mcp.example/' + 'a'.repeat(2048)]) {
    safeError(() => read(servers({ ...http, baseUrl })))
  }
  assert.equal(read(servers({ ...http, baseUrl: 'https://mcp.example' })).tools.mcp.servers.lookup.baseUrl, 'https://mcp.example/')
})

test('stdio MCP bounds command, arguments and cwd and never accepts inline environment values', t => {
  const { read, stdio, servers } = fixture(t)
  for (const command of [undefined, null, false, '', ' ', [], {}, 1, 'x'.repeat(4097), 'node\0', 'node\n']) {
    safeError(() => read(servers({ ...stdio, command })))
  }
  for (const args of [null, false, 'server.mjs', {}, [1], [null], Array(129).fill('arg'), ['x'.repeat(4097)], ['raw-private\0arg']]) {
    safeError(() => read(servers({ ...stdio, args })))
  }
  for (const cwd of [null, false, '', ' ', [], {}, 1, 'x'.repeat(4097), 'raw-private\0path']) safeError(() => read(servers({ ...stdio, cwd })))
  for (const envFrom of [null, false, [], 'raw-private-value', { SECRET: 'raw-private-value' }, { 'bad-name': 'TEST_MCP_KEY' },
    { '1BAD': 'TEST_MCP_KEY' }, { ['A'.repeat(129)]: 'TEST_MCP_KEY' }, { SECRET: true }, { SECRET: '' }]) {
    safeError(() => read(servers({ ...stdio, envFrom })))
  }
})

test('MCP filters contain at most 128 unique nonempty bounded tool names', t => {
  const { read, http, servers } = fixture(t)
  for (const key of ['includeTools', 'excludeTools']) {
    for (const names of [null, false, {}, 'lookup', [1], [null], [''], [' '], ['lookup', 'lookup'], ['x'.repeat(129)], ['raw-private\nname'],
      Array.from({ length: 129 }, (_, index) => `tool_${index}`)]) safeError(() => read(servers({ ...http, [key]: names })))
    const maximum = Array.from({ length: 128 }, (_, index) => `tool_${index}`)
    assert.deepEqual(read(servers({ ...http, [key]: maximum })).tools.mcp.servers.lookup[key], maximum)
  }
})

test('MCP timeouts, reconnect attempts and switches use exact bounded integer and boolean types', t => {
  const { read, http, servers } = fixture(t)
  for (const [key, minimum, maximum] of [['connectTimeoutMs', 100, 30_000], ['toolCallTimeoutMs', 100, 120_000], ['reconnectMaxAttempts', 0, 3]]) {
    for (const number of [minimum - 1, maximum + 1, minimum + 0.5, null, false, {}, [], '100']) safeError(() => read(servers({ ...http, [key]: number })))
    for (const number of [minimum, maximum]) assert.equal(read(servers({ ...http, [key]: number })).tools.mcp.servers.lookup[key], number)
  }
  for (const key of ['enabled', 'autoReconnect']) for (const value of [null, 0, 1, '', 'true', [], {}]) safeError(() => read(servers({ ...http, [key]: value })))
})

test('network MCP header names are case-insensitively unique, syntactically valid and cannot override transport state', t => {
  const { read, http, servers } = fixture(t)
  for (const header of ['', 'bad name', 'Bad\r\nName', ':authority', 'x'.repeat(129), 'Host', 'Content-Length', 'Cookie', 'Set-Cookie', 'Connection',
    'Transfer-Encoding', 'TE', 'Trailer', 'Upgrade', 'Expect', 'Content-Type', 'Accept', 'Proxy-Authorization', 'Proxy-Authenticate',
    'Forwarded', 'X-Forwarded-For', 'Sec-WebSocket-Key', 'Mcp-Session-Id', 'MCP-Protocol-Version', 'Last-Event-Id']) {
    safeError(() => read(servers({ ...http, headersFromEnv: { [header]: 'TEST_MCP_TOKEN' } })))
  }
  for (const headersFromEnv of [null, false, [], 'Authorization', { Authorization: 'raw-private-token' }, { Authorization: null },
    { Authorization: 'TEST_MCP_TOKEN', authorization: 'TEST_MCP_TOKEN' }]) safeError(() => read(servers({ ...http, headersFromEnv })))
  assert.deepEqual(read(servers({ ...http, headersFromEnv: { authorization: 'TEST_MCP_TOKEN' } })).tools.mcp.servers.lookup.headers,
    { authorization: 'Bearer mcp-private-token' })
})

test('MCP environment mappings and resolved values have separate transport limits and errors never reveal secrets', t => {
  const { read, http, stdio, env, servers } = fixture(t)
  for (const [backend, field] of [[http, 'headersFromEnv'], [stdio, 'envFrom']]) {
    const mappings = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`KEY_${index}`, 'TEST_MCP_KEY']))
    safeError(() => read(servers({ ...backend, [field]: mappings })))
  }
  for (const value of ['raw-private\nvalue', 'raw-private\rvalue', 'raw-private\0value', 'raw-private\tvalue', 'x'.repeat(8193)]) {
    safeError(() => read(servers({ ...http, headersFromEnv: { Authorization: 'TEST_MCP_TOKEN' } }), undefined, { ...env, TEST_MCP_TOKEN: value }))
  }
  for (const value of ['raw-private\0value', 'x'.repeat(32_769)]) {
    safeError(() => read(servers({ ...stdio, envFrom: { KEY: 'TEST_MCP_KEY' } }), undefined, { ...env, TEST_MCP_KEY: value }))
  }
  assert.deepEqual(read(servers({ ...stdio, envFrom: { KEY: 'TEST_MCP_KEY' } }), undefined, { ...env, TEST_MCP_KEY: 'multi\nline' }).tools.mcp.servers.lookup.env,
    { KEY: 'multi\nline' })
  assert.deepEqual(read(servers({ ...http, headersFromEnv: { Authorization: 'TEST_MCP_TOKEN' } }), undefined,
    { ...env, TEST_MCP_TOKEN: '  Bearer mcp-private-token  ' }).tools.mcp.servers.lookup.headers, { Authorization: 'Bearer mcp-private-token' })
  assert.deepEqual(read(servers({ ...stdio, envFrom: { KEY: 'TEST_MCP_KEY' } }), undefined,
    { ...env, TEST_MCP_KEY: '  mcp-private-key  ' }).tools.mcp.servers.lookup.env, { KEY: '  mcp-private-key  ' })
})

test('MCP composes with explicitly configured existing tool providers without borrowing model credentials', t => {
  const { read, servers, env } = fixture(t)
  const tools = read(undefined, undefined, env, { tools: { mcp: servers(), web: { enabled: true },
    search: { baseUrl: 'https://search.example/v1', name: 'search-model', apiKeyEnv: 'TEST_MCP_KEY' },
    images: { generation: { baseUrl: 'https://images.example/v1', name: 'image-model', apiKeyEnv: 'TEST_MCP_KEY' } },
  } }).tools
  assert.deepEqual(tools.mcp, { servers: { lookup: { type: 'http', baseUrl: 'https://mcp.example/tools' } } })
  assert.equal(tools.web.enabled, true)
  assert.equal(tools.search.apiKey, 'mcp-private-key')
  assert.equal(tools.images.generation.apiKey, 'mcp-private-key')
})
