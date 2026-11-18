import type { AgentMessageVideo, AgentVideoInput, MessageVideoReadOptions } from '../../../contracts/agentVideo.js'
import type { ConversationAddress, PlatformUserRef } from '../../../contracts/agentBinding.js'
import type { IncomingMessage } from '../../../contracts/platformMessage.js'
import type { SimMessage } from '../../../contracts/simulation.js'
import { validateAgentVideoInput } from '../../media/domain/agentVideoInput.js'

export const MAX_SIMULATION_MESSAGE_VIDEOS = 20
export function simulationVideoCount(parts: IncomingMessage['parts']): number {
  return Math.min(MAX_SIMULATION_MESSAGE_VIDEOS, parts.filter(part => part.kind === 'video').length)
}

/** Reload only bounded metadata. Drop accidental video resource/byte fields from stored state. */
export function normalizeSimulationMessageVideo(message: SimMessage): SimMessage {
  const cleanCount = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0 ? Math.min(MAX_SIMULATION_MESSAGE_VIDEOS, value as number) : 0
  const { videoCount: _count, ...owned } = message
  const count = cleanCount(message.videoCount)
  const quote = message.quoteSource
  if (!quote?.video) return { ...owned, ...(count ? { videoCount: count } : {}) }
  const { video: _video, ...source } = quote
  const value = quote.video
  const valid = typeof value.authorId === 'string' && value.authorId.length > 0 && value.authorId.length <= 200 && Number.isSafeInteger(value.occurredAt) && value.occurredAt > 0
  const quotedCount = cleanCount(value.count)
  return { ...owned, ...(count ? { videoCount: count } : {}), quoteSource: { ...source,
    ...(valid && (quotedCount || value.hasForward === true) ? { video: { count: quotedCount, authorId: value.authorId, occurredAt: value.occurredAt, ...(value.hasForward === true ? { hasForward: true } : {}) } } : {}),
  } }
}

export interface SimulationAgentVideoContext {
  readonly target: ConversationAddress
  readonly request: SimMessage
  readonly signal: AbortSignal
  isCurrent(): boolean
  /** Low-level turn/privacy check; must not traverse registered projections. */
  ensureCurrent(): Promise<void>
  requestCurrent(): boolean
  markEphemeral(): void
  cancelTurn(): void
  registerProjection(projection: { isCurrent(): Promise<boolean> }): void
  loadMessage(messageId: string): Promise<IncomingMessage | undefined>
  allowsOriginal(original: IncomingMessage, messageId: string, authorId: string, occurredAt: number): Promise<boolean>
  requestTextCurrent(original: IncomingMessage): boolean
  allowsForwardSource(source: { readonly author: PlatformUserRef; readonly occurredAt: number }): Promise<boolean>
  readMessageVideo(target: ConversationAddress, messageId: string, options: MessageVideoReadOptions): Promise<AgentMessageVideo | undefined>
}

/** Fixed human trigger only: model arguments never become a source selector or URL. */
export function createSimulationAgentVideo(context: SimulationAgentVideoContext) {
  const request = structuredClone(context.request)
  const rootId = String(request.messageId)
  const quote = request.quoteSource?.video
  const quoteId = request.quoteSource?.messageId
  const requestKey = (message: SimMessage) => JSON.stringify([message.seq, message.messageId, message.userId, message.at, message.text,
    message.textTruncated, message.quoteSource, message.videoCount, message.forwardId])
  const captured = requestKey(request)
  const current = () => !context.signal.aborted && context.isCurrent() && context.requestCurrent() && requestKey(context.request) === captured
  const ensure = async () => {
    if (!current()) throw new Error('视频来源或回合已失效')
    await context.ensureCurrent()
    if (!current()) throw new Error('视频来源或回合已失效')
  }
  const allowsRoot = async (original: IncomingMessage) => {
    await ensure()
    return await context.allowsOriginal(original, rootId, request.userId, request.at) &&
      context.requestTextCurrent(original) && (!quoteId || original.quote?.messageId === quoteId) && current()
  }
  const allowsSource = async (original: IncomingMessage): Promise<boolean> => {
    try {
      if (original.messageId === rootId) return await allowsRoot(original)
      if (!quoteId || !quote || original.messageId !== quoteId || original.occurredAt > request.at ||
          !await context.allowsOriginal(original, quoteId, quote.authorId, quote.occurredAt)) return false
      const root = await context.loadMessage(rootId)
      return !!root && await allowsRoot(root) && current()
    } catch { return false }
  }
  const read = async (inspectOnly: boolean, signal: AbortSignal, isCurrent: () => boolean) => {
    const check = () => !signal.aborted && isCurrent() && current()
    const guardedEnsure = async () => { if (!check()) throw new Error('视频读取已取消'); await ensure(); if (!check()) throw new Error('视频读取已取消') }
    await guardedEnsure()
    const value = await context.readMessageVideo(context.target, rootId, {
      signal, isCurrent: check, ensureCurrent: guardedEnsure, ...(inspectOnly ? { inspectOnly: true } : {}),
      allowsSource: async original => check() && await allowsSource(original) && check(),
      allowsForwardSource: async source => {
        try { await guardedEnsure(); return await context.allowsForwardSource(source) && check() }
        catch { return false }
      },
    })
    await guardedEnsure()
    if (!value || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(value.fingerprint) || !['current', 'reply', 'forward'].includes(value.origin)) throw new Error('当前消息和引用消息里没有可核验的视频')
    return value
  }
  return {
    async readVideo(isCurrent: () => boolean, signal: AbortSignal): Promise<AgentVideoInput> {
      context.markEphemeral()
      const selected = await read(false, AbortSignal.any([signal, context.signal]), isCurrent)
      const video = validateAgentVideoInput(selected.video)
      const definitionIsCurrent = () => { try { return isCurrent() === true } catch { return false } }
      // Definition revocation must also stop an already dispatched continuation.
      // This guard deliberately owns neither the tool timeout nor its final abort.
      const timer = setInterval(() => { if (!definitionIsCurrent()) context.cancelTurn() }, 25)
      timer.unref?.()
      const release = () => { clearInterval(timer); context.signal.removeEventListener('abort', release) }
      context.signal.addEventListener('abort', release, { once: true })
      if (context.signal.aborted) release()
      const projection = { async isCurrent() {
        try {
          // A tool timeout ends only that call; this proof lives for the complete turn.
          const fresh = await read(true, context.signal, definitionIsCurrent)
          return fresh.fingerprint === selected.fingerprint && fresh.origin === selected.origin
        } catch { return false }
      } }
      context.registerProjection(projection)
      if (!await projection.isCurrent() || signal.aborted || !isCurrent()) throw new Error('视频来源已改变')
      return video
    },
  }
}
