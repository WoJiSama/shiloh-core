import { types } from 'node:util'
import type { AgentToolContext, AgentToolRegistry, AgentToolResult } from '../../../contracts/agentTool.js'
import { agentBindingToken, isConversationAddress, isPlatformAccount, isPlatformIdentifier, samePlatformNamespace } from '../../runtime/domain/agentBindings.js'
import { createAgentSecretTextCheck } from '../../messaging/infrastructure/agentSecretText.js'
import { validateMessageBundle } from '../../messaging/infrastructure/messageBundle.js'
import { abortableAgentWeb, boundedAgentWebTimeout, ensureAgentWebCurrent } from '../../tools/infrastructure/agentPublicWeb.js'
import { createAgentImageSearchProvider, type AgentImageSearchProviderOptions } from './agentImageSearchProvider.js'
export type { AgentImageSearchHttpDependencies, AgentImageSearchRequest, AgentImageSearchHttpResponse, AgentImageSearchRequestPolicy } from './agentImageSearchHttp.js'

export interface AgentImageSearchToolsOptions extends AgentImageSearchProviderOptions {
  readonly emoji?: { readonly enabled: boolean }
  readonly bing?: { readonly enabled: boolean }
  readonly allowsText?: (text: string) => boolean
  /** May shorten the complete search and delivery operation's 90s deadline. */
  readonly timeoutMs?: number
}
const failed = (): AgentToolResult => ({ status: 'failed', content: '图片搜索未完成：参数、来源、服务或图片不符合要求，没有确认图片送达。' })
const unknown = (): AgentToolResult => ({ status: 'unknown', content: '图片投递结果尚未确认，请核实当前会话；本轮不会重发或补发。' })
const invalid = () => new Error('图片搜索来源不可用')
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) throw invalid()
  return value as Record<string, unknown>
}
function identity(context: AgentToolContext): string {
  const { binding, actor, request } = context
  if (!binding || !isConversationAddress(binding.target) || !['configured', 'legacy'].includes(binding.source) ||
      ![binding.id, binding.agentId, binding.revision, binding.personaId, binding.connectionId].every(isPlatformIdentifier) ||
      actor.kind !== 'user' || !isPlatformAccount(actor.user) || !samePlatformNamespace(actor.user, binding.target.account) ||
      actor.user.id === binding.target.account.id || !request || !isPlatformIdentifier(request.messageId) || typeof request.text !== 'string') throw invalid()
  return JSON.stringify([agentBindingToken(binding), binding.target, actor.user, request.messageId, request.text, request.occurredAt, request.replyMessageId])
}

/** Fixed-target image search uses one delivery attempt; no URL, path or native platform event crosses the tool result. */
export function createAgentImageSearchTools(options: AgentImageSearchToolsOptions = {}): AgentToolRegistry {
  for (const selected of [options.emoji, options.bing]) if (selected !== undefined) {
    const row = closed(selected, ['enabled']); if (typeof row.enabled !== 'boolean') throw invalid()
  }
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 90_000) ||
      options.allowsText !== undefined && typeof options.allowsText !== 'function' || options.secrets !== undefined &&
      (!Array.isArray(options.secrets) || options.secrets.length > 256 || options.secrets.some(secret => typeof secret !== 'string' || secret.length > 32768))) throw invalid()
  const secrets = createAgentSecretTextCheck(options.secrets ?? []), provider = createAgentImageSearchProvider(options)
  return { builtIn: (['emoji', 'bing'] as const).filter(kind => options[kind]?.enabled === true).map(kind => ({
    name: kind === 'emoji' ? 'emojiSearchTool' : 'bingImageSearchTool', timeoutMs: 90_000,
    description: kind === 'emoji' ? '按关键词搜索表情包，将核验过的图片发送到当前会话；成功回执才表示已送达，不要重复发送。' :
      '按关键词搜索图片和壁纸，将核验过的图片发送到当前会话；成功回执才表示已送达，不要重复发送。',
    parameters: { type: 'object' as const, additionalProperties: false, required: [kind === 'emoji' ? 'keyword' : 'query'], properties: {
      [kind === 'emoji' ? 'keyword' : 'query']: { type: 'string', minLength: 1, maxLength: 200 },
      count: { type: 'integer', minimum: 1, maximum: 10, default: kind === 'emoji' ? 1 : 10 },
    } },
    async execute(input: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult> {
      const lifetime = new AbortController(), signal = AbortSignal.any([context.signal, lifetime.signal, AbortSignal.timeout(boundedAgentWebTimeout(options.timeoutMs, 90_000))])
      let sending = false
      try {
        const key = kind === 'emoji' ? 'keyword' : 'query', value = closed(input, [key, 'count']), keyword = value[key], count = value.count ?? (kind === 'emoji' ? 1 : 10)
        if (typeof keyword !== 'string' || !keyword.trim() || keyword.length > 200 || /[\u0000-\u001f\u007f]/u.test(keyword) ||
            !secrets(keyword) || options.allowsText?.(keyword) === false || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > 10 ||
            count === 1 && !context.sendImage && !context.sendBundle || count > 1 && !context.sendBundle) return failed()
        const captured = identity(context), isCurrent = () => {
          try { return !signal.aborted && identity(context) === captured && context.isCurrent() } catch { return false }
        }
        const scoped = { ...context, signal, isCurrent, ensureCurrent: async () => {
          if (!isCurrent()) throw invalid()
          await context.ensureCurrent?.()
          if (!isCurrent()) throw invalid()
        } }
        const ensure = () => ensureAgentWebCurrent(scoped)
        await ensure()
        const images = await provider.search(kind, keyword.trim(), count, scoped)
        await ensure()
        if (!images.length) return { status: 'failed', content: '未找到符合要求的可用图片，本轮没有发送图片。' }
        const bundle = validateMessageBundle(images.map(image => ({ parts: [{ kind: 'image', ...image }] })))
        await ensure()
        sending = true
        const receipt = await abortableAgentWeb(images.length === 1 && context.sendImage
          ? context.sendImage(images[0]!) : context.sendBundle!(bundle), signal)
        await ensure()
        if (receipt.state === 'failed') return failed()
        if (receipt.state !== 'sent' || !isPlatformIdentifier(receipt.messageId) || receipt.messageId === '0') return unknown()
        return { status: 'succeeded', content: `图片搜索完成，已确认向当前会话发送 ${images.length} 张图片${images.length < count ? `（请求 ${count} 张，其余无符合要求的图片）` : ''}。不要重复发送图片或输出图片地址。` }
      } catch { return sending ? unknown() : failed() }
      finally { lifetime.abort() }
    },
  })) }
}
