import type { AgentBindingSnapshot } from '../../../contracts/agentBinding.js'
import type { AgentMusicExtractionConfig, AgentMusicExtractionContext, AgentMusicShare } from '../../../contracts/agentMusicExtraction.js'
import type { IncomingMessage, MessageActionPort } from '../../../contracts/platformMessage.js'
import type { PlatformConnectionAdapter } from '../../../contracts/platformConnection.js'
import type { DeliveryReceipt } from '../../../contracts/delivery.js'
import type { FileDeliveryReceipt } from '../../../contracts/agentFileDelivery.js'
import type { AgentInboxRedis } from '../../runtime/infrastructure/agentInbox.js'
import { conversationAddressKey, platformAccountKey } from '../../runtime/domain/agentBindings.js'
import { normalizeDeliveryReceipt } from '../../messaging/domain/deliveryReceipt.js'
import { normalizeFileDeliveryReceipt } from '../../messaging/infrastructure/agentFileDelivery.js'
import { validateMusicExtractionConfig } from '../domain/musicExtractionConfig.js'
import { validateAgentAudioAttachment } from './agentAudioAttachment.js'
import { validateAgentAudioBytes } from './agentMediaBytes.js'
import { createAgentMusicExtractionProvider, parseNeteaseMusicLink, validateAgentMusicShare } from './agentMusicExtractionProvider.js'
import { createAgentMusicExtractionLedger, type MusicExtractionStage } from './agentMusicExtractionLedger.js'

export type MusicExtractionProvider = Pick<ReturnType<typeof createAgentMusicExtractionProvider>, 'prepare'>
type ReadResult = NonNullable<Awaited<ReturnType<NonNullable<PlatformConnectionAdapter['readMusicShare']>>>>
type Context = AgentMusicExtractionContext & { allowsSource(message: IncomingMessage): Promise<boolean> }

