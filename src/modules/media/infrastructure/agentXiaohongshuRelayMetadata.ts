import { xiaohongshuFailure } from './agentXiaohongshuRelayHttp.js'

export interface AgentXiaohongshuResolvedMedia {
  readonly id: string
  readonly kind: 'image' | 'video'
  readonly title: string
  readonly description: string
  readonly author: string
  readonly duration: number
  readonly cover: string
  readonly video: string
  /** Original slots are retained, including absent images, to align live photographs. */
  readonly images: readonly string[]
  readonly livePhotos: readonly string[]
  readonly stats: Readonly<Record<string, number>>
}
const row = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export function xiaohongshuDisplay(input: unknown, maximum: number): string {
  if (input === undefined || input === null || input === '') return ''
  if (typeof input !== 'string' || input.length > 32_768 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input)) throw xiaohongshuFailure()
  return Array.from(input.replace(/&amp;/giu, '&').replace(/&quot;/giu, '"').replace(/&lt;/giu, '<').replace(/&gt;/giu, '>').replace(/\r\n?/gu, '\n').trim()).slice(0, maximum).join('')
}
export function xiaohongshuMediaUrl(input: unknown): string {
  if (typeof input !== 'string' || !input || input.length > 8192 || /[\s\\\u0000-\u001f\u007f]/u.test(input)) return ''
  return input.startsWith('//') ? `https:${input}` : input.replace(/^http:\/\//iu, 'https://')
}
/** Bounded traversal accepts the target map key or an explicit note identity, never the first entry. */
export function xiaohongshuTargetNote(input: unknown, id: string): Record<string, unknown> | undefined {
  const queue = [{ value: input, depth: 0 }], seen = new Set<object>()
  for (let at = 0; at < queue.length; at++) {
    const next = queue[at]!
    if (at > 40_000 || next.depth > 24) throw xiaohongshuFailure()
    if (!next.value || typeof next.value !== 'object' || seen.has(next.value)) continue
    seen.add(next.value)
    const object = row(next.value), map = row(object.noteDetailMap)
    for (const [key, value] of Object.entries(map)) if (key.toLowerCase() === id) {
      const note = row(row(value).note), explicit = note.noteId ?? note.note_id
      if (explicit !== undefined && (typeof explicit !== 'string' || explicit.toLowerCase() !== id)) throw xiaohongshuFailure()
      if (Object.keys(note).length) return note
    }
    const explicit = object.noteId ?? object.note_id
    if (typeof explicit === 'string' && explicit.toLowerCase() === id && (object.desc !== undefined || object.title !== undefined || Array.isArray(object.imageList))) return object
    for (const child of Object.values(next.value)) if (child && typeof child === 'object') queue.push({ value: child, depth: next.depth + 1 })
    if (queue.length > 40_000) throw xiaohongshuFailure()
  }
  return undefined
}
function videoStream(input: unknown): { url: string; duration: number } {
  const queue = [{ value: input, depth: 0, codec: '' }], seen = new Set<object>()
  let best: { url: string; duration: number; rank: number } | undefined, duration = 0
  const ranks: Readonly<Record<string, number>> = { h264: 0, av1: 1, h265: 2, h266: 3 }
  for (let at = 0; at < queue.length; at++) {
    const next = queue[at]!
    if (at > 10_000 || next.depth > 16) throw xiaohongshuFailure()
    if (!next.value || typeof next.value !== 'object' || seen.has(next.value)) continue
    seen.add(next.value)
    const object = row(next.value)
    const rawDuration = Number(object.duration ?? 0)
    const ownDuration = object.videoDuration !== undefined ? Number(object.videoDuration) / 1000 : object.duration_ms !== undefined ? Number(object.duration_ms) / 1000 : rawDuration > 100_000 ? rawDuration / 1000 : rawDuration
    if (Number.isFinite(ownDuration) && ownDuration > 0 && !duration) duration = ownDuration
    const candidates = [object.masterUrl, object.master_url, object.playUrl, object.play_url, ...(Array.isArray(object.backupUrls) ? object.backupUrls : [])]
    for (const candidate of candidates) {
      const url = xiaohongshuMediaUrl(candidate)
      if (!/^https:\/\/sns-(?:video|bak)[a-z0-9-]*\.xhscdn\.com\/[^#]*\.mp4(?:\?|$)/iu.test(url)) continue
      const rank = ranks[next.codec] ?? 9
      if (!best || rank < best.rank) best = { url, rank, duration: Number.isFinite(ownDuration) && ownDuration > 0 ? ownDuration : 0 }
    }
    for (const [key, child] of Object.entries(next.value)) if (child && typeof child === 'object') queue.push({ value: child, depth: next.depth + 1, codec: Object.hasOwn(ranks, key.toLowerCase()) ? key.toLowerCase() : next.codec })
    if (queue.length > 10_000) throw xiaohongshuFailure()
  }
  return { url: best?.url ?? '', duration: best?.duration || duration }
}
function count(input: unknown): number | undefined {
  const text = String(input ?? '').trim(), match = /^([0-9]+(?:\.[0-9]+)?)万$/u.exec(text)
  const value = match ? Math.round(Number(match[1]) * 10_000) : /^\d+$/u.test(text) ? Number(text) : NaN
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}
export function xiaohongshuMetadata(input: unknown, id: string, hint?: 'image' | 'video'): AgentXiaohongshuResolvedMedia | undefined {
  const note = xiaohongshuTargetNote(input, id)
  if (!note) return undefined
  const rawImages = Array.isArray(note.imageList) ? note.imageList : []
  if (rawImages.length > 2000) throw xiaohongshuFailure()
  const images: string[] = [], livePhotos: string[] = []
  for (const raw of rawImages) {
    const image = row(raw), info = Array.isArray(image.infoList) ? image.infoList : []
    images.push(xiaohongshuMediaUrl(row(info[0]).url || image.urlDefault || image.url))
    livePhotos.push(image.livePhoto === true ? videoStream(image.stream).url : '')
  }
  const video = row(note.video), stream = videoStream(Object.keys(video).length ? video : note.videoData)
  // An explicit image hint or normal note always prevents a live-photo stream becoming the main video.
  const kind = hint === 'image' || note.type === 'normal' ? 'image' : note.type === 'video' || hint === 'video' ? 'video' : images.length ? 'image' : 'video'
  const stats: Record<string, number> = {}, interact = row(note.interactInfo)
  for (const [key, raw] of Object.entries({ liked: interact.liked ?? interact.likedCount, collected: interact.collected ?? interact.collectedCount, comments: interact.commentCount })) {
    const value = count(raw); if (value !== undefined) stats[key] = value
  }
  return { id, kind, title: xiaohongshuDisplay(note.title, 300) || '小红书笔记', description: xiaohongshuDisplay(note.desc, 2000),
    author: xiaohongshuDisplay(row(note.user).nickname, 120), duration: stream.duration, video: kind === 'video' ? stream.url : '', images, livePhotos,
    cover: images.find(Boolean) || xiaohongshuMediaUrl(row(video.image).firstFrameUrl), stats }
}
/** Replace only the undefined value literal outside strings; SSR data is never evaluated as code. */
function parseState(raw: string): unknown {
  let result = '', quoted = false, escaped = false
  for (let at = 0; at < raw.length; at++) {
    const char = raw[at]!
    if (quoted) { result += char; if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue }
    if (char === '"') { quoted = true; result += char; continue }
    if (raw.startsWith('undefined', at) && /[\s,:\[]/u.test(raw[at - 1] ?? '') && /[\s,}\]]/u.test(raw[at + 9] ?? '')) { result += 'null'; at += 8 } else result += char
  }
  return JSON.parse(result)
}
export function xiaohongshuDocumentMetadata(html: string, id: string, hint?: 'image' | 'video'): AgentXiaohongshuResolvedMedia | undefined {
  if (typeof html !== 'string' || Buffer.byteLength(html) > 2 * 1024 * 1024) throw xiaohongshuFailure()
  const marker = /window\.__INITIAL_STATE__\s*=\s*/gu
  for (const match of html.matchAll(marker)) {
    const start = match.index + match[0].length
    if (html[start] !== '{') continue
    let depth = 0, quoted = false, escaped = false
    for (let at = start; at < html.length; at++) {
      const char = html[at]
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue }
      if (char === '"') quoted = true
      else if (char === '{') depth++
      else if (char === '}' && --depth === 0) {
        try { const value = xiaohongshuMetadata(parseState(html.slice(start, at + 1)), id, hint); if (value) return value } catch { /* Another state script can supply the target. */ }
        break
      }
    }
  }
  return undefined
}
export const xiaohongshuCanonicalPage = (id: string) => `https://www.xiaohongshu.com/explore/${id}`
export function xiaohongshuPageIdentity(url: URL): string | undefined {
  return ['xiaohongshu.com', 'www.xiaohongshu.com'].includes(url.hostname) ? /^\/(?:explore|discovery\/item)\/([a-f0-9]{16,32})\/?$/iu.exec(url.pathname)?.[1]?.toLowerCase() : undefined
}
export function xiaohongshuUnsignedImage(input: string): string {
  try {
    const url = new URL(input)
    if (url.hostname === 'ci.xiaohongshu.com') return xiaohongshuUnsignedImage(decodeURIComponent(url.pathname.replace(/^\/+/, '')))
    if (!/^sns-(?:webpic|img|video)[a-z0-9-]*\.xhscdn\.com$/u.test(url.hostname)) return ''
    const id = url.pathname.split('/').map(part => part.split('!', 1)[0]!).find(part => /^10[a-z0-9]{18,}$/iu.test(part))
    return id ? `https://sns-img-qc.xhscdn.com/${id}` : ''
  } catch { return '' }
}
