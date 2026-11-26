import type { SimConfirmedGroupReply, SimMessage, SimSessionState, SimWakeReason } from '../../../contracts/simulation.js'
import { sanitizeUnicodeText } from '../../models/domain/unicodeText.js'

export interface GroupWakeMessage {
  seq: number
  speaker: string
  name: string
  text: string
  atSelf: boolean
  joinable: boolean
  mentions: string[]
  replyTo?: number
  replyToSpeaker?: string
  quotedText?: string
  ageSeconds: number
}

export interface GroupWakeRouting {
  selfName: string
  triggerSeq?: number
  reply: 'none' | 'addressed' | 'continuation'
  allowJoin: boolean
  messages: GroupWakeMessage[]
  previous: { sourceSeq: number; speaker: string; question: string; answer?: string }[]
}

export interface GroupWakeSelection {
  mode: 'reply' | 'join'
  seq: number
  previousSeq?: number
  contextSeqs?: number[]
}

export const GROUP_REPLY_LIMIT = 6
export const GROUP_REPLY_EVIDENCE_LIMIT = 16

export function isAddressedElsewhere(message: SimMessage): boolean {
  return !message.atSelf && !message.quoteToSelf && (!!message.atOther || !!message.replyToUserId)
}

export function isImplicitGroupContinuation(state: SimSessionState, message: SimMessage, windowMs: number): boolean {
  return !isAddressedElsewhere(message) && currentGroupReplies(state, message.at, windowMs)
    .some(({ source }) => source.userId === message.userId && source.seq < message.seq)
}

export function currentGroupReplies(state: SimSessionState, at: number, windowMs: number) {
  return (state.confirmedGroupReplies ?? []).flatMap(reply => {
    if (reply.at > at + 2_000 || at - reply.at > windowMs || !state.confirmedMessageIds?.includes(reply.replyId)) return []
    const source = state.recent.find(message => message.seq === reply.sourceSeq && String(message.messageId) === reply.sourceId)
    return source ? [{ reply, source }] : []
  })
}

export function rememberGroupReply(state: SimSessionState, source: SimMessage, reply: { messageId: string; at: number },
  context?: { content: string; evidenceIds: ReadonlySet<string> }) {
  if (!source.messageId || !reply.messageId || !state.confirmedMessageIds?.includes(reply.messageId)) return
  const row: SimConfirmedGroupReply = { sourceSeq: source.seq, sourceId: String(source.messageId), replyId: reply.messageId, at: reply.at }
  if (context && context.evidenceIds.size <= GROUP_REPLY_EVIDENCE_LIMIT) {
    row.text = sanitizeUnicodeText(context.content.slice(0, 240))
    if (context.evidenceIds.size) row.evidenceIds = [...context.evidenceIds]
  }
  state.confirmedGroupReplies = [row, ...(state.confirmedGroupReplies ?? []).filter(previous => previous.sourceSeq !== source.seq)].slice(0, GROUP_REPLY_LIMIT)
}

export function buildGroupWakeRouting(sources: SimMessage[], replies: ReturnType<typeof currentGroupReplies>,
  reason: SimWakeReason, selfId: string, selfName: string, joinable: ReadonlySet<number>, now: number, allowFollowUp: boolean): GroupWakeRouting {
  const ids = new Map([[selfId, 'bot']])
  const speaker = (id: string) => {
    let label = ids.get(id)
    if (!label) { label = 'p' + ids.size; ids.set(id, label) }
    return label
  }
  const trigger = sources.find(message => message.seq === reason.seq)
  const earlier = replies.filter(item => trigger && item.source.userId === trigger.userId && item.source.seq < trigger.seq).slice(0, 3)
  const unspecified = trigger && /^(?:那\s*)?(?:这个|那个|这件事|那件事|你|他|她)?\s*呢[?？。！!\s]*$/u.test(trigger.text.trim())
  const lastReplyAt = earlier[0]?.reply.at
  const sideConversation = trigger && lastReplyAt !== undefined && sources.some(message => message.seq < trigger.seq &&
    message.at >= lastReplyAt && isAddressedElsewhere(message) &&
    (message.userId === trigger.userId || message.mentionUserIds?.includes(trigger.userId)))
  const ambiguousContinuation = reason.kind === 'continuation' && unspecified && (earlier.length > 1 || sideConversation)
  const reply = !trigger || isAddressedElsewhere(trigger) || ambiguousContinuation ? 'none' : reason.kind === 'continuation' ? 'continuation'
    : reason.kind === 'nameMention' || reason.kind === 'question' ? 'addressed' : 'none'
  const messages = sources.map(message => {
    const replyId = message.quoteSource?.messageId ?? message.replyMessageId
    const quote = replyId ? sources.find(row => String(row.messageId) === replyId) : undefined
    const replyToUser = quote?.userId ?? message.replyToUserId
    const replyToSpeaker = message.quoteToSelf ? 'bot' : replyToUser ? speaker(replyToUser) : undefined
    const person = speaker(message.userId)
    return { seq: message.seq, speaker: person, name: message.name === message.userId ? person : message.name.slice(0, 48), text: message.text.slice(0, 160),
      ageSeconds: Math.max(0, Math.floor((now - message.at) / 1000)),
      atSelf: message.atSelf || message.quoteToSelf, joinable: joinable.has(message.seq) && !message.atSelf && !message.quoteToSelf,
      mentions: (message.mentionUserIds ?? []).slice(0, 8).map(speaker),
      ...(quote ? { replyTo: quote.seq } : {}),
      ...(replyToSpeaker ? { replyToSpeaker } : {}),
      ...(message.quoteText ? { quotedText: message.quoteText.slice(0, 100) } : {}),
    }
  })
  const previous = earlier.map(({ reply, source }) => ({ sourceSeq: source.seq, speaker: speaker(source.userId),
      question: source.text.slice(0, 160), ...(reply.text ? { answer: reply.text.slice(0, 200) } : {}) }))
  return { selfName: selfName.slice(0, 64), ...(trigger ? { triggerSeq: trigger.seq } : {}), reply: allowFollowUp ? reply : 'none',
    allowJoin: messages.some(message => message.joinable), messages, previous }
}

export function validateGroupWakeSelection(value: unknown, frame: GroupWakeRouting): GroupWakeSelection | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const row = value as Record<string, unknown>
  const { mode, seq, previousSeq, contextSeqs } = row
  if (Object.keys(row).some(key => !['mode', 'seq', 'previousSeq', 'contextSeqs'].includes(key)) ||
      typeof seq !== 'number' || !frame.messages.some(message => message.seq === seq)) return
  if (mode === 'reply') {
    if (frame.reply === 'none' || seq !== frame.triggerSeq ||
        (previousSeq === undefined ? frame.reply === 'continuation' : !frame.previous.some(reply => reply.sourceSeq === previousSeq))) return
  } else if (mode !== 'join' || !frame.allowJoin || previousSeq !== undefined ||
      !frame.messages.some(message => message.seq === seq && message.joinable)) return
  if (contextSeqs !== undefined && (!Array.isArray(contextSeqs) || contextSeqs.length > 3 ||
      contextSeqs.some(id => !frame.messages.some(message => message.seq === id)))) return
  const related = Array.isArray(contextSeqs) ? [...new Set(contextSeqs)].filter(id => id !== seq) : []
  return { mode, seq, ...(typeof previousSeq === 'number' ? { previousSeq } : {}), ...(related.length ? { contextSeqs: related } : {}) }
}
