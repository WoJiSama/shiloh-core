import { types } from 'node:util'
import type { AgentBindingSnapshot, PlatformAccountRef } from '../contracts/agentBinding.js'
import type { AgentQzoneAction, AgentQzoneFeed, AgentQzoneGuard, AgentQzoneOperation, AgentQzoneOwnPost, AgentQzoneProvider, AgentQzoneReceipt } from '../contracts/agentQzone.js'
import { withDeliveryGuard } from '../modules/messaging/infrastructure/deliveryScope.js'

export type QqQzoneApiAction = 'send_qzone_msg' | 'delete_qzone_msg' | 'get_credentials'
export interface QqQzoneApiOptions extends AgentQzoneGuard { readonly timeoutMs: number }
export interface QqQzoneProviderOptions {
  readonly account: PlatformAccountRef
  readonly connectionId: string
  isReady(): boolean
  callApi(action: QqQzoneApiAction, params: Record<string, unknown>, options: QqQzoneApiOptions): Promise<unknown>
  /** Independent durable ownership lookup. Deletion is unavailable without it. */
  readOwnPost?(account: PlatformAccountRef, postId: string): Promise<AgentQzoneOwnPost | undefined>
  /** A host-controlled HTTP executor; this is never a model-selected URL or client. */
  readonly fetch?: typeof globalThis.fetch
}

export const QQ_QZONE_TIMEOUT_MS = 30_000
export const QQ_QZONE_HTTP_TIMEOUT_MS = 15_000
export const QQ_QZONE_MAX_RESPONSE_BYTES = 256 * 1024
const origin = 'https://user.qzone.qq.com'
const endpoints = {
  visit: '/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6',
  like: '/proxy/domain/w.qzone.qq.com/cgi-bin/likes/internal_dolike_appbar',
  comment: '/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_re_feeds',
} as const
const invalid = () => Error('Invalid QQ Qzone request')
class QzoneFeedOwnerMismatch extends Error {}
const failed = (code: string, evidence: { httpStatus?: number; nativeCode?: number } = {}): AgentQzoneReceipt =>
  ({ state: 'failed', code, ...evidence })
const unknown = (): AgentQzoneReceipt => ({ state: 'unknown' })
const platformCode = (input: unknown): input is number =>
  typeof input === 'number' && Number.isInteger(input) && Math.abs(input) <= 2_147_483_647
const timedOut = (signal: AbortSignal) => signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError'

