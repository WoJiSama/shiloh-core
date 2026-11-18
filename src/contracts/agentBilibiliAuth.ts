import type { AgentBindingSnapshot, ConversationAddress, PlatformUserRef } from './agentBinding.js'
import type { AgentMediaResourceContext } from './agentMediaRelay.js'

export interface AgentBilibiliAuthSource {
  readonly target: ConversationAddress
  readonly messageId: string
  readonly author: PlatformUserRef
  readonly occurredAt: number
  readonly textSha256: string
}
/** A short-lived login session; credentials and polling key remain inside the service. */
export interface AgentBilibiliAuthSession {
  readonly image: { readonly mime: 'image/png'; readonly base64: string }
  readonly expiresAt: number
  poll(context: AgentMediaResourceContext): Promise<'waiting' | 'success' | 'expired'>
  cancel(): void
}
export interface AgentBilibiliAuthService {
  status(binding: AgentBindingSnapshot, context: AgentMediaResourceContext): Promise<{ readonly authorized: boolean; readonly updatedAt?: number }>
  start(binding: AgentBindingSnapshot, context: AgentMediaResourceContext): Promise<AgentBilibiliAuthSession>
  logout(binding: AgentBindingSnapshot, context: AgentMediaResourceContext): Promise<void>
  /** Trusted provider capability only; never pass to model tools, diagnostics or native delivery. */
  credential(binding: AgentBindingSnapshot, context: AgentMediaResourceContext): Promise<string | undefined>
  close(): Promise<void>
}
/** The destination is always the proven original sender; native account/recipient cannot be supplied by a model. */
export interface SendRequesterBilibiliAuthAction {
  readonly version: 1
  readonly kind: 'bilibili-auth.notify'
  readonly binding: AgentBindingSnapshot
  readonly source: AgentBilibiliAuthSource
  readonly content: { readonly kind: 'qr'; readonly mime: 'image/png'; readonly base64: string } | { readonly kind: 'text'; readonly text: string }
}
