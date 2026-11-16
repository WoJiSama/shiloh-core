import type { AgentBindingSnapshot, ConversationAddress } from './agentBinding.js'

/** In-memory owned media bytes; provider URLs, native references and local paths are excluded. */
export interface AgentAudioBytes {
  readonly mime: string
  readonly base64: string
  /** Trusted producer text for the host's output policy; never a native message parameter. */
  readonly spokenText?: string
}

export interface AgentVideoBytes {
  readonly mime: string
  readonly base64: string
}

export interface SendMediaAction {
  readonly version: 1
  readonly kind: 'media.send'
  readonly target: ConversationAddress
  readonly media: ({ readonly kind: 'audio' } & AgentAudioBytes) | ({ readonly kind: 'video' } & AgentVideoBytes)
  readonly binding?: AgentBindingSnapshot
}
