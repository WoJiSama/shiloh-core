import { types } from 'node:util'
import type { AgentBindingSnapshot, PlatformUserRef } from '../../../contracts/agentBinding.js'
import { AGENT_GIFT_CATALOG, type AgentGiftAction, type AgentGiftPlan, type AgentGiftReceipt, type AgentGiftResult, type AgentGiftType } from '../../../contracts/agentQqGift.js'
import { isPlatformAccount, samePlatformNamespace } from '../../runtime/domain/agentBindings.js'

export const giftInvalid = () => new Error('Gift display request unavailable')
export function giftData(input: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw giftInvalid()
  const row: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(input)) {
    const field = Object.getOwnPropertyDescriptor(input, key)
    if (typeof key !== 'string' || keys && !keys.includes(key) || !field || !Object.hasOwn(field, 'value')) throw giftInvalid()
    row[key] = field.value
  }
  return row
}
export function giftToken(input: unknown, maximum = 128): string {
  if (typeof input !== 'string' || !input.length || input.length > maximum || input !== input.trim() || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(input)) throw giftInvalid()
  return input
}
export function giftUser(input: unknown): Readonly<PlatformUserRef> {
  const row = giftData(input, ['platform', 'namespace', 'id'])
  const user = { platform: giftToken(row.platform, 64), namespace: giftToken(row.namespace), id: giftToken(row.id) }
  if (!isPlatformAccount(user)) throw giftInvalid()
  return Object.freeze(user)
}
export function giftBinding(input: unknown): Readonly<AgentBindingSnapshot> {
  const row = giftData(input, ['source', 'id', 'revision', 'agentId', 'personaId', 'connectionId', 'target']), target = giftData(row.target, ['account', 'kind', 'id'])
  if (row.source !== 'configured' && row.source !== 'legacy' || target.kind !== 'group') throw giftInvalid()
  return Object.freeze({ source: row.source, id: giftToken(row.id, 4096), revision: giftToken(row.revision, 4096),
    agentId: giftToken(row.agentId), personaId: giftToken(row.personaId), connectionId: giftToken(row.connectionId),
    target: Object.freeze({ account: giftUser(target.account), kind: 'group', id: giftToken(target.id) }) })
}
export function validateAgentGiftPlan(input: unknown): Readonly<AgentGiftPlan> {
  const row = giftData(input, ['version', 'recipient', 'giftType'])
  if (row.version !== 1 || typeof row.giftType !== 'string' || !Object.hasOwn(AGENT_GIFT_CATALOG, row.giftType)) throw giftInvalid()
  return Object.freeze({ version: 1, recipient: giftUser(row.recipient), giftType: row.giftType as AgentGiftType })
}
export function validateAgentGiftAction(input: unknown): Readonly<AgentGiftAction> {
  const row = giftData(input, ['version', 'kind', 'binding', 'source', 'plan']), source = giftData(row.source, ['messageId', 'author'])
  if (row.version !== 1 || row.kind !== 'qq.gift-display') throw giftInvalid()
  const binding = giftBinding(row.binding), plan = validateAgentGiftPlan(row.plan), author = giftUser(source.author), messageId = giftToken(source.messageId, 240)
  if (messageId === '0' || !samePlatformNamespace(author, binding.target.account) || !samePlatformNamespace(plan.recipient, binding.target.account) || author.id === binding.target.account.id) throw giftInvalid()
  return Object.freeze({ version: 1, kind: row.kind, binding, source: Object.freeze({ messageId, author }), plan })
}
export function normalizeAgentGiftReceipt(input: unknown): AgentGiftReceipt {
  try {
    const row = giftData(input, ['state', 'evidence', 'code'])
    if (row.state === 'confirmed' && row.evidence === 'packet-accepted' && Object.keys(row).length === 2) return Object.freeze({ state: 'confirmed', evidence: 'packet-accepted' })
    if (row.state === 'failed' && row.evidence === undefined && (row.code === undefined || typeof row.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/u.test(row.code))) return Object.freeze({ state: 'failed', ...(row.code === undefined ? {} : { code: row.code as string }) })
    if (row.state === 'unknown' && Object.keys(row).length === 1) return Object.freeze({ state: 'unknown' })
  } catch { /* Native/host data cannot manufacture confirmation. */ }
  return Object.freeze({ state: 'unknown' })
}
export function normalizeAgentGiftResult(input: unknown): AgentGiftResult {
  try {
    const row = giftData(input, ['state', 'completed', 'code'])
    if (!['confirmed', 'failed', 'unknown'].includes(row.state as string) || row.completed !== 0 && row.completed !== 1 || row.state === 'confirmed' && row.completed !== 1 || row.code !== undefined && (typeof row.code !== 'string' || !/^gift_[a-z_]{1,65}$/u.test(row.code))) throw giftInvalid()
    return Object.freeze({ state: row.state as AgentGiftResult['state'], completed: row.completed, ...(row.code === undefined ? {} : { code: row.code as string }) })
  } catch { return Object.freeze({ state: 'unknown', completed: 0, code: 'gift_invalid_result' }) }
}
