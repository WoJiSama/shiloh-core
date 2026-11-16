import type { PlatformUserRef } from './agentBinding.js'

/** Opt-in bounded original sources. No embeddings or external model calls. */
export interface AgentHistoryConfig {
  enabled?: boolean
  retentionDays?: number
  maxMessagesPerConversation?: number
  timeoutMs?: number
}

/** Current verified user request, supplied by the host rather than the model. */
export interface AgentHistoryRequestSource {
  messageId: string
  authorId: string
  text: string
  at: number
  mentions: readonly PlatformUserRef[]
  replyAuthor?: PlatformUserRef
}

/** Temporary evidence: recheck before every model call, send and derived write. */
export interface AgentHistoryRecall {
  text: string
  isCurrent(): Promise<boolean>
}
