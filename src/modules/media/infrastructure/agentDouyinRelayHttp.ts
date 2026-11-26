import { lookup as dnsLookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import https from 'node:https'
import { isIP } from 'node:net'
import type { AgentMediaResourceContext } from '../../../contracts/agentMediaRelay.js'
import { agentErrorDetails, annotateAgentError } from '../../runtime/infrastructure/agentDiagnostics.js'
import { isPublicAddress } from '../../shared/infrastructure/publicAddress.js'

export const douyinFailure = () => new Error('抖音媒体获取失败：来源、权限、网络或内容不符合要求')
export class DouyinHttpError extends Error {
  constructor(readonly step: string, readonly httpStatus?: number, error?: unknown) {
    super('抖音媒体获取失败：来源、权限、网络或内容不符合要求')
    annotateAgentError(this, agentErrorDetails(error) ?? {})
  }
}
export type DouyinRequestKind = 'page' | 'browser' | 'video' | 'image' | 'music'
export interface AgentDouyinRequestPolicy { readonly maxBytes: number; readonly headers: Readonly<Record<string, string>> }
export interface AgentDouyinResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly body: AsyncIterable<Uint8Array> | Uint8Array | string
  readonly setCookies?: readonly string[]
  close?(): Promise<void> | void
}
export type AgentDouyinRequest = (url: URL, address: LookupAddress, signal: AbortSignal, policy: AgentDouyinRequestPolicy) => Promise<AgentDouyinResponse>
export type AgentDouyinLookup = (hostname: string) => Promise<readonly LookupAddress[]>

const watchedContexts = new WeakSet<AgentMediaResourceContext>()

export function douyinGuard(context: AgentMediaResourceContext, timeoutMs: number) {
  const cancel = new AbortController()
  if (!(context?.signal instanceof AbortSignal) || typeof context.isCurrent !== 'function' || context.ensureCurrent !== undefined && typeof context.ensureCurrent !== 'function') throw douyinFailure()
  const signal = AbortSignal.any([context.signal, cancel.signal])
  const check = () => { try { if (signal.aborted || context.isCurrent() !== true) throw douyinFailure() } catch { throw douyinFailure() } }
  let deadlineElapsed = false
  const timer = setTimeout(() => { deadlineElapsed = true; cancel.abort() }, timeoutMs); timer.unref()
  let checking = false
  // The parent already polls source authority; its abort signal stops every child stage.
  const watcher = watchedContexts.has(context) ? undefined : setInterval(() => {
    try {
      check()
      if (context.ensureCurrent && !checking) {
        checking = true
        void Promise.resolve().then(() => context.ensureCurrent!()).catch(() => cancel.abort()).finally(() => { checking = false })
      }
    } catch { cancel.abort() }
  }, 20)
  watcher?.unref()
  const wait = <T>(operation: Promise<T>, late?: (value: T) => unknown): Promise<T> => new Promise((resolve, reject) => {
    let settled = false
    const abort = () => { settled = true; signal.removeEventListener('abort', abort); reject(douyinFailure()) }
    operation.then(value => {
      signal.removeEventListener('abort', abort)
      try { if (settled) throw douyinFailure(); check(); settled = true; resolve(value) }
      catch { if (late) void Promise.resolve().then(() => late(value)).catch(() => {}); reject(douyinFailure()) }
    }, error => {
      settled = true; signal.removeEventListener('abort', abort)
      reject(annotateAgentError(douyinFailure(), agentErrorDetails(error) ?? {}))
    })
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
  })
  const scoped = Object.freeze({ signal, isCurrent: () => { try { check(); return true } catch { return false } },
    ...(context.ensureCurrent ? { ensureCurrent: () => context.ensureCurrent!() } : {}) })
  watchedContexts.add(scoped)
  return { signal, check, wait, async ensure() { check(); if (context.ensureCurrent) await wait(Promise.resolve().then(() => context.ensureCurrent!())); check() },
    context: scoped,
    get deadlineElapsed() { return deadlineElapsed },
    close() { clearTimeout(timer); clearInterval(watcher); cancel.abort() } }
}

