import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { importBilibiliHost as load } from './helpers/bilibiliQualitySource.mjs'

const { openStandaloneAgentConsoleAuth, createStandaloneAgentConsoleAuth } = await load('bootstrap/standaloneAgentConsoleAuth.js')
const { AgentConsoleError } = await load('contracts/agentConsole.js')
const { createSynchronousGuard } = await load('modules/runtime/domain/synchronousGuard.js')
const empty = { token: '', cookie: '' }, token = 'synthetic-console-token-0267001188', secret = 'synthetic-password-one'
const cookie = result => result.cookie.split(';')[0]
function guard() {
  const controller = new AbortController()
  let current = true
  return { signal: controller.signal, isCurrent: () => current && !controller.signal.aborted,
    ensureCurrent() { if (!this.isCurrent()) throw new Error('guard revoked') },
    revoke() { current = false }, abort() { controller.abort() } }
}
const code = expected => error => error instanceof AgentConsoleError && error.code === expected && error.message === expected
const oldStore = (name = 'old-admin', password = secret) => {
  const salt = '0123456789abcdef0123456789abcdef'
  return JSON.stringify({ users: [{ username: name, salt, hash: scryptSync(password, salt, 64).toString('hex'), createdAt: '2026-11-17T00:00:00.000Z' }] })
}
async function fixture(t, changes = {}) {
  const created = await mkdtemp(path.join(tmpdir(), 'agent-console-auth-')), root = await realpath(created)
  t.after(() => rm(root, { recursive: true, force: true }))
  const authority = guard(), file = path.join(root, 'auth', 'users.json'), env = { TEST_CONSOLE_AUTH_TOKEN: token }, services = []
  const clock = { at: Date.parse('2026-11-17T12:00:00+08:00') }
  const options = { userFile: file, authority, env, tokenEnv: 'TEST_CONSOLE_AUTH_TOKEN', now: () => clock.at, ...changes }
  const open = async extra => { const port = await openStandaloneAgentConsoleAuth({ ...options, ...extra }); services.push(port); return port }
  t.after(async () => { for (const port of services) await port.close() })
  return { root, file, authority, clock, env, options, open,
    async setup(port, credentials = { ...empty, token }, name = 'admin') { return port.run('setup', { username: name, password: secret }, credentials, guard()) },
    async login(port, name = 'admin', password = secret) { return port.run('login', { username: name, password }, empty, guard()) },
  }
}

test('explicit token env is the only credential read and default setup/permissions remain denied', async t => {
  const f = await fixture(t), reads = []
  const env = new Proxy(f.env, { get(target, key) { reads.push(key); assert.equal(key, 'TEST_CONSOLE_AUTH_TOKEN'); return target[key] } })
  const port = await f.open({ env })
  assert.equal(createStandaloneAgentConsoleAuth, openStandaloneAgentConsoleAuth)
  assert.deepEqual(await port.state(empty, guard()), { hasUser: false, username: null, tokenWorks: false, via: null })
  assert.equal(await port.authenticate(empty, guard()), undefined)
  await assert.rejects(port.run('setup', { username: 'admin', password: secret }, empty, guard()), code('forbidden'))
  const principal = await port.authenticate({ ...empty, token }, guard())
  assert.equal(principal.via, 'token'); assert.equal(principal.username, null); assert.equal(principal.id.includes(token), false)
  assert.equal(port.isCurrent(principal), true); assert.equal(await port.authorize(principal, 'config.read', undefined, guard()), 'denied')
  await port.run('logout', {}, { ...empty, token }, { ...guard(), principal }); assert.equal(port.isCurrent(principal), false)
  assert.equal((await port.authenticate({ ...empty, token }, guard())).via, 'token', 'logout revokes its issued identity while the explicit automation token remains configured')
  assert.ok(reads.length > 0); assert.equal((await lstat(path.dirname(f.file))).mode & 0o777, 0o700)
  await assert.rejects(lstat(f.file), { code: 'ENOENT' })
})

