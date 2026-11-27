import fs, { constants, type BigIntStats } from 'node:fs'
import path from 'node:path'
import { isUtf8 } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { types } from 'node:util'
import { AgentConsoleError } from '../contracts/agentConsole.js'
import { initializeStandaloneConfigDatabase, isStandaloneConfigDatabase, nextStandaloneConfigDatabaseContent, openStandaloneConfigDatabase,
  readStandaloneConfigDatabase, writeStandaloneConfigDatabase } from './standaloneAgentConfigDatabase.js'
import type { ConfigDatabaseContent } from './standaloneAgentConfigDatabase.js'
import { canReuseConfigMetadata, commitConfigTransaction, configMetadataReuseCutoff, createConfigExecutionTransactionReader, inspectConfigTransaction,
  readConfigTransactionGroup, recoverConfigTransaction, sameConfigFileState, tryConfigTransactionLease } from './standaloneAgentConfigTransaction.js'
import type { ConfigRecoveryHooks, ConfigTransactionHooks, ConfigTransactionInspection, TransactionRoot } from './standaloneAgentConfigTransaction.js'
export type { ConfigRecoveryHooks, ConfigTransactionHooks, ConfigTransactionInspection } from './standaloneAgentConfigTransaction.js'

export type ConfigSourceName = 'host' | 'personas' | 'bindings'
export type ConfigSources = Readonly<{ host: string; personas: string | undefined; bindings: string; format?: 'json' }>
export interface SourceSnapshot {
  readonly hostFile: string
  readonly root: string
  readonly revision: string
  readonly versions: Readonly<Record<ConfigSourceName, string>>
  readonly sources: ConfigSources
  /** Opaque terminal transaction fence, also included in revision. */
  readonly fence: string
}
interface Pin { readonly name: string; readonly stat: BigIntStats }
interface Root { readonly hostFile: string; readonly root: string; readonly pins: readonly Pin[] }
interface Guard { readonly signal: AbortSignal; ensureCurrent(): void }
const absentFile = { source: undefined, version: 'absent' } as const
type FileRead = typeof absentFile | { readonly source: string; readonly version: string; readonly stat: BigIntStats; readonly bytes: Buffer }
const snapshots = new WeakMap<SourceSnapshot, Root>()
const observations = new WeakMap<Root, SourceSnapshot>()
type SourceReads = Readonly<Record<ConfigSourceName, FileRead>>
const verifiedSources = new WeakMap<Root, { reads: SourceReads; snapshot: SourceSnapshot; reusable: boolean }>()
const verifiedDatabases = new WeakMap<Root, { file: BigIntStats; snapshot: SourceSnapshot }>()
const localMetadata = new WeakMap<Root, boolean>()
const executionReaders = new WeakMap<Root, ReturnType<typeof createConfigExecutionTransactionReader> | null>()
type ObservationMode = 'full' | 'execution'
const maximum = 2 * 1024 * 1024
const sourceKeys = ['host', 'personas', 'bindings'] as const
const importStage = /^\.agent-config\.import-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
let configReadCount = 0, configReadMs = 0
export function standaloneConfigReadWork() {
  return { configReadCount, configReadMs }
}
function measureConfigRead<T>(read: () => T): T {
  const started = performance.now()
  try { return read() }
  finally { configReadCount++; configReadMs += performance.now() - started }
}
const fail = (code: 'conflict' | 'unavailable' = 'conflict'): never => { throw new AgentConsoleError(code) }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const missing = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
const identity = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino
const stat = (name: string) => fs.lstatSync(name, { bigint: true })
function rootFor(hostFile: string): Root {
  const absolute = path.resolve(hostFile), root = fs.realpathSync(path.dirname(absolute)), pins: Pin[] = []
  const uid = process.getuid?.()
  if (uid === undefined || /[\u0000-\u001f\u007f]/u.test(absolute) || ['persona-library.yaml', 'agent-bindings.yaml'].includes(path.basename(absolute)) || path.basename(absolute).startsWith('.agent-config.')) return fail('unavailable')
  for (let name = root; ; name = path.dirname(name)) {
    const current = stat(name)
    if (!current.isDirectory() || current.isSymbolicLink() || current.uid !== BigInt(uid) && current.uid !== 0n ||
        (current.mode & 0o022n) !== 0n && !(current.uid === 0n && (current.mode & 0o1000n) !== 0n)) return fail('unavailable')
    pins.push({ name, stat: current })
    if (path.dirname(name) === name) break
  }
  return { hostFile: path.join(root, path.basename(absolute)), root, pins }
}
function checkRoot(root: Root) {
  for (const pin of root.pins) {
    const current = stat(pin.name)
    if (!identity(current, pin.stat) || !current.isDirectory() || current.isSymbolicLink() || current.uid !== pin.stat.uid || current.mode !== pin.stat.mode) fail()
  }
}
function names(root: Root): Record<ConfigSourceName, string> {
  return { host: root.hostFile, personas: path.join(root.root, 'persona-library.yaml'), bindings: path.join(root.root, 'agent-bindings.yaml') }
}
function readFile(name: string, optional: boolean, previous?: FileRead, limit = maximum): FileRead {
  let fd: number | undefined
  try {
    fd = fs.openSync(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = fs.fstatSync(fd, { bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid!()) || before.size > BigInt(limit) ||
        (before.mode & 0o022n) !== 0n || !sameConfigFileState(before, stat(name))) fail('unavailable')
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd, { bigint: true })
    if (bytes.length !== Number(after.size) || !sameConfigFileState(before, after) || !sameConfigFileState(after, stat(name))) fail()
    // Reuse decoded text and its digest only after observing and comparing every byte.
    if (previous?.source !== undefined && sameConfigFileState(after, previous.stat) && bytes.equals(previous.bytes)) return previous
    if (!isUtf8(bytes)) fail()
    // Keep binding revisions identical to the runtime's agentBindingConfig reader.
    const nativeStamp = [after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs].join(':')
    return { source: bytes.toString('utf8'), version: createHash('sha256').update(nativeStamp + '\0').update(bytes).digest('hex'), stat: after, bytes }
  } catch (error) {
    if (optional && fd === undefined && missing(error)) return absentFile
    if (error instanceof AgentConsoleError) throw error
    return fail('unavailable')
  } finally { if (fd !== undefined) fs.closeSync(fd) }
}
function transactionRoot(root: Root): TransactionRoot { return { root: root.root, hostFile: root.hostFile, ensureRoot: () => checkRoot(root) } }

