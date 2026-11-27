import type { ConversationAddress, PlatformAccountRef } from './agentBinding.js'
import type { CharacterEpistemic, CharacterState } from './character.js'

/** A data/cost rollout boundary, intentionally off until the host opts in. */
export interface AgentCognitionConfig { enabled: boolean }

/** Trusted Core evidence. The model never supplies ownership or audience. */
export interface CognitionSource {
  id: string
  agentId: string
  conversation: ConversationAddress
  kind: 'message' | 'self-expression' | 'receipt'
  nativeId: string
  authorId: string
  occurredAt: number
  content: string
  revision: number
  participantIds: string[]
  /** The owning runtime still verifies the original record before every use. */
  status: 'active' | 'revoked'
}

export type CognitionNodeKind = 'experience' | 'observation' | 'interest' | 'opinion' | 'habit' | 'procedure' | 'page' | 'goal' | 'receipt' | 'person'
export interface CognitionNode {
  id: string
  kind: CognitionNodeKind
  content: string
  topic: string
  epistemic: CharacterEpistemic
  conversation: ConversationAddress
  audience: 'scene' | 'self'
  sourceIds: string[]
  sourceVersions: Record<string, number>
  status: 'active' | 'superseded' | 'invalid'
  supersedes?: string
  createdAt: number
  updatedAt: number
}

export type CognitionRelation = 'supports' | 'contradicts' | 'refines' | 'participates' | 'motivates' | 'result' | 'related'
export interface CognitionLink {
  id: string
  from: string
  to: string
  /** goal -> receipt `result` records association; the raw receipt proves the outcome. */
  kind: CognitionRelation
  sourceIds: string[]
}

export interface CognitionInvalidation {
  id: string
  account?: PlatformAccountRef
  conversation?: ConversationAddress
  sourceIds?: string[]
  authorId?: string
  before: number
}

export interface CognitionState {
  version: 1
  agentId: string
  revision: number
  privacyRevision: number
  sources: CognitionSource[]
  nodes: CognitionNode[]
  links: CognitionLink[]
  invalidations: CognitionInvalidation[]
  /** Input fingerprints, checkpointed atomically with the resulting changes. */
  processed: string[]
}

export interface CognitionGuard {
  isCurrent(): boolean
  signal?: AbortSignal
  ensureCurrent?(signal?: AbortSignal): Promise<void>
}

export interface CognitionRedis {
  get(key: string): Promise<unknown>
  set(key: string, value: string, options?: { NX?: boolean; EX?: number; PX?: number }): Promise<unknown>
  eval?(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

/** Internal proposals: semantic judgments remain with the model; code enforces structure and provenance. */
export interface CognitionProposal {
  id: string
  action: 'CREATE' | 'CORROBORATE' | 'REFINE' | 'CORRECT'
  kind: CognitionNodeKind
  content: string
  topic: string
  sourceIds: string[]
  targetId?: string
  epistemic: CharacterEpistemic
  audience: 'scene' | 'self'
  /** Required for self projections; never promotes raw/private material automatically. */
  selfAssessment?: { subject: 'self'; sensitivity: 'ordinary'; containsOtherPeople: false }
}

export interface CognitionQuery {
  agentId: string
  conversation: ConversationAddress
  text: string
  limit?: number
  /** Runtime-owned current goals are already projected by their execution owner. */
  excludeKinds?: readonly CognitionNodeKind[]
}

export interface CognitionRecall {
  text: string
  nodes: CognitionNode[]
  revision: number
  isCurrent(): Promise<boolean>
}

export interface CognitionModelInput {
  sources: readonly CognitionSource[]
  current: readonly CognitionNode[]
}
export type CognitionConsolidator = (input: CognitionModelInput, guard: CognitionGuard) => Promise<readonly CognitionProposal[]>

export interface AgentCognition {
  record(sources: readonly CognitionSource[], guard: CognitionGuard): Promise<void>
  propose(agentId: string, conversation: ConversationAddress, proposals: readonly CognitionProposal[], guard: CognitionGuard): Promise<void>
  recall(query: CognitionQuery, guard: CognitionGuard): Promise<CognitionRecall>
  invalidate(agentId: string, change: CognitionInvalidation, guard: CognitionGuard): Promise<void>
  consolidate(agentId: string, conversation: ConversationAddress, guard: CognitionGuard, model?: CognitionConsolidator): Promise<void>
}

/** Only the owning runtime can construct a projection from committed records. */
export interface CognitionTurnProjection {
  agentId: string
  conversation: ConversationAddress
  character: CharacterState
  messageRefs: readonly { seq: number; messageId: string }[]
  expressions: readonly { messageId: string; content: string; at: number; participantIds: string[] }[]
  contextNodeIds?: readonly string[]
  /** Text-only turns append evidence without replacing the scene's character projection. */
  preserveCharacter?: boolean
}
