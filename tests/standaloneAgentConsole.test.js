import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const [{ createStandaloneAgentConsole }, { AGENT_CONSOLE_SERVICES, AgentConsoleError },
  { agentBindingToken, agentConversationKey }] = await Promise.all([
  load('bootstrap/standaloneAgentConsole.js'), load('contracts/agentConsole.js'), load('modules/runtime/domain/agentBindings.js'),
])
const consoleToken = 'fixture-console-token-secret', sessionId = 'fixture-session-secret', modelSecret = 'fixture-model-key-secret'
const json = value => ({ kind: 'json', value })
const route = (operation, handle) => ({ ...AGENT_CONSOLE_SERVICES.find(item => item.operation === operation), handle })
const custom = (path, handle, scope = 'global', method = 'GET', extra = {}) => ({ operation: path.split('/').slice(2).join('.'), method, path, scope, handle, ...extra })
function binding(accountId = '23000101', revision = 'v1') {
  return { source: 'configured', id: `binding-${accountId}`, revision, agentId: 'daily', personaId: 'default', connectionId: `qq-${accountId}`,
    target: { account: { platform: 'qq', namespace: 'global', id: accountId }, kind: 'group', id: '310901' } }
}

test('an opaque authority may synchronously audit a supplied current predicate without revoking it', async t => {
  const observed = []
  let observer, busy = false
  const authority = { signal: new AbortController().signal, isCurrent() {
    if (observer && !busy) {
      busy = true
      try { observed.push(observer()) } finally { busy = false }
    }
    return true
  } }
  const auth = { async state(_credentials, guard) {
    observer = () => guard.isCurrent()
    try { guard.ensureCurrent() } finally { observer = undefined }
    return { hasUser: false, username: null, tokenWorks: false, via: null }
  }, async authenticate() { return undefined }, async authorize() { return 'denied' }, async run() { return {} }, isCurrent() { return true } }
  const f = await fixture(t, [], { authority, auth })
  const response = await fetch(f.base + '/api/auth/state')
  assert.equal(response.status, 200)
  assert.deepEqual(observed, [true])
})

