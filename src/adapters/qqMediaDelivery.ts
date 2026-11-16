import type { ConversationAddress, PlatformAccountRef } from '../contracts/agentBinding.js'
import type { SendMediaAction } from '../contracts/agentMedia.js'
import type { DeliveryReceipt } from '../contracts/delivery.js'
import type { MessageActionOptions, MessageActionPort } from '../contracts/platformMessage.js'
import { validateAgentMedia } from '../modules/media/infrastructure/agentMediaBytes.js'
import { conversationAddressKey, platformAccountKey } from '../modules/runtime/domain/agentBindings.js'
import { withDeliveryGuard } from '../modules/messaging/infrastructure/deliveryScope.js'
import { qqId } from './qqIdentity.js'
import { qqDeliveryRejection } from './qqDeliveryReceipt.js'

type MediaSendApi = 'send_group_msg' | 'send_private_msg'
type MediaSendOptions = MessageActionOptions & { readonly signal?: AbortSignal }
// 30 MiB takes about 130s at NapCat's default 256 KiB/s timeout calculation.
export const QQ_MEDIA_SEND_TIMEOUT_MS = 180_000

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function plainData(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))
}
function targetValid(target: ConversationAddress): boolean {
  return plainData(target, ['account', 'kind', 'id']) && plainData(target.account, ['platform', 'namespace', 'id']) &&
    target.account.platform === 'qq' && target.account.namespace === 'global' && qqId(target.account.id) === target.account.id &&
    qqId(target.id) === target.id && (target.kind === 'group' || target.kind === 'private')
}
function failed(code: string): DeliveryReceipt { return { state: 'failed', code } }
function messageId(value: unknown): value is string | number {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value !== 0
  return typeof value === 'string' && value !== '0' && value.length > 0 && value.length <= 128 && value.trim() === value && !/[\u0000-\u0020\u007f]/u.test(value)
}
function responseReceipt(value: unknown, target: ConversationAddress): DeliveryReceipt {
  const response = record(value), data = record(response.data), rejection = qqDeliveryRejection(value)
  if (rejection) return rejection
  if (response.status !== 'ok' || response.retcode !== 0 || !messageId(data.message_id)) return { state: 'unknown' }
  for (const row of [response, data]) {
    if (row.self_id !== undefined && String(row.self_id) !== target.account.id ||
        row.group_id !== undefined && (target.kind !== 'group' || String(row.group_id) !== target.id) ||
        row.user_id !== undefined && (target.kind !== 'private' || String(row.user_id) !== target.id)) return { state: 'unknown' }
  }
  return { state: 'sent', messageId: String(data.message_id) }
}

/** Single native playable media segment from owned bytes; no URL, local path or fallback send. */
export function createQqMediaDeliveryPort(options: {
  readonly account: PlatformAccountRef
  readonly connectionId?: string
  sendApi(action: MediaSendApi, params: Record<string, unknown>, options: { readonly isCurrent: () => boolean; readonly signal: AbortSignal }): Promise<unknown>
}): NonNullable<MessageActionPort['sendMedia']> {
  const accountKey = platformAccountKey(options.account)
  return async (action: SendMediaAction, guard: MediaSendOptions = {}): Promise<DeliveryReceipt> => {
    let target: ConversationAddress, targetKey: string, bindingKey: string | undefined
    let media: ReturnType<typeof validateAgentMedia>
    const input = action, check = guard.isCurrent
    try {
      if (!plainData(action, ['version', 'kind', 'target', 'media', 'binding']) || action.version !== 1 || action.kind !== 'media.send' ||
          !targetValid(action.target) || platformAccountKey(action.target.account) !== accountKey) return failed('invalid_media_target')
      targetKey = conversationAddressKey(action.target)
      if (action.binding) {
        if (!plainData(action.binding, ['source', 'id', 'revision', 'personaId', 'agentId', 'connectionId', 'target']) ||
            !targetValid(action.binding.target) || conversationAddressKey(action.binding.target) !== targetKey ||
            options.connectionId !== undefined && action.binding.connectionId !== options.connectionId) return failed('binding_target_mismatch')
        bindingKey = JSON.stringify(action.binding)
      }
      media = validateAgentMedia(action.media)
      target = Object.freeze({ ...action.target, account: Object.freeze({ ...action.target.account }) })
    } catch { return failed('invalid_media_bytes') }
    const cancel = new AbortController()
    const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(QQ_MEDIA_SEND_TIMEOUT_MS), ...(guard.signal ? [guard.signal] : [])])
    const isCurrent = () => {
      try {
        return !signal.aborted && check?.() !== false && platformAccountKey(options.account) === accountKey &&
          conversationAddressKey(input.target) === targetKey && JSON.stringify(input.binding) === bindingKey
      } catch { return false }
    }
    if (!isCurrent()) return failed('binding_changed')
    const timer = setInterval(() => { if (!isCurrent()) cancel.abort() }, 25)
    let abort: (() => void) | undefined
    try {
      // Spoken text is host policy input; only the owned record/video bytes enter the native request.
      const segment = Object.freeze({ type: media.kind === 'audio' ? 'record' : 'video',
        data: Object.freeze({ file: `base64://${media.base64}` }),
      })
      const params = Object.freeze({ [target.kind === 'group' ? 'group_id' : 'user_id']: target.id, message: Object.freeze([segment]) })
      if (!isCurrent()) return failed('binding_changed')
      const result = await new Promise<unknown>((resolve, reject) => {
        abort = () => reject(new Error('QQ media send outcome unknown'))
        signal.addEventListener('abort', abort, { once: true })
        Promise.resolve().then(() => {
          if (!isCurrent()) throw new Error('QQ media send outcome unknown')
          return withDeliveryGuard(isCurrent, () => options.sendApi(target.kind === 'group' ? 'send_group_msg' : 'send_private_msg', params, { isCurrent, signal }))
        }).then(resolve, reject)
      })
      if (!isCurrent()) return { state: 'unknown' }
      return responseReceipt(result, target)
    } catch { return { state: 'unknown' } }
    finally {
      if (abort) signal.removeEventListener('abort', abort)
      clearInterval(timer)
      cancel.abort()
    }
  }
}
