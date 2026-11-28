import { AsyncLocalStorage } from 'node:async_hooks'
import { types } from 'node:util'
import type { AgentBindingSnapshot, ConversationAddress, PlatformAccountRef } from '../contracts/agentBinding.js'
import type { AgentDiagnosticDetails } from '../contracts/agentDiagnostics.js'
import type { AgentMediaArtifact, AgentMediaRelayPlan, SendMediaRelayAction } from '../contracts/agentMediaRelay.js'
import type { DeliveryReceipt } from '../contracts/delivery.js'
import type { MessageActionOptions, MessageActionPort } from '../contracts/platformMessage.js'
import { validateAgentMediaRelayPlan } from '../modules/media/domain/agentMediaRelayPlan.js'
import { conversationAddressKey, platformAccountKey } from '../modules/runtime/domain/agentBindings.js'
import { annotateDeliveryFailure, type DeliveryFailureEvidence } from '../modules/messaging/domain/deliveryReceipt.js'
import { queuedDeliveryAllowed, withDeliveryGuard } from '../modules/messaging/infrastructure/deliveryScope.js'
import { qqId } from './qqIdentity.js'
import type { QqMediaRelayBridge } from './qqMediaRelayBridge.js'

export const QQ_MEDIA_RELAY_SEND_TIMEOUT_MS = 90 * 60 * 1000
const MAX_WAITING = 4
type NativeAction = 'send_group_forward_msg' | 'send_private_forward_msg' | 'send_group_msg' | 'send_private_msg'
type RelayOptions = MessageActionOptions & { readonly signal?: AbortSignal }
type BridgeLease = Awaited<ReturnType<QqMediaRelayBridge['stage']>>
const failed = (code: string): DeliveryReceipt => ({ state: 'failed', code })

function unconfirmed(code: string, details: AgentDiagnosticDetails = {}): DeliveryReceipt {
  return annotateDeliveryFailure({ state: 'unknown' }, { code,
    details: { step: 'qq_media_response', result: 'confirmation_pending', ...details } })
}

