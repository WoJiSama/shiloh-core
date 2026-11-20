import { types } from 'node:util'
import type { AgentTool, AgentToolContext, AgentToolRegistry, AgentToolResult } from '../../../contracts/agentTool.js'
import type { AgentMediaRelayProvider, AgentPreparedMediaRelay } from '../../../contracts/agentMediaRelayWorkflow.js'
import { validateAgentMediaRelayPlan } from '../domain/agentMediaRelayPlan.js'
import type { AgentVideoCard, AgentVideoSearchProvider } from '../../../contracts/agentVideoCard.js'
import type { AgentInboxRedis } from '../../runtime/infrastructure/agentInbox.js'
import type { AgentDiagnostics } from '../../runtime/infrastructure/agentDiagnostics.js'
import { isPlatformAccount, isPlatformIdentifier, samePlatformNamespace } from '../../runtime/domain/agentBindings.js'
import { sanitizeFinalReplyText } from '../../conversation/domain/replySanitizer.js'
import { createAgentSecretTextCheck } from '../../messaging/infrastructure/agentSecretText.js'
import { validateAgentVideoCard } from './agentVideoCard.js'
import { bilibiliGuard } from './agentBilibiliRelayHttp.js'
import { createAgentVideoSearchStore, type AgentVideoSearchSession, type AgentVideoSearchTicket, type AgentVideoShareAttempt, type AgentVideoShareState } from './agentVideoSearchStore.js'
import { captureAgentToolSourceGuard } from '../../runtime/infrastructure/agentToolSourceGuard.js'

export interface AgentVideoSearchToolsConfig { readonly enabled: boolean }
export interface AgentVideoSearchToolsOptions {
  readonly storage: AgentInboxRedis
  readonly provider: AgentVideoSearchProvider
  /** Anonymous bounded attachments, independent of metadata search and card sharing. */
  readonly attachmentProvider?: AgentMediaRelayProvider
  readonly diagnostics?: Pick<AgentDiagnostics, 'emit' | 'traceId'>
  readonly allowsText?: (text: string) => boolean
  readonly secrets?: readonly string[]
  readonly now?: () => number
}
const failure = () => new Error('视频查询、来源或当前会话权限已不可用')
const failed = (): AgentToolResult => ({ status: 'failed', content: '视频操作未完成，未确认发送。请按工具结果检查查询、选择或当前来源权限。' })
const unknown = (): AgentToolResult => ({ status: 'unknown', content: '视频投递结果尚未确认，可能已经发送，请核实当前会话，不要重发或补发。' })
function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).some(key => typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value'))) throw failure()
  return input as Record<string, unknown>
}
function human(context: AgentToolContext): void {
  if (context.actor.kind !== 'user' || !context.actor.user || !isPlatformAccount(context.actor.user) ||
    !samePlatformNamespace(context.actor.user, context.binding.target.account) || [context.binding.target.account.id, context.botUserId].includes(context.actor.user.id) ||
    !context.request || !isPlatformIdentifier(context.request.messageId) || context.request.messageId === '0' || typeof context.request.text !== 'string' ||
    !context.isSourceAvailable) throw failure()
}
function receipt(value: unknown): Exclude<AgentVideoShareState, 'pending'> {
  try {
    const row = object(value, ['state', 'messageId', 'code'])
    if (row.state === 'failed') return 'failed'
    return row.state === 'sent' && isPlatformIdentifier(row.messageId) && row.messageId !== '0' ? 'sent' : 'unknown'
  } catch { return 'unknown' }
}

