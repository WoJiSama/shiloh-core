import type { AgentBindingSnapshot, ConversationAddress } from './agentBinding.js'

/** Trusted host management authority; never constructed from a model or browser payload. */
export interface AgentManagementGuard {
  readonly signal: AbortSignal
  isCurrent(): boolean
  ensureCurrent(): void
}

/** Issued by the trusted forget-operation owner, never decoded from an HTTP/model payload. */
export interface AgentProfileForgetCutoff {
  readonly operationId: string
  readonly userId: string
  readonly bindingToken: string
  readonly through: number
}

export interface AgentManagementContext extends AgentManagementGuard {
  readonly binding?: AgentBindingSnapshot
  readonly profileForget?: AgentProfileForgetCutoff
  /** Re-evaluated by management modules before storage access and mutation. */
  authorize(operation: string, binding: AgentBindingSnapshot, guard: AgentManagementGuard):
    Promise<'allowed' | 'denied' | 'unavailable'>
}

export interface AgentManagementBindings {
  list(): readonly AgentBindingSnapshot[]
  resolve(target: ConversationAddress): AgentBindingSnapshot | undefined
}

/** Trusted management ports over the same stores used by the running Agent. */
export interface AgentManagementModules {
  readonly profiles: {
    list(context: AgentManagementContext): Promise<readonly { binding: AgentBindingSnapshot; profile: Record<string, unknown> }[]>
    remove(userId: string, context: AgentManagementContext): Promise<boolean>
    removeField(userId: string, field: string, value: string | undefined, context: AgentManagementContext): Promise<unknown>
  }
  readonly trusteeship: {
    overview(context: AgentManagementContext): Promise<Record<string, unknown>>
    cancelCommitment(scopeKey: string, id: string, context: AgentManagementContext): Promise<boolean>
    deleteDelegated(scopeKey: string, id: string, context: AgentManagementContext): Promise<boolean>
    clearFailLog(context: AgentManagementContext): Promise<boolean>
  }
}

export class AgentManagementError extends Error {
  constructor(readonly code: 'forbidden' | 'conflict' | 'unavailable' | 'invalid_request' | 'not_found') {
    super('Agent management ' + code)
    this.name = 'AgentManagementError'
  }
}
