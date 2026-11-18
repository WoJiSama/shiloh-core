import { types } from 'node:util'
import type { AgentBindingSnapshot, ConversationAddress, PlatformAccountRef } from '../contracts/agentBinding.js'
import type { AgentDicePrivateRelayRequest, AgentDiceRelayGuard } from '../contracts/agentDice.js'
import type { DeliveryReceipt } from '../contracts/delivery.js'
import type { IncomingMessage, MessageActionPort, MessagePart } from '../contracts/platformMessage.js'
import { agentDiceSourceFingerprint } from '../modules/dice/infrastructure/agentDiceSource.js'
import { conversationAddressKey, platformAccountKey } from '../modules/runtime/domain/agentBindings.js'
import { withDeliveryGuard } from '../modules/messaging/infrastructure/deliveryScope.js'
import { decodeQqIncomingMessage } from './qqMessage.js'
import { parseQqCqMessage } from './qqCqMessage.js'
import { qqId } from './qqIdentity.js'
import { proveQqFriend } from './qqOwnMessageProof.js'
import { qqDeliveryRejection } from './qqDeliveryReceipt.js'

export const QQ_DICE_PRIVATE_TIMEOUT_MS = 30_000
export interface QqDicePrivateApiOptions extends AgentDiceRelayGuard { readonly timeoutMs: number }
class InvalidDicePrivateDelivery extends Error {}
const invalid = () => new InvalidDicePrivateDelivery('QQ骰子私密投递来源或内容无效')
type Plain = Record<string, unknown>
function data(input: unknown, keys?: readonly string[]): Plain {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw invalid()
  const result: Plain = Object.create(null)
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key) || keys && !keys.includes(key)) throw invalid()
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable || descriptor.value === undefined) throw invalid()
    result[key] = descriptor.value
  }
  return result
}
function list(input: unknown, max: number): unknown[] {
  if (types.isProxy(input) || !Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype ||
      input.length > max || Reflect.ownKeys(input).length !== input.length + 1) throw invalid()
  return Array.from({ length: input.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw invalid()
    return descriptor.value
  })
}
function token(input: unknown, max = 512): string {
  if (typeof input !== 'string' || !input || input === '0' || input.trim() !== input || input.length > max || /[\u0000-\u001f\u007f]/u.test(input)) throw invalid()
  return input
}
function text(input: unknown, max = 16_384): string {
  if (typeof input !== 'string' || input.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input)) throw invalid()
  return input
}
function account(input: unknown): Readonly<PlatformAccountRef> {
  const row = data(input, ['platform', 'namespace', 'id'])
  if (row.platform !== 'qq' || row.namespace !== 'global' || typeof row.id !== 'string' || qqId(row.id) !== row.id || row.id.length > 16 || !Number.isSafeInteger(Number(row.id))) throw invalid()
  return Object.freeze({ platform: 'qq', namespace: 'global', id: row.id })
}
function group(input: unknown): Readonly<ConversationAddress> {
  const row = data(input, ['account', 'kind', 'id'])
  if (row.kind !== 'group' || typeof row.id !== 'string' || qqId(row.id) !== row.id || row.id.length > 16 || !Number.isSafeInteger(Number(row.id))) throw invalid()
  return Object.freeze({ account: account(row.account), kind: 'group', id: row.id })
}
function binding(input: unknown, connectionId: string, botKey: string): Readonly<AgentBindingSnapshot> {
  const row = data(input, ['source', 'id', 'revision', 'agentId', 'personaId', 'connectionId', 'target']), target = group(row.target)
  if (row.source !== 'configured' || row.connectionId !== connectionId || platformAccountKey(target.account) !== botKey) throw invalid()
  return Object.freeze({ source: 'configured', id: token(row.id, 4096), revision: token(row.revision, 4096), agentId: token(row.agentId),
    personaId: token(row.personaId), connectionId, target })
}
function sameBinding(left: AgentBindingSnapshot, right: AgentBindingSnapshot) { return JSON.stringify(left) === JSON.stringify(right) }
function messageId(input: unknown): input is string {
  return typeof input === 'string' && /^-?[1-9]\d{0,15}$/u.test(input) && Number.isSafeInteger(Number(input))
}
function nativeId(input: unknown): string | undefined {
  return typeof input === 'number' && Number.isSafeInteger(input) || typeof input === 'string'
    ? qqId(input) === String(input) ? String(input) : undefined : undefined
}
function occurredAt(input: unknown): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input <= 0 || !Number.isFinite(new Date(input).getTime())) throw invalid()
  return input
}
function parts(input: unknown): readonly MessagePart[] {
  return Object.freeze(list(input, 256).map(value => {
    const row = data(value, ['kind', 'text', 'user'])
    if (row.kind === 'text' && Object.keys(row).length === 2) return Object.freeze({ kind: 'text' as const, text: text(row.text) })
    if (row.kind === 'mention' && Object.keys(row).length === 2) return Object.freeze({ kind: 'mention' as const,
      user: row.user === 'everyone' ? 'everyone' as const : account(row.user) })
    throw invalid()
  }))
}
function source(input: unknown, selected: AgentBindingSnapshot, connectionId: string, botKey: string): Readonly<IncomingMessage> {
  const row = data(input, ['version', 'conversation', 'sender', 'senderName', 'messageId', 'occurredAt', 'text', 'parts', 'mentions', 'directedToAccount', 'quote', 'binding'])
  const conversation = group(row.conversation), sender = account(row.sender), body = text(row.text), messageParts = parts(row.parts)
  const mentions = Object.freeze(list(row.mentions, 128).map(account))
  if (row.version !== 1 || !messageId(row.messageId) || typeof row.directedToAccount !== 'boolean' || sender.id === selected.target.account.id ||
      conversationAddressKey(conversation) !== conversationAddressKey(selected.target) || !messageParts.length || !body.trim() ||
      messageParts.filter(part => part.kind === 'text').map(part => part.text).join('') !== body ||
      new Set(mentions.map(user => user.id)).size !== mentions.length || row.binding !== undefined && !sameBinding(binding(row.binding, connectionId, botKey), selected)) throw invalid()
  if (row.senderName !== undefined) text(row.senderName, 256)
  let quote: IncomingMessage['quote']
  if (Object.hasOwn(row, 'quote')) {
    const detail = data(row.quote, ['messageId', 'author', 'authorName', 'text', 'parts'])
    if (!messageId(detail.messageId)) throw invalid()
    if (detail.author !== undefined) account(detail.author)
    if (detail.authorName !== undefined) text(detail.authorName, 256)
    if (detail.text !== undefined) text(detail.text)
    // Embedded quote text and author never participate in relay authority.
    if (detail.parts !== undefined) { list(detail.parts, 256); snapshot(detail.parts) }
    quote = Object.freeze({ messageId: detail.messageId, parts: Object.freeze([]) })
  }
  return Object.freeze({ version: 1, conversation, sender, messageId: row.messageId, occurredAt: occurredAt(row.occurredAt), text: body,
    parts: messageParts, mentions, directedToAccount: row.directedToAccount, ...(quote ? { quote } : {}) })
}
/** Descriptor-only bounded JSON; native prototypes, accessors and proxies never run. */
function snapshot(input: unknown): unknown {
  const seen = new Set<object>(); let nodes = 0, chars = 0
  function copy(value: unknown, depth: number): unknown {
    if (++nodes > 100_000 || depth > 16) throw invalid()
    if (typeof value === 'string') { chars += value.length; if (chars > 262_144 || value.length > 65_536) throw invalid(); return value }
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value
    if (!value || typeof value !== 'object' || types.isProxy(value) || seen.has(value)) throw invalid()
    seen.add(value)
    try {
      if (Array.isArray(value)) return list(value, 10_000).map(item => copy(item, depth + 1))
      const row = data(value), result: Plain = Object.create(null)
      if (Object.keys(row).length > 256) throw invalid()
      for (const key of Object.keys(row)) { chars += key.length; if (chars > 262_144 || key.length > 512) throw invalid(); result[key] = copy(row[key], depth + 1) }
      return result
    } finally { seen.delete(value) }
  }
  return copy(input, 0)
}
function request(input: unknown, connectionId: string, botKey: string): Readonly<AgentDicePrivateRelayRequest> {
  const row = data(input, ['binding', 'source', 'origin', 'recipient', 'text', 'operationId', 'index', 'packId', 'deliveryId'])
  const selected = binding(row.binding, connectionId, botKey), original = data(row.origin, ['binding', 'source', 'operationId', 'authorityRevision'])
  const originalBinding = binding(original.binding, connectionId, botKey), originalSource = data(original.source, ['messageId', 'author', 'occurredAt', 'fingerprint'])
  const recipient = account(row.recipient), author = account(originalSource.author), body = text(row.text)
  if (!sameBinding(selected, originalBinding) || recipient.id === selected.target.account.id || author.id === selected.target.account.id ||
      !messageId(originalSource.messageId) || typeof originalSource.fingerprint !== 'string' || !/^[a-f\d]{64}$/u.test(originalSource.fingerprint) ||
      !body.trim() || !Number.isSafeInteger(row.index) || (row.index as number) < 0 || (row.index as number) >= 4096) throw invalid()
  return Object.freeze({ binding: selected, source: source(row.source, selected, connectionId, botKey), recipient, text: body,
    origin: Object.freeze({ binding: originalBinding, source: Object.freeze({ messageId: originalSource.messageId, author,
      occurredAt: occurredAt(originalSource.occurredAt), fingerprint: originalSource.fingerprint }),
      operationId: token(original.operationId), authorityRevision: token(original.authorityRevision, 4096) }),
    operationId: token(row.operationId), index: row.index as number,
    ...(Object.hasOwn(row, 'packId') ? { packId: token(row.packId) } : {}), ...(Object.hasOwn(row, 'deliveryId') ? { deliveryId: token(row.deliveryId, 1024) } : {}) })
}
function nativeScope(row: Plain, target: ConversationAddress, user?: string) {
  if (row.self_id !== undefined && nativeId(row.self_id) !== target.account.id ||
      row.group_id !== undefined && nativeId(row.group_id) !== target.id || row.user_id !== undefined && user !== undefined && nativeId(row.user_id) !== user) throw invalid()
}
function evidence(input: unknown, selected: AgentBindingSnapshot, expected: { messageId: string; author: PlatformAccountRef; occurredAt: number }): IncomingMessage {
  const response = data(snapshot(input)), row = data(response.data), sender = data(row.sender), target = selected.target
  nativeScope(response, target, expected.author.id); nativeScope(row, target, expected.author.id); nativeScope(sender, target, expected.author.id)
  const nativeMessageId = typeof row.message_id === 'number' && Number.isSafeInteger(row.message_id) || typeof row.message_id === 'string' ? String(row.message_id) : undefined
  if (response.status !== 'ok' || response.retcode !== 0 || row.message_type !== 'group' || nativeId(row.group_id) !== target.id ||
      nativeMessageId !== expected.messageId || !messageId(nativeMessageId) || nativeId(sender.user_id) !== expected.author.id ||
      row.user_id !== undefined && nativeId(row.user_id) !== expected.author.id || row.time !== expected.occurredAt / 1000 ||
      row.post_type !== undefined && row.post_type !== 'message' || row.message_sent_type !== undefined || row.temp_source !== undefined) throw invalid()
  const segments = typeof row.message === 'string' ? parseQqCqMessage(row.message) : row.message
  if (!Array.isArray(segments) || segments.length > 256) throw invalid()
  const decoded = decodeQqIncomingMessage({ self_id: target.account.id, message_type: 'group', group_id: target.id,
    user_id: expected.author.id, sender, message_id: expected.messageId, time: row.time, message: segments })
  if (!decoded || decoded.parts.some(part => !['text', 'mention'].includes(part.kind))) throw invalid()
  return source(decoded, selected, selected.connectionId, platformAccountKey(selected.target.account))
}
function receipt(input: unknown, bot: PlatformAccountRef, recipientId: string): DeliveryReceipt {
  try {
    const row = data(snapshot(input)), rejected = qqDeliveryRejection(row)
    if (rejected) return rejected
    if (row.status !== 'ok' || row.retcode !== 0) return { state: 'unknown' }
    const detail = data(row.data), nativeMessageId = typeof detail.message_id === 'number' && Number.isSafeInteger(detail.message_id) || typeof detail.message_id === 'string' ? String(detail.message_id) : undefined
    if (!messageId(nativeMessageId)) return { state: 'unknown' }
    for (const value of [row, detail]) if (value.group_id !== undefined || value.self_id !== undefined && nativeId(value.self_id) !== bot.id ||
        value.user_id !== undefined && nativeId(value.user_id) !== recipientId) return { state: 'unknown' }
    return { state: 'sent', messageId: nativeMessageId }
  } catch { return { state: 'unknown' } }
}

