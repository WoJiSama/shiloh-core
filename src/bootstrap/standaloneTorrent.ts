import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rm, type FileHandle } from 'node:fs/promises'
import type { PlatformConnection } from '../contracts/agentBinding.js'
import type { AgentTorrentConfig, AgentTorrentProvider } from '../contracts/agentTorrent.js'
import type { AgentMediaResourceContext } from '../contracts/agentMediaRelay.js'
import { openQqRequesterArchiveBridge, type QqRequesterArchiveBridge } from '../adapters/qqRequesterArchiveBridge.js'
import { createAgentTorrentProvider } from '../modules/media/infrastructure/agentTorrentProvider.js'
import { readStandaloneMediaRelayConfig, type StandaloneMediaRelayBridgeConfig } from './standaloneMediaRelay.js'

export interface StandaloneTorrentConfig extends AgentTorrentConfig {
  readonly autoDetect: boolean
  readonly selectionTtlSeconds: number
  readonly proxyUrl?: string
  readonly bridges: readonly StandaloneMediaRelayBridgeConfig[]
}
const failure = () => new Error('独立宿主磁链配置、租约或私有资源目录不可用')
const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32)
function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).some(key => typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'))) throw failure()
  return input as Record<string, unknown>
}
/** Pure declaration validation; no directories, listeners, DNS, credentials or native processes are opened by --check. */
export function readStandaloneTorrentConfig(input: unknown, connections: readonly PlatformConnection[]): Readonly<StandaloneTorrentConfig> {
  try {
    const value: Record<string, unknown> = input === undefined ? { enabled: false } : object(input, ['enabled', 'autoDetect', 'selectionTtlSeconds', 'proxyUrl', 'bridges'])
    if (typeof value.enabled !== 'boolean' || value.autoDetect !== undefined && typeof value.autoDetect !== 'boolean' ||
      connections.some(connection => connection.account.platform !== 'qq')) throw failure()
    const ttl = value.selectionTtlSeconds ?? 1800
    if (typeof ttl !== 'number' || !Number.isSafeInteger(ttl) || ttl < 60 || ttl > 1800) throw failure()
    let proxyUrl: string | undefined
    if (value.proxyUrl !== undefined) {
      if (typeof value.proxyUrl !== 'string' || !value.proxyUrl || value.proxyUrl.length > 4096 || /[\s\\\u0000-\u001f\u007f]/u.test(value.proxyUrl)) throw failure()
      const proxy = new URL(value.proxyUrl)
      if (!['http:', 'https:'].includes(proxy.protocol) || !proxy.hostname || proxy.pathname !== '/' || proxy.search || proxy.hash) throw failure()
      proxyUrl = proxy.href
    }
    const neutral = readStandaloneMediaRelayConfig({ enabled: value.enabled, ...(value.bridges === undefined ? {} : { bridges: value.bridges }) }, connections, {})
    return Object.freeze({ enabled: value.enabled, autoDetect: value.autoDetect !== false, selectionTtlSeconds: ttl,
      ...(proxyUrl ? { proxyUrl } : {}), bridges: neutral.bridges })
  } catch { throw failure() }
}

/** A current instance lease owns only its exactly marked private runs. Native P2P remains a trusted host capability. */
export async function openStandaloneTorrent(options: {
  readonly config: StandaloneTorrentConfig
  readonly dataDir: string
  readonly instance: string
  readonly secrets: readonly string[]
  isLeaseCurrent(): boolean
  allowsText(text: string): boolean
}) {
  if (!options.config.enabled || typeof options.instance !== 'string' || !options.instance || options.instance.length > 128) throw failure()
  let root = '', run = '', rootStat: Stats | undefined, runStat: Stats | undefined, closing: Promise<void> | undefined
  const bridges = new Map<string, QqRequesterArchiveBridge>(), tasks = new Set<Promise<unknown>>(), stopped = new AbortController()
  const current = () => { if (!options.isLeaseCurrent()) throw failure() }
  const same = (left: Stats, right: Stats) => left.dev === right.dev && left.ino === right.ino && right.isDirectory() && !right.isSymbolicLink()
  const ownedRoot = async () => {
    current()
    if (!rootStat || !same(rootStat, await lstat(root)) || await realpath(root) !== root) throw failure()
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
    async ensureCurrent() { current(); if (stopped.signal.aborted) throw failure(); await context.ensureCurrent?.(); current(); if (stopped.signal.aborted || !context.isCurrent()) throw failure() },
  })
  const track = <T>(operation: Promise<T>): Promise<T> => {
    tasks.add(operation); void operation.then(() => tasks.delete(operation), () => tasks.delete(operation)); return operation
  }
  const close = (): Promise<void> => closing ??= (async () => {
    stopped.abort()
    await Promise.allSettled([...tasks, ...[...bridges.values()].map(bridge => bridge.close())])
    if (run && runStat) try {
      await ownedRoot()
      if (same(runStat, await lstat(run)) && await realpath(run) === run && await readMarker(run, marker(path.basename(run)))) await rm(run, { recursive: true, force: true })
    } catch { /* Lease loss leaves the exact marked run for the next authorized owner. */ }
  })()
  try {
    current()
    await mkdir(path.resolve(options.dataDir), { recursive: true })
    root = path.join(await realpath(path.resolve(options.dataDir)), `.agent-torrent-${digest(options.instance)}`)
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
    const directory = path.join(run, 'provider'); await mkdir(directory, { mode: 0o700 })
    const implementation = createAgentTorrentProvider({ directory, ...(options.config.proxyUrl ? { proxyUrl: options.config.proxyUrl } : {}), secrets: options.secrets, allowsText: options.allowsText })
    const provider: AgentTorrentProvider = Object.freeze<AgentTorrentProvider>({ prepare: async (magnet, selection, context) => {
      current(); if (stopped.signal.aborted) return Promise.reject(failure())
      return track(implementation.prepare(magnet, selection, scope(context)))
    } })
    for (const config of options.config.bridges) {
      await ownedRoot()
      const directory = path.join(run, `bridge-${digest(config.connectionId)}`); await mkdir(directory, { mode: 0o700 })
      const bridge = await openQqRequesterArchiveBridge({ directory, listen: config.listen, advertisedOrigin: config.advertisedOrigin, allowedPeers: config.allowedPeers })
      bridges.set(config.connectionId, Object.freeze<QqRequesterArchiveBridge>({ stage: async (archive, context) => {
        current(); if (stopped.signal.aborted) return Promise.reject(failure())
        return track(bridge.stage(archive, scope(context)))
      }, close: () => bridge.close() }))
    }
    await ownedRoot()
    return Object.freeze({ provider, bridgeFor: (connectionId: string) => stopped.signal.aborted ? undefined : bridges.get(connectionId), close })
  } catch { await close(); throw failure() }
}
