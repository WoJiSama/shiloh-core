import type { AgentBindingSnapshot, ConversationAddress } from './agentBinding.js'
import type { AgentMediaResourceContext } from './agentMediaRelay.js'

/** Core-owned public video metadata. Native card JSON and resource URLs belong to adapters. */
export interface AgentVideoCard {
  readonly provider: 'bilibili'
  readonly id: string
  readonly title: string
  readonly author: string
  readonly durationSeconds: number
  readonly pageUrl: string
}

export interface SendVideoCardAction {
  readonly version: 1
  readonly kind: 'video-card.send'
  readonly target: ConversationAddress
  readonly binding: AgentBindingSnapshot
  readonly card: AgentVideoCard
}

export interface AgentVideoSearchProvider {
  search(keyword: string, context: AgentMediaResourceContext): Promise<{ readonly items: readonly AgentVideoCard[] }>
  resolve(input: { readonly query?: string; readonly url?: string }, context: AgentMediaResourceContext): Promise<AgentVideoCard>
}
