import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import fsPromises from 'node:fs/promises'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url)), release = path.resolve(process.env.BL_CHAT_AGENT_RELEASE_DIR || root)
const sourceTest = process.env.BL_CHAT_AGENT_SOURCE_TEST === '1', ts = sourceTest ? (await import('typescript')).default : undefined, urls = new Map()
function moduleUrl(relative) {
  if (!sourceTest) return pathToFileURL(path.join(release, relative.replace(/^src\//u, 'dist/backend/').replace(/\.ts$/u, '.js'))).href
  if (urls.has(relative)) return urls.get(relative)
  const compiled = ts.transpileModule(readFileSync(path.join(root, relative), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  const code = compiled.replace(/(\bfrom\s+)(['"])(\.[^'"]+)\2/gu, (_all, from, quote, specifier) => {
    const dependency = path.relative(root, path.resolve(root, path.dirname(relative), specifier))
    return `${from}${quote}${/^agentBilibiliAuth/u.test(path.basename(dependency)) ? moduleUrl(dependency.replace(/\.js$/u, '.ts')) : pathToFileURL(path.join(root, dependency.replace(/^src\//u, 'dist/backend/'))).href}${quote}`
  }).replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(root, relative)).href))
  const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`; urls.set(relative, url); return url
}
const { openAgentBilibiliAuthService } = await import(moduleUrl('src/modules/media/infrastructure/agentBilibiliAuthService.ts'))
const KEY = 'BILIBILI_QR_PRIVATE_1234567890123456', SESS = 'SESS_PRIVATE_123456789,1700000000,abc*11Cj', JCT = '0123456789abcdef0123456789abcdef', USER = '123456789'
const COOKIE = `SESSDATA=${SESS}; bili_jct=${JCT}; DedeUserID=${USER}`, AT = 1_790_000_000_000
const QR_URL = `https://passport.bilibili.com/h5-app/passport/login/scan?navhide=1&qrcode_key=${KEY}&from=main_web`
const CALLBACK = `https://passport.biligame.com/crossDomain?SESSDATA=${encodeURIComponent(SESS)}&bili_jct=${JCT}&DedeUserID=${USER}&DedeUserID__ckMd5=abc&Expires=0&gourl=https%3A%2F%2Fwww.bilibili.com`
const binding = (changes = {}) => ({ source: 'configured', id: 'binding-one', revision: 'rev-one', agentId: 'daily', personaId: 'default', connectionId: 'main', target: { account: { platform: 'qq', namespace: 'global', id: '900001' }, kind: 'group', id: '900002' }, ...changes })
const context = (changes = {}) => ({ signal: new AbortController().signal, isCurrent: () => true, ...changes })
const generated = () => ({ code: 0, message: '', data: { qrcode_key: KEY, url: QR_URL } })
const polled = (code = 0, changes = {}) => ({ code: 0, message: '', data: { code, message: '', url: code === 0 ? CALLBACK : '', refresh_token: code === 0 ? 'REFRESH_PRIVATE_012345' : '', timestamp: 0, ...changes } })
const httpResponse = body => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function fixture(t, settings = {}) {
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), 'bilibili-auth-test-'))), directory = path.join(parent, 'credentials'), requests = [], secrets = [], events = []
  let lease = true, at = AT
  const options = { directory, isLeaseCurrent: () => lease, registerSecrets: values => { secrets.push(...values) }, now: () => at, timeoutMs: 500,
    diagnostics: { emit: event => events.push(event) }, lookup: async host => { assert.equal(host, 'passport.bilibili.com'); return [{ address: '93.184.216.34', family: 4 }] },
    request: async (url, address, signal, policy) => {
      assert.deepEqual(address, { address: '93.184.216.34', family: 4 }); assert.equal(url.hostname, 'passport.bilibili.com'); assert.equal(url.protocol, 'https:')
      assert.equal(policy.maxBytes, 32768); assert.equal(policy.headers.Cookie, undefined); assert.equal(policy.headers.Authorization, undefined)
      requests.push({ url: new URL(url), signal, policy })
      if (settings.respond) return settings.respond(url, signal, requests.length)
      return httpResponse(url.pathname.endsWith('/generate') ? generated() : polled())
    }, ...settings.options }
  const service = await openAgentBilibiliAuthService(options)
  t.after(async () => { await service.close(); await rm(parent, { recursive: true, force: true }) })
  return { parent, directory, service, requests, secrets, events, options, setLease(value) { lease = value }, setTime(value) { at = value },
    async files() { return (await readdir(directory)).map(name => path.join(directory, name)) },
    async login(selected = binding()) { const session = await service.start(selected, context()); assert.equal(await session.poll(context()), 'success'); return session },
  }
}