async function fixture(t, services = [], extra = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-console-')), frontendDir = path.join(directory, 'frontend')
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(frontendDir); await writeFile(path.join(frontendDir, 'index.html'), '<!doctype html><title>Static fixture</title>')
  const authority = new AbortController(), bindings = [binding(), binding('23000102')], calls = [], permissions = new Map()
  let current = true, sessionCurrent = true
  const principal = { id: 'console-admin', username: 'admin', via: 'token' }
  const auth = {
    async state(credentials, guard) { guard.ensureCurrent(); return { hasUser: true, username: credentials.cookie === `sid=${sessionId}` ? 'admin' : null,
      tokenWorks: credentials.token === consoleToken, via: credentials.token === consoleToken ? 'token' : credentials.cookie === `sid=${sessionId}` ? 'session' : null } },
    async authenticate(credentials, guard) { guard.ensureCurrent(); return credentials.token === consoleToken ? principal
      : credentials.cookie === `sid=${sessionId}` && sessionCurrent ? { ...principal, via: 'session' } : undefined },
    async run(action, body, credentials, context) {
      calls.push({ action, body, credentials, context }); context.ensureCurrent()
      return { username: 'admin', cookie: `sid=${action === 'logout' ? '' : sessionId}; Path=/; HttpOnly; SameSite=Lax` }
    },
    async authorize(_principal, operation, selected, guard) { guard.ensureCurrent(); return permissions.get(`${operation}:${selected?.target.account.id ?? '*'}`) ?? permissions.get(operation) ?? 'allowed' },
    isCurrent: () => sessionCurrent,
  }
  const options = { frontendDir, port: 0, auth, services, bindings: { list: () => bindings, resolve: target => bindings.find(item => agentConversationKey(item) === agentConversationKey({ agentId: item.agentId, target })) },
    authority: { signal: authority.signal, isCurrent: () => current }, allowsResponse: body => ![consoleToken, sessionId, modelSecret].some(secret => Buffer.from(body).toString().includes(secret)), ...extra }
  const app = createStandaloneAgentConsole(options)
  t.after(() => app.close())
  const address = await app.listen(), base = `http://127.0.0.1:${address.port}`
  const select = (selected = bindings[0]) => ({ scopeKey: agentConversationKey(selected), bindingToken: agentBindingToken(selected) })
  const request = async (pathname, { method = 'GET', body, headers = {}, token = true } = {}) => {
    const response = await fetch(base + pathname, { method, headers: { ...(token ? { 'x-console-token': consoleToken } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const text = await response.text()
    return { response, status: response.status, text, data: response.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(text) : null }
  }
  return { app, base, options, auth, authority, bindings, permissions, calls, principal, request, select,
    setHostCurrent: value => { current = value }, setSessionCurrent: value => { sessionCurrent = value } }
}

test('the standalone HTTP boundary serves existing static assets and exposes known uninstalled capabilities as 503', async t => {
  const f = await fixture(t)
  assert.equal((await f.request('/', { token: false })).status, 200)
  assert.equal((await f.request('/api/tokens/summary', { token: false })).status, 401)
  for (const pathname of ['/api/tokens/summary', '/api/overview/accounts', '/api/ai/config', '/api/health/alerts', '/api/qzone/bots']) {
    assert.deepEqual((await f.request(pathname)).data, { error: 'unavailable' })
    assert.equal((await f.request(pathname)).status, 503)
  }
  assert.equal((await f.request('/api/not-an-operation')).status, 404)
  assert.equal((await f.request('/bl-chat/commands/api/config')).status, 404)
  assert.equal((await f.request('/api/tokens/summary', { method: 'POST' })).status, 405)
  assert.equal((await f.request('/src/contracts/agentConsole.ts')).status, 404)
})

test('the console observes real 5xx faults without reporting expected rejections or disabled features', async t => {
  const failures = []
  const f = await fixture(t, [custom('/api/broken', async () => { throw new Error('private API response') }),
    custom('/api/fault', async () => ({ ...json({ error: 'unavailable' }), status: 503 }))], {
    onRequestFailure: (...event) => failures.push(event),
  })
  assert.equal((await f.request('/api/broken', { token: false })).status, 401)
  assert.equal((await f.request('/api/qzone/bots')).status, 503)
  assert.equal((await f.request('/api/broken')).status, 500)
  assert.equal((await f.request('/api/fault')).status, 503)
  assert.deepEqual(failures, [[500, 'request_failed'], [503, 'console_http_error']])
})

test('authentication keeps cookie/token compatibility without forwarding credentials to business services', async t => {
  let received
  const f = await fixture(t, [custom('/api/echo', async (request, context) => { received = { request, context }; return json({ value: 7 }) })])
  const state = await f.request('/api/auth/state')
  assert.deepEqual(state.data, { hasUser: true, username: null, tokenWorks: true, via: 'token' })
  assert.equal(state.text.includes(consoleToken), false)
  const login = await f.request('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'fixture-password' }, token: false })
  assert.equal(login.status, 200); assert.match(login.response.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/u)
  assert.equal(login.text.includes(sessionId), false); assert.equal(f.calls[0].body.password, 'fixture-password')
  assert.equal((await f.request(`/api/echo?token=${consoleToken}&limit=4`, { token: false })).status, 200)
  assert.deepEqual({ ...received.request.query }, { limit: '4' }); assert.equal(received.context.principal.via, 'token')
  assert.equal(JSON.stringify(received).includes(consoleToken), false); assert.equal(JSON.stringify(received).includes('cookie'), false)
  const byCookie = await f.request('/api/echo', { token: false, headers: { cookie: `sid=${sessionId}` } })
  assert.equal(byCookie.status, 200); assert.equal(received.context.principal.via, 'session')
  assert.equal(JSON.stringify(received).includes(sessionId), false)
  assert.equal((await f.request('/api/auth/password', { method: 'POST', body: { oldPassword: 'old', newPassword: 'new' } })).status, 401)
  assert.equal((await f.request('/api/auth/password', { method: 'POST', token: false, headers: { cookie: `sid=${sessionId}` }, body: { oldPassword: 'old', newPassword: 'new' } })).status, 200)
  assert.equal((await f.request('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'x', isMaster: true } })).status, 400)
  assert.equal((await f.request('/api/auth/state', { method: 'POST' })).status, 405)
})

test('the binding directory returns exact host snapshots and filters inaccessible conversations', async t => {
  const f = await fixture(t)
  f.permissions.set('bindings.read:23000102', 'denied')
  const result = await f.request('/api/bindings')
  assert.equal(result.status, 200); assert.equal(result.data.bindings.length, 1)
  assert.deepEqual(result.data.bindings[0], { ...f.select(), binding: f.bindings[0] })
  f.permissions.set('bindings.read:23000102', 'unavailable')
  assert.equal((await f.request('/api/bindings')).status, 503)
  f.permissions.set('bindings.list', 'denied')
  assert.equal((await f.request('/api/bindings')).status, 403)
})

test('a completed HTTP request expires its service guard even while the host and session remain current', async t => {
  let captured
  const f = await fixture(t, [custom('/api/lifetime', async (_request, context) => { captured = context; return json({ ok: true }) })])
  assert.equal((await f.request('/api/lifetime')).status, 200)
  assert.equal(f.auth.isCurrent(f.principal), true); assert.equal(f.options.authority.isCurrent(), true)
  assert.equal(captured.signal.aborted, true); assert.equal(captured.isCurrent(), false)
  assert.throws(() => captured.ensureCurrent(), { code: 'conflict' })
})

test('retired execution leaves only authenticated workspace, config-state and metadata observation reads available', async t => {
  const execution = new AbortController(), received = [], invoked = []
  const services = [route('workspace.read', async (_request, context) => {
    received.push(context); return json({ robots: [{ id: 'daily' }], phase: 'requires-restart' })
  }), route('config-state.read', async (_request, context) => {
    received.push(context); return json({ phase: 'requires-restart' })
  }), route('observe.read', async (_request, context) => {
    received.push(context); return json({ phase: 'requires-restart', events: [] })
  }), route('tokens.summary', async () => { invoked.push('tokens'); return json({ tokens: 7 }) }),
  route('accounts.action', async () => { invoked.push('action'); return json({ ok: true }) }),
  custom('/api/workspace/extra', async () => { invoked.push('extra'); return json({ ok: true }) })]
  const f = await fixture(t, services, { execution: { signal: execution.signal, isCurrent: () => !execution.signal.aborted } })
  execution.abort()
  for (const pathname of ['/api/workspace', '/api/config-state', '/api/observe/summary']) {
    assert.equal((await f.request(pathname, { token: false })).status, 401)
    for (const options of [{}, { token: false, headers: { cookie: `sid=${sessionId}` } }]) {
      const result = await f.request(pathname, options)
      assert.equal(result.status, 200); assert.equal(result.data.phase, 'requires-restart')
      const context = received.at(-1)
      assert.equal(context.signal.aborted, true); assert.equal(context.isCurrent(), false)
      assert.throws(() => context.ensureCurrent(), { code: 'conflict' })
    }
  }
  for (const pathname of ['/api/tokens/summary', '/api/bindings', '/api/simulation/overview', '/api/workspace/extra']) {
    assert.equal((await f.request(pathname)).status, 409)
  }
  assert.equal((await f.request('/api/accounts/action', { method: 'POST', body: {} })).status, 409)
  assert.equal((await f.request('/api/workspace', { method: 'POST', body: {} })).status, 405)
  assert.deepEqual(invoked, [])
})

test('retired host metadata reads still enforce permissions, secret filtering and session and host revocation', async t => {
  const execution = new AbortController()
  let payload = { robots: [] }, calls = 0
  const handler = async () => { calls++; return json(payload) }
  const f = await fixture(t, [route('workspace.read', handler), route('config-state.read', handler), route('observe.read', handler)],
    { execution: { signal: execution.signal, isCurrent: () => false } })
  execution.abort()
  for (const [pathname, operation] of [['/api/workspace', 'workspace.read'], ['/api/config-state', 'config-state.read'], ['/api/observe/summary', 'observe.read']]) {
    for (const [decision, status] of [['denied', 403], ['unavailable', 503]]) {
      f.permissions.set(operation, decision)
      assert.equal((await f.request(pathname)).status, status)
    }
    f.permissions.set(operation, 'allowed')
  }
  assert.equal(calls, 0)
  payload = { apiKey: modelSecret }
  for (const pathname of ['/api/workspace', '/api/config-state', '/api/observe/summary']) {
    const filtered = await f.request(pathname)
    assert.equal(filtered.status, 500); assert.deepEqual(filtered.data, { error: 'request_failed' })
    assert.equal(filtered.text.includes(modelSecret), false)
  }
  payload = { robots: [] }
  const beforeRevocation = calls, original = f.auth.authorize
  f.auth.authorize = async (...args) => { const decision = await original(...args); f.setSessionCurrent(false); return decision }
  for (const pathname of ['/api/workspace', '/api/config-state', '/api/observe/summary']) {
    f.setSessionCurrent(true)
    assert.equal((await f.request(pathname)).status, 409); assert.equal(calls, beforeRevocation)
    assert.equal((await f.request(pathname, { token: false, headers: { cookie: `sid=${sessionId}` } })).status, 401)
  }
  f.setSessionCurrent(true); f.auth.authorize = original; f.setHostCurrent(false)
  for (const pathname of ['/api/workspace', '/api/config-state', '/api/observe/summary']) assert.equal((await f.request(pathname)).status, 409)
  assert.equal(calls, beforeRevocation)
})

test('conversation services require complete binding selectors and isolate equal group IDs across accounts', async t => {
  const received = []
  const f = await fixture(t, [route('simulation.group-read', async (request, context) => {
    received.push({ request, context }); return json({ groupId: context.binding.target.id, account: context.binding.target.account.id })
  }), route('simulation.group-write', async (request, context) => {
    context.ensureCurrent(); received.push({ request, context }); return json({ ok: true })
  })])
  for (const selected of f.bindings) {
    const result = await f.request('/api/simulation/group?' + new URLSearchParams({ ...f.select(selected), group: selected.target.id }))
    assert.equal(result.status, 200); assert.equal(result.data.account, selected.target.account.id)
    assert.deepEqual(received.at(-1).context.binding, selected); assert.equal(Object.isFrozen(received.at(-1).context.binding.target.account), true)
    assert.equal(Object.hasOwn(received.at(-1).request.query, 'scopeKey'), false)
  }
  assert.equal((await f.request('/api/simulation/group?group=310901')).status, 400)
  for (const change of [{ revision: 'stale' }, { connectionId: 'wrong-connection' }, { personaId: 'wrong-persona' }, { id: 'wrong-id' }]) {
    const stale = { ...f.bindings[0], ...change }, result = await f.request('/api/simulation/group?' + new URLSearchParams(f.select(stale)))
    assert.equal(result.status, 409)
  }
  assert.equal((await f.request('/api/simulation/group', { method: 'POST', body: { ...f.select(), action: 'disable' } })).status, 200)
  assert.equal(Object.hasOwn(received.at(-1).request.body, 'bindingToken'), false)
  assert.equal((await f.request('/api/simulation/group?' + new URLSearchParams(f.select()), { method: 'POST', body: { ...f.select(f.bindings[1]), action: 'disable' } })).status, 400)
})

test('permission denial and unavailable authorization prevent reads and side effects', async t => {
  let invoked = 0
  const f = await fixture(t, [custom('/api/work', async () => { invoked++; return json({ ok: true }) }, 'conversation', 'POST')])
  for (const [decision, expected] of [['denied', 403], ['unavailable', 503]]) {
    f.permissions.set('work', decision)
    assert.equal((await f.request('/api/work', { method: 'POST', body: f.select() })).status, expected)
  }
  assert.equal(invoked, 0)
  f.permissions.set('work', 'allowed'); f.setSessionCurrent(false)
  assert.equal((await f.request('/api/work', { method: 'POST', body: f.select() })).status, 409); assert.equal(invoked, 0)
})

test('host/session/binding revocation during awaited authentication and permission checks cancels dispatch', async t => {
  for (const stage of ['authentication', 'authorization']) {
    for (const revoked of ['host', 'session', 'binding']) {
      let invoked = 0
      const f = await fixture(t, [custom('/api/work', async () => { invoked++; return json({ ok: true }) }, 'conversation', 'POST')])
      const method = stage === 'authentication' ? 'authenticate' : 'authorize', original = f.auth[method]
      f.auth[method] = async (...args) => {
        const result = await original(...args)
        if (revoked === 'host') f.setHostCurrent(false)
        if (revoked === 'session') f.setSessionCurrent(false)
        if (revoked === 'binding') f.bindings[0] = { ...f.bindings[0], revision: 'withdrawn' }
        return result
      }
      assert.equal((await f.request('/api/work', { method: 'POST', body: f.select() })).status, 409, `${stage} ${revoked}`)
      assert.equal(invoked, 0)
    }
  }
})

test('the service guard prevents a queued mutation and suppresses results after a binding is withdrawn', async t => {
  let commits = 0, f
  const work = custom('/api/work', async (_request, context) => {
    await Promise.resolve()
    f.bindings[0] = { ...f.bindings[0], revision: 'rebound' }
    context.ensureCurrent(); commits++; return json({ ok: true })
  }, 'conversation', 'POST')
  f = await fixture(t, [work])
  assert.equal((await f.request('/api/work', { method: 'POST', body: f.select() })).status, 409); assert.equal(commits, 0)
  work.path = '/api/changed-after-start'; work.handle = async () => { commits++; return json({ ok: true }) }
  assert.equal((await f.request('/api/changed-after-start', { method: 'POST', body: f.select() })).status, 404)
  assert.equal(commits, 0)
})

test('secret-bearing service/auth results and upstream exception messages never reach the browser', async t => {
  const f = await fixture(t, [custom('/api/leak', async () => json({ apiKey: modelSecret })),
    custom('/api/throws', async () => { throw new Error(`upstream leaked ${modelSecret}`) }),
    custom('/api/bad-code', async () => { throw new AgentConsoleError(modelSecret) }),
    custom('/api/token', async () => json({ token: consoleToken })),
    custom('/api/binary', async () => ({ kind: 'bytes', value: Buffer.from(sessionId), contentType: 'text/plain' }))])
  for (const pathname of ['/api/leak', '/api/throws', '/api/bad-code', '/api/token', '/api/binary']) {
    const result = await f.request(pathname)
    assert.equal(result.status, 500); assert.deepEqual(result.data, { error: 'request_failed' }); assert.equal(result.text.includes('fixture-'), false)
  }
  f.auth.run = async () => ({ username: 'admin', message: modelSecret, cookie: `sid=${sessionId}; HttpOnly; SameSite=Lax` })
  const login = await f.request('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'x' } })
  assert.equal(login.status, 500); assert.equal(login.response.headers.get('set-cookie'), null)
  f.auth.run = async () => ({ username: 'admin', cookie: `sid=${sessionId}; Path=/` })
  const unsafe = await f.request('/api/auth/login', { method: 'POST', body: {} })
  assert.equal(unsafe.status, 500); assert.equal(unsafe.response.headers.get('set-cookie'), null)
})

test('bounded multipart input and binary output preserve the existing image service boundary', async t => {
  let received
  const f = await fixture(t, [route('images.edit', async (request, context) => { received = { request, context }; return json({ image: '/img/example.png' }) }),
    route('images.read', async request => ({ kind: 'bytes', value: Buffer.from([1, 2, 3]), contentType: 'image/png' }))])
  const bytes = Buffer.from('--boundary\r\nfixture-upload\r\n--boundary--')
  const response = await fetch(f.base + '/api/image/edit', { method: 'POST', headers: { 'x-console-token': consoleToken, 'content-type': 'multipart/form-data; boundary=boundary' }, body: bytes })
  assert.equal(response.status, 200); assert.deepEqual(Buffer.from(received.request.bytes), bytes)
  assert.equal(received.request.contentType, 'multipart/form-data; boundary=boundary'); assert.equal(Object.hasOwn(received.request, 'credentials'), false)
  const image = await fetch(f.base + '/img/example.png', { headers: { 'x-console-token': consoleToken } })
  assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from([1, 2, 3]))
})

test('incoming cookies, newly submitted secrets and newly issued sessions are filtered even before the host credential inventory refreshes', async t => {
  const transientSecret = 'new-credential-not-in-host-inventory'
  const f = await fixture(t, [custom('/api/echo-secret', async request => json({ value: request.body.provider.apiKey }), 'global', 'POST'),
    custom('/api/echo-cookie', async () => json({ value: sessionId }))])
  f.options.allowsResponse = () => true
  const submitted = await f.request('/api/echo-secret', { method: 'POST', body: { provider: { apiKey: transientSecret } } })
  assert.equal(submitted.status, 500); assert.equal(submitted.text.includes(transientSecret), false)
  const cookie = await f.request('/api/echo-cookie', { token: false, headers: { cookie: `sid=${sessionId}` } })
  assert.equal(cookie.status, 500); assert.equal(cookie.text.includes(sessionId), false)
  f.auth.run = async () => ({ username: 'admin', message: transientSecret, cookie: `sid=${sessionId}; HttpOnly; SameSite=Lax` })
  const password = await f.request('/api/auth/login', { method: 'POST', body: { username: 'admin', password: transientSecret } })
  assert.equal(password.status, 500); assert.equal(password.response.headers.get('set-cookie'), null)
  f.auth.run = async () => ({ username: 'admin', message: sessionId, cookie: `sid=${sessionId}; HttpOnly; SameSite=Lax` })
  const issued = await f.request('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'fixture-password' } })
  assert.equal(issued.status, 500); assert.equal(issued.response.headers.get('set-cookie'), null)
})

test('invalid paths, duplicate selectors, oversized bodies, cross-origin writes and global binding aliases fail before services run', async t => {
  let invoked = 0
  const f = await fixture(t, [custom('/api/work', async () => { invoked++; return json({ ok: true }) }, 'global', 'POST', { maxBodyBytes: 64 })])
  for (const pathname of ['/api/work?token=a&token=b', '/api/work?limit=1&limit=2', '/api/work%2ffoo']) {
    assert.equal((await f.request(pathname, { method: 'POST', body: {} })).status, 400)
  }
  assert.equal((await f.request('/api/work', { method: 'POST', body: { value: 'x'.repeat(100) } })).status, 413)
  assert.equal((await f.request('/api/work', { method: 'POST', body: { ...f.select() } })).status, 413)
  assert.equal((await f.request('/api/work?scopeKey=bad', { method: 'POST', body: {} })).status, 400)
  assert.equal((await f.request('/api/work', { method: 'POST', body: {}, headers: { origin: 'https://external.invalid' } })).status, 403)
  assert.equal((await f.request('/api/work', { method: 'POST', body: {}, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
  const malformed = await fetch(f.base + '/api/work', { method: 'POST', headers: { 'x-console-token': consoleToken, 'content-type': 'application/json' }, body: '{' })
  assert.equal(malformed.status, 400); await malformed.body.cancel()
  assert.equal(invoked, 0)
})

test('shutdown aborts in-flight work and closes the HTTP listener', async t => {
  let entered, signal, release
  const started = new Promise(resolve => { entered = resolve }), blocked = new Promise(resolve => { release = resolve })
  const f = await fixture(t, [custom('/api/work', async (_request, context) => { signal = context.signal; entered(); await blocked; context.ensureCurrent(); return json({ ok: true }) })])
  const request = f.request('/api/work').catch(() => null)
  await started; f.authority.abort(); release(); await f.app.close(); await request
  assert.equal(signal.aborted, true); assert.equal(f.app.server.listening, false)
  await assert.rejects(f.app.listen(), { code: 'unavailable' })
})

test('a restart drains the in-flight HTTP response before expiring its authority', async t => {
  const ready = Promise.withResolvers()
  const release = Promise.withResolvers()
  const f = await fixture(t, [route('config-state.read', async (_request, context) => {
    ready.resolve()
    await release.promise
    context.ensureCurrent()
    return json({ committedRevision: 'synthetic-revision' })
  })])
  const pending = f.request('/api/config-state')
  await ready.promise
  const closing = f.app.close('restart')
  release.resolve()
  const response = await pending
  assert.equal(response.status, 200)
  assert.deepEqual(response.data, { committedRevision: 'synthetic-revision' })
  await closing
  assert.equal(f.app.server.listening, false)
})

test('invalid or downgraded service declarations cannot reserve auth routes or replace scoped handlers', async t => {
  const f = await fixture(t)
  for (const services of [[custom('/api/auth/evil', async () => json({}))], [custom('/api/bindings', async () => json({}))],
    [custom('/api/work', async () => json({})), custom('/api/work', async () => json({}))],
    [{ ...route('simulation.group-read', async () => json({})), scope: 'global' }],
    [custom('/api/work', async () => json({}), 'global', 'POST', { maxBodyBytes: 1e9 })]]) {
    assert.throws(() => createStandaloneAgentConsole({ ...f.options, services }), /控制台服务/u)
  }
})
