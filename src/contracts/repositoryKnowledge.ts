import type { ConversationAddress } from './agentBinding.js'
import type { DeliveryReceipt } from './delivery.js'
import type { IncomingMessage } from './platformMessage.js'

export interface RepositorySource {
  readonly id: string
  readonly remote: string
  readonly link: string
  readonly branch: string
  readonly paths: readonly string[]
}

export interface RepositoryProject {
  readonly id: string
  readonly name: string
  readonly repositories: readonly string[]
}

export interface RepositoryGrant {
  readonly target: ConversationAddress
  readonly projectId: string
  readonly repositories: readonly string[]
}

export interface RepositoryCatalog {
  readonly repositories: readonly RepositorySource[]
  readonly projects: readonly RepositoryProject[]
  readonly grants: readonly RepositoryGrant[]
}

export interface RepositoryEvidence {
  readonly repoId: string
  readonly sha: string
  readonly path: string
  readonly start: number
  readonly end: number
  readonly text: string
}

export interface RepositoryQueryGuard {
  readonly signal: AbortSignal
  isCurrent(): boolean
  ensureCurrent(): Promise<void>
}

export interface RepositoryKnowledgeReply {
  readonly text: string
  isCurrent(): boolean
  ensureCurrent?(): Promise<void>
  delivered(receipt: DeliveryReceipt): void | Promise<void>
}

export interface RepositoryKnowledgePort {
  available(target: ConversationAddress): boolean
  answer(source: IncomingMessage, persona: { readonly name?: string; readonly identity?: string; readonly tone?: string; readonly speechStyle?: readonly string[] },
    guard: RepositoryQueryGuard): Promise<RepositoryKnowledgeReply | undefined>
}