test('QR service performs explicit bounded polls and registers secrets while exposing only PNG and status', async t => {
  const states = [86090, 86101, 0]
  const f = await fixture(t, { respond: async url => httpResponse(url.pathname.endsWith('/generate') ? generated() : polled(states.shift())) })
  assert.deepEqual(await f.service.status(binding(), context()), { authorized: false }); assert.equal(f.requests.length, 0)
  const session = await f.service.start(binding(), context())
  assert.equal(session.expiresAt, AT + 170000); assert.deepEqual(Object.keys(session).sort(), ['cancel', 'expiresAt', 'image', 'poll']); assert.equal(session.image.mime, 'image/png')
  assert.equal(Buffer.from(session.image.base64, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); assert.equal(f.requests.length, 1)
  assert.equal(await session.poll(context()), 'waiting'); assert.equal(await session.poll(context()), 'waiting'); assert.equal(await session.poll(context()), 'success')
  assert.equal(f.requests.length, 4); assert.ok(f.requests.every(row => ['/x/passport-login/web/qrcode/generate', '/x/passport-login/web/qrcode/poll'].includes(row.url.pathname)))
  assert.ok(f.requests.slice(1).every(row => [...row.url.searchParams.keys()].join() === 'qrcode_key' && row.url.searchParams.get('qrcode_key') === KEY))
  assert.deepEqual(await f.service.status(binding(), context()), { authorized: true, updatedAt: AT }); assert.equal(await f.service.credential(binding(), context()), COOKIE)
  for (const secret of [KEY, QR_URL, CALLBACK, COOKIE, SESS, JCT, USER, session.image.base64, 'REFRESH_PRIVATE_012345']) assert.ok(f.secrets.includes(secret))
  assert.equal(JSON.stringify(await f.service.status(binding(), context())).includes(SESS), false); assert.deepEqual(f.events, [])
  const [file] = await f.files(); assert.equal((await lstat(f.directory)).mode & 0o7777, 0o700); assert.equal((await lstat(file)).mode & 0o7777, 0o600); assert.equal((await lstat(file)).nlink, 1)
  const stored = JSON.parse(await readFile(file, 'utf8')); assert.equal(stored.cookie, COOKIE); assert.equal(stored.owner, JSON.stringify(['qq', 'global', '900001', 'daily']))
  await f.service.logout(binding(), context()); assert.deepEqual(await f.service.status(binding(), context()), { authorized: false }); assert.deepEqual(await f.files(), [])
})

test('credentials persist per complete account and Agent across groups, connections, revisions and process reopen', async t => {
  const f = await fixture(t); await f.login()
  const changed = binding({ id: 'other-binding', revision: 'updated', connectionId: 'replacement', personaId: 'new-persona', target: { ...binding().target, id: 'other-group', kind: 'private' } })
  assert.equal(await f.service.credential(changed, context()), COOKIE)
  for (const other of [binding({ agentId: 'another' }), ...['platform', 'namespace', 'id'].map(key => binding({ target: { ...binding().target, account: { ...binding().target.account, [key]: 'another' } } }))]) assert.equal(await f.service.credential(other, context()), undefined)
  await f.service.close(); const reopened = await openAgentBilibiliAuthService(f.options); t.after(() => reopened.close())
  assert.equal(await reopened.credential(changed, context()), COOKIE)
})

test('expiry and official expired state never persist a credential or initiate background polling', async t => {
  const f = await fixture(t); const session = await f.service.start(binding(), context()); f.setTime(AT + 170000)
  assert.equal(await session.poll(context()), 'expired'); assert.equal(await session.poll(context()), 'expired'); assert.equal(f.requests.length, 1); assert.deepEqual(await f.files(), [])
  const expired = await fixture(t, { respond: async url => httpResponse(url.pathname.endsWith('/generate') ? generated() : polled(86038)) })
  const second = await expired.service.start(binding(), context()); assert.equal(await second.poll(context()), 'expired'); assert.equal(await second.poll(context()), 'expired'); assert.equal(expired.requests.length, 2)
})

test('logout invalidates an in-flight poll and a late successful login cannot recreate credentials', async t => {
  const entered = deferred(), late = deferred(); let closed = false
  const f = await fixture(t, { respond: async (url, signal) => { if (url.pathname.endsWith('/generate')) return httpResponse(generated()); entered.resolve(signal); return late.promise } })
  const session = await f.service.start(binding(), context()), polling = session.poll(context()), rejected = assert.rejects(polling, /B站授权服务不可用/u), signal = await entered.promise
  await f.service.logout(binding(), context()); await rejected; assert.equal(signal.aborted, true)
  late.resolve({ ...httpResponse(polled()), close() { closed = true } }); await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(closed, true); assert.equal(await f.service.credential(binding(), context()), undefined); assert.deepEqual(await f.files(), [])
  await assert.rejects(session.poll(context()), /B站授权服务不可用/u)
})

test('replacement sessions, cancellation, host lease loss and close revoke active operations', async t => {
  const f = await fixture(t), first = await f.service.start(binding(), context()), second = await f.service.start(binding(), context())
  await assert.rejects(first.poll(context()), /B站授权服务不可用/u); second.cancel(); await assert.rejects(second.poll(context()), /B站授权服务不可用/u)
  for (const revoke of ['lease', 'close']) {
    const entered = deferred(), late = deferred()
    const active = await fixture(t, { respond: async url => { if (url.pathname.endsWith('/generate')) return httpResponse(generated()); entered.resolve(); return late.promise } })
    const session = await active.service.start(binding(), context()), pending = session.poll(context()), rejected = assert.rejects(pending, /B站授权服务不可用/u); await entered.promise
    if (revoke === 'lease') active.setLease(false); else await active.service.close()
    await rejected; assert.equal(active.requests[1].signal.aborted, true); late.resolve(httpResponse(polled())); assert.deepEqual(await active.files(), [])
  }
})

test('aborted or stale caller guards fail before DNS and concurrent polls cannot race credential commits', async t => {
  const f = await fixture(t), aborted = new AbortController(); aborted.abort()
  for (const invalid of [context({ signal: aborted.signal }), context({ isCurrent: () => false }), context({ ensureCurrent: async () => { throw new Error(SESS) } })]) await assert.rejects(f.service.start(binding(), invalid), /B站授权服务不可用/u)
  assert.equal(f.requests.length, 0)
  const entered = deferred(), late = deferred(), concurrent = await fixture(t, { respond: async url => { if (url.pathname.endsWith('/generate')) return httpResponse(generated()); entered.resolve(); return late.promise } })
  const session = await concurrent.service.start(binding(), context()), pending = session.poll(context()); await entered.promise
  await assert.rejects(session.poll(context()), /B站授权服务不可用/u); late.resolve(httpResponse(polled())); assert.equal(await pending, 'success'); assert.equal(concurrent.requests.length, 2)
})

test('all DNS answers must be public and numeric addresses stay pinned to the fixed passport endpoints', async t => {
  for (const addresses of [[], [{ address: '127.0.0.1', family: 4 }], [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }], [{ address: '::ffff:127.0.0.1', family: 6 }], [{ address: '93.184.216.34', family: 6 }]]) {
    const f = await fixture(t, { options: { lookup: async () => addresses } }); await assert.rejects(f.service.start(binding(), context()), /B站授权服务不可用/u); assert.equal(f.requests.length, 0)
  }
})

