import { constants } from 'node:fs'
import { chmod, lstat, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { AgentMediaArtifactLease, AgentMediaRelayItem } from '../../../contracts/agentMediaRelay.js'
import type { AgentMediaRelayProvider, AgentPreparedMediaRelay, AgentMediaShareAccess } from '../../../contracts/agentMediaRelayWorkflow.js'
import { sanitizeFinalReplyText } from '../../conversation/domain/replySanitizer.js'
import { createAgentSecretTextCheck } from '../../messaging/infrastructure/agentSecretText.js'
import { validateAgentMediaRelayPlan } from '../domain/agentMediaRelayPlan.js'
import type { AgentMediaArtifactStore } from './agentMediaArtifactStore.js'
import { validateAgentMediaShare } from './agentMediaRelayReference.js'
import { parseAgentXiaohongshuReference, readAgentXiaohongshuAccess, validateAgentXiaohongshuAccess, xiaohongshuAccessPageUrl } from './agentXiaohongshuRelayReference.js'
import { createXiaohongshuHttp, xiaohongshuBody, xiaohongshuFailure, xiaohongshuGuard } from './agentXiaohongshuRelayHttp.js'
import type { AgentXiaohongshuLookup, AgentXiaohongshuRequest } from './agentXiaohongshuRelayHttp.js'
import { nativeAgentXiaohongshuBrowser } from './agentXiaohongshuRelayBrowser.js'
import type { AgentXiaohongshuBrowser } from './agentXiaohongshuRelayBrowser.js'
import { xiaohongshuCanonicalPage, xiaohongshuDocumentMetadata, xiaohongshuPageIdentity, xiaohongshuUnsignedImage } from './agentXiaohongshuRelayMetadata.js'
import type { AgentXiaohongshuResolvedMedia } from './agentXiaohongshuRelayMetadata.js'
import { douyinConvertImage, douyinFileChunks, douyinThumbnail } from './agentDouyinRelayNative.js'
import type { AgentDouyinNative } from './agentDouyinRelayNative.js'

export type { AgentXiaohongshuLookup, AgentXiaohongshuRequest, AgentXiaohongshuResponse, AgentXiaohongshuRequestPolicy } from './agentXiaohongshuRelayHttp.js'
export type { AgentXiaohongshuBrowser, AgentXiaohongshuBrowserInput, AgentXiaohongshuBrowserRead } from './agentXiaohongshuRelayBrowser.js'
export interface AgentXiaohongshuRelayProviderOptions {
  readonly directory: string
  readonly artifacts: AgentMediaArtifactStore
  readonly secrets?: readonly string[]
  readonly allowsText?: (text: string) => boolean
  /** Explicit host capability used only on official note-page HTTP requests. */
  readonly authCookie?: string
  readonly lookup?: AgentXiaohongshuLookup
  readonly request?: AgentXiaohongshuRequest
  readonly browser?: AgentXiaohongshuBrowser
  readonly native?: AgentDouyinNative
  readonly timeoutMs?: number
}
const MiB = 1024 * 1024, IMAGE_BYTES = 32 * MiB, VIDEO_BYTES = 256 * MiB
const imageMimes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/bmp', 'image/heic', 'image/heif'])
const videoMimes = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-flv'])
const extension: Readonly<Record<string, string>> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif', 'image/bmp': '.bmp', 'image/heic': '.heic', 'image/heif': '.heif', 'video/mp4': '.mp4', 'video/quicktime': '.mp4', 'video/webm': '.webm', 'video/x-flv': '.flv' }

export function createAgentXiaohongshuRelayProvider(options: AgentXiaohongshuRelayProviderOptions): AgentMediaRelayProvider {
  if (!options || typeof options.directory !== 'string' || !path.isAbsolute(options.directory) || !options.artifacts || typeof options.artifacts.stage !== 'function' || options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)) throw xiaohongshuFailure()
  if (options.authCookie !== undefined && (typeof options.authCookie !== 'string' || options.authCookie.length > 32768 || /[\u0000-\u001f\u007f]/u.test(options.authCookie))) throw xiaohongshuFailure()
  const secrets = [...(options.secrets ?? []), ...(options.authCookie ? [options.authCookie, ...options.authCookie.split(';').map(value => value.trim().split('=').slice(1).join('=')).filter(Boolean)] : [])]
  const hostCheck = createAgentSecretTextCheck(secrets)
  const allows = (value: string) => { try { return hostCheck(value) && options.allowsText?.(value) !== false } catch { return false } }
  const stageTime = (maximum: number) => Math.min(maximum, options.timeoutMs ?? maximum)
  let browserTail: Promise<unknown> = Promise.resolve()
  return { async prepare(input, context) {
    const share = validateAgentMediaShare(input)
    if (share.provider !== 'xiaohongshu') throw xiaohongshuFailure()
    const guard = xiaohongshuGuard(context, stageTime(14_000_000)), leases: AgentMediaArtifactLease[] = []
    const transient = new Set<string>(), accessSecrets = new Set<string>()
    let expectedId = share.reference.kind === 'note' ? share.reference.id : '', access: Readonly<AgentMediaShareAccess> | undefined
    let secretCheck = hostCheck, accessCheck = hostCheck
    const register = (values: readonly string[], access = false) => {
      for (const value of values.filter(Boolean)) { if (!transient.has(value) && transient.size >= 256) throw xiaohongshuFailure(); transient.add(value); if (access) accessSecrets.add(value) }
      secretCheck = createAgentSecretTextCheck([...secrets, ...transient]); accessCheck = createAgentSecretTextCheck([...secrets, ...accessSecrets])
    }
    const safeText = (value: string) => typeof value === 'string' && sanitizeFinalReplyText(value) === value && secretCheck(value) && allows(value)
    const read = createXiaohongshuHttp({ ...(options.lookup ? { lookup: options.lookup } : {}), ...(options.request ? { request: options.request } : {}),
      ...(options.authCookie !== undefined ? { authCookie: options.authCookie } : {}), allows,
      feedContext: () => ({ id: expectedId, ...(access?.xsecToken ? { token: access.xsecToken } : {}) }),
      allowsMedia: (value, kind) => kind === 'browser' ? accessCheck(value) : secretCheck(value), registerAnonymousSecrets: values => register(values),
      checkPage(url, requestKind) {
        const landed = xiaohongshuPageIdentity(url)
        if (!landed) { if (expectedId) throw xiaohongshuFailure(); return }
        if (expectedId && landed !== expectedId) throw xiaohongshuFailure()
        expectedId = landed
        const reference = parseAgentXiaohongshuReference(url.href), observed = reference && readAgentXiaohongshuAccess(url.href, reference)
        if (observed && requestKind === 'browser') {
          if (observed.xsecToken !== undefined && observed.xsecToken !== access?.xsecToken) throw xiaohongshuFailure()
          const withoutToken = new URL(url); withoutToken.searchParams.delete('xsec_token'); if (!accessCheck(withoutToken.href)) throw xiaohongshuFailure()
        }
        if (observed && requestKind === 'page') { access = { ...access, ...observed, ...(access?.mediaKind === 'image' ? { mediaKind: 'image' as const } : {}) }; if (observed.xsecToken) register([observed.xsecToken], true) }
      } })
    let directory = '', counter = 0, transferred = false, released: Promise<void> | undefined
    const release = () => released ??= Promise.allSettled(leases.map(lease => lease.release())).then(() => {})
    const addLease = async (operation: Promise<AgentMediaArtifactLease>) => { const lease = await guard.wait(operation, late => late.release()); leases.push(lease); await guard.ensure(); return lease }
    const file = (suffix: string) => path.join(directory, `media-${counter++}${suffix}`)
    async function stage(filePath: string, kind: 'image' | 'video', mime: string) {
      return addLease(options.artifacts.stage({ kind, mime, chunks: douyinFileChunks(filePath, kind === 'image' ? IMAGE_BYTES : VIDEO_BYTES, guard) }, guard.context))
    }
    async function download(url: string, kind: 'video' | 'image') {
      const own = xiaohongshuGuard(guard.context, stageTime(kind === 'video' ? 600_000 : 60_000)), maximum = kind === 'video' ? VIDEO_BYTES : IMAGE_BYTES
      let filePath = '', handle: Awaited<ReturnType<typeof open>> | undefined
      try {
        const response = await read(url, kind, own, maximum)
        try {
          const mime = response.mime === 'image/jpg' ? 'image/jpeg' : response.mime === 'video/flv' ? 'video/x-flv' : response.mime
          if (!(kind === 'image' ? imageMimes : videoMimes).has(mime)) throw xiaohongshuFailure()
          filePath = file(extension[mime] ?? '.bin')
          handle = await own.wait(open(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600), late => late.close())
          let tail = '', size = 0
          const decoder = new StringDecoder('utf8'), window = Math.max(512, ...[...secrets, ...transient].map(value => Buffer.byteLength(value) * 8 + 32))
          for await (const bytes of response.chunks) {
            await own.ensure()
            const content = tail + decoder.write(Buffer.from(bytes))
            if (!secretCheck(content)) throw xiaohongshuFailure()
            tail = content.slice(-window); size += bytes.byteLength
            if (size > maximum) throw xiaohongshuFailure()
            for (let at = 0; at < bytes.length;) { await own.ensure(); const result = await own.wait(handle.write(bytes, at, bytes.length - at)); if (!result.bytesWritten) throw xiaohongshuFailure(); at += result.bytesWritten }
          }
          if (!size || !secretCheck(tail + decoder.end())) throw xiaohongshuFailure()
          await handle.close(); handle = undefined; await chmod(filePath, 0o400); await own.ensure()
          return { file: filePath, mime }
        } finally { await response.close() }
      } finally { await handle?.close().catch(() => {}); own.close(); /* All partial files remain job-owned until final cleanup. */ }
    }
    async function image(input: string) {
      let source = input
      try { const parsed = new URL(source); if (parsed.hostname === 'ci.xiaohongshu.com') source = decodeURIComponent(parsed.pathname.replace(/^\/+/, '')).replace(/^http:/u, 'https:') } catch { throw xiaohongshuFailure() }
      let downloaded: Awaited<ReturnType<typeof download>>
      try { downloaded = await download(source, 'image') }
      catch { await guard.ensure(); const unsigned = xiaohongshuUnsignedImage(source); if (!unsigned || unsigned === source || !accessCheck(source)) throw xiaohongshuFailure(); downloaded = await download(unsigned, 'image') }
      if (['image/heic', 'image/heif'].includes(downloaded.mime)) { const converted = file('.jpg'); await douyinConvertImage(downloaded.file, converted, options.native, guard); return (await stage(converted, 'image', 'image/jpeg')) }
      return stage(downloaded.file, 'image', downloaded.mime)
    }
    async function video(url: string) {
      const downloaded = await download(url, 'video'), lease = await stage(downloaded.file, 'video', downloaded.mime)
      try { const thumbnailPath = file('.jpg'); await douyinThumbnail(downloaded.file, thumbnailPath, options.native, guard, downloaded.mime); const thumbnail = await stage(thumbnailPath, 'image', 'image/jpeg'); return { kind: 'video' as const, artifact: lease.artifact, thumbnail: thumbnail.artifact } }
      catch { await guard.ensure(); return { kind: 'video' as const, artifact: lease.artifact } }
    }
    try {
      await guard.ensure()
      if (context.readSourceAccess !== undefined) {
        if (typeof context.readSourceAccess !== 'function') throw xiaohongshuFailure()
        const value = await guard.wait(Promise.resolve().then(() => context.readSourceAccess!()))
        await guard.ensure(); access = value === undefined ? undefined : validateAgentXiaohongshuAccess(value)
      }
      if (access?.xsecToken) register([access.xsecToken], true)
      const parent = await guard.wait(realpath(options.directory))
      if (!(await guard.wait(lstat(parent))).isDirectory()) throw xiaohongshuFailure()
      directory = await guard.wait(mkdtemp(path.join(parent, 'xiaohongshu-')), late => rm(late, { recursive: true, force: true })); await chmod(directory, 0o700)
      let id = share.reference.kind === 'short' ? '' : share.reference.id, accessPage = xiaohongshuAccessPageUrl(share, access), metadata: AgentXiaohongshuResolvedMedia | undefined
      const metadataGuard = xiaohongshuGuard(guard.context, stageTime(8000))
      try {
        const response = await read(accessPage, 'page', metadataGuard, 2 * MiB)
        const landed = xiaohongshuPageIdentity(response.url)
        if (!landed || id && landed !== id) { await response.close(); throw xiaohongshuFailure() }
        id = landed; accessPage = response.url.href
        const landedRef = parseAgentXiaohongshuReference(accessPage), landedAccess = landedRef && readAgentXiaohongshuAccess(accessPage, landedRef)
        if (landedAccess) { access = { ...access, ...landedAccess, ...(access?.mediaKind === 'image' ? { mediaKind: 'image' as const } : {}) }; if (access.xsecToken) register([access.xsecToken], true) }
        const body = await xiaohongshuBody(response)
        // Page state legitimately contains its access token; check only extracted output fields.
        metadata = xiaohongshuDocumentMetadata(body.toString('utf8'), id, access?.mediaKind)
      } catch { await guard.ensure(); if (!id) throw xiaohongshuFailure() }
      finally { metadataGuard.close() }
      if (!metadata || metadata.kind === 'image' && !metadata.images.some(Boolean) || metadata.kind === 'video' && (!metadata.video || metadata.duration <= 0)) {
        const browserGuard = xiaohongshuGuard(guard.context, stageTime(25_000))
        try {
          const task = browserTail.then(async () => { await browserGuard.ensure(); return (options.browser ?? nativeAgentXiaohongshuBrowser)({ id, ...(access?.mediaKind ? { mediaKind: access.mediaKind } : {}), pageUrl: accessPage, directory }, browserGuard.context, read) })
          browserTail = task.catch(() => {})
          const resolved = await browserGuard.wait(task); if (resolved) metadata = resolved
        } catch { await guard.ensure() }
        finally { browserGuard.close() }
      }
      await guard.ensure()
      const media = metadata
      if (media && (media.id !== id || !['image', 'video'].includes(media.kind) || !Number.isFinite(media.duration) || media.duration < 0 || !Array.isArray(media.images) || media.images.length > 2000 || !Array.isArray(media.livePhotos) || media.livePhotos.length !== media.images.length ||
        ![[media.title, 300], [media.description, 2000], [media.author, 120]].every(([value, maximum]) => typeof value === 'string' && Array.from(value).length <= Number(maximum) && (!value || safeText(value))) ||
        [...media.images, ...media.livePhotos, media.video, media.cover].some(value => typeof value !== 'string' || value.length > 8192))) throw xiaohongshuFailure()
      const kind = access?.mediaKind === 'image' ? 'image' : media?.kind ?? access?.mediaKind ?? 'image', pageUrl = xiaohongshuCanonicalPage(id)
      const lines = [`分享了小红书笔记《${media?.title || '未命名笔记'}》`, `笔记:${id}`], items: AgentMediaRelayItem[] = []
      if (media?.author) lines.push(`作者:${media.author}`)
      if (media?.stats) { const labels: Readonly<Record<string, string>> = { liked: '点赞', collected: '收藏', comments: '评论' }; const stats = Object.entries(labels).filter(([key]) => Number.isSafeInteger(media.stats[key]) && media.stats[key]! >= 0).map(([key, label]) => `${label}:${media.stats[key]}`); if (stats.length) lines.push(`数据:${stats.join(' ')}`) }
      if (media?.description && media.description !== media.title) items.push({ parts: [{ kind: 'text', text: media.description }] })
      let cover: AgentMediaArtifactLease | undefined, ready = false
      if (kind === 'video' && media) {
        if (media.cover) { try { cover = await image(media.cover) } catch { await guard.ensure(); lines.push('封面暂时获取失败') } }
        if (media.duration > 1800) lines.push('视频超过30分钟，未附带视频本体')
        else if (media.duration <= 0) lines.push('视频时长未通过验证，已保留封面与笔记页面')
        else if (!media.video) lines.push('视频播放地址暂时获取失败，已保留封面与笔记页面')
        else { try { items.push({ parts: [await video(media.video)] }); ready = true } catch { await guard.ensure(); lines.push('视频本体暂时获取失败，附封面与原文') } }
      } else if (media) {
        const slots = (media.images.some(Boolean) ? media.images : media.cover ? [media.cover] : media.images).slice(0, 20), failed: number[] = []
        lines.push(`图片:${media.images.length}张`)
        for (const [index, imageUrl] of slots.entries()) {
          const live = media.livePhotos[index]
          if (live) { try { items.push({ parts: [await video(live)] }); ready = true; continue } catch { await guard.ensure() } }
          if (imageUrl) { try { const lease = await image(imageUrl); items.push({ parts: [{ kind: 'image', artifact: lease.artifact }] }); ready = true; continue } catch { await guard.ensure() } }
          failed.push(index + 1)
        }
        if (media.images.length > 20) lines.push(`笔记共${media.images.length}张图，仅附前20张`)
        if (failed.length) lines.push(`笔记第${failed.join('、')}张图片暂时获取失败，已保留其余内容和笔记页面`)
        if (!ready) lines.push('笔记图片暂时获取失败，已保留笔记页面')
      } else lines.push('小红书笔记详情暂时未解析完成，已保留笔记页面')
      lines.push(pageUrl)
      const infoText = lines.join('\n')
      if (!safeText(infoText)) throw xiaohongshuFailure()
      const plan = validateAgentMediaRelayPlan({ version: 1, items: [{ parts: [{ kind: 'text', text: infoText }, ...(cover ? [{ kind: 'image', artifact: cover.artifact } as const] : [])] }, ...items] }, { allowsText: safeText })
      await guard.ensure(); transferred = true
      return { status: ready ? 'ready' : 'metadata-only', pageUrl, infoText, plan, release } satisfies AgentPreparedMediaRelay
    } catch { throw xiaohongshuFailure() }
    finally { guard.close(); if (!transferred) await release(); if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {}) }
  } }
}
