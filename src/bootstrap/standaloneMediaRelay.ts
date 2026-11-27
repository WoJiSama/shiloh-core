import { createHash, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import path from 'node:path'
import { chmod, lstat, mkdir, open, readdir, realpath, rm, type FileHandle } from 'node:fs/promises'
import { constants, type Stats } from 'node:fs'
import type { AgentBindingSnapshot, PlatformConnection } from '../contracts/agentBinding.js'
import type { AgentBilibiliAuthService } from '../contracts/agentBilibiliAuth.js'
import type { AgentBilibiliQualityProvider } from '../contracts/agentBilibiliQuality.js'
import type { AgentDiagnostics } from '../modules/runtime/infrastructure/agentDiagnostics.js'
import { openQqMediaRelayBridge, type QqMediaRelayBridge } from '../adapters/qqMediaRelayBridge.js'
import { createAgentMediaArtifactStore } from '../modules/media/infrastructure/agentMediaArtifactStore.js'
import { createAgentBilibiliRelayProvider } from '../modules/media/infrastructure/agentBilibiliRelayProvider.js'
import { createAgentBilibiliQualityProvider, createAgentBilibiliSearchAttachmentProvider } from '../modules/media/infrastructure/agentBilibiliQualityProvider.js'
import { ownBilibiliQualityData } from '../modules/media/infrastructure/agentBilibiliQualityPolicy.js'
import { createAgentDouyinRelayProvider } from '../modules/media/infrastructure/agentDouyinRelayProvider.js'
import { createAgentXiaohongshuRelayProvider } from '../modules/media/infrastructure/agentXiaohongshuRelayProvider.js'
import { createAgentYoutubeRelayProvider } from '../modules/media/infrastructure/agentYoutubeRelayProvider.js'
import { createAgentPixivRelayProvider } from '../modules/media/infrastructure/agentPixivRelayProvider.js'
import { normalizePixivCookie } from '../modules/media/infrastructure/agentPixivRelayHttp.js'
import { validateYoutubeProxyUrl, youtubeCookieSecrets } from '../modules/media/infrastructure/agentYoutubeRelayHttp.js'
import { validateAgentMediaShare } from '../modules/media/infrastructure/agentMediaRelayReference.js'
import type { StandalonePixivToolsConfig } from './standalonePixiv.js'
import type { AgentMediaRelayPrepareContext, AgentMediaRelayProvider, AgentMediaShare } from '../contracts/agentMediaRelayWorkflow.js'

export interface StandaloneMediaRelayBridgeConfig {
  readonly connectionId: string
  readonly listen: { readonly host: string; readonly port: number }
  readonly advertisedOrigin: string
  readonly allowedPeers: readonly string[]
}
export interface StandaloneMediaRelayConfig {
  readonly enabled: boolean
  readonly bridges: readonly StandaloneMediaRelayBridgeConfig[]
  readonly bilibili: { readonly authCookie?: string; readonly autoAuthorizedRetry: boolean }
  readonly douyin?: { readonly enabled: boolean }
  readonly xiaohongshu?: { readonly enabled: boolean; readonly authCookie?: string }
  readonly youtube?: { readonly enabled: boolean; readonly authCookie?: string; readonly poToken?: string; readonly proxyUrl?: string }
  readonly pixiv?: { readonly enabled: boolean; readonly allowRestricted: boolean; readonly authCookie?: string; readonly proxyUrl?: string }
}
const failure = () => new Error('独立宿主媒体搬运配置或私有资源目录不可用')
const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32)
function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
      Reflect.ownKeys(input).some(key => typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'))) throw failure()
  return input as Record<string, unknown>
}
function array(input: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > maximum || Reflect.ownKeys(input).length !== input.length + 1) throw failure()
  const result: unknown[] = []
  for (let i = 0; i < input.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(i))
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw failure()
    result.push(descriptor.value)
  }
  return result
}
function ip(value: unknown): string {
  if (typeof value !== 'string' || value.includes('%') || !isIP(value)) throw failure()
  return isIP(value) === 6 ? new URL(`http://[${value}]`).hostname.slice(1, -1) : value
}
function origin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\?#@%]/u.test(value) || !/^https?:\/\//u.test(value)) throw failure()
  const url = new URL(value), authority = value.slice(value.indexOf('//') + 2).split('/')[0]!
  const literal = authority.startsWith('[') ? authority.slice(1, authority.indexOf(']')) : authority.split(':')[0]!
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      value.replace(/\/$/u, '') !== `${url.protocol}//${authority}`) throw failure()
  if (url.protocol === 'http:') {
    if (literal !== 'localhost') {
      const normalized = ip(literal)
      if (isIP(normalized) === 4) {
        const [first, second] = normalized.split('.').map(Number)
        if (!(first === 10 || first === 127 || first === 172 && second! >= 16 && second! <= 31 || first === 192 && second === 168)) throw failure()
      } else if (!(normalized === '::1' || /^f[cd][a-f\d]{2}:/u.test(normalized))) throw failure()
    }
  } else if (url.protocol !== 'https:') throw failure()
  return value.replace(/\/$/u, '')
}