const pageHosts = new Set(['douyin.com', 'www.douyin.com', 'iesdouyin.com', 'www.iesdouyin.com', 'v.douyin.com'])
const suffix = (host: string, domains: readonly string[]) => domains.some(domain => host === domain || host.endsWith(`.${domain}`))
const imageDomains = ['douyinpic.com', 'byteimg.com', 'ibytedtos.com', 'douyinstatic.com', 'pstatp.com']
const browserDomains = [...imageDomains, 'douyinvod.com', 'douyincdn.com', 'bytegoofy.com', 'bytescm.com', 'bytednsdoc.com', 'bytedance.com']
/** Never upgrades or resolves an unvalidated endpoint. Every redirected hop is checked again. */
export function douyinOfficialUrl(input: string, kind: DouyinRequestKind): URL {
  if (typeof input !== 'string' || !input || input.length > 8192 || /[\s\\\u0000-\u001f\u007f]/u.test(input) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu.test(input)) throw douyinFailure()
  const authority = /^https:\/\/([^/?#]+)/u.exec(input)?.[1]
  if (!authority || /[:@]/u.test(authority) || /(?:^|\/)\.{1,2}(?:\/|[?#]|$)/u.test(input) || /%(?:2e|2f|5c)/iu.test(input.split('?')[0]!)) throw douyinFailure()
  const url = new URL(input), host = url.hostname
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || isIP(host) || !host.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(part))) throw douyinFailure()
  const page = pageHosts.has(host)
  const allowed = kind === 'page' ? page && (host === 'v.douyin.com' ? /^\/[A-Za-z0-9_-]{1,128}\/?$/u.test(url.pathname) : /^\/(?:share\/)?(?:video|note)\/[1-9]\d{5,19}\/?$/u.test(url.pathname))
    : kind === 'browser' ? page || suffix(host, browserDomains)
      : kind === 'image' ? suffix(host, imageDomains)
        : kind === 'music' ? suffix(host, ['douyinstatic.com', 'douyincdn.com', 'byteimg.com', 'ibytedtos.com'])
          : suffix(host, ['douyinvod.com', 'douyincdn.com']) || ['aweme.snssdk.com', 'www.iesdouyin.com', 'www.douyin.com'].includes(host) && /^\/aweme\/v\d+\/play(?:wm)?\/?$/u.test(url.pathname)
  if (!allowed) throw douyinFailure()
  return url
}

export const nativeAgentDouyinRequest: AgentDouyinRequest = (url, address, signal, policy) => new Promise((resolve, reject) => {
  const request = https.request(url, { method: 'GET', agent: false, signal, family: address.family, maxHeaderSize: 16_384,
    headers: { ...policy.headers, 'Accept-Encoding': 'identity' },
    lookup: (_host, _options, callback) => callback(null, address.address, address.family) }, response => {
    response.on('error', () => {})
    resolve({ status: response.statusCode ?? 0, headers: { 'content-type': response.headers['content-type'], 'content-length': response.headers['content-length'],
      'content-encoding': response.headers['content-encoding'], location: response.headers.location }, body: response,
      ...(response.headers['set-cookie'] ? { setCookies: response.headers['set-cookie'] } : {}),
      close() { response.destroy(); request.destroy() } })
  })
  request.once('error', error => reject(annotateAgentError(douyinFailure(), agentErrorDetails(error) ?? {}))); request.end()
})

export function createDouyinHttp(options: { lookup?: AgentDouyinLookup; request?: AgentDouyinRequest; allows(value: string): boolean; registerAnonymousSecrets?(values: readonly string[]): void }) {
  return async (input: string, kind: DouyinRequestKind, guard: ReturnType<typeof douyinGuard>, maxBytes: number, session?: { readonly cookie: string }) => {
    let url = douyinOfficialUrl(input, kind)
    for (let hop = 0; hop <= 4; hop++) {
      if (!options.allows(url.href)) throw douyinFailure()
      await guard.ensure()
      const addresses = await guard.wait((options.lookup ?? (host => dnsLookup(host, { all: true, verbatim: true })))(url.hostname))
        .catch(error => { throw new DouyinHttpError('douyin_http_dns', undefined, error) })
      if (!Array.isArray(addresses) || !addresses.length || addresses.length > 32 || addresses.some(address => !address || isIP(address.address) !== address.family || !isPublicAddress(address.address))) {
        throw new DouyinHttpError('douyin_http_address_policy')
      }
      await guard.ensure()
      const cookie = kind === 'browser' && url.hostname === 'www.douyin.com' && session?.cookie ? session.cookie : ''
      if (cookie && (cookie.length > 8192 || /[\r\n\u0000-\u001f\u007f]/u.test(cookie) || !options.allows(cookie))) throw douyinFailure()
      if (cookie) options.registerAnonymousSecrets?.(cookie.split(';').map(value => value.trim().split('=').slice(1).join('=')).filter(value => value.length >= 8))
      const response = await guard.wait((options.request ?? nativeAgentDouyinRequest)(url, addresses[0]!, guard.signal, {
        maxBytes, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36', Referer: 'https://www.douyin.com/', Accept: '*/*', ...(cookie ? { Cookie: cookie } : {}) },
      }), late => late.close?.()).catch(error => { throw new DouyinHttpError('response_headers', undefined, error) })
      let closed = false
      const close = async () => { if (closed) return; closed = true; try { await response.close?.() } catch {} }
      try {
        await guard.ensure()
        if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) throw douyinFailure()
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.location
          if (hop === 4 || typeof location !== 'string' || !options.allows(location) || /[\\\s]/u.test(location) ||
            /(?:^|\/)\.{1,2}(?:\/|[?#]|$)/u.test(location) || /%(?:2e|2f|5c)/iu.test(location.split('?')[0]!)) throw douyinFailure()
          const authority = /^(?:https?:)?\/\/([^/?#]+)/iu.exec(location)?.[1]
          if (authority && /[:@]/u.test(authority)) throw douyinFailure()
          url = douyinOfficialUrl(new URL(location, url).href, kind); await close(); continue
        }
        // A short link can identify its fixed work before the landing page presents an
        // anonymous-browser challenge. Preserve that validated identity without parsing
        // the challenge response or treating it as media.
        if (kind === 'page' && url.hostname !== 'v.douyin.com' && [403, 412, 429].includes(response.status)) {
          await close(); return { url, status: response.status, mime: '', close, setCookies: [] as readonly string[], chunks: (async function* () {})() }
        }
        if (response.status !== 200) throw new DouyinHttpError('douyin_http_status', response.status)
        if (response.headers['content-encoding'] && response.headers['content-encoding']!.toLowerCase() !== 'identity') throw douyinFailure()
        const length = response.headers['content-length']
        if (length !== undefined && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maxBytes)) throw douyinFailure()
        const body = response.body
        const iterable: AsyncIterable<Uint8Array> = typeof body === 'string' || body instanceof Uint8Array
          ? (async function* () { yield typeof body === 'string' ? Buffer.from(body) : body })() : body
        if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function') throw douyinFailure()
        let consumed = false
        const setCookies: readonly string[] = kind === 'browser' && url.hostname === 'www.douyin.com' && Array.isArray(response.setCookies) ? response.setCookies : []
        if (setCookies.length > 32 || setCookies.some(value => typeof value !== 'string' || value.length > 4096 || /[\r\n\u0000-\u001f\u007f]/u.test(value) || !options.allows(value))) throw douyinFailure()
        options.registerAnonymousSecrets?.(setCookies.map(value => value.split(';', 1)[0]!.split('=').slice(1).join('=')).filter(value => value.length >= 8))
        return { url, status: response.status, mime: (response.headers['content-type'] ?? '').split(';', 1)[0]!.trim().toLowerCase(), close, setCookies,
          chunks: (async function* () {
            if (consumed) throw douyinFailure(); consumed = true
            let size = 0
            const iterator = iterable[Symbol.asyncIterator]()
            try {
              while (true) {
                await guard.ensure(); const next = await guard.wait(Promise.resolve().then(() => iterator.next()))
                if (next.done) break
                if (!(next.value instanceof Uint8Array)) throw douyinFailure()
                size += next.value.byteLength
                if (size > maxBytes) throw douyinFailure()
                for (let at = 0; at < next.value.byteLength; at += 1024 * 1024) { await guard.ensure(); yield Buffer.from(next.value.subarray(at, at + 1024 * 1024)) }
              }
              if (!size || length !== undefined && Number(length) !== size) throw douyinFailure()
              await guard.ensure()
            } catch (error) { throw new DouyinHttpError('response_body', response.status, error) }
            finally { try { const returned = iterator.return?.(); if (returned) void Promise.resolve(returned).catch(() => {}) } catch {}; await close() }
          })() }
      } catch (error) {
        await close()
        const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : undefined
        throw error instanceof DouyinHttpError ? error : new DouyinHttpError('douyin_http_response', status, error)
      }
    }
    throw douyinFailure()
  }
}

export async function douyinBody(response: { chunks: AsyncIterable<Uint8Array> }): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const bytes of response.chunks) chunks.push(Buffer.from(bytes))
  return Buffer.concat(chunks)
}
