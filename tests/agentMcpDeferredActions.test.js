import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import { registerHooks } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const repo = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || repo)
const sourceTest = process.env.BL_CHAT_AGENT_SOURCE_TEST === '1'
if (sourceTest) {
  const ts = (await import('typescript')).default, sourceRoot = path.join(repo, 'src') + path.sep
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(pathToFileURL(sourceRoot).href)) {
        const url = new URL(specifier.replace(/\.js$/u, '.ts'), context.parentURL)
        if (existsSync(fileURLToPath(url))) return next(url.href, context)
      }
      return next(specifier, context)
    },
    load(url, context, next) {
      if (url.startsWith(pathToFileURL(sourceRoot).href) && url.endsWith('.ts')) return { format: 'module', shortCircuit: true,
        source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText }
      return next(url, context)
    },
  })
}
const load = relative => import(pathToFileURL(path.join(sourceTest ? repo : release, sourceTest ? 'src' : 'dist/backend',
  sourceTest ? relative.replace(/\.js$/u, '.ts') : relative)).href)
const { openAgentMcpTools } = await load('modules/tools/infrastructure/agentMcpTools.js')
const { createAgentDeferredActionExecutor } = await load('modules/tools/infrastructure/agentDeferredActionExecutor.js')
const { createAgentDeferredActionPolicy } = await load('modules/tools/infrastructure/agentDeferredActionPolicy.js')
const { freezeDeferredAction } = await load('modules/commitments/infrastructure/agentDeferredActionData.js')
const { agentBindingIdentity, agentConversationKey } = await load('modules/runtime/domain/agentBindings.js')

const fixturePath = fileURLToPath(new URL('./fixtures/agentMcpServer.mjs', import.meta.url))
const secret = 'deferred-mcp-explicit-secret-083916'
const valid = () => ({ count: 2, mode: 'safe', nested: { code: 'AB' }, tags: [0, 2] })
const at = 1_800_000_000_000
const binding = { source: 'configured', id: 'mcp-binding', revision: 'binding-1', agentId: 'daily', personaId: 'default', connectionId: 'qq-local',
  target: { account: { platform: 'qq', namespace: 'global', id: '90001' }, kind: 'group', id: '80001' } }
const creator = { platform: 'qq', namespace: 'global', id: '70001' }
const get = (handle, name) => handle.getDeferredDefinitions().find(definition => definition.name === `mcp_server_${name}`)

async function waitFor(probe, label, timeout = 2500) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const result = await probe()
    if (result) return result
    await delay(10)
  }
  assert.fail(`Timed out waiting for ${label}`)
}