test('HTTP redirects, oversized streams, decompression, invalid MIME and body mismatches fail closed with static diagnostics', async t => {
  const cases = [
    { status: 302, headers: { location: 'http://127.0.0.1/private' }, body: '' },
    { status: 200, headers: { 'content-type': 'text/html' }, body: JSON.stringify(generated()) },
    { status: 200, headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: JSON.stringify(generated()) },
    { status: 200, headers: { 'content-type': 'application/json', 'content-length': '32769' }, body: '{}' },
    { status: 200, headers: { 'content-type': 'application/json', 'content-length': '1' }, body: '{}' },
    { status: 200, headers: { 'content-type': 'application/json' }, body: (async function* () { yield Buffer.alloc(32769) })() },
    { status: 200, headers: { 'content-type': 'application/json' }, body: new Uint8Array([255]) },
    { status: 200, headers: { 'content-type': 'application/json' }, body: '{' },
  ]
  for (const response of cases) {
    let closes = 0; const f = await fixture(t, { respond: async () => ({ ...response, close() { closes++ } }) })
    await assert.rejects(f.service.start(binding(), context()), /B站授权服务不可用/u); assert.equal(f.requests.length, 1); assert.equal(closes, 1); assert.deepEqual(await f.files(), [])
    assert.ok(f.events.some(event => /^auth_http_generate_(?:headers|body|parse)_failed$/u.test(event.code)))
    assert.ok(f.events.some(event => event.code === 'auth_start_failed' && event.outcome === 'failed'))
    assert.ok(f.events.every(event => !JSON.stringify(event).includes(SESS)))
  }
})

