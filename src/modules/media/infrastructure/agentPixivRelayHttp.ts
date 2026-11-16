import { isIP } from 'node:net'
import { createNativeYoutubeRequest, youtubePublicAddresses } from './agentYoutubeRelayHttp.js'
import type { AgentYoutubeLookup, AgentYoutubeRequest, AgentYoutubeRequestPolicy, AgentYoutubeResponse } from './agentYoutubeRelayHttp.js'
import { douyinGuard } from './agentDouyinRelayHttp.js'

export const pixivFailure = () => new Error('Pixiv 媒体获取失败：来源、权限、网络或内容不符合要求')
export const pixivGuard = douyinGuard
export type AgentPixivLookup = AgentYoutubeLookup
export type AgentPixivRequest = AgentYoutubeRequest
export type AgentPixivResponse = AgentYoutubeResponse
export type AgentPixivRequestPolicy = AgentYoutubeRequestPolicy
export interface AgentPixivHttpTarget { readonly id: string; readonly index?: number }
export const PIXIV_USER_AGENT = 'Mozilla/5.0 (compatible; XiloMediaRelay/1.0)'

/** Host and direct construction share one credential grammar. */
export function normalizePixivCookie(input: string | undefined): string {
  if (input === undefined || input === '') return ''
  if (typeof input !== 'string' || input.length > 32768 || /[^\x20-\x7e]/u.test(input)) throw pixivFailure()
  const value = input.replace(/^\s*cookie\s*:\s*/iu, '').trim(), names = new Set<string>(), parts = value.split(';')
  if (!parts.at(-1)?.trim()) parts.pop()
  for (const part of parts) {
    const at = part.indexOf('='), name = part.slice(0, at).trim(), data = part.slice(at + 1).trim()
    if (at < 1 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/u.test(name) || !data || /\s/u.test(data) || names.has(name)) throw pixivFailure()
    names.add(name)
  }
  if (!names.size) throw pixivFailure()
  return value
}

