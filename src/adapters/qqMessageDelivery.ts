import { isAgentBindingCurrent, type AgentBindingGuard, type ConversationAddress } from '../contracts/agentBinding.js'
import type { DeliveryReceipt } from '../contracts/delivery.js'
import type { MessageActionPort } from '../contracts/platformMessage.js'
import { normalizeQqDeliveryReceipt } from './qqDeliveryReceipt.js'
import { withDeliveryGuard } from '../modules/messaging/infrastructure/deliveryScope.js'
import { validateMessageBundle } from '../modules/messaging/infrastructure/messageBundle.js'
import { conversationAddressKey } from '../modules/runtime/domain/agentBindings.js'
import { findQqAccount, qqId, resolveQqConversationAddress } from './qqIdentity.js'
import { encodeQqLegacyParts, opaqueMessageId } from './qqMessage.js'

type LegacyReply = (payload: unknown, quote?: unknown) => Promise<unknown>
type PreparedSend = () => unknown
type QqSendAction = 'send_group_msg' | 'send_private_msg' | 'send_group_forward_msg' | 'send_private_forward_msg'

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function rejected(code: string): DeliveryReceipt {
  return { state: 'failed', code }
}

function isQqTarget(target: ConversationAddress): boolean {
  return Boolean(target && target.account) && target.account.platform === 'qq' && target.account.namespace === 'global' &&
    qqId(target.account.id) === target.account.id && qqId(target.id) === target.id &&
    (target.kind === 'group' || target.kind === 'private')
}

export function createQqMessageActionPort(options: {
  getBotRoot?: () => unknown
  sendApi?: (action: QqSendAction, params: Record<string, unknown>) => Promise<unknown>
  /** Event-scoped native reply, only for this exact account and conversation. */
  reply?: { target: ConversationAddress; messageId?: string; send: LegacyReply }
  resolveExtension?: (ref: string) => unknown
}): MessageActionPort {
  return {
    async send(action, guard) {
      if (action.version !== 1 || action.kind !== 'message.send' || !isQqTarget(action.target)) return rejected('invalid_target')
      const target = conversationAddressKey(action.target)
      if (action.binding && conversationAddressKey(action.binding.target) !== target) return rejected('binding_target_mismatch')
      if (options.reply && conversationAddressKey(options.reply.target) !== target) return rejected('invalid_target')
      if (!action.parts.length) return rejected('empty_message')
      const quote = action.replyTo
      if (quote !== undefined && opaqueMessageId(quote) !== quote) return rejected('invalid_quote')

      let send: PreparedSend
      try {
        const useNativeQuote = Boolean(quote && options.reply?.messageId === quote)
        const segments: unknown[] = quote && !useNativeQuote ? [{type:'reply', data:{id:quote}}] : []
        for (const part of action.parts) {
          if (part.kind === 'text') {
            segments.push({type:'text', data:{text:part.text}})
          } else if (part.kind === 'mention') {
            const user = part.user
            const id = user === 'everyone' ? 'all' : user.platform === 'qq' && user.namespace === 'global' ? qqId(user.id) : null
            if (!id) return rejected('invalid_mention')
            segments.push({type:'at', data:{qq:id}})
          } else if (part.kind === 'extension') {
            if (part.platform !== 'qq') return rejected('unsupported_part')
            const native = options.resolveExtension?.(part.ref)
            if (native === undefined) return rejected('unsupported_part')
            segments.push(native)
          } else {
            const type = part.kind === 'audio' ? 'record' : part.kind
            segments.push({type, data:{file:part.resource.value, ...(part.name ? {name:part.name} : {})}})
          }
        }
        if (options.reply) {
          const native = options.reply
          const first = action.parts[0]
          const payload = !quote || useNativeQuote
            ? action.parts.length === 1 && first?.kind === 'text' ? first.text : segments.length === 1 ? segments[0] : segments
            : segments
          send = () => native.send(payload, useNativeQuote)
        } else if (options.sendApi) {
          const group = action.target.kind === 'group'
          const numericId = Number(action.target.id)
          const id = Number.isSafeInteger(numericId) ? numericId : action.target.id
          send = () => options.sendApi!(group ? 'send_group_msg' : 'send_private_msg', { [group ? 'group_id' : 'user_id']: id, message: segments })
        } else {
          const account = findQqAccount(options.getBotRoot?.(), action.target.account.id)
          const client = object(account)
          const pick = action.target.kind === 'group' ? client.pickGroup : client.pickFriend
          if (typeof pick !== 'function') return rejected('account_unavailable')
          const numericId = Number(action.target.id)
          const recipient = Reflect.apply(pick, account, [Number.isSafeInteger(numericId) ? numericId : action.target.id])
          const sendMsg = object(recipient).sendMsg
          if (typeof sendMsg !== 'function') return rejected('conversation_unavailable')
          send = () => Reflect.apply(sendMsg, recipient, [segments])
        }
        if (guard?.isCurrent?.() === false) return rejected('binding_changed')
      } catch {
        return rejected('preparation_failed')
      }
      try {
        if (guard?.ensureCurrent) await guard.ensureCurrent()
        if (guard?.isCurrent?.() === false) return rejected('binding_changed')
      } catch {
        return rejected('binding_changed')
      }
      try {
        return normalizeQqDeliveryReceipt(await withDeliveryGuard(guard?.isCurrent, send))
      } catch {
        return { state: 'unknown' }
      }
    },
    async sendBundle(action, guard) {
      if (action.version !== 1 || action.kind !== 'message.bundle.send' || !isQqTarget(action.target)) return rejected('invalid_target')
      const target = conversationAddressKey(action.target)
      if (action.binding && conversationAddressKey(action.binding.target) !== target) return rejected('binding_target_mismatch')
      if (options.reply && conversationAddressKey(options.reply.target) !== target) return rejected('invalid_target')

      let send: PreparedSend
      try {
        const items = validateMessageBundle(action.items)
        const group = action.target.kind === 'group'
        const numericId = Number(action.target.id)
        const id = Number.isSafeInteger(numericId) ? numericId : action.target.id
        const apiAction = group ? 'send_group_forward_msg' : 'send_private_forward_msg'
        const params = {
          [group ? 'group_id' : 'user_id']: id,
          messages: items.map(item => ({
            type: 'node',
            data: {
              name: 'Agent',
              uin: action.target.account.id,
              content: item.parts.map(part => part.kind === 'text'
                ? { type: 'text', data: { text: part.text } }
                : { type: 'image', data: { file: `base64://${part.base64}` } }),
            },
          })),
        }
        if (options.sendApi) send = () => options.sendApi!(apiAction, params)
        else {
          const account = findQqAccount(options.getBotRoot?.(), action.target.account.id)
          if (!account) return rejected('account_unavailable')
          const sendApi = object(account).sendApi
          if (typeof sendApi !== 'function') return rejected('bundle_unsupported')
          send = () => Reflect.apply(sendApi, account, [apiAction, params])
        }
        if (guard?.isCurrent?.() === false) return rejected('binding_changed')
      } catch {
        return rejected('invalid_bundle')
      }
      try {
        if (guard?.ensureCurrent) await guard.ensureCurrent()
        if (guard?.isCurrent?.() === false) return rejected('binding_changed')
      } catch {
        return rejected('binding_changed')
      }
      try {
        return normalizeQqDeliveryReceipt(await withDeliveryGuard(guard?.isCurrent, send))
      } catch {
        return { state: 'unknown' }
      }
    },
  }
}

