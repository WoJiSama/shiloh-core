import { createHash, randomBytes } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rm, type FileHandle } from 'node:fs/promises'
import { isIP } from 'node:net'
import path from 'node:path'
import type { PlatformConnection, PlatformUserRef } from '../contracts/agentBinding.js'
import type { AgentMediaResourceContext } from '../contracts/agentMediaRelay.js'
import { openQqGroupLogBridge, type QqGroupLogBridge } from '../adapters/qqGroupLogBridge.js'
import { qqId } from '../adapters/qqIdentity.js'
import { MAX_AGENT_GROUP_LOG_BYTES } from '../modules/media/infrastructure/agentGroupLogArtifact.js'
import { readStandaloneMediaRelayConfig, type StandaloneMediaRelayBridgeConfig } from './standaloneMediaRelay.js'

export interface StandaloneGroupLogConfig {
  readonly enabled: boolean
  readonly maxBytes: number
  readonly masters: readonly PlatformUserRef[]
  readonly bridges: readonly StandaloneMediaRelayBridgeConfig[]
}
const failure = () => new Error('独立宿主团录配置、租约或私有资源目录不可用')
const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32)
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) throw failure()
  return value as Record<string, unknown>
}
function array(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) throw failure()
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw failure()
    return descriptor.value
  })
}
function privateAddress(value: string): boolean {
  if (isIP(value) === 4) {
    const [first, second] = value.split('.').map(Number)
    return first === 10 || first === 127 || first === 172 && second! >= 16 && second! <= 31 || first === 192 && second === 168
  }
  if (isIP(value) !== 6) return false
  const normalized = new URL(`http://[${value}]`).hostname.slice(1, -1)
  const mapped = /^::ffff:([a-f\d]{1,4}):([a-f\d]{1,4})$/u.exec(normalized)
  if (mapped) {
    const high = Number.parseInt(mapped[1]!, 16), low = Number.parseInt(mapped[2]!, 16)
    return privateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
  }
  return normalized === '::1' || /^f[cd][a-f\d]{2}:/u.test(normalized)
}

/** Host-owned declarations only; check/preview performs no filesystem, listener or model work. */
export function readStandaloneGroupLogConfig(input: unknown, connections: readonly PlatformConnection[]): Readonly<StandaloneGroupLogConfig> {
  try {
    const value: Record<string, unknown> = input === undefined ? { enabled: false } : object(input, ['enabled', 'maxBytes', 'masters', 'bridges'])
    if (typeof value.enabled !== 'boolean' || connections.some(connection => connection.account.platform !== 'qq')) throw failure()
    const maxBytes = value.maxBytes === undefined ? 8 * 1024 * 1024 : value.maxBytes
    if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 * 1024 || maxBytes > MAX_AGENT_GROUP_LOG_BYTES) throw failure()
    const seen = new Set<string>()
    const masters = (value.masters === undefined ? [] : array(value.masters, 64)).map(input => {
      const master = object(input, ['platform', 'namespace', 'id'])
      if (master.platform !== 'qq' || typeof master.namespace !== 'string' || typeof master.id !== 'string' || qqId(master.id) !== master.id ||
          !connections.some(connection => connection.account.platform === master.platform && connection.account.namespace === master.namespace)) throw failure()
      const key = JSON.stringify([master.platform, master.namespace, master.id])
      if (seen.has(key)) throw failure()
      seen.add(key)
      return Object.freeze({ platform: master.platform, namespace: master.namespace, id: master.id })
    })
    const neutral = readStandaloneMediaRelayConfig({ enabled: value.enabled, ...(value.bridges === undefined ? {} : { bridges: value.bridges }) }, connections, {})
    if (new Set(neutral.bridges.map(bridge => bridge.listen.port)).size !== neutral.bridges.length) throw failure()
    for (const bridge of neutral.bridges) {
      const host = new URL(bridge.advertisedOrigin).hostname.replace(/^\[|\]$/gu, '')
      if (!privateAddress(bridge.listen.host) || host !== 'localhost' && !privateAddress(host) || bridge.allowedPeers.some(peer => !privateAddress(peer))) throw failure()
    }
    return Object.freeze({ enabled: value.enabled, maxBytes, masters: Object.freeze(masters), bridges: neutral.bridges })
  } catch { throw failure() }
}