/** URL identity is checked again for every hop, before DNS or credentials are used. */
export function pixivOfficialUrl(input: string, kind: 'metadata' | 'image', target: AgentPixivHttpTarget): URL {
  if (!target || !/^[1-9]\d{0,11}$/u.test(target.id) || typeof input !== 'string' || !input || input.length > 8192 || /[\s\\\u0000-\u001f\u007f]/u.test(input) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu.test(input)) throw pixivFailure()
  const authority = /^https:\/\/([^/?#]+)/u.exec(input)?.[1]
  if (!authority || /[:@]/u.test(authority) || /(?:^|\/)\.{1,2}(?:\/|[?#]|$)/u.test(input) || /%(?:2e|2f|5c)/iu.test(input.split('?')[0]!)) throw pixivFailure()
  let url: URL; try { url = new URL(input) } catch { throw pixivFailure() }
  if (url.username || url.password || url.port || url.hash || isIP(url.hostname)) throw pixivFailure()
  if (kind === 'metadata') {
    if (url.hostname !== 'www.pixiv.net' || url.search || ![`/ajax/illust/${target.id}`, `/ajax/illust/${target.id}/pages`].includes(url.pathname)) throw pixivFailure()
  } else {
    const index = target.index
    if (url.hostname !== 'i.pximg.net' || !Number.isSafeInteger(index) || index! < 0 || index! > 1999) throw pixivFailure()
    const name = url.pathname.split('/').at(-1) ?? ''
    const suffix = '(?:_[A-Za-z0-9_-]{1,128})?\\.(?:jpe?g|png|webp|gif|avif)'
    const page = new RegExp(`^${target.id}_p${index}${suffix}$`, 'u'), firstFrame = new RegExp(`^${target.id}_ugoira0${suffix}$`, 'u')
    if (!(page.test(name) || index === 0 && firstFrame.test(name))) throw pixivFailure()
  }
  return url
}
export function createPixivHttp(options: { lookup?: AgentPixivLookup; request?: AgentPixivRequest; proxyUrl?: string; authCookie?: string; allows(value: string): boolean }) {
  const native = createNativeYoutubeRequest(options.proxyUrl)
  const auth = normalizePixivCookie(options.authCookie)
  return async (input: string, kind: 'metadata' | 'image', guard: ReturnType<typeof pixivGuard>, maxBytes: number, target: AgentPixivHttpTarget, onConsumed?: (bytes: number) => void) => {
    let url = pixivOfficialUrl(input, kind, target)
    const originalPath = url.pathname
    for (let hop = 0; hop <= 4; hop++) {
      if (!options.allows(url.href) || kind === 'metadata' && url.pathname !== originalPath) throw pixivFailure()
      const addresses = await youtubePublicAddresses(url.hostname, guard, options.lookup)
      const response = await guard.wait((options.request ?? native)(url, addresses[0]!, guard.signal, { maxBytes, headers: {
        'User-Agent': PIXIV_USER_AGENT, Referer: 'https://www.pixiv.net/', Accept: kind === 'metadata' ? 'application/json' : '*/*', ...(kind === 'metadata' && auth ? { Cookie: auth } : {}),
      } }), late => late.close?.())
      let closed = false
      const close = async () => { if (closed) return; closed = true; try { await response.close?.() } catch {} }
      try {
        await guard.ensure()
        if (!Number.isInteger(response.status)) throw pixivFailure()
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.location
          if (hop === 4 || typeof location !== 'string' || /[\\\s]/u.test(location) || /(?:^|\/)\.{1,2}(?:\/|[?#]|$)/u.test(location) || /%(?:2e|2f|5c)/iu.test(location.split('?')[0]!)) throw pixivFailure()
          const authority = /^(?:https?:)?\/\/([^/?#]+)/iu.exec(location)?.[1]
          if (authority && /[:@]/u.test(authority)) throw pixivFailure()
          const redirected = pixivOfficialUrl(new URL(location, url).href, kind, target)
          if (!options.allows(redirected.href) || kind === 'metadata' && redirected.pathname !== originalPath) throw pixivFailure()
          url = redirected; await close(); continue
        }
        if (response.status !== 200 || response.headers['content-encoding'] && response.headers['content-encoding']!.toLowerCase() !== 'identity') throw pixivFailure()
        const length = response.headers['content-length']
        if (length !== undefined && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)))) throw pixivFailure()
        if (length !== undefined && Number(length) > maxBytes) throw Object.assign(pixivFailure(), { code: 'pixiv_bytes_limit' })
        const body = response.body, iterable: AsyncIterable<Uint8Array> = typeof body === 'string' || body instanceof Uint8Array ? (async function* () { yield typeof body === 'string' ? Buffer.from(body) : body })() : body
        if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function') throw pixivFailure()
        let consumed = false
        return { url, mime: (response.headers['content-type'] ?? '').split(';', 1)[0]!.trim().toLowerCase(), close,
          chunks: (async function* () {
            if (consumed) throw pixivFailure(); consumed = true
            let size = 0; const iterator = iterable[Symbol.asyncIterator]()
            try {
              while (true) {
                await guard.ensure(); const next = await guard.wait(Promise.resolve().then(() => iterator.next())); if (next.done) break
                if (!(next.value instanceof Uint8Array)) throw pixivFailure()
                // Count the complete observed transport chunk before checking the cap.
                // A failing image must not make its last consumed chunk free for later pages.
                size += next.value.byteLength; onConsumed?.(next.value.byteLength)
                if (size > maxBytes) throw Object.assign(pixivFailure(), { code: 'pixiv_bytes_limit' })
                for (let at = 0; at < next.value.byteLength; at += 1024 * 1024) { await guard.ensure(); yield Buffer.from(next.value.subarray(at, at + 1024 * 1024)) }
              }
              if (!size || length !== undefined && Number(length) !== size) throw pixivFailure()
              await guard.ensure()
            } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'pixiv_bytes_limit') throw Object.assign(pixivFailure(), { code: 'pixiv_bytes_limit' }); throw pixivFailure() }
            finally { try { const returned = iterator.return?.(); if (returned) void Promise.resolve(returned).catch(() => {}) } catch {}; await close() }
          })() }
      } catch (error) { await close(); if (error && typeof error === 'object' && 'code' in error && error.code === 'pixiv_bytes_limit') throw error; throw pixivFailure() }
    }
    throw pixivFailure()
  }
}
export async function pixivBody(response: { chunks: AsyncIterable<Uint8Array> }): Promise<Buffer> { const chunks: Buffer[] = []; for await (const bytes of response.chunks) chunks.push(Buffer.from(bytes)); return Buffer.concat(chunks) }
