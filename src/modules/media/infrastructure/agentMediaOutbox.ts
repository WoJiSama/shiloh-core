import { AsyncLocalStorage } from 'node:async_hooks'
import type { AgentDiagnosticScope } from '../../../contracts/agentDiagnostics.js'
import type { AgentDiagnostics } from '../../runtime/infrastructure/agentDiagnostics.js'
import type { AgentMediaRelayProvider, AgentMediaRelayPrepareContext, AgentMediaShare, AgentMediaShareAccess, AgentPreparedMediaRelay } from '../../../contracts/agentMediaRelayWorkflow.js'
import type { AgentMediaRelayPlan, AgentMediaResourceContext } from '../../../contracts/agentMediaRelay.js'
import type { DeliveryReceipt } from '../../../contracts/delivery.js'
import type { IncomingMessage, MessageActionPort } from '../../../contracts/platformMessage.js'
import type { ConversationAddress } from '../../../contracts/agentBinding.js'
import type { AgentInboxRedis } from '../../runtime/infrastructure/agentInbox.js'
import { conversationAddressKey, platformAccountKey } from '../../runtime/domain/agentBindings.js'
import { normalizeDeliveryReceipt } from '../../messaging/domain/deliveryReceipt.js'
import { sanitizeFinalReplyText } from '../../conversation/domain/replySanitizer.js'
import { validateAgentMediaRelayPlan } from '../domain/agentMediaRelayPlan.js'
import { agentMediaSharePageUrl, validateAgentMediaPreparedPageUrl, validateAgentMediaShare } from './agentMediaRelayReference.js'
import { validateAgentXiaohongshuAccess } from './agentXiaohongshuRelayReference.js'
import { agentMediaSourceScopeKey, createAgentMediaOutboxLedger, type AgentMediaOutboxRecord, type AgentMediaOutboxSession, type MediaOutboxEffect } from './agentMediaOutboxLedger.js'

export interface AgentMediaOutboxContext extends AgentMediaResourceContext {
  readSource(): Promise<{ readonly message: IncomingMessage; readonly share: AgentMediaShare; readonly access?: AgentMediaShareAccess } | undefined>
  release(): void
}
interface Prepared {
  readonly status: AgentPreparedMediaRelay['status']
  readonly plan: Readonly<AgentMediaRelayPlan>
  readonly infoText: string
  readonly pageUrl: string
  readonly linkOnly: boolean
  release(): Promise<void>
}
interface Entry {
  readonly session: AgentMediaOutboxSession
  readonly cancel: AbortController
  context?: AgentMediaOutboxContext
  abortContext?: () => void
  prepared?: Prepared
  readyAt?: number
  lastDelivery?: DeliveryReceipt
  preparationScope?: ReturnType<typeof AsyncLocalStorage.snapshot>
  preparing: boolean
  sending: boolean
  cleanup?: Promise<void>
}
const failure = () => new Error('媒体搬运来源或交付已失效')
const lane = (record: AgentMediaOutboxRecord) => JSON.stringify([record.binding.connectionId, conversationAddressKey(record.binding.target)])
const sameSource = (record: AgentMediaOutboxRecord, value: Awaited<ReturnType<AgentMediaOutboxContext['readSource']>>) => !!value &&
  value.message.messageId === record.source.messageId && value.message.occurredAt === record.source.occurredAt &&
  conversationAddressKey(value.message.conversation) === conversationAddressKey(record.binding.target) &&
  platformAccountKey(value.message.sender) === platformAccountKey(record.source.sender) &&
  JSON.stringify(validateAgentMediaShare(value.share)) === JSON.stringify(validateAgentMediaShare(record.source.share))