function privateFile(file: BigIntStats, links = 1n): boolean {
  return file.isFile() && file.nlink === links && file.uid === BigInt(process.getuid!()) && (file.mode & 0o077n) === 0n
}

function databaseFiles(root: Root) {
  checkRoot(root)
  const file = stat(root.hostFile)
  const journal = fs.lstatSync(root.hostFile + '-journal', { bigint: true, throwIfNoEntry: false })
  if (!privateFile(file) || journal && !privateFile(journal) ||
      ['-wal', '-shm'].some(suffix => fs.lstatSync(root.hostFile + suffix, { throwIfNoEntry: false }))) return fail('unavailable')
  return { file, journal }
}

function openDatabase(root: Root, readOnly: boolean) {
  const initial = databaseFiles(root)
  const ensureCurrent = () => {
    const current = databaseFiles(root)
    if (!identity(initial.file, current.file)) return fail()
    return current
  }
  const db = openStandaloneConfigDatabase(root.hostFile, readOnly)
  try { ensureCurrent(); return { db, ensureCurrent, initial } }
  catch (error) { db.close(); throw error }
}

function readDatabaseSnapshot(root: Root, opened?: ReturnType<typeof openDatabase>, reuse = false): SourceSnapshot {
  const session = opened ?? openDatabase(root, true)
  try {
    return measureConfigRead(() => {
      const cutoff = reuse ? configMetadataReuseCutoff() : undefined
      const before = session.ensureCurrent()
      const { sources, versions, generation } = readStandaloneConfigDatabase(session.db)
      const after = session.ensureCurrent()
      const fence = digest(JSON.stringify([generation, versions, sources]))
      const revision = digest(JSON.stringify([root.hostFile, String(session.initial.file.dev), String(session.initial.file.ino), fence]))
      const snapshot = Object.freeze({ hostFile: root.hostFile, root: root.root, sources, versions, fence, revision })
      snapshots.set(snapshot, root)
      if (cutoff !== undefined && !session.initial.journal && !before.journal && !after.journal &&
          sameConfigFileState(session.initial.file, before.file) && sameConfigFileState(before.file, after.file) &&
          canReuseConfigMetadata(after.file, root.pins[0]!.stat.dev, cutoff)) {
        verifiedDatabases.set(root, { file: after.file, snapshot })
      }
      return snapshot
    })
  } finally { if (!opened) session.db.close() }
}