/** Inspect data properties only; provider/native responses never execute caller getters. */
function data(input: unknown, allowed?: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw invalid()
  const row: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(input)) {
    const field = Object.getOwnPropertyDescriptor(input, key)
    if (typeof key !== 'string' || allowed && !allowed.includes(key) || !field || !Object.hasOwn(field, 'value')) throw invalid()
    row[key] = field.value
  }
  return row
}
function token(input: unknown, maximum = 128): string {
  if (typeof input !== 'string' || !input.length || input.length > maximum || input !== input.trim() || /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(input)) throw invalid()
  return input
}
function qqId(input: unknown): string {
  if (typeof input !== 'string' || !/^[1-9]\d{0,19}$/u.test(input)) throw invalid()
  return input
}
function postId(input: unknown): string {
  if (typeof input !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(input)) throw invalid()
  return input
}
function account(input: unknown): PlatformAccountRef {
  const row = data(input, ['platform', 'namespace', 'id'])
  if (row.platform !== 'qq' || row.namespace !== 'global') throw invalid()
  return Object.freeze({ platform: 'qq', namespace: 'global', id: qqId(row.id) })
}
function binding(input: unknown): AgentBindingSnapshot {
  const row = data(input, ['source', 'id', 'revision', 'agentId', 'personaId', 'connectionId', 'target']), target = data(row.target, ['account', 'kind', 'id'])
  if (row.source !== 'configured' || target.kind !== 'group' && target.kind !== 'private') throw invalid()
  return Object.freeze({ source: row.source, id: token(row.id, 4096), revision: token(row.revision, 4096), agentId: token(row.agentId),
    personaId: token(row.personaId), connectionId: token(row.connectionId),
    target: Object.freeze({ account: account(target.account), kind: target.kind, id: qqId(target.id) }) })
}
function text(input: unknown, maximum: number): string {
  if (typeof input !== 'string' || !input.trim() || input.length > maximum || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(input)) throw invalid()
  return input
}
function operation(input: unknown): AgentQzoneOperation {
  const row = data(input, ['kind', 'text', 'postId', 'userId', 'visitId']), keys = Object.keys(row)
  if (row.kind === 'publish' && keys.length === 2 && Object.hasOwn(row, 'text')) return Object.freeze({ kind: row.kind, text: text(row.text, 2000) })
  if (row.kind === 'delete' && keys.length === 2 && Object.hasOwn(row, 'postId')) return Object.freeze({ kind: row.kind, postId: postId(row.postId) })
  if ((row.kind === 'visit' || row.kind === 'read') && keys.length === 2 && Object.hasOwn(row, 'userId')) {
    return Object.freeze({ kind: row.kind, userId: qqId(row.userId) })
  }
  if ((row.kind === 'like' || row.kind === 'comment') && keys.length === (row.kind === 'like' ? 4 : 5) &&
      ['userId', 'postId', 'visitId'].every(key => Object.hasOwn(row, key)) && (row.kind === 'comment' || !Object.hasOwn(row, 'text'))) {
    const selected = { userId: qqId(row.userId), postId: postId(row.postId), visitId: token(row.visitId) }
    return Object.freeze(row.kind === 'like' ? { kind: row.kind, ...selected } : { kind: row.kind, ...selected, text: text(row.text, 120) })
  }
  throw invalid()
}
function action(input: unknown, expectedAccount: PlatformAccountRef, connectionId: string): AgentQzoneAction {
  const row = data(input, ['version', 'binding', 'operation']), selected = binding(row.binding), op = operation(row.operation)
  if (row.version !== 1 || selected.target.account.id !== expectedAccount.id || selected.connectionId !== connectionId ||
      'userId' in op && op.userId === expectedAccount.id ||
      op.kind === 'read' && (selected.target.kind !== 'private' || selected.target.id !== op.userId) ||
      op.kind === 'visit' && selected.target.kind !== 'group' ||
      (op.kind === 'like' || op.kind === 'comment') && selected.target.kind === 'private' && selected.target.id !== op.userId) throw invalid()
  return Object.freeze({ version: 1, binding: selected, operation: op })
}
function nativeId(input: unknown): string | undefined {
  if (typeof input === 'number' && Number.isSafeInteger(input) && input > 0) return String(input)
  if (typeof input === 'string' && /^[1-9]\d{0,19}$/u.test(input)) return input
  return undefined
}
function envelope(input: unknown, selected: AgentQzoneAction): Record<string, unknown> {
  const row = data(input, ['status', 'retcode', 'data', 'echo', 'message', 'wording', 'self_id'])
  if (Object.hasOwn(row, 'self_id') && nativeId(row.self_id) !== selected.binding.target.account.id) throw invalid()
  return row
}
function nativeReceipt(input: unknown, selected: AgentQzoneAction): AgentQzoneReceipt {
  try {
    const marker = data(input)
    // Only the trusted transport creates this closed marker before native dispatch.
    if (marker.state === 'failed' && Object.keys(marker).length === 2 && Object.hasOwn(marker, 'code') &&
        (marker.code === 'qq_action_cancelled' || marker.code === 'onebot_disconnected')) return failed('qzone_native_rejected')
    const row = envelope(input, selected)
    if (row.status === 'failed' && typeof row.retcode === 'number' && Number.isSafeInteger(row.retcode) && row.retcode !== 0)
      return failed('qzone_native_rejected', platformCode(row.retcode) ? { nativeCode: row.retcode } : undefined)
    if (row.status !== 'ok' || row.retcode !== 0) return unknown()
    if (selected.operation.kind === 'publish') {
      const detail = data(row.data, ['tid'])
      return { state: 'confirmed', postId: postId(detail.tid) }
    }
    return Object.hasOwn(row, 'data') && row.data === null ? { state: 'confirmed' } : unknown()
  } catch { return unknown() }
}
function credentials(row: Record<string, unknown>): { cookies: string; token: string } {
  const detail = data(row.data, ['cookies', 'token'])
  if (row.status !== 'ok' || row.retcode !== 0 || typeof detail.cookies !== 'string' || !detail.cookies || detail.cookies.length > 16_384 ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(detail.cookies)) throw invalid()
  const value = detail.token
  if (!(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647 ||
        typeof value === 'string' && /^\d{1,10}$/u.test(value) && Number(value) <= 2_147_483_647)) throw invalid()
  // The token is supplied by this account's provider. Do not derive it from skey/p_skey.
  return { cookies: detail.cookies, token: String(value) }
}
function ownPost(input: unknown, selected: AgentQzoneAction): boolean {
  try {
    const row = data(input, ['account', 'agentId', 'postId', 'source']), ownAccount = account(row.account), source = binding(row.source)
    return selected.operation.kind === 'delete' && ownAccount.id === selected.binding.target.account.id &&
      row.postId === selected.operation.postId && row.agentId === selected.binding.agentId && source.agentId === row.agentId && source.target.account.id === ownAccount.id
  } catch { return false }
}
function status(row: Record<string, unknown>): 'confirmed' | 'rejected' | 'invalid' {
  const codes = ['ret', 'code', 'subcode'].filter(key => Object.hasOwn(row, key)).map(key => row[key])
  if (!codes.length || codes.some(value => typeof value !== 'number' || !Number.isSafeInteger(value))) return 'invalid'
  if (codes.every(value => value === 0)) return 'confirmed'
  return codes.every(value => value !== 0) ? 'rejected' : 'invalid'
}
function jsonBody(body: string, callback = false): Record<string, unknown> {
  let json = body.trim()
  if (callback) {
    const match = /^sharrpCallback\s*\(\s*(\{[\s\S]*\})\s*\)\s*;?$/u.exec(json)
    if (!match) throw invalid()
    json = match[1]!
  }
  return data(JSON.parse(json))
}
function feeds(input: unknown, userId: string): readonly AgentQzoneFeed[] {
  if (!Array.isArray(input) || types.isProxy(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > 8 ||
      Reflect.ownKeys(input).length !== input.length + 1) throw invalid()
  const result: AgentQzoneFeed[] = [], seen = new Set<string>()
  for (let index = 0; index < input.length; index++) {
    const field = Object.getOwnPropertyDescriptor(input, String(index))
    if (!field || !Object.hasOwn(field, 'value')) throw invalid()
    const row = data(field.value), id = postId(row.tid)
    if (['uin', 'hostuin', 'hostUin'].some(key => Object.hasOwn(row, key) && nativeId(row[key]) !== userId)) throw new QzoneFeedOwnerMismatch()
    if (seen.has(id)) throw invalid()
    seen.add(id)
    const content = row.content
    if (typeof content !== 'string' || content.length > 65_536 || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(content)) throw invalid()
    const created = row.created_time, fwd = row.fwd === undefined ? undefined : data(row.fwd), likes = fwd?.cntlike
    if (created !== undefined && (typeof created !== 'number' || !Number.isSafeInteger(created) || created < 0 || created > 8_640_000_000_000) ||
        likes !== undefined && (typeof likes !== 'number' || !Number.isSafeInteger(likes) || likes < 0)) throw invalid()
    const compact = content.slice(0, 200).replace(/[\uD800-\uDBFF]$/u, '')
    result.push(Object.freeze({ postId: id, userId, text: compact,
      ...(typeof created === 'number' && created > 0 ? { createdAt: created * 1000 } : {}), ...(typeof likes === 'number' ? { likes } : {}) }))
  }
  return Object.freeze(result)
}
function httpReceipt(body: string, httpStatus: number, op: Extract<AgentQzoneOperation, { kind: 'read' | 'visit' | 'like' | 'comment' }>): AgentQzoneReceipt {
  const readsFeed = op.kind === 'visit' || op.kind === 'read'
  try {
    const row = jsonBody(body, op.kind === 'comment'), decoded = status(row)
    if (Object.hasOwn(row, 'messageId') || Object.hasOwn(row, 'message_id')) throw invalid()
    if (decoded === 'rejected') {
      const nativeCode = [row.code, row.ret, row.subcode].find(platformCode)
      return failed('qzone_remote_rejected', { httpStatus, ...(nativeCode === undefined ? {} : { nativeCode }) })
    }
    if (decoded !== 'confirmed') throw invalid()
    if (readsFeed) return { state: 'confirmed', feeds: feeds(row.msglist, op.userId) }
    return { state: 'confirmed' }
  } catch (error) {
    return readsFeed ? failed(error instanceof QzoneFeedOwnerMismatch ? 'qzone_feed_owner_mismatch' : 'qzone_invalid_feed', { httpStatus }) : unknown()
  }
}
function checkSignal(input: unknown): AbortSignal {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== AbortSignal.prototype) throw invalid()
  for (const key of Reflect.ownKeys(input)) {
    const field = Object.getOwnPropertyDescriptor(input, key)
    if (typeof key === 'string' || !field || !Object.hasOwn(field, 'value') || types.isProxy(field.value)) throw invalid()
  }
  Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!.call(input)
  return input as AbortSignal
}
function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { clear(); reject(invalid()) }, clear = () => signal.removeEventListener('abort', abort)
    promise.then(value => { clear(); resolve(value) }, () => { clear(); reject(invalid()) })
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
  })
}
async function boundedBody(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) throw invalid()
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0, complete = false
  try {
    const declared = response.headers.get('content-length')
    if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > QQ_QZONE_MAX_RESPONSE_BYTES)) throw invalid()
    while (true) {
      const next = await wait(reader.read(), signal)
      if (next.done) { complete = true; break }
      size += next.value.byteLength
      if (size > QQ_QZONE_MAX_RESPONSE_BYTES) throw invalid()
      chunks.push(next.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } finally {
    // A hostile/unresponsive body must not extend the operation deadline while cancelling.
    if (!complete) void reader.cancel().catch(() => {})
    try { reader.releaseLock() } catch { /* A pending read is already fenced by the aborted signal. */ }
  }
}

