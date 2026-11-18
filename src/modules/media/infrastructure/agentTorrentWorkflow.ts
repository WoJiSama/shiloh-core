import type { AgentDiagnosticScope } from '../../../contracts/agentDiagnostics.js'
import type { AgentDiagnostics } from '../../runtime/infrastructure/agentDiagnostics.js'
import { createHash } from 'node:crypto'
import type { AgentBindingSnapshot, ConversationAddress, PlatformUserRef } from '../../../contracts/agentBinding.js'
import type { AgentMediaResourceContext } from '../../../contracts/agentMediaRelay.js'
import type { AgentTorrentConfig, AgentTorrentMetadata, AgentTorrentProvider } from '../../../contracts/agentTorrent.js'
import type { IncomingMessage, MessageActionPort, MessageBundleItem } from '../../../contracts/platformMessage.js'
import type { FileDeliveryReceipt } from '../../../contracts/agentFileDelivery.js'
import type { DeliveryReceipt } from '../../../contracts/delivery.js'
import type { AgentInboxRedis } from '../../runtime/infrastructure/agentInbox.js'
import { conversationAddressKey, platformAccountKey } from '../../runtime/domain/agentBindings.js'
import { normalizeDeliveryReceipt } from '../../messaging/domain/deliveryReceipt.js'
import { normalizeFileDeliveryReceipt } from '../../messaging/infrastructure/agentFileDelivery.js'
import { sanitizeFinalReplyText } from '../../conversation/domain/replySanitizer.js'
import { validateMessageBundle } from '../../messaging/infrastructure/messageBundle.js'
import { validateAgentPreparedTorrent, validateAgentTorrentConfig, parseAgentTorrentMagnet, parseAgentTorrentSelection } from '../domain/agentTorrent.js'
import { createAgentTorrentLedger } from './agentTorrentLedger.js'
import { parseMagnetUri } from '../domain/torrentMagnet.js'

export interface AgentTorrentSource { readonly messageId: string; readonly sender: PlatformUserRef; readonly occurredAt: number }
export interface AgentTorrentWorkflowContext extends AgentMediaResourceContext {
  read(messageId: string, expected: AgentTorrentSource): Promise<IncomingMessage | undefined>
  release(): void
}
type Ledger = ReturnType<typeof createAgentTorrentLedger>
type Session = NonNullable<Awaited<ReturnType<Ledger['claim']>>>
type Reservation = NonNullable<Awaited<ReturnType<Ledger['reserveSelection']>>>
interface Entry {
  readonly session: Session
  readonly cancel: AbortController
  readonly reservation?: Reservation
  magnet?: string
  textSha256?: string
  context?: AgentTorrentWorkflowContext
  cleanup?: Promise<void>
  explained?: boolean
}
const failure = () => new Error('磁链来源、选择或投递已失效')
const source = (message: IncomingMessage): AgentTorrentSource => {
  if (!message.messageId) throw failure()
  return { messageId: message.messageId, sender: { ...message.sender }, occurredAt: message.occurredAt }
}
const selectionHint = (text: string) => /^(?:下载|下|选择|选)\s*.{1,4096}$/u.test(text.trim())
const scope = (target: ConversationAddress) => JSON.stringify([target.account.platform, target.account.namespace, target.kind, target.id])
const same = (message: IncomingMessage | undefined, target: ConversationAddress, expected: AgentTorrentSource) => !!message &&
  conversationAddressKey(message.conversation) === conversationAddressKey(target) && message.messageId === expected.messageId &&
  message.occurredAt === expected.occurredAt && platformAccountKey(message.sender) === platformAccountKey(expected.sender)

