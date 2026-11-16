import type { AgentToolContext, AgentToolRegistry, AgentToolResult } from '../../../contracts/agentTool.js'
import type { AgentMediaRelayProvider, AgentPreparedMediaRelay } from '../../../contracts/agentMediaRelayWorkflow.js'
import type { AgentInboxRedis } from '../../runtime/infrastructure/agentInbox.js'
import { isPlatformAccount, isPlatformIdentifier, samePlatformNamespace } from '../../runtime/domain/agentBindings.js'
import { createAgentSecretTextCheck } from '../../messaging/infrastructure/agentSecretText.js'
import { sanitizeFinalReplyText } from '../../conversation/domain/replySanitizer.js'
import { validateAgentToolImage } from '../../image/infrastructure/agentToolImage.js'
import { validateAgentMediaRelayPlan } from '../domain/agentMediaRelayPlan.js'
import { validateAgentMediaPreparedPageUrl } from './agentMediaRelayReference.js'
import { pixivGuard } from './agentPixivRelayHttp.js'
import type { AgentPixivSearchInput, AgentPixivSearchProvider, AgentPixivSearchResult } from './agentPixivSearchProvider.js'
import { createAgentPixivSessionStore, type AgentPixivAttempt, type AgentPixivSearchTicket, type AgentPixivSession, type AgentPixivSessionData } from './agentPixivSessionStore.js'

export interface AgentPixivToolsConfig { readonly enabled: boolean; readonly allowRestricted?: boolean }
export interface AgentPixivToolsOptions {
  readonly provider: AgentPixivSearchProvider
  readonly relayProvider: AgentMediaRelayProvider
  readonly storage: AgentInboxRedis
  readonly now?: () => number
  readonly secrets?: readonly string[]
  readonly allowsText?: (text: string) => boolean
}
const failure = () => new Error('Pixiv 请求或来源已不可用')
const failed = (): AgentToolResult => ({ status: 'failed', content: 'Pixiv 操作未完成，请检查参数、服务或当前会话权限。' })
const unknown = (): AgentToolResult => ({ status: 'unknown', content: 'Pixiv 投递结果尚未确认，请核实当前会话，不要重发或补发。' })
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) throw failure()
  return value as Record<string, unknown>
}
function receipt(value: unknown): 'sent' | 'failed' | 'unknown' {
  try {
    const row = object(value, ['state', 'messageId', 'code'])
    if (row.state === 'failed') return 'failed'
    return row.state === 'sent' && typeof row.messageId === 'string' && isPlatformIdentifier(row.messageId) && row.messageId !== '0' ? 'sent' : 'unknown'
  } catch { return 'unknown' }
}
function human(context: AgentToolContext): void {
  if (context.actor.kind !== 'user' || !context.actor.user || !isPlatformAccount(context.actor.user) ||
    !samePlatformNamespace(context.actor.user, context.binding.target.account) || context.actor.user.id === context.binding.target.account.id ||
    !context.request || !isPlatformIdentifier(context.request.messageId)) throw failure()
}

