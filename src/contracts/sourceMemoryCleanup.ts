import type { AgentConversationMemoryCleanupGuard, AgentConversationMemoryPurgeSubject } from './conversationMemory.js'

export type AgentSourceMemoryCleanupGuard = AgentConversationMemoryCleanupGuard
export type AgentSourceMemoryPurgeSubject = AgentConversationMemoryPurgeSubject
export interface AgentSourceMemoryPartitionCleanupReceipt {
  readonly id: string
  readonly cleanup: 'completed' | 'unknown'
  readonly removedRecords: number
  readonly removedPartitions: number
}
export interface AgentSourceMemoryCleanupReceipt {
  readonly usage: 'blocked'
  readonly partitions: readonly AgentSourceMemoryPartitionCleanupReceipt[]
}
/** Trusted host operation. It is available independently of feature switches and bindings. */
export interface AgentSourceMemoryCleanup {
  purgeSubject(input: AgentSourceMemoryPurgeSubject, guard: AgentSourceMemoryCleanupGuard): Promise<AgentSourceMemoryCleanupReceipt>
}