function data(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw Error('Invalid relay data')
  const owned: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !keys.includes(key)) throw Error('Invalid relay data')
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw Error('Invalid relay data')
    owned[key] = descriptor.value
  }
  return owned
}
function account(input: unknown): Readonly<PlatformAccountRef> {
  const row = data(input, ['platform', 'namespace', 'id'])
  if (row.platform !== 'qq' || row.namespace !== 'global' || typeof row.id !== 'string' || qqId(row.id) !== row.id) throw Error('Invalid relay account')
  return Object.freeze({ platform: row.platform, namespace: row.namespace, id: row.id })
}
function target(input: unknown): Readonly<ConversationAddress> {
  const row = data(input, ['account', 'kind', 'id'])
  if (row.kind !== 'group' && row.kind !== 'private' || typeof row.id !== 'string' || qqId(row.id) !== row.id) throw Error('Invalid relay target')
  return Object.freeze({ account: account(row.account), kind: row.kind, id: row.id })
}
function binding(input: unknown, targetKey: string, connectionId?: string): Readonly<AgentBindingSnapshot> | undefined {
  if (input === undefined) return undefined
  const row = data(input, ['source', 'id', 'revision', 'personaId', 'agentId', 'connectionId', 'target'])
  if (row.source !== 'configured' && row.source !== 'legacy') throw Error('Invalid relay binding')
  for (const key of ['id', 'revision', 'personaId', 'agentId', 'connectionId'] as const) {
    if (typeof row[key] !== 'string' || !row[key].length || row[key].length > 512 || /[\u0000-\u001f\u007f]/u.test(row[key])) throw Error('Invalid relay binding')
  }
  const address = target(row.target)
  if (conversationAddressKey(address) !== targetKey || connectionId !== undefined && row.connectionId !== connectionId) throw Error('Invalid relay binding')
  return Object.freeze({ source: row.source, id: row.id as string, revision: row.revision as string, personaId: row.personaId as string,
    agentId: row.agentId as string, connectionId: row.connectionId as string, target: address })
}
function messageId(value: unknown): value is number | string {
  return typeof value === 'number' && Number.isSafeInteger(value) && value !== 0 ||
    typeof value === 'string' && /^-?[1-9]\d{0,15}$/u.test(value) && Number.isSafeInteger(Number(value))
}
function qqForwardVideoPreSendFailure(value: unknown): string | undefined {
  let response
  try { response = data(value, ['status', 'retcode', 'data', 'message', 'wording', 'echo', 'stream', 'self_id', 'group_id', 'user_id']) }
  catch { return }
  const message = response.message
  if (response.status !== 'failed' || response.retcode !== 1200 || response.data !== null ||
      typeof message !== 'string' || message !== response.wording || message.length > 16_384) return
  const lines = message.split('\n'), first = lines.shift()
  if (lines.length < 1 || lines.length > 32 || !lines.every(line => /^    at (?:async )?(?:(?:new )?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)* \((?:[^()\r\n]{1,1024}:\d{1,8}:\d{1,8}|index \d{1,3})\)|[^()\s]{1,1024}:\d{1,8}:\d{1,8})$/u.test(line))) return
  const counts = /^发送伪造合并转发消息失败: AggregateError: 上传转发消息资源失败：([1-9]\d{0,2})\/([1-9]\d{0,2})$/u.exec(first ?? '')
  if (counts && Number(counts[1]) <= Number(counts[2]) && Number(counts[2]) <= 512) return 'media_resource_preprocessing_failed'
  // NapCat loads the video from the bridge inside createSendElements, before
  // uploading the forward packet and before sending the final group message.
  if (first !== '发送伪造合并转发消息失败: Error: other side closed') return
  const file = lines.findIndex(line => /\.handleOb11FileLikeMessage \(file:\/\/\/[^()]+\/napcat\.mjs:\d+:\d+\)$/u.test(line))
  const video = lines.findIndex(line => /^    at async video \(file:\/\/\/[^()]+\/napcat\.mjs:\d+:\d+\)$/u.test(line))
  const elements = lines.findIndex(line => /\.createSendElements \(file:\/\/\/[^()]+\/napcat\.mjs:\d+:\d+\)$/u.test(line))
  const packet = lines.findIndex(line => /\.uploadForwardedNodesPacket \(file:\/\/\/[^()]+\/napcat\.mjs:\d+:\d+\)$/u.test(line))
  if (file === 0 && file < video && video < elements && elements < packet) return 'media_resource_fetch_closed'
}
function receipt(value: unknown, address: ConversationAddress, mode: SendMediaRelayAction['mode'], hasVideo: boolean, transport?: DeliveryFailureEvidence): DeliveryReceipt {
  try {
    const response = data(value, ['status', 'retcode', 'data', 'message', 'wording', 'echo', 'stream', 'self_id', 'group_id', 'user_id', 'state', 'code'])
    if (response.state === 'failed') {
      const code = typeof response.code === 'string' && /^[a-zA-Z0-9_:-]{1,128}$/u.test(response.code) ? response.code : 'native_rejected'
      return annotateDeliveryFailure({ state: 'failed', code }, transport ?? { code, details: { step: 'qq_media_dispatch', dispatched: false, result: 'not_dispatched' } })
    }
    if (response.state === 'unknown') return unconfirmed(transport?.code ?? 'qq_media_transport_unconfirmed', transport?.details)
    const nativeCode = typeof response.retcode === 'number' && Number.isInteger(response.retcode) &&
      Math.abs(response.retcode) <= 2_147_483_647 ? response.retcode : undefined
    const native = { dispatched: true, ...(nativeCode === undefined ? {} : { nativeCode }) }
    if (response.retcode === 400 || response.retcode === 1400) return annotateDeliveryFailure({ state: 'failed', code: String(response.retcode) },
      { code: 'onebot_rejected', details: { step: 'qq_media_response', ...native } })
    // NapCat Bt serializes the same handler error into message and wording. Its
    // inspected packet resource AggregateError occurs before final native send.
    if (mode === 'forward' && hasVideo) {
      const failure = qqForwardVideoPreSendFailure(value)
      if (failure) return annotateDeliveryFailure({ state: 'failed', code: failure }, { code: failure,
        details: { step: 'qq_media_preprocess', ...(nativeCode === undefined ? {} : { nativeCode }), result: 'not_dispatched' } })
    }
    if (mode === 'forward' && response.status === 'failed' && response.retcode === 1200 && response.data === null &&
        typeof response.message === 'string' && response.message === response.wording &&
        /^发送转发消息（res_id：[a-zA-Z0-9_+./=-]{1,256} 失败$/u.test(response.message)) {
      return unconfirmed('qq_media_packet_uploaded_send_unconfirmed', { ...native, step: 'qq_media_final_send' })
    }
    if (response.status !== 'ok' || response.retcode !== 0) {
      return unconfirmed(response.status === 'failed' ? 'qq_media_handler_unconfirmed' : transport?.code ?? 'qq_media_receipt_invalid',
        { ...native, ...transport?.details })
    }
    if (!response.data || typeof response.data !== 'object') return unconfirmed('qq_media_message_id_missing', native)
    const detail = data(response.data, ['message_id', 'res_id', 'forward_id', 'self_id', 'group_id', 'user_id'])
    if (!messageId(detail.message_id)) return unconfirmed('qq_media_message_id_missing', native)
    for (const row of [response, detail]) {
      if (row.self_id !== undefined && String(row.self_id) !== address.account.id ||
          row.group_id !== undefined && (address.kind !== 'group' || String(row.group_id) !== address.id) ||
          row.user_id !== undefined && (address.kind !== 'private' || String(row.user_id) !== address.id)) return unconfirmed('qq_media_receipt_target_mismatch', native)
    }
    return { state: 'sent', messageId: String(detail.message_id) }
  } catch { return unconfirmed(transport?.code ?? 'qq_media_receipt_invalid', transport?.details) }
}