/** Search is metadata only. Human requests explicitly select a card or an optional bounded attachment. */
export function createAgentVideoSearchTools(config: AgentVideoSearchToolsConfig, options: AgentVideoSearchToolsOptions): AgentToolRegistry {
  const value = object(config, ['enabled'])
  if (typeof value.enabled !== 'boolean') throw failure()
  if (!value.enabled) return { builtIn: [] }
  const secrets = createAgentSecretTextCheck(options.secrets ?? [])
  const safe = (text: string) => { try { return secrets(text) && options.allowsText?.(text) !== false && sanitizeFinalReplyText(text) === text } catch { return false } }
  const store = createAgentVideoSearchStore(options.storage, { ...(options.now ? { now: options.now } : {}), allowsText: safe })
  const string = (input: unknown, maximum: number): string => {
    if (typeof input !== 'string' || !input.trim() || Array.from(input).length > maximum || /[\u0000-\u001f\u007f-\u009f]/u.test(input) || !safe(input)) throw failure()
    return input.trim()
  }
  const emit = (operation: string, outcome: 'succeeded' | 'failed' | 'unknown' | 'cancelled', code: string) => {
    try { if (options.diagnostics) { options.diagnostics.emit({ stage: 'tool', operation, outcome, code }); return } } catch { /* Fixed metadata remains observable through the fallback. */ }
    try { console.error(`[Agent] tool/${operation} ${outcome} ${code}`) } catch { /* No remaining writable observer. */ }
  }
  const source = (context: AgentToolContext) => ({ messageId: context.request!.messageId, author: context.actor.user! })
  const guardFor = (context: AgentToolContext, selected: () => AgentVideoSearchTicket | undefined, timeoutMs = 45_000) => {
    const owned = captureAgentToolSourceGuard(context)
    return bilibiliGuard({
      signal: context.signal, isCurrent: () => context.isCurrent(),
      async ensureCurrent() {
        // The owned validator reads the complete current request on every call.
        // Only its exact source identity can reuse that validator; a list from
        // another request still needs its own fresh source authorization.
        if (owned) await owned()
        else await context.ensureCurrent?.()
        if (!context.isSourceAvailable || !owned?.matchesSource(source(context)) && !await context.isSourceAvailable(source(context))) throw failure()
        const original = selected()
        if (original && (!owned?.matchesSource(original.source) && !await context.isSourceAvailable(original.source) || !await store.current(original))) throw failure()
        if (!context.isCurrent() || context.signal.aborted) throw failure()
      },
    }, timeoutMs)
  }
  const list = (items: readonly AgentVideoCard[]) => items.length ? [
    'B站视频搜索结果（按相关度，1 为首选）：',
    ...items.map((card, index) => `${index + 1}. ${card.title} / ${card.author || '未知作者'} / ${card.durationSeconds}秒 [${card.id}]\n${card.pageUrl}`),
    '这里只完成查询，尚未发送视频卡片。列表保留5分钟，新搜索替换旧列表；可明确选择一个序号或视频ID再发送。',
  ].join('\n') : '没有找到可用的B站视频，尚未发送视频卡片。可调整关键词后重新搜索。'
  const repeat = (state: AgentVideoShareState): AgentToolResult => state === 'sent'
    ? { status: 'succeeded', content: '这条请求已有视频投递确认，请核实原消息，不要重复发送。' }
    : state === 'failed' ? { status: 'failed', content: '这条视频请求已处理且未确认发送成功，本轮不会重复执行。' } : unknown()
  const deliveryTool = (download: boolean): AgentTool => {
    const operation = download ? 'video_download' : 'video_share'
    const release = async (value: AgentPreparedMediaRelay) => {
      try {
        if (!value || typeof value !== 'object' || types.isProxy(value)) throw failure()
        const descriptor = Object.getOwnPropertyDescriptor(value, 'release')
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function' || types.isProxy(descriptor.value)) throw failure()
        await Reflect.apply(descriptor.value, value, [])
      } catch { emit(operation, 'failed', 'prepared_release_failed') }
    }
    return {
      name: download ? 'videoDownloadTool' : 'videoShareTool', timeoutMs: download ? 240_000 : 45_000,
      effect: download
        ? { actor: 'user', conversation: 'group', required: ['isSourceAvailable', 'sendMediaRelay'], metadata: ['request', 'botUserId'] }
        : { actor: 'user', required: ['isSourceAvailable', 'sendVideoCard'], metadata: ['request', 'botUserId'] },
      description: download
        ? '将一个B站视频的完整匿名低清附件及说明一次发送到当前群，最多两段且每段30MiB。id/index只能选择最近5分钟搜索列表；url/query必须在当前真人请求中明确提供，四选一。查询不自动下载，高清仍用专用授权命令。'
        : '发送一个B站视频卡片到当前会话：id/index只能选择最近5分钟搜索列表；url/query必须由当前真人请求明确提供。一次请求只发送一次。',
      parameters: { type: 'object', additionalProperties: false, required: [], properties: {
        id: { type: 'string', pattern: '^(?:BV[0-9A-Za-z]{10}|ep[1-9][0-9]{0,19})$' }, index: { type: 'integer', minimum: 1, maximum: 8 },
        url: { type: 'string', minLength: 1, maxLength: 2048 }, query: { type: 'string', minLength: 1, maxLength: 200 },
      } },
      async execute(input, context) {
        let selected: AgentVideoSearchSession | undefined, attempt: AgentVideoShareAttempt | undefined,
          guard: ReturnType<typeof guardFor> | undefined, sending = false, prepared: AgentPreparedMediaRelay | undefined
        try {
          human(context)
          if (download ? context.binding.target.kind !== 'group' || !options.attachmentProvider || !context.sendMediaRelay : !context.sendVideoCard) throw failure()
          const row = object(input, ['id', 'index', 'url', 'query'])
          if (Object.keys(row).length !== 1) throw failure()
          if (row.id !== undefined && (typeof row.id !== 'string' || !/^(?:BV[0-9A-Za-z]{10}|ep[1-9]\d{0,19})$/u.test(row.id) || !safe(row.id)) ||
            row.index !== undefined && (typeof row.index !== 'number' || !Number.isSafeInteger(row.index) || row.index < 1 || row.index > 8)) throw failure()
          const direct = row.url === undefined && row.query === undefined ? undefined : row.url !== undefined
            ? { url: string(row.url, 2048) } : { query: string(row.query, 200) }
          let expectedId: string | undefined
          if (direct) {
            const explicit = 'url' in direct ? direct.url : direct.query
            if (!context.request!.text.includes(explicit)) throw failure()
            if ('url' in direct) {
              const url = new URL(direct.url)
              if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.search ||
                !(['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(url.hostname) && /^(?:\/video\/BV[0-9A-Za-z]{10}|\/bangumi\/play\/ep[1-9]\d{0,19})\/?$/u.test(url.pathname) ||
                  url.hostname === 'b23.tv' && /^\/[A-Za-z0-9_-]{1,128}\/?$/u.test(url.pathname))) throw failure()
              expectedId = /^\/(?:video|bangumi\/play)\/(BV[0-9A-Za-z]{10}|ep[1-9]\d{0,19})\/?$/u.exec(url.pathname)?.[1]
            }
          }
          guard = guardFor(context, () => selected, download ? 240_000 : 45_000)
          await guard.wait(Promise.resolve().then(() => context.ensureCurrent?.()))
          await guard.ensure()
          let card: AgentVideoCard | undefined
          if (!direct) {
            selected = await guard.wait(store.load(context.binding))
            if (!selected) throw failure()
            await guard.ensure()
            const item = row.id === undefined ? selected.items[(row.index as number) - 1] : selected.items.find(item => item.id === row.id)
            if (!item) throw failure()
            card = validateAgentVideoCard(item, safe)
          }
          await guard.ensure()
          const claim = await guard.wait(store.claimShare(context.binding, source(context)))
          if (!claim.attempt) return repeat(claim.state)
          attempt = claim.attempt
          if (direct) card = validateAgentVideoCard(await guard.wait(options.provider.resolve(direct, guard.context)), safe)
          if (!card || expectedId && card.id !== expectedId) throw failure()
          await guard.ensure()
          let state: Exclude<AgentVideoShareState, 'pending'>
          if (download) {
            const share = { provider: 'bilibili' as const, reference: /^ep/u.test(card.id)
              ? { kind: 'episode' as const, id: card.id.slice(2) } : { kind: 'video' as const, id: card.id } }
            prepared = await guard.wait(options.attachmentProvider!.prepare(share, guard.context), release)
            const result = object(prepared, ['status', 'pageUrl', 'infoText', 'plan', 'release'])
            if (result.status !== 'ready' || result.pageUrl !== card.pageUrl || typeof result.infoText !== 'string' || !safe(result.infoText) ||
                typeof result.release !== 'function' || types.isProxy(result.release)) throw failure()
            const plan = validateAgentMediaRelayPlan(result.plan, { allowsText: safe }), parts = plan.items.flatMap(item => item.parts)
            const videos = parts.filter(part => part.kind === 'video')
            const text = parts.flatMap(part => part.kind === 'text' ? [part.text] : []).join('\n')
            if (!videos.length || videos.length > 2 || videos.some(part => part.artifact.sizeBytes > 30 * 1024 * 1024) || !safe(text)) throw failure()
            await guard.ensure(); sending = true
            state = receipt(await guard.wait(context.sendMediaRelay!(plan, guard.context)))
          } else {
            // This is the only outbound call; query/resolve cannot choose a target.
            sending = true
            state = receipt(await guard.wait(context.sendVideoCard!(card, guard.context)))
          }
          try { await store.finishShare(attempt, state) }
          catch { emit(operation, 'unknown', 'delivery_receipt_store_failed'); throw failure() }
          attempt = undefined
          emit(operation, state === 'sent' ? 'succeeded' : state, state === 'sent' ? 'delivery_confirmed' : state === 'failed' ? 'delivery_rejected' : 'delivery_unconfirmed')
          if (state === 'unknown') return unknown()
          await guard.ensure()
          return state === 'sent' ? { status: 'succeeded', content: download
            ? '视频完整低清附件及说明已确认发送到当前群，请不要重复发送。'
            : '视频卡片已确认发送到当前会话，请不要重复发送。' } : failed()
        } catch {
          if (attempt) try { await store.finishShare(attempt, sending ? 'unknown' : 'failed') }
          catch { emit(operation, sending ? 'unknown' : 'failed', 'attempt_store_failed') }
          emit(operation, sending ? 'unknown' : 'failed', sending ? 'delivery_unconfirmed' : 'selection_prepare_or_source_unavailable')
          return sending ? unknown() : failed()
        } finally { guard?.close(); if (prepared) await release(prepared) }
      },
    }
  }
  const searchTools: AgentTool[] = [{
    name: 'searchVideoTool', timeoutMs: 45_000,
    effect: { actor: 'user', required: ['isSourceAvailable'], metadata: ['request', 'botUserId'] },
    description: '查询B站视频，按相关度返回最多8个结果，第一条为首选，保存5分钟供明确选择；查询本身不会发送视频卡片。',
    parameters: { type: 'object', additionalProperties: false, required: ['keyword'], properties: { keyword: { type: 'string', minLength: 1, maxLength: 200 } } },
    async execute(input, context) {
      let ticket: AgentVideoSearchTicket | undefined, guard: ReturnType<typeof guardFor> | undefined
      try {
        human(context)
        const row = object(input, ['keyword']), keyword = string(row.keyword, 200)
        guard = guardFor(context, () => ticket)
        await guard.wait(Promise.resolve().then(() => context.ensureCurrent?.()))
        await guard.ensure()
        ticket = await guard.wait(store.begin(context.binding, source(context)))
        await guard.ensure()
        const result = object(await guard.wait(options.provider.search(keyword, guard.context)), ['items'])
        if (!Array.isArray(result.items) || types.isProxy(result.items) || Object.getPrototypeOf(result.items) !== Array.prototype ||
          result.items.length > 50 || Reflect.ownKeys(result.items).length !== result.items.length + 1) throw failure()
        const items: AgentVideoCard[] = [], seen = new Set<string>()
        for (let index = 0; index < result.items.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(result.items, String(index)); if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw failure()
          const card = validateAgentVideoCard(descriptor.value, safe)
          if (!seen.has(card.id)) { seen.add(card.id); if (items.length < 8) items.push(card) }
        }
        await guard.ensure()
        const saved = await guard.wait(store.save(ticket, items), late => late && store.discard(late))
        if (!saved) throw failure()
        await guard.ensure()
        const content = list(saved.items); if (!safe(content)) throw failure()
        emit('video_search', 'succeeded', 'source_backed_list_ready')
        return { status: 'succeeded', content }
      } catch {
        if (ticket) await store.discard(ticket).catch(() => {})
        emit('video_search', 'failed', 'query_or_source_unavailable')
        return failed()
      } finally { guard?.close() }
    },
  }]
  return { builtIn: [...searchTools, deliveryTool(false), ...(options.attachmentProvider ? [deliveryTool(true)] : [])] }
}
