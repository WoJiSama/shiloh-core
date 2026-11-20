import type { AgentTool, AgentToolContext, AgentToolResult } from '../../../contracts/agentTool.js'
import { createPersonaReplyGuard } from '../../conversation/domain/personaReplyGuard.js'
import { isToneCorrectionMessage } from '../../conversation/application/chatFailureReply.js'
import { safeTruncateUnicode } from '../../models/domain/unicodeText.js'
import { createAgentSecretTextCheck } from '../../messaging/infrastructure/agentSecretText.js'
import { abortableVoice, boundedVoiceTimeout, createAgentVoiceProvider, ensureVoiceCurrent, type AgentVoiceConfig, type VoiceStyle } from './agentVoiceProvider.js'

export type { AgentVoiceConfig } from './agentVoiceProvider.js'
export interface AgentVoiceToolOptions {
  readonly secrets?: readonly string[]
  readonly allowsText?: (text: string) => boolean
  readonly fetchImpl?: typeof fetch
  /** Trusted hosts may shorten, never increase, the total synthesis/delivery deadline. */
  readonly timeoutMs?: number
}
const STYLES = ['normal', 'shy', 'tease', 'serious', 'sleepy'] as const
const DEFAULT_STYLES: Record<string, VoiceStyle> = {
  normal: {}, shy: { speedRatio: .94, pitchRatio: 1.03, emotion: 'shy' }, tease: { speedRatio: 1.04, pitchRatio: 1.02 },
  serious: { speedRatio: .98 }, sleepy: { speedRatio: .9, pitchRatio: .96 }
}
const MAX_TOOL_MS = 215_000
const failed = (): AgentToolResult => ({ status: 'failed', content: '这条语音未发送成功，请先检查语音配置、内容或当前会话权限。' })
const unknown = (): AgentToolResult => ({ status: 'unknown', content: '语音投递结果尚未确认，请先核实当前会话，不要重试或用文字重复这段语音。' })

