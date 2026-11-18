import { types } from 'node:util'
import type { AgentBindingSnapshot, ConversationAddress, PlatformAccountRef } from '../contracts/agentBinding.js'
import type { AgentVideoCard, SendVideoCardAction } from '../contracts/agentVideoCard.js'
import type { DeliveryReceipt } from '../contracts/delivery.js'
import type { MessageActionOptions, MessageActionPort } from '../contracts/platformMessage.js'
import { validateAgentVideoCard } from '../modules/media/infrastructure/agentVideoCard.js'
import { withDeliveryGuard } from '../modules/messaging/infrastructure/deliveryScope.js'
import { conversationAddressKey, platformAccountKey } from '../modules/runtime/domain/agentBindings.js'
import { qqDeliveryRejection } from './qqDeliveryReceipt.js'
import { qqId } from './qqIdentity.js'

type Options = MessageActionOptions & { readonly signal?: AbortSignal }
export const QQ_VIDEO_CARD_SEND_TIMEOUT_MS = 30_000
const failed = (code: string): DeliveryReceipt => ({ state: 'failed', code })
const unknown = (): DeliveryReceipt => ({ state: 'unknown' })
function data(input: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw Error('Invalid video card data')
  const result: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || keys && !keys.includes(key)) throw Error('Invalid video card field')
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw Error('Invalid video card field')
    result[key] = descriptor.value
  }
  return result
}
function account(input: unknown): Readonly<PlatformAccountRef> {
  const row = data(input, ['platform', 'namespace', 'id'])
  if (row.platform !== 'qq' || row.namespace !== 'global' || typeof row.id !== 'string' || qqId(row.id) !== row.id) throw Error('Invalid video card account')
  return Object.freeze({ platform: 'qq', namespace: 'global', id: row.id })
}
function group(input: unknown): Readonly<ConversationAddress> {
  const row = data(input, ['account', 'kind', 'id'])
  if (row.kind !== 'group' || typeof row.id !== 'string' || qqId(row.id) !== row.id) throw Error('Invalid video card group')
  return Object.freeze({ account: account(row.account), kind: 'group', id: row.id })
}
function binding(input: unknown, targetKey: string, connectionId?: string): Readonly<AgentBindingSnapshot> {
  const row = data(input, ['source', 'id', 'revision', 'personaId', 'agentId', 'connectionId', 'target'])
  if (row.source !== 'configured' && row.source !== 'legacy') throw Error('Invalid video card binding')
  for (const field of ['id', 'revision', 'personaId', 'agentId', 'connectionId'] as const) {
    if (typeof row[field] !== 'string' || !row[field] || row[field].length > 512 || /[\u0000-\u001f\u007f]/u.test(row[field])) throw Error('Invalid video card binding')
  }
  const target = group(row.target)
  if (conversationAddressKey(target) !== targetKey || connectionId !== undefined && row.connectionId !== connectionId) throw Error('Invalid video card binding')
  return Object.freeze({ source: row.source, id: row.id as string, revision: row.revision as string, personaId: row.personaId as string,
    agentId: row.agentId as string, connectionId: row.connectionId as string, target })
}
function receipt(input: unknown, target: ConversationAddress): DeliveryReceipt {
  try {
    const row = data(input), rejection = qqDeliveryRejection(row)
    if (rejection) return rejection
    if (row.status !== 'ok' || row.retcode !== 0) return unknown()
    const detail = data(row.data), id = detail.message_id
    if (!(typeof id === 'number' && Number.isSafeInteger(id) && id !== 0 ||
        typeof id === 'string' && /^-?[1-9]\d{0,15}$/u.test(id) && Number.isSafeInteger(Number(id)))) return unknown()
    const canonical = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) || typeof value === 'string' ? String(value) : undefined
    for (const value of [row, detail]) if (value.user_id !== undefined ||
        value.self_id !== undefined && canonical(value.self_id) !== target.account.id || value.group_id !== undefined && canonical(value.group_id) !== target.id) return unknown()
    return { state: 'sent', messageId: String(id) }
  } catch { return unknown() }
}
function nativeCard(card: AgentVideoCard): string {
  return JSON.stringify({ app: 'com.bilibili.app', view: 'min', ver: '1.0.0.0', prompt: `[视频]${card.title}`,
    meta: { detail_1: { appid: '1109937557', title: '哔哩哔哩', desc: card.title, author: card.author,
      duration: card.durationSeconds, qqdocurl: card.pageUrl, url: card.pageUrl } }, config: { autosize: 1, forward: 1 } })
}

