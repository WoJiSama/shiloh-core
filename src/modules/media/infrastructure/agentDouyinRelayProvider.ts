import { constants } from 'node:fs'
import { chmod, lstat, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { AgentMediaArtifactLease, AgentMediaRelayItem, AgentMediaResourceContext } from '../../../contracts/agentMediaRelay.js'
import type { AgentMediaRelayProvider, AgentPreparedMediaRelay } from '../../../contracts/agentMediaRelayWorkflow.js'
import { sanitizeFinalReplyText } from '../../conversation/domain/replySanitizer.js'
import { createAgentSecretTextCheck } from '../../messaging/infrastructure/agentSecretText.js'
import { validateAgentMediaRelayPlan } from '../domain/agentMediaRelayPlan.js'
import type { AgentMediaArtifactStore } from './agentMediaArtifactStore.js'
import { agentMediaSharePageUrl, validateAgentMediaShare } from './agentMediaRelayReference.js'
import { createDouyinHttp, douyinBody, douyinFailure, douyinGuard, douyinOfficialUrl } from './agentDouyinRelayHttp.js'
import type { AgentDouyinLookup, AgentDouyinRequest, DouyinRequestKind } from './agentDouyinRelayHttp.js'
import { nativeAgentDouyinBrowser } from './agentDouyinRelayBrowser.js'
import type { AgentDouyinBrowser } from './agentDouyinRelayBrowser.js'
import { douyinCanonicalPage, douyinDocumentMetadata, douyinPageIdentity } from './agentDouyinRelayMetadata.js'
import type { AgentDouyinResolvedMedia } from './agentDouyinRelayMetadata.js'
import { douyinConvertImage, douyinFileChunks, douyinSlideshow, douyinThumbnail } from './agentDouyinRelayNative.js'
import type { AgentDouyinNative } from './agentDouyinRelayNative.js'

export type { AgentDouyinLookup, AgentDouyinRequest, AgentDouyinResponse, AgentDouyinRequestPolicy } from './agentDouyinRelayHttp.js'
export type { AgentDouyinBrowser, AgentDouyinBrowserInput, AgentDouyinBrowserRead } from './agentDouyinRelayBrowser.js'
export type { AgentDouyinNative, AgentDouyinNativeOptions } from './agentDouyinRelayNative.js'
export interface AgentDouyinRelayProviderOptions {
  readonly directory: string
  readonly artifacts: AgentMediaArtifactStore
  readonly secrets?: readonly string[]
  readonly allowsText?: (text: string) => boolean
  readonly lookup?: AgentDouyinLookup
  readonly request?: AgentDouyinRequest
  readonly browser?: AgentDouyinBrowser
  readonly native?: AgentDouyinNative
  /** May shorten the preparation and every external stage's deadline. */
  readonly timeoutMs?: number
}
const MiB = 1024 * 1024, IMAGE_BYTES = 32 * MiB, VIDEO_BYTES = 512 * MiB
const imageMimes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/bmp', 'image/heic', 'image/heif'])
const videoMimes = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-flv'])
const extension: Readonly<Record<string, string>> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif', 'image/bmp': '.bmp',
  'image/heic': '.heic', 'image/heif': '.heif', 'video/mp4': '.mp4', 'video/quicktime': '.mp4', 'video/webm': '.webm', 'video/x-flv': '.flv',
  'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac', 'audio/aacp': '.aac' }

