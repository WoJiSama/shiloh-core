import type { AgentMediaArtifact, AgentMediaArtifactLease, AgentMediaRelayItem, AgentMediaResourceContext } from '../../../contracts/agentMediaRelay.js'
import type { AgentMediaRelayProvider, AgentMediaShare, AgentPreparedMediaRelay } from '../../../contracts/agentMediaRelayWorkflow.js'
import { createAgentSecretTextCheck } from '../../messaging/infrastructure/agentSecretText.js'
import { validateAgentMediaRelayPlan } from '../domain/agentMediaRelayPlan.js'
import type { AgentMediaArtifactStore } from './agentMediaArtifactStore.js'
import { bilibiliFailure, bilibiliGuard, bilibiliOfficialUrl, createBilibiliHttp } from './agentBilibiliRelayHttp.js'
import type { AgentBilibiliLookup, AgentBilibiliRequest } from './agentBilibiliRelayHttp.js'
import { parseAgentBilibiliReference, validateAgentMediaShare } from './agentBilibiliRelayReference.js'
import { prepareBilibiliThumbnail } from './agentBilibiliRelayThumbnail.js'
import type { AgentBilibiliThumbnail } from './agentBilibiliRelayThumbnail.js'

export type { AgentBilibiliLookup, AgentBilibiliRequest, AgentBilibiliResponse, AgentBilibiliRequestPolicy } from './agentBilibiliRelayHttp.js'
export type { AgentBilibiliThumbnail } from './agentBilibiliRelayThumbnail.js'
export interface AgentBilibiliRelayProviderOptions {
  readonly directory: string
  readonly artifacts: AgentMediaArtifactStore
  readonly authCookie?: string
  readonly autoAuthorizedRetry?: boolean
  readonly allowsText?: (text: string) => boolean
  readonly secrets?: readonly string[]
  readonly lookup?: AgentBilibiliLookup
  readonly request?: AgentBilibiliRequest
  readonly thumbnail?: AgentBilibiliThumbnail
  /** May shorten each API stage's 10s and download candidate's 10min deadlines. */
  readonly timeoutMs?: number
}
const META_BYTES = 2 * 1024 * 1024, IMAGE_BYTES = 32 * 1024 * 1024, VIDEO_BYTES = 512 * 1024 * 1024
const MAX_SECONDS = 1800, MAX_PARTS = 20
// One optional cover plus one owned video and JPEG thumbnail per segment must fit
// the artifact store's 128 descriptor limit. Text nodes do not consume artifacts.
const MAX_VIDEOS = Math.floor(128 / 2)
const row = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const list = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(row) : []
function positive(value: unknown): number {
  const number = typeof value === 'string' && /^\d{1,16}$/u.test(value) || typeof value === 'number' ? Number(value) : NaN
  if (!Number.isSafeInteger(number) || number <= 0) throw bilibiliFailure()
  return number
}
function nonnegative(value: unknown): number { const result = Number(value); if (!Number.isFinite(result) || result < 0) throw bilibiliFailure(); return result }
function display(value: unknown, maximum: number, fallback = ''): string {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string' || value.length > 32_768 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw bilibiliFailure()
  return Array.from(value.replace(/&amp;/giu, '&').replace(/&quot;/giu, '"').replace(/&lt;/giu, '<').replace(/&gt;/giu, '>').replace(/\s+/gu, ' ').trim()).slice(0, maximum).join('') || fallback
}
const durationText = (duration: number) => { const total = Math.round(duration); return total >= 3600 ? `${Math.floor(total / 3600)}:${String(Math.floor(total % 3600 / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}` : `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}` }
interface Part { page: number; cid: number; title: string; duration: number }
interface Metadata { id: string; episode: boolean; pageUrl: string; title: string; description: string; owner: string; duration: number; partCount: number; parts: Part[]; cover: string; published: number; stats: Record<string, number> }
interface Playback { resources: { url: string; backups: string[]; size: number; part: Part; index: number; quality: number; preview: boolean }[]; preview: boolean; login: boolean; restricted: boolean; overCapacity: boolean; notices: string[]; formats: string[] }

