import { types } from 'node:util'
import { isIP } from 'node:net'
import { isPublicAddress } from '../modules/shared/infrastructure/publicAddress.js'

export interface StandaloneMagnetSearchConfig {
  readonly enabled: boolean
  readonly searchUrl: string
  readonly bitsearchUrl: string
  readonly solidSearchUrl: string
  readonly proxyUrl: string
  readonly timeoutMs: number
  readonly proxyTimeoutMs: number
}

/** Explicit independent declaration; parsing opens no network, credentials or host resources. */
export function readStandaloneMagnetSearchConfig(input: unknown): Readonly<StandaloneMagnetSearchConfig> {
  const fail = () => new Error('tools.magnetSearch 配置无效')
  const keys = ['enabled', 'searchUrl', 'bitsearchUrl', 'solidSearchUrl', 'proxyUrl', 'timeoutMs', 'proxyTimeoutMs']
  if (input !== undefined && (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).some(key =>
        typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value')))) throw fail()
  const value = (input ?? { enabled: false }) as Record<string, unknown>
  if (typeof value.enabled !== 'boolean') throw fail()
  const endpoint = (key: string, fallback: string, proxy = false) => {
    const raw = value[key] ?? fallback
    if (proxy && raw === '') return ''
    if (typeof raw !== 'string' || !raw || raw.length > 2048 || /[\s\\\u0000-\u001f\u007f]/u.test(raw)) throw fail()
    let url: URL
    try { url = new URL(raw) } catch { throw fail() }
    const host = url.hostname.replace(/^\[|\]$/gu, '')
    if (!(proxy ? ['http:', 'https:'] : ['https:']).includes(url.protocol) || url.search || url.hash || !host ||
        (proxy ? url.pathname !== '/' : url.username || url.password || host === 'localhost' || host.endsWith('.localhost') || isIP(host) && !isPublicAddress(host))) throw fail()
    return url.href
  }
  const duration = (key: string, fallback: number, maximum: number) => {
    const number = value[key] ?? fallback
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1000 || number > maximum) throw fail()
    return number
  }
  return Object.freeze({ enabled: value.enabled, searchUrl: endpoint('searchUrl', 'https://torrents-csv.com/service/search'),
    bitsearchUrl: endpoint('bitsearchUrl', 'https://bitsearch.eu/search'), solidSearchUrl: endpoint('solidSearchUrl', 'https://solidtorrents.to/api/v1/search'),
    proxyUrl: endpoint('proxyUrl', '', true), timeoutMs: duration('timeoutMs', 10_000, 60_000), proxyTimeoutMs: duration('proxyTimeoutMs', 8000, 30_000) })
}

export function standaloneMagnetSearchSecrets(config: StandaloneMagnetSearchConfig): string[] {
  if (!config.proxyUrl) return []
  const url = new URL(config.proxyUrl)
  return [url.username, url.password].filter(Boolean).flatMap(value => [value, decodeURIComponent(value)])
}
