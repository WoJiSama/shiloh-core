import fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isProxy } from 'node:util/types'
import type { AgentBindingSnapshot, PlatformAccountRef } from '../../../contracts/agentBinding.js'
import type { AgentDiagnosticEvent, AgentDiagnosticScope, AgentOperationJournal } from '../../../contracts/agentDiagnostics.js'

export type { AgentDiagnosticEvent, AgentDiagnosticScope, AgentDiagnosticSink, AgentOperationJournal } from '../../../contracts/agentDiagnostics.js'

export interface AgentOperationJournalOptions {
  readonly dataDir: string
  readonly allowsText?: (text: string) => boolean
  readonly maxFileBytes?: number
  readonly maxFiles?: number
  readonly retentionDays?: number
  readonly onEmergency?: (event: AgentDiagnosticEvent | undefined, code: string) => void
}

const MiB = 1024 * 1024, MAX_LINE_BYTES = 8192, MAX_PENDING = 256, MAX_PENDING_BYTES = 2 * MiB
const filePattern = /^(\d{4}-\d{2}-\d{2})\.(\d{6})\.ndjson$/u
const tokenPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const failure = () => new Error('操作日志不可用')
const stages = ['host', 'inbox', 'model', 'tool', 'delivery', 'memory', 'runtime', 'notification']
const outcomes = ['started', 'succeeded', 'failed', 'unknown', 'cancelled']
const errorKinds = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'TimeoutError', 'Unknown']
const activeWriters = new Set<string>()