/** Official Bilibili protocol; URLs, credentials and private files stay inside this provider. */
export function createAgentBilibiliRelayProvider(options: AgentBilibiliRelayProviderOptions): AgentMediaRelayProvider {
  let cookie = '', timeout = 600_000
  const secrets = new Set<string>(options.secrets ?? [])
  try {
    if (typeof options.directory !== 'string' || !options.directory.startsWith('/') || !options.artifacts || typeof options.artifacts.stage !== 'function' || typeof options.artifacts.open !== 'function') throw bilibiliFailure()
    cookie = options.authCookie ?? ''
    if (typeof cookie !== 'string' || cookie.length > 32768 || /[^\x20-\x7e]/u.test(cookie)) throw bilibiliFailure()
    if (cookie) {
      secrets.add(cookie)
      for (const item of cookie.split(';')) {
        if (!item.trim()) continue
        const index = item.indexOf('='), key = item.slice(0, index).trim(), value = item.slice(index + 1).trim()
        if (index < 1 || !/^[A-Za-z0-9_]{1,100}$/u.test(key) || !value || /\s/u.test(value)) throw bilibiliFailure()
        secrets.add(value)
      }
    }
    if (options.timeoutMs !== undefined) { if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 600_000) throw bilibiliFailure(); timeout = options.timeoutMs }
  } catch { throw bilibiliFailure() }
  // SPI is the fixed credential-reception endpoint for anonymous device tokens.
  // It may repeat a previously learned buvid, but must still reject host/account secrets.
  const hostSecretCheck = createAgentSecretTextCheck([...secrets])
  const hostAllowed = (value: string): boolean => { try { return hostSecretCheck(value) && options.allowsText?.(value) !== false } catch { return false } }
  let secretCheck = createAgentSecretTextCheck([...secrets])
  const allowed = (value: string): boolean => { try { return secretCheck(value) && options.allowsText?.(value) !== false } catch { return false } }
  const safe = (value: string) => { if (!allowed(value)) throw bilibiliFailure(); return value }
  const inspect = (value: unknown, check = allowed) => {
    const pending = [{ value, depth: 0 }]; let visited = 0
    while (pending.length) {
      const next = pending.pop()!
      if (++visited > 40_000 || next.depth > 16) throw bilibiliFailure()
      if (typeof next.value === 'string') { if (next.value.length > 32_768 || !check(next.value)) throw bilibiliFailure() }
      else if (Array.isArray(next.value)) for (const value of next.value) pending.push({ value, depth: next.depth + 1 })
      else if (next.value && typeof next.value === 'object') for (const [key, value] of Object.entries(next.value)) { if (key.length > 256 || !check(key)) throw bilibiliFailure(); pending.push({ value, depth: next.depth + 1 }) }
    }
  }
  const read = createBilibiliHttp({ ...(options.lookup ? { lookup: options.lookup } : {}), ...(options.request ? { request: options.request } : {}), allows: allowed })
  let fingerprintCache = { value: '', expiresAt: 0 }
  async function json(url: string, context: AgentMediaResourceContext, auth = ''): Promise<Record<string, unknown>> {
    const guard = bilibiliGuard(context, Math.min(timeout, 10_000))
    let response: Awaited<ReturnType<typeof read>> | undefined
    try {
      response = await read(url, 'metadata', guard, META_BYTES, auth)
      if (response.mime !== 'application/json' && !response.mime.endsWith('+json')) throw bilibiliFailure()
      const chunks: Uint8Array[] = []; let size = 0
      for await (const bytes of response.chunks) { size += bytes.length; chunks.push(bytes) }
      const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))
      const responseAllowed = url === 'https://api.bilibili.com/x/frontend/finger/spi' ? hostAllowed : allowed
      if (!responseAllowed(raw)) throw bilibiliFailure()
      const payload = JSON.parse(raw)
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw bilibiliFailure()
      inspect(payload, responseAllowed); await guard.ensure(); return payload as Record<string, unknown>
    } catch { throw bilibiliFailure() } finally { await response?.close(); guard.close() }
  }
  async function fingerprint(context: AgentMediaResourceContext): Promise<string> {
    if (Date.now() < fingerprintCache.expiresAt) return fingerprintCache.value
    try {
      const payload = await json('https://api.bilibili.com/x/frontend/finger/spi', context), data = row(payload.data)
      if (payload.code !== 0 || typeof data.b_3 !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/u.test(data.b_3) || data.b_4 !== undefined && (typeof data.b_4 !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/u.test(data.b_4))) { fingerprintCache = { value: '', expiresAt: Date.now() + 60_000 }; return '' }
      for (const value of [data.b_3, data.b_4]) if (typeof value === 'string' && value) secrets.add(value)
      secretCheck = createAgentSecretTextCheck([...secrets])
      const value = `buvid3=${data.b_3}${data.b_4 ? `; buvid4=${data.b_4}` : ''}`
      fingerprintCache = { value, expiresAt: Date.now() + 24 * 60 * 60 * 1000 }; return value
    } catch { const guard = bilibiliGuard(context, Math.min(timeout, 10_000)); try { await guard.ensure(); fingerprintCache = { value: '', expiresAt: Date.now() + 60_000 }; return '' } finally { guard.close() } }
  }
  async function identify(share: AgentMediaShare, context: AgentMediaResourceContext): Promise<AgentMediaShare> {
    if (share.reference.kind !== 'short') return share
    const guard = bilibiliGuard(context, Math.min(timeout, 10_000)); let response: Awaited<ReturnType<typeof read>> | undefined
    try {
      response = await read(`https://b23.tv/${share.reference.id}`, 'share', guard, META_BYTES)
      const parsed = parseAgentBilibiliReference(response.url.href)
      if (!parsed || parsed.reference.kind === 'short') throw bilibiliFailure()
      await guard.ensure(); return parsed
    } finally { await response?.close(); guard.close() }
  }
  async function metadata(share: AgentMediaShare, context: AgentMediaResourceContext, buvid: string): Promise<Metadata> {
    const episode = share.reference.kind === 'episode', id = share.reference.id
    const url = episode ? `https://api.bilibili.com/pgc/view/web/season?ep_id=${id}` : `https://api.bilibili.com/x/web-interface/view?bvid=${id}`
    const payload = await json(url, context, buvid)
    if (payload.code !== 0) throw bilibiliFailure()
    const data = episode ? list(row(payload.result).episodes).find(item => String(item.id) === id) : row(payload.data)
    if (!data || !Object.keys(data).length || !episode && (typeof data.bvid !== 'string' || !/^BV[0-9A-Za-z]{8,16}$/iu.test(data.bvid) || `BV${data.bvid.slice(2)}` !== id)) throw bilibiliFailure()
    const rawParts = episode ? [{ page: 1, cid: data.cid, part: data.long_title ?? data.share_copy, duration: nonnegative(data.duration ?? 0) / 1000 }] : Array.isArray(data.pages) && data.pages.length ? list(data.pages) : [{ page: 1, cid: data.cid, part: data.title, duration: data.duration }]
    const partCount = episode ? 1 : positive(data.videos ?? rawParts.length)
    if (partCount !== rawParts.length) throw bilibiliFailure()
    const parts = rawParts.map(part => ({ page: positive(part.page), cid: positive(part.cid), title: display(part.part, 200, 'P1'), duration: nonnegative(part.duration ?? 0) }))
    if (new Set(parts.map(part => part.cid)).size !== parts.length) throw bilibiliFailure()
    const stats: Record<string, number> = {}
    for (const key of ['view', 'like', 'coin', 'share', 'reply', 'favorite', 'danmaku']) {
      const value = row(data.stat)[key]; if (value !== undefined) { const number = nonnegative(value); if (!Number.isSafeInteger(number)) throw bilibiliFailure(); stats[key] = number }
    }
    const cover = typeof (episode ? data.cover : data.pic) === 'string' ? String(episode ? data.cover : data.pic) : ''
    if (cover) bilibiliOfficialUrl(cover, 'image')
    const published = data.pubdate === undefined ? 0 : nonnegative(data.pubdate)
    if (published > 8_640_000_000_000 || published && !Number.isSafeInteger(published)) throw bilibiliFailure()
    return { id, episode, pageUrl: episode ? `https://www.bilibili.com/bangumi/play/ep${id}` : `https://www.bilibili.com/video/${id}`,
      title: display(episode ? data.long_title ?? data.share_copy : data.title, 300, 'B站视频'), description: display(data.desc === '-' ? '' : data.desc, 1000), owner: display(row(data.owner).name, 120),
      duration: episode ? nonnegative(data.duration ?? 0) / 1000 : nonnegative(data.duration ?? 0), partCount, parts, cover, published, stats }
  }
  async function playback(meta: Metadata, context: AgentMediaResourceContext, auth: string, capacity: number): Promise<Playback> {
    const result: Playback = { resources: [], preview: false, login: false, restricted: false, overCapacity: false, notices: [], formats: [] }
    for (const part of meta.parts) {
      const url = meta.episode ? `https://api.bilibili.com/pgc/player/web/playurl?ep_id=${meta.id}&cid=${part.cid}&qn=6&fnval=0&fourk=0`
        : `https://api.bilibili.com/x/player/playurl?bvid=${meta.id}&cid=${part.cid}&qn=6&fnval=0&fourk=0`
      const payload = await json(url, context, auth)
      if (payload.code !== 0) {
        const message = display(payload.message ?? row(payload.result).message, 80)
        result.login ||= /登录|未登录/iu.test(message)
        result.restricted ||= /地区|区域|版权|港澳台|海外/iu.test(message)
        result.notices.push(result.login ? 'B站播放接口要求登录后才能提供资源' : result.restricted ? 'B站播放接口受地区或版权限制，未提供资源' : 'B站播放接口未提供可下载资源')
        continue
      }
      const data = row(meta.episode ? payload.result : payload.data), durls = list(data.durl)
      const quality = data.quality === undefined ? 6 : positive(data.quality)
      if (quality > 127) throw bilibiliFailure()
      for (const format of list(data.support_formats)) {
        const qn = positive(format.quality); if (qn > 127) throw bilibiliFailure()
        const label = display(format.new_description ?? format.display_desc ?? format.format, 40, `qn=${qn}`)
        if (!result.formats.includes(label)) result.formats.push(label)
      }
      if (!durls.length) { result.notices.push('B站播放接口未提供可下载资源'); continue }
      if (durls.length > capacity || result.resources.length + durls.length > capacity) {
        result.overCapacity = true; result.resources.length = 0
        result.notices.push(`视频分段数超过${capacity}段资源容量上限，未附带视频本体`)
        return result
      }
      const preview = data.is_preview === true || data.is_preview === 1
      result.preview ||= preview
      if (preview) result.notices.push(`B站${meta.episode ? '番剧' : '视频'}仅提供约${durationText(durls.reduce((sum, item) => sum + nonnegative(item.length ?? 0), 0) / 1000)}试看，本体为试看片段`)
      for (const [index, item] of durls.entries()) {
        if (typeof item.url !== 'string') throw bilibiliFailure()
        bilibiliOfficialUrl(item.url, 'video')
        const backups = item.backup_url === undefined ? [] : Array.isArray(item.backup_url) && item.backup_url.length <= 8 ? item.backup_url.map(value => { if (typeof value !== 'string') throw bilibiliFailure(); bilibiliOfficialUrl(value, 'video'); return value }) : undefined
        if (!backups) throw bilibiliFailure()
        result.resources.push({ url: item.url, backups, size: nonnegative(item.size ?? 0), part, index, quality, preview })
      }
    }
    return result
  }
  async function download(urls: string[], kind: 'video' | 'image', context: AgentMediaResourceContext, auth = '', expectedSize = 0): Promise<AgentMediaArtifactLease> {
    for (const url of urls) {
      const guard = bilibiliGuard(context, timeout), maxBytes = kind === 'video' ? VIDEO_BYTES : IMAGE_BYTES
      let response: Awaited<ReturnType<typeof read>> | undefined
      try {
        response = await read(url, kind, guard, maxBytes, auth)
        const mime = response.mime === 'video/x-flv' || response.mime === 'video/flv' ? 'video/x-flv' : response.mime === 'image/jpg' ? 'image/jpeg' : response.mime
        if (kind === 'video' && !['video/mp4', 'video/quicktime', 'video/webm', 'video/x-flv'].includes(mime) || kind === 'image' && !['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'].includes(mime)) throw bilibiliFailure()
        const lease = await guard.wait(options.artifacts.stage({ kind, mime, chunks: response.chunks }, guard.context), late => late.release())
        try {
          await guard.ensure()
          if (expectedSize > 0 && lease.artifact.sizeBytes !== expectedSize) throw bilibiliFailure()
          return lease
        } catch { await lease.release(); throw bilibiliFailure() }
      } catch {
        const current = bilibiliGuard(context, Math.min(timeout, 10_000)); try { await current.ensure() } finally { current.close() }
      } finally { await response?.close(); guard.close() }
    }
    throw bilibiliFailure()
  }
  return Object.freeze({ async prepare(input: AgentMediaShare, context: AgentMediaResourceContext): Promise<AgentPreparedMediaRelay> {
    const owned = validateAgentMediaShare(input), leases: AgentMediaArtifactLease[] = []
    if (owned.provider !== 'bilibili') throw bilibiliFailure()
    const guard = bilibiliGuard(context, 90 * 60 * 1000)
    let transferred = false
    try {
      inspect(owned); await guard.ensure()
      const share = await identify(owned, guard.context), buvid = await fingerprint(guard.context)
      const meta = await metadata(share, guard.context, buvid)
      const lines = [`分享了B站${meta.episode ? '番剧' : '视频'}《${meta.title}》`, [meta.owner ? `UP:${meta.owner}` : '', meta.episode ? `ep${meta.id}` : meta.id,
        `时长:${durationText(meta.duration)}`, meta.partCount > 1 ? `${meta.partCount}个分P` : ''].filter(Boolean).join(' | ')]
      if (meta.published) lines.push(`发布日期:${new Date(meta.published * 1000).toISOString().slice(0, 10)}`)
      const statLabels: Record<string, string> = { view: '播放', like: '点赞', coin: '投币', favorite: '收藏', share: '转发', reply: '评论', danmaku: '弹幕' }
      const stats = Object.entries(statLabels).filter(([key]) => meta.stats[key] !== undefined).map(([key, label]) => `${label}:${meta.stats[key]}`)
      if (stats.length) lines.push(`数据：${stats.join(' ')}`)
      if (meta.description) lines.push(`简介：${meta.description}`)
      lines.push(`视频页面:${meta.pageUrl}`)
      let status: AgentPreparedMediaRelay['status'] = 'metadata-only'
      const mediaItems: AgentMediaRelayItem[] = []
      let cover: AgentMediaArtifact | undefined
      if (meta.cover) { try { const lease = await download([meta.cover], 'image', guard.context); leases.push(lease); cover = lease.artifact } catch { await guard.ensure(); lines.push('封面暂时获取失败') } }
      if (meta.duration > MAX_SECONDS) lines.push('视频超过30分钟，未附带视频本体')
      else if (meta.partCount > MAX_PARTS) lines.push(`视频共有${meta.partCount}个分P，超过20个分P上限，未附带视频本体`)
      else if (meta.duration <= 0) lines.push('视频时长未知，未附带视频本体')
      else {
        const capacity = cover ? MAX_VIDEOS - 1 : MAX_VIDEOS
        let play = await playback(meta, guard.context, buvid, capacity), authorized = false
        if (!play.overCapacity && cookie && options.autoAuthorizedRetry === true && (play.preview || play.login)) {
          play = await playback(meta, guard.context, [cookie, buvid].filter(Boolean).join('; '), capacity); authorized = true
        }
        lines.push(...new Set(play.notices))
        if (authorized && play.preview) { status = 'restricted'; lines.push('已使用授权账号复试，但B站仍只提供试看资源，未附带视频本体') }
        else if (!play.resources.length || play.notices.some(notice => !notice.includes('试看')) || play.resources.some(resource => resource.size > VIDEO_BYTES)) {
          status = play.restricted || play.login ? 'restricted' : 'metadata-only'
          if (play.resources.some(resource => resource.size > VIDEO_BYTES)) lines.push('单个视频超过512 MiB上限，未附带视频本体')
          else lines.push('B站未提供全部分P的可下载资源，已保留视频页面')
        } else {
          const videoLeases: AgentMediaArtifactLease[] = []
          try {
            for (const resource of play.resources) {
              await guard.ensure()
              const video = await download([resource.url, ...resource.backups], 'video', guard.context, authorized ? cookie : '', resource.size)
              leases.push(video); videoLeases.push(video)
              let thumbnail: AgentMediaArtifactLease | undefined
              try { thumbnail = await prepareBilibiliThumbnail(video.artifact, { directory: options.directory, artifacts: options.artifacts, guard, ...(options.thumbnail ? { thumbnail: options.thumbnail } : {}) }) }
              catch { await guard.ensure(); if (!lines.includes('视频预览图暂不可用')) lines.push('视频预览图暂不可用') }
              if (thumbnail) { leases.push(thumbnail); videoLeases.push(thumbnail) }
              mediaItems.push({ parts: [{ kind: 'video', artifact: video.artifact, ...(thumbnail ? { thumbnail: thumbnail.artifact } : {}) }] })
            }
            status = play.preview ? 'preview' : 'ready'
            if (play.formats.length) lines.push(`可选清晰度：${play.formats.join('、')}`)
            const qualities = [...new Set(play.resources.map(resource => resource.quality))]
            lines.push(`请求清晰度:qn=6；实际清晰度:${qualities.map(value => `qn=${value}`).join('、')}`)
          } catch { await guard.ensure(); mediaItems.length = 0; await Promise.allSettled(videoLeases.map(lease => lease.release())); lines.push('视频本体未完整获取，已保留视频页面') }
        }
      }
      const infoText = safe(lines.join('\n')), pageUrl = safe(meta.pageUrl)
      const plan = validateAgentMediaRelayPlan({ version: 1, items: [{ parts: [{ kind: 'text', text: infoText }, ...(cover ? [{ kind: 'image', artifact: cover } as const] : [])] }, ...mediaItems] }, { allowsText: allowed })
      await guard.ensure()
      let released: Promise<void> | undefined
      const result = Object.freeze({ status, pageUrl, infoText, plan, release() {
        return released ??= Promise.allSettled(leases.map(lease => lease.release())).then(() => {})
      } })
      transferred = true; return result
    } catch { throw bilibiliFailure() }
    finally { guard.close(); if (!transferred) await Promise.allSettled(leases.map(lease => lease.release())) }
  } })
}
