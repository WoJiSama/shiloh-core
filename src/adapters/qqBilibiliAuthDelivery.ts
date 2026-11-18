import { createHash } from 'node:crypto'
import { types } from 'node:util'
import type { AgentBindingSnapshot, ConversationAddress, PlatformAccountRef } from '../contracts/agentBinding.js'
import type { AgentBilibiliAuthSource, SendRequesterBilibiliAuthAction } from '../contracts/agentBilibiliAuth.js'
import type { DeliveryReceipt } from '../contracts/delivery.js'
import type { MessageActionPort } from '../contracts/platformMessage.js'
import { readImageDimensions } from '../modules/image/domain/imageDimensions.js'
import { validateAgentToolImage } from '../modules/image/infrastructure/agentToolImage.js'
import { sanitizeFinalReplyText } from '../modules/conversation/domain/replySanitizer.js'
import { conversationAddressKey, platformAccountKey } from '../modules/runtime/domain/agentBindings.js'
import { withDeliveryGuard } from '../modules/messaging/infrastructure/deliveryScope.js'
import { decodeQqIncomingMessage } from './qqMessage.js'
import { parseQqCqMessage } from './qqCqMessage.js'
import { qqId } from './qqIdentity.js'
import { qqDeliveryRejection } from './qqDeliveryReceipt.js'