function supportsLocalConfigMetadata(root: Root): boolean {
  const cached = localMetadata.get(root)
  if (cached !== undefined) return cached
  // Metadata fast paths require local Linux inode and change-time semantics.
  let local = false
  try { local = process.platform === 'linux' && [0xef53, 0x01021994, 0x58465342, 0x9123683e].includes(fs.statfsSync(root.root).type >>> 0) }
  catch { /* The complete read remains available. */ }
  localMetadata.set(root, local)
  return local
}

function executionReader(root: Root) {
  let read = executionReaders.get(root)
  if (read !== undefined) return read
  read = supportsLocalConfigMetadata(root) ? createConfigExecutionTransactionReader(transactionRoot(root), root.pins[0]!.stat.dev) : null
  executionReaders.set(root, read)
  return read
}
function matchesFiles(files: ReturnType<typeof names>, reads: SourceReads): boolean {
  return sourceKeys.every(key => {
    const current = fs.lstatSync(files[key], { bigint: true, throwIfNoEntry: false }), prior = reads[key]
    return prior.source === undefined ? !current : !!current && sameConfigFileState(current, prior.stat)
  })
}
function readRoot(root: Root, mode: ObservationMode = 'full'): SourceSnapshot {
  if (isStandaloneConfigDatabase(root.hostFile)) {
    const reuse = mode === 'execution' && supportsLocalConfigMetadata(root)
    const previous = reuse ? verifiedDatabases.get(root) : undefined
    if (previous) {
      // Every execution check still fences the pinned path and transaction sidecars.
      const unchanged = measureConfigRead(() => {
        const { file, journal } = databaseFiles(root)
        return !journal && sameConfigFileState(file, previous.file)
      })
      if (unchanged) return previous.snapshot
      verifiedDatabases.delete(root)
    }
    return readDatabaseSnapshot(root, undefined, reuse)
  }
  const previous = verifiedSources.get(root), files = names(root)
  const query = mode === 'execution' ? executionReader(root) : null
  if (query && previous?.reusable) {
    // Reuse only validated bytes. Verify both the files and durable transaction fence on every check.
    const unchanged = measureConfigRead(() => query(fence => fence === previous.snapshot.fence && matchesFiles(files, previous.reads)))
    if (unchanged) return previous.snapshot
  }
  const cutoff = configMetadataReuseCutoff(), device = root.pins[0]!.stat.dev
  const { reads, snapshot } = measureConfigRead(() => readConfigTransactionGroup(transactionRoot(root), fence => {
    const prior = previous?.reads
    const host = readFile(files.host, false, prior?.host), personas = readFile(files.personas, true, prior?.personas),
      bindings = readFile(files.bindings, false, prior?.bindings)
    const reads = { host, personas, bindings }
    const versions = Object.freeze({ host: host.version, personas: personas.version, bindings: bindings.version })
    // Verify the complete read set, not only the last file read.
    for (const key of sourceKeys) if (readFile(files[key], key === 'personas', reads[key]) !== reads[key]) fail()
    const sources: ConfigSources = Object.freeze({ host: host.source!, personas: personas.source, bindings: bindings.source! })
    const snapshot: SourceSnapshot = Object.freeze({ hostFile: root.hostFile, root: root.root, versions, sources, fence,
      revision: digest(JSON.stringify([root.root, root.pins[0]!.stat.dev.toString(), root.pins[0]!.stat.ino.toString(), versions, fence])) })
    return { reads, snapshot }
  }))
  const reusable = sourceKeys.every(key => { const file = reads[key]; return file.source === undefined || canReuseConfigMetadata(file.stat, device, cutoff) })
  verifiedSources.set(root, { reads, snapshot, reusable })
  snapshots.set(snapshot, root)
  return snapshot
}
export interface StandaloneAgentConfigLock {
  read(): SourceSnapshot
  ensureCurrent(): void
  commitSources(next: ConfigSources, expected: SourceSnapshot, hooks: ConfigTransactionHooks): { readonly txId: string; readonly snapshot: SourceSnapshot }
  commit(target: ConfigSourceName, source: string, expected: SourceSnapshot, ensureCurrent: () => void, onCommitted: () => void): SourceSnapshot
  release(): void
}

