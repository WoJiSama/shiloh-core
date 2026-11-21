import { types } from 'node:util'
import sharp from 'sharp'
import type { AgentMediaArtifact, AgentMediaArtifactLease, AgentMediaRelayItem, AgentMediaResourceContext } from '../../../contracts/agentMediaRelay.js'
import type { AgentMediaRelayProvider, AgentMediaShare, AgentPreparedMediaRelay } from '../../../contracts/agentMediaRelayWorkflow.js'
import type { AgentPreparedBilibiliQuality } from '../../../contracts/agentBilibiliQuality.js'
import type { AgentDiagnostics } from '../../runtime/infrastructure/agentDiagnostics.js'
import { createAgentSecretTextCheck } from '../../messaging/infrastructure/agentSecretText.js'
import { buildTextImageChatSvg } from '../../rendering/infrastructure/textImageTemplates.js'
import { validateAgentMediaRelayPlan } from '../domain/agentMediaRelayPlan.js'
import type { AgentMediaArtifactStore } from './agentMediaArtifactStore.js'
import { bilibiliFailure, bilibiliGuard, bilibiliOfficialUrl, createBilibiliHttp, nativeAgentBilibiliRequest } from './agentBilibiliRelayHttp.js'
import type { AgentBilibiliLookup, AgentBilibiliRequest } from './agentBilibiliRelayHttp.js'
import { parseAgentBilibiliReference, validateAgentMediaShare } from './agentBilibiliRelayReference.js'
import { prepareBilibiliThumbnail } from './agentBilibiliRelayThumbnail.js'
import type { AgentBilibiliThumbnail } from './agentBilibiliRelayThumbnail.js'
import { AgentBilibiliCardError } from './agentBilibiliCardRenderer.js'

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
  /** Supplies an image for the first automatic relay node. 'summary' renders it without Chromium. */
  readonly cardRenderer?: 'summary' | { render(view: Readonly<import('./agentBilibiliCardRenderer.js').AgentBilibiliCardView>, context: AgentMediaResourceContext): Promise<{ mime: string; base64: string }> }
  /** Metadata only: upstream errors, URLs, credentials and local paths are never emitted. */
  readonly diagnostics?: Pick<AgentDiagnostics, 'emit'>
  /** May shorten each API stage's 10s and download candidate's 10min deadlines. */
  readonly timeoutMs?: number
}
const META_BYTES = 2 * 1024 * 1024, IMAGE_BYTES = 32 * 1024 * 1024, VIDEO_BYTES = 512 * 1024 * 1024
const MAX_SECONDS = 1800, MAX_PARTS = 20
// The optional cover and card plus one video and JPEG thumbnail per segment must fit
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
interface Playback { resources: { url: string; backups: string[]; size: number; part: Part; index: number; quality: number; preview: boolean }[]; preview: boolean; login: boolean; restricted: boolean; overCapacity: boolean; notices: string[]; formats: string[]; qualities: { quality: number; label: string }[] }
export interface AgentBilibiliRelayProfile { readonly mode: 'automatic' | 'quality' | 'attachment'; readonly quality: number }
export interface AgentBilibiliProfileProvider {
  prepare(input: AgentMediaShare, context: AgentMediaResourceContext): Promise<AgentPreparedBilibiliQuality>
}

