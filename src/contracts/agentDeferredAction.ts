import type { AgentBindingSnapshot, PlatformAccountRef, PlatformUserRef } from './agentBinding.js'
import type { AgentToolResult } from './agentTool.js'
import type { CommitmentConfigSection, CommitmentData, CommitmentRedisLike } from './commitments.js'
import type { DeliveryReceipt } from './delivery.js'

export type AgentDeferredJson = null | boolean | number | string | readonly AgentDeferredJson[] | { readonly [key: string]: AgentDeferredJson }
export type AgentDeferredParams = { readonly [key: string]: AgentDeferredJson }
export type AgentDeferredExecutorKind = 'builtin' | 'custom' | 'mcp'

/** A frozen, single invocation. No language-model planning occurs at its due time. */
export interface AgentDeferredFrozenAction {
  readonly tool: string
  readonly executor: AgentDeferredExecutorKind
  /** Stable fingerprint of schema, implementation and MCP server configuration across restarts.
   * Each live MCP generation additionally supplies its own revocable isCurrent guard. */
  readonly definitionId: string
  readonly params: AgentDeferredParams
}
export type AgentDeferredActionSource = {
  readonly kind: 'message'
  readonly messageId: string
  readonly at: number
} | {
  readonly kind: 'migration'
  readonly id: string
  readonly sourceHash: string
  readonly authorizedBy: string
  readonly at: number
}

/** A delegation, never a cached native user/master event. Current policy must still approve it. */
export interface AgentDeferredActionGrant {
  readonly version: 1
  readonly id: string
  readonly ruleId: string
  readonly ruleRevision: string
  readonly bindingIdentity: string
  readonly scopeKey: string
  readonly creator: PlatformUserRef
  readonly actionHash: string
  readonly dueAt: number
  readonly source: AgentDeferredActionSource
  readonly issuedAt: number
  readonly expiresAt: number
}

export interface AgentDeferredActionLegacySource {
  readonly kind: 'legacy-qq-reminder'
  readonly detailKey: string
  readonly rawSha256: string
  readonly originalStatus: 'pending' | 'sending' | 'unknown' | 'failed' | 'completed' | 'cancelled'
  readonly originalCreatedAt: number
  readonly originalUpdatedAt: number
  readonly originalTriggerTime: number
  readonly originalMessageId: string | number | null
  readonly originalExtraAttempted: boolean
  readonly explicitToolMapping: { readonly from: string; readonly to: string; readonly definitionId: string; readonly executor: AgentDeferredExecutorKind }
}

export interface AgentDeferredActionData {
  readonly version: 1
  readonly action: AgentDeferredFrozenAction
  readonly grant: AgentDeferredActionGrant
  readonly state: 'pending' | 'executing' | 'succeeded' | 'failed' | 'unknown'
  readonly attemptedAt: number
  readonly settledAt: number
  /** Only fixed diagnostic codes are durable; tool-returned data is not retained. */
  readonly resultCode: string
  readonly legacy?: AgentDeferredActionLegacySource
}

export interface AgentDeferredActionAuthorizationRequest {
  readonly binding: AgentBindingSnapshot
  readonly creator: PlatformUserRef
  readonly action: AgentDeferredFrozenAction
  readonly source: AgentDeferredActionSource
  readonly dueAt: number
  /** Available only during creation, never fabricated on deferred execution. */
  readonly requestText?: string
}
export type AgentDeferredAuthorizationCheck = 'allowed' | 'denied' | 'unavailable'
export interface AgentDeferredAuthorizationGuard {
  readonly signal: AbortSignal
  isCurrent(): boolean
}
export interface AgentDeferredActionAuthorization {
  issue(request: AgentDeferredActionAuthorizationRequest, guard?: AgentDeferredAuthorizationGuard): Promise<AgentDeferredActionGrant | undefined>
  check(grant: AgentDeferredActionGrant, request: AgentDeferredActionAuthorizationRequest, guard?: AgentDeferredAuthorizationGuard): Promise<AgentDeferredAuthorizationCheck>
  /** Fast revocation check, also used by queued native operations. */
  isCurrent(grant: AgentDeferredActionGrant, request: AgentDeferredActionAuthorizationRequest): boolean
}

export interface AgentDeferredActionExecutionContext {
  readonly kind: 'deferred'
  readonly taskId: string
  readonly binding: AgentBindingSnapshot
  readonly creator: PlatformUserRef
  readonly delegation: AgentDeferredActionGrant
  readonly signal: AbortSignal
  isCurrent(): boolean
  /** Rechecks the durable cancellation claim, current tool/config/identity/privacy and source. */
  ensureCurrent(): Promise<void>
}

export interface AgentDeferredActionDefinition {
  readonly name: string
  readonly executor: AgentDeferredExecutorKind
  readonly definitionId: string
  readonly timeoutMs?: number
  isCurrent(): boolean
  validate(params: AgentDeferredParams): boolean
  execute(params: AgentDeferredParams, context: AgentDeferredActionExecutionContext): Promise<AgentToolResult>
}
export interface AgentDeferredActionExecutor {
  resolve(name: string): AgentDeferredActionDefinition | undefined
  execute(action: AgentDeferredFrozenAction, context: AgentDeferredActionExecutionContext): Promise<AgentToolResult>
}

export interface AgentDeferredActionCreate {
  readonly binding: AgentBindingSnapshot
  readonly creator: PlatformUserRef
  readonly creatorName: string
  readonly source: AgentDeferredActionSource
  readonly requestText: string
  readonly dueAt: number
  readonly content: string
  readonly message: string
  readonly tool: string
  readonly params: unknown
  readonly signal: AbortSignal
  isCurrent(): boolean
}

export interface AgentDeferredActionRuntimePorts {
  readonly redis: CommitmentRedisLike
  readonly logger: { info(message: string): void; warn(message: string): void; error(message: string, error?: unknown): void }
  readonly executor: AgentDeferredActionExecutor
  readonly authorization: AgentDeferredActionAuthorization
  resolveBinding(target: AgentBindingSnapshot['target']): AgentBindingSnapshot | undefined
  /** Undefined means temporarily unavailable. Extra actions are never created in text/private mode. */
  mode(target: AgentBindingSnapshot['target']): 'simulation' | 'text' | 'private' | undefined
  ready(account: PlatformAccountRef): boolean
  /** Preserve the host's explicit group/creator caps; omitted uses existing commitment defaults. */
  limits?(): CommitmentConfigSection
  capture?(binding: AgentBindingSnapshot): { readonly signal: AbortSignal; isCurrent(): boolean; release(): void }
  /** Implement with the existing fixed-target send queue; recheck the supplied guard at native dispatch. */
  sendReminder(task: CommitmentData, context: AgentDeferredActionExecutionContext): Promise<DeliveryReceipt>
  now?(): number
}
