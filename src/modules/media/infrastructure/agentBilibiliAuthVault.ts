import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { types } from 'node:util'
import type { AgentBindingSnapshot } from '../../../contracts/agentBinding.js'
import type { AgentMediaResourceContext } from '../../../contracts/agentMediaRelay.js'
import type { AgentDiagnostics } from '../../runtime/infrastructure/agentDiagnostics.js'

export const bilibiliAuthFailure = () => new Error('B站授权服务不可用，请稍后重新发起授权')
type AuthDiagnostics = Pick<AgentDiagnostics, 'emit'>
/** Preserve only a built-in error category. Custom observers never receive the original exception. */
export function bilibiliAuthDiagnostic(diagnostics: AuthDiagnostics | undefined, operation: 'bilibili_auth_service' | 'bilibili_auth_http' | 'bilibili_auth_vault' | 'bilibili_auth_cleanup' | 'bilibili_auth_session', outcome: 'failed' | 'cancelled', code: string, error?: unknown): void {
  let kind = 'Unknown'
  try {
    if (error && typeof error === 'object' && !types.isProxy(error)) {
      const name = Object.getOwnPropertyDescriptor(error, 'name')?.value
      if (name === 'AbortError' || name === 'TimeoutError') kind = name
      else {
        try { const name = Object.getOwnPropertyDescriptor(DOMException.prototype, 'name')!.get!.call(error); if (name === 'AbortError' || name === 'TimeoutError') kind = name } catch { /* Native brand check, never instance properties. */ }
        if (kind === 'Unknown' && types.isNativeError(error)) {
          const prototype = Object.getPrototypeOf(error)
          kind = prototype === TypeError.prototype ? 'TypeError' : prototype === RangeError.prototype ? 'RangeError' : prototype === SyntaxError.prototype ? 'SyntaxError' : 'Error'
        }
      }
    }
  } catch { kind = 'Unknown' }
  const safe = kind === 'TypeError' ? new TypeError() : kind === 'RangeError' ? new RangeError() : kind === 'SyntaxError' ? new SyntaxError() : kind === 'Error' ? new Error() : undefined
  if (safe) { delete safe.stack; Object.freeze(safe) }
  const event = { stage: 'runtime' as const, operation, outcome, code, error: safe ?? (kind === 'Unknown' ? null : Object.freeze({ name: kind })) }
  try { if (diagnostics) { diagnostics.emit(event); return } } catch { /* Fall back to the same fixed metadata only. */ }
  try { console.error(`[Agent] runtime/${operation} ${outcome} ${code} errorKind=${kind}`) } catch { /* No writable observer remains. */ }
}
export function bilibiliAuthCancelled(context?: AgentMediaResourceContext): boolean {
  try { return !!context && (context.signal.aborted || context.isCurrent() !== true) } catch { return true }
}
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino
const uid = () => { if (!process.getuid) throw bilibiliAuthFailure(); return process.getuid() }
const missing = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
export function bilibiliAuthOwner(binding: AgentBindingSnapshot): string {
  const values = [binding.target.account.platform, binding.target.account.namespace, binding.target.account.id, binding.agentId]
  if (values.some(value => typeof value !== 'string' || !value || value.length > 1024 || /[\u0000-\u001f\u007f]/u.test(value))) throw bilibiliAuthFailure()
  return JSON.stringify(values)
}
export function validBilibiliCredential(cookie: unknown): cookie is string {
  return typeof cookie === 'string' && /^SESSDATA=[A-Za-z0-9_%.,~*-]{1,2048}; bili_jct=[0-9a-fA-F]{32}; DedeUserID=[1-9]\d{0,19}$/u.test(cookie) &&
    !/%(?![0-9a-fA-F]{2})/u.test(cookie) && !/%(?:0[0-9a-f]|1[0-9a-f]|7f|3b|3d|5c)/iu.test(cookie)
}
export interface BilibiliCredentialRecord { readonly version: 1; readonly owner: string; readonly cookie: string; readonly updatedAt: number }

