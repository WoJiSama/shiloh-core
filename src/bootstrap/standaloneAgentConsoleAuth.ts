import { constants, closeSync, existsSync, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, type Stats } from 'node:fs'
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import { types } from 'node:util'
import type { AgentBindingSnapshot } from '../contracts/agentBinding.js'
import { AgentConsoleError } from '../contracts/agentConsole.js'
import type { AgentConsoleAuthPort, AgentConsoleCredentials, AgentConsoleGuard, AgentConsoleJson, AgentConsolePrincipal } from '../contracts/agentConsole.js'
import { captureSynchronousGuardCheck, createSynchronousGuard, ensureSynchronousGuard } from '../modules/runtime/domain/synchronousGuard.js'

type Decision = 'allowed' | 'denied' | 'unavailable'
export interface StandaloneAgentConsoleAuthOptions {
  /** A dedicated private directory is created with 0700 if absent. No plugin path is inferred. */
  readonly userFile: string
  readonly authority: { readonly signal: AbortSignal; isCurrent(): boolean }
  readonly tokenEnv?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Read-only import, only when userFile does not exist. Old scrypt hashes are preserved. */
  readonly legacyUserFile?: string
  /** Only the host may enable first-user setup; an existing user always prevents setup. */
  readonly allowSetup?: boolean
  readonly policy?: {
    readonly operations: readonly string[]
    authorize(principal: AgentConsolePrincipal, operation: string, binding: AgentBindingSnapshot | undefined, guard: AgentConsoleGuard): Promise<Decision>
  }
  readonly sessionTtlMs?: number
  readonly secureCookies?: boolean
  readonly now?: () => number
}
export type StandaloneAgentConsoleAuth = AgentConsoleAuthPort & { close(): Promise<void> }

interface User { username: string; salt: string; hash: string; createdAt: string; updatedAt?: string }
interface Snapshot { readonly stat: Stats; readonly raw: string }
interface Issued { readonly principal: AgentConsolePrincipal; readonly username: string | null; readonly tokenHash?: string; readonly sidHash?: string; expiresAt: number }
interface Attempts { count: number; firstAt: number; lockedUntil: number }
const cookieName = 'bl_console_sid', maxStoreBytes = 1024 * 1024
const windowMs = 15 * 60_000, lockMs = 10 * 60_000, maxFails = 5
const fail = (code: ConstructorParameters<typeof AgentConsoleError>[0]): never => { throw new AgentConsoleError(code) }
const missing = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const sameInode = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino
const sameStat = (a: Stats, b: Stats) => sameInode(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.mode === b.mode && a.nlink === b.nlink
function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail('invalid_request')
  const result: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(value)) {
    const field = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || !field || !Object.hasOwn(field, 'value') || !field.enumerable) return fail('invalid_request')
    result[key] = field.value
  }
  return result
}
function username(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{2,32}$/u.test(value)) return fail('invalid_request')
  return value
}
function password(value: unknown, minimum = 8): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > 1024 || /[\u0000-\u001f\u007f]/u.test(value)) return fail('invalid_request')
  return value
}
function users(raw: string): User[] {
  try {
    const row = plain(JSON.parse(raw))
    if (Object.keys(row).some(key => key !== 'users') || !Array.isArray(row.users) || row.users.length > 64) return fail('unavailable')
    const result = row.users.map((item: unknown) => {
      const user = plain(item)
      if (Object.keys(user).some(key => !['username', 'salt', 'hash', 'createdAt', 'updatedAt'].includes(key)) ||
          typeof user.salt !== 'string' || !/^[a-f0-9]{32}$/iu.test(user.salt) || typeof user.hash !== 'string' || !/^[a-f0-9]{128}$/iu.test(user.hash) ||
          typeof user.createdAt !== 'string' || user.createdAt.length > 64 || /[\u0000-\u001f\u007f]/u.test(user.createdAt) ||
          user.updatedAt !== undefined && (typeof user.updatedAt !== 'string' || user.updatedAt.length > 64 || /[\u0000-\u001f\u007f]/u.test(user.updatedAt))) return fail('unavailable')
      return { username: username(user.username), salt: user.salt, hash: user.hash, createdAt: user.createdAt,
        ...(user.updatedAt === undefined ? {} : { updatedAt: user.updatedAt as string }) }
    })
    if (new Set(result.map(user => user.username)).size !== result.length) return fail('unavailable')
    return result
  } catch { return fail('unavailable') }
}
function absolute(value: unknown): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value || /[\u0000-\u001f\u007f]/u.test(value)) return fail('invalid_request')
  return value
}
function cookieSid(header: string): string | undefined {
  let result: string | undefined
  for (const part of header.split(';')) {
    const offset = part.indexOf('=')
    if (offset < 0 || part.slice(0, offset).trim() !== cookieName) continue
    if (result !== undefined) return undefined
    try { result = decodeURIComponent(part.slice(offset + 1).trim()) } catch { return undefined }
  }
  return result && /^[a-f0-9]{64}$/u.test(result) ? result : undefined
}
function credentials(value: AgentConsoleCredentials): AgentConsoleCredentials {
  const row = plain(value)
  if (Object.keys(row).some(key => key !== 'token' && key !== 'cookie') || typeof row.token !== 'string' || row.token.length > 8192 ||
      typeof row.cookie !== 'string' || row.cookie.length > 16_384 || /[\r\n\u0000]/u.test(row.token + row.cookie)) return fail('invalid_request')
  return { token: row.token, cookie: row.cookie }
}
function secureEqual(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(digest(left), 'hex'), Buffer.from(digest(right), 'hex'))
}
function hashPassword(value: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => scrypt(value, salt, 64, (error, derived) => error ? reject(new AgentConsoleError('unavailable')) : resolve(derived.toString('hex'))))
}

