import type { AgentBindingSnapshot, ConversationAddress } from './agentBinding.js'

/** Owned bytes only; platform paths, URLs, recipient selectors and folder IDs are not accepted. */
export interface AgentFileUpload {
  readonly name: string
  readonly mime: string
  readonly base64: string
}

/** A file upload is distinct from a normal message; file IDs must never become message IDs. */
export type FileDeliveryReceipt =
  | { readonly state: 'uploaded'; readonly fileId: string; readonly messageId?: string }
  | { readonly state: 'failed'; readonly code: string | null }
  | { readonly state: 'unknown' }

export interface SendFileAction {
  readonly version: 1
  readonly kind: 'file.upload'
  readonly target: ConversationAddress
  readonly file: AgentFileUpload
  readonly binding?: AgentBindingSnapshot
}
