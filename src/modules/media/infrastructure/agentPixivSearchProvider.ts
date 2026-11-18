import type { AgentMediaResourceContext } from '../../../contracts/agentMediaRelay.js'
import { sanitizeFinalReplyText } from '../../conversation/domain/replySanitizer.js'
import { createAgentSecretTextCheck } from '../../messaging/infrastructure/agentSecretText.js'
import { normalizePixivCookie } from './agentPixivRelayHttp.js'
import type { AgentPixivLookup, AgentPixivRequest } from './agentPixivRelayHttp.js'
import { createPixivSearchHttp, pixivSearchFailure, pixivSearchGuard, pixivSearchId, pixivSearchMetadataUrl, pixivSearchOfficialUrl } from './agentPixivSearchHttp.js'
import type { PixivSearchHttpTarget } from './agentPixivSearchHttp.js'
import { renderAgentPixivList } from './agentPixivListRenderer.js'

export interface AgentPixivSearchInput { readonly keyword: string; readonly searchType?: 'artworks' | 'artist'; readonly orderBy?: 'newest' | 'oldest' | 'popular' }
export interface AgentPixivSearchItem { readonly id: string; readonly title: string; readonly userName: string; readonly userId?: string; readonly pageCount: number; readonly xRestrict?: number; readonly bookmarkCount?: number; readonly thumbUrl?: string }
export interface AgentPixivSearchResult {
  readonly keyword: string
  readonly mode: 'artworks' | 'artist'
  readonly order: 'newest' | 'oldest' | 'popular'
  readonly orderSource: 'native' | 'ranking' | 'rerank'
  readonly total: number
  readonly artist?: { readonly userId: string; readonly userName: string }
  readonly items: readonly AgentPixivSearchItem[]
}
export interface AgentPixivSearchProviderOptions {
  readonly authCookie?: string
  readonly proxyUrl?: string
  readonly secrets?: readonly string[]
  readonly allowsText?: (value: string) => boolean
  readonly lookup?: AgentPixivLookup
  readonly request?: AgentPixivRequest
  readonly timeoutMs?: number
}
export interface AgentPixivSearchProvider {
  search(input: AgentPixivSearchInput, context: AgentMediaResourceContext): Promise<AgentPixivSearchResult>
  renderList(result: AgentPixivSearchResult, context: AgentMediaResourceContext): Promise<{ readonly mime: 'image/jpeg'; readonly base64: string }>
}
const MiB = 1024 * 1024
const row = (input: unknown): Record<string, unknown> => input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
const integer = (input: unknown, maximum: number): number | undefined => { const n = typeof input === 'number' ? input : typeof input === 'string' && /^\d+$/u.test(input) ? Number(input) : NaN; return Number.isSafeInteger(n) && n >= 0 && n <= maximum ? n : undefined }
const normalized = (value: string) => value.toLowerCase().replace(/\s+/gu, '')
function clean(input: unknown, maximum: number): string {
  if (input === undefined || input === null || input === '') return ''
  if (typeof input !== 'string' || input.length > 32_768 || /[\u0000-\u001f\u007f]/u.test(input)) throw pixivSearchFailure()
  return Array.from(input.replace(/\s+/gu, ' ').trim()).slice(0, maximum).join('')
}
async function mapFour<T, R>(items: readonly T[], operation: (value: T) => Promise<R>, guard: ReturnType<typeof pixivSearchGuard>): Promise<R[]> {
  const results: R[] = []; let next = 0
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length) { await guard.ensure(); if (next >= items.length) break; const at = next++; results[at] = await operation(items[at]!) }
  }))
  return results
}
function closedObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) throw pixivSearchFailure()
  return value as Record<string, unknown>
}