/** Validate declarations without opening resources, resolving DNS or reading disabled credentials. */
export function readStandaloneMediaRelayConfig(input: unknown, connections: readonly PlatformConnection[], env: NodeJS.ProcessEnv,
  requireCredentials = true): Readonly<StandaloneMediaRelayConfig> {
  try {
    const value: Record<string, unknown> = input === undefined ? { enabled: false } : object(input, ['enabled', 'bilibili', 'douyin', 'xiaohongshu', 'youtube', 'pixiv', 'bridges'])
    if (typeof value.enabled !== 'boolean') throw failure()
    const douyin = value.douyin === undefined ? undefined : object(value.douyin, ['enabled'])
    if (douyin && typeof douyin.enabled !== 'boolean') throw failure()
    const px = value.pixiv === undefined ? undefined : object(value.pixiv, ['enabled', 'allowRestricted', 'cookieEnv', 'proxyEnv'])
    if (px && (typeof px.enabled !== 'boolean' || px.allowRestricted !== undefined && typeof px.allowRestricted !== 'boolean')) throw failure()
    const pxValues: { authCookie?: string; proxyUrl?: string } = {}
    for (const [field, resolved, label] of [['cookieEnv', 'authCookie', 'Cookie'], ['proxyEnv', 'proxyUrl', '代理']] as const) {
      const reference = px?.[field]
      if (reference === undefined) continue
      if (typeof reference !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(reference)) throw failure()
      if (!value.enabled || !px?.enabled) continue
      const secret = env[reference]?.trim() ?? ''
      if (!secret) { if (requireCredentials) throw new Error(`环境变量 ${reference} 缺少 Pixiv ${label}`); continue }
      if (resolved === 'authCookie') pxValues.authCookie = normalizePixivCookie(secret)
      else { validateYoutubeProxyUrl(secret); pxValues.proxyUrl = secret }
    }
    const yt = value.youtube === undefined ? undefined : object(value.youtube, ['enabled', 'cookieEnv', 'poTokenEnv', 'proxyEnv'])
    if (yt && typeof yt.enabled !== 'boolean') throw failure()
    const ytValues: { authCookie?: string; poToken?: string; proxyUrl?: string } = {}
    for (const [field, resolved, label] of [['cookieEnv', 'authCookie', 'Cookie'], ['poTokenEnv', 'poToken', 'PO Token'], ['proxyEnv', 'proxyUrl', '代理']] as const) {
      const reference = yt?.[field]
      if (reference === undefined) continue
      if (typeof reference !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(reference)) throw failure()
      if (!value.enabled || !yt?.enabled) continue
      const secret = env[reference]?.trim() ?? ''
      if (!secret) { if (requireCredentials) throw new Error(`环境变量 ${reference} 缺少 YouTube ${label}`); continue }
      if (resolved === 'authCookie') {
        youtubeCookieSecrets(secret)
      } else if (resolved === 'poToken') {
        if (secret.length > 8192 || !/^[A-Za-z0-9_+./=-]+$/u.test(secret)) throw failure()
      } else {
        if (secret.length > 2048 || /[\s\\?#\u0000-\u001f\u007f]/u.test(secret)) throw failure()
        const proxy = new URL(secret)
        if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(proxy.protocol) || !proxy.hostname || proxy.pathname && proxy.pathname !== '/' || proxy.search || proxy.hash) throw failure()
        for (const encoded of [proxy.username, proxy.password]) if (encoded && /[\u0000-\u0020\u007f]/u.test(decodeURIComponent(encoded))) throw failure()
      }
      ytValues[resolved] = secret
    }
    const xhs = value.xiaohongshu === undefined ? undefined : object(value.xiaohongshu, ['enabled', 'cookieEnv'])
    if (xhs && typeof xhs.enabled !== 'boolean') throw failure()
    const xhsReference = xhs?.cookieEnv
    if (xhsReference !== undefined && (typeof xhsReference !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(xhsReference))) throw failure()
    let xhsCookie = ''
    if (value.enabled && xhs?.enabled && xhsReference) {
      xhsCookie = env[xhsReference as string]?.trim() ?? ''
      if (!xhsCookie && requireCredentials) throw new Error(`环境变量 ${xhsReference} 缺少小红书 Cookie`)
      if (xhsCookie.length > 32768 || /[^\x20-\x7e]/u.test(xhsCookie)) throw failure()
      for (const part of xhsCookie.split(';').filter(part => part.trim())) {
        const at = part.indexOf('='), name = part.slice(0, at).trim(), content = part.slice(at + 1).trim()
        if (at < 1 || !/^[A-Za-z0-9_]{1,100}$/u.test(name) || !content || /\s/u.test(content)) throw failure()
      }
    }
    const bili = value.bilibili === undefined ? {} : object(value.bilibili, ['cookieEnv', 'autoAuthorizedRetry'])
    if (bili.autoAuthorizedRetry !== undefined && typeof bili.autoAuthorizedRetry !== 'boolean') throw failure()
    const reference = bili.cookieEnv
    if (reference !== undefined && (typeof reference !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(reference))) throw failure()
    let cookie = ''
    if (value.enabled && reference) {
      cookie = env[reference as string]?.trim() ?? ''
      if (!cookie && requireCredentials) throw new Error(`环境变量 ${reference} 缺少 B站 Cookie`)
      if (cookie.length > 32768 || /[^\x20-\x7e]/u.test(cookie)) throw failure()
      for (const part of cookie.split(';').filter(part => part.trim())) {
        const at = part.indexOf('='), name = part.slice(0, at).trim(), content = part.slice(at + 1).trim()
        if (at < 1 || !/^[A-Za-z0-9_]{1,100}$/u.test(name) || !content || /\s/u.test(content)) throw failure()
      }
    }
    const seen = new Set<string>(), listeners = new Set<string>()
    const bridges = (value.bridges === undefined ? [] : array(value.bridges, 32)).map(input => {
      const bridge = object(input, ['connectionId', 'listen', 'advertisedOrigin', 'allowedPeers'])
      if (typeof bridge.connectionId !== 'string' || !connections.some(connection => connection.id === bridge.connectionId) || seen.has(bridge.connectionId)) throw failure()
      seen.add(bridge.connectionId)
      const listen = object(bridge.listen, ['host', 'port']), host = ip(listen.host), port = listen.port
      if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw failure()
      const key = `${host}:${port}`
      if (listeners.has(key)) throw failure()
      listeners.add(key)
      const peers = array(bridge.allowedPeers, 32).map(ip)
      if (!peers.length || new Set(peers).size !== peers.length) throw failure()
      return Object.freeze({ connectionId: bridge.connectionId, listen: Object.freeze({ host, port }),
        advertisedOrigin: origin(bridge.advertisedOrigin), allowedPeers: Object.freeze(peers) })
    })
    if (value.enabled && !bridges.length) throw failure()
    return Object.freeze({ enabled: value.enabled, bridges: Object.freeze(bridges),
      ...(douyin ? { douyin: Object.freeze({ enabled: douyin.enabled as boolean }) } : {}),
      ...(xhs ? { xiaohongshu: Object.freeze({ enabled: xhs.enabled as boolean, ...(xhsCookie ? { authCookie: xhsCookie } : {}) }) } : {}),
      ...(yt ? { youtube: Object.freeze({ enabled: yt.enabled as boolean, ...ytValues }) } : {}),
      ...(px ? { pixiv: Object.freeze({ enabled: px.enabled as boolean, allowRestricted: px.allowRestricted === true, ...pxValues }) } : {}),
      bilibili: Object.freeze({ autoAuthorizedRetry: bili.autoAuthorizedRetry === true, ...(cookie ? { authCookie: cookie } : {}) }) })
  } catch (error) {
    if (error instanceof Error && /^环境变量 [A-Z_][A-Z0-9_]{0,127} 缺少(?:(?: B站|小红书) Cookie| YouTube (?:Cookie|PO Token|代理)| Pixiv (?:Cookie|代理))$/u.test(error.message)) throw error
    throw failure()
  }
}
export function standaloneMediaRelaySecrets(config: StandaloneMediaRelayConfig): readonly string[] {
  const secrets = [config.bilibili.authCookie, config.xiaohongshu?.authCookie, config.pixiv?.authCookie].flatMap(cookie => cookie ? [cookie, ...cookie.split(';').flatMap(part => {
    const at = part.indexOf('='), content = part.slice(at + 1).trim()
    return at > 0 && content ? [content] : []
  })] : [])
  if (config.youtube?.authCookie) secrets.push(...youtubeCookieSecrets(config.youtube.authCookie))
  if (config.youtube?.poToken) secrets.push(config.youtube.poToken)
  for (const value of [config.youtube?.proxyUrl, config.pixiv?.proxyUrl]) if (value) {
    secrets.push(value)
    const proxy = new URL(value)
    for (const value of [proxy.username, proxy.password]) if (value) secrets.push(value, decodeURIComponent(value))
  }
  return [...new Set(secrets)]
}

/** A lease holder owns only marked runs under its exact instance-specific private directory. */
export async function openStandaloneMediaRelay(options: {
  readonly config: StandaloneMediaRelayConfig
  readonly pixivTools?: StandalonePixivToolsConfig
  readonly videoSearchAttachments?: boolean
  readonly bilibiliQuality?: { readonly enabled: boolean; readonly authService: AgentBilibiliAuthService }
  readonly dataDir: string
  readonly instance: string
  readonly secrets: readonly string[]
  readonly diagnostics?: Pick<AgentDiagnostics, 'emit'>
  isLeaseCurrent(): boolean
  allowsText(text: string): boolean
}) {
  if (!options.config.enabled && !options.pixivTools?.enabled && !options.bilibiliQuality?.enabled && !options.videoSearchAttachments) throw failure()
  let root = ''
  let rootStat: Stats | undefined, run = '', runStat: Stats | undefined
  let artifacts: Awaited<ReturnType<typeof createAgentMediaArtifactStore>> | undefined
  const bridges = new Map<string, QqMediaRelayBridge>()
  let closing: Promise<void> | undefined
  const diagnoseCleanup = (code: string) => {
    const event = { stage: 'host' as const, operation: 'media_relay_cleanup', outcome: 'failed' as const, code }
    try { if (options.diagnostics) { options.diagnostics.emit(event); return } } catch { /* Observer failure does not change resource ownership. */ }
    try { console.error(`[Agent] host/media_relay_cleanup failed ${code}`) } catch { /* No remaining writable observer. */ }
  }
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
  const close = (): Promise<void> => closing ??= (async () => {
    const closed = await Promise.allSettled([...bridges.values()].map(bridge => bridge.close()))
    for (const result of closed) if (result.status === 'rejected') diagnoseCleanup('bridge_close_failed')
    await artifacts?.close().catch(() => diagnoseCleanup('artifact_close_failed'))
    if (run && runStat) {
      try {
        await ownedRoot()
        if (same(runStat, await lstat(run)) && await realpath(run) === run && await readMarker(run, marker(path.basename(run)))) await rm(run, { recursive: true, force: true })
      } catch { diagnoseCleanup('owned_run_cleanup_unavailable') }
    }
  })()
  try {
    current()
    await mkdir(path.resolve(options.dataDir), { recursive: true })
    root = path.join(await realpath(path.resolve(options.dataDir)), `.agent-media-relay-${digest(options.instance)}`)
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
    run = path.join(root, `run-${randomBytes(16).toString('hex')}`)
    await mkdir(run, { mode: 0o700 }); runStat = await lstat(run)
    await writeMarker(run, marker(path.basename(run)))
    const providerDirectory = path.join(run, 'provider'); await mkdir(providerDirectory, { mode: 0o700 })
    artifacts = await createAgentMediaArtifactStore({ directory: run })
    const bilibili = options.config.enabled ? createAgentBilibiliRelayProvider({ directory: providerDirectory, artifacts,
      ...(options.config.bilibili.authCookie ? { authCookie: options.config.bilibili.authCookie } : {}),
      autoAuthorizedRetry: options.config.bilibili.autoAuthorizedRetry, secrets: options.secrets, allowsText: options.allowsText,
      cardRenderer: 'summary',
      ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}) }) : undefined
    let douyin: AgentMediaRelayProvider | undefined
    if (options.config.enabled && options.config.douyin?.enabled) {
      const directory = path.join(run, 'douyin-provider'); await mkdir(directory, { mode: 0o700 })
      douyin = createAgentDouyinRelayProvider({ directory, artifacts, secrets: options.secrets, allowsText: options.allowsText,
        ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}) })
    }
    let xiaohongshu: AgentMediaRelayProvider | undefined
    if (options.config.enabled && options.config.xiaohongshu?.enabled) {
      const directory = path.join(run, 'xiaohongshu-provider'); await mkdir(directory, { mode: 0o700 })
      xiaohongshu = createAgentXiaohongshuRelayProvider({ directory, artifacts, secrets: options.secrets, allowsText: options.allowsText,
        ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
        ...(options.config.xiaohongshu.authCookie ? { authCookie: options.config.xiaohongshu.authCookie } : {}) })
    }
    let youtube: AgentMediaRelayProvider | undefined
    if (options.config.enabled && options.config.youtube?.enabled) {
      const directory = path.join(run, 'youtube-provider'); await mkdir(directory, { mode: 0o700 })
      youtube = createAgentYoutubeRelayProvider({ directory, artifacts, secrets: options.secrets, allowsText: options.allowsText,
        ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
        ...(options.config.youtube.authCookie ? { authCookie: options.config.youtube.authCookie } : {}),
        ...(options.config.youtube.poToken ? { poToken: options.config.youtube.poToken } : {}),
        ...(options.config.youtube.proxyUrl ? { proxyUrl: options.config.youtube.proxyUrl } : {}) })
    }
    let pixiv: AgentMediaRelayProvider | undefined
    if (options.config.enabled && options.config.pixiv?.enabled) {
      const directory = path.join(run, 'pixiv-provider'); await mkdir(directory, { mode: 0o700 })
      pixiv = createAgentPixivRelayProvider({ directory, artifacts, secrets: options.secrets, allowsText: options.allowsText,
        allowRestricted: options.config.pixiv.allowRestricted,
        ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
        ...(options.config.pixiv.authCookie ? { authCookie: options.config.pixiv.authCookie } : {}),
        ...(options.config.pixiv.proxyUrl ? { proxyUrl: options.config.pixiv.proxyUrl } : {}) })
    }
    const provider: AgentMediaRelayProvider = Object.freeze({ async prepare(share: AgentMediaShare, context: AgentMediaRelayPrepareContext) {
      current()
      const owned = validateAgentMediaShare(share)
      if (owned.provider === 'bilibili' && bilibili) return bilibili.prepare(owned, context)
      if (owned.provider === 'douyin' && douyin) return douyin.prepare(owned, context)
      if (owned.provider === 'xiaohongshu' && xiaohongshu) return xiaohongshu.prepare(owned, context)
      if (owned.provider === 'youtube' && youtube) return youtube.prepare(owned, context)
      if (owned.provider === 'pixiv' && pixiv) return pixiv.prepare(owned, context)
      throw failure()
    } })
    let pixivToolProvider: AgentMediaRelayProvider | undefined
    if (options.pixivTools?.enabled) {
      const directory = path.join(run, 'pixiv-tools-provider'); await mkdir(directory, { mode: 0o700 })
      pixivToolProvider = createAgentPixivRelayProvider({ directory, artifacts, secrets: options.secrets, allowsText: options.allowsText,
        allowRestricted: options.pixivTools.allowRestricted, introCard: false,
        ...(options.pixivTools.authCookie ? { authCookie: options.pixivTools.authCookie } : {}),
        ...(options.pixivTools.proxyUrl ? { proxyUrl: options.pixivTools.proxyUrl } : {}) })
    }
    let qualityDirectory: string | undefined
    let videoSearchAttachmentProvider: AgentMediaRelayProvider | undefined
    if (options.videoSearchAttachments) {
      const directory = path.join(run, 'video-search-attachment-provider'); await mkdir(directory, { mode: 0o700 })
      videoSearchAttachmentProvider = createAgentBilibiliSearchAttachmentProvider({ directory, artifacts, secrets: options.secrets, allowsText: options.allowsText,
        ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}) })
    }
    if (options.bilibiliQuality?.enabled) {
      qualityDirectory = path.join(run, 'bilibili-quality-provider')
      await mkdir(qualityDirectory, { mode: 0o700 })
    }
    const qualityProviderFor = (binding: AgentBindingSnapshot): AgentBilibiliQualityProvider | undefined => {
      if (!qualityDirectory || !options.bilibiliQuality?.enabled || !bridges.has(binding.connectionId)) return undefined
      current()
      if (closing) throw failure()
      const owned = ownBilibiliQualityData(binding)
      return createAgentBilibiliQualityProvider({ directory: qualityDirectory, artifacts: artifacts!, secrets: options.secrets, allowsText: options.allowsText,
        ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
        credential: async context => {
          current()
          if (closing) throw failure()
          const cookie = await options.bilibiliQuality!.authService.credential(owned, context)
          current()
          if (closing || !cookie) throw failure()
          return cookie
        } })
    }
    for (const config of options.config.bridges) {
      await ownedRoot()
      const directory = path.join(run, `bridge-${digest(config.connectionId)}`)
      await mkdir(directory, { mode: 0o700 }); await chmod(directory, 0o700)
      // The bridge verifies the full copy before publishing its capability.
      const bridge = await openQqMediaRelayBridge({ directory, resources: { open: artifacts.openStream }, listen: config.listen,
        advertisedOrigin: config.advertisedOrigin, allowedPeers: config.allowedPeers, ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}) })
      bridges.set(config.connectionId, bridge)
    }
    await ownedRoot()
    return Object.freeze({ provider, ...(pixivToolProvider ? { pixivToolProvider } : {}), ...(videoSearchAttachmentProvider ? { videoSearchAttachmentProvider } : {}),
      qualityProviderFor, bridgeFor: (connectionId: string) => bridges.get(connectionId), close })
  } catch { await close(); throw failure() }
}