export function createAgentDouyinRelayProvider(options: AgentDouyinRelayProviderOptions): AgentMediaRelayProvider {
  if (!options || typeof options.directory !== 'string' || !path.isAbsolute(options.directory) || !options.artifacts || typeof options.artifacts.stage !== 'function' ||
    options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)) throw douyinFailure()
  const secrets = options.secrets ?? [], hostSecretCheck = createAgentSecretTextCheck(secrets)
  const allows = (value: string) => { try { return hostSecretCheck(value) && options.allowsText?.(value) !== false } catch { return false } }
  const stageTime = (maximum: number) => Math.min(maximum, options.timeoutMs ?? maximum)
  let browserTail: Promise<unknown> = Promise.resolve()
  return { async prepare(input, context) {
    const share = validateAgentMediaShare(input)
    if (share.provider !== 'douyin') throw douyinFailure()
    const anonymous = new Set<string>()
    let secretCheck = hostSecretCheck
    const safeText = (value: string) => typeof value === 'string' && sanitizeFinalReplyText(value) === value && secretCheck(value) && allows(value)
    const read = createDouyinHttp({ ...(options.lookup ? { lookup: options.lookup } : {}), ...(options.request ? { request: options.request } : {}), allows,
      registerAnonymousSecrets(values) { for (const value of values) { if (!anonymous.has(value) && anonymous.size >= 256) throw douyinFailure(); anonymous.add(value) }; secretCheck = createAgentSecretTextCheck([...secrets, ...anonymous]) } })
    const guard = douyinGuard(context, stageTime(2_700_000)), leases: AgentMediaArtifactLease[] = []
    let directory = '', counter = 0, transferred = false, released: Promise<void> | undefined
    const release = () => released ??= Promise.allSettled(leases.map(lease => lease.release())).then(() => {})
    const addLease = async (operation: Promise<AgentMediaArtifactLease>) => {
      const lease = await guard.wait(operation, late => late.release()); leases.push(lease); await guard.ensure(); return lease
    }
    const file = (suffix: string) => path.join(directory, `media-${counter++}${suffix}`)
    async function stage(filePath: string, kind: 'image' | 'video', mime: string) {
      return addLease(options.artifacts.stage({ kind, mime, chunks: douyinFileChunks(filePath, kind === 'image' ? IMAGE_BYTES : VIDEO_BYTES, guard) }, guard.context))
    }
    async function download(url: string, kind: 'video' | 'image' | 'music') {
      const own = douyinGuard(guard.context, stageTime(kind === 'video' ? 600_000 : 60_000))
      let filePath = '', handle: Awaited<ReturnType<typeof open>> | undefined
      try {
        const response = await read(url, kind, own, kind === 'video' ? VIDEO_BYTES : IMAGE_BYTES)
        let mime = response.mime === 'image/jpg' ? 'image/jpeg' : response.mime === 'video/flv' ? 'video/x-flv' : response.mime
        try {
          if (!(kind === 'image' ? imageMimes.has(mime) : kind === 'video' ? videoMimes.has(mime) : /^audio\/(?:mpeg|mp3|mp4|x-m4a|aac|aacp)$/u.test(mime))) throw douyinFailure()
          filePath = file(extension[mime] ?? '.bin')
          handle = await own.wait(open(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600), late => late.close())
          let tail = '', size = 0
          const decoder = new StringDecoder('utf8')
          const window = Math.max(512, ...[...secrets, ...anonymous].map(value => Buffer.byteLength(value) * 8 + 32))
          for await (const bytes of response.chunks) {
            await own.ensure()
            const content = tail + decoder.write(Buffer.from(bytes))
            if (!secretCheck(content)) throw douyinFailure()
            tail = content.slice(-window); size += bytes.byteLength
            if (size > (kind === 'video' ? VIDEO_BYTES : IMAGE_BYTES)) throw douyinFailure()
            for (let at = 0; at < bytes.length;) { await own.ensure(); const result = await own.wait(handle.write(bytes, at, bytes.length - at)); if (!result.bytesWritten) throw douyinFailure(); at += result.bytesWritten }
          }
          if (!secretCheck(tail + decoder.end())) throw douyinFailure()
          if (!size) throw douyinFailure()
          await handle.close(); handle = undefined; await chmod(filePath, 0o400); await own.ensure()
          return { file: filePath, mime }
        } finally { await response.close() }
      } finally { await handle?.close().catch(() => {}); own.close() }
    }
    async function image(url: string) {
      const downloaded = await download(url, 'image')
      if (['image/heic', 'image/heif'].includes(downloaded.mime)) {
        const converted = file('.jpg'); await douyinConvertImage(downloaded.file, converted, options.native, guard)
        return { file: converted, lease: await stage(converted, 'image', 'image/jpeg') }
      }
      return { file: downloaded.file, lease: await stage(downloaded.file, 'image', downloaded.mime) }
    }
    async function video(filePath: string, mime: string) {
      const videoLease = await stage(filePath, 'video', mime)
      try {
        const thumbnailPath = file('.jpg')
        await douyinThumbnail(filePath, thumbnailPath, options.native, guard, mime)
        const thumbnail = await stage(thumbnailPath, 'image', 'image/jpeg')
        return { kind: 'video' as const, artifact: videoLease.artifact, thumbnail: thumbnail.artifact }
      } catch { await guard.ensure(); return { kind: 'video' as const, artifact: videoLease.artifact } }
    }
    try {
      await guard.ensure()
      const parent = await guard.wait(realpath(options.directory))
      if (!(await guard.wait(lstat(parent))).isDirectory()) throw douyinFailure()
      directory = await guard.wait(mkdtemp(path.join(parent, 'douyin-')), late => rm(late, { recursive: true, force: true })); await chmod(directory, 0o700)
      const ref = share.reference
      let id = ref.kind === 'short' ? '' : ref.id, kind: 'video' | 'note' = ref.kind === 'note' ? 'note' : 'video'
      let metadata: AgentDouyinResolvedMedia | undefined
      const metadataGuard = douyinGuard(guard.context, stageTime(7000))
      try {
        const response = await read(agentMediaSharePageUrl(share), 'page', metadataGuard, 2 * MiB)
        const landed = douyinPageIdentity(response.url)
        if (!landed || id && landed.id !== id) { await response.close(); throw douyinFailure() }
        id = landed.id; kind = landed.kind
        const body = await douyinBody(response)
        if (!secretCheck(body.toString('utf8'))) throw douyinFailure()
        metadata = douyinDocumentMetadata(body.toString('utf8'), id, kind)
      } catch { await guard.ensure(); if (!id) throw douyinFailure() }
      finally { metadataGuard.close() }
      const complete = () => metadata && (metadata.kind === 'note' ? metadata.images.length > 0 : !!metadata.video && metadata.duration > 0)
      if (!complete()) {
        const browserGuard = douyinGuard(guard.context, stageTime(25_000))
        try {
          const task = browserTail.then(async () => { await browserGuard.ensure(); return (options.browser ?? nativeAgentDouyinBrowser)({ id, kind, pageUrl: douyinCanonicalPage(id, kind), directory }, browserGuard.context, read) })
          browserTail = task.catch(() => {})
          const resolved = await browserGuard.wait(task)
          if (resolved) metadata = resolved
        } catch { await guard.ensure() }
        finally { browserGuard.close() }
      }
      await guard.ensure()
      const media = metadata
      if (media && (media.id !== id || !['video', 'note'].includes(media.kind) || !Number.isFinite(media.duration) || media.duration < 0 || !Array.isArray(media.images) || media.images.length > 2000 ||
        ![media.title, media.description, media.author].every(value => typeof value === 'string' && Array.from(value).length <= 1000 && (!value || safeText(value))))) throw douyinFailure()
      if (media) kind = media.kind
      const pageUrl = douyinCanonicalPage(id, kind), lines = [kind === 'note' ? '抖音图文搬一下' : '抖音视频搬一下', media?.title || '作品详情暂未解析完成', `作品:${id}`], items: AgentMediaRelayItem[] = []
      if (media?.author) lines.push(`作者:${media.author}`)
      if (media?.description && media.description !== media.title) lines.push(`简介:${media.description}`)
      if (media?.duration) lines.push(`时长:${Math.floor(media.duration / 60)}:${String(Math.floor(media.duration % 60)).padStart(2, '0')}`)
      const labels: Readonly<Record<string, string>> = { play_count: '播放', digg_count: '点赞', comment_count: '评论', share_count: '转发', collect_count: '收藏' }
      if (media?.stats) { const stats = Object.entries(labels).filter(([key]) => Number.isSafeInteger(media.stats[key]) && media.stats[key]! >= 0).map(([key, label]) => `${label}:${media.stats[key]}`); if (stats.length) lines.push(`数据:${stats.join(' ')}`) }
      let cover: AgentMediaArtifactLease | undefined
      if (kind === 'video' && media?.cover) {
        try { cover = (await image(media.cover)).lease } catch { await guard.ensure(); lines.push('封面暂时获取失败') }
      }
      if (kind === 'note' && media?.images.length) {
        const images = media.images.slice(0, 20), localImages: string[] = []
        const failed: number[] = []
        for (const [index, url] of images.entries()) {
          try { const prepared = await image(url); localImages.push(prepared.file); items.push({ parts: [{ kind: 'image', artifact: prepared.lease.artifact }] }) }
          catch { await guard.ensure(); failed.push(index + 1) }
        }
        lines.push(`图集:${media.images.length}张`)
        if (media.images.length > 20) lines.push(`图集共${media.images.length}张，仅附前20张`)
        if (failed.length) lines.push(`图集第${failed.join('、')}张图片暂时获取失败，已保留其余图片和作品页面`)
        if (!localImages.length) lines.push('图集图片暂时获取失败，已保留作品页面')
        if (media.music && localImages.length) {
          try {
            const audio = await download(media.music, 'music'), output = file('.mp4')
            const audioFormat = audio.mime === 'audio/mp4' || audio.mime === 'audio/x-m4a' ? 'mov' : ['audio/aac', 'audio/aacp'].includes(audio.mime) ? 'aac' : 'mp3'
            await douyinSlideshow(localImages, audio.file, audioFormat, output, options.native, guard)
            items.push({ parts: [await video(output, 'video/mp4')] })
          } catch { await guard.ensure(); lines.push('配乐视频暂时无法合成，已保留图集') }
        }
      } else if (kind === 'video' && media) {
        if (media.duration > 1800) lines.push('视频超过30分钟，未附带视频本体')
        else if (media.duration <= 0) lines.push('视频时长未通过验证，已保留作品页面')
        else if (media.video) {
          try { const downloaded = await download(media.video, 'video'); items.push({ parts: [await video(downloaded.file, downloaded.mime)] }) }
          catch { await guard.ensure(); lines.push('视频本体暂时获取失败，已保留作品页面') }
        } else lines.push('视频播放地址暂时获取失败，已保留作品页面')
      } else lines.push('作品详情暂时未解析完成，已保留作品页面')
      lines.push(pageUrl)
      const infoText = lines.join('\n')
      if (!safeText(infoText)) throw douyinFailure()
      const plan = validateAgentMediaRelayPlan({ version: 1, items: [{ parts: [{ kind: 'text', text: infoText }, ...(cover ? [{ kind: 'image', artifact: cover.artifact } as const] : [])] }, ...items] }, { allowsText: safeText })
      await guard.ensure(); transferred = true
      return { status: items.length ? 'ready' : 'metadata-only', pageUrl, infoText, plan, release } satisfies AgentPreparedMediaRelay
    } catch { throw douyinFailure() }
    finally { guard.close(); if (!transferred) await release(); if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {}) }
  } }
}