test('token requests keep one issued identity until its fixed expiry or explicit revocation', async t => {
  const f = await fixture(t), port = await f.open({ sessionTtlMs: 1000 }), supplied = { ...empty, token }
  const first = await port.authenticate(supplied, guard())
  f.clock.at += 500
  assert.deepEqual(await port.authenticate(supplied, guard()), first, 'preview and commit requests share the current token identity')
  f.clock.at += 500
  assert.equal(port.isCurrent(first), false, 'authentication does not extend the original expiry')
  const second = await port.authenticate(supplied, guard())
  assert.notEqual(second.id, first.id)
  await port.run('logout', {}, supplied, { ...guard(), principal: second })
  assert.equal(port.isCurrent(second), false)
  const third = await port.authenticate(supplied, guard())
  assert.notEqual(third.id, second.id, 'logout cannot revive a previous candidate owner')
  assert.deepEqual(await port.authenticate(supplied, guard()), third)
  f.env.TEST_CONSOLE_AUTH_TOKEN = 'synthetic-new-token-identity-0267'
  const rotated = await port.authenticate({ ...empty, token: f.env.TEST_CONSOLE_AUTH_TOKEN }, guard())
  assert.equal(port.isCurrent(third), false)
  assert.notEqual(rotated.id, third.id)
  f.env.TEST_CONSOLE_AUTH_TOKEN = token
  const restored = await port.authenticate(supplied, guard())
  assert.equal(port.isCurrent(rotated), false)
  assert.equal(port.isCurrent(first), false)
  assert.equal(port.isCurrent(second), false)
  assert.equal(port.isCurrent(third), false)
  assert.notEqual(restored.id, third.id, 'restoring the token cannot revive a revoked candidate owner')
})

test('authentication observes an intact owned guard once per synchronous check without caching later calls', async t => {
  const f = await fixture(t), port = await f.open()
  let calls = 0, current = true
  const scope = createSynchronousGuard(new AbortController().signal, () => { calls++; if (!current) throw new AgentConsoleError('conflict') }, () => { throw new AgentConsoleError('conflict') })
  await port.authenticate({ ...empty, token }, scope)
  assert.equal(calls, 2, 'authenticate has two fresh check boundaries, each with one owned observation')
  current = false
  await assert.rejects(port.authenticate({ ...empty, token }, scope), code('conflict'))
  assert.equal(calls, 3, 'a later request must not reuse the previous successful observation')
})

test('authentication keeps foreign current-before-ensure order and a stronger ensure cannot be skipped', async t => {
  const f = await fixture(t), port = await f.open(), events = [], controller = new AbortController()
  let current = true, stronger = false
  const scope = { signal: controller.signal,
    isCurrent() { assert.equal(this, scope); events.push('current'); return current },
    ensureCurrent() { assert.equal(this, scope); events.push('ensure'); if (stronger) throw new Error('stronger foreign ensure') } }
  await port.state(empty, scope)
  assert.deepEqual(events, ['current', 'ensure', 'current', 'current', 'ensure', 'current'])
  events.length = 0; current = false
  await assert.rejects(port.state(empty, scope), code('conflict'))
  assert.deepEqual(events, ['current'], 'an already revoked foreign guard must not run its ensure callback')
  events.length = 0; current = true; stronger = true
  await assert.rejects(port.state(empty, scope), code('unavailable'))
  assert.deepEqual(events, ['current', 'ensure'])
})

test('the authentication lease is fresh after an owned guard callback revokes it synchronously', async t => {
  const f = await fixture(t), port = await f.open()
  const scope = createSynchronousGuard(new AbortController().signal, () => { f.authority.revoke() }, () => { throw new AgentConsoleError('conflict') })
  await assert.rejects(port.state(empty, scope), code('conflict'))
})

test('a foreign ensure may synchronously audit the authentication scoped current without recursion', async t => {
  let scoped
  const observations = [], f = await fixture(t)
  const parent = guard(), original = parent.ensureCurrent
  parent.ensureCurrent = function() { if (scoped) observations.push(scoped.isCurrent()); original.call(this) }
  const port = await f.open({ policy: { operations: ['config.read'], async authorize(_principal, _operation, _binding, scope) {
    scoped = scope; scope.ensureCurrent(); return 'allowed'
  } } })
  const principal = await port.authenticate({ ...empty, token }, guard())
  assert.equal(await port.authorize(principal, 'config.read', undefined, parent), 'allowed')
  assert.ok(observations.length > 0); assert.equal(observations.every(Boolean), true)
})

