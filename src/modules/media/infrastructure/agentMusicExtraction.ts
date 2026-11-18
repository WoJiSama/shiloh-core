import type { AgentDiagnosticScope } from '../../../contracts/agentDiagnostics.js'
import type { AgentDiagnostics } from '../../runtime/infrastructure/agentDiagnostics.js'
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
  readonly diagnostics?: Pick<AgentDiagnostics, 'emit' | 'traceId'>
  withDiagnosticScope?<T>(scope: AgentDiagnosticScope, operation: string, run: () => Promise<T>): Promise<T>
  explainFailure?(input: { detail: string; isCurrent: () => Promise<boolean> | boolean; signal?: AbortSignal }): Promise<string | undefined>
  readonly config?: AgentMusicExtractionConfig
  readonly storage: AgentInboxRedis
  readonly actions: MessageActionPort
  readonly provider?: MusicExtractionProvider
  readonly allowsText?: (text: string) => boolean
  readonly now?: () => number
  readShare(message: IncomingMessage, sourceId: string, context: Context): Promise<ReadResult | undefined>
}) {
  const diagnose = (input: Parameters<AgentDiagnostics['emit']>[0]) => { try { options.diagnostics?.emit(input) } catch { /* Diagnostics cannot change effects. */ } }
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
    let finalOutcome: 'succeeded' | 'failed' | 'unknown' | 'cancelled' = 'succeeded'
    const execute = async () => {
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
      } catch (error) { diagnose({ stage: 'runtime', operation: 'music_read_share', outcome: 'failed', code: 'source_read_failed', error }); return command }
      if (!source && !command) return false
      let session: Awaited<ReturnType<typeof ledger.claim>>
      try { session = await ledger.claim(binding, incoming.messageId) } catch (error) { diagnose({ stage: 'runtime', operation: 'music_claim', outcome: 'failed', code: 'claim_failed', error }); throw error }
      if (!session) return true
      let unknown = false, pending = false, explained = false
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
        try { pending = true; await session.begin(stage) } catch (error) { diagnose({ stage: 'delivery', operation: `music_${stage}`, outcome: 'unknown', code: 'effect_begin_failed', error }); throw error }
        diagnose({ stage: 'delivery', operation: `music_${stage}`, outcome: 'started' })
        let receipt: DeliveryReceipt | FileDeliveryReceipt
        try {
          await ensureCurrent()
          receipt = await send()
          receipt = stage === 'file' ? normalizeFileDeliveryReceipt(receipt) : normalizeDeliveryReceipt(receipt)
          const ids = receipt.state === 'uploaded' ? [receipt.fileId, receipt.messageId] : receipt.state === 'sent' ? [receipt.messageId] : []
          if (ids.some(id => id !== undefined && !safe(id))) receipt = { state: 'unknown' }
        } catch (error) { diagnose({ stage: 'delivery', operation: `music_${stage}`, outcome: 'unknown', code: 'effect_threw', error }); receipt = { state: 'unknown' } }
        try { await session.finish(stage, receipt); pending = false } catch (error) { unknown = true; diagnose({ stage: 'delivery', operation: `music_${stage}`, outcome: 'unknown', code: 'effect_ledger_failed', error }); throw new Error('音乐交付记账结果未知') }
        diagnose({ stage: 'delivery', operation: `music_${stage}`, outcome: receipt.state === 'sent' || receipt.state === 'uploaded' ? 'succeeded' : receipt.state, code: receipt.state === 'unknown' ? 'effect_unknown' : receipt.state === 'failed' ? 'effect_rejected' : 'effect_confirmed' })
        if (receipt.state === 'unknown') { unknown = true; throw new Error('音乐交付结果未知') }
        return receipt
      }
      const sendText = async (stage: 'introText' | 'failureText', text: string) => {
        if (!safe(text)) throw new Error('音乐介绍未通过出站检查')
        return run(stage, () => options.actions.send({ version: 1, kind: 'message.send', target: binding.target,
          parts: [{ kind: 'text', text }], binding }, { isCurrent: context.isCurrent }))
      }
      const sendFailure = async (detail: string, legacy: string) => {
        diagnose({ stage: 'notification', operation: 'music_failure_notice', outcome: 'failed', code: 'request_unfulfilled' })
        if (!options.explainFailure) return sendText('failureText', legacy)
        const authorized = async () => { if (unknown || pending) return false; try { await refreshSource(); return !unknown && !pending && context.isCurrent() && !context.signal.aborted } catch { return false } }
        if (explained || !await authorized()) return undefined
        explained = true
        const signal = AbortSignal.any([context.signal, AbortSignal.timeout(15_000)])
        let abort: (() => void) | undefined
        try {
          const value = await Promise.race([options.explainFailure({ detail, isCurrent: authorized, signal }), new Promise<never>((_resolve, reject) => {
            abort = () => reject(new Error('Failure explanation cancelled')); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
          })])
          if (typeof value === 'string' && value.trim() && value.length <= 1200 && safe(value) && await authorized()) return sendText('failureText', value)
          diagnose({ stage: 'notification', operation: 'music_failure_notice', outcome: 'failed', code: 'explanation_unavailable' })
        } catch (error) { diagnose({ stage: 'notification', operation: 'music_failure_notice', outcome: 'failed', code: 'explanation_failed', error }) }
        finally { if (abort) signal.removeEventListener('abort', abort) }
        return undefined
      }
      try {
        if (!source) {
          finalOutcome = 'failed'
          await sendFailure(sourceId ? '引用消息未确认为可提取的网易云音乐分享，尚未提取音频' : '当前真人请求没有引用音乐分享，需要先引用网易云音乐卡片再发送音乐提取命令', sourceId ? '引用消息不是可提取的网易云音乐分享，或无法确认来源。' : '请引用一条网易云音乐卡片后发送 .音乐提取')
          await session.close('failed')
          return true
        }
        const share: AgentMusicShare = validateAgentMusicShare(source.share)
        let prepared: Awaited<ReturnType<MusicExtractionProvider['prepare']>>
        try {
          await ensureCurrent()
          diagnose({ stage: 'runtime', operation: 'music_provider_prepare', outcome: 'started' })
          const result = await provider.prepare(share, { signal: context.signal, isCurrent: context.isCurrent, ensureCurrent })
          if (typeof result.title !== 'string' || typeof result.artist !== 'string' ||
              [result.title, result.artist].some(value => Array.from(value).length > 300 || /[\u0000-\u001f\u007f]/u.test(value))) throw new Error('音乐信息无效')
          const attachment = validateAgentAudioAttachment(result.attachment), audio = validateAgentAudioBytes(result.audio)
          if (attachment.mime !== audio.mime || attachment.base64 !== audio.base64) throw new Error('音乐文件与试听字节不一致')
          prepared = Object.freeze({ attachment, audio, title: result.title, artist: result.artist })
          await refreshSource()
          diagnose({ stage: 'runtime', operation: 'music_provider_prepare', outcome: 'succeeded', code: 'provider_ready' })
        } catch (error) {
          finalOutcome = 'failed'
          diagnose({ stage: 'runtime', operation: 'music_provider_prepare', outcome: 'failed', code: 'prepare_failed', error })
          await ensureCurrent()
          if (command) await sendFailure('音乐提取没有取得可交付的官方音频，尚未上传文件', '音乐提取失败：没有取得可交付的官方音频。')
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
          finalOutcome = 'failed'
          await preview()
          await sendFailure('已取得音频，但可下载文件上传被明确拒绝；试听仅按原工作流尝试，不表示文件上传成功', '音乐已经提取出来了，但可下载文件发送失败。')
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
      } catch (error) {
        finalOutcome = unknown || pending ? 'unknown' : 'failed'
        diagnose({ stage: 'runtime', operation: 'music_run', outcome: finalOutcome, code: 'workflow_failed', error })
        if (!unknown) await session.close('cancelled').catch(error => diagnose({ stage: 'runtime', operation: 'music_cleanup', outcome: 'unknown', code: 'close_ledger_failed', error }))
        return true
      } finally { session.abandon() }
    }
    const observed = async () => {
      diagnose({ stage: 'runtime', operation: 'music_run', outcome: 'started' })
      try { const result = await execute(); diagnose({ stage: 'runtime', operation: 'music_run', outcome: finalOutcome, code: 'workflow_settled' }); return result }
      catch (error) { diagnose({ stage: 'runtime', operation: 'music_run', outcome: 'failed', code: 'workflow_threw', error }); throw error }
    }
    return options.withDiagnosticScope
      ? options.withDiagnosticScope({ kind: 'conversation', binding, ...(incoming.messageId ? { messageId: isCommand(incoming) ? incoming.quote?.messageId ?? incoming.messageId : incoming.messageId } : {}) }, 'music_run', observed) : observed()
  }
  return { isCommand, isCandidate, handle }
}