function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw failure()
  const snapshot: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (typeof key !== 'string' || !allowed.includes(key) || !Object.hasOwn(descriptor, 'value')) throw failure()
    snapshot[key] = descriptor.value
  }
  return snapshot
}
function text(value: unknown, maximum = 128): string {
  if (typeof value !== 'string' || !value || value.length > maximum || value !== value.trim() || /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value)) throw failure()
  return value
}
function token(value: unknown): string {
  if (typeof value !== 'string' || !tokenPattern.test(value)) throw failure()
  return value
}
function account(value: unknown): PlatformAccountRef {
  const row = record(value, ['platform', 'namespace', 'id'])
  const platform = text(row.platform, 64)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(platform)) throw failure()
  return Object.freeze({ platform, namespace: text(row.namespace), id: text(row.id) })
}
function binding(value: unknown): AgentBindingSnapshot {
  const row = record(value, ['source', 'id', 'revision', 'agentId', 'personaId', 'connectionId', 'target'])
  const target = record(row.target, ['account', 'kind', 'id'])
  if (typeof row.source !== 'string' || !['configured', 'legacy'].includes(row.source) || typeof target.kind !== 'string' || !['group', 'private', 'channel', 'thread'].includes(target.kind)) throw failure()
  return Object.freeze({ source: row.source as AgentBindingSnapshot['source'], id: text(row.id, 4096), revision: text(row.revision, 512),
    agentId: token(row.agentId), personaId: text(row.personaId), connectionId: token(row.connectionId),
    target: Object.freeze({ account: account(target.account), kind: target.kind as AgentBindingSnapshot['target']['kind'], id: text(target.id) }) })
}
function scope(value: unknown): AgentDiagnosticScope {
  const row = record(value, ['kind', 'binding', 'messageId', 'account'])
  if (row.kind === 'host' && Object.keys(row).length === 1) return Object.freeze({ kind: 'host' })
  if (row.kind === 'account' && Object.keys(row).length === 2 && Object.hasOwn(row, 'account')) return Object.freeze({ kind: 'account', account: account(row.account) })
  if (row.kind === 'conversation' && !Object.hasOwn(row, 'account') && Object.hasOwn(row, 'binding')) {
    return Object.freeze({ kind: 'conversation', binding: binding(row.binding), ...(row.messageId === undefined ? {} : { messageId: text(row.messageId) }) })
  }
  throw failure()
}
/** The writer and read view share the same closed metadata schema, including historical v1 records. */
export function parseAgentDiagnosticEvent(value: unknown): Readonly<AgentDiagnosticEvent> {
  const row = record(value, ['version', 'id', 'traceId', 'at', 'scope', 'stage', 'operation', 'outcome', 'code', 'durationMs', 'errorKind', 'httpStatus', 'configurationRevision', 'delivery'])
  if (row.version !== 1 || !Number.isSafeInteger(row.at) || Number(row.at) < 0 || Number(row.at) > 8_640_000_000_000_000 ||
      typeof row.stage !== 'string' || !stages.includes(row.stage) || typeof row.outcome !== 'string' || !outcomes.includes(row.outcome) ||
      row.durationMs !== undefined && (!Number.isSafeInteger(row.durationMs) || Number(row.durationMs) < 0) ||
      row.errorKind !== undefined && (typeof row.errorKind !== 'string' || !errorKinds.includes(row.errorKind)) ||
      row.httpStatus !== undefined && (!Number.isInteger(row.httpStatus) || Number(row.httpStatus) < 100 || Number(row.httpStatus) > 599)) throw failure()
  let delivery: AgentDiagnosticEvent['delivery']
  if (row.delivery !== undefined) {
    const receipt = record(row.delivery, ['state', 'messageId', 'code'])
    if (typeof receipt.state !== 'string' || !['sent', 'uploaded', 'confirmed', 'unknown', 'failed'].includes(receipt.state)) throw failure()
    delivery = Object.freeze({ state: receipt.state as NonNullable<AgentDiagnosticEvent['delivery']>['state'],
      ...(receipt.messageId === undefined ? {} : { messageId: text(receipt.messageId) }), ...(receipt.code === undefined ? {} : { code: token(receipt.code) }) })
  }
  return Object.freeze({ version: 1, id: token(row.id), traceId: token(row.traceId), at: row.at as number, scope: scope(row.scope),
    stage: row.stage as AgentDiagnosticEvent['stage'], operation: token(row.operation), outcome: row.outcome as AgentDiagnosticEvent['outcome'],
    ...(row.code === undefined ? {} : { code: token(row.code) }), ...(row.durationMs === undefined ? {} : { durationMs: row.durationMs as number }),
    ...(row.errorKind === undefined ? {} : { errorKind: row.errorKind as NonNullable<AgentDiagnosticEvent['errorKind']> }), ...(row.httpStatus === undefined ? {} : { httpStatus: row.httpStatus as number }),
    ...(row.configurationRevision === undefined ? {} : { configurationRevision: text(row.configurationRevision, 512) }), ...(delivery === undefined ? {} : { delivery }) })
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw failure()
  return value as number
}
const day = (): string => new Date().toISOString().slice(0, 10)

/** Process-local only; a caller must hold the sole cross-process host lease for this dataDir. */
async function localWriterLock(dataDir: string): Promise<() => Promise<void>> {
  const canonical = await fs.realpath(dataDir)
  if (activeWriters.has(canonical)) throw failure()
  activeWriters.add(canonical)
  return async () => { activeWriters.delete(canonical) }
}

/**
 * Bounded metadata records, fsync before acknowledgement, and one process-local owner.
 * The caller must hold one host lease owner per dataDir. This factory has no cross-process lock.
 */
