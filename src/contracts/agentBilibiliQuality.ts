import type { ConversationAddress, PlatformUserRef } from './agentBinding.js'
import type { AgentMediaResourceContext } from './agentMediaRelay.js'
import type { AgentMediaShare, AgentPreparedMediaRelay } from './agentMediaRelayWorkflow.js'

/** Trusted host permission declarations; no bare group/account identifiers. */
export interface AgentBilibiliQualityConfig {
  readonly enabled: boolean
  readonly masters: readonly PlatformUserRef[]
  readonly whitelist?: readonly { readonly target: ConversationAddress; readonly users: readonly PlatformUserRef[] }[]
}
export interface AgentBilibiliQualityRequest {
  readonly share: Extract<AgentMediaShare, { provider: 'bilibili' }>
  readonly quality: number
}
export interface AgentPreparedBilibiliQuality extends AgentPreparedMediaRelay {
  readonly requestedQuality: number
  readonly actualQualities: readonly { readonly quality: number; readonly label: string }[]
}
export interface AgentBilibiliQualityProvider {
  prepare(request: AgentBilibiliQualityRequest, context: AgentMediaResourceContext): Promise<AgentPreparedBilibiliQuality>
}