async function stdioFixture(t, { config: changes = {}, ...options } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-mcp-deferred-')), auditPath = path.join(directory, 'audit.ndjson')
  const config = { type: 'stdio', command: process.execPath, args: [fixturePath, auditPath], cwd: directory,
    env: { MCP_EXPLICIT_VALUE: secret }, connectTimeoutMs: 2000, toolCallTimeoutMs: 1000, autoReconnect: false, ...changes }
  let handle
  t.after(async () => { await handle?.close(); await fs.rm(directory, { recursive: true, force: true }) })
  const open = async () => { await handle?.close(); handle = await openAgentMcpTools({ ...options, servers: { server: config } }); return handle }
  await open()
  const events = async () => (await fs.readFile(auditPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const calls = async name => (await events()).filter(event => event.event === 'call' && (!name || event.name === name))
  return { get handle() { return handle }, config, open, events, calls, get: name => get(handle, name) }
}

async function execution(handle, definition, params = {}, overrides = {}) {
  const action = freezeDeferredAction({ tool: definition.name, executor: definition.executor, definitionId: definition.definitionId, params })
  const executor = createAgentDeferredActionExecutor({ getDefinitions: () => handle.getDeferredDefinitions() })
  const rule = { id: 'one-mcp-rule', revision: 'policy-1', bindingIdentity: agentBindingIdentity(binding), scopeKey: agentConversationKey(binding),
    creatorIds: [creator.id], tool: action.tool, executor: action.executor, definitionId: action.definitionId, maxDelayMs: 60_000 }
  const policy = createAgentDeferredActionPolicy({ getConfig: () => ({ enabled: true, rules: [rule] }), resolveDefinition: executor.resolve,
    mode: () => 'simulation', isToolAllowed: () => true, now: () => at, verifyAuthority: async () => 'allowed' })
  const request = { binding, creator, action, source: { kind: 'message', messageId: 'original-request', at }, dueAt: at + 1000, requestText: '稍后执行已指定的工具' }
  const delegation = await policy.issue(request)
  assert.ok(delegation)
  const context = { kind: 'deferred', taskId: 'task-mcp', binding, creator, delegation, signal: new AbortController().signal,
    isCurrent: () => policy.isCurrent(delegation, request),
    async ensureCurrent() { if (await policy.check(delegation, request) !== 'allowed') throw new Error('revoked') }, ...overrides }
  return { action, context, executor }
}

test('dedicated definitions execute a real SDK call using an exact grant without a human actor or provider output', { timeout: 8000 }, async t => {
  const empty = await openAgentMcpTools()
  assert.deepEqual(empty.getDeferredDefinitions(), [])
  assert.equal(Object.isFrozen(empty.getDeferredDefinitions()), true)
  await empty.close()
  const f = await stdioFixture(t), definition = f.get('lookup'), definitions = f.handle.getDeferredDefinitions()
  assert.equal(Object.isFrozen(definitions), true)
  assert.equal(Object.isFrozen(definition), true)
  assert.equal(definition.executor, 'mcp')
  assert.match(definition.definitionId, /^mcp:def:v1:[a-f0-9]{64}$/u)
  assert.ok(!definition.definitionId.includes(secret))
  const { executor, action, context } = await execution(f.handle, definition, valid())
  assert.equal('actor' in context, false)
  assert.equal('request' in context, false)
  const humanTool = f.handle.registry.custom.find(tool => tool.name === definition.name)
  assert.equal((await humanTool.execute(valid(), { ...context, actor: { kind: 'commitment' } })).status, 'failed')
  assert.deepEqual(await f.calls(), [])
  assert.deepEqual(await executor.execute(action, context), { status: 'succeeded', content: '延期工具已确认完成。' })
  assert.deepEqual((await f.calls('lookup')).map(call => call.input), [valid()])
  const revoked = { ...action, definitionId: 'another-definition' }
  assert.equal((await executor.execute(revoked, context)).status, 'failed')
  assert.equal((await f.calls('lookup')).length, 1)
})

test('the original discovered schema and secret guard reject deferred inputs before the SDK sends anything', { timeout: 8000 }, async t => {
  const f = await stdioFixture(t), definition = f.get('lookup'), { context } = await execution(f.handle, definition, valid())
  for (const change of [value => { value.count = 0 }, value => { value.count = 4 }, value => { value.count = 1.5 },
    value => { delete value.count }, value => { value.mode = 'unsafe' }, value => { value.nested.code = 'lowercase' },
    value => { value.nested.extra = true }, value => { value.extra = true }, value => { value.tags = [] },
    value => { value.tags = [0, 1, 2] }, value => { value.tags = [0, 0] }, value => { value.tags = [3] }]) {
    const input = valid(); change(input)
    assert.equal(definition.validate(input), false)
    assert.equal((await definition.execute(input, context)).status, 'failed')
  }
  const credential = f.get('credential_input')
  for (const value of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')]) {
    assert.equal(credential.validate({ value }), false)
    const result = await credential.execute({ value }, context)
    assert.equal(result.status, 'failed')
    assert.ok(!JSON.stringify(result).includes(value))
  }
  assert.deepEqual(await f.calls(), [])
  assert.equal(f.get('credential_descriptor'), undefined)
})

test('deferred results discard remote text and secrets and preserve explicit SDK failures', { timeout: 8000 }, async t => {
  const f = await stdioFixture(t)
  for (const [name, status] of [['external_instructions', 'succeeded'], ['remote_failure', 'failed'], ['credential_echo', 'unknown']]) {
    const definition = f.get(name), { context } = await execution(f.handle, definition)
    const result = await definition.execute({}, context)
    assert.equal(result.status, status)
    for (const forbidden of [secret, 'Ignore the host', 'Remote explicitly refused', 'structuredContent']) assert.ok(!JSON.stringify(result).includes(forbidden))
    assert.equal('messageId' in result, false)
    assert.equal((await f.calls(name)).length, 1)
  }
})

test('list refresh revokes pending calls and hanging preflight checks while preserving the stable unchanged-tool fingerprint', { timeout: 8000 }, async t => {
  const f = await stdioFixture(t), oldLookup = f.get('lookup'), oldOnly = f.get('old_only'), slow = f.get('slow')
  const { context } = await execution(f.handle, slow)
  const pending = slow.execute({}, context)
  let entered
  const started = new Promise(resolve => { entered = resolve })
  const preflight = oldLookup.execute(valid(), { ...context, ensureCurrent: async () => { entered(); await new Promise(() => {}) } })
  await started
  await waitFor(async () => (await f.calls('slow')).length === 1, 'dispatched deferred call')
  assert.equal((await f.get('refresh').execute({}, context)).status, 'succeeded')
  await waitFor(() => f.get('added'), 'new deferred generation')
  assert.equal((await pending).status, 'unknown')
  assert.equal((await preflight).status, 'failed')
  assert.equal(oldLookup.isCurrent(), false)
  assert.equal(oldOnly.isCurrent(), false)
  assert.equal(oldLookup.validate(valid()), false)
  assert.equal((await oldLookup.execute(valid(), context)).status, 'failed')
  assert.equal(f.get('lookup').definitionId, oldLookup.definitionId)
  assert.notEqual(f.get('lookup'), oldLookup)
  assert.equal(f.get('old_only'), undefined)
  const added = f.get('added'), current = await execution(f.handle, added)
  assert.equal((await current.executor.execute(current.action, current.context)).status, 'succeeded')
  assert.equal((await f.calls('slow')).length, 1)
  assert.equal((await f.calls('lookup')).length, 0)
})

for (const stop of ['close', 'parent-abort', 'context-abort', 'configuration-revoked']) {
  test(`${stop} cancels a deferred SDK wait and a hanging preflight without retry`, { timeout: 8000 }, async t => {
    const parent = new AbortController(), invocation = new AbortController()
    let current = true
    const f = await stdioFixture(t, { signal: parent.signal, isCurrent: () => current })
    const definition = f.get('slow'), lookup = f.get('lookup'), { context } = await execution(f.handle, definition, {}, { signal: invocation.signal })
    const pending = definition.execute({}, context)
    let entered
    const started = new Promise(resolve => { entered = resolve })
    const preflight = lookup.execute(valid(), { ...context, ensureCurrent: async () => { entered(); await new Promise(() => {}) } })
    await started
    await waitFor(async () => (await f.calls('slow')).length === 1, 'deferred call before cancellation')
    const began = Date.now()
    const closing = stop === 'close' ? f.handle.close() : undefined
    if (stop === 'parent-abort') parent.abort()
    if (stop === 'context-abort') invocation.abort()
    if (stop === 'configuration-revoked') current = false
    const [result, before] = await Promise.all([pending, preflight])
    assert.equal(result.status, 'unknown')
    assert.equal(before.status, 'failed')
    assert.ok(Date.now() - began < 500, 'cancellation stops waiting before the configured deadline')
    assert.ok(!JSON.stringify(result).includes('LATE_REMOTE_RESULT_MUST_NOT_BE_ACCEPTED'))
    assert.equal((await f.calls('slow')).length, 1)
    assert.equal((await f.calls('lookup')).length, 0)
    if (stop === 'context-abort') {
      assert.equal(definition.isCurrent(), true)
      const fresh = await execution(f.handle, lookup, valid())
      assert.equal((await fresh.executor.execute(fresh.action, fresh.context)).status, 'succeeded')
    } else {
      await closing
      await waitFor(() => !definition.isCurrent(), 'revoked deferred generation')
      assert.deepEqual(f.handle.getDeferredDefinitions(), [])
      assert.equal((await definition.execute({}, context)).status, 'failed')
    }
  })
}

test('a real remote side effect that exceeds the deferred timeout stays unknown and is never replayed after its late result', { timeout: 8000 }, async t => {
  const f = await stdioFixture(t, { config: { toolCallTimeoutMs: 100 } }), definition = f.get('slow')
  const { context } = await execution(f.handle, definition)
  const result = await definition.execute({}, context)
  assert.equal(result.status, 'unknown')
  await waitFor(async () => (await f.events()).some(row => row.event === 'late-result'), 'ignored late deferred result')
  assert.equal((await f.calls('slow')).length, 1)
  assert.equal((await f.events()).filter(row => row.event === 'start').length, 1)
  assert.ok(!JSON.stringify(result).includes('LATE_REMOTE_RESULT_MUST_NOT_BE_ACCEPTED'))
})

test('stdio definition fingerprints survive restart and capture an immutable snapshot of the original server configuration', { timeout: 8000 }, async t => {
  const f = await stdioFixture(t), original = f.get('lookup'), fingerprint = original.definitionId
  f.config.env.MCP_EXPLICIT_VALUE = 'changed-host-configuration'
  assert.equal(f.get('lookup').definitionId, fingerprint)
  assert.equal(original.isCurrent(), true)
  const initial = f.config.env.MCP_EXPLICIT_VALUE
  f.config.env.MCP_EXPLICIT_VALUE = secret
  await f.open()
  assert.equal(original.isCurrent(), false)
  assert.equal(f.get('lookup').definitionId, fingerprint)
  f.config.env.MCP_EXPLICIT_VALUE = initial
  await f.open()
  assert.notEqual(f.get('lookup').definitionId, fingerprint)
  assert.ok(!f.get('lookup').definitionId.includes(initial))
})

test('HTTP fingerprints canonicalize field order and change with schema, metadata, server version and effective configuration', { timeout: 12000 }, async t => {
  let version = '1.0.0', descriptor = { name: 'lookup', description: 'original tool', inputSchema: {
    type: 'object', properties: { count: { type: 'integer', minimum: 1, maximum: 3 } }, required: ['count'], additionalProperties: false,
  } }, remote, transport, handle
  const errors = []
  const http = createServer(async (request, response) => {
    try {
      let body
      if (request.method === 'POST') { let text = ''; for await (const chunk of request) text += chunk; body = JSON.parse(text) }
      await transport.handleRequest(request, response, body)
    } catch (error) { errors.push(error); if (!response.headersSent) response.writeHead(500).end() }
  })
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await handle?.close(); await remote?.close(); await transport?.close()
    http.closeAllConnections(); await new Promise(resolve => http.close(resolve))
  })
  const config = { type: 'http', baseUrl: `http://127.0.0.1:${http.address().port}/mcp`,
    headers: { Authorization: 'Bearer local-only-fingerprint-token', 'X-Fixture': 'fixed' },
    includeTools: ['lookup', 'other'], excludeTools: ['excluded', 'hidden'],
    connectTimeoutMs: 2000, toolCallTimeoutMs: 1000, autoReconnect: false }
  let serial = 0
  async function open(changes = {}) {
    await handle?.close(); await remote?.close(); await transport?.close()
    remote = new Server({ name: 'deferred-http-fixture', version }, { capabilities: { tools: { listChanged: true } } })
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => `deferred-http-${++serial}`, enableJsonResponse: true })
    remote.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [structuredClone(descriptor)] }))
    remote.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'unused' }] }))
    await remote.connect(transport)
    handle = await openAgentMcpTools({ servers: { server: { ...config, ...changes } } })
    return get(handle, 'lookup')
  }
  const first = await open(), fingerprint = first.definitionId
  const second = await open({ headers: { 'X-Fixture': 'fixed', Authorization: config.headers.Authorization },
    includeTools: ['other', 'lookup'], excludeTools: ['hidden', 'excluded'], reconnectMaxAttempts: 3 })
  assert.equal(second.definitionId, fingerprint)
  assert.equal(first.isCurrent(), false)
  descriptor = { inputSchema: { additionalProperties: false, required: ['count'], properties: { count: { maximum: 3, minimum: 1, type: 'integer' } }, type: 'object' },
    description: 'original tool', name: 'lookup' }
  assert.equal((await open()).definitionId, fingerprint)
  for (const change of [
    () => { descriptor.inputSchema.properties.count.maximum = 4 },
    () => { descriptor.description = 'revised tool implementation' },
    () => { descriptor.annotations = { destructiveHint: true } },
    () => { version = '2.0.0' },
  ]) {
    const prior = get(handle, 'lookup').definitionId
    change()
    assert.notEqual((await open()).definitionId, prior)
  }
  const current = get(handle, 'lookup').definitionId
  for (const changes of [{ headers: { ...config.headers, Authorization: 'Bearer rotated-local-token' } },
    { baseUrl: `${config.baseUrl}/another` }, { toolCallTimeoutMs: 1100 }, { connectTimeoutMs: 2100 },
    { includeTools: ['lookup'] }, { excludeTools: ['excluded'] }, { autoReconnect: true }, { reconnectMaxAttempts: 2 }]) {
    assert.notEqual((await open(changes)).definitionId, current)
  }
  assert.deepEqual(errors, [])
})
