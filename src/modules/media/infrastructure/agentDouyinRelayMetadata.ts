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
export function hasDouyinMedia(metadata: AgentDouyinResolvedMedia | undefined): boolean {
  return !!metadata && (metadata.kind === 'note' ? metadata.images.length > 0 : !!metadata.video && metadata.duration > 0)
}
const row = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const first = (input: unknown) => Array.isArray(input) ? input.find(value => typeof value === 'string' && /^https?:\/\//u.test(value)) as string | undefined ?? '' : ''
const firstUrl = (value: unknown) => { const source = row(value); return first(source.url_list ?? source.urlList) }
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
    if (String(value.aweme_id ?? value.awemeId ?? '') === id && (value.desc !== undefined || value.description !== undefined ||
        value.video !== undefined || Array.isArray(value.images))) return value
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
  const video = row(item.video), author = row(item.author), soundtrack = row(item.music), music = row(soundtrack.play_url ?? soundtrack.playUrl)
  const rawImages = Array.isArray(item.images) ? item.images : []
  if (rawImages.length > 2000) throw douyinFailure()
  const images = [...new Set(rawImages.map(image => mediaUrl(firstUrl(image))).filter(Boolean))]
  const actualKind = images.length || kind === 'note' ? 'note' : 'video'
  const rawDuration = video.duration !== undefined ? Number(video.duration) / 1000 : Number(item.duration ?? 0)
  const duration = Number.isFinite(rawDuration) && rawDuration >= 0 ? video.duration === undefined && rawDuration >= 10_000 ? rawDuration / 1000 : rawDuration : 0
  const statistics = row(item.statistics), stats: Record<string, number> = {}
  for (const key of ['play_count', 'digg_count', 'comment_count', 'share_count', 'collect_count']) {
    const value = Number(statistics[key]); if (Number.isSafeInteger(value) && value >= 0) stats[key] = value
  }
  const description = item.desc ?? item.description
  return { id, kind: actualKind, title: douyinDisplay(description, 300) || (actualKind === 'note' ? '抖音图文' : '抖音视频'),
    description: douyinDisplay(description, 1000), author: douyinDisplay(author.nickname ?? author.name, 120), duration,
    cover: mediaUrl(firstUrl(video.cover) || firstUrl(video.origin_cover ?? video.originCover)),
    video: mediaUrl(firstUrl(video.play_addr ?? video.playAddr)), images,
    music: mediaUrl(firstUrl(music) || (typeof music.url === 'string' ? music.url : '')), stats }
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
    const data = match[1]!
    try { result.push(JSON.parse(data)); continue } catch { /* Some pages percent-encode the JSON. */ }
    try { result.push(JSON.parse(decodeURIComponent(data))) } catch { /* Another supported document encoding may work. */ }
  }
  return result
}
/** A fragment is a JSON string literal in a known inline call. Script code is never evaluated here. */
function* desktopWorkRecords(html: string, id: string): Generator<unknown> {
  if (!html.includes('self.__pace_f.push(')) return
  const fragments: string[] = []
  for (const [, body] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/giu)) {
    const literal = /^\s*self\.__pace_f\.push\((\[[\s\S]*\])\);?\s*$/u.exec(body!)?.[1]
    if (!literal) continue
    let args: unknown
    try { args = JSON.parse(literal) } catch { return }
    if (Array.isArray(args) && args.length === 2 && args[0] === 1 && typeof args[1] === 'string') fragments.push(args[1])
  }
  const stream = Buffer.from(fragments.join(''), 'utf8')
  for (let start = 0; start < stream.length;) {
    const header = stream.toString('latin1', start, start + 28)
    const prefix = /^[\da-f]{1,10}:/iu.exec(header)?.[0]
    if (!prefix) return
    const at = start + prefix.length
    // React Flight sends long strings and binary records with a hexadecimal byte count.
    if (/^[TAOoUSsLlGgMmV]/u.test(header.slice(prefix.length))) {
      const sizeTag = /^[TAOoUSsLlGgMmV]([\da-f]{1,8}),/iu.exec(header.slice(prefix.length))
      if (!sizeTag) return
      start = at + sizeTag[0].length + Number.parseInt(sizeTag[1]!, 16)
      if (start > stream.length) return
      continue
    }
    const eol = stream.indexOf(10, at)
    const end = eol === -1 ? stream.length : eol
    start = end + 1
    if (stream[at] !== 91 && stream[at] !== 123) continue
    const data = stream.toString('utf8', at, end)
    if (!data.includes(id)) continue
    try { yield JSON.parse(data) } catch { /* A different Flight record carries no usable work. */ }
  }
}

