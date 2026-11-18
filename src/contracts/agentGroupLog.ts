import type { AgentBindingSnapshot, ConversationAddress, PlatformUserRef } from './agentBinding.js'

/** Explicit host authorization; inbound messages and model arguments cannot add masters. */
export interface AgentGroupLogConfig {
  readonly enabled: boolean
  readonly maxBytes?: number
  readonly masters?: readonly PlatformUserRef[]
}

/** Complete owned transcript bytes; no paths, URLs, resource handles or recipient selectors. */
export interface AgentGroupLogArtifact {
  readonly name: string
  readonly mime: 'text/plain' | 'text/html'
  readonly base64: string
}

/** A deterministic human command owns both the fixed destination and original source evidence. */
export interface SendGroupLogAction {
  readonly version: 1
  readonly kind: 'group-log.upload'
  readonly target: ConversationAddress
  readonly binding: AgentBindingSnapshot
  readonly source: {
    readonly messageId: string
    readonly sender: PlatformUserRef
    readonly occurredAt: number
    readonly textSha256: string
  }
  readonly log: AgentGroupLogArtifact
}
