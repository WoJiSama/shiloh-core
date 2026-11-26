import fs, { constants, type BigIntStats } from 'node:fs'
import path from 'node:path'
import { isUtf8 } from 'node:buffer'
import { createHash } from 'node:crypto'
import { types } from 'node:util'
import { AgentConsoleError } from '../contracts/agentConsole.js'
import { canReuseConfigMetadata, commitConfigTransaction, configMetadataReuseCutoff, createConfigExecutionTransactionReader, inspectConfigTransaction,
  readConfigTransactionGroup, recoverConfigTransaction, sameConfigFileState, tryConfigTransactionLease } from './standaloneAgentConfigTransaction.js'
import type { ConfigRecoveryHooks, ConfigTransactionHooks, ConfigTransactionInspection, TransactionRoot } from './standaloneAgentConfigTransaction.js'
export type { ConfigRecoveryHooks, ConfigTransactionHooks, ConfigTransactionInspection } from './standaloneAgentConfigTransaction.js'

export type ConfigSources = Readonly<{ host: string; personas: string | undefined; bindings: string }>
export type ConfigSourceName = keyof ConfigSources
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
const executionReaders = new WeakMap<Root, ReturnType<typeof createConfigExecutionTransactionReader> | null>()
type ObservationMode = 'full' | 'execution'
const maximum = 2 * 1024 * 1024
const sourceKeys = ['host', 'personas', 'bindings'] as const
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
function readFile(name: string, optional: boolean, previous?: FileRead): FileRead {
  let fd: number | undefined
  try {
    fd = fs.openSync(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = fs.fstatSync(fd, { bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid!()) || before.size > BigInt(maximum) ||
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
function executionReader(root: Root) {
  let read = executionReaders.get(root)
  if (read !== undefined) return read
  // Metadata fast paths require local Linux inode and change-time semantics.
  let local = false
  try { local = process.platform === 'linux' && [0xef53, 0x01021994, 0x58465342, 0x9123683e].includes(fs.statfsSync(root.root).type >>> 0) }
  catch { /* The complete read remains available. */ }
  read = local ? createConfigExecutionTransactionReader(transactionRoot(root), root.pins[0]!.stat.dev) : null
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
function tryLock(root: Root): StandaloneAgentConfigLock | undefined {
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
  try { return inspectConfigTransaction(transactionRoot(rootFor(hostFile))) }
  catch { return { phase: 'blocked', reason: 'invalid-state' } }
}
/** Explicit offline recovery only. Normal readers and acquire never reclaim an abandoned owner. */
export function recoverStandaloneAgentConfigTransaction(hostFile: string, hooks: ConfigRecoveryHooks): {
  readonly phase: 'clean' | 'recovered'; readonly txId?: string; readonly direction?: 'undo' | 'redo'; readonly snapshot: SourceSnapshot
} {
  const root = rootFor(hostFile)
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
  const { reads, reusable } = verifiedSources.get(root)!
  observations.set(root, entry)
  let accepted: boolean
  try { accepted = evaluate() } finally { observations.delete(root) }
  try {
    const files = names(root), query = mode === 'execution' && reusable ? executionReader(root) : null
    const current = measureConfigRead(() => query
      ? query(fence => fence === entry.fence && matchesFiles(files, reads))
      : readConfigTransactionGroup(transactionRoot(root), fence =>
        fence === entry.fence && sourceKeys.every(key => readFile(files[key], key === 'personas', reads[key]) === reads[key])))
    return { current, accepted: current && accepted }
  } catch { return failed }
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
