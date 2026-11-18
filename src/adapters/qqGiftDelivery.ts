import { randomInt } from 'node:crypto'
import { types } from 'node:util'
import type { PlatformAccountRef } from '../contracts/agentBinding.js'
import { AGENT_GIFT_CATALOG, type AgentGiftAction, type AgentGiftDeliveryPort, type AgentGiftGuard, type AgentGiftReceipt } from '../contracts/agentQqGift.js'
import { giftData, giftInvalid, giftToken, giftUser, validateAgentGiftAction } from '../modules/tools/infrastructure/agentGiftValidation.js'
import { platformAccountKey } from '../modules/runtime/domain/agentBindings.js'
import { withDeliveryGuard } from '../modules/messaging/infrastructure/deliveryScope.js'

export type QqGiftApiAction = 'get_msg' | 'get_group_member_info' | 'send_packet'
export interface QqGiftApiOptions extends AgentGiftGuard { readonly timeoutMs: number }
export interface QqGiftDeliveryOptions {
  readonly account: PlatformAccountRef
  readonly connectionId: string
  /** Only set after explicitly verifying this connection supports the NapCat extension. */
  readonly supportsGiftPacket?: boolean
  isReady(): boolean
  /** Captured authenticated socket; do not switch to a reconnected socket or retry. */
  callApi(action: QqGiftApiAction, params: Readonly<Record<string, unknown>>, guard: QqGiftApiOptions): Promise<unknown>
}
const timeoutMs = 30_000
const failed = (code: string): AgentGiftReceipt => Object.freeze({ state: 'failed', code })
const uncertain = (): AgentGiftReceipt => Object.freeze({ state: 'unknown' })
function nativeId(value: unknown): string {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) throw giftInvalid()
  const text = String(value)
  if (!/^[1-9][0-9]{0,15}$/u.test(text) || !Number.isSafeInteger(Number(text))) throw giftInvalid()
  return text
}
function messageId(value: string): boolean { return /^-?[1-9][0-9]{0,9}$/u.test(value) && Number(value) >= -2147483648 && Number(value) <= 2147483647 }
function nativeMessageId(value: unknown): string {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) throw giftInvalid()
  const text = String(value)
  if (!messageId(text)) throw giftInvalid()
  return text
}
function qqAccount(value: unknown): Readonly<PlatformAccountRef> {
  const user = giftUser(value)
  if (user.platform !== 'qq' || user.namespace !== 'global' || nativeId(user.id) !== user.id) throw giftInvalid()
  return user
}
function action(value: unknown, accountKey: string, connectionId: string): Readonly<AgentGiftAction> {
  const result = validateAgentGiftAction(value), { binding } = result
  if (platformAccountKey(qqAccount(binding.target.account)) !== accountKey || binding.connectionId !== connectionId || nativeId(binding.target.id) !== binding.target.id ||
      nativeId(result.plan.recipient.id) !== result.plan.recipient.id || nativeId(result.source.author.id) !== result.source.author.id || !messageId(result.source.messageId)) throw giftInvalid()
  return result
}
function scope(row: Record<string, unknown>, selected: AgentGiftAction, userId?: string): boolean {
  try {
    return (row.self_id === undefined || nativeId(row.self_id) === selected.binding.target.account.id) &&
      (row.group_id === undefined || nativeId(row.group_id) === selected.binding.target.id) &&
      (row.user_id === undefined || !!userId && nativeId(row.user_id) === userId)
  } catch { return false }
}
function envelope(value: unknown, selected: AgentGiftAction, userId: string): Record<string, unknown> {
  const row = giftData(value), detail = giftData(row.data)
  if (row.status !== 'ok' || row.retcode !== 0 || !scope(row, selected, userId) || !scope(detail, selected, userId) ||
      nativeId(detail.group_id) !== selected.binding.target.id || nativeId(detail.user_id) !== userId) throw giftInvalid()
  return detail
}
function displayName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || [...value].length > 60 || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value)) throw giftInvalid()
  return value.trim()
}
function member(value: unknown, selected: AgentGiftAction, id: string): string {
  const detail = envelope(value, selected, id)
  return displayName(typeof detail.card === 'string' && detail.card.trim() ? detail.card : detail.nickname)
}

