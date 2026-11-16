import { createNativeYoutubeRequest, youtubePublicAddresses } from './agentYoutubeRelayHttp.js'
import type { AgentPixivLookup, AgentPixivRequest } from './agentPixivRelayHttp.js'
import { normalizePixivCookie, PIXIV_USER_AGENT, pixivGuard } from './agentPixivRelayHttp.js'

export const pixivSearchFailure = () => new Error('Pixiv 搜索暂时不可用：来源、权限、网络或内容未通过验证')
export { pixivGuard as pixivSearchGuard }
export type PixivSearchHttpTarget =
  | { readonly kind: 'search'; readonly keyword: string; readonly order: 'date_d' | 'date' | 'popular_d' }
  | { readonly kind: 'ranking'; readonly mode: 'daily' | 'weekly'; readonly page: 1 | 2 }
  | { readonly kind: 'profile'; readonly userId: string }
  | { readonly kind: 'detail'; readonly id: string }
  | { readonly kind: 'thumbnail'; readonly id: string }
export const pixivSearchId = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,11}$/u.test(value)

/** The metadata request vocabulary has no caller-selected endpoint or extra query. */
export function pixivSearchMetadataUrl(target: Exclude<PixivSearchHttpTarget, { kind: 'thumbnail' }>): string {
  switch (target.kind) {
    case 'search': {
      if (typeof target.keyword !== 'string' || !target.keyword || Array.from(target.keyword).length > 80 || /[\u0000-\u001f\u007f]/u.test(target.keyword) || ['.', '..'].includes(target.keyword) || !['date_d', 'date', 'popular_d'].includes(target.order)) throw pixivSearchFailure()
      const word = encodeURIComponent(target.keyword)
      return `https://www.pixiv.net/ajax/search/artworks/${word}?word=${word}&order=${target.order}&mode=safe&p=1&type=all&lang=zh`
    }
    case 'ranking': if (!['daily', 'weekly'].includes(target.mode) || ![1, 2].includes(target.page)) throw pixivSearchFailure(); return `https://www.pixiv.net/ranking.php?mode=${target.mode}&content=all&format=json&p=${target.page}`
    case 'profile': if (!pixivSearchId(target.userId)) throw pixivSearchFailure(); return `https://www.pixiv.net/ajax/user/${target.userId}/profile/all?lang=zh`
    case 'detail': if (!pixivSearchId(target.id)) throw pixivSearchFailure(); return `https://www.pixiv.net/ajax/illust/${target.id}?lang=zh`
    default: throw pixivSearchFailure()
  }
}

