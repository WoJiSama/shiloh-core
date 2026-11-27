import fs, { constants, type BigIntStats } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { AgentConsoleError } from '../contracts/agentConsole.js'
import type { ConfigSources, ConfigSourceName, SourceSnapshot } from './standaloneAgentConfigSources.js'

export interface ConfigTransactionHooks {
  ensureActorCurrent(): void
  onFenced(txId: string): void
  onCommitPublished(txId: string): void
}
export interface ConfigTransactionInspection {
  readonly phase: 'clean' | 'recovery-required' | 'blocked'
  readonly txId?: string
  readonly direction?: 'undo' | 'redo'
  readonly reason?: 'owner-unavailable' | 'invalid-state'
}
export interface ConfigRecoveryHooks { ensureOfflineCurrent(): void }
export interface TransactionRoot { readonly root: string; readonly hostFile: string; ensureRoot(): void }
interface Machine { platform: 'linux' | 'darwin'; boot: string; namespace: string }
interface Owner extends Machine { token: string; pid: number; prepared: string }
interface Artifact {
  dev: string; ino: string; size: string; mtime: string; mode: string; uid: string; hash: string
}
interface FileState { source: string; artifact: Artifact; version: string }
interface Blob { name: string; artifact: Artifact }
interface Entry { original: Artifact | null; old: Blob | null; next: Blob | null }
interface Manifest {
  schema: 1; txId: string; hostName: string; root: { dev: string; ino: string }; owner: Owner
  files: Record<ConfigSourceName, Entry>
}
interface Active { schema: 1; txId: string; manifestHash: string }
interface Action {
  schema: 1; sequence: number; key: ConfigSourceName; from: Artifact | null; to: Blob | null; displaced: string
}
interface Resolution { schema: 1; txId: string; direction: 'undo' | 'redo'; head: string }
interface Claim { schema: 1; owner: Owner; predecessor: string; lockToken: string; txId?: string }
interface Transaction { directory: string; manifest: Manifest; hash: string }
const keys = ['host', 'personas', 'bindings'] as const
const maximum = 2 * 1024 * 1024
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const hashPattern = /^[a-f0-9]{64}$/u
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const fail = (code: 'conflict' | 'unavailable' = 'conflict'): never => { throw new AgentConsoleError(code) }
const absent = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
const exists = (name: string) => fs.lstatSync(name, { throwIfNoEntry: false }) !== undefined
const stat = (name: string) => fs.lstatSync(name, { bigint: true })
const identity = (left: BigIntStats, right: BigIntStats) => left.dev === right.dev && left.ino === right.ino
const record = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(); return value as Record<string, unknown> }
const exact = (value: Record<string, unknown>, fields: readonly string[]) => { if (Object.keys(value).some(key => !fields.includes(key))) fail() }
const names = (root: TransactionRoot): Record<ConfigSourceName, string> => ({ host: root.hostFile, personas: path.join(root.root, 'persona-library.yaml'), bindings: path.join(root.root, 'agent-bindings.yaml') })
const activeName = (root: TransactionRoot) => path.join(root.root, '.agent-config.active')
const lockName = (root: TransactionRoot) => path.join(root.root, '.agent-config.write.lock')
const maintenanceName = (root: TransactionRoot) => path.join(root.root, '.agent-config.maintenance')
const headName = (root: TransactionRoot) => path.join(root.root, '.agent-config.head')
const journalName = (root: TransactionRoot) => path.join(root.root, '.agent-config.transactions')
const claimName = (root: TransactionRoot) => path.join(root.root, '.agent-config.claims')
function privateDirectory(name: string, create = false) {
  if (create && !exists(name)) { fs.mkdirSync(name, { mode: 0o700 }); syncDirectory(path.dirname(name)) }
  const value = stat(name)
  if (!value.isDirectory() || value.isSymbolicLink() || value.uid !== BigInt(process.getuid!()) || (value.mode & 0o077n) !== 0n) fail('unavailable')
  return value
}
function syncDirectory(name: string) {
  const fd = fs.openSync(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    if (!identity(fs.fstatSync(fd, { bigint: true }), stat(name))) fail()
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
}
function artifact(value: BigIntStats, hash: string): Artifact {
  return { dev: String(value.dev), ino: String(value.ino), size: String(value.size), mtime: String(value.mtimeNs), mode: String(value.mode), uid: String(value.uid), hash }
}
function same(left: Artifact, right: Artifact) { return JSON.stringify(left) === JSON.stringify(right) }
function readState(name: string, optional = false, links = 1n, limit = maximum): FileState | null {
  let fd: number | undefined
  try {
    fd = fs.openSync(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = fs.fstatSync(fd, { bigint: true })
    if (!before.isFile() || before.uid !== BigInt(process.getuid!()) || before.nlink < 1n || before.nlink > links || before.size > BigInt(limit) || (before.mode & 0o022n) !== 0n || !identity(before, stat(name))) return fail('unavailable')
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd, { bigint: true }), source = bytes.toString('utf8')
    if (bytes.length !== Number(after.size) || !Buffer.from(source).equals(bytes) || !identity(before, after) ||
        before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
        before.mode !== after.mode || before.uid !== after.uid || !identity(after, stat(name))) return fail()
    return { source, artifact: artifact(after, digest(bytes)), version: digest([after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs].join(':') + '\0' + source) }
  } catch (error) { if (optional && absent(error)) return null; if (error instanceof AgentConsoleError) throw error; return fail('unavailable') }
  finally { if (fd !== undefined) fs.closeSync(fd) }
}
function readJson(name: string, optional = false): { value: unknown; state: FileState } | null {
  const state = readState(name, optional, 2n, 256 * 1024)
  if (!state) return null
  try { return { value: JSON.parse(state.source), state } } catch { return fail() }
}
function writeFile(name: string, source: string): Blob {
  const fd = fs.openSync(name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  let value: BigIntStats
  try { fs.writeFileSync(fd, source); fs.fsyncSync(fd); value = fs.fstatSync(fd, { bigint: true }) }
  finally { fs.closeSync(fd) }
  const state = readState(name)!
  if (!identity(value!, stat(name)) || state.source !== source) return fail()
  return { name: path.basename(name), artifact: state.artifact }
}
/** Complete bytes are durable before a no-replace publication; interrupted hardlinks are identifiable. */
function publish(name: string, value: unknown, preparedName = '.record-' + randomUUID(), cleanConflict = false, beforePublication?: (blob: Blob) => void): Blob {
  const directory = path.dirname(name), prepared = path.join(directory, preparedName)
  const blob = writeFile(prepared, JSON.stringify(value))
  syncDirectory(directory)
  beforePublication?.(blob)
  try { fs.linkSync(prepared, name) }
  catch (error) {
    if (cleanConflict && error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
      const own = readState(prepared, true, 1n)
      // Even equal bytes do not confer ownership of a replacement inode.
      if (own && same(own.artifact, blob.artifact)) { fs.unlinkSync(prepared); syncDirectory(directory) }
    }
    throw error
  }
  const published = readState(name, false, 2n)!
  if (!same(blob.artifact, published.artifact)) return fail()
  fs.unlinkSync(prepared)
  syncDirectory(directory)
  return { name: path.basename(name), artifact: published.artifact }
}
function machine(): Machine {
  if (process.platform === 'linux') {
    const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim().toLowerCase(), namespace = fs.statSync('/proc/self/ns/pid', { bigint: true })
    if (!uuid.test(boot)) return fail('unavailable')
    return { platform: 'linux', boot, namespace: namespace.dev + ':' + namespace.ino }
  }
  if (process.platform === 'darwin') {
    const result = spawnSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 })
    const boot = result.stdout?.trim().toLowerCase()
    if (result.status !== 0 || !uuid.test(boot)) return fail('unavailable')
    return { platform: 'darwin', boot, namespace: 'darwin-host' }
  }
  return fail('unavailable')
}
function owner(): Owner { const token = randomUUID(); return { ...machine(), token, pid: process.pid, prepared: '.owner-' + token } }
function parseOwner(value: unknown): Owner {
  const data = record(value); exact(data, ['platform', 'boot', 'namespace', 'token', 'pid', 'prepared'])
  if ((data.platform !== 'linux' && data.platform !== 'darwin') || typeof data.boot !== 'string' || !uuid.test(data.boot) || typeof data.namespace !== 'string' || !/^(?:darwin-host|[0-9]+:[0-9]+)$/u.test(data.namespace) ||
      typeof data.token !== 'string' || !uuid.test(data.token) || !Number.isSafeInteger(data.pid) || Number(data.pid) <= 0 || data.prepared !== '.owner-' + data.token) return fail()
  return data as unknown as Owner
}
function stopped(value: Owner) {
  const current = machine()
  if (value.platform !== current.platform || value.boot !== current.boot || value.namespace !== current.namespace) return fail()
  try { process.kill(value.pid, 0) } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') return
    return fail()
  }
  return fail()
}
function parseArtifact(value: unknown): Artifact {
  const data = record(value); exact(data, ['dev', 'ino', 'size', 'mtime', 'mode', 'uid', 'hash'])
  for (const key of ['dev', 'ino', 'size', 'mtime', 'mode', 'uid']) if (typeof data[key] !== 'string' || !/^[0-9]+$/u.test(data[key])) fail()
  if (typeof data.hash !== 'string' || !hashPattern.test(data.hash)) return fail()
  return data as unknown as Artifact
}
function parseBlob(value: unknown): Blob | null {
  if (value === null) return null
  const data = record(value); exact(data, ['name', 'artifact'])
  if (typeof data.name !== 'string' || !/^(?:old|next|prepared)-[A-Za-z0-9.-]+$/u.test(data.name)) return fail()
  return { name: data.name, artifact: parseArtifact(data.artifact) }
}
function readHead(root: TransactionRoot): string {
  const directory = headName(root)
  if (!exists(directory)) return 'absent'
  privateDirectory(directory)
  const entries = fs.readdirSync(directory).sort()
  if (entries.length > 4096) return fail('unavailable')
  const values = entries.filter(name => !name.startsWith('.record-')).map(name => {
    if (!/^[a-f0-9-]{36}\.json$/u.test(name) || !uuid.test(name.slice(0, -5))) return fail()
    const data = readJson(path.join(directory, name))!, value = record(data.value)
    exact(value, ['schema', 'txId', 'direction', 'token'])
    if (value.schema !== 1 || typeof value.txId !== 'string' || !uuid.test(value.txId) || !['undo', 'redo'].includes(String(value.direction)) || value.token !== name.slice(0, -5)) return fail()
    return [name, data.state.artifact]
  })
  return digest(JSON.stringify(values))
}
function readFenceValue(root: TransactionRoot): string {
  if (exists(activeName(root)) || exists(maintenanceName(root))) return fail()
  const head = readHead(root)
  if (exists(activeName(root)) || exists(maintenanceName(root))) return fail()
  return head
}
/** Public read fence. A terminal append prevents an active-present/absent ABA. */
export function readConfigTransactionFence(root: TransactionRoot): string {
  root.ensureRoot()
  const head = readFenceValue(root)
  root.ensureRoot()
  return head
}
/** One synchronous root/fence envelope owns the complete group observation. */
export function readConfigTransactionGroup<T>(root: TransactionRoot, read: (fence: string) => T): T {
  root.ensureRoot()
  const fence = readFenceValue(root), result = read(fence)
  if (result && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') return fail()
  if (readFenceValue(root) !== fence) return fail()
  root.ensureRoot()
  return result
}
export interface ConfigTransactionLease {
  readonly owner: Owner
  ensureCurrent(): void
  protect(): void
  complete(): void
  release(): void
}
export function tryConfigTransactionLease(root: TransactionRoot, recovering = false, suppliedOwner?: Owner): ConfigTransactionLease | undefined {
  root.ensureRoot()
  if (!recovering) readConfigTransactionFence(root)
  const name = lockName(root), owned = suppliedOwner ?? owner(), prepared = path.join(root.root, owned.prepared)
  const claims = claimName(root)
  let createdClaims: BigIntStats | undefined
  const releaseClaims = () => {
    if (!createdClaims) return
    try {
      root.ensureRoot()
      const current = privateDirectory(claims)
      if (!identity(current, createdClaims) || current.mode !== createdClaims.mode || current.uid !== createdClaims.uid || fs.readdirSync(claims).length) return
      // The empty observation is not authority over a directory replaced while it ran.
      const checked = privateDirectory(claims)
      if (!identity(checked, createdClaims) || checked.mode !== createdClaims.mode || checked.uid !== createdClaims.uid) return
      fs.rmdirSync(claims); syncDirectory(root.root)
    } catch { /* Replacements, nonempty directories and uncertain cleanup are retained. */ }
  }
  try {
    fs.mkdirSync(claims, { mode: 0o700 })
    createdClaims = privateDirectory(claims)
    syncDirectory(root.root)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') privateDirectory(claims)
    else { releaseClaims(); throw error }
  }
  const claimsStat = privateDirectory(claims), anchorName = path.join(claims, 'owner-' + owned.token + '.json'), rootStat = stat(root.root)
  let blob: Blob, anchor: Blob | undefined
  const releaseAnchor = () => {
    if (!identity(privateDirectory(claims), claimsStat)) return fail()
    const state = readState(anchorName, true)
    if (anchor && state && same(anchor.artifact, state.artifact)) { fs.unlinkSync(anchorName); syncDirectory(claimName(root)) }
  }
  try { blob = publish(name, owned, owned.prepared, true, preparedBlob => {
    anchor = publish(anchorName, { schema: 1, owner: owned, artifact: preparedBlob.artifact,
      root: { dev: String(rootStat.dev), ino: String(rootStat.ino) }, hostName: path.basename(root.hostFile) })
  }) }
  catch (error) {
    // A failed no-replace link never owns the existing lock.
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
      try { releaseAnchor(); releaseClaims() } catch { /* Only exact artifacts made by this attempt are removable. */ }
      return undefined
    }
    throw error
  }
  let released = false, protectedState = false
  const ensureCurrent = () => {
    if (released) return fail()
    root.ensureRoot()
    if (!identity(privateDirectory(claims), claimsStat)) return fail()
    const state = readState(name, false, 1n)!
    if (!same(blob.artifact, state.artifact) || state.source !== JSON.stringify(owned)) return fail()
    const anchored = readState(anchorName, false, 1n)!
    if (!anchor || !same(anchor.artifact, anchored.artifact)) return fail()
  }
  const release = () => {
    if (released) return
    if (!protectedState) {
      try { ensureCurrent(); fs.unlinkSync(name); syncDirectory(root.root); releaseAnchor(); releaseClaims() } catch { /* A replacement or uncertain lock is retained. */ }
    }
    released = true
  }
  const result = { owner: owned, ensureCurrent, protect() { protectedState = true }, complete() { protectedState = false }, release }
  if (!recovering) {
    try { readConfigTransactionFence(root); ensureCurrent() } catch (error) { release(); throw error }
  }
  return result
}
function loadTransaction(root: TransactionRoot, txId: string): Transaction {
  if (!uuid.test(txId)) return fail()
  privateDirectory(journalName(root))
  const directory = path.join(journalName(root), txId); privateDirectory(directory)
  const data = readJson(path.join(directory, 'manifest.json'))!, raw = record(data.value)
  exact(raw, ['schema', 'txId', 'hostName', 'root', 'owner', 'files'])
  const rootStat = stat(root.root), rootIdentity = record(raw.root)
  exact(rootIdentity, ['dev', 'ino'])
  if (raw.schema !== 1 || raw.txId !== txId || raw.hostName !== path.basename(root.hostFile) || rootIdentity.dev !== String(rootStat.dev) || rootIdentity.ino !== String(rootStat.ino)) return fail()
  const files = record(raw.files); exact(files, keys)
  const entries = {} as Record<ConfigSourceName, Entry>
  for (const key of keys) {
    const entry = record(files[key]); exact(entry, ['original', 'old', 'next'])
    entries[key] = { original: entry.original === null ? null : parseArtifact(entry.original), old: parseBlob(entry.old), next: parseBlob(entry.next) }
    if ((entries[key].original === null) !== (entries[key].old === null) || key !== 'personas' && (!entries[key].old || !entries[key].next)) return fail()
  }
  return { directory, hash: digest(data.state.source), manifest: { schema: 1, txId, hostName: String(raw.hostName), root: { dev: String(rootIdentity.dev), ino: String(rootIdentity.ino) }, owner: parseOwner(raw.owner), files: entries } }
}
function active(root: TransactionRoot): { value: Active; state: FileState } | null {
  const data = readJson(activeName(root), true)
  if (!data) return null
  const raw = record(data.value); exact(raw, ['schema', 'txId', 'manifestHash'])
  if (raw.schema !== 1 || typeof raw.txId !== 'string' || !uuid.test(raw.txId) || typeof raw.manifestHash !== 'string' || !hashPattern.test(raw.manifestHash)) return fail()
  return { value: raw as unknown as Active, state: data.state }
}
function decision(tx: Transaction): 'undo' | 'redo' {
  const commit = readJson(path.join(tx.directory, 'commit.json'), true)
  if (!commit) return 'undo'
  const data = record(commit.value); exact(data, ['schema', 'txId', 'manifestHash'])
  if (data.schema !== 1 || data.txId !== tx.manifest.txId || data.manifestHash !== tx.hash) return fail()
  return 'redo'
}
function actions(tx: Transaction): { action: Action; done: boolean; hash: string }[] {
  const entries = fs.readdirSync(tx.directory).filter(name => /^action-[0-9]{6}\.json$/u.test(name)).sort()
  if (entries.length > 512) return fail()
  let pending = false
  return entries.map((name, index) => {
    if (name !== 'action-' + String(index + 1).padStart(6, '0') + '.json') return fail()
    const loaded = readJson(path.join(tx.directory, name))!, raw = record(loaded.value)
    exact(raw, ['schema', 'sequence', 'key', 'from', 'to', 'displaced'])
    if (pending || raw.schema !== 1 || raw.sequence !== index + 1 || !keys.includes(raw.key as ConfigSourceName) || raw.displaced !== 'displaced-' + String(index + 1).padStart(6, '0')) return fail()
    const action: Action = { schema: 1, sequence: index + 1, key: raw.key as ConfigSourceName, from: raw.from === null ? null : parseArtifact(raw.from), to: parseBlob(raw.to), displaced: String(raw.displaced) }
    const hash = digest(loaded.state.source), done = readJson(path.join(tx.directory, name.replace('.json', '.done.json')), true)
    if (done) {
      const value = record(done.value); exact(value, ['schema', 'hash'])
      if (value.schema !== 1 || value.hash !== hash) return fail()
    } else pending = true
    return { action, done: !!done, hash }
  })
}
function requireArtifact(name: string, expected: Artifact, optional = false, links = 2n) {
  const state = readState(name, optional, links)
  if (state && !same(state.artifact, expected)) return fail()
  return state
}
function preflight(root: TransactionRoot, tx: Transaction) {
  root.ensureRoot(); privateDirectory(tx.directory)
  const rows = actions(tx), fileNames = names(root)
  for (const key of keys) {
    for (const blob of [tx.manifest.files[key].old, tx.manifest.files[key].next]) if (blob) requireArtifact(path.join(tx.directory, blob.name), blob.artifact, false, 1n)
    const current = readState(fileNames[key], true, 2n)
    const latest = rows.filter(row => row.action.key === key).at(-1)
    if (!latest || latest.done) {
      const expected = latest ? latest.action.to?.artifact ?? null : tx.manifest.files[key].original
      if (expected ? !current || !same(current.artifact, expected) : current !== null) return fail()
    } else {
      const action = latest.action, displaced = readState(path.join(tx.directory, action.displaced), true, 1n)
      const beforeMove = action.from && !displaced
      if (beforeMove ? !current || !same(current.artifact, action.from!) : current !== null && (!action.to || !same(current.artifact, action.to.artifact))) return fail()
      if (action.to && (!current || !same(current.artifact, action.to.artifact))) requireArtifact(path.join(tx.directory, action.to.name), action.to.artifact)
    }
    if (current && stat(fileNames[key]).nlink === 2n) {
      const installing = rows.find(row => row.action.key === key && row.action.to && same(row.action.to.artifact, current.artifact))
      if (!installing?.action.to || !requireArtifact(path.join(tx.directory, installing.action.to.name), current.artifact, true)) return fail()
    }
  }
  for (const { action, done } of rows) {
    const displaced = readState(path.join(tx.directory, action.displaced), true, 1n)
    if (displaced && (!action.from || !same(displaced.artifact, action.from))) return fail()
    if (done && action.from && !displaced) return fail()
    if (action.to) requireArtifact(path.join(tx.directory, action.to.name), action.to.artifact, true)
  }
  return rows
}
function executeAction(root: TransactionRoot, tx: Transaction, action: Action, ensure: () => void) {
  const target = names(root)[action.key], displacedName = path.join(tx.directory, action.displaced)
  ensure()
  let current = readState(target, true, 2n), displaced = readState(displacedName, true, 2n)
  if (displaced && (!action.from || !same(displaced.artifact, action.from))) return fail()
  const installed = action.to ? !!current && same(current.artifact, action.to.artifact) : current === null && (!action.from || displaced !== null)
  if (!installed) {
    if (current) {
      if (!action.from || !same(current.artifact, action.from) || displaced) return fail()
      ensure()
      fs.renameSync(target, displacedName)
      syncDirectory(root.root); syncDirectory(tx.directory)
      displaced = requireArtifact(displacedName, action.from)!
      current = readState(target, true, 2n)
      if (current) return fail()
    } else if (action.from && !displaced) return fail()
    if (action.to) {
      const preparedName = path.join(tx.directory, action.to.name)
      requireArtifact(preparedName, action.to.artifact)
      ensure()
      fs.linkSync(preparedName, target)
      syncDirectory(root.root)
      requireArtifact(target, action.to.artifact)
    }
  }
  if (action.to) {
    const preparedName = path.join(tx.directory, action.to.name), prepared = requireArtifact(preparedName, action.to.artifact, true)
    if (prepared) { ensure(); fs.unlinkSync(preparedName); syncDirectory(tx.directory) }
    requireArtifact(target, action.to.artifact, false, 1n)
  } else if (exists(target)) return fail()
  if (action.from && !displaced) return fail()
  ensure()
  publish(path.join(tx.directory, 'action-' + String(action.sequence).padStart(6, '0') + '.done.json'), { schema: 1, hash: digest(JSON.stringify(action)) })
}
function addAction(root: TransactionRoot, tx: Transaction, key: ConfigSourceName, source: string | undefined, ensure: () => void) {
  const rows = actions(tx), current = readState(names(root)[key], true, 1n)
  const previous = rows.filter(row => row.action.key === key).at(-1)
  if (previous && !previous.done) return fail()
  const expected = previous ? previous.action.to?.artifact ?? null : tx.manifest.files[key].original
  // Bind the observed object itself to the registered trajectory. A later raw
  // read is never authority to adopt an external replacement or deletion.
  if (expected ? !current || !same(current.artifact, expected) : current !== null) return fail()
  if ((current?.source ?? undefined) === source) return
  const sequence = rows.length + 1, suffix = String(sequence).padStart(6, '0')
  // A crash before the action record is published leaves an unowned preparation.
  // Never infer its ownership from equal bytes or reuse its sequence-based path.
  const to = source === undefined ? null : writeFile(path.join(tx.directory, 'prepared-' + suffix + '-' + randomUUID()), source)
  const action: Action = { schema: 1, sequence, key, from: current?.artifact ?? null, to, displaced: 'displaced-' + suffix }
  syncDirectory(tx.directory)
  ensure()
  publish(path.join(tx.directory, 'action-' + suffix + '.json'), action)
  executeAction(root, tx, action, ensure)
}
function sourcesFor(tx: Transaction, direction: 'undo' | 'redo'): ConfigSources {
  const result = {} as Record<ConfigSourceName, string | undefined>
  for (const key of keys) {
    const blob = tx.manifest.files[key][direction === 'undo' ? 'old' : 'next']
    result[key] = blob ? requireArtifact(path.join(tx.directory, blob.name), blob.artifact, false, 1n)!.source : undefined
  }
  return result as ConfigSources
}
function finalCheck(root: TransactionRoot, tx: Transaction, sources: ConfigSources) {
  preflight(root, tx)
  for (const key of keys) if ((readState(names(root)[key], true, 1n)?.source ?? undefined) !== sources[key]) return fail()
}
function settle(root: TransactionRoot, tx: Transaction, direction: 'undo' | 'redo', ensure: () => void) {
  const existing = readJson(path.join(tx.directory, 'resolution.json'), true)
  let resolution: Resolution
  if (existing) {
    const data = record(existing.value); exact(data, ['schema', 'txId', 'direction', 'head'])
    if (data.schema !== 1 || data.txId !== tx.manifest.txId || data.direction !== direction || typeof data.head !== 'string' || !uuid.test(data.head)) return fail()
    resolution = data as unknown as Resolution
  } else {
    resolution = { schema: 1, txId: tx.manifest.txId, direction, head: randomUUID() }
    ensure(); publish(path.join(tx.directory, 'resolution.json'), resolution)
  }
  privateDirectory(headName(root), true)
  const name = path.join(headName(root), resolution.head + '.json'), value = { schema: 1, txId: tx.manifest.txId, direction, token: resolution.head }
  ensure()
  if (exists(name)) { if (readState(name, false, 2n)!.source !== JSON.stringify(value)) return fail(); syncDirectory(headName(root)) }
  else publish(name, value)
  const gate = active(root)
  if (gate) {
    if (gate.value.txId !== tx.manifest.txId || gate.value.manifestHash !== tx.hash) return fail()
    ensure(); fs.unlinkSync(activeName(root)); syncDirectory(root.root)
  } else syncDirectory(root.root)
}
export function commitConfigTransaction(root: TransactionRoot, lease: ConfigTransactionLease, next: ConfigSources, expected: SourceSnapshot,
  readSnapshot: () => SourceSnapshot, hooks: ConfigTransactionHooks): { readonly txId: string; readonly snapshot: SourceSnapshot } {
  lease.ensureCurrent(); hooks.ensureActorCurrent()
  if (readSnapshot().revision !== expected.revision) return fail()
  for (const key of keys) if (next[key] !== undefined && (typeof next[key] !== 'string' || Buffer.byteLength(next[key]!) > maximum) || key !== 'personas' && next[key] === undefined) return fail()
  if (keys.every(key => next[key] === expected.sources[key])) return { txId: '', snapshot: expected }
  const txId = randomUUID(), directory = path.join(journalName(root), txId), fileNames = names(root), entries = {} as Record<ConfigSourceName, Entry>
  privateDirectory(journalName(root), true); fs.mkdirSync(directory, { mode: 0o700 }); syncDirectory(journalName(root))
  for (const key of keys) {
    const original = readState(fileNames[key], key === 'personas')
    if ((original?.source ?? undefined) !== expected.sources[key] || (original?.version ?? 'absent') !== expected.versions[key]) return fail()
    entries[key] = { original: original?.artifact ?? null,
      old: original ? writeFile(path.join(directory, 'old-' + key), original.source) : null,
      next: next[key] === undefined ? null : writeFile(path.join(directory, 'next-' + key), next[key]!) }
  }
  const rootStat = stat(root.root), manifest: Manifest = { schema: 1, txId, hostName: path.basename(root.hostFile), root: { dev: String(rootStat.dev), ino: String(rootStat.ino) }, owner: lease.owner, files: entries }
  publish(path.join(directory, 'manifest.json'), manifest)
  const tx: Transaction = { directory, manifest, hash: digest(JSON.stringify(manifest)) }
  lease.ensureCurrent(); hooks.ensureActorCurrent()
  if (readSnapshot().revision !== expected.revision) return fail()
  // From publication onward, release never removes the lock until a durable terminal fence exists.
  const ensure = () => { lease.ensureCurrent(); hooks.ensureActorCurrent(); root.ensureRoot() }
  ensure()
  const marker = { schema: 1, txId, manifestHash: tx.hash }
  const prepared = '.active-' + txId
  const blob = writeFile(path.join(root.root, prepared), JSON.stringify(marker)); syncDirectory(root.root)
  lease.protect()
  fs.linkSync(path.join(root.root, prepared), activeName(root))
  hooks.onFenced(txId)
  if (!same(readState(activeName(root), false, 2n)!.artifact, blob.artifact)) return fail()
  fs.unlinkSync(path.join(root.root, prepared)); syncDirectory(root.root)
  ensure(); preflight(root, tx)
  // Retirement listeners may synchronously edit even an otherwise identical file.
  // Before the first materialization, retain the complete original version CAS.
  for (const key of keys) if ((readState(fileNames[key], key === 'personas')?.version ?? 'absent') !== expected.versions[key]) return fail()
  if (readHead(root) !== expected.fence) return fail()
  for (const key of keys) { preflight(root, tx); addAction(root, tx, key, next[key], ensure) }
  ensure(); finalCheck(root, tx, next)
  const commitPrepared = path.join(directory, '.commit-' + txId)
  writeFile(commitPrepared, JSON.stringify(marker)); syncDirectory(directory)
  ensure(); fs.linkSync(commitPrepared, path.join(directory, 'commit.json'))
  hooks.onCommitPublished(txId)
  fs.unlinkSync(commitPrepared); syncDirectory(directory)
  ensure(); finalCheck(root, tx, next)
  settle(root, tx, 'redo', ensure)
  const snapshot = readSnapshot()
  if (keys.some(key => snapshot.sources[key] !== next[key])) return fail()
  lease.complete()
  return { txId, snapshot }
}
function locate(root: TransactionRoot): { tx?: Transaction; lock: { owner: Owner; state: FileState } | null; gate: ReturnType<typeof active> } {
  root.ensureRoot()
  const gate = active(root), loaded = readJson(lockName(root), true), lock = loaded ? { owner: parseOwner(loaded.value), state: loaded.state } : null
  if (lock) {
    privateDirectory(claimName(root))
    const anchor = readJson(path.join(claimName(root), 'owner-' + lock.owner.token + '.json'))!, value = record(anchor.value)
    exact(value, ['schema', 'owner', 'artifact', 'root', 'hostName'])
    const rootStat = stat(root.root), expectedRoot = record(value.root); exact(expectedRoot, ['dev', 'ino'])
    if (value.schema !== 1 || JSON.stringify(parseOwner(value.owner)) !== JSON.stringify(lock.owner) || value.hostName !== path.basename(root.hostFile) ||
        expectedRoot.dev !== String(rootStat.dev) || expectedRoot.ino !== String(rootStat.ino) || !same(parseArtifact(value.artifact), lock.state.artifact)) return fail()
    if (stat(lockName(root)).nlink === 2n) requireArtifact(path.join(root.root, lock.owner.prepared), lock.state.artifact)
  }
  let tx: Transaction | undefined
  if (gate) {
    tx = loadTransaction(root, gate.value.txId)
    if (tx.hash !== gate.value.manifestHash) return fail()
  } else if (lock && exists(journalName(root))) {
    privateDirectory(journalName(root))
    const entries = fs.readdirSync(journalName(root))
    if (entries.length > 8192) return fail('unavailable')
    for (const name of entries) {
      if (!uuid.test(name) || !exists(path.join(journalName(root), name, 'manifest.json'))) continue
      const candidate = loadTransaction(root, name)
      if (candidate.manifest.owner.token === lock.owner.token) { if (tx) return fail(); tx = candidate }
    }
  }
  return { ...(tx ? { tx } : {}), lock, gate }
}
function parseClaim(value: unknown): Claim {
  const data = record(value); exact(data, ['schema', 'owner', 'predecessor', 'lockToken', 'txId'])
  if (data.schema !== 1 || typeof data.predecessor !== 'string' || !uuid.test(data.predecessor) || typeof data.lockToken !== 'string' || !uuid.test(data.lockToken) || data.txId !== undefined && (typeof data.txId !== 'string' || !uuid.test(data.txId))) return fail()
  return { schema: 1, owner: parseOwner(data.owner), predecessor: data.predecessor, lockToken: data.lockToken, ...(data.txId ? { txId: String(data.txId) } : {}) }
}
function currentClaim(root: TransactionRoot): { claim: Claim; rootState: FileState } | null {
  const first = readJson(maintenanceName(root), true)
  if (!first) return null
  let claim = parseClaim(first.value)
  const seen = new Set([claim.owner.token])
  if (exists(claimName(root))) privateDirectory(claimName(root))
  for (;;) {
    const successor = readJson(path.join(claimName(root), claim.owner.token + '.next'), true)
    if (!successor) return { claim, rootState: first.state }
    const next = parseClaim(successor.value)
    if (next.predecessor !== claim.owner.token || next.lockToken !== claim.lockToken || next.txId !== claim.txId || seen.has(next.owner.token) || seen.size >= 256) return fail()
    claim = next; seen.add(claim.owner.token)
  }
}
function verifyTakeovers(root: TransactionRoot) {
  if (!exists(claimName(root))) return
  privateDirectory(claimName(root))
  const entries = fs.readdirSync(claimName(root))
  if (entries.length > 32768) return fail('unavailable')
  for (const name of entries.filter(value => /^takeover-[a-f0-9-]{36}\.json$/u.test(value))) {
    const loaded = readJson(path.join(claimName(root), name))!, value = record(loaded.value)
    exact(value, ['schema', 'from', 'quarantine'])
    if (value.schema !== 1 || typeof value.quarantine !== 'string' || !/^lock-[a-f0-9-]{36}$/u.test(value.quarantine)) return fail()
    const expected = parseArtifact(value.from), displaced = requireArtifact(path.join(claimName(root), value.quarantine), expected, true)
    if (!displaced) requireArtifact(lockName(root), expected)
  }
}
export function inspectConfigTransaction(root: TransactionRoot): ConfigTransactionInspection {
  try {
    const located = locate(root), maintenance = currentClaim(root), tx = located.tx ?? (maintenance?.claim.txId ? loadTransaction(root, maintenance.claim.txId) : undefined)
    verifyTakeovers(root)
    if (!located.lock && !located.gate && !maintenance) { readConfigTransactionFence(root); return { phase: 'clean' } }
    if (tx) preflight(root, tx)
    return { phase: 'recovery-required', ...(tx ? { txId: tx.manifest.txId, direction: decision(tx) } : {}) }
  } catch { return { phase: 'blocked', reason: 'invalid-state' } }
}
function cleanOwnerAlias(root: TransactionRoot, value: Owner, state: FileState) {
  const alias = path.join(root.root, value.prepared), current = readState(alias, true, 2n)
  if (current) { if (!same(current.artifact, state.artifact) || current.source !== JSON.stringify(value)) return fail(); fs.unlinkSync(alias); syncDirectory(root.root) }
}
export function recoverConfigTransaction(root: TransactionRoot, hooks: ConfigRecoveryHooks, readSnapshot: () => SourceSnapshot): {
  readonly phase: 'clean' | 'recovered'; readonly txId?: string; readonly direction?: 'undo' | 'redo'; readonly snapshot: SourceSnapshot
} {
  hooks.ensureOfflineCurrent(); root.ensureRoot()
  let located = locate(root), previous = currentClaim(root)
  verifyTakeovers(root)
  if (!located.lock && !located.gate && !previous) return { phase: 'clean', snapshot: readSnapshot() }
  const tx = located.tx ?? (previous?.claim.txId ? loadTransaction(root, previous.claim.txId) : undefined)
  if (located.gate && !tx) return fail()
  if (tx) { preflight(root, tx); decision(tx) }
  const predecessor = previous?.claim.owner ?? located.lock?.owner ?? tx?.manifest.owner
  if (!predecessor) return fail()
  stopped(predecessor); hooks.ensureOfflineCurrent()
  privateDirectory(claimName(root), true)
  const owned = owner(), claim: Claim = { schema: 1, owner: owned, predecessor: predecessor.token,
    lockToken: previous?.claim.lockToken ?? located.lock?.owner.token ?? tx!.manifest.owner.token, ...(tx ? { txId: tx.manifest.txId } : {}) }
  if (previous) publish(path.join(claimName(root), predecessor.token + '.next'), claim)
  else publish(maintenanceName(root), claim)
  previous = currentClaim(root)
  if (!previous) return fail()
  const maintenanceArtifact = previous.rootState.artifact
  const ensure = () => {
    hooks.ensureOfflineCurrent(); root.ensureRoot()
    const current = currentClaim(root)
    if (!current || !same(current.rootState.artifact, maintenanceArtifact) || current.claim.owner.token !== owned.token || current.claim.owner.pid !== process.pid) return fail()
  }
  ensure()
  located = locate(root)
  if (located.lock) {
    if (located.lock.owner.token !== claim.lockToken && located.lock.owner.token !== predecessor.token) return fail()
    stopped(located.lock.owner)
    const quarantine = path.join(claimName(root), 'lock-' + located.lock.owner.token)
    if (exists(quarantine)) return fail()
    // Even the lock handoff is registered before a rename. A successor can
    // retain and verify a moved lock after this recovery process itself dies.
    publish(path.join(claimName(root), 'takeover-' + owned.token + '.json'), { schema: 1, from: located.lock.state.artifact,
      quarantine: path.basename(quarantine) })
    ensure(); fs.renameSync(lockName(root), quarantine); syncDirectory(root.root); syncDirectory(claimName(root))
    requireArtifact(quarantine, located.lock.state.artifact)
    cleanOwnerAlias(root, located.lock.owner, located.lock.state)
  }
  let lease: ConfigTransactionLease | undefined
  try {
    ensure()
    lease = tryConfigTransactionLease(root, true, owned)
    if (!lease) return fail()
    lease.protect()
    const authority = () => { ensure(); lease!.ensureCurrent() }
    if (tx) {
      preflight(root, tx)
      for (const row of actions(tx)) if (!row.done) executeAction(root, tx, row.action, authority)
      const direction = decision(tx), desired = sourcesFor(tx, direction)
      for (const key of keys) { preflight(root, tx); addAction(root, tx, key, desired[key], authority) }
      authority(); finalCheck(root, tx, desired)
      settle(root, tx, direction, authority)
      authority()
      const maintenance = currentClaim(root)!
      fs.unlinkSync(maintenanceName(root)); syncDirectory(root.root)
      lease.complete(); lease.release(); lease = undefined
      return { phase: 'recovered', txId: tx.manifest.txId, direction, snapshot: readSnapshot() }
    }
    authority(); fs.unlinkSync(maintenanceName(root)); syncDirectory(root.root)
    lease.complete(); lease.release(); lease = undefined
    return { phase: 'recovered', snapshot: readSnapshot() }
  } finally { lease?.release() }
}
