import type { AgentBindingSnapshot, PlatformUserRef } from './agentBinding.js'
import type { AgentToolRegistry } from './agentTool.js'

export interface AgentLocalEmojiCollectionContext {
  readonly binding: AgentBindingSnapshot
  readonly source: {
    readonly messageId: string
    readonly author: PlatformUserRef
    readonly occurredAt: number
  }
  readonly signal: AbortSignal
  isCurrent(): boolean
  ensureCurrent(): Promise<void>
}

export interface AgentLocalEmojiModel {
  readonly baseUrl: string
  readonly model: string
  readonly apiKey: string
}

export interface AgentLocalEmojiRuntime {
  readonly builtIn: NonNullable<AgentToolRegistry['builtIn']>
  collect(image: { readonly mime: string; readonly base64: string }, context: AgentLocalEmojiCollectionContext): Promise<{ readonly ok: boolean; readonly error?: string }>
  close(): Promise<void>
}