test('request and stalled body deadlines cancel the underlying signal without logging response secrets', async t => {
  for (const stage of ['request', 'body']) {
    const never = deferred(), f = await fixture(t, { options: { timeoutMs: 60 }, respond: async () => stage === 'request' ? never.promise : { status: 200, headers: { 'content-type': 'application/json' }, body: { [Symbol.asyncIterator]() { return { next() { return never.promise }, return: async () => ({ done: true }) } } } } })
    await assert.rejects(f.service.start(binding(), context()), /B站授权服务不可用/u); assert.equal(f.requests[0].signal.aborted, true); assert.deepEqual(await f.files(), [])
  }
})

test('QR URL/key and login callback/cookies reject foreign authority, duplicates, injection and invalid fields', async t => {
  for (const data of [
    { ...generated().data, url: 'https://evil.example/scan' }, { ...generated().data, qrcode_key: '../private' },
    { ...generated().data, url: QR_URL.replace('https:', 'http:') }, { ...generated().data, url: QR_URL + '&qrcode_key=' + KEY },
    { ...generated().data, url: QR_URL.replace('/h5-app/', '/other/') }, { ...generated().data, url: QR_URL + '&redirect=http://127.0.0.1' },
  ]) {
    const f = await fixture(t, { respond: async () => httpResponse({ ...generated(), data }) }); await assert.rejects(f.service.start(binding(), context()), /B站授权服务不可用/u); assert.deepEqual(await f.files(), [])
  }
  for (const callback of [CALLBACK.replace('passport.biligame.com', 'evil.example'), CALLBACK.replace('https:', 'http:'), CALLBACK.replace('/crossDomain', '/other'), CALLBACK + '&SESSDATA=duplicate', CALLBACK.replace(encodeURIComponent(SESS), 'secret%0D%0AInjected'), CALLBACK.replace(JCT, 'invalid'), CALLBACK.replace(`DedeUserID=${USER}`, 'DedeUserID=0'), CALLBACK.replace('passport.biligame.com', 'passport.biligame.com:443'), CALLBACK + '&arbitrary=secret']) {
    const f = await fixture(t, { respond: async url => httpResponse(url.pathname.endsWith('/generate') ? generated() : polled(0, { url: callback })) })
    const session = await f.service.start(binding(), context()); await assert.rejects(session.poll(context()), /B站授权服务不可用/u); assert.deepEqual(await f.files(), []); assert.equal(f.requests.length, 2)
  }
})

