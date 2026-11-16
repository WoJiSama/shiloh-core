import sharp from 'sharp'
import type { AgentMediaResourceContext } from '../../../contracts/agentMediaRelay.js'
import type { AgentPixivSearchItem, AgentPixivSearchResult } from './agentPixivSearchProvider.js'
import { pixivSearchFailure, pixivSearchGuard, pixivSearchId, pixivSearchOfficialUrl } from './agentPixivSearchHttp.js'

const MiB = 1024 * 1024, WIDTH = 1000, ROW = 142, HEADER = 128, FOOTER = 118, PIXELS = 16_000_000
export interface AgentPixivListRendererOptions {
  readonly allows: (value: string) => boolean
  readonly secretCheck: (value: string) => boolean
  readonly timeoutMs?: number
  thumbnail(item: AgentPixivSearchItem, guard: ReturnType<typeof pixivSearchGuard>): Promise<{ readonly mime: string; readonly bytes: Buffer }>
}
const escape = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
const short = (value: string, maximum: number): string => Array.from(value).length <= maximum ? value : Array.from(value).slice(0, maximum - 1).join('') + '…'
const count = (value: number): string => value >= 10000 ? `${(value / 10000).toFixed(1)}万` : String(value)
function rasterSignature(mime: string, bytes: Buffer): boolean {
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (mime === 'image/jpeg' || mime === 'image/jpg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (mime === 'image/gif') return ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))
  if (mime === 'image/webp') return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
  if (mime === 'image/avif') return bytes.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/u.test(bytes.toString('ascii', 8, 64))
  return false
}
function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).some(key => typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'))) throw pixivSearchFailure()
  return input as Record<string, unknown>
}
function checkedText(input: unknown, maximum: number, allows: (value: string) => boolean, required = false): string {
  if (typeof input !== 'string' || required && !input || Array.from(input).length > maximum || /[\u0000-\u001f\u007f]/u.test(input) || !allows(input)) throw pixivSearchFailure()
  return input
}
function number(input: unknown, maximum: number, minimum = 0): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < minimum || input > maximum) throw pixivSearchFailure()
  return input
}
/** Rendering accepts only a bounded value copy; caller objects cannot supply SVG or resource references. */
export function validateAgentPixivListResult(input: unknown, allows: (value: string) => boolean): AgentPixivSearchResult {
  const raw = object(input, ['keyword', 'mode', 'order', 'orderSource', 'total', 'artist', 'items'])
  const keyword = checkedText(raw.keyword, 80, allows, true)
  if (typeof raw.mode !== 'string' || typeof raw.order !== 'string' || typeof raw.orderSource !== 'string' || !['artworks', 'artist'].includes(raw.mode) || !['newest', 'oldest', 'popular'].includes(raw.order) || !['native', 'ranking', 'rerank'].includes(raw.orderSource) || !Array.isArray(raw.items) || !raw.items.length || raw.items.length > 24) throw pixivSearchFailure()
  const items = raw.items.map(value => {
    const item = object(value, ['id', 'title', 'userName', 'userId', 'pageCount', 'xRestrict', 'bookmarkCount', 'thumbUrl'])
    if (!pixivSearchId(item.id) || item.userId !== undefined && !pixivSearchId(item.userId)) throw pixivSearchFailure()
    const title = checkedText(item.title, 120, allows, true), userName = checkedText(item.userName, 60, allows)
    if (item.thumbUrl !== undefined && (typeof item.thumbUrl !== 'string' || !allows(item.thumbUrl))) throw pixivSearchFailure()
    const thumbUrl = item.thumbUrl === undefined ? undefined : pixivSearchOfficialUrl(item.thumbUrl as string, { kind: 'thumbnail', id: item.id }).href
    return { id: item.id, title, userName, ...(item.userId !== undefined ? { userId: item.userId as string } : {}), pageCount: number(item.pageCount, 2000, 1), ...(item.xRestrict !== undefined ? { xRestrict: number(item.xRestrict, 2) } : {}), ...(item.bookmarkCount !== undefined ? { bookmarkCount: number(item.bookmarkCount, Number.MAX_SAFE_INTEGER) } : {}), ...(thumbUrl ? { thumbUrl } : {}) }
  })
  if (new Set(items.map(item => item.id)).size !== items.length) throw pixivSearchFailure()
  let artist: AgentPixivSearchResult['artist']
  if (raw.artist !== undefined) { const data = object(raw.artist, ['userId', 'userName']); if (!pixivSearchId(data.userId)) throw pixivSearchFailure(); artist = { userId: data.userId, userName: checkedText(data.userName, 60, allows, true) } }
  if (raw.mode === 'artist' && !artist) throw pixivSearchFailure()
  return { keyword, mode: raw.mode as AgentPixivSearchResult['mode'], order: raw.order as AgentPixivSearchResult['order'], orderSource: raw.orderSource as AgentPixivSearchResult['orderSource'], total: number(raw.total, Number.MAX_SAFE_INTEGER), ...(artist ? { artist } : {}), items }
}