export async function openAgentOperationJournal(options: AgentOperationJournalOptions): Promise<AgentOperationJournal> {
  const raw = record(options, ['dataDir', 'allowsText', 'maxFileBytes', 'maxFiles', 'retentionDays', 'onEmergency'])
  if (typeof raw.dataDir !== 'string' || !raw.dataDir || raw.dataDir.length > 4096 || /[\u0000-\u001f\u007f]/u.test(raw.dataDir) ||
      raw.allowsText !== undefined && typeof raw.allowsText !== 'function' || raw.onEmergency !== undefined && typeof raw.onEmergency !== 'function') throw failure()
  const maximum = integer(raw.maxFileBytes, 8 * MiB, 64 * 1024, 64 * MiB), maxFiles = integer(raw.maxFiles, 14, 1, 128), retention = integer(raw.retentionDays, 14, 1, 365)
  const allows = raw.allowsText as AgentOperationJournalOptions['allowsText'], emergency = raw.onEmergency as AgentOperationJournalOptions['onEmergency']
  const dataDir = path.resolve(raw.dataDir), directory = path.join(dataDir, 'operations')
  let degraded = false, written = 0, failed = 0, lastWrittenAt: number | undefined, closing = false
  let tail: Promise<void> = Promise.resolve(), pending = 0, pendingBytes = 0
  let closeResult: Promise<boolean> | undefined, latest: { name: string; size: number } | undefined
  let rootIdentity: { dev: number; ino: number } | undefined, directoryIdentity: { dev: number; ino: number } | undefined
  let reporting = false
  let releaseWriter: (() => Promise<void>) | undefined

  function report(safe: AgentDiagnosticEvent | undefined, code: string): void {
    degraded = true; failed++
    if (!reporting) {
      reporting = true
      try { emergency?.(safe, code) } catch { /* Never feed emergency failures back into this journal. */ }
      finally { reporting = false }
    }
    try { process.stderr.write(`[AgentDiagnostics] ${code}${safe ? ' ' + JSON.stringify(safe) : ''}\n`) } catch { /* No recursive logging. */ }
  }
  async function directories(initial = false): Promise<void> {
    if (initial) await fs.mkdir(dataDir, { recursive: true, mode: 0o700 })
    const root = await fs.lstat(dataDir)
    if (!root.isDirectory() || root.isSymbolicLink() || rootIdentity && (rootIdentity.dev !== root.dev || rootIdentity.ino !== root.ino)) throw failure()
    if (initial) await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error })
    const own = await fs.lstat(directory)
    if (!own.isDirectory() || own.isSymbolicLink() || (own.mode & 0o777) !== 0o700 || directoryIdentity && (directoryIdentity.dev !== own.dev || directoryIdentity.ino !== own.ino)) throw failure()
    rootIdentity ??= { dev: root.dev, ino: root.ino }; directoryIdentity ??= { dev: own.dev, ino: own.ino }
  }
  async function syncDirectory(): Promise<void> {
    await directories()
    const handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { await handle.sync() } finally { await handle.close() }
  }
  async function privateFile(name: string, flags: number): Promise<FileHandle> {
    const handle = await fs.open(path.join(directory, name), flags | constants.O_NOFOLLOW, 0o600)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size > 64 * MiB) throw failure()
      await directories()
      const actual = await fs.lstat(path.join(directory, name))
      if (actual.isSymbolicLink() || actual.dev !== stat.dev || actual.ino !== stat.ino) throw failure()
      return handle
    } catch { await handle.close(); throw failure() }
  }
  async function names(): Promise<string[]> {
    await directories()
    const entries = await fs.readdir(directory)
    if (entries.length > 4096) throw failure()
    return entries.filter(name => filePattern.test(name)).sort()
  }
  async function prune(): Promise<void> {
    const entries = await names(), cutoff = new Date(Date.now() - retention * 86_400_000).toISOString().slice(0, 10)
    const expired = entries.filter(name => name.slice(0, 10) < cutoff), retained = entries.filter(name => !expired.includes(name)), remove = [...expired, ...retained.slice(0, Math.max(0, retained.length - maxFiles))]
    for (const name of remove) {
      const handle = await privateFile(name, constants.O_RDONLY); await handle.close()
      await fs.unlink(path.join(directory, name)); if (latest?.name === name) latest = undefined
    }
    if (remove.length) await syncDirectory()
  }
  async function recover(): Promise<void> {
    for (const name of await names()) {
      const handle = await privateFile(name, constants.O_RDWR)
      try {
        let size = (await handle.stat()).size
        if (size) {
          let cursor = size, boundary = -1
          while (cursor > 0 && boundary < 0) {
            const length = Math.min(cursor, MAX_LINE_BYTES), buffer = Buffer.alloc(length)
            const read = await handle.read(buffer, 0, length, cursor - length)
            if (read.bytesRead !== length) throw failure()
            const newline = buffer.lastIndexOf(10)
            if (newline >= 0) boundary = cursor - length + newline + 1
            cursor -= length
          }
          if (boundary !== size) {
            size = Math.max(0, boundary)
            await handle.truncate(size); await handle.sync()
          }
        }
        latest = { name, size }
      } finally { await handle.close() }
    }
    await prune()
  }
  async function write(line: string): Promise<void> {
    await directories()
    const bytes = Buffer.from(line, 'utf8'), today = day()
    let created = false
    if (!latest || !latest.name.startsWith(today + '.') || latest.size + bytes.length > maximum) {
      const existing = (await names()).filter(name => name.startsWith(today + '.'))
      const sequence = Number(existing.at(-1)?.match(filePattern)?.[2] ?? -1) + 1
      if (sequence > 999999) throw failure()
      latest = { name: `${today}.${String(sequence).padStart(6, '0')}.ndjson`, size: 0 }; created = true
    }
    const handle = await privateFile(latest.name, constants.O_WRONLY | constants.O_APPEND | (created ? constants.O_CREAT | constants.O_EXCL : 0))
    try {
      if ((await handle.stat()).size !== latest.size) throw failure()
      await handle.writeFile(bytes); await handle.sync(); latest.size += bytes.length
    } finally { await handle.close() }
    if (created) await syncDirectory()
    await prune()
  }
  try { await directories(true); releaseWriter = await localWriterLock(dataDir); await recover(); await syncDirectory() }
  catch { await releaseWriter?.().catch(() => {}); report(undefined, 'JOURNAL_OPEN_FAILED'); throw failure() }

  return {
    append(input: AgentDiagnosticEvent): Promise<boolean> {
      let safe: AgentDiagnosticEvent, line: string
      try {
        safe = parseAgentDiagnosticEvent(input); line = JSON.stringify(safe) + '\n'
        let permitted = true; try { permitted = allows?.(line) !== false } catch { permitted = false }
        if (!permitted) {
          safe = Object.freeze({ version: 1, id: randomUUID(), traceId: randomUUID(), at: Date.now(), scope: Object.freeze({ kind: 'host' }), stage: 'runtime', operation: 'diagnostic.redacted', outcome: 'failed', code: 'DIAGNOSTIC_REDACTED' })
          line = JSON.stringify(safe) + '\n'
        }
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw failure()
      } catch { report(undefined, 'JOURNAL_INVALID_EVENT'); return Promise.resolve(false) }
      if (closing) { report(safe, 'JOURNAL_CLOSED'); return Promise.resolve(false) }
      const size = Buffer.byteLength(line)
      if (pending >= MAX_PENDING || pendingBytes + size > MAX_PENDING_BYTES) { report(safe, 'JOURNAL_OVERFLOW'); return Promise.resolve(false) }
      pending++; pendingBytes += size
      const result = tail.then(async () => {
        try { await write(line); written++; lastWrittenAt = Date.now(); return true }
        catch { report(safe, 'JOURNAL_WRITE_FAILED'); return false }
        finally { pending--; pendingBytes -= size }
      })
      tail = result.then(() => {}, () => {})
      return result
    },
    async flush(): Promise<boolean> { await tail; return !degraded },
    close(): Promise<boolean> {
      closing = true
      closeResult ??= tail.then(async () => { try { await releaseWriter?.() } catch { report(undefined, 'JOURNAL_CLOSE_FAILED') } return !degraded })
      return closeResult.then(result => result && !degraded)
    },
    health() { return { degraded, written, failed, ...(lastWrittenAt === undefined ? {} : { lastWrittenAt }) } },
  }
}