function tryDatabaseLock(root: Root): StandaloneAgentConfigLock | undefined {
  let session: ReturnType<typeof openDatabase> | undefined
  try {
    session = openDatabase(root, false)
    session.db.exec('BEGIN IMMEDIATE')
  } catch (error) {
    session?.db.close()
    const code = (error as { errcode?: number })?.errcode
    if (code === 5 || code === 6) return undefined
    throw error
  }
  const opened = session, { db } = opened
  let released = false
  const ensureCurrent = () => { if (released) fail(); opened.ensureCurrent() }
  const read = () => { ensureCurrent(); return readDatabaseSnapshot(root, opened) }
  const commitSources = (next: ConfigSources, expected: SourceSnapshot, hooks: ConfigTransactionHooks) => {
    ensureCurrent(); hooks.ensureActorCurrent()
    if (!snapshots.has(expected) || read().revision !== expected.revision) return fail()
    if (sourceKeys.every(key => next[key] === expected.sources[key])) return { txId: '', snapshot: expected }
    const content = nextStandaloneConfigDatabaseContent(next, readStandaloneConfigDatabase(db))
    const txId = content.generation
    hooks.onFenced(txId)
    ensureCurrent(); hooks.ensureActorCurrent()
    writeStandaloneConfigDatabase(db, content)
    ensureCurrent(); hooks.ensureActorCurrent()
    db.exec('COMMIT')
    hooks.onCommitPublished(txId)
    // Keep the published revision stable while its HTTP receipt is verified.
    db.exec('BEGIN IMMEDIATE')
    if (readStandaloneConfigDatabase(db).generation !== txId) return fail()
    return { txId, snapshot: read() }
  }
  return {
    ensureCurrent, read, commitSources,
    release() { if (!released) { released = true; db.close() } },
    commit(target, source, expected, guard, onCommitted) {
      if (!sourceKeys.includes(target) || typeof source !== 'string') return fail()
      return commitSources({ ...expected.sources, [target]: source }, expected,
        { ensureActorCurrent: guard, onFenced() {}, onCommitPublished: onCommitted }).snapshot
    },
  }
}