/** One connection owns one bounded queue. Native URLs stay inside this adapter. */
export function createQqMediaRelayDeliveryPort(options: {
  readonly account: PlatformAccountRef
  readonly connectionId?: string
  readonly bridge: QqMediaRelayBridge
  readonly allowsText?: (text: string) => boolean
  /** Trusted host/testing override can shorten, never extend the 90 minute ceiling. */
  readonly timeoutMs?: number
  sendApi(action: NativeAction, params: Record<string, unknown>, options: {
    readonly isCurrent: () => boolean; readonly signal: AbortSignal; readonly timeoutMs: number
    reportFailure(code: string, details: AgentDiagnosticDetails): void
  }): Promise<unknown>
}): NonNullable<MessageActionPort['sendMediaRelay']> {
  const configuredAccount = options.account, accountKey = platformAccountKey(account(configuredAccount)), connectionId = options.connectionId
  const bridge = options.bridge, sendApi = options.sendApi, allowsText = options.allowsText
  const timeoutMs = options.timeoutMs ?? QQ_MEDIA_RELAY_SEND_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > QQ_MEDIA_RELAY_SEND_TIMEOUT_MS) throw Error('QQ媒体转发配置无效')
  let active = false
  interface Waiting { run(): Promise<DeliveryReceipt>; resolve(value: DeliveryReceipt): void; signal: AbortSignal; abort(): void }
  const waiting: Waiting[] = []
  const drain = () => {
    if (active) return
    const next = waiting.shift()
    if (!next) return
    next.signal.removeEventListener('abort', next.abort)
    if (next.signal.aborted) { next.resolve(failed('binding_changed')); drain(); return }
    active = true
    void Promise.resolve().then(next.run).then(next.resolve, () => next.resolve(unconfirmed('qq_media_transport_unconfirmed'))).finally(() => { active = false; drain() })
  }
  const enqueue = (run: Waiting['run'], signal: AbortSignal): Promise<DeliveryReceipt> => {
    if (signal.aborted) return Promise.resolve(failed('binding_changed'))
    if (active && waiting.length >= MAX_WAITING) return Promise.resolve(failed('media_relay_busy'))
    return new Promise(resolve => {
      const inScope = AsyncLocalStorage.snapshot()
      const item: Waiting = { run: () => inScope(run), resolve, signal, abort() {
        const index = waiting.indexOf(item)
        if (index !== -1) { waiting.splice(index, 1); resolve(failed('binding_changed')) }
      } }
      waiting.push(item); signal.addEventListener('abort', item.abort, { once: true }); drain()
    })
  }
  return async (input: SendMediaRelayAction, guard: RelayOptions = {}): Promise<DeliveryReceipt> => {
    let entryScope: ReturnType<typeof AsyncLocalStorage.snapshot>
    try { entryScope = AsyncLocalStorage.snapshot() } catch { return failed('invalid_media_relay_guard') }
    let address: ConversationAddress, targetKey: string, bindingKey: string | undefined, plan: Readonly<AgentMediaRelayPlan>, mode: SendMediaRelayAction['mode']
    let callerSignal: AbortSignal | undefined, check: (() => boolean) | undefined, ensureCurrent: (() => Promise<void>) | undefined
    try {
      const scope = data(guard, ['signal', 'isCurrent', 'ensureCurrent'])
      if (scope.signal !== undefined && (types.isProxy(scope.signal) || !(scope.signal instanceof AbortSignal)) ||
          scope.isCurrent !== undefined && (typeof scope.isCurrent !== 'function' || types.isProxy(scope.isCurrent)) ||
          scope.ensureCurrent !== undefined && (typeof scope.ensureCurrent !== 'function' || types.isProxy(scope.ensureCurrent))) return failed('invalid_media_relay_guard')
      callerSignal = scope.signal as AbortSignal | undefined; check = scope.isCurrent as (() => boolean) | undefined
      ensureCurrent = scope.ensureCurrent as (() => Promise<void>) | undefined
    } catch { return failed('invalid_media_relay_guard') }
    try {
      const row = data(input, ['version', 'kind', 'target', 'binding', 'mode', 'plan'])
      if (row.version !== 1 || row.kind !== 'media-relay.send' || row.mode !== 'forward' && row.mode !== 'direct-video') return failed('invalid_media_relay')
      address = target(row.target); targetKey = conversationAddressKey(address)
      if (platformAccountKey(address.account) !== accountKey) return failed('invalid_media_relay_target')
      bindingKey = JSON.stringify(binding(row.binding, targetKey, connectionId))
      mode = row.mode
      plan = validateAgentMediaRelayPlan(row.plan, allowsText ? { allowsText } : {})
      // Direct video keeps the proven plain-message form (text, cover image and video
      // segments in one native message); forward wraps whole items as fake nodes.
      if (mode === 'direct-video' && plan.items.some(item => item.parts.some(part => part.kind !== 'video' && part.kind !== 'text' && part.kind !== 'image'))) return failed('invalid_direct_video')
      if (plan.items.some(item => item.parts.some(part => part.kind === 'video' && !part.thumbnail))) return failed('video_thumbnail_missing')
    } catch { return failed('invalid_media_relay') }
    const cancel = new AbortController(), deadline = new AbortController()
    let signal: AbortSignal
    try { signal = AbortSignal.any([cancel.signal, deadline.signal, ...(callerSignal ? [callerSignal] : [])]) }
    catch { return failed('invalid_media_relay_guard') }
    const isCurrent = () => {
      try {
        if (signal.aborted || check && check() !== true || !entryScope(queuedDeliveryAllowed) || platformAccountKey(account(configuredAccount)) !== accountKey) return false
        const row = data(input, ['version', 'kind', 'target', 'binding', 'mode', 'plan'])
        if (row.version !== 1 || row.kind !== 'media-relay.send' || row.mode !== mode || conversationAddressKey(target(row.target)) !== targetKey ||
            JSON.stringify(binding(row.binding, targetKey, connectionId)) !== bindingKey) return false
        return !allowsText || plan.items.every(item => item.parts.every(part => part.kind !== 'text' || allowsText(part.text) === true))
      } catch { return false }
    }
    const timer = setTimeout(() => deadline.abort(), timeoutMs)
    const watcher = setInterval(() => { if (!isCurrent()) cancel.abort() }, 20); watcher.unref()
    const wait = <T>(operation: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      const abort = () => reject(Error('QQ媒体转发已取消')), clear = () => signal.removeEventListener('abort', abort)
      operation.then(value => { clear(); resolve(value) }, () => { clear(); reject(Error('QQ媒体转发失败')) })
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
    })
    const ensure = async () => {
      if (!isCurrent()) throw Error('QQ媒体转发来源已失效')
      if (ensureCurrent) await wait(Promise.resolve().then(() => ensureCurrent!()))
      if (!isCurrent()) throw Error('QQ媒体转发来源已失效')
    }
    const interrupted = (transport?: DeliveryFailureEvidence) => {
      if (transport) return unconfirmed(transport.code, transport.details)
      if (deadline.signal.aborted) return unconfirmed('onebot_timeout', { limit: timeoutMs })
      return unconfirmed(signal.aborted || !isCurrent() ? 'qq_media_authority_lost' : 'qq_media_transport_unconfirmed')
    }
    try {
      if (!isCurrent()) return failed('binding_changed')
      return await enqueue(async () => {
        const leases: BridgeLease[] = [], urls = new Map<string, string>()
        let dispatched = false, accepting = true
        let transport: DeliveryFailureEvidence | undefined
        try {
          await ensure()
          const artifacts = new Map<string, AgentMediaArtifact>()
          for (const item of plan.items) for (const part of item.parts) {
            if (part.kind === 'text') continue
            artifacts.set(part.artifact.id, part.artifact)
            if (part.kind === 'video' && part.thumbnail) artifacts.set(part.thumbnail.id, part.thumbnail)
          }
          for (const artifact of artifacts.values()) {
            await ensure()
            const staging = Promise.resolve().then(() => {
              if (!isCurrent()) throw Error('QQ媒体转发已取消')
              // This delivery's watcher already aborts the shared signal on revocation.
              return bridge.stage(artifact, { signal, isCurrent }, true)
            }).then(async lease => {
              if (!accepting || !isCurrent()) { await lease.release(); throw Error('QQ媒体转发已取消') }
              leases.push(lease)
              const url = new URL(lease.nativeUrl)
              if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.href !== lease.nativeUrl || lease.nativeUrl.length > 2048) throw Error('QQ媒体资源无效')
              urls.set(artifact.id, lease.nativeUrl)
            })
            await wait(staging)
            await ensure()
          }
          if (!isCurrent()) return failed('binding_changed')
          const items = plan.items.map(item => Object.freeze(item.parts.map(part => Object.freeze(part.kind === 'text'
            ? { type: 'text', data: Object.freeze({ text: part.text }) }
            : part.kind === 'image' ? { type: 'image', data: Object.freeze({ file: urls.get(part.artifact.id)! }) }
              : { type: 'video', data: Object.freeze({ file: urls.get(part.artifact.id)!, thumb: urls.get(part.thumbnail!.id)! }) }))))
          const group = address.kind === 'group'
          const nativeAction: NativeAction = mode === 'forward' ? group ? 'send_group_forward_msg' : 'send_private_forward_msg' : group ? 'send_group_msg' : 'send_private_msg'
          const params = Object.freeze({ [group ? 'group_id' : 'user_id']: address.id, ...(mode === 'forward'
            ? { messages: Object.freeze(items.map(content => Object.freeze({ type: 'node', data: Object.freeze({ name: 'Agent', uin: address.account.id, content }) }))) }
            : { message: Object.freeze(items.flat()) }) })
          const hasVideo = plan.items.some(item => item.parts.some(part => part.kind === 'video'))
          const result = await wait(Promise.resolve().then(async () => {
            await ensure()
            if (!isCurrent()) return failed('binding_changed')
            dispatched = true
            return withDeliveryGuard(isCurrent, () => sendApi(nativeAction, params, { isCurrent, signal, timeoutMs,
              reportFailure(code, details) { transport ??= { code, details } } }))
          }))
          if (!isCurrent()) return dispatched ? interrupted(transport) : failed('binding_changed')
          return receipt(result, address, mode, hasVideo, transport)
        } catch { return dispatched ? interrupted(transport) : failed(signal.aborted ? 'binding_changed' : 'media_relay_preparation_failed') }
        finally {
          accepting = false; cancel.abort()
          await Promise.allSettled(leases.map(lease => Promise.resolve().then(() => lease.release())))
        }
      }, signal)
    } catch { return interrupted() }
    finally { clearTimeout(timer); clearInterval(watcher); cancel.abort() }
  }
}
