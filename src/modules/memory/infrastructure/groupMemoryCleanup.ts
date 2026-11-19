import { createHash } from 'node:crypto'
import { types } from 'node:util'
import type { AgentConversationScope } from '../../../contracts/agentBinding.js'
import type { AgentGroupMemoryCleanupGuard, AgentGroupMemoryPurgeSubject, GroupMemoryState } from '../../../contracts/groupMemory.js'
import { agentPersonaScopeId, conversationAddressKey, isConversationAddress, isPlatformAccount, isPlatformIdentifier, platformAccountKey } from '../../runtime/domain/agentBindings.js'

export const GROUP_CLEANUP_MAX_SELECTORS = 4096
export const GROUP_CLEANUP_MAX_BYTES = 2 * 1024 * 1024
const fail = (): never => { throw new Error('群记忆清理权限、水位或存储不可用') }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const identifier = /^[a-f0-9]{64}$/u
export interface GroupCleanupSelector {
  readonly id: string
  readonly agent: string
  readonly account: string
  readonly subject: string
  readonly target?: string
  readonly through: number
}
export interface GroupCleanupFences { readonly version: 1; readonly entries: GroupCleanupSelector[] }
function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) fail()
  return value as Record<string, unknown>
}
export function groupCleanupSelector(input: AgentGroupMemoryPurgeSubject): GroupCleanupSelector {
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
export function parseGroupCleanup(value: string | null): GroupCleanupFences {
  if (value === null) return { version: 1, entries: [] }
  if (value.length > GROUP_CLEANUP_MAX_BYTES) fail()
  const root = object(JSON.parse(value), ['version', 'entries'])
  if (root.version !== 1 || !Array.isArray(root.entries) || root.entries.length > GROUP_CLEANUP_MAX_SELECTORS) fail()
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
export function groupCleanupMatchesScope(scope: AgentConversationScope, selector: GroupCleanupSelector): boolean {
  return digest(scope.agentId) === selector.agent && digest(platformAccountKey(scope.target.account)) === selector.account &&
    (!selector.target || digest(conversationAddressKey(scope.target)) === selector.target)
}
export function groupCleanupAllows(scope: AgentConversationScope, row: { readonly authorId: string; readonly at: number }, fences: GroupCleanupFences): boolean {
  return row.at > (effectiveCuts(scope, fences).get(digest(row.authorId)) ?? -1)
}
function effectiveCuts(scope: AgentConversationScope, fences: GroupCleanupFences): Map<string, number> {
  const cuts = new Map<string, number>()
  const agent = digest(scope.agentId), account = digest(platformAccountKey(scope.target.account)), target = digest(conversationAddressKey(scope.target))
  for (const selector of fences.entries) if (selector.agent === agent && selector.account === account && (!selector.target || selector.target === target)) {
    cuts.set(selector.subject, Math.max(cuts.get(selector.subject) ?? -1, selector.through))
  }
  return cuts
}
export function filterGroupCleanupRows<T extends { readonly authorId: string; readonly at: number }>(scope: AgentConversationScope, rows: readonly T[], fences: GroupCleanupFences): T[] {
  const cuts = effectiveCuts(scope, fences)
  if (!cuts.size) return [...rows]
  return rows.filter(row => row.at > (cuts.get(digest(row.authorId)) ?? -1))
}
export function groupCleanupCurrent(guard: AgentGroupMemoryCleanupGuard): boolean {
  try { return !guard.signal.aborted && guard.isCurrent() } catch { return false }
}
export async function ensureGroupCleanup(guard: AgentGroupMemoryCleanupGuard): Promise<void> {
  if (!guard || !(guard.signal instanceof AbortSignal) || typeof guard.ensureCurrent !== 'function' || !groupCleanupCurrent(guard)) fail()
  await new Promise<void>((resolve, reject) => {
    const abort = () => { guard.signal.removeEventListener('abort', abort); reject(new Error('群记忆清理已取消')) }
    guard.signal.addEventListener('abort', abort, { once: true })
    Promise.resolve().then(() => { if (!groupCleanupCurrent(guard)) fail(); return guard.ensureCurrent() }).then(() => {
      guard.signal.removeEventListener('abort', abort); resolve()
    }, error => { guard.signal.removeEventListener('abort', abort); reject(error) })
  })
  if (!groupCleanupCurrent(guard)) fail()
}

/** Only effective subject cutoffs affect aggregate generations, so an older
 * replay or an equivalent narrow selector cannot revoke newly rebuilt output. */
export function groupCleanupToken(scope: AgentConversationScope, fences: GroupCleanupFences): string | undefined {
  return token(effectiveCuts(scope, fences))
}
function token(cuts: Map<string, number>): string | undefined {
  if (!cuts.size) return undefined
  return digest([...cuts.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
}
/** Facts can mix every job input even when their retained source names a different
 * author. Old generations are removed conservatively; original rows retain their
 * exact author cutoff. Shared teaching follows its recorded originating Agent. */
export function filterGroupMemoryState(state: GroupMemoryState, fences: GroupCleanupFences): GroupMemoryState {
  const scopes = new Map(state.agents.map(agent => {
    const cuts = effectiveCuts({ agentId: agent.agentId, target: state.target }, fences)
    return [agent.agentId, { token: token(cuts), allows: (row: { authorId: string; at: number }) => row.at > (cuts.get(digest(row.authorId)) ?? -1) }]
  }))
  const entryAllowed = (scope: NonNullable<ReturnType<typeof scopes.get>>, entry: GroupMemoryState['entries'][number]) => {
    if (entry.cleanupToken !== scope.token || !scope.allows(entry.source)) return false
    const participants = [...entry.targetUserIds, ...entry.relatedUserIds, ...(entry.ownerId ? [entry.ownerId] : [])]
    return participants.every(authorId => scope.allows({ authorId, at: entry.source.at }))
  }
  const origins = new Map(state.agents.map(agent => [agentPersonaScopeId(agent.agentId), scopes.get(agent.agentId)!]))
  return { ...state,
    agents: state.agents.map(agent => {
      const scope = scopes.get(agent.agentId)!
      return { ...agent,
        records: agent.records.filter(scope.allows),
        jobs: agent.jobs.filter(job => job.cleanupToken === scope.token && job.messages.every(scope.allows)),
        entries: agent.entries.filter(entry => entryAllowed(scope, entry)),
      }
    }),
    entries: state.entries.filter(entry => { const scope = origins.get(entry.persona.personaId); return scope !== undefined && entryAllowed(scope, entry) }),
  }
}
export function groupMemoryContent(state: GroupMemoryState): number {
  return state.entries.length + state.agents.reduce((count, agent) => count + agent.records.length + agent.jobs.length + agent.entries.length, 0)
}
/** Another Agent's clear/recall barriers and acknowledgement history remain
 * meaningful even when cleanup removes the last retained source text. */
export function groupMemoryRetained(state: GroupMemoryState): boolean {
  return groupMemoryContent(state) > 0 || state.agents.length > 1 || state.deletedSources.length > 0 ||
    (state.teachingDeletedSources?.length ?? 0) > 0 || state.teachingClearedAt !== undefined || state.agents.some(agent =>
      agent.seen.length > 0 || agent.consensusDone.length > 0 || agent.teachingDone.length > 0 || agent.deletedSources.length > 0 || agent.clearedAt !== undefined)
}
