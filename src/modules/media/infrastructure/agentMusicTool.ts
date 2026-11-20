import type { AgentTool, AgentToolContext, AgentToolResult } from '../../../contracts/agentTool.js'
import { createAgentSecretTextCheck } from '../../messaging/infrastructure/agentSecretText.js'
import { abortableMusic, createAgentMusicProvider, ensureMusicCurrent, type AgentMusicConfig, type AgentMusicProvider, type AgentMusicProviderOptions } from './agentMusicProvider.js'

export type { AgentMusicConfig } from './agentMusicProvider.js'
export { createAgentMusicProvider } from './agentMusicProvider.js'
export type { AgentMusicProviderOptions, AgentMusicContext, AgentMusicProvider, AgentMusicSearchInput, AgentMusicSearchResult } from './agentMusicProvider.js'
export interface AgentMusicToolOptions extends AgentMusicProviderOptions {
  /** Hosts share this credential service with their authorized background refresh job. */
  readonly provider?: AgentMusicProvider
}
const MAX_MS = 90_000
const failed = (): AgentToolResult => ({ status: 'failed', content: '音乐搜索或发送失败，请检查关键词、音乐服务或当前会话权限。' })
const unknown = (): AgentToolResult => ({ status: 'unknown', content: '音乐卡片投递结果尚未确认，请先核实当前会话，不要重试或重复发送。' })
function validInput(input: unknown): input is { keyword: string; isArtistOnly?: boolean } {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return false
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !['keyword', 'isArtistOnly'].includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value')) return false
  }
  const value = input as Record<string, unknown>
  return typeof value.keyword === 'string' && !!value.keyword.trim() && value.keyword.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value.keyword) &&
    (value.isArtistOnly === undefined || typeof value.isArtistOnly === 'boolean')
}
/** Search by song or artist, then deliver one native-capable music card through the scoped Core port. */
export function createAgentMusicTool(config: AgentMusicConfig, options: AgentMusicToolOptions = {}): AgentTool {
  const enabled = config.enabled === true
  const provider = options.provider ?? createAgentMusicProvider({ ...config }, options)
  const safe = (text: string) => createAgentSecretTextCheck([...(options.secrets ?? []), ...provider.getSecrets()])(text) && options.allowsText?.(text) !== false
  return {
    name: 'searchMusicTool', effect: 'sendMusic', timeoutMs: MAX_MS,
    description: '搜索并发送一张QQ音乐卡片。keyword只放歌曲名、歌曲名+歌手或歌手名，不要带点歌/放首等动词。只指定歌手时isArtistOnly=true，从最多20首中随机选一首；指定歌曲时取第一首。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      keyword: { type: 'string', minLength: 1, maxLength: 200, description: '歌曲名、歌曲名+歌手，或歌手名。' },
      isArtistOnly: { type: 'boolean', default: false, description: '用户只给歌手、没有指定歌曲时为true。' }
    }, required: ['keyword'] },
    async execute(input: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult> {
      const controller = new AbortController(), signal = AbortSignal.any([controller.signal, context.signal])
      const deadline = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(MAX_MS, Math.floor(options.timeoutMs!))) : MAX_MS
      const timer = setTimeout(() => controller.abort(), deadline); timer.unref?.()
      let sendStarted = false
      try {
        if (!enabled || !context.sendMusic || !validInput(input) || !safe(input.keyword) || !safe(JSON.stringify(input))) return failed()
        const scoped = { signal, isCurrent: () => context.isCurrent(), ...(context.ensureCurrent ? { ensureCurrent: () => context.ensureCurrent!() } : {}) }
        await ensureMusicCurrent(scoped)
        const selected = await abortableMusic(provider.search({ keyword: input.keyword, isArtistOnly: input.isArtistOnly === true, accountId: context.binding.target.account.id }, scoped), signal)
        if (!selected) return { status: 'failed', content: '未找到相关的音乐。' }
        if (!safe(selected.music.title) || selected.music.artist && !safe(selected.music.artist) || !safe(selected.id)) return failed()
        await ensureMusicCurrent(scoped)
        sendStarted = true
        const receipt = await abortableMusic(context.sendMusic(selected.music), signal)
        await ensureMusicCurrent(scoped)
        if (receipt.state === 'sent' && typeof receipt.messageId === 'string' && !!receipt.messageId.trim()) {
          const identity = receipt.messageId.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(receipt.messageId) && safe(receipt.messageId) ? `消息ID：${receipt.messageId}。` : ''
          const mode = input.isArtistOnly ? `从${selected.poolSize}首候选中随机选择。` : ''
          return { status: 'succeeded', content: `音乐卡片已发送：${selected.music.title}${selected.music.artist ? ` — ${selected.music.artist}` : ''}。歌曲ID：${selected.id}。${mode}${identity}不要重复发送。` }
        }
        return receipt.state === 'failed' ? failed() : unknown()
      } catch { return sendStarted ? unknown() : failed() } finally { clearTimeout(timer) }
    }
  }
}
