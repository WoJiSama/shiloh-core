import type { AgentBindingSnapshot, ConversationAddress } from './agentBinding.js'

export interface PersonProfileExtractionMessage {
  readonly userId: string
  readonly name: string
  readonly text: string
}

/** Host-owned scope and revocable authority; never include this context in a model prompt. */
export interface PersonProfileExtractionContext {
  readonly target: ConversationAddress
  readonly binding?: AgentBindingSnapshot
  readonly signal: AbortSignal
  isCurrent(): boolean
  ensureCurrent(): Promise<void>
  recordUsage?(model: string, usage: unknown): void
}

export type PersonProfileExtractor = (
  messages: readonly PersonProfileExtractionMessage[],
  isCurrent?: () => boolean,
  context?: PersonProfileExtractionContext,
) => Promise<string>