/** The SVG contains text and geometry only; downloaded pixels are composited separately. */
export function buildAgentPixivListSvg(result: AgentPixivSearchResult): string {
  const items = result.items.slice(0, 8), height = HEADER + items.length * ROW + FOOTER
  const labels = { newest: '按时间·最新', oldest: '按时间·最早', native: '按人气·全站收藏排序', ranking: '按人气·官方排行榜（日/周榜）匹配', rerank: '按近期人气（最新上传中收藏最多）' }
  const order = result.order === 'popular' ? labels[result.orderSource] : labels[result.order]
  const source = result.orderSource === 'ranking' ? '官方排行榜 ranking' : result.orderSource === 'rerank' ? '近期收藏重排 rerank' : '原生排序 native'
  const subtitle = result.mode === 'artist' ? `画师 ${result.artist?.userName ?? ''} 的最近作品 · 共 ${items.length} 张` : `共 ${count(result.total)} 个结果 · 展示前 ${items.length} 个`
  const text = (x: number, y: number, value: string, size = 22, fill = '#334155', weight = 400) => `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}">${escape(value)}</text>`
  const rows = items.map((item, index) => {
    const y = HEADER + index * ROW
    const meta = [item.userName || '未知画师', item.pageCount > 1 ? `${item.pageCount}P` : '', item.bookmarkCount !== undefined ? `♥ ${count(item.bookmarkCount)}` : '', item.xRestrict === 1 || item.xRestrict === 2 ? 'R-18' : item.xRestrict === undefined ? '受限标记未验证' : ''].filter(Boolean).join(' · ')
    const title = Array.from(item.title), titleLines = [title.slice(0, 28).join(''), title.slice(28, 55).join('') + (title.length > 55 ? '…' : '')].filter(Boolean)
    return `<rect x="20" y="${y + 4}" width="960" height="132" rx="12" fill="${index % 2 ? '#f0f5fa' : '#ffffff'}"/>` + text(38, y + 78, String(index + 1), 27, '#008ee6', 700) +
      `<rect x="86" y="${y + 15}" width="150" height="110" rx="8" fill="#e2e8f0"/>` + text(124, y + 77, item.xRestrict ? 'R-18' : '无图', 21, '#94a3b8') +
      titleLines.map((line, at) => text(258, y + 41 + at * 28, line, 23, '#111827', 600)).join('') + text(258, y + 101, short(meta, 43), 18, '#64748b') + text(807, y + 121, `ID ${item.id}`, 16, '#64748b')
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}"><rect width="${WIDTH}" height="${height}" rx="18" fill="#f8fafc"/><g font-family="PingFang SC,Microsoft YaHei,Noto Sans CJK SC,sans-serif">` +
    text(28, 39, `Pixiv ${result.mode === 'artist' ? '画师作品' : '搜索'}「${short(result.keyword, 30)}」`, 29, '#008ee6', 700) + text(28, 73, short(subtitle, 64), 20, '#64748b') + text(28, 103, `${order} · ${source}`, 18, '#64748b') + rows +
    text(28, height - 76, '回复「下载 序号」或「下载 作品ID」即可搬运对应作品', 21, '#334155') + text(28, height - 44, '列表保留5分钟，成功下载会续期；新搜索会替换当前列表。', 18, '#64748b') + text(28, height - 17, 'R-18作品默认不下载；未验证受限标记的作品不展示缩略图。', 17, '#94a3b8') + '</g></svg>'
}

export async function renderAgentPixivList(input: AgentPixivSearchResult, context: AgentMediaResourceContext, options: AgentPixivListRendererOptions): Promise<{ readonly mime: 'image/jpeg'; readonly base64: string }> {
  const guard = pixivSearchGuard(context, Math.min(55_000, options.timeoutMs ?? 55_000))
  try {
    const result = validateAgentPixivListResult(input, options.allows), items = result.items.slice(0, 8), composites: { input: Buffer; left: number; top: number }[] = []
    if (!options.secretCheck(JSON.stringify(result))) throw pixivSearchFailure()
    let next = 0
    await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
      while (next < items.length) {
        await guard.ensure(); if (next >= items.length) break
        const index = next++, item = items[index]!
        if (item.xRestrict !== 0 || !item.thumbUrl) continue
        for (let attempt = 0; attempt < 2; attempt++) {
          const own = pixivSearchGuard(guard.context, Math.min(12_000, options.timeoutMs ?? 12_000))
          try {
            const response = await options.thumbnail(item, own)
            if (!Buffer.isBuffer(response.bytes) || !response.bytes.length || response.bytes.length > 3 * MiB || !rasterSignature(response.mime, response.bytes) || !options.secretCheck(response.bytes.toString('utf8'))) throw pixivSearchFailure()
            const image = sharp(response.bytes, { limitInputPixels: PIXELS, animated: false, pages: 1, failOn: 'warning' }).timeout({ seconds: 5 })
            const metadata = await own.wait(image.metadata())
            const formats: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'heif' }
            if (!metadata.width || !metadata.height || metadata.width * metadata.height > PIXELS || metadata.format !== formats[response.mime]) throw pixivSearchFailure()
            const pixels = await own.wait(image.rotate().resize(150, 110, { fit: 'cover' }).removeAlpha().png().toBuffer())
            if (pixels.length > MiB) throw pixivSearchFailure()
            await own.ensure(); composites.push({ input: pixels, left: 86, top: HEADER + index * ROW + 15 }); break
          } catch { await guard.ensure() }
          finally { own.close() }
        }
      }
    }))
    await guard.ensure()
    const svg = buildAgentPixivListSvg(result)
    if (!options.secretCheck(svg)) throw pixivSearchFailure()
    const bytes = await guard.wait(sharp(Buffer.from(svg), { limitInputPixels: PIXELS }).timeout({ seconds: 5 }).composite(composites).jpeg({ quality: 88, chromaSubsampling: '4:4:4' }).toBuffer())
    if (!bytes.length || bytes.length > 3 * MiB || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9 || !options.secretCheck(bytes.toString('utf8'))) throw pixivSearchFailure()
    const metadata = await guard.wait(sharp(bytes, { limitInputPixels: PIXELS }).metadata())
    if (metadata.format !== 'jpeg' || metadata.width !== WIDTH || metadata.height !== HEADER + items.length * ROW + FOOTER) throw pixivSearchFailure()
    await guard.ensure(); return { mime: 'image/jpeg', base64: bytes.toString('base64') }
  } catch { throw pixivSearchFailure() }
  finally { guard.close() }
}