export function createAgentPixivSearchProvider(options: AgentPixivSearchProviderOptions = {}): AgentPixivSearchProvider {
  if (!options || options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) || options.allowsText !== undefined && typeof options.allowsText !== 'function' || options.secrets !== undefined && (!Array.isArray(options.secrets) || options.secrets.length > 256 || options.secrets.some(value => typeof value !== 'string' || value.length > 32768))) throw pixivSearchFailure()
  const cookie = normalizePixivCookie(options.authCookie), secrets = [...options.secrets ?? [], ...(cookie ? [cookie, ...cookie.split(';').map(part => part.trim().split('=').slice(1).join('=')).filter(Boolean)] : [])]
  if (options.proxyUrl) { try { const proxy = new URL(options.proxyUrl); secrets.push(options.proxyUrl, proxy.href); for (const value of [proxy.username, proxy.password]) if (value) secrets.push(value, decodeURIComponent(value)) } catch { throw pixivSearchFailure() } }
  const secretCheck = createAgentSecretTextCheck(secrets)
  const allows = (value: string): boolean => { try { return secretCheck(value) && options.allowsText?.(value) !== false } catch { return false } }
  const safe = (value: string): boolean => sanitizeFinalReplyText(value) === value && allows(value)
  const read = createPixivSearchHttp({ ...(cookie ? { authCookie: cookie } : {}), ...(options.proxyUrl ? { proxyUrl: options.proxyUrl } : {}), ...(options.lookup ? { lookup: options.lookup } : {}), ...(options.request ? { request: options.request } : {}), allows })
  const duration = (maximum: number) => Math.min(maximum, options.timeoutMs ?? maximum)
  const normalizeItem = (input: unknown): AgentPixivSearchItem | undefined => {
    const value = row(input), id = typeof value.id === 'number' ? String(value.id) : value.id ?? value.illustId
    if (!pixivSearchId(id)) return undefined
    const title = clean(value.title ?? value.alt, 120) || '未命名作品', userName = clean(value.userName ?? row(value.user).name, 60)
    if (!safe(title) || !safe(userName)) return undefined
    const user = value.userId ?? row(value.user).id, userId = typeof user === 'number' ? String(user) : user
    const count = integer(value.pageCount, 2000), xRestrict = integer(value.xRestrict, 2), bookmarkCount = integer(value.bookmarkCount, Number.MAX_SAFE_INTEGER)
    let thumbUrl: string | undefined
    for (const candidate of [value.url, value.thumbUrl, row(value.urls).regular, row(value.urls).small, row(value.urls).original]) {
      if (typeof candidate !== 'string' || !allows(candidate)) continue
      try { thumbUrl = pixivSearchOfficialUrl(candidate, { kind: 'thumbnail', id }).href; break } catch {}
    }
    return Object.freeze({ id, title, userName, ...(pixivSearchId(userId) ? { userId } : {}), pageCount: count && count >= 1 ? count : 1, ...(xRestrict !== undefined ? { xRestrict } : {}), ...(bookmarkCount !== undefined ? { bookmarkCount } : {}), ...(thumbUrl ? { thumbUrl } : {}) })
  }
  return {
    async search(input, context) {
      let guard: ReturnType<typeof pixivSearchGuard> | undefined
      try {
        const data = closedObject(input, ['keyword', 'searchType', 'orderBy'])
        const keyword = clean(data.keyword, 80), mode = data.searchType ?? 'artworks', order = data.orderBy ?? 'newest'
        if (!keyword || !safe(keyword) || typeof mode !== 'string' || typeof order !== 'string' || !['artworks', 'artist'].includes(mode) || !['newest', 'oldest', 'popular'].includes(order)) throw pixivSearchFailure()
        const wantedMode = mode as AgentPixivSearchResult['mode'], wantedOrder = order as AgentPixivSearchResult['order']
        guard = pixivSearchGuard(context, duration(wantedMode === 'artist' ? 24_000 : 12_000)); const current = guard
        const json = async (target: Exclude<PixivSearchHttpTarget, { kind: 'thumbnail' }>): Promise<Record<string, unknown>> => {
          const response = await read(pixivSearchMetadataUrl(target), target, current, 2 * MiB)
          const content = new TextDecoder('utf-8', { fatal: true }).decode(response.bytes)
          if (!secretCheck(content)) throw pixivSearchFailure()
          const payload = row(JSON.parse(content))
          if (target.kind === 'ranking') return payload
          if (payload.error !== false || !payload.body || typeof payload.body !== 'object' || Array.isArray(payload.body)) throw pixivSearchFailure()
          return row(payload.body)
        }
        const nativeOrder = wantedOrder === 'popular' ? cookie ? 'popular_d' : 'date_d' : wantedOrder === 'oldest' ? 'date' : 'date_d'
        const body = await json({ kind: 'search', keyword, order: nativeOrder }), collection = Array.isArray(row(body.illustManga).data) ? row(body.illustManga) : row(body.illust)
        const raw = collection.data
        if (!Array.isArray(raw) || raw.length > 1000) throw pixivSearchFailure()
        let items = raw.map(normalizeItem).filter((value): value is AgentPixivSearchItem => value !== undefined)
        const seen = new Set<string>(); items = items.filter(item => !seen.has(item.id) && Boolean(seen.add(item.id)))
        if (!items.length) throw pixivSearchFailure()
        let total = integer(collection.total, Number.MAX_SAFE_INTEGER) ?? items.length, orderSource: AgentPixivSearchResult['orderSource'] = 'native'
        if (wantedOrder === 'popular' && !cookie) {
          const aliases = new Set([normalized(keyword)]), translations = Array.isArray(body.tagTranslation) ? body.tagTranslation.flatMap(entry => Object.entries(row(entry))) : Object.entries(row(body.tagTranslation))
          if (translations.length > 4000) throw pixivSearchFailure()
          for (const [tag, translation] of translations) {
            const ja = normalized(clean(tag, 80)), zh = normalized(clean(row(translation).zh, 80))
            if (ja && zh && [...aliases].some(alias => zh === alias || zh.includes(alias) || alias.includes(zh))) aliases.add(ja)
            if (aliases.size > 100) break
          }
          const pages = await mapFour([{ mode: 'daily', page: 1 }, { mode: 'daily', page: 2 }, { mode: 'weekly', page: 1 }, { mode: 'weekly', page: 2 }] as const, async ({ mode, page }) => {
            try {
              const ranking = await json({ kind: 'ranking', mode, page })
              if (!Array.isArray(ranking.contents) || ranking.contents.length > 1000) throw pixivSearchFailure()
              return ranking.contents.flatMap(value => {
                const entry = row(value), restriction = integer(entry.xRestrict ?? row(entry.illust_content_type).sexual, 2)
                const item = normalizeItem({ id: entry.illust_id, title: entry.title, userName: entry.user_name, userId: entry.user_id, pageCount: entry.illust_page_count ?? entry.pageCount ?? 1, xRestrict: restriction, url: entry.url, bookmarkCount: entry.rating_count })
                if (!item) return []
                const tags = Array.isArray(entry.tags) ? entry.tags.slice(0, 8).map(tag => clean(tag, 80)) : []
                const haystacks = [item.title, item.userName, ...tags].map(normalized).filter(Boolean)
                const hit = haystacks.some(text => [...aliases].some(alias => text.includes(alias) || alias.length >= 2 && text.length >= 2 && alias.includes(text)))
                return hit ? [item] : []
              })
            } catch { await current.ensure(); return [] }
          }, current)
          const rankingIds = new Set<string>(), ranking = pages.flat().filter(item => !rankingIds.has(item.id) && Boolean(rankingIds.add(item.id))).sort((a, b) => (b.bookmarkCount ?? 0) - (a.bookmarkCount ?? 0))
          const reranked = (await mapFour(items.slice(0, 24), async item => {
            try {
              const detail = await json({ kind: 'detail', id: item.id })
              if (String(detail.id) !== item.id) throw pixivSearchFailure()
              const bookmarkCount = integer(detail.bookmarkCount, Number.MAX_SAFE_INTEGER)
              if (bookmarkCount === undefined) throw pixivSearchFailure()
              const restriction = integer(detail.xRestrict, 2), { xRestrict: _previousRestriction, ...base } = item
              return Object.freeze({ ...base, bookmarkCount, ...(restriction !== undefined ? { xRestrict: restriction } : {}) })
            } catch { await current.ensure(); return undefined }
          }, current)).filter((value): value is AgentPixivSearchItem & { bookmarkCount: number } => value !== undefined).sort((a, b) => b.bookmarkCount - a.bookmarkCount)
          if (ranking.length) { items = [...ranking.slice(0, 24), ...reranked.filter(item => !rankingIds.has(item.id))].slice(0, 24); total = ranking.length; orderSource = 'ranking' }
          else if (reranked.length) { items = reranked; total = Math.min(total, 24); orderSource = 'rerank' }
        }
        if (wantedMode === 'artist') {
          const matches = new Map<string, { userId: string; userName: string; hits: number }>(), word = keyword.toLowerCase()
          for (const item of items) {
            if (!item.userId || !item.userName || !item.userName.toLowerCase().includes(word) && !word.includes(item.userName.toLowerCase())) continue
            const match = matches.get(item.userId) ?? { userId: item.userId, userName: item.userName, hits: 0 }; match.hits++; matches.set(item.userId, match)
          }
          const artist = [...matches.values()].sort((a, b) => b.hits - a.hits)[0]
          if (artist) {
            const profile = await json({ kind: 'profile', userId: artist.userId }), ids = Object.keys(row(profile.illusts)).filter(pixivSearchId).sort((a, b) => Number(b) - Number(a)).slice(0, 16)
            if (!ids.length) throw pixivSearchFailure()
            const recent = (await mapFour(ids, async id => {
              try {
                const detail = await json({ kind: 'detail', id })
                if (String(detail.id) !== id || String(detail.userId) !== artist.userId) throw pixivSearchFailure()
                return normalizeItem(detail)
              } catch { await current.ensure(); return undefined }
            }, current)).filter((item): item is AgentPixivSearchItem => item !== undefined).slice(0, 8)
            if (!recent.length) throw pixivSearchFailure()
            await current.ensure()
            return Object.freeze({ keyword, mode: 'artist', order: 'newest', orderSource: 'native', total: recent.length, artist: Object.freeze({ userId: artist.userId, userName: artist.userName }), items: Object.freeze(recent) })
          }
        }
        await current.ensure()
        return Object.freeze({ keyword, mode: 'artworks', order: wantedOrder, orderSource, total, items: Object.freeze(items.slice(0, 24)) })
      } catch { throw pixivSearchFailure() }
      finally { guard?.close() }
    },
    async renderList(result, context) {
      return renderAgentPixivList(result, context, { allows: safe, secretCheck, timeoutMs: duration(55_000), async thumbnail(item, current) {
        if (!item.thumbUrl) throw pixivSearchFailure()
        const response = await read(item.thumbUrl, { kind: 'thumbnail', id: item.id }, current, 3 * MiB)
        if (!secretCheck(response.bytes.toString('utf8'))) throw pixivSearchFailure()
        return response
      } })
    },
  }
}