/** Complete Core-owned workflow, outside model deadlines and without model-selected receivers. */
export function createAgentTorrentWorkflow(options: {
  readonly diagnostics?: Pick<AgentDiagnostics, 'emit' | 'traceId'>
  withDiagnosticScope?<T>(scope: AgentDiagnosticScope, operation: string, run: () => Promise<T>): Promise<T>
  explainFailure?(input: { detail: string; isCurrent: () => Promise<boolean> | boolean; signal?: AbortSignal }): Promise<string | undefined>
  readonly config?: AgentTorrentConfig
  readonly storage: AgentInboxRedis
  readonly actions: MessageActionPort
  readonly provider?: AgentTorrentProvider
  readonly allowsText?: (text: string) => boolean
  readonly now?: () => number
  isCurrent(): boolean
  responsible(message: IncomingMessage): boolean
  openContext(record: { readonly binding: AgentBindingSnapshot; readonly trigger: AgentTorrentSource; readonly source: AgentTorrentSource; readonly expiresAt: number },
    signal: AbortSignal): Promise<AgentTorrentWorkflowContext | 'wait' | undefined>
  /** Optional neutral card renderer. A rendering failure before delivery falls back to complete text. */
  renderListing?(text: string, context: AgentMediaResourceContext): Promise<{ readonly mime: string; readonly base64: string }>
}) {
  const diagnose = (input: Parameters<AgentDiagnostics['emit']>[0]) => { try { options.diagnostics?.emit(input) } catch { /* Diagnostics cannot change effects. */ } }
  const inScope = <T>(entry: Entry, operation: string, run: () => Promise<T>) => {
    const observed = async () => {
      diagnose({ stage: 'runtime', operation, outcome: 'started' })
      try { const result = await run(); const state = entry.session.record.state; diagnose({ stage: 'runtime', operation, outcome: state === 'failed' || state === 'unknown' || state === 'cancelled' ? state : 'succeeded', code: 'workflow_settled' }); return result }
      catch (error) { diagnose({ stage: 'runtime', operation, outcome: 'failed', code: 'workflow_threw', error }); throw error }
    }
    return options.withDiagnosticScope ? options.withDiagnosticScope({ kind: 'conversation', binding: entry.session.record.binding, messageId: entry.session.record.source.messageId }, operation, observed) : observed()
  }
  const config = validateAgentTorrentConfig(options.config), now = options.now ?? Date.now
  if (config.enabled && typeof options.provider?.prepare !== 'function') throw failure()
  const ledger = createAgentTorrentLedger(options.storage, { now })
  const entries = new Map<string, Entry>(), tasks = new Set<Promise<void>>()
  let stopped = false, started = false, scanning = false, running = false
  const live = () => { try { return config.enabled && !stopped && options.isCurrent() } catch { return false } }
  const safe = (text: string) => typeof text === 'string' && sanitizeFinalReplyText(text) === text && options.allowsText?.(text) !== false
  const current = (entry: Entry) => { try { return live() && !entry.cancel.signal.aborted && entry.context?.signal.aborted === false && entry.context.isCurrent() } catch { return false } }
  const wait = <T>(promise: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> => new Promise((resolve, reject) => {
    let settled = false
    const abort = () => { settled = true; signal.removeEventListener('abort', abort); reject(failure()) }
    promise.then(value => { signal.removeEventListener('abort', abort); if (settled || signal.aborted) { late?.(value); reject(failure()) } else { settled = true; resolve(value) } },
      () => { signal.removeEventListener('abort', abort); settled = true; reject(failure()) })
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
  })
  const cleanup = (entry: Entry) => entry.cleanup ??= (async () => {
    entry.cancel.abort()
    try { entry.context?.release() } catch (error) { diagnose({ stage: 'runtime', operation: 'torrent_cleanup', outcome: 'failed', code: 'context_release_failed', error }) }
    try { entry.session.abandon() } finally { if (entries.get(entry.session.record.id) === entry) entries.delete(entry.session.record.id) }
  })()
  const track = (task: Promise<void>) => { tasks.add(task); void task.then(() => tasks.delete(task), error => { tasks.delete(task); diagnose({ stage: 'runtime', operation: 'torrent_task', outcome: 'failed', code: 'background_task_failed', error }) }) }
  async function refresh(entry: Entry): Promise<{ trigger: IncomingMessage; original: IncomingMessage; magnet: string }> {
    if (!current(entry)) throw failure()
    await wait(Promise.resolve().then(() => entry.context!.ensureCurrent?.()), entry.cancel.signal)
    const record = entry.session.record, target = record.binding.target
    const original = await wait(entry.context!.read(record.source.messageId, record.source), entry.cancel.signal)
    const trigger = record.trigger.messageId === record.source.messageId ? original : await wait(entry.context!.read(record.trigger.messageId, record.trigger), entry.cancel.signal)
    if (!same(original, target, record.source) || !same(trigger, target, record.trigger) || !current(entry)) { entry.cancel.abort(); throw failure() }
    const magnet = parseAgentTorrentMagnet(original!.text)
    const textSha256 = createHash('sha256').update(original!.text).digest('hex')
    if (!magnet || entry.magnet !== undefined && magnet !== entry.magnet || entry.textSha256 !== undefined && entry.textSha256 !== textSha256 ||
      !safe(original!.text) || !safe(trigger!.text)) { entry.cancel.abort(); throw failure() }
    entry.magnet ??= magnet
    entry.textSha256 ??= textSha256
    return { original: original!, trigger: trigger!, magnet }
  }
  async function effect(entry: Entry, stage: 'notice' | 'listing' | 'archive' | 'confirmation' | 'failure', send: () => Promise<DeliveryReceipt | FileDeliveryReceipt>) {
    await refresh(entry)
    try { await entry.session.begin(stage) } catch (error) { diagnose({ stage: 'delivery', operation: `torrent_${stage}`, outcome: 'unknown', code: 'effect_begin_failed', error }); throw error }
    diagnose({ stage: 'delivery', operation: `torrent_${stage}`, outcome: 'started' })
    let receipt: DeliveryReceipt | FileDeliveryReceipt
    try { if (!current(entry)) throw failure(); const result = await send(); receipt = stage === 'archive' ? normalizeFileDeliveryReceipt(result) : normalizeDeliveryReceipt(result) }
    catch (error) { diagnose({ stage: 'delivery', operation: `torrent_${stage}`, outcome: 'unknown', code: 'effect_threw', error }); receipt = { state: 'unknown' } }
    const ids = receipt.state === 'sent' ? [receipt.messageId] : receipt.state === 'uploaded' ? [receipt.fileId, receipt.messageId] : []
    if (ids.some(id => id !== undefined && !safe(id))) receipt = { state: 'unknown' }
    try { await entry.session.finish(stage, receipt) } catch (error) { diagnose({ stage: 'delivery', operation: `torrent_${stage}`, outcome: 'unknown', code: 'effect_ledger_failed', error }); throw error }
    diagnose({ stage: 'delivery', operation: `torrent_${stage}`, outcome: receipt.state === 'sent' || receipt.state === 'uploaded' ? 'succeeded' : receipt.state, code: receipt.state === 'unknown' ? 'effect_unknown' : receipt.state === 'failed' ? 'effect_rejected' : 'effect_confirmed' })
    if (receipt.state === 'unknown') throw failure()
    if (!current(entry)) throw failure()
    return receipt
  }
  async function text(entry: Entry, stage: 'notice' | 'listing' | 'confirmation' | 'failure', value: string) {
    if (!safe(value) || value.length > 32_000) throw failure()
    const { binding } = entry.session.record
    return effect(entry, stage, () => options.actions.send({ version: 1, kind: 'message.send', binding, target: binding.target,
      parts: [{ kind: 'text', text: value }] }, { isCurrent: () => current(entry) }))
  }
  function listing(metadata: AgentTorrentMetadata, available: readonly number[]): string {
    const lines = ['【磁链文件清单】', `根目录：${metadata.name}/`, `文件：${metadata.files.length} 个；总大小：${metadata.totalBytes} B`,
      '整包超出限制，请从标为可下载的文件中选择，最多3个、合计50 MB。']
    for (const file of metadata.files) lines.push(`${file.index}｜${available.includes(file.index) ? '可下载' : '不可下载（超出单次限制）'}｜${file.relativePath.slice(1).join('/') || metadata.name}｜${file.size} B`)
    lines.push(`回复“下载 ${available.slice(0, 2).join(',')}”或唯一完整文件名；清单仅供原发起人在当前群内使用。`)
    const result = lines.join('\n')
    if (Buffer.byteLength(result) > 1_100_000 || !safe(result)) throw failure()
    return result
  }
  function splitListing(value: string, maximum: number): readonly string[] {
    const pages: string[] = []
    for (let offset = 0; offset < value.length;) {
      let end = Math.min(value.length, offset + maximum)
      if (end < value.length) {
        const newline = value.lastIndexOf('\n', end)
        if (newline > offset) end = newline
        else { const slash = value.lastIndexOf('/', end); if (slash > offset) end = slash + 1 }
      }
      if (end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1]!)) end--
      const page = value.slice(offset, end).replace(/^\n|\n$/gu, '')
      if (page) pages.push(page)
      offset = end
      if (value[offset] === '\n') offset++
    }
    if (!pages.length || pages.length > 512) throw failure()
    return pages
  }
  function listingPages(value: string): readonly string[] {
    const pages = splitListing(value, options.actions.sendBundle ? 30_000 : 3_800)
    return pages.map((page, index) => `【磁链清单 ${index + 1}/${pages.length}】\n${page}\n【本页结束】`)
  }
  async function sendListing(entry: Entry, value: string) {
    const { binding } = entry.session.record
    let items: readonly MessageBundleItem[] | undefined
    if (value.length <= 32_000 && options.renderListing && options.actions.sendBundle) {
      try { const image = await wait(options.renderListing(value, entry.context!), entry.cancel.signal); items = validateMessageBundle([{ parts: [{ kind: 'image', ...image }] }]) }
      catch (error) { diagnose({ stage: 'runtime', operation: 'torrent_render_listing', outcome: 'failed', code: 'listing_render_failed', error }); if (!current(entry)) throw failure() }
    }
    if (!items && options.actions.sendBundle) {
      const parts: MessageBundleItem[] = []
      for (const text of splitListing(value, 4000)) parts.push({ parts: [{ kind: 'text', text }] })
      items = validateMessageBundle(parts)
    }
    if (!items) return text(entry, 'listing', value)
    return effect(entry, 'listing', () => options.actions.sendBundle!({ version: 1, kind: 'message.bundle.send', binding, target: binding.target, items: items! }, { isCurrent: () => current(entry) }))
  }
  async function sendFailure(entry: Entry, detail: string, legacy: string) {
    diagnose({ stage: 'notification', operation: 'torrent_failure_notice', outcome: 'failed', code: 'request_unfulfilled' })
    if (!options.explainFailure) return text(entry, 'failure', legacy)
    const authorized = async () => {
      if (entry.session.record.stages.some(stage => stage.state === 'pending' || stage.state === 'unknown')) return false
      try { await refresh(entry); return current(entry) } catch { return false }
    }
    if (entry.explained || !await authorized()) return undefined
    entry.explained = true
    const signal = AbortSignal.any([entry.cancel.signal, entry.context!.signal, AbortSignal.timeout(15_000)])
    try {
      const value = await wait(options.explainFailure({ detail, isCurrent: authorized, signal }), signal)
      if (typeof value === 'string' && value.trim() && value.length <= 1200 && safe(value) && await authorized()) return text(entry, 'failure', value)
      diagnose({ stage: 'notification', operation: 'torrent_failure_notice', outcome: 'failed', code: 'explanation_unavailable' })
    } catch (error) { diagnose({ stage: 'notification', operation: 'torrent_failure_notice', outcome: 'failed', code: 'explanation_failed', error }) }
    return undefined
  }
  async function run(entry: Entry) {
    return inScope(entry, 'torrent_run', async () => {
      let deferred = false
      try {
        const record = entry.session.record
        const context = await wait(options.openContext(record, entry.cancel.signal), entry.cancel.signal, late => { if (late && late !== 'wait') late.release() })
        if (context === 'wait') { deferred = true; return }
        if (!context) { await entry.session.close('cancelled'); return }
        entry.context = context
        const signal = AbortSignal.any([context.signal, entry.cancel.signal])
        const cancel = () => entry.cancel.abort(); signal.addEventListener('abort', cancel, { once: true })
        try {
          signal.throwIfAborted()
          await entry.session.preparing()
          const fresh = await refresh(entry), pending = entry.reservation?.selection
          // A malformed selection may report one failure, but can never become a whole-torrent request.
          if (record.trigger.messageId !== record.source.messageId && !pending) throw failure()
          const indexes = pending ? parseAgentTorrentSelection(fresh.trigger.text, pending.metadata) : undefined
          if (pending && (!indexes || fresh.magnet !== pending.magnet || indexes.some(index => !pending.selectableIndexes.includes(index)))) throw failure()
          if (!pending) {
            const notice = await text(entry, 'notice', '正在识别磁链；符合限制后会将 ZIP 私发给原发起人。')
            if (notice.state !== 'sent') { await entry.session.close('failed'); return }
          }
          diagnose({ stage: 'runtime', operation: 'torrent_provider_prepare', outcome: 'started' })
          const produced = validateAgentPreparedTorrent(await wait(options.provider!.prepare(fresh.magnet, pending ? { indexes: indexes!, expectedFingerprint: pending.metadata.fingerprint } : undefined,
            { signal, isCurrent: () => current(entry), ensureCurrent: () => entry.context!.ensureCurrent?.() ?? Promise.resolve() }).catch(error => { diagnose({ stage: 'runtime', operation: 'torrent_provider_prepare', outcome: 'failed', code: 'provider_threw', error }); throw error }), entry.cancel.signal)
          )
          diagnose({ stage: 'runtime', operation: 'torrent_provider_prepare', outcome: 'succeeded', code: 'provider_returned' })
          await refresh(entry)
          const metadata = produced.metadata
          if (![metadata.name, ...metadata.files.flatMap(file => file.relativePath)].every(safe)) throw failure()
          if (metadata.infoHash !== parseMagnetUri(fresh.magnet).infoHash) throw failure()
          if (pending && (metadata.fingerprint !== pending.metadata.fingerprint || metadata.infoHash !== pending.metadata.infoHash ||
            metadata.name !== pending.metadata.name || metadata.totalBytes !== pending.metadata.totalBytes ||
            metadata.files.length !== pending.metadata.files.length || metadata.files.some((file, index) => {
              const before = pending.metadata.files[index]!
              return file.index !== before.index || file.size !== before.size || file.relativePath.length !== before.relativePath.length ||
                file.relativePath.some((part, offset) => part !== before.relativePath[offset])
            }))) throw failure()
          if (produced.status === 'selection-required') {
            if (pending || !Array.isArray(produced.selectableIndexes) || !produced.selectableIndexes.length ||
              produced.selectableIndexes.some(index => !Number.isSafeInteger(index) || !metadata.files.some(file => file.index === index)) ||
              new Set(produced.selectableIndexes).size !== produced.selectableIndexes.length) throw failure()
            const pages = listingPages(listing(metadata, produced.selectableIndexes))
            await entry.session.saveSelection({ magnet: fresh.magnet, metadata, selectableIndexes: [...produced.selectableIndexes], ttlSeconds: config.selectionTtlSeconds, listingParts: pages.length })
            for (const page of pages) {
              const delivered = await sendListing(entry, page)
              if (delivered.state !== 'sent') { await entry.session.close('failed'); return }
            }
            await entry.session.close('awaiting-selection')
            return
          }
          const archive = produced.archive
          if (!safe(archive.name)) throw failure()
          const delivered = await effect(entry, 'archive', () => options.actions.sendRequesterArchive ? options.actions.sendRequesterArchive({
            version: 1, kind: 'requester-archive.upload', target: record.binding.target, binding: record.binding,
            source: { ...record.source, textSha256: entry.textSha256! }, archive,
          }, { signal, isCurrent: () => current(entry) }) : Promise.resolve({ state: 'failed', code: 'requester_archive_unavailable' }))
          if (delivered.state === 'uploaded') {
            await entry.reservation?.commit()
            const confirmed = await text(entry, 'confirmation', `磁链内容已私发给发起人：${archive.name}。`)
            await entry.session.close(confirmed.state === 'sent' ? 'completed' : 'failed')
          } else {
            await sendFailure(entry, 'ZIP私发被平台明确拒绝，未确认交付，没有改发到群内，当前请求未完成', 'ZIP 私发被平台明确拒绝，已停止；没有改发到群内。')
            await entry.session.close('failed')
          }
        } finally { signal.removeEventListener('abort', cancel) }
      } catch (error) {
        diagnose({ stage: 'runtime', operation: 'torrent_run', outcome: entry.session.record.stages.some(stage => stage.state === 'pending' || stage.state === 'unknown') ? 'unknown' : 'failed', code: 'workflow_failed', error })
        if (!stopped) {
          const record = entry.session.record
          const uncertain = record.stages.some(stage => stage.state === 'pending' || stage.state === 'unknown')
          if (!uncertain && current(entry)) {
            try { await sendFailure(entry, '磁链处理未完成，来源、文件清单、资源限制或下载环境未通过验证，尚无成功交付结果', '磁链处理未完成：来源、文件清单、资源限制或下载环境未通过验证。'); await entry.session.close('failed') } catch (error) { diagnose({ stage: 'runtime', operation: 'torrent_cleanup', outcome: 'unknown', code: 'failure_close_failed', error }) }
          } else await entry.session.close(uncertain ? 'unknown' : 'cancelled').catch(error => diagnose({ stage: 'runtime', operation: 'torrent_cleanup', outcome: 'unknown', code: 'close_ledger_failed', error }))
        }
      } finally {
        await entry.reservation?.release().catch(error => diagnose({ stage: 'runtime', operation: 'torrent_cleanup', outcome: 'failed', code: 'reservation_release_failed', error }))
        await cleanup(entry); running = false
        if (!stopped && !deferred) void tick().catch(() => {})
      }
    })
  }
  const isCandidate = (message: IncomingMessage) => live() && message.conversation.kind === 'group' && !!message.messageId &&
    (config.autoDetect && !!parseAgentTorrentMagnet(message.text) || selectionHint(message.text))
  async function handle(message: IncomingMessage, binding: AgentBindingSnapshot): Promise<boolean> {
    if (!isCandidate(message)) return false
    const initial = parseAgentTorrentMagnet(message.text)
    if (initial && (!config.autoDetect || !options.responsible(message))) return false
    const trigger = source(message)
    let pending: Awaited<ReturnType<Ledger['readSelection']>>
    if (!initial) { pending = await ledger.readSelection(binding, message.sender); if (!pending) return false }
    const original = pending?.source ?? trigger, cancel = new AbortController()
    const context = await options.openContext({ binding, trigger, source: original, expiresAt: now() + 86_400_000 }, cancel.signal)
    if (context === 'wait') throw failure()
    if (!context) return true
    try {
      const observed = await context.read(trigger.messageId, trigger), origin = trigger.messageId === original.messageId ? observed : await context.read(original.messageId, original)
      if (!same(observed, binding.target, trigger) || !same(origin, binding.target, original) || !context.isCurrent() || !live() ||
        parseAgentTorrentMagnet(origin!.text) !== (initial ?? pending?.magnet)) throw failure()
      const admit = (session: Session, reservation?: Reservation) => {
        if (!live()) { session.abandon(); return }
        const existing = entries.get(session.record.id)
        if (existing) { if (existing.session !== session) session.abandon(); return }
        entries.set(session.record.id, { session, cancel, magnet: initial ?? pending!.magnet, ...(reservation ? { reservation } : {}) })
      }
      if (!initial && pending) {
        let indexes: readonly number[] | undefined
        try { indexes = parseAgentTorrentSelection(observed!.text, pending.metadata) } catch { /* A claimed failure can report this once. */ }
        if (!indexes || indexes.some(index => !pending!.selectableIndexes.includes(index))) {
          const session = await ledger.claim(binding, trigger, original)
          if (session) admit(session)
        } else {
          const reservation = await ledger.reserveSelection(binding, trigger)
          if (reservation) admit(reservation.session, reservation)
        }
      } else {
        const session = await ledger.claim(binding, trigger)
        if (session) admit(session)
      }
      void tick().catch(() => {})
      return true
    } catch (error) { diagnose({ stage: 'runtime', operation: 'torrent_admission', outcome: 'failed', code: 'admission_failed', error }); throw error }
    finally { try { context.release() } catch (error) { diagnose({ stage: 'runtime', operation: 'torrent_cleanup', outcome: 'failed', code: 'admission_release_failed', error }) } }
  }
  async function tick(): Promise<void> {
    if (!started || !live() || scanning) return
    scanning = true
    try {
      await ledger.recover()
      if (running) return
      const first = entries.values().next().value as Entry | undefined
      if (first) { running = true; track(run(first)); return }
      for (const record of await ledger.listActive()) {
        if (!live()) return
        if (record.state !== 'queued' || entries.has(record.id)) continue
        const cancel = new AbortController()
        const probe = await options.openContext(record, cancel.signal)
        if (probe === 'wait') continue
        if (probe) { try { probe.release() } catch (error) { diagnose({ stage: 'runtime', operation: 'torrent_cleanup', outcome: 'failed', code: 'probe_release_failed', error }) } }
        const reservation = record.trigger.messageId === record.source.messageId ? undefined : await ledger.reserveSelection(record.binding, record.trigger)
        const session = reservation?.session ?? await ledger.claim(record.binding, record.trigger, record.source)
        if (!session) continue
        if (!live()) { session.abandon(); return }
        const entry: Entry = { session, cancel, ...(reservation ? { reservation, magnet: reservation.selection.magnet } : {}) }
        entries.set(record.id, entry); running = true; track(run(entry)); break
      }
    } catch (error) { diagnose({ stage: 'runtime', operation: 'torrent_tick', outcome: 'failed', code: 'tick_failed', error }); throw error }
    finally { scanning = false }
  }
  return {
    ledger, isCandidate, handle, tick,
    async start() { if (!config.enabled || stopped || started) return; started = true; await tick() },
    async cancelSource(target: ConversationAddress, messageId: string) {
      for (const entry of entries.values()) if (scope(entry.session.record.binding.target) === scope(target) &&
        [entry.session.record.source.messageId, entry.session.record.trigger.messageId].includes(messageId)) entry.cancel.abort()
      try { await ledger.cancelSource(target, messageId) } catch (error) { diagnose({ stage: 'runtime', operation: 'torrent_cancel', outcome: 'unknown', code: 'cancel_ledger_failed', error }); throw error }
    },
    async stop() { stopped = true; for (const entry of entries.values()) entry.cancel.abort(); await Promise.allSettled([...tasks]); for (const entry of entries.values()) await cleanup(entry) },
  }
}