type Pb = { [key: number]: number | string | Pb }
function encode(object: Pb): number[] {
  const bytes: number[] = []
  const varint = (value: number) => { let n = BigInt(value); while (n > 127n) { bytes.push(Number(n & 127n) | 128); n >>= 7n } bytes.push(Number(n)) }
  for (const [key, value] of Object.entries(object)) {
    const tag = Number(key)
    if (typeof value === 'number') { varint(tag * 8); varint(value) }
    else {
      const body = typeof value === 'string' ? [...new TextEncoder().encode(value)] : encode(value)
      varint(tag * 8 + 2); varint(body.length); bytes.push(...body)
    }
  }
  return bytes
}
/** Internal packet construction only: identities and names have already come from fresh QQ evidence. */
function packet(selected: AgentGiftAction, recipientName: string, botName: string): string {
  const gift = AGENT_GIFT_CATALOG[selected.plan.giftType]
  const body: Pb = {
    1: { 2: { 1: Number(selected.binding.target.id) } }, 2: { 1: 1, 2: 0, 3: 0 },
    3: { 1: { 2: { 53: { 1: 41, 2: {
      1: 0, 2: gift.name, 3: Number(selected.plan.recipient.id), 4: recipientName,
      5: Number(selected.binding.target.account.id), 6: botName, 7: gift.displayValue,
      8: {}, 10: gift.tianquanId, 11: 5, 12: '30', 13: { 1: { 2: gift.coinValue }, 2: 9, 4: gift.displayValue },
    } } } } }, 4: randomInt(0x1_0000_0000), 5: randomInt(0x1_0000_0000),
  }
  return Buffer.from(encode(body)).toString('hex')
}
function receipt(value: unknown, selected: AgentGiftAction): AgentGiftReceipt {
  try {
    const row = giftData(value)
    if (row.state === 'failed' && Object.keys(row).every(key => key === 'state' || key === 'code')) return failed('native_rejected')
    if (row.state !== undefined || row.status !== 'ok' || row.retcode !== 0 || !scope(row, selected) || row.message_id !== undefined || row.cmd !== undefined && row.cmd !== 'MessageSvc.PbSendMsg') return uncertain()
    if (row.data !== undefined && row.data !== null) {
      const detail = giftData(row.data)
      if (!scope(detail, selected) || detail.message_id !== undefined || detail.cmd !== undefined && detail.cmd !== 'MessageSvc.PbSendMsg') return uncertain()
    }
    return Object.freeze({ state: 'confirmed', evidence: 'packet-accepted' })
  } catch { return uncertain() }
}

/** Unsupported implementations expose no port; native packet acceptance is not proof of QQ client rendering. */
export function createQqGiftDeliveryPort(options: QqGiftDeliveryOptions): AgentGiftDeliveryPort | undefined {
  const configured = giftData(options, ['account', 'connectionId', 'supportsGiftPacket', 'isReady', 'callApi'])
  if (configured.supportsGiftPacket !== true) return undefined
  const configuredAccount = options.account, account = qqAccount(configured.account), accountKey = platformAccountKey(account), connectionId = giftToken(configured.connectionId)
  if ([configured.isReady, configured.callApi].some(value => typeof value !== 'function' || types.isProxy(value))) throw giftInvalid()
  const ready = configured.isReady as () => boolean, callApi = configured.callApi as QqGiftDeliveryOptions['callApi']
  return async (input, guard) => {
    let selected: Readonly<AgentGiftAction>, snapshot: string
    try {
      selected = action(input, accountKey, connectionId); snapshot = JSON.stringify(selected)
      if (types.isProxy(guard.signal) || !(guard.signal instanceof AbortSignal) || [guard.isCurrent, guard.ensureCurrent].some(value => typeof value !== 'function' || types.isProxy(value))) throw giftInvalid()
    } catch { return failed('invalid_gift') }
    const cancel = new AbortController(), signal = AbortSignal.any([cancel.signal, guard.signal]), deadline = Date.now() + timeoutMs
    const current = () => {
      try { return !signal.aborted && ready() === true && guard.isCurrent() === true && platformAccountKey(qqAccount(configuredAccount)) === accountKey && JSON.stringify(action(input, accountKey, connectionId)) === snapshot }
      catch { return false }
    }
    const timer = setTimeout(() => cancel.abort(), timeoutMs), watcher = setInterval(() => { if (!current()) cancel.abort() }, 25)
    const ensure = async () => { if (!current()) throw giftInvalid(); await guard.ensureCurrent(); if (!current()) throw giftInvalid() }
    let dispatched = false, abort: (() => void) | undefined
    const invoke = async (name: QqGiftApiAction, params: Readonly<Record<string, unknown>>): Promise<unknown> => {
      await ensure()
      if (!current()) throw giftInvalid()
      return withDeliveryGuard(current, () => {
        if (name === 'send_packet') dispatched = true
        return callApi(name, Object.freeze(params), Object.freeze({ signal, isCurrent: current, ensureCurrent: ensure, timeoutMs: Math.max(1, deadline - Date.now()) }))
      })
    }
    try {
      const response = await new Promise<unknown>((resolve, reject) => {
        abort = () => reject(giftInvalid()); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
        Promise.resolve().then(async () => {
          const source = envelope(await invoke('get_msg', { message_id: Number(selected.source.messageId) }), selected, selected.source.author.id)
          if (nativeMessageId(source.message_id) !== selected.source.messageId || source.message_type !== undefined && source.message_type !== 'group') throw giftInvalid()
          const recipientName = member(await invoke('get_group_member_info', { group_id: selected.binding.target.id, user_id: selected.plan.recipient.id, no_cache: true }), selected, selected.plan.recipient.id)
          const botName = member(await invoke('get_group_member_info', { group_id: selected.binding.target.id, user_id: selected.binding.target.account.id, no_cache: true }), selected, selected.binding.target.account.id)
          return invoke('send_packet', { cmd: 'MessageSvc.PbSendMsg', data: packet(selected, recipientName, botName) })
        }).then(resolve, reject)
      })
      return current() ? receipt(response, selected) : uncertain()
    } catch { return dispatched ? uncertain() : failed('source_unavailable') }
    finally { if (abort) signal.removeEventListener('abort', abort); clearTimeout(timer); clearInterval(watcher); cancel.abort() }
  }
}