test('registered auth secrets are allowed solely in designated provider fields and never reflected through other response fields', async t => {
  for (const secret of [KEY, QR_URL]) {
    const f = await fixture(t, { respond: async () => httpResponse({ ...generated(), message: secret }) }); await assert.rejects(f.service.start(binding(), context()), /B站授权服务不可用/u); assert.ok(f.secrets.includes(secret))
  }
  const blocked = await fixture(t, { options: { secrets: ['HOST_PRIVATE_SECRET'], allowsText: value => !value.includes('HOST_PRIVATE_SECRET') }, respond: async () => httpResponse({ ...generated(), data: { ...generated().data, extra: 'HOST_PRIVATE_SECRET' } }) })
  await assert.rejects(blocked.service.start(binding(), context()), error => error.message === 'B站授权服务不可用，请稍后重新发起授权')
  const f = await fixture(t, { respond: async url => httpResponse(url.pathname.endsWith('/generate') ? generated() : { ...polled(), message: SESS }) })
  const session = await f.service.start(binding(), context()); await assert.rejects(session.poll(context()), /B站授权服务不可用/u); assert.ok(f.secrets.includes(SESS)); assert.deepEqual(await f.files(), [])
})

test('vault refuses symlinks, hardlinks, permissive files and mismatched exact owner records', async t => {
  for (const attack of ['symlink', 'hardlink', 'mode', 'owner', 'malformed']) {
    const f = await fixture(t); await f.login(); const [file] = await f.files(), outside = path.join(f.parent, 'outside.json')
    if (attack === 'symlink') { await rename(file, outside); await symlink(outside, file) }
    if (attack === 'hardlink') await link(file, outside)
    if (attack === 'mode') await chmod(file, 0o644)
    if (attack === 'owner') { const value = JSON.parse(await readFile(file, 'utf8')); value.owner = JSON.stringify(['qq', 'global', '900001', 'other']); await writeFile(file, JSON.stringify(value)) }
    if (attack === 'malformed') await writeFile(file, '{')
    await assert.rejects(f.service.credential(binding(), context()), /B站授权服务不可用/u); await assert.rejects(f.service.logout(binding(), context()), /B站授权服务不可用/u)
    assert.ok((await readdir(f.directory)).every(name => !name.endsWith('.tmp')))
  }
})

test('vault refuses permissive or replaced directory inodes and symlink directory paths', async t => {
  const f = await fixture(t); await f.login(); await chmod(f.directory, 0o755); await assert.rejects(f.service.status(binding(), context()), /B站授权服务不可用/u)
  await chmod(f.directory, 0o700); await rename(f.directory, f.directory + '-old'); await mkdir(f.directory, { mode: 0o700 }); await assert.rejects(f.service.status(binding(), context()), /B站授权服务不可用/u)
  await rm(f.directory, { recursive: true }); await symlink(f.directory + '-old', f.directory); await assert.rejects(openAgentBilibiliAuthService(f.options), /B站授权服务不可用/u)
})

function assertSafeDiagnostics(events, originals = []) {
  assert.ok(events.length > 0)
  for (const event of events) {
    assert.match(event.code, /^auth_[a-z_]+$/u)
    assert.ok(['failed', 'cancelled'].includes(event.outcome))
    assert.equal(event.stage, 'runtime')
    for (const original of originals) assert.notEqual(event.error, original)
    if (event.error instanceof Error) {
      assert.equal(event.error.message, ''); assert.equal(event.error.stack, undefined)
      assert.deepEqual(Reflect.ownKeys(event.error), []); assert.equal(Object.isFrozen(event.error), true)
    } else if (event.error !== null) {
      assert.ok(['AbortError', 'TimeoutError'].includes(event.error.name)); assert.deepEqual(Object.keys(event.error), ['name']); assert.equal(Object.isFrozen(event.error), true)
    }
    const text = JSON.stringify(event)
    for (const secret of [KEY, QR_URL, CALLBACK, COOKIE, SESS, JCT, USER, '/private/credentials', 'SECRET_ERROR_TEXT']) assert.equal(text.includes(secret), false)
  }
}