function* desktopWorkProps(input: unknown, id: string): Generator<Record<string, unknown>> {
  const pending = [input]
  for (let at = 0; at < pending.length && pending.length <= 40_000; at++) {
    const value = pending[at]
    if (Array.isArray(value)) {
      if (value[0] === '$') pending.push(value[3])
      else for (const child of value) if (child && typeof child === 'object') pending.push(child)
    } else {
      const props = row(value)
      if (props.awemeId === id && typeof props.statusCode === 'number' && Object.hasOwn(props, 'aweme')) yield props
      if (props.children && typeof props.children === 'object') pending.push(props.children)
    }
  }
}

export type DouyinDocumentIssue = 'douyin_page_verification_required' | 'douyin_page_work_empty' |
  'douyin_page_metadata_incomplete' | 'douyin_page_target_missing'

export function inspectDouyinDocument(html: string, id: string, kind: 'video' | 'note'): {
  metadata?: AgentDouyinResolvedMedia
  issue?: DouyinDocumentIssue
  nativeCode?: number
} {
  let incomplete: AgentDouyinResolvedMedia | undefined
  for (const value of douyinDocumentData(html)) {
    const metadata = douyinMetadata(value, id, kind)
    if (metadata && hasDouyinMedia(metadata)) return { metadata }
    incomplete ??= metadata
  }
  let emptyWork: { nativeCode: number } | undefined
  for (const record of desktopWorkRecords(html, id)) for (const props of desktopWorkProps(record, id)) {
    const status = Number(props.statusCode)
    if (!Number.isSafeInteger(status) || status < 0 || status > 1_000_000_000) continue
    const work = row(props.aweme)
    // The route and the actual media object must both identify the requested work.
    const matches = (work.aweme_id ?? work.awemeId) === id
    if (status === 0 && matches) {
      const metadata = douyinMetadata(work, id, kind)
      if (metadata && hasDouyinMedia(metadata)) return { metadata }
      incomplete ??= metadata
    } else if (props.aweme === null || status !== 0) emptyWork ??= { nativeCode: status }
  }
  if (incomplete) return { metadata: incomplete, issue: 'douyin_page_metadata_incomplete' }
  if (emptyWork) return { issue: 'douyin_page_work_empty', ...emptyWork }
  if (html.includes('__ac_nonce') && html.includes('document.cookie') && /\blocation\s*\.\s*reload\s*\(/u.test(html)) {
    return { issue: 'douyin_page_verification_required' }
  }
  return { issue: 'douyin_page_target_missing' }
}

export function douyinDocumentMetadata(html: string, id: string, kind: 'video' | 'note'): AgentDouyinResolvedMedia | undefined {
  return inspectDouyinDocument(html, id, kind).metadata
}
export function douyinCanonicalPage(id: string, kind: 'video' | 'note') { return `https://www.douyin.com/${kind}/${id}` }
export function douyinPageIdentity(url: URL): { id: string; kind: 'video' | 'note' } | undefined {
  if (!['douyin.com', 'www.douyin.com', 'iesdouyin.com', 'www.iesdouyin.com'].includes(url.hostname)) return undefined
  const match = /^\/(?:share\/)?(video|note)\/([1-9]\d{5,19})\/?$/u.exec(url.pathname)
  return match ? { kind: match[1] as 'video' | 'note', id: match[2]! } : undefined
}
