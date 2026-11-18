/** Platform IDs remain opaque after the adapter has validated them. */
export interface PlatformIdentityRef {
  readonly platform: string
  readonly namespace: string
  readonly id: string
}

export type PlatformAccountRef = PlatformIdentityRef
export type PlatformUserRef = PlatformIdentityRef

export type ConversationKind = 'group' | 'private' | 'channel' | 'thread'

export interface ConversationAddress {
  readonly account: PlatformAccountRef
  readonly kind: ConversationKind
  readonly id: string
}

export interface AgentDefinition {
  readonly id: string
  readonly personaId: string
}

export interface PlatformConnection {
  readonly id: string
  readonly account: PlatformAccountRef
}

/** Durable ownership of conversation data, stable across binding revisions. */
export interface AgentConversationScope {
  readonly agentId: string
  readonly target: ConversationAddress
}

/** Serializable route resolved by the host, independent of credentials and live platform objects. */
export interface AgentBindingSnapshot extends AgentConversationScope {
  readonly source: 'configured' | 'legacy'
  readonly id: string
  readonly revision: string
  readonly personaId: string
  readonly connectionId: string
}

/** The host supplies this check for a captured turn. It never enters persisted data. */
export interface AgentBindingGuard {
  _isAgentBindingCurrent?: () => boolean
}

export interface AgentBindingTurn extends AgentBindingGuard {
  _agentBinding?: AgentBindingSnapshot
  _agentBindingToken?: string
  _expectedAgentBindingToken?: string
  /** Async source fence for operations that cross an await before external I/O. */
  _ensureAgentToolCurrent?: () => Promise<void>
}

export interface DeferredBindingEvent extends AgentBindingTurn {
  self_id?: string | number | null
  group_id?: string | number | null
  user_id?: string | number | null
  message_type?: string
}

export type RestoreDeferredAgentBinding = (
  event: DeferredBindingEvent,
  expected?: {token: string} | {identity: string},
) => 'current' | 'changed' | 'unavailable'

export function isAgentBindingCurrent(event?: AgentBindingGuard | null): boolean {
  try {
    return event?._isAgentBindingCurrent?.() ?? true
  } catch {
    return false
  }
}

export async function ensureAgentBindingCurrent(event?: AgentBindingTurn | null): Promise<void> {
  if (!isAgentBindingCurrent(event)) throw new Error('工具来源或角色绑定已改变')
  await event?._ensureAgentToolCurrent?.()
  if (!isAgentBindingCurrent(event)) throw new Error('工具来源或角色绑定已改变')
}
