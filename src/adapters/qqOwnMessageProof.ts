import { types } from 'node:util'
import type { ConversationAddress } from '../contracts/agentBinding.js'
import type { OwnMessageSnapshot } from '../contracts/platformConnection.js'
import { qqId } from './qqIdentity.js'

function row(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw Error('Invalid QQ ownership evidence')
  const result: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(input)) {
    const field = Object.getOwnPropertyDescriptor(input, key)
    if (typeof key !== 'string' || !field || !Object.hasOwn(field, 'value')) throw Error('Invalid QQ ownership evidence')
    result[key] = field.value
  }
  return result
}
function id(input: unknown): string | undefined {
  return typeof input === 'number' && Number.isSafeInteger(input) || typeof input === 'string'
    ? qqId(input) === String(input) ? String(input) : undefined : undefined
}
export function isQqOwnMessageId(input: unknown): input is string {
  return typeof input === 'string' && /^-?[1-9]\d{0,9}$/u.test(input) && Number(input) >= -2_147_483_648 && Number(input) <= 2_147_483_647
}
export function captureQqOwnMessageTarget(input: unknown): Readonly<ConversationAddress> | undefined {
  try {
    const target = row(input), account = row(target.account)
    if (Object.keys(target).some(key => !['account', 'kind', 'id'].includes(key)) ||
        Object.keys(account).some(key => !['platform', 'namespace', 'id'].includes(key)) ||
        account.platform !== 'qq' || account.namespace !== 'global' || typeof account.id !== 'string' || id(account.id) !== account.id ||
        typeof target.id !== 'string' || id(target.id) !== target.id || target.kind !== 'group' && target.kind !== 'private' ||
        target.kind === 'private' && target.id === account.id) return undefined
    return Object.freeze({ account: Object.freeze({ platform: 'qq', namespace: 'global', id: account.id }), kind: target.kind, id: target.id })
  } catch { return undefined }
}
/** Fresh friendship is required on the same authenticated socket as the effect. */
export function proveQqFriend(input: unknown, target: ConversationAddress): boolean {
  try {
    const response = row(input), values = response.data
    if (target.kind !== 'private' || response.status !== 'ok' || response.retcode !== 0 || !Array.isArray(values) || types.isProxy(values) ||
        Object.getPrototypeOf(values) !== Array.prototype || values.length > 10_000 || Reflect.ownKeys(values).length !== values.length + 1 ||
        response.complete === false || response.truncated === true || response.has_more === true ||
        response.self_id !== undefined && id(response.self_id) !== target.account.id) return false
    const seen = new Set<string>()
    for (let index = 0; index < values.length; index++) {
      const field = Object.getOwnPropertyDescriptor(values, String(index))
      if (!field || !Object.hasOwn(field, 'value')) return false
      const friend = row(field.value), peer = id(friend.user_id)
      if (!peer || seen.has(peer) || friend.self_id !== undefined && id(friend.self_id) !== target.account.id) return false
      seen.add(peer)
    }
    return seen.has(target.id)
  } catch { return false }
}
/** Inspect only native ownership metadata. Never decode, return or persist message content. */
export function proveQqOwnMessage(input: unknown, target: ConversationAddress, messageId: string): Readonly<OwnMessageSnapshot> | undefined {
  try {
    const captured = captureQqOwnMessageTarget(target)
    if (!captured || !isQqOwnMessageId(messageId)) return undefined
    const response = row(input), message = row(response.data), sender = row(message.sender)
    const nativeMessageId = typeof message.message_id === 'number' && Number.isSafeInteger(message.message_id) || typeof message.message_id === 'string' ? String(message.message_id) : undefined
    if (response.status !== 'ok' || response.retcode !== 0 || nativeMessageId !== messageId ||
        id(sender.user_id) !== captured.account.id || id(message.user_id) !== captured.account.id ||
        response.user_id !== undefined && id(response.user_id) !== captured.account.id ||
        response.self_id !== undefined && id(response.self_id) !== captured.account.id || message.self_id !== undefined && id(message.self_id) !== captured.account.id ||
        typeof message.time !== 'number' || !Number.isSafeInteger(message.time) || message.time <= 0 ||
        !Number.isSafeInteger(message.time * 1000) || message.time * 1000 > Date.now() + 60_000) return undefined
    if (captured.kind === 'group') {
      if (message.message_type !== 'group' || id(message.group_id) !== captured.id ||
          message.post_type !== undefined && message.post_type !== 'message' && message.post_type !== 'message_sent' ||
          sender.group_id !== undefined && id(sender.group_id) !== captured.id ||
          response.group_id !== undefined && id(response.group_id) !== captured.id) return undefined
    } else if (message.message_type !== 'private' || id(message.target_id) !== captured.id ||
        message.sub_type !== undefined && message.sub_type !== 'friend' || message.group_id != null || sender.group_id != null ||
        message.temp_source != null || message.isGroup === true || response.group_id != null ||
        message.post_type !== undefined && message.post_type !== 'message' && message.post_type !== 'message_sent' ||
        message.message_sent_type !== undefined && message.message_sent_type !== 'self' ||
        message.post_type !== 'message_sent' && message.message_sent_type !== 'self' ||
        response.target_id !== undefined && id(response.target_id) !== captured.id) return undefined
    return Object.freeze({ conversation: captured, messageId, author: captured.account, occurredAt: message.time * 1000 })
  } catch { return undefined }
}
