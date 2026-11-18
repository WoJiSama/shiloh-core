import fs, { constants, type BigIntStats } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { AgentConsoleError } from '../contracts/agentConsole.js'
import { commitConfigTransaction, inspectConfigTransaction, readConfigTransactionGroup, recoverConfigTransaction, tryConfigTransactionLease } from './standaloneAgentConfigTransaction.js'
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
const snapshots = new WeakMap<SourceSnapshot, Root>()
const maximum = 2 * 1024 * 1024
const fail = (code: 'conflict' | 'unavailable' = 'conflict'): never => { throw new AgentConsoleError(code) }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const missing = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
const identity = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino
const stamp = (s: BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode, s.uid, s.nlink].join(':')
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
function readFile(name: string, optional: boolean): { source: string | undefined; version: string } {
  let fd: number | undefined
  try {
    fd = fs.openSync(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = fs.fstatSync(fd, { bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid!()) || before.size > BigInt(maximum) || (before.mode & 0o022n) !== 0n || stamp(before) !== stamp(stat(name))) fail('unavailable')
    const bytes = fs.readFileSync(fd), source = bytes.toString('utf8'), after = fs.fstatSync(fd, { bigint: true })
    if (!Buffer.from(source).equals(bytes) || stamp(before) !== stamp(after) || stamp(after) !== stamp(stat(name))) fail()
    // Keep binding revisions identical to the runtime's agentBindingConfig reader.
    const nativeStamp = [after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs].join(':')
    return { source, version: digest(nativeStamp + '\0' + source) }
  } catch (error) {
    if (optional && missing(error)) return { source: undefined, version: 'absent' }
    if (error instanceof AgentConsoleError) throw error
    return fail('unavailable')
  } finally { if (fd !== undefined) fs.closeSync(fd) }
}
function transactionRoot(root: Root): TransactionRoot { return { root: root.root, hostFile: root.hostFile, ensureRoot: () => checkRoot(root) } }
function readRoot(root: Root): SourceSnapshot {
  return readConfigTransactionGroup(transactionRoot(root), fence => {
    const files = names(root), host = readFile(files.host, false), personas = readFile(files.personas, true), bindings = readFile(files.bindings, false)
    const versions = Object.freeze({ host: host.version, personas: personas.version, bindings: bindings.version })
    // Verify the complete read set, not only the last file read.
    for (const key of ['host', 'personas', 'bindings'] as const) if (readFile(files[key], key === 'personas').version !== versions[key]) fail()
    const sources: ConfigSources = Object.freeze({ host: host.source!, personas: personas.source, bindings: bindings.source! })
    const result: SourceSnapshot = Object.freeze({ hostFile: root.hostFile, root: root.root, versions, sources, fence,
      revision: digest(JSON.stringify([root.root, root.pins[0]!.stat.dev.toString(), root.pins[0]!.stat.ino.toString(), versions, fence])) })
    snapshots.set(result, root)
    return result
  })
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
export function isStandaloneAgentSourceSnapshotCurrent(snapshot: SourceSnapshot): boolean {
  try { const root = snapshots.get(snapshot); return !!root && readRoot(root).revision === snapshot.revision } catch { return false }
}
/** Observation only. Mutations must acquire the root lock and compare the entire read set. */
export function inspectStandaloneAgentSourceSnapshot(snapshot: SourceSnapshot): SourceSnapshot {
  const root = snapshots.get(snapshot)
  if (!root) return fail('unavailable')
  return readRoot(root)
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