test('a foreign authentication scoped current adds no ensure side effects and keeps stronger ensure separate', async t => {
  let blocked = false
  const f = await fixture(t), parent = guard(), original = parent.ensureCurrent
  parent.ensureCurrent = function() { if (blocked) throw new AgentConsoleError('conflict'); original.call(this) }
  const port = await f.open({ policy: { operations: ['config.read'], async authorize(_principal, _operation, _binding, scope) {
    blocked = true
    assert.equal(scope.isCurrent(), true)
    assert.throws(scope.ensureCurrent, code('conflict'))
    blocked = false
    return 'allowed'
  } } })
  const principal = await port.authenticate({ ...empty, token }, guard())
  assert.equal(await port.authorize(principal, 'config.read', undefined, parent), 'allowed')
})

test('an optimized authentication scoped guard rejects replacement by another valid owned tuple', async t => {
  const f = await fixture(t), fail = () => { throw new AgentConsoleError('conflict') }, signal = new AbortController().signal
  const parent = { ...createSynchronousGuard(signal, () => {}, fail) }
  let observed
  const port = await f.open({ policy: { operations: ['config.read'], async authorize(_principal, _operation, _binding, scope) {
    Object.assign(parent, createSynchronousGuard(signal, () => {}, fail))
    observed = scope.isCurrent()
    assert.throws(scope.ensureCurrent, code('conflict'))
    return 'allowed'
  } } })
  const principal = await port.authenticate({ ...empty, token }, guard())
  assert.notEqual(await port.authorize(principal, 'config.read', undefined, parent), 'allowed')
  assert.equal(observed, false)
})

test('first setup requires host permission or current token, writes 0600 hashes and cannot replace an existing user', async t => {
  for (const hostSetup of [false, true]) {
    const f = await fixture(t), port = await f.open({ allowSetup: hostSetup, secureCookies: true })
    const result = await f.setup(port, hostSetup ? empty : { ...empty, token })
    assert.equal(result.username, 'admin'); assert.match(result.cookie, /; HttpOnly; SameSite=Lax; Path=\/; Max-Age=604800; Secure$/u)
    const raw = await readFile(f.file, 'utf8'), saved = JSON.parse(raw).users[0]
    assert.equal(saved.username, 'admin'); assert.equal(saved.hash.length, 128); assert.equal(raw.includes(secret), false); assert.equal(raw.includes(token), false)
    assert.equal((await lstat(f.file)).mode & 0o777, 0o600); assert.equal((await lstat(f.file)).nlink, 1)
    const principal = await port.authenticate({ ...empty, cookie: cookie(result) }, guard())
    assert.equal(principal.username, 'admin'); assert.equal(principal.via, 'session')
    await assert.rejects(f.setup(port), code('conflict')); assert.equal(await readFile(f.file, 'utf8'), raw)
  }
})

test('legacy scrypt stores import only through an explicit path, remain read-only, and login without rehashing', async t => {
  const f = await fixture(t), legacyFile = path.join(f.root, 'legacy-users.json'), original = oldStore()
  await writeFile(legacyFile, original, { mode: 0o644 })
  const port = await f.open({ legacyUserFile: legacyFile })
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), JSON.parse(original))
  assert.equal(await readFile(legacyFile, 'utf8'), original); assert.equal((await lstat(legacyFile)).mode & 0o777, 0o644)
  assert.equal((await lstat(f.file)).mode & 0o777, 0o600)
  assert.equal((await f.login(port, 'old-admin')).username, 'old-admin')
  const existing = await readFile(f.file, 'utf8')
  const reopened = await f.open({ legacyUserFile: path.join(f.root, 'intentionally-missing-source') })
  assert.equal((await f.login(reopened, 'old-admin')).username, 'old-admin')
  assert.equal(await readFile(f.file, 'utf8'), existing)
})