/** Internal shared engine; public factories select one closed, fixed policy. */
export function createAgentBilibiliRelayProviderWithProfile(options: AgentBilibiliRelayProviderOptions, input: AgentBilibiliRelayProfile): AgentBilibiliProfileProvider {
  let profile: Readonly<AgentBilibiliRelayProfile>
  try {
    if (!input || typeof input !== 'object' || types.isProxy(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
        Reflect.ownKeys(input).length !== 2 || Reflect.ownKeys(input).some(key => typeof key !== 'string' || !['mode', 'quality'].includes(key) ||
          !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'))) throw bilibiliFailure()
    const mode: unknown = Object.getOwnPropertyDescriptor(input, 'mode')?.value, quality: unknown = Object.getOwnPropertyDescriptor(input, 'quality')?.value
    if (!['automatic', 'quality', 'attachment'].includes(mode as string) || typeof quality !== 'number' || !Number.isSafeInteger(quality) || quality < 1 || quality > 127 ||
        mode === 'automatic' && quality !== 6 || mode === 'attachment' && quality !== 16) throw bilibiliFailure()
    profile = Object.freeze({ mode: mode as AgentBilibiliRelayProfile['mode'], quality })
  } catch { throw bilibiliFailure() }
  return createProfileProvider(options, profile)
}

/** Official Bilibili protocol; URLs, credentials and private files stay inside this provider. */
export function createAgentBilibiliRelayProvider(options: AgentBilibiliRelayProviderOptions): AgentMediaRelayProvider {
  const engine = createAgentBilibiliRelayProviderWithProfile(options, { mode: 'automatic', quality: 6 })
  return Object.freeze({ async prepare(input: AgentMediaShare, context: AgentMediaResourceContext) {
    const result = await engine.prepare(input, context)
    return Object.freeze({ status: result.status, pageUrl: result.pageUrl, infoText: result.infoText, plan: result.plan, release: result.release })
  } })
}

function createProfileProvider(options: AgentBilibiliRelayProviderOptions, profile: Readonly<AgentBilibiliRelayProfile>): AgentBilibiliProfileProvider {
  const strict = profile.mode !== 'automatic', requiredAuth = profile.mode === 'quality'
  const cardRenderer = strict ? undefined : options.cardRenderer
  const videoLimit = profile.mode === 'attachment' ? 30 * 1024 * 1024 : VIDEO_BYTES
  const videoCapacity = profile.mode === 'attachment' ? 2 : MAX_VIDEOS
  const diagnose = (operation: string, code: string, context?: AgentMediaResourceContext) => {
    let outcome: 'failed' | 'cancelled' = 'failed'
    if (context) { try { if (context.signal.aborted || !context.isCurrent()) outcome = 'cancelled' } catch { outcome = 'cancelled' } }
    const event = { stage: 'runtime' as const, operation, outcome, code }
    try { if (options.diagnostics) { options.diagnostics.emit(event); return } } catch { /* Fixed terminal metadata remains available if an observer fails. */ }
    try { console.error(`[Agent] runtime/${operation} ${outcome} ${code}`) } catch { /* No remaining writable observer. */ }
  }
  const releaseLeases = async (leases: readonly AgentMediaArtifactLease[]) => {
    const results = await Promise.allSettled(leases.map(lease => Promise.resolve().then(() => lease.release())))
    for (const result of results) if (result.status === 'rejected') diagnose('bilibili_provider_release', 'artifact_release_failed')
  }
  const closeResponse = async (response: { close(): Promise<void> | void } | undefined) => {
    try { await response?.close() } catch { diagnose('bilibili_provider_release', 'response_close_failed'); throw bilibiliFailure() }
  }
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
    if (requiredAuth && !cookie || profile.mode === 'attachment' && cookie) throw bilibiliFailure()
    if (options.timeoutMs !== undefined) { if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 600_000) throw bilibiliFailure(); timeout = options.timeoutMs }
  } catch { throw bilibiliFailure() }
  // Bilibili API responses and signed media URLs legitimately echo the client's own
  // anonymous device tokens (playurl durl URLs embed buvid3), so host/account secrets
  // gate requests, URLs and response bodies while learned device tokens are only kept
  // out of delivered text through `allowed`/`safe` below.
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
  const read = createBilibiliHttp({ ...(options.lookup ? { lookup: options.lookup } : {}), ...(options.request ? { request: options.request } : {}), allows: hostAllowed,
    onCleanupFailure: code => diagnose('bilibili_provider_release', code) })
  let fingerprintCache = { value: '', expiresAt: 0 }
  async function json(url: string, context: AgentMediaResourceContext, auth = '', exact = false): Promise<Record<string, unknown>> {
    const guard = bilibiliGuard(context, Math.min(timeout, 10_000))
    let response: Awaited<ReturnType<typeof read>> | undefined
    try {
      const reader = exact ? createBilibiliHttp({ ...(options.lookup ? { lookup: options.lookup } : {}), allows: hostAllowed,
        onCleanupFailure: code => diagnose('bilibili_provider_release', code),
        request: (current, address, signal, policy) => {
          if (current.href !== url) throw bilibiliFailure()
          return (options.request ?? nativeAgentBilibiliRequest)(current, address, signal, policy)
        } }) : read
      response = await reader(url, 'metadata', guard, META_BYTES, auth)
      if (response.mime !== 'application/json' && !response.mime.endsWith('+json')) throw bilibiliFailure()
      const chunks: Uint8Array[] = []; let size = 0
      for await (const bytes of response.chunks) { size += bytes.length; chunks.push(bytes) }
      const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))
      const responseAllowed = hostAllowed
      if (!responseAllowed(raw)) throw bilibiliFailure()
      const payload = JSON.parse(raw)
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw bilibiliFailure()
      inspect(payload, responseAllowed); await guard.ensure(); return payload as Record<string, unknown>
    } catch { diagnose('bilibili_provider_metadata', 'metadata_unavailable', context); throw bilibiliFailure() }
    finally { try { await closeResponse(response) } finally { guard.close() } }
  }
  async function fingerprint(context: AgentMediaResourceContext): Promise<string> {
    if (Date.now() < fingerprintCache.expiresAt) return fingerprintCache.value
    try {
      const payload = await json('https://api.bilibili.com/x/frontend/finger/spi', context), data = row(payload.data)
      // Bilibili appends a base64 tail (with +/=: characters) to b_4; a rejected b_4 now
      // degrades to a buvid3-only cookie instead of dropping the whole fingerprint,
      // because anonymous view/playback APIs are risk-controlled (HTTP 412) without buvid3.
      const token = /^[A-Za-z0-9_+=:\/-]{1,256}$/u
      const b3 = typeof data.b_3 === 'string' && token.test(data.b_3) ? data.b_3 : ''
      const b4 = typeof data.b_4 === 'string' && token.test(data.b_4) ? data.b_4 : ''
      if (payload.code !== 0 || !b3) { diagnose('bilibili_provider_fingerprint', 'fingerprint_invalid_fallback', context); fingerprintCache = { value: '', expiresAt: Date.now() + 60_000 }; return '' }
      if (!b4 && data.b_4) diagnose('bilibili_provider_fingerprint', 'fingerprint_partial_fallback', context)
      for (const value of [b3, b4]) if (value) secrets.add(value)
      secretCheck = createAgentSecretTextCheck([...secrets])
      const value = `buvid3=${b3}${b4 ? `; buvid4=${b4}` : ''}`
      fingerprintCache = { value, expiresAt: Date.now() + 24 * 60 * 60 * 1000 }; return value
    } catch { diagnose('bilibili_provider_fingerprint', 'fingerprint_unavailable_fallback', context); const guard = bilibiliGuard(context, Math.min(timeout, 10_000)); try { await guard.ensure(); fingerprintCache = { value: '', expiresAt: Date.now() + 60_000 }; return '' } finally { guard.close() } }
  }
  async function identify(share: AgentMediaShare, context: AgentMediaResourceContext): Promise<AgentMediaShare> {
    if (share.reference.kind !== 'short') return share
    const guard = bilibiliGuard(context, Math.min(timeout, 10_000)); let response: Awaited<ReturnType<typeof read>> | undefined
    try {
      response = await read(`https://b23.tv/${share.reference.id}`, 'share', guard, META_BYTES)
      const parsed = parseAgentBilibiliReference(response.url.href)
      if (!parsed || parsed.reference.kind === 'short') throw bilibiliFailure()
      await guard.ensure(); return parsed
    } catch { diagnose('bilibili_provider_identify', 'source_identification_failed', context); throw bilibiliFailure() }
    finally { try { await closeResponse(response) } finally { guard.close() } }
  }
  async function metadata(share: AgentMediaShare, context: AgentMediaResourceContext, buvid: string): Promise<Metadata> {
    const episode = share.reference.kind === 'episode', id = share.reference.id
    const url = episode ? `https://api.bilibili.com/pgc/view/web/season?ep_id=${id}` : `https://api.bilibili.com/x/web-interface/view?bvid=${id}`
    const payload = await json(url, context, buvid)
    if (payload.code !== 0) throw bilibiliFailure()
    const episodes = episode ? list(row(payload.result).episodes).filter(item => String(item.id) === id) : []
    if (strict && episode && episodes.length !== 1) throw bilibiliFailure()
    const data = episode ? episodes[0] : row(payload.data)
    if (!data || !Object.keys(data).length || !episode && (typeof data.bvid !== 'string' || !/^BV[0-9A-Za-z]{8,16}$/iu.test(data.bvid) || `BV${data.bvid.slice(2)}` !== id)) throw bilibiliFailure()
    const rawParts = episode ? [{ page: 1, cid: data.cid, part: data.long_title ?? data.share_copy, duration: nonnegative(data.duration ?? 0) / 1000 }] : Array.isArray(data.pages) && data.pages.length ? list(data.pages) : [{ page: 1, cid: data.cid, part: data.title, duration: data.duration }]
    const partCount = episode ? 1 : positive(data.videos ?? rawParts.length)
    if (partCount !== rawParts.length) throw bilibiliFailure()
    const parts = rawParts.map(part => ({ page: positive(part.page), cid: positive(part.cid), title: display(part.part, 200, 'P1'), duration: nonnegative(part.duration ?? 0) }))
    if (new Set(parts.map(part => part.cid)).size !== parts.length) throw bilibiliFailure()
    if (strict && parts.some((part, index) => part.page !== index + 1)) throw bilibiliFailure()
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
    const result: Playback = { resources: [], preview: false, login: false, restricted: false, overCapacity: false, notices: [], formats: [], qualities: [] }
    for (const part of meta.parts) {
      const url = meta.episode ? `https://api.bilibili.com/pgc/player/web/playurl?ep_id=${meta.id}&cid=${part.cid}&qn=${profile.quality}&fnval=0&fourk=0`
        : `https://api.bilibili.com/x/player/playurl?bvid=${meta.id}&cid=${part.cid}&qn=${profile.quality}&fnval=0&fourk=0`
      const payload = await json(url, context, auth, strict)
      if (payload.code !== 0) {
        const message = display(payload.message ?? row(payload.result).message, 80)
        result.login ||= /登录|未登录/iu.test(message)
        result.restricted ||= /地区|区域|版权|港澳台|海外/iu.test(message)
        result.notices.push(result.login ? 'B站播放接口要求登录后才能提供资源' : result.restricted ? 'B站播放接口受地区或版权限制，未提供资源' : 'B站播放接口未提供可下载资源')
        continue
      }
      const data = row(meta.episode ? payload.result : payload.data), durls = list(data.durl)
      const quality = data.quality === undefined && !strict ? 6 : positive(data.quality)
      if (quality > 127) throw bilibiliFailure()
      const privateResourceText = strict ? createAgentSecretTextCheck(durls.flatMap(item => {
        const references = [item.url, ...Array.isArray(item.backup_url) ? item.backup_url : []]
        return references.flatMap(reference => {
          if (typeof reference !== 'string') throw bilibiliFailure()
          const url = bilibiliOfficialUrl(reference, 'video')
          return [reference, ...[...url.searchParams.values()].filter(value => value.length >= 8)]
        })
      })) : () => true
      let actualLabel = `qn=${quality}`
      for (const format of list(data.support_formats)) {
        const qn = positive(format.quality); if (qn > 127) throw bilibiliFailure()
        const rawLabel = format.new_description ?? format.display_desc ?? format.format
        if (strict && typeof rawLabel === 'string' && !privateResourceText(rawLabel)) throw bilibiliFailure()
        const label = display(rawLabel, 40, `qn=${qn}`)
        if (!result.formats.includes(label)) result.formats.push(label)
        if (qn === quality) actualLabel = label
      }
      if (!result.qualities.some(value => value.quality === quality)) result.qualities.push({ quality, label: safe(actualLabel) })
      if (!durls.length) { result.notices.push('B站播放接口未提供可下载资源'); continue }
      if (durls.length > capacity || result.resources.length + durls.length > capacity) {
        result.overCapacity = true; result.resources.length = 0
        result.notices.push(`视频分段数超过${capacity}段资源容量上限，未附带视频本体`)
        return result
      }
      const preview = data.is_preview === true || data.is_preview === 1
      if (strict && data.is_preview !== undefined && ![true, false, 0, 1].includes(data.is_preview as boolean | number)) throw bilibiliFailure()
      result.preview ||= preview
      if (preview) result.notices.push(`B站${meta.episode ? '番剧' : '视频'}仅提供约${durationText(durls.reduce((sum, item) => sum + nonnegative(item.length ?? 0), 0) / 1000)}试看，本体为试看片段`)
      if (strict && !preview) {
        const complete = durls.every((item, index) => typeof item.length === 'number' && Number.isSafeInteger(item.length) && item.length > 0 &&
          typeof item.size === 'number' && Number.isSafeInteger(item.size) && item.size > 0 && (item.order === undefined || item.order === index + 1))
        const length = complete ? durls.reduce((sum, item) => sum + (item.length as number), 0) : 0
        if (!complete || !Number.isSafeInteger(length) || length < part.duration * 1000 ||
            data.timelength !== undefined && (typeof data.timelength !== 'number' || !Number.isSafeInteger(data.timelength) ||
              data.timelength < part.duration * 1000 || length < data.timelength)) {
          result.notices.push('B站未提供全部分段的完整时长与大小，未附带视频本体')
          continue
        }
      }
      for (const [index, item] of durls.entries()) {
        if (typeof item.url !== 'string') throw bilibiliFailure()
        const rawBackups = item.backup_url === undefined ? [] : Array.isArray(item.backup_url) && item.backup_url.length <= 8 ? item.backup_url : undefined
        if (!rawBackups) throw bilibiliFailure()
        // Bilibili can list an unofficial PCDN primary alongside an official backup.
        const [url, ...backups] = [item.url, ...rawBackups].filter((value): value is string => {
          try {
            if (typeof value !== 'string') throw bilibiliFailure()
            bilibiliOfficialUrl(value, 'video')
            return true
          } catch (error) { if (strict) throw error; return false }
        })
        if (!url) {
          result.notices.push('B站未提供全部分段的官方可下载资源，未附带视频本体')
          continue
        }
        result.resources.push({ url, backups, size: nonnegative(item.size ?? 0), part, index, quality, preview })
      }
    }
    return result
  }
  async function download(urls: string[], kind: 'video' | 'image', context: AgentMediaResourceContext, auth = '', expectedSize = 0): Promise<AgentMediaArtifactLease> {
    for (const url of urls) {
      const guard = bilibiliGuard(context, timeout), maxBytes = kind === 'video' ? videoLimit : IMAGE_BYTES
      let response: Awaited<ReturnType<typeof read>> | undefined
      try {
        response = await read(url, kind, guard, maxBytes, auth)
        const mime = response.mime === 'video/x-flv' || response.mime === 'video/flv' ? 'video/x-flv' : response.mime === 'image/jpg' ? 'image/jpeg' : response.mime
        if (kind === 'video' && !['video/mp4', 'video/quicktime', 'video/webm', 'video/x-flv'].includes(mime) || kind === 'image' && !['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'].includes(mime)) throw bilibiliFailure()
        const lease = await guard.wait(options.artifacts.stage({ kind, mime, chunks: response.chunks }, guard.context), late => releaseLeases([late]))
        try {
          await guard.ensure()
          if (expectedSize > 0 && lease.artifact.sizeBytes !== expectedSize) throw bilibiliFailure()
          return lease
        } catch { try { await lease.release() } catch { diagnose('bilibili_provider_release', 'artifact_release_failed') }; throw bilibiliFailure() }
      } catch {
        diagnose('bilibili_provider_download', kind === 'video' ? 'video_candidate_failed' : 'image_candidate_failed', context)
        const current = bilibiliGuard(context, Math.min(timeout, 10_000)); try { await current.ensure() } finally { current.close() }
      } finally { try { await closeResponse(response) } finally { guard.close() } }
    }
    throw bilibiliFailure()
  }
  return Object.freeze({ async prepare(input: AgentMediaShare, context: AgentMediaResourceContext): Promise<AgentPreparedBilibiliQuality> {
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
      if (strict) lines.push(`请求清晰度:qn=${profile.quality}`)
      let status: AgentPreparedMediaRelay['status'] = 'metadata-only'
      let actualQualities: readonly { readonly quality: number; readonly label: string }[] = Object.freeze([])
      const outputReferences = meta.cover ? [meta.cover] : []
      const mediaItems: AgentMediaRelayItem[] = []
      let cover: AgentMediaArtifact | undefined
      if (meta.cover && cardRenderer !== 'summary') { try { const lease = await download([meta.cover], 'image', guard.context); leases.push(lease); cover = lease.artifact } catch { diagnose('bilibili_provider_cover', 'cover_unavailable', context); await guard.ensure(); lines.push('封面暂时获取失败') } }
      const duration = strict ? Math.max(meta.duration, meta.parts.reduce((total, part) => total + part.duration, 0)) : meta.duration
      if (duration > MAX_SECONDS) lines.push('视频超过30分钟，未附带视频本体')
      else if (meta.partCount > MAX_PARTS) lines.push(`视频共有${meta.partCount}个分P，超过20个分P上限，未附带视频本体`)
      else if (meta.duration <= 0 || strict && meta.parts.some(part => part.duration <= 0)) lines.push('视频时长未知，未附带视频本体')
      else {
        const reserveIntroArtifacts = profile.mode !== 'attachment' && (cover || cardRenderer)
        const capacity = reserveIntroArtifacts ? videoCapacity - 1 : videoCapacity
        let play = await playback(meta, guard.context, requiredAuth ? [cookie, buvid].filter(Boolean).join('; ') : buvid, capacity), authorized = requiredAuth
        if (!strict && !play.overCapacity && cookie && options.autoAuthorizedRetry === true && (play.preview || play.login)) {
          play = await playback(meta, guard.context, [cookie, buvid].filter(Boolean).join('; '), capacity); authorized = true
        }
        if (strict) for (const resource of play.resources) outputReferences.push(resource.url, ...resource.backups)
        lines.push(...new Set(play.notices))
        if ((authorized || strict) && play.preview) { status = 'restricted'; lines.push(authorized ? strict ? '已使用授权账号，但B站仍只提供试看资源，未附带视频本体' : '已使用授权账号复试，但B站仍只提供试看资源，未附带视频本体' : 'B站仅提供试看资源，未附带视频本体') }
        else if (!play.resources.length || play.notices.some(notice => !notice.includes('试看')) || play.resources.some(resource => resource.size > videoLimit)) {
          status = play.restricted || play.login ? 'restricted' : 'metadata-only'
          if (play.resources.some(resource => resource.size > videoLimit)) lines.push(`单个视频超过${videoLimit / 1024 / 1024} MiB上限，未附带视频本体`)
          else lines.push('B站未提供全部分P的可下载资源，已保留视频页面')
        } else {
          const videoLeases: AgentMediaArtifactLease[] = []
          try {
            for (const resource of play.resources) {
              await guard.ensure()
              const video = await download([resource.url, ...resource.backups], 'video', guard.context, authorized ? cookie : '', resource.size)
              leases.push(video); videoLeases.push(video)
              let thumbnail: AgentMediaArtifactLease | undefined
              try { thumbnail = await prepareBilibiliThumbnail(video.artifact, { directory: options.directory, artifacts: options.artifacts, guard,
                onCleanupFailure: code => diagnose('bilibili_provider_release', code), ...(options.thumbnail ? { thumbnail: options.thumbnail } : {}) }) }
              catch { diagnose('bilibili_provider_thumbnail', 'thumbnail_unavailable', context); await guard.ensure(); if (!lines.includes('视频预览图暂不可用')) lines.push('视频预览图暂不可用') }
              if (thumbnail) { leases.push(thumbnail); videoLeases.push(thumbnail) }
              mediaItems.push({ parts: [{ kind: 'video', artifact: video.artifact, ...(thumbnail ? { thumbnail: thumbnail.artifact } : {}) }] })
            }
            status = play.preview ? 'preview' : 'ready'
            if (strict) actualQualities = Object.freeze(play.qualities.map(value => Object.freeze({ ...value })))
            if (play.formats.length) lines.push(`可选清晰度：${play.formats.join('、')}`)
            const qualities = [...new Set(play.resources.map(resource => resource.quality))]
            lines.push(`请求清晰度:qn=${profile.quality}；实际清晰度:${qualities.map(value => `qn=${value}`).join('、')}`)
          } catch { diagnose('bilibili_provider_download', 'video_plan_incomplete', context); await guard.ensure(); mediaItems.length = 0; await releaseLeases(videoLeases); lines.push('视频本体未完整获取，已保留视频页面') }
        }
      }
      const outputCheck = strict ? createAgentSecretTextCheck(outputReferences.flatMap(reference =>
        [reference, ...[...new URL(reference).searchParams.values()].filter(value => value.length >= 8)])) : () => true
      const outputAllowed = (value: string) => allowed(value) && outputCheck(value)
      const infoText = safe(lines.join('\n')), pageUrl = safe(meta.pageUrl)
      if (!outputAllowed(infoText) || !outputAllowed(pageUrl) || actualQualities.some(value => !outputAllowed(value.label))) throw bilibiliFailure()
      let introParts: readonly ({ kind: 'text', text: string } | { kind: 'image', artifact: AgentMediaArtifact })[] | undefined
      if (cardRenderer) {
        let card: { bytes: Buffer; mime: string } | undefined
        if (cardRenderer !== 'summary') {
          try {
            let coverData: { readonly mime: string; readonly bytes: Buffer } | undefined
            if (cover) {
              const reader = await options.artifacts.open(cover, guard.context)
              try { const chunks: Buffer[] = []; for await (const bytes of reader.chunks) chunks.push(Buffer.from(bytes)); coverData = { mime: cover.mime, bytes: Buffer.concat(chunks) } } finally { await reader.close?.() }
            }
            const image = await cardRenderer.render({ title: meta.title, owner: meta.owner, durationText: durationText(meta.duration),
              partText: meta.partCount > 1 ? `${meta.partCount}个分P` : '', publishedText: meta.published ? new Date(meta.published * 1000).toISOString().slice(0, 10) : '',
              pageUrl: meta.pageUrl, stats: Object.fromEntries(Object.entries(statLabels).filter(([key]) => meta.stats[key] !== undefined).map(([key, label]) => [label, meta.stats[key]!.toLocaleString('zh-CN')])),
              description: meta.description.slice(0, 300), episode: meta.episode, ...(coverData ? { cover: coverData } : {}) }, guard.context)
            card = { bytes: Buffer.from(image.base64, 'base64'), mime: image.mime }
          } catch (error) {
            diagnose('bilibili_provider_card', error instanceof AgentBilibiliCardError ? error.code : 'card_unavailable', context)
            await guard.ensure()
          }
        }
        if (!card) {
          const { svg, visibleText } = buildTextImageChatSvg({ text: infoText, nickname: '哔哩哔哩' })
          if (!outputAllowed(visibleText)) throw bilibiliFailure()
          const bytes = await guard.wait(sharp(Buffer.from(svg), { limitInputPixels: 8_000_000 }).timeout({ seconds: 5 }).png().toBuffer())
          card = { bytes, mime: 'image/png' }
        }
        const { bytes, mime } = card
        const lease = await guard.wait(options.artifacts.stage({ kind: 'image', mime, chunks: (async function* () { yield bytes })() }, guard.context), late => releaseLeases([late]))
        leases.push(lease)
        introParts = [{ kind: 'image', artifact: lease.artifact }]
      }
      const plan = validateAgentMediaRelayPlan({ version: 1, items: [{ parts: introParts ?? [{ kind: 'text', text: infoText }, ...(cover ? [{ kind: 'image', artifact: cover } as const] : [])] }, ...mediaItems] }, { allowsText: outputAllowed })
      await guard.ensure()
      let released: Promise<void> | undefined
      const result = Object.freeze({ status, pageUrl, infoText, plan, requestedQuality: profile.quality, actualQualities, release() {
        return released ??= releaseLeases(leases)
      } })
      transferred = true; return result
    } catch { diagnose('bilibili_provider_prepare', 'prepare_unavailable', context); throw bilibiliFailure() }
    finally { guard.close(); if (!transferred) await releaseLeases(leases) }
  } })
}
