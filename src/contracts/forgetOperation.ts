import type { AgentBindingSnapshot } from './agentBinding.js'

/** The cleanup state is deliberately separate from the usage state. */
export type ForgetCleanupState = 'pending' | 'completed' | 'failed' | 'unknown' | 'unsupported'
export type ForgetUsageState = 'pending' | 'blocked' | 'unknown'
export type ForgetOperationPhase = 'accepted' | 'committed' | 'settling' | 'completed' | 'failed' | 'unknown'

export type ForgetOperationKind = 'person-profile' | 'person-entry' | 'character-memory'
export type ForgetImpactKind =
  | 'person-memory-entry'
  | 'character-memory'
  | 'character-goal'
  | 'character-work'
  | 'character-shared-derived'
  | 'source-consumer'
  | 'partition'

/** A reference is intentionally metadata only: no forgotten text, summary, or excerpt is retained. */
export interface ForgetImpact {
  readonly kind: ForgetImpactKind
  readonly id: string
  readonly partition: string
  readonly state: ForgetCleanupState
}

export interface ForgetOperationSubject {
  readonly userId?: string
  readonly entryId?: string
  readonly groupId?: string
  readonly memoryId?: string
}

export interface ForgetOperationReceipt {
  readonly version: 1
  readonly operationId: string
  readonly requestId: string
  /** Hash of the exact selector; forgotten source text is never retained. */
  readonly requestDigest: string
  readonly kind: ForgetOperationKind
  readonly binding: AgentBindingSnapshot
  readonly subject: ForgetOperationSubject
  readonly phase: ForgetOperationPhase
  readonly usage: ForgetUsageState
  readonly cleanup: ForgetCleanupState
  readonly impacts: readonly ForgetImpact[]
  readonly createdAt: number
  readonly updatedAt: number
  readonly sourceRevision?: string
  readonly errorCode?: string
}

export interface ForgetOperationStorage {
  get(key: string): Promise<string | null>
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

export interface ForgetOperationGuard {
  ensureCurrent(): void
  beforeAccess?(): Promise<void>
}

export class ForgetOperationConflictError extends Error {
  constructor() { super('遗忘请求编号已用于其他操作'); this.name = 'ForgetOperationConflictError' }
}

export interface ForgetOperationStore {
  begin(input: {
    readonly requestId: string
    readonly operationId?: string
    readonly requestDigest?: string
    readonly kind: ForgetOperationKind
    readonly binding: AgentBindingSnapshot
    readonly subject: ForgetOperationSubject
    readonly sourceRevision?: string
    readonly now?: number
  }, guard?: ForgetOperationGuard): Promise<ForgetOperationReceipt>
  read(operationId: string, guard?: ForgetOperationGuard): Promise<ForgetOperationReceipt | undefined>
  readByRequestId(requestId: string, guard?: ForgetOperationGuard): Promise<ForgetOperationReceipt | undefined>
  update(operationId: string, patch: {
    readonly phase?: ForgetOperationPhase
    readonly usage?: ForgetUsageState
    readonly cleanup?: ForgetCleanupState
    readonly impacts?: readonly ForgetImpact[]
    readonly sourceRevision?: string
    readonly errorCode?: string
    readonly now?: number
  }, guard?: ForgetOperationGuard): Promise<ForgetOperationReceipt>
  markCommitted(operationId: string, input?: {
    readonly impacts?: readonly ForgetImpact[]
    readonly sourceRevision?: string
    readonly now?: number
  }, guard?: ForgetOperationGuard): Promise<ForgetOperationReceipt>
  complete(operationId: string, input?: {
    readonly impacts?: readonly ForgetImpact[]
    readonly now?: number
  }, guard?: ForgetOperationGuard): Promise<ForgetOperationReceipt>
  fail(operationId: string, input: {
    readonly state?: Extract<ForgetCleanupState, 'failed' | 'unknown' | 'unsupported'>
    readonly errorCode: string
    readonly now?: number
  }, guard?: ForgetOperationGuard): Promise<ForgetOperationReceipt>
}