/** Each leased host owns exactly marked private runs and one independent QQ listener per connection. */
export async function openStandaloneGroupLog(options: {
  readonly config: StandaloneGroupLogConfig
  readonly dataDir: string
  readonly instance: string
  isLeaseCurrent(): boolean
}) {
  if (!options.config.enabled || typeof options.instance !== 'string' || !options.instance || options.instance.length > 128) throw failure()
  let root = '', run = '', rootStat: Stats | undefined, runStat: Stats | undefined, closing: Promise<void> | undefined
  const bridges = new Map<string, QqGroupLogBridge>(), tasks = new Set<Promise<unknown>>(), stopped = new AbortController()
  const current = () => { try { if (!options.isLeaseCurrent() || stopped.signal.aborted) throw failure() } catch { throw failure() } }
  const same = (left: Stats, right: Stats) => left.dev === right.dev && left.ino === right.ino && right.isDirectory() && !right.isSymbolicLink()
  const ownedRoot = async () => {
    if (!options.isLeaseCurrent() || !rootStat || !same(rootStat, await lstat(root)) || await realpath(root) !== root) throw failure()
  }
  const marker = (runId?: string) => JSON.stringify({ version: 1, instance: options.instance, ...(runId ? { run: runId } : {}) })
  const readMarker = async (directory: string, expected: string): Promise<boolean> => {
    let handle: FileHandle | undefined
    try {
      handle = await open(path.join(directory, '.owner.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
      const stat = await handle.stat()
      return stat.isFile() && stat.nlink === 1 && stat.size === Buffer.byteLength(expected) && await handle.readFile('utf8') === expected
    } catch { return false } finally { await handle?.close() }
  }
  const writeMarker = async (directory: string, value: string) => {
    const handle = await open(path.join(directory, '.owner.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { await handle.writeFile(value); await handle.sync() } finally { await handle.close() }
  }
  const scope = (context: AgentMediaResourceContext): AgentMediaResourceContext => ({
    signal: AbortSignal.any([context.signal, stopped.signal]),
    isCurrent: () => !stopped.signal.aborted && options.isLeaseCurrent() && context.isCurrent(),
    async ensureCurrent() { current(); await context.ensureCurrent?.(); current(); if (!context.isCurrent()) throw failure() },
  })
  const track = <T>(operation: Promise<T>): Promise<T> => {
    tasks.add(operation); void operation.then(() => tasks.delete(operation), () => tasks.delete(operation)); return operation
  }
  const close = (): Promise<void> => closing ??= (async () => {
    stopped.abort()
    const [, results] = await Promise.all([Promise.allSettled([...tasks]), Promise.allSettled([...bridges.values()].map(bridge => bridge.close()))])
    if (run && runStat) try {
      await ownedRoot()
      if (same(runStat, await lstat(run)) && await realpath(run) === run && await readMarker(run, marker(path.basename(run)))) await rm(run, { recursive: true, force: true })
    } catch { /* Lease loss leaves this exact marked run for the next authorized holder. */ }
    if (results.some(result => result.status === 'rejected')) throw failure()
  })()
  try {
    current()
    await mkdir(path.resolve(options.dataDir), { recursive: true, mode: 0o700 })
    root = path.join(await realpath(path.resolve(options.dataDir)), `.agent-group-log-${digest(options.instance)}`)
    let created = false
    try { await mkdir(root, { mode: 0o700 }); created = true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    rootStat = await lstat(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(root) !== root || rootStat.mode & 0o077) throw failure()
    if (created) await writeMarker(root, marker())
    if (!await readMarker(root, marker())) throw failure()
    await ownedRoot()
    for (const name of await readdir(root)) {
      if (!/^run-[a-f\d]{32}$/u.test(name)) continue
      const stale = path.join(root, name), stat = await lstat(stale)
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || await realpath(stale) !== stale || !await readMarker(stale, marker(name))) continue
      await ownedRoot()
      if (same(stat, await lstat(stale))) await rm(stale, { recursive: true, force: true })
    }
    await ownedRoot()
    run = path.join(root, `run-${randomBytes(16).toString('hex')}`); await mkdir(run, { mode: 0o700 }); runStat = await lstat(run)
    await writeMarker(run, marker(path.basename(run)))
    for (const config of options.config.bridges) {
      await ownedRoot()
      const directory = path.join(run, `bridge-${digest(config.connectionId)}`); await mkdir(directory, { mode: 0o700 })
      const bridge = await openQqGroupLogBridge({ directory, listen: config.listen, advertisedOrigin: config.advertisedOrigin, allowedPeers: config.allowedPeers,
        maxTotalBytes: Math.min(4 * options.config.maxBytes, 4 * MAX_AGENT_GROUP_LOG_BYTES) })
      bridges.set(config.connectionId, Object.freeze<QqGroupLogBridge>({ stage: async (log, context) => {
        current(); return track(bridge.stage(log, scope(context)))
      }, close: () => bridge.close() }))
    }
    current(); await ownedRoot()
    return Object.freeze({ bridgeFor: (connectionId: string) => stopped.signal.aborted ? undefined : bridges.get(connectionId), close })
  } catch { await close().catch(() => {}); throw failure() }
}