/** Translate a legacy host reply. Unmapped native objects are scoped to this invocation. */
export function bindQqHostReply(event: object & AgentBindingGuard, reply: LegacyReply): LegacyReply {
  const target = resolveQqConversationAddress(event)
  if (!target) return reply
  const targetKey = conversationAddressKey(target)
  const messageId = opaqueMessageId(object(event).message_id)
  let uncertain = false
  let pending = Promise.resolve()
  const isCurrent = () => {
    const live = resolveQqConversationAddress(event)
    return live !== null && conversationAddressKey(live) === targetKey && isAgentBindingCurrent(event)
  }

  const send = async (payload: unknown, quote?: unknown) => {
    if (!isCurrent()) return {status:'failed', message:'角色绑定已改变，未发送'}
    if (uncertain) return {state:'unknown'}
    const {parts, resolveExtension} = encodeQqLegacyParts(payload)
    // Keep the exact host payload shape for mixed arrays, buffers and native segments.
    let raw: unknown
    let transportError: {error: unknown} | undefined
    const native = createQqMessageActionPort({
      reply: {
        target,
        ...(messageId ? {messageId} : {}),
        send: async () => {
          try {
            raw = await reply(payload, quote)
            return raw
          } catch (error) {
            transportError = {error}
            throw error
          }
        },
      },
      resolveExtension,
    })
    const outcome = await native.send({
      version:1, kind:'message.send', target, parts,
      ...(quote === true && messageId ? {replyTo:messageId} : {}),
    }, {isCurrent})
    if (outcome.state === 'unknown') {
      uncertain = true
      if (transportError) throw transportError.error
    }
    if (outcome.state === 'sent') return raw
    if (outcome.state === 'failed' && outcome.code === 'binding_changed') {
      return {status:'failed', message:'角色绑定已改变，未发送'}
    }
    return outcome.state === 'failed' && raw !== undefined ? raw : outcome
  }
  return (payload, quote) => {
    const result = pending.then(() => send(payload, quote))
    pending = result.then(() => {}, () => {})
    return result
  }
}
