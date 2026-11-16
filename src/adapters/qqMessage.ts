import type { AgentBindingSnapshot, ConversationAddress, PlatformUserRef } from '../contracts/agentBinding.js'
import type { PlatformConversationEvent, PlatformNudgeEvent } from '../contracts/platformConnection.js'
import type { IncomingMessage, MessagePart, MessageQuote, MessageResource, OutgoingPart } from '../contracts/platformMessage.js'
import { getReplyTargetUserId, extractForwardIdFromSegment } from '../modules/conversation/domain/messageSegments.js'
import { collectMentionTargetIds, getMentionTargetId } from '../modules/conversation/domain/mentionTargets.js'
import { conversationAddressKey, isPlatformIdentifier } from '../modules/runtime/domain/agentBindings.js'
import { qqId, resolveQqConversationAddress } from './qqIdentity.js'
import { qqFileName, qqFileResource } from './qqMessageFile.js'

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function opaqueMessageId(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value !== 0 ? String(value) : undefined
  if (typeof value !== 'string') return undefined
  const id = value.trim()
  return id && id !== '0' ? id : undefined
}

function qqUser(id: string): PlatformUserRef {
  return { platform: 'qq', namespace: 'global', id }
}

export function qqRecallKind(value: unknown): 'group' | 'private' | undefined {
  const event = object(value)
  const type = typeof event.notice_type === 'string' ? event.notice_type.trim() : ''
  const legacy = event.sub_type === 'recall'
  if (type === 'group_recall' || type === 'group.recall' || (type === 'group' && legacy)) return 'group'
  if (type === 'friend_recall' || type === 'friend.recall' || (type === 'friend' && legacy)) return 'private'
}

/** QQ's legacy plugin and raw OneBot encode the same recall with different notice fields. */
export function decodeQqRecall(value: unknown, fallbackAccount?: () => string | undefined): Extract<PlatformConversationEvent, { kind: 'recall' }> | null {
  const event = object(value)
  const kind = qqRecallKind(event)
  if (!kind || (event.post_type && event.post_type !== 'notice') || (event.message_type && event.message_type !== kind)) return null
  const rawSelf = event.self_id
  const rawBot = object(event.bot).uin
  const hasSelf = rawSelf != null && rawSelf !== ''
  const hasBot = rawBot != null && rawBot !== ''
  if ((hasSelf && qqId(rawSelf) === null) || (hasBot && qqId(rawBot) === null)) return null
  const fallback = !hasSelf && !hasBot ? fallbackAccount?.() : undefined
  const input = fallback ? Object.create(event, { self_id: { value: fallback } }) : event
  const target = resolveQqConversationAddress(input)
  const messageId = opaqueMessageId(event.message_id ?? event.messageId)
  return target?.kind === kind && isPlatformIdentifier(messageId) && isPlatformIdentifier(target.account.id) &&
    isPlatformIdentifier(target.id) ? { kind: 'recall', target, messageId } : null
}

export function decodeQqNudge(value: unknown, options: { now?: number; requireRecipient?: boolean } = {}): PlatformNudgeEvent | null {
  const event = object(value)
  if ((event.notice_type !== 'notify' && event.notice_type !== 'poke') || event.sub_type !== 'poke') return null
  const target = resolveQqConversationAddress(event)
  const senderId = qqId(event.user_id)
  if (target?.kind !== 'group' || !senderId || senderId === target.account.id) return null
  if ((options.requireRecipient || event.target_id != null) && qqId(event.target_id) !== target.account.id) return null
  const sender = object(event.sender)
  const name = sender.card || sender.nickname
  const seconds = Number(event.time)
  return {
    kind: 'nudge', target, sender: qqUser(senderId),
    ...(typeof name === 'string' && name ? { senderName: name.slice(0, 128) } : {}),
    occurredAt: Number.isSafeInteger(seconds * 1000) && seconds > 0 ? seconds * 1000 : options.now ?? Date.now(),
  }
}

function partText(parts: readonly MessagePart[]): string {
  return parts.flatMap(part => part.kind === 'text' ? [part.text] : []).join('')
}

/** Convert an already-authorized legacy payload without interpreting native objects as text. */
export function encodeQqLegacyParts(payload: unknown): { parts: OutgoingPart[]; resolveExtension(ref: string): unknown } {
  const originals: unknown[] = []
  const parts: OutgoingPart[] = []
  for (const value of Array.isArray(payload) ? payload : [payload]) {
    const item = object(value)
    const text = typeof value === 'string' ? value : item.type === 'text' ? item.text ?? object(item.data).text : undefined
    if (typeof text === 'string') {
      parts.push({kind:'text', text})
      continue
    }
    const target = item.type === 'at' ? getMentionTargetId(item) : undefined
    const id = qqId(target)
    if (id || target === 'all') {
      parts.push({kind:'mention', user:id ? qqUser(id) : 'everyone'})
      continue
    }
    const ref = String(originals.push(value) - 1)
    parts.push({kind:'extension', platform:'qq', type:String(item.type || 'native'), ref})
  }
  return {parts, resolveExtension:ref => originals[Number(ref)]}
}

