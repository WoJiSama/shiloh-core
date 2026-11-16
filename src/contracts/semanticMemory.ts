import type { PersonProfileExtractionContext } from './personProfileExtraction.js'

/** Disabled unless explicitly enabled. Retention is bounded per conversation. */
export interface AgentSemanticMemoryConfig {
  enabled?: boolean
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
