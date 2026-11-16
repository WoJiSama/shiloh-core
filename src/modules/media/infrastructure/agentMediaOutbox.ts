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
  readonly storage: AgentInboxRedis
  readonly actions: MessageActionPort
  readonly provider?: AgentMediaRelayProvider
  readonly allowsText?: (text: string) => boolean
  readonly now?: () => number
  /** 'wait' preserves a queued task while its exact account is disconnected. */
  openContext(record: AgentMediaOutboxRecord, signal: AbortSignal): Promise<AgentMediaOutboxContext | 'wait' | undefined>
}) {
  const now = options.now ?? Date.now
  const ledger = createAgentMediaOutboxLedger(options.storage, { now })
  const entries = new Map<string, Entry>(), tasks = new Set<Promise<void>>(), connections = new Set<string>()
  let stopped = false, scanning = false, preparing = 0, started = false
  const safeText = (text: string) => typeof text === 'string' && sanitizeFinalReplyText(text) === text && options.allowsText?.(text) !== false
  const sendCurrent = (entry: Entry) => !stopped && !entry.cancel.signal.aborted && entry.context?.signal.aborted === false && entry.context.isCurrent()
  const track = (task: Promise<void>) => { tasks.add(task); void task.then(() => tasks.delete(task), () => tasks.delete(task)) }
  const wait = <T>(promise: Promise<T>, signal: AbortSignal, late?: (value: T) => Promise<unknown>): Promise<T> => new Promise((resolve, reject) => {
    let settled = false
    const abort = () => { settled = true; signal.removeEventListener('abort', abort); reject(failure()) }
    promise.then(value => {
      signal.removeEventListener('abort', abort)
      if (settled || signal.aborted) { if (late) void Promise.resolve().then(() => late(value)).catch(() => {}); reject(failure()); return }
      settled = true; resolve(value)
    }, () => { signal.removeEventListener('abort', abort); settled = true; reject(failure()) })
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
  })
  const releasePrepared = async (value: AgentPreparedMediaRelay | Prepared) => { try { await value.release() } catch { /* Continue owned cleanup. */ } }
  function cleanup(id: string, entry: Entry): Promise<void> {
    return entry.cleanup ??= (async () => {
      entry.cancel.abort()
      if (entry.context && entry.abortContext) entry.context.signal.removeEventListener('abort', entry.abortContext)
      if (entry.prepared) await releasePrepared(entry.prepared)
      try { entry.context?.release() } catch { /* A host cleanup must not retain the durable claim. */ }
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
    return Object.freeze({ plan, infoText: input.infoText, pageUrl: input.pageUrl, linkOnly: false,
      release: () => release.call(input) })
  }
  async function prepare(record: AgentMediaOutboxRecord, entry: Entry) {
    try {
      const context = await wait(options.openContext(record, entry.cancel.signal), entry.cancel.signal, async late => { if (late && late !== 'wait') late.release() })
      if (context === 'wait') return
      if (!context || !options.provider) { await entry.session.close('cancelled'); return }
      entry.context = context
      const abort = () => entry.cancel.abort()
      entry.abortContext = abort
      if (context.signal.aborted) abort(); else context.signal.addEventListener('abort', abort, { once: true })
      await current(entry, true)
      await entry.session.preparing()
      await current(entry)
      const result = await wait(Promise.resolve().then(() => options.provider!.prepare(record.source.share, prepareContext(entry))), entry.cancel.signal, releasePrepared)
      try { entry.prepared = prepared(result, record.source.share) } catch { await releasePrepared(result); throw failure() }
      await current(entry, true)
      entry.readyAt = now()
    } catch {
      try {
        if (stopped) return
        if (!entry.context?.isCurrent() || entry.cancel.signal.aborted) await entry.session.close('cancelled')
        else if (entry.session.record.prepareFailures < 2) await entry.session.retry(now() + 1000 * 3 ** entry.session.record.prepareFailures)
        else {
          // Even a final preparation failure waits for its FIFO/connection lane.
          const share = validateAgentMediaShare(record.source.share), pageUrl = agentMediaSharePageUrl(share)
          if (entry.prepared) await releasePrepared(entry.prepared)
          const infoText = share.provider === 'bilibili' ? 'B站视频（视频资源准备失败）'
            : share.provider === 'douyin' ? '抖音作品（媒体资源准备失败）'
              : share.provider === 'youtube' ? 'YouTube视频（媒体资源准备失败）'
                : share.provider === 'pixiv' ? 'Pixiv作品（图片资源准备失败）' : '小红书笔记（媒体资源准备失败）'
          entry.prepared = { pageUrl, infoText, linkOnly: true,
            plan: { version: 1, items: [{ parts: [{ kind: 'text', text: infoText }] }] }, async release() {} }
          entry.readyAt = now()
        }
      } catch { /* A failed CAS retains its prior marker; recovery cannot assume delivery. */ }
    } finally {
      preparing--; entry.preparing = false
      if (entry.readyAt === undefined) await cleanup(record.id, entry)
      if (!stopped && entry.readyAt !== undefined) void tick().catch(() => {})
    }
  }
  async function effect(entry: Entry, name: MediaOutboxEffect, send: () => Promise<DeliveryReceipt>): Promise<DeliveryReceipt> {
    await current(entry, true)
    await entry.session.begin(name)
    let receipt: DeliveryReceipt
    try { await current(entry); receipt = normalizeDeliveryReceipt(await send()) } catch { receipt = { state: 'unknown' } }
    if (receipt.state === 'sent' && !safeText(receipt.messageId)) receipt = { state: 'unknown' }
    await entry.session.finish(name, receipt)
    if (receipt.state === 'unknown') throw failure()
    await current(entry)
    return receipt
  }
  const linkText = (value: Prepared) => `${value.infoText}\n${value.pageUrl}\n（媒体转发资源暂不可用，已改为发送原作品链接）`
  async function text(entry: Entry, name: 'directIntro' | 'link', value: string) {
    if (!safeText(value)) throw failure()
    const binding = entry.session.record.binding
    return effect(entry, name, () => options.actions.send({ version: 1, kind: 'message.send', target: binding.target,
      binding, parts: [{ kind: 'text', text: value }] }, { isCurrent: () => sendCurrent(entry) }))
  }
  async function deliver(id: string, entry: Entry) {
    const record = entry.session.record, connection = record.binding.connectionId
    try {
      const value = entry.prepared!
      await current(entry, true)
      if (value.linkOnly) {
        const sent = await text(entry, 'link', linkText(value))
        await entry.session.close(sent.state === 'sent' ? 'completed' : 'failed'); return
      }
      const binding = record.binding
      const relay = (name: 'forward' | 'forwardRetry' | 'directVideo', plan: AgentMediaRelayPlan) => effect(entry, name,
        async () => options.actions.sendMediaRelay ? options.actions.sendMediaRelay({ version: 1, kind: 'media-relay.send',
          target: binding.target, binding, mode: name === 'directVideo' ? 'direct-video' : 'forward', plan },
        { signal: entry.cancel.signal, isCurrent: () => sendCurrent(entry) }) : { state: 'failed', code: 'media_relay_unavailable' })
      const videos: AgentMediaRelayPlan = { version: 1, items: value.plan.items.flatMap(item => item.parts.flatMap(part => part.kind === 'video' ? [{ parts: [part] }] : [])) }
      let result = await relay('forward', value.plan)
      if (result.state === 'sent') { await entry.session.close('completed'); return }
      if (result.state === 'failed' && result.code === 'video_thumbnail_missing') {
        const linked = await text(entry, 'link', linkText(value))
        await entry.session.close(linked.state === 'sent' ? 'completed' : 'failed'); return
      }
      if (result.state !== 'failed' || result.code !== 'media_resource_preprocessing_failed') { await entry.session.close('failed'); return }
      result = await relay('forwardRetry', value.plan)
      if (result.state === 'sent') { await entry.session.close('completed'); return }
      if (result.state !== 'failed' || result.code !== 'media_resource_preprocessing_failed') { await entry.session.close('failed'); return }
      if (!videos.items.length) {
        const linked = await text(entry, 'link', linkText(value))
        await entry.session.close(linked.state === 'sent' ? 'completed' : 'failed'); return
      }
      const intro = await text(entry, 'directIntro', `${value.infoText}\n${value.pageUrl}\n（合并转发上传失败，视频改为直接发送）`)
      if (intro.state === 'sent') {
        const direct = await relay('directVideo', videos)
        if (direct.state === 'sent') { await entry.session.close('completed'); return }
      }
      const linked = await text(entry, 'link', linkText(value))
      await entry.session.close(linked.state === 'sent' ? 'completed' : 'failed')
    } catch {
      if (!stopped) await entry.session.close(entry.session.record.effects.length ? 'unknown' : 'cancelled').catch(() => {})
    } finally {
      connections.delete(connection); await cleanup(id, entry)
      if (!stopped) void tick().catch(() => {})
    }
  }
  async function tick(): Promise<void> {
    if (stopped || scanning || !started) return
    scanning = true
    try {
      await ledger.recover()
      const records = await ledger.listActive(), heads = new Map<string, string>(), active = new Set(records.map(record => record.id))
      for (const entry of entries.values()) if (entry.session.record.expiresAt <= now()) entry.cancel.abort()
      for (const [id, entry] of entries) if (!entry.preparing && !entry.sending && (!active.has(id) || entry.cancel.signal.aborted)) {
        if (active.has(id)) await entry.session.close(entry.session.record.effects.length ? 'unknown' : 'cancelled').catch(() => {})
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
        const session = await ledger.claim(record.id)
        if (!session) continue
        if (stopped) { session.abandon(); return }
        const entry: Entry = { session, cancel: new AbortController(), preparing: true, sending: false }
        entries.set(record.id, entry); preparing++; track(prepare(record, entry))
      }
    } finally { scanning = false }
  }
  return {
    ledger,
    async start() { if (started || stopped) return; await ledger.recover(); started = true; await tick() },
    tick,
    async cancelSource(target: ConversationAddress, messageId: string) {
      const matching = [...entries].filter(([, entry]) => entry.session.record.source.messageId === messageId &&
        agentMediaSourceScopeKey(entry.session.record.binding.target) === agentMediaSourceScopeKey(target))
      // Revoke in-memory readers immediately even if durable cancellation loses its reply.
      for (const [, entry] of matching) entry.cancel.abort()
      try { await ledger.cancelSource(target, messageId) }
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