test('an explicit existing legacy-format userFile can be reused in its private directory', async t => {
  const f = await fixture(t), original = oldStore()
  await mkdir(path.dirname(f.file), { mode: 0o700 }); await writeFile(f.file, original, { mode: 0o600 })
  const port = await f.open()
  assert.equal((await f.login(port, 'old-admin')).username, 'old-admin'); assert.equal(await readFile(f.file, 'utf8'), original)
})

test('login/logout, cookie ambiguity, session expiry and restart revoke opaque sessions', async t => {
  const f = await fixture(t), port = await f.open({ sessionTtlMs: 1000 }), first = await f.setup(port)
  const credentials = { ...empty, cookie: cookie(first) }, principal = await port.authenticate(credentials, guard())
  assert.ok(principal); assert.equal(await port.authenticate({ ...credentials, cookie: credentials.cookie + '; ' + credentials.cookie }, guard()), undefined)
  const logout = await port.run('logout', {}, credentials, { ...guard(), principal })
  assert.match(logout.cookie, /Max-Age=0/u); assert.equal(port.isCurrent(principal), false)
  const second = await f.login(port), secondPrincipal = await port.authenticate({ ...empty, cookie: cookie(second) }, guard())
  f.clock.at += 1001; assert.equal(port.isCurrent(secondPrincipal), false)
  const third = await f.login(port), thirdCredentials = { ...empty, cookie: cookie(third) }
  await port.close(); const restarted = await f.open(); assert.equal(await restarted.authenticate(thirdCredentials, guard()), undefined)
})

test('password changes require the current session and old password and revoke every previous session', async t => {
  const f = await fixture(t), port = await f.open(), first = await f.setup(port), second = await f.login(port)
  const one = { ...empty, cookie: cookie(first) }, two = { ...empty, cookie: cookie(second) }
  const firstPrincipal = await port.authenticate(one, guard()), secondPrincipal = await port.authenticate(two, guard())
  const tokenPrincipal = await port.authenticate({ ...empty, token }, guard())
  await assert.rejects(port.run('password', { oldPassword: secret, newPassword: 'synthetic-password-two' }, { ...empty, token }, { ...guard(), principal: tokenPrincipal }), code('unauthorized'))
  await assert.rejects(port.run('password', { oldPassword: 'wrong-old-password', newPassword: 'synthetic-password-two' }, one, { ...guard(), principal: firstPrincipal }), code('unauthorized'))
  const authority = guard(), context = { ...authority, principal: firstPrincipal,
    isCurrent: () => authority.isCurrent() && port.isCurrent(firstPrincipal),
    ensureCurrent() { if (!this.isCurrent()) throw Error('session revoked') } }
  await port.run('password', { oldPassword: secret, newPassword: 'synthetic-password-two' }, one, context)
  assert.equal(port.isCurrent(firstPrincipal), false); assert.equal(port.isCurrent(secondPrincipal), false)
  assert.equal(await port.authenticate(two, guard()), undefined)
  await assert.rejects(f.login(port), code('unauthorized')); assert.equal((await f.login(port, 'admin', 'synthetic-password-two')).username, 'admin')
  const raw = await readFile(f.file, 'utf8'); assert.equal(raw.includes(secret), false); assert.equal(raw.includes('synthetic-password-two'), false)
  assert.equal(port.isCurrent(tokenPrincipal), true)
})

test('a cancellation immediately after the password commit still revokes every prior session', async t => {
  const f = await fixture(t), port = await f.open(), first = await f.setup(port), second = await f.login(port)
  const one = { ...empty, cookie: cookie(first) }, two = { ...empty, cookie: cookie(second) }
  const firstPrincipal = await port.authenticate(one, guard()), secondPrincipal = await port.authenticate(two, guard())
  const scope = guard(), ensure = scope.ensureCurrent.bind(scope)
  scope.ensureCurrent = () => {
    ensure()
    if (readFileSync(f.file, 'utf8').includes('updatedAt')) scope.revoke()
  }
  await assert.rejects(port.run('password', { oldPassword: secret, newPassword: 'synthetic-password-two' }, one, { ...scope, principal: firstPrincipal }), code('conflict'))
  assert.equal(port.isCurrent(firstPrincipal), false); assert.equal(port.isCurrent(secondPrincipal), false)
  assert.equal((await f.login(port, 'admin', 'synthetic-password-two')).username, 'admin')
})

