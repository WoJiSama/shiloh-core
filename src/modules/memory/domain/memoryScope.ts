import type { MemoryPersona } from '../../../contracts/memoryEngine.js'
import type { AgentConversationScope } from '../../../contracts/agentBinding.js'
import { agentConversationKey, decodeAgentConversationKey } from '../../runtime/domain/agentBindings.js'

const PREFIX = 'agent:'

export function agentMemoryScope(scope: AgentConversationScope): string {
  return PREFIX + encodeURIComponent(agentConversationKey(scope))
}

export function decodeMemoryScope(value: unknown) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return null
  try {
    return decodeAgentConversationKey(decodeURIComponent(value.slice(PREFIX.length)))
  } catch {
    return null
  }
}

/** A missing group is a private conversation, never the shared "undefined" group. */
export function conversationMemoryScope(groupId: unknown, userId: unknown, identity?: Pick<MemoryPersona, 'botId' | 'personaId' | 'binding'>): string | undefined {
  const binding = identity?.binding
  if (binding?.source === 'configured') return agentMemoryScope(binding)
  if (binding?.target.kind === 'group') return binding.target.id
  const group = String(groupId ?? '').trim()
  if (group && group !== 'undefined' && group !== 'null') return group
  const user = String(userId ?? '').trim()
  if (!user || !identity?.botId || !identity.personaId) return undefined
  return `private:${encodeURIComponent(identity.botId)}:${encodeURIComponent(identity.personaId)}:${encodeURIComponent(user)}`
}

export function memoryScene(groupId: unknown, userId: unknown): { kind: 'group' | 'private'; id: string } {
  const scope = String(groupId ?? '').trim()
  const bound = decodeMemoryScope(scope)?.target
  if (bound) return { kind: bound.kind === 'private' ? 'private' : 'group', id: bound.id }
  return !scope || scope.startsWith('private:')
    ? { kind: 'private', id: String(userId ?? '') }
    : { kind: 'group', id: scope }
}

export function isGroupMemoryScope(groupId: unknown): boolean {
  const scope = String(groupId ?? '').trim()
  const bound = decodeMemoryScope(scope)?.target
  if (bound) return bound.kind !== 'private'
  return Boolean(scope && scope !== 'undefined' && scope !== 'null' && !scope.startsWith('private:'))
}

export function sharedMemoryGroup(scope: unknown): string | undefined {
  const target = decodeMemoryScope(scope)?.target
  return target && target.kind !== 'private' ? target.id : undefined
}
