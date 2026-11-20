import type { PersonProfileExtractionContext } from './personProfileExtraction.js'
import type { ConversationAddress, PlatformAccountRef } from './agentBinding.js'

/** Trusted cleanup authority, supplied by the host after privacy admission. */
export interface AgentSemanticMemoryCleanupGuard {
  readonly signal: AbortSignal
  isCurrent(): boolean
  ensureCurrent(): Promise<void>
}

export interface AgentSemanticMemoryPurgeSubject {
  readonly account: PlatformAccountRef
  readonly agentId: string
  readonly subjectId: string
  /** Omitted only for the person's own account-wide private privacy command. */
  readonly target?: ConversationAddress
  /** Stable inclusive source timestamp; retries must not replace this with the current time. */
  readonly through: number
}

/** Blocked requires a committed durable fence. Publication failure rejects the operation.
 * Completed proves the matching persisted rows/vectors are gone; unknown requires a retry. */
export interface AgentSemanticMemoryCleanupReceipt {
  readonly usage: 'blocked'
  readonly cleanup: 'completed' | 'unknown'
  readonly removedRows: number
  readonly removedVectors: number
  readonly removedPartitions: number
}

export interface AgentSemanticMemoryCleanup {
  purgeSubject(input: AgentSemanticMemoryPurgeSubject, guard: AgentSemanticMemoryCleanupGuard): Promise<AgentSemanticMemoryCleanupReceipt>
}

/** Disabled unless explicitly enabled. Retention is bounded per conversation. */
export interface AgentSemanticMemoryConfig {
  enabled?: boolean
  /** Preserve deployments that capture and recall only inside groups. */
  groupOnly?: boolean
  retentionDays?: number
  maxMessagesPerConversation?: number
  topK?: number
  minScore?: number
  timeoutMs?: number
}

/** id is a lowercase SHA-256 fingerprint, changed with the endpoint/model/vector space. */
export interface AgentSemanticMemoryBackend {
  readonly id: string
  embed(texts: readonly string[], context: PersonProfileExtractionContext): Promise<readonly (readonly number[] | null)[]>
  rerank?(query: string, documents: readonly { readonly id: string; readonly text: string }[], context: PersonProfileExtractionContext): Promise<ReadonlyMap<string, number> | null>
}

/** Revalidate the actual sources before using a retained projection. */
export interface AgentSemanticMemoryRecall {
  readonly text: string
  isCurrent(): Promise<boolean>
}

/** Supplied by the trusted message host, never selected by the model. */
export interface AgentSemanticMemoryQuerySource {
  readonly messageId: string
  readonly authorId: string
  readonly at: number
}