test('session replacement, explicit cancel, logout and service close produce cancellation diagnostics exactly once', async t => {
  const f = await fixture(t), first = await f.service.start(binding(), context()), second = await f.service.start(binding(), context())
  assert.equal(f.events.filter(event => event.code === 'auth_session_replaced').length, 1)
  await assert.rejects(first.poll(context()), /B站授权服务不可用/u)
  second.cancel(); second.cancel()
  assert.equal(f.events.filter(event => event.code === 'auth_session_cancelled').length, 1)
  await assert.rejects(second.poll(context()), /B站授权服务不可用/u)
  const third = await f.service.start(binding(), context()); await f.service.logout(binding(), context())
  assert.equal(f.events.filter(event => event.code === 'auth_logout_cancelled').length, 1)
  await assert.rejects(third.poll(context()), /B站授权服务不可用/u)
  await f.service.start(binding(), context()); await f.service.close(); await f.service.close()
  assert.equal(f.events.filter(event => event.code === 'auth_service_closed').length, 1)
  assert.ok(f.events.every(event => event.outcome === 'cancelled'))
  assertSafeDiagnostics(f.events)
})

test('service deadlines remain failures while external abort, stale callers and failed current checks are cancellations', async t => {
  const never = deferred(), timed = await fixture(t, { options: { timeoutMs: 35 }, respond: () => never.promise })
  await assert.rejects(timed.service.start(binding(), context()), /B站授权服务不可用/u)
  const timeout = timed.events.find(event => event.code === 'auth_start_timeout')
  assert.equal(timeout?.outcome, 'failed'); assert.equal(timeout?.error.name, 'TimeoutError')
  assertSafeDiagnostics(timed.events)
  for (const reason of ['abort', 'stale', 'ensure', 'lease', 'close']) {
    const entered = deferred(), late = deferred(), controller = new AbortController(); let current = true
    const f = await fixture(t, { respond: () => { entered.resolve(); return late.promise } })
    const selected = context({ signal: controller.signal, isCurrent: () => reason === 'ensure' || current, ...(reason === 'ensure' ? { ensureCurrent: async () => { if (!current) throw new TypeError(SESS) } } : {}) })
    const pending = f.service.start(binding(), selected), rejected = assert.rejects(pending, /B站授权服务不可用/u); await entered.promise
    if (reason === 'abort') controller.abort(); else if (reason === 'lease') f.setLease(false); else if (reason === 'close') await f.service.close(); else current = false
    await rejected
    assert.ok(f.events.some(event => event.code === 'auth_start_cancelled' && event.outcome === 'cancelled'))
    assert.equal(f.events.some(event => event.code === 'auth_start_timeout'), false)
    assertSafeDiagnostics(f.events); late.resolve(httpResponse(generated()))
  }
})

test('HTTP failure stages preserve safe native kinds without forwarding exception text, getters, proxies or response secrets', async t => {
  const sensitive = `SECRET_ERROR_TEXT ${COOKIE} ${QR_URL} /private/credentials`
  for (const kind of ['dns', 'request', 'body', 'parse']) {
    const failure = kind === 'dns' ? new RangeError(sensitive) : new TypeError(sensitive)
    const f = await fixture(t, {
      ...(kind === 'dns' ? { options: { lookup: async () => { throw failure } } } : {}),
      respond: async () => {
        if (kind === 'request') throw failure
        if (kind === 'parse') return { ...httpResponse(generated()), body: '{' }
        return { ...httpResponse(generated()), body: { [Symbol.asyncIterator]() { return { async next() { throw failure } } } } }
      },
    })
    await assert.rejects(f.service.start(binding(), context()), /B站授权服务不可用/u)
    const event = f.events.find(event => event.code === `auth_http_generate_${kind}_failed`)
    assert.ok(event); assert.equal(event.error.name, kind === 'dns' ? 'RangeError' : kind === 'parse' ? 'SyntaxError' : 'TypeError')
    assertSafeDiagnostics(f.events, [failure])
  }
  let touched = 0
  const accessor = Object.defineProperties(new Error(sensitive), { name: { get() { touched++; throw new Error(SESS) } }, message: { get() { touched++; throw new Error(SESS) } }, stack: { get() { touched++; throw new Error(SESS) } } })
  const proxy = new Proxy(new Error(sensitive), { get() { touched++; throw new Error(SESS) }, getOwnPropertyDescriptor() { touched++; throw new Error(SESS) }, getPrototypeOf() { touched++; throw new Error(SESS) } })
  for (const failure of [accessor, proxy, new DOMException(sensitive, 'AbortError'), new DOMException(sensitive, 'TimeoutError')]) {
    const f = await fixture(t, { options: { lookup: async () => { throw failure } } })
    await assert.rejects(f.service.start(binding(), context()), /B站授权服务不可用/u); assertSafeDiagnostics(f.events, [failure])
  }
  assert.equal(touched, 0)
})