/** One fixed Bilibili JSON segment, with no thumbnail fetch or alternate send. */
export function createQqVideoCardDeliveryPort(options: {
  readonly account: PlatformAccountRef
  readonly connectionId?: string
  sendApi(action: 'send_group_msg', params: Record<string, unknown>, options: { readonly isCurrent: () => boolean; readonly signal: AbortSignal }): Promise<unknown>
}): NonNullable<MessageActionPort['sendVideoCard']> {
  const accountKey = platformAccountKey(account(options.account))
  return async (input: SendVideoCardAction, guard: Options = {}): Promise<DeliveryReceipt> => {
    let target: Readonly<ConversationAddress>, targetKey: string, bindingKey: string, card: AgentVideoCard, check: (() => boolean) | undefined, parent: AbortSignal | undefined, ensureCurrent: (() => Promise<void>) | undefined
    try {
      const row = data(input, ['version', 'kind', 'target', 'binding', 'card']), scope = data(guard, ['isCurrent', 'signal', 'ensureCurrent'])
      if (scope.isCurrent !== undefined && (typeof scope.isCurrent !== 'function' || types.isProxy(scope.isCurrent)) ||
          scope.signal !== undefined && (types.isProxy(scope.signal) || !(scope.signal instanceof AbortSignal)) ||
          scope.ensureCurrent !== undefined && (typeof scope.ensureCurrent !== 'function' || types.isProxy(scope.ensureCurrent))) throw Error('Invalid video card guard')
      check = scope.isCurrent as (() => boolean) | undefined; parent = scope.signal as AbortSignal | undefined
      ensureCurrent = scope.ensureCurrent as (() => Promise<void>) | undefined
      if (row.version !== 1 || row.kind !== 'video-card.send') throw Error('Invalid video card action')
      target = group(row.target); targetKey = conversationAddressKey(target)
      if (platformAccountKey(target.account) !== accountKey) return failed('invalid_video_card_target')
      bindingKey = JSON.stringify(binding(row.binding, targetKey, options.connectionId))
      card = validateAgentVideoCard(row.card)
      if (card.provider !== 'bilibili' || !(/^BV[0-9A-Za-z]{10}$/u.test(card.id) && card.pageUrl === `https://www.bilibili.com/video/${card.id}` ||
          /^ep[1-9]\d{0,19}$/u.test(card.id) && card.pageUrl === `https://www.bilibili.com/bangumi/play/${card.id}`)) return failed('invalid_video_card_provider')
    } catch { return failed('invalid_video_card') }
    const cancel = new AbortController(), signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(QQ_VIDEO_CARD_SEND_TIMEOUT_MS), ...(parent ? [parent] : [])])
    const isCurrent = () => {
      try {
        const row = data(input, ['version', 'kind', 'target', 'binding', 'card'])
        return !signal.aborted && (!check || check() === true) && platformAccountKey(account(options.account)) === accountKey &&
          row.version === 1 && row.kind === 'video-card.send' && conversationAddressKey(group(row.target)) === targetKey &&
          JSON.stringify(binding(row.binding, targetKey, options.connectionId)) === bindingKey
      } catch { return false }
    }
    if (!isCurrent()) return failed('binding_changed')
    const params = Object.freeze({ group_id: target.id, message: Object.freeze([Object.freeze({ type: 'json', data: Object.freeze({ data: nativeCard(card) }) })]) })
    const timer = setInterval(() => { if (!isCurrent()) cancel.abort() }, 25)
    let abort: (() => void) | undefined, dispatched = false
    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        abort = () => reject(Error('QQ video card send outcome unknown'))
        signal.addEventListener('abort', abort, { once: true })
        Promise.resolve().then(async () => {
          if (!isCurrent()) throw Error('QQ video card source unavailable')
          await ensureCurrent?.()
          if (!isCurrent()) throw Error('QQ video card source unavailable')
          dispatched = true
          return withDeliveryGuard(isCurrent, () => options.sendApi('send_group_msg', params, { isCurrent, signal }))
        }).then(resolve, reject)
      })
      return isCurrent() ? receipt(result, target) : unknown()
    } catch { return dispatched ? unknown() : failed('source_unavailable') }
    finally { if (abort) signal.removeEventListener('abort', abort); clearInterval(timer); cancel.abort() }
  }
}