/** The historical short-speech cleanup, with a code-point-safe 80-character default. */
export function sanitizeAgentVoiceText(text: string, maximum = 80): string {
  const limit = Math.max(8, Math.min(300, Math.floor(Number(maximum) || 80)))
  return safeTruncateUnicode(text.replace(/\[CQ:[^\]]+\]/gu, ' ').replace(/```[\s\S]*?```/gu, ' ')
    .replace(/`([^`]+)`/gu, '$1').replace(/!\[[^\]]*\]\([^)]+\)/gu, '图片').replace(/\[[^\]]*\]\([^)]+\)/gu, '')
    .replace(/[()（）【】[\]{}<>《》]/gu, ' ').replace(/[#*_~|>`]/gu, '').replace(/\s+/gu, ' ').trim(), limit)
}
function selectStyle(text: string, styles: Record<string, VoiceStyle>): string {
  if (/(害羞|不好意思|别这样|你别|唔|呜|脸红|小声|撒娇)/u.test(text)) return styles.shy ? 'shy' : 'normal'
  if (/(你少来|别闹|才没有|烦|吐槽|绷不住|草|笑死)/u.test(text)) return styles.tease ? 'tease' : 'normal'
  if (/(解释|认真|结论|原因|原理|首先|因为|所以|总结)/u.test(text)) return styles.serious ? 'serious' : 'normal'
  if (/(困|睡|晚安|懒|趴|不想动)/u.test(text)) return styles.sleepy ? 'sleepy' : 'normal'
  return 'normal'
}
function validateInput(input: unknown): input is { text: string; style?: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return false
  const fields = Object.getOwnPropertyDescriptors(input)
  if (Reflect.ownKeys(fields).some(key => typeof key !== 'string' || !['text', 'style'].includes(key) || !Object.hasOwn(fields[key]!, 'value'))) return false
  const value = input as Record<string, unknown>
  return typeof value.text === 'string' && !!value.text.trim() && value.text.length <= 12000 &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.text) &&
    (value.style === undefined || typeof value.style === 'string' && value.style.length <= 40 && !/[\u0000-\u001f\u007f]/u.test(value.style))
}
/** One scoped short voice reply; provider bytes never become paths or durable tool history. */
export function createAgentVoiceTool(config: AgentVoiceConfig, options: AgentVoiceToolOptions = {}): AgentTool {
  const captured = structuredClone(config)
  const styles = Object.fromEntries([...new Set([...STYLES, ...Object.keys(captured.styles ?? {})])]
    .map(name => [name, { ...DEFAULT_STYLES[name], ...captured.styles?.[name] }]))
  const provider = createAgentVoiceProvider(captured, { ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) })
  const { guardReply } = createPersonaReplyGuard({ isToneCorrectionMessage })
  const allowsSecretText = createAgentSecretTextCheck([captured.accessToken, captured.authorization, ...(options.secrets ?? [])].filter((value): value is string => !!value))
  const allows = (text: string) => allowsSecretText(text) && options.allowsText?.(text) !== false
  return {
    name: 'voiceTool', timeoutMs: MAX_TOOL_MS,
    effect: { required: ['sendAudio'], metadata: ['persona', 'request'] },
    description: '发送一条短语音。用户明确要求语音、朗读、念出来，或非常适合用短语音表达时调用。口播必须短而自然，默认最多80字；不要朗读长篇科普、代码、列表或工具结果。可自选normal/shy/tease/serious/sleepy或宿主配置的语气，省略时自动选择。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      text: { type: 'string', minLength: 1, maxLength: 12000, description: '纯口播短句，不要Markdown、代码或舞台动作。' },
      style: { type: 'string', maxLength: 40, description: '常用normal/shy/tease/serious/sleepy，也可用宿主已配置的样式名；省略时自动选择，未知样式回退normal。' }
    }, required: ['text'] },
    async execute(input: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult> {
      const controller = new AbortController(), signal = AbortSignal.any([controller.signal, context.signal])
      const timer = setTimeout(() => controller.abort(), boundedVoiceTimeout(options.timeoutMs, MAX_TOOL_MS))
      timer.unref?.()
      let sendStarted = false
      try {
        if (captured.enabled !== true || !context.sendAudio || !validateInput(input) || !allows(input.text) || !allowsSecretText(JSON.stringify(input))) return failed()
        // Read role/name/guard once before asynchronous work; mutable host configuration never enters the provider.
        const persona = context.persona ? structuredClone(context.persona) : undefined
        const text = sanitizeAgentVoiceText(guardReply(input.text, persona?.guard, {
          userText: context.request?.text ?? '', botNames: [persona?.name, ...(persona?.aliases ?? [])].filter((name): name is string => !!name)
        }), captured.maxTextLength)
        if (!text || !allows(text)) return failed()
        const styleName = input.style || selectStyle(text, styles)
        const style = { ...styles.normal, ...(Object.hasOwn(styles, styleName) ? styles[styleName] : {}) }
        await ensureVoiceCurrent(context, signal)
        const audio = await provider.synthesize({ text, style }, { signal, isCurrent: () => context.isCurrent(),
          ...(context.ensureCurrent ? { ensureCurrent: () => context.ensureCurrent!() } : {}) })
        await ensureVoiceCurrent(context, signal)
        sendStarted = true
        const receipt = await abortableVoice(context.sendAudio({ ...audio, spokenText: text }), signal)
        await ensureVoiceCurrent(context, signal)
        if (receipt.state === 'sent' && typeof receipt.messageId === 'string' && !!receipt.messageId.trim()) {
          const id = receipt.messageId.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(receipt.messageId) && allowsSecretText(receipt.messageId) ? `消息ID：${receipt.messageId}。` : ''
          return { status: 'succeeded', content: `语音已发送。${id}不要再用文字重复这段语音。` }
        }
        return receipt.state === 'failed' ? failed() : unknown()
      } catch { return sendStarted ? unknown() : failed() } finally { clearTimeout(timer) }
    }
  }
}
