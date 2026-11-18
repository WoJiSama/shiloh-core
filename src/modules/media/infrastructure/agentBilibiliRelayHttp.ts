import { lookup as dnsLookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import https from 'node:https'
import { isIP } from 'node:net'
import type { AgentMediaResourceContext } from '../../../contracts/agentMediaRelay.js'
import { isPublicAddress } from '../../shared/infrastructure/publicAddress.js'

export const bilibiliFailure = () => new Error('B站媒体获取失败：来源、权限、网络或内容不符合要求')
export type BilibiliRequestKind = 'share' | 'metadata' | 'video' | 'image'
export interface AgentBilibiliRequestPolicy { readonly maxBytes: number; readonly headers: Readonly<Record<string, string>> }
export interface AgentBilibiliResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly body: AsyncIterable<Uint8Array> | Uint8Array | string
  close?(): Promise<void> | void
}
export type AgentBilibiliRequest = (url: URL, address: LookupAddress, signal: AbortSignal, policy: AgentBilibiliRequestPolicy) => Promise<AgentBilibiliResponse>
export type AgentBilibiliLookup = (hostname: string) => Promise<readonly LookupAddress[]>
export type BilibiliCleanupFailureCode = 'response_close_failed' | 'iterator_return_failed' | 'late_cleanup_failed' |
  'thumbnail_reader_close_failed' | 'thumbnail_file_close_failed' | 'thumbnail_directory_remove_failed' | 'thumbnail_artifact_release_failed'
