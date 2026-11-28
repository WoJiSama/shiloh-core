import { types } from 'node:util'
import type { AgentBindingSnapshot, PlatformAccountRef } from '../../../contracts/agentBinding.js'
import type { AgentQzoneAction, AgentQzoneFeed, AgentQzoneLimits, AgentQzoneOperation, AgentQzoneOwnPost, AgentQzoneReceipt, AgentQzoneVisit } from '../../../contracts/agentQzone.js'
import { redactInternalStatusLeaks } from '../../conversation/domain/internalStatusLeak.js'

const invalid = () => new Error('qzone_invalid_request')
const receiptFailureSteps = new Map(Object.entries({
  qzone_invalid_request: 'qzone_request',
  qzone_source_unavailable: 'authorization',
  qzone_ownership_unavailable: 'qzone_ownership',
  qzone_native_rejected: 'qzone_native',
  qzone_credentials_rejected: 'qzone_credentials',
  qzone_credentials_invalid: 'qzone_credentials',
  qzone_http_transport_error: 'response_headers',
  qzone_http_headers_timeout: 'response_headers',
  qzone_http_rejected: 'response_headers',
  qzone_http_redirected: 'response_headers',
  qzone_http_body_timeout: 'response_body',
  qzone_http_body_failed: 'response_body',
  qzone_remote_rejected: 'response_validation',
  qzone_invalid_feed: 'response_validation',
  qzone_feed_owner_mismatch: 'response_validation',
  qzone_invalid_response: 'response_validation',
  qzone_cancelled: 'qzone_provider',
  qzone_provider_timeout: 'qzone_provider',
  qzone_provider_unavailable: 'qzone_provider',
}))
export const qzoneReceiptFailureStep = (code: string) => receiptFailureSteps.get(code)
const safeResultCodes = new Set(['qzone_invalid_request', 'qzone_source_unavailable', 'qzone_claim_failed', 'qzone_already_claimed',
  'qzone_disabled', 'qzone_daily_limit', 'qzone_visit_cooldown', 'qzone_claim_conflict', 'qzone_already_unknown', 'qzone_already_confirmed',
  'qzone_already_failed', 'qzone_ledger_unavailable', 'qzone_outcome_unknown', 'qzone_settlement_failed', 'qzone_rejected', 'qzone_invalid_result'])
