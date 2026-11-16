import { lookup as dnsLookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import { isIP } from 'node:net'
import https from 'node:https'
import { isPublicAddress } from '../../shared/infrastructure/publicAddress.js'
import { douyinGuard, nativeAgentDouyinRequest } from './agentDouyinRelayHttp.js'
import type { AgentDouyinLookup, AgentDouyinResponse, AgentDouyinRequestPolicy } from './agentDouyinRelayHttp.js'
import { parseAgentXiaohongshuReference, readAgentXiaohongshuAccess, xiaohongshuAccessPageUrl } from './agentXiaohongshuRelayReference.js'

export const xiaohongshuFailure = () => new Error('小红书媒体获取失败：来源、权限、网络或内容不符合要求')
// These shared primitives own only cancellation and pinned HTTPS; no Douyin endpoint or state is reused.
export const xiaohongshuGuard = douyinGuard
export interface AgentXiaohongshuRequestPolicy extends AgentDouyinRequestPolicy { readonly method?: 'GET' | 'POST'; readonly body?: string }
export type AgentXiaohongshuRequest = (url: URL, address: LookupAddress, signal: AbortSignal, policy: AgentXiaohongshuRequestPolicy) => Promise<AgentXiaohongshuResponse>
/** The POST transport remains pinned and streams through the same response budget/abort owner. */
export const nativeAgentXiaohongshuRequest: AgentXiaohongshuRequest = (url, address, signal, policy) => {
  if (policy.method !== 'POST') return nativeAgentDouyinRequest(url, address, signal, policy)
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method: 'POST', agent: false, signal, family: address.family, maxHeaderSize: 16_384,
      headers: { ...policy.headers, 'Accept-Encoding': 'identity', 'Content-Length': String(Buffer.byteLength(policy.body ?? '')) },
      lookup: (_host, _options, callback) => callback(null, address.address, address.family) }, response => {
      response.on('error', () => {})
      resolve({ status: response.statusCode ?? 0, headers: { 'content-type': response.headers['content-type'], 'content-length': response.headers['content-length'],
        'content-encoding': response.headers['content-encoding'], location: response.headers.location }, body: response,
        ...(response.headers['set-cookie'] ? { setCookies: response.headers['set-cookie'] } : {}), close() { response.destroy(); request.destroy() } })
    })
    request.once('error', () => reject(xiaohongshuFailure())); request.end(policy.body)
  })
}
export type AgentXiaohongshuLookup = AgentDouyinLookup
export type AgentXiaohongshuResponse = AgentDouyinResponse
export type XiaohongshuRequestKind = 'page' | 'browser' | 'image' | 'video'
export const xiaohongshuFeedUrl = (url: URL) => url.href === 'https://edith.xiaohongshu.com/api/sns/web/v1/feed'
export const XIAOHONGSHU_MOBILE_UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'
const firstParty = (host: string) => host === 'www.xiaohongshu.com' || host === 'xiaohongshu.com'
export const xiaohongshuBrowserCookieUrl = (url: URL) => xiaohongshuFeedUrl(url) || firstParty(url.hostname) && (/^\/(?:explore|discovery\/item)\/[a-f0-9]{16,32}\/?$/iu.test(url.pathname) || url.pathname.startsWith('/api/'))
const suffix = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`)
const sensitive = /token|cookie|authorization|password|passwd|secret|credential|session|api[_-]?key|(?:^|[_-])(?:auth|sid|pwd)(?:$|[_-])/iu

/** Every hop is HTTPS, host bounded, and syntax checked before public DNS is pinned. */
export function xiaohongshuOfficialUrl(input: string, kind: XiaohongshuRequestKind): URL {
  if (typeof input !== 'string' || !input || input.length > 16_384 || /[\s\\\u0000-\u001f\u007f]/u.test(input) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu.test(input)) throw xiaohongshuFailure()
  const authority = /^https:\/\/([^/?#]+)/u.exec(input)?.[1]
  if (!authority || /[:@]/u.test(authority) || /(?:^|\/)\.{1,2}(?:\/|[?#]|$)/u.test(input) || /%(?:2e|2f|5c)/iu.test(input.split('?')[0]!)) throw xiaohongshuFailure()
  let url = new URL(input)
  const host = url.hostname
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || isIP(host) || !host.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(part))) throw xiaohongshuFailure()
  if (kind === 'page') {
    if (!(firstParty(host) && /^\/(?:explore|discovery\/item)\/[a-f0-9]{16,32}\/?$/iu.test(url.pathname) || host === 'xhslink.com' && /^\/(?:a\/)?[A-Za-z0-9_-]{1,128}\/?$/u.test(url.pathname))) throw xiaohongshuFailure()
    const ref = parseAgentXiaohongshuReference(url.href)
    if (!ref) throw xiaohongshuFailure()
    url = new URL(xiaohongshuAccessPageUrl(ref, readAgentXiaohongshuAccess(url.href, ref)))
  } else if (kind === 'browser') {
    if (!(firstParty(host) || suffix(host, 'xhscdn.com') || ['edith.xiaohongshu.com', 'web.xiaohongshu.com', 'fe-static.xiaohongshu.com'].includes(host))) throw xiaohongshuFailure()
    // Access material belongs only to a first-party note, never scripts/CDNs or other API routes.
    const note = firstParty(host) && /^\/(?:explore|discovery\/item)\/[a-f0-9]{16,32}\/?$/iu.test(url.pathname)
    if (note) url = xiaohongshuOfficialUrl(url.href, 'page')
    else if ([...url.searchParams].some(([key]) => /^xsec_(?:token|source)$/iu.test(key))) throw xiaohongshuFailure()
  } else {
    if (!suffix(host, 'xhscdn.com') || !/^sns-(?:webpic|img|video|bak)[a-z0-9-]*\.xhscdn\.com$/u.test(host) || [...url.searchParams].some(([key]) => sensitive.test(key))) throw xiaohongshuFailure()
  }
  return url
}

function closed(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Reflect.ownKeys(input).some(key => typeof key !== 'string' || !keys.includes(key))) throw xiaohongshuFailure()
  return input as Record<string, unknown>
}
/** Validate without reserializing: whitespace and key order are covered by the page signature. */
export function xiaohongshuFeedBody(body: unknown, expectedId: string, token?: string): string {
  if (typeof body !== 'string' || Buffer.byteLength(body) > 16_384 || !/^[a-f0-9]{16,32}$/u.test(expectedId)) throw xiaohongshuFailure()
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { throw xiaohongshuFailure() }
  // JSON.parse alone hides duplicate object keys; reject them before any raw bytes leave Core.
  const stack: { readonly object: boolean; readonly keys: Set<string> }[] = []
  for (let at = 0; at < body.length; at++) {
    const char = body[at]
    if (char === '{' || char === '[') { stack.push({ object: char === '{', keys: new Set() }); if (stack.length > 8) throw xiaohongshuFailure() }
    else if (char === '}' || char === ']') stack.pop()
    else if (char === '"') {
      const start = at; let escaped = false
      while (++at < body.length) { if (escaped) escaped = false; else if (body[at] === '\\') escaped = true; else if (body[at] === '"') break }
      let next = at + 1; while (/\s/u.test(body[next] ?? '') && next < body.length) next++
      if (body[next] === ':' && stack.at(-1)?.object) { const key = JSON.parse(body.slice(start, at + 1)) as string, keys = stack.at(-1)!.keys; if (keys.has(key)) throw xiaohongshuFailure(); keys.add(key) }
    }
  }
  const value = closed(parsed, ['source_note_id', 'image_formats', 'extra', 'xsec_source', 'xsec_token'])
  if (value.source_note_id !== expectedId || value.xsec_token !== undefined && (typeof token !== 'string' || !token || value.xsec_token !== token) ||
    value.xsec_source !== undefined && (typeof value.xsec_source !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.xsec_source))) throw xiaohongshuFailure()
  if (value.image_formats !== undefined && (!Array.isArray(value.image_formats) || value.image_formats.length > 3 || new Set(value.image_formats).size !== value.image_formats.length || value.image_formats.some(format => !['jpg', 'webp', 'avif'].includes(format)))) throw xiaohongshuFailure()
  if (value.extra !== undefined) { const extra = closed(value.extra, ['need_body_topic']); if (extra.need_body_topic !== '1' && extra.need_body_topic !== 1) throw xiaohongshuFailure() }
  return body
}
function signatures(input: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(input ?? {})) {
    const name = key.toLowerCase()
    if (!['x-s', 'x-t', 'x-s-common'].includes(name) || Object.hasOwn(result, name) || typeof value !== 'string' || !/^[\x20-\x7e]{1,8192}$/u.test(value) || name === 'x-t' && !/^\d{1,20}$/u.test(value)) throw xiaohongshuFailure()
    result[name] = value
  }
  return result
}
export interface AgentXiaohongshuBrowserSession { readonly cookie?: string; readonly method?: 'GET' | 'POST'; readonly body?: string; readonly headers?: Readonly<Record<string, string>> }

export function createXiaohongshuHttp(options: { lookup?: AgentXiaohongshuLookup; request?: AgentXiaohongshuRequest; authCookie?: string;
  allows(value: string): boolean; checkPage?(url: URL, kind: XiaohongshuRequestKind): void; feedContext?(): { readonly id: string; readonly token?: string }; allowsMedia?(value: string, kind: XiaohongshuRequestKind): boolean; registerAnonymousSecrets?(values: readonly string[]): void }) {
  if (options.authCookie !== undefined && (typeof options.authCookie !== 'string' || options.authCookie.length > 32768 || /[\u0000-\u001f\u007f]/u.test(options.authCookie))) throw xiaohongshuFailure()
  return async (input: string, kind: XiaohongshuRequestKind, guard: ReturnType<typeof xiaohongshuGuard>, maxBytes: number, session?: AgentXiaohongshuBrowserSession) => {
    let url = xiaohongshuOfficialUrl(input, kind)
    const method = session?.method ?? 'GET'
    if (!['GET', 'POST'].includes(method) || method === 'GET' && (session?.body !== undefined || session?.headers !== undefined)) throw xiaohongshuFailure()
    const signed = method === 'POST' ? signatures(session?.headers) : {}
    let postBody: string | undefined
    for (let hop = 0; hop <= 4; hop++) {
      if (method === 'POST') {
        const source = options.feedContext?.()
        if (kind !== 'browser' || !xiaohongshuFeedUrl(url) || !source) throw xiaohongshuFailure()
        postBody = xiaohongshuFeedBody(session?.body, source.id, source.token)
        const otherFields = JSON.parse(postBody) as Record<string, unknown>; delete otherFields.xsec_token
        if (options.allowsMedia?.(JSON.stringify(otherFields), 'browser') === false) throw xiaohongshuFailure()
        if (!options.allows(postBody) || Object.values(signed).some(value => !options.allows(value) || options.allowsMedia?.(value, 'browser') === false)) throw xiaohongshuFailure()
        options.registerAnonymousSecrets?.(Object.values(signed).filter(value => value.length >= 8))
      }
      if (kind === 'page' || kind === 'browser' && firstParty(url.hostname) && /^\/(?:explore|discovery\/item)\/[a-f0-9]{16,32}\/?$/iu.test(url.pathname)) options.checkPage?.(url, kind)
      if (!options.allows(url.href) || (kind === 'image' || kind === 'video' || kind === 'browser' && !(firstParty(url.hostname) && /^\/(?:explore|discovery\/item)\/[a-f0-9]{16,32}\/?$/iu.test(url.pathname))) && options.allowsMedia?.(url.href, kind) === false) throw xiaohongshuFailure()
      await guard.ensure()
      const addresses = await guard.wait((options.lookup ?? (host => dnsLookup(host, { all: true, verbatim: true })))(url.hostname))
      if (!Array.isArray(addresses) || !addresses.length || addresses.length > 32 || addresses.some(address => !address || isIP(address.address) !== address.family || !isPublicAddress(address.address))) throw xiaohongshuFailure()
      await guard.ensure()
      const cookie = kind === 'page' && firstParty(url.hostname) ? options.authCookie ?? '' : kind === 'browser' && xiaohongshuBrowserCookieUrl(url) ? session?.cookie ?? '' : ''
      if (kind === 'browser' && cookie && (cookie.length > 8192 || /[\u0000-\u001f\u007f]/u.test(cookie) || !options.allows(cookie) || options.allowsMedia?.(cookie, 'browser') === false)) throw xiaohongshuFailure()
      if (kind === 'browser' && cookie) options.registerAnonymousSecrets?.(cookie.split(';').map(value => value.trim().split('=').slice(1).join('=')).filter(value => value.length >= 8))
      const response = await guard.wait((options.request ?? nativeAgentXiaohongshuRequest)(url, addresses[0]!, guard.signal, {
        maxBytes, ...(method === 'POST' ? { method, body: postBody! } : {}), headers: { 'User-Agent': XIAOHONGSHU_MOBILE_UA, Referer: 'https://www.xiaohongshu.com/', Accept: '*/*', ...(cookie ? { Cookie: cookie } : {}),
          ...(method === 'POST' ? { 'Content-Type': 'application/json;charset=UTF-8', Origin: 'https://www.xiaohongshu.com', ...signed } : {}) },
      }), late => late.close?.())
      let closed = false
      const close = async () => { if (closed) return; closed = true; try { await response.close?.() } catch {} }
      try {
        await guard.ensure()
        if (!Number.isInteger(response.status)) throw xiaohongshuFailure()
        if (response.status >= 300 && response.status < 400) {
          if (method === 'POST') throw xiaohongshuFailure()
          const location = response.headers.location
          if (hop === 4 || typeof location !== 'string' || !options.allows(location) || /[\\\s]/u.test(location) || /(?:^|\/)\.{1,2}(?:\/|[?#]|$)/u.test(location) || /%(?:2e|2f|5c)/iu.test(location.split('?')[0]!)) throw xiaohongshuFailure()
          const authority = /^(?:https?:)?\/\/([^/?#]+)/iu.exec(location)?.[1]
          if (authority && /[:@]/u.test(authority)) throw xiaohongshuFailure()
          url = xiaohongshuOfficialUrl(new URL(location, url).href, kind); await close(); continue
        }
        // A controlled short redirect can establish the work even when its page needs a browser.
        if (kind === 'page' && firstParty(url.hostname) && [403, 412, 429].includes(response.status)) {
          await close(); return { url, mime: '', close, setCookies: [] as readonly string[], chunks: (async function* () {})() }
        }
        if (response.status !== 200 || response.headers['content-encoding'] && response.headers['content-encoding']!.toLowerCase() !== 'identity') throw xiaohongshuFailure()
        const length = response.headers['content-length']
        if (length !== undefined && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maxBytes)) throw xiaohongshuFailure()
        const body = response.body
        const iterable: AsyncIterable<Uint8Array> = typeof body === 'string' || body instanceof Uint8Array ? (async function* () { yield typeof body === 'string' ? Buffer.from(body) : body })() : body
        if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function') throw xiaohongshuFailure()
        const setCookies: readonly string[] = kind === 'browser' && xiaohongshuBrowserCookieUrl(url) && Array.isArray(response.setCookies) ? response.setCookies : []
        if (setCookies.length > 32 || setCookies.some(value => typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value) || !options.allows(value) || options.allowsMedia?.(value, 'browser') === false)) throw xiaohongshuFailure()
        options.registerAnonymousSecrets?.(setCookies.map(value => value.split(';', 1)[0]!.split('=').slice(1).join('=')).filter(value => value.length >= 8))
        let consumed = false
        return { url, mime: (response.headers['content-type'] ?? '').split(';', 1)[0]!.trim().toLowerCase(), close, setCookies,
          chunks: (async function* () {
            if (consumed) throw xiaohongshuFailure(); consumed = true
            let size = 0
            const iterator = iterable[Symbol.asyncIterator]()
            try {
              while (true) {
                await guard.ensure(); const next = await guard.wait(Promise.resolve().then(() => iterator.next()))
                if (next.done) break
                if (!(next.value instanceof Uint8Array)) throw xiaohongshuFailure()
                size += next.value.byteLength
                if (size > maxBytes) throw xiaohongshuFailure()
                for (let at = 0; at < next.value.byteLength; at += 1024 * 1024) { await guard.ensure(); yield Buffer.from(next.value.subarray(at, at + 1024 * 1024)) }
              }
              if (!size || length !== undefined && Number(length) !== size) throw xiaohongshuFailure()
              await guard.ensure()
            } finally { try { const result = iterator.return?.(); if (result) void Promise.resolve(result).catch(() => {}) } catch {}; await close() }
          })() }
      } catch { await close(); throw xiaohongshuFailure() }
    }
    throw xiaohongshuFailure()
  }
}
export async function xiaohongshuBody(response: { chunks: AsyncIterable<Uint8Array> }): Promise<Buffer> {
  const chunks: Buffer[] = []; for await (const bytes of response.chunks) chunks.push(Buffer.from(bytes)); return Buffer.concat(chunks)
}
