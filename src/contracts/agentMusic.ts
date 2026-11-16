import type { AgentBindingSnapshot, ConversationAddress } from './agentBinding.js'

/** Provider-owned public music references; host credentials never enter this card. */
export interface AgentMusicCard {
  readonly title: string
  readonly artist?: string
  readonly pageUrl: string
  readonly audioUrl: string
  readonly coverUrl: string
}

export interface SendMusicAction {
  readonly version: 1
  readonly kind: 'music.send'
  readonly target: ConversationAddress
  readonly music: AgentMusicCard
  readonly binding?: AgentBindingSnapshot
}