/** Model-selected Pixiv tools share source-scoped durable selection and at-most-once delivery. */
export function createAgentPixivTools(config: AgentPixivToolsConfig, options: AgentPixivToolsOptions): AgentToolRegistry {
  if (!config || typeof config.enabled !== 'boolean' || config.allowRestricted !== undefined && typeof config.allowRestricted !== 'boolean') throw failure()
  if (!config.enabled) return { builtIn: [] }
  const secretCheck = createAgentSecretTextCheck(options.secrets ?? [])
  const safe = (value: string): boolean => { try { return secretCheck(value) && options.allowsText?.(value) !== false && sanitizeFinalReplyText(value) === value } catch { return false } }
  const store = createAgentPixivSessionStore(options.storage, { ...(options.now ? { now: options.now } : {}), allowsText: safe })
  const string = (value: unknown, maximum: number): string => {
    if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value) || !safe(value)) throw failure()
    return value.trim()
  }
  const repeat = (state: string): AgentToolResult => state === 'sent' ? { status: 'succeeded', content: '这条 Pixiv 请求已确认投递，请不要重复发送。' }
    : state === 'failed' ? { status: 'failed', content: '这条 Pixiv 请求已处理且未确认投递成功，本轮不会重复执行。' } : unknown()
  const available = async (context: AgentToolContext, selected: AgentPixivSession): Promise<void> => {
    if (!context.isSourceAvailable || !await context.isSourceAvailable(selected.source)) throw failure()
  }
  const listing = (data: AgentPixivSessionData) => {
    const order = data.order === 'popular' ? data.orderSource === 'native' ? '原生人气排序' : data.orderSource === 'ranking' ? '官方榜单匹配' : '候选收藏数重排'
      : data.order === 'oldest' ? '最早作品' : '最新作品'
    return [`Pixiv ${data.mode === 'artist' ? '画师作品' : '搜索结果'}：${data.total} 项，${order}；展示前${Math.min(8, data.items.length)}项。`,
      ...data.items.slice(0, 8).map((item, index) => `${index + 1}. ${item.title} / ${item.userName || '未知画师'}${item.pageCount > 1 ? `（${item.pageCount}张）` : ''} [${item.id}]${item.xRestrict ? '（受限）' : ''}`),
      '回复「下载 序号」或「下载 作品ID」。列表保留5分钟，新搜索会替换当前列表；确认图片送达后续期。'].join('\n')
  }
  const normalize = (input: AgentPixivSearchResult): { result: AgentPixivSearchResult; data: AgentPixivSessionData } => {
    const raw = object(input, ['keyword', 'mode', 'order', 'orderSource', 'total', 'artist', 'items'])
    if (!Array.isArray(raw.items) || Object.getPrototypeOf(raw.items) !== Array.prototype || raw.items.length > 24 ||
      Reflect.ownKeys(raw.items).length !== raw.items.length + 1) throw failure()
    const items = Array.from({ length: raw.items.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(raw.items, String(index)); if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw failure()
      const row = object(descriptor.value, ['id', 'title', 'userName', 'userId', 'pageCount', 'xRestrict', 'bookmarkCount', 'thumbUrl'])
      // Only these text/count fields may enter the durable list; URLs remain task-local.
      if (row.thumbUrl !== undefined && (typeof row.thumbUrl !== 'string' || row.thumbUrl.length > 16_384)) throw failure()
      return { ...row } as unknown as AgentPixivSearchResult['items'][number]
    })
    const result = { ...raw, keyword: string(raw.keyword, 200), items } as unknown as AgentPixivSearchResult
    const { keyword: _keyword, ...withoutKeyword } = result
    const data = { ...withoutKeyword, items: items.slice(0, 20).map(({ thumbUrl: _thumb, ...item }) => item) }
    return { result, data }
  }
  return { builtIn: [{
    name: 'pixivSearchTool', dataPolicy: 'ephemeral', timeoutMs: 90_000,
    description: '搜索 Pixiv 插画或画师作品，发送前8项缩略图列表，保存5分钟供「下载 序号」选择。newest=最新、oldest=最早、popular=人气；画师查询用artist。',
    parameters: { type: 'object', additionalProperties: false, required: ['keyword'], properties: {
      keyword: { type: 'string', minLength: 1, maxLength: 200 }, searchType: { type: 'string', enum: ['artworks', 'artist'] },
      orderBy: { type: 'string', enum: ['newest', 'oldest', 'popular'] },
    } },
    async execute(input, context) {
      let attempt: AgentPixivAttempt | undefined, ticket: AgentPixivSearchTicket | undefined, sendStarted = false
      const guard = pixivGuard(context, 90_000)
      try {
        human(context)
        const raw = object(input, ['keyword', 'searchType', 'orderBy']), keyword = string(raw.keyword, 200)
        if (raw.searchType !== undefined && !['artworks', 'artist'].includes(raw.searchType as string) ||
          raw.orderBy !== undefined && !['newest', 'oldest', 'popular'].includes(raw.orderBy as string)) throw failure()
        await guard.ensure()
        const claim = await guard.wait(store.claimAttempt(context.binding, context.request!.messageId, 'search'))
        if (!claim.attempt) return repeat(claim.state)
        attempt = claim.attempt
        ticket = await guard.wait(store.begin(context.binding, { messageId: context.request!.messageId, author: context.actor.user! }))
        const current = async () => { await guard.ensure(); if (!await guard.wait(store.current(ticket!))) throw failure(); await guard.ensure() }
        const normalized = normalize(await guard.wait(options.provider.search({ keyword, ...(raw.searchType ? { searchType: raw.searchType as NonNullable<AgentPixivSearchInput['searchType']> } : {}),
          ...(raw.orderBy ? { orderBy: raw.orderBy as NonNullable<AgentPixivSearchInput['orderBy']> } : {}) }, guard.context)))
        await current()
        const session = await guard.wait(store.save(ticket, normalized.data), late => late && store.discard(late))
        if (!session) throw failure()
        const text = listing(session.data); if (!safe(text)) throw failure()
        let image: ReturnType<typeof validateAgentToolImage> | undefined
        try { if (context.sendImage) image = validateAgentToolImage(await guard.wait(options.provider.renderList(normalized.result, guard.context))) }
        catch { await current() }
        await current()
        if (!image || !context.sendImage) {
          await store.finishAttempt(attempt, 'failed'); attempt = undefined
          return { status: 'succeeded', content: `列表卡面未发送，以下为文字结果：\n${text}` }
        }
        if (!secretCheck(image.base64) || !secretCheck(Buffer.from(image.base64, 'base64').toString('utf8'))) throw failure()
        await current(); sendStarted = true
        const state = receipt(await guard.wait(context.sendImage(image)))
        await store.finishAttempt(attempt, state); attempt = undefined
        if (state === 'unknown') return unknown()
        await current()
        return state === 'sent' ? { status: 'succeeded', content: `Pixiv 前${Math.min(8, session.data.items.length)}项列表卡面已确认送达。列表保留5分钟，可回复「下载 序号」或「下载 作品ID」，不要重复发送列表。` }
          : { status: 'succeeded', content: `列表卡面投递明确失败，以下为文字结果：\n${text}` }
      } catch {
        if (ticket && !sendStarted) await store.discard(ticket).catch(() => {})
        if (attempt) await store.finishAttempt(attempt, sendStarted ? 'unknown' : 'failed').catch(() => {})
        return sendStarted ? unknown() : failed()
      } finally { guard.close() }
    },
  }, {
    name: 'pixivDownloadTool', dataPolicy: 'ephemeral', timeoutMs: 240_000,
    description: '将 Pixiv 作品的完整前5张可用图片一次合并发送到当前群。target是最近5分钟列表的序号1..8，或5..12位作品ID；受限作品默认不搬运。',
    parameters: { type: 'object', additionalProperties: false, required: ['target'], properties: { target: { type: 'string', minLength: 1, maxLength: 32 } } },
    async execute(input, context) {
      let attempt: AgentPixivAttempt | undefined, prepared: AgentPreparedMediaRelay | undefined, sendStarted = false, selected: AgentPixivSession | undefined
      const guard = pixivGuard({ signal: context.signal, isCurrent: () => context.isCurrent(), async ensureCurrent() {
        await context.ensureCurrent?.(); if (selected) await available(context, selected)
      } }, 240_000)
      try {
        human(context)
        if (!context.sendMediaRelay) throw failure()
        const raw = object(input, ['target']), target = string(raw.target, 32)
        let id: string
        if (/^[1-9]\d{4,11}$/u.test(target)) id = target
        else {
          const index = /^(?:#|No\.?|第)?([1-9]\d?)$/iu.exec(target)?.[1]
          if (!index || Number(index) > 8) throw failure()
          await guard.ensure(); selected = await guard.wait(store.load(context.binding))
          if (!selected) return { status: 'failed', content: '最近5分钟内没有可用的 Pixiv 列表，请先搜索或提供作品ID。' }
          await available(context, selected); await guard.ensure()
          const item = selected.data.items[Number(index) - 1]
          if (!item) throw failure()
          if (item.xRestrict && config.allowRestricted !== true) return { status: 'failed', content: '该 Pixiv 作品为受限内容，当前配置不搬运。' }
          id = item.id
        }
        await guard.ensure()
        const claim = await guard.wait(store.claimAttempt(context.binding, context.request!.messageId, 'download'))
        if (!claim.attempt) return repeat(claim.state)
        attempt = claim.attempt
        const share = { provider: 'pixiv' as const, reference: { kind: 'artwork' as const, id } }
        prepared = await guard.wait(options.relayProvider.prepare(share, guard.context), late => late.release())
        validateAgentMediaPreparedPageUrl(prepared.pageUrl, share)
        if (!safe(prepared.infoText) || prepared.status === 'restricted' && config.allowRestricted !== true) throw failure()
        const plan = validateAgentMediaRelayPlan(prepared.plan, { allowsText: safe }), parts = plan.items.flatMap(item => item.parts)
        if (parts.some(part => part.kind === 'video')) throw failure()
        const images = parts.filter(part => part.kind === 'image')
        if (images.length > 5 || images.some(part => part.artifact.sizeBytes > 16 * 1024 * 1024) ||
          images.reduce((sum, part) => sum + part.artifact.sizeBytes, 0) > 40 * 1024 * 1024) throw failure()
        await guard.ensure(); sendStarted = true
        const state = receipt(await guard.wait(context.sendMediaRelay(plan)))
        await store.finishAttempt(attempt, state); attempt = undefined
        if (state === 'unknown') return unknown()
        await guard.ensure()
        if (state === 'failed') return { status: 'failed', content: 'Pixiv 作品合并消息投递明确失败，本轮不会重发。' }
        if (selected && images.length) await store.touch(selected).catch(() => false)
        return { status: 'succeeded', content: `Pixiv 作品 ${id} 的${images.length ? `${images.length}张图片及说明` : '说明（未附带图片）'}已确认送达，请不要重复发送。` }
      } catch {
        if (attempt) await store.finishAttempt(attempt, sendStarted ? 'unknown' : 'failed').catch(() => {})
        return sendStarted ? unknown() : failed()
      } finally { guard.close(); await prepared?.release().catch(() => {}) }
    },
  }] }
}