/** Fixed-account native publication/deletion and bounded, fixed-domain Qzone HTTP interactions. */
export function createQqQzoneProvider(options: QqQzoneProviderOptions): AgentQzoneProvider {
  const configured = data(options, ['account', 'connectionId', 'isReady', 'callApi', 'readOwnPost', 'fetch']), configuredAccount = configured.account
  const expectedAccount = account(configuredAccount), connectionId = token(configured.connectionId)
  for (const key of ['isReady', 'callApi', 'readOwnPost', 'fetch']) if (configured[key] !== undefined && (typeof configured[key] !== 'function' || types.isProxy(configured[key]))) throw invalid()
  if (typeof configured.isReady !== 'function' || typeof configured.callApi !== 'function') throw invalid()
  const isReady = configured.isReady as () => boolean, callApi = configured.callApi as QqQzoneProviderOptions['callApi']
  const readOwnPost = configured.readOwnPost as QqQzoneProviderOptions['readOwnPost'], fetcher = (configured.fetch ?? globalThis.fetch) as typeof globalThis.fetch
  return Object.freeze({
    async execute(input: AgentQzoneAction, guard: AgentQzoneGuard): Promise<AgentQzoneReceipt> {
      let selected: AgentQzoneAction, parent: AbortSignal, check: () => boolean, ensure: () => Promise<void>, identity: string
      try {
        selected = action(input, expectedAccount, connectionId); identity = JSON.stringify(selected)
        const scope = data(guard, ['signal', 'isCurrent', 'ensureCurrent'])
        if (typeof scope.isCurrent !== 'function' || types.isProxy(scope.isCurrent) || typeof scope.ensureCurrent !== 'function' || types.isProxy(scope.ensureCurrent)) throw invalid()
        parent = checkSignal(scope.signal); check = scope.isCurrent as () => boolean; ensure = scope.ensureCurrent as () => Promise<void>
      } catch { return failed('qzone_invalid_request') }
      const cancel = new AbortController(), signal = AbortSignal.any([cancel.signal, parent]), deadline = Date.now() + QQ_QZONE_TIMEOUT_MS
      const current = () => {
        try { return !signal.aborted && isReady() === true && check() === true && account(configuredAccount).id === expectedAccount.id &&
          JSON.stringify(action(input, expectedAccount, connectionId)) === identity } catch { return false }
      }
      const ensureCurrent = async () => {
        if (!current()) throw invalid()
        await wait(Promise.resolve().then(() => ensure()), signal)
        if (!current()) throw invalid()
      }
      if (!current()) return failed('qzone_source_unavailable')
      const timer = setTimeout(() => cancel.abort(new DOMException('QQ 空间操作超时', 'TimeoutError')), QQ_QZONE_TIMEOUT_MS)
      const watch = setInterval(() => { if (!current()) cancel.abort() }, 25)
      let dispatched = false
      const native = async (name: QqQzoneApiAction, params: Record<string, unknown>) => {
        await ensureCurrent()
        return wait(withDeliveryGuard(current, () => {
          if (!current()) throw invalid()
          if (name !== 'get_credentials') dispatched = true
          return callApi(name, Object.freeze(params), Object.freeze({ signal, isCurrent: current, ensureCurrent, timeoutMs: Math.max(1, deadline - Date.now()) }))
        }), signal)
      }
      try {
        await ensureCurrent()
        const op = selected.operation
        if (op.kind === 'publish') return nativeReceipt(await native('send_qzone_msg', { content: op.text }), selected)
        if (op.kind === 'delete') {
          if (!readOwnPost || !ownPost(await wait(Promise.resolve().then(() => readOwnPost(expectedAccount, op.postId)), signal), selected)) return failed('qzone_ownership_unavailable')
          await ensureCurrent()
          return nativeReceipt(await native('delete_qzone_msg', { tid: op.postId }), selected)
        }
        let secret
        const credentialReply = await native('get_credentials', { domain: 'qzone.qq.com' })
        try {
          const row = envelope(credentialReply, selected)
          if (row.status === 'failed' && platformCode(row.retcode) && row.retcode !== 0)
            return failed('qzone_credentials_rejected', { nativeCode: row.retcode })
          secret = credentials(row)
        } catch { return failed('qzone_credentials_invalid') }
        await ensureCurrent()
        const readsFeed = op.kind === 'read' || op.kind === 'visit'
        const url = new URL(endpoints[op.kind === 'read' ? 'visit' : op.kind], origin), form = new URLSearchParams()
        url.searchParams.set('g_tk', secret.token)
        if (readsFeed) {
          // This feed endpoint selects the space by uin. The Bot's identity comes from its cookie.
          for (const [key, value] of Object.entries({ uin: op.userId, ftype: '0', sort: '0', pos: '0', num: '8', replynum: '0',
            code_version: '1', format: 'json', need_private_comment: '0' })) url.searchParams.set(key, value)
        } else if (op.kind === 'like') {
          for (const [key, value] of Object.entries({ qzreferrer: `${origin}/${expectedAccount.id}/main`, opuin: expectedAccount.id, unikey: op.postId,
            curkey: `${origin}/${op.userId}/mood/${op.postId}`, appid: '311', typename: '0', abstime: '0', fid: op.postId, active: '0', fupdatever: '0', format: 'json' })) form.set(key, value)
        } else {
          for (const [key, value] of Object.entries({ uin: expectedAccount.id, hostuin: op.userId, tid: op.postId, topicid: op.postId, commentid: '', content: op.text,
            feedstype: '100', to_uin: '0', replyid: '0', ver: '1', face: '0', fontsize: '', richval: '', weibo: '0', need_feed: '0', appid: '311',
            cb: 'sharrpCallback', code_version: '1', format: 'fs', inCharset: 'utf-8', outCharset: 'utf-8' })) form.set(key, value)
        }
        const httpSignal = AbortSignal.any([signal, AbortSignal.timeout(QQ_QZONE_HTTP_TIMEOUT_MS)])
        let response: Response | undefined, body: string
        await ensureCurrent()
        try {
          response = await wait(withDeliveryGuard(current, () => {
            if (!current()) throw invalid()
            if (!readsFeed) dispatched = true
            return fetcher(url.href, { method: readsFeed ? 'GET' : 'POST', redirect: 'error', signal: httpSignal,
              headers: { Cookie: secret.cookies, ...(readsFeed ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }) },
              ...(readsFeed ? {} : { body: form.toString() }) })
          }), httpSignal)
          if (response.redirected || !response.ok) {
            void response.body?.cancel().catch(() => {})
            return readsFeed ? failed(response.redirected ? 'qzone_http_redirected' : 'qzone_http_rejected', { httpStatus: response.status }) : unknown()
          }
          body = await boundedBody(response, httpSignal)
        } catch (error) {
          if (dispatched) return unknown()
          const timeout = timedOut(httpSignal) || error instanceof DOMException && error.name === 'TimeoutError'
          if (signal.aborted && !timeout) return failed('qzone_cancelled')
          const code = response ? timeout ? 'qzone_http_body_timeout' : 'qzone_http_body_failed'
            : timeout ? 'qzone_http_headers_timeout' : 'qzone_http_transport_error'
          return failed(code, response ? { httpStatus: response.status } : undefined)
        }
        if (readsFeed) await ensureCurrent()
        return httpReceipt(body, response.status, op)
      } catch {
        return dispatched ? unknown() : failed(timedOut(signal) ? 'qzone_provider_timeout' : signal.aborted ? 'qzone_cancelled' : 'qzone_provider_unavailable')
      }
      finally { clearTimeout(timer); clearInterval(watch); cancel.abort() }
    },
  })
}
