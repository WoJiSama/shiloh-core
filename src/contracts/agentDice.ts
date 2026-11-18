import type { AgentBindingSnapshot, PlatformUserRef } from './agentBinding.js'
import type { IncomingMessage } from './platformMessage.js'

/** Explicit host authorization for deterministic public group dice commands.
 * Character sheets, delegated/hidden rolls and custom rule packs are separate capabilities. */
export interface AgentDiceConfig {
  readonly enabled: boolean
  readonly maxDiceCount?: number
  readonly maxDiceSides?: number
  readonly maxRounds?: number
}

/** A private result keeps its original group authority; it never invents a private binding. */
export interface AgentDicePrivateRelayRequest {
  readonly binding: AgentBindingSnapshot
  readonly source: IncomingMessage
  readonly origin: {
    readonly binding: AgentBindingSnapshot
    readonly source: {
      readonly messageId: string
      readonly author: PlatformUserRef
      readonly occurredAt: number
      readonly fingerprint: string
    }
    readonly operationId: string
    readonly authorityRevision: string
  }
  readonly recipient: PlatformUserRef
  readonly text: string
  readonly operationId: string
  readonly index: number
  readonly packId?: string
  readonly deliveryId?: string
}

export interface AgentDiceRelayGuard {
  readonly signal: AbortSignal
  isCurrent(): boolean
  ensureCurrent(): Promise<void>
}