function tryLock(root: Root): StandaloneAgentConfigLock | undefined {
  if (isStandaloneConfigDatabase(root.hostFile)) return tryDatabaseLock(root)
  const io = transactionRoot(root), lease = tryConfigTransactionLease(io)
  if (!lease) return undefined
  const commitSources = (next: ConfigSources, expected: SourceSnapshot, hooks: ConfigTransactionHooks) => {
    lease.ensureCurrent()
    if (!snapshots.has(expected) || expected.hostFile !== root.hostFile) return fail()
    return commitConfigTransaction(io, lease, next, expected, () => readRoot(root), hooks)
  }
  return {
    ensureCurrent: lease.ensureCurrent,
    read() { lease.ensureCurrent(); return readRoot(root) },
    release: lease.release,
    commitSources,
    commit(target, source, expected, guard, onCommitted) {
      if (!['host', 'personas', 'bindings'].includes(target) || typeof source !== 'string') return fail()
      return commitSources(Object.freeze({ ...expected.sources, [target]: source }), expected,
        { ensureActorCurrent: guard, onFenced() {}, onCommitPublished: onCommitted }).snapshot
    },
  }
}
/** Only fixed transaction metadata is exposed; source bytes and arbitrary errors are never returned. */
export function inspectStandaloneAgentConfigTransaction(hostFile: string): ConfigTransactionInspection {
  try {
    const root = rootFor(hostFile)
    if (!isStandaloneConfigDatabase(root.hostFile)) return inspectConfigTransaction(transactionRoot(root))
    readRoot(root)
    return { phase: 'clean' }
  }
  catch { return { phase: 'blocked', reason: 'invalid-state' } }
}
/** Explicit offline recovery only. Normal readers and acquire never reclaim an abandoned owner. */
export function recoverStandaloneAgentConfigTransaction(hostFile: string, hooks: ConfigRecoveryHooks): {
  readonly phase: 'clean' | 'recovered'; readonly txId?: string; readonly direction?: 'undo' | 'redo'; readonly snapshot: SourceSnapshot
} {
  const root = rootFor(hostFile)
  if (isStandaloneConfigDatabase(root.hostFile)) {
    hooks.ensureOfflineCurrent()
    const published = stat(root.hostFile)
    const interruptedImport = privateFile(published, 2n)
    if (interruptedImport) {
      // A crash between the no-replace publication and removal of its private staging name.
      const aliases = fs.readdirSync(root.root).filter(name => importStage.test(name)).map(name => path.join(root.root, name))
        .filter(name => identity(stat(name), published))
      const alias = aliases[0]
      if (aliases.length !== 1 || !alias) return fail()
      const db = openStandaloneConfigDatabase(root.hostFile, true)
      try { readStandaloneConfigDatabase(db) } finally { db.close() }
      hooks.ensureOfflineCurrent(); checkRoot(root)
      if (!sameConfigFileState(published, stat(root.hostFile)) || !sameConfigFileState(published, stat(alias))) return fail()
      fs.unlinkSync(alias)
      syncConfigDirectory(root.root)
    }
    const lock = tryDatabaseLock(root)
    if (!lock) return fail()
    try { hooks.ensureOfflineCurrent(); return { phase: interruptedImport ? 'recovered' : 'clean', snapshot: lock.read() } }
    finally { lock.release() }
  }
  return recoverConfigTransaction(transactionRoot(root), hooks, () => readRoot(root))
}
/** Startup reader: one synchronous, non-reentrant root lock; never accepts an async callback. */
export function readStandaloneAgentSourceSnapshot(hostFile: string): SourceSnapshot {
  const root = rootFor(hostFile), lock = tryLock(root)
  if (!lock) return fail()
  try { return lock.read() } finally { lock.release() }
}
export function isStandaloneAgentSourceSnapshotCurrent(snapshot: SourceSnapshot, mode: ObservationMode = 'full'): boolean {
  try { return inspectStandaloneAgentSourceSnapshot(snapshot, mode).revision === snapshot.revision } catch { return false }
}
/** Observation only. Mutations must acquire the root lock and compare the entire read set. */
export function inspectStandaloneAgentSourceSnapshot(snapshot: SourceSnapshot, mode: ObservationMode = 'full'): SourceSnapshot {
  const root = snapshots.get(snapshot)
  if (!root) return fail('unavailable')
  return observations.get(root) ?? readRoot(root, mode)
}
/** Pure synchronous checks share one read set, with a fresh fence on return.
 * Callers retain their loaded-version policy, including live bindings without a console. */
export function observeStandaloneAgentSourceSnapshot(snapshot: SourceSnapshot, check: () => boolean,
  mode: ObservationMode = 'full'): Readonly<{ current: boolean; accepted: boolean }> {
  const root = snapshots.get(snapshot)
  const failed = { current: false, accepted: false } as const
  if (!root) return failed
  const evaluate = () => {
    try {
      const value: unknown = check()
      if (types.isPromise(value)) {
        try { void Promise.prototype.then.call(value, undefined, () => {}) } catch { /* Async checks are always rejected. */ }
      }
      return value === true
    } catch { return false }
  }
  if (observations.has(root)) return { current: true, accepted: evaluate() }
  let entry: SourceSnapshot
  try { entry = readRoot(root, mode) } catch { return failed }
  observations.set(root, entry)
  let accepted: boolean
  try { accepted = evaluate() } finally { observations.delete(root) }
  try {
    if (isStandaloneConfigDatabase(root.hostFile)) {
      const current = readRoot(root, mode).revision === entry.revision
      return { current, accepted: current && accepted }
    }
    const { reads, reusable } = verifiedSources.get(root)!
    const files = names(root), query = mode === 'execution' && reusable ? executionReader(root) : null
    const current = measureConfigRead(() => query
      ? query(fence => fence === entry.fence && matchesFiles(files, reads))
      : readConfigTransactionGroup(transactionRoot(root), fence =>
        fence === entry.fence && sourceKeys.every(key => readFile(files[key], key === 'personas', reads[key]) === reads[key])))
    return { current, accepted: current && accepted }
  } catch { return failed }
}