/** The host owns the lease. This vault only accesses a private, inode-pinned directory. */
export async function openAgentBilibiliAuthVault(options: { directory: string; isLeaseCurrent(): boolean; diagnostics?: AuthDiagnostics }) {
  const diagnose = (code: string, error: unknown, context?: AgentMediaResourceContext) => bilibiliAuthDiagnostic(options.diagnostics, 'bilibili_auth_vault', bilibiliAuthCancelled(context) ? 'cancelled' : 'failed', code, error)
  const closeHandle = async (handle: { close(): Promise<void> } | undefined) => { try { await handle?.close() } catch (error) { bilibiliAuthDiagnostic(options.diagnostics, 'bilibili_auth_cleanup', 'failed', 'auth_vault_handle_close_failed', error); throw error } }
  try {
  const directory = path.resolve(options.directory), parent = path.dirname(directory), user = uid()
  if (!path.isAbsolute(options.directory) || directory === parent) throw bilibiliAuthFailure()
  const parentStat = await lstat(parent)
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.uid !== user || (parentStat.mode & 0o022) !== 0 || await realpath(parent) !== parent || !options.isLeaseCurrent()) throw bilibiliAuthFailure()
  try { await mkdir(directory, { mode: 0o700 }) } catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error }
  const pinned = await lstat(directory)
  let closed = false, tail: Promise<void> = Promise.resolve()
  const check = async (context?: AgentMediaResourceContext) => {
    if (closed || !options.isLeaseCurrent()) throw bilibiliAuthFailure()
    if (context) { context.signal.throwIfAborted(); if (!context.isCurrent()) throw bilibiliAuthFailure(); await context.ensureCurrent?.(); context.signal.throwIfAborted(); if (!context.isCurrent()) throw bilibiliAuthFailure() }
    const stat = await lstat(directory), liveParent = await lstat(parent)
    if (!same(parentStat, liveParent) || liveParent.uid !== user || (liveParent.mode & 0o022) !== 0 || !same(pinned, stat) || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== user || (stat.mode & 0o7777) !== 0o700 || await realpath(directory) !== directory || closed || !options.isLeaseCurrent()) throw bilibiliAuthFailure()
  }
  const fileFor = (owner: string) => path.join(directory, `${createHash('sha256').update(owner).digest('hex')}.json`)
  const safeStat = (stat: Stats) => stat.isFile() && stat.nlink === 1 && stat.uid === user && (stat.mode & 0o7777) === 0o600 && stat.size > 0 && stat.size <= 16_384
  const read = async (owner: string): Promise<BilibiliCredentialRecord | undefined> => {
    const file = fileFor(owner)
    let handle
    try {
      try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) } catch (error) { if (missing(error)) return undefined; throw error }
      const before = await handle.stat()
      if (!safeStat(before) || !same(before, await lstat(file))) throw bilibiliAuthFailure()
      const value: unknown = JSON.parse(await handle.readFile('utf8'))
      const after = await handle.stat()
      if (!safeStat(after) || !same(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || !same(before, await lstat(file)) || !value || typeof value !== 'object' || Array.isArray(value)) throw bilibiliAuthFailure()
      const row = value as Record<string, unknown>
      if (Object.keys(row).length !== 4 || Object.keys(row).some(key => !['version', 'owner', 'cookie', 'updatedAt'].includes(key)) || row.version !== 1 || row.owner !== owner || !validBilibiliCredential(row.cookie) || typeof row.updatedAt !== 'number' || !Number.isSafeInteger(row.updatedAt) || row.updatedAt < 0) throw bilibiliAuthFailure()
      return row as unknown as BilibiliCredentialRecord
    } catch (error) { diagnose('auth_vault_record_read_failed', error); throw bilibiliAuthFailure() } finally { await closeHandle(handle) }
  }
  const queue = <T>(operation: () => Promise<T>) => { const next = tail.then(operation); tail = next.then(() => {}, () => {}); return next }
  await check()
  return {
    read(owner: string, context: AgentMediaResourceContext) { return queue(async () => { try { await check(context); const result = await read(owner); await check(context); return result } catch (error) { diagnose('auth_vault_read_failed', error, context); throw error } }) },
    save(record: BilibiliCredentialRecord, context: AgentMediaResourceContext) { return queue(async () => {
      let handle, temporary: string | undefined
      try {
        if (!validBilibiliCredential(record.cookie) || !Number.isSafeInteger(record.updatedAt) || record.updatedAt < 0) throw bilibiliAuthFailure()
        await check(context); await read(record.owner)
        const file = fileFor(record.owner); temporary = path.join(directory, `.${randomUUID()}.tmp`)
        handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        await handle.writeFile(JSON.stringify(record) + '\n'); await handle.sync()
        if (!safeStat(await handle.stat()) || !same(await handle.stat(), await lstat(temporary))) throw bilibiliAuthFailure()
        await check(context); await read(record.owner); await check(context)
        await rename(temporary, file)
        const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        try { if (!same(pinned, await dir.stat())) throw bilibiliAuthFailure(); await dir.sync() } finally { await closeHandle(dir) }
        await check(context)
      } catch (error) { diagnose('auth_vault_write_failed', error, context); throw bilibiliAuthFailure() } finally {
        try { await closeHandle(handle) } finally {
          if (temporary) await unlink(temporary).catch(error => { if (!missing(error)) bilibiliAuthDiagnostic(options.diagnostics, 'bilibili_auth_cleanup', 'failed', 'auth_vault_temporary_unlink_failed', error) })
        }
      }
    }) },
    remove(owner: string, context: AgentMediaResourceContext) { return queue(async () => {
      try {
        await check(context); const previous = await read(owner); await check(context)
        if (previous) { await unlink(fileFor(owner)); const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { if (!same(pinned, await dir.stat())) throw bilibiliAuthFailure(); await dir.sync() } finally { await closeHandle(dir) } }
        await check(context)
      } catch (error) { diagnose('auth_vault_remove_failed', error, context); throw error }
    }) },
    async close() { closed = true; await tail },
  }
  } catch (error) { diagnose('auth_vault_open_failed', error); throw bilibiliAuthFailure() }
}
