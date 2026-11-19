import type { AgentBindingSnapshot, ConversationAddress, PlatformAccountRef, PlatformUserRef } from './agentBinding.js'
import type { AgentToolRegistry } from './agentTool.js'

export interface AgentLocalEmojiCollectionContext {
  readonly binding: AgentBindingSnapshot
  readonly source: {
    readonly messageId: string
    readonly author: PlatformUserRef
    readonly occurredAt: number
  }
  readonly signal: AbortSignal
  isCurrent(): boolean
  ensureCurrent(): Promise<void>
}

export interface AgentLocalEmojiModel {
  readonly baseUrl: string
  readonly model: string
  readonly apiKey: string
}

/** Trusted cleanup authority can finish a previously committed privacy command after a binding change. */
export interface AgentLocalEmojiCleanupGuard {
  readonly signal: AbortSignal
  isCurrent(): boolean
  ensureCurrent(): Promise<void>
}

export interface AgentLocalEmojiRevokeSource {
  readonly target: ConversationAddress
  readonly messageId: string
}

export interface AgentLocalEmojiPurgeSubject {
  readonly account: PlatformAccountRef
  readonly agentId: string
  readonly subjectId: string
  /** Omitted for the person's own private command, which covers this Agent across the account. */
  readonly target?: ConversationAddress
  readonly through: number
}

/** Only attributable sources are covered. Historical archives never gain invented person/message identities.
 * A receipt requires a durable usage fence; failure to publish that fence rejects the operation.
 * Unsupported means unidentified old records are quarantined; unknown means cleanup needs a retry. */
export interface AgentLocalEmojiCleanupReceipt {
  readonly usage: 'blocked'
  readonly cleanup: 'completed' | 'unknown' | 'unsupported'
  readonly removedSources: number
  readonly removedImages: number
  readonly unattributedImages: number
}

export interface AgentLocalEmojiRuntime {
  readonly builtIn: NonNullable<AgentToolRegistry['builtIn']>
  collect(image: { readonly mime: string; readonly base64: string }, context: AgentLocalEmojiCollectionContext): Promise<{ readonly ok: boolean; readonly error?: string }>
  revokeSource(input: AgentLocalEmojiRevokeSource, guard: AgentLocalEmojiCleanupGuard): Promise<AgentLocalEmojiCleanupReceipt>
  purgeSubject(input: AgentLocalEmojiPurgeSubject, guard: AgentLocalEmojiCleanupGuard): Promise<AgentLocalEmojiCleanupReceipt>
  close(): Promise<void>
}
