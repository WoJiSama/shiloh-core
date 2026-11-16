import type { AgentBindingSnapshot, AgentConversationScope } from './agentBinding.js'
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
  peerId?: string
}
export interface ConversationMemorySummary {
  text: string
  updatedAt: number
  coveredSeq: number
  invalidatedAt: number
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
