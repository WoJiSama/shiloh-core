import path from 'node:path'
import { lstat, realpath } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { StringDecoder } from 'node:string_decoder'
import type { AgentMediaArtifactLease, AgentMediaRelayItem } from '../../../contracts/agentMediaRelay.js'
import type { AgentMediaRelayProvider, AgentPreparedMediaRelay } from '../../../contracts/agentMediaRelayWorkflow.js'
import { sanitizeFinalReplyText } from '../../conversation/domain/replySanitizer.js'
import { createAgentSecretTextCheck } from '../../messaging/infrastructure/agentSecretText.js'
import type { AgentDiagnostics } from '../../runtime/infrastructure/agentDiagnostics.js'
import { firstAgentMediaRelayImage, validateAgentMediaRelayPlan } from '../domain/agentMediaRelayPlan.js'
import type { AgentMediaArtifactStore } from './agentMediaArtifactStore.js'
import { stageAgentMediaRelayCard } from './agentMediaRelayCard.js'
import { validateAgentMediaShare, agentMediaSharePageUrl } from './agentMediaRelayReference.js'
import { parseAgentYoutubeReference } from './agentYoutubeRelayReference.js'
import { createYoutubeHttp, youtubeCookieSecrets, youtubeFailure, youtubeGuard, youtubeOfficialUrl } from './agentYoutubeRelayHttp.js'
import type { AgentYoutubeLookup, AgentYoutubeRequest } from './agentYoutubeRelayHttp.js'
import { runAgentYoutubeMetadata } from './agentYoutubeRelayNative.js'
import type { AgentYoutubeNative } from './agentYoutubeRelayNative.js'
import { prepareBilibiliThumbnail, type AgentBilibiliThumbnail } from './agentBilibiliRelayThumbnail.js'

export type { AgentYoutubeLookup, AgentYoutubeRequest, AgentYoutubeResponse, AgentYoutubeRequestPolicy } from './agentYoutubeRelayHttp.js'
export type { AgentYoutubeNative, AgentYoutubeNativeOptions } from './agentYoutubeRelayNative.js'
export type AgentYoutubeThumbnail = AgentBilibiliThumbnail
export interface AgentYoutubeRelayProviderOptions {
  readonly directory: string
  readonly artifacts: AgentMediaArtifactStore
  readonly authCookie?: string
  readonly poToken?: string
  /** Explicit host proxy; target DNS is still validated locally and pinned. */
  readonly proxyUrl?: string
  readonly secrets?: readonly string[]
  readonly allowsText?: (text: string) => boolean
  readonly lookup?: AgentYoutubeLookup
  readonly request?: AgentYoutubeRequest
  readonly native?: AgentYoutubeNative
  readonly thumbnail?: AgentYoutubeThumbnail
  readonly diagnostics?: Pick<AgentDiagnostics, 'emit'>
  /** May only shorten preparation and stage deadlines. */
  readonly timeoutMs?: number
}
const MiB = 1024 * 1024, VIDEO_BYTES = 512 * MiB, COVER_BYTES = 8 * MiB
const imageMimes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'])
const row = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
function text(value: unknown, limit: number, fallback = ''): string {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw youtubeFailure()
  return Array.from(value.replace(/\s+/gu, ' ').trim()).slice(0, limit).join('').trimEnd() || fallback
}
const durationText = (seconds: number) => {
  const total = Math.round(seconds), minutes = Math.floor(total / 60)
  return total >= 3600 ? `${Math.floor(total / 3600)}:${String(minutes % 60).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}` : `${minutes}:${String(total % 60).padStart(2, '0')}`
}
function failureReason(error: unknown): string {
  switch (row(error).code) {
    case 'youtube_downloader_unavailable': return 'YouTube 下载器 yt-dlp 未安装或不在 PATH 中'
    case 'youtube_access_required': return '该 YouTube 视频需要账号 Cookie、会员资格或访问验证'
    case 'youtube_region_restricted': return '该 YouTube 视频受地区限制'
    case 'youtube_metadata_timeout': return 'YouTube 视频详情请求超时'
    default: return 'YouTube 视频详情暂时获取失败'
  }
}

