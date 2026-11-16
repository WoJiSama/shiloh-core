import { douyinFailure } from './agentDouyinRelayHttp.js'

export interface AgentDouyinResolvedMedia {
  readonly id: string
  readonly kind: 'video' | 'note'
  readonly title: string
  readonly description: string
  readonly author: string
  readonly duration: number
  readonly cover: string
  readonly video: string
  readonly images: readonly string[]
  readonly music: string
  readonly stats: Readonly<Record<string, number>>
}
const row = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const first = (input: unknown) => Array.isArray(input) ? input.find(value => typeof value === 'string' && /^https?:\/\//u.test(value)) as string | undefined ?? '' : ''
export function douyinDisplay(input: unknown, maximum: number): string {
  if (input === undefined || input === null || input === '') return ''
  if (typeof input !== 'string' || input.length > 32_768 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input)) throw douyinFailure()
  return Array.from(input.replace(/&amp;/giu, '&').replace(/&quot;/giu, '"').replace(/&lt;/giu, '<').replace(/&gt;/giu, '>').replace(/\s+/gu, ' ').trim()).slice(0, maximum).join('')
}
/** Bounded traversal selects the requested work, never the first recommended work. */
export function douyinTargetItem(input: unknown, id: string): Record<string, unknown> | undefined {
  const queue = [{ value: input, depth: 0 }], seen = new Set<object>()
  let visited = 0
  for (let at = 0; at < queue.length; at++) {
    const next = queue[at]!
    if (++visited > 40_000 || next.depth > 24) throw douyinFailure()
    if (!next.value || typeof next.value !== 'object' || seen.has(next.value)) continue
    seen.add(next.value)
    const value = row(next.value)
    if (String(value.aweme_id ?? '') === id && (value.desc !== undefined || value.video !== undefined || Array.isArray(value.images))) return value
    for (const child of Object.values(next.value)) if (child && typeof child === 'object') queue.push({ value: child, depth: next.depth + 1 })
    if (queue.length > 40_000) throw douyinFailure()
  }
  return undefined
}
function mediaUrl(input: unknown): string {
  if (typeof input !== 'string' || input.length > 8192 || /[\s\\\u0000-\u001f\u007f]/u.test(input)) return ''
  return input.startsWith('//') ? `https:${input}` : input.replace(/^http:\/\//u, 'https://')
}
export function douyinMetadata(input: unknown, id: string, kind: 'video' | 'note'): AgentDouyinResolvedMedia | undefined {
  const item = douyinTargetItem(input, id)
  if (!item) return undefined
  const video = row(item.video), author = row(item.author), music = row(row(item.music).play_url)
  const rawImages = Array.isArray(item.images) ? item.images : []
  if (rawImages.length > 2000) throw douyinFailure()
  const images = [...new Set(rawImages.map(image => mediaUrl(first(row(image).url_list))).filter(Boolean))]
  const actualKind = images.length || kind === 'note' ? 'note' : 'video'
  const rawDuration = video.duration !== undefined ? Number(video.duration) / 1000 : Number(item.duration ?? 0)
  const duration = Number.isFinite(rawDuration) && rawDuration >= 0 ? video.duration === undefined && rawDuration >= 10_000 ? rawDuration / 1000 : rawDuration : 0
  const statistics = row(item.statistics), stats: Record<string, number> = {}
  for (const key of ['play_count', 'digg_count', 'comment_count', 'share_count', 'collect_count']) {
    const value = Number(statistics[key]); if (Number.isSafeInteger(value) && value >= 0) stats[key] = value
  }
  return { id, kind: actualKind, title: douyinDisplay(item.desc, 300) || (actualKind === 'note' ? '抖音图文' : '抖音视频'),
    description: douyinDisplay(item.desc, 1000), author: douyinDisplay(author.nickname ?? author.name, 120), duration,
    cover: mediaUrl(first(row(video.cover).url_list) || first(row(video.origin_cover).url_list)),
    video: mediaUrl(first(row(video.play_addr ?? video.playAddr).url_list)), images,
    music: mediaUrl(first(music.url_list) || (typeof music.url === 'string' ? music.url : '')), stats }
}
function balanced(text: string, marker: string): unknown {
  const markerAt = text.indexOf(marker)
  if (markerAt < 0) return undefined
  const start = text.indexOf('{', markerAt + marker.length)
  if (start < 0) return undefined
  let depth = 0, quoted = false, escaped = false
  for (let at = start; at < text.length; at++) {
    const char = text[at]
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue }
    if (char === '"') quoted = true
    else if (char === '{') depth++
    else if (char === '}' && --depth === 0) { try { return JSON.parse(text.slice(start, at + 1)) } catch { return undefined } }
  }
  return undefined
}
export function douyinDocumentData(html: string): readonly unknown[] {
  if (typeof html !== 'string' || Buffer.byteLength(html) > 2 * 1024 * 1024) throw douyinFailure()
  const result: unknown[] = []
  for (const marker of ['window._ROUTER_DATA =', 'window._ROUTER_DATA=', 'window.__INITIAL_STATE__ =', 'window.__INITIAL_STATE__=']) {
    const value = balanced(html, marker); if (value) result.push(value)
  }
  for (const match of html.matchAll(/<script\b[^>]*\bid=["'](?:RENDER_DATA|__NEXT_DATA__)["'][^>]*>([\s\S]*?)<\/script\s*>/giu)) {
    try { result.push(JSON.parse(decodeURIComponent(match[1]!))) } catch { /* Another supported document encoding may work. */ }
  }
  return result
}
export function douyinDocumentMetadata(html: string, id: string, kind: 'video' | 'note'): AgentDouyinResolvedMedia | undefined {
  for (const value of douyinDocumentData(html)) { const item = douyinMetadata(value, id, kind); if (item) return item }
  return undefined
}
export function douyinCanonicalPage(id: string, kind: 'video' | 'note') { return `https://www.douyin.com/${kind}/${id}` }
export function douyinPageIdentity(url: URL): { id: string; kind: 'video' | 'note' } | undefined {
  if (!['douyin.com', 'www.douyin.com', 'iesdouyin.com', 'www.iesdouyin.com'].includes(url.hostname)) return undefined
  const match = /^\/(?:share\/)?(video|note)\/([1-9]\d{5,19})\/?$/u.exec(url.pathname)
  return match ? { kind: match[1] as 'video' | 'note', id: match[2]! } : undefined
}
