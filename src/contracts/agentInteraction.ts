import type { AgentBindingSnapshot, ConversationAddress, PlatformUserRef } from './agentBinding.js'

/** Platform-neutral effects; native API names, credentials and message payloads never enter these values. */
export type AgentInteraction =
  | { readonly kind: 'poke'; readonly user: PlatformUserRef }
  | { readonly kind: 'profile-like'; readonly user: PlatformUserRef; readonly count: number }
  | { readonly kind: 'message-reaction'; readonly messageId: string; readonly emojiId: string }
  | { readonly kind: 'message-recall'; readonly messageId: string }
  | { readonly kind: 'member-mute'; readonly user: PlatformUserRef; readonly seconds: number; readonly requester: PlatformUserRef }
  | { readonly kind: 'group-mute'; readonly enabled: boolean; readonly requester: PlatformUserRef }
  | { readonly kind: 'member-card'; readonly user: PlatformUserRef; readonly name: string; readonly requester: PlatformUserRef }

export interface AgentInteractionPlan {
  readonly version: 1
  readonly kind: AgentInteraction['kind']
  readonly operations: readonly AgentInteraction[]
}

export interface SendInteractionAction {
  readonly version: 1
  readonly kind: 'conversation.interact'
  readonly target: ConversationAddress
  readonly binding: AgentBindingSnapshot
  readonly interaction: AgentInteraction
}

/** Non-message effects cannot manufacture a message ID to claim confirmation. */
export type InteractionReceipt =
  | { readonly state: 'confirmed' }
  | { readonly state: 'failed'; readonly code?: string }
  | { readonly state: 'unknown' }

export interface AgentInteractionResult {
  readonly state: InteractionReceipt['state']
  readonly completed: number
  readonly requested: number
  readonly code?: string
}