/** Durable scheduling is independent of platform objects and of any model turn. */
export function createAgentMediaOutbox(options: {
  readonly diagnostics?: Pick<AgentDiagnostics, 'emit' | 'traceId'> & Partial<Pick<AgentDiagnostics, 'emitFailure' | 'emitReceipt'>>
  withDiagnosticScope?<T>(scope: AgentDiagnosticScope, operation: string, run: () => Promise<T>, inheritTrace?: boolean): Promise<T>
  readonly storage: AgentInboxRedis
  readonly actions: MessageActionPort
  readonly provider?: AgentMediaRelayProvider
  readonly allowsText?: (text: string) => boolean
  readonly now?: () => number
  /** 'wait' preserves a queued task while its exact account is disconnected. */
  openContext(record: AgentMediaOutboxRecord, signal: AbortSignal): Promise<AgentMediaOutboxContext | 'wait' | undefined>
}) {
  const now = options.now ?? Date.now
  const diagnose = (input: Parameters<AgentDiagnostics['emit']>[0]) => { try { options.diagnostics?.emit(input) } catch { /* Observers cannot change delivery. */ } }
  const diagnoseReceipt = (input: Parameters<AgentDiagnostics['emit']>[0], receipt?: DeliveryReceipt) => {
    try {
      if (options.diagnostics?.emitReceipt) options.diagnostics.emitReceipt(input, receipt)
      else diagnose(input)
    } catch { /* Observers cannot change delivery. */ }
  }
  const inScope = <T>(entry: Entry, operation: string, run: () => Promise<T>) => {
    const record = entry.session.record
    const observed = async () => {
      diagnose({ stage: 'runtime', operation, outcome: 'started' })
      try {
        const result = await run(), state = entry.session.record.state
        const outcome = state === 'failed' || state === 'unknown' || state === 'cancelled' ? state : 'succeeded'
        diagnoseReceipt({ stage: 'runtime', operation, outcome, code: 'workflow_settled' }, entry.lastDelivery)
        return result
      }
      catch (error) { diagnose({ stage: 'runtime', operation, outcome: 'failed', code: 'workflow_threw', error }); throw error }
    }
    const scoped = () => options.withDiagnosticScope
      ? options.withDiagnosticScope({ kind: 'conversation', binding: record.binding, messageId: record.source.messageId }, operation, observed, !!entry.preparationScope)
      : observed()
    return entry.preparationScope ? entry.preparationScope(scoped) : scoped()
  }
  const ledger = createAgentMediaOutboxLedger(options.storage, { now })
  const entries = new Map<string, Entry>(), tasks = new Set<Promise<void>>(), connections = new Set<string>()
  let stopped = false, scanning = false, preparing = 0, started = false
  const safeText = (text: string) => typeof text === 'string' && sanitizeFinalReplyText(text) === text && options.allowsText?.(text) !== false
  const sendCurrent = (entry: Entry) => !stopped && !entry.cancel.signal.aborted && entry.context?.signal.aborted === false && entry.context.isCurrent()
  const track = (task: Promise<void>) => { tasks.add(task); void task.then(() => tasks.delete(task), error => { tasks.delete(task); diagnose({ stage: 'runtime', operation: 'media_task', outcome: 'failed', code: 'background_task_failed', error }) }) }
  const wait = <T>(promise: Promise<T>, signal: AbortSignal, late?: (value: T) => Promise<unknown>): Promise<T> => new Promise((resolve, reject) => {
    let settled = false
    const abort = () => { settled = true; signal.removeEventListener('abort', abort); reject(failure()) }
    promise.then(value => {
      signal.removeEventListener('abort', abort)
      if (settled || signal.aborted) { if (late) void Promise.resolve().then(() => late(value)).catch(error => diagnose({ stage: 'runtime', operation: 'media_cleanup', outcome: 'failed', code: 'late_release_failed', error })); reject(failure()); return }
      settled = true; resolve(value)
    }, () => { signal.removeEventListener('abort', abort); settled = true; reject(failure()) })
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
  })
  const releasePrepared = async (value: AgentPreparedMediaRelay | Prepared) => { try { await value.release() } catch (error) { diagnose({ stage: 'runtime', operation: 'media_cleanup', outcome: 'failed', code: 'prepared_release_failed', error }) } }
  function cleanup(id: string, entry: Entry): Promise<void> {
    return entry.cleanup ??= (async () => {
      entry.cancel.abort()
      if (entry.context && entry.abortContext) entry.context.signal.removeEventListener('abort', entry.abortContext)
      if (entry.prepared) await releasePrepared(entry.prepared)
      try { entry.context?.release() } catch (error) { diagnose({ stage: 'runtime', operation: 'media_cleanup', outcome: 'failed', code: 'context_release_failed', error }) }
      entry.session.abandon()
      if (entries.get(id) === entry) entries.delete(id)
    })()
  }
  async function current(entry: Entry, reread = false): Promise<void> {
    const context = entry.context
    if (stopped || !context || entry.cancel.signal.aborted || context.signal.aborted || !context.isCurrent()) throw failure()
    await wait(Promise.resolve().then(() => context.ensureCurrent?.()), entry.cancel.signal)
    if (reread && !sameSource(entry.session.record, await wait(context.readSource(), entry.cancel.signal))) {
      entry.cancel.abort()
      throw failure()
    }
    if (stopped || entry.cancel.signal.aborted || context.signal.aborted || !context.isCurrent()) throw failure()
  }
  function prepareContext(entry: Entry): Readonly<AgentMediaRelayPrepareContext> {
    return Object.freeze({ signal: AbortSignal.any([entry.cancel.signal, entry.context!.signal]), isCurrent: () => sendCurrent(entry),
      ensureCurrent: () => current(entry),
      async readSourceAccess() {
        await current(entry)
        const observed = await wait(entry.context!.readSource(), entry.cancel.signal)
        if (!sameSource(entry.session.record, observed)) { entry.cancel.abort(); throw failure() }
        await current(entry)
        const descriptor = Object.getOwnPropertyDescriptor(observed!, 'access')
        if (!descriptor) {
          if ('access' in observed!) { entry.cancel.abort(); throw failure() }
          return undefined
        }
        if (!Object.hasOwn(descriptor, 'value')) { entry.cancel.abort(); throw failure() }
        if (descriptor.value === undefined) return undefined
        if (entry.session.record.source.share.provider !== 'xiaohongshu') { entry.cancel.abort(); throw failure() }
        const access = validateAgentXiaohongshuAccess(descriptor.value)
        await current(entry)
        if (!sendCurrent(entry)) { entry.cancel.abort(); throw failure() }
        return access
      },
    })
  }
  function prepared(input: AgentPreparedMediaRelay, share: AgentMediaShare): Prepared {
    if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw failure()
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== 'string' || !['status', 'pageUrl', 'infoText', 'plan', 'release'].includes(key) ||
          !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, 'value')) throw failure()
    }
    if (!['ready', 'metadata-only', 'preview', 'restricted'].includes(input.status) || typeof input.release !== 'function' ||
        typeof input.infoText !== 'string' || !input.infoText || input.infoText.length > 64_000 || !safeText(input.infoText) ||
        typeof input.pageUrl !== 'string' || validateAgentMediaPreparedPageUrl(input.pageUrl, share) !== input.pageUrl ||
        !safeText(input.pageUrl)) throw failure()
    const plan = validateAgentMediaRelayPlan(input.plan, { allowsText: safeText })
    const release = input.release
    return Object.freeze({ status: input.status, plan, infoText: input.infoText, pageUrl: input.pageUrl, linkOnly: false,
      release: () => release.call(input) })
  }
  async function prepare(record: AgentMediaOutboxRecord, entry: Entry) {
    return inScope(entry, 'media_prepare', async () => {
      if (options.withDiagnosticScope) entry.preparationScope = AsyncLocalStorage.snapshot()
      let providerReported = false
      let step = 'authorization'
      try {
        const context = await wait(options.openContext(record, entry.cancel.signal), entry.cancel.signal, async late => { if (late && late !== 'wait') late.release() })
        if (context === 'wait') return
        if (!context || !options.provider) { await entry.session.close('cancelled'); return }
        entry.context = context
        const abort = () => entry.cancel.abort()
        entry.abortContext = abort
        if (context.signal.aborted) abort(); else context.signal.addEventListener('abort', abort, { once: true })
        await current(entry, true)
        step = 'reserve'
        await entry.session.preparing()
        await current(entry)
        step = 'provider_request'
        diagnose({ stage: 'runtime', operation: 'media_provider_prepare', outcome: 'started' })
        const result = await wait(Promise.resolve().then(() => options.provider!.prepare(record.source.share, prepareContext(entry))).catch(error => {
          if (!entry.cancel.signal.aborted) {
            providerReported = true
            diagnose({ stage: 'runtime', operation: 'media_provider_prepare', outcome: 'failed', code: 'provider_threw', error,
              details: { step, attempt: entry.session.record.prepareAttempts, maxAttempts: 3 } })
          }
          throw error
        }), entry.cancel.signal, releasePrepared)
        diagnose({ stage: 'runtime', operation: 'media_provider_prepare', outcome: 'succeeded', code: 'provider_returned' })
        step = 'response_validation'
        try { entry.prepared = prepared(result, record.source.share) } catch { await releasePrepared(result); throw failure() }
        await current(entry, true)
        entry.readyAt = now()
      } catch (error) {
        if (!providerReported && !entry.cancel.signal.aborted) {
          diagnose({ stage: 'runtime', operation: 'media_prepare', outcome: 'failed', code: 'prepare_failed', error, details: { step } })
        }
        try {
          if (stopped) return
          if (!entry.context?.isCurrent() || entry.cancel.signal.aborted) await entry.session.close('cancelled')
          else if (entry.session.record.prepareFailures < 2) {
            const retryInMs = 1_000 * 3 ** entry.session.record.prepareFailures
            await entry.session.retry(now() + retryInMs)
            diagnose({ stage: 'runtime', operation: 'media_prepare', outcome: 'succeeded', code: 'prepare_retry_scheduled',
              details: { result: 'retry_scheduled', retryInMs, attempt: entry.session.record.prepareAttempts, maxAttempts: 3 } })
          }
          else {
            // Even a final preparation failure waits for its FIFO/connection lane.
            const share = validateAgentMediaShare(record.source.share), pageUrl = agentMediaSharePageUrl(share)
            if (entry.prepared) await releasePrepared(entry.prepared)
            const infoText = share.provider === 'bilibili' ? 'B站视频（视频资源准备失败）'
              : share.provider === 'douyin' ? '抖音作品（媒体资源准备失败）'
                : share.provider === 'youtube' ? 'YouTube视频（媒体资源准备失败）'
                  : share.provider === 'pixiv' ? 'Pixiv作品（图片资源准备失败）' : '小红书笔记（媒体资源准备失败）'
            entry.prepared = { status: 'metadata-only', pageUrl, infoText, linkOnly: true,
              plan: { version: 1, items: [{ parts: [{ kind: 'text', text: infoText }] }] }, async release() {} }
            entry.readyAt = now()
            diagnose({ stage: 'runtime', operation: 'media_prepare', outcome: 'succeeded', code: 'prepare_fallback_ready',
              details: { result: 'fallback_used', attempt: entry.session.record.prepareAttempts, maxAttempts: 3 } })
          }
        } catch (error) { diagnose({ stage: 'runtime', operation: 'media_prepare', outcome: 'unknown', code: 'prepare_ledger_failed', error,
          details: { step: 'reconcile', result: 'confirmation_pending' } }) }
      } finally {
        preparing--; entry.preparing = false
        if (entry.readyAt === undefined) await cleanup(record.id, entry)
        if (!stopped && entry.readyAt !== undefined) void tick().catch(() => {})
      }
      const code = entry.readyAt === undefined ? 'prepare_not_ready'
        : entry.prepared?.status === 'metadata-only' ? 'prepare_metadata_only' : 'prepare_ready'
      diagnose({ stage: 'runtime', operation: 'media_prepare', outcome: entry.readyAt === undefined ? 'cancelled' : 'succeeded', code })
    })
  }
  async function effect(entry: Entry, name: MediaOutboxEffect, send: () => Promise<DeliveryReceipt>): Promise<DeliveryReceipt> {
    delete entry.lastDelivery
    await current(entry, true)
    try { await entry.session.begin(name) } catch (error) { diagnose({ stage: 'delivery', operation: `media_${name}`, outcome: 'unknown', code: 'effect_begin_failed', error }); throw error }
    diagnose({ stage: 'delivery', operation: `media_${name}`, outcome: 'started' })
    let observed: DeliveryReceipt, receipt: DeliveryReceipt, sendError: unknown
    try {
      await current(entry)
      observed = await send()
      receipt = normalizeDeliveryReceipt(observed)
    } catch (error) {
      sendError = error
      observed = receipt = { state: 'unknown' }
    }
    if (receipt.state === 'sent' && !safeText(receipt.messageId)) observed = receipt = { state: 'unknown' }
    if (receipt.state !== 'sent') {
      entry.lastDelivery = observed
      diagnoseReceipt({ stage: 'delivery', operation: `media_${name}`, outcome: receipt.state,
        code: receipt.state === 'unknown' ? sendError === undefined ? 'effect_unknown' : 'effect_threw' : 'effect_rejected',
        delivery: { state: receipt.state }, ...(sendError === undefined ? {} : { error: sendError }),
        details: receipt.state === 'unknown' ? { result: 'confirmation_pending' } : { cause: receipt.code ?? 'native_rejected' },
      }, observed)
    }
    try { await entry.session.finish(name, receipt) } catch (error) { diagnose({ stage: 'delivery', operation: `media_${name}`, outcome: 'unknown', code: 'effect_ledger_failed', error }); throw error }
    if (receipt.state === 'sent') diagnose({ stage: 'delivery', operation: `media_${name}`, outcome: 'succeeded', code: 'effect_sent' })
    if (receipt.state === 'unknown') throw failure()
    await current(entry)
    return receipt
  }
  const linkText = (value: Prepared) => `${value.infoText}${value.infoText.includes(value.pageUrl) ? '' : '\n' + value.pageUrl}\n（媒体转发资源暂不可用，已附原作品链接）`
  async function text(entry: Entry, name: 'directIntro' | 'link', value: string) {
    if (!safeText(value)) throw failure()
    const binding = entry.session.record.binding
    return effect(entry, name, () => options.actions.send({ version: 1, kind: 'message.send', target: binding.target,
      binding, parts: [{ kind: 'text', text: value }] }, { isCurrent: () => sendCurrent(entry) }))
  }
  async function deliver(id: string, entry: Entry) {
    const record = entry.session.record, connection = record.binding.connectionId
    return inScope(entry, 'media_deliver', async () => {
      try {
        const value = entry.prepared!
        const binding = record.binding
        const relay = (name: 'forward' | 'forwardRetry' | 'forwardCard' | 'directIntro' | 'directVideo', plan: AgentMediaRelayPlan) => effect(entry, name,
          async () => options.actions.sendMediaRelay ? options.actions.sendMediaRelay({ version: 1, kind: 'media-relay.send',
            target: binding.target, binding, mode: name === 'directIntro' || name === 'directVideo' ? 'direct-video' : 'forward', plan },
          { signal: entry.cancel.signal, isCurrent: () => sendCurrent(entry) }) : { state: 'failed', code: 'media_relay_unavailable' })
        const bilibili = record.source.share.provider === 'bilibili'
        if (value.linkOnly) {
          if (bilibili) {
            const card = await relay('forward', { version: 1, items: [{ parts: [{ kind: 'text', text: linkText(value) }] }] })
            if (card.state === 'sent') { await entry.session.close('completed'); return }
          }
          const sent = await text(entry, 'link', linkText(value))
          await entry.session.close(sent.state === 'sent' ? 'completed' : 'failed'); return
        }
        const videos = bilibili ? [] : value.plan.items.flatMap(item => item.parts.flatMap(part => part.kind === 'video' ? [{ parts: [part] }] : []))
        if (videos.length) {
          const introParts = value.plan.items.flatMap(item => item.parts.flatMap(part => part.kind !== 'video' ? [part] : []))
          if (introParts.length) {
            const intro = await relay('directIntro', { version: 1, items: [{ parts: introParts }] })
            if (intro.state !== 'sent') {
              const linked = await text(entry, 'link', linkText(value))
              await entry.session.close(linked.state === 'sent' ? 'completed' : 'failed'); return
            }
          }
          const direct = await relay('directVideo', { version: 1, items: videos })
          if (direct.state === 'sent') { await entry.session.close('completed'); return }
          const linked = await text(entry, 'link', linkText(value))
          await entry.session.close(linked.state === 'sent' ? 'completed' : 'failed'); return
        }
        let result = await relay('forward', value.plan)
        const retryVideo = bilibili && result.state === 'failed' && result.code === 'media_resource_fetch_closed'
        if (retryVideo) result = await relay('forwardRetry', value.plan)
        if (result.state === 'failed' && bilibili) {
          // Keep the image-only intro after a confirmed video rejection.
          const textPart = { kind: 'text' as const, text: linkText(value) }
          const intro = value.plan.items[0]!.parts
          const covers = intro.filter(part => part.kind === 'image')
          if (value.plan.items.some(item => item.parts.some(part => part.kind === 'video'))) {
            const parts = covers.length && intro.every(part => part.kind === 'image') ? covers : [textPart, ...covers]
            result = await relay(retryVideo ? 'forwardCard' : 'forwardRetry', { version: 1, items: [{ parts }] })
          } else if (result.code === 'media_resource_preprocessing_failed') {
            result = await relay('forwardRetry', { version: 1, items: [{ parts: [textPart] }] })
          }
        } else if (result.state === 'failed' && result.code === 'media_resource_preprocessing_failed') {
          result = await relay('forwardRetry', value.plan)
        }
        if (result.state === 'sent') { await entry.session.close('completed'); return }
        if (result.state !== 'failed' || !bilibili && result.code !== 'media_resource_preprocessing_failed') { await entry.session.close('failed'); return }
        const linked = await text(entry, 'link', linkText(value))
        await entry.session.close(linked.state === 'sent' ? 'completed' : 'failed')
      } catch (error) {
        // finish() already durably closed an unknown effect and released its
        // owner. A second close manufactures a ledger failure.
        if (entry.session.record.state === 'unknown') return
        diagnose({ stage: 'runtime', operation: 'media_deliver', outcome: 'unknown', code: 'delivery_failed', error })
        if (!stopped) await entry.session.close(entry.session.record.effects.length ? 'unknown' : 'cancelled').catch(error => diagnose({ stage: 'runtime', operation: 'media_cleanup', outcome: 'unknown', code: 'close_ledger_failed', error }))
      } finally {
        connections.delete(connection); await cleanup(id, entry)
        if (!stopped) void tick().catch(() => {})
      }
    })
  }
  async function tick(): Promise<void> {
    if (stopped || scanning || !started) return
    scanning = true
    let step = 'reconcile'
    const startedAt = performance.now()
    try {
      await ledger.recover()
      step = 'list'
      const records = await ledger.listActive(), heads = new Map<string, string>(), active = new Set(records.map(record => record.id))
      step = 'reconcile'
      for (const entry of entries.values()) if (entry.session.record.expiresAt <= now()) entry.cancel.abort()
      for (const [id, entry] of entries) if (!entry.preparing && !entry.sending && (!active.has(id) || entry.cancel.signal.aborted)) {
        if (active.has(id)) await entry.session.close(entry.session.record.effects.length ? 'unknown' : 'cancelled').catch(error => diagnose({ stage: 'runtime', operation: 'media_cleanup', outcome: 'unknown', code: 'stale_close_failed', error }))
        await cleanup(id, entry)
      }
      for (const record of records) if (!heads.has(lane(record))) heads.set(lane(record), record.id)
      for (const record of records) {
        if (stopped) return
        const existing = entries.get(record.id)
        if (existing?.prepared && !existing.sending && !existing.preparing) {
          if (now() - existing.readyAt! >= 180_000) {
            try { await existing.session.retry(now(), false) } finally { await cleanup(record.id, existing) }
            continue
          }
          if (heads.get(lane(record)) === record.id && !connections.has(record.binding.connectionId)) {
            existing.sending = true; connections.add(record.binding.connectionId); track(deliver(record.id, existing))
          }
          continue
        }
        if (existing || preparing >= 2 || record.nextAttemptAt > now()) continue
        step = 'reserve'
        const session = await ledger.claim(record.id)
        if (!session) continue
        if (stopped) { session.abandon(); return }
        const entry: Entry = { session, cancel: new AbortController(), preparing: true, sending: false }
        entries.set(record.id, entry); preparing++; track(prepare(record, entry))
      }
    } catch (error) {
      const event = { stage: 'runtime', operation: 'media_tick', outcome: 'failed', code: 'tick_failed', error,
        details: { step }, durationMs: performance.now() - startedAt } as const
      try { if (options.diagnostics?.emitFailure) options.diagnostics.emitFailure(event, true); else diagnose(event) }
      catch { /* Preserve the inspection result. */ }
      throw error
    }
    finally { scanning = false }
  }
  return {
    ledger,
    async start() { if (started || stopped) return; try { await ledger.recover(); started = true; await tick() } catch (error) { diagnose({ stage: 'runtime', operation: 'media_start', outcome: 'failed', code: 'start_failed', error }); throw error } },
    tick,
    async cancelSource(target: ConversationAddress, messageId: string) {
      const matching = [...entries].filter(([, entry]) => entry.session.record.source.messageId === messageId &&
        agentMediaSourceScopeKey(entry.session.record.binding.target) === agentMediaSourceScopeKey(target))
      // Revoke in-memory readers immediately even if durable cancellation loses its reply.
      for (const [, entry] of matching) entry.cancel.abort()
      try { await ledger.cancelSource(target, messageId) }
      catch (error) { diagnose({ stage: 'runtime', operation: 'media_cancel', outcome: 'unknown', code: 'cancel_ledger_failed', error }); throw error }
      finally { for (const [id, entry] of matching) if (!entry.preparing && !entry.sending) await cleanup(id, entry) }
    },
    async stop() {
      stopped = true
      for (const entry of entries.values()) entry.cancel.abort()
      await Promise.allSettled([...tasks])
      for (const [id, entry] of entries) await cleanup(id, entry)
    },
  }
}
