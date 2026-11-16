import path from 'node:path'
import { lstat, realpath } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import type { AgentMediaArtifactLease, AgentMediaRelayItem } from '../../../contracts/agentMediaRelay.js'
import type { AgentMediaRelayProvider, AgentPreparedMediaRelay } from '../../../contracts/agentMediaRelayWorkflow.js'
import { sanitizeFinalReplyText } from '../../conversation/domain/replySanitizer.js'
import { createAgentSecretTextCheck } from '../../messaging/infrastructure/agentSecretText.js'
import { validateAgentMediaRelayPlan } from '../domain/agentMediaRelayPlan.js'
import type { AgentMediaArtifactStore } from './agentMediaArtifactStore.js'
import { validateAgentMediaShare } from './agentMediaRelayReference.js'
import { createPixivHttp, normalizePixivCookie, pixivBody, pixivFailure, pixivGuard, pixivOfficialUrl } from './agentPixivRelayHttp.js'
import type { AgentPixivLookup, AgentPixivRequest } from './agentPixivRelayHttp.js'

export type { AgentPixivLookup, AgentPixivRequest, AgentPixivResponse, AgentPixivRequestPolicy } from './agentPixivRelayHttp.js'
export interface AgentPixivRelayProviderOptions {
  readonly directory: string
  readonly artifacts: AgentMediaArtifactStore
  readonly secrets?: readonly string[]
  readonly allowsText?: (text: string) => boolean
  readonly authCookie?: string
  readonly proxyUrl?: string
  readonly allowRestricted?: boolean
  readonly lookup?: AgentPixivLookup
  readonly request?: AgentPixivRequest
  readonly timeoutMs?: number
}
const MiB = 1024 * 1024, IMAGE_BYTES = 16 * MiB, TOTAL_BYTES = 40 * MiB
const imageMimes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'])
const row = (input: unknown): Record<string, unknown> => input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
function text(input: unknown, maximum: number): string {
  if (input === undefined || input === null || input === '') return ''
  if (typeof input !== 'string' || input.length > 128_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input)) throw pixivFailure()
  return Array.from(input.replace(/<br\s*\/?>/giu, '\n').replace(/<[^>]*>/gu, '').replace(/&amp;/giu, '&').replace(/&quot;/giu, '"').replace(/&#39;|&apos;/giu, "'").replace(/&lt;/giu, '<').replace(/&gt;/giu, '>').replace(/\s+/gu, ' ').trim()).slice(0, maximum).join('')
}
function integer(input: unknown, maximum: number): number | undefined { const value = typeof input === 'number' ? input : typeof input === 'string' && /^\d+$/u.test(input) ? Number(input) : NaN; return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : undefined }
export function createAgentPixivRelayProvider(options: AgentPixivRelayProviderOptions): AgentMediaRelayProvider {
  if (!options || typeof options.directory !== 'string' || !path.isAbsolute(options.directory) || !options.artifacts || typeof options.artifacts.stage !== 'function' || options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) || options.allowRestricted !== undefined && typeof options.allowRestricted !== 'boolean') throw pixivFailure()
  const cookie = normalizePixivCookie(options.authCookie), secrets = [...options.secrets ?? [], ...(cookie ? [cookie, ...cookie.split(';').map(part => part.trim().split('=').slice(1).join('=')).filter(Boolean)] : [])]
  if (options.proxyUrl) { try { const proxy = new URL(options.proxyUrl); secrets.push(options.proxyUrl, proxy.href); for (const value of [proxy.username, proxy.password]) if (value) secrets.push(value, decodeURIComponent(value)) } catch { throw pixivFailure() } }
  const secretCheck = createAgentSecretTextCheck(secrets)
  const allows = (value: string) => { try { return secretCheck(value) && options.allowsText?.(value) !== false } catch { return false } }
  const safeText = (value: string) => sanitizeFinalReplyText(value) === value && allows(value)
  const read = createPixivHttp({ ...(options.lookup ? { lookup: options.lookup } : {}), ...(options.request ? { request: options.request } : {}), ...(options.proxyUrl ? { proxyUrl: options.proxyUrl } : {}), ...(cookie ? { authCookie: cookie } : {}), allows })
  const stageTime = (maximum: number) => Math.min(maximum, options.timeoutMs ?? maximum)
  return { async prepare(input, context) {
    const share = validateAgentMediaShare(input)
    if (share.provider !== 'pixiv') throw pixivFailure()
    const id = share.reference.id, pageUrl = `https://www.pixiv.net/artworks/${id}`, leases: AgentMediaArtifactLease[] = [], guard = pixivGuard(context, stageTime(460_000))
    let transferred = false, released: Promise<void> | undefined
    const release = () => released ??= Promise.allSettled(leases.map(lease => lease.release())).then(() => {})
    try {
      await guard.ensure()
      const directory = await guard.wait(realpath(options.directory)), stat = await guard.wait(lstat(directory))
      if (!stat.isDirectory()) throw pixivFailure()
      const metadataGuard = pixivGuard(guard.context, stageTime(7000))
      const json = async (suffix: string): Promise<unknown> => {
        const response = await read(`https://www.pixiv.net/ajax/illust/${id}${suffix}`, 'metadata', metadataGuard, 2 * MiB, { id })
        try {
          if (response.mime !== 'application/json') throw pixivFailure()
          const body = (await pixivBody(response)).toString('utf8')
          if (!secretCheck(body)) throw pixivFailure()
          const parsed = row(JSON.parse(body)); if (parsed.error !== false || !Object.hasOwn(parsed, 'body')) throw pixivFailure()
          return parsed.body
        } finally { await response.close() }
      }
      let detail: PromiseSettledResult<unknown>, pages: PromiseSettledResult<unknown>
      try { [detail, pages] = await Promise.allSettled([json(''), json('/pages')]) } finally { metadataGuard.close() }
      await guard.ensure()
      let body: Record<string, unknown> | undefined, title = '未命名作品', description = '', author = '', count = 1, restricted: number | undefined, slots: string[] = [], failed: number[] = [], ready = false, fallback = false, total = 0
      const lines: string[] = []
      if (detail.status === 'fulfilled') {
        const candidate = row(detail.value)
        if ((typeof candidate.id === 'string' || Number.isSafeInteger(candidate.id)) && String(candidate.id) === id) {
          body = candidate
          title = text(body.title, 300) || title; description = text(body.description, 240); author = text(body.userName, 120)
          count = integer(body.pageCount, 2000) ?? 1; if (!count) throw pixivFailure()
          const restriction = integer(body.xRestrict, 2)
          // Unknown restriction is not a verified public work; retain its metadata only.
          restricted = restriction
          const pick = (value: unknown, index: number): string => {
            const urls = row(value)
            for (const candidate of [urls.regular, urls.small, urls.original]) {
              if (typeof candidate !== 'string') continue
              try { const url = pixivOfficialUrl(candidate, 'image', { id, index }); if (allows(url.href)) return url.href } catch {}
            }
            return ''
          }
          if (pages.status === 'fulfilled' && Array.isArray(pages.value) && pages.value.length <= 2000) slots = Array.from({ length: count }, (_, index) => pick(row((pages.value as unknown[])[index]).urls, index))
          if (!slots.some(Boolean)) { const single = pick(body.urls, 0); slots = Array.from({ length: count }, (_, index) => index === 0 ? single : ''); fallback = Boolean(single) }
        }
      }
      if (!body) lines.push('Pixiv 作品详情暂时未解析完成，已保留作品页面')
      if (author) lines.push(`画师:${author}`)
      lines.push(`作品:${id}`)
      if (body) {
        lines.push(`页数:${count}`)
        const width = integer(body.width, 100_000), height = integer(body.height, 100_000); if (width && height) lines.push(`尺寸:${width}x${height}`)
        const tags = (Array.isArray(row(body.tags).tags) ? row(body.tags).tags : Array.isArray(body.tags) ? body.tags : []) as unknown[]
        if (tags.length > 2000) throw pixivFailure()
        const displayTags = tags.slice(0, 20).map(value => text(row(value).tag ?? value, 80)).filter(Boolean); if (displayTags.length) lines.push(`标签:${displayTags.join('、')}`)
        const stats = Object.entries({ 浏览: body.viewCount, 点赞: body.likeCount, 收藏: body.bookmarkCount, 评论: body.commentCount }).flatMap(([label, raw]) => { const value = integer(raw, Number.MAX_SAFE_INTEGER); return value === undefined ? [] : [`${label}:${value}`] }); if (stats.length) lines.push(`数据:${stats.join(' ')}`)
        if (description) lines.push(`简介:${description}`)
      }
      const items: AgentMediaRelayItem[] = []
      if (body && restricted === undefined) lines.push('该 Pixiv 作品的受限标记未能验证，未自动附带图片')
      else if (body && restricted! > 0 && options.allowRestricted !== true) lines.push('该 Pixiv 作品标记为受限内容，未自动附带图片')
      else if (body) {
        if (fallback) lines.push('分页信息暂时不可用，已使用作品首页图片')
        if (count > 5) lines.push(`作品共${count}页，仅附前5页`)
        const totalSkipped: number[] = [], oversized: number[] = []
        for (let index = 0; index < Math.min(count, 5); index++) {
          const url = slots[index]
          if (!url) { failed.push(index + 1); continue }
          const remaining = TOTAL_BYTES - total
          if (remaining <= 0) { totalSkipped.push(index + 1); continue }
          const own = pixivGuard(guard.context, stageTime(90_000)), imageLimit = Math.min(IMAGE_BYTES, remaining)
          let imageConsumed = 0
          try {
            const response = await read(url, 'image', own, imageLimit, { id, index }, consumed => { total += consumed; imageConsumed += consumed })
            try {
              const mime = response.mime === 'image/jpg' ? 'image/jpeg' : response.mime
              if (!imageMimes.has(mime)) throw pixivFailure()
              const chunks = (async function* () {
                const decoder = new StringDecoder('utf8'), window = Math.max(512, ...secrets.map(value => Buffer.byteLength(value) * 8 + 32)); let tail = ''
                for await (const bytes of response.chunks) {
                  await own.ensure(); if (total > TOTAL_BYTES) throw pixivFailure()
                  const content = tail + decoder.write(Buffer.from(bytes)); if (!secretCheck(content)) throw pixivFailure(); tail = content.slice(-window); yield bytes
                }
                if (!secretCheck(tail + decoder.end())) throw pixivFailure()
              })()
              const lease = await own.wait(options.artifacts.stage({ kind: 'image', mime, chunks }, own.context), late => late.release()); leases.push(lease)
              await own.ensure(); items.push({ parts: [{ kind: 'image', artifact: lease.artifact }] }); ready = true
            } finally { await response.close() }
          } catch (error) { await guard.ensure(); if (imageConsumed > imageLimit || error && typeof error === 'object' && 'code' in error && error.code === 'pixiv_bytes_limit') { if (remaining < IMAGE_BYTES) totalSkipped.push(index + 1); else oversized.push(index + 1) } else failed.push(index + 1) }
          finally { own.close() }
        }
        if (failed.length) lines.push(`第${failed.join('、')}页图片暂时获取失败或来源未通过验证，已保留其余页面`)
        if (oversized.length) lines.push(`第${oversized.join('、')}页超过单图16MiB上限，未附带`)
        if (totalSkipped.length || total >= TOTAL_BYTES) lines.push(`图片合计受40MiB预算限制${totalSkipped.length ? `，第${totalSkipped.join('、')}页未附带` : ''}`)
        if (!ready) lines.push('作品图片暂时获取失败，已保留作品页面')
      }
      const infoText = [`分享了 Pixiv 作品《${title}》`, ...lines, pageUrl].join('\n')
      if (!safeText(infoText)) throw pixivFailure()
      const plan = validateAgentMediaRelayPlan({ version: 1, items: [{ parts: [{ kind: 'text', text: infoText }] }, ...items] }, { allowsText: safeText })
      await guard.ensure(); transferred = true
      return { status: body && restricted !== undefined && restricted > 0 && options.allowRestricted !== true ? 'restricted' : ready ? 'ready' : 'metadata-only', pageUrl, infoText, plan, release } satisfies AgentPreparedMediaRelay
    } catch { throw pixivFailure() }
    finally { guard.close(); if (!transferred) await release() }
  } }
}
