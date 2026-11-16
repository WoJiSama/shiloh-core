import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { types } from 'node:util'
import type { AgentBindingSnapshot, ConversationAddress, PlatformAccountRef, PlatformUserRef } from '../contracts/agentBinding.js'
import type { FileDeliveryReceipt } from '../contracts/agentFileDelivery.js'
import type { AgentTorrentArchive, SendRequesterArchiveAction } from '../contracts/agentTorrent.js'
import type { MessageActionOptions, MessageActionPort } from '../contracts/platformMessage.js'
import { validateAgentTorrentArchive } from '../modules/media/domain/agentTorrent.js'
import { queuedDeliveryAllowed, withDeliveryGuard } from '../modules/messaging/infrastructure/deliveryScope.js'
import { conversationAddressKey, platformAccountKey } from '../modules/runtime/domain/agentBindings.js'
import { qqId } from './qqIdentity.js'
import { decodeQqIncomingMessage } from './qqMessage.js'
import { parseQqCqMessage } from './qqCqMessage.js'
import { QQ_REQUESTER_ARCHIVE_TIMEOUT_MS, type QqRequesterArchiveBridge, type QqRequesterArchiveLease } from './qqRequesterArchiveBridge.js'

type Options = MessageActionOptions & { readonly signal?: AbortSignal }
type Scope = { readonly isCurrent: () => boolean; readonly signal: AbortSignal; readonly timeoutMs: number }
const failed = (code: string): FileDeliveryReceipt => ({ state: 'failed', code })
const unknown = (): FileDeliveryReceipt => ({ state: 'unknown' })
function data(input: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw Error('Invalid archive data')
  const row: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || keys && !keys.includes(key)) throw Error('Invalid archive field')
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw Error('Invalid archive field')
    row[key] = descriptor.value
  }
  return row
}
function account(input: unknown): Readonly<PlatformAccountRef> {
  const row = data(input, ['platform', 'namespace', 'id'])
  if (row.platform !== 'qq' || row.namespace !== 'global' || typeof row.id !== 'string' || qqId(row.id) !== row.id) throw Error('Invalid archive account')
  return Object.freeze({ platform: 'qq', namespace: 'global', id: row.id })
}
function group(input: unknown): Readonly<ConversationAddress> {
  const row = data(input, ['account', 'kind', 'id'])
  if (row.kind !== 'group' || typeof row.id !== 'string' || qqId(row.id) !== row.id) throw Error('Invalid archive source group')
  return Object.freeze({ account: account(row.account), kind: 'group', id: row.id })
}
function binding(input: unknown, key: string, connectionId: string): Readonly<AgentBindingSnapshot> {
  const row = data(input, ['source', 'id', 'revision', 'personaId', 'agentId', 'connectionId', 'target'])
  if (row.source !== 'configured' && row.source !== 'legacy') throw Error('Invalid archive binding')
  for (const field of ['id', 'revision', 'personaId', 'agentId', 'connectionId'] as const) {
    if (typeof row[field] !== 'string' || !row[field] || row[field].length > 512 || /[\u0000-\u001f\u007f]/u.test(row[field])) throw Error('Invalid archive binding')
  }
  const target = group(row.target)
  if (row.connectionId !== connectionId || conversationAddressKey(target) !== key) throw Error('Invalid archive binding')
  return Object.freeze({ source: row.source, id: row.id as string, revision: row.revision as string, personaId: row.personaId as string,
    agentId: row.agentId as string, connectionId, target })
}
function messageId(input: unknown): input is string {
  return typeof input === 'string' && /^-?[1-9]\d{0,9}$/u.test(input) && Number(input) >= -2_147_483_648 && Number(input) <= 2_147_483_647
}
function source(input: unknown, bot: PlatformAccountRef): Readonly<SendRequesterArchiveAction['source']> {
  const row = data(input, ['messageId', 'sender', 'occurredAt', 'textSha256']), sender: PlatformUserRef = account(row.sender)
  if (!messageId(row.messageId) || sender.id === bot.id || typeof row.occurredAt !== 'number' || !Number.isSafeInteger(row.occurredAt) || row.occurredAt <= 0) throw Error('Invalid archive requester')
  if (Object.hasOwn(row, 'textSha256') && (typeof row.textSha256 !== 'string' || !/^[a-f\d]{64}$/u.test(row.textSha256))) throw Error('Invalid archive source text digest')
  return Object.freeze({ messageId: row.messageId, sender, occurredAt: row.occurredAt,
    ...(typeof row.textSha256 === 'string' ? { textSha256: row.textSha256 } : {}) })
}
/** Bounded descriptor-only native snapshot; no native card or URL leaves this file. */
function snapshot(input: unknown): unknown {
  const seen = new Set<object>(); let nodes = 0, chars = 0
  function copy(value: unknown, depth: number): unknown {
    if (++nodes > 4096 || depth > 16) throw Error('Invalid native source')
    if (typeof value === 'string') { chars += value.length; if (value.length > 65536 || chars > 131072) throw Error('Invalid native source'); return value }
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value
    if (!value || typeof value !== 'object' || seen.has(value)) throw Error('Invalid native source')
    seen.add(value)
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 512 || Reflect.ownKeys(value).length !== value.length + 1) throw Error('Invalid native source')
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw Error('Invalid native source')
        return copy(descriptor.value, depth + 1)
      })
    }
    const row = data(value), result: Record<string, unknown> = Object.create(null)
    for (const key of Object.keys(row).sort()) { chars += key.length; if (chars > 131072 || key.length > 512) throw Error('Invalid native source'); result[key] = copy(row[key], depth + 1) }
    return result
  }
  return copy(input, 0)
}
function canonicalId(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) || typeof value === 'string' ? qqId(value) === String(value) ? String(value) : undefined : undefined
}
function sourceEvidence(input: unknown, target: ConversationAddress, expected: SendRequesterArchiveAction['source']): string {
  const response = data(snapshot(input)), native = data(response.data), sender = data(native.sender)
  if (response.status !== 'ok' || response.retcode !== 0 || native.message_type !== 'group' || canonicalId(native.group_id) !== target.id ||
    String(native.message_id) !== expected.messageId || !messageId(String(native.message_id)) || canonicalId(native.user_id) !== expected.sender.id ||
    canonicalId(sender.user_id) !== expected.sender.id || native.time !== expected.occurredAt / 1000 || native.post_type !== undefined && native.post_type !== 'message' ||
    native.message_sent_type === 'self' || response.self_id !== undefined && canonicalId(response.self_id) !== target.account.id ||
    native.self_id !== undefined && canonicalId(native.self_id) !== target.account.id ||
    !Array.isArray(native.message) && typeof native.message !== 'string' && typeof native.raw_message !== 'string') throw Error('Source unavailable')
  if (expected.textSha256 !== undefined) {
    // Match OneBot readMessage: parse CQ first and ignore raw_message.
    const segments = typeof native.message === 'string' ? parseQqCqMessage(native.message) : native.message
    if (!Array.isArray(segments)) throw Error('Source text unavailable')
    const decoded = decodeQqIncomingMessage({ self_id: target.account.id, post_type: 'message', message_type: 'group', group_id: target.id,
      user_id: expected.sender.id, sender: native.sender, message_id: expected.messageId, message: segments, time: native.time })
    if (!decoded || decoded.text.length > 4000 || createHash('sha256').update(decoded.text).digest('hex') !== expected.textSha256) throw Error('Source text changed')
  }
  return createHash('sha256').update(JSON.stringify({ message: native.message ?? null, raw: native.raw_message ?? null })).digest('hex')
}
function receipt(input: unknown, bot: PlatformAccountRef, sender: PlatformUserRef): FileDeliveryReceipt {
  try {
    const row = data(input, ['status', 'retcode', 'data', 'message', 'wording', 'echo', 'stream', 'self_id', 'user_id', 'group_id', 'state', 'code'])
    if (row.state === 'failed') return failed(typeof row.code === 'string' && /^[a-zA-Z0-9_:-]{1,128}$/u.test(row.code) ? row.code : 'native_rejected')
    if (row.retcode === 400 || row.retcode === 1400) return failed(String(row.retcode))
    if (row.state === 'unknown' || row.status !== 'ok' || row.retcode !== 0) return unknown()
    const detail = data(row.data, ['file_id', 'self_id', 'user_id', 'group_id'])
    if (typeof detail.file_id !== 'string' || !detail.file_id || detail.file_id.length > 1024 || /[\s\u0000-\u001f\u007f]/u.test(detail.file_id)) return unknown()
    for (const value of [row, detail]) if (value.group_id !== undefined || value.self_id !== undefined && canonicalId(value.self_id) !== bot.id ||
      value.user_id !== undefined && canonicalId(value.user_id) !== sender.id) return unknown()
    return { state: 'uploaded', fileId: detail.file_id }
  } catch { return unknown() }
}