type Guard = { readonly signal: AbortSignal; isCurrent(): boolean }
export const QQ_BILIBILI_AUTH_TIMEOUT_MS = 30_000
const invalid = () => new Error('QQ授权通知来源或内容无效')
function data(input: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw invalid()
  const row: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (typeof key !== 'string' || keys && !keys.includes(key) || !descriptor || !Object.hasOwn(descriptor, 'value')) throw invalid()
    row[key] = descriptor.value
  }
  return row
}
function account(input: unknown): PlatformAccountRef {
  const row = data(input, ['platform', 'namespace', 'id'])
  if (row.platform !== 'qq' || row.namespace !== 'global' || typeof row.id !== 'string' || qqId(row.id) !== row.id) throw invalid()
  return Object.freeze({ platform: 'qq', namespace: 'global', id: row.id })
}
function target(input: unknown): ConversationAddress {
  const row = data(input, ['account', 'kind', 'id'])
  if (!['private', 'group'].includes(row.kind as string) || typeof row.id !== 'string' || qqId(row.id) !== row.id) throw invalid()
  return Object.freeze({ account: account(row.account), kind: row.kind as 'private' | 'group', id: row.id })
}
function binding(input: unknown, connectionId: string): AgentBindingSnapshot {
  const row = data(input, ['source', 'id', 'revision', 'agentId', 'personaId', 'connectionId', 'target'])
  if (row.source !== 'configured' || row.connectionId !== connectionId) throw invalid()
  for (const field of ['id', 'revision', 'agentId', 'personaId', 'connectionId']) if (typeof row[field] !== 'string' || !row[field] || (row[field] as string).length > 512 || /[\u0000-\u001f\u007f]/u.test(row[field] as string)) throw invalid()
  return Object.freeze({ source: 'configured', id: row.id as string, revision: row.revision as string, agentId: row.agentId as string,
    personaId: row.personaId as string, connectionId, target: target(row.target) })
}
function messageId(input: unknown): input is string { return typeof input === 'string' && /^-?[1-9]\d{0,15}$/u.test(input) && Number.isSafeInteger(Number(input)) }
function source(input: unknown, selected: AgentBindingSnapshot): AgentBilibiliAuthSource {
  const row = data(input, ['target', 'messageId', 'author', 'occurredAt', 'textSha256']), destination = target(row.target), author = account(row.author)
  if (conversationAddressKey(destination) !== conversationAddressKey(selected.target) || author.id === selected.target.account.id ||
      !messageId(row.messageId) || typeof row.occurredAt !== 'number' || !Number.isSafeInteger(row.occurredAt) || row.occurredAt <= 0 ||
      typeof row.textSha256 !== 'string' || !/^[a-f\d]{64}$/u.test(row.textSha256) || destination.kind === 'private' && destination.id !== author.id) throw invalid()
  return Object.freeze({ target: destination, messageId: row.messageId, author, occurredAt: row.occurredAt, textSha256: row.textSha256 })
}
/** Own all native values before decoding. Getters/proxies never run at this boundary. */
function native(input: unknown, depth = 0, budget = { nodes: 0, chars: 0 }): unknown {
  if (++budget.nodes > 4096 || depth > 12) throw invalid()
  if (typeof input === 'string') { budget.chars += input.length; if (budget.chars > 131072) throw invalid(); return input }
  if (input === null || typeof input === 'boolean' || typeof input === 'number' && Number.isFinite(input)) return input
  if (Array.isArray(input) && !types.isProxy(input) && Object.getPrototypeOf(input) === Array.prototype) {
    if (input.length > 256 || Reflect.ownKeys(input).length !== input.length + 1) throw invalid()
    return Array.from({ length: input.length }, (_, index) => { const d = Object.getOwnPropertyDescriptor(input, String(index)); if (!d || !Object.hasOwn(d, 'value')) throw invalid(); return native(d.value, depth + 1, budget) })
  }
  return Object.fromEntries(Object.entries(data(input)).map(([key, value]) => [key, native(value, depth + 1, budget)]))
}
function evidence(input: unknown, expected: AgentBilibiliAuthSource): string {
  const response = data(native(input)), row = data(response.data), sender = data(row.sender)
  if (response.status !== 'ok' || response.retcode !== 0 || row.message_type !== expected.target.kind ||
      String(row.message_id) !== expected.messageId || String(row.user_id) !== expected.author.id || String(sender.user_id) !== expected.author.id ||
      row.time !== expected.occurredAt / 1000 || row.self_id !== undefined && String(row.self_id) !== expected.target.account.id ||
      expected.target.kind === 'group' && String(row.group_id) !== expected.target.id || expected.target.kind === 'private' && row.group_id !== undefined) throw invalid()
  const segments = Array.isArray(row.message) ? row.message : typeof row.message === 'string' ? parseQqCqMessage(row.message) : undefined
  if (!segments) throw invalid()
  const decoded = decodeQqIncomingMessage({ ...row, post_type: 'message', self_id: expected.target.account.id, message: segments })
  if (!decoded || decoded.quote || decoded.parts.some(part => !['text', 'mention'].includes(part.kind)) ||
      createHash('sha256').update(decoded.text).digest('hex') !== expected.textSha256) throw invalid()
  return createHash('sha256').update(JSON.stringify({ message: row.message, raw: row.raw_message ?? null })).digest('hex')
}
function receipt(input: unknown, bot: PlatformAccountRef, authorId: string): DeliveryReceipt {
  try {
    const row = data(input), rejected = qqDeliveryRejection(row); if (rejected) return rejected
    if (row.status !== 'ok' || row.retcode !== 0) return { state: 'unknown' }
    const detail = data(row.data), id = String(detail.message_id)
    if (!messageId(id)) return { state: 'unknown' }
    for (const value of [row, detail]) if (value.group_id !== undefined || value.self_id !== undefined && String(value.self_id) !== bot.id || value.user_id !== undefined && String(value.user_id) !== authorId) return { state: 'unknown' }
    return { state: 'sent', messageId: id }
  } catch { return { state: 'unknown' } }
}
/** Only the original verified requester can receive a login QR or its terminal notice. */
export function createQqBilibiliAuthDeliveryPort(options: {
  readonly account: PlatformAccountRef; readonly connectionId: string; readonly allowsText?: (text: string) => boolean
  readApi(action: 'get_msg', params: Record<string, unknown>, guard: Guard): Promise<unknown>
  sendApi(action: 'send_private_msg', params: Record<string, unknown>, guard: Guard): Promise<unknown>
}): NonNullable<MessageActionPort['sendRequesterBilibiliAuth']> {
  const bot = account(options.account), botKey = platformAccountKey(bot)
  return async (input: SendRequesterBilibiliAuthAction, guard = {}) => {
    let selected: AgentBindingSnapshot, original: AgentBilibiliAuthSource, content: readonly unknown[], check: (() => boolean) | undefined, parent: AbortSignal | undefined
    try {
      const row = data(input, ['version', 'kind', 'binding', 'source', 'content']), scope = data(guard, ['signal', 'isCurrent'])
      if (row.version !== 1 || row.kind !== 'bilibili-auth.notify') throw invalid()
      selected = binding(row.binding, options.connectionId); original = source(row.source, selected)
      if (platformAccountKey(selected.target.account) !== botKey) throw invalid()
      check = scope.isCurrent as (() => boolean) | undefined; parent = scope.signal as AbortSignal | undefined
      if (typeof check !== 'function' || types.isProxy(check) || !(parent instanceof AbortSignal) || types.isProxy(parent)) throw invalid()
      const body = data(row.content, ['kind', 'mime', 'base64', 'text'])
      if (body.kind === 'qr' && Object.keys(body).length === 3 && body.mime === 'image/png') {
        if (typeof body.base64 !== 'string' || body.base64.length > Math.ceil(2 * 1024 * 1024 / 3) * 4) throw invalid()
        const image = validateAgentToolImage({ mime: body.mime, base64: body.base64 }), bytes = Buffer.from(image.base64, 'base64')
        const dimensions = readImageDimensions(bytes)
        if (bytes.length > 2 * 1024 * 1024 || !dimensions || dimensions.width > 2048 || dimensions.height > 2048 || dimensions.width * dimensions.height > 4 * 1024 * 1024) throw invalid()
        content = [Object.freeze({ type: 'image', data: Object.freeze({ file: `base64://${image.base64}` }) })]
      } else if (body.kind === 'text' && Object.keys(body).length === 2 && typeof body.text === 'string' && body.text.trim() && body.text.length <= 2000 &&
          sanitizeFinalReplyText(body.text) === body.text && options.allowsText?.(body.text) !== false) content = [Object.freeze({ type: 'text', data: Object.freeze({ text: body.text }) })]
      else throw invalid()
    } catch { return { state: 'failed', code: 'invalid_bilibili_auth_notice' } }
    const controller = new AbortController(), signal = AbortSignal.any([parent!, controller.signal, AbortSignal.timeout(QQ_BILIBILI_AUTH_TIMEOUT_MS)])
    const current = () => { try { return !signal.aborted && check?.() === true && platformAccountKey(account(options.account)) === botKey } catch { return false } }
    const live: Guard = { signal, isCurrent: current }, timer = setInterval(() => { if (!current()) controller.abort() }, 25)
    let dispatched = false, fingerprint: string | undefined
    const wait = <T>(operation: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      const abort = () => reject(invalid()); signal.addEventListener('abort', abort, { once: true })
      operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => {})
      if (signal.aborted) abort()
    })
    try {
      if (!current()) return { state: 'failed', code: 'binding_changed' }
      fingerprint = evidence(await wait(options.readApi('get_msg', { message_id: original.messageId }, live)), original)
      if (!current()) return { state: 'failed', code: 'binding_changed' }
      const params = Object.freeze({ user_id: original.author.id, ...(original.target.kind === 'group' ? { group_id: original.target.id } : {}), message: Object.freeze(content) })
      const result = await wait(Promise.resolve().then(() => {
        if (!current()) throw invalid(); dispatched = true
        return withDeliveryGuard(current, () => options.sendApi('send_private_msg', params, live))
      }))
      if (!current() || evidence(await wait(options.readApi('get_msg', { message_id: original.messageId }, live)), original) !== fingerprint || !current()) return { state: 'unknown' }
      return receipt(result, bot, original.author.id)
    } catch { return dispatched ? { state: 'unknown' } : { state: 'failed', code: 'bilibili_auth_source_unavailable' } }
    finally { clearInterval(timer); controller.abort() }
  }
}