test('per-user and global rate limits stop unknown-name bypass and expire under the supplied clock', async t => {
  const f = await fixture(t), port = await f.open(); await f.setup(port)
  for (let i = 0; i < 5; i++) await assert.rejects(f.login(port, 'different-' + i, 'wrong-password'), code('unauthorized'))
  await assert.rejects(f.login(port), code('unauthorized'))
  f.clock.at += 15 * 60_000 + 1
  assert.equal((await f.login(port)).username, 'admin')
  for (let i = 0; i < 5; i++) await assert.rejects(f.login(port, 'admin', 'wrong-password'), code('unauthorized'))
  await assert.rejects(f.login(port), code('unauthorized'))
})

test('authorization uses the installed trusted operation policy and rechecks revocation after awaiting it', async t => {
  const f = await fixture(t), calls = [], pending = Promise.withResolvers()
  let wait = false, throws = false
  const port = await f.open({ policy: { operations: ['config.read'], async authorize(principal, operation, binding, scope) {
    calls.push({ principal, operation, binding, guard: scope }); scope.ensureCurrent()
    if (throws) throw Error(secret + token)
    if (wait) await pending.promise
    return 'allowed'
  } } })
  const principal = await port.authenticate({ ...empty, token }, guard())
  assert.equal(await port.authorize(principal, 'config.write', undefined, guard()), 'denied'); assert.equal(calls.length, 0)
  assert.equal(await port.authorize({ ...principal, id: 'forged' }, 'config.read', undefined, guard()), 'denied')
  assert.equal(await port.authorize(principal, 'config.read', undefined, guard()), 'allowed')
  throws = true; assert.equal(await port.authorize(principal, 'config.read', undefined, guard()), 'unavailable'); throws = false
  wait = true; const scope = guard(), result = port.authorize(principal, 'config.read', undefined, scope)
  f.authority.abort(); assert.equal(calls.at(-1).guard.signal.aborted, true); assert.equal(calls.at(-1).guard.isCurrent(), false)
  pending.resolve(); assert.equal(await result, 'denied')
})

test('token rotation and lease loss revoke previously issued token and session principals', async t => {
  const f = await fixture(t), port = await f.open(), first = await f.setup(port)
  const tokenPrincipal = await port.authenticate({ ...empty, token }, guard()), sessionPrincipal = await port.authenticate({ ...empty, cookie: cookie(first) }, guard())
  f.env.TEST_CONSOLE_AUTH_TOKEN = 'synthetic-replacement-console-token-0267'
  assert.equal(port.isCurrent(tokenPrincipal), false); assert.equal(await port.authenticate({ ...empty, token }, guard()), undefined)
  assert.equal((await port.authenticate({ ...empty, token: f.env.TEST_CONSOLE_AUTH_TOKEN }, guard())).via, 'token')
  f.env.TEST_CONSOLE_AUTH_TOKEN = token; assert.equal(port.isCurrent(tokenPrincipal), false, 'a rotated-back token cannot revive a revoked principal')
  f.authority.abort(); assert.equal(port.isCurrent(sessionPrincipal), false)
  await assert.rejects(port.state(empty, guard()), code('conflict'))
})

test('request cancellation and lease revocation during scrypt prevent setup commits and cookies', async t => {
  for (const kind of ['request', 'lease']) {
    const f = await fixture(t), port = await f.open({ allowSetup: true }), scope = guard()
    const result = port.run('setup', { username: 'admin', password: secret }, empty, scope)
    if (kind === 'request') scope.abort(); else f.authority.abort()
    await assert.rejects(result, code('conflict')); await assert.rejects(lstat(f.file), { code: 'ENOENT' })
    assert.deepEqual(await readdir(path.dirname(f.file)), [])
  }
})

test('concurrent first-user CAS never overwrites the other completed setup', async t => {
  const f = await fixture(t), first = await f.open({ allowSetup: true }), second = await f.open({ allowSetup: true })
  const results = await Promise.allSettled([f.setup(first, empty, 'first-admin'), f.setup(second, empty, 'second-admin')])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const winner = results.find(result => result.status === 'fulfilled').value.username
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')).users.map(user => user.username), [winner])
  assert.deepEqual(await readdir(path.dirname(f.file)), ['users.json'])
})

