import type { AgentBindingSnapshot, ConversationAddress, PlatformUserRef } from './agentBinding.js'
import type { AgentToolContext } from './agentTool.js'

/** Structural storage port; the host's leased Redis storage satisfies it. */
export interface AgentRedPacketStorage {
  get(key: string): Promise<string | null>
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

/** Guards belong to a captured binding, authenticated connection and source authorization. */
export interface AgentRedPacketGuard {
  readonly signal: AbortSignal
  isCurrent(): boolean
  ensureCurrent(): Promise<void>
}

export type AgentRedPacketKind = 'normal' | 'lucky' | 'password' | 'exclusive' | 'unknown'

/** Trusted adapter evidence. Native wallet credentials never leave the adapter. */
export interface AgentRedPacketSnapshot {
  readonly version: 1
  readonly target: ConversationAddress
  readonly source: { readonly messageId: string; readonly author: PlatformUserRef; readonly at: number }
  readonly observedAt: number
  /** Opaque ephemeral selection handle; meaningless to other accounts/conversations. */
  readonly packetRef: string
  /** Stable digest of the real native packet identity, independent of a human command/quote. */
  readonly packetIdentity: string
  readonly kind: AgentRedPacketKind
  readonly title: string
  readonly exclusiveForBot: boolean
}

export type AgentRedPacketPasswordReceipt =
  | { readonly state: 'confirmed'; readonly messageId: string }
  | { readonly state: 'failed'; readonly code?: string }
  | { readonly state: 'unknown' }

/** Only a native grabRedBagRsp with an actual positive integer amount confirms a grab. */
export type AgentRedPacketGrabReceipt =
  | { readonly state: 'confirmed'; readonly amountFen: number }
  | { readonly state: 'failed'; readonly code?: string }
  | { readonly state: 'unknown' }

export interface AgentRedPacketPort {
  read(target: ConversationAddress, messageId: string, guard: AgentRedPacketGuard): Promise<AgentRedPacketSnapshot | undefined>
  /** Newest first, bounded to options.limit (1..1000). Each item still requires a fresh read before use. */
  recent(target: ConversationAddress, options: AgentRedPacketGuard & { readonly limit: number }): Promise<readonly AgentRedPacketSnapshot[]>
  revalidate(packet: AgentRedPacketSnapshot, guard: AgentRedPacketGuard): Promise<boolean>
  /** Sends the exact native password, never model-supplied text; one native dispatch only. */
  sendPassword(packet: AgentRedPacketSnapshot, guard: AgentRedPacketGuard): Promise<AgentRedPacketPasswordReceipt>
  /** Fresh native proof and one grab_red_bag; no retries or inferred message IDs. */
  grab(packet: AgentRedPacketSnapshot, guard: AgentRedPacketGuard): Promise<AgentRedPacketGrabReceipt>
}

/** These are separate grants. Absent/false fields deny that branch. */
export interface AgentRedPacketPolicy {
  readonly enabled: boolean
  readonly allowExplicit?: boolean
  readonly allowRecentSearch?: boolean
  readonly allowReferenceFallback?: boolean
  readonly allowPasswordSend?: boolean
  readonly recentLimit?: number
  readonly automatic?: {
    readonly enabled: boolean
    readonly toolConfigured: boolean
    readonly allowPasswordSend?: boolean
  }
}

/** Core creates this scope from a real human request; tools cannot add trusted sources. */
export interface AgentRedPacketContext extends Pick<AgentToolContext, 'binding' | 'actor' | 'request' | 'signal' | 'isCurrent' | 'ensureCurrent'> {
  /** The host must re-read the original human text/time/author and current permissions. */
  ensureCurrent(): Promise<void>
  readonly visiblePackets?: readonly AgentRedPacketSnapshot[]
  /** Includes recall/privacy/config checks for the wallet's actual author and message. */
  isSourceAvailable(source: { readonly messageId: string; readonly author: PlatformUserRef }): Promise<boolean>
}

/** A trusted wallet ingress is a distinct producer, never a fabricated human message. */
export interface AgentRedPacketAutomaticContext extends AgentRedPacketGuard {
  readonly binding: AgentBindingSnapshot
  isSourceAvailable(source: { readonly messageId: string; readonly author: PlatformUserRef }): Promise<boolean>
}

export interface AgentRedPacketRequest {
  readonly confirm?: boolean
  readonly messageId?: string
  readonly packetRef?: string
}

export type AgentRedPacketPhase = 'claimed' | 'password_pending' | 'password_confirmed' | 'grab_pending' | 'finished'
export interface AgentRedPacketResult {
  readonly state: 'confirmed' | 'failed' | 'unknown' | 'cancelled' | 'skipped'
  readonly phase: AgentRedPacketPhase
  readonly code: string
  readonly passwordConfirmed: boolean
  readonly grabbed: boolean
  readonly amountFen?: number
}

export interface AgentRedPacketRuntime {
  execute(context: AgentRedPacketContext, request?: AgentRedPacketRequest): Promise<AgentRedPacketResult>
  executeAutomatic(context: AgentRedPacketAutomaticContext, packet: AgentRedPacketSnapshot): Promise<AgentRedPacketResult>
}
