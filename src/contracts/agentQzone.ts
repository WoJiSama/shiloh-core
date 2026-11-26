import type { AgentBindingSnapshot, ConversationAddress, PlatformAccountRef, PlatformUserRef } from './agentBinding.js'
import type { ConversationMemberSnapshot } from './platformConnection.js'

/** No credentials, native payloads, positional deletion or visibility/image options. */
export type AgentQzoneOperation =
  | { readonly kind: 'publish'; readonly text: string }
  | { readonly kind: 'delete'; readonly postId: string }
  | { readonly kind: 'read'; readonly userId: string }
  | { readonly kind: 'visit'; readonly userId: string }
  | { readonly kind: 'like'; readonly userId: string; readonly postId: string; readonly visitId: string }
  | { readonly kind: 'comment'; readonly userId: string; readonly postId: string; readonly visitId: string; readonly text: string }

export interface AgentQzoneAction {
  readonly version: 1
  readonly binding: AgentBindingSnapshot
  readonly operation: AgentQzoneOperation
}
export interface AgentQzoneGuard {
  readonly signal: AbortSignal
  isCurrent(): boolean
  /** The provider calls this before credentials, each native/HTTP request and after preceding reads. */
  ensureCurrent(): Promise<void>
}
export interface AgentQzoneFeed {
  readonly postId: string
  readonly userId: string
  readonly text: string
  readonly createdAt?: number
  readonly likes?: number
}
export type AgentQzoneReceipt =
  | { readonly state: 'confirmed'; readonly postId?: string; readonly feeds?: readonly AgentQzoneFeed[] }
  | { readonly state: 'failed'; readonly code: string }
  | { readonly state: 'unknown' }

/** Trusted host-owned provider. It dispatches one external effect and never retries. */
export interface AgentQzoneProvider {
  execute(action: AgentQzoneAction, guard: AgentQzoneGuard): Promise<AgentQzoneReceipt>
}
export interface AgentQzoneOwnPost {
  readonly account: PlatformAccountRef
  readonly agentId: string
  readonly postId: string
  readonly source: AgentBindingSnapshot
}
/** Only verified visit results create these opaque, binding/source-bound capabilities. No feed text is persisted. */
export interface AgentQzoneVisit {
  readonly id: string
  readonly binding: AgentBindingSnapshot
  readonly sourceId: string
  readonly userId: string
  readonly postIds: readonly string[]
  readonly observedAt: number
  readonly expiresAt: number
}
export interface AgentQzoneLimits {
  readonly enabled: boolean
  readonly visitCooldownMs: number
  readonly minAffinity: number
  readonly maxLikesPerDay: number
  readonly maxCommentsPerDay: number
}
export interface AgentQzoneClaim {
  readonly key: string
  readonly token: string
}
export type AgentQzoneClaimResult =
  | { readonly state: 'claimed'; readonly claim: AgentQzoneClaim }
  | { readonly state: 'failed' | 'unknown'; readonly code: string }

/** A structural Redis port, independent of inbox routing and platform event unions. */
export interface AgentQzoneStorage {
  get(key: string): Promise<string | null>
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

/** Claims/effect keys survive restart. Pending/unknown effects are never replayed or silently expired. */
export interface AgentQzoneLedger {
  claim(input: { readonly binding: AgentBindingSnapshot; readonly identity: string; readonly operation: AgentQzoneOperation;
    readonly now: number; readonly limits: AgentQzoneLimits }): Promise<AgentQzoneClaimResult>
  isPending(claim: AgentQzoneClaim): Promise<boolean>
  settle(claim: AgentQzoneClaim, state: AgentQzoneReceipt['state'], evidence?: {
    readonly ownPost?: AgentQzoneOwnPost; readonly visit?: AgentQzoneVisit;
  }): Promise<boolean>
  readOwnPost(account: PlatformAccountRef, postId: string): Promise<AgentQzoneOwnPost | undefined>
  readVisit(visitId: string): Promise<AgentQzoneVisit | undefined>
}

export interface AgentQzoneExecution {
  readonly binding: AgentBindingSnapshot
  /** Host-derived source identity, stable across restart; never supplied by a model. */
  readonly identity: string
  readonly actor: { readonly kind: 'user' | 'autonomous' | 'commitment'; readonly user?: PlatformUserRef }
  readonly operation: AgentQzoneOperation
  readonly signal: AbortSignal
  isCurrent(): boolean
  ensureCurrent(): Promise<void>
  /** Re-evaluates live tool allow/deny, actor policy, privacy and source withdrawal. Missing grant means deny. */
  authorize(action: AgentQzoneAction): Promise<boolean>
  /** Fresh group evidence is mandatory for every visit, like and comment. */
  readMember?(userId: string, guard: AgentQzoneGuard): Promise<ConversationMemberSnapshot | undefined>
  affinity?(userId: string): number
  /** Applies the host's persona/output policy to the final outbound text. Must return exactly true. */
  allowsText?(text: string, target: ConversationAddress): Promise<boolean>
}
export interface AgentQzoneResult {
  readonly state: AgentQzoneReceipt['state']
  readonly kind: AgentQzoneOperation['kind']
  readonly code?: string
  readonly postId?: string
  readonly visitId?: string
  readonly feeds?: readonly AgentQzoneFeed[]
  /** Every attempted write/unknown result must end the host turn without follow-up model or text. */
  readonly terminal: boolean
}