export type BilibiliCleanupObserver = (code: BilibiliCleanupFailureCode) => unknown
/** Cleanup observers receive fixed metadata only and cannot interrupt remaining cleanup. */
export function reportBilibiliCleanupFailure(code: BilibiliCleanupFailureCode, observer?: BilibiliCleanupObserver): void {
  const terminal = () => { try { console.error(`[Agent] runtime/bilibili_provider_release failed ${code}`) } catch { /* No remaining writable observer. */ } }
  try { if (observer) { void Promise.resolve(observer(code)).catch(terminal); return } } catch { /* Fall back without exposing the observer's error. */ }
  terminal()
}
export function bilibiliGuard(context: AgentMediaResourceContext, timeoutMs: number, onCleanupFailure?: BilibiliCleanupObserver) {
  const cancel = new AbortController()
  let signal: AbortSignal
  try { if (!(context.signal instanceof AbortSignal) || typeof context.isCurrent !== 'function' || context.ensureCurrent !== undefined && typeof context.ensureCurrent !== 'function') throw bilibiliFailure(); signal = AbortSignal.any([context.signal, cancel.signal]) }
  catch { throw bilibiliFailure() }
  const check = () => { try { if (signal.aborted || context.isCurrent() !== true) throw bilibiliFailure() } catch { throw bilibiliFailure() } }
  const timer = setTimeout(() => cancel.abort(), timeoutMs); timer.unref()
  let checking = false
  const watcher = setInterval(() => {
    try {
      check()
      if (context.ensureCurrent && !checking) {
        checking = true
        void Promise.resolve().then(() => context.ensureCurrent!()).catch(() => cancel.abort()).finally(() => { checking = false })
      }
    } catch { cancel.abort() }
  }, 20); watcher.unref()
  const wait = <T>(operation: Promise<T>, late?: (value: T) => unknown): Promise<T> => new Promise((resolve, reject) => {
    let settled = false
    const abort = () => { settled = true; signal.removeEventListener('abort', abort); reject(bilibiliFailure()) }
    operation.then(value => {
      signal.removeEventListener('abort', abort)
      try { if (settled) throw bilibiliFailure(); check(); settled = true; resolve(value) }
      catch { if (late) void Promise.resolve().then(() => late(value)).catch(() => reportBilibiliCleanupFailure('late_cleanup_failed', onCleanupFailure)); reject(bilibiliFailure()) }
    }, () => { settled = true; signal.removeEventListener('abort', abort); reject(bilibiliFailure()) })
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
  })
  return { signal, check, wait, async ensure() { check(); if (context.ensureCurrent) await wait(Promise.resolve().then(() => context.ensureCurrent!())); check() },
    context: { signal, isCurrent: () => { try { check(); return true } catch { return false } }, ...(context.ensureCurrent ? { ensureCurrent: () => context.ensureCurrent!() } : {}) },
    close() { clearTimeout(timer); clearInterval(watcher); cancel.abort() } }
}
const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u
export function bilibiliOfficialUrl(input: string, kind: BilibiliRequestKind): URL {
  if (typeof input !== 'string' || !input || input.length > 8192 || /[\s\\\u0000-\u001f\u007f]/u.test(input) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu.test(input)) throw bilibiliFailure()
  const raw = input.startsWith('//') ? `https:${input}` : input
  const authority = /^https?:\/\/([^/?#]+)/iu.exec(raw)?.[1]
  if (!authority || authority.includes(':') || authority.includes('@') || /(?:^|\/)\.{1,2}(?:\/|[?#]|$)/u.test(raw) || /%(?:2e|2f|5c)/iu.test(raw.split('?')[0]!)) throw bilibiliFailure()
  const url = new URL(raw), host = url.hostname.toLowerCase()
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || url.hash || isIP(host) || !host.split('.').every(part => label.test(part))) throw bilibiliFailure()
  const media = host.endsWith('.bilivideo.com') || host.endsWith('.bilivideo.cn') || host.endsWith('.hdslb.com') || host === 'upos-hz-mirrorakam.akamaized.net'
  const allowed = kind === 'metadata' ? host === 'api.bilibili.com' && /^\/(?:x\/frontend\/finger\/spi|x\/web-interface\/view|x\/web-interface\/search\/type|x\/player\/playurl|pgc\/view\/web\/season|pgc\/player\/web\/playurl)$/u.test(url.pathname)
    : kind === 'share' ? host === 'b23.tv' && /^\/[A-Za-z0-9_-]{1,128}\/?$/u.test(url.pathname) || ['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'].includes(host) && /^\/(?:video\/BV[0-9A-Za-z]{8,16}|bangumi\/play\/ep[1-9]\d{0,19})\/?$/iu.test(url.pathname)
      : kind === 'video' ? media : host.endsWith('.hdslb.com')
  if (!allowed) throw bilibiliFailure()
  if (kind === 'metadata' && url.pathname === '/x/web-interface/search/type') {
    const keys = [...url.searchParams.keys()], keyword = url.searchParams.get('keyword')
    if (keys.length !== 4 || new Set(keys).size !== 4 || keys.some(key => !['keyword', 'search_type', 'order', 'page'].includes(key)) ||
      keyword === null || !keyword.trim() || Array.from(keyword).length > 200 || /[\u0000-\u001f\u007f]/u.test(keyword) ||
      url.searchParams.get('search_type') !== 'video' || url.searchParams.get('order') !== 'totalrank' || url.searchParams.get('page') !== '1') throw bilibiliFailure()
  }
  url.protocol = 'https:'
  return url
}
export const nativeAgentBilibiliRequest: AgentBilibiliRequest = (url, address, signal, policy) => new Promise((resolve, reject) => {
  const request = https.request(url, { method: 'GET', agent: false, signal, family: address.family, maxHeaderSize: 16_384,
    headers: { ...policy.headers, 'Accept-Encoding': 'identity' },
    lookup: (_host, _options, callback) => callback(null, address.address, address.family) }, response => {
    response.on('error', () => {})
    resolve({ status: response.statusCode ?? 0, headers: { 'content-type': response.headers['content-type'], 'content-length': response.headers['content-length'],
      'content-encoding': response.headers['content-encoding'], location: response.headers.location }, body: response,
      close() { response.destroy(); request.destroy() } })
  })
  request.once('error', () => reject(bilibiliFailure())); request.end()
})
export function createBilibiliHttp(options: { lookup?: AgentBilibiliLookup; request?: AgentBilibiliRequest; allows(value: string): boolean; onCleanupFailure?: BilibiliCleanupObserver }) {
  const closeResponse = async (response: AgentBilibiliResponse) => { try { await response.close?.() } catch { reportBilibiliCleanupFailure('response_close_failed', options.onCleanupFailure) } }
  return async (input: string, kind: BilibiliRequestKind, guard: ReturnType<typeof bilibiliGuard>, maxBytes: number, cookie = '') => {
    let url = bilibiliOfficialUrl(input, kind)
    for (let hop = 0; hop <= 4; hop++) {
      if (!options.allows(url.href)) throw bilibiliFailure()
      await guard.ensure()
      const addresses = await guard.wait((options.lookup ?? (host => dnsLookup(host, { all: true, verbatim: true })))(url.hostname))
      if (!Array.isArray(addresses) || !addresses.length || addresses.length > 32 || addresses.some(address => !address || isIP(address.address) !== address.family || !isPublicAddress(address.address))) throw bilibiliFailure()
      await guard.ensure()
      const headers = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/', Accept: kind === 'metadata' ? 'application/json' : kind === 'image' ? 'image/*' : '*/*',
        ...(cookie && (kind === 'metadata' || kind === 'video') ? { Cookie: cookie } : {}) }
      const response = await guard.wait((options.request ?? nativeAgentBilibiliRequest)(url, addresses[0]!, guard.signal, { maxBytes, headers }), closeResponse)
      let closed = false
      const close = async () => { if (closed) return; closed = true; await closeResponse(response) }
      try {
        await guard.ensure()
        if (!Number.isInteger(response.status)) throw bilibiliFailure()
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.location
          if (hop === 4 || typeof location !== 'string' || !options.allows(location)) throw bilibiliFailure()
          const rawAuthority = /^(?:https?:)?\/\/([^/?#]+)/iu.exec(location)?.[1]
          if (rawAuthority && (rawAuthority.includes(':') || rawAuthority.includes('@'))) throw bilibiliFailure()
          const next = new URL(location, url)
          // Validate raw spelling as well as the resolved URL, before DNS or forwarding credentials.
          if (/[\\\s]/u.test(location) || /(?:^|\/)\.{1,2}(?:\/|[?#]|$)/u.test(location) || /%(?:2e|2f|5c)/iu.test(location.split('?')[0]!)) throw bilibiliFailure()
          url = bilibiliOfficialUrl(next.href, kind); await close(); continue
        }
        if (kind === 'share' && url.hostname !== 'b23.tv' && (response.status >= 200 && response.status < 300 || response.status === 412)) {
          return { url, mime: '', close, chunks: (async function* () {})() }
        }
        if (response.status < 200 || response.status >= 300 || response.headers['content-encoding'] && response.headers['content-encoding']!.toLowerCase() !== 'identity') throw bilibiliFailure()
        const length = response.headers['content-length']
        if (length !== undefined && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maxBytes)) throw bilibiliFailure()
        const body = response.body
        const iterable: AsyncIterable<Uint8Array> = typeof body === 'string' || body instanceof Uint8Array
          ? (async function* () { yield typeof body === 'string' ? Buffer.from(body) : body })() : body
        if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function') throw bilibiliFailure()
        let consumed = false
        return { url, mime: (response.headers['content-type'] ?? '').split(';', 1)[0]!.trim().toLowerCase(), close,
          chunks: (async function* () {
            if (consumed) throw bilibiliFailure(); consumed = true
            let size = 0
            const iterator = iterable[Symbol.asyncIterator]()
            try {
              while (true) {
                await guard.ensure(); const next = await guard.wait(Promise.resolve().then(() => iterator.next()))
                if (next.done) break
                if (!(next.value instanceof Uint8Array)) throw bilibiliFailure()
                size += next.value.byteLength
                if (size > maxBytes) throw bilibiliFailure()
                for (let at = 0; at < next.value.byteLength; at += 1024 * 1024) { await guard.ensure(); yield Buffer.from(next.value.subarray(at, at + 1024 * 1024)) }
              }
              if (!size || length !== undefined && Number(length) !== size) throw bilibiliFailure()
              await guard.ensure()
            } finally {
              try { const returned = iterator.return?.(); if (returned) void Promise.resolve(returned).catch(() => reportBilibiliCleanupFailure('iterator_return_failed', options.onCleanupFailure)) }
              catch { reportBilibiliCleanupFailure('iterator_return_failed', options.onCleanupFailure) }
              await close()
            }
          })() }
      } catch { await close(); throw bilibiliFailure() }
    }
    throw bilibiliFailure()
  }
}