/** Local files and explicit environment references only; errors contain fixed public codes. */
export async function openStandaloneAgentConsoleAuth(options: StandaloneAgentConsoleAuthOptions): Promise<StandaloneAgentConsoleAuth> {
  try {
    const file = absolute(options.userFile), directory = path.dirname(file), uid = process.getuid?.()
    if (uid === undefined || directory === file || !options.authority || !(options.authority.signal instanceof AbortSignal) ||
        typeof options.authority.isCurrent !== 'function' || options.allowSetup !== undefined && typeof options.allowSetup !== 'boolean' ||
        options.secureCookies !== undefined && typeof options.secureCookies !== 'boolean') return fail('invalid_request')
    const tokenEnv = options.tokenEnv
    if (tokenEnv !== undefined && !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(tokenEnv)) return fail('invalid_request')
    const environment = options.env ?? process.env, authority = options.authority, allowSetup = options.allowSetup === true
    const ttl = options.sessionTtlMs ?? 7 * 86_400_000, secure = options.secureCookies === true
    if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 30 * 86_400_000) return fail('invalid_request')
    const policy = options.policy, operations = new Set(policy?.operations ?? [])
    if (policy && (!Array.isArray(policy.operations) || policy.operations.length > 256 || operations.size !== policy.operations.length ||
        policy.operations.some(operation => !/^[a-z][a-z0-9.-]{0,127}$/u.test(operation)) || typeof policy.authorize !== 'function')) return fail('invalid_request')
    const authorize = policy?.authorize.bind(policy)
    let closed = false, compromised = false, generation = 0, store: User[] = [], snapshot: Snapshot | undefined
    const issued = new Map<string, Issued>(), sessions = new Map<string, Issued>(), attempts = new Map<string, Attempts>()
    let globalAttempts: Attempts = { count: 0, firstAt: 0, lockedUntil: 0 }, passwordsPending = 0
    const now = () => { const value = options.now?.() ?? Date.now(); if (!Number.isSafeInteger(value) || value < 0) return fail('unavailable'); return value }
    const revokeAll = () => { issued.clear(); sessions.clear() }
    const lease = () => {
      try {
        if (!closed && !compromised && !authority.signal.aborted && authority.isCurrent() === true) return true
      } catch { /* A revoked or unavailable lease cannot revive issued identities. */ }
      revokeAll(); return false
    }
    const checkLease = (guard?: AgentConsoleGuard, captured?: () => void) => {
      if (!lease()) return fail('conflict')
      if (guard) {
        if (!(guard.signal instanceof AbortSignal)) return fail('conflict')
        if (captured) captured()
        else ensureSynchronousGuard(guard, () => fail('conflict'), 'current-first')
        if (!lease()) return fail('conflict')
      }
    }
    const pinDirectories = (leaf: string) => {
      const result: { name: string; stat: Stats }[] = []
      for (let current = leaf; ; current = path.dirname(current)) {
        const stat = lstatSync(current)
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid && stat.uid !== 0 ||
            (stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000) !== 0) || realpathSync(current) !== current) return fail('unavailable')
        result.push({ name: current, stat })
        if (path.dirname(current) === current) break
      }
      return result
    }
    checkLease()
    let ancestor = directory
    while (!existsSync(ancestor)) ancestor = path.dirname(ancestor)
    const ancestors = pinDirectories(ancestor)
    checkLease()
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const directories = pinDirectories(directory)
    if ((directories[0]!.stat.mode & 0o7777) !== 0o700 || directories[0]!.stat.uid !== uid ||
        ancestors.some(item => !sameInode(item.stat, lstatSync(item.name)))) return fail('unavailable')
    const checkDirectories = () => {
      for (const pinned of directories) {
        const live = lstatSync(pinned.name)
        if (!sameInode(pinned.stat, live) || !live.isDirectory() || live.isSymbolicLink() || live.uid !== pinned.stat.uid || live.mode !== pinned.stat.mode) return fail('conflict')
      }
    }
    const read = (name: string, legacy = false): Snapshot | undefined => {
      let descriptor: number | undefined
      try {
        descriptor = openSync(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const before = fstatSync(descriptor)
        const safe = (stat: Stats) => stat.isFile() && stat.nlink === 1 && stat.uid === uid && stat.size > 0 && stat.size <= maxStoreBytes &&
          (legacy ? (stat.mode & 0o022) === 0 : (stat.mode & 0o7777) === 0o600)
        if (!safe(before) || !sameStat(before, lstatSync(name))) return fail('unavailable')
        const raw = readFileSync(descriptor, 'utf8'), after = fstatSync(descriptor)
        if (!safe(after) || !sameStat(before, after) || !sameStat(after, lstatSync(name))) return fail('conflict')
        return { stat: after, raw }
      } catch (error) { if (missing(error)) return undefined; throw error }
      finally { if (descriptor !== undefined) closeSync(descriptor) }
    }
    const verifySnapshot = () => {
      const live = read(file)
      if (snapshot === undefined ? live !== undefined : !live || !sameStat(snapshot.stat, live.stat) || snapshot.raw !== live.raw) return fail('conflict')
    }
    const filesystemCurrent = () => {
      try { checkDirectories() } catch { compromised = true; revokeAll(); return false }
      try {
        const live = read(file)
        if (snapshot === undefined ? live !== undefined : !live || !sameStat(snapshot.stat, live.stat) || snapshot.raw !== live.raw) throw new Error()
      } catch {
        compromised = true; revokeAll(); return false
      }
      return true
    }
    const check = (guard?: AgentConsoleGuard, captured?: () => void) => { checkLease(guard, captured); if (!filesystemCurrent()) return fail('conflict') }
    snapshot = read(file); if (snapshot) store = users(snapshot.raw)
    const write = (next: User[], guard?: AgentConsoleGuard, verifySource?: () => void) => {
      let lock: number | undefined, temporary: number | undefined, lockStat: Stats | undefined, temporaryStat: Stats | undefined
      const lockFile = file + '.lock', temporaryFile = path.join(directory, '.' + randomUUID() + '.tmp')
      try {
        check(guard); verifySnapshot()
        try { lock = openSync(lockFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
        catch { return fail('conflict') }
        writeFileSync(lock, randomUUID()); fsyncSync(lock); lockStat = fstatSync(lock)
        check(guard); verifySnapshot(); verifySource?.()
        temporary = openSync(temporaryFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        const raw = JSON.stringify({ users: next }) + '\n'
        if (Buffer.byteLength(raw) > maxStoreBytes) return fail('unavailable')
        writeFileSync(temporary, raw); fsyncSync(temporary); temporaryStat = fstatSync(temporary)
        if (temporaryStat.nlink !== 1 || (temporaryStat.mode & 0o7777) !== 0o600 || !sameStat(temporaryStat, lstatSync(temporaryFile))) return fail('conflict')
        check(guard); verifySnapshot(); verifySource?.()
        if (!sameStat(lockStat, lstatSync(lockFile)) || lockStat.nlink !== 1 || (lockStat.mode & 0o7777) !== 0o600) return fail('conflict')
        // No await separates the final snapshot/guard CAS from the atomic commit.
        check(guard); verifySnapshot()
        if (!sameStat(lockStat, lstatSync(lockFile))) return fail('conflict')
        if (snapshot) renameSync(temporaryFile, file)
        else { linkSync(temporaryFile, file); unlinkSync(temporaryFile) }
        const descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        try { if (!sameInode(directories[0]!.stat, fstatSync(descriptor))) return fail('conflict'); fsyncSync(descriptor) }
        finally { closeSync(descriptor) }
        snapshot = read(file)
        if (!snapshot || snapshot.raw !== raw) return fail('conflict')
        store = users(raw); generation++
        // Revocation is part of the commit, even if the request is cancelled immediately afterward.
        try { check(guard) }
        finally { for (const [id, record] of issued) if (record.username !== null) { issued.delete(id); if (record.sidHash) sessions.delete(record.sidHash) } }
      } finally {
        if (temporary !== undefined) closeSync(temporary)
        if (lock !== undefined) closeSync(lock)
        for (const [name, pinned] of [[temporaryFile, temporaryStat], [lockFile, lockStat]] as const) {
          try { if (pinned && sameInode(pinned, lstatSync(name))) unlinkSync(name) } catch { /* Never remove a replacement file. */ }
        }
      }
    }
    if (!snapshot && options.legacyUserFile !== undefined) {
      const legacyFile = absolute(options.legacyUserFile)
      if (legacyFile === file) return fail('invalid_request')
      const sourceDirectories = pinDirectories(path.dirname(legacyFile)), source = read(legacyFile, true)
      if (!source) return fail('unavailable')
      const imported = users(source.raw)
      write(imported, undefined, () => {
        checkLease()
        for (const item of sourceDirectories) if (!sameInode(item.stat, lstatSync(item.name))) return fail('conflict')
        const current = read(legacyFile, true)
        if (!current || !sameStat(source.stat, current.stat) || source.raw !== current.raw) return fail('conflict')
      })
    }
    check()
    let tokenFingerprint: string | undefined
    const revokeTokens = () => { for (const [id, record] of issued) if (record.tokenHash !== undefined) issued.delete(id) }
    const tokenValue = () => {
      const value = tokenEnv === undefined ? '' : environment[tokenEnv] ?? ''
      if (typeof value !== 'string' || value.length > 8192 || value.trim() !== value || /[\u0000-\u0020\u007f]/u.test(value)) { revokeTokens(); return fail('unavailable') }
      const fingerprint = digest(value)
      if (tokenFingerprint !== undefined && tokenFingerprint !== fingerprint) revokeTokens()
      tokenFingerprint = fingerprint
      return value
    }
    tokenValue()
    const tokenWorks = (value: string) => { const expected = tokenValue(); return !!value && !!expected && secureEqual(value, expected) }
    const publicCurrent = (principal: AgentConsolePrincipal) => {
      try {
        if (!lease() || !filesystemCurrent()) return false
        const row = plain(principal)
        if (Object.keys(row).some(key => !['id', 'username', 'via'].includes(key)) || typeof row.id !== 'string' || row.id.length > 256 ||
            row.via !== 'session' && row.via !== 'token' || row.username !== null && typeof row.username !== 'string') return false
        const record = issued.get(row.id)
        if (!record || row.via !== record.principal.via || row.username !== record.username || record.expiresAt <= now()) return false
        return record.tokenHash === undefined || !!tokenValue() && secureEqual(record.tokenHash, digest(tokenValue()))
      } catch { return false }
    }
    const prune = () => {
      for (const [id, record] of issued) if (!publicCurrent(record.principal)) { issued.delete(id); if (record.sidHash) sessions.delete(record.sidHash) }
      while (issued.size >= 1024) { const record = issued.values().next().value!; issued.delete(record.principal.id); if (record.sidHash) sessions.delete(record.sidHash) }
    }
    const session = (value: AgentConsoleCredentials) => {
      const sid = cookieSid(value.cookie), record = sid && sessions.get(digest(sid))
      return record && publicCurrent(record.principal) ? record : undefined
    }
    const tokenPrincipal = (value: string) => {
      if (!tokenWorks(value)) return undefined
      prune()
      // A preview and its later commit belong to the same current credential.
      // Reuse only a still-issued identity; expiry, logout and rotation discard it.
      for (const record of issued.values()) if (record.tokenHash !== undefined) return record.principal
      const principal: AgentConsolePrincipal = Object.freeze({ id: 'token-' + randomUUID(), username: null, via: 'token' })
      issued.set(principal.id, { principal, username: null, tokenHash: digest(tokenValue()), expiresAt: now() + ttl })
      return principal
    }
    const setCookie = (sid: string, age: number) => `${cookieName}=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${secure ? '; Secure' : ''}`
    const issueSession = (name: string) => {
      prune()
      const sid = randomBytes(32).toString('hex'), sidHash = digest(sid)
      const principal: AgentConsolePrincipal = Object.freeze({ id: 'session-' + randomUUID(), username: name, via: 'session' })
      const record: Issued = { principal, username: name, sidHash, expiresAt: now() + ttl }
      sessions.set(sidHash, record); issued.set(principal.id, record)
      return { username: name, cookie: setCookie(sid, Math.floor(ttl / 1000)) }
    }
    const rateState = (state: Attempts | undefined, at: number): Attempts => {
      const result = state ?? { count: 0, firstAt: at, lockedUntil: 0 }
      if (result.lockedUntil <= at && at - result.firstAt >= windowMs) return { count: 0, firstAt: at, lockedUntil: 0 }
      return result
    }
    const attempt = (name: string) => {
      const at = now(), key = digest(name), local = rateState(attempts.get(key), at)
      globalAttempts = rateState(globalAttempts, at)
      if (local.lockedUntil > at || globalAttempts.lockedUntil > at || passwordsPending >= maxFails) return fail('unauthorized')
      for (const state of [local, globalAttempts]) { state.count++; if (state.count >= maxFails) state.lockedUntil = at + lockMs }
      if (attempts.size >= 1024 && !attempts.has(key)) attempts.delete(attempts.keys().next().value!)
      attempts.set(key, local); return () => { attempts.delete(key); globalAttempts = { count: 0, firstAt: now(), lockedUntil: 0 } }
    }
    const hash = async (value: string, salt: string, guard: AgentConsoleGuard, expected: number) => {
      passwordsPending++
      try { const result = await hashPassword(value, salt); check(guard); if (generation !== expected) return fail('conflict'); return result }
      finally { passwordsPending-- }
    }
    const result: StandaloneAgentConsoleAuth = {
      async state(input, guard) {
        try {
          check(guard); const value = credentials(input), actor = session(value)?.principal
          const works = tokenWorks(value.token)
          check(guard)
          return { hasUser: store.length > 0, username: actor?.username ?? null, tokenWorks: works, via: actor ? 'session' : works ? 'token' : null }
        } catch (error) { if (error instanceof AgentConsoleError) throw error; return fail('unavailable') }
      },
      async authenticate(input, guard) {
        try { check(guard); const value = credentials(input), actor = session(value)?.principal ?? tokenPrincipal(value.token); check(guard); return actor }
        catch (error) { if (error instanceof AgentConsoleError) throw error; return fail('unavailable') }
      },
      isCurrent: publicCurrent,
      async authorize(principal, operation, binding, guard) {
        try {
          check(guard)
          if (!publicCurrent(principal) || !operations.has(operation) || !authorize) return 'denied'
          const captured = captureSynchronousGuardCheck(guard, () => fail('conflict'))
          const signal = AbortSignal.any([guard.signal, authority.signal])
          const scoped = captured ? createSynchronousGuard(signal, () => {
            check(guard, captured); if (!publicCurrent(principal)) return fail('conflict')
          }, () => fail('conflict')) : { signal,
            isCurrent: () => lease() && filesystemCurrent() && !guard.signal.aborted && guard.isCurrent() && publicCurrent(principal),
            ensureCurrent() { check(guard); if (!publicCurrent(principal)) return fail('conflict') },
          }
          const decision = await authorize(principal, operation, binding, scoped)
          check(guard, captured)
          if (!publicCurrent(principal)) return 'denied'
          return decision === 'allowed' || decision === 'unavailable' ? decision : 'denied'
        } catch {
          try { return lease() && filesystemCurrent() && !guard.signal.aborted && guard.isCurrent() ? 'unavailable' : 'denied' }
          catch { return 'denied' }
        }
      },
      async run(action, input, supplied, context) {
        try {
          check(context)
          if (!['setup', 'login', 'logout', 'password'].includes(action)) return fail('invalid_request')
          const body = plain(input), value = credentials(supplied), expected = generation
          const fields = action === 'setup' || action === 'login' ? ['username', 'password'] : action === 'password' ? ['oldPassword', 'newPassword'] : []
          if (Object.keys(body).some(key => !fields.includes(key)) || fields.some(key => typeof body[key] !== 'string')) return fail('invalid_request')
          if (action === 'logout') {
            const record = session(value)
            check(context)
            if (record) { issued.delete(record.principal.id); sessions.delete(record.sidHash!) }
            if (context.principal?.via === 'token' && tokenWorks(value.token) && publicCurrent(context.principal)) issued.delete(context.principal.id)
            return { cookie: setCookie('', 0) }
          }
          if (action === 'setup') {
            if (store.length) return fail('conflict')
            if (!allowSetup && !tokenWorks(value.token)) return fail('forbidden')
            const name = username(body.username), secret = password(body.password), success = attempt(name), salt = randomBytes(16).toString('hex')
            const hashed = await hash(secret, salt, context, expected)
            check(context)
            if (store.length || !allowSetup && !tokenWorks(value.token)) return fail('conflict')
            write([{ username: name, salt, hash: hashed, createdAt: new Date(now()).toISOString() }], context)
            check(context); success(); return issueSession(name)
          }
          if (action === 'login') {
            const name = username(body.username), secret = password(body.password, 1), success = attempt(name), user = store.find(item => item.username === name)
            const hashed = await hash(secret, user?.salt ?? '00000000000000000000000000000000', context, expected)
            if (!user || !secureEqual(hashed, user.hash)) return fail('unauthorized')
            check(context); success(); return issueSession(name)
          }
          const record = session(value)
          if (!record || !context.principal || context.principal.id !== record.principal.id || !publicCurrent(context.principal)) return fail('unauthorized')
          const oldSecret = password(body.oldPassword, 1), newSecret = password(body.newPassword), user = store.find(item => item.username === record.username)
          if (!user) return fail('unauthorized')
          const success = attempt(user.username), previous = await hash(oldSecret, user.salt, context, expected)
          check(context)
          if (!secureEqual(previous, user.hash)) return fail('unauthorized')
          const salt = randomBytes(16).toString('hex'), hashed = await hash(newSecret, salt, context, expected)
          check(context)
          write(store.map(item => item.username === user.username ? { ...item, salt, hash: hashed, updatedAt: new Date(now()).toISOString() } : item), context)
          success(); return { username: user.username, cookie: setCookie('', 0) }
        } catch (error) { if (error instanceof AgentConsoleError) throw error; return fail('unavailable') }
      },
      async close() { closed = true; revokeAll() },
    }
    return Object.freeze(result)
  } catch (error) { if (error instanceof AgentConsoleError) throw error; return fail('unavailable') }
}

export const createStandaloneAgentConsoleAuth = openStandaloneAgentConsoleAuth