/** Search thumbnails may add Pixiv's bounded master/square/custom suffix to page zero. */
export function pixivSearchOfficialUrl(input: string, target: PixivSearchHttpTarget): URL {
  if (typeof input !== 'string' || !input || input.length > 8192 || /[\s\\\u0000-\u001f\u007f]/u.test(input) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu.test(input)) throw pixivSearchFailure()
  let url: URL; try { url = new URL(input) } catch { throw pixivSearchFailure() }
  if (url.username || url.password || url.port || url.hash) throw pixivSearchFailure()
  if (target.kind !== 'thumbnail') {
    if (input !== pixivSearchMetadataUrl(target)) throw pixivSearchFailure()
  } else {
    if (!pixivSearchId(target.id) || !input.startsWith('https://i.pximg.net/') || url.hostname !== 'i.pximg.net' || /(?:^|\/)\.{1,2}(?:\/|[?#]|$)/u.test(input) || /%(?:2e|2f|5c)/iu.test(input.split('?')[0]!)) throw pixivSearchFailure()
    const filename = url.pathname.split('/').at(-1) ?? ''
    if (!new RegExp(`^${target.id}_(?:p0|ugoira0)(?:_[A-Za-z0-9_-]{1,128})?\\.(?:jpe?g|png|webp|gif|avif)$`, 'u').test(filename)) throw pixivSearchFailure()
  }
  return url
}

export function createPixivSearchHttp(options: { readonly authCookie?: string; readonly proxyUrl?: string; readonly lookup?: AgentPixivLookup; readonly request?: AgentPixivRequest; allows(value: string): boolean }) {
  const native = createNativeYoutubeRequest(options.proxyUrl), cookie = normalizePixivCookie(options.authCookie)
  return async (input: string, target: PixivSearchHttpTarget, guard: ReturnType<typeof pixivGuard>, maxBytes: number): Promise<{ readonly mime: string; readonly bytes: Buffer }> => {
    try {
      let url = pixivSearchOfficialUrl(input, target)
      for (let hop = 0; hop <= 4; hop++) {
        if (!options.allows(url.href)) throw pixivSearchFailure()
        const addresses = await youtubePublicAddresses(url.hostname, guard, options.lookup)
        const response = await guard.wait((options.request ?? native)(url, addresses[0]!, guard.signal, { maxBytes, headers: {
          'User-Agent': PIXIV_USER_AGENT, Referer: 'https://www.pixiv.net/', Accept: target.kind === 'thumbnail' ? 'image/*' : 'application/json', ...(target.kind !== 'thumbnail' && cookie ? { Cookie: cookie } : {}),
        } }), late => late.close?.())
        let closed = false
        const close = async () => { if (closed) return; closed = true; try { await response.close?.() } catch {} }
        try {
          await guard.ensure()
          if (!Number.isInteger(response.status)) throw pixivSearchFailure()
          if (response.status >= 300 && response.status < 400) {
            const location = response.headers.location
            if (hop === 4 || typeof location !== 'string' || !location || /[\\\s\u0000-\u001f\u007f]/u.test(location) || /(?:^|\/)\.{1,2}(?:\/|[?#]|$)/u.test(location) || /%(?:2e|2f|5c)/iu.test(location.split('?')[0]!)) throw pixivSearchFailure()
            const authority = /^(?:https?:)?\/\/([^/?#]+)/iu.exec(location)?.[1]
            if (authority && /[:@]/u.test(authority)) throw pixivSearchFailure()
            const redirected = pixivSearchOfficialUrl(new URL(location, url).href, target)
            if (!options.allows(redirected.href)) throw pixivSearchFailure()
            url = redirected; continue
          }
          if (response.status !== 200 || response.headers['content-encoding'] && response.headers['content-encoding']!.toLowerCase() !== 'identity') throw pixivSearchFailure()
          const mime = (response.headers['content-type'] ?? '').split(';', 1)[0]!.trim().toLowerCase()
          if (target.kind !== 'thumbnail' && mime !== 'application/json' || target.kind === 'thumbnail' && !['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/avif'].includes(mime)) throw pixivSearchFailure()
          const length = response.headers['content-length']
          if (length !== undefined && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maxBytes)) throw pixivSearchFailure()
          const body = response.body, iterable: AsyncIterable<Uint8Array> = typeof body === 'string' || body instanceof Uint8Array ? (async function* () { yield typeof body === 'string' ? Buffer.from(body) : body })() : body
          if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function') throw pixivSearchFailure()
          const chunks: Buffer[] = [], iterator = iterable[Symbol.asyncIterator](); let size = 0
          try {
            while (true) {
              await guard.ensure(); const part = await guard.wait(Promise.resolve().then(() => iterator.next()))
              if (part.done) break
              if (!(part.value instanceof Uint8Array)) throw pixivSearchFailure()
              size += part.value.byteLength; if (size > maxBytes) throw pixivSearchFailure()
              chunks.push(Buffer.from(part.value))
            }
            if (!size || length !== undefined && Number(length) !== size) throw pixivSearchFailure()
            await guard.ensure(); return { mime, bytes: Buffer.concat(chunks, size) }
          } finally { try { const returned = iterator.return?.(); if (returned) void Promise.resolve(returned).catch(() => {}) } catch {} }
        } finally { await close() }
      }
    } catch { throw pixivSearchFailure() }
    throw pixivSearchFailure()
  }
}