export function normalizeAgentQzoneCode(input: unknown): string {
  return typeof input === 'string' && (safeResultCodes.has(input) || receiptFailureSteps.has(input)) ? input : 'qzone_rejected'
}
export function qzoneData(input: unknown, allowedKeys?: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw invalid()
  const row: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(input)) {
    const field = Object.getOwnPropertyDescriptor(input, key)
    if (typeof key !== 'string' || allowedKeys && !allowedKeys.includes(key) || !field || !Object.hasOwn(field, 'value')) throw invalid()
    row[key] = field.value
  }
  return row
}
export function qzoneToken(input: unknown, maximum = 128): string {
  if (typeof input !== 'string' || !input.length || input.length > maximum || input.trim() !== input || /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(input)) throw invalid()
  return input
}
export function qzoneArray(input: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(input) || types.isProxy(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > maximum || Reflect.ownKeys(input).length !== input.length + 1) throw invalid()
  return Array.from({ length: input.length }, (_, index) => {
    const field = Object.getOwnPropertyDescriptor(input, String(index))
    if (!field || !Object.hasOwn(field, 'value')) throw invalid()
    return field.value
  })
}
export function validateAgentQzoneAccount(input: unknown): Readonly<PlatformAccountRef> {
  const row = qzoneData(input, ['platform', 'namespace', 'id'])
  return Object.freeze({ platform: qzoneToken(row.platform, 64), namespace: qzoneToken(row.namespace), id: qzoneToken(row.id) })
}
export function validateAgentQzoneBinding(input: unknown): Readonly<AgentBindingSnapshot> {
  const row = qzoneData(input, ['source', 'id', 'revision', 'agentId', 'personaId', 'connectionId', 'target'])
  const target = qzoneData(row.target, ['account', 'kind', 'id'])
  if (row.source !== 'configured' || target.kind !== 'group' && target.kind !== 'private') throw invalid()
  return Object.freeze({ source: row.source, id: qzoneToken(row.id, 4096), revision: qzoneToken(row.revision, 4096),
    agentId: qzoneToken(row.agentId), personaId: qzoneToken(row.personaId), connectionId: qzoneToken(row.connectionId),
    target: Object.freeze({ account: validateAgentQzoneAccount(target.account), kind: target.kind, id: qzoneToken(target.id) }) })
}
/** The 120 limit counts UTF-16 units, as in the plugin. Avoid emitting a cut surrogate pair. */
export function prepareAgentQzoneText(input: unknown, kind: 'publish' | 'comment'): string {
  if (typeof input !== 'string' || input.length > 16_384 || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(input)) throw invalid()
  let text = input.trim()
  if (kind === 'comment') text = text.slice(0, 120).replace(/[\uD800-\uDBFF]$/u, '')
  if (!text || kind === 'publish' && text.length > 2000) throw invalid()
  const clean = redactInternalStatusLeaks(text)
  if (clean.heavy || !clean.text.trim()) throw invalid()
  return clean.text
}
export function validateAgentQzoneOperation(input: unknown): Readonly<AgentQzoneOperation> {
  const row = qzoneData(input, ['kind', 'text', 'postId', 'userId', 'visitId'])
  const keys: Record<string, readonly string[]> = { publish: ['kind', 'text'], delete: ['kind', 'postId'], read: ['kind', 'userId'], visit: ['kind', 'userId'],
    like: ['kind', 'userId', 'postId', 'visitId'], comment: ['kind', 'userId', 'postId', 'visitId', 'text'] }
  if (typeof row.kind !== 'string' || !Object.hasOwn(keys, row.kind)) throw invalid()
  const allowed = keys[row.kind]!
  if (Object.keys(row).length !== allowed.length || Object.keys(row).some(key => !allowed.includes(key))) throw invalid()
  if (row.kind === 'publish') return Object.freeze({ kind: row.kind, text: prepareAgentQzoneText(row.text, 'publish') })
  if (row.kind === 'delete') return Object.freeze({ kind: row.kind, postId: qzoneToken(row.postId) })
  if (row.kind === 'visit' || row.kind === 'read') return Object.freeze({ kind: row.kind, userId: qzoneToken(row.userId) })
  const effect = { userId: qzoneToken(row.userId), postId: qzoneToken(row.postId), visitId: qzoneToken(row.visitId) }
  if (row.kind === 'like') return Object.freeze({ kind: row.kind, ...effect })
  return Object.freeze({ kind: 'comment', ...effect, text: prepareAgentQzoneText(row.text, 'comment') })
}
export function validateAgentQzoneAction(input: unknown): Readonly<AgentQzoneAction> {
  const row = qzoneData(input, ['version', 'binding', 'operation'])
  if (row.version !== 1) throw invalid()
  const binding = validateAgentQzoneBinding(row.binding), operation = validateAgentQzoneOperation(row.operation)
  const target = binding.target
  if (operation.kind === 'read' && (target.kind !== 'private' || target.id !== operation.userId) ||
      operation.kind === 'visit' && target.kind !== 'group' ||
      (operation.kind === 'like' || operation.kind === 'comment') && target.kind === 'private' && target.id !== operation.userId) throw invalid()
  return Object.freeze({ version: 1, binding, operation })
}
export function normalizeAgentQzoneLimits(input: unknown = {}): Readonly<AgentQzoneLimits> {
  const row = qzoneData(input, ['enabled', 'visitCooldownMs', 'minAffinity', 'maxLikesPerDay', 'maxCommentsPerDay'])
  if (row.enabled !== undefined && typeof row.enabled !== 'boolean') throw invalid()
  const number = (key: string, fallback: number, min: number, max: number) => {
    const value = row[key] === undefined ? fallback : row[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid()
    return Math.min(max, Math.max(min, Math.floor(value)))
  }
  return Object.freeze({ enabled: row.enabled === true, visitCooldownMs: number('visitCooldownMs', 7_200_000, 1_800_000, 86_400_000),
    minAffinity: number('minAffinity', 55, 0, 100), maxLikesPerDay: number('maxLikesPerDay', 6, 0, 50), maxCommentsPerDay: number('maxCommentsPerDay', 3, 0, 20) })
}
export function validateAgentQzoneOwnPost(input: unknown): Readonly<AgentQzoneOwnPost> {
  const row = qzoneData(input, ['account', 'agentId', 'postId', 'source']), account = validateAgentQzoneAccount(row.account), source = validateAgentQzoneBinding(row.source), agentId = qzoneToken(row.agentId)
  if (agentId !== source.agentId || JSON.stringify(account) !== JSON.stringify(source.target.account)) throw invalid()
  return Object.freeze({ account, source, agentId, postId: qzoneToken(row.postId) })
}
export function validateAgentQzoneVisit(input: unknown): Readonly<AgentQzoneVisit> {
  const row = qzoneData(input, ['id', 'binding', 'sourceId', 'userId', 'postIds', 'observedAt', 'expiresAt']), binding = validateAgentQzoneBinding(row.binding)
  const postIds = qzoneArray(row.postIds, 8).map(value => qzoneToken(value))
  if (binding.target.kind === 'private' && binding.target.id !== row.userId || new Set(postIds).size !== postIds.length || typeof row.observedAt !== 'number' || !Number.isSafeInteger(row.observedAt) || row.observedAt <= 0 ||
      typeof row.expiresAt !== 'number' || !Number.isSafeInteger(row.expiresAt) || row.expiresAt <= row.observedAt || row.expiresAt > row.observedAt + 900_000) throw invalid()
  return Object.freeze({ id: qzoneToken(row.id), binding, sourceId: qzoneToken(row.sourceId, 4096), userId: qzoneToken(row.userId), postIds: Object.freeze(postIds), observedAt: row.observedAt, expiresAt: row.expiresAt })
}
export function normalizeAgentQzoneReceipt(input: unknown, operation: AgentQzoneOperation): AgentQzoneReceipt {
  const readsFeed = operation.kind === 'visit' || operation.kind === 'read'
  try {
    const row = qzoneData(input, ['state', 'postId', 'feeds', 'code', 'httpStatus', 'nativeCode'])
    if (row.state === 'unknown' && Object.keys(row).length === 1) return Object.freeze({ state: 'unknown' })
    if (row.state === 'failed' && !Object.hasOwn(row, 'postId') && !Object.hasOwn(row, 'feeds') &&
        typeof row.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/u.test(row.code)) {
      if (!receiptFailureSteps.has(row.code)) return Object.freeze({ state: 'failed', code: 'qzone_rejected' })
      const { httpStatus, nativeCode } = row
      return Object.freeze({ state: 'failed', code: row.code,
        ...(typeof httpStatus === 'number' && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}),
        ...(typeof nativeCode === 'number' && Number.isInteger(nativeCode) && Math.abs(nativeCode) <= 2_147_483_647 ? { nativeCode } : {}) })
    }
    if (row.state !== 'confirmed') throw invalid()
    if (operation.kind === 'publish' && Object.keys(row).length === 2 && Object.hasOwn(row, 'postId')) return Object.freeze({ state: 'confirmed', postId: qzoneToken(row.postId) })
    if (readsFeed && Object.keys(row).length === 2 && Object.hasOwn(row, 'feeds')) {
      const feeds: AgentQzoneFeed[] = qzoneArray(row.feeds, 8).map(value => {
        const feed = qzoneData(value, ['postId', 'userId', 'text', 'createdAt', 'likes'])
        if (feed.userId !== operation.userId || typeof feed.text !== 'string' || feed.text.length > 200 || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(feed.text) ||
            feed.createdAt !== undefined && (typeof feed.createdAt !== 'number' || !Number.isSafeInteger(feed.createdAt) || feed.createdAt <= 0) ||
            feed.likes !== undefined && (typeof feed.likes !== 'number' || !Number.isSafeInteger(feed.likes) || feed.likes < 0)) throw invalid()
        return Object.freeze({ postId: qzoneToken(feed.postId), userId: operation.userId, text: feed.text,
          ...(feed.createdAt === undefined ? {} : { createdAt: feed.createdAt as number }), ...(feed.likes === undefined ? {} : { likes: feed.likes as number }) })
      })
      if (new Set(feeds.map(feed => feed.postId)).size !== feeds.length) throw invalid()
      return Object.freeze({ state: 'confirmed', feeds: Object.freeze(feeds) })
    }
    if (operation.kind !== 'publish' && !readsFeed && Object.keys(row).length === 1) return Object.freeze({ state: 'confirmed' })
    throw invalid()
  } catch { return Object.freeze(readsFeed ? { state: 'failed', code: 'qzone_invalid_response' } : { state: 'unknown' }) }
}