/** Complete-file relay remains a deterministic business workflow, separate from model music-card tools. */
export function createAgentMusicExtraction(options: {
  readonly config?: AgentMusicExtractionConfig
  readonly storage: AgentInboxRedis
  readonly actions: MessageActionPort
  readonly provider?: MusicExtractionProvider
  readonly allowsText?: (text: string) => boolean
  readonly now?: () => number
  readShare(message: IncomingMessage, sourceId: string, context: Context): Promise<ReadResult | undefined>
}) {
  const config = validateMusicExtractionConfig(options.config)
  const ledger = createAgentMusicExtractionLedger(options.storage, { ...(options.now ? { now: options.now } : {}) })
  const provider = options.provider ?? createAgentMusicExtractionProvider({ ...(options.allowsText ? { allowsText: options.allowsText } : {}) })
  const isCommand = (message: IncomingMessage) => config.enabled && /^[.。]音乐提取\s*$/u.test(message.text.trim())
  const isCandidate = (message: IncomingMessage) => config.enabled && (isCommand(message) || message.conversation.kind === 'group' &&
    (message.parts.some(part => part.kind === 'extension' && ['json', 'music'].includes(part.type)) || !!parseNeteaseMusicLink(message.text)))
  const permitted = (message: IncomingMessage) => config.operators.some(operator => platformAccountKey(operator) === platformAccountKey(message.sender))
  const safe = (text: string) => options.allowsText?.(text) !== false

  async function handle(incoming: IncomingMessage, binding: AgentBindingSnapshot, context: Context): Promise<boolean> {
    if (!isCandidate(incoming)) return false
    const command = isCommand(incoming)
    if (command && !permitted(incoming)) return true
    if (!incoming.messageId || conversationAddressKey(incoming.conversation) !== conversationAddressKey(binding.target)) return command
    const sourceId = command ? incoming.quote?.messageId : incoming.messageId
    let source: ReadResult | undefined
    try {
      await context.ensureCurrent?.()
      context.signal.throwIfAborted()
      if (!context.isCurrent() || !await context.allowsSource(incoming)) return true
      if (sourceId) source = await options.readShare(incoming, sourceId, context)
    } catch { return command }
    if (!source && !command) return false
    const session = await ledger.claim(binding, incoming.messageId)
    if (!session) return true
    let unknown = false
    const ensureCurrent = async () => {
      context.signal.throwIfAborted()
      if (!context.isCurrent()) throw new Error('音乐来源已失效')
      await context.ensureCurrent?.()
      if (!await context.allowsSource(incoming) || source && !await context.allowsSource(source.message)) throw new Error('音乐来源已失效')
      context.signal.throwIfAborted()
      if (!context.isCurrent()) throw new Error('音乐来源已失效')
    }
    const refreshSource = async () => {
      await ensureCurrent()
      if (!source || !sourceId) return
      const current = await options.readShare(incoming, sourceId, { ...context, ensureCurrent })
      if (!current || current.message.messageId !== source.message.messageId || current.message.occurredAt !== source.message.occurredAt ||
          platformAccountKey(current.message.sender) !== platformAccountKey(source.message.sender) ||
          JSON.stringify(validateAgentMusicShare(current.share)) !== JSON.stringify(validateAgentMusicShare(source.share))) throw new Error('音乐来源已改变')
      await ensureCurrent()
    }
    const run = async (stage: MusicExtractionStage, send: () => Promise<DeliveryReceipt | FileDeliveryReceipt>) => {
      await refreshSource()
      await session.begin(stage)
      let receipt: DeliveryReceipt | FileDeliveryReceipt
      try {
        await ensureCurrent()
        receipt = await send()
        receipt = stage === 'file' ? normalizeFileDeliveryReceipt(receipt) : normalizeDeliveryReceipt(receipt)
        const ids = receipt.state === 'uploaded' ? [receipt.fileId, receipt.messageId] : receipt.state === 'sent' ? [receipt.messageId] : []
        if (ids.some(id => id !== undefined && !safe(id))) receipt = { state: 'unknown' }
      } catch { receipt = { state: 'unknown' } }
      try { await session.finish(stage, receipt) } catch { unknown = true; throw new Error('音乐交付记账结果未知') }
      if (receipt.state === 'unknown') { unknown = true; throw new Error('音乐交付结果未知') }
      return receipt
    }
    const sendText = async (stage: 'introText' | 'failureText', text: string) => {
      if (!safe(text)) throw new Error('音乐介绍未通过出站检查')
      return run(stage, () => options.actions.send({ version: 1, kind: 'message.send', target: binding.target,
        parts: [{ kind: 'text', text }], binding }, { isCurrent: context.isCurrent }))
    }
    try {
      if (!source) {
        await sendText('failureText', sourceId ? '引用消息不是可提取的网易云音乐分享，或无法确认来源。' : '请引用一条网易云音乐卡片后发送 .音乐提取')
        await session.close('failed')
        return true
      }
      const share: AgentMusicShare = validateAgentMusicShare(source.share)
      let prepared: Awaited<ReturnType<MusicExtractionProvider['prepare']>>
      try {
        await ensureCurrent()
        const result = await provider.prepare(share, { signal: context.signal, isCurrent: context.isCurrent, ensureCurrent })
        if (typeof result.title !== 'string' || typeof result.artist !== 'string' ||
            [result.title, result.artist].some(value => Array.from(value).length > 300 || /[\u0000-\u001f\u007f]/u.test(value))) throw new Error('音乐信息无效')
        const attachment = validateAgentAudioAttachment(result.attachment), audio = validateAgentAudioBytes(result.audio)
        if (attachment.mime !== audio.mime || attachment.base64 !== audio.base64) throw new Error('音乐文件与试听字节不一致')
        prepared = Object.freeze({ attachment, audio, title: result.title, artist: result.artist })
        await refreshSource()
      } catch {
        await ensureCurrent()
        if (command) await sendText('failureText', '音乐提取失败：没有取得可交付的官方音频。')
        await session.close('failed')
        return true
      }
      for (const value of [prepared.title, prepared.artist, prepared.attachment.name]) if (!safe(value)) throw new Error('音乐信息未通过出站检查')
      const preview = () => run('preview', async () => options.actions.sendMedia
        ? options.actions.sendMedia({ version: 1, kind: 'media.send', target: binding.target,
          media: { kind: 'audio', ...prepared.audio }, binding }, { isCurrent: context.isCurrent, signal: context.signal })
        : { state: 'failed', code: 'audio_unavailable' })
      const uploaded = await run('file', async () => options.actions.sendAudioFile
        ? options.actions.sendAudioFile({ version: 1, kind: 'audio-file.upload', target: binding.target,
          attachment: prepared.attachment, binding }, { isCurrent: context.isCurrent, signal: context.signal })
        : { state: 'failed', code: 'audio_file_unavailable' })
      if (uploaded.state !== 'uploaded') {
        await preview()
        await sendText('failureText', '音乐已经提取出来了，但可下载文件发送失败。')
        await session.close('failed')
        return true
      }
      const size = Buffer.from(prepared.attachment.base64, 'base64').byteLength
      const intro = ['网易云音乐', prepared.title + ' - ' + prepared.artist,
        '可下载文件：' + prepared.attachment.name, '文件大小：' + (size / 1024 / 1024).toFixed(2) + ' MiB'].join('\n')
      if (!safe(intro)) throw new Error('音乐介绍未通过出站检查')
      const summary = options.actions.sendBundle ? await run('introBundle', () => options.actions.sendBundle!({
        version: 1, kind: 'message.bundle.send', target: binding.target, items: [{ parts: [{ kind: 'text', text: intro }] }], binding,
      }, { isCurrent: context.isCurrent })) : undefined
      if (!summary || summary.state === 'failed') await sendText('introText', intro)
      await preview()
      await session.close('completed')
      return true
    } catch {
      if (!unknown) await session.close('cancelled').catch(() => {})
      return true
    } finally { session.abandon() }
  }
  return { isCommand, isCandidate, handle }
}