function resourceOf(value: unknown): MessageResource | undefined {
  if (typeof value !== 'string' || !value) return undefined
  return { kind: /^https?:\/\//i.test(value) ? 'url' : 'reference', value }
}

function decodeParts(value: unknown): MessagePart[] {
  if (!Array.isArray(value)) return typeof value === 'string' && value ? [{kind:'text', text:value}] : []
  const parts: MessagePart[] = []
  for (const segment of value) {
    if (typeof segment === 'string') {
      parts.push({ kind: 'text', text: segment })
      continue
    }
    const item = object(segment)
    const data = object(item.data)
    const type = typeof item.type === 'string' ? item.type : 'unknown'
    if (type === 'reply') continue
    if (type === 'text') {
      const text = item.text ?? data.text
      if (typeof text === 'string') parts.push({ kind: 'text', text })
      continue
    }
    if (type === 'at') {
      const target = getMentionTargetId(item)
      const id = qqId(target)
      if (id || target === 'all') {
        parts.push({ kind: 'mention', user: id ? qqUser(id) : 'everyone' })
        continue
      }
    }
    if (type === 'image' || type === 'mface' || type === 'record' || type === 'audio' || type === 'video' || type === 'file') {
      const resource = type === 'file' ? qqFileResource(item, data) :
        resourceOf(item.url ?? data.url) ?? resourceOf(item.file ?? data.file ?? item.file_id ?? data.file_id)
      const name = type === 'file' ? qqFileName(item.name ?? data.name ?? item.file_name ?? data.file_name ?? item.file ?? data.file) : item.name ?? data.name
      const kind = type === 'mface' ? 'image' : type === 'record' ? 'audio' : type
      parts.push({ kind, ...(resource ? {resource} : {}), ...(typeof name === 'string' ? {name} : {}) })
      continue
    }
    if (type === 'forward' || type === 'json') {
      const id = opaqueMessageId(extractForwardIdFromSegment(item))
      if (id) {
        parts.push({ kind: 'forward', id })
        continue
      }
    }
    parts.push({ kind: 'extension', platform: 'qq', type })
  }
  return parts
}

function decodeQuote(event: Record<string, unknown>, message: unknown[], rawText: string): MessageQuote | undefined {
  const source = object(event.source)
  const reply = object(message.find(segment => object(segment).type === 'reply'))
  const data = object(reply.data)
  const cq = rawText.match(/\[CQ:reply,([^\]]*)\](?:\s*\[CQ:at,[^\]]*(?:qq|user_id|id|uin)=(\d+)[^\]]*\])?/)
  const cqId = cq?.[1]?.match(/(?:^|,)id=([^,]+)/)?.[1]
  const messageId = opaqueMessageId(event.reply_id ?? reply.id ?? data.id ?? source.message_id ?? cqId)
  const authorId = qqId(getReplyTargetUserId(source)) ?? qqId(getReplyTargetUserId(reply)) ?? qqId(cq?.[2])
  const sender = object(source.sender)
  const authorName = source.card || sender.card || source.nickname || sender.nickname
  const parts = decodeParts(source.message)
  const text = (typeof source.text === 'string' ? source.text : '') || partText(parts)
  if (!messageId && !authorId && !text && !parts.length) return undefined
  return {
    parts,
    ...(messageId ? {messageId} : {}),
    ...(authorId ? {author:qqUser(authorId)} : {}),
    ...(typeof authorName === 'string' && authorName ? {authorName} : {}),
    ...(text ? {text} : {}),
  }
}

export function decodeQqIncomingMessage(value: unknown, options: {
  binding?: AgentBindingSnapshot
  now?: number
} = {}): IncomingMessage | null {
  const event = object(value)
  const sender = object(event.sender)
  const address: ConversationAddress | null = resolveQqConversationAddress(event)
  const senderId = qqId(event.user_id)
  if (!address || !senderId) return null
  const {binding} = options
  if (binding && conversationAddressKey(binding.target) !== conversationAddressKey(address)) return null
  const segments = Array.isArray(event.message) ? event.message : []
  const parts = decodeParts(segments)
  const rawText = [event.raw_message, event.msg].filter(value => typeof value === 'string' && value).join(' ')
  const legacyText = event.msg || event.raw_message
  const text = legacyText ? String(legacyText).replace(/\[CQ:(?:reply|at),[^\]]*\]/g, '') : partText(parts)
  if (!segments.length && text) parts.push({kind:'text', text})
  const quote = decodeQuote(event, segments, rawText)
  const mentionIds = new Set(collectMentionTargetIds({message:segments.map(object), msg:rawText, at:event.at, at_user:event.at_user}).map(qqId))
  mentionIds.delete(null)
  const mentions = [...mentionIds].flatMap(id => id ? [qqUser(id)] : [])
  const messageId = opaqueMessageId(event.message_id ?? event.messageId)
  const senderName = sender.card || sender.nickname
  const seconds = Number(event.time)
  const occurredAt = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : options.now ?? Date.now()
  return {
    version: 1,
    conversation: address,
    sender: qqUser(senderId),
    ...(typeof senderName === 'string' && senderName ? {senderName} : {}),
    ...(messageId ? {messageId} : {}),
    occurredAt,
    text,
    parts,
    mentions,
    directedToAccount: mentionIds.has(address.account.id) || Boolean(event.atBot || event.at === true || event.atme || event.atMe || event.isAt),
    ...(quote ? {quote} : {}),
    ...(binding ? {binding} : {}),
  }
}