/** Send a frozen group-authorized dice result to a proven friend, never a TEMP target. */
export function createQqDicePrivateDeliveryPort(options: {
  readonly account: PlatformAccountRef; readonly connectionId: string; readonly allowsText?: (text: string) => boolean
  readApi(action: 'get_msg' | 'get_group_member_info' | 'get_friend_list', params: Record<string, unknown>, guard: QqDicePrivateApiOptions): Promise<unknown>
  sendApi(action: 'send_private_msg', params: Record<string, unknown>, guard: QqDicePrivateApiOptions): Promise<unknown>
}): NonNullable<MessageActionPort['sendDicePrivate']> {
  const configured = data(options, ['account', 'connectionId', 'allowsText', 'readApi', 'sendApi']), bot = account(configured.account), botKey = platformAccountKey(bot)
  const connectionId = token(configured.connectionId), readApi = configured.readApi as typeof options.readApi, sendApi = configured.sendApi as typeof options.sendApi
  const allowsText = configured.allowsText as typeof options.allowsText
  for (const callback of [readApi, sendApi, ...(allowsText === undefined ? [] : [allowsText])]) if (typeof callback !== 'function' || types.isProxy(callback)) throw invalid()
  return async (input, guard): Promise<DeliveryReceipt> => {
    let selected: Readonly<AgentDicePrivateRelayRequest>, identity: string, check: AgentDiceRelayGuard['isCurrent'], ensure: AgentDiceRelayGuard['ensureCurrent'], parent: AbortSignal
    try {
      selected = request(input, connectionId, botKey); identity = JSON.stringify(selected)
      const scope = data(guard, ['signal', 'isCurrent', 'ensureCurrent'])
      if (types.isProxy(scope.signal) || !(scope.signal instanceof AbortSignal) || Object.getPrototypeOf(scope.signal) !== AbortSignal.prototype ||
          typeof scope.isCurrent !== 'function' || types.isProxy(scope.isCurrent) || typeof scope.ensureCurrent !== 'function' || types.isProxy(scope.ensureCurrent)) throw invalid()
      parent = scope.signal; check = scope.isCurrent as typeof check; ensure = scope.ensureCurrent as typeof ensure
      if (allowsText?.(selected.text) === false) throw invalid()
    } catch { return { state: 'failed', code: 'invalid_dice_private_request' } }
    const cancel = new AbortController(), signal = AbortSignal.any([parent, cancel.signal]), deadline = Date.now() + QQ_DICE_PRIVATE_TIMEOUT_MS
    const current = () => { try { return !signal.aborted && check() === true &&
      platformAccountKey(account(data(options).account)) === botKey && data(options).connectionId === connectionId &&
      JSON.stringify(request(input, connectionId, botKey)) === identity && allowsText?.(selected.text) !== false } catch { return false } }
    const ensureCurrent = async () => { if (!current()) throw invalid(); await ensure(); if (!current()) throw invalid() }
    const live = (): QqDicePrivateApiOptions => Object.freeze({ signal, isCurrent: current, ensureCurrent, timeoutMs: Math.max(1, deadline - Date.now()) })
    let dispatched = false, timedOut = false
    const timer = setTimeout(() => { timedOut = true; cancel.abort() }, QQ_DICE_PRIVATE_TIMEOUT_MS), watch = setInterval(() => { if (!current()) cancel.abort() }, 25)
    const wait = <R>(run: () => Promise<R>): Promise<R> => new Promise((resolve, reject) => {
      const abort = () => reject(invalid()); signal.addEventListener('abort', abort, { once: true })
      Promise.resolve().then(() => { if (!current()) throw invalid(); return run() }).then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', abort)).catch(() => {})
      if (signal.aborted) abort()
    })
    const read = (action: Parameters<typeof readApi>[0], params: Record<string, unknown>) => wait(async () => {
      await ensureCurrent(); return readApi(action, Object.freeze(params), live())
    })
    try {
      await wait(ensureCurrent)
      const sourceProof = evidence(await read('get_msg', { message_id: selected.source.messageId! }), selected.binding,
        { messageId: selected.source.messageId!, author: selected.source.sender, occurredAt: selected.source.occurredAt })
      if (agentDiceSourceFingerprint(sourceProof) !== agentDiceSourceFingerprint(selected.source) || sourceProof.directedToAccount !== selected.source.directedToAccount) throw invalid()
      const original = selected.origin.source
      const originalProof = original.messageId === selected.source.messageId
        ? sourceProof : evidence(await read('get_msg', { message_id: original.messageId }), selected.origin.binding, original)
      if (originalProof.sender.id !== original.author.id || originalProof.occurredAt !== original.occurredAt ||
          agentDiceSourceFingerprint(originalProof) !== original.fingerprint) throw invalid()
      const memberResponse = data(snapshot(await read('get_group_member_info', { group_id: selected.binding.target.id, user_id: selected.recipient.id, no_cache: true })))
      const member = data(memberResponse.data)
      nativeScope(memberResponse, selected.binding.target, selected.recipient.id); nativeScope(member, selected.binding.target, selected.recipient.id)
      if (memberResponse.status !== 'ok' || memberResponse.retcode !== 0 || nativeId(member.group_id) !== selected.binding.target.id || nativeId(member.user_id) !== selected.recipient.id) throw invalid()
      const privateTarget = Object.freeze({ account: bot, kind: 'private' as const, id: selected.recipient.id })
      if (!proveQqFriend(snapshot(await read('get_friend_list', {})), privateTarget)) throw invalid()
      await wait(ensureCurrent)
      if (!current()) throw invalid()
      const params = Object.freeze({ user_id: selected.recipient.id, message: Object.freeze([Object.freeze({ type: 'text', data: Object.freeze({ text: selected.text }) })]) })
      const result = await wait(() => {
        if (!current()) throw invalid()
        return withDeliveryGuard(current, () => { if (!current()) throw invalid(); dispatched = true; return sendApi('send_private_msg', params, live()) })
      })
      const delivered = receipt(result, bot, selected.recipient.id)
      return delivered.state === 'failed' || current() ? delivered : { state: 'unknown' }
    } catch (error) {
      return !dispatched && !timedOut && (error instanceof InvalidDicePrivateDelivery || !current())
        ? { state: 'failed', code: 'dice_private_source_unavailable' } : { state: 'unknown' }
    }
    finally { clearTimeout(timer); clearInterval(watch); cancel.abort() }
  }
}