/** yt-dlp extracts a fixed video; Core downloads bytes and produces the neutral plan. */
export function createAgentYoutubeRelayProvider(options: AgentYoutubeRelayProviderOptions): AgentMediaRelayProvider {
  if (!options || typeof options.directory !== 'string' || !path.isAbsolute(options.directory) || !options.artifacts ||
      typeof options.artifacts.stage !== 'function' || typeof options.artifacts.open !== 'function' || options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 900_000)) throw youtubeFailure()
  const cookie = options.authCookie ?? '', token = options.poToken ?? '', secrets = [...(options.secrets ?? [])]
  if (typeof cookie !== 'string' ||
      typeof token !== 'string' || token.length > 8192 || token && !/^[A-Za-z0-9_+./=-]+$/u.test(token)) throw youtubeFailure()
  secrets.push(...youtubeCookieSecrets(cookie))
  if (token) secrets.push(token)
  if (options.proxyUrl) {
    secrets.push(options.proxyUrl)
    try { const proxy = new URL(options.proxyUrl); for (const value of [proxy.username, proxy.password]) if (value) secrets.push(value, decodeURIComponent(value)) } catch { throw youtubeFailure() }
  }
  const checkSecrets = createAgentSecretTextCheck(secrets)
  const allows = (value: string) => { try { return checkSecrets(value) && options.allowsText?.(value) !== false } catch { return false } }
  // The configured PO token is an authorized query credential only in its exact
  // Google video playback field. It cannot become a header, text or another URL.
  const allowsMediaUrl = (value: string): boolean => {
    if (allows(value)) return true
    if (!token) return false
    try {
      const url = youtubeOfficialUrl(value, 'video')
      if (url.pathname !== '/videoplayback' || url.searchParams.getAll('pot').length !== 1 || url.searchParams.get('pot') !== token) return false
      url.searchParams.delete('pot'); return allows(url.href)
    } catch { return false }
  }
  const safeText = (value: string) => allows(value) && sanitizeFinalReplyText(value) === value
  const read = createYoutubeHttp({ ...(options.lookup ? { lookup: options.lookup } : {}), ...(options.request ? { request: options.request } : {}),
    ...(options.proxyUrl ? { proxyUrl: options.proxyUrl } : {}), allows: allowsMediaUrl })
  function inspectMetadata(value: unknown) {
    const pending = [{ value, depth: 0 }]; let count = 0
    while (pending.length) {
      const next = pending.pop()!
      if (++count > 100_000 || next.depth > 32) throw youtubeFailure()
      if (typeof next.value === 'string') { if (!allowsMediaUrl(next.value)) throw youtubeFailure() }
      else if (Array.isArray(next.value)) for (const child of next.value) pending.push({ value: child, depth: next.depth + 1 })
      else if (next.value && typeof next.value === 'object') for (const [key, child] of Object.entries(next.value)) {
        if (!allows(key)) throw youtubeFailure(); pending.push({ value: child, depth: next.depth + 1 })
      }
    }
  }
  async function* safeChunks(chunks: AsyncIterable<Uint8Array>) {
    if (!secrets.length) { yield* chunks; return }
    const decoder = new StringDecoder('utf8'), window = Math.max(512, ...secrets.map(value => Buffer.byteLength(value) * 8 + 32))
    let tail = ''
    for await (const chunk of chunks) {
      const content = tail + decoder.write(Buffer.from(chunk))
      if (!checkSecrets(content)) throw youtubeFailure()
      tail = content.slice(-window); yield chunk
    }
    if (!checkSecrets(tail + decoder.end())) throw youtubeFailure()
  }
  const stageTime = (maximum: number) => Math.min(maximum, options.timeoutMs ?? maximum)
  return { async prepare(input, context) {
    const share = validateAgentMediaShare(input)
    if (share.provider !== 'youtube') throw youtubeFailure()
    const pageUrl = agentMediaSharePageUrl(share), guard = youtubeGuard(context, stageTime(900_000)), leases: AgentMediaArtifactLease[] = []
    let transferred = false, released = false
    const release = async () => { if (released) return; released = true; await Promise.allSettled(leases.map(lease => lease.release())) }
    try {
      await guard.ensure()
      const stat = await guard.wait(lstat(options.directory))
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || await guard.wait(realpath(options.directory)) !== options.directory) throw youtubeFailure()
      let data: Record<string, unknown> = {}, reason = '', raw: string | undefined
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          raw = await runAgentYoutubeMetadata({ directory: options.directory, pageUrl,
            ...(cookie ? { authCookie: cookie } : {}), ...(token ? { poToken: token } : {}), ...(options.proxyUrl ? { proxyUrl: options.proxyUrl } : {}),
            ...(options.lookup ? { lookup: options.lookup } : {}), ...(options.native ? { native: options.native } : {}), allows }, guard, stageTime(15_000))
          break
        } catch (error) {
          await guard.ensure()
          data = {}; reason = failureReason(error)
          if (attempt || ['youtube_downloader_unavailable', 'youtube_metadata_timeout'].includes(String(row(error).code ?? ''))) break
          await guard.wait(delay(2000, undefined, { signal: guard.signal }))
        }
      }
      await guard.ensure()
      if (raw !== undefined) {
        if (typeof raw !== 'string' || Buffer.byteLength(raw) > 2 * MiB) throw youtubeFailure()
        data = row(JSON.parse(raw))
        inspectMetadata(data)
        if (!Object.keys(data).length || Object.hasOwn(data, 'entries') || data.id !== share.reference.id ||
            data._type !== undefined && data._type !== 'video' || data.extractor_key !== undefined && data.extractor_key !== 'Youtube') throw youtubeFailure()
        for (const field of ['webpage_url', 'original_url']) if (data[field] !== undefined) {
          const parsedPage = typeof data[field] === 'string' ? parseAgentYoutubeReference(data[field]) : undefined
          if (!parsedPage || parsedPage.reference.id !== share.reference.id) throw youtubeFailure()
        }
      }
      const resolved = Object.keys(data).length > 0
      const title = resolved ? text(data.title, 300, 'YouTube 视频') : '视频信息未获取'
      const lines = [resolved ? `YouTube视频搬一下：分享了《${title}》` : 'YouTube视频搬一下：视频信息未获取']
      const basic = [`视频:${share.reference.id}`], channel = text(data.channel ?? data.uploader, 120)
      if (channel) basic.unshift(`频道:${channel}`)
      const duration = data.duration === undefined || data.duration === null ? 0 : data.duration
      if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0 || duration > 1_000_000_000) throw youtubeFailure()
      if (duration) basic.push(`时长:${durationText(duration)}`)
      lines.push(basic.join(' | '))
      const stats: (readonly [string, number])[] = []
      for (const [key, label] of [['view_count', '播放'], ['like_count', '点赞'], ['comment_count', '评论'], ['repost_count', '转发']] as const) {
        const value = data[key]
        if (value !== undefined && value !== null) { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw youtubeFailure(); stats.push([label, value]) }
      }
      if (stats.length) lines.push(`数据：${stats.map(([label, count]) => `${label}:${count}`).join(' ')}`)
      const description = text(data.description, 240)
      if (description) lines.push(`简介：${description}`)
      const items: AgentMediaRelayItem[] = []
      let cover: AgentMediaArtifactLease | undefined
      if (resolved && typeof data.thumbnail === 'string' && data.thumbnail) {
        const coverGuard = youtubeGuard(guard.context, stageTime(15_000)); let response: Awaited<ReturnType<typeof read>> | undefined
        try {
          response = await read(data.thumbnail, 'image', coverGuard, COVER_BYTES)
          if (!imageMimes.has(response.mime)) throw youtubeFailure()
          const lease = await coverGuard.wait(options.artifacts.stage({ kind: 'image', mime: response.mime, chunks: safeChunks(response.chunks) }, coverGuard.context), late => late.release())
          leases.push(lease); await coverGuard.ensure(); cover = lease
        } catch { await guard.ensure() } finally { await response?.close(); coverGuard.close() }
      }
      if (!resolved) lines.push(reason)
      else if (data.is_live === true || data.live_status === 'is_live' || data.live_status === 'is_upcoming') lines.push('直播中或尚未开始的视频未附带视频本体')
      else if (duration > 1800) lines.push('视频超过30分钟，未附带视频本体')
      else if (!duration) lines.push('视频时长未确认，未附带视频本体')
      else {
        let video: AgentMediaArtifactLease | undefined
        const download = youtubeGuard(guard.context, stageTime(600_000)); let response: Awaited<ReturnType<typeof read>> | undefined
        try {
          if (data.ext !== 'mp4' || data.protocol !== 'https' || data.fragments !== undefined || data.manifest_url !== undefined || data.fragment_base_url !== undefined ||
              typeof data.vcodec !== 'string' || !data.vcodec || data.vcodec === 'none' ||
              typeof data.acodec !== 'string' || !data.acodec || data.acodec === 'none' || typeof data.url !== 'string' ||
              Array.isArray(data.requested_formats) && data.requested_formats.length > 0 ||
              data.filesize !== undefined && data.filesize !== null && (typeof data.filesize !== 'number' || !Number.isSafeInteger(data.filesize) || data.filesize < 1 || data.filesize > VIDEO_BYTES)) throw youtubeFailure()
          response = await read(data.url, 'video', download, VIDEO_BYTES)
          if (!['video/mp4', 'application/octet-stream'].includes(response.mime)) throw youtubeFailure()
          video = await download.wait(options.artifacts.stage({ kind: 'video', mime: 'video/mp4', chunks: safeChunks(response.chunks) }, download.context), late => late.release())
          leases.push(video); await download.ensure()
          if (typeof data.filesize === 'number' && video.artifact.sizeBytes !== data.filesize) throw youtubeFailure()
        } catch { video = undefined; await guard.ensure(); lines.push('YouTube 未提供可完整下载的单文件 MP4，已保留视频页面') }
        finally { await response?.close(); download.close() }
        if (video) {
          let thumbnail: AgentMediaArtifactLease | undefined
          try { thumbnail = await prepareBilibiliThumbnail(video.artifact, { directory: options.directory, artifacts: options.artifacts, guard,
            ...(options.thumbnail ? { thumbnail: options.thumbnail } : {}) }); leases.push(thumbnail) }
          catch { await guard.ensure() }
          items.push({ parts: [{ kind: 'video', artifact: video.artifact, ...(thumbnail ? { thumbnail: thumbnail.artifact } : {}) }] })
        }
      }
      const notice = items.length ? '' : lines.at(-1) ?? ''
      lines.push(pageUrl)
      const infoText = lines.join('\n')
      if (!safeText(infoText)) throw youtubeFailure()
      const preview = firstAgentMediaRelayImage(items)
      const card = await stageAgentMediaRelayCard({ platform: 'youtube', kind: '视频', title, author: channel,
        detail: duration ? durationText(duration) : '', description, stats, pageUrl, notice,
      }, { artifacts: options.artifacts, covers: [cover?.artifact, preview], guard, allowsText: safeText, diagnostics: options.diagnostics })
      if (card) leases.push(card)
      const intro = card?.artifact ?? cover?.artifact ?? preview
      const plan = validateAgentMediaRelayPlan({ version: 1, items: [{ parts: [intro ? { kind: 'image', artifact: intro } : { kind: 'text', text: infoText }] }, ...items] }, { allowsText: safeText })
      await guard.ensure(); transferred = true
      return { status: items.length ? 'ready' : 'metadata-only', pageUrl, infoText, plan, release } satisfies AgentPreparedMediaRelay
    } catch { throw youtubeFailure() } finally { guard.close(); if (!transferred) await release() }
  } }
}
