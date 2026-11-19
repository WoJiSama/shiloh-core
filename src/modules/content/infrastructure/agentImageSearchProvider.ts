import { randomBytes, randomInt } from 'node:crypto'
import type { AgentToolContext } from '../../../contracts/agentTool.js'
import { createAgentSecretTextCheck } from '../../messaging/infrastructure/agentSecretText.js'
import { readAgentPublicImage, ensureAgentWebCurrent, normalizeAgentPublicWebUrl, type AgentPublicWebDependencies } from '../../tools/infrastructure/agentPublicWeb.js'
import { createImageSearchJsonReader, imageSearchFailure, nativeAgentImageSearchRequest, readImageSearchBody, type AgentImageSearchHttpDependencies } from './agentImageSearchHttp.js'

export interface AgentImageSearchProviderOptions {
  readonly secrets?: readonly string[]
  readonly publicWeb?: AgentPublicWebDependencies
  readonly providerHttp?: AgentImageSearchHttpDependencies
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const META_BYTES = 2 * 1024 * 1024, IMAGE_BYTES = 2 * 1024 * 1024, TOTAL_IMAGE_BYTES = 12 * 1024 * 1024
const MAX_DOWNLOADS = 24
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
function shuffle<T>(items: readonly T[]): T[] {
  const result = [...items]
  for (let index = result.length - 1; index > 0; index--) { const other = randomInt(index + 1); [result[index], result[other]] = [result[other]!, result[index]!] }
  return result
}

/** Search metadata supplies temporary URLs; callers receive only safe bounded image bytes. */
export function createAgentImageSearchProvider(options: AgentImageSearchProviderOptions = {}) {
  const secretCheck = createAgentSecretTextCheck(options.secrets ?? [])
  const json = createImageSearchJsonReader(options.providerHttp ?? {}, secretCheck)
  async function candidates(kind: 'emoji' | 'bing', keyword: string, count: number, context: AgentToolContext): Promise<readonly string[]> {
    const urls = new Set<string>()
    const add = (value: unknown) => {
      if (typeof value !== 'string' || !secretCheck(value)) return
      try {
        const parsed = new URL(value), publicAddress = new URL(parsed)
        publicAddress.search = ''
        normalizeAgentPublicWebUrl(publicAddress.href)
        // Search results are not credentials. Arbitrary public origins remain supported for Bing results.
        if (value.length <= 2048 && !parsed.port && !parsed.hash && !urls.has(parsed.href)) urls.add(parsed.href)
      } catch { /* One malformed result cannot become a download target. */ }
    }
    if (kind === 'emoji') {
      const target = Math.min(200, Math.max(24, count * 20))
      for (let page = 0; page < 10 && urls.size < target; page++) {
        await ensureAgentWebCurrent(context)
        const url = new URL('https://www.duitang.com/napi/blog/list/by_search/')
        url.searchParams.set('kw', keyword); url.searchParams.set('start', String(page * 24)); url.searchParams.set('limit', '24')
        const payload = await json(url, { method: 'GET', maxBytes: META_BYTES, headers: {
          Accept: 'application/json', 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest',
        } }, context)
        const rows = object(payload.data).object_list
        if (!Array.isArray(rows) || rows.length > 1000) throw imageSearchFailure()
        if (!rows.length) break
        const before = urls.size
        for (const row of rows) { if (urls.size >= target) break; add(object(object(row).photo).path) }
        if (urls.size === before) break
      }
    } else {
      const params = new URLSearchParams({ product_id: '52', version_code: '28103', page: '0', search_word: keyword,
        maxWidth: '99999', minWidth: '0', maxHeight: '99999', minHeight: '0', searchMode: 'ACCURATE_SEARCH', sort: '0', sign: randomBytes(32).toString('hex') })
      try {
        const payload = await json(new URL('https://wallpaper.soutushenqi.com/v1/wallpaper/list'), { method: 'POST', maxBytes: META_BYTES,
          headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA }, body: params.toString() }, context)
        if (!Array.isArray(payload.data) || payload.data.length > 1000) throw imageSearchFailure()
        for (const row of payload.data) { const value = object(row).largeUrl; if (typeof value === 'string' && !value.includes('fw480')) add(value) }
      } catch { await ensureAgentWebCurrent(context) }
      if (urls.size < count) {
        const url = new URL('https://cn.bing.com/images/vsasync')
        url.searchParams.set('q', keyword); url.searchParams.set('count', String(count - urls.size))
        const payload = await json(url, { method: 'GET', maxBytes: META_BYTES, headers: {
          Accept: 'application/json', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', Referer: 'https://cn.bing.com/visualsearch',
          'User-Agent': UA, 'sec-ms-gec': randomBytes(32).toString('hex').toUpperCase(), 'sec-ms-gec-version': '1-131.0.2903.112',
        } }, context)
        if (!Array.isArray(payload.results) || payload.results.length > 1000) throw imageSearchFailure()
        for (const row of payload.results) add(object(row).imageUrl)
      }
    }
    await ensureAgentWebCurrent(context)
    return shuffle([...urls]).slice(0, MAX_DOWNLOADS)
  }
  return {
    async search(kind: 'emoji' | 'bing', keyword: string, count: number, context: AgentToolContext): Promise<readonly { readonly mime: string; readonly base64: string }[]> {
      if (!['emoji', 'bing'].includes(kind) || typeof keyword !== 'string' || !keyword.trim() || keyword.length > 200 ||
          !secretCheck(keyword) || !Number.isSafeInteger(count) || count < 1 || count > 10) throw imageSearchFailure()
      const urls = await candidates(kind, keyword, count, context), images: { readonly mime: string; readonly base64: string }[] = []
      let total = 0
      for (const url of urls) {
        await ensureAgentWebCurrent(context)
        if (images.length >= count) break
        try {
          const dependencies: AgentPublicWebDependencies = { ...options.publicWeb,
            async request(target, address, signal) {
              if (!secretCheck(target.href)) throw imageSearchFailure()
              if (options.publicWeb?.request) {
                const response = await options.publicWeb.request(target, address, signal)
                if (!secretCheck(typeof response.body === 'string' ? response.body : Buffer.from(response.body).toString('utf8'))) throw imageSearchFailure()
                return response
              }
              const response = await nativeAgentImageSearchRequest(target, address, signal, { method: 'GET', maxBytes: IMAGE_BYTES,
                headers: { Accept: 'image/png, image/jpeg, image/webp, image/gif', 'User-Agent': UA } })
              try {
                if (response.status >= 300 && response.status < 400) {
                  if (response.headers.location && !secretCheck(response.headers.location)) throw imageSearchFailure()
                  return { status: response.status, headers: response.headers, body: new Uint8Array() }
                }
                const bytes = await readImageSearchBody(response, { ...context, signal }, IMAGE_BYTES)
                if (!secretCheck(bytes.toString('utf8'))) throw imageSearchFailure()
                return { status: response.status, headers: response.headers, body: bytes }
              } finally { await response.close?.() }
            },
          }
          const image = await readAgentPublicImage(url, context, dependencies), bytes = Buffer.from(image.base64, 'base64')
          if (bytes.length > IMAGE_BYTES || total + bytes.length > TOTAL_IMAGE_BYTES || !secretCheck(bytes.toString('utf8'))) continue
          await ensureAgentWebCurrent(context)
          total += bytes.length; images.push(image)
        } catch { await ensureAgentWebCurrent(context) }
      }
      await ensureAgentWebCurrent(context)
      return images
    },
  }
}