test('unsafe credential files and explicit legacy symlink/hardlink sources are rejected without modifying targets', async t => {
  for (const kind of ['symlink', 'hardlink', 'permissions']) {
    const f = await fixture(t), source = path.join(f.root, 'source.json'), original = oldStore()
    await mkdir(path.dirname(f.file), { mode: 0o700 }); await writeFile(source, original, { mode: 0o600 })
    if (kind === 'symlink') await symlink(source, f.file)
    else if (kind === 'hardlink') await link(source, f.file)
    else { await writeFile(f.file, original, { mode: 0o644 }); await chmod(f.file, 0o644) }
    await assert.rejects(f.open(), error => error instanceof AgentConsoleError)
    assert.equal(await readFile(source, 'utf8'), original)
    if (kind !== 'permissions') await assert.rejects(f.open({ userFile: path.join(f.root, 'fresh', 'users.json'), legacyUserFile: f.file }), error => error instanceof AgentConsoleError)
  }
})

test('store edits or directory replacement revoke all principals and never load the replacement', async t => {
  for (const kind of ['store', 'in-place', 'directory']) {
    const f = await fixture(t), port = await f.open(), setup = await f.setup(port)
    const principal = await port.authenticate({ ...empty, cookie: cookie(setup) }, guard())
    if (kind === 'store') {
      const replacement = path.join(f.root, 'replacement.json'); await writeFile(replacement, oldStore('replacement'), { mode: 0o600 }); await rename(replacement, f.file)
    } else if (kind === 'in-place') await writeFile(f.file, oldStore('replacement'))
    else { await rename(path.dirname(f.file), path.join(f.root, 'previous-directory')); await mkdir(path.dirname(f.file), { mode: 0o700 }) }
    assert.equal(port.isCurrent(principal), false); await assert.rejects(port.authenticate({ ...empty, token }, guard()), code('conflict'))
  }
})

test('exclusive lock and final guard prevent overwriting path replacements before atomic commit', async t => {
  const f = await fixture(t), port = await f.open({ allowSetup: true }), marker = path.join(f.root, 'marker')
  await writeFile(marker, 'untouched'); await symlink(marker, f.file + '.lock')
  await assert.rejects(f.setup(port, empty), code('conflict')); assert.equal(await readFile(marker, 'utf8'), 'untouched')
  await rm(f.file + '.lock'); await port.close()
  const reopened = await f.open({ allowSetup: true }), scope = guard(), replacement = JSON.stringify({ users: [] })
  const originalEnsure = scope.ensureCurrent.bind(scope)
  let replaced = false
  scope.ensureCurrent = () => {
    originalEnsure()
    if (!replaced && readdirSync(path.dirname(f.file)).some(name => name.endsWith('.tmp'))) {
      const file = path.join(f.root, 'replacement-before-commit.json'); writeFileSync(file, replacement, { mode: 0o600 }); renameSync(file, f.file); replaced = true
    }
  }
  await assert.rejects(reopened.run('setup', { username: 'admin', password: secret }, empty, scope), code('conflict'))
  assert.equal(replaced, true); assert.equal(await readFile(f.file, 'utf8'), replacement)
  assert.deepEqual(await readdir(path.dirname(f.file)), ['users.json'])
})

test('malformed requests, unknown actions, damaged stores and untrusted inherited fields expose fixed errors only', async t => {
  const f = await fixture(t), port = await f.open({ allowSetup: true })
  for (const body of [{ username: 'admin', password: secret, token }, { username: '../invalid', password: secret },
    { username: 'admin', password: 'short' }, Object.create({ username: 'admin', password: secret })]) {
    await assert.rejects(port.run('setup', body, empty, guard()), code('invalid_request'))
  }
  await assert.rejects(port.run('unknown', {}, empty, guard()), code('invalid_request'))
  await port.close(); await writeFile(f.file, token + secret, { mode: 0o600 })
  await assert.rejects(f.open(), error => code('unavailable')(error) && !String(error).includes(secret) && !String(error).includes(token))
})
