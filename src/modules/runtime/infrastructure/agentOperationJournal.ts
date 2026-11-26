import fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { constants, type Stats } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { stderr } from 'node:process'
import { isProxy } from 'node:util/types'
import type { AgentBindingSnapshot, PlatformAccountRef } from '../../../contracts/agentBinding.js'
import { agentDiagnosticResults, agentDiagnosticValueTypes, agentJournalWriteSteps, type AgentDiagnosticDetails, type AgentDiagnosticEvent, type AgentDiagnosticScope,
  type AgentJournalWriteObserver, type AgentJournalWriteStep, type AgentOperationJournal } from '../../../contracts/agentDiagnostics.js'

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
export function parseAgentDiagnosticDetails(value: unknown): Readonly<AgentDiagnosticDetails> {
  const row = record(value, ['step', 'cause', 'field', 'rule', 'expectedType', 'actualType', 'limit', 'nativeCode', 'dispatched', 'result',
    'retryInMs', 'attempt', 'maxAttempts', 'causeEventId', 'queueMs', 'stepMs', 'blockingStep', 'slowestCompletedStep', 'slowestCompletedStepMs',
    'dispatchTurnPending', 'dispatchTurnMs', 'loopActiveMs', 'configReadCount', 'configReadMs', 'timeoutOverrunMs', 'outputTokens', 'reasoningTokens', 'requestedSeq', 'firstUnseenSeq', 'bytesWritten', 'bytesExpected'])
  for (const key of ['step', 'cause', 'field', 'rule', 'causeEventId', 'slowestCompletedStep']) if (row[key] !== undefined) token(row[key])
  for (const key of ['limit', 'retryInMs', 'attempt', 'maxAttempts', 'queueMs', 'stepMs', 'slowestCompletedStepMs',
    'dispatchTurnMs', 'loopActiveMs', 'configReadCount', 'configReadMs', 'timeoutOverrunMs', 'outputTokens', 'reasoningTokens', 'requestedSeq', 'firstUnseenSeq', 'bytesWritten', 'bytesExpected']) if (row[key] !== undefined &&
      (!Number.isSafeInteger(row[key]) || Number(row[key]) < 0)) throw failure()
  if (row.blockingStep !== undefined && !agentJournalWriteSteps.some(step => step === row.blockingStep)) throw failure()
  if (row.nativeCode !== undefined && (!Number.isInteger(row.nativeCode) || Math.abs(Number(row.nativeCode)) > 2_147_483_647)) throw failure()
  for (const key of ['dispatched', 'dispatchTurnPending']) if (row[key] !== undefined && typeof row[key] !== 'boolean') throw failure()
  if (row.result !== undefined && !agentDiagnosticResults.some(item => item === row.result)) throw failure()
  for (const key of ['expectedType', 'actualType']) if (row[key] !== undefined &&
      !agentDiagnosticValueTypes.some(type => type === row[key])) throw failure()
  return Object.freeze(row) as AgentDiagnosticDetails
}