export function checkStandaloneAgentConfigDatabaseDestination(file: string): string {
  const root = rootFor(file)
  if (!isStandaloneConfigDatabase(root.hostFile) || fs.lstatSync(root.hostFile, { throwIfNoEntry: false }) ||
      ['-journal', '-wal', '-shm'].some(suffix => fs.lstatSync(root.hostFile + suffix, { throwIfNoEntry: false }))) return fail()
  return root.hostFile
}

export function readStandaloneAgentConfigImportFile(file: string): { readonly source: string; readonly isCurrent: () => boolean } {
  const root = rootFor(file)
  const input = readFile(root.hostFile, false, undefined, 8 * 1024 * 1024)
  return { source: input.source!, isCurrent: () => {
    checkRoot(root)
    return readFile(root.hostFile, false, input, 8 * 1024 * 1024) === input
  } }
}

function syncConfigDirectory(root: string): void {
  const directory = fs.openSync(root, constants.O_RDONLY | constants.O_DIRECTORY)
  try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
}

function publishConfigFile(file: string, write: (stage: string) => void, ensureCurrent: () => void): void {
  const root = rootFor(file)
  if (fs.lstatSync(root.hostFile, { throwIfNoEntry: false })) return fail()
  const stage = path.join(root.root, '.agent-config.import-' + randomUUID())
  const fd = fs.openSync(stage, 'wx', 0o600)
  const staged = fs.fstatSync(fd, { bigint: true })
  fs.closeSync(fd)
  try {
    write(stage)
    checkRoot(root)
    ensureCurrent()
    if (!identity(staged, stat(stage))) return fail()
    fs.linkSync(stage, root.hostFile)
  } finally {
    checkRoot(root)
    if (identity(staged, stat(stage))) fs.unlinkSync(stage)
  }
  syncConfigDirectory(root.root)
}

/** A validated import is visible at its final path only after SQLite has committed. */
export function publishStandaloneAgentConfigDatabase(file: string, content: ConfigDatabaseContent, ensureCurrent: () => void): void {
  publishConfigFile(checkStandaloneAgentConfigDatabaseDestination(file),
    stage => initializeStandaloneConfigDatabase(stage, content), ensureCurrent)
}

export function exportStandaloneAgentConfigFile(file: string, source: string, ensureCurrent: () => void): void {
  if (path.extname(file).toLowerCase() !== '.json' || Buffer.byteLength(source) > 8 * 1024 * 1024) return fail()
  publishConfigFile(file, stage => {
    const fd = fs.openSync(stage, constants.O_WRONLY | constants.O_NOFOLLOW)
    try { fs.writeFileSync(fd, source); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  }, ensureCurrent)
}
/** Compatibility entry point using the complete synchronous configuration observation. */
export function withStandaloneAgentConfigObservation(snapshot: SourceSnapshot, check: () => boolean): boolean {
  let failure: { error: unknown } | undefined
  const result = observeStandaloneAgentSourceSnapshot(snapshot, () => {
    try { return check() } catch (error) { failure = { error }; return false }
  })
  if (failure) throw failure.error
  return result.accepted
}
/** Runtime lock acquisition is bounded and abortable; an abandoned lock is never stolen. */
export async function acquireStandaloneAgentConfigLock(snapshot: SourceSnapshot, guard: Guard): Promise<StandaloneAgentConfigLock> {
  const root = snapshots.get(snapshot)
  if (!root) return fail('unavailable')
  const deadline = Date.now() + 1000
  for (;;) {
    guard.ensureCurrent(); if (guard.signal.aborted) return fail()
    const lock = tryLock(root)
    if (lock) {
      try { guard.ensureCurrent(); if (guard.signal.aborted) return fail(); return lock }
      catch (error) { lock.release(); throw error }
    }
    if (Date.now() >= deadline) return fail()
    await new Promise<void>(resolve => { const timer = setTimeout(done, 10); function done() { clearTimeout(timer); guard.signal.removeEventListener('abort', done); resolve() }; guard.signal.addEventListener('abort', done, { once: true }) })
  }
}
