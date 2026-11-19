import type { AgentBindingSnapshot, ConversationAddress, PlatformAccountRef } from './agentBinding.js'
import type { PersonaScope } from './persona.js'
import type { PersonProfileExtractionContext } from './personProfileExtraction.js'

/** Compatibility controls for group learning. A separate explicit model port is required. */
export interface GroupMemoryConfig {
  enabled?: boolean
  groupExtractMinIntervalMinutes?: number
  groupExtractMaxBatchMessages?: number
}

export interface GroupMemoryMessage {
  messageId: string
  authorId: string
  name: string
  text: string
  at: number
  mentions: string[]
  files: { name: string; reference?: string }[]
}

export type GroupMemoryKind = 'fact' | 'alias' | 'member_definition' | 'member_set' | 'group_file' | 'workflow'
export interface GroupMemoryProposal {
  kind: GroupMemoryKind
  sourceIndex: number
  excerpt: string
  text?: string
  subject?: string
  condition?: string
  targetUserIds?: string[]
  relatedUserIds?: string[]
  ownerId?: string
  fileName?: string
  tags?: string[]
}

/** A legacy archive proves who observed a message, not the teaching's submitting persona version. */
export interface LegacyGroupTeachingObservation {
  kind: 'legacy-qq-observation'
  botId: string
  personaId: string
  sourceKey: string
  recordId: string
  fingerprint: string
}

export interface GroupMemoryEntry {
  id: string
  kind: GroupMemoryKind
  key: string
  source: GroupMemoryMessage
  excerpt: string
  persona: PersonaScope | LegacyGroupTeachingObservation
  createdBy: string
  createdAt: number
  updatedAt: number
  text?: string
  subject?: string
  condition?: string
  targetUserIds: string[]
  relatedUserIds: string[]
  ownerId?: string
  file?: { name: string; reference?: string }
  tags: string[]
  /** Generation of every input used to derive this entry, captured before extraction. */
  cleanupToken?: string
}

export interface GroupMemoryJob {
  id: string
  mode: 'consensus' | 'teaching'
  messages: GroupMemoryMessage[]
  attempts: number
  retryAt: number
  invalidatedAt: number
  cleanupToken?: string
}

/** Automatic group facts remain Agent-owned; explicit human teaching belongs to the conversation. */
export interface GroupMemoryAgentState {
  agentId: string
  binding: AgentBindingSnapshot
  token: string
  records: GroupMemoryMessage[]
  jobs: GroupMemoryJob[]
  entries: GroupMemoryEntry[]
  seen: string[]
  consensusDone: string[]
  teachingDone: string[]
  deletedSources: string[]
  /** Sources already received before an Agent clear cannot be captured or rebuilt later. */
  clearedAt?: number
  nextConsensusAt: number
}

/** One CAS document keeps shared teaching, Agent facts and job acknowledgements atomic. */
export interface GroupMemoryState {
  version: 1
  id: string
  target: ConversationAddress
  agents: GroupMemoryAgentState[]
  entries: GroupMemoryEntry[]
  deletedSources: string[]
  /** Revoked explicit-teaching sources do not erase another Agent's automatic facts. */
  teachingDeletedSources?: string[]
  /** Explicit teaching from older source messages cannot be rebuilt after a shared clear. */
  teachingClearedAt?: number
}

export interface GroupMemoryModelInput {
  readonly mode: 'consensus' | 'teaching'
  readonly messages: readonly Readonly<GroupMemoryMessage>[]
  /** Verified candidates only. A model never creates platform identities or roles. */
  readonly members: readonly { readonly id: string; readonly name: string }[]
  readonly botUserId: string
}

export type GroupMemoryModel = (input: GroupMemoryModelInput, context: PersonProfileExtractionContext) => Promise<readonly GroupMemoryProposal[]>

/** Cleanup authority comes from the host, never a model or a live scene binding. */
export interface AgentGroupMemoryCleanupGuard {
  readonly signal: AbortSignal
  isCurrent(): boolean
  ensureCurrent(): void | Promise<void>
}
export interface AgentGroupMemoryPurgeSubject {
  readonly account: PlatformAccountRef
  readonly agentId: string
  readonly subjectId: string
  /** Omission includes old, disabled and unbound scopes under this account and Agent. */
  readonly target?: ConversationAddress
  /** Inclusive source cutoff, frozen across retries. */
  readonly through: number
}
export interface AgentGroupMemoryCleanupReceipt {
  readonly usage: 'blocked'
  readonly cleanup: 'completed' | 'unknown'
  readonly removedRecords: number
  readonly removedJobs: number
  readonly removedEntries: number
  readonly removedPartitions: number
}
export interface AgentGroupMemoryCleanup {
  purgeSubject(input: AgentGroupMemoryPurgeSubject, guard: AgentGroupMemoryCleanupGuard): Promise<AgentGroupMemoryCleanupReceipt>
}