/** The writer and read view share the same closed metadata schema, including historical v1 records. */
export function parseAgentDiagnosticEvent(value: unknown): Readonly<AgentDiagnosticEvent> {
  const row = record(value, ['version', 'id', 'traceId', 'at', 'scope', 'stage', 'operation', 'outcome', 'code', 'sourceTag', 'durationMs', 'errorKind', 'httpStatus', 'details', 'configurationRevision', 'delivery'])
  if (row.version !== 1 || !Number.isSafeInteger(row.at) || Number(row.at) < 0 || Number(row.at) > 8_640_000_000_000_000 ||
      typeof row.stage !== 'string' || !stages.includes(row.stage) || typeof row.outcome !== 'string' || !outcomes.includes(row.outcome) ||
      row.durationMs !== undefined && (!Number.isSafeInteger(row.durationMs) || Number(row.durationMs) < 0) ||
      row.errorKind !== undefined && (typeof row.errorKind !== 'string' || !errorKinds.includes(row.errorKind)) ||
      row.sourceTag !== undefined && (typeof row.sourceTag !== 'string' || !/^[\p{Script=Han}\p{L}\p{N} _-]{1,24}$/u.test(row.sourceTag)) ||
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
    ...(row.code === undefined ? {} : { code: token(row.code) }), ...(row.sourceTag === undefined ? {} : { sourceTag: row.sourceTag as string }),
    ...(row.durationMs === undefined ? {} : { durationMs: row.durationMs as number }),
    ...(row.errorKind === undefined ? {} : { errorKind: row.errorKind as NonNullable<AgentDiagnosticEvent['errorKind']> }), ...(row.httpStatus === undefined ? {} : { httpStatus: row.httpStatus as number }),
    ...(row.details === undefined ? {} : { details: parseAgentDiagnosticDetails(row.details) }),
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
  const queue: { safe: AgentDiagnosticEvent; line: string; size: number; resolve(ok: boolean): void; observe?: AgentJournalWriteObserver }[] = []
  let draining: Promise<void> | undefined, pending = 0, pendingBytes = 0
  let activeStep: AgentJournalWriteStep | undefined
  let closeResult: Promise<boolean> | undefined
  let latest: { name: string; size: number; dev: number; ino: number; needsDirectorySync: boolean } | undefined
  let activeFile: FileHandle | undefined
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
    try { stderr.write(`[AgentDiagnostics] ${code}${safe ? ' ' + JSON.stringify(safe) : ''}\n`) } catch { /* No recursive logging. */ }
  }
  async function directories(initial = false): Promise<void> {
    if (initial) await fs.mkdir(dataDir, { recursive: true, mode: 0o700 })
    if (initial) {
      const root = await fs.lstat(dataDir)
      if (!root.isDirectory()) throw failure()
    }
    if (initial) await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error })
    const [root, own] = await Promise.all([fs.lstat(dataDir), fs.lstat(directory)])
    if (!root.isDirectory() || root.isSymbolicLink() || rootIdentity && (rootIdentity.dev !== root.dev || rootIdentity.ino !== root.ino)) throw failure()
    if (!own.isDirectory() || own.isSymbolicLink() || (own.mode & 0o777) !== 0o700 || directoryIdentity && (directoryIdentity.dev !== own.dev || directoryIdentity.ino !== own.ino)) throw failure()
    rootIdentity ??= { dev: root.dev, ino: root.ino }; directoryIdentity ??= { dev: own.dev, ino: own.ino }
  }
  async function syncDirectory(): Promise<void> {
    await directories()
    const handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { await handle.sync() } finally { await handle.close() }
  }
  function validateFile(stat: Stats) {
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size > 64 * MiB) throw failure()
  }
  async function verifyPath(name: string, expected: { dev: number; ino: number; size: number }, advance?: (step: AgentJournalWriteStep) => void) {
    advance?.('journal_verify_directories')
    await directories()
    advance?.('journal_verify_path')
    const actual = await fs.lstat(path.join(directory, name))
    validateFile(actual)
    if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.size !== expected.size) throw failure()
  }
  async function verifyFile(name: string, handle: FileHandle, advance?: (step: AgentJournalWriteStep) => void) {
    advance?.('journal_verify')
    const stat = await handle.stat()
    validateFile(stat)
    await verifyPath(name, stat, advance)
    return stat
  }
  async function privateFile(name: string, flags: number): Promise<FileHandle> {
    const handle = await fs.open(path.join(directory, name), flags | constants.O_NOFOLLOW, 0o600)
    try { await verifyFile(name, handle); return handle }
    catch (error) { await handle.close(); throw error }
  }
  async function closeFile(): Promise<void> {
    const handle = activeFile
    activeFile = undefined
    await handle?.close()
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
        const stat = await handle.stat()
        let { size } = stat
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
        latest = { name, size, dev: stat.dev, ino: stat.ino, needsDirectorySync: false }
      } finally { await handle.close() }
    }
    await prune()
  }
  function progress(observe: AgentJournalWriteObserver | undefined, step: AgentJournalWriteStep,
    blockingStep?: () => AgentJournalWriteStep | undefined): void {
    try { observe?.(step, blockingStep) } catch { /* Progress observers cannot obstruct writes. */ }
  }

  async function write(line: string, advance: (step: AgentJournalWriteStep) => void): Promise<void> {
    const bytes = Buffer.from(line, 'utf8'), today = day()
    let file = latest
    try {
      if (!file || !file.name.startsWith(today + '.') || file.size + bytes.length > maximum) {
        if (activeFile) { advance('journal_close'); await closeFile() }
        advance('journal_open')
        const existing = (await names()).filter(name => name.startsWith(today + '.'))
        const sequence = Number(existing.at(-1)?.match(filePattern)?.[2] ?? -1) + 1
        if (sequence > 999999) throw failure()
        const name = `${today}.${String(sequence).padStart(6, '0')}.ndjson`
        activeFile = await fs.open(path.join(directory, name), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT |
          constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        const stat = await verifyFile(name, activeFile, advance)
        if (stat.size !== 0) throw failure()
        latest = file = { name, size: 0, dev: stat.dev, ino: stat.ino, needsDirectorySync: true }
      } else {
        if (!activeFile) {
          advance('journal_open')
          await directories()
          activeFile = await fs.open(path.join(directory, file.name), constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW, 0o600)
          const stat = await verifyFile(file.name, activeFile, advance)
          if (stat.size !== file.size || stat.dev !== file.dev || stat.ino !== file.ino) throw failure()
        } else {
          // An open descriptor keeps its inode. Recheck today's path and
          // length against the confirmed inode before each durable append.
          await verifyPath(file.name, file, advance)
        }
      }
      const handle = activeFile
      try {
        advance('journal_write')
        await handle.writeFile(bytes)
        advance('journal_sync')
        await handle.sync()
        file.size += bytes.length
      } catch (error) {
        // A failed append can leave a partial line. Only truncate bytes from
        // this writer's failed batch, keeping every acknowledged event.
        advance('journal_recovery')
        try { await handle.truncate(file.size); await handle.sync() } catch { /* Keep the last confirmed offset for recovery. */ }
        throw error
      }
      if (file.needsDirectorySync) {
        advance('journal_directory_sync')
        await syncDirectory()
        file.needsDirectorySync = false
        advance('journal_retention')
        await prune().catch(() => report(undefined, 'JOURNAL_RETENTION_FAILED'))
      }
    } catch (error) {
      if (activeFile) { advance('journal_close'); await closeFile().catch(() => {}) }
      throw error
    }
  }
  function drain() {
    if (draining) return
    draining = Promise.resolve().then(async () => {
      while (queue.length) {
        const first = queue[0]!
        const remaining = latest?.name.startsWith(day() + '.') ? maximum - latest.size : maximum
        const budget = Math.min(64 * 1024, first.size <= remaining ? remaining : maximum)
        let count = 0, batchBytes = 0
        while (count < Math.min(queue.length, 64) && batchBytes + queue[count]!.size <= budget) {
          batchBytes += queue[count]!.size
          count++
        }
        const batch = queue.splice(0, count)
        let committed = false
        try {
          await write(batch.map(item => item.line).join(''), step => {
            activeStep = step
            for (const item of batch) progress(item.observe, step)
          })
          committed = true
          written += batch.length
          lastWrittenAt = Date.now()
        } catch (error) {
          const code = error && typeof error === 'object' && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ENOSPC'
            ? 'JOURNAL_NO_SPACE' : 'JOURNAL_WRITE_FAILED'
          for (const item of batch) report(item.safe, code)
        } finally {
          activeStep = undefined
          pending -= batch.length
          pendingBytes -= batchBytes
          for (const item of batch) item.resolve(committed)
        }
      }
    }).finally(() => { draining = undefined; if (queue.length) drain() })
  }
  async function flush() {
    while (draining) await draining
    return !degraded
  }
  try { await directories(true); releaseWriter = await localWriterLock(dataDir); await recover(); await syncDirectory() }
  catch { await releaseWriter?.().catch(() => {}); report(undefined, 'JOURNAL_OPEN_FAILED'); throw failure() }

  return {
    append(input: AgentDiagnosticEvent, observe?: AgentJournalWriteObserver): Promise<boolean> {
      let safe: AgentDiagnosticEvent, line: string
      try {
        safe = parseAgentDiagnosticEvent(input); line = JSON.stringify(safe) + '\n'
        if (allows) {
          const permitted = (value: string) => { try { return allows(value) } catch { return false } }
          if (!permitted(line)) {
            const generatedId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id) && permitted(id)
            const keepTrace = generatedId(safe.id) && generatedId(safe.traceId)
            const minimal = { version: 1 as const, id: keepTrace ? safe.id : randomUUID(), traceId: keepTrace ? safe.traceId : randomUUID(),
              at: safe.at, scope: { kind: 'host' as const },
              stage: safe.stage, operation: 'diagnostic.redacted', outcome: safe.outcome, code: 'DIAGNOSTIC_REDACTED' }
            const metadata = Object.fromEntries(Object.entries(safe.details ?? {}).filter(([, value]) => permitted(String(value))))
            const sanitized = { ...minimal, operation: safe.operation, code: safe.code ?? 'DIAGNOSTIC_REDACTED',
              ...(safe.durationMs === undefined ? {} : { durationMs: safe.durationMs }),
              ...(safe.httpStatus === undefined ? {} : { httpStatus: safe.httpStatus }),
              details: { cause: 'diagnostic_metadata_redacted', ...metadata } }
            const reduced = JSON.stringify(sanitized) + '\n'
            line = keepTrace && permitted(reduced) ? reduced : JSON.stringify(minimal) + '\n'
            if (!permitted(line)) line = JSON.stringify({ ...minimal, id: randomUUID(), traceId: randomUUID() }) + '\n'
            safe = parseAgentDiagnosticEvent(JSON.parse(line))
          }
        }
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw failure()
      } catch { report(undefined, 'JOURNAL_INVALID_EVENT'); return Promise.resolve(false) }
      if (closing) { report(safe, 'JOURNAL_CLOSED'); return Promise.resolve(false) }
      const size = Buffer.byteLength(line)
      if (pending >= MAX_PENDING || pendingBytes + size > MAX_PENDING_BYTES) { report(safe, 'JOURNAL_OVERFLOW'); return Promise.resolve(false) }
      pending++; pendingBytes += size
      return new Promise(resolve => {
        queue.push({ safe, line, size, resolve, ...(observe ? { observe } : {}) })
        progress(observe, 'journal_queue', () => activeStep)
        drain()
      })
    },
    flush,
    close(): Promise<boolean> {
      closing = true
      closeResult ??= flush().then(async () => {
        try { await closeFile() } catch { report(undefined, 'JOURNAL_CLOSE_FAILED') }
        try { await releaseWriter?.() } catch { report(undefined, 'JOURNAL_CLOSE_FAILED') }
        return !degraded
      })
      return closeResult.then(result => result && !degraded)
    },
    health() { return { degraded, written, failed, ...(lastWrittenAt === undefined ? {} : { lastWrittenAt }) } },
  }
}
