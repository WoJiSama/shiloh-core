import type { AgentBindingSnapshot, AgentConversationScope, ConversationAddress, PlatformAccountRef } from './agentBinding.js'
import type { PersonaScope } from './persona.js'
import type { PersonProfileExtractionContext } from './personProfileExtraction.js'

export interface MidtermMemoryConfig {
  enabled?: boolean
  minMessages?: number
  debounceMs?: number
  maxSummaryChars?: number
  bufferMaxLines?: number
  retentionDays?: number
}
export interface EpisodicMemoryConfig {
  enabled?: boolean
  maxPerGroup?: number
  recallDays?: number
  proactiveEnabled?: boolean
}
export interface ConversationMemoryRecord {
  seq: number
  messageId: string
  authorId: string
  name: string
  text: string
  at: number
  peerId?: string
}
export interface ConversationMemoryEpisode {
  id: string
  at: number
  userId?: string
  userName: string
  summary: string
  reply: string
  source: PersonaScope
  messageIds: string[]
  replyIds: string[]
  invalidatedAt: number
  /** Durable cleanup generation of all aggregate inputs; missing on legacy content. */
  cleanupToken?: string
  peerId?: string
}
export interface ConversationMemorySummary {
  text: string
  updatedAt: number
  coveredSeq: number
  invalidatedAt: number
  /** Durable cleanup generation of all aggregate inputs; missing on legacy content. */
  cleanupToken?: string
}
export interface ConversationMemoryState {
  version: 1
  id: string
  scope: AgentConversationScope
  binding: AgentBindingSnapshot
  token: string
  nextSeq: number
  records: ConversationMemoryRecord[]
  episodes: ConversationMemoryEpisode[]
  summary?: ConversationMemorySummary
  dueAt: number
  dueInvalidatedAt?: number
  /** Cleanup generation for the scheduled summary and its bounded retries. */
  dueCleanupToken?: string
  attempts: number
  retryAt: number
}
export interface ConversationSummaryInput {
  readonly previous: string
  readonly messages: readonly { readonly at: number; readonly authorId: string; readonly name: string; readonly text: string }[]
  readonly maxChars: number
}
export type ConversationSummaryModel = (input: ConversationSummaryInput, context: PersonProfileExtractionContext) => Promise<string>

export interface ConversationEpisodeInput {
  binding: AgentBindingSnapshot
  source: PersonaScope
  at: number
  userId?: string
  userName?: string
  summary: string
  reply: string
  messageIds: readonly string[]
  replyIds: readonly string[]
  peerId?: string
}

/** Authority supplied by a trusted host, never by a model tool. */
export interface AgentConversationMemoryCleanupGuard {
  readonly signal: AbortSignal
  isCurrent(): boolean
  ensureCurrent(): void | Promise<void>
}
export interface AgentConversationMemoryPurgeSubject {
  readonly account: PlatformAccountRef
  readonly agentId: string
  readonly subjectId: string
  /** Omission covers this subject's scopes under the same account and Agent. */
  readonly target?: ConversationAddress
  /** Inclusive original-message cutoff, fixed across recovery and retries. */
  readonly through: number
}
export interface AgentConversationMemoryCleanupReceipt {
  readonly usage: 'blocked'
  readonly cleanup: 'completed' | 'unknown'
  readonly removedRecords: number
  readonly removedSummaries: number
  readonly removedEpisodes: number
  readonly removedPartitions: number
}
export interface AgentConversationMemoryCleanup {
  purgeSubject(input: AgentConversationMemoryPurgeSubject, guard: AgentConversationMemoryCleanupGuard): Promise<AgentConversationMemoryCleanupReceipt>
}