test('sync and async iterator cleanup and response close failures stay observable without changing successful delivery', async t => {
  for (const asynchronous of [false, true]) {
    const returnError = new TypeError(`SECRET_ERROR_TEXT ${COOKIE}`), closeError = new RangeError(`/private/credentials ${QR_URL}`)
    const f = await fixture(t, { respond: async () => ({ status: 200, headers: { 'content-type': 'application/json' },
      body: { [Symbol.asyncIterator]() { let done = false; return {
        async next() { if (done) return { done: true }; done = true; return { done: false, value: Buffer.from(JSON.stringify(generated())) } },
        return() { if (asynchronous) return Promise.reject(returnError); throw returnError },
      } } }, close() { if (asynchronous) return Promise.reject(closeError); throw closeError },
    }) })
    const session = await f.service.start(binding(), context()); assert.equal(session.image.mime, 'image/png')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.events.filter(event => event.code === 'auth_http_iterator_return_failed').length, 1)
    assert.equal(f.events.filter(event => event.code === 'auth_http_response_close_failed').length, 1)
    assertSafeDiagnostics(f.events, [returnError, closeError])
  }
})

test('a response arriving after cancellation reports failed cleanup without resuming QR delivery', async t => {
  for (const asynchronous of [false, true]) {
    const entered = deferred(), late = deferred(), controller = new AbortController(), failure = new TypeError(`SECRET_ERROR_TEXT ${QR_URL}`)
    const f = await fixture(t, { respond: () => { entered.resolve(); return late.promise } })
    const pending = f.service.start(binding(), context({ signal: controller.signal })), rejected = assert.rejects(pending, /B站授权服务不可用/u)
    await entered.promise; controller.abort(); await rejected
    late.resolve({ ...httpResponse(generated()), close() { if (asynchronous) return Promise.reject(failure); throw failure } })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(f.events.filter(event => event.code === 'auth_http_late_response_close_failed').length, 1)
    assert.equal(f.requests.length, 1); assert.deepEqual(await f.files(), []); assert.equal(f.secrets.includes(KEY), false)
    assertSafeDiagnostics(f.events, [failure])
  }
})

test('vault reports real temporary-unlink and handle-close failures while preserving static operation failures', async t => {
  const original = { open: fsPromises.open, rename: fsPromises.rename, unlink: fsPromises.unlink }
  for (const kind of ['unlink', 'close']) {
    const f = await fixture(t), session = await f.service.start(binding(), context())
    const failure = Object.assign(new TypeError(`SECRET_ERROR_TEXT ${COOKIE} /private/credentials`), { code: kind === 'unlink' ? 'EACCES' : 'EIO' })
    try {
      if (kind === 'unlink') {
        fsPromises.rename = async (from, to) => { if (String(from).endsWith('.tmp')) throw new RangeError(SESS); return original.rename(from, to) }
        fsPromises.unlink = async selected => { if (String(selected).endsWith('.tmp')) throw failure; return original.unlink(selected) }
      } else fsPromises.open = async (...args) => {
        const handle = await original.open(...args)
        if (String(args[0]).endsWith('.tmp')) { const close = handle.close.bind(handle); handle.close = async () => { await close(); throw failure } }
        return handle
      }
      syncBuiltinESMExports()
      await assert.rejects(session.poll(context()), /B站授权服务不可用/u)
    } finally {
      Object.assign(fsPromises, original); syncBuiltinESMExports()
    }
    assert.equal(f.events.filter(event => event.code === (kind === 'unlink' ? 'auth_vault_temporary_unlink_failed' : 'auth_vault_handle_close_failed')).length, 1)
    assertSafeDiagnostics(f.events, [failure])
    if (kind === 'unlink') assert.equal((await f.files()).filter(name => name.endsWith('.tmp')).length, 1)
  }
})

