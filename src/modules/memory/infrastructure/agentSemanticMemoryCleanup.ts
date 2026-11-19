import { createHash } from 'node:crypto'
import { types } from 'node:util'
import type { AgentConversationScope } from '../../../contracts/agentBinding.js'
import type { AgentSemanticMemoryCleanupGuard, AgentSemanticMemoryPurgeSubject } from '../../../contracts/semanticMemory.js'
import { conversationAddressKey, isConversationAddress, isPlatformAccount, isPlatformIdentifier, platformAccountKey } from '../../runtime/domain/agentBindings.js'

export const SEMANTIC_CLEANUP_MAX_SELECTORS = 4096
export const SEMANTIC_CLEANUP_MAX_BYTES = 2 * 1024 * 1024
const fail = (): never => { throw new Error('语义记忆清理权限、水位或存储不可用') }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const identifier = /^[a-f0-9]{64}$/u
export interface SemanticCleanupSelector {
  readonly id: string
  readonly agent: string
  readonly account: string
  readonly subject: string
  readonly target?: string
  readonly through: number
}
export interface SemanticCleanupFences { readonly version: 1; readonly entries: SemanticCleanupSelector[] }
function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) fail()
  return value as Record<string, unknown>
}
export function semanticCleanupSelector(input: AgentSemanticMemoryPurgeSubject): SemanticCleanupSelector {
  const raw = object(input, ['account', 'agentId', 'subjectId', 'target', 'through'])
  object(raw.account, ['platform', 'namespace', 'id'])
  if (!isPlatformAccount(input.account) || typeof input.agentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input.agentId) ||
      !isPlatformIdentifier(input.subjectId) || input.subjectId === '0' || !Number.isSafeInteger(input.through) || input.through < 0) fail()
  if (input.target) {
    object(input.target, ['account', 'kind', 'id']); object(input.target.account, ['platform', 'namespace', 'id'])
    if (!isConversationAddress(input.target) || platformAccountKey(input.target.account) !== platformAccountKey(input.account)) fail()
  } else if (raw.target !== undefined) fail()
  const selected = { agent: digest(input.agentId), account: digest(platformAccountKey(input.account)), subject: digest(input.subjectId),
    ...(input.target ? { target: digest(conversationAddressKey(input.target)) } : {}) }
  return { ...selected, id: digest(selected), through: input.through }
}
export function parseSemanticCleanup(value: string | null): SemanticCleanupFences {
  if (value === null) return { version: 1, entries: [] }
  if (value.length > SEMANTIC_CLEANUP_MAX_BYTES) fail()
  const root = object(JSON.parse(value), ['version', 'entries'])
  if (root.version !== 1 || !Array.isArray(root.entries) || root.entries.length > SEMANTIC_CLEANUP_MAX_SELECTORS) fail()
  const entries = (root.entries as unknown[]).map(value => {
    const raw = object(value, ['id', 'agent', 'account', 'subject', 'target', 'through'])
    if (![raw.id, raw.agent, raw.account, raw.subject].every(value => typeof value === 'string' && identifier.test(value)) ||
        raw.target !== undefined && (typeof raw.target !== 'string' || !identifier.test(raw.target)) || !Number.isSafeInteger(raw.through) || Number(raw.through) < 0) fail()
    const selector = { agent: String(raw.agent), account: String(raw.account), subject: String(raw.subject), ...(raw.target === undefined ? {} : { target: String(raw.target) }) }
    if (digest(selector) !== raw.id) fail()
    return { ...selector, id: String(raw.id), through: Number(raw.through) }
  })
  if (new Set(entries.map(row => row.id)).size !== entries.length) fail()
  return { version: 1, entries }
}
export function semanticCleanupMatchesScope(scope: AgentConversationScope, selector: SemanticCleanupSelector): boolean {
  return digest(scope.agentId) === selector.agent && digest(platformAccountKey(scope.target.account)) === selector.account &&
    (!selector.target || digest(conversationAddressKey(scope.target)) === selector.target)
}
export function semanticCleanupAllows(scope: AgentConversationScope, row: { readonly authorId: string; readonly at: number }, fences: SemanticCleanupFences): boolean {
  const matching = fences.entries.filter(selector => semanticCleanupMatchesScope(scope, selector))
  return !matching.some(selector => digest(row.authorId) === selector.subject && row.at <= selector.through)
}
export function filterSemanticCleanupRows<T extends { readonly authorId: string; readonly at: number }>(scope: AgentConversationScope, rows: readonly T[], fences: SemanticCleanupFences): T[] {
  const cuts = new Map<string, number>()
  for (const selector of fences.entries) if (semanticCleanupMatchesScope(scope, selector)) cuts.set(selector.subject, Math.max(cuts.get(selector.subject) ?? -1, selector.through))
  if (!cuts.size) return [...rows]
  return rows.filter(row => row.at > (cuts.get(digest(row.authorId)) ?? -1))
}
export function semanticCleanupCurrent(guard: AgentSemanticMemoryCleanupGuard): boolean {
  try { return !guard.signal.aborted && guard.isCurrent() } catch { return false }
}
export async function ensureSemanticCleanup(guard: AgentSemanticMemoryCleanupGuard): Promise<void> {
  if (!guard || !(guard.signal instanceof AbortSignal) || typeof guard.ensureCurrent !== 'function' || !semanticCleanupCurrent(guard)) fail()
  await new Promise<void>((resolve, reject) => {
    const abort = () => { guard.signal.removeEventListener('abort', abort); reject(new Error('语义记忆清理已取消')) }
    guard.signal.addEventListener('abort', abort, { once: true })
    Promise.resolve().then(() => { if (!semanticCleanupCurrent(guard)) fail(); return guard.ensureCurrent() }).then(() => {
      guard.signal.removeEventListener('abort', abort); resolve()
    }, error => { guard.signal.removeEventListener('abort', abort); reject(error) })
  })
  if (!semanticCleanupCurrent(guard)) fail()
}
