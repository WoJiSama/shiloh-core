import type {PersonaIdentity} from './persona.js'
import type {AgentBindingSnapshot,PlatformUserRef} from './agentBinding.js'
/** Serializable identity only. Live event methods and cancellation handles stay in adapters. */
interface ConversationIdentity {
  readonly botId: string
  readonly userId: string
  readonly conversationId: string
  readonly persona?: PersonaIdentity
  readonly binding?: AgentBindingSnapshot
  readonly sender?: PlatformUserRef
}
export interface GroupConversationContext extends ConversationIdentity {
  readonly kind: 'group'
  readonly groupId: string
}
export interface PrivateConversationContext extends ConversationIdentity {
  readonly kind: 'private'
}
export type ConversationContext = GroupConversationContext | PrivateConversationContext
