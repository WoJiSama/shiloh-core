import type { AgentBindingSnapshot } from './agentBinding.js'

export interface TextPersonMemoryConfig {
  enabled?: boolean
  userExtractDebounceSeconds?: number
  userExtractMaxBatchMessages?: number
}

/** Original user utterances only, captured by the verified conversation host. */
export interface TextPersonMemoryMessage {
  messageId: string
  at: number
  name: string
  text: string
}

export interface TextPersonMemoryBatch {
  version: 1
  id: string
  binding: AgentBindingSnapshot
  token: string
  subjectId: string
  peerId?: string
  messages: TextPersonMemoryMessage[]
  dueAt: number
  attempts: number
  retryAt: number
  /** Bounded acknowledgement ledger for replayed confirmed replies. */
  completedMessageIds?: string[]
  /** Persist a validated response before applying it; restart never regenerates this batch. */
  result?: { raw: string; messageIds: string[] }
}