/** A fixed group source authorizes only its original sender; native TEMP delivery remains available. */
export function createQqRequesterArchiveDeliveryPort(options: {
  readonly account: PlatformAccountRef
  readonly connectionId: string
  readonly bridge: QqRequesterArchiveBridge
  readonly allowsText?: (text: string) => boolean
  readonly timeoutMs?: number
  readApi(action: 'get_msg', params: Record<string, unknown>, scope: Scope): Promise<unknown>
  sendApi(action: 'upload_private_file', params: Record<string, unknown>, scope: Scope): Promise<unknown>
}): NonNullable<MessageActionPort['sendRequesterArchive']> {
  const configured = options.account, bot = account(configured), accountKey = platformAccountKey(bot), connectionId = options.connectionId
  const bridge = options.bridge, readApi = options.readApi, sendApi = options.sendApi, allowsText = options.allowsText, timeoutMs = options.timeoutMs ?? QQ_REQUESTER_ARCHIVE_TIMEOUT_MS
  if (typeof connectionId !== 'string' || !connectionId || typeof readApi !== 'function' || typeof sendApi !== 'function' ||
    typeof bridge.stage !== 'function' || allowsText !== undefined && typeof allowsText !== 'function' ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > QQ_REQUESTER_ARCHIVE_TIMEOUT_MS) throw Error('QQ请求者压缩包配置无效')
  let active = false
  interface Waiting { run(): Promise<FileDeliveryReceipt>; resolve(value: FileDeliveryReceipt): void; signal: AbortSignal; abort(): void }
  const waiting: Waiting[] = []
  const drain = () => {
    if (active) return
    const next = waiting.shift(); if (!next) return
    next.signal.removeEventListener('abort', next.abort)
    if (next.signal.aborted) { next.resolve(failed('binding_changed')); drain(); return }
    active = true
    void Promise.resolve().then(next.run).then(next.resolve, () => next.resolve(unknown())).finally(() => { active = false; drain() })
  }
  function enqueue(run: Waiting['run'], signal: AbortSignal): Promise<FileDeliveryReceipt> {
    if (signal.aborted) return Promise.resolve(failed('binding_changed'))
    if (active && waiting.length >= 4) return Promise.resolve(failed('requester_archive_busy'))
    return new Promise(resolve => {
      const captured = AsyncLocalStorage.snapshot()
      const item: Waiting = { run: () => captured(run), resolve, signal, abort() {
        const at = waiting.indexOf(item); if (at >= 0) { waiting.splice(at, 1); resolve(failed('binding_changed')) }
      } }
      waiting.push(item); signal.addEventListener('abort', item.abort, { once: true }); drain()
    })
  }
  return async (input: SendRequesterArchiveAction, options: Options = {}): Promise<FileDeliveryReceipt> => {
    let scope: ReturnType<typeof AsyncLocalStorage.snapshot>, target: ConversationAddress, expected: SendRequesterArchiveAction['source'], archive: AgentTorrentArchive
    let targetKey: string, bindingKey: string, sourceKey: string, caller: AbortSignal | undefined, check: (() => boolean) | undefined
    try {
      scope = AsyncLocalStorage.snapshot()
      const row = data(input, ['version', 'kind', 'target', 'binding', 'source', 'archive'])
      if (row.version !== 1 || row.kind !== 'requester-archive.upload') throw Error('Invalid archive')
      target = group(row.target); targetKey = conversationAddressKey(target)
      if (platformAccountKey(target.account) !== accountKey) throw Error('Invalid archive target')
      bindingKey = JSON.stringify(binding(row.binding, targetKey, connectionId)); expected = source(row.source, bot); sourceKey = JSON.stringify(expected)
      archive = validateAgentTorrentArchive(row.archive)
      if (allowsText && allowsText(archive.name) !== true) throw Error('Invalid archive name')
      const guard = data(options, ['isCurrent', 'signal']); caller = guard.signal as AbortSignal | undefined; check = guard.isCurrent as (() => boolean) | undefined
      if (caller !== undefined && (!(caller instanceof AbortSignal) || types.isProxy(caller)) || check !== undefined && typeof check !== 'function') throw Error('Invalid archive guard')
    } catch { return failed('invalid_requester_archive') }
    const cancel = new AbortController(), deadline = new AbortController()
    let signal: AbortSignal
    try { signal = AbortSignal.any([cancel.signal, deadline.signal, ...(caller ? [caller] : [])]) } catch { return failed('invalid_requester_archive_guard') }
    const isCurrent = () => {
      try {
        if (signal.aborted || check && check() !== true || !scope(queuedDeliveryAllowed) || platformAccountKey(account(configured)) !== accountKey ||
          allowsText && allowsText(archive.name) !== true) return false
        const row = data(input, ['version', 'kind', 'target', 'binding', 'source', 'archive']), currentArchive = data(row.archive, ['name', 'mime', 'base64'])
        return row.version === 1 && row.kind === 'requester-archive.upload' && conversationAddressKey(group(row.target)) === targetKey &&
          JSON.stringify(binding(row.binding, targetKey, connectionId)) === bindingKey && JSON.stringify(source(row.source, bot)) === sourceKey &&
          currentArchive.name === archive.name && currentArchive.mime === archive.mime && currentArchive.base64 === archive.base64
      } catch { return false }
    }
    const timer = setTimeout(() => deadline.abort(), timeoutMs), watcher = setInterval(() => { if (!isCurrent()) cancel.abort() }, 20); watcher.unref()
    const wait = <T>(operation: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      const abort = () => reject(Error('Archive operation cancelled')), clear = () => signal.removeEventListener('abort', abort)
      operation.then(value => { clear(); resolve(value) }, () => { clear(); reject(Error('Archive operation failed')) })
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
    })
    try {
      if (!isCurrent()) return failed('binding_changed')
      return await enqueue(async () => {
        let lease: QqRequesterArchiveLease | undefined, accepting = true, dispatched = false, fingerprint: string | undefined
        const verify = async () => {
          if (!isCurrent()) throw Error('Stale source')
          const value = await wait(Promise.resolve().then(() => {
            if (!isCurrent()) throw Error('Stale source')
            return readApi('get_msg', Object.freeze({ message_id: Number(expected.messageId) }), { signal, isCurrent, timeoutMs: 1_500 })
          }))
          if (!isCurrent()) throw Error('Stale source')
          const next = sourceEvidence(value, target, expected)
          if (fingerprint !== undefined && fingerprint !== next) throw Error('Source changed')
          fingerprint = next
        }
        try {
          await verify()
          await wait(Promise.resolve().then(() => {
            if (!isCurrent()) throw Error('Stale source')
            return bridge.stage(archive, { signal, isCurrent })
          }).then(async value => {
            if (!accepting || !isCurrent()) { await value.release(); throw Error('Stale resource') }
            lease = value
            const url = new URL(value.nativeUrl)
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search || url.href !== value.nativeUrl || value.nativeUrl.length > 2048) throw Error('Invalid archive resource')
          }))
          await verify()
          const params = Object.freeze({ user_id: expected.sender.id, file: lease!.nativeUrl, name: archive.name })
          const result = await wait(Promise.resolve().then(() => {
            if (!isCurrent()) return failed('binding_changed')
            dispatched = true
            return withDeliveryGuard(isCurrent, () => sendApi('upload_private_file', params, { signal, isCurrent, timeoutMs }))
          }))
          if (!isCurrent()) return dispatched ? unknown() : failed('binding_changed')
          await verify()
          return receipt(result, bot, expected.sender)
        } catch { return dispatched ? unknown() : failed(signal.aborted ? 'binding_changed' : 'requester_archive_preparation_failed') }
        finally { accepting = false; cancel.abort(); if (lease) await Promise.resolve().then(() => lease!.release()).catch(() => {}) }
      }, signal)
    } catch { return unknown() }
    finally { clearTimeout(timer); clearInterval(watcher); cancel.abort() }
  }
}
