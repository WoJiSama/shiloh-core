import type { AgentBindingSnapshot } from './agentBinding.js'
import type { IncomingMessage } from './platformMessage.js'
import type { MessageImage } from './platformConnection.js'
import type { AgentDicePrivateRelayRequest, AgentDiceRelayGuard } from './agentDice.js'

/** The same verified original-group relay envelope used by private dice results. */
export type AgentGroupGamePrivateRelayRequest = Omit<AgentDicePrivateRelayRequest, 'packId' | 'deliveryId'>
export type AgentGroupGameRelayGuard = AgentDiceRelayGuard
export interface AgentGroupGameSendGuard {
  readonly signal?: AbortSignal
  isCurrent(): boolean
  ensureCurrent(): Promise<void>
}

/** Core-owned source and authority. Game adapters never receive native bot events. */
export interface AgentGroupGameContext {
  readonly source: IncomingMessage
  readonly binding: AgentBindingSnapshot
  readonly member: { readonly id: string; readonly name: string; readonly role: 'member' | 'admin' | 'owner' }
  readonly signal: AbortSignal
  isCurrent(): boolean
  ensureCurrent(): Promise<void>
  sendText(text: string, guard?: AgentGroupGameSendGuard): Promise<void>
  sendImage(image: MessageImage, guard?: AgentGroupGameSendGuard): Promise<void>
  /** Only a current member in this group may receive a game-specific private result. */
  sendPrivate(userId: string, text: string, guard?: AgentGroupGameSendGuard): Promise<void>
}

export interface AgentGroupGameHandler {
  readonly id: 'turtle-soup' | 'uma-race'
  isCandidate(source: IncomingMessage, binding: AgentBindingSnapshot): boolean
  isActive?(binding: AgentBindingSnapshot): boolean
  handle(context: AgentGroupGameContext): Promise<boolean>
  stop(): void | Promise<void>
}