test('vault still attempts temporary unlink after close EIO and observes both cleanup failures without masking close', async t => {
  const { bilibiliAuthOwner, openAgentBilibiliAuthVault } = await import(moduleUrl('src/modules/media/infrastructure/agentBilibiliAuthVault.ts'))
  const original = { open: fsPromises.open, rename: fsPromises.rename, unlink: fsPromises.unlink }
  for (const unlinkFails of [false, true]) {
    const f = await fixture(t), vault = await openAgentBilibiliAuthVault(f.options)
    t.after(() => vault.close())
    const closeFailure = Object.assign(new TypeError(`SECRET_ERROR_TEXT ${COOKIE}`), { code: 'EIO' })
    const unlinkFailure = Object.assign(new RangeError(`/private/credentials ${SESS}`), { code: 'EACCES' })
    let unlinkAttempts = 0, closed = false
    try {
      fsPromises.open = async (...args) => {
        const handle = await original.open(...args)
        if (String(args[0]).endsWith('.tmp')) {
          const close = handle.close.bind(handle)
          handle.close = async () => { await close(); closed = true; throw closeFailure }
        }
        return handle
      }
      fsPromises.rename = async (from, to) => { if (String(from).endsWith('.tmp')) throw new Error(KEY); return original.rename(from, to) }
      fsPromises.unlink = async selected => {
        if (String(selected).endsWith('.tmp')) { assert.equal(closed, true); unlinkAttempts++; if (unlinkFails) throw unlinkFailure }
        return original.unlink(selected)
      }
      syncBuiltinESMExports()
      await assert.rejects(vault.save({ version: 1, owner: bilibiliAuthOwner(binding()), cookie: COOKIE, updatedAt: AT }, context()), error => error === closeFailure)
    } finally { Object.assign(fsPromises, original); syncBuiltinESMExports() }
    assert.equal(unlinkAttempts, 1)
    assert.equal(f.events.filter(event => event.code === 'auth_vault_handle_close_failed').length, 1)
    assert.equal(f.events.filter(event => event.code === 'auth_vault_temporary_unlink_failed').length, unlinkFails ? 1 : 0)
    assert.equal((await f.files()).filter(name => name.endsWith('.tmp')).length, unlinkFails ? 1 : 0)
    assertSafeDiagnostics(f.events, [closeFailure, unlinkFailure])
  }
})

test('throwing diagnostic observers fall back to fixed metadata without changing authorization results', async t => {
  const lines = [], received = [], original = console.error, failure = new SyntaxError(`SECRET_ERROR_TEXT ${CALLBACK} /private/credentials`)
  try {
    console.error = (...values) => lines.push(values)
    const f = await fixture(t, { options: { diagnostics: { emit(event) { received.push(event); throw failure } }, lookup: async () => { throw failure } } })
    await assert.rejects(f.service.start(binding(), context()), /B站授权服务不可用/u); await f.service.close()
  } finally { console.error = original }
  assertSafeDiagnostics(received, [failure])
  assert.ok(lines.length >= 3)
  for (const values of lines) {
    assert.equal(values.length, 1); assert.match(values[0], /^\[Agent\] runtime\/bilibili_auth_(?:http|service|session) (?:failed|cancelled) auth_[a-z_]+ errorKind=(?:SyntaxError|Error|AbortError)$/u)
    for (const secret of [SESS, QR_URL, CALLBACK, '/private/credentials', 'SECRET_ERROR_TEXT']) assert.equal(values[0].includes(secret), false)
  }
})
